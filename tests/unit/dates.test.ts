// 날짜 유틸·Task/Milestone 마감 판정 테스트 (SOT §6.5)

import { describe, expect, it } from 'vitest';
import {
  APP_TIME_ZONE,
  addDays,
  daysBetween,
  formatDday,
  isDueSoonTask,
  isOverdueTask,
  isOverdueMilestone,
  isUpcomingMilestone,
  monthSpan,
  toISODate,
  toISODateInTimeZone,
  todayISO,
} from '@/lib/dates';
import type { Milestone, Task } from '@/types';

const TODAY = '2026-08-02';

function task(dueDate: string | null, status: Task['status'] = 'todo'): Pick<Task, 'dueDate' | 'status'> {
  return { dueDate, status };
}

function milestone(
  date: string,
  status: Milestone['status'] = 'planned'
): Pick<Milestone, 'date' | 'status'> {
  return { date, status };
}

describe('toISODate', () => {
  it('로컬 기준 연-월-일을 0 패딩해 반환한다', () => {
    expect(toISODate(new Date(2026, 7, 2))).toBe('2026-08-02');
    expect(toISODate(new Date(2026, 0, 9))).toBe('2026-01-09');
  });

  it('자정 직후·직전에도 같은 로컬 날짜를 준다 (UTC 밀림 없음)', () => {
    expect(toISODate(new Date(2026, 7, 2, 0, 0, 0))).toBe('2026-08-02');
    expect(toISODate(new Date(2026, 7, 2, 23, 59, 59))).toBe('2026-08-02');
  });
});

describe('daysBetween', () => {
  it('같은 날은 0', () => {
    expect(daysBetween(TODAY, TODAY)).toBe(0);
  });

  it('미래는 양수, 과거는 음수', () => {
    expect(daysBetween(TODAY, '2026-08-04')).toBe(2);
    expect(daysBetween(TODAY, '2026-07-26')).toBe(-7);
  });

  it('월·연 경계를 넘어도 달력일로 센다', () => {
    expect(daysBetween('2026-08-31', '2026-09-01')).toBe(1);
    expect(daysBetween('2026-12-31', '2027-01-01')).toBe(1);
    expect(daysBetween('2026-02-28', '2026-03-01')).toBe(1); // 2026은 평년
    expect(daysBetween('2024-02-28', '2024-03-01')).toBe(2); // 2024는 윤년
  });

  it('DST 전환 구간(미국 서머타임 시작/종료)도 정수 일수로 센다', () => {
    expect(daysBetween('2026-03-07', '2026-03-09')).toBe(2);
    expect(daysBetween('2026-10-31', '2026-11-02')).toBe(2);
  });

  it('형식이 틀리거나 존재하지 않는 날짜는 조용히 넘기지 않는다', () => {
    expect(() => daysBetween(TODAY, '2026-8-2')).toThrow(RangeError);
    expect(() => daysBetween(TODAY, '2026-02-30')).toThrow(RangeError);
  });
});

describe('isOverdueTask (§6.5)', () => {
  it('마감이 오늘보다 이전이면 지연', () => {
    expect(isOverdueTask(task('2026-08-01'), TODAY)).toBe(true);
  });

  it('마감이 오늘이거나 이후면 지연 아님', () => {
    expect(isOverdueTask(task(TODAY), TODAY)).toBe(false);
    expect(isOverdueTask(task('2026-08-03'), TODAY)).toBe(false);
  });

  it('완료된 작업은 마감이 지나도 지연 아님', () => {
    expect(isOverdueTask(task('2026-07-01', 'done'), TODAY)).toBe(false);
  });

  it('마감이 없으면 지연 아님', () => {
    expect(isOverdueTask(task(null), TODAY)).toBe(false);
  });

  it('done이 아닌 다른 상태는 모두 지연 판정 대상이다', () => {
    for (const status of ['todo', 'in_progress', 'blocked'] as const) {
      expect(isOverdueTask(task('2026-07-01', status), TODAY)).toBe(true);
    }
  });
});

