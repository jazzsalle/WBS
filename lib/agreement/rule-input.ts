// 수행 모드 규칙 판정 — 판정 대상 버전 + 입력 어댑터 (SOT §6.14.7, §6.14.8 "공통 적용" ①~⑥, 부록 B.9.7,
// 계획서 Phase 26 S-8).
//
// 판정기는 `lib/rules.ts` `evaluateRules` 하나다(D-10). 여기는 협약 예산 버전 데이터를 그 입력 모양
// (`RuleEvaluationInput`)으로 바꾸기만 한다 — 비율·경계·메시지를 다시 쓰지 않는다. 금액 줄을 세목 소계째
// `buildYearTotals`에 넘기므로 E1(`modifiedPersonnel`)·수정직접비(`modifiedDirectCost`)·총 인건비
// (`totalPersonnelCost`)는 판정기가 `lib/budget-plan.ts`에서 그대로 얻는다.
//
// 같은 편성이면 제안 판정과 결과가 같아야 한다(scope의 행 식별자만 다름 — 부록 B.9.7). 그래서 행 모양은
// 제안 경로(actions/budget-plan.ts `getBudgetPlan`)가 만드는 것과 맞춘다: 연차는 `order` 순 전부, 행 금액은
// 원 단위 정수, 인력은 `{ id, hireType }`.
//
// 모르는 값을 0으로 셈하지 않는다(절대 규칙 5): 정부지원 현금 미입력·초과 연차는 총액 3종을 null로 두고
// 사유를 남기고, 세목 미지정(`default`) 금액은 그 금액이 빠진다는 사실을 `skipped`로 남긴다.
// 단위 테스트: tests/unit/agreement-rules.test.ts

import { buildYearTotals, PERSONNEL_SUPPORT_SUBCATEGORY, PARTICIPATION_FACTOR_LABEL, type YearTotalSource } from '@/lib/budget-plan';
import {
  AGREEMENT_ITEM_SUBCATEGORY,
  BUDGET_CATEGORY_LABELS,
  BUDGET_CATEGORY_ORDER,
  DEFAULT_SUBCATEGORY_CODE,
} from '@/lib/constants';
import {
  evaluateRules,
  RULE_SPECS,
  type RuleEvaluation,
  type RuleEvaluationInput,
  type RuleInput,
  type RuleRowInput,
  type RuleSkipped,
  type RuleSubcategoryTotal,
  type RuleYearInput,
} from '@/lib/rules';
import { currentVersionId, type VersionRef } from './versions';
import type {
  AgreementGovSupport,
  AgreementItem,
  AgreementLine,
  AgreementParticipant,
  BudgetCategory,
  DetailAxis,
  Member,
  RuleCode,
  Year,
} from '@/types';

// ─── 판정 대상 버전 ───────────────────────────────────────────────────────────

/**
 * 판정 대상 버전(§6.14.8): 보고 있는 버전(작성 중·확정 모두) → 고른 것이 없으면 현재 버전(AV-3).
 * 버전이 0개면 null — "판정할 버전 없음"이지 위반 0건이 아니다(절대 규칙 5). 호출부는 null과 빈 findings를
 * 다르게 보여야 한다.
 *
 * 고른 버전이 목록에 없으면(그사이 남이 지움) 현재 버전으로 돌아간다 — 보기(AgreementScreen)가 같은 규칙으로
 * 버전을 고르고 "고른 버전이 없어 현재 버전을 보인다"를 알리므로, 판정 대상이 보기와 갈리지 않게 맞춘다.
 */
export function ruleTargetVersionId(versions: readonly VersionRef[], viewingVersionId: string | null): string | null {
  // currentVersionId가 목록 정합(중복·작성 중 2개)을 검사한다 — 어긋난 목록이면 던진다
  const current = currentVersionId(versions);
  if (viewingVersionId !== null && versions.some((v) => v.id === viewingVersionId)) return viewingVersionId;
  return current;
}

// ─── 입력 ─────────────────────────────────────────────────────────────────────

export type RuleInputLine = Pick<AgreementLine, 'yearId' | 'category' | 'subcategoryCode' | 'axis' | 'amount'>;
export type RuleInputParticipant = Pick<
  AgreementParticipant,
  'id' | 'memberId' | 'yearId' | 'participationRate' | 'months' | 'personnelCash' | 'personnelInKind'
