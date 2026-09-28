// 사업비 입력 양식 파서 — 수행 모드 (SOT §6.16 IN-9~IN-13, §5.12, 부록 F-6).
//
// 제안 모드와 같은 좌표 맵에서 파생한 `sheetsFor('execution')`의 고정 좌표를 읽는다(IN-1·IN-9).
// 행 하나 = `BudgetExecution` 후보 하나이고, 기존 집행과는 숨김 `executionId`로만 잇는다(IN-10).
// 이름 매칭을 하지 않는다(IN-3) — 산출근거 임포트의 인력 매칭·라벨 정규화 함수를 import하지 않는다.
// 숫자·라벨 읽기는 제안 파서(parse.ts)의 헬퍼를 그대로 쓴다 — 같은 열이 모드마다 다르게 읽히면 안 된다.
// 진입점은 `parseInputForm(sheets, expected, 'execution')`이다 — 미리보기와 반영이 그 함수 하나를 탄다(IN-6).
//
// 여기서 판정하지 **않는** 것 (기존 집행·연차·인력 데이터가 필요해 미리보기의 몫이다):
// - `category-moved`(IN-10): `_meta`에는 executionId → version만 있고 원래 비목이 없다
// - 인건비 행의 금액 보완·`amount-mismatch`: 연봉이 필요하다(IN-11) — 원 금액(nullable)만 넘긴다
// - `date-out-of-year`: 연차 기간은 `_meta.yearId`로 연차를 찾은 뒤에야 안다 — `dateOutOfYearIssue`를 쓴다

import { computeDetailAmount } from '@/lib/budget-plan';
import { DETAIL_AXIS_LABELS, SUBCATEGORY_PRESETS } from '@/lib/constants';
import { cellAt, cellText } from '@/lib/import/grid';
import type { RawCell, RawSheet } from '@/lib/import/types';
import type { BudgetCategory, DetailAxis, DetailFactor } from '@/types';
import { columnOf, sheetsFor } from './layout';
import {
  AXIS_BY_LABEL,
  PERSONNEL_CODE_BY_LABEL,
  SUBCATEGORY_KEY_SEPARATOR,
  labelKey,
  parseSubcategoryKey,
  readDecimal,
  readInteger,
} from './parse';
import { EXECUTION_DESCRIPTION_MAX, EXECUTION_ISSUES } from './types';
import type {
  ExecutionFormMeta,
  ExecutionIssueKind,
  InputFormRejection,
  ParseIssue,
  ParsedExecutionForm,
  ParsedExecutionRow,
} from './types';

export type ParseExecutionFormResult =
  | { ok: true; parsed: ParsedExecutionForm }
  | { ok: false; rejection: InputFormRejection };

const SHEETS = sheetsFor('execution');

// ─── 문제 기록 ───────────────────────────────────────────────

/** 차단 여부는 `EXECUTION_ISSUES` 한 곳에서만 정한다 — 셀 값은 문구에 덧붙이기만 한다 */
function executionIssue(kind: ExecutionIssueKind, detail?: string): ParseIssue {
  const def = EXECUTION_ISSUES[kind];
  return { kind, message: detail === undefined ? def.message : `${def.message}: ${detail}`, blocking: def.blocking };
}

// 제안 모드와 같은 검사는 제안 모드의 사유 코드를 그대로 쓴다(types.ts ExecutionIssueKind 주석)
function blocking(kind: string, message: string): ParseIssue {
  return { kind, message, blocking: true };
}

function warning(kind: string, message: string): ParseIssue {
  return { kind, message, blocking: false };
}

// ─── 집행일 (IN-11, F-6) ─────────────────────────────────────

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const DAY_MS = 24 * 60 * 60 * 1000;
// 엑셀 1900 체계의 직렬값 0일. 60 = 1900-02-29는 로터스 호환으로 들어간 **없는 날**이라
// 61부터는 1899-12-30을, 1~59는 1899-12-31을 기준으로 센다
const SERIAL_EPOCH_FROM_61 = Date.UTC(1899, 11, 30);
const SERIAL_EPOCH_BELOW_60 = Date.UTC(1899, 11, 31);
const FAKE_LEAP_DAY_SERIAL = 60;
/** 9999-12-31. 엑셀이 날짜로 표시할 수 있는 마지막 직렬값 */
const MAX_DATE_SERIAL = 2_958_465;

