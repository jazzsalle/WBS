// 규칙 판정 — 제안·수행 공통 확장 (SOT §6.14.5~§6.14.8, 부록 B.9.5·B.9.6, Phase 26 T3)
//
// 판정기는 하나다. 수행 모드 어댑터가 붙이는 선택 필드(subcategoryTotals·origin·unavailableReason)는
// 분자 출처·scope 종류·skipped 사유만 바꾼다. 선택 필드가 없는 제안 경로는 Phase 25와 같은 결과여야 한다.
// 부록 B.9.5(RL-22)·B.9.6(RL-17)의 숫자를 그대로 옮긴다 — 다른 값이 나오면 구현이 틀린 것이다.

import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { buildYearTotals, modifiedPersonnel, totalPersonnelCost, type YearCategoryTotals } from '@/lib/budget-plan';
import { RULE_PRESETS, presetToRows, type PresetId } from '@/lib/rules-presets';
import {
  RATIO_CODES,
  RULE_SPECS,
  evaluateRules,
  meetsEquipmentThreshold,
  type RuleEvaluationInput,
  type RuleInput,
  type RuleRowInput,
  type RuleSubcategoryTotal,
  type RuleYearInput,
} from '@/lib/rules';
import type { BudgetCategory, BudgetDetail, DetailAxis, DetailFactor, HireType, RuleCode } from '@/types';

// ─── 픽스처 헬퍼 ─────────────────────────────────────────────

const NEW_CODES: readonly RuleCode[] = ['lab_safety_min', 'lab_safety_max', 'preserve_subcategory_totals'];
const LAB_CODES: readonly RuleCode[] = ['lab_safety_min', 'lab_safety_max'];
const NO_PROJECT = { govBudget: null, ownBudget: null, totalBudget: null };

function totals(spec: Partial<Record<BudgetCategory, [number, number]>>, personnelSupportTotal = 0): YearCategoryTotals {
  const sources = Object.entries(spec).map(([key, [cash, inKind]]) => {
    const amounts = { cashAmount: cash, inKindAmount: inKind, plannedAmount: cash + inKind };
    return key === 'personnel'
      ? { category: 'personnel' as const, ...amounts, personnelSupportTotal }
      : { category: key as Exclude<BudgetCategory, 'personnel'>, ...amounts };
  });
  return buildYearTotals(sources);
}

let seq = 0;

function detail(spec: {
  id?: string;
  category: BudgetCategory;
  subcategory?: string;
  axis?: DetailAxis;
  formula?: BudgetDetail['formula'];
  memberId?: string | null;
  name?: string;
  factors?: DetailFactor[];
}): BudgetDetail {
  seq += 1;
  return {
    id: spec.id ?? `d${seq}`,
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    version: 1,
    createdBy: null,
    updatedBy: null,
    projectId: 'p1',
    yearId: 'y1',
    category: spec.category,
    subcategory: spec.subcategory ?? 'default',
    axis: spec.axis ?? 'cash',
    formula: spec.formula ?? (spec.memberId ? 'personnel' : 'quantity'),
    memberId: spec.memberId ?? null,
    name: spec.name ?? '',
    unitPrice: 0,
    spec: '',
    factors: spec.factors ?? [],
    adjustment: 0,
    note: '',
    order: seq,
    amount: -1,
  };
}

function quantityRow(category: BudgetCategory, subcategory: string, name: string, amount: number, id?: string): RuleRowInput {
  return { detail: detail({ id, category, subcategory, name }), amount };
}

function itemRow(category: BudgetCategory, subcategory: string, name: string, amount: number, itemId: string): RuleRowInput {
  return { ...quantityRow(category, subcategory, name, amount, `row-${itemId}`), origin: { kind: 'item', id: itemId } };
}

function personnelRow(spec: {
  id?: string;
  memberId: string;
  hireType: HireType;
  axis: DetailAxis;
  amount: number;
  rate: number;
  participantId?: string;
}): RuleRowInput {
  const row: RuleRowInput = {
    detail: detail({
      id: spec.id,
      category: 'personnel',
      subcategory: 'personnel_internal',
      axis: spec.axis,
      formula: 'personnel',
      memberId: spec.memberId,
      factors: [
        { label: '참여율(%)', value: spec.rate, isPercent: true },
        { label: '참여기간(월)', value: 12, isPercent: false },
      ],
    }),
    amount: spec.amount,
    member: { id: spec.memberId, hireType: spec.hireType },
  };
  return spec.participantId ? { ...row, origin: { kind: 'participant', id: spec.participantId } } : row;
}

