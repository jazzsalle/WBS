// HR API 키 보관 계층 테스트 (SOT §6.13.3 HR-10~HR-12, §7.14)
// 비Tauri에서는 세션 메모리로만 유지하고 그 사실(storage: 'session')을 돌려주는지,
// Tauri에서는 키체인 항목 'wbs.hr-api-key'로 오가는지, 서버에서 부르면 막히는지를 증명한다.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { clearHrApiKey, loadHrApiKey, maskApiKey, saveHrApiKey } from '@/lib/hr-key';

// Rust 셸 keychain_* 커맨드를 인메모리로 흉내 낸다 — lib/tauri/keychain.ts는 실제 코드를 탄다
const fakeKeychain = new Map<string, string>();
vi.mock('@tauri-apps/api/core', () => ({
  invoke: async (cmd: string, args: { key: string; value?: string }) => {
    switch (cmd) {
      case 'keychain_get':
        return fakeKeychain.get(args.key) ?? null;
      case 'keychain_set':
        fakeKeychain.set(args.key, args.value ?? '');
        return undefined;
      case 'keychain_delete':
        fakeKeychain.delete(args.key);
        return undefined;
      default:
        throw new Error(`unknown cmd ${cmd}`);
    }
  },
}));

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  fakeKeychain.clear();
});

describe('비Tauri(브라우저 개발 모드) — 세션 메모리', () => {
  beforeEach(async () => {
    vi.stubGlobal('window', {});
    vi.spyOn(console, 'warn').mockImplementation(() => {}); // keychain.ts의 not-tauri 경고
    await clearHrApiKey();
  });

  it('처음에는 키가 없고 storage는 session이다', async () => {
    expect(await loadHrApiKey()).toEqual({ key: null, storage: 'session' });
  });

  it('save→load가 storage: session으로 값을 돌려준다 (조용한 no-op이 아니다)', async () => {
    expect(await saveHrApiKey('  hr_live_abc123  ')).toEqual({ storage: 'session' });
    expect(await loadHrApiKey()).toEqual({ key: 'hr_live_abc123', storage: 'session' });
  });

  it('clear 후에는 null이다', async () => {
    await saveHrApiKey('hr_live_abc123');
    await clearHrApiKey();
    expect(await loadHrApiKey()).toEqual({ key: null, storage: 'session' });
  });

  it('빈 키(공백만)는 저장하지 않고 예외를 던진다', async () => {
    await expect(saveHrApiKey('   ')).rejects.toThrow('비어');
    await expect(saveHrApiKey('')).rejects.toThrow();
    expect(await loadHrApiKey()).toEqual({ key: null, storage: 'session' });
  });
});

describe('Tauri — OS 키체인', () => {
  beforeEach(async () => {
    vi.stubGlobal('window', { __TAURI_INTERNALS__: {} });
    await clearHrApiKey();
  });

  it("키체인 항목 'wbs.hr-api-key'에 저장하고 storage: keychain으로 읽는다", async () => {
    expect(await saveHrApiKey('hr_live_abc123')).toEqual({ storage: 'keychain' });
    expect(fakeKeychain.get('wbs.hr-api-key')).toBe('hr_live_abc123');
    expect(await loadHrApiKey()).toEqual({ key: 'hr_live_abc123', storage: 'keychain' });
  });

  it('clear가 키체인 항목을 지운다', async () => {
    await saveHrApiKey('hr_live_abc123');
    await clearHrApiKey();
    expect(fakeKeychain.has('wbs.hr-api-key')).toBe(false);
    expect(await loadHrApiKey()).toEqual({ key: null, storage: 'keychain' });
  });

  it('Supabase 세션 토큰 항목과 이름이 겹치지 않는다', async () => {
    fakeKeychain.set('sb-test-auth-token', 'token');
    await saveHrApiKey('hr_live_abc123');
    expect(fakeKeychain.get('sb-test-auth-token')).toBe('token');
    expect(fakeKeychain.size).toBe(2);
  });
});

describe('서버 가드 — window가 없으면 명시적 예외', () => {
  it('load/save/clear 모두 서버에서는 던진다', async () => {
    expect(typeof window).toBe('undefined');
    await expect(loadHrApiKey()).rejects.toThrow('클라이언트');
    await expect(saveHrApiKey('hr_live_abc123')).rejects.toThrow('클라이언트');
    await expect(clearHrApiKey()).rejects.toThrow('클라이언트');
  });
});

describe('maskApiKey — 끝 4자리만 노출', () => {
  it('앞부분은 고정 4글자로 가리고 끝 4자리만 남긴다', () => {
    const masked = maskApiKey('abcdefgh1234');
    expect(masked).toBe('••••1234');
    expect(masked).not.toContain('abcdefgh');
    expect(masked.endsWith('1234')).toBe(true);
  });

  it('4자 이하는 전부 가린다', () => {
    expect(maskApiKey('abcd')).toBe('••••');
    expect(maskApiKey('ab')).toBe('••••');
    expect(maskApiKey('')).toBe('••••');
  });

  it('가린 결과에서 원문 길이를 알 수 없다', () => {
    expect(maskApiKey('x'.repeat(40) + '9876')).toBe('••••9876');
  });
});
