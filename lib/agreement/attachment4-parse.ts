// 붙임4 과제별 사업비검토양식 → 협약 버전 금액 줄 + 연차별 정부지원 현금 (SOT §5.21 AV-7, 부록 C.4, 계획서 S-13·S-14).
//
// 입력은 어댑터가 만든 셀 격자(`RawSheet[]`)뿐이다 — SheetJS 객체를 모른다(AV-7 ⑤, AG-9). 미리보기와 반영이
// 같은 함수를 부르므로(I-13과 같은 원칙) 결과는 입력에만 의존한다.
//
// 이 모듈의 전부는 "금액을 조용히 잃지 않는 것"이다: 모르는 라벨·음수·문자·비정수·단위 없음은 blocking이고,
// 집계 행·8-1 정합이 어긋나면 위치와 차액을 경고로 남긴다. 블록은 추측해 고르지 않는다(G-11 — 회사명 개념 없음).

import {
  ATTACHMENT4_FORM_ROWS,
  ATTACHMENT8_1_COLUMNS,
  BUDGET_CATEGORY_ORDER,
  attachment4LabelKey,
  type Attachment4FormRowDef,
  type Attachment81ColumnDef,
} from '@/lib/constants';
import { detectAmountUnit, parseAmountCell } from '@/lib/import/amount';
import { cellText, expandMerges } from '@/lib/import/grid';
import { indexToColumnLetter, normalizeLabel } from '@/lib/import/normalize';
import { parseYearOrderFromLabel } from '@/lib/import/structure';
import type { AmountUnit, MergeRange, RawCell, RawSheet } from '@/lib/import/types';
import type { Attachment4RowId, Attachment81ColumnId, BudgetCategory, DetailAxis, Year } from '@/types';

// ─── 입력 ─────────────────────────────────────────────────────────────────────

export const ATTACHMENT4_SHEET_8_2 = '8-2. 연구개발비 사용계획';
export const ATTACHMENT4_SHEET_8_1 = '8-1. 연구개발비 지원 및 부담계획';

export type Attachment4YearInput = Pick<Year, 'id' | 'name' | 'order'>;

export interface Attachment4ParseInput {
  sheets: readonly RawSheet[];
  /** 과제 연차 전부. `N차년도` 열·8-1 연차 블록을 이 `order` 순서로 맞춘다 */
  years: readonly Attachment4YearInput[];
  /** 고른 8-2 기관 블록(`blocks`의 index — 총합 블록 제외). 블록이 하나면 생략 가능 */
  blockIndex?: number;
  /** 8-1 연차 블록 안 기관 금액 행의 위치(0부터, `choose-81-row` 후보의 index). 'none' = 8-1 쓰지 않음 */
  plan81Row?: number | 'none';
}

// ─── 출력 ─────────────────────────────────────────────────────────────────────

export interface Attachment4Block {
  /** `blockIndex`로 넘기는 값 — 총합 블록을 뺀 순서 */
  index: number;
  /** B열(수행기관 열) 텍스트 그대로 — 미리보기 목록에 이대로 보인다(G-11) */
  label: string;
  /** 시트 행 번호(1부터) — 위치 표시용 */
  startRow: number;
  endRow: number;
}

export type Attachment4IssueCode =
  | 'sheet_missing'            // 8-2 시트가 없다
  | 'header_missing'           // 수행기관 열·N차년도 열을 못 찾았다
  | 'no_years'                 // 과제 연차가 없다
  | 'no_blocks'                // 총합 블록 말고 기관 블록이 없다
  | 'block_out_of_range'       // blockIndex가 블록 목록 밖
  | 'unit_missing'             // 8-2·8-1 어디에도 단위 표기가 없다
  | 'unknown_label'            // 부록 C.4에 없는 라벨
  | 'unlabeled_row'            // 라벨 없는 행에 값
  | 'invalid_amount'           // 문자·수식 에러·비정수
  | 'negative_amount'
  | 'no_amounts'               // 고른 블록에서 만들 금액 줄이 0개 — 0원 버전을 만들지 않는다
  | 'plan81_row_out_of_range'  // plan81Row가 후보 밖
  | 'plan81_invalid_amount';   // 고른 8-1 행의 정부지원 현금(A)이 0 이상 정수가 아니다

export interface Attachment4Issue {
  code: Attachment4IssueCode;
  /** 위치(시트·칸·라벨)를 담은 사용자용 문장 */
  message: string;
  sheet: string | null;
  /** A1 표기. 칸 하나를 가리키지 않으면 null */
  cell: string | null;
}

export type Attachment4WarningCode =
  | 'unit_from_other_sheet'     // 8-2에 단위 표기가 없어 8-1 시트 표기를 썼다(실측 — 8-2에는 표기가 없다)
  | 'year_count_mismatch'       // N차년도 열 수 ≠ 과제 연차 수
  | 'aggregate_mismatch'        // 집계 행(인건비 소계·E1·E2·K·M) ≠ 가져온 데이터 합
  | 'aggregate_unreadable'      // 집계 칸을 숫자로 못 읽어 대조하지 못했다
  | 'memo_nonzero'              // (간접비 중 연구실 안전관리비) 값 ≠ 0 — 반영하지 않는다(U-3)
  | 'duplicate_key'             // 같은 (연차, 비목, 세목, 축)이 두 행에서 왔다 — 합산
  | 'extra_column_unreadable'   // 남는 연차 열의 칸을 못 읽었다(반영 대상 아님)
  | 'plan81_unavailable'        // 8-1 시트·머리를 못 찾았다 — 정부지원 현금 없음
  | 'plan81_not_used'           // 사용자가 "8-1 쓰지 않음"을 골랐다
  | 'plan81_year_missing'       // 그 연차의 8-1 행이 없다 — 그 연차 정부지원 현금 없음
  | 'plan81_year_extra'         // 과제 연차보다 많은 8-1 연차 블록 — 읽지 않는다
  | 'plan81_gov_cash_blank'     // 고른 행의 A 칸이 비었다 — 그 연차 미입력
  | 'plan81_mismatch'           // 정합(8-2 현금 = A+B, 현물 = C, 합계 = H) 어긋남
  | 'plan81_other_support'      // 그 외 기관 지원금 E·F ≠ 0
  | 'plan81_unreadable';        // 정합 대조 칸을 숫자로 못 읽었다