function year(yearId: string, t: YearCategoryTotals, rows: readonly RuleRowInput[] = [], subcategoryTotals?: readonly RuleSubcategoryTotal[]): RuleYearInput {
  return subcategoryTotals ? { yearId, totals: t, rows, subcategoryTotals } : { yearId, totals: t, rows };
}

function preset(id: PresetId): RuleInput[] {
  return presetToRows(id);
}

/** Phase 25 규칙 집합 — 새 코드 3행을 뺀 프리셋 */
function phase25Preset(id: PresetId): RuleInput[] {
  return presetToRows(id).filter((r) => !NEW_CODES.includes(r.code));
}

function only(codes: readonly RuleCode[]): RuleInput[] {
  return preset('moe_energy_sme').filter((r) => codes.includes(r.code));
}

function findingsOf(evaluation: ReturnType<typeof evaluateRules>, code: RuleCode) {
  return evaluation.findings.filter((f) => f.code === code);
}

function labOnly(evaluation: ReturnType<typeof evaluateRules>) {
  return {
    findings: evaluation.findings.filter((f) => LAB_CODES.includes(f.code)),
    skipped: evaluation.skipped.filter((s) => LAB_CODES.includes(s.code)),
  };
}

// ─── totalPersonnelCost (RL-22 분모) ─────────────────────────

describe('totalPersonnelCost — 인건비 + 학생인건비, 현금+현물, personnel_support 포함', () => {
  it('부록 B.9.5 기본: 현금 84,000,000(지원인력 4,000,000 포함) + 현물 16,000,000 = 100,000,000 — E1(96,000,000)과 다르다', () => {
    const t = totals({ personnel: [84_000_000, 16_000_000] }, 4_000_000);
    expect(totalPersonnelCost(t)).toBe(100_000_000);
    expect(modifiedPersonnel(t)).toBe(96_000_000);
  });

  it('학생인건비를 더하고 다른 비목은 더하지 않는다', () => {
    const t = totals({ personnel: [84_000_000, 16_000_000], student_personnel: [10_000_000, 0], allowance: [5_000_000, 0] }, 4_000_000);
    expect(totalPersonnelCost(t)).toBe(110_000_000);
    expect(totalPersonnelCost(totals({}))).toBe(0);
  });
});

// ─── 부록 B.9.5 — RL-22 연구실 안전관리비 ────────────────────

