// import_profiles 리포지토리 (SOT §5.12.1, §8.6)
// 프로파일 = 부처 템플릿. projectId가 null이면 전역 프로파일(모든 과제에서 재사용).
// import_snapshots 리포지토리는 Phase 5.5 범위 — 여기서 만들지 않는다 (I-17).

import type { PostgrestError, SupabaseClient } from '@supabase/supabase-js';
import { z } from 'zod';
import type { BaseEntity, ImportKind, ImportProfile } from '@/types';
import { appToDb, dbToApp, dbToAppArray } from './mapper';
import { importProfileRowSchema } from './schema';
import { ConflictError, NotFoundError, StaleDataError, ValidationError } from './errors';

const TABLE = 'import_profiles';

// lastUsedAt/useCount는 markImportProfileUsed가 관리한다 — 생성 입력에서 제외 (§5.12.2와 같은 부분집합).
// 서버 액션이 createdBy/updatedBy를 세션 사용자로 채운다 (SA-2)
export type ImportProfileInput = Omit<ImportProfile, keyof BaseEntity | 'lastUsedAt' | 'useCount'> & {
  createdBy?: string | null;
  updatedBy?: string | null;
};

export type ImportProfilePatch = Partial<Omit<ImportProfile, keyof BaseEntity>> & {
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

// §9 listImportProfiles(kind, projectId): 해당 과제에서 쓸 수 있는 프로파일 =
// 전역(project_id null) + 그 과제 소속. projectId가 null이면 전역만.
// 마법사 선택 UX를 위해 최근 사용 순으로 정렬한다.
export async function listImportProfiles(
  client: SupabaseClient,
  kind: ImportKind,
  projectId: string | null
): Promise<ImportProfile[]> {
  let query = client.from(TABLE).select('*').eq('kind', kind);
  query =
    projectId === null
      ? query.is('project_id', null)
      : query.or(`project_id.is.null,project_id.eq.${projectId}`);
  const { data, error } = await query
    .order('last_used_at', { ascending: false, nullsFirst: false })
    .order('name');
  if (error) throwDbError(error);
  return dbToAppArray<ImportProfile>(parseRow(z.array(importProfileRowSchema), data ?? []));
}

export async function getImportProfileById(
  client: SupabaseClient,
  id: string
): Promise<ImportProfile> {
  const { data, error } = await client.from(TABLE).select('*').eq('id', id).maybeSingle();
  if (error) throwDbError(error);
  if (!data) throw new NotFoundError();
  return dbToApp<ImportProfile>(parseRow(importProfileRowSchema, data));
}

export async function createImportProfile(
  client: SupabaseClient,
  input: ImportProfileInput
): Promise<ImportProfile> {
  const { data, error } = await client.from(TABLE).insert(appToDb(input)).select('*').single();
  if (error) throwDbError(error);
  return dbToApp<ImportProfile>(parseRow(importProfileRowSchema, data));
}

export async function updateImportProfile(
  client: SupabaseClient,
  id: string,
  patch: ImportProfilePatch,
  expectedVersion?: number
): Promise<ImportProfile> {
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
  return dbToApp<ImportProfile>(parseRow(importProfileRowSchema, row));
}

export async function removeImportProfile(client: SupabaseClient, id: string): Promise<void> {
  const { data, error } = await client.from(TABLE).delete().eq('id', id).select('id');
  if (error) throwDbError(error);
  if ((data ?? []).length === 0) throw new NotFoundError();
}

// commitImport 성공 시 호출 — lastUsedAt 갱신 + useCount +1 (§5.12.1).
// 읽고-더하기 방식이라 동시 커밋 시 카운트가 1 손실될 수 있으나, 사용 빈도 통계라 허용한다.
// (RPC로 만들 정도의 정합성 요구가 아니다 — X-1)
export async function markImportProfileUsed(
  client: SupabaseClient,
  id: string,
  updatedBy?: string | null
): Promise<ImportProfile> {
  const { data, error } = await client.from(TABLE).select('use_count').eq('id', id).maybeSingle();
  if (error) throwDbError(error);
  if (!data) throw new NotFoundError();
  const useCount = (data as { use_count: number }).use_count;
  const patch: Record<string, unknown> = {
    last_used_at: new Date().toISOString(),
    use_count: useCount + 1,
  };
  if (updatedBy !== undefined) patch.updated_by = updatedBy;
  const { data: updated, error: updateError } = await client
    .from(TABLE)
    .update(patch)
    .eq('id', id)
    .select('*');
  if (updateError) throwDbError(updateError);
  const row = (updated ?? [])[0];
  if (row === undefined) throw new NotFoundError();
  return dbToApp<ImportProfile>(parseRow(importProfileRowSchema, row));
}
