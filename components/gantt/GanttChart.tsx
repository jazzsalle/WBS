'use client';

// 간트 화면 (SOT §7.5)
//  - 데이터는 전부 서버(page.tsx → getGanttData)가 계산해 내려준다. 진척률·WBS 코드·날짜 롤업을
//    여기서 다시 계산하거나 저장하지 않는다 (§6.1 O-4, §6.1.1 P-14~P-16, §6.7).
//  - 좌표는 전부 lib/gantt의 순수 함수가 낸다 — 화면에서 날짜 산술을 새로 쓰지 않는다.
//  - 기준일(오늘)은 서버가 Asia/Seoul 달력으로 만든 todayISO만 쓴다. new Date() 금지 (§6.5).
//  - 드래그 저장은 updateTask(expectedVersion)로 낙관적 잠금을 건다 (O-1). STALE이면 위치를
//    되돌리지 않고 ConflictDialog + 미저장 배너로 사용자가 고르게 한다 (O-3).
//  - 저장 실패(STALE 외)는 원위치로 되돌리고 배너로 알린다 — 조용히 삼키지 않는다 (절대 규칙 5).
//
// 좌측 트리의 접힘 상태는 이 화면의 로컬 상태다. §7.5의 "WBS 화면과 동기화"는 저장 위치가
// SOT에 정의되어 있지 않아(로컬 스토리지/URL/서버 중 무엇인지 없음) 지어내지 않았다.

import { useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import type { Year } from '@/types';
import type { WbsNode } from '@/actions/tasks';
import type { GanttData } from '@/actions/gantt';
import { updateTask } from '@/actions/tasks';
import type { ActionErrorCode } from '@/lib/db/errors';
import {
  GANTT_SCALES,
  GANTT_SCALE_LABELS,
  buildTicks,
  computeBarGeometry,
  computeChartRange,
  computeYearBands,
  daysFromPx,
  moveTaskDates,
  resizeTaskDue,
  resizeTaskStart,
  todayX as todayXOf,
  type GanttScale,
  type TaskDates,
} from '@/lib/gantt';
import { isOverdueTask } from '@/lib/dates';
import {
  MILESTONE_TYPE_COLORS,
  MILESTONE_TYPE_LABELS,
  TASK_STATUS_LABELS,
} from '@/lib/constants';
import { setRealtimePaused } from '@/components/RealtimeRefresher';
import Button from '@/components/ui/Button';
import ErrorBanner from '@/components/ui/ErrorBanner';
import ConflictDialog from '@/components/ui/ConflictDialog';
import TimeAxis, { AXIS_HEIGHT } from './TimeAxis';
import MilestoneLane, { layoutMilestones } from './MilestoneLane';
import GanttBar, { type DragMode } from './GanttBar';

const LEFT_WIDTH = 340;
const ROW_HEIGHT = 26;
const BAND_STRIP_HEIGHT = 22;
const INDENT_PX = 12;

// 범례: 같은 색을 쓰는 유형끼리 묶는다 (색 정의의 원본은 부록 A.3 하나뿐이다)
const TYPE_LEGEND = (Object.keys(MILESTONE_TYPE_COLORS) as (keyof typeof MILESTONE_TYPE_COLORS)[])
  .reduce<{ token: string; labels: string[] }[]>((groups, type) => {
    const token = MILESTONE_TYPE_COLORS[type];
    const group = groups.find((g) => g.token === token);
    if (group) group.labels.push(MILESTONE_TYPE_LABELS[type]);
    else groups.push({ token, labels: [MILESTONE_TYPE_LABELS[type]] });
    return groups;
  }, []);

const LEGEND_DOT_CLASSES: Record<string, string> = {
  'purple-600': 'bg-purple-600',
  'blue-600': 'bg-blue-600',
  'teal-600': 'bg-teal-600',
  'grey-600': 'bg-grey-600',
};

const BAND_TINTS = ['bg-grey-100', 'bg-surface'];

type Row =
  | { kind: 'year'; key: string; year: Year; progress: number }
  | { kind: 'task'; key: string; node: WbsNode };

interface DragState {
  taskId: string;
  mode: DragMode;
  originX: number;
  scale: GanttScale;
  base: TaskDates;
  preview: TaskDates;
  version: number;
}

interface Override {
  taskId: string;
  dates: TaskDates;
  /** saved = 저장 성공, 서버 재조회 대기 / unsaved = 저장 실패로 아직 반영되지 않음 */
  state: 'saved' | 'unsaved';
}

type Failure = { message: string; code?: ActionErrorCode };

/** §5.5: name이 있으면 name, 없으면 order+1 + '차년도' */
function yearLabel(year: Year): string {
  return year.name.trim() || `${year.order + 1}차년도`;
}

function applyDrag(mode: DragMode, base: TaskDates, deltaDays: number): TaskDates {
  if (mode === 'move') return moveTaskDates(base, deltaDays);
  if (mode === 'start') return resizeTaskStart(base, deltaDays);
  return resizeTaskDue(base, deltaDays);
}

function dateRangeLabel(dates: TaskDates): string {
  if (dates.startDate === null && dates.dueDate === null) return '날짜 없음';
  return `${dates.startDate ?? '—'} ~ ${dates.dueDate ?? '—'}`;
}

export interface GanttChartProps {
  data: GanttData;
}

export default function GanttChart({ data }: GanttChartProps) {
  const router = useRouter();

  // 스케일은 화면 상수(1일 px)만 바꾸므로 서버를 다시 부르지 않는다. 초깃값은 서버가 검증한 값이다.
  const [scale, setScale] = useState<GanttScale>(data.scale);
  const [collapsedIds, setCollapsedIds] = useState<ReadonlySet<string>>(() => new Set<string>());
  const [drag, setDrag] = useState<DragState | null>(null);
  const [override, setOverride] = useState<Override | null>(null);
  const [conflict, setConflict] = useState<{ taskId: string; message: string } | null>(null);
  const [failure, setFailure] = useState<Failure | null>(null);
  const [busy, setBusy] = useState(false);

  const dragRef = useRef<DragState | null>(null);
  const setDragState = (next: DragState | null): void => {
    dragRef.current = next;
    setDrag(next);
  };

  const { nodeById, parentIds, allNodes } = useMemo(() => {
    const byId = new Map<string, WbsNode>();
    const parents: string[] = [];
    const flat: WbsNode[] = [];
    const walk = (nodes: readonly WbsNode[]): void => {
      for (const node of nodes) {
        byId.set(node.task.id, node);
        flat.push(node);
        if (node.children.length > 0) {
          parents.push(node.task.id);
          walk(node.children);
        }
      }
    };
    for (const group of data.years) walk(group.nodes);
    return { nodeById: byId, parentIds: parents, allNodes: flat };
  }, [data.years]);

  // 표시 행 (연차 헤더 + 접힘을 반영한 pre-order 작업 목록)
  const rows: Row[] = useMemo(() => {
    const out: Row[] = [];
    for (const group of data.years) {
      out.push({
        kind: 'year',
        key: `year-${group.year.id}`,
        year: group.year,
        progress: group.yearProgress,
      });
      const visit = (nodes: readonly WbsNode[]): void => {
        for (const node of nodes) {
          out.push({ kind: 'task', key: `task-${node.task.id}`, node });
          if (!collapsedIds.has(node.task.id)) visit(node.children);
        }
      };
      visit(group.nodes);
    }
    return out;
  }, [data.years, collapsedIds]);

  // 차트 범위는 서버 값(작업 롤업 기간·마일스톤·연차)만으로 정한다. 드래그 미리보기를 넣으면
  // 끄는 동안 축 전체가 움직여 기준이 흔들린다 — 저장 후 새로 받은 데이터로 다시 잡는다.
  const range = useMemo(() => {
    const dates: (string | null)[] = [];
    for (const group of data.years) {
      dates.push(group.year.startDate, group.year.endDate);
    }
    for (const node of allNodes) {
      dates.push(node.rolledUpStartDate, node.rolledUpDueDate);
    }
    for (const milestone of data.milestones) dates.push(milestone.date);
    return computeChartRange(dates, scale);
  }, [data.years, data.milestones, allNodes, scale]);

  const dragging = drag !== null;
  const hasUnsaved = override?.state === 'unsaved';

  // R-4: 끄는 중이거나 저장되지 않은 위치가 남아 있으면 자동 새로고침을 보류한다
  // (화면이 다시 그려지면 손에 잡고 있던 막대가 사라진다)
  useEffect(() => {
    if (!dragging && !hasUnsaved) return;
    setRealtimePaused(true);
    return () => setRealtimePaused(false);
  }, [dragging, hasUnsaved]);

  // 저장이 반영되면 낙관적 표시를 걷는다. 서버 값이 내 저장과 같아질 때까지만 유지한다.
  useEffect(() => {
    if (override === null || override.state !== 'saved') return;
    const node = nodeById.get(override.taskId);
    if (!node) {
      setOverride(null);
      return;
    }
    if (
      node.task.startDate === override.dates.startDate &&
      node.task.dueDate === override.dates.dueDate
    ) {
      setOverride(null);
    }
  }, [override, nodeById]);

  // 드래그는 포인터가 막대 밖으로 나가도 이어져야 하므로 window에서 듣는다.
  // 의존성을 dragging 하나로 유지하려고 진행 중 상태는 ref로 읽는다.
  useEffect(() => {
    if (!dragging) return;

    const onMove = (e: PointerEvent): void => {
      const cur = dragRef.current;
      if (!cur) return;
      const delta = daysFromPx(e.clientX - cur.originX, cur.scale);
      const preview = applyDrag(cur.mode, cur.base, delta);
      if (
        preview.startDate === cur.preview.startDate &&
        preview.dueDate === cur.preview.dueDate
      ) {
        return;
      }
      setDragState({ ...cur, preview });
    };

    const onUp = (): void => {
      const cur = dragRef.current;
      setDragState(null);
      if (!cur) return;
      const changed =
        cur.preview.startDate !== cur.base.startDate || cur.preview.dueDate !== cur.base.dueDate;
      if (!changed) return;

      // 낙관적 렌더: 저장 결과가 올 때까지 끌어 놓은 자리를 유지한다
      setOverride({ taskId: cur.taskId, dates: cur.preview, state: 'saved' });
      setBusy(true);
      setFailure(null);
      void updateTask(
        cur.taskId,
        { startDate: cur.preview.startDate, dueDate: cur.preview.dueDate },
        cur.version
      ).then((res) => {
        setBusy(false);
        if (res.ok) {
          // 부모의 롤업 기간(P-14~P-16)도 함께 바뀐다 — 서버 계산 값을 다시 받는다
          router.refresh();
          return;
        }
        if (res.code === 'STALE') {
          // O-3: 되돌리지 않는다. 내 위치를 남긴 채 사용자가 고르게 한다
          setOverride({ taskId: cur.taskId, dates: cur.preview, state: 'unsaved' });
          setConflict({ taskId: cur.taskId, message: res.error });
          return;
        }
        // 절대 규칙 5: 실패는 원위치 + 화면에 남긴다
        setOverride(null);
        setFailure({ message: res.error, code: res.code });
      });
    };

    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onUp);
    return () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onUp);
    };
  }, [dragging, router]);

  const effectiveDates = (node: WbsNode): TaskDates => {
    if (drag?.taskId === node.task.id) return drag.preview;
    if (override?.taskId === node.task.id) return override.dates;
    return { startDate: node.task.startDate, dueDate: node.task.dueDate };
  };

  // 부모는 자식에서 롤업된 기간을 그린다 (P-14~P-16). 리프만 자기 날짜를 쓴다.
  const barDates = (node: WbsNode): TaskDates =>
    node.children.length > 0
      ? { startDate: node.rolledUpStartDate, dueDate: node.rolledUpDueDate }
      : effectiveDates(node);

  const startDrag = (node: WbsNode, mode: DragMode, clientX: number): void => {
    if (node.children.length > 0) return; // 롤업 막대는 저장할 곳이 없다
    const base = effectiveDates(node);
    setDragState({
      taskId: node.task.id,
      mode,
      originX: clientX,
      scale,
      base,
      preview: base,
      version: node.task.version,
    });
  };

  const retrySave = async (): Promise<void> => {
    if (override === null || override.state !== 'unsaved') return;
    const node = nodeById.get(override.taskId);
    if (!node) {
      setOverride(null);
      setFailure({ message: '옮기려던 작업이 더 이상 없습니다. 다른 사람이 삭제했을 수 있습니다.' });
      return;
    }
    setBusy(true);
    setFailure(null);
    const res = await updateTask(
      override.taskId,
      { startDate: override.dates.startDate, dueDate: override.dates.dueDate },
      node.task.version
    );
    setBusy(false);
    if (res.ok) {
      setOverride({ ...override, state: 'saved' });
      setConflict(null);
      router.refresh();
      return;
    }
    if (res.code === 'STALE') {
      setConflict({ taskId: override.taskId, message: res.error });
      return;
    }
    setFailure({ message: res.error, code: res.code });
  };

  // ─── 파생 표시값 ────────────────────────────────────────────

  const datelessCount = useMemo(
    () =>
      allNodes.filter((n) => n.rolledUpStartDate === null && n.rolledUpDueDate === null).length,
    [allNodes]
  );

  const truncatedCount = useMemo(() => {
    if (range === null) return 0;
    return allNodes.filter((node) => {
      const geo = computeBarGeometry(
        range,
        node.rolledUpStartDate,
        node.rolledUpDueDate,
        scale
      );
      return geo?.truncated === true;
    }).length;
  }, [allNodes, range, scale]);

  const bandResult = useMemo(
    () =>
      range === null
        ? null
        : computeYearBands(
            data.years.map((g) => ({
              id: g.year.id,
              startDate: g.year.startDate,
              endDate: g.year.endDate,
            })),
            range,
            scale
          ),
    [data.years, range, scale]
  );

  const ticks = useMemo(() => (range === null ? null : buildTicks(range, scale)), [range, scale]);

  const laneLayout = useMemo(
    () =>
      range === null
        ? null
        : layoutMilestones(data.milestones, range, scale, data.todayISO, data.milestoneAlertDays),
    [data.milestones, data.todayISO, data.milestoneAlertDays, range, scale]
  );

  const todayLineX = range === null ? null : todayXOf(range, data.todayISO, scale);
  const yearNameById = new Map(data.years.map((g) => [g.year.id, yearLabel(g.year)]));
  const conflictNode = conflict === null ? null : nodeById.get(conflict.taskId);
  const overrideNode = override === null ? null : nodeById.get(override.taskId);

  // ─── 좌측 패널 행 ───────────────────────────────────────────

  const renderLeftRow = (row: Row) => {
    if (row.kind === 'year') {
      return (
        <div
          key={row.key}
          className="flex items-center gap-2 border-b border-grey-200 bg-grey-100 px-2 text-xs font-bold text-grey-700"
          style={{ height: ROW_HEIGHT }}
        >
          <span className="truncate">{yearLabel(row.year)}</span>
          <span className="ml-auto shrink-0 tabular-nums text-grey-500">
            {row.progress.toFixed(1)}%
          </span>
        </div>
      );
    }

    const node = row.node;
    const dates = barDates(node);
    const hasDate = dates.startDate !== null || dates.dueDate !== null;
    const collapsed = collapsedIds.has(node.task.id);
    const unsaved = override?.taskId === node.task.id && override.state === 'unsaved';

    return (
      <div
        key={row.key}
        className="flex items-center gap-1 border-b border-grey-100 px-2 text-xs text-grey-700"
        style={{ height: ROW_HEIGHT }}
      >
        <span style={{ width: (node.depth - 1) * INDENT_PX }} aria-hidden />
        {node.children.length > 0 ? (
          <button
            type="button"
            onClick={() =>
              setCollapsedIds((prev) => {
                const next = new Set(prev);
                if (next.has(node.task.id)) next.delete(node.task.id);
                else next.add(node.task.id);
                return next;
              })
            }
            aria-expanded={!collapsed}
            aria-label={`${node.task.title} 하위 작업 ${collapsed ? '펼치기' : '접기'}`}
            className="w-4 shrink-0 text-grey-400 hover:text-grey-700"
          >
            {collapsed ? '▸' : '▾'}
          </button>
        ) : (
          <span className="w-4 shrink-0" aria-hidden />
        )}
        <span className="shrink-0 tabular-nums text-[10px] text-grey-400">{node.wbsCode}</span>
        <span className="truncate" title={node.task.title}>
          {node.task.title}
        </span>
        {!hasDate && (
          // §7.5: 날짜 없는 작업은 막대 없이 목록에만 나온다 — 이유를 배지로 밝힌다
          <span className="ml-auto shrink-0 rounded bg-grey-100 px-1 text-[10px] text-grey-500">
            날짜 없음
          </span>
        )}
        {hasDate && (
          <span
            className={`ml-auto shrink-0 tabular-nums text-[10px] ${
              unsaved ? 'font-semibold text-orange-700' : 'text-grey-400'
            }`}
            title={dateRangeLabel(dates)}
          >
            {dates.startDate?.slice(5) ?? '—'}~{dates.dueDate?.slice(5) ?? '—'}
          </span>
        )}
      </div>
    );
  };

  // ─── 우측 행 ────────────────────────────────────────────────

  const renderRightRow = (row: Row) => {
    if (row.kind === 'year' || range === null) {
      return (
        <div
          key={row.key}
          className={`relative border-b ${
            row.kind === 'year' ? 'border-grey-200 bg-grey-100/70' : 'border-grey-100'
          }`}
          style={{ height: ROW_HEIGHT, width: range?.widthPx }}
        />
      );
    }

    const node = row.node;
    const summary = node.children.length > 0;
    const dates = barDates(node);
    const geometry = computeBarGeometry(range, dates.startDate, dates.dueDate, scale);

    return (
      <div
        key={row.key}
        className="relative border-b border-grey-100"
        style={{ height: ROW_HEIGHT, width: range.widthPx }}
      >
        {geometry && (
          <GanttBar
            geometry={geometry}
            progress={node.progress}
            status={node.task.status}
            summary={summary}
            overdue={isOverdueTask(node.task, data.todayISO)}
            rowHeight={ROW_HEIGHT}
            title={`${node.wbsCode} ${node.task.title} (${TASK_STATUS_LABELS[node.task.status]} ${node.progress.toFixed(1)}%)`}
            unsaved={override?.taskId === node.task.id && override.state === 'unsaved'}
            dragging={drag?.taskId === node.task.id}
            busy={busy}
            onDragStart={(mode, clientX) => startDrag(node, mode, clientX)}
          />
        )}
      </div>
    );
  };

  const rowsHeight = rows.length * ROW_HEIGHT;

  return (
    <section>
      {/* 툴바 — 스케일 전환(§7.5) */}
      <div className="mb-3 flex flex-wrap items-center gap-3 rounded-xl border border-grey-200 bg-surface p-3 text-sm">
        <div role="group" aria-label="시간축 스케일" className="flex items-center gap-1">
          {GANTT_SCALES.map((s) => (
            <Button
              key={s}
              size="sm"
              variant={s === scale ? 'primary' : 'secondary'}
              aria-pressed={s === scale}
              onClick={() => setScale(s)}
            >
              {GANTT_SCALE_LABELS[s]}
            </Button>
          ))}
        </div>

        <Button size="sm" onClick={() => setCollapsedIds(new Set())}>
          전체 펼치기
        </Button>
        <Button size="sm" onClick={() => setCollapsedIds(new Set(parentIds))}>
          전체 접기
        </Button>

        <ul className="ml-auto flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-grey-500">
          {TYPE_LEGEND.map((group) => (
            <li key={group.token} className="flex items-center gap-1.5">
              <span
                aria-hidden
                className={`h-2.5 w-2.5 rotate-45 ${LEGEND_DOT_CLASSES[group.token] ?? 'bg-grey-600'}`}
              />
              {group.labels.join(' · ')}
            </li>
          ))}
        </ul>
      </div>

      {data.invalidTaskIds.length > 0 && (
        // 절대 규칙 5: 트리에 붙지 못한 작업을 조용히 버리지 않는다
        <ErrorBanner
          className="mb-3"
          code="RULE"
          message={`계층 구조에 편입되지 못한 작업이 ${data.invalidTaskIds.length}건 있어 간트에 표시되지 않습니다. 부모 작업이 삭제되었거나 다른 연차를 가리키고 있습니다.`}
        />
      )}

      {failure && (
        <ErrorBanner
          className="mb-3"
          message={failure.message}
          code={failure.code}
          onDismiss={() => setFailure(null)}
        />
      )}

      {override?.state === 'unsaved' && (
        // O-3: 저장하지 못한 위치를 조용히 되돌리지 않는다. 내 위치와 최신 값을 나란히 둔다
        <div
          role="status"
          className="mb-3 rounded-xl border border-orange-200 bg-orange-50 p-3 text-sm text-orange-800"
        >
          <p className="font-semibold">기간 변경이 저장되지 않았습니다.</p>
          <div className="mt-2 flex flex-wrap items-center gap-3 rounded-lg bg-surface/70 px-2.5 py-1.5 text-xs">
            <span className="font-semibold text-grey-700">
              {overrideNode?.task.title ?? '(삭제된 작업)'}
            </span>
            <span className="text-grey-500">내 위치: {dateRangeLabel(override.dates)}</span>
            <span className="text-grey-500">
              최신:{' '}
              {overrideNode
                ? dateRangeLabel({
                    startDate: overrideNode.task.startDate,
                    dueDate: overrideNode.task.dueDate,
                  })
                : '(삭제됨)'}
            </span>
          </div>
          <div className="mt-2 flex flex-wrap gap-2">
            <button
              type="button"
              disabled={busy || overrideNode === undefined}
              onClick={() => void retrySave()}
              className="rounded-md border border-orange-300 px-2 py-0.5 text-xs font-semibold text-orange-800 disabled:opacity-50"
            >
              내 위치로 다시 저장
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={() => {
                setOverride(null);
                setConflict(null);
                router.refresh();
              }}
              className="rounded-md border border-grey-300 px-2 py-0.5 text-xs font-semibold text-grey-600"
            >
              최신 값 두기 (내 변경 버림)
            </button>
          </div>
        </div>
      )}

      {range === null || ticks === null || laneLayout === null || bandResult === null ? (
        <p className="rounded-xl border border-dashed border-grey-300 p-10 text-center text-sm text-grey-500">
          날짜가 입력된 작업·마일스톤·연차가 없어 시간축을 그릴 수 없습니다. 연차 기간이나 작업의
          시작일·마감일을 입력하면 여기에 그려집니다.
          {allNodes.length > 0 && ` (작업 ${allNodes.length}건은 아래 목록에만 있습니다)`}
        </p>
      ) : (
        <div
          className="grid overflow-hidden rounded-xl border border-grey-200 bg-surface"
          style={{ gridTemplateColumns: `${LEFT_WIDTH}px minmax(0, 1fr)` }}
        >
          {/* 좌측 고정 패널: 연차 > 작업 트리 (§7.5) */}
          <div className="border-r border-grey-300">
            <div
              className="flex items-end border-b border-grey-300 bg-grey-50 px-2 pb-1 text-[11px] font-semibold text-grey-500"
              style={{ height: AXIS_HEIGHT }}
            >
              연차 · 작업
            </div>
            <div
              className="flex items-center border-b border-grey-200 px-2 text-[11px] text-grey-400"
              style={{ height: laneLayout.height }}
            >
              마일스톤
            </div>
            <div
              className="flex items-center border-b border-grey-200 bg-grey-50 px-2 text-[11px] text-grey-400"
              style={{ height: BAND_STRIP_HEIGHT }}
            >
              연차 구간
            </div>
            <div>{rows.map(renderLeftRow)}</div>
          </div>

          {/* 우측 시간축 영역 — 가로 스크롤은 이 컬럼만 한다 */}
          <div className="overflow-x-auto">
            <div style={{ width: range.widthPx }}>
              <TimeAxis range={range} scale={scale} ticks={ticks} todayX={todayLineX} />

              <MilestoneLane layout={laneLayout} range={range} />

              {/* 연차 라벨 띠 */}
              <div
                className="relative border-b border-grey-200 bg-grey-50"
                style={{ height: BAND_STRIP_HEIGHT, width: range.widthPx }}
              >
                {bandResult.bands.map((band, i) => (
                  <div
                    key={band.id}
                    title={`${yearNameById.get(band.id) ?? '연차'} ${band.startDate} ~ ${band.endDate}`}
                    className={`absolute inset-y-0 flex items-center justify-center overflow-hidden border-x border-grey-300 px-1 text-[11px] font-medium text-grey-600 ${
                      BAND_TINTS[i % BAND_TINTS.length]
                    }`}
                    style={{ left: band.left, width: band.width }}
                  >
                    <span className="truncate">{yearNameById.get(band.id) ?? '연차'}</span>
                  </div>
                ))}
              </div>

              {/* 행 영역 — 배경(연차 밴드·경계선·오늘선) 위에 행을 얹는다 */}
              <div className="relative" style={{ height: rowsHeight, width: range.widthPx }}>
                <div aria-hidden className="pointer-events-none absolute inset-0">
                  {bandResult.bands.map((band, i) => (
                    <div
                      key={band.id}
                      className={`absolute inset-y-0 ${BAND_TINTS[i % BAND_TINTS.length]} opacity-60`}
                      style={{ left: band.left, width: band.width }}
                    />
                  ))}
                  {/* 연차 경계 세로 구분선 (§7.5) */}
                  {bandResult.bands.map((band) => (
                    <div
                      key={`edge-${band.id}`}
                      className="absolute inset-y-0 w-px bg-grey-300"
                      style={{ left: band.left }}
                    />
                  ))}
                  {bandResult.bands.length > 0 && (
                    <div
                      className="absolute inset-y-0 w-px bg-grey-300"
                      style={{
                        left:
                          (bandResult.bands[bandResult.bands.length - 1]?.left ?? 0) +
                          (bandResult.bands[bandResult.bands.length - 1]?.width ?? 0),
                      }}
                    />
                  )}
                  {/* 오늘 세로 기준선 (§6.5 서버 기준일) */}
                  {todayLineX !== null && (
                    <div className="absolute inset-y-0 z-10 w-px bg-red-500" style={{ left: todayLineX }} />
                  )}
                </div>

                <div className="relative">{rows.map(renderRightRow)}</div>
              </div>
            </div>
          </div>
        </div>
      )}

      <ul className="mt-3 space-y-1 text-xs text-grey-500">
        <li>
          막대를 끌면 기간이 옮겨지고 양끝을 끌면 시작일·마감일이 바뀝니다. 하위 작업이 있는 작업의
          막대는 하위에서 계산된 기간이라 끌 수 없습니다(§6.1.1).
        </li>
        {datelessCount > 0 && (
          <li>
            날짜가 없는 작업 {datelessCount}건은 막대 없이 좌측 목록에만 표시됩니다.
          </li>
        )}
        {truncatedCount > 0 && (
          <li className="text-orange-700">
            현재 스케일({GANTT_SCALE_LABELS[scale]})에서 너무 짧아 최소 폭으로 넓게 그린 막대가{' '}
            {truncatedCount}건 있습니다(점선 테두리). 정확한 기간은 좌측 목록의 날짜를 보세요.
          </li>
        )}
        {range !== null && todayLineX === null && (
          <li>오늘({data.todayISO})은 표시 구간 밖이라 기준선을 그리지 않았습니다.</li>
        )}
        {bandResult && bandResult.unplottableIds.length > 0 && (
          <li>
            기간이 없거나 시작일이 종료일보다 늦어 배경 밴드를 그리지 못한 연차:{' '}
            {bandResult.unplottableIds.map((id) => yearNameById.get(id) ?? id).join(', ')}
          </li>
        )}
        {bandResult && bandResult.overlappingIds.length > 0 && (
          <li className="text-orange-700">
            기간이 서로 겹치는 연차가 있습니다:{' '}
            {bandResult.overlappingIds.map((id) => yearNameById.get(id) ?? id).join(', ')}. 밴드를
            임의로 자르지 않고 그대로 겹쳐 그렸습니다.
          </li>
        )}
        <li>의존관계 화살표는 v1에서 제공하지 않습니다(§7.5).</li>
      </ul>

      {conflict && (
        <ConflictDialog
          message={
            conflictNode
              ? `${conflict.message} 최신 기간: ${dateRangeLabel({
                  startDate: conflictNode.task.startDate,
                  dueDate: conflictNode.task.dueDate,
                })}`
              : conflict.message
          }
          onReload={() => {
            setConflict(null);
            router.refresh();
          }}
          onKeepEditing={() => setConflict(null)}
        />
      )}
    </section>
  );
}
