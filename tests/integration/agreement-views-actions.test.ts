// 협약 예산 보기 3종 조회 + 붙임4형 편집 액션 통합 테스트 — Phase 25 T9
// (SOT §5.21 AV-6 ④, §5.25, §6.19 AG-3·AG-4·AG-5, §9 Agreement Budget, §8.4 O-2,
//  계획서 docs/plans/phase-25-plan.md S-4·S-6~S-8·S-12·합성 픽스처)
//
// agreement-actions.test.ts와 같은 방식: next/headers를 실제 세션 토큰 스텁으로 바꿔 가드(SA-1)까지 그대로 부른다.
// 저장 결과는 직결 SQL로 원본을 본다.
//
// 경합(O-2 STALE)은 "액션이 읽은 직후 다른 사람이 같은 행을 고친" 상태를 만들어야 한다. 액션을 동시에 부르면
// next/headers 스텁이 잡히지 않으므로(agreement-actions.test.ts 머리말), 리포지토리 조회 함수를 감싸 읽은 직후
// 한 번만 직결 SQL로 그 행을 바꾸는 훅을 둔다 — 액션 코드 경로는 그대로다.
//
// 시나리오는 한 과제 위에서 순서대로 쌓인다: 보내기(정부지원 현금 맵) → 삭제 → 버전 A(픽스처) → 보기 3종 →
// 8-2 칸 편집 → 정부지원 현금 편집 → 확정 잠금 → 복제(현재 버전 아님 표식).

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Sql } from 'postgres';
import { connectDirectDb, createTestUser, destroyTestUser, type TestUser } from './helpers';
import type { ActionResult, DetailFactor } from '@/types';
import * as projectsRepo from '@/lib/db/projects';
import * as stagesRepo from '@/lib/db/stages';
import * as yearsRepo from '@/lib/db/years';
import * as membersRepo from '@/lib/db/members';

const session = vi.hoisted(() => ({ accessToken: '' }));
// 읽은 직후 한 번만 실행되는 경합 훅(위 머리말)
const race = vi.hoisted(() => ({
  afterLinesRead: null as null | (() => Promise<void>),
  afterGovRead: null as null | (() => Promise<void>),
}));

vi.mock('next/headers', () => ({
  cookies: async () => ({ get: () => ({ value: session.accessToken }) }),
}));
vi.mock('next/cache', () => ({ revalidatePath: () => undefined }));
vi.mock('@/lib/db/agreements', async (importOriginal) => {
  const orig = await importOriginal<typeof import('@/lib/db/agreements')>();
  return {
    ...orig,
    listLinesByVersionIds: async (...args: Parameters<typeof orig.listLinesByVersionIds>) => {
      const rows = await orig.listLinesByVersionIds(...args);
      const hook = race.afterLinesRead;
      race.afterLinesRead = null;
      if (hook) await hook();
      return rows;
    },
    listGovSupportByVersionIds: async (...args: Parameters<typeof orig.listGovSupportByVersionIds>) => {
      const rows = await orig.listGovSupportByVersionIds(...args);
      const hook = race.afterGovRead;
      race.afterGovRead = null;
      if (hook) await hook();
      return rows;
    },
  };
});

const agreement = await import('@/actions/agreement');
const plan = await import('@/actions/budget-plan');
const budget = await import('@/actions/budget');

let sql: Sql;
let user: TestUser;
const tempProjectIds: string[] = [];

let projectId: string;
let year1Id: string;
let year1Name: string;
let year2Id: string;
let m1Id: string;
let m2Id: string;
let otherYearId: string;

let vAId: string; // 픽스처 버전 A (작성 중 → 확정)

function unwrap<T>(result: ActionResult<T>): T {
  if (!result.ok) throw new Error(`액션 실패: ${result.error} (code=${result.code ?? '-'})`);
  return result.data;
}

function expectCode(result: ActionResult<unknown>, code: string): string {
  if (result.ok) throw new Error(`실패해야 하는 호출이 통과했습니다 (기대 code=${code}).`);
  expect(result.code).toBe(code);
  return result.error;
}

const PERSONNEL_FACTORS = (rate: number, months: number): DetailFactor[] => [
  { label: '참여율(%)', value: rate, isPercent: true },
  { label: '참여기간(월)', value: months, isPercent: false },
];

async function newMember(pid: string, name: string, annualSalary: number, order: number) {
  return membersRepo.createMember(
    user.client,
    {
      projectId: pid,
      orgId: null,
      name,
      role: 'researcher',
      position: '선임연구원',
      field: '',
      email: '',
      phone: '',
      active: true,
      order,
      annualSalary,
      hireType: 'existing',
    },
    user.id
  );
}

// ─── 직결 SQL (bigint는 text로 받아 정수로) ───────────────────────────────────

