// Task ↔ 목표 연계 서버 액션 통합 테스트 (SOT §9 linkTaskGoals, §7.4 연계 컬럼,
// §5.1 N-2 조인 테이블, §6.6 H-11)
//
// 서버 액션은 쿠키 세션(requireApprovedUser)에서 토큰을 읽으므로 next/headers를
// "실제 세션 토큰을 돌려주는 스텁"으로 바꿔 액션을 가드까지 포함해 그대로 호출한다
// (team-actions.test.ts와 같은 방식). revalidatePath는 요청 컨텍스트 밖이라 스텁한다.
//
// 검증의 핵심은 과제 경계다: task_deliverables·task_tech_targets의 FK는 "그 목표가
// 존재하는가"만 보고 "어느 과제의 목표인가"는 보지 못한다. 앱이 막지 못하면 H-11이
// 경고한 상태 — 남의 과제 목표를 가리키는 연계 — 가 조용히 저장된다.

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Sql } from 'postgres';
import { connectDirectDb, createTestUser, destroyTestUser, type TestUser } from './helpers';
import type { ActionResult } from '@/types';
import * as tasksRepo from '@/lib/db/tasks';
import * as yearsRepo from '@/lib/db/years';

const session = vi.hoisted(() => ({ accessToken: '' }));

vi.mock('next/headers', () => ({
  cookies: async () => ({ get: () => ({ value: session.accessToken }) }),
}));
vi.mock('next/cache', () => ({ revalidatePath: () => undefined }));

const goals = await import('@/actions/goals');
const { createProject } = await import('@/actions/projects');
const { bulkUpdateTasks, createTask, deleteTask, linkTaskGoals, updateTask } = await import(
  '@/actions/tasks'
);

let sql: Sql;
let user: TestUser;
const tempProjectIds: string[] = []; // afterAll 안전망 — 이 테스트가 만든 과제만 지운다

let projectId: string;
let yearId: string;
let taskId: string;
let deliverableId: string;
let techTargetId: string;

let otherProjectId: string;
let otherTaskId: string;
let otherDeliverableId: string; // 다른 과제의 성과목표 (경계 검증용)
let otherTechTargetId: string; // 다른 과제의 기술목표 (경계 검증용)

// 실패를 조용히 넘기지 않는다 — 실패 코드까지 메시지에 담아 원인을 드러낸다
function unwrap<T>(result: ActionResult<T>): T {
  if (!result.ok) {
    throw new Error(`액션 실패: ${result.error} (code=${result.code ?? '-'})`);
  }
  return result.data;
}

function expectRuleViolation(result: ActionResult<unknown>): string {
  if (result.ok) throw new Error('규칙 위반이 차단되지 않았습니다.');
  expect(result.code).toBe('RULE');
  return result.error;
}

async function newProject(name: string): Promise<string> {
  const project = unwrap(await createProject({ name, contractStartDate: '2026-01-01' }));
  tempProjectIds.push(project.id);
  return project.id;
}

async function firstYearId(pid: string): Promise<string> {
  const year = (await yearsRepo.listYears(user.client, pid))[0];
  if (!year) throw new Error('createProject가 연차를 만들지 않았습니다.');
  return year.id;
}

beforeAll(async () => {
  sql = connectDirectDb();
  user = await createTestUser(sql);
  session.accessToken = user.accessToken;

  projectId = await newProject('목표 연계 테스트 과제');
  yearId = await firstYearId(projectId);
  taskId = unwrap(await createTask(yearId, { title: '목표 연계 대상 작업' })).id;
  deliverableId = unwrap(
    await goals.createDeliverable(projectId, { type: 'paper_sci', name: 'SCI급 논문 게재' })
  ).id;
  techTargetId = unwrap(await goals.createTechTarget(projectId, { name: '인식 정확도' })).id;

  otherProjectId = await newProject('목표 연계 남의 과제');
  otherTaskId = unwrap(
    await createTask(await firstYearId(otherProjectId), { title: '남의 과제 작업' })
  ).id;
  otherDeliverableId = unwrap(
    await goals.createDeliverable(otherProjectId, {
      type: 'patent_dom_apply',
      name: '남의 특허 출원',
    })
  ).id;
  otherTechTargetId = unwrap(
    await goals.createTechTarget(otherProjectId, { name: '남의 처리 속도' })
  ).id;
});

afterAll(async () => {
  for (const id of tempProjectIds) {
    await sql`delete from public.projects where id = ${id}::uuid`;
  }
  await destroyTestUser(sql, user);
  await sql.end();
});

