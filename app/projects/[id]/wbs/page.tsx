// WBS 트리 화면 (SOT §7.4, §7.1)
// 데이터 로딩은 서버에서만 한다 — 액션(actions/)만 호출하고 supabase는 직접 부르지 않는다.
// 진척률·WBS 코드·날짜 롤업·우선순위는 전부 서버 계산값이다(저장하지 않는다, §6.1 O-4·PR-7).
// 실패는 조용히 삼키지 않고 ErrorBanner로 code별 안내를 띄운다 (§9).

import { redirect } from 'next/navigation';
import { getCurrentUser } from '@/actions/auth';
import { getProjectFullTree, getYearTree } from '@/actions/tasks';
import { getTeam } from '@/actions/team';
import { getGoalsData } from '@/actions/goals';
import { getLinkedNotes } from '@/actions/notes';
import { todayISO } from '@/lib/dates';
import ErrorBanner from '@/components/ui/ErrorBanner';
import RealtimeRefresher from '@/components/RealtimeRefresher';
import WbsScreen, { type WbsGroup } from '@/components/wbs/WbsScreen';
import { ALL_YEARS } from '@/components/wbs/YearSelector';

// R-1 §8.5 구독표: WBS 화면은 tasks·years만 구독한다. 전체 구독 금지.
// members·organizations·deliverables·tech_targets는 구독표에 없다 — 다른 사람이 인력·기관·목표
// 이름을 바꿔도 이 화면은 즉시 다시 그려지지 않는다. 이름 표시가 늦는 대신 동시 연결 수를
// 지킨다(R-1). 이름을 고친 쪽에서 revalidatePath('/projects/[id]/wbs')를 부르므로 다음
// 이동·새로고침에 반영된다.
const REALTIME_TABLES = ['tasks', 'years'];

// 레이아웃(§7.1)은 폭 제약을 걸지 않는다 — 컬럼이 10개라 WBS는 넓은 폭을 쓴다 (§12 반응형)
const CONTENT_CLASS = 'mx-auto max-w-[1600px] p-8';

interface WbsPageProps {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ yearId?: string | string[] }>;
}

