// 사업비 입력 양식의 어댑터 경계 타입 (SOT §6.16, §7.9.7).
//
// 이 디렉터리는 SheetJS(`xlsx`)를 import하지 않는다 — `lib/import/`·`lib/export/`와 같은 경계다(IN-8, I-13).
// 워크북을 쓰는 것은 `lib/input-form-adapter.ts`의 몫이고, 읽기는 `lib/import-adapter.ts`가 만든
// `RawSheet`를 그대로 받는다. 여기는 **어느 값이 어느 칸에 있는가**만 다룬다.

import type { BudgetCategory, BudgetDetail, DetailAxis, Member, Project, Year } from '@/types';
import type { FormCellFormat } from './layout';

// ─── 생성기 → 어댑터 (쓰기) ─────────────────────────────────

/**
 * 셀 하나. `formula`가 있으면 어댑터가 수식 셀로 쓴다(IN-7 — 인건비 금액은 엑셀에서도 같은 값이 보여야 한다).
 * 수식 문자열은 `=` 없이 담는다(SheetJS `f` 규약). `value`와 `formula`가 둘 다 없으면 빈 칸이다.
 */
export interface FormCell {
  value?: string | number | null;
  formula?: string;
  /**
   * 수식 셀의 결과값(캐시). **있을 때만** 어댑터가 `<v>`로 쓴다 — 없으면 Phase 19 그대로 수식만(IN-7, 기존 양식 바이트 불변).
   * 협약 예산 보기 내려받기(AG-8)는 앱이 이미 계산한 표라 엑셀이 다시 계산하기 전에도 같은 값이 보여야 한다.
   */
  result?: number;
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
  /**
   * `_meta`에 `mode` 행이 있었다 — 폐기된 옛 수행 양식(v4.9)의 표지라 `checkMeta`가 거부한다(IN-2).
   * `parseMeta`는 행이 없으면 이 키를 만들지 않는다 — 제안 파일의 결과가 Phase 19와 같은 모양이어야 한다
   */
  hasModeRow?: true;
}

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

/** 파싱에 들어가기 전에 파일째로 거부하는 이유 (IN-2) */
export interface InputFormRejection {
  kind: 'no-meta' | 'project-mismatch' | 'version-mismatch' | 'legacy-mode-row' | 'missing-sheet';
  message: string;
}
