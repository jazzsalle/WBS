// To-Do 필터·정렬·지연 판정 (SOT §7.13 T-D1~T-D10)
// 기준일은 항상 인자로 넘긴다 — 실행 시각에 따라 결과가 흔들리면 안 된다.

import { describe, expect, it } from 'vitest';
import {
  filterTodos,
  sortTodos,
  todoDueState,
  TODO_PRIORITY_RANK,
  type TodoFilter,
} from '@/lib/todos';
import type { Todo } from '@/types';

const TODAY = '2026-08-07';

function makeTodo(overrides: Partial<Todo> & Pick<Todo, 'id'>): Todo {
  return {
    createdAt: '2026-08-01T00:00:00Z',
    updatedAt: '2026-08-01T00:00:00Z',
    version: 1,
    createdBy: null,
    updatedBy: null,
    title: overrides.id,
    done: false,
    projectId: null,
    dueDate: null,
    priority: 'normal',
    order: 0,
    completedAt: null,
    ...overrides,
  };
}

const ids = (todos: readonly Pick<Todo, 'id'>[]): string[] => todos.map((t) => t.id);

describe('filterTodos — T-D1 전체·미완료', () => {
  const todos = [
    makeTodo({ id: 'a', done: false }),
    makeTodo({ id: 'b', done: true }),
    makeTodo({ id: 'c', done: false }),
  ];

  it('전체는 완료 항목까지 모두 남긴다 (T-D8: 전체에서는 남는다)', () => {
    expect(ids(filterTodos(todos, { mode: 'all' }, TODAY))).toEqual(['a', 'b', 'c']);
  });

  it('미완료는 done=true를 뺀다', () => {
    expect(ids(filterTodos(todos, { mode: 'open' }, TODAY))).toEqual(['a', 'c']);
  });

  it('입력 배열을 변형하지 않고 새 배열을 돌려준다', () => {
    const result = filterTodos(todos, { mode: 'all' }, TODAY);
    expect(result).not.toBe(todos);
    expect(ids(todos)).toEqual(['a', 'b', 'c']);
  });
});

describe('filterTodos — T-D2 오늘 (지난 마감 포함)', () => {
  const yesterday = makeTodo({ id: 'yesterday', dueDate: '2026-08-06' });
  const today = makeTodo({ id: 'today', dueDate: TODAY });
  const tomorrow = makeTodo({ id: 'tomorrow', dueDate: '2026-08-08' });
  const noDue = makeTodo({ id: 'noDue', dueDate: null });
  const doneOverdue = makeTodo({ id: 'doneOverdue', dueDate: '2026-08-01', done: true });

  it('어제 마감(지난 마감)을 포함한다', () => {
    const result = filterTodos([yesterday, tomorrow], { mode: 'today' }, TODAY);
    expect(ids(result)).toEqual(['yesterday']);
  });

  it('오늘 마감을 포함한다', () => {
    expect(ids(filterTodos([today], { mode: 'today' }, TODAY))).toEqual(['today']);
  });

  it('내일 마감은 뺀다', () => {
    expect(filterTodos([tomorrow], { mode: 'today' }, TODAY)).toEqual([]);
  });

  it('마감일이 없으면 뺀다', () => {
    expect(filterTodos([noDue], { mode: 'today' }, TODAY)).toEqual([]);
  });

  it('완료 항목은 마감이 지났어도 뺀다 (T-D8)', () => {
    expect(filterTodos([doneOverdue], { mode: 'today' }, TODAY)).toEqual([]);
  });

  it('기준일이 바뀌면 결과도 따라 바뀐다 (오늘을 스스로 만들지 않는다)', () => {
    const todos = [yesterday, today, tomorrow];
    expect(ids(filterTodos(todos, { mode: 'today' }, '2026-08-08'))).toEqual([
      'yesterday',
      'today',
      'tomorrow',
    ]);
  });
});

