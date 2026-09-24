// 과제 목록 (SOT §7.15, §7.1)
// 데이터 로딩은 서버에서 — 액션(actions/)만 호출하고 supabase는 직접 부르지 않는다.
// 아카이브 토글은 클라이언트 상태이므로 여기서는 아카이브 포함 전체를 한 번 가져오고
// 목록 컴포넌트가 거른다 (§7.15 "기본 숨김, 토글로 표시").
// 실패는 조용히 삼키지 않고 ErrorBanner로 code별 안내를 띄운다 (§9).

import { redirect } from 'next/navigation';
import Link from 'next/link';
import { getCurrentUser } from '@/actions/auth';
import { getProjectsSummary } from '@/actions/projects';
import ErrorBanner from '@/components/ui/ErrorBanner';
import ProjectList from '@/components/project/ProjectList';
import RealtimeRefresher from '@/components/RealtimeRefresher';

// R-1 §8.5 구독표: 이 화면의 카드는 projects(협약정보·상태) + years(현재 연차 뱃지)
// + tasks(진척률 롤업)에서 파생된다. 그 밖의 테이블은 구독하지 않는다.
const REALTIME_TABLES = ['projects', 'years', 'tasks'];

export default async function ProjectsPage() {
  const me = await getCurrentUser();
  // 미들웨어가 이미 거르지만, 세션 만료 직후 직접 접근을 방어한다 (A-4)
  if (!me.ok) redirect('/login');

  const res = await getProjectsSummary(true);

  return (
    <main className="mx-auto max-w-6xl p-8">
      <div className="mb-6 flex items-center justify-between">
        <h1 className="text-2xl font-bold">과제</h1>
        <div className="flex items-center gap-4 text-sm text-grey-500">
          <Link href="/" className="underline hover:text-grey-700">
            대시보드
          </Link>
          <Link href="/settings" className="underline hover:text-grey-700">
            설정
          </Link>
        </div>
      </div>

      {res.ok ? (
        <>
          <RealtimeRefresher tables={REALTIME_TABLES} selfUserId={me.data.id} />
          <ProjectList summaries={res.data} />
        </>
      ) : (
        <ErrorBanner message={res.error} code={res.code} />
      )}
    </main>
  );
}