export default async function WbsPage({ params, searchParams }: WbsPageProps) {
  const { id: projectId } = await params;
  const { yearId } = await searchParams;
  const requestedYearId = Array.isArray(yearId) ? yearId[0] : yearId;

  const me = await getCurrentUser();
  // 미들웨어가 이미 거르지만, 세션 만료 직후 직접 접근을 방어한다 (A-4)
  if (!me.ok) redirect('/login');

  // 단계·연차 목록(셀렉터)과 "전체 연차 보기"가 여기서 함께 나온다.
  // 담당·기관 컬럼(§7.4)에 쓸 이름은 팀 조회에서, 연계 컬럼·상세 패널의 목표 후보는
  // 목표 조회에서 온다 — 서로 기다릴 이유가 없어 함께 던진다.
  // 상세 패널의 관련 노트(§7.12 역참조)도 같은 왕복에서 가져온다
  const [full, team, goals, linkedNotes] = await Promise.all([
    getProjectFullTree(projectId),
    getTeam(projectId),
    getGoalsData(projectId),
    getLinkedNotes(projectId),
  ]);
  if (!full.ok) {
    return (
      <main className={CONTENT_CLASS}>
        <ErrorBanner message={full.error} code={full.code} />
      </main>
    );
  }
  // 절대 규칙 5: 인력·기관을 못 읽었다고 빈 목록으로 넘기면 배정된 담당자가 화면에서
  // 사라진 것처럼 보이고, 그 상태로 저장하면 배정이 지워진다. 실패는 그대로 알린다.
  if (!team.ok) {
    return (
      <main className={CONTENT_CLASS}>
        <ErrorBanner message={team.error} code={team.code} />
      </main>
    );
  }
  // 목표도 같은 기준이다. 빈 목록으로 넘기면 연계된 목표가 사라진 것처럼 보이고,
  // 상세 패널을 그대로 저장하면 연계가 전체 치환으로 지워진다.
  if (!goals.ok) {
    return (
      <main className={CONTENT_CLASS}>
        <ErrorBanner message={goals.error} code={goals.code} />
      </main>
    );
  }

  // 노트도 같은 기준이다. 빈 목록으로 넘기면 연결된 노트가 없는 것처럼 보인다.
  if (!linkedNotes.ok) {
    return (
      <main className={CONTENT_CLASS}>
        <ErrorBanner message={linkedNotes.error} code={linkedNotes.code} />
      </main>
    );
  }

  const { stages, years: yearTrees, invalidTaskIds } = full.data;
  // 트리·패널은 목표의 이름과 id만 쓴다 — 달성률(파생 값)은 여기서 다루지 않는다
  const deliverables = goals.data.deliverables.map((view) => view.deliverable);
  const techTargets = goals.data.techTargets.map((view) => view.techTarget);
  const years = yearTrees.map((y) => y.year);

  if (years.length === 0) {
    return (
      <main className={CONTENT_CLASS}>
        <p className="rounded-xl border border-dashed border-slate-300 p-10 text-center text-sm text-slate-500">
          아직 연차가 없습니다. 과제 개요에서 단계와 연차를 먼저 만드세요.
        </p>
      </main>
    );
  }

  const showAll = requestedYearId === ALL_YEARS;
  // 요청 연차 → 수행 중(active) 연차 → 첫 연차 순으로 고른다 (§7.4 연차 선택 탭)
  const selectedYear = showAll
    ? null
    : (years.find((y) => y.id === requestedYearId) ??
      years.find((y) => y.status === 'active') ??
      years[0] ??
      null);
  const missingRequestedYear =
    !showAll &&
    requestedYearId !== undefined &&
    !years.some((y) => y.id === requestedYearId);

  let groups: WbsGroup[];
  let invalidIds: string[];

  if (selectedYear === null) {
    // §6.7: 여러 연차가 섞이므로 WBS 코드에 '1차-' 접두가 붙은 전체 트리를 그대로 쓴다
    groups = yearTrees;
    invalidIds = invalidTaskIds;
  } else {
    // 단일 연차는 코드가 연차 단위로 리셋된 트리여야 한다(접두 없음) — 전체 트리를 재사용할 수 없다
    const tree = await getYearTree(selectedYear.id);
    if (!tree.ok) {
      return (
        <main className={CONTENT_CLASS}>
          <ErrorBanner message={tree.error} code={tree.code} />
        </main>
      );
    }
    groups = [{ year: tree.data.year, nodes: tree.data.nodes, yearProgress: tree.data.yearProgress }];
    invalidIds = tree.data.invalidTaskIds;
  }

  return (
    <main className={CONTENT_CLASS}>
      <RealtimeRefresher tables={REALTIME_TABLES} selfUserId={me.data.id} />

      <h1 className="mb-4 text-xl font-bold">WBS 트리</h1>

      {missingRequestedYear && (
        <ErrorBanner
          className="mb-4"
          message="요청한 연차를 찾을 수 없어 다른 연차를 표시합니다. 다른 사람이 연차를 삭제했을 수 있습니다."
        />
      )}

      <WbsScreen
        projectId={projectId}
        stages={stages}
        years={years}
        groups={groups}
        members={team.data.members}
        organizations={team.data.organizations}
        deliverables={deliverables}
        techTargets={techTargets}
        selectedYearId={selectedYear === null ? ALL_YEARS : selectedYear.id}
        invalidTaskIds={invalidIds}
        linkedNotes={linkedNotes.data}
        // 지연 판정 기준일을 서버에서 Asia/Seoul 달력으로 고정해
        // SSR/CSR·서버 OS 타임존에 따라 결과가 갈리지 않게 한다 (§6.5)
        todayISO={todayISO(new Date())}
      />
    </main>
  );
}
