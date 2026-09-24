// 급여 이력 순수 함수 테스트 (SOT §5.20 SL-1·SL-2·SL-4, §6.10 PL-2)
// 숫자는 §11 Phase 16 행(월급 3,000,000 → 36,000,000)과 부록 B.7.1 박선욱(74,000,000)에서 가져왔다.

import { describe, expect, it } from 'vitest';
import { monthlyDisplay, pickSalaryAsOf, salaryBasisBadge, toAnnualSalary } from '@/lib/salary';
import { SALARY_FLAG_LABELS } from '@/lib/constants';
import type { StaffSalary } from '@/types';

let seq = 0;

function salary(effectiveFrom: string, spec: Partial<Pick<StaffSalary, 'basis' | 'amount'>> = {}): StaffSalary {
  seq += 1;
  return {
    id: `s${seq}`,
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    version: 1,
    createdBy: null,
    updatedBy: null,
    staffId: 'st1',
    effectiveFrom,
    basis: spec.basis ?? 'annual',
    amount: spec.amount ?? 0,
    includesRetirement: false,
    includesInsurance: false,
    note: '',
  };
}

describe('toAnnualSalary (SL-1)', () => {
  it('월급 3,000,000 → 연봉 36,000,000', () => {
    expect(toAnnualSalary({ basis: 'monthly', amount: 3_000_000 })).toBe(36_000_000);
  });

  it('연봉 74,000,000은 그대로', () => {
    expect(toAnnualSalary({ basis: 'annual', amount: 74_000_000 })).toBe(74_000_000);
  });
});

describe('monthlyDisplay (SL-1 표시 전용, PL-2)', () => {
  it('74,000,000 → 6,166,667 (표시에서만 반올림)', () => {
    expect(monthlyDisplay(74_000_000)).toBe(6_166_667);
  });

  it('나누어떨어지면 그대로', () => {
    expect(monthlyDisplay(36_000_000)).toBe(3_000_000);
  });

  it('0은 -0이 아니라 0', () => {
    expect(Object.is(monthlyDisplay(0), 0)).toBe(true);
  });
});

describe('pickSalaryAsOf (SL-2)', () => {
  const s2025 = salary('2025-01-01', { amount: 30_000_000 });
  const s2026 = salary('2026-01-01', { amount: 36_000_000 });
  const history = [s2025, s2026];

  it('기준일이 경계일과 같으면 그 이력 (2026-01-01 → 2026 행)', () => {
    expect(pickSalaryAsOf(history, '2026-01-01')).toBe(s2026);
  });

  it('경계 하루 전은 이전 이력 (2025-12-31 → 2025 행)', () => {
    expect(pickSalaryAsOf(history, '2025-12-31')).toBe(s2025);
  });

  it('첫 이력보다 이른 기준일이면 null — 빈 값으로 채우지 않는다', () => {
    expect(pickSalaryAsOf(history, '2024-06-01')).toBeNull();
  });

  it('역순 입력도 같은 결과 (정렬을 가정하지 않는다)', () => {
    const reversed = [s2026, s2025];
    expect(pickSalaryAsOf(reversed, '2026-01-01')).toBe(s2026);
    expect(pickSalaryAsOf(reversed, '2025-12-31')).toBe(s2025);
    expect(pickSalaryAsOf(reversed, '2024-06-01')).toBeNull();
  });

  it('이력이 없으면 null', () => {
    expect(pickSalaryAsOf([], '2026-01-01')).toBeNull();
  });

  it('기준일 이후 이력만 있으면 null', () => {
    expect(pickSalaryAsOf([s2026], '2025-06-01')).toBeNull();
  });

  it('입력 배열을 바꾸지 않는다', () => {
    const copy = [s2026, s2025];
    pickSalaryAsOf(copy, '2026-06-01');
    expect(copy).toEqual([s2026, s2025]);
  });
});

describe('salaryBasisBadge (SL-4)', () => {
  it('둘 다 true → 퇴직금 포함 · 4대보험 포함', () => {
    const badge = salaryBasisBadge({ salaryIncludesRetirement: true, salaryIncludesInsurance: true });
    expect(badge).toEqual({
      retirement: true,
      insurance: true,
      labels: [SALARY_FLAG_LABELS.retirement, SALARY_FLAG_LABELS.insurance],
    });
  });

  it('퇴직금만 → 퇴직금 포함', () => {
    const badge = salaryBasisBadge({ salaryIncludesRetirement: true, salaryIncludesInsurance: false });
    expect(badge.labels).toEqual([SALARY_FLAG_LABELS.retirement]);
  });

  it('둘 다 false → 라벨 없음 (기록은 있으나 아무것도 포함하지 않음)', () => {
    const badge = salaryBasisBadge({ salaryIncludesRetirement: false, salaryIncludesInsurance: false });
    expect(badge).toEqual({ retirement: false, insurance: false, labels: [] });
  });

  it('둘 다 null → 기록 없음 (수동 입력, PL-10b)', () => {
    const badge = salaryBasisBadge({ salaryIncludesRetirement: null, salaryIncludesInsurance: null });
    expect(badge).toEqual({ retirement: null, insurance: null, labels: [SALARY_FLAG_LABELS.none] });
  });

  it('문구는 SOT 표기 그대로', () => {
    expect(SALARY_FLAG_LABELS.retirement).toBe('퇴직금 포함');
    expect(SALARY_FLAG_LABELS.insurance).toBe('4대보험 포함');
    expect(SALARY_FLAG_LABELS.none).toBe('기록 없음');
  });
});
