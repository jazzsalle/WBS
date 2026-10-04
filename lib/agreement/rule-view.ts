// 붙임4형 8-2 규칙 판정 줄 (SOT §6.19 AG-3 "8-2 규칙 판정 줄", §6.14.8, 계획서 Phase 26 S-15).
//
// 8-2 표의 비율은 표시만 한다. 그 아래에 **같은 `evaluateRules` 결과**(판정 대상 = 이 버전)에서 RL-4(연구수당 ÷
// 수정인건비 = 양식 I/E2)와 RL-3(간접비 ÷ 수정직접비)을 연차별 판정 줄로 옮긴다. 여기서 비율을 다시 계산하거나
// 한도와 비교하지 않는다 — 결과의 ratios·findings·skipped를 읽기만 한다(규칙 패널과 결론이 갈리지 않게).
//
// 표의 간접비 비율은 양식 분모(AG-3)라 RL-3 분모(`modifiedDirectCost(base)`)와 다를 수 있다 — 그래서 RL-3 줄에는
// 분모 `base` 라벨을 함께 싣고 차이 안내 문구를 붙인다.
// 단위 테스트: tests/unit/agreement-rules.test.ts

import { INDIRECT_BASE_LABELS } from '@/lib/constants';
import { DEFAULT_INDIRECT_BASE, RULE_SPECS, type RuleEvaluation, type RuleInput } from '@/lib/rules';
import type { IndirectBase, RuleSeverity } from '@/types';

export type Form82RuleCode = 'allowance_max' | 'indirect_max';

/** 8-2 아래 줄 순서 — 표의 I/E2(연구수당)가 간접비 비율보다 위에 있다 */
export const FORM82_RULE_CODES: readonly Form82RuleCode[] = ['allowance_max', 'indirect_max'];

export const FORM82_RULE_TEXT = {
  allowanceLabel: 'RL-4 연구수당 ÷ 수정인건비 (= 양식 I/E2)',
  indirectLabel: 'RL-3 간접비 ÷ 수정직접비',
  indirectBaseNote: '표의 간접비 비율은 양식 분모라 RL-3과 다를 수 있습니다',
  pass: '통과',
  fail: '경고',
  skipped: '판정하지 않음',
} as const;

export type Form82RuleCell =
  | { status: 'pass'; label: string; actual: number; limit: number }
  | { status: 'fail'; label: string; actual: number; limit: number; severity: RuleSeverity; message: string }
  | { status: 'skipped'; label: string; reason: string };

export interface Form82RuleLine {
  code: Form82RuleCode;
  ruleRef: string;
  label: string;
  /** RL-3만 — 분모 정의 이름(`INDIRECT_BASE_LABELS`). RL-4는 null(분모 = PL-11 수정인건비) */
  baseLabel: string | null;
  /** 연차별 판정. 입력 `yearIds` 순 */
  years: { yearId: string; cell: Form82RuleCell }[];
  /** 전 연차 합계 비율(RL-2 참고값 — 판정하지 않는다). 분모 0이면 null */
  totalActual: number | null;
}

export interface Form82RuleView {
  lines: Form82RuleLine[];
  /** "표의 간접비 비율은 양식 분모라 RL-3과 다를 수 있습니다" */
  note: string;
}

function ruleState(rules: readonly RuleInput[], code: Form82RuleCode): string | null {
  // 판정기처럼 첫 행(RL-D1). 판정하지 않은 이유만 고른다 — 판정 자체는 evaluation이 이미 했다
  const rule = rules.find((r) => r.code === code);
  const ref = RULE_SPECS[code].ruleRef;
  if (rule === undefined) return `${ref} 규칙 행이 없습니다`;
  if (!rule.enabled) return `${ref} 규칙이 꺼져 있습니다`;
  if (rule.value === null) return `${ref} 한도 값이 없습니다`;
  return null;
}

/**
 * 판정 결과 → 8-2 판정 줄. `evaluation`·`rules`는 같은 버전·같은 규칙 행으로 낸 것이어야 한다.
 * @param yearIds 8-2 연차 열 순서(줄이 없는 연차도 판정 연차라면 넣는다)
 */
export function buildForm82RuleView(
  evaluation: RuleEvaluation,
  rules: readonly RuleInput[],
  yearIds: readonly string[]
): Form82RuleView {
  const indirectBase: IndirectBase = rules.find((r) => r.code === 'indirect_max')?.base ?? DEFAULT_INDIRECT_BASE;

  const lines = FORM82_RULE_CODES.map((code): Form82RuleLine => {
    const ratios = evaluation.ratios[code];
    const off = ruleState(rules, code);
    const years = yearIds.map((yearId) => {
      const entry = ratios.find((r) => r.yearId === yearId);
      // ratios는 판정기가 입력 연차마다 싣는다 — 없으면 다른 입력으로 낸 결과를 넘긴 것이다
      if (entry === undefined) throw new Error(`판정 결과에 연차 ${yearId}의 ${RULE_SPECS[code].ruleRef} 비율이 없습니다.`);
      if (off !== null) return { yearId, cell: { status: 'skipped', label: FORM82_RULE_TEXT.skipped, reason: off } as const };
      const skip = evaluation.skipped.find((s) => s.code === code && s.yearId === yearId);
      if (skip !== undefined) return { yearId, cell: { status: 'skipped', label: FORM82_RULE_TEXT.skipped, reason: skip.reason } as const };
      const finding = evaluation.findings.find((f) => f.code === code && f.scope.kind === 'year' && f.scope.yearId === yearId);
      if (finding !== undefined) {
        return {
          yearId,
          cell: {
            status: 'fail', label: FORM82_RULE_TEXT.fail, actual: finding.actual!, limit: finding.limit!,
            severity: finding.severity, message: finding.message,
          } as const,
        };
      }
      // 켜져 있고 skipped·finding이 없으면 판정기가 통과로 본 것이다 — actual·limit은 ratios의 원값
      return { yearId, cell: { status: 'pass', label: FORM82_RULE_TEXT.pass, actual: entry.actual!, limit: entry.limit! } as const };
    });
    return {
      code,
      ruleRef: RULE_SPECS[code].ruleRef,
      label: code === 'allowance_max' ? FORM82_RULE_TEXT.allowanceLabel : FORM82_RULE_TEXT.indirectLabel,
      baseLabel: code === 'indirect_max' ? INDIRECT_BASE_LABELS[indirectBase] : null,
      years,
      totalActual: ratios.find((r) => r.yearId === null)?.actual ?? null,
    };
  });

  return { lines, note: FORM82_RULE_TEXT.indirectBaseNote };
}
