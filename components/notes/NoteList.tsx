'use client';

// 노트 목록 + 필터 (SOT §7.12 좌측 열)
//  - 목록: 고정(pinned) 상단 → 날짜 내림차순. 정렬·필터 판정은 전부 lib/notes.ts가 한다.
//  - 행: 유형 아이콘 / 제목 / 날짜 / 태그 (§7.12)
//  - 필터: 유형 · 연차 · 태그 · 전문 검색 (§7.12)
//  - 고정 토글은 사용자가 만지는 필드가 하나라 낙관적 잠금 없이 저장한다 (O-2).
// 쓰기는 부모(NoteScreen)가 actions/notes.ts를 거쳐 수행한다.

import type { Note, NoteType, Year } from '@/types';
import { NOTE_TYPE_LABELS } from '@/lib/constants';
import type { NoteFilter } from '@/lib/notes';

/** §7.12 "유형 아이콘". 라벨(부록 A)과 함께 쓰므로 아이콘만으로 뜻을 전하지는 않는다 */
export const NOTE_TYPE_ICONS: Record<NoteType, string> = {
  meeting: '🗣️',
  tech: '🔧',
  issue: '⚠️',
  idea: '💡',
  report_draft: '📄',
  other: '📝',
};

/** §5.5: name이 있으면 name, 없으면 order+1 + '차년도' */
function yearLabel(year: Year): string {
  return year.name.trim() || `${year.order + 1}차년도`;
}

export interface NoteListProps {
  /** 이미 필터·정렬이 끝난 목록 */
  notes: Note[];
  /** 필터 전 전체 건수 — "0건"이 필터 때문인지 데이터가 없어서인지 구분해 보여준다 */
  totalCount: number;
  years: Year[];
  tagOptions: string[];
  filter: NoteFilter;
  onFilterChange: (filter: NoteFilter) => void;
  selectedId: string | null;
  onSelect: (id: string) => void;
  onTogglePin: (id: string) => void;
  busy: boolean;
}

export default function NoteList({
  notes,
  totalCount,
  years,
  tagOptions,
  filter,
  onFilterChange,
  selectedId,
  onSelect,
  onTogglePin,
  busy,
}: NoteListProps) {
  const controlClass =
    'w-full rounded-lg border border-grey-300 bg-white px-2 py-1.5 text-xs focus:border-grey-500 focus:outline-none';

  return (
    <div className="flex min-h-0 flex-col rounded-xl border border-grey-200 bg-white">
      <div className="space-y-2 border-b border-grey-200 p-3">
        <label className="block">
          <span className="sr-only">노트 검색</span>
          <input
            type="search"
            value={filter.query ?? ''}
            onChange={(e) => onFilterChange({ ...filter, query: e.target.value })}
            placeholder="제목·본문·태그 전문 검색"
            className={controlClass}
          />
        </label>

        <div className="grid grid-cols-3 gap-2">
          <label>
            <span className="sr-only">유형 필터</span>
            <select
              value={filter.type ?? ''}
              onChange={(e) =>
                onFilterChange({ ...filter, type: e.target.value === '' ? null : (e.target.value as NoteType) })
              }
              className={controlClass}
            >
              <option value="">유형 전체</option>
              {(Object.keys(NOTE_TYPE_LABELS) as NoteType[]).map((type) => (
                <option key={type} value={type}>
                  {NOTE_TYPE_LABELS[type]}
                </option>
              ))}
            </select>
          </label>

          <label>
            <span className="sr-only">연차 필터</span>
            <select
              value={filter.yearId ?? ''}
              onChange={(e) =>
                onFilterChange({ ...filter, yearId: e.target.value === '' ? null : e.target.value })
              }
              className={controlClass}
            >
              <option value="">연차 전체</option>
              {years.map((year) => (
                <option key={year.id} value={year.id}>
                  {yearLabel(year)}
                </option>
              ))}
            </select>
          </label>

          <label>
            <span className="sr-only">태그 필터</span>
            <select
              value={filter.tag ?? ''}
              onChange={(e) =>
                onFilterChange({ ...filter, tag: e.target.value === '' ? null : e.target.value })
              }
              className={controlClass}
            >
              <option value="">태그 전체</option>
              {tagOptions.map((tag) => (
                <option key={tag} value={tag}>
                  {tag}
                </option>
              ))}
            </select>
          </label>
        </div>

        <p className="text-xs text-grey-500">
          {notes.length}건 표시 / 전체 {totalCount}건
        </p>
      </div>

      <ul className="min-h-0 flex-1 divide-y divide-grey-100 overflow-y-auto">
        {notes.length === 0 && (
          <li className="px-3 py-10 text-center text-xs text-grey-400">
            {totalCount === 0
              ? '등록된 노트가 없습니다. [새 노트]로 시작하세요.'
              : '조건에 맞는 노트가 없습니다. 필터를 바꿔 보세요.'}
          </li>
        )}

        {notes.map((note) => {
          const selected = note.id === selectedId;
          return (
            <li key={note.id} className={selected ? 'bg-grey-50' : undefined}>
              <div className="flex items-start gap-1 px-2 py-2">
                <button
                  type="button"
                  onClick={() => onTogglePin(note.id)}
                  disabled={busy}
                  aria-pressed={note.pinned}
                  aria-label={`${note.title} ${note.pinned ? '고정 해제' : '고정'}`}
                  title={note.pinned ? '고정 해제' : '목록 상단에 고정'}
                  className={`shrink-0 rounded px-1 text-sm leading-6 disabled:opacity-50 ${
                    note.pinned ? 'text-orange-500' : 'text-grey-300 hover:text-grey-500'
                  }`}
                >
                  ★
                </button>

                <button
                  type="button"
                  onClick={() => onSelect(note.id)}
                  aria-current={selected}
                  className="min-w-0 flex-1 text-left"
                >
                  <span className="flex items-center gap-1.5">
                    <span aria-hidden className="shrink-0">
                      {NOTE_TYPE_ICONS[note.type]}
                    </span>
                    <span
                      className={`truncate text-sm ${selected ? 'font-bold text-grey-900' : 'font-medium text-grey-700'}`}
                    >
                      {note.title}
                    </span>
                  </span>
                  <span className="mt-0.5 flex flex-wrap items-center gap-1.5 text-xs text-grey-500">
                    <span className="tabular-nums">{note.date}</span>
                    <span className="text-grey-400">{NOTE_TYPE_LABELS[note.type]}</span>
                    {(note.taskId !== null || note.milestoneId !== null) && (
                      <span className="text-grey-400" title="작업·마일스톤에 연결됨">
                        🔗
                      </span>
                    )}
                  </span>
                  {note.tags.length > 0 && (
                    <span className="mt-1 flex flex-wrap gap-1">
                      {note.tags.map((tag) => (
                        <span
                          key={tag}
                          className="rounded-full bg-grey-100 px-1.5 py-0.5 text-[11px] text-grey-600"
                        >
                          #{tag}
                        </span>
                      ))}
                    </span>
                  )}
                </button>
              </div>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
