'use client';

// 로그인 화면 (SOT §7.0, §14.2 A-1·A-2)
// 로고 + "회사 구글 계정으로 로그인" 버튼 1개. OAuth 시작은 lib/auth/client.ts 경유 —
// supabase-js를 직접 import하지 않는다.
//  - Tauri(A-1): WebView 안 구글 로그인은 차단되므로 시스템 브라우저를 열고,
//    콜백은 wbs://auth-callback 딥링크로 받는다(DeepLinkListener가 교환).
//  - 브라우저 개발 모드: 같은 탭 리다이렉트, 콜백은 /auth/callback 페이지가 받는다.

import { useState } from 'react';
import { getAuthClient } from '@/lib/auth/client';
import { isTauri } from '@/lib/tauri/env';
import { bootstrapAuthStorage } from './DeepLinkListener';

// A-2: hd는 구글 계정 선택 화면을 회사 도메인으로 좁히는 편의 기능일 뿐이다.
// 보안 검증은 서버(미들웨어·가드)의 ALLOWED_EMAIL_DOMAIN 재검증이 담당하므로,
// 클라이언트 노출용 env가 없으면 hd 없이 진행해도 안전하다.
const HD_DOMAIN = process.env.NEXT_PUBLIC_ALLOWED_EMAIL_DOMAIN;

// A-1: 공식 opener 플러그인 커맨드를 직접 invoke한다. JS 래퍼 패키지 없이 동작하지만
// Rust 셸에 tauri-plugin-opener 등록 + opener 권한이 있어야 한다 — 셸 태스크에서 연결.
// 실패하면 아래 catch가 명시적 에러로 표시한다(무음 처리 금지).
async function openSystemBrowser(url: string): Promise<void> {
  const { invoke } = await import('@tauri-apps/api/core');
  await invoke('plugin:opener|open_url', { url });
}

// 미들웨어(?error=domain)·콜백 흐름이 넘기는 에러 코드의 사용자 메시지
function messageForErrorCode(code: string, detail: string | null): string {
  switch (code) {
    case 'domain':
      return HD_DOMAIN
        ? `회사 도메인(@${HD_DOMAIN}) 계정만 사용할 수 있습니다. 회사 구글 계정으로 다시 로그인하세요.`
        : '허용된 회사 도메인 계정이 아닙니다. 회사 구글 계정으로 다시 로그인하세요.';
    case 'oauth':
      return `구글 로그인이 완료되지 않았습니다.${detail ? ` (${detail})` : ''}`;
    case 'callback':
      return `로그인 처리 중 오류가 발생했습니다. 다시 시도하세요.${detail ? ` (${detail})` : ''}`;
    default:
      return `로그인에 실패했습니다.${detail ? ` (${detail})` : ''}`;
  }
}

interface LoginScreenProps {
  errorCode: string | null;
  errorDetail: string | null;
}

export default function LoginScreen({ errorCode, errorDetail }: LoginScreenProps) {
  const [busy, setBusy] = useState(false);
  // Tauri: 시스템 브라우저로 넘어간 뒤 딥링크를 기다리는 상태
  const [waitingExternal, setWaitingExternal] = useState(false);
  const [localError, setLocalError] = useState<string | null>(null);

  const error =
    localError ?? (errorCode ? messageForErrorCode(errorCode, errorDetail) : null);

  const handleLogin = async () => {
    setBusy(true);
    setLocalError(null);
    try {
      // code verifier가 세션과 같은 storage(키체인/dev sessionStorage)에 남도록 먼저 주입
      bootstrapAuthStorage();
      const tauri = isTauri();
      const redirectTo = tauri
        ? 'wbs://auth-callback'
        : `${window.location.origin}/auth/callback`;

      const { data, error: oauthError } = await getAuthClient().auth.signInWithOAuth({
        provider: 'google',
        options: {
          redirectTo,
          ...(HD_DOMAIN ? { queryParams: { hd: HD_DOMAIN } } : {}),
          // Tauri에서는 WebView가 아니라 시스템 브라우저가 URL을 열어야 한다 (A-1)
          skipBrowserRedirect: tauri,
        },
      });
      if (oauthError) throw new Error(oauthError.message);

      if (tauri) {
        if (!data?.url) throw new Error('OAuth 인증 URL을 받지 못했습니다.');
        await openSystemBrowser(data.url);
        setWaitingExternal(true);
      }
      // 브라우저 개발 모드는 이 시점에 전체 페이지가 구글로 이동한다
    } catch (e) {
      setLocalError(
        `로그인을 시작하지 못했습니다: ${e instanceof Error ? e.message : String(e)}`
      );
      setWaitingExternal(false);
    } finally {
      setBusy(false);
    }
  };

  return (
    <main className="flex min-h-screen items-center justify-center p-8">
      <div className="w-full max-w-sm rounded-2xl border border-grey-200 bg-surface p-8 shadow-sm">
        {/* 로고 */}
        <div className="mb-8 text-center">
          <div className="mx-auto mb-3 flex h-14 w-14 items-center justify-center rounded-xl bg-grey-900 text-xl font-bold text-surface">
            R&D
          </div>
          <h1 className="text-xl font-bold">R&D 과제 관리</h1>
          <p className="mt-1 text-sm text-grey-500">국가 R&D 과제 WBS·목표·예산 관리 도구</p>
        </div>

        {error && (
          <p
            role="alert"
            className="mb-4 rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-700"
          >
            {error}
          </p>
        )}

        {waitingExternal ? (
          <div className="text-center">
            <p className="text-sm text-grey-600">
              브라우저에서 구글 로그인을 계속하세요. 완료되면 앱으로 자동 복귀합니다.
            </p>
            <button
              type="button"
              onClick={handleLogin}
              disabled={busy}
              className="mt-4 text-sm text-grey-500 underline hover:text-grey-700"
            >
              브라우저가 열리지 않았나요? 다시 시도
            </button>
          </div>
        ) : (
          <button
            type="button"
            onClick={handleLogin}
            disabled={busy}
            className="w-full rounded-lg bg-grey-900 px-4 py-3 text-sm font-semibold text-surface transition hover:bg-grey-700 disabled:opacity-50"
          >
            {busy ? '로그인 준비 중…' : '회사 구글 계정으로 로그인'}
          </button>
        )}
      </div>
    </main>
  );
}
