// 제출 서식 내보내기의 어댑터 경계 타입 (SOT §6.12).
//
// 이 디렉터리는 SheetJS(`xlsx`)를 import하지 않는다 — `lib/import/`와 같은 경계다(§6.12.4, I-13).
// 워크북을 열고 쓰는 것은 어댑터의 몫이고, 여기는 **어느 값을 어느 셀에 쓸까**만 다룬다.
// 그래야 좌표 규칙 전부가 워크북 없이 단위 테스트로 고정된다.

import type { BudgetCategory, HireType, IndirectBase } from '@/types';
import type { BudgetDetailInput, MemberSalaryInput } from '@/lib/budget-plan';
import type { DetailColumnRole } from '@/lib/import';

// ─── 앱 쪽 입력 (§5.17 BudgetDetail · §5.11 Member · §5.5 Year) ─
//
// DB 행을 그대로 대입할 수 있는 **최소 형태**만 요구한다 (lib/budget-plan의 BudgetDetailInput과 같은 태도).
// 산출 금액은 여기 담지 않는다 — 저장된 `amount`를 믿지 않고 `computeDetailAmount`로 다시 낸다 (PL-10a).

/** 인건비 행이 쓰는 인력 정보. 단가(연봉)의 유일한 출처는 명부다 (§5.11, D-8a) */
export interface ExportMember extends MemberSalaryInput {
  name: string;
  position: string;
  /** 서식의 기존인력/신규채용 하위 블록을 가르는 값이다 (부록 B.8.1) */
  hireType: HireType;
}

/** 산출 행 하나. 서식이 요구하는 표시 필드(품명·규격·비고)가 산식 입력에 더해진다 */
export interface ExportDetailRow extends BudgetDetailInput {
  name: string;
  spec: string;
  note: string;
  /** 세목 안에서의 표시 순서 (§5.17). 슬롯 배치 순서가 된다 */
  order: number;
}

/** 총괄표의 연차 열을 짚는 데 필요한 최소 정보. `order`는 0-based이고 서식은 1-based다 (§5.5) */
export interface ExportYear {
  id: string;
  order: number;
  name: string;
}

/**
 * 내보내기 한 번의 입력 전부. **읽기 전용이다** (X-11: 앱 데이터를 한 줄도 바꾸지 않는다).
 *
 * `details`는 **전 연차**를 담는다 — 산출근거는 한 연차만 쓰지만(X-9) 총괄표는 전 연차 열을
 * 채워야 하므로(X-10) 두 시트가 같은 배열을 보아야 합계가 어긋나지 않는다.
 */
export interface ExportPlanData {
  details: readonly ExportDetailRow[];
  members: readonly ExportMember[];
  years: readonly ExportYear[];
  /**
   * 총괄표 간접비 비율 행(X-10c, PL-13)의 수정직접비 정의. 과제의 `indirect_max` 규칙 행이 고르고
   * (§6.14 RL-3), 행이 없으면 호출부가 `DEFAULT_INDIRECT_BASE`를 넣는다 — 파일의 비율과 화면의
   * 비율이 같은 분모를 보아야 한다.
   */
  indirectBase: IndirectBase;
}

// ─── 쓰기 지시 ───────────────────────────────────────────────

/**
 * 어댑터에게 넘기는 쓰기 지시 한 건. **수식 문자열은 담지 않는다** — 앱이 만드는 것은 언제나 값이고,
 * 소계·합계·비율만 템플릿의 수식이 다시 계산한다 (X-4a).
 *
 * `value`가 `null`이면 **셀을 비운다**(X-8: 값이 없어도 서식의 자리는 남긴다).
 */
export interface CellWrite {
  sheet: string;
  /** A1 표기. 1-based 행 */
  addr: string;
  value: string | number | null;
  /**
   * X-4: 이 셀에 템플릿 수식이 있으면 어댑터가 **지운 뒤**(`delete cell.f`) 값을 쓴다.
   *
   * 행 금액 열이 수식이라 필요하다(`J65 = TRUNC(G65*H65*I65,-3)`). 수식을 남긴 채 값만 넣으면
   * 엑셀이 다시 계산하면서 값이 사라지고, 무엇보다 **남의 조정상수가 붙은 수식**이 그대로 살아
   * 금액이 조용히 어긋난다. 축이 바뀐 슬롯(현금 → 현물)에서는 쓰지 않는 쪽 금액 칸의 수식을
   * 지우지 않으면 같은 금액이 양쪽에 잡혀 소계가 두 배가 된다.
   */
  clearFormula?: boolean;
}

