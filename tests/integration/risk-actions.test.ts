// Risk 서버 액션 통합 테스트
// (SOT §9 Risk·조회 목록, §5.13, §6.5, §7.11, §8.3 X-3, §8.4 O-1~O-3)
//
// 서버 액션은 쿠키 세션(requireApprovedUser)에서 토큰을 읽으므로 next/headers를
// "실제 세션 토큰을 돌려주는 스텁"으로 바꿔 액션을 가드까지 포함해 그대로 호출한다
// (milestone-actions.test.ts와 같은 방식). revalidatePath는 요청 컨텍스트 밖이라 스텁한다.
//
// 검증의 핵심 세 가지:
//  1. 과제 경계 — yearId·taskId·ownerMemberId는 FK가 과제를 강제하지 않는다. 앱이 막지 못하면
//     남의 과제 연차·작업·인력을 가리키는 리스크가 조용히 저장된다.
//  2. score(probability × impact)는 저장하지 않는다 — 조회 모델이 매번 계산하고,
//     §6.5의 해결·종료 판정 제외와 'occurred' 주의 규칙을 그대로 따른다.
//  3. 낙관적 잠금(O-1) — 상세 편집은 expectedVersion 불일치 시 STALE이어야 한다.

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Sql } from 'postgres';
import { connectDirectDb, createTestUser, destroyTestUser, type TestUser } from './helpers';
import type { ActionResult } from '@/types';
import * as risksRepo from '@/lib/db/risks';
import * as yearsRepo from '@/lib/db/years';

const session = vi.hoisted(() => ({ accessToken: '' }));

vi.mock('next/headers', () => ({
  cookies: async () => ({ get: () => ({ value: session.accessToken }) }),
}));
vi.mock('next/cache', () => ({ revalidatePath: () => undefined }));

const risks = await import('@/actions/risks');
const team = await import('@/actions/team');
const { createProject } = await import('@/actions/projects');
const { createTask } = await import('@/actions/tasks');

let sql: Sql;
let user: TestUser;
const tempProjectIds: string[] = []; // afterAll 안전망 — 이 테스트가 만든 과제만 지운다

let projectId: string;
let year1Id: string;
let memberId: string;
let taskId: string;

let otherProjectId: string;
let otherYearId: string;
let otherMemberId: string;
let otherTaskId: string;

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

  projectId = await newProject('리스크 액션 테스트 과제');
  const firstYear = (await yearsRepo.listYears(user.client, projectId))[0];
  if (!firstYear) throw new Error('createProject가 연차를 만들지 않았습니다.');
  year1Id = firstYear.id;
  memberId = unwrap(await team.createMember(projectId, { name: '김연구' })).id;
  taskId = unwrap(await createTask(year1Id, { title: '핵심 부품 발주' })).id;

  otherProjectId = await newProject('리스크 액션 남의 과제');
  const otherYear = (await yearsRepo.listYears(user.client, otherProjectId))[0];
  if (!otherYear) throw new Error('createProject가 연차를 만들지 않았습니다.');
  otherYearId = otherYear.id;
  otherMemberId = unwrap(await team.createMember(otherProjectId, { name: '남의 연구원' })).id;
  otherTaskId = unwrap(await createTask(otherYearId, { title: '남의 작업' })).id;
});

afterAll(async () => {
  for (const id of tempProjectIds) {
    await sql`delete from public.projects where id = ${id}::uuid`;
  }
  await destroyTestUser(sql, user);
  await sql.end();
});

