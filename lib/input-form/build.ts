// 사업비 입력 양식 생성기 (SOT §6.16 IN-1·IN-3·IN-4·IN-7, §7.9.7, 부록 F).
//
// 앱 데이터 → `InputFormWorkbook`(FormCell 격자). 좌표는 전부 `layout.ts`에서 온다 — 여기에 열 번호가
// 하나라도 박히면 파서와 어긋날 수 있다(IN-1). `xlsx`·`exceljs`를 import하지 않는다(IN-8) — 서식은
// FormSheet의 **힌트**(columnHints·rowRoles·kind)로만 실어 보내고 어댑터가 부록 F로 옮긴다.
//
// **금액을 계산하지 않는다.** 인건비·사업비 금액 열은 엑셀 수식이다(IN-7) — 사용자가 엑셀에서 참여율을
// 고치면 그 자리에서 같은 값이 보여야 하고, 올리면 서버가 PL-1로 다시 계산한다(금액 열은 읽지 않는다, IN-3).
// 그래서 `computeDetailAmount`를 부를 이유가 없다. 수식은 연봉 셀을 직접 쓴다 — 월급 셀을 거치면
// 월액 반올림이 끼어 박선욱 행이 1원 어긋난다(PL-2).
//
// 사업비 시트의 소계·총액 행(§7.9.7)도 수식뿐이다. 숨김 키 열과 사용자 열을 전부 비워 두므로 파서는
// IN-4의 빈 행 규칙으로 건너뛴다 — 이 행들을 읽게 만드는 변경은 파서와 함께 해야 한다.
//
// **수행 모드(IN-9~IN-12)는 다르다.** 행은 산출근거가 아니라 집행(`BudgetExecution`)이고, 금액 열은 입력값이라
// 수식이 아니라 **값**이다(IN-11). 반영이 id 기반이라(IN-10) 양식에 실리지 않은 집행은 "양식에서 사라진 id" =
// 삭제 후보가 된다 — 그래서 그 연차의 집행을 **정확히 한 행씩** 싣고, 못 실으면 던진다(IN-4).

import { PARTICIPATION_FACTOR_LABEL, personnelParticipation } from '@/lib/budget-plan';
import {
  BUDGET_CATEGORY_LABELS,
  BUDGET_CATEGORY_ORDER,
  DETAIL_AXIS_LABELS,
  HIRE_TYPE_LABELS,
  SUBCATEGORY_PRESETS,
} from '@/lib/constants';
import { exportFileName } from '@/lib/export/detail-sheet';
import { personnelMonths } from '@/lib/participation';
import { monthlyDisplay, salaryBasisBadge } from '@/lib/salary';
import type { BudgetCategory, BudgetDetail } from '@/types';
import { buildGuideSheet } from './guide';
import {
  EMPTY_ROWS_PER_SUBCATEGORY,
  INPUT_FORM_SHEETS,
  INPUT_FORM_VERSION,
  columnAddress,
  columnOf,
  hiddenColumnIndexes,
  sheetsFor,
} from './layout';
import type { InputFormColumnDef, InputFormSheetDef } from './layout';
import { buildMetaRows } from './meta';
import { subcategoryKeyOf } from './parse';
import type {
  FormCell,
  FormColumnHint,
  FormColumnValidation,
  FormRowRole,
  FormSheet,
  InputFormData,
  InputFormExecution,
  InputFormMeta,
  InputFormMode,
  InputFormWorkbook,
} from './types';

/** IN-7: 연봉이 없으면 수식 대신 이 비고를 적는다. 파서(T3)가 경고로 되돌려 읽는 문구이기도 하다 */
export const NO_SALARY_NOTE = '연봉 미입력';
/** SL-4 배지가 하나도 없을 때(퇴직금·4대보험 둘 다 미포함으로 기록됨) */
export const NO_INCLUSION_LABEL = '포함 없음';
/** IN-3: 기존 행이 없는 인력의 빈 행에 미리 적는 세목 */
export const DEFAULT_PERSONNEL_SUBCATEGORY = 'personnel_internal';
/** 소계·총액 행 라벨 접미·총액 라벨(§7.9.7) */
export const SUBTOTAL_SUFFIX = ' 소계';
export const TOTAL_LABEL = '총액';

/**
 * S-6 `세목 미지정` 슬롯(수행 모드, IN-4). 복합 키는 `비목:` — 세목 부분이 빈 문자열이고 파서는
 * `subcategoryCode = null`로 읽는다. 세목 없는 집행(그 비목에 `default`가 없을 때)과 인력 없는 인건비 집행이 여기 실린다.
 */
export const UNASSIGNED_SUBCATEGORY_CODE = '';
export const UNASSIGNED_SUBCATEGORY_LABEL = '세목 미지정';
/** IN-12: 인건비 집행의 개월은 이 라벨의 인자다(§5.17과 같은 규약). 참여율은 `PARTICIPATION_FACTOR_LABEL` */
export const MONTHS_FACTOR_LABEL = '참여기간(월)';

