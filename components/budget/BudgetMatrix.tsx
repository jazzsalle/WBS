'use client';

// 비목 매트릭스 테이블 (SOT §7.9, §6.4 B-1~B-4, §6.10.2 PL-9, 부록 A.1·A.3)
// 행 = 비목 12개(부록 A.1 순서, 직접비/간접비 구분 표시), 열 = 연차(order asc) + 합계.
// **두 모드가 같은 표를 공유한다** (§7.9 "왜 탭을 늘리지 않는가") — 바뀌는 것은 셀의 아랫줄뿐이다:
//  - 수행: 예산 / 집행 / 집행률 · 클릭하면 집행 내역 패널
//  - 제안: 예산 / 현금 / 현물 · 클릭하면 산출근거 패널
// 인쇄도 현재 모드를 따른다 (§7.9.2) — 모드가 DOM을 정하고, 인쇄는 그 DOM을 그대로 뽑는다.
//
// 표시 규칙 — 숫자는 전부 서버(getBudgetMatrix → lib/budget.ts §6.4,
// getBudgetPlanData → lib/budget-plan.ts §6.10)가 계산한 값이다.
// 이 파일에는 나눗셈·백분율이 없다:
//  - B-1 planned=0 → 집행률 N/A(formatRate), 집행이 있으면 "예산 외 집행" 경고 아이콘
//  - B-2 cell.over(집행률 100% 초과) → red-600 계열로 표시. 저장은 막지 않는다
//  - B-3 yearBudgetChecks[yearId].mismatch → 연차 헤더에 경고 배지(title에 차액)
//  - B-4 표시는 currencyUnit으로 환산(formatAmount), 입력은 언제나 원 단위 정수
//  - PL-9 산출근거가 있는 셀은 계획액이 내역 합계라 인라인 편집이 잠긴다 (자물쇠 + 이유 title)
//
// 인쇄(§12 P-R1~P-R5): 12행 × 연차 N열이라 A4 가로로 뽑는다. 편집 컨트롤(계획액 입력·패널
// 트리거)은 감추고 같은 숫자를 정적 텍스트로 대신 남긴다 — 종이에 빈 입력상자를 남기지 않으면서
// 값은 잃지 않는다.

import { useEffect, useState, type ReactNode } from 'react';
import type { BudgetCategory, BudgetItem, Settings } from '@/types';
import type { BudgetPlanCellView } from '@/actions/budget-plan';
import type { BudgetMatrix, BudgetMatrixCell, YearBudgetMismatch } from '@/lib/budget';
import {
  BUDGET_CATEGORY_GROUPS,
  BUDGET_CATEGORY_LABELS,
  DETAIL_AXIS_LABELS,
} from '@/lib/constants';
import { formatAmount } from '@/lib/currency';
import { formatRate } from '@/lib/goals';
import Badge from '@/components/ui/Badge';
import Button from '@/components/ui/Button';
import PrintHeader from '@/components/print/PrintHeader';
import { PRINT_TABLE, PRINT_TABLE_WRAP, PRINT_TD, PRINT_TH } from '@/components/print/tokens';
import { setRealtimePaused } from '@/components/RealtimeRefresher';

export interface CellRef {
  yearId: string;
  category: BudgetCategory;
}

/** (연차, 비목) 키. yearId는 UUID라 '|'가 값에 섞이지 않는다 (lib/budget.ts와 같은 규칙) */
export function cellKey(yearId: string, category: BudgetCategory): string {
  return `${yearId}|${category}`;
}

/** §7.9 모드 토글. 화면 로컬 상태이며 URL·DB에 저장하지 않는다 (§7.9.2) */
export type BudgetMode = 'execution' | 'plan';

interface BudgetMatrixBaseProps {
  matrix: BudgetMatrix;
  currencyUnit: Settings['currencyUnit'];
  /** 인쇄 머리말 (§12 P-R3) */
  projectName: string;
  /** 인쇄 출력일 (§12 P-R3). 서버가 만든 오늘을 그대로 쓴다 — new Date() 금지 (§6.5) */
  todayISO: string;
  /** B-3 판정. 값이 null이면 비교 대상(year.budget)이 없어 배지를 띄우지 않는다 */
  yearBudgetChecks: Record<string, YearBudgetMismatch | null>;
  /** 셀별 원본 행 — 현금/현물 분리 여부로 총액 인라인 편집 가능 여부가 갈린다 */
  itemsByCell: Map<string, BudgetItem[]>;
  selected: CellRef | null;
  busy: boolean;
  onSelect: (cell: CellRef) => void;
  onInlineSave: (cell: CellRef, plannedAmount: number) => void;
}

