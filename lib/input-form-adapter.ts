// exceljs 쓰기 어댑터 — 사업비 입력 양식(`InputFormWorkbook`)을 xlsx 바이트로 만든다 (SOT §6.16 IN-2·IN-7·IN-8, 부록 F).
//
// `lib/export-adapter.ts`·`lib/import-adapter.ts`와 같은 자리, 같은 이유다. `lib/input-form/`은
// "어느 값이 어느 칸에 있는가"만 다루는 서식 라이브러리 무의존 층이라(IN-8) 워크북을 실제로 만드는 일은
// 여기 한 곳에 모인다. 쓰기는 exceljs다 — SheetJS 커뮤니티판은 셀 서식을 기록하지 못해 Phase 17 양식이
// 서식 없는 텍스트뿐이었다. 읽기는 새로 만들지 않는다 — 올린 양식은 `lib/import-adapter.readUploadedWorkbook`이
// 만든 RawSheet(숨김 시트 포함)를 파서가 고정 좌표로 읽는다(IN-1).
//
// 보이는 규칙(글꼴·채움·테두리·너비)은 전부 `lib/xlsx-style.ts`(부록 F)에 있다. 여기는 FormSheet의
// **힌트**(kind·headerRow·dataStartRow·columnHints·rowRoles·validations)를 그 헬퍼 호출로 옮길 뿐, 색·서식 문자열을
// 직접 쓰지 않는다. 힌트가 없는 FormSheet는 값·수식·숨김만 쓴다(`_meta`가 그렇다).
//
// I-13: `import 'server-only'`로 클라이언트 번들 유입을 컴파일 타임에 막는다.
import 'server-only';

import ExcelJS from 'exceljs';
import type { FormCell, FormRowRole, FormSheet, InputFormWorkbook } from '@/lib/input-form/types';
import {
  applyListValidation,
  createStyledWorkbook,
  excelDateFromIso,
  finishDataSheet,
  finishGuideSheet,
  inlineListFormula,
  rangeListFormula,
  styleDataCell,
  styleGuideSheet,
  styleHeaderRow,
  styleSummaryRow,
} from '@/lib/xlsx-style';

// ─── 셀 ───────────────────────────────────────────────────────────────────────

/**
 * FormCell → exceljs 셀 값. 값도 수식도 없으면 아무것도 쓰지 않는다(서식만 남을 수 있다).
 *
 * **숫자 서식은 여기서 붙이지 않는다** — 열 힌트를 받은 `styleDataCell`이 `numFmtFor`로만 정한다.
 * 참여율·인자 열이 백분율 서식이면 화면의 `10`이 엑셀에서 `1000%`로 보이고(X-7), 올릴 때는 저장값이
 * `0.1`이라 D-22의 ×100 되돌리기가 필요해진다 — 임포트에서 금액이 1/100로 어긋난 바로 그 함정이다.
 * 일반 숫자로 두면 양방향 모두 값 = 화면 숫자다.
 *
 * 수식 셀은 **`result` 없이** `{ formula }`만 쓴다(IN-7). exceljs는 result가 없으면 `<v>`를 아예 쓰지 않는다
 * (`<c r="N2"><f>…</f></c>`). 캐시를 넣으면 엑셀이 다시 계산하기 전까지 우리가 계산한 값이 보이는데, 그 값이
 * 앱 산식과 어긋나는 순간을 사용자가 알 길이 없다. 빈 채로 두면 엑셀이 열면서 계산하고, 앱은 어차피 금액 열을
 * 읽지 않는다(IN-3). 올리기 경로(`readWorkbook`, cellFormula:false)는 이 셀을 레코드 없음 → null로 읽는다.
 * 테스트가 SheetJS로 `f`를 확인하려면 `sheetStubs`(또는 `cellStyles`)가 필요하다 — 없으면 SheetJS가 v=0을
 * 합성한 뒤 빈 숫자로 보고 레코드째 버린다.
 */
