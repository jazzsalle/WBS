// 협약 예산 비목별 보기 — 연차 × 비목 × 현금/현물 매트릭스와 그 표 모델 (SOT §6.19 AG-2·AG-8, 부록 A.1).
//
// 금액 줄(§5.22)을 (연차, 비목, 축)으로 더한다. 세목은 이 보기에서 접힌다 — 세목 단위 편집은 셀 편집
// 해석(`cell-edit.ts`)의 몫이다. 줄이 하나도 없는 칸은 `null`로 남겨 금액 0인 칸과 구별한다(절대 규칙 5 —
// "—"와 "0"은 다른 사실이다). 금액은 원 단위 정수 덧셈만 한다.

import { BUDGET_CATEGORY_LABELS, BUDGET_CATEGORY_ORDER } from '@/lib/constants';
import type { AgreementLine, BudgetCategory, Year } from '@/types';
import type { TableCell, TableCellRef, TableColumn, TableModel, TableRow } from './table';

export type CategoryViewLine = Pick<AgreementLine, 'yearId' | 'category' | 'subcategoryCode' | 'axis' | 'amount'>;
export type CategoryViewYear = Pick<Year, 'id' | 'name' | 'order'>;

/** 한 칸의 축별 금액. 그 축의 줄이 하나도 없으면 null, `total`은 두 축 모두 줄이 없을 때만 null */
export interface AxisAmounts {
  cash: number | null;
  inKind: number | null;
  total: number | null;
}

export interface CategoryViewRow {
  category: BudgetCategory;
  label: string;
  /** `CategoryViewModel.years`와 같은 순서·길이 */
  byYear: AxisAmounts[];
  /** 전 연차 합(비목 총계) */
  total: AxisAmounts;
}

export interface CategoryViewModel {
  /** 연차 `order` 순 */
  years: { id: string; name: string }[];
  /** 부록 A.1 순서, 12비목 전부(줄이 없는 비목도 행은 있다 — 칸이 null) */
  rows: CategoryViewRow[];
  /** 연차 합계 — `years`와 같은 순서 */
  yearTotals: AxisAmounts[];
  grandTotal: AxisAmounts;
}

const EMPTY: AxisAmounts = { cash: null, inKind: null, total: null };

function addNullable(a: number | null, b: number | null): number | null {
  if (a === null) return b;
  if (b === null) return a;
  return a + b;
}

function addAxis(a: AxisAmounts, b: AxisAmounts): AxisAmounts {
  return { cash: addNullable(a.cash, b.cash), inKind: addNullable(a.inKind, b.inKind), total: addNullable(a.total, b.total) };
}

/**
 * 비목별 매트릭스(AG-2). 연차 밖의 줄·같은 칸(연차·비목·세목·축)의 중복 줄·음수·정수가 아닌 금액은
 * DB 제약을 벗어난 데이터라 던진다 — 조용히 빼거나 더하면 합계가 틀린 채 보인다.
 */
export function buildCategoryView(
  lines: readonly CategoryViewLine[],
  years: readonly CategoryViewYear[]
): CategoryViewModel {
  const sortedYears = [...years].sort((a, b) => a.order - b.order);
  const yearIndex = new Map<string, number>();
  sortedYears.forEach((y, i) => {
    if (yearIndex.has(y.id)) throw new Error(`연차 목록에 같은 연차가 두 번 있습니다 (${y.id}).`);
    yearIndex.set(y.id, i);
  });

  const cells = new Map<BudgetCategory, AxisAmounts[]>(
    BUDGET_CATEGORY_ORDER.map((c) => [c, sortedYears.map(() => ({ ...EMPTY }))])
  );
  const seen = new Set<string>();
  for (const line of lines) {
    const yi = yearIndex.get(line.yearId);
    if (yi === undefined) throw new Error(`협약 금액 줄이 과제에 없는 연차를 가리킵니다 (${line.yearId}).`);
    const row = cells.get(line.category);
    if (row === undefined) throw new Error(`알 수 없는 비목입니다 (${line.category}).`);
    if (!Number.isSafeInteger(line.amount) || line.amount < 0) {
      throw new Error(`협약 금액 줄 금액이 0 이상의 원 단위 정수가 아닙니다 (${line.amount}).`);
    }
    const key = `${line.yearId}|${line.category}|${line.subcategoryCode}|${line.axis}`;
    if (seen.has(key)) throw new Error(`같은 칸의 협약 금액 줄이 두 개입니다 (${key}).`);
    seen.add(key);
    const cell = row[yi]!;
    const add: AxisAmounts =
      line.axis === 'cash'
        ? { cash: line.amount, inKind: null, total: line.amount }
        : { cash: null, inKind: line.amount, total: line.amount };
    row[yi] = addAxis(cell, add);
  }

  const rows: CategoryViewRow[] = BUDGET_CATEGORY_ORDER.map((category) => {
    const byYear = cells.get(category)!;
    return { category, label: BUDGET_CATEGORY_LABELS[category], byYear, total: byYear.reduce(addAxis, EMPTY) };
  });
  const yearTotals = sortedYears.map((_, i) => rows.reduce((acc, r) => addAxis(acc, r.byYear[i]!), EMPTY));
  return {
    years: sortedYears.map((y) => ({ id: y.id, name: y.name })),
    rows,
    yearTotals,
    grandTotal: yearTotals.reduce(addAxis, EMPTY),
  };
}

