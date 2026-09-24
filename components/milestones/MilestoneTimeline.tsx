'use client';

// 마일스톤 타임라인 (SOT §7.8 "상단 수평 타임라인 — 연차 밴드 위에 유형별 마커", 부록 A.3)
// 새 의존성 없이 CSS 포지셔닝만으로 그린다. 가로 위치는 lib/dates.daysBetween이 낸 달력일 차이의
// 비율이다 — 날짜 계산을 화면에서 새로 쓰지 않는다 (§6.5).
// 오늘 위치도 서버가 내려준 기준일(todayISO)로만 찍는다. 여기서 new Date()를 부르지 않는다.
// 마커 색의 원본은 MILESTONE_TYPE_COLORS(부록 A.3)다. 여기서는 그 토큰을 Tailwind 클래스로 옮기기만 한다.

import type { MilestoneType, Year } from '@/types';
import {
  DUE_COLORS,
  MILESTONE_STATUS_LABELS,
  MILESTONE_TYPE_COLORS,
  MILESTONE_TYPE_LABELS,
} from '@/lib/constants';
import { daysBetween } from '@/lib/dates';
import type { MilestoneView } from './MilestoneTable';

// Tailwind는 클래스명을 정적으로 스캔한다 — 토큰을 문자열로 조합하지 않고 완전한 형태로 나열한다.
const MARKER_COLOR_CLASSES: Record<string, string> = {
  'purple-600': 'bg-purple-600',
  'blue-600': 'bg-blue-600',
  'teal-600': 'bg-teal-600',
  'grey-600': 'bg-grey-600',
};

// §6.5 지연·임박은 부록 A.3의 마감 색으로 테두리를 두른다 (색 정의의 원본은 DUE_COLORS)
const DUE_RING_CLASSES: Record<string, string> = {
  'red-600': 'ring-2 ring-red-600',
  'orange-500': 'ring-2 ring-orange-500',
};

// 같은 색을 쓰는 유형끼리 묶어 범례를 만든다 — 색 그룹의 근거는 A.3 하나뿐이다
const LEGEND = (Object.keys(MILESTONE_TYPE_COLORS) as MilestoneType[]).reduce<
  { token: string; labels: string[] }[]
>((groups, type) => {
  const token = MILESTONE_TYPE_COLORS[type];
  const group = groups.find((g) => g.token === token);
  if (group) group.labels.push(MILESTONE_TYPE_LABELS[type]);
  else groups.push({ token, labels: [MILESTONE_TYPE_LABELS[type]] });
  return groups;
}, []);

const ROW_PX = 16; // 마커(h-3 = 12px) 한 줄 높이
// 최소 폭 900px에서 약 14px — 이보다 가까운 마커는 한 점으로 뭉쳐 보이므로 다음 줄로 내린다
const MIN_GAP_PCT = 1.6;

/** §5.5: name이 있으면 name, 없으면 order+1 + '차년도' */
function yearLabel(year: Year): string {
  return year.name.trim() || `${year.order + 1}차년도`;
}

interface Band {
  year: Year;
  startDate: string;
  endDate: string;
}

interface Marker {
  view: MilestoneView;
  pct: number;
  row: number;
}

/**
 * 겹치는 마커를 줄로 나눈다. items는 pct 오름차순이어야 한다(날짜 오름차순 정렬의 결과).
 * 반환값의 인덱스는 items와 같다.
 */
function assignRows(pcts: readonly number[]): number[] {
  const lastPctByRow: number[] = [];
  return pcts.map((pct) => {
    for (let row = 0; row < lastPctByRow.length; row += 1) {
      const last = lastPctByRow[row];
      if (last === undefined || pct - last >= MIN_GAP_PCT) {
        lastPctByRow[row] = pct;
        return row;
      }
    }
    lastPctByRow.push(pct);
    return lastPctByRow.length - 1;
  });
}

function markerDescription(view: MilestoneView, yearName: string): string {
  const m = view.milestone;
  const state = view.overdue ? ' · 지연' : view.upcoming ? ' · 임박' : '';
  return `${m.date} ${MILESTONE_TYPE_LABELS[m.type]} · ${m.title} · ${yearName} · ${MILESTONE_STATUS_LABELS[m.status]}${state}`;
}

export interface MilestoneTimelineProps {
  /** 날짜 오름차순으로 정렬된 상태로 받는다 */
  views: MilestoneView[];
  years: Year[];
  /** §6.5 기준일. 서버가 Asia/Seoul 달력으로 고정해 내려준 값 */
  todayISO: string;
  selectedId: string | null;
  onSelect: (id: string) => void;
}

