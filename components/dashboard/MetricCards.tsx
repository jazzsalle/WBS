// 대시보드 지표 카드 5개 (SOT §7.2 1)
// 표시 전용 서버 컴포넌트다 — 숫자는 getDashboardData가 계산해 내려준 값만 쓴다(O-4).
// 진척률 표기는 formatRate() 한 곳에서만 반올림한다 (P-8).

import type { DashboardMetrics } from '@/actions/dashboard';
import { formatRate } from '@/lib/goals';

interface MetricCardProps {
  label: string;
  value: string;
  caption: string;
  /** 숫자의 모집단·기준을 카드 안에 다 담을 수 없을 때만 툴팁으로 덧붙인다 */
  title?: string;
}

function MetricCard({ label, value, caption, title }: MetricCardProps) {
  return (
    <div
      title={title}
      className="rounded-2xl border border-slate-200 bg-white p-4"
    >
      <p className="text-xs font-medium text-slate-500">{label}</p>
      <p className="mt-1.5 text-2xl font-bold tabular-nums text-slate-900">{value}</p>
      <p className="mt-1 text-xs text-slate-400">{caption}</p>
    </div>
  );
}

export interface MetricCardsProps {
  metrics: DashboardMetrics;
}

export default function MetricCards({ metrics }: MetricCardsProps) {
  return (
    <section aria-labelledby="dashboard-metrics-title">
      <h2 id="dashboard-metrics-title" className="sr-only">
        주요 지표
      </h2>
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
        <MetricCard
          label="진행 중 과제"
          value={`${metrics.activeProjectCount.toLocaleString('ko-KR')}건`}
          caption="상태 '수행중' (아카이브 제외)"
        />
        <MetricCard
          label="평균 진척률"
          value={formatRate(metrics.averageProgress)}
          // ② 모집단을 라벨에 밝힌다 — '수행중'만이 아니라 아카이브를 뺀 전 과제의 평균이다
          caption={`아카이브 제외 전 과제 ${metrics.averageProgressProjectCount.toLocaleString('ko-KR')}개`}
          title={
            metrics.averageProgress === null
              ? '집계 대상 과제가 없어 평균을 낼 수 없습니다(N/A).'
              : undefined
          }
        />
        <MetricCard
          label={`${metrics.milestoneMetricWindowDays}일 내 마일스톤`}
          value={`${metrics.milestonesWithin30Days.toLocaleString('ko-KR')}건`}
          caption="완료·취소 제외"
          // ③ 이 창은 설정값이 아니라 §7.2에 박힌 고정값이다. 아래 임박 타임라인(설정
          //    milestoneAlertDays 기준)과 숫자가 달라 보일 수 있으므로 그 사실을 밝힌다.
          title={`설정의 마일스톤 알림 기준일과 별개인 고정 ${metrics.milestoneMetricWindowDays}일 기준입니다. 아래 '임박 마일스톤'은 설정값 기준이라 건수가 다를 수 있습니다.`}
        />
        <MetricCard
          label="최우선 작업"
          value={`${metrics.topPriorityTaskCount.toLocaleString('ko-KR')}건`}
          caption="우선순위 점수 15+"
          title="완료·막힘을 제외한 리프 작업 중 우선순위 점수가 15 이상인 건수입니다 (§6.9.2)."
        />
        <MetricCard
          label="고위험 리스크"
          value={`${metrics.highRiskCount.toLocaleString('ko-KR')}건`}
          caption="점수 15+ · 미해결"
          title="발생확률 × 영향도가 15 이상이고 해결·종결되지 않은 리스크입니다 (§6.5)."
        />
      </div>
    </section>
  );
}
