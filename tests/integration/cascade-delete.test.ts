// 연쇄 삭제 통합 테스트 — H-4 ~ H-8 (SOT §6.6, §8.3, N-8, N-13)
// 삭제는 리포지토리(RPC·RLS 경로)로 실행하고, "남았는지/지워졌는지"는 직결 SQL로 확인한다.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Sql } from 'postgres';
import { connectDirectDb, createTestUser, destroyTestUser, type TestUser } from './helpers';
import * as projects from '@/lib/db/projects';
import * as stages from '@/lib/db/stages';
import * as years from '@/lib/db/years';
import * as tasks from '@/lib/db/tasks';
import * as milestones from '@/lib/db/milestones';
import * as deliverables from '@/lib/db/deliverables';
import * as techTargets from '@/lib/db/tech-targets';
import * as organizations from '@/lib/db/organizations';
import * as members from '@/lib/db/members';
import * as risks from '@/lib/db/risks';
import * as notes from '@/lib/db/notes';
import * as todos from '@/lib/db/todos';
import { RuleViolationError } from '@/lib/db/errors';

let sql: Sql;
let user: TestUser;
const tempProjectIds: string[] = [];

async function countRows(table: string, column: string, id: string): Promise<number> {
  // sql(name)은 단일 식별자 인용 — search_path 기본값(public)에 의존한다
  const rows = await sql`
    select count(*)::int as n from ${sql(table)}
     where ${sql(column)} = ${id}::uuid`;
  return (rows[0] as { n: number }).n;
}

// 각 시나리오의 공통 뼈대: 과제 + 단계 + 연차(비목 12종 포함)
async function makeProjectWithYear(name: string) {
  const project = await projects.createProject(user.client, {
    name,
    createdBy: user.id,
    updatedBy: user.id,
  });
  tempProjectIds.push(project.id);
  const stage = await stages.createStage(user.client, { projectId: project.id, name: '1단계' });
  const year = await years.createYear(user.client, { stageId: stage.id, name: '1차년도' });
  return { project, stage, year };
}

beforeAll(async () => {
  sql = connectDirectDb();
  user = await createTestUser(sql);
});

afterAll(async () => {
  for (const id of tempProjectIds) {
    await sql`delete from public.projects where id = ${id}::uuid`;
  }
  await sql`delete from public.todos where created_by = ${user.id}::uuid`;
  await destroyTestUser(sql, user);
  await sql.end();
});

describe('H-4: 부모 Task 삭제', () => {
  it('자손 전체가 삭제되고, Note·Risk의 taskId는 null로 남는다', async () => {
    const { project, year } = await makeProjectWithYear('H-4 검증');
    const a = await tasks.createTask(user.client, {
      projectId: project.id,
      yearId: year.id,
      title: 'A',
    });
    const b = await tasks.createTask(user.client, {
      projectId: project.id,
      yearId: year.id,
      parentId: a.id,
      title: 'B',
    });
    const c = await tasks.createTask(user.client, {
      projectId: project.id,
      yearId: year.id,
      parentId: b.id,
      title: 'C',
    });

    const note = await notes.createNote(user.client, {
      projectId: project.id,
      yearId: null,
      taskId: b.id,
      milestoneId: null,
      type: 'tech',
      title: 'B 작업 메모',
      body: '',
      date: '2026-02-01',
      attendeeMemberIds: [],
      tags: [],
      pinned: false,
    });
    const risk = await risks.createRisk(user.client, {
      projectId: project.id,
      yearId: null,
      taskId: c.id,
      title: 'C 작업 리스크',
      category: 'technical',
      description: '',
      probability: 3,
      impact: 3,
      strategy: 'accept',
      response: '',
      contingency: '',
      ownerMemberId: null,
      dueDate: null,
      status: 'identified',
      order: 0,
    });

    await tasks.deleteTask(user.client, a.id);

    // 자손 전체 삭제 — 직결 SQL로 확인
    const left = await sql`
      select count(*)::int as n from public.tasks
       where id in (${a.id}::uuid, ${b.id}::uuid, ${c.id}::uuid)`;
    expect(left[0]!.n).toBe(0);

    // Note·Risk는 남고 taskId만 null (N-8)
    expect((await notes.getNoteById(user.client, note.id)).taskId).toBeNull();
    expect((await risks.getRiskById(user.client, risk.id)).taskId).toBeNull();
  });
});