export interface Attachment4Warning {
  code: Attachment4WarningCode;
  message: string;
  sheet: string | null;
  cell: string | null;
  /** 차액(파일 − 가져온 값, 원). 차액이 없는 경고는 null */
  difference: number | null;
}

export interface Attachment4Line {
  yearId: string;
  category: BudgetCategory;
  subcategoryCode: string;
  axis: DetailAxis;
  /** 원 단위 양의 정수 — 0·빈 칸은 줄을 만들지 않는다 */
  amount: number;
}

export interface Attachment4Unit {
  unit: AmountUnit;
  /** 근거 텍스트(예: `(단위: 천원)`) */
  text: string;
  /** 표기를 찾은 시트 */
  sheet: string;
}

export interface Plan81Candidate {
  /** `plan81Row`로 넘기는 값 — 연차 블록 안 기관 금액 행의 위치 */
  index: number;
  /** 첫 연차 블록의 그 위치 기관 텍스트 그대로 */
  label: string;
  /** 연차 블록마다 그 위치의 기관 텍스트·칸 */
  rows: { yearOrder: number; label: string; cell: string }[];
}

export interface Plan81YearCheck {
  yearId: string;
  yearName: string;
  /** 고른 8-1 행의 기관 칸 */
  cell: string;
  label: string;
  /** 정부지원 현금 A(원). 칸이 비었으면 null(미입력) */
  govCash: number | null;
  /** 파일 값(원) — 못 읽은 칸은 null */
  file: { ownCash: number | null; ownInKind: number | null; totalCash: number | null; totalInKind: number | null; total: number | null };
  /** 고른 8-2 블록에서 가져온 그 연차 합(원) */
  imported: { cash: number; inKind: number; total: number };
  /** 정합 대조가 모두 맞았는가(못 읽은 칸이 있으면 false) */
  matches: boolean;
}

export interface Plan81Summary {
  /** auto = 텍스트가 같은 행 하나씩 · chosen = plan81Row로 고름 · none = 쓰지 않음 · unavailable = 8-1을 못 읽음 */
  mode: 'auto' | 'chosen' | 'none' | 'unavailable';
  rowIndex: number | null;
  years: Plan81YearCheck[];
}

export type Attachment4ParseResult =
  | { status: 'choose-block'; blocks: Attachment4Block[] }
  | {
      status: 'choose-81-row';
      blocks: Attachment4Block[];
      blockIndex: number;
      blockLabel: string;
      /** no-match = 같은 텍스트 행이 없는 연차가 있다 · multiple-match = 둘 이상인 연차가 있다 */
      reason: 'no-match' | 'multiple-match';
      candidates: Plan81Candidate[];
      warnings: Attachment4Warning[];
    }
  | {
      status: 'ok';
      blocks: Attachment4Block[];
      blockIndex: number;
      blockLabel: string;
      unit: Attachment4Unit;
      /** 연차 order → 부록 A.1 비목 → 세목 → 현금·현물 순 */
      lines: Attachment4Line[];
      /** {연차 id: 원} — RPC `p_gov_cash`에 그대로. 키 없음 = 미입력(§5.25) */
      govCash: Record<string, number>;
      plan81: Plan81Summary;
      warnings: Attachment4Warning[];
    }
  | { status: 'blocked'; blocks: Attachment4Block[]; issues: Attachment4Issue[]; warnings: Attachment4Warning[] };

// ─── 공통 ─────────────────────────────────────────────────────────────────────

const won = (n: number): string => `${n.toLocaleString('ko-KR')}원`;
const a1 = (row: number, col: number): string => `${indexToColumnLetter(col)}${row + 1}`;

/** 시트 이름 비교형 — 판마다 공백이 흔들린다 */
const sheetKey = (name: string): string => name.normalize('NFC').replace(/\s+/g, '');

/**
 * 8-2 B열 ↔ 8-1 기관 칸 비교형(S-14 — NFC·공백 정규화). 실측에서 같은 기관이 8-2에는 `가나\n연구원`,
 * 8-1에는 `가나연구원`으로 적혀 있다 — 공백을 줄이는 게 아니라 **전부 지운다**
 */
const orgKey = (text: string): string => text.normalize('NFC').replace(/\s+/g, '');

// 괄호 내역 행은 attachment4LabelKey가 가운뎃점을 남긴다 — 판마다 `·`/`‧`가 섞여도 같은 행으로 본다
const MIDDLE_DOTS = /[·‧ㆍ•・･]/g;
const rowLabelKey = (raw: string): string => attachment4LabelKey(raw).replace(MIDDLE_DOTS, '');

const AXIS_KEYS = new Set(['현금', '현물', '일반', '통합관리']);

interface RowLookup {
  def: Attachment4FormRowDef;
  axis: DetailAxis | null;
}

const ROW_LOOKUP: ReadonlyMap<string, RowLookup> = (() => {
  const map = new Map<string, RowLookup>();
  for (const def of ATTACHMENT4_FORM_ROWS) {
    for (const m of def.match) {
      map.set(`${rowLabelKey(m.itemKey)}|${m.subKey ?? ''}`, { def, axis: m.axis });
    }
  }
  return map;
})();

