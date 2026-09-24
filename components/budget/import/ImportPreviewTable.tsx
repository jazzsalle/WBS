'use client';

// Step 5 반영 예정 내역 테이블 (SOT §7.9.1 Step 5)
//  열: 연차 / 비목 / 계획액 / 현금 / 현물 / 상태
//  행 상태: 신규(초록) / 덮어씀(주황) / 건너뜀(회색) / 잠김(회색·자물쇠, S-14) / 오류(빨강)
//  덮어쓸 기존 값은 `기존 → 신규`로 나란히 보여준다.
//  잠김 행은 파일 값이 반영되지 않으므로 **유지되는 기존 값**을 보여준다 (S-14).
//
// 금액은 원 단위 정수로 넘어온다. 표시 환산만 lib/currency.formatAmount가 한다 (B-4).

import type { PreviewRow, PreviewRowStatus, Settings } from '@/types';
import { BUDGET_CATEGORY_LABELS } from '@/lib/constants';
import { formatAmount } from '@/lib/currency';

const STATUS_CLASS: Record<PreviewRowStatus, string> = {
  new: 'bg-green-50 text-green-800',
  overwrite: 'bg-orange-50 text-orange-800',
  skipped: 'bg-grey-50 text-grey-400',
  locked: 'bg-grey-100 text-grey-500',  // S-14 잠김 — 회색
  error: 'bg-red-50 text-red-700',
};

const STATUS_ORDER: Record<PreviewRowStatus, number> = {
  error: 0,
  overwrite: 1,
  new: 2,
  locked: 3,
  skipped: 4,
};

export interface ImportPreviewTableProps {
  rows: PreviewRow[];
  yearNameById: Record<string, string>;
  currencyUnit: Settings['currencyUnit'];
}

export default function ImportPreviewTable({
  rows,
  yearNameById,
  currencyUnit,
}: ImportPreviewTableProps) {
  // 오류를 먼저 보여준다 — 반영을 막는 원인이라 사용자가 가장 먼저 봐야 한다
  const sorted = [...rows].sort(
    (a, b) =>
      STATUS_ORDER[a.status] - STATUS_ORDER[b.status] ||
      (a.yearOrder ?? 99) - (b.yearOrder ?? 99) ||
      (a.sourceRowIndexes[0] ?? 0) - (b.sourceRowIndexes[0] ?? 0)
  );

  return (
    <div className="max-h-[24rem] overflow-auto rounded-xl border border-grey-200">
      <table className="w-full text-xs">
        <thead className="sticky top-0 bg-grey-50 text-grey-500">
          <tr>
            <th className="w-20 px-2 py-1.5 text-left">상태</th>
            <th className="w-28 px-2 py-1.5 text-left">연차</th>
            <th className="w-32 px-2 py-1.5 text-left">비목</th>
            <th className="px-2 py-1.5 text-right">계획액</th>
            <th className="px-2 py-1.5 text-right">현금</th>
            <th className="px-2 py-1.5 text-right">현물</th>
            <th className="px-2 py-1.5 text-left">비고</th>
          </tr>
        </thead>
        <tbody>
          {sorted.map((row, index) => (
            <tr key={`${row.status}-${row.sourceRowIndexes.join('_')}-${index}`} className="border-t border-grey-100">
              <td className="px-2 py-1.5">
                <span className={`rounded px-1.5 py-0.5 font-semibold ${STATUS_CLASS[row.status]}`}>
                  {row.status === 'locked' && <span aria-hidden className="mr-0.5">🔒</span>}
                  {row.statusLabel}
                </span>
              </td>
              <td className="px-2 py-1.5 text-grey-600">
                {row.yearId ? (yearNameById[row.yearId] ?? `${(row.yearOrder ?? 0) + 1}차년도`) : '—'}
              </td>
              <td className="px-2 py-1.5 text-grey-700">
                {row.category ? BUDGET_CATEGORY_LABELS[row.category] : (row.label ?? '—')}
              </td>
              <td className="px-2 py-1.5 text-right tabular-nums">
                <AmountCell
                  next={row.plannedAmount}
                  previous={row.existing?.plannedAmount ?? null}
                  overwrite={row.status === 'overwrite'}
                  locked={row.status === 'locked'}
                  currencyUnit={currencyUnit}
                />
                {/* 잠김 행이 보여주는 금액은 파일 값이 아니라 유지되는 산출근거 합계다 —
                    파일 값의 반올림(I-11) 표시를 여기 붙이면 엉뚱한 숫자를 가리킨다 */}
                {row.rounded && row.status !== 'locked' && (
                  <span className="ml-1 text-orange-600" title="소수점이 있어 반올림했습니다 (I-11)">
                    ≈
                  </span>
                )}
              </td>
              <td className="px-2 py-1.5 text-right tabular-nums">
                <AmountCell
                  next={row.cashAmount}
                  previous={row.existing?.cashAmount ?? null}
                  overwrite={row.status === 'overwrite'}
                  locked={row.status === 'locked'}
                  currencyUnit={currencyUnit}
                />
              </td>
              <td className="px-2 py-1.5 text-right tabular-nums">
                <AmountCell
                  next={row.inKindAmount}
                  previous={row.existing?.inKindAmount ?? null}
                  overwrite={row.status === 'overwrite'}
                  locked={row.status === 'locked'}
                  currencyUnit={currencyUnit}
                />
              </td>
              <td className="max-w-[18rem] px-2 py-1.5 text-grey-500">
                <span className="block truncate" title={row.reason ?? row.label ?? ''}>
                  {row.reason ?? row.label ?? ''}
                </span>
                {row.sourceRowIndexes.length > 0 && (
                  <span className="text-[10px] text-grey-400">
                    원본 {row.sourceRowIndexes.map((i) => i + 1).join(', ')}행
                  </span>
                )}
              </td>
            </tr>
          ))}
          {sorted.length === 0 && (
            <tr>
              <td colSpan={7} className="px-2 py-6 text-center text-grey-400">
                반영 예정 내역이 없습니다.
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}

/** 덮어쓰기면 `기존 → 신규`를 나란히 (§7.9.1 Step 5) */
function AmountCell({
  next,
  previous,
  overwrite,
  locked,
  currencyUnit,
}: {
  next: number | null;
  previous: number | null;
  overwrite: boolean;
  locked: boolean;
  currencyUnit: Settings['currencyUnit'];
}) {
  // S-14: 잠김 행은 파일 값이 버려지고 산출근거 합계가 그대로 남는다 — 남는 값을 보여준다
  if (locked) {
    return previous === null ? (
      <span className="text-grey-300">—</span>
    ) : (
      <span className="text-grey-500" title="산출근거 합계 — 그대로 유지됩니다">
        {formatAmount(previous, currencyUnit)}
      </span>
    );
  }
  if (next === null && previous === null) return <span className="text-grey-300">—</span>;
  return (
    <span>
      {overwrite && previous !== null && (
        <span className="text-grey-400 line-through">{formatAmount(previous, currencyUnit)}</span>
      )}
      {overwrite && previous !== null && <span className="mx-1 text-grey-400">→</span>}
      <span className="font-medium text-grey-700">
        {next === null ? '—' : formatAmount(next, currencyUnit)}
      </span>
    </span>
  );
}
