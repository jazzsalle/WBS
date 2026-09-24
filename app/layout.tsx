import type { Metadata } from "next";
import Script from "next/script";
import "./globals.css";
import DeepLinkListener from "@/components/auth/DeepLinkListener";
import AppBootstrap from "@/components/AppBootstrap";
import { LOCAL_CONFIG_STORAGE_KEY } from "@/lib/local-config";
import { THEME_ATTRIBUTE } from "@/lib/theme";

// §7.19 마운트 전 깜빡임 방지 스크립트. 브라우저 모드의 localStorage에서 LocalConfig를 읽어
// theme이 light/dark면 <html data-theme>를 세팅하고, 아니면(system·없음·손상) 지운다 —
// 그러면 CSS의 prefers-color-scheme 분기가 맡는다. 실패는 전부 삼킨다: 여기서 던지면
// 첫 페인트가 막히고, 잘못된 값의 복구·보고는 lib/local-config가 마운트 후 따로 한다.
// Tauri는 config가 파일이라 이 스크립트가 못 읽는다 → AppBootstrap이 로드 후 applyTheme.
//
// (이전에는 script 속성 직접 주입을 썼다) CLAUDE.md의 금지는 "노트 경로"(사용자 입력 마크다운)
// 한정이다. 이 문자열은 빌드 시점에 고정된 상수 두 개(저장 키·속성 이름)만 끼워 넣은
// 정적 코드이며 사용자 입력이 섞일 경로가 없다.
const THEME_BOOT_SCRIPT = `(function(){try{var k=${JSON.stringify(LOCAL_CONFIG_STORAGE_KEY)},a=${JSON.stringify(THEME_ATTRIBUTE)},r=localStorage.getItem(k),t=r?JSON.parse(r).theme:null,e=document.documentElement;if(t==='light'||t==='dark')e.setAttribute(a,t);else e.removeAttribute(a)}catch(_){}})();`;

export const metadata: Metadata = {
  title: "R&D 과제 관리",
  description: "국가 R&D 과제 WBS·목표·예산 관리 도구",
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  // suppressHydrationWarning: 위 스크립트가 서버 HTML에 없는 data-theme을 마운트 전에 붙인다
  return (
    <html lang="ko" suppressHydrationWarning>
      <head>
        {/* next/script beforeInteractive: 인라인 문자열을 hydration 전에 <head>에 넣는다.
            정적 상수라 사용자 입력이 아니며, 노트 경로의 HTML 주입 금지(CLAUDE.md)와 무관하다 —
            그래도 그 속성 자체는 쓰지 않아 정적 검사(help-content.test)가 그대로 유지된다 */}
        <Script id="theme-boot" strategy="beforeInteractive">
          {THEME_BOOT_SCRIPT}
        </Script>
      </head>
      <body className="min-h-screen bg-screen font-sans text-grey-900 antialiased">
        {/* 인증 부트스트랩: 키체인 storage 주입 + wbs:// 딥링크 수신 + 세션 복원 (§7.0, A-1·A-4) */}
        <DeepLinkListener />
        {/* 시작 부트스트랩: 헬스핑(F-2) + 스키마 버전 게이트(§8.8) + 자동 백업(K-2·K-3) */}
        <AppBootstrap />
        {children}
      </body>
    </html>
  );
}
