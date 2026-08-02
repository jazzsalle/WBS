// 목표 관리 화면 (SOT §7.7, §7.1)
// 데이터 로딩은 서버에서만 한다 — 액션(actions/)만 호출하고 supabase는 직접 부르지 않는다.
// 달성률·경고(§6.2 D-1~D-5, §6.3 T-1~T-4)는 전부 getGoalsData가 계산해 내려준 값이다(저장하지 않는다, O-4).
// 실패는 조용히 삼키지 않고 ErrorBanner로 code별 안내를 띄운다 (§9).

import { redirect } from 'next/navigation';
import { getCurrentUser } from '@/actions/auth';
import { getGoalsData } from '@/actions/goals';
import ErrorBanner from '@/components/ui/ErrorBanner';
import RealtimeRefresher from '@/components/RealtimeRefresher';
import GoalsScreen from '@/components/goals/GoalsScreen';

// R-1 §8.5 구독표의 "목표 관리" 행 그대로 4개. 전체 구독 금지.
// years·organizations·members는 구독표에 없다 — 남이 연차·기관·인력 이름을 바꿔도 이 화면은
// 즉시 다시 그려지지 않지만, 바꾼 쪽이 revalidatePath로 이 경로를 무효화하므로
// 다음 이동·새로고침에 반영된다.
const REALTIME_TABLES = [
  'deliverables',
  'deliverable_achievements',
  'tech_targets',
  'tech_target_records',
];

// §7.7 탭 2는 계획서 표(10열)를 그대로 그린다 — 좁은 폭에 가두지 않는다
const CONTENT_CLASS = 'mx-auto max-w-7xl p-8';

interface GoalsPageProps {
  params: Promise<{ id: string }>;
}

export default async function GoalsPage({ params }: GoalsPageProps) {
  const { id: projectId } = await params;

  const me = await getCurrentUser();
  // 미들웨어가 이미 거르지만, 세션 만료 직후 직접 접근을 방어한다 (A-4)
  if (!me.ok) redirect('/login');

  const goals = await getGoalsData(projectId);
  // 절대 규칙 5: 빈 목록으로 대체하면 목표가 삭제된 것처럼 보이고, 그 화면에서 저장하면
  // 연차별 목표가 실제로 지워진다. 실패는 그대로 알린다.
  if (!goals.ok) {
    return (
      <main className={CONTENT_CLASS}>
        <ErrorBanner message={goals.error} code={goals.code} />
      </main>
    );
  }

  return (
    <main className={CONTENT_CLASS}>
      <RealtimeRefresher tables={REALTIME_TABLES} selfUserId={me.data.id} />

      <h1 className="mb-6 text-xl font-bold print:hidden">목표 관리</h1>

      <GoalsScreen projectId={projectId} data={goals.data} />
    </main>
  );
}
