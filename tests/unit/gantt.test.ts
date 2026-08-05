// 간트 좌표 계산 테스트 (SOT §7.5, §6.1.1, §6.5)
// 좌표가 틀리면 화면 전체가 틀린다 — 스케일 3종 × (x좌표·폭·눈금·오늘선·연차 밴드·범위)를 고정한다.

import { describe, expect, it } from 'vitest';
import {
  DAY_PX,
  GANTT_SCALES,
  MIN_BAR_PX,
  RANGE_PAD_DAYS,
  buildTicks,
  computeBarGeometry,
  computeChartRange,
  computeYearBands,
  dateAtX,
  daysFromPx,
  moveTaskDates,
  nextMonthStart,
  resizeTaskDue,
  resizeTaskStart,
  startOfMonth,
  startOfWeek,
  todayX,
  xOf,
  type GanttRange,
  type GanttScale,
} from '@/lib/gantt';

// 2026-01-01 ~ 2026-12-31 (365일). 여백 없이 직접 만든 범위라 좌표가 자명하다.
function fixedRange(scale: GanttScale): GanttRange {
  return {
    startDate: '2026-01-01',
    endDate: '2026-12-31',
    totalDays: 365,
    widthPx: 365 * DAY_PX[scale],
  };
}

describe('달력 경계', () => {
  it('startOfWeek는 월요일을 돌려준다', () => {
    // 2026-08-05는 수요일 → 같은 주 월요일은 2026-08-03
    expect(startOfWeek('2026-08-05')).toBe('2026-08-03');
    expect(startOfWeek('2026-08-03')).toBe('2026-08-03'); // 월요일은 그대로
    expect(startOfWeek('2026-08-09')).toBe('2026-08-03'); // 일요일은 그 주 월요일
  });

  it('startOfMonth / nextMonthStart는 연말을 넘긴다', () => {
    expect(startOfMonth('2026-08-05')).toBe('2026-08-01');
    expect(nextMonthStart('2026-08-01')).toBe('2026-09-01');
    expect(nextMonthStart('2026-12-15')).toBe('2027-01-01');
  });
});

describe('computeChartRange', () => {
  it('작업·마일스톤·연차 날짜를 모두 감싼다', () => {
    const range = computeChartRange(
      ['2026-03-10', '2026-01-05', null, '2026-09-30', undefined],
      'day'
    );
    expect(range).not.toBeNull();
    // 최소 2026-01-05, 최대 2026-09-30에 스케일별 여백이 붙는다
    expect(range?.startDate).toBe('2026-01-02'); // -3일
    expect(range?.endDate).toBe('2026-10-03'); // +3일
  });

  it('스케일마다 여백과 폭이 다르다', () => {
    for (const scale of GANTT_SCALES) {
      const range = computeChartRange(['2026-05-01', '2026-05-10'], scale);
      expect(range).not.toBeNull();
      if (!range) continue;
      const pad = RANGE_PAD_DAYS[scale];
      // 10일 구간 + 양쪽 여백
      expect(range.totalDays).toBe(10 + pad * 2);
      expect(range.widthPx).toBe(range.totalDays * DAY_PX[scale]);
    }
  });

  it('날짜가 하나뿐이면 여백만큼의 범위가 나온다', () => {
    const range = computeChartRange(['2026-05-01'], 'day');
    expect(range?.startDate).toBe('2026-04-28');
    expect(range?.endDate).toBe('2026-05-04');
    expect(range?.totalDays).toBe(7);
  });

  it('날짜가 하나도 없으면 null이다 (축을 그리지 않는다)', () => {
    expect(computeChartRange([], 'day')).toBeNull();
    expect(computeChartRange([null, undefined, null], 'month')).toBeNull();
  });
});

