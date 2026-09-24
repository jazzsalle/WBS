// 급여 이력 (SOT §5.20 SL-1·SL-2·SL-4) — 연봉 환산·적용 이력 선택·기준 배지. 순수 함수.
//
// 인건비 금액 산식(PL-1)은 여기 없다. 이 모듈은 "어느 급여를 얼마로 볼 것인가"까지만 정하고,
// 그 값을 Member.annualSalary에 넣는 것은 [급여 반영](§7.10)이, 금액을 만드는 것은
// lib/budget-plan.ts가 한다 (PL-10a: 같은 산식이 두 곳에 생기면 반드시 어긋난다).

import type { Member, StaffSalary } from '@/types';
import { SALARY_FLAG_LABELS } from './constants';

/** SL-1: `annual`은 그대로, `monthly`는 × 12. 원 단위 정수 입력이므로 결과도 정수다 */
export function toAnnualSalary(salary: Pick<StaffSalary, 'basis' | 'amount'>): number {
  return salary.basis === 'monthly' ? salary.amount * 12 : salary.amount;
}

/**
 * 월급 **표시** 값. 반환값을 산식에 넣지 않는다 — PL-2: 월액을 먼저 반올림하면
 * `74,000,000 / 12 → 6,166,667 × 0.28 × 9`가 15,540,001이 되어 연봉 기준 15,540,000과 어긋난다.
 * 화면 라벨·툴팁 용도로만 쓴다.
 */
export function monthlyDisplay(annual: number): number {
  return Math.round(annual / 12) + 0; // +0: -0 방지 (budget-plan.computeDetailAmount와 같은 이유)
}

/**
 * SL-2: 기준일 이하(`effectiveFrom ≤ asOfDate`, 경계일 포함)인 이력 중 가장 늦은 것.
 * 'YYYY-MM-DD'는 사전순이 곧 시간순이라 Date 객체 없이 비교한다.
 * 입력 정렬을 가정하지 않는다. 해당 이력이 없으면 null — 빈 값으로 채우지 않는다.
 */
export function pickSalaryAsOf(salaries: readonly StaffSalary[], asOfDate: string): StaffSalary | null {
  let picked: StaffSalary | null = null;
  for (const salary of salaries) {
    if (salary.effectiveFrom > asOfDate) continue;
    if (picked === null || salary.effectiveFrom > picked.effectiveFrom) picked = salary;
  }
  return picked;
}

export interface SalaryBasisBadge {
  retirement: boolean | null;
  insurance: boolean | null;
  /** 화면에 그대로 붙이는 배지 문구. 둘 다 null(수동 입력·기록 없음)이면 '기록 없음' 하나 */
  labels: string[];
}

/**
 * SL-4: Member에 스냅샷된 급여 기준 플래그를 배지 문구로. 어느 과제에서든 "이 연봉이 무엇을
 * 포함한 값인지"가 보여야 한다. 둘 다 null이면 [급여 반영]을 거치지 않은 값이다(PL-10b).
 */
export function salaryBasisBadge(
  m: Pick<Member, 'salaryIncludesRetirement' | 'salaryIncludesInsurance'>
): SalaryBasisBadge {
  const retirement = m.salaryIncludesRetirement;
  const insurance = m.salaryIncludesInsurance;
  if (retirement === null && insurance === null) {
    return { retirement, insurance, labels: [SALARY_FLAG_LABELS.none] };
  }
  const labels: string[] = [];
  if (retirement) labels.push(SALARY_FLAG_LABELS.retirement);
  if (insurance) labels.push(SALARY_FLAG_LABELS.insurance);
  return { retirement, insurance, labels };
}
