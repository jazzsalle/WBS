// 사업비 입력 양식 파서 (SOT §6.16 IN-2·IN-3·IN-4·IN-6, §6.11 D-22).
//
// 우리 양식이므로 헤더를 추측하지 않는다 — `layout.ts` 좌표 맵의 고정 좌표를 읽는다(IN-1).
// 행은 숨김 키(memberId·세목 코드·detailId)로만 잇는다. 이름 매칭(D-11~D-14)을 하지 않으므로
// 산출근거 임포트 미리보기의 인력 매칭·라벨 정규화 함수를 **import하지 않는다**(IN-3).
// `read: false` 열(연봉·월급·산식 금액·금액·성명…)은 열 인덱스조차 구하지 않는다 —
// 사용자가 그 칸을 고쳐 올려도 서버가 다시 계산한 값이 쓰인다(PL-D7).
// 미리보기와 반영이 이 함수 하나를 탄다(IN-6). SheetJS 무의존(IN-8).

import { DETAIL_AXIS_LABELS, SUBCATEGORY_PRESETS } from '@/lib/constants';
import { parseAmountCell } from '@/lib/import/amount';
import { cellAt, cellText } from '@/lib/import/grid';
import type { RawCell, RawSheet } from '@/lib/import/types';
import type { BudgetCategory, DetailAxis } from '@/types';
import { INPUT_FORM_SHEETS, columnOf } from './layout';
import { NO_META_MESSAGE, checkMeta, parseMeta } from './meta';
import type {
  InputFormRejection,
  ParseIssue,
  ParsedInputForm,
  ParsedPersonnelRow,
  ParsedQuantityRow,
} from './types';

export type ParseInputFormResult =
  | { ok: true; parsed: ParsedInputForm }
  | { ok: false; rejection: InputFormRejection };

// ─── 숫자 읽기 ───────────────────────────────────────────────

// 소수 인자를 정수 산술로 읽기 위한 배수 (lib/import/detail-sheet.ts의 FACTOR_SCALE과 같은 이유)
const DECIMAL_SCALE = 1_000_000;

type NumberRead =
  | { kind: 'empty' }
  | { kind: 'invalid'; text: string }
  | { kind: 'not-integer'; text: string }
  | { kind: 'value'; value: number };

/**
 * 소수 허용 숫자(참여율·개월·인자).
 * D-22: 백분율 서식 셀은 저장값이 100배 작다(`28.0%` → `0.28`). 어댑터가 알려 준 `percentFormat`일 때만
 * ×100 한다 — 휴리스틱 없음. 곱셈을 나눗셈보다 먼저 해서 부동소수점 오차를 만들지 않는다.
 */
function readDecimal(cell: RawCell): NumberRead {
  if (cellText(cell) === '') return { kind: 'empty' };
  const parsed = parseAmountCell(cell, DECIMAL_SCALE);
  if (!parsed.ok || parsed.amount === null) return { kind: 'invalid', text: parsed.rawText };
  const scaled = cell.percentFormat === true ? parsed.amount * 100 : parsed.amount;
  return { kind: 'value', value: scaled / DECIMAL_SCALE };
}

/** 원 단위 정수(단가·조정액). 소수는 반올림해 삼키지 않고 거부한다 — 금액 자리의 소수는 입력 실수다 */
function readInteger(cell: RawCell): NumberRead {
  if (cellText(cell) === '') return { kind: 'empty' };
  const parsed = parseAmountCell(cell, 1);
  if (!parsed.ok || parsed.amount === null) return { kind: 'invalid', text: parsed.rawText };
  if (parsed.rounded) return { kind: 'not-integer', text: parsed.rawText };
  return { kind: 'value', value: parsed.amount };
}

// ─── 라벨 → 코드 ─────────────────────────────────────────────

/** 우리가 쓴 라벨이라 정규화는 공백 제거뿐이다. 부처 서식의 별칭 사전(부록 C)을 타지 않는다 */
function labelKey(text: string): string {
  return text.replace(/\s+/g, '');
}

const AXIS_BY_LABEL: ReadonlyMap<string, DetailAxis> = new Map(
  (Object.entries(DETAIL_AXIS_LABELS) as [DetailAxis, string][]).map(([axis, label]) => [
    labelKey(label),
    axis,
  ])
);

