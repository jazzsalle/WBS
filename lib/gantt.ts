// 간트 좌표 계산 (SOT §7.5, §6.1.1, §6.5)
// 전부 부수효과 없는 순수 함수다. 좌표가 틀리면 화면 전체가 틀리므로 단위 테스트 필수다
// (CLAUDE.md "순수 함수 + 테스트"). 단위 테스트: tests/unit/gantt.test.ts
//
// §7.5 구현 지침: CSS Grid. 1일 = 스케일별 고정 px, `날짜차이 × px`로 위치·너비를 낸다.
// 날짜 계산은 lib/dates의 달력일 함수만 쓴다 — 여기서 Date 산술을 새로 쓰지 않는다.
// 기준일(오늘)은 인자로만 받는다. 이 파일에서 new Date()를 부르지 않는다 (§6.5).

import { addDays, daysBetween } from '@/lib/dates';

// ─── 스케일 ──────────────────────────────────────────────────

export type GanttScale = 'day' | 'week' | 'month';

export const GANTT_SCALES = ['day', 'week', 'month'] as const satisfies readonly GanttScale[];

export const GANTT_SCALE_LABELS: Record<GanttScale, string> = {
  day: '일',
  week: '주',
  month: '월',
};

// 1일당 px. 정수로 둬서 눈금·막대·밴드가 같은 격자 위에 떨어지게 한다
// (소수 px는 브라우저 반올림 방향이 요소마다 달라 1px씩 어긋난다).
export const DAY_PX: Record<GanttScale, number> = {
  day: 24,
  week: 8,
  month: 3,
};

// 월 스케일은 1일 = 3px이라 하루짜리 작업이 3px로 사라진다. 최소 폭을 주되
// 그 사실을 호출자가 알 수 있게 truncated 플래그로 함께 돌려준다 (§7.5).
export const MIN_BAR_PX = 8;

// 차트 양끝 여백(일). 첫 작업이 축 맨 왼쪽에 딱 붙으면 막대 시작이 잘려 보인다.
export const RANGE_PAD_DAYS: Record<GanttScale, number> = {
  day: 3,
  week: 7,
  month: 15,
};

// ─── 달력 경계 ───────────────────────────────────────────────

// 1970-01-05는 월요일. 주 시작을 월요일로 고정한다(한국 업무 달력 관행).
const WEEK_ANCHOR_MONDAY = '1970-01-05';

/** 그 날짜가 속한 주의 월요일. */
export function startOfWeek(iso: string): string {
  const offset = ((daysBetween(WEEK_ANCHOR_MONDAY, iso) % 7) + 7) % 7;
  return addDays(iso, -offset);
}

/** 그 날짜가 속한 달의 1일. */
export function startOfMonth(iso: string): string {
  return `${iso.slice(0, 7)}-01`;
}

/** 다음 달 1일. */
export function nextMonthStart(iso: string): string {
  const year = Number(iso.slice(0, 4));
  const month = Number(iso.slice(5, 7));
  return month === 12
    ? `${year + 1}-01-01`
    : `${year}-${String(month + 1).padStart(2, '0')}-01`;
}

// ─── 차트 범위 ───────────────────────────────────────────────

export interface GanttRange {
  startDate: string;
  endDate: string;
  /** 시작일·종료일을 모두 포함한 달력일 수 (하루뿐이면 1) */
  totalDays: number;
  widthPx: number;
}

/**
 * 작업·마일스톤·연차의 모든 날짜를 감싸는 차트 범위. null·undefined는 무시한다.
 * 날짜가 하나도 없으면 null — 이때 화면은 축을 그리지 않고 "표시할 일정 없음"을 알린다.
 * 오늘은 범위 계산에 넣지 않는다: 오늘이 일정 밖이면 기준선을 그리지 않고 그 사실을 적는다(§6.5).
 */
export function computeChartRange(
  dates: readonly (string | null | undefined)[],
  scale: GanttScale
): GanttRange | null {
  const known = dates.filter((d): d is string => typeof d === 'string' && d.length > 0);
  if (known.length === 0) return null;

  const min = known.reduce((a, b) => (b < a ? b : a));
  const max = known.reduce((a, b) => (b > a ? b : a));

  const pad = RANGE_PAD_DAYS[scale];
  const startDate = addDays(min, -pad);
  const endDate = addDays(max, pad);
  const totalDays = daysBetween(startDate, endDate) + 1;

  return { startDate, endDate, totalDays, widthPx: totalDays * DAY_PX[scale] };
}

/** 날짜 → x좌표(px). 범위보다 이르면 음수가 나온다 — 자르는 것은 호출자 몫이다. */
export function xOf(range: GanttRange, dateISO: string, scale: GanttScale): number {
  return daysBetween(range.startDate, dateISO) * DAY_PX[scale];
}

