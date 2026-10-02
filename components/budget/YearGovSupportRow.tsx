'use client';

// 제안 모드 매트릭스 아래 "정부지원 현금"·"기관부담 현금" 행 (SOT §7.9, §5.5 govSupportCash, Phase 25 S-3·S-4·S-17)
//
// 소스 일원화(Phase 25 핵심 원칙): 저장하는 값은 정부지원 현금 하나(years.gov_support_cash)뿐이다.
// 기관부담 현금 = 그 연차 현금 합 − 정부지원 현금은 파생 값이라 여기서 그리기만 한다.
//
// **현금 합의 출처** = getBudgetPlanData의 yearAxisSplits(그 연차 YearAxisSplit). 지침 검증·현금/현물 비중과
// 같은 소스 배열에서 나온 값이라 한 화면의 숫자가 어긋나지 않는다(C5). 미분리 금액(axis.unspecified —
// 현금·현물 둘 다 null인 셀의 계획액)은 **현금으로 본다** — [협약 기준선으로 보내기](AV-6 ①)가 미분리 셀을
// 현금으로 보내므로, 여기서 다르게 세면 보낸 뒤 8-1의 기관부담 현금이 이 행과 달라진다. 대신 그 금액을
// 화면에 밝힌다(조용히 섞지 않는다). unspecified가 음수면 현금+현물이 계획액을 넘는 손상 데이터라
// 현금 합을 정할 수 없다 — "—"와 사유를 보인다.
//
// 이 컴포넌트가 소유하는 것: 입력 초안, 진행 중, 실패 배너, STALE 충돌 다이얼로그(O-3).
// 부모는 저장 성공 뒤 다시 그리기(onSaved → router.refresh())만 한다. 쓰기는 actions/years.ts updateYear 경유.

import { useEffect, useState } from 'react';
import type { Settings, Year } from '@/types';
import type { ActionErrorCode } from '@/lib/db/errors';
import type { BudgetPlanYearAxisView } from '@/actions/budget-plan';
import type { YearAxisSplit } from '@/lib/budget-plan';
import { updateYear } from '@/actions/years';
import { formatAmount } from '@/lib/currency';
import ErrorBanner from '@/components/ui/ErrorBanner';
import ConflictDialog from '@/components/ui/ConflictDialog';
import { PRINT_TABLE, PRINT_TABLE_WRAP, PRINT_TD, PRINT_TH } from '@/components/print/tokens';
import { setRealtimePaused } from '@/components/RealtimeRefresher';

/** 연차 하나. 순서는 매트릭스 열(matrix.columns)과 같게 넘긴다 */
export interface YearGovSupportColumn {
  yearId: string;
  name: string;
  /** Year.version — O-1 낙관적 잠금 */
  version: number;
  /** Year.govSupportCash. null = 미입력 */
  govSupportCash: number | null;
  /**
   * 그 연차 현금/현물 축 합계(getBudgetPlanData.yearAxisSplits). null이면 조회 결과에 그 연차가 없다 —
   * 0으로 채우지 않고 "—"와 사유를 보인다
   */
  axis: YearAxisSplit | null;
}

export interface YearGovSupportRowProps {
  columns: YearGovSupportColumn[];
  /** 협약 정보 Project.govBudget. 연차 합과 다르면 정보 문구만(판정 아님) */
  govBudget: number | null;
  currencyUnit: Settings['currencyUnit'];
  /** 부모가 다른 저장을 돌리는 중이면 입력을 잠근다 (선택) */
  disabled?: boolean;
  /** 저장 성공 또는 STALE "다시 불러오기" — 부모는 router.refresh()로 plan 스냅샷을 다시 받는다 */
  onSaved: () => void;
}

/** plan(getBudgetPlanData) 한 벌에서 열을 만든다 — 다른 조회를 섞지 않는다(C5) */
export function buildGovSupportColumns(
  years: readonly Year[],
  yearAxisSplits: readonly BudgetPlanYearAxisView[]
): YearGovSupportColumn[] {
  const axisByYear = new Map(yearAxisSplits.map((view) => [view.yearId, view.axis]));
  return years.map((year) => ({
    yearId: year.id,
    name: year.name,
    version: year.version,
    govSupportCash: year.govSupportCash,
    axis: axisByYear.get(year.id) ?? null,
  }));
}

