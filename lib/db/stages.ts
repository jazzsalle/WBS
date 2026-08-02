// stages 리포지토리 (SOT §5.4, §8.4, §8.6, §6.6 H-6)
// 클라이언트는 호출자가 주입한다 — 테스트에서 service_role 클라이언트를 넣을 수 있게 (C-1 예외).

import type { PostgrestError, SupabaseClient } from '@supabase/supabase-js';
import type { Stage } from '@/types';
import { stageRowSchema } from './schema';
import { appToDb, dbToApp } from './mapper';
import {
  AuthError,
  ConflictError,
  NotFoundError,
  OfflineError,
  RuleViolationError,
  StaleDataError,
  ValidationError,
} from './errors';

const SCHEMA_MISMATCH_MESSAGE =
  'DB 응답이 앱이 기대하는 형식과 다릅니다. 앱과 DB 마이그레이션 버전을 확인하세요.';

function raiseDbError(error: PostgrestError): never {
  if (error.code === '23505') throw new ConflictError();
  if (error.code === 'P0001') throw new RuleViolationError(error.message); // H-6 '마지막 단계는 삭제할 수 없습니다' 등
  if (error.code === 'PGRST301') throw new AuthError();
  if (/fetch failed|failed to fetch/i.test(error.message)) throw new OfflineError();
  throw new Error(error.message);
}

function parseStageRow(row: unknown): Stage {
  const parsed = stageRowSchema.safeParse(row);
  if (!parsed.success) {
    console.error('[db/stages] row 검증 실패:', parsed.error);
    throw new ValidationError(SCHEMA_MISMATCH_MESSAGE);
  }
  return dbToApp<Stage>(parsed.data);
}

function compactPayload(payload: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(payload)) {
    if (value !== undefined) out[key] = value;
  }
  return out;
}

async function raiseStaleOrNotFound(
  client: SupabaseClient,
  id: string,
  expectedVersion: number | undefined
): Promise<never> {
  if (expectedVersion === undefined) throw new NotFoundError();
  const { data, error } = await client
    .from('stages')
    .select('updated_by')
    .eq('id', id)
    .maybeSingle();
  if (error) raiseDbError(error);
  if (!data) throw new NotFoundError();
  throw new StaleDataError((data as { updated_by: string | null }).updated_by);
}

export type StageCreateInput = { projectId: string } &
  Partial<Omit<Stage, 'id' | 'createdAt' | 'updatedAt' | 'version' | 'projectId'>>;
export type StagePatch = Partial<
  Omit<Stage, 'id' | 'createdAt' | 'updatedAt' | 'version' | 'createdBy' | 'projectId'>
>;

export async function listStages(client: SupabaseClient, projectId: string): Promise<Stage[]> {
  const { data, error } = await client
    .from('stages')
    .select('*')
    .eq('project_id', projectId)
    .order('sort_order', { ascending: true });
  if (error) raiseDbError(error);
  return data.map(parseStageRow);
}

export async function getStageById(client: SupabaseClient, id: string): Promise<Stage> {
  const { data, error } = await client.from('stages').select('*').eq('id', id).maybeSingle();
  if (error) raiseDbError(error);
  if (!data) throw new NotFoundError('단계를 찾을 수 없습니다.');
  return parseStageRow(data);
}

export async function createStage(
  client: SupabaseClient,
  input: StageCreateInput
): Promise<Stage> {
  const { data, error } = await client.from('stages').insert(appToDb(input)).select().single();
  if (error) raiseDbError(error);
  return parseStageRow(data);
}

export async function updateStage(
  client: SupabaseClient,
  id: string,
  patch: StagePatch,
  expectedVersion?: number
): Promise<Stage> {
  const payload = compactPayload(appToDb(patch));
  if (Object.keys(payload).length === 0) {
    throw new ValidationError('변경할 내용이 없습니다.');
  }
  let query = client.from('stages').update(payload).eq('id', id);
  if (expectedVersion !== undefined) query = query.eq('version', expectedVersion);
  const { data, error } = await query.select();
  if (error) raiseDbError(error);
  if (!data || data.length === 0) await raiseStaleOrNotFound(client, id, expectedVersion);
  return parseStageRow(data[0]);
}

// H-10: 컨테이너는 project. 넘어온 순서대로 sort_order 0..n-1을 한 번의 RPC로 부여한다 (X-3)
export async function reorderStages(
  client: SupabaseClient,
  projectId: string,
  orderedIds: string[]
): Promise<void> {
  const { error } = await client.rpc('reorder_stages', {
    p_project_id: projectId,
    p_ordered_ids: orderedIds,
  });
  if (error) raiseDbError(error);
}

// H-6: 마지막 Stage 삭제 거부 + 소속 Year에 delete_year 로직(H-5) 적용은 RPC가 보장한다 (§8.3)
export async function deleteStage(client: SupabaseClient, id: string): Promise<void> {
  const { error } = await client.rpc('delete_stage', { p_stage_id: id });
  if (error) raiseDbError(error);
}
