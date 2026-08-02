// 날짜 유틸·Task 마감 판정 테스트 (SOT §6.5)

import { describe, expect, it } from 'vitest';
import { daysBetween, isDueSoonTask, isOverdueTask, toISODate } from '@/lib/dates';
import type { Task } from '@/types';

const TODAY = '2026-08-02';

function task(dueDate: string | null, status: Task['status'] = 'todo'): Pick<Task, 'dueDate' | 'status'> {
  return { dueDate, status };
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
