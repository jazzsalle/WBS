'use client';

// 협약 예산 조정회의형 보기 — 변경전(제안) · 변경후(보고 있는 버전) 두 표 (SOT §6.19 AG-4, D-7 개정, §7.9.8 "조정회의형 보기")
//
// 숫자는 전부 서버(getAgreementData → lib/agreement/adjustment-view)가 만든 모델이다 — 여기서는 그리기만 한다.
// 읽기 전용이다(AG-4): 편집은 비목별·붙임4형 보기에서 하고, 이 보기는 같은 소스를 다시 읽을 뿐이다(AG-1).
// 변경전 변환이 실패하면 그 표는 0이 아니라 "—"와 사유를 보인다 — 0으로 채우면 "제안에서 전부 삭감됐다"로
// 읽힌다(절대 규칙 5).
//
// 인쇄 머리말·가로 방향은 셸(AgreementScreen)의 몫이다(P-R4).

import type { Settings } from '@/types';
import type { AgreementVersionView } from '@/actions/agreement';
import { ADJUSTMENT_INDIRECT_RATE_LABEL, type AdjustmentSide } from '@/lib/agreement/adjustment-view';
import { formatRate, RATE_NONE_TEXT } from '@/lib/agreement/rates';
import HelpLink from '@/components/help/HelpLink';
import { PRINT_TABLE, PRINT_TABLE_WRAP, PRINT_TD, PRINT_TH } from '@/components/print/tokens';
import TableActions from './TableActions';
import { FormCell } from './Attachment4View';

function SideTable({
  side,
  badge,
  currencyUnit,
}: {
  side: AdjustmentSide;
  /** 머리 옆 표식("현재 버전 아님") — 없으면 null */
  badge: string | null;
  currencyUnit: Settings['currencyUnit'];
}) {
  const header = side.headerIndirectRate;
  return (
    <section className="min-w-0 space-y-2">
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <h3 className="flex items-center gap-1.5 text-t6 font-semibold text-grey-800 print:text-black">
          {side.label}
          {badge !== null && (
            <span className="rounded bg-orange-50 px-1.5 py-0.5 text-[10px] font-semibold text-orange-800 print:border print:border-black print:bg-transparent print:text-black">
              {badge}
            </span>
          )}
        </h3>
        <p className="text-t7 text-grey-600 print:text-black">
          *{ADJUSTMENT_INDIRECT_RATE_LABEL}{' '}
          <span
            title={header.value === null ? header.reason : undefined}
            className={`tabular-nums ${header.value === null ? 'text-grey-400' : 'font-semibold text-grey-900 print:text-black'}`}
          >
            {formatRate(header)}
          </span>
        </p>
      </div>

      {!side.available && (
        <div role="status" className="rounded-xl border border-orange-200 bg-orange-50 p-3 text-t7 text-orange-800 print:border-black print:bg-transparent print:text-black">
          <p className="font-semibold">제안 데이터를 변경전 표로 바꾸지 못했습니다 — 0으로 채우지 않고 {RATE_NONE_TEXT}로 둡니다.</p>
          <ul className="mt-1 list-disc space-y-0.5 pl-5 whitespace-pre-line">
            {side.failureReasons.map((reason, i) => (
              <li key={i}>{reason}</li>
            ))}
          </ul>
          <p className="mt-1 print:hidden">제안 모드에서 사유를 고치면 이 표가 다시 채워집니다.</p>
        </div>
      )}

      <div className={`overflow-x-auto rounded-xl border border-grey-200 bg-surface ${PRINT_TABLE_WRAP}`}>
        <table className={`w-full min-w-max text-xs ${PRINT_TABLE}`}>
          <caption className="sr-only">
            조정회의 {side.label}. 항목 × 연차와 합계. 값이 없는 칸은 {RATE_NONE_TEXT}.
          </caption>
          <thead className="text-grey-500 print:text-black">
            <tr className="border-b border-grey-100">
              <th scope="col" className={`px-3 py-2 text-left font-medium ${PRINT_TH}`}>
                항목
              </th>
              {side.columns.map((col) => (
                <th
                  key={`${col.kind}-${col.key}`}
                  scope="col"
                  className={`border-l border-grey-100 px-3 py-2 text-right font-medium text-grey-700 ${
                    col.kind === 'total' ? 'bg-grey-50 print:bg-transparent' : ''
                  } ${PRINT_TH}`}
                >
                  {col.label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-grey-100">
            {side.rows.map((row) => {
              const strong = row.id === 'subtotal' || row.id === 'total';
              return (
                <tr key={row.id} data-row={row.id} className={strong ? 'bg-grey-50 print:bg-transparent' : ''}>
                  <th
                    scope="row"
                    className={`px-3 py-1.5 text-left ${strong ? 'font-semibold text-grey-900' : 'font-medium text-grey-800'} ${PRINT_TD}`}
                  >
                    {row.label}
                  </th>
                  {row.cells.map((cell, ci) => {
                    const col = side.columns[ci]!;
                    return (
                      <td
                        key={`${col.kind}-${col.key}`}
                        className={`border-l border-grey-100 px-1.5 py-1 text-right ${
                          col.kind === 'total' ? 'bg-grey-50 print:bg-transparent' : ''
                        } ${PRINT_TD}`}
                      >
                        <FormCell cell={cell} currencyUnit={currencyUnit} strong={strong || col.kind === 'total'} />
                      </td>
                    );
                  })}
                </tr>
              );
            })}
            <tr data-row="indirect_rate">
              <th scope="row" className={`px-3 py-1.5 text-left font-medium text-grey-800 ${PRINT_TD}`}>
                {ADJUSTMENT_INDIRECT_RATE_LABEL}
              </th>
              {side.indirectRates.map((cell, ci) => {
                const col = side.columns[ci]!;
                return (
                  <td
                    key={`${col.kind}-${col.key}`}
                    className={`border-l border-grey-100 px-1.5 py-1 text-right ${
                      col.kind === 'total' ? 'bg-grey-50 print:bg-transparent' : ''
                    } ${PRINT_TD}`}
                  >
                    <FormCell cell={cell} currencyUnit={currencyUnit} />
                  </td>
                );
              })}
            </tr>
          </tbody>
        </table>
      </div>
    </section>
  );
}

export interface AdjustmentViewProps {
  projectId: string;
  view: AgreementVersionView;
  currencyUnit: Settings['currencyUnit'];
}

export default function AdjustmentView({ projectId, view, currencyUnit }: AdjustmentViewProps) {
  const model = view.adjustment.view;
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="space-y-0.5 text-t7 text-grey-500 print:text-black">
          <p className="flex items-center gap-1.5">
            <span>
              금액 표시 단위 {currencyUnit} · 변경전은 제안 모드 사업비, 변경후는 이 협약 버전입니다. {RATE_NONE_TEXT}는 값이
              없는 칸입니다(0원과 다릅니다 — 칸에 마우스를 올리면 이유가 보입니다).
            </span>
            <HelpLink slug="agreement" anchor="조정회의형" />
          </p>
          <p className="print:hidden">읽기 전용입니다. 금액은 비목별·붙임4형 보기나 제안 모드에서 고칩니다.</p>
        </div>
        <TableActions
          projectId={projectId}
          model={view.adjustment.table}
          workbook={{ view: 'adjustment', versionId: view.version.id }}
        />
      </div>

      <div className="grid gap-4 xl:grid-cols-2 print:grid-cols-2">
        <SideTable side={model.before} badge={null} currencyUnit={currencyUnit} />
        <SideTable side={model.after} badge={model.notCurrentLabel} currencyUnit={currencyUnit} />
      </div>
    </div>
  );
}