function writeCellValue(target: ExcelJS.Cell, cell: FormCell, where: string, asDate: boolean): void {
  if (typeof cell.formula === 'string') {
    const formula = cell.formula.trim();
    if (formula === '') throw new Error(`${where}: 수식이 비어 있습니다.`);
    // 규약은 `=` 없는 수식이다(types.ts). 앞에 `=`가 붙은 채 쓰면 엑셀이 `==A1`로 읽어 열자마자
    // 오류 셀이 된다 — 조용히 떼지 않고 생성기의 실수를 여기서 드러낸다
    if (formula.startsWith('=')) {
      throw new Error(`${where}: 수식은 '=' 없이 담아야 합니다 (${formula}).`);
    }
    target.value = { formula };
    return;
  }

  const value = cell.value;
  if (value === undefined || value === null) return;
  if (typeof value === 'number') {
    // NaN·Infinity는 exceljs가 그대로 <v>에 흘려 엑셀이 열지 못하는 파일이 된다.
    // 금액·참여율 계산이 깨진 신호이므로 막는다
    if (!Number.isFinite(value)) throw new Error(`${where}: 유한한 숫자가 아닙니다 (${value}).`);
    target.value = value;
    return;
  }
  if (asDate && value !== '') {
    // F-6 날짜 셀. 문자열로 두면 엑셀이 날짜로 정렬·필터하지 못한다. 형식이 틀리면 조용히 텍스트로 남기지 않는다
    try {
      target.value = excelDateFromIso(value);
    } catch (e) {
      throw new Error(`${where}: ${e instanceof Error ? e.message : String(e)}`);
    }
    return;
  }
  // 날짜 열의 빈 문자열은 빈 셀이다 — ''를 쓰면 빈 문자열 셀이 생겨 파서가 "값 있음"으로 오인할 수 있다
  if (asDate) return;
  target.value = value;
}

// ─── 시트 ─────────────────────────────────────────────────────────────────────

/** 힌트 검사 — 생성기와 어긋난 힌트를 조용히 절반만 적용하지 않는다 */
function assertHints(sheet: FormSheet, columnCount: number): void {
  const { columnHints, rowRoles, headerRow, dataStartRow } = sheet;
  if (columnHints !== undefined && columnHints.length < columnCount) {
    throw new Error(
      `'${sheet.name}' 시트의 열 힌트 수(${columnHints.length})가 열 수(${columnCount})보다 적습니다.`
    );
  }
  if (rowRoles !== undefined && rowRoles.length !== sheet.rows.length) {
    throw new Error(
      `'${sheet.name}' 시트의 행 역할 수(${rowRoles.length})와 행 수(${sheet.rows.length})가 다릅니다.`
    );
  }
  if (headerRow !== undefined && (!Number.isInteger(headerRow) || headerRow < 1)) {
    throw new Error(`'${sheet.name}' 시트의 헤더 행이 올바르지 않습니다: ${headerRow}`);
  }
  if (dataStartRow !== undefined && (!Number.isInteger(dataStartRow) || dataStartRow <= (headerRow ?? 1))) {
    throw new Error(`'${sheet.name}' 시트의 데이터 시작 행이 올바르지 않습니다: ${dataStartRow}`);
  }
}

/**
 * 드롭다운을 걸 0-based 행(F-9, types.ts `validations`). rowRoles가 있으면 'data' 행만, 없으면 dataStartRow부터 끝까지.
 * 소계·총액 행은 수식이라 목록이 의미 없고, 헤더에 걸면 라벨이 "목록에 없는 값"이 된다.
 */
function validationRows(sheet: FormSheet): number[] {
  if (sheet.rowRoles !== undefined) {
    return sheet.rowRoles.flatMap((role, r) => (role === 'data' ? [r] : []));
  }
  const start = (sheet.dataStartRow ?? (sheet.headerRow ?? 1) + 1) - 1;
  const out: number[] = [];
  for (let r = start; r < sheet.rows.length; r += 1) out.push(r);
  return out;
}

