// 연구비 사용 규칙 판정기 (SOT §6.14 RL-1~RL-19, §6.14.6, §6.14.7, 부록 B.9).
// 부수효과 없는 순수 함수다 — DB·네트워크·현재 시각을 쓰지 않는다.
//
// **전부 경고다**(RL-1). 이 파일은 저장·반영·내보내기를 막는 값을 만들지 않는다. severity는 색과
// 정렬 순서만 정한다.
//
// 금액 합계·E1·수정직접비의 재료는 lib/budget-plan.ts의 집계 결과를 **받아서** 쓴다 — 산식을 다시
// 구현하지 않는다(§6.14.7, PL-10a와 같은 이유). 그래서 여기에는 연봉·단가 곱셈이 없고, 행 금액은
// 입력(`amount`)으로 들어온다.
//
// 규칙의 *의미*(무엇을 무엇으로 나누는가)는 RULE_SPECS와 이 파일의 판정 코드가 갖고, *값*(비율·금액·
// 켜짐·출처)은 과제별 규칙 행(§5.18)이 갖는다. 프리셋(lib/rules-presets.ts)은 그 행을 만드는 기본값일 뿐이다.
//
// 비율은 중간 반올림 없이 원값으로 비교한다(부록 B.9.1 주석 — 69.2308을 69.23으로 자른 뒤 비교하면
// 경계에서 판정이 뒤집힌다). 표시 반올림은 화면의 몫이다.
// 단위 테스트: tests/unit/rules.test.ts · 경계: tests/unit/rules-boundary.test.ts

import {
  DIRECT_CATEGORIES,
  modifiedDirectCost,
  modifiedPersonnel,
  personnelParticipation,
  type YearCategoryTotals,
} from './budget-plan';
import type {
  BudgetCategory,
  BudgetDetail,
  BudgetRule,
  IndirectBase,
  Member,
  RuleCode,
  RuleSeverity,
} from '@/types';

// 정의는 budget-plan.ts 한 곳이다(순환 import 회피). §6.14.7이 여기서도 찾을 수 있게 다시 내보낸다
export { modifiedDirectCost } from './budget-plan';

// ─── 상수 ────────────────────────────────────────────────────

/**
 * `indirect_max` 규칙 행이 없을 때의 수정직접비 정의. 비율은 규칙이 꺼져 있어도 보여 줘야 하므로
 * (§6.14.6) 분모를 하나 골라야 한다 — 과기부고시가 공통 기준이라 그쪽이다.
 */
export const DEFAULT_INDIRECT_BASE: IndirectBase = 'direct_cash_excl_intl_consign_burden';

export type RuleKind = 'ratio_max' | 'ratio_min' | 'flag' | 'threshold' | 'personnel';
export type RuleScopeKind = 'year' | 'project' | 'detail';

export interface RuleSpec {
  kind: RuleKind;
  /** RL-D2: value가 있어야 판정할 수 있는 코드인가 */
  needsValue: boolean;
  valueUnit: 'percent' | 'won' | null;
  /** finding의 scope 종류 (§6.14.6) */
  scope: RuleScopeKind;
  label: string;
  /** RL-7·RL-9처럼 가정이 들어간 판정. 화면이 "근사"라고 적는다 */
  approximate: boolean;
  /** §6.14의 규칙 번호 */
  ruleRef: string;
}