describe('부록 B.9.5 — RL-22 연구실 안전관리비 (제안: 산출 행 합)', () => {
  const base = totals({ personnel: [84_000_000, 16_000_000] }, 4_000_000);
  const rules = only(LAB_CODES);

  function run(labSafety: number | null, t: YearCategoryTotals = base) {
    const rows = labSafety === null ? [] : [quantityRow('indirect', 'indirect_lab_safety', '연구실 안전관리비', labSafety, 'lab')];
    return evaluateRules(rules, { years: [year('y1', t, rows)], project: NO_PROJECT });
  }

  it('1,000,000 = 정확히 1% → 통과 ("미만"이 아니다)', () => {
    expect(labOnly(run(1_000_000))).toEqual({ findings: [], skipped: [] });
  });

  it('999,999 → lab_safety_min warn 1건 (actual 0.999999, limit 1)', () => {
    const { findings, skipped } = labOnly(run(999_999));
    expect(skipped).toEqual([]);
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ code: 'lab_safety_min', severity: 'warn', scope: { kind: 'year', yearId: 'y1' }, limit: 1, approximate: false });
    expect(findings[0]!.actual).toBeCloseTo(0.999999, 10);
    expect(findings[0]!.message).toContain('하한 1% 미만');
    expect(findings[0]!.message.endsWith('(간사 지침 연구실 안전관리비 (인건비 + 학생인건비의 1% 이상))')).toBe(true);
  });

  it('2,000,000 = 정확히 2% → 통과 ("초과"가 아니다)', () => {
    expect(labOnly(run(2_000_000))).toEqual({ findings: [], skipped: [] });
  });

  it('2,000,001 → lab_safety_max warn 1건 (actual 2.000001, limit 2)', () => {
    const { findings } = labOnly(run(2_000_001));
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ code: 'lab_safety_max', severity: 'warn', scope: { kind: 'year', yearId: 'y1' }, limit: 2 });
    expect(findings[0]!.actual).toBeCloseTo(2.000001, 10);
    expect(findings[0]!.message).toContain('상한 2%');
    expect(findings[0]!.message.endsWith('(간사 지침 연구실 안전관리비 (인건비 + 학생인건비의 2% 이하))')).toBe(true);
  });

  it('세목 없음 · 0 → findings 0건 · skipped 0건 (세목이 있을 때만 판정)', () => {
    expect(labOnly(run(null))).toEqual({ findings: [], skipped: [] });
    expect(labOnly(run(0))).toEqual({ findings: [], skipped: [] });
  });

  it('인건비·학생인건비 0 + 안전관리비 500,000 → skipped 2건 "인건비 + 학생인건비가 0", findings 0건', () => {
    const evaluation = run(500_000, totals({ indirect: [500_000, 0] }));
    expect(labOnly(evaluation)).toEqual({
      findings: [],
      skipped: [
        { code: 'lab_safety_min', reason: '인건비 + 학생인건비가 0', yearId: 'y1' },
        { code: 'lab_safety_max', reason: '인건비 + 학생인건비가 0', yearId: 'y1' },
      ],
    });
  });

  it('분모 0이어도 꺼진 코드는 skipped에 없다 — 켜진 코드마다', () => {
    const evaluation = evaluateRules(only(['lab_safety_min']), {
      years: [year('y1', totals({ indirect: [500_000, 0] }), [quantityRow('indirect', 'indirect_lab_safety', '안전', 500_000)])],
      project: NO_PROJECT,
    });
    expect(evaluation.skipped).toEqual([{ code: 'lab_safety_min', reason: '인건비 + 학생인건비가 0', yearId: 'y1' }]);
  });

  it('student_general 현금 10,000,000 추가 → 분모 110,000,000, 1,000,000 = 0.9091% → lab_safety_min warn', () => {
    const t = totals({ personnel: [84_000_000, 16_000_000], student_personnel: [10_000_000, 0] }, 4_000_000);
    const { findings } = labOnly(run(1_000_000, t));
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ code: 'lab_safety_min', limit: 1 });
    expect(findings[0]!.actual).toBeCloseTo(100 / 110, 12);
    expect(Math.round(findings[0]!.actual! * 10_000) / 10_000).toBe(0.9091);
  });

  it('B.7 실측 indirect_support 품명 "연구실 안전관리비" 2,000,000 → 판정 안 함 (자동 이관 없음), B.9.1 결과 불변', () => {
    const b7 = totals({ personnel: [180_840_000, 88_650_000], activity: [27_020_000, 0], indirect: [2_000_000, 0] });
    const rows = [quantityRow('indirect', 'indirect_support', '연구실 안전관리비', 2_000_000)];
    const input: RuleEvaluationInput = {
      years: [year('y1', b7, rows)],
      project: { govBudget: 225_000_000, ownBudget: 100_000_000, totalBudget: 325_000_000 },
    };
    const now = evaluateRules(preset('moe_energy_sme'), input);
    expect(labOnly(now)).toEqual({ findings: [], skipped: [] });
    expect(now).toEqual(evaluateRules(phase25Preset('moe_energy_sme'), input));
    expect(now.findings.map((f) => f.code)).toEqual(['allowance_min']);
  });

  it('ratios에는 RL-22가 없다 (RatioCode 7종 그대로)', () => {
    const evaluation = run(999_999);
    expect(Object.keys(evaluation.ratios).sort()).toEqual([...RATIO_CODES].sort());
    expect(RATIO_CODES).toHaveLength(7);
    expect(RATIO_CODES as readonly string[]).not.toContain('lab_safety_min');
  });

  it('연차마다 따로 판정한다 — 세목이 없는 연차는 대상이 아니다', () => {
    const evaluation = evaluateRules(rules, {
      years: [
        year('y1', base, [quantityRow('indirect', 'indirect_lab_safety', '안전', 999_999)]),
        year('y2', base),
      ],
      project: NO_PROJECT,
    });
    expect(evaluation.findings.map((f) => [f.code, f.scope])).toEqual([['lab_safety_min', { kind: 'year', yearId: 'y1' }]]);
    expect(evaluation.skipped).toEqual([]);
  });
});

