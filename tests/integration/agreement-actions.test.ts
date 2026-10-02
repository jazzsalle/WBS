// 협약 예산 서버 액션 통합 테스트 — Phase 24 T7a
// (SOT §5.21 AV-1~AV-8, §6.19 AG-2·AG-7, §9 Agreement Budget SA-1~SA-4, §8.4 O-1·O-2,
//  계획서 docs/plans/phase-24-plan.md S-2·S-4~S-6·S-10·S-12·S-15·S-16·S-20)
//
// 서버 액션은 쿠키 세션에서 토큰을 읽으므로 next/headers를 실제 세션 토큰을 돌려주는 스텁으로 바꿔
// 가드(SA-1)까지 포함해 그대로 호출한다(budget-plan-actions.test.ts와 같은 방식).
//
// 이 파일의 시나리오는 한 과제 위에서 순서대로 쌓인다(보내기 → 셀 편집 → 확정 → 복제 → 다시 보내기 → 확정 취소
// → 삭제). 버전 판정(현재·기준·확정 취소)이 "쌓인 이력"에 대한 규칙이라 단계를 쪼개면 검증할 상태가 사라진다.
// 결과 확인은 액션 반환값이 아니라 직결 SQL로 저장된 원본을 본다 — 액션이 몰래 보정했는지는 DB만 답한다.
// 자기가 만든 과제·사용자만 지운다 — 파괴적 테스트가 아니다.
//
// 생성 경합(동시 호출 → 부분 유일 인덱스 23505 → RULE)은 repos-agreements.test.ts가 리포지토리 수준에서 본다 —
// 액션을 Promise.all로 동시에 부르면 next/headers 스텁 대신 실제 cookies()가 잡혀 가드에서 실패한다(테스트 환경 한계).

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Sql } from 'postgres';
import { connectDirectDb, createTestUser, destroyTestUser, type TestUser } from './helpers';
import type { ActionResult, DetailFactor } from '@/types';
import * as projectsRepo from '@/lib/db/projects';
import * as stagesRepo from '@/lib/db/stages';
import * as yearsRepo from '@/lib/db/years';
import * as membersRepo from '@/lib/db/members';

const session = vi.hoisted(() => ({ accessToken: '' }));

vi.mock('next/headers', () => ({
  cookies: async () => ({ get: () => ({ value: session.accessToken }) }),
}));
vi.mock('next/cache', () => ({ revalidatePath: () => undefined }));

const agreement = await import('@/actions/agreement');
const plan = await import('@/actions/budget-plan');
const budget = await import('@/actions/budget');

let sql: Sql;
let user: TestUser;
const tempProjectIds: string[] = [];

let projectId: string;
let year1Id: string;
let year2Id: string;
let m1Id: string; // 연봉 60,000,000 (S-20 M1)
let m2Id: string; // 연봉 50,000,000 (S-20 M2)
let m1DetailId: string;

let otherProjectId: string;
let otherYearId: string;
let otherVersionId: string;

// 시나리오가 쌓아 가는 버전 id
let v1Id: string; // 보내기(선정평가본 → 확정 후 최종협약본으로 종류 변경)
let v2Id: string; // v1 복제(협약변경 1차)
let v3Id: string; // 버전이 있을 때 다시 보내기(Q4)

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

async function newMember(pid: string, name: string, annualSalary: number) {
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
      order: 0,
      annualSalary,
      hireType: 'existing',
    },
    user.id
  );
}

// ─── 직결 SQL 조회 (bigint는 text로 받아 정수로 — 부동소수점 경유 금지) ──────────

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

async function readVersionRow(versionId: string) {
  const rows = await sql<
    { status: string; confirmed_at: Date | null; sort_order: number; kind: string; version: string }[]
  >`
    select status, confirmed_at, sort_order, kind, version::text
      from public.agreement_versions where id = ${versionId}::uuid`;
  return rows[0];
}

async function countChildren(versionId: string) {
  const rows = await sql<{ lines: number; participants: number; items: number }[]>`
    select
      (select count(*) from public.agreement_lines where version_id = ${versionId}::uuid)::int as lines,
      (select count(*) from public.agreement_participants where version_id = ${versionId}::uuid)::int as participants,
      (select count(*) from public.agreement_items where version_id = ${versionId}::uuid)::int as items`;
  return rows[0]!;
}

async function countVersions(pid: string): Promise<number> {
  const rows = await sql<{ n: number }[]>`
    select count(*)::int as n from public.agreement_versions where project_id = ${pid}::uuid`;
  return rows[0]!.n;
}