/** 코드의 의미. 부록 D 프리셋과 화면이 참조한다 */
export const RULE_SPECS: Record<RuleCode, RuleSpec> = {
  allowance_max: { kind: 'ratio_max', needsValue: true, valueUnit: 'percent', scope: 'year', label: '연구수당 상한 (÷ 수정인건비)', approximate: false, ruleRef: 'RL-4' },
  allowance_min: { kind: 'ratio_min', needsValue: true, valueUnit: 'percent', scope: 'year', label: '연구수당 권고 하한 (÷ 수정인건비)', approximate: false, ruleRef: 'RL-5' },
  indirect_max: { kind: 'ratio_max', needsValue: true, valueUnit: 'percent', scope: 'year', label: '간접비 상한 (÷ 수정직접비)', approximate: false, ruleRef: 'RL-3' },
  consignment_max: { kind: 'ratio_max', needsValue: true, valueUnit: 'percent', scope: 'year', label: '위탁연구개발비 상한 (÷ 직접비 − 위탁·국제공동·부담비)', approximate: false, ruleRef: 'RL-6' },
  external_tech_max: { kind: 'ratio_max', needsValue: true, valueUnit: 'percent', scope: 'year', label: '외부 전문기술 활용비 상한 (÷ 직접비)', approximate: true, ruleRef: 'RL-7' },
  gov_share_max: { kind: 'ratio_max', needsValue: true, valueUnit: 'percent', scope: 'project', label: '정부지원 비율 상한 (÷ 총액 − 국제공동)', approximate: false, ruleRef: 'RL-8' },
  own_cash_min: { kind: 'ratio_min', needsValue: true, valueUnit: 'percent', scope: 'project', label: '기관부담 현금 비율 하한 (÷ 기관부담연구개발비)', approximate: true, ruleRef: 'RL-9' },
  indirect_cash_only: { kind: 'flag', needsValue: false, valueUnit: null, scope: 'year', label: '간접비 현물 계상 금지', approximate: false, ruleRef: 'RL-10' },
  no_personnel_support: { kind: 'flag', needsValue: false, valueUnit: null, scope: 'year', label: '연구지원인력인건비(직접비) 계상 금지', approximate: false, ruleRef: 'RL-11' },
  no_student_personnel: { kind: 'flag', needsValue: false, valueUnit: null, scope: 'year', label: '학생인건비 계상 금지', approximate: false, ruleRef: 'RL-12' },
  no_burden: { kind: 'flag', needsValue: false, valueUnit: null, scope: 'year', label: '연구개발부담비 계상 금지', approximate: false, ruleRef: 'RL-13' },
  existing_personnel_cash: { kind: 'personnel', needsValue: false, valueUnit: null, scope: 'detail', label: '기존인력 인건비 현금 계상', approximate: false, ruleRef: 'RL-14' },
  existing_cash_le_new: { kind: 'personnel', needsValue: false, valueUnit: null, scope: 'year', label: '기존인력 현금 인건비 ≤ 신규채용 인건비', approximate: false, ruleRef: 'RL-15' },
  min_participation: { kind: 'personnel', needsValue: true, valueUnit: 'percent', scope: 'detail', label: '참여연구자 최소 참여율', approximate: false, ruleRef: 'RL-16' },
  equipment_review_threshold: { kind: 'threshold', needsValue: true, valueUnit: 'won', scope: 'detail', label: '장비 도입 심의 대상 금액', approximate: false, ruleRef: 'RL-17' },
  material_notice_threshold: { kind: 'threshold', needsValue: true, valueUnit: 'won', scope: 'detail', label: '재료 구입 필요성·수량 명시 금액', approximate: false, ruleRef: 'RL-18' },
  outsourcing_notice_threshold: { kind: 'threshold', needsValue: true, valueUnit: 'won', scope: 'detail', label: '외주 용역 내역·금액 명시 금액', approximate: false, ruleRef: 'RL-19' },
};

/** 비율 규칙 7종 (RL-3~RL-9). 규칙이 없거나 꺼져 있어도 `ratios`에 실린다 */
export const RATIO_CODES = [
  'allowance_max',
  'allowance_min',
  'indirect_max',
  'consignment_max',
  'external_tech_max',
  'gov_share_max',
  'own_cash_min',
] as const satisfies readonly RuleCode[];

export type RatioCode = (typeof RATIO_CODES)[number];

// RL-7: 외부 전문기술 활용비의 근사 — 전문가활용비 + 외주용역비(연구개발서비스) 세목. 기술도입비 세목이 없다
const EXTERNAL_TECH_SUBCATEGORIES: readonly string[] = ['activity_expert', 'activity_outsourcing'];

const EQUIPMENT_SUBCATEGORY = 'facility_purchase';
const MATERIAL_SUBCATEGORY = 'material_purchase';
const OUTSOURCING_SUBCATEGORY = 'activity_outsourcing';

