// 예산 제안 — 산출근거 금액·집계·지침 검증값 (SOT §6.10 PL-1~PL-13, §5.17).
// 한도 판정(PL-14·PL-15, §6.14)은 lib/rules.ts다 — 여기는 값만 낸다.
// 부수효과 없는 순수 함수다 — DB·네트워크·현재 시각을 쓰지 않는다.
//
// lib/budget.ts(§6.4 집행률)와 합치지 않는다 (§6.10.4). 방향이 반대이기 때문이다:
// §6.4는 집행을 더해 올라가고, 여기는 산출 행을 더해 비목 총액을 만들어낸다. 한 파일에 두면
// "기준액"이라는 말이 두 뜻으로 쓰여 PL-13의 간접비 기준액이 집행 기준액과 섞인다.
//
// 금액은 원 단위 정수다 (CLAUDE.md 절대규칙 4). 실수가 남는 값은 비율(rate)뿐이고,
// 비율은 여기서 반올림하지 않는다 (§6.1 P-8) — 표시 반올림은 화면의 몫이다.
// 단위 테스트: tests/unit/budget-plan.test.ts

import { BUDGET_CATEGORY_ORDER, SUBCATEGORY_PRESETS } from './constants';
import type { BudgetCategory, BudgetDetail, DetailAxis, DetailFactor, IndirectBase, Member } from '@/types';

// ─── 입력 (BudgetDetail·Member를 그대로 대입할 수 있는 최소 형태) ─

export type BudgetDetailInput = Pick<
  BudgetDetail,
  'yearId' | 'category' | 'subcategory' | 'axis' | 'formula' | 'memberId' | 'unitPrice' | 'adjustment'
> & {
  // 저장된 amount는 읽지 않는다 — 근거로 다시 계산한 값만 믿는다 (PL-D7)
  factors: readonly DetailFactor[];
};

/** 인건비 행의 단가 원본은 Member.annualSalary 하나뿐이다 (§5.11, §6.10.1) */
export type MemberSalaryInput = Pick<Member, 'id' | 'annualSalary'>;

// ─── 출력 ────────────────────────────────────────────────────

export interface DetailAmountResult {
  /** PL-4: 조정액을 더한 뒤 한 번만 반올림한 원 단위 정수 */
  amount: number;
  /** 반올림 전 실수. PL-2 검증과 디버깅용이다 — 저장하지 않는다 */
  unrounded: number;
  /** PL-5: 최종 금액이 음수. 0으로 자르지 않고 오류로 드러낸다 (호출부가 빨강 표시에 쓴다) */
  negative: boolean;
  /** 인건비 행인데 단가(연봉)를 알 수 없다 — 금액 0 + 경고 (§7.9.2 "연봉 미입력") */
  missingSalary: boolean;
}

/** 축별 금액. 필드명은 BudgetItem(§5.12)과 맞춘다 — PL-7이 그대로 이 세 값을 만든다 */
export interface PlanAmounts {
  cashAmount: number;
  inKindAmount: number;
  plannedAmount: number;
}

/** PL-6: 세목 소계 (축별 포함) */
export interface SubcategoryTotal extends PlanAmounts {
  category: BudgetCategory;
  subcategory: string;
  rowCount: number;
}

/** PL-7: (연차 × 비목) 셀 합계 */
export interface CellTotal extends PlanAmounts {
  yearId: string;
  category: BudgetCategory;
  rowCount: number;
  /** PL-5 오류 행 수. 0이 아니면 셀 합계를 그대로 믿으면 안 된다 */
  negativeCount: number;
  /** 연봉 미입력으로 0원 처리된 행 수 */
  missingSalaryCount: number;
  /** 부록 A.5 프리셋 순서. 프리셋에 없는 세목(PL-D4 위반)은 뒤에 등장 순서대로 붙인다 */
  subcategories: SubcategoryTotal[];
}

export interface DetailAggregate {
  /** 입력과 같은 순서·길이의 행별 계산 결과. 호출부가 행 표시에 그대로 쓴다 */
  rows: DetailAmountResult[];
  cells: CellTotal[];
  total: PlanAmounts;
  negativeCount: number;
  missingSalaryCount: number;
}

