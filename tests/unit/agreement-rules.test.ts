// 수행 모드 규칙 판정 — 입력 어댑터·판정 대상·8-2 판정 줄·장비 사전 승인
// (SOT §6.14.7·§6.14.8, §6.19 AG-3·AG-7 ④, 부록 B.9.5·B.9.7·B.9.8, 계획서 Phase 26 S-8·S-15·S-20).
//
// 판정기는 `evaluateRules` 하나다. 여기서는 어댑터가 버전 데이터를 제안과 같은 입력으로 바꾸는지를 본다 —
// 같은 편성이면 결과가 같고 scope의 행 식별자만 다르다(B.9.7). 숫자는 SOT·계획서 그대로다.

import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { buildAttachment4View } from '@/lib/agreement/attachment4-view';
import { diffEquipmentApproval, type EquipmentApprovalItem } from '@/lib/agreement/equipment-approval';
import { buildBaselineFromPlan } from '@/lib/agreement/from-plan';
import { buildItemsView } from '@/lib/agreement/items-view';
import {
  AGREEMENT_RULE_TOTALS_SOURCE_LABEL,
  buildAgreementRuleInput,
  evaluateAgreementRules,
  ruleTargetVersionId,
  type AgreementRuleInputParams,
  type RuleInputLine,
  type RuleInputParticipant,
} from '@/lib/agreement/rule-input';
import { buildForm82RuleView, FORM82_RULE_TEXT } from '@/lib/agreement/rule-view';
import type { VersionRef } from '@/lib/agreement/versions';
import { aggregateDetails, buildYearTotals, computeDetailAmount } from '@/lib/budget-plan';
import { INDIRECT_BASE_LABELS } from '@/lib/constants';
import { presetToRows } from '@/lib/rules-presets';
import {
  evaluateRules,
  type RuleEvaluation,
  type RuleFinding,
  type RuleInput,
  type RuleProjectInput,
  type RuleRowInput,
} from '@/lib/rules';
import type { BudgetCategory, BudgetDetail, DetailAxis, DetailFactor, HireType, IndirectBase, RuleCode } from '@/types';

// ─── 공통 헬퍼 ────────────────────────────────────────────────────────────────

const round4 = (v: number | null | undefined): number | null => (v == null ? null : Math.round(v * 10_000) / 10_000);

function rule(code: RuleCode, value: number | null, opts: { enabled?: boolean; base?: IndirectBase | null } = {}): RuleInput {
  return { code, enabled: opts.enabled ?? true, value, base: opts.base ?? null, severity: 'warn', source: '간사 지침 테스트' };
}

function line(yearId: string, category: BudgetCategory, sub: string, axis: DetailAxis, amount: number): RuleInputLine {
  return { yearId, category, subcategoryCode: sub, axis, amount };
}

const YEARS_2 = [
  { id: 'Y2', name: '2차년도', order: 1, stageId: 'S1' },
  { id: 'Y1', name: '1차년도', order: 0, stageId: 'S1' },
];

/** Phase 24 S-20 버전 A (계획서 Phase 25 합성 픽스처) */
const VERSION_A: RuleInputLine[] = [
  line('Y1', 'personnel', 'personnel_internal', 'cash', 30_000_000),
  line('Y1', 'personnel', 'personnel_internal', 'in_kind', 10_000_000),
  line('Y1', 'material', 'material_purchase', 'cash', 5_000_000),
  line('Y1', 'activity', 'activity_meeting', 'cash', 1_200_000),
  line('Y1', 'activity', 'activity_travel_dom', 'cash', 800_000),
  line('Y1', 'allowance', 'default', 'cash', 3_000_000),
  line('Y1', 'indirect', 'indirect_hr', 'cash', 2_500_000),
  line('Y2', 'personnel', 'personnel_internal', 'cash', 32_000_000),
  line('Y2', 'personnel', 'personnel_internal', 'in_kind', 10_000_000),
  line('Y2', 'material', 'material_purchase', 'cash', 4_000_000),
  line('Y2', 'activity', 'activity_meeting', 'cash', 1_000_000),
  line('Y2', 'allowance', 'default', 'cash', 3_000_000),
  line('Y2', 'indirect', 'indirect_hr', 'cash', 2_700_000),
];

const GOV_35 = [
  { yearId: 'Y1', govCash: 35_000_000 },
  { yearId: 'Y2', govCash: 35_000_000 },
];

function params(over: Partial<AgreementRuleInputParams> = {}): AgreementRuleInputParams {
  return { lines: VERSION_A, participants: [], items: [], govSupport: GOV_35, members: [], years: YEARS_2, rules: [], ...over };
}

// ─── B.9.7 제안·수행 동등성 ──────────────────────────────────────────────────

const MOE_RULES: RuleInput[] = presetToRows('moe_energy_sme');

interface PlanMember {
  id: string;
  annualSalary: number | null;
  hireType: HireType;
}

