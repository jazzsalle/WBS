// 라우팅 가드 (SOT §7.0): 비인증 → /login, 인증했으나 미승인 → /pending, 승인 → 요청 경로.
// 여기는 화면 흐름 제어일 뿐이다 — 데이터 보호는 RLS(§14.3)와 서버 액션 가드(SA-1)가 한다.

import { NextRequest, NextResponse } from 'next/server';
import type { AppUser } from '@/types';
import { createServerClient } from '@/lib/db/client';
import * as appUsers from '@/lib/db/app-users';
import { AuthError } from '@/lib/db/errors';
import { getAllowedEmailDomain, isAllowedEmailDomain } from '@/lib/auth/guard';
import { ACCESS_TOKEN_COOKIE, REFRESH_TOKEN_COOKIE } from '@/lib/auth/session';

function redirectTo(request: NextRequest, pathname: string, search = ''): NextResponse {
  const url = request.nextUrl.clone();
  url.pathname = pathname;
  url.search = search;
  return NextResponse.redirect(url);
}

// 무효 토큰 쿠키를 남겨두면 /login 리다이렉트가 무한 반복된다 — 응답에서 즉시 지운다
function clearSessionCookies(res: NextResponse): NextResponse {
  res.cookies.delete(ACCESS_TOKEN_COOKIE);
  res.cookies.delete(REFRESH_TOKEN_COOKIE);
  return res;
}

export async function middleware(request: NextRequest): Promise<NextResponse> {
  const { pathname } = request.nextUrl;
  const accessToken = request.cookies.get(ACCESS_TOKEN_COOKIE)?.value;

  if (!accessToken) {
    return pathname === '/login' ? NextResponse.next() : redirectTo(request, '/login');
  }

  let user: AppUser;
  try {
    // 리포지토리 경유(C-2) — 토큰 검증과 프로필 조회를 한 번에. lastSeenAt 하루 1회
    // 갱신(SA-1)도 여기서 함께 일어난다.
    user = await appUsers.getCurrentUser(createServerClient(accessToken), accessToken);
  } catch (e) {
    // 만료·무효 토큰은 정상 경로다(A-4: 재로그인 요구). 그 외 실패는 원인을 남긴다.
    if (!(e instanceof AuthError)) {
      console.error('[middleware] 사용자 확인 실패:', e);
    }
    const res =
      pathname === '/login' ? NextResponse.next() : redirectTo(request, '/login');
    return clearSessionCookies(res);
  }

  // A-2: hd 파라미터는 편의 기능일 뿐 — 세션 이메일을 서버에서 반드시 재검증한다.
  // 불일치는 §7.0대로 /login에서 명시적 에러로 표시한다.
  if (!isAllowedEmailDomain(user.email, getAllowedEmailDomain())) {
    return clearSessionCookies(redirectTo(request, '/login', '?error=domain'));
  }

  if (!user.active) {
    return pathname === '/pending' ? NextResponse.next() : redirectTo(request, '/pending');
  }

  // 승인된 사용자가 로그인·대기 화면에 머물 이유는 없다
  if (pathname === '/login' || pathname === '/pending') {
    return redirectTo(request, '/');
  }
  return NextResponse.next();
}

export const config = {
  // /auth/session·/auth/callback은 쿠키가 생기기 전에 호출되므로 가드 대상에서 제외한다
  // (콜백을 가드하면 OAuth ?code가 /login 리다이렉트로 유실된다).
  // 정적 자산도 제외해 요청마다의 Auth 서버 왕복을 줄인다.
  matcher: ['/((?!auth/session|auth/callback|_next/static|_next/image|favicon.ico).*)'],
};
