// lib/agreement 8-2 칸 편집 해석 + 보내기 정부지원 현금 (SOT §6.19 AG-3 편집, §5.21 AV-6 ④, 계획서 S-12·S-4).
// 숫자는 계획서 합성 픽스처(버전 A = Phase 24 S-20)에서 출발한다.

import { describe, expect, it } from 'vitest';
import type { CellEditLine } from '@/lib/agreement/cell-edit';
import { resolveFormCellEdit, type FormCellEditTarget } from '@/lib/agreement/form-edit';
import { buildBaselineFromPlan, type PlanItemInput } from '@/lib/agreement/from-plan';
import { ATTACHMENT4_FORM_ROWS } from '@/lib/constants';
import type { Attachment4RowId, BudgetCategory, DetailAxis } from '@/types';

let seq = 0;
function line(yearId: string, category: BudgetCategory, sub: string, axis: DetailAxis, amount: number, id?: string): CellEditLine {
  seq += 1;
  return { id: id ?? `L${seq}`, yearId, category, subcategoryCode: sub, axis, amount };
}

/** 버전 A(S-20) */
const VERSION_A: CellEditLine[] = [
  line('Y1', 'personnel', 'personnel_internal', 'cash', 30_000_000, 'a-int-cash'),
  line('Y1', 'personnel', 'personnel_internal', 'in_kind', 10_000_000, 'a-int-kind'),
  line('Y1', 'material', 'material_purchase', 'cash', 5_000_000, 'a-mat'),
  line('Y1', 'activity', 'activity_meeting', 'cash', 1_200_000, 'a-act-meet'),
  line('Y1', 'activity', 'activity_travel_dom', 'cash', 800_000, 'a-act-travel'),
  line('Y1', 'allowance', 'default', 'cash', 3_000_000, 'a-allow'),
  line('Y1', 'indirect', 'indirect_hr', 'cash', 2_500_000, 'a-ind'),
  line('Y2', 'personnel', 'personnel_internal', 'cash', 32_000_000, 'a2-int-cash'),
  line('Y2', 'personnel', 'personnel_internal', 'in_kind', 10_000_000, 'a2-int-kind'),
  line('Y2', 'material', 'material_purchase', 'cash', 4_000_000, 'a2-mat'),
  line('Y2', 'activity', 'activity_meeting', 'cash', 1_000_000, 'a2-act'),
  line('Y2', 'allowance', 'default', 'cash', 3_000_000, 'a2-allow'),
  line('Y2', 'indirect', 'indirect_hr', 'cash', 2_700_000, 'a2-ind'),
];

const edit = (lines: readonly CellEditLine[], target: FormCellEditTarget) => resolveFormCellEdit(lines, target);
const t = (rowId: Attachment4RowId, axis: DetailAxis | null, amount: number, yearId = 'Y1'): FormCellEditTarget => ({
  yearId,
  rowId,
  axis,
  amount,
});

