// 화면 모드 적용 (SOT §7.19, 부록 E.5)
// LocalConfig.theme → <html data-theme>. 부록 E.5의 다크 팔레트가 [data-theme="dark"]와
// prefers-color-scheme: dark(:root:not([data-theme="light"]))에서 --color-*를 재정의하므로,
// 여기서는 속성 하나만 다루고 컴포넌트 클래스는 손대지 않는다.
// 순수 함수(resolveThemeAttribute)와 DOM 적용(applyTheme)을 나눈다 — 앞쪽만 테스트한다.

import type { ThemeMode } from '@/types';

export const THEME_ATTRIBUTE = 'data-theme';

export const THEME_LABELS: Record<ThemeMode, string> = {
  system: '시스템',
  light: '밝게',
  dark: '어둡게',
};

/**
 * system은 null — 속성을 지워 CSS의 prefers-color-scheme 분기에 맡긴다.
 * 그래서 OS 모드가 바뀌어도 JS가 다시 개입할 필요가 없다.
 */
export function resolveThemeAttribute(theme: ThemeMode): 'light' | 'dark' | null {
  return theme === 'system' ? null : theme;
}

/** 클라이언트 전용. 서버에서는 document가 없으므로 아무 것도 하지 않는다. */
export function applyTheme(theme: ThemeMode): void {
  if (typeof document === 'undefined') return;
  const value = resolveThemeAttribute(theme);
  const root = document.documentElement;
  if (value === null) root.removeAttribute(THEME_ATTRIBUTE);
  else root.setAttribute(THEME_ATTRIBUTE, value);
}
