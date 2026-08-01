// TechTarget(정량적 기술목표) 리포지토리 (SOT §5.9, §5.1 N-1, §8.4, §8.6)
// DB에는 tech_target_records(N-1)로 정규화되어 있고,
// 조회 시 §5.9의 앱 형태(records 임베드)로 조립해 반환한다.
// 클라이언트는 호출자가 주입한다 — 서버 액션은 createServerClient(token), 테스트는 목/로컬.

import type { PostgrestError, SupabaseClient } from '@supabase/supabase-js';
import { z } from 'zod';
import type { TechTarget, TechTargetRecord } from '@/types';
import { techTargetRecordRowSchema, techTargetRowSchema } from './schema';
import { appToDb, dbToApp } from './mapper';
import { ConflictError, NotFoundError, StaleDataError, ValidationError } from './errors';

// N-4 공통 컬럼은 DB(트리거)와 서버 액션이 채운다 — 입력에서 제외.
// records는 자식 테이블이므로 add/update/deleteRecord로만 조작한다.
type BaseFieldKeys = 'id' | 'createdAt' | 'updatedAt' | 'version' | 'createdBy' | 'updatedBy';

export type TechTargetInput = Omit<TechTarget, BaseFieldKeys | 'records'>;
export type TechTargetPatch = Partial<TechTargetInput>;

export type TechTargetRecordInput = Omit<TechTargetRecord, 'id'>;
export type TechTargetRecordPatch = Partial<TechTargetRecordInput>;

// PostgREST 임베드 응답 검증용 — schema.ts의 row 스키마를 중첩 형태로 확장
const techTargetWithRecordsRowSchema = techTargetRowSchema.extend({
  tech_target_records: z.array(techTargetRecordRowSchema),
});

const TECH_TARGET_SELECT = '*, tech_target_records(*)';

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
    console.error('[db] tech_targets 응답 스키마 검증 실패:', result.error.issues);
    throw new ValidationError('저장소 응답이 기대 스키마와 다릅니다. 앱과 DB 버전을 확인하세요.');
  }
  return result.data;
}

// 0행 갱신의 원인 구분: 행이 없으면 NotFound, 있으면 version 불일치(§8.4).
// O-3: 최신 updated_by를 담아 "OO님이 먼저 수정했습니다"를 표시할 수 있게 한다.
async function throwStaleOrNotFound(
  client: SupabaseClient,
  table: 'tech_targets' | 'tech_target_records',
  id: string
): Promise<never> {
  const { data, error } = await client.from(table).select('updated_by').eq('id', id).maybeSingle();
  if (error) throwDbError(error);
  if (!data) throw new NotFoundError('대상을 찾을 수 없습니다.');
  throw new StaleDataError(parseRow(z.object({ updated_by: z.uuid().nullable() }), data).updated_by);
}

// §5.9 앱 형태로 변환. DB 전용 컬럼(tech_target_id, version 등)은 앱 타입에 없으므로
// 필드를 명시적으로 골라 담는다 — 스프레드로 새면 저장 시 되돌아온다.
function toRecord(row: z.infer<typeof techTargetRecordRowSchema>): TechTargetRecord {
  return {
    id: row.id,
    value: row.value,
    date: row.date,
    yearId: row.year_id,
    method: row.method,
    evaluator: row.evaluator,
    evidenceUrl: row.evidence_url,
    note: row.note,
  };
}

function toTechTarget(raw: unknown): TechTarget {
  const { tech_target_records, ...base } = parseRow(techTargetWithRecordsRowSchema, raw);
  const records = tech_target_records
    // §5.9: "최신값이 현재 실적치" — 측정일 오름차순으로 정렬해 마지막 원소가 최신이 되게 한다
    .sort((a, b) => a.date.localeCompare(b.date) || a.created_at.localeCompare(b.created_at))
    .map(toRecord);
  return { ...dbToApp<Omit<TechTarget, 'records'>>(base), records };
}

// ─── TechTarget CRUD ─────────────────────────────────────────

