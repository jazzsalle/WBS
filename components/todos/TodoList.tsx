'use client';

// To-Do 목록 (SOT §7.13)
// 목록은 이미 lib/todos.ts가 거르고 정렬한 결과다 (T-D3) — 여기서 다시 거르거나 정렬하지 않는다.
// 드래그 상태는 부모(TodoScreen)가 들고 있다: 순서 재계산이 **숨겨진 항목까지 포함한 전체 순서**
// 위에서 일어나야 하는데(T-D10) 이 컴포넌트는 보이는 것만 알기 때문이다.

import type { Todo } from '@/types';
import type { TodoProjectOption } from '@/actions/todos';
import type { DropPosition } from '@/lib/board';
import TodoRow, { type TodoDragCallbacks } from './TodoRow';
import type { Failure } from './TodoScreen';

export interface TodoListProps {
  todos: Todo[];
  todayISO: string;
  dueSoonDays: number;
  projects: TodoProjectOption[];
  dragEnabled: boolean;
  draggingId: string | null;
  dropTarget: { id: string; position: DropPosition } | null;
  busy: boolean;
  emptyMessage: string;
  onFailure: (failure: Failure | null) => void;
  onRefresh: () => void;
  onRequestDelete: (id: string) => void;
  dragCallbacks: TodoDragCallbacks;
}

export default function TodoList({
  todos,
  todayISO,
  dueSoonDays,
  projects,
  dragEnabled,
  draggingId,
  dropTarget,
  busy,
  emptyMessage,
  onFailure,
  onRefresh,
  onRequestDelete,
  dragCallbacks,
}: TodoListProps) {
  if (todos.length === 0) {
    return (
      <p className="mt-4 rounded-xl border border-dashed border-slate-300 p-10 text-center text-sm text-slate-500">
        {emptyMessage}
      </p>
    );
  }

  return (
    <ul className="mt-4 space-y-1.5">
      {todos.map((todo) => (
        <TodoRow
          key={todo.id}
          todo={todo}
          todayISO={todayISO}
          dueSoonDays={dueSoonDays}
          projects={projects}
          dragEnabled={dragEnabled}
          dragging={draggingId === todo.id}
          dropPosition={dropTarget?.id === todo.id ? dropTarget.position : null}
          busy={busy}
          onFailure={onFailure}
          onRefresh={onRefresh}
          onRequestDelete={onRequestDelete}
          dragCallbacks={dragCallbacks}
        />
      ))}
    </ul>
  );
}
