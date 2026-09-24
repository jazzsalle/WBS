// 화면 헤더의 `?` (SOT §7.16 HP-4) — 해당 화면의 도움말 절(/help#<slug>)로 간다.
// 인쇄물에 `?`가 찍힐 이유가 없다 — print:hidden.

import Link from 'next/link';
import type { HelpSlug } from '@/lib/help';
import { HELP_TITLES } from '@/lib/help';

export interface HelpLinkProps {
  slug: HelpSlug;
  className?: string;
}

export default function HelpLink({ slug, className = '' }: HelpLinkProps) {
  const label = `도움말: ${HELP_TITLES[slug]}`;
  return (
    <Link
      href={`/help#${slug}`}
      title="도움말"
      aria-label={label}
      className={`inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-grey-100 text-t7 font-bold text-grey-600 transition hover:bg-grey-200 print:hidden ${className}`}
    >
      ?
    </Link>
  );
}