// ─── §6.10.1 산출 행 금액 (PL-1~PL-5) ────────────────────────

/**
 * PL-1·PL-3의 인자 곱.
 *
 * `isPercent`만으로 구분하는 이유: 인자 라벨은 행마다 바꿀 수 있어서(부록 A.5 주의 2 — 실측에서
 * ⑥ 소프트웨어 활용비의 수량 라벨이 `시트(수량)`였다) 라벨로 "참여기간(월)"을 찾을 수 없다.
 *
 * personnel 산식에서 비율이 아닌 인자는 **개월**뿐이므로 `/12`한다. 근거: 부록 A.5의 personnel
 * 세목 5종(내부·외부·연구지원인력·학생 일반·통합관리)이 모두 `참여율(%)`(isPercent) +
 * `참여기간(월)`(non-percent) 한 쌍이고, PL-1의 등식이 `연봉 × 참여율/100 × 개월/12`다.
 * quantity 산식에는 개월 개념이 없으므로 non-percent 인자를 그대로 곱한다 (PL-3).
 *
 * 인자가 0개면 곱은 1이다 — quantity는 `단가 + 조정액`(산식 없이 금액만 적는 간접비 세목),
 * personnel은 `연봉 + 조정액`(참여율 100% · 12개월과 같은 값)이 된다.
 */
function multiplyFactors(factors: readonly DetailFactor[], isPersonnel: boolean): number {
  let product = 1;
  for (const factor of factors) {
    if (factor.isPercent) product *= factor.value / 100;
    else if (isPersonnel) product *= factor.value / 12;
    else product *= factor.value;
  }
  return product;
}

/**
 * 산출 행 하나의 금액 (PL-1~PL-5).
 *
 * PL-2: 중간 반올림을 하지 않는다. 특히 월액(`annualSalary / 12`)을 먼저 반올림하면 안 된다 —
 * 박선욱 `74,000,000 × 0.28 × 0.75 = 15,540,000`이 월액 선반올림 경로에서는 15,540,001이 된다
 * (부록 B.7.1). 서식의 월액 열은 표시용이지 계산 입력이 아니다.
 * 그래서 여기서는 실수 곱을 끝까지 이어가고, PL-4의 Math.round는 조정액을 더한 **뒤** 딱 한 번만 한다.
 *
 * @param member formula='personnel'일 때의 단가 원본. 없거나 연봉이 null이면 금액 0 + 경고다.
 */
export function computeDetailAmount(
  detail: BudgetDetailInput,
  member?: MemberSalaryInput | null
): DetailAmountResult {
  const isPersonnel = detail.formula === 'personnel';
  let unitPrice = detail.unitPrice;

  if (isPersonnel) {
    // 단가를 모르면 조정액만 남은 금액은 근거가 없다 — 0원으로 두고 경고로 드러낸다.
    // member가 아예 없는 경우(PL-D1 위반)도 같은 취급이다: 어느 쪽이든 연봉을 알 수 없다는 뜻이고,
    // 화면이 띄울 경고("연봉 미입력", §7.9.2)도 하나다.
    if (member == null || member.annualSalary === null) {
      return { amount: 0, unrounded: 0, negative: false, missingSalary: true };
    }
    // PL-D1: personnel 행의 unitPrice는 무시하고 연봉만 쓴다
    unitPrice = member.annualSalary;
  }

  const unrounded = unitPrice * multiplyFactors(detail.factors, isPersonnel) + detail.adjustment;
  const amount = Math.round(unrounded) + 0; // +0: -0이 그대로 새어나가는 것을 막는다 (goals.formatRate와 같은 이유)

  return {
    amount,
    unrounded,
    negative: amount < 0, // PL-5: 0으로 자르지 않는다. 조정액을 잘못 넣은 것이지 0원짜리 행이 아니다
    missingSalary: false,
  };
}

// ─── §6.10.2 집계 (PL-6~PL-8) ────────────────────────────────

