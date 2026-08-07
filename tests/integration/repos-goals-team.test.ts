// 목표·팀 리포지토리 통합 테스트 — organizations / members / milestones /
// deliverables(+achievements) / tech-targets(+records) (SOT §5.7~5.11, N-1, N-2)
// 조회 결과가 §5 앱 형태(camelCase + 임베드 배열 + xxxIds)인지까지 확인한다.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Sql } from 'postgres';
import { connectDirectDb, createTestUser, destroyTestUser, type TestUser } from './helpers';
import * as projects from '@/lib/db/projects';
import * as organizations from '@/lib/db/organizations';
import * as members from '@/lib/db/members';
import * as milestones from '@/lib/db/milestones';
import * as deliverables from '@/lib/db/deliverables';
import * as techTargets from '@/lib/db/tech-targets';
import { NotFoundError } from '@/lib/db/errors';

let sql: Sql;
let user: TestUser;
let projectId: string;
let leadOrgId: string;
let memberId: string;

beforeAll(async () => {
  sql = connectDirectDb();
  user = await createTestUser(sql);
  const project = await projects.createProject(user.client, {
    name: '목표·팀 테스트 과제',
    createdBy: user.id,
    updatedBy: user.id,
  });
  projectId = project.id;

  const org = await organizations.createOrganization(
    user.client,
    {
      projectId,
      name: '주관연구소',
      role: 'lead',
      type: '출연연',
      representative: '김책임',
      contact: 'lead@example.org',
      responsibility: '총괄',
      budget: 300_000_000,
      order: 0,
    },
    user.id
  );
  leadOrgId = org.id;

  const member = await members.createMember(
    user.client,
    {
      projectId,
      orgId: leadOrgId,
      name: '이연구',
      role: 'pl',
      position: '책임',
      field: '컴퓨터비전',
      email: 'lee@example.org',
      phone: '',
      active: true,
      annualSalary: null,
      hireType: 'existing',
      order: 0,
    },
    user.id
  );
  memberId = member.id;
});

afterAll(async () => {
  await sql`delete from public.projects where id = ${projectId}::uuid`;
  await destroyTestUser(sql, user);
  await sql.end();
});

describe('organizations CRUD', () => {
  it('create → read(role 포함) → update → delete', async () => {
    const read = await organizations.getOrganizationById(user.client, leadOrgId);
    expect(read.name).toBe('주관연구소');
    expect(read.budget).toBe(300_000_000);
    expect(await organizations.getOrganizationRole(user.client, leadOrgId)).toBe('lead');

    const joint = await organizations.createOrganization(
      user.client,
      {
        projectId,
        name: '공동기업',
        role: 'joint',
        type: '기업',
        representative: '',
        contact: '',
        responsibility: '',
        budget: null,
        order: 1,
      },
      user.id
    );
    const list = await organizations.listOrganizations(user.client, projectId);
    expect(list.map((o) => o.name)).toEqual(['주관연구소', '공동기업']); // order 순

    const updated = await organizations.updateOrganization(
      user.client,
      joint.id,
      { responsibility: '실증' },
      user.id
    );
    expect(updated.responsibility).toBe('실증');
    expect(updated.updatedBy).toBe(user.id);

    await organizations.removeOrganization(user.client, joint.id);
    await expect(
      organizations.getOrganizationById(user.client, joint.id)
    ).rejects.toBeInstanceOf(NotFoundError);
  });
});

describe('members CRUD', () => {
  it('create → read → update → delete', async () => {
    const read = await members.getMemberById(user.client, memberId);
    expect(read.orgId).toBe(leadOrgId);
    expect(read.role).toBe('pl');

    const second = await members.createMember(
      user.client,
      {
        projectId,
        orgId: null,
        name: '박행정',
        role: 'staff',
        position: '',
        field: '',
        email: '',
        phone: '',
        active: true,
        annualSalary: null,
        hireType: 'existing',
        order: 1,
      },
      user.id
    );
    expect((await members.listMembers(user.client, projectId)).length).toBe(2);

    const updated = await members.updateMember(
      user.client,
      second.id,
      { active: false, position: '주임' },
      user.id
    );
    expect(updated.active).toBe(false);
    expect(updated.position).toBe('주임');

    await members.removeMember(user.client, second.id);
    await expect(members.getMemberById(user.client, second.id)).rejects.toBeInstanceOf(
      NotFoundError
    );
  });
});

