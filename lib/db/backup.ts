// 백업 리포지토리 (SOT §8.7 K-1·K-4·K-5·K-7·K-8, §8.6)
// 행은 DB snake_case 원본 그대로 담는다 — 매퍼 버그로부터 독립(§8.7). dbToApp을 거치지 않는다.
// 클라이언트는 호출자가 주입한다 — 테스트에서 실제 세션 클라이언트를 넣을 수 있게 (C-1 예외).

import type { PostgrestError, SupabaseClient } from '@supabase/supabase-js';
import { z } from 'zod';
import type { BackupFile } from '@/types';
import {
  AuthError,
  ConflictError,
  OfflineError,
  RuleViolationError,
  ValidationError,
} from './errors';

function raiseDbError(error: PostgrestError): never {
  if (error.code === '23505') throw new ConflictError();
  if (error.code === 'P0001') throw new RuleViolationError(error.message); // restore_backup의 K-5 거부 등
  if (error.code === 'PGRST301') throw new AuthError();
  if (/fetch failed|failed to fetch/i.test(error.message)) throw new OfflineError();
  throw new Error(error.message);
}

// K-7 정순(FK 의존 순서) 복원 대상 23종 — restore_backup RPC의 c_tables와 반드시 일치해야 한다.
// 여기가 어긋나면 내보낸 파일이 복원 시 "테이블 데이터 없음"으로 거부된다.
export const RESTORE_TABLES = [
  'projects', 'organizations', 'members', 'stages', 'years', 'tasks', 'milestones',
  'deliverables', 'deliverable_achievements', 'tech_targets', 'tech_target_records',
  'budget_items', 'budget_executions', 'risks', 'notes', 'todos',
  'import_profiles', 'import_snapshots',
  'task_members', 'task_deliverables', 'task_tech_targets',
  'achievement_members', 'note_attendees',
] as const;

// K-8: app_users와 app_settings는 백업에 포함하되 복원하지 않는다
// (app_settings는 schema_version 제외 컬럼만 RPC가 UPDATE한다)
export const BACKUP_TABLES = [...RESTORE_TABLES, 'app_users', 'app_settings'] as const;

// PostgREST 응답 상한(기본 1,000행)에 걸려 백업이 조용히 잘리는 것을 막기 위해
// id 정렬 + range 페이지네이션으로 끝까지 읽는다
const PAGE_SIZE = 1000;

async function dumpTable(client: SupabaseClient, table: string): Promise<unknown[]> {
  const rows: unknown[] = [];
  for (let offset = 0; ; offset += PAGE_SIZE) {
    const { data, error } = await client
      .from(table)
      .select('*')
      .order('id', { ascending: true })
      .range(offset, offset + PAGE_SIZE - 1);
    if (error) raiseDbError(error);
    if (!data) throw new Error(`${table} 덤프 응답이 비어 있습니다.`);
    rows.push(...data);
    if (data.length < PAGE_SIZE) break;
  }
  return rows;
}

// K-1: 전 테이블(25종) JSON 덤프. schemaVersion은 함께 덤프한 app_settings 행에서 얻는다 —
// BackupFile 헤더와 tables.app_settings가 서로 다른 시점을 가리키지 않게 하기 위해서다.
export async function exportAll(
  client: SupabaseClient,
  exportedBy: BackupFile['exportedBy']
): Promise<BackupFile> {
  const tables: Record<string, unknown[]> = {};
  for (const table of BACKUP_TABLES) {
    tables[table] = await dumpTable(client, table);
  }

  const settingsRow = tables['app_settings']?.[0] as { schema_version?: unknown } | undefined;
  const schemaVersion = settingsRow?.schema_version;
  if (typeof schemaVersion !== 'number') {
    // 최초 마이그레이션이 기본 행을 삽입한다(N-10) — 없다면 마이그레이션 누락이다
    throw new ValidationError(
      'app_settings에서 schema_version을 읽지 못했습니다. DB 마이그레이션 적용 여부를 확인하세요.'
    );
  }

  return {
    schemaVersion,
    exportedAt: new Date().toISOString(),
    exportedBy,
    tables,
  };
}

// K-5 "내보내기 JSON 형식을 지킨다" — 복원 전 구조 검증.
// 대상 테이블 키가 하나라도 빠지면 "삭제만 되고 삽입은 0건"인 무음 데이터 파괴가 되므로
// RPC와 별개로 여기서도 25종 전부를 요구한다.
const backupFileSchema = z.object({
  schemaVersion: z.number().int(),
  exportedAt: z.string(),
  exportedBy: z.object({ id: z.string(), email: z.string() }),
  tables: z.record(z.string(), z.array(z.unknown())),
});

export function parseBackupFile(json: unknown): BackupFile {
  const parsed = backupFileSchema.safeParse(json);
  if (!parsed.success) {
    throw new ValidationError('백업 파일 형식이 올바르지 않습니다. (§8.7 내보내기 JSON이 아닙니다)');
  }
  const missing = BACKUP_TABLES.filter((t) => !(t in parsed.data.tables));
  if (missing.length > 0) {
    throw new ValidationError(`백업 파일에 테이블 데이터가 없습니다: ${missing.join(', ')}`);
  }
  return parsed.data;
}

// K-7: 단일 RPC 트랜잭션 — FK 역순 전 행 DELETE → 정순 INSERT (id 보존), 전체 대체만.
// K-5(schemaVersion)·호출자 active 검증은 RPC(security definer) 안에서 최종 수행된다.
export async function restoreBackup(client: SupabaseClient, payload: BackupFile): Promise<void> {
  const { error } = await client.rpc('restore_backup', { payload });
  if (error) raiseDbError(error);
}
