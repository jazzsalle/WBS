// 사업비 입력 양식의 좌표 맵 (SOT §6.16 IN-1, §6.12.1 X-3와 같은 원칙).
//
// **맵은 코드가 아니라 데이터다.** 시트 이름·헤더 행·열 순서·시작 행을 여기 한 곳에 두고
// 생성기(`build.ts`)와 파서(`parse.ts`)가 같은 맵을 읽는다 — 둘이 어긋날 수 없다.
// 우리가 만든 양식이므로 부처 서식처럼 헤더를 추측하지 않고 고정 좌표로 읽는다(§7.9.7).
//
// SheetJS를 import하지 않는다 (IN-8). A1 좌표 헬퍼는 `lib/export/layouts.ts`를 재사용한다.

import { columnLetter, encodeAddr } from '@/lib/export/layouts';

/** 양식 구조가 바뀌면 올린다. 올린 파일의 `_meta.formVersion`과 다르면 거부한다(IN-2) */
export const INPUT_FORM_VERSION = 1;

/** 사업비 시트에서 세목마다 미리 깔아 두는 빈 줄 수 (§7.9.7) */
export const EMPTY_ROWS_PER_SUBCATEGORY = 3;

/**
 * 셀 서식 힌트. 어댑터가 숫자 서식을 고를 때 쓴다.
 * 참여율은 `percent`가 아니라 `decimal`이다 — 백분율 서식 셀은 `10`을 `1000%`로 보이게 하고(X-7),
 * 읽을 때는 D-22의 ×100 되돌리기가 필요해진다. 일반 숫자로 두면 양방향 모두 함정이 없다.
 */
export type FormCellFormat = 'int' | 'decimal' | 'percent' | 'text' | 'formula' | 'date';

/**
 * 양식 모드(IN-9). 좌표 맵은 하나이고 수행 모드 열은 제안 맵에서 파생한다 — 맵을 둘로 두면
 * 두 모드의 같은 열이 서로 다른 자리로 흘러갈 수 있다(IN-1).
 */
export type InputFormMode = 'plan' | 'execution';

export interface InputFormColumnDef {
  role: string;
  /** 헤더 행에 찍히는 라벨 */
  label: string;
  /** 사람이 볼 필요 없는 키 열(memberId·detailId·세목 코드). 숨김 열은 전부 파서가 읽는 키다 */
  hidden: boolean;
  /**
   * 파서가 읽는 열인가. false면 표시·계산 전용이다 — 연봉·월급·금액은 서버가 다시 계산하므로
   * 사용자가 값을 바꿔 올려도 무시된다(IN-3, PL-D7). 성명·직위처럼 이름 매칭에 쓰일 수 있는
   * 열도 false다(IN-3: 이름 매칭 없음).
   */
  read: boolean;
  format?: FormCellFormat;
}

export interface InputFormSheetDef {
  name: string;
  hidden: boolean;
  /** 1-based */
  headerRow: number;
  /** 1-based */
  dataStartRow: number;
  columns: readonly InputFormColumnDef[];
}

export type InputFormSheetKey = 'personnel' | 'budget' | 'meta';

export type PersonnelColumnRole =
  | 'memberId'
  | 'detailId'
  | 'executionId'
  | 'name'
  | 'position'
  | 'staff'
  | 'salaryBasis'
  | 'annualSalary'
  | 'monthlySalary'
  | 'executionDate'
  | 'subcategory'
  | 'participation'
  | 'months'
  | 'axis'
  | 'adjustment'
  | 'formulaAmount'
  | 'amount'
  | 'note';

export type BudgetColumnRole =
  | 'subcategory'
  | 'detailId'
  | 'executionId'
  | 'category'
  | 'subcategoryLabel'
  | 'executionDate'
  | 'name'
  | 'spec'
  | 'unitPrice'
  | 'factor1'
  | 'factor2'
  | 'factor3'
  | 'adjustment'
  | 'axis'
  | 'amount'
  | 'note';

export type MetaColumnRole = 'key' | 'value';

/**
 * `_meta` 시트의 고정 키. 목록 항목은 `subcategory:<code>`·`member:<memberId>` 접두 행으로 잇는다.
 * `mode`는 수행 양식에만 적는다 — 없으면 제안 양식이다(IN-2). 제안 양식에 적으면 Phase 19 파일과 바이트가 달라진다.
 */
export const META_KEYS = {
  formVersion: 'formVersion',
  projectId: 'projectId',
  yearId: 'yearId',
  generatedAt: 'generatedAt',
  mode: 'mode',
} as const;

export const META_SUBCATEGORY_PREFIX = 'subcategory:';
export const META_MEMBER_PREFIX = 'member:';
/** 수행 양식 전용. 값은 내려받을 때의 `version` — 충돌·삭제 판정 기준(IN-10) */
export const META_EXECUTION_PREFIX = 'execution:';
/** 수행 양식 전용. 그 연차의 산출근거 id — 경계 목록(IN-13) */
export const META_DETAIL_PREFIX = 'detail:';