describe('A·B 현금/현물 — (세목, 축) 줄 정확히', () => {
  it('A 현금: personnel_internal 현금 줄 update', () => {
    expect(edit(VERSION_A, t('personnel_internal', 'cash', 35_000_000))).toEqual({
      kind: 'update', lineId: 'a-int-cash', amount: 35_000_000,
    });
  });

  it('A 현물: 같은 금액이면 noop', () => {
    expect(edit(VERSION_A, t('personnel_internal', 'in_kind', 10_000_000))).toEqual({ kind: 'noop' });
  });

  it('A 0도 저장 — update 금액 0', () => {
    expect(edit(VERSION_A, t('personnel_internal', 'cash', 0))).toEqual({ kind: 'update', lineId: 'a-int-cash', amount: 0 });
  });

  it('A: 세목 미지정 인건비 같은 축 금액을 빼고 personnel_internal 줄을 고친다(default 줄은 그대로)', () => {
    const lines = [...VERSION_A, line('Y1', 'personnel', 'default', 'cash', 2_000_000, 'p-def')];
    // 보기 A 현금 = 30,000,000 + 2,000,000 = 32,000,000 → 33,000,000 입력 → internal 31,000,000
    expect(edit(lines, t('personnel_internal', 'cash', 33_000_000))).toEqual({
      kind: 'update', lineId: 'a-int-cash', amount: 31_000_000,
    });
    // 다른 축의 default는 빼지 않는다
    expect(edit(lines, t('personnel_internal', 'in_kind', 12_000_000))).toEqual({
      kind: 'update', lineId: 'a-int-kind', amount: 12_000_000,
    });
  });

  it('A: 입력 < 세목 미지정 금액이면 below_fixed_part', () => {
    const lines = [...VERSION_A, line('Y1', 'personnel', 'default', 'cash', 2_000_000)];
    const r = edit(lines, t('personnel_internal', 'cash', 1_999_999));
    expect(r.kind === 'reject' && r.reason).toBe('below_fixed_part');
    expect(r.kind === 'reject' && r.message).toContain('세목 미지정 인건비 2,000,000원');
  });

  it('A: internal 줄 없고 default만 있으면 차액으로 internal insert (입력 = default면 0 insert)', () => {
    const lines = [line('Y1', 'personnel', 'default', 'cash', 2_000_000)];
    expect(edit(lines, t('personnel_internal', 'cash', 5_000_000))).toEqual({
      kind: 'insert',
      line: { yearId: 'Y1', category: 'personnel', subcategoryCode: 'personnel_internal', axis: 'cash', amount: 3_000_000 },
    });
    expect(edit(lines, t('personnel_internal', 'cash', 2_000_000))).toEqual({
      kind: 'insert',
      line: { yearId: 'Y1', category: 'personnel', subcategoryCode: 'personnel_internal', axis: 'cash', amount: 0 },
    });
  });

  it('B 현물: 줄 없음 → insert(0도 insert), 다른 세목 줄과 섞이지 않는다', () => {
    expect(edit(VERSION_A, t('personnel_external', 'in_kind', 4_000_000))).toEqual({
      kind: 'insert',
      line: { yearId: 'Y1', category: 'personnel', subcategoryCode: 'personnel_external', axis: 'in_kind', amount: 4_000_000 },
    });
    expect(edit(VERSION_A, t('personnel_external', 'cash', 0))).toEqual({
      kind: 'insert',
      line: { yearId: 'Y1', category: 'personnel', subcategoryCode: 'personnel_external', axis: 'cash', amount: 0 },
    });
  });

  it('B: 기존 줄 update, 연차 구분', () => {
    const lines = [...VERSION_A, line('Y2', 'personnel', 'personnel_external', 'cash', 1_000_000, 'ext2')];
    expect(edit(lines, t('personnel_external', 'cash', 1_500_000, 'Y2'))).toEqual({ kind: 'update', lineId: 'ext2', amount: 1_500_000 });
    expect(edit(lines, t('personnel_external', 'cash', 1_500_000, 'Y1')).kind).toBe('insert');
  });

  it('같은 세목·축 줄이 둘이면 손상으로 throw', () => {
    const lines = [line('Y1', 'personnel', 'personnel_external', 'cash', 1), line('Y1', 'personnel', 'personnel_external', 'cash', 2)];
    expect(() => edit(lines, t('personnel_external', 'cash', 5))).toThrow(/손상/);
  });
});

