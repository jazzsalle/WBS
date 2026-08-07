// 제안 모드 하단 요약 — 연차별 합계 · 현금/현물 비중 · 지침 검증 배지 (SOT §7.9 모드 표,
// §6.10.3 PL-11~PL-15, §5.12·S-4)
//
// **이 파일에는 나눗셈이 없다.** 비율·기준액·위반 여부는 전부 서버가 evaluateBudgetRules·
// computeAxisSplit으로 계산해 내려준 값(yearRules·yearAxisSplits)이고 여기서는 표시만 한다 —
// 같은 규칙이 두 곳에 생기면 반드시 어긋난다(O-4). 반올림도 표시 시점에만 한다 (§6.1 P-8).
//
//  - PL-12 연구수당 비율 = 연구수당 / 수정인건비(E1). E1이 0이면 비율이 null이고 '—'로 적는다
//  - PL-13 간접비 비율 = 간접비 / 직접비 현금 기준액
//  - PL-15 한도(allowanceLimit·indirectLimit)가 null이면 **비율만 적고 배지는 없다.**
//    한도는 과제 개요(§7.3 BudgetRateLimitCard)에서 넣는다 — 이 화면은 판정에만 쓴다
//  - §7.9 현금/현물 비중: `cashAmount`·`inKindAmount`는 §5.12·S-4상 null(미입력)일 수 있다.
//    미입력을 0으로 눙쳐 합산하면 사용자가 입력한 적 없는 '현물 0원'이 만들어지므로,
//    축이 없는 금액(`unspecified`)이 0이 아니면 **비중 대신 그 금액을 적는다.**
//  - PL-5 음수 행·연봉 미입력·PL-10 합계 불일치는 배너로 드러낸다. 특히 합계 불일치는
//    트랜잭션 불변식이 깨진 것이라 조용히 넘길 수 없다 (절대 규칙 5)
//
// 인쇄(§12 P-R1~P-R5): 매트릭스와 함께 가로로 나간다. 편집 안내·링크만 print:hidden이고
// 숫자와 배지 글자는 종이에 남는다 — 배지 색이 흑백에서 사라져도 '초과'가 글자로 읽힌다.

import Link from 'next/link';
import type { Settings } from '@/types';
import type { BudgetPlanYearAxisView, BudgetPlanYearView } from '@/actions/budget-plan';
import type { YearAxisSplit } from '@/lib/budget-plan';
import { formatAmount } from '@/lib/currency';
import Badge from '@/components/ui/Badge';
import ErrorBanner from '@/components/ui/ErrorBanner';
import { PRINT_TABLE, PRINT_TABLE_WRAP, PRINT_TD, PRINT_TH } from '@/components/print/tokens';

export interface BudgetPlanSummaryProps {
  /** 매트릭스와 같은 열 순서 (matrix.columns) — 위아래 표의 연차가 어긋나면 읽을 수 없다 */
  columns: readonly { yearId: string; name: string }[];
  yearRules: readonly BudgetPlanYearView[];
  /** §7.9 현금/현물 비중. yearRules와 같은 연차 집합이다 (서버가 같은 소스로 만든다) */
  yearAxisSplits: readonly BudgetPlanYearAxisView[];
  currencyUnit: Settings['currencyUnit'];
  /** 한도 미입력 안내가 거는 과제 개요 링크 (PL-14 입력 자리는 §7.3이다) */
  projectId: string;
  /** PL-5 음수 행 수 (과제 전체) */
  negativeCount: number;
  /** 연봉 미입력으로 0원 처리된 인건비 행 수 */
  missingSalaryCount: number;
  /** PL-10 불변식이 깨진 셀 수 */
  mismatchCount: number;
}

/**
 * 비율 표시. 소수 둘째 자리까지 적는다 — 간접비 고시율은 소수점이 있는 값이고(부록 B.7.3의
 * 0.9622%), 한 자리로 줄이면 한도 근처에서 배지와 숫자가 서로 다른 말을 하는 것처럼 보인다.
 * **위반 판정은 이 반올림값이 아니라 서버의 over 플래그를 쓴다.**
 */
