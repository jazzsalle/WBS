// 협약 예산 보기의 표 모델 — [엑셀 내려받기]와 [복사](TSV)의 공통 부품 (SOT §6.19 AG-8·AG-9, 부록 F).
//
// 보기(비목별·변경 이력)는 화면용 계산을 마친 뒤 **하나의 `TableModel`**을 만들고, 엑셀과 TSV는 둘 다 그 모델에서
// 나온다 — 두 경로가 따로 계산하면 "엑셀로 받은 표"와 "붙여 넣은 표"가 언젠가 어긋난다. 그래서 `sum` 칸은
// 엑셀 수식(`SUM`·`B−A`)과 결과값을 함께 들고 다니고, 여기서 결과값이 항들의 합과 같은지 검사한다.
//
// 경계(AG-9): 순수 함수다. xlsx·exceljs·supabase·`lib/db`·`actions`·어댑터를 import하지 않는다. 엑셀 쪽 산출물은
// 서식 라이브러리를 모르는 `FormSheet`(타입만)이고, 실제 바이트는 server-only 어댑터 `writeInputFormWorkbook`이 쓴다 —
// exceljs를 import하는 파일을 늘리지 않기 위해서다(사전 사실 1). 협약 도메인 타입에도 의존하지 않는 범용 표다.

import type { FormCell, FormColumnHint, FormRowRole, FormSheet, InputFormWorkbook } from '@/lib/input-form/types';

// ─── 모델 ─────────────────────────────────────────────────────────────────────

/** 열. `label`이 헤더 1행(병합 없음 — 어댑터가 병합 셀을 모른다, 사전 사실 2)의 그 칸이다 */
export interface TableColumn {
  label: string;
  /** `amount`면 `#,##0`·오른쪽 정렬(F-6·F-5), `text`면 왼쪽 정렬·줄바꿈 */
  type: 'text' | 'amount';
  /** F-3 키 열(연차·비목 같은 표시 라벨 열) — 베이지 채움. 없으면 false */
  key?: boolean;
  /** F-7 엑셀 열 너비(문자 수). 없으면 amount 14 · text 20 */
  width?: number;
}

/**
 * `sum` 칸이 더하는 칸. `row`는 `TableModel.rows`의 0-based 인덱스(헤더 제외), `col`은 0-based 열.
 * `negate`면 뺀다 — 변경 이력의 증감 칸 `=B−A`(AG-8)는 B 항 + A 항(negate)이다.
 */
export interface TableCellRef {
  row: number;
  col: number;
  negate?: boolean;
}

/**
 * 칸. 금액은 **원 단위 정수**다(절대 규칙 4 — 표시 단위 환산 없음, AG-8).
 * - `text`: 문자열 그대로. `''`는 빈 칸과 같게 나간다
 * - `amount`: 입력값 성격의 금액(줄 금액 등). 음수도 된다(증감을 값으로 담을 때)
 * - `sum`: `terms`의 부호 붙은 합. `value`는 호출자가 이미 계산한 값이고 여기서 항들과 대조한다.
 *   엑셀에서는 수식 + 결과값, TSV에서는 값
 * - `empty`: 줄이 없는 칸. 금액 0과 구별된다(절대 규칙 5). `sum`의 항으로 쓰이면 0이다(엑셀 SUM과 같다)
 */
export type TableCell =
  | { kind: 'text'; text: string }
  | { kind: 'amount'; value: number }
  | { kind: 'sum'; value: number; terms: TableCellRef[] }
  | { kind: 'empty' };

/** 행 역할. `subtotal`·`total`은 엑셀에서 F-4 합계 행 서식(회색·굵게·위 medium)이 된다 */
export type TableRowKind = 'data' | 'subtotal' | 'total';

export interface TableRow {
  kind: TableRowKind;
  /** `TableModel.columns`와 같은 길이 */
  cells: TableCell[];
}

/** 표 하나 = 제목 + 헤더 1행(`columns`의 라벨) + 행. 제목은 화면·인쇄 머리말용이고 격자(TSV·시트)에는 넣지 않는다 */
export interface TableModel {
  title: string;
  columns: TableColumn[];
  rows: TableRow[];
}

