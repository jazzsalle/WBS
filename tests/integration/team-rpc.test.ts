// 팀 RPC 통합 테스트 — delete_member / count_member_references /
// set_lead_organization / reorder_organizations / reorder_members
// (SOT §6.6 H-8·H-9·H-10, §8.3 X-3, §5.10, §5.11)
// publishable 키 + 실제 세션(RLS 경로)으로 리포지토리를 호출한다. 직결 SQL은 결과 확인 전용.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Sql } from 'postgres';
import { connectDirectDb, createTestUser, destroyTestUser, type TestUser } from './helpers';
import * as projects from '@/lib/db/projects';
import * as years from '@/lib/db/years';
import * as tasks from '@/lib/db/tasks';
import * as milestones from '@/lib/db/milestones';
import * as risks from '@/lib/db/risks';
import * as notes from '@/lib/db/notes';
import * as deliverables from '@/lib/db/deliverables';
import * as organizations from '@/lib/db/organizations';
import * as members from '@/lib/db/members';
import * as appUsers from '@/lib/db/app-users';
import { NotFoundError, RuleViolationError } from '@/lib/db/errors';

let sql: Sql;
let user: TestUser;
const tempProjectIds: string[] = []; // afterAll 안전망 — 실패해도 dev DB를 원복한다

beforeAll(async () => {
  sql = connectDirectDb();
  user = await createTestUser(sql);
});

afterAll(async () => {
  for (const id of tempProjectIds) {
    await sql`delete from public.projects where id = ${id}::uuid`;
  }
  await destroyTestUser(sql, user);
  await sql.end();
});

async function newProject(name: string) {
  const project = await projects.createProjectWithDefaults(user.client, {
    name,
    contractStartDate: '2026-01-01',
  });
  tempProjectIds.push(project.id);
  return project;
}

function newOrganization(projectId: string, name: string, role: 'lead' | 'joint' | 'consign', order: number) {
  return organizations.createOrganization(
    user.client,
    {
      projectId,
      name,
      role,
      type: '기업',
      representative: '',
      contact: '',
      responsibility: '',
      budget: null,
      order,
    },
    user.id
  );
}

function newMember(projectId: string, name: string, order: number) {
  return members.createMember(
    user.client,
    {
      projectId,
      orgId: null,
      name,
      role: 'researcher',
      position: '',
      field: '',
      email: '',
      phone: '',
      active: true,
      annualSalary: null,
      hireType: 'existing',
      order,
    },
    user.id
  );
}

function firstCount(rows: readonly unknown[]): number {
  return (rows[0] as { n: number }).n;
}