function formatPercent(rate: number | null): string {
  if (rate === null) return '—';
  return `${(Math.round(rate * 100) / 100 + 0).toFixed(2)}%`; // +0: -0 이 '-0.00%'로 보이는 것을 막는다
}

/** 반올림 전 값. 20.004%가 '20.00%'로 보일 때 배지의 근거를 title에서 확인할 수 있어야 한다 */
function rateTitle(rate: number | null, limit: number | null): string {
  const measured = rate === null ? '비율을 낼 수 없습니다(기준액 0).' : `계산값 ${rate}%`;
  return limit === null ? `${measured} 한도 미입력이라 위반 판정을 하지 않습니다 (PL-15).` : `${measured} 한도 ${limit}%`;
}

/** 서버가 준 비율·한도·위반 여부 한 벌 (PL-12 또는 PL-13) */
interface RateValue {
  rate: number | null;
  limit: number | null;
  over: boolean;
}

interface RateCellProps extends RateValue {
  /** 기준액이 0이라 비율이 없을 때 그 이유를 밝힌다 (PL-12·PL-13) */
  zeroBaseReason: string;
}

function RateCell({ rate, limit, over, zeroBaseReason }: RateCellProps) {
  return (
    <span className="block">
      <span
        className={`block font-semibold tabular-nums ${over ? 'text-red-600 print:text-black' : 'text-slate-800'}`}
        title={rate === null ? zeroBaseReason : rateTitle(rate, limit)}
      >
        {formatPercent(rate)}
      </span>
      {/* PL-15: 한도가 null이면 비율만 적고 배지를 띄우지 않는다 */}
      {limit !== null && (
        <span className="mt-0.5 block">
          {over ? (
            // P-R5: 흑백 출력에서도 읽히도록 '초과'를 글자로 남긴다
            <Badge tone="red" title="협의 중인 계획이 한도를 넘을 수 있습니다. 저장은 막지 않습니다 (PL-15)">
              한도 {limit}% 초과
            </Badge>
          ) : (
            <span className="text-[11px] text-slate-400 print:text-black">한도 {limit}%</span>
          )}
        </span>
      )}
    </span>
  );
}

/**
 * §7.9 현금/현물 비중. 비율은 서버가 낸 값이고 여기서는 **어느 문장을 쓸지**만 고른다.
 * 왜 셋으로 갈리는가는 shareBlockedBy가 이미 말해 준다 — 화면이 다시 판정하지 않는다.
 */
function AxisShareCell({
  axis,
  currencyUnit,
}: {
  axis: YearAxisSplit;
  currencyUnit: Settings['currencyUnit'];
}) {
  if (axis.shareBlockedBy === 'unspecified') {
    // 모르는 값을 분모에 넣어 그럴듯한 비율을 만들지 않는다 (절대 규칙 5, PL-14와 같은 태도).
    // 미입력 금액을 그대로 적어 "얼마가 아직 안 나뉘었는지"를 화면에서 바로 읽게 한다
    return (
      <span
        className="block font-semibold text-amber-700 print:text-black"
        title="현금/현물 구분이 없는 계획액이 있어 비중의 분모가 확정되지 않습니다. 수행 모드에서 셀을 열어 현금·현물을 나누거나, 제안 모드에서 산출근거를 넣으면 비중이 나옵니다."
      >
        미입력 {formatAmount(axis.unspecified, currencyUnit)} — 비중을 낼 수 없습니다
      </span>
    );
  }
  if (axis.shareBlockedBy === 'zero-total') {
    return (
      <span
        className="block text-slate-400 print:text-black"
        title="이 연차의 계획액이 0이라 비중을 내지 않습니다."
      >
        —
      </span>
    );
  }
  return (
    <span className="block tabular-nums text-slate-800 print:text-black">
      현금 {formatPercent(axis.cashRate)} · 현물 {formatPercent(axis.inKindRate)}
    </span>
  );
}

