// 대시보드 (SOT §7.2, §7.1)
// 전 과제 요약 화면이다. 데이터는 서버에서 getDashboardData() 한 번으로 받고 하위 컴포넌트는
// 표시만 한다 — 진척률·달성률·집행률·우선순위·마감 판정을 화면에서 다시 계산하지 않는다 (O-4).
// 아카이브 과제는 서버가 모든 집계에서 뺀 상태로 내려준다 (§7.2 마지막 줄).
// 승인된 사용자만 미들웨어를 통과해 여기 도달한다. 최초 1회 온보딩 모달(§14.4 ③④)을
// 여기서 띄운다 — /login·/pending에는 떠서는 안 되므로 layout이 아닌 홈에 마운트한다.
// 따라하기 드로어(§7.17 TU-1)의 본문 9편은 서버가 fs로 읽어 내려준다(HP-1) — 읽기 실패는
// 대시보드를 막지 않고 배너로만 드러낸다.

import { redirect } from 'next/navigation';
import Link from 'next/link';
import { getCurrentUser } from '@/actions/auth';
import { getDashboardData } from '@/actions/dashboard';
import OnboardingModal from '@/components/auth/OnboardingModal';
import ErrorBanner from '@/components/ui/ErrorBanner';
import RealtimeRefresher from '@/components/RealtimeRefresher';
import MetricCards from '@/components/dashboard/MetricCards';
import ProjectSummaryCards from '@/components/dashboard/ProjectSummaryCards';
import UpcomingMilestones from '@/components/dashboard/UpcomingMilestones';
import FocusTasks from '@/components/dashboard/FocusTasks';
import AttentionList from '@/components/dashboard/AttentionList';
import TodayTodos from '@/components/dashboard/TodayTodos';
import HelpLink from '@/components/help/HelpLink';
import TutorialLauncher from '@/components/tutorial/TutorialLauncher';
import type { TutorialDocument } from '@/lib/content';
import { readAllTutorialDocuments } from '@/lib/content';

// R-1 §8.5 구독표의 "대시보드" 행 그대로. 리스크·To-Do가 화면에 나와도 구독하지 않는다
// (전체 구독 금지 — 무료 플랜 200 동시 연결).
const REALTIME_TABLES = ['projects', 'milestones', 'tasks'];

export default async function DashboardPage() {
  const me = await getCurrentUser();
  // 미들웨어가 이미 거르지만, 세션 만료 직후 직접 접근을 방어한다 (A-4)
  if (!me.ok) redirect('/login');

  const res = await getDashboardData();

  // 본문이 없으면 드로어를 그리지 않되 이유는 남긴다 — standalone에서 content/가 빠진 배포 사고가
  // "버튼이 안 보이네"로 묻히면 안 된다(HP-1, 절대 규칙 5)
  let tutorialDocs: TutorialDocument[] | null = null;
  let tutorialError: string | null = null;
  try {
    tutorialDocs = await readAllTutorialDocuments();
  } catch (e) {
    tutorialError = e instanceof Error ? e.message : String(e);
  }

  return (
    <main className="mx-auto max-w-6xl px-8 py-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <div className="flex items-center gap-2">
            <h1 className="text-2xl font-bold">대시보드</h1>
            <HelpLink slug="dashboard" />
          </div>
          {res.ok && (
            // §6.5 기준일은 서버가 Asia/Seoul 달력으로 한 번 정한다 — 어느 판정이 언제 기준인지 밝힌다
            <p className="mt-0.5 text-xs text-grey-500">기준일 {res.data.todayISO}</p>
          )}
        </div>
        <div className="flex items-center gap-4">
          <span className="text-sm text-grey-500">{me.data.name}</span>
          <Link
            href="/projects"
            className="text-sm text-grey-500 underline hover:text-grey-700"
          >
            과제 목록
          </Link>
          {/* /todos·/settings는 과제 밖 라우트라 과제 탭에 없다 (§7.1) — 여기가 유일한 진입점이다 */}
          <Link
            href="/todos"
            className="text-sm text-grey-500 underline hover:text-grey-700"
          >
            To-Do
          </Link>
          <Link
            href="/settings"
            className="text-sm text-grey-500 underline hover:text-grey-700"
          >
            설정
          </Link>
        </div>
      </div>

      {tutorialError !== null && (
        <ErrorBanner
          message={`따라하기 본문을 읽지 못했습니다: ${tutorialError}`}
          className="mt-6"
        />
      )}

      {/* 조회 실패를 빈 대시보드로 위장하지 않는다 (절대 규칙 5) */}
      {!res.ok ? (
        <ErrorBanner message={res.error} code={res.code} className="mt-6" />
      ) : (
        <>
          <RealtimeRefresher tables={REALTIME_TABLES} selfUserId={me.data.id} />

          <div className="mt-6">
            <MetricCards metrics={res.data.metrics} />
          </div>

          <div className="mt-8">
            <ProjectSummaryCards
              cards={res.data.projectCards}
              currencyUnit={res.data.settings.currencyUnit}
            />
          </div>

          <div className="mt-8 grid gap-4 lg:grid-cols-2">
            <UpcomingMilestones
              items={res.data.upcomingMilestones}
              milestoneAlertDays={res.data.settings.milestoneAlertDays}
            />
            <FocusTasks items={res.data.focusTasks} />
            <AttentionList items={res.data.attention} />
            <TodayTodos items={res.data.todayTodos} />
          </div>
        </>
      )}

      <OnboardingModal defaultName={me.data.name} />
      {tutorialDocs !== null && <TutorialLauncher projectId={null} docs={tutorialDocs} />}
    </main>
  );
}
