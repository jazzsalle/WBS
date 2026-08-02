// Milestone 서버 액션 통합 테스트
// (SOT §9 Milestone·조회 목록, §5.7, §7.8, §8.3 X-1, §8.4 O-1~O-3, §6.6 H-5)
//
// 서버 액션은 쿠키 세션(requireApprovedUser)에서 토큰을 읽으므로 next/headers를
// "실제 세션 토큰을 돌려주는 스텁"으로 바꿔 액션을 가드까지 포함해 그대로 호출한다
// (goal-actions.test.ts와 같은 방식). revalidatePath는 요청 컨텍스트 밖이라 스텁한다.
//
// 검증의 핵심 두 가지:
//  1. 과제 경계 — yearId·ownerMemberId는 FK가 과제를 강제하지 않는다. 앱이 막지 못하면
//     남의 과제 연차·인력을 가리키는 마일스톤이 조용히 저장된다.
//  2. 기본 마일스톤 자동 생성(§7.8)의 멱등성과 날짜 규칙 — 재실행이 중복을 만들거나
//     종료일 없는 연차에 임의 날짜를 지어내면 마감 관리 자체가 무너진다.

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Sql } from 'postgres';
import { connectDirectDb, createTestUser, destroyTestUser, type TestUser } from './helpers';
import type { ActionResult } from '@/types';
import * as milestonesRepo from '@/lib/db/milestones';
import * as stagesRepo from '@/lib/db/stages';
import * as yearsRepo from '@/lib/db/years';

const session = vi.hoisted(() => ({ accessToken: '' }));

vi.mock('next/headers', () => ({
  cookies: async () => ({ get: () => ({ value: session.accessToken }) }),
}));
vi.mock('next/cache', () => ({ revalidatePath: () => undefined }));

const milestones = await import('@/actions/milestones');
const team = await import('@/actions/team');
const { createProject } = await import('@/actions/projects');
const { createYear } = await import('@/actions/years');

let sql: Sql;
let user: TestUser;
const tempProjectIds: string[] = []; // afterAll 안전망 — 이 테스트가 만든 과제만 지운다

let projectId: string;
let year1Id: string;
let memberId: string;

let otherProjectId: string;
let otherYearId: string;
let otherMemberId: string;

// 실패를 조용히 넘기지 않는다 — 실패 코드까지 메시지에 담아 원인을 드러낸다
function unwrap<T>(result: ActionResult<T>): T {
  if (!result.ok) {
    throw new Error(`액션 실패: ${result.error} (code=${result.code ?? '-'})`);
  }
  return result.data;
}

function expectCode(result: ActionResult<unknown>, code: string): string {
  if (result.ok) throw new Error(`실패해야 하는 호출이 통과했습니다 (기대 code=${code}).`);
  expect(result.code).toBe(code);
  return result.error;
}

function expectRuleViolation(result: ActionResult<unknown>): string {
  return expectCode(result, 'RULE');
}

async function newProject(name: string): Promise<string> {
  const project = unwrap(await createProject({ name, contractStartDate: '2026-01-01' }));
  tempProjectIds.push(project.id);
  return project.id;
}

beforeAll(async () => {
  sql = connectDirectDb();
  user = await createTestUser(sql);
  session.accessToken = user.accessToken;

  projectId = await newProject('마일스톤 액션 테스트 과제');
  const firstYear = (await yearsRepo.listYears(user.client, projectId))[0];
  if (!firstYear) throw new Error('createProject가 연차를 만들지 않았습니다.');
  year1Id = firstYear.id;

  memberId = unwrap(await team.createMember(projectId, { name: '김연구' })).id;

  otherProjectId = await newProject('마일스톤 액션 남의 과제');
  const otherYear = (await yearsRepo.listYears(user.client, otherProjectId))[0];
  if (!otherYear) throw new Error('createProject가 연차를 만들지 않았습니다.');
  otherYearId = otherYear.id;
  otherMemberId = unwrap(await team.createMember(otherProjectId, { name: '남의 연구원' })).id;
});

afterAll(async () => {
  for (const id of tempProjectIds) {
    await sql`delete from public.projects where id = ${id}::uuid`;
  }
  await destroyTestUser(sql, user);
  await sql.end();
});