let seq = 0;
function planDetail(spec: {
  yearId?: string;
  category: BudgetCategory;
  subcategory: string;
  axis?: DetailAxis;
  memberId?: string | null;
  name?: string;
  unitPrice?: number;
  factors?: DetailFactor[];
}): BudgetDetail {
  seq += 1;
  return {
    id: `detail-${seq}`,
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    version: 1,
    createdBy: null,
    updatedBy: null,
    projectId: 'p1',
    yearId: spec.yearId ?? 'Y1',
    category: spec.category,
    subcategory: spec.subcategory,
    axis: spec.axis ?? 'cash',
    formula: spec.memberId ? 'personnel' : 'quantity',
    memberId: spec.memberId ?? null,
    name: spec.name ?? '',
    unitPrice: spec.unitPrice ?? 0,
    spec: '',
    factors: spec.factors ?? [],
    adjustment: 0,
    note: '',
    order: seq,
    amount: 0,
  };
}

const RATE = (rate: number): DetailFactor[] => [
  { label: '참여율(%)', value: rate, isPercent: true },
  { label: '참여기간(월)', value: 12, isPercent: false },
];
const QTY = (n: number): DetailFactor[] => [{ label: '수량', value: n, isPercent: false }];

interface EqFixture {
  members: PlanMember[];
  details: BudgetDetail[];
  /** 1개 연차 — 정부지원 현금 = govBudget */
  project: { govBudget: number; ownBudget: number; totalBudget: number };
}

/** 산출 행 금액은 저장값이 아니라 계산값이다(PL-D7) — 보내기도 그 값을 옮긴다 */
function withAmounts(fx: EqFixture): BudgetDetail[] {
  const salaries = new Map(fx.members.map((m) => [m.id, m]));
  return fx.details.map((d) => ({
    ...d,
    amount: computeDetailAmount(d, d.memberId === null ? null : salaries.get(d.memberId)).amount,
  }));
}

/** 제안 경로 — actions/budget-plan.ts getBudgetPlan과 같은 모양으로 입력을 만든다 */
function evaluatePlan(fx: EqFixture): RuleEvaluation {
  const details = withAmounts(fx);
  const aggregate = aggregateDetails(details, fx.members);
  const members = new Map(fx.members.map((m) => [m.id, m]));
  const rows: RuleRowInput[] = details.map((detail, i) => {
    const member = detail.memberId === null ? null : members.get(detail.memberId)!;
    return { detail, amount: aggregate.rows[i]!.amount, member: member === null ? null : { id: member.id, hireType: member.hireType } };
  });
  const project: RuleProjectInput = fx.project;
  return evaluateRules(MOE_RULES, {
    years: [{ yearId: 'Y1', totals: buildYearTotals(aggregate.cells.filter((c) => c.yearId === 'Y1')), rows }],
    project,
  });
}

/** 수행 경로 — 그 제안을 보낸 버전(AV-6, 편성 항목 포함)을 어댑터로 판정 */
function sendAndEvaluate(fx: EqFixture) {
  const years = [{ id: 'Y1', name: '1차년도', order: 0, govSupportCash: fx.project.govBudget }];
  const baseline = buildBaselineFromPlan({ items: [], details: withAmounts(fx), members: fx.members, years });
  if (!baseline.ok) throw new Error(baseline.issues.map((i) => i.message).join('\n'));
  const participants: RuleInputParticipant[] = baseline.participants.map((p, i) => ({ ...p, id: `participant-${i}` }));
  const items = baseline.items.map((it, i) => ({ ...it, id: `item-${i}` }));
  const govSupport = Object.entries(baseline.govCash).map(([yearId, govCash]) => ({ yearId, govCash }));
  const result = evaluateAgreementRules({
    lines: baseline.lines,
    participants,
    items,
    govSupport,
    members: fx.members,
    years,
    rules: MOE_RULES,
  });
  return { baseline, participants, items, result };
}

/** scope의 행 식별자만 뺀 finding — 나머지는 두 모드가 같아야 한다 */
function comparable(f: RuleFinding) {
  const { scope } = f;
  return {
    code: f.code,
    severity: f.severity,
    actual: f.actual,
    limit: f.limit,
    message: f.message,
    approximate: f.approximate,
    yearId: scope.kind === 'project' ? null : scope.yearId,
    category: scope.kind === 'project' || scope.kind === 'year' ? null : scope.category,
    rowScope: scope.kind === 'detail' || scope.kind === 'participant' || scope.kind === 'item',
  };
}

function expectEquivalent(plan: RuleEvaluation, agreement: RuleEvaluation): void {
  expect(agreement.findings.map(comparable)).toEqual(plan.findings.map(comparable));
  expect(agreement.ratios).toEqual(plan.ratios);
  expect(agreement.skipped).toEqual(plan.skipped);
}

function finding(evaluation: RuleEvaluation, code: RuleCode): RuleFinding {
  const found = evaluation.findings.filter((f) => f.code === code);
  expect(found).toHaveLength(1);
  return found[0]!;
}

