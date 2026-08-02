// WBS 트리 순수 함수 테스트 (SOT §6.6 H-1~H-3, §6.7, §6.1.1 P-14~P-16, 부록 B.1)
// 트리 코드·깊이·순환 판정이 틀리면 그 위의 진척률·간트가 전부 틀린다.

import { describe, expect, it } from 'vitest';
import { MAX_TASK_DEPTH } from '@/lib/constants';
import {
  buildTaskTree,
  canMoveTask,
  flattenTree,
  getDescendantIds,
  subtreeHeight,
  wouldCreateCycle,
} from '@/lib/tree';
import type { Task } from '@/types';

const YEAR_1 = 'year-1';
const YEAR_2 = 'year-2';

function makeTask(patch: Partial<Task> & Pick<Task, 'id'>): Task {
  return {
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    version: 1,
    createdBy: null,
    updatedBy: null,
    projectId: 'project-1',
    yearId: YEAR_1,
    parentId: null,
    order: 0,
    title: patch.id,
    description: '',
    status: 'todo',
    progressMode: 'manual',
    manualProgress: 0,
    estimatedHours: null,
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
    ...patch,
  };
}

// 깊이 n의 단일 체인 (r1 → r2 → … → rn). H-3 검증용
function makeChain(depth: number, yearId = YEAR_1): Task[] {
  return Array.from({ length: depth }, (_, i) =>
    makeTask({
      id: `c${i + 1}`,
      yearId,
      parentId: i === 0 ? null : `c${i}`,
      order: 0,
    })
  );
}

describe('buildTaskTree — WBS 코드 (§6.7)', () => {
  const tasks = [
    makeTask({ id: 'r1', order: 0 }),
    makeTask({ id: 'r1-a', parentId: 'r1', order: 0 }),
    makeTask({ id: 'r1-b', parentId: 'r1', order: 1 }),
    makeTask({ id: 'r2', order: 1 }),
    makeTask({ id: 'r3', order: 2 }),
  ];

  it('루트는 1부터, 자식은 부모코드.n 으로 매긴다', () => {
    const { roots, invalid } = buildTaskTree(tasks);
    expect(invalid).toEqual([]);
    expect(flattenTree(roots).map((n) => n.wbsCode)).toEqual(['1', '1.1', '1.2', '2', '3']);
  });

  it('yearPrefix를 주면 전체 연차 보기용 접두를 붙인다 — 1차-1.2', () => {
    const { roots } = buildTaskTree(tasks, { yearPrefix: '1차-' });
    const codes = flattenTree(roots).map((n) => n.wbsCode);
    expect(codes).toEqual(['1차-1', '1차-1.1', '1차-1.2', '1차-2', '1차-3']);
  });

  it('depth는 루트 1 기준이고 isLeaf가 자식 유무를 반영한다 (H-3)', () => {
    const { roots } = buildTaskTree(tasks);
    expect(roots[0]!.depth).toBe(1);
    expect(roots[0]!.isLeaf).toBe(false);
    expect(roots[0]!.children[0]!.depth).toBe(2);
    expect(roots[0]!.children[0]!.isLeaf).toBe(true);
  });

  it('형제 정렬은 order 오름차순, 동률이면 id 사전순으로 결정론적이다', () => {
    const shuffled = [
      makeTask({ id: 'b', order: 1 }),
      makeTask({ id: 'z', order: 0 }),
      makeTask({ id: 'a', order: 1 }),
    ];
    const { roots } = buildTaskTree(shuffled);
    expect(roots.map((n) => n.task.id)).toEqual(['z', 'a', 'b']);
  });
});

