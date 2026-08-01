// tasks 리포지토리 (SOT §5.6, §8.4, §8.6, §6.6 H-4)
// Task 앱 타입의 memberIds/deliverableIds/techTargetIds는 조인 테이블(N-2)에 있다 —
// 읽기는 PostgREST 임베드로 한 번에 가져오고, 쓰기는 배열 전체 치환으로 저장한다.
// moveTask/moveTaskToYear/reorderTasks는 순환·깊이 검사를 DB에서 해야 하므로(X-4)
// Phase 1의 RPC로 만든다 — 여기서 다루지 않는다.
// 클라이언트는 호출자가 주입한다 — 테스트에서 service_role 클라이언트를 넣을 수 있게 (C-1 예외).

import type { PostgrestError, SupabaseClient } from '@supabase/supabase-js';
import { z } from 'zod';
import type { Task } from '@/types';
import { taskRowSchema } from './schema';
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

// 조인 테이블 임베드 select — 목록·단건 조회가 같은 모양을 쓰게 상수로 고정
const TASK_SELECT =
  '*, task_members(member_id), task_deliverables(deliverable_id), task_tech_targets(tech_target_id)';

const taskJoinsSchema = z.object({
  task_members: z.array(z.object({ member_id: z.uuid() })),
  task_deliverables: z.array(z.object({ deliverable_id: z.uuid() })),
  task_tech_targets: z.array(z.object({ tech_target_id: z.uuid() })),
});

type TaskBase = Omit<Task, 'memberIds' | 'deliverableIds' | 'techTargetIds'>;

function parseTaskRow(row: unknown): Task {
  // taskRowSchema는 임베드 키를 모르므로 base와 joins를 따로 검증한다 (zod가 미선언 키를 제거)
  const base = taskRowSchema.safeParse(row);
  const joins = taskJoinsSchema.safeParse(row);
  if (!base.success || !joins.success) {
    console.error('[db/tasks] row 검증 실패:', base.success ? joins.error : base.error);
    throw new ValidationError(SCHEMA_MISMATCH_MESSAGE);
  }
  return {
    ...dbToApp<TaskBase>(base.data),
    memberIds: joins.data.task_members.map((r) => r.member_id),
    deliverableIds: joins.data.task_deliverables.map((r) => r.deliverable_id),
    techTargetIds: joins.data.task_tech_targets.map((r) => r.tech_target_id),
  };
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
    .from('tasks')
    .select('updated_by')
    .eq('id', id)
    .maybeSingle();
  if (error) raiseDbError(error);
  if (!data) throw new NotFoundError();
  throw new StaleDataError((data as { updated_by: string | null }).updated_by);
}

type TaskJoinTable = 'task_members' | 'task_deliverables' | 'task_tech_targets';

// 배열 전체 치환 — 조인 테이블은 id·타임스탬프뿐이라(N-2) 삭제 후 재삽입해도 잃는 정보가 없다
async function replaceTaskJoins(
  client: SupabaseClient,
  table: TaskJoinTable,
  fkColumn: 'member_id' | 'deliverable_id' | 'tech_target_id',
  taskId: string,
  ids: string[]
): Promise<void> {
  const removed = await client.from(table).delete().eq('task_id', taskId);
  if (removed.error) raiseDbError(removed.error);
  if (ids.length > 0) {
    const inserted = await client
      .from(table)
      .insert(ids.map((value) => ({ task_id: taskId, [fkColumn]: value })));
    if (inserted.error) raiseDbError(inserted.error);
  }
}

export type TaskCreateInput = { projectId: string; yearId: string } &
  Partial<Omit<Task, 'id' | 'createdAt' | 'updatedAt' | 'version' | 'projectId' | 'yearId'>>;

// parentId·yearId·order 변경은 제외한다 — 이동·재정렬은 순환(H-2)·깊이(H-3)·같은 과제(H-11)
// 검사를 DB에서 수행하는 moveTask/moveTaskToYear/reorderTasks RPC 전용이다 (X-3, X-4)
export type TaskPatch = Partial<
  Omit<
    Task,
    'id' | 'createdAt' | 'updatedAt' | 'version' | 'createdBy' | 'projectId' | 'yearId' | 'parentId' | 'order'
  >