describe('xOf / dateAtX / daysFromPx', () => {
  it('날짜 차이 × 1일 px가 x좌표다 (스케일 3종)', () => {
    for (const scale of GANTT_SCALES) {
      const range = fixedRange(scale);
      expect(xOf(range, '2026-01-01', scale)).toBe(0);
      expect(xOf(range, '2026-01-11', scale)).toBe(10 * DAY_PX[scale]);
      expect(xOf(range, '2026-12-31', scale)).toBe(364 * DAY_PX[scale]);
    }
  });

  it('범위보다 이른 날짜는 음수 x를 준다 (자르는 것은 화면 몫)', () => {
    const range = fixedRange('day');
    expect(xOf(range, '2025-12-30', 'day')).toBe(-2 * DAY_PX.day);
  });

  it('dateAtX는 x가 걸친 날짜를 주고 범위 밖은 끝으로 자른다', () => {
    const range = fixedRange('week');
    expect(dateAtX(range, 0, 'week')).toBe('2026-01-01');
    expect(dateAtX(range, DAY_PX.week * 3 + 1, 'week')).toBe('2026-01-04');
    expect(dateAtX(range, -500, 'week')).toBe('2026-01-01');
    expect(dateAtX(range, 999_999, 'week')).toBe('2026-12-31');
  });

  it('daysFromPx는 반 칸을 넘겨야 하루가 움직인다', () => {
    expect(daysFromPx(DAY_PX.day * 2, 'day')).toBe(2);
    expect(daysFromPx(DAY_PX.day / 2 - 1, 'day')).toBe(0);
    expect(daysFromPx(-DAY_PX.month * 10, 'month')).toBe(-10);
  });
});

describe('buildTicks', () => {
  it('월 경계는 스케일이 달라도 같은 날짜에서 나오고 x가 xOf와 일치한다', () => {
    const monthStarts: Record<GanttScale, string[]> = { day: [], week: [], month: [] };
    for (const scale of GANTT_SCALES) {
      const range = fixedRange(scale);
      const { major } = buildTicks(range, scale);
      for (const tick of major) {
        expect(tick.x).toBe(xOf(range, tick.dateISO, scale));
        if (tick.monthStart) monthStarts[scale].push(tick.dateISO);
      }
    }
    expect(monthStarts.day).toHaveLength(12); // 2026-01-01 ~ 2026-12-01
    expect(monthStarts.day[0]).toBe('2026-01-01');
    expect(monthStarts.week).toEqual(monthStarts.day);
    expect(monthStarts.month).toEqual(monthStarts.day);
  });

  it('범위가 월 중간에서 시작하면 그 지점을 첫 눈금으로 둔다', () => {
    const range: GanttRange = {
      startDate: '2026-03-15',
      endDate: '2026-05-10',
      totalDays: 57,
      widthPx: 57 * DAY_PX.day,
    };
    const { major } = buildTicks(range, 'day');
    expect(major[0]?.dateISO).toBe('2026-03-15');
    expect(major[0]?.x).toBe(0);
    expect(major[0]?.monthStart).toBe(false);
    expect(major.slice(1).map((t) => t.dateISO)).toEqual(['2026-04-01', '2026-05-01']);
  });

  it('일 스케일은 매일, 주 스케일은 월요일, 월 스케일은 하위 눈금이 없다', () => {
    const dayRange: GanttRange = {
      startDate: '2026-08-01',
      endDate: '2026-08-31',
      totalDays: 31,
      widthPx: 31 * DAY_PX.day,
    };
    const day = buildTicks(dayRange, 'day');
    expect(day.minor).toHaveLength(31);
    expect(day.minor[0]?.label).toBe('1');
    expect(day.minor[30]?.dateISO).toBe('2026-08-31');

    const weekRange: GanttRange = { ...dayRange, widthPx: 31 * DAY_PX.week };
    const week = buildTicks(weekRange, 'week');
    // 2026-08-01(토) 이후 첫 월요일은 08-03, 이후 7일 간격
    expect(week.minor.map((t) => t.dateISO)).toEqual([
      '2026-08-03',
      '2026-08-10',
      '2026-08-17',
      '2026-08-24',
      '2026-08-31',
    ]);
    expect(week.minor[0]?.x).toBe(2 * DAY_PX.week);

    const month = buildTicks({ ...dayRange, widthPx: 31 * DAY_PX.month }, 'month');
    expect(month.minor).toHaveLength(0);
    expect(month.major.length).toBeGreaterThan(0);
  });
});

describe('todayX', () => {
  it('범위 안이면 날짜 차이 × px, 밖이면 null이다', () => {
    const range = fixedRange('day');
    expect(todayX(range, '2026-01-01', 'day')).toBe(0);
    expect(todayX(range, '2026-03-02', 'day')).toBe(60 * DAY_PX.day); // 1월 31 + 2월 28 + 1
    expect(todayX(range, '2025-12-31', 'day')).toBeNull();
    expect(todayX(range, '2027-01-01', 'day')).toBeNull();
  });

  it('경계 당일은 범위 안이다', () => {
    const range = fixedRange('month');
    expect(todayX(range, '2026-12-31', 'month')).toBe(364 * DAY_PX.month);
  });
});

