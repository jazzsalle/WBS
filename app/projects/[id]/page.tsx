// 과제 개요 (SOT §7.3) — Phase 1 + Phase 3 범위
// 이 Phase까지 구현한 것: 협약 정보 패널 + 단계·연차 타임라인(진척률·예산·상태) + 목표 달성 현황.
// 임박 마일스톤(Phase 4)·고위험 리스크/최근 노트(Phase 6)는 자리표시로 둔다.
// 데이터 로딩은 서버에서 — 액션(actions/)만 호출하고 supabase는 직접 부르지 않는다.
// 진척률은 getProjectFullTree가 §6.1 4단계 롤업으로 계산해 내려준 값이다(저장하지 않는다, O-4).
// 목표 달성률도 getGoalsData(→ lib/goals.ts)가 계산한 값을 그대로 쓴다 — 여기서 다시 나누지 않는다.

import { redirect } from 'next/navigation';
import Link from 'next/link';
import { getCurrentUser } from '@/actions/auth';
import { getProjectFullTree } from '@/actions/tasks';
import { getTeam } from '@/actions/team';
import { getGoalsData, type GoalsData } from '@/actions/goals';
import type { ActionResult } from '@/types';
import { PROJECT_STATUS_LABELS } from '@/lib/constants';
import { formatRate } from '@/lib/goals';
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

// §5.9 비중은 소수 입력이 가능하다 — 자릿수를 임의로 잘라 합계가 100처럼 보이게 하지 않는다
function formatWeight(weight: number): string {
  return weight.toLocaleString('ko-KR', { maximumFractionDigits: 6 });
}

function InfoRow({ label, value, warn }: { label: string; value: string; warn?: boolean }) {
  return (
    <div>
      <dt className="text-xs text-slate-500">{label}</dt>
      {/* warn: 값을 못 읽은 행. 미입력과 구분되게 색으로 드러낸다 (절대 규칙 5) */}
      <dd className={`mt-0.5 text-sm ${warn ? 'text-amber-700' : 'text-slate-900'}`}>
        {value || '미입력'}
      </dd>
    </div>
  );
}

/**
 * §7.3 성과목표 도넛. 채움만 0~100으로 자른다 — D-2로 100을 넘는 달성률이 실제로 오고,
 * 숫자는 formatRate()가 실제 값을 그대로 보여준다(P-8).
 */
function AchievementDonut({ rate }: { rate: number | null }) {
  const radius = 34;
  const circumference = 2 * Math.PI * radius;
  const filled = rate === null ? 0 : (Math.max(0, Math.min(100, rate)) / 100) * circumference;
  return (
    <svg
      viewBox="0 0 88 88"
      role="img"
      aria-label={`성과목표 달성률 ${formatRate(rate)}`}
      className="h-24 w-24 shrink-0"
    >
      <circle cx="44" cy="44" r={radius} fill="none" stroke="#e2e8f0" strokeWidth="10" />
      {rate !== null && (
        <circle
          cx="44"
          cy="44"
          r={radius}
          fill="none"
          stroke="#3b82f6"
          strokeWidth="10"
          strokeLinecap="round"
          strokeDasharray={`${filled} ${circumference - filled}`}
          transform="rotate(-90 44 44)"
        />
      )}
      <text x="44" y="49" textAnchor="middle" className="fill-slate-900 text-[13px] font-bold">
        {formatRate(rate)}
      </text>
    </svg>
  );
}

/**
 * §7.3 목표 달성 현황 요약. 달성률·비중 경고는 getGoalsData가 계산해 내려준 값만 쓴다(O-4).
 * 조회에 실패해도 개요 전체를 막지 않고 이 카드에만 사실을 남긴다 (절대 규칙 5).
 */
