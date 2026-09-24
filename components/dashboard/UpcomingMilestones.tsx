// 대시보드 임박 마일스톤 타임라인 (SOT §7.2 3)
// 서버가 §6.5 upcoming(설정 milestoneAlertDays 창)으로 걸러 날짜 오름차순으로 내려준 목록을
// 그대로 그린다 — 여기서 다시 정렬하거나 판정하지 않는다.
// "평가/보고서는 아이콘 구분"(§7.2): 색의 원본은 부록 A.3 MILESTONE_TYPE_COLORS이고,
// 여기서는 그 토큰을 클래스·모양으로 옮기기만 한다. 새 색을 만들지 않는다.

import Link from 'next/link';
import type { UpcomingMilestoneItem } from '@/actions/dashboard';
import type { MilestoneType } from '@/types';
import {
  MILESTONE_STATUS_LABELS,
  MILESTONE_TYPE_COLORS,
  MILESTONE_TYPE_LABELS,
} from '@/lib/constants';
import Badge, { type BadgeTone } from '@/components/ui/Badge';

// Tailwind는 클래스명을 정적으로 스캔한다 — 토큰을 문자열로 조합하지 않고 완전한 형태로 나열한다.
const MARKER_COLOR_CLASSES: Record<string, string> = {
  'purple-600': 'bg-purple-600',
  'blue-600': 'bg-blue-600',
  'teal-600': 'bg-teal-600',
  'grey-600': 'bg-grey-600',
};

// 색만으로는 구분이 어려운 환경(색각·흑백 인쇄)을 위해 모양도 함께 나눈다.
// 평가(violet) = 마름모, 보고서(sky) = 문서, 그 밖 = 원.
const MARKER_SHAPE_CLASSES: Record<string, string> = {
  'purple-600': 'h-3 w-3 rotate-45',
  'blue-600': 'h-3.5 w-2.5 rounded-[2px]',
  'teal-600': 'h-3 w-3 rounded-full',
  'grey-600': 'h-3 w-3 rounded-full',
};

// 같은 색·모양을 쓰는 유형끼리 묶어 범례를 만든다 — 그룹의 근거는 A.3 하나뿐이다
const LEGEND = (Object.keys(MILESTONE_TYPE_COLORS) as MilestoneType[]).reduce<
  { token: string; labels: string[] }[]
>((groups, type) => {
  const token = MILESTONE_TYPE_COLORS[type];
  const group = groups.find((g) => g.token === token);
  if (group) group.labels.push(MILESTONE_TYPE_LABELS[type]);
  else groups.push({ token, labels: [MILESTONE_TYPE_LABELS[type]] });
  return groups;
}, []);

function TypeMarker({ type }: { type: MilestoneType }) {
  const token = MILESTONE_TYPE_COLORS[type];
  return (
    <span
      aria-hidden
      className={`${MARKER_SHAPE_CLASSES[token] ?? 'h-3 w-3 rounded-full'} ${
        MARKER_COLOR_CLASSES[token] ?? 'bg-grey-600'
      }`}
    />
  );
}

export interface UpcomingMilestonesProps {
  items: UpcomingMilestoneItem[];
  /** §6.5 알림 기준일. 목록의 창 길이를 사용자에게 밝히기 위해 받는다 */
  milestoneAlertDays: number;
}

export default function UpcomingMilestones({ items, milestoneAlertDays }: UpcomingMilestonesProps) {
  return (
    <section
      aria-labelledby="dashboard-milestones-title"
      className="rounded-2xl border border-grey-200 bg-surface p-5"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 id="dashboard-milestones-title" className="text-base font-bold text-grey-900">
          임박 마일스톤
          <span className="ml-2 text-xs font-normal text-grey-500">향후 {milestoneAlertDays}일</span>
        </h2>
        <ul className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-grey-500">
          {LEGEND.map((group) => (
            <li key={group.token} className="flex items-center gap-1.5">
              <span
                aria-hidden
                className={`${MARKER_SHAPE_CLASSES[group.token] ?? 'h-3 w-3 rounded-full'} ${
                  MARKER_COLOR_CLASSES[group.token] ?? 'bg-grey-600'
                }`}
              />
              {group.labels.join(' · ')}
            </li>
          ))}
        </ul>
      </div>

      {items.length === 0 ? (
        <p className="mt-4 rounded-xl border border-dashed border-grey-300 p-6 text-center text-xs text-grey-500">
          향후 {milestoneAlertDays}일 내 마일스톤이 없습니다.
        </p>
      ) : (
        <ol className="mt-4">
          {items.map((item, index) => {
            // §6.5: 날짜가 지난 항목은 지연(빨강), 창 안의 항목은 임박(주황).
            // 판정은 서버가 준 daysLeft 하나로 한다 — 화면에서 오늘을 만들지 않는다.
            const tone: BadgeTone = item.daysLeft < 0 ? 'red' : 'amber';
            return (
              <li key={item.id} className="flex gap-3">
                {/* 세로 레일: 마지막 항목은 선을 잇지 않는다 */}
                <div className="flex flex-col items-center pt-1.5">
                  <TypeMarker type={item.type} />
                  {index < items.length - 1 && <span aria-hidden className="w-px flex-1 bg-grey-200" />}
                </div>
                <div className="min-w-0 flex-1 pb-4">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-xs tabular-nums text-grey-500">{item.date}</span>
                    <Badge tone={tone} className="tabular-nums">
                      {item.dday}
                    </Badge>
                    <Badge>{MILESTONE_TYPE_LABELS[item.type]}</Badge>
                    <Badge title="마일스톤 상태">{MILESTONE_STATUS_LABELS[item.status]}</Badge>
                  </div>
                  <p className="mt-1 truncate text-sm font-medium text-grey-900" title={item.title}>
                    {item.title}
                  </p>
                  <Link
                    href={`/projects/${item.projectId}`}
                    className="text-xs text-grey-500 hover:text-blue-600 hover:underline"
                  >
                    {item.projectName || '(이름 없는 과제)'}
                  </Link>
                </div>
              </li>
            );
          })}
        </ol>
      )}
    </section>
  );
}
