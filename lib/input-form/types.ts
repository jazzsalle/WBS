// 사업비 입력 양식의 어댑터 경계 타입 (SOT §6.16, §7.9.7).
//
// 이 디렉터리는 SheetJS(`xlsx`)를 import하지 않는다 — `lib/import/`·`lib/export/`와 같은 경계다(IN-8, I-13).
// 워크북을 쓰는 것은 `lib/input-form-adapter.ts`의 몫이고, 읽기는 `lib/import-adapter.ts`가 만든
// `RawSheet`를 그대로 받는다. 여기는 **어느 값이 어느 칸에 있는가**만 다룬다.

import type { BudgetCategory, BudgetDetail, DetailAxis, DetailFactor, Member, Project, Year } from '@/types';
import type { FormCellFormat, InputFormMode } from './layout';

// 좌표 맵과 같은 곳에 정의한다(layout.ts) — mode가 열을 파생하므로(IN-9). 기존 import 경로를 위해 여기서도 내보낸다
export type { InputFormMode } from './layout';

// ─── 생성기 → 어댑터 (쓰기) ─────────────────────────────────

/**
 * 셀 하나. `formula`가 있으면 어댑터가 수식 셀로 쓴다(IN-7 — 인건비 금액은 엑셀에서도 같은 값이 보여야 한다).
 * 수식 문자열은 `=` 없이 담는다(SheetJS `f` 규약). `value`와 `formula`가 둘 다 없으면 빈 칸이다.
 */
export interface FormCell {
  value?: string | number | null;
  formula?: string;
}

/** 행 역할. 어댑터가 부록 F-2(헤더)·F-4(소계·합계) 서식을 고를 때 쓴다 */
export type FormRowRole = 'header' | 'data' | 'subtotal' | 'total';

/**
 * 열 서식 힌트(부록 F-3·F-5·F-6·F-7). 어댑터가 exceljs 스타일로 옮긴다 — 여기는 서식 라이브러리를 모른다(IN-8).
 * `format`은 layout의 것을 그대로 쓰되 `'percent'`는 넣지 않는다(F-6·X-7 — 백분율 서식 금지).
 */
export interface FormColumnHint {
  /** 보이는 열이면서 `read: false` — 사람이 고치면 안 되는 표시·계산 전용 열(F-3 베이지). 숨김 열은 false */
  key: boolean;
  format: FormCellFormat;
  /** 엑셀 열 너비(문자 수) — F-7 */
  width: number;
  align: 'left' | 'center' | 'right';
}

export interface FormSheet {
  name: string;
  /** `_meta`만 true (IN-2) */
  hidden: boolean;
  /** 0-based [row][col]. 헤더 행을 포함한 시트 전체다 */
  rows: FormCell[][];
  /** 숨길 열(0-based). `memberId`·`detailId`·세목 코드처럼 사람이 볼 필요 없는 키 열 */
  hiddenColumns: number[];
  // ─ Phase 19 서식 힌트(부록 F). 전부 선택이다 — 힌트 없는 FormSheet도 유효하다
  /** 없으면 'data'. `작성안내`(F-8)만 'guide' */
  kind?: 'data' | 'guide';
  /** 1-based. 없으면 1 */
  headerRow?: number;
  /** 1-based. 없으면 `headerRow + 1` — 틀 고정·자동 필터 기준(F-5) */
  dataStartRow?: number;
  /** 열 수와 같은 길이 */
  columnHints?: FormColumnHint[];
  /** `rows`와 같은 길이. 없으면 `headerRow` 이전은 header, 나머지 data */
  rowRoles?: FormRowRole[];
  // ─ Phase 20 드롭다운(부록 F-9). 선택이다 — 없으면 유효성 없음
  /**
   * 열별 **인라인 목록** 유효성(`"현금,현물"`). `_lists` 시트를 만들지 않는다(F-9 — 제안 양식 시트 목록 불변).
   * 데이터 행(`rowRoles`가 'data'인 행, `rowRoles`가 없으면 `dataStartRow`부터 끝까지)에만 건다 —
   * 소계·총액 행은 수식이라 목록이 의미 없다. 파서는 목록과 무관하게 값을 다시 검사한다(붙여넣기는 유효성을 우회한다).
   */
  validations?: FormColumnValidation[];
}