describe('RL-22 수행 — 분자는 subcategoryTotals(금액 줄)에서 읽는다', () => {
  const base = totals({ personnel: [84_000_000, 16_000_000] }, 4_000_000);
  const rules = only(LAB_CODES);

  it('subcategoryTotals indirect_lab_safety 999,999 → lab_safety_min warn (산출 행 없이)', () => {
    const evaluation = evaluateRules(rules, {
      years: [year('y1', base, [], [{ category: 'indirect', subcategory: 'indirect_lab_safety', amount: 999_999 }])],
      project: NO_PROJECT,
    });
    expect(evaluation.findings).toHaveLength(1);
    expect(evaluation.findings[0]).toMatchObject({ code: 'lab_safety_min', scope: { kind: 'year', yearId: 'y1' } });
  });

  it('같은 (비목, 세목)이 여러 번 오면 더한다 — 600,000 + 500,000 = 1.1% 통과', () => {
    const evaluation = evaluateRules(rules, {
      years: [
        year('y1', base, [], [
          { category: 'indirect', subcategory: 'indirect_lab_safety', amount: 600_000 },
          { category: 'indirect', subcategory: 'indirect_lab_safety', amount: 500_000 },
        ]),
      ],
      project: NO_PROJECT,
    });
    expect(labOnly(evaluation)).toEqual({ findings: [], skipped: [] });
  });

  it('indirect/default 300,000만 있고 indirect_lab_safety 줄 없음 → 판정기 findings·skipped 0건 (세목 미지정 skipped는 어댑터 몫)', () => {
    const evaluation = evaluateRules(rules, {
      years: [year('y1', base, [], [{ category: 'indirect', subcategory: 'default', amount: 300_000 }])],
      project: NO_PROJECT,
    });
    expect(evaluation.findings).toEqual([]);
    expect(evaluation.skipped).toEqual([]);
  });

  it('subcategoryTotals가 있으면 행은 분자에 쓰지 않는다 — 두 출처를 섞지 않는다', () => {
    const evaluation = evaluateRules(rules, {
      years: [year('y1', base, [quantityRow('indirect', 'indirect_lab_safety', '안전', 999_999)], [])],
      project: NO_PROJECT,
    });
    expect(labOnly(evaluation)).toEqual({ findings: [], skipped: [] });
  });
});

// ─── 부록 B.9.6 — RL-17 부가세 별도 금액 × 1.1 ───────────────

describe('meetsEquipmentThreshold — amount × 11 ≥ value × 10 (정수)', () => {
  it('부록 B.9.6 경계', () => {
    expect(meetsEquipmentThreshold(27_272_727, 30_000_000)).toBe(false);
    expect(meetsEquipmentThreshold(27_272_728, 30_000_000)).toBe(true);
    expect(meetsEquipmentThreshold(29_999_999, 30_000_000)).toBe(true);
    expect(meetsEquipmentThreshold(30_000_000, 30_000_000)).toBe(true);
    expect(meetsEquipmentThreshold(35_000_000, 30_000_000)).toBe(true);
  });

  it('×1.1이 정확히 기준인 금액은 대상이다 (10 × 11 = 110 ≥ 11 × 10)', () => {
    expect(meetsEquipmentThreshold(10, 11)).toBe(true);
    expect(meetsEquipmentThreshold(9, 11)).toBe(false);
    expect(meetsEquipmentThreshold(0, 0)).toBe(true);
  });
});