const PERSONNEL_CATEGORIES: ReadonlySet<BudgetCategory> = new Set(['personnel', 'student_personnel']);
const PERSONNEL_CATEGORY_LIST: readonly BudgetCategory[] = BUDGET_CATEGORY_ORDER.filter((c) =>
  PERSONNEL_CATEGORIES.has(c)
);

/**
 * 세목 없는 인건비 집행을 인건비 시트에 보일 때의 세목(IN-12 "없으면 기본 라벨"). 비목마다 따로 둔다 —
 * 학생인건비 집행에 `내부인건비`를 보이면 다시 올릴 때 비목이 바뀌어 `category-moved`가 된다(IN-10).
 */
const DEFAULT_SUBCATEGORY_BY_PERSONNEL_CATEGORY: Readonly<Partial<Record<BudgetCategory, string>>> = {
  personnel: DEFAULT_PERSONNEL_SUBCATEGORY,
  student_personnel: SUBCATEGORY_PRESETS.student_personnel[0]?.code,
};

// ─── 드롭다운 목록 (부록 F-9 — 인라인 목록, `_lists` 시트 없음) ─────

/** 축 열 `"현금,현물"` */
export const AXIS_OPTIONS: readonly string[] = [DETAIL_AXIS_LABELS.cash, DETAIL_AXIS_LABELS.in_kind];
/** 인건비 시트 `세목` 열 — 부록 A.5 인건비·학생인건비 세목 라벨(파서 IN-3이 받는 목록과 같다) */
export const PERSONNEL_SUBCATEGORY_OPTIONS: readonly string[] = PERSONNEL_CATEGORY_LIST.flatMap((c) =>
  SUBCATEGORY_PRESETS[c].map((d) => d.label)
);

// ─── 서식 힌트 (부록 F-3·F-5·F-6·F-7) ───────────────────────

/**
 * 역할 → 열 너비(F-7). 같은 역할 이름이 시트마다 뜻이 다를 수 있어(인건비 `subcategory`는 보이는 세목 라벨,
 * 사업비 `subcategory`는 숨김 키) 라벨이 아니라 역할로 고르되 숨김 열은 표를 보지 않는다.
 */
const COLUMN_WIDTHS: Readonly<Record<string, number>> = {
  name: 26,
  spec: 40,
  note: 40,
  subcategory: 20,
  subcategoryLabel: 20,
  salaryBasis: 20,
  staff: 20,
  category: 12,
  position: 12,
  annualSalary: 14,
  monthlySalary: 14,
  unitPrice: 14,
  formulaAmount: 14,
  amount: 14,
  adjustment: 14,
  participation: 12,
  months: 12,
  factor1: 12,
  factor2: 12,
  factor3: 12,
  axis: 10,
  // F-7에 날짜 열 값이 없다 — 숫자 열 대표값(12~14) 중 yyyy-mm-dd가 들어가는 12
  executionDate: 12,
};
/** 숨김 열은 너비가 보이지 않는다 — 표를 보지 않고 이 값이다 */
const HIDDEN_COLUMN_WIDTH = 10;

function columnHint(column: InputFormColumnDef): FormColumnHint {
  const format = column.format ?? 'text';
  if (format === 'percent') {
    // F-6·X-7: 백분율 서식 금지. 좌표 맵이 percent를 달면 여기서 막는다
    throw new Error(`열 '${column.label}'의 서식이 percent다 — 입력 양식은 백분율 서식을 쓰지 않는다(F-6)`);
  }
  let width: number;
  if (column.hidden) {
    width = HIDDEN_COLUMN_WIDTH;
  } else {
    const w = COLUMN_WIDTHS[column.role];
    // 표에 없는 역할이 새로 생기면 조용히 기본 너비로 두지 않고 여기서 터뜨린다
    if (w === undefined) throw new Error(`열 역할 '${column.role}'의 너비가 정해지지 않았다(F-7)`);
    width = w;
  }
  const align: FormColumnHint['align'] =
    format === 'int' || format === 'decimal' || format === 'formula'
      ? 'right'
      : column.role === 'axis'
        ? 'center'
        : 'left';
  return { key: !column.hidden && !column.read, format, width, align };
}

function columnHints(def: InputFormSheetDef): FormColumnHint[] {
  return def.columns.map(columnHint);
}

// ─── 셀 헬퍼 ────────────────────────────────────────────────

/** 역할 → 셀 쓰기. 열 번호는 맵이 정한다 */
function makeRow(sheet: InputFormSheetDef): {
  cells: FormCell[];
  set: (role: string, cell: FormCell) => void;
} {
  const cells: FormCell[] = sheet.columns.map(() => ({}));
  return {
    cells,
    set: (role, cell) => {
      cells[columnOf(sheet, role)] = cell;
    },
  };
}

