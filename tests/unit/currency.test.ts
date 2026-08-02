// 금액 표시 환산 테스트 (SOT §6.4 B-4, §7.9, §5.16)

import { describe, expect, it } from 'vitest';
import { CURRENCY_UNIT_DIVISORS, formatAmount } from '@/lib/currency';
import type { Settings } from '@/types';

const UNITS: Settings['currencyUnit'][] = ['원', '천원', '백만원'];

describe('CURRENCY_UNIT_DIVISORS', () => {
  it('§5.16의 3종 단위를 모두 덮는다', () => {
    expect(Object.keys(CURRENCY_UNIT_DIVISORS).sort()).toEqual([...UNITS].sort());
  });

  it('배수는 1 / 1,000 / 1,000,000 이다', () => {
    expect(CURRENCY_UNIT_DIVISORS).toEqual({ '원': 1, '천원': 1_000, '백만원': 1_000_000 });
  });
});

describe('formatAmount', () => {
  it('0은 부호 없이 0으로 표시한다', () => {
    expect(formatAmount(0, '원')).toBe('0원');
    expect(formatAmount(0, '천원')).toBe('0천원');
    expect(formatAmount(0, '백만원')).toBe('0백만원');
  });

  it('원 단위는 환산 없이 천단위 콤마만 붙인다', () => {
    expect(formatAmount(1, '원')).toBe('1원');
    expect(formatAmount(499, '원')).toBe('499원');
    expect(formatAmount(1_500, '원')).toBe('1,500원');
    expect(formatAmount(200_000_000, '원')).toBe('200,000,000원');
  });

  it('천원 단위로 환산한다', () => {
    expect(formatAmount(120_000_000, '천원')).toBe('120,000천원');
    expect(formatAmount(200_000_000, '천원')).toBe('200,000천원');
    expect(formatAmount(1_000, '천원')).toBe('1천원');
  });

  it('백만원 단위로 환산한다', () => {
    expect(formatAmount(120_000_000, '백만원')).toBe('120백만원');
    expect(formatAmount(200_000_000, '백만원')).toBe('200백만원');
    expect(formatAmount(1_000_000, '백만원')).toBe('1백만원');
  });

  // 반올림 경계: 나머지가 divisor의 절반 이상이면 올린다
  it('천원 경계 499/500에서 갈린다', () => {
    expect(formatAmount(499, '천원')).toBe('0천원');
    expect(formatAmount(500, '천원')).toBe('1천원');
    expect(formatAmount(1_499, '천원')).toBe('1천원');
    expect(formatAmount(1_500, '천원')).toBe('2천원');
  });

  it('백만원 경계 499,999/500,000에서 갈린다', () => {
    expect(formatAmount(499_999, '백만원')).toBe('0백만원');
    expect(formatAmount(500_000, '백만원')).toBe('1백만원');
    expect(formatAmount(1_499_999, '백만원')).toBe('1백만원');
    expect(formatAmount(1_500_000, '백만원')).toBe('2백만원');
  });

  it('원 단위는 경계 값도 그대로 둔다', () => {
    expect(formatAmount(500, '원')).toBe('500원');
    expect(formatAmount(499, '원')).toBe('499원');
  });

  // 음수: Math.trunc + 나머지 부호 처리. 0에서 먼 쪽으로 반올림한다
  it('음수는 양수와 부호만 다르게 표시한다', () => {
    for (const unit of UNITS) {
      for (const won of [0, 1, 499, 500, 1_500, 120_000_000, 200_000_000]) {
        const positive = formatAmount(won, unit);
        const negative = formatAmount(-won, unit);
        const expected = positive.startsWith('0') ? positive : `-${positive}`;
        expect(negative, `${-won} ${unit}`).toBe(expected);
      }
    }
  });

  it('음수 반올림 경계도 대칭이다', () => {
    expect(formatAmount(-499, '천원')).toBe('0천원'); // -0 이 새어 나오지 않는다
    expect(formatAmount(-500, '천원')).toBe('-1천원');
    expect(formatAmount(-1_500, '천원')).toBe('-2천원');
    expect(formatAmount(-1_499, '천원')).toBe('-1천원');
    expect(formatAmount(-499_999, '백만원')).toBe('0백만원');
    expect(formatAmount(-500_000, '백만원')).toBe('-1백만원');
    expect(formatAmount(-200_000_000, '백만원')).toBe('-200백만원');
    expect(formatAmount(-1_500, '원')).toBe('-1,500원');
  });

  // B-4: 소수 나눗셈에 기대면 이 구간에서 경계가 뒤집힌다
  it('큰 금액에서도 몫·나머지 반올림이 어긋나지 않는다', () => {
    expect(formatAmount(9_007_199_254_740_000, '백만원')).toBe('9,007,199,255백만원');
    expect(formatAmount(1_234_567_891, '천원')).toBe('1,234,568천원');
    expect(formatAmount(1_234_567_449, '천원')).toBe('1,234,567천원');
  });
});
