'use client';

// 협약 예산 비목별 보기 (SOT §6.19 AG-2, §7.9.8 "비목별 보기", 부록 A.1)
//
// 연차 × 비목 매트릭스, 연차마다 현금·현물·계 세 칸. 숫자는 전부 서버(getAgreementData → lib/agreement/category-view)가
// 더한 값이다 — 이 파일에는 금액 덧셈이 없다(파생 값은 한 곳에서만 계산한다).
//  - 금액 줄이 없는 칸은 "—"(null). 금액 0인 줄과 다른 사실이다(절대 규칙 5)
//  - 작성 중 버전만 현금·현물 칸을 고친다(AG-2, AV-2). 계·합계는 파생 값이라 편집 칸이 아니다
//  - 셀 편집은 셀 총액을 보낸다. 어느 세목 줄이 바뀌는지는 서버의 resolveCellEdit가 정한다(default 줄 흡수)
//  - 실패: RULE·VALIDATION 등은 배너(서버 문구 그대로, 줄바꿈 유지), STALE은 ConflictDialog(O-3)
//
// 세목 총액 보존(RL-23)은 §7.9.8대로 변경 이력 보기에만 둔다 — 여기서 같은 경고를 또 띄우지 않는다.
// 인쇄 머리말·가로 방향은 셸(AgreementScreen)의 몫이다. 편집 컨트롤은 종이에 남기지 않고 값만 남긴다(P-R4).

import { useEffect, useRef, useState } from 'react';
import type { BudgetCategory, DetailAxis, Settings, Year } from '@/types';
import type { ActionErrorCode } from '@/lib/db/errors';
import type { AxisAmounts } from '@/lib/agreement/category-view';
import type { AgreementVersionView } from '@/actions/agreement';
import { setAgreementCellAmount } from '@/actions/agreement';
import {
  AGREEMENT_VERSION_STATUS_LABELS,
  BUDGET_CATEGORY_GROUPS,
  DETAIL_AXIS_LABELS,
} from '@/lib/constants';
import { formatAmount } from '@/lib/currency';
import ConflictDialog from '@/components/ui/ConflictDialog';
import ErrorBanner from '@/components/ui/ErrorBanner';
import { PRINT_TABLE, PRINT_TABLE_WRAP, PRINT_TD, PRINT_TH } from '@/components/print/tokens';
import { setRealtimePaused } from '@/components/RealtimeRefresher';
import TableActions from './TableActions';

/** 줄이 없는 칸 — 0원과 구별한다 */
const NO_LINE = '—';
const TOTAL_LABEL = '계';

interface Failure {
  message: string;
  code?: ActionErrorCode;
}

interface CellTarget {
  yearId: string;
  category: BudgetCategory;
  axis: DetailAxis;
}

function display(value: number | null, currencyUnit: Settings['currencyUnit']): string {
  return value === null ? NO_LINE : formatAmount(value, currencyUnit);
}

/**
 * 현금·현물 한 칸. 누르면 원 단위 입력이 열린다(B-4 — 입력은 언제나 원 단위 정수).
 * 저장이 실패하면 입력값을 지우지 않고 열어 둔다 — 고쳐서 다시 보내거나 Esc로 버린다.
 */
