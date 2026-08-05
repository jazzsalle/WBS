// 마일스톤 화면 (SOT §7.8, §7.1)
// 데이터 로딩은 서버에서만 한다 — 액션(actions/)만 호출하고 supabase는 직접 부르지 않는다.
// 지연·임박·D-day 판정 기준일(§6.5)은 여기서 Asia/Seoul 달력으로 한 번 고정해 내려준다.
// 클라이언트가 new Date()로 오늘을 다시 만들면 서버 OS 타임존·SSR/CSR에 따라 판정이 갈린다.
// 실패는 조용히 삼키지 않고 ErrorBanner로 code별 안내를 띄운다 (§9).

import { redirect } from 'next/navigation';
import { getCurrentUser } from '@/actions/auth';
import { getMilestonesData } from '@/actions/milestones';
import { getLinkedNotes } from '@/actions/notes';
import { todayISO } from '@/lib/dates';
import ErrorBanner from '@/components/ui/ErrorBanner';
import RealtimeRefresher from '@/components/RealtimeRefresher';
import MilestoneScreen from '@/components/milestones/MilestoneScreen';

// R-1 §8.5 구독표의 "마일스톤" 행 그대로 1개. 전체 구독 금지.
// years·members는 구독표에 없다 — 남이 연차·인력 이름을 바꿔도 이 화면은 즉시 다시 그려지지
// 않지만, 바꾼 쪽이 revalidatePath로 이 경로를 무효화하므로 다음 이동·새로고침에 반영된다.
const REALTIME_TABLES = ['milestones'];

const CONTENT_CLASS = 'mx-auto max-w-7xl p-8';

interface MilestonesPageProps {
  params: Promise<{ id: string }>;
}

export default async function MilestonesPage({ params }: MilestonesPageProps) {
  const { id: projectId } = await params;

  const me = await getCurrentUser();
  // 미들웨어가 이미 거르지만, 세션 만료 직후 직접 접근을 방어한다 (A-4)
  if (!me.ok) redirect('/login');

  // 행을 펼쳤을 때 보여줄 관련 노트(§7.12 역참조)도 같은 왕복에서 가져온다
  const [milestones, linkedNotes] = await Promise.all([
    getMilestonesData(projectId),
    getLinkedNotes(projectId),
  ]);
  // 절대 규칙 5: 빈 목록으로 대체하면 마일스톤이 삭제된 것처럼 보인다. 실패는 그대로 알린다.
  if (!milestones.ok) {
    return (
      <main className={CONTENT_CLASS}>
        <ErrorBanner message={milestones.error} code={milestones.code} />
      </main>
    );
  }

  // 노트도 같은 기준이다 — 빈 목록으로 넘기면 연결된 노트가 없는 것처럼 보인다
  if (!linkedNotes.ok) {
    return (
      <main className={CONTENT_CLASS}>
        <ErrorBanner message={linkedNotes.error} code={linkedNotes.code} />
      </main>
    );
  }

  return (
    <main className={CONTENT_CLASS}>
      <RealtimeRefresher tables={REALTIME_TABLES} selfUserId={me.data.id} />

      <h1 className="mb-6 text-xl font-bold">마일스톤</h1>

      <MilestoneScreen
        data={milestones.data}
        todayISO={todayISO(new Date())}
        linkedNotes={linkedNotes.data}
      />
    </main>
  );
}
