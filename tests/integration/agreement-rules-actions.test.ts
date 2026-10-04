// 협약 예산 조회·보내기 액션 — Phase 26 T11 통합 테스트
// (SOT §6.14.8 공통 적용, §6.19 AG-3·AG-6·AG-7 ④, §5.21 AV-6 ③, §9 Agreement Budget Phase 26 확장,
//  계획서 docs/plans/phase-26-plan.md S-7·S-8·S-9·S-12·S-14·S-15·S-20, 부록 B.9.8)
//
// agreement-actions.test.ts와 같은 방식: next/headers를 실제 세션 토큰 스텁으로 바꿔 가드(SA-1)까지 그대로 부른다.
// 저장 결과는 직결 SQL로 원본을 본다. 조회 실패(규칙·인력·편성 항목)는 리포지토리 함수를 감싸 한 번만 던지게
// 해서 만든다 — 액션 코드 경로는 그대로다.
//
// 시나리오는 한 과제 위에서 순서대로 쌓인다: 보내기(편성 항목) → 버전 A(Phase 25 8-1 픽스처 + B.9.8 A 편성 항목)
// → 확정 → 복제 B → B 편성 항목 변경(B.9.8) → 변경 이력 장비 사전 승인 → RL-23 세 상태 → 조회 실패.

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Sql } from 'postgres';
import { connectDirectDb, createTestUser, destroyTestUser, type TestUser } from './helpers';
import type { ActionResult } from '@/types';
import * as projectsRepo from '@/lib/db/projects';
import * as stagesRepo from '@/lib/db/stages';
import * as yearsRepo from '@/lib/db/years';
import * as membersRepo from '@/lib/db/members';
import { AGREEMENT_EVIDENCE_DEFAULTS, PRESERVATION_RULE_OFF_TEXT, agreementSubcategoryLabel } from '@/lib/constants';

const session = vi.hoisted(() => ({ accessToken: '' }));
const revalidated = vi.hoisted(() => ({ paths: [] as string[] }));
// 다음 호출 한 번만 던지게 하는 조회 실패 스위치(위 머리말)
const failOnce = vi.hoisted(() => ({ rules: false, members: false, items: false }));

vi.mock('next/headers', () => ({
  cookies: async () => ({ get: () => ({ value: session.accessToken }) }),
}));
vi.mock('next/cache', () => ({
  revalidatePath: (path: string) => {
    revalidated.paths.push(path);
  },
}));
vi.mock('@/lib/db/budget-rules', async (importOriginal) => {
  const orig = await importOriginal<typeof import('@/lib/db/budget-rules')>();
  return {
    ...orig,
    listByProject: async (...args: Parameters<typeof orig.listByProject>) => {
      if (failOnce.rules) {
        failOnce.rules = false;
        throw new Error('규칙 조회 실패(테스트)');
      }
      return orig.listByProject(...args);
    },
  };
});
vi.mock('@/lib/db/members', async (importOriginal) => {
  const orig = await importOriginal<typeof import('@/lib/db/members')>();
  return {
    ...orig,
    listMembers: async (...args: Parameters<typeof orig.listMembers>) => {
      if (failOnce.members) {
        failOnce.members = false;
        throw new Error('인력 조회 실패(테스트)');
      }
      return orig.listMembers(...args);
    },
  };
});
vi.mock('@/lib/db/agreements', async (importOriginal) => {
  const orig = await importOriginal<typeof import('@/lib/db/agreements')>();
  return {
    ...orig,
    listItemsByVersionIds: async (...args: Parameters<typeof orig.listItemsByVersionIds>) => {
      if (failOnce.items) {
        failOnce.items = false;
        throw new Error('편성 항목 조회 실패(테스트)');
      }
      return orig.listItemsByVersionIds(...args);
    },
  };
});

const agreement = await import('@/actions/agreement');
const agreementItems = await import('@/actions/agreement-items');
const plan = await import('@/actions/budget-plan');
const rulesActions = await import('@/actions/budget-rules');

let sql: Sql;
let user: TestUser;
const tempProjectIds: string[] = [];

let projectId: string;
let year1Id: string;
let year2Id: string;
let outsourcingDetailId: string;

let vAId: string; // 최종협약본(확정) — Phase 25 8-1 픽스처 + B.9.8 A 편성 항목
let vBId: string; // vA 복제(작성 중) — B.9.8 B 편성 항목