/**
 * 모드별 추가 입력. 제안 모드에서는 셀 요약(현금·현물·잠금·경고)이 **반드시** 필요하므로
 * 타입으로 강제한다 — 없을 수 있는 값으로 두면 화면이 0을 지어내는 폴백을 만들게 된다.
 */
export type BudgetMatrixTableProps = BudgetMatrixBaseProps &
  (
    | { mode: 'execution' }
    | {
        mode: 'plan';
        /** cellKey(yearId, category) → getBudgetPlanData의 셀 뷰 (연차 × 12비목 전 조합) */
        planCells: Map<string, BudgetPlanCellView>;
      }
  );

// 총액 인라인 편집을 열 수 없는 이유. 이유 없이 막지 않고 title로 항상 밝힌다.
type LockReason = 'split' | 'missing' | 'duplicated' | 'detail';

interface CellLock {
  reason: LockReason;
  /** PL-9 잠금일 때 몇 건의 근거가 셀을 잠갔는지. 이유를 숫자까지 밝힌다 */
  detailCount: number;
}

function lockMessage(lock: CellLock, mode: BudgetMode): string {
  if (lock.reason === 'detail') {
    // PL-9: 계획액의 소유권이 산출근거로 넘어간 셀이다. 서버도 같은 이유로 저장을 거부한다
    return `산출근거 ${lock.detailCount}건이 있어 계획액이 내역 합계로 확정됩니다 (PL-9). 제안 모드에서 셀을 클릭해 산출근거 패널에서 고치세요. 마지막 행을 지우면 이 잠금이 풀리고 직전 합계가 그대로 남습니다.`;
  }
  if (lock.reason === 'split') {
    const base =
      '현금·현물이 입력된 셀입니다. 총액은 현금 + 현물 합계로 자동 계산되므로 셀 상세 패널에서 현금·현물을 편집하세요.';
    // 제안 모드에서 셀을 클릭하면 산출근거 패널이 열린다 — 현금·현물 입력칸은 수행 모드에 있다
    return mode === 'plan'
      ? `${base} 그 패널은 수행 모드에서 셀을 클릭하면 열립니다.`
      : base;
  }
  if (lock.reason === 'missing') {
    return '이 연차·비목의 예산 행이 없습니다. 연차 생성 시 자동으로 만들어지는 행이므로 데이터가 어긋난 상태입니다.';
  }
  return '이 연차·비목에 예산 행이 2개 이상 있습니다. 어느 행을 고칠지 알 수 없어 편집을 막습니다. 관리자에게 알리세요.';
}

/** 계획액(총액) 인라인 편집기. 입력은 원 단위 정수다 (B-4) */
function PlannedInput({
  value,
  label,
  currencyUnit,
  disabled,
  onSave,
}: {
  value: number;
  label: string;
  currencyUnit: Settings['currencyUnit'];
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
      {/* P-R4: 종이에 입력상자를 남기지 않는다. 값은 다른 셀과 같은 표시 단위로 환산해 남긴다 */}
      <span className="hidden text-xs font-semibold tabular-nums text-black print:inline">
        {formatAmount(value, currencyUnit)}
      </span>
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
        className={`w-28 rounded-md border px-1.5 py-1 text-right text-xs tabular-nums focus:outline-none print:hidden ${
          invalid ? 'border-red-400 bg-red-50' : 'border-grey-300 focus:border-grey-500'
        }`}
      />
      <span className="text-[10px] text-grey-400 print:hidden">원</span>
      {invalid && (
        <span className="block text-[10px] text-red-600">0 이상 정수(원)만 저장됩니다.</span>
      )}
    </span>
  );
}

