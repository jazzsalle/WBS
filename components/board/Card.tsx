'use client';

// 칸반 카드 (SOT §7.6 "카드: 작업명, WBS 코드, 진척률, 마감일, 담당자 아바타, 기관, 태그")
// 파생 값(진척률·우선순위 점수·등급·긴급도)은 서버가 계산해 내려준 값을 표시만 한다 (PR-7, O-4).
// 담당·기관 이름은 부모가 내려준 사전으로만 푼다 — 카드마다 조회하지 않는다.

import type { DragEvent } from 'react';
import type { BoardCard } from '@/actions/board';
import type { DropPosition } from '@/lib/board';
import Badge from '@/components/ui/Badge';
import { priorityColorClasses } from './priority-colors';

// 배정은 남아 있는데 인력·기관이 지워진 경우. 조용히 '—'로 만들면 "배정이 없다"로 읽혀
// 사실이 바뀐다 — 이름을 못 찾았다는 것 자체를 보여준다 (절대 규칙 5). WBS 트리와 같은 문구.
const DELETED_MEMBER = '(삭제된 인력)';
const DELETED_ORG = '(삭제된 기관)';

export interface CardCallbacks {
  onDragStart: (id: string) => void;
  onDragEnd: () => void;
  onDragOverCard: (id: string, position: DropPosition) => void;
  onDropCard: (id: string, position: DropPosition) => void;
}

export interface CardProps {
  card: BoardCard;
  memberNames: Record<string, string>;
  orgNames: Record<string, string>;
  dragging: boolean;
  dropPosition: DropPosition | null;
  busy: boolean;
  callbacks: CardCallbacks;
}

function nameOf(id: string, dict: Record<string, string>, missing: string): string {
  return dict[id] ?? missing;
}

function positionFromPointer(e: DragEvent<HTMLElement>): DropPosition {
  const rect = e.currentTarget.getBoundingClientRect();
  const ratio = rect.height === 0 ? 0.5 : (e.clientY - rect.top) / rect.height;
  return ratio < 0.5 ? 'before' : 'after';
}

export default function Card({
  card,
  memberNames,
  orgNames,
  dragging,
  dropPosition,
  busy,
  callbacks,
}: CardProps) {
  const colors = priorityColorClasses(card.colorToken);
  const done = card.status === 'done';

  const ownerName =
    card.ownerMemberId === null ? null : nameOf(card.ownerMemberId, memberNames, DELETED_MEMBER);
  const extraMemberIds = card.memberIds.filter((id) => id !== card.ownerMemberId);
  const extraMemberNames = extraMemberIds.map((id) => nameOf(id, memberNames, DELETED_MEMBER));
  const orgName = card.orgId === null ? null : nameOf(card.orgId, orgNames, DELETED_ORG);
  const progress = Math.max(0, Math.min(100, Math.round(card.progress)));

  return (
    <article
      draggable={!busy}
      aria-label={`${card.wbsCode} ${card.title}`}
      onDragStart={(e) => {
        e.dataTransfer.effectAllowed = 'move';
        e.dataTransfer.setData('text/plain', card.id);
        callbacks.onDragStart(card.id);
      }}
      onDragEnd={callbacks.onDragEnd}
      onDragOver={(e) => {
        e.preventDefault(); // preventDefault를 해야 drop 이벤트가 발생한다
        e.stopPropagation(); // 카드 위에서는 삽입 위치만 보여준다 (컬럼 전체 강조와 겹치지 않게)
        e.dataTransfer.dropEffect = 'move';
        callbacks.onDragOverCard(card.id, positionFromPointer(e));
      }}
      onDrop={(e) => {
        e.preventDefault();
        e.stopPropagation(); // 컬럼(상태 변경) 드롭과 겹치지 않게 카드 드롭이 이긴다
        callbacks.onDropCard(card.id, positionFromPointer(e));
      }}
      className={[
        'relative flex gap-2 rounded-lg border border-grey-200 bg-white p-2 pl-3 text-xs shadow-sm',
        busy ? '' : 'cursor-grab',
        dragging ? 'opacity-40' : 'hover:border-grey-300',
        // PR-6: 완료 작업은 우선순위 표시를 흐리게 한다
        done ? 'opacity-60' : '',
        // PR-5: 막힌 작업은 점수와 무관하게 주의 대상이다
        card.status === 'blocked' ? 'border-red-300' : '',
        dropPosition === 'before' ? 'shadow-[inset_0_2px_0_0_#2563eb]' : '',
        dropPosition === 'after' ? 'shadow-[inset_0_-2px_0_0_#2563eb]' : '',
      ].join(' ')}
    >
      {/* §7.6 카드 좌측 우선순위 등급 색 띠 */}
      <span
        aria-hidden
        title={`중요도 ${card.importance} × 긴급도 ${card.urgency} = ${card.score} (${card.grade})`}
        className={`absolute top-1.5 bottom-1.5 left-1 w-1 rounded-full ${colors.band} ${
          done ? 'opacity-50' : ''
        }`}
      />

      <div className="min-w-0 flex-1">
        <div className="flex items-baseline gap-1.5">
          <span className="shrink-0 font-mono text-[10px] text-grey-400">{card.wbsCode}</span>
          {card.urgencyPinned && (
            // PR-4: 긴급도 고정은 마감일이 바뀌어도 값이 변하지 않는다는 뜻이다
            <span aria-label="긴급도 고정" title="긴급도 고정(수동)" className="shrink-0 text-[10px]">
              📌
            </span>
          )}
          {!card.isLeaf && (
            <Badge className="shrink-0" title="하위 작업이 있는 묶음 작업입니다">
              묶음
            </Badge>
          )}
        </div>

        <p
          title={card.title}
          className={`mt-0.5 truncate font-semibold ${done ? 'text-grey-400 line-through' : 'text-grey-800'}`}
        >
          {card.title}
        </p>

        <div className="mt-1.5 flex items-center gap-1.5">
          <span
            role="progressbar"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={progress}
            aria-label="진척률"
            className="h-1.5 w-full overflow-hidden rounded-full bg-grey-100"
          >
            <span className="block h-full rounded-full bg-blue-500" style={{ width: `${progress}%` }} />
          </span>
          <span className="shrink-0 tabular-nums text-grey-500">{progress}%</span>
        </div>

        <div className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-grey-500">
          <span className={card.overdue ? 'font-semibold text-red-600' : ''}>
            {card.dueDate === null ? (
              <span className="text-grey-300">마감 없음</span>
            ) : (
              <span title={card.overdue ? '마감일이 지났습니다' : undefined}>
                {card.dueDate} ({card.dday})
              </span>
            )}
          </span>

          <span className="truncate" title={ownerName ?? '담당자 미지정'}>
            {ownerName ?? <span className="text-grey-300">담당 미지정</span>}
          </span>
          {extraMemberNames.length > 0 && (
            <Badge title={`참여 담당자: ${extraMemberNames.join(', ')}`}>
              +{extraMemberNames.length}
            </Badge>
          )}

          {orgName !== null && (
            <span className="truncate text-grey-400" title={orgName}>
              {orgName}
            </span>
          )}
        </div>

        {card.tags.length > 0 && (
          <div className="mt-1 flex flex-wrap gap-1">
            {card.tags.map((tag) => (
              <Badge key={tag} tone="violet">
                #{tag}
              </Badge>
            ))}
          </div>
        )}
      </div>
    </article>
  );
}
