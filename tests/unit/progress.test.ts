// 4단계 진척률 롤업 테스트 (SOT §6.1 P-1~P-13, 부록 B.1)
// 부록 B.1의 수치를 그대로 고정한다 — 숫자가 안 맞으면 구현이 틀린 것이다.

import { describe, expect, it } from 'vitest';
import {
  computeProgressMap,
  computeProjectProgress,
  computeStageProgress,
  computeTaskProgress,
  computeYearProgress,
  leafFallbackProgress,
  type ProgressNode,
} from '@/lib/progress';
import { buildTaskTree } from '@/lib/tree';
import type { Task, TaskStatus } from '@/types';

interface NodeSpec {
  id: string;
  status?: TaskStatus;
  progressMode?: 'manual' | 'auto';
  manualProgress?: number;
  estimatedHours?: number | null;
  children?: NodeSpec[];
}

function node(spec: NodeSpec): ProgressNode {
  return {
    task: {
      id: spec.id,
      status: spec.status ?? 'todo',
      progressMode: spec.progressMode ?? 'manual',
      manualProgress: spec.manualProgress ?? 0,
      estimatedHours: spec.estimatedHours ?? null,
    },
    children: (spec.children ?? []).map(node),
  };
}

// ─── 부록 B.1 픽스처 (supabase/seed.sql과 동일한 7 Task) ─────
// 1차년도: 요구사항 분석(40h) ├ 문헌조사(16h, done) └ 요구사항 정의(24h, done)
// 2차년도: 모델 개발(100h) ├ 데이터 구축(40h, 100%) └ 학습·튜닝(60h, 30%), 시스템 통합(50h, 0%)

const year1Roots: ProgressNode[] = [
  node({
    id: 't31',
    status: 'done',
    progressMode: 'auto',
    estimatedHours: 40,
    children: [
      { id: 't32', status: 'done', manualProgress: 100, estimatedHours: 16 },
      { id: 't33', status: 'done', manualProgress: 100, estimatedHours: 24 },
    ],
  }),
];

const year2Roots: ProgressNode[] = [
  node({
    id: 't34',
    status: 'in_progress',
    progressMode: 'auto',
    estimatedHours: 100,
    children: [
      { id: 't35', status: 'in_progress', manualProgress: 100, estimatedHours: 40 },
      { id: 't36', status: 'in_progress', manualProgress: 30, estimatedHours: 60 },
    ],
  }),
  node({ id: 't37', status: 'todo', manualProgress: 0, estimatedHours: 50 }),
];

describe('① computeTaskProgress (P-1~P-7)', () => {
  it('P-1: 리프가 done이면 manualProgress와 무관하게 100', () => {
    expect(computeTaskProgress(node({ id: 'x', status: 'done', manualProgress: 0 }))).toBe(100);
  });

  it('P-1: done이 아닌 리프는 manualProgress 그대로', () => {
    expect(computeTaskProgress(node({ id: 'x', status: 'blocked', manualProgress: 40 }))).toBe(40);
  });

  it('P-2: manualProgress 100 → status done 전환(액션 레이어) 후에도 계산값은 100 그대로', () => {
    const before = node({ id: 'x', status: 'in_progress', manualProgress: 100 });
    const after = node({ id: 'x', status: 'done', manualProgress: 100 });
    expect(computeTaskProgress(before)).toBe(100);
    expect(computeTaskProgress(after)).toBe(100);
  });

  it('P-3: 1~99 입력 시 todo → in_progress 전환이 계산값을 바꾸지 않는다', () => {
    const todo = node({ id: 'x', status: 'todo', manualProgress: 30 });
    const inProgress = node({ id: 'x', status: 'in_progress', manualProgress: 30 });
    expect(computeTaskProgress(todo)).toBe(30);
    expect(computeTaskProgress(inProgress)).toBe(30);
  });

  it('P-4/P-5: 부모 manual은 입력값, auto 복귀 시 즉시 롤업값', () => {
    const children: NodeSpec[] = [
      { id: 'a', manualProgress: 100, estimatedHours: 1 },
      { id: 'b', manualProgress: 0, estimatedHours: 1 },
    ];
    const manual = node({ id: 'p', progressMode: 'manual', manualProgress: 80, children });
    const auto = node({ id: 'p', progressMode: 'auto', manualProgress: 80, children });
    expect(computeTaskProgress(manual)).toBe(80);
    expect(computeTaskProgress(auto)).toBe(50);
  });

  it('P-1은 리프 전용 — 자식이 있는 done 부모는 롤업값을 쓴다', () => {
    const parent = node({
      id: 'p',
      status: 'done',
      progressMode: 'auto',
      children: [{ id: 'a', manualProgress: 20, estimatedHours: 1 }],
    });
    expect(computeTaskProgress(parent)).toBe(20);
  });

  it('P-6: 자식이 생겨 auto로 전환된 노드는 자식 롤업을 따른다', () => {
    const afterP6 = node({
      id: 'p',
      progressMode: 'auto',
      manualProgress: 90, // 리프 시절 값이 남아 있어도 무시된다
      children: [{ id: 'a', manualProgress: 10, estimatedHours: 1 }],
    });
    expect(computeTaskProgress(afterP6)).toBe(10);
  });

  it('P-7: estimatedHours가 0/null인 자식은 가중치 1', () => {
    const parent = node({
      id: 'p',
      progressMode: 'auto',
      children: [
        { id: 'a', manualProgress: 100, estimatedHours: null },
        { id: 'b', manualProgress: 0, estimatedHours: 0 },
      ],
    });
    expect(computeTaskProgress(parent)).toBe(50);
  });

  it('P-11: done을 되돌려도 manualProgress는 유지되고 100 강제만 풀린다', () => {
    expect(computeTaskProgress(node({ id: 'x', status: 'todo', manualProgress: 70 }))).toBe(70);
  });

  it('3단계 중첩도 post-order로 올라온다', () => {
    const root = node({
      id: 'r',
      progressMode: 'auto',
      children: [
        {
          id: 'm',
          progressMode: 'auto',
          estimatedHours: 3,
          children: [
            { id: 'l1', status: 'done', estimatedHours: 1 },
            { id: 'l2', manualProgress: 0, estimatedHours: 2 },
          ],
        },
        { id: 'n', manualProgress: 0, estimatedHours: 1 },
      ],
    });
    // m = (100*1 + 0*2)/3 = 33.333…, r = (33.333…*3 + 0*1)/4 = 25
    // P-8대로 중간 반올림을 하지 않으므로 부동소수 오차만큼만 벌어진다
    expect(computeTaskProgress(root)).toBeCloseTo(25, 10);
  });
});