export async function listTechTargets(
  client: SupabaseClient,
  projectId: string
): Promise<TechTarget[]> {
  const { data, error } = await client
    .from('tech_targets')
    .select(TECH_TARGET_SELECT)
    .eq('project_id', projectId)
    .order('sort_order', { ascending: true });
  if (error) throwDbError(error);
  if (!data) throw new Error('[db] tech_targets 조회 응답이 비어 있습니다.');
  return data.map(toTechTarget);
}

export async function getTechTargetById(client: SupabaseClient, id: string): Promise<TechTarget> {
  const { data, error } = await client
    .from('tech_targets')
    .select(TECH_TARGET_SELECT)
    .eq('id', id)
    .maybeSingle();
  if (error) throwDbError(error);
  if (!data) throw new NotFoundError('기술목표를 찾을 수 없습니다.');
  return toTechTarget(data);
}

export async function createTechTarget(
  client: SupabaseClient,
  input: TechTargetInput,
  createdBy: string | null
): Promise<TechTarget> {
  const { data, error } = await client
    .from('tech_targets')
    .insert({ ...appToDb(input), created_by: createdBy, updated_by: createdBy })
    .select()
    .single();
  if (error) throwDbError(error);
  // 방금 생성한 행이므로 측정 이력은 아직 없다 — 재조회 없이 빈 배열로 조립
  return { ...dbToApp<Omit<TechTarget, 'records'>>(parseRow(techTargetRowSchema, data)), records: [] };
}

// SA-2: expectedVersion이 넘어오면 낙관적 잠금(§8.4 O-1), 생략하면 마지막 저장 우선(O-2)
export async function updateTechTarget(
  client: SupabaseClient,
  id: string,
  patch: TechTargetPatch,
  updatedBy: string | null,
  expectedVersion?: number
): Promise<TechTarget> {
  let query = client
    .from('tech_targets')
    .update({ ...appToDb(patch), updated_by: updatedBy })
    .eq('id', id);
  if (expectedVersion !== undefined) query = query.eq('version', expectedVersion);
  const { data, error } = await query.select(TECH_TARGET_SELECT).maybeSingle();
  if (error) throwDbError(error);
  if (!data) return throwStaleOrNotFound(client, 'tech_targets', id);
  return toTechTarget(data);
}

export async function removeTechTarget(client: SupabaseClient, id: string): Promise<void> {
  // select를 붙여 0행 삭제(이미 지워짐)를 무음으로 넘기지 않는다. 자식은 FK cascade(N-1)
  const { data, error } = await client.from('tech_targets').delete().eq('id', id).select('id');
  if (error) throwDbError(error);
  if (!data || data.length === 0) throw new NotFoundError('기술목표를 찾을 수 없습니다.');
}

// ─── TechTargetRecord 자식 CRUD (N-1) ────────────────────────

export async function addRecord(
  client: SupabaseClient,
  techTargetId: string,
  input: TechTargetRecordInput,
  createdBy: string | null
): Promise<TechTargetRecord> {
  const { data, error } = await client
    .from('tech_target_records')
    .insert({
      ...appToDb(input),
      tech_target_id: techTargetId,
      created_by: createdBy,
      updated_by: createdBy,
    })
    .select()
    .single();
  if (error) throwDbError(error);
  return toRecord(parseRow(techTargetRecordRowSchema, data));
}

export async function updateRecord(
  client: SupabaseClient,
  recordId: string,
  patch: TechTargetRecordPatch,
  updatedBy: string | null,
  expectedVersion?: number
): Promise<TechTargetRecord> {
  let query = client
    .from('tech_target_records')
    .update({ ...appToDb(patch), updated_by: updatedBy })
    .eq('id', recordId);
  if (expectedVersion !== undefined) query = query.eq('version', expectedVersion);
  const { data, error } = await query.select().maybeSingle();
  if (error) throwDbError(error);
  if (!data) return throwStaleOrNotFound(client, 'tech_target_records', recordId);
  return toRecord(parseRow(techTargetRecordRowSchema, data));
}

export async function deleteRecord(client: SupabaseClient, recordId: string): Promise<void> {
  const { data, error } = await client
    .from('tech_target_records')
    .delete()
    .eq('id', recordId)
    .select('id');
  if (error) throwDbError(error);
  if (!data || data.length === 0) throw new NotFoundError('측정 이력을 찾을 수 없습니다.');
}