describe('부록 B.9.6 — RL-17 판정 (value 30,000,000, 부가세 포함 기준)', () => {
  const t = totals({ personnel: [50_000_000, 0], facility_equipment: [35_000_000, 0] });
  const rules = only(['equipment_review_threshold']);
  const source = RULE_PRESETS.moe_energy_sme.rules.find((r) => r.code === 'equipment_review_threshold')!.source;

  function run(subcategory: string, amount: number) {
    return evaluateRules(rules, { years: [year('y1', t, [quantityRow('facility_equipment', subcategory, '분광기', amount, 'eq1')])], project: NO_PROJECT });
  }

  it('27,272,727 → 없음', () => {
    expect(run('facility_purchase', 27_272_727).findings).toEqual([]);
  });

  it('27,272,728 → warn, actual 27,272,728 · limit 30,000,000, 메시지 "부가세 포함 30,000,000원"(표시 버림)', () => {
    const { findings } = run('facility_purchase', 27_272_728);
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({
      code: 'equipment_review_threshold',
      severity: 'warn',
      scope: { kind: 'detail', yearId: 'y1', detailId: 'eq1', category: 'facility_equipment' },
      actual: 27_272_728,
      limit: 30_000_000,
      approximate: false,
    });
    expect(findings[0]!.message).toBe(
      '장비 27,272,728원(부가세 별도, 부가세 포함 30,000,000원) — 부가세 포함 30,000,000원 이상 연구시설·장비: ' +
        `「연구시설·장비 구입 및 활용계획서」 작성 및 전담기관 사전 승인 대상, IRIS/ZEUS 등록 (${source})`
    );
  });

  it('29,999,999 → warn (Phase 13 경계 개정), 30,000,000 → warn, 35,000,000 → warn (B.9.3)', () => {
    for (const amount of [29_999_999, 30_000_000, 35_000_000]) {
      const { findings } = run('facility_purchase', amount);
      expect(findings, String(amount)).toHaveLength(1);
      expect(findings[0]).toMatchObject({ actual: amount, limit: 30_000_000 });
    }
    expect(run('facility_purchase', 35_000_000).findings[0]!.message).toContain('장비 35,000,000원(부가세 별도, 부가세 포함 38,500,000원)');
  });

  it('facility_lease 35,000,000 → 없음 (구입 세목만)', () => {
    expect(run('facility_lease', 35_000_000).findings).toEqual([]);
  });

  it('value는 규칙 행의 값이다 — 메시지의 기준 금액도 행 값', () => {
    const custom = rules.map((r) => ({ ...r, value: 11_000_000 }));
    const evaluation = evaluateRules(custom, { years: [year('y1', t, [quantityRow('facility_equipment', 'facility_purchase', 'x', 10_000_000)])], project: NO_PROJECT });
    expect(evaluation.findings).toHaveLength(1);
    expect(evaluation.findings[0]!.message).toContain('부가세 포함 11,000,000원 이상');
  });

  it('RULE_SPECS 라벨 "장비 사전 승인 대상 금액 (부가세 포함 기준)"', () => {
    expect(RULE_SPECS.equipment_review_threshold.label).toBe('장비 사전 승인 대상 금액 (부가세 포함 기준)');
  });

  it('RL-18·RL-19는 ×1.1 없이 그대로 — 18,181,819(×1.1 ≥ 2천만)는 RL-18 대상이 아니다', () => {
    const evaluation = evaluateRules(only(['material_notice_threshold', 'outsourcing_notice_threshold']), {
      years: [
        year('y1', t, [
          quantityRow('material', 'material_purchase', '시약', 18_181_819),
          quantityRow('activity', 'activity_outsourcing', '용역', 27_272_728),
        ]),
      ],
      project: NO_PROJECT,
    });
    expect(evaluation.findings).toEqual([]);
  });
});

// ─── origin → scope 종류 (§6.14.6) ───────────────────────────