type CashTotal =
  | { ok: true; cash: number; unsplit: number }
  | { ok: false; reason: string };

function cashTotalOf(axis: YearAxisSplit | null): CashTotal {
  if (axis === null) {
    return { ok: false, reason: '이 연차의 현금 합이 조회 결과에 없습니다. 매트릭스와 제안 데이터가 어긋난 상태입니다.' };
  }
  if (axis.unspecified < 0) {
    return {
      ok: false,
      reason: '현금·현물 합이 계획액보다 큰 셀이 있어 현금 합을 정할 수 없습니다. 매트릭스의 현금·현물을 확인하세요.',
    };
  }
  // AV-6 ①: 미분리 셀은 현금으로 본다
  return { ok: true, cash: axis.cash + axis.unspecified, unsplit: axis.unspecified };
}

/** 정부지원 현금 입력 칸. 입력은 원 단위 정수, 비우면 미입력(null) */
function GovCashInput({
  value,
  label,
  currencyUnit,
  disabled,
  onSave,
}: {
  value: number | null;
  label: string;
  currencyUnit: Settings['currencyUnit'];
  disabled: boolean;
  onSave: (amount: number | null) => void;
}) {
  const shown = value === null ? '' : String(value);
  const [draft, setDraft] = useState<string>(shown);
  const [editing, setEditing] = useState(false);
  const [invalid, setInvalid] = useState(false);

  // 편집 중에는 서버 값을 따라가지 않는다 — 입력하던 값이 새로고침으로 덮이면 작업이 사라진다
  useEffect(() => {
    if (editing) return;
    setDraft(shown);
  }, [shown, editing]);

  // R-4: 편집하는 동안 자동 새로고침을 보류한다
  useEffect(() => {
    if (!editing) return;
    setRealtimePaused(true);
    return () => setRealtimePaused(false);
  }, [editing]);

  const commit = (): void => {
    setEditing(false);
    const trimmed = draft.trim();
    // 빈 칸은 0원이 아니라 미입력이다 (§5.5)
    const next = trimmed === '' ? null : Number(trimmed);
    if (next !== null && (!Number.isInteger(next) || next < 0)) {
      setInvalid(true);
      return;
    }
    setInvalid(false);
    if (next === value) return;
    onSave(next);
  };

  return (
    <span className="inline-flex flex-col items-end gap-0.5">
      {/* P-R4: 종이에 입력상자를 남기지 않는다. 값은 표시 단위로 환산해 남긴다 */}
      <span className="hidden text-xs tabular-nums text-black print:inline">
        {value === null ? '—' : formatAmount(value, currencyUnit)}
      </span>
      <span className="inline-flex items-center gap-1 print:hidden">
        <input
          type="number"
          inputMode="numeric"
          min={0}
          step={1}
          value={draft}
          placeholder="미입력"
          disabled={disabled}
          aria-label={`${label} 정부지원 현금(원)`}
          onFocus={() => setEditing(true)}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              e.currentTarget.blur();
            }
            if (e.key === 'Escape') {
              setDraft(shown);
              setInvalid(false);
              setEditing(false);
              e.currentTarget.blur();
            }
          }}
          className={`w-28 rounded-md border bg-surface px-1.5 py-1 text-right text-xs tabular-nums text-grey-800 focus:outline-none ${
            invalid ? 'border-red-400 bg-red-50' : 'border-grey-300 focus:border-grey-500'
          }`}
        />
        <span className="text-[10px] text-grey-400">원</span>
      </span>
      {value !== null && (
        <span className="text-[11px] tabular-nums text-grey-500 print:hidden">
          {formatAmount(value, currencyUnit)}
        </span>
      )}
      {invalid && (
        <span className="text-[10px] text-red-600 print:hidden">
          0 이상 정수(원)만 저장됩니다. 비우면 미입력입니다.
        </span>
      )}
    </span>
  );
}

