// 엑셀 예산계획 임포트 파싱의 어댑터 경계 타입 (SOT §6.8).
//
// 이 디렉터리는 SheetJS(`xlsx`)를 import하지 않는다 — 워크북을 읽는 어댑터가 아래 형태로
// 평범한 배열을 만들어 넘긴다. 파싱 규칙(S-1~S-12, I-1~I-15)을 xlsx 의존 없이
// 단위 테스트로 고정하기 위한 경계다 (I-13: 파싱 자체는 서버 액션에서만 수행).

import type { BudgetCategory } from '@/types';
import type { BudgetAxis } from '@/lib/constants';

// ─── 어댑터 경계 ─────────────────────────────────────────────

export interface RawCell {
  /** 계산된 값. 수식 셀은 계산값 (I-16). 빈 셀은 null */
  value: string | number | boolean | null;
  /** 엑셀 에러 셀(#REF!, #DIV/0!, #VALUE!, #N/A, #NAME? 등) 여부 (I-12) */
  isError: boolean;
  /** 에러 문자열 원문 (있으면). 미리보기 표시용 */
  errorText?: string;
}

/** 0-based, 양끝 포함 */
export interface MergeRange {
  s: { r: number; c: number };
  e: { r: number; c: number };
}

export interface RawSheet {
  name: string;
  /** 0-based [row][col]. 없는 셀은 null 대신 { value: null, isError: false } 로 채워 넣는다 */
  cells: RawCell[][];
  merges: MergeRange[];
}

// ─── 비목 매칭 (§6.8.3) ──────────────────────────────────────

/**
 * 라벨 판정 결과 (부록 C 주의 1의 4단계 + I-3/I-5/I-6).
 * - `empty`: 원래부터 빈 셀. S-2 carry-forward 대상이다
 * - `blank-after-normalize`: 값이 있었으나 정규화(I-1) 후 빈 문자열. 메모 행 후보다 (I-5, S-10)
 *
 * 이 둘을 한 값으로 뭉개면 S-10 승계 판정과 carry-forward가 구분되지 않는다.
 */
export type LabelKind =
  | 'category'
  | 'ambiguous'
  | 'axis'
  | 'skip'
  | 'empty'
  | 'blank-after-normalize'
  | 'unknown';

/** 비목 확정 근거 (§7.9.1 Step 4의 상태 아이콘) */
export type CategorySource =
  | 'exact' // ✅ 정규화 후 비목 표준 명칭과 완전일치
  | 'alias-draft' // 🔵 프로파일에 학습된 별칭 (I-2 ①)
  | 'alias-ministry' // 🔵 부처 프리셋 (I-2 ②)
  | 'alias-common' // 🔵 공통 사전 (I-2 ③)
  | 'combined' // S-6 세로 분절 결합
  | 'inherited' // S-10 빈 라벨 행의 비목 승계
  | 'manual'; // 사용자 지정 (I-4/I-6)

export interface LabelClassification {
  /** 병합 확장·carry-forward를 거친 원본 텍스트 */
  raw: string;
  /** I-1 정규화 결과 */
  normalized: string;
  kind: LabelKind;
  category: BudgetCategory | null;
  categorySource: CategorySource | null;
  axis: BudgetAxis | null;
  /** I-6 모호 별칭이면 사용자가 골라야 할 후보들 */
  ambiguousCandidates: BudgetCategory[] | null;
}

/** I-3 퍼지 후보. 자동 확정하지 않고 사용자 확인을 요구한다 */
export interface FuzzyCandidate {
  category: BudgetCategory;
  /** 매칭된 사전 키 (정규화 형태) */
  key: string;
  /** 1 - levenshtein / max(len) */
  similarity: number;
}

/** I-2 조회 우선순위를 담는 매칭 문맥 */
export interface MatchContext {
  /** ① ImportProfile.categoryAliases (임포트 중 학습분) */
  draftAliases?: Readonly<Record<string, BudgetCategory>>;
  /** ② ImportProfile.ministry — MINISTRY_ALIAS_PRESETS 키 */
  ministry?: string | null;
  /** ④ 스킵 패턴. 생략하면 SKIP_ROW_PATTERNS */
  skipPatterns?: readonly string[];
}

// ─── 금액 파싱 (§6.8.4) ──────────────────────────────────────

export type AmountUnit = 1 | 1000 | 1000000;

export type AmountErrorReason =
  /** I-12: 엑셀 수식 에러 셀 (#REF! 등) */
  | 'formula-error'
  /** I-12: 숫자로 읽을 수 없는 텍스트 */
  | 'unparsable'
  /** 정수 안전 범위를 벗어남 — 조용히 잘라내지 않는다 */
  | 'out-of-range';

export interface AmountError {
  reason: AmountErrorReason;
  /** 원본 셀 텍스트 (미리보기 표시용) */
  text: string;
  message: string;
}

export interface AmountParseResult {
  ok: boolean;
  /** 원 단위 정수 (I-11). 실패면 null */
  amount: number | null;
  /** I-11: 소수를 반올림했는가 — 미리보기에 표시한다 */
  rounded: boolean;
  error: AmountError | null;
  /** 원본 셀 텍스트 */
  rawText: string;
}

/** I-10 단위 추정 결과. 자동 확정하지 않고 후보로만 제시한다 */
export interface AmountUnitHint {
  unit: AmountUnit;
  /** 근거 텍스트 (예: '(단위 : 원)') */
  text: string;
  row: number;
  column: number;
}
