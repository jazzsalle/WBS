'use server';

// Backup 서버 액션 (SOT §9 Auth/Backup 목록, §8.7 K-1·K-4·K-5)
// 반환은 ActionResult<T> — 예외를 그대로 던지지 않는다. supabase 직접 호출 금지,
// 반드시 lib/db/backup 리포지토리를 거친다 (§8.6).
// 파일 저장·2단계 확인 UI(K-4의 클라이언트 절반)는 후속 태스크 — 여기서는 데이터만 다룬다.

import { revalidatePath } from 'next/cache';
import type { ActionResult, BackupFile } from '@/types';
import { requireApprovedUser } from '@/lib/auth/guard';
import * as backup from '@/lib/db/backup';
import * as settings from '@/lib/db/settings';
import { RuleViolationError, toActionFailure } from '@/lib/db/errors';

// K-1: 전 테이블 JSON 덤프. 호출자(Tauri 셸)가 백업 폴더에 저장한다.
export async function exportAll(): Promise<ActionResult<BackupFile>> {
  try {
    const { user, client } = await requireApprovedUser();
    const file = await backup.exportAll(client, { id: user.id, email: user.email });
    return { ok: true, data: file };
  } catch (e) {
    return toActionFailure(e);
  }
}

// K-4·K-7: 전체 복원. 복원 직전 상태의 자동 백업(preRestoreBackup)을 반환한다 —
// 호출자가 파일로 저장해야 잘못된 복원을 되돌릴 수 있다 (K-4의 서버 측 절반).
export async function importAll(
  json: unknown
): Promise<ActionResult<{ preRestoreBackup: BackupFile }>> {
  try {
    const { user, client } = await requireApprovedUser();
    const parsed = backup.parseBackupFile(json); // 형식 위반은 VALIDATION으로 거부

    const preRestoreBackup = await backup.exportAll(client, { id: user.id, email: user.email });

    // K-5: RPC가 최종 판정하지만, 어차피 거부될 파일이면 복원 시도 전에 멈춘다
    if (parsed.schemaVersion !== preRestoreBackup.schemaVersion) {
      throw new RuleViolationError(
        `백업 파일의 스키마 버전(${parsed.schemaVersion})이 현재 스키마 버전(${preRestoreBackup.schemaVersion})과 달라 복원할 수 없습니다.`
      );
    }

    await backup.restoreBackup(client, parsed);
    // 전체 대체 복원 — 모든 화면이 갱신 대상이다
    revalidatePath('/', 'layout');
    return { ok: true, data: { preRestoreBackup } };
  } catch (e) {
    return toActionFailure(e);
  }
}

// §14.6 F-2 헬스체크 + §8.8 스키마 버전 확인을 한 쿼리로 겸한다 —
// app_settings 단일 행 조회가 곧 "가벼운 헬스체크 쿼리"다.
// 앱 시작 부트스트랩(AppBootstrap)이 매 실행 호출한다. F-2의 "주 1회"는
// 최소 빈도이고, §8.8 확인은 어차피 매 시작마다 필요하므로 초과 호출은 무해하다.
export async function runHealthPing(): Promise<ActionResult<{ schemaVersion: number }>> {
  try {
    const { client } = await requireApprovedUser();
    const current = await settings.getSettings(client);
    return { ok: true, data: { schemaVersion: current.schemaVersion } };
  } catch (e) {
    return toActionFailure(e);
  }
}