// IN-3: 인건비 시트의 보이는 `세목` 열은 인건비 2비목(인건비·학생인건비) 프리셋 라벨 5종만 받는다
const PERSONNEL_CATEGORIES: readonly BudgetCategory[] = ['personnel', 'student_personnel'];

const PERSONNEL_CODE_BY_LABEL: ReadonlyMap<string, string> = new Map(
  PERSONNEL_CATEGORIES.flatMap((category) =>
    SUBCATEGORY_PRESETS[category].map((def) => [labelKey(def.label), def.code] as const)
  )
);

/** IN-4 복합 키 `비목:세목` (예 `activity:activity_meeting`, `consignment:default`). 생성기·`_meta`·파서가 같은 형식을 쓴다 */
export const SUBCATEGORY_KEY_SEPARATOR = ':';

export function subcategoryKeyOf(category: BudgetCategory, subcategory: string): string {
  return `${category}${SUBCATEGORY_KEY_SEPARATOR}${subcategory}`;
}

/**
 * 복합 키 → (비목, 세목). 세목 코드 `default`는 부록 A.5에서 여섯 비목이 공유하므로 세목 코드만으로는
 * 비목을 정할 수 없다 — `:` 없는 bare 코드는 지어내지 않고 null이다. 프리셋에 그 (비목, 세목) 조합이
 * 없어도 null이다(PL-D4).
 */
export function parseSubcategoryKey(key: string): { category: BudgetCategory; subcategory: string } | null {
  const at = key.indexOf(SUBCATEGORY_KEY_SEPARATOR);
  if (at <= 0) return null;
  const category = key.slice(0, at);
  const subcategory = key.slice(at + 1);
  if (!Object.prototype.hasOwnProperty.call(SUBCATEGORY_PRESETS, category)) return null;
  const presets = SUBCATEGORY_PRESETS[category as BudgetCategory];
  if (!presets.some((def) => def.code === subcategory)) return null;
  return { category: category as BudgetCategory, subcategory };
}

// ─── 공통 열 읽기 ────────────────────────────────────────────

function blocking(kind: string, message: string): ParseIssue {
  return { kind, message, blocking: true };
}

function warning(kind: string, message: string): ParseIssue {
  return { kind, message, blocking: false };
}