// ─── 템플릿 파일에서 읽어 오는 사실 ──────────────────────────

/** 0-based, 양끝 포함 (lib/import의 MergeRange와 같은 형태) */
export interface TemplateMergeRange {
  s: { r: number; c: number };
  e: { r: number; c: number };
}

/**
 * 템플릿 워크북 시트 한 장의 **사실**. 어댑터가 파일에서 만든다.
 *
 * **수식 셀 집합을 맵에 적지 않는 이유**: 같은 사실을 맵과 파일 두 곳에 적으면 반드시 어긋난다.
 * 수식은 파일이 원본이다. `formulaCells`는 이제 X-4 위반 판정에 쓰이지 않지만(행 금액 열이
 * 수식인 것은 정상이다) 어댑터가 수식을 지울 대상을 세고 리포트하는 데 필요하다.
 */
export interface TemplateSheetInfo {
  name: string;
  /** `!ref`를 디코드한 사용 범위 (0-based, 양끝 포함) */
  range: TemplateMergeRange;
  /** 셀 레코드가 실제로 있는 주소(A1). 범위 안이어도 레코드가 없으면 서식이 붙어 있지 않다 */
  presentCells: readonly string[];
  /** 수식 셀 주소(A1) */
  formulaCells: readonly string[];
  merges: readonly TemplateMergeRange[];
  /**
   * 이 시트의 수식이 가리키는 **다른 시트 이름**.
   *
   * 템플릿을 만들 때 시트명을 바꾸고 수식을 안 고치면(`'1차년도_250520'!G13`) 엑셀에서
   * 그 열 전체가 `#REF!`가 된다. 실제로 한 번 일어났고, 부처 템플릿이 늘면 반복될 자리다.
   */
  referencedSheets: readonly string[];
}

// ─── 셀 좌표 맵 (X-3: 코드가 아니라 데이터다) ────────────────

export type TemplateAxis = 'cash' | 'inKind';

export interface TemplateColumn {
  /** 열 문자 (`'F'`) */
  column: string;
  role: DetailColumnRole;
  /** 템플릿 헤더 원문. 인자 라벨은 세목마다 다르다 (PL-3, 실측 `시트(수량)`) */
  label: string;
  /**
   * X-7: 백분율 서식 셀인가. 화면의 `10.0`을 그대로 쓰면 엑셀이 `1000%`로 읽으므로
   * 여기가 true면 **100으로 나눠** 쓴다.
   */
  percentFormat: boolean;
  /**
   * X-4: 행 단위 **금액** 열인가. true면 템플릿에 수식이 있어도 앱이 계산한 값이 이긴다
   * (`CellWrite.clearFormula`). 열의 **역할**로 정하는 값이지 이 템플릿에 수식이 있느냐가 아니다 —
   * 같은 열에서도 어떤 행은 수식이고 어떤 행은 빈칸이다(실측 `I99`는 수식, `I101`은 빈칸).
   *
   * 소계·합계는 여기 해당하지 않는다. 그것은 `TemplateSubtotal` 좌표이고 X-4a대로 수식을 살린다.
   */
  overwritesFormula: boolean;
}

/**
 * 소계·합계 행. **데이터 대상이 아니다** (X-4a) — 템플릿의 `SUM`이 다시 계산하고, 우리는
 * 그 재계산 값과 앱의 소계가 일치하는지 대조할 때만 읽는다. 이 검산이 X-4로 행을 값으로
 * 바꾼 뒤에도 남는 유일한 안전망이다.
 */
export interface TemplateSubtotal {
  label: string;
  /** 1-based */
  row: number;
  cash: string | null;
  inKind: string | null;
  total: string | null;
}

/** 인건비의 기존인력/신규채용처럼 세목 헤더 없이 소계로만 갈리는 하위 블록 (부록 B.8.1) */
export type TemplateSegment = 'existing' | 'newHire';

