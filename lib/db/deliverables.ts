// Deliverable(정량적 성과목표) 리포지토리 (SOT §5.8, §5.1 N-1/N-2, §8.4, §8.6)
// DB에는 deliverable_achievements(N-1)·achievement_members(N-2)로 정규화되어 있고,
// 조회 시 §5.8의 앱 형태(achievements 배열 + 각 memberIds)로 조립해 반환한다.
// 클라이언트는 호출자가 주입한다 — 서버 액션은 createServerClient(token), 테스트는 목/로컬.

import type { PostgrestError, SupabaseClient } from '@supabase/supabase-js';
import { z } from 'zod';
import type { Deliverable, DeliverableAchievement } from '@/types';
import { deliverableAchievementRowSchema, deliverableRowSchema } from './schema';
import { appToDb, dbToApp } from './mapper';
import {
  ConflictError,
  NotFoundError,
  RuleViolationError,
  StaleDataError,
  ValidationError,
} from './errors';

// N-4 공통 컬럼은 DB(트리거)와 서버 액션이 채운다 — 입력에서 제외.
// achievements는 자식 테이블이므로 add/update/deleteAchievement로만 조작한다.
type BaseFieldKeys = 'id' | 'createdAt' | 'updatedAt' | 'version' | 'createdBy' | 'updatedBy';

export type DeliverableInput = Omit<Deliverable, BaseFieldKeys | 'achievements'>;
export type DeliverablePatch = Partial<DeliverableInput>;

// version은 DB 트리거가 올린다(N-4) — 입력으로 받지 않고 조회에만 실어 보낸다(§5.8, O-1)
export type AchievementInput = Omit<DeliverableAchievement, 'id' | 'version'>;
export type AchievementPatch = Partial<AchievementInput>;

// PostgREST 임베드 응답 검증용 — schema.ts의 row 스키마를 중첩 형태로 확장
const achievementWithMembersRowSchema = deliverableAchievementRowSchema.extend({
  achievement_members: z.array(z.object({ member_id: z.uuid() })),
});
const deliverableWithChildrenRowSchema = deliverableRowSchema.extend({
  deliverable_achievements: z.array(achievementWithMembersRowSchema),
});

// export인 이유: 전 과제 벌크 조회(lib/db/dashboard.ts)가 같은 문자열을 써야 임베드 모양이 갈라지지 않는다
export const DELIVERABLE_SELECT = '*, deliverable_achievements(*, achievement_members(member_id))';

// ─── 파일 내부 헬퍼 ──────────────────────────────────────────

// 23505(유니크 충돌)와 P0001(RPC raise exception)만 의미를 부여하고, 나머지는 일반 Error로
// 던져 toActionFailure가 테이블·제약명 노출을 막게 한다 (SA-4). 무음 처리는 없다.
function throwDbError(error: PostgrestError): never {
  if (error.code === '23505') throw new ConflictError();
  if (error.code === 'P0001') throw new RuleViolationError(error.message);
  throw new Error(`[db] ${error.code}: ${error.message}`);
}

// DB 응답 검증 실패 = 스키마 드리프트 신호. 조용히 넘기지 않는다 (§8.6, 절대 규칙 5).
function parseRow<T>(schema: z.ZodType<T>, row: unknown): T {
  const result = schema.safeParse(row);
  if (!result.success) {
    console.error('[db] deliverables 응답 스키마 검증 실패:', result.error.issues);
    throw new ValidationError('저장소 응답이 기대 스키마와 다릅니다. 앱과 DB 버전을 확인하세요.');
  }
  return result.data;
}

// 0행 갱신의 원인 구분: 행이 없으면 NotFound, 있으면 version 불일치(§8.4).
// O-3: 최신 updated_by를 담아 "OO님이 먼저 수정했습니다"를 표시할 수 있게 한다.
async function throwStaleOrNotFound(
  client: SupabaseClient,
  table: 'deliverables' | 'deliverable_achievements',
  id: string
): Promise<never> {
  const { data, error } = await client.from(table).select('updated_by').eq('id', id).maybeSingle();
  if (error) throwDbError(error);
  if (!data) throw new NotFoundError('대상을 찾을 수 없습니다.');
  throw new StaleDataError(parseRow(z.object({ updated_by: z.uuid().nullable() }), data).updated_by);
}