/** 병합의 좌상단이 아닌 칸 — 펼친 격자에서 위 행 값이 복사돼 들어온 칸이다 */
function mergeContinuation(merges: readonly MergeRange[], row: number, col: number): boolean {
  return merges.some((m) => row >= m.s.r && row <= m.e.r && col >= m.s.c && col <= m.e.c && !(row === m.s.r && col === m.s.c));
}

function mergeAt(merges: readonly MergeRange[], row: number, col: number): MergeRange | null {
  return merges.find((m) => m.s.r === row && m.s.c === col) ?? null;
}

function isBlankCell(cell: RawCell | undefined): boolean {
  return !cell || (!cell.isError && cellText(cell) === '');
}

function findSheet(sheets: readonly RawSheet[], name: string): RawSheet | null {
  const key = sheetKey(name);
  return sheets.find((s) => sheetKey(s.name) === key) ?? null;
}

// ─── 8-2 구조 ─────────────────────────────────────────────────────────────────

interface Sheet82Layout {
  grid: RawCell[][];
  orgCol: number;
  labelCols: number[];
  /** 왼쪽부터 `N차년도` 열 */
  yearCols: number[];
  /** 총합 블록 포함 전부 */
  allBlocks: { label: string; start: number; end: number; total: boolean }[];
}

function layout82(sheet: RawSheet): Sheet82Layout | Attachment4Issue {
  const grid = expandMerges(sheet).cells;
  const headerIssue = (message: string): Attachment4Issue => ({ code: 'header_missing', message, sheet: sheet.name, cell: null });

  let yearRow = -1;
  let yearCols: number[] = [];
  for (let r = 0; r < grid.length && yearRow < 0; r += 1) {
    const cols: number[] = [];
    // 병합으로 펼쳐진 머리(`1차년도`가 두 칸에 걸침)를 두 열로 세지 않게 좌상단만 본다
    grid[r]!.forEach((cell, c) => {
      if (!mergeContinuation(sheet.merges, r, c) && parseYearOrderFromLabel(cellText(cell)) !== null) cols.push(c);
    });
    if (cols.length > 0) {
      yearRow = r;
      yearCols = cols;
    }
  }
  if (yearRow < 0) return headerIssue(`'${sheet.name}' 시트에서 'N차년도' 머리 칸을 찾지 못했습니다.`);

  let orgCol = -1;
  for (let r = 0; r <= yearRow && orgCol < 0; r += 1) {
    const c = grid[r]!.findIndex((cell) => normalizeLabel(cellText(cell)) === '수행기관');
    if (c >= 0) orgCol = c;
  }
  if (orgCol < 0) return headerIssue(`'${sheet.name}' 시트에서 '수행기관' 머리 칸을 찾지 못했습니다.`);
  const firstYearCol = Math.min(...yearCols);
  if (firstYearCol <= orgCol + 1) return headerIssue(`'${sheet.name}' 시트에서 수행기관 열과 연차 열 사이에 비목 열이 없습니다.`);
  const labelCols: number[] = [];
  for (let c = orgCol + 1; c < firstYearCol; c += 1) labelCols.push(c);

  // 블록 시작 = 수행기관 열 원본 칸에 텍스트가 있는 행(병합 이어진 칸 제외). 머리 행 아래의 연도 숫자 행은 그 열이 비어 있다
  const starts: number[] = [];
  for (let r = yearRow + 1; r < grid.length; r += 1) {
    const raw = sheet.cells[r]?.[orgCol];
    if (mergeContinuation(sheet.merges, r, orgCol)) continue;
    if (cellText(raw) !== '') starts.push(r);
  }
  const allBlocks = starts.map((start, i) => {
    const next = starts[i + 1] ?? grid.length;
    const merge = mergeAt(sheet.merges, start, orgCol);
    // 마지막 블록 아래 메모 줄을 블록으로 읽지 않게 병합이 있으면 그 끝까지만
    const end = merge && merge.e.r > start ? Math.min(merge.e.r, next - 1) : next - 1;
    const label = cellText(sheet.cells[start]?.[orgCol]);
    return { label, start, end, total: normalizeLabel(label).startsWith('총합') };
  });

  return { grid, orgCol, labelCols, yearCols, allBlocks };
}

// ─── 8-2 행 해석 ──────────────────────────────────────────────────────────────

interface BlockParse {
  /** 키 → 줄. 같은 키가 두 번이면 합산(⑧) */
  lines: Map<string, Attachment4Line>;
  issues: Attachment4Issue[];
  warnings: Attachment4Warning[];
  /** 대응한 연차(index)별 양식 행 합(원, 현금+현물) — 집계 대조·8-1 정합용 */
  rowTotals: Map<Attachment4RowId, number>[];
  axisTotals: { cash: number; inKind: number }[];
}

// 양식 집계 행의 식(실측 수식과 같다 — 통합관리비(현금) 행은 K에 들어가지 않는다)
const AGGREGATE_PARTS: Partial<Record<Attachment4RowId, readonly Attachment4RowId[]>> = {
  personnel_subtotal: ['personnel_internal', 'personnel_external', 'personnel_support'],
  total_personnel: ['personnel_internal', 'personnel_external', 'personnel_support', 'student_general', 'student_managed'],
  modified_personnel: ['personnel_internal', 'personnel_external', 'student_general', 'student_managed'],
  direct_subtotal: [
    'personnel_internal', 'personnel_external', 'personnel_support', 'student_general', 'student_managed',
    'facility_equipment', 'material', 'activity', 'allowance',
  ],
  total: [
    'personnel_internal', 'personnel_external', 'personnel_support', 'student_general', 'student_managed',
    'facility_equipment', 'material', 'activity', 'allowance', 'indirect',
  ],
};

