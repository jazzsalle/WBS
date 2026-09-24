// 연구비 사용 규칙 판정 테스트 (SOT §6.14 RL-1~RL-19, §6.14.6, 부록 B.9, 부록 D)
//
// 부록 B.9의 숫자를 그대로 옮긴다 — 다른 값이 나오면 구현이 틀린 것이다.
// B.9.1은 부록 B.7 1차년도 실측 합계(tests/unit/budget-plan.test.ts가 행 단위로 고정한 값)에
// `moe_energy_sme` 프리셋을 적용한 기대값이고, B.9.2~B.9.4는 합성 데이터다.
//
// Phase 9의 한도 판정(allowance_max 경계값 등)도 여기로 옮겨 왔다 — 한도가 Project 컬럼에서
// 규칙 행으로 옮겨졌기 때문이다(§5.18).

import { describe, expect, it } from 'vitest';
import {
  aggregateDetails,
  buildYearTotals,
  modifiedPersonnel,
  type YearCategoryTotals,
} from '@/lib/budget-plan';
import { PRESET_IDS, RULE_PRESETS, presetToRows, type PresetId } from '@/lib/rules-presets';
import {
  DEFAULT_INDIRECT_BASE,
  RATIO_CODES,
  RULE_SPECS,
  evaluateRules,
  modifiedDirectCost,
  type RuleDetailInput,
  type RuleEvaluationInput,
  type RuleInput,
  type RuleRowInput,
  type RuleYearInput,
} from '@/lib/rules';
import type { BudgetCategory, BudgetDetail, DetailAxis, DetailFactor, HireType, RuleCode } from '@/types';

// ─── 픽스처 헬퍼 ─────────────────────────────────────────────

function totals(
  spec: Partial<Record<BudgetCategory, [number, number]>>,
  personnelSupportTotal = 0
): YearCategoryTotals {
  const sources = Object.entries(spec).map(([key, [cash, inKind]]) => {
    const amounts = { cashAmount: cash, inKindAmount: inKind, plannedAmount: cash + inKind };
    return key === 'personnel'
      ? { category: 'personnel' as const, ...amounts, personnelSupportTotal }
      : { category: key as Exclude<BudgetCategory, 'personnel'>, ...amounts };
  });
  return buildYearTotals(sources);
}

let seq = 0;

/** BudgetDetail 전체를 만든다 — 판정기가 실제 엔티티를 그대로 받는지도 함께 고정한다 */
function detail(spec: {
  id?: string;
  yearId?: string;
  category: BudgetCategory;
  subcategory?: string;
  axis?: DetailAxis;
  formula?: BudgetDetail['formula'];
  memberId?: string | null;
  name?: string;
  unitPrice?: number;
  factors?: DetailFactor[];
}): BudgetDetail {
  seq += 1;
  const formula = spec.formula ?? (spec.memberId ? 'personnel' : 'quantity');
  return {
    id: spec.id ?? `d${seq}`,
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    version: 1,
    createdBy: null,
    updatedBy: null,
    projectId: 'p1',
    yearId: spec.yearId ?? 'y1',
    category: spec.category,
    subcategory: spec.subcategory ?? 'default',
    axis: spec.axis ?? 'cash',
    formula,
    memberId: spec.memberId ?? null,
    name: spec.name ?? '',
    unitPrice: spec.unitPrice ?? 0,
    spec: '',
    factors: spec.factors ?? [],
    adjustment: 0,
    note: '',
    order: seq,
    amount: -1, // PL-D7: 판정기는 저장된 amount가 아니라 입력 amount를 본다
  };
}

function personnelFactors(ratePercent: number, months: number): DetailFactor[] {
  return [
    { label: '참여율(%)', value: ratePercent, isPercent: true },
    { label: '참여기간(월)', value: months, isPercent: false },
  ];
}

/** quantity 행 하나 — 금액은 그대로 amount로 넘긴다(계산은 budget-plan의 몫) */
function quantityRow(
  category: BudgetCategory,
  subcategory: string,
  name: string,
  amount: number,
  id?: string
): RuleRowInput {
  return { detail: detail({ id, category, subcategory, name, unitPrice: amount }), amount };
}

function year(yearId: string, t: YearCategoryTotals, rows: readonly RuleRowInput[] = []): RuleYearInput {
  return { yearId, totals: t, rows };
}

const B91_PROJECT = { govBudget: 225_000_000, ownBudget: 100_000_000, totalBudget: 325_000_000 };

function preset(id: PresetId): RuleInput[] {
  return presetToRows(id);
}

/** 프리셋에서 한 코드만 바꾼 규칙 배열 */
function withRule(rules: RuleInput[], code: RuleCode, patch: Partial<RuleInput>): RuleInput[] {
  return rules.map((r) => (r.code === code ? { ...r, ...patch } : r));
}

function findingsOf(evaluation: ReturnType<typeof evaluateRules>, code: RuleCode) {
  return evaluation.findings.filter((f) => f.code === code);
}

function round4(value: number | null): number | null {
  return value === null ? null : Math.round(value * 10_000) / 10_000;
}

// ─── 부록 B.9.1 — B.7 1차년도 + moe_energy_sme ───────────────