export interface FormColumnValidation {
  /** 0-based 열 */
  column: number;
  /** 보이는 라벨 그대로. 쉼표를 담을 수 없다(인라인 목록 구분자) — 어댑터가 검사한다 */
  values: string[];
  // ─ Phase 21 목표 양식(F-9). 둘 다 선택이다 — 없으면 Phase 20 인라인 목록 경로 그대로
  /**
   * 인라인 목록 대신 **범위 참조** 목록. `listRange`를 쓰면 `values`는 빈 배열이어야 한다(둘 다 있으면 어느 쪽이
   * 의도였는지 알 수 없다). 기관·관여자 목록은 인라인 한도(255자)를 넘을 수 있고, 실적·측정 시트의 지표명 목록은
   * 같은 파일의 다른 데이터 시트를 가리켜야 새로 적은 지표도 뜬다(GF-10).
   */
  listRange?: FormListRange;
  /** 없으면 'stop'. 관여자(`;` 다중 입력)·지표명/평가항목 열만 'warning'이다 — 'stop'이면 엑셀이 입력을 막는다(GF-4) */
  errorStyle?: 'stop' | 'warning';
}

/**
 * 목록 범위. 시트 이름의 따옴표 처리는 어댑터 몫이다 — 여기는 이름과 A1 범위만 담는다.
 * `range`는 절대 참조 A1 범위(`$A$2:$A$14`) — 드롭다운이 행마다 복사되므로 상대 참조면 목록이 밀린다.
 */
export interface FormListRange {
  /** 대상 시트 이름(`_lists`·`성과목표` 등) */
  sheet: string;
  range: string;
}

export interface InputFormWorkbook {
  sheets: FormSheet[];
  /** X-12와 같은 원칙 — 과제명·연차·생성일을 담는다 */
  fileName: string;
}

// ─── `_meta` (IN-2) ──────────────────────────────────────────

export interface InputFormMeta {
  formVersion: number;
  projectId: string;
  yearId: string;
  /** ISO 8601 */
  generatedAt: string;
  /** 사업비 시트에 깔린 세목 코드(부록 A.5). 시트 순서 그대로 */
  subcategoryCodes: string[];
  /** 인건비 시트에 깔린 인력 id. 시트 순서 그대로 — 이름 매칭을 하지 않는 근거다(IN-3) */
  memberIds: string[];
  // ─ 수행 양식(Phase 20)만 싣는다(IN-2). 제안 양식에서는 셋 다 없다 — Phase 19 파일과 같은 모양이어야 한다
  /** 없으면 제안 양식이다. `parseMeta`는 제안 파일에서 이 키를 만들지 않는다 — `metaMode()`로 읽는다 */
  mode?: InputFormMode;
  /** executionId → 내려받을 때의 version. 충돌·삭제 후보 판정의 기준(IN-10). 시트 순서 그대로 */
  executions?: Record<string, number>;
  /** 그 연차의 산출근거 id. 숨김 `detailId`의 경계 목록(IN-13) */
  detailIds?: string[];
}

/** 수행 양식의 `_meta`. `parseMeta`가 mode 'execution'을 읽으면 목록 두 개를 늘 채운다(비어도 빈 값) */
export type ExecutionFormMeta = InputFormMeta & {
  mode: 'execution';
  executions: Record<string, number>;
  detailIds: string[];
};

// ─── 생성기 입력 ─────────────────────────────────────────────

/**
 * 양식 한 장을 만드는 데 필요한 앱 데이터 전부. **읽기 전용이다** — 내려받기는 앱을 바꾸지 않는다.
 * `details`는 그 연차의 산출근거만 담는다(양식은 연차 단위, §7.9.7).
 */
export interface InputFormData {
  project: Pick<Project, 'id' | 'name'>;
  year: Pick<Year, 'id' | 'name' | 'startDate' | 'endDate' | 'order'>;
  /** `staffName`은 조직원 연결(§5.19) 표시용. 연결이 없으면 null */
  members: (Member & { staffName: string | null })[];
  details: BudgetDetail[];
  /** 수행 모드(IN-9)만 쓴다. 그 연차 budget_items의 집행 전부 — 생성기는 하나도 빠뜨리지 않고 한 행씩 싣는다(IN-4) */
  executions?: InputFormExecution[];
}

/**
 * 생성기가 쓰는 집행 한 건. `BudgetExecution`(§5.12)의 필요한 필드 + 부모 비목이다 — 집행은 비목(BudgetItem)
 * 아래에 달려 있어 행 자체로는 비목을 모른다. 앱 타입을 그대로 import하지 않고 구조만 적어
 * 리포지토리 타입이 늘어도 이 경계가 흔들리지 않게 한다.
 */