const EQ1: EqFixture = {
  members: [
    { id: 'm1', annualSalary: 180_840_000, hireType: 'new' },
    { id: 'm2', annualSalary: 88_650_000, hireType: 'existing' },
  ],
  details: [
    planDetail({ category: 'personnel', subcategory: 'personnel_internal', axis: 'cash', memberId: 'm1', factors: RATE(100) }),
    planDetail({ category: 'personnel', subcategory: 'personnel_internal', axis: 'in_kind', memberId: 'm2', factors: RATE(100) }),
    planDetail({ category: 'activity', subcategory: 'activity_meeting', name: '회의비', unitPrice: 27_020_000 }),
    // 부록 B.7 실측 — 연구지원비 세목의 "연구실 안전관리비" 품명은 RL-22 대상이 아니다(자동 이관 없음)
    planDetail({ category: 'indirect', subcategory: 'indirect_support', name: '연구실 안전관리비', unitPrice: 2_000_000 }),
  ],
  project: { govBudget: 200_000_000, ownBudget: 98_510_000, totalBudget: 298_510_000 },
};

const EQ2: EqFixture = {
  members: [
    { id: 'A', annualSalary: 60_000_000, hireType: 'existing' },
    { id: 'B', annualSalary: 48_000_000, hireType: 'new' },
    { id: 'C', annualSalary: 50_000_000, hireType: 'existing' },
  ],
  details: [
    planDetail({ category: 'personnel', subcategory: 'personnel_internal', axis: 'cash', memberId: 'A', factors: RATE(30) }),
    planDetail({ category: 'personnel', subcategory: 'personnel_internal', axis: 'cash', memberId: 'B', factors: RATE(50) }),
    planDetail({ category: 'personnel', subcategory: 'personnel_internal', axis: 'in_kind', memberId: 'C', factors: RATE(5) }),
  ],
  project: { govBudget: 30_000_000, ownBudget: 14_500_000, totalBudget: 44_500_000 },
};

const EQ3: EqFixture = {
  members: [],
  details: [
    planDetail({ category: 'facility_equipment', subcategory: 'facility_purchase', name: '분석 장비', unitPrice: 35_000_000, factors: QTY(1) }),
    planDetail({ category: 'material', subcategory: 'material_purchase', name: '시약', unitPrice: 12_000_000 }),
    planDetail({ category: 'material', subcategory: 'material_purchase', name: '시약 ', unitPrice: 9_000_000 }),
    planDetail({ category: 'activity', subcategory: 'activity_outsourcing', name: '시험 분석 용역', unitPrice: 29_990_000 }),
  ],
  project: { govBudget: 60_000_000, ownBudget: 25_990_000, totalBudget: 85_990_000 },
};

describe('B.9.7 제안·수행 동등성 — 같은 편성이면 판정이 같고 scope의 행 식별자만 다르다', () => {
  it('EQ-1 (B.9.1 금액): RL-3 0.9622% 통과 · RL-5 info · RL-8 66.9994% · RL-9 10.0091%', () => {
    const plan = evaluatePlan(EQ1);
    const { result } = sendAndEvaluate(EQ1);
    expectEquivalent(plan, result.evaluation);

    const ev = result.evaluation;
    expect(round4(ev.ratios.indirect_max[0]!.actual)).toBe(0.9622);
    expect(finding(ev, 'allowance_min').severity).toBe('info');
    expect(round4(ev.ratios.gov_share_max[0]!.actual)).toBe(66.9994);
    expect(round4(ev.ratios.own_cash_min[0]!.actual)).toBe(10.0091);
    expect(ev.findings.map((f) => f.code)).toEqual(['allowance_min']);
    // 버전 총액 = 과제 필드에 넣은 합성 값
    expect(buildAgreementRuleInput({ ...sendParams(EQ1) }).input.project).toEqual(EQ1.project);
  });

  it('EQ-2 (B.9.2 인력): RL-16 C error · RL-14 A warn · RL-5 info · RL-8 67.4157% · RL-9 82.7586%', () => {
    const plan = evaluatePlan(EQ2);
    const { result, participants } = sendAndEvaluate(EQ2);
    expectEquivalent(plan, result.evaluation);

    const ev = result.evaluation;
    const rl16 = finding(ev, 'min_participation');
    expect(rl16.severity).toBe('error');
    expect(rl16.actual).toBe(5);
    const rl14 = finding(ev, 'existing_personnel_cash');
    expect(rl14.severity).toBe('warn');
    expect(rl14.actual).toBe(18_000_000);
    expect(finding(ev, 'allowance_min').severity).toBe('info');
    expect(round4(ev.ratios.gov_share_max[0]!.actual)).toBe(67.4157);
    expect(round4(ev.ratios.own_cash_min[0]!.actual)).toBe(82.7586);

    // 다른 것은 행 식별자뿐 — 수행은 참여인원 id를 가리킨다
    const byMember = new Map(participants.map((p) => [p.memberId, p.id]));
    expect(rl16.scope).toEqual({ kind: 'participant', yearId: 'Y1', participantId: byMember.get('C'), category: 'personnel' });
    expect(rl14.scope).toEqual({ kind: 'participant', yearId: 'Y1', participantId: byMember.get('A'), category: 'personnel' });
    expect(finding(plan, 'min_participation').scope.kind).toBe('detail');
  });

  it('EQ-3 (B.9.3 건별, 전부 현금): RL-17·RL-18 warn · RL-19 없음 · RL-7 34.8761% · RL-4/5 skipped · RL-8 ≈69.7756% · RL-9 100%', () => {
    const plan = evaluatePlan(EQ3);
    const { result, items, baseline } = sendAndEvaluate(EQ3);
    expectEquivalent(plan, result.evaluation);

    const ev = result.evaluation;
    const rl17 = finding(ev, 'equipment_review_threshold');
    expect([rl17.severity, rl17.actual, rl17.limit]).toEqual(['warn', 35_000_000, 30_000_000]);
    expect(rl17.scope).toMatchObject({ kind: 'item', yearId: 'Y1', category: 'facility_equipment' });
    const rl18 = finding(ev, 'material_notice_threshold');
    expect([rl18.severity, rl18.actual]).toEqual(['warn', 21_000_000]);
    expect(rl18.scope.kind).toBe('item');
    expect(ev.findings.some((f) => f.code === 'outsourcing_notice_threshold')).toBe(false);
    expect(round4(ev.ratios.external_tech_max[0]!.actual)).toBe(34.8761);
    expect(ev.skipped).toEqual([
      { code: 'allowance_max', reason: '수정인건비가 0', yearId: 'Y1' },
      { code: 'allowance_min', reason: '수정인건비가 0', yearId: 'Y1' },
    ]);
    expect(round4(ev.ratios.gov_share_max[0]!.actual)).toBe(69.7756);
    expect(ev.ratios.own_cash_min[0]!.actual).toBe(100);

    // 보낸 버전의 편성 항목 4건, 금액 줄 대조 차이 0
    expect(items).toHaveLength(4);
    const view = buildItemsView({ items: items.map((it) => ({ ...it })), lines: baseline.lines, years: [{ id: 'Y1', name: '1차년도', order: 0 }], findings: ev.findings });
    expect(view.hasDifference).toBe(false);
  });
});

