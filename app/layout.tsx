import type { Metadata } from "next";
import "./globals.css";

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
        {children}
      </body>
    </html>
  );
}
