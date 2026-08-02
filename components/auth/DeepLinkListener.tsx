'use client';

// 인증 부트스트랩 + wbs:// 딥링크 수신 (SOT §7.0, §14.2 A-1·A-4, §8.2 C-3)
// app/layout.tsx에 마운트되어 앱 전체에서 한 번만 동작한다.
//  - Tauri: 키체인 storage 주입(A-4) → cold start 딥링크 확인 → 딥링크 구독 →
//    키체인 세션 복원·쿠키 동기화(ensureFreshSession)
//  - 브라우저 개발 모드: 딥링크·키체인이 없으므로 storage 주입만 하고 끝낸다.
// OAuth code 교환은 lib/auth/ 경유만 한다 — supabase-js를 직접 import하지 않는다.

import { useEffect } from 'react';
import { usePathname, useRouter } from 'next/navigation';
import { getAuthClient, setAuthTokenStorage, type AuthTokenStorage } from '@/lib/auth/client';
import {
  ReloginRequiredError,
  ensureFreshSession,
  syncSessionToServer,
} from '@/lib/auth/session';
import { isTauri } from '@/lib/tauri/env';
import { getInitialDeepLink, onDeepLink } from '@/lib/tauri/deep-link';
import { keychainDelete, keychainGet, keychainSet } from '@/lib/tauri/keychain';

const DEEP_LINK_CALLBACK_PREFIX = 'wbs://auth-callback';

// A-4/C-3: Tauri에서는 세션·PKCE verifier의 영속 보관처가 OS 키체인이다.
// keychain 래퍼는 비Tauri에서 { ok: false }를 반환하지만, 이 어댑터는 isTauri()일 때만
// 주입되므로 not-tauri 결과는 계약 위반 — 조용히 넘기지 않고 명시적으로 던진다.
function createKeychainStorage(): AuthTokenStorage {
  const mustOk = <T,>(result: { ok: true; value: T } | { ok: false; reason: string }): T => {
    if (!result.ok) {
      throw new Error(`키체인 접근 실패 (${result.reason}): Tauri 환경에서만 사용할 수 있습니다.`);
    }
    return result.value;
  };
  return {
    getItem: async (key) => mustOk(await keychainGet(key)),
    setItem: async (key, value) => {
      mustOk(await keychainSet(key, value));
    },
    removeItem: async (key) => {
      mustOk(await keychainDelete(key));
    },
  };
}

// 브라우저 개발 모드 전용. PKCE code verifier는 구글로의 전체 페이지 리다이렉트를
// 살아남아야 /auth/callback에서 교환이 가능한데, 기본 메모리 storage는 문서 전환 시
// 사라진다. C-3(키체인 보관·localStorage 금지)은 배포 형태인 Tauri 앱의 규칙이고,
// 개발 브라우저에 키체인은 없으므로 탭 종료 시 소멸하는 sessionStorage로 한정해 쓴다.
// localStorage는 어떤 경로에서도 쓰지 않는다.
function createDevSessionStorage(): AuthTokenStorage {
  return {
    getItem: (key) => window.sessionStorage.getItem(key),
    setItem: (key, value) => {
      window.sessionStorage.setItem(key, value);
    },
    removeItem: (key) => {
      window.sessionStorage.removeItem(key);
    },
  };
}

let storageInstalled = false;

// 로그인 시작·code 교환 전에 반드시 호출한다 — verifier와 세션이 같은 백엔드에 남도록.
// LoginScreen·auth/callback 페이지도 이 함수를 직접 호출한다(자식 effect가 부모보다
// 먼저 실행되므로 이 컴포넌트의 마운트에만 의존할 수 없다). 멱등.
export function bootstrapAuthStorage(): void {
  if (storageInstalled || typeof window === 'undefined') return;
  setAuthTokenStorage(isTauri() ? createKeychainStorage() : createDevSessionStorage());
  storageInstalled = true;
}

function parseCallbackParams(url: string): URLSearchParams {
  const qIndex = url.indexOf('?');
  return new URLSearchParams(qIndex >= 0 ? url.slice(qIndex + 1) : '');
}

// React 18+ dev 이중 마운트에서 code 교환(1회용)이 두 번 돌지 않도록 모듈 플래그로 막는다
let bootStarted = false;

export default function DeepLinkListener() {
  const router = useRouter();
  const pathname = usePathname();

  useEffect(() => {
    bootstrapAuthStorage();
    if (!isTauri() || bootStarted) return;
    bootStarted = true;

    let unlisten: (() => void) | null = null;

    // 딥링크 콜백 처리: code 추출 → 교환 → 서버 쿠키 동기화 → 라우팅.
    // 미승인 사용자는 '/'로 보내도 미들웨어가 /pending으로 돌린다 (§7.0).
    const handleUrls = async (urls: string[]) => {
      const url = urls.find((u) => u.startsWith(DEEP_LINK_CALLBACK_PREFIX));
      if (!url) return;
      const params = parseCallbackParams(url);

      const oauthError = params.get('error');
      if (oauthError) {
        const detail = params.get('error_description') ?? oauthError;
        console.error('[auth] OAuth 콜백 에러:', oauthError, detail);
        router.replace(`/login?error=oauth&detail=${encodeURIComponent(detail)}`);
        return;
      }

      const code = params.get('code');
      if (!code) {
        console.error('[auth] 딥링크 콜백에 code가 없습니다.');
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
        console.error('[auth] code 교환 실패:', detail);
        router.replace(`/login?error=callback&detail=${encodeURIComponent(detail)}`);
      }
    };

    void (async () => {
      // 구독 전에 도착한 cold start 딥링크를 먼저 소화한다
      try {
        const initial = await getInitialDeepLink();
        if (initial && initial.length > 0) await handleUrls(initial);
        unlisten = await onDeepLink((urls) => {
          void handleUrls(urls);
        });
      } catch (e) {
        console.error('[auth] 딥링크 구독 실패:', e);
      }

      // 앱 재시작: 키체인의 세션을 복원해 서버 쿠키를 다시 맞춘다 (A-4).
      // 세션이 없거나 갱신 불가면 재로그인 경로 — 미들웨어가 /login으로 보내므로 여기선 침묵.
      try {
        await ensureFreshSession();
        if (pathname === '/login') {
          router.replace('/');
        } else {
          router.refresh();
        }
      } catch (e) {
        if (!(e instanceof ReloginRequiredError)) {
          console.error('[auth] 세션 복원 실패:', e);
        }
      }
    })();

    return () => {
      unlisten?.();
    };
    // pathname은 마운트 시점 값만 쓰면 된다 — 재구독하면 딥링크 핸들러가 중복된다
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return null;
}
