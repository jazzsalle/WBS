'use client';

// 칸반 보드 본체 (SOT §7.6 보드 뷰)
// 컬럼 4개 고정 + 담당자별 그룹핑(스윔레인) 토글. 정렬은 order다 (PR-8) — 우선순위 정렬은
// 매트릭스 뷰와 대시보드에서만 한다.

import type { BoardCard } from '@/actions/board';
import type { Member, TaskStatus } from '@/types';
import { BOARD_COLUMNS } from '@/lib/board';
import Column, { type ColumnCallbacks } from './Column';
import type { CardCallbacks } from './Card';

/** 담당자 없음 레인의 키. 실제 member id와 겹치지 않게 uuid가 아닌 문자열을 쓴다 */
const NO_OWNER = 'none';
/** 스윔레인을 끈 상태의 단일 레인 키 */
export const SINGLE_LANE = 'all';

export interface KanbanCallbacks extends CardCallbacks {
  onDragOverColumn: (laneKey: string, status: TaskStatus) => void;
  onDropColumn: (laneKey: string, status: TaskStatus) => void;
  onDragLeaveColumn: () => void;
}

export interface KanbanBoardProps {
  /** 이미 걸러진 카드 (리프 전용/전체 토글 반영) */
  cards: BoardCard[];
  /** §7.6 담당자별 그룹핑 토글 */
  swimlanes: boolean;
  members: Member[];
  memberNames: Record<string, string>;
  orgNames: Record<string, string>;
  draggingId: string | null;
  dropCard: { id: string; position: 'before' | 'after' } | null;
  dropColumn: { laneKey: string; status: TaskStatus } | null;
  busy: boolean;
  callbacks: KanbanCallbacks;
}

interface Lane {
  key: string;
  label: string;
  cards: BoardCard[];
}

function buildLanes(
  cards: readonly BoardCard[],
  swimlanes: boolean,
  members: readonly Member[],
  memberNames: Record<string, string>
): Lane[] {
  if (!swimlanes) return [{ key: SINGLE_LANE, label: '', cards: [...cards] }];

  const byOwner = new Map<string, BoardCard[]>();
  for (const card of cards) {
    const key = card.ownerMemberId ?? NO_OWNER;
    const bucket = byOwner.get(key);
    if (bucket) bucket.push(card);
    else byOwner.set(key, [card]);
  }

  const lanes: Lane[] = [];
  for (const member of members) {
    const owned = byOwner.get(member.id);
    if (!owned) continue;
    byOwner.delete(member.id);
    lanes.push({ key: member.id, label: member.name, cards: owned });
  }
  // 인력 목록에 없는 id가 남으면 조용히 버리지 않는다 — 카드가 통째로 사라지면 안 된다
  for (const [key, owned] of byOwner) {
    if (key === NO_OWNER) continue;
    lanes.push({ key, label: memberNames[key] ?? '(삭제된 인력)', cards: owned });
  }
  const none = byOwner.get(NO_OWNER);
  if (none) lanes.push({ key: NO_OWNER, label: '담당자 미지정', cards: none });
  return lanes;
}

export default function KanbanBoard({
  cards,
  swimlanes,
  members,
  memberNames,
  orgNames,
  draggingId,
  dropCard,
  dropColumn,
  busy,
  callbacks,
}: KanbanBoardProps) {
  const lanes = buildLanes(cards, swimlanes, members, memberNames);

  if (lanes.length === 0) {
    return (
      <p className="rounded-xl border border-dashed border-grey-300 p-10 text-center text-sm text-grey-500">
        표시할 작업이 없습니다. 연차 필터나 표시 옵션을 바꿔 보세요.
      </p>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      {lanes.map((lane) => (
        <div key={lane.key}>
          {swimlanes && (
            <h2 className="mb-1.5 flex items-baseline gap-2 text-sm font-bold text-grey-700">
              {lane.label}
              <span className="text-xs font-normal text-grey-400">{lane.cards.length}건</span>
            </h2>
          )}
          <div className="flex gap-3 overflow-x-auto pb-1">
            {BOARD_COLUMNS.map((status) => {
              const columnCards = lane.cards
                .filter((card) => card.status === status)
                // PR-8: 컬럼 안 정렬은 order(트리 순서)다
                .sort((a, b) => a.sortIndex - b.sortIndex);
              const columnCallbacks: ColumnCallbacks = {
                ...callbacks,
                onDragOverColumn: (s) => callbacks.onDragOverColumn(lane.key, s),
                onDropColumn: (s) => callbacks.onDropColumn(lane.key, s),
              };
              return (
                <Column
                  key={status}
                  status={status}
                  cards={columnCards}
                  memberNames={memberNames}
                  orgNames={orgNames}
                  draggingId={draggingId}
                  dropCard={dropCard}
                  dropActive={dropColumn?.laneKey === lane.key && dropColumn.status === status}
                  busy={busy}
                  callbacks={columnCallbacks}
                />
              );
            })}
          </div>
        </div>
      ))}
    </div>
  );
}