// §5.8 앱 형태로 변환. DB 전용 컬럼(deliverable_id, created_by 등)은 앱 타입에 없으므로
// 필드를 명시적으로 골라 담는다 — 스프레드로 새면 저장 시 되돌아온다.
// version은 예외로 싣는다: 편집 폼이 expectedVersion을 걸려면 읽은 버전을 알아야 한다(§8.4 O-1).
function toAchievement(
  row: z.infer<typeof deliverableAchievementRowSchema>,
  memberIds: string[]
): DeliverableAchievement {
  return {
    id: row.id,
    version: row.version,
    title: row.title,
    date: row.date,
    yearId: row.year_id,
    orgId: row.org_id,
    memberIds,
    evidenceUrl: row.evidence_url,
    note: row.note,
  };
}

export function toDeliverable(raw: unknown): Deliverable {
  const { deliverable_achievements, ...base } = parseRow(deliverableWithChildrenRowSchema, raw);
  const achievements = deliverable_achievements
    // 임베드 배열의 순서는 보장되지 않는다 — 달성일순으로 결정적 정렬
    .sort((a, b) => a.date.localeCompare(b.date) || a.created_at.localeCompare(b.created_at))
    .map((row) => toAchievement(row, row.achievement_members.map((m) => m.member_id)));
  return { ...dbToApp<Omit<Deliverable, 'achievements'>>(base), achievements };
}

// N-2: memberIds는 achievement_members 조인 테이블이다. 부분 diff의 이득이 없어
// 통째로 갈아끼운다. 중간 실패는 그대로 던진다 — 부분 성공을 숨기지 않는다.
async function replaceAchievementMembers(
  client: SupabaseClient,
  achievementId: string,
  memberIds: string[]
): Promise<void> {
  const del = await client.from('achievement_members').delete().eq('achievement_id', achievementId);
  if (del.error) throwDbError(del.error);
  if (memberIds.length === 0) return;
  const ins = await client
    .from('achievement_members')
    .insert(memberIds.map((memberId) => ({ achievement_id: achievementId, member_id: memberId })));
  if (ins.error) throwDbError(ins.error);
}

async function listAchievementMemberIds(
  client: SupabaseClient,
  achievementId: string
): Promise<string[]> {
  const { data, error } = await client
    .from('achievement_members')
    .select('member_id')
    .eq('achievement_id', achievementId);
  if (error) throwDbError(error);
  if (!data) throw new Error('[db] achievement_members 조회 응답이 비어 있습니다.');
  return parseRow(z.array(z.object({ member_id: z.uuid() })), data).map((r) => r.member_id);
}

// ─── Deliverable CRUD ────────────────────────────────────────

export async function listDeliverables(
  client: SupabaseClient,
  projectId: string
): Promise<Deliverable[]> {
  const { data, error } = await client
    .from('deliverables')
    .select(DELIVERABLE_SELECT)
    .eq('project_id', projectId)
    .order('sort_order', { ascending: true });
  if (error) throwDbError(error);
  if (!data) throw new Error('[db] deliverables 조회 응답이 비어 있습니다.');
  return data.map(toDeliverable);
}

export async function getDeliverableById(
  client: SupabaseClient,
  id: string
): Promise<Deliverable> {
  const { data, error } = await client
    .from('deliverables')
    .select(DELIVERABLE_SELECT)
    .eq('id', id)
    .maybeSingle();
  if (error) throwDbError(error);
  if (!data) throw new NotFoundError('성과목표를 찾을 수 없습니다.');
  return toDeliverable(data);
}

export async function createDeliverable(
  client: SupabaseClient,
  input: DeliverableInput,
  createdBy: string | null
): Promise<Deliverable> {
  const { data, error } = await client
    .from('deliverables')
    .insert({ ...appToDb(input), created_by: createdBy, updated_by: createdBy })
    .select()
    .single();
  if (error) throwDbError(error);
  // 방금 생성한 행이므로 실적은 아직 없다 — 재조회 없이 빈 배열로 조립
  return { ...dbToApp<Omit<Deliverable, 'achievements'>>(parseRow(deliverableRowSchema, data)), achievements: [] };
}

