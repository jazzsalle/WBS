// To-Do 화면 (SOT §7.13, §7.1)
// 데이터 로딩은 서버에서만 한다 — 액션(actions/todos.ts)만 호출하고 supabase는 직접 부르지 않는다.
// 기준일은 getTodosData가 서버에서 Asia/Seoul 달력으로 한 번 계산한 값(todayISO)을 그대로 내린다:
// 클라이언트가 new Date()로 오늘을 다시 만들면 서버 OS 타임존·SSR/CSR에 따라 날짜가 갈려
// 대시보드 "오늘의 To-Do"(§7.2 6)와 건수가 조용히 어긋난다 (§7.13 서문, §6.5).
// 필터·정렬은 화면이 lib/todos.ts로 건다 — 액션은 거르지 않은 전체 목록을 준다 (T-D10).

import { redirect } from 'next/navigation';
import Link from 'next/link';
import { requireApprovedUser } from '@/lib/auth/guard';
import { getTodosData } from '@/actions/todos';
import ErrorBanner from '@/components/ui/ErrorBanner';
import RealtimeRefresher from '@/components/RealtimeRefresher';
import TodoScreen from '@/components/todos/TodoScreen';
import HelpLink from '@/components/help/HelpLink';

// R-1 §8.5 구독표의 "To-Do" 행 그대로 1개. 전체 구독 금지.
// projects는 구독표에 없다 — 남이 과제명을 바꿔도 이 화면은 즉시 다시 그려지지 않지만,
// 바꾼 쪽이 revalidatePath로 이 경로를 무효화하므로 다음 이동·새로고침에 반영된다.
const REALTIME_TABLES = ['todos'];

const CONTENT_CLASS = 'mx-auto max-w-5xl p-8';

export default async function TodosPage() {
  let ctx: Awaited<ReturnType<typeof requireApprovedUser>>;
  try {
    ctx = await requireApprovedUser();
  } catch {
    // 미들웨어가 이미 거르지만, 세션 만료 직후 직접 접근을 방어한다 (A-4)
    redirect('/login');
  }

  const todos = await getTodosData();
  // 절대 규칙 5: 빈 목록으로 대체하면 할 일이 전부 지워진 것처럼 보인다. 실패는 그대로 알린다.
  if (!todos.ok) {
    return (
      <main className={CONTENT_CLASS}>
        <ErrorBanner message={todos.error} code={todos.code} />
      </main>
    );
  }

  return (
    <main className={CONTENT_CLASS}>
      <RealtimeRefresher tables={REALTIME_TABLES} selfUserId={ctx.user.id} />

      <div className="mb-6 flex items-center justify-between">
        <div>
          <div className="flex items-center gap-2">
            <h1 className="text-2xl font-bold">To-Do</h1>
            <HelpLink slug="todos" />
          </div>
          {/* §7.13 소유권: 팀 공유다. "나만 본다"로 오해하면 남의 할 일을 지운다 */}
          <p className="mt-1 text-sm text-grey-500">
            과제 계층에 매이지 않는 할 일 목록입니다. 승인된 팀원 모두가 함께 보고 고칩니다 —
            진척률·달성률 계산에는 포함되지 않습니다.
          </p>
        </div>
        <Link href="/" className="shrink-0 text-sm text-grey-500 underline hover:text-grey-700">
          홈으로
        </Link>
      </div>

      <TodoScreen data={todos.data} todayISO={todos.data.todayISO} />
    </main>
  );
}
