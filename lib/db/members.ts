// Member(참여인력) 리포지토리 (SOT §5.11, §6.6 H-9, §8.4, §8.6)
// H-9: 삭제 대신 active=false 권장. 삭제 시 8곳의 참조 정리는 스키마가 보장한다 —
// 조인 테이블은 FK cascade(N-2), 단일 참조는 set null(N-8). delete_member RPC는 Phase 2 범위.
// 클라이언트는 호출자가 주입한다 — 서버 액션은 createServerClient(token), 테스트는 목/로컬.

import type { PostgrestError, SupabaseClient } from '@supabase/supabase-js';
import { z } from 'zod';
import type { Member } from '@/types';
import { memberRowSchema } from './schema';
import { appToDb, dbToApp } from './mapper';
import { ConflictError, NotFoundError, StaleDataError, ValidationError } from './errors';

// N-4 공통 컬럼은 DB(트리거)와 서버 액션이 채운다 — 입력에서 제외
type BaseFieldKeys = 'id' | 'createdAt' | 'updatedAt' | 'version' | 'createdBy' | 'updatedBy';

export type MemberInput = Omit<Member, BaseFieldKeys>;
export type MemberPatch = Partial<MemberInput>;

// ─── 파일 내부 헬퍼 ──────────────────────────────────────────

// 23505(유니크 충돌)만 의미를 부여하고, 나머지는 일반 Error로 던져
// toActionFailure가 테이블·제약명 노출을 막게 한다 (SA-4). 무음 처리는 없다.
function throwDbError(error: PostgrestError): never {
  if (error.code === '23505') throw new ConflictError();
  throw new Error(`[db] ${error.code}: ${error.message}`);
}

// DB 응답 검증 실패 = 스키마 드리프트 신호. 조용히 넘기지 않는다 (§8.6, 절대 규칙 5).
function parseRow<T>(schema: z.ZodType<T>, row: unknown): T {
  const result = schema.safeParse(row);
  if (!result.success) {
    console.error('[db] members 응답 스키마 검증 실패:', result.error.issues);
    throw new ValidationError('저장소 응답이 기대 스키마와 다릅니다. 앱과 DB 버전을 확인하세요.');
  }
  return result.data;
}

// 0행 갱신의 원인 구분: 행이 없으면 NotFound, 있으면 version 불일치(§8.4).
// O-3: 최신 updated_by를 담아 "OO님이 먼저 수정했습니다"를 표시할 수 있게 한다.
async function throwStaleOrNotFound(client: SupabaseClient, id: string): Promise<never> {
  const { data, error } = await client
    .from('members')
    .select('updated_by')
    .eq('id', id)
    .maybeSingle();
  if (error) throwDbError(error);
  if (!data) throw new NotFoundError('참여인력을 찾을 수 없습니다.');
  throw new StaleDataError(parseRow(z.object({ updated_by: z.uuid().nullable() }), data).updated_by);
}

function toMember(row: unknown): Member {
  return dbToApp<Member>(parseRow(memberRowSchema, row));
}

// ─── CRUD ────────────────────────────────────────────────────

export async function listMembers(client: SupabaseClient, projectId: string): Promise<Member[]> {
  const { data, error } = await client
    .from('members')
    .select('*')
    .eq('project_id', projectId)
    .order('sort_order', { ascending: true });
  if (error) throwDbError(error);
  if (!data) throw new Error('[db] members 조회 응답이 비어 있습니다.');
  return data.map(toMember);
}

export async function getMemberById(client: SupabaseClient, id: string): Promise<Member> {
  const { data, error } = await client.from('members').select('*').eq('id', id).maybeSingle();
  if (error) throwDbError(error);
  if (!data) throw new NotFoundError('참여인력을 찾을 수 없습니다.');
  return toMember(data);
}

export async function createMember(
  client: SupabaseClient,
  input: MemberInput,
  createdBy: string | null
): Promise<Member> {
  const { data, error } = await client
    .from('members')
    .insert({ ...appToDb(input), created_by: createdBy, updated_by: createdBy })
    .select()
    .single();
  if (error) throwDbError(error);
  return toMember(data);
}

// SA-2: expectedVersion이 넘어오면 낙관적 잠금(§8.4 O-1), 생략하면 마지막 저장 우선(O-2)
export async function updateMember(
  client: SupabaseClient,
  id: string,
  patch: MemberPatch,
  updatedBy: string | null,
  expectedVersion?: number
): Promise<Member> {
  let query = client
    .from('members')
    .update({ ...appToDb(patch), updated_by: updatedBy })
    .eq('id', id);
  if (expectedVersion !== undefined) query = query.eq('version', expectedVersion);
  const { data, error } = await query.select().maybeSingle();
  if (error) throwDbError(error);
  if (!data) return throwStaleOrNotFound(client, id);
  return toMember(data);
}

// 단순 delete — H-9의 참조 8곳 정리는 스키마(cascade/set null)가 보장한다.
// 여러 테이블을 한 트랜잭션으로 묶는 delete_member RPC는 Phase 2에서 붙는다.
export async function removeMember(client: SupabaseClient, id: string): Promise<void> {
  // select를 붙여 0행 삭제(이미 지워짐)를 무음으로 넘기지 않는다
  const { data, error } = await client.from('members').delete().eq('id', id).select('id');
  if (error) throwDbError(error);
  if (!data || data.length === 0) throw new NotFoundError('참여인력을 찾을 수 없습니다.');
}
