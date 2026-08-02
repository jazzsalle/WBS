// 예산 집행률 테스트 (SOT §6.4 B-1~B-4, 부록 A.1, 부록 B.4, §7.9, §6.1 P-8)
// 부록 B.4는 단위가 천원이다 — 여기서는 B-4에 따라 원 단위 정수로 환산해 그대로 옮긴다.
// 합계 집행률은 금액 합계끼리 나눈 값이다. 개별 집행률의 평균(90.93…)이 아니다.

import { describe, expect, it } from 'vitest';
import {
  buildBudgetMatrix,
  checkYearBudgetMismatch,
  computeExecutionRate,
  computeItemSummary,
  computeProjectSummary,
  computeYearSummary,
  isOffBudgetExecution,
  isOverExecuted,
  sumExecutions,
  type BudgetYearInput,
} from '@/lib/budget';
import {
  BUDGET_CATEGORY_COUNT,
  BUDGET_CATEGORY_LABELS,
  BUDGET_CATEGORY_ORDER,
} from '@/lib/constants';
import { formatRate } from '@/lib/goals';
import type { BudgetCategory, BudgetExecution, BudgetItem } from '@/types';

// ─── 픽스처 헬퍼 ─────────────────────────────────────────────

// BudgetItem(§5.12) 전체를 만들어 넘긴다 — 계산 함수가 실제 엔티티를 그대로 받는지도 함께 고정한다
function item(spec: {
  yearId?: string;
  category: BudgetCategory;
  planned: number;
  cash?: number | null;
  inKind?: number | null;
  /** 집행 금액 목록 (원). 생략하면 집행 없음 */
  executed?: readonly number[];
}): BudgetItem {
  const yearId = spec.yearId ?? 'y1';
  const executions: BudgetExecution[] = (spec.executed ?? []).map((amount, i) => ({
    id: `${yearId}-${spec.category}-e${i}`,
    version: 1,
    date: '2026-03-01',
    amount,
    description: '집행',
    note: '',
  }));
  return {
    id: `${yearId}-${spec.category}`,
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    version: 1,
    createdBy: null,
    updatedBy: null,
    projectId: 'p1',
    yearId,
    category: spec.category,
    plannedAmount: spec.planned,
    cashAmount: spec.cash ?? null,
    inKindAmount: spec.inKind ?? null,
    executions,
    note: '',
  };
}

// 부록 B.4 (1차년도). 천원 단위 표를 원 단위로 환산한 값이다.
const B4_YEAR1: BudgetItem[] = [
  item({ category: 'personnel', planned: 120_000_000, executed: [118_400_000] }),
  item({ category: 'material', planned: 40_000_000, executed: [43_200_000] }),
  item({ category: 'activity', planned: 25_000_000, executed: [12_000_000] }),
  item({ category: 'allowance', planned: 8_000_000, executed: [8_000_000] }),
  item({ category: 'indirect', planned: 7_000_000, executed: [7_000_000] }),
];

// 연차 생성 시 12비목이 0으로 만들어진다(§5.12) — 표에 없는 7비목도 실제로는 레코드가 있다
const B4_YEAR1_FULL: BudgetItem[] = BUDGET_CATEGORY_ORDER.map(
  (category) => B4_YEAR1.find((i) => i.category === category) ?? item({ category, planned: 0 })
);

const year = (spec: Partial<BudgetYearInput> & { id: string }): BudgetYearInput => ({
  name: '1차년도',
  order: 0,
  budget: null,
  ...spec,
});

// ─── 부록 A.1 비목 순서 ──────────────────────────────────────

describe('BUDGET_CATEGORY_ORDER (부록 A.1)', () => {
  it('부록 A.1 표 순서 그대로 12종이다', () => {
    expect(BUDGET_CATEGORY_ORDER).toEqual([
      'personnel',
      'student_personnel',
      'facility_equipment',
      'material',
      'consignment',
      'international',
      'burden',
      'activity',
      'promotion',
      'allowance',
      'indirect',
      'other',
    ]);
    expect(BUDGET_CATEGORY_ORDER).toHaveLength(12);
    expect(BUDGET_CATEGORY_COUNT).toBe(12);
  });

  it('중복 없이 라벨 맵과 같은 집합이다', () => {
    expect(new Set(BUDGET_CATEGORY_ORDER).size).toBe(BUDGET_CATEGORY_ORDER.length);
    expect([...BUDGET_CATEGORY_ORDER].sort()).toEqual(Object.keys(BUDGET_CATEGORY_LABELS).sort());
  });
});