interface LineRow {
  id: string;
  yearId: string;
  category: string;
  subcategoryCode: string;
  axis: string;
  amount: number;
  version: number;
}

async function readLines(versionId: string): Promise<LineRow[]> {
  const rows = await sql<
    { id: string; year_id: string; category: string; subcategory_code: string; axis: string; amount: string; version: string }[]
  >`
    select id::text, year_id::text, category, subcategory_code, axis, amount::text, version::text
      from public.agreement_lines where version_id = ${versionId}::uuid
     order by year_id, category, subcategory_code, axis`;
  return rows.map((r) => ({
    id: r.id,
    yearId: r.year_id,
    category: r.category,
    subcategoryCode: r.subcategory_code,
    axis: r.axis,
    amount: Number(r.amount),
    version: Number(r.version),
  }));
}

function findLine(lines: LineRow[], yearId: string, category: string, subcategoryCode: string, axis = 'cash') {
  return lines.find(
    (l) => l.yearId === yearId && l.category === category && l.subcategoryCode === subcategoryCode && l.axis === axis
  );
}

async function readGov(versionId: string): Promise<{ yearId: string; govCash: number; version: number }[]> {
  const rows = await sql<{ year_id: string; gov_cash: string; version: string }[]>`
    select year_id::text, gov_cash::text, version::text
      from public.agreement_gov_support where version_id = ${versionId}::uuid order by year_id`;
  return rows.map((r) => ({ yearId: r.year_id, govCash: Number(r.gov_cash), version: Number(r.version) }));
}

async function snapshot(versionId: string): Promise<string> {
  return JSON.stringify({ lines: await readLines(versionId), gov: await readGov(versionId) });
}

async function viewOf(versionId: string) {
  const data = unwrap(await agreement.getAgreementData(projectId));
  const view = data.versions.find((v) => v.version.id === versionId);
  if (!view) throw new Error(`getAgreementData에 버전 ${versionId}가 없습니다.`);
  return { data, view };
}

type VersionView = Awaited<ReturnType<typeof viewOf>>['view'];

function colIndex(view: VersionView, key: string): number {
  const i = view.attachment4.view.plan82.columns.findIndex((c) => c.key === key);
  if (i < 0) throw new Error(`8-2 열 ${key}가 없습니다.`);
  return i;
}

/** 8-2 칸 값 — 금액이면 숫자, 비율이면 원값, "—"면 null */
function cell82(view: VersionView, rowKey: string, colKey: string): number | null {
  const row = view.attachment4.view.plan82.rows.find((r) => r.key === rowKey);
  if (!row) throw new Error(`8-2 행 ${rowKey}가 없습니다.`);
  const c = row.cells[colIndex(view, colKey)]!;
  if (c.kind === 'amount') return c.value;
  if (c.kind === 'rate') return c.rate.value;
  return null;
}

function categoryCell(view: VersionView, yearId: string, category: string) {
  const yi = view.categoryView.years.findIndex((y) => y.id === yearId);
  const row = view.categoryView.rows.find((r) => r.category === category);
  if (yi < 0 || !row) throw new Error('비목별 보기에서 칸을 찾지 못했습니다.');
  return row.byYear[yi]!;
}

// ─── 준비 ─────────────────────────────────────────────────────────────────────