function AmountCell({
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
  onSave: (amount: number) => Promise<boolean>;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const [invalid, setInvalid] = useState(false);
  // 저장은 됐지만 새 값이 아직 내려오지 않은 동안 보일 값 — 옛 값이 잠깐 되살아나 보이지 않게
  const [pending, setPending] = useState<number | null>(null);
  // 방금 실패한 입력값. 충돌 대화·배너로 포커스가 빠질 때(blur) 같은 값을 다시 보내지 않게 한다
  const [failedDraft, setFailedDraft] = useState<string | null>(null);

  useEffect(() => {
    setPending(null);
  }, [value]);

  // R-4: 칸을 고치는 동안 자동 새로고침을 보류한다 — 입력하던 값이 덮이지 않게
  useEffect(() => {
    if (!editing) return;
    setRealtimePaused(true);
    return () => setRealtimePaused(false);
  }, [editing]);

  const open = (): void => {
    setDraft(value === null ? '' : String(value));
    setInvalid(false);
    setFailedDraft(null);
    setEditing(true);
  };

  const cancel = (): void => {
    setEditing(false);
    setInvalid(false);
  };

  const commit = async (): Promise<void> => {
    const trimmed = draft.trim();
    if (trimmed === '') {
      // 빈 입력을 0원 저장으로 눙치지 않는다 — 원래 값 그대로 둔다(줄 없음은 "—"로 남는다)
      cancel();
      return;
    }
    const next = Number(trimmed);
    if (!Number.isSafeInteger(next) || next < 0) {
      setInvalid(true);
      return;
    }
    if (next === value) {
      cancel();
      return;
    }
    setInvalid(false);
    const saved = await onSave(next);
    if (saved) {
      setPending(next);
      setEditing(false);
    } else {
      setFailedDraft(draft);
    }
  };

  const shown = pending ?? value;

  if (!editing) {
    return (
      <>
        <button
          type="button"
          onClick={open}
          disabled={disabled}
          aria-label={`${label} 금액 고치기`}
          title="눌러서 금액(원)을 고칩니다"
          className={`w-full rounded-md px-1.5 py-1 text-right tabular-nums hover:bg-grey-100 disabled:cursor-not-allowed print:hidden ${
            shown === null ? 'text-grey-400' : 'text-grey-800'
          } ${pending !== null ? 'opacity-60' : ''}`}
        >
          {display(shown, currencyUnit)}
        </button>
        <span className="hidden tabular-nums print:inline">{display(shown, currencyUnit)}</span>
      </>
    );
  }

  return (
    <span className="inline-flex flex-col items-end gap-0.5 print:hidden">
      <span className="inline-flex items-center gap-1">
        <input
          type="number"
          inputMode="numeric"
          min={0}
          step={1}
          autoFocus
          value={draft}
          disabled={disabled}
          placeholder={NO_LINE}
          aria-label={`${label} 금액(원)`}
          onChange={(e) => {
            setDraft(e.target.value);
            setInvalid(false);
            setFailedDraft(null);
          }}
          onBlur={() => {
            if (!disabled && draft !== failedDraft) void commit();
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              void commit();
            }
            if (e.key === 'Escape') {
              e.preventDefault();
              cancel();
            }
          }}
          className={`w-28 rounded-md border px-1.5 py-1 text-right text-xs tabular-nums focus:outline-none ${
            invalid ? 'border-red-400 bg-red-50' : 'border-grey-300 bg-surface focus:border-grey-500'
          }`}
        />
        <span className="text-[10px] text-grey-400">원</span>
      </span>
      {invalid && <span className="text-[10px] text-red-600">0 이상 정수(원)만 저장됩니다.</span>}
    </span>
  );
}

function StaticAmount({
  value,
  currencyUnit,
  strong = false,
}: {
  value: number | null;
  currencyUnit: Settings['currencyUnit'];
  strong?: boolean;
}) {
  return (
    <span
      className={`block px-1.5 py-1 tabular-nums print:text-black ${
        value === null ? 'text-grey-400' : strong ? 'font-semibold text-grey-900' : 'text-grey-700'
      }`}
    >
      {display(value, currencyUnit)}
    </span>
  );
}

export interface CategoryViewProps {
  projectId: string;
  view: AgreementVersionView;
  /** 계약상 받는다 — 열 순서·이름은 서버가 만든 `view.categoryView.years`가 원본이다 */
  years: Year[];
  currencyUnit: Settings['currencyUnit'];
  /** 작성 중 버전을 보고 있을 때만 true(AG-2·AV-2). 서버도 확정 버전 편집을 RULE로 거부한다 */
  editable: boolean;
  /** 규칙 패널에서 연차 finding을 눌렀을 때 그 연차 — 열을 강조하고 그 열로 스크롤한다(§7.9.8). 없으면 null */
  highlightYearId?: string | null;
  /** 저장 성공·충돌 후 다시 불러오기 — 셸이 router.refresh 등으로 새 값을 받는다 */
  onChanged: () => void;
}