/** 축. 빈 칸은 현금 기본 + 비차단 알림 — 조용히 채우지 않는다 */
function readAxis(cell: RawCell, issues: ParseIssue[]): DetailAxis | null {
  const text = cellText(cell);
  if (text === '') {
    issues.push(warning('default-axis', `현금/현물이 비어 있어 '${DETAIL_AXIS_LABELS.cash}'으로 둡니다`));
    return 'cash';
  }
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

/** 조정액. 빈 칸은 0 — 조정이 없다는 뜻이다. 소수·문자는 막는다 */
function readAdjustment(cell: RawCell, issues: ParseIssue[]): number {
  const read = readInteger(cell);
  switch (read.kind) {
    case 'empty':
      return 0;
    case 'value':
      return read.value;
    case 'not-integer':
      issues.push(blocking('adjustment-not-integer', `조정액은 원 단위 정수여야 합니다: ${read.text}`));
      return 0;
    case 'invalid':
      issues.push(blocking('adjustment-invalid', `조정액을 숫자로 읽을 수 없습니다: ${read.text}`));
      return 0;
  }
}

function readRanged(
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
      issues.push(blocking(`${kindPrefix}-missing`, `${label}이(가) 비어 있습니다`));
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

function isBlank(cells: readonly (readonly RawCell[])[], row: number, columns: readonly number[]): boolean {
  return columns.every((column) => cellText(cellAt(cells, row, column)) === '');
}

// ─── 인건비 시트 (IN-3) ──────────────────────────────────────

function parsePersonnelSheet(sheet: RawSheet, knownMemberIds: ReadonlySet<string>): ParsedPersonnelRow[] {
  const def = INPUT_FORM_SHEETS.personnel;
  const col = {
    memberId: columnOf(def, 'memberId'),
    detailId: columnOf(def, 'detailId'),
    subcategory: columnOf(def, 'subcategory'),
    participation: columnOf(def, 'participation'),
    months: columnOf(def, 'months'),
    axis: columnOf(def, 'axis'),
    adjustment: columnOf(def, 'adjustment'),
    note: columnOf(def, 'note'),
  };
  // 생성기는 산출근거가 없는 인력에도 키만 채운 빈 행을 깔아 둔다(IN-3 "0건이면 빈 값 1행").
  // 그래서 빈 행 판정은 키 열을 빼고 사용자가 적는 열만 본다
  const userColumns = [col.participation, col.months, col.adjustment, col.note];

  const rows: ParsedPersonnelRow[] = [];
  const cells = sheet.cells;
  for (let r = def.dataStartRow - 1; r < cells.length; r += 1) {
    if (isBlank(cells, r, userColumns)) continue;
    const issues: ParseIssue[] = [];

    const memberId = cellText(cellAt(cells, r, col.memberId));
    if (!knownMemberIds.has(memberId)) {
      // 버리지 않고 남긴다 — "알 수 없는 행"으로 미리보기에 보여야 한다(IN-3)
      issues.push(
        blocking(
          'unknown-member',
          memberId === ''
            ? '인력 id가 없는 행입니다 — 양식에 있던 인력 행만 받습니다'
            : `양식에 없던 인력입니다: ${memberId}`
        )
      );
    }

    const detailText = cellText(cellAt(cells, r, col.detailId));
    const subcategoryLabel = cellText(cellAt(cells, r, col.subcategory));
    let subcategory: string | null;
    if (subcategoryLabel === '') {
      // IN-3: 빈 세목은 내부인건비 기본
      subcategory = 'personnel_internal';
      issues.push(warning('default-subcategory', "세목이 비어 있어 '내부인건비'로 둡니다"));
    } else {
      subcategory = PERSONNEL_CODE_BY_LABEL.get(labelKey(subcategoryLabel)) ?? null;
      if (subcategory === null) {
        issues.push(blocking('unknown-subcategory', `알 수 없는 인건비 세목입니다: ${subcategoryLabel}`));
      }
    }

    const participation = readRanged(cellAt(cells, r, col.participation), issues, '참여율(%)', 'participation', 0, 100);
    // 연차 개월 초과는 연차를 아는 미리보기(T4)의 경고다 — 여기서는 달력 범위만 본다
    const months = readRanged(cellAt(cells, r, col.months), issues, '참여개월', 'months', 0, 12);
    const axis = readAxis(cellAt(cells, r, col.axis), issues);
    const adjustment = readAdjustment(cellAt(cells, r, col.adjustment), issues);
    const note = cellText(cellAt(cells, r, col.note));

    rows.push({
      rowIndex: r + 1,
      memberId,
      detailId: detailText === '' ? null : detailText,
      subcategory,
      participation,
      months,
      axis,
      adjustment,
      note,
      issues,
    });
  }
  return rows;
}

// ─── 사업비 시트 (IN-4) ──────────────────────────────────────

function parseBudgetSheet(sheet: RawSheet): ParsedQuantityRow[] {
  const def = INPUT_FORM_SHEETS.budget;
  const col = {
    subcategory: columnOf(def, 'subcategory'),
    detailId: columnOf(def, 'detailId'),
    name: columnOf(def, 'name'),
    spec: columnOf(def, 'spec'),
    unitPrice: columnOf(def, 'unitPrice'),
    factors: [columnOf(def, 'factor1'), columnOf(def, 'factor2'), columnOf(def, 'factor3')],
    adjustment: columnOf(def, 'adjustment'),
    axis: columnOf(def, 'axis'),
    note: columnOf(def, 'note'),
  };
  // IN-4: 세목마다 미리 깔린 빈 줄은 키 열만 차 있다 — 사용자가 적는 열이 전부 비면 빈 행
  const userColumns = [col.name, col.spec, col.unitPrice, ...col.factors, col.adjustment, col.note];

  const rows: ParsedQuantityRow[] = [];
  const cells = sheet.cells;
  for (let r = def.dataStartRow - 1; r < cells.length; r += 1) {
    if (isBlank(cells, r, userColumns)) continue;
    const issues: ParseIssue[] = [];

    const key = cellText(cellAt(cells, r, col.subcategory));
    const resolved = parseSubcategoryKey(key);
    if (resolved === null) {
      // 버리지 않고 남긴다 — "알 수 없는 세목"으로 미리보기에 보여야 한다(IN-4)
      issues.push(
        blocking(
          'unknown-subcategory',
          key === '' ? '세목 키가 없는 행입니다' : `알 수 없는 세목입니다: ${key}`
        )
      );
    }

    const detailText = cellText(cellAt(cells, r, col.detailId));

    let unitPrice = 0;
    const unitRead = readInteger(cellAt(cells, r, col.unitPrice));
    if (unitRead.kind === 'value') {
      unitPrice = unitRead.value;
      if (unitPrice < 0) issues.push(blocking('unit-price-negative', `단가는 음수일 수 없습니다: ${unitPrice}`));
    } else if (unitRead.kind === 'not-integer') {
      issues.push(blocking('unit-price-not-integer', `단가는 원 단위 정수여야 합니다: ${unitRead.text}`));
    } else if (unitRead.kind === 'invalid') {
      issues.push(blocking('unit-price-invalid', `단가를 숫자로 읽을 수 없습니다: ${unitRead.text}`));
    }

    // 빈 인자 칸은 "인자가 없다"이지 0이 아니다 — 0으로 읽으면 곱이 0이 되어 근거가 사라진다
    const factors: number[] = [];
    col.factors.forEach((column, index) => {
      const read = readDecimal(cellAt(cells, r, column));
      if (read.kind === 'empty') return;
      if (read.kind === 'value') {
        factors.push(read.value);
        return;
      }
      issues.push(blocking('factor-invalid', `인자${index + 1}을(를) 숫자로 읽을 수 없습니다: ${read.text}`));
    });

    const adjustment = readAdjustment(cellAt(cells, r, col.adjustment), issues);
    const axis = readAxis(cellAt(cells, r, col.axis), issues);

    rows.push({
      rowIndex: r + 1,
      // 복합 키에서 세목 코드만 남긴다. 모르는 키는 원문 그대로 두어 메시지에 보이게 한다
      subcategory: resolved?.subcategory ?? key,
      category: resolved?.category ?? null,
      detailId: detailText === '' ? null : detailText,
      name: cellText(cellAt(cells, r, col.name)),
      spec: cellText(cellAt(cells, r, col.spec)),
      unitPrice,
      factors,
      adjustment,
      axis,
      note: cellText(cellAt(cells, r, col.note)),
      issues,
    });
  }
  return rows;
}

// ─── 진입점 ──────────────────────────────────────────────────

function findSheet(sheets: readonly RawSheet[], name: string): RawSheet | undefined {
  return sheets.find((sheet) => sheet.name === name);
}

/**
 * 워크북(어댑터가 만든 RawSheet 목록) → 파싱 결과.
 * 순서: `_meta` → 거부 3종(IN-2) → 시트 존재 → 인건비·사업비.
 * 거부는 파일째 돌려보내는 것이고, 통과한 뒤의 문제는 전부 행별 `issues`로 남긴다 — 버리는 행이 없다.
 */
export function parseInputForm(
  sheets: readonly RawSheet[],
  expected: { projectId: string; formVersion: number }
): ParseInputFormResult {
  const metaSheet = findSheet(sheets, INPUT_FORM_SHEETS.meta.name);
  if (metaSheet === undefined) {
    return { ok: false, rejection: { kind: 'no-meta', message: NO_META_MESSAGE } };
  }
  const meta = parseMeta(metaSheet);
  const rejection = checkMeta(meta, expected);
  if (rejection !== null || meta === null) {
    return {
      ok: false,
      rejection: rejection ?? { kind: 'no-meta', message: NO_META_MESSAGE },
    };
  }

  const personnelSheet = findSheet(sheets, INPUT_FORM_SHEETS.personnel.name);
  const budgetSheet = findSheet(sheets, INPUT_FORM_SHEETS.budget.name);
  const missing = [
    personnelSheet === undefined ? INPUT_FORM_SHEETS.personnel.name : null,
    budgetSheet === undefined ? INPUT_FORM_SHEETS.budget.name : null,
  ].filter((name): name is string => name !== null);
  if (missing.length > 0 || personnelSheet === undefined || budgetSheet === undefined) {
    return {
      ok: false,
      rejection: {
        kind: 'missing-sheet',
        message: `양식에 '${missing.join("', '")}' 시트가 없습니다 — 시트를 지우거나 이름을 바꾸지 마세요`,
      },
    };
  }

  return {
    ok: true,
    parsed: {
      meta,
      personnel: parsePersonnelSheet(personnelSheet, new Set(meta.memberIds)),
      budget: parseBudgetSheet(budgetSheet),
      issues: [],
    },
  };
}
