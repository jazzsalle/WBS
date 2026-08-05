'use server';

// 칸반 보드 · 우선순위 매트릭스 조회 모델 (SOT §9 getBoardData / getPriorityMatrix, §7.6, §6.9)
//
// 이 파일은 **조회 전용**이다. 쓰기는 이미 있는 actions/tasks.ts의 액션(setTaskStatus,
// reorderTasks, setTaskPriority, setTaskUrgency)을 그대로 부른다 — 같은 규칙(P-1, X-3, PR-1,
// PR-4)이 두 곳에 생기지 않게 한다.
//
// 트리·진척률·WBS 코드·긴급도·점수는 getYearTree / getProjectFullTree가 이미 계산해 준다.
// 여기서 다시 계산하지 않는다 (PR-7: 저장하지 않고 읽을 때 계산, O-4).
// supabase 직접 호출 금지 — 데이터는 전부 액션·리포지토리를 거친다 (§8.2 C-2, §8.6).

import type { ActionResult, Stage, Task, TaskStatus, Year } from '@/types';
import { getProjectFullTree, getYearTree, type WbsNode } from '@/actions/tasks';
import {
  BOARD_ALL_YEARS,
  buildPriorityCells,
  containerKey,
  type MatrixItemInput,
  type PriorityMatrixCell,
} from '@/lib/board';
import { comparePriority, priorityGrade, type PriorityGrade, type PriorityLevel } from '@/lib/priority';
import { formatDday, isOverdueTask, todayISO } from '@/lib/dates';

// ─── 조회 모델 타입 ───────────────────────────────────────────────────────────
// 타입을 types/index.ts가 아니라 여기에 두는 이유: 화면 전용 조회 모델이라 DB 엔티티가
// 아니다. actions/risks.ts의 RiskMatrixData가 같은 선례다.

/** §7.6 카드: 작업명, WBS 코드, 진척률, 마감일, 담당자, 기관, 태그 + 우선순위 색 띠 */
export interface BoardCard {
  id: string;
  yearId: string;
  parentId: string | null;
  title: string;
  wbsCode: string;
  status: TaskStatus;
  /** §6.1 롤업 결과. P-1(done → 100)도 이 값에 이미 반영돼 있다 */
  progress: number;
  /** 카드는 그 작업 자신의 마감일을 보여준다 — 부모의 롤업 기간은 WBS·간트의 몫이다 */
  dueDate: string | null;
  /** 'D-3' / 'D-DAY' / 'D+2'. 마감이 없으면 null */
  dday: string | null;
  overdue: boolean;
  ownerMemberId: string | null;
  memberIds: string[];
  orgId: string | null;
  tags: string[];
  importance: PriorityLevel;
  /** §6.9.1 자동 계산 결과 (또는 PR-4 고정값) */
  urgency: PriorityLevel;
  score: number;
  grade: PriorityGrade;
  /** 부록 A.3 PRIORITY_SCORE_COLORS 색상 토큰 — 카드 좌측 색 띠에 쓴다 */
  colorToken: string;
  /** PR-4 긴급도 고정(핀) 여부 */
  urgencyPinned: boolean;
  /** PR-9: 기본 표시 대상 */
  isLeaf: boolean;
  /** 컬럼 내 정렬 기준 = 연차 트리의 pre-order 위치(곧 order 순서, PR-8) */
  sortIndex: number;
}

/** 컬럼 내 재정렬용 (yearId, parentId) 컨테이너. reorderTasks는 자식 전체를 요구한다 (X-3) */
export interface BoardContainer {
  key: string;
  yearId: string;
  parentId: string | null;
  /** order 오름차순 전체 형제 id */
  taskIds: string[];
}

export interface BoardData {
  projectId: string;
  /** 기준일(Asia/Seoul). 클라이언트는 오늘을 스스로 만들지 않는다 (§6.5) */
  todayISO: string;
  stages: Stage[];
  years: Year[];
  /** null이면 전체 연차 보기 */
  selectedYearId: string | null;
  /** 요청한 연차가 사라졌을 때 — 조용히 다른 연차를 보여주지 않는다 (절대 규칙 5) */
  missingRequestedYear: boolean;
  cards: BoardCard[];
  containers: BoardContainer[];
  /** 트리에 편입되지 못한 작업 (절대 규칙 5) */
  invalidTaskIds: string[];
}

