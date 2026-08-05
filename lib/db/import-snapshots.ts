// import_snapshots 리포지토리 (SOT §6.8.5 I-17·I-18, §7.14, §8.6)
//
// 임포트 반영 전 계획액 스냅샷. 행을 직접 만들지 않는다 — 스냅샷은 commit_import RPC가
// 반영과 **같은 트랜잭션**에서 기록한다(I-17). 여기서 제공하는 쓰기 통로는 RPC 호출과
// 삭제뿐이다. UI·서버 액션은 supabase 클라이언트를 직접 부르지 않으므로(절대 규칙 3)
// 이 파일이 임포트 반영·복원의 유일한 통로다.

import type { PostgrestError, SupabaseClient } from '@supabase/supabase-js';
import { z } from 'zod';
import type { BudgetCategory, ImportSnapshot } from '@/types';
import { dbToApp, dbToAppArray } from './mapper';
import { importSnapshotRowSchema } from './schema';
import { ConflictError, NotFoundError, RuleViolationError, ValidationError } from './errors';

const TABLE = 'import_snapshots';

// commit_import RPC에 넘기는 행 (§9 Budget Import). 파싱 결과의 최종 형태이고
// (yearId, category)는 S-8 합산 후라 유일하다 — 중복이 오면 RPC가 거부한다.
export interface ImportCommitRow {
  yearId: string;
  category: BudgetCategory;
  plannedAmount: number;             // 원 단위 정수 (절대 규칙 4)
  cashAmount: number | null;
  inKindAmount: number | null;
}

// 스냅샷 메타 — 어떤 파일이 어떤 프로파일로 반영됐는지 남긴다
export interface ImportCommitSource {
  fileName: string;
  sheetName: string;
  profileId: string | null;
  fileHash: string;
}

export interface ImportCommitResult {
  snapshotId: string;
  updated: number;                   // 실제로 쓴 (연차, 비목) 셀 수
}

export interface ImportRestoreResult {
  snapshotId: string;
  restored: number;
}

// 23505(unique 충돌)만 의미 있는 코드로 바꾸고 나머지는 그대로 던진다 —
// RepositoryError가 아닌 예외는 toActionFailure가 내부 정보를 감춘다 (SA-4).
function throwDbError(error: PostgrestError): never {
  if (error.code === '23505') throw new ConflictError();
  throw error;
}

// RPC의 raise exception(P0001)은 규칙 위반이다 — 일반 Error로 뭉개면 UI가 안내를 못 한다.
// commit_import/restore_import_snapshot의 거부 사유는 전부 사용자에게 보여줄 문장이다.
function throwRpcError(error: PostgrestError): never {
  if (error.code === 'P0001') throw new RuleViolationError(error.message);
  throwDbError(error);
}

// DB 응답 검증 실패 = 스키마 드리프트 신호. 조용히 넘기지 않는다 (§8.6, 절대 규칙 5).
function parseRow<T>(schema: z.ZodType<T>, row: unknown): T {
  const result = schema.safeParse(row);
  if (!result.success) {
    throw new ValidationError('DB 응답이 스키마와 일치하지 않습니다. 마이그레이션 누락 가능성이 있습니다.');
  }
  return result.data;
}

// RPC 반환 jsonb도 검증한다 — 마이그레이션이 덜 적용된 DB는 다른 모양을 돌려준다
const commitResultSchema = z.object({ snapshotId: z.uuid(), updated: z.number() });
const restoreResultSchema = z.object({ snapshotId: z.uuid(), restored: z.number() });

// §7.14 설정 화면 목록. 최신순 — 되돌릴 대상은 거의 항상 방금 한 반영이다.
// 20개 상한은 commit_import RPC가 유지하므로 여기서 자르지 않는다 (I-17).
export async function listImportSnapshots(
  client: SupabaseClient,
  projectId: string
): Promise<ImportSnapshot[]> {
  const { data, error } = await client
    .from(TABLE)
    .select('*')
    .eq('project_id', projectId)
    .order('created_at', { ascending: false })
    .order('id', { ascending: false }); // 같은 트랜잭션 내 동시 생성 시 순서 고정
  if (error) throwDbError(error);
  return dbToAppArray<ImportSnapshot>(parseRow(z.array(importSnapshotRowSchema), data ?? []));
}

export async function getImportSnapshotById(
  client: SupabaseClient,
  id: string
): Promise<ImportSnapshot> {
  const { data, error } = await client.from(TABLE).select('*').eq('id', id).maybeSingle();
  if (error) throwDbError(error);
  if (!data) throw new NotFoundError('스냅샷을 찾을 수 없습니다.');
  return dbToApp<ImportSnapshot>(parseRow(importSnapshotRowSchema, data));
}

// I-18: 단일 RPC 트랜잭션. 한 행이라도 실패하면 전체 롤백이라 부분 반영이 없다.
// I-17: 반영 전 계획액 스냅샷도 같은 트랜잭션에서 기록된다.
// S-9: rows에 없는 (연차, 비목)의 기존 계획액은 건드리지 않는다.
export async function commitImport(
  client: SupabaseClient,
  projectId: string,
  rows: ImportCommitRow[],
  source: ImportCommitSource
): Promise<ImportCommitResult> {
  const { data, error } = await client.rpc('commit_import', {
    p_project_id: projectId,
    p_rows: rows,
    p_source: source,
  });
  if (error) throwRpcError(error);
  const result = commitResultSchema.safeParse(data);
  if (!result.success) {
    console.error('[db] commit_import 반환값이 기대 형식과 다릅니다:', data);
    throw new ValidationError('저장소 응답이 기대 스키마와 다릅니다. 앱과 DB 버전을 확인하세요.');
  }
  return result.data;
}

// §7.14: 스냅샷 시점의 계획액으로 되돌린다. 역시 단일 트랜잭션 + 과제 경계 검증.
export async function restoreImportSnapshot(
  client: SupabaseClient,
  snapshotId: string
): Promise<ImportRestoreResult> {
  const { data, error } = await client.rpc('restore_import_snapshot', {
    p_snapshot_id: snapshotId,
  });
  if (error) throwRpcError(error);
  const result = restoreResultSchema.safeParse(data);
  if (!result.success) {
    console.error('[db] restore_import_snapshot 반환값이 기대 형식과 다릅니다:', data);
    throw new ValidationError('저장소 응답이 기대 스키마와 다릅니다. 앱과 DB 버전을 확인하세요.');
  }
  return result.data;
}

export async function removeImportSnapshot(client: SupabaseClient, id: string): Promise<void> {
  const { data, error } = await client.from(TABLE).delete().eq('id', id).select('id');
  if (error) throwDbError(error);
  if ((data ?? []).length === 0) throw new NotFoundError('스냅샷을 찾을 수 없습니다.');
}
