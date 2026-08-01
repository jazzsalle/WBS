// 낙관적 잠금 통합 테스트 — version 조건 갱신 (SOT §8.4, N-5, O-1~O-3)
// stale version으로 갱신하면 0행 갱신 → StaleDataError, version은 BEFORE UPDATE 트리거가 +1.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Sql } from 'postgres';
import { connectDirectDb, createTestUser, destroyTestUser, type TestUser } from './helpers';
import * as projects from '@/lib/db/projects';
import * as stages from '@/lib/db/stages';
import * as years from '@/lib/db/years';
import * as tasks from '@/lib/db/tasks';
import * as budgetItems from '@/lib/db/budget-items';
import { NotFoundError, StaleDataError } from '@/lib/db/errors';

let sql: Sql;
let user: TestUser;
let projectId: string;
let yearId: string;

beforeAll(async () => {
  sql = connectDirectDb();
  user = await createTestUser(sql);
  const project = await projects.createProject(user.client, {
    name: '낙관적 잠금 테스트 과제',
    createdBy: user.id,
    updatedBy: user.id,
  });
  projectId = project.id;
  const stage = await stages.createStage(user.client, { projectId, name: '1단계' });
  const year = await years.createYear(user.client, { stageId: stage.id, name: '1차년도' });
  yearId = year.id;
});

afterAll(async () => {
  await sql`delete from public.projects where id = ${projectId}::uuid`;
  await destroyTestUser(sql, user);
  await sql.end();
});

describe('projects: version 조건 갱신', () => {
  it('BEFORE UPDATE 트리거가 version을 +1 하고, stale version은 StaleDataError', async () => {
    const created = await projects.createProject(user.client, {
      name: '충돌 대상',
      createdBy: user.id,
      updatedBy: user.id,
    });
    expect(created.version).toBe(1);

    // 정상 경로: 읽은 version(1)으로 갱신 → 성공, version 2
    const first = await projects.updateProject(
      user.client,
      created.id,
      { name: '첫 번째 수정', updatedBy: user.id },
      1
    );
    expect(first.version).toBe(2);

    // 충돌 경로: 같은 version(1)으로 다시 갱신 → 0행 갱신 → StaleDataError
    const stale = await projects
      .updateProject(user.client, created.id, { name: '두 번째 수정', updatedBy: user.id }, 1)
      .then(
        () => null,
        (e: unknown) => e
      );
    expect(stale).toBeInstanceOf(StaleDataError);
    // O-3: 먼저 수정한 사람(updated_by)을 담아 "OO님이 먼저 수정했습니다"를 띄울 수 있어야 한다
    expect((stale as StaleDataError).updatedBy).toBe(user.id);

    // 충돌은 데이터를 바꾸지 않는다 — 첫 번째 수정 내용이 유지된다
    const after = await projects.getProjectById(user.client, created.id);
    expect(after.name).toBe('첫 번째 수정');
    expect(after.version).toBe(2);

    // 최신 version으로는 다시 성공한다
    const second = await projects.updateProject(
      user.client,
      created.id,
      { name: '세 번째 수정', updatedBy: user.id },
      2
    );
    expect(second.version).toBe(3);

    await projects.deleteProject(user.client, created.id);
  });

  it('없는 행 + expectedVersion은 NotFoundError로 구분된다', async () => {
    await expect(
      projects.updateProject(
        user.client,
        '00000000-0000-4000-8000-999999999999',
        { name: 'x', updatedBy: user.id },
        1
      )
    ).rejects.toBeInstanceOf(NotFoundError);
  });
});

describe('tasks: version 조건 갱신', () => {
  it('동시 편집 시나리오 — 두 세션이 같은 version으로 저장하면 늦은 쪽이 진다', async () => {
    const task = await tasks.createTask(user.client, {
      projectId,
      yearId,
      title: '동시 편집 대상',
      createdBy: user.id,
      updatedBy: user.id,
    });
    expect(task.version).toBe(1);

    // 세션 A: version 1로 저장 → 성공
    const sessionA = await tasks.updateTask(
      user.client,
      task.id,
      { description: 'A의 수정', updatedBy: user.id },
      1
    );
    expect(sessionA.version).toBe(2);

    // 세션 B: 여전히 version 1을 들고 있음 → StaleDataError
    await expect(
      tasks.updateTask(user.client, task.id, { description: 'B의 수정', updatedBy: user.id }, 1)
    ).rejects.toBeInstanceOf(StaleDataError);

    // expectedVersion 생략(O-2: 단일 필드 조작)은 마지막 저장 우선으로 성공한다
    const lastWrite = await tasks.updateTask(user.client, task.id, {
      status: 'in_progress',
      updatedBy: user.id,
    });
    expect(lastWrite.status).toBe('in_progress');
    expect(lastWrite.version).toBe(3);
  });
});

describe('budget-items: (yearId, category) 키 기반 version 조건 갱신', () => {
  it('stale version은 StaleDataError, 최신 version은 성공', async () => {
    const item = await budgetItems.updateBudgetPlan(
      user.client,
      yearId,
      'material',
      { plannedAmount: 40_000_000, updatedBy: user.id },
      1 // create_year가 만든 직후라 version 1
    );
    expect(item.version).toBe(2);

    await expect(
      budgetItems.updateBudgetPlan(
        user.client,
        yearId,
        'material',
        { plannedAmount: 43_200_000, updatedBy: user.id },
        1
      )
    ).rejects.toBeInstanceOf(StaleDataError);

    const retried = await budgetItems.updateBudgetPlan(
      user.client,
      yearId,
      'material',
      { plannedAmount: 43_200_000, updatedBy: user.id },
      2
    );
    expect(retried.plannedAmount).toBe(43_200_000);
    expect(retried.version).toBe(3);
  });
});