/** §7.6 우선순위 정렬 목록 한 줄 */
export interface PriorityMatrixItem {
  id: string;
  yearId: string;
  title: string;
  wbsCode: string;
  status: TaskStatus;
  ownerMemberId: string | null;
  dueDate: string | null;
  dday: string | null;
  overdue: boolean;
  importance: PriorityLevel;
  urgency: PriorityLevel;
  score: number;
  grade: PriorityGrade;
  colorToken: string;
  urgencyPinned: boolean;
}

export interface PriorityMatrixData {
  projectId: string;
  todayISO: string;
  stages: Stage[];
  years: Year[];
  selectedYearId: string | null;
  missingRequestedYear: boolean;
  /** 25칸. 중요도 5→1(위에서 아래), 긴급도 1→5(왼→오른) */
  cells: PriorityMatrixCell[];
  /** 점수 내림차순. PR-6에 따라 완료는 최후순위 */
  items: PriorityMatrixItem[];
  invalidTaskIds: string[];
}

// ─── 공통 조회 ────────────────────────────────────────────────────────────────

interface BoardScope {
  stages: Stage[];
  years: Year[];
  selectedYearId: string | null;
  missingRequestedYear: boolean;
  /** 표시 대상 연차의 트리 (선택 순서대로) */
  groups: { year: Year; nodes: WbsNode[] }[];
  /** 과제 전체 기준 컨테이너 — 화면에 안 보이는 형제까지 담아야 재정렬이 안전하다 (X-3) */
  containers: BoardContainer[];
  invalidTaskIds: string[];
  today: string;
}

// 표시 순서(pre-order). WbsNode는 order 순으로 정렬된 트리라 이 순서가 곧 order 순서다 (PR-8).
function walkPreOrder(nodes: readonly WbsNode[], visit: (node: WbsNode) => void): void {
  for (const node of nodes) {
    visit(node);
    walkPreOrder(node.children, visit);
  }
}

function collectContainers(groups: readonly { year: Year; nodes: WbsNode[] }[]): BoardContainer[] {
  const containers: BoardContainer[] = [];
  const push = (yearId: string, parentId: string | null, nodes: readonly WbsNode[]): void => {
    if (nodes.length === 0) return;
    containers.push({
      key: containerKey(yearId, parentId),
      yearId,
      parentId,
      taskIds: nodes.map((n) => n.task.id),
    });
    for (const node of nodes) push(yearId, node.task.id, node.children);
  };
  for (const group of groups) push(group.year.id, null, group.nodes);
  return containers;
}

/**
 * 연차 필터를 풀고(기본: 수행 중 연차) 트리를 읽어 온다.
 * yearId === BOARD_ALL_YEARS면 전체 연차, undefined면 수행 중 연차 → 첫 연차 순으로 고른다 (§7.6).
 */
async function loadScope(
  projectId: string,
  yearId?: string
): Promise<ActionResult<BoardScope>> {
  const full = await getProjectFullTree(projectId);
  if (!full.ok) return full;

  const { stages, years: yearTrees, invalidTaskIds } = full.data;
  const years = yearTrees.map((y) => y.year);
  const today = todayISO(new Date()); // §6.5 기준일 — Asia/Seoul 달력

  // 컨테이너는 필터와 무관하게 과제 전체에서 모은다 — reorderTasks에 넘길 형제 목록이
  // 화면 필터 때문에 빠지면 숨은 작업의 order와 충돌한다 (X-3).
  const containers = collectContainers(yearTrees);

  const showAll = yearId === BOARD_ALL_YEARS;
  const selected = showAll
    ? null
    : (years.find((y) => y.id === yearId) ??
      years.find((y) => y.status === 'active') ?? // §7.6 기본: 현재 진행 연차
      years[0] ??
      null);
  const missingRequestedYear =
    !showAll && yearId !== undefined && !years.some((y) => y.id === yearId);

  if (selected === null) {
    return {
      ok: true,
      data: {
        stages,
        years,
        selectedYearId: null,
        missingRequestedYear,
        groups: yearTrees.map((y) => ({ year: y.year, nodes: y.nodes })),
        containers,
        invalidTaskIds,
        today,
      },
    };
  }

  // 단일 연차는 WBS 코드가 연차 단위로 리셋된 트리여야 한다(접두 없음) — 전체 트리를
  // 재사용할 수 없다 (§6.7, WBS 화면과 같은 처리).
  const tree = await getYearTree(selected.id);
  if (!tree.ok) return tree;

  return {
    ok: true,
    data: {
      stages,
      years,
      selectedYearId: selected.id,
      missingRequestedYear,
      groups: [{ year: tree.data.year, nodes: tree.data.nodes }],
      containers,
      invalidTaskIds: tree.data.invalidTaskIds,
      today,
    },
  };
}