describe('computeProgressMap', () => {
  it('모든 Task의 진척률을 id로 돌려준다 (부록 B.1 2차년도)', () => {
    const map = computeProgressMap(year2Roots);
    expect(map.size).toBe(4);
    expect(map.get('t35')).toBe(100);
    expect(map.get('t36')).toBe(30);
    expect(map.get('t34')).toBe(58);
    expect(map.get('t37')).toBe(0);
  });

  it('manual 부모의 자식도 맵에 들어간다 (표시에는 필요하다)', () => {
    const roots = [
      node({
        id: 'p',
        progressMode: 'manual',
        manualProgress: 10,
        children: [{ id: 'c', status: 'done' }],
      }),
    ];
    const map = computeProgressMap(roots);
    expect(map.get('p')).toBe(10);
    expect(map.get('c')).toBe(100);
  });

  it('computeTaskProgress와 값이 일치한다', () => {
    const map = computeProgressMap(year1Roots);
    expect(map.get('t31')).toBe(computeTaskProgress(year1Roots[0]!));
  });
});

describe('② computeYearProgress', () => {
  it('Task가 없는 연차는 0 (P-13의 분모 포함 근거)', () => {
    expect(computeYearProgress([])).toBe(0);
  });

  it('루트들의 estimatedHours 가중 평균', () => {
    const roots = [
      node({ id: 'a', manualProgress: 100, estimatedHours: 100 }),
      node({ id: 'b', manualProgress: 0, estimatedHours: 300 }),
    ];
    expect(computeYearProgress(roots)).toBe(25);
  });

  it('P-7: 루트의 estimatedHours가 null이어도 가중치 1로 계산된다', () => {
    const roots = [
      node({ id: 'a', manualProgress: 100, estimatedHours: null }),
      node({ id: 'b', manualProgress: 0, estimatedHours: null }),
    ];
    expect(computeYearProgress(roots)).toBe(50);
  });
});

