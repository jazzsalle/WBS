// SheetJS 어댑터 — 업로드된 워크북을 `lib/import`의 RawSheet 경계 타입으로 옮긴다 (SOT §6.8, I-13~I-16).
//
// **`lib/import/` 안에 두지 않는 이유**: 그 디렉터리는 "xlsx 무의존" 불변식으로 파싱 규칙 전부를
// 워크북 없이 단위 테스트로 고정한다(lib/import/types.ts 주석). SheetJS를 들이면 그 경계가 깨진다.
// `actions/`에 두지 않는 이유는 'use server' 파일의 export가 전부 서버 액션이어야 해서,
// 순수 변환 함수(toRawCell·toCommitRows)를 export할 수 없기 때문이다.
//
// I-13: `import 'server-only'`로 클라이언트 번들 유입을 컴파일 타임에 막는다.
// I-14: 업로드 버퍼는 이 파일 안에서 끝난다 — 디스크에 쓰지 않는다.
import 'server-only';

import { createHash } from 'node:crypto';
import * as XLSX from 'xlsx';
import { cellText, checkRowLimit } from '@/lib/import';
import type { MergeRange, RawCell, RawSheet } from '@/lib/import';
import type { ImportCommitRow } from '@/lib/db/import-snapshots';
import { RuleViolationError, ValidationError } from '@/lib/db/errors';
import type { ImportPreview, SheetGridPreview } from '@/types';

// ─── I-15 상한 ────────────────────────────────────────────────────────────────

/** I-15: 파일 10MB 상한. 초과 시 거부한다 (조용한 절단 금지) */
export const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;

/** §6.8.1 ①: 업로드 허용 확장자 */
export const ACCEPTED_EXTENSIONS = ['.xlsx', '.xlsm', '.xls', '.csv'] as const;

/** §7.9.1 Step 2: 원본 미리보기 그리드는 상위 30행 */
export const PREVIEW_ROW_LIMIT = 30;

// ─── 셀 변환 ──────────────────────────────────────────────────────────────────

// SheetJS는 에러 셀의 v를 BIFF 에러 코드(숫자)로 담는다. w(표시 문자열)가 생성되지 않은
// 경로를 대비한 역매핑 — 없으면 `#REF!`가 `23`으로 보여 미리보기가 무의미해진다.
const ERROR_TEXT_BY_CODE: Readonly<Record<number, string>> = {
  0x00: '#NULL!',
  0x07: '#DIV/0!',
  0x0f: '#VALUE!',
  0x17: '#REF!',
  0x1d: '#NAME?',
  0x24: '#NUM!',
  0x2a: '#N/A',
  0x2b: '#GETTING_DATA',
};

function errorTextOf(cell: XLSX.CellObject): string {
  if (typeof cell.w === 'string' && cell.w.trim() !== '') return cell.w.trim();
  const v = cell.v;
  if (typeof v === 'number') return ERROR_TEXT_BY_CODE[v] ?? `#ERROR(${v})`;
  if (typeof v === 'string' && v.trim() !== '') return v.trim();
  return '#ERROR';
}

/**
 * 셀 하나를 RawCell로. **빈 셀도 `{ value: null, isError: false }`로 채운다** (구멍 없는 2차원 배열).
 *
 * - I-16: 수식은 계산값(`v`)을 읽는다. `cellFormula: false`로 읽었으므로 `f`는 애초에 없다
 * - I-12: 에러 셀(`t === 'e'`)은 `isError: true` + 원문을 `errorText`에 담는다
 */
export function toRawCell(cell: XLSX.CellObject | undefined | null): RawCell {
  if (!cell || cell.t === 'z' || cell.v === undefined || cell.v === null) {
    return { value: null, isError: false };
  }
  if (cell.t === 'e') {
    const text = errorTextOf(cell);
    // value에도 원문을 담아 둔다 — cellText()가 errorText 없이도 같은 문자열을 돌려주게
    return { value: text, isError: true, errorText: text };
  }
  const v: unknown = cell.v;
  if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') {
    return { value: v, isError: false };
  }
  // cellDates: false라 여기 오지 않아야 하지만, 오면 조용히 버리지 않고 문자열로 남긴다
  if (v instanceof Date) return { value: v.toISOString(), isError: false };
  return { value: String(v), isError: false };
}

/**
 * 워크시트 → RawSheet. 시트 절대 좌표를 유지하려고 **항상 0행/0열부터** 채운다 —
 * `!ref`가 `B3:H20`처럼 시작해도 오프셋을 두면 병합 범위(절대 좌표)와 행 인덱스가 어긋난다.
 */
