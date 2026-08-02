import type { Metadata } from "next";
import "./globals.css";
import DeepLinkListener from "@/components/auth/DeepLinkListener";
import AppBootstrap from "@/components/AppBootstrap";

export const metadata: Metadata = {
  title: "R&D 과제 관리",
  description: "국가 R&D 과제 WBS·목표·예산 관리 도구",
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="ko">
      <body className="min-h-screen bg-slate-50 text-slate-900 antialiased">
        {/* 인증 부트스트랩: 키체인 storage 주입 + wbs:// 딥링크 수신 + 세션 복원 (§7.0, A-1·A-4) */}
        <DeepLinkListener />
        {/* 시작 부트스트랩: 헬스핑(F-2) + 스키마 버전 게이트(§8.8) + 자동 백업(K-2·K-3) */}
        <AppBootstrap />
        {children}
      </body>
    </html>
  );
}
