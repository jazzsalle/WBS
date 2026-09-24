// SheetJS 어댑터 — 사업비 입력 양식(`InputFormWorkbook`)을 xlsx 바이트로 만든다 (SOT §6.16 IN-2·IN-7·IN-8).
//
// `lib/export-adapter.ts`·`lib/import-adapter.ts`와 같은 자리, 같은 이유다. `lib/input-form/`은
// "어느 값이 어느 칸에 있는가"만 다루는 SheetJS 무의존 층이라(IN-8) 워크북을 실제로 만드는 일은
// 여기 한 곳에 모인다. 읽기는 새로 만들지 않는다 — 올린 양식은 `lib/import-adapter.readUploadedWorkbook`이
// 만든 RawSheet(숨김 시트 포함)를 파서가 고정 좌표로 읽는다(IN-1).
//
// I-13: `import 'server-only'`로 클라이언트 번들 유입을 컴파일 타임에 막는다.
import 'server-only';

import * as XLSX from 'xlsx';
import type { FormCell, FormSheet, InputFormWorkbook } from '@/lib/input-form/types';

// ─── 셀 ───────────────────────────────────────────────────────────────────────

/**
 * FormCell → SheetJS 셀. 값도 수식도 없으면 `undefined`(셀 레코드를 만들지 않는다).
 *
 * **숫자 서식(`z`)을 어느 셀에도 붙이지 않는다.** 참여율·인자 열이 백분율 서식이면 화면의 `10`이
 * 엑셀에서 `1000%`로 보이고(X-7), 올릴 때는 저장값이 `0.1`이라 D-22의 ×100 되돌리기가 필요해진다 —
 * 임포트에서 금액이 1/100로 어긋난 바로 그 함정이다. 일반 숫자로 두면 양방향 모두 값 = 화면 숫자다.
 *
 * 수식 셀은 **캐시값 없이** `f`만 쓴다(IN-7). 캐시를 넣으면 엑셀이 다시 계산하기 전까지 우리가
 * 계산한 값이 보이는데, 그 값이 앱 산식과 어긋나는 순간을 사용자가 알 길이 없다. 빈 채로 두면
 * 엑셀이 열면서 계산하고, 앱은 어차피 금액 열을 읽지 않는다(IN-3).
 */
function toSheetCell(cell: FormCell, where: string): XLSX.CellObject | undefined {
  if (typeof cell.formula === 'string') {
    const formula = cell.formula.trim();
    if (formula === '') throw new Error(`${where}: 수식이 비어 있습니다.`);
    // 규약은 `=` 없는 수식이다(types.ts). 앞에 `=`가 붙은 채 쓰면 엑셀이 `==A1`로 읽어 열자마자
    // 오류 셀이 된다 — 조용히 떼지 않고 생성기의 실수를 여기서 드러낸다
    if (formula.startsWith('=')) {
      throw new Error(`${where}: 수식은 '=' 없이 담아야 합니다 (${formula}).`);
    }
    return { t: 'n', f: formula };
  }

  const value = cell.value;
  if (value === undefined || value === null) return undefined;
  if (typeof value === 'number') {
    // NaN·Infinity는 SheetJS가 문자열 "NaN"으로 써 버린다. 금액·참여율 계산이 깨진 신호이므로 막는다
    if (!Number.isFinite(value)) throw new Error(`${where}: 유한한 숫자가 아닙니다 (${value}).`);
    return { t: 'n', v: value };
  }
  return { t: 's', v: value };
}

// ─── 시트 ─────────────────────────────────────────────────────────────────────

/**
 * FormSheet → 워크시트. `!ref`는 **행 수 × 최대 열 수 격자** 전체다 — 값이 있는 셀만으로 잡으면
 * 끝 열이 비어 있는 헤더(비고 등)가 잘려 파서가 보는 격자 폭이 시트마다 달라진다.
 * 행이 하나도 없으면 `!ref`를 두지 않는다(빈 시트). `A1:A1`로 꾸미면 없는 셀이 있는 척하게 된다.
 */
function toWorksheet(sheet: FormSheet): XLSX.WorkSheet {
  const ws: XLSX.WorkSheet = {};
  let maxCol = -1;

  sheet.rows.forEach((row, r) => {
    if (row.length > 0) maxCol = Math.max(maxCol, row.length - 1);
    row.forEach((cell, c) => {
      const addr = XLSX.utils.encode_cell({ r, c });
      const sheetCell = toSheetCell(cell, `'${sheet.name}'!${addr}`);
      if (sheetCell) ws[addr] = sheetCell;
    });
  });

  if (sheet.rows.length > 0) {
    ws['!ref'] = XLSX.utils.encode_range({
      s: { r: 0, c: 0 },
      e: { r: sheet.rows.length - 1, c: Math.max(maxCol, 0) },
    });
  }

  if (sheet.hiddenColumns.length > 0) {
    // 희소 배열이다 — SheetJS는 항목이 있는 인덱스만 <col>로 쓴다. 보이는 열은 기본 너비로 둔다
    const cols: XLSX.ColInfo[] = [];
    for (const index of sheet.hiddenColumns) {
      if (!Number.isInteger(index) || index < 0) {
        throw new Error(`'${sheet.name}' 시트의 숨김 열 인덱스가 올바르지 않습니다: ${index}`);
      }
      cols[index] = { hidden: true };
    }
    ws['!cols'] = cols;
  }

  return ws;
}

// ─── 워크북 ───────────────────────────────────────────────────────────────────

/**
 * 입력 양식 워크북 → xlsx 바이트 (IN-8: 양식은 xlsx만).
 *
 * 숨김 시트(`_meta`, IN-2)는 `Workbook.Sheets[i].Hidden = 1`로 표시한다 — 워크북 수준 속성이라
 * 시트 객체가 아니라 여기서 정한다. SheetJS는 숨김 시트도 `SheetNames`에 그대로 두므로
 * `lib/import-adapter.readWorkbook`이 만든 RawSheet 목록에 `_meta`가 포함된다(파서가 거기서 읽는다).
 *
 * `.mjs` 빌드의 `XLSX.writeFile`은 `fs`가 묶여 있지 않으므로 버퍼를 돌려주고 저장은 호출부의 몫이다
 * (export-adapter.writeWorkbookBuffer와 같은 이유).
 */
export function writeInputFormWorkbook(wb: InputFormWorkbook): Buffer {
  if (wb.sheets.length === 0) throw new Error('입력 양식에 시트가 하나도 없습니다.');

  const seen = new Set<string>();
  const workbook: XLSX.WorkBook = { SheetNames: [], Sheets: {}, Workbook: { Sheets: [] } };
  wb.sheets.forEach((sheet, index) => {
    if (seen.has(sheet.name)) throw new Error(`시트 이름이 중복됩니다: ${sheet.name}`);
    seen.add(sheet.name);
    workbook.SheetNames.push(sheet.name);
    workbook.Sheets[sheet.name] = toWorksheet(sheet);
    // Hidden: 0 보임 / 1 숨김 / 2 매우 숨김(VBA로만 해제). 사용자가 필요하면 볼 수 있어야 하므로 1
    workbook.Workbook!.Sheets![index] = { Hidden: sheet.hidden ? 1 : 0 };
  });

  const out: unknown = XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx', compression: true });
  if (Buffer.isBuffer(out)) return out;
  // type:'buffer'는 Node에서 Buffer를 주지만, 런타임이 Uint8Array를 주더라도 그대로 삼키지 않는다
  if (out instanceof Uint8Array) return Buffer.from(out);
  throw new Error('입력 양식 파일을 만들지 못했습니다 (예상치 못한 출력 형식).');
}