/** 헤더 행(과 그 앞뒤 빈 줄). 행 역할은 전부 'header' — 틀 고정 위쪽이다 */
function headerRows(sheet: InputFormSheetDef): { rows: FormCell[][]; roles: FormRowRole[] } {
  const rows: FormCell[][] = [];
  for (let r = 1; r < sheet.headerRow; r += 1) rows.push([]);
  rows.push(sheet.columns.map((column) => ({ value: column.label })));
  for (let r = sheet.headerRow + 1; r < sheet.dataStartRow; r += 1) rows.push([]);
  return { rows, roles: rows.map(() => 'header') };
}

function byOrder<T extends { order: number }>(a: T, b: T): number {
  return a.order - b.order;
}

/** 부록 A.5 세목 코드 → 라벨. 프리셋에 없는 코드는 코드 그대로 보여 준다 — 조용히 빈 칸으로 두지 않는다 */
function subcategoryLabel(category: BudgetCategory, code: string): string {
  const def = SUBCATEGORY_PRESETS[category].find((d) => d.code === code);
  return def ? def.label : code;
}

function dataSheet(
  def: InputFormSheetDef,
  rows: FormCell[][],
  roles: FormRowRole[],
  validations: FormColumnValidation[]
): FormSheet {
  if (rows.length !== roles.length) {
    throw new Error(`'${def.name}' 시트의 행 수(${rows.length})와 행 역할 수(${roles.length})가 다르다`);
  }
  return {
    name: def.name,
    hidden: def.hidden,
    rows,
    hiddenColumns: hiddenColumnIndexes(def),
    kind: 'data',
    headerRow: def.headerRow,
    dataStartRow: def.dataStartRow,
    columnHints: columnHints(def),
    rowRoles: roles,
    validations,
  };
}

/** 인건비 시트: 세목·축(F-9, S-3). 사업비 세목 라벨은 `read: false`라 걸지 않는다 */
function personnelValidations(def: InputFormSheetDef): FormColumnValidation[] {
  return [
    { column: columnOf(def, 'subcategory'), values: [...PERSONNEL_SUBCATEGORY_OPTIONS] },
    { column: columnOf(def, 'axis'), values: [...AXIS_OPTIONS] },
  ];
}

function budgetValidations(def: InputFormSheetDef): FormColumnValidation[] {
  return [{ column: columnOf(def, 'axis'), values: [...AXIS_OPTIONS] }];
}