export interface TemplateBlock {
  /** `personnel/null#existing` 형태. 블록을 가리키는 안정된 키 */
  key: string;
  category: BudgetCategory;
  /** 부록 A.5 세목 코드. 서식에 세목 구분이 없으면 `null`이다 (D-3a: 없는 값을 지어내지 않는다) */
  subcategory: string | null;
  segment: TemplateSegment | null;
  /** 템플릿 원문 라벨 */
  label: string;
  /** 컬럼 헤더 행 (1-based). 실측에 2~3행에 걸친 헤더가 있다 (D-7) */
  headerRows: readonly number[];
  dataStartRow: number;
  dataEndRow: number;
  /**
   * 실제로 한 줄을 이루는 행 (1-based). 세로 병합된 데이터 행은 **시작 행만** 담는다 —
   * 실측 `⑤ 국내출장비`는 `C186:C187`로 병합된 한 줄이다 (D-25).
   */
  slotRows: readonly number[];
  /** X-5 용량. `slotRows.length`와 같다 */
  slotCount: number;
  /**
   * **데이터 대상** 열. 병합 안쪽인 열은 여기 들어오지 않는다(거기 쓰면 값이 보이지 않는다).
   * 금액 열은 수식이어도 들어온다 — X-4대로 앱 값이 이긴다.
   */
  columns: readonly TemplateColumn[];
  subtotals: readonly TemplateSubtotal[];
}

/** 비목 합계 줄 (D-23). 대조용 읽기 좌표다 */
export interface TemplateCategoryTotal {
  category: BudgetCategory;
  row: number;
  labelAddr: string;
  valueAddr: string;
}

export interface TemplateDetailLayout {
  sheet: string;
  blocks: readonly TemplateBlock[];
  categoryTotals: readonly TemplateCategoryTotal[];
}

export interface TemplateYearColumn {
  /** 1-based 연차 번호 */
  yearIndex: number;
  column: string;
  labelCell: string;
  label: string;
  /**
   * 값이 템플릿 수식으로 산출근거 시트에 묶여 있는 열인가.
   *
   * **X-10a: true여도 쓴다.** 산출근거 시트에는 내보내는 연차 **하나만** 들어가므로(X-9),
   * 2차년도를 내보내면 `산출근거!G13`을 가리키는 1차년도 열이 2차년도 값을 1차년도 칸에
   * 보여 준다 — 살려 두면 조용히 틀린다. 이 필드는 이제 "쓸까 말까"가 아니라
   * **어댑터가 수식을 지워야 하는 열인가**를 뜻한다 (`CellWrite.clearFormula`).
   */
  linked: boolean;
}

export type TemplateSummaryRowKind = 'amount' | 'aggregate' | 'ratio';

/**
 * X-10c: 집계·비율 행이 **무엇을 계산하는가**. 산식은 여기 없다 — `lib/budget-plan.ts`의
 * `evaluateBudgetRules`가 갖고 있고(PL-10a) 이 이름은 그 결과의 어느 필드를 쓸지만 고른다.
 *
 * 이 행들도 값으로 쓰는 이유는 X-10a와 같다: `총괄표!F12 = 산출근거!G21`은 총괄표 안의 SUM이
 * 아니라 **시트 간 참조**이고, 산출근거에는 내보내는 연차 하나만 들어간다(X-9).
 */
export type SummaryAggregateKind =
  /** 총 인건비 E = A+B+C+D (PL-11 기준의 인건비 + 학생인건비) */
  | 'totalPersonnel'
  /** 수정인건비 E1 = A+B+D — `personnel_support` 세목을 뺀다 (PL-11) */
  | 'modifiedPersonnel'
  /** 연구수당 비율 = 연구수당 / E1 × 100 (PL-12) */
  | 'allowanceRate'
  /** 간접비 비율 = 간접비 / 직접비 현금 기준액 × 100 (PL-13. 기준액은 C를 **넣는다**) */
  | 'indirectRate'
  /** 직접비 계 K = 총액 − 간접비 */
  | 'directTotal'
  /** 연구개발비 총액 M = K + L */
  | 'grandTotal';