describe('Risk CRUD 액션 (§9, §5.13)', () => {
  let riskId: string;

  it('생성 시 §5.13 기본값을 채운다', async () => {
    const created = unwrap(
      await risks.createRisk(projectId, {
        title: '핵심 부품 수급 지연',
        category: 'schedule',
        strategy: 'mitigate',
        yearId: year1Id,
        taskId,
        ownerMemberId: memberId,
      })
    );
    riskId = created.id;

    expect(created.status).toBe('identified');
    expect(created.probability).toBe(3); // DB default
    expect(created.impact).toBe(3);
    expect(created.description).toBe('');
    expect(created.response).toBe('');
    expect(created.contingency).toBe('');
    expect(created.dueDate).toBeNull();
    expect(created.order).toBe(0);
    expect(created.version).toBe(1); // N-4 default

    // score 컬럼은 존재하지 않는다 — 파생 값을 저장하지 않는다 (§5.13)
    const columns = await sql`
      select column_name from information_schema.columns
       where table_schema = 'public' and table_name = 'risks' and column_name = 'score'`;
    expect(columns.length).toBe(0);
  });

  it('리스크명·유형·대응전략은 생략할 수 없다', async () => {
    const base = { title: '규격 미달', category: 'technical', strategy: 'avoid' };
    expectCode(
      await risks.createRisk(projectId, { category: base.category, strategy: base.strategy }),
      'VALIDATION'
    );
    expectCode(
      await risks.createRisk(projectId, { title: base.title, strategy: base.strategy }),
      'VALIDATION'
    );
    expectCode(
      await risks.createRisk(projectId, { title: base.title, category: base.category }),
      'VALIDATION'
    );
    // 1~5 밖의 척도와 잘못된 날짜 형식도 거부한다 (§5.13 RiskLevel, DB check)
    expectCode(await risks.createRisk(projectId, { ...base, probability: 0 }), 'VALIDATION');
    expectCode(await risks.createRisk(projectId, { ...base, impact: 6 }), 'VALIDATION');
    expectCode(await risks.createRisk(projectId, { ...base, dueDate: '2026/12/31' }), 'VALIDATION');
  });

  it('다른 과제의 연차·작업·담당자는 거부하고 아무것도 저장하지 않는다', async () => {
    const base = { title: '경계 침범', category: 'external', strategy: 'accept' };

    const yearMessage = expectRuleViolation(
      await risks.createRisk(projectId, { ...base, yearId: otherYearId })
    );
    expect(yearMessage).toContain('연차');

    const taskMessage = expectRuleViolation(
      await risks.createRisk(projectId, { ...base, taskId: otherTaskId })
    );
    expect(taskMessage).toContain('작업');

    expectRuleViolation(
      await risks.createRisk(projectId, { ...base, ownerMemberId: otherMemberId })
    );

    // 거부됐으므로 행이 만들어지지 않아야 한다
    const list = await risksRepo.listRisks(user.client, projectId);
    expect(list.map((r) => r.id)).toEqual([riskId]);
  });

  it('수정은 낙관적 잠금을 건다 (O-1, O-3)', async () => {
    const before = await risksRepo.getRiskById(user.client, riskId);
    const updated = unwrap(
      await risks.updateRisk(
        riskId,
        {
          probability: 4,
          impact: 5,
          response: '대체 공급사 2곳 사전 계약',
          contingency: '설계 변경으로 대체 부품 적용',
          dueDate: '2026-09-30',
        },
        before.version
      )
    );
    expect(updated.probability).toBe(4);
    expect(updated.impact).toBe(5);
    expect(updated.dueDate).toBe('2026-09-30');
    expect(updated.version).toBe(before.version + 1); // N-5 트리거

    // 같은(이제는 낡은) version으로 다시 저장하면 STALE이다
    const message = expectCode(
      await risks.updateRisk(riskId, { title: '덮어쓰기' }, before.version),
      'STALE'
    );
    expect(message).toContain('먼저 수정했습니다'); // O-3

    // 실패한 저장이 내용을 바꾸지 않았는지 확인한다
    const after = await risksRepo.getRiskById(user.client, riskId);
    expect(after.title).toBe('핵심 부품 수급 지연');
  });

  it('수정에서도 다른 과제의 연차·작업·담당자를 거부한다', async () => {
    expectRuleViolation(await risks.updateRisk(riskId, { yearId: otherYearId }));
    expectRuleViolation(await risks.updateRisk(riskId, { taskId: otherTaskId }));
    expectRuleViolation(await risks.updateRisk(riskId, { ownerMemberId: otherMemberId }));

    const after = await risksRepo.getRiskById(user.client, riskId);
    expect(after.yearId).toBe(year1Id);
    expect(after.taskId).toBe(taskId);
    expect(after.ownerMemberId).toBe(memberId);
  });

  it('상태 변경은 낙관적 잠금 없이 저장한다 (O-2)', async () => {
    const updated = unwrap(await risks.setRiskStatus(riskId, 'occurred'));
    expect(updated.status).toBe('occurred');

    expectCode(await risks.setRiskStatus(riskId, 'happened'), 'VALIDATION');

    unwrap(await risks.setRiskStatus(riskId, 'monitoring'));
  });

  it('삭제하면 목록에서 사라지고 두 번 지울 수 없다', async () => {
    const throwaway = unwrap(
      await risks.createRisk(projectId, {
        title: '임시 리스크',
        category: 'other',
        strategy: 'accept',
      })
    );

    unwrap(await risks.deleteRisk(throwaway.id));
    const list = await risksRepo.listRisks(user.client, projectId);
    expect(list.map((r) => r.id)).toEqual([riskId]);

    const failed = await risks.deleteRisk(throwaway.id);
    if (failed.ok) throw new Error('이미 지운 리스크 삭제가 통과했습니다.');
    expect(failed.code).toBeUndefined(); // NotFound — §9 코드 체계에 NOT_FOUND가 없다
  });
});

