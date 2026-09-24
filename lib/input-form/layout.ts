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
export type FormCellFormat = 'int' | 'decimal' | 'percent' | 'text' | 'formula';

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
  | 'name'
  | 'position'
  | 'staff'
  | 'salaryBasis'
  | 'annualSalary'
  | 'monthlySalary'
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
  | 'category'
  | 'subcategoryLabel'
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

/** `_meta` 시트의 고정 키. 목록 항목은 `subcategory:<code>`·`member:<memberId>` 접두 행으로 잇는다 */
export const META_KEYS = {
  formVersion: 'formVersion',
  projectId: 'projectId',
  yearId: 'yearId',
  generatedAt: 'generatedAt',
} as const;

export const META_SUBCATEGORY_PREFIX = 'subcategory:';
export const META_MEMBER_PREFIX = 'member:';

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

export const INPUT_FORM_SHEETS: Readonly<Record<InputFormSheetKey, InputFormSheetDef>> = {
  personnel: { name: '인건비', hidden: false, headerRow: 1, dataStartRow: 2, columns: PERSONNEL_COLUMNS },
  budget: { name: '사업비', hidden: false, headerRow: 1, dataStartRow: 2, columns: BUDGET_COLUMNS },
  meta: { name: '_meta', hidden: true, headerRow: 1, dataStartRow: 2, columns: META_COLUMNS },
};

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