// ─── 표 모델 (AG-8) ───────────────────────────────────────────────────────────

/** 연차마다 [현금, 현물, 계] 세 열, 끝에 총계 세 열. 0열은 비목 */
const AXIS_COLUMNS = ['현금', '현물', '계'] as const;

function amountCell(value: number | null): TableCell {
  return value === null ? { kind: 'empty' } : { kind: 'amount', value };
}

/** 항이 전부 빈 칸이면 빈 칸 — `SUM`이 0을 보여 "줄 없음"이 금액 0으로 둔갑하지 않게 */
function sumCell(value: number | null, terms: TableCellRef[]): TableCell {
  return value === null ? { kind: 'empty' } : { kind: 'sum', value, terms };
}

/**
 * 비목별 보기 → 표 모델. 헤더 1행(병합 없음 — 어댑터 제약), 비목 12행 + 합계 행.
 * 데이터 칸(연차별 현금·현물)은 값, 계·총계·합계 행은 그 값들을 더하는 `sum` 칸이다 —
 * 엑셀에서 사용자가 숫자를 고치면 합계가 따라 움직인다.
 */
export function categoryViewTable(view: CategoryViewModel, title: string): TableModel {
  const yearCount = view.years.length;
  const columns: TableColumn[] = [{ label: '비목', type: 'text', key: true, width: 18 }];
  for (const y of view.years) for (const axis of AXIS_COLUMNS) columns.push({ label: `${y.name} ${axis}`, type: 'amount' });
  for (const axis of AXIS_COLUMNS) columns.push({ label: `총계 ${axis}`, type: 'amount' });

  const col = (yearSlot: number, axis: 0 | 1 | 2): number => 1 + yearSlot * 3 + axis;
  const totalSlot = yearCount;

  const rows: TableRow[] = view.rows.map((row, r) => {
    const cells: TableCell[] = [{ kind: 'text', text: row.label }];
    row.byYear.forEach((amounts, i) => {
      cells.push(amountCell(amounts.cash), amountCell(amounts.inKind));
      cells.push(sumCell(amounts.total, [{ row: r, col: col(i, 0) }, { row: r, col: col(i, 1) }]));
    });
    if (yearCount === 0) {
      // 연차가 없으면 더할 칸이 없다 — 항 없는 SUM은 엑셀 오류라 빈 칸으로 둔다(값도 null이다)
      cells.push({ kind: 'empty' }, { kind: 'empty' }, { kind: 'empty' });
    } else {
      const acrossYears = (axis: 0 | 1 | 2): TableCellRef[] => row.byYear.map((_, i) => ({ row: r, col: col(i, axis) }));
      cells.push(sumCell(row.total.cash, acrossYears(0)), sumCell(row.total.inKind, acrossYears(1)));
      cells.push(sumCell(row.total.total, acrossYears(2)));
    }
    return { kind: 'data', cells };
  });

  const dataRowCount = rows.length;
  const columnTotal = (c: number, value: number | null): TableCell =>
    sumCell(value, Array.from({ length: dataRowCount }, (_, r) => ({ row: r, col: c })));
  const totalCells: TableCell[] = [{ kind: 'text', text: '합계' }];
  view.yearTotals.forEach((t, i) => {
    totalCells.push(columnTotal(col(i, 0), t.cash), columnTotal(col(i, 1), t.inKind), columnTotal(col(i, 2), t.total));
  });
  const g = view.grandTotal;
  totalCells.push(
    columnTotal(col(totalSlot, 0), g.cash),
    columnTotal(col(totalSlot, 1), g.inKind),
    columnTotal(col(totalSlot, 2), g.total)
  );
  rows.push({ kind: 'total', cells: totalCells });

  return { title, columns, rows };
}