export default function MilestoneTimeline({
  views,
  years,
  todayISO,
  selectedId,
  onSelect,
}: MilestoneTimelineProps) {
  // 기간이 없거나 뒤집힌 연차는 밴드를 그릴 수 없다 — 감추지 않고 아래에 이유를 적는다
  const bands: Band[] = [];
  const unplottableYears: Year[] = [];
  for (const year of years) {
    if (year.startDate !== null && year.endDate !== null && year.startDate <= year.endDate) {
      bands.push({ year, startDate: year.startDate, endDate: year.endDate });
    } else {
      unplottableYears.push(year);
    }
  }

  const dates: string[] = [];
  for (const band of bands) dates.push(band.startDate, band.endDate);
  for (const view of views) dates.push(view.milestone.date);

  if (dates.length === 0) {
    return (
      <section
        aria-labelledby="milestone-timeline-title"
        className="rounded-xl border border-grey-200 bg-surface p-4 print:hidden"
      >
        <h2 id="milestone-timeline-title" className="text-base font-bold text-grey-900">
          타임라인
        </h2>
        <p className="mt-2 text-sm text-grey-400">
          표시할 일정이 없습니다. 연차 기간을 입력하거나 마일스톤을 추가하면 여기에 그려집니다.
        </p>
      </section>
    );
  }

  const rangeStart = dates.reduce((min, d) => (d < min ? d : min));
  const rangeEnd = dates.reduce((max, d) => (d > max ? d : max));
  const totalDays = daysBetween(rangeStart, rangeEnd);

  // 구간이 하루뿐이면 나눌 폭이 없다 — 전부 가운데에 둔다
  const pctOf = (dateISO: string): number =>
    totalDays === 0 ? 50 : (daysBetween(rangeStart, dateISO) / totalDays) * 100;

  const yearNameById = new Map(years.map((year) => [year.id, yearLabel(year)]));

  // H-5: 연차를 지워도 마일스톤은 남는다. 연차 없는 마일스톤은 밴드 아래 별도 레인에 그린다.
  const bandViews = views.filter((v) => v.milestone.yearId !== null);
  const looseViews = views.filter((v) => v.milestone.yearId === null);

  const toMarkers = (source: MilestoneView[]): Marker[] => {
    const pcts = source.map((view) => pctOf(view.milestone.date));
    const rows = assignRows(pcts);
    return source.map((view, i) => ({ view, pct: pcts[i] ?? 0, row: rows[i] ?? 0 }));
  };

  const bandMarkers = toMarkers(bandViews);
  const looseMarkers = toMarkers(looseViews);

  const laneHeight = (markers: Marker[]): number =>
    markers.length === 0 ? 0 : (Math.max(...markers.map((m) => m.row)) + 1) * ROW_PX;

  const topLaneHeight = laneHeight(bandMarkers);
  const topMaxRow = bandMarkers.length === 0 ? 0 : Math.max(...bandMarkers.map((m) => m.row));

  const todayInRange = todayISO >= rangeStart && todayISO <= rangeEnd;
  const todayPct = todayInRange ? pctOf(todayISO) : 0;

  const renderMarker = (marker: Marker, top: number) => {
    const m = marker.view.milestone;
    const yearName = m.yearId === null ? '연차 없음' : (yearNameById.get(m.yearId) ?? '(삭제된 연차)');
    const colorClass = MARKER_COLOR_CLASSES[MILESTONE_TYPE_COLORS[m.type]] ?? 'bg-grey-600';
    const ringClass = marker.view.overdue
      ? (DUE_RING_CLASSES[DUE_COLORS.overdue] ?? '')
      : marker.view.upcoming
        ? (DUE_RING_CLASSES[DUE_COLORS.dueSoon] ?? '')
        : '';
    const description = markerDescription(marker.view, yearName);

    return (
      <button
        key={m.id}
        type="button"
        onClick={() => onSelect(m.id)}
        title={description}
        aria-label={description}
        aria-pressed={selectedId === m.id}
        className={`absolute h-3 w-3 -translate-x-1/2 rounded-full ${colorClass} ${ringClass} ${
          m.status === 'cancelled' ? 'opacity-40' : ''
        } ${selectedId === m.id ? 'outline outline-2 outline-offset-2 outline-grey-900' : ''}`}
        style={{ left: `${marker.pct}%`, top: `${top}px` }}
      />
    );
  };

  return (
    <section
      aria-labelledby="milestone-timeline-title"
      className="rounded-xl border border-grey-200 bg-surface p-4 print:hidden"
    >
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 id="milestone-timeline-title" className="text-base font-bold text-grey-900">
          타임라인
          <span className="ml-2 text-xs font-normal text-grey-500">
            {rangeStart} ~ {rangeEnd}
          </span>
        </h2>
        <ul className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-grey-500">
          {LEGEND.map((group) => (
            <li key={group.token} className="flex items-center gap-1.5">
              <span
                aria-hidden
                className={`h-2.5 w-2.5 rounded-full ${MARKER_COLOR_CLASSES[group.token] ?? 'bg-grey-600'}`}
              />
              {group.labels.join(' · ')}
            </li>
          ))}
        </ul>
      </div>

      {/* 좌우 여백은 스크롤 컨테이너에 준다 — 좌표 기준(min-w 박스)이 흔들리면 밴드와 마커가 어긋난다 */}
      <div className="mt-4 overflow-x-auto px-2">
        <div className="min-w-[900px]">
          {/* 오늘 라벨 자리를 padding으로 확보한다 — 자식의 margin이 무너져 라벨이 잘리지 않게 */}
          <div className="relative pt-5">
            {/* 오늘 위치 (§6.5 기준일). 구간 밖이면 선을 그리지 않고 아래에 사실을 적는다 */}
            {todayInRange && (
              <div
                aria-hidden
                className="pointer-events-none absolute inset-y-0 z-10 w-px bg-grey-900/70"
                style={{ left: `${todayPct}%` }}
              >
                <span className="absolute left-1 top-0 rounded bg-grey-900 px-1 text-[10px] font-semibold leading-4 text-surface">
                  오늘
                </span>
              </div>
            )}

            {/* 연차에 속한 마일스톤 마커: 밴드 바로 위에서 위로 쌓는다 */}
            <div className="relative" style={{ height: `${topLaneHeight}px` }}>
              {bandMarkers.map((marker) => renderMarker(marker, (topMaxRow - marker.row) * ROW_PX))}
            </div>

            {/* 연차 밴드 */}
            <div className="relative mt-1 h-9 overflow-hidden rounded-lg bg-grey-50">
              {bands.map((band, index) => {
                const left = pctOf(band.startDate);
                const width = Math.max(pctOf(band.endDate) - left, 0.4);
                return (
                  <div
                    key={band.year.id}
                    title={`${yearLabel(band.year)} ${band.startDate} ~ ${band.endDate}`}
                    className={`absolute inset-y-0 flex items-center justify-center overflow-hidden border-x border-white px-1 text-xs font-medium text-grey-700 ${
                      index % 2 === 0 ? 'bg-grey-200' : 'bg-grey-100'
                    }`}
                    style={{ left: `${left}%`, width: `${width}%` }}
                  >
                    <span className="truncate">{yearLabel(band.year)}</span>
                  </div>
                );
              })}
              {bands.length === 0 && (
                <span className="absolute inset-0 flex items-center justify-center text-xs text-grey-400">
                  기간이 입력된 연차가 없습니다
                </span>
              )}
            </div>

            {/* H-5: 연차 없는 마일스톤 전용 레인 — 밴드에 걸 곳이 없어도 숨기지 않는다 */}
            {looseMarkers.length > 0 && (
              <div className="relative mt-2" style={{ height: `${laneHeight(looseMarkers)}px` }}>
                {looseMarkers.map((marker) => renderMarker(marker, marker.row * ROW_PX))}
              </div>
            )}
          </div>

          <div className="mt-1 flex justify-between text-[11px] tabular-nums text-grey-400">
            <span>{rangeStart}</span>
            <span>{rangeEnd}</span>
          </div>
        </div>
      </div>

      {looseMarkers.length > 0 && (
        <p className="mt-2 text-xs text-grey-500">
          아래 레인은 연차가 지정되지 않은 마일스톤 {looseMarkers.length}건입니다(과제 전체 이벤트
          또는 연차가 삭제된 항목).
        </p>
      )}

      {!todayInRange && (
        <p className="mt-2 text-xs text-grey-500">
          오늘({todayISO})은 표시 구간 밖이라 기준선을 그리지 않았습니다.
        </p>
      )}

      {unplottableYears.length > 0 && (
        <p className="mt-2 text-xs text-grey-500">
          기간이 없거나 시작일이 종료일보다 늦어 밴드를 그리지 못한 연차:{' '}
          {unplottableYears.map(yearLabel).join(', ')}
        </p>
      )}
    </section>
  );
}
