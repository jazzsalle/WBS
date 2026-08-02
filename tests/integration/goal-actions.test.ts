// Deliverable·TechTarget 서버 액션 통합 테스트
// (SOT §9 Deliverable/TechTarget/조회 목록, §5.8, §5.9, §5.1 N-13, §6.2, §6.3, §8.4 O-1·O-3)
//
// 서버 액션은 쿠키 세션(requireApprovedUser)에서 토큰을 읽으므로 next/headers를
// "실제 세션 토큰을 돌려주는 스텁"으로 바꿔 액션을 가드까지 포함해 그대로 호출한다
// (team-actions.test.ts와 같은 방식). revalidatePath는 요청 컨텍스트 밖이라 스텁한다.
//
// 검증의 핵심은 과제 경계다: 기관·인력은 FK가 과제를 강제하지 않고, targetByYear의
// yearId 키는 FK 자체가 없다(N-13). 앱이 막지 못하면 남의 과제 연차·인력을 가리키는
// 목표가 조용히 저장된다.

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Sql } from 'postgres';
import { connectDirectDb, createTestUser, destroyTestUser, type TestUser } from './helpers';
import type { ActionResult } from '@/types';
import * as deliverablesRepo from '@/lib/db/deliverables';
import * as techTargetsRepo from '@/lib/db/tech-targets';
import * as stagesRepo from '@/lib/db/stages';
import * as yearsRepo from '@/lib/db/years';
import { NotFoundError, StaleDataError } from '@/lib/db/errors';

const session = vi.hoisted(() => ({ accessToken: '' }));

vi.mock('next/headers', () => ({
  cookies: async () => ({ get: () => ({ value: session.accessToken }) }),
}));
vi.mock('next/cache', () => ({ revalidatePath: () => undefined }));

const goals = await import('@/actions/goals');
const team = await import('@/actions/team');
const { createProject } = await import('@/actions/projects');
const { createYear } = await import('@/actions/years');

let sql: Sql;
let user: TestUser;
const tempProjectIds: string[] = []; // afterAll 안전망 — 이 테스트가 만든 과제만 지운다

let projectId: string;
let year1Id: string;
let year2Id: string;
let orgId: string;
let memberId: string;

let otherProjectId: string;
let otherYearId: string;
let otherOrgId: string;
let otherMemberId: string;

let deliverableId: string; // CRUD 대상 성과목표
let techTargetId: string; // CRUD 대상 기술목표

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