describe('filterTodos — T-D5 과제별', () => {
  const todos = [
    makeTodo({ id: 'p1-a', projectId: 'p1' }),
    makeTodo({ id: 'none', projectId: null }),
    makeTodo({ id: 'p2', projectId: 'p2' }),
    makeTodo({ id: 'p1-b', projectId: 'p1', done: true }),
  ];

  it('고른 과제의 To-Do만 남긴다 (완료 여부는 보지 않는다)', () => {
    expect(ids(filterTodos(todos, { mode: 'project', projectId: 'p1' }, TODAY))).toEqual([
      'p1-a',
      'p1-b',
    ]);
  });

  it('projectId=null은 "(과제 없음)"이라는 고를 수 있는 값이다', () => {
    expect(ids(filterTodos(todos, { mode: 'project', projectId: null }, TODAY))).toEqual(['none']);
  });

  it('projectId=undefined(미선택)는 null과 다르다 — 조용히 넘기지 않고 예외로 드러낸다', () => {
    const filter = { mode: 'project' } as TodoFilter;
    expect(() => filterTodos(todos, filter, TODAY)).toThrow(RangeError);
  });

  it('일치하는 과제가 없으면 빈 배열이다', () => {
    expect(filterTodos(todos, { mode: 'project', projectId: 'p9' }, TODAY)).toEqual([]);
  });
});

describe('filterTodos — T-D6 아카이브를 모른다', () => {
  it('아카이브 과제 여부와 무관하게 projectId만 보고 남긴다', () => {
    // 이 모듈은 Project를 입력으로 받지 않는다 — 아카이브 제외는 대시보드 몫이다.
    const todos = [makeTodo({ id: 'archived-proj', projectId: 'archived' })];
    expect(ids(filterTodos(todos, { mode: 'open' }, TODAY))).toEqual(['archived-proj']);
    expect(ids(filterTodos(todos, { mode: 'project', projectId: 'archived' }, TODAY))).toEqual([
      'archived-proj',
    ]);
  });
});

describe('sortTodos — T-D7', () => {
  it('수동은 order → id 순이다', () => {
    const todos = [
      makeTodo({ id: 'c', order: 1 }),
      makeTodo({ id: 'a', order: 0 }),
      makeTodo({ id: 'b', order: 0 }),
    ];
    expect(ids(sortTodos(todos, 'manual'))).toEqual(['a', 'b', 'c']);
  });

  it('마감일은 오름차순이다', () => {
    const todos = [
      makeTodo({ id: 'late', dueDate: '2026-09-01' }),
      makeTodo({ id: 'early', dueDate: '2026-08-01' }),
      makeTodo({ id: 'mid', dueDate: '2026-08-20' }),
    ];
    expect(ids(sortTodos(todos, 'due'))).toEqual(['early', 'mid', 'late']);
  });

  it('마감일 없는 항목은 빼지 않고 뒤로 보낸다', () => {
    const todos = [
      makeTodo({ id: 'noDue', dueDate: null }),
      makeTodo({ id: 'due', dueDate: '2026-09-01' }),
    ];
    expect(ids(sortTodos(todos, 'due'))).toEqual(['due', 'noDue']);
  });

  it('마감일이 같으면 우선순위 → order → id로 가른다', () => {
    const todos = [
      makeTodo({ id: 'z', dueDate: TODAY, priority: 'normal', order: 5 }),
      makeTodo({ id: 'y', dueDate: TODAY, priority: 'high', order: 9 }),
      makeTodo({ id: 'x', dueDate: TODAY, priority: 'normal', order: 1 }),
      makeTodo({ id: 'w', dueDate: TODAY, priority: 'normal', order: 1 }),
    ];
    expect(ids(sortTodos(todos, 'due'))).toEqual(['y', 'w', 'x', 'z']);
  });

  it('우선순위는 high → normal → low 순이다', () => {
    const todos = [
      makeTodo({ id: 'low', priority: 'low' }),
      makeTodo({ id: 'high', priority: 'high' }),
      makeTodo({ id: 'normal', priority: 'normal' }),
    ];
    expect(ids(sortTodos(todos, 'priority'))).toEqual(['high', 'normal', 'low']);
  });

  it('우선순위가 같으면 마감일 → order → id로 가른다', () => {
    const todos = [
      makeTodo({ id: 'b', priority: 'high', dueDate: '2026-09-01', order: 0 }),
      makeTodo({ id: 'a', priority: 'high', dueDate: '2026-08-01', order: 9 }),
      makeTodo({ id: 'd', priority: 'high', dueDate: null, order: 0 }),
      makeTodo({ id: 'c', priority: 'high', dueDate: '2026-09-01', order: 1 }),
    ];
    expect(ids(sortTodos(todos, 'priority'))).toEqual(['a', 'b', 'c', 'd']);
  });

  it('우선순위 정렬에서도 마감일 없는 항목은 우선순위가 높으면 앞에 온다', () => {
    const todos = [
      makeTodo({ id: 'lowDue', priority: 'low', dueDate: '2026-08-01' }),
      makeTodo({ id: 'highNoDue', priority: 'high', dueDate: null }),
    ];
    expect(ids(sortTodos(todos, 'priority'))).toEqual(['highNoDue', 'lowDue']);
  });

  it('입력 배열을 변형하지 않는다', () => {
    const todos = [
      makeTodo({ id: 'b', order: 1 }),
      makeTodo({ id: 'a', order: 0 }),
    ];
    const result = sortTodos(todos, 'manual');
    expect(result).not.toBe(todos);
    expect(ids(todos)).toEqual(['b', 'a']);
    expect(ids(result)).toEqual(['a', 'b']);
  });

  it('빈 목록은 빈 목록이다', () => {
    expect(sortTodos([], 'due')).toEqual([]);
  });

  it('TODO_PRIORITY_RANK는 high가 가장 앞이다', () => {
    expect(TODO_PRIORITY_RANK.high).toBeLessThan(TODO_PRIORITY_RANK.normal);
    expect(TODO_PRIORITY_RANK.normal).toBeLessThan(TODO_PRIORITY_RANK.low);
  });
});

