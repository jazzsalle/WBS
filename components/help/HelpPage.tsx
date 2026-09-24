'use client';

// 도움말 페이지 본문 (SOT §7.16 HP-4·HP-6) — 좌측 목차 + 우측 절 17개.
// 해시(/help#wbs)로 절을 찾아 스크롤하고 잠깐 강조한다 — 화면 `?`에서 온 사용자가
// "어디를 보라는 건지" 바로 알게. 본문 AST는 서버가 만들었고 여기서는 MarkdownViewer로만 그린다(HP-2).
// 데이터가 없으므로 Realtime·DB 없음(HP-5).

import { useEffect, useState } from 'react';
import type { HelpDocument } from '@/lib/content';
import type { HelpSlug } from '@/lib/help';
import { HELP_RELATED, HELP_TITLES, HELP_TOC_GROUPS, isHelpSlug } from '@/lib/help';
import MarkdownViewer from '@/components/notes/MarkdownViewer';

/** 강조가 사라지는 시간. 눈에 띌 만큼만 — 계속 남으면 다른 절을 읽을 때 방해된다 */
const HIGHLIGHT_MS = 2000;

function slugFromHash(hash: string): HelpSlug | null {
  const raw = decodeURIComponent(hash.replace(/^#/, ''));
  return isHelpSlug(raw) ? raw : null;
}

export interface HelpPageProps {
  documents: HelpDocument[];
}

export default function HelpPage({ documents }: HelpPageProps) {
  const [active, setActive] = useState<HelpSlug | null>(null);

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const focusFromHash = (): void => {
      const slug = slugFromHash(window.location.hash);
      if (!slug) return;
      // 브라우저의 기본 해시 점프는 sticky 목차·레이아웃 시프트 뒤에 어긋날 수 있어 직접 스크롤한다
      document.getElementById(slug)?.scrollIntoView({ block: 'start' });
      setActive(slug);
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => setActive(null), HIGHLIGHT_MS);
    };
    focusFromHash();
    window.addEventListener('hashchange', focusFromHash);
    return () => {
      window.removeEventListener('hashchange', focusFromHash);
      if (timer) clearTimeout(timer);
    };
  }, []);

  return (
    <div className="flex gap-10">
      <nav
        aria-label="도움말 목차"
        className="sticky top-8 hidden h-fit w-48 shrink-0 self-start md:block print:hidden"
      >
        {HELP_TOC_GROUPS.map((group) => (
          <div key={group.label} className="mb-5">
            <p className="mb-1.5 text-t7 font-semibold text-grey-500">{group.label}</p>
            <ul className="space-y-0.5">
              {group.slugs.map((slug) => (
                <li key={slug}>
                  <a
                    href={`#${slug}`}
                    className={`block rounded-md px-2 py-1 text-t6 transition hover:bg-grey-100 ${
                      active === slug ? 'bg-blue-50 font-semibold text-blue-600' : 'text-grey-700'
                    }`}
                  >
                    {HELP_TITLES[slug]}
                  </a>
                </li>
              ))}
            </ul>
          </div>
        ))}
      </nav>

      <div className="min-w-0 flex-1 space-y-4">
        {documents.map((doc) => {
          const related = HELP_RELATED[doc.slug] ?? [];
          return (
            <section
              key={doc.slug}
              id={doc.slug}
              // scroll-mt: 스크롤 도착 지점이 화면 위 모서리에 딱 붙지 않게
              className={`scroll-mt-6 rounded-xl border border-grey-200 bg-surface p-6 transition-shadow duration-500 ${
                active === doc.slug ? 'ring-2 ring-blue-200' : ''
              }`}
            >
              <h2 className="text-t3 font-bold text-grey-900">{doc.title}</h2>
              <p className="mt-2 border-l-4 border-blue-200 pl-3 text-t6 text-grey-600">
                언제 쓰나: {doc.intro}
              </p>
              {/* 1행(제목)·2행(intro)은 위에 따로 그렸으므로 AST에서는 뺀다 */}
              <MarkdownViewer blocks={doc.blocks.slice(2)} emptyText="본문이 아직 없습니다." />
              {related.length > 0 && (
                <p className="mt-4 border-t border-grey-100 pt-3 text-t7 text-grey-500">
                  관련 도움말:{' '}
                  {related.map((slug, index) => (
                    <span key={slug}>
                      {index > 0 && ' · '}
                      <a href={`#${slug}`} className="text-blue-600 underline underline-offset-2 hover:text-blue-700">
                        {HELP_TITLES[slug]}
                      </a>
                    </span>
                  ))}
                </p>
              )}
            </section>
          );
        })}
      </div>
    </div>
  );
}
