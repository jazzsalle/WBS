// 붙임4형(8-1·8-2)·조정회의형 보기 모델 (SOT §6.19 AG-3·AG-4·AG-8, 부록 C.4, 계획서 S-5~S-8·합성 픽스처).
// 숫자는 계획서 Phase 25 합성 픽스처(버전 A = Phase 24 S-20) 그대로다 — 안 맞으면 구현이 틀린 것이다.
// 기호 혼동(I/E2 7.5% — 6.8182%면 FAIL)과 양식 분모 ≠ RL-3(6.0976% — 6.25%면 FAIL)이 이 파일의 핵심이다.

import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import {
  attachment4Tables,
  buildAttachment4View,
  judgeRatio,
  type Attachment4ViewInput,
  type Attachment4ViewModel,
  type Form81Row,
  type FormViewCell,
  type GovCashInput,
} from '@/lib/agreement/attachment4-view';
import { adjustmentTable, buildAdjustmentView, type AdjustmentSide } from '@/lib/agreement/adjustment-view';
import { aggregateFormRows, formColumnMetrics, formRowOf, type FormRowLine } from '@/lib/agreement/form-rows';
import { buildBaselineFromPlan, type PlanDetailInput, type PlanItemInput } from '@/lib/agreement/from-plan';
import { computeRate, formatRate } from '@/lib/agreement/rates';
import { assertTableModel, toTsv } from '@/lib/agreement/table';
import { modifiedDirectCost, modifiedPersonnel } from '@/lib/budget-plan';
import { BUDGET_CATEGORY_ORDER, SUBCATEGORY_PRESETS } from '@/lib/constants';
import { DEFAULT_INDIRECT_BASE, evaluateRules, type RuleInput } from '@/lib/rules';
import type { BudgetCategory, DetailAxis, DetailFactor, RuleCode } from '@/types';

// ─── 픽스처 ───────────────────────────────────────────────────────────────────

const STAGES = [{ id: 'S1', name: '1단계', order: 0 }];
const YEARS = [
  { id: 'Y2', name: '2차년도', order: 1, stageId: 'S1' },
  { id: 'Y1', name: '1차년도', order: 0, stageId: 'S1' },
];

function line(yearId: string, category: BudgetCategory, sub: string, axis: DetailAxis, amount: number): FormRowLine {
  return { yearId, category, subcategoryCode: sub, axis, amount };
}