beforeAll(async () => {
  sql = connectDirectDb();
  user = await createTestUser(sql);
  session.accessToken = user.accessToken;

  const project = await projectsRepo.createProjectWithDefaults(user.client, {
    name: '협약 보기 액션 테스트 과제',
    contractStartDate: '2026-01-01',
  });
  projectId = project.id;
  tempProjectIds.push(projectId);
  const firstYear = (await yearsRepo.listYears(user.client, projectId))[0];
  if (!firstYear) throw new Error('createProjectWithDefaults가 연차를 만들지 않았습니다.');
  year1Id = firstYear.id;
  year1Name = firstYear.name;
  const stage = (await stagesRepo.listStages(user.client, projectId))[0];
  if (!stage) throw new Error('createProjectWithDefaults가 단계를 만들지 않았습니다.');
  year2Id = (
    await yearsRepo.createYear(user.client, {
      stageId: stage.id,
      name: '2차년도',
      startDate: '2027-01-01',
      endDate: '2027-12-31',
    })
  ).id;
  m1Id = (await newMember(projectId, 'M1', 60_000_000, 0)).id;
  m2Id = (await newMember(projectId, 'M2', 50_000_000, 1)).id;

  // Phase 24 S-20 보내기 픽스처(1차년도) — 조정회의형 변경전의 원본
  unwrap(
    await plan.createBudgetDetail(year1Id, 'personnel', 'personnel_internal', {
      axis: 'cash',
      memberId: m1Id,
      factors: PERSONNEL_FACTORS(50, 12),
    })
  );
  unwrap(
    await plan.createBudgetDetail(year1Id, 'personnel', 'personnel_internal', {
      axis: 'in_kind',
      memberId: m2Id,
      factors: PERSONNEL_FACTORS(20, 12),
    })
  );
  unwrap(await budget.updateBudgetPlan(year1Id, 'material', 5_000_000, 5_000_000, 0));
  unwrap(await budget.updateBudgetPlan(year1Id, 'allowance', 3_000_000, null, null)); // 미분리 → 현금
  unwrap(
    await plan.createBudgetDetail(year1Id, 'activity', 'activity_meeting', {
      axis: 'cash',
      unitPrice: 100_000,
      factors: [{ label: '횟수', value: 12, isPercent: false }],
    })
  );
  unwrap(
    await plan.createBudgetDetail(year1Id, 'activity', 'activity_travel_dom', {
      axis: 'cash',
      unitPrice: 200_000,
      factors: [{ label: '횟수', value: 4, isPercent: false }],
    })
  );
  // 계획서 픽스처 "보내기·복제": 제안 Y1 정부지원 현금 35,000,000, Y2 null
  await sql`update public.years set gov_support_cash = 35000000 where id = ${year1Id}::uuid`;

  const other = await projectsRepo.createProjectWithDefaults(user.client, {
    name: '협약 보기 액션 남의 과제',
    contractStartDate: '2026-01-01',
  });
  tempProjectIds.push(other.id);
  const otherYear = (await yearsRepo.listYears(user.client, other.id))[0];
  if (!otherYear) throw new Error('남의 과제에 연차가 없습니다.');
  otherYearId = otherYear.id;
});

afterAll(async () => {
  race.afterLinesRead = null;
  race.afterGovRead = null;
  if (tempProjectIds.length > 0) {
    // 버전을 먼저 지운다 — 연차·인력 FK가 no action이라(H-5a·H-9b) 과제 cascade가 막힌다
    await sql`delete from public.agreement_versions where project_id = any(${tempProjectIds}::uuid[])`;
    await sql`delete from public.projects where id = any(${tempProjectIds}::uuid[])`;
    const rows = await sql<{ n: number }[]>`
      select ((select count(*) from public.projects where id = any(${tempProjectIds}::uuid[]))
            + (select count(*) from public.agreement_versions where project_id = any(${tempProjectIds}::uuid[])))::int as n`;
    if (rows[0]!.n !== 0) throw new Error(`테스트가 만든 데이터가 ${rows[0]!.n}건 남았습니다.`);
  }
  await destroyTestUser(sql, user);
  await sql.end();
});

// ─── 보내기 — 정부지원 현금 (AV-6 ④) ──────────────────────────────────────────

describe('보내기가 정부지원 현금을 옮긴다 (AV-6 ④, S-4)', () => {
  it('미리보기는 연차별 값(Y1 35,000,000 · Y2 미입력)을 summary와 별도로 싣는다', async () => {
    const preview = unwrap(await agreement.previewAgreementBaseline(projectId));
    if (!preview.ok) throw new Error('미리보기가 거부 사유를 돌려주었습니다.');
    expect(preview.govCash).toEqual([
      { yearId: year1Id, yearName: year1Name, amount: 35_000_000 },
      { yearId: year2Id, yearName: '2차년도', amount: null },
    ]);
    expect(preview.summary).not.toHaveProperty('govCash');
  });

  it('보내기 = null 아닌 연차만 행 1개, 조정회의형 변경전 = 변경후(같은 제안)', async () => {
    const created = unwrap(
      await agreement.createAgreementVersionFromPlan(projectId, { kind: 'selection', name: '선정평가본' })
    );
    expect(created.govSupportCount).toBe(1);
    expect((await readGov(created.versionId)).map((g) => [g.yearId, g.govCash])).toEqual([[year1Id, 35_000_000]]);

    const { view } = await viewOf(created.versionId);
    expect(view.govSupport.map((g) => [g.yearId, g.govCash])).toEqual([[year1Id, 35_000_000]]);
    const { before, after } = view.adjustment.view;
    expect(before.available).toBe(true);
    // 계획서 픽스처 조정회의형 변경전 Y1: A 40,000,000 · B 3,000,000 · D 43,000,000 · E 50,000,000 · F 50,000,000
    expect(before.values[0]).toMatchObject({
      personnel: 40_000_000,
      allowance: 3_000_000,
      subtotal: 43_000_000,
      total: 50_000_000,
      direct: 50_000_000,
    });
    expect(before.values[0]!.subtotalRatio.value).toBeCloseTo(86, 10);
    expect(before.values[0]!.allowanceRatio.value).toBeCloseTo(7.5, 10);
    expect(before.values[0]!.personnelDirectRatio.value).toBeCloseTo(80, 10);
    expect(before.values[1]!.subtotal).toBeNull(); // Y2 줄 없음 "—"
    expect(after.values).toEqual(before.values);

    // 다음 시나리오가 작성 중 버전을 만들 수 있게 지운다(AV-2)
    unwrap(await agreement.deleteAgreementVersion(created.versionId));
  });

  it('빈 버전은 정부지원 현금 0행', async () => {
    const empty = unwrap(await agreement.createEmptyAgreementVersion(projectId, { kind: 'final', name: '최종협약본' }));
    expect(empty.govSupportCount).toBe(0);
    expect(await readGov(empty.versionId)).toEqual([]);
    vAId = empty.versionId;
  });
});