const SOURCE = '테스트 출처';

function unwrap<T>(result: ActionResult<T>): T {
  if (!result.ok) throw new Error(`액션 실패: ${result.error} (code=${result.code ?? '-'})`);
  return result.data;
}

function expectCode(result: ActionResult<unknown>, code: string): string {
  if (result.ok) throw new Error(`실패해야 하는 호출이 통과했습니다 (기대 code=${code}).`);
  expect(result.code).toBe(code);
  return result.error;
}

function expectFailure(result: ActionResult<unknown>): string {
  if (result.ok) throw new Error('조회 실패가 빈 값으로 성공했습니다(절대 규칙 5).');
  return result.error;
}

async function countVersions(pid: string): Promise<number> {
  const rows = await sql<{ n: number }[]>`
    select count(*)::int as n from public.agreement_versions where project_id = ${pid}::uuid`;
  return rows[0]!.n;
}

async function readItems(versionId: string) {
  const rows = await sql<
    { kind: string; name: string; amount: string; quantity: string | null; evidence: { label: string; obtained: boolean; memo: string }[] }[]
  >`
    select kind, name, amount::text, quantity::text, evidence
      from public.agreement_items where version_id = ${versionId}::uuid
     order by kind, name`;
  return rows.map((r) => ({
    kind: r.kind,
    name: r.name,
    amount: Number(r.amount),
    quantity: r.quantity === null ? null : Number(r.quantity),
    evidence: r.evidence,
  }));
}

async function viewOf(versionId: string) {
  const data = unwrap(await agreement.getAgreementData(projectId));
  const view = data.versions.find((v) => v.version.id === versionId);
  if (!view) throw new Error(`getAgreementData에 버전 ${versionId}가 없습니다.`);
  return { data, view };
}

async function ruleVersion(code: string): Promise<number> {
  const rows = await sql<{ version: string }[]>`
    select version::text from public.budget_rules where project_id = ${projectId}::uuid and code = ${code}`;
  if (!rows[0]) throw new Error(`규칙 행 ${code}가 없습니다.`);
  return Number(rows[0].version);
}

async function itemByName(versionId: string, name: string) {
  const { view } = await viewOf(versionId);
  const row = view.items.rows.find((r) => r.name === name);
  if (!row) throw new Error(`편성 항목 ${name}이 없습니다.`);
  return row;
}

function defaultEvidence(kind: keyof typeof AGREEMENT_EVIDENCE_DEFAULTS) {
  return AGREEMENT_EVIDENCE_DEFAULTS[kind].map((label) => ({ label, obtained: false, memo: '' }));
}

// ─── 준비 ─────────────────────────────────────────────────────────────────────

