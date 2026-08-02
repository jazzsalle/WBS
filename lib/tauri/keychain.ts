// OS 키체인 get/set/delete 래퍼 (SOT §14.2 A-4, §8.2 C-3 — localStorage 금지).
// Rust 셸의 keychain_* 커맨드(src-tauri/src/keychain.rs)를 호출한다.
// Tauri 환경이 아니면 저장하지 않고 { ok: false, reason: 'not-tauri' }를 반환한다 —
// 조용한 no-op이 아니라 호출부가 폴백을 명시적으로 결정하게 한다.

import { isTauri } from './env';

export type KeychainResult<T> =
  | { ok: true; value: T }
  | { ok: false; reason: 'not-tauri' };

async function invoke<T>(cmd: string, args: Record<string, unknown>): Promise<T> {
  const { invoke } = await import('@tauri-apps/api/core');
  // 키체인 접근 실패는 Rust 쪽에서 문자열 에러로 reject된다 — 삼키지 않고 그대로 던진다
  return invoke<T>(cmd, args);
}

export async function keychainGet(key: string): Promise<KeychainResult<string | null>> {
  if (!isTauri()) return notTauri('get', key);
  const value = await invoke<string | null>('keychain_get', { key });
  return { ok: true, value };
}

export async function keychainSet(key: string, value: string): Promise<KeychainResult<void>> {
  if (!isTauri()) return notTauri('set', key);
  await invoke<void>('keychain_set', { key, value });
  return { ok: true, value: undefined };
}

export async function keychainDelete(key: string): Promise<KeychainResult<void>> {
  if (!isTauri()) return notTauri('delete', key);
  await invoke<void>('keychain_delete', { key });
  return { ok: true, value: undefined };
}

function notTauri(op: string, key: string): { ok: false; reason: 'not-tauri' } {
  console.warn(`[keychain] Tauri 환경이 아니므로 ${op}(${key}) 미수행 (브라우저 개발 모드)`);
  return { ok: false, reason: 'not-tauri' };
}
