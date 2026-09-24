'use client';

// 원본 미리보기 그리드 (SOT §7.9.1 Step 2)
//
// 서버가 준 그리드는 **병합 확장 전 원본**이다 (lib/import-adapter.toGridPreview 주석) —
// 확장한 격자를 보여주면 사용자가 클릭으로 지정한 헤더 행 좌표가 원본과 어긋난다.
// 그래서 병합 범위를 rowSpan/colSpan으로 그대로 그린다.
//
// 표시만 하는 컴포넌트다. 감지·판정은 전부 서버(lib/import)의 결과를 받아 색으로 표현할 뿐이다.

import { useMemo } from 'react';
import type { SheetGridPreview } from '@/types';

export type PickTarget = 'header' | 'dataStart';

export interface SheetGridProps {
  grid: SheetGridPreview;
  /** 사용자가 확정한 헤더 행 (0-based). 없으면 null */
  headerRow: number | null;
  /** 자동 추정 헤더 행 — 확정값과 다르면 흐린 하이라이트로 함께 보여준다 */
  suggestedHeaderRow: number | null;
  dataStartRow: number;
  /** 라벨 열 (0-based 열 인덱스) */
  labelColumnIndexes: readonly number[];
  /** 연차 열 (0-based 열 인덱스) */
  yearColumnIndexes: readonly number[];
  /** S-5로 자동 제외된 합계 열 */
  totalColumnIndexes: readonly number[];
  /** 행 클릭이 무엇을 지정하는지 */
  pickTarget: PickTarget;
  onPickRow: (rowIndex: number) => void;
  disabled?: boolean;
}

function columnLetter(index: number): string {
  let n = index;
  let out = '';
  while (n >= 0) {
    out = String.fromCharCode((n % 26) + 65) + out;
    n = Math.floor(n / 26) - 1;
  }
  return out;
}

interface Span {
  rowSpan: number;
  colSpan: number;
}

/** 병합 앵커의 span + 앵커가 가린 셀 좌표. 표시 범위 밖으로 나가는 병합은 잘라 그린다 */
function buildMergeMaps(grid: SheetGridPreview): {
  spans: Map<string, Span>;
  covered: Set<string>;
} {
  const spans = new Map<string, Span>();
  const covered = new Set<string>();
  const lastRow = grid.rows.length - 1;
  const lastCol = grid.totalColumns - 1;

  for (const merge of grid.merges) {
    const endRow = Math.min(merge.e.r, lastRow);
    const endCol = Math.min(merge.e.c, lastCol);
    if (merge.s.r > lastRow || merge.s.c > lastCol) continue;
    spans.set(`${merge.s.r}:${merge.s.c}`, {
      rowSpan: endRow - merge.s.r + 1,
      colSpan: endCol - merge.s.c + 1,
    });
    for (let r = merge.s.r; r <= endRow; r += 1) {
      for (let c = merge.s.c; c <= endCol; c += 1) {
        if (r === merge.s.r && c === merge.s.c) continue;
        covered.add(`${r}:${c}`);
      }
    }
  }
  return { spans, covered };
}