describe('부록 B.9.1 — B.7 1차년도 합계에 moe_energy_sme 프리셋 적용', () => {
  // 인건비 현금 180,840,000 / 현물 88,650,000 · 연구활동비 현금 27,020,000 · 간접비 현금 2,000,000
  const b7 = totals({
    personnel: [180_840_000, 88_650_000],
    activity: [27_020_000, 0],
    indirect: [2_000_000, 0],
  });
  const input: RuleEvaluationInput = { years: [year('y1', b7)], project: B91_PROJECT };
  const rules = preset('moe_energy_sme');
  const evaluation = evaluateRules(rules, input);
  const source = (code: RuleCode) => rules.find((r) => r.code === code)!.source;

  it('RL-3 indirect_max: 2,000,000 / 207,860,000 = 0.9622% (base=direct_cash_excl_intl) → 통과', () => {
    const [y1] = evaluation.ratios.indirect_max;
    expect(y1).toMatchObject({ yearId: 'y1', enabled: true, limit: 10, numerator: 2_000_000, denominator: 207_860_000 });
    expect(round4(y1!.actual)).toBe(0.9622);
    expect(y1!.actual).toBeCloseTo(0.962186, 6);
    expect(findingsOf(evaluation, 'indirect_max')).toEqual([]);
    // promotion·other·위탁·국제공동·부담비가 0이라 두 base가 같은 수를 낸다 (PL-13 주석)
    expect(modifiedDirectCost(b7, 'direct_cash_excl_intl')).toBe(207_860_000);
    expect(modifiedDirectCost(b7, DEFAULT_INDIRECT_BASE)).toBe(207_860_000);
  });

  it('RL-4 allowance_max: 0 / 269,490,000 = 0.00% → 통과', () => {
    const [y1] = evaluation.ratios.allowance_max;
    expect(y1).toMatchObject({ yearId: 'y1', actual: 0, limit: 20, enabled: true, numerator: 0, denominator: 269_490_000 });
    expect(findingsOf(evaluation, 'allowance_max')).toEqual([]);
  });

  it('RL-5 allowance_min: 0.00% < 10 → info 1건 "권고 하한 미만"', () => {
    const findings = findingsOf(evaluation, 'allowance_min');
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({
      severity: 'info',
      scope: { kind: 'year', yearId: 'y1' },
      actual: 0,
      limit: 10,
      approximate: false,
    });
    expect(findings[0]!.message).toContain('권고 하한');
    expect(findings[0]!.message.endsWith(`(${source('allowance_min')})`)).toBe(true);
  });

  it('RL-6 consignment_max: 0 / 296,510,000 → 통과', () => {
    const [y1] = evaluation.ratios.consignment_max;
    expect(y1).toMatchObject({ actual: 0, numerator: 0, denominator: 296_510_000, limit: 40 });
    expect(findingsOf(evaluation, 'consignment_max')).toEqual([]);
  });

  it('RL-7 external_tech_max: 0 / 296,510,000 → 통과, 근사 표식', () => {
    const [y1] = evaluation.ratios.external_tech_max;
    expect(y1).toMatchObject({ actual: 0, numerator: 0, denominator: 296_510_000, limit: 40 });
    expect(RULE_SPECS.external_tech_max.approximate).toBe(true);
    expect(findingsOf(evaluation, 'external_tech_max')).toEqual([]);
  });

  it('RL-8 gov_share_max: 225,000,000 / 325,000,000 = 69.2308% ≤ 75 → 통과', () => {
    const [project] = evaluation.ratios.gov_share_max;
    expect(project).toMatchObject({ yearId: null, limit: 75, enabled: true, numerator: 225_000_000, denominator: 325_000_000 });
    expect(round4(project!.actual)).toBe(69.2308);
    expect(findingsOf(evaluation, 'gov_share_max')).toEqual([]);
  });

  it('RL-8 value를 67(혁신제품형)로 바꾸면 error', () => {
    const changed = evaluateRules(withRule(rules, 'gov_share_max', { value: 67 }), input);
    const findings = findingsOf(changed, 'gov_share_max');
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ severity: 'error', scope: { kind: 'project' }, limit: 67, approximate: false });
    expect(round4(findings[0]!.actual)).toBe(69.2308);
    expect(findings[0]!.message.endsWith(`(${source('gov_share_max')})`)).toBe(true);
  });

  it('RL-9 own_cash_min: (100,000,000 − 88,650,000) / 100,000,000 = 11.35% ≥ 10 → 통과, 근사', () => {
    const [project] = evaluation.ratios.own_cash_min;
    expect(project).toMatchObject({ yearId: null, actual: 11.35, limit: 10, enabled: true, numerator: 11_350_000, denominator: 100_000_000 });
    expect(RULE_SPECS.own_cash_min.approximate).toBe(true);
    expect(findingsOf(evaluation, 'own_cash_min')).toEqual([]);
  });

  it('RL-9 ownBudget 90,000,000이면 현금 1,350,000 = 1.5% → error (approximate)', () => {
    const changed = evaluateRules(rules, { ...input, project: { ...B91_PROJECT, ownBudget: 90_000_000 } });
    const findings = findingsOf(changed, 'own_cash_min');
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ severity: 'error', scope: { kind: 'project' }, actual: 1.5, limit: 10, approximate: true });
    expect(changed.ratios.own_cash_min[0]).toMatchObject({ numerator: 1_350_000, denominator: 90_000_000 });
  });

  it('RL-10~13 · RL-17~19: 해당 없음 — findings는 allowance_min 하나뿐', () => {
    for (const code of [
      'indirect_cash_only',
      'no_personnel_support',
      'no_student_personnel',
      'no_burden',
      'existing_personnel_cash',
      'existing_cash_le_new',
      'min_participation',
      'equipment_review_threshold',
      'material_notice_threshold',
      'outsourcing_notice_threshold',
    ] as RuleCode[]) {
      expect(findingsOf(evaluation, code), code).toEqual([]);
    }
    expect(evaluation.findings.map((f) => f.code)).toEqual(['allowance_min']);
    expect(evaluation.skipped).toEqual([]);
  });

  it('비율 7종이 전부 ratios에 있고 연차 단위 코드는 과제 단위 합계(yearId null)를 하나 더 갖는다 (RL-2)', () => {
    expect(Object.keys(evaluation.ratios).sort()).toEqual([...RATIO_CODES].sort());
    for (const code of ['allowance_max', 'allowance_min', 'indirect_max', 'consignment_max', 'external_tech_max'] as const) {
      const entries = evaluation.ratios[code];
      expect(entries.map((e) => e.yearId)).toEqual(['y1', null]);
      // 연차가 하나뿐이니 합계는 그 연차와 같다
      expect(entries[1]).toMatchObject({ numerator: entries[0]!.numerator, denominator: entries[0]!.denominator });
    }
    expect(evaluation.ratios.gov_share_max.map((e) => e.yearId)).toEqual([null]);
    expect(evaluation.ratios.own_cash_min.map((e) => e.yearId)).toEqual([null]);
  });
});

// ─── 부록 B.9.2 — 합성 인력 3명 (RL-14·RL-15·RL-16) ──────────