// ─── 기본 계산 ───────────────────────────────────────────────

describe('sumExecutions (§6.4)', () => {
  it('집행 내역이 없으면 0', () => {
    expect(sumExecutions([])).toBe(0);
  });

  it('원 단위 정수를 그대로 더한다 (B-4)', () => {
    const total = sumExecutions([{ amount: 118_400_000 }, { amount: 1 }, { amount: 0 }]);
    expect(total).toBe(118_400_001);
    expect(Number.isInteger(total)).toBe(true);
  });
});

describe('computeExecutionRate (§6.4 B-1·B-2)', () => {
  it('B-1: 계획액 0이면 N/A(null) — 집행이 있어도 나누지 않는다', () => {
    expect(computeExecutionRate(0, 0)).toBeNull();
    expect(computeExecutionRate(0, 1)).toBeNull();
    expect(computeExecutionRate(0, 5_000_000)).toBeNull();
  });

  it('B-2: 100 초과도 그대로 돌려준다 (저장을 막지 않는다)', () => {
    expect(computeExecutionRate(40_000_000, 43_200_000)).toBe(108);
  });

  it('나누어떨어지지 않는 비율도 반올림하지 않는다 (P-8)', () => {
    expect(computeExecutionRate(120_000_000, 118_400_000)).toBeCloseTo(98.66666666666667, 10);
  });
});

describe('isOffBudgetExecution (§6.4 B-1)', () => {
  it('계획 0 + 집행 0이면 경고가 아니다', () => {
    expect(isOffBudgetExecution(0, 0)).toBe(false);
  });

  it('계획 0인데 집행이 1원이라도 있으면 예산 외 집행이다', () => {
    expect(isOffBudgetExecution(0, 1)).toBe(true);
  });

  it('계획이 있으면 초과 집행이어도 예산 외 집행이 아니다', () => {
    expect(isOffBudgetExecution(40_000_000, 43_200_000)).toBe(false);
  });
});

describe('isOverExecuted (§6.4 B-2)', () => {
  it('정확히 100은 초과가 아니다 (경계)', () => {
    expect(isOverExecuted(100)).toBe(false);
  });

  it('100을 조금이라도 넘으면 초과다', () => {
    expect(isOverExecuted(100.0001)).toBe(true);
    expect(isOverExecuted(108)).toBe(true);
  });

  it('N/A(null)는 초과 판정 대상이 아니다', () => {
    expect(isOverExecuted(null)).toBe(false);
  });
});

// ─── 부록 B.4 ────────────────────────────────────────────────

describe('computeItemSummary — 부록 B.4 비목별', () => {
  const summaryOf = (category: BudgetCategory) =>
    computeItemSummary(B4_YEAR1_FULL.find((i) => i.category === category)!);

  it('인건비 120,000,000 / 118,400,000 → 98.666…% (표시 98.7%)', () => {
    const s = summaryOf('personnel');
    expect(s.rate).toBeCloseTo(98.66666666666667, 10);
    expect(formatRate(s.rate)).toBe('98.7%');
    expect(s.remaining).toBe(1_600_000);
    expect(s.over).toBe(false);
    expect(s.offBudget).toBe(false);
  });

  it('연구재료비 40,000,000 / 43,200,000 → 108.0% 초과 경고 (B-2)', () => {
    const s = summaryOf('material');
    expect(s.rate).toBe(108);
    expect(formatRate(s.rate)).toBe('108.0%');
    expect(s.over).toBe(true);
    // 초과 집행이면 잔액은 음수다 (§7.9)
    expect(s.remaining).toBe(-3_200_000);
  });

  it('연구활동비 25,000,000 / 12,000,000 → 48.0%', () => {
    const s = summaryOf('activity');
    expect(s.rate).toBe(48);
    expect(s.remaining).toBe(13_000_000);
    expect(s.over).toBe(false);
  });

  it('연구수당·간접비는 정확히 100.0% — 경계이므로 초과가 아니다', () => {
    for (const category of ['allowance', 'indirect'] as const) {
      const s = summaryOf(category);
      expect(s.rate).toBe(100);
      expect(formatRate(s.rate)).toBe('100.0%');
      expect(s.over).toBe(false);
      expect(s.remaining).toBe(0);
    }
  });

  it('표에 없는 7비목은 계획·집행 모두 0이라 N/A이고 경고도 없다 (B-1)', () => {
    const zeroCategories = BUDGET_CATEGORY_ORDER.filter(
      (c) => !B4_YEAR1.some((i) => i.category === c)
    );
    expect(zeroCategories).toHaveLength(7);
    for (const category of zeroCategories) {
      const s = summaryOf(category);
      expect(s.rate).toBeNull();
      expect(formatRate(s.rate)).toBe('N/A');
      expect(s.offBudget).toBe(false);
      expect(s.over).toBe(false);
      expect(s.remaining).toBe(0);
    }
  });

  it('현금/현물 분리가 없으면(null) 0으로 합산한다 (S-4)', () => {
    const split = computeItemSummary(
      item({ category: 'personnel', planned: 70_000_000, cash: 50_000_000, inKind: 20_000_000 })
    );
    expect(split.cash).toBe(50_000_000);
    expect(split.inKind).toBe(20_000_000);

    const merged = computeItemSummary(item({ category: 'personnel', planned: 70_000_000 }));
    expect(merged.cash).toBe(0);
    expect(merged.inKind).toBe(0);
    expect(merged.planned).toBe(70_000_000);
  });

  it('집행 내역 여러 건은 합산해 하나의 집행액이 된다', () => {
    const s = computeItemSummary(
      item({ category: 'material', planned: 40_000_000, executed: [40_000_000, 3_200_000] })
    );
    expect(s.executed).toBe(43_200_000);
    expect(s.rate).toBe(108);
  });
});

