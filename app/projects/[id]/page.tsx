// 과제 개요 (SOT §7.3) — Phase 1 + Phase 3 + Phase 4 + Phase 6 범위
// §7.3의 6개 영역 전부: 협약 정보 패널 + 단계·연차 타임라인(진척률·예산·상태) + 목표 달성 현황
// + 임박 마일스톤 5건 + 고위험 리스크 5건 + 최근 노트 5건.
// 데이터 로딩은 서버에서 — 액션(actions/)만 호출하고 supabase는 직접 부르지 않는다.
// 진척률은 getProjectFullTree가 §6.1 4단계 롤업으로 계산해 내려준 값이다(저장하지 않는다, O-4).
// 목표 달성률도 getGoalsData(→ lib/goals.ts)가 계산한 값을 그대로 쓴다 — 여기서 다시 나누지 않는다.

import { redirect } from 'next/navigation';
import Link from 'next/link';
import { getCurrentUser } from '@/actions/auth';
import { getProjectFullTree } from '@/actions/tasks';
import { getTeam } from '@/actions/team';
import { getGoalsData, type GoalsData } from '@/actions/goals';
import { getMilestonesData, type MilestonesData } from '@/actions/milestones';
import { getRiskMatrix, type RiskMatrixData } from '@/actions/risks';
import { getNotesData, type NotesData } from '@/actions/notes';
import type { ActionResult, Milestone, MilestoneStatus, Year } from '@/types';
import {
  MILESTONE_TYPE_COLORS,
  MILESTONE_TYPE_LABELS,
  NOTE_TYPE_LABELS,
  PROJECT_STATUS_LABELS,
  RISK_CATEGORY_LABELS,
} from '@/lib/constants';
import { formatDday, isOverdueMilestone, isUpcomingMilestone, todayISO } from '@/lib/dates';
import { formatRate } from '@/lib/goals';
import { sortNotes } from '@/lib/notes';
import { RISK_SEVERITY_LABELS, RISK_SEVERITY_TONES } from '@/components/risks/severity';
import Badge, { type BadgeTone } from '@/components/ui/Badge';
import ErrorBanner from '@/components/ui/ErrorBanner';
import ProgressBar from '@/components/ui/ProgressBar';
import RealtimeRefresher from '@/components/RealtimeRefresher';
import StageYearPanel from '@/components/project/StageYearPanel';

// R-1 §8.5 구독표의 "과제 개요" 행 그대로. 다른 테이블은 구독하지 않는다.
// 고위험 리스크·최근 노트 카드는 `risks`/`notes`를 구독하지 않아 실시간으로 따라오지 않는다 —
// 구독표를 늘리면 §8.5의 "화면당 최대 4테이블" 예산을 깨고 연결 수가 늘어난다. 요약 카드라
// 다음 이동·revalidate 때 갱신되면 충분하다. (대시보드도 리스크를 집계하면서 같은 선택을 했다)
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

// ─── 임박 마일스톤 (§7.3, §6.5) ───────────────────────────────────────────────

const OVERVIEW_MILESTONE_LIMIT = 5;
/** §7.3 "고위험 리스크 5건" / "최근 노트 5건" */
const OVERVIEW_LIST_LIMIT = 5;

// §6.5: done·cancelled는 마감 판정 대상이 아니다 — 개요 목록에서도 뺀다
const CLOSED_MILESTONE_STATUSES: ReadonlySet<MilestoneStatus> = new Set(['done', 'cancelled']);

// 부록 A.3 유형 색상 토큰 → Badge 톤. Badge에는 sky·teal 톤이 없어 계열이 가장 가까운 톤으로 옮긴다.
const MILESTONE_TYPE_TONES: Record<string, BadgeTone> = {
  'violet-600': 'violet',
  'sky-600': 'blue',
  'teal-600': 'green',
  'slate-600': 'neutral',
};

/** §5.5: name이 있으면 name, 없으면 order+1 + '차년도' */
function yearLabel(year: Year): string {
  return year.name.trim() || `${year.order + 1}차년도`;
}