export function worksheetToRawSheet(name: string, sheet: XLSX.WorkSheet): RawSheet {
  const merges: MergeRange[] = (sheet['!merges'] ?? []).map((m) => ({
    s: { r: m.s.r, c: m.s.c },
    e: { r: m.e.r, c: m.e.c },
  }));

  const ref = sheet['!ref'];
  if (typeof ref !== 'string' || ref === '') return { name, cells: [], merges };

  const range = XLSX.utils.decode_range(ref);
  const lastRow = range.e.r;
  const lastCol = range.e.c;
  if (lastRow < 0 || lastCol < 0) return { name, cells: [], merges };

  // I-15: 20,000행 상한. 그리드를 만들기 **전에** 판정한다 — 만들고 나서 거부하면
  // 거부 대상 파일이 이미 메모리를 다 먹은 뒤다
  const rowCount = lastRow + 1;
  const limit = checkRowLimit(rowCount);
  if (!limit.ok) {
    throw new ValidationError(
      `'${name}' 시트가 ${rowCount.toLocaleString()}행으로 상한 ${limit.limit.toLocaleString()}행을 넘습니다. 파일을 나눠서 올려주세요.`
    );
  }

  const cells: RawCell[][] = [];
  for (let r = 0; r <= lastRow; r += 1) {
    const row: RawCell[] = new Array<RawCell>(lastCol + 1);
    for (let c = 0; c <= lastCol; c += 1) {
      row[c] = toRawCell(sheet[XLSX.utils.encode_cell({ r, c })] as XLSX.CellObject | undefined);
    }
    cells.push(row);
  }

  return { name, cells, merges };
}

/**
 * I-16: 계산값을 읽는다(`cellFormula: false`). `cellDates: false`로 날짜도 직렬값(숫자)으로 받아
 * 금액 파싱(I-8)이 로케일 서식에 흔들리지 않게 한다.
 */
export function readWorkbook(data: Uint8Array): RawSheet[] {
  let workbook: XLSX.WorkBook;
  try {
    workbook = XLSX.read(data, {
      type: 'buffer',
      cellFormula: false,
      cellDates: false,
      dense: false,
    });
  } catch (e) {
    // 원인은 로그로 남기고 사용자에게는 내부 정보 없는 문장을 준다 (SA-4, 절대 규칙 5)
    console.error('[import-adapter] 워크북 파싱 실패:', e);
    throw new ValidationError(
      '엑셀 파일을 읽을 수 없습니다. 파일이 손상되었거나 지원하지 않는 형식입니다.'
    );
  }

  return workbook.SheetNames.map((name) => {
    const sheet = workbook.Sheets[name];
    return sheet ? worksheetToRawSheet(name, sheet) : { name, cells: [], merges: [] };
  });
}

// ─── 업로드 처리 (I-14, I-15) ─────────────────────────────────────────────────

export interface UploadedWorkbook {
  fileName: string;
  fileSize: number;
  /** sha256 hex. previewImport가 반환하고 commitImport가 대조한다 (§5.12.2) */
  fileHash: string;
  sheets: RawSheet[];
}

function hasAcceptedExtension(fileName: string): boolean {
  const lower = fileName.toLowerCase();
  return ACCEPTED_EXTENSIONS.some((ext) => lower.endsWith(ext));
}

/** FormData 필드명. 마법사 UI와 액션이 공유하는 규약이다 */
export const UPLOAD_FIELD = 'file';

/**
 * §9: 파일은 FormData로 전달된다. 읽고 나면 버퍼는 여기서 끝이다 — 디스크에 저장하지 않는다 (I-14).
 * 확장자·크기 위반은 **거부**한다 (I-15, 조용한 절단 금지).
 */