// ─── 검증 ─────────────────────────────────────────────────────────────────────

/**
 * 모델이 스스로 모순이 없는지 본다. 어긋난 모델을 조용히 내보내면 엑셀(수식이 다시 계산한 값)과
 * TSV(`value`)가 서로 다른 숫자를 보여 준다 — 사용자는 어느 쪽이 맞는지 알 길이 없다.
 */
export function assertTableModel(model: TableModel): void {
  const width = model.columns.length;
  if (width === 0) throw new Error(`'${model.title}' 표에 열이 없습니다.`);

  model.rows.forEach((row, r) => {
    if (row.cells.length !== width) {
      throw new Error(`'${model.title}' 표 ${r + 1}번째 행의 칸 수(${row.cells.length})가 열 수(${width})와 다릅니다.`);
    }
    row.cells.forEach((cell, c) => {
      const where = `'${model.title}' 표 ${r + 1}행 ${c + 1}열`;
      if ((cell.kind === 'amount' || cell.kind === 'sum') && !Number.isSafeInteger(cell.value)) {
        throw new Error(`${where}: 금액이 원 단위 정수가 아닙니다 (${cell.value}).`);
      }
      if (cell.kind === 'sum') assertSumTerms(model, cell, r, c, where);
    });
  });

  assertNoSumCycle(model);
}

function cellAt(model: TableModel, ref: TableCellRef): TableCell | undefined {
  return model.rows[ref.row]?.cells[ref.col];
}

function assertSumTerms(
  model: TableModel,
  cell: Extract<TableCell, { kind: 'sum' }>,
  r: number,
  c: number,
  where: string
): void {
  // 항 없는 SUM()은 엑셀에서 오류다 — 0이 의도라면 호출자가 amount 0을 쓴다
  if (cell.terms.length === 0) throw new Error(`${where}: 합계 칸에 더할 칸이 없습니다.`);
  const seen = new Set<string>();
  let total = 0;
  for (const ref of cell.terms) {
    const key = `${ref.row}:${ref.col}`;
    if (ref.row === r && ref.col === c) throw new Error(`${where}: 합계 칸이 자기 자신을 더합니다.`);
    // 같은 칸을 두 번 세면 엑셀 범위 묶기에서 한 번으로 줄어 값이 달라진다
    if (seen.has(key)) throw new Error(`${where}: 같은 칸(${ref.row + 1}행 ${ref.col + 1}열)을 두 번 더합니다.`);
    seen.add(key);
    const target = cellAt(model, ref);
    if (target === undefined) {
      throw new Error(`${where}: 표 밖의 칸(${ref.row + 1}행 ${ref.col + 1}열)을 더합니다.`);
    }
    if (target.kind === 'text') {
      throw new Error(`${where}: 글자 칸(${ref.row + 1}행 ${ref.col + 1}열)을 더합니다.`);
    }
    const v = target.kind === 'empty' ? 0 : target.value;
    total += ref.negate === true ? -v : v;
  }
  if (total !== cell.value) {
    throw new Error(`${where}: 합계 값(${cell.value})이 항들의 합(${total})과 다릅니다.`);
  }
}

/** 합계가 합계를 더하는 것은 허용하되(연차 합 → 총계) 순환은 엑셀 순환 참조라 막는다 */
function assertNoSumCycle(model: TableModel): void {
  const state = new Map<string, 'visiting' | 'done'>();
  const visit = (row: number, col: number): void => {
    const key = `${row}:${col}`;
    const mark = state.get(key);
    if (mark === 'done') return;
    if (mark === 'visiting') {
      throw new Error(`'${model.title}' 표 ${row + 1}행 ${col + 1}열: 합계 칸이 순환 참조합니다.`);
    }
    const cell = model.rows[row]?.cells[col];
    if (cell?.kind !== 'sum') {
      state.set(key, 'done');
      return;
    }
    state.set(key, 'visiting');
    for (const ref of cell.terms) visit(ref.row, ref.col);
    state.set(key, 'done');
  };
  model.rows.forEach((row, r) => row.cells.forEach((_, c) => visit(r, c)));
}