describe('reorderRisks (§9, X-3)', () => {
  let orderProjectId: string;
  let aId: string;
  let bId: string;
  let cId: string;

  beforeAll(async () => {
    orderProjectId = await newProject('리스크 재정렬 과제');
    const create = async (title: string): Promise<string> =>
      unwrap(
        await risks.createRisk(orderProjectId, { title, category: 'technical', strategy: 'mitigate' })
      ).id;
    aId = await create('A');
    bId = await create('B');
    cId = await create('C');
  });

  it('생성 순서대로 order가 0..n-1로 붙는다', async () => {
    const list = await risksRepo.listRisks(user.client, orderProjectId);
    expect(list.map((r) => r.id)).toEqual([aId, bId, cId]);
    expect(list.map((r) => r.order)).toEqual([0, 1, 2]);
  });

  it('넘긴 순서대로 0..n-1로 정규화한다', async () => {
    unwrap(await risks.reorderRisks(orderProjectId, [cId, aId, bId]));
    const list = await risksRepo.listRisks(user.client, orderProjectId);
    expect(list.map((r) => r.id)).toEqual([cId, aId, bId]);
    expect(list.map((r) => r.order)).toEqual([0, 1, 2]);
  });

  it('다른 과제의 리스크가 섞이면 거부하고 순서를 바꾸지 않는다', async () => {
    const foreign = unwrap(
      await risks.createRisk(projectId, {
        title: '남의 과제 리스크',
        category: 'other',
        strategy: 'accept',
      })
    );

    const failed = await risks.reorderRisks(orderProjectId, [foreign.id, cId, aId, bId]);
    if (failed.ok) throw new Error('다른 과제 리스크가 섞인 재정렬이 통과했습니다.');

    // 부분 반영이 남으면 안 된다 — RPC는 한 트랜잭션이다 (X-3)
    const list = await risksRepo.listRisks(user.client, orderProjectId);
    expect(list.map((r) => r.id)).toEqual([cId, aId, bId]);
    expect(list.map((r) => r.order)).toEqual([0, 1, 2]);

    unwrap(await risks.deleteRisk(foreign.id));
  });

  it('빈 목록은 거부한다', async () => {
    expectCode(await risks.reorderRisks(orderProjectId, []), 'VALIDATION');
  });
});