function sendParams(fx: EqFixture): AgreementRuleInputParams {
  const { baseline, participants, items } = sendAndEvaluate(fx);
  if (!baseline.ok) throw new Error('보내기 실패');
  return {
    lines: baseline.lines,
    participants,
    items,
    govSupport: Object.entries(baseline.govCash).map(([yearId, govCash]) => ({ yearId, govCash })),
    members: fx.members,
    years: [{ id: 'Y1', name: '1차년도', order: 0 }],
    rules: MOE_RULES,
  };
}

// ─── 수행 RL-8·RL-9 — 8-1과 교차 ──────────────────────────────────────────────

describe('수행 RL-8·RL-9 — 버전 정부지원 현금 기준', () => {
  const RULES_81 = [rule('gov_share_max', 75), rule('own_cash_min', 40)];

  it('Phase 25 8-1 픽스처 → RL-8 66.5399% · RL-9 43.1818% = 붙임4형 8-1 합계 행', () => {
    const adapted = buildAgreementRuleInput(params({ rules: RULES_81 }));
    expect(adapted.totalsSource).toBe('agreement_gov_support');
    expect(AGREEMENT_RULE_TOTALS_SOURCE_LABEL).toBe('버전 정부지원 현금 기준');
    expect(adapted.input.project).toEqual({ govBudget: 70_000_000, ownBudget: 35_200_000, totalBudget: 105_200_000 });

    const { evaluation } = evaluateAgreementRules(params({ rules: RULES_81 }));
    const gov = evaluation.ratios.gov_share_max[0]!.actual;
    const own = evaluation.ratios.own_cash_min[0]!.actual;
    expect(round4(gov)).toBe(66.5399);
    expect(round4(own)).toBe(43.1818);
    expect(evaluation.findings).toEqual([]);

    const total = buildAttachment4View({ lines: VERSION_A, years: YEARS_2, stages: [{ id: 'S1', name: '1단계', order: 0 }], govSupport: GOV_35, rules: RULES_81 })
      .plan81.rows.find((r) => r.kind === 'total')!;
    expect(gov).toBe(total.govShare.value);
    expect(own).toBe(total.ownCashShare.value);
  });

  it('Y2 정부지원 현금 미입력 → 총액 3종 null + RL-8·RL-9 skipped(연차 이름 포함) — 0으로 대체하지 않는다', () => {
    const p = params({ govSupport: [GOV_35[0]!], rules: RULES_81 });
    const adapted = buildAgreementRuleInput(p);
    expect(adapted.input.project).toEqual({
      govBudget: null, ownBudget: null, totalBudget: null, unavailableReason: '정부지원 현금 미입력(2차년도)',
    });
    const { evaluation } = evaluateAgreementRules(p);
    expect(evaluation.skipped).toEqual([
      { code: 'gov_share_max', reason: '정부지원 현금 미입력(2차년도)', yearId: null },
      { code: 'own_cash_min', reason: '정부지원 현금 미입력(2차년도)', yearId: null },
    ]);
    expect(evaluation.ratios.gov_share_max[0]!.actual).toBeNull();
  });

  it('정부지원 현금 > 그 연차 현금 합(Y1 45,000,000 > 42,500,000) → skipped, 사유에 1차년도', () => {
    const p = params({ govSupport: [{ yearId: 'Y1', govCash: 45_000_000 }, GOV_35[1]!], rules: RULES_81 });
    const { evaluation } = evaluateAgreementRules(p);
    expect(evaluation.skipped.map((s) => s.code)).toEqual(['gov_share_max', 'own_cash_min']);
    expect(evaluation.skipped[0]!.reason).toContain('1차년도');
    expect(evaluation.skipped[0]!.reason).toContain('현금 합보다 큼');
  });

  it('기호 혼동(Y1 personnel_support 현금 4,000,000) → RL-4 분모 40,000,000 = modifiedPersonnel → 7.5% (44,000,000이면 틀림)', () => {
    const lines = [...VERSION_A, line('Y1', 'personnel', 'personnel_support', 'cash', 4_000_000)];
    const { evaluation } = evaluateAgreementRules(params({ lines, rules: [rule('allowance_max', 20), rule('no_personnel_support', null)] }));
    const y1 = evaluation.ratios.allowance_max.find((r) => r.yearId === 'Y1')!;
    expect(y1.denominator).toBe(40_000_000);
    expect(y1.actual).toBe(7.5);
    // personnel_support 줄은 RL-11 재료로도 그대로 간다
    expect(finding(evaluation, 'no_personnel_support').actual).toBe(4_000_000);
  });
});