beforeAll(async () => {
  sql = connectDirectDb();
  user = await createTestUser(sql);
  session.accessToken = user.accessToken;

  const project = await projectsRepo.createProjectWithDefaults(user.client, {
    name: '협약 규칙 판정 액션 테스트 과제',
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
  await membersRepo.createMember(
    user.client,
    {
      projectId,
      orgId: null,
      name: 'M1',
      role: 'researcher',
      position: '선임연구원',
      field: '',
      email: '',
      phone: '',
      active: true,
      order: 0,
      annualSalary: 60_000_000,
      hireType: 'existing',
    },
    user.id
  );

  // 보내기 편성 항목 원본(AV-6 ③): 장비 33,000,000 · 품명 없는 0원 재료 · 수량 인자 없는 외주
  unwrap(
    await plan.createBudgetDetail(year1Id, 'facility_equipment', 'facility_purchase', {
      axis: 'cash',
      name: '분석 장비',
      unitPrice: 33_000_000,
      factors: [{ label: '수량', value: 1, isPercent: false }],
    })
  );
  unwrap(
    await plan.createBudgetDetail(year1Id, 'material', 'material_purchase', {
      axis: 'cash',
      name: '',
      unitPrice: 0,
      factors: [{ label: '수량', value: 0, isPercent: false }],
    })
  );
  outsourcingDetailId = unwrap(
    await plan.createBudgetDetail(year1Id, 'activity', 'activity_outsourcing', {
      axis: 'cash',
      name: '시험 외주',
      unitPrice: 10_000_000,
      factors: [{ label: '건수', value: 1, isPercent: false }],
    })
  ).id;

  // 규칙 행: RL-8 60% · RL-9 50% · RL-17 30,000,000 (전부 warn)
  unwrap(await rulesActions.upsertBudgetRule(projectId, 'gov_share_max', { value: 60, severity: 'warn', source: SOURCE }));
  unwrap(await rulesActions.upsertBudgetRule(projectId, 'own_cash_min', { value: 50, severity: 'warn', source: SOURCE }));
  unwrap(
    await rulesActions.upsertBudgetRule(projectId, 'equipment_review_threshold', {
      value: 30_000_000,
      severity: 'warn',
      source: SOURCE,
    })
  );
});

afterAll(async () => {
  failOnce.rules = false;
  failOnce.members = false;
  failOnce.items = false;
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

// ─── 보내기 편성 항목 (AV-6 ③, S-14) ─────────────────────────────────────────

describe('보내기가 편성 항목을 만든다 (AV-6 ③, S-14)', () => {
  it('품명 200자 초과 행은 미리보기 issues, 보내기는 위치를 적어 RULE — 잘라 보내지 않는다', async () => {
    const longName = '가'.repeat(201);
    await sql`update public.budget_details set name = ${longName} where id = ${outsourcingDetailId}::uuid`;
    try {
      const preview = unwrap(await agreement.previewAgreementBaseline(projectId));
      if (preview.ok) throw new Error('미리보기가 200자 넘는 품명을 거부하지 않았습니다.');
      expect(preview.issues).toHaveLength(1);
      expect(preview.issues[0]).toMatchObject({ code: 'item_name_too_long', yearId: year1Id, category: 'activity' });
      expect(preview.issues[0]!.message).toContain('201자');

      const message = expectCode(
        await agreement.createAgreementVersionFromPlan(projectId, { kind: 'selection', name: '선정평가본' }),
        'RULE'
      );
      expect(message).toContain(preview.issues[0]!.message);
      expect(await countVersions(projectId)).toBe(0);
    } finally {
      await sql`update public.budget_details set name = '시험 외주' where id = ${outsourcingDetailId}::uuid`;
    }
  });

  it('미리보기 건수 = 만든 건수: 3건(품명 없음 1건), 0원 재료도 편성 항목, 기본 증빙 복사', async () => {
    const preview = unwrap(await agreement.previewAgreementBaseline(projectId));
    if (!preview.ok) throw new Error('미리보기가 거부 사유를 돌려주었습니다.');
    expect(preview.itemSummary).toEqual({ count: 3, unnamedCount: 1 });

    const created = unwrap(
      await agreement.createAgreementVersionFromPlan(projectId, { kind: 'selection', name: '선정평가본' })
    );
    expect(created.itemCount).toBe(3);
    expect(created.itemSummary).toEqual(preview.itemSummary);
    expect(created.summary).toEqual(preview.summary);

    expect(await readItems(created.versionId)).toEqual([
      { kind: 'equipment', name: '분석 장비', amount: 33_000_000, quantity: 1, evidence: defaultEvidence('equipment') },
      {
        kind: 'material',
        name: agreementSubcategoryLabel('material', 'material_purchase'),
        amount: 0,
        quantity: 0,
        evidence: defaultEvidence('material'),
      },
      { kind: 'outsourcing', name: '시험 외주', amount: 10_000_000, quantity: null, evidence: defaultEvidence('outsourcing') },
    ]);

    // 보기·판정: 장비 33,000,000 × 1.1 ≥ 30,000,000 → RL-17 경고가 그 건에 붙는다
    const { data, view } = await viewOf(created.versionId);
    expect(data.ruleTargetVersionId).toBe(created.versionId);
    expect(view.items.rows).toHaveLength(3);
    expect(view.items.view.grandTotal).toEqual({ itemCount: 3, amount: 43_000_000 });
    expect(view.items.table.rows.length).toBeGreaterThan(0);
    const equipment = view.items.view.rows.find((r) => r.kind === 'equipment')!;
    expect(equipment.findings.map((f) => f.code)).toEqual(['equipment_review_threshold']);
    expect(view.items.view.rows.filter((r) => r.kind !== 'equipment').every((r) => r.findings.length === 0)).toBe(true);
    const rl17 = view.ruleResult.evaluation.findings.filter((f) => f.code === 'equipment_review_threshold');
    expect(rl17).toHaveLength(1);
    expect(rl17[0]!.scope).toMatchObject({ kind: 'item', yearId: year1Id, itemId: equipment.id });

    // 제안 연차 정부지원 현금 미입력 → 버전 정부지원 현금 행 없음 → RL-8·RL-9 skipped(0으로 셈하지 않는다)
    expect(view.ruleResult.totalsSource).toBe('agreement_gov_support');
    expect(view.ruleResult.targetLabel).toBe('선정평가본 · 작성 중');
    const skippedCodes = view.ruleResult.evaluation.skipped.map((s) => s.code);
    expect(skippedCodes).toEqual(expect.arrayContaining(['gov_share_max', 'own_cash_min']));
    expect(view.ruleResult.evaluation.findings.some((f) => f.code === 'gov_share_max')).toBe(false);

    // 다음 시나리오가 작성 중 버전을 만들 수 있게 지운다(AV-2)
    unwrap(await agreement.deleteAgreementVersion(created.versionId));
  });

  it('버전 0개면 판정 대상 없음(null) — 빈 findings가 아니다', async () => {
    const data = unwrap(await agreement.getAgreementData(projectId));
    expect(data.versions).toEqual([]);
    expect(data.ruleTargetVersionId).toBeNull();
  });
});

// ─── 버전별 규칙 판정 (§6.14.8) ──────────────────────────────────────────────

describe('버전별 ruleResult — RL-8/9 = 버전 정부지원 현금 (§6.14.8 ⑤)', () => {
  beforeAll(async () => {
    vAId = unwrap(await agreement.createEmptyAgreementVersion(projectId, { kind: 'final', name: '최종협약본' })).versionId;
    // Phase 25 8-1 픽스처(Phase 24 S-20 버전 A 금액 줄)
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
    unwrap(await agreement.setAgreementGovCash(vAId, year1Id, 35_000_000));
    unwrap(await agreement.setAgreementGovCash(vAId, year2Id, 35_000_000));

    // B.9.8 A 편성 항목 — 재료 "분광기" 28,000,000 · 장비 "오실로스코프" 27,000,000 · 장비 "레이저" 40,000,000
    for (const [kind, name, amount] of [
      ['material', '분광기', 28_000_000],
      ['equipment', '오실로스코프', 27_000_000],
      ['equipment', '레이저', 40_000_000],
    ] as const) {
      unwrap(await agreementItems.addAgreementItem(vAId, { yearId: year1Id, kind, name, amount, quantity: 1 }));
    }
  });

  it('RL-8 66.5399% · RL-9 43.1818% = 붙임4 8-1 합계, 한도 60%·50%를 넘어 경고', async () => {
    const { view } = await viewOf(vAId);
    const { evaluation } = view.ruleResult;
    const gov = evaluation.ratios.gov_share_max.find((r) => r.yearId === null)!;
    const own = evaluation.ratios.own_cash_min.find((r) => r.yearId === null)!;
    expect(gov.actual).toBeCloseTo(66.5399, 3);
    expect(own.actual).toBeCloseTo(43.1818, 3);
    // 8-1 표시(Phase 25)와 같은 수
    const total = view.attachment4.view.plan81.rows.find((r) => r.kind === 'total')!;
    expect(gov.actual).toBeCloseTo(total.govShare.value!, 10);
    expect(own.actual).toBeCloseTo(total.ownCashShare.value!, 10);
    expect(evaluation.findings.filter((f) => f.code === 'gov_share_max' || f.code === 'own_cash_min').map((f) => f.code).sort())
      .toEqual(['gov_share_max', 'own_cash_min']);
    expect(evaluation.skipped.some((s) => s.code === 'gov_share_max')).toBe(false);
  });

  it('Y2 정부지원 현금 미입력 → RL-8·RL-9 skipped(연차 이름 포함), 다시 넣으면 판정', async () => {
    unwrap(await agreement.setAgreementGovCash(vAId, year2Id, null));
    try {
      const { view } = await viewOf(vAId);
      const { evaluation } = view.ruleResult;
      const skipped = evaluation.skipped.filter((s) => s.code === 'gov_share_max' || s.code === 'own_cash_min');
      expect(skipped).toHaveLength(2);
      expect(skipped.every((s) => s.reason.includes('2차년도'))).toBe(true);
      expect(evaluation.findings.some((f) => f.code === 'gov_share_max' || f.code === 'own_cash_min')).toBe(false);
    } finally {
      unwrap(await agreement.setAgreementGovCash(vAId, year2Id, 35_000_000));
    }
  });

  it('8-2 판정 줄(S-15): RL-4·RL-3 연차별 — 규칙 행이 없으면 판정하지 않음', async () => {
    const { data, view } = await viewOf(vAId);
    expect(view.form82Rules.lines.map((l) => l.code)).toEqual(['allowance_max', 'indirect_max']);
    for (const line of view.form82Rules.lines) {
      expect(line.years.map((y) => y.yearId)).toEqual(data.years.map((y) => y.id));
      expect(line.years.every((y) => y.cell.status === 'skipped')).toBe(true);
    }
  });

  it('편성 항목 보기: A의 RL-17 = 레이저 1건(오실로스코프 27,000,000 × 1.1 < 30,000,000)', async () => {
    const { view } = await viewOf(vAId);
    const flagged = view.items.view.rows.filter((r) => r.findings.length > 0).map((r) => r.name);
    expect(flagged).toEqual(['레이저']);
  });
});

// ─── 장비 사전 승인 (AG-7 ④, B.9.8) · RL-23 세 상태 (S-7) ───────────────────

describe('변경 이력 장비 사전 승인(B.9.8)과 RL-23 세 상태', () => {
  beforeAll(async () => {
    const vA = (await viewOf(vAId)).view.version;
    unwrap(await agreement.confirmAgreementVersion(vAId, vA.version));
    vBId = unwrap(await agreement.cloneLatestAgreementVersion(projectId, { kind: 'amendment', name: '협약변경 1차' })).versionId;

    // B: 재료 "분광기" → 장비 · 오실로스코프 27,272,728 · 레이저 41,000,000 · 신규 장비 "현미경" 20,000,000
    const spectro = await itemByName(vBId, '분광기');
    unwrap(await agreementItems.updateAgreementItem(spectro.id, { kind: 'equipment' }, spectro.version));
    const oscillo = await itemByName(vBId, '오실로스코프');
    unwrap(await agreementItems.updateAgreementItem(oscillo.id, { amount: 27_272_728 }, oscillo.version));
    const laser = await itemByName(vBId, '레이저');
    unwrap(await agreementItems.updateAgreementItem(laser.id, { amount: 41_000_000 }, laser.version));
    unwrap(
      await agreementItems.addAgreementItem(vBId, {
        yearId: year1Id,
        kind: 'equipment',
        name: '현미경',
        amount: 20_000_000,
        quantity: 1,
      })
    );
  });

  it('A → B 경고 2건(분광기 이관 · 오실로스코프 기준 넘음), B의 RL-17은 3건', async () => {
    const changes = unwrap(await agreement.getAgreementChanges(projectId, vAId, vBId));
    if (changes.equipmentApproval.status !== 'judged') throw new Error('RL-17이 켜져 있는데 판정하지 않았습니다.');
    expect(changes.equipmentApproval.threshold).toBe(30_000_000);
    expect(
      changes.equipmentApproval.warnings.map((w) => [w.name, w.reason, w.afterAmount]).sort()
    ).toEqual([
      ['분광기', 'moved', 28_000_000],
      ['오실로스코프', 'crossed', 27_272_728],
    ]);

    const { data, view } = await viewOf(vBId);
    expect(view.ruleResult.evaluation.findings.filter((f) => f.code === 'equipment_review_threshold')).toHaveLength(3);
    expect(view.items.view.rows.filter((r) => r.findings.length > 0).map((r) => r.name).sort()).toEqual([
      '레이저',
      '분광기',
      '오실로스코프',
    ]);
    // 판정 대상은 버전마다 자신 — 현재 버전(확정 A)과 보고 있는 B의 결과가 섞이지 않는다
    expect(data.ruleTargetVersionId).toBe(vAId);
    expect(view.ruleResult.targetLabel).toBe('협약변경 1차 · 작성 중');
    expect((await viewOf(vAId)).view.ruleResult.targetLabel).toBe('최종협약본 · 확정');
  });

  it('RL-17이 꺼지면 장비 사전 승인은 판정하지 않음 + 사유', async () => {
    unwrap(
      await rulesActions.upsertBudgetRule(
        projectId,
        'equipment_review_threshold',
        { enabled: false },
        await ruleVersion('equipment_review_threshold')
      )
    );
    try {
      const changes = unwrap(await agreement.getAgreementChanges(projectId, vAId, vBId));
      expect(changes.equipmentApproval).toEqual({ status: 'not_judged', reason: expect.stringContaining('꺼져') });
    } finally {
      unwrap(
        await rulesActions.upsertBudgetRule(
          projectId,
          'equipment_review_threshold',
          { enabled: true },
          await ruleVersion('equipment_review_threshold')
        )
      );
    }
  });

  it('RL-23 행 없음 = 켜짐: 기준 버전 없음(A) · 판정함(B 대 A, 경고 0건)', async () => {
    const { data } = await viewOf(vAId);
    const a = data.versions.find((v) => v.version.id === vAId)!;
    const b = data.versions.find((v) => v.version.id === vBId)!;
    expect(a.preservationStatus).toEqual({ kind: 'no_base' });
    expect(b.preservationStatus).toEqual({ kind: 'checked', baseVersionName: '최종협약본', warningCount: 0 });

    const changes = unwrap(await agreement.getAgreementChanges(projectId, vAId, vBId));
    expect(changes.preservationStatus).toEqual({ kind: 'checked', baseVersionName: '최종협약본', warningCount: 0 });
    expect(changes.tables.preservation.title).not.toContain(PRESERVATION_RULE_OFF_TEXT);
  });

  it('RL-23 행이 있고 꺼짐 = 세 번째 상태, 변경 이력 표는 숫자 없이 상태 한 행', async () => {
    unwrap(
      await rulesActions.upsertBudgetRule(projectId, 'preserve_subcategory_totals', {
        enabled: false,
        severity: 'warn',
        source: SOURCE,
      })
    );
    const { data } = await viewOf(vAId);
    expect(data.versions.map((v) => v.preservationStatus)).toEqual([{ kind: 'off' }, { kind: 'off' }]);

    const changes = unwrap(await agreement.getAgreementChanges(projectId, vAId, vBId));
    expect(changes.preservationStatus).toEqual({ kind: 'off' });
    expect(changes.tables.preservation.title).toContain(PRESERVATION_RULE_OFF_TEXT);
    const dataRows = changes.tables.preservation.rows.filter((r) => r.kind === 'data');
    expect(dataRows).toHaveLength(1);
    expect(dataRows[0]!.cells[0]).toEqual({ kind: 'text', text: PRESERVATION_RULE_OFF_TEXT });
    expect(dataRows[0]!.cells.some((c) => c.kind === 'amount')).toBe(false);

    // 다시 켜면 판정한다
    unwrap(
      await rulesActions.upsertBudgetRule(
        projectId,
        'preserve_subcategory_totals',
        { enabled: true },
        await ruleVersion('preserve_subcategory_totals')
      )
    );
    const after = unwrap(await agreement.getAgreementChanges(projectId, vAId, vBId));
    expect(after.preservationStatus).toMatchObject({ kind: 'checked' });
  });

  it('규칙 편집은 연구비 경로를 revalidate — 제안·수행 두 모드가 함께 다시 읽는다', async () => {
    revalidated.paths.length = 0;
    unwrap(
      await rulesActions.upsertBudgetRule(
        projectId,
        'gov_share_max',
        { value: 70 },
        await ruleVersion('gov_share_max')
      )
    );
    expect(revalidated.paths).toEqual([`/projects/${projectId}/budget`]);
    // 다음 조회에 바로 반영 — 66.5399% < 70% → RL-8 경고 없음
    const { view } = await viewOf(vAId);
    expect(view.ruleResult.evaluation.findings.some((f) => f.code === 'gov_share_max')).toBe(false);
  });
});

// ─── 조회 실패는 명시적 오류 (절대 규칙 5) ───────────────────────────────────

describe('규칙·인력·편성 항목 조회 실패는 빈 값이 아니라 실패', () => {
  it('getAgreementData', async () => {
    failOnce.rules = true;
    expectFailure(await agreement.getAgreementData(projectId));
    failOnce.members = true;
    expectFailure(await agreement.getAgreementData(projectId));
    failOnce.items = true;
    expectFailure(await agreement.getAgreementData(projectId));
    // 스위치는 한 번만 — 다음 조회는 정상
    unwrap(await agreement.getAgreementData(projectId));
  });

  it('getAgreementChanges', async () => {
    failOnce.rules = true;
    expectFailure(await agreement.getAgreementChanges(projectId, vAId, vBId));
    failOnce.items = true;
    expectFailure(await agreement.getAgreementChanges(projectId, vAId, vBId));
    unwrap(await agreement.getAgreementChanges(projectId, vAId, vBId));
  });
});
