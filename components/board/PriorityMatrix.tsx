'use client';

// 우선순위 매트릭스 뷰 (SOT §7.6 매트릭스 뷰, §6.9)
//  - 5×5 히트맵: 가로 긴급도, 세로 중요도. 셀에 작업 개수. 클릭 시 필터링.
//    표는 components/ui/Matrix5x5를 §7.11 리스크 매트릭스와 함께 쓴다.
//  - 우측에 점수 내림차순 목록 (작업명·WBS 코드·담당·마감일·점수 뱃지)
//  - 리프 Task만(PR-9), 완료 항목 기본 숨김(PR-6)
//  - 목록의 카드를 셀로 끌면 **중요도**가 바뀐다. 긴급도는 마감일 기반이라 드래그로 바꾸지
//    않고, urgencyMode='manual'로 고정된 작업일 때만 함께 바뀐다 (PR-4).
// 점수·등급은 서버(actions/board.ts → lib/priority.ts)가 끝낸 값이다 — 여기서 계산하지 않는다.

import type { PriorityMatrixData, PriorityMatrixItem } from '@/actions/board';
import Matrix5x5, { type Matrix5x5Cell, type Matrix5x5Selection } from '@/components/ui/Matrix5x5';
import Badge from '@/components/ui/Badge';
import { priorityColorClasses } from './priority-colors';

const DELETED_MEMBER = '(삭제된 인력)';

export interface PriorityMatrixProps {
  data: PriorityMatrixData;
  memberNames: Record<string, string>;
  /** PR-6: 완료 항목 기본 숨김 */
  showDone: boolean;
  onShowDoneChange: (show: boolean) => void;
  selected: Matrix5x5Selection | null;
  onSelect: (selection: Matrix5x5Selection | null) => void;
  draggingId: string | null;
  dropCell: Matrix5x5Selection | null;
  busy: boolean;
  onItemDragStart: (id: string) => void;
  onItemDragEnd: () => void;
  onCellDragOver: (selection: Matrix5x5Selection | null) => void;
  onCellDrop: (selection: Matrix5x5Selection) => void;
  /** PR-4 긴급도 고정 토글 — 고정해야 드래그로 긴급도를 바꿀 수 있다 */
  onTogglePin: (item: PriorityMatrixItem) => void;
}

