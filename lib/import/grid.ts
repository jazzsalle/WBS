// 그리드 전처리 — S-11 병합 확장, S-2/S-2' 라벨 carry-forward (SOT §6.8.2).
// 부수효과 없는 순수 함수다 (입력 시트를 변형하지 않는다). 단위 테스트: tests/unit/import-grid.test.ts

import type { MergeRange, RawCell, RawSheet } from './types';

export const EMPTY_CELL: RawCell = { value: null, isError: false };

/** 셀 텍스트. 에러 셀은 원문(`#REF!`)을 그대로 돌려준다 — 미리보기에 그대로 보여야 한다 */
export function cellText(cell: RawCell | undefined | null): string {
  if (!cell) return '';
  if (cell.isError) return (cell.errorText ?? String(cell.value ?? '')).trim();
  const value = cell.value;
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value.trim();
  return String(value);
}

export function cellAt(
  cells: readonly (readonly RawCell[])[],
  row: number,
  column: number
): RawCell {
  return cells[row]?.[column] ?? EMPTY_CELL;
}

export function gridWidth(cells: readonly (readonly RawCell[])[]): number {
  let width = 0;
  for (const row of cells) width = Math.max(width, row.length);
  return width;
}

/** 들쭉날쭉한 행 길이를 맞춘다. 이후 로직이 `undefined` 분기를 반복하지 않게 하는 전처리다 */
export function normalizeGrid(
  cells: readonly (readonly RawCell[])[],
  minWidth = 0,
  minHeight = 0
): RawCell[][] {
  const width = Math.max(gridWidth(cells), minWidth);
  const height = Math.max(cells.length, minHeight);
  const grid: RawCell[][] = [];
  for (let r = 0; r < height; r += 1) {
    const source = cells[r];
    const row: RawCell[] = new Array<RawCell>(width);
    for (let c = 0; c < width; c += 1) row[c] = source?.[c] ?? EMPTY_CELL;
    grid.push(row);
  }
  return grid;
}

function isValidMerge(merge: MergeRange): boolean {
  return (
    Number.isInteger(merge.s.r) &&
    Number.isInteger(merge.s.c) &&
    Number.isInteger(merge.e.r) &&
    Number.isInteger(merge.e.c) &&
    merge.s.r >= 0 &&
    merge.s.c >= 0 &&
    merge.e.r >= merge.s.r &&
    merge.e.c >= merge.s.c
  );
}

/**
 * S-11: 병합 범위를 **먼저** 펼쳐 범위 내 모든 셀에 좌상단 값을 채운다. S-2 carry-forward보다 앞선다.
 *
 * 확장하지 않으면 `C16:E16`처럼 라벨 열들을 가로지르는 메모 행에서 D·E열이 빈 셀로 남아
 * 위 행의 축 라벨(`현물`)을 잘못 승계하고 메모 행이 금액 행으로 둔갑한다.
 */
export function expandMerges(sheet: RawSheet): RawSheet {
  const merges = sheet.merges.filter(isValidMerge);
  let minWidth = 0;
  let minHeight = 0;
  for (const merge of merges) {
    minWidth = Math.max(minWidth, merge.e.c + 1);
    minHeight = Math.max(minHeight, merge.e.r + 1);
  }
  const grid = normalizeGrid(sheet.cells, minWidth, minHeight);

  for (const merge of merges) {
    const source = grid[merge.s.r]?.[merge.s.c] ?? EMPTY_CELL;
    for (let r = merge.s.r; r <= merge.e.r; r += 1) {
      const row = grid[r];
      if (!row) continue;
      for (let c = merge.s.c; c <= merge.e.c; c += 1) row[c] = source;
    }
  }

  return { name: sheet.name, cells: grid, merges: sheet.merges };
}

// ─── S-2 / S-2' 라벨 carry-forward ───────────────────────────

export interface LabelGrid {
  /** 대상 범위의 첫 행 (0-based, 시트 기준) */
  startRow: number;
  /** [행][라벨열] 병합 확장 후 원본 텍스트 (carry-forward 전) */
  raw: string[][];
  /** [행][라벨열] carry-forward를 적용한 유효 라벨 */
  effective: string[][];
}

/**
 * S-2 병합 셀 carry-forward + S-2' 미매핑 라벨 배제.
 *
 * - 라벨 열의 빈 셀은 그 열에서 **마지막으로 판정에 성공한 값**을 이어받는다 (S-2, S-2').
 * - 리셋: 어떤 라벨 열에 **직전 행과 다른 판정값**이 나타나면 그보다 오른쪽 열의 승계를 초기화한다.
 *   병합으로 같은 값이 반복되는 것은 새 값이 아니다 (S-11 단서).
 * - 판정되지 않은 라벨(세로쓰기 조각 `직`/`접`/`비`)은 그 행에서는 그대로 보이지만 아래로는
 *   흘리지 않고, 리셋 판정에도 끼지 않는다 (S-2'). 끼워 넣으면 행안부 12~14행에서
 *   우측 라벨의 승계가 끊겨 현물 행이 통째로 미매핑된다.
 *
 * @param isCarryForwardable 판정 성공 여부. categorize.isCarryForwardable을 넘긴다
 */
export function buildLabelGrid(
  cells: readonly (readonly RawCell[])[],
  labelColumnIndexes: readonly number[],
  startRow: number,
  endRow: number,
  isCarryForwardable: (raw: string) => boolean
): LabelGrid {
  const width = labelColumnIndexes.length;
  const raw: string[][] = [];
  const effective: string[][] = [];

  const carried: string[] = new Array<string>(width).fill('');
  let prevDetermined: string[] = new Array<string>(width).fill('');

  for (let r = startRow; r <= endRow; r += 1) {
    const rowRaw: string[] = [];
    const determined: string[] = [];
    for (let i = 0; i < width; i += 1) {
      const text = cellText(cellAt(cells, r, labelColumnIndexes[i]!));
      rowRaw.push(text);
      determined.push(text !== '' && isCarryForwardable(text) ? text : '');
    }

    // 리셋: 판정값이 직전 행과 달라진 **가장 왼쪽** 열보다 오른쪽의 승계를 버린다
    let changedAt = -1;
    for (let i = 0; i < width; i += 1) {
      if (determined[i] !== '' && determined[i] !== prevDetermined[i]) {
        changedAt = i;
        break;
      }
    }
    if (changedAt !== -1) {
      for (let i = changedAt + 1; i < width; i += 1) carried[i] = '';
    }

    const rowEffective: string[] = [];
    for (let i = 0; i < width; i += 1) {
      const own = rowRaw[i]!;
      rowEffective.push(own !== '' ? own : carried[i]!);
      // S-2': 판정에 성공한 값만 아래로 넘긴다
      if (determined[i] !== '') carried[i] = determined[i]!;
    }

    raw.push(rowRaw);
    effective.push(rowEffective);
    prevDetermined = determined;
  }

  return { startRow, raw, effective };
}