describe('isDueSoonTask (§6.5)', () => {
  it('0 ≤ 남은 일수 ≤ dueSoonDays이면 임박', () => {
    expect(isDueSoonTask(task(TODAY), TODAY, 7)).toBe(true);
    expect(isDueSoonTask(task('2026-08-09'), TODAY, 7)).toBe(true); // 경계 d=7
  });

  it('dueSoonDays를 넘으면 임박 아님', () => {
    expect(isDueSoonTask(task('2026-08-10'), TODAY, 7)).toBe(false); // d=8
  });

  it('이미 지난 마감은 임박이 아니라 지연이다', () => {
    expect(isDueSoonTask(task('2026-08-01'), TODAY, 7)).toBe(false);
  });

  it('완료된 작업과 마감 없는 작업은 임박 아님', () => {
    expect(isDueSoonTask(task('2026-08-03', 'done'), TODAY, 7)).toBe(false);
    expect(isDueSoonTask(task(null), TODAY, 7)).toBe(false);
  });

  it('dueSoonDays는 설정값을 그대로 반영한다', () => {
    expect(isDueSoonTask(task('2026-08-05'), TODAY, 3)).toBe(true); // d=3
    expect(isDueSoonTask(task('2026-08-06'), TODAY, 3)).toBe(false); // d=4
  });
});

// 단언은 전부 UTC instant로 쓴다 — 호스트 로컬 타임존이 무엇이든 같은 결과여야 한다.
describe('toISODateInTimeZone / todayISO (§6.5 기준일)', () => {
  it('KST 자정 경계(UTC 15:00)에서 날짜가 넘어간다', () => {
    expect(todayISO(new Date('2026-08-02T14:59:59Z'))).toBe('2026-08-02');
    expect(todayISO(new Date('2026-08-02T15:00:00Z'))).toBe('2026-08-03');
  });

  it('연 경계도 KST 기준으로 넘어간다', () => {
    expect(todayISO(new Date('2025-12-31T15:00:00Z'))).toBe('2026-01-01');
    expect(todayISO(new Date('2025-12-31T14:59:59Z'))).toBe('2025-12-31');
  });

  it('같은 순간이라도 타임존이 다르면 경계에서 다른 날짜가 나온다', () => {
    const instant = new Date('2026-08-02T15:00:00Z');
    expect(toISODateInTimeZone(instant, 'UTC')).toBe('2026-08-02');
    expect(toISODateInTimeZone(instant, APP_TIME_ZONE)).toBe('2026-08-03');
    // 서버가 UTC든 뉴욕이든 기준일은 흔들리지 않아야 한다
    expect(toISODateInTimeZone(instant, 'America/New_York')).toBe('2026-08-02');
    expect(todayISO(instant)).toBe('2026-08-03');
  });

  it('월·일을 0으로 채운 YYYY-MM-DD를 준다', () => {
    expect(toISODateInTimeZone(new Date('2026-01-09T03:00:00Z'), APP_TIME_ZONE)).toBe('2026-01-09');
  });

  it('유효하지 않은 Date와 타임존은 조용히 넘기지 않는다', () => {
    expect(() => todayISO(new Date('nope'))).toThrow(RangeError);
    expect(() => toISODateInTimeZone(new Date('2026-08-02T00:00:00Z'), 'Mars/Olympus')).toThrow(
      RangeError
    );
  });
});

describe('addDays', () => {
  it('달력일을 더하고 뺀다', () => {
    expect(addDays(TODAY, 0)).toBe('2026-08-02');
    expect(addDays(TODAY, 7)).toBe('2026-08-09');
    expect(addDays(TODAY, -7)).toBe('2026-07-26');
  });

  it('월·연 경계를 넘는다', () => {
    expect(addDays('2026-08-31', 1)).toBe('2026-09-01');
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01');
    expect(addDays('2024-02-28', 1)).toBe('2024-02-29'); // 윤년
    expect(addDays('2026-02-28', 1)).toBe('2026-03-01'); // 평년
  });

  it('잘못된 날짜·소수 일수는 거부한다', () => {
    expect(() => addDays('2026-8-2', 1)).toThrow(RangeError);
    expect(() => addDays(TODAY, 1.5)).toThrow(RangeError);
  });
});