describe('Milestone CRUD 액션 (§9, §5.7)', () => {
  let milestoneId: string;

  it('생성 시 §5.7 기본값을 채운다', async () => {
    const created = unwrap(
      await milestones.createMilestone(projectId, {
        type: 'annual_eval',
        title: '1차년도 연차평가',
        date: '2026-12-15',
        yearId: year1Id,
        ownerMemberId: memberId,
      })
    );
    milestoneId = created.id;

    expect(created.status).toBe('planned');
    expect(created.description).toBe('');
    expect(created.resultNote).toBe('');
    expect(created.version).toBe(1); // N-4 default
  });

  it('유형·제목·날짜는 생략할 수 없고 날짜 형식을 강제한다 (§5.7 date 필수)', async () => {
    const base = { type: 'report', title: '중간보고서', date: '2026-06-30' };
    expectCode(
      await milestones.createMilestone(projectId, { title: base.title, date: base.date }),
      'VALIDATION'
    );
    expectCode(
      await milestones.createMilestone(projectId, { type: base.type, date: base.date }),
      'VALIDATION'
    );
    expectCode(
      await milestones.createMilestone(projectId, { type: base.type, title: base.title }),
      'VALIDATION'
    );
    expectCode(
      await milestones.createMilestone(projectId, { ...base, date: '2026/06/30' }),
      'VALIDATION'
    );
  });

  it('연차 없는 과제 전체 이벤트도 만들 수 있다 (§5.7 yearId null)', async () => {
    const created = unwrap(
      await milestones.createMilestone(projectId, {
        type: 'contract',
        title: '협약 체결',
        date: '2026-01-05',
      })
    );
    expect(created.yearId).toBeNull();
    expect(created.ownerMemberId).toBeNull();

    unwrap(await milestones.deleteMilestone(created.id));
  });

  it('다른 과제의 연차·담당자는 거부한다 (FK는 과제 경계를 막지 못한다)', async () => {
    const base = { type: 'demo', title: '시연회', date: '2026-08-01' };

    const yearMessage = expectRuleViolation(
      await milestones.createMilestone(projectId, { ...base, yearId: otherYearId })
    );
    expect(yearMessage).toContain('연차');
    expectRuleViolation(
      await milestones.createMilestone(projectId, { ...base, ownerMemberId: otherMemberId })
    );

    // 거부됐으므로 행이 만들어지지 않아야 한다
    const list = await milestonesRepo.listMilestones(user.client, projectId);
    expect(list.map((m) => m.id)).toEqual([milestoneId]);
  });

  it('수정은 낙관적 잠금을 건다 (O-1, O-3)', async () => {
    const before = await milestonesRepo.getMilestoneById(user.client, milestoneId);
    const updated = unwrap(
      await milestones.updateMilestone(
        milestoneId,
        { title: '1차년도 연차평가(확정)', date: '2026-12-20', description: '평가위원 5인' },
        before.version
      )
    );
    expect(updated.title).toBe('1차년도 연차평가(확정)');
    expect(updated.date).toBe('2026-12-20');
    expect(updated.version).toBe(before.version + 1); // N-5 트리거

    // 같은(이제는 낡은) version으로 다시 저장하면 STALE이다
    const message = expectCode(
      await milestones.updateMilestone(milestoneId, { title: '덮어쓰기' }, before.version),
      'STALE'
    );
    expect(message).toContain('먼저 수정했습니다'); // O-3

    // 실패한 저장이 내용을 바꾸지 않았는지 확인한다
    const after = await milestonesRepo.getMilestoneById(user.client, milestoneId);
    expect(after.title).toBe('1차년도 연차평가(확정)');
  });

  it('수정에서도 다른 과제의 연차·담당자를 거부한다', async () => {
    expectRuleViolation(await milestones.updateMilestone(milestoneId, { yearId: otherYearId }));
    expectRuleViolation(
      await milestones.updateMilestone(milestoneId, { ownerMemberId: otherMemberId })
    );

    const after = await milestonesRepo.getMilestoneById(user.client, milestoneId);
    expect(after.yearId).toBe(year1Id);
    expect(after.ownerMemberId).toBe(memberId);
  });

  it('상태 변경은 결과 메모를 함께 갱신한다 (§7.8, O-2: 잠금 없음)', async () => {
    const updated = unwrap(
      await milestones.setMilestoneStatus(milestoneId, 'done', '조건부 통과 — 지적사항 3건')
    );
    expect(updated.status).toBe('done');
    expect(updated.resultNote).toBe('조건부 통과 — 지적사항 3건');

    // 메모를 생략하면 기존 메모를 유지한다 (상태만 바꾸는 조작이 메모를 지우면 안 된다)
    const again = unwrap(await milestones.setMilestoneStatus(milestoneId, 'delayed'));
    expect(again.status).toBe('delayed');
    expect(again.resultNote).toBe('조건부 통과 — 지적사항 3건');

    expectCode(await milestones.setMilestoneStatus(milestoneId, 'finished'), 'VALIDATION');
  });

  it('삭제하면 목록에서 사라지고 두 번 지울 수 없다', async () => {
    unwrap(await milestones.deleteMilestone(milestoneId));
    const list = await milestonesRepo.listMilestones(user.client, projectId);
    expect(list).toEqual([]);

    const failed = await milestones.deleteMilestone(milestoneId);
    if (failed.ok) throw new Error('이미 지운 마일스톤 삭제가 통과했습니다.');
    expect(failed.code).toBeUndefined(); // NotFound — §9 코드 체계에 NOT_FOUND가 없다
  });
});