describe('H-5: Year 삭제 (delete_year RPC)', () => {
  it('Task·BudgetItem은 삭제, 마일스톤·리스크·노트·실적은 yearId=null, targetByYear 키는 제거된다', async () => {
    const { project, stage, year } = await makeProjectWithYear('H-5 검증');
    const keepYear = await years.createYear(user.client, { stageId: stage.id, name: '2차년도' });

    await tasks.createTask(user.client, { projectId: project.id, yearId: year.id, title: 'T1' });
    expect(await countRows('budget_items', 'year_id', year.id)).toBe(12);

    const milestone = await milestones.createMilestone(
      user.client,
      {
        projectId: project.id,
        yearId: year.id,
        type: 'report',
        title: '연차보고서 제출',
        date: '2026-12-01',
        status: 'planned',
        ownerMemberId: null,
        description: '',
        resultNote: '',
      },
      user.id
    );
    const risk = await risks.createRisk(user.client, {
      projectId: project.id,
      yearId: year.id,
      taskId: null,
      title: '일정 지연',
      category: 'schedule',
      description: '',
      probability: 3,
      impact: 4,
      strategy: 'mitigate',
      response: '',
      contingency: '',
      ownerMemberId: null,
      dueDate: null,
      status: 'identified',
      order: 0,
    });
    const note = await notes.createNote(user.client, {
      projectId: project.id,
      yearId: year.id,
      taskId: null,
      milestoneId: null,
      type: 'meeting',
      title: '연차 회의록',
      body: '',
      date: '2026-03-01',
      attendeeMemberIds: [],
      tags: [],
      pinned: false,
    });

    // 실적·측정과 targetByYear — N-13은 delete_year RPC만이 보장한다
    const deliverable = await deliverables.createDeliverable(
      user.client,
      {
        projectId: project.id,
        type: 'paper_sci',
        name: 'SCI 논문',
        unit: '건',
        targetTotal: 4,
        targetByYear: { [year.id]: 1, [keepYear.id]: 3 },
        orgId: null,
        note: '',
        order: 0,
      },
      user.id
    );
    const achievement = await deliverables.addAchievement(
      user.client,
      deliverable.id,
      {
        title: '논문 1편',
        date: '2026-10-01',
        yearId: year.id,
        orgId: null,
        memberIds: [],
        evidenceUrl: '',
        note: '',
      },
      user.id
    );
    const techTarget = await techTargets.createTechTarget(
      user.client,
      {
        projectId: project.id,
        name: '정확도',
        unit: '%',
        direction: 'higher_better',
        weight: 100,
        targetValue: 90,
        targetByYear: { [year.id]: 80, [keepYear.id]: 90 },
        baselineDomestic: null,
        worldBest: null,
        worldBestHolder: '',
        measureMethod: 'self',
        measureDescription: '',
        orgId: null,
        order: 0,
      },
      user.id
    );
    const record = await techTargets.addRecord(
      user.client,
      techTarget.id,
      {
        value: 78,
        date: '2026-11-01',
        yearId: year.id,
        method: 'self',
        evaluator: '',
        evidenceUrl: '',
        note: '',
      },
      user.id
    );

    await years.deleteYear(user.client, year.id);

    // 삭제 확인 — Task·BudgetItem (cascade)
    expect(await countRows('tasks', 'year_id', year.id)).toBe(0);
    expect(await countRows('budget_items', 'year_id', year.id)).toBe(0);

    // 잔존 확인 — yearId=null (N-8)
    expect((await milestones.getMilestoneById(user.client, milestone.id)).yearId).toBeNull();
    expect((await risks.getRiskById(user.client, risk.id)).yearId).toBeNull();
    expect((await notes.getNoteById(user.client, note.id)).yearId).toBeNull();

    const achievementRow = await sql`
      select year_id from public.deliverable_achievements where id = ${achievement.id}::uuid`;
    expect(achievementRow[0]!.year_id).toBeNull();
    const recordRow = await sql`
      select year_id from public.tech_target_records where id = ${record.id}::uuid`;
    expect(recordRow[0]!.year_id).toBeNull();

    // targetByYear 고아 키 제거 (N-13) — 남은 연차 키는 유지
    const deliverableAfter = await deliverables.getDeliverableById(user.client, deliverable.id);
    expect(deliverableAfter.targetByYear).toEqual({ [keepYear.id]: 3 });
    const techTargetAfter = await techTargets.getTechTargetById(user.client, techTarget.id);
    expect(techTargetAfter.targetByYear).toEqual({ [keepYear.id]: 90 });
  });
});

