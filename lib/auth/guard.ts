// 서버 액션 인증 가드 (SOT §9 SA-1, §14.2 A-2, §7.0)
// 모든 서버 액션은 시작 시 여기를 거친다 — RLS만 믿지 않는다 (SA-1, RLS-3).

import type { SupabaseClient } from '@supabase/supabase-js';
import type { AppUser } from '@/types';
import { createServerClient } from '@/lib/db/client';
import * as appUsers from '@/lib/db/app-users';
import { AuthError } from '@/lib/db/errors';
import { ACCESS_TOKEN_COOKIE } from './session';

// A-2: 허용 도메인은 env로만 관리한다 — 하드코딩 금지. 미설정을 조용한 전체 허용으로
// 넘기지 않고 명시적으로 실패시킨다.
export function getAllowedEmailDomain(): string {
  const domain = process.env.ALLOWED_EMAIL_DOMAIN?.trim().replace(/^@/, '').toLowerCase();
  if (!domain) {
    throw new Error(
      'ALLOWED_EMAIL_DOMAIN 환경 변수가 없습니다. .env.local에 회사 이메일 도메인을 설정하세요.'
    );
  }
  return domain;
}

// A-2 서버 측 재검증용 순수 헬퍼 — 구글 OAuth의 hd 파라미터는 편의 기능일 뿐
// 보안 수단이 아니므로 발급된 세션의 이메일을 여기로 반드시 다시 거른다.
// 마지막 '@' 뒤 전체가 정확히 일치해야 한다 — evil-unes.co.kr, mail.unes.co.kr 류의
// 접미사·서브도메인 위장을 걸러낸다.
export function isAllowedEmailDomain(email: string, allowedDomain: string): boolean {
  const at = email.lastIndexOf('@');
  if (at < 0) return false;
  const domain = email.slice(at + 1).trim().toLowerCase();
  if (!domain) return false;
  return domain === allowedDomain.trim().replace(/^@/, '').toLowerCase();
}

export interface AuthContext {
  user: AppUser;
  /** 사용자 세션 토큰이 주입된 서버 클라이언트 — 리포지토리 호출에 그대로 넘긴다 */
  client: SupabaseClient;
  accessToken: string;
}

// 세션 + 도메인(A-2)만 확인하고 active는 보지 않는다 — 승인 대기 화면(§7.0 /pending)이
// 본인 프로필을 읽어야 하기 때문이다. 데이터를 다루는 액션은 requireApprovedUser를 쓴다.
export async function requireSession(): Promise<AuthContext> {
  // next/headers는 요청 컨텍스트 밖(vitest 단위 테스트)에서 문제를 일으킬 수 있어
  // 순수 헬퍼(isAllowedEmailDomain)와 분리되도록 지연 로드한다
  const { cookies } = await import('next/headers');
  const accessToken = (await cookies()).get(ACCESS_TOKEN_COOKIE)?.value;
  if (!accessToken) {
    throw new AuthError('로그인이 필요합니다.');
  }

  const client = createServerClient(accessToken);
  // SA-1: 토큰 검증 + 프로필 조회 + lastSeenAt 하루 1회 갱신은 리포지토리가 수행한다
  const user = await appUsers.getCurrentUser(client, accessToken);

  const allowed = getAllowedEmailDomain();
  if (!isAllowedEmailDomain(user.email, allowed)) {
    throw new AuthError(`회사 도메인(@${allowed}) 계정만 사용할 수 있습니다.`);
  }

  return { user, client, accessToken };
}

// SA-1: 세션 + app_users.active 확인. 데이터 접근 액션의 표준 진입점.
export async function requireApprovedUser(): Promise<AuthContext> {
  const ctx = await requireSession();
  if (!ctx.user.active) {
    throw new AuthError('관리자 승인 대기 중입니다. 승인 후 이용할 수 있습니다.');
  }
  return ctx;
}
