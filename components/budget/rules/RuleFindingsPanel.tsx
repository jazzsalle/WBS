'use client';

// 규칙 검증 패널 (SOT §7.9 "규칙 검증 패널" 불릿, §6.14 RL-1·RL-2·6.14.6, PL-8, 부록 E)
// Phase 9의 "지침 검증 줄"(한도 배지)을 대체한다. 제안 모드 하단에만 놓인다 — 배치는 BudgetScreen이 정한다.
//
// **이 파일에는 나눗셈도 판정도 없다.** 비율(`ratios`)·위반(`findings`)·판정 못 함(`skipped`)은 전부
// 서버가 lib/rules.ts로 계산해 내려준 값이고 여기서는 표시만 한다(O-4). 비율 셀의 색도 `findings`에 같은
// (code, scope)가 있는지로 정한다 — 화면이 actual > limit를 다시 비교하면 원값과 표시값 사이에서 판정이
// 어긋난다(부록 B.9.1 주석). 반올림은 표시 시점에만, 소수 4자리(PL-8과 같은 태도).
//
//  - ① 비율 표: RL-3~RL-9 × 연차 열 + 과제(합계) 열. 규칙이 꺼져 있어도, 행이 없어도 값은 적는다(PL-14 —
//    모르는 값을 0으로 취급해 빨간 경고를 띄우는 것이 더 나쁘다). `indirect_max` 행이 없으면 분모는
//    기본값(과기부 공통)이고 그 사실을 적는다
//  - ② findings: 서버가 이미 severity 순으로 정렬해 준다. 연차·행 항목은 클릭하면 부모가 그 열/셀로 옮긴다
//  - ③ skipped: 접힌 목록. 조용히 빼지 않는다(절대 규칙 5)
//  - ④ 규칙 행이 0건이면 안내 + [연구비 규칙] 자리. 버튼 연결(§7.9.5 모달)은 부모의 몫이다
//
// 전부 경고다(RL-1). 이 패널은 저장·반영·내보내기를 막는 값을 만들지 않는다.
//
// 인쇄(§12 P-R1~P-R5): 비율 표는 매트릭스와 함께 종이에 나간다. 클릭 안내·버튼만 print:hidden이고
// 숫자와 '초과'·'근사' 글자는 남는다 — 색이 흑백에서 사라져도 글자로 읽힌다.

import type { BudgetCategory, BudgetRule, RuleCode, RuleSeverity } from '@/types';
import { INDIRECT_BASE_LABELS } from '@/lib/constants';
import {
  DEFAULT_INDIRECT_BASE,
  RATIO_CODES,
  RULE_SPECS,
  type RatioCode,
  type RuleEvaluation,
  type RuleFinding,
  type YearRatio,
} from '@/lib/rules';
import Badge, { type BadgeTone } from '@/components/ui/Badge';
import Button from '@/components/ui/Button';
import { PRINT_TABLE, PRINT_TABLE_WRAP, PRINT_TD, PRINT_TH } from '@/components/print/tokens';

export interface RuleFindingsPanelProps {
  /** 매트릭스와 같은 열 순서 (matrix.columns) — 위아래 표의 연차가 어긋나면 읽을 수 없다 */
  columns: readonly { yearId: string; name: string }[];
  /** §5.18 과제 규칙 행. 0건이면 ④ 안내를 띄운다. 한도·켜짐·분모 표기의 원본이다 */
  rules: readonly BudgetRule[];
  /** §6.14.6 판정 결과 — 위 rules를 같은 조회의 집계에 적용한 것 */
  evaluation: RuleEvaluation;
  /** 부모(BudgetScreen)가 강조 중인 연차 열. 이 표의 열 머리에도 같은 강조를 건다 */
  highlightedYearId: string | null;
  /** 연차 단위 항목 클릭 → 부모가 매트릭스 연차 열을 강조한다. 같은 연차를 다시 누르면 부모가 해제한다 */
  onSelectYear: (yearId: string) => void;
  /**
   * 행 단위 항목 클릭 → 부모가 해당 셀의 산출근거 패널을 열고 그 행을 강조한다.
   * 셀 좌표(연차·비목)는 판정기가 scope에 실어 준 것을 그대로 넘긴다(§6.14.6) — 화면이 코드에서 비목을
   * 추측하지 않는다
   */
  onSelectDetail: (target: { code: RuleCode; yearId: string; detailId: string; category: BudgetCategory }) => void;
  /** §7.9.5 규칙 편집 패널 열기. 아직 연결되지 않았으면(undefined) 버튼을 비활성으로 둔다 — 자리는 남긴다 */
  onOpenRules?: () => void;
}