// ─── 버전 A 보기 3종 (AG-3~AG-5) ─────────────────────────────────────────────

describe('보기 3종 — 계획서 합성 픽스처 버전 A', () => {
  beforeAll(async () => {
    // Phase 24 S-20 버전 A 금액 줄
    const rows: [string, string, string, string, number][] = [
      [year1Id, 'personnel', 'personnel_internal', 'cash', 30_000_000],
      [year1Id, 'personnel', 'personnel_internal', 'in_kind', 10_000_000],
      [year1Id, 'material', 'material_purchase', 'cash', 5_000_000],
      [year1Id, 'activity', 'activity_meeting', 'cash', 1_200_000],
      [year1Id, 'activity', 'activity_travel_dom', 'cash', 800_000],
      [year1Id, 'allowance', 'default', 'cash', 3_000_000],
      [year1Id, 'indirect', 'indirect_hr', 'cash', 2_500_000],
      [year2Id, 'personnel', 'personnel_internal', 'cash', 32_000_000],
      [year2Id, 'personnel', 'personnel_internal', 'in_kind', 10_000_000],
      [year2Id, 'material', 'material_purchase', 'cash', 4_000_000],
      [year2Id, 'activity', 'activity_meeting', 'cash', 1_000_000],
      [year2Id, 'allowance', 'default', 'cash', 3_000_000],
      [year2Id, 'indirect', 'indirect_hr', 'cash', 2_700_000],
    ];
    for (const [yid, category, sub, axis, amount] of rows) {
      await sql`
        insert into public.agreement_lines (version_id, year_id, category, subcategory_code, axis, amount)
        values (${vAId}::uuid, ${yid}::uuid, ${category}, ${sub}, ${axis}, ${amount})`;
    }
    // 참여인원(계획서 픽스처): M1 Y1 자동 · M1 Y2 수동 · M2 Y1·Y2 자동(현물)
    const people: [string, string, number, number, number, number, number][] = [
      [m1Id, year1Id, 50, 12, 60_000_000, 30_000_000, 0],
      [m1Id, year2Id, 50, 12, 60_000_000, 32_000_000, 0],
      [m2Id, year1Id, 20, 12, 50_000_000, 0, 10_000_000],
      [m2Id, year2Id, 20, 12, 50_000_000, 0, 10_000_000],
    ];
    for (const [mid, yid, rate, months, salary, cash, inKind] of people) {
      await sql`
        insert into public.agreement_participants
          (version_id, member_id, year_id, participation_rate, months, annual_salary, personnel_cash, personnel_in_kind)
        values (${vAId}::uuid, ${mid}::uuid, ${yid}::uuid, ${rate}, ${months}, ${salary}, ${cash}, ${inKind})`;
    }
  });

  it('정부지원 현금: 행 없음 + 값 = 삽입(Y1·Y2 35,000,000)', async () => {
    const r1 = unwrap(await agreement.setAgreementGovCash(vAId, year1Id, 35_000_000));
    expect(r1.kind).toBe('insert');
    expect(r1.row).toMatchObject({ versionId: vAId, yearId: year1Id, govCash: 35_000_000 });
    const r2 = unwrap(await agreement.setAgreementGovCash(vAId, year2Id, 35_000_000));
    expect(r2.kind).toBe('insert');
    expect((await readGov(vAId)).map((g) => g.govCash)).toEqual([35_000_000, 35_000_000]);
  });

  it('getAgreementData가 단계·인력·규칙과 버전별 보기 3종·정부지원 행을 싣는다', async () => {
    const { data, view } = await viewOf(vAId);
    expect(data.stages).toHaveLength(1);
    expect(data.members).toEqual([
      { id: m1Id, name: 'M1', order: 0, annualSalary: 60_000_000 },
      { id: m2Id, name: 'M2', order: 1, annualSalary: 50_000_000 },
    ]);
    expect(Array.isArray(data.rules)).toBe(true);
    expect(view.govSupport.map((g) => g.govCash)).toEqual([35_000_000, 35_000_000]);
    expect(view.govSupport.every((g) => Number.isInteger(g.version))).toBe(true);
    expect(view.attachment4.tables.plan81.rows.length).toBeGreaterThan(0);
    expect(view.attachment4.tables.plan82.rows.length).toBeGreaterThan(0);
    expect(view.adjustment.table.rows.length).toBeGreaterThan(0);
    expect(view.participants.table.rows.length).toBeGreaterThan(0);
  });

  it('붙임4형 8-2 (AG-3): E1·E2·K·L·M·양식 분모 비율', async () => {
    const { view } = await viewOf(vAId);
    // 단계 1개 → 연차 2 + 합계
    expect(view.attachment4.view.plan82.columns.map((c) => c.key)).toEqual([year1Id, year2Id, 'total']);
    expect(cell82(view, 'total_personnel', year1Id)).toBe(40_000_000);
    expect(cell82(view, 'modified_personnel', year1Id)).toBe(40_000_000);
    expect(cell82(view, 'direct_subtotal', year1Id)).toBe(50_000_000);
    expect(cell82(view, 'indirect', year1Id)).toBe(2_500_000);
    expect(cell82(view, 'total', year1Id)).toBe(52_500_000);
    expect(cell82(view, 'indirect_ratio', year1Id)).toBeCloseTo(6.25, 10);
    expect(cell82(view, 'indirect_ratio', year2Id)).toBeCloseTo(6.75, 10);
    expect(cell82(view, 'total', 'total')).toBe(105_200_000);
    expect(cell82(view, 'indirect_ratio', 'total')).toBeCloseTo(6.5, 10);
    expect(cell82(view, 'personnel_ratio', 'total')).toBeCloseTo(77.9468, 3);
  });

  it('붙임4형 8-1 (AG-3): 연차별 A·B·C·D·H·비율, 합계 = 66.5399% · 43.1818%', async () => {
    const { view } = await viewOf(vAId);
    const [y1, y2, total] = view.attachment4.view.plan81.rows;
    expect(y1).toMatchObject({
      govCashInput: 35_000_000,
      govCashStatus: 'ok',
      govCash: 35_000_000,
      ownCash: 7_500_000,
      ownInKind: 10_000_000,
      ownSubtotal: 17_500_000,
      total: 52_500_000,
    });
    expect(y1!.govShare.value).toBeCloseTo(66.6667, 3);
    expect(y1!.ownCashShare.value).toBeCloseTo(42.8571, 3);
    expect(y2).toMatchObject({ govCash: 35_000_000, ownCash: 7_700_000, total: 52_700_000 });
    expect(total).toMatchObject({ kind: 'total', govCash: 70_000_000, ownCash: 15_200_000, total: 105_200_000 });
    expect(total!.govShare.value).toBeCloseTo(66.5399, 3);
    expect(total!.ownCashShare.value).toBeCloseTo(43.1818, 3);
    // 규칙 행이 없으면 판정하지 않는다(G-1)
    expect(total!.govShareJudgement.status).toBe('skipped');
  });

  it('조정회의형 (AG-4): 변경후 = 버전 A, 현재 버전이면 표식 없음', async () => {
    const { data, view } = await viewOf(vAId);
    expect(data.currentVersionId).toBe(vAId);
    const { before, after, notCurrentVersion } = view.adjustment.view;
    expect(notCurrentVersion).toBe(false);
    expect(before.values[0]!.subtotal).toBe(43_000_000);
    expect(after.values[0]).toMatchObject({ indirect: 2_500_000, subtotal: 45_500_000, total: 52_500_000, direct: 50_000_000 });
    expect(after.values[1]).toMatchObject({ subtotal: 47_700_000, total: 52_700_000 });
    expect(after.values[0]!.subtotalRatio.value).toBeCloseTo(86.6667, 3);
    expect(after.values[2]!.subtotalRatio.value).toBeCloseTo(88.5932, 3);
    expect(after.headerIndirectRate.value).toBeCloseTo(6.5, 10);
  });

  it('참여인원 (AG-5): 구분 자동·수동, 총계, 원본 행(version 포함)', async () => {
    const { view } = await viewOf(vAId);
    const p = view.participants.view;
    expect(p.rows.map((r) => [r.memberId, r.yearId, r.kind])).toEqual([
      [m1Id, year1Id, 'auto'],
      [m1Id, year2Id, 'manual'],
      [m2Id, year1Id, 'auto'],
      [m2Id, year2Id, 'auto'],
    ]);
    expect(p.grandTotal).toEqual({ cash: 62_000_000, inKind: 20_000_000, total: 82_000_000 });
    expect(view.participants.rows).toHaveLength(4);
    expect(view.participants.rows.every((r) => r.versionId === vAId && Number.isInteger(r.version))).toBe(true);
  });
});

