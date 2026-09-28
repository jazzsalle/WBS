// 우리 양식 스타일 — 부록 F 상수·exceljs 헬퍼 (SOT 부록 F, §6.16 IN-8, §6.17 GF-8).
//
// SheetJS 커뮤니티판은 셀 서식을 기록하지 못해 Phase 17 양식이 "텍스트만 있으니 알아보기 힘들다"는
// 상태였다. 쓰기 엔진만 exceljs로 바꾸고(IN-8) 보이는 규칙은 전부 여기 한 파일에 모은다 —
// 입력 양식(§7.9.7)과 목표 양식(§6.17)이 같은 헬퍼를 쓰므로 `lib/input-form/**`·`@/types` 밖의
// 앱 모듈은 import하지 않는다. 좌표 맵·파서(`lib/input-form/`)는 서식 라이브러리를 모른다(IN-1·IN-8).
//
// I-13: `import 'server-only'`로 클라이언트 번들 유입을 컴파일 타임에 막는다.
import 'server-only';

import ExcelJS from 'exceljs';

// ─── 상수 (부록 F) ────────────────────────────────────────────────────────────

/** 부록 F 원문 값이다. `samples/exel style.xlsx`를 읽어 얻지 않는다 — 원본은 SOT 표다 */
export const XLSX_STYLE = {
  /** F-1 */
  font: { name: 'Pretendard', size: 10 },
  /** F-8 안내 시트 제목 */
  titleSize: 20,
  color: {
    /** F-1 본문 */
    text: '1A1A1A',
    /** F-1 보조(안내·표시 전용 열) */
    muted: '6B6B6B',
    /** F-2 */
    headerFill: '1A1A1A',
    headerText: 'FFFFFF',
    /** F-3 키 열 */
    keyFill: 'F4F1EA',
    /** F-4 소계·합계 행, F-8 안내 표 라벨 열 */
    summaryFill: 'F7F7F7',
    /** F-4 */
    border: 'DCDCDC',
  },
  /** F-6 — 백분율 서식은 없다(X-7) */
  numFmt: { amount: '#,##0', date: 'yyyy-mm-dd' },
  /** F-8 */
  guide: { labelColumnWidth: 16, valueColumnWidth: 120 },
  /** F-10 */
  tab: { data: '1A1A1A', guide: '1A1A1A' },
} as const;

/** 셀 서식 힌트. `lib/input-form/layout.ts`의 `FormCellFormat` + 수행 양식의 날짜 열(IN-9·F-6) */
export type XlsxCellFormat = 'int' | 'decimal' | 'percent' | 'text' | 'formula' | 'date';

export type XlsxAlign = 'left' | 'center' | 'right';

export interface DataCellHint {
  /** F-3 키 열(사람이 고치면 안 되는 표시 전용 열)이면 true */
  key: boolean;
  format: XlsxCellFormat;
  align: XlsxAlign;
}

// ─── 기본 헬퍼 ────────────────────────────────────────────────────────────────

/** exceljs 색은 불투명 ARGB 문자열이다 — 부록 F의 6자리 hex 앞에 `FF`를 붙인다 */
export function argb(hex: string): string {
  return `FF${hex}`;
}

/**
 * F-6 숫자 서식. 금액·수식 열만 `#,##0`, 날짜 열만 `yyyy-mm-dd`.
 *
 * `percent`는 일부러 undefined다 — 백분율 서식이면 화면의 `10`이 엑셀에서 `1000%`로 보이고
 * 올릴 때 저장값 `0.1`을 ×100 되돌려야 한다(X-7, IN-4의 함정). 일반 숫자로 두면 양방향 모두
 * 값 = 화면 숫자다. 어떤 입력에도 `%`가 든 서식을 돌려주지 않는다.
 */
export function numFmtFor(format: XlsxCellFormat): string | undefined {
  switch (format) {
    case 'int':
    case 'formula':
      return XLSX_STYLE.numFmt.amount;
    case 'date':
      return XLSX_STYLE.numFmt.date;
    case 'decimal':
    case 'percent':
    case 'text':
      return undefined;
  }
}

