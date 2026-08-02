// wbs:// 딥링크 수신 래퍼 (SOT §14.2 A-1).
// Rust 셸의 deep-link 플러그인이 발행하는 이벤트를 프론트 콜백으로 노출한다.
// 두 번째 실행의 딥링크는 single-instance 플러그인이 같은 이벤트로 이어준다.
// 플러그인 모듈은 동적 import — Tauri 밖(브라우저 개발 모드)에서 번들이 터지지 않게 한다.

import { isTauri } from './env';

export type DeepLinkHandler = (urls: string[]) => void;

/**
 * 딥링크 수신 구독. 해제 함수를 반환한다.
 * Tauri 환경이 아니면 구독하지 않고 no-op 해제 함수를 반환한다 (콘솔로 명시).
 */
export async function onDeepLink(handler: DeepLinkHandler): Promise<() => void> {
  if (!isTauri()) {
    console.info('[deep-link] Tauri 환경이 아니므로 딥링크 구독 생략 (브라우저 개발 모드)');
    return () => {};
  }
  const { onOpenUrl } = await import('@tauri-apps/plugin-deep-link');
  return onOpenUrl((urls) => {
    // wbs://auth-callback?... 도달 검증용 로그. 토큰이 포함될 수 있어 URL 자체는 찍지 않는다
    console.info(`[deep-link] 딥링크 ${urls.length}건 수신`);
    handler(urls);
  });
}

/**
 * 앱이 딥링크로 시작(cold start)된 경우의 URL. 없으면 null.
 * onDeepLink 구독 전에 도착한 콜백을 놓치지 않기 위해 진입 시 한 번 확인한다.
 */
export async function getInitialDeepLink(): Promise<string[] | null> {
  if (!isTauri()) return null;
  const { getCurrent } = await import('@tauri-apps/plugin-deep-link');
  return getCurrent();
}