describe('부록 B.9.2 — 합성 인력 3명', () => {
  type Person = { id: string; hireType: HireType; salary: number; rate: number; axis: DetailAxis };
  const A: Person = { id: 'A', hireType: 'existing', salary: 60_000_000, rate: 30, axis: 'cash' };
  const B: Person = { id: 'B', hireType: 'new', salary: 48_000_000, rate: 50, axis: 'cash' };
  const C: Person = { id: 'C', hireType: 'existing', salary: 50_000_000, rate: 5, axis: 'in_kind' };

  /** 금액은 lib/budget-plan.ts가 계산하고(PL-1) 판정기는 그 결과를 받는다 */
  function build(people: Person[]) {
    const details = people.map((p) =>
      detail({
        id: `row-${p.id}`,
        category: 'personnel',
        subcategory: 'personnel_internal',
        axis: p.axis,
        formula: 'personnel',
        memberId: p.id,
        factors: personnelFactors(p.rate, 12),
      })
    );
    const aggregate = aggregateDetails(details, people.map((p) => ({ id: p.id, annualSalary: p.salary })));
    const rows: RuleRowInput[] = details.map((d, i) => ({
      detail: d,
      amount: aggregate.rows[i]!.amount,
      member: { id: d.memberId!, hireType: people[i]!.hireType },
    }));
    const t = buildYearTotals(aggregate.cells);
    return { rows, totals: t, amounts: aggregate.rows.map((r) => r.amount) };
  }

  const base = build([A, B, C]);
  const project = { govBudget: 100_000_000, ownBudget: 50_000_000, totalBudget: 150_000_000 };
  const evaluation = evaluateRules(preset('moe_energy_sme'), { years: [year('y1', base.totals, base.rows)], project });

  it('금액: A 18,000,000 · B 24,000,000 · C 2,500,000 (PL-1)', () => {
    expect(base.amounts).toEqual([18_000_000, 24_000_000, 2_500_000]);
  });

  it('RL-14 existing_personnel_cash: A 행 1건 (existing + cash). C는 현물이라 아니다', () => {
    const findings = findingsOf(evaluation, 'existing_personnel_cash');
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({
      severity: 'warn',
      scope: { kind: 'detail', yearId: 'y1', detailId: 'row-A', category: 'personnel' },
      actual: 18_000_000,
      limit: null,
    });
  });

  it('RL-16 min_participation(10): C 행 1건 (5% < 10). A·B 통과', () => {
    const findings = findingsOf(evaluation, 'min_participation');
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({
      severity: 'error',
      scope: { kind: 'detail', yearId: 'y1', detailId: 'row-C', category: 'personnel' },
      actual: 5,
      limit: 10,
    });
  });

  it('RL-15 existing_cash_le_new: existing 현금 18,000,000 ≤ new 24,000,000 → 통과', () => {
    expect(findingsOf(evaluation, 'existing_cash_le_new')).toEqual([]);
  });

  it('RL-15: B의 참여율을 30%(14,400,000)로 낮추면 error', () => {
    const lowered = build([A, { ...B, rate: 30 }, C]);
    expect(lowered.amounts[1]).toBe(14_400_000);
    const changed = evaluateRules(preset('moe_energy_sme'), { years: [year('y1', lowered.totals, lowered.rows)], project });
    const findings = findingsOf(changed, 'existing_cash_le_new');
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({
      severity: 'error',
      scope: { kind: 'year', yearId: 'y1' },
      actual: 18_000_000,
      limit: 14_400_000,
    });
  });

  it('RL-15: 신규 인력 행이 0이면 기존 현금이 조금이라도 있을 때 위반이다', () => {
    const noNew = build([A, C]);
    const changed = evaluateRules(preset('moe_energy_sme'), { years: [year('y1', noNew.totals, noNew.rows)], project });
    expect(findingsOf(changed, 'existing_cash_le_new')[0]).toMatchObject({ actual: 18_000_000, limit: 0 });
  });

  it('PL-11 E1 = 44,500,000 (세 행 현금+현물) — 규칙 판정이 E1 산식을 바꾸지 않는다', () => {
    expect(modifiedPersonnel(base.totals)).toBe(44_500_000);
    expect(evaluation.ratios.allowance_max[0]!.denominator).toBe(44_500_000);
  });

  it('RL-16: 같은 Member의 행 둘(5% + 5% = 10%)은 합산해 통과한다', () => {
    const rows: RuleRowInput[] = [
      {
        detail: detail({ id: 'r1', category: 'personnel', subcategory: 'personnel_internal', memberId: 'M', factors: personnelFactors(5, 12) }),
        amount: 1_000_000,
        member: { id: 'M', hireType: 'new' },
      },
      {
        detail: detail({ id: 'r2', category: 'personnel', subcategory: 'personnel_external', memberId: 'M', factors: personnelFactors(5, 12) }),
        amount: 1_000_000,
        member: { id: 'M', hireType: 'new' },
      },
    ];
    const changed = evaluateRules(preset('moe_energy_sme'), {
      years: [year('y1', totals({ personnel: [2_000_000, 0] }), rows)],
      project,
    });
    expect(findingsOf(changed, 'min_participation')).toEqual([]);

    // 4% + 5% = 9%는 위반이고 finding은 첫 행을 가리킨다
    const under = evaluateRules(preset('moe_energy_sme'), {
      years: [year('y1', totals({ personnel: [2_000_000, 0] }), [{ ...rows[0]!, detail: { ...rows[0]!.detail, factors: personnelFactors(4, 12) } }, rows[1]!])],
      project,
    });
    expect(findingsOf(under, 'min_participation')).toHaveLength(1);
    expect(findingsOf(under, 'min_participation')[0]).toMatchObject({ actual: 9, scope: { kind: 'detail', detailId: 'r1', category: 'personnel' } });
  });

  it('RL-16: student_personnel 행은 제외한다', () => {
    const rows: RuleRowInput[] = [
      {
        detail: detail({ id: 's1', category: 'student_personnel', subcategory: 'student_general', memberId: 'S', factors: personnelFactors(3, 12) }),
        amount: 600_000,
        member: { id: 'S', hireType: 'new' },
      },
    ];
    const changed = evaluateRules(preset('moe_energy_sme'), {
      years: [year('y1', totals({ student_personnel: [600_000, 0] }), rows)],
      project,
    });
    expect(findingsOf(changed, 'min_participation')).toEqual([]);
  });

  it('인력 정보가 없는 인건비 행은 판정하지 못하고 skipped에 남긴다 — 조용히 빠지지 않는다', () => {
    const rows: RuleRowInput[] = [
      { detail: detail({ id: 'x1', category: 'personnel', subcategory: 'personnel_internal', memberId: 'ghost', factors: personnelFactors(5, 12) }), amount: 1_000_000 },
    ];
    const changed = evaluateRules(preset('moe_energy_sme'), {
      years: [year('y1', totals({ personnel: [1_000_000, 0] }), rows)],
      project,
    });
    const codes = changed.skipped.filter((s) => s.yearId === 'y1').map((s) => s.code).sort();
    expect(codes).toEqual(['existing_cash_le_new', 'existing_personnel_cash', 'min_participation']);
    expect(changed.skipped[0]!.reason).toContain('인력 정보가 없는 인건비 행 1건');
  });
});

