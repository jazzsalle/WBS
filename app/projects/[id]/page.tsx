// 과제 개요 (SOT §7.3) — Phase 1 범위
// 이 Phase에서 구현하는 것: 협약 정보 패널 + 단계·연차 타임라인(진척률·예산·상태).
// 목표 달성 현황(Phase 3)·임박 마일스톤(Phase 4)·고위험 리스크/최근 노트(Phase 6)는 자리표시로 둔다.
// 데이터 로딩은 서버에서 — 액션(actions/)만 호출하고 supabase는 직접 부르지 않는다.
// 진척률은 getProjectFullTree가 §6.1 4단계 롤업으로 계산해 내려준 값이다(저장하지 않는다, O-4).

import { redirect } from 'next/navigation';
import { getCurrentUser } from '@/actions/auth';
import { getProjectFullTree } from '@/actions/tasks';
import { PROJECT_STATUS_LABELS } from '@/lib/constants';
import Badge from '@/components/ui/Badge';
import ErrorBanner from '@/components/ui/ErrorBanner';
import ProgressBar from '@/components/ui/ProgressBar';
import RealtimeRefresher from '@/components/RealtimeRefresher';
import StageYearPanel from '@/components/project/StageYearPanel';

// R-1 §8.5 구독표의 "과제 개요" 행 그대로. 다른 테이블은 구독하지 않는다.
const REALTIME_TABLES = ['projects', 'years', 'milestones'];

function formatWon(amount: number | null): string {
  return amount === null ? '미입력' : `${amount.toLocaleString('ko-KR')}원`;
}

function InfoRow({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-xs text-slate-500">{label}</dt>
      <dd className="mt-0.5 text-sm text-slate-900">{value || '미입력'}</dd>
    </div>
  );
}

/** 후속 Phase에서 채울 영역. 빈 화면을 말없이 두지 않고 언제 채워지는지 밝힌다. */
function PlaceholderCard({ title, phase, detail }: { title: string; phase: number; detail: string }) {
  return (
    <section className="rounded-2xl border border-dashed border-slate-300 bg-white/60 p-5">
      <h2 className="text-base font-bold text-slate-700">{title}</h2>
      <p className="mt-1 text-xs text-slate-500">{detail}</p>
      <p className="mt-2 text-xs font-medium text-slate-400">Phase {phase}에서 구현됩니다.</p>
    </section>
  );
}

export default async function ProjectOverviewPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const me = await getCurrentUser();
  // 미들웨어가 이미 거르지만, 세션 만료 직후 직접 접근을 방어한다 (A-4)
  if (!me.ok) redirect('/login');

  const { id } = await params;
  const res = await getProjectFullTree(id);

  if (!res.ok) {
    return (
      <main className="mx-auto max-w-6xl px-8 py-6">
        <ErrorBanner message={res.error} code={res.code} />
      </main>
    );
  }

  const { project, stages, years, stageProgress, projectProgress, invalidTaskIds } = res.data;

  return (
    <main className="mx-auto max-w-6xl px-8 py-6">
      <RealtimeRefresher tables={REALTIME_TABLES} selfUserId={me.data.id} />

      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="text-2xl font-bold text-slate-900">{project.name}</h1>
            <Badge>{PROJECT_STATUS_LABELS[project.status]}</Badge>
            {project.archived && <Badge tone="amber">보관됨</Badge>}
          </div>
          <p className="mt-1 text-sm text-slate-500">
            {[project.ministry, project.agency, project.programName].filter(Boolean).join(' · ') ||
              '부처·전문기관·사업명 미입력'}
          </p>
        </div>
        <ProgressBar
          value={projectProgress}
          label="과제 진척률"
          className="w-full max-w-xs shrink-0"
        />
      </div>

      {invalidTaskIds.length > 0 && (
        // 절대 규칙 5: 트리에 편입되지 못한 작업을 조용히 버리지 않는다
        <ErrorBanner
          message={`트리에 붙지 못한 작업이 ${invalidTaskIds.length}건 있습니다(순환 참조이거나 부모가 다른 연차에 있습니다). 진척률 집계에서 빠져 있으니 WBS 화면에서 확인하세요.`}
          code="RULE"
          className="mt-4"
        />
      )}

      <section className="mt-6 rounded-2xl border border-slate-200 bg-white p-5">
        <h2 className="text-base font-bold text-slate-900">협약 정보</h2>
        <dl className="mt-4 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          <InfoRow label="과제번호" value={project.projectNo} />
          <InfoRow label="부처" value={project.ministry} />
          <InfoRow label="전문기관" value={project.agency} />
          <InfoRow label="사업명" value={project.programName} />
          <InfoRow
            label="협약기간"
            value={
              project.contractStartDate || project.contractEndDate
                ? `${project.contractStartDate ?? '?'} ~ ${project.contractEndDate ?? '?'}`
                : ''
            }
          />
          <InfoRow label="총 연구개발비" value={formatWon(project.totalBudget)} />
          <InfoRow label="정부지원연구개발비" value={formatWon(project.govBudget)} />
          <InfoRow label="기관부담연구개발비" value={formatWon(project.ownBudget)} />
          {/* PM·주관기관은 Member·Organization이 생기는 Phase 2에서 연결한다 (§7.3) */}
          <InfoRow label="총괄책임자(PM) · 주관기관" value="Phase 2에서 연결됩니다." />
        </dl>
      </section>

      <div className="mt-6">
        <StageYearPanel
          projectId={project.id}
          stages={stages}
          years={years.map(({ year, yearProgress }) => ({ year, progress: yearProgress }))}
          stageProgress={stageProgress}
        />
      </div>

      <div className="mt-6 grid gap-4 lg:grid-cols-2">
        <PlaceholderCard
          title="목표 달성 현황"
          phase={3}
          detail="성과목표 도넛(달성/목표 건수)과 기술목표 가중 달성률 게이지 (§7.3, §6.2~6.3)."
        />
        <PlaceholderCard
          title="임박 마일스톤"
          phase={4}
          detail="마감이 가까운 마일스톤 5건 (§7.3, §6.5)."
        />
        <PlaceholderCard title="고위험 리스크" phase={6} detail="리스크 점수 상위 5건 (§7.3, §6.5)." />
        <PlaceholderCard title="최근 노트" phase={6} detail="최근 작성된 노트 5건 (§7.3)." />
      </div>
    </main>
  );
}
