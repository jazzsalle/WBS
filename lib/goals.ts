// 성과목표(§6.2 D-1~D-5)·기술목표(§6.3 T-1~T-4) 달성률 계산.
// 부수효과 없는 순수 함수다. 달성률은 저장하지 않고 읽을 때 계산한다 (O-4).
// P-8: 여기서는 절대 반올림하지 않는다 — 반올림은 formatRate()에서만 한다.
// 경고 판정(D-3/D-5/T-3/T-4)도 전부 반환값으로 노출한다. UI가 다시 판정하면
// 규칙이 두 곳에 생긴다.
// 단위 테스트: tests/unit/goals.test.ts

import type { Deliverable, TechTarget, TechTargetRecord } from '@/types';

// ─── §6.2 성과목표 ───────────────────────────────────────────

// 계산에 필요한 최소 입력 (Deliverable을 그대로 대입할 수 있다)
export type DeliverableInput = Pick<
  Deliverable,
  'targetTotal' | 'targetByYear' | 'achievements'
>;

export interface DeliverableYearRate {
  yearId: string;
  target: number;
  achieved: number;
  rate: number | null;   // D-5: target이 없거나 0이면 null
  offTarget: boolean;    // D-5: 목표 0인데 실적이 있는 "목표 외 달성"
}

export interface DeliverableSummary {
  target: number;
  achieved: number;
  rate: number | null;          // D-1: targetTotal 0이면 null(N/A)
  overAchieved: boolean;        // D-2: 100 초과 (클램프하지 않는다)
  yearTargetMismatch: boolean;  // D-3: Σ targetByYear ≠ targetTotal
  unassignedAchieved: number;   // D-4: yearId가 null인 실적 건수
  byYear: DeliverableYearRate[];
}

/** 지표 달성률 = 실적 건수 / targetTotal * 100. D-1이면 null, D-2로 상한 없음 */
export function computeDeliverableRate(input: DeliverableInput): number | null {
  if (input.targetTotal === 0) return null;
  return (input.achievements.length / input.targetTotal) * 100;
}

/** 특정 연차의 달성률. D-4에 따라 yearId가 null인 실적은 세지 않는다 */
export function computeDeliverableYearRate(
  input: DeliverableInput,
  yearId: string
): DeliverableYearRate {
  const target = input.targetByYear[yearId] ?? 0;
  const achieved = input.achievements.filter((a) => a.yearId === yearId).length;
  if (target <= 0) {
    // D-5: 분모가 없으면 N/A. 실적이 있으면 "목표 외 달성"으로 구분한다
    return { yearId, target, achieved, rate: null, offTarget: achieved > 0 };
  }
  return { yearId, target, achieved, rate: (achieved / target) * 100, offTarget: false };
}

export function summarizeDeliverable(input: DeliverableInput): DeliverableSummary {
  const rate = computeDeliverableRate(input);

  // 목표가 잡힌 연차 + 목표 없이 실적만 있는 연차(D-5) 둘 다 나열한다
  const yearIds: string[] = Object.keys(input.targetByYear);
  for (const a of input.achievements) {
    if (a.yearId !== null && !yearIds.includes(a.yearId)) yearIds.push(a.yearId);
  }

  const yearTargetSum = Object.values(input.targetByYear).reduce((s, v) => s + v, 0);

  return {
    target: input.targetTotal,
    achieved: input.achievements.length,
    rate,
    overAchieved: rate !== null && rate > 100,
    yearTargetMismatch: yearTargetSum !== input.targetTotal,
    unassignedAchieved: input.achievements.filter((a) => a.yearId === null).length,
    byYear: yearIds.map((y) => computeDeliverableYearRate(input, y)),
  };
}

export interface DeliverableTotal {
  target: number;                    // Σ targetTotal
  achieved: number;                  // Σ 실적 건수 (D-4: yearId null 포함)
  rate: number | null;               // 단순 합산, 지표별 가중 없음
  overAchieved: boolean;
  anyYearTargetMismatch: boolean;    // D-3 경고가 하나라도 있으면 true
}

/** 과제 전체 성과목표 달성률 = Σ달성 / Σ목표 * 100 */
export function computeDeliverableTotal(
  inputs: readonly DeliverableInput[]
): DeliverableTotal {
  let target = 0;
  let achieved = 0;
  let anyYearTargetMismatch = false;

  for (const input of inputs) {
    target += input.targetTotal;
    achieved += input.achievements.length;
    const yearTargetSum = Object.values(input.targetByYear).reduce((s, v) => s + v, 0);
    if (yearTargetSum !== input.targetTotal) anyYearTargetMismatch = true;
  }

  const rate = target === 0 ? null : (achieved / target) * 100;
  return {
    target,
    achieved,
    rate,
    overAchieved: rate !== null && rate > 100,
    anyYearTargetMismatch,
  };
}

// ─── §6.3 기술목표 ───────────────────────────────────────────

