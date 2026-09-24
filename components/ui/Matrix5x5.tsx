'use client';

// 5×5 히트맵 (SOT §7.11 리스크 매트릭스, §7.6 우선순위 매트릭스)
//
// §7.6이 "§7.11 리스크 매트릭스와 같은 컴포넌트를 공유한다"고 정한다. 두 화면이 쓰는 것은
// 축·셀 개수·클릭 필터라는 **표 자체**뿐이고, 점수·색상 토큰·개수는 전부 서버가 끝낸 값이다 —
// 이 컴포넌트는 계산을 하지 않는다. 판정을 화면으로 끌어오면 규칙이 두 곳에 생긴다 (O-4).
//
// 축 이름만 다르다: 리스크는 (가로 발생가능성 × 세로 영향도), 보드는 (가로 긴급도 × 세로 중요도).

import type { ReactNode } from 'react';

export type MatrixLevel = 1 | 2 | 3 | 4 | 5;

/** 셀 하나. 좌표(x=가로, y=세로)와 표시값은 호출자가 계산해 넘긴다 */
export interface Matrix5x5Cell {
  x: MatrixLevel;
  y: MatrixLevel;
  score: number;
  colorToken: string;
  count: number;
}

export interface Matrix5x5Selection {
  x: MatrixLevel;
  y: MatrixLevel;
}

export interface Matrix5x5ColorClasses {
  cell: string;
  cellSelected: string;
}

export interface Matrix5x5Props {
  /** 카드 제목 (예: '리스크 매트릭스 (5×5)') */
  title: string;
  /** section의 aria-label (예: '리스크 매트릭스') */
  ariaLabel: string;
  /** 제목 옆 안내 문구 */
  description: string;
  /** 가로축 이름 (예: '발생가능성', '긴급도') */
  xAxisLabel: string;
  /** 세로축 이름 (예: '영향도', '중요도') */
  yAxisLabel: string;
  /** caption에 쓰는 셀 내용물의 이름 (예: '리스크', '작업') */
  unitNoun: string;
  /** 25칸. 순서와 무관하게 좌표로 찾는다 */
  cells: readonly Matrix5x5Cell[];
  selected: Matrix5x5Selection | null;
  onSelect: (selection: Matrix5x5Selection | null) => void;
  /** 색상 토큰(부록 A.3) → Tailwind 클래스. 토큰 해석은 화면별 severity 모듈이 한다 */
  colorClasses: (colorToken: string) => Matrix5x5ColorClasses;
  legend?: ReactNode;
  /** 드롭을 받을 때만 넘긴다. 없으면 드래그 관련 속성이 붙지 않는다 (리스크 화면) */
  onCellDrop?: (selection: Matrix5x5Selection) => void;
  onCellDragOver?: (selection: Matrix5x5Selection | null) => void;
  dropTarget?: Matrix5x5Selection | null;
}

const LEVELS: readonly MatrixLevel[] = [1, 2, 3, 4, 5];

function keyOf(x: number, y: number): string {
  return `${x}:${y}`;
}

export default function Matrix5x5({
  title,
  ariaLabel,
  description,
  xAxisLabel,
  yAxisLabel,
  unitNoun,
  cells,
  selected,
  onSelect,
  colorClasses,
  legend,
  onCellDrop,
  onCellDragOver,
  dropTarget = null,
}: Matrix5x5Props) {
  const byKey = new Map(cells.map((cell) => [keyOf(cell.x, cell.y), cell]));
  const droppable = onCellDrop !== undefined;

  return (
    <section aria-label={ariaLabel} className="rounded-xl border border-grey-200 bg-surface p-4">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="text-sm font-bold text-grey-900">{title}</h2>
        <p className="text-xs text-grey-500">{description}</p>
      </div>

      <div className="mt-3 overflow-x-auto">
        <table className="border-separate border-spacing-1 text-center text-xs">
          <caption className="sr-only">
            세로축 {yAxisLabel}(1~5), 가로축 {xAxisLabel}(1~5). 각 칸은 해당 조합의 {unitNoun}{' '}
            개수입니다.
          </caption>
          <thead>
            <tr>
              <th scope="col" className="w-20 px-1 py-1 text-right align-bottom text-grey-500">
                {yAxisLabel} ↓
              </th>
              {LEVELS.map((x) => (
                <th key={x} scope="col" className="w-16 px-1 py-1 font-semibold text-grey-600">
                  {x}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {/* 위에서 아래로 세로축 5 → 1 */}
            {[...LEVELS].reverse().map((y) => (
              <tr key={y}>
                <th scope="row" className="px-1 py-1 text-right font-semibold text-grey-600">
                  {y}
                </th>
                {LEVELS.map((x) => {
                  const cell = byKey.get(keyOf(x, y));
                  // 서버가 25칸을 모두 만들어 준다. 없으면 조회 모델이 깨진 것이므로 드러낸다.
                  if (!cell) {
                    return (
                      <td key={x} className="px-1 py-1 text-red-600">
                        ?
                      </td>
                    );
                  }

                  const isSelected = selected !== null && selected.x === x && selected.y === y;
                  const isDropTarget =
                    dropTarget !== null && dropTarget.x === x && dropTarget.y === y;
                  const classes = colorClasses(cell.colorToken);

                  return (
                    <td key={x} className="p-0">
                      <button
                        type="button"
                        aria-pressed={isSelected}
                        aria-label={`${xAxisLabel} ${x} × ${yAxisLabel} ${y} (점수 ${cell.score}) — ${cell.count}건`}
                        title={`점수 ${cell.score} · ${cell.count}건`}
                        onClick={() => onSelect(isSelected ? null : { x, y })}
                        {...(droppable
                          ? {
                              onDragOver: (e) => {
                                e.preventDefault(); // preventDefault를 해야 drop 이벤트가 발생한다
                                e.dataTransfer.dropEffect = 'move';
                                onCellDragOver?.({ x, y });
                              },
                              onDragLeave: () => onCellDragOver?.(null),
                              onDrop: (e) => {
                                e.preventDefault();
                                onCellDragOver?.(null);
                                onCellDrop?.({ x, y });
                              },
                            }
                          : {})}
                        className={`flex h-14 w-16 flex-col items-center justify-center rounded-lg border transition ${
                          isSelected ? classes.cellSelected : classes.cell
                        } ${cell.count === 0 ? 'opacity-45' : ''} ${
                          isDropTarget ? 'ring-2 ring-blue-500' : ''
                        }`}
                      >
                        <span className="text-base font-bold tabular-nums">{cell.count}</span>
                        <span className="text-[10px] opacity-70 tabular-nums">{cell.score}점</span>
                      </button>
                    </td>
                  );
                })}
              </tr>
            ))}
            <tr>
              <td />
              <td colSpan={LEVELS.length} className="pt-1 text-right text-grey-500">
                {xAxisLabel} →
              </td>
            </tr>
          </tbody>
        </table>
      </div>

      {legend}
    </section>
  );
}