/** 집행은 정렬 순서 필드가 없다 — 날짜, 같으면 id로 늘 같은 순서를 만든다(같은 입력 → 같은 양식) */
function byExecutionOrder(a: InputFormExecution, b: InputFormExecution): number {
  if (a.date !== b.date) return a.date < b.date ? -1 : 1;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/** 인력 셀(숨김 memberId + 표시 전용 열). 두 모드가 같다 */
function setMemberCells(
  set: (role: string, cell: FormCell) => void,
  member: InputFormData['members'][number]
): void {
  set('memberId', { value: member.id });
  set('name', {
    value: member.hireType === 'new' ? `${member.name} (${HIRE_TYPE_LABELS.new})` : member.name,
  });
  set('position', { value: member.position });
  set('staff', { value: member.staffName ?? '' });
  const badge = salaryBasisBadge(member).labels;
  set('salaryBasis', { value: badge.length > 0 ? badge.join(' · ') : NO_INCLUSION_LABEL });
  set('annualSalary', { value: member.annualSalary });
  set('monthlySalary', {
    value: member.annualSalary === null ? null : monthlyDisplay(member.annualSalary),
  });
}

// ─── 인건비 시트 (IN-3, IN-7) ────────────────────────────────

function buildPersonnelSheet(data: InputFormData): { sheet: FormSheet; memberIds: string[] } {
  const def = INPUT_FORM_SHEETS.personnel;
  const { rows, roles } = headerRows(def);
  const members = [...data.members].sort(byOrder);
  const memberIdSet = new Set(members.map((m) => m.id));

  // 인력 목록에 없는 memberId를 가진 인건비 행은 양식에서 사라진다 — 조용히 빠뜨리지 않고 던진다
  const orphan = data.details.find(
    (d) => d.formula === 'personnel' && d.memberId !== null && !memberIdSet.has(d.memberId)
  );
  if (orphan) {
    throw new Error(`인건비 산출근거 ${orphan.id}의 인력(${orphan.memberId})이 인력 목록에 없다`);
  }

  for (const member of members) {
    const details = data.details
      .filter((d) => d.formula === 'personnel' && d.memberId === member.id)
      .sort(byOrder);
    const slots: (BudgetDetail | null)[] = details.length > 0 ? details : [null];

    for (const detail of slots) {
      const rowNumber = rows.length + 1; // 1-based — 수식이 같은 행을 가리킬 때 쓴다
      const { cells, set } = makeRow(def);

      setMemberCells(set, member);
      set('detailId', { value: detail ? detail.id : null });
      set('subcategory', {
        value: detail
          ? subcategoryLabel(detail.category, detail.subcategory)
          : subcategoryLabel('personnel', DEFAULT_PERSONNEL_SUBCATEGORY),
      });
      set('participation', { value: detail ? personnelParticipation(detail) : null });
      set('months', { value: detail ? personnelMonths(detail) : null });
      set('axis', { value: detail ? DETAIL_AXIS_LABELS[detail.axis] : null });
      set('adjustment', { value: detail ? detail.adjustment : null });

      const note = detail ? detail.note : '';
      if (member.annualSalary === null) {
        // IN-7: 수식 대신 빈 칸. 기존 비고는 지우지 않고 앞에 붙인다
        set('note', { value: note === '' ? NO_SALARY_NOTE : `${NO_SALARY_NOTE} · ${note}` });
      } else {
        const salary = columnAddress(def, 'annualSalary', rowNumber);
        const participation = columnAddress(def, 'participation', rowNumber);
        const months = columnAddress(def, 'months', rowNumber);
        const adjustment = columnAddress(def, 'adjustment', rowNumber);
        const formulaAmount = columnAddress(def, 'formulaAmount', rowNumber);
        // PL-1·PL-2 그대로: 연봉 × 참여율/100 × 개월/12를 한 번에 반올림. 월급 셀 참조 금지
        set('formulaAmount', { formula: `ROUND(${salary}*${participation}/100*${months}/12,0)` });
        set('amount', { formula: `${formulaAmount}+${adjustment}` });
        set('note', { value: note });
      }

      rows.push(cells);
      roles.push('data');
    }
  }

  return {
    sheet: dataSheet(def, rows, roles, personnelValidations(def)),
    memberIds: members.map((m) => m.id),
  };
}

/** IN-12: 참여율·개월은 라벨로 찾는다. 없으면 빈 칸 — 제안 모드처럼 100%·12개월로 채우면 없던 값이 생긴다 */
function factorByLabel(factors: InputFormExecution['factors'], label: string): number | null {
  const factor = (factors ?? []).find((f) => f.label === label);
  return factor ? factor.value : null;
}

function executionPersonnelLabel(execution: InputFormExecution): string {
  const code = execution.subcategoryCode ?? DEFAULT_SUBCATEGORY_BY_PERSONNEL_CATEGORY[execution.category];
  if (code === undefined) {
    throw new Error(`집행 ${execution.id}의 비목(${execution.category})은 인건비 시트에 실을 수 없다`);
  }
  return subcategoryLabel(execution.category, code);
}

/**
 * 수행 모드 인건비 시트(IN-12): 행 = 인력 × 그 인력의 인건비·학생인건비 집행. 없으면 빈 1행.
 * 금액은 입력값(IN-11)이라 수식이 없고, 조정액·산식 금액은 비운다(IN-9).
 */
function buildExecutionPersonnelSheet(
  data: InputFormData,
  executions: readonly InputFormExecution[]
): { sheet: FormSheet; memberIds: string[]; executionIds: string[] } {
  const def = sheetsFor('execution').personnel;
  const { rows, roles } = headerRows(def);
  const members = [...data.members].sort(byOrder);
  const memberIdSet = new Set(members.map((m) => m.id));
  const executionIds: string[] = [];

  // 인력 목록 밖 memberId의 인건비 집행은 실을 행이 없다 — 삭제 후보로 새지 않게 던진다(IN-4)
  const orphan = executions.find(
    (e) => PERSONNEL_CATEGORIES.has(e.category) && e.memberId !== null && !memberIdSet.has(e.memberId)
  );
  if (orphan) {
    throw new Error(`인건비 집행 ${orphan.id}의 인력(${orphan.memberId})이 인력 목록에 없다`);
  }

  for (const member of members) {
    const own = executions
      .filter((e) => PERSONNEL_CATEGORIES.has(e.category) && e.memberId === member.id)
      .sort(byExecutionOrder);
    const slots: (InputFormExecution | null)[] = own.length > 0 ? own : [null];

    for (const execution of slots) {
      const { cells, set } = makeRow(def);
      setMemberCells(set, member);
      set('detailId', { value: execution ? execution.detailId : null });
      set('executionId', { value: execution ? execution.id : null });
      set('executionDate', { value: execution ? execution.date : null });
      set('subcategory', {
        value: execution
          ? executionPersonnelLabel(execution)
          : subcategoryLabel('personnel', DEFAULT_PERSONNEL_SUBCATEGORY),
      });
      set('participation', {
        value: execution ? factorByLabel(execution.factors, PARTICIPATION_FACTOR_LABEL) : null,
      });
      set('months', { value: execution ? factorByLabel(execution.factors, MONTHS_FACTOR_LABEL) : null });
      set('axis', { value: execution?.axis ? DETAIL_AXIS_LABELS[execution.axis] : null });
      set('amount', { value: execution ? execution.amount : null });
      set('note', { value: execution ? execution.note : '' });

      if (execution) executionIds.push(execution.id);
      rows.push(cells);
      roles.push('data');
    }
  }

  return {
    sheet: dataSheet(def, rows, roles, personnelValidations(def)),
    memberIds: members.map((m) => m.id),
    executionIds,
  };
}

// ─── 사업비 시트 (IN-4) ──────────────────────────────────────

interface BudgetSlot {
  category: BudgetCategory;
  code: string;
  /** IN-4 복합 키 `비목:세목` — 숨김 열과 `_meta.subcategoryCodes`에 쓰는 값. 세목 코드 `default`가 여섯 비목에 공유된다 */
  key: string;
  label: string;
}

function makeSlot(category: BudgetCategory, code: string, label: string): BudgetSlot {
  return { category, code, key: subcategoryKeyOf(category, code), label };
}

/** 시트에 깔 (비목, 세목 코드, 라벨) 순서 — 부록 A.5 전 세목 + 프리셋에 없는 코드는 그 비목 끝에 */
function budgetSubcategorySlots(details: readonly BudgetDetail[]): BudgetSlot[] {
  const slots: BudgetSlot[] = [];
  for (const category of BUDGET_CATEGORY_ORDER) {
    if (PERSONNEL_CATEGORIES.has(category)) continue;
    const presetCodes = new Set<string>();
    for (const def of SUBCATEGORY_PRESETS[category]) {
      presetCodes.add(def.code);
      slots.push(makeSlot(category, def.code, def.label));
    }
    // 프리셋 밖 코드를 가진 기존 행도 양식에 실어야 사용자가 그 행의 존재를 안다
    const extras = new Set<string>();
    for (const d of details) {
      if (d.category === category && !presetCodes.has(d.subcategory)) extras.add(d.subcategory);
    }
    for (const code of [...extras].sort()) slots.push(makeSlot(category, code, code));
  }
  return slots;
}

/**
 * 수행 모드 슬롯(IN-4·S-6): 제안 모드 슬롯 + 비목마다 끝에 `세목 미지정`. 인건비·학생인건비 비목은
 * 세목 슬롯 없이 `세목 미지정`만 둔다 — 인력 있는 인건비 집행은 인건비 시트에 실리기 때문이다(IN-12).
 */
function executionSubcategorySlots(executions: readonly InputFormExecution[]): BudgetSlot[] {
  const slots: BudgetSlot[] = [];
  for (const category of BUDGET_CATEGORY_ORDER) {
    if (!PERSONNEL_CATEGORIES.has(category)) {
      const presetCodes = new Set<string>();
      for (const def of SUBCATEGORY_PRESETS[category]) {
        presetCodes.add(def.code);
        slots.push(makeSlot(category, def.code, def.label));
      }
      const extras = new Set<string>();
      for (const e of executions) {
        if (e.category === category && e.subcategoryCode !== null && !presetCodes.has(e.subcategoryCode)) {
          extras.add(e.subcategoryCode);
        }
      }
      for (const code of [...extras].sort()) slots.push(makeSlot(category, code, code));
    }
    slots.push(makeSlot(category, UNASSIGNED_SUBCATEGORY_CODE, UNASSIGNED_SUBCATEGORY_LABEL));
  }
  return slots;
}

/**
 * 사업비 시트에 실릴 집행의 슬롯 키(IN-4·IN-12). 인건비 시트에 실릴 집행(인력 있는 인건비)은 부르지 않는다.
 * - 인력 없는 인건비·학생인건비 → `세목 미지정`(세목이 있어도 — 사업비 시트에 인건비 세목 슬롯이 없다)
 * - 세목 없음 → 그 비목에 `default` 세목이 있으면 `default`, 없으면 `세목 미지정`
 */
function executionSlotKey(execution: InputFormExecution): string {
  const { category, subcategoryCode } = execution;
  if (PERSONNEL_CATEGORIES.has(category)) return subcategoryKeyOf(category, UNASSIGNED_SUBCATEGORY_CODE);
  if (subcategoryCode !== null) return subcategoryKeyOf(category, subcategoryCode);
  const hasDefault = SUBCATEGORY_PRESETS[category].some((d) => d.code === 'default');
  return subcategoryKeyOf(category, hasDefault ? 'default' : UNASSIGNED_SUBCATEGORY_CODE);
}

/** 인건비 시트에 실리는 집행인가(IN-12) */
function isPersonnelSheetExecution(execution: InputFormExecution): boolean {
  return PERSONNEL_CATEGORIES.has(execution.category) && execution.memberId !== null;
}

type SetCell = (role: string, cell: FormCell) => void;

/**
 * 사업비 시트 골격 — 두 모드 공통: 슬롯마다 기존 행 + 빈 줄 3개 + 세목 소계, 비목 소계, 총액(§7.9.7).
 * 행 내용만 모드별 `fillRow`가 채운다. 슬롯 키·비목·세목 라벨 칸은 여기서 쓴다.
 */
function buildBudgetSheetWith<T>(
  def: InputFormSheetDef,
  slots: readonly BudgetSlot[],
  entriesOf: (slot: BudgetSlot) => T[],
  fillRow: (set: SetCell, entry: T | null, rowNumber: number) => void
): { sheet: FormSheet; subcategoryCodes: string[]; placed: T[] } {
  const { rows, roles } = headerRows(def);
  const amountAt = (rowNumber: number) => columnAddress(def, 'amount', rowNumber);
  const placed: T[] = [];

  const pushRow = (slot: BudgetSlot, entry: T | null) => {
    const rowNumber = rows.length + 1;
    const { cells, set } = makeRow(def);
    set('subcategory', { value: slot.key });
    set('category', { value: BUDGET_CATEGORY_LABELS[slot.category] });
    set('subcategoryLabel', { value: slot.label });
    fillRow(set, entry, rowNumber);
    if (entry !== null) placed.push(entry);
    rows.push(cells);
    roles.push('data');
  };

  /**
   * 소계·총액 행. 라벨 셀과 금액 수식만 쓰고 나머지는 전부 빈 칸이다 — 숨김 키·품명·단가·인자·조정액·비고가
   * 비어 있어야 파서가 IN-4 빈 행으로 건너뛴다. 그 행의 금액 셀 주소를 돌려줘 상위 합계가 참조한다.
   */
  const pushSumRow = (role: 'subtotal' | 'total', labelRole: string, label: string, formula: string): string => {
    const rowNumber = rows.length + 1;
    const { cells, set } = makeRow(def);
    set(labelRole, { value: label });
    set('amount', { formula });
    rows.push(cells);
    roles.push(role);
    return amountAt(rowNumber);
  };

  const categorySubtotalCells: string[] = [];
  let currentCategory: BudgetCategory | null = null;
  let subcategorySubtotalCells: string[] = [];

  const closeCategory = () => {
    if (currentCategory === null) return;
    categorySubtotalCells.push(
      pushSumRow(
        'subtotal',
        'category',
        `${BUDGET_CATEGORY_LABELS[currentCategory]}${SUBTOTAL_SUFFIX}`,
        `SUM(${subcategorySubtotalCells.join(',')})`
      )
    );
    subcategorySubtotalCells = [];
  };

  for (const slot of slots) {
    if (slot.category !== currentCategory) {
      closeCategory();
      currentCategory = slot.category;
    }
    const firstRow = rows.length + 1;
    for (const entry of entriesOf(slot)) pushRow(slot, entry);
    for (let i = 0; i < EMPTY_ROWS_PER_SUBCATEGORY; i += 1) pushRow(slot, null);
    const lastRow = rows.length;
    subcategorySubtotalCells.push(
      pushSumRow(
        'subtotal',
        'subcategoryLabel',
        `${slot.label}${SUBTOTAL_SUFFIX}`,
        `SUM(${amountAt(firstRow)}:${amountAt(lastRow)})`
      )
    );
  }
  closeCategory();
  pushSumRow('total', 'category', TOTAL_LABEL, `SUM(${categorySubtotalCells.join(',')})`);

  return {
    sheet: dataSheet(def, rows, roles, budgetValidations(def)),
    subcategoryCodes: slots.map((s) => s.key),
    placed,
  };
}

const FACTOR_ROLES = ['factor1', 'factor2', 'factor3'] as const;

/**
 * IN-4: 인자는 프리셋 defaultFactors 자리(인자1~3)에 순서대로. 라벨은 버리고 값만 —
 * isPercent 인자는 /100해 두면 곱셈에서 같은 금액이 나온다(금액만 보존)
 */
function setFactorCells(set: SetCell, factors: readonly { value: number; isPercent: boolean }[] | null): void {
  FACTOR_ROLES.forEach((role, index) => {
    const factor = factors ? factors[index] : undefined;
    set(role, { value: factor ? (factor.isPercent ? factor.value / 100 : factor.value) : null });
  });
}

function buildBudgetSheet(data: InputFormData): { sheet: FormSheet; subcategoryCodes: string[] } {
  const def = INPUT_FORM_SHEETS.budget;
  const { sheet, subcategoryCodes } = buildBudgetSheetWith<BudgetDetail>(
    def,
    budgetSubcategorySlots(data.details),
    (slot) =>
      data.details.filter((d) => d.category === slot.category && d.subcategory === slot.code).sort(byOrder),
    (set, detail, rowNumber) => {
      set('detailId', { value: detail ? detail.id : null });
      set('name', { value: detail ? detail.name : null });
      set('spec', { value: detail ? detail.spec : null });
      set('unitPrice', { value: detail ? detail.unitPrice : null });
      setFactorCells(set, detail ? detail.factors : null);
      set('adjustment', { value: detail ? detail.adjustment : null });
      set('axis', { value: detail ? DETAIL_AXIS_LABELS[detail.axis] : null });

      const unitPrice = columnAddress(def, 'unitPrice', rowNumber);
      const adjustment = columnAddress(def, 'adjustment', rowNumber);
      const product = FACTOR_ROLES.map((role) => columnAddress(def, role, rowNumber))
        .map((addr) => `IF(${addr}="",1,${addr})`)
        .join('*');
      // PL-3·PL-4: 빈 인자는 1(곱셈 항등원). 조정액을 더한 뒤 한 번만 반올림
      set('amount', { formula: `ROUND(${unitPrice}*${product}+${adjustment},0)` });
      set('note', { value: detail ? detail.note : null });
    }
  );
  return { sheet, subcategoryCodes };
}

/**
 * 수행 모드 사업비 시트(IN-4·IN-9·IN-11). 금액은 집행액 **값**이고 조정액은 비운다(IN-9).
 * 인자가 3개를 넘는 집행은 넷째부터 칸이 없다 — 조용히 잘라 다시 올리면 인자가 사라지므로 던진다.
 */
function buildExecutionBudgetSheet(executions: readonly InputFormExecution[]): {
  sheet: FormSheet;
  subcategoryCodes: string[];
  executionIds: string[];
} {
  const def = sheetsFor('execution').budget;
  const bySlot = new Map<string, InputFormExecution[]>();
  for (const e of executions) {
    if ((e.factors?.length ?? 0) > FACTOR_ROLES.length) {
      throw new Error(`집행 ${e.id}의 인자가 ${e.factors?.length}개다 — 양식은 ${FACTOR_ROLES.length}개까지 싣는다`);
    }
    const key = executionSlotKey(e);
    const list = bySlot.get(key);
    if (list) list.push(e);
    else bySlot.set(key, [e]);
  }

  const { sheet, subcategoryCodes, placed } = buildBudgetSheetWith<InputFormExecution>(
    def,
    executionSubcategorySlots(executions),
    (slot) => [...(bySlot.get(slot.key) ?? [])].sort(byExecutionOrder),
    (set, execution) => {
      set('detailId', { value: execution ? execution.detailId : null });
      set('executionId', { value: execution ? execution.id : null });
      set('executionDate', { value: execution ? execution.date : null });
      set('name', { value: execution ? execution.description : null });
      set('spec', { value: execution ? execution.spec : null });
      set('unitPrice', { value: execution ? execution.unitPrice : null });
      setFactorCells(set, execution ? execution.factors : null);
      set('axis', { value: execution?.axis ? DETAIL_AXIS_LABELS[execution.axis] : null });
      set('amount', { value: execution ? execution.amount : null });
      set('note', { value: execution ? execution.note : null });
    }
  );
  return { sheet, subcategoryCodes, executionIds: placed.map((e) => e.id) };
}

// ─── 워크북 ─────────────────────────────────────────────────

/**
 * X-12와 같은 파일명 규칙(금지 문자 치환·날짜 형식 검사)을 재사용하고 접두만 붙인다.
 * 수행 양식은 `입력양식_수행_`이다 — 두 양식이 한 폴더에 쌓여도 파일명만 보고 어느 모드에서 올릴지 알 수 있어야 한다
 * (올린 파일의 mode가 화면과 다르면 거부된다, IN-9). 제안 양식은 Phase 19와 같은 이름이다.
 */
export function inputFormFileName(
  project: InputFormData['project'],
  year: InputFormData['year'],
  todayISO: string,
  mode: InputFormMode = 'plan'
): string {
  const prefix = mode === 'execution' ? '입력양식_수행_' : '입력양식_';
  return `${prefix}${exportFileName(project, year, todayISO)}`;
}

/**
 * IN-4: 그 연차의 집행이 두 시트에 **정확히 한 번씩** 실렸는가. 빠진 집행은 다시 올릴 때 삭제 후보가 되고,
 * 두 번 실린 집행은 한 id에 변경이 둘이 된다 — 어느 쪽도 양식을 내보내면 안 된다.
 */
function assertEveryExecutionPlaced(
  executions: readonly InputFormExecution[],
  placedIds: readonly string[]
): void {
  const counts = new Map<string, number>();
  for (const id of placedIds) counts.set(id, (counts.get(id) ?? 0) + 1);
  const missing = executions.filter((e) => !counts.has(e.id)).map((e) => e.id);
  const duplicated = [...counts].filter(([, n]) => n > 1).map(([id]) => id);
  if (missing.length > 0 || duplicated.length > 0 || placedIds.length !== executions.length) {
    throw new Error(
      `수행 양식에 집행을 정확히 한 번씩 싣지 못했다 — 빠짐 [${missing.join(', ')}] · 중복 [${duplicated.join(', ')}]`
    );
  }
}

/** 수행 모드 인건비·사업비 시트와 `_meta` 수행 필드(IN-2: mode·execution:<id>=version·detail:<id>) */
function buildExecutionSheets(
  data: InputFormData,
  todayISO: string
): {
  personnel: FormSheet;
  budget: FormSheet;
  meta: InputFormMeta;
} {
  // 빈 배열로 메우지 않는다 — 집행을 빠뜨린 호출이 "집행 0건 양식"으로 조용히 나가면
  // 사용자가 그 양식을 올릴 때 _meta에 없는 집행이 삭제 후보가 된다(절대 규칙 5)
  const executions = data.executions;
  if (executions === undefined) {
    throw new Error('수행 양식에는 그 연차의 집행 목록(executions)이 필요하다 — 없으면 빈 배열을 명시해 넘긴다');
  }
  const detailIdSet = new Set(data.details.map((d) => d.id));
  // 양식에 실린 detailId가 _meta 목록 밖이면 손대지 않은 행이 다시 올릴 때 오류 행이 된다(IN-13)
  const strayDetail = executions.find((e) => e.detailId !== null && !detailIdSet.has(e.detailId));
  if (strayDetail) {
    throw new Error(`집행 ${strayDetail.id}의 산출근거(${strayDetail.detailId})가 이 연차의 산출근거 목록에 없다`);
  }

  const personnel = buildExecutionPersonnelSheet(data, executions);
  const budget = buildExecutionBudgetSheet(executions.filter((e) => !isPersonnelSheetExecution(e)));
  const placedIds = [...personnel.executionIds, ...budget.executionIds];
  assertEveryExecutionPlaced(executions, placedIds);

  const versionById = new Map(executions.map((e) => [e.id, e.version]));
  const executionVersions: Record<string, number> = {};
  for (const id of placedIds) executionVersions[id] = versionById.get(id) as number;

  return {
    personnel: personnel.sheet,
    budget: budget.sheet,
    meta: {
      formVersion: INPUT_FORM_VERSION,
      projectId: data.project.id,
      yearId: data.year.id,
      generatedAt: todayISO,
      subcategoryCodes: budget.subcategoryCodes,
      memberIds: personnel.memberIds,
      mode: 'execution',
      executions: executionVersions,
      detailIds: data.details.map((d) => d.id),
    },
  };
}

/**
 * 양식 한 장. 시트 순서 `[작성안내, 인건비, 사업비, _meta]`(F-8 — 안내가 첫 시트). 두 모드가 같은 시트 목록이다(F-9).
 * `todayISO`는 `_meta.generatedAt`·파일명·안내 부제에 쓴다 — 시각을 여기서 읽지 않아야
 * 같은 입력이면 같은 출력이다(테스트 가능). `mode = 'execution'`이면 행이 `data.executions`다(IN-9~IN-12).
 */
export function buildInputForm(
  data: InputFormData,
  todayISO: string,
  mode: InputFormMode = 'plan'
): InputFormWorkbook {
  const guide = buildGuideSheet(data, todayISO, mode);
  const metaDef = sheetsFor(mode).meta;

  let personnelSheet: FormSheet;
  let budgetSheet: FormSheet;
  let metaValue: InputFormMeta;
  if (mode === 'execution') {
    const built = buildExecutionSheets(data, todayISO);
    personnelSheet = built.personnel;
    budgetSheet = built.budget;
    metaValue = built.meta;
  } else {
    const personnel = buildPersonnelSheet(data);
    const budget = buildBudgetSheet(data);
    personnelSheet = personnel.sheet;
    budgetSheet = budget.sheet;
    metaValue = {
      formVersion: INPUT_FORM_VERSION,
      projectId: data.project.id,
      yearId: data.year.id,
      generatedAt: todayISO,
      subcategoryCodes: budget.subcategoryCodes,
      memberIds: personnel.memberIds,
    };
  }

  const meta: FormSheet = {
    name: metaDef.name,
    hidden: metaDef.hidden,
    rows: buildMetaRows(metaValue),
    hiddenColumns: hiddenColumnIndexes(metaDef),
  };

  return {
    sheets: [guide, personnelSheet, budgetSheet, meta],
    fileName: inputFormFileName(data.project, data.year, todayISO, mode),
  };
}