export default function YearGovSupportRow({
  columns,
  govBudget,
  currencyUnit,
  disabled = false,
  onSaved,
}: YearGovSupportRowProps) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<{ message: string; code?: ActionErrorCode } | null>(null);
  const [conflict, setConflict] = useState<string | null>(null);

  const save = async (column: YearGovSupportColumn, amount: number | null): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      const res = await updateYear(column.yearId, { govSupportCash: amount }, column.version);
      if (!res.ok) {
        if (res.code === 'STALE') setConflict(res.error);
        else setError({ message: res.error, code: res.code });
        return;
      }
      onSaved();
    } catch (e) {
      // 네트워크 단절 등 액션 밖 실패도 삼키지 않는다 (절대 규칙 5)
      setError({ message: e instanceof Error ? e.message : '정부지원 현금을 저장하지 못했습니다.' });
    } finally {
      setBusy(false);
    }
  };

  const rows = columns.map((column) => {
    const total = cashTotalOf(column.axis);
    const gov = column.govSupportCash;
    const exceeds = total.ok && gov !== null && gov > total.cash;
    return { column, total, gov, exceeds };
  });

  const entered = rows.filter((r) => r.gov !== null);
  const missingCount = rows.length - entered.length;
  const govSum = entered.reduce((sum, r) => sum + (r.gov ?? 0), 0);
  // 기관부담 합은 모든 연차가 값을 낼 때만 — 한 연차라도 "—"면 합도 "—"다 (8-1 합계 행과 같은 태도)
  const ownCells = rows.map((r) =>
    r.gov !== null && r.total.ok ? r.total.cash - r.gov : null
  );
  const ownSum = ownCells.every((v) => v !== null)
    ? ownCells.reduce<number>((sum, v) => sum + (v ?? 0), 0)
    : null;
  // 입력한 연차가 하나도 없으면 비교할 것이 없다 — 0원 합을 불일치라고 말하지 않는다
  const showBudgetInfo = govBudget !== null && entered.length > 0 && govSum !== govBudget;

  const locked = disabled || busy;

  return (
    <div className="mt-3">
      {error && (
        <ErrorBanner
          className="mb-2 print:hidden"
          message={error.message}
          code={error.code}
          onDismiss={() => setError(null)}
        />
      )}

      <div className={`overflow-x-auto rounded-xl border border-grey-200 bg-surface ${PRINT_TABLE_WRAP}`}>
        <table className={`w-full text-left text-sm ${PRINT_TABLE}`}>
          <caption className="sr-only">
            연차별 정부지원 현금(입력)과 기관부담 현금(그 연차 현금 합 − 정부지원 현금).
          </caption>
          <thead className="text-xs text-grey-500 print:text-black">
            <tr className="border-b border-grey-100">
              <th scope="col" className={`px-3 py-2 font-medium ${PRINT_TH}`}>
                현금 구분
              </th>
              {columns.map((column) => (
                <th
                  key={column.yearId}
                  scope="col"
                  className={`px-3 py-2 text-right font-medium text-grey-700 print:text-black ${PRINT_TH}`}
                >
                  {column.name}
                </th>
              ))}
              <th scope="col" className={`px-3 py-2 text-right font-medium text-grey-700 ${PRINT_TH}`}>
                합계
              </th>
            </tr>
          </thead>
          <tbody className="divide-y divide-grey-100">
            <tr className="align-top">
              <th scope="row" className={`px-3 py-2 text-left font-medium text-grey-800 ${PRINT_TD}`}>
                정부지원 현금
                <span className="mt-0.5 block text-[11px] font-normal text-grey-400 print:text-black">
                  입력 · 비우면 미입력
                </span>
              </th>
              {rows.map(({ column, total, exceeds }) => (
                <td key={column.yearId} className={`px-3 py-2 text-right ${PRINT_TD}`}>
                  <GovCashInput
                    value={column.govSupportCash}
                    label={column.name}
                    currencyUnit={currencyUnit}
                    disabled={locked}
                    onSave={(amount) => void save(column, amount)}
                  />
                  {exceeds && total.ok && (
                    // S-4: 저장은 막지 않고 읽을 때 경고한다
                    <span
                      role="note"
                      className="mt-1 block text-[11px] font-semibold text-orange-700 print:text-black"
                    >
                      ⚠ 현금 합({formatAmount(total.cash, currencyUnit)})보다 큽니다
                    </span>
                  )}
                </td>
              ))}
              <td className={`px-3 py-2 text-right ${PRINT_TD}`}>
                <span className="block text-xs font-semibold tabular-nums text-grey-800 print:text-black">
                  {entered.length === 0 ? '—' : formatAmount(govSum, currencyUnit)}
                </span>
                {missingCount > 0 && entered.length > 0 && (
                  <span className="block text-[11px] text-grey-400 print:text-black">
                    미입력 {missingCount}개 연차 제외
                  </span>
                )}
              </td>
            </tr>
            <tr className="align-top">
              <th scope="row" className={`px-3 py-2 text-left font-medium text-grey-800 ${PRINT_TD}`}>
                기관부담 현금
                <span className="mt-0.5 block text-[11px] font-normal text-grey-400 print:text-black">
                  현금 합 − 정부지원 현금 (자동)
                </span>
              </th>
              {rows.map(({ column, total, gov }, index) => (
                <td key={column.yearId} className={`px-3 py-2 text-right ${PRINT_TD}`}>
                  <span
                    className="block text-xs tabular-nums text-grey-700 print:text-black"
                    title={
                      !total.ok
                        ? total.reason
                        : gov === null
                          ? '정부지원 현금이 미입력이라 계산하지 않습니다.'
                          : undefined
                    }
                  >
                    {ownCells[index] === null ? '—' : formatAmount(ownCells[index]!, currencyUnit)}
                  </span>
                  {total.ok ? (
                    <span className="block text-[11px] tabular-nums text-grey-400 print:text-black">
                      현금 합 {formatAmount(total.cash, currencyUnit)}
                      {total.unsplit > 0 && (
                        <span
                          className="block"
                          title="현금·현물이 나뉘지 않은 셀의 계획액은 현금으로 셉니다 — [협약 기준선으로 보내기]와 같습니다 (AV-6)."
                        >
                          (미분리 {formatAmount(total.unsplit, currencyUnit)} 현금으로 봄)
                        </span>
                      )}
                    </span>
                  ) : (
                    <span className="block text-[11px] font-semibold text-red-600 print:text-black">
                      {total.reason}
                    </span>
                  )}
                </td>
              ))}
              <td className={`px-3 py-2 text-right ${PRINT_TD}`}>
                <span className="block text-xs font-semibold tabular-nums text-grey-800 print:text-black">
                  {ownSum === null ? '—' : formatAmount(ownSum, currencyUnit)}
                </span>
              </td>
            </tr>
          </tbody>
        </table>
      </div>

      {showBudgetInfo && govBudget !== null && (
        // 정보 문구일 뿐 판정이 아니다 (S-4) — 규칙 판정은 budget_rules(RL-8·RL-9)의 몫이다
        <p className="mt-2 text-xs text-grey-500 print:text-black">
          연차 정부지원 현금 합 {formatAmount(govSum, currencyUnit)}이 협약 정보의 정부지원연구개발비{' '}
          {formatAmount(govBudget, currencyUnit)}와 {formatAmount(Math.abs(govSum - govBudget), currencyUnit)}{' '}
          다릅니다{missingCount > 0 ? ` (미입력 ${missingCount}개 연차 제외)` : ''}.
        </p>
      )}

      {conflict !== null && (
        <ConflictDialog
          message={conflict}
          onReload={() => {
            setConflict(null);
            onSaved();
          }}
          onKeepEditing={() => setConflict(null)}
        />
      )}
    </div>
  );
}