function baseFont(overrides: Partial<ExcelJS.Font> = {}): Partial<ExcelJS.Font> {
  return {
    name: XLSX_STYLE.font.name,
    size: XLSX_STYLE.font.size,
    color: { argb: argb(XLSX_STYLE.color.text) },
    ...overrides,
  };
}

function solidFill(hex: string): ExcelJS.Fill {
  return { type: 'pattern', pattern: 'solid', fgColor: { argb: argb(hex) } };
}

function edge(style: ExcelJS.BorderStyle): Partial<ExcelJS.Border> {
  return { style, color: { argb: argb(XLSX_STYLE.color.border) } };
}

/** F-4 — 모든 데이터 셀의 4변 thin 테두리 */
function thinBorders(): Partial<ExcelJS.Borders> {
  return { top: edge('thin'), left: edge('thin'), bottom: edge('thin'), right: edge('thin') };
}

/**
 * F-1 열 기본 글꼴. exceljs는 styles.xml의 0번 글꼴(워크북 기본)을 바꾸는 API가 없어서
 * 사용 열 전체에 열 스타일을 깔아 빈 셀까지 Pretendard로 맞춘다(Phase 19 결정 — styles.xml 후처리 없음).
 */
function applyColumnFont(ws: ExcelJS.Worksheet, columnCount: number): void {
  for (let c = 1; c <= columnCount; c += 1) {
    const column = ws.getColumn(c);
    column.style = { ...column.style, font: baseFont() };
  }
}

// ─── 워크북 ───────────────────────────────────────────────────────────────────

export function createStyledWorkbook(): ExcelJS.Workbook {
  const wb = new ExcelJS.Workbook();
  wb.created = new Date();
  return wb;
}

// ─── 데이터 시트 ──────────────────────────────────────────────────────────────

/** F-2 헤더 행: 검정 채움, 흰 굵은 글자, 아래 medium, 세로 가운데·왼쪽, 줄바꿈 */
export function styleHeaderRow(ws: ExcelJS.Worksheet, rowNumber: number, columnCount: number): void {
  const row = ws.getRow(rowNumber);
  for (let c = 1; c <= columnCount; c += 1) {
    const cell = row.getCell(c);
    cell.fill = solidFill(XLSX_STYLE.color.headerFill);
    cell.font = baseFont({ bold: true, color: { argb: argb(XLSX_STYLE.color.headerText) } });
    cell.alignment = { vertical: 'middle', horizontal: 'left', wrapText: true };
    cell.border = { ...thinBorders(), bottom: edge('medium') };
  }
}

/**
 * 데이터 셀 하나. F-3(키 열 채움·보조 글자) · F-4(thin 테두리) · F-5(정렬) · F-6(숫자 서식).
 * 사용자가 적는 열은 채움을 넣지 않는다 — "흰색"이 곧 "여기 적으세요"다(F-3).
 */
export function styleDataCell(cell: ExcelJS.Cell, hint: DataCellHint): void {
  cell.font = hint.key ? baseFont({ color: { argb: argb(XLSX_STYLE.color.muted) } }) : baseFont();
  if (hint.key) cell.fill = solidFill(XLSX_STYLE.color.keyFill);
  cell.border = thinBorders();
  // F-5: 텍스트는 왼쪽·위·줄바꿈, 분류는 가운데, 숫자는 오른쪽. 세로는 텍스트만 top —
  // 여러 줄 텍스트 옆의 숫자·분류가 아래로 처지지 않도록 나머지는 세로 가운데다
  cell.alignment =
    hint.align === 'left'
      ? { horizontal: 'left', vertical: 'top', wrapText: true }
      : { horizontal: hint.align, vertical: 'middle' };
  const numFmt = numFmtFor(hint.format);
  if (numFmt !== undefined) cell.numFmt = numFmt;
}