/** x좌표(px) → 그 자리에 걸린 날짜. 범위 밖은 범위 끝으로 자른다. */
export function dateAtX(range: GanttRange, x: number, scale: GanttScale): string {
  const day = Math.floor(x / DAY_PX[scale]);
  const clamped = Math.min(Math.max(day, 0), range.totalDays - 1);
  return addDays(range.startDate, clamped);
}

/** 드래그 이동 px → 달력일 수. 반올림이라 반 칸 이상 끌어야 하루가 움직인다. */
export function daysFromPx(dx: number, scale: GanttScale): number {
  return Math.round(dx / DAY_PX[scale]);
}

/** 오늘 세로 기준선의 x. 범위 밖이면 null (§6.5 기준일은 반드시 인자로 받는다). */
export function todayX(
  range: GanttRange,
  todayISO: string,
  scale: GanttScale
): number | null {
  if (todayISO < range.startDate || todayISO > range.endDate) return null;
  return xOf(range, todayISO, scale);
}

// ─── 시간축 눈금 ─────────────────────────────────────────────

export interface GanttTick {
  dateISO: string;
  x: number;
  label: string;
  /** 월 경계 — 스케일과 무관하게 같은 x에 떨어져야 한다 */
  monthStart: boolean;
}

export interface GanttTicks {
  /** 상단 줄: 월 경계 (+ 범위 시작이 월 중간이면 그 지점) */
  major: GanttTick[];
  /** 하단 줄: 일 스케일=매일, 주 스케일=주 시작(월요일), 월 스케일=없음 */
  minor: GanttTick[];
}

function monthLabel(iso: string, withYear: boolean): string {
  const month = Number(iso.slice(5, 7));
  return withYear ? `${iso.slice(0, 4)}.${month}월` : `${month}월`;
}

/**
 * 시간축 눈금. 월 경계는 세 스케일 모두 같은 날짜에서 나오고 x는 xOf와 일치한다
 * (스케일이 바뀌어도 월 경계가 어긋나지 않는다).
 */
export function buildTicks(range: GanttRange, scale: GanttScale): GanttTicks {
  const major: GanttTick[] = [];

  // 범위가 월 중간에서 시작하면 그 달 라벨이 사라진다 — 시작점을 첫 major로 둔다
  const firstMonthStart = startOfMonth(range.startDate);
  if (firstMonthStart !== range.startDate) {
    major.push({
      dateISO: range.startDate,
      x: 0,
      label: monthLabel(range.startDate, true),
      monthStart: false,
    });
  }

  let cursor = firstMonthStart === range.startDate ? range.startDate : nextMonthStart(range.startDate);
  while (cursor <= range.endDate) {
    major.push({
      dateISO: cursor,
      x: xOf(range, cursor, scale),
      // 연이 바뀌는 지점(1월)과 첫 눈금은 연도를 함께 적어야 몇 년 것인지 알 수 있다
      label: monthLabel(cursor, cursor.slice(5, 7) === '01' || major.length === 0),
      monthStart: true,
    });
    cursor = nextMonthStart(cursor);
  }

  const minor: GanttTick[] = [];
  if (scale === 'day') {
    for (let i = 0; i < range.totalDays; i += 1) {
      const dateISO = addDays(range.startDate, i);
      minor.push({
        dateISO,
        x: i * DAY_PX.day,
        label: String(Number(dateISO.slice(8, 10))),
        monthStart: dateISO.slice(8, 10) === '01',
      });
    }
  } else if (scale === 'week') {
    const first = startOfWeek(range.startDate);
    let week = first < range.startDate ? addDays(first, 7) : first;
    while (week <= range.endDate) {
      minor.push({
        dateISO: week,
        x: xOf(range, week, scale),
        label: `${Number(week.slice(5, 7))}/${Number(week.slice(8, 10))}`,
        monthStart: week.slice(8, 10) === '01',
      });
      week = addDays(week, 7);
    }
  }
  // month 스케일은 월 경계(major)가 곧 눈금이라 하위 눈금을 두지 않는다

  return { major, minor };
}

// ─── 연차 배경 밴드 ──────────────────────────────────────────

export interface YearBandInput {
  id: string;
  startDate: string | null;
  endDate: string | null;
}

export interface YearBand {
  id: string;
  startDate: string;
  endDate: string;
  left: number;
  width: number;
}

export interface YearBandResult {
  /** startDate 오름차순 */
  bands: YearBand[];
  /** 기간이 없거나 뒤집혀 그릴 수 없는 연차 — 감추지 않고 화면에 이유를 적는다 (절대 규칙 5) */
  unplottableIds: string[];
  /** 서로 기간이 겹치는 연차. 겹침을 임의로 잘라내지 않고 사실만 알린다 */
  overlappingIds: string[];
}

