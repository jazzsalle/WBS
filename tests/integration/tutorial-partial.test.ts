// createSampleProject 부분 실패 통합 테스트 (SOT §7.17 TU-3 "한 트랜잭션이 아니다")
//
// 마지막 단계(applyRulePreset)를 모의로 실패시킨다. 그 앞 8단계는 실제 액션·DB를 탄다.
// 기대: ok:false + 만들어진 과제 id + "일부만" 안내 — 조용히 성공 처리하거나 id 없이 실패해
// 고아 과제를 남기면 안 된다(절대 규칙 5). 그 과제가 실제로 DB에 있고 [과제 삭제](TU-5)로
// 지울 수 있는 상태인지까지 본다.
//
// 자기가 만든 과제·사용자만 지운다 — 파괴적 테스트가 아니다.

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Sql } from 'postgres';
import { connectDirectDb, createTestUser, destroyTestUser, type TestUser } from './helpers';
import * as projectsRepo from '@/lib/db/projects';
import * as budgetDetailsRepo from '@/lib/db/budget-details';
import * as budgetRulesRepo from '@/lib/db/budget-rules';

const session = vi.hoisted(() => ({ accessToken: '' }));

vi.mock('next/headers', () => ({
  cookies: async () => ({ get: () => ({ value: session.accessToken }) }),
}));
vi.mock('next/cache', () => ({ revalidatePath: () => undefined }));
// 9단계만 실패시킨다 — 나머지 액션은 실제 경로다
vi.mock('@/actions/budget-rules', () => ({
  applyRulePreset: async () => ({ ok: false, error: '모의 프리셋 실패', code: 'RULE' }),
}));

const help = await import('@/actions/help');
const { deleteProject } = await import('@/actions/projects');

let sql: Sql;
let user: TestUser;
const tempProjectIds: string[] = [];

beforeAll(async () => {
  sql = connectDirectDb();
  user = await createTestUser(sql);
  session.accessToken = user.accessToken;
});

afterAll(async () => {
  for (const id of tempProjectIds) {
    await sql`delete from public.projects where id = ${id}::uuid`;
  }
  let remaining = 0;
  for (const id of tempProjectIds) {
    const rows = await sql`
      select ((select count(*) from public.projects       where id         = ${id}::uuid)
            + (select count(*) from public.budget_details where project_id = ${id}::uuid)
            + (select count(*) from public.members        where project_id = ${id}::uuid))::text as n`;
    remaining += Number((rows[0] as { n: string }).n);
  }
  if (remaining !== 0) {
    throw new Error(`테스트가 만든 데이터가 ${remaining}건 남았습니다.`);
  }
  await destroyTestUser(sql, user);
  await sql.end();
});

describe('createSampleProject — 중간 실패는 만든 과제 id와 함께 실패로 돌려준다 (TU-3)', () => {
  it('9단계(규칙 프리셋) 실패 → ok:false · projectId · "일부만" · 실패 단계 표기', async () => {
    const result = await help.createSampleProject(null);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    if (!('projectId' in result)) {
      throw new Error(`projectId 없는 실패로 돌아왔습니다: ${result.error}`);
    }
    tempProjectIds.push(result.projectId);

    expect(result.error).toContain('일부만');
    expect(result.error).toContain('실패 단계: 9 규칙 프리셋');
    expect(result.error).toContain('모의 프리셋 실패');
    expect(result.error).toContain('[과제 삭제]');
    expect(result.code).toBe('RULE');

    // 그 과제가 실제로 DB에 있고, 8단계까지는 만들어졌으며, 9단계는 비어 있다
    const project = await projectsRepo.getProjectById(user.client, result.projectId);
    expect(project.name.startsWith('[예제] ')).toBe(true);
    expect(await budgetDetailsRepo.listByProject(user.client, result.projectId)).toHaveLength(6);
    expect(await budgetRulesRepo.listByProject(user.client, result.projectId)).toHaveLength(0);

    // 드로어는 이 상태를 "⑦ 미완료"로 본다 — 규칙이 없으므로 (TU-4)
    const status = await help.getTutorialStatus(result.projectId);
    if (!status.ok) throw new Error(status.error);
    expect(status.data.projectExists).toBe(true);
    expect(status.data.steps).toMatchObject({ milestones: true, budget: false });
  });

  it('부분 생성된 과제는 기존 deleteProject로 지워지고, 지운 뒤 판정은 과제 없음 (TU-5)', async () => {
    const [projectId] = tempProjectIds;
    if (!projectId) throw new Error('앞 테스트가 과제를 만들지 못했습니다.');

    const deleted = await deleteProject(projectId);
    if (!deleted.ok) throw new Error(`삭제 실패: ${deleted.error}`);

    const status = await help.getTutorialStatus(projectId);
    if (!status.ok) throw new Error(status.error);
    expect(status.data.projectExists).toBe(false);
  });
});