function emptyAmounts(): PlanAmounts {
  return { cashAmount: 0, inKindAmount: 0, plannedAmount: 0 };
}

/**
 * PL-7·PL-8: 축별로 **이미 반올림된 행 금액**을 더한다.
 * 실수 합계를 나중에 반올림하면 화면의 행 금액을 손으로 더한 값과 어긋난다.
 */
function addToAmounts(target: PlanAmounts, axis: DetailAxis, amount: number): void {
  if (axis === 'cash') target.cashAmount += amount;
  else target.inKindAmount += amount;
  target.plannedAmount += amount;
}

// 세목 정렬 키. 부록 A.5 프리셋에 없으면(PL-D4 위반) 뒤로 보낸다 — 조용히 버리지 않는다
function subcategoryRank(category: BudgetCategory, subcategory: string): number {
  const index = SUBCATEGORY_PRESETS[category].findIndex((def) => def.code === subcategory);
  return index === -1 ? Number.MAX_SAFE_INTEGER : index;
}

// 비목 순서는 부록 A.1 고정 순서를 따른다 (매트릭스 행 순서와 같아야 한다)
function categoryRank(category: BudgetCategory): number {
  const index = BUDGET_CATEGORY_ORDER.indexOf(category);
  return index === -1 ? Number.MAX_SAFE_INTEGER : index;
}

/**
 * 산출 행들을 세목 소계(PL-6) · 셀 합계(PL-7)로 접는다.
 * 셀 순서는 (연차 첫 등장 순, 부록 A.1 비목 순)으로 고정한다 — 연차 메타데이터 없이도 결정적이다.
 */
export function aggregateDetails(
  details: readonly BudgetDetailInput[],
  members: readonly MemberSalaryInput[]
): DetailAggregate {
  const salaries = new Map(members.map((m) => [m.id, m]));

  const rows: DetailAmountResult[] = [];
  const cells = new Map<string, CellTotal>();
  const yearOrder = new Map<string, number>();
  const subtotals = new Map<string, Map<string, SubcategoryTotal>>();
  const total = emptyAmounts();
  let negativeCount = 0;
  let missingSalaryCount = 0;

  for (const detail of details) {
    const result = computeDetailAmount(
      detail,
      detail.memberId === null ? null : salaries.get(detail.memberId)
    );
    rows.push(result);
    if (result.negative) negativeCount += 1;
    if (result.missingSalary) missingSalaryCount += 1;

    if (!yearOrder.has(detail.yearId)) yearOrder.set(detail.yearId, yearOrder.size);

    const cellKey = `${detail.yearId}|${detail.category}`;
    let cell = cells.get(cellKey);
    if (!cell) {
      cell = {
        yearId: detail.yearId,
        category: detail.category,
        rowCount: 0,
        negativeCount: 0,
        missingSalaryCount: 0,
        subcategories: [],
        ...emptyAmounts(),
      };
      cells.set(cellKey, cell);
      subtotals.set(cellKey, new Map());
    }
    cell.rowCount += 1;
    if (result.negative) cell.negativeCount += 1;
    if (result.missingSalary) cell.missingSalaryCount += 1;
    addToAmounts(cell, detail.axis, result.amount);

    const bySubcategory = subtotals.get(cellKey)!;
    let subtotal = bySubcategory.get(detail.subcategory);
    if (!subtotal) {
      subtotal = {
        category: detail.category,
        subcategory: detail.subcategory,
        rowCount: 0,
        ...emptyAmounts(),
      };
      bySubcategory.set(detail.subcategory, subtotal);
    }
    subtotal.rowCount += 1;
    addToAmounts(subtotal, detail.axis, result.amount);

    addToAmounts(total, detail.axis, result.amount);
  }

  const orderedCells = [...cells.values()].sort(
    (a, b) =>
      (yearOrder.get(a.yearId) ?? 0) - (yearOrder.get(b.yearId) ?? 0) ||
      categoryRank(a.category) - categoryRank(b.category)
  );
  for (const cell of orderedCells) {
    const bySubcategory = subtotals.get(`${cell.yearId}|${cell.category}`)!;
    cell.subcategories = [...bySubcategory.values()].sort(
      (a, b) =>
        subcategoryRank(cell.category, a.subcategory) -
        subcategoryRank(cell.category, b.subcategory)
    );
  }

  return { rows, cells: orderedCells, total, negativeCount, missingSalaryCount };
}

