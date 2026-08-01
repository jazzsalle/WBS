// Milestone 리포지토리 (SOT §5.7, §8.4, §8.6)
// UI·서버 액션은 supabase를 직접 부르지 않고 이 모듈을 거친다.
// 클라이언트는 호출자가 주입한다 — 서버 액션은 createServerClient(token), 테스트는 목/로컬.

import type { PostgrestError, SupabaseClient } from '@supabase/supabase-js';
import { z } from 'zod';
import type { Milestone } from '@/types';
import { milestoneRowSchema } from './schema';
import { appToDb, dbToApp } from './mapper';
import { ConflictError, NotFoundError, StaleDataError, ValidationError } from './errors';

// N-4 공통 컬럼은 DB(트리거)와 서버 액션이 채운다 — 입력에서 제외
type BaseFieldKeys = 'id' | 'createdAt' | 'updatedAt' | 'version' | 'createdBy' | 'updatedBy';

export type MilestoneInput = Omit<Milestone, BaseFieldKeys>;
export type MilestonePatch = Partial<MilestoneInput>;

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
    console.error('[db] milestones 응답 스키마 검증 실패:', result.error.issues);
    throw new ValidationError('저장소 응답이 기대 스키마와 다릅니다. 앱과 DB 버전을 확인하세요.');
  }
  return result.data;
}

// 0행 갱신의 원인 구분: 행이 없으면 NotFound, 있으면 version 불일치(§8.4).
// O-3: 최신 updated_by를 담아 "OO님이 먼저 수정했습니다"를 표시할 수 있게 한다.
async function throwStaleOrNotFound(client: SupabaseClient, id: string): Promise<never> {
  const { data, error } = await client
    .from('milestones')
    .select('updated_by')
    .eq('id', id)
    .maybeSingle();
  if (error) throwDbError(error);
  if (!data) throw new NotFoundError('마일스톤을 찾을 수 없습니다.');
  throw new StaleDataError(parseRow(z.object({ updated_by: z.uuid().nullable() }), data).updated_by);
}

function toMilestone(row: unknown): Milestone {
  return dbToApp<Milestone>(parseRow(milestoneRowSchema, row));
}

// ─── CRUD ────────────────────────────────────────────────────

export async function listMilestones(
  client: SupabaseClient,
  projectId: string
): Promise<Milestone[]> {
  const { data, error } = await client
    .from('milestones')
    .select('*')
    .eq('project_id', projectId)
    .order('date', { ascending: true })
    .order('created_at', { ascending: true }); // 같은 날짜의 순서를 결정적으로
  if (error) throwDbError(error);
  if (!data) throw new Error('[db] milestones 조회 응답이 비어 있습니다.');
  return data.map(toMilestone);
}

export async function getMilestoneById(client: SupabaseClient, id: string): Promise<Milestone> {
  const { data, error } = await client.from('milestones').select('*').eq('id', id).maybeSingle();
  if (error) throwDbError(error);
  if (!data) throw new NotFoundError('마일스톤을 찾을 수 없습니다.');
  return toMilestone(data);
}

export async function createMilestone(
  client: SupabaseClient,
  input: MilestoneInput,
  createdBy: string | null
): Promise<Milestone> {
  const { data, error } = await client
    .from('milestones')
    .insert({ ...appToDb(input), created_by: createdBy, updated_by: createdBy })
    .select()
    .single();
  if (error) throwDbError(error);
  return toMilestone(data);
}

// SA-2: expectedVersion이 넘어오면 낙관적 잠금(§8.4 O-1), 생략하면 마지막 저장 우선(O-2)
export async function updateMilestone(
  client: SupabaseClient,
  id: string,
  patch: MilestonePatch,
  updatedBy: string | null,
  expectedVersion?: number
): Promise<Milestone> {
  let query = client
    .from('milestones')
    .update({ ...appToDb(patch), updated_by: updatedBy })
    .eq('id', id);
  if (expectedVersion !== undefined) query = query.eq('version', expectedVersion);
  const { data, error } = await query.select().maybeSingle();
  if (error) throwDbError(error);
  if (!data) return throwStaleOrNotFound(client, id);
  return toMilestone(data);
}

export async function removeMilestone(client: SupabaseClient, id: string): Promise<void> {
  // select를 붙여 0행 삭제(이미 지워짐)를 무음으로 넘기지 않는다
  const { data, error } = await client.from('milestones').delete().eq('id', id).select('id');
  if (error) throwDbError(error);
  if (!data || data.length === 0) throw new NotFoundError('마일스톤을 찾을 수 없습니다.');
}
