// projects 리포지토리 (SOT §5.3, §8.4, §8.6, §6.6 H-7)
// UI·서버 액션은 supabase를 직접 부르지 않고 이 모듈을 거친다 (§8.6).
// 클라이언트는 호출자가 주입한다 — 테스트에서 service_role 클라이언트를 넣을 수 있게 (C-1 예외).

import type { PostgrestError, SupabaseClient } from '@supabase/supabase-js';
import type { Project, ProjectStatus } from '@/types';
import { projectRowSchema } from './schema';
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

// SA-4: 테이블명·제약명 같은 내부 정보를 사용자 메시지에 싣지 않는다
const SCHEMA_MISMATCH_MESSAGE =
  'DB 응답이 앱이 기대하는 형식과 다릅니다. 앱과 DB 마이그레이션 버전을 확인하세요.';

// PostgREST 에러 → 리포지토리 에러. 매핑 안 되는 에러는 그대로 던져
// toActionFailure가 일반 메시지로 감춘다 (SA-4) — 삼키지는 않는다.
function raiseDbError(error: PostgrestError): never {
  if (error.code === '23505') throw new ConflictError();
  if (error.code === 'P0001') throw new RuleViolationError(error.message); // RPC raise exception
  if (error.code === 'PGRST301') throw new AuthError();
  if (/fetch failed|failed to fetch/i.test(error.message)) throw new OfflineError();
  throw new Error(error.message);
}

function parseProjectRow(row: unknown): Project {
  const parsed = projectRowSchema.safeParse(row);
  if (!parsed.success) {
    // 스키마 드리프트는 마이그레이션 누락 신호 — 서버 로그에 원인을 남기고 명시적으로 실패시킨다 (§8.6)
    console.error('[db/projects] row 검증 실패:', parsed.error);
    throw new ValidationError(SCHEMA_MISMATCH_MESSAGE);
  }
  return dbToApp<Project>(parsed.data);
}

// undefined 값을 제거한다 — JSON 직렬화에서 사라져 빈 PATCH가 되는 것을 미리 잡기 위해
function compactPayload(payload: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(payload)) {
    if (value !== undefined) out[key] = value;
  }
  return out;
}

// O-3: 낙관적 잠금 실패 시 최신 행의 updated_by로 "OO님이 먼저 수정했습니다"를 띄운다
async function raiseStaleOrNotFound(
  client: SupabaseClient,
  id: string,
  expectedVersion: number | undefined
): Promise<never> {
  if (expectedVersion === undefined) throw new NotFoundError();
  const { data, error } = await client
    .from('projects')
    .select('updated_by')
    .eq('id', id)
    .maybeSingle();
  if (error) raiseDbError(error);
  if (!data) throw new NotFoundError();
  throw new StaleDataError((data as { updated_by: string | null }).updated_by);
}

// 모든 필드가 DB 기본값을 가지므로 전부 선택 (§5.3). createdBy/updatedBy는 액션이 채운다 (SA-2)
export type ProjectCreateInput = Partial<Omit<Project, 'id' | 'createdAt' | 'updatedAt' | 'version'>>;
export type ProjectPatch = Partial<Omit<Project, 'id' | 'createdAt' | 'updatedAt' | 'version' | 'createdBy'>>;

export async function listProjects(client: SupabaseClient): Promise<Project[]> {
  const { data, error } = await client
    .from('projects')
    .select('*')
    .order('sort_order', { ascending: true });
  if (error) raiseDbError(error);
  return data.map(parseProjectRow);
}

export async function getProjectById(client: SupabaseClient, id: string): Promise<Project> {
  const { data, error } = await client.from('projects').select('*').eq('id', id).maybeSingle();
  if (error) raiseDbError(error);
  if (!data) throw new NotFoundError('과제를 찾을 수 없습니다.');
  return parseProjectRow(data);
}

export async function createProject(
  client: SupabaseClient,
  input: ProjectCreateInput
): Promise<Project> {
  const { data, error } = await client
    .from('projects')
    .insert(appToDb(input))
    .select()
    .single();
  if (error) raiseDbError(error);
  return parseProjectRow(data);
}

// §9 createProject: Stage 1개 + Year 1개(비목 12종 포함)를 함께 만드는 실제 생성 경로.
// pmMemberId·leadOrgId는 인력·기관이 아직 없으므로 받지 않는다 — 생성 후 updateProject로 지정한다.
export interface ProjectWithDefaultsInput {
  name?: string;
  projectNo?: string;
  ministry?: string;
  agency?: string;
  programName?: string;
  description?: string;
  status?: ProjectStatus;
  color?: string;
  contractStartDate?: string | null;
  contractEndDate?: string | null;
  totalBudget?: number | null;
  govBudget?: number | null;
  ownBudget?: number | null;
}

// 다중 테이블 생성이라 RPC 트랜잭션을 쓴다 (§8.3 X-1). created_by/updated_by는 RPC가 auth.uid()로 채운다.
export async function createProjectWithDefaults(
  client: SupabaseClient,
  input: ProjectWithDefaultsInput
): Promise<Project> {
  const { data, error } = await client.rpc('create_project_with_defaults', {
    p_name: input.name ?? '',
    p_project_no: input.projectNo ?? '',
    p_ministry: input.ministry ?? '',
    p_agency: input.agency ?? '',
    p_program_name: input.programName ?? '',
    p_description: input.description ?? '',
    p_status: input.status ?? 'planning',
    p_color: input.color ?? '',
    p_contract_start_date: input.contractStartDate ?? null,
    p_contract_end_date: input.contractEndDate ?? null,
    p_total_budget: input.totalBudget ?? null,
    p_gov_budget: input.govBudget ?? null,
    p_own_budget: input.ownBudget ?? null,
  });
  if (error) raiseDbError(error);
  if (typeof data !== 'string') {
    console.error('[db/projects] create_project_with_defaults 반환값이 uuid가 아닙니다:', data);
    throw new ValidationError(SCHEMA_MISMATCH_MESSAGE);
  }
  return getProjectById(client, data);
}

// §8.4: expectedVersion이 오면 version 조건을 걸어 0행이면 StaleDataError (O-1)
export async function updateProject(
  client: SupabaseClient,
  id: string,
  patch: ProjectPatch,
  expectedVersion?: number
): Promise<Project> {
  const payload = compactPayload(appToDb(patch));
  if (Object.keys(payload).length === 0) {
    throw new ValidationError('변경할 내용이 없습니다.');
  }
  let query = client.from('projects').update(payload).eq('id', id);
  if (expectedVersion !== undefined) query = query.eq('version', expectedVersion);
  const { data, error } = await query.select();
  if (error) raiseDbError(error);
  if (!data || data.length === 0) await raiseStaleOrNotFound(client, id, expectedVersion);
  return parseProjectRow(data[0]);
}

// H-10: 넘어온 순서대로 sort_order 0..n-1. 행마다 부르지 않고 한 번의 RPC로 일괄 갱신한다 (X-3)
export async function reorderProjects(
  client: SupabaseClient,
  orderedIds: string[]
): Promise<void> {
  const { error } = await client.rpc('reorder_projects', { p_ordered_ids: orderedIds });
  if (error) raiseDbError(error);
}

// H-7: 연쇄 삭제는 RPC 트랜잭션으로 — 순환 FK 해소(pm_member_id·lead_org_id) 후 cascade (§8.3)
export async function deleteProject(client: SupabaseClient, id: string): Promise<void> {
  const { error } = await client.rpc('delete_project', { p_project_id: id });
  if (error) raiseDbError(error);
}
