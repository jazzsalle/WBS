// Organization·Member 서버 액션 통합 테스트 (SOT §9 Organization/Member, §6.6 H-8·H-9·H-10,
// §7.10, §5.10, §5.11, N-11)
//
// 서버 액션은 쿠키 세션(requireApprovedUser)에서 토큰을 읽으므로 next/headers를
// "실제 세션 토큰을 돌려주는 스텁"으로 바꿔 액션을 가드까지 포함해 그대로 호출한다
// (wbs-queries.test.ts와 같은 방식). revalidatePath는 요청 컨텍스트 밖이라 스텁한다.
//
// 검증 대상의 핵심은 H-8이다: 주관기관은 삭제할 수 없고, 다른 기관을 주관으로 지정한
// 뒤에는 삭제된다. 이 판정이 무너지면 과제의 주관기관이 0개가 된다.

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Sql } from 'postgres';
import { connectDirectDb, createTestUser, destroyTestUser, type TestUser } from './helpers';
import type { ActionResult } from '@/types';
import * as projectsRepo from '@/lib/db/projects';
import * as organizationsRepo from '@/lib/db/organizations';
import * as membersRepo from '@/lib/db/members';
import * as yearsRepo from '@/lib/db/years';
import * as tasksRepo from '@/lib/db/tasks';

const session = vi.hoisted(() => ({ accessToken: '' }));

vi.mock('next/headers', () => ({
  cookies: async () => ({ get: () => ({ value: session.accessToken }) }),
}));
vi.mock('next/cache', () => ({ revalidatePath: () => undefined }));

const team = await import('@/actions/team');
const { createProject } = await import('@/actions/projects');
const { assignTaskMembers, bulkUpdateTasks, createTask, deleteTask, updateTask } = await import(
  '@/actions/tasks'
);

let sql: Sql;
let user: TestUser;
const tempProjectIds: string[] = []; // afterAll 안전망 — 실패해도 dev DB를 원복한다

let projectId: string;
let otherProjectId: string;
let yearId: string;
let taskId: string;
let otherTaskId: string; // 다른 과제의 작업 (과제 경계를 넘는 일괄 배정 검증용)

let leadOrgId: string; // 최초 주관기관 — 나중에 joint로 강등된 뒤 삭제된다
let jointOrgId: string; // 재지정 대상 — 테스트 후반의 주관기관
let otherOrgId: string; // 다른 과제의 기관 (소속 검증용)
let otherMemberId: string; // 다른 과제의 인력 (소속 검증용)
let memberAId: string;
let memberBId: string;

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

beforeAll(async () => {
  sql = connectDirectDb();
  user = await createTestUser(sql);
  session.accessToken = user.accessToken;

  const project = unwrap(
    await createProject({ name: '팀 액션 테스트 과제', contractStartDate: '2026-01-01' })
  );
  projectId = project.id;
  tempProjectIds.push(projectId);

  const other = unwrap(await createProject({ name: '팀 액션 남의 과제' }));
  otherProjectId = other.id;
  tempProjectIds.push(otherProjectId);

  const firstYear = (await yearsRepo.listYears(user.client, projectId))[0];
  if (!firstYear) throw new Error('createProject가 연차를 만들지 않았습니다.');
  yearId = firstYear.id;
  taskId = unwrap(await createTask(yearId, { title: '팀 배정 대상 작업' })).id;

  const otherYear = (await yearsRepo.listYears(user.client, otherProjectId))[0];
  if (!otherYear) throw new Error('createProject가 연차를 만들지 않았습니다.');
  otherTaskId = unwrap(await createTask(otherYear.id, { title: '남의 과제 작업' })).id;

  otherOrgId = unwrap(
    await team.createOrganization(otherProjectId, { name: '남의 기관', role: 'lead' })
  ).id;
  otherMemberId = unwrap(await team.createMember(otherProjectId, { name: '남의 연구원' })).id;
});

afterAll(async () => {
  for (const id of tempProjectIds) {
    await sql`delete from public.projects where id = ${id}::uuid`;
  }
  await destroyTestUser(sql, user);
  await sql.end();
});