// ─── §6.10.3 지침 검증 (PL-11~PL-13) ─────────────────────────
//
// 여기는 **값**만 낸다 — E1·비율·수정직접비. 한도와 비교해 위반을 가리는 일은 lib/rules.ts
// (§6.14)가 한다. 한도가 Project 컬럼에서 과제별 규칙 행(§5.18)으로 옮겨졌기 때문이다(v4.5).

/** 부록 A.5 `personnel` 비목의 연구지원인력인건비 세목 코드. 서식의 C열이다 */
export const PERSONNEL_SUPPORT_SUBCATEGORY = 'personnel_support';

interface CategoryAmountsSource {
  plannedAmount: number;
  /** S-4: 현금/현물 분리가 없는 항목은 null이다 — 합산에서는 0으로 본다 */
  cashAmount: number | null;
  inKindAmount: number | null;
}

/**
 * 연차 하나의 비목별 금액.
 *
 * `personnel` 비목만 `personnelSupportTotal`을 **필수**로 요구한다 (PL-11). 이유:
 * E1은 `personnel_support` 세목을 세목 단위로 빼야 하는데, 비목 합계만 아는 경로
 * (`BudgetItem` §5.12 — 직접 입력·총괄표 임포트로 들어온 셀)는 그 값을 알 수 없다.
 * **모르는 값을 0으로 때우면 E1이 부풀고 연구수당 비율이 실제보다 작게 나와 한도 초과를 놓친다** —
 * 그래서 추론하지 않고 타입으로 호출부에 묻는다. 세목 소계를 아는 경로(aggregateDetails()의
 * `CellTotal`)는 그대로 넘기면 되고, 여기서 세목 소계로부터 값을 직접 뽑는다.
 * 산출근거가 없는 셀이라 C 구분 자체가 없는 경우에만 호출부가 0을 **명시적으로** 적는다.
 */
export type YearTotalSource =
  | CellTotal
  | (CategoryAmountsSource & { category: Exclude<BudgetCategory, 'personnel'> })
  | (CategoryAmountsSource & { category: 'personnel'; personnelSupportTotal: number });

export interface YearCategoryTotals {
  byCategory: Readonly<Partial<Record<BudgetCategory, PlanAmounts>>>;
  /** PL-11: 그 연차 `personnel_support` 세목의 현금 + 현물 소계. E1에서만 뺀다 */
  personnelSupportTotal: number;
}

/** 같은 비목이 여러 줄로 들어와도(임포트 중간 상태 등) 잃지 않도록 합산한다 */
export function buildYearTotals(sources: readonly YearTotalSource[]): YearCategoryTotals {
  const byCategory: Partial<Record<BudgetCategory, PlanAmounts>> = {};
  let personnelSupportTotal = 0;

  for (const source of sources) {
    const bucket = (byCategory[source.category] ??= emptyAmounts());
    bucket.plannedAmount += source.plannedAmount;
    bucket.cashAmount += source.cashAmount ?? 0;
    bucket.inKindAmount += source.inKindAmount ?? 0;

    if (source.category !== 'personnel') continue;
    if ('subcategories' in source) {
      // 세목 소계를 아는 경로 — 여기서 뽑는 것이 호출부가 손으로 세는 것보다 안전하다
      for (const subtotal of source.subcategories) {
        if (subtotal.subcategory === PERSONNEL_SUPPORT_SUBCATEGORY) {
          personnelSupportTotal += subtotal.plannedAmount;
        }
      }
    } else {
      personnelSupportTotal += source.personnelSupportTotal;
    }
  }

  return { byCategory, personnelSupportTotal };
}