describe('H-6: Stage 삭제 (delete_stage RPC)', () => {
  it('소속 Year를 연쇄 삭제하고, 마지막 Stage는 삭제를 거부한다', async () => {
    const { project, year } = await makeProjectWithYear('H-6 검증');
    const stage2 = await stages.createStage(user.client, {
      projectId: project.id,
      name: '2단계',
      order: 1,
    });
    const stage2Year = await years.createYear(user.client, { stageId: stage2.id, name: '3차년도' });
    await tasks.createTask(user.client, {
      projectId: project.id,
      yearId: stage2Year.id,
      title: '2단계 작업',
    });

    await stages.deleteStage(user.client, stage2.id);
    expect(await countRows('years', 'stage_id', stage2.id)).toBe(0);
    expect(await countRows('tasks', 'year_id', stage2Year.id)).toBe(0);

    // 남은 Stage 1개 — 삭제 거부 (H-6)
    const stageList = await stages.listStages(user.client, project.id);
    expect(stageList).toHaveLength(1);
    await expect(stages.deleteStage(user.client, stageList[0]!.id)).rejects.toBeInstanceOf(
      RuleViolationError
    );
    // 거부되었으므로 기존 연차도 그대로다
    expect(await countRows('years', 'project_id', project.id)).toBe(1);
    expect((await years.getYearById(user.client, year.id)).id).toBe(year.id);
  });
});

describe('H-7: Project 삭제 (delete_project RPC)', () => {
  it('소속 전 엔티티가 삭제되고 To-Do는 projectId=null로 남는다', async () => {
    const { project, year } = await makeProjectWithYear('H-7 검증');
    const org = await organizations.createOrganization(
      user.client,
      {
        projectId: project.id,
        name: '주관기관',
        role: 'lead',
        type: '기업',
        representative: '',
        contact: '',
        responsibility: '',
        budget: null,
        order: 0,
      },
      user.id
    );
    const member = await members.createMember(
      user.client,
      {
        projectId: project.id,
        orgId: org.id,
        name: '김피엠',
        role: 'pm',
        position: '',
        field: '',
        email: '',
        phone: '',
        active: true,
        annualSalary: null,
        hireType: 'existing',
        order: 0,
      },
      user.id
    );
    // 순환 FK(H-7) — pm_member_id·lead_org_id를 채워 RPC의 선행 null 처리까지 검증한다
    await projects.updateProject(user.client, project.id, {
      pmMemberId: member.id,
      leadOrgId: org.id,
      updatedBy: user.id,
    });
    await tasks.createTask(user.client, { projectId: project.id, yearId: year.id, title: 'T' });
    await notes.createNote(user.client, {
      projectId: project.id,
      yearId: null,
      taskId: null,
      milestoneId: null,
      type: 'other',
      title: '과제 노트',
      body: '',
      date: '2026-01-01',
      attendeeMemberIds: [],
      tags: [],
      pinned: false,
    });
    const todo = await todos.createTodo(user.client, {
      title: '과제 관련 할 일',
      done: false,
      projectId: project.id,
      dueDate: null,
      priority: 'normal',
      order: 0,
      completedAt: null,
      createdBy: user.id,
      updatedBy: user.id,
    });

    await projects.deleteProject(user.client, project.id);

    for (const table of [
      'stages', 'years', 'tasks', 'organizations', 'members', 'budget_items', 'notes',
    ]) {
      expect(await countRows(table, 'project_id', project.id), table).toBe(0);
    }

    // To-Do는 남고 projectId만 null (N-8)
    const todoAfter = await todos.getTodoById(user.client, todo.id);
    expect(todoAfter.projectId).toBeNull();
    expect(todoAfter.title).toBe('과제 관련 할 일');
    await todos.removeTodo(user.client, todo.id);
  });
});

describe('H-8: Organization 삭제', () => {
  it('참조하던 Member의 orgId가 null이 된다', async () => {
    const { project } = await makeProjectWithYear('H-8 검증');
    const org = await organizations.createOrganization(
      user.client,
      {
        projectId: project.id,
        name: '공동기관',
        role: 'joint',
        type: '대학',
        representative: '',
        contact: '',
        responsibility: '',
        budget: null,
        order: 0,
      },
      user.id
    );
    const member = await members.createMember(
      user.client,
      {
        projectId: project.id,
        orgId: org.id,
        name: '박소속',
        role: 'researcher',
        position: '',
        field: '',
        email: '',
        phone: '',
        active: true,
        annualSalary: null,
        hireType: 'existing',
        order: 0,
      },
      user.id
    );

    await organizations.removeOrganization(user.client, org.id);

    const after = await members.getMemberById(user.client, member.id);
    expect(after.orgId).toBeNull(); // N-8 set null — 인력 데이터는 남는다
    expect(after.name).toBe('박소속');
  });
});
