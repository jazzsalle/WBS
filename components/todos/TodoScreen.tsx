'use client';

// To-Do 화면 컨테이너 (SOT §7.13 T-D1~T-D10, §8.4 O-1~O-3, §8.5 R-4)
//
//  - 데이터는 전부 서버(page.tsx → getTodosData)가 조회해 내려준다. 오늘(todayISO)도 prop이다.
//  - 필터·정렬·지연 판정은 lib/todos.ts 순수 함수만 쓴다 (T-D3) — 판정식을 화면에 복제하면
//    대시보드 "오늘의 To-Do"(§7.2 6)와 건수가 조용히 어긋난다.
//  - 쓰기는 전부 actions/todos.ts를 거친다. supabase를 직접 부르지 않는다 (§8.2 C-2).
//  - T-D10: 드래그 결과는 **필터로 숨겨진 항목까지 포함한 전체 순서**로 보낸다.
//    보이는 것만 보내면 필터를 풀었을 때 순서가 섞이고, reorder_todos RPC가 거부한다.

import { useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import type { Todo } from '@/types';
import type { ActionErrorCode } from '@/lib/db/errors';
import type { TodosData } from '@/actions/todos';
import { deleteTodo, reorderTodos } from '@/actions/todos';
import {
  filterTodos,
  sortTodos,
  type TodoFilter,
  type TodoFilterMode,
  type TodoSortOrder,
} from '@/lib/todos';
// reorderIds는 "전체 순서에서 한 항목만 앞/뒤로 옮긴다"는 범용 순수 함수다 (칸반 전용 상태가
// 아니다). To-Do도 X-3의 같은 계약(전체 배열 전달)을 쓰므로 다시 구현하지 않고 그대로 쓴다.
import { reorderIds, type DropPosition } from '@/lib/board';
import { setRealtimePaused } from '@/components/RealtimeRefresher';
import Button from '@/components/ui/Button';
import ErrorBanner from '@/components/ui/ErrorBanner';
import Modal from '@/components/ui/Modal';
import TodoQuickAdd from './TodoQuickAdd';
import TodoFilters from './TodoFilters';
import TodoList from './TodoList';

export interface Failure {
  message: string;
  code?: ActionErrorCode;
}

export interface TodoScreenProps {
  data: TodosData;
  /** §7.13 서문·§6.5 기준일. 서버가 todayISO(new Date())로 Asia/Seoul 달력에 맞춰 고정한 값 */
  todayISO: string;
}

const EMPTY_MESSAGES: Record<TodoFilterMode, string> = {
  all: '아직 할 일이 없습니다. 위에 한 줄로 적고 Enter를 누르세요.',
  open: '미완료 할 일이 없습니다.',
  today: '오늘까지 마감인 할 일이 없습니다. (지난 마감도 여기에 함께 보입니다)',
  project: '이 과제에 걸린 할 일이 없습니다.',
};

export default function TodoScreen({ data, todayISO }: TodoScreenProps) {
  const router = useRouter();

  // T-D1: 진입 기본 필터는 `미완료`. T-D9: 진입 기본 정렬은 `수동`.
  const [mode, setMode] = useState<TodoFilterMode>('open');
  const [projectId, setProjectId] = useState<string | null | undefined>(undefined);
  const [order, setOrder] = useState<TodoSortOrder>('manual');

  const [draggingId, setDraggingId] = useState<string | null>(null);
  const [dropTarget, setDropTarget] = useState<{ id: string; position: DropPosition } | null>(null);
  // 드롭 직후 서버 응답을 기다리는 동안 행이 제자리에 남아 있으면 조작이 먹히지 않은 것처럼
  // 보인다. 새 순서를 미리 반영하고, 실패하면 지워 원위치로 되돌린다 (절대 규칙 5).
  const [pendingOrder, setPendingOrder] = useState<string[] | null>(null);

  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<Failure | null>(null);

  // 서버가 새 목록을 내려주면 낙관적 순서는 역할이 끝났다 (그때가 진실이다)
  useEffect(() => {
    setPendingOrder(null);
  }, [data.todos]);

  // R-4: 드래그하는 동안 화면이 다시 그려지면 잡고 있던 행이 사라진다
  const dragging = draggingId !== null;
  useEffect(() => {
    if (!dragging) return;
    setRealtimePaused(true);
    return () => setRealtimePaused(false);
  }, [dragging]);

  // 낙관적 순서는 `order` 값만 갈아끼운다 — 정렬은 그대로 sortTodos('manual')가 한다.
  // (파생 값이므로 저장하지 않는다. 저장은 reorderTodos RPC가 0..n-1로 다시 매긴다)
  const todos: Todo[] = useMemo(() => {
    if (pendingOrder === null) return data.todos;
    const rank = new Map(pendingOrder.map((id, index) => [id, index]));
    return data.todos.map((todo) => {
      const next = rank.get(todo.id);
      return next === undefined ? todo : { ...todo, order: next };
    });
  }, [data.todos, pendingOrder]);

  // filterTodos는 mode='project'인데 projectId가 undefined면 RangeError를 던진다 —
  // "과제를 아직 안 골랐다"는 화면 상태이므로 여기서 표현한다. T-D5의 null("과제 없음")과 다르다.
  const projectUnset = mode === 'project' && projectId === undefined;
  const filter = useMemo<TodoFilter>(
    () => (projectUnset ? { mode: 'open' } : { mode, projectId }),
    [projectUnset, mode, projectId]
  );

  const visible = useMemo(
    () => sortTodos(filterTodos(todos, filter, todayISO), order),
    [todos, filter, todayISO, order]
  );

  // T-D10: 필터가 걸려 있어도 이 전체 순서 위에서 재계산한다
  const fullOrderIds = useMemo(() => sortTodos(todos, 'manual').map((todo) => todo.id), [todos]);

  const deleting = deletingId === null ? null : (todos.find((t) => t.id === deletingId) ?? null);

  // 남이 지운 할 일이 대상으로 남아 있으면 다음 조작이 사라진 행을 가리킨다
  useEffect(() => {
    if (deletingId !== null && !data.todos.some((t) => t.id === deletingId)) setDeletingId(null);
  }, [data.todos, deletingId]);

  const clearDrag = (): void => {
    setDraggingId(null);
    setDropTarget(null);
  };

  const handleDrop = async (targetId: string, position: DropPosition): Promise<void> => {
    const movedId = draggingId;
    clearDrag();
    if (movedId === null || movedId === targetId) return;

    const next = reorderIds(fullOrderIds, movedId, targetId, position);
    if (next === null) {
      // 조용히 넘기지 않는다 — 대상이 사라졌다는 뜻이다 (절대 규칙 5)
      setFailure({
        message: '옮기려는 할 일이 더 이상 없습니다. 화면을 새로고침한 뒤 다시 시도하세요.',
      });
      return;
    }

    setPendingOrder(next);
    setBusy(true);
    setFailure(null);
    // X-3: 한 번의 RPC로 0..n-1을 다시 매긴다. 배열은 숨겨진 항목까지 포함한 전체다 (T-D10).
    const res = await reorderTodos(next);
    setBusy(false);
    if (!res.ok) {
      setPendingOrder(null); // 원위치
      setFailure({ message: res.error, code: res.code });
      return;
    }
    router.refresh();
  };

  const handleDelete = async (id: string): Promise<void> => {
    setBusy(true);
    setFailure(null);
    const res = await deleteTodo(id);
    setBusy(false);
    if (!res.ok) {
      setFailure({ message: res.error, code: res.code });
      return;
    }
    setDeletingId(null);
    router.refresh();
  };

  return (
    <section>
      <TodoQuickAdd busy={busy} onFailure={setFailure} onCreated={() => router.refresh()} />

      <TodoFilters
        mode={mode}
        projectId={projectId}
        order={order}
        projects={data.projects}
        totalCount={todos.length}
        visibleCount={visible.length}
        projectUnset={projectUnset}
        disabled={busy}
        onModeChange={(next) => {
          setMode(next);
          // 과제별을 벗어나면 선택을 비운다 — 다시 들어왔을 때 남은 선택이 건수를 헷갈리게 한다
          if (next !== 'project') setProjectId(undefined);
        }}
        onProjectChange={setProjectId}
        onOrderChange={setOrder}
      />

      {failure && (
        <ErrorBanner
          className="mt-4"
          message={failure.message}
          code={failure.code}
          onDismiss={() => setFailure(null)}
        />
      )}

      <TodoList
        todos={visible}
        todayISO={todayISO}
        dueSoonDays={data.dueSoonDays}
        projects={data.projects}
        // T-D9: 마감일·우선순위 정렬 중에는 드래그해도 결과가 보이지 않으므로 비활성
        dragEnabled={order === 'manual'}
        draggingId={draggingId}
        dropTarget={dropTarget}
        busy={busy}
        emptyMessage={projectUnset ? EMPTY_MESSAGES.open : EMPTY_MESSAGES[mode]}
        onFailure={setFailure}
        onRefresh={() => router.refresh()}
        onRequestDelete={setDeletingId}
        dragCallbacks={{
          onDragStart: setDraggingId,
          onDragEnd: clearDrag,
          onDragOverRow: (id, position) =>
            setDropTarget((prev) =>
              prev?.id === id && prev.position === position ? prev : { id, position }
            ),
          onDropRow: (id, position) => void handleDrop(id, position),
        }}
      />

      {deleting && (
        <Modal
          open
          title="할 일을 삭제합니다"
          onClose={() => setDeletingId(null)}
          closeOnBackdrop={false}
          footer={
            <>
              <Button size="sm" onClick={() => setDeletingId(null)} disabled={busy}>
                취소
              </Button>
              <Button
                size="sm"
                variant="danger"
                disabled={busy}
                onClick={() => void handleDelete(deleting.id)}
              >
                {busy ? '삭제 중…' : '삭제'}
              </Button>
            </>
          }
        >
          <p className="text-sm text-slate-700">
            <strong>{deleting.title}</strong>을(를) 삭제합니다. 되돌릴 수 없습니다.
          </p>
          <p className="mt-3 rounded-lg bg-amber-50 p-3 text-xs text-amber-800">
            To-Do는 팀 공유 목록입니다 (§7.13). 다른 팀원이 만든 할 일일 수 있습니다.
          </p>
        </Modal>
      )}
    </section>
  );
}
