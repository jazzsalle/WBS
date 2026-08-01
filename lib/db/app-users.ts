// app_users 리포지토리 (SOT §14.2, §14.3 RLS-2, §9 SA-1)
// 행 생성은 handle_new_user 트리거(A-3), 승인·비활성화는 security definer RPC(A-5)만 가능 —
// 여기서는 INSERT를 하지 않는다. UPDATE는 본인 행의 name·member_id·last_seen_at만
// (id·email·active는 app_users_guard 트리거가 거부한다).
// 클라이언트는 호출자가 주입한다 — 테스트에서 service_role 클라이언트를 넣을 수 있게 (C-1 예외).

import type { PostgrestError, SupabaseClient } from '@supabase/supabase-js';
import type { AppUser } from '@/types';
import { appUserRowSchema } from './schema';
import { dbToApp } from './mapper';
import {
  AuthError,
  ConflictError,
  NotFoundError,
  OfflineError,
  RuleViolationError,
  ValidationError,
} from './errors';

const SCHEMA_MISMATCH_MESSAGE =
  'DB 응답이 앱이 기대하는 형식과 다릅니다. 앱과 DB 마이그레이션 버전을 확인하세요.';

function raiseDbError(error: PostgrestError): never {
  if (error.code === '23505') throw new ConflictError();
  if (error.code === 'P0001') throw new RuleViolationError(error.message); // '자기 자신은 승인할 수 없습니다' 등
  if (error.code === 'PGRST301') throw new AuthError();
  if (/fetch failed|failed to fetch/i.test(error.message)) throw new OfflineError();
  throw new Error(error.message);
}

function parseAppUserRow(row: unknown): AppUser {
  const parsed = appUserRowSchema.safeParse(row);
  if (!parsed.success) {
    console.error('[db/app-users] row 검증 실패:', parsed.error);
    throw new ValidationError(SCHEMA_MISMATCH_MESSAGE);
  }
  return dbToApp<AppUser>(parsed.data);
}

// SA-1의 세션 확인용. 토큰을 Auth 서버에서 검증한 뒤 프로필을 돌려준다.
// active=false여도 프로필은 반환한다 — 승인 대기 화면(§7.0)이 본인 행을 읽어야 하므로
// 데이터 접근 차단(active 확인)은 호출한 액션의 책임이다 (SA-1).
// lastSeenAt은 SA-1 명세대로 이 확인 시 하루 1회만 갱신한다.
export async function getCurrentUser(
  client: SupabaseClient,
  accessToken: string
): Promise<AppUser> {
  const { data: authData, error: authError } = await client.auth.getUser(accessToken);
  if (authError || !authData.user) {
    throw new AuthError();
  }

  const { data, error } = await client
    .from('app_users')
    .select('*')
    .eq('id', authData.user.id)
    .maybeSingle();
  if (error) raiseDbError(error);
  if (!data) {
    // handle_new_user 트리거가 만들었어야 할 행이 없다 — 재로그인으로 부트스트랩을 다시 태운다
    throw new AuthError('사용자 프로필이 없습니다. 다시 로그인하세요.');
  }
  const user = parseAppUserRow(data);

  const today = new Date().toISOString().slice(0, 10);
  if (user.lastSeenAt.slice(0, 10) !== today) {
    const touched = await client
      .from('app_users')
      .update({ last_seen_at: new Date().toISOString() })
      .eq('id', user.id)
      .select()
      .maybeSingle();
    if (touched.error) raiseDbError(touched.error);
    if (touched.data) return parseAppUserRow(touched.data);
  }
  return user;
}

// 설정 화면 사용자 관리(§7.14)용. 승인 대기자 상단 배치 등 정렬·필터는 UI 몫.
// RLS-2: 미승인 사용자는 본인 행만 보인다 — 그것도 유효한 결과이므로 그대로 반환한다.
export async function listAppUsers(client: SupabaseClient): Promise<AppUser[]> {
  const { data, error } = await client
    .from('app_users')
    .select('*')
    .order('created_at', { ascending: true });
  if (error) raiseDbError(error);
  return data.map(parseAppUserRow);
}

export async function getAppUserById(client: SupabaseClient, id: string): Promise<AppUser> {
  const { data, error } = await client.from('app_users').select('*').eq('id', id).maybeSingle();
  if (error) raiseDbError(error);
  if (!data) throw new NotFoundError('사용자를 찾을 수 없습니다.');
  return parseAppUserRow(data);
}

// A-5: 누구나(active 사용자) 대기자를 승인할 수 있다. 자기 자신 승인 불가는 RPC가 거부한다.
export async function approveUser(client: SupabaseClient, userId: string): Promise<void> {
  const { error } = await client.rpc('approve_user', { p_user_id: userId });
  if (error) raiseDbError(error);
}

// 자기 자신 비활성화 불가(마지막 사용자 잠금 사고 방지)는 RPC가 거부한다
export async function deactivateUser(client: SupabaseClient, userId: string): Promise<void> {
  const { error } = await client.rpc('deactivate_user', { p_user_id: userId });
  if (error) raiseDbError(error);
}

// RLS-2: 본인 행만, name·member_id만. 다른 컬럼은 타입에서 막고 트리거가 최후 방어한다.
export interface AppUserProfilePatch {
  name?: string;
  memberId?: string | null;
}

export async function updateProfile(
  client: SupabaseClient,
  userId: string,
  patch: AppUserProfilePatch
): Promise<AppUser> {
  const payload: Record<string, unknown> = {};
  if (patch.name !== undefined) payload.name = patch.name;
  if (patch.memberId !== undefined) payload.member_id = patch.memberId;
  if (Object.keys(payload).length === 0) {
    throw new ValidationError('변경할 내용이 없습니다.');
  }
  const { data, error } = await client
    .from('app_users')
    .update(payload)
    .eq('id', userId)
    .select()
    .maybeSingle();
  if (error) raiseDbError(error);
  // RLS가 남의 행 갱신을 0행으로 만든다 — 조용히 성공처럼 넘기지 않는다
  if (!data) throw new NotFoundError('본인 프로필만 수정할 수 있습니다.');
  return parseAppUserRow(data);
}