describe('Organization 액션 (§9, H-8, H-10)', () => {
  it('주관기관을 만들면 projects.lead_org_id까지 함께 갱신된다', async () => {
    const org = unwrap(
      await team.createOrganization(projectId, {
        name: '주관연구소',
        role: 'lead',
        type: '출연연',
        representative: '김책임',
        budget: 300_000_000,
      })
    );
    leadOrgId = org.id;

    expect(org.role).toBe('lead');
    expect(org.order).toBe(0); // H-10: 첫 기관은 0
    expect(org.budget).toBe(300_000_000);

    const project = await projectsRepo.getProjectById(user.client, projectId);
    expect(project.leadOrgId).toBe(leadOrgId);
  });

  it('두 번째 기관은 목록 마지막 뒤에 붙는다 (H-10)', async () => {
    const org = unwrap(
      await team.createOrganization(projectId, { name: '공동참여기업', role: 'joint', type: '기업' })
    );
    jointOrgId = org.id;
    expect(org.order).toBe(1);
  });

  it('금액이 정수가 아니면 VALIDATION으로 거부한다 (절대 규칙 4)', async () => {
    const result = await team.createOrganization(projectId, {
      name: '소수점기관',
      role: 'joint',
      budget: 1_000.5,
    });
    if (result.ok) throw new Error('소수점 금액이 통과했습니다.');
    expect(result.code).toBe('VALIDATION');
  });

  it('주관기관은 삭제할 수 없다 (H-8)', async () => {
    const message = expectRuleViolation(await team.deleteOrganization(leadOrgId));
    expect(message).toContain('주관기관');

    // 차단이므로 행은 그대로 남아 있어야 한다
    expect((await organizationsRepo.listOrganizations(user.client, projectId)).length).toBe(2);
  });

  it('주관기관의 역할을 직접 내리는 것도 막는다 (H-8: lead 0개 금지)', async () => {
    expectRuleViolation(await team.updateOrganization(leadOrgId, { role: 'joint' }));
    expect(await organizationsRepo.getOrganizationRole(user.client, leadOrgId)).toBe('lead');
  });

  it('주관 재지정은 기존 주관 강등 + 포인터 갱신을 함께 한다 (H-8)', async () => {
    const list = unwrap(await team.setLeadOrganization(projectId, jointOrgId));

    expect(list.find((o) => o.id === jointOrgId)?.role).toBe('lead');
    expect(list.find((o) => o.id === leadOrgId)?.role).toBe('joint'); // 강등
    const project = await projectsRepo.getProjectById(user.client, projectId);
    expect(project.leadOrgId).toBe(jointOrgId);
  });

  it('주관에서 내려온 기관은 삭제된다 (H-8 차단 해제)', async () => {
    // 소속 인력이 있어도 orgId는 set null로 남는다 (N-8)
    const attached = unwrap(
      await team.createMember(projectId, { name: '삭제될기관소속', orgId: leadOrgId })
    );

    unwrap(await team.deleteOrganization(leadOrgId));

    const remaining = await organizationsRepo.listOrganizations(user.client, projectId);
    expect(remaining.map((o) => o.id)).toEqual([jointOrgId]);
    expect((await membersRepo.getMemberById(user.client, attached.id)).orgId).toBeNull();

    unwrap(await team.deleteMember(attached.id));
  });

  it('기관 정보 수정은 낙관적 잠금을 건다 (O-1)', async () => {
    const before = await organizationsRepo.getOrganizationById(user.client, jointOrgId);
    const updated = unwrap(
      await team.updateOrganization(jointOrgId, { responsibility: '시스템 통합' }, before.version)
    );
    expect(updated.responsibility).toBe('시스템 통합');

    const stale = await team.updateOrganization(jointOrgId, { type: '대학' }, before.version);
    if (stale.ok) throw new Error('낡은 버전 저장이 통과했습니다.');
    expect(stale.code).toBe('STALE');
  });

  it('재정렬은 0..n-1로 정규화한다 (H-10)', async () => {
    const extra = unwrap(
      await team.createOrganization(projectId, { name: '위탁기관', role: 'consign' })
    );
    unwrap(await team.reorderOrganizations(projectId, [extra.id, jointOrgId]));

    const list = await organizationsRepo.listOrganizations(user.client, projectId);
    expect(list.map((o) => o.id)).toEqual([extra.id, jointOrgId]);
    expect(list.map((o) => o.order)).toEqual([0, 1]);

    unwrap(await team.deleteOrganization(extra.id));
  });

  it('다른 과제의 기관은 주관으로 지정할 수 없다', async () => {
    expectRuleViolation(await team.setLeadOrganization(projectId, otherOrgId));
  });
});