describe('③④ Stage / Project 진척률', () => {
  it('P-9: year.budget이 전부 null이면 budget 기준이어도 균등 폴백', () => {
    const years = [
      { progress: 100, budget: null },
      { progress: 0, budget: null },
    ];
    expect(computeStageProgress(years, 'budget')).toBe(50);
    expect(computeStageProgress(years, 'equal')).toBe(50);
  });

  it("basis가 'equal'이면 budget이 있어도 균등", () => {
    const years = [
      { progress: 100, budget: 200_000_000 },
      { progress: 0, budget: 400_000_000 },
    ];
    expect(computeStageProgress(years, 'equal')).toBe(50);
    expect(computeStageProgress(years, 'budget')).toBeCloseTo(33.3333, 4);
  });

  it('P-13: Task 없는 연차는 진척 0으로 분모에 포함된다', () => {
    const years = [
      { progress: 100, budget: 200_000_000 },
      { progress: 0, budget: 200_000_000 }, // 계획만 있는 미래 연차
    ];
    expect(computeStageProgress(years, 'budget')).toBe(50);
  });

  it('단계·연차가 없으면 0으로 떨어진다 (0으로 나누지 않는다)', () => {
    expect(computeStageProgress([], 'budget')).toBe(0);
    expect(computeProjectProgress([], 'equal')).toBe(0);
  });

  it('Project는 stage.budget으로 같은 규칙을 적용한다', () => {
    const stages = [
      { progress: 80, budget: 600_000_000 },
      { progress: 20, budget: 200_000_000 },
    ];
    expect(computeProjectProgress(stages, 'budget')).toBe(65);
    expect(computeProjectProgress(stages, 'equal')).toBe(50);
  });
});

describe('부록 B.1 — 4단계 롤업 전 구간 (P-8: 중간 반올림 금지)', () => {
  const modelDev = computeTaskProgress(year2Roots[0]!);
  const year1 = computeYearProgress(year1Roots);
  const year2 = computeYearProgress(year2Roots);
  const stage1 = computeStageProgress(
    [
      { progress: year1, budget: 200_000_000 },
      { progress: year2, budget: 400_000_000 },
    ],
    'budget'
  );
  const projectA = computeProjectProgress([{ progress: stage1, budget: 600_000_000 }], 'budget');

  it('모델 개발 = (100×40 + 30×60)/100 = 58', () => {
    expect(modelDev).toBe(58);
  });

  it('1차년도 = 100', () => {
    expect(year1).toBe(100);
  });

  it('2차년도 = 5800/150 = 38.6666…', () => {
    expect(year2).toBeCloseTo(38.6667, 4);
    expect(year2).not.toBe(38.67); // P-8: 표시용 반올림값을 계산에 쓰지 않는다
  });

  it('1단계(budget 가중 2e8/4e8) = 59.1111…', () => {
    expect(stage1).toBeCloseTo(59.1111, 4);
  });

  it('과제 A(단계 1개) = 59.1111…', () => {
    expect(projectA).toBeCloseTo(59.1111, 4);
  });

  it('P-8 회귀: 2차년도를 38.67로 반올림해 넣으면 1단계가 59.113…이 되어 정밀도 4를 통과하지 못한다', () => {
    const rounded = computeStageProgress(
      [
        { progress: 100, budget: 200_000_000 },
        { progress: 38.67, budget: 400_000_000 },
      ],
      'budget'
    );
    expect(rounded).toBeCloseTo(59.1133, 4);
    // 중간 반올림 경로는 정밀도 4에서 정답과 갈린다 — 이 갈림이 회귀 감지의 핵심이다
    expect(Math.abs(rounded - stage1)).toBeGreaterThan(0.00005);
  });
});

describe('lib/tree.ts TaskNode 호환 (P-12 포함)', () => {
  it('buildTaskTree의 TaskNode를 그대로 ProgressNode로 쓸 수 있다', () => {
    const base: Omit<Task, 'id' | 'parentId' | 'order' | 'title' | 'status' | 'estimatedHours'> = {
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
      version: 1,
      createdBy: null,
      updatedBy: null,
      projectId: 'p1',
      yearId: 'y1',
      description: '',
      progressMode: 'manual',
      manualProgress: 0,
      actualHours: null,
      startDate: null,
      dueDate: null,
      importance: 3,
      urgencyMode: 'auto',
      urgencyManual: 3,
      ownerMemberId: null,
      memberIds: [],
      orgId: null,
      deliverableIds: [],
      techTargetIds: [],
      tags: [],
    };
    const tasks: Task[] = [
      { ...base, id: 'r', parentId: null, order: 0, title: '루트', status: 'todo', progressMode: 'auto', estimatedHours: 100 },
      { ...base, id: 'a', parentId: 'r', order: 0, title: '자식1', status: 'done', estimatedHours: 40 },
      { ...base, id: 'b', parentId: 'r', order: 1, title: '자식2', status: 'todo', manualProgress: 30, estimatedHours: 60 },
    ];
    const { roots } = buildTaskTree(tasks);
    const asProgressNodes: ProgressNode[] = roots; // 구조적 대입 — 컴파일이 곧 검증이다
    expect(computeYearProgress(asProgressNodes)).toBe(58);
  });

  it('P-12: 마지막 자식이 사라진 부모는 직전 롤업값(반올림)으로 고정된다', () => {
    expect(leafFallbackProgress(38.6666666)).toBe(39);
    expect(leafFallbackProgress(58)).toBe(58);
    expect(leafFallbackProgress(0.4)).toBe(0);
  });
});
