// 세션 토큰의 서버 전달 (SOT §8.2 C-2·C-3, §14.2 A-4)
// 인증 클라이언트(lib/auth/client.ts)의 세션은 메모리/키체인에 있다. Next 사이드카의
// 서버 액션·미들웨어가 같은 세션을 쓰려면 토큰을 httpOnly 쿠키로 넘겨야 한다
// (app/auth/session/route.ts가 설정·삭제를 담당).
// 쿠키는 만료시간 없는 세션 쿠키다 — 영속 보관은 키체인 몫이고(C-3), 앱 재시작 시
// ensureFreshSession이 키체인에서 복원한 세션을 다시 동기화한다.

import type { Session } from '@supabase/supabase-js';
import { getAuthClient } from './client';
import { setRealtimeAuth } from '@/lib/db/client';

export const ACCESS_TOKEN_COOKIE = 'wbs-access-token';
export const REFRESH_TOKEN_COOKIE = 'wbs-refresh-token';
export const SESSION_ROUTE = '/auth/session';

// 만료 임박 판정 여유 — 서버 액션이 전송 중에 만료되는 토큰을 들고 실패하지 않게
const EXPIRY_MARGIN_MS = 60_000;

// A-4: 토큰 갱신 실패 = 재로그인 요구. UI는 이 에러를 받으면 /login으로 보낸다.
export class ReloginRequiredError extends Error {
  constructor(message = '세션이 만료되었습니다. 다시 로그인하세요.') {
    super(message);
    this.name = 'ReloginRequiredError';
  }
}

// getSession()이 내부적으로 갱신해 버린 토큰을 놓치지 않기 위한 마지막 동기화 기록
let lastSyncedAccessToken: string | null = null;

// 로그인 성공·토큰 갱신 직후 호출 — 서버 쿠키와 Realtime 채널 인증을 함께 맞춘다
export async function syncSessionToServer(session: Session): Promise<void> {
  const res = await fetch(SESSION_ROUTE, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      accessToken: session.access_token,
      refreshToken: session.refresh_token,
    }),
  });
  if (!res.ok) {
    throw new Error(
      `세션 쿠키 동기화에 실패했습니다 (HTTP ${res.status}). 저장 기능이 동작하지 않습니다.`
    );
  }
  lastSyncedAccessToken = session.access_token;
  setRealtimeAuth(session.access_token);
}

export async function clearServerSession(): Promise<void> {
  const res = await fetch(SESSION_ROUTE, { method: 'DELETE' });
  if (!res.ok) {
    throw new Error(`세션 쿠키 삭제에 실패했습니다 (HTTP ${res.status}).`);
  }
  lastSyncedAccessToken = null;
}

// 로그아웃: 키체인/메모리 세션 파기 + 서버 쿠키 삭제.
// 원격 폐기가 실패해도 쿠키는 지운다 — 쿠키만 남으면 유령 세션이 된다.
export async function signOut(): Promise<void> {
  const { error } = await getAuthClient().auth.signOut();
  await clearServerSession();
  if (error) {
    throw new Error(`로그아웃 처리 중 오류가 발생했습니다: ${error.message}`);
  }
}

// 서버 액션 호출 전·앱 부팅 시 호출하는 단일 진입점.
// 유효한 세션을 보장하고, 쿠키가 뒤처졌으면(내부 갱신·앱 재시작) 다시 동기화한다.
// 갱신이 불가능하면 세션을 정리하고 재로그인을 요구한다 (A-4).
export async function ensureFreshSession(): Promise<Session> {
  const auth = getAuthClient().auth;

  const { data, error } = await auth.getSession();
  if (error || !data.session) {
    await discardSession();
    throw new ReloginRequiredError();
  }

  let session = data.session;
  const expiresAtMs = (session.expires_at ?? 0) * 1000;
  if (expiresAtMs - Date.now() <= EXPIRY_MARGIN_MS) {
    const refreshed = await auth.refreshSession();
    if (refreshed.error || !refreshed.data.session) {
      await discardSession();
      throw new ReloginRequiredError();
    }
    session = refreshed.data.session;
  }

  if (session.access_token !== lastSyncedAccessToken) {
    await syncSessionToServer(session);
  }
  return session;
}

// 갱신 실패 경로의 정리. 원격 폐기 실패는 여기서 중요하지 않다 — 사용자에게는
// ReloginRequiredError로 이미 알리므로 경고만 남긴다(무음 처리 아님).
async function discardSession(): Promise<void> {
  const { error } = await getAuthClient().auth.signOut({ scope: 'local' });
  if (error) {
    console.warn('[auth/session] 로컬 세션 폐기 중 경고:', error.message);
  }
  await clearServerSession();
}