function pad(n: number, width: number): string {
  return String(n).padStart(width, '0');
}

function isoOfUTC(epochMs: number): string {
  const d = new Date(epochMs);
  return `${pad(d.getUTCFullYear(), 4)}-${pad(d.getUTCMonth() + 1, 2)}-${pad(d.getUTCDate(), 2)}`;
}

/**
 * 엑셀 직렬값(1900 체계) → ISO `yyyy-mm-dd`. 공용 `readWorkbook`이 `cellDates: false`라 날짜 셀은 숫자로 온다(F-6).
 * 시각이 섞인 소수 직렬값은 날짜 열의 값이 아니다 — 잘라 내 하루를 정하지 않고 null이다. 없는 날(60)도 null.
 * UTC 산술만 쓴다 — 로컬 시간대를 거치면 자정 근처에서 하루가 밀린다.
 */
export function excelSerialToISO(serial: number): string | null {
  if (!Number.isInteger(serial) || serial < 1 || serial > MAX_DATE_SERIAL) return null;
  if (serial === FAKE_LEAP_DAY_SERIAL) return null;
  const epoch = serial > FAKE_LEAP_DAY_SERIAL ? SERIAL_EPOCH_FROM_61 : SERIAL_EPOCH_BELOW_60;
  return isoOfUTC(epoch + serial * DAY_MS);
}

/** `yyyy-mm-dd` 문자열 → 같은 문자열. 2026-02-30처럼 달력에 없는 날은 null */
function validIsoDate(text: string): string | null {
  const match = ISO_DATE.exec(text);
  if (match === null) return null;
  const epoch = Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  // Date.UTC는 없는 날을 다음 달로 넘기고 두 자리 연도를 1900년대로 읽는다 — 되돌려 비교해 잡는다
  return isoOfUTC(epoch) === text ? text : null;
}

type DateRead = { kind: 'empty' } | { kind: 'invalid'; text: string } | { kind: 'value'; iso: string };

/** 집행일 셀. 숫자는 직렬값, 문자열은 `yyyy-mm-dd`만 받는다 — 다른 표기를 추측해 살리지 않는다 */
export function readExecutionDate(cell: RawCell): DateRead {
  const text = cellText(cell);
  if (text === '') return { kind: 'empty' };
  if (cell.isError) return { kind: 'invalid', text };
  const iso = typeof cell.value === 'number' ? excelSerialToISO(cell.value) : validIsoDate(text);
  return iso === null ? { kind: 'invalid', text } : { kind: 'value', iso };
}

/**
 * S-14·IN-11: 집행일이 연차 기간 밖이면 경고(막지 않는다). 연차를 아는 미리보기가 부른다 — 파서는 `_meta.yearId`만
 * 알고 연차 날짜를 모른다. 연차 날짜가 없으면 판정하지 않는다.
 */
export function dateOutOfYearIssue(
  date: string,
  year: { startDate: string | null; endDate: string | null }
): ParseIssue | null {
  const before = year.startDate !== null && date < year.startDate;
  const after = year.endDate !== null && date > year.endDate;
  if (!before && !after) return null;
  return executionIssue('date-out-of-year', `${date} (연차 ${year.startDate ?? '?'} ~ ${year.endDate ?? '?'})`);
}

// ─── 공통 열 ─────────────────────────────────────────────────

/** 축. 수행 모드는 빈 칸이 null이다(IN-11) — 제안 모드처럼 현금으로 채우지도 알리지도 않는다 */
function readOptionalAxis(cell: RawCell, issues: ParseIssue[]): DetailAxis | null {
  const text = cellText(cell);
  if (text === '') return null;
  const axis = AXIS_BY_LABEL.get(labelKey(text));
  if (axis === undefined) {
    issues.push(
      blocking(
        'invalid-axis',
        `현금/현물은 '${DETAIL_AXIS_LABELS.cash}' 또는 '${DETAIL_AXIS_LABELS.in_kind}'이어야 합니다: ${text}`
      )
    );
    return null;
  }
  return axis;
}