// ─── 부록 B.9.3 — 건별 금액 알림 (RL-17~RL-19) ───────────────

describe('부록 B.9.3 — 건별 금액 알림', () => {
  const project = { govBudget: null, ownBudget: null, totalBudget: null };
  const t = totals({
    personnel: [50_000_000, 0],
    facility_equipment: [35_000_000, 0],
    material: [21_000_000, 0],
    activity: [29_990_000, 0],
  });

  function run(rows: RuleRowInput[]) {
    return evaluateRules(preset('moe_energy_sme'), { years: [year('y1', t, rows)], project });
  }

  it('RL-17: facility_purchase 35,000,000 → warn (30,000,000 이상)', () => {
    const evaluation = run([quantityRow('facility_equipment', 'facility_purchase', '분광기', 35_000_000, 'eq1')]);
    const findings = findingsOf(evaluation, 'equipment_review_threshold');
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({
      severity: 'warn',
      scope: { kind: 'detail', yearId: 'y1', detailId: 'eq1', category: 'facility_equipment' },
      actual: 35_000_000,
      limit: 30_000_000,
    });
    expect(findings[0]!.message).toContain('심의');
  });

  it('RL-18: material_purchase 같은 품명 12,000,000 + 9,000,000 = 21,000,000 → warn 1건 (합산, 첫 행)', () => {
    const evaluation = run([
      quantityRow('material', 'material_purchase', '시약 A', 12_000_000, 'm1'),
      quantityRow('material', 'material_purchase', ' 시약 A ', 9_000_000, 'm2'), // trim 후 같은 품명
    ]);
    const findings = findingsOf(evaluation, 'material_notice_threshold');
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({
      severity: 'warn',
      scope: { kind: 'detail', yearId: 'y1', detailId: 'm1', category: 'material' },
      actual: 21_000_000,
      limit: 20_000_000,
    });
  });

  it('RL-18: 품명이 다르면 합치지 않는다 (12,000,000 · 9,000,000 각각 미만)', () => {
    const evaluation = run([
      quantityRow('material', 'material_purchase', '시약 A', 12_000_000),
      quantityRow('material', 'material_purchase', '시약 B', 9_000_000),
    ]);
    expect(findingsOf(evaluation, 'material_notice_threshold')).toEqual([]);
  });

  it('RL-18: 연차가 다르면 합치지 않는다', () => {
    const evaluation = evaluateRules(preset('moe_energy_sme'), {
      years: [
        year('y1', t, [{ detail: detail({ yearId: 'y1', category: 'material', subcategory: 'material_purchase', name: '시약 A' }), amount: 12_000_000 }]),
        year('y2', t, [{ detail: detail({ yearId: 'y2', category: 'material', subcategory: 'material_purchase', name: '시약 A' }), amount: 9_000_000 }]),
      ],
      project,
    });
    expect(findingsOf(evaluation, 'material_notice_threshold')).toEqual([]);
  });

  it('RL-19: activity_outsourcing 29,990,000 → 통과 (경계 미만)', () => {
    const evaluation = run([quantityRow('activity', 'activity_outsourcing', '해석 용역', 29_990_000)]);
    expect(findingsOf(evaluation, 'outsourcing_notice_threshold')).toEqual([]);
  });

  it('RL-19: 정확히 30,000,000 → warn (≥ 경계값 포함)', () => {
    const evaluation = run([quantityRow('activity', 'activity_outsourcing', '해석 용역', 30_000_000, 'o1')]);
    const findings = findingsOf(evaluation, 'outsourcing_notice_threshold');
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ scope: { kind: 'detail', detailId: 'o1', category: 'activity' }, actual: 30_000_000, limit: 30_000_000 });
  });

  it('RL-17·RL-19도 정확히 경계값이면 대상이다', () => {
    const evaluation = run([quantityRow('facility_equipment', 'facility_purchase', '장비', 30_000_000)]);
    expect(findingsOf(evaluation, 'equipment_review_threshold')).toHaveLength(1);
    const under = run([quantityRow('facility_equipment', 'facility_purchase', '장비', 29_999_999)]);
    expect(findingsOf(under, 'equipment_review_threshold')).toEqual([]);
  });

  it('세목이 다르면 대상이 아니다 — 장비비 비목의 다른 세목 35,000,000은 RL-17 대상이 아니다', () => {
    const evaluation = run([quantityRow('facility_equipment', 'facility_rental', '임차', 35_000_000)]);
    expect(findingsOf(evaluation, 'equipment_review_threshold')).toEqual([]);
  });
});

// ─── 부록 B.9.4 — 판정 제외 (skipped) ────────────────────────

