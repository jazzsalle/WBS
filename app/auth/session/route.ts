// 세션 쿠키 설정·삭제 라우트 (SOT §8.2 C-3, §14.1)
// localhost 사이드카 전용 — WebView(클라이언트)의 인증 세션을 서버 액션·미들웨어가
// 쓸 수 있도록 httpOnly 쿠키로 옮긴다. httpOnly라서 WebView 스크립트로 탈취할 수 없고,
// localStorage는 어느 단계에도 등장하지 않는다 (C-3).

import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { ACCESS_TOKEN_COOKIE, REFRESH_TOKEN_COOKIE } from '@/lib/auth/session';

// 사이드카는 127.0.0.1에 바인딩된다(§14.1). 웹 배포로 전환하면 secure·도메인 정책을
// 다시 설계해야 하므로, 그때까지 로컬 외 호스트는 명시적으로 거부한다.
const LOCAL_HOSTNAMES = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);

const bodySchema = z.object({
  accessToken: z.string().min(1),
  refreshToken: z.string().min(1),
});

// maxAge 없음 = 브라우저 세션 쿠키. 영속 보관은 OS 키체인이 담당하고(C-3),
// 앱 시작 시 ensureFreshSession이 재동기화한다. secure=false는 127.0.0.1 http 한정.
const COOKIE_OPTIONS = {
  httpOnly: true,
  sameSite: 'lax',
  path: '/',
  secure: false,
} as const;

function rejectNonLocal(request: NextRequest): NextResponse | null {
  if (!LOCAL_HOSTNAMES.has(request.nextUrl.hostname)) {
    return NextResponse.json(
      { error: '이 엔드포인트는 로컬 사이드카 전용입니다.' },
      { status: 403 }
    );
  }
  return null;
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  const rejected = rejectNonLocal(request);
  if (rejected) return rejected;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: '요청 본문이 JSON이 아닙니다.' }, { status: 400 });
  }
  const parsed = bodySchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: '토큰 형식이 올바르지 않습니다.' }, { status: 400 });
  }

  const res = NextResponse.json({ ok: true });
  res.cookies.set(ACCESS_TOKEN_COOKIE, parsed.data.accessToken, COOKIE_OPTIONS);
  res.cookies.set(REFRESH_TOKEN_COOKIE, parsed.data.refreshToken, COOKIE_OPTIONS);
  return res;
}

export async function DELETE(request: NextRequest): Promise<NextResponse> {
  const rejected = rejectNonLocal(request);
  if (rejected) return rejected;

  const res = NextResponse.json({ ok: true });
  res.cookies.delete(ACCESS_TOKEN_COOKIE);
  res.cookies.delete(REFRESH_TOKEN_COOKIE);
  return res;
}
