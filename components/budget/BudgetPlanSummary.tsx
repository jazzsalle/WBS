// 제안 모드 하단 요약 — 연차별 합계 · 현금/현물 비중 · 지침 검증 **값** (SOT §7.9 모드 표,
// §6.10.3 PL-11~PL-13, §5.12·S-4)
//
// **이 파일에는 나눗셈이 없다.** E1·수정직접비·축 합계는 전부 서버가 evaluateBudgetRules·computeAxisSplit으로
// 계산해 내려준 값(yearRules·yearAxisSplits)이고 여기서는 표시만 한다 — 같은 규칙이 두 곳에 생기면 반드시
// 어긋난다(O-4).
//
//  - 한도 판정·비율 표는 여기 없다. Phase 13부터 §6.14 규칙 행이 한도를 갖고, 비율·위반·판정 못 함은
//    아래 규칙 검증 패널(rules/RuleFindingsPanel)이 보여 준다. 이 표는 그 비율의 **재료**(E1·수정직접비·총액)만
//    적어 "왜 그 비율인가"를 옆에서 읽게 한다
//  - §7.9 현금/현물 비중: `cashAmount`·`inKindAmount`는 §5.12·S-4상 null(미입력)일 수 있다.
//    미입력을 0으로 눙쳐 합산하면 사용자가 입력한 적 없는 '현물 0원'이 만들어지므로,
//    축이 없는 금액(`unspecified`)이 0이 아니면 **비중 대신 그 금액을 적는다.**
//  - PL-5 음수 행·연봉 미입력·PL-10 합계 불일치는 배너로 드러낸다. 특히 합계 불일치는
//    트랜잭션 불변식이 깨진 것이라 조용히 넘길 수 없다 (절대 규칙 5)
//
// 인쇄(§12 P-R1~P-R5): 매트릭스와 함께 가로로 나간다. 편집 안내·링크만 print:hidden이고 숫자는 종이에 남는다.

import Link from 'next/link';
import type { Settings } from '@/types';
import type { BudgetPlanYearAxisView, BudgetPlanYearView } from '@/actions/budget-plan';
import type { YearAxisSplit } from '@/lib/budget-plan';
import { formatAmount } from '@/lib/currency';
import ErrorBanner from '@/components/ui/ErrorBanner';
import { PRINT_TABLE, PRINT_TABLE_WRAP, PRINT_TD, PRINT_TH } from '@/components/print/tokens';

export interface BudgetPlanSummaryProps {
  /** 매트릭스와 같은 열 순서 (matrix.columns) — 위아래 표의 연차가 어긋나면 읽을 수 없다 */
  columns: readonly { yearId: string; name: string }[];
  yearRules: readonly BudgetPlanYearView[];
  /** §7.9 현금/현물 비중. yearRules와 같은 연차 집합이다 (서버가 같은 소스로 만든다) */
  yearAxisSplits: readonly BudgetPlanYearAxisView[];
  currencyUnit: Settings['currencyUnit'];
  /** 연봉 미입력 안내가 거는 인력 화면 링크 (§7.9.2) */
  projectId: string;
  /** PL-5 음수 행 수 (과제 전체) */
  negativeCount: number;
  /** 연봉 미입력으로 0원 처리된 인건비 행 수 */
  missingSalaryCount: number;
  /** PL-10 불변식이 깨진 셀 수 */
  mismatchCount: number;
}

/**
 * 현금/현물 비중 표시. 소수 둘째 자리 — 비중은 한도 판정과 무관한 안내값이라 4자리(부록 B.9.1)까지 필요 없다.
 * 규칙 비율은 RuleFindingsPanel이 4자리로 적는다.
 */
function formatPercent(rate: number | null): string {
  if (rate === null) return '—';
  return `${(Math.round(rate * 100) / 100 + 0).toFixed(2)}%`; // +0: -0 이 '-0.00%'로 보이는 것을 막는다
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
        className="block font-semibold text-orange-700 print:text-black"
        title="현금/현물 구분이 없는 계획액이 있어 비중의 분모가 확정되지 않습니다. 수행 모드에서 셀을 열어 현금·현물을 나누거나, 제안 모드에서 산출근거를 넣으면 비중이 나옵니다."
      >
        미입력 {formatAmount(axis.unspecified, currencyUnit)} — 비중을 낼 수 없습니다
      </span>
    );
  }
  if (axis.shareBlockedBy === 'zero-total') {
    return (
      <span
        className="block text-grey-400 print:text-black"
        title="이 연차의 계획액이 0이라 비중을 내지 않습니다."
      >
        —
      </span>
    );
  }
  return (
    <span className="block tabular-nums text-grey-800 print:text-black">
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
      <span className="tabular-nums text-grey-800 print:text-black">
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
  return (
    <span className="tabular-nums text-grey-800 print:text-black">
      {formatAmount(row.amount(rules), currencyUnit)}
    </span>
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
          className="rounded-xl border border-orange-200 bg-orange-50 p-3 text-xs text-orange-800 print:border-grey-400 print:bg-transparent print:text-black"
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

      <div className={`overflow-x-auto rounded-xl border border-grey-200 bg-white ${PRINT_TABLE_WRAP}`}>
        <table className={`w-full text-left text-xs ${PRINT_TABLE}`}>
          <caption className="px-3 pt-2 text-left text-xs font-semibold text-grey-700 print:text-black">
            연차별 합계 · 현금/현물 비중 · 지침 검증 값
            <span className="ml-2 font-normal text-grey-400 print:text-black">
              비율·한도 판정은 아래 규칙 검증 패널에 있습니다 (§6.14)
            </span>
          </caption>
          <thead className="text-grey-500 print:text-black">
            <tr className="border-b border-grey-100">
              <th scope="col" className={`px-3 py-2 font-medium ${PRINT_TH}`}>
                항목
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
            </tr>
          </thead>

          <tbody className="divide-y divide-grey-100">
            {rows.map((row) => (
              <tr key={row.key} className="align-top">
                <th
                  scope="row"
                  className={`px-3 py-2 text-left font-medium text-grey-700 print:text-black ${PRINT_TD}`}
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

    </section>
  );
}

// ─── 표 행 정의 (전부 서버가 준 값이다 — 여기서 다시 계산하지 않는다) ────────

type Rules = BudgetPlanYearView['rules'];

type SummaryRow =
  | { key: string; label: string; hint: string; kind: 'amount'; amount: (rules: Rules) => number }
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
    key: 'modifiedDirectCost',
    label: '수정직접비 (간접비 기준액)',
    // PL-13: 어느 비목을 빼는지는 규칙 indirect_max의 base가 정한다 — 분모 이름은 규칙 검증 패널이 적는다
    hint: '직접비 전 비목의 현금 합계에서 규칙 indirect_max의 분모 정의(base)에 따라 위탁·국제공동·부담비 등을 뺀 값입니다 (PL-13, RL-3). 어느 분모인지는 아래 규칙 검증 패널의 간접비 상한 행에 있습니다.',
    kind: 'amount',
    amount: (rules) => rules.modifiedDirectCost,
  },
] as const;
