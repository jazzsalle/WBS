'use client';

// WBS 트리의 한 행 (SOT §7.4 계층형 테이블 컬럼)
// 파생 값(wbsCode·progress·urgency·priorityScore·rolledUp*)은 서버가 계산해 내려준 값을
// 표시만 한다 — 클라이언트에서 다시 계산하거나 저장하지 않는다 (PR-7, O-4, §6.1.1).
// 담당·기관·목표 이름은 부모가 내려준 사전으로만 푼다 — 행마다 조회하지 않는다.
// 연계(성과·기술목표) 편집은 상세 패널에서 한다 — 여기서는 건수 뱃지와 이름 툴팁만 보여준다.

import { useEffect, useRef, useState, type KeyboardEvent, type MouseEvent } from 'react';
import type { WbsNode } from '@/actions/tasks';
import type { ProgressMode, TaskStatus } from '@/types';
import { TASK_STATUS_LABELS } from '@/lib/constants';
import { priorityGrade, type PriorityGrade } from '@/lib/priority';
import { isOverdueTask } from '@/lib/dates';
import Badge, { type BadgeTone } from '@/components/ui/Badge';
import { DELETED_GOAL } from './conflict';

export type DropZone = 'before' | 'inside' | 'after';

// 부록 A.3의 색 의미를 뱃지 톤으로 옮긴다. Tailwind는 클래스명을 정적으로 스캔하므로
// 'slate-400' 같은 토큰을 문자열로 조립하지 않고 완전한 클래스를 나열한다.
const STATUS_TONES: Record<TaskStatus, BadgeTone> = {
  todo: 'neutral',
  in_progress: 'blue',
  done: 'green',
  blocked: 'red',
};

const STATUS_SELECT_CLASSES: Record<TaskStatus, string> = {
  todo: 'border-slate-200 bg-white text-slate-600',
  in_progress: 'border-blue-200 bg-blue-50 text-blue-700',
  done: 'border-emerald-200 bg-emerald-50 text-emerald-700',
  blocked: 'border-rose-200 bg-rose-50 text-rose-700',
};

// §6.9.2 등급 색(red-600 / amber-500 / slate-500 / slate-400)에 대응하는 뱃지 톤
const GRADE_TONES: Record<PriorityGrade, BadgeTone> = {
  최우선: 'red',
  높음: 'amber',
  보통: 'neutral',
  낮음: 'neutral',
};

const INDENT_PX = 18;

// 배정은 남아 있는데 인력·기관이 지워진 경우. 조용히 '—'로 만들면 "배정이 없다"로 읽혀
// 사실이 바뀐다 — 이름을 못 찾았다는 것 자체를 보여준다 (절대 규칙 5).
const DELETED_MEMBER = '(삭제된 인력)';
const DELETED_ORG = '(삭제된 기관)';

function nameOf(id: string, dict: Record<string, string>, missing: string): string {
  return dict[id] ?? missing;
}

export interface TreeRowCallbacks {
  onSelect: (id: string) => void;
  onToggleCollapse: (id: string) => void;
  onRowKeyDown: (id: string, e: KeyboardEvent<HTMLTableRowElement>) => void;
  onStatusChange: (id: string, status: TaskStatus) => void;
  onProgressCommit: (id: string, value: number) => void;
  onProgressModeChange: (id: string, mode: ProgressMode) => void;
  onRenameStart: (id: string) => void;
  onRenameChange: (id: string, title: string) => void;
  onRenameCommit: (id: string, title: string) => void;
  onRenameCancel: () => void;
  onDragStart: (id: string) => void;
  onDragEnd: () => void;
  onDragOverRow: (id: string, zone: DropZone) => void;
  onDropRow: (id: string, zone: DropZone) => void;
}

export interface TreeRowProps {
  node: WbsNode;
  /** 지연 판정 기준일. 서버에서 내려받아 SSR/CSR 결과가 갈리지 않게 한다 (§6.5) */
  todayISO: string;
  /** 담당·기관 컬럼용 id → 이름 사전 */
  memberNames: Record<string, string>;
  orgNames: Record<string, string>;
  /** 연계 컬럼 툴팁용 id → 목표명 사전 */
  deliverableNames: Record<string, string>;
  techTargetNames: Record<string, string>;
  selected: boolean;
  collapsed: boolean;
  /**
   * 이름 편집 중이면 입력값, 아니면 null. 값을 WbsScreen이 들고 있는 이유는
   * 저장이 STALE로 실패해도 입력을 잃지 않기 위해서다 (O-3) — 비제어 입력은
   * 행이 다시 그려지는 순간 사용자가 친 문자열이 사라진다.
   */
  renameDraft: string | null;
  dragging: boolean;
  dropZone: DropZone | null;
  busy: boolean;
  /** 0보다 크면 이 행에 포커스를 준다. 생성·이동 뒤 키보드 조작을 이어가기 위한 신호 */
  focusToken: number;
  callbacks: TreeRowCallbacks;
}