function parseBlock(
  sheet: RawSheet,
  layout: Sheet82Layout,
  block: { label: string; start: number; end: number },
  years: readonly Attachment4YearInput[],
  unit: AmountUnit
): BlockParse {
  const { grid, labelCols, yearCols } = layout;
  const mapped = Math.min(yearCols.length, years.length);
  const issues: Attachment4Issue[] = [];
  const warnings: Attachment4Warning[] = [];
  const lines = new Map<string, Attachment4Line>();
  const duplicateWarned = new Set<string>();
  const rowTotals = Array.from({ length: mapped }, () => new Map<Attachment4RowId, number>());
  const axisTotals = Array.from({ length: mapped }, () => ({ cash: 0, inKind: 0 }));
  const aggregateCells: { def: Attachment4FormRowDef; row: number }[] = [];
  let extraSum = 0;
  const where = (row: number, col: number) => `'${sheet.name}' ${block.label} 블록 ${a1(row, col)}`;

  for (let r = block.start; r <= block.end; r += 1) {
    const row = grid[r] ?? [];
    // 펼친 병합이 같은 텍스트를 여러 칸에 복사하므로 연달아 같은 텍스트는 하나로 본다
    const labels: { text: string; col: number }[] = [];
    for (const c of labelCols) {
      const text = cellText(row[c]);
      if (text === '' || labels[labels.length - 1]?.text === text) continue;
      labels.push({ text, col: c });
    }
    const hasValue = yearCols.some((c) => !isBlankCell(row[c]));

    if (labels.length === 0) {
      if (hasValue) {
        issues.push({
          code: 'unlabeled_row',
          message: `${where(r, yearCols[0]!)}: 라벨이 없는 행에 금액이 있습니다 — 어느 비목인지 알 수 없어 가져오지 않습니다.`,
          sheet: sheet.name,
          cell: a1(r, yearCols[0]!),
        });
      }
      continue;
    }

    const last = labels[labels.length - 1]!;
    const subKey = AXIS_KEYS.has(rowLabelKey(last.text)) ? rowLabelKey(last.text) : null;
    const item = subKey === null ? last : [...labels.slice(0, -1)].reverse().find((l) => !AXIS_KEYS.has(rowLabelKey(l.text)));
    const found = item ? ROW_LOOKUP.get(`${rowLabelKey(item.text)}|${subKey ?? ''}`) : undefined;
    if (!found) {
      const shown = item ? (subKey === null ? item.text : `${item.text} / ${last.text}`) : last.text;
      issues.push({
        code: 'unknown_label',
        message: `${where(r, (item ?? last).col)}: 부록 C.4에 없는 라벨 '${shown.replace(/\s+/g, ' ')}'입니다 — 금액이 사라지지 않도록 가져오기를 멈춥니다.`,
        sheet: sheet.name,
        cell: a1(r, (item ?? last).col),
      });
      continue;
    }

    const { def, axis: matchAxis } = found;
    if (def.kind === 'ratio' || def.kind === 'ignored') continue;
    if (def.kind === 'aggregate') {
      aggregateCells.push({ def, row: r });
      continue;
    }
    if (def.kind === 'memo') {
      for (let i = 0; i < mapped; i += 1) {
        const c = yearCols[i]!;
        const parsed = parseAmountCell(row[c], unit);
        if (parsed.ok && parsed.amount === 0) continue;
        warnings.push({
          code: 'memo_nonzero',
          message: `${where(r, c)}: '${def.label}' ${years[i]!.name} 값(${parsed.ok ? won(parsed.amount!) : cellText(row[c])})은 반영하지 않습니다 — 이 내역은 협약 버전에 담을 곳이 없습니다.`,
          sheet: sheet.name,
          cell: a1(r, c),
          difference: null,
        });
      }
      continue;
    }

    // data — 가져오기 대상이 없는 data 행(양식 밖 비목)은 양식에 라벨이 없어 여기 오지 않는다
    const target = def.importTarget!;
    const axis: DetailAxis = def.axes === 'split' ? (matchAxis ?? 'cash') : 'cash';
    yearCols.forEach((c, i) => {
      const cell = row[c];
      if (isBlankCell(cell)) return;
      const parsed = parseAmountCell(cell, unit);
      const label = `${def.label}${def.subLabel ? ` ${def.subLabel}` : ''}${def.axes === 'split' ? ` ${axis === 'cash' ? '현금' : '현물'}` : ''}`;
      if (i >= mapped) {
        if (parsed.ok) extraSum += parsed.amount!;
        else {
          warnings.push({
            code: 'extra_column_unreadable',
            message: `${where(r, c)}: 과제 연차에 대응하지 않는 열의 '${label}' 칸을 숫자로 읽지 못했습니다(${cellText(cell)}) — 반영 대상은 아닙니다.`,
            sheet: sheet.name,
            cell: a1(r, c),
            difference: null,
          });
        }
        return;
      }
      if (!parsed.ok || parsed.rounded) {
        issues.push({
          code: 'invalid_amount',
          message: parsed.ok
            ? `${where(r, c)}: '${label}' ${years[i]!.name} 금액 ${cellText(cell)}이 원 단위 정수가 아닙니다 — 원 단위로 고친 뒤 다시 올리세요.`
            : `${where(r, c)}: '${label}' ${years[i]!.name} 칸을 금액으로 읽지 못했습니다(${cellText(cell)}).`,
          sheet: sheet.name,
          cell: a1(r, c),
        });
        return;
      }
      const amount = parsed.amount!;
      if (amount < 0) {
        issues.push({
          code: 'negative_amount',
          message: `${where(r, c)}: '${label}' ${years[i]!.name} 금액이 음수입니다(${won(amount)}).`,
          sheet: sheet.name,
          cell: a1(r, c),
        });
        return;
      }
      if (amount === 0) return;
      rowTotals[i]!.set(def.id, (rowTotals[i]!.get(def.id) ?? 0) + amount);
      if (axis === 'cash') axisTotals[i]!.cash += amount;
      else axisTotals[i]!.inKind += amount;

      const yearId = years[i]!.id;
      const key = `${yearId}|${target.category}|${target.subcategoryCode}|${axis}`;
      const existing = lines.get(key);
      if (existing) {
        existing.amount += amount;
        if (!duplicateWarned.has(key)) {
          duplicateWarned.add(key);
          warnings.push({
            code: 'duplicate_key',
            message: `${where(r, c)}: '${label}' ${years[i]!.name}이 블록 안에 두 번 있어 금액을 합칩니다.`,
            sheet: sheet.name,
            cell: a1(r, c),
            difference: null,
          });
        }
      } else {
        lines.set(key, { yearId, category: target.category, subcategoryCode: target.subcategoryCode, axis, amount });
      }
    });
  }

  if (yearCols.length !== years.length) {
    const shown = yearCols.length > years.length
      ? ` 남는 열(${yearCols.slice(years.length).map((c) => indexToColumnLetter(c)).join('·')}열)의 금액 합계 ${won(extraSum)}은 반영하지 않습니다.`
      : ` ${years.slice(yearCols.length).map((y) => y.name).join('·')}에는 금액이 들어가지 않습니다.`;
    warnings.push({
      code: 'year_count_mismatch',
      message: `'${sheet.name}'의 연차 열은 ${yearCols.length}개, 과제 연차는 ${years.length}개입니다 — 앞에서부터 ${mapped}개만 맞춥니다.${shown}`,
      sheet: sheet.name,
      cell: null,
      difference: yearCols.length > years.length ? extraSum : null,
    });
  }

  for (const { def, row } of aggregateCells) {
    const parts = AGGREGATE_PARTS[def.id] ?? [];
    for (let i = 0; i < mapped; i += 1) {
      const c = yearCols[i]!;
      const cell = grid[row]?.[c];
      const parsed = parseAmountCell(cell, unit);
      if (!parsed.ok) {
        warnings.push({
          code: 'aggregate_unreadable',
          message: `${where(row, c)}: '${def.label}' ${years[i]!.name} 칸을 숫자로 읽지 못해 대조하지 않았습니다(${cellText(cell)}).`,
          sheet: sheet.name,
          cell: a1(row, c),
          difference: null,
        });
        continue;
      }
      // 실측 양식의 인건비 소계 행은 수식이 아닌 입력 칸이라 늘 0으로 남는다 — 비었거나 0이면 대조하지 않는다(메인 결정)
      if (def.id === 'personnel_subtotal' && parsed.amount === 0) continue;
      const ours = parts.reduce((sum, id) => sum + (rowTotals[i]!.get(id) ?? 0), 0);
      const diff = parsed.amount! - ours;
      if (diff === 0) continue;
      warnings.push({
        code: 'aggregate_mismatch',
        message: `${where(row, c)}: 파일의 '${def.label}' ${years[i]!.name} ${won(parsed.amount!)} ≠ 가져온 금액 합 ${won(ours)} (차액 ${won(diff)}).`,
        sheet: sheet.name,
        cell: a1(row, c),
        difference: diff,
      });
    }
  }

  return { lines, issues, warnings, rowTotals, axisTotals };
}

