'use client';

// WBS 계층형 테이블 (SOT §7.4 컬럼 정의)
// 정렬은 order(계층 순서) 그대로다 — 우선순위로 재정렬하지 않는다 (PR-8).
// 행 목록은 WbsScreen이 필터·접기를 적용해 표시 순서대로 넘겨준다.

import type { Year } from '@/types';
import type { WbsNode } from '@/actions/tasks';
import { YEAR_STATUS_LABELS } from '@/lib/constants';
import Badge from '@/components/ui/Badge';
import ProgressBar from '@/components/ui/ProgressBar';
import TreeRow, { type DropZone, type TreeRowCallbacks } from './TreeRow';

export interface TreeTableGroup {
  year: Year;
  /** §6.1 ② 연차 진척률. 서버 계산값 — 반올림은 표시 단계에서만 한다 (P-8) */
  yearProgress: number;
  /** 필터·접기를 적용한 뒤의 표시 행 */
  rows: WbsNode[];
  /** 필터 적용 전 이 연차의 전체 작업 수 */
  totalCount: number;
}

export interface TreeTableProps {
  groups: TreeTableGroup[];
  todayISO: string;
  /** 담당·기관 컬럼에 쓸 id → 이름 사전 (§7.4) */
  memberNames: Record<string, string>;
  orgNames: Record<string, string>;
  /** 연계 컬럼에 쓸 id → 목표명 사전 (§7.4) */
  deliverableNames: Record<string, string>;
  techTargetNames: Record<string, string>;
  selectedId: string | null;
  /** 이름 편집 중인 행과 그 입력값. 값은 화면 상태로 들고 있어야 저장 실패에도 살아남는다 (O-3) */
  renaming: { id: string; draft: string } | null;
  collapsedIds: ReadonlySet<string>;
  dragId: string | null;
  dropTarget: { id: string; zone: DropZone } | null;
  busy: boolean;
  focusToken: number;
  callbacks: TreeRowCallbacks;
}

const COLUMN_COUNT = 10;

// §5.5: name이 있으면 name, 없으면 order+1 + '차년도'
function yearLabel(year: Year): string {
  return year.name.trim() || `${year.order + 1}차년도`;
}

export default function TreeTable({
  groups,
  todayISO,
  memberNames,
  orgNames,
  deliverableNames,
  techTargetNames,
  selectedId,
  renaming,
  collapsedIds,
  dragId,
  dropTarget,
  busy,
  focusToken,
  callbacks,
}: TreeTableProps) {
  return (
    <div className="overflow-x-auto rounded-xl border border-grey-200 bg-white">
      <table className="w-full min-w-[1100px] border-collapse">
        <colgroup>
          <col className="w-20" />
          <col />
          <col className="w-28" />
          <col className="w-28" />
          <col className="w-24" />
          <col className="w-20" />
          <col className="w-36" />
          <col className="w-52" />
          <col className="w-24" />
          <col className="w-28" />
        </colgroup>
        <thead className="sticky top-0 z-10 bg-grey-50 text-left text-xs font-semibold text-grey-500">
          <tr className="border-b border-grey-200">
            <th className="px-2 py-2">WBS</th>
            <th className="px-2 py-2">작업명</th>
            <th className="px-2 py-2">담당</th>
            <th className="px-2 py-2">기관</th>
            <th className="px-2 py-2">상태</th>
            <th className="px-2 py-2">우선순위</th>
            <th className="px-2 py-2">진척률</th>
            <th className="px-2 py-2">기간</th>
            <th className="px-2 py-2">공수</th>
            <th className="px-2 py-2">연계</th>
          </tr>
        </thead>

        {groups.map((group) => (
          <tbody key={group.year.id}>
            <tr className="border-b border-grey-200 bg-grey-100/70">
              <td colSpan={COLUMN_COUNT} className="px-2 py-2">
                <div className="flex items-center gap-3">
                  <span className="font-semibold text-grey-700">{yearLabel(group.year)}</span>
                  <Badge tone="violet">{YEAR_STATUS_LABELS[group.year.status]}</Badge>
                  <ProgressBar
                    value={group.yearProgress}
                    showValue={false}
                    label="연차 진척률"
                    className="w-40"
                  />
                  {/* 중간 계산은 소수점을 유지하고 표시에서만 자른다 (P-8) */}
                  <span className="text-xs font-semibold text-grey-600 tabular-nums">
                    {group.yearProgress.toFixed(1)}%
                  </span>
                  <span
                    className="text-xs text-grey-500"
                    // P-13: 작업이 없는 연차도 진척률 0으로 상위 평균에 포함된다
                    title={group.totalCount === 0 ? '작업 없음 (진척률 0으로 집계됩니다)' : undefined}
                  >
                    작업 {group.totalCount}건
                    {group.rows.length !== group.totalCount && ` · 표시 ${group.rows.length}건`}
                  </span>
                </div>
              </td>
            </tr>

            {group.rows.length === 0 ? (
              <tr>
                <td colSpan={COLUMN_COUNT} className="px-4 py-6 text-center text-sm text-grey-500">
                  {group.totalCount === 0
                    ? '이 연차에는 작업이 없습니다. [새 작업]으로 첫 작업을 만드세요.'
                    : '필터에 맞는 작업이 없습니다.'}
                </td>
              </tr>
            ) : (
              group.rows.map((node) => (
                <TreeRow
                  key={node.task.id}
                  node={node}
                  todayISO={todayISO}
                  memberNames={memberNames}
                  orgNames={orgNames}
                  deliverableNames={deliverableNames}
                  techTargetNames={techTargetNames}
                  selected={selectedId === node.task.id}
                  collapsed={collapsedIds.has(node.task.id)}
                  renameDraft={renaming?.id === node.task.id ? renaming.draft : null}
                  dragging={dragId === node.task.id}
                  dropZone={dropTarget?.id === node.task.id ? dropTarget.zone : null}
                  busy={busy}
                  focusToken={selectedId === node.task.id ? focusToken : 0}
                  callbacks={callbacks}
                />
              ))
            )}
          </tbody>
        ))}
      </table>
    </div>
  );
}