export default function CategoryView({
  projectId,
  view,
  currencyUnit,
  editable,
  highlightYearId = null,
  onChanged,
}: CategoryViewProps) {
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<Failure | null>(null);
  const [conflict, setConflict] = useState<string | null>(null);
  const yearHeaderRefs = useRef(new Map<string, HTMLTableCellElement>());

  const model = view.categoryView;
  const version = view.version;

  // 연차가 많으면 표가 가로로 넘친다 — 강조한 열이 화면 밖이면 "눌러도 아무 일 없음"으로 보인다
  useEffect(() => {
    if (highlightYearId === null) return;
    yearHeaderRefs.current
      .get(highlightYearId)
      ?.scrollIntoView({ block: 'nearest', inline: 'center', behavior: 'smooth' });
  }, [highlightYearId]);
  const yearTint = (yearId: string): string =>
    yearId === highlightYearId ? 'bg-blue-50 print:bg-transparent' : '';

  async function saveCell(target: CellTarget, amount: number): Promise<boolean> {
    setBusy(true);
    setFailure(null);
    try {
      const res = await setAgreementCellAmount(version.id, target.yearId, target.category, target.axis, amount);
      if (!res.ok) {
        if (res.code === 'STALE') setConflict(res.error);
        else setFailure({ message: res.error, code: res.code });
        return false;
      }
      onChanged();
      return true;
    } catch (e) {
      // 네트워크 단절 등 — 저장됐는지 모르는 채로 넘어가지 않는다
      setFailure({ message: `금액을 저장하지 못했습니다: ${e instanceof Error ? e.message : String(e)}` });
      return false;
    } finally {
      setBusy(false);
    }
  }

  const readOnlyReason =
    version.status === 'confirmed'
      ? `${AGREEMENT_VERSION_STATUS_LABELS.confirmed}된 버전이라 금액을 고칠 수 없습니다. 버전 정보는 [버전 정보]에서 고칠 수 있습니다.`
      : '이 버전은 지금 읽기 전용입니다.';

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="space-y-0.5 text-t7 text-grey-500 print:text-black">
          <p>
            금액 표시 단위 {currencyUnit} · {NO_LINE}는 금액 줄이 없는 칸입니다(0원과 다릅니다).
          </p>
          {editable ? (
            <p className="print:hidden">
              현금·현물 칸을 눌러 원 단위로 고칩니다. 세목 줄이 여럿인 칸은 차액을 세목 미지정 줄이 맡습니다.
            </p>
          ) : (
            <p className="print:hidden">{readOnlyReason}</p>
          )}
        </div>
        <TableActions
          projectId={projectId}
          model={view.categoryTable}
          workbook={{ view: 'category', versionId: version.id }}
        />
      </div>

      {failure !== null && (
        <ErrorBanner
          message={failure.message}
          code={failure.code}
          className="whitespace-pre-line print:hidden"
          onDismiss={() => setFailure(null)}
        />
      )}

      {model.years.length === 0 ? (
        <p className="rounded-xl border border-dashed border-grey-300 bg-surface p-6 text-center text-t7 text-grey-500">
          이 과제에 연차가 없어 금액을 넣을 칸이 없습니다. 과제 개요에서 단계·연차를 먼저 만드세요.
        </p>
      ) : (
        <div className={`overflow-x-auto rounded-xl border border-grey-200 bg-surface ${PRINT_TABLE_WRAP}`}>
          <table className={`w-full min-w-max text-xs ${PRINT_TABLE}`}>
            <caption className="sr-only">
              협약 예산 비목별 매트릭스 — {version.name}. 연차마다 현금·현물·계, 끝에 총계. 줄이 없는 칸은 {NO_LINE}.
            </caption>
            <thead className="text-grey-500 print:text-black">
              <tr className="border-b border-grey-100">
                <th scope="col" rowSpan={2} className={`px-3 py-2 text-left font-medium ${PRINT_TH}`}>
                  비목
                </th>
                {model.years.map((y) => (
                  <th
                    key={y.id}
                    scope="colgroup"
                    colSpan={3}
                    ref={(el) => {
                      if (el) yearHeaderRefs.current.set(y.id, el);
                      else yearHeaderRefs.current.delete(y.id);
                    }}
                    className={`border-l border-grey-100 px-3 py-2 text-center font-medium text-grey-700 ${yearTint(y.id)} ${PRINT_TH}`}
                  >
                    {y.name}
                  </th>
                ))}
                <th
                  scope="colgroup"
                  colSpan={3}
                  className={`border-l border-grey-200 px-3 py-2 text-center font-semibold text-grey-800 ${PRINT_TH}`}
                >
                  총계
                </th>
              </tr>
              <tr className="border-b border-grey-100">
                {[...model.years.map((y) => y.id), 'total'].map((slot) =>
                  [DETAIL_AXIS_LABELS.cash, DETAIL_AXIS_LABELS.in_kind, TOTAL_LABEL].map((axisLabel, i) => (
                    <th
                      key={`${slot}-${axisLabel}`}
                      scope="col"
                      className={`px-3 py-1.5 text-right font-medium ${i === 0 ? 'border-l border-grey-100' : ''} ${yearTint(slot)} ${PRINT_TH}`}
                    >
                      {axisLabel}
                    </th>
                  ))
                )}
              </tr>
            </thead>

            <tbody className="divide-y divide-grey-100">
              {model.rows.map((row, rowIndex) => {
                const group = BUDGET_CATEGORY_GROUPS[row.category];
                const previous = rowIndex === 0 ? undefined : model.rows[rowIndex - 1];
                const groupChanged =
                  previous !== undefined && BUDGET_CATEGORY_GROUPS[previous.category] !== group;
                return (
                  <tr
                    key={row.category}
                    data-category={row.category}
                    className={groupChanged ? 'border-t-2 border-t-grey-200' : ''}
                  >
                    <th scope="row" className={`px-3 py-1.5 text-left font-medium text-grey-800 ${PRINT_TD}`}>
                      {row.label}
                    </th>
                    {row.byYear.map((cell, yi) => {
                      const year = model.years[yi]!;
                      const label = `${year.name} ${row.label}`;
                      const axisCell = (axis: DetailAxis, value: number | null, first: boolean) => (
                        <td
                          key={axis}
                          className={`px-1.5 py-1 text-right ${first ? 'border-l border-grey-100' : ''} ${yearTint(year.id)} ${PRINT_TD}`}
                        >
                          {editable ? (
                            <AmountCell
                              value={value}
                              label={`${label} ${DETAIL_AXIS_LABELS[axis]}`}
                              currencyUnit={currencyUnit}
                              disabled={busy}
                              onSave={(amount) => saveCell({ yearId: year.id, category: row.category, axis }, amount)}
                            />
                          ) : (
                            <StaticAmount value={value} currencyUnit={currencyUnit} />
                          )}
                        </td>
                      );
                      return [
                        axisCell('cash', cell.cash, true),
                        axisCell('in_kind', cell.inKind, false),
                        <td
                          key="total"
                          className={`px-1.5 py-1 text-right print:bg-transparent ${
                            year.id === highlightYearId ? 'bg-blue-50' : 'bg-grey-50'
                          } ${PRINT_TD}`}
                        >
                          <StaticAmount value={cell.total} currencyUnit={currencyUnit} strong />
                        </td>,
                      ];
                    })}
                    <TotalCells amounts={row.total} currencyUnit={currencyUnit} />
                  </tr>
                );
              })}
            </tbody>

            <tfoot className="border-t-2 border-grey-200 bg-grey-50 print:bg-transparent">
              <tr>
                <th scope="row" className={`px-3 py-2 text-left font-semibold text-grey-800 ${PRINT_TH}`}>
                  합계
                </th>
                {model.yearTotals.map((t, yi) => (
                  <TotalCells key={model.years[yi]!.id} amounts={t} currencyUnit={currencyUnit} />
                ))}
                <TotalCells amounts={model.grandTotal} currencyUnit={currencyUnit} />
              </tr>
            </tfoot>
          </table>
        </div>
      )}

      {conflict !== null && (
        <ConflictDialog
          message={conflict}
          // 셀 편집은 O-2 — 다시 불러오면 서버가 새로 읽은 줄 version으로 다음 저장을 판정한다
          onReload={() => {
            setConflict(null);
            onChanged();
          }}
          onKeepEditing={() => setConflict(null)}
        />
      )}
    </div>
  );
}

/** 합계 성격의 세 칸(현금·현물·계) — 전부 파생 값이라 편집하지 않는다 */
function TotalCells({ amounts, currencyUnit }: { amounts: AxisAmounts; currencyUnit: Settings['currencyUnit'] }) {
  return (
    <>
      <td className={`border-l border-grey-200 px-1.5 py-1 text-right ${PRINT_TD}`}>
        <StaticAmount value={amounts.cash} currencyUnit={currencyUnit} strong />
      </td>
      <td className={`px-1.5 py-1 text-right ${PRINT_TD}`}>
        <StaticAmount value={amounts.inKind} currencyUnit={currencyUnit} strong />
      </td>
      <td className={`bg-grey-50 px-1.5 py-1 text-right print:bg-transparent ${PRINT_TD}`}>
        <StaticAmount value={amounts.total} currencyUnit={currencyUnit} strong />
      </td>
    </>
  );
}