describe('computeYearBands', () => {
  const range = fixedRange('day');

  it('연차 구간을 좌표로 바꾸고 종료일 당일까지 포함한다', () => {
    const { bands, unplottableIds, overlappingIds } = computeYearBands(
      [
        { id: 'y2', startDate: '2026-07-01', endDate: '2026-12-31' },
        { id: 'y1', startDate: '2026-01-01', endDate: '2026-06-30' },
      ],
      range,
      'day'
    );
    expect(bands.map((b) => b.id)).toEqual(['y1', 'y2']); // 시작일 오름차순
    expect(bands[0]?.left).toBe(0);
    expect(bands[0]?.width).toBe(181 * DAY_PX.day); // 1/1~6/30 = 181일
    expect(bands[1]?.left).toBe(181 * DAY_PX.day);
    expect(bands[1]?.width).toBe(184 * DAY_PX.day);
    expect(unplottableIds).toEqual([]);
    expect(overlappingIds).toEqual([]);
  });

  it('기간이 없거나 뒤집힌 연차는 밴드에서 빼고 이유를 알린다', () => {
    const { bands, unplottableIds } = computeYearBands(
      [
        { id: 'a', startDate: null, endDate: '2026-06-30' },
        { id: 'b', startDate: '2026-01-01', endDate: null },
        { id: 'c', startDate: null, endDate: null },
        { id: 'd', startDate: '2026-06-30', endDate: '2026-01-01' },
        { id: 'e', startDate: '2026-02-01', endDate: '2026-02-01' },
      ],
      range,
      'day'
    );
    expect(bands.map((b) => b.id)).toEqual(['e']);
    expect(bands[0]?.width).toBe(DAY_PX.day); // 하루짜리 연차도 1일 폭
    expect(unplottableIds).toEqual(['a', 'b', 'c', 'd']);
  });

  it('겹치는 연차는 자르지 않고 겹침 사실만 알린다', () => {
    const { bands, overlappingIds } = computeYearBands(
      [
        { id: 'y1', startDate: '2026-01-01', endDate: '2026-07-31' },
        { id: 'y2', startDate: '2026-07-01', endDate: '2026-12-31' },
        { id: 'y3', startDate: '2026-12-01', endDate: '2026-12-31' },
      ],
      range,
      'day'
    );
    expect(bands).toHaveLength(3);
    expect(overlappingIds.sort()).toEqual(['y1', 'y2', 'y3']);
    // 자르지 않았으므로 y1의 오른쪽 끝이 y2의 왼쪽 끝보다 뒤에 있다
    const [y1, y2] = bands;
    expect((y1?.left ?? 0) + (y1?.width ?? 0)).toBeGreaterThan(y2?.left ?? 0);
  });
});

describe('computeBarGeometry', () => {
  it('시작일·마감일이 모두 없으면 막대가 없다 (P-16: 목록에만 표시)', () => {
    expect(computeBarGeometry(fixedRange('day'), null, null, 'day')).toBeNull();
  });

  it('마감일 당일을 포함한 폭을 낸다 (스케일 3종)', () => {
    for (const scale of GANTT_SCALES) {
      const range = fixedRange(scale);
      const bar = computeBarGeometry(range, '2026-02-01', '2026-02-10', scale);
      expect(bar?.left).toBe(31 * DAY_PX[scale]);
      expect(bar?.naturalWidth).toBe(10 * DAY_PX[scale]);
      expect(bar?.partial).toBe(false);
      expect(bar?.reversed).toBe(false);
    }
  });

  it('같은 날 시작·마감은 1일 폭이다', () => {
    const bar = computeBarGeometry(fixedRange('day'), '2026-02-01', '2026-02-01', 'day');
    expect(bar?.naturalWidth).toBe(DAY_PX.day);
    expect(bar?.width).toBe(DAY_PX.day);
    expect(bar?.truncated).toBe(false);
  });

  it('월 스케일에서 짧은 작업은 최소 폭이 적용되고 그 사실이 플래그로 남는다', () => {
    const range = fixedRange('month');
    const bar = computeBarGeometry(range, '2026-02-01', '2026-02-01', 'month');
    expect(bar?.naturalWidth).toBe(DAY_PX.month); // 3px — 그대로 두면 사라진다
    expect(bar?.width).toBe(MIN_BAR_PX);
    expect(bar?.truncated).toBe(true);

    // 최소 폭을 넘는 기간에는 적용되지 않는다
    const wide = computeBarGeometry(range, '2026-02-01', '2026-02-10', 'month');
    expect(wide?.width).toBe(10 * DAY_PX.month);
    expect(wide?.truncated).toBe(false);
  });

  it('한쪽 날짜만 있으면 하루짜리로 그리고 partial로 알린다', () => {
    const range = fixedRange('day');
    const onlyStart = computeBarGeometry(range, '2026-03-01', null, 'day');
    expect(onlyStart?.partial).toBe(true);
    expect(onlyStart?.startDate).toBe('2026-03-01');
    expect(onlyStart?.endDate).toBe('2026-03-01');
    expect(onlyStart?.naturalWidth).toBe(DAY_PX.day);

    const onlyDue = computeBarGeometry(range, null, '2026-03-05', 'day');
    expect(onlyDue?.partial).toBe(true);
    expect(onlyDue?.left).toBe(63 * DAY_PX.day);
  });

  it('마감일이 시작일보다 이르면 숨기지 않고 reversed로 알린다', () => {
    const bar = computeBarGeometry(fixedRange('day'), '2026-03-10', '2026-03-01', 'day');
    expect(bar?.reversed).toBe(true);
    expect(bar?.naturalWidth).toBe(DAY_PX.day);
    expect(bar?.left).toBe(xOf(fixedRange('day'), '2026-03-10', 'day'));
  });
});