describe('computeYearSummary — 부록 B.4 합계', () => {
  const summary = computeYearSummary(B4_YEAR1_FULL);

  it('예산 200,000,000 / 집행 188,600,000 → 94.3%', () => {
    expect(summary.planned).toBe(200_000_000);
    expect(summary.executed).toBe(188_600_000);
    expect(summary.rate).toBeCloseTo(94.3, 10);
    expect(formatRate(summary.rate)).toBe('94.3%');
    expect(summary.remaining).toBe(11_400_000);
    expect(summary.over).toBe(false);
    expect(summary.offBudget).toBe(false);
  });

  it('계획 0인 7비목을 넣어도 합계가 변하지 않는다', () => {
    const withoutZeros = computeYearSummary(B4_YEAR1);
    expect(withoutZeros.planned).toBe(summary.planned);
    expect(withoutZeros.executed).toBe(summary.executed);
    expect(withoutZeros.rate).toBe(summary.rate);
  });

  // 회귀 1: 부록 B.4가 명시적으로 배제하는 오답
  it('회귀 — 합계 집행률은 개별 집행률의 평균(90.93…)이 아니다', () => {
    const rates = B4_YEAR1.map((i) => computeItemSummary(i).rate!);
    const average = rates.reduce((sum, r) => sum + r, 0) / rates.length;
    expect(average).toBeCloseTo(90.93333333333334, 10);
    expect(summary.rate).not.toBeCloseTo(average, 6);
    expect(summary.rate).toBeCloseTo(94.3, 10);
  });

  // 회귀 2: P-8 중간 반올림 금지
  it('회귀 — 개별 집행률을 먼저 표시값으로 반올림해 합산하면 값이 달라진다', () => {
    const roundedAverage =
      B4_YEAR1.map((i) => Math.round(computeItemSummary(i).rate! * 10) / 10).reduce(
        (sum, r) => sum + r,
        0
      ) / B4_YEAR1.length;
    // 98.666… → 98.7로 먼저 반올림한 결과. 합계 계산에는 이 값이 끼어들면 안 된다
    expect(roundedAverage).toBeCloseTo(90.94, 10);
    expect(summary.rate).not.toBeCloseTo(roundedAverage, 6);
  });

  // 회귀 3: B-1 / B-2 경계
  it('회귀 — 계획 0 합계의 경계: (0,0)은 N/A·경고 없음, (0,+)는 N/A·예산 외 집행', () => {
    const allZero = computeYearSummary([item({ category: 'personnel', planned: 0 })]);
    expect(allZero.rate).toBeNull();
    expect(allZero.offBudget).toBe(false);

    const offBudget = computeYearSummary([
      item({ category: 'personnel', planned: 0, executed: [1] }),
    ]);
    expect(offBudget.rate).toBeNull();
    expect(offBudget.offBudget).toBe(true);
    expect(offBudget.executed).toBe(1);
    expect(offBudget.remaining).toBe(-1);
  });

  it('한 비목이 초과여도 합계가 100 이하면 합계는 초과가 아니다', () => {
    // 연구재료비는 108%지만 연차 합계는 94.3%다
    expect(computeItemSummary(B4_YEAR1[1]!).over).toBe(true);
    expect(summary.over).toBe(false);
  });
});