describe('Member 액션 (§9, H-9, N-11, §7.10)', () => {
  it('생성 시 active=true와 role 기본값을 명시적으로 넣는다 (N-11)', async () => {
    const member = unwrap(
      await team.createMember(projectId, { name: '이연구', orgId: jointOrgId, field: '컴퓨터비전' })
    );
    memberAId = member.id;

    expect(member.active).toBe(true); // DB 기본값은 false다
    expect(member.role).toBe('researcher');
    expect(member.orgId).toBe(jointOrgId);
    expect(member.order).toBe(0);
  });

  it('이메일은 빈 문자열을 허용하고 값이 있으면 형식을 본다', async () => {
    const blank = unwrap(await team.createMember(projectId, { name: '박행정', role: 'staff' }));
    expect(blank.email).toBe('');
    memberBId = blank.id;

    const invalid = await team.createMember(projectId, { name: '오타', email: 'not-an-email' });
    if (invalid.ok) throw new Error('잘못된 이메일이 통과했습니다.');
    expect(invalid.code).toBe('VALIDATION');
  });

  it('다른 과제의 기관은 소속으로 지정할 수 없다', async () => {
    expectRuleViolation(await team.createMember(projectId, { name: '남의소속', orgId: otherOrgId }));
    expectRuleViolation(await team.updateMember(memberAId, { orgId: otherOrgId }));
  });

  it('참여 종료는 active 토글로 처리한다 (H-9)', async () => {
    expect(unwrap(await team.setMemberActive(memberBId, false)).active).toBe(false);
    expect(unwrap(await team.setMemberActive(memberBId, true)).active).toBe(true);
  });

  it('인력 정보 수정은 낙관적 잠금을 건다 (O-1)', async () => {
    const before = await membersRepo.getMemberById(user.client, memberAId);
    const updated = unwrap(
      await team.updateMember(memberAId, { position: '책임연구원' }, before.version)
    );
    expect(updated.position).toBe('책임연구원');

    const stale = await team.updateMember(memberAId, { field: '자연어처리' }, before.version);
    if (stale.ok) throw new Error('낡은 버전 저장이 통과했습니다.');
    expect(stale.code).toBe('STALE');
  });

  it('재정렬은 0..n-1로 정규화한다 (H-10)', async () => {
    unwrap(await team.reorderMembers(projectId, [memberBId, memberAId]));
    const list = await membersRepo.listMembers(user.client, projectId);
    expect(list.map((m) => m.id)).toEqual([memberBId, memberAId]);
    expect(list.map((m) => m.order)).toEqual([0, 1]);
  });
});

describe('setProjectPM (§7.10)', () => {
  it('기존 PM의 role을 자동으로 바꾸지 않고 이전 PM을 알려준다', async () => {
    const first = unwrap(await team.setProjectPM(projectId, memberAId));
    expect(first.project.pmMemberId).toBe(memberAId);
    expect(first.previousPmMemberId).toBeNull(); // 최초 지정

    // 이전 PM을 pm 역할로 만들어 두고 교체한다 — 강등되지 않아야 한다
    unwrap(await team.updateMember(memberAId, { role: 'pm' }));

    const second = unwrap(await team.setProjectPM(projectId, memberBId));
    expect(second.project.pmMemberId).toBe(memberBId);
    expect(second.previousPmMemberId).toBe(memberAId);

    // §7.10: 자동으로 pl로 강등되지 않고 경고만 — role은 그대로다
    expect((await membersRepo.getMemberById(user.client, memberAId)).role).toBe('pm');
    expect((await membersRepo.getMemberById(user.client, memberBId)).role).toBe('staff');
  });

  it('다른 과제의 인력은 PM으로 지정할 수 없다', async () => {
    expectRuleViolation(await team.setProjectPM(projectId, otherMemberId));
  });
});

describe('deleteMember / countMemberReferences (H-9)', () => {
  it('정리될 참조를 미리 세고, 삭제 결과로 그 건수를 돌려준다', async () => {
    const temp = unwrap(await team.createMember(projectId, { name: '임시연구원' }));
    unwrap(await assignTaskMembers(taskId, temp.id, [temp.id, memberAId]));

    const before = unwrap(await team.countMemberReferences(temp.id));
    expect(before.tasks).toBe(1); // tasks.owner_member_id
    expect(before.taskMembers).toBe(1); // task_members
    expect(before.projects).toBe(0);

    const counts = unwrap(await team.deleteMember(temp.id));
    expect(counts).toEqual(before);

    const task = await tasksRepo.getTaskById(user.client, taskId);
    expect(task.ownerMemberId).toBeNull(); // set null (N-8)
    expect(task.memberIds).toEqual([memberAId]); // cascade로 조인만 사라진다
  });
});

