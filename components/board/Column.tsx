'use client';

// 칸반 컬럼 (SOT §7.6 "컬럼 4개 고정: todo / in_progress / done / blocked")
// 컬럼 사이 드롭 = status 변경, 컬럼 안 카드 위 드롭 = order 변경. 실제 저장은 BoardScreen이 한다.
// 컬럼 안 정렬은 order다 — 우선순위로 재정렬하지 않는다 (PR-8).

import type { BoardCard } from '@/actions/board';
import type { TaskStatus } from '@/types';
import { TASK_STATUS_LABELS } from '@/lib/constants';
import Card, { type CardCallbacks } from './Card';

const HEADER_CLASSES: Record<TaskStatus, string> = {
  todo: 'border-slate-200 bg-slate-50 text-slate-600',
  in_progress: 'border-blue-200 bg-blue-50 text-blue-700',
  done: 'border-emerald-200 bg-emerald-50 text-emerald-700',
  blocked: 'border-rose-200 bg-rose-50 text-rose-700',
};

export interface ColumnCallbacks extends CardCallbacks {
  onDragOverColumn: (status: TaskStatus) => void;
  onDropColumn: (status: TaskStatus) => void;
  onDragLeaveColumn: () => void;
}

export interface ColumnProps {
  status: TaskStatus;
  cards: BoardCard[];
  memberNames: Record<string, string>;
  orgNames: Record<string, string>;
  draggingId: string | null;
  /** 카드 사이 삽입 표시 */
  dropCard: { id: string; position: 'before' | 'after' } | null;
  /** 컬럼 자체가 드롭 대상일 때 */
  dropActive: boolean;
  busy: boolean;
  callbacks: ColumnCallbacks;
}

export default function Column({
  status,
  cards,
  memberNames,
  orgNames,
  draggingId,
  dropCard,
  dropActive,
  busy,
  callbacks,
}: ColumnProps) {
  return (
    <section
      aria-label={`${TASK_STATUS_LABELS[status]} 컬럼`}
      onDragOver={(e) => {
        e.preventDefault();
        e.dataTransfer.dropEffect = 'move';
        callbacks.onDragOverColumn(status);
      }}
      onDragLeave={callbacks.onDragLeaveColumn}
      onDrop={(e) => {
        e.preventDefault();
        callbacks.onDropColumn(status);
      }}
      className={`flex min-w-56 flex-1 flex-col rounded-xl border bg-slate-50/60 p-2 transition ${
        dropActive ? 'border-blue-400 ring-2 ring-blue-300' : 'border-slate-200'
      }`}
    >
      <h3
        className={`mb-2 flex items-center justify-between rounded-lg border px-2 py-1 text-xs font-bold ${HEADER_CLASSES[status]}`}
      >
        <span>{TASK_STATUS_LABELS[status]}</span>
        <span className="tabular-nums">{cards.length}</span>
      </h3>

      <div className="flex min-h-16 flex-col gap-2">
        {cards.length === 0 ? (
          <p className="rounded-lg border border-dashed border-slate-200 p-3 text-center text-[11px] text-slate-400">
            여기로 카드를 끌어오면 상태가 바뀝니다
          </p>
        ) : (
          cards.map((card) => (
            <Card
              key={card.id}
              card={card}
              memberNames={memberNames}
              orgNames={orgNames}
              dragging={draggingId === card.id}
              dropPosition={dropCard?.id === card.id ? dropCard.position : null}
              busy={busy}
              callbacks={callbacks}
            />
          ))
        )}
      </div>
    </section>
  );
}
