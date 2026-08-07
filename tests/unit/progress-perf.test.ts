// §12 계산 성능 검증 — "5,000 노드 4단계 롤업 100ms 이내" (SOT §12 검증 방법 표)
// 순수 함수 측정이다. DB·네트워크를 타지 않는다.
//
// §12 검증표가 요구하는 형태 그대로다:
//   작업 5,000개를 합성 → computeProgressMap 왕복 시간 측정 → 100ms 초과 시 실패.
//   통과할 때도 실측을 stderr로 남긴다 — vitest 기본 리포터가 통과 테스트의 console 출력을
//   감추기 때문에, 그러지 않으면 "느려졌지만 아직 통과" 구간의 회귀를 아무도 못 본다.

import { describe, expect, it } from 'vitest';
import { computeProgressMap, computeTaskProgress, type ProgressNode } from '@/lib/progress';
import { MAX_TASK_DEPTH } from '@/lib/constants';

// §12 원문 그대로. 실측은 보통 이 값의 한두 자릿수 아래로 떨어지므로 임계값 자체가 이미
// PC 편차를 흡수하는 여유다. 느리다고 이 상수를 올리거나 skip하지 않는다 — 실패는 실패로 다룬다.
const ROLLUP_BUDGET_MS = 100;

// §12 데이터 규모의 상한(작업 5,000개).
const TASK_COUNT = 5_000;

const WARMUP_RUNS = 1;
const MEASURED_RUNS = 5;

// 깊이별 자식 수 범위. [depth 1→2, 2→3, 3→4, 4→5]이고 깊이 5는 항상 리프다.
// 깊이 3·4에서 최소 0을 허용해 중간 깊이 리프를 섞는다 — 전부 리프이거나 전부 일렬이면
// 롤업(가중 평균 + 재귀)을 재는 의미가 없다.
const CHILD_COUNT_RANGE: readonly (readonly [number, number])[] = [
  [2, 5],
  [2, 4],
  [0, 4],
  [0, 3],
];

const SYNTH_MAX_DEPTH = CHILD_COUNT_RANGE.length + 1; // 5

// 시드 고정 PRNG(mulberry32). 실행마다 트리가 달라지면 측정값을 비교할 수 없다.
function makeRng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function makeTask(id: string, isParent: boolean, rng: () => number): ProgressNode['task'] {
  const r = rng();
  // P-7의 두 분기(null·0 → 가중치 1)를 실제로 타게 섞는다. 전부 양수면 가중 평균이 쉬워진다
  const estimatedHours = r < 0.15 ? null : r < 0.2 ? 0 : 1 + Math.floor(rng() * 80);

  if (isParent) {
    // P-6: 자식이 생긴 Task는 auto. P-4의 manual 토글도 일부 섞어 조기 반환 경로를 태운다
    return {
      id,
      status: 'in_progress',
      progressMode: rng() < 0.1 ? 'manual' : 'auto',
      manualProgress: Math.floor(rng() * 101),
      estimatedHours,
    };
  }

  const s = rng();
  return {
    id,
    // P-10: 리프 기본은 manual
    status: s < 0.3 ? 'done' : s < 0.7 ? 'in_progress' : 'todo',
    progressMode: 'manual',
    manualProgress: Math.floor(rng() * 101),
    estimatedHours,
  };
}

/** 정확히 `total`개 Task를 깊이 1~5의 다분기 포레스트로 합성한다. */
function synthesizeForest(total: number, seed: number): ProgressNode[] {
  const rng = makeRng(seed);
  let created = 0;

  const build = (depth: number): ProgressNode => {
    const id = `perf-task-${created}`;
    created += 1;

    const children: ProgressNode[] = [];
    const range = CHILD_COUNT_RANGE[depth - 1];
    if (range) {
      const [min, max] = range;
      const want = min + Math.floor(rng() * (max - min + 1));
      for (let i = 0; i < want && created < total; i += 1) children.push(build(depth + 1));
    }

    return { task: makeTask(id, children.length > 0, rng), children };
  };

  const roots: ProgressNode[] = [];
  while (created < total) roots.push(build(1));
  return roots;
}

interface ForestStats {
  rootCount: number;
  nodeCount: number;
  leafCount: number;
  maxDepth: number;
  branchWidths: Set<number>;
  internalDepths: Set<number>;
}