describe('origin — 수행 모드 행의 scope', () => {
  const t = totals({ personnel: [60_000_000, 0], facility_equipment: [40_000_000, 0], material: [21_000_000, 0], activity: [30_000_000, 0] });

  it('편성 항목(origin item) → RL-17·RL-18·RL-19 scope가 item', () => {
    const evaluation = evaluateRules(only(['equipment_review_threshold', 'material_notice_threshold', 'outsourcing_notice_threshold']), {
      years: [
        year('y1', t, [
          itemRow('facility_equipment', 'facility_purchase', '분광기', 35_000_000, 'it-eq'),
          itemRow('material', 'material_purchase', '시약 A', 12_000_000, 'it-m1'),
          itemRow('material', 'material_purchase', ' 시약 A ', 9_000_000, 'it-m2'),
          itemRow('activity', 'activity_outsourcing', '해석 용역', 30_000_000, 'it-o'),
        ]),
      ],
      project: NO_PROJECT,
    });
    expect(evaluation.findings.map((f) => [f.code, f.scope, f.actual])).toEqual([
      ['equipment_review_threshold', { kind: 'item', yearId: 'y1', itemId: 'it-eq', category: 'facility_equipment' }, 35_000_000],
      ['material_notice_threshold', { kind: 'item', yearId: 'y1', itemId: 'it-m1', category: 'material' }, 21_000_000],
      ['outsourcing_notice_threshold', { kind: 'item', yearId: 'y1', itemId: 'it-o', category: 'activity' }, 30_000_000],
    ]);
  });

  it('참여인원(origin participant) → RL-14 scope가 participant', () => {
    const evaluation = evaluateRules(only(['existing_personnel_cash']), {
      years: [year('y1', t, [personnelRow({ memberId: 'A', hireType: 'existing', axis: 'cash', amount: 30_000_000, rate: 50, participantId: 'pa-A' })])],
      project: NO_PROJECT,
    });
    expect(evaluation.findings).toHaveLength(1);
    expect(evaluation.findings[0]!.scope).toEqual({ kind: 'participant', yearId: 'y1', participantId: 'pa-A', category: 'personnel' });
  });

  it('RL-16: 참여인원 1행이 현금·현물 두 행으로 나뉘어도 참여율은 한 번만 센다 (8% → warn, 16%로 부풀지 않음)', () => {
    const rows = [
      personnelRow({ memberId: 'A', hireType: 'new', axis: 'cash', amount: 4_000_000, rate: 8, participantId: 'pa-A' }),
      personnelRow({ memberId: 'A', hireType: 'new', axis: 'in_kind', amount: 1_000_000, rate: 8, participantId: 'pa-A' }),
    ];
    const evaluation = evaluateRules(only(['min_participation']), { years: [year('y1', t, rows)], project: NO_PROJECT });
    expect(evaluation.findings).toHaveLength(1);
    expect(evaluation.findings[0]).toMatchObject({
      code: 'min_participation',
      actual: 8,
      limit: 10,
      scope: { kind: 'participant', yearId: 'y1', participantId: 'pa-A', category: 'personnel' },
    });
  });

  it('RL-16: 같은 Member의 다른 참여인원 행은 합산한다 (6% + 6% = 12% → 통과)', () => {
    const rows = [
      personnelRow({ memberId: 'A', hireType: 'new', axis: 'cash', amount: 3_000_000, rate: 6, participantId: 'pa-1' }),
      personnelRow({ memberId: 'A', hireType: 'new', axis: 'in_kind', amount: 3_000_000, rate: 6, participantId: 'pa-1' }),
      personnelRow({ memberId: 'A', hireType: 'new', axis: 'cash', amount: 3_000_000, rate: 6, participantId: 'pa-2' }),
    ];
    const evaluation = evaluateRules(only(['min_participation']), { years: [year('y1', t, rows)], project: NO_PROJECT });
    expect(evaluation.findings).toEqual([]);
  });

  it('origin이 없으면 제안 경로 그대로 — 같은 Member 산출 행 두 개는 합산(8% + 8% = 16% 통과), scope는 detail', () => {
    const rows = [
      personnelRow({ id: 'r1', memberId: 'A', hireType: 'new', axis: 'cash', amount: 4_000_000, rate: 8 }),
      personnelRow({ id: 'r2', memberId: 'A', hireType: 'new', axis: 'in_kind', amount: 1_000_000, rate: 8 }),
    ];
    expect(evaluateRules(only(['min_participation']), { years: [year('y1', t, rows)], project: NO_PROJECT }).findings).toEqual([]);

    const single = evaluateRules(only(['min_participation']), { years: [year('y1', t, [rows[0]!])], project: NO_PROJECT });
    expect(single.findings[0]!.scope).toEqual({ kind: 'detail', yearId: 'y1', detailId: 'r1', category: 'personnel' });
  });
});

// ─── subcategoryTotals — RL-7 분자 ───────────────────────────

describe('subcategoryTotals — RL-7 분자 (제안·수행 같은 결과, scope 식별자만 다름)', () => {
  const t = totals({ personnel: [100_000_000, 0], activity: [50_000_000, 0] });
  const rules = only(['external_tech_max', 'outsourcing_notice_threshold']);

  it('제안 산출 행 ↔ 수행 금액 줄 소계 + 편성 항목 건: ratios·skipped 같고 findings는 scope만 다르다', () => {
    const plan = evaluateRules(rules, {
      years: [year('y1', t, [
        quantityRow('activity', 'activity_outsourcing', '해석 용역', 45_000_000, 'det-o'),
        quantityRow('activity', 'activity_expert', '자문', 5_000_000, 'det-e'),
      ])],
      project: NO_PROJECT,
    });
    const agreement = evaluateRules(rules, {
      years: [
        year('y1', t, [itemRow('activity', 'activity_outsourcing', '해석 용역', 45_000_000, 'it-o')], [
          { category: 'activity', subcategory: 'activity_outsourcing', amount: 45_000_000 },
          { category: 'activity', subcategory: 'activity_expert', amount: 5_000_000 },
        ]),
      ],
      project: NO_PROJECT,
    });

    expect(plan.ratios.external_tech_max[0]).toMatchObject({ numerator: 50_000_000, denominator: 150_000_000 });
    expect(agreement.ratios).toEqual(plan.ratios);
    expect(agreement.skipped).toEqual(plan.skipped);
    const withoutRowId = (e: typeof plan) =>
      e.findings.map(({ scope, ...rest }) => ({ ...rest, yearId: 'yearId' in scope ? scope.yearId : null }));
    expect(withoutRowId(agreement)).toEqual(withoutRowId(plan));
    expect(agreement.findings.map((f) => f.scope.kind)).toEqual(['item']);
    expect(plan.findings.map((f) => f.scope.kind)).toEqual(['detail']);
  });
});

