'use client';

// WBS 트리 화면의 상태·키보드·드래그·액션 호출 (SOT §7.4)
//  - 데이터는 전부 서버(page.tsx)가 계산해 내려준다. 여기서 진척률·WBS 코드·우선순위를
//    다시 계산하거나 저장하지 않는다 (§6.1 O-4, §6.7, PR-7).
//  - 트리 기본 정렬은 order 그대로 유지한다 — 우선순위로 재정렬하지 않는다 (PR-8).
//  - 모든 이동은 lib/tree.canMoveTask로 먼저 검사해 거절 사유를 화면에 밝힌다. 서버(RPC)가
//    거부한 경우도 같은 문구로 보여준다 (H-1·H-2·H-3은 DB·UI 양쪽에 동일 정의).

import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { useRouter } from 'next/navigation';
import type { Member, Organization, ProgressMode, Stage, Task, TaskStatus, Year } from '@/types';
import {
  createTask,
  deleteTask,
  moveTask,
  setProgressMode,
  setTaskProgress,
  setTaskStatus,
  updateTask,
  type WbsNode,
} from '@/actions/tasks';
import type { ActionErrorCode } from '@/lib/db/errors';
import { canMoveTask, getDescendantIds, type MoveRejectReason } from '@/lib/tree';
import { priorityGrade, type PriorityGrade } from '@/lib/priority';
import {
  MAX_TASK_DEPTH,
  PRIORITY_SCORE_COLORS,
  TASK_STATUS_LABELS,
} from '@/lib/constants';
import { setRealtimePaused } from '@/components/RealtimeRefresher';
import Button from '@/components/ui/Button';
import ErrorBanner from '@/components/ui/ErrorBanner';
import Modal from '@/components/ui/Modal';
import YearSelector, { ALL_YEARS } from './YearSelector';
import TreeTable, { type TreeTableGroup } from './TreeTable';
import type { DropZone, TreeRowCallbacks } from './TreeRow';
import TaskDetailPanel from './TaskDetailPanel';

export interface WbsGroup {
  year: Year;
  nodes: WbsNode[];
  yearProgress: number;
}

export interface WbsScreenProps {
  projectId: string;
  stages: Stage[];
  /** 셀렉터에 쓸 과제의 전 연차 */
  years: Year[];
  /** 표시할 연차 묶음. 단일 연차 보기면 1개, 전체 연차 보기면 전부 */
  groups: WbsGroup[];
  /** 담당·기관 컬럼과 상세 패널 배정에 쓰는 과제 인력 (§5.11, §7.4) */
  members: Member[];
  /** 수행 기관 후보 (§5.10) */
  organizations: Organization[];
  selectedYearId: string | typeof ALL_YEARS;
  /** 트리에 편입되지 못한 작업 (절대 규칙 5: 조용히 버리지 않는다) */
  invalidTaskIds: string[];
  /** 지연 판정 기준일. 서버에서 넘겨 SSR/CSR 판정이 갈리지 않게 한다 */
  todayISO: string;
}

// H-1·H-2·H-3 위반 문구. DB(move_task RPC)와 UI가 같은 규칙을 말하도록 여기 한 곳에 둔다.
const REJECT_MESSAGES: Record<MoveRejectReason, string> = {
  NOT_FOUND: '대상 작업을 찾을 수 없습니다. 화면을 새로고침한 뒤 다시 시도하세요.',
  CROSS_YEAR: '다른 연차의 작업 아래로는 옮길 수 없습니다.',
  CYCLE: '자기 자신이나 하위 작업 아래로는 옮길 수 없습니다.',
  DEPTH: `작업 계층은 최대 ${MAX_TASK_DEPTH}단계까지만 만들 수 있습니다.`,
};

// 서버 RPC의 거절 문구를 UI 사전 검사와 같은 문장으로 정규화한다.
// 모르는 사유는 서버 문구를 그대로 보여준다 — 삼키지 않는다 (절대 규칙 5).
function toRejectMessage(serverMessage: string): string {
  if (serverMessage.includes('깊이')) return REJECT_MESSAGES.DEPTH;
  if (serverMessage.includes('다른 연차')) return REJECT_MESSAGES.CROSS_YEAR;
  if (serverMessage.includes('자손') || serverMessage.includes('자기 자신')) {
    return REJECT_MESSAGES.CYCLE;
  }
  if (serverMessage.includes('찾을 수 없습니다')) return REJECT_MESSAGES.NOT_FOUND;
  return serverMessage;
}

