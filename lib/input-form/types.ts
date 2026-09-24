// 사업비 입력 양식의 어댑터 경계 타입 (SOT §6.16, §7.9.7).
//
// 이 디렉터리는 SheetJS(`xlsx`)를 import하지 않는다 — `lib/import/`·`lib/export/`와 같은 경계다(IN-8, I-13).
// 워크북을 쓰는 것은 `lib/input-form-adapter.ts`의 몫이고, 읽기는 `lib/import-adapter.ts`가 만든
// `RawSheet`를 그대로 받는다. 여기는 **어느 값이 어느 칸에 있는가**만 다룬다.

import type { BudgetCategory, BudgetDetail, DetailAxis, Member, Project, Year } from '@/types';

// ─── 생성기 → 어댑터 (쓰기) ─────────────────────────────────

/**
 * 셀 하나. `formula`가 있으면 어댑터가 수식 셀로 쓴다(IN-7 — 인건비 금액은 엑셀에서도 같은 값이 보여야 한다).
 * 수식 문자열은 `=` 없이 담는다(SheetJS `f` 규약). `value`와 `formula`가 둘 다 없으면 빈 칸이다.
 */
export interface FormCell {
  value?: string | number | null;
  formula?: string;
}

export interface FormSheet {
  name: string;
  /** `_meta`만 true (IN-2) */
  hidden: boolean;
  /** 0-based [row][col]. 헤더 행을 포함한 시트 전체다 */
  rows: FormCell[][];
  /** 숨길 열(0-based). `memberId`·`detailId`·세목 코드처럼 사람이 볼 필요 없는 키 열 */
  hiddenColumns: number[];
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
  kind: 'no-meta' | 'project-mismatch' | 'version-mismatch' | 'missing-sheet';
  message: string;
}
