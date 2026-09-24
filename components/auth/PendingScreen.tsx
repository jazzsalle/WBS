'use client';

// 승인 대기 화면 (SOT §7.0)
// "관리자 승인을 기다리고 있습니다" + 내 이메일 + 새로고침 버튼.
// active=true 전환 감지는 30초 폴링을 쓴다(§7.0이 Realtime 구독 또는 30초 폴링을 허용).
// 폴링을 택한 이유: 미승인 상태에서는 클라이언트 Realtime 채널에 세션 토큰 주입이
// 페이지 새로고침 후 보장되지 않지만, getCurrentUser 액션은 httpOnly 쿠키 기반이라
// Tauri·브라우저 어느 경로에서든 항상 동작한다.

import { useCallback, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { getCurrentUser } from '@/actions/auth';

const POLL_INTERVAL_MS = 30_000;

interface PendingScreenProps {
  email: string;
}

export default function PendingScreen({ email }: PendingScreenProps) {
  const router = useRouter();
  const [checking, setChecking] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  // manual=true는 새로고침 버튼 — 아직 대기 중이라는 피드백을 남긴다
  const check = useCallback(
    async (manual: boolean) => {
      setChecking(true);
      if (manual) setNotice(null);
      try {
        const res = await getCurrentUser();
        if (!res.ok) {
          // 세션 만료(A-4) 등 — 미들웨어와 같은 결론으로 로그인부터 다시
          if (res.code === 'AUTH') {
            router.replace('/login');
            return;
          }
          setNotice(`상태 확인에 실패했습니다: ${res.error}`);
          return;
        }
        if (res.data.active) {
          router.replace('/');
          return;
        }
        if (manual) setNotice('아직 승인되지 않았습니다. 잠시 후 다시 확인해 주세요.');
      } finally {
        setChecking(false);
      }
    },
    [router]
  );

  useEffect(() => {
    const id = setInterval(() => {
      void check(false);
    }, POLL_INTERVAL_MS);
    return () => clearInterval(id);
  }, [check]);

  return (
    <main className="flex min-h-screen items-center justify-center p-8">
      <div className="w-full max-w-sm rounded-2xl border border-grey-200 bg-surface p-8 text-center shadow-sm">
        <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-full bg-orange-100">
          <svg
            className="h-6 w-6 text-orange-600"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            aria-hidden="true"
          >
            <circle cx="12" cy="12" r="9" />
            <path d="M12 7v5l3 3" />
          </svg>
        </div>
        <h1 className="text-lg font-bold">관리자 승인을 기다리고 있습니다</h1>
        <p className="mt-2 text-sm text-grey-600">
          기존 사용자가 설정 화면에서 승인하면 자동으로 이동합니다.
        </p>
        <p className="mt-4 rounded-lg bg-grey-100 px-3 py-2 text-sm font-medium text-grey-700">
          {email}
        </p>

        {notice && (
          <p role="status" className="mt-4 text-sm text-grey-500">
            {notice}
          </p>
        )}

        <button
          type="button"
          onClick={() => void check(true)}
          disabled={checking}
          className="mt-6 w-full rounded-lg border border-grey-300 px-4 py-2.5 text-sm font-semibold text-grey-700 transition hover:bg-grey-50 disabled:opacity-50"
        >
          {checking ? '확인 중…' : '새로고침'}
        </button>
      </div>
    </main>
  );
}