// RL-6 분모 = 직접비 합계(현금+현물) − 이 세 비목
const CONSIGNMENT_DENOMINATOR_EXCLUDED: readonly BudgetCategory[] = ['consignment', 'international', 'burden'];

const SEVERITY_ORDER: Record<RuleSeverity, number> = { error: 0, warn: 1, info: 2 };

// ─── 입력 ────────────────────────────────────────────────────

/** 판정에 쓰는 규칙 행. BudgetRule 전체를 넣어도 되고 PresetRow(프리셋 → 행 변환 결과)를 넣어도 된다 */
export type RuleInput = Pick<BudgetRule, 'code' | 'enabled' | 'value' | 'base' | 'severity' | 'source'>;

/** 산출 행. `amount`는 PL-D7 계산값을 호출부가 넘긴다 — 여기서 다시 계산하지 않는다 */
export type RuleDetailInput = Pick<
  BudgetDetail,
  'id' | 'category' | 'subcategory' | 'axis' | 'formula' | 'memberId' | 'name' | 'factors'
>;

export interface RuleRowInput {
  detail: RuleDetailInput;
  amount: number;
  /** 인건비 행의 인력. hireType이 RL-14·RL-15의 판정 재료다. 없으면 인력 판정은 건너뛰고 skipped에 남긴다 */
  member?: Pick<Member, 'id' | 'hireType'> | null;
}

export interface RuleYearInput {
  yearId: string;
  /** lib/budget-plan.ts buildYearTotals() 결과 (비목 합계 + personnelSupportTotal) */
  totals: YearCategoryTotals;
  rows: readonly RuleRowInput[];
}

export interface RuleProjectInput {
  govBudget: number | null;
  ownBudget: number | null;
  totalBudget: number | null;
}

export interface RuleEvaluationInput {
  years: readonly RuleYearInput[];
  project: RuleProjectInput;
}

// ─── 출력 (§6.14.6) ──────────────────────────────────────────

export type RuleFindingScope =
  | { kind: 'project' }
  | { kind: 'year'; yearId: string }
  // category = 그 행의 비목. 화면이 코드에서 비목을 추측하지 않도록 판정기가 싣는다 (§6.14.6)
  | { kind: 'detail'; yearId: string; detailId: string; category: BudgetCategory };

export interface RuleFinding {
  code: RuleCode;
  severity: RuleSeverity;
  scope: RuleFindingScope;
  /** 실제 비율(%) 또는 금액. 원값 — 반올림하지 않는다 */
  actual: number | null;
  /** 규칙 value. 값을 쓰지 않는 코드는 null */
  limit: number | null;
  /** 사람이 읽는 한 문장 + 출처 */
  message: string;
  approximate: boolean;
}

/** 비율 규칙의 연차별 실제값. 통과해도 화면에 보여 준다 (§6.14.6) */
export interface YearRatio {
  /** null = 과제 단위(전 연차 합계 또는 RL-8·RL-9) */
  yearId: string | null;
  /** 분모 0이면 null. 원값 */
  actual: number | null;
  /** 규칙 value. 행이 없으면 null */
  limit: number | null;
  /** 규칙 행이 있고 켜져 있는가. false면 판정하지 않았다는 뜻이지 0이 아니다(PL-14) */
  enabled: boolean;
  numerator: number;
  denominator: number;
}

export interface RuleSkipped {
  code: RuleCode;
  reason: string;
  /** 어느 연차에서 판정하지 못했는가. 과제 단위 규칙은 null */
  yearId: string | null;
}

export interface RuleEvaluation {
  /** 위반·알림만. 통과한 규칙은 넣지 않는다. severity 순(error > warn > info), 같은 등급 안에서는 입력 순 */
  findings: RuleFinding[];
  /** 비율 규칙 7종 전부 — 규칙이 없어도, 꺼져 있어도 계산해 싣는다 */
  ratios: Record<RatioCode, YearRatio[]>;
  /** 분모 0·필드 null 등으로 판정하지 못한 규칙. 조용히 빼지 않는다 */
  skipped: RuleSkipped[];
}

