// 금액 표시 환산 (SOT §6.4 B-4, §7.9, §5.16)
// 저장·계산은 언제나 원 단위 정수다. 이 모듈은 표시 계층 전용이며,
// 여기서 나온 값을 다시 계산에 넣지 않는다.
// 단위 테스트: tests/unit/currency.test.ts

import type { Settings } from '@/types';

// §5.16 currencyUnit의 3종과 1:1로 대응한다.
export const CURRENCY_UNIT_DIVISORS: Record<Settings['currencyUnit'], number> = {
  '원': 1,
  '천원': 1_000,
  '백만원': 1_000_000,
};

/**
 * B-4 표시 환산. 입력은 원 단위 정수다.
 *
 * 몫과 나머지로 반올림한다 — `won / divisor`의 소수 결과를 Math.round에 넘기면
 * 큰 금액에서 이진 부동소수 오차가 경계값을 뒤집을 수 있다.
 * 음수는 0에서 먼 쪽으로 반올림해(half away from zero) 부호 대칭을 지킨다:
 * formatAmount(-n) 은 언제나 '-' + formatAmount(n) 이다.
 */
export function formatAmount(won: number, unit: Settings['currencyUnit']): string {
  const divisor = CURRENCY_UNIT_DIVISORS[unit];
  const quotient = Math.trunc(won / divisor);
  const remainder = won - quotient * divisor;
  const step = remainder < 0 ? -1 : 1;
  const rounded = Math.abs(remainder) * 2 >= divisor ? quotient + step : quotient;
  return `${(rounded + 0).toLocaleString('ko-KR')}${unit}`; // +0: -0 이 '-0원'으로 보이는 것을 막는다
}
