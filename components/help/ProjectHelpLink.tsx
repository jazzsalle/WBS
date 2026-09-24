'use client';

// 과제 헤더의 `?` (SOT §7.16 HP-4) — 탭이 바뀌면 slug도 바뀐다(/projects/[id]/wbs → wbs).
// 과제 레이아웃은 서버 컴포넌트라 현재 탭을 모르므로, 경로는 클라이언트에서 읽는다.

import { usePathname } from 'next/navigation';
import { helpSlugForPath } from '@/lib/help';
import HelpLink from './HelpLink';

export default function ProjectHelpLink({ className }: { className?: string }) {
  const pathname = usePathname();
  // 레지스트리에 없는 하위 경로는 과제 개요 도움말로 보낸다 — `?`가 아예 사라지는 것보다 낫다
  const slug = helpSlugForPath(pathname) ?? 'project';
  return <HelpLink slug={slug} className={className} />;
}