describe('milestones CRUD', () => {
  it('create → read → update → delete', async () => {
    const created = await milestones.createMilestone(
      user.client,
      {
        projectId,
        yearId: null,
        type: 'annual_eval',
        title: '1차년도 연차평가',
        date: '2026-11-30',
        status: 'planned',
        ownerMemberId: memberId,
        description: '',
        resultNote: '',
      },
      user.id
    );
    expect(created.type).toBe('annual_eval');
    expect(created.ownerMemberId).toBe(memberId);

    const list = await milestones.listMilestones(user.client, projectId);
    expect(list.some((m) => m.id === created.id)).toBe(true);

    const updated = await milestones.updateMilestone(
      user.client,
      created.id,
      { status: 'done', resultNote: '통과' },
      user.id
    );
    expect(updated.status).toBe('done');
    expect(updated.resultNote).toBe('통과');

    await milestones.removeMilestone(user.client, created.id);
    await expect(milestones.getMilestoneById(user.client, created.id)).rejects.toBeInstanceOf(
      NotFoundError
    );
  });
});

describe('deliverables + achievements (N-1, N-2)', () => {
  it('실적·관여자가 임베드 배열(achievements[].memberIds)로 왕복한다', async () => {
    const created = await deliverables.createDeliverable(
      user.client,
      {
        projectId,
        type: 'patent_dom_apply',
        name: '국내 특허 출원',
        unit: '건',
        targetTotal: 6,
        targetByYear: {},
        orgId: leadOrgId,
        note: '',
        order: 0,
      },
      user.id
    );
    expect(created.achievements).toEqual([]);

    const achievement = await deliverables.addAchievement(
      user.client,
      created.id,
      {
        title: '영상 인식 방법 특허',
        date: '2026-06-30',
        yearId: null,
        orgId: leadOrgId,
        memberIds: [memberId],
        evidenceUrl: 'https://doi.example/1',
        note: '',
      },
      user.id
    );
    expect(achievement.memberIds).toEqual([memberId]);

    const read = await deliverables.getDeliverableById(user.client, created.id);
    expect(read.achievements).toHaveLength(1);
    expect(read.achievements[0]!.title).toBe('영상 인식 방법 특허');
    expect(read.achievements[0]!.memberIds).toEqual([memberId]);
    expect(read.achievements[0]!.evidenceUrl).toBe('https://doi.example/1'); // evidence_url → camel

    const patched = await deliverables.updateAchievement(
      user.client,
      achievement.id,
      { title: '영상 인식 방법 특허(보정)', memberIds: [] },
      user.id
    );
    expect(patched.title).toBe('영상 인식 방법 특허(보정)');
    expect(patched.memberIds).toEqual([]);

    const updated = await deliverables.updateDeliverable(
      user.client,
      created.id,
      { targetTotal: 8 },
      user.id
    );
    expect(updated.targetTotal).toBe(8);

    await deliverables.deleteAchievement(user.client, achievement.id);
    await deliverables.removeDeliverable(user.client, created.id);
    await expect(
      deliverables.getDeliverableById(user.client, created.id)
    ).rejects.toBeInstanceOf(NotFoundError);
  });
});

describe('tech-targets + records (N-1)', () => {
  it('측정 이력이 records 임베드 배열로 왕복한다', async () => {
    const created = await techTargets.createTechTarget(
      user.client,
      {
        projectId,
        name: '추론 지연시간',
        unit: 'ms',
        direction: 'lower_better',
        weight: 30,
        targetValue: 50,
        targetByYear: {},
        baselineDomestic: 200,
        worldBest: 40,
        worldBestHolder: '독일',
        measureMethod: 'certified_lab',
        measureDescription: '공인시험',
        orgId: null,
        order: 0,
      },
      user.id
    );
    expect(created.records).toEqual([]);
    expect(created.direction).toBe('lower_better');
    expect(created.baselineDomestic).toBe(200);

    const record = await techTargets.addRecord(
      user.client,
      created.id,
      {
        value: 80,
        date: '2026-09-01',
        yearId: null,
        method: 'certified_lab',
        evaluator: '한국시험연구원',
        evidenceUrl: '',
        note: '',
      },
      user.id
    );
    expect(record.value).toBe(80);

    const read = await techTargets.getTechTargetById(user.client, created.id);
    expect(read.records).toHaveLength(1);
    expect(read.records[0]!.evaluator).toBe('한국시험연구원');

    const patchedRecord = await techTargets.updateRecord(
      user.client,
      record.id,
      { value: 70 },
      user.id
    );
    expect(patchedRecord.value).toBe(70);

    const updated = await techTargets.updateTechTarget(
      user.client,
      created.id,
      { weight: 40 },
      user.id
    );
    expect(updated.weight).toBe(40);

    await techTargets.deleteRecord(user.client, record.id);
    await techTargets.removeTechTarget(user.client, created.id);
    await expect(
      techTargets.getTechTargetById(user.client, created.id)
    ).rejects.toBeInstanceOf(NotFoundError);
  });
});
