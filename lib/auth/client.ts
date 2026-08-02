// 로그인 전용 supabase auth 클라이언트 (SOT §14.2 A-1~A-4, §8.2 C-1·C-3)
// lib/db/client.ts와 역할이 다르다 — 그쪽은 서버 액션/Realtime용이고, 이 파일은
// OAuth 로그인·세션 보관·토큰 갱신만 담당한다. 데이터 쿼리에 쓰지 않는다.
//
// PKCE 주의: signInWithOAuth가 code verifier를 이 클라이언트의 storage에 저장하고,
// 딥링크로 돌아온 code의 exchangeCodeForSession이 "같은 storage"에서 verifier를 읽는다.
// 그래서 클라이언트는 싱글턴이고, storage는 백엔드 교체가 가능한 위임 객체 하나를
// 계속 바라본다 — 백엔드를 바꿔도 클라이언트를 다시 만들 필요가 없다.

import { createClient, type SupabaseClient } from '@supabase/supabase-js';

// C-3/A-4: 세션 토큰의 영속 보관처는 OS 키체인이다. Tauri 셸이 이 인터페이스로
// 키체인 위임 구현을 주입한다. 기본값(웹 브라우저 개발)은 메모리 — 어느 경로에도
// localStorage는 없다.
export interface AuthTokenStorage {
  getItem(key: string): Promise<string | null> | string | null;
  setItem(key: string, value: string): Promise<void> | void;
  removeItem(key: string): Promise<void> | void;
}

function createMemoryStorage(): AuthTokenStorage {
  const store = new Map<string, string>();
  return {
    getItem: (key) => store.get(key) ?? null,
    setItem: (key, value) => {
      store.set(key, value);
    },
    removeItem: (key) => {
      store.delete(key);
    },
  };
}

let backend: AuthTokenStorage = createMemoryStorage();

// Tauri 부팅 시 키체인 어댑터를 주입한다. 로그인 시작(signInWithOAuth) 전에 호출해야
// code verifier와 세션이 같은 백엔드에 남는다.
export function setAuthTokenStorage(adapter: AuthTokenStorage): void {
  backend = adapter;
}

// createClient에 한 번만 넘겨지는 위임 계층 — setAuthTokenStorage로 백엔드가 바뀌어도
// 클라이언트는 항상 최신 백엔드를 본다
const delegatingStorage: AuthTokenStorage = {
  getItem: (key) => Promise.resolve(backend.getItem(key)),
  setItem: (key, value) => Promise.resolve(backend.setItem(key, value)),
  removeItem: (key) => Promise.resolve(backend.removeItem(key)),
};

let authClient: SupabaseClient | null = null;

export function getAuthClient(): SupabaseClient {
  if (!authClient) {
    const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
    const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
    if (!url || !anonKey) {
      // 에러 무음 처리 금지 — 설정 누락은 즉시 명시적으로 실패시킨다
      throw new Error(
        'NEXT_PUBLIC_SUPABASE_URL / NEXT_PUBLIC_SUPABASE_ANON_KEY 환경 변수가 없습니다. .env.local을 확인하세요.'
      );
    }
    authClient = createClient(url, anonKey, {
      auth: {
        // A-1: 시스템 브라우저 + wbs:// 딥링크 왕복 — implicit flow는 토큰이 URL에
        // 노출되므로 PKCE만 쓴다
        flowType: 'pkce',
        // persistSession: true여야 커스텀 storage가 실제로 쓰인다(false면 supabase-js가
        // 자체 메모리로 대체해 키체인 위임이 무시된다)
        persistSession: true,
        storage: delegatingStorage,
        // A-4: 갱신은 lib/auth/session.ts가 명시적으로 수행한다 — 백그라운드 타이머로
        // 갱신되면 쿠키 동기화 시점을 놓치고, 실패 시 재로그인 요구를 걸 수 없다
        autoRefreshToken: false,
        // 콜백 code는 딥링크 핸들러가 exchangeCodeForSession으로 직접 처리한다
        detectSessionInUrl: false,
      },
    });
  }
  return authClient;
}
