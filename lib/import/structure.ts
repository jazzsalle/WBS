// 구조 감지 — 헤더 행·데이터 범위·라벨 열·연차 열(S-5)·금액 단위(I-10)·시트 추천(S-13).
// 부수효과 없는 순수 함수다. 단위 테스트: tests/unit/import-structure.test.ts

import { DEFAULT_AMOUNT_UNIT, detectAmountUnit } from './amount';
import { classifyLabel } from './categorize';
import { cellAt, cellText, expandMerges, gridWidth } from './grid';
import { indexToColumnLetter, normalizeLabel } from './normalize';
import type { AmountUnit, AmountUnitHint, MatchContext, RawCell, RawSheet } from './types';

// ─── I-15 상한 ───────────────────────────────────────────────

export const MAX_IMPORT_ROWS = 20_000;

export interface RowLimitCheck {
  ok: boolean;
  rowCount: number;
  limit: number;
}

/** I-15: 20,000행 상한. 초과하면 거부한다 (조용히 잘라 읽지 않는다) */
export function checkRowLimit(rowCount: number): RowLimitCheck {
  return { ok: rowCount <= MAX_IMPORT_ROWS, rowCount, limit: MAX_IMPORT_ROWS };
}

// ─── S-5 연차 열 ─────────────────────────────────────────────

// `1차년도`, `제1차연도`, `1 차 년 도`, `1년차` 모두 받는다. `1단계`는 매칭되지 않아야 한다
const YEAR_ORDER_PATTERNS = [/^제?(\d+)차[년연]도$/, /^제?(\d+)[년연]차$/];