export interface TemplateSummaryRow {
  row: number;
  label: string;
  /** 서식 라벨과 수식이 어긋나 판정할 수 없으면 `null`이다 (`conflict` 참고) */
  category: BudgetCategory | null;
  subcategory: string | null;
  axis: TemplateAxis | null;
  kind: TemplateSummaryRowKind;
  percentFormat: boolean;
  /** X-10c: 집계·비율 행이 계산하는 값. `kind !== 'amount'`인 행은 이것 아니면 `memo`를 갖는다 */
  aggregate?: SummaryAggregateKind;
  /**
   * X-10d: **앱에 대응 데이터가 없는 괄호 메모 행**이라는 표시와 그 이유.
   *
   * `(연구시설‧장비비 중 통합관리비(현금))`·`(간접비 중 연구실 안전관리비)`는 부록 A.5의 세목이
   * 아니고 §6.11 I-5·S-10이 임포트에서 이미 건너뛴다 — 읽지 않는 것을 내보내기가 지어낼 수 없다.
   * 그렇다고 템플릿 수식을 남기면 다른 연차를 내보낼 때 **틀린 값이 찍히므로** 셀을 비우고 알린다.
   */
  memo?: string;
  /** 서식 자체의 모순. 지어내지 않고 드러낸다 */
  conflict?: string;
}

export interface TemplateSummaryLayout {
  sheet: string;
  headerRow: number;
  yearColumns: readonly TemplateYearColumn[];
  /** 연차 합계 열. 템플릿 수식이 채운다 */
  totalColumn: string;
  rows: readonly TemplateSummaryRow[];
}

export interface TemplateLayout {
  templateId: string;
  templateFile: string;
  detail: TemplateDetailLayout;
  summary: TemplateSummaryLayout;
}

// ─── 검증 결과 ───────────────────────────────────────────────

export type LayoutViolationKind =
  /** 맵이 워크북에 없는 시트를 가리킨다 */
  | 'missing-sheet'
  /** 맵이 시트 사용 범위 밖을 가리킨다 */
  | 'missing-cell'
  /** 병합 범위 **안쪽**(시작 셀이 아닌) 좌표. 거기 쓰면 값이 안 보인다 */
  | 'merge-interior'
  /**
   * **소계·합계·비율 셀**을 데이터 대상으로 지정 (X-4a 위반).
   *
   * 행 금액 열이 수식인 것은 위반이 아니다 — X-4대로 앱 값으로 덮어쓴다. 여기서 잡는 것은
   * 템플릿이 스스로 굴려야 할 집계 셀에 값을 박는 경우다. 거기 값을 박으면 사용자가 엑셀에서
   * 한 칸을 고쳐도 소계가 따라오지 않고, **앱 값과 엑셀 재계산 값의 대조**라는 유일한 검산이 사라진다.
   */
  | 'formula-target'
  /** 수식이 워크북에 없는 시트를 가리킨다 — 열면 `#REF!`가 된다 */
  | 'dangling-sheet-ref'
  /**
   * 총괄표 행이 **무엇을 써야 할지 정할 수 없는데** 그 사실이 맵에 비어 있다 (X-10b·X-10c 위반).
   *
   * 두 경우다:
   * 1. 금액 행인데 비목을 정할 수 없고 `conflict`도 없다. 실측 24·25행이 그렇다 — 라벨은
   *    `위탁연구개발비`인데 수식은 `산출근거!G33`(국제공동연구개발비)을 가리킨다. 어느 쪽이
   *    옳은지는 서식 소유자의 결정이며, 그때까지는 비워 내보내고 사용자에게 알린다.
   * 2. 집계·비율 행인데 `aggregate`(무엇을 계산할까)도 `memo`(왜 비우는가)도 없다 (X-10c).
   *
   * 어느 쪽이든 표시를 지우면 그 행은 **말없이 빈 줄**이 된다 — 사용자는 빠진 줄이 있다는 것조차
   * 모른 채 제출한다.
   */
  | 'unresolved-summary-row';

export interface LayoutViolation {
  kind: LayoutViolationKind;
  sheet: string;
  /** 문제가 된 셀 주소. 시트 단위 위반이면 없다 */
  addr?: string;
  /** 맵 안의 위치 (`detail.blocks[personnel/null#existing].columns.F`) */
  path: string;
  detail: string;
}