// ─── 8-2 칸 편집 (S-12) ───────────────────────────────────────────────────────

describe('붙임4형 8-2 칸 편집 (setAgreementFormCellAmount, S-12)', () => {
  it('G 재료비 현금(줄 1개) → 6,000,000 = 그 줄 갱신, 비목별·8-2 같은 값', async () => {
    const r = unwrap(
      await agreement.setAgreementFormCellAmount(vAId, { yearId: year1Id, rowId: 'material', axis: 'cash', amount: 6_000_000 })
    );
    expect(r.kind).toBe('update');
    expect(findLine(await readLines(vAId), year1Id, 'material', 'material_purchase')?.amount).toBe(6_000_000);
    const { view } = await viewOf(vAId);
    expect(categoryCell(view, year1Id, 'material').cash).toBe(6_000_000);
    expect(cell82(view, 'material:cash', year1Id)).toBe(6_000_000);
  });

  it('A 내부인건비 현물 → 12,000,000 = (personnel_internal, 현물) 줄 정확 갱신', async () => {
    const r = unwrap(
      await agreement.setAgreementFormCellAmount(vAId, {
        yearId: year1Id,
        rowId: 'personnel_internal',
        axis: 'in_kind',
        amount: 12_000_000,
      })
    );
    expect(r.kind).toBe('update');
    const lines = await readLines(vAId);
    expect(findLine(lines, year1Id, 'personnel', 'personnel_internal', 'in_kind')?.amount).toBe(12_000_000);
    expect(findLine(lines, year1Id, 'personnel', 'personnel_internal', 'cash')?.amount).toBe(30_000_000);
  });

  it('B 외부인건비 현금(줄 없음) → 1,000,000 = 세목 줄 신설, 같은 값 다시 = noop(쓰기 없음)', async () => {
    const r = unwrap(
      await agreement.setAgreementFormCellAmount(vAId, {
        yearId: year1Id,
        rowId: 'personnel_external',
        axis: 'cash',
        amount: 1_000_000,
      })
    );
    expect(r.kind).toBe('insert');
    expect(r.line).toMatchObject({ category: 'personnel', subcategoryCode: 'personnel_external', axis: 'cash', amount: 1_000_000 });
    const before = await snapshot(vAId);

    const again = unwrap(
      await agreement.setAgreementFormCellAmount(vAId, {
        yearId: year1Id,
        rowId: 'personnel_external',
        axis: 'cash',
        amount: 1_000_000,
      })
    );
    expect(again).toEqual({ kind: 'noop', line: null });
    expect(await snapshot(vAId)).toBe(before);

    const { view } = await viewOf(vAId);
    expect(categoryCell(view, year1Id, 'personnel').cash).toBe(31_000_000);
    expect(cell82(view, 'personnel_external:cash', year1Id)).toBe(1_000_000);
  });

  it('L 간접비(한 칸, axis null) → 3,000,000 = 현금 줄 갱신, 0도 저장', async () => {
    unwrap(await agreement.setAgreementFormCellAmount(vAId, { yearId: year2Id, rowId: 'indirect', axis: null, amount: 3_000_000 }));
    expect(findLine(await readLines(vAId), year2Id, 'indirect', 'indirect_hr')?.amount).toBe(3_000_000);
    unwrap(await agreement.setAgreementFormCellAmount(vAId, { yearId: year2Id, rowId: 'indirect', axis: null, amount: 0 }));
    expect(findLine(await readLines(vAId), year2Id, 'indirect', 'indirect_hr')?.amount).toBe(0);
    const { view } = await viewOf(vAId);
    expect(cell82(view, 'indirect', year2Id)).toBe(0); // "—"가 아니라 0
    unwrap(await agreement.setAgreementFormCellAmount(vAId, { yearId: year2Id, rowId: 'indirect', axis: null, amount: 2_700_000 }));
  });

  it('H 연구활동비: 과제추진비 몫보다 작으면 RULE(below_fixed_part), 세목 줄 합보다 작으면 RULE(exceeds_target)', async () => {
    // Y1 과제추진비 현금 400,000 (비목별 셀 편집으로 promotion/default 신설)
    unwrap(await agreement.setAgreementCellAmount(vAId, year1Id, 'promotion', 'cash', 400_000));
    const before = await snapshot(vAId);
    const below = expectCode(
      await agreement.setAgreementFormCellAmount(vAId, { yearId: year1Id, rowId: 'activity', axis: 'cash', amount: 300_000 }),
      'RULE'
    );
    expect(below).toContain('연구과제추진비');
    // 목표 1,000,000 − 400,000 = 600,000 < 세목 줄 합 2,000,000
    const exceeds = expectCode(
      await agreement.setAgreementFormCellAmount(vAId, { yearId: year1Id, rowId: 'activity', axis: 'cash', amount: 1_000_000 }),
      'RULE'
    );
    expect(exceeds).toContain('세목 줄 합계');
    expect(await snapshot(vAId)).toBe(before);

    // 2,600,000 − 400,000 = 2,200,000 → default 200,000 신설(줄 2개 → 흡수)
    const ok = unwrap(
      await agreement.setAgreementFormCellAmount(vAId, { yearId: year1Id, rowId: 'activity', axis: 'cash', amount: 2_600_000 })
    );
    expect(ok.kind).toBe('insert');
    expect(findLine(await readLines(vAId), year1Id, 'activity', 'default')?.amount).toBe(200_000);
    const { view } = await viewOf(vAId);
    expect(cell82(view, 'activity:cash', year1Id)).toBe(2_600_000);
    expect(categoryCell(view, year1Id, 'activity').cash).toBe(2_200_000);
  });

  it('편집 불가 칸·축 불일치는 RULE, 형식 오류는 VALIDATION, 데이터 불변', async () => {
    const before = await snapshot(vAId);
    for (const input of [
      { yearId: year1Id, rowId: 'total', axis: null, amount: 1 },
      { yearId: year1Id, rowId: 'outside', axis: null, amount: 1 },
      { yearId: year1Id, rowId: 'material', axis: null, amount: 1 },
      { yearId: year1Id, rowId: 'indirect', axis: 'cash', amount: 1 },
    ]) {
      expectCode(await agreement.setAgreementFormCellAmount(vAId, input), 'RULE');
    }
    for (const input of [
      { yearId: year1Id, rowId: 'material', axis: 'cash', amount: -1 },
      { yearId: year1Id, rowId: 'material', axis: 'cash', amount: 1.5 },
      { yearId: year1Id, rowId: 'nope', axis: 'cash', amount: 1 },
      { yearId: year1Id, rowId: 'material', axis: 'gold', amount: 1 },
      { yearId: 'x', rowId: 'material', axis: 'cash', amount: 1 },
    ]) {
      expectCode(await agreement.setAgreementFormCellAmount(vAId, input), 'VALIDATION');
    }
    expectCode(
      await agreement.setAgreementFormCellAmount(vAId, { yearId: otherYearId, rowId: 'material', axis: 'cash', amount: 1 }),
      'RULE'
    );
    expect(await snapshot(vAId)).toBe(before);
  });

  it('경합: 읽은 줄이 그사이 바뀌면 STALE(누가 고쳤는지), 상대 값 유지', async () => {
    const target = findLine(await readLines(vAId), year2Id, 'material', 'material_purchase')!;
    race.afterLinesRead = async () => {
      await sql`update public.agreement_lines set amount = 4100000, updated_by = ${user.id}::uuid where id = ${target.id}::uuid`;
    };
    const message = expectCode(
      await agreement.setAgreementFormCellAmount(vAId, { yearId: year2Id, rowId: 'material', axis: 'cash', amount: 4_500_000 }),
      'STALE'
    );
    expect(message).toContain('먼저 수정했습니다');
    expect(findLine(await readLines(vAId), year2Id, 'material', 'material_purchase')?.amount).toBe(4_100_000);
  });

  it('경합: 없던 줄을 그사이 다른 사람이 만들면(유일 위반) STALE', async () => {
    race.afterLinesRead = async () => {
      await sql`
        insert into public.agreement_lines (version_id, year_id, category, subcategory_code, axis, amount)
        values (${vAId}::uuid, ${year2Id}::uuid, 'personnel', 'personnel_external', 'cash', 777)`;
    };
    expectCode(
      await agreement.setAgreementFormCellAmount(vAId, {
        yearId: year2Id,
        rowId: 'personnel_external',
        axis: 'cash',
        amount: 1_000,
      }),
      'STALE'
    );
    expect(findLine(await readLines(vAId), year2Id, 'personnel', 'personnel_external')?.amount).toBe(777);
  });
});

