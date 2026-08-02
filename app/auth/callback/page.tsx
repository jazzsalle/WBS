'use client';

// 브라우저 개발 모드 OAuth 콜백 (SOT §7.0, §14.2 A-1의 폴백 경로)
// Tauri 배포에서는 wbs:// 딥링크(DeepLinkListener)가 code를 받으므로 이 페이지는
// next dev를 브라우저로 열었을 때만 쓰인다. code 수신 → exchangeCodeForSession →
// syncSessionToServer → 라우팅(미승인이면 미들웨어가 /pending으로 보낸다).
// 교환은 lib/auth/ 경유만 한다 — supabase-js를 직접 import하지 않는다.

import { Suspense, useEffect, useRef, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { getAuthClient } from '@/lib/auth/client';
import { syncSessionToServer } from '@/lib/auth/session';
import { bootstrapAuthStorage } from '@/components/auth/DeepLinkListener';

function CallbackHandler() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [failure, setFailure] = useState<string | null>(null);
  // OAuth code는 1회용 — React dev 이중 마운트에서 교환이 두 번 돌지 않게 막는다
  const ranRef = useRef(false);

  useEffect(() => {
    if (ranRef.current) return;
    ranRef.current = true;

    void (async () => {
      // code verifier를 저장한 storage(dev sessionStorage)를 교환 전에 연결한다.
      // 부모(layout)의 DeepLinkListener effect보다 자식 effect가 먼저 실행되므로 직접 호출.
      bootstrapAuthStorage();

      const oauthError = searchParams.get('error');
      if (oauthError) {
        const detail = searchParams.get('error_description') ?? oauthError;
        console.error('[auth/callback] OAuth 에러:', oauthError, detail);
        router.replace(`/login?error=oauth&detail=${encodeURIComponent(detail)}`);
        return;
      }

      const code = searchParams.get('code');
      if (!code) {
        console.error('[auth/callback] code 파라미터가 없습니다.');
        router.replace('/login?error=callback');
        return;
      }

      try {
        const { data, error } = await getAuthClient().auth.exchangeCodeForSession(code);
        if (error || !data.session) {
          throw new Error(error?.message ?? '세션을 받지 못했습니다.');
        }
        await syncSessionToServer(data.session);
        router.replace('/');
      } catch (e) {
        const detail = e instanceof Error ? e.message : String(e);
        console.error('[auth/callback] code 교환 실패:', detail);
        setFailure(detail);
        router.replace(`/login?error=callback&detail=${encodeURIComponent(detail)}`);
      }
    })();
  }, [router, searchParams]);

  return (
    <main className="flex min-h-screen items-center justify-center p-8">
      <p className="text-sm text-slate-500" role="status">
        {failure ? `로그인 처리 실패: ${failure}` : '로그인 처리 중…'}
      </p>
    </main>
  );
}

export default function AuthCallbackPage() {
  // useSearchParams는 프리렌더 시 Suspense 경계가 필요하다 (Next.js 규칙)
  return (
    <Suspense
      fallback={
        <main className="flex min-h-screen items-center justify-center p-8">
          <p className="text-sm text-slate-500">로그인 처리 중…</p>
        </main>
      }
    >
      <CallbackHandler />
    </Suspense>
  );
}