export async function readUploadedWorkbook(
  formData: FormData,
  field: string = UPLOAD_FIELD
): Promise<UploadedWorkbook> {
  const entry = formData.get(field);
  if (entry === null || typeof entry === 'string') {
    throw new ValidationError('업로드된 파일이 없습니다.');
  }

  const blob = entry as Blob & { name?: string };
  const fileName = (blob.name ?? '').trim() || 'upload.xlsx';
  if (!hasAcceptedExtension(fileName)) {
    throw new ValidationError(
      `지원하지 않는 파일 형식입니다. ${ACCEPTED_EXTENSIONS.join(', ')} 파일만 올릴 수 있습니다.`
    );
  }
  if (blob.size > MAX_UPLOAD_BYTES) {
    throw new ValidationError(
      `파일이 ${MAX_UPLOAD_BYTES / 1024 / 1024}MB 상한을 넘습니다. 필요한 시트만 남겨서 다시 올려주세요.`
    );
  }

  const bytes = new Uint8Array(await blob.arrayBuffer());
  // Blob.size를 그대로 믿지 않는다 — 실제로 읽은 바이트로 한 번 더 본다
  if (bytes.byteLength > MAX_UPLOAD_BYTES) {
    throw new ValidationError(
      `파일이 ${MAX_UPLOAD_BYTES / 1024 / 1024}MB 상한을 넘습니다. 필요한 시트만 남겨서 다시 올려주세요.`
    );
  }
  if (bytes.byteLength === 0) throw new ValidationError('빈 파일입니다.');

  const fileHash = createHash('sha256').update(bytes).digest('hex');
  const sheets = readWorkbook(bytes);

  return { fileName, fileSize: bytes.byteLength, fileHash, sheets };
}

// ─── §7.9.1 Step 2 원본 그리드 ────────────────────────────────────────────────

/**
 * 상위 N행의 **원본**(병합 확장 전) 그리드. 병합 범위를 함께 넘겨 화면이 실제 서식 그대로
 * 그리게 한다 — 확장한 격자를 보여주면 사용자가 헤더 행을 클릭으로 지정할 때 원본과 어긋난다.
 */
export function toGridPreview(sheet: RawSheet, maxRows: number = PREVIEW_ROW_LIMIT): SheetGridPreview {
  const totalRows = sheet.cells.length;
  let totalColumns = 0;
  for (const row of sheet.cells) totalColumns = Math.max(totalColumns, row.length);

  const shown = Math.min(totalRows, Math.max(maxRows, 0));
  const rows = sheet.cells.slice(0, shown).map((row) => {
    const out = new Array<{ text: string; isError: boolean }>(totalColumns);
    for (let c = 0; c < totalColumns; c += 1) {
      const cell = row[c];
      out[c] = { text: cellText(cell), isError: cell?.isError ?? false };
    }
    return out;
  });

  return {
    sheetName: sheet.name,
    rows,
    merges: sheet.merges.filter((m) => m.s.r < shown),
    totalRows,
    totalColumns,
    truncated: totalRows > shown,
  };
}

// ─── 반영 대상 변환 (§7.9.1 Step 5, S-5) ─────────────────────────────────────

/**
 * 미리보기 → commit_import RPC 행. **판정을 다시 하지 않는다** — `blocked`는 buildPreview가
 * 이미 계산했고(오류 1건 이상 또는 미대응 연차 열), 액션이 같은 규칙을 두 번 쓰면 반드시 어긋난다.
 *
 * 미리보기에서 본 것과 반영되는 것이 같아야 하므로(§9), commitImport는 자체 파싱 없이
 * previewImport와 같은 경로로 만든 ImportPreview를 여기에 넣는다.
 */
export function toCommitRows(preview: ImportPreview): ImportCommitRow[] {
  if (preview.blocked) {
    const reasons: string[] = [];
    if (preview.summary.error > 0) reasons.push(`오류 ${preview.summary.error}건`);
    if (preview.unmappedYearOrders.length > 0) {
      const labels = preview.unmappedYearOrders.map((order) => `${order + 1}차년도`).join(', ');
      reasons.push(`연차 미대응 (${labels})`);
    }
    throw new RuleViolationError(
      `반영할 수 없습니다 — ${reasons.join(' / ')}. 해당 행을 "건너뛰기"로 제외하거나 연차 열 대응을 지정한 뒤 다시 시도하세요.`
    );
  }

  const rows: ImportCommitRow[] = [];
  for (const row of preview.rows) {
    if (row.status !== 'new' && row.status !== 'overwrite') continue;
    if (row.yearId === null || row.category === null || row.plannedAmount === null) {
      // blocked가 아닌데 반영 대상 행이 비어 있으면 파이프라인이 깨진 것이다. 조용히 건너뛰지 않는다
      throw new RuleViolationError(
        '반영 대상 행에 연차·비목·계획액이 비어 있습니다. 미리보기를 다시 확인하세요.'
      );
    }
    rows.push({
      yearId: row.yearId,
      category: row.category,
      plannedAmount: row.plannedAmount,
      cashAmount: row.cashAmount,
      inKindAmount: row.inKindAmount,
    });
  }
  return rows;
}
