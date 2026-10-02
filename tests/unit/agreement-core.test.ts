// lib/agreement A — 버전 판정·비목별 보기·셀 편집·보내기 매핑 (SOT §5.21 AV-1·AV-3·AV-5·AV-6·AV-8, §6.19 AG-2).
// 숫자는 계획서 S-20 합성 픽스처 그대로다(부록 B에 협약 예산 예시가 없다) — 안 맞으면 구현이 틀린 것이다.

import { describe, expect, it } from 'vitest';
import { buildCategoryView, categoryViewTable, type CategoryViewLine } from '@/lib/agreement/category-view';
import { resolveCellEdit, type CellEditLine } from '@/lib/agreement/cell-edit';
import { buildBaselineFromPlan, type PlanDetailInput, type PlanItemInput } from '@/lib/agreement/from-plan';
import { assertTableModel, toTsv } from '@/lib/agreement/table';
import {
  baseVersionId,
  baseVersionIds,
  canUnconfirm,
  currentVersionId,
  draftVersionId,
  suggestNextVersionMeta,
  type VersionRef,
} from '@/lib/agreement/versions';
import type { BudgetCategory, DetailAxis, DetailFactor } from '@/types';

const YEARS = [
  { id: 'Y2', name: '2차년도', order: 1 },
  { id: 'Y1', name: '1차년도', order: 0 },
];

// ─── S-20 버전 A ──────────────────────────────────────────────────────────────

function line(yearId: string, category: BudgetCategory, sub: string, axis: DetailAxis, amount: number): CategoryViewLine {
  return { yearId, category, subcategoryCode: sub, axis, amount };
}