// ─── 정부지원 현금 편집 (S-4 O-2) ─────────────────────────────────────────────

describe('정부지원 현금 편집 (setAgreementGovCash, S-4)', () => {
  it('행 + 값 = 갱신, 0 = 갱신(행 유지), null = 삭제, 다시 null = noop', async () => {
    const up = unwrap(await agreement.setAgreementGovCash(vAId, year2Id, 30_000_000));
    expect(up.kind).toBe('update');
    expect(up.row?.govCash).toBe(30_000_000);

    const zero = unwrap(await agreement.setAgreementGovCash(vAId, year2Id, 0));
    expect(zero.kind).toBe('update');
    expect((await readGov(vAId)).find((g) => g.yearId === year2Id)?.govCash).toBe(0);
    let { view } = await viewOf(vAId);
    // 0은 입력값 — "—"가 아니라 0% 계산
    expect(view.attachment4.view.plan81.rows[1]).toMatchObject({ govCashStatus: 'ok', govCash: 0 });

    expect(unwrap(await agreement.setAgreementGovCash(vAId, year2Id, null))).toEqual({ kind: 'delete', row: null });
    expect((await readGov(vAId)).map((g) => g.yearId)).toEqual([year1Id]);
    ({ view } = await viewOf(vAId));
    expect(view.attachment4.view.plan81.rows[1]).toMatchObject({ govCashStatus: 'missing', govCash: null });
    expect(view.attachment4.view.plan81.rows[2]!.govCash).toBeNull(); // 미입력 연차가 있으면 합계도 "—"

    const before = await snapshot(vAId);
    expect(unwrap(await agreement.setAgreementGovCash(vAId, year2Id, null))).toEqual({ kind: 'noop', row: null });
    expect(await snapshot(vAId)).toBe(before);
  });

  it('형식 오류 VALIDATION, 다른 과제 연차 RULE, 데이터 불변', async () => {
    const before = await snapshot(vAId);
    expectCode(await agreement.setAgreementGovCash(vAId, year1Id, -1), 'VALIDATION');
    expectCode(await agreement.setAgreementGovCash(vAId, year1Id, 0.5), 'VALIDATION');
    expectCode(await agreement.setAgreementGovCash(vAId, 'x', 1), 'VALIDATION');
    expectCode(await agreement.setAgreementGovCash(vAId, otherYearId, 1), 'RULE');
    expect(await snapshot(vAId)).toBe(before);
  });

  it('경합: 없던 행을 그사이 다른 사람이 넣으면(유일 위반) STALE, 상대 값 유지', async () => {
    race.afterGovRead = async () => {
      await sql`insert into public.agreement_gov_support (version_id, year_id, gov_cash)
                values (${vAId}::uuid, ${year2Id}::uuid, 111)`;
    };
    expectCode(await agreement.setAgreementGovCash(vAId, year2Id, 35_000_000), 'STALE');
    expect((await readGov(vAId)).find((g) => g.yearId === year2Id)?.govCash).toBe(111);
  });

  it('경합: 읽은 행이 그사이 바뀌면 갱신·삭제 모두 STALE', async () => {
    race.afterGovRead = async () => {
      await sql`update public.agreement_gov_support set gov_cash = 222, updated_by = ${user.id}::uuid
                 where version_id = ${vAId}::uuid and year_id = ${year2Id}::uuid`;
    };
    expect(expectCode(await agreement.setAgreementGovCash(vAId, year2Id, 35_000_000), 'STALE')).toContain('먼저 수정했습니다');
    race.afterGovRead = async () => {
      await sql`update public.agreement_gov_support set gov_cash = 333
                 where version_id = ${vAId}::uuid and year_id = ${year2Id}::uuid`;
    };
    expectCode(await agreement.setAgreementGovCash(vAId, year2Id, null), 'STALE');
    expect((await readGov(vAId)).find((g) => g.yearId === year2Id)?.govCash).toBe(333);
    unwrap(await agreement.setAgreementGovCash(vAId, year2Id, 35_000_000));
  });
});