describe('assignTaskMembers 과제 소속 검증 (H-11과 같은 무결성)', () => {
  it('같은 과제의 인력은 책임자·참여자로 배정된다', async () => {
    const updated = unwrap(await assignTaskMembers(taskId, memberAId, [memberAId, memberBId]));
    expect(updated.ownerMemberId).toBe(memberAId);
    expect([...updated.memberIds].sort()).toEqual([memberAId, memberBId].sort());
  });

  it('다른 과제의 인력은 배정할 수 없다', async () => {
    expectRuleViolation(await assignTaskMembers(taskId, otherMemberId, []));
    expectRuleViolation(await assignTaskMembers(taskId, null, [otherMemberId]));

    // 차단됐으므로 기존 배정이 남아 있어야 한다 (전체 치환이 일어나지 않는다)
    const task = await tasksRepo.getTaskById(user.client, taskId);
    expect(task.ownerMemberId).toBe(memberAId);
    expect(task.memberIds.length).toBe(2);
  });

  it('createTask도 다른 과제의 인력·기관을 거부한다', async () => {
    expectRuleViolation(
      await createTask(yearId, { title: '남의 담당자 작업', ownerMemberId: otherMemberId })
    );
    expectRuleViolation(
      await createTask(yearId, { title: '남의 참여자 작업', memberIds: [otherMemberId] })
    );
    expectRuleViolation(await createTask(yearId, { title: '남의 기관 작업', orgId: otherOrgId }));

    // 거부됐으므로 작업 자체가 만들어지지 않아야 한다
    const titles = (await tasksRepo.listTasksByYear(user.client, yearId)).map((t) => t.title);
    expect(titles).toEqual(['팀 배정 대상 작업']);

    // 같은 과제의 인력·기관이면 생성된다
    const ok = unwrap(
      await createTask(yearId, {
        title: '같은 과제 담당자 작업',
        ownerMemberId: memberAId,
        orgId: jointOrgId,
      })
    );
    expect(ok.ownerMemberId).toBe(memberAId);
    unwrap(await deleteTask(ok.id));
  });

  it('bulkUpdateTasks도 다른 과제의 인력·기관을 거부한다', async () => {
    expectRuleViolation(await bulkUpdateTasks([taskId], { memberIds: [otherMemberId] }));
    expectRuleViolation(await bulkUpdateTasks([taskId], { orgId: otherOrgId }));

    // 여러 과제의 작업을 한 번에 배정하는 요청은 성립하지 않으므로 먼저 거부한다
    const message = expectRuleViolation(
      await bulkUpdateTasks([taskId, otherTaskId], { ownerMemberId: memberAId })
    );
    expect(message).toContain('여러 과제');

    // 차단된 뒤에도 남의 과제 작업은 그대로여야 한다 (부분 반영 금지)
    expect((await tasksRepo.getTaskById(user.client, otherTaskId)).ownerMemberId).toBeNull();

    // 같은 과제 안에서는 일괄 배정이 그대로 동작한다
    const updated = unwrap(await bulkUpdateTasks([taskId], { ownerMemberId: memberAId }));
    expect(updated[0]?.ownerMemberId).toBe(memberAId);
  });

  it('updateTask도 다른 과제의 기관·담당자를 거부한다', async () => {
    const task = await tasksRepo.getTaskById(user.client, taskId);
    expectRuleViolation(await updateTask(taskId, { orgId: otherOrgId }, task.version));
    expectRuleViolation(
      await updateTask(taskId, { ownerMemberId: otherMemberId }, task.version)
    );

    const sameProject = unwrap(await updateTask(taskId, { orgId: jointOrgId }, task.version));
    expect(sameProject.orgId).toBe(jointOrgId);
  });
});

describe('팀 조회 (§7.10)', () => {
  it('getTeam은 기관·인력을 정렬된 상태로 돌려준다', async () => {
    const data = unwrap(await team.getTeam(projectId));
    expect(data.organizations.map((o) => o.id)).toEqual([jointOrgId]);
    expect(data.members.map((m) => m.id)).toEqual([memberBId, memberAId]);
  });

  it('getTeamScreenData는 인력별 배정 작업을 서버에서 집계한다', async () => {
    const data = unwrap(await team.getTeamScreenData(projectId));

    expect(data.project.id).toBe(projectId);
    expect(data.project.pmMemberId).toBe(memberBId);

    const assignedToA = data.assignedTasksByMember[memberAId];
    if (!assignedToA) throw new Error('배정 목록에 인력 키가 없습니다.');
    expect(assignedToA.map((t) => t.id)).toEqual([taskId]);
    expect(assignedToA[0]?.isOwner).toBe(true); // 책임자이면서 참여자여도 한 번만, isOwner 우선
    expect(assignedToA[0]?.yearId).toBe(yearId);
    expect(assignedToA[0]?.title).toBe('팀 배정 대상 작업');

    // 참여자로만 들어간 인력은 isOwner=false
    expect(data.assignedTasksByMember[memberBId]?.[0]?.isOwner).toBe(false);

    // 배정이 없는 인력도 빈 배열 키를 갖는다
    const idle = unwrap(await team.createMember(projectId, { name: '배정없음' }));
    const after = unwrap(await team.getTeamScreenData(projectId));
    expect(after.assignedTasksByMember[idle.id]).toEqual([]);
  });
});