// ─── 보조 ────────────────────────────────────────────────────

function planned(totals: YearCategoryTotals, category: BudgetCategory): number {
  return totals.byCategory[category]?.plannedAmount ?? 0;
}

function inKind(totals: YearCategoryTotals, category: BudgetCategory): number {
  return totals.byCategory[category]?.inKindAmount ?? 0;
}

function sumPlanned(totals: YearCategoryTotals, categories: readonly BudgetCategory[]): number {
  let sum = 0;
  for (const category of categories) sum += planned(totals, category);
  return sum;
}

function ratio(numerator: number, denominator: number): number | null {
  return denominator === 0 ? null : (numerator / denominator) * 100;
}

// 표시용 — 비교에는 절대 쓰지 않는다. 메시지 한 문장 안의 숫자만 여기서 자른다
function fmtPercent(value: number): string {
  return `${Math.round(value * 10_000) / 10_000}%`;
}

// Intl에 기대지 않는다 — 테스트·서버·Tauri 웹뷰에서 같은 문자열이어야 한다
function fmtWon(value: number): string {
  const sign = value < 0 ? '-' : '';
  const digits = Math.abs(Math.trunc(value)).toString();
  return `${sign}${digits.replace(/\B(?=(\d{3})+(?!\d))/g, ',')}원`;
}

function withSource(sentence: string, rule: RuleInput): string {
  return `${sentence} (${rule.source})`;
}

function firstRuleByCode(rules: readonly RuleInput[]): Map<RuleCode, RuleInput> {
  // RL-D1이 (project, code) 유일을 보장한다. 혹시 둘이면 첫 행 — 두 번째를 조용히 우선하지 않는다
  const map = new Map<RuleCode, RuleInput>();
  for (const rule of rules) if (!map.has(rule.code)) map.set(rule.code, rule);
  return map;
}

/** 켜져 있고 (값이 필요하면) 값이 있는 행만 판정 대상이다 (PL-14) */
function isActive(rule: RuleInput | undefined): rule is RuleInput {
  if (!rule || !rule.enabled) return false;
  return !RULE_SPECS[rule.code].needsValue || rule.value !== null;
}

// ─── 비율 (RL-3~RL-9) ────────────────────────────────────────

interface YearRatioParts {
  numerator: number;
  denominator: number;
  /** 분모가 0일 때 skipped에 적을 사유 */
  zeroReason: string;
}

/** 연차 단위 비율 5종의 분자·분모 (RL-3~RL-7). 과제 단위 합계는 이 값을 더해서 만든다 */
function yearRatioParts(code: Exclude<RatioCode, 'gov_share_max' | 'own_cash_min'>, year: RuleYearInput, base: IndirectBase): YearRatioParts {
  const { totals } = year;
  switch (code) {
    case 'allowance_max':
    case 'allowance_min':
      // RL-4·RL-5: 분모는 PL-11 E1 그대로
      return { numerator: planned(totals, 'allowance'), denominator: modifiedPersonnel(totals), zeroReason: '수정인건비가 0' };
    case 'indirect_max':
      // RL-3: 분자는 현금+현물, 분모는 base가 정한 수정직접비(현금)
      return { numerator: planned(totals, 'indirect'), denominator: modifiedDirectCost(totals, base), zeroReason: '수정직접비가 0' };
    case 'consignment_max':
      // RL-6: 고시가 현금/현물을 구분하지 않으므로 분모는 현금+현물
      return {
        numerator: planned(totals, 'consignment'),
        denominator: sumPlanned(totals, DIRECT_CATEGORIES) - sumPlanned(totals, CONSIGNMENT_DENOMINATOR_EXCLUDED),
        zeroReason: '직접비(위탁·국제공동·부담비 제외)가 0',
      };
    case 'external_tech_max': {
      // RL-7 근사: 세목 소계는 YearCategoryTotals에 없어 산출 행에서 더한다. 행이 없는 연차는 0이다
      let numerator = 0;
      for (const row of year.rows) {
        if (row.detail.category === 'activity' && EXTERNAL_TECH_SUBCATEGORIES.includes(row.detail.subcategory)) {
          numerator += row.amount;
        }
      }
      return { numerator, denominator: sumPlanned(totals, DIRECT_CATEGORIES), zeroReason: '직접비 합계가 0' };
    }
  }
}