// ─── 확정 잠금 · 복제 ─────────────────────────────────────────────────────────

describe('확정 버전 잠금 (AV-2) · 복제', () => {
  it('확정 버전: 8-2 칸 편집·정부지원 현금 저장/삭제 모두 RULE, 데이터 불변', async () => {
    const row = await sql<{ version: string }[]>`
      select version::text from public.agreement_versions where id = ${vAId}::uuid`;
    unwrap(await agreement.confirmAgreementVersion(vAId, Number(row[0]!.version)));
    const before = await snapshot(vAId);

    expectCode(
      await agreement.setAgreementFormCellAmount(vAId, { yearId: year1Id, rowId: 'material', axis: 'cash', amount: 1 }),
      'RULE'
    );
    expectCode(await agreement.setAgreementGovCash(vAId, year1Id, 1), 'RULE');
    expectCode(await agreement.setAgreementGovCash(vAId, year1Id, null), 'RULE');
    expect(await snapshot(vAId)).toBe(before);
  });

  it('복제는 정부지원 현금 행을 새 id로 복사하고, 복제본 조정회의형은 "현재 버전 아님"', async () => {
    const cloned = unwrap(
      await agreement.cloneLatestAgreementVersion(projectId, { kind: 'amendment', name: '협약변경 1차' })
    );
    expect(cloned.govSupportCount).toBe(2);
    expect((await readGov(cloned.versionId)).map((g) => g.govCash)).toEqual(
      (await readGov(vAId)).map((g) => g.govCash)
    );
    const { data, view } = await viewOf(cloned.versionId);
    expect(data.currentVersionId).toBe(vAId);
    expect(view.adjustment.view.notCurrentVersion).toBe(true);
    expect(view.adjustment.view.notCurrentLabel).toBe('현재 버전 아님');
  });
});
