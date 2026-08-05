'use client';

// 칸반 보드 · 우선순위 매트릭스 화면 컨테이너 (SOT §7.6, §6.9, §8.4 O-2, §8.5 R-4)
//
//  - 데이터는 전부 서버(page.tsx → actions/board.ts)가 계산해 내려준다. 진척률·우선순위 점수·
//    긴급도를 여기서 다시 계산하거나 저장하지 않는다 (PR-7, O-4).
//  - 쓰기는 이미 있는 actions/tasks.ts 액션만 부른다: setTaskStatus(P-1), reorderTasks(X-3),
//    setTaskPriority(PR-1·PR-2), setTaskUrgency(PR-4). supabase를 직접 부르지 않는다 (§8.2 C-2).
//  - 컬럼 안 정렬은 order다 (PR-8). 우선순위 정렬은 매트릭스 뷰에서만 한다.
//  - 드래그 저장이 실패하면 카드를 원위치로 되돌리고 실패를 배너로 남긴다 (절대 규칙 5).
//  - 드래그 중에는 남의 변경으로 화면이 다시 그려지지 않게 실시간 새로고침을 멈춘다 (R-4).

import { useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import type { Member, Organization, Stage, TaskStatus, Year } from '@/types';
import type { ActionErrorCode } from '@/lib/db/errors';
import type {
  BoardCard,
  BoardData,
  PriorityMatrixData,
  PriorityMatrixItem,
} from '@/actions/board';
import { reorderTasks, setTaskPriority, setTaskStatus, setTaskUrgency } from '@/actions/tasks';
import { BOARD_ALL_YEARS, containerKey, reorderIds, type DropPosition } from '@/lib/board';
import { setRealtimePaused } from '@/components/RealtimeRefresher';
import ErrorBanner from '@/components/ui/ErrorBanner';
import type { Matrix5x5Selection } from '@/components/ui/Matrix5x5';
import ViewToggle, { type BoardView } from './ViewToggle';
import KanbanBoard, { type KanbanCallbacks } from './KanbanBoard';
import PriorityMatrix from './PriorityMatrix';

type Failure = { message: string; code?: ActionErrorCode };

export interface BoardScreenProps {
  board: BoardData;
  matrix: PriorityMatrixData;
  members: Member[];
  organizations: Organization[];
}

/** §5.5: name이 있으면 name, 없으면 order+1 + '차년도' */
function yearLabel(year: Year): string {
  return year.name.trim() || `${year.order + 1}차년도`;
}

function stageLabel(stage: Stage): string {
  return stage.name.trim() || `${stage.order + 1}단계`;
}

export default function BoardScreen({ board, matrix, members, organizations }: BoardScreenProps) {
  const router = useRouter();

  const [view, setView] = useState<BoardView>('board');
  const [leafOnly, setLeafOnly] = useState(true); // §7.6 기본은 리프 Task만
  const [swimlanes, setSwimlanes] = useState(false);
  const [showDone, setShowDone] = useState(false); // 매트릭스: 완료 기본 숨김 (PR-6)
  const [selectedCell, setSelectedCell] = useState<Matrix5x5Selection | null>(null);

  const [draggingId, setDraggingId] = useState<string | null>(null);
  const [dropCard, setDropCard] = useState<{ id: string; position: DropPosition } | null>(null);
  const [dropColumn, setDropColumn] = useState<{ laneKey: string; status: TaskStatus } | null>(null);
  const [dropCell, setDropCell] = useState<Matrix5x5Selection | null>(null);

  // 드롭 직후 서버 응답을 기다리는 동안 카드가 제자리에 남아 있으면 조작이 먹히지 않은 것처럼
  // 보인다. 상태 변경만 미리 반영하고, 실패하면 지워 원위치로 되돌린다.
  const [optimisticStatus, setOptimisticStatus] = useState<Record<string, TaskStatus>>({});

  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<Failure | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

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

  const cardById = useMemo(
    () => new Map(board.cards.map((card) => [card.id, card])),
    [board.cards]
  );
  const containerByKey = useMemo(
    () => new Map(board.containers.map((c) => [c.key, c])),
    [board.containers]
  );

  // 서버가 새 데이터를 내려주면 낙관적 표시는 역할이 끝났다 (그때가 진실이다)
  useEffect(() => {
    setOptimisticStatus({});
  }, [board]);

  // R-4: 드래그하는 동안 화면이 다시 그려지면 잡고 있던 카드가 사라진다
  const dragging = draggingId !== null;
  useEffect(() => {
    if (!dragging) return;
    setRealtimePaused(true);
    return () => setRealtimePaused(false);
  }, [dragging]);

  const visibleCards = useMemo(
    () =>
      board.cards
        .filter((card) => !leafOnly || card.isLeaf) // §7.6 토글로 전체 표시
        .map((card) => {
          const pending = optimisticStatus[card.id];
          return pending === undefined ? card : { ...card, status: pending };
        }),
    [board.cards, leafOnly, optimisticStatus]
  );

  const clearDrag = (): void => {
    setDraggingId(null);
    setDropCard(null);
    setDropColumn(null);
    setDropCell(null);
  };

  const goYear = (value: string): void => {
    router.push(`/projects/${board.projectId}/board?yearId=${value}`);
  };

  // ─── 보드: 컬럼 간 드래그 → status 변경 (P-1 적용) ─────────────

  const applyStatus = async (card: BoardCard, status: TaskStatus): Promise<void> => {
    setOptimisticStatus((prev) => ({ ...prev, [card.id]: status }));
    setBusy(true);
    setFailure(null);
    // O-2: 상태 변경은 사용자가 만지는 필드가 하나뿐이라 낙관적 잠금을 생략한다
    const res = await setTaskStatus(card.id, status);
    setBusy(false);

    if (!res.ok) {
      // 원위치로 되돌리고 실패를 남긴다 — 조용히 되돌리지 않는다 (절대 규칙 5)
      setOptimisticStatus((prev) => {
        const next = { ...prev };
        delete next[card.id];
        return next;
      });
      setFailure({ message: res.error, code: res.code });
      return;
    }
    // P-1: done으로 옮기면 리프 진척률 100은 서버 계산이 강제한다. 새로 읽어 카드에 반영한다.
    router.refresh();
  };

  // ─── 보드: 컬럼 내 드래그 → order 변경 ─────────────────────────

  const applyReorder = async (
    card: BoardCard,
    target: BoardCard,
    position: DropPosition
  ): Promise<void> => {
    // X-3: reorderTasks는 (yearId, parentId) 컨테이너의 자식 **전체**를 요구한다.
    // 다른 컨테이너의 카드 사이로 끌면 계층을 바꾸는 조작이 되므로 여기서 하지 않는다.
    if (target.yearId !== card.yearId || target.parentId !== card.parentId) {
      setFailure({
        message:
          '같은 상위 작업 안에서만 순서를 바꿀 수 있습니다. 계층을 옮기려면 WBS 트리에서 끌어 놓으세요.',
        code: 'RULE',
      });
      return;
    }

    const container = containerByKey.get(containerKey(card.yearId, card.parentId));
    const next =
      container === undefined
        ? null
        : reorderIds(container.taskIds, card.id, target.id, position);
    if (container === undefined || next === null) {
      setFailure({ message: '순서를 계산하지 못했습니다. 화면을 새로고침한 뒤 다시 시도하세요.' });
      return;
    }

    setBusy(true);
    setFailure(null);
    const res = await reorderTasks(card.yearId, card.parentId, next);
    setBusy(false);
    if (!res.ok) {
      setFailure({ message: res.error, code: res.code });
      return;
    }
    router.refresh();
  };

  const handleDropColumn = (_laneKey: string, status: TaskStatus): void => {
    const card = draggingId === null ? null : (cardById.get(draggingId) ?? null);
    clearDrag();
    if (card === null) {
      if (draggingId !== null) {
        setFailure({ message: '옮기려는 작업이 더 이상 없습니다. 다른 사람이 삭제했을 수 있습니다.' });
      }
      return;
    }
    if (card.status === status) return; // 같은 컬럼 안이면 순서 드롭에서 처리한다
    void applyStatus(card, status);
  };

  const handleDropCard = (targetId: string, position: DropPosition): void => {
    const card = draggingId === null ? null : (cardById.get(draggingId) ?? null);
    const target = cardById.get(targetId) ?? null;
    clearDrag();
    if (card === null || target === null) {
      setFailure({ message: '옮기려는 작업이 더 이상 없습니다. 화면을 새로고침하세요.' });
      return;
    }
    if (card.id === target.id) return;

    if (card.status !== target.status) {
      void applyStatus(card, target.status);
      return;
    }
    void applyReorder(card, target, position);
  };

  const kanbanCallbacks: KanbanCallbacks = {
    onDragStart: (id) => setDraggingId(id),
    onDragEnd: clearDrag,
    onDragOverCard: (id, position) => {
      setDropColumn(null); // 카드 위에서는 삽입 위치 표시가 이긴다
      setDropCard((prev) =>
        prev?.id === id && prev.position === position ? prev : { id, position }
      );
    },
    onDropCard: handleDropCard,
    onDragOverColumn: (laneKey, status) => {
      setDropCard(null);
      setDropColumn((prev) =>
        prev?.laneKey === laneKey && prev.status === status ? prev : { laneKey, status }
      );
    },
    onDragLeaveColumn: () => setDropColumn(null),
    onDropColumn: handleDropColumn,
  };

  // ─── 매트릭스: 셀 드롭 → 중요도 변경 (긴급도는 고정 모드일 때만) ─

  const handleCellDrop = async (selection: Matrix5x5Selection): Promise<void> => {
    const item = draggingId === null ? null : (matrix.items.find((i) => i.id === draggingId) ?? null);
    clearDrag();
    if (item === null) {
      if (draggingId !== null) {
        setFailure({ message: '옮기려는 작업이 더 이상 없습니다. 화면을 새로고침하세요.' });
      }
      return;
    }

    const changes: string[] = [];
    let saved = false;
    setBusy(true);
    setFailure(null);
    setNotice(null);

    try {
      // PR-1·PR-2: 중요도만 사람이 정한다. 이 작업 한 행만 바뀐다(롤업 없음).
      if (item.importance !== selection.y) {
        const res = await setTaskPriority(item.id, selection.y);
        if (!res.ok) {
          setFailure({ message: res.error, code: res.code });
          return;
        }
        saved = true;
        changes.push(`중요도 ${item.importance} → ${selection.y}`);
      }

      if (selection.x !== item.urgency) {
        if (item.urgencyPinned) {
          // PR-4: 고정된 작업만 드래그로 긴급도를 바꾼다
          const res = await setTaskUrgency(item.id, 'manual', selection.x);
          if (!res.ok) {
            setFailure({ message: res.error, code: res.code });
            return;
          }
          saved = true;
          changes.push(`긴급도 ${item.urgency} → ${selection.x} (고정)`);
        } else {
          // 조용히 무시하지 않는다 — 왜 안 바뀌었는지 알려 준다
          changes.push(
            '긴급도는 마감일에서 자동 계산되므로 바꾸지 않았습니다. 📌로 고정하면 바꿀 수 있습니다'
          );
        }
      }
    } finally {
      setBusy(false);
      if (saved) router.refresh();
    }

    if (changes.length > 0) setNotice(`${item.title}: ${changes.join(' · ')}`);
  };

  const handleTogglePin = async (item: PriorityMatrixItem): Promise<void> => {
    setBusy(true);
    setFailure(null);
    // PR-4: 고정할 때는 지금 계산된 긴급도를 그대로 굳힌다 — 임의의 기본값을 넣지 않는다
    const res = item.urgencyPinned
      ? await setTaskUrgency(item.id, 'auto')
      : await setTaskUrgency(item.id, 'manual', item.urgency);
    setBusy(false);
    if (!res.ok) {
      setFailure({ message: res.error, code: res.code });
      return;
    }
    setNotice(
      item.urgencyPinned
        ? `${item.title}: 긴급도를 마감일 기반 자동 계산으로 되돌렸습니다.`
        : `${item.title}: 긴급도를 ${item.urgency}로 고정했습니다.`
    );
    router.refresh();
  };

  // ─── 렌더 ──────────────────────────────────────────────────────

  const twoLevel = board.stages.length >= 2;
  const selectedYearId = board.selectedYearId ?? BOARD_ALL_YEARS;

  return (
    <section>
      <div className="flex flex-wrap items-center justify-between gap-3">
        {/* 연차 필터는 두 뷰가 공유한다 (§7.6). 선택은 URL(?yearId=)에 둔다 */}
        <div className="flex flex-wrap items-center gap-2" role="tablist" aria-label="연차 선택">
          {board.years.map((year) => {
            const active = year.id === board.selectedYearId;
            const stage = board.stages.find((s) => s.id === year.stageId);
            return (
              <button
                key={year.id}
                type="button"
                role="tab"
                aria-selected={active}
                disabled={busy}
                onClick={() => goYear(year.id)}
                title={twoLevel && stage ? stageLabel(stage) : undefined}
                className={`rounded-lg px-3 py-1.5 text-sm font-semibold transition ${
                  active
                    ? 'bg-slate-900 text-white'
                    : 'border border-slate-300 bg-white text-slate-700 hover:bg-slate-50'
                }`}
              >
                {yearLabel(year)}
              </button>
            );
          })}
          <button
            type="button"
            role="tab"
            aria-selected={selectedYearId === BOARD_ALL_YEARS}
            disabled={busy}
            onClick={() => goYear(BOARD_ALL_YEARS)}
            title="모든 연차를 한 화면에서 봅니다. WBS 코드에 연차 접두가 붙습니다"
            className={`rounded-lg px-3 py-1.5 text-sm font-semibold transition ${
              selectedYearId === BOARD_ALL_YEARS
                ? 'bg-slate-900 text-white'
                : 'border border-dashed border-slate-300 bg-white text-slate-600 hover:bg-slate-50'
            }`}
          >
            전체 연차 보기
          </button>
        </div>

        <ViewToggle value={view} onChange={setView} disabled={busy} />
      </div>

      {view === 'board' && (
        <div className="mt-4 flex flex-wrap items-center gap-4 rounded-xl border border-slate-200 bg-white p-3 text-sm">
          <label className="flex items-center gap-2 text-slate-700">
            <input
              type="checkbox"
              checked={!leafOnly}
              onChange={(e) => setLeafOnly(!e.target.checked)}
              className="h-4 w-4 rounded border-slate-300"
            />
            묶음(상위) 작업도 표시
          </label>
          <label className="flex items-center gap-2 text-slate-700">
            <input
              type="checkbox"
              checked={swimlanes}
              onChange={(e) => setSwimlanes(e.target.checked)}
              className="h-4 w-4 rounded border-slate-300"
            />
            담당자별 그룹핑
          </label>
          <span className="ml-auto text-xs text-slate-400">
            카드를 다른 컬럼으로 끌면 상태가, 같은 컬럼 안에서 끌면 순서가 바뀝니다
          </span>
        </div>
      )}

      {board.invalidTaskIds.length > 0 && (
        // 절대 규칙 5: 트리에 붙지 못한 작업을 조용히 버리지 않는다
        <ErrorBanner
          className="mt-4"
          code="RULE"
          message={`계층 구조에 편입되지 못한 작업이 ${board.invalidTaskIds.length}건 있어 보드에 표시되지 않았습니다. 부모 작업이 삭제되었거나 다른 연차를 가리키고 있습니다.`}
        />
      )}

      {board.missingRequestedYear && (
        <ErrorBanner
          className="mt-4"
          message="요청한 연차를 찾을 수 없어 다른 연차를 표시합니다. 다른 사람이 연차를 삭제했을 수 있습니다."
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

      {notice && (
        <div
          role="status"
          className="mt-4 flex items-start justify-between gap-4 rounded-xl border border-slate-200 bg-slate-50 p-3 text-sm text-slate-700"
        >
          <p className="min-w-0 break-words">{notice}</p>
          <button
            type="button"
            onClick={() => setNotice(null)}
            aria-label="알림 닫기"
            className="shrink-0 font-bold text-slate-400 hover:text-slate-600"
          >
            ×
          </button>
        </div>
      )}

      <div className="mt-4">
        {view === 'board' ? (
          <KanbanBoard
            cards={visibleCards}
            swimlanes={swimlanes}
            members={members}
            memberNames={memberNames}
            orgNames={orgNames}
            draggingId={draggingId}
            dropCard={dropCard}
            dropColumn={dropColumn}
            busy={busy}
            callbacks={kanbanCallbacks}
          />
        ) : (
          <PriorityMatrix
            data={matrix}
            memberNames={memberNames}
            showDone={showDone}
            onShowDoneChange={setShowDone}
            selected={selectedCell}
            onSelect={setSelectedCell}
            draggingId={draggingId}
            dropCell={dropCell}
            busy={busy}
            onItemDragStart={(id) => setDraggingId(id)}
            onItemDragEnd={clearDrag}
            onCellDragOver={setDropCell}
            onCellDrop={(selection) => void handleCellDrop(selection)}
            onTogglePin={(item) => void handleTogglePin(item)}
          />
        )}
      </div>
    </section>
  );
}
