// 협약 보기 비율 — 계산과 표시 (SOT §6.19 AG-3·AG-4, 부록 B.9 주석, 계획서 S-6~S-8·S-19).
//
// 비율은 중간 반올림 없이 원값으로 들고 다닌다 — 판정·교차 검증은 원값으로 하고(부록 B.9: 잘라서 비교하면
// 경계에서 판정이 뒤집힌다), 소수 둘째 자리 + `%`는 표시할 때만 만든다. 분모가 0이면 0으로 나누지 않고
// 값 없음("—") + 사유를 낸다 — 사유는 검토사항에 그대로 보인다(조용히 0%로 보이지 않게).

/** 값이 없는 칸의 표시 */
export const RATE_NONE_TEXT = '—';

/** 비율(%). `value`가 null이면 `reason`이 그 이유다 */
export type Rate = { value: number; reason: null } | { value: null; reason: string };

/**
 * `numerator / denominator × 100`. 분모가 null(재료 줄 없음)이거나 0이면 값 없음.
 * 분자 null은 0으로 본다 — 분모가 있는데 분자 줄만 없으면 비율은 0%가 맞다.
 * 식은 `lib/rules.ts`의 `ratio()`와 같다(교차 검증이 원값으로 같아야 한다).
 */
export function computeRate(
  numerator: number | null,
  denominator: number | null,
  reasons: { noLines: string; zero: string }
): Rate {
  if (denominator === null) return { value: null, reason: reasons.noLines };
  if (denominator === 0) return { value: null, reason: reasons.zero };
  return { value: ((numerator ?? 0) / denominator) * 100, reason: null };
}

/** 값 없음 + 사유 */
export function noRate(reason: string): Rate {
  return { value: null, reason };
}

/**
 * 표시: 소수 둘째 자리 + `%`, 값 없음 "—". 지수 표기로 반올림해 `1.005`가 `1.00`이 되는 이진 오차를 피한다.
 */
export function formatRate(rate: Rate | number | null): string {
  const value = typeof rate === 'number' || rate === null ? rate : rate.value;
  if (value === null) return RATE_NONE_TEXT;
  if (!Number.isFinite(value)) throw new Error(`비율이 유한한 수가 아닙니다 (${value}).`);
  const abs = Math.abs(value);
  const text = String(abs);
  // 아주 작거나 큰 수는 String이 이미 지수 표기라 문자열 이어 붙이기가 깨진다 — 그때는 곱셈 반올림
  const rounded = text.includes('e') ? Math.round(abs * 100) / 100 : Number(`${Math.round(Number(`${text}e2`))}e-2`);
  const sign = value < 0 && rounded !== 0 ? '-' : '';
  return `${sign}${rounded.toFixed(2)}%`;
}