// ─── 8-1 ──────────────────────────────────────────────────────────────────────

interface Row81 {
  row: number;
  yearOrder: number;
  label: string;
}

interface Sheet81Layout {
  grid: RawCell[][];
  columns: Partial<Record<Attachment81ColumnId, number>>;
  /** yearOrder → 그 연차 블록의 기관 금액 행(위에서 아래) */
  groups: Map<number, Row81[]>;
}

function layout81(sheet: RawSheet): Sheet81Layout | null {
  const grid = expandMerges(sheet).cells;
  let labelRow = -1;
  for (let r = 0; r < grid.length && labelRow < 0; r += 1) {
    if (grid[r]!.some((cell) => ['기업유형', '연구개발기관'].includes(normalizeLabel(cellText(cell))))) labelRow = r;
  }
  if (labelRow < 0) return null;

  const width = grid[labelRow]!.length;
  const columns: Partial<Record<Attachment81ColumnId, number>> = {};
  let yearCol = -1;
  for (let c = 0; c < width; c += 1) {
    const labelText = cellText(grid[labelRow]![c]);
    const labelKey = normalizeLabel(labelText);
    if (labelKey === '연차') yearCol = c;
    // 상위 머리 = 위로 올라가며 처음 만나는 다른 텍스트(병합으로 펼쳐진 `정부지원연구개발비` 등)
    let groupKey: string | null = null;
    for (let r = labelRow - 1; r >= Math.max(0, labelRow - 3); r -= 1) {
      const text = cellText(grid[r]![c]);
      if (text !== '' && text !== labelText) {
        groupKey = normalizeLabel(text);
        break;
      }
    }
    const def = ATTACHMENT8_1_COLUMNS.find(
      (d: Attachment81ColumnDef) => d.labelKey === labelKey && (d.groupKey === null || d.groupKey === groupKey || d.importUse === 'match_org')
    );
    if (def && columns[def.id] === undefined) columns[def.id] = c;
  }
  const orgCol = columns.org;
  if (orgCol === undefined || columns.gov_cash === undefined) return null;
  if (yearCol < 0) yearCol = orgCol - 1;

  const groups = new Map<number, Row81[]>();
  let currentYear: number | null = null;
  for (let r = labelRow + 1; r < grid.length; r += 1) {
    const yearText = yearCol >= 0 ? cellText(grid[r]![yearCol]) : '';
    const yearOrder = /^\d+$/.test(yearText) ? Number(yearText) - 1 : parseYearOrderFromLabel(yearText);
    if (yearOrder !== null && yearOrder >= 0) currentYear = yearOrder;
    // 기관마다 금액 행 + 비율 행 — 비율 행은 기관 칸이 위 행과 병합돼 있거나(실측) 비어 있다. 머리 아래 `비율(A/H)` 행도 같다
    if (mergeContinuation(sheet.merges, r, orgCol)) continue;
    const label = cellText(sheet.cells[r]?.[orgCol]);
    if (label === '' || currentYear === null) continue;
    const list = groups.get(currentYear) ?? [];
    list.push({ row: r, yearOrder: currentYear, label });
    groups.set(currentYear, list);
  }
  return { grid, columns, groups };
}