describe('부록 B.9.4 — 판정하지 못한 규칙은 skipped에 남는다', () => {
  it('E1 = 0인 연차: allowance_max · allowance_min이 "수정인건비가 0"으로 skipped, findings에는 없다', () => {
    const evaluation = evaluateRules(preset('moe_energy_sme'), {
      years: [year('y1', totals({ allowance: [5_000_000, 0] }))],
      project: B91_PROJECT,
    });
    expect(evaluation.skipped).toContainEqual({ code: 'allowance_max', reason: '수정인건비가 0', yearId: 'y1' });
    expect(evaluation.skipped).toContainEqual({ code: 'allowance_min', reason: '수정인건비가 0', yearId: 'y1' });
    expect(findingsOf(evaluation, 'allowance_max')).toEqual([]);
    expect(findingsOf(evaluation, 'allowance_min')).toEqual([]);
    expect(evaluation.ratios.allowance_max[0]).toMatchObject({ actual: null, numerator: 5_000_000, denominator: 0 });
  });

  it('govBudget null: gov_share_max가 "정부지원연구개발비 미입력"으로 skipped', () => {
    const evaluation = evaluateRules(preset('moe_energy_sme'), {
      years: [year('y1', totals({ personnel: [100_000_000, 0] }))],
      project: { ...B91_PROJECT, govBudget: null },
    });
    expect(evaluation.skipped).toContainEqual({ code: 'gov_share_max', reason: '정부지원연구개발비 미입력', yearId: null });
    expect(findingsOf(evaluation, 'gov_share_max')).toEqual([]);
    expect(evaluation.ratios.gov_share_max[0]!.actual).toBeNull();
  });

  it('totalBudget null · ownBudget null/0도 각각 사유를 남긴다', () => {
    const noTotal = evaluateRules(preset('moe_energy_sme'), {
      years: [year('y1', totals({ personnel: [100_000_000, 0] }))],
      project: { ...B91_PROJECT, totalBudget: null, ownBudget: null },
    });
    expect(noTotal.skipped.map((s) => s.code)).toEqual(expect.arrayContaining(['gov_share_max', 'own_cash_min']));
    expect(noTotal.skipped.find((s) => s.code === 'own_cash_min')!.reason).toBe('기관부담연구개발비 미입력');

    const zeroOwn = evaluateRules(preset('moe_energy_sme'), {
      years: [year('y1', totals({ personnel: [100_000_000, 0] }))],
      project: { ...B91_PROJECT, ownBudget: 0 },
    });
    expect(zeroOwn.skipped.find((s) => s.code === 'own_cash_min')!.reason).toBe('기관부담연구개발비가 0');
  });

  it('수정직접비가 0이면 indirect_max가 skipped — 간접비만 있는 연차', () => {
    const evaluation = evaluateRules(preset('msit_profit'), {
      years: [year('y1', totals({ indirect: [1_000_000, 0] }))],
      project: B91_PROJECT,
    });
    expect(evaluation.skipped).toContainEqual({ code: 'indirect_max', reason: '수정직접비가 0', yearId: 'y1' });
    expect(findingsOf(evaluation, 'indirect_max')).toEqual([]);
  });

  it('꺼진 규칙은 skipped에도 findings에도 없다 — "검사 안 함"은 ratios.enabled=false가 말한다', () => {
    const rules = withRule(preset('moe_energy_sme'), 'allowance_max', { enabled: false });
    const evaluation = evaluateRules(rules, {
      years: [year('y1', totals({ allowance: [5_000_000, 0] }))],
      project: B91_PROJECT,
    });
    expect(evaluation.skipped.map((s) => s.code)).not.toContain('allowance_max');
    expect(evaluation.ratios.allowance_max[0]!.enabled).toBe(false);
  });
});

// ─── PL-13 정정 — 분모는 직접비 11비목 · base가 고른다 ───────

describe('PL-13 정정 — indirect_max 분모', () => {
  const project = { govBudget: null, ownBudget: null, totalBudget: null };

  it('promotion 현금 1,000,000이 있으면 분모가 Phase 9의 6비목 합과 다르다', () => {
    const t = totals({
      personnel: [100_000_000, 0],
      activity: [20_000_000, 0],
      promotion: [1_000_000, 0],
      indirect: [12_100_000, 0],
    });
    const evaluation = evaluateRules(preset('msit_profit'), { years: [year('y1', t)], project });
    const [y1] = evaluation.ratios.indirect_max;
    expect(y1!.denominator).toBe(121_000_000);
    expect(y1!.denominator).not.toBe(120_000_000); // 6비목 합 — promotion이 빠진 옛 분모
    expect(y1!.actual).toBe(10); // 12,100,000 / 121,000,000 — 경계값, 위반 아님
    expect(findingsOf(evaluation, 'indirect_max')).toEqual([]);
    // 옛 분모였다면 10.08%로 위반이 됐을 것이다 — 분모 정정이 판정을 바꾼다
    expect((12_100_000 / 120_000_000) * 100).toBeGreaterThan(10);
  });

  it('other 현금도 분모에 든다', () => {
    const t = totals({ personnel: [100_000_000, 0], other: [5_000_000, 0], indirect: [10_500_000, 0] });
    const evaluation = evaluateRules(preset('msit_profit'), { years: [year('y1', t)], project });
    expect(evaluation.ratios.indirect_max[0]!.denominator).toBe(105_000_000);
    expect(evaluation.ratios.indirect_max[0]!.actual).toBe(10);
  });

  it('consignment 현금이 있는 연차에서 두 base의 비율이 다르다 (부록 D 주석)', () => {
    const t = totals({
      personnel: [100_000_000, 0],
      consignment: [50_000_000, 0],
      indirect: [12_000_000, 0],
    });
    // 과기부: 위탁을 뺀다 → 12,000,000 / 100,000,000 = 12% > 10 → error
    const msit = evaluateRules(preset('msit_profit'), { years: [year('y1', t)], project });
    expect(msit.ratios.indirect_max[0]).toMatchObject({ denominator: 100_000_000, actual: 12 });
    expect(findingsOf(msit, 'indirect_max')).toHaveLength(1);
    expect(findingsOf(msit, 'indirect_max')[0]).toMatchObject({ severity: 'error', scope: { kind: 'year', yearId: 'y1' }, actual: 12, limit: 10 });

    // 기후부: 위탁을 넣는다 → 12,000,000 / 150,000,000 = 8% ≤ 10 → 통과
    const moe = evaluateRules(preset('moe_energy_sme'), { years: [year('y1', t)], project });
    expect(moe.ratios.indirect_max[0]).toMatchObject({ denominator: 150_000_000, actual: 8 });
    expect(findingsOf(moe, 'indirect_max')).toEqual([]);
  });

  it('위탁·국제공동·부담비 제외가 정확하고 현물은 애초에 빠진다', () => {
    const t = totals({
      personnel: [100_000_000, 30_000_000],
      student_personnel: [10_000_000, 0],
      facility_equipment: [10_000_000, 5_000_000],
      material: [10_000_000, 0],
      activity: [10_000_000, 0],
      allowance: [10_000_000, 0],
      international: [50_000_000, 0],
      consignment: [40_000_000, 0],
      burden: [30_000_000, 0],
      promotion: [1_000_000, 0],
      other: [2_000_000, 0],
      indirect: [15_000_000, 0],
    });
    expect(modifiedDirectCost(t, 'direct_cash_excl_intl_consign_burden')).toBe(153_000_000);
    expect(modifiedDirectCost(t, 'direct_cash_excl_intl')).toBe(153_000_000 + 40_000_000 + 30_000_000);
  });

  it('indirect_max 행이 없으면 DEFAULT_INDIRECT_BASE(과기부)로 비율을 낸다', () => {
    const t = totals({ personnel: [100_000_000, 0], consignment: [50_000_000, 0], indirect: [12_000_000, 0] });
    const evaluation = evaluateRules([], { years: [year('y1', t)], project });
    expect(DEFAULT_INDIRECT_BASE).toBe('direct_cash_excl_intl_consign_burden');
    expect(evaluation.ratios.indirect_max[0]).toMatchObject({ denominator: 100_000_000, actual: 12, enabled: false, limit: null });
  });
});