// ─── TSV ([복사]) ─────────────────────────────────────────────────────────────

/** 탭·개행·따옴표가 든 칸만 `"…"`로 감싸고 `"`는 `""` — 엑셀 붙여넣기가 받는 규약이다 */
function tsvField(text: string): string {
  return /[\t\r\n"]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

/** TSV 한 칸의 값. 금액은 구분 기호 없는 원 단위 정수 — 엑셀이 숫자로 받는다(AG-8) */
function tsvValue(cell: TableCell): string {
  switch (cell.kind) {
    case 'text':
      return tsvField(cell.text);
    case 'amount':
    case 'sum':
      return String(cell.value);
    case 'empty':
      return '';
  }
}

/**
 * 표 → TSV. 헤더 1행 + 행, 행 구분 `\r\n`(끝에 붙이지 않는다 — 붙이면 엑셀이 빈 행을 하나 더 붙인다).
 * 수식이 아니라 값이다 — 붙여 넣은 곳의 셀 주소가 시트와 달라 수식을 옮기면 엉뚱한 칸을 더한다.
 */
export function toTsv(model: TableModel): string {
  assertTableModel(model);
  const lines = [
    model.columns.map((col) => tsvField(col.label)).join('\t'),
    ...model.rows.map((row) => row.cells.map(tsvValue).join('\t')),
  ];
  return lines.join('\r\n');
}

// ─── 엑셀 셀 (FormSheet) ──────────────────────────────────────────────────────

/** 시트의 헤더 행(1-based). 헤더 1행이고 그 위에 아무것도 두지 않는다 — TSV와 격자가 같아야 한다 */
const HEADER_ROW = 1;
const FIRST_DATA_ROW = HEADER_ROW + 1;

/** SUM 인자 한도(엑셀 255). 범위로 묶은 뒤에도 넘으면 표를 쪼개야 한다 — 조용히 자르지 않는다 */
const MAX_SUM_ARGS = 255;

/** 0-based 열 → A1 열 문자(`0` → `A`, `26` → `AA`) */
export function columnLetter(index: number): string {
  if (!Number.isInteger(index) || index < 0) throw new Error(`열 인덱스가 올바르지 않습니다: ${index}`);
  let n = index + 1;
  let out = '';
  while (n > 0) {
    const rem = (n - 1) % 26;
    out = String.fromCharCode(65 + rem) + out;
    n = Math.floor((n - 1) / 26);
  }
  return out;
}

function address(row: number, col: number): string {
  return `${columnLetter(col)}${row + FIRST_DATA_ROW}`;
}

/**
 * 같은 열의 연속 행 → 세로 범위, 남은 칸 중 같은 행의 연속 열 → 가로 범위. 나머지는 단일 칸.
 * 결과 순서는 결정적이다(같은 모델이면 같은 수식).
 */
function compactRefs(refs: readonly TableCellRef[]): { text: string; single: boolean }[] {
  const byCol = [...refs].sort((a, b) => a.col - b.col || a.row - b.row);
  const out: { text: string; single: boolean }[] = [];
  const singles: TableCellRef[] = [];
  let i = 0;
  while (i < byCol.length) {
    const start = byCol[i]!;
    let j = i;
    while (j + 1 < byCol.length && byCol[j + 1]!.col === start.col && byCol[j + 1]!.row === byCol[j]!.row + 1) j += 1;
    if (j > i) out.push({ text: `${address(start.row, start.col)}:${address(byCol[j]!.row, start.col)}`, single: false });
    else singles.push(start);
    i = j + 1;
  }
  singles.sort((a, b) => a.row - b.row || a.col - b.col);
  i = 0;
  while (i < singles.length) {
    const start = singles[i]!;
    let j = i;
    while (j + 1 < singles.length && singles[j + 1]!.row === start.row && singles[j + 1]!.col === singles[j]!.col + 1) j += 1;
    if (j > i) out.push({ text: `${address(start.row, start.col)}:${address(start.row, singles[j]!.col)}`, single: false });
    else out.push({ text: address(start.row, start.col), single: true });
    i = j + 1;
  }
  return out;
}

function sumCall(args: { text: string }[], where: string): string {
  if (args.length > MAX_SUM_ARGS) {
    throw new Error(`${where}: 합계 수식의 항(${args.length}개)이 엑셀 한도(${MAX_SUM_ARGS})를 넘습니다.`);
  }
  return `SUM(${args.map((a) => a.text).join(',')})`;
}

/** 한 칸이면 그 주소, 아니면 SUM(…) — `=C2-B2`처럼 증감 수식이 읽기 쉽도록 */
function operand(args: { text: string; single: boolean }[], where: string): string {
  if (args.length === 1 && args[0]!.single) return args[0]!.text;
  return sumCall(args, where);
}

/** `sum` 칸의 수식(`=` 없이 — FormCell 규약). 빼는 항이 없으면 `SUM(…)`, 있으면 `더하는 쪽-빼는 쪽` */
export function sumFormula(terms: readonly TableCellRef[], where = '합계 칸'): string {
  const plus = compactRefs(terms.filter((t) => t.negate !== true));
  const minus = compactRefs(terms.filter((t) => t.negate === true));
  if (minus.length === 0) return sumCall(plus, where);
  const left = plus.length === 0 ? '0' : operand(plus, where);
  return `${left}-${operand(minus, where)}`;
}

function formCell(cell: TableCell, where: string): FormCell {
  switch (cell.kind) {
    case 'text':
      // '' 문자열 셀을 쓰면 "값 있는 빈 칸"이 된다 — TSV의 ''와 같게 빈 칸으로
      return cell.text === '' ? {} : { value: cell.text };
    case 'amount':
      return { value: cell.value };
    case 'sum':
      // 결과값을 함께 싣는다 — 엑셀이 다시 계산하기 전에도(미리보기·다른 뷰어) 앱과 같은 숫자가 보인다(AG-8)
      return { formula: sumFormula(cell.terms, where), result: cell.value };
    case 'empty':
      return {};
  }
}

/** 시트 이름 규칙(엑셀): 1~31자, `[]:*?/\` 금지, 앞뒤 작은따옴표 금지 */
function assertSheetName(name: string): void {
  if (name.length === 0 || name.length > 31) {
    throw new Error(`시트 이름은 1~31자여야 합니다: '${name}' (${name.length}자)`);
  }
  if (/[[\]:*?/\\]/.test(name)) throw new Error(`시트 이름에 쓸 수 없는 문자가 있습니다: '${name}'`);
  if (name.startsWith("'") || name.endsWith("'")) {
    throw new Error(`시트 이름은 작은따옴표로 시작하거나 끝날 수 없습니다: '${name}'`);
  }
}

function columnHint(col: TableColumn): FormColumnHint {
  return col.type === 'amount'
    ? { key: col.key ?? false, format: 'int', width: col.width ?? 14, align: 'right' }
    : { key: col.key ?? false, format: 'text', width: col.width ?? 20, align: 'left' };
}

/**
 * 표 → 데이터 시트(부록 F). 1행 헤더(F-2), 2행부터 데이터, 합계 행은 F-4, 금액 열 `#,##0`(F-6),
 * 틀 고정 `A2`·자동 필터·너비·인쇄·탭 색(F-5·F-7·F-10)은 힌트가 다 있으므로 어댑터가 입힌다.
 * 격자는 TSV와 칸마다 같다(제목은 넣지 않는다).
 */
export function toFormSheet(model: TableModel, sheetName: string): FormSheet {
  assertTableModel(model);
  assertSheetName(sheetName);
  const header: FormCell[] = model.columns.map((col) => ({ value: col.label }));
  const body: FormCell[][] = model.rows.map((row, r) =>
    row.cells.map((cell, c) => formCell(cell, `'${sheetName}'!${address(r, c)}`))
  );
  const rowRoles: FormRowRole[] = ['header', ...model.rows.map((row) => row.kind)];
  return {
    name: sheetName,
    hidden: false,
    rows: [header, ...body],
    hiddenColumns: [],
    kind: 'data',
    headerRow: HEADER_ROW,
    dataStartRow: FIRST_DATA_ROW,
    columnHints: model.columns.map(columnHint),
    rowRoles,
  };
}

// ─── 작성안내·워크북 ──────────────────────────────────────────────────────────

/** AG-8 — 첫 시트(F-8). 입력 양식과 같은 이름이지만 그쪽 상수를 값으로 끌어오지 않는다(경계: 타입만) */
export const AGREEMENT_GUIDE_SHEET_NAME = '작성안내';

/** F-8 작성안내 내용. 문장은 보기별 생성기(내보내기 액션)가 정한다 */
export interface TableGuide {
  /** A1 — `{과제명} — {양식 이름}` */
  title: string;
  /** A2 — `생성 {일시} · {버전} · {모드}` */
  subtitle: string;
  /** A4부터 2열 표 `[라벨, 본문]` */
  entries: { label: string; body: string }[];
}

/** F-8 격자: A1 제목, A2 부제, 3행 빈 줄, A4부터 2열 표 — 어댑터의 `kind: 'guide'` 서식 좌표와 같다 */
export function toGuideSheet(guide: TableGuide): FormSheet {
  const rows: FormCell[][] = [
    [{ value: guide.title }],
    [{ value: guide.subtitle }],
    [],
    ...guide.entries.map((e) => [{ value: e.label }, { value: e.body }]),
  ];
  return { name: AGREEMENT_GUIDE_SHEET_NAME, hidden: false, rows, hiddenColumns: [], kind: 'guide' };
}

/** 작성안내를 첫 시트로, 이어서 표마다 데이터 시트 하나(AG-8). 쓰기는 `writeInputFormWorkbook`(server-only) */
export function toFormWorkbook(input: {
  guide: TableGuide;
  tables: { sheetName: string; model: TableModel }[];
  fileName: string;
}): InputFormWorkbook {
  if (input.tables.length === 0) throw new Error('내보낼 표가 하나도 없습니다.');
  const sheets = [toGuideSheet(input.guide), ...input.tables.map((t) => toFormSheet(t.model, t.sheetName))];
  const seen = new Set<string>();
  for (const sheet of sheets) {
    if (seen.has(sheet.name)) throw new Error(`시트 이름이 중복됩니다: ${sheet.name}`);
    seen.add(sheet.name);
  }
  return { sheets, fileName: input.fileName };
}

// ─── 파일명 ───────────────────────────────────────────────────────────────────

// X-12 파일명 규칙과 같은 치환(`lib/goal-form/build.ts`와 같은 이유로 여기 사본을 둔다 — 경계 밖 값 import 금지)
const FORBIDDEN_FILENAME_CHARS = /[\\/:*?"<>|]|\p{Cc}/gu;

function sanitizeFileNamePart(text: string, fallback: string): string {
  const cleaned = text.replace(FORBIDDEN_FILENAME_CHARS, '_').replace(/\s+/g, ' ').trim();
  // 끝의 점·공백은 윈도우가 조용히 잘라내 파일명이 달라진다
  const trimmed = cleaned.replace(/[. ]+$/, '');
  return trimmed === '' ? fallback : trimmed;
}

/**
 * `{과제명}_협약예산_{버전 이름 또는 A→B}_{YYYYMMDD}.xlsx`(AG-8). `label`은 호출자가 만든다
 * (비목별 = 버전 이름, 변경 이력 = `A→B`). 날짜 형식이 어긋나면 던진다 — 날짜 없는 파일명은 최신을 고를 수 없다.
 */
export function agreementWorkbookFileName(projectName: string, label: string, todayISO: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(todayISO);
  if (!match) throw new Error(`생성일이 YYYY-MM-DD 형식이 아니다: ${todayISO}`);
  const projectPart = sanitizeFileNamePart(projectName, '과제');
  const labelPart = sanitizeFileNamePart(label, '버전');
  return `${projectPart}_협약예산_${labelPart}_${match[1]}${match[2]}${match[3]}.xlsx`;
}