function statsOf(roots: readonly ProgressNode[]): ForestStats {
  const stats: ForestStats = {
    rootCount: roots.length,
    nodeCount: 0,
    leafCount: 0,
    maxDepth: 0,
    branchWidths: new Set(),
    internalDepths: new Set(),
  };

  const walk = (node: ProgressNode, depth: number): void => {
    stats.nodeCount += 1;
    stats.maxDepth = Math.max(stats.maxDepth, depth);
    if (node.children.length === 0) {
      stats.leafCount += 1;
    } else {
      stats.branchWidths.add(node.children.length);
      stats.internalDepths.add(depth);
    }
    for (const child of node.children) walk(child, depth + 1);
  };

  for (const root of roots) walk(root, 1);
  return stats;
}

function median(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

const forest = synthesizeForest(TASK_COUNT, 20260807);
const stats = statsOf(forest);

describe('§12 계산 성능 — 5,000 노드 4단계 롤업', () => {
  it('합성 데이터가 §12 규모(작업 5,000)이고 깊이 4~5의 다분기 트리다', () => {
    expect(stats.nodeCount).toBe(TASK_COUNT);
    expect(stats.maxDepth).toBeGreaterThanOrEqual(4);
    expect(stats.maxDepth).toBe(SYNTH_MAX_DEPTH);
    expect(SYNTH_MAX_DEPTH).toBeLessThanOrEqual(MAX_TASK_DEPTH); // H-3 범위 안의 현실적 트리

    // 전부 리프도, 전부 일렬도 아니어야 롤업을 재는 의미가 있다
    expect(stats.leafCount).toBeLessThan(stats.nodeCount);
    expect(stats.leafCount).toBeGreaterThan(stats.nodeCount / 2);
    expect(stats.internalDepths.size).toBeGreaterThanOrEqual(3); // 여러 깊이에 부모가 있다
    expect(stats.branchWidths.size).toBeGreaterThanOrEqual(3); // 분기 폭이 섞여 있다
    expect(stats.rootCount).toBeGreaterThan(1);
  });

  it('computeProgressMap이 5,000개를 전부 계산한다 (측정이 빈 계산이 아님을 보장)', () => {
    const map = computeProgressMap(forest);

    // 시간만 재고 계산이 비어 있었는지 모르는 상태를 막는 단언이다
    expect(map.size).toBe(TASK_COUNT);
    for (const progress of map.values()) {
      expect(Number.isFinite(progress)).toBe(true);
      expect(progress).toBeGreaterThanOrEqual(0);
      expect(progress).toBeLessThanOrEqual(100);
    }
    // 루트 값이 단일 계산 경로와 일치하는지 교차 확인 (맵이 채워지기만 한 게 아니다)
    expect(map.get(forest[0]!.task.id)).toBe(computeTaskProgress(forest[0]!));
  });

  it(`중앙값 실행 시간이 ${ROLLUP_BUDGET_MS}ms 이내다`, () => {
    for (let i = 0; i < WARMUP_RUNS; i += 1) computeProgressMap(forest); // JIT 워밍업

    const samples: number[] = [];
    for (let i = 0; i < MEASURED_RUNS; i += 1) {
      const start = performance.now();
      const map = computeProgressMap(forest);
      samples.push(performance.now() - start);
      // 최적화로 호출이 통째로 사라지지 않게 결과를 실제로 읽는다
      expect(map.size).toBe(TASK_COUNT);
    }

    const med = median(samples);
    const fixed = (n: number): string => n.toFixed(2);
    // 통과해도 남긴다 — 회귀를 눈으로 보기 위한 §12 검증표의 "통과 로그"
    process.stderr.write(
      `\n[§12 계산 성능] computeProgressMap: 노드 ${stats.nodeCount} (루트 ${stats.rootCount}, ` +
        `최대 깊이 ${stats.maxDepth}, 리프 ${stats.leafCount}) — ` +
        `중앙값 ${fixed(med)}ms / 최소 ${fixed(Math.min(...samples))}ms / ` +
        `최대 ${fixed(Math.max(...samples))}ms (${MEASURED_RUNS}회, 임계 ${ROLLUP_BUDGET_MS}ms)\n`
    );

    expect(med).toBeLessThanOrEqual(ROLLUP_BUDGET_MS);
  });
});