// ─── 표시 규약 ─────────────────────────────────────────────────

// RL-3~RL-9 표 순서. RATIO_CODES는 판정기의 나열 순서라 §6.14.2 표의 번호 순으로 다시 세운다.
// Record<RatioCode, …>라 비율 코드가 늘면 여기서 컴파일이 깨진다 — 표에서 조용히 빠지지 않는다
const RATIO_ROW_RANK: Record<RatioCode, number> = {
  indirect_max: 0,
  allowance_max: 1,
  allowance_min: 2,
  consignment_max: 3,
  external_tech_max: 4,
  gov_share_max: 5,
  own_cash_min: 6,
};
const RATIO_ROW_ORDER: readonly RatioCode[] = [...RATIO_CODES].sort(
  (a, b) => RATIO_ROW_RANK[a] - RATIO_ROW_RANK[b]
);

// 부록 A.3·E.4: error → red, warn → orange(Badge의 'amber' 톤이 orange-50/700이다), info → blue
const SEVERITY_TONE: Record<RuleSeverity, BadgeTone> = { error: 'red', warn: 'amber', info: 'blue' };
const SEVERITY_LABEL: Record<RuleSeverity, string> = { error: '위반', warn: '주의', info: '권고' };

/** 부록 B.9.1: 표시는 소수 4자리. +0은 -0이 '-0.0000%'로 보이는 것을 막는다 */
function formatRatio(value: number | null): string {
  if (value === null) return '—';
  return `${(Math.round(value * 10_000) / 10_000 + 0).toFixed(4)}%`;
}

/**
 * 메시지 끝의 출처(조문)를 떼어 낸다. lib/rules.ts withSource()가 ` (출처)`를 붙이므로 **끝에서 짝이 맞는
 * 마지막 괄호 묶음**이 출처다. 출처 자체에 괄호가 있을 수 있어(부록 D "(근사, RL-7)") 정규식 대신 짝을 센다.
 * 형식이 다르면(출처 없는 메시지) 본문만 돌려준다 — 잘라내지 않는다
 */
function splitSource(message: string): { body: string; source: string | null } {
  if (!message.endsWith(')')) return { body: message, source: null };
  let depth = 0;
  for (let i = message.length - 1; i >= 0; i -= 1) {
    const ch = message[i];
    if (ch === ')') depth += 1;
    else if (ch === '(') {
      depth -= 1;
      if (depth === 0) {
        // 여는 괄호 앞에 공백이 있어야 withSource()의 모양이다
        if (i === 0 || message[i - 1] !== ' ') return { body: message, source: null };
        return { body: message.slice(0, i - 1), source: message.slice(i + 1, -1) };
      }
    }
  }
  return { body: message, source: null };
}

/** finding의 (code, scope) 키. 비율 표 셀이 "이 셀에 위반이 있는가"를 찾는 데 쓴다 */
function findingKey(code: RuleCode, yearId: string | null): string {
  return `${code}|${yearId ?? 'project'}`;
}

function scopeYearId(finding: RuleFinding): string | null {
  return finding.scope.kind === 'project' ? null : finding.scope.yearId;
}

// ─── ① 비율 표 ─────────────────────────────────────────────────