/** F-4 소계·합계 행: 회색 채움, 굵게, 위 medium. 역할 구분은 호출자가 라벨로 한다 */
export function styleSummaryRow(
  ws: ExcelJS.Worksheet,
  rowNumber: number,
  columnCount: number,
  role: 'subtotal' | 'total',
): void {
  const row = ws.getRow(rowNumber);
  for (let c = 1; c <= columnCount; c += 1) {
    const cell = row.getCell(c);
    cell.fill = solidFill(XLSX_STYLE.color.summaryFill);
    cell.font = baseFont({ bold: true });
    // 총액은 아래도 medium으로 닫아 표의 끝을 드러낸다
    cell.border = {
      ...thinBorders(),
      top: edge('medium'),
      ...(role === 'total' ? { bottom: edge('medium') } : {}),
    };
    if (typeof cell.value === 'number' || cell.formula) {
      cell.alignment = { horizontal: 'right', vertical: 'middle' };
      cell.numFmt = XLSX_STYLE.numFmt.amount;
    } else {
      cell.alignment = { horizontal: 'left', vertical: 'middle' };
    }
  }
}

export interface FinishDataSheetOptions {
  /** 1-based */
  headerRow: number;
  /** 1-based — 이 행 위에서 틀 고정(F-5) */
  dataStartRow: number;
  columnCount: number;
  /** 1-based 열 번호. 너비 0이 아니라 열 숨김이다(F-3) */
  hiddenColumns: number[];
  /** 열별 너비(F-7). 길이가 columnCount보다 짧으면 나머지는 exceljs 기본값 */
  widths: number[];
}

/**
 * 데이터 시트 마무리 — 셀 값·셀 서식을 다 쓴 뒤 한 번 부른다.
 * F-1 열 기본 글꼴 · F-3 숨김 열 · F-5 틀 고정+자동 필터 · F-7 너비 · F-10 인쇄·탭 색.
 */
export function finishDataSheet(ws: ExcelJS.Worksheet, opts: FinishDataSheetOptions): void {
  applyColumnFont(ws, opts.columnCount);
  opts.widths.forEach((width, i) => {
    ws.getColumn(i + 1).width = width;
  });
  for (const c of opts.hiddenColumns) ws.getColumn(c).hidden = true;

  // F-5: 첫 데이터 행 위에서 틀 고정, 헤더 행 자동 필터
  ws.views = [
    { state: 'frozen', xSplit: 0, ySplit: opts.dataStartRow - 1, topLeftCell: `A${opts.dataStartRow}` },
  ];
  ws.autoFilter = {
    from: { row: opts.headerRow, column: 1 },
    to: { row: opts.headerRow, column: opts.columnCount },
  };

  // F-10: 가로, 페이지 너비 맞춤(세로는 제한 없음), 헤더 행 반복
  ws.pageSetup = {
    ...ws.pageSetup,
    orientation: 'landscape',
    fitToPage: true,
    fitToWidth: 1,
    fitToHeight: 0,
    printTitlesRow: `${opts.headerRow}:${opts.headerRow}`,
  };
  ws.properties.tabColor = { argb: argb(XLSX_STYLE.tab.data) };
}

// ─── 작성안내 시트 (F-8) ──────────────────────────────────────────────────────

export interface StyleGuideSheetOptions {
  /** A{titleRow} — 20pt 굵게 */
  titleRow: number;
  /** A{subtitleRow} — 보조 색 */
  subtitleRow: number;
  /** 2열 표(라벨/값)의 첫 행 */
  tableStartRow: number;
  tableRowCount: number;
}