/** 금액(IN-11, §5.12). 빈 칸은 null — 채울지 막을지는 시트마다 다르다. 문제가 있으면 null이다 */
function readAmount(cell: RawCell, issues: ParseIssue[]): { value: number | null; empty: boolean } {
  const read = readInteger(cell);
  switch (read.kind) {
    case 'empty':
      return { value: null, empty: true };
    case 'invalid':
      issues.push(executionIssue('amount-invalid', read.text));
      return { value: null, empty: false };
    case 'not-integer':
      issues.push(executionIssue('amount-not-integer', read.text));
      return { value: null, empty: false };
    case 'value':
      if (read.value < 0) {
        issues.push(executionIssue('amount-negative', String(read.value)));
        return { value: null, empty: false };
      }
      return { value: read.value, empty: false };
  }
}

interface KeyColumns {
  executionId: number;
  detailId: number;
  executionDate: number;
  amount: number;
  axis: number;
  note: number;
}

interface CommonFields {
  executionId: string | null;
  detailId: string | null;
  date: string | null;
  axis: DetailAxis | null;
  note: string;
}

/** 두 시트가 같은 규칙으로 읽는 열: 숨김 id 둘(IN-13), 집행일(IN-11), 축, 비고 */
function readCommon(
  cells: readonly (readonly RawCell[])[],
  r: number,
  col: KeyColumns,
  meta: ExecutionFormMeta,
  issues: ParseIssue[]
): CommonFields {
  const executionText = cellText(cellAt(cells, r, col.executionId));
  if (executionText !== '' && !Object.prototype.hasOwnProperty.call(meta.executions, executionText)) {
    // 버리지 않고 남긴다 — 다른 양식에서 복사한 행은 미리보기에 오류 행으로 보여야 한다(IN-13)
    issues.push(executionIssue('unknown-execution', executionText));
  }

  const detailText = cellText(cellAt(cells, r, col.detailId));
  if (detailText !== '' && !meta.detailIds.includes(detailText)) {
    issues.push(executionIssue('unknown-detail', detailText));
  }

  let date: string | null = null;
  const dateRead = readExecutionDate(cellAt(cells, r, col.executionDate));
  if (dateRead.kind === 'empty') issues.push(executionIssue('no-date'));
  else if (dateRead.kind === 'invalid') issues.push(executionIssue('invalid-date', dateRead.text));
  else date = dateRead.iso;

  return {
    executionId: executionText === '' ? null : executionText,
    detailId: detailText === '' ? null : detailText,
    date,
    axis: readOptionalAxis(cellAt(cells, r, col.axis), issues),
    note: cellText(cellAt(cells, r, col.note)),
  };
}

function isBlank(cells: readonly (readonly RawCell[])[], row: number, columns: readonly number[]): boolean {
  return columns.every((column) => cellText(cellAt(cells, row, column)) === '');
}

/**
 * 건너뛰는 행. 빈 행(사용자 열이 전부 빔)과 소계·총액 행이다. 수행 모드는 금액이 사용자 열이라
 * 소계·총액 행(금액 칸에 SUM 수식 — 엑셀이 저장하면 계산값이 들어온다)이 빈 행 판정만으로는 걸리지 않는다.
 * 그 행은 숨김 키가 전부 비고 금액 말고는 사용자 열도 비어 있다(build.ts pushSumRow) — 그 모양만 건너뛴다.
 * 키 없이 금액만 적은 사용자 행도 같은 모양이지만, 집행일이 없어 어차피 반영할 수 없는 행이다.
 */
function isSkippedRow(
  cells: readonly (readonly RawCell[])[],
  r: number,
  userColumnsWithoutAmount: readonly number[],
  amountColumn: number,
  keyColumns: readonly number[]
): boolean {
  if (!isBlank(cells, r, userColumnsWithoutAmount)) return false;
  return isBlank(cells, r, [amountColumn]) || isBlank(cells, r, keyColumns);
}

// ─── 인자 ────────────────────────────────────────────────────

// 파서가 소수 인자를 소수 6자리 정수 산술로 읽으므로(parse.ts DECIMAL_SCALE) 되돌릴 때도 같은 자리에서 자른다 —
// `0.28 * 100`은 28.000000000000004라 그대로 두면 왕복 후 unchanged 판정이 깨진다
const PERCENT_RESTORE_SCALE = 1_000_000;