describe('linkTaskGoals (§9, §7.4)', () => {
  it('같은 과제의 성과·기술목표를 연계하고, 다시 부르면 통째로 치환한다', async () => {
    const linked = unwrap(await linkTaskGoals(taskId, [deliverableId], [techTargetId]));
    expect(linked.deliverableIds).toEqual([deliverableId]);
    expect(linked.techTargetIds).toEqual([techTargetId]);

    // 전체 치환 규약: 목록에서 빠진 목표는 연계가 풀린다
    const cleared = unwrap(await linkTaskGoals(taskId, [], [techTargetId]));
    expect(cleared.deliverableIds).toEqual([]);
    expect(cleared.techTargetIds).toEqual([techTargetId]);

    unwrap(await linkTaskGoals(taskId, [deliverableId], [techTargetId]));
  });

  it('다른 과제의 목표는 연계할 수 없다 (H-11과 같은 무결성)', async () => {
    const message = expectRuleViolation(
      await linkTaskGoals(taskId, [otherDeliverableId], [techTargetId])
    );
    expect(message).toContain('이 과제에 속하지 않은 목표');
    expectRuleViolation(await linkTaskGoals(taskId, [deliverableId], [otherTechTargetId]));

    // 차단됐으므로 기존 연계가 남아 있어야 한다 (전체 치환이 일어나지 않는다)
    const task = await tasksRepo.getTaskById(user.client, taskId);
    expect(task.deliverableIds).toEqual([deliverableId]);
    expect(task.techTargetIds).toEqual([techTargetId]);
  });

  it('형식이 틀린 id는 VALIDATION으로 먼저 거른다', async () => {
    const result = await linkTaskGoals(taskId, ['목표1'], []);
    if (result.ok) throw new Error('잘못된 id 형식이 통과했습니다.');
    expect(result.code).toBe('VALIDATION');
  });

  it('목표를 지우면 연계 조인만 사라지고 작업은 남는다 (N-1 cascade)', async () => {
    const temp = unwrap(
      await goals.createDeliverable(projectId, { type: 'paper_domestic', name: '임시 국내 논문' })
    );
    unwrap(await linkTaskGoals(taskId, [deliverableId, temp.id], [techTargetId]));

    unwrap(await goals.deleteDeliverable(temp.id));

    const task = await tasksRepo.getTaskById(user.client, taskId);
    expect(task.deliverableIds).toEqual([deliverableId]);
  });
});

describe('createTask / updateTask / bulkUpdateTasks의 목표 경계 검증', () => {
  it('createTask는 다른 과제의 목표 연계를 거부한다', async () => {
    expectRuleViolation(
      await createTask(yearId, { title: '남의 성과목표 작업', deliverableIds: [otherDeliverableId] })
    );
    expectRuleViolation(
      await createTask(yearId, { title: '남의 기술목표 작업', techTargetIds: [otherTechTargetId] })
    );

    // 거부됐으므로 작업 자체가 만들어지지 않아야 한다
    const titles = (await tasksRepo.listTasksByYear(user.client, yearId)).map((t) => t.title);
    expect(titles).toEqual(['목표 연계 대상 작업']);

    // 같은 과제의 목표면 생성된다. PR-3: 연계가 있으면 중요도 4를 제안한다
    const ok = unwrap(
      await createTask(yearId, {
        title: '같은 과제 목표 연계 작업',
        deliverableIds: [deliverableId],
        techTargetIds: [techTargetId],
      })
    );
    expect(ok.deliverableIds).toEqual([deliverableId]);
    expect(ok.importance).toBe(4);
    unwrap(await deleteTask(ok.id));
  });

  it('updateTask는 다른 과제의 목표 연계를 거부한다 (상세 패널 저장 경로)', async () => {
    const before = await tasksRepo.getTaskById(user.client, taskId);
    expectRuleViolation(
      await updateTask(taskId, { deliverableIds: [otherDeliverableId] }, before.version)
    );
    expectRuleViolation(
      await updateTask(taskId, { techTargetIds: [otherTechTargetId] }, before.version)
    );

    // 차단된 호출은 쓰기 자체가 없어야 한다 — version이 그대로다
    const after = await tasksRepo.getTaskById(user.client, taskId);
    expect(after.version).toBe(before.version);
    expect(after.deliverableIds).toEqual([deliverableId]);

    const saved = unwrap(
      await updateTask(taskId, { deliverableIds: [deliverableId] }, before.version)
    );
    expect(saved.deliverableIds).toEqual([deliverableId]);
  });

  it('bulkUpdateTasks는 남의 과제 목표와 과제가 섞인 일괄 연계를 거부한다', async () => {
    expectRuleViolation(await bulkUpdateTasks([taskId], { deliverableIds: [otherDeliverableId] }));
    expectRuleViolation(await bulkUpdateTasks([taskId], { techTargetIds: [otherTechTargetId] }));

    const message = expectRuleViolation(
      await bulkUpdateTasks([taskId, otherTaskId], { deliverableIds: [deliverableId] })
    );
    expect(message).toContain('여러 과제');

    // 부분 반영 금지 — 남의 과제 작업은 그대로여야 한다
    expect((await tasksRepo.getTaskById(user.client, otherTaskId)).deliverableIds).toEqual([]);

    // 같은 과제 안에서는 일괄 연계가 그대로 동작한다
    const updated = unwrap(await bulkUpdateTasks([taskId], { techTargetIds: [techTargetId] }));
    expect(updated[0]?.techTargetIds).toEqual([techTargetId]);
  });
});
