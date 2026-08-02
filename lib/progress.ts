// 4단계 진척률 롤업: Task → Year → Stage → Project (SOT §6.1, P-1~P-13)
// 부수효과 없는 순수 함수다. 진척률은 저장하지 않고 읽을 때 계산한다 (O-4).
// P-8: 여기서는 절대 반올림하지 않는다. 반올림은 표시 단계에서만 한다.
// 단위 테스트: tests/unit/progress.test.ts

import type { Task } from '@/types';

// lib/tree.ts의 TaskNode가 구조적으로 그대로 대입되도록 최소 필드만 요구한다.
// (진척률 계산이 트리 구성 모듈에 의존하지 않게 하려는 의도 — 반대 방향 import도 없다)
export interface ProgressNode {
  task: Pick<Task, 'id' | 'status' | 'progressMode' | 'manualProgress' | 'estimatedHours'>;
  children: ProgressNode[];
}

// P-7: estimatedHours가 0/null이면 가중치 1. 음수는 §5.6 검증이 막지만,
// 들어오더라도 가중 평균이 뒤집히지 않도록 1로 본다.
function weightOf(estimatedHours: number | null): number {
  return estimatedHours === null || estimatedHours <= 0 ? 1 : estimatedHours;
}

/** ① Task 진척률 (post-order). P-1~P-7 */
export function computeTaskProgress(node: ProgressNode): number {
  if (node.children.length === 0) {
    // P-1: 리프가 done이면 100 강제. P-11: 되돌려도 manualProgress는 유지된다
    if (node.task.status === 'done') return 100;
    return node.task.manualProgress;
  }

  // P-4/P-5: 부모는 auto가 기본이고, manual 토글 시 입력값을 그대로 쓴다
  if (node.task.progressMode === 'manual') return node.task.manualProgress;

  return weightedAverage(
    node.children.map((c): [number, number] => [
      computeTaskProgress(c),
      weightOf(c.task.estimatedHours),
    ])
  );
}

/** 트리 전체의 Task별 진척률을 post-order 1회 순회로 계산한다. key = task.id */
export function computeProgressMap(roots: readonly ProgressNode[]): Map<string, number> {
  const map = new Map<string, number>();

  const visit = (node: ProgressNode): number => {
    let progress: number;
    if (node.children.length === 0) {
      progress = node.task.status === 'done' ? 100 : node.task.manualProgress;
    } else {
      // 자식은 manual 부모여도 순회해야 한다 — 맵에 모든 Task가 들어가야 하므로
      const childResults = node.children.map((c): [number, number] => [
        visit(c),
        weightOf(c.task.estimatedHours),
      ]);
      progress =
        node.task.progressMode === 'manual'
          ? node.task.manualProgress
          : weightedAverage(childResults);
    }
    map.set(node.task.id, progress);
    return progress;
  };

  for (const root of roots) visit(root);
  return map;
}

/** ② Year 진척률 = 루트 Task들의 가중 평균. Task가 없으면 0 (P-13이 이 0을 분모에 포함시킨다) */
export function computeYearProgress(roots: readonly ProgressNode[]): number {
  return weightedAverage(
    roots.map((r): [number, number] => [computeTaskProgress(r), weightOf(r.task.estimatedHours)])
  );
}

// ③④ 공통: budget 가중 평균. P-9 — budget이 전부 쓸모없으면(전부 null 또는 합이 0)
// progressWeightBasis 설정과 무관하게 균등 가중으로 폴백한다.
function budgetWeightedAverage(
  items: readonly { progress: number; budget: number | null }[],
  basis: 'budget' | 'equal'
): number {
  const useBudget =
    basis === 'budget' && items.some((i) => i.budget !== null && i.budget > 0);
  return weightedAverage(
    items.map((i): [number, number] => [i.progress, useBudget ? (i.budget ?? 1) : 1])
  );
}

/**
 * ③ Stage 진척률 = 소속 Year들의 가중 평균.
 * P-13: Task가 없는 연차도 progress 0으로 목록에 포함해서 넘겨야 한다(분모 포함).
 */
export function computeStageProgress(
  years: readonly { progress: number; budget: number | null }[],
  basis: 'budget' | 'equal'
): number {
  return budgetWeightedAverage(years, basis);
}

/** ④ Project 진척률 = 소속 Stage들의 가중 평균 (가중치 기준은 ③과 동일) */
export function computeProjectProgress(
  stages: readonly { progress: number; budget: number | null }[],
  basis: 'budget' | 'equal'
): number {
  return budgetWeightedAverage(stages, basis);
}

/**
 * P-12: 마지막 자식이 삭제되어 부모가 다시 리프가 될 때 고정할 manualProgress.
 * 여기서만 반올림한다 — 저장되는 입력값이 되기 때문이다(파생 값이 아니다).
 */
export function leafFallbackProgress(prevRolledUp: number): number {
  const rounded = Math.round(prevRolledUp);
  return Math.min(100, Math.max(0, rounded)); // manualProgress는 0~100 (§5.6)
}

// [진척률, 가중치] 목록의 가중 평균. 항목이 없거나 가중치 합이 0이면 0 (§6.1 ①의 규칙).
// P-8: 중간 반올림 없음.
function weightedAverage(entries: readonly (readonly [number, number])[]): number {
  let totalWeight = 0;
  let weightedSum = 0;
  for (const [value, weight] of entries) {
    totalWeight += weight;
    weightedSum += value * weight;
  }
  return totalWeight === 0 ? 0 : weightedSum / totalWeight;
}
