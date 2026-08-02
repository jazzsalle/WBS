// Task 트리 RPC 통합 테스트 — move_task / move_task_to_year / reorder_tasks
// SOT §6.6 H-1·H-2·H-3·H-10·H-11·H-12, §8.3 X-3·X-4
//
// 규칙 검사는 DB 안에서 돌아야 한다(X-4). 따라서 리포지토리를 publishable 키 + 실제 세션
// (RLS 경로)으로 호출해 실제 dev DB의 함수를 태운다. 직결 SQL은 사용자 생성·정리 전용이다.
// 연차를 규칙별로 분리해 테스트 간 순서 간섭을 없앤다.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Sql } from 'postgres';
import { connectDirectDb, createTestUser, destroyTestUser, type TestUser } from './helpers';
import * as projects from '@/lib/db/projects';
import * as stages from '@/lib/db/stages';
import * as years from '@/lib/db/years';
import * as tasks from '@/lib/db/tasks';
import { RuleViolationError } from '@/lib/db/errors';
import type { Task } from '@/types';

let sql: Sql;
let user: TestUser;
const tempProjectIds: string[] = []; // afterAll 안전망 — 테스트 실패 시에도 직결 SQL로 지운다

let projectId: string;
let yearCycle: string;   // 순환(H-2) + 깊이(H-3)
let yearOrder: string;   // 삽입 위치·normalize (H-12, H-10)
let yearFrom: string;    // 연차 이동 출발 (H-11)
let yearTo: string;      // 연차 이동 도착 (H-11)
let yearMisc: string;    // 다른 연차 부모 지정(H-1) + 재정렬(X-3)
let otherYearId: string; // 다른 과제의 연차 (H-11 거부)

async function mk(
  pid: string,
  yearId: string,
  title: string,
  parentId: string | null,
  order: number
): Promise<Task> {
  return tasks.createTask(user.client, {
    projectId: pid,
    yearId,
    parentId,
    title,
    order,
    createdBy: user.id,
    updatedBy: user.id,
  });
}

// 한 컨테이너(yearId, parentId)의 자식을 order 순으로
async function childrenOf(yearId: string, parentId: string | null): Promise<Task[]> {
  const list = await tasks.listTasksByYear(user.client, yearId);
  return list.filter((t) => t.parentId === parentId).sort((a, b) => a.order - b.order);
}

beforeAll(async () => {
  sql = connectDirectDb();
  user = await createTestUser(sql);

  const project = await projects.createProject(user.client, {
    name: '트리 RPC 검증',
    createdBy: user.id,
    updatedBy: user.id,
  });
  projectId = project.id;
  tempProjectIds.push(projectId);

  const stage = await stages.createStage(user.client, {
    projectId,
    name: '1단계',
    createdBy: user.id,
    updatedBy: user.id,
  });
  const created: string[] = [];
  for (const name of ['1차년도', '2차년도', '3차년도', '4차년도', '5차년도']) {
    const year = await years.createYear(user.client, { stageId: stage.id, name });
    created.push(year.id);
  }
  [yearCycle, yearOrder, yearFrom, yearTo, yearMisc] = created as [
    string, string, string, string, string,
  ];

  const other = await projects.createProject(user.client, {
    name: '남의 과제',
    createdBy: user.id,
    updatedBy: user.id,
  });
  tempProjectIds.push(other.id);
  const otherStage = await stages.createStage(user.client, {
    projectId: other.id,
    name: '1단계',
    createdBy: user.id,
    updatedBy: user.id,
  });
  otherYearId = (await years.createYear(user.client, { stageId: otherStage.id, name: '1차년도' })).id;
});

afterAll(async () => {
  for (const id of tempProjectIds) {
    await sql`delete from public.projects where id = ${id}::uuid`;
  }
  await destroyTestUser(sql, user);
  await sql.end();
});