export type TechTargetInput = Pick<
  TechTarget,
  'direction' | 'weight' | 'targetValue' | 'baselineDomestic' | 'measureMethod' | 'records'
>;

export interface TechTargetSummary {
  current: number | null;      // 최신 실적치. 레코드가 없으면 null
  latest: TechTargetRecord | null;
  rate: number | null;         // 미측정 또는 T-2면 null
  measured: boolean;
  evaluatorMissing: boolean;   // T-4
}

/**
 * 현재 실적치가 될 레코드. date가 가장 최신인 것,
 * 동률이면 배열 뒤쪽(리포지토리가 created_at 오름차순으로 내려준다)을 최신으로 본다.
 * 입력 정렬을 신뢰하지 않고 여기서 고른다.
 */
export function latestRecord(
  records: readonly TechTargetRecord[]
): TechTargetRecord | null {
  let best: TechTargetRecord | null = null;
  for (const r of records) {
    if (best === null || r.date >= best.date) best = r; // >= 로 동률 시 뒤쪽 우선
  }
  return best;
}

/** §6.3 의사코드 그대로. 반환은 0~100 클램프(T-1) 또는 null(미측정·T-2) */
export function computeTechTargetRate(target: TechTargetInput): number | null {
  const current = latestRecord(target.records)?.value ?? null;
  if (current === null) return null; // 미측정 — T-2보다 먼저 판정한다

  // T-2: 감소 목표는 시작점 없이 감소율을 만들 수 없다
  if (target.direction === 'lower_better' && target.baselineDomestic === null) return null;

  const base = target.baselineDomestic ?? 0;
  const targetValue = target.targetValue;
  let rate: number;

  if (target.direction === 'higher_better') {
    rate =
      targetValue === base
        ? current >= targetValue
          ? 100
          : 0
        : ((current - base) / (targetValue - base)) * 100;
  } else if (target.direction === 'lower_better') {
    rate =
      base === targetValue
        ? current <= targetValue
          ? 100
          : 0
        : ((base - current) / (base - targetValue)) * 100;
  } else {
    if (current === targetValue) {
      rate = 100;
    } else {
      const tolerance = Math.abs(targetValue) * 0.05; // ±5% 허용
      rate = Math.abs(current - targetValue) <= tolerance ? 100 : 0;
    }
  }

  return clamp(rate, 0, 100); // T-1
}

export function summarizeTechTarget(target: TechTargetInput): TechTargetSummary {
  const latest = latestRecord(target.records);
  return {
    current: latest?.value ?? null,
    latest,
    rate: computeTechTargetRate(target),
    measured: latest !== null,
    // T-4: 공인시험 방식인데 평가기관이 비어 있으면 경고.
    // 레코드가 아예 없으면 미측정 문제이지 T-4가 아니다
    evaluatorMissing:
      target.measureMethod === 'certified_lab' &&
      latest !== null &&
      latest.evaluator.trim() === '',
  };
}

export interface TechTargetTotal {
  weightedRate: number | null;  // T-3: Σweight가 0이면 null (0으로 나누지 않는다)
  totalWeight: number;
  weightMismatch: boolean;      // T-3: Σweight ≠ 100
  unmeasuredCount: number;      // 달성률 0으로 잡힌 항목 수 (미측정 + T-2 N/A)
  evaluatorMissingCount: number;
}

/**
 * 과제 전체 기술목표 달성률 = Σ(달성률 × weight) / Σ(weight).
 * 미측정과 T-2 N/A는 달성률 0으로 간주하되 분모(weight)에는 포함한다.
 * P-8: 항목 달성률을 반올림하지 않고 그대로 가중한다.
 */
export function computeTechTargetTotal(
  targets: readonly TechTargetInput[]
): TechTargetTotal {
  let totalWeight = 0;
  let weightedSum = 0;
  let unmeasuredCount = 0;
  let evaluatorMissingCount = 0;

  for (const t of targets) {
    const summary = summarizeTechTarget(t);
    totalWeight += t.weight;
    weightedSum += (summary.rate ?? 0) * t.weight;
    if (summary.rate === null) unmeasuredCount += 1;
    if (summary.evaluatorMissing) evaluatorMissingCount += 1;
  }

  return {
    weightedRate: totalWeight === 0 ? null : weightedSum / totalWeight,
    totalWeight,
    weightMismatch: targets.length > 0 && totalWeight !== 100,
    unmeasuredCount,
    evaluatorMissingCount,
  };
}

// ─── 표시 ────────────────────────────────────────────────────

/** 표시용 반올림은 여기서만 한다 (P-8). null은 'N/A' */
export function formatRate(rate: number | null): string {
  if (rate === null) return 'N/A';
  const rounded = Math.round(rate * 10) / 10;
  return `${(rounded + 0).toFixed(1)}%`; // +0: -0 이 '-0.0%'로 표시되는 것을 막는다
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
