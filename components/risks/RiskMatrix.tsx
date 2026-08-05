'use client';

// 5×5 리스크 히트맵 (SOT §7.11 "가로 발생가능성, 세로 영향도. 셀에 리스크 개수. 클릭 시 필터링")
// 셀 구성·점수·색상은 전부 서버(actions/risks.ts → lib/risk.ts)가 끝낸 값이다.
// 여기서 score = probability × impact를 다시 계산하지 않는다 (§5.13, §6.5).
//
// 개수는 목록과 같은 기준으로 센다 — "해결/종료 표시"가 꺼져 있으면 미해결만 센다.
// 매트릭스와 목록의 건수가 서로 다르면 사용자는 어느 쪽을 믿어야 할지 알 수 없다.

import type { RiskLevel } from '@/types';
import type { RiskMatrixCell } from '@/actions/risks';
import { riskColorClasses } from './severity';

/** 선택된 셀 — null이면 필터 없음 */
export interface MatrixSelection {
  probability: RiskLevel;
  impact: RiskLevel;
}

export interface RiskMatrixProps {
  /** impact 5→1, probability 1→5 순으로 정렬된 25칸 */
  cells: RiskMatrixCell[];
  /** §7.11 해결/종료 표시 토글 — 켜져 있으면 셀 개수에도 더한다 */
  showResolved: boolean;
  selected: MatrixSelection | null;
  onSelect: (selection: MatrixSelection | null) => void;
}

const LEVELS: readonly RiskLevel[] = [1, 2, 3, 4, 5];

function cellCount(cell: RiskMatrixCell, showResolved: boolean): number {
  return cell.activeIds.length + (showResolved ? cell.inactiveIds.length : 0);
}

export default function RiskMatrix({
  cells,
  showResolved,
  selected,
  onSelect,
}: RiskMatrixProps) {
  const byKey = new Map(cells.map((cell) => [`${cell.probability}:${cell.impact}`, cell]));

  return (
    <section
      aria-label="리스크 매트릭스"
      className="rounded-xl border border-slate-200 bg-white p-4"
    >
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="text-sm font-bold text-slate-900">리스크 매트릭스 (5×5)</h2>
        <p className="text-xs text-slate-500">
          셀을 누르면 아래 목록이 그 조합만 보여줍니다. 다시 누르면 해제됩니다.
        </p>
      </div>

      <div className="mt-3 overflow-x-auto">
        <table className="border-separate border-spacing-1 text-center text-xs">
          <caption className="sr-only">
            세로축 영향도(1~5), 가로축 발생가능성(1~5). 각 칸은 해당 조합의 리스크 개수입니다.
          </caption>
          <thead>
            <tr>
              <th scope="col" className="w-20 px-1 py-1 text-right align-bottom text-slate-500">
                영향도 ↓
              </th>
              {LEVELS.map((probability) => (
                <th
                  key={probability}
                  scope="col"
                  className="w-16 px-1 py-1 font-semibold text-slate-600"
                >
                  {probability}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {/* 위에서 아래로 영향도 5 → 1 */}
            {[...LEVELS].reverse().map((impact) => (
              <tr key={impact}>
                <th scope="row" className="px-1 py-1 text-right font-semibold text-slate-600">
                  {impact}
                </th>
                {LEVELS.map((probability) => {
                  const cell = byKey.get(`${probability}:${impact}`);
                  // 서버가 25칸을 모두 만들어 준다. 없으면 조회 모델이 깨진 것이므로 드러낸다.
                  if (!cell) {
                    return (
                      <td key={probability} className="px-1 py-1 text-red-600">
                        ?
                      </td>
                    );
                  }

                  const count = cellCount(cell, showResolved);
                  const isSelected =
                    selected !== null &&
                    selected.probability === probability &&
                    selected.impact === impact;
                  const classes = riskColorClasses(cell.colorToken);

                  return (
                    <td key={probability} className="p-0">
                      <button
                        type="button"
                        aria-pressed={isSelected}
                        aria-label={`발생가능성 ${probability} × 영향도 ${impact} (점수 ${cell.score}) — ${count}건`}
                        title={`점수 ${cell.score} · ${count}건`}
                        onClick={() =>
                          onSelect(isSelected ? null : { probability, impact })
                        }
                        className={`flex h-14 w-16 flex-col items-center justify-center rounded-lg border transition ${
                          isSelected ? classes.cellSelected : classes.cell
                        } ${count === 0 ? 'opacity-45' : ''}`}
                      >
                        <span className="text-base font-bold tabular-nums">{count}</span>
                        <span className="text-[10px] opacity-70 tabular-nums">{cell.score}점</span>
                      </button>
                    </td>
                  );
                })}
              </tr>
            ))}
            <tr>
              <td />
              <td colSpan={LEVELS.length} className="pt-1 text-right text-slate-500">
                발생가능성 →
              </td>
            </tr>
          </tbody>
        </table>
      </div>

      {/* 등급 경계는 부록 A.3이 원본이다 — 여기서는 색만 안내한다 */}
      <div className="mt-2 flex flex-wrap items-center gap-3 text-[11px] text-slate-500">
        <span className="inline-flex items-center gap-1">
          <span className="inline-block h-3 w-3 rounded border border-red-200 bg-red-50" /> 고위험
        </span>
        <span className="inline-flex items-center gap-1">
          <span className="inline-block h-3 w-3 rounded border border-amber-200 bg-amber-50" />{' '}
          중위험
        </span>
        <span className="inline-flex items-center gap-1">
          <span className="inline-block h-3 w-3 rounded border border-emerald-200 bg-emerald-50" />{' '}
          저위험
        </span>
      </div>
    </section>
  );
}