// 제안 데이터 원본 — 독립성(AV-6) 비교용
async function planSnapshot(pid: string): Promise<string> {
  const items = await sql`
    select id::text, year_id::text, category, planned_amount::text, cash_amount::text, in_kind_amount::text, version::text
      from public.budget_items where project_id = ${pid}::uuid order by id`;
  const details = await sql`
    select id::text, amount::text, factors::text, version::text
      from public.budget_details where project_id = ${pid}::uuid order by id`;
  return JSON.stringify({ items, details });
}

async function versionSnapshot(versionId: string): Promise<string> {
  const lines = await readLines(versionId);
  const participants = await sql`
    select id::text, member_id::text, year_id::text, participation_rate::text, months::text,
           annual_salary::text, personnel_cash::text, personnel_in_kind::text, version::text
      from public.agreement_participants where version_id = ${versionId}::uuid order by id`;
  const items = await sql`
    select id::text, amount::text, evidence::text, version::text
      from public.agreement_items where version_id = ${versionId}::uuid order by id`;
  return JSON.stringify({ lines, participants, items });
}

async function dataView(versionId: string) {
  const data = unwrap(await agreement.getAgreementData(projectId));
  const view = data.versions.find((v) => v.version.id === versionId);
  if (!view) throw new Error(`getAgreementData에 버전 ${versionId}가 없습니다.`);
  return { data, view };
}

function cellOf(
  view: Awaited<ReturnType<typeof dataView>>['view'],
  yearId: string,
  category: string
) {
  const yi = view.categoryView.years.findIndex((y) => y.id === yearId);
  const row = view.categoryView.rows.find((r) => r.category === category);
  if (yi < 0 || !row) throw new Error('비목별 보기에서 칸을 찾지 못했습니다.');
  return row.byYear[yi]!;
}

async function currentVersionNumber(versionId: string): Promise<number> {
  const row = await readVersionRow(versionId);
  if (!row) throw new Error('버전 행이 없습니다.');
  return Number(row.version);
}

// ─── 준비 ─────────────────────────────────────────────────────────────────────

beforeAll(async () => {
  sql = connectDirectDb();
  user = await createTestUser(sql);
  session.accessToken = user.accessToken;

  const project = await projectsRepo.createProjectWithDefaults(user.client, {
    name: '협약 예산 액션 테스트 과제',
    contractStartDate: '2026-01-01',
  });
  projectId = project.id;
  tempProjectIds.push(projectId);
  const firstYear = (await yearsRepo.listYears(user.client, projectId))[0];
  if (!firstYear) throw new Error('createProjectWithDefaults가 연차를 만들지 않았습니다.');
  year1Id = firstYear.id;
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
  m1Id = (await newMember(projectId, 'M1', 60_000_000)).id;
  m2Id = (await newMember(projectId, 'M2', 50_000_000)).id;

  // S-20 보내기 픽스처 (1차년도)
  m1DetailId = unwrap(
    await plan.createBudgetDetail(year1Id, 'personnel', 'personnel_internal', {
      axis: 'cash',
      memberId: m1Id,
      factors: PERSONNEL_FACTORS(50, 12),
    })
  ).id;
  unwrap(
    await plan.createBudgetDetail(year1Id, 'personnel', 'personnel_internal', {
      axis: 'in_kind',
      memberId: m2Id,
      factors: PERSONNEL_FACTORS(20, 12),
    })
  );
  unwrap(await budget.updateBudgetPlan(year1Id, 'material', 5_000_000, 5_000_000, 0));
  unwrap(await budget.updateBudgetPlan(year1Id, 'allowance', 3_000_000, null, null)); // 미분리(Q2)
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

  const other = await projectsRepo.createProjectWithDefaults(user.client, {
    name: '협약 예산 액션 남의 과제',
    contractStartDate: '2026-01-01',
  });
  otherProjectId = other.id;
  tempProjectIds.push(otherProjectId);
  const otherYear = (await yearsRepo.listYears(user.client, otherProjectId))[0];
  if (!otherYear) throw new Error('남의 과제에 연차가 없습니다.');
  otherYearId = otherYear.id;
  otherVersionId = unwrap(
    await agreement.createEmptyAgreementVersion(otherProjectId, { kind: 'selection', name: '남의 선정평가본' })
  ).versionId;
});