function restorePercent(value: number): number {
  return Math.round(value * 100 * PERCENT_RESTORE_SCALE) / PERCENT_RESTORE_SCALE;
}

type FactorDefs = readonly { label: string; isPercent: boolean }[];

/**
 * `세목 미지정` 슬롯(IN-4)의 인자 라벨. 세목이 없으니 프리셋이 없다 — 그 비목의 세목이 **모두 같은**
 * `defaultFactors`를 쓰면(인건비 2비목의 참여율·참여기간, 시설장비·재료비의 수량) 그것을 쓰고, 세목마다 다르면
 * (연구활동비) 정할 수 없으므로 비운다. 인건비 슬롯은 인력 없는 인건비 집행이 실리는 자리라(IN-12) 참여율의
 * isPercent가 살아야 금액 보완이 맞는다.
 */
function slotFactorDefs(category: BudgetCategory): FactorDefs {
  const presets = SUBCATEGORY_PRESETS[category];
  const first = presets[0];
  if (first === undefined) return [];
  const signature = JSON.stringify(first.defaultFactors);
  return presets.every((def) => JSON.stringify(def.defaultFactors) === signature) ? first.defaultFactors : [];
}

function factorDefsOf(category: BudgetCategory | null, subcategoryCode: string | null): FactorDefs {
  if (category === null) return [];
  if (subcategoryCode === null) return slotFactorDefs(category);
  return SUBCATEGORY_PRESETS[category].find((def) => def.code === subcategoryCode)?.defaultFactors ?? [];
}

/**
 * IN-4와 같은 규약: 라벨·isPercent는 프리셋 자리(인자1~3) 그대로, isPercent 칸은 생성기가 `/100`해 둔 값이라
 * `×100`으로 되돌린다. 프리셋보다 인자가 많으면 `인자N`(비율 아님)이고 라벨 손실을 경고한다 —
 * 기존 집행의 라벨은 미리보기가 안다.
 */
function labelFactors(values: readonly number[], defs: FactorDefs, issues: ParseIssue[]): DetailFactor[] {
  return values.map((value, index) => {
    const def = defs[index];
    if (def === undefined) {
      const label = `인자${index + 1}`;
      issues.push(warning('factor-without-preset', `인자${index + 1}에 프리셋 라벨이 없어 '${label}'로 둡니다`));
      return { label, value, isPercent: false };
    }
    return { label: def.label, value: def.isPercent ? restorePercent(value) : value, isPercent: def.isPercent };
  });
}

// 인건비 시트의 참여율·개월 열이 담기는 인자 라벨(IN-12). 부록 A.5 인건비 세목 5종이 같은 한 쌍이다
function personnelFactorDef(isPercent: boolean): { label: string; isPercent: boolean } {
  const found = SUBCATEGORY_PRESETS.personnel[0]?.defaultFactors.find((def) => def.isPercent === isPercent);
  // 프리셋이 바뀌어 한쪽이 사라지면 참여율·개월이 조용히 버려진다 — 모듈 로드 시점에 터뜨린다
  if (found === undefined) throw new Error('부록 A.5 인건비 프리셋에 참여율(%)·참여기간(월) 인자가 없다');
  return found;
}

const PARTICIPATION_DEF = personnelFactorDef(true);
const MONTHS_DEF = personnelFactorDef(false);

/** 참여율·개월 한 칸. 수행 모드는 비어도 된다 — 집행은 금액이 원본이다(IN-11). 범위는 제안 모드와 같다(IN-3) */
function readOptionalRanged(
  cell: RawCell,
  issues: ParseIssue[],
  label: string,
  kindPrefix: string,
  min: number,
  max: number
): number | null {
  const read = readDecimal(cell);
  switch (read.kind) {
    case 'empty':
      return null;
    case 'invalid':
    case 'not-integer':
      issues.push(blocking(`${kindPrefix}-invalid`, `${label}을(를) 숫자로 읽을 수 없습니다: ${read.text}`));
      return null;
    case 'value':
      if (read.value < min || read.value > max) {
        issues.push(
          blocking(`${kindPrefix}-out-of-range`, `${label}은(는) ${min}~${max} 사이여야 합니다: ${read.value}`)
        );
      }
      return read.value;
  }
}