/** 연차 구간을 배경 밴드 좌표로 바꾼다 (§7.5). 경계 세로선은 밴드의 left/right가 그대로 쓰인다. */
export function computeYearBands(
  years: readonly YearBandInput[],
  range: GanttRange,
  scale: GanttScale
): YearBandResult {
  const bands: YearBand[] = [];
  const unplottableIds: string[] = [];

  for (const year of years) {
    if (year.startDate === null || year.endDate === null || year.startDate > year.endDate) {
      unplottableIds.push(year.id);
      continue;
    }
    const left = xOf(range, year.startDate, scale);
    const width = (daysBetween(year.startDate, year.endDate) + 1) * DAY_PX[scale];
    bands.push({ id: year.id, startDate: year.startDate, endDate: year.endDate, left, width });
  }

  bands.sort((a, b) => (a.startDate === b.startDate ? (a.id < b.id ? -1 : 1) : a.startDate < b.startDate ? -1 : 1));

  // 겹침은 데이터 문제일 수도, 단계 전환기의 실제 중복일 수도 있다 — 판단은 사람에게 맡긴다
  const overlapping = new Set<string>();
  for (let i = 1; i < bands.length; i += 1) {
    const prev = bands[i - 1];
    const cur = bands[i];
    if (prev && cur && cur.startDate <= prev.endDate) {
      overlapping.add(prev.id);
      overlapping.add(cur.id);
    }
  }

  return { bands, unplottableIds, overlappingIds: [...overlapping] };
}

// ─── 막대 좌표 ───────────────────────────────────────────────

export interface BarGeometry {
  left: number;
  /** 최소 폭(MIN_BAR_PX)이 적용된 실제 렌더 폭 */
  width: number;
  /** 날짜 차이 그대로의 폭 */
  naturalWidth: number;
  /** 최소 폭이 적용되어 실제 기간보다 넓게 그려진다 */
  truncated: boolean;
  /** 시작일·마감일 중 한쪽만 있어 하루짜리로 그린다 */
  partial: boolean;
  /** 마감일이 시작일보다 이르다 (데이터 이상) */
  reversed: boolean;
  startDate: string;
  endDate: string;
}

/**
 * 막대의 x·폭. 시작일과 마감일이 모두 null이면 null — 날짜 없는 작업은 목록에만 나온다 (§7.5, P-16).
 * 폭은 마감일 당일까지 포함한다(같은 날이면 1일 폭).
 */
export function computeBarGeometry(
  range: GanttRange,
  startDate: string | null,
  dueDate: string | null,
  scale: GanttScale
): BarGeometry | null {
  if (startDate === null && dueDate === null) return null;

  const partial = startDate === null || dueDate === null;
  const from = startDate ?? (dueDate as string);
  const to = dueDate ?? (startDate as string);
  const reversed = to < from;

  // 뒤집힌 데이터는 숨기지 않고 하루짜리로 그린 뒤 플래그로 알린다
  const spanDays = reversed ? 1 : daysBetween(from, to) + 1;
  const naturalWidth = spanDays * DAY_PX[scale];
  const width = Math.max(naturalWidth, MIN_BAR_PX);

  return {
    left: xOf(range, from, scale),
    width,
    naturalWidth,
    truncated: naturalWidth < MIN_BAR_PX,
    partial,
    reversed,
    startDate: from,
    endDate: reversed ? from : to,
  };
}

// ─── 드래그 결과 날짜 ────────────────────────────────────────

export interface TaskDates {
  startDate: string | null;
  dueDate: string | null;
}

/** 막대 이동: 있는 날짜만 같은 일수만큼 민다(기간은 그대로). */
export function moveTaskDates(dates: TaskDates, deltaDays: number): TaskDates {
  if (deltaDays === 0) return dates;
  return {
    startDate: dates.startDate === null ? null : addDays(dates.startDate, deltaDays),
    dueDate: dates.dueDate === null ? null : addDays(dates.dueDate, deltaDays),
  };
}

/** 왼쪽 캡 리사이즈: 시작일만 바꾸고 마감일을 넘어가지 않게 막는다. */
export function resizeTaskStart(dates: TaskDates, deltaDays: number): TaskDates {
  const base = dates.startDate ?? dates.dueDate;
  if (base === null) return dates;
  let next = addDays(base, deltaDays);
  if (dates.dueDate !== null && next > dates.dueDate) next = dates.dueDate;
  return { startDate: next, dueDate: dates.dueDate };
}

/** 오른쪽 캡 리사이즈: 마감일만 바꾸고 시작일보다 앞서지 않게 막는다. */
export function resizeTaskDue(dates: TaskDates, deltaDays: number): TaskDates {
  const base = dates.dueDate ?? dates.startDate;
  if (base === null) return dates;
  let next = addDays(base, deltaDays);
  if (dates.startDate !== null && next < dates.startDate) next = dates.startDate;
  return { startDate: dates.startDate, dueDate: next };
}
