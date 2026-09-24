// years 리포지토리 (SOT §5.5, §8.4, §8.6, §6.6 H-5, N-13)
// 생성·삭제는 다중 테이블 작업이라 RPC 트랜잭션을 쓴다 (§8.3 X-1):
//  - create_year: stage 마지막 뒤 삽입 + 이후 전체 sort_order +1 시프트 + 비목 12종 자동 생성
//  - delete_year: Milestone·Risk·Note·실적 set null(N-8) + targetByYear 고아 키 제거(N-13)
// 클라이언트는 호출자가 주입한다 — 테스트에서 service_role 클라이언트를 넣을 수 있게 (C-1 예외).

import type { PostgrestError, SupabaseClient } from '@supabase/supabase-js';
import type { Year, YearStatus } from '@/types';
import { yearRowSchema } from './schema';
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
  if (error.code === 'P0001') throw new RuleViolationError(error.message); // RPC raise exception
  if (error.code === 'PGRST301') throw new AuthError();
  if (/fetch failed|failed to fetch/i.test(error.message)) throw new OfflineError();
  throw new Error(error.message);
}

function parseYearRow(row: unknown): Year {
  const parsed = yearRowSchema.safeParse(row);
  if (!parsed.success) {
    console.error('[db/years] row 검증 실패:', parsed.error);
    throw new ValidationError(SCHEMA_MISMATCH_MESSAGE);
  }
  return dbToApp<Year>(parsed.data);
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
    .from('years')
    .select('updated_by')
    .eq('id', id)
    .maybeSingle();
  if (error) raiseDbError(error);
  if (!data) throw new NotFoundError();
  throw new StaleDataError((data as { updated_by: string | null }).updated_by);
}

// projectId·order는 RPC가 stage에서 유도·계산한다 (§5.5 order 부여 규칙).
// created_by/updated_by도 RPC가 auth.uid()로 채우므로 받지 않는다.
export interface YearCreateInput {
  stageId: string;
  name?: string;
  goal?: string;
  startDate?: string | null;
  endDate?: string | null;
  budget?: number | null;
  status?: YearStatus;
}

// stageId·projectId 변경은 지원하지 않는다. order 변경은 reorderYears RPC 전용 (H-10, X-3)
export type YearPatch = Partial<
  Omit<Year, 'id' | 'createdAt' | 'updatedAt' | 'version' | 'createdBy' | 'projectId' | 'stageId' | 'order'>
>;

export async function listYears(client: SupabaseClient, projectId: string): Promise<Year[]> {
  const { data, error } = await client
    .from('years')
    .select('*')
    .eq('project_id', projectId)
    .order('sort_order', { ascending: true });
  if (error) raiseDbError(error);
  return data.map(parseYearRow);
}

// PostgREST 응답 상한(max-rows 1000) — §12 규모(연차 150개)로는 넘지 않지만 전 과제 조회는
// 상한을 전제하지 않는다. budget-details.ts fetchAllRows와 같은 전략으로 이어 읽는다.
const PAGE_SIZE = 1000;

/**
 * PS-5 — 전 과제의 연차 전량. 참여율 합산(§6.15 PS-3)이 연차 startDate로 달력 연도를 배정한다.
 * sort_order는 과제 안에서만 의미가 있으므로(H-10) id 순으로 페이징해 읽고, 순서는 (과제, sort_order)로 맞춘다.
 */
export async function listAllYears(client: SupabaseClient): Promise<Year[]> {
  const rows: unknown[] = [];
  for (let from = 0; ; ) {
    const { data, error } = await client
      .from('years')
      .select('*')
      .order('id', { ascending: true })
      .range(from, from + PAGE_SIZE - 1);
    if (error) raiseDbError(error);
    const page = data ?? [];
    if (page.length === 0) break;
    rows.push(...page);
    from += page.length;
  }
  return rows.map(parseYearRow).sort((a, b) => {
    if (a.projectId !== b.projectId) return a.projectId < b.projectId ? -1 : 1;
    if (a.order !== b.order) return a.order - b.order;
    return a.id < b.id ? -1 : 1;
  });
}

export async function getYearById(client: SupabaseClient, id: string): Promise<Year> {
  const { data, error } = await client.from('years').select('*').eq('id', id).maybeSingle();
  if (error) raiseDbError(error);
  if (!data) throw new NotFoundError('연차를 찾을 수 없습니다.');
  return parseYearRow(data);
}

export async function createYear(client: SupabaseClient, input: YearCreateInput): Promise<Year> {
  const { data, error } = await client.rpc('create_year', {
    p_stage_id: input.stageId,
    p_name: input.name ?? '',
    p_goal: input.goal ?? '',
    p_start_date: input.startDate ?? null,
    p_end_date: input.endDate ?? null,
    p_budget: input.budget ?? null,
    p_status: input.status ?? 'planned',
  });
  if (error) raiseDbError(error);
  if (typeof data !== 'string') {
    console.error('[db/years] create_year 반환값이 uuid가 아닙니다:', data);
    throw new ValidationError(SCHEMA_MISMATCH_MESSAGE);
  }
  return getYearById(client, data);
}

export async function updateYear(
  client: SupabaseClient,
  id: string,
  patch: YearPatch,
  expectedVersion?: number
): Promise<Year> {
  const payload = compactPayload(appToDb(patch));
  if (Object.keys(payload).length === 0) {
    throw new ValidationError('변경할 내용이 없습니다.');
  }
  let query = client.from('years').update(payload).eq('id', id);
  if (expectedVersion !== undefined) query = query.eq('version', expectedVersion);
  const { data, error } = await query.select();
  if (error) raiseDbError(error);
  if (!data || data.length === 0) await raiseStaleOrNotFound(client, id, expectedVersion);
  return parseYearRow(data[0]);
}

// H-10: 컨테이너는 project 전체(§5.5). 과제의 모든 연차를 넘겨야 하며,
// 단계 경계를 넘는 순서는 RPC가 RuleViolationError로 거부한다.
export async function reorderYears(
  client: SupabaseClient,
  projectId: string,
  orderedIds: string[]
): Promise<void> {
  const { error } = await client.rpc('reorder_years', {
    p_project_id: projectId,
    p_ordered_ids: orderedIds,
  });
  if (error) raiseDbError(error);
}

// §5.5: 'active'는 과제당 1개 — 기존 active 해제와 지정을 한 트랜잭션으로 묶는다 (§8.3)
export async function setYearStatus(
  client: SupabaseClient,
  id: string,
  status: YearStatus
): Promise<Year> {
  const { error } = await client.rpc('set_year_status', { p_year_id: id, p_status: status });
  if (error) raiseDbError(error);
  return getYearById(client, id);
}

// H-5: Task·BudgetItem은 cascade, 나머지는 set null — RPC 트랜잭션이 보장한다
export async function deleteYear(client: SupabaseClient, id: string): Promise<void> {
  const { error } = await client.rpc('delete_year', { p_year_id: id });
  if (error) raiseDbError(error);
}