export interface InputFormExecution {
  id: string;
  version: number;
  /** ISO `yyyy-mm-dd` */
  date: string;
  amount: number;
  description: string;
  note: string;
  category: BudgetCategory;
  subcategoryCode: string | null;
  spec: string;
  unitPrice: number | null;
  factors: DetailFactor[] | null;
  axis: DetailAxis | null;
  memberId: string | null;
  detailId: string | null;
}

// ─── 파서 출력 ───────────────────────────────────────────────

/**
 * 행 단위 문제. `blocking`이 true면 반영을 막는다(참여율·개월 범위 밖 등).
 * 경고(연차 개월 초과·연봉 없음·라벨 손실)는 막지 않는다 — PL-15·RL-1.
 */
export interface ParseIssue {
  kind: string;
  message: string;
  blocking: boolean;
}

/** 인건비 시트 한 행. 금액·연봉·월급은 없다 — 읽지 않는 열이다(IN-3, PL-D7) */
export interface ParsedPersonnelRow {
  /** 1-based 엑셀 행 번호. 사용자 메시지용 */
  rowIndex: number;
  /** 숨김 열의 값 그대로. `_meta`에 없는 id면 "알 수 없는 행"으로 남긴다(IN-3) */
  memberId: string;
  /** 숨김 열. 새 행이면 null (IN-5의 추가/변경/삭제 판정 키) */
  detailId: string | null;
  /** 보이는 `세목` 라벨을 부록 A.5 인건비 세목 코드로 옮긴 값. 모르는 라벨이면 null */
  subcategory: string | null;
  participation: number | null;
  months: number | null;
  axis: DetailAxis | null;
  adjustment: number;
  note: string;
  issues: ParseIssue[];
}

/** 사업비 시트 한 행 (빈 행은 여기 오지 않는다 — IN-4) */
export interface ParsedQuantityRow {
  rowIndex: number;
  /** 숨김 열의 세목 코드 그대로. 부록 A.5에 없으면 `category`가 null이고 "알 수 없는 세목" */
  subcategory: string;
  category: BudgetCategory | null;
  detailId: string | null;
  name: string;
  spec: string;
  unitPrice: number;
  /** 인자1~3 중 값이 있는 것만, 순서대로. 라벨은 프리셋 `defaultFactors`로 고정된다(IN-4) */
  factors: number[];
  adjustment: number;
  axis: DetailAxis | null;
  note: string;
  issues: ParseIssue[];
}

export interface ParsedInputForm {
  meta: InputFormMeta;
  personnel: ParsedPersonnelRow[];
  budget: ParsedQuantityRow[];
  /** 행에 매이지 않는 파일 단위 문제 */
  issues: ParseIssue[];
}

// ─── 수행 모드 파서 출력 (IN-9~IN-13) ────────────────────────

/**
 * 수행 양식 한 행 = `BudgetExecution` 한 건의 후보. 인건비·사업비 시트 모두 이 모양으로 모은다 —
 * 반영이 id 기반이라(IN-10) 두 시트를 구별할 필요가 diff 단계에 없다.
 */
export interface ParsedExecutionRow {
  /** 1-based 엑셀 행 번호 */
  rowIndex: number;
  /** 숨김 열. 비면 새 행(add). `_meta.executions` 밖이면 'unknown-execution'(IN-13) */
  executionId: string | null;
  /** 세목 코드로 정한 비목. 세목 키를 해석하지 못하면 null(그 행은 blocking 오류) */
  category: BudgetCategory | null;
  /** 부록 A.5 세목 코드. `세목 미지정` 슬롯(키 `비목:`)은 null(IN-4) */
  subcategoryCode: string | null;
  /** 인건비 시트 행만. `_meta.memberIds` 밖이면 blocking(IN-13) */
  memberId: string | null;
  /** 숨김 열. `_meta.detailIds` 밖이면 blocking(IN-13) */
  detailId: string | null;
  /** ISO `yyyy-mm-dd`. 비었거나 해석하지 못하면 null이고 그 행은 blocking(IN-11) */
  date: string | null;
  /** 품명(사업비). 인건비 시트에는 품명 열이 없어 빈 문자열이다 */
  description: string;
  spec: string;
  unitPrice: number | null;
  /** 사업비는 인자1~3(프리셋 라벨, IN-4), 인건비는 `참여율(%)`·`참여기간(월)`(IN-12). 없으면 null */
  factors: DetailFactor[] | null;
  /** 비어도 된다(IN-11) — 제안 모드처럼 현금으로 채우지 않는다 */
  axis: DetailAxis | null;
  /**
   * 원 단위 정수. 사업비는 비어 있으면 파서가 단가 × 인자로 채운 값이다(IN-11).
   * 인건비는 입력값 그대로(비면 null) — 연봉이 필요한 보완은 미리보기가 한다
   */
  amount: number | null;
  note: string;
  issues: ParseIssue[];
}