describe('C·D 일반·D 통합관리 — 현금 줄 목표 = 입력 − 현물', () => {
  it('C: 현물 1,000,000이 있으면 4,000,000 입력 → personnel_support 현금 3,000,000 insert', () => {
    const lines = [...VERSION_A, line('Y1', 'personnel', 'personnel_support', 'in_kind', 1_000_000)];
    expect(edit(lines, t('personnel_support', null, 4_000_000))).toEqual({
      kind: 'insert',
      line: { yearId: 'Y1', category: 'personnel', subcategoryCode: 'personnel_support', axis: 'cash', amount: 3_000_000 },
    });
  });

  it('C: 현금 줄이 있으면 update, 입력 = 현물이면 현금 0', () => {
    const lines = [
      line('Y1', 'personnel', 'personnel_support', 'cash', 4_000_000, 'sup-c'),
      line('Y1', 'personnel', 'personnel_support', 'in_kind', 1_000_000, 'sup-k'),
    ];
    expect(edit(lines, t('personnel_support', null, 1_000_000))).toEqual({ kind: 'update', lineId: 'sup-c', amount: 0 });
    expect(edit(lines, t('personnel_support', null, 5_000_000))).toEqual({ kind: 'noop' });
  });

  it('C: 입력 < 현물이면 below_fixed_part', () => {
    const lines = [line('Y1', 'personnel', 'personnel_support', 'in_kind', 1_000_000)];
    const r = edit(lines, t('personnel_support', null, 999_999));
    expect(r.kind === 'reject' && r.reason).toBe('below_fixed_part');
  });

  it('C: 다른 인건비 세목 현물은 빼지 않는다', () => {
    // 버전 A Y1 personnel_internal 현물 10,000,000이 있어도 C 목표에 영향 없음
    expect(edit(VERSION_A, t('personnel_support', null, 4_000_000))).toEqual({
      kind: 'insert',
      line: { yearId: 'Y1', category: 'personnel', subcategoryCode: 'personnel_support', axis: 'cash', amount: 4_000_000 },
    });
  });

  it('D 일반: 현물 + 세목 미지정 학생인건비(현금·현물)를 뺀다', () => {
    const lines = [
      line('Y1', 'student_personnel', 'student_general', 'cash', 2_000_000, 'sg-c'),
      line('Y1', 'student_personnel', 'student_general', 'in_kind', 1_000_000),
      line('Y1', 'student_personnel', 'default', 'cash', 500_000),
      line('Y1', 'student_personnel', 'default', 'in_kind', 300_000),
      line('Y1', 'student_personnel', 'student_managed', 'in_kind', 9_000_000),
    ];
    // 보기 D 일반 = 2,000,000 + 1,000,000 + 500,000 + 300,000 = 3,800,000 → 5,000,000 입력 → 현금 3,200,000
    expect(edit(lines, t('student_general', null, 5_000_000))).toEqual({ kind: 'update', lineId: 'sg-c', amount: 3_200_000 });
    expect(edit(lines, t('student_general', null, 3_800_000))).toEqual({ kind: 'noop' });
    const r = edit(lines, t('student_general', null, 1_799_999));
    expect(r.kind === 'reject' && r.reason).toBe('below_fixed_part');
    expect(r.kind === 'reject' && r.message).toContain('1,800,000원');
  });

  it('D 통합관리: student_managed 현물만 뺀다, 줄 없으면 insert', () => {
    const lines = [
      line('Y1', 'student_personnel', 'student_managed', 'in_kind', 600_000),
      line('Y1', 'student_personnel', 'default', 'cash', 500_000),
    ];
    expect(edit(lines, t('student_managed', null, 1_000_000))).toEqual({
      kind: 'insert',
      line: { yearId: 'Y1', category: 'student_personnel', subcategoryCode: 'student_managed', axis: 'cash', amount: 400_000 },
    });
    const r = edit(lines, t('student_managed', null, 599_999));
    expect(r.kind === 'reject' && r.reason).toBe('below_fixed_part');
  });
});

describe('F·G — resolveCellEdit(default 흡수)', () => {
  it('G 현금: 줄 1개 → 그 줄', () => {
    expect(edit(VERSION_A, t('material', 'cash', 6_000_000))).toEqual({ kind: 'update', lineId: 'a-mat', amount: 6_000_000 });
  });

  it('G 현금: 세목 줄 2개 → default insert, 초과면 exceeds_target', () => {
    const lines = [...VERSION_A, line('Y1', 'material', 'material_test', 'cash', 1_000_000)];
    expect(edit(lines, t('material', 'cash', 7_000_000))).toEqual({
      kind: 'insert',
      line: { yearId: 'Y1', category: 'material', subcategoryCode: 'default', axis: 'cash', amount: 1_000_000 },
    });
    const r = edit(lines, t('material', 'cash', 5_999_999));
    expect(r.kind === 'reject' && r.reason).toBe('exceeds_target');
  });

  it('F 현물: 줄 없음 → default insert(0도)', () => {
    expect(edit(VERSION_A, t('facility_equipment', 'in_kind', 0))).toEqual({
      kind: 'insert',
      line: { yearId: 'Y1', category: 'facility_equipment', subcategoryCode: 'default', axis: 'in_kind', amount: 0 },
    });
  });

  it('F: 같은 금액 update는 noop', () => {
    const lines = [line('Y1', 'facility_equipment', 'facility_purchase', 'cash', 7_000_000)];
    expect(edit(lines, t('facility_equipment', 'cash', 7_000_000))).toEqual({ kind: 'noop' });
  });
});