function applyValidations(
  ws: ExcelJS.Worksheet,
  sheet: FormSheet,
  columnCount: number,
  sheetNames: ReadonlySet<string>
): void {
  if (sheet.validations === undefined) return;
  const seen = new Set<number>();
  const rows = validationRows(sheet);
  for (const validation of sheet.validations) {
    const { column } = validation;
    if (!Number.isInteger(column) || column < 0 || column >= columnCount) {
      throw new Error(`'${sheet.name}' 시트의 드롭다운 열 인덱스가 올바르지 않습니다: ${column}`);
    }
    // 같은 열에 두 목록이면 뒤의 것이 앞을 덮는다 — 어느 쪽이 의도였는지 여기서는 알 수 없다
    if (seen.has(column)) throw new Error(`'${sheet.name}' 시트의 드롭다운 열이 중복됩니다: ${column}`);
    seen.add(column);
    const where = `'${sheet.name}' 시트 ${column}번 열`;
    const { listRange } = validation;
    // 둘 다 있으면 인라인 목록과 범위 중 어느 쪽이 의도였는지 알 수 없다(types.ts 규약: listRange면 values는 [])
    if (listRange !== undefined && validation.values.length > 0) {
      throw new Error(`${where}: 드롭다운에 목록 값과 목록 범위를 함께 지정했습니다.`);
    }
    // 없는 시트를 가리키면 엑셀은 드롭다운을 빈 목록으로 보여줄 뿐이라 아무도 알아채지 못한다
    if (listRange !== undefined && !sheetNames.has(listRange.sheet)) {
      throw new Error(`${where}: 드롭다운 목록 시트 '${listRange.sheet}'가 워크북에 없습니다.`);
    }
    let formula: string;
    try {
      formula =
        listRange !== undefined
          ? rangeListFormula(listRange.sheet, listRange.range)
          : inlineListFormula(validation.values);
    } catch (e) {
      throw new Error(`${where}: ${e instanceof Error ? e.message : String(e)}`);
    }
    const errorStyle = validation.errorStyle ?? 'stop';
    for (const r of rows) applyListValidation(ws.getCell(r + 1, column + 1), formula, errorStyle);
  }
}

/** rowRoles가 없을 때의 기본 — 헤더 행까지는 header, 나머지는 data(types.ts) */
function rowRoleOf(sheet: FormSheet, rowIndex: number, headerRow: number): FormRowRole {
  if (sheet.rowRoles !== undefined) return sheet.rowRoles[rowIndex] ?? 'data';
  return rowIndex + 1 <= headerRow ? 'header' : 'data';
}

/**
 * 데이터 시트 서식(부록 F-1~F-7·F-10). 값을 다 쓴 뒤에 부른다 — `styleSummaryRow`가 셀에 숫자·수식이
 * 있는지 보고 정렬을 고르기 때문이다. `styleDataCell`을 먼저 깔고 소계·총액 행을 그 위에 덮는다.
 */
function styleDataSheet(ws: ExcelJS.Worksheet, sheet: FormSheet, columnCount: number): void {
  const headerRow = sheet.headerRow ?? 1;
  const dataStartRow = sheet.dataStartRow ?? headerRow + 1;
  const hidden = new Set(sheet.hiddenColumns);

  if (sheet.headerRow !== undefined) styleHeaderRow(ws, headerRow, columnCount);

  sheet.rows.forEach((_, r) => {
    const role = rowRoleOf(sheet, r, headerRow);
    if (role === 'header') return;
    const rowNumber = r + 1;
    if (sheet.columnHints !== undefined) {
      sheet.columnHints.forEach((hint, c) => {
        // 숨김 열은 보이지 않으니 서식을 깔 이유가 없다
        if (hidden.has(c)) return;
        styleDataCell(ws.getCell(rowNumber, c + 1), hint);
      });
    }
    if (role === 'subtotal' || role === 'total') styleSummaryRow(ws, rowNumber, columnCount, role);
  });

  // 틀 고정·필터·너비·인쇄는 세 힌트가 모두 있을 때만 — 하나라도 없으면 생성기가 서식을 의도하지 않은 시트다
  if (sheet.headerRow !== undefined && sheet.dataStartRow !== undefined && sheet.columnHints !== undefined) {
    finishDataSheet(ws, {
      headerRow,
      dataStartRow,
      columnCount,
      hiddenColumns: sheet.hiddenColumns.map((c) => c + 1),
      widths: sheet.columnHints.map((hint) => hint.width),
    });
  }
}

/** 작성안내 시트 서식(부록 F-8). 격자는 `buildGuideSheet`가 정한다: A1 제목, A2 부제, A4부터 2열 표 */
const GUIDE_TITLE_ROW = 1;
const GUIDE_SUBTITLE_ROW = 2;
const GUIDE_TABLE_START_ROW = 4;

function styleGuide(ws: ExcelJS.Worksheet, sheet: FormSheet): void {
  styleGuideSheet(ws, {
    titleRow: GUIDE_TITLE_ROW,
    subtitleRow: GUIDE_SUBTITLE_ROW,
    tableStartRow: GUIDE_TABLE_START_ROW,
    tableRowCount: Math.max(sheet.rows.length - (GUIDE_TABLE_START_ROW - 1), 0),
  });
  finishGuideSheet(ws);
}