// ─── 인건비 시트 (IN-12) ─────────────────────────────────────

function personnelCategoryOf(subcategory: string): BudgetCategory | null {
  for (const category of ['personnel', 'student_personnel'] as const) {
    if (SUBCATEGORY_PRESETS[category].some((def) => def.code === subcategory)) return category;
  }
  return null;
}

function parsePersonnelSheet(sheet: RawSheet, meta: ExecutionFormMeta): ParsedExecutionRow[] {
  const def = SHEETS.personnel;
  const col = {
    memberId: columnOf(def, 'memberId'),
    detailId: columnOf(def, 'detailId'),
    executionId: columnOf(def, 'executionId'),
    executionDate: columnOf(def, 'executionDate'),
    subcategory: columnOf(def, 'subcategory'),
    participation: columnOf(def, 'participation'),
    months: columnOf(def, 'months'),
    axis: columnOf(def, 'axis'),
    amount: columnOf(def, 'amount'),
    note: columnOf(def, 'note'),
  };
  // 생성기는 집행이 없는 인력에도 키만 채운 빈 행을 깐다(IN-12) — 키 열·세목·축은 빈 행 판정에서 뺀다
  const userColumnsWithoutAmount = [col.executionDate, col.participation, col.months, col.note];
  const keyColumns = [col.memberId, col.detailId, col.executionId];
  const knownMembers = new Set(meta.memberIds);

  const rows: ParsedExecutionRow[] = [];
  const cells = sheet.cells;
  for (let r = def.dataStartRow - 1; r < cells.length; r += 1) {
    if (isSkippedRow(cells, r, userColumnsWithoutAmount, col.amount, keyColumns)) continue;
    const issues: ParseIssue[] = [];

    const memberText = cellText(cellAt(cells, r, col.memberId));
    if (!knownMembers.has(memberText)) {
      // 인력 없는 인건비 집행의 자리는 사업비 시트 `세목 미지정` 슬롯이다(IN-12) — 여기서는 id가 반드시 있어야 한다
      issues.push(executionIssue('unknown-member', memberText === '' ? '(비어 있음)' : memberText));
    }

    const common = readCommon(cells, r, col, meta, issues);

    const subcategoryLabel = cellText(cellAt(cells, r, col.subcategory));
    let subcategoryCode: string | null;
    if (subcategoryLabel === '') {
      // IN-3과 같다: 빈 세목은 내부인건비 기본 + 알림
      subcategoryCode = 'personnel_internal';
      issues.push(warning('default-subcategory', "세목이 비어 있어 '내부인건비'로 둡니다"));
    } else {
      subcategoryCode = PERSONNEL_CODE_BY_LABEL.get(labelKey(subcategoryLabel)) ?? null;
      if (subcategoryCode === null) {
        issues.push(blocking('unknown-subcategory', `알 수 없는 인건비 세목입니다: ${subcategoryLabel}`));
      }
    }

    const participation = readOptionalRanged(
      cellAt(cells, r, col.participation), issues, '참여율(%)', 'participation', 0, 100
    );
    const months = readOptionalRanged(cellAt(cells, r, col.months), issues, '참여개월', 'months', 0, 12);
    // IN-12: 참여율(isPercent)·참여기간(월). 인건비 시트의 참여율은 % 그대로 적힌다(layout.ts — 백분율 서식 없음)
    const factors: DetailFactor[] = [];
    if (participation !== null) factors.push({ ...PARTICIPATION_DEF, value: participation });
    if (months !== null) factors.push({ ...MONTHS_DEF, value: months });

    // 연봉이 필요한 보완·대조는 미리보기의 몫이다(IN-11) — 원 금액만 넘긴다
    const amount = readAmount(cellAt(cells, r, col.amount), issues).value;

    rows.push({
      rowIndex: r + 1,
      executionId: common.executionId,
      category: subcategoryCode === null ? null : personnelCategoryOf(subcategoryCode),
      subcategoryCode,
      memberId: memberText === '' ? null : memberText,
      detailId: common.detailId,
      date: common.date,
      // 인건비 시트에는 품명·규격·단가 열이 없다
      description: '',
      spec: '',
      unitPrice: null,
      factors: factors.length === 0 ? null : factors,
      axis: common.axis,
      amount,
      note: common.note,
      issues,
    });
  }
  return rows;
}

