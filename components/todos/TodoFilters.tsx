'use client';

// To-Do 필터·정렬 막대 (SOT §7.13 T-D1·T-D5·T-D6·T-D7·T-D9)
// 여기는 선택만 한다 — 거르고 정렬하는 일은 lib/todos.ts가 한다 (T-D3).
// 라벨은 이 화면 전용 UI 문구다. 도메인 enum 라벨(우선순위 등)은 lib/constants.ts가 원본이다.

import type { TodoProjectOption } from '@/actions/todos';
import type { TodoFilterMode, TodoSortOrder } from '@/lib/todos';

const FILTER_LABELS: Record<TodoFilterMode, string> = {
  all: '전체',
  open: '미완료',
  today: '오늘',
  project: '과제별',
};

const FILTER_HINTS: Record<TodoFilterMode, string> = {
  all: '완료한 할 일도 함께 봅니다 (T-D8)',
  open: '완료하지 않은 할 일만 봅니다',
  today: '오늘까지 마감인 미완료 할 일 — 지난 마감을 포함합니다 (T-D2)',
  project: '과제 하나를 골라 봅니다. "(과제 없음)"도 고를 수 있습니다 (T-D5)',
};

const SORT_LABELS: Record<TodoSortOrder, string> = {
  manual: '수동',
  due: '마감일',
  priority: '우선순위',
};

const SORT_HINTS: Record<TodoSortOrder, string> = {
  manual: '드래그로 정한 순서입니다',
  due: '마감일 빠른 순 — 마감일 없는 할 일은 뒤로 갑니다 (T-D7)',
  priority: '높음 → 보통 → 낮음 → 마감일 순 (T-D7)',
};

const FILTER_MODES: readonly TodoFilterMode[] = ['all', 'open', 'today', 'project'];
const SORT_ORDERS: readonly TodoSortOrder[] = ['manual', 'due', 'priority'];

// 과제 선택 <select>의 값 인코딩. 빈 문자열은 "아직 안 골랐다"(undefined)이고,
// NO_PROJECT는 T-D5의 고를 수 있는 값 null("과제 없음")이다 — 둘은 다르다.
const UNSET = '';
const NO_PROJECT = '__none__';

function encodeProject(projectId: string | null | undefined): string {
  if (projectId === undefined) return UNSET;
  return projectId === null ? NO_PROJECT : projectId;
}

function decodeProject(value: string): string | null | undefined {
  if (value === UNSET) return undefined;
  return value === NO_PROJECT ? null : value;
}

export interface TodoFiltersProps {
  mode: TodoFilterMode;
  projectId: string | null | undefined;
  order: TodoSortOrder;
  /** T-D6: 아카이브 과제도 목록에 있다 — 흐리게 구분해 보여주되 감추지 않는다 */
  projects: TodoProjectOption[];
  totalCount: number;
  visibleCount: number;
  /** 과제별을 골랐지만 아직 과제를 안 정한 상태 (미완료 목록을 대신 보여준다) */
  projectUnset: boolean;
  disabled: boolean;
  onModeChange: (mode: TodoFilterMode) => void;
  onProjectChange: (projectId: string | null | undefined) => void;
  onOrderChange: (order: TodoSortOrder) => void;
}

const TAB_BASE = 'rounded-lg px-3 py-1.5 text-sm font-semibold transition disabled:opacity-50';
const TAB_ON = 'bg-slate-900 text-white';
const TAB_OFF = 'border border-slate-300 bg-white text-slate-700 hover:bg-slate-50';

export default function TodoFilters({
  mode,
  projectId,
  order,
  projects,
  totalCount,
  visibleCount,
  projectUnset,
  disabled,
  onModeChange,
  onProjectChange,
  onOrderChange,
}: TodoFiltersProps) {
  return (
    <div className="mt-4 rounded-xl border border-slate-200 bg-white p-3">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-3">
        <div className="flex flex-wrap items-center gap-2" role="tablist" aria-label="필터">
          {FILTER_MODES.map((value) => (
            <button
              key={value}
              type="button"
              role="tab"
              aria-selected={mode === value}
              disabled={disabled}
              title={FILTER_HINTS[value]}
              onClick={() => onModeChange(value)}
              className={`${TAB_BASE} ${mode === value ? TAB_ON : TAB_OFF}`}
            >
              {FILTER_LABELS[value]}
            </button>
          ))}

          {mode === 'project' && (
            <select
              value={encodeProject(projectId)}
              disabled={disabled}
              aria-label="과제 선택"
              onChange={(e) => onProjectChange(decodeProject(e.target.value))}
              className="rounded-lg border border-slate-300 bg-white px-2.5 py-1.5 text-sm focus:border-slate-500 focus:outline-none disabled:opacity-50"
            >
              <option value={UNSET}>과제를 고르세요…</option>
              {/* T-D5: 과제에 걸리지 않은 할 일도 하나의 선택지다 */}
              <option value={NO_PROJECT}>(과제 없음)</option>
              {projects.map((project) => (
                <option key={project.id} value={project.id}>
                  {project.archived ? `${project.name} (보관)` : project.name}
                </option>
              ))}
            </select>
          )}
        </div>

        <div className="flex flex-wrap items-center gap-2" role="tablist" aria-label="정렬">
          <span className="text-xs font-semibold text-slate-400">정렬</span>
          {SORT_ORDERS.map((value) => (
            <button
              key={value}
              type="button"
              role="tab"
              aria-selected={order === value}
              disabled={disabled}
              title={SORT_HINTS[value]}
              onClick={() => onOrderChange(value)}
              className={`${TAB_BASE} ${order === value ? TAB_ON : TAB_OFF}`}
            >
              {SORT_LABELS[value]}
            </button>
          ))}
        </div>

        <p className="ml-auto text-xs text-slate-500 tabular-nums">
          전체 {totalCount}건 · 표시 {visibleCount}건
        </p>
      </div>

      {projectUnset && (
        <p role="status" className="mt-3 rounded-lg bg-slate-50 p-2.5 text-xs text-slate-600">
          과제를 고르기 전까지는 <strong>미완료</strong> 목록을 보여줍니다.
        </p>
      )}

      {order !== 'manual' && (
        // T-D9: 여기서 드래그하면 결과가 보이지 않으므로 왜 잠갔는지 밝힌다
        <p className="mt-3 rounded-lg bg-slate-50 p-2.5 text-xs text-slate-600">
          <strong>{SORT_LABELS[order]}</strong> 정렬 중에는 드래그로 순서를 바꿀 수 없습니다.
          순서를 바꾸려면 <strong>수동</strong> 정렬로 되돌리세요.
        </p>
      )}
    </div>
  );
}