// ─── 세목 미지정(⑥) ───────────────────────────────────────────────────────────

describe('세목 미지정 금액 — 판정에서 빠진 사실을 skipped로 남긴다(⑥)', () => {
  const ACTIVITY_DEFAULT = [...VERSION_A, line('Y1', 'activity', 'default', 'cash', 1_000_000)];
  const REASON = '세목 미지정 연구활동비 1,000,000원 — 세목을 알 수 없어 판정에서 뺐습니다';

  it('activity/default 1,000,000 + RL-7 켜짐 → 그 연차 RL-7 어댑터 skipped (판정 결과 skipped 뒤에)', () => {
    const p = params({ lines: ACTIVITY_DEFAULT, rules: [rule('external_tech_max', 40)] });
    expect(buildAgreementRuleInput(p).skipped).toEqual([{ code: 'external_tech_max', reason: REASON, yearId: 'Y1' }]);
    const { evaluation, notes } = evaluateAgreementRules(p);
    expect(evaluation.skipped.at(-1)).toEqual({ code: 'external_tech_max', reason: REASON, yearId: 'Y1' });
    expect(notes).toContainEqual({
      kind: 'unassigned_subcategory', yearId: 'Y1', category: 'activity', amount: 1_000_000, message: `1차년도 ${REASON}`,
    });
  });

  it('RL-7이 꺼져 있으면 skipped는 없고 메모만 남는다', () => {
    const adapted = buildAgreementRuleInput(params({ lines: ACTIVITY_DEFAULT, rules: [rule('external_tech_max', 40, { enabled: false })] }));
    expect(adapted.skipped).toEqual([]);
    expect(adapted.notes.map((n) => n.kind)).toEqual(['unassigned_subcategory']);
  });

  it('personnel/default → RL-11, 다른 비목 default(allowance)는 메모 없음', () => {
    const lines = [...VERSION_A, line('Y2', 'personnel', 'default', 'in_kind', 2_000_000)];
    const adapted = buildAgreementRuleInput(params({ lines, rules: [rule('no_personnel_support', null)] }));
    expect(adapted.skipped).toEqual([
      { code: 'no_personnel_support', reason: '세목 미지정 인건비 2,000,000원 — 세목을 알 수 없어 판정에서 뺐습니다', yearId: 'Y2' },
    ]);
  });

  it('B.9.5 (수행) indirect/default 300,000 + 안전관리비 줄 없음 → findings 0건, 어댑터 skipped 2건', () => {
    const lines = [
      line('Y1', 'personnel', 'personnel_internal', 'cash', 80_000_000),
      line('Y1', 'personnel', 'personnel_internal', 'in_kind', 16_000_000),
      line('Y1', 'personnel', 'personnel_support', 'cash', 4_000_000),
      line('Y1', 'indirect', 'default', 'cash', 300_000),
    ];
    const rules = [rule('lab_safety_min', 1), rule('lab_safety_max', 2)];
    const { evaluation } = evaluateAgreementRules({
      lines, participants: [], items: [], govSupport: [{ yearId: 'Y1', govCash: 0 }], members: [],
      years: [{ id: 'Y1', name: '1차년도', order: 0 }], rules,
    });
    const reason = '세목 미지정 간접비 300,000원 — 세목을 알 수 없어 판정에서 뺐습니다';
    expect(evaluation.findings).toEqual([]);
    expect(evaluation.skipped).toEqual([
      { code: 'lab_safety_min', reason, yearId: 'Y1' },
      { code: 'lab_safety_max', reason, yearId: 'Y1' },
    ]);
  });

  it('RL-22 분자는 subcategoryTotals(금액 줄)에서 — indirect_lab_safety 999,999 → min warn (분모 100,000,000)', () => {
    const lines = [
      line('Y1', 'personnel', 'personnel_internal', 'cash', 80_000_000),
      line('Y1', 'personnel', 'personnel_internal', 'in_kind', 16_000_000),
      line('Y1', 'personnel', 'personnel_support', 'cash', 4_000_000),
      line('Y1', 'indirect', 'indirect_lab_safety', 'cash', 999_999),
    ];
    const { evaluation } = evaluateAgreementRules({
      lines, participants: [], items: [], govSupport: [{ yearId: 'Y1', govCash: 0 }], members: [],
      years: [{ id: 'Y1', name: '1차년도', order: 0 }], rules: [rule('lab_safety_min', 1), rule('lab_safety_max', 2)],
    });
    const f = finding(evaluation, 'lab_safety_min');
    expect(f.actual).toBeCloseTo(0.999999, 10);
    expect(evaluation.skipped).toEqual([]);
  });
});