describe('buildTaskTree — 편입 불가 Task는 조용히 버리지 않는다 (H-1, 절대 규칙 5)', () => {
  it('부모가 입력에 없으면 invalid로 돌려준다', () => {
    const orphan = makeTask({ id: 'orphan', parentId: 'ghost' });
    const { roots, invalid } = buildTaskTree([makeTask({ id: 'r1' }), orphan]);
    expect(roots).toHaveLength(1);
    expect(invalid.map((t) => t.id)).toEqual(['orphan']);
  });

  it('부모와 yearId가 다르면 invalid로 돌려준다 (H-1 위반)', () => {
    const crossYear = makeTask({ id: 'x', yearId: YEAR_2, parentId: 'r1' });
    const { roots, invalid } = buildTaskTree([makeTask({ id: 'r1' }), crossYear]);
    expect(roots[0]!.children).toEqual([]);
    expect(invalid.map((t) => t.id)).toEqual(['x']);
  });

  it('편입 불가 노드의 자손도 invalid에 포함된다 — 입력 = 트리 ∪ invalid', () => {
    const tasks = [
      makeTask({ id: 'r1' }),
      makeTask({ id: 'x', yearId: YEAR_2, parentId: 'r1' }),
      makeTask({ id: 'x-child', yearId: YEAR_2, parentId: 'x' }),
    ];
    const { roots, invalid } = buildTaskTree(tasks);
    expect(invalid.map((t) => t.id)).toEqual(['x', 'x-child']);
    expect(flattenTree(roots).length + invalid.length).toBe(tasks.length);
  });

  it('입력 데이터가 순환이면 그 노드들은 루트에 닿지 못하므로 invalid다', () => {
    const tasks = [
      makeTask({ id: 'a', parentId: 'b' }),
      makeTask({ id: 'b', parentId: 'a' }),
    ];
    const { roots, invalid } = buildTaskTree(tasks);
    expect(roots).toEqual([]);
    expect(invalid.map((t) => t.id)).toEqual(['a', 'b']);
  });
});

describe('flattenTree / getDescendantIds / subtreeHeight', () => {
  const tasks = [
    makeTask({ id: 'r1', order: 0 }),
    makeTask({ id: 'a', parentId: 'r1', order: 0 }),
    makeTask({ id: 'a1', parentId: 'a', order: 0 }),
    makeTask({ id: 'b', parentId: 'r1', order: 1 }),
    makeTask({ id: 'r2', order: 1 }),
  ];
  const { roots } = buildTaskTree(tasks);

  it('pre-order 표시 순서를 돌려준다', () => {
    expect(flattenTree(roots).map((n) => n.task.id)).toEqual(['r1', 'a', 'a1', 'b', 'r2']);
  });

  it('접힌 노드 자신은 남고 자손만 빠진다', () => {
    const visible = flattenTree(roots, new Set(['a'])).map((n) => n.task.id);
    expect(visible).toEqual(['r1', 'a', 'b', 'r2']);
  });

  it('루트를 접으면 그 서브트리 전체가 빠진다', () => {
    expect(flattenTree(roots, new Set(['r1'])).map((n) => n.task.id)).toEqual(['r1', 'r2']);
  });

  it('getDescendantIds는 자기 자신을 제외한 자손 전부 (H-4 삭제 개수 확인용)', () => {
    expect(getDescendantIds(roots[0]!)).toEqual(['a', 'a1', 'b']);
    expect(getDescendantIds(roots[1]!)).toEqual([]);
  });

  it('subtreeHeight는 자기 자신을 포함해 1 이상', () => {
    expect(subtreeHeight(roots[0]!)).toBe(3);
    expect(subtreeHeight(roots[1]!)).toBe(1);
  });
});