/**
 * 직접비 비목 — `indirect`를 뺀 11비목 전부 (§6.14 RL-3).
 *
 * Phase 9는 `personnel`·`student_personnel`·`facility_equipment`·`material`·`activity`·`allowance`
 * 6비목만 더해 `promotion`·`other`의 현금이 간접비 분모에서 빠졌다. 과기부고시 제2조 9호의
 * 수정직접비는 "직접비 중 현물·위탁·국제공동·부담비를 제외한 금액"이라 **전 직접비**가 출발점이다
 * (PL-13 정정, v4.5). 부록 B.7은 두 비목이 0이라 0.9622%가 그대로다.
 */
export const DIRECT_CATEGORIES: readonly BudgetCategory[] = [
  'personnel',
  'student_personnel',
  'facility_equipment',
  'material',
  'activity',
  'allowance',
  'international',
  'consignment',
  'burden',
  'promotion',
  'other',
];

// PL-11: E1의 비목 쪽 재료. 여기서 personnel_support 세목 소계를 뺀 것이 E1이다
const MODIFIED_PERSONNEL_CATEGORIES: readonly BudgetCategory[] = ['personnel', 'student_personnel'];

// RL-3: base별로 직접비 현금 합에서 빼는 비목
const EXCLUDED_BY_BASE: Record<IndirectBase, readonly BudgetCategory[]> = {
  direct_cash_excl_intl_consign_burden: ['international', 'consignment', 'burden'],
  direct_cash_excl_intl: ['international'],
};

function sumPlanned(totals: YearCategoryTotals, categories: readonly BudgetCategory[]): number {
  let sum = 0;
  for (const category of categories) sum += totals.byCategory[category]?.plannedAmount ?? 0;
  return sum;
}

function sumCash(totals: YearCategoryTotals, categories: readonly BudgetCategory[]): number {
  let sum = 0;
  for (const category of categories) sum += totals.byCategory[category]?.cashAmount ?? 0;
  return sum;
}

/**
 * PL-11 수정인건비 E1 = (인건비 − 연구지원인력인건비) + 학생인건비. 현금 + 현물.
 *
 * **세목 단위로** 연구지원인력인건비(C)를 뺀다 — 서식의 `수정인건비2) (E1=A+B+D)` 그대로다.
 * 비목 단위로 더하면 C가 섞여 E1이 커지고, 분모가 커진 만큼 **연구수당 비율이 실제보다 작게 나와
 * 한도 초과를 놓친다.** 실측 서식은 C가 0이라 부록 B.7로는 드러나지 않는 오류다 —
 * 그래서 C > 0 회귀 테스트를 따로 둔다.
 */
export function modifiedPersonnel(yearTotals: YearCategoryTotals): number {
  return sumPlanned(yearTotals, MODIFIED_PERSONNEL_CATEGORIES) - yearTotals.personnelSupportTotal;
}

/**
 * PL-13·RL-3 수정직접비 = 직접비 11비목의 **현금** 합 − base별 제외 비목의 현금.
 * 정의는 여기 한 곳뿐이다 — lib/rules.ts는 이 함수를 그대로 가져다 쓴다.
 *
 * ⚠ PL-11과의 비대칭은 의도된 것이다: `personnel`은 연구지원인력인건비(C)를 **포함한 채로** 들어간다.
 * 서식의 분모 `N+O+P+D+…`에서 P가 바로 C의 현금이기 때문이다. E1은 C를 빼고 수정직접비는 C를 넣는다 —
 * 규정이 실제로 다르다. "일관성"을 이유로 한쪽에 맞추지 마라. 맞추는 순간 둘 중 하나는 서식과 어긋난다.
 */
export function modifiedDirectCost(yearTotals: YearCategoryTotals, base: IndirectBase): number {
  return sumCash(yearTotals, DIRECT_CATEGORIES) - sumCash(yearTotals, EXCLUDED_BY_BASE[base]);
}

/** 참여율 라벨. 부록 A.5 personnel 세목 5종의 기본 인자 이름이다 */
export const PARTICIPATION_FACTOR_LABEL = '참여율(%)';