function GoalSummaryCard({
  projectId,
  result,
}: {
  projectId: string;
  result: ActionResult<GoalsData>;
}) {
  return (
    <section className="rounded-2xl border border-slate-200 bg-white p-5">
      <div className="flex items-center justify-between gap-3">
        <h2 className="text-base font-bold text-slate-900">목표 달성 현황</h2>
        <Link
          href={`/projects/${projectId}/goals`}
          className="text-xs font-medium text-blue-600 hover:underline"
        >
          목표 관리 →
        </Link>
      </div>

      {!result.ok ? (
        <ErrorBanner message={result.error} code={result.code} className="mt-4" />
      ) : (
        <div className="mt-4 space-y-5">
          <div className="flex items-center gap-4">
            <AchievementDonut rate={result.data.deliverableSummary.rate} />
            <div className="min-w-0">
              <p className="text-xs text-slate-500">정량적 성과목표</p>
              <p className="mt-0.5 text-lg font-bold text-slate-900">
                {result.data.deliverableSummary.achievedTotal}
                <span className="text-sm font-normal text-slate-500">
                  {' / '}
                  {result.data.deliverableSummary.targetTotal}건
                </span>
              </p>
              {result.data.deliverables.length === 0 && (
                <p className="mt-1 text-xs text-slate-400">등록된 성과목표가 없습니다.</p>
              )}
            </div>
          </div>

          <div>
            {/* 숫자는 formatRate()만 쓰도록 진행바의 자체 표기를 끈다 (P-8) */}
            <ProgressBar
              value={result.data.techSummary.weightedRate ?? 0}
              showValue={false}
              label="정량적 기술목표 가중 달성률"
            />
            <div className="mt-1.5 flex flex-wrap items-center gap-2">
              <span className="text-lg font-bold text-slate-900">
                {formatRate(result.data.techSummary.weightedRate)}
              </span>
              {/* T-3: 비중 합계는 가중 평균의 분모다. 100이 아니면 값의 의미가 달라진다 */}
              <span className="text-xs text-slate-500">
                비중 합계 {formatWeight(result.data.techSummary.weightSum)}%
              </span>
              {result.data.techSummary.weightMismatch && (
                <Badge tone="amber" title="실제 합계로 정규화해 계산한 값입니다">
                  비중 합계 100 아님
                </Badge>
              )}
              {result.data.techTargets.length === 0 && (
                <span className="text-xs text-slate-400">등록된 기술목표가 없습니다.</span>
              )}
            </div>
          </div>
        </div>
      )}
    </section>
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
  // PM·주관기관은 이름으로 보여야 하므로 인력·기관 목록을 함께 읽는다 (§7.3).
  // 목표 달성 현황 요약도 같은 화면에 있으므로 함께 던진다 — 서로 기다릴 이유가 없다.
  // 둘 다 실패해도 개요 전체를 막지는 않고 해당 행·카드에만 사실을 표시한다.
  const [res, teamRes, goalsRes] = await Promise.all([
    getProjectFullTree(id),
    getTeam(id),
    getGoalsData(id),
  ]);

  if (!res.ok) {
    return (
      <main className="mx-auto max-w-6xl px-8 py-6">
        <ErrorBanner message={res.error} code={res.code} />
      </main>
    );
  }

  const { project, stages, years, stageProgress, projectProgress, invalidTaskIds } = res.data;

  const TEAM_LOAD_FAILED = '인력·기관 정보를 불러오지 못했습니다';
  // 가리키는 대상이 사라졌다면 '미입력'으로 뭉개지 않는다 — 사용자가 다시 지정해야 하는 상태다
  const pmName = !teamRes.ok
    ? TEAM_LOAD_FAILED
    : project.pmMemberId === null
      ? ''
      : (teamRes.data.members.find((m) => m.id === project.pmMemberId)?.name ?? '(삭제된 인력)');
  const leadOrgName = !teamRes.ok
    ? TEAM_LOAD_FAILED
    : project.leadOrgId === null
      ? ''
      : (teamRes.data.organizations.find((o) => o.id === project.leadOrgId)?.name ??
        '(삭제된 기관)');

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
          <InfoRow label="총괄책임자(PM)" value={pmName} warn={!teamRes.ok} />
          <InfoRow label="주관기관" value={leadOrgName} warn={!teamRes.ok} />
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
        <GoalSummaryCard projectId={id} result={goalsRes} />
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
