'use client';

// 개인 설정 — 화면 모드 (SOT §7.14, §7.19)
// LocalConfig.theme은 이 PC의 파일/localStorage라 서버가 모른다 — 마운트 후 읽는다
// (TutorialResetPanel과 같은 패턴, SSR 불일치 방지). 라디오를 고르는 즉시 저장하고
// <html data-theme>를 바꾼다. DB에는 아무것도 쓰지 않는다.

import { useEffect, useState } from 'react';
import type { ThemeMode } from '@/types';
import { THEME_MODES, loadLocalConfig, updateLocalConfig } from '@/lib/local-config';
import { THEME_LABELS, applyTheme } from '@/lib/theme';

const toMessage = (e: unknown) => (e instanceof Error ? e.message : String(e));

const DESCRIPTIONS: Record<ThemeMode, string> = {
  system: 'OS의 밝게/어둡게 설정을 따릅니다',
  light: '항상 밝은 화면',
  dark: '항상 어두운 화면',
};

export default function ThemePanel() {
  const [theme, setTheme] = useState<ThemeMode | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    loadLocalConfig()
      .then((config) => setTheme(config.theme))
      .catch((e) => setError(`로컬 설정을 읽지 못했습니다: ${toMessage(e)}`));
  }, []);

  const handleChange = async (next: ThemeMode) => {
    if (busy || next === theme) return;
    setBusy(true);
    setError(null);
    // 저장보다 먼저 적용한다 — 저장이 실패해도 화면은 고른 대로 보이고, 오류는 아래에 남긴다
    applyTheme(next);
    setTheme(next);
    try {
      await updateLocalConfig({ theme: next });
    } catch (e) {
      setError(`설정을 저장하지 못했습니다 (다음 실행 때 되돌아갑니다): ${toMessage(e)}`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="mt-8 rounded-2xl border border-grey-200 bg-surface p-6">
      <h2 className="text-t5 font-bold text-grey-900">개인 설정 — 화면 모드</h2>
      <p className="mt-1 text-t7 text-grey-500">
        이 PC에만 저장됩니다. 인쇄는 항상 밝은 화면입니다.
      </p>

      {error && (
        <p role="alert" className="mt-4 rounded-lg border border-red-100 bg-red-50 p-3 text-t7 text-red-700">
          {error}
        </p>
      )}

      <fieldset className="mt-4" disabled={theme === null}>
        <legend className="sr-only">화면 모드</legend>
        <div className="flex flex-col gap-2 sm:flex-row sm:gap-3">
          {THEME_MODES.map((mode) => {
            const checked = theme === mode;
            return (
              <label
                key={mode}
                className={`flex flex-1 cursor-pointer items-start gap-2 rounded-lg border px-3 py-2 text-t7 ${
                  checked
                    ? 'border-blue-500 bg-blue-50 text-grey-900'
                    : 'border-grey-200 text-grey-700 hover:bg-surface-grey'
                }`}
              >
                <input
                  type="radio"
                  name="theme"
                  value={mode}
                  checked={checked}
                  onChange={() => void handleChange(mode)}
                  className="mt-0.5"
                />
                <span>
                  <span className="font-medium">{THEME_LABELS[mode]}</span>
                  <span className="block text-grey-500">{DESCRIPTIONS[mode]}</span>
                </span>
              </label>
            );
          })}
        </div>
      </fieldset>
      {theme === null && !error && <p className="mt-2 text-t7 text-grey-500">읽는 중…</p>}
    </section>
  );
}