/**
 * 인건비 행의 참여율(%). §6.14 RL-16이 인자 의미를 다시 정하지 않도록 여기서 한 번만 읽는다.
 *
 * 라벨이 '참여율(%)'인 `isPercent` 인자를 우선하고, 없으면 첫 `isPercent` 인자를 쓴다 —
 * multiplyFactors가 라벨이 아니라 `isPercent`로 참여율을 고르기 때문에(PL-1) 금액 계산과 같은
 * 인자를 봐야 한다. 백분율 인자가 하나도 없으면 100이다: PL-1에서 인자가 없는 행은 연봉 전액
 * (= 참여율 100%)이므로, 금액이 말하는 것과 같은 값을 돌려준다.
 */
export function personnelParticipation(detail: { factors: readonly DetailFactor[] }): number {
  const labelled = detail.factors.find((f) => f.isPercent && f.label === PARTICIPATION_FACTOR_LABEL);
  const factor = labelled ?? detail.factors.find((f) => f.isPercent);
  return factor ? factor.value : 100;
}

export interface BudgetRuleEvaluation {
  /** PL-11 수정인건비 E1 = (인건비 − 연구지원인력인건비) + 학생인건비. 현금 + 현물 */
  modifiedPersonnel: number;
  /** E1에서 빠진 연구지원인력인건비(C). 화면이 "왜 인건비 합계와 다른가"를 설명할 수 있어야 한다 */
  personnelSupportTotal: number;
  /** 연구수당 비목 합계 */
  allowanceTotal: number;
  /** PL-12: E1이 0이면 null — 0으로 나누지 않는다. 화면은 '—' */
  allowanceRate: number | null;
  /** 간접비 비목 합계 */
  indirectTotal: number;
  /** 어느 정의로 수정직접비를 냈는가 (RL-3). 화면이 분모 이름을 함께 보여 준다 */
  indirectBase: IndirectBase;
  /** PL-13 수정직접비(금액) = 직접비 11비목 현금 합 − base별 제외 */
  modifiedDirectCost: number;
  /** PL-13: 수정직접비가 0이면 null */
  indirectRate: number | null;
  /** 직접비 소계 = 총액 − 간접비 */
  directTotal: number;
  /** 연구개발비 총액 = 전 비목 합계 */
  grandTotal: number;
}

/**
 * 지침 검증의 **값** (PL-11~PL-13). 한도 판정은 하지 않는다 — lib/rules.ts `evaluateRules`가
 * 규칙 행(§5.18)을 받아서 한다. 여기서 한도를 알면 Project 컬럼 시절처럼 산식과 규제값이 한 곳에
 * 섞인다.
 *
 * @param indirectBase 수정직접비 정의. 과제의 `indirect_max` 규칙 행이 고르고, 행이 없으면 호출부가
 *   `DEFAULT_INDIRECT_BASE`(lib/rules.ts)를 넘긴다 — 비율은 규칙이 없어도 보여 준다(§6.14.6).
 */
export function evaluateBudgetRules(
  yearTotals: YearCategoryTotals,
  indirectBase: IndirectBase
): BudgetRuleEvaluation {
  const personnelSupportTotal = yearTotals.personnelSupportTotal;
  const e1 = modifiedPersonnel(yearTotals);

  const allowanceTotal = yearTotals.byCategory.allowance?.plannedAmount ?? 0;
  const indirectTotal = yearTotals.byCategory.indirect?.plannedAmount ?? 0;
  const directCost = modifiedDirectCost(yearTotals, indirectBase);

  // P-8: 비율은 여기서 반올림하지 않는다. 부록 B.7.3의 0.9622%는 표시 시점의 반올림 결과다
  const allowanceRate = e1 === 0 ? null : (allowanceTotal / e1) * 100;
  const indirectRate = directCost === 0 ? null : (indirectTotal / directCost) * 100;

  let grandTotal = 0;
  for (const amounts of Object.values(yearTotals.byCategory)) grandTotal += amounts.plannedAmount;

  return {
    modifiedPersonnel: e1,
    personnelSupportTotal,
    allowanceTotal,
    allowanceRate,
    indirectTotal,
    indirectBase,
    modifiedDirectCost: directCost,
    indirectRate,
    directTotal: grandTotal - indirectTotal,
    grandTotal,
  };
}

