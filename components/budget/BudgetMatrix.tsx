'use client';

// 비목 매트릭스 테이블 (SOT §7.9, §6.4 B-1~B-4, 부록 A.1·A.3)
// 행 = 비목 12개(부록 A.1 순서, 직접비/간접비 구분 표시), 열 = 연차(order asc) + 합계.
// 각 셀은 예산 / 집행 / 집행률 3값을 보여준다.
//
// 표시 규칙 — 숫자는 전부 서버(getBudgetMatrix → lib/budget.ts)가 계산한 값이다.
// 이 파일에는 나눗셈·백분율이 없다:
//  - B-1 planned=0 → 집행률 N/A(formatRate), 집행이 있으면 "예산 외 집행" 경고 아이콘
//  - B-2 cell.over(집행률 100% 초과) → red-600 계열로 표시. 저장은 막지 않는다
//  - B-3 yearBudgetChecks[yearId].mismatch → 연차 헤더에 경고 배지(title에 차액)
//  - B-4 표시는 currencyUnit으로 환산(formatAmount), 입력은 언제나 원 단위 정수

import { useEffect, useState } from 'react';
import type { BudgetCategory, BudgetItem, Settings } from '@/types';
import type { BudgetMatrix, BudgetMatrixCell, YearBudgetMismatch } from '@/lib/budget';
import { BUDGET_CATEGORY_GROUPS, BUDGET_CATEGORY_LABELS } from '@/lib/constants';
import { formatAmount } from '@/lib/currency';
import { formatRate } from '@/lib/goals';
import Badge from '@/components/ui/Badge';
import { setRealtimePaused } from '@/components/RealtimeRefresher';

export interface CellRef {
  yearId: string;
  category: BudgetCategory;
}

/** (연차, 비목) 키. yearId는 UUID라 '|'가 값에 섞이지 않는다 (lib/budget.ts와 같은 규칙) */
export function cellKey(yearId: string, category: BudgetCategory): string {
  return `${yearId}|${category}`;
}

export interface BudgetMatrixTableProps {
  matrix: BudgetMatrix;
  currencyUnit: Settings['currencyUnit'];
  /** B-3 판정. 값이 null이면 비교 대상(year.budget)이 없어 배지를 띄우지 않는다 */
  yearBudgetChecks: Record<string, YearBudgetMismatch | null>;
  /** 셀별 원본 행 — 현금/현물 분리 여부로 총액 인라인 편집 가능 여부가 갈린다 */
  itemsByCell: Map<string, BudgetItem[]>;
  selected: CellRef | null;
  busy: boolean;
  onSelect: (cell: CellRef) => void;
  onInlineSave: (cell: CellRef, plannedAmount: number) => void;
}

// 총액 인라인 편집을 열 수 없는 이유. 이유 없이 막지 않고 title로 항상 밝힌다.
type LockReason = 'split' | 'missing' | 'duplicated' | null;

function lockMessage(reason: Exclude<LockReason, null>): string {
  if (reason === 'split') {
    return '현금·현물이 입력된 셀입니다. 총액은 현금 + 현물 합계로 자동 계산되므로 셀 상세 패널에서 현금·현물을 편집하세요.';
  }
  if (reason === 'missing') {
    return '이 연차·비목의 예산 행이 없습니다. 연차 생성 시 자동으로 만들어지는 행이므로 데이터가 어긋난 상태입니다.';
  }
  return '이 연차·비목에 예산 행이 2개 이상 있습니다. 어느 행을 고칠지 알 수 없어 편집을 막습니다. 관리자에게 알리세요.';
}

/** 계획액(총액) 인라인 편집기. 입력은 원 단위 정수다 (B-4) */
function PlannedInput({
  value,
  label,
  disabled,
  onSave,
}: {
  value: number;
  label: string;
  disabled: boolean;
  onSave: (plannedAmount: number) => void;
}) {
  const [draft, setDraft] = useState<string>(String(value));
  const [editing, setEditing] = useState(false);
  const [invalid, setInvalid] = useState(false);

  // 편집 중에는 서버 값을 따라가지 않는다 — 입력하던 값이 새로고침으로 덮이면 작업이 사라진다
  useEffect(() => {
    if (editing) return;
    setDraft(String(value));
  }, [value, editing]);

  // R-4: 셀을 편집하는 동안 자동 새로고침을 보류한다
  useEffect(() => {
    if (!editing) return;
    setRealtimePaused(true);
    return () => setRealtimePaused(false);
  }, [editing]);

  const commit = (): void => {
    setEditing(false);
    const trimmed = draft.trim();
    if (trimmed === '') {
      // 빈 값은 0원 저장으로 눙치지 않는다 — 원래 값으로 되돌리고 사실을 알린다
      setDraft(String(value));
      setInvalid(false);
      return;
    }
    const next = Number(trimmed);
    // B-4 + §5.12: 원 단위 정수, 0 이상. 서버도 거부하는 값이라 여기서 먼저 알린다
    if (!Number.isInteger(next) || next < 0) {
      setInvalid(true);
      return;
    }
    setInvalid(false);
    if (next === value) return;
    onSave(next);
  };

  return (
    <span className="inline-flex items-center gap-1">
      <input
        type="number"
        inputMode="numeric"
        min={0}
        step={1}
        value={draft}
        disabled={disabled}
        aria-label={`${label} 예산액(원)`}
        onFocus={() => setEditing(true)}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            e.currentTarget.blur();
          }
          if (e.key === 'Escape') {
            setDraft(String(value));
            setInvalid(false);
            setEditing(false);
            e.currentTarget.blur();
          }
        }}
        className={`w-28 rounded-md border px-1.5 py-1 text-right text-xs tabular-nums focus:outline-none ${
          invalid ? 'border-red-400 bg-red-50' : 'border-slate-300 focus:border-slate-500'
        }`}
      />
      <span className="text-[10px] text-slate-400">원</span>
      {invalid && (
        <span className="block text-[10px] text-red-600">0 이상 정수(원)만 저장됩니다.</span>
      )}
    </span>
  );
}

