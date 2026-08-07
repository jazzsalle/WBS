// To-Do 필터·정렬·지연 판정 (SOT §7.13 T-D1~T-D10)
//
// 기준일(today)과 dueSoonDays는 반드시 인자로 받는다 — 서버 컴포넌트가 한 번
// 계산해 prop으로 내리고 클라이언트는 오늘을 스스로 만들지 않는다(§7.13 서문).
// T-D3: /todos 화면과 대시보드 "오늘의 To-Do"(§7.2 6)가 이 함수들을 함께 쓴다.
// 정의가 두 벌이 되면 두 화면의 건수가 조용히 어긋난다.
//
// 이 모듈은 **아카이브 과제를 모른다**(T-D6). /todos는 To-Do의 유일한 접근
// 경로라 아카이브 과제의 To-Do도 감추지 않는다 — 감추면 되살릴 방법이 없다.
// 아카이브 제외는 집계 화면인 대시보드(§7.2)만의 규칙이므로 그쪽에서 건다.
//
// 날짜 산술은 lib/dates.ts가 원본이다. 여기서 다시 쓰지 않는다.
//
// 단위 테스트: tests/unit/todos.test.ts

import { daysBetween, isDueSoonTask, isOverdueTask } from './dates';
import type { Priority, Todo } from '@/types';

/** T-D1·T-D2·T-D5의 필터 4종 */
export type TodoFilterMode = 'all' | 'open' | 'today' | 'project';

export interface TodoFilter {
  mode: TodoFilterMode;
  /**
   * mode='project'일 때만 의미가 있다. T-D5: `null`은 "(과제 없음)"이라는
   * **고를 수 있는 값**이지 "안 골랐다"가 아니다 — 미선택은 `undefined`.
   */
  projectId?: string | null;
}

/** T-D7의 정렬 3종. 화면 기본값은 'manual'(T-D9) */
export type TodoSortOrder = 'manual' | 'due' | 'priority';

/** T-D4: overdue 빨강 · dueSoon 주황 · none 무색 */
export type TodoDueState = 'overdue' | 'dueSoon' | 'none';

export type TodoFilterInput = Pick<Todo, 'done' | 'dueDate' | 'projectId'>;
export type TodoSortInput = Pick<Todo, 'id' | 'dueDate' | 'priority' | 'order'>;
export type TodoDueInput = Pick<Todo, 'done' | 'dueDate'>;

/** T-D7 정렬 키. high가 앞이다 */
export const TODO_PRIORITY_RANK: Record<Priority, number> = { high: 0, normal: 1, low: 2 };

/**
 * T-D1·T-D2·T-D5·T-D6.
 * `today` = 완료되지 않았고 마감일이 있으며 마감일 ≤ 오늘 — **지난 마감을 포함한다.**
 * 입력 배열을 변형하지 않는다.
 */
export function filterTodos<T extends TodoFilterInput>(
  todos: readonly T[],
  filter: TodoFilter,
  today: string
): T[] {
  switch (filter.mode) {
    case 'all':
      return [...todos];
    case 'open':
      return todos.filter((todo) => !todo.done);
    case 'today':
      return todos.filter(
        (todo) => !todo.done && todo.dueDate !== null && daysBetween(today, todo.dueDate) <= 0
      );
    case 'project': {
      // 미선택(undefined)을 "(과제 없음)"(null)이나 전체로 뭉뚱그리면 건수가
      // 조용히 달라진다 — 호출자의 상태가 깨진 것이므로 드러낸다 (절대 규칙 5).
      if (filter.projectId === undefined) {
        throw new RangeError('과제별 필터에는 projectId가 필요합니다. "(과제 없음)"은 null입니다.');
      }
      return todos.filter((todo) => todo.projectId === filter.projectId);
    }
  }
}

/**
 * T-D7. 입력 배열을 변형하지 않는다 — 화면이 원본 순서(수동 정렬 기준)를
 * 계속 들고 있어야 T-D10의 "숨겨진 항목까지 포함한 전체 순서" 재계산이 된다.
 */
export function sortTodos<T extends TodoSortInput>(todos: readonly T[], order: TodoSortOrder): T[] {
  const sorted = [...todos];
  switch (order) {
    case 'manual':
      return sorted.sort((a, b) => byOrder(a, b) || byId(a, b));
    case 'due':
      return sorted.sort((a, b) => byDueDate(a, b) || byPriority(a, b) || byOrder(a, b) || byId(a, b));
    case 'priority':
      return sorted.sort((a, b) => byPriority(a, b) || byDueDate(a, b) || byOrder(a, b) || byId(a, b));
  }
}

/**
 * T-D4. 완료 항목은 날짜와 무관하게 'none' — 끝난 일에 지연 뱃지를 붙이지 않는다.
 * 경계(§6.5)를 Task 판정과 한 벌로 유지하려고 lib/dates.ts의 함수에 위임하고,
 * To-Do에는 status가 없으므로 done을 status로 옮겨 넘긴다.
 */
export function todoDueState(todo: TodoDueInput, today: string, dueSoonDays: number): TodoDueState {
  const asTask = { dueDate: todo.dueDate, status: todo.done ? ('done' as const) : ('todo' as const) };
  if (isOverdueTask(asTask, today)) return 'overdue';
  if (isDueSoonTask(asTask, today, dueSoonDays)) return 'dueSoon';
  return 'none';
}

// 마감 없는 항목은 뒤로 — "언젠가"가 "오늘"보다 앞설 수는 없다 (T-D7: 빼지 않는다)
function byDueDate(a: TodoSortInput, b: TodoSortInput): number {
  if (a.dueDate === b.dueDate) return 0;
  if (a.dueDate === null) return 1;
  if (b.dueDate === null) return -1;
  return compareText(a.dueDate, b.dueDate);
}

function byPriority(a: TodoSortInput, b: TodoSortInput): number {
  return TODO_PRIORITY_RANK[a.priority] - TODO_PRIORITY_RANK[b.priority];
}

function byOrder(a: TodoSortInput, b: TodoSortInput): number {
  return a.order - b.order;
}

// id까지 보는 이유: order가 같은 행이 남아도 정렬 결과가 실행마다 흔들리지 않게 한다
function byId(a: TodoSortInput, b: TodoSortInput): number {
  return compareText(a.id, b.id);
}

function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