// ─── 사업비 시트 (IN-4·IN-11) ────────────────────────────────

function isBudgetCategory(text: string): text is BudgetCategory {
  return Object.prototype.hasOwnProperty.call(SUBCATEGORY_PRESETS, text);
}

/**
 * 복합 키 → (비목, 세목 코드). 제안 모드와 같은 검사(IN-4)에 두 가지가 더해진다.
 * - `세목 미지정` 슬롯(`비목:` — 세목 부분이 빔). 슬롯의 세목 코드는 null이다.
 * - `_meta.subcategoryCodes`에 있는 키. 프리셋 밖 세목 코드를 가진 기존 집행은 생성기가 그 코드로 슬롯을
 *   더 깐다(build.ts executionSubcategorySlots) — DB 값에서 온 키라 거부하면 손대지 않은 양식이 막힌다.
 *   제안 모드는 이 완화를 하지 않는다(parse.ts는 그대로).
 */
function resolveBudgetKey(
  key: string,
  metaKeys: ReadonlySet<string>
): { category: BudgetCategory; subcategoryCode: string | null } | null {
  const slotCategory = key.endsWith(SUBCATEGORY_KEY_SEPARATOR) ? key.slice(0, -SUBCATEGORY_KEY_SEPARATOR.length) : null;
  if (slotCategory !== null && isBudgetCategory(slotCategory)) {
    return { category: slotCategory, subcategoryCode: null };
  }
  const resolved = parseSubcategoryKey(key);
  if (resolved !== null) return { category: resolved.category, subcategoryCode: resolved.subcategory };
  if (!metaKeys.has(key)) return null;
  const at = key.indexOf(SUBCATEGORY_KEY_SEPARATOR);
  if (at <= 0) return null;
  const category = key.slice(0, at);
  const code = key.slice(at + 1);
  if (code === '' || !isBudgetCategory(category)) return null;
  return { category, subcategoryCode: code };
}