// ─── 참여인원·편성 항목 행 ────────────────────────────────────────────────────

describe('참여인원 → 인력 행, 편성 항목 → 건 행', () => {
  const MEMBERS = [{ id: 'M1', hireType: 'existing' as const }];
  const RULES = [rule('existing_personnel_cash', null), rule('min_participation', 10), rule('existing_cash_le_new', null)];

  function participant(over: Partial<RuleInputParticipant>): RuleInputParticipant {
    return { id: 'P1', memberId: 'M1', yearId: 'Y1', participationRate: 8, months: 12, personnelCash: 0, personnelInKind: 0, ...over };
  }

  it('현금·현물 두 축이면 행 둘, RL-16 참여율은 한 번만(8% → 16%로 두 배가 되지 않는다)', () => {
    const p = params({ participants: [participant({ personnelCash: 3_000_000, personnelInKind: 2_000_000 })], members: MEMBERS, rules: RULES });
    const rows = buildAgreementRuleInput(p).input.years.find((y) => y.yearId === 'Y1')!.rows;
    expect(rows.map((r) => [r.detail.axis, r.amount, r.origin])).toEqual([
      ['cash', 3_000_000, { kind: 'participant', id: 'P1' }],
      ['in_kind', 2_000_000, { kind: 'participant', id: 'P1' }],
    ]);
    const { evaluation } = evaluateAgreementRules(p);
    expect(finding(evaluation, 'min_participation').actual).toBe(8);
    expect(finding(evaluation, 'existing_personnel_cash').actual).toBe(3_000_000);
  });

  it('금액 0(연봉 모름 등)인 참여인원도 RL-16 대상 — 현물 0원 행 하나(RL-14 소음 없음)', () => {
    const { evaluation } = evaluateAgreementRules(params({ participants: [participant({})], members: MEMBERS, rules: RULES }));
    expect(evaluation.findings.map((f) => f.code)).toEqual(['min_participation']);
  });

  it('인력 미지정 참여인원 → skipped "인력 정보가 없는 인건비 행 1건"(두 축이어도 1건)', () => {
    const p = params({ participants: [participant({ memberId: null, personnelCash: 1, personnelInKind: 1 })], rules: RULES });
    const { evaluation } = evaluateAgreementRules(p);
    expect(evaluation.skipped).toEqual([
      { code: 'existing_personnel_cash', reason: '인력 정보가 없는 인건비 행 1건', yearId: 'Y1' },
      { code: 'existing_cash_le_new', reason: '인력 정보가 없는 인건비 행 1건', yearId: 'Y1' },
      { code: 'min_participation', reason: '인력 정보가 없는 인건비 행 1건', yearId: 'Y1' },
    ]);
  });

  it('참여인원이 있으면 학생 구분 없음 메모', () => {
    const { notes } = buildAgreementRuleInput(params({ participants: [participant({})], members: MEMBERS }));
    expect(notes.map((n) => n.kind)).toEqual(['participants_without_student_split']);
  });

  it('금액 줄(세목 합계)은 건이 아니다 — facility_purchase 줄 35,000,000만 있으면 RL-17 0건', () => {
    const lines = [...VERSION_A, line('Y1', 'facility_equipment', 'facility_purchase', 'cash', 35_000_000)];
    const { evaluation } = evaluateAgreementRules(params({ lines, rules: [rule('equipment_review_threshold', 30_000_000)] }));
    expect(evaluation.findings).toEqual([]);
  });

  it('손상 데이터는 던진다 — 없는 인력·없는 연차·음수 금액', () => {
    expect(() => buildAgreementRuleInput(params({ participants: [participant({ memberId: 'ghost' })] }))).toThrow(/인력/);
    expect(() => buildAgreementRuleInput(params({ lines: [line('Y9', 'material', 'default', 'cash', 1)] }))).toThrow(/연차/);
    expect(() => buildAgreementRuleInput(params({ items: [{ id: 'I', yearId: 'Y1', kind: 'material', name: 'x', amount: -1 }] }))).toThrow(/원 단위 정수/);
  });
});

// ─── 판정 대상 버전 ───────────────────────────────────────────────────────────