describe('computeProjectSummary (§6.4 과제 = 전 연차 합산)', () => {
  const year2: BudgetItem[] = [
    item({ yearId: 'y2', category: 'personnel', planned: 100_000_000, executed: [50_000_000] }),
    item({ yearId: 'y2', category: 'indirect', planned: 0, executed: [2_000_000] }),
  ];

  it('연차 합계를 다시 합산해 나눈다', () => {
    const summary = computeProjectSummary([...B4_YEAR1_FULL, ...year2]);
    expect(summary.planned).toBe(300_000_000);
    expect(summary.executed).toBe(240_600_000);
    expect(summary.rate).toBeCloseTo((240_600_000 / 300_000_000) * 100, 10);
    expect(summary.remaining).toBe(59_400_000);
  });

  it('일부 비목이 예산 외 집행이어도 계획 합계가 0이 아니면 합계는 경고가 아니다 (B-1)', () => {
    const summary = computeProjectSummary([...B4_YEAR1_FULL, ...year2]);
    expect(computeItemSummary(year2[1]!).offBudget).toBe(true);
    expect(summary.offBudget).toBe(false);
  });
});

// ─── B-3 ─────────────────────────────────────────────────────

describe('checkYearBudgetMismatch (§6.4 B-3)', () => {
  it('year.budget이 null이면 비교 대상이 없어 배지를 띄우지 않는다', () => {
    expect(checkYearBudgetMismatch(null, 200_000_000)).toBeNull();
    expect(checkYearBudgetMismatch(null, 0)).toBeNull();
  });

  it('일치하면 mismatch=false, diff=0', () => {
    expect(checkYearBudgetMismatch(200_000_000, 200_000_000)).toEqual({
      mismatch: false,
      diff: 0,
    });
  });

  it('편성이 더 많으면 diff는 양수', () => {
    expect(checkYearBudgetMismatch(200_000_000, 205_000_000)).toEqual({
      mismatch: true,
      diff: 5_000_000,
    });
  });

  it('편성이 모자라면 diff는 음수', () => {
    expect(checkYearBudgetMismatch(200_000_000, 195_000_000)).toEqual({
      mismatch: true,
      diff: -5_000_000,
    });
  });

  it('year.budget이 0이면 null이 아니라 실제 비교 대상이다', () => {
    expect(checkYearBudgetMismatch(0, 0)).toEqual({ mismatch: false, diff: 0 });
    expect(checkYearBudgetMismatch(0, 1_000)).toEqual({ mismatch: true, diff: 1_000 });
  });
});

// ─── §7.9 매트릭스 ───────────────────────────────────────────