describe('날짜 롤업 (§6.1.1 P-14~P-16)', () => {
  it('P-14/P-15: 부모 날짜가 null이면 자식 범위를 그대로 물려받는다', () => {
    const tasks = [
      makeTask({ id: 'p' }),
      makeTask({ id: 'c1', parentId: 'p', order: 0, startDate: '2026-03-01', dueDate: '2026-04-30' }),
      makeTask({ id: 'c2', parentId: 'p', order: 1, startDate: '2026-04-01', dueDate: '2026-05-31' }),
    ];
    const { roots } = buildTaskTree(tasks);
    expect(roots[0]!.rolledUpStartDate).toBe('2026-03-01');
    expect(roots[0]!.rolledUpDueDate).toBe('2026-05-31');
  });

  it('부모 값이 자식보다 넓으면 부모 값을 유지한다', () => {
    const tasks = [
      makeTask({ id: 'p', startDate: '2026-01-01', dueDate: '2026-12-31' }),
      makeTask({ id: 'c1', parentId: 'p', startDate: '2026-03-01', dueDate: '2026-05-31' }),
    ];
    const { roots } = buildTaskTree(tasks);
    expect(roots[0]!.rolledUpStartDate).toBe('2026-01-01');
    expect(roots[0]!.rolledUpDueDate).toBe('2026-12-31');
  });

  it('손자까지 올라오고, 한쪽만 null인 자식은 비교에서 제외된다', () => {
    const tasks = [
      makeTask({ id: 'p' }),
      makeTask({ id: 'c', parentId: 'p', startDate: null, dueDate: '2026-06-30' }),
      makeTask({ id: 'g', parentId: 'c', startDate: '2026-02-01', dueDate: null }),
    ];
    const { roots } = buildTaskTree(tasks);
    expect(roots[0]!.rolledUpStartDate).toBe('2026-02-01');
    expect(roots[0]!.rolledUpDueDate).toBe('2026-06-30');
  });

  it('P-16: 자기 값과 자식 값이 전부 null이면 결과도 null (간트에 그리지 않는다)', () => {
    const tasks = [makeTask({ id: 'p' }), makeTask({ id: 'c', parentId: 'p' })];
    const { roots } = buildTaskTree(tasks);
    expect(roots[0]!.rolledUpStartDate).toBeNull();
    expect(roots[0]!.rolledUpDueDate).toBeNull();
  });
});

describe('wouldCreateCycle (H-2)', () => {
  const tasks = makeChain(3); // c1 → c2 → c3

  it('자기 자신을 부모로 지정할 수 없다', () => {
    expect(wouldCreateCycle(tasks, 'c1', 'c1')).toBe(true);
  });

  it('자손을 부모로 지정할 수 없다', () => {
    expect(wouldCreateCycle(tasks, 'c1', 'c3')).toBe(true);
  });

  it('루트로 올리는 이동(null)과 형제 이동은 순환이 아니다', () => {
    expect(wouldCreateCycle(tasks, 'c3', null)).toBe(false);
    expect(wouldCreateCycle(tasks, 'c3', 'c1')).toBe(false);
  });
});

describe('canMoveTask (H-1, H-2, H-3)', () => {
  // 깊이 10 체인 (루트 = 깊이 1, MAX_TASK_DEPTH = 10)
  const chain = makeChain(MAX_TASK_DEPTH);

  it('MAX_TASK_DEPTH는 lib/constants.ts 값 10이다', () => {
    expect(MAX_TASK_DEPTH).toBe(10);
  });

  it('(a) 루트를 자기 자손 아래로 옮기면 CYCLE', () => {
    expect(canMoveTask(chain, 'c1', 'c5')).toEqual({ ok: false, reason: 'CYCLE' });
  });

  it('(b) 깊이 10 리프 아래로 다른 노드를 옮기면 DEPTH', () => {
    const tasks = [...chain, makeTask({ id: 'loose', order: 1 })];
    expect(canMoveTask(tasks, 'loose', `c${MAX_TASK_DEPTH}`)).toEqual({
      ok: false,
      reason: 'DEPTH',
    });
  });

  it('(c) 다른 연차의 부모로 옮기면 CROSS_YEAR', () => {
    const tasks = [...chain, makeTask({ id: 'other', yearId: YEAR_2 })];
    expect(canMoveTask(tasks, 'c3', 'other')).toEqual({ ok: false, reason: 'CROSS_YEAR' });
  });

  it('대상 또는 새 부모가 없으면 NOT_FOUND', () => {
    expect(canMoveTask(chain, 'ghost', null)).toEqual({ ok: false, reason: 'NOT_FOUND' });
    expect(canMoveTask(chain, 'c1', 'ghost')).toEqual({ ok: false, reason: 'NOT_FOUND' });
  });

  it('깊이 = 부모 깊이 + 서브트리 높이. 정확히 10이면 허용, 11이면 거절', () => {
    // c9(깊이 9) 아래에 높이 1짜리를 넣으면 10 → 허용
    const tasks = [...chain, makeTask({ id: 'loose', order: 1 })];
    expect(canMoveTask(tasks, 'loose', 'c9')).toEqual({ ok: true });
    expect(canMoveTask(tasks, 'loose', 'c10')).toEqual({ ok: false, reason: 'DEPTH' });
  });

  it('서브트리 높이를 포함해 판정한다 — 자손이 딸린 노드는 더 얕은 곳까지만 들어간다', () => {
    // 별도 루트 s1 → s2 (높이 2). 깊이 9 아래로는 못 들어가고 깊이 8 아래는 된다
    const tasks = [
      ...chain,
      makeTask({ id: 's1', order: 1 }),
      makeTask({ id: 's2', parentId: 's1' }),
    ];
    expect(canMoveTask(tasks, 's1', 'c9')).toEqual({ ok: false, reason: 'DEPTH' });
    expect(canMoveTask(tasks, 's1', 'c8')).toEqual({ ok: true });
  });

  it('루트로 올리는 이동은 부모 깊이 0으로 계산한다', () => {
    expect(canMoveTask(chain, 'c2', null)).toEqual({ ok: true });
  });
});