function zoneFromPointer(e: MouseEvent<HTMLTableRowElement>): DropZone {
  const rect = e.currentTarget.getBoundingClientRect();
  const ratio = rect.height === 0 ? 0.5 : (e.clientY - rect.top) / rect.height;
  if (ratio < 0.25) return 'before';
  if (ratio > 0.75) return 'after';
  return 'inside';
}

function formatHours(value: number | null): string {
  return value === null ? '—' : `${value}h`;
}

export default function TreeRow({
  node,
  todayISO,
  memberNames,
  orgNames,
  deliverableNames,
  techTargetNames,
  selected,
  collapsed,
  renameDraft,
  dragging,
  dropZone,
  busy,
  focusToken,
  callbacks,
}: TreeRowProps) {
  const { task } = node;
  const rowRef = useRef<HTMLTableRowElement>(null);
  const [progressDraft, setProgressDraft] = useState<string | null>(null);

  useEffect(() => {
    if (focusToken > 0) rowRef.current?.focus();
  }, [focusToken]);

  const hasChildren = node.children.length > 0;
  // 부모가 manual이면 그 값이 곧 진척률이므로 부모도 직접 입력할 수 있어야 한다 (P-4)
  const progressEditable = node.isLeaf || task.progressMode === 'manual';
  const grade = priorityGrade(node.priorityScore);
  // 기간 컬럼은 롤업 기간을 보여주므로 지연 판정도 같은 날짜로 한다 — 리프는 자기 dueDate와 같다
  const overdue = isOverdueTask({ dueDate: node.rolledUpDueDate, status: task.status }, todayISO);
  const linkedCount = task.deliverableIds.length + task.techTargetIds.length;
  // 툴팁에 실제 목표명을 나열한다. 사전에 없으면 "지워진 목표를 가리키고 있다"를 그대로 알린다
  const linkedDeliverableNames = task.deliverableIds.map((id) =>
    nameOf(id, deliverableNames, DELETED_GOAL)
  );
  const linkedTechTargetNames = task.techTargetIds.map((id) =>
    nameOf(id, techTargetNames, DELETED_GOAL)
  );

  // §7.4 담당 컬럼 = 책임자 이름 + 추가 인원 수. 책임자가 참여자에도 들어 있으면 두 번 세지 않는다
  const ownerName =
    task.ownerMemberId === null ? null : nameOf(task.ownerMemberId, memberNames, DELETED_MEMBER);
  const extraMemberIds = task.memberIds.filter((id) => id !== task.ownerMemberId);
  const extraMemberNames = extraMemberIds.map((id) => nameOf(id, memberNames, DELETED_MEMBER));
  const orgName = task.orgId === null ? null : nameOf(task.orgId, orgNames, DELETED_ORG);

  const stop = (e: MouseEvent<HTMLElement>): void => e.stopPropagation();

  const commitProgress = (): void => {
    const raw = progressDraft;
    setProgressDraft(null);
    if (raw === null) return;
    const parsed = Number.parseInt(raw.trim(), 10);
    // 숫자가 아니면 저장하지 않고 편집을 취소한다 (잘못된 값을 서버로 보내지 않는다)
    if (Number.isNaN(parsed)) return;
    const clamped = Math.max(0, Math.min(100, parsed));
    if (clamped === Math.round(node.progress)) return;
    callbacks.onProgressCommit(task.id, clamped);
  };

  return (
    <tr
      ref={rowRef}
      tabIndex={0}
      aria-selected={selected}
      draggable={!busy}
      onClick={() => callbacks.onSelect(task.id)}
      onKeyDown={(e) => {
        // 셀 안의 입력·드롭다운에서 누른 키는 트리 조작으로 해석하지 않는다
        if (e.target !== e.currentTarget) return;
        callbacks.onRowKeyDown(task.id, e);
      }}
      onDragStart={(e) => {
        e.dataTransfer.effectAllowed = 'move';
        e.dataTransfer.setData('text/plain', task.id);
        callbacks.onDragStart(task.id);
      }}
      onDragEnd={callbacks.onDragEnd}
      onDragOver={(e) => {
        e.preventDefault(); // preventDefault를 해야 drop 이벤트가 발생한다
        e.dataTransfer.dropEffect = 'move';
        callbacks.onDragOverRow(task.id, zoneFromPointer(e));
      }}
      onDrop={(e) => {
        e.preventDefault();
        callbacks.onDropRow(task.id, zoneFromPointer(e));
      }}
      className={[
        'border-b border-slate-100 text-sm outline-none focus:bg-slate-50',
        selected ? 'bg-blue-50/70' : 'hover:bg-slate-50',
        dragging ? 'opacity-40' : '',
        task.status === 'done' ? 'text-slate-400' : 'text-slate-700', // PR-6: 완료는 흐리게
        dropZone === 'before' ? 'shadow-[inset_0_2px_0_0_#2563eb]' : '',
        dropZone === 'after' ? 'shadow-[inset_0_-2px_0_0_#2563eb]' : '',
        dropZone === 'inside' ? 'ring-2 ring-inset ring-blue-400' : '',
      ].join(' ')}
    >
      <td className="px-2 py-1.5 font-mono text-xs text-slate-400">{node.wbsCode}</td>

      <td className="px-2 py-1.5">
        <div className="flex items-center" style={{ paddingLeft: (node.depth - 1) * INDENT_PX }}>
          {hasChildren ? (
            <button
              type="button"
              onClick={(e) => {
                stop(e);
                callbacks.onToggleCollapse(task.id);
              }}
              aria-label={collapsed ? '하위 작업 펼치기' : '하위 작업 접기'}
              aria-expanded={!collapsed}
              className="mr-1 w-4 shrink-0 text-xs text-slate-400 hover:text-slate-700"
            >
              {collapsed ? '▸' : '▾'}
            </button>
          ) : (
            <span aria-hidden className="mr-1 w-4 shrink-0" />
          )}

          {renameDraft !== null ? (
            <input
              autoFocus
              value={renameDraft}
              onClick={stop}
              onChange={(e) => callbacks.onRenameChange(task.id, e.target.value)}
              onBlur={() => callbacks.onRenameCommit(task.id, renameDraft)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  callbacks.onRenameCommit(task.id, renameDraft);
                }
                if (e.key === 'Escape') {
                  e.preventDefault();
                  callbacks.onRenameCancel();
                }
              }}
              aria-label="작업명"
              className="w-full rounded border border-blue-400 px-1.5 py-0.5 text-sm focus:outline-none"
            />
          ) : (
            <span
              onDoubleClick={(e) => {
                stop(e);
                callbacks.onRenameStart(task.id);
              }}
              title={`${task.title} (더블클릭하면 이름을 바꿉니다)`}
              className={`truncate ${hasChildren ? 'font-semibold' : ''}`}
            >
              {task.title}
            </span>
          )}
        </div>
      </td>

      <td className="px-2 py-1.5 text-xs text-slate-500">
        {ownerName === null && extraMemberNames.length === 0 ? (
          <span className="text-slate-300">—</span>
        ) : (
          <span className="flex items-center gap-1">
            <span className="truncate" title={ownerName ?? '책임자 미지정'}>
              {ownerName ?? <span className="text-slate-400">미지정</span>}
            </span>
            {extraMemberNames.length > 0 && (
              <Badge
                className="shrink-0"
                title={`참여 담당자: ${extraMemberNames.join(', ')}`}
              >
                +{extraMemberNames.length}
              </Badge>
            )}
          </span>
        )}
      </td>
      <td className="px-2 py-1.5 text-xs text-slate-500">
        {orgName === null ? (
          <span className="text-slate-300">—</span>
        ) : (
          // 기관명은 길다. 잘라 보여주되 전체 이름은 title로 남긴다
          <span className="block truncate" title={orgName}>
            {orgName}
          </span>
        )}
      </td>

      <td className="px-2 py-1.5" onClick={stop}>
        <select
          value={task.status}
          disabled={busy}
          aria-label="상태"
          onChange={(e) => callbacks.onStatusChange(task.id, e.target.value as TaskStatus)}
          className={`w-full rounded-md border px-1.5 py-1 text-xs font-medium focus:outline-none ${STATUS_SELECT_CLASSES[task.status]}`}
        >
          {(Object.keys(TASK_STATUS_LABELS) as TaskStatus[]).map((status) => (
            <option key={status} value={status}>
              {TASK_STATUS_LABELS[status]}
            </option>
          ))}
        </select>
      </td>

      <td className="px-2 py-1.5">
        <span className="flex items-center gap-1">
          <Badge
            tone={GRADE_TONES[grade.grade]}
            title={`중요도 ${task.importance} × 긴급도 ${node.urgency} = ${node.priorityScore} (${grade.grade})`}
          >
            {node.priorityScore}
          </Badge>
          {/* PR-4: 긴급도를 고정하면 마감일이 바뀌어도 값이 변하지 않는다 */}
          {task.urgencyMode === 'manual' && (
            <span aria-label="긴급도 고정" title="긴급도 고정(수동)" className="text-xs">
              📌
            </span>
          )}
        </span>
      </td>

      <td className="px-2 py-1.5" onClick={stop}>
        <div className="flex items-center gap-1.5">
          <span
            role="progressbar"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={Math.round(node.progress)}
            aria-label="진척률"
            className="h-1.5 w-full min-w-8 overflow-hidden rounded-full bg-slate-100"
          >
            <span
              className="block h-full rounded-full bg-blue-500"
              style={{ width: `${Math.max(0, Math.min(100, Math.round(node.progress)))}%` }}
            />
          </span>
          {progressDraft !== null ? (
            <input
              autoFocus
              inputMode="numeric"
              value={progressDraft}
              aria-label="진척률 입력"
              onChange={(e) => setProgressDraft(e.target.value)}
              onBlur={commitProgress}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  commitProgress();
                }
                if (e.key === 'Escape') {
                  e.preventDefault();
                  setProgressDraft(null);
                }
              }}
              className="w-10 rounded border border-blue-400 px-1 text-right text-xs focus:outline-none"
            />
          ) : (
            <button
              type="button"
              disabled={busy || !progressEditable}
              onClick={() => setProgressDraft(String(Math.round(node.progress)))}
              title={
                progressEditable
                  ? '클릭해서 진척률을 입력합니다'
                  : '자동 롤업 값입니다. 직접 입력하려면 수동으로 바꾸세요 (P-4)'
              }
              className="w-9 shrink-0 text-right text-xs tabular-nums disabled:cursor-default"
            >
              {Math.round(node.progress)}%
            </button>
          )}
          {hasChildren && (
            <button
              type="button"
              disabled={busy}
              onClick={() =>
                callbacks.onProgressModeChange(
                  task.id,
                  task.progressMode === 'auto' ? 'manual' : 'auto'
                )
              }
              title={
                task.progressMode === 'auto'
                  ? '자동(하위 작업 가중 평균). 클릭하면 수동으로 바꿉니다'
                  : '수동 입력. 클릭하면 자동 롤업으로 되돌립니다'
              }
              className="shrink-0 rounded border border-slate-200 px-1 text-[10px] text-slate-500 hover:bg-slate-100"
            >
              {task.progressMode === 'auto' ? '자동' : '수동'}
            </button>
          )}
        </div>
      </td>

      <td className={`px-2 py-1.5 text-xs whitespace-nowrap ${overdue ? 'font-semibold text-red-600' : 'text-slate-500'}`}>
        {node.rolledUpStartDate === null && node.rolledUpDueDate === null ? (
          '—'
        ) : (
          <span title={overdue ? '마감일이 지났습니다' : undefined}>
            {node.rolledUpStartDate ?? '?'} ~ {node.rolledUpDueDate ?? '?'}
          </span>
        )}
      </td>

      <td className="px-2 py-1.5 text-xs whitespace-nowrap text-slate-500" title="예상 / 실적 공수">
        {formatHours(task.estimatedHours)} / {formatHours(task.actualHours)}
      </td>

      <td className="px-2 py-1.5 text-xs">
        {linkedCount === 0 ? (
          <span className="text-slate-300">—</span>
        ) : (
          <span className="flex gap-1">
            {task.deliverableIds.length > 0 && (
              <Badge tone="violet" title={`연계 성과목표: ${linkedDeliverableNames.join(', ')}`}>
                성과 {task.deliverableIds.length}
              </Badge>
            )}
            {task.techTargetIds.length > 0 && (
              <Badge tone="blue" title={`연계 기술목표: ${linkedTechTargetNames.join(', ')}`}>
                기술 {task.techTargetIds.length}
              </Badge>
            )}
          </span>
        )}
      </td>
    </tr>
  );
}