/** F-8 작성안내 시트의 제목·부제·2열 표 서식. 문장은 양식 생성기가 넣는다(§7.9.7) */
export function styleGuideSheet(ws: ExcelJS.Worksheet, opts: StyleGuideSheetOptions): void {
  const title = ws.getCell(`A${opts.titleRow}`);
  title.font = baseFont({ bold: true, size: XLSX_STYLE.titleSize });
  title.alignment = { vertical: 'middle', horizontal: 'left' };

  const subtitle = ws.getCell(`A${opts.subtitleRow}`);
  subtitle.font = baseFont({ color: { argb: argb(XLSX_STYLE.color.muted) } });
  subtitle.alignment = { vertical: 'middle', horizontal: 'left' };

  for (let r = opts.tableStartRow; r < opts.tableStartRow + opts.tableRowCount; r += 1) {
    const label = ws.getCell(r, 1);
    label.fill = solidFill(XLSX_STYLE.color.summaryFill);
    label.font = baseFont({ bold: true });
    label.alignment = { vertical: 'top', horizontal: 'left' };
    label.border = thinBorders();

    const value = ws.getCell(r, 2);
    value.font = baseFont();
    value.alignment = { vertical: 'top', horizontal: 'left', wrapText: true };
    value.border = thinBorders();
  }
}

/** 안내 시트 마무리 — 탭 색(F-10), 라벨·값 열 너비(F-8), 열 기본 글꼴(F-1) */
export function finishGuideSheet(ws: ExcelJS.Worksheet): void {
  applyColumnFont(ws, 2);
  ws.getColumn(1).width = XLSX_STYLE.guide.labelColumnWidth;
  ws.getColumn(2).width = XLSX_STYLE.guide.valueColumnWidth;
  ws.pageSetup = { ...ws.pageSetup, orientation: 'landscape', fitToPage: true, fitToWidth: 1, fitToHeight: 0 };
  ws.properties.tabColor = { argb: argb(XLSX_STYLE.tab.guide) };
}

// ─── 날짜 셀 (F-6) ────────────────────────────────────────────────────────────

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

/**
 * `yyyy-mm-dd` → 날짜 셀에 넣을 Date. **UTC 자정**으로 만든다.
 *
 * exceljs는 Date를 `25569 + getTime()/86400000`(UTC 기준)으로 직렬값화한다. 로컬 자정(`new Date(y, m, d)`)을 넣으면
 * KST에서는 전날 15:00이 되어 직렬값이 소수(…​.625)로 떨어지고 `yyyy-mm-dd`로 보면 **하루 앞당겨진다**.
 * UTC 자정이면 직렬값이 정수라 시간대와 무관하게 같은 날짜다. 달력에 없는 날(`2025-02-30`)은 Date가
 * 조용히 3월로 넘기므로 되돌려 비교해 막는다 — 틀린 날짜를 파일에 쓰면 사용자는 알아챌 방법이 없다.
 */
export function excelDateFromIso(iso: string): Date {
  const m = ISO_DATE.exec(iso);
  if (m === null) throw new Error(`날짜가 yyyy-mm-dd 형식이 아닙니다: ${iso}`);
  const year = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) {
    throw new Error(`존재하지 않는 날짜입니다: ${iso}`);
  }
  return date;
}

// ─── 데이터 유효성 (F-9) ──────────────────────────────────────────────────────

/** 엑셀 인라인 목록 유효성의 한도 — 쉼표 포함 목록 문자열 길이 */
export const INLINE_LIST_MAX_LENGTH = 255;

/**
 * 인라인 목록 수식(`"현금,현물"`). 입력 양식은 `_lists` 시트 없이 이것만 쓴다(F-9).
 *
 * 쉼표는 목록 구분자라 값에 들어가면 한 항목이 둘로 쪼개지고, `"`는 수식 문자열을 닫아 파일이 깨진다.
 * 255자를 넘기면 엑셀이 파일을 복구 대상으로 연다. 셋 다 생성기 실수이므로 조용히 자르지 않고 throw한다.
 */
export function inlineListFormula(values: readonly string[]): string {
  if (values.length === 0) throw new Error('드롭다운 목록이 비어 있습니다.');
  for (const value of values) {
    if (value === '') throw new Error('드롭다운 목록에 빈 값이 있습니다.');
    if (value.includes(',')) throw new Error(`드롭다운 값에 쉼표를 쓸 수 없습니다: ${value}`);
    if (value.includes('"')) throw new Error(`드롭다운 값에 큰따옴표를 쓸 수 없습니다: ${value}`);
  }
  const joined = values.join(',');
  if (joined.length > INLINE_LIST_MAX_LENGTH) {
    throw new Error(
      `드롭다운 목록이 ${joined.length}자로 인라인 한도 ${INLINE_LIST_MAX_LENGTH}자를 넘습니다.`
    );
  }
  return `"${joined}"`;
}