const VERSION_A: CategoryViewLine[] = [
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

/** S-20 버전 B = A 복제 후 5곳 수정 */
function versionB(): CellEditLine[] {
  const b = VERSION_A.map((l, i) => ({ ...l, id: `b${i}` }))
    .filter((l) => !(l.yearId === 'Y1' && l.subcategoryCode === 'activity_travel_dom'))
    .map((l) => {
      if (l.subcategoryCode === 'material_purchase') return { ...l, amount: l.yearId === 'Y1' ? 3_000_000 : 6_000_000 };
      if (l.yearId === 'Y2' && l.subcategoryCode === 'indirect_hr') return { ...l, amount: 2_900_000 };
      return l;
    });
  b.push({ id: 'b-intl', yearId: 'Y2', category: 'activity', subcategoryCode: 'activity_travel_intl', axis: 'cash', amount: 500_000 });
  return b;
}

describe('비목별 보기 (AG-2) — S-20 버전 A', () => {
  const view = buildCategoryView(VERSION_A, YEARS);
  const row = (c: BudgetCategory) => view.rows.find((r) => r.category === c)!;

  it('연차는 order 순, 비목은 부록 A.1 순서 12행', () => {
    expect(view.years.map((y) => y.id)).toEqual(['Y1', 'Y2']);
    expect(view.rows.map((r) => r.category)).toEqual([
      'personnel', 'student_personnel', 'facility_equipment', 'material', 'consignment', 'international',
      'burden', 'activity', 'promotion', 'allowance', 'indirect', 'other',
    ]);
    expect(row('activity').label).toBe('연구활동비');
  });

  it('연차 합계·총계', () => {
    expect(view.yearTotals).toEqual([
      { cash: 42_500_000, inKind: 10_000_000, total: 52_500_000 },
      { cash: 42_700_000, inKind: 10_000_000, total: 52_700_000 },
    ]);
    expect(view.grandTotal).toEqual({ cash: 85_200_000, inKind: 20_000_000, total: 105_200_000 });
  });

  it('비목 총계', () => {
    expect(row('personnel').total.total).toBe(82_000_000);
    expect(row('material').total.total).toBe(9_000_000);
    expect(row('activity').total.total).toBe(3_000_000);
    expect(row('allowance').total.total).toBe(6_000_000);
    expect(row('indirect').total.total).toBe(5_200_000);
  });

  it('줄이 없는 칸은 null — 금액 0과 구별된다', () => {
    expect(row('promotion').byYear[0]).toEqual({ cash: null, inKind: null, total: null });
    expect(row('promotion').total).toEqual({ cash: null, inKind: null, total: null });
    expect(row('material').byYear[0]).toEqual({ cash: 5_000_000, inKind: null, total: 5_000_000 });
    const zero = buildCategoryView([line('Y1', 'promotion', 'default', 'cash', 0)], YEARS);
    expect(zero.rows.find((r) => r.category === 'promotion')!.byYear[0]).toEqual({ cash: 0, inKind: null, total: 0 });
    expect(zero.yearTotals[1]).toEqual({ cash: null, inKind: null, total: null });
  });

  it('줄이 없는 버전 — 전부 null(0 매트릭스가 아니다)', () => {
    const empty = buildCategoryView([], YEARS);
    expect(empty.grandTotal).toEqual({ cash: null, inKind: null, total: null });
    expect(empty.rows.every((r) => r.total.total === null)).toBe(true);
  });

  it('연차 밖·중복·음수·소수 줄은 던진다', () => {
    expect(() => buildCategoryView([line('Y9', 'material', 'default', 'cash', 1)], YEARS)).toThrow(/연차/);
    expect(() =>
      buildCategoryView([line('Y1', 'material', 'default', 'cash', 1), line('Y1', 'material', 'default', 'cash', 2)], YEARS)
    ).toThrow(/두 개/);
    expect(() => buildCategoryView([line('Y1', 'material', 'default', 'cash', -1)], YEARS)).toThrow(/정수/);
    expect(() => buildCategoryView([line('Y1', 'material', 'default', 'cash', 1.5)], YEARS)).toThrow(/정수/);
  });

  it('표 모델 — 헤더·합계 행·빈 칸, sum이 항들과 맞는다', () => {
    const table = categoryViewTable(view, '협약 예산 비목별');
    expect(() => assertTableModel(table)).not.toThrow();
    expect(table.columns.map((c) => c.label)).toEqual([
      '비목', '1차년도 현금', '1차년도 현물', '1차년도 계', '2차년도 현금', '2차년도 현물', '2차년도 계',
      '총계 현금', '총계 현물', '총계 계',
    ]);
    expect(table.rows).toHaveLength(13);
    expect(table.rows[12]!.kind).toBe('total');
    const tsv = toTsv(table).split('\r\n');
    expect(tsv[1]).toBe('인건비\t30000000\t10000000\t40000000\t32000000\t10000000\t42000000\t62000000\t20000000\t82000000');
    expect(tsv[2]).toBe('학생인건비\t\t\t\t\t\t\t\t\t');
    expect(tsv[13]).toBe('합계\t42500000\t10000000\t52500000\t42700000\t10000000\t52700000\t85200000\t20000000\t105200000');
  });

  it('표 모델 — 연차가 없어도 모순 없다', () => {
    const table = categoryViewTable(buildCategoryView([], []), '빈');
    expect(() => assertTableModel(table)).not.toThrow();
    expect(table.columns).toHaveLength(4);
  });

  it('버전 B 총계 — 105,100,000 (Y1 49,700,000 / Y2 55,400,000)', () => {
    const vb = buildCategoryView(versionB(), YEARS);
    expect(vb.yearTotals.map((t) => t.total)).toEqual([49_700_000, 55_400_000]);
    expect(vb.grandTotal.total).toBe(105_100_000);
  });
});

// ─── 셀 편집 (S-10) ───────────────────────────────────────────────────────────

describe('resolveCellEdit (AG-2) — S-20 셀 편집 5건을 순서대로', () => {
  let lines = versionB();
  const apply = (r: ReturnType<typeof resolveCellEdit>): void => {
    if (r.kind === 'update') lines = lines.map((l) => (l.id === r.lineId ? { ...l, amount: r.amount } : l));
    else if (r.kind === 'insert') lines = [...lines, { ...r.line, id: `new${lines.length}` }];
  };
  const activityY2 = { yearId: 'Y2', category: 'activity' as const, axis: 'cash' as const };
  const cellSum = () =>
    lines.filter((l) => l.yearId === 'Y2' && l.category === 'activity' && l.axis === 'cash').reduce((s, l) => s + l.amount, 0);

  it('① 줄 2개 셀 → 2,000,000: default 500,000 신설', () => {
    const r = resolveCellEdit(lines, activityY2, 2_000_000);
    expect(r).toEqual({
      kind: 'insert',
      line: { yearId: 'Y2', category: 'activity', subcategoryCode: 'default', axis: 'cash', amount: 500_000 },
    });
    apply(r);
    expect(cellSum()).toBe(2_000_000);
  });

  it('② 같은 셀 → 1,700,000: default 200,000 (다른 세목 줄은 그대로)', () => {
    const def = lines.find((l) => l.yearId === 'Y2' && l.category === 'activity' && l.subcategoryCode === 'default')!;
    const r = resolveCellEdit(lines, activityY2, 1_700_000);
    expect(r).toEqual({ kind: 'update', lineId: def.id, amount: 200_000 });
    apply(r);
    expect(lines.find((l) => l.id === 'b-intl')!.amount).toBe(500_000);
    expect(cellSum()).toBe(1_700_000);
  });

  it('③ 같은 셀 → 1,400,000: reject (default −100,000)', () => {
    const r = resolveCellEdit(lines, activityY2, 1_400_000);
    expect(r.kind).toBe('reject');
    if (r.kind === 'reject') {
      expect(r.reason).toBe('exceeds_target');
      expect(r.message).toContain('세목 줄 합계가 이미 목표보다 큽니다');
    }
  });

  it('④ Y1 재료비 현금(줄 1개) → 3,500,000: 그 줄 갱신', () => {
    const target = lines.find((l) => l.yearId === 'Y1' && l.subcategoryCode === 'material_purchase')!;
    expect(resolveCellEdit(lines, { yearId: 'Y1', category: 'material', axis: 'cash' }, 3_500_000)).toEqual({
      kind: 'update',
      lineId: target.id,
      amount: 3_500_000,
    });
  });

  it('⑤ Y1 연구과제추진비 현금(줄 0개) → 400,000: promotion/default 신설', () => {
    expect(resolveCellEdit(lines, { yearId: 'Y1', category: 'promotion', axis: 'cash' }, 400_000)).toEqual({
      kind: 'insert',
      line: { yearId: 'Y1', category: 'promotion', subcategoryCode: 'default', axis: 'cash', amount: 400_000 },
    });
  });

  it('0으로 낮춘 default 줄은 지우지 않고 금액 0 update', () => {
    const r = resolveCellEdit(lines, activityY2, 1_500_000);
    expect(r.kind).toBe('update');
    if (r.kind === 'update') expect(r.amount).toBe(0);
  });

  it('줄 1개 셀이 default여도 그 줄을 바꾼다 · 축이 다른 줄은 셀에 안 든다', () => {
    const ls: CellEditLine[] = [
      { id: 'a', yearId: 'Y1', category: 'personnel', subcategoryCode: 'personnel_internal', axis: 'cash', amount: 5 },
      { id: 'b', yearId: 'Y1', category: 'personnel', subcategoryCode: 'personnel_internal', axis: 'in_kind', amount: 7 },
    ];
    expect(resolveCellEdit(ls, { yearId: 'Y1', category: 'personnel', axis: 'in_kind' }, 3)).toEqual({
      kind: 'update',
      lineId: 'b',
      amount: 3,
    });
  });

  it('음수·소수 금액은 reject', () => {
    expect(resolveCellEdit(lines, activityY2, -1)).toMatchObject({ kind: 'reject', reason: 'invalid_amount' });
    expect(resolveCellEdit(lines, activityY2, 1.5)).toMatchObject({ kind: 'reject', reason: 'invalid_amount' });
  });
});

// ─── 버전 판정 (AV-3·AV-5·AV-8, Q1) ─────────────────────────────────────────

function v(id: string, kind: VersionRef['kind'], status: VersionRef['status'], order: number): VersionRef {
  return { id, kind, status, order };
}

describe('현재·작성 중·기준 버전 — S-20 버전 판정', () => {
  const four = [
    v('v1', 'selection', 'confirmed', 1),
    v('v2', 'final', 'confirmed', 2),
    v('v3', 'amendment', 'confirmed', 3),
    v('v4', 'amendment', 'draft', 4),
  ];

  it('4버전: 현재 v3, 작성 중 v4, base(v4)=v2, base(v3)=v2, base(v2)=v1, base(v1)=없음', () => {
    expect(currentVersionId(four)).toBe('v3');
    expect(draftVersionId(four)).toBe('v4');
    expect(baseVersionIds(four)).toEqual({ v1: null, v2: 'v1', v3: 'v2', v4: 'v2' });
    for (const x of four) expect(canUnconfirm(four, x.id)).toBe(false);
  });

  const withoutV2 = four.filter((x) => x.id !== 'v2');

  it('v2(최종협약본) 삭제: base(v4)=v3, base(v3)=v1, base(v1)=없음, 현재 v3, order 1·3·4 그대로', () => {
    expect(baseVersionId(withoutV2, 'v4')).toBe('v3');
    expect(baseVersionId(withoutV2, 'v3')).toBe('v1');
    expect(baseVersionId(withoutV2, 'v1')).toBeNull();
    expect(currentVersionId(withoutV2)).toBe('v3');
    expect(withoutV2.map((x) => x.order)).toEqual([1, 3, 4]);
  });

  it('다시 v4 삭제: canUnconfirm(v3)만 true', () => {
    const two = withoutV2.filter((x) => x.id !== 'v4');
    expect(canUnconfirm(two, 'v3')).toBe(true);
    expect(canUnconfirm(two, 'v1')).toBe(false);
    expect(draftVersionId(two)).toBeNull();
  });

  it('작성 중 하나만: 현재 = 그 작성 중 버전, 기준 없음', () => {
    const only = [v('v1', 'selection', 'draft', 1)];
    expect(currentVersionId(only)).toBe('v1');
    expect(draftVersionId(only)).toBe('v1');
    expect(baseVersionId(only, 'v1')).toBeNull();
    expect(canUnconfirm(only, 'v1')).toBe(false);
  });

  it('버전 없음: 현재·작성 중 모두 없음', () => {
    expect(currentVersionId([])).toBeNull();
    expect(draftVersionId([])).toBeNull();
    expect(baseVersionIds([])).toEqual({});
  });

  it('final 둘: base(v3)=v2(최근 final), base(v2)=v1', () => {
    const finals = [v('v1', 'final', 'confirmed', 1), v('v2', 'final', 'confirmed', 2), v('v3', 'amendment', 'draft', 3)];
    expect(baseVersionId(finals, 'v3')).toBe('v2');
    expect(baseVersionId(finals, 'v2')).toBe('v1');
  });

  it('종류 변경: v2를 지운 목록에서 v1을 final로 → base(v4)=v1, base(v3)=v1', () => {
    const changed = withoutV2.map((x) => (x.id === 'v1' ? { ...x, kind: 'final' as const } : x));
    expect(baseVersionId(changed, 'v4')).toBe('v1');
    expect(baseVersionId(changed, 'v3')).toBe('v1');
  });

  it('기준은 항상 앞선 확정 버전 — 작성 중 final·뒤의 final은 기준이 아니다', () => {
    const list = [
      v('v1', 'selection', 'confirmed', 1),
      v('v2', 'amendment', 'confirmed', 2),
      v('v3', 'final', 'confirmed', 3),
    ];
    expect(baseVersionId(list, 'v2')).toBe('v1');
    const draftFinal = [v('v1', 'selection', 'confirmed', 1), v('v2', 'final', 'draft', 2)];
    expect(baseVersionId(draftFinal, 'v2')).toBe('v1');
  });

  it('입력 순서와 무관하다', () => {
    expect(baseVersionIds([...four].reverse())).toEqual({ v1: null, v2: 'v1', v3: 'v2', v4: 'v2' });
    expect(currentVersionId([...four].reverse())).toBe('v3');
  });

  it('확정 버전 없이 작성 중이 마지막: canUnconfirm 전부 false', () => {
    const list = [v('v1', 'selection', 'confirmed', 1), v('v2', 'adjustment', 'draft', 2)];
    expect(canUnconfirm(list, 'v1')).toBe(false);
    expect(canUnconfirm(list, 'v2')).toBe(false);
  });

  it('손상된 목록(작성 중 2개·순번 중복)·없는 id는 던진다', () => {
    expect(() => currentVersionId([v('a', 'selection', 'draft', 1), v('b', 'selection', 'draft', 2)])).toThrow(/작성 중/);
    expect(() => currentVersionId([v('a', 'selection', 'confirmed', 1), v('b', 'selection', 'draft', 1)])).toThrow(/순번/);
    expect(() => baseVersionId(four, 'zz')).toThrow(/찾을 수 없습니다/);
  });
});

describe('suggestNextVersionMeta (AV-1, S-22)', () => {
  it('없음 → 선정평가본', () => {
    expect(suggestNextVersionMeta([])).toEqual({ kind: 'selection', name: '선정평가본' });
  });
  it('selection → 조정회의본', () => {
    expect(suggestNextVersionMeta([v('a', 'selection', 'confirmed', 1)])).toEqual({ kind: 'adjustment', name: '조정회의본' });
  });
  it('adjustment → 최종협약본', () => {
    expect(
      suggestNextVersionMeta([v('a', 'selection', 'confirmed', 1), v('b', 'adjustment', 'confirmed', 2)])
    ).toEqual({ kind: 'final', name: '최종협약본' });
  });
  it('final → 협약변경 1차, amendment → 협약변경 N차(협약변경 수 + 1)', () => {
    const base = [v('a', 'selection', 'confirmed', 1), v('b', 'final', 'confirmed', 3)];
    expect(suggestNextVersionMeta(base)).toEqual({ kind: 'amendment', name: '협약변경 1차' });
    const two = [...base, v('c', 'amendment', 'confirmed', 4), v('d', 'amendment', 'confirmed', 5)];
    expect(suggestNextVersionMeta(two)).toEqual({ kind: 'amendment', name: '협약변경 3차' });
  });
  it('마지막 = order 최대(입력 순서 아님)', () => {
    expect(
      suggestNextVersionMeta([v('b', 'adjustment', 'confirmed', 2), v('a', 'selection', 'confirmed', 1)])
    ).toEqual({ kind: 'final', name: '최종협약본' });
  });
});

// ─── 보내기 매핑 (AV-6, S-6, Q2) ─────────────────────────────────────────────

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

/** S-20 보내기: 산출근거로 계산된 셀(인건비·활동비) + 산출근거 없는 셀(재료비·연구수당) */
const PLAN_DETAILS: PlanDetailInput[] = [
  detail({ category: 'personnel', subcategory: 'personnel_internal', formula: 'personnel', memberId: 'M1', factors: PERSONNEL_FACTORS(50, 12), amount: 30_000_000 }),
  detail({ category: 'personnel', subcategory: 'personnel_internal', formula: 'personnel', memberId: 'M2', axis: 'in_kind', factors: PERSONNEL_FACTORS(20, 12), amount: 10_000_000 }),
  detail({ category: 'activity', subcategory: 'activity_meeting', factors: [{ label: '회', value: 12, isPercent: false }], amount: 1_200_000 }),
  detail({ category: 'activity', subcategory: 'activity_travel_dom', factors: [{ label: '횟수', value: 4, isPercent: false }], amount: 800_000 }),
];
const PLAN_ITEMS: PlanItemInput[] = [
  // 산출근거 셀의 budget_items — 현금/현물 칸은 무시되고 산출 행이 쓰인다
  item({ category: 'personnel', plannedAmount: 40_000_000, cashAmount: 30_000_000, inKindAmount: 10_000_000 }),
  item({ category: 'activity', plannedAmount: 2_000_000, cashAmount: 2_000_000, inKindAmount: 0 }),
  item({ category: 'material', plannedAmount: 5_000_000, cashAmount: 5_000_000, inKindAmount: 0 }),
  item({ category: 'allowance', plannedAmount: 3_000_000 }),
];
const PLAN_MEMBERS = [
  { id: 'M1', annualSalary: 60_000_000 },
  { id: 'M2', annualSalary: 50_000_000 },
];

describe('buildBaselineFromPlan (AV-6) — S-20 보내기', () => {
  const result = buildBaselineFromPlan({ items: PLAN_ITEMS, details: PLAN_DETAILS, members: PLAN_MEMBERS, years: YEARS });

  it('금액 줄 6개 — 재료비 material/default 현금, 연구수당 allowance/default 현금', () => {
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.lines).toEqual([
      { yearId: 'Y1', category: 'personnel', subcategoryCode: 'personnel_internal', axis: 'cash', amount: 30_000_000 },
      { yearId: 'Y1', category: 'personnel', subcategoryCode: 'personnel_internal', axis: 'in_kind', amount: 10_000_000 },
      { yearId: 'Y1', category: 'material', subcategoryCode: 'default', axis: 'cash', amount: 5_000_000 },
      { yearId: 'Y1', category: 'activity', subcategoryCode: 'activity_meeting', axis: 'cash', amount: 1_200_000 },
      { yearId: 'Y1', category: 'activity', subcategoryCode: 'activity_travel_dom', axis: 'cash', amount: 800_000 },
      { yearId: 'Y1', category: 'allowance', subcategoryCode: 'default', axis: 'cash', amount: 3_000_000 },
    ]);
    expect(result.items).toEqual([]);
  });

  it('참여인원 2행 — 연봉 스냅샷·참여율·개월·축', () => {
    if (!result.ok) throw new Error('보내기 실패');
    expect(result.participants).toEqual([
      { memberId: 'M1', yearId: 'Y1', participationRate: 50, months: 12, annualSalary: 60_000_000, personnelCash: 30_000_000, personnelInKind: 0, role: '' },
      { memberId: 'M2', yearId: 'Y1', participationRate: 20, months: 12, annualSalary: 50_000_000, personnelCash: 0, personnelInKind: 10_000_000, role: '' },
    ]);
  });

  it('현금 40,000,000(= 37,000,000 + 미분리 3,000,000) · 현물 10,000,000 · 미분리 1건 3,000,000', () => {
    if (!result.ok) throw new Error('보내기 실패');
    expect(result.summary).toEqual({
      lineCount: 6,
      participantCount: 2,
      cashTotal: 40_000_000,
      inKindTotal: 10_000_000,
      unsplit: { count: 1, amount: 3_000_000, cells: [{ yearId: 'Y1', category: 'allowance', amount: 3_000_000 }] },
    });
  });

  it('산출근거 금액은 저장값 그대로 — 재계산하지 않는다', () => {
    const r = buildBaselineFromPlan({
      items: [],
      details: [detail({ category: 'personnel', subcategory: 'personnel_internal', formula: 'personnel', memberId: 'M1', factors: PERSONNEL_FACTORS(50, 12), amount: 30_000_001 })],
      members: PLAN_MEMBERS,
      years: YEARS,
    });
    expect(r.ok && r.lines[0]!.amount).toBe(30_000_001);
    expect(r.ok && r.participants[0]!.personnelCash).toBe(30_000_001);
  });

  it('참여인원 — 개월 인자 없으면 12, 참여율 인자 없으면 100, 인력 미지정은 연봉 null', () => {
    const r = buildBaselineFromPlan({
      items: [],
      details: [
        detail({ category: 'personnel', subcategory: 'personnel_external', formula: 'personnel', memberId: null, factors: [{ label: '참여율(%)', value: 30, isPercent: true }], amount: 1 }),
        detail({ category: 'student_personnel', subcategory: 'student_general', formula: 'personnel', memberId: 'M2', factors: [{ label: '참여기간(월)', value: 6, isPercent: false }], amount: 2 }),
      ],
      members: PLAN_MEMBERS,
      years: YEARS,
    });
    if (!r.ok) throw new Error(JSON.stringify(r.issues));
    expect(r.participants.map((p) => [p.memberId, p.participationRate, p.months, p.annualSalary])).toEqual([
      [null, 30, 12, null],
      ['M2', 100, 6, 50_000_000],
    ]);
  });

  it('산출근거 같은 그룹은 합산 · 0 그룹은 줄 없음', () => {
    const r = buildBaselineFromPlan({
      items: [item({ category: 'promotion', plannedAmount: 0, cashAmount: 0, inKindAmount: 0 }), item({ category: 'burden', plannedAmount: 0 })],
      details: [
        detail({ category: 'activity', subcategory: 'activity_meeting', amount: 100 }),
        detail({ category: 'activity', subcategory: 'activity_meeting', amount: 200 }),
        detail({ category: 'activity', subcategory: 'activity_etc', amount: 5 }),
        detail({ category: 'activity', subcategory: 'activity_etc', amount: -5 }),
      ],
      members: [],
      years: YEARS,
    });
    if (!r.ok) throw new Error(JSON.stringify(r.issues));
    expect(r.lines).toEqual([{ yearId: 'Y1', category: 'activity', subcategoryCode: 'activity_meeting', axis: 'cash', amount: 300 }]);
    expect(r.summary.unsplit.count).toBe(0);
  });

  it('한쪽만 null이고 현금 + 현물 ≠ 계획액이면 위치를 적어 거부', () => {
    const r = buildBaselineFromPlan({
      items: [item({ yearId: 'Y2', category: 'material', plannedAmount: 5_000_000, cashAmount: 3_000_000, inKindAmount: null })],
      details: [],
      members: [],
      years: YEARS,
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.issues).toHaveLength(1);
    expect(r.issues[0]).toMatchObject({ code: 'split_mismatch', yearId: 'Y2', category: 'material' });
    expect(r.issues[0]!.message).toContain('2차년도 연구재료비');
  });

  it('한쪽만 null이고 합이 맞으면 null = 0으로 보낸다', () => {
    const r = buildBaselineFromPlan({
      items: [item({ category: 'material', plannedAmount: 5_000_000, cashAmount: null, inKindAmount: 5_000_000 })],
      details: [],
      members: [],
      years: YEARS,
    });
    if (!r.ok) throw new Error(JSON.stringify(r.issues));
    expect(r.lines).toEqual([{ yearId: 'Y1', category: 'material', subcategoryCode: 'default', axis: 'in_kind', amount: 5_000_000 }]);
    expect(r.summary.unsplit.count).toBe(0);
  });

  it('음수 그룹은 위치를 적어 거부(조정액으로 음수가 된 산출근거 합)', () => {
    const r = buildBaselineFromPlan({
      items: [],
      details: [detail({ category: 'indirect', subcategory: 'indirect_hr', amount: -10 })],
      members: [],
      years: YEARS,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.issues[0]).toMatchObject({ code: 'negative_group', category: 'indirect' });
      expect(r.issues[0]!.message).toContain('1차년도 간접비');
      expect(r.issues[0]!.message).toContain('가. 인력지원비');
    }
  });

  it('거부 사유를 전부 모은다 · 인력·연차·세목 불일치도 거부', () => {
    const r = buildBaselineFromPlan({
      items: [
        item({ category: 'material', plannedAmount: 10, cashAmount: 1, inKindAmount: 1 }),
        item({ yearId: 'Y9', category: 'other', plannedAmount: 1 }),
      ],
      details: [
        detail({ category: 'personnel', subcategory: 'personnel_internal', formula: 'personnel', memberId: 'M9', factors: PERSONNEL_FACTORS(50, 12), amount: 1 }),
        detail({ category: 'activity', subcategory: 'nope', amount: 1 }),
        detail({ category: 'personnel', subcategory: 'personnel_internal', formula: 'personnel', memberId: 'M1', factors: PERSONNEL_FACTORS(150, 12), amount: 1 }),
      ],
      members: PLAN_MEMBERS,
      years: YEARS,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.issues.map((i) => i.code).sort()).toEqual(
        ['participant_out_of_range', 'split_mismatch', 'unknown_member', 'unknown_subcategory', 'unknown_year'].sort()
      );
    }
  });

  it('미분리 셀이 계획액 0이면 보고하지 않는다', () => {
    const r = buildBaselineFromPlan({ items: [item({ category: 'allowance', plannedAmount: 0 })], details: [], members: [], years: YEARS });
    expect(r.ok && r.summary.unsplit).toEqual({ count: 0, amount: 0, cells: [] });
    expect(r.ok && r.lines).toEqual([]);
  });

  it('보낸 결과를 비목별 보기로 읽으면 같은 합계', () => {
    if (!result.ok) throw new Error('보내기 실패');
    const view = buildCategoryView(result.lines, YEARS);
    expect(view.grandTotal).toEqual({ cash: 40_000_000, inKind: 10_000_000, total: 50_000_000 });
  });
});