>;

export async function listTasksByYear(client: SupabaseClient, yearId: string): Promise<Task[]> {
  const { data, error } = await client
    .from('tasks')
    .select(TASK_SELECT)
    .eq('year_id', yearId)
    .order('sort_order', { ascending: true });
  if (error) raiseDbError(error);
  return data.map(parseTaskRow);
}

// "전체 연차 보기"(§7.4)·getProjectFullTree(§6.7)용
export async function listTasksByProject(
  client: SupabaseClient,
  projectId: string
): Promise<Task[]> {
  const { data, error } = await client
    .from('tasks')
    .select(TASK_SELECT)
    .eq('project_id', projectId)
    .order('sort_order', { ascending: true });
  if (error) raiseDbError(error);
  return data.map(parseTaskRow);
}

export async function getTaskById(client: SupabaseClient, id: string): Promise<Task> {
  const { data, error } = await client
    .from('tasks')
    .select(TASK_SELECT)
    .eq('id', id)
    .maybeSingle();
  if (error) raiseDbError(error);
  if (!data) throw new NotFoundError('작업을 찾을 수 없습니다.');
  return parseTaskRow(data);
}

export async function createTask(client: SupabaseClient, input: TaskCreateInput): Promise<Task> {
  const { memberIds = [], deliverableIds = [], techTargetIds = [], ...base } = input;
  const { data, error } = await client
    .from('tasks')
    .insert(appToDb(base))
    .select('id')
    .single();
  if (error) raiseDbError(error);
  const id = (data as { id: string }).id;
  await replaceTaskJoins(client, 'task_members', 'member_id', id, memberIds);
  await replaceTaskJoins(client, 'task_deliverables', 'deliverable_id', id, deliverableIds);
  await replaceTaskJoins(client, 'task_tech_targets', 'tech_target_id', id, techTargetIds);
  return getTaskById(client, id);
}

// 본체 컬럼은 낙관적 잠금(§8.4), 조인 배열은 넘어온 것만 전체 치환.
// 배열만 바꾸는 호출(assignTaskMembers, linkTaskGoals — §9)도 이 함수 하나로 처리한다.
export async function updateTask(
  client: SupabaseClient,
  id: string,
  patch: TaskPatch,
  expectedVersion?: number
): Promise<Task> {
  const { memberIds, deliverableIds, techTargetIds, ...base } = patch;
  const payload = compactPayload(appToDb(base));
  const hasBasePatch = Object.keys(payload).length > 0;
  const hasJoinPatch =
    memberIds !== undefined || deliverableIds !== undefined || techTargetIds !== undefined;
  if (!hasBasePatch && !hasJoinPatch) {
    throw new ValidationError('변경할 내용이 없습니다.');
  }

  if (hasBasePatch) {
    let query = client.from('tasks').update(payload).eq('id', id);
    if (expectedVersion !== undefined) query = query.eq('version', expectedVersion);
    const { data, error } = await query.select('id');
    if (error) raiseDbError(error);
    if (!data || data.length === 0) await raiseStaleOrNotFound(client, id, expectedVersion);
  }

  if (memberIds !== undefined) {
    await replaceTaskJoins(client, 'task_members', 'member_id', id, memberIds);
  }
  if (deliverableIds !== undefined) {
    await replaceTaskJoins(client, 'task_deliverables', 'deliverable_id', id, deliverableIds);
  }
  if (techTargetIds !== undefined) {
    await replaceTaskJoins(client, 'task_tech_targets', 'tech_target_id', id, techTargetIds);
  }

  return getTaskById(client, id);
}

// H-4: 자손·조인 행은 FK cascade가 함께 지운다. Note·Risk의 taskId는 set null로 남는다 (N-8).
// "삭제 전 개수 확인" 대화상자는 UI 몫 — 여기서는 대상 부재만 명시적으로 알린다.
export async function deleteTask(client: SupabaseClient, id: string): Promise<void> {
  const { data, error } = await client.from('tasks').delete().eq('id', id).select('id');
  if (error) raiseDbError(error);
  if (!data || data.length === 0) throw new NotFoundError('작업을 찾을 수 없습니다.');
}
