// app_settings 리포지토리 (SOT §5.16, N-10, §8.4)
// 단일 행(id=true)을 DB가 강제한다 — INSERT/DELETE 정책이 없어 get/update만 존재한다.
// schema_version은 마이그레이션만 갱신할 수 있다(트리거 거부) — 패치 타입에서도 제외한다.
// 클라이언트는 호출자가 주입한다 — 테스트에서 service_role 클라이언트를 넣을 수 있게 (C-1 예외).

import type { PostgrestError, SupabaseClient } from '@supabase/supabase-js';
import type { Settings } from '@/types';
import { appSettingsRowSchema } from './schema';
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
  if (error.code === 'P0001') throw new RuleViolationError(error.message); // schema_version 가드 트리거 등
  if (error.code === 'PGRST301') throw new AuthError();
  if (/fetch failed|failed to fetch/i.test(error.message)) throw new OfflineError();
  throw new Error(error.message);
}

// Settings(§5.16)는 업무 규칙 필드만 정의한다. 낙관적 잠금(O-1)과 O-3 표시에 필요한
// 메타를 함께 돌려주기 위해 리포지토리 반환 타입을 확장한다.
export interface SettingsRecord extends Settings {
  createdAt: string;
  updatedAt: string;
  version: number;
  updatedBy: string | null;
}

// schemaVersion은 앱에서 변경 불가(N-10). updatedBy는 액션이 세션 사용자로 채운다 (SA-2)
export type SettingsPatch = Partial<Omit<Settings, 'schemaVersion'>> & {
  updatedBy?: string | null;
};

function parseSettingsRow(row: unknown): SettingsRecord {
  const parsed = appSettingsRowSchema.safeParse(row);
  if (!parsed.success) {
    console.error('[db/settings] row 검증 실패:', parsed.error);
    throw new ValidationError(SCHEMA_MISMATCH_MESSAGE);
  }
  // id(boolean true)는 단일 행 강제 장치일 뿐 앱 개념이 아니라서 반환에서 뺀다
  const { id: _id, ...rest } = dbToApp<SettingsRecord & { id: true }>(parsed.data);
  return rest;
}

export async function getSettings(client: SupabaseClient): Promise<SettingsRecord> {
  const { data, error } = await client
    .from('app_settings')
    .select('*')
    .eq('id', true)
    .maybeSingle();
  if (error) raiseDbError(error);
  if (!data) {
    // 최초 마이그레이션이 기본 행을 삽입한다(N-10) — 없다면 마이그레이션 누락이다
    throw new NotFoundError('설정 행이 없습니다. DB 마이그레이션 적용 여부를 확인하세요.');
  }
  return parseSettingsRow(data);
}

export async function updateSettings(
  client: SupabaseClient,
  patch: SettingsPatch,
  expectedVersion?: number
): Promise<SettingsRecord> {
  const raw = appToDb(patch);
  const payload: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (value !== undefined) payload[key] = value;
  }
  if (Object.keys(payload).length === 0) {
    throw new ValidationError('변경할 내용이 없습니다.');
  }
  let query = client.from('app_settings').update(payload).eq('id', true);
  if (expectedVersion !== undefined) query = query.eq('version', expectedVersion);
  const { data, error } = await query.select();
  if (error) raiseDbError(error);
  if (!data || data.length === 0) {
    if (expectedVersion === undefined) {
      throw new NotFoundError('설정 행이 없습니다. DB 마이그레이션 적용 여부를 확인하세요.');
    }
    // O-3: 최신 행의 updatedBy로 "OO님이 먼저 수정했습니다"를 띄운다
    const latest = await client
      .from('app_settings')
      .select('updated_by')
      .eq('id', true)
      .maybeSingle();
    if (latest.error) raiseDbError(latest.error);
    if (!latest.data) {
      throw new NotFoundError('설정 행이 없습니다. DB 마이그레이션 적용 여부를 확인하세요.');
    }
    throw new StaleDataError((latest.data as { updated_by: string | null }).updated_by);
  }
  return parseSettingsRow(data[0]);
}
