// 변경 이력 ④ 장비 사전 승인 (SOT §6.19 AG-7 ④, §6.14.5 RL-17, 부록 B.9.8, 계획서 Phase 26 S-20).
//
// 고른 두 버전 A(이전)·B(이후)의 편성 항목을 키 (연차, trim 품명)로 맞춰, B의 장비 건이 RL-17 기준 이상인데
// A 쪽에서는 아직 대상이 아니었던 것(새 장비 · 재료 → 장비 이관 · 기준 미만 → 이상)을 "사전 승인 대상"으로 낸다.
// 기준 비교는 `meetsEquipmentThreshold` 하나다(RL-17과 공용 — 부가세 별도 금액 × 1.1을 정수로 비교).
//
// 화면 목록만이다 — 변경 이력 엑셀(AG-8)은 이 결과를 쓰지 않는다. RL-17 행이 없거나 꺼져 있으면 판정하지 않고
// 그 사실을 돌려준다(경고 0건과 구별 — 절대 규칙 5).
// 단위 테스트: tests/unit/agreement-rules.test.ts

import { AGREEMENT_ITEM_KIND_LABELS } from '@/lib/constants';
import { meetsEquipmentThreshold, RULE_SPECS, type RuleInput } from '@/lib/rules';
import type { AgreementItem, AgreementItemKind } from '@/types';

export type EquipmentApprovalItem = Pick<AgreementItem, 'id' | 'yearId' | 'kind' | 'name' | 'amount'>;

export interface EquipmentApprovalWarning {
  /** B 버전 장비 건 id — 화면이 그 행으로 이동한다 */
  itemId: string;
  yearId: string;
  /** trim한 품명(비교 키) */
  name: string;
  /** A에 같은 키 장비가 없으면 null(새 장비·이관) */
  beforeEquipmentAmounts: number[] | null;
  /** A의 같은 키 장비 아닌 건 종류(재료 → 장비 이관 표시용). 없으면 빈 배열 */
  beforeOtherKinds: AgreementItemKind[];
  afterAmount: number;
  reason: 'new' | 'moved' | 'crossed';
  message: string;
}

export type EquipmentApprovalResult =
  | { status: 'judged'; threshold: number; warnings: EquipmentApprovalWarning[] }
  | { status: 'not_judged'; reason: string };

const RULE_CODE = 'equipment_review_threshold';

function fmtWon(value: number): string {
  return `${value.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',')}원`;
}

function keyOf(item: EquipmentApprovalItem): string {
  return `${item.yearId}|${item.name.trim()}`;
}

/**
 * A → B 장비 사전 승인 경고(AG-7 ④). `rule`은 과제의 `equipment_review_threshold` 행(없으면 undefined·null).
 * B의 같은 키 장비가 여럿이면 건마다 따로 본다. A의 같은 키 장비가 여럿이면 하나라도 기준 이상이면 이미 대상이다.
 */
export function diffEquipmentApproval(
  itemsA: readonly EquipmentApprovalItem[],
  itemsB: readonly EquipmentApprovalItem[],
  rule: RuleInput | null | undefined
): EquipmentApprovalResult {
  const ref = RULE_SPECS[RULE_CODE].ruleRef;
  if (rule == null) return { status: 'not_judged', reason: `${ref} 규칙 행이 없어 판정하지 않습니다` };
  if (rule.code !== RULE_CODE) throw new Error(`장비 사전 승인은 ${RULE_CODE} 규칙 행으로만 판정합니다 (${rule.code}).`);
  if (!rule.enabled) return { status: 'not_judged', reason: `${ref} 규칙이 꺼져 있어 판정하지 않습니다` };
  if (rule.value === null) return { status: 'not_judged', reason: `${ref} 기준 금액이 없어 판정하지 않습니다` };
  const threshold = rule.value;

  const before = new Map<string, EquipmentApprovalItem[]>();
  for (const item of itemsA) {
    const list = before.get(keyOf(item));
    if (list === undefined) before.set(keyOf(item), [item]);
    else list.push(item);
  }

  const warnings: EquipmentApprovalWarning[] = [];
  for (const item of itemsB) {
    if (item.kind !== 'equipment' || !meetsEquipmentThreshold(item.amount, threshold)) continue;
    const sameKey = before.get(keyOf(item)) ?? [];
    const equipment = sameKey.filter((a) => a.kind === 'equipment');
    if (equipment.some((a) => meetsEquipmentThreshold(a.amount, threshold))) continue;

    const otherKinds = [...new Set(sameKey.filter((a) => a.kind !== 'equipment').map((a) => a.kind))];
    const reason: EquipmentApprovalWarning['reason'] = equipment.length > 0 ? 'crossed' : otherKinds.length > 0 ? 'moved' : 'new';
    const name = item.name.trim();
    const was =
      reason === 'crossed'
        ? `이전 장비 ${equipment.map((a) => fmtWon(a.amount)).join(', ')}`
        : reason === 'moved'
          ? `이전에는 ${otherKinds.map((k) => AGREEMENT_ITEM_KIND_LABELS[k]).join('·')}`
          : '이전에 없음';
    warnings.push({
      itemId: item.id,
      yearId: item.yearId,
      name,
      beforeEquipmentAmounts: equipment.length > 0 ? equipment.map((a) => a.amount) : null,
      beforeOtherKinds: otherKinds,
      afterAmount: item.amount,
      reason,
      message: `장비 '${name}' ${fmtWon(item.amount)}(부가세 별도) — 부가세 포함 ${fmtWon(threshold)} 이상, 사전 승인 대상 (${was})`,
    });
  }
  return { status: 'judged', threshold, warnings };
}