/** 엑셀 시트 이름에 쓸 수 없는 문자(`[]:*?/\`)와 길이 한도 31자 */
const SHEET_NAME_FORBIDDEN = /[[\]:*?/\\]/;
const SHEET_NAME_MAX_LENGTH = 31;
/** 절대 참조 A1 범위(`$A$2:$A$14`) 또는 단일 셀(`$A$2`) */
const ABSOLUTE_A1_RANGE = /^\$[A-Z]{1,3}\$[1-9]\d*(?::\$[A-Z]{1,3}\$[1-9]\d*)?$/;

/**
 * 범위 참조 목록 수식(`'_lists'!$A$2:$A$14`). 목표 양식의 기관·관여자처럼 인라인 한도를 넘을 수 있는 목록,
 * 실적·측정 시트가 같은 파일의 성과목표·기술목표 이름 열을 가리키는 목록(GF-10)에 쓴다(F-9).
 *
 * 시트 이름은 **항상** 작은따옴표로 감싸고 안의 작은따옴표는 두 번 쓴다 — 한글·공백·숫자로 시작하는 이름은
 * 따옴표 없이는 엑셀이 수식을 해석하지 못해 파일을 복구 대상으로 연다. 이름·범위가 엑셀 규칙을 어기면
 * 드롭다운이 조용히 죽으므로 생성기 실수로 보고 throw한다. 범위가 상대 참조면 행마다 목록이 밀린다.
 */
export function rangeListFormula(sheet: string, range: string): string {
  if (sheet === '') throw new Error('드롭다운 목록 시트 이름이 비어 있습니다.');
  if (sheet.length > SHEET_NAME_MAX_LENGTH) {
    throw new Error(`드롭다운 목록 시트 이름이 ${SHEET_NAME_MAX_LENGTH}자를 넘습니다: ${sheet}`);
  }
  if (SHEET_NAME_FORBIDDEN.test(sheet)) {
    throw new Error(`드롭다운 목록 시트 이름에 쓸 수 없는 문자가 있습니다: ${sheet}`);
  }
  if (!ABSOLUTE_A1_RANGE.test(range)) {
    throw new Error(`드롭다운 목록 범위는 절대 참조 A1 형식이어야 합니다 ($A$2:$A$14): ${range}`);
  }
  return `'${sheet.replace(/'/g, "''")}'!${range}`;
}

/** 'warning'은 목록 밖 값을 [예]로 받아들인다 — 관여자 `;` 다중 입력·새로 적은 지표명(GF-4·GF-10) */
const LIST_ERROR_MESSAGE: Record<'stop' | 'warning', string> = {
  stop: '드롭다운 목록에서 고르세요.',
  warning: '목록에 없는 값입니다. 그대로 두려면 [예]를 누르세요 — 올릴 때 다시 검사합니다.',
};

/**
 * 셀 하나에 목록 유효성. 빈 칸은 허용한다 — 축처럼 비어도 되는 열이 있고(IN-11), 필수 여부는 파서가 판정한다.
 * 잘못된 값은 엑셀이 막지만 붙여넣기는 우회하므로 파서가 다시 검사한다(F-9).
 */
export function applyListValidation(
  cell: ExcelJS.Cell,
  formula: string,
  errorStyle: 'stop' | 'warning' = 'stop'
): void {
  cell.dataValidation = {
    type: 'list',
    allowBlank: true,
    formulae: [formula],
    showErrorMessage: true,
    errorStyle,
    errorTitle: '목록에 없는 값',
    error: LIST_ERROR_MESSAGE[errorStyle],
  };
}