describe('I·L — 현금 셀 목표 = 입력 − 그 비목 현물(전 세목)', () => {
  it('I: 현물 없음 → allowance 현금 줄', () => {
    expect(edit(VERSION_A, t('allowance', null, 3_500_000))).toEqual({ kind: 'update', lineId: 'a-allow', amount: 3_500_000 });
  });

  it('I: 현물 500,000 → 현금 목표 3,000,000 = noop', () => {
    const lines = [...VERSION_A, line('Y1', 'allowance', 'default', 'in_kind', 500_000)];
    expect(edit(lines, t('allowance', null, 3_500_000))).toEqual({ kind: 'noop' });
    const r = edit(lines, t('allowance', null, 499_999));
    expect(r.kind === 'reject' && r.reason).toBe('below_fixed_part');
  });

  it('L: 여러 세목 현물 합을 빼고 현금 셀은 default 흡수', () => {
    const lines = [
      ...VERSION_A,
      line('Y1', 'indirect', 'indirect_support', 'cash', 500_000),
      line('Y1', 'indirect', 'indirect_hr', 'in_kind', 200_000),
      line('Y1', 'indirect', 'indirect_support', 'in_kind', 100_000),
    ];
    // 현금 셀 목표 = 4,000,000 − 300,000 = 3,700,000, 세목 현금 3,000,000 → default 700,000
    expect(edit(lines, t('indirect', null, 4_000_000))).toEqual({
      kind: 'insert',
      line: { yearId: 'Y1', category: 'indirect', subcategoryCode: 'default', axis: 'cash', amount: 700_000 },
    });
  });

  it('L: 버전 A Y2 단일 줄 update', () => {
    expect(edit(VERSION_A, t('indirect', null, 2_900_000, 'Y2'))).toEqual({ kind: 'update', lineId: 'a2-ind', amount: 2_900_000 });
  });
});

describe('H — activity 셀 목표 = 입력 − 그 연차·축 promotion 합', () => {
  // 픽스처 promotion(U-1): Y2 promotion/default 현금 400,000 → 보기 H Y2 현금 1,400,000
  const lines = [...VERSION_A, line('Y2', 'promotion', 'default', 'cash', 400_000, 'promo2')];

  it('H Y2 현금 1,500,000 → activity 현금 1,100,000 (줄 1개 update)', () => {
    expect(edit(lines, t('activity', 'cash', 1_500_000, 'Y2'))).toEqual({ kind: 'update', lineId: 'a2-act', amount: 1_100_000 });
  });

  it('H Y2 현금 그대로 1,400,000 → noop', () => {
    expect(edit(lines, t('activity', 'cash', 1_400_000, 'Y2'))).toEqual({ kind: 'noop' });
  });

  it('H Y2 현금 < promotion → below_fixed_part', () => {
    const r = edit(lines, t('activity', 'cash', 399_999, 'Y2'));
    expect(r.kind === 'reject' && r.reason).toBe('below_fixed_part');
    expect(r.kind === 'reject' && r.message).toContain('연구과제추진비 400,000원');
  });

  it('H 현물: 다른 축 promotion은 빼지 않는다 → activity default insert', () => {
    expect(edit(lines, t('activity', 'in_kind', 300_000, 'Y2'))).toEqual({
      kind: 'insert',
      line: { yearId: 'Y2', category: 'activity', subcategoryCode: 'default', axis: 'in_kind', amount: 300_000 },
    });
  });

  it('H Y1: activity 세목 줄 2개 → default 흡수, 세목 합 초과면 exceeds_target', () => {
    expect(edit(lines, t('activity', 'cash', 2_500_000))).toEqual({
      kind: 'insert',
      line: { yearId: 'Y1', category: 'activity', subcategoryCode: 'default', axis: 'cash', amount: 500_000 },
    });
    const r = edit(lines, t('activity', 'cash', 1_999_999));
    expect(r.kind === 'reject' && r.reason).toBe('exceeds_target');
  });
});

