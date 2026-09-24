// 도움말 페이지 (SOT §7.16, §7.1)
// 본문은 content/help/*.md를 서버가 fs로 읽어 AST로 내린다(HP-1·HP-2). 데이터가 없으므로
// DB·Realtime 조회가 없다(HP-5) — 그래도 인증 뒤에만 연다(미들웨어 + 페이지 가드).
// 17편 중 하나라도 못 읽으면 어느 slug인지 배너로 보인다 — 빈 절로 대체하지 않는다(절대 규칙 5).

import { redirect } from 'next/navigation';
import Link from 'next/link';
import { requireApprovedUser } from '@/lib/auth/guard';
import { HELP_SLUGS } from '@/lib/help';
import type { HelpDocument } from '@/lib/content';
import { readHelpDocument } from '@/lib/content';
import ErrorBanner from '@/components/ui/ErrorBanner';
import HelpPage from '@/components/help/HelpPage';

const CONTENT_CLASS = 'mx-auto max-w-6xl p-8';

export default async function HelpRoute() {
  try {
    await requireApprovedUser();
  } catch {
    // 미들웨어가 이미 거르지만, 세션 만료 직후 직접 접근을 방어한다 (A-4)
    redirect('/login');
  }

  const results = await Promise.allSettled(HELP_SLUGS.map((slug) => readHelpDocument(slug)));
  const documents: HelpDocument[] = [];
  const failures: string[] = [];
  results.forEach((result, index) => {
    if (result.status === 'fulfilled') {
      documents.push(result.value);
    } else {
      const reason = result.reason instanceof Error ? result.reason.message : String(result.reason);
      failures.push(`${HELP_SLUGS[index]}: ${reason}`);
    }
  });

  return (
    <main className={CONTENT_CLASS}>
      <div className="mb-6 flex items-center justify-between">
        <div>
          <h1 className="text-t2 font-bold text-grey-900">도움말</h1>
          <p className="mt-1 text-t7 text-grey-500">
            화면별 사용법과 계산 방식. 각 화면의 <span className="font-semibold">?</span> 버튼이 해당 절로 옵니다.
          </p>
        </div>
        <Link href="/" className="text-sm text-grey-500 underline hover:text-grey-700 print:hidden">
          홈으로
        </Link>
      </div>

      {failures.length > 0 && (
        <ErrorBanner
          className="mb-6"
          message={`도움말 ${failures.length}편을 읽지 못했습니다 — ${failures.join(' / ')}`}
        />
      )}

      <HelpPage documents={documents} />
    </main>
  );
}