describe('delete_member — H-9 참조 8곳 정리', () => {
  it('참조 건수를 돌려주고 8곳을 모두 정리한다', async () => {
    const project = await newProject('H-9 검증 과제');
    const year = (await years.listYears(user.client, project.id))[0]!;
    const member = await newMember(project.id, '정리대상', 0);

    // ①tasks.owner_member_id ②task_members
    const task = await tasks.createTask(user.client, {
      projectId: project.id,
      yearId: year.id,
      title: '담당 작업',
      ownerMemberId: member.id,
      memberIds: [member.id],
    });
    // ③milestones.owner_member_id
    const milestone = await milestones.createMilestone(
      user.client,
      {
        projectId: project.id,
        yearId: year.id,
        type: 'report',
        title: '연차보고서',
        date: '2026-12-01',
        status: 'planned',
        ownerMemberId: member.id,
        description: '',
        resultNote: '',
      },
      user.id
    );
    // ④risks.owner_member_id
    const risk = await risks.createRisk(user.client, {
      projectId: project.id,
      yearId: null,
      taskId: null,
      title: '인력 이탈',
      category: 'resource',
      description: '',
      probability: 3,
      impact: 3,
      strategy: 'mitigate',
      response: '',
      contingency: '',
      ownerMemberId: member.id,
      dueDate: null,
      status: 'identified',
      order: 0,
    });
    // ⑤projects.pm_member_id
    await projects.updateProject(user.client, project.id, { pmMemberId: member.id });
    // ⑥achievement_members
    const deliverable = await deliverables.createDeliverable(
      user.client,
      {
        projectId: project.id,
        type: 'paper_sci',
        name: 'SCI 논문',
        unit: '건',
        targetTotal: 1,
        targetByYear: {},
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
        date: '2026-06-01',
        yearId: year.id,
        orgId: null,
        memberIds: [member.id],
        evidenceUrl: '',
        note: '',
      },
      user.id
    );
    // ⑦note_attendees
    const note = await notes.createNote(user.client, {
      projectId: project.id,
      yearId: null,
      taskId: null,
      milestoneId: null,
      type: 'meeting',
      title: '킥오프',
      body: '',
      date: '2026-02-01',
      attendeeMemberIds: [member.id],
      tags: [],
      pinned: false,
    });
    // ⑧app_users.member_id — 본인 행에만 쓸 수 있다 (RLS-2)
    await appUsers.updateProfile(user.client, user.id, { memberId: member.id });

    const expected = {
      tasks: 1,
      taskMembers: 1,
      milestones: 1,
      risks: 1,
      projects: 1,
      achievementMembers: 1,
      noteAttendees: 1,
      appUsers: 1,
      // H-9a: 산출근거는 "정리되는 참조"가 아니라 "삭제를 막는 참조"라 별도 항목이다.
      // 0건이므로 이 삭제는 통과한다
      budgetDetails: 0,
    };
    // 삭제 확인 대화상자용 집계와 삭제가 같은 숫자를 봐야 한다
    expect(await members.countMemberReferences(user.client, member.id)).toEqual(expected);
    expect(await members.removeMember(user.client, member.id)).toEqual(expected);

    // set null 4곳 (N-8) — 행 자체는 남는다
    const taskRow = await sql`
      select owner_member_id from public.tasks where id = ${task.id}::uuid`;
    expect(taskRow[0]!.owner_member_id).toBeNull();
    const milestoneRow = await sql`
      select owner_member_id from public.milestones where id = ${milestone.id}::uuid`;
    expect(milestoneRow[0]!.owner_member_id).toBeNull();
    const riskRow = await sql`
      select owner_member_id from public.risks where id = ${risk.id}::uuid`;
    expect(riskRow[0]!.owner_member_id).toBeNull();
    const projectRow = await sql`
      select pm_member_id from public.projects where id = ${project.id}::uuid`;
    expect(projectRow[0]!.pm_member_id).toBeNull();

    // 조인 3곳은 행 삭제 (N-2 cascade). 상위 행은 남는다
    expect(
      firstCount(await sql`
        select count(*)::int as n from public.task_members
         where member_id = ${member.id}::uuid`)
    ).toBe(0);
    expect(
      firstCount(await sql`
        select count(*)::int as n from public.achievement_members
         where member_id = ${member.id}::uuid`)
    ).toBe(0);
    expect(
      firstCount(await sql`
        select count(*)::int as n from public.note_attendees
         where member_id = ${member.id}::uuid`)
    ).toBe(0);
    expect(
      firstCount(await sql`
        select count(*)::int as n from public.deliverable_achievements
         where id = ${achievement.id}::uuid`)
    ).toBe(1);
    expect(
      firstCount(await sql`
        select count(*)::int as n from public.notes where id = ${note.id}::uuid`)
    ).toBe(1);

    // ⑧ 남의 행 갱신이 RLS로 막히는 자리 — FK set null이 처리한다
    const appUserRow = await sql`
      select member_id from public.app_users where id = ${user.id}::uuid`;
    expect(appUserRow[0]!.member_id).toBeNull();

    // 대상 인력은 실제로 사라졌다
    expect(
      firstCount(await sql`
        select count(*)::int as n from public.members where id = ${member.id}::uuid`)
    ).toBe(0);
  });

  it('참조가 없으면 전부 0을 돌려준다', async () => {
    const project = await newProject('참조 없는 인력 과제');
    const member = await newMember(project.id, '참조없음', 0);

    const zeros = {
      tasks: 0,
      taskMembers: 0,
      milestones: 0,
      risks: 0,
      projects: 0,
      achievementMembers: 0,
      noteAttendees: 0,
      appUsers: 0,
      budgetDetails: 0, // H-9a
    };
    expect(await members.countMemberReferences(user.client, member.id)).toEqual(zeros);
    expect(await members.removeMember(user.client, member.id)).toEqual(zeros);
  });

  // Phase 9: members.ts의 P0001 해석이 budget-details.ts와 같은 규약을 쓴다 —
  // '…찾을 수 없습니다'는 NotFoundError, '먼저 수정'은 StaleDataError(§8.4 O-1),
  // 나머지가 RuleViolationError다. 전부 RULE로 보내면 apply_salary_change의 잠금 실패가
  // STALE로 잡히지 않아 O-3 충돌 다이얼로그가 뜨지 않는다. 무음 성공이 아닌 것은 그대로다.
  it('없는 인력의 삭제·집계는 조용히 성공하지 않는다', async () => {
    const missing = 'bbbb0000-0000-4000-8000-0000000000fe';
    await expect(members.removeMember(user.client, missing)).rejects.toBeInstanceOf(NotFoundError);
    await expect(members.countMemberReferences(user.client, missing)).rejects.toBeInstanceOf(
      NotFoundError
    );
  });
});