// ─── unavailableReason — RL-8·RL-9 ───────────────────────────

describe('unavailableReason — 수행 총액을 정할 수 없으면 RL-8·RL-9 skipped', () => {
  const t = totals({ personnel: [100_000_000, 10_000_000] });
  const reason = '정부지원 현금 미입력 연차: 2차년도';

  it('총액 null + 사유 → 두 코드가 그 사유로 skipped, ratios actual null, findings 0건', () => {
    const evaluation = evaluateRules(preset('moe_energy_sme'), {
      years: [year('y1', t)],
      project: { govBudget: null, ownBudget: null, totalBudget: null, unavailableReason: reason },
    });
    expect(evaluation.skipped.filter((s) => s.code === 'gov_share_max' || s.code === 'own_cash_min')).toEqual([
      { code: 'gov_share_max', reason, yearId: null },
      { code: 'own_cash_min', reason, yearId: null },
    ]);
    expect(evaluation.ratios.gov_share_max[0]!.actual).toBeNull();
    expect(evaluation.ratios.own_cash_min[0]!.actual).toBeNull();
    expect(findingsOf(evaluation, 'gov_share_max')).toEqual([]);
    expect(findingsOf(evaluation, 'own_cash_min')).toEqual([]);
  });

  it('사유가 있으면 값이 있어도 판정하지 않는다 (현물 초과 finding도 없음)', () => {
    const evaluation = evaluateRules(preset('moe_energy_sme'), {
      years: [year('y1', t)],
      project: { govBudget: 100_000_000, ownBudget: 5_000_000, totalBudget: 105_000_000, unavailableReason: reason },
    });
    expect(findingsOf(evaluation, 'gov_share_max')).toEqual([]);
    expect(findingsOf(evaluation, 'own_cash_min')).toEqual([]);
    expect(evaluation.skipped.filter((s) => s.reason === reason).map((s) => s.code)).toEqual(['gov_share_max', 'own_cash_min']);
  });

  it('꺼진 규칙은 사유가 있어도 skipped에 없다', () => {
    const rules = preset('moe_energy_sme').map((r) => (r.code === 'gov_share_max' ? { ...r, enabled: false } : r));
    const evaluation = evaluateRules(rules, {
      years: [year('y1', t)],
      project: { govBudget: null, ownBudget: null, totalBudget: null, unavailableReason: reason },
    });
    expect(evaluation.skipped.map((s) => s.code)).not.toContain('gov_share_max');
    expect(evaluation.skipped.map((s) => s.code)).toContain('own_cash_min');
  });
});

// ─── 새 코드 행이 없으면 결과 불변 · preserve_subcategory_totals ─