export interface ParsedExecutionForm {
  meta: ExecutionFormMeta;
  personnel: ParsedExecutionRow[];
  budget: ParsedExecutionRow[];
  /** 행에 매이지 않는 파일 단위 문제 */
  issues: ParseIssue[];
}

/**
 * 수행 모드 행 문제의 사유 코드. 숫자 칸 읽기 실패처럼 제안 모드와 같은 검사(`unknown-subcategory`·
 * `unit-price-*`·`factor-invalid` 등)는 제안 모드 코드를 그대로 쓰고, 여기는 수행 모드에서 새로 생긴 것만 둔다.
 */
export type ExecutionIssueKind =
  | 'no-date'
  | 'invalid-date'
  | 'date-out-of-year'
  | 'amount-invalid'
  | 'amount-negative'
  | 'amount-not-integer'
  | 'no-amount'
  | 'amount-mismatch'
  | 'description-too-long'
  | 'unknown-execution'
  | 'unknown-member'
  | 'unknown-detail'
  | 'category-moved'
  | 'duplicate-execution';

/** 품명(`BudgetExecution.description`) 상한 — 화면 CRUD의 적요 검증과 같다(IN-11) */
export const EXECUTION_DESCRIPTION_MAX = 200;

/**
 * 사유별 기본 문구와 반영 차단 여부(SOT §6.16 IN-10·IN-11·IN-13). 파서는 셀 값을 덧붙일 수 있지만
 * 차단 여부는 여기서만 정한다 — 같은 사유가 행마다 다르게 막히면 미리보기와 반영이 어긋난다.
 */
export const EXECUTION_ISSUES: Readonly<Record<ExecutionIssueKind, { message: string; blocking: boolean }>> = {
  'no-date': { message: '집행일이 비어 있습니다 — 집행일은 필수입니다', blocking: true },
  'invalid-date': { message: '집행일을 날짜로 읽을 수 없습니다', blocking: true },
  'date-out-of-year': { message: '집행일이 연차 기간 밖입니다', blocking: false },
  'amount-invalid': { message: '금액을 숫자로 읽을 수 없습니다', blocking: true },
  'amount-negative': { message: '금액은 0 이상이어야 합니다', blocking: true },
  'amount-not-integer': { message: '금액은 원 단위 정수여야 합니다', blocking: true },
  'no-amount': { message: '금액이 비어 있고 단가 × 인자로도 채울 수 없습니다', blocking: true },
  'amount-mismatch': {
    message: '입력 금액이 단가 × 인자와 다릅니다 — 입력 금액으로 반영합니다',
    blocking: false,
  },
  'description-too-long': {
    message: `품명은 ${EXECUTION_DESCRIPTION_MAX}자 이내여야 합니다`,
    blocking: true,
  },
  'unknown-execution': {
    message: '이 양식에 없던 executionId입니다 — 다른 양식에서 복사한 행은 올릴 수 없습니다',
    blocking: true,
  },
  'unknown-member': {
    message: '이 양식에 없던 인력(memberId)입니다 — 다른 과제의 행은 올릴 수 없습니다',
    blocking: true,
  },
  'unknown-detail': {
    message: '이 연차의 산출근거가 아닌 detailId입니다 — 다른 과제·연차의 행은 올릴 수 없습니다',
    blocking: true,
  },
  'category-moved': {
    message: '기존 집행 행을 다른 비목으로 옮길 수 없습니다 — 비목을 바꾸려면 그 행을 지우고 새 행으로 적으세요',
    blocking: true,
  },
  'duplicate-execution': {
    message: '같은 집행을 가리키는 행이 여럿입니다 — 복사한 행은 빈 줄에 다시 적으세요',
    blocking: true,
  },
};

/** 파싱에 들어가기 전에 파일째로 거부하는 이유 (IN-2·IN-9) */
export interface InputFormRejection {
  kind: 'no-meta' | 'project-mismatch' | 'version-mismatch' | 'mode-mismatch' | 'missing-sheet';
  message: string;
}