/** 집행액 + 집행률. 클릭하면 집행 내역 패널이 열린다 (§7.9) */
function ExecutionButton({
  cell,
  label,
  currencyUnit,
  onSelect,
}: {
  cell: BudgetMatrixCell;
  label: string;
  currencyUnit: Settings['currencyUnit'];
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onSelect}
      aria-label={`${label} 집행 내역 열기`}
      className="mt-1 block w-full rounded-md px-1.5 py-1 text-right hover:bg-slate-100"
    >
      <span className="block text-xs tabular-nums text-slate-600">
        집행 {formatAmount(cell.executed, currencyUnit)}
      </span>
      <span className="mt-0.5 flex items-center justify-end gap-1">
        {cell.offBudget && (
          // B-1: 계획액 0인데 집행이 있다. 아이콘만 두지 않고 title로 뜻을 밝힌다
          <span
            aria-label="예산 외 집행 경고"
            title="예산 외 집행: 계획액이 0인데 집행액이 있습니다 (B-1)"
            className="text-amber-600"
          >
            ⚠
          </span>
        )}
        <span
          // B-2: 집행률 100% 초과는 빨강 (부록 A.3 red-600)
          className={`text-xs font-semibold tabular-nums ${
            cell.over ? 'text-red-600' : 'text-slate-500'
          }`}
          title={cell.over ? '집행률이 100%를 넘었습니다 (B-2)' : undefined}
        >
          {formatRate(cell.rate)}
        </span>
      </span>
    </button>
  );
}