export default function SheetGrid({
  grid,
  headerRow,
  suggestedHeaderRow,
  dataStartRow,
  labelColumnIndexes,
  yearColumnIndexes,
  totalColumnIndexes,
  pickTarget,
  onPickRow,
  disabled = false,
}: SheetGridProps) {
  const { spans, covered } = useMemo(() => buildMergeMaps(grid), [grid]);
  const labelCols = useMemo(() => new Set(labelColumnIndexes), [labelColumnIndexes]);
  const yearCols = useMemo(() => new Set(yearColumnIndexes), [yearColumnIndexes]);
  const totalCols = useMemo(() => new Set(totalColumnIndexes), [totalColumnIndexes]);

  const columnCount = grid.totalColumns;

  return (
    <div className="rounded-xl border border-grey-200">
      <div className="flex flex-wrap items-center gap-3 border-b border-grey-200 bg-grey-50 px-3 py-2 text-xs text-grey-600">
        <span className="font-semibold text-grey-700">{grid.sheetName}</span>
        <span>
          {grid.totalRows.toLocaleString()}행 × {grid.totalColumns}열
        </span>
        {grid.truncated && <span className="text-grey-400">상위 {grid.rows.length}행만 표시</span>}
        <span className="ml-auto flex items-center gap-2">
          <LegendSwatch className="bg-blue-100" label="헤더 행" />
          <LegendSwatch className="bg-green-100" label="데이터 시작" />
          <LegendSwatch className="bg-orange-50" label="라벨 열" />
          <LegendSwatch className="bg-purple-50" label="연차 열" />
          <LegendSwatch className="bg-grey-200" label="합계 열(제외)" />
        </span>
      </div>

      <div className="max-h-[22rem] overflow-auto">
        <table className="w-max min-w-full border-collapse text-xs">
          <thead className="sticky top-0 z-10 bg-white">
            <tr>
              <th className="sticky left-0 z-20 w-14 border border-grey-200 bg-grey-100 px-1 py-1 text-grey-500">
                행
              </th>
              {Array.from({ length: columnCount }, (_, c) => (
                <th
                  key={c}
                  className={`border border-grey-200 px-2 py-1 font-mono font-normal text-grey-500 ${
                    yearCols.has(c)
                      ? 'bg-purple-100'
                      : labelCols.has(c)
                        ? 'bg-orange-100'
                        : totalCols.has(c)
                          ? 'bg-grey-200'
                          : 'bg-grey-50'
                  }`}
                >
                  {columnLetter(c)}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {grid.rows.map((row, r) => {
              const isHeader = headerRow === r;
              const isSuggested = suggestedHeaderRow === r && headerRow !== r;
              const isDataStart = dataStartRow === r;
              return (
                <tr
                  key={r}
                  className={
                    isHeader
                      ? 'bg-blue-50'
                      : isDataStart
                        ? 'bg-green-50'
                        : isSuggested
                          ? 'bg-blue-50/40'
                          : ''
                  }
                >
                  <th className="sticky left-0 z-10 border border-grey-200 bg-grey-100 p-0 text-grey-500">
                    <button
                      type="button"
                      disabled={disabled}
                      onClick={() => onPickRow(r)}
                      title={
                        pickTarget === 'header'
                          ? `${r + 1}행을 헤더 행으로 지정`
                          : `${r + 1}행을 데이터 시작 행으로 지정`
                      }
                      className="w-full px-1 py-1 text-center hover:bg-grey-200 disabled:cursor-not-allowed disabled:opacity-50"
                    >
                      {r + 1}
                      {isHeader && <span className="ml-0.5 text-blue-600">H</span>}
                      {isDataStart && <span className="ml-0.5 text-green-600">D</span>}
                      {isSuggested && <span className="ml-0.5 text-blue-300">h</span>}
                    </button>
                  </th>
                  {Array.from({ length: columnCount }, (_, c) => {
                    if (covered.has(`${r}:${c}`)) return null;
                    const span = spans.get(`${r}:${c}`);
                    const cell = row[c];
                    const text = cell?.text ?? '';
                    return (
                      <td
                        key={c}
                        rowSpan={span?.rowSpan}
                        colSpan={span?.colSpan}
                        className={`max-w-[14rem] truncate border border-grey-200 px-2 py-1 align-top ${
                          cell?.isError
                            ? 'bg-red-50 font-semibold text-red-700'
                            : yearCols.has(c)
                              ? 'bg-purple-50/60'
                              : labelCols.has(c)
                                ? 'bg-orange-50/60'
                                : totalCols.has(c)
                                  ? 'bg-grey-100 text-grey-400'
                                  : ''
                        }`}
                        title={text}
                      >
                        {text}
                      </td>
                    );
                  })}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function LegendSwatch({ className, label }: { className: string; label: string }) {
  return (
    <span className="inline-flex items-center gap-1">
      <span className={`inline-block h-2.5 w-2.5 rounded-sm border border-grey-300 ${className}`} />
      {label}
    </span>
  );
}