describe('부록 B.1 시드 구조 — 트리 형태', () => {
  // supabase/seed.sql과 동일한 7 Task (진척률은 progress.test.ts에서 검증)
  const tasks: Task[] = [
    makeTask({ id: 't31', yearId: YEAR_1, order: 0, title: '요구사항 분석', status: 'done', progressMode: 'auto', estimatedHours: 40 }),
    makeTask({ id: 't32', yearId: YEAR_1, parentId: 't31', order: 0, title: '문헌조사', status: 'done', manualProgress: 100, estimatedHours: 16 }),
    makeTask({ id: 't33', yearId: YEAR_1, parentId: 't31', order: 1, title: '요구사항 정의', status: 'done', manualProgress: 100, estimatedHours: 24 }),
    makeTask({ id: 't34', yearId: YEAR_2, order: 0, title: '모델 개발', status: 'in_progress', progressMode: 'auto', estimatedHours: 100 }),
    makeTask({ id: 't35', yearId: YEAR_2, parentId: 't34', order: 0, title: '데이터 구축', status: 'in_progress', manualProgress: 100, estimatedHours: 40 }),
    makeTask({ id: 't36', yearId: YEAR_2, parentId: 't34', order: 1, title: '학습·튜닝', status: 'in_progress', manualProgress: 30, estimatedHours: 60 }),
    makeTask({ id: 't37', yearId: YEAR_2, order: 1, title: '시스템 통합', status: 'todo', manualProgress: 0, estimatedHours: 50 }),
  ];

  it('WBS 코드는 연차마다 1부터 다시 시작한다 (§6.7)', () => {
    const y1 = buildTaskTree(tasks.filter((t) => t.yearId === YEAR_1));
    const y2 = buildTaskTree(tasks.filter((t) => t.yearId === YEAR_2));
    expect(y1.invalid).toEqual([]);
    expect(y2.invalid).toEqual([]);
    expect(flattenTree(y1.roots).map((n) => `${n.wbsCode} ${n.task.title}`)).toEqual([
      '1 요구사항 분석',
      '1.1 문헌조사',
      '1.2 요구사항 정의',
    ]);
    expect(flattenTree(y2.roots).map((n) => `${n.wbsCode} ${n.task.title}`)).toEqual([
      '1 모델 개발',
      '1.1 데이터 구축',
      '1.2 학습·튜닝',
      '2 시스템 통합',
    ]);
  });

  it('두 연차를 한 번에 넣어도 H-1 위반 없이 각 연차 루트가 살아 있다', () => {
    const { roots, invalid } = buildTaskTree(tasks);
    expect(invalid).toEqual([]);
    expect(roots.map((n) => n.task.title)).toEqual(['요구사항 분석', '모델 개발', '시스템 통합']);
  });
});