describe('todoDueState — T-D4', () => {
  const dueSoonDays = 7;

  it('마감이 지났으면 overdue다', () => {
    expect(todoDueState({ done: false, dueDate: '2026-08-06' }, TODAY, dueSoonDays)).toBe('overdue');
  });

  it('오늘 마감은 dueSoon이다 (경계 0일)', () => {
    expect(todoDueState({ done: false, dueDate: TODAY }, TODAY, dueSoonDays)).toBe('dueSoon');
  });

  it('기준일수 마지막 날까지 dueSoon이다 (경계 dueSoonDays)', () => {
    expect(todoDueState({ done: false, dueDate: '2026-08-14' }, TODAY, dueSoonDays)).toBe('dueSoon');
  });

  it('기준일수를 하루라도 넘으면 none이다', () => {
    expect(todoDueState({ done: false, dueDate: '2026-08-15' }, TODAY, dueSoonDays)).toBe('none');
  });

  it('마감일이 없으면 none이다', () => {
    expect(todoDueState({ done: false, dueDate: null }, TODAY, dueSoonDays)).toBe('none');
  });

  it('완료 항목은 마감이 지났어도 none이다', () => {
    expect(todoDueState({ done: true, dueDate: '2026-01-01' }, TODAY, dueSoonDays)).toBe('none');
  });

  it('완료 항목은 오늘 마감이어도 none이다', () => {
    expect(todoDueState({ done: true, dueDate: TODAY }, TODAY, dueSoonDays)).toBe('none');
  });

  it('dueSoonDays=0이면 오늘 마감만 dueSoon이다', () => {
    expect(todoDueState({ done: false, dueDate: TODAY }, TODAY, 0)).toBe('dueSoon');
    expect(todoDueState({ done: false, dueDate: '2026-08-08' }, TODAY, 0)).toBe('none');
  });

  it('잘못된 날짜 형식은 조용히 넘기지 않는다', () => {
    expect(() => todoDueState({ done: false, dueDate: '2026-8-7' }, TODAY, dueSoonDays)).toThrow(
      RangeError
    );
  });
});

describe('필터 + 정렬 조합 — 대시보드 "오늘의 To-Do"(§7.2 6)와 같은 결과 (T-D3)', () => {
  it('오늘 필터 후 마감일 정렬이 대시보드 순서와 같다', () => {
    const todos = [
      makeTodo({ id: 'future', dueDate: '2026-08-20' }),
      makeTodo({ id: 'overdueNormal', dueDate: '2026-08-01', priority: 'normal', order: 2 }),
      makeTodo({ id: 'overdueHigh', dueDate: '2026-08-01', priority: 'high', order: 3 }),
      makeTodo({ id: 'todayLow', dueDate: TODAY, priority: 'low', order: 0 }),
      makeTodo({ id: 'doneOld', dueDate: '2026-07-01', done: true }),
      makeTodo({ id: 'someday', dueDate: null }),
    ];
    const result = sortTodos(filterTodos(todos, { mode: 'today' }, TODAY), 'due');
    expect(ids(result)).toEqual(['overdueHigh', 'overdueNormal', 'todayLow']);
  });
});