// §7.8 자동 생성 대상은 정확히 2건(연차평가, 연차실적계획서 제출)이다.
// CRUD 테스트와 건수가 얽히지 않도록 별도 과제를 쓴다.
describe('generateDefaultMilestones (§7.8, X-1)', () => {
  let genProjectId: string;
  let genStageId: string;
  let namedYearId: string; // name='2차년도', endDate 있음
  let noEndDateYearId: string; // endDate 없음

  async function milestonesOfYear(pid: string, yearId: string) {
    const list = await milestonesRepo.listMilestones(user.client, pid);
    return list.filter((m) => m.yearId === yearId);
  }

  beforeAll(async () => {
    genProjectId = await newProject('기본 마일스톤 생성 과제');
    const stage = (await stagesRepo.listStages(user.client, genProjectId))[0];
    if (!stage) throw new Error('createProject가 단계를 만들지 않았습니다.');
    genStageId = stage.id;

    namedYearId = unwrap(
      await createYear(genStageId, { name: '2차년도', startDate: '2027-01-01', endDate: '2027-12-31' })
    ).id;
    noEndDateYearId = unwrap(await createYear(genStageId, { name: '3차년도' })).id;
  });

  it('연차평가 + 연차실적계획서 제출 2건을 연차 종료일로 만든다', async () => {
    const created = unwrap(await milestones.generateDefaultMilestones(namedYearId));
    expect(created.length).toBe(2);

    const byType = new Map(created.map((m) => [m.type, m]));
    const evaluation = byType.get('annual_eval');
    const report = byType.get('report');
    if (!evaluation || !report) throw new Error('기본 마일스톤 2종이 만들어지지 않았습니다.');

    expect(evaluation.title).toBe('2차년도 연차평가');
    expect(report.title).toBe('2차년도 연차실적계획서 제출');
    // 날짜 오프셋을 지어내지 않는다 — 인자가 없으면 연차 종료일 그대로다
    expect(evaluation.date).toBe('2027-12-31');
    expect(report.date).toBe('2027-12-31');

    for (const milestone of [evaluation, report]) {
      expect(milestone.projectId).toBe(genProjectId);
      expect(milestone.yearId).toBe(namedYearId);
      expect(milestone.status).toBe('planned');
      expect(milestone.ownerMemberId).toBeNull();
      expect(milestone.description).toBe('');
      expect(milestone.resultNote).toBe('');
    }
  });

  it('재실행해도 늘어나지 않는다 (멱등 — 같은 연차의 같은 유형은 건너뛴다)', async () => {
    const again = unwrap(await milestones.generateDefaultMilestones(namedYearId));
    expect(again).toEqual([]);
    expect((await milestonesOfYear(genProjectId, namedYearId)).length).toBe(2);
  });

  it('사용자가 날짜를 고쳐도 재실행이 되살리지 않는다', async () => {
    const list = await milestonesOfYear(genProjectId, namedYearId);
    const evaluation = list.find((m) => m.type === 'annual_eval');
    if (!evaluation) throw new Error('연차평가 마일스톤이 없습니다.');

    unwrap(await milestones.updateMilestone(evaluation.id, { date: '2028-01-20' }, evaluation.version));
    expect(unwrap(await milestones.generateDefaultMilestones(namedYearId))).toEqual([]);

    const after = await milestonesOfYear(genProjectId, namedYearId);
    expect(after.length).toBe(2);
    expect(after.find((m) => m.type === 'annual_eval')?.date).toBe('2028-01-20');
  });

  it('연차명이 비면 유형명만 제목으로 쓴다 (createProject 기본 연차)', async () => {
    const firstYear = (await yearsRepo.listYears(user.client, genProjectId))[0];
    if (!firstYear) throw new Error('createProject가 연차를 만들지 않았습니다.');
    expect(firstYear.name).toBe(''); // §5.5 표시 폴백은 화면 몫이다

    const created = unwrap(await milestones.generateDefaultMilestones(firstYear.id));
    expect(created.map((m) => m.title).sort()).toEqual(['연차실적계획서 제출', '연차평가']);
  });

  it('종료일이 없으면 날짜를 지어내지 않고 실패한다 (부분 삽입 없음)', async () => {
    const message = expectRuleViolation(
      await milestones.generateDefaultMilestones(noEndDateYearId)
    );
    expect(message).toContain('연차 종료일');
    expect(await milestonesOfYear(genProjectId, noEndDateYearId)).toEqual([]);
  });

  it('종료일이 없어도 날짜를 직접 지정하면 만든다 (§7.8 수정 가능)', async () => {
    const created = unwrap(
      await milestones.generateDefaultMilestones(noEndDateYearId, {
        annualEvalDate: '2029-01-31',
        reportDate: '2029-02-15',
      })
    );
    expect(created.length).toBe(2);

    const byType = new Map(created.map((m) => [m.type, m.date]));
    expect(byType.get('annual_eval')).toBe('2029-01-31');
    expect(byType.get('report')).toBe('2029-02-15');
  });

  it('없는 연차와 잘못된 날짜 형식은 거부한다', async () => {
    const missing = await milestones.generateDefaultMilestones(
      '00000000-0000-4000-8000-000000000000'
    );
    if (missing.ok) throw new Error('없는 연차에 대한 생성이 통과했습니다.');

    expectCode(
      await milestones.generateDefaultMilestones(namedYearId, { reportDate: '2027.12.31' }),
      'VALIDATION'
    );
  });

  // H-5: 연차를 지워도 마일스톤은 year_id=null로 남는다 (N-8)
  it('연차를 삭제해도 마일스톤은 연차 없음 상태로 남는다', async () => {
    const before = await milestonesOfYear(genProjectId, noEndDateYearId);
    expect(before.length).toBe(2);

    await yearsRepo.deleteYear(user.client, noEndDateYearId);

    const all = await milestonesRepo.listMilestones(user.client, genProjectId);
    const orphans = all.filter((m) => before.some((b) => b.id === m.id));
    expect(orphans.length).toBe(2);
    expect(orphans.every((m) => m.yearId === null)).toBe(true);
  });
});