/**
 * §7.3 임박 마일스톤 5건. 지연 항목을 먼저 보이고 그다음 오늘 이후를 가까운 순으로 —
 * 지연 항목은 날짜가 오늘보다 앞서므로 날짜 오름차순 하나로 그 순서가 나온다.
 * 같은 날짜는 제목으로 갈라 목록이 새로고침마다 뒤바뀌지 않게 한다.
 * 기준일(today)은 서버가 계산해 내려준 Asia/Seoul 달력 오늘이다 (§6.5).
 * 조회에 실패해도 개요 전체를 막지 않고 이 카드에만 사실을 남긴다 (절대 규칙 5).
 */
function UpcomingMilestoneCard({
  projectId,
  today,
  result,
}: {
  projectId: string;
  today: string;
  result: ActionResult<MilestonesData>;
}) {
  const upcoming = result.ok
    ? result.data.milestones
        .filter((m) => !CLOSED_MILESTONE_STATUSES.has(m.status))
        .sort((a, b) => (a.date === b.date ? a.title.localeCompare(b.title, 'ko') : a.date < b.date ? -1 : 1))
        .slice(0, OVERVIEW_MILESTONE_LIMIT)
    : [];

  // 가리키는 연차가 사라졌다면 '미지정'으로 뭉개지 않는다 (절대 규칙 5)
  const yearNameOf = (milestone: Milestone): string => {
    if (!result.ok || milestone.yearId === null) return '과제 전체';
    const year = result.data.years.find((y) => y.id === milestone.yearId);
    return year ? yearLabel(year) : '(삭제된 연차)';
  };

  return (
    <section className="rounded-2xl border border-slate-200 bg-white p-5">
      <div className="flex items-center justify-between gap-3">
        <h2 className="text-base font-bold text-slate-900">임박 마일스톤</h2>
        <Link
          href={`/projects/${projectId}/milestones`}
          className="text-xs font-medium text-blue-600 hover:underline"
        >
          마일스톤 관리 →
        </Link>
      </div>

      {!result.ok ? (
        <ErrorBanner message={result.error} code={result.code} className="mt-4" />
      ) : upcoming.length === 0 ? (
        <p className="mt-4 rounded-xl border border-dashed border-slate-300 p-6 text-center text-xs text-slate-500">
          예정된 마일스톤이 없습니다.
        </p>
      ) : (
        <ul className="mt-4 space-y-2">
          {upcoming.map((m) => {
            const overdue = isOverdueMilestone(m, today);
            const alertDays = result.data.milestoneAlertDays;
            const tone: BadgeTone = overdue
              ? 'red'
              : isUpcomingMilestone(m, today, alertDays)
                ? 'amber'
                : 'neutral';
            return (
              <li key={m.id} className="flex flex-wrap items-center gap-2 rounded-xl bg-slate-50/60 px-3 py-2">
                <Badge tone={MILESTONE_TYPE_TONES[MILESTONE_TYPE_COLORS[m.type]] ?? 'neutral'}>
                  {MILESTONE_TYPE_LABELS[m.type]}
                </Badge>
                <span className="min-w-0 flex-1 truncate text-sm font-medium text-slate-900" title={m.title}>
                  {m.title}
                </span>
                <span className="text-xs text-slate-500">{yearNameOf(m)}</span>
                <span className="text-xs tabular-nums text-slate-500">{m.date}</span>
                <Badge tone={tone} className="tabular-nums" title={overdue ? '지연 (§6.5)' : undefined}>
                  {formatDday(today, m.date)}
                </Badge>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

/**
 * §7.3 고위험 리스크 5건. 정렬·등급·색상은 전부 `getRiskMatrix`가 `lib/risk.ts`로 계산해
 * 내려준 값이다 — 여기서 점수를 다시 곱하거나 경계값을 다시 쓰지 않는다 (O-4).
 * 해결·종료는 §6.5상 등급 판정 대상이 아니므로(`severity=null`) 이 카드에서 제외한다.
 */
function HighRiskCard({ projectId, result }: { projectId: string; result: ActionResult<RiskMatrixData> }) {
  // getRiskMatrix가 이미 "미해결 먼저, 점수 내림차순"으로 정렬해 내려준다
  const top = result.ok ? result.data.risks.filter((v) => v.active).slice(0, OVERVIEW_LIST_LIMIT) : [];

  return (
    <section className="rounded-2xl border border-slate-200 bg-white p-5">
      <div className="flex items-center justify-between gap-3">
        <h2 className="text-base font-bold text-slate-900">고위험 리스크</h2>
        <Link
          href={`/projects/${projectId}/risks`}
          className="text-xs font-medium text-blue-600 hover:underline"
        >
          리스크 관리 →
        </Link>
      </div>

      {!result.ok ? (
        <ErrorBanner message={result.error} code={result.code} className="mt-4" />
      ) : top.length === 0 ? (
        <p className="mt-4 rounded-xl border border-dashed border-slate-300 p-6 text-center text-xs text-slate-500">
          미해결 리스크가 없습니다.
        </p>
      ) : (
        <ul className="mt-4 space-y-2">
          {top.map((v) => (
            <li
              key={v.risk.id}
              className="flex flex-wrap items-center gap-2 rounded-xl bg-slate-50/60 px-3 py-2"
            >
              <Badge tone={v.severity ? RISK_SEVERITY_TONES[v.severity] : 'neutral'} className="tabular-nums">
                {v.severity ? RISK_SEVERITY_LABELS[v.severity] : '판정 제외'} {v.score}
              </Badge>
              <span
                className="min-w-0 flex-1 truncate text-sm font-medium text-slate-900"
                title={v.risk.title}
              >
                {v.risk.title}
              </span>
              <span className="text-xs text-slate-500">{RISK_CATEGORY_LABELS[v.risk.category]}</span>
              {/* §6.5: 발생한 리스크는 점수와 무관하게 주의 대상이다 */}
              {v.attention && v.severity !== 'high' && <Badge tone="red">주의</Badge>}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/**
 * §7.3 최근 노트 5건. 목록 정렬(고정 상단 → 날짜 내림차순)은 `lib/notes.ts`의 `sortNotes`가
 * 원본이다 — 노트 화면과 여기가 다른 순서를 보여주면 안 된다.
 */
function RecentNoteCard({ projectId, result }: { projectId: string; result: ActionResult<NotesData> }) {
  const recent = result.ok ? sortNotes(result.data.notes).slice(0, OVERVIEW_LIST_LIMIT) : [];

  return (
    <section className="rounded-2xl border border-slate-200 bg-white p-5">
      <div className="flex items-center justify-between gap-3">
        <h2 className="text-base font-bold text-slate-900">최근 노트</h2>
        <Link
          href={`/projects/${projectId}/notes`}
          className="text-xs font-medium text-blue-600 hover:underline"
        >
          노트 열기 →
        </Link>
      </div>

      {!result.ok ? (
        <ErrorBanner message={result.error} code={result.code} className="mt-4" />
      ) : recent.length === 0 ? (
        <p className="mt-4 rounded-xl border border-dashed border-slate-300 p-6 text-center text-xs text-slate-500">
          작성된 노트가 없습니다.
        </p>
      ) : (
        <ul className="mt-4 space-y-2">
          {recent.map((note) => (
            <li key={note.id} className="flex flex-wrap items-center gap-2 rounded-xl bg-slate-50/60 px-3 py-2">
              <Badge tone="neutral">{NOTE_TYPE_LABELS[note.type]}</Badge>
              <Link
                href={`/projects/${projectId}/notes?note=${note.id}`}
                className="min-w-0 flex-1 truncate text-sm font-medium text-slate-900 hover:underline"
                title={note.title}
              >
                {note.pinned && <span aria-label="고정됨">📌 </span>}
                {note.title}
              </Link>
              <span className="text-xs tabular-nums text-slate-500">{note.date}</span>
            </li>
          ))}
        </ul>
      )}
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
  // 목표 달성 현황·임박 마일스톤 요약도 같은 화면에 있으므로 함께 던진다 — 서로 기다릴 이유가 없다.
  // 어느 하나가 실패해도 개요 전체를 막지는 않고 해당 행·카드에만 사실을 표시한다.
  const [res, teamRes, goalsRes, milestonesRes, risksRes, notesRes] = await Promise.all([
    getProjectFullTree(id),
    getTeam(id),
    getGoalsData(id),
    getMilestonesData(id),
    getRiskMatrix(id),
    getNotesData(id),
  ]);

  // §6.5 기준일은 서버가 한 번 계산해 내려준다 — 클라이언트가 각자 '오늘'을 만들면 판정이 갈린다
  const today = todayISO(new Date());

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
        <UpcomingMilestoneCard projectId={id} today={today} result={milestonesRes} />
        <HighRiskCard projectId={id} result={risksRes} />
        <RecentNoteCard projectId={id} result={notesRes} />
      </div>
    </main>
  );
}
