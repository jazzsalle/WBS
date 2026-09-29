// 대시보드 과제 요약 카드 (SOT §7.2 2)
// 카드 클릭 → /projects/[id]. 표시 전용 서버 컴포넌트다.
// 진척률·달성률은 getDashboardData가 계산해 내려준 값을 그대로 쓴다 —
// 여기서 다시 나누지 않는다 (O-4, P-8).
// 아카이브 과제는 서버가 이미 뺀 목록이 온다 (§7.2 마지막 줄) — 화면이 되살리지 않는다.

import Link from 'next/link';
import type { ProjectSummaryCard } from '@/actions/dashboard';
import { PROJECT_STATUS_LABELS } from '@/lib/constants';
import { formatRate } from '@/lib/goals';
import Badge from '@/components/ui/Badge';
import ProgressBar from '@/components/ui/ProgressBar';

function RateRow({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-[11px] text-grey-500">{label}</dt>
      <dd className="mt-0.5 text-sm font-semibold tabular-nums text-grey-900">{value}</dd>
    </div>
  );
}

export interface ProjectSummaryCardsProps {
  cards: ProjectSummaryCard[];
}

export default function ProjectSummaryCards({ cards }: ProjectSummaryCardsProps) {
  return (
    <section aria-labelledby="dashboard-projects-title">
      <div className="flex items-center justify-between gap-3">
        <h2 id="dashboard-projects-title" className="text-base font-bold text-grey-900">
          과제 요약
        </h2>
        <Link href="/projects" className="text-xs font-medium text-blue-600 hover:underline">
          과제 목록 →
        </Link>
      </div>

      {cards.length === 0 ? (
        <p className="mt-3 rounded-2xl border border-dashed border-grey-300 bg-surface/60 p-6 text-center text-xs text-grey-500">
          표시할 과제가 없습니다. 과제를 등록하면 여기에 요약이 나타납니다(아카이브 과제는 제외됩니다).
        </p>
      ) : (
        <ul className="mt-3 grid gap-3 lg:grid-cols-2">
          {cards.map((card) => (
            <li key={card.projectId}>
              <Link
                href={`/projects/${card.projectId}`}
                className="block rounded-2xl border border-grey-200 bg-surface p-5 hover:border-blue-300 hover:shadow-sm"
              >
                <div className="flex items-start gap-3">
                  {/* 과제 색은 사용자가 지정한 임의 값이라 클래스가 아닌 인라인 스타일로만 쓸 수 있다 */}
                  <span
                    aria-hidden
                    className="mt-1 h-3 w-3 shrink-0 rounded-full"
                    style={{ backgroundColor: card.color }}
                  />
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="truncate text-sm font-bold text-grey-900" title={card.name}>
                        {card.name}
                      </span>
                      <Badge>{PROJECT_STATUS_LABELS[card.status]}</Badge>
                      {card.currentYear !== null && (
                        <Badge tone="blue" title="현재 수행중인 연차">
                          {card.currentYear.name.trim() || `${card.currentYear.order + 1}차년도`}
                        </Badge>
                      )}
                    </div>
                    <p className="mt-0.5 truncate text-xs text-grey-500">
                      {card.agency || '전문기관 미입력'}
                    </p>
                  </div>
                </div>

                {/* 숫자는 formatRate()만 쓰도록 진행바의 자체 표기를 끈다 (P-8) */}
                <div className="mt-4 flex items-center gap-3">
                  <ProgressBar
                    value={card.progress}
                    showValue={false}
                    label="진척률"
                    className="min-w-0 flex-1"
                  />
                  <span className="shrink-0 text-lg font-bold tabular-nums text-grey-900">
                    {formatRate(card.progress)}
                  </span>
                </div>

                <dl className="mt-4 grid grid-cols-2 gap-3">
                  <RateRow label="성과목표 달성률" value={formatRate(card.deliverableRate)} />
                  <RateRow label="기술목표 달성률" value={formatRate(card.techTargetRate)} />
                </dl>

                <div className="mt-4 border-t border-grey-100 pt-3 text-xs">
                  {card.nextMilestone === null ? (
                    <span className="text-grey-400">예정된 마일스톤이 없습니다.</span>
                  ) : (
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="text-grey-500">다음 마일스톤</span>
                      <span
                        className="min-w-0 flex-1 truncate font-medium text-grey-900"
                        title={card.nextMilestone.title}
                      >
                        {card.nextMilestone.title}
                      </span>
                      <span className="tabular-nums text-grey-500">{card.nextMilestone.date}</span>
                      {/* §6.5: 지연은 빨강, 그 밖은 중립. 판정은 서버가 준 daysLeft 하나로 한다 */}
                      <Badge
                        tone={card.nextMilestone.daysLeft < 0 ? 'red' : 'amber'}
                        className="tabular-nums"
                      >
                        {card.nextMilestone.dday}
                      </Badge>
                    </div>
                  )}
                </div>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