interface RatioCellProps {
  ratio: YearRatio | undefined;
  /** 이 (code, scope)에 finding이 있는가. 있으면 상한은 red, 하한은 blue(info) */
  finding: RuleFinding | undefined;
  kind: 'ratio_max' | 'ratio_min';
  /** 과제 단위 규칙(RL-8·RL-9)의 연차 셀 — 값이 없는 것이 정상이라 '—'가 아니라 이유를 적는다 */
  projectOnly: boolean;
}

function RatioCell({ ratio, finding, kind, projectOnly }: RatioCellProps) {
  if (ratio === undefined) {
    return (
      <span
        className="block text-grey-400 print:text-black"
        title={projectOnly ? '과제 단위 규칙입니다 — 값은 과제 열에 있습니다 (RL-2)' : '이 연차의 비율이 조회 결과에 없습니다.'}
      >
        {projectOnly ? '과제 단위' : '값 없음'}
      </span>
    );
  }
  if (ratio.actual === null) {
    return (
      <span className="block text-grey-400 print:text-black" title="분모가 0이라 비율을 내지 않습니다. 아래 '판정 못 함'에 사유가 있습니다.">
        —
      </span>
    );
  }
  const flagged = finding !== undefined;
  const tone = !flagged
    ? 'text-grey-800'
    : kind === 'ratio_max'
      ? 'text-red-600'
      : 'text-blue-600';
  const title = `계산값 ${ratio.actual}% (분자 ${ratio.numerator.toLocaleString('ko-KR')} / 분모 ${ratio.denominator.toLocaleString('ko-KR')})${
    ratio.enabled ? '' : ' · 규칙이 없거나 꺼져 있어 판정하지 않았습니다'
  }`;
  return (
    <span className="block">
      <span className={`block font-semibold tabular-nums ${tone} print:text-black`} title={title}>
        {formatRatio(ratio.actual)}
      </span>
      {flagged && (
        // P-R5: 흑백 출력에서도 읽히도록 판정을 글자로 남긴다
        <span className={`block text-[11px] ${kind === 'ratio_max' ? 'text-red-600' : 'text-blue-600'} print:text-black`}>
          {kind === 'ratio_max' ? '상한 초과' : '하한 미달'}
        </span>
      )}
    </span>
  );
}

interface RatioTableProps {
  columns: RuleFindingsPanelProps['columns'];
  rulesByCode: Map<RuleCode, BudgetRule>;
  evaluation: RuleEvaluation;
  findingsByKey: Map<string, RuleFinding>;
  highlightedYearId: string | null;
}