type ColumnDefOf<R extends string> = Omit<InputFormColumnDef, 'role'> & { role: R };

const PERSONNEL_COLUMNS: readonly ColumnDefOf<PersonnelColumnRole>[] = [
  { role: 'memberId', label: 'memberId', hidden: true, read: true, format: 'text' },
  { role: 'detailId', label: 'detailId', hidden: true, read: true, format: 'text' },
  { role: 'name', label: '성명', hidden: false, read: false, format: 'text' },
  { role: 'position', label: '직위', hidden: false, read: false, format: 'text' },
  { role: 'staff', label: '조직원', hidden: false, read: false, format: 'text' },
  { role: 'salaryBasis', label: '급여 기준', hidden: false, read: false, format: 'text' },
  // 연봉·월급은 명부가 원본이다(D-8a). 양식에서 고쳐도 반영하지 않는다
  { role: 'annualSalary', label: '연봉', hidden: false, read: false, format: 'int' },
  { role: 'monthlySalary', label: '월급', hidden: false, read: false, format: 'int' },
  { role: 'subcategory', label: '세목', hidden: false, read: true, format: 'text' },
  { role: 'participation', label: '참여율(%)', hidden: false, read: true, format: 'decimal' },
  { role: 'months', label: '참여개월', hidden: false, read: true, format: 'decimal' },
  { role: 'axis', label: '현금/현물', hidden: false, read: true, format: 'text' },
  { role: 'adjustment', label: '조정액', hidden: false, read: true, format: 'int' },
  // IN-7: ROUND(연봉×참여율/100×개월/12,0) — 월급을 거치지 않는다(PL-2). 금액 = 산식 금액 + 조정액
  { role: 'formulaAmount', label: '산식 금액', hidden: false, read: false, format: 'formula' },
  { role: 'amount', label: '금액', hidden: false, read: false, format: 'formula' },
  { role: 'note', label: '비고', hidden: false, read: true, format: 'text' },
];

const BUDGET_COLUMNS: readonly ColumnDefOf<BudgetColumnRole>[] = [
  { role: 'subcategory', label: 'subcategory', hidden: true, read: true, format: 'text' },
  { role: 'detailId', label: 'detailId', hidden: true, read: true, format: 'text' },
  // 비목·세목 라벨은 표시 전용 — 행은 숨김 세목 코드로 잇는다(IN-4)
  { role: 'category', label: '비목', hidden: false, read: false, format: 'text' },
  { role: 'subcategoryLabel', label: '세목', hidden: false, read: false, format: 'text' },
  { role: 'name', label: '품명', hidden: false, read: true, format: 'text' },
  { role: 'spec', label: '규격', hidden: false, read: true, format: 'text' },
  { role: 'unitPrice', label: '단가', hidden: false, read: true, format: 'int' },
  { role: 'factor1', label: '인자1', hidden: false, read: true, format: 'decimal' },
  { role: 'factor2', label: '인자2', hidden: false, read: true, format: 'decimal' },
  { role: 'factor3', label: '인자3', hidden: false, read: true, format: 'decimal' },
  { role: 'adjustment', label: '조정액', hidden: false, read: true, format: 'int' },
  { role: 'axis', label: '현금/현물', hidden: false, read: true, format: 'text' },
  { role: 'amount', label: '금액', hidden: false, read: false, format: 'formula' },
  { role: 'note', label: '비고', hidden: false, read: true, format: 'text' },
];

const META_COLUMNS: readonly ColumnDefOf<MetaColumnRole>[] = [
  { role: 'key', label: '키', hidden: false, read: true, format: 'text' },
  { role: 'value', label: '값', hidden: false, read: true, format: 'text' },
];

// ─── 수행 모드 파생 (IN-9) ───────────────────────────────────

// 행을 기존 집행(`BudgetExecution.id`)과 잇는 키. 비면 새 행이다(IN-10)
const EXECUTION_ID_COLUMN = { label: 'executionId', hidden: true, read: true, format: 'text' } as const;
const EXECUTION_DATE_COLUMN = { label: '집행일', hidden: false, read: true, format: 'date' } as const;

/**
 * 제안 맵 → 수행 맵. 열을 **더하고 플래그만 바꾼다** — 제안 양식의 보이는 열 순서가 그대로 남아야
 * "같은 시트·열 + 집행일"이 된다(IN-9).
 * - `executionId`는 숨김 키 열 묶음 끝에, `집행일`은 사용자가 적는 첫 열 앞에 둔다.
 * - 금액은 입력값이다(IN-11) — 수식이 아니므로 `int`로 읽는다.
 * - 조정액·인건비 산식 금액은 `BudgetExecution`에 담을 곳이 없어 자리만 남기고 읽지 않는다(IN-9).
 */