// ─── RL-6 · RL-7 분모 (현금+현물) ────────────────────────────

describe('RL-6 consignment_max · RL-7 external_tech_max', () => {
  const project = { govBudget: null, ownBudget: null, totalBudget: null };

  it('RL-6 분모는 현금+현물이고 위탁·국제공동·부담비를 뺀다', () => {
    const t = totals({
      personnel: [60_000_000, 40_000_000],
      consignment: [45_000_000, 0],
      international: [10_000_000, 0],
      burden: [5_000_000, 0],
    });
    const evaluation = evaluateRules(preset('msit_profit'), { years: [year('y1', t)], project });
    // 분모 = 직접비 160,000,000 − 위탁 45,000,000 − 국제공동 10,000,000 − 부담비 5,000,000 = 100,000,000
    expect(evaluation.ratios.consignment_max[0]).toMatchObject({ numerator: 45_000_000, denominator: 100_000_000, actual: 45 });
    expect(findingsOf(evaluation, 'consignment_max')[0]).toMatchObject({ severity: 'error', actual: 45, limit: 40 });
  });

  it('RL-7 분자는 activity_expert + activity_outsourcing 행 합, 분모는 직접비 합계. finding은 approximate', () => {
    const t = totals({ personnel: [50_000_000, 0], activity: [50_000_000, 0] });
    const rows = [
      quantityRow('activity', 'activity_expert', '자문', 30_000_000),
      quantityRow('activity', 'activity_outsourcing', '용역', 15_000_000),
      quantityRow('activity', 'activity_meeting', '회의비', 5_000_000), // 대상 아님
    ];
    const evaluation = evaluateRules(preset('msit_profit'), { years: [year('y1', t, rows)], project });
    expect(evaluation.ratios.external_tech_max[0]).toMatchObject({ numerator: 45_000_000, denominator: 100_000_000, actual: 45 });
    const findings = findingsOf(evaluation, 'external_tech_max');
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ severity: 'warn', approximate: true, actual: 45, limit: 40 });
    expect(findings[0]!.message).toContain('근사');
  });
});

// ─── RL-9 현물 > 기관부담 ────────────────────────────────────

describe('RL-9 현물 합이 ownBudget을 넘으면 별도 경고', () => {
  it('"현물이 기관부담연구개발비를 초과" finding + 비율 finding', () => {
    const evaluation = evaluateRules(preset('moe_energy_sme'), {
      years: [year('y1', totals({ personnel: [50_000_000, 120_000_000] }))],
      project: { govBudget: 200_000_000, ownBudget: 100_000_000, totalBudget: 300_000_000 },
    });
    const findings = findingsOf(evaluation, 'own_cash_min');
    expect(findings).toHaveLength(2);
    expect(findings.some((f) => f.message.includes('현물') && f.message.includes('초과'))).toBe(true);
    expect(findings.map((f) => f.actual).sort((a, b) => a! - b!)).toEqual([-20, 120_000_000]);
    expect(evaluation.ratios.own_cash_min[0]).toMatchObject({ numerator: -20_000_000, denominator: 100_000_000, actual: -20 });
  });
});

// ─── RL-10~RL-13 계상 금지 ───────────────────────────────────

describe('RL-10~RL-13 계상 금지 · 현금/현물', () => {
  const project = { govBudget: null, ownBudget: null, totalBudget: null };

  it('간접비 현물 · 연구지원인력인건비 · 학생인건비 · 부담비가 있으면 각 1건', () => {
    const t = totals(
      {
        personnel: [100_000_000, 0],
        student_personnel: [5_000_000, 0],
        burden: [3_000_000, 0],
        indirect: [10_000_000, 1_000_000],
      },
      7_000_000
    );
    const evaluation = evaluateRules(preset('msit_profit'), { years: [year('y1', t)], project });
    expect(findingsOf(evaluation, 'indirect_cash_only')[0]).toMatchObject({ severity: 'error', scope: { kind: 'year', yearId: 'y1' }, actual: 1_000_000, limit: null });
    expect(findingsOf(evaluation, 'no_personnel_support')[0]).toMatchObject({ severity: 'warn', actual: 7_000_000 });
    expect(findingsOf(evaluation, 'no_student_personnel')[0]).toMatchObject({ severity: 'warn', actual: 5_000_000 });
    expect(findingsOf(evaluation, 'no_burden')[0]).toMatchObject({ severity: 'warn', actual: 3_000_000 });
  });

  it('전부 0이면 finding이 없다', () => {
    const evaluation = evaluateRules(preset('msit_profit'), {
      years: [year('y1', totals({ personnel: [100_000_000, 0], indirect: [10_000_000, 0] }))],
      project,
    });
    for (const code of ['indirect_cash_only', 'no_personnel_support', 'no_student_personnel', 'no_burden'] as RuleCode[]) {
      expect(findingsOf(evaluation, code), code).toEqual([]);
    }
  });
});