>;
export type RuleInputItem = Pick<AgreementItem, 'id' | 'yearId' | 'kind' | 'name' | 'amount'>;
export type RuleInputGovSupport = Pick<AgreementGovSupport, 'yearId' | 'govCash'>;
/** RL-14·RL-15의 재료. 연봉은 쓰지 않는다 — 참여인원 금액은 버전에 저장된 값이다(§5.23) */
export type RuleInputMember = Pick<Member, 'id' | 'hireType'>;
export type RuleInputYear = Pick<Year, 'id' | 'name' | 'order'>;

export interface AgreementRuleInputParams {
  /** 판정 대상 버전의 금액 줄(§5.22) */
  lines: readonly RuleInputLine[];
  /** 판정 대상 버전의 참여인원(§5.23) */
  participants: readonly RuleInputParticipant[];
  /** 판정 대상 버전의 편성 항목(§5.24) */
  items: readonly RuleInputItem[];
  /** 판정 대상 버전의 연차별 정부지원 현금(§5.25). 행 없음 = 미입력 */
  govSupport: readonly RuleInputGovSupport[];
  /** 과제 인력 전부 — 참여인원이 가리키는 인력은 반드시 있어야 한다 */
  members: readonly RuleInputMember[];
  /** 과제 연차 전부(제안 경로와 같이 줄이 없는 연차도 판정 연차다) */
  years: readonly RuleInputYear[];
  /** 과제 규칙 행 — 세목 미지정 메모를 켜진 규칙에만 붙이기 위해 읽는다(⑥) */
  rules: readonly RuleInput[];
}

// ─── 출력 ─────────────────────────────────────────────────────────────────────

/** RL-8·RL-9 총액의 출처. 수행 모드는 과제 필드(`govBudget` 등)를 쓰지 않는다 */
export type AgreementRuleTotalsSource = 'agreement_gov_support';

/** 화면이 결과 옆에 적는 출처 문구(§6.14.8 ⑤ "버전 정부지원 현금 기준") */
export const AGREEMENT_RULE_TOTALS_SOURCE_LABEL = '버전 정부지원 현금 기준';

export type AgreementRuleNote =
  /** 세목 미지정 금액 — 켜진 규칙이 없어도 머리 메모로 보인다(S-9). 규칙별 사유는 `skipped`에 따로 있다 */
  | { kind: 'unassigned_subcategory'; yearId: string; category: UnassignedCategory; amount: number; message: string }
  /** 참여인원에는 학생 구분이 없어 전원이 RL-16 대상이다(③) */
  | { kind: 'participants_without_student_split'; message: string };

export interface AgreementRuleInputResult {
  input: RuleEvaluationInput;
  totalsSource: AgreementRuleTotalsSource;
  /** 어댑터가 정하는 skipped(⑥ 세목 미지정). 판정 결과의 skipped **뒤에** 붙인다 */
  skipped: RuleSkipped[];
  notes: AgreementRuleNote[];
}

// ─── 세목 미지정(⑥) ───────────────────────────────────────────────────────────

/**
 * 세목으로 갈리는 규칙의 재료가 되는 비목 → 그 규칙 코드. `default` 줄 금액은 세목을 몰라 분자에서 빠진다.
 * activity → RL-7(전문가활용비·외주용역비 세목), personnel → RL-11(연구지원인력인건비 세목),
 * indirect → RL-22(연구실 안전관리비 세목) 두 코드.
 */
const UNASSIGNED_RULES = {
  activity: ['external_tech_max'],
  personnel: ['no_personnel_support'],
  indirect: ['lab_safety_min', 'lab_safety_max'],
} as const satisfies Partial<Record<BudgetCategory, readonly RuleCode[]>>;

type UnassignedCategory = keyof typeof UNASSIGNED_RULES;
const UNASSIGNED_CATEGORIES = Object.keys(UNASSIGNED_RULES) as UnassignedCategory[];

// Intl에 기대지 않는다 — 테스트·서버·Tauri 웹뷰에서 같은 문자열이어야 한다(lib/rules.ts와 같은 이유)
function fmtWon(value: number): string {
  return `${value.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',')}원`;
}

export function unassignedSkippedReason(category: UnassignedCategory, amount: number): string {
  return `세목 미지정 ${BUDGET_CATEGORY_LABELS[category]} ${fmtWon(amount)} — 세목을 알 수 없어 판정에서 뺐습니다`;
}

