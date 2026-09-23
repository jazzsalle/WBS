// HR API 키 보관 계층 (SOT §6.13.3 HR-10~HR-12, §7.14 "사내 명부 연동")
//
// 키는 OS 키체인(lib/tauri/keychain.ts)에만 둔다. 앱 DB·백업 파일·localStorage에 두지 않는
// 이유: 데스크톱 앱은 사용자 손에 있는 코드다. 키가 DB나 백업에 들어가면 앱(또는 백업
// 파일)을 가진 누구나 전 직원 명부를 조회할 수 있다 — service_role 키를 클라이언트에
// 넣지 않는 것과 같은 이유(절대 규칙 1). 그래서 키는 §8.7 백업으로 옮겨지지 않고 PC마다
// 등록해야 하며, 사용자마다 자기 키를 쓴다(HR-10).
//
// Tauri가 아닌 환경(브라우저 개발 모드)에는 키체인이 없다. 그때는 이 모듈의 변수에만
// 두고 storage: 'session'으로 그 사실을 돌려준다 — 호출부가 "이 창에서만 유지됩니다"를
// 화면에 띄운다(HR-12, 조용한 no-op 금지).
//
// 클라이언트 전용. 서버에서 부르면 각 사용자의 키가 아니라 서버 프로세스의 값이 된다.
// 키 값은 어디에도 로그하지 않는다.

import { isTauri } from './tauri/env';
import { keychainDelete, keychainGet, keychainSet } from './tauri/keychain';

// Supabase 세션 토큰 항목(sb-*-auth-token)과 겹치지 않는 이름
const HR_API_KEY_KEYCHAIN_KEY = 'wbs.hr-api-key';

export type HrKeyStorage = 'keychain' | 'session';

// 비Tauri 환경의 세션 메모리 — 모듈 인스턴스 수명(= 이 창) 동안만 산다
let sessionKey: string | null = null;

function assertClient(): void {
  if (typeof window === 'undefined') {
    throw new Error('HR API 키는 클라이언트에서만 읽고 쓸 수 있습니다.');
  }
}

export async function loadHrApiKey(): Promise<{ key: string | null; storage: HrKeyStorage }> {
  assertClient();
  if (isTauri()) {
    const result = await keychainGet(HR_API_KEY_KEYCHAIN_KEY);
    if (result.ok) return { key: result.value, storage: 'keychain' };
  }
  return { key: sessionKey, storage: 'session' };
}

export async function saveHrApiKey(key: string): Promise<{ storage: HrKeyStorage }> {
  assertClient();
  const trimmed = key.trim();
  if (trimmed.length === 0) {
    throw new Error('HR API 키가 비어 있습니다.');
  }
  const result = await keychainSet(HR_API_KEY_KEYCHAIN_KEY, trimmed);
  if (result.ok) {
    // 키체인에 들어갔으면 메모리 사본을 남길 이유가 없다
    sessionKey = null;
    return { storage: 'keychain' };
  }
  // not-tauri: 이번 세션에서만 쓰는 값으로 취급하고 그 사실을 돌려준다(HR-12)
  sessionKey = trimmed;
  return { storage: 'session' };
}

export async function clearHrApiKey(): Promise<void> {
  assertClient();
  sessionKey = null;
  if (isTauri()) {
    await keychainDelete(HR_API_KEY_KEYCHAIN_KEY);
  }
}

// 저장 후 화면에는 끝 4자리만 보인다(§7.14). 앞부분 길이도 드러내지 않도록 고정 4글자로 가린다.
export function maskApiKey(key: string): string {
  const MASK = '••••';
  if (key.length <= 4) return MASK;
  return MASK + key.slice(-4);
}