describe('드래그 결과 날짜', () => {
  it('이동은 기간을 유지한 채 양끝을 민다', () => {
    expect(moveTaskDates({ startDate: '2026-03-01', dueDate: '2026-03-10' }, 5)).toEqual({
      startDate: '2026-03-06',
      dueDate: '2026-03-15',
    });
    expect(moveTaskDates({ startDate: '2026-03-01', dueDate: '2026-03-10' }, -1)).toEqual({
      startDate: '2026-02-28',
      dueDate: '2026-03-09',
    });
  });

  it('이동은 있는 날짜만 민다', () => {
    expect(moveTaskDates({ startDate: null, dueDate: '2026-03-10' }, 3)).toEqual({
      startDate: null,
      dueDate: '2026-03-13',
    });
    expect(moveTaskDates({ startDate: null, dueDate: null }, 3)).toEqual({
      startDate: null,
      dueDate: null,
    });
  });

  it('0일 이동은 원본을 그대로 돌려준다 (저장을 부르지 않게)', () => {
    const dates = { startDate: '2026-03-01', dueDate: '2026-03-10' };
    expect(moveTaskDates(dates, 0)).toBe(dates);
  });

  it('왼쪽 리사이즈는 마감일을 넘지 않는다', () => {
    expect(resizeTaskStart({ startDate: '2026-03-01', dueDate: '2026-03-10' }, 3)).toEqual({
      startDate: '2026-03-04',
      dueDate: '2026-03-10',
    });
    expect(resizeTaskStart({ startDate: '2026-03-01', dueDate: '2026-03-10' }, 30)).toEqual({
      startDate: '2026-03-10',
      dueDate: '2026-03-10',
    });
    // 시작일이 없으면 마감일을 기준으로 새로 만든다
    expect(resizeTaskStart({ startDate: null, dueDate: '2026-03-10' }, -2)).toEqual({
      startDate: '2026-03-08',
      dueDate: '2026-03-10',
    });
  });

  it('오른쪽 리사이즈는 시작일보다 앞서지 않는다', () => {
    expect(resizeTaskDue({ startDate: '2026-03-01', dueDate: '2026-03-10' }, -3)).toEqual({
      startDate: '2026-03-01',
      dueDate: '2026-03-07',
    });
    expect(resizeTaskDue({ startDate: '2026-03-01', dueDate: '2026-03-10' }, -30)).toEqual({
      startDate: '2026-03-01',
      dueDate: '2026-03-01',
    });
    expect(resizeTaskDue({ startDate: '2026-03-01', dueDate: null }, 4)).toEqual({
      startDate: '2026-03-01',
      dueDate: '2026-03-05',
    });
  });

  it('날짜가 하나도 없으면 리사이즈는 아무 것도 만들지 않는다', () => {
    const empty = { startDate: null, dueDate: null };
    expect(resizeTaskStart(empty, 3)).toBe(empty);
    expect(resizeTaskDue(empty, 3)).toBe(empty);
  });
});