const NEW_TASK_TITLE = '새 작업';
const GRADES = PRIORITY_SCORE_COLORS.map((b) => b.grade);

type Failure = { message: string; code?: ActionErrorCode };

// 필터에 걸린 노드의 조상은 계층을 보이기 위해 함께 남긴다 (트리가 끊겨 보이면 안 된다)
function collectVisible(
  nodes: readonly WbsNode[],
  keep: (node: WbsNode) => boolean,
  into: Set<string>
): boolean {
  let anyVisible = false;
  for (const node of nodes) {
    const childVisible = collectVisible(node.children, keep, into);
    if (childVisible || keep(node)) {
      into.add(node.task.id);
      anyVisible = true;
    }
  }
  return anyVisible;
}

// 표시 순서(pre-order). 접힌 노드의 자손과 필터에서 빠진 노드는 건너뛴다.
function flattenVisible(
  nodes: readonly WbsNode[],
  visibleIds: ReadonlySet<string>,
  collapsedIds: ReadonlySet<string>,
  out: WbsNode[]
): void {
  for (const node of nodes) {
    if (!visibleIds.has(node.task.id)) continue;
    out.push(node);
    if (!collapsedIds.has(node.task.id)) {
      flattenVisible(node.children, visibleIds, collapsedIds, out);
    }
  }
}

function walk(nodes: readonly WbsNode[], visit: (node: WbsNode, parent: WbsNode | null) => void): void {
  const go = (list: readonly WbsNode[], parent: WbsNode | null): void => {
    for (const node of list) {
      visit(node, parent);
      go(node.children, node);
    }
  };
  go(nodes, null);
}

