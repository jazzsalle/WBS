// 백업 폴더 파일 쓰기·목록·삭제 + 폴더 선택 래퍼 (SOT §8.7 K-1~K-4, §7.14)
// Tauri fs/dialog 플러그인을 감싼다. 브라우저 개발 모드에는 로컬 폴더가 없으므로
// 호출부가 isTauri()로 분기해야 하며, 비Tauri 호출은 조용한 no-op 대신 명시적으로 던진다 —
// keychain.ts의 Result 방식과 달리 여기는 "폴더 기능 자체가 Tauri 한정"이라 폴백이 없다.

import type { BackupFile } from '@/types';
import { backupFileName, selectBackupsToPrune } from '../backup-policy';
import { isTauri } from './env';

function assertTauri(op: string): void {
  if (!isTauri()) {
    throw new Error(`백업 폴더 ${op}은(는) Tauri 데스크톱 앱에서만 사용할 수 있습니다.`);
  }
}

async function joinPath(folder: string, fileName: string): Promise<string> {
  const { join } = await import('@tauri-apps/api/path');
  return join(folder, fileName);
}

// 폴더가 삭제·이동됐어도 백업이 실패하지 않도록 항상 먼저 만든다 (멱등)
export async function writeBackupFile(
  folder: string,
  fileName: string,
  content: string
): Promise<string> {
  assertTauri('쓰기');
  const { mkdir, writeTextFile } = await import('@tauri-apps/plugin-fs');
  await mkdir(folder, { recursive: true });
  const path = await joinPath(folder, fileName);
  await writeTextFile(path, content);
  return path;
}

// 파일명만 반환한다 (디렉터리 제외). 규약 필터링은 backup-policy가 담당.
export async function listBackupFiles(folder: string): Promise<string[]> {
  assertTauri('목록 조회');
  const { exists, readDir } = await import('@tauri-apps/plugin-fs');
  if (!(await exists(folder))) return [];
  const entries = await readDir(folder);
  return entries.filter((e) => e.isFile).map((e) => e.name);
}

export async function deleteBackupFile(folder: string, fileName: string): Promise<void> {
  assertTauri('삭제');
  const { remove } = await import('@tauri-apps/plugin-fs');
  await remove(await joinPath(folder, fileName));
}

// dialog 플러그인 폴더 선택 (§7.14 백업 폴더 변경). 취소하면 null.
export async function pickBackupFolder(defaultPath?: string): Promise<string | null> {
  assertTauri('선택');
  const { open } = await import('@tauri-apps/plugin-dialog');
  const picked = await open({
    directory: true,
    multiple: false,
    title: '백업 폴더 선택 (드라이브 동기화 폴더 권장)',
    ...(defaultPath ? { defaultPath } : {}),
  });
  return typeof picked === 'string' ? picked : null;
}

// K-1 저장 + K-3 보존을 한 번에: 파일 쓰기 → 초과분(12개 넘는 가장 오래된 것) 삭제.
// 새 파일을 쓴 "뒤" 목록을 읽으므로 13개째 시점에 가장 오래된 1개가 지워진다.
export async function runBackupToFolder(
  folder: string,
  file: BackupFile
): Promise<{ fileName: string; pruned: string[] }> {
  assertTauri('백업');
  const fileName = backupFileName(file.exportedAt);
  // 복원 입력용 기계 형식이므로 pretty printing 없이 저장한다 (크기 절약)
  await writeBackupFile(folder, fileName, JSON.stringify(file));

  const names = await listBackupFiles(folder);
  const pruned = selectBackupsToPrune(names);
  for (const name of pruned) {
    await deleteBackupFile(folder, name);
  }
  return { fileName, pruned };
}
