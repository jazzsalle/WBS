// 역참조 노트 목록 (SOT §7.12 "연결되면 해당 화면에서 역참조로 보인다")
// Task 상세 패널(§7.4)과 마일스톤 목록(§7.8)이 함께 쓴다. 여기서는 목록만 그린다 —
// 노트 편집은 노트 화면에서만 한다(§5.14 연결은 Note 쪽 단방향 참조라 편집 주체가 하나다).

import Link from 'next/link';
import type { LinkedNote } from '@/actions/notes';
import { NOTE_TYPE_LABELS } from '@/lib/constants';
import { NOTE_TYPE_ICONS } from './NoteList';

export interface LinkedNoteListProps {
  notes: LinkedNote[];
  projectId: string;
  /** 연결된 노트가 없을 때 보여줄 안내 */
  emptyText: string;
  className?: string;
}

export default function LinkedNoteList({
  notes,
  projectId,
  emptyText,
  className = '',
}: LinkedNoteListProps) {
  if (notes.length === 0) {
    return <p className={`text-xs text-slate-500 ${className}`}>{emptyText}</p>;
  }

  return (
    <ul className={`space-y-1 ${className}`}>
      {notes.map((note) => (
        <li key={note.id}>
          <Link
            // 노트 화면이 이 id를 초기 선택으로 받는다 — 목록에서 다시 찾지 않게
            href={`/projects/${projectId}/notes?note=${note.id}`}
            className="flex items-center gap-1.5 rounded-lg border border-slate-200 px-2 py-1.5 text-xs text-slate-700 hover:bg-slate-50"
          >
            <span aria-hidden className="shrink-0">
              {NOTE_TYPE_ICONS[note.type]}
            </span>
            <span className="min-w-0 flex-1 truncate font-medium">{note.title}</span>
            <span className="shrink-0 text-slate-400">{NOTE_TYPE_LABELS[note.type]}</span>
            <span className="shrink-0 tabular-nums text-slate-400">{note.date}</span>
          </Link>
        </li>
      ))}
    </ul>
  );
}
