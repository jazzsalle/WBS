// todos 리포지토리 (SOT §5.15, §8.6)
// To-Do는 진척률·달성률 계산에 절대 포함되지 않는다 (§5.15) — 여기는 순수 CRUD만 있다.

import type { PostgrestError, SupabaseClient } from '@supabase/supabase-js';
import { z } from 'zod';
import type { BaseEntity, Todo } from '@/types';
import { appToDb, dbToApp, dbToAppArray } from './mapper';
import { todoRowSchema } from './schema';
import { ConflictError, NotFoundError, StaleDataError, ValidationError } from './errors';

const TABLE = 'todos';

// 서버 액션이 createdBy/updatedBy를 세션 사용자로 채운다 (SA-2)
export type TodoInput = Omit<Todo, keyof BaseEntity> & {
  createdBy?: string | null;
  updatedBy?: string | null;
};

export type TodoPatch = Partial<Omit<Todo, keyof BaseEntity>> & {
  updatedBy?: string | null;
};

// 23505(unique 충돌)만 의미 있는 코드로 바꾸고 나머지는 그대로 던진다 —
// RepositoryError가 아닌 예외는 toActionFailure가 내부 정보를 감춘다 (SA-4).
function throwDbError(error: PostgrestError): never {
  if (error.code === '23505') throw new ConflictError();
  throw error;
}

// DB 응답 검증 실패 = 스키마 드리프트 신호. 조용히 넘기지 않는다 (§8.6, 절대 규칙 5).
function parseRow<T>(schema: z.ZodType<T>, row: unknown): T {
  const result = schema.safeParse(row);
  if (!result.success) {
    throw new ValidationError('DB 응답이 스키마와 일치하지 않습니다. 마이그레이션 누락 가능성이 있습니다.');
  }
  return result.data;
}

// undefined 값 키 제거 — JSON 직렬화에서 빠져 빈 body가 되는 것을 막고,
// "갱신할 내용 없음"을 명시적으로 판정하기 위함
function definedOnly(obj: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined));
}

// 0행 갱신의 원인 구분: 행이 없으면 NotFound, 있으면 낙관적 잠금 실패 (§8.4).
// O-3 표시("OO님이 먼저 수정했습니다")를 위해 최신 행의 updated_by를 담는다.
async function throwUpdateMiss(client: SupabaseClient, id: string): Promise<never> {
  const { data, error } = await client.from(TABLE).select('updated_by').eq('id', id).maybeSingle();
  if (error) throwDbError(error);
  if (!data) throw new NotFoundError();
  throw new StaleDataError((data as { updated_by: string | null }).updated_by);
}

// To-Do 화면(§7.13)은 과제 구분 없이 전체 목록이다 — projectId 필터를 두지 않는다
export async function listTodos(client: SupabaseClient): Promise<Todo[]> {
  const { data, error } = await client
    .from(TABLE)
    .select('*')
    .order('sort_order')
    .order('created_at');
  if (error) throwDbError(error);
  return dbToAppArray<Todo>(parseRow(z.array(todoRowSchema), data ?? []));
}

export async function getTodoById(client: SupabaseClient, id: string): Promise<Todo> {
  const { data, error } = await client.from(TABLE).select('*').eq('id', id).maybeSingle();
  if (error) throwDbError(error);
  if (!data) throw new NotFoundError();
  return dbToApp<Todo>(parseRow(todoRowSchema, data));
}

export async function createTodo(client: SupabaseClient, input: TodoInput): Promise<Todo> {
  const { data, error } = await client.from(TABLE).insert(appToDb(input)).select('*').single();
  if (error) throwDbError(error);
  return dbToApp<Todo>(parseRow(todoRowSchema, data));
}

export async function updateTodo(
  client: SupabaseClient,
  id: string,
  patch: TodoPatch,
  expectedVersion?: number
): Promise<Todo> {
  const dbPatch = definedOnly(appToDb(patch));
  if (Object.keys(dbPatch).length === 0) {
    throw new ValidationError('갱신할 내용이 없습니다.');
  }
  let query = client.from(TABLE).update(dbPatch).eq('id', id);
  if (expectedVersion !== undefined) {
    query = query.eq('version', expectedVersion); // §8.4: 그새 바뀌었으면 0행 갱신
  }
  const { data, error } = await query.select('*');
  if (error) throwDbError(error);
  const row = (data ?? [])[0];
  if (row === undefined) return throwUpdateMiss(client, id);
  return dbToApp<Todo>(parseRow(todoRowSchema, row));
}

export async function removeTodo(client: SupabaseClient, id: string): Promise<void> {
  const { data, error } = await client.from(TABLE).delete().eq('id', id).select('id');
  if (error) throwDbError(error);
  if ((data ?? []).length === 0) throw new NotFoundError();
}
