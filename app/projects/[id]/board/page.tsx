// 칸반 / 우선순위 매트릭스 화면 (SOT §7.6, §7.1)
// 데이터 로딩은 서버에서만 한다 — 액션(actions/)만 호출하고 supabase는 직접 부르지 않는다.
// 진척률·WBS 코드·긴급도·우선순위 점수는 전부 서버 계산값이다(저장하지 않는다, O-4·PR-7).
// 실패는 조용히 삼키지 않고 ErrorBanner로 code별 안내를 띄운다 (§9).

import { redirect } from 'next/navigation';
import { getCurrentUser } from '@/actions/auth';
import { getBoardData, getPriorityMatrix } from '@/actions/board';
import { getTeam } from '@/actions/team';
import ErrorBanner from '@/components/ui/ErrorBanner';
import RealtimeRefresher from '@/components/RealtimeRefresher';
import BoardScreen from '@/components/board/BoardScreen';

// R-1 §8.5 구독표의 "WBS / 간트 / 보드" 행 그대로. 전체 구독 금지.
// members·organizations는 구독표에 없다 — 남이 인력·기관 이름을 바꿔도 이 화면은 즉시 다시
// 그려지지 않지만, 바꾼 쪽이 revalidatePath로 이 경로를 무효화하므로 다음 이동·새로고침에 반영된다.
const REALTIME_TABLES = ['tasks', 'years'];

// 컬럼 4개가 가로로 늘어서므로 WBS와 같은 넓은 폭을 쓴다 (§12 반응형)
const CONTENT_CLASS = 'mx-auto max-w-[1600px] p-8';

interface BoardPageProps {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ yearId?: string | string[] }>;
}

export default async function BoardPage({ params, searchParams }: BoardPageProps) {
  const { id: projectId } = await params;
  const { yearId } = await searchParams;
  const requestedYearId = Array.isArray(yearId) ? yearId[0] : yearId;

  const me = await getCurrentUser();
  // 미들웨어가 이미 거르지만, 세션 만료 직후 직접 접근을 방어한다 (A-4)
  if (!me.ok) redirect('/login');

  // 두 조회 모델(§9)은 같은 연차 인자를 받아 같은 연차를 고른다 — 뷰를 바꿔도 필터가 흔들리지 않는다.
  // 담당·기관 이름은 팀 조회에서 온다(구독표에 없는 테이블이라 이름 갱신은 다음 새로고침에 따라온다).
  const [board, matrix, team] = await Promise.all([
    getBoardData(projectId, requestedYearId),
    getPriorityMatrix(projectId, requestedYearId),
    getTeam(projectId),
  ]);

  // 절대 규칙 5: 빈 보드로 대체하면 작업이 사라진 것처럼 보인다. 실패는 그대로 알린다.
  if (!board.ok) {
    return (
      <main className={CONTENT_CLASS}>
        <ErrorBanner message={board.error} code={board.code} />
      </main>
    );
  }
  if (!matrix.ok) {
    return (
      <main className={CONTENT_CLASS}>
        <ErrorBanner message={matrix.error} code={matrix.code} />
      </main>
    );
  }
  // 인력·기관을 못 읽었다고 빈 목록으로 넘기면 배정된 담당자가 화면에서 사라진 것처럼 보인다
  if (!team.ok) {
    return (
      <main className={CONTENT_CLASS}>
        <ErrorBanner message={team.error} code={team.code} />
      </main>
    );
  }

  if (board.data.years.length === 0) {
    return (
      <main className={CONTENT_CLASS}>
        <p className="rounded-xl border border-dashed border-slate-300 p-10 text-center text-sm text-slate-500">
          아직 연차가 없습니다. 과제 개요에서 단계와 연차를 먼저 만드세요.
        </p>
      </main>
    );
  }

  return (
    <main className={CONTENT_CLASS}>
      <RealtimeRefresher tables={REALTIME_TABLES} selfUserId={me.data.id} />

      <h1 className="mb-4 text-xl font-bold">칸반 / 우선순위 매트릭스</h1>

      <BoardScreen
        board={board.data}
        matrix={matrix.data}
        members={team.data.members}
        organizations={team.data.organizations}
      />
    </main>
  );
}