// ─── enabled=false · 규칙 없음 ───────────────────────────────

describe('PL-14 — 행이 없거나 꺼진 규칙은 판정하지 않고 비율만 보여 준다', () => {
  const project = { govBudget: null, ownBudget: null, totalBudget: null };
  const t = totals({ personnel: [100_000_000, 0], allowance: [50_000_000, 0], indirect: [90_000_000, 0] });

  it('enabled=false: findings 없음, ratios에는 enabled:false로 남는다', () => {
    const rules = withRule(preset('msit_profit'), 'allowance_max', { enabled: false });
    const evaluation = evaluateRules(rules, { years: [year('y1', t)], project });
    expect(findingsOf(evaluation, 'allowance_max')).toEqual([]);
    expect(evaluation.ratios.allowance_max[0]).toMatchObject({ yearId: 'y1', actual: 50, limit: 20, enabled: false });
    // 켜져 있는 indirect_max는 여전히 판정한다 (90,000,000 / 150,000,000 = 60%)
    expect(findingsOf(evaluation, 'indirect_max')[0]).toMatchObject({ actual: 60, limit: 10 });
  });

  it('규칙 배열이 비어도 비율 7종은 ratios에 있고 findings·skipped는 비어 있다', () => {
    const evaluation = evaluateRules([], { years: [year('y1', t)], project });
    expect(Object.keys(evaluation.ratios).sort()).toEqual([...RATIO_CODES].sort());
    for (const code of RATIO_CODES) {
      for (const entry of evaluation.ratios[code]) {
        expect(entry.enabled, code).toBe(false);
        expect(entry.limit, code).toBeNull();
      }
    }
    expect(evaluation.ratios.allowance_max[0]!.actual).toBe(50);
    expect(evaluation.ratios.indirect_max[0]!.actual).toBe(60);
    expect(evaluation.findings).toEqual([]);
    expect(evaluation.skipped).toEqual([]);
  });

  it('켜져 있는데 값이 없는 행(RL-D2 위반)은 판정하지 않고 skipped에 남긴다', () => {
    const rules = withRule(preset('msit_profit'), 'allowance_max', { value: null });
    const evaluation = evaluateRules(rules, { years: [year('y1', t)], project });
    expect(findingsOf(evaluation, 'allowance_max')).toEqual([]);
    expect(evaluation.ratios.allowance_max[0]).toMatchObject({ actual: 50, limit: null, enabled: true });
  });
});

// ─── Phase 9에서 옮겨 온 한도 경계 (PL-12·PL-15) ──────────────

describe('allowance_max 경계 — 정확히 20%는 초과가 아니다', () => {
  const project = { govBudget: null, ownBudget: null, totalBudget: null };

  it('20,000,000 / 100,000,000 = 20% → 통과 · 20,000,001 → error', () => {
    const exact = evaluateRules(preset('msit_profit'), {
      years: [year('y1', totals({ personnel: [100_000_000, 0], allowance: [20_000_000, 0] }))],
      project,
    });
    expect(exact.ratios.allowance_max[0]!.actual).toBe(20);
    expect(findingsOf(exact, 'allowance_max')).toEqual([]);

    const over = evaluateRules(preset('msit_profit'), {
      years: [year('y1', totals({ personnel: [100_000_000, 0], allowance: [20_000_001, 0] }))],
      project,
    });
    expect(findingsOf(over, 'allowance_max')).toHaveLength(1);
    expect(findingsOf(over, 'allowance_max')[0]).toMatchObject({ severity: 'error', limit: 20 });
  });

  it('C > 0 회귀: E1이 세목 단위로 C를 빼므로 25%가 나와 한도 초과가 잡힌다', () => {
    // budget-plan.test.ts의 같은 케이스 — 비목 단위 E1(180,000,000)이면 16.67%로 통과해 버린다
    const t = totals({ personnel: [150_000_000, 10_000_000], student_personnel: [20_000_000, 0], allowance: [30_000_000, 0] }, 60_000_000);
    const evaluation = evaluateRules(preset('msit_profit'), { years: [year('y1', t)], project });
    expect(evaluation.ratios.allowance_max[0]).toMatchObject({ denominator: 120_000_000, actual: 25 });
    expect(findingsOf(evaluation, 'allowance_max')).toHaveLength(1);
  });
});

// ─── 중간 반올림 금지 ────────────────────────────────────────

describe('비율 비교에 중간 반올림이 없다 (부록 B.9.1 주석)', () => {
  it('한도 69.23에 actual 69.2308… → error. 69.23으로 잘라 비교하면 통과로 뒤집힌다', () => {
    const evaluation = evaluateRules(withRule(preset('moe_energy_sme'), 'gov_share_max', { value: 69.23 }), {
      years: [year('y1', totals({ personnel: [100_000_000, 0] }))],
      project: B91_PROJECT,
    });
    const findings = findingsOf(evaluation, 'gov_share_max');
    expect(findings).toHaveLength(1);
    expect(findings[0]!.actual).toBeCloseTo(69.230769, 6);
    expect(findings[0]!.actual).not.toBe(69.23);
    expect(findings[0]!.actual).not.toBe(69.2308);
    // 2자리로 자른 값으로 비교했다면 위반이 아니었을 것이다
    expect(Math.round(findings[0]!.actual! * 100) / 100 > 69.23).toBe(false);
  });

  it('한도 69.2308(표시값 그대로)이면 원값 69.230769…는 그보다 작아 통과다', () => {
    const evaluation = evaluateRules(withRule(preset('moe_energy_sme'), 'gov_share_max', { value: 69.2308 }), {
      years: [year('y1', totals({ personnel: [100_000_000, 0] }))],
      project: B91_PROJECT,
    });
    expect(findingsOf(evaluation, 'gov_share_max')).toEqual([]);
  });
});

// ─── 다연차 · 정렬 · 메시지 ──────────────────────────────────