function toDday(task: Task, today: string): string | null {
  return task.dueDate === null ? null : formatDday(today, task.dueDate);
}

function toCard(node: WbsNode, sortIndex: number, today: string): BoardCard {
  const { task } = node;
  const { grade, color } = priorityGrade(node.priorityScore);
  return {
    id: task.id,
    yearId: task.yearId,
    parentId: task.parentId,
    title: task.title,
    wbsCode: node.wbsCode,
    status: task.status,
    progress: node.progress,
    dueDate: task.dueDate,
    dday: toDday(task, today),
    overdue: isOverdueTask(task, today),
    ownerMemberId: task.ownerMemberId,
    memberIds: task.memberIds,
    orgId: task.orgId,
    tags: task.tags,
    importance: task.importance,
    urgency: node.urgency,
    score: node.priorityScore,
    grade,
    colorToken: color,
    urgencyPinned: task.urgencyMode === 'manual',
    isLeaf: node.isLeaf,
    sortIndex,
  };
}

// ─── §9 getBoardData ──────────────────────────────────────────────────────────

export async function getBoardData(
  projectId: string,
  yearId?: string
): Promise<ActionResult<BoardData>> {
  const scope = await loadScope(projectId, yearId);
  if (!scope.ok) return scope;

  const cards: BoardCard[] = [];
  for (const group of scope.data.groups) {
    walkPreOrder(group.nodes, (node) => {
      cards.push(toCard(node, cards.length, scope.data.today));
    });
  }

  return {
    ok: true,
    data: {
      projectId,
      todayISO: scope.data.today,
      stages: scope.data.stages,
      years: scope.data.years,
      selectedYearId: scope.data.selectedYearId,
      missingRequestedYear: scope.data.missingRequestedYear,
      cards,
      containers: scope.data.containers,
      invalidTaskIds: scope.data.invalidTaskIds,
    },
  };
}

// ─── §9 getPriorityMatrix ─────────────────────────────────────────────────────

export async function getPriorityMatrix(
  projectId: string,
  yearId?: string
): Promise<ActionResult<PriorityMatrixData>> {
  const scope = await loadScope(projectId, yearId);
  if (!scope.ok) return scope;

  const today = scope.data.today;

  // PR-9: 매트릭스는 리프 Task만 담는다. 부모는 묶음일 뿐 실행 단위가 아니다.
  const leaves: WbsNode[] = [];
  for (const group of scope.data.groups) {
    walkPreOrder(group.nodes, (node) => {
      if (node.isLeaf) leaves.push(node);
    });
  }

  // PR-6(완료는 최후순위)과 점수 내림차순은 lib/priority.comparePriority가 원본이다.
  // 동점은 마감 이른 순 → id 순으로 고정해 새로고침마다 순서가 흔들리지 않게 한다.
  const sorted = [...leaves].sort((a, b) => {
    const byPriority = comparePriority(a.task, b.task, today);
    if (byPriority !== 0) return byPriority;
    if (a.task.dueDate !== b.task.dueDate) {
      if (a.task.dueDate === null) return 1; // 마감 없는 항목은 뒤로
      if (b.task.dueDate === null) return -1;
      return a.task.dueDate < b.task.dueDate ? -1 : 1;
    }
    return a.task.id < b.task.id ? -1 : a.task.id > b.task.id ? 1 : 0;
  });

  const matrixInputs: MatrixItemInput[] = leaves.map((node) => ({
    id: node.task.id,
    importance: node.task.importance,
    urgency: node.urgency,
    done: node.task.status === 'done',
  }));

  const items: PriorityMatrixItem[] = sorted.map((node) => {
    const { grade, color } = priorityGrade(node.priorityScore);
    return {
      id: node.task.id,
      yearId: node.task.yearId,
      title: node.task.title,
      wbsCode: node.wbsCode,
      status: node.task.status,
      ownerMemberId: node.task.ownerMemberId,
      dueDate: node.task.dueDate,
      dday: toDday(node.task, today),
      overdue: isOverdueTask(node.task, today),
      importance: node.task.importance,
      urgency: node.urgency,
      score: node.priorityScore,
      grade,
      colorToken: color,
      urgencyPinned: node.task.urgencyMode === 'manual',
    };
  });

  return {
    ok: true,
    data: {
      projectId,
      todayISO: today,
      stages: scope.data.stages,
      years: scope.data.years,
      selectedYearId: scope.data.selectedYearId,
      missingRequestedYear: scope.data.missingRequestedYear,
      cells: buildPriorityCells(matrixInputs),
      items,
      invalidTaskIds: scope.data.invalidTaskIds,
    },
  };
}