// SA-2: expectedVersion이 넘어오면 낙관적 잠금(§8.4 O-1), 생략하면 마지막 저장 우선(O-2)
export async function updateDeliverable(
  client: SupabaseClient,
  id: string,
  patch: DeliverablePatch,
  updatedBy: string | null,
  expectedVersion?: number
): Promise<Deliverable> {
  let query = client
    .from('deliverables')
    .update({ ...appToDb(patch), updated_by: updatedBy })
    .eq('id', id);
  if (expectedVersion !== undefined) query = query.eq('version', expectedVersion);
  const { data, error } = await query.select(DELIVERABLE_SELECT).maybeSingle();
  if (error) throwDbError(error);
  if (!data) return throwStaleOrNotFound(client, 'deliverables', id);
  return toDeliverable(data);
}

// H-10, X-3: orderedIds는 과제의 성과목표 목록 순서다. 한 번의 RPC로 0..n-1을 부여한다.
export async function reorderDeliverables(
  client: SupabaseClient,
  projectId: string,
  orderedIds: string[]
): Promise<void> {
  const { error } = await client.rpc('reorder_deliverables', {
    p_project_id: projectId,
    p_ordered_ids: orderedIds,
  });
  if (error) throwDbError(error);
}

export async function removeDeliverable(client: SupabaseClient, id: string): Promise<void> {
  // select를 붙여 0행 삭제(이미 지워짐)를 무음으로 넘기지 않는다. 자식은 FK cascade(N-1)
  const { data, error } = await client.from('deliverables').delete().eq('id', id).select('id');
  if (error) throwDbError(error);
  if (!data || data.length === 0) throw new NotFoundError('성과목표를 찾을 수 없습니다.');
}

// ─── DeliverableAchievement 자식 CRUD (N-1) ──────────────────

export async function addAchievement(
  client: SupabaseClient,
  deliverableId: string,
  input: AchievementInput,
  createdBy: string | null
): Promise<DeliverableAchievement> {
  const { memberIds, ...fields } = input;
  const { data, error } = await client
    .from('deliverable_achievements')
    .insert({
      ...appToDb(fields),
      deliverable_id: deliverableId,
      created_by: createdBy,
      updated_by: createdBy,
    })
    .select()
    .single();
  if (error) throwDbError(error);
  const row = parseRow(deliverableAchievementRowSchema, data);
  await replaceAchievementMembers(client, row.id, memberIds);
  return toAchievement(row, [...memberIds]);
}

export async function updateAchievement(
  client: SupabaseClient,
  achievementId: string,
  patch: AchievementPatch,
  updatedBy: string | null,
  expectedVersion?: number
): Promise<DeliverableAchievement> {
  const { memberIds, ...fields } = patch;
  // memberIds만 바꾸는 호출도 본문 update를 거친다 — version 검사·updated_by 갱신 경로를 하나로
  let query = client
    .from('deliverable_achievements')
    .update({ ...appToDb(fields), updated_by: updatedBy })
    .eq('id', achievementId);
  if (expectedVersion !== undefined) query = query.eq('version', expectedVersion);
  const { data, error } = await query.select().maybeSingle();
  if (error) throwDbError(error);
  if (!data) return throwStaleOrNotFound(client, 'deliverable_achievements', achievementId);
  const row = parseRow(deliverableAchievementRowSchema, data);
  if (memberIds !== undefined) {
    await replaceAchievementMembers(client, row.id, memberIds);
    return toAchievement(row, [...memberIds]);
  }
  return toAchievement(row, await listAchievementMemberIds(client, row.id));
}

export async function deleteAchievement(client: SupabaseClient, achievementId: string): Promise<void> {
  // achievement_members는 FK cascade(N-2)로 함께 지워진다
  const { data, error } = await client
    .from('deliverable_achievements')
    .delete()
    .eq('id', achievementId)
    .select('id');
  if (error) throwDbError(error);
  if (!data || data.length === 0) throw new NotFoundError('실적을 찾을 수 없습니다.');
}