describe('formatDday', () => {
  it('오늘은 D-DAY, 미래는 D-n, 과거는 D+n', () => {
    expect(formatDday(TODAY, TODAY)).toBe('D-DAY');
    expect(formatDday(TODAY, '2026-08-05')).toBe('D-3');
    expect(formatDday(TODAY, '2026-07-28')).toBe('D+5');
  });
});

describe('isOverdueMilestone (§6.5)', () => {
  it('날짜가 오늘보다 이전이면 지연', () => {
    expect(isOverdueMilestone(milestone(addDays(TODAY, -1)), TODAY)).toBe(true);
  });

  it('오늘이거나 이후면 지연 아님', () => {
    expect(isOverdueMilestone(milestone(TODAY), TODAY)).toBe(false);
    expect(isOverdueMilestone(milestone(addDays(TODAY, 1)), TODAY)).toBe(false);
  });

  it('done·cancelled는 지난 날짜여도 지연 아님', () => {
    expect(isOverdueMilestone(milestone('2026-07-01', 'done'), TODAY)).toBe(false);
    expect(isOverdueMilestone(milestone('2026-07-01', 'cancelled'), TODAY)).toBe(false);
  });

  it('planned·preparing·delayed는 판정 대상이다', () => {
    for (const status of ['planned', 'preparing', 'delayed'] as const) {
      expect(isOverdueMilestone(milestone('2026-07-01', status), TODAY)).toBe(true);
    }
  });
});

describe('isUpcomingMilestone (§6.5)', () => {
  const ALERT = 30; // §5.16 milestoneAlertDays 기본값

  it('오늘(D-DAY)은 임박이고 지연은 아니다', () => {
    expect(isUpcomingMilestone(milestone(TODAY), TODAY, ALERT)).toBe(true);
    expect(isOverdueMilestone(milestone(TODAY), TODAY)).toBe(false);
    expect(formatDday(TODAY, TODAY)).toBe('D-DAY');
  });

  it('milestoneAlertDays 경계까지 임박, 하루 넘으면 아님', () => {
    expect(isUpcomingMilestone(milestone(addDays(TODAY, ALERT)), TODAY, ALERT)).toBe(true);
    expect(isUpcomingMilestone(milestone(addDays(TODAY, ALERT + 1)), TODAY, ALERT)).toBe(false);
  });

  it('이미 지난 날짜는 임박이 아니라 지연이다', () => {
    const past = milestone(addDays(TODAY, -1));
    expect(isUpcomingMilestone(past, TODAY, ALERT)).toBe(false);
    expect(isOverdueMilestone(past, TODAY)).toBe(true);
  });

  it('done·cancelled는 임박 아님', () => {
    expect(isUpcomingMilestone(milestone(addDays(TODAY, 3), 'done'), TODAY, ALERT)).toBe(false);
    expect(isUpcomingMilestone(milestone(addDays(TODAY, 3), 'cancelled'), TODAY, ALERT)).toBe(false);
  });

  it('preparing·delayed는 판정 대상이다', () => {
    for (const status of ['preparing', 'delayed'] as const) {
      expect(isUpcomingMilestone(milestone(addDays(TODAY, 3), status), TODAY, ALERT)).toBe(true);
    }
  });

  it('milestoneAlertDays=0이면 오늘만 임박', () => {
    expect(isUpcomingMilestone(milestone(TODAY), TODAY, 0)).toBe(true);
    expect(isUpcomingMilestone(milestone(addDays(TODAY, 1)), TODAY, 0)).toBe(false);
  });
});

describe('monthSpan (§6.16 IN-3 연차 개월)', () => {
  it('양끝을 포함한 달 수를 센다', () => {
    expect(monthSpan('2025-04-01', '2025-12-31')).toBe(9);
    expect(monthSpan('2026-01-01', '2026-12-31')).toBe(12);
    expect(monthSpan('2026-03-15', '2026-03-20')).toBe(1);
  });

  it('연 경계를 넘어도 달력 월로 센다', () => {
    expect(monthSpan('2025-10-01', '2026-03-31')).toBe(6);
  });

  it('잘못된 날짜·역순 기간은 거부한다', () => {
    expect(() => monthSpan('2026-1-1', '2026-12-31')).toThrow(RangeError);
    expect(() => monthSpan('2026-04-01', '2026-03-31')).toThrow(RangeError);
  });
});