describe('편집 불가 칸 · 금액 검증', () => {
  const nonData = ATTACHMENT4_FORM_ROWS.filter((r) => r.kind !== 'data').map((r) => r.id);

  it.each([...nonData, 'outside' as const])('%s 행은 not_editable', (rowId) => {
    for (const axis of [null, 'cash'] as const) {
      const r = edit(VERSION_A, t(rowId, axis, 1_000));
      expect(r.kind === 'reject' && r.reason).toBe('not_editable');
    }
  });

  it('집계·비율·내역·무시 행이 모두 포함됐다', () => {
    expect(nonData).toEqual(expect.arrayContaining([
      'personnel_subtotal', 'total_personnel', 'modified_personnel', 'facility_integrated_mgmt',
      'allowance_ratio', 'direct_subtotal', 'lab_safety', 'indirect_ratio', 'total', 'personnel_ratio',
    ]));
  });

  it('split 행에 축 없음 / combined 행에 축 지정은 not_editable', () => {
    for (const rowId of ['personnel_internal', 'personnel_external', 'facility_equipment', 'material', 'activity'] as const) {
      const r = edit(VERSION_A, t(rowId, null, 1_000));
      expect(r.kind === 'reject' && r.reason).toBe('not_editable');
    }
    for (const rowId of ['personnel_support', 'student_general', 'student_managed', 'allowance', 'indirect'] as const) {
      const r = edit(VERSION_A, t(rowId, 'cash', 1_000));
      expect(r.kind === 'reject' && r.reason).toBe('not_editable');
    }
  });

  it.each([-1, 1.5, Number.NaN, Number.MAX_SAFE_INTEGER + 1])('금액 %s → invalid_amount', (amount) => {
    const r = edit(VERSION_A, t('personnel_internal', 'cash', amount));
    expect(r.kind === 'reject' && r.reason).toBe('invalid_amount');
  });

  it('모든 data 행(양식 밖 제외)에 분기가 있다 — throw하지 않는다', () => {
    for (const row of ATTACHMENT4_FORM_ROWS) {
      if (row.kind !== 'data' || row.id === 'outside') continue;
      const axis = row.axes === 'split' ? 'cash' : null;
      expect(() => edit(VERSION_A, t(row.id, axis, 10_000_000))).not.toThrow();
    }
  });
});

describe('buildBaselineFromPlan — 정부지원 현금(AV-6 ④)', () => {
  const items: PlanItemInput[] = [
    { yearId: 'Y1', category: 'material', plannedAmount: 5_000_000, cashAmount: 5_000_000, inKindAmount: 0 },
  ];

  it('제안 Y1 35,000,000 · Y2 null → {Y1: 35,000,000}', () => {
    const r = buildBaselineFromPlan({
      items,
      details: [],
      members: [],
      years: [
        { id: 'Y2', name: '2차년도', order: 1, govSupportCash: null },
        { id: 'Y1', name: '1차년도', order: 0, govSupportCash: 35_000_000 },
      ],
    });
    if (!r.ok) throw new Error('보내기 실패');
    expect(r.govCash).toEqual({ Y1: 35_000_000 });
  });

  it('0은 입력값 — 키가 남는다, 연차 order 순', () => {
    const r = buildBaselineFromPlan({
      items,
      details: [],
      members: [],
      years: [
        { id: 'Y2', name: '2차년도', order: 1, govSupportCash: 30_000_000 },
        { id: 'Y1', name: '1차년도', order: 0, govSupportCash: 0 },
      ],
    });
    if (!r.ok) throw new Error('보내기 실패');
    expect(r.govCash).toEqual({ Y1: 0, Y2: 30_000_000 });
    expect(Object.keys(r.govCash)).toEqual(['Y1', 'Y2']);
  });

  it('govSupportCash 생략(Phase 24 입력 형태) = 미입력 → 빈 객체', () => {
    const r = buildBaselineFromPlan({ items, details: [], members: [], years: [{ id: 'Y1', name: '1차년도', order: 0 }] });
    if (!r.ok) throw new Error('보내기 실패');
    expect(r.govCash).toEqual({});
  });

  it('음수·비정수는 손상으로 throw', () => {
    for (const bad of [-1, 1.5]) {
      expect(() =>
        buildBaselineFromPlan({ items, details: [], members: [], years: [{ id: 'Y1', name: '1차년도', order: 0, govSupportCash: bad }] })
      ).toThrow(/손상/);
    }
  });
});