/**
 * FormSheet → 워크시트. 값·수식을 먼저 쓰고 힌트가 있으면 서식을 입힌다.
 *
 * exceljs의 `<dimension>`은 값·수식이 있는 셀의 경계다(서식만 있는 셀은 세지 않는다). 헤더 행이 전폭이므로
 * 파서가 보는 격자 폭(`!ref`)은 헤더 폭과 같다 — 끝 열(비고 등)이 데이터 행에서 비어 있어도 잘리지 않는다.
 * 행이 하나도 없으면 빈 시트다.
 */
function writeSheet(wb: ExcelJS.Workbook, sheet: FormSheet, sheetNames: ReadonlySet<string>): void {
  // 숨김: 사용자가 필요하면 볼 수 있어야 하므로 'hidden'(veryHidden은 VBA로만 해제된다)
  const ws = sheet.hidden ? wb.addWorksheet(sheet.name, { state: 'hidden' }) : wb.addWorksheet(sheet.name);

  const headerRow = sheet.headerRow ?? 1;
  let columnCount = 0;
  sheet.rows.forEach((row, r) => {
    columnCount = Math.max(columnCount, row.length);
    // 날짜 변환은 데이터 행만 — 헤더(`집행일`)·소계 행의 라벨은 날짜가 아니다
    const isDataRow = sheet.kind !== 'guide' && rowRoleOf(sheet, r, headerRow) === 'data';
    row.forEach((cell, c) => {
      const target = ws.getCell(r + 1, c + 1);
      const asDate = isDataRow && sheet.columnHints?.[c]?.format === 'date';
      writeCellValue(target, cell, `'${sheet.name}'!${target.address}`, asDate);
    });
  });

  for (const index of sheet.hiddenColumns) {
    if (!Number.isInteger(index) || index < 0) {
      throw new Error(`'${sheet.name}' 시트의 숨김 열 인덱스가 올바르지 않습니다: ${index}`);
    }
    ws.getColumn(index + 1).hidden = true;
  }

  assertHints(sheet, columnCount);
  if (sheet.kind === 'guide') {
    styleGuide(ws, sheet);
  } else {
    styleDataSheet(ws, sheet, columnCount);
    applyValidations(ws, sheet, columnCount, sheetNames);
  }
}

// ─── 워크북 ───────────────────────────────────────────────────────────────────

/**
 * 입력 양식 워크북 → xlsx 바이트 (IN-8: 양식은 xlsx만).
 *
 * 숨김 시트(`_meta`, IN-2)는 `state: 'hidden'`으로 만든다. SheetJS는 숨김 시트도 `SheetNames`에 그대로 두므로
 * `lib/import-adapter.readWorkbook`이 만든 RawSheet 목록에 `_meta`가 포함된다(파서가 거기서 읽는다).
 * 시트 순서는 `wb.sheets` 순서 그대로다(F-8 — 작성안내가 첫 시트).
 *
 * `writeBuffer`는 Promise다. 저장은 호출부의 몫이다(export-adapter.writeWorkbookBuffer와 같은 이유).
 */
export async function writeInputFormWorkbook(wb: InputFormWorkbook): Promise<Buffer> {
  if (wb.sheets.length === 0) throw new Error('입력 양식에 시트가 하나도 없습니다.');

  const seen = new Set<string>();
  for (const sheet of wb.sheets) {
    if (seen.has(sheet.name)) throw new Error(`시트 이름이 중복됩니다: ${sheet.name}`);
    seen.add(sheet.name);
  }
  // 범위 목록은 뒤에 오는 시트(`_lists`)를 가리킬 수 있어 이름을 먼저 다 모은다
  const workbook = createStyledWorkbook();
  for (const sheet of wb.sheets) writeSheet(workbook, sheet, seen);

  const out: unknown = await workbook.xlsx.writeBuffer();
  if (Buffer.isBuffer(out)) return out;
  // Node에서는 Buffer를 주지만, 런타임이 Uint8Array(ArrayBuffer 뷰)를 주더라도 그대로 삼키지 않는다
  if (out instanceof Uint8Array) return Buffer.from(out);
  throw new Error('입력 양식 파일을 만들지 못했습니다 (예상치 못한 출력 형식).');
}