describe('RL-2 다연차 — 판정은 연차마다, 과제 단위 합계는 참고값', () => {
  const project = { govBudget: null, ownBudget: null, totalBudget: null };

  it('한 연차만 넘고 총합은 안 넘는 경우: finding은 그 연차 1건, 합계 행은 한도 이내', () => {
    const y1 = totals({ personnel: [100_000_000, 0], allowance: [30_000_000, 0] }); // 30%
    const y2 = totals({ personnel: [300_000_000, 0], allowance: [30_000_000, 0] }); // 10%
    const evaluation = evaluateRules(preset('msit_profit'), { years: [year('y1', y1), year('y2', y2)], project });
    const findings = findingsOf(evaluation, 'allowance_max');
    expect(findings).toHaveLength(1);
    expect(findings[0]!.scope).toEqual({ kind: 'year', yearId: 'y1' });
    expect(evaluation.ratios.allowance_max.map((e) => e.yearId)).toEqual(['y1', 'y2', null]);
    expect(evaluation.ratios.allowance_max[2]).toMatchObject({ numerator: 60_000_000, denominator: 400_000_000, actual: 15 });
  });

  it('gov_share_max 분모의 국제공동은 전 연차 합, own_cash_min의 현물도 전 연차 합', () => {
    const y1 = totals({ personnel: [50_000_000, 10_000_000], international: [20_000_000, 0] });
    const y2 = totals({ personnel: [50_000_000, 15_000_000], international: [30_000_000, 0] });
    const evaluation = evaluateRules(preset('moe_energy_sme'), {
      years: [year('y1', y1), year('y2', y2)],
      project: { govBudget: 150_000_000, ownBudget: 50_000_000, totalBudget: 250_000_000 },
    });
    expect(evaluation.ratios.gov_share_max[0]).toMatchObject({ numerator: 150_000_000, denominator: 200_000_000, actual: 75 });
    expect(evaluation.ratios.own_cash_min[0]).toMatchObject({ numerator: 25_000_000, denominator: 50_000_000, actual: 50 });
  });
});

describe('findings 정렬 · 메시지', () => {
  it('severity 순 error > warn > info, 같은 등급은 입력 순', () => {
    const rows = [quantityRow('facility_equipment', 'facility_purchase', '장비', 40_000_000)];
    const t = totals({ personnel: [100_000_000, 0], facility_equipment: [40_000_000, 0], indirect: [30_000_000, 0] });
    const evaluation = evaluateRules(preset('moe_energy_sme'), { years: [year('y1', t, rows)], project: B91_PROJECT });
    const severities = evaluation.findings.map((f) => f.severity);
    const rank = { error: 0, warn: 1, info: 2 };
    for (let i = 1; i < severities.length; i++) {
      expect(rank[severities[i]!]).toBeGreaterThanOrEqual(rank[severities[i - 1]!]);
    }
    expect(severities).toContain('error'); // indirect_max
    expect(severities).toContain('warn'); // equipment
    expect(severities).toContain('info'); // allowance_min
  });

  it('모든 finding의 message가 규칙 source로 끝난다', () => {
    const rules = preset('moe_energy_sme');
    const t = totals({ personnel: [100_000_000, 0], indirect: [30_000_000, 0], burden: [1_000_000, 0] }, 1_000_000);
    const evaluation = evaluateRules(rules, { years: [year('y1', t)], project: { ...B91_PROJECT, ownBudget: 90_000_000, govBudget: 300_000_000 } });
    expect(evaluation.findings.length).toBeGreaterThanOrEqual(4);
    for (const finding of evaluation.findings) {
      const source = rules.find((r) => r.code === finding.code)!.source;
      expect(finding.message.endsWith(`(${source})`), finding.code).toBe(true);
    }
  });
});

// ─── 프리셋 ↔ RULE_SPECS 정합 ────────────────────────────────

describe('RULE_SPECS ↔ RULE_PRESETS 정합 (RL-D2·RL-D3)', () => {
  it('RULE_SPECS는 RuleCode 17종 전부를 갖는다', () => {
    expect(Object.keys(RULE_SPECS)).toHaveLength(17);
    expect(RATIO_CODES).toHaveLength(7);
    for (const code of RATIO_CODES) expect(['ratio_max', 'ratio_min']).toContain(RULE_SPECS[code].kind);
  });

  it('프리셋 모든 행: needsValue면 value 있음, 아니면 null. base는 indirect_max에만', () => {
    for (const id of PRESET_IDS) {
      for (const rule of RULE_PRESETS[id].rules) {
        const spec = RULE_SPECS[rule.code];
        if (spec.needsValue) expect(rule.value, `${id}/${rule.code}`).not.toBeNull();
        else expect(rule.value, `${id}/${rule.code}`).toBeNull();
        if (rule.code === 'indirect_max') expect(rule.base, `${id}/${rule.code}`).not.toBeNull();
        else expect(rule.base, `${id}/${rule.code}`).toBeNull();
        // 단위: percent 코드는 0~100, won 코드는 정수
        if (spec.valueUnit === 'percent') {
          expect(rule.value!).toBeGreaterThanOrEqual(0);
          expect(rule.value!).toBeLessThanOrEqual(100);
        }
        if (spec.valueUnit === 'won') expect(Number.isInteger(rule.value)).toBe(true);
      }
    }
  });

  it('approximate는 RL-7·RL-9만 true', () => {
    const approximate = (Object.keys(RULE_SPECS) as RuleCode[]).filter((c) => RULE_SPECS[c].approximate).sort();
    expect(approximate).toEqual(['external_tech_max', 'own_cash_min']);
  });

  it('scope: 과제 단위는 gov_share_max·own_cash_min, 행 단위는 RL-14·16·17~19', () => {
    const byScope = (scope: 'project' | 'detail') =>
      (Object.keys(RULE_SPECS) as RuleCode[]).filter((c) => RULE_SPECS[c].scope === scope).sort();
    expect(byScope('project')).toEqual(['gov_share_max', 'own_cash_min']);
    expect(byScope('detail')).toEqual([
      'equipment_review_threshold',
      'existing_personnel_cash',
      'material_notice_threshold',
      'min_participation',
      'outsourcing_notice_threshold',
    ]);
  });

  it('PresetRow는 그대로 evaluateRules의 규칙 입력이 된다 (타입 호환)', () => {
    const rows: RuleInput[] = presetToRows('msit_profit');
    const rowDetail: RuleDetailInput = detail({ category: 'activity' });
    expect(rows).toHaveLength(10);
    expect(rowDetail.id).toBeTruthy();
  });
});