describe('set_lead_organization — H-8 주관기관은 항상 1개', () => {
  it('주관을 옮기면 기존 주관이 joint로 강등되고 projects.lead_org_id가 따라간다', async () => {
    const project = await newProject('주관 재지정 과제');
    const lead = await newOrganization(project.id, '기존주관', 'lead', 0);
    const joint = await newOrganization(project.id, '공동기업', 'joint', 1);
    await projects.updateProject(user.client, project.id, { leadOrgId: lead.id });

    await organizations.setLeadOrganization(user.client, project.id, joint.id);

    const after = await organizations.listOrganizations(user.client, project.id);
    expect(after.find((o) => o.id === lead.id)!.role).toBe('joint');
    expect(after.find((o) => o.id === joint.id)!.role).toBe('lead');
    expect(after.filter((o) => o.role === 'lead')).toHaveLength(1);
    expect((await projects.getProjectById(user.client, project.id)).leadOrgId).toBe(joint.id);
  });

  it('주관이 아직 없어도 지정할 수 있다', async () => {
    const project = await newProject('주관 최초 지정 과제');
    const org = await newOrganization(project.id, '위탁기관', 'consign', 0);

    await organizations.setLeadOrganization(user.client, project.id, org.id);

    expect(await organizations.getOrganizationRole(user.client, org.id)).toBe('lead');
    expect((await projects.getProjectById(user.client, project.id)).leadOrgId).toBe(org.id);
  });

  it('다른 과제의 기관은 주관으로 지정할 수 없다', async () => {
    const a = await newProject('주관 경계 A');
    const b = await newProject('주관 경계 B');
    const orgB = await newOrganization(b.id, 'B 기관', 'joint', 0);

    await expect(
      organizations.setLeadOrganization(user.client, a.id, orgB.id)
    ).rejects.toBeInstanceOf(RuleViolationError);
    expect(await organizations.getOrganizationRole(user.client, orgB.id)).toBe('joint');
  });
});

describe('reorderOrganizations / reorderMembers — H-10 0..n-1 normalize (X-3)', () => {
  it('기관 순서를 뒤집으면 order가 0..n-1로 다시 매겨진다', async () => {
    const project = await newProject('기관 재정렬 과제');
    await newOrganization(project.id, '기관1', 'lead', 0);
    await newOrganization(project.id, '기관2', 'joint', 5); // 비연속 order로 시작
    await newOrganization(project.id, '기관3', 'consign', 9);

    const before = await organizations.listOrganizations(user.client, project.id);
    const reversed = [...before].reverse().map((o) => o.id);
    await organizations.reorderOrganizations(user.client, project.id, reversed);

    const after = await organizations.listOrganizations(user.client, project.id);
    expect(after.map((o) => o.id)).toEqual(reversed);
    expect(after.map((o) => o.order)).toEqual([0, 1, 2]);
  });

  it('다른 과제의 기관 id가 섞이면 거부한다', async () => {
    const a = await newProject('기관 재정렬 경계 A');
    const b = await newProject('기관 재정렬 경계 B');
    const orgA = await newOrganization(a.id, 'A 기관', 'lead', 0);
    const orgB = await newOrganization(b.id, 'B 기관', 'lead', 0);

    await expect(
      organizations.reorderOrganizations(user.client, a.id, [orgA.id, orgB.id])
    ).rejects.toBeInstanceOf(RuleViolationError);
    // 거부됐으므로 원래 order 그대로다
    expect((await organizations.getOrganizationById(user.client, orgA.id)).order).toBe(0);
  });

  it('인력 순서를 뒤집으면 order가 0..n-1로 다시 매겨진다', async () => {
    const project = await newProject('인력 재정렬 과제');
    await newMember(project.id, '인력1', 0);
    await newMember(project.id, '인력2', 3);
    await newMember(project.id, '인력3', 7);

    const before = await members.listMembers(user.client, project.id);
    const reversed = [...before].reverse().map((m) => m.id);
    await members.reorderMembers(user.client, project.id, reversed);

    const after = await members.listMembers(user.client, project.id);
    expect(after.map((m) => m.id)).toEqual(reversed);
    expect(after.map((m) => m.order)).toEqual([0, 1, 2]);
  });

  it('다른 과제의 인력 id가 섞이면 거부한다', async () => {
    const a = await newProject('인력 재정렬 경계 A');
    const b = await newProject('인력 재정렬 경계 B');
    const memberA = await newMember(a.id, 'A 인력', 0);
    const memberB = await newMember(b.id, 'B 인력', 0);

    await expect(
      members.reorderMembers(user.client, a.id, [memberA.id, memberB.id])
    ).rejects.toBeInstanceOf(RuleViolationError);
    expect((await members.getMemberById(user.client, memberA.id)).order).toBe(0);
  });
});