// ─── §7.9 제안 모드 하단 — 연차별 현금/현물 비중 ─────────────

/**
 * 축 합계의 재료. `YearTotalSource`를 그대로 넣을 수 있게 필드를 맞춘다 —
 * 지침 검증과 축 합계가 **같은 소스 배열**을 보아야 두 줄의 총액이 어긋나지 않는다.
 */
export interface AxisAmountsSource {
  plannedAmount: number;
  /** §5.12·S-4: 현금/현물 분리가 없는 셀은 null이다 — 0과 구분한다 */
  cashAmount: number | null;
  inKindAmount: number | null;
}

/** 비중을 낼 수 없는 이유. null이면 `cashRate`·`inKindRate`가 값이다 */
export type AxisShareBlock =
  /** 축이 없는 금액이 남아 있다 — 분모가 확정되지 않는다 */
  | 'unspecified'
  /** 그 연차 계획액이 0이다 — 0으로 나누지 않는다 (PL-12와 같은 태도) */
  | 'zero-total';

export interface YearAxisSplit {
  /** 현금으로 확정된 금액의 합 */
  cash: number;
  /** 현물로 확정된 금액의 합 */
  inKind: number;
  /** 현금/현물 구분이 **없는** 금액의 합. 0이 아니면 비중을 내지 않는다 */
  unspecified: number;
  /** cash + inKind + unspecified. 그 연차 계획액 총합과 같다 */
  total: number;
  /** 백분율. 반올림하지 않는다 (P-8) — 표시 반올림은 화면의 몫이다 */
  cashRate: number | null;
  inKindRate: number | null;
  shareBlockedBy: AxisShareBlock | null;
}

/**
 * 연차 하나의 현금/현물 비중 (§7.9 제안 모드 하단 요약).
 *
 * **모르는 값을 0으로 취급하지 않는다** (§6.10.3 PL-14와 같은 태도, CLAUDE.md 절대 규칙 5).
 * `cashAmount`·`inKindAmount`는 §5.12·S-4상 **null(미입력)일 수 있고**, 그것을 0으로 눙쳐
 * 합산하면 "현물 0원"이라는 사용자가 입력한 적 없는 진술이 만들어진다. 그래서 축이 붙지 않은
 * 금액을 `unspecified`로 **따로 세우고**, 그 값이 0이 아니면 비중 자체를 내지 않는다 —
 * 모르는 값을 분모에 넣어 그럴듯한 비율을 만드는 것이 가장 나쁜 결과다.
 *
 * 잔액(`plannedAmount − cash − inKind`)을 `unspecified`에 넣는 이유: 둘 다 null인 셀이면
 * 전액이 그대로 들어가고(S-4의 정상 경로), 한쪽만 채워진 셀은 §5.12상 나머지가 0이라 아무것도
 * 더하지 않는다. 두 값의 합이 `plannedAmount`와 어긋난 손상 데이터라면 그 차액이 여기 남아
 * 비중이 막히고 화면에 드러난다 — 조용히 사라지지 않는다.
 */
export function computeAxisSplit(sources: readonly AxisAmountsSource[]): YearAxisSplit {
  let cash = 0;
  let inKind = 0;
  let unspecified = 0;

  for (const source of sources) {
    const sourceCash = source.cashAmount ?? 0;
    const sourceInKind = source.inKindAmount ?? 0;
    cash += sourceCash;
    inKind += sourceInKind;
    unspecified += source.plannedAmount - sourceCash - sourceInKind;
  }

  const total = cash + inKind + unspecified;
  const shareBlockedBy: AxisShareBlock | null =
    unspecified !== 0 ? 'unspecified' : total === 0 ? 'zero-total' : null;

  return {
    cash,
    inKind,
    unspecified,
    total,
    cashRate: shareBlockedBy === null ? (cash / total) * 100 : null,
    inKindRate: shareBlockedBy === null ? (inKind / total) * 100 : null,
    shareBlockedBy,
  };
}
