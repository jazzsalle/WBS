'use client';

// To-Do 한 행 (SOT §7.13 "체크박스, 제목(인라인 편집), 과제 링크, 마감일, D-day 뱃지,
// 우선순위 뱃지, 삭제", T-D4·T-D8·T-D9, §8.4 O-1~O-3, §8.5 R-4)
//
//  - 체크박스는 toggleTodo — 사용자가 만진 필드가 done 하나뿐이라 낙관적 잠금을 생략한다(O-2).
//  - 제목·마감일·우선순위·과제는 updateTodo + expectedVersion(O-1). STALE이면 ConflictDialog를
//    띄우되 **편집기와 입력값을 그대로 둔다**(O-3) — 사용자가 친 글자를 날리지 않는다.
//  - 지연 판정(T-D4)은 lib/todos.ts의 todoDueState만 쓴다. 여기서 날짜를 비교하지 않는다.
//  - 오늘(todayISO)은 서버가 준 prop이다. new Date()를 부르지 않는다 (§7.13 서문).

import { useEffect, useRef, useState, type DragEvent } from 'react';
import Link from 'next/link';
import type { Priority, Todo } from '@/types';
import type { TodoProjectOption } from '@/actions/todos';
import type { DropPosition } from '@/lib/board';
import { toggleTodo, updateTodo } from '@/actions/todos';
import { formatDday } from '@/lib/dates';
import { todoDueState, type TodoDueState } from '@/lib/todos';
import { PRIORITY_LABELS } from '@/lib/constants';
import Badge, { type BadgeTone } from '@/components/ui/Badge';
import { PRIORITY_TONES } from '@/components/ui/priorityTone';
import ConflictDialog from '@/components/ui/ConflictDialog';
import { setRealtimePaused } from '@/components/RealtimeRefresher';
import type { Failure } from './TodoScreen';

// T-D4·부록 A.3: overdue 빨강 · dueSoon 주황 · 그 밖에는 색을 쓰지 않는다
const DUE_TONES: Record<TodoDueState, BadgeTone> = {
  overdue: 'red',
  dueSoon: 'amber',
  none: 'neutral',
};

// 과제가 지워졌는데 To-Do는 남은 경우(N-8 set null이 아니라 목록에서 빠진 경우).
// 조용히 '(과제 없음)'으로 보이면 사실이 바뀐다 — 이름을 못 찾았다는 것 자체를 보여준다.
const DELETED_PROJECT = '(삭제된 과제)';
const NO_PROJECT_LABEL = '(과제 없음)';

type EditField = 'title' | 'dueDate' | 'priority' | 'projectId';

const PRIORITIES: readonly Priority[] = ['high', 'normal', 'low'];

export interface TodoDragCallbacks {
  onDragStart: (id: string) => void;
  onDragEnd: () => void;
  onDragOverRow: (id: string, position: DropPosition) => void;
  onDropRow: (id: string, position: DropPosition) => void;
}

export interface TodoRowProps {
  todo: Todo;
  todayISO: string;
  dueSoonDays: number;
  projects: TodoProjectOption[];
  /** T-D9: 수동 정렬일 때만 드래그가 결과로 이어진다 */
  dragEnabled: boolean;
  dragging: boolean;
  dropPosition: DropPosition | null;
  busy: boolean;
  onFailure: (failure: Failure | null) => void;
  /** 저장·다시 불러오기 후 서버 컴포넌트를 다시 가져온다 (계산·최신 version의 출처는 서버다) */
  onRefresh: () => void;
  onRequestDelete: (id: string) => void;
  dragCallbacks: TodoDragCallbacks;
}

function positionFromPointer(e: DragEvent<HTMLElement>): DropPosition {
  const rect = e.currentTarget.getBoundingClientRect();
  const ratio = rect.height === 0 ? 0.5 : (e.clientY - rect.top) / rect.height;
  return ratio < 0.5 ? 'before' : 'after';
}

const CELL_BUTTON =
  'rounded-lg px-2 py-1 text-left text-xs text-grey-600 hover:bg-grey-100 disabled:cursor-not-allowed disabled:opacity-50';
const EDIT_INPUT =
  'rounded-lg border border-grey-400 px-2 py-1 text-sm focus:border-grey-600 focus:outline-none';