function parseBudgetSheet(sheet: RawSheet, meta: ExecutionFormMeta): ParsedExecutionRow[] {
  const def = SHEETS.budget;
  const col = {
    subcategory: columnOf(def, 'subcategory'),
    detailId: columnOf(def, 'detailId'),
    executionId: columnOf(def, 'executionId'),
    executionDate: columnOf(def, 'executionDate'),
    name: columnOf(def, 'name'),
    spec: columnOf(def, 'spec'),
    unitPrice: columnOf(def, 'unitPrice'),
    factors: [columnOf(def, 'factor1'), columnOf(def, 'factor2'), columnOf(def, 'factor3')],
    axis: columnOf(def, 'axis'),
    amount: columnOf(def, 'amount'),
    note: columnOf(def, 'note'),
  };
  // 조정액은 수행 모드에서 읽지 않는다(IN-9) — 빈 행 판정에도 넣지 않는다
  const userColumnsWithoutAmount = [
    col.executionDate, col.name, col.spec, col.unitPrice, ...col.factors, col.note,
  ];
  const keyColumns = [col.subcategory, col.detailId, col.executionId];
  const metaKeys = new Set(meta.subcategoryCodes);

  const rows: ParsedExecutionRow[] = [];
  const cells = sheet.cells;
  for (let r = def.dataStartRow - 1; r < cells.length; r += 1) {
    if (isSkippedRow(cells, r, userColumnsWithoutAmount, col.amount, keyColumns)) continue;
    const issues: ParseIssue[] = [];

    const key = cellText(cellAt(cells, r, col.subcategory));
    const resolved = resolveBudgetKey(key, metaKeys);
    if (resolved === null) {
      issues.push(
        blocking('unknown-subcategory', key === '' ? '세목 키가 없는 행입니다' : `알 수 없는 세목입니다: ${key}`)
      );
    }

    const common = readCommon(cells, r, col, meta, issues);

    const description = cellText(cellAt(cells, r, col.name));
    if (description.length > EXECUTION_DESCRIPTION_MAX) {
      issues.push(executionIssue('description-too-long', `${description.length}자`));
    }

    let unitPrice: number | null = null;
    let unitPriceUsable = false;
    const unitRead = readInteger(cellAt(cells, r, col.unitPrice));
    if (unitRead.kind === 'value') {
      unitPrice = unitRead.value;
      if (unitPrice < 0) issues.push(blocking('unit-price-negative', `단가는 음수일 수 없습니다: ${unitPrice}`));
      else unitPriceUsable = true;
    } else if (unitRead.kind === 'not-integer') {
      issues.push(blocking('unit-price-not-integer', `단가는 원 단위 정수여야 합니다: ${unitRead.text}`));
    } else if (unitRead.kind === 'invalid') {
      issues.push(blocking('unit-price-invalid', `단가를 숫자로 읽을 수 없습니다: ${unitRead.text}`));
    }

    // 빈 인자 칸은 "인자가 없다"이지 0이 아니다(제안 모드와 같다)
    const factorValues: number[] = [];
    let factorsUsable = true;
    col.factors.forEach((column, index) => {
      const read = readDecimal(cellAt(cells, r, column));
      if (read.kind === 'empty') return;
      if (read.kind === 'value') {
        factorValues.push(read.value);
        return;
      }
      factorsUsable = false;
      issues.push(blocking('factor-invalid', `인자${index + 1}을(를) 숫자로 읽을 수 없습니다: ${read.text}`));
    });
    const category = resolved?.category ?? null;
    const subcategoryCode = resolved?.subcategoryCode ?? null;
    const factors = labelFactors(factorValues, factorDefsOf(category, subcategoryCode), issues);

    // IN-11: 단가 × 인자(PL-1의 곱, 조정액 없음). 계산은 lib/budget-plan 한 곳이다 — 여기서 곱하지 않는다
    const computed =
      unitPriceUsable && factorsUsable && unitPrice !== null && category !== null
        ? computeDetailAmount({
            yearId: meta.yearId,
            category,
            subcategory: subcategoryCode ?? '',
            axis: common.axis ?? 'cash',
            formula: 'quantity',
            memberId: null,
            unitPrice,
            adjustment: 0,
            factors,
          }).amount
        : null;

    const amountRead = readAmount(cellAt(cells, r, col.amount), issues);
    let amount = amountRead.value;
    if (amountRead.empty) {
      if (computed !== null) amount = computed;
      // 단가 칸 자체가 틀렸으면 그 오류가 이미 막는다 — 채울 근거가 아예 없을 때만 no-amount
      else if (unitRead.kind === 'empty') issues.push(executionIssue('no-amount'));
    } else if (amount !== null && computed !== null && amount !== computed) {
      issues.push(executionIssue('amount-mismatch', `입력 ${amount} · 단가×인자 ${computed}`));
    }

    rows.push({
      rowIndex: r + 1,
      executionId: common.executionId,
      category,
      subcategoryCode,
      // 사업비 시트에는 인력 열이 없다 — 인력 없는 인건비 집행이 슬롯에 실리는 이유다(IN-12)
      memberId: null,
      detailId: common.detailId,
      date: common.date,
      description,
      spec: cellText(cellAt(cells, r, col.spec)),
      unitPrice,
      factors: factors.length === 0 ? null : factors,
      axis: common.axis,
      amount,
      note: common.note,
      issues,
    });
  }
  return rows;
}

// ─── 진입점 (parse.ts가 부른다) ──────────────────────────────

/**
 * `_meta`·mode 검사(IN-2·IN-9)와 시트 존재 확인을 통과한 수행 양식 → 행 목록. 버리는 행이 없다 —
 * 통과한 뒤의 문제는 전부 행별 `issues`다. 직접 부르지 말고 `parseInputForm(…, 'execution')`을 쓴다.
 */
export function parseExecutionSheets(
  personnelSheet: RawSheet,
  budgetSheet: RawSheet,
  meta: ExecutionFormMeta
): ParsedExecutionForm {
  return {
    meta,
    personnel: parsePersonnelSheet(personnelSheet, meta),
    budget: parseBudgetSheet(budgetSheet, meta),
    issues: [],
  };
}
