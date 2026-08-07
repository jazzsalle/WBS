// 과제 하위 공통 레이아웃 (SOT §7.1 "과제 하위 화면은 공통 레이아웃 + 탭 네비게이션을 공유한다")
// 여기서는 화면 뼈대(브레드크럼 + 탭)만 담당한다. 과제 데이터를 여기서 읽지 않는 이유는
// 탭마다 필요한 조회가 달라서다 — 각 탭 페이지가 자기 조회를 하고 제목·본문을 그린다.
// Realtime 구독표(§8.5)도 화면마다 다르므로 레이아웃이 아니라 각 페이지가 마운트한다.
// 페이지가 <main>을 직접 렌더하도록 폭 제약을 걸지 않는다(WBS·간트는 넓은 폭을 쓴다).

import { redirect } from 'next/navigation';
import Link from 'next/link';
import type { ReactNode } from 'react';
import { getCurrentUser } from '@/actions/auth';
import TabNav from '@/components/project/TabNav';

export default async function ProjectLayout({
  children,
  params,
}: {
  children: ReactNode;
  params: Promise<{ id: string }>;
}) {
  const me = await getCurrentUser();
  // 미들웨어가 이미 거르지만, 세션 만료 직후 직접 접근을 방어한다 (A-4)
  if (!me.ok) redirect('/login');

  const { id } = await params;

  return (
    <div className="min-h-screen">
      {/* §12 P-R4: 브레드크럼·탭은 화면 이동 수단이다. 인쇄물에 남기지 않는다 */}
      <header className="border-b border-slate-200 bg-white print:hidden">
        <div className="mx-auto max-w-7xl px-8 pt-6">
          <nav aria-label="위치" className="flex items-center gap-2 text-xs text-slate-500">
            <Link href="/" className="hover:text-slate-700 hover:underline">
              대시보드
            </Link>
            <span aria-hidden>/</span>
            <Link href="/projects" className="hover:text-slate-700 hover:underline">
              과제 목록
            </Link>
          </nav>

          <div className="mt-3">
            <TabNav projectId={id} />
          </div>
        </div>
      </header>

      {children}
    </div>
  );
}