/** 판정기의 isActive와 같은 뜻 — 켜져 있고 값이 필요하면 값이 있다(PL-14). 판정이 아니라 메모를 붙일지 정할 뿐이다 */
function ruleIsOn(rules: readonly RuleInput[], code: RuleCode): boolean {
  // RL-D1이 (project, code) 유일을 보장한다. 혹시 둘이면 판정기처럼 첫 행
  const rule = rules.find((r) => r.code === code);
  if (rule === undefined || !rule.enabled) return false;
  return !RULE_SPECS[code].needsValue || rule.value !== null;
}

// ─── 검증 ─────────────────────────────────────────────────────────────────────

// DB 제약을 벗어난 데이터는 던진다 — 조용히 빼면 판정이 줄어든 금액으로 통과를 낸다(절대 규칙 5)
function assertWon(value: number, what: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${what}이 0 이상의 원 단위 정수가 아닙니다 (${value}) — 데이터가 손상되었습니다.`);
  }
}

// ─── 어댑터 ───────────────────────────────────────────────────────────────────

const PARTICIPANT_SUBCATEGORY = DEFAULT_SUBCATEGORY_CODE;
const MONTHS_FACTOR_LABEL = '참여기간(월)';

function participantRow(
  participant: RuleInputParticipant,
  axis: DetailAxis,
  amount: number,
  member: RuleInputMember | null
): RuleRowInput {
  return {
    detail: {
      id: participant.id,
      // 참여인원에는 학생 구분·세목이 없다 — 전원 personnel(③). RL-16의 학생 제외는 그래서 적용되지 않는다
      category: 'personnel',
      subcategory: PARTICIPANT_SUBCATEGORY,
      axis,
      formula: 'personnel',
      memberId: participant.memberId,
      name: '',
      // 참여율은 personnelParticipation이 읽는 같은 라벨로 싣는다 — 인자 의미를 여기서 다시 정하지 않는다
      factors: [
        { label: PARTICIPATION_FACTOR_LABEL, value: participant.participationRate, isPercent: true },
        { label: MONTHS_FACTOR_LABEL, value: participant.months, isPercent: false },
      ],
    },
    amount,
    member: member === null ? null : { id: member.id, hireType: member.hireType },
    origin: { kind: 'participant', id: participant.id },
  };
}

/**
 * 참여인원 1행 → 축별 행(③). 현금 > 0이면 현금 행, 현물 > 0이면 현물 행 — RL-16 참여율은 판정기가 `origin`으로
 * 참여인원당 한 번만 센다.
 *
 * 두 축이 다 0인 행(연봉 모름 등)도 RL-16 대상이라 금액 0 행 하나를 남긴다. 축은 현물로 둔다 — 0원을 현금
 * 계상으로 읽어 RL-14 경고를 내면 소음이고, 현물 0원 행은 RL-14·RL-15 어느 쪽에도 금액을 보태지 않는다.
 * 인력 미지정 행은 판정기가 행 수로 skipped 사유를 세므로 축과 관계없이 행 하나만 만든다(같은 사람을 두 번 세지 않게).
 */
function participantRows(participant: RuleInputParticipant, member: RuleInputMember | null): RuleRowInput[] {
  const { personnelCash: cash, personnelInKind: inKind } = participant;
  if (member === null) {
    return [cash > 0 || inKind === 0 ? participantRow(participant, 'cash', cash, null) : participantRow(participant, 'in_kind', inKind, null)];
  }
  const rows: RuleRowInput[] = [];
  if (cash > 0) rows.push(participantRow(participant, 'cash', cash, member));
  if (inKind > 0) rows.push(participantRow(participant, 'in_kind', inKind, member));
  if (rows.length === 0) rows.push(participantRow(participant, 'in_kind', 0, member));
  return rows;
}

/** 편성 항목 1건 → 건 행(④). 금액 줄(세목 합계)은 건이 아니다 — RL-17~RL-19는 이 행만 본다(§6.14.5) */
function itemRow(item: RuleInputItem): RuleRowInput {
  const target = AGREEMENT_ITEM_SUBCATEGORY[item.kind];
  return {
    detail: {
      id: item.id,
      category: target.category,
      subcategory: target.subcategoryCode,
      // 편성 항목에는 축이 없다. 건별 규칙은 축을 보지 않는다
      axis: 'cash',
      formula: 'quantity',
      memberId: null,
      name: item.name,
      factors: [],
    },
    amount: item.amount,
    member: null,
    origin: { kind: 'item', id: item.id },
  };
}

interface YearAccumulator {
  byCategory: Map<BudgetCategory, { cash: number; inKind: number; seen: boolean }>;
  personnelSupport: number;
  subcategories: Map<string, RuleSubcategoryTotal>;
  unassigned: Map<UnassignedCategory, number>;
  rows: RuleRowInput[];
  cash: number;
  inKind: number;
}

function emptyYear(): YearAccumulator {
  return {
    byCategory: new Map(BUDGET_CATEGORY_ORDER.map((c) => [c, { cash: 0, inKind: 0, seen: false }])),
    personnelSupport: 0,
    subcategories: new Map(),
    unassigned: new Map(),
    rows: [],
    cash: 0,
    inKind: 0,
  };
}

/**
 * 판정 대상 버전 → `evaluateRules` 입력 + 어댑터 skipped·메모(§6.14.8 ①~⑥). 순수 함수.
 * 결과 판정은 `evaluateAgreementRules`가 같은 일을 한 번에 한다.
 */
export function buildAgreementRuleInput(params: AgreementRuleInputParams): AgreementRuleInputResult {
  const years = [...params.years].sort((a, b) => a.order - b.order);
  const acc = new Map<string, YearAccumulator>();
  for (const y of years) {
    if (acc.has(y.id)) throw new Error(`연차 목록에 같은 연차가 두 번 있습니다 (${y.id}).`);
    acc.set(y.id, emptyYear());
  }
  const yearOf = (yearId: string, what: string): YearAccumulator => {
    const found = acc.get(yearId);
    if (found === undefined) throw new Error(`${what}이 과제에 없는 연차를 가리킵니다 (${yearId}) — 데이터가 손상되었습니다.`);
    return found;
  };

  // ① 금액 줄 → 비목 합계 + personnel_support 소계, ② 세목 소계, ⑥ 세목 미지정 금액
  for (const line of params.lines) {
    const year = yearOf(line.yearId, '금액 줄');
    assertWon(line.amount, '금액 줄 금액');
    const bucket = year.byCategory.get(line.category);
    if (bucket === undefined) throw new Error(`금액 줄의 비목 '${line.category}'을 알 수 없습니다 — 데이터가 손상되었습니다.`);
    bucket.seen = true;
    if (line.axis === 'cash') {
      bucket.cash += line.amount;
      year.cash += line.amount;
    } else {
      bucket.inKind += line.amount;
      year.inKind += line.amount;
    }
    if (line.category === 'personnel' && line.subcategoryCode === PERSONNEL_SUPPORT_SUBCATEGORY) {
      year.personnelSupport += line.amount;
    }

    const key = `${line.category}|${line.subcategoryCode}`;
    const sub = year.subcategories.get(key);
    if (sub === undefined) year.subcategories.set(key, { category: line.category, subcategory: line.subcategoryCode, amount: line.amount });
    else sub.amount += line.amount;

    if (line.subcategoryCode === DEFAULT_SUBCATEGORY_CODE && line.category in UNASSIGNED_RULES) {
      const category = line.category as UnassignedCategory;
      year.unassigned.set(category, (year.unassigned.get(category) ?? 0) + line.amount);
    }
  }

  // ③ 참여인원 → 인력 행
  const members = new Map(params.members.map((m) => [m.id, m]));
  for (const p of params.participants) {
    const year = yearOf(p.yearId, '참여인원');
    assertWon(p.personnelCash, '참여인원 현금 인건비');
    assertWon(p.personnelInKind, '참여인원 현물 인건비');
    let member: RuleInputMember | null = null;
    if (p.memberId !== null) {
      const found = members.get(p.memberId);
      // FK·같은 과제 트리거가 보장하는 값이다 — 없으면 인력 목록을 덜 읽은 것이다
      if (found === undefined) throw new Error(`참여인원이 가리키는 인력을 찾을 수 없습니다 (${p.memberId}) — 데이터가 손상되었습니다.`);
      member = found;
    }
    year.rows.push(...participantRows(p, member));
  }

  // ④ 편성 항목 → 건 행
  for (const item of params.items) {
    const year = yearOf(item.yearId, '편성 항목');
    assertWon(item.amount, '편성 항목 금액');
    year.rows.push(itemRow(item));
  }

  // ⑤ RL-8·RL-9 총액 — 정부지원 현금(§5.25)
  const govByYear = new Map<string, number>();
  for (const g of params.govSupport) {
    yearOf(g.yearId, '정부지원 현금');
    assertWon(g.govCash, '정부지원 현금');
    if (govByYear.has(g.yearId)) throw new Error(`한 연차에 정부지원 현금 행이 두 개입니다 (${g.yearId}) — 데이터가 손상되었습니다.`);
    govByYear.set(g.yearId, g.govCash);
  }
  const missing: string[] = [];
  const exceeds: string[] = [];
  let gov = 0;
  let own = 0;
  for (const y of years) {
    const year = acc.get(y.id)!;
    const a = govByYear.get(y.id);
    if (a === undefined) {
      missing.push(y.name);
      continue;
    }
    if (a > year.cash) {
      exceeds.push(y.name);
      continue;
    }
    gov += a;
    own += year.cash - a + year.inKind;
  }
  const reasons: string[] = [];
  if (missing.length > 0) reasons.push(`정부지원 현금 미입력(${missing.join(', ')})`);
  if (exceeds.length > 0) reasons.push(`정부지원 현금이 그 연차 현금 합보다 큼(${exceeds.join(', ')})`);
  const project: RuleEvaluationInput['project'] =
    reasons.length > 0
      ? { govBudget: null, ownBudget: null, totalBudget: null, unavailableReason: reasons.join(' · ') }
      : { govBudget: gov, ownBudget: own, totalBudget: gov + own };

  // 연차 입력 + ⑥ skipped·메모
  const ruleYears: RuleYearInput[] = [];
  const skipped: RuleSkipped[] = [];
  const notes: AgreementRuleNote[] = [];
  for (const y of years) {
    const year = acc.get(y.id)!;
    const sources: YearTotalSource[] = [];
    for (const category of BUDGET_CATEGORY_ORDER) {
      const b = year.byCategory.get(category)!;
      if (!b.seen) continue;
      const amounts = { plannedAmount: b.cash + b.inKind, cashAmount: b.cash, inKindAmount: b.inKind };
      if (category === 'personnel') sources.push({ ...amounts, category, personnelSupportTotal: year.personnelSupport });
      else sources.push({ ...amounts, category });
    }
    ruleYears.push({
      yearId: y.id,
      totals: buildYearTotals(sources),
      rows: year.rows,
      subcategoryTotals: [...year.subcategories.values()],
    });

    for (const category of UNASSIGNED_CATEGORIES) {
      const amount = year.unassigned.get(category) ?? 0;
      if (amount <= 0) continue;
      const reason = unassignedSkippedReason(category, amount);
      notes.push({ kind: 'unassigned_subcategory', yearId: y.id, category, amount, message: `${y.name} ${reason}` });
      for (const code of UNASSIGNED_RULES[category]) {
        if (ruleIsOn(params.rules, code)) skipped.push({ code, reason, yearId: y.id });
      }
    }
  }
  if (params.participants.length > 0) {
    notes.push({
      kind: 'participants_without_student_split',
      message: '참여인원에는 학생 구분이 없어 전원을 최소 참여율(RL-16) 대상으로 판정합니다',
    });
  }

  return {
    input: { years: ruleYears, project },
    totalsSource: 'agreement_gov_support',
    skipped,
    notes,
  };
}

export interface AgreementRuleEvaluation {
  /** `evaluateRules` 결과 + 어댑터 skipped(뒤에 붙음) */
  evaluation: RuleEvaluation;
  totalsSource: AgreementRuleTotalsSource;
  notes: AgreementRuleNote[];
}

/** 어댑터 → 판정기 → 어댑터 skipped 덧붙이기. 수행 모드가 판정 결과를 얻는 유일한 길이다 */
export function evaluateAgreementRules(params: AgreementRuleInputParams): AgreementRuleEvaluation {
  const adapted = buildAgreementRuleInput(params);
  const evaluation = evaluateRules(params.rules, adapted.input);
  return {
    evaluation: { ...evaluation, skipped: [...evaluation.skipped, ...adapted.skipped] },
    totalsSource: adapted.totalsSource,
    notes: adapted.notes,
  };
}