describe('ruleTargetVersionId — 보고 있는 버전 → 현재 버전 → null', () => {
  const v1: VersionRef = { id: 'v1', kind: 'final', status: 'confirmed', order: 1 };
  const v2: VersionRef = { id: 'v2', kind: 'amendment', status: 'draft', order: 2 };

  it('[] → null ("판정할 버전 없음" — 빈 findings와 다르다)', () => {
    expect(ruleTargetVersionId([], null)).toBeNull();
    expect(ruleTargetVersionId([], 'v1')).toBeNull();
  });

  it('[v1 확정, v2 작성 중]에서 v2를 보고 있음 → v2 / 고른 것 없음 → v1(현재 버전)', () => {
    expect(ruleTargetVersionId([v1, v2], 'v2')).toBe('v2');
    expect(ruleTargetVersionId([v1, v2], null)).toBe('v1');
  });

  it('고른 버전이 그사이 지워졌으면 현재 버전(보기와 같은 규칙)', () => {
    expect(ruleTargetVersionId([v1, v2], 'gone')).toBe('v1');
  });

  it('null과 빈 findings는 다른 값이다 — 버전이 있고 위반이 없으면 findings []', () => {
    const target = ruleTargetVersionId([v1], null);
    expect(target).toBe('v1');
    expect(evaluateAgreementRules(params({ rules: [] })).evaluation.findings).toEqual([]);
  });
});

// ─── 8-2 규칙 판정 줄 ─────────────────────────────────────────────────────────

describe('rule-view — 8-2 아래 RL-4·RL-3 판정 줄 (같은 evaluateRules 결과)', () => {
  const YEAR_IDS = ['Y1', 'Y2'];

  it('RL-3 줄은 분모 base 라벨을 싣고, 양식 분모와 다를 수 있다는 안내가 붙는다', () => {
    // 양식 분모 ≠ RL-3 픽스처: Y1 student_general 현물 1,000,000 → 표 6.0976%, RL-3 6.25%
    const lines = [...VERSION_A, line('Y1', 'student_personnel', 'student_general', 'in_kind', 1_000_000)];
    const rules = [rule('allowance_max', 20), rule('indirect_max', 10, { base: 'direct_cash_excl_intl' })];
    const { evaluation } = evaluateAgreementRules(params({ lines, rules }));
    const view = buildForm82RuleView(evaluation, rules, YEAR_IDS);

    expect(view.note).toBe('표의 간접비 비율은 양식 분모라 RL-3과 다를 수 있습니다');
    expect(view.lines.map((l) => [l.ruleRef, l.label])).toEqual([
      ['RL-4', FORM82_RULE_TEXT.allowanceLabel],
      ['RL-3', FORM82_RULE_TEXT.indirectLabel],
    ]);
    const rl3 = view.lines[1]!;
    expect(rl3.baseLabel).toBe(INDIRECT_BASE_LABELS.direct_cash_excl_intl);
    expect(rl3.years[0]).toEqual({ yearId: 'Y1', cell: { status: 'pass', label: '통과', actual: 6.25, limit: 10 } });
    expect(view.lines[0]!.baseLabel).toBeNull();
    // 학생인건비 현물도 E1(PL-11)에 들어간다 — 3,000,000 / 41,000,000
    const rl4y1 = view.lines[0]!.years[0]!.cell;
    expect(rl4y1).toMatchObject({ status: 'pass', limit: 20 });
    expect(rl4y1.status === 'pass' && round4(rl4y1.actual)).toBe(7.3171);
  });

  it('위반은 판정기 finding을 그대로 옮긴다 — RL-4 7% 한도면 두 연차 경고', () => {
    const rules = [rule('allowance_max', 7)];
    const { evaluation } = evaluateAgreementRules(params({ rules }));
    const rl4 = buildForm82RuleView(evaluation, rules, YEAR_IDS).lines[0]!;
    expect(rl4.years.map((y) => y.cell.status)).toEqual(['fail', 'fail']);
    const y1 = rl4.years[0]!.cell;
    if (y1.status !== 'fail') throw new Error('fail이어야 한다');
    expect(y1.message).toBe(finding({ ...evaluation, findings: evaluation.findings.filter((f) => f.scope.kind === 'year' && f.scope.yearId === 'Y1') }, 'allowance_max').message);
    expect(round4(rl4.totalActual)).toBe(7.3171);
  });

  it('판정하지 않음 — 규칙 행 없음·꺼짐, 분모 0(skipped 사유 그대로)', () => {
    const none = evaluateAgreementRules(params()).evaluation;
    const view = buildForm82RuleView(none, [rule('allowance_max', 20, { enabled: false })], YEAR_IDS);
    expect(view.lines[0]!.years[0]!.cell).toEqual({ status: 'skipped', label: '판정하지 않음', reason: 'RL-4 규칙이 꺼져 있습니다' });
    expect(view.lines[1]!.years[0]!.cell).toEqual({ status: 'skipped', label: '판정하지 않음', reason: 'RL-3 규칙 행이 없습니다' });

    // Y2에 인건비 줄이 없으면 E1 = 0 → 판정기 skipped "수정인건비가 0"
    const lines = VERSION_A.filter((l) => !(l.yearId === 'Y2' && l.category === 'personnel'));
    const rules = [rule('allowance_max', 20)];
    const ev = evaluateAgreementRules(params({ lines, rules })).evaluation;
    expect(buildForm82RuleView(ev, rules, YEAR_IDS).lines[0]!.years[1]!.cell).toEqual({
      status: 'skipped', label: '판정하지 않음', reason: '수정인건비가 0',
    });
  });
});