describe('move_task — 순환·깊이·연차 검사 (X-4)', () => {
  it('H-2: 자기 자신·자식·손자를 부모로 지정하면 거부된다', async () => {
    const root = await mk(projectId, yearCycle, '순환 루트', null, 0);
    const child = await mk(projectId, yearCycle, '자식', root.id, 0);
    const grand = await mk(projectId, yearCycle, '손자', child.id, 0);

    await expect(tasks.moveTask(user.client, root.id, root.id, 0)).rejects.toBeInstanceOf(
      RuleViolationError
    );
    await expect(tasks.moveTask(user.client, root.id, child.id, 0)).rejects.toBeInstanceOf(
      RuleViolationError
    );
    await expect(tasks.moveTask(user.client, root.id, grand.id, 0)).rejects.toBeInstanceOf(
      RuleViolationError
    );

    // 거부됐으면 트리는 그대로여야 한다 (부분 반영 없음)
    const after = await tasks.getTaskById(user.client, root.id);
    expect(after.parentId).toBeNull();
    expect((await tasks.getTaskById(user.client, child.id)).parentId).toBe(root.id);
  });

  it('H-3: 루트=깊이 1 기준 최대 10단계까지만 허용된다', async () => {
    const chain: string[] = [];
    let parent: string | null = null;
    for (let depth = 1; depth <= 10; depth += 1) {
      const node = await mk(projectId, yearCycle, `깊이${depth}`, parent, 0);
      chain.push(node.id);
      parent = node.id;
    }

    // 높이 1 노드를 깊이 9 아래로 → 깊이 10. 경계는 통과한다
    const single = await mk(projectId, yearCycle, '단독', null, 5);
    const moved = await tasks.moveTask(user.client, single.id, chain[8]!, 0);
    expect(moved.parentId).toBe(chain[8]);

    // 깊이 10 아래로 → 11단계. 거부
    await expect(tasks.moveTask(user.client, single.id, chain[9]!, 0)).rejects.toBeInstanceOf(
      RuleViolationError
    );

    // 서브트리 높이도 함께 센다: 높이 2를 깊이 9 아래에 붙이면 11단계
    const subRoot = await mk(projectId, yearCycle, '서브루트', null, 6);
    await mk(projectId, yearCycle, '서브자식', subRoot.id, 0);
    await expect(tasks.moveTask(user.client, subRoot.id, chain[8]!, 0)).rejects.toBeInstanceOf(
      RuleViolationError
    );
    // 깊이 8 아래면 9·10단계 — 통과
    const ok = await tasks.moveTask(user.client, subRoot.id, chain[7]!, 0);
    expect(ok.parentId).toBe(chain[7]);
  });

  it('H-1: 다른 연차의 작업을 부모로 지정하면 거부된다', async () => {
    const mine = await mk(projectId, yearCycle, '이 연차 작업', null, 7);
    const otherYearTask = await mk(projectId, yearMisc, '다른 연차 작업', null, 0);

    await expect(
      tasks.moveTask(user.client, mine.id, otherYearTask.id, 0)
    ).rejects.toBeInstanceOf(RuleViolationError);
    expect((await tasks.getTaskById(user.client, mine.id)).parentId).toBeNull();
  });
});

describe('move_task — 삽입 위치와 normalize (H-12, H-10)', () => {
  it('newIndex는 대상 제거 후 배열 기준이고, 양쪽 그룹이 0..n-1로 normalize된다', async () => {
    const parent = await mk(projectId, yearOrder, '부모', null, 0);
    const a = await mk(projectId, yearOrder, 'A', parent.id, 0);
    await mk(projectId, yearOrder, 'B', parent.id, 1);
    await mk(projectId, yearOrder, 'C', parent.id, 2);

    // A를 제거하면 [B, C] — index 2는 맨 뒤
    await tasks.moveTask(user.client, a.id, parent.id, 2);
    let kids = await childrenOf(yearOrder, parent.id);
    expect(kids.map((k) => k.title)).toEqual(['B', 'C', 'A']);
    expect(kids.map((k) => k.order)).toEqual([0, 1, 2]);

    // 범위를 벗어난 index는 양 끝으로 clamp
    await tasks.moveTask(user.client, a.id, parent.id, 99);
    kids = await childrenOf(yearOrder, parent.id);
    expect(kids.map((k) => k.title)).toEqual(['B', 'C', 'A']);
    await tasks.moveTask(user.client, a.id, parent.id, -5);
    kids = await childrenOf(yearOrder, parent.id);
    expect(kids.map((k) => k.title)).toEqual(['A', 'B', 'C']);
    expect(kids.map((k) => k.order)).toEqual([0, 1, 2]);

    // 루트로 빼면 구 부모 그룹(B, C)과 새 그룹(루트)이 모두 normalize된다
    const movedOut = await tasks.moveTask(user.client, a.id, null, 0);
    expect(movedOut.parentId).toBeNull();
    kids = await childrenOf(yearOrder, parent.id);
    expect(kids.map((k) => k.title)).toEqual(['B', 'C']);
    expect(kids.map((k) => k.order)).toEqual([0, 1]);
    const roots = await childrenOf(yearOrder, null);
    expect(roots.map((r) => r.title)).toEqual(['A', '부모']);
    expect(roots.map((r) => r.order)).toEqual([0, 1]);
  });
});

