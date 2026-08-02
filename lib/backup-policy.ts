// 백업 스케줄·보존 정책 순수 함수 (SOT §8.7 K-2·K-3, §8.8)
// Tauri fs를 실기동으로 검증할 수 없으므로, 파일명 규약·초과분 선정·경과 판정을
// 부수효과 없는 함수로 분리해 단위 테스트로 증명한다 (tests/unit/backup-policy.test.ts).

// K-2: 마지막 백업이 7일 "이상" 지났으면 앱 시작 시 자동 내보내기
export const AUTO_BACKUP_INTERVAL_DAYS = 7;

// K-3: 백업 파일은 최근 12개 유지
export const BACKUP_KEEP_COUNT = 12;

const BACKUP_FILE_PREFIX = 'wbs-backup-';

// ISO 8601 타임스탬프에서 파일명 금지 문자(:·.)만 치환한다 — 자릿수가 고정된
// ISO 표기라서 사전순 정렬이 곧 시간순 정렬이 된다 (초과분 선정이 이 성질에 의존)
export function backupFileName(exportedAt: string): string {
  return `${BACKUP_FILE_PREFIX}${exportedAt.replace(/[:.]/g, '-')}.json`;
}

// 백업 폴더에는 사용자의 다른 파일이 섞여 있을 수 있다 — 우리 규약 파일만 보존
// 정책의 대상으로 삼아, 남의 파일을 지우는 사고를 원천 차단한다
export function isBackupFileName(name: string): boolean {
  return /^wbs-backup-\d{4}-\d{2}-\d{2}T[\d-]+Z?\.json$/.test(name);
}

// K-3: 보존 개수를 넘는 가장 오래된 파일들을 삭제 대상으로 고른다.
// 입력 순서와 무관하게 동작하고, 규약 밖 파일은 개수 계산에서도 제외한다.
export function selectBackupsToPrune(
  fileNames: string[],
  keep: number = BACKUP_KEEP_COUNT
): string[] {
  const backups = fileNames.filter(isBackupFileName).sort(); // 사전순 = 시간순 (오래된 것부터)
  if (backups.length <= keep) return [];
  return backups.slice(0, backups.length - keep);
}

// K-2: 자동 백업 시점 판정. 기록이 없거나 손상됐으면 백업하는 쪽이 안전하다.
export function isAutoBackupDue(
  lastBackupAt: string | null,
  now: Date,
  intervalDays: number = AUTO_BACKUP_INTERVAL_DAYS
): boolean {
  if (!lastBackupAt) return true;
  const last = Date.parse(lastBackupAt);
  if (Number.isNaN(last)) return true;
  return now.getTime() - last >= intervalDays * 24 * 60 * 60 * 1000;
}

// §8.8: 앱 기대값(EXPECTED_SCHEMA_VERSION) 대비 DB schema_version 판정.
// db-behind = 마이그레이션 안내, app-behind = 앱 업데이트 안내. 어느 쪽이든 진입 차단.
export type SchemaVerdict = 'ok' | 'db-behind' | 'app-behind';

export function judgeSchemaVersion(dbVersion: number, expectedVersion: number): SchemaVerdict {
  if (dbVersion < expectedVersion) return 'db-behind';
  if (dbVersion > expectedVersion) return 'app-behind';
  return 'ok';
}
