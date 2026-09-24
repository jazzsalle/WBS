'use client';

// 마일스톤 레인 (SOT §7.5 "마일스톤은 상단 별도 레인에 마름모 마커로 표시. 유형별 색상 구분")
// 색의 원본은 MILESTONE_TYPE_COLORS(부록 A.3)다 — 여기서는 토큰을 Tailwind 클래스로 옮기기만 한다.
// 지연·임박 판정은 서버가 내려준 기준일(todayISO)로만 한다. 여기서 new Date()를 부르지 않는다 (§6.5).

import type { Milestone } from '@/types';
import {
  DUE_COLORS,
  MILESTONE_STATUS_LABELS,
  MILESTONE_TYPE_COLORS,
  MILESTONE_TYPE_LABELS,
} from '@/lib/constants';
import { isOverdueMilestone, isUpcomingMilestone } from '@/lib/dates';
import { xOf, type GanttRange, type GanttScale } from '@/lib/gantt';

// Tailwind는 클래스명을 정적으로 스캔한다 — 토큰을 문자열로 조합하지 않고 완전한 형태로 나열한다.
const MARKER_COLOR_CLASSES: Record<string, string> = {
  'purple-600': 'bg-purple-600',
  'blue-600': 'bg-blue-600',
  'teal-600': 'bg-teal-600',
  'grey-600': 'bg-grey-600',
};

const DUE_RING_CLASSES: Record<string, string> = {
  'red-600': 'ring-2 ring-red-600',
  'orange-500': 'ring-2 ring-orange-500',
};

const MARKER_PX = 12;
export const LANE_ROW_HEIGHT = 18;
const LANE_PADDING = 8;
// 이보다 가까운 마커는 한 점으로 뭉쳐 보이므로 다음 줄로 내린다
const MIN_GAP_PX = MARKER_PX + 4;

export interface MilestoneMarker {
  milestone: Milestone;
  x: number;
  row: number;
  overdue: boolean;
  upcoming: boolean;
}

export interface MilestoneLayout {
  markers: MilestoneMarker[];
  /** 레인 높이(px). 좌측 패널이 같은 높이를 써야 행이 어긋나지 않는다 */
  height: number;
}

/**
 * 마커 좌표와 겹침 회피 줄 배치. 좌측 패널 높이를 맞추려면 화면이 먼저 이걸 계산해야 하므로
 * 컴포넌트 밖으로 뺀다. milestones는 날짜 오름차순이어야 한다(getGanttData가 정렬해 준다).
 */
export function layoutMilestones(
  milestones: readonly Milestone[],
  range: GanttRange,
  scale: GanttScale,
  todayISO: string,
  milestoneAlertDays: number
): MilestoneLayout {
  const lastXByRow: number[] = [];
  const markers: MilestoneMarker[] = milestones.map((milestone) => {
    const x = xOf(range, milestone.date, scale);
    let row = lastXByRow.findIndex((last) => x - last >= MIN_GAP_PX);
    if (row < 0) {
      lastXByRow.push(x);
      row = lastXByRow.length - 1;
    } else {
      lastXByRow[row] = x;
    }
    return {
      milestone,
      x,
      row,
      overdue: isOverdueMilestone(milestone, todayISO),
      upcoming: isUpcomingMilestone(milestone, todayISO, milestoneAlertDays),
    };
  });

  const rows = Math.max(lastXByRow.length, 1);
  return { markers, height: rows * LANE_ROW_HEIGHT + LANE_PADDING };
}

function markerTitle(marker: MilestoneMarker): string {
  const m = marker.milestone;
  const state = marker.overdue ? ' · 지연' : marker.upcoming ? ' · 임박' : '';
  return `${m.date} ${MILESTONE_TYPE_LABELS[m.type]} · ${m.title} · ${MILESTONE_STATUS_LABELS[m.status]}${state}`;
}

export interface MilestoneLaneProps {
  layout: MilestoneLayout;
  range: GanttRange;
}

export default function MilestoneLane({ layout, range }: MilestoneLaneProps) {
  return (
    <div
      aria-label="마일스톤"
      className="relative border-b border-grey-200 bg-white"
      style={{ width: range.widthPx, height: layout.height }}
    >
      {layout.markers.map((marker) => {
        const m = marker.milestone;
        const colorClass = MARKER_COLOR_CLASSES[MILESTONE_TYPE_COLORS[m.type]] ?? 'bg-grey-600';
        const ringClass = marker.overdue
          ? (DUE_RING_CLASSES[DUE_COLORS.overdue] ?? '')
          : marker.upcoming
            ? (DUE_RING_CLASSES[DUE_COLORS.dueSoon] ?? '')
            : '';
        const title = markerTitle(marker);
        return (
          <span
            key={m.id}
            role="img"
            aria-label={title}
            title={title}
            // 마름모 = 정사각형 45° 회전. -translate-x-1/2로 마커 중심을 날짜에 맞춘다
            className={`absolute rotate-45 ${colorClass} ${ringClass} ${
              m.status === 'cancelled' ? 'opacity-40' : ''
            }`}
            style={{
              left: marker.x - MARKER_PX / 2,
              top: marker.row * LANE_ROW_HEIGHT + LANE_PADDING / 2,
              width: MARKER_PX,
              height: MARKER_PX,
            }}
          />
        );
      })}
      {layout.markers.length === 0 && (
        <span className="absolute left-2 top-1 text-[11px] text-grey-400">
          등록된 마일스톤이 없습니다
        </span>
      )}
    </div>
  );
}