describe('새 코드 3행 유무와 무관하게 기존 판정이 같다 (선택 필드 없는 제안 경로)', () => {
  // B.9.1~B.9.3 모양의 입력 — RL-17 경계 개정 구간(27,272,728~29,999,999)은 넣지 않는다
  const inputs: [string, RuleEvaluationInput][] = [
    [
      'B.9.1',
      {
        years: [year('y1', totals({ personnel: [180_840_000, 88_650_000], activity: [27_020_000, 0], indirect: [2_000_000, 0] }))],
        project: { govBudget: 225_000_000, ownBudget: 100_000_000, totalBudget: 325_000_000 },
      },
    ],
    [
      'B.9.2',
      {
        years: [
          year('y1', totals({ personnel: [40_000_000, 10_000_000], allowance: [1_000_000, 0] }), [
            personnelRow({ id: 'row-A', memberId: 'A', hireType: 'existing', axis: 'cash', amount: 20_000_000, rate: 50 }),
            personnelRow({ id: 'row-B', memberId: 'B', hireType: 'new', axis: 'cash', amount: 20_000_000, rate: 50 }),
            personnelRow({ id: 'row-C', memberId: 'C', hireType: 'existing', axis: 'in_kind', amount: 10_000_000, rate: 5 }),
          ]),
        ],
        project: { govBudget: 30_000_000, ownBudget: 14_500_000, totalBudget: 44_500_000 },
      },
    ],
    [
      'B.9.3',
      {
        years: [
          year('y1', totals({ personnel: [50_000_000, 0], facility_equipment: [35_000_000, 0], material: [21_000_000, 0], activity: [29_990_000, 0], indirect: [3_000_000, 0] }), [
            quantityRow('facility_equipment', 'facility_purchase', '분광기', 35_000_000),
            quantityRow('material', 'material_purchase', '시약 A', 12_000_000),
            quantityRow('material', 'material_purchase', '시약 A', 9_000_000),
            quantityRow('activity', 'activity_outsourcing', '해석 용역', 29_990_000),
            quantityRow('indirect', 'indirect_support', '연구실 안전관리비', 3_000_000),
          ]),
        ],
        project: NO_PROJECT,
      },
    ],
  ];

  for (const id of ['msit_profit', 'moe_energy_sme'] as const) {
    for (const [name, input] of inputs) {
      it(`${id} · ${name}: 새 코드 3행을 더해도 deepEqual`, () => {
        expect(evaluateRules(preset(id), input)).toEqual(evaluateRules(phase25Preset(id), input));
      });
    }
  }

  it('preserve_subcategory_totals 행은 evaluateRules가 판정하지 않는다 (수행 전용 플래그)', () => {
    const rules = only(['preserve_subcategory_totals']);
    expect(rules).toHaveLength(1);
    const evaluation = evaluateRules(rules, inputs[0]![1]);
    expect(evaluation.findings).toEqual([]);
    expect(evaluation.skipped).toEqual([]);
    expect(RULE_SPECS.preserve_subcategory_totals.modes).toEqual(['agreement']);
  });
});

// ─── 소스 경계 — 분모 재구현 0 · 부동소수 곱 0 ────────────────

describe('lib/rules.ts 소스 경계 (§6.14.7)', () => {
  const ROOT = path.resolve(__dirname, '../..');
  // 주석을 지운 사본 — 주석은 "×1.1"·"E1" 같은 규칙 설명을 담는다
  const code = fs
    .readFileSync(path.join(ROOT, 'lib/rules.ts'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:'"`])\/\/.*$/gm, '$1');

  it('E1·수정직접비·총 인건비를 다시 정의하지 않는다 — budget-plan 집계를 호출한다', () => {
    expect(/\bfunction\s+(modifiedPersonnel|modifiedDirectCost|totalPersonnelCost)\b/.test(code)).toBe(false);
    expect(/\b(MODIFIED_PERSONNEL_CATEGORIES|EXCLUDED_BY_BASE)\b/.test(code)).toBe(false);
    // 인건비 + 학생인건비 비목 목록을 직접 쓰면 RL-22 분모를 두 번째로 적은 것이다
    expect(/\[\s*'personnel'\s*,\s*'student_personnel'\s*\]/.test(code)).toBe(false);
    expect(code).toContain('totalPersonnelCost(year.totals)');
    expect(code).toContain('modifiedPersonnel(totals)');
    expect(code).toContain('modifiedDirectCost(totals, base)');
  });

  it('RL-17 비교에 부동소수점 1.1이 없다 — 정수 비교 amount * 11 >= value * 10', () => {
    expect(/\b1\.1\b/.test(code)).toBe(false);
    expect(code).toContain('amount * 11 >= value * 10');
  });
});

// ─── 프리셋 새 행 ────────────────────────────────────────────

describe('부록 D 새 3행 — 간사 지침', () => {
  it('두 프리셋 마지막 3행이 같은 값·출처를 갖고, 서로 다른 객체다', () => {
    const tail = (id: PresetId) => RULE_PRESETS[id].rules.slice(-3);
    expect(tail('msit_profit')).toEqual([
      { code: 'lab_safety_min', enabled: true, value: 1, base: null, severity: 'warn', source: '간사 지침 연구실 안전관리비 (인건비 + 학생인건비의 1% 이상)' },
      { code: 'lab_safety_max', enabled: true, value: 2, base: null, severity: 'warn', source: '간사 지침 연구실 안전관리비 (인건비 + 학생인건비의 2% 이하)' },
      { code: 'preserve_subcategory_totals', enabled: true, value: null, base: null, severity: 'warn', source: '간사 지침 세목 총액 보존 (연차 간 이동 시 세목별 총액 유지)' },
    ]);
    expect(tail('moe_energy_sme')).toEqual(tail('msit_profit'));
    expect(tail('moe_energy_sme')[0]).not.toBe(tail('msit_profit')[0]);
  });
});