export default function BudgetMatrixTable({
  matrix,
  currencyUnit,
  yearBudgetChecks,
  itemsByCell,
  selected,
  busy,
  onSelect,
  onInlineSave,
}: BudgetMatrixTableProps) {
  const lockReasonOf = (cell: BudgetMatrixCell): LockReason => {
    const bucket = itemsByCell.get(cellKey(cell.yearId, cell.category)) ?? [];
    if (bucket.length === 0) return 'missing';
    if (bucket.length > 1) return 'duplicated';
    const item = bucket[0]!;
    // 현금·현물이 모두 비어 있는 셀만 총액을 자유롭게 고칠 수 있다.
    // 분리값이 있으면 총액은 합계라서, 화면이 차액을 임의 배분하지 않기 위해 잠근다 (§5.12)
    return item.cashAmount === null && item.inKindAmount === null ? null : 'split';
  };

  return (
    <div className="overflow-x-auto rounded-xl border border-slate-200 bg-white">
      <table className="w-full text-left text-sm">
        <caption className="sr-only">
          비목 × 연차 예산 매트릭스. 각 셀은 예산·집행·집행률입니다.
        </caption>
        <thead className="text-xs text-slate-500">
          <tr className="border-b border-slate-100">
            <th scope="col" className="px-3 py-2 font-medium">
              비목
            </th>
            {matrix.columns.map((column) => {
              const check = yearBudgetChecks[column.yearId] ?? null;
              return (
                <th key={column.yearId} scope="col" className="px-3 py-2 text-right font-medium">
                  <span className="block text-slate-700">{column.name}</span>
                  <span className="block text-[11px] font-normal tabular-nums text-slate-400">
                    연차 예산{' '}
                    {column.yearBudget === null
                      ? '미입력'
                      : formatAmount(column.yearBudget, currencyUnit)}
                  </span>
                  {check?.mismatch && (
                    // B-3: 연차 예산 합계와 year.budget 불일치. 저장은 막지 않고 사실만 알린다
                    <Badge
                      tone="amber"
                      className="mt-1"
                      title={`비목 편성 합계가 연차 예산보다 ${formatAmount(
                        Math.abs(check.diff),
                        currencyUnit
                      )} ${check.diff > 0 ? '많습니다' : '적습니다'} (B-3)`}
                    >
                      연차 예산 불일치
                    </Badge>
                  )}
                </th>
              );
            })}
            <th scope="col" className="px-3 py-2 text-right font-medium text-slate-700">
              합계
            </th>
          </tr>
        </thead>

        <tbody className="divide-y divide-slate-100">
          {matrix.rows.map((row, rowIndex) => {
            const group = BUDGET_CATEGORY_GROUPS[row.category];
            const previous = rowIndex === 0 ? undefined : matrix.rows[rowIndex - 1];
            const groupChanged =
              previous === undefined || BUDGET_CATEGORY_GROUPS[previous.category] !== group;

            return (
              <tr
                key={row.category}
                data-category={row.category}
                className={`align-top ${groupChanged && rowIndex > 0 ? 'border-t-2 border-t-slate-200' : ''}`}
              >
                <th scope="row" className="px-3 py-2 text-left font-medium text-slate-800">
                  {BUDGET_CATEGORY_LABELS[row.category]}
                  <span className="mt-0.5 block text-[11px] font-normal text-slate-400">
                    {/* 부록 A.1에서 'other'는 어느 쪽도 아니다 — 없는 구분을 지어내지 않는다 */}
                    {group ?? '구분 없음'}
                  </span>
                </th>

                {row.cells.map((cell) => {
                  const label = `${
                    matrix.columns.find((c) => c.yearId === cell.yearId)?.name ?? '연차'
                  } ${BUDGET_CATEGORY_LABELS[cell.category]}`;
                  const isSelected =
                    selected?.yearId === cell.yearId && selected?.category === cell.category;
                  const lock = lockReasonOf(cell);

                  return (
                    <td
                      key={cell.yearId}
                      className={`px-3 py-2 text-right ${cell.over ? 'bg-red-50' : ''} ${
                        isSelected ? 'ring-2 ring-inset ring-slate-900' : ''
                      }`}
                    >
                      {lock === null ? (
                        <PlannedInput
                          value={cell.planned}
                          label={label}
                          disabled={busy}
                          onSave={(planned) =>
                            onInlineSave({ yearId: cell.yearId, category: cell.category }, planned)
                          }
                        />
                      ) : (
                        <span
                          title={lockMessage(lock)}
                          className="inline-flex items-center gap-1 text-xs tabular-nums text-slate-700"
                        >
                          <span aria-hidden>🔒</span>
                          {formatAmount(cell.planned, currencyUnit)}
                        </span>
                      )}

                      <ExecutionButton
                        cell={cell}
                        label={label}
                        currencyUnit={currencyUnit}
                        onSelect={() =>
                          onSelect({ yearId: cell.yearId, category: cell.category })
                        }
                      />
                    </td>
                  );
                })}

                <td className="px-3 py-2 text-right">
                  <span className="block text-xs font-semibold tabular-nums text-slate-800">
                    {formatAmount(row.total.planned, currencyUnit)}
                  </span>
                  <span className="block text-xs tabular-nums text-slate-600">
                    집행 {formatAmount(row.total.executed, currencyUnit)}
                  </span>
                  <span
                    className={`block text-xs font-semibold tabular-nums ${
                      row.total.over ? 'text-red-600' : 'text-slate-500'
                    }`}
                  >
                    {formatRate(row.total.rate)}
                  </span>
                </td>
              </tr>
            );
          })}
        </tbody>

        {/* 하단 요약 행 (§7.9): 연차별 합계 / 집행률 / 잔액. 합계 열도 같은 3값 */}
        <tfoot className="border-t-2 border-slate-200 bg-slate-50 text-xs">
          <tr>
            <th scope="row" className="px-3 py-2 text-left font-semibold text-slate-800">
              합계
            </th>
            {matrix.columns.map((column) => (
              <td key={column.yearId} className="px-3 py-2 text-right">
                <span className="block font-semibold tabular-nums text-slate-800">
                  {formatAmount(column.total.planned, currencyUnit)}
                </span>
                <span className="block tabular-nums text-slate-600">
                  집행 {formatAmount(column.total.executed, currencyUnit)}
                </span>
                <span
                  className={`block font-semibold tabular-nums ${
                    column.total.over ? 'text-red-600' : 'text-slate-500'
                  }`}
                >
                  {formatRate(column.total.rate)}
                </span>
                <span
                  className={`block tabular-nums ${
                    column.total.remaining < 0 ? 'text-red-600' : 'text-slate-500'
                  }`}
                  title="잔액 = 예산 − 집행"
                >
                  잔액 {formatAmount(column.total.remaining, currencyUnit)}
                </span>
              </td>
            ))}
            <td className="px-3 py-2 text-right">
              <span className="block font-semibold tabular-nums text-slate-900">
                {formatAmount(matrix.total.planned, currencyUnit)}
              </span>
              <span className="block tabular-nums text-slate-600">
                집행 {formatAmount(matrix.total.executed, currencyUnit)}
              </span>
              <span
                className={`block font-semibold tabular-nums ${
                  matrix.total.over ? 'text-red-600' : 'text-slate-500'
                }`}
              >
                {formatRate(matrix.total.rate)}
              </span>
              <span
                className={`block tabular-nums ${
                  matrix.total.remaining < 0 ? 'text-red-600' : 'text-slate-500'
                }`}
                title="잔액 = 예산 − 집행"
              >
                잔액 {formatAmount(matrix.total.remaining, currencyUnit)}
              </span>
            </td>
          </tr>
        </tfoot>
      </table>
    </div>
  );
}