function ratioMessage(code: RatioCode, actual: number, limit: number, rule: RuleInput): string {
  const shown = fmtPercent(actual);
  switch (code) {
    case 'allowance_max':
      return withSource(`연구수당이 수정인건비의 ${shown}로 상한 ${limit}%를 넘습니다`, rule);
    case 'allowance_min':
      return withSource(`연구수당이 수정인건비의 ${shown}로 권고 하한 ${limit}% 미만입니다`, rule);
    case 'indirect_max':
      return withSource(`간접비가 수정직접비의 ${shown}로 상한 ${limit}%를 넘습니다`, rule);
    case 'consignment_max':
      return withSource(`위탁연구개발비가 직접비(위탁·국제공동·부담비 제외)의 ${shown}로 상한 ${limit}%를 넘습니다`, rule);
    case 'external_tech_max':
      return withSource(`외부 전문기술 활용비(근사)가 직접비의 ${shown}로 상한 ${limit}%를 넘습니다`, rule);
    case 'gov_share_max':
      return withSource(`정부지원연구개발비가 총액(국제공동 제외)의 ${shown}로 상한 ${limit}%를 넘습니다`, rule);
    case 'own_cash_min':
      return withSource(`기관부담 현금이 기관부담연구개발비의 ${shown}로 하한 ${limit}% 미만입니다`, rule);
  }
}

function violates(kind: RuleKind, actual: number, limit: number): boolean {
  // 경계값은 위반이 아니다: "초과"·"미만"이 고시의 표현이다
  if (kind === 'ratio_max') return actual > limit;
  if (kind === 'ratio_min') return actual < limit;
  return false;
}

// ─── 판정기 ──────────────────────────────────────────────────

/**
 * 규칙 행 + 연차별 집계·산출 행 + 과제 총액 → 판정 결과 (§6.14.6).
 *
 * - 비율 7종은 규칙이 없거나 꺼져 있어도 `ratios`에 싣는다. 화면이 값을 보여 주고 "검사 안 함"을
 *   `enabled:false`로 표시한다(PL-14 — 모르는 값을 0으로 취급해 빨간 경고를 띄우는 것이 더 나쁘다).
 * - 연차 단위 비율은 전 연차 합계로 과제 단위 값(yearId null)도 하나 더 낸다(RL-2). 판정은 연차마다다.
 * - 판정하지 못한 규칙은 `skipped`에 사유와 함께 남긴다. 조용히 빼지 않는다.
 */