interface Plan81Outcome {
  kind: 'ok';
  govCash: Record<string, number>;
  summary: Plan81Summary;
  warnings: Attachment4Warning[];
  issues: Attachment4Issue[];
}

type Plan81Result =
  | Plan81Outcome
  | { kind: 'choose'; reason: 'no-match' | 'multiple-match'; candidates: Plan81Candidate[] };

function readPlan81(
  sheet: RawSheet | null,
  blockLabel: string,
  plan81Row: number | 'none' | undefined,
  years: readonly Attachment4YearInput[],
  unit: AmountUnit,
  block: BlockParse
): Plan81Result {
  const warnings: Attachment4Warning[] = [];
  const issues: Attachment4Issue[] = [];
  const empty = (mode: Plan81Summary['mode']): Plan81Outcome => ({
    kind: 'ok', govCash: {}, summary: { mode, rowIndex: null, years: [] }, warnings, issues,
  });

  if (plan81Row === 'none') {
    warnings.push({
      code: 'plan81_not_used',
      message: '8-1을 쓰지 않습니다 — 버전의 정부지원 현금이 비어 있습니다(미입력). 붙임4형 보기 8-1에서 연차별로 입력하세요.',
      sheet: null, cell: null, difference: null,
    });
    return empty('none');
  }

  const layout = sheet ? layout81(sheet) : null;
  if (!sheet || !layout || layout.groups.size === 0) {
    if (typeof plan81Row === 'number') {
      issues.push({
        code: 'plan81_row_out_of_range',
        message: `'${ATTACHMENT4_SHEET_8_1}' 시트에서 기관 행을 찾지 못해 고른 8-1 행을 쓸 수 없습니다.`,
        sheet: sheet?.name ?? null, cell: null,
      });
      return empty('unavailable');
    }
    warnings.push({
      code: 'plan81_unavailable',
      message: sheet
        ? `'${sheet.name}' 시트에서 연구개발기관·정부지원 현금(A) 머리 또는 기관 행을 찾지 못했습니다 — 정부지원 현금 없이 가져옵니다.`
        : `'${ATTACHMENT4_SHEET_8_1}' 시트가 없습니다 — 정부지원 현금 없이 가져옵니다.`,
      sheet: sheet?.name ?? null, cell: null, difference: null,
    });
    return empty('unavailable');
  }

  const { grid, columns, groups } = layout;
  const orgCol = columns.org!;
  const orders = [...groups.keys()].sort((a, b) => a - b);
  const inRange = orders.filter((o) => o < years.length);
  const extra = orders.filter((o) => o >= years.length);
  if (extra.length > 0) {
    warnings.push({
      code: 'plan81_year_extra',
      message: `'${sheet.name}'에 과제 연차(${years.length}개)보다 뒤의 연차 블록(${extra.map((o) => `${o + 1}`).join('·')})이 있어 읽지 않습니다.`,
      sheet: sheet.name, cell: null, difference: null,
    });
  }

  let rowIndex: number | null = null;
  let mode: Plan81Summary['mode'];
  const chosen = new Map<number, Row81>();
  if (typeof plan81Row === 'number') {
    const maxLen = Math.max(0, ...inRange.map((o) => groups.get(o)!.length));
    if (!Number.isInteger(plan81Row) || plan81Row < 0 || plan81Row >= maxLen) {
      issues.push({
        code: 'plan81_row_out_of_range',
        message: `고른 8-1 행(${plan81Row})이 후보(0~${maxLen - 1}) 밖입니다.`,
        sheet: sheet.name, cell: null,
      });
      return empty('chosen');
    }
    rowIndex = plan81Row;
    mode = 'chosen';
    for (const o of inRange) {
      const row = groups.get(o)![plan81Row];
      if (row) chosen.set(o, row);
    }
  } else {
    const key = orgKey(blockLabel);
    let reason: 'no-match' | 'multiple-match' | null = null;
    for (const o of inRange) {
      const hits = groups.get(o)!.filter((row) => orgKey(row.label) === key);
      if (hits.length === 1) chosen.set(o, hits[0]!);
      else if (hits.length === 0) reason = reason ?? 'no-match';
      else reason = 'multiple-match';
    }
    if (reason !== null || inRange.length === 0) {
      const maxLen = Math.max(0, ...inRange.map((o) => groups.get(o)!.length));
      const candidates: Plan81Candidate[] = [];
      for (let k = 0; k < maxLen; k += 1) {
        const rows = inRange
          .map((o) => groups.get(o)![k])
          .filter((row): row is Row81 => row !== undefined)
          .map((row) => ({ yearOrder: row.yearOrder, label: row.label, cell: a1(row.row, orgCol) }));
        candidates.push({ index: k, label: rows[0]?.label ?? '', rows });
      }
      return { kind: 'choose', reason: reason ?? 'no-match', candidates };
    }
    mode = 'auto';
  }

  const govCash: Record<string, number> = {};
  const checks: Plan81YearCheck[] = [];
  const at = (row: number, id: Attachment81ColumnId) => (columns[id] === undefined ? undefined : grid[row]?.[columns[id]!]);
  const cellOf = (row: number, id: Attachment81ColumnId) => (columns[id] === undefined ? null : a1(row, columns[id]!));
  const read = (row: number, id: Attachment81ColumnId): number | null => {
    if (columns[id] === undefined) return null;
    const parsed = parseAmountCell(at(row, id), unit);
    if (parsed.ok) return parsed.amount;
    warnings.push({
      code: 'plan81_unreadable',
      message: `'${sheet.name}' ${cellOf(row, id)}: 칸을 숫자로 읽지 못해 정합을 대조하지 않았습니다(${cellText(at(row, id))}).`,
      sheet: sheet.name, cell: cellOf(row, id), difference: null,
    });
    return null;
  };

  years.forEach((year, i) => {
    const row = chosen.get(i);
    if (!row) {
      warnings.push({
        code: 'plan81_year_missing',
        message: `'${sheet.name}'에 ${year.name}의 기관 행이 없습니다 — 그 연차 정부지원 현금은 미입력입니다.`,
        sheet: sheet.name, cell: null, difference: null,
      });
      return;
    }
    const where = `'${sheet.name}' ${year.name} '${row.label.replace(/\s+/g, ' ')}' 행`;
    const govCell = at(row.row, 'gov_cash');
    let gov: number | null = null;
    if (isBlankCell(govCell)) {
      warnings.push({
        code: 'plan81_gov_cash_blank',
        message: `${where}: 정부지원 현금(A) 칸이 비어 있어 그 연차는 미입력으로 둡니다.`,
        sheet: sheet.name, cell: cellOf(row.row, 'gov_cash'), difference: null,
      });
    } else {
      const parsed = parseAmountCell(govCell, unit);
      if (!parsed.ok || parsed.rounded || parsed.amount! < 0) {
        issues.push({
          code: 'plan81_invalid_amount',
          message: `${where} ${cellOf(row.row, 'gov_cash')}: 정부지원 현금(A) ${cellText(govCell)}이 0 이상 원 단위 정수가 아닙니다.`,
          sheet: sheet.name, cell: cellOf(row.row, 'gov_cash'),
        });
      } else {
        gov = parsed.amount!;
        govCash[year.id] = gov;
      }
    }

    const ownCash = read(row.row, 'own_cash');
    const ownInKind = read(row.row, 'own_in_kind');
    const totalCash = read(row.row, 'total_cash');
    const totalInKind = read(row.row, 'total_in_kind');
    const total = read(row.row, 'total');
    const imported = block.axisTotals[i] ?? { cash: 0, inKind: 0 };
    const ours = { cash: imported.cash, inKind: imported.inKind, total: imported.cash + imported.inKind };
    let matches = gov !== null && ownCash !== null && ownInKind !== null && total !== null;

    const compare = (fileValue: number | null, oursValue: number, fileWhat: string, oursWhat: string, id: Attachment81ColumnId) => {
      if (fileValue === null) return;
      const diff = fileValue - oursValue;
      if (diff === 0) return;
      matches = false;
      warnings.push({
        code: 'plan81_mismatch',
        message: `${where} ${cellOf(row.row, id)}: 8-1 ${fileWhat} ${won(fileValue)} ≠ 8-2 ${oursWhat} ${won(oursValue)} (차액 ${won(diff)}).`,
        sheet: sheet.name, cell: cellOf(row.row, id), difference: diff,
      });
    };
    if (gov !== null && ownCash !== null) compare(gov + ownCash, ours.cash, '현금(A+B)', '현금 합', 'own_cash');
    compare(ownInKind, ours.inKind, '현물(C)', '현물 합', 'own_in_kind');
    compare(total, ours.total, '합계(H)', '합계', 'total');

    for (const id of ['other_cash', 'other_in_kind'] as const) {
      const v = read(row.row, id);
      if (v === null || v === 0) continue;
      warnings.push({
        code: 'plan81_other_support',
        message: `${where} ${cellOf(row.row, id)}: 그 외 기관 등의 지원금 ${id === 'other_cash' ? '현금(E)' : '현물(F)'}이 ${won(v)}입니다 — 협약 버전에는 담지 않습니다.`,
        sheet: sheet.name, cell: cellOf(row.row, id), difference: v,
      });
    }

    checks.push({
      yearId: year.id,
      yearName: year.name,
      cell: a1(row.row, orgCol),
      label: row.label,
      govCash: gov,
      file: { ownCash, ownInKind, totalCash, totalInKind, total },
      imported: ours,
      matches,
    });
  });

  return { kind: 'ok', govCash, summary: { mode, rowIndex, years: checks }, warnings, issues };
}

