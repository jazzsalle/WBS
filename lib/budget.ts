// 예산 계획액 매트릭스와 연차 예산 비교 (SOT §6.4 B-3·B-4, §7.9).
// 부수효과 없는 순수 함수다. 합계는 저장하지 않고 읽을 때 계산한다.
// B-4: 금액은 원 단위 정수로만 다룬다 — 여기서는 정수 덧셈만 하고, 통화 단위 환산
// (settings.currencyUnit)은 표시 계층의 몫이다.
// 산출근거 집계(lib/budget-plan.ts)와 합치지 않는다 — 기준액 정의가 섞인다 (§6.10.4).
// 단위 테스트: tests/unit/budget.test.ts

import { BUDGET_CATEGORY_ORDER } from './constants';
import type { BudgetCategory, BudgetItem, Year } from '@/types';

// ─── 입력 (BudgetItem·Year를 그대로 대입할 수 있는 최소 형태) ─

export type BudgetItemInput = Pick<
  BudgetItem,
  'yearId' | 'category' | 'plannedAmount' | 'cashAmount' | 'inKindAmount'
>;

export type BudgetYearInput = Pick<Year, 'id' | 'name' | 'order' | 'budget'>;

// ─── 출력 ────────────────────────────────────────────────────

export interface BudgetSummary {
  /** 계획(예산)액 합계 (원) */
  planned: number;
  /** 그중 현금. 현금/현물 분리가 없는 항목은 null이므로 합산에서는 0으로 본다 */
  cash: number;
  /** 그중 현물 */
  inKind: number;
}

export interface YearBudgetMismatch {
  /** B-3: 연차 예산 합계가 year.budget과 다른가 */
  mismatch: boolean;
  /** plannedSum - yearBudget. 양수면 편성이 연차 예산보다 많다 */
  diff: number;
}

// ─── §6.4 B-3 ────────────────────────────────────────────────

/**
 * B-3: 연차 예산 합계와 year.budget 비교.
 * yearBudget이 null이면 비교 대상 자체가 없으므로 null을 돌려준다 — 배지를 띄우지 않는다.
 * (0으로 간주하면 예산을 아직 입력하지 않은 연차가 전부 불일치로 잡힌다)
 */
export function checkYearBudgetMismatch(
  yearBudget: number | null,
  plannedSum: number
): YearBudgetMismatch | null {
  if (yearBudget === null) return null;
  const diff = plannedSum - yearBudget;
  return { mismatch: diff !== 0, diff };
}

// ─── 합산 ────────────────────────────────────────────────────

/** 여러 비목의 계획액 합산. 현금/현물이 null(분리 없음)이면 0으로 합산한다 */
function sumItems(items: readonly BudgetItemInput[]): BudgetSummary {
  let planned = 0;
  let cash = 0;
  let inKind = 0;
  for (const item of items) {
    planned += item.plannedAmount;
    cash += item.cashAmount ?? 0;
    inKind += item.inKindAmount ?? 0;
  }
  return { planned, cash, inKind };
}

// ─── §7.9 매트릭스 (행 = 12비목, 열 = 연차) ──────────────────

export interface BudgetMatrixCell extends BudgetSummary {
  yearId: string;
  category: BudgetCategory;
}

export interface BudgetMatrixRow {
  category: BudgetCategory;
  /** columns와 같은 순서·길이. 데이터가 없는 조합도 planned 0 셀로 채운다 */
  cells: BudgetMatrixCell[];
  /** 비목별 전 연차 합계 */
  total: BudgetSummary;
}

export interface BudgetMatrixColumn {
  yearId: string;
  name: string;
  order: number;
  /** 연차 연구개발비 (§5.5). B-3 비교 대상 */
  yearBudget: number | null;
  /** 연차별 합계 = 하단 요약 행 (§7.9) */
  total: BudgetSummary;
  /** B-3 경고 배지. yearBudget이 null이면 null */
  mismatch: YearBudgetMismatch | null;
}

export interface BudgetMatrix {
  /** order 오름차순으로 고정한 열 순서 */
  columns: BudgetMatrixColumn[];
  /** 항상 12행 (BUDGET_CATEGORY_ORDER 순) */
  rows: BudgetMatrixRow[];
  /** 전체 합계 */
  total: BudgetSummary;
  /**
   * columns에 없는 연차를 가리키는 비목 수. 0이 아니면 매트릭스에 실리지 않은 예산이 있다는 뜻이다 —
   * 데이터 손상을 조용히 삼키지 않기 위해 개수를 노출한다.
   */
  unmatchedItemCount: number;
}

// (연차, 비목) 셀 키. yearId는 UUID라 '|'가 값에 섞이지 않는다
function cellKey(yearId: string, category: BudgetCategory): string {
  return `${yearId}|${category}`;
}

export function buildBudgetMatrix(
  years: readonly BudgetYearInput[],
  items: readonly BudgetItemInput[]
): BudgetMatrix {
  // 열 순서는 연차 order 고정. 동률이면 id로 갈라 화면마다 순서가 흔들리지 않게 한다
  const columnYears = [...years].sort(
    (a, b) => a.order - b.order || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
  );
  const yearIds = new Set(columnYears.map((y) => y.id));

  // (연차, 비목) → 해당 조합의 비목들. 유일 제약(§5.12)이 깨져 중복이 와도 합산해 잃지 않는다
  const buckets = new Map<string, BudgetItemInput[]>();
  let unmatchedItemCount = 0;
  for (const item of items) {
    if (!yearIds.has(item.yearId)) {
      unmatchedItemCount += 1;
      continue;
    }
    const key = cellKey(item.yearId, item.category);
    const bucket = buckets.get(key);
    if (bucket) bucket.push(item);
    else buckets.set(key, [item]);
  }

  const rows: BudgetMatrixRow[] = BUDGET_CATEGORY_ORDER.map((category) => {
    const cells = columnYears.map((year) => ({
      yearId: year.id,
      category,
      ...sumItems(buckets.get(cellKey(year.id, category)) ?? []),
    }));
    return { category, cells, total: sumSummaries(cells) };
  });

  const columns: BudgetMatrixColumn[] = columnYears.map((year, index) => {
    const total = sumSummaries(rows.map((row) => row.cells[index]!));
    return {
      yearId: year.id,
      name: year.name,
      order: year.order,
      yearBudget: year.budget,
      total,
      mismatch: checkYearBudgetMismatch(year.budget, total.planned),
    };
  });

  return {
    columns,
    rows,
    total: sumSummaries(rows.map((row) => row.total)),
    unmatchedItemCount,
  };
}

/** 이미 계산된 요약들의 합 */
function sumSummaries(summaries: readonly BudgetSummary[]): BudgetSummary {
  let planned = 0;
  let cash = 0;
  let inKind = 0;
  for (const summary of summaries) {
    planned += summary.planned;
    cash += summary.cash;
    inKind += summary.inKind;
  }
  return { planned, cash, inKind };
}
