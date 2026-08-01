// supabase 클라이언트 생성 (SOT §8.2)
// C-1: anon 키 + 사용자 세션 + RLS만 쓴다. 관리자 키는 앱 코드에 절대 넣지 않는다 —
//      데스크톱 앱은 사용자 손에 있는 코드라서 키가 그대로 노출된다.
// C-2: 쓰기는 전부 서버 액션(서버용 클라이언트) 경유. 브라우저용은 Realtime 구독 전용이다.

import { createClient, type SupabaseClient } from '@supabase/supabase-js';

function requireEnv(): { url: string; anonKey: string } {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !anonKey) {
    // 에러 무음 처리 금지 — 설정 누락은 즉시 명시적으로 실패시킨다
    throw new Error(
      'NEXT_PUBLIC_SUPABASE_URL / NEXT_PUBLIC_SUPABASE_ANON_KEY 환경 변수가 없습니다. .env.local을 확인하세요.'
    );
  }
  return { url, anonKey };
}

// 서버 액션·RSC용. 요청마다 새로 만들고 사용자 세션의 access token을 주입한다.
// 세션 보관·갱신은 supabase-js에 맡기지 않는다 — 토큰은 OS 키체인에 있다 (C-3, Phase 0.5).
export function createServerClient(accessToken?: string): SupabaseClient {
  const { url, anonKey } = requireEnv();
  return createClient(url, anonKey, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
      detectSessionInUrl: false,
    },
    global: accessToken
      ? { headers: { Authorization: `Bearer ${accessToken}` } }
      : undefined,
  });
}

// 브라우저(클라이언트 컴포넌트)용 — Realtime 구독 전용 (C-2 예외, §8.5).
// C-3: 세션 토큰을 localStorage에 두지 않으므로 persistSession을 끈다.
// RLS가 걸린 테이블의 이벤트를 받으려면 구독 전에 setRealtimeAuth로 토큰을 넣어야 한다.
let browserClient: SupabaseClient | null = null;

export function getBrowserClient(): SupabaseClient {
  if (!browserClient) {
    const { url, anonKey } = requireEnv();
    browserClient = createClient(url, anonKey, {
      auth: {
        persistSession: false,
        autoRefreshToken: false,
        detectSessionInUrl: false,
      },
    });
  }
  return browserClient;
}

// 로그인·토큰 갱신 시(Phase 0.5) 호출해 Realtime 채널 인증을 최신으로 유지한다
export function setRealtimeAuth(accessToken: string): void {
  getBrowserClient().realtime.setAuth(accessToken);
}