/** S-5: `N차년도` → `yearOrder = N-1`. `N단계` 그룹 헤더는 null을 돌려준다 */
export function parseYearOrderFromLabel(label: string): number | null {
  const compact = String(label).normalize('NFKC').replace(/\s+/g, '');
  if (compact === '') return null;
  // 접미 표기(`1차년도(2026)`)는 괄호를 떼고 본다
  const stripped = compact.replace(/[(（].*$/, '');
  for (const pattern of YEAR_ORDER_PATTERNS) {
    const match = pattern.exec(stripped);
    const n = match?.[1];
    if (n === undefined) continue;
    const order = Number(n) - 1;
    if (Number.isInteger(order) && order >= 0) return order;
  }
  return null;
}

const TOTAL_LABELS = new Set(['합계', '계', '총계', '총합계', '소계', '누계', '총액']);

/** S-5: `합계`/`총계`/`소계` 열은 자동 제외한다 */
export function isTotalColumnLabel(label: string): boolean {
  return TOTAL_LABELS.has(normalizeLabel(label));
}

export interface YearColumn {
  column: string;
  columnIndex: number;
  label: string;
  yearOrder: number;
}

export interface DetectedColumn {
  column: string;
  columnIndex: number;
  label: string;
}

/** 헤더 행에서 연차 열과 합계 열을 갈라낸다 (S-5) */
export function detectYearColumns(
  cells: readonly (readonly RawCell[])[],
  headerRow: number
): { yearColumns: YearColumn[]; totalColumns: DetectedColumn[] } {
  const yearColumns: YearColumn[] = [];
  const totalColumns: DetectedColumn[] = [];
  const width = gridWidth(cells);
  const seen = new Set<number>();

  for (let c = 0; c < width; c += 1) {
    const label = cellText(cellAt(cells, headerRow, c));
    if (label === '') continue;
    if (isTotalColumnLabel(label)) {
      totalColumns.push({ column: indexToColumnLetter(c), columnIndex: c, label });
      continue;
    }
    const order = parseYearOrderFromLabel(label);
    if (order === null) continue;
    // 병합으로 같은 연차 라벨이 여러 열에 펼쳐지면 가장 왼쪽 열만 쓴다
    if (seen.has(order)) continue;
    seen.add(order);
    yearColumns.push({ column: indexToColumnLetter(c), columnIndex: c, label, yearOrder: order });
  }

  return { yearColumns, totalColumns };
}

/** 한 행에 있는 `N차년도` 매칭 수 */
function countYearHeaders(cells: readonly (readonly RawCell[])[], row: number): number {
  const width = gridWidth(cells);
  const orders = new Set<number>();
  for (let c = 0; c < width; c += 1) {
    const order = parseYearOrderFromLabel(cellText(cellAt(cells, row, c)));
    if (order !== null) orders.add(order);
  }
  return orders.size;
}

/**
 * 헤더 행 = `N차년도` 매칭이 가장 많은 행. **동률이면 가장 위쪽 행**을 고른다 —
 * 세로 병합으로 같은 연차 라벨이 두 행에 걸치기 때문이다 (부록 B.6).
 */
export function detectHeaderRow(cells: readonly (readonly RawCell[])[]): number | null {
  let best = -1;
  let bestCount = 0;
  for (let r = 0; r < cells.length; r += 1) {
    const count = countYearHeaders(cells, r);
    if (count > bestCount) {
      bestCount = count;
      best = r;
    }
  }
  return bestCount > 0 ? best : null;
}

// ─── 데이터 범위·라벨 열 ─────────────────────────────────────

type RowVerdict = 'category' | 'skip' | 'other';

function rowVerdict(
  cells: readonly (readonly RawCell[])[],
  row: number,
  labelColumnIndexes: readonly number[],
  context: MatchContext | undefined
): RowVerdict {
  let verdict: RowVerdict = 'other';
  for (const c of labelColumnIndexes) {
    const kind = classifyLabel(cellText(cellAt(cells, row, c)), context).kind;
    if (kind === 'category' || kind === 'ambiguous') return 'category';
    if (kind === 'skip') verdict = 'skip';
  }
  return verdict;
}

export interface DataRange {
  /** 헤더 아래 첫 비목 판정 행. 없으면 headerRow + 1 */
  dataStartRow: number;
  /** 마지막 비목 또는 스킵 판정 행. 라벨 없이 금액만 남은 잔여 행은 범위 밖으로 둔다 */
  dataEndRow: number;
}

export function detectDataRange(
  cells: readonly (readonly RawCell[])[],
  headerRow: number,
  labelColumnIndexes: readonly number[],
  context?: MatchContext
): DataRange {
  let start = -1;
  let end = -1;
  for (let r = headerRow + 1; r < cells.length; r += 1) {
    const verdict = rowVerdict(cells, r, labelColumnIndexes, context);
    if (verdict === 'category' && start === -1) start = r;
    if (verdict !== 'other') end = r;
  }
  if (start === -1) {
    const fallback = Math.min(headerRow + 1, Math.max(cells.length - 1, 0));
    return { dataStartRow: fallback, dataEndRow: Math.max(fallback, end) };
  }
  return { dataStartRow: start, dataEndRow: Math.max(start, end) };
}

/** 라벨 열 = 첫 연차 열 왼쪽에서 데이터 구간에 값이 있는 열 전부 */
export function detectLabelColumns(
  cells: readonly (readonly RawCell[])[],
  firstYearColumnIndex: number,
  startRow: number,
  endRow: number
): number[] {
  const columns: number[] = [];
  for (let c = 0; c < firstYearColumnIndex; c += 1) {
    for (let r = startRow; r <= endRow; r += 1) {
      if (cellText(cellAt(cells, r, c)) !== '') {
        columns.push(c);
        break;
      }
    }
  }
  return columns;
}

// ─── S-1 방향 ────────────────────────────────────────────────

/** S-1: 헤더 행에서 비목이 2개 이상 매칭되면 비목이 열에 있는 서식이다 */
export function detectOrientation(
  cells: readonly (readonly RawCell[])[],
  headerRow: number,
  context?: MatchContext
): 'row' | 'column' {
  const width = gridWidth(cells);
  let hits = 0;
  for (let c = 0; c < width; c += 1) {
    if (classifyLabel(cellText(cellAt(cells, headerRow, c)), context).kind === 'category') hits += 1;
  }
  return hits >= 2 ? 'column' : 'row';
}

// ─── 전체 구조 감지 ──────────────────────────────────────────

export interface DetectedStructure {
  sheetName: string;
  orientation: 'row' | 'column';
  headerRow: number | null;
  dataStartRow: number;
  dataEndRow: number;
  /** 좌→우 순의 엑셀 열 문자 */
  labelColumns: string[];
  labelColumnIndexes: number[];
  yearColumns: YearColumn[];
  /** S-5로 제외한 합계 열 */
  totalColumns: DetectedColumn[];
  /** I-10 근거. 못 찾으면 null이고 unit은 기본값 ×1이다 (자동 확정 아님) */
  amountUnitHint: AmountUnitHint | null;
  amountUnit: AmountUnit;
  rowCount: number;
  rowLimit: RowLimitCheck;
}

/**
 * 힌트 없이 시트 하나의 구조를 추정한다. 결과는 전부 **제안**이고 사용자가 Step 2~3에서 확정한다 (§6.8 대원칙).
 * S-11에 따라 병합을 먼저 펼친 그리드로 판단한다.
 */
export function detectStructure(sheet: RawSheet, context?: MatchContext): DetectedStructure {
  const expanded = expandMerges(sheet);
  const cells = expanded.cells;
  const headerRow = detectHeaderRow(cells);
  const hint = detectAmountUnit(expanded);

  if (headerRow === null) {
    return {
      sheetName: sheet.name,
      orientation: 'row',
      headerRow: null,
      dataStartRow: 0,
      dataEndRow: Math.max(cells.length - 1, 0),
      labelColumns: [],
      labelColumnIndexes: [],
      yearColumns: [],
      totalColumns: [],
      amountUnitHint: hint,
      amountUnit: hint?.unit ?? DEFAULT_AMOUNT_UNIT,
      rowCount: cells.length,
      rowLimit: checkRowLimit(cells.length),
    };
  }

  const { yearColumns, totalColumns } = detectYearColumns(cells, headerRow);
  const firstYearColumnIndex = yearColumns[0]?.columnIndex ?? gridWidth(cells);

  // 라벨 열 후보(첫 연차 열 왼쪽 전부)로 데이터 범위를 먼저 잡고, 그 범위로 라벨 열을 좁힌다
  const candidates = Array.from({ length: firstYearColumnIndex }, (_, c) => c);
  const range = detectDataRange(cells, headerRow, candidates, context);
  const labelColumnIndexes = detectLabelColumns(
    cells,
    firstYearColumnIndex,
    range.dataStartRow,
    range.dataEndRow
  );

  return {
    sheetName: sheet.name,
    orientation: detectOrientation(cells, headerRow, context),
    headerRow,
    dataStartRow: range.dataStartRow,
    dataEndRow: range.dataEndRow,
    labelColumns: labelColumnIndexes.map(indexToColumnLetter),
    labelColumnIndexes,
    yearColumns,
    totalColumns,
    amountUnitHint: hint,
    amountUnit: hint?.unit ?? DEFAULT_AMOUNT_UNIT,
    rowCount: cells.length,
    rowLimit: checkRowLimit(cells.length),
  };
}

// ─── S-13 시트 추천 ──────────────────────────────────────────

export interface SheetScore {
  name: string;
  /** 비목으로 판정된 셀이 하나라도 있는 행 수 */
  categoryRows: number;
  /** 비어 있지 않은 행 수 */
  nonEmptyRows: number;
  /** 헤더로 인정된 행의 `N차년도` 매칭 수 */
  yearHeaderCount: number;
  /** categoryRows / nonEmptyRows. 후보가 아니면 0 */
  score: number;
  /** `N차년도` 헤더가 2개 이상인가 (S-13 게이트) */
  eligible: boolean;
}

/**
 * S-13: 시트 추천 점수 = **비목 판정 행 수 / 비어 있지 않은 행 수**.
 * 단 `N차년도` 헤더가 2개 이상인 시트만 후보다.
 *
 * 행 **수**로 매기면 틀린 시트를 고른다 — 실측 워크북에는 연차별 산출근거 시트(240~250행)가
 * 함께 들어 있어 비목을 훨씬 많이 언급하기 때문이다 (산자부 33행 vs 총괄표 19행).
 */
export function scoreSheet(sheet: RawSheet, context?: MatchContext): SheetScore {
  const cells = expandMerges(sheet).cells;
  const width = gridWidth(cells);

  let categoryRows = 0;
  let nonEmptyRows = 0;
  let yearHeaderCount = 0;

  for (let r = 0; r < cells.length; r += 1) {
    yearHeaderCount = Math.max(yearHeaderCount, countYearHeaders(cells, r));
    let hasContent = false;
    let hasCategory = false;
    for (let c = 0; c < width; c += 1) {
      const text = cellText(cellAt(cells, r, c));
      if (text === '') continue;
      hasContent = true;
      if (!hasCategory && classifyLabel(text, context).kind === 'category') hasCategory = true;
    }
    if (hasContent) nonEmptyRows += 1;
    if (hasCategory) categoryRows += 1;
  }

  const eligible = yearHeaderCount >= 2;
  return {
    name: sheet.name,
    categoryRows,
    nonEmptyRows,
    yearHeaderCount,
    score: eligible && nonEmptyRows > 0 ? categoryRows / nonEmptyRows : 0,
    eligible,
  };
}

export interface SheetRecommendation {
  /** 추천 시트명. 후보가 없으면 첫 시트명 (시트가 없으면 null) */
  recommended: string | null;
  scores: SheetScore[];
}

/**
 * §6.8.1 ②: 시트가 1개면 자동 선택, 여러 개면 S-13 점수가 가장 높은 시트를 **하이라이트**한다.
 * 확정은 언제나 사용자가 한다.
 */
export function recommendSheet(
  sheets: readonly RawSheet[],
  context?: MatchContext
): SheetRecommendation {
  const scores = sheets.map((sheet) => scoreSheet(sheet, context));
  if (sheets.length === 0) return { recommended: null, scores };
  if (sheets.length === 1) return { recommended: sheets[0]!.name, scores };

  let best: SheetScore | null = null;
  for (const score of scores) {
    if (!score.eligible) continue;
    if (best === null || score.score > best.score) best = score;
  }
  return { recommended: best?.name ?? sheets[0]!.name, scores };
}