function expectCode(result: ActionResult<unknown>, code: string): string {
  if (result.ok) throw new Error(`실패해야 하는 호출이 통과했습니다 (기대 code=${code}).`);
  expect(result.code).toBe(code);
  return result.error;
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

  projectId = await newProject('목표 액션 테스트 과제');
  const firstYear = (await yearsRepo.listYears(user.client, projectId))[0];
  if (!firstYear) throw new Error('createProject가 연차를 만들지 않았습니다.');
  year1Id = firstYear.id;

  const stage = (await stagesRepo.listStages(user.client, projectId))[0];
  if (!stage) throw new Error('createProject가 단계를 만들지 않았습니다.');
  year2Id = unwrap(await createYear(stage.id, { name: '2차년도' })).id;

  orgId = unwrap(await team.createOrganization(projectId, { name: '주관연구소', role: 'lead' })).id;
  memberId = unwrap(await team.createMember(projectId, { name: '김연구' })).id;

  otherProjectId = await newProject('목표 액션 남의 과제');
  const otherYear = (await yearsRepo.listYears(user.client, otherProjectId))[0];
  if (!otherYear) throw new Error('createProject가 연차를 만들지 않았습니다.');
  otherYearId = otherYear.id;
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

describe('Deliverable 액션 (§9, §5.8, H-10)', () => {
  it('생성 시 단위 기본값과 목록 마지막 순서를 채운다', async () => {
    const created = unwrap(
      await goals.createDeliverable(projectId, {
        type: 'paper_sci',
        name: 'SCI급 논문 게재',
        targetTotal: 4,
        targetByYear: { [year1Id]: 1, [year2Id]: 3 },
        orgId,
      })
    );
    deliverableId = created.id;

    expect(created.unit).toBe('건'); // §5.8 기본 '건'
    expect(created.order).toBe(0); // H-10: 첫 항목은 0
    expect(created.targetByYear).toEqual({ [year1Id]: 1, [year2Id]: 3 });
    expect(created.achievements).toEqual([]);
  });

  it('유형은 생략할 수 없다 (DB 기본값 없음)', async () => {
    expectCode(await goals.createDeliverable(projectId, { name: '유형없음' }), 'VALIDATION');
  });

  it('목표 건수는 0 이상 정수만 받는다', async () => {
    expectCode(
      await goals.createDeliverable(projectId, { type: 'other', name: '소수목표', targetTotal: 1.5 }),
      'VALIDATION'
    );
    expectCode(
      await goals.createDeliverable(projectId, { type: 'other', name: '음수목표', targetTotal: -1 }),
      'VALIDATION'
    );
    expectCode(
      await goals.createDeliverable(projectId, {
        type: 'other',
        name: '연차목표 소수',
        targetByYear: { [year1Id]: 0.5 },
      }),
      'VALIDATION'
    );
  });

  it('다른 과제의 기관·연차는 거부한다 (N-13: targetByYear 키에 FK가 없다)', async () => {
    expectRuleViolation(
      await goals.createDeliverable(projectId, { type: 'other', name: '남의 기관', orgId: otherOrgId })
    );
    const message = expectRuleViolation(
      await goals.createDeliverable(projectId, {
        type: 'other',
        name: '남의 연차',
        targetByYear: { [otherYearId]: 1 },
      })
    );
    expect(message).toContain('연차');

    // 거부됐으므로 행이 만들어지지 않아야 한다
    const list = await deliverablesRepo.listDeliverables(user.client, projectId);
    expect(list.map((d) => d.id)).toEqual([deliverableId]);
  });

  it('수정은 낙관적 잠금을 건다 (O-1)', async () => {
    const before = await deliverablesRepo.getDeliverableById(user.client, deliverableId);
    const updated = unwrap(
      await goals.updateDeliverable(deliverableId, { note: '학술지 게재 기준' }, before.version)
    );
    expect(updated.note).toBe('학술지 게재 기준');

    const stale = await goals.updateDeliverable(deliverableId, { unit: '편' }, before.version);
    expectCode(stale, 'STALE');
  });

  it('수정에서도 다른 과제의 기관·연차를 거부한다', async () => {
    expectRuleViolation(await goals.updateDeliverable(deliverableId, { orgId: otherOrgId }));
    expectRuleViolation(
      await goals.updateDeliverable(deliverableId, { targetByYear: { [otherYearId]: 2 } })
    );
  });

  it('연차별 목표는 통째로 교체하고, 합계 불일치(D-3)는 저장을 막지 않는다', async () => {
    const updated = unwrap(
      await goals.setDeliverableYearTargets(deliverableId, { [year1Id]: 1 })
    );
    // 통째 교체 — year2 키는 사라진다 (셀을 비우는 조작이 표현돼야 한다)
    expect(updated.targetByYear).toEqual({ [year1Id]: 1 });
    expect(updated.targetTotal).toBe(4); // Σ(1) ≠ 4 이지만 저장은 허용 (D-3)

    expectRuleViolation(
      await goals.setDeliverableYearTargets(deliverableId, { [otherYearId]: 1 })
    );

    // 원복
    unwrap(await goals.setDeliverableYearTargets(deliverableId, { [year1Id]: 1, [year2Id]: 3 }));
  });

  it('재정렬은 0..n-1로 정규화하고 다른 과제 항목이 섞이면 거부한다 (H-10, X-3)', async () => {
    const second = unwrap(
      await goals.createDeliverable(projectId, { type: 'sw_registration', name: 'SW 등록' })
    );
    expect(second.order).toBe(1);

    const foreign = unwrap(
      await goals.createDeliverable(otherProjectId, { type: 'other', name: '남의 성과' })
    );
    expectRuleViolation(
      await goals.reorderDeliverables(projectId, [second.id, foreign.id, deliverableId])
    );

    unwrap(await goals.reorderDeliverables(projectId, [second.id, deliverableId]));
    const list = await deliverablesRepo.listDeliverables(user.client, projectId);
    expect(list.map((d) => d.id)).toEqual([second.id, deliverableId]);
    expect(list.map((d) => d.order)).toEqual([0, 1]);

    unwrap(await goals.deleteDeliverable(second.id));
    unwrap(await goals.deleteDeliverable(foreign.id));
  });
});

describe('DeliverableAchievement 액션 (§5.8, N-2, D-4)', () => {
  let achievementId: string;

  it('같은 과제의 기관·인력·연차로 실적을 등록한다', async () => {
    const created = unwrap(
      await goals.addAchievement(deliverableId, {
        title: '딥러닝 기반 결함 검출',
        date: '2026-05-20',
        yearId: year1Id,
        orgId,
        memberIds: [memberId],
        evidenceUrl: 'https://doi.org/10.1000/example',
      })
    );
    achievementId = created.id;

    expect(created.memberIds).toEqual([memberId]);
    expect(created.note).toBe('');

    const deliverable = await deliverablesRepo.getDeliverableById(user.client, deliverableId);
    expect(deliverable.achievements.map((a) => a.id)).toEqual([achievementId]);
  });

  it('달성일 없는 실적은 만들 수 없다 (D-4 연차 집계의 근거)', async () => {
    expectCode(await goals.addAchievement(deliverableId, { title: '날짜없음' }), 'VALIDATION');
    expectCode(
      await goals.addAchievement(deliverableId, { title: '형식오류', date: '2026/05/20' }),
      'VALIDATION'
    );
  });

  it('다른 과제의 인력·기관·연차는 거부한다', async () => {
    const base = { title: '경계 검증', date: '2026-06-01' };
    expectRuleViolation(
      await goals.addAchievement(deliverableId, { ...base, memberIds: [otherMemberId] })
    );
    expectRuleViolation(await goals.addAchievement(deliverableId, { ...base, orgId: otherOrgId }));
    expectRuleViolation(await goals.addAchievement(deliverableId, { ...base, yearId: otherYearId }));

    // 차단됐으므로 실적이 늘지 않아야 한다
    const deliverable = await deliverablesRepo.getDeliverableById(user.client, deliverableId);
    expect(deliverable.achievements.length).toBe(1);
  });

  it('실적 수정은 낙관적 잠금을 건다 (O-1, O-3)', async () => {
    const updated = unwrap(
      await goals.updateAchievement(deliverableId, achievementId, { note: '게재 확정' }, 1)
    );
    expect(updated.note).toBe('게재 확정');
    expect(updated.memberIds).toEqual([memberId]); // memberIds 미지정이면 기존 조인을 유지한다

    // version이 2로 올라갔으므로 같은 기준으로 다시 저장하면 STALE이다
    const message = expectCode(
      await goals.updateAchievement(deliverableId, achievementId, { note: '덮어쓰기' }, 1),
      'STALE'
    );
    expect(message).toContain('먼저 수정했습니다'); // O-3
  });

  it('다른 성과목표의 실적 id로는 수정·삭제할 수 없다', async () => {
    const other = unwrap(
      await goals.createDeliverable(projectId, { type: 'other', name: '무관한 지표' })
    );

    const failed = await goals.updateAchievement(other.id, achievementId, { note: '남의 실적' });
    if (failed.ok) throw new Error('다른 지표의 실적 수정이 통과했습니다.');
    expect(failed.code).toBeUndefined(); // NotFound — §9 코드 체계에 NOT_FOUND가 없다

    const deleteFailed = await goals.deleteAchievement(other.id, achievementId);
    if (deleteFailed.ok) throw new Error('다른 지표의 실적 삭제가 통과했습니다.');

    // 실적은 그대로 남아 있어야 한다
    const deliverable = await deliverablesRepo.getDeliverableById(user.client, deliverableId);
    expect(deliverable.achievements.length).toBe(1);

    unwrap(await goals.deleteDeliverable(other.id));
  });

  it('실적을 지우면 목록에서 사라진다', async () => {
    unwrap(await goals.deleteAchievement(deliverableId, achievementId));
    const deliverable = await deliverablesRepo.getDeliverableById(user.client, deliverableId);
    expect(deliverable.achievements).toEqual([]);
  });
});

describe('TechTarget 액션 (§9, §5.9)', () => {
  it('생성 시 §5.9 기본값을 채운다', async () => {
    const created = unwrap(
      await goals.createTechTarget(projectId, {
        name: '객체 인식 정확도',
        unit: '%',
        weight: 50,
        targetValue: 90,
        baselineDomestic: 75,
        targetByYear: { [year1Id]: 80, [year2Id]: 90 },
      })
    );
    techTargetId = created.id;

    expect(created.direction).toBe('higher_better');
    expect(created.measureMethod).toBe('self');
    expect(created.order).toBe(0);
    expect(created.records).toEqual([]);
  });

  it('목표치는 소수를 허용하고 비중은 음수를 거부한다 (§5.9 numeric, T-3)', async () => {
    const fractional = unwrap(
      await goals.createTechTarget(projectId, {
        name: '추론 지연시간',
        unit: 'ms',
        direction: 'lower_better',
        weight: 30,
        targetValue: 49.5, // 측정치는 건수가 아니다 — 소수가 정상
        baselineDomestic: 200,
      })
    );
    expect(fractional.targetValue).toBe(49.5);

    expectCode(
      await goals.createTechTarget(projectId, { name: '음수비중', weight: -1 }),
      'VALIDATION'
    );

    unwrap(await goals.deleteTechTarget(fractional.id));
  });

  it('다른 과제의 기관·연차는 거부한다 (N-13)', async () => {
    expectRuleViolation(
      await goals.createTechTarget(projectId, { name: '남의 기관', orgId: otherOrgId })
    );
    expectRuleViolation(
      await goals.createTechTarget(projectId, {
        name: '남의 연차',
        targetByYear: { [otherYearId]: 10 },
      })
    );
    expectRuleViolation(
      await goals.setTechTargetYearTargets(techTargetId, { [otherYearId]: 10 })
    );
  });

  it('수정은 낙관적 잠금을 건다 (O-1)', async () => {
    const before = await techTargetsRepo.getTechTargetById(user.client, techTargetId);
    const updated = unwrap(
      await goals.updateTechTarget(techTargetId, { measureMethod: 'certified_lab' }, before.version)
    );
    expect(updated.measureMethod).toBe('certified_lab');

    expectCode(
      await goals.updateTechTarget(techTargetId, { unit: 'percent' }, before.version),
      'STALE'
    );
  });

  it('재정렬은 0..n-1로 정규화하고 다른 과제 항목이 섞이면 거부한다 (H-10, X-3)', async () => {
    const second = unwrap(await goals.createTechTarget(projectId, { name: '동시 처리 채널 수' }));
    const foreign = unwrap(await goals.createTechTarget(otherProjectId, { name: '남의 기술목표' }));

    expectRuleViolation(
      await goals.reorderTechTargets(projectId, [second.id, foreign.id, techTargetId])
    );

    unwrap(await goals.reorderTechTargets(projectId, [second.id, techTargetId]));
    const list = await techTargetsRepo.listTechTargets(user.client, projectId);
    expect(list.map((t) => t.id)).toEqual([second.id, techTargetId]);
    expect(list.map((t) => t.order)).toEqual([0, 1]);

    unwrap(await goals.deleteTechTarget(second.id));
    unwrap(await goals.deleteTechTarget(foreign.id));
  });
});

describe('TechTargetRecord 액션 (§5.9, §6.3)', () => {
  let recordId: string;

  it('측정 방법을 생략하면 항목의 기본 측정방법을 따른다 (T-4 판정 기준과 일치)', async () => {
    const created = unwrap(
      await goals.addTechRecord(techTargetId, { value: 85, date: '2026-06-30', yearId: year1Id })
    );
    recordId = created.id;

    expect(created.method).toBe('certified_lab'); // 항목이 certified_lab이다
    expect(created.evaluator).toBe('');
  });

  it('측정값과 측정일은 생략할 수 없다 (기본값 0이 실적치로 굳는 것을 막는다)', async () => {
    expectCode(await goals.addTechRecord(techTargetId, { date: '2026-07-01' }), 'VALIDATION');
    expectCode(await goals.addTechRecord(techTargetId, { value: 90 }), 'VALIDATION');
  });

  it('다른 과제의 연차는 거부한다 (N-13)', async () => {
    expectRuleViolation(
      await goals.addTechRecord(techTargetId, { value: 88, date: '2026-07-01', yearId: otherYearId })
    );
    expectRuleViolation(
      await goals.updateTechRecord(techTargetId, recordId, { yearId: otherYearId })
    );
  });

  it('측정 이력 수정은 낙관적 잠금을 건다 (O-1)', async () => {
    const updated = unwrap(
      await goals.updateTechRecord(techTargetId, recordId, { evaluator: '한국인정기구' }, 1)
    );
    expect(updated.evaluator).toBe('한국인정기구');

    expectCode(
      await goals.updateTechRecord(techTargetId, recordId, { value: 86 }, 1),
      'STALE'
    );
  });

  it('다른 기술목표의 측정 이력 id로는 수정·삭제할 수 없다', async () => {
    const other = unwrap(await goals.createTechTarget(projectId, { name: '무관한 항목' }));

    const failed = await goals.updateTechRecord(other.id, recordId, { note: '남의 이력' });
    if (failed.ok) throw new Error('다른 항목의 측정 이력 수정이 통과했습니다.');
    const deleteFailed = await goals.deleteTechRecord(other.id, recordId);
    if (deleteFailed.ok) throw new Error('다른 항목의 측정 이력 삭제가 통과했습니다.');

    expect((await techTargetsRepo.getTechTargetById(user.client, techTargetId)).records.length).toBe(1);
    unwrap(await goals.deleteTechTarget(other.id));
  });

  it('측정 이력을 지우면 목록에서 사라진다', async () => {
    unwrap(await goals.deleteTechRecord(techTargetId, recordId));
    expect((await techTargetsRepo.getTechTargetById(user.client, techTargetId)).records).toEqual([]);
  });
});

// 달성률은 저장하지 않는다 (O-4). getGoalsData가 lib/goals.ts로 계산해 싣는지,
// 부록 B의 기대값과 맞는지 확인한다. 앞 describe의 CRUD와 얽히지 않도록 별도 과제를 쓴다.
describe('getGoalsData (§9 조회, §6.2, §6.3, 부록 B.2)', () => {
  let summaryProjectId: string;
  let sy1: string;
  let sy2: string;

  beforeAll(async () => {
    summaryProjectId = await newProject('목표 집계 검증 과제');
    const firstYear = (await yearsRepo.listYears(user.client, summaryProjectId))[0];
    if (!firstYear) throw new Error('createProject가 연차를 만들지 않았습니다.');
    sy1 = firstYear.id;
    const stage = (await stagesRepo.listStages(user.client, summaryProjectId))[0];
    if (!stage) throw new Error('createProject가 단계를 만들지 않았습니다.');
    sy2 = unwrap(await createYear(stage.id, { name: '2차년도' })).id;

    // ─ 성과목표 4종 (D-1~D-5를 모두 밟는다)
    const paper = unwrap(
      await goals.createDeliverable(summaryProjectId, {
        type: 'paper_sci',
        name: 'SCI 논문',
        targetTotal: 4,
        targetByYear: { [sy1]: 1, [sy2]: 3 },
      })
    );
    for (const [title, date, yearId] of [
      ['논문 A', '2026-03-01', sy1],
      ['논문 B', '2027-03-01', sy2],
      ['논문 C', '2027-06-01', null],
    ] as const) {
      unwrap(await goals.addAchievement(paper.id, { title, date, yearId }));
    }

    // D-5: 1차년도 목표가 0인데 실적이 있다 → "목표 외 달성"
    const sw = unwrap(
      await goals.createDeliverable(summaryProjectId, {
        type: 'sw_registration',
        name: 'SW 등록',
        targetTotal: 2,
        targetByYear: { [sy1]: 0, [sy2]: 2 },
      })
    );
    unwrap(await goals.addAchievement(sw.id, { title: 'SW A', date: '2026-09-01', yearId: sy1 }));

    // D-3: Σ targetByYear(2) ≠ targetTotal(6)
    unwrap(
      await goals.createDeliverable(summaryProjectId, {
        type: 'patent_dom_apply',
        name: '국내 특허 출원',
        targetTotal: 6,
        targetByYear: { [sy1]: 2 },
      })
    );

    // D-1: targetTotal 0 → 달성률 N/A
    unwrap(
      await goals.createDeliverable(summaryProjectId, {
        type: 'other',
        name: '목표 미설정 지표',
        targetTotal: 0,
      })
    );

    // ─ 기술목표 3종 (부록 B.2 그대로)
    const accuracy = unwrap(
      await goals.createTechTarget(summaryProjectId, {
        name: '객체 인식 정확도',
        unit: '%',
        direction: 'higher_better',
        weight: 50,
        baselineDomestic: 75,
        targetValue: 90,
        measureMethod: 'certified_lab',
      })
    );
    unwrap(await goals.addTechRecord(accuracy.id, { value: 85, date: '2026-06-30' }));

    const latency = unwrap(
      await goals.createTechTarget(summaryProjectId, {
        name: '추론 지연시간',
        unit: 'ms',
        direction: 'lower_better',
        weight: 30,
        baselineDomestic: 200,
        targetValue: 50,
      })
    );
    unwrap(await goals.addTechRecord(latency.id, { value: 80, date: '2026-06-30' }));

    unwrap(
      await goals.createTechTarget(summaryProjectId, {
        name: '동시 처리 채널 수',
        unit: '채널',
        direction: 'higher_better',
        weight: 20,
        baselineDomestic: 4,
        targetValue: 16,
      })
    );
  });

  it('연차·기관·인력 목록을 함께 싣는다', async () => {
    const data = unwrap(await goals.getGoalsData(summaryProjectId));
    expect(data.projectId).toBe(summaryProjectId);
    expect(data.years.map((y) => y.id)).toEqual([sy1, sy2]);
    expect(data.organizations).toEqual([]);
    expect(data.members).toEqual([]);
  });

  it('성과목표 달성률과 D-3·D-5 경고를 계산해 싣는다 (§6.2)', async () => {
    const data = unwrap(await goals.getGoalsData(summaryProjectId));

    const paper = data.deliverables.find((d) => d.deliverable.name === 'SCI 논문');
    if (!paper) throw new Error('성과목표가 조회되지 않았습니다.');
    expect(paper.achievedTotal).toBe(3);
    expect(paper.rate).toBe(75); // 3/4
    expect(paper.yearTargetMismatch).toBe(false);
    // D-4: yearId가 null인 실적은 연차 집계에서 빠지고 전체에만 들어간다
    expect(paper.byYear[sy1]).toEqual({ target: 1, achieved: 1, rate: 100, offTarget: false });
    expect(paper.byYear[sy2]?.achieved).toBe(1);
    expect(paper.byYear[sy2]?.rate).toBeCloseTo(33.3333, 4);

    const sw = data.deliverables.find((d) => d.deliverable.name === 'SW 등록');
    if (!sw) throw new Error('성과목표가 조회되지 않았습니다.');
    // D-5: 목표 0인데 실적이 있으면 달성률은 N/A이고 "목표 외 달성"으로 표시한다
    expect(sw.byYear[sy1]).toEqual({ target: 0, achieved: 1, rate: null, offTarget: true });
    expect(sw.byYear[sy2]).toEqual({ target: 2, achieved: 0, rate: 0, offTarget: false });

    const patent = data.deliverables.find((d) => d.deliverable.name === '국내 특허 출원');
    expect(patent?.yearTargetMismatch).toBe(true); // D-3
    // 목표가 없는 연차도 키를 갖는다 (UI 폴백 분기 제거)
    expect(patent?.byYear[sy2]).toEqual({ target: null, achieved: 0, rate: null, offTarget: false });

    const empty = data.deliverables.find((d) => d.deliverable.name === '목표 미설정 지표');
    expect(empty?.rate).toBeNull(); // D-1
  });

  it('전체 성과 집계는 단순 합산이고 유형별로도 집계한다 (§6.2, §7.7)', async () => {
    const data = unwrap(await goals.getGoalsData(summaryProjectId));

    expect(data.deliverableSummary.targetTotal).toBe(12); // 4 + 2 + 6 + 0
    expect(data.deliverableSummary.achievedTotal).toBe(4); // 3 + 1
    expect(data.deliverableSummary.rate).toBeCloseTo(33.3333, 4);

    const byType = new Map(data.deliverableSummary.byType.map((b) => [b.type, b]));
    expect(byType.get('paper_sci')).toEqual({ type: 'paper_sci', target: 4, achieved: 3 });
    expect(byType.get('sw_registration')).toEqual({ type: 'sw_registration', target: 2, achieved: 1 });
    expect(byType.get('patent_dom_apply')).toEqual({
      type: 'patent_dom_apply',
      target: 6,
      achieved: 0,
    });
  });

  it('기술목표 달성률은 부록 B.2와 같다 (P-8: 중간값을 반올림하지 않는다)', async () => {
    const data = unwrap(await goals.getGoalsData(summaryProjectId));
    const byName = new Map(data.techTargets.map((t) => [t.techTarget.name, t]));

    const accuracy = byName.get('객체 인식 정확도');
    expect(accuracy?.current).toBe(85);
    expect(accuracy?.rate).toBeCloseTo(66.6667, 4);
    expect(accuracy?.evaluatorMissing).toBe(true); // T-4: certified_lab인데 평가기관이 비었다

    const latency = byName.get('추론 지연시간');
    expect(latency?.current).toBe(80);
    expect(latency?.rate).toBe(80); // (200−80)/(200−50)

    const channels = byName.get('동시 처리 채널 수');
    expect(channels?.current).toBeNull();
    expect(channels?.rate).toBeNull(); // 미측정

    // 미측정은 달성률 0으로 보되 분모(weight)에는 남는다
    expect(data.techSummary.weightSum).toBe(100);
    expect(data.techSummary.weightMismatch).toBe(false);
    expect(data.techSummary.weightedRate).toBeCloseTo(57.3333, 4);
  });

  it('비중 합계가 100이 아니면 경고를 싣는다 (T-3)', async () => {
    const extra = unwrap(
      await goals.createTechTarget(summaryProjectId, { name: '초과 비중 항목', weight: 10 })
    );
    const data = unwrap(await goals.getGoalsData(summaryProjectId));
    expect(data.techSummary.weightSum).toBe(110);
    expect(data.techSummary.weightMismatch).toBe(true);

    unwrap(await goals.deleteTechTarget(extra.id));
  });

  it('목표가 없는 과제도 실패가 아니라 빈 집계를 돌려준다', async () => {
    const emptyProjectId = await newProject('목표 없는 과제');
    const data = unwrap(await goals.getGoalsData(emptyProjectId));

    expect(data.deliverables).toEqual([]);
    expect(data.deliverableSummary.rate).toBeNull(); // Σ목표 0 → N/A
    expect(data.deliverableSummary.byType).toEqual([]);
    expect(data.techSummary.weightedRate).toBeNull(); // T-3: 0으로 나누지 않는다
    expect(data.techSummary.weightMismatch).toBe(false); // 항목이 없으면 경고도 없다
  });
});

// 실적·측정 이력의 다중 필드 편집은 O-1 대상이다. 앱 타입이 version을 싣지 않으면
// UI가 expectedVersion을 줄 수 없어 잠금이 통째로 빠진다 — 그래서 노출 자체를 검증한다.
describe('실적·측정 이력 낙관적 잠금 (§5.8·§5.9 version, §8.4 O-1·O-3)', () => {
  let lockDeliverableId: string;
  let lockTechTargetId: string;

  beforeAll(async () => {
    lockDeliverableId = unwrap(
      await goals.createDeliverable(projectId, { type: 'paper_sci', name: '잠금 검증 지표' })
    ).id;
    lockTechTargetId = unwrap(
      await goals.createTechTarget(projectId, { name: '잠금 검증 항목' })
    ).id;
  });

  afterAll(async () => {
    // 이 describe가 만든 것만 지운다 — 자식(실적·측정 이력)은 FK cascade로 함께 정리된다 (N-1)
    unwrap(await goals.deleteDeliverable(lockDeliverableId));
    unwrap(await goals.deleteTechTarget(lockTechTargetId));
  });

  it('실적 조회에 version이 실리고, 오래된 version으로 갱신하면 StaleDataError다', async () => {
    const created = unwrap(
      await goals.addAchievement(lockDeliverableId, { title: '잠금 실적', date: '2026-04-01' })
    );
    expect(created.version).toBe(1); // N-4 default

    const loaded = await deliverablesRepo.getDeliverableById(user.client, lockDeliverableId);
    const fromList = loaded.achievements.find((a) => a.id === created.id);
    if (!fromList) throw new Error('방금 만든 실적이 조회에 없습니다.');
    expect(fromList.version).toBe(1); // 임베드 조회에도 실려야 UI가 잠금을 걸 수 있다

    // 읽은 version으로 저장하면 통과하고 트리거가 version을 올린다 (N-5)
    const updated = unwrap(
      await goals.updateAchievement(
        lockDeliverableId,
        created.id,
        { title: '잠금 실적 v2', note: '수정함' },
        fromList.version
      )
    );
    expect(updated.version).toBe(fromList.version + 1);

    // 같은(이제는 낡은) version으로 다시 저장하면 리포지토리가 StaleDataError를 던진다
    await expect(
      deliverablesRepo.updateAchievement(
        user.client,
        created.id,
        { title: '덮어쓰기' },
        user.id,
        fromList.version
      )
    ).rejects.toBeInstanceOf(StaleDataError);

    // O-3: 액션은 "누가 먼저 고쳤는지"까지 담아 STALE로 돌려준다
    const message = expectCode(
      await goals.updateAchievement(
        lockDeliverableId,
        created.id,
        { title: '덮어쓰기' },
        fromList.version
      ),
      'STALE'
    );
    expect(message).toContain('먼저 수정했습니다');

    // 실패한 저장이 내용을 바꾸지 않았는지 확인한다
    const after = await deliverablesRepo.getDeliverableById(user.client, lockDeliverableId);
    expect(after.achievements.find((a) => a.id === created.id)?.title).toBe('잠금 실적 v2');

    // 행이 아예 없으면 version 불일치가 아니라 NotFound다 (0행 갱신의 원인 구분)
    await expect(
      deliverablesRepo.updateAchievement(
        user.client,
        '00000000-0000-4000-8000-000000000000',
        { title: '없는 실적' },
        user.id,
        1
      )
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  it('측정 이력 조회에 version이 실리고, 오래된 version으로 갱신하면 StaleDataError다', async () => {
    const created = unwrap(
      await goals.addTechRecord(lockTechTargetId, { value: 70, date: '2026-04-01' })
    );
    expect(created.version).toBe(1);

    const loaded = await techTargetsRepo.getTechTargetById(user.client, lockTechTargetId);
    const fromList = loaded.records.find((r) => r.id === created.id);
    if (!fromList) throw new Error('방금 만든 측정 이력이 조회에 없습니다.');
    expect(fromList.version).toBe(1);

    const updated = unwrap(
      await goals.updateTechRecord(
        lockTechTargetId,
        created.id,
        { value: 75, evaluator: '한국산업기술시험원' },
        fromList.version
      )
    );
    expect(updated.version).toBe(fromList.version + 1);

    await expect(
      techTargetsRepo.updateRecord(user.client, created.id, { value: 99 }, user.id, fromList.version)
    ).rejects.toBeInstanceOf(StaleDataError);

    const message = expectCode(
      await goals.updateTechRecord(lockTechTargetId, created.id, { value: 99 }, fromList.version),
      'STALE'
    );
    expect(message).toContain('먼저 수정했습니다');

    // 최신 실적치(§6.3)가 실패한 저장으로 흔들리지 않아야 한다
    const after = await techTargetsRepo.getTechTargetById(user.client, lockTechTargetId);
    expect(after.records.find((r) => r.id === created.id)?.value).toBe(75);

    await expect(
      techTargetsRepo.updateRecord(
        user.client,
        '00000000-0000-4000-8000-000000000000',
        { value: 1 },
        user.id,
        1
      )
    ).rejects.toBeInstanceOf(NotFoundError);
  });
});