describe('buildBudgetMatrix (§7.9)', () => {
  const years = [
    year({ id: 'y2', name: '2차년도', order: 1, budget: 100_000_000 }),
    year({ id: 'y1', name: '1차년도', order: 0, budget: 200_000_000 }),
  ];
  const items = [
    ...B4_YEAR1,
    item({ yearId: 'y2', category: 'personnel', planned: 100_000_000, executed: [50_000_000] }),
  ];
  const matrix = buildBudgetMatrix(years, items);

  it('열은 연차 order 오름차순이다', () => {
    expect(matrix.columns.map((c) => c.yearId)).toEqual(['y1', 'y2']);
    expect(matrix.columns.map((c) => c.name)).toEqual(['1차년도', '2차년도']);
  });

  it('데이터가 없어도 항상 12행이며 부록 A.1 순서를 따른다', () => {
    expect(matrix.rows).toHaveLength(12);
    expect(matrix.rows.map((r) => r.category)).toEqual([...BUDGET_CATEGORY_ORDER]);
    const empty = buildBudgetMatrix(years, []);
    expect(empty.rows).toHaveLength(12);
    expect(empty.rows.every((r) => r.cells.every((c) => c.planned === 0))).toBe(true);
  });

  it('데이터가 없는 (연차, 비목) 조합도 빈 셀이 아니라 planned 0 셀이다', () => {
    const consignment = matrix.rows.find((r) => r.category === 'consignment')!;
    expect(consignment.cells).toHaveLength(2);
    expect(consignment.cells.map((c) => c.planned)).toEqual([0, 0]);
    expect(consignment.cells.map((c) => c.rate)).toEqual([null, null]);

    // 2차년도에는 재료비 레코드가 없다
    const material = matrix.rows.find((r) => r.category === 'material')!;
    expect(material.cells[1]!.yearId).toBe('y2');
    expect(material.cells[1]!.planned).toBe(0);
    expect(material.cells[1]!.executed).toBe(0);
  });

  it('연차별 합계(하단 요약 행)는 부록 B.4와 같다', () => {
    const y1 = matrix.columns[0]!;
    expect(y1.total.planned).toBe(200_000_000);
    expect(y1.total.executed).toBe(188_600_000);
    expect(formatRate(y1.total.rate)).toBe('94.3%');
    expect(y1.total.remaining).toBe(11_400_000);
  });

  it('비목별 합계는 전 연차를 가로로 합산한다', () => {
    const personnel = matrix.rows.find((r) => r.category === 'personnel')!;
    expect(personnel.total.planned).toBe(220_000_000);
    expect(personnel.total.executed).toBe(168_400_000);
    expect(personnel.total.rate).toBeCloseTo((168_400_000 / 220_000_000) * 100, 10);
  });

  it('전체 합계는 연차별 합계의 합과 같다', () => {
    const columnPlanned = matrix.columns.reduce((sum, c) => sum + c.total.planned, 0);
    const columnExecuted = matrix.columns.reduce((sum, c) => sum + c.total.executed, 0);
    expect(matrix.total.planned).toBe(columnPlanned);
    expect(matrix.total.executed).toBe(columnExecuted);
    expect(matrix.total.planned).toBe(300_000_000);
    expect(matrix.total.executed).toBe(238_600_000);
  });

  it('B-3 배지: 연차 예산과 편성 합계를 열마다 비교한다', () => {
    expect(matrix.columns[0]!.mismatch).toEqual({ mismatch: false, diff: 0 });
    // 2차년도 편성은 100,000,000으로 일치
    expect(matrix.columns[1]!.mismatch).toEqual({ mismatch: false, diff: 0 });

    const shifted = buildBudgetMatrix(
      [year({ id: 'y1', budget: 180_000_000 })],
      B4_YEAR1
    );
    expect(shifted.columns[0]!.mismatch).toEqual({ mismatch: true, diff: 20_000_000 });
  });

  it('year.budget이 null인 연차는 배지를 띄우지 않는다 (B-3)', () => {
    const noBudget = buildBudgetMatrix([year({ id: 'y1' })], B4_YEAR1);
    expect(noBudget.columns[0]!.mismatch).toBeNull();
    expect(noBudget.columns[0]!.yearBudget).toBeNull();
  });

  it('같은 (연차, 비목) 레코드가 둘이면 합산한다 — 금액을 덮어쓰지 않는다', () => {
    const duplicated = buildBudgetMatrix(
      [year({ id: 'y1' })],
      [
        item({ category: 'personnel', planned: 1_000_000, executed: [500_000] }),
        item({ category: 'personnel', planned: 2_000_000, executed: [100_000] }),
      ]
    );
    const personnel = duplicated.rows[0]!;
    expect(personnel.cells[0]!.planned).toBe(3_000_000);
    expect(personnel.cells[0]!.executed).toBe(600_000);
  });

  it('열에 없는 연차의 비목은 매트릭스에서 빠지므로 개수를 노출한다 (조용히 버리지 않는다)', () => {
    const orphan = buildBudgetMatrix(
      [year({ id: 'y1' })],
      [...B4_YEAR1, item({ yearId: 'y9', category: 'personnel', planned: 9_000_000 })]
    );
    expect(orphan.unmatchedItemCount).toBe(1);
    expect(orphan.total.planned).toBe(200_000_000);
    expect(matrix.unmatchedItemCount).toBe(0);
  });

  it('B-2: 초과 집행 셀만 초과로 표시된다', () => {
    const material = matrix.rows.find((r) => r.category === 'material')!;
    expect(material.cells[0]!.over).toBe(true);
    expect(material.cells[1]!.over).toBe(false);
    expect(matrix.columns[0]!.total.over).toBe(false);
  });

  it('B-4: 매트릭스가 내보내는 금액은 전부 원 단위 정수다', () => {
    const amounts = matrix.rows.flatMap((r) => [
      ...r.cells.flatMap((c) => [c.planned, c.cash, c.inKind, c.executed, c.remaining]),
      r.total.planned,
      r.total.executed,
    ]);
    expect(amounts.every(Number.isInteger)).toBe(true);
  });
});