describe('getMilestonesData (§9 조회, §7.8)', () => {
  it('마일스톤·연차·인력·알림 기준일을 함께 싣는다', async () => {
    const created = unwrap(
      await milestones.createMilestone(projectId, {
        type: 'progress_check',
        title: '상반기 진도점검',
        date: '2026-07-01',
        yearId: year1Id,
        ownerMemberId: memberId,
      })
    );

    const data = unwrap(await milestones.getMilestonesData(projectId));
    expect(data.projectId).toBe(projectId);
    expect(data.milestones.map((m) => m.id)).toEqual([created.id]);
    expect(data.years.map((y) => y.id)).toContain(year1Id);
    expect(data.members.map((m) => m.id)).toEqual([memberId]);
    expect(data.milestoneAlertDays).toBeGreaterThan(0); // §5.16 기본 30

    unwrap(await milestones.deleteMilestone(created.id));
  });

  it('마일스톤이 없는 과제도 실패가 아니라 빈 목록을 돌려준다', async () => {
    const emptyProjectId = await newProject('마일스톤 없는 과제');
    const data = unwrap(await milestones.getMilestonesData(emptyProjectId));

    expect(data.milestones).toEqual([]);
    expect(data.members).toEqual([]);
    expect(data.years.length).toBe(1); // createProject가 만든 기본 연차
  });

  it('날짜순으로 정렬해 싣는다 (§7.8 타임라인)', async () => {
    const dates = ['2026-11-01', '2026-03-15', '2026-07-20'];
    const ids: string[] = [];
    for (const date of dates) {
      ids.push(
        unwrap(
          await milestones.createMilestone(projectId, { type: 'custom', title: `이벤트 ${date}`, date })
        ).id
      );
    }

    const data = unwrap(await milestones.getMilestonesData(projectId));
    expect(data.milestones.map((m) => m.date)).toEqual([...dates].sort());

    for (const id of ids) unwrap(await milestones.deleteMilestone(id));
  });
});