export default function WbsScreen({
  projectId,
  stages,
  years,
  groups,
  members,
  organizations,
  selectedYearId,
  invalidTaskIds,
  todayISO,
}: WbsScreenProps) {
  const router = useRouter();

  const [collapsedIds, setCollapsedIds] = useState<ReadonlySet<string>>(() => new Set<string>());
  const [selectedId, setSelectedId] = useState<string | null>(null);
  // 이름 편집 상태. 입력값을 여기 두는 이유는 저장이 STALE로 실패해도 사용자가 친 제목을
  // 잃지 않기 위해서다 (O-3). 행이 다시 그려져도 값은 이 상태에서 다시 채워진다.
  const [renaming, setRenaming] = useState<{ id: string; draft: string } | null>(null);
  // 이름 변경 충돌. 최신 제목과 내 입력을 나란히 보여주고 사용자가 고르게 한다 (O-3)
  const [renameConflict, setRenameConflict] = useState<{ id: string; mine: string; message: string } | null>(
    null
  );
  const [detailOpen, setDetailOpen] = useState(false);
  const [dragId, setDragId] = useState<string | null>(null);
  const [dropTarget, setDropTarget] = useState<{ id: string; zone: DropZone } | null>(null);
  const [deleteTargetId, setDeleteTargetId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<Failure | null>(null);
  const [focusToken, setFocusToken] = useState(0);

  const [hideDone, setHideDone] = useState(false);
  const [statusFilter, setStatusFilter] = useState<TaskStatus | 'all'>('all');
  const [gradeFilter, setGradeFilter] = useState<PriorityGrade | 'all'>('all');
  const [memberFilter, setMemberFilter] = useState<string>('all');
  const [orgFilter, setOrgFilter] = useState<string>('all');

  // id → 이름 사전. 행·상세 패널·충돌 비교가 같은 사전을 봐야 같은 이름이 나온다.
  const memberNames = useMemo(() => {
    const map: Record<string, string> = {};
    for (const member of members) map[member.id] = member.name;
    return map;
  }, [members]);

  const orgNames = useMemo(() => {
    const map: Record<string, string> = {};
    for (const org of organizations) map[org.id] = org.name;
    return map;
  }, [organizations]);

  // 원본 트리 색인. 필터·접기와 무관하게 이동 계산은 항상 원본 기준이어야 한다 (H-12).
  const index = useMemo(() => {
    const nodeById = new Map<string, WbsNode>();
    const parentById = new Map<string, WbsNode | null>();
    const rootsByYear = new Map<string, WbsNode[]>();
    const tasksByYear = new Map<string, Task[]>();
    const parentIds: string[] = [];

    for (const group of groups) {
      rootsByYear.set(group.year.id, group.nodes);
      const tasks: Task[] = [];
      walk(group.nodes, (node, parent) => {
        nodeById.set(node.task.id, node);
        parentById.set(node.task.id, parent);
        tasks.push(node.task);
        if (node.children.length > 0) parentIds.push(node.task.id);
      });
      tasksByYear.set(group.year.id, tasks);
    }
    return { nodeById, parentById, rootsByYear, tasksByYear, parentIds };
  }, [groups]);

  const displayGroups: TreeTableGroup[] = useMemo(() => {
    const keep = (node: WbsNode): boolean => {
      if (hideDone && node.task.status === 'done') return false;
      if (statusFilter !== 'all' && node.task.status !== statusFilter) return false;
      if (gradeFilter !== 'all' && priorityGrade(node.priorityScore).grade !== gradeFilter) {
        return false;
      }
      // 담당 필터는 책임자와 참여자를 함께 본다 — 참여만 하는 작업이 빠지면 "내 일"을 못 찾는다
      if (
        memberFilter !== 'all' &&
        node.task.ownerMemberId !== memberFilter &&
        !node.task.memberIds.includes(memberFilter)
      ) {
        return false;
      }
      if (orgFilter !== 'all' && node.task.orgId !== orgFilter) return false;
      return true;
    };

    return groups.map((group) => {
      const visibleIds = new Set<string>();
      collectVisible(group.nodes, keep, visibleIds);
      const rows: WbsNode[] = [];
      flattenVisible(group.nodes, visibleIds, collapsedIds, rows);
      let total = 0;
      walk(group.nodes, () => {
        total += 1;
      });
      return { year: group.year, yearProgress: group.yearProgress, rows, totalCount: total };
    });
  }, [groups, collapsedIds, hideDone, statusFilter, gradeFilter, memberFilter, orgFilter]);

  const visibleRows = useMemo(
    () => displayGroups.flatMap((g) => g.rows),
    [displayGroups]
  );

  const selectedNode = selectedId === null ? null : (index.nodeById.get(selectedId) ?? null);

  // 충돌 배너의 "최신" 값. router.refresh()로 새로 받은 서버 제목이라 내 입력과 나란히 비교된다.
  const renameConflictLatestTitle =
    renameConflict === null
      ? null
      : (index.nodeById.get(renameConflict.id)?.task.title ?? null);

  // R-4: 이름을 편집하는 동안에는 남의 변경으로 화면이 다시 그려지지 않게 보류한다
  const isRenaming = renaming !== null;
  useEffect(() => {
    if (!isRenaming) return;
    setRealtimePaused(true);
    return () => setRealtimePaused(false);
  }, [isRenaming]);

  // 한 번 화면에 보였던 작업이 사라지면(다른 사람이 삭제) 조용히 넘기지 않는다.
  // 방금 만든 작업은 아직 서버 응답 전이라 트리에 없을 수 있으므로 "보였던 적 있는 id"만 본다.
  const resolvedIdRef = useRef<string | null>(null);
  useEffect(() => {
    if (selectedNode !== null) {
      resolvedIdRef.current = selectedNode.task.id;
      return;
    }
    if (selectedId !== null && resolvedIdRef.current === selectedId) {
      resolvedIdRef.current = null;
      setSelectedId(null);
      setDetailOpen(false);
      setFailure({ message: '선택한 작업이 더 이상 없습니다. 다른 사람이 삭제했을 수 있습니다.' });
    }
  }, [selectedId, selectedNode]);

  // ─── 공통 실행 래퍼 ────────────────────────────────────────

  const finish = (res: { ok: true } | { ok: false; error: string; code?: ActionErrorCode }, rule = false): boolean => {
    if (!res.ok) {
      setFailure({
        message: rule && res.code === 'RULE' ? toRejectMessage(res.error) : res.error,
        code: res.code,
      });
      return false;
    }
    router.refresh();
    return true;
  };

  // ─── 형제·부모 조회 (원본 트리 기준) ───────────────────────

  const siblingsOf = (node: WbsNode): WbsNode[] => {
    const parent = index.parentById.get(node.task.id) ?? null;
    if (parent) return parent.children;
    return index.rootsByYear.get(node.task.yearId) ?? [];
  };

  // ─── 이동 (드래그 / Tab / Shift+Tab) ───────────────────────

  const applyMove = async (
    node: WbsNode,
    newParentId: string | null,
    newIndex: number
  ): Promise<void> => {
    // 깊이 10 차단은 UI에서 먼저 한다 — 서버 왕복 없이 이유를 말해 준다 (H-3)
    const yearTasks = index.tasksByYear.get(node.task.yearId) ?? [];
    const check = canMoveTask(yearTasks, node.task.id, newParentId);
    if (!check.ok) {
      setFailure({ message: REJECT_MESSAGES[check.reason], code: 'RULE' });
      return;
    }

    setBusy(true);
    setFailure(null);
    const res = await moveTask(node.task.id, newParentId, newIndex);
    setBusy(false);
    if (finish(res, true)) {
      // 새 부모가 접혀 있으면 옮긴 작업이 사라진 것처럼 보인다
      if (newParentId !== null) {
        setCollapsedIds((prev) => {
          if (!prev.has(newParentId)) return prev;
          const next = new Set(prev);
          next.delete(newParentId);
          return next;
        });
      }
      setFocusToken((n) => n + 1);
    }
  };

  const handleIndent = (node: WbsNode): void => {
    const siblings = siblingsOf(node);
    const at = siblings.findIndex((s) => s.task.id === node.task.id);
    const previous = at > 0 ? siblings[at - 1] : undefined;
    if (!previous) {
      setFailure({ message: '바로 위에 형제 작업이 없어 들여쓸 수 없습니다.', code: 'RULE' });
      return;
    }
    // H-12: 대상을 뺀 뒤의 새 부모 자식 배열 기준 삽입 위치 = 맨 끝
    const insertAt = previous.children.filter((c) => c.task.id !== node.task.id).length;
    void applyMove(node, previous.task.id, insertAt);
  };

  const handleOutdent = (node: WbsNode): void => {
    const parent = index.parentById.get(node.task.id) ?? null;
    if (!parent) {
      setFailure({ message: '이미 최상위 작업이라 더 내어쓸 수 없습니다.', code: 'RULE' });
      return;
    }
    const grandParent = index.parentById.get(parent.task.id) ?? null;
    const uncles = grandParent
      ? grandParent.children
      : (index.rootsByYear.get(parent.task.yearId) ?? []);
    const parentAt = uncles.findIndex((u) => u.task.id === parent.task.id);
    if (parentAt < 0) {
      setFailure({ message: REJECT_MESSAGES.NOT_FOUND, code: 'RULE' });
      return;
    }
    // 이동 대상은 조부모의 자식이 아니므로 배열이 그대로다 — 부모 바로 뒤에 놓는다
    void applyMove(node, grandParent?.task.id ?? null, parentAt + 1);
  };

  const handleDrop = (targetId: string, zone: DropZone): void => {
    const source = dragId === null ? null : (index.nodeById.get(dragId) ?? null);
    setDragId(null);
    setDropTarget(null);
    if (!source) return;
    const target = index.nodeById.get(targetId);
    if (!target || target.task.id === source.task.id) return;

    // H-1: 연차 간 부모-자식 관계 금지. 연차 이동은 별도 조작(moveTaskToYear)이다
    if (target.task.yearId !== source.task.yearId) {
      setFailure({ message: REJECT_MESSAGES.CROSS_YEAR, code: 'RULE' });
      return;
    }

    if (zone === 'inside') {
      const insertAt = target.children.filter((c) => c.task.id !== source.task.id).length;
      void applyMove(source, target.task.id, insertAt);
      return;
    }

    const siblings = siblingsOf(target).filter((s) => s.task.id !== source.task.id);
    const at = siblings.findIndex((s) => s.task.id === target.task.id);
    if (at < 0) return;
    void applyMove(source, target.task.parentId, zone === 'before' ? at : at + 1);
  };

  // ─── 생성 / 삭제 ───────────────────────────────────────────

  const handleCreateSibling = async (node: WbsNode): Promise<void> => {
    setBusy(true);
    setFailure(null);
    const created = await createTask(node.task.yearId, {
      title: NEW_TASK_TITLE,
      parentId: node.task.parentId,
    });
    if (!created.ok) {
      setBusy(false);
      setFailure({ message: created.error, code: created.code });
      return;
    }

    // 액션은 형제 맨 끝에 붙인다 — 선택 행 바로 아래로 옮긴다 (H-12: 대상 제거 후 배열 기준)
    const siblings = siblingsOf(node);
    const at = siblings.findIndex((s) => s.task.id === node.task.id);
    if (at >= 0 && at < siblings.length - 1) {
      const moved = await moveTask(created.data.id, node.task.parentId, at + 1);
      if (!moved.ok) {
        setBusy(false);
        setFailure({ message: toRejectMessage(moved.error), code: moved.code });
        return;
      }
    }
    setBusy(false);
    setSelectedId(created.data.id);
    setRenaming({ id: created.data.id, draft: created.data.title });
    router.refresh();
  };

  const handleCreateRoot = async (): Promise<void> => {
    const yearId = selectedNode?.task.yearId ?? groups[0]?.year.id;
    if (yearId === undefined) return;
    setBusy(true);
    setFailure(null);
    const created = await createTask(yearId, { title: NEW_TASK_TITLE });
    setBusy(false);
    if (!created.ok) {
      setFailure({ message: created.error, code: created.code });
      return;
    }
    setSelectedId(created.data.id);
    setRenaming({ id: created.data.id, draft: created.data.title });
    router.refresh();
  };

  const handleDeleteConfirmed = async (): Promise<void> => {
    if (deleteTargetId === null) return;
    setBusy(true);
    setFailure(null);
    const res = await deleteTask(deleteTargetId);
    setBusy(false);
    setDeleteTargetId(null);
    if (!res.ok) {
      setFailure({ message: res.error, code: res.code });
      return;
    }
    setSelectedId(null);
    setDetailOpen(false);
    router.refresh();
  };

  // ─── 인라인 편집 (O-2: 단일 조작은 낙관적 잠금 없이) ───────

  const handleStatusChange = async (id: string, status: TaskStatus): Promise<void> => {
    setBusy(true);
    setFailure(null);
    const res = await setTaskStatus(id, status);
    setBusy(false);
    finish(res);
  };

  const handleProgressCommit = async (id: string, value: number): Promise<void> => {
    setBusy(true);
    setFailure(null);
    const res = await setTaskProgress(id, value);
    setBusy(false);
    finish(res);
  };

  const handleProgressModeChange = async (id: string, mode: ProgressMode): Promise<void> => {
    setBusy(true);
    setFailure(null);
    const res = await setProgressMode(id, mode);
    setBusy(false);
    finish(res);
  };

  const closeRename = (): void => {
    setRenaming(null);
    setRenameConflict(null);
    // 이름 입력을 마치면 행으로 포커스를 되돌려 키보드 조작을 이어간다 (§12 접근성)
    setFocusToken((n) => n + 1);
  };

  // 이름 저장의 본체. 실패하면 편집 상태와 입력값을 반드시 살려 둔다 (O-3).
  const commitRename = async (id: string, title: string): Promise<void> => {
    const node = index.nodeById.get(id);
    if (!node) {
      setRenaming(null);
      setRenameConflict(null);
      setFailure({ message: '이름을 바꾸려는 작업이 더 이상 없습니다. 화면을 새로고침하세요.' });
      return;
    }
    const next = title.trim();
    if (next === '' || next === node.task.title) {
      closeRename();
      return;
    }

    setBusy(true);
    setFailure(null);
    // updateTask는 expectedVersion이 필수라 단일 필드여도 잠금이 걸린다(O-2의 생략은 선택 사항이다).
    // 잠금을 거는 이상 O-3를 지켜야 하므로 실패해도 입력을 되돌려 주는 편집 상태를 유지한다.
    const res = await updateTask(id, { title: next }, node.task.version);
    setBusy(false);

    if (!res.ok) {
      // 어떤 실패든 사용자가 친 제목은 화면에 남긴다
      setRenaming({ id, draft: next });
      if (res.code === 'STALE') {
        setRenameConflict({ id, mine: next, message: res.error });
        // 최신 제목을 받아 와 비교에 쓴다 (내 입력은 화면 상태라 지워지지 않는다)
        router.refresh();
        return;
      }
      setFailure({ message: res.error, code: res.code });
      return;
    }

    closeRename();
    router.refresh();
  };

  const handleRenameCommit = (id: string, title: string): void => {
    // 충돌 배너가 떠 있는 동안에는 입력 포커스가 빠질 때마다 같은 저장을 반복하지 않는다.
    // 재시도 여부는 사용자가 배너에서 고른다.
    if (renameConflict?.id === id) return;
    void commitRename(id, title);
  };

  const handleRenameRetry = (): void => {
    if (!renameConflict) return;
    const { id, mine } = renameConflict;
    setRenameConflict(null);
    // 배너를 보는 동안에도 계속 고칠 수 있으므로 지금 입력창에 있는 값을 우선한다
    void commitRename(id, renaming?.id === id ? renaming.draft : mine);
  };

  // ─── 키보드 조작 (§7.4, §12 접근성) ────────────────────────

  const selectAt = (offset: number): void => {
    if (visibleRows.length === 0) return;
    const at = visibleRows.findIndex((n) => n.task.id === selectedId);
    const next = at < 0 ? 0 : Math.min(visibleRows.length - 1, Math.max(0, at + offset));
    const target = visibleRows[next];
    if (!target) return;
    setSelectedId(target.task.id);
    setFocusToken((n) => n + 1);
  };

  const handleRowKeyDown = (id: string, e: KeyboardEvent<HTMLTableRowElement>): void => {
    const node = index.nodeById.get(id);
    if (!node || busy) return;

    switch (e.key) {
      case 'Enter':
        e.preventDefault();
        void handleCreateSibling(node);
        return;
      case 'Tab':
        e.preventDefault();
        if (e.shiftKey) handleOutdent(node);
        else handleIndent(node);
        return;
      case 'Delete':
        e.preventDefault();
        setDeleteTargetId(id);
        return;
      case 'F2':
        e.preventDefault();
        setRenaming({ id, draft: node.task.title });
        return;
      case 'ArrowDown':
        e.preventDefault();
        selectAt(1);
        return;
      case 'ArrowUp':
        e.preventDefault();
        selectAt(-1);
        return;
      case 'ArrowRight':
        e.preventDefault();
        if (node.children.length > 0) {
          setCollapsedIds((prev) => {
            const next = new Set(prev);
            next.delete(id);
            return next;
          });
        }
        return;
      case 'ArrowLeft':
        e.preventDefault();
        if (node.children.length > 0 && !collapsedIds.has(id)) {
          setCollapsedIds((prev) => new Set(prev).add(id));
        } else {
          const parent = index.parentById.get(id);
          if (parent) {
            setSelectedId(parent.task.id);
            setFocusToken((n) => n + 1);
          }
        }
        return;
      default:
    }
  };

  const callbacks: TreeRowCallbacks = {
    onSelect: (id) => {
      setSelectedId(id);
      setDetailOpen(true);
    },
    onToggleCollapse: (id) =>
      setCollapsedIds((prev) => {
        const next = new Set(prev);
        if (next.has(id)) next.delete(id);
        else next.add(id);
        return next;
      }),
    onRowKeyDown: handleRowKeyDown,
    onStatusChange: (id, status) => void handleStatusChange(id, status),
    onProgressCommit: (id, value) => void handleProgressCommit(id, value),
    onProgressModeChange: (id, mode) => void handleProgressModeChange(id, mode),
    onRenameStart: (id) => {
      const node = index.nodeById.get(id);
      if (node) setRenaming({ id, draft: node.task.title });
    },
    onRenameChange: (id, title) => {
      setRenaming({ id, draft: title });
      // 사용자가 다시 고치기 시작하면 지난 충돌 안내는 역할이 끝났다 —
      // 배너를 치워야 Enter 저장(재시도)이 막히지 않는다
      if (renameConflict?.id === id) setRenameConflict(null);
    },
    onRenameCommit: (id, title) => void handleRenameCommit(id, title),
    onRenameCancel: closeRename,
    onDragStart: (id) => setDragId(id),
    onDragEnd: () => {
      setDragId(null);
      setDropTarget(null);
    },
    onDragOverRow: (id, zone) =>
      setDropTarget((prev) => (prev?.id === id && prev.zone === zone ? prev : { id, zone })),
    onDropRow: handleDrop,
  };

  const deleteTarget = deleteTargetId === null ? null : index.nodeById.get(deleteTargetId);
  const descendantCount = deleteTarget ? getDescendantIds(deleteTarget).length : 0;

  const detailVisible = detailOpen && selectedNode !== null;

  return (
    // 상세 패널은 오른쪽 고정 드로어다 — 열려 있는 동안 표가 가려지지 않게 자리를 비운다
    <section className={detailVisible ? 'pr-[396px]' : ''}>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <YearSelector
          projectId={projectId}
          stages={stages}
          years={years}
          selectedYearId={selectedYearId}
          disabled={busy}
        />
        <Button variant="primary" size="sm" disabled={busy || groups.length === 0} onClick={() => void handleCreateRoot()}>
          새 작업
        </Button>
      </div>

      {/* 툴바 (§7.4). 태그 필터는 아직 없다 */}
      <div className="mt-4 flex flex-wrap items-center gap-3 rounded-xl border border-slate-200 bg-white p-3 text-sm">
        <Button size="sm" onClick={() => setCollapsedIds(new Set())}>
          전체 펼치기
        </Button>
        <Button size="sm" onClick={() => setCollapsedIds(new Set(index.parentIds))}>
          전체 접기
        </Button>

        <label className="flex items-center gap-2 text-slate-600">
          <input
            type="checkbox"
            checked={hideDone}
            onChange={(e) => setHideDone(e.target.checked)}
            className="h-4 w-4 rounded border-slate-300"
          />
          완료 숨기기
        </label>

        <label className="flex items-center gap-2 text-slate-600">
          상태
          <select
            value={statusFilter}
            onChange={(e) => setStatusFilter(e.target.value as TaskStatus | 'all')}
            className="rounded-lg border border-slate-300 bg-white px-2.5 py-1.5 text-sm focus:border-slate-500 focus:outline-none"
          >
            <option value="all">전체</option>
            {(Object.keys(TASK_STATUS_LABELS) as TaskStatus[]).map((status) => (
              <option key={status} value={status}>
                {TASK_STATUS_LABELS[status]}
              </option>
            ))}
          </select>
        </label>

        <label className="flex items-center gap-2 text-slate-600">
          담당
          <select
            value={memberFilter}
            onChange={(e) => setMemberFilter(e.target.value)}
            className="max-w-40 rounded-lg border border-slate-300 bg-white px-2.5 py-1.5 text-sm focus:border-slate-500 focus:outline-none"
          >
            <option value="all">전체</option>
            {members.map((member) => (
              <option key={member.id} value={member.id}>
                {member.active ? member.name : `${member.name} (참여종료)`}
              </option>
            ))}
          </select>
        </label>

        <label className="flex items-center gap-2 text-slate-600">
          기관
          <select
            value={orgFilter}
            onChange={(e) => setOrgFilter(e.target.value)}
            className="max-w-40 rounded-lg border border-slate-300 bg-white px-2.5 py-1.5 text-sm focus:border-slate-500 focus:outline-none"
          >
            <option value="all">전체</option>
            {organizations.map((org) => (
              <option key={org.id} value={org.id}>
                {org.name}
              </option>
            ))}
          </select>
        </label>

        <label className="flex items-center gap-2 text-slate-600">
          우선순위
          <select
            value={gradeFilter}
            onChange={(e) => setGradeFilter(e.target.value as PriorityGrade | 'all')}
            className="rounded-lg border border-slate-300 bg-white px-2.5 py-1.5 text-sm focus:border-slate-500 focus:outline-none"
          >
            <option value="all">전체</option>
            {GRADES.map((grade) => (
              <option key={grade} value={grade}>
                {grade}
              </option>
            ))}
          </select>
        </label>

        <span className="ml-auto text-xs text-slate-400">
          행 선택 후 Enter 새 작업 · Tab 들여쓰기 · Shift+Tab 내어쓰기 · F2 이름 변경 · Delete 삭제
        </span>
      </div>

      {invalidTaskIds.length > 0 && (
        // 절대 규칙 5: 트리에 붙지 못한 작업을 조용히 버리지 않는다
        <ErrorBanner
          className="mt-4"
          code="RULE"
          message={`계층 구조에 편입되지 못한 작업이 ${invalidTaskIds.length}건 있습니다. 부모 작업이 삭제되었거나 다른 연차를 가리키고 있습니다. 관리자에게 알려 데이터를 정리하세요.`}
        />
      )}

      {failure && (
        <ErrorBanner
          className="mt-4"
          message={failure.message}
          code={failure.code}
          onDismiss={() => setFailure(null)}
        />
      )}

      {renameConflict && (
        // O-3: 이름 변경이 충돌해도 입력한 제목을 날리지 않는다. 최신 값과 나란히 두고 고르게 한다
        <div
          role="status"
          className="mt-4 rounded-xl border border-amber-200 bg-amber-50 p-3 text-sm text-amber-800"
        >
          <p className="font-semibold">이름 변경이 저장되지 않았습니다.</p>
          <p className="mt-1 text-xs">{renameConflict.message}</p>
          <div className="mt-2 flex flex-wrap items-center gap-2 rounded-lg bg-white/70 px-2.5 py-1.5 text-xs">
            <span className="font-semibold text-slate-700">작업명</span>
            <span className="text-slate-500">내 입력: {renameConflict.mine}</span>
            <span className="text-slate-500">
              최신: {renameConflictLatestTitle ?? '(작업이 삭제되었습니다)'}
            </span>
          </div>
          <p className="mt-1 text-xs">
            입력한 제목은 표에 그대로 남아 있습니다. 계속 고쳐도 되고, 아래에서 바로 고를 수도 있습니다.
          </p>
          <div className="mt-2 flex flex-wrap gap-2">
            <button
              type="button"
              disabled={busy || renameConflictLatestTitle === null}
              onClick={handleRenameRetry}
              className="rounded-md border border-amber-300 px-2 py-0.5 text-xs font-semibold text-amber-800 disabled:opacity-50"
            >
              내 입력으로 다시 저장
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={closeRename}
              className="rounded-md border border-slate-300 px-2 py-0.5 text-xs font-semibold text-slate-600"
            >
              최신 이름 두기 (내 입력 버림)
            </button>
          </div>
        </div>
      )}

      <div className="mt-4">
        <TreeTable
          groups={displayGroups}
          todayISO={todayISO}
          memberNames={memberNames}
          orgNames={orgNames}
          selectedId={selectedId}
          renaming={renaming}
          collapsedIds={collapsedIds}
          dragId={dragId}
          dropTarget={dropTarget}
          busy={busy}
          focusToken={focusToken}
          callbacks={callbacks}
        />
      </div>

      {deleteTarget && (
        <Modal
          open
          title="작업을 삭제할까요?"
          onClose={() => setDeleteTargetId(null)}
          closeOnBackdrop={false}
          footer={
            <>
              <Button size="sm" onClick={() => setDeleteTargetId(null)} disabled={busy}>
                취소
              </Button>
              <Button
                size="sm"
                variant="danger"
                onClick={() => void handleDeleteConfirmed()}
                disabled={busy}
              >
                삭제
              </Button>
            </>
          }
        >
          <p className="text-sm text-slate-700">
            <strong>{deleteTarget.task.title}</strong>
            {descendantCount > 0
              ? ` 및 하위 작업 ${descendantCount}건이 함께 삭제됩니다.`
              : '을(를) 삭제합니다.'}
          </p>
          <p className="mt-2 text-xs text-slate-500">
            삭제한 작업은 되돌릴 수 없습니다. 이 작업을 참조하던 노트·리스크는 연결만 해제됩니다.
          </p>
        </Modal>
      )}

      {detailVisible && selectedNode && (
        <TaskDetailPanel
          key={selectedNode.task.id}
          task={selectedNode.task}
          urgency={selectedNode.urgency}
          priorityScore={selectedNode.priorityScore}
          wbsCode={selectedNode.wbsCode}
          members={members}
          organizations={organizations}
          memberNames={memberNames}
          orgNames={orgNames}
          onClose={() => setDetailOpen(false)}
        />
      )}
    </section>
  );
}