export function evaluateRules(rules: readonly RuleInput[], input: RuleEvaluationInput): RuleEvaluation {
  const byCode = firstRuleByCode(rules);
  const findings: RuleFinding[] = [];
  const skipped: RuleSkipped[] = [];
  const ratios = {} as Record<RatioCode, YearRatio[]>;

  const indirectRule = byCode.get('indirect_max');
  const indirectBase: IndirectBase = indirectRule?.base ?? DEFAULT_INDIRECT_BASE;

  // ── 연차 단위 비율 (RL-3~RL-7) ──
  for (const code of ['allowance_max', 'allowance_min', 'indirect_max', 'consignment_max', 'external_tech_max'] as const) {
    const rule = byCode.get(code);
    const active = isActive(rule);
    const limit = rule?.value ?? null;
    const enabled = rule?.enabled ?? false;
    const entries: YearRatio[] = [];
    let sumNumerator = 0;
    let sumDenominator = 0;

    for (const year of input.years) {
      const parts = yearRatioParts(code, year, indirectBase);
      const actual = ratio(parts.numerator, parts.denominator);
      entries.push({ yearId: year.yearId, actual, limit, enabled, numerator: parts.numerator, denominator: parts.denominator });
      sumNumerator += parts.numerator;
      sumDenominator += parts.denominator;

      if (!active) continue;
      if (actual === null) {
        skipped.push({ code, reason: parts.zeroReason, yearId: year.yearId });
        continue;
      }
      if (violates(RULE_SPECS[code].kind, actual, rule.value!)) {
        findings.push({
          code,
          severity: rule.severity,
          scope: { kind: 'year', yearId: year.yearId },
          actual,
          limit: rule.value,
          message: ratioMessage(code, actual, rule.value!, rule),
          approximate: RULE_SPECS[code].approximate,
        });
      }
    }

    // RL-2: 과제 단위 참고값. 판정은 하지 않는다 — 한 연차만 넘고 총합은 안 넘는 경우를 사용자가 본다
    entries.push({ yearId: null, actual: ratio(sumNumerator, sumDenominator), limit, enabled, numerator: sumNumerator, denominator: sumDenominator });
    ratios[code] = entries;
  }

  // ── 과제 단위 비율 (RL-8·RL-9) ──
  let internationalAll = 0;
  let inKindAll = 0;
  for (const year of input.years) {
    internationalAll += planned(year.totals, 'international');
    for (const amounts of Object.values(year.totals.byCategory)) inKindAll += amounts.inKindAmount;
  }
  const { govBudget, ownBudget, totalBudget } = input.project;

  {
    const code = 'gov_share_max';
    const rule = byCode.get(code);
    const numerator = govBudget ?? 0;
    const denominator = (totalBudget ?? 0) - internationalAll;
    const actual = govBudget === null || totalBudget === null ? null : ratio(numerator, denominator);
    ratios[code] = [{ yearId: null, actual, limit: rule?.value ?? null, enabled: rule?.enabled ?? false, numerator, denominator }];

    if (isActive(rule)) {
      if (govBudget === null) skipped.push({ code, reason: '정부지원연구개발비 미입력', yearId: null });
      else if (totalBudget === null) skipped.push({ code, reason: '총 연구개발비 미입력', yearId: null });
      else if (actual === null) skipped.push({ code, reason: '총 연구개발비(국제공동 제외)가 0', yearId: null });
      else if (violates('ratio_max', actual, rule.value!)) {
        findings.push({
          code, severity: rule.severity, scope: { kind: 'project' }, actual, limit: rule.value,
          message: ratioMessage(code, actual, rule.value!, rule), approximate: RULE_SPECS[code].approximate,
        });
      }
    }
  }

  {
    const code = 'own_cash_min';
    const rule = byCode.get(code);
    // RL-9 가정: 현물은 전액 기관부담이다 — 기관부담 현금 = ownBudget − 전 연차 현물 합
    const numerator = (ownBudget ?? 0) - inKindAll;
    const denominator = ownBudget ?? 0;
    const actual = ownBudget === null ? null : ratio(numerator, denominator);
    ratios[code] = [{ yearId: null, actual, limit: rule?.value ?? null, enabled: rule?.enabled ?? false, numerator, denominator }];

    if (isActive(rule)) {
      if (ownBudget === null) skipped.push({ code, reason: '기관부담연구개발비 미입력', yearId: null });
      else if (ownBudget === 0) skipped.push({ code, reason: '기관부담연구개발비가 0', yearId: null });
      else {
        if (inKindAll > ownBudget) {
          // 현물이 기관부담 총액을 넘는 것은 비율 이전의 문제다 — 별도 finding
          findings.push({
            code, severity: rule.severity, scope: { kind: 'project' }, actual: inKindAll, limit: ownBudget,
            message: withSource(`현물 합계 ${fmtWon(inKindAll)}이 기관부담연구개발비 ${fmtWon(ownBudget)}을 초과합니다`, rule),
            approximate: true,
          });
        }
        if (actual !== null && violates('ratio_min', actual, rule.value!)) {
          findings.push({
            code, severity: rule.severity, scope: { kind: 'project' }, actual, limit: rule.value,
            message: ratioMessage(code, actual, rule.value!, rule), approximate: RULE_SPECS[code].approximate,
          });
        }
      }
    }
  }

  // ── 계상 금지 · 현금/현물 (RL-10~RL-13) ──
  for (const year of input.years) {
    const { totals, yearId } = year;
    const scope: RuleFindingScope = { kind: 'year', yearId };

    const flags: { code: RuleCode; amount: number; sentence: string }[] = [
      { code: 'indirect_cash_only', amount: inKind(totals, 'indirect'), sentence: '간접비에 현물 {amount}이 있습니다 — 영리기관 간접비는 현금으로만 계상합니다' },
      { code: 'no_personnel_support', amount: totals.personnelSupportTotal, sentence: '연구지원인력인건비 {amount}이 직접비에 있습니다 — 영리기관은 간접비 인력지원비로 계상합니다' },
      { code: 'no_student_personnel', amount: planned(totals, 'student_personnel'), sentence: '학생인건비 {amount}이 있습니다 — 대학·출연연만 계상합니다' },
      { code: 'no_burden', amount: planned(totals, 'burden'), sentence: '연구개발부담비 {amount}이 있습니다 — 정부출연기관만 계상합니다' },
    ];
    for (const flag of flags) {
      const rule = byCode.get(flag.code);
      if (!isActive(rule) || flag.amount <= 0) continue;
      findings.push({
        code: flag.code, severity: rule.severity, scope, actual: flag.amount, limit: null,
        message: withSource(flag.sentence.replace('{amount}', fmtWon(flag.amount)), rule), approximate: false,
      });
    }
  }

  // ── 인력 (RL-14~RL-16) ──
  for (const year of input.years) {
    const { yearId } = year;
    const personnelRows = year.rows.filter((row) => row.detail.formula === 'personnel');
    const withoutMember = personnelRows.filter((row) => row.member == null).length;

    const cashRule = byCode.get('existing_personnel_cash');
    const balanceRule = byCode.get('existing_cash_le_new');
    const participationRule = byCode.get('min_participation');

    // 인력을 모르는 인건비 행(PL-D1 위반 또는 호출부 누락)은 판정할 수 없다 — 사유를 남긴다
    if (withoutMember > 0) {
      const reason = `인력 정보가 없는 인건비 행 ${withoutMember}건`;
      if (isActive(cashRule)) skipped.push({ code: 'existing_personnel_cash', reason, yearId });
      if (isActive(balanceRule)) skipped.push({ code: 'existing_cash_le_new', reason, yearId });
      if (isActive(participationRule)) skipped.push({ code: 'min_participation', reason, yearId });
    }

    let existingCash = 0;
    let newTotal = 0;
    for (const row of personnelRows) {
      if (row.member == null) continue;
      const isExistingCash = row.member.hireType === 'existing' && row.detail.axis === 'cash';
      if (isExistingCash) existingCash += row.amount;
      if (row.member.hireType === 'new') newTotal += row.amount;

      // RL-14: 행 단위
      if (isExistingCash && isActive(cashRule)) {
        findings.push({
          code: 'existing_personnel_cash', severity: cashRule.severity,
          scope: { kind: 'detail', yearId, detailId: row.detail.id, category: row.detail.category }, actual: row.amount, limit: null,
          message: withSource(`기존인력 인건비 ${fmtWon(row.amount)}이 현금으로 계상되어 있습니다 — 영리기관 기존인력은 현물이 원칙입니다`, cashRule),
          approximate: false,
        });
      }
    }

    // RL-15: 연차 단위. 신규 행이 0이면 기존 현금이 조금이라도 있을 때 위반이다
    if (isActive(balanceRule) && existingCash > newTotal) {
      findings.push({
        code: 'existing_cash_le_new', severity: balanceRule.severity, scope: { kind: 'year', yearId },
        actual: existingCash, limit: newTotal,
        message: withSource(`기존인력 현금 인건비 ${fmtWon(existingCash)}이 신규채용 인건비 ${fmtWon(newTotal)}을 넘습니다`, balanceRule),
        approximate: false,
      });
    }

    // RL-16: 같은 Member의 행을 합산. 학생인건비 제외
    if (isActive(participationRule)) {
      const byMember = new Map<string, { firstDetailId: string; firstCategory: BudgetCategory; participation: number }>();
      for (const row of personnelRows) {
        if (row.member == null || row.detail.category === 'student_personnel') continue;
        const entry = byMember.get(row.member.id);
        const participation = personnelParticipation(row.detail);
        if (entry) entry.participation += participation;
        else byMember.set(row.member.id, { firstDetailId: row.detail.id, firstCategory: row.detail.category, participation });
      }
      for (const entry of byMember.values()) {
        if (entry.participation >= participationRule.value!) continue;
        findings.push({
          code: 'min_participation', severity: participationRule.severity,
          scope: { kind: 'detail', yearId, detailId: entry.firstDetailId, category: entry.firstCategory },
          actual: entry.participation, limit: participationRule.value,
          message: withSource(`참여율 ${fmtPercent(entry.participation)}가 최소 ${participationRule.value}% 미만입니다`, participationRule),
          approximate: false,
        });
      }
    }
  }

  // ── 건별 금액 알림 (RL-17~RL-19) ──
  for (const year of input.years) {
    const { yearId } = year;

    const equipmentRule = byCode.get('equipment_review_threshold');
    if (isActive(equipmentRule)) {
      for (const row of year.rows) {
        if (row.detail.subcategory !== EQUIPMENT_SUBCATEGORY || row.amount < equipmentRule.value!) continue;
        findings.push({
          code: 'equipment_review_threshold', severity: equipmentRule.severity,
          scope: { kind: 'detail', yearId, detailId: row.detail.id, category: row.detail.category }, actual: row.amount, limit: equipmentRule.value,
          message: withSource(`장비 ${fmtWon(row.amount)}은 전문기관 도입 심의 대상입니다 (${fmtWon(equipmentRule.value!)} 이상)`, equipmentRule),
          approximate: false,
        });
      }
    }

    // RL-18: 고시가 "단일 물품의 연도 합계"라 같은 품명을 연차 안에서 합친다
    const materialRule = byCode.get('material_notice_threshold');
    if (isActive(materialRule)) {
      const byName = new Map<string, { firstDetailId: string; firstCategory: BudgetCategory; amount: number }>();
      for (const row of year.rows) {
        if (row.detail.subcategory !== MATERIAL_SUBCATEGORY) continue;
        const name = row.detail.name.trim();
        const entry = byName.get(name);
        if (entry) entry.amount += row.amount;
        else byName.set(name, { firstDetailId: row.detail.id, firstCategory: row.detail.category, amount: row.amount });
      }
      for (const [name, entry] of byName) {
        if (entry.amount < materialRule.value!) continue;
        findings.push({
          code: 'material_notice_threshold', severity: materialRule.severity,
          scope: { kind: 'detail', yearId, detailId: entry.firstDetailId, category: entry.firstCategory }, actual: entry.amount, limit: materialRule.value,
          message: withSource(`재료 '${name}' 연도 합계 ${fmtWon(entry.amount)}은 계획서에 구입 필요성·수량을 명시해야 합니다 (${fmtWon(materialRule.value!)} 이상)`, materialRule),
          approximate: false,
        });
      }
    }

    const outsourcingRule = byCode.get('outsourcing_notice_threshold');
    if (isActive(outsourcingRule)) {
      for (const row of year.rows) {
        if (row.detail.subcategory !== OUTSOURCING_SUBCATEGORY || row.amount < outsourcingRule.value!) continue;
        findings.push({
          code: 'outsourcing_notice_threshold', severity: outsourcingRule.severity,
          scope: { kind: 'detail', yearId, detailId: row.detail.id, category: row.detail.category }, actual: row.amount, limit: outsourcingRule.value,
          message: withSource(`외주 용역 ${fmtWon(row.amount)}은 계획서에 용역 내역·금액을 명시해야 합니다 (${fmtWon(outsourcingRule.value!)} 이상)`, outsourcingRule),
          approximate: false,
        });
      }
    }
  }

  // RL-1: severity는 정렬 순서만 정한다. Array.prototype.sort는 안정 정렬이라 같은 등급은 입력 순이 유지된다
  findings.sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity]);

  return { findings, ratios, skipped };
}
