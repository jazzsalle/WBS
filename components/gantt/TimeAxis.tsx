'use client';

// 간트 시간축 (SOT §7.5 "우측 시간축: 일/주/월 스케일 전환")
// 눈금 좌표는 전부 lib/gantt.buildTicks가 낸 값이다 — 여기서 날짜 계산을 새로 하지 않는다.
// 월 경계(major)는 스케일이 바뀌어도 같은 날짜에서 나온다(단위 테스트로 고정).

import type { GanttRange, GanttScale, GanttTicks } from '@/lib/gantt';

export const AXIS_HEIGHT = 44;
const MAJOR_ROW_HEIGHT = 22;

export interface TimeAxisProps {
  range: GanttRange;
  scale: GanttScale;
  ticks: GanttTicks;
  /** 오늘 세로 기준선의 x. 범위 밖이면 null (§6.5) */
  todayX: number | null;
}

export default function TimeAxis({ range, scale, ticks, todayX }: TimeAxisProps) {
  return (
    <div
      className="relative border-b border-grey-300 bg-grey-50"
      style={{ width: range.widthPx, height: AXIS_HEIGHT }}
    >
      {ticks.major.map((tick) => (
        <div
          key={`major-${tick.dateISO}`}
          className="absolute top-0 border-l border-grey-300"
          style={{ left: tick.x, height: MAJOR_ROW_HEIGHT }}
        >
          <span className="whitespace-nowrap pl-1 text-[11px] font-semibold text-grey-600">
            {tick.label}
          </span>
        </div>
      ))}

      {ticks.minor.map((tick) => (
        <div
          key={`minor-${tick.dateISO}`}
          className={`absolute border-l ${tick.monthStart ? 'border-grey-300' : 'border-grey-200'}`}
          style={{ left: tick.x, top: MAJOR_ROW_HEIGHT, height: AXIS_HEIGHT - MAJOR_ROW_HEIGHT }}
        >
          <span className="whitespace-nowrap pl-0.5 text-[10px] tabular-nums text-grey-400">
            {tick.label}
          </span>
        </div>
      ))}

      {/* 월 스케일은 하위 눈금이 없어 축 아래쪽이 비므로 범위를 적어 둔다 */}
      {scale === 'month' && (
        <span
          className="absolute left-1 text-[10px] text-grey-400"
          style={{ top: MAJOR_ROW_HEIGHT + 2 }}
        >
          {range.startDate} ~ {range.endDate}
        </span>
      )}

      {todayX !== null && (
        <div
          aria-hidden
          className="pointer-events-none absolute bottom-0 z-10 w-px bg-red-500"
          style={{ left: todayX, height: AXIS_HEIGHT }}
        >
          <span className="absolute -top-0.5 left-0.5 whitespace-nowrap rounded bg-red-600 px-1 text-[10px] font-semibold leading-4 text-white">
            오늘
          </span>
        </div>
      )}
    </div>
  );
}