// ─── 진입점 ───────────────────────────────────────────────────────────────────

const LINE_AXIS_RANK: Record<DetailAxis, number> = { cash: 0, in_kind: 1 };

/**
 * 붙임4 격자 → 금액 줄 + 정부지원 현금(AV-7, S-13·S-14). 단계 순서:
 * ① 8-2 시트 ② 블록 분할(총합 제외) ③ 블록 선택(G-11) ④ 단위 ⑤ 연차 열 ⑥ 행 종류(C.4) ⑦ 금액 ⑧ 같은 키 합산
 * → 8-1 행 찾기·정부지원 현금·정합. blocking이 하나라도 있으면 `blocked` — 버전을 반쯤 만들지 않는다.
 */
export function parseAttachment4(input: Attachment4ParseInput): Attachment4ParseResult {
  const years = [...input.years].sort((a, b) => a.order - b.order);
  const blocked = (blocks: Attachment4Block[], issues: Attachment4Issue[], warnings: Attachment4Warning[] = []) =>
    ({ status: 'blocked', blocks, issues, warnings }) as const;

  const sheet82 = findSheet(input.sheets, ATTACHMENT4_SHEET_8_2);
  if (!sheet82) {
    return blocked([], [{
      code: 'sheet_missing',
      message: `'${ATTACHMENT4_SHEET_8_2}' 시트가 없습니다(있는 시트: ${input.sheets.map((s) => `'${s.name}'`).join(', ') || '없음'}).`,
      sheet: null, cell: null,
    }]);
  }
  const layout = layout82(sheet82);
  if ('code' in layout) return blocked([], [layout]);

  const orgBlocks = layout.allBlocks.filter((b) => !b.total);
  const blocks: Attachment4Block[] = orgBlocks.map((b, index) => ({ index, label: b.label, startRow: b.start + 1, endRow: b.end + 1 }));
  if (blocks.length === 0) {
    return blocked(blocks, [{ code: 'no_blocks', message: `'${sheet82.name}'에 총합 블록 말고 기관 블록이 없습니다.`, sheet: sheet82.name, cell: null }]);
  }

  // G-11: 여럿이면 사용자가 고른다 — 텍스트로 추측하지 않는다
  if (input.blockIndex === undefined && blocks.length > 1) return { status: 'choose-block', blocks };
  const blockIndex = input.blockIndex ?? 0;
  if (!Number.isInteger(blockIndex) || blockIndex < 0 || blockIndex >= blocks.length) {
    return blocked(blocks, [{
      code: 'block_out_of_range',
      message: `고른 블록(${blockIndex})이 기관 블록 목록(0~${blocks.length - 1}) 밖입니다.`,
      sheet: sheet82.name, cell: null,
    }]);
  }
  const block = orgBlocks[blockIndex]!;

  if (years.length === 0) {
    return blocked(blocks, [{ code: 'no_years', message: '과제에 연차가 없습니다 — 연차를 먼저 만드세요.', sheet: null, cell: null }]);
  }

  const sheet81 = findSheet(input.sheets, ATTACHMENT4_SHEET_8_1);
  const warnings: Attachment4Warning[] = [];
  const hint82 = detectAmountUnit(sheet82);
  const hint81 = sheet81 ? detectAmountUnit(sheet81) : null;
  // 실측 8-2에는 단위 표기가 없고 8-1에만 `(단위: 천원)`이 있다 — 같은 양식의 표기를 쓰고 그 사실을 알린다
  const unit82: Attachment4Unit | null = hint82
    ? { unit: hint82.unit, text: hint82.text, sheet: sheet82.name }
    : hint81 && sheet81
      ? { unit: hint81.unit, text: hint81.text, sheet: sheet81.name }
      : null;
  if (!unit82) {
    return blocked(blocks, [{
      code: 'unit_missing',
      message: `'${sheet82.name}'·'${ATTACHMENT4_SHEET_8_1}' 어디에도 '(단위: 천원)' 같은 단위 표기가 없습니다 — 1000배 오류를 막기 위해 가져오지 않습니다.`,
      sheet: sheet82.name, cell: null,
    }]);
  }
  if (!hint82) {
    warnings.push({
      code: 'unit_from_other_sheet',
      message: `'${sheet82.name}'에 단위 표기가 없어 '${unit82.sheet}'의 '${unit82.text}'을 씁니다.`,
      sheet: sheet82.name, cell: null, difference: null,
    });
  }
  const unit81: AmountUnit = hint81?.unit ?? unit82.unit;

  const parsed = parseBlock(sheet82, layout, block, years, unit82.unit);
  warnings.push(...parsed.warnings);
  if (parsed.issues.length > 0) return blocked(blocks, parsed.issues, warnings);
  // 8-1 A만 있어도 금액 줄 0개면 막는다 — 정부지원 현금만 담긴 0원 버전이 조용히 생기면 절대 규칙 5 위반이다(AV-7 ②)
  if (parsed.lines.size === 0) {
    return blocked(blocks, [{
      code: 'no_amounts',
      message: `'${sheet82.name}' ${block.label.replace(/\s+/g, ' ')} 블록(${block.start + 1}~${block.end + 1}행)의 금액 칸이 전부 0이거나 비어 있습니다 — 0원 협약 버전을 만들지 않도록 가져오기를 멈춥니다. 고른 블록이 맞는지 확인하세요.`,
      sheet: sheet82.name, cell: null,
    }], warnings);
  }

  const plan81 = readPlan81(sheet81, block.label, input.plan81Row, years, unit81, parsed);
  if (plan81.kind === 'choose') {
    return {
      status: 'choose-81-row',
      blocks,
      blockIndex,
      blockLabel: block.label,
      reason: plan81.reason,
      candidates: plan81.candidates,
      warnings,
    };
  }
  warnings.push(...plan81.warnings);
  if (plan81.issues.length > 0) return blocked(blocks, plan81.issues, warnings);

  const yearRank = new Map(years.map((y, i) => [y.id, i]));
  const categoryRank = new Map(BUDGET_CATEGORY_ORDER.map((c, i) => [c, i]));
  const lines = [...parsed.lines.values()].sort(
    (a, b) =>
      yearRank.get(a.yearId)! - yearRank.get(b.yearId)! ||
      categoryRank.get(a.category)! - categoryRank.get(b.category)! ||
      a.subcategoryCode.localeCompare(b.subcategoryCode) ||
      LINE_AXIS_RANK[a.axis] - LINE_AXIS_RANK[b.axis]
  );

  return {
    status: 'ok',
    blocks,
    blockIndex,
    blockLabel: block.label,
    unit: unit82,
    lines,
    govCash: plan81.govCash,
    plan81: plan81.summary,
    warnings,
  };
}