// ─── B.9.8 장비 사전 승인 ─────────────────────────────────────────────────────

describe('B.9.8 변경 이력 장비 사전 승인 (AG-7 ④)', () => {
  const RL17 = rule('equipment_review_threshold', 30_000_000);
  const item = (id: string, kind: EquipmentApprovalItem['kind'], name: string, amount: number): EquipmentApprovalItem => ({
    id, yearId: 'Y1', kind, name, amount,
  });
  const A = [
    item('a1', 'material', '분광기', 28_000_000),
    item('a2', 'equipment', '오실로스코프', 27_000_000),
    item('a3', 'equipment', '레이저', 40_000_000),
  ];
  const B = [
    item('b1', 'equipment', '분광기', 28_000_000),
    item('b2', 'equipment', ' 오실로스코프 ', 27_272_728),
    item('b3', 'equipment', '레이저', 41_000_000),
    item('b4', 'equipment', '현미경', 20_000_000),
  ];

  it('경고 2건(재료 → 장비 이관 · 기준 미만 → 이상), 레이저·현미경 없음', () => {
    const result = diffEquipmentApproval(A, B, RL17);
    if (result.status !== 'judged') throw new Error('판정해야 한다');
    expect(result.warnings.map((w) => [w.itemId, w.name, w.reason, w.beforeEquipmentAmounts, w.afterAmount])).toEqual([
      ['b1', '분광기', 'moved', null, 28_000_000],
      ['b2', '오실로스코프', 'crossed', [27_000_000], 27_272_728],
    ]);
    expect(result.warnings[0]!.beforeOtherKinds).toEqual(['material']);
  });

  it('B 버전의 RL-17 finding은 3건(분광기·오실로스코프·레이저) — 같은 판정기', () => {
    const { evaluation } = evaluateAgreementRules(params({ items: B, rules: [RL17] }));
    expect(evaluation.findings.filter((f) => f.code === 'equipment_review_threshold').map((f) => f.scope.kind === 'item' && f.scope.itemId))
      .toEqual(['b1', 'b2', 'b3']);
  });

  it('A의 같은 키 장비가 여럿이면 하나라도 기준 이상이면 이미 대상', () => {
    const result = diffEquipmentApproval([...A, item('a4', 'equipment', '오실로스코프', 31_000_000)], B, RL17);
    expect(result.status === 'judged' && result.warnings.map((w) => w.itemId)).toEqual(['b1']);
  });

  it('새 장비가 기준 이상이면 경고(reason new), 다른 연차의 같은 품명은 다른 키', () => {
    const result = diffEquipmentApproval([{ ...A[2]!, yearId: 'Y2' }], [item('n1', 'equipment', '레이저', 41_000_000)], RL17);
    expect(result.status === 'judged' && result.warnings.map((w) => w.reason)).toEqual(['new']);
  });

  it('RL-17 행이 꺼졌거나 없으면 판정하지 않음(경고 0건과 구별)', () => {
    expect(diffEquipmentApproval(A, B, { ...RL17, enabled: false })).toEqual({
      status: 'not_judged', reason: 'RL-17 규칙이 꺼져 있어 판정하지 않습니다',
    });
    expect(diffEquipmentApproval(A, B, undefined).status).toBe('not_judged');
    expect(diffEquipmentApproval(A, B, { ...RL17, value: null }).status).toBe('not_judged');
    expect(diffEquipmentApproval([], [], RL17)).toEqual({ status: 'judged', threshold: 30_000_000, warnings: [] });
  });
});

// ─── 판정 로직 재작성 0 ───────────────────────────────────────────────────────

describe('판정기는 하나 — 새 모듈에 판정 로직·분모 산식이 없다(소스 검사)', () => {
  const ROOT = path.resolve(__dirname, '../..');
  const read = (rel: string): string =>
    fs.readFileSync(path.join(ROOT, rel), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
  const FILES = ['lib/agreement/rule-input.ts', 'lib/agreement/rule-view.ts', 'lib/agreement/equipment-approval.ts'];

  it.each(FILES)('%s: 비율 계산·×1.1·분모 함수 호출 없음', (file) => {
    const src = read(file);
    expect(src).not.toMatch(/\*\s*100\b/);
    expect(src).not.toMatch(/\*\s*1\.1\b|\*\s*11\b/);
    expect(src).not.toMatch(/\b(modifiedPersonnel|modifiedDirectCost|totalPersonnelCost)\(/);
    expect(src).not.toMatch(/\bviolates\(/);
  });

  it('어댑터는 buildYearTotals·evaluateRules를, 장비 사전 승인은 meetsEquipmentThreshold를 쓴다', () => {
    expect(read('lib/agreement/rule-input.ts')).toMatch(/buildYearTotals\(/);
    expect(read('lib/agreement/rule-input.ts')).toMatch(/evaluateRules\(/);
    expect(read('lib/agreement/equipment-approval.ts')).toMatch(/meetsEquipmentThreshold\(/);
  });
});
