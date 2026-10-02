// 화면 헤더의 `?` (SOT §7.16 HP-4) — 해당 화면의 도움말(/help#<slug>)로 간다.
// 한 편 안에 화면이 여럿이면(연구비 제안·수행) `anchor`로 그 절 제목을 지정해 절까지 내려간다.
// 인쇄물에 `?`가 찍힐 이유가 없다 — print:hidden.

import Link from 'next/link';
import type { HelpSlug } from '@/lib/help';
import { HELP_TITLES, helpHref } from '@/lib/help';

export interface HelpLinkProps {
  slug: HelpSlug;
  /** 도움말 본문의 절 제목(`##`/`###` 원문 그대로). tests/unit/help-content.test.ts가 실재 여부를 검사한다 */
  anchor?: string;
  className?: string;
}

export default function HelpLink({ slug, anchor, className = '' }: HelpLinkProps) {
  const label = anchor ? `도움말: ${HELP_TITLES[slug]} — ${anchor}` : `도움말: ${HELP_TITLES[slug]}`;
  return (
    <Link
      href={helpHref(slug, anchor)}
      title="도움말"
      aria-label={label}
      className={`inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-grey-100 text-t7 font-bold text-grey-600 transition hover:bg-grey-200 print:hidden ${className}`}
    >
      ?
    </Link>
  );
}