describe('move_task_to_year (H-11)', () => {
  it('자손 전체가 함께 이동하고 대상은 새 연차의 루트 말단이 된다', async () => {
    await mk(projectId, yearFrom, '앞 루트', null, 0);
    const target = await mk(projectId, yearFrom, '이동 대상', null, 1);
    await mk(projectId, yearFrom, '뒤 루트', null, 2);
    const child1 = await mk(projectId, yearFrom, '자식1', target.id, 0);
    const child2 = await mk(projectId, yearFrom, '자식2', target.id, 1);
    const grand = await mk(projectId, yearFrom, '손자', child2.id, 0);

    await mk(projectId, yearTo, '기존 루트1', null, 0);
    await mk(projectId, yearTo, '기존 루트2', null, 1);

    const moved = await tasks.moveTaskToYear(user.client, target.id, yearTo);
    expect(moved.yearId).toBe(yearTo);
    expect(moved.parentId).toBeNull();
    expect(moved.order).toBe(2); // 새 연차 루트 말단 (max+1)

    // 자손 전부 새 연차로, 부모-자식 관계는 보존
    const inTo = new Map((await tasks.listTasksByYear(user.client, yearTo)).map((t) => [t.id, t]));
    expect(inTo.get(child1.id)?.parentId).toBe(target.id);
    expect(inTo.get(child2.id)?.parentId).toBe(target.id);
    expect(inTo.get(grand.id)?.parentId).toBe(child2.id);
    expect(inTo.get(child1.id)?.order).toBe(0);
    expect(inTo.get(child2.id)?.order).toBe(1);

    // 구 연차에는 자손이 하나도 남지 않고, 루트 그룹은 normalize된다 (H-10)
    const leftBehind = await tasks.listTasksByYear(user.client, yearFrom);
    expect(leftBehind.map((t) => t.title).sort()).toEqual(['뒤 루트', '앞 루트']);
    const fromRoots = await childrenOf(yearFrom, null);
    expect(fromRoots.map((t) => t.title)).toEqual(['앞 루트', '뒤 루트']);
    expect(fromRoots.map((t) => t.order)).toEqual([0, 1]);
  });

  it('다른 과제의 연차로 이동하면 거부된다', async () => {
    const target = await mk(projectId, yearFrom, '남의 과제로', null, 5);
    await expect(
      tasks.moveTaskToYear(user.client, target.id, otherYearId)
    ).rejects.toBeInstanceOf(RuleViolationError);
    expect((await tasks.getTaskById(user.client, target.id)).yearId).toBe(yearFrom);
  });
});

describe('reorder_tasks (H-10, X-3)', () => {
  it('자식 집합과 다른 배열은 거부하고, 일치하면 0..n-1로 일괄 갱신한다', async () => {
    const parent = await mk(projectId, yearMisc, 'R부모', null, 1);
    const a = await mk(projectId, yearMisc, 'RA', parent.id, 0);
    const b = await mk(projectId, yearMisc, 'RB', parent.id, 1);
    const c = await mk(projectId, yearMisc, 'RC', parent.id, 2);

    // 누락 / 초과(다른 그룹 id 포함) / 중복 — 전부 거부
    await expect(
      tasks.reorderTasks(user.client, yearMisc, parent.id, [c.id, a.id])
    ).rejects.toBeInstanceOf(RuleViolationError);
    await expect(
      tasks.reorderTasks(user.client, yearMisc, parent.id, [c.id, b.id, a.id, parent.id])
    ).rejects.toBeInstanceOf(RuleViolationError);
    await expect(
      tasks.reorderTasks(user.client, yearMisc, parent.id, [a.id, a.id, b.id])
    ).rejects.toBeInstanceOf(RuleViolationError);

    // 거부 후에도 순서 그대로 — 조용한 부분 반영이 없다
    expect((await childrenOf(yearMisc, parent.id)).map((k) => k.title)).toEqual([
      'RA',
      'RB',
      'RC',
    ]);

    await tasks.reorderTasks(user.client, yearMisc, parent.id, [c.id, a.id, b.id]);
    const kids = await childrenOf(yearMisc, parent.id);
    expect(kids.map((k) => k.title)).toEqual(['RC', 'RA', 'RB']);
    expect(kids.map((k) => k.order)).toEqual([0, 1, 2]);
  });

  it('루트 컨테이너(parentId = null)도 재정렬된다', async () => {
    const roots = await childrenOf(yearMisc, null);
    expect(roots.length).toBeGreaterThan(1);
    const reversed = [...roots].reverse();

    await tasks.reorderTasks(
      user.client,
      yearMisc,
      null,
      reversed.map((r) => r.id)
    );
    const after = await childrenOf(yearMisc, null);
    expect(after.map((r) => r.id)).toEqual(reversed.map((r) => r.id));
    expect(after.map((r) => r.order)).toEqual(after.map((_, i) => i));
  });
});
