// 세목 총액 보존 RL-23 (SOT §6.14.8, §6.19 AG-7 ③, 계획서 S-12).
//
// 연차 간 이동은 허용되지만 세목별 전 연차 합은 기준 버전과 같아야 한다. 판정만 하고 막지 않는다(RL-1 — 경고).
// `RuleCode`·`budget_rules` 행이 아니다 — 켜고 끄기는 Phase 26 T0.
//
// 기준 버전 판정(AV-5)은 `versions.ts`가 한다. 여기서는 기준 버전의 줄을 인자로 받기만 한다 — 판정 규칙이
// 두 곳에 있으면 화면의 기준 표식과 경고의 비교 대상이 어긋날 수 있다.

import { compareCategoryKey, subcategoryRank } from '@/lib/agreement/diff';
import type { AgreementLine } from '@/types';

export type PreservationLine = Pick<AgreementLine, 'category' | 'subcategoryCode' | 'axis' | 'amount'>;
export type PreservationKey = Pick<AgreementLine, 'category' | 'subcategoryCode' | 'axis'>;

export interface PreservationEntry extends PreservationKey {
  /** 기준 버전의 전 연차 합. 기준에 없는 키는 0 */
  baseTotal: number;
  /** 판정 대상 버전의 전 연차 합. 대상에 없는 키는 0 */
  total: number;
  /** total − baseTotal */
  delta: number;
  preserved: boolean;
}

/**
 * - `no-base`: 기준 버전이 없어 판정하지 않았다. 경고 0건(`checked` + 빈 `warnings`)과 **다른 값**이다
 *   — 화면이 "문제 없음"과 "비교 대상 없음"을 같게 보이면 안 된다(절대 규칙 5)
 * - `checked`: `entries`는 양쪽 어디든 나온 키 전부(비목·세목·축 순서), `warnings`는 그중 다른 것
 */
export type PreservationResult =
  | { status: 'no-base' }
  | { status: 'checked'; baseVersionId: string; entries: PreservationEntry[]; warnings: PreservationEntry[] };

function keyOf(line: PreservationKey): string {
  return `${line.category}\u0000${line.subcategoryCode}\u0000${line.axis}`;
}

function totalsByKey(lines: readonly PreservationLine[], side: string): Map<string, { key: PreservationKey; total: number }> {
  const map = new Map<string, { key: PreservationKey; total: number }>();
  for (const line of lines) {
    if (!Number.isSafeInteger(line.amount) || line.amount < 0) {
      throw new Error(
        `${side} 줄(${line.category}/${line.subcategoryCode}/${line.axis})의 금액이 0 이상의 원 단위 정수가 아닙니다 (${line.amount}).`
      );
    }
    // 정렬 비교가 불리지 않는 키 1개짜리에서도 A.5 밖 세목을 잡는다
    subcategoryRank(line.category, line.subcategoryCode);
    const k = keyOf(line);
    const entry = map.get(k);
    if (entry === undefined) {
      map.set(k, { key: { category: line.category, subcategoryCode: line.subcategoryCode, axis: line.axis }, total: line.amount });
    } else {
      entry.total += line.amount;
    }
  }
  return map;
}

/**
 * 버전 V의 줄(`lines`, 모든 연차)을 기준 버전 base(V)의 줄과 (비목, 세목, 축)별 전 연차 합으로 비교한다.
 * `base`가 null이면 "기준 버전 없음". 정수 비교만 한다.
 */
export function checkSubcategoryPreservation(
  lines: readonly PreservationLine[],
  base: { versionId: string; lines: readonly PreservationLine[] } | null
): PreservationResult {
  if (base === null) return { status: 'no-base' };

  const target = totalsByKey(lines, '대상 버전');
  const baseline = totalsByKey(base.lines, '기준 버전');
  const entries: PreservationEntry[] = [];
  for (const k of new Set([...baseline.keys(), ...target.keys()])) {
    const b = baseline.get(k);
    const t = target.get(k);
    const baseTotal = b?.total ?? 0;
    const total = t?.total ?? 0;
    entries.push({ ...(t ?? b)!.key, baseTotal, total, delta: total - baseTotal, preserved: total === baseTotal });
  }
  entries.sort(compareCategoryKey);
  return { status: 'checked', baseVersionId: base.versionId, entries, warnings: entries.filter((e) => !e.preserved) };
}
