// 간트 화면 (SOT §7.5, §7.1)
// 데이터 로딩은 서버에서만 한다 — 액션(actions/)만 호출하고 supabase는 직접 부르지 않는다.
// 진척률·WBS 코드·날짜 롤업은 전부 서버 계산값이다(저장하지 않는다, §6.1 O-4, §6.1.1).
// 오늘 기준선의 기준일도 서버가 Asia/Seoul 달력으로 고정해 내려준다 (§6.5) —
// 클라이언트가 new Date()로 오늘을 만들면 서버 OS 타임존·SSR/CSR에 따라 선이 하루씩 밀린다.
// 실패는 조용히 삼키지 않고 ErrorBanner로 code별 안내를 띄운다 (§9).

import { redirect } from 'next/navigation';
import { getCurrentUser } from '@/actions/auth';
import { getGanttData } from '@/actions/gantt';
import ErrorBanner from '@/components/ui/ErrorBanner';
import RealtimeRefresher from '@/components/RealtimeRefresher';
import GanttChart from '@/components/gantt/GanttChart';

// R-1 §8.5 구독표의 "WBS / 간트 / 보드" 행 그대로. 전체 구독 금지.
// milestones는 이 행에 없다 — 상단 마일스톤 레인은 남이 마일스톤을 바꿔도 즉시 다시 그려지지
// 않는다. 대신 마일스톤을 고친 쪽이 revalidatePath로 과제 경로를 무효화하므로 다음 이동·
// 새로고침에 반영된다. 구독표를 바꾸려면 SOT §8.5부터 고쳐야 한다.
const REALTIME_TABLES = ['tasks', 'years'];

// 간트는 좌측 패널 + 시간축이라 WBS와 같은 넓은 폭을 쓴다 (§12 반응형)
const CONTENT_CLASS = 'mx-auto max-w-[1600px] p-8';

interface GanttPageProps {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ scale?: string | string[] }>;
}

export default async function GanttPage({ params, searchParams }: GanttPageProps) {
  const { id: projectId } = await params;
  const { scale } = await searchParams;
  const requestedScale = Array.isArray(scale) ? scale[0] : scale;

  const me = await getCurrentUser();
  // 미들웨어가 이미 거르지만, 세션 만료 직후 직접 접근을 방어한다 (A-4)
  if (!me.ok) redirect('/login');

  // 기본은 주 스케일 — 연차(보통 12개월) 단위 과제가 한 화면에 들어오는 배율이다
  const data = await getGanttData(projectId, requestedScale ?? 'week');
  // 절대 규칙 5: 빈 트리로 대체하면 작업이 삭제된 것처럼 보인다. 실패는 그대로 알린다.
  if (!data.ok) {
    return (
      <main className={CONTENT_CLASS}>
        <ErrorBanner message={data.error} code={data.code} />
      </main>
    );
  }

  if (data.data.years.length === 0) {
    return (
      <main className={CONTENT_CLASS}>
        <h1 className="mb-4 text-xl font-bold">간트</h1>
        <p className="rounded-xl border border-dashed border-grey-300 p-10 text-center text-sm text-grey-500">
          아직 연차가 없습니다. 과제 개요에서 단계와 연차를 먼저 만드세요.
        </p>
      </main>
    );
  }

  return (
    <main className={CONTENT_CLASS}>
      <RealtimeRefresher tables={REALTIME_TABLES} selfUserId={me.data.id} />

      <h1 className="mb-4 text-xl font-bold">간트</h1>

      <GanttChart data={data.data} />
    </main>
  );
}
