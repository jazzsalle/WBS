// LocalConfig 영속화 (SOT §5.16, §14.4 ④)
// 각 PC 로컬 설정 — DB에 저장하지 않는다. Tauri에서는 app config dir의 JSON 파일,
// 브라우저 개발 모드에서는 localStorage에 둔다 (§5.16 주석: C-3의 localStorage 금지는
// "세션 토큰" 한정이며 비밀이 아닌 로컬 설정은 무관하다).
// 클라이언트 전용 — 서버 액션은 각 PC의 로컬 파일에 접근할 수 없다 (I-17과 같은 이유).

import { z } from 'zod';
import type { LocalConfig } from '@/types';
import { isTauri } from './tauri/env';

const FILE_NAME = 'local-config.json';
const STORAGE_KEY = 'wbs.local-config';

export const DEFAULT_LOCAL_CONFIG: LocalConfig = {
  backupFolder: null,
  lastBackupAt: null,
  lastOpenedProjectId: null,
  ganttScale: 'week', // §5.16 defaultGanttScale 기본값과 맞춘다
};

// 저장 파일 형식 = LocalConfig + 온보딩 완료 메타.
// "최초 1회" 판정(§7.0)의 영속 근거가 필요한데 §5.16 인터페이스에는 자리가 없어,
// 앱 노출 타입(LocalConfig)에는 넣지 않고 저장 형식에만 동봉한다.
interface StoredLocalConfig extends LocalConfig {
  onboardingCompleted: boolean;
}

// 필드 단위 .catch — 일부 필드가 손상돼도 나머지 설정을 살린다.
// 로컬 화면 취향이므로 기본값 복구가 안전하지만, 복구 사실은 콘솔에 남긴다(무음 금지).
const storedSchema = z.object({
  backupFolder: z.string().nullable().catch(null),
  lastBackupAt: z.string().nullable().catch(null),
  lastOpenedProjectId: z.string().nullable().catch(null),
  ganttScale: z.enum(['day', 'week', 'month']).catch('week'),
  onboardingCompleted: z.boolean().catch(false),
});

const DEFAULT_STORED: StoredLocalConfig = { ...DEFAULT_LOCAL_CONFIG, onboardingCompleted: false };

function assertClient(): void {
  if (typeof window === 'undefined') {
    // 서버에서 부르면 각 PC의 설정이 아니라 서버 프로세스의 설정이 된다 — 설계 위반
    throw new Error('LocalConfig는 클라이언트에서만 읽고 쓸 수 있습니다.');
  }
}

async function configFilePath(): Promise<string> {
  const { appConfigDir, join } = await import('@tauri-apps/api/path');
  return join(await appConfigDir(), FILE_NAME);
}

async function readRaw(): Promise<string | null> {
  if (isTauri()) {
    const { exists, readTextFile } = await import('@tauri-apps/plugin-fs');
    const path = await configFilePath();
    if (!(await exists(path))) return null;
    return readTextFile(path);
  }
  return window.localStorage.getItem(STORAGE_KEY);
}

async function writeRaw(content: string): Promise<void> {
  if (isTauri()) {
    const { appConfigDir, join } = await import('@tauri-apps/api/path');
    const { mkdir, writeTextFile } = await import('@tauri-apps/plugin-fs');
    const dir = await appConfigDir();
    await mkdir(dir, { recursive: true }); // 최초 실행 시 config dir가 없다
    await writeTextFile(await join(dir, FILE_NAME), content);
    return;
  }
  window.localStorage.setItem(STORAGE_KEY, content);
}

async function loadStored(): Promise<StoredLocalConfig> {
  assertClient();
  const raw = await readRaw();
  if (raw === null) return { ...DEFAULT_STORED };
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    console.error('[local-config] 저장된 설정이 JSON이 아닙니다. 기본값으로 복구합니다.');
    return { ...DEFAULT_STORED };
  }
  const parsed = storedSchema.safeParse(json);
  if (!parsed.success) {
    console.error('[local-config] 저장된 설정 형식이 올바르지 않습니다. 기본값으로 복구합니다.');
    return { ...DEFAULT_STORED };
  }
  return parsed.data;
}

async function saveStored(config: StoredLocalConfig): Promise<void> {
  assertClient();
  await writeRaw(JSON.stringify(config, null, 2));
}

export async function loadLocalConfig(): Promise<LocalConfig> {
  const { onboardingCompleted: _meta, ...config } = await loadStored();
  return config;
}

export async function updateLocalConfig(patch: Partial<LocalConfig>): Promise<LocalConfig> {
  const stored = await loadStored();
  const next: StoredLocalConfig = { ...stored, ...patch };
  await saveStored(next);
  const { onboardingCompleted: _meta, ...config } = next;
  return config;
}

// ─── 온보딩 "최초 1회" 판정 (§7.0, §14.4 ③·④) ────────────────

export async function loadOnboardingState(): Promise<{
  completed: boolean;
  backupFolder: string | null;
}> {
  const stored = await loadStored();
  return { completed: stored.onboardingCompleted, backupFolder: stored.backupFolder };
}

export async function completeOnboarding(backupFolder: string | null): Promise<void> {
  const stored = await loadStored();
  await saveStored({ ...stored, backupFolder, onboardingCompleted: true });
}
