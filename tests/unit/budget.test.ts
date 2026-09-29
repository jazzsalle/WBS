// 예산 계획액 매트릭스·연차 예산 비교 테스트 (SOT §6.4 B-3·B-4, 부록 A.1, §7.9)

import { describe, expect, it } from 'vitest';
import {
  buildBudgetMatrix,
  checkYearBudgetMismatch,
  type BudgetItemInput,
  type BudgetYearInput,
} from '@/lib/budget';
import {
  BUDGET_CATEGORY_COUNT,
  BUDGET_CATEGORY_LABELS,
  BUDGET_CATEGORY_ORDER,
} from '@/lib/constants';
import type { BudgetCategory } from '@/types';

// ─── 픽스처 헬퍼 ─────────────────────────────────────────────

function item(spec: {
  yearId?: string;
  category: BudgetCategory;
  planned: number;
  cash?: number | null;
  inKind?: number | null;
}): BudgetItemInput {
  return {
    yearId: spec.yearId ?? 'y1',
    category: spec.category,
    plannedAmount: spec.planned,
    cashAmount: spec.cash ?? null,
    inKindAmount: spec.inKind ?? null,
  };
}

// 1차년도 편성 (원 단위). 5비목 합계 200,000,000
const YEAR1: BudgetItemInput[] = [
  item({ category: 'personnel', planned: 120_000_000 }),
  item({ category: 'material', planned: 40_000_000 }),
  item({ category: 'activity', planned: 25_000_000 }),
  item({ category: 'allowance', planned: 8_000_000 }),
  item({ category: 'indirect', planned: 7_000_000 }),
];

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
    ...YEAR1,
    item({ yearId: 'y2', category: 'personnel', planned: 100_000_000 }),
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

    // 2차년도에는 재료비 레코드가 없다
    const material = matrix.rows.find((r) => r.category === 'material')!;
    expect(material.cells[1]!.yearId).toBe('y2');
    expect(material.cells[1]).toEqual({
      yearId: 'y2',
      category: 'material',
      planned: 0,
      cash: 0,
      inKind: 0,
    });
  });

  it('연차별 합계(하단 요약 행)는 그 연차 편성의 합이다', () => {
    const y1 = matrix.columns[0]!;
    expect(y1.total.planned).toBe(200_000_000);
    expect(matrix.columns[1]!.total.planned).toBe(100_000_000);
  });

  it('비목별 합계는 전 연차를 가로로 합산한다', () => {
    const personnel = matrix.rows.find((r) => r.category === 'personnel')!;
    expect(personnel.total.planned).toBe(220_000_000);
  });

  it('전체 합계는 연차별 합계의 합과 같다', () => {
    const columnPlanned = matrix.columns.reduce((sum, c) => sum + c.total.planned, 0);
    expect(matrix.total.planned).toBe(columnPlanned);
    expect(matrix.total.planned).toBe(300_000_000);
  });

  it('현금/현물을 셀·연차·비목·전체 합계로 합산하고, 분리 없음(null)은 0으로 본다', () => {
    const split = buildBudgetMatrix(
      [year({ id: 'y1' }), year({ id: 'y2', name: '2차년도', order: 1 })],
      [
        item({ category: 'personnel', planned: 70_000_000, cash: 50_000_000, inKind: 20_000_000 }),
        item({ yearId: 'y2', category: 'personnel', planned: 30_000_000, cash: 30_000_000, inKind: 0 }),
        item({ category: 'material', planned: 10_000_000 }),
      ]
    );
    const personnel = split.rows[0]!;
    expect(personnel.cells[0]).toMatchObject({ planned: 70_000_000, cash: 50_000_000, inKind: 20_000_000 });
    expect(personnel.total).toEqual({ planned: 100_000_000, cash: 80_000_000, inKind: 20_000_000 });

    const material = split.rows.find((r) => r.category === 'material')!;
    expect(material.cells[0]).toMatchObject({ planned: 10_000_000, cash: 0, inKind: 0 });

    expect(split.columns[0]!.total).toEqual({ planned: 80_000_000, cash: 50_000_000, inKind: 20_000_000 });
    expect(split.total).toEqual({ planned: 110_000_000, cash: 80_000_000, inKind: 20_000_000 });
  });

  it('B-3 배지: 연차 예산과 편성 합계를 열마다 비교한다', () => {
    expect(matrix.columns[0]!.mismatch).toEqual({ mismatch: false, diff: 0 });
    // 2차년도 편성은 100,000,000으로 일치
    expect(matrix.columns[1]!.mismatch).toEqual({ mismatch: false, diff: 0 });

    const shifted = buildBudgetMatrix([year({ id: 'y1', budget: 180_000_000 })], YEAR1);
    expect(shifted.columns[0]!.mismatch).toEqual({ mismatch: true, diff: 20_000_000 });
  });

  it('year.budget이 null인 연차는 배지를 띄우지 않는다 (B-3)', () => {
    const noBudget = buildBudgetMatrix([year({ id: 'y1' })], YEAR1);
    expect(noBudget.columns[0]!.mismatch).toBeNull();
    expect(noBudget.columns[0]!.yearBudget).toBeNull();
  });

  it('같은 (연차, 비목) 레코드가 둘이면 합산한다 — 금액을 덮어쓰지 않는다', () => {
    const duplicated = buildBudgetMatrix(
      [year({ id: 'y1' })],
      [
        item({ category: 'personnel', planned: 1_000_000, cash: 1_000_000, inKind: 0 }),
        item({ category: 'personnel', planned: 2_000_000, cash: 500_000, inKind: 1_500_000 }),
      ]
    );
    const personnel = duplicated.rows[0]!;
    expect(personnel.cells[0]!.planned).toBe(3_000_000);
    expect(personnel.cells[0]!.cash).toBe(1_500_000);
    expect(personnel.cells[0]!.inKind).toBe(1_500_000);
  });

  it('열에 없는 연차의 비목은 매트릭스에서 빠지므로 개수를 노출한다 (조용히 버리지 않는다)', () => {
    const orphan = buildBudgetMatrix(
      [year({ id: 'y1' })],
      [...YEAR1, item({ yearId: 'y9', category: 'personnel', planned: 9_000_000 })]
    );
    expect(orphan.unmatchedItemCount).toBe(1);
    expect(orphan.total.planned).toBe(200_000_000);
    expect(matrix.unmatchedItemCount).toBe(0);
  });

  it('B-4: 매트릭스가 내보내는 금액은 전부 원 단위 정수다', () => {
    const amounts = matrix.rows.flatMap((r) => [
      ...r.cells.flatMap((c) => [c.planned, c.cash, c.inKind]),
      r.total.planned,
      r.total.cash,
      r.total.inKind,
    ]);
    expect(amounts.every(Number.isInteger)).toBe(true);
  });
});
