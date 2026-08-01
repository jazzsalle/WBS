// 리포지토리 레이어 공용 에러 (SOT §8.4, §8.6, §9)
// 서버 액션은 이 에러들을 잡아 ActionResult 실패로 변환한다 — 예외를 그대로 던지지 않는다.

import type { ActionResult } from '@/types';

// §9 ActionResult의 code 체계에서 추출한다 — 여기와 types가 어긋날 수 없게.
type ActionFailure = Extract<ActionResult<unknown>, { ok: false }>;
export type ActionErrorCode = NonNullable<ActionFailure['code']>;

export class RepositoryError extends Error {
  readonly code?: ActionErrorCode;

  constructor(message: string, code?: ActionErrorCode) {
    super(message);
    this.name = new.target.name;
    this.code = code;
  }
}

// §8.4 낙관적 잠금 실패 — version 조건이 안 맞아 0행 갱신.
// O-3: updatedBy로 "OO님이 먼저 수정했습니다"를 표시해야 하므로 최신 행의 값을 담는다.
export class StaleDataError extends RepositoryError {
  readonly updatedBy: string | null;

  constructor(updatedBy: string | null = null, message = '다른 사람이 먼저 수정했습니다. 최신 내용을 확인하세요.') {
    super(message, 'STALE');
    this.updatedBy = updatedBy;
  }
}

// 조회 대상 없음. §9 코드 체계에 NOT_FOUND가 없으므로 code 없이 반환된다 (code는 선택 필드).
export class NotFoundError extends RepositoryError {
  constructor(message = '대상을 찾을 수 없습니다.') {
    super(message);
  }
}

// SA-1: 세션 없음 또는 app_users.active=false
export class AuthError extends RepositoryError {
  constructor(message = '로그인이 필요하거나 접근 권한이 없습니다.') {
    super(message, 'AUTH');
  }
}

// C-4: 네트워크 장애 — 쓰기를 차단하고 오프라인 배너를 띄운다
export class OfflineError extends RepositoryError {
  constructor(message = '네트워크에 연결할 수 없습니다. 오프라인 상태에서는 저장할 수 없습니다.') {
    super(message, 'OFFLINE');
  }
}

// Zod 검증 실패 — 입력값 검증(§9)과 DB 응답 검증(§8.6) 모두 이 에러를 쓴다.
// DB 응답 실패는 스키마 마이그레이션 누락 신호이므로 조용히 넘기지 않는다 (절대 규칙 5).
export class ValidationError extends RepositoryError {
  constructor(message = '데이터 형식이 올바르지 않습니다.') {
    super(message, 'VALIDATION');
  }
}

// 유니크 제약 충돌 (예: budget_items unique(year_id, category))
export class ConflictError extends RepositoryError {
  constructor(message = '이미 존재하는 항목과 충돌합니다.') {
    super(message, 'CONFLICT');
  }
}

// 비즈니스 규칙 위반 (H-6 마지막 Stage 삭제, H-8 주관기관 삭제 등)
export class RuleViolationError extends RepositoryError {
  constructor(message = '허용되지 않는 작업입니다.') {
    super(message, 'RULE');
  }
}

// 서버 액션의 catch 절에서 사용. SA-4: RepositoryError가 아닌 예외(DB 드라이버 등)는
// 테이블명·제약명 같은 내부 정보를 노출하지 않도록 일반 메시지로 감춘다.
export function toActionFailure(e: unknown): ActionFailure {
  if (e instanceof RepositoryError) {
    return { ok: false, error: e.message, code: e.code };
  }
  return { ok: false, error: '요청 처리 중 오류가 발생했습니다.' };
}