/** 매트릭스에는 있는데 그 연차의 계산 결과가 조회에 없다 — 0으로 채우지 않고 사실을 적는다 */
function MissingCell({ label, title }: { label: string; title: string }) {
  return (
    <span className="font-semibold text-red-600 print:text-black" title={title}>
      {label}
    </span>
  );
}

function SummaryCell({
  row,
  rules,
  axis,
  currencyUnit,
}: {
  row: SummaryRow;
  rules: Rules | undefined;
  axis: YearAxisSplit | undefined;
  currencyUnit: Settings['currencyUnit'];
}) {
  if (row.kind === 'axisAmount' || row.kind === 'axisShare') {
    if (axis === undefined) {
      return (
        <MissingCell label="합계 없음" title="이 연차의 현금/현물 합계가 조회 결과에 없습니다." />
      );
    }
    return row.kind === 'axisAmount' ? (
      <span className="tabular-nums text-slate-800 print:text-black">
        {formatAmount(row.amount(axis), currencyUnit)}
      </span>
    ) : (
      <AxisShareCell axis={axis} currencyUnit={currencyUnit} />
    );
  }

  if (rules === undefined) {
    return (
      <MissingCell label="검증 없음" title="이 연차의 지침 검증 결과가 조회 결과에 없습니다." />
    );
  }
  return row.kind === 'amount' ? (
    <span className="tabular-nums text-slate-800 print:text-black">
      {formatAmount(row.amount(rules), currencyUnit)}
    </span>
  ) : (
    <RateCell {...row.rate(rules)} zeroBaseReason={row.zeroBaseReason} />
  );
}

