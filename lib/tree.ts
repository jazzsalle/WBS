// WBS 트리 구성·코드 부여·무결성 검사·날짜 롤업 (SOT §6.6 H-1~H-3, §6.7, §6.1.1)
// 전부 부수효과 없는 순수 함수다. 파생 값(wbsCode·depth·isLeaf·rolledUp*)은 저장하지 않고
// 읽을 때 계산한다 (§5.6). 단위 테스트: tests/unit/tree.test.ts

import { MAX_TASK_DEPTH } from '@/lib/constants';
import type { Task } from '@/types';

export interface TaskNode {
  task: Task;
  children: TaskNode[];
  depth: number;                     // 루트 = 1 (H-3 기준)
  wbsCode: string;                   // '1', '1.2', '1.2.3' — 연차 단위 리셋 (§6.7)
  isLeaf: boolean;
  rolledUpStartDate: string | null;  // P-14
  rolledUpDueDate: string | null;    // P-15, P-16
}

export interface BuildTreeOptions {
  // §6.7 전체 연차 보기: 여러 연차가 한 화면에 섞일 때 '1차-1.2' 형태로 구분한다
  yearPrefix?: string;
}

export interface BuildTreeResult {
  roots: TaskNode[];
  // 트리에 편입되지 못한 Task. 조용히 버리면 사용자가 데이터 손실을 모른다 (절대 규칙 5)
  invalid: Task[];
}

export type MoveRejectReason = 'NOT_FOUND' | 'CROSS_YEAR' | 'CYCLE' | 'DEPTH';

export type MoveCheck = { ok: true } | { ok: false; reason: MoveRejectReason };

// ─── 날짜 비교 (§6.1.1) ──────────────────────────────────────
// ISO 'YYYY-MM-DD'는 자릿수가 고정이라 사전순 비교가 곧 시간순 비교다.
// null은 "값 없음"이므로 비교에서 제외한다 (P-14, P-15).

function minDate(a: string | null, b: string | null): string | null {
  if (a === null) return b;
  if (b === null) return a;
  return a <= b ? a : b;
}

function maxDate(a: string | null, b: string | null): string | null {
  if (a === null) return b;
  if (b === null) return a;
  return a >= b ? a : b;
}