/** Phase 24 S-20 버전 A */
const VERSION_A: FormRowLine[] = [
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

const GOV_35: GovCashInput[] = [
  { yearId: 'Y1', govCash: 35_000_000 },
  { yearId: 'Y2', govCash: 35_000_000 },
];

function rule(code: RuleCode, value: number | null, enabled = true): RuleInput {
  return { code, enabled, value, base: null, severity: 'error', source: '테스트 고시' };
}

function view(over: Partial<Attachment4ViewInput> = {}): Attachment4ViewModel {
  return buildAttachment4View({ lines: VERSION_A, years: YEARS, stages: STAGES, govSupport: GOV_35, rules: [], ...over });
}

const round4 = (v: number | null): number | null => (v === null ? null : Math.round(v * 10_000) / 10_000);

/** 8-2 칸 — 행 key × 열 key('Y1'·'Y2'·'total'·단계 id) */
function cell82(v: Attachment4ViewModel, rowKey: string, colKey: string): FormViewCell {
  const row = v.plan82.rows.find((r) => r.key === rowKey);
  if (row === undefined) throw new Error(`8-2 행 없음: ${rowKey}`);
  const ci = v.plan82.columns.findIndex((c) => c.key === colKey);
  if (ci < 0) throw new Error(`8-2 열 없음: ${colKey}`);
  return row.cells[ci]!;
}

function amount82(v: Attachment4ViewModel, rowKey: string, colKey: string): number | null {
  const c = cell82(v, rowKey, colKey);
  if (c.kind === 'amount') return c.value;
  if (c.kind === 'empty') return null;
  throw new Error(`금액 칸이 아닙니다: ${rowKey}/${colKey} (${c.kind})`);
}

function rate82(v: Attachment4ViewModel, rowKey: string, colKey: string): number | null {
  const c = cell82(v, rowKey, colKey);
  if (c.kind !== 'rate') throw new Error(`비율 칸이 아닙니다: ${rowKey}/${colKey}`);
  return round4(c.rate.value);
}

function metrics(v: Attachment4ViewModel, colKey: string) {
  const ci = v.plan82.columns.findIndex((c) => c.key === colKey);
  return v.plan82.metrics[ci]!;
}

function row81(v: Attachment4ViewModel, key: string): Form81Row {
  const row = v.plan81.rows.find((r) => r.key === key);
  if (row === undefined) throw new Error(`8-1 행 없음: ${key}`);
  return row;
}

function assertTables(v: Attachment4ViewModel): void {
  const t = attachment4Tables(v, { plan81: '8-1', plan82: '8-2' });
  assertTableModel(t.plan81);
  assertTableModel(t.plan82);
  expect(toTsv(t.plan81).length).toBeGreaterThan(0);
  expect(toTsv(t.plan82).length).toBeGreaterThan(0);
}

// ─── 대응표 (부록 C.4.1) ──────────────────────────────────────────────────────

describe('양식 행 대응 (부록 C.4.1 ⑤)', () => {
  it('12비목의 모든 A.5 세목과 default가 정확히 한 양식 행에 들어간다', () => {
    for (const category of BUDGET_CATEGORY_ORDER) {
      const codes = new Set([...SUBCATEGORY_PRESETS[category].map((d) => d.code), 'default']);
      for (const code of codes) expect(formRowOf(category, code), `${category}/${code}`).not.toBeNull();
    }
  });

  it('세목 미지정 인건비 → A, 세목 미지정 학생인건비 → D 일반, promotion → H, 양식 밖 4종 → 양식에 없는 비목', () => {
    expect(formRowOf('personnel', 'default')).toBe('personnel_internal');
    expect(formRowOf('personnel', 'personnel_support')).toBe('personnel_support');
    expect(formRowOf('student_personnel', 'default')).toBe('student_general');
    expect(formRowOf('promotion', 'default')).toBe('activity');
    for (const c of ['consignment', 'international', 'burden', 'other'] as const) expect(formRowOf(c, 'default')).toBe('outside');
  });
});

// ─── 8-2 사용계획 ─────────────────────────────────────────────────────────────

describe('8-2 버전 A (픽스처)', () => {
  const v = view();

  it.each([
    // [열, E1, E2, I/E2, K, L, 양식 분모, 간접비 비율, M, E1/M]
    ['Y1', 40_000_000, 40_000_000, 7.5, 50_000_000, 2_500_000, 40_000_000, 6.25, 52_500_000, 76.1905],
    ['Y2', 42_000_000, 42_000_000, 7.1429, 50_000_000, 2_700_000, 40_000_000, 6.75, 52_700_000, 79.6964],
    ['total', 82_000_000, 82_000_000, 7.3171, 100_000_000, 5_200_000, 80_000_000, 6.5, 105_200_000, 77.9468],
  ] as const)('%s: E1 %d · E2 %d · I/E2 %d%% · K %d · L %d · 분모 %d → %d%% · M %d · E1/M %d%%', (col, e1, e2, ie2, k, l, base, ir, m, e1m) => {
    expect(amount82(v, 'total_personnel', col)).toBe(e1);
    expect(amount82(v, 'modified_personnel', col)).toBe(e2);
    expect(rate82(v, 'allowance_ratio', col)).toBe(ie2);
    expect(amount82(v, 'direct_subtotal', col)).toBe(k);
    expect(amount82(v, 'indirect', col)).toBe(l);
    expect(metrics(v, col).formIndirectBase).toBe(base);
    expect(rate82(v, 'indirect_ratio', col)).toBe(ir);
    expect(amount82(v, 'total', col)).toBe(m);
    expect(rate82(v, 'personnel_ratio', col)).toBe(e1m);
  });

  it('행 순서 = C.4.1(통합관리비 행 없음, 양식 밖 0이면 행 없음), 라벨 "양식 E1/E2"', () => {
    expect(v.plan82.rows.map((r) => r.key)).toEqual([
      'personnel_internal:cash', 'personnel_internal:in_kind',
      'personnel_external:cash', 'personnel_external:in_kind',
      'personnel_support', 'personnel_subtotal',
      'student_general', 'student_managed',
      'total_personnel', 'modified_personnel',
      'facility_equipment:cash', 'facility_equipment:in_kind',
      'material:cash', 'material:in_kind',
      'activity:cash', 'activity:in_kind',
      'allowance', 'allowance_ratio',
      'direct_subtotal', 'indirect', 'lab_safety', 'indirect_ratio', 'total', 'personnel_ratio',
    ]);
    expect(v.plan82.showOutsideRow).toBe(false);
    expect(v.plan82.rows.find((r) => r.key === 'total_personnel')!.label).toContain('양식 E1');
    expect(v.plan82.rows.find((r) => r.key === 'modified_personnel')!.label).toContain('양식 E2');
  });

  it('줄 없는 칸은 "—"(empty) — 금액 0과 다르다', () => {
    expect(cell82(v, 'facility_equipment:cash', 'Y1')).toEqual({ kind: 'empty' });
    expect(cell82(v, 'personnel_support', 'total')).toEqual({ kind: 'empty' });
    expect(cell82(v, 'personnel_internal:in_kind', 'Y1')).toEqual({ kind: 'amount', value: 10_000_000 });
  });

  it('연구실 안전관리비 행은 내역 행 — 세목 줄이 없으면 전 칸 "—"(empty, 0 아님), 검토사항 없음(Phase 26)', () => {
    const row = v.plan82.rows.find((r) => r.key === 'lab_safety')!;
    expect(row.kind).toBe('breakdown');
    for (const c of row.cells) expect(c).toEqual({ kind: 'empty' });
    expect(v.reviewNotes.map((n) => n.code as string)).not.toContain('lab_safety_no_source');
  });

  it('편집 가능 칸 = 데이터 행만(집계·비율·내역 불가)', () => {
    const editable = v.plan82.rows.filter((r) => r.editable).map((r) => r.key);
    expect(editable).toEqual([
      'personnel_internal:cash', 'personnel_internal:in_kind',
      'personnel_external:cash', 'personnel_external:in_kind',
      'personnel_support', 'student_general', 'student_managed',
      'facility_equipment:cash', 'facility_equipment:in_kind',
      'material:cash', 'material:in_kind',
      'activity:cash', 'activity:in_kind',
      'allowance', 'indirect',
    ]);
  });

  it('단계가 하나면 단계 소계 열이 없다', () => {
    expect(v.plan82.columns.map((c) => c.key)).toEqual(['Y1', 'Y2', 'total']);
  });

  it('표 모델 검증 통과(집계 행 = sum 칸 결과값이 항들의 합)', () => assertTables(v));
});

describe('8-2 기호 혼동 — Y1 personnel_support 현금 4,000,000 (PL-11 C 제외)', () => {
  const v = view({ lines: [...VERSION_A, line('Y1', 'personnel', 'personnel_support', 'cash', 4_000_000)] });

  it('C 4,000,000 · E1 44,000,000 · E2 40,000,000 · I/E2 7.5%(6.8182%면 FAIL)', () => {
    expect(amount82(v, 'personnel_support', 'Y1')).toBe(4_000_000);
    expect(amount82(v, 'personnel_subtotal', 'Y1')).toBe(44_000_000);
    expect(amount82(v, 'total_personnel', 'Y1')).toBe(44_000_000);
    expect(amount82(v, 'modified_personnel', 'Y1')).toBe(40_000_000);
    expect(rate82(v, 'allowance_ratio', 'Y1')).toBe(7.5);
    expect(rate82(v, 'allowance_ratio', 'Y1')).not.toBe(6.8182);
  });

  it('K 54,000,000 · 분모 44,000,000 → 5.6818% · M 56,500,000 · E1/M 77.8761%', () => {
    expect(amount82(v, 'direct_subtotal', 'Y1')).toBe(54_000_000);
    expect(metrics(v, 'Y1').formIndirectBase).toBe(44_000_000);
    expect(rate82(v, 'indirect_ratio', 'Y1')).toBe(5.6818);
    expect(amount82(v, 'total', 'Y1')).toBe(56_500_000);
    expect(rate82(v, 'personnel_ratio', 'Y1')).toBe(77.8761);
  });

  it('양식 E2 = lib/budget-plan modifiedPersonnel(재사용) 그대로', () => {
    const y1 = v.formRows.years.find((y) => y.yearId === 'Y1')!;
    expect(amount82(v, 'modified_personnel', 'Y1')).toBe(modifiedPersonnel(y1.totals));
    assertTables(v);
  });
});

describe('8-2 양식 분모 ≠ RL-3 — Y1 student_general 현물 1,000,000', () => {
  const v = view({ lines: [...VERSION_A, line('Y1', 'student_personnel', 'student_general', 'in_kind', 1_000_000)] });

  it('분모 41,000,000 → 6.0976%(6.25%면 FAIL), modifiedDirectCost 40,000,000, E1 = E2 = 41,000,000', () => {
    const y1 = v.formRows.years.find((y) => y.yearId === 'Y1')!;
    expect(metrics(v, 'Y1').formIndirectBase).toBe(41_000_000);
    expect(rate82(v, 'indirect_ratio', 'Y1')).toBe(6.0976);
    expect(rate82(v, 'indirect_ratio', 'Y1')).not.toBe(6.25);
    expect(modifiedDirectCost(y1.totals, DEFAULT_INDIRECT_BASE)).toBe(40_000_000);
    expect(amount82(v, 'total_personnel', 'Y1')).toBe(41_000_000);
    expect(amount82(v, 'modified_personnel', 'Y1')).toBe(41_000_000);
    assertTables(v);
  });
});

describe('8-2 promotion (U-1) — Y2 promotion/default 현금 400,000', () => {
  const v = view({ lines: [...VERSION_A, line('Y2', 'promotion', 'default', 'cash', 400_000)] });

  it('H Y2 1,400,000 · K 50,400,000 · 분모 40,400,000 → 6.6832% = modifiedDirectCost', () => {
    const y2 = v.formRows.years.find((y) => y.yearId === 'Y2')!;
    expect(amount82(v, 'activity:cash', 'Y2')).toBe(1_400_000);
    expect(amount82(v, 'direct_subtotal', 'Y2')).toBe(50_400_000);
    expect(metrics(v, 'Y2').formIndirectBase).toBe(40_400_000);
    expect(rate82(v, 'indirect_ratio', 'Y2')).toBe(6.6832);
    expect(modifiedDirectCost(y2.totals, DEFAULT_INDIRECT_BASE)).toBe(40_400_000);
    assertTables(v);
  });
});

describe('교차: 양식 분모 ↔ modifiedDirectCost(DEFAULT_INDIRECT_BASE) — C·D·I 현물 0 · 양식 밖 0 · H에 promotion', () => {
  const variants: [string, FormRowLine[]][] = [
    ['버전 A', VERSION_A],
    ['promotion', [...VERSION_A, line('Y2', 'promotion', 'default', 'cash', 400_000)]],
    [
      'C·D 현금·장비·현물 여러 비목',
      [
        ...VERSION_A,
        line('Y1', 'personnel', 'personnel_support', 'cash', 1_500_000),
        line('Y1', 'personnel', 'personnel_external', 'cash', 2_000_000),
        line('Y1', 'personnel', 'personnel_external', 'in_kind', 700_000),
        line('Y1', 'student_personnel', 'student_managed', 'cash', 900_000),
        line('Y2', 'facility_equipment', 'facility_purchase', 'cash', 6_000_000),
        line('Y2', 'facility_equipment', 'facility_lease', 'in_kind', 1_000_000),
        line('Y2', 'material', 'material_make', 'in_kind', 300_000),
        line('Y2', 'activity', 'activity_ip', 'in_kind', 200_000),
        line('Y2', 'promotion', 'default', 'in_kind', 50_000),
      ],
    ],
  ];

  it.each(variants)('%s: 연차마다·합계가 같다', (_, lines) => {
    const v = view({ lines });
    let sum = 0;
    for (const y of v.formRows.years) {
      const expected = modifiedDirectCost(y.totals, DEFAULT_INDIRECT_BASE);
      expect(metrics(v, y.yearId).formIndirectBase).toBe(expected);
      sum += expected;
    }
    expect(metrics(v, 'total').formIndirectBase).toBe(sum);
    assertTables(v);
  });
});

describe('8-2 양식에 없는 비목 (U-2) — Y1 consignment 현금 1,000,000', () => {
  const v = view({ lines: [...VERSION_A, line('Y1', 'consignment', 'default', 'cash', 1_000_000)] });

  it('"양식에 없는 비목" 1,000,000 · K 51,000,000 · M 53,500,000 · 분모는 그대로 40,000,000', () => {
    expect(v.plan82.showOutsideRow).toBe(true);
    const row = v.plan82.rows.find((r) => r.key === 'outside')!;
    expect(row.label).toBe('양식에 없는 비목');
    expect(row.editable).toBe(false);
    expect(amount82(v, 'outside', 'Y1')).toBe(1_000_000);
    expect(amount82(v, 'direct_subtotal', 'Y1')).toBe(51_000_000);
    expect(amount82(v, 'total', 'Y1')).toBe(53_500_000);
    expect(metrics(v, 'Y1').formIndirectBase).toBe(40_000_000);
    assertTables(v);
  });

  it('검토사항 경고', () => {
    const notes = v.reviewNotes.filter((n) => n.code === 'outside_categories');
    expect(notes).toHaveLength(1);
    expect(notes[0]).toMatchObject({ severity: 'warning', yearId: 'Y1' });
    expect(notes[0]!.message).toContain('위탁연구개발비 1,000,000원');
  });

  it('양식 밖 줄이 있어도 금액이 0이면 행 없음', () => {
    const zero = view({ lines: [...VERSION_A, line('Y1', 'other', 'default', 'cash', 0)] });
    expect(zero.plan82.showOutsideRow).toBe(false);
    expect(zero.plan82.rows.some((r) => r.key === 'outside')).toBe(false);
    expect(zero.reviewNotes.some((n) => n.code === 'outside_categories')).toBe(false);
    assertTables(zero);
  });
});

describe('8-2 세목 미지정 인건비·학생인건비 (C.4.1)', () => {
  const v = view({
    lines: [
      ...VERSION_A,
      line('Y1', 'personnel', 'default', 'cash', 2_000_000),
      line('Y2', 'student_personnel', 'default', 'in_kind', 500_000),
    ],
  });

  it('A·D 일반에 들어가고 E1·E2·총액이 보존된다', () => {
    expect(amount82(v, 'personnel_internal:cash', 'Y1')).toBe(32_000_000);
    expect(amount82(v, 'student_general', 'Y2')).toBe(500_000);
    expect(amount82(v, 'total_personnel', 'Y1')).toBe(42_000_000);
    expect(amount82(v, 'modified_personnel', 'Y1')).toBe(42_000_000);
    expect(amount82(v, 'total', 'total')).toBe(105_200_000 + 2_500_000);
    assertTables(v);
  });

  it('검토사항 문구', () => {
    const messages = v.reviewNotes.map((n) => n.message);
    expect(messages).toContain('1차년도: 세목 미지정 인건비 2,000,000원을 내부인건비(A)에 넣었습니다');
    expect(messages).toContain('2차년도: 세목 미지정 학생인건비 500,000원을 학생인건비 일반(D)에 넣었습니다');
  });
});

describe('8-2 단계 소계 열 (단계 2개 이상)', () => {
  const stages = [
    { id: 'S2', name: '2단계', order: 1 },
    { id: 'S1', name: '1단계', order: 0 },
  ];
  const years = [
    { id: 'Y1', name: '1차년도', order: 0, stageId: 'S1' },
    { id: 'Y2', name: '2차년도', order: 1, stageId: 'S1' },
    { id: 'Y3', name: '3차년도', order: 2, stageId: 'S2' },
  ];
  const v = view({ years, stages, govSupport: [] });

  it('열 = 단계별 연차 + "{단계} 소계", 끝에 합계', () => {
    expect(v.plan82.columns.map((c) => c.label)).toEqual(['1차년도', '2차년도', '1단계 소계', '3차년도', '2단계 소계', '합계']);
  });

  it('단계 소계 = 그 단계 연차 합, 줄 없는 단계는 "—"', () => {
    expect(amount82(v, 'total', 'S1')).toBe(105_200_000);
    expect(amount82(v, 'total', 'S2')).toBeNull();
    expect(cell82(v, 'indirect_ratio', 'S2')).toMatchObject({ kind: 'rate', text: '—' });
    expect(rate82(v, 'indirect_ratio', 'S1')).toBe(6.5);
    assertTables(v);
  });
});

describe('8-2 분모 0 — "—" + 사유', () => {
  // 연구수당만 있는 연차: E2 = 0, 양식 분모 = I > 0
  const v = view({ lines: [line('Y1', 'material', 'material_purchase', 'in_kind', 1_000_000), line('Y1', 'indirect', 'indirect_hr', 'cash', 100_000)] });

  it('I/E2·간접비 비율은 "—", 사유는 검토사항에', () => {
    const c = cell82(v, 'allowance_ratio', 'Y1');
    expect(c).toMatchObject({ kind: 'rate', text: '—' });
    expect(cell82(v, 'indirect_ratio', 'Y1')).toMatchObject({ kind: 'rate', text: '—' });
    const zero = v.reviewNotes.filter((n) => n.code === 'zero_denominator' && n.yearId === 'Y1').map((n) => n.message);
    expect(zero.some((m) => m.includes('양식 E2(수정인건비)가 0'))).toBe(true);
    expect(zero.some((m) => m.includes('양식 분모'))).toBe(true);
    // 줄이 하나도 없는 Y2는 "줄 없음" — 분모 0 검토사항을 만들지 않는다
    expect(v.reviewNotes.some((n) => n.code === 'zero_denominator' && n.yearId === 'Y2')).toBe(false);
    assertTables(v);
  });
});

// ─── 8-1 지원·부담계획 ────────────────────────────────────────────────────────

describe('8-1 정부지원 현금 Y1·Y2 35,000,000 (픽스처)', () => {
  const v = view();

  it.each([
    // [행, A, B, C, D, H, A/H, B/D]
    ['Y1', 35_000_000, 7_500_000, 10_000_000, 17_500_000, 52_500_000, 66.6667, 42.8571],
    ['Y2', 35_000_000, 7_700_000, 10_000_000, 17_700_000, 52_700_000, 66.4137, 43.5028],
    ['total', 70_000_000, 15_200_000, 20_000_000, 35_200_000, 105_200_000, 66.5399, 43.1818],
  ] as const)('%s: A %d · B %d · C %d · D %d · H %d → %d%% · %d%%', (key, a, b, c, d, h, gs, oc) => {
    const r = row81(v, key);
    expect(r.govCash).toBe(a);
    expect(r.ownCash).toBe(b);
    expect(r.ownInKind).toBe(c);
    expect(r.ownSubtotal).toBe(d);
    expect(r.total).toBe(h);
    expect(r.totalCash + r.totalInKind).toBe(h);
    expect(round4(r.govShare.value)).toBe(gs);
    expect(round4(r.ownCashShare.value)).toBe(oc);
    expect(r.companyType).toBe('중소기업');
    expect([r.otherCash, r.otherInKind, r.otherSubtotal]).toEqual([0, 0, 0]);
  });

  it('행 = 연차(order 순) + 합계', () => {
    expect(v.plan81.rows.map((r) => r.key)).toEqual(['Y1', 'Y2', 'total']);
  });

  it('교차: 합계 행 비율 = evaluateRules(gov ΣA, own ΣD, total ΣH) ratios — 국제공동 0', () => {
    const total = row81(v, 'total');
    const evaluation = evaluateRules([], {
      years: v.formRows.years.map((y) => ({ yearId: y.yearId, totals: y.totals, rows: [] })),
      project: { govBudget: total.govCash, ownBudget: total.ownSubtotal, totalBudget: total.total },
    });
    expect(total.govShare.value).toBe(evaluation.ratios.gov_share_max[0]!.actual);
    expect(total.ownCashShare.value).toBe(evaluation.ratios.own_cash_min[0]!.actual);
  });

  it('표 모델 검증 통과', () => assertTables(v));
});

describe('8-1 판정 (G-1)', () => {
  it('gov_share_max 75 · own_cash_min 40 → 전부 통과', () => {
    const v = view({ rules: [rule('gov_share_max', 75), rule('own_cash_min', 40)] });
    for (const r of v.plan81.rows) {
      expect(r.govShareJudgement.status).toBe('pass');
      expect(r.ownCashJudgement.status).toBe('pass');
      expect(r.govShareJudgement.label).toBe('통과');
    }
  });

  it('own_cash_min 43 → Y1만 미달(위반), Y2·합계 통과', () => {
    const v = view({ rules: [rule('own_cash_min', 43)] });
    expect(row81(v, 'Y1').ownCashJudgement).toMatchObject({ status: 'fail', label: '위반', limit: 43 });
    expect(row81(v, 'Y2').ownCashJudgement.status).toBe('pass');
    expect(row81(v, 'total').ownCashJudgement.status).toBe('pass');
  });

  it('규칙 행 없음·꺼짐·값 없음 → "판정하지 않음" + 사유', () => {
    const none = view();
    expect(row81(none, 'Y1').govShareJudgement).toMatchObject({ status: 'skipped', label: '판정하지 않음' });
    expect(row81(none, 'Y1').govShareJudgement).toHaveProperty('reason', 'RL-8 규칙 행이 없습니다');
    const off = view({ rules: [rule('gov_share_max', 75, false), rule('own_cash_min', null)] });
    expect(row81(off, 'Y1').govShareJudgement).toHaveProperty('reason', 'RL-8 규칙이 꺼져 있습니다');
    expect(row81(off, 'Y1').ownCashJudgement).toHaveProperty('reason', 'RL-9 한도 값이 없습니다');
  });

  it('경계는 lib/rules.ts와 같다 — 한도와 같으면 통과, evaluateRules도 위반 없음', () => {
    const base = view();
    const total = row81(base, 'total');
    const limits = [rule('gov_share_max', total.govShare.value), rule('own_cash_min', total.ownCashShare.value)];
    const v = view({ rules: limits });
    expect(row81(v, 'total').govShareJudgement.status).toBe('pass');
    expect(row81(v, 'total').ownCashJudgement.status).toBe('pass');
    const evaluation = evaluateRules(limits, {
      years: v.formRows.years.map((y) => ({ yearId: y.yearId, totals: y.totals, rows: [] })),
      project: { govBudget: total.govCash, ownBudget: total.ownSubtotal, totalBudget: total.total },
    });
    expect(evaluation.findings.filter((f) => f.code === 'gov_share_max' || f.code === 'own_cash_min')).toEqual([]);
    // 한도를 아주 조금 낮추면(높이면) 둘 다 위반 — 같은 방향
    const tighter = view({ rules: [rule('gov_share_max', total.govShare.value! - 1e-9), rule('own_cash_min', total.ownCashShare.value! + 1e-9)] });
    expect(row81(tighter, 'total').govShareJudgement.status).toBe('fail');
    expect(row81(tighter, 'total').ownCashJudgement.status).toBe('fail');
  });

  it('judgeRatio: 비율 "—"면 그 사유로 판정하지 않음', () => {
    expect(judgeRatio('gov_share_max', rule('gov_share_max', 75), { value: null, reason: '합계(H)가 0' })).toEqual({
      status: 'skipped', label: '판정하지 않음', reason: '합계(H)가 0',
    });
  });
});

describe('8-1 정부지원 현금 미입력·초과·0', () => {
  it('Y2 행 없음(미입력) → Y2·합계 A·B·D·비율 "—" + 사유, 검토사항', () => {
    const v = view({ govSupport: [{ yearId: 'Y1', govCash: 35_000_000 }], rules: [rule('gov_share_max', 75)] });
    const y2 = row81(v, 'Y2');
    expect(y2.govCashStatus).toBe('missing');
    expect(y2.govCashInput).toBeNull();
    expect([y2.govCash, y2.ownCash, y2.ownSubtotal]).toEqual([null, null, null]);
    expect(formatRate(y2.govShare)).toBe('—');
    expect(y2.govShare.reason).toBe('정부지원 현금 미입력');
    expect(y2.govShareJudgement).toMatchObject({ status: 'skipped', reason: '정부지원 현금 미입력' });
    // C·H는 정부지원 현금과 무관하게 보인다
    expect(y2.ownInKind).toBe(10_000_000);
    expect(y2.total).toBe(52_700_000);
    const total = row81(v, 'total');
    expect(total.govCash).toBeNull();
    expect(formatRate(total.ownCashShare)).toBe('—');
    expect(total.govShare.reason).toContain('2차년도');
    expect(row81(v, 'Y1').govShareJudgement.status).toBe('pass');
    expect(v.reviewNotes.filter((n) => n.code === 'gov_cash_missing').map((n) => n.yearId)).toEqual(['Y2']);
    assertTables(v);
  });

  it('Y1 = 45,000,000(> 현금 합 42,500,000) → Y1 "—" + 경고, 저장값은 편집 칸에 남는다', () => {
    const v = view({ govSupport: [{ yearId: 'Y1', govCash: 45_000_000 }, { yearId: 'Y2', govCash: 35_000_000 }] });
    const y1 = row81(v, 'Y1');
    expect(y1.govCashStatus).toBe('exceeds');
    expect(y1.govCashInput).toBe(45_000_000);
    expect([y1.govCash, y1.ownCash]).toEqual([null, null]);
    expect(formatRate(y1.govShare)).toBe('—');
    expect(row81(v, 'Y2').govCash).toBe(35_000_000);
    const note = v.reviewNotes.find((n) => n.code === 'gov_cash_exceeds')!;
    expect(note.yearId).toBe('Y1');
    expect(note.message).toContain('45,000,000원');
    expect(note.message).toContain('42,500,000원');
    assertTables(v);
  });

  it('Y1 = 0(입력)은 "—"가 아니라 0% 계산', () => {
    const v = view({ govSupport: [{ yearId: 'Y1', govCash: 0 }, { yearId: 'Y2', govCash: 35_000_000 }] });
    const y1 = row81(v, 'Y1');
    expect(y1.govCashStatus).toBe('ok');
    expect(y1.govCash).toBe(0);
    expect(y1.govShare.value).toBe(0);
    expect(formatRate(y1.govShare)).toBe('0.00%');
    expect(y1.ownCash).toBe(42_500_000);
    assertTables(v);
  });
});

// ─── 조정회의형 ───────────────────────────────────────────────────────────────

const PERSONNEL_FACTORS = (rate: number, months: number): DetailFactor[] => [
  { label: '참여율(%)', value: rate, isPercent: true },
  { label: '참여기간(월)', value: months, isPercent: false },
];

function detail(over: Partial<PlanDetailInput> & Pick<PlanDetailInput, 'category' | 'subcategory' | 'amount'>): PlanDetailInput {
  return { yearId: 'Y1', axis: 'cash', formula: 'quantity', memberId: null, factors: [], ...over };
}

function item(over: Partial<PlanItemInput> & Pick<PlanItemInput, 'category' | 'plannedAmount'>): PlanItemInput {
  return { yearId: 'Y1', cashAmount: null, inKindAmount: null, ...over };
}

/** Phase 24 S-20 "보내기" 제안(Y1만) */
const PLAN = {
  details: [
    detail({ category: 'personnel', subcategory: 'personnel_internal', formula: 'personnel', memberId: 'M1', factors: PERSONNEL_FACTORS(50, 12), amount: 30_000_000 }),
    detail({ category: 'personnel', subcategory: 'personnel_internal', formula: 'personnel', memberId: 'M2', axis: 'in_kind', factors: PERSONNEL_FACTORS(20, 12), amount: 10_000_000 }),
    detail({ category: 'activity', subcategory: 'activity_meeting', factors: [{ label: '회', value: 12, isPercent: false }], amount: 1_200_000 }),
    detail({ category: 'activity', subcategory: 'activity_travel_dom', factors: [{ label: '횟수', value: 4, isPercent: false }], amount: 800_000 }),
  ],
  items: [
    item({ category: 'personnel', plannedAmount: 40_000_000, cashAmount: 30_000_000, inKindAmount: 10_000_000 }),
    item({ category: 'activity', plannedAmount: 2_000_000, cashAmount: 2_000_000, inKindAmount: 0 }),
    item({ category: 'material', plannedAmount: 5_000_000, cashAmount: 5_000_000, inKindAmount: 0 }),
    item({ category: 'allowance', plannedAmount: 3_000_000 }),
  ],
  members: [
    { id: 'M1', annualSalary: 60_000_000 },
    { id: 'M2', annualSalary: 50_000_000 },
  ],
  years: YEARS.map(({ id, name, order }) => ({ id, name, order })),
};

const ADJ_YEARS = YEARS.map(({ id, name, order }) => ({ id, name, order }));

function sideRow(side: AdjustmentSide, id: string): FormViewCell[] {
  return side.rows.find((r) => r.id === id)!.cells;
}

/** 열(0 = Y1, 1 = Y2, 2 = 합계)의 [A, B, C, D, E, F] */
function sideAmounts(side: AdjustmentSide, ci: number): (number | null)[] {
  return ['personnel', 'allowance', 'indirect', 'subtotal', 'total', 'direct'].map((id) => {
    const c = sideRow(side, id)[ci]!;
    return c.kind === 'amount' ? c.value : null;
  });
}

/** [D/E, B/A, A/F, 간접비 비율] */
function sideRates(side: AdjustmentSide, ci: number): (number | null)[] {
  const v = side.values[ci]!;
  return [v.subtotalRatio, v.allowanceRatio, v.personnelDirectRatio, v.indirectRate].map((r) => round4(r.value));
}

describe('조정회의형 (AG-4) — 변경전 = 제안(보내기 변환), 변경후 = 버전 A', () => {
  const before = buildBaselineFromPlan(PLAN);
  const adj = buildAdjustmentView({
    years: ADJ_YEARS,
    before,
    after: { versionId: 'VA', versionName: '최종협약본', lines: VERSION_A },
    currentVersionId: 'VA',
  });

  it('변경전 Y1: A 40,000,000 · B 3,000,000 · C 0 · D 43,000,000 · E 50,000,000 · F 50,000,000 → 86% · 7.5% · 80% · 간접비 0%', () => {
    expect(before.ok).toBe(true);
    expect(adj.before.available).toBe(true);
    expect(sideAmounts(adj.before, 0)).toEqual([40_000_000, 3_000_000, 0, 43_000_000, 50_000_000, 50_000_000]);
    expect(sideRates(adj.before, 0)).toEqual([86, 7.5, 80, 0]);
  });

  it('변경전 Y2 "—"(줄 없는 연차), 합계 = Y1', () => {
    expect(sideAmounts(adj.before, 1)).toEqual([null, null, null, null, null, null]);
    expect(sideRates(adj.before, 1)).toEqual([null, null, null, null]);
    expect(sideAmounts(adj.before, 2)).toEqual([40_000_000, 3_000_000, 0, 43_000_000, 50_000_000, 50_000_000]);
  });

  it('변경후 Y1·Y2·합계', () => {
    expect(sideAmounts(adj.after, 0)).toEqual([40_000_000, 3_000_000, 2_500_000, 45_500_000, 52_500_000, 50_000_000]);
    expect(sideRates(adj.after, 0)).toEqual([86.6667, 7.5, 80, 6.25]);
    expect(sideAmounts(adj.after, 1)).toEqual([42_000_000, 3_000_000, 2_700_000, 47_700_000, 52_700_000, 50_000_000]);
    expect(sideRates(adj.after, 1)).toEqual([90.5123, 7.1429, 84, 6.75]);
    expect(sideRates(adj.after, 2)).toEqual([88.5932, 7.3171, 82, 6.5]);
    expect(round4(adj.after.headerIndirectRate.value)).toBe(6.5);
  });

  it('라벨·현재 버전', () => {
    expect(adj.before.label).toBe('변경전 (제안)');
    expect(adj.after.label).toBe('변경후 (최종협약본)');
    expect(adj.notCurrentVersion).toBe(false);
    expect(adj.notCurrentLabel).toBeNull();
  });

  it('인건비 A = 양식 E2(personnel_support 제외)', () => {
    const lines = [...VERSION_A, line('Y1', 'personnel', 'personnel_support', 'cash', 4_000_000)];
    const a = buildAdjustmentView({ years: ADJ_YEARS, before, after: { versionId: 'VA', versionName: 'A', lines }, currentVersionId: 'VA' });
    expect(sideAmounts(a.after, 0)[0]).toBe(40_000_000);
    expect(sideAmounts(a.after, 0)[5]).toBe(54_000_000);
  });

  it('보고 있는 버전이 현재 버전이 아니면 "현재 버전 아님"', () => {
    const a = buildAdjustmentView({ years: ADJ_YEARS, before, after: { versionId: 'VB', versionName: 'B', lines: VERSION_A }, currentVersionId: 'VA' });
    expect(a.notCurrentVersion).toBe(true);
    expect(a.notCurrentLabel).toBe('현재 버전 아님');
    const t = adjustmentTable(a, '조정회의형');
    expect(t.title).toContain('현재 버전 아님');
    assertTableModel(t);
  });

  it('표 모델: 한 시트, 열 = 항목 + 변경전 연차·합계 + 변경후 연차·합계', () => {
    const t = adjustmentTable(adj, '조정회의형');
    assertTableModel(t);
    expect(t.columns.map((c) => c.label)).toEqual([
      '항목',
      '변경전 (제안) 1차년도', '변경전 (제안) 2차년도', '변경전 (제안) 합계',
      '변경후 (최종협약본) 1차년도', '변경후 (최종협약본) 2차년도', '변경후 (최종협약본) 합계',
    ]);
    const tsv = toTsv(t).split('\r\n');
    expect(tsv[4]).toBe('합계(D=A+B+C)\t43000000\t\t43000000\t45500000\t47700000\t93200000');
    expect(tsv[tsv.length - 1]).toBe('간접비 비율(양식 분모)\t0.00%\t—\t0.00%\t6.25%\t6.75%\t6.50%');
  });
});

describe('조정회의형 — 변경전 변환 실패', () => {
  // 한쪽만 null 불일치: 현금 1,000,000 + 현물 null ≠ 계획액 5,000,000
  const failing = buildBaselineFromPlan({
    ...PLAN,
    items: [...PLAN.items.filter((i) => i.category !== 'material'), item({ category: 'material', plannedAmount: 5_000_000, cashAmount: 1_000_000 })],
  });
  const adj = buildAdjustmentView({
    years: ADJ_YEARS,
    before: failing,
    after: { versionId: 'VA', versionName: '최종협약본', lines: VERSION_A },
    currentVersionId: 'VA',
  });

  it('변경전 열은 0이 아니라 사유 — 변경후는 그대로', () => {
    expect(failing.ok).toBe(false);
    expect(adj.before.available).toBe(false);
    expect(adj.before.failureReasons.length).toBeGreaterThan(0);
    expect(adj.before.failureReasons[0]).toContain('계획액');
    for (const row of adj.before.rows) for (const c of row.cells) expect(c.kind).toBe('none');
    expect(sideAmounts(adj.after, 0)[3]).toBe(45_500_000);
  });

  it('표 모델에 사유 행', () => {
    const t = adjustmentTable(adj, '조정회의형');
    assertTableModel(t);
    const last = t.rows[t.rows.length - 1]!;
    expect(last.cells[0]).toEqual({ kind: 'text', text: '변경전 사유' });
    expect(last.cells[1]).toMatchObject({ kind: 'text' });
    expect((last.cells[1] as { text: string }).text).toContain('계획액');
  });
});

// ─── 비율 표시 ────────────────────────────────────────────────────────────────

describe('rates — 중간 반올림 없음, 표시만 소수 둘째 자리', () => {
  it('computeRate는 원값, 분모 0·null은 값 없음 + 사유', () => {
    expect(computeRate(1, 3, { noLines: 'x', zero: 'z' }).value).toBe((1 / 3) * 100);
    expect(computeRate(1, 0, { noLines: 'x', zero: 'z' })).toEqual({ value: null, reason: 'z' });
    expect(computeRate(1, null, { noLines: 'x', zero: 'z' })).toEqual({ value: null, reason: 'x' });
    expect(computeRate(null, 5, { noLines: 'x', zero: 'z' }).value).toBe(0);
  });

  it.each([
    [7.5, '7.50%'],
    [76.19047619, '76.19%'],
    [1.005, '1.01%'],
    [0, '0.00%'],
    [null, '—'],
  ] as const)('formatRate(%s) = %s', (value, expected) => {
    expect(formatRate(value)).toBe(expected);
  });
});

// ─── 손상 입력 ────────────────────────────────────────────────────────────────

describe('손상 입력은 던진다(조용히 빼지 않는다)', () => {
  it.each([
    ['과제에 없는 연차', [line('Y9', 'material', 'material_purchase', 'cash', 1)]],
    ['같은 칸 두 줄', [line('Y1', 'material', 'default', 'cash', 1), line('Y1', 'material', 'default', 'cash', 2)]],
    ['음수', [line('Y1', 'material', 'default', 'cash', -1)]],
    ['비정수', [line('Y1', 'material', 'default', 'cash', 1.5)]],
    ['A.5에 없는 세목', [line('Y1', 'personnel', 'personnel_unknown', 'cash', 1)]],
    ['알 수 없는 축', [{ ...line('Y1', 'material', 'default', 'cash', 1), axis: 'both' as DetailAxis }]],
  ])('금액 줄: %s', (_, lines) => {
    expect(() => view({ lines })).toThrow();
    expect(() => aggregateFormRows(lines, YEARS)).toThrow();
  });

  it.each([
    ['과제에 없는 연차', [{ yearId: 'Y9', govCash: 1 }]],
    ['한 연차 두 행', [{ yearId: 'Y1', govCash: 1 }, { yearId: 'Y1', govCash: 2 }]],
    ['음수', [{ yearId: 'Y1', govCash: -1 }]],
    ['비정수', [{ yearId: 'Y1', govCash: 0.5 }]],
  ])('정부지원 현금: %s', (_, govSupport) => {
    expect(() => view({ govSupport })).toThrow();
  });

  it('단계 목록에 없는 단계의 연차', () => {
    expect(() => view({ stages: [{ id: 'SX', name: 'X', order: 0 }] })).toThrow();
  });

  it('조정회의형 변경후 줄 손상', () => {
    expect(() =>
      buildAdjustmentView({
        years: ADJ_YEARS,
        before: { ok: true, lines: [] },
        after: { versionId: 'V', versionName: 'V', lines: [line('Y9', 'material', 'default', 'cash', 1)] },
        currentVersionId: 'V',
      })
    ).toThrow();
  });

  it('formColumnMetrics: 집계에 없는 연차', () => {
    expect(() => formColumnMetrics(aggregateFormRows([], YEARS), ['Y9'])).toThrow();
  });
});

// ─── 재사용 (AG-3 — 산식을 다시 구현하지 않는다) ─────────────────────────────

describe('양식 E2는 modifiedPersonnel 재사용', () => {
  it('form-rows.ts가 lib/budget-plan의 modifiedPersonnel을 import해 호출한다', () => {
    const source = fs.readFileSync(path.resolve(__dirname, '../../lib/agreement/form-rows.ts'), 'utf8');
    expect(source).toMatch(/import\s*\{[^}]*\bmodifiedPersonnel\b[^}]*\}\s*from\s*'@\/lib\/budget-plan'/);
    expect(source).toMatch(/modifiedPersonnel\(y\.totals\)/);
  });
});
