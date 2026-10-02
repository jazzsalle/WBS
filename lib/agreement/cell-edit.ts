// 비목별 보기의 셀 편집 해석 (SOT §6.19 AG-2, 계획서 S-10).
//
// 화면의 셀은 (연차, 비목, 축)이지만 데이터는 세목 단위 금액 줄이다. 사용자가 셀 총액을 바꾸면 어느 줄을
// 고칠지 정해야 한다: 줄이 정확히 1개면 그 줄, 0개·2개 이상이면 차액을 `default`(세목 미지정) 줄이 흡수한다.
// 다른 세목 줄을 임의로 깎지 않는다 — 그 줄들은 사용자가(또는 협약서가) 세목까지 정한 금액이다.
// 순수 함수다 — 실제 쓰기·낙관적 잠금(O-2)은 액션·리포지토리가 한다.

import { DEFAULT_SUBCATEGORY_CODE } from '@/lib/constants';
import type { AgreementLine, BudgetCategory, DetailAxis } from '@/types';

export type CellEditLine = Pick<AgreementLine, 'id' | 'yearId' | 'category' | 'subcategoryCode' | 'axis' | 'amount'>;

export interface CellEditTarget {
  yearId: string;
  category: BudgetCategory;
  axis: DetailAxis;
}

export type CellEditResolution =
  /** 기존 줄 하나의 금액을 바꾼다 */
  | { kind: 'update'; lineId: string; amount: number }
  /** `default` 세목 줄을 새로 만든다 */
  | {
      kind: 'insert';
      line: { yearId: string; category: BudgetCategory; subcategoryCode: string; axis: DetailAxis; amount: number };
    }
  /** 받을 수 없는 편집. `message`를 그대로 사용자에게 보인다 */
  | { kind: 'reject'; reason: 'invalid_amount' | 'exceeds_target'; message: string };

/**
 * 셀 총액을 `amount`로 바꾸려면 어떤 쓰기가 필요한가(AG-2).
 *
 * - 그 셀의 줄이 정확히 1개 → 그 줄을 `amount`로(세목이 무엇이든)
 * - 0개·2개 이상 → 새 `default` = `amount` − Σ(default 아닌 줄). `default` 줄이 있으면 update, 없으면 insert.
 *   음수면 reject("세목 줄 합계가 이미 목표보다 큽니다")
 *
 * 0이 된 줄은 지우지 않는다(update 금액 0) — 줄 없음("—")과 금액 0은 다른 사실이다.
 * `lines`에는 다른 셀의 줄이 섞여 있어도 된다(버전의 줄 전체를 넘겨도 된다).
 */
export function resolveCellEdit(
  lines: readonly CellEditLine[],
  target: CellEditTarget,
  amount: number
): CellEditResolution {
  if (!Number.isSafeInteger(amount) || amount < 0) {
    return { kind: 'reject', reason: 'invalid_amount', message: '금액은 0 이상의 원 단위 정수여야 합니다.' };
  }
  const cellLines = lines.filter(
    (l) => l.yearId === target.yearId && l.category === target.category && l.axis === target.axis
  );
  if (cellLines.length === 1) return { kind: 'update', lineId: cellLines[0]!.id, amount };

  const defaults = cellLines.filter((l) => l.subcategoryCode === DEFAULT_SUBCATEGORY_CODE);
  // unique(version_id, year_id, category, subcategory_code, axis)가 막는 상태 — 어느 줄에 흡수할지 정할 수 없다
  if (defaults.length > 1) throw new Error('같은 칸에 세목 미지정 줄이 두 개 있습니다 — 데이터가 손상되었습니다.');
  const others = cellLines.reduce((sum, l) => (l.subcategoryCode === DEFAULT_SUBCATEGORY_CODE ? sum : sum + l.amount), 0);
  const nextDefault = amount - others;
  if (nextDefault < 0) {
    return {
      kind: 'reject',
      reason: 'exceeds_target',
      message: `세목 줄 합계가 이미 목표보다 큽니다 — 세목 줄 합계 ${others.toLocaleString('ko-KR')}원, 목표 ${amount.toLocaleString('ko-KR')}원. 세목별 금액을 먼저 줄이세요.`,
    };
  }
  const existing = defaults[0];
  if (existing !== undefined) return { kind: 'update', lineId: existing.id, amount: nextDefault };
  return {
    kind: 'insert',
    line: {
      yearId: target.yearId,
      category: target.category,
      subcategoryCode: DEFAULT_SUBCATEGORY_CODE,
      axis: target.axis,
      amount: nextDefault,
    },
  };
}