export default function TodoRow({
  todo,
  todayISO,
  dueSoonDays,
  projects,
  dragEnabled,
  dragging,
  dropPosition,
  busy,
  onFailure,
  onRefresh,
  onRequestDelete,
  dragCallbacks,
}: TodoRowProps) {
  const [editing, setEditing] = useState<EditField | null>(null);
  const [draft, setDraft] = useState('');
  const [saving, setSaving] = useState(false);
  const [conflict, setConflict] = useState<string | null>(null);
  // O-3: "다시 불러오기" 이후 최신 서버 값과 내 입력을 나란히 보여주기 위한 표시 스위치
  const [reloaded, setReloaded] = useState(false);
  // 완료 토글은 왕복을 기다리는 동안 체크가 움직이지 않으면 먹히지 않은 것처럼 보인다.
  // 미리 반영하고 실패하면 되돌린다 (절대 규칙 5).
  const [pendingDone, setPendingDone] = useState<boolean | null>(null);
  // Escape로 닫은 편집기의 blur가 저장으로 이어지면 취소가 취소되지 않는다
  const cancelledRef = useRef(false);

  // 서버가 이 행의 새 값을 내려주면 낙관적 표시는 역할이 끝났다 (그때가 진실이다)
  useEffect(() => {
    setPendingDone(null);
  }, [todo]);

  // R-4: 인라인 편집 중에는 자동 새로고침을 보류한다 — 치던 값이 날아가면 안 된다
  useEffect(() => {
    if (editing === null) return;
    setRealtimePaused(true);
    return () => setRealtimePaused(false);
  }, [editing]);

  const done = pendingDone ?? todo.done;
  const dueState = todoDueState({ done, dueDate: todo.dueDate }, todayISO, dueSoonDays);
  const disabled = busy || saving;

  const projectName = (id: string): string =>
    projects.find((p) => p.id === id)?.name ?? DELETED_PROJECT;
  const projectArchived = (id: string): boolean =>
    projects.find((p) => p.id === id)?.archived ?? false;

  const currentValue = (field: EditField): string => {
    switch (field) {
      case 'title':
        return todo.title;
      case 'dueDate':
        return todo.dueDate ?? '';
      case 'priority':
        return todo.priority;
      case 'projectId':
        return todo.projectId ?? '';
    }
  };

  const displayValue = (field: EditField, value: string): string => {
    switch (field) {
      case 'title':
        return value.trim() === '' ? '(빈 제목)' : value;
      case 'dueDate':
        return value === '' ? '마감 없음' : value;
      case 'priority':
        return PRIORITY_LABELS[value as Priority];
      case 'projectId':
        return value === '' ? NO_PROJECT_LABEL : projectName(value);
    }
  };

  const open = (field: EditField): void => {
    cancelledRef.current = false;
    setReloaded(false);
    setDraft(currentValue(field));
    setEditing(field);
  };

  const close = (): void => {
    setEditing(null);
    setReloaded(false);
    setConflict(null);
  };

  const cancel = (): void => {
    cancelledRef.current = true;
    close();
  };

  const save = async (field: EditField, value: string): Promise<void> => {
    const normalized = field === 'title' ? value.trim() : value;
    if (normalized === currentValue(field)) {
      close(); // 바뀐 게 없으면 version만 올리는 저장을 하지 않는다 (남의 편집을 STALE로 만든다)
      return;
    }

    let patch: Record<string, unknown>;
    switch (field) {
      case 'title':
        if (normalized === '') {
          // 서버도 다시 검증한다(§9). 여기서 막는 이유는 왕복 없이 즉시 알려주기 위해서다.
          onFailure({ message: '할 일을 입력하세요.', code: 'VALIDATION' });
          return;
        }
        patch = { title: normalized };
        break;
      case 'dueDate':
        patch = { dueDate: normalized === '' ? null : normalized };
        break;
      case 'priority':
        patch = { priority: normalized as Priority };
        break;
      case 'projectId':
        patch = { projectId: normalized === '' ? null : normalized };
        break;
    }

    setSaving(true);
    onFailure(null);
    // O-1: 마지막으로 읽은 version을 조건으로 건다
    const res = await updateTodo(todo.id, patch, todo.version);
    setSaving(false);

    if (!res.ok) {
      if (res.code === 'STALE') {
        // O-3: 배너가 아니라 선택 다이얼로그로 — 편집기와 입력값은 그대로 둔다
        setConflict(res.error);
        return;
      }
      onFailure({ message: res.error, code: res.code });
      return;
    }
    close();
    onRefresh();
  };

  const handleToggle = async (): Promise<void> => {
    setPendingDone(!done);
    setSaving(true);
    onFailure(null);
    // O-2: 사용자가 만진 필드가 done 하나뿐이라 낙관적 잠금을 생략한다 (completedAt은 파생 갱신)
    const res = await toggleTodo(todo.id);
    setSaving(false);
    if (!res.ok) {
      setPendingDone(null); // 원위치
      onFailure({ message: res.error, code: res.code });
      return;
    }
    onRefresh();
  };

  const handleBlur = (field: EditField): void => {
    if (cancelledRef.current) {
      cancelledRef.current = false;
      return;
    }
    void save(field, draft);
  };

  // O-3 비교: 다시 불러온 뒤 최신 서버 값과 내 입력이 다르면 둘을 나란히 보여준다
  const showComparison =
    editing !== null && reloaded && draft.trim() !== currentValue(editing).trim();

  return (
    <li
      onDragOver={(e) => {
        if (!dragEnabled) return;
        e.preventDefault(); // preventDefault를 해야 drop 이벤트가 발생한다
        e.dataTransfer.dropEffect = 'move';
        dragCallbacks.onDragOverRow(todo.id, positionFromPointer(e));
      }}
      onDrop={(e) => {
        if (!dragEnabled) return;
        e.preventDefault();
        dragCallbacks.onDropRow(todo.id, positionFromPointer(e));
      }}
      className={[
        'flex flex-wrap items-center gap-x-2 gap-y-1 rounded-xl border border-grey-200 bg-white px-2 py-1.5',
        dragging ? 'opacity-40' : 'hover:border-grey-300',
        // T-D8: 완료 항목은 `전체` 필터에서 흐린 스타일로 남는다
        done ? 'opacity-60' : '',
        dropPosition === 'before' ? 'shadow-[inset_0_2px_0_0_#2563eb]' : '',
        dropPosition === 'after' ? 'shadow-[inset_0_-2px_0_0_#2563eb]' : '',
      ].join(' ')}
    >
      {/* T-D9: 수동 정렬에서만 잡을 수 있다. 편집 중에는 잡히면 입력이 끊긴다 */}
      <span
        draggable={dragEnabled && !disabled && editing === null}
        onDragStart={(e) => {
          e.dataTransfer.effectAllowed = 'move';
          e.dataTransfer.setData('text/plain', todo.id);
          dragCallbacks.onDragStart(todo.id);
        }}
        onDragEnd={dragCallbacks.onDragEnd}
        aria-hidden={!dragEnabled}
        title={
          dragEnabled
            ? '끌어서 순서를 바꿉니다'
            : '수동 정렬일 때만 순서를 바꿀 수 있습니다 (T-D9)'
        }
        className={`select-none px-1 text-sm leading-none ${
          dragEnabled && !disabled ? 'cursor-grab text-grey-400' : 'cursor-not-allowed text-grey-200'
        }`}
      >
        ⠿
      </span>

      <input
        type="checkbox"
        checked={done}
        disabled={disabled}
        onChange={() => void handleToggle()}
        aria-label={`${todo.title} 완료`}
        className="h-4 w-4 shrink-0 rounded border-grey-300"
      />

      {/* 제목 — 인라인 편집 */}
      <div className="min-w-[12rem] flex-1">
        {editing === 'title' ? (
          <input
            value={draft}
            autoFocus
            maxLength={200}
            disabled={saving}
            aria-label="할 일 제목"
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void save('title', draft);
              if (e.key === 'Escape') cancel();
            }}
            onBlur={() => handleBlur('title')}
            className={`w-full ${EDIT_INPUT}`}
          />
        ) : (
          <button
            type="button"
            disabled={disabled}
            onClick={() => open('title')}
            title="눌러서 제목을 고칩니다"
            className={`w-full truncate rounded-lg px-2 py-1 text-left text-sm hover:bg-grey-100 disabled:cursor-not-allowed ${
              done ? 'text-grey-400 line-through' : 'text-grey-900'
            }`}
          >
            {todo.title}
          </button>
        )}
      </div>

      {/* 과제 — 링크 + 인라인 편집 (T-D6: 아카이브 과제도 고를 수 있다) */}
      <div className="flex min-w-[9rem] items-center gap-1">
        {editing === 'projectId' ? (
          <select
            value={draft}
            autoFocus
            disabled={saving}
            aria-label="과제"
            onChange={(e) => {
              setDraft(e.target.value);
              void save('projectId', e.target.value);
            }}
            onBlur={() => {
              if (!saving) cancel();
            }}
            onKeyDown={(e) => {
              if (e.key === 'Escape') cancel();
            }}
            className={`w-full bg-white text-xs ${EDIT_INPUT}`}
          >
            <option value="">{NO_PROJECT_LABEL}</option>
            {projects.map((project) => (
              <option key={project.id} value={project.id}>
                {project.archived ? `${project.name} (보관)` : project.name}
              </option>
            ))}
          </select>
        ) : (
          <>
            <button
              type="button"
              disabled={disabled}
              onClick={() => open('projectId')}
              title="눌러서 과제를 바꿉니다"
              className={`min-w-0 flex-1 truncate ${CELL_BUTTON} ${
                todo.projectId === null ? 'text-grey-300' : ''
              } ${todo.projectId !== null && projectArchived(todo.projectId) ? 'italic text-grey-400' : ''}`}
            >
              {todo.projectId === null ? NO_PROJECT_LABEL : projectName(todo.projectId)}
            </button>
            {todo.projectId !== null && (
              <Link
                href={`/projects/${todo.projectId}`}
                aria-label="과제 열기"
                title="과제 화면으로 이동"
                className="shrink-0 rounded px-1 text-xs text-grey-400 hover:text-blue-600"
              >
                ↗
              </Link>
            )}
          </>
        )}
      </div>

      {/* 마감일 + D-day 뱃지 */}
      <div className="flex min-w-[10rem] items-center gap-1">
        {editing === 'dueDate' ? (
          <input
            type="date"
            value={draft}
            autoFocus
            disabled={saving}
            aria-label="마감일"
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void save('dueDate', draft);
              if (e.key === 'Escape') cancel();
            }}
            onBlur={() => handleBlur('dueDate')}
            className={`w-36 ${EDIT_INPUT} text-xs`}
          />
        ) : (
          <>
            <button
              type="button"
              disabled={disabled}
              onClick={() => open('dueDate')}
              title="눌러서 마감일을 바꿉니다 (비우면 마감 없음)"
              className={`${CELL_BUTTON} tabular-nums ${
                todo.dueDate === null ? 'text-grey-300' : ''
              } ${dueState === 'overdue' ? 'font-semibold text-red-600' : ''} ${
                dueState === 'dueSoon' ? 'font-semibold text-orange-600' : ''
              }`}
            >
              {todo.dueDate ?? '마감 없음'}
            </button>
            {todo.dueDate !== null && (
              <Badge tone={DUE_TONES[dueState]} className="shrink-0 tabular-nums">
                {formatDday(todayISO, todo.dueDate)}
              </Badge>
            )}
          </>
        )}
      </div>

      {/* 우선순위 뱃지 (부록 A.3: high 빨강 · normal 파랑 · low 회색) */}
      <div className="min-w-[5rem]">
        {editing === 'priority' ? (
          <select
            value={draft}
            autoFocus
            disabled={saving}
            aria-label="우선순위"
            onChange={(e) => {
              setDraft(e.target.value);
              void save('priority', e.target.value);
            }}
            onBlur={() => {
              if (!saving) cancel();
            }}
            onKeyDown={(e) => {
              if (e.key === 'Escape') cancel();
            }}
            className={`w-full bg-white text-xs ${EDIT_INPUT}`}
          >
            {PRIORITIES.map((priority) => (
              <option key={priority} value={priority}>
                {PRIORITY_LABELS[priority]}
              </option>
            ))}
          </select>
        ) : (
          <button
            type="button"
            disabled={disabled}
            onClick={() => open('priority')}
            title="눌러서 우선순위를 바꿉니다"
            className="rounded-lg p-0.5 hover:bg-grey-100 disabled:cursor-not-allowed disabled:opacity-50"
          >
            <Badge tone={PRIORITY_TONES[todo.priority]}>{PRIORITY_LABELS[todo.priority]}</Badge>
          </button>
        )}
      </div>

      <button
        type="button"
        disabled={disabled}
        onClick={() => onRequestDelete(todo.id)}
        aria-label={`${todo.title} 삭제`}
        title="삭제"
        className="shrink-0 rounded-lg px-2 py-1 text-sm text-grey-300 hover:bg-red-50 hover:text-red-600 disabled:cursor-not-allowed disabled:opacity-50"
      >
        ×
      </button>

      {showComparison && editing !== null && (
        // O-3: 작업 내용을 날리지 않는다 — 최신 값과 내 입력을 나란히 두고 사용자가 고르게 한다
        <p className="w-full rounded-lg bg-orange-50 px-3 py-2 text-xs text-orange-800">
          최신 저장값: <strong>{displayValue(editing, currentValue(editing))}</strong> · 내 입력:{' '}
          <strong>{displayValue(editing, draft)}</strong> — 그대로 저장하려면 다시 저장하세요.
        </p>
      )}

      {conflict !== null && (
        <ConflictDialog
          message={conflict}
          onReload={() => {
            setConflict(null);
            setReloaded(true); // 새 값이 내려오면 위 비교 문구가 뜬다
            onRefresh(); // 이 행의 최신 version·값을 다시 받는다. 편집기와 입력값은 그대로 둔다
          }}
          onKeepEditing={() => setConflict(null)}
        />
      )}
    </li>
  );
}