function deriveExecutionColumns<R extends string>(
  columns: readonly ColumnDefOf<R>[],
  anchors: { executionIdAfter: R; executionDateBefore: R },
  overrides: Partial<Record<R, Pick<InputFormColumnDef, 'read' | 'format'>>>
): ColumnDefOf<R | 'executionId' | 'executionDate'>[] {
  const out: ColumnDefOf<R | 'executionId' | 'executionDate'>[] = [];
  let placedId = false;
  let placedDate = false;
  for (const column of columns) {
    if (column.role === anchors.executionDateBefore) {
      out.push({ role: 'executionDate', ...EXECUTION_DATE_COLUMN });
      placedDate = true;
    }
    const override = overrides[column.role];
    out.push(override === undefined ? column : { ...column, ...override });
    if (column.role === anchors.executionIdAfter) {
      out.push({ role: 'executionId', ...EXECUTION_ID_COLUMN });
      placedId = true;
    }
  }
  // 앵커 오타는 열이 조용히 빠진 맵을 만든다 — 모듈 로드 시점에 터뜨린다
  if (!placedId || !placedDate) {
    throw new Error(`수행 모드 열 파생 실패: 앵커 역할이 없다 (${anchors.executionIdAfter}, ${anchors.executionDateBefore})`);
  }
  return out;
}

const PERSONNEL_EXECUTION_COLUMNS = deriveExecutionColumns(
  PERSONNEL_COLUMNS,
  { executionIdAfter: 'detailId', executionDateBefore: 'subcategory' },
  {
    adjustment: { read: false, format: 'int' },
    formulaAmount: { read: false, format: 'int' },
    amount: { read: true, format: 'int' },
  }
);

const BUDGET_EXECUTION_COLUMNS = deriveExecutionColumns(
  BUDGET_COLUMNS,
  { executionIdAfter: 'detailId', executionDateBefore: 'name' },
  {
    adjustment: { read: false, format: 'int' },
    amount: { read: true, format: 'int' },
  }
);

type InputFormSheets = Readonly<Record<InputFormSheetKey, InputFormSheetDef>>;

const PLAN_SHEETS: InputFormSheets = {
  personnel: { name: '인건비', hidden: false, headerRow: 1, dataStartRow: 2, columns: PERSONNEL_COLUMNS },
  budget: { name: '사업비', hidden: false, headerRow: 1, dataStartRow: 2, columns: BUDGET_COLUMNS },
  meta: { name: '_meta', hidden: true, headerRow: 1, dataStartRow: 2, columns: META_COLUMNS },
};

// 시트 이름·행 좌표·`_meta`는 두 모드가 같다 — 다른 것은 열뿐이다
const EXECUTION_SHEETS: InputFormSheets = {
  personnel: { ...PLAN_SHEETS.personnel, columns: PERSONNEL_EXECUTION_COLUMNS },
  budget: { ...PLAN_SHEETS.budget, columns: BUDGET_EXECUTION_COLUMNS },
  meta: PLAN_SHEETS.meta,
};

/** mode별 좌표 맵. 호출마다 같은 객체를 돌려준다 */
export function sheetsFor(mode: InputFormMode): InputFormSheets {
  return mode === 'execution' ? EXECUTION_SHEETS : PLAN_SHEETS;
}

/** 제안 모드 맵. Phase 17·19 호출부를 위한 별칭이다 — `sheetsFor('plan')`과 같은 객체 */
export const INPUT_FORM_SHEETS: InputFormSheets = PLAN_SHEETS;

function sheetDef(sheet: InputFormSheetDef | InputFormSheetKey): InputFormSheetDef {
  return typeof sheet === 'string' ? INPUT_FORM_SHEETS[sheet] : sheet;
}

/**
 * 역할 → 열 인덱스(0-based). 역할이 정확히 하나여야 하며 아니면 throw한다 —
 * 좌표 맵의 오타는 조용히 빈 열을 만들지 말고 여기서 터져야 한다.
 */
export function columnOf(sheet: InputFormSheetDef | InputFormSheetKey, role: string): number {
  const def = sheetDef(sheet);
  const indexes: number[] = [];
  def.columns.forEach((column, index) => {
    if (column.role === role) indexes.push(index);
  });
  if (indexes.length !== 1) {
    throw new Error(
      `'${def.name}' 시트에 역할 '${role}'인 열이 ${indexes.length}개다 (정확히 1개여야 한다)`
    );
  }
  return indexes[0] as number;
}

/** 역할 + 1-based 행 → A1 주소. 수식(IN-7)이 같은 행의 다른 열을 가리킬 때 쓴다 */
export function columnAddress(
  sheet: InputFormSheetDef | InputFormSheetKey,
  role: string,
  row1based: number
): string {
  return encodeAddr(columnLetter(columnOf(sheet, role)), row1based);
}

/** `FormSheet.hiddenColumns`에 그대로 넣는 값 */
export function hiddenColumnIndexes(sheet: InputFormSheetDef | InputFormSheetKey): number[] {
  const out: number[] = [];
  sheetDef(sheet).columns.forEach((column, index) => {
    if (column.hidden) out.push(index);
  });
  return out;
}