export default function BudgetPlanSummary({
  columns,
  yearRules,
  yearAxisSplits,
  currencyUnit,
  projectId,
  negativeCount,
  missingSalaryCount,
  mismatchCount,
}: BudgetPlanSummaryProps) {
  const rulesByYear = new Map(yearRules.map((view) => [view.yearId, view.rules]));
  const axisByYear = new Map(yearAxisSplits.map((view) => [view.yearId, view.axis]));

  // 축이 없는 금액이 어디에도 없으면 이 행은 언제나 0이라 비중 행이 이미 전부를 말한다.
  // 한 연차에서라도 나오면 **모든 연차에** 남겨야 어느 연차가 미입력인지 나란히 비교된다
  const hasUnspecified = yearAxisSplits.some((view) => view.axis.unspecified !== 0);
  const rows = hasUnspecified
    ? SUMMARY_ROWS
    : SUMMARY_ROWS.filter((row) => row.key !== 'axisUnspecified');

  // 한도가 하나라도 비어 있으면 그 검사는 돌지 않는다 — 어디서 넣는지 알려 준다 (PL-14)
  const missingLimits = columns.some((column) => {
    const rules = rulesByYear.get(column.yearId);
    return rules !== undefined && (rules.allowanceLimit === null || rules.indirectLimit === null);
  });

  return (
    <section aria-label="제안 모드 요약" className="space-y-3">
      {mismatchCount > 0 && (
        // PL-10은 트랜잭션 불변식이다. 깨졌다면 화면의 계획액과 산출근거가 서로 다른 값이라는 뜻이라
        // 아래 비율도 믿을 수 없다 — 가장 먼저, 가장 크게 알린다
        <ErrorBanner
          code="RULE"
          message={`저장된 계획액이 산출근거 합계와 다른 셀이 ${mismatchCount}건 있습니다 (PL-10 불변식 위반). 해당 셀의 '합계 불일치' 표시를 확인하고, 산출근거 패널에서 행을 한 번 저장하면 합계가 다시 맞춰집니다. 반복되면 관리자에게 알리세요.`}
        />
      )}

      {(negativeCount > 0 || missingSalaryCount > 0) && (
        <div
          role="alert"
          className="rounded-xl border border-amber-200 bg-amber-50 p-3 text-xs text-amber-800 print:border-slate-400 print:bg-transparent print:text-black"
        >
          {negativeCount > 0 && (
            <p>
              금액이 음수인 산출근거 행 <strong>{negativeCount}건</strong> — 조정액을 확인하세요.
              0으로 자르지 않고 그대로 합계에 들어갑니다 (PL-5).
            </p>
          )}
          {missingSalaryCount > 0 && (
            <p className={negativeCount > 0 ? 'mt-1' : ''}>
              연봉이 비어 있어 0원으로 계산된 인건비 행 <strong>{missingSalaryCount}건</strong> —{' '}
              <Link
                href={`/projects/${projectId}/team`}
                className="font-semibold underline underline-offset-2 print:hidden"
              >
                인력 화면에서 연봉 입력
              </Link>
            </p>
          )}
        </div>
      )}

      <div className={`overflow-x-auto rounded-xl border border-slate-200 bg-white ${PRINT_TABLE_WRAP}`}>
        <table className={`w-full text-left text-xs ${PRINT_TABLE}`}>
          <caption className="px-3 pt-2 text-left text-xs font-semibold text-slate-700 print:text-black">
            연차별 합계 · 현금/현물 비중 · 지침 검증
            <span className="ml-2 font-normal text-slate-400 print:text-black">
              지침 검증은 경고일 뿐 저장·반영을 막지 않습니다 (PL-15)
            </span>
          </caption>
          <thead className="text-slate-500 print:text-black">
            <tr className="border-b border-slate-100">
              <th scope="col" className={`px-3 py-2 font-medium ${PRINT_TH}`}>
                항목
              </th>
              {columns.map((column) => (
                <th
                  key={column.yearId}
                  scope="col"
                  className={`px-3 py-2 text-right font-medium text-slate-700 print:text-black ${PRINT_TH}`}
                >
                  {column.name}
                </th>
              ))}
            </tr>
          </thead>

          <tbody className="divide-y divide-slate-100">
            {rows.map((row) => (
              <tr key={row.key} className="align-top">
                <th
                  scope="row"
                  className={`px-3 py-2 text-left font-medium text-slate-700 print:text-black ${PRINT_TD}`}
                  title={row.hint}
                >
                  {row.label}
                </th>
                {columns.map((column) => (
                  <td key={column.yearId} className={`px-3 py-2 text-right ${PRINT_TD}`}>
                    <SummaryCell
                      row={row}
                      rules={rulesByYear.get(column.yearId)}
                      axis={axisByYear.get(column.yearId)}
                      currencyUnit={currencyUnit}
                    />
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {missingLimits && (
        <p className="text-[11px] text-slate-500 print:hidden">
          한도가 비어 있는 검사는 비율만 표시하고 위반 판정을 하지 않습니다 (PL-15). 한도는{' '}
          <Link
            href={`/projects/${projectId}`}
            className="font-semibold underline underline-offset-2"
          >
            과제 개요 &gt; 지침 한도
          </Link>
          에서 넣습니다. 부처·기관 유형마다 고시율이 다르므로 도구가 기본값을 지어내지 않습니다
          (PL-16).
        </p>
      )}
    </section>
  );
}

// ─── 표 행 정의 (전부 서버가 준 값이다 — 여기서 다시 계산하지 않는다) ────────

type Rules = BudgetPlanYearView['rules'];

type SummaryRow =
  | { key: string; label: string; hint: string; kind: 'amount'; amount: (rules: Rules) => number }
  | {
      key: string;
      label: string;
      hint: string;
      kind: 'rate';
      zeroBaseReason: string;
      rate: (rules: Rules) => RateValue;
    }
  // §7.9 현금/현물 비중은 yearRules가 아니라 yearAxisSplits에서 읽는다 —
  // 지침 검증(기준액이 규정별로 다르다)과 축 합계는 다른 질문이라 한 값에 섞지 않는다
  | { key: string; label: string; hint: string; kind: 'axisAmount'; amount: (axis: YearAxisSplit) => number }
  | { key: string; label: string; hint: string; kind: 'axisShare' };

const SUMMARY_ROWS: readonly SummaryRow[] = [
  {
    key: 'grandTotal',
    label: '연구개발비 총액',
    hint: '그 연차 12비목의 계획액 합계입니다.',
    kind: 'amount',
    amount: (rules) => rules.grandTotal,
  },
  {
    key: 'directTotal',
    label: '직접비',
    hint: '총액 − 간접비.',
    kind: 'amount',
    amount: (rules) => rules.directTotal,
  },
  {
    key: 'indirectTotal',
    label: '간접비',
    hint: '간접비 비목 합계입니다.',
    kind: 'amount',
    amount: (rules) => rules.indirectTotal,
  },
  {
    key: 'axisCash',
    label: '현금',
    hint: '현금으로 확정된 계획액의 합입니다 (§7.9).',
    kind: 'axisAmount',
    amount: (axis) => axis.cash,
  },
  {
    key: 'axisInKind',
    label: '현물',
    hint: '현물로 확정된 계획액의 합입니다 (§7.9).',
    kind: 'axisAmount',
    amount: (axis) => axis.inKind,
  },
  {
    key: 'axisUnspecified',
    label: '└ 현금/현물 구분 없음',
    // §5.12·S-4: 총액만 입력했거나 총괄표 임포트에 축 라벨이 없던 셀이 여기 모인다.
    // 산출근거가 있는 셀은 §5.17상 축이 필수라 여기 오지 않는다
    hint: '현금·현물이 입력되지 않은 계획액입니다 (§5.12·S-4). 0이 아니면 비중을 내지 않습니다 — 미입력을 0으로 보면 없는 현물을 지어내게 됩니다.',
    kind: 'axisAmount',
    amount: (axis) => axis.unspecified,
  },
  {
    key: 'axisShare',
    label: '현금/현물 비중',
    hint: '현금 ÷ 총액, 현물 ÷ 총액. 구분 없는 금액이 남아 있으면 분모가 확정되지 않으므로 비율 대신 그 금액을 적습니다.',
    kind: 'axisShare',
  },
  {
    key: 'modifiedPersonnel',
    label: '수정인건비 (E1)',
    // PL-11: 연구지원인력인건비(C)만 빠진다. 인건비 합계와 다른 이유를 표에서 읽을 수 있어야 한다
    hint: '(인건비 − 연구지원인력인건비) + 학생인건비. 현금 + 현물이며 연구수당 비율의 기준액입니다 (PL-11).',
    kind: 'amount',
    amount: (rules) => rules.modifiedPersonnel,
  },
  {
    key: 'personnelSupportTotal',
    label: '└ E1에서 뺀 연구지원인력인건비',
    hint: 'PL-11이 E1에서 제외하는 세목(C)입니다. 간접비 기준액에서는 빠지지 않습니다.',
    kind: 'amount',
    amount: (rules) => rules.personnelSupportTotal,
  },
  {
    key: 'allowanceTotal',
    label: '연구수당',
    hint: '연구수당 비목 합계입니다.',
    kind: 'amount',
    amount: (rules) => rules.allowanceTotal,
  },
  {
    key: 'allowanceRate',
    label: '연구수당 비율 (PL-12)',
    hint: '연구수당 ÷ 수정인건비(E1) × 100.',
    kind: 'rate',
    zeroBaseReason: '수정인건비(E1)가 0이라 비율을 내지 않습니다 (PL-12).',
    rate: (rules) => ({
      rate: rules.allowanceRate,
      limit: rules.allowanceLimit,
      over: rules.allowanceOver,
    }),
  },
  {
    key: 'indirectBase',
    label: '간접비 기준액 (직접비 현금)',
    hint: '인건비·학생인건비·연구시설장비비·재료비·연구활동비·연구수당의 현금 합계입니다 (PL-13). 연구지원인력인건비는 여기에 포함됩니다.',
    kind: 'amount',
    amount: (rules) => rules.indirectBase,
  },
  {
    key: 'indirectRate',
    label: '간접비 비율 (PL-13)',
    hint: '간접비 ÷ 직접비 현금 기준액 × 100.',
    kind: 'rate',
    zeroBaseReason: '직접비 현금 기준액이 0이라 비율을 내지 않습니다 (PL-13).',
    rate: (rules) => ({
      rate: rules.indirectRate,
      limit: rules.indirectLimit,
      over: rules.indirectOver,
    }),
  },
] as const;
