// 액션 실패 배너 (SOT §9 ActionResult 코드 체계, §8.2 C-4)
// 에러를 조용히 삼키지 않는다 — 실패한 액션은 반드시 이 배너로 사용자에게 보인다.
// code별로 "다음에 무엇을 해야 하는지"를 덧붙인다. 서버가 준 error 문구는 그대로 보여준다.

import type { ActionErrorCode } from '@/lib/db/errors';

interface CodePresentation {
  title: string;
  hint: string;
  tone: 'red' | 'amber';
}

const CODE_PRESENTATION: Record<ActionErrorCode, CodePresentation> = {
  STALE: {
    title: '다른 사람이 먼저 수정했습니다',
    hint: '최신 내용을 다시 불러온 뒤 저장하세요. 입력한 내용은 사라지지 않습니다.',
    tone: 'amber',
  },
  AUTH: {
    title: '접근 권한이 없습니다',
    hint: '세션이 만료되었거나 아직 승인되지 않은 계정입니다. 다시 로그인하거나 관리자 승인을 받으세요.',
    tone: 'amber',
  },
  OFFLINE: {
    // C-4: 오프라인 편집은 지원하지 않는다 — 연결 복구 전에는 저장이 불가능하다
    title: '네트워크에 연결할 수 없습니다',
    hint: '연결이 복구된 뒤 다시 시도하세요. 오프라인 상태에서는 저장할 수 없습니다.',
    tone: 'amber',
  },
  VALIDATION: {
    title: '입력값을 확인하세요',
    hint: '형식이 맞지 않는 항목이 있습니다. 표시된 내용을 고친 뒤 다시 저장하세요.',
    tone: 'red',
  },
  CONFLICT: {
    title: '이미 있는 항목과 충돌합니다',
    hint: '같은 값이 이미 등록되어 있습니다. 기존 항목을 확인하세요.',
    tone: 'red',
  },
  RULE: {
    title: '허용되지 않는 작업입니다',
    hint: '데이터 규칙에 어긋나는 요청입니다. 조건을 바꾼 뒤 다시 시도하세요.',
    tone: 'red',
  },
};

const FALLBACK: CodePresentation = {
  title: '요청을 처리하지 못했습니다',
  hint: '잠시 후 다시 시도하고, 계속 실패하면 관리자에게 알리세요.',
  tone: 'red',
};

const TONE_CLASSES = {
  red: 'border-red-200 bg-red-50 text-red-700',
  amber: 'border-amber-200 bg-amber-50 text-amber-800',
} as const;

export interface ErrorBannerProps {
  /** 액션이 돌려준 error 문구 */
  message: string;
  code?: ActionErrorCode;
  onRetry?: () => void;
  onDismiss?: () => void;
  className?: string;
}

export default function ErrorBanner({
  message,
  code,
  onRetry,
  onDismiss,
  className = '',
}: ErrorBannerProps) {
  const presentation = code ? CODE_PRESENTATION[code] : FALLBACK;
  return (
    <div
      role="alert"
      className={`rounded-xl border p-4 text-sm ${TONE_CLASSES[presentation.tone]} ${className}`}
    >
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <p className="font-semibold">{presentation.title}</p>
          <p className="mt-1 break-words">{message}</p>
          <p className="mt-1 text-xs opacity-80">{presentation.hint}</p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {onRetry && (
            <button
              type="button"
              onClick={onRetry}
              className="rounded-lg border border-current px-2.5 py-1 text-xs font-semibold"
            >
              다시 시도
            </button>
          )}
          {onDismiss && (
            <button
              type="button"
              onClick={onDismiss}
              aria-label="알림 닫기"
              className="font-bold opacity-60 hover:opacity-100"
            >
              ×
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