// 형제 정렬: order 오름차순, 동률이면 id 사전순. 같은 입력이면 항상 같은 WBS 코드가
// 나와야 하므로(코드가 화면·인쇄물에 노출된다) 완전한 결정론적 순서를 강제한다.
function compareSiblings(a: Task, b: Task): number {
  if (a.order !== b.order) return a.order - b.order;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

// parentId가 입력에 있고 H-1(같은 yearId)을 만족하는 관계만 자식으로 인정한다.
function groupChildren(tasks: readonly Task[]): Map<string, Task[]> {
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const childrenOf = new Map<string, Task[]>();
  for (const task of tasks) {
    if (task.parentId === null) continue;
    const parent = byId.get(task.parentId);
    if (!parent || parent.yearId !== task.yearId) continue;
    const bucket = childrenOf.get(task.parentId);
    if (bucket) bucket.push(task);
    else childrenOf.set(task.parentId, [task]);
  }
  for (const bucket of childrenOf.values()) bucket.sort(compareSiblings);
  return childrenOf;
}

function buildNode(
  task: Task,
  wbsCode: string,
  depth: number,
  childrenOf: Map<string, Task[]>
): TaskNode {
  const childTasks = childrenOf.get(task.id) ?? [];
  const children = childTasks.map((child, i) =>
    buildNode(child, `${wbsCode}.${i + 1}`, depth + 1, childrenOf)
  );

  // 진척률과 같은 post-order 위치에서 날짜를 롤업한다 (§6.1.1). 자식이 없으면 자기 값 그대로.
  let rolledUpStartDate = task.startDate;
  let rolledUpDueDate = task.dueDate;
  for (const child of children) {
    rolledUpStartDate = minDate(rolledUpStartDate, child.rolledUpStartDate);
    rolledUpDueDate = maxDate(rolledUpDueDate, child.rolledUpDueDate);
  }

  return {
    task,
    children,
    depth,
    wbsCode,
    isLeaf: children.length === 0,
    rolledUpStartDate,
    rolledUpDueDate,
  };
}

/**
 * Task 배열을 트리로 구성한다. WBS 코드는 연차 단위로 1부터 다시 매긴다 (§6.7).
 * 루트에서 도달할 수 없는 Task(부모 없음·H-1 위반·그 자손·데이터 순환)는 `invalid`로 돌려준다.
 */
export function buildTaskTree(tasks: readonly Task[], opts?: BuildTreeOptions): BuildTreeResult {
  const prefix = opts?.yearPrefix ?? '';
  const childrenOf = groupChildren(tasks);

  const rootTasks = tasks.filter((t) => t.parentId === null).slice().sort(compareSiblings);
  const roots = rootTasks.map((task, i) => buildNode(task, `${prefix}${i + 1}`, 1, childrenOf));

  // 각 Task의 parentId는 하나뿐이므로 루트에서 내려가는 순회는 순환할 수 없다.
  // 도달하지 못한 Task = 부모 유실·연차 불일치·그 자손·입력 데이터의 순환.
  const reached = new Set<string>();
  const stack = [...roots];
  while (stack.length > 0) {
    const node = stack.pop()!;
    reached.add(node.task.id);
    for (const child of node.children) stack.push(child);
  }
  const invalid = tasks.filter((t) => !reached.has(t.id));

  return { roots, invalid };
}

/** 화면 표시 순서(pre-order). 접힌 노드 자신은 포함하고 그 자손은 제외한다. */
export function flattenTree(
  roots: readonly TaskNode[],
  collapsedIds?: ReadonlySet<string>
): TaskNode[] {
  const out: TaskNode[] = [];
  const visit = (node: TaskNode): void => {
    out.push(node);
    if (collapsedIds?.has(node.task.id)) return;
    for (const child of node.children) visit(child);
  };
  for (const root of roots) visit(root);
  return out;
}

/** 자기 자신을 제외한 모든 자손 id (pre-order). 연쇄 삭제 개수 확인(H-4)에 쓴다. */
export function getDescendantIds(node: TaskNode): string[] {
  const out: string[] = [];
  const visit = (n: TaskNode): void => {
    for (const child of n.children) {
      out.push(child.task.id);
      visit(child);
    }
  };
  visit(node);
  return out;
}

/** 자기 자신 포함 서브트리 높이. 리프는 1. */
export function subtreeHeight(node: TaskNode): number {
  let max = 0;
  for (const child of node.children) {
    const h = subtreeHeight(child);
    if (h > max) max = h;
  }
  return max + 1;
}

/** H-2: 자기 자신 또는 자손을 부모로 지정하려 하는가. */
export function wouldCreateCycle(
  tasks: readonly Task[],
  taskId: string,
  newParentId: string | null
): boolean {
  if (newParentId === null) return false;
  if (newParentId === taskId) return true;

  const byId = new Map(tasks.map((t) => [t.id, t]));
  const seen = new Set<string>();
  let cursor: string | null = newParentId;
  while (cursor !== null) {
    if (cursor === taskId) return true;
    // 이미 데이터가 순환이면 이동을 허용해선 안 된다 (무한 루프 방지 겸)
    if (seen.has(cursor)) return true;
    seen.add(cursor);
    cursor = byId.get(cursor)?.parentId ?? null;
  }
  return false;
}

// 루트 = 1 기준 깊이 (H-3). 부모 사슬이 끊겨 있으면 거기까지만 센다.
function depthOf(byId: Map<string, Task>, task: Task): number {
  let depth = 1;
  const seen = new Set<string>([task.id]);
  let cursor = task.parentId;
  while (cursor !== null && !seen.has(cursor)) {
    seen.add(cursor);
    const parent = byId.get(cursor);
    if (!parent) break;
    depth += 1;
    cursor = parent.parentId;
  }
  return depth;
}

// 평면 배열에서 서브트리 높이 계산 (TaskNode를 만들지 않고 이동 가능 여부만 볼 때)
function subtreeHeightFrom(childrenOf: Map<string, Task[]>, taskId: string): number {
  let max = 0;
  for (const child of childrenOf.get(taskId) ?? []) {
    const h = subtreeHeightFrom(childrenOf, child.id);
    if (h > max) max = h;
  }
  return max + 1;
}

/**
 * Task 이동 가능 여부 (H-1 연차, H-2 순환, H-3 깊이).
 * 거절 사유를 돌려줘 UI가 "왜 안 되는지"를 말할 수 있게 한다 (절대 규칙 5).
 */
export function canMoveTask(
  tasks: readonly Task[],
  taskId: string,
  newParentId: string | null
): MoveCheck {
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const moving = byId.get(taskId);
  if (!moving) return { ok: false, reason: 'NOT_FOUND' };

  let parentDepth = 0; // 루트로 이동하면 부모 깊이는 0 — 대상이 깊이 1이 된다
  if (newParentId !== null) {
    const newParent = byId.get(newParentId);
    if (!newParent) return { ok: false, reason: 'NOT_FOUND' };
    // H-1: 연차 간 부모-자식 금지. 연차를 넘는 이동은 moveTaskToYear(H-11)의 몫이다
    if (newParent.yearId !== moving.yearId) return { ok: false, reason: 'CROSS_YEAR' };
    if (wouldCreateCycle(tasks, taskId, newParentId)) return { ok: false, reason: 'CYCLE' };
    parentDepth = depthOf(byId, newParent);
  }

  const childrenOf = groupChildren(tasks);
  if (parentDepth + subtreeHeightFrom(childrenOf, taskId) > MAX_TASK_DEPTH) {
    return { ok: false, reason: 'DEPTH' };
  }
  return { ok: true };
}