describe('getRiskMatrix (§9 조회, §7.11, §6.5)', () => {
  let matrixProjectId: string;
  let highId: string;
  let mediumId: string;
  let lowId: string;
  let occurredId: string;
  let resolvedId: string;

  beforeAll(async () => {
    matrixProjectId = await newProject('리스크 매트릭스 과제');
    const create = async (
      title: string,
      probability: number,
      impact: number,
      status: string
    ): Promise<string> =>
      unwrap(
        await risks.createRisk(matrixProjectId, {
          title,
          category: 'technical',
          strategy: 'mitigate',
          probability,
          impact,
          status,
        })
      ).id;

    highId = await create('고위험', 5, 5, 'identified'); // 25
    mediumId = await create('중위험', 3, 3, 'monitoring'); // 9
    lowId = await create('저위험', 1, 2, 'identified'); // 2
    occurredId = await create('낮은 점수지만 발생', 1, 1, 'occurred'); // 1
    resolvedId = await create('해결된 고위험', 5, 5, 'resolved'); // 25
  });

  it('점수를 매번 계산하고 §6.5 등급 판정을 그대로 따른다', async () => {
    const data = unwrap(await risks.getRiskMatrix(matrixProjectId));
    const byId = new Map(data.risks.map((view) => [view.risk.id, view]));

    const high = byId.get(highId);
    const medium = byId.get(mediumId);
    const low = byId.get(lowId);
    const occurred = byId.get(occurredId);
    const resolved = byId.get(resolvedId);
    if (!high || !medium || !low || !occurred || !resolved) {
      throw new Error('조회 모델에 리스크가 빠졌습니다.');
    }

    expect(high.score).toBe(25);
    expect(high.severity).toBe('high');
    expect(medium.score).toBe(9);
    expect(medium.severity).toBe('medium');
    expect(low.score).toBe(2);
    expect(low.severity).toBe('low');

    // §6.5 마지막 문장: 'occurred'는 점수와 무관하게 주의 필요다
    expect(occurred.score).toBe(1);
    expect(occurred.severity).toBe('low');
    expect(occurred.attention).toBe(true);

    // §6.5: 해결·종료는 등급 판정 대상이 아니다
    expect(resolved.score).toBe(25);
    expect(resolved.severity).toBeNull();
    expect(resolved.active).toBe(false);
    expect(resolved.attention).toBe(false);

    expect(data.activeCount).toBe(4);
    expect(data.resolvedCount).toBe(1);
    expect(data.highCount).toBe(1); // 해결된 고위험은 세지 않는다
    expect(data.attentionCount).toBe(2); // 고위험 1 + 발생 1
  });

  it('미해결 먼저, 그 안에서 점수 내림차순으로 정렬한다 (§7.11)', async () => {
    const data = unwrap(await risks.getRiskMatrix(matrixProjectId));
    expect(data.risks.map((view) => view.risk.id)).toEqual([
      highId, // 25 미해결
      mediumId, // 9
      lowId, // 2
      occurredId, // 1
      resolvedId, // 25이지만 판정 제외라 뒤로
    ]);
  });

  it('5×5 히트맵은 25칸이고 미해결·해결을 나눠 센다 (§7.11)', async () => {
    const data = unwrap(await risks.getRiskMatrix(matrixProjectId));
    expect(data.cells.length).toBe(25);

    const cell55 = data.cells.find((c) => c.probability === 5 && c.impact === 5);
    if (!cell55) throw new Error('5×5 셀이 없습니다.');
    expect(cell55.score).toBe(25);
    expect(cell55.activeIds).toEqual([highId]);
    expect(cell55.inactiveIds).toEqual([resolvedId]);

    // 축 배치: 첫 칸은 impact 5 × probability 1 (위에서 아래로 영향도 5→1)
    const first = data.cells[0];
    if (!first) throw new Error('셀이 비었습니다.');
    expect(first.probability).toBe(1);
    expect(first.impact).toBe(5);

    const total = data.cells.reduce(
      (sum, cell) => sum + cell.activeIds.length + cell.inactiveIds.length,
      0
    );
    expect(total).toBe(data.risks.length);
  });

  it('연차·인력·작업 목록을 함께 싣는다 (폼 선택지와 관련 작업 링크)', async () => {
    const data = unwrap(await risks.getRiskMatrix(projectId));
    expect(data.projectId).toBe(projectId);
    expect(data.years.map((y) => y.id)).toContain(year1Id);
    expect(data.members.map((m) => m.id)).toEqual([memberId]);
    expect(data.tasks.map((t) => t.id)).toEqual([taskId]);
    expect(data.tasks[0]?.yearId).toBe(year1Id); // WBS 링크가 열 연차
  });

  it('리스크가 없는 과제도 실패가 아니라 빈 목록과 25칸을 돌려준다', async () => {
    const emptyProjectId = await newProject('리스크 없는 과제');
    const data = unwrap(await risks.getRiskMatrix(emptyProjectId));

    expect(data.risks).toEqual([]);
    expect(data.cells.length).toBe(25);
    expect(data.activeCount).toBe(0);
    expect(data.highCount).toBe(0);
  });
});