afterAll(async () => {
  if (tempProjectIds.length > 0) {
    // 버전을 먼저 지운다 — 연차·인력 FK가 no action이라(H-5a·H-9b) 과제 cascade가 막힌다(delete_project와 같은 순서)
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

// ─── 시나리오 ─────────────────────────────────────────────────────────────────

describe('버전이 없을 때 (AV-3, S-22)', () => {
  it('getAgreementData는 버전 0개·현재/작성 중 없음·이름 제안 선정평가본을 돌려준다', async () => {
    const data = unwrap(await agreement.getAgreementData(projectId));
    expect(data.versions).toEqual([]);
    expect(data.currentVersionId).toBeNull();
    expect(data.draftVersionId).toBeNull();
    expect(data.nextVersionMeta).toEqual({ kind: 'selection', name: '선정평가본' });
    expect(data.years.map((y) => y.id)).toEqual([year1Id, year2Id]);
    expect(data.projectName).toBe('협약 예산 액션 테스트 과제');
  });

  it('복제할 버전이 없으면 [새 버전]은 RULE', async () => {
    expectCode(
      await agreement.cloneLatestAgreementVersion(projectId, { kind: 'selection', name: '선정평가본' }),
      'RULE'
    );
    expect(await countVersions(projectId)).toBe(0);
  });

  it('입력 검증: 잘못된 id·종류·빈 이름은 VALIDATION', async () => {
    expectCode(await agreement.getAgreementData('not-a-uuid'), 'VALIDATION');
    expectCode(await agreement.createEmptyAgreementVersion(projectId, { kind: 'draft', name: 'x' }), 'VALIDATION');
    expectCode(await agreement.createEmptyAgreementVersion(projectId, { kind: 'selection', name: '  ' }), 'VALIDATION');
    expect(await countVersions(projectId)).toBe(0);
  });
});

describe('협약 기준선으로 보내기 (AV-6, S-6·S-20)', () => {
  let planBefore: string;

  it('S-20 보내기: 줄 6개·참여인원 2행·현금 40,000,000·현물 10,000,000·미분리 1건 3,000,000', async () => {
    const preview = unwrap(await agreement.previewAgreementBaseline(projectId));
    expect(await countVersions(projectId)).toBe(0); // 미리보기는 쓰지 않는다
    if (!preview.ok) throw new Error('미리보기가 거부 사유를 돌려주었습니다.');
    expect(preview.draftVersionName).toBeNull();
    expect(preview.hasVersions).toBe(false);

    const created = unwrap(
      await agreement.createAgreementVersionFromPlan(projectId, { kind: 'selection', name: '선정평가본' })
    );
    // 확인 대화에 보인 숫자 = 실제로 보낸 숫자
    expect(created.summary).toEqual(preview.summary);
    v1Id = created.versionId;
    planBefore = await planSnapshot(projectId);

    expect(created.order).toBe(1);
    expect(created.lineCount).toBe(6);
    expect(created.participantCount).toBe(2);
    expect(created.summary).toMatchObject({
      lineCount: 6,
      participantCount: 2,
      cashTotal: 40_000_000,
      inKindTotal: 10_000_000,
      unsplit: { count: 1, amount: 3_000_000 },
    });

    const lines = await readLines(v1Id);
    expect(lines).toHaveLength(6);
    expect(findLine(lines, year1Id, 'material', 'default')?.amount).toBe(5_000_000);
    expect(findLine(lines, year1Id, 'allowance', 'default')?.amount).toBe(3_000_000);
    expect(findLine(lines, year1Id, 'personnel', 'personnel_internal', 'cash')?.amount).toBe(30_000_000);
    expect(findLine(lines, year1Id, 'personnel', 'personnel_internal', 'in_kind')?.amount).toBe(10_000_000);
    expect(findLine(lines, year1Id, 'activity', 'activity_meeting')?.amount).toBe(1_200_000);
    expect(findLine(lines, year1Id, 'activity', 'activity_travel_dom')?.amount).toBe(800_000);

    const participants = await sql<{ member_id: string; annual_salary: string; rate: string; months: string; cash: string; in_kind: string; role: string }[]>`
      select member_id::text, annual_salary::text, participation_rate::text as rate, months::text,
             personnel_cash::text as cash, personnel_in_kind::text as in_kind, role
        from public.agreement_participants where version_id = ${v1Id}::uuid order by personnel_cash desc`;
    expect(participants.map((p) => [p.member_id, Number(p.annual_salary), Number(p.rate), Number(p.months), Number(p.cash), Number(p.in_kind), p.role])).toEqual([
      [m1Id, 60_000_000, 50, 12, 30_000_000, 0, ''],
      [m2Id, 50_000_000, 20, 12, 0, 10_000_000, ''],
    ]);

    const row = await readVersionRow(v1Id);
    expect(row).toMatchObject({ status: 'draft', confirmed_at: null, sort_order: 1, kind: 'selection' });
  });

  it('보낸 합계 = 제안 모드 합계(현금·현물 각각, 미분리 셀은 현금 쪽)', async () => {
    const planData = unwrap(await plan.getBudgetPlanData(projectId));
    let planCash = 0;
    let planInKind = 0;
    for (const cell of planData.cells) {
      if (cell.detailCount > 0) {
        planCash += cell.total.cashAmount;
        planInKind += cell.total.inKindAmount;
      } else if (cell.saved.cashAmount === null && cell.saved.inKindAmount === null) {
        planCash += cell.saved.plannedAmount;
      } else {
        planCash += cell.saved.cashAmount ?? 0;
        planInKind += cell.saved.inKindAmount ?? 0;
      }
    }
    const { data, view } = await dataView(v1Id);
    expect(view.categoryView.grandTotal).toEqual({ cash: planCash, inKind: planInKind, total: planCash + planInKind });
    expect(view.categoryView.grandTotal).toEqual({ cash: 40_000_000, inKind: 10_000_000, total: 50_000_000 });
    // U-3: 확정 버전이 없으면 작성 중 버전이 현재 버전
    expect(data.currentVersionId).toBe(v1Id);
    expect(data.draftVersionId).toBe(v1Id);
    expect(view.baseVersionId).toBeNull();
    expect(view.preservation).toEqual({ status: 'no-base' });
    expect(view.canUnconfirm).toBe(false);
    expect(view.lineCount).toBe(6);
    // 줄 없는 칸은 null(금액 0과 구별), 표 모델도 함께 실린다
    expect(cellOf(view, year2Id, 'material')).toEqual({ cash: null, inKind: null, total: null });
    expect(view.categoryTable.rows.length).toBeGreaterThan(0);
  });

  it('작성 중 버전이 있으면 보내기·빈 버전·새 버전 세 경로 모두 RULE, 작성 중은 1개 그대로', async () => {
    const input = { kind: 'adjustment', name: '조정회의본' };
    for (const result of [
      await agreement.createAgreementVersionFromPlan(projectId, input),
      await agreement.createEmptyAgreementVersion(projectId, input),
      await agreement.cloneLatestAgreementVersion(projectId, input),
    ]) {
      const message = expectCode(result, 'RULE');
      expect(message).toContain('작성 중 버전 "선정평가본"이 있습니다');
    }
    expect(await countVersions(projectId)).toBe(1);
  });

  it('셀 편집 5분기(S-20 순서)가 DB와 getAgreementData 합계에 바로 반영된다 (AG-2)', async () => {
    // ① 1차년도 연구활동비 현금(줄 2개 = 2,000,000) → 2,500,000: default 500,000 신설
    const r1 = unwrap(await agreement.setAgreementCellAmount(v1Id, year1Id, 'activity', 'cash', 2_500_000));
    expect(r1.kind).toBe('insert');
    let lines = await readLines(v1Id);
    expect(findLine(lines, year1Id, 'activity', 'default')?.amount).toBe(500_000);
    expect(findLine(lines, year1Id, 'activity', 'activity_meeting')?.amount).toBe(1_200_000);
    expect(cellOf((await dataView(v1Id)).view, year1Id, 'activity').cash).toBe(2_500_000);

    // ② 같은 칸 → 2,200,000: default 200,000 (다른 세목 줄은 그대로)
    const r2 = unwrap(await agreement.setAgreementCellAmount(v1Id, year1Id, 'activity', 'cash', 2_200_000));
    expect(r2.kind).toBe('update');
    lines = await readLines(v1Id);
    expect(findLine(lines, year1Id, 'activity', 'default')?.amount).toBe(200_000);
    expect(findLine(lines, year1Id, 'activity', 'activity_travel_dom')?.amount).toBe(800_000);

    // ③ → 1,900,000: default가 −100,000이 되므로 RULE, 데이터 불변
    const before = await readLines(v1Id);
    const message = expectCode(
      await agreement.setAgreementCellAmount(v1Id, year1Id, 'activity', 'cash', 1_900_000),
      'RULE'
    );
    expect(message).toContain('세목 줄 합계가 이미 목표보다 큽니다');
    expect(await readLines(v1Id)).toEqual(before);

    // ④ 1차년도 연구재료비 현금(줄 1개) → 3,500,000: 그 줄 갱신
    const r4 = unwrap(await agreement.setAgreementCellAmount(v1Id, year1Id, 'material', 'cash', 3_500_000));
    expect(r4.kind).toBe('update');
    expect(findLine(await readLines(v1Id), year1Id, 'material', 'default')?.amount).toBe(3_500_000);

    // ⑤ 1차년도 연구과제추진비 현금(줄 0개) → 400,000: promotion/default 신설
    const r5 = unwrap(await agreement.setAgreementCellAmount(v1Id, year1Id, 'promotion', 'cash', 400_000));
    expect(r5.kind).toBe('insert');
    expect(r5.line).toMatchObject({ category: 'promotion', subcategoryCode: 'default', amount: 400_000 });

    const { view } = await dataView(v1Id);
    // 40,000,000 + 200,000(활동 default) − 1,500,000(재료) + 400,000(추진비)
    expect(view.categoryView.grandTotal).toEqual({ cash: 39_100_000, inKind: 10_000_000, total: 49_100_000 });
    expect(cellOf(view, year1Id, 'promotion')).toEqual({ cash: 400_000, inKind: null, total: 400_000 });
  });

  it('셀 편집 입력 검증·과제 경계', async () => {
    const before = await readLines(v1Id);
    expectCode(await agreement.setAgreementCellAmount(v1Id, year1Id, 'material', 'cash', -1), 'VALIDATION');
    expectCode(await agreement.setAgreementCellAmount(v1Id, year1Id, 'material', 'cash', 1.5), 'VALIDATION');
    expectCode(
      await agreement.setAgreementCellAmount(v1Id, year1Id, 'nope' as never, 'cash', 100),
      'VALIDATION'
    );
    // 남의 과제 연차 — 액션이 먼저 거부한다
    const message = expectCode(
      await agreement.setAgreementCellAmount(v1Id, otherYearId, 'material', 'cash', 100),
      'RULE'
    );
    expect(message).toContain('이 과제에 속하지 않은 연차');
    expect(await readLines(v1Id)).toEqual(before);
  });

  it('독립성: 버전을 고쳐도 제안 데이터 불변, 제안을 고쳐도 버전 불변', async () => {
    // 위 셀 편집 5분기 뒤에도 budget_items·budget_details는 보낼 때 그대로
    expect(await planSnapshot(projectId)).toBe(planBefore);

    const versionBefore = await versionSnapshot(v1Id);
    unwrap(await budget.updateBudgetPlan(year1Id, 'allowance', 9_000_000, null, null));
    unwrap(await plan.updateBudgetDetail(m1DetailId, { factors: PERSONNEL_FACTORS(40, 12) }));
    expect(await planSnapshot(projectId)).not.toBe(planBefore);
    expect(await versionSnapshot(v1Id)).toBe(versionBefore);

    // 다음 보내기(Q4) 검증이 S-20 금액을 쓰도록 제안을 되돌린다
    unwrap(await budget.updateBudgetPlan(year1Id, 'allowance', 3_000_000, null, null));
    unwrap(await plan.updateBudgetDetail(m1DetailId, { factors: PERSONNEL_FACTORS(50, 12) }));
  });
});

describe('메타·확정 (AV-2, O-1)', () => {
  it('메타: 낡은 expectedVersion은 STALE(누가 고쳤는지 포함), 데이터 불변', async () => {
    const current = await currentVersionNumber(v1Id);
    const message = expectCode(
      await agreement.updateAgreementVersionMeta(v1Id, { changeReason: '낡은 편집' }, current - 1),
      'STALE'
    );
    expect(message).toContain('먼저 수정했습니다');
    expect(await currentVersionNumber(v1Id)).toBe(current);
  });

  it('메타: 빈 patch·형식 오류는 VALIDATION', async () => {
    const current = await currentVersionNumber(v1Id);
    expectCode(await agreement.updateAgreementVersionMeta(v1Id, {}, current), 'VALIDATION');
    expectCode(await agreement.updateAgreementVersionMeta(v1Id, { baseDate: '2026/01/01' }, current), 'VALIDATION');
    expectCode(await agreement.updateAgreementVersionMeta(v1Id, { noticeType: 'memo' }, current), 'VALIDATION');
  });

  it('메타 7개 편집 성공', async () => {
    const current = await currentVersionNumber(v1Id);
    const updated = unwrap(
      await agreement.updateAgreementVersionMeta(
        v1Id,
        {
          name: '선정평가본(수정)',
          baseDate: '2026-02-01',
          changeReason: '선정평가 반영',
          noticeType: 'notice',
          irisRequestedAt: '2026-02-03',
          note: '비고',
        },
        current
      )
    );
    expect(updated).toMatchObject({
      name: '선정평가본(수정)',
      baseDate: '2026-02-01',
      changeReason: '선정평가 반영',
      noticeType: 'notice',
      irisRequestedAt: '2026-02-03',
      note: '비고',
      status: 'draft',
    });
  });

  it('확정: 낡은 버전은 STALE, 맞으면 확정(confirmedAt 기록), 다시 확정은 RULE', async () => {
    // 복제가 편성 항목(증빙 포함)까지 복사하는지 보려고 확정 전에 1건 넣는다 — 편집 화면은 Phase 26
    await sql`
      insert into public.agreement_items (version_id, year_id, kind, name, amount, quantity, evidence)
      values (${v1Id}::uuid, ${year1Id}::uuid, 'equipment', '분석 장비', 33000000, 1,
              '[{"label":"견적서","obtained":true,"memo":"2개사"}]'::jsonb)`;

    const current = await currentVersionNumber(v1Id);
    expectCode(await agreement.confirmAgreementVersion(v1Id, current - 1), 'STALE');
    expect((await readVersionRow(v1Id))?.status).toBe('draft');

    const confirmed = unwrap(await agreement.confirmAgreementVersion(v1Id, current));
    expect(confirmed.status).toBe('confirmed');
    expect(confirmed.confirmedAt).not.toBeNull();
    expectCode(await agreement.confirmAgreementVersion(v1Id, confirmed.version), 'RULE');
  });

  it('확정 버전의 셀 편집은 RULE이고 금액 줄이 바뀌지 않는다 (AV-2 — 액션이 막는다)', async () => {
    const before = await versionSnapshot(v1Id);
    for (const [category, amount] of [
      ['material', 1],
      ['activity', 9_999_999],
      ['other', 100],
    ] as const) {
      const message = expectCode(
        await agreement.setAgreementCellAmount(v1Id, year1Id, category, 'cash', amount),
        'RULE'
      );
      expect(message).toContain('확정된 협약 예산 버전');
    }
    expect(await versionSnapshot(v1Id)).toBe(before);
  });

  it('확정 후에도 메타 편집(종류 포함)은 성공한다', async () => {
    const current = await currentVersionNumber(v1Id);
    const updated = unwrap(
      await agreement.updateAgreementVersionMeta(v1Id, { kind: 'final', name: '최종협약본' }, current)
    );
    expect(updated).toMatchObject({ kind: 'final', name: '최종협약본', status: 'confirmed' });
    const { data } = await dataView(v1Id);
    expect(data.currentVersionId).toBe(v1Id);
    expect(data.draftVersionId).toBeNull();
    expect(data.nextVersionMeta).toEqual({ kind: 'amendment', name: '협약변경 1차' });
  });
});

describe('새 버전 = 마지막 버전 복제 (AV-1) · 변경 이력 (AG-7)', () => {
  it('복제: 줄·참여인원·편성 항목이 새 id로 모두 복사되고 원본 불변, 작성 중·order 2', async () => {
    const sourceBefore = await versionSnapshot(v1Id);
    const created = unwrap(
      await agreement.cloneLatestAgreementVersion(projectId, { kind: 'amendment', name: '협약변경 1차' })
    );
    v2Id = created.versionId;
    expect(created).toMatchObject({ order: 2, sourceVersionId: v1Id, participantCount: 2, itemCount: 1 });
    expect(await countChildren(v2Id)).toEqual(await countChildren(v1Id));
    expect(await versionSnapshot(v1Id)).toBe(sourceBefore);

    const src = await readLines(v1Id);
    const copy = await readLines(v2Id);
    expect(copy.map(({ id: _id, version: _v, ...rest }) => rest)).toEqual(src.map(({ id: _id, version: _v, ...rest }) => rest));
    expect(copy.some((l) => src.some((s) => s.id === l.id))).toBe(false);

    expect(await readVersionRow(v2Id)).toMatchObject({ status: 'draft', confirmed_at: null, sort_order: 2 });
    const { view } = await dataView(v2Id);
    expect(view.baseVersionId).toBe(v1Id);
    expect(view.preservation).toMatchObject({ status: 'checked', baseVersionId: v1Id, warnings: [] });
  });

  it('getAgreementChanges: 줄 증감·참여인원 증감·B 대 base(B)의 RL-23·표 모델 3종', async () => {
    // 연차 간 이동(보존) 1건 + 증액(경고) 1건
    unwrap(await agreement.setAgreementCellAmount(v2Id, year1Id, 'material', 'cash', 3_000_000));
    unwrap(await agreement.setAgreementCellAmount(v2Id, year2Id, 'material', 'cash', 500_000));
    unwrap(await agreement.setAgreementCellAmount(v2Id, year1Id, 'promotion', 'cash', 600_000));

    const changes = unwrap(await agreement.getAgreementChanges(projectId, v1Id, v2Id));
    expect(changes.lineDiff.counts).toEqual({ added: 1, removed: 0, changed: 2, unchanged: 6 });
    expect(changes.lineDiff.netDelta).toBe(200_000);
    expect(changes.participantDiff.counts).toEqual({ added: 0, removed: 0, changed: 0, unchanged: 2 });
    expect(changes.baseVersionId).toBe(v1Id);
    if (changes.preservation.status !== 'checked') throw new Error('기준 버전이 있어야 한다');
    expect(changes.preservation.warnings).toHaveLength(1);
    expect(changes.preservation.warnings[0]).toMatchObject({
      category: 'promotion',
      subcategoryCode: 'default',
      axis: 'cash',
      baseTotal: 400_000,
      total: 600_000,
      delta: 200_000,
    });
    // 재료비는 1차년도 −500,000 · 2차년도 +500,000 — 세목 총액 보존
    expect(
      changes.preservation.entries.find((e) => e.category === 'material' && e.subcategoryCode === 'default')
    ).toMatchObject({ baseTotal: 3_500_000, total: 3_500_000, preserved: true });
    expect(changes.tables.lines.rows.length).toBeGreaterThan(0);
    expect(changes.tables.participants.rows.length).toBeGreaterThan(0);
    // 키마다 한 행 + 합계 행
    expect(changes.tables.preservation.rows.filter((r) => r.kind === 'data')).toHaveLength(changes.preservation.entries.length);

    // 같은 버전끼리는 전부 불변
    const same = unwrap(await agreement.getAgreementChanges(projectId, v2Id, v2Id));
    expect(same.lineDiff.counts.unchanged).toBe(same.lineDiff.changes.length);

    // 첫 버전 대상이면 "기준 버전 없음"
    const first = unwrap(await agreement.getAgreementChanges(projectId, v1Id, v1Id));
    expect(first.preservation).toEqual({ status: 'no-base' });
    expect(first.baseVersionId).toBeNull();
  });

  it('getAgreementChanges 과제 경계: 남의 과제 버전은 RULE', async () => {
    expectCode(await agreement.getAgreementChanges(projectId, v1Id, otherVersionId), 'RULE');
    expectCode(await agreement.getAgreementChanges(otherProjectId, v1Id, otherVersionId), 'RULE');
  });
});

describe('버전이 있을 때 보내기 (Q4) · 기준 버전 재계산 (AV-5) · 확정 취소 (AV-8)', () => {
  it('미리보기: 작성 중 버전이 있으면 그 이름을 돌려준다', async () => {
    const preview = unwrap(await agreement.previewAgreementBaseline(projectId));
    expect(preview.draftVersionName).toBe('협약변경 1차');
    expect(preview.hasVersions).toBe(true);
  });

  it('금액을 잃을 셀이 있으면 미리보기는 issues, 보내기는 같은 위치를 적어 RULE — 버전을 만들지 않는다', async () => {
    unwrap(await agreement.confirmAgreementVersion(v2Id, await currentVersionNumber(v2Id)));
    // 현금만 적혔는데 계획액과 다른 셀 — 정상 경로(updateBudgetPlan)는 막으므로 직결 SQL로 만든다
    await sql`
      update public.budget_items set planned_amount = 2000000, cash_amount = 1000000, in_kind_amount = null
       where year_id = ${year2Id}::uuid and category = 'other'`;
    try {
      const preview = unwrap(await agreement.previewAgreementBaseline(projectId));
      if (preview.ok) throw new Error('미리보기가 불일치 셀을 거부하지 않았습니다.');
      expect(preview.draftVersionName).toBeNull();
      expect(preview.issues).toHaveLength(1);
      expect(preview.issues[0]).toMatchObject({ code: 'split_mismatch', yearId: year2Id, category: 'other' });

      const versionsBefore = await countVersions(projectId);
      const message = expectCode(
        await agreement.createAgreementVersionFromPlan(projectId, { kind: 'amendment', name: '협약변경 2차' }),
        'RULE'
      );
      expect(message).toContain(preview.issues[0]!.message);
      expect(await countVersions(projectId)).toBe(versionsBefore);
    } finally {
      await sql`
        update public.budget_items set planned_amount = 0, cash_amount = null, in_kind_amount = null
         where year_id = ${year2Id}::uuid and category = 'other'`;
    }
  });

  it('작성 중 버전이 없으면 보내기 성공 — order 3, 기존 버전 불변', async () => {
    const v1Before = await versionSnapshot(v1Id);
    const v2Before = await versionSnapshot(v2Id);

    const preview = unwrap(await agreement.previewAgreementBaseline(projectId));
    if (!preview.ok) throw new Error('미리보기가 거부 사유를 돌려주었습니다.');
    expect(preview).toMatchObject({ draftVersionName: null, hasVersions: true });
    const created = unwrap(
      await agreement.createAgreementVersionFromPlan(projectId, { kind: 'amendment', name: '협약변경 2차' })
    );
    expect(created.summary).toEqual(preview.summary);
    v3Id = created.versionId;
    expect(created.order).toBe(3);
    expect(created.summary).toMatchObject({ cashTotal: 40_000_000, inKindTotal: 10_000_000, unsplit: { count: 1, amount: 3_000_000 } });
    expect(await versionSnapshot(v1Id)).toBe(v1Before);
    expect(await versionSnapshot(v2Id)).toBe(v2Before);
    expect(await readVersionRow(v3Id)).toMatchObject({ status: 'draft', sort_order: 3 });
  });

  it('종류(메타)를 바꾸면 다음 조회의 기준 버전이 바뀐다', async () => {
    let { data } = await dataView(v3Id);
    // v1 최종협약본(확정)이 앞에 있다 → base(v3) = v1
    expect(data.versions.find((v) => v.version.id === v3Id)?.baseVersionId).toBe(v1Id);
    expect(data.currentVersionId).toBe(v2Id); // 확정 중 order 최대
    expect(data.draftVersionId).toBe(v3Id);

    unwrap(await agreement.updateAgreementVersionMeta(v1Id, { kind: 'selection' }, await currentVersionNumber(v1Id)));
    ({ data } = await dataView(v3Id));
    // 앞선 확정 최종협약본이 없다 → 직전 확정 버전 v2
    expect(data.versions.find((v) => v.version.id === v3Id)?.baseVersionId).toBe(v2Id);
  });

  it('확정 취소: 뒤에 버전이 있으면 RULE, 작성 중 버전은 RULE', async () => {
    const message = expectCode(
      await agreement.unconfirmAgreementVersion(v2Id, await currentVersionNumber(v2Id)),
      'RULE'
    );
    expect(message).toContain('마지막 버전');
    expectCode(await agreement.unconfirmAgreementVersion(v3Id, await currentVersionNumber(v3Id)), 'RULE');
    expect((await readVersionRow(v2Id))?.status).toBe('confirmed');
  });

  it('버전 삭제(작성 중) → 마지막이 된 확정 버전은 확정 취소 가능, 낡은 버전은 STALE', async () => {
    const childrenBefore = await countChildren(v3Id);
    expect(childrenBefore.lines).toBeGreaterThan(0);
    unwrap(await agreement.deleteAgreementVersion(v3Id));
    expect(await readVersionRow(v3Id)).toBeUndefined();
    expect(await countChildren(v3Id)).toEqual({ lines: 0, participants: 0, items: 0 });

    const { view } = await dataView(v2Id);
    expect(view.canUnconfirm).toBe(true);

    const current = await currentVersionNumber(v2Id);
    expectCode(await agreement.unconfirmAgreementVersion(v2Id, current - 1), 'STALE');
    const reverted = unwrap(await agreement.unconfirmAgreementVersion(v2Id, current));
    expect(reverted).toMatchObject({ status: 'draft', confirmedAt: null });
    expect(await readVersionRow(v2Id)).toMatchObject({ status: 'draft', confirmed_at: null, sort_order: 2 });
  });

  it('확정 버전도 삭제된다 — 하위 3종 cascade, 남은 순번은 그대로', async () => {
    expect((await readVersionRow(v1Id))?.status).toBe('confirmed');
    const before = await countChildren(v1Id);
    expect(before.items).toBe(1);
    unwrap(await agreement.deleteAgreementVersion(v1Id));
    expect(await countChildren(v1Id)).toEqual({ lines: 0, participants: 0, items: 0 });
    expect(await readVersionRow(v2Id)).toMatchObject({ sort_order: 2 });
    const { data, view } = await dataView(v2Id);
    expect(data.versions.map((v) => v.version.order)).toEqual([2]);
    expect(view.baseVersionId).toBeNull();
    // 이미 지운 버전 — 대상 없음은 code 없는 실패(NotFound)
    const again = await agreement.deleteAgreementVersion(v1Id);
    expect(again.ok).toBe(false);
  });
});

describe('전체 버전 삭제 (AV-4)', () => {
  it('그 과제 버전만 지우고 하위 3종 cascade, 남의 과제 불변', async () => {
    unwrap(await agreement.confirmAgreementVersion(v2Id, await currentVersionNumber(v2Id)));
    const extra = unwrap(
      await agreement.cloneLatestAgreementVersion(projectId, { kind: 'amendment', name: '협약변경 2차' })
    );
    const otherBefore = await versionSnapshot(otherVersionId);
    const otherCount = await countVersions(otherProjectId);

    const result = unwrap(await agreement.deleteAllAgreementVersions(projectId));
    expect(result.deleted).toBe(2);
    expect(await countVersions(projectId)).toBe(0);
    for (const id of [v2Id, extra.versionId]) {
      expect(await countChildren(id)).toEqual({ lines: 0, participants: 0, items: 0 });
    }
    expect(await countVersions(otherProjectId)).toBe(otherCount);
    expect(await versionSnapshot(otherVersionId)).toBe(otherBefore);

    const data = unwrap(await agreement.getAgreementData(projectId));
    expect(data.versions).toEqual([]);
    expect(data.currentVersionId).toBeNull();
  });
});
