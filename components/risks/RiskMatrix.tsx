'use client';

// 5×5 리스크 히트맵 (SOT §7.11 "가로 발생가능성, 세로 영향도. 셀에 리스크 개수. 클릭 시 필터링")
// 셀 구성·점수·색상은 전부 서버(actions/risks.ts → lib/risk.ts)가 끝낸 값이다.
// 여기서 score = probability × impact를 다시 계산하지 않는다 (§5.13, §6.5).
//
// 표 자체는 components/ui/Matrix5x5가 그린다 — §7.6 우선순위 매트릭스와 같은 컴포넌트를
// 공유하라는 규정에 따라 5×5 격자·선택 동작을 한 곳에 두고, 이 파일은 리스크의 축 이름과
// 개수 기준(해결/종료 토글)만 정한다.
//
// 개수는 목록과 같은 기준으로 센다 — "해결/종료 표시"가 꺼져 있으면 미해결만 센다.
// 매트릭스와 목록의 건수가 서로 다르면 사용자는 어느 쪽을 믿어야 할지 알 수 없다.

import type { RiskLevel } from '@/types';
import type { RiskMatrixCell } from '@/actions/risks';
import Matrix5x5, { type Matrix5x5Cell } from '@/components/ui/Matrix5x5';
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

function cellCount(cell: RiskMatrixCell, showResolved: boolean): number {
  return cell.activeIds.length + (showResolved ? cell.inactiveIds.length : 0);
}

export default function RiskMatrix({
  cells,
  showResolved,
  selected,
  onSelect,
}: RiskMatrixProps) {
  // 가로축 = 발생가능성, 세로축 = 영향도 (§7.11)
  const gridCells: Matrix5x5Cell[] = cells.map((cell) => ({
    x: cell.probability,
    y: cell.impact,
    score: cell.score,
    colorToken: cell.colorToken,
    count: cellCount(cell, showResolved),
  }));

  return (
    <Matrix5x5
      title="리스크 매트릭스 (5×5)"
      ariaLabel="리스크 매트릭스"
      description="셀을 누르면 아래 목록이 그 조합만 보여줍니다. 다시 누르면 해제됩니다."
      xAxisLabel="발생가능성"
      yAxisLabel="영향도"
      unitNoun="리스크"
      cells={gridCells}
      colorClasses={riskColorClasses}
      selected={selected === null ? null : { x: selected.probability, y: selected.impact }}
      onSelect={(next) =>
        onSelect(next === null ? null : { probability: next.x, impact: next.y })
      }
      legend={
        // 등급 경계는 부록 A.3이 원본이다 — 여기서는 색만 안내한다
        <div className="mt-2 flex flex-wrap items-center gap-3 text-[11px] text-grey-500">
          <span className="inline-flex items-center gap-1">
            <span className="inline-block h-3 w-3 rounded border border-red-200 bg-red-50" /> 고위험
          </span>
          <span className="inline-flex items-center gap-1">
            <span className="inline-block h-3 w-3 rounded border border-orange-200 bg-orange-50" />{' '}
            중위험
          </span>
          <span className="inline-flex items-center gap-1">
            <span className="inline-block h-3 w-3 rounded border border-green-200 bg-green-50" />{' '}
            저위험
          </span>
        </div>
      }
    />
  );
}
