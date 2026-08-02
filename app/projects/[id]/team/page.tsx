// 인력·기관 화면 (SOT §7.10, §7.1)
// 데이터 로딩은 서버에서만 한다 — 액션(actions/)만 호출하고 supabase는 직접 부르지 않는다.
// 배정 작업 집계도 서버(getTeamScreenData)가 끝낸 값을 그대로 쓴다.
// 실패는 조용히 삼키지 않고 ErrorBanner로 code별 안내를 띄운다 (§9).

import { redirect } from 'next/navigation';
import { getCurrentUser } from '@/actions/auth';
import { getTeamScreenData } from '@/actions/team';
import ErrorBanner from '@/components/ui/ErrorBanner';
import RealtimeRefresher from '@/components/RealtimeRefresher';
import TeamScreen from '@/components/team/TeamScreen';

// R-1 §8.5 구독표: 인력·기관 화면은 organizations·members만 구독한다. 전체 구독 금지.
// projects(주관기관·PM 포인터)는 구독표에 없다 — 남이 PM을 바꿔도 즉시 다시 그려지지 않지만,
// 바꾼 쪽이 revalidatePath로 이 경로를 무효화하므로 다음 이동·새로고침에 반영된다.
const REALTIME_TABLES = ['organizations', 'members'];

const CONTENT_CLASS = 'mx-auto max-w-7xl p-8';

interface TeamPageProps {
  params: Promise<{ id: string }>;
}

export default async function TeamPage({ params }: TeamPageProps) {
  const { id: projectId } = await params;

  const me = await getCurrentUser();
  // 미들웨어가 이미 거르지만, 세션 만료 직후 직접 접근을 방어한다 (A-4)
  if (!me.ok) redirect('/login');

  const screen = await getTeamScreenData(projectId);
  if (!screen.ok) {
    return (
      <main className={CONTENT_CLASS}>
        <ErrorBanner message={screen.error} code={screen.code} />
      </main>
    );
  }

  const { project, organizations, members, assignedTasksByMember } = screen.data;

  return (
    <main className={CONTENT_CLASS}>
      <RealtimeRefresher tables={REALTIME_TABLES} selfUserId={me.data.id} />

      <h1 className="text-xl font-bold">인력·기관</h1>
      <p className="mb-6 mt-1 text-sm text-slate-500">{project.name}</p>

      <TeamScreen
        projectId={projectId}
        pmMemberId={project.pmMemberId}
        leadOrgId={project.leadOrgId}
        organizations={organizations}
        members={members}
        assignedTasksByMember={assignedTasksByMember}
      />
    </main>
  );
}