function RatioTable({ columns, rulesByCode, evaluation, findingsByKey, highlightedYearId }: RatioTableProps) {
  return (
    <div className={`overflow-x-auto rounded-xl border border-hairline bg-surface ${PRINT_TABLE_WRAP}`}>
      <table className={`w-full text-left text-t7 ${PRINT_TABLE}`}>
        <caption className="px-4 pt-3 text-left text-t5 font-semibold text-grey-900 print:text-black">
          비율 규칙 (RL-3~RL-9)
          <span className="ml-2 text-t7 font-normal text-grey-500 print:text-black">
            규칙이 꺼져 있어도 비율은 표시합니다. 판정은 연차 단위, 과제 열은 전 연차 합계입니다 (RL-2)
          </span>
        </caption>
        <thead className="text-grey-500 print:text-black">
          <tr className="border-b border-hairline">
            <th scope="col" className={`px-4 py-2 font-medium ${PRINT_TH}`}>
              규칙
            </th>
            <th scope="col" className={`px-3 py-2 font-medium ${PRINT_TH}`}>
              한도
            </th>
            {columns.map((column) => (
              <th
                key={column.yearId}
                scope="col"
                className={`px-3 py-2 text-right font-medium text-grey-700 print:bg-transparent print:text-black ${PRINT_TH} ${
                  column.yearId === highlightedYearId ? 'bg-blue-50' : ''
                }`}
              >
                {column.name}
              </th>
            ))}
            <th scope="col" className={`px-3 py-2 text-right font-medium text-grey-700 print:text-black ${PRINT_TH}`}>
              과제
            </th>
          </tr>
        </thead>
        <tbody className="divide-y divide-hairline">
          {RATIO_ROW_ORDER.map((code) => {
            const spec = RULE_SPECS[code];
            const rule = rulesByCode.get(code);
            const kind = spec.kind === 'ratio_min' ? 'ratio_min' : 'ratio_max';
            const projectOnly = spec.scope === 'project';
            const byYear = new Map<string | null, YearRatio>();
            for (const ratio of evaluation.ratios[code] ?? []) byYear.set(ratio.yearId, ratio);
            // 분모 표기: indirect_max만 base를 고른다(RL-3). 행이 없으면 기본 분모(과기부 공통)
            const baseLabel =
              code === 'indirect_max'
                ? rule?.base
                  ? INDIRECT_BASE_LABELS[rule.base]
                  : `기본 분모(과기부 공통) — ${INDIRECT_BASE_LABELS[DEFAULT_INDIRECT_BASE]}`
                : null;

            return (
              <tr key={code} className="align-top">
                <th scope="row" className={`px-4 py-2 text-left font-medium text-grey-800 print:text-black ${PRINT_TD}`}>
                  <span className="flex flex-wrap items-center gap-1.5">
                    {spec.label}
                    {spec.approximate && (
                      <Badge tone="neutral" title="세목 대응이나 가정이 들어간 근사 판정입니다 (§6.14.2)">
                        근사
                      </Badge>
                    )}
                  </span>
                  <span className="mt-0.5 block text-[11px] font-normal text-grey-500 print:text-black">
                    {spec.ruleRef}
                    {baseLabel && ` · 분모: ${baseLabel}`}
                  </span>
                </th>
                <td className={`px-3 py-2 whitespace-nowrap ${PRINT_TD}`}>
                  {rule === undefined ? (
                    <span className="text-grey-400 print:text-black" title="이 코드의 규칙 행이 없습니다. 비율만 표시하고 판정하지 않습니다 (PL-14)">
                      규칙 없음
                    </span>
                  ) : (
                    <span className="block">
                      <span className="tabular-nums text-grey-800 print:text-black">
                        {rule.value === null ? '값 없음' : `${kind === 'ratio_max' ? '≤' : '≥'} ${rule.value}%`}
                      </span>
                      <span className="mt-0.5 block">
                        {rule.enabled ? (
                          <Badge tone={SEVERITY_TONE[rule.severity]} title={rule.source}>
                            {SEVERITY_LABEL[rule.severity]} 검사
                          </Badge>
                        ) : (
                          <Badge tone="neutral" title={rule.note === '' ? '규칙이 꺼져 있어 판정하지 않습니다' : `꺼짐 — ${rule.note}`}>
                            꺼짐
                          </Badge>
                        )}
                      </span>
                    </span>
                  )}
                </td>
                {columns.map((column) => (
                  <td
                    key={column.yearId}
                    className={`px-3 py-2 text-right print:bg-transparent ${PRINT_TD} ${
                      column.yearId === highlightedYearId ? 'bg-blue-50' : ''
                    }`}
                  >
                    <RatioCell
                      ratio={byYear.get(column.yearId)}
                      finding={findingsByKey.get(findingKey(code, column.yearId))}
                      kind={kind}
                      projectOnly={projectOnly}
                    />
                  </td>
                ))}
                <td className={`px-3 py-2 text-right ${PRINT_TD}`}>
                  <RatioCell
                    ratio={byYear.get(null)}
                    finding={findingsByKey.get(findingKey(code, null))}
                    kind={kind}
                    projectOnly={false}
                  />
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

// ─── ② findings 목록 ────────────────────────────────────────────

interface FindingItemProps {
  finding: RuleFinding;
  yearName: string | null;
  active: boolean;
  onSelectYear: RuleFindingsPanelProps['onSelectYear'];
  onSelectDetail: RuleFindingsPanelProps['onSelectDetail'];
}

function FindingItem({ finding, yearName, active, onSelectYear, onSelectDetail }: FindingItemProps) {
  const spec = RULE_SPECS[finding.code];
  const { body, source } = splitSource(finding.message);
  const { scope } = finding;

  // 연차 단위는 열 강조, 행 단위는 셀 패널 + 행 강조. 과제 단위는 옮겨 갈 자리가 없다
  const onClick =
    scope.kind === 'year'
      ? () => onSelectYear(scope.yearId)
      : scope.kind === 'detail'
        ? () => onSelectDetail({ code: finding.code, yearId: scope.yearId, detailId: scope.detailId, category: scope.category })
        : null;
  const clickHint =
    scope.kind === 'year'
      ? '클릭하면 매트릭스에서 이 연차 열을 강조합니다'
      : scope.kind === 'detail'
        ? '클릭하면 해당 셀의 산출근거 패널을 열고 그 행을 강조합니다'
        : undefined;

  const content = (
    <>
      <span className="flex flex-wrap items-center gap-1.5">
        <Badge tone={SEVERITY_TONE[finding.severity]}>{SEVERITY_LABEL[finding.severity]}</Badge>
        <span className="font-medium text-grey-800">{spec.label}</span>
        <span className="text-grey-500">{spec.ruleRef}</span>
        {finding.approximate && (
          <Badge tone="neutral" title="세목 대응이나 가정이 들어간 근사 판정입니다 (§6.14.2)">
            근사
          </Badge>
        )}
        <span className="text-grey-500">
          {scope.kind === 'project' ? '과제 단위' : yearName ?? '(연차 없음)'}
          {scope.kind === 'detail' && ' · 행'}
        </span>
      </span>
      <span className="mt-0.5 block text-grey-700">{body}</span>
      {source && <span className="mt-0.5 block text-[11px] text-grey-500">{source}</span>}
    </>
  );

  const shell = `block w-full rounded-lg px-3 py-2 text-left text-t7 ${active ? 'bg-blue-50' : ''}`;
  if (onClick === null) return <li className={shell}>{content}</li>;
  return (
    <li>
      <button
        type="button"
        onClick={onClick}
        title={clickHint}
        aria-pressed={active}
        className={`${shell} transition hover:bg-grey-50 ${active ? 'hover:bg-blue-50' : ''}`}
      >
        {content}
      </button>
    </li>
  );
}

// ─── 패널 ─────────────────────────────────────────────────────

export default function RuleFindingsPanel({
  columns,
  rules,
  evaluation,
  highlightedYearId,
  onSelectYear,
  onSelectDetail,
  onOpenRules,
}: RuleFindingsPanelProps) {
  const yearNames = new Map(columns.map((column) => [column.yearId, column.name]));
  // RL-D1이 (project, code) 유일을 보장한다. 판정기(firstRuleByCode)와 같은 규칙으로 첫 행을 쓴다
  const rulesByCode = new Map<RuleCode, BudgetRule>();
  for (const rule of rules) if (!rulesByCode.has(rule.code)) rulesByCode.set(rule.code, rule);
  const findingsByKey = new Map<string, RuleFinding>();
  for (const finding of evaluation.findings) {
    const key = findingKey(finding.code, scopeYearId(finding));
    if (!findingsByKey.has(key)) findingsByKey.set(key, finding);
  }

  const noRules = rules.length === 0;
  const { findings, skipped } = evaluation;

  return (
    <section aria-label="규칙 검증" className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2 print:hidden">
        <p className="text-t7 text-grey-500">
          전부 경고입니다 — 저장·반영·내보내기를 막지 않습니다 (RL-1). 비율은 서버가 원값으로 비교하고 여기서는
          소수 4자리로 적습니다.
        </p>
      </div>

      {/* ④ 규칙 행 0건. 비율 표는 그래도 아래에 나온다(규칙 없이도 값은 보여 준다) */}
      {noRules && (
        <div
          role="status"
          className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-hairline bg-surface px-5 py-4 print:hidden"
        >
          <div>
            <p className="text-t5 font-semibold text-grey-900">이 과제에 연구비 규칙이 없습니다</p>
            <p className="mt-0.5 text-t7 text-grey-600">
              규칙이 없으면 비율만 표시하고 위반 판정을 하지 않습니다. 부처·기관 유형 프리셋을 채우거나 직접
              입력하세요 (§7.9.5).
            </p>
          </div>
          <Button
            size="sm"
            variant="primary"
            disabled={onOpenRules === undefined}
            title={onOpenRules === undefined ? '규칙 편집 패널이 아직 연결되지 않았습니다' : '연구비 규칙 편집 패널을 엽니다'}
            onClick={onOpenRules}
          >
            연구비 규칙
          </Button>
        </div>
      )}

      {/* ① 비율 표 */}
      <RatioTable
        columns={columns}
        rulesByCode={rulesByCode}
        evaluation={evaluation}
        findingsByKey={findingsByKey}
        highlightedYearId={highlightedYearId}
      />

      {/* ② findings — 서버가 severity 순(error → warn → info)으로 정렬해 준다. 여기서 다시 정렬하지 않는다 */}
      <div className="rounded-xl border border-hairline bg-surface px-4 py-3">
        <p className="text-t5 font-semibold text-grey-900">
          판정 결과
          <span className="ml-2 text-t7 font-normal text-grey-500">
            {findings.length === 0 ? '위반·알림 없음' : `${findings.length}건`}
          </span>
        </p>
        {findings.length === 0 ? (
          <p className="mt-1 text-t7 text-grey-500">
            {noRules
              ? '규칙이 없어 판정하지 않았습니다.'
              : '켜져 있는 규칙을 전부 통과했습니다. 판정하지 못한 규칙이 있으면 아래에 남습니다.'}
          </p>
        ) : (
          <ul className="mt-2 divide-y divide-hairline">
            {findings.map((finding, index) => {
              const yearId = scopeYearId(finding);
              return (
                <FindingItem
                  // 같은 (code, scope) finding이 둘일 수 있다(RL-17 장비 행 여럿) — index로 구분한다
                  key={`${findingKey(finding.code, yearId)}|${finding.scope.kind === 'detail' ? finding.scope.detailId : ''}|${index}`}
                  finding={finding}
                  yearName={yearId === null ? null : yearNames.get(yearId) ?? null}
                  active={yearId !== null && yearId === highlightedYearId && finding.scope.kind === 'year'}
                  onSelectYear={onSelectYear}
                  onSelectDetail={onSelectDetail}
                />
              );
            })}
          </ul>
        )}
      </div>

      {/* ③ skipped — 접힌 목록. 조용히 빼지 않는다 */}
      {skipped.length > 0 && (
        <details className="rounded-xl border border-hairline bg-surface px-4 py-3">
          <summary className="cursor-pointer text-t7 font-semibold text-grey-700">
            판정 못 함 {skipped.length}건
            <span className="ml-2 font-normal text-grey-500">분모 0·필드 미입력 등으로 판정하지 못한 규칙입니다</span>
          </summary>
          <ul className="mt-2 divide-y divide-hairline">
            {skipped.map((item, index) => (
              <li key={`${item.code}|${item.yearId ?? 'project'}|${index}`} className="py-1.5 text-t7">
                <span className="font-medium text-grey-800">{RULE_SPECS[item.code].label}</span>
                <span className="ml-1.5 text-grey-500">{RULE_SPECS[item.code].ruleRef}</span>
                <span className="ml-1.5 text-grey-500">
                  · {item.yearId === null ? '과제 단위' : yearNames.get(item.yearId) ?? '(연차 없음)'}
                </span>
                <span className="mt-0.5 block text-grey-700">{item.reason}</span>
              </li>
            ))}
          </ul>
        </details>
      )}
    </section>
  );
}
