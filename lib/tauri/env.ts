// Tauri WebView 판별 (SOT §14.1).
// 브라우저 개발 모드(next dev를 브라우저로 열람)에서는 딥링크·키체인이 없으므로
// 호출부가 이 함수로 폴백 분기한다.
// @tauri-apps/api를 import하지 않고 주입 전역만 확인한다 — SSR(서버 컴포넌트) 안전.

export function isTauri(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
}