/** 집행액 + 집행률 표시. 화면·인쇄가 같은 숫자를 쓰도록 한 곳에서 만든다 */
function executionSummary(
  cell: BudgetMatrixCell,
  currencyUnit: Settings['currencyUnit']
): ReactNode {
  return (
    <>
      <span className="block text-xs tabular-nums text-grey-600 print:text-black">
        집행 {formatAmount(cell.executed, currencyUnit)}
      </span>
      <span className="mt-0.5 flex items-center justify-end gap-1">
        {cell.offBudget && (
          // B-1: 계획액 0인데 집행이 있다. 아이콘만 두지 않고 title로 뜻을 밝힌다
          <span
            aria-label="예산 외 집행 경고"
            title="예산 외 집행: 계획액이 0인데 집행액이 있습니다 (B-1)"
            className="text-orange-600 print:text-black"
          >
            ⚠
          </span>
        )}
        <span
          // B-2: 집행률 100% 초과는 빨강 (부록 A.3 red-600)
          className={`text-xs font-semibold tabular-nums ${
            cell.over ? 'text-red-600' : 'text-grey-500'
          }`}
          title={cell.over ? '집행률이 100%를 넘었습니다 (B-2)' : undefined}
        >
          {formatRate(cell.rate)}
        </span>
        {/* P-R5: 흑백 출력에서는 빨간 글씨·빨간 셀이 사라진다. 초과를 글자로도 남긴다 */}
        {cell.over && (
          <span className="hidden text-xs font-bold text-black print:inline">초과</span>
        )}
      </span>
    </>
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
  const summary = executionSummary(cell, currencyUnit);
  return (
    <>
      <button
        type="button"
        onClick={onSelect}
        aria-label={`${label} 집행 내역 열기`}
        // P-R4: 패널 트리거는 인쇄에서 빠진다. 숫자는 아래 정적 블록이 그대로 남긴다
        className="mt-1 block w-full rounded-md px-1.5 py-1 text-right hover:bg-grey-100 print:hidden"
      >
        {summary}
      </button>
      <span className="mt-1 hidden px-1.5 py-1 text-right print:block">{summary}</span>
    </>
  );
}

/** S-4: 현금·현물 분리는 null(미입력)과 0원이 다르다. 0으로 눙치지 않는다 */
function formatSplit(amount: number | null, currencyUnit: Settings['currencyUnit']): string {
  return amount === null ? '미입력' : formatAmount(amount, currencyUnit);
}

/**
 * 제안 모드 셀 요약 — 현금 / 현물 (§7.9 표).
 * 값은 budget_items에 저장된 값이다. 잠긴 셀에서는 산출근거 합계와 같아야 하며(PL-10),
 * 다르면 감추지 않고 그 자리에서 드러낸다 (절대 규칙 5).
 */
function planSummary(
  view: BudgetPlanCellView | undefined,
  currencyUnit: Settings['currencyUnit']
): ReactNode {
  if (view === undefined) {
    // 서버는 연차 × 12비목 전 조합을 내려준다. 빠졌다면 매트릭스와 제안 데이터가 어긋난 것이다
    return (
      <span
        className="block text-xs font-semibold text-red-600 print:text-black"
        title="이 셀의 산출근거 요약이 조회 결과에 없습니다. 매트릭스와 제안 데이터가 어긋난 상태입니다."
      >
        요약 없음
      </span>
    );
  }
  return (
    <>
      <span className="block text-xs tabular-nums text-grey-600 print:text-black">
        {DETAIL_AXIS_LABELS.cash} {formatSplit(view.saved.cashAmount, currencyUnit)}
      </span>
      <span className="block text-xs tabular-nums text-grey-600 print:text-black">
        {DETAIL_AXIS_LABELS.in_kind} {formatSplit(view.saved.inKindAmount, currencyUnit)}
      </span>
      {view.detailCount > 0 && (
        <span className="block text-[11px] text-grey-400 print:text-black">
          근거 {view.detailCount}행
        </span>
      )}
      {view.mismatch && (
        // PL-10 불변식 위반. 트랜잭션 안에서만 갱신되므로 정상 경로에서는 나올 수 없는 값이다
        <span
          className="block text-[11px] font-semibold text-red-600 print:text-black"
          title={`저장된 계획액과 산출근거 합계가 다릅니다 (PL-10). 산출근거 합계 = 계 ${formatAmount(
            view.total.plannedAmount,
            currencyUnit
          )} · ${DETAIL_AXIS_LABELS.cash} ${formatAmount(
            view.total.cashAmount,
            currencyUnit
          )} · ${DETAIL_AXIS_LABELS.in_kind} ${formatAmount(view.total.inKindAmount, currencyUnit)}`}
        >
          ⚠ 합계 불일치
        </span>
      )}
      {view.negativeCount > 0 && (
        <span
          className="block text-[11px] font-semibold text-red-600 print:text-black"
          title="조정액을 확인하세요 (PL-5). 저장은 막지 않습니다"
        >
          음수 {view.negativeCount}행
        </span>
      )}
      {view.missingSalaryCount > 0 && (
        <span
          className="block text-[11px] text-orange-700 print:text-black"
          title="연봉이 비어 있는 인력의 인건비 행은 0원으로 계산됩니다 (§7.9.2)"
        >
          연봉 미입력 {view.missingSalaryCount}행
        </span>
      )}
    </>
  );
}

/** 현금 / 현물. 클릭하면 산출근거 패널이 열린다 (§7.9.2) */
function PlanButton({
  view,
  label,
  currencyUnit,
  onSelect,
}: {
  view: BudgetPlanCellView | undefined;
  label: string;
  currencyUnit: Settings['currencyUnit'];
  onSelect: () => void;
}) {
  const summary = planSummary(view, currencyUnit);
  return (
    <>
      <button
        type="button"
        onClick={onSelect}
        aria-label={`${label} 산출근거 열기`}
        // P-R4: 패널 트리거는 인쇄에서 빠진다. 숫자는 아래 정적 블록이 그대로 남긴다
        className="mt-1 block w-full rounded-md px-1.5 py-1 text-right hover:bg-grey-100 print:hidden"
      >
        {summary}
      </button>
      <span className="mt-1 hidden px-1.5 py-1 text-right print:block">{summary}</span>
    </>
  );
}

export default function BudgetMatrixTable(props: BudgetMatrixTableProps) {
  const {
    matrix,
    currencyUnit,
    projectName,
    todayISO,
    yearBudgetChecks,
    itemsByCell,
    selected,
    busy,
    mode,
    onSelect,
    onInlineSave,
  } = props;
  const planCells = props.mode === 'plan' ? props.planCells : null;

  const lockOf = (cell: BudgetMatrixCell): CellLock | null => {
    const bucket = itemsByCell.get(cellKey(cell.yearId, cell.category)) ?? [];
    if (bucket.length === 0) return { reason: 'missing', detailCount: 0 };
    if (bucket.length > 1) return { reason: 'duplicated', detailCount: 0 };
    const item = bucket[0]!;
    // PL-9: 산출근거가 있는 셀은 두 모드 모두에서 잠긴다. 계획액의 소유권이 내역 합계에 있고,
    // 서버(updateBudgetPlan)도 같은 이유로 거부하므로 여기서 열어 두면 저장이 반드시 실패한다
    if (item.detailCount > 0) return { reason: 'detail', detailCount: item.detailCount };
    // 마지막 근거 행을 지우면 여기로 내려온다: RPC가 직전 합계를 지우지 않으므로(PL-9)
    // 현금·현물이 남아 있어 §5.12의 'split' 잠금으로 바뀐다. 잠금은 유지되지만 **이유가 달라지고**
    // 직전 합계는 셀에 그대로 보인다 — 이어서 고치는 자리는 수행 모드의 셀 상세 패널이다.
    // 현금·현물이 모두 비어 있는 셀만 총액을 자유롭게 고칠 수 있다.
    // 분리값이 있으면 총액은 합계라서, 화면이 차액을 임의 배분하지 않기 위해 잠근다 (§5.12)
    return item.cashAmount === null && item.inKindAmount === null
      ? null
      : { reason: 'split', detailCount: 0 };
  };

  return (
    <div>
      {/* P-R1 가로 + P-R3 머리말. 12행 × 연차 N열이라 A4 세로에는 들어가지 않는다.
          표시 단위를 머리말에 함께 남긴다 — 종이에서는 단위를 되물을 수 없다 (B-4) */}
      <PrintHeader
        title="연구비 비목 매트릭스"
        projectName={projectName}
        todayISO={todayISO}
        orientation="landscape"
        // 모드에 따라 셀의 숫자가 달라진다 — 종이만 보고 어느 관점인지 알 수 있어야 한다 (P-R3)
        subtitle={
          mode === 'plan'
            ? `금액 표시 단위 ${currencyUnit} · 제안 모드 (예산 / 현금 / 현물)`
            : `금액 표시 단위 ${currencyUnit}`
        }
      />

      <div className="mb-2 flex justify-end print:hidden">
        <Button size="sm" onClick={() => window.print()}>
          인쇄
        </Button>
      </div>

      <div className={`overflow-x-auto rounded-xl border border-grey-200 bg-white ${PRINT_TABLE_WRAP}`}>
        <table className={`w-full text-left text-sm ${PRINT_TABLE}`}>
          <caption className="sr-only">
            비목 × 연차 예산 매트릭스.{' '}
            {mode === 'plan'
              ? '각 셀은 예산·현금·현물입니다.'
              : '각 셀은 예산·집행·집행률입니다.'}
          </caption>
          <thead className="text-xs text-grey-500 print:text-black">
            <tr className="border-b border-grey-100">
              <th scope="col" className={`px-3 py-2 font-medium ${PRINT_TH}`}>
                비목
              </th>
              {matrix.columns.map((column) => {
                const check = yearBudgetChecks[column.yearId] ?? null;
                return (
                  <th
                    key={column.yearId}
                    scope="col"
                    className={`px-3 py-2 text-right font-medium ${PRINT_TH}`}
                  >
                    <span className="block text-grey-700 print:text-black">{column.name}</span>
                    <span className="block text-[11px] font-normal tabular-nums text-grey-400 print:text-black">
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
              <th scope="col" className={`px-3 py-2 text-right font-medium text-grey-700 ${PRINT_TH}`}>
                합계
              </th>
            </tr>
          </thead>
  
          <tbody className="divide-y divide-grey-100">
            {matrix.rows.map((row, rowIndex) => {
              const group = BUDGET_CATEGORY_GROUPS[row.category];
              const previous = rowIndex === 0 ? undefined : matrix.rows[rowIndex - 1];
              const groupChanged =
                previous === undefined || BUDGET_CATEGORY_GROUPS[previous.category] !== group;
  
              return (
                <tr
                  key={row.category}
                  data-category={row.category}
                  className={`align-top ${groupChanged && rowIndex > 0 ? 'border-t-2 border-t-grey-200' : ''}`}
                >
                  <th
                    scope="row"
                    className={`px-3 py-2 text-left font-medium text-grey-800 ${PRINT_TD}`}
                  >
                    {BUDGET_CATEGORY_LABELS[row.category]}
                    <span className="mt-0.5 block text-[11px] font-normal text-grey-400 print:text-black">
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
                    const lock = lockOf(cell);
  
                    return (
                      <td
                        key={cell.yearId}
                        // B-2 초과 강조는 수행 모드에서만 건다 — 제안 모드 셀에는 집행 숫자가
                        // 없어 빨간 칸의 이유를 셀 안에서 읽을 수 없다 (P-R5와 같은 취지)
                        className={`px-3 py-2 text-right ${PRINT_TD} ${
                          cell.over && mode === 'execution' ? 'bg-red-50' : ''
                        } ${
                          // 선택 표시는 조작 흔적이라 인쇄에서 지운다 (P-R4)
                          isSelected ? 'ring-2 ring-inset ring-grey-900 print:ring-0' : ''
                        }`}
                      >
                        {lock === null ? (
                          <PlannedInput
                            value={cell.planned}
                            label={label}
                            currencyUnit={currencyUnit}
                            disabled={busy}
                            onSave={(planned) =>
                              onInlineSave({ yearId: cell.yearId, category: cell.category }, planned)
                            }
                          />
                        ) : (
                          <span
                            title={lockMessage(lock, mode)}
                            className="inline-flex items-center gap-1 text-xs tabular-nums text-grey-700 print:text-black"
                          >
                            {/* 자물쇠는 편집 가능 여부라는 화면 사정이다 — 종이에는 금액만 남긴다 */}
                            <span aria-hidden className="print:hidden">
                              🔒
                            </span>
                            {formatAmount(cell.planned, currencyUnit)}
                          </span>
                        )}
  
                        {/* 모드가 바꾸는 것은 셀의 아랫줄과 클릭 대상뿐이다 (§7.9 표) */}
                        {planCells === null ? (
                          <ExecutionButton
                            cell={cell}
                            label={label}
                            currencyUnit={currencyUnit}
                            onSelect={() =>
                              onSelect({ yearId: cell.yearId, category: cell.category })
                            }
                          />
                        ) : (
                          <PlanButton
                            view={planCells.get(cellKey(cell.yearId, cell.category))}
                            label={label}
                            currencyUnit={currencyUnit}
                            onSelect={() =>
                              onSelect({ yearId: cell.yearId, category: cell.category })
                            }
                          />
                        )}
                      </td>
                    );
                  })}
  
                  <td className={`px-3 py-2 text-right ${PRINT_TD}`}>
                    <span className="block text-xs font-semibold tabular-nums text-grey-800">
                      {formatAmount(row.total.planned, currencyUnit)}
                    </span>
                    {/* 집행 숫자는 수행 모드의 것이다. 제안 모드에서는 계획액만 남긴다 (§7.9 표) */}
                    {mode === 'execution' && (
                      <>
                        <span className="block text-xs tabular-nums text-grey-600 print:text-black">
                          집행 {formatAmount(row.total.executed, currencyUnit)}
                        </span>
                        <span
                          className={`block text-xs font-semibold tabular-nums ${
                            row.total.over ? 'text-red-600' : 'text-grey-500'
                          }`}
                        >
                          {formatRate(row.total.rate)}
                          {/* P-R5: 흑백에서 빨간 글씨가 사라져도 초과를 알 수 있게 글자로 남긴다 */}
                          {row.total.over && <span className="hidden print:inline"> 초과</span>}
                        </span>
                      </>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
  
          {/* 하단 요약 행 (§7.9): 수행은 연차별 합계 / 집행률 / 잔액, 제안은 계획액 합계만.
              제안 모드의 현금/현물 비중과 연차별 지침 검증(PL-12·PL-13)은 표 아래
              BudgetPlanSummary가 맡는다 */}
          <tfoot className="border-t-2 border-grey-200 bg-grey-50 text-xs">
            <tr>
              <th
                scope="row"
                className={`px-3 py-2 text-left font-semibold text-grey-800 ${PRINT_TH}`}
              >
                합계
              </th>
              {matrix.columns.map((column) => (
                <td key={column.yearId} className={`px-3 py-2 text-right ${PRINT_TD}`}>
                  <span className="block font-semibold tabular-nums text-grey-800">
                    {formatAmount(column.total.planned, currencyUnit)}
                  </span>
                  {mode === 'execution' && (
                    <>
                      <span className="block tabular-nums text-grey-600 print:text-black">
                        집행 {formatAmount(column.total.executed, currencyUnit)}
                      </span>
                      <span
                        className={`block font-semibold tabular-nums ${
                          column.total.over ? 'text-red-600' : 'text-grey-500'
                        }`}
                      >
                        {formatRate(column.total.rate)}
                        {column.total.over && <span className="hidden print:inline"> 초과</span>}
                      </span>
                      <span
                        className={`block tabular-nums ${
                          column.total.remaining < 0 ? 'text-red-600' : 'text-grey-500'
                        }`}
                        title="잔액 = 예산 − 집행"
                      >
                        잔액 {formatAmount(column.total.remaining, currencyUnit)}
                      </span>
                    </>
                  )}
                </td>
              ))}
              <td className={`px-3 py-2 text-right ${PRINT_TD}`}>
                <span className="block font-semibold tabular-nums text-grey-900">
                  {formatAmount(matrix.total.planned, currencyUnit)}
                </span>
                {mode === 'execution' && (
                  <>
                    <span className="block tabular-nums text-grey-600 print:text-black">
                      집행 {formatAmount(matrix.total.executed, currencyUnit)}
                    </span>
                    <span
                      className={`block font-semibold tabular-nums ${
                        matrix.total.over ? 'text-red-600' : 'text-grey-500'
                      }`}
                    >
                      {formatRate(matrix.total.rate)}
                      {matrix.total.over && <span className="hidden print:inline"> 초과</span>}
                    </span>
                    <span
                      className={`block tabular-nums ${
                        matrix.total.remaining < 0 ? 'text-red-600' : 'text-grey-500'
                      }`}
                      title="잔액 = 예산 − 집행"
                    >
                      잔액 {formatAmount(matrix.total.remaining, currencyUnit)}
                    </span>
                  </>
                )}
              </td>
            </tr>
          </tfoot>
        </table>
      </div>
    </div>
  );
}