export default function PriorityMatrix({
  data,
  memberNames,
  showDone,
  onShowDoneChange,
  selected,
  onSelect,
  draggingId,
  dropCell,
  busy,
  onItemDragStart,
  onItemDragEnd,
  onCellDragOver,
  onCellDrop,
  onTogglePin,
}: PriorityMatrixProps) {
  // 셀 개수는 목록과 같은 기준으로 센다 — "완료 표시"가 꺼져 있으면 미완료만 센다.
  // 두 숫자가 어긋나면 사용자는 어느 쪽을 믿어야 할지 알 수 없다 (리스크 매트릭스와 같은 규칙).
  const gridCells: Matrix5x5Cell[] = data.cells.map((cell) => ({
    x: cell.urgency,
    y: cell.importance,
    score: cell.score,
    colorToken: cell.colorToken,
    count: cell.activeIds.length + (showDone ? cell.doneIds.length : 0),
  }));

  const visible = data.items.filter((item) => {
    if (!showDone && item.status === 'done') return false;
    if (selected === null) return true;
    return item.importance === selected.y && item.urgency === selected.x;
  });

  return (
    <div className="flex flex-col gap-4 lg:flex-row lg:items-start">
      <div className="shrink-0">
        <Matrix5x5
          title="우선순위 매트릭스 (5×5)"
          ariaLabel="우선순위 매트릭스"
          description="셀을 누르면 오른쪽 목록이 그 조합만 보여줍니다. 목록의 작업을 셀로 끌면 중요도가 바뀝니다."
          xAxisLabel="긴급도"
          yAxisLabel="중요도"
          unitNoun="작업"
          cells={gridCells}
          colorClasses={priorityColorClasses}
          selected={selected}
          onSelect={onSelect}
          onCellDragOver={onCellDragOver}
          onCellDrop={onCellDrop}
          dropTarget={dropCell}
          legend={
            <div className="mt-2 space-y-1 text-[11px] text-grey-500">
              <p>
                긴급도는 마감일에서 자동 계산됩니다(§6.9.1). 드래그로 긴급도를 바꾸려면 먼저
                목록에서 📌 고정을 켜세요 (PR-4).
              </p>
              <p>리프 작업만 표시합니다 (PR-9). 완료 항목은 기본으로 숨깁니다.</p>
            </div>
          }
        />
      </div>

      <section aria-label="우선순위 정렬 목록" className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-3 text-sm">
          <h2 className="font-bold text-grey-900">우선순위 정렬 (점수 내림차순)</h2>
          <label className="flex items-center gap-2 text-grey-700">
            <input
              type="checkbox"
              checked={showDone}
              onChange={(e) => onShowDoneChange(e.target.checked)}
              className="h-4 w-4 rounded border-grey-300"
            />
            완료 항목 표시
          </label>
          {selected !== null && (
            <div className="flex items-center gap-2 rounded-full bg-blue-50 px-3 py-1 text-xs text-blue-800">
              <span>
                중요도 {selected.y} × 긴급도 {selected.x} 필터
              </span>
              <button
                type="button"
                onClick={() => onSelect(null)}
                aria-label="매트릭스 필터 해제"
                className="font-bold text-blue-500 hover:text-blue-800"
              >
                ×
              </button>
            </div>
          )}
          <span className="text-xs text-grey-500">표시 {visible.length}건</span>
        </div>

        <div className="mt-2 overflow-x-auto rounded-xl border border-grey-200 bg-surface">
          <table className="w-full text-sm">
            <thead className="bg-grey-50 text-xs text-grey-500">
              <tr>
                <th scope="col" className="px-2 py-1.5 text-left font-semibold">
                  코드
                </th>
                <th scope="col" className="px-2 py-1.5 text-left font-semibold">
                  작업명
                </th>
                <th scope="col" className="px-2 py-1.5 text-left font-semibold">
                  담당
                </th>
                <th scope="col" className="px-2 py-1.5 text-left font-semibold">
                  마감일
                </th>
                <th scope="col" className="px-2 py-1.5 text-right font-semibold">
                  점수
                </th>
                <th scope="col" className="px-2 py-1.5 text-center font-semibold">
                  고정
                </th>
              </tr>
            </thead>
            <tbody>
              {visible.length === 0 ? (
                <tr>
                  <td colSpan={6} className="px-2 py-6 text-center text-sm text-grey-500">
                    표시할 작업이 없습니다.
                  </td>
                </tr>
              ) : (
                visible.map((item) => {
                  const colors = priorityColorClasses(item.colorToken);
                  const done = item.status === 'done';
                  const ownerName =
                    item.ownerMemberId === null
                      ? null
                      : (memberNames[item.ownerMemberId] ?? DELETED_MEMBER);
                  return (
                    <tr
                      key={item.id}
                      draggable={!busy}
                      onDragStart={(e) => {
                        e.dataTransfer.effectAllowed = 'move';
                        e.dataTransfer.setData('text/plain', item.id);
                        onItemDragStart(item.id);
                      }}
                      onDragEnd={onItemDragEnd}
                      className={`border-t border-grey-100 ${
                        draggingId === item.id ? 'opacity-40' : 'hover:bg-grey-50'
                      } ${done ? 'text-grey-400' : 'text-grey-700'}`}
                    >
                      <td className="px-2 py-1.5 font-mono text-xs text-grey-400">
                        {item.wbsCode}
                      </td>
                      <td className="px-2 py-1.5">
                        <span className="flex items-center gap-1.5">
                          <span
                            aria-hidden
                            title={`중요도 ${item.importance} × 긴급도 ${item.urgency} = ${item.score} (${item.grade})`}
                            className={`inline-block h-3 w-1 shrink-0 rounded-full ${colors.band}`}
                          />
                          <span className={`truncate ${done ? 'line-through' : ''}`} title={item.title}>
                            {item.title}
                          </span>
                        </span>
                      </td>
                      <td className="px-2 py-1.5 text-xs">
                        {ownerName ?? <span className="text-grey-300">—</span>}
                      </td>
                      <td
                        className={`px-2 py-1.5 text-xs whitespace-nowrap ${
                          item.overdue ? 'font-semibold text-red-600' : ''
                        }`}
                      >
                        {item.dueDate === null ? (
                          <span className="text-grey-300">—</span>
                        ) : (
                          <span title={item.overdue ? '마감일이 지났습니다' : undefined}>
                            {item.dueDate} ({item.dday})
                          </span>
                        )}
                      </td>
                      <td className="px-2 py-1.5 text-right">
                        {/* PR-6: 완료 항목은 등급은 그대로 두고 표시만 흐리게 한다 */}
                        <Badge tone={colors.badge} className={done ? 'opacity-60' : ''}>
                          {item.score}
                        </Badge>
                      </td>
                      <td className="px-2 py-1.5 text-center">
                        <button
                          type="button"
                          disabled={busy}
                          onClick={() => onTogglePin(item)}
                          aria-pressed={item.urgencyPinned}
                          title={
                            item.urgencyPinned
                              ? '긴급도 고정 중(수동). 누르면 마감일 기반 자동 계산으로 되돌립니다'
                              : '긴급도를 지금 값으로 고정합니다. 고정해야 드래그로 긴급도를 바꿀 수 있습니다 (PR-4)'
                          }
                          className={`rounded border px-1.5 py-0.5 text-[11px] ${
                            item.urgencyPinned
                              ? 'border-orange-300 bg-orange-50 text-orange-700'
                              : 'border-grey-200 text-grey-400 hover:bg-grey-100'
                          }`}
                        >
                          📌
                        </button>
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}
