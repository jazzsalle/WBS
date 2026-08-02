// 목표 재정렬 RPC 통합 테스트 — reorder_deliverables / reorder_tech_targets
// (SOT §9 SA-3, §8.3 X-2·X-3, §6.6 H-10, §5.8, §5.9)
// publishable 키 + 실제 세션(RLS 경로)으로 RPC를 호출한다. 직결 SQL은 테스트 사용자 준비·정리 전용.
//
// 리포지토리 래퍼(reorderDeliverables/reorderTechTargets)는 아직 없으므로 RPC 이름을 직접 쓴다.
// 호출 경로는 동일하다(anon 키 + 세션 → RLS).

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { PostgrestError } from '@supabase/supabase-js';
import type { Sql } from 'postgres';
import { connectDirectDb, createTestUser, destroyTestUser, type TestUser } from './helpers';
import * as projects from '@/lib/db/projects';
import * as deliverables from '@/lib/db/deliverables';
import * as techTargets from '@/lib/db/tech-targets';

let sql: Sql;
let user: TestUser;
const tempProjectIds: string[] = []; // 이 테스트가 만든 과제만 지운다 (파괴적 정리 금지)

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

function newDeliverable(projectId: string, name: string, order: number) {
  return deliverables.createDeliverable(
    user.client,
    {
      projectId,
      type: 'paper_sci',
      name,
      unit: '건',
      targetTotal: 1,
      targetByYear: {},
      orgId: null,
      note: '',
      order,
    },
    user.id
  );
}

function newTechTarget(projectId: string, name: string, order: number) {
  return techTargets.createTechTarget(
    user.client,
    {
      projectId,
      name,
      unit: '%',
      direction: 'higher_better',
      weight: 10,
      targetValue: 90,
      targetByYear: {},
      baselineDomestic: null,
      worldBest: null,
      worldBestHolder: '',
      measureMethod: 'self',
      measureDescription: '',
      orgId: null,
      order,
    },
    user.id
  );
}

// RPC는 리포지토리를 거치지 않으므로 PostgrestError를 그대로 받는다.
// 규칙 위반은 raise exception(P0001)으로 드러나야 한다 — 조용한 성공은 실패로 본다.
async function reorder(fn: string, projectId: string, orderedIds: string[]) {
  const { error } = await user.client.rpc(fn, {
    p_project_id: projectId,
    p_ordered_ids: orderedIds,
  });
  return error;
}

function expectRuleViolation(error: PostgrestError | null) {
  expect(error).not.toBeNull();
  expect(error!.code).toBe('P0001');
}

describe('reorder_deliverables — H-10 0..n-1 normalize (X-3)', () => {
  it('순서를 뒤집으면 order가 0..n-1로 다시 매겨진다', async () => {
    const project = await newProject('성과목표 재정렬 과제');
    await newDeliverable(project.id, '성과1', 0);
    await newDeliverable(project.id, '성과2', 5); // 비연속 order로 시작
    await newDeliverable(project.id, '성과3', 9);

    const before = await deliverables.listDeliverables(user.client, project.id);
    const reversed = [...before].reverse().map((d) => d.id);
    expect(await reorder('reorder_deliverables', project.id, reversed)).toBeNull();

    const after = await deliverables.listDeliverables(user.client, project.id);
    expect(after.map((d) => d.id)).toEqual(reversed);
    expect(after.map((d) => d.order)).toEqual([0, 1, 2]);
  });

  it('다른 과제의 id가 섞이면 거부하고 기존 순서를 유지한다', async () => {
    const a = await newProject('성과목표 재정렬 경계 A');
    const b = await newProject('성과목표 재정렬 경계 B');
    const a1 = await newDeliverable(a.id, 'A 성과1', 0);
    const a2 = await newDeliverable(a.id, 'A 성과2', 1);
    const foreign = await newDeliverable(b.id, 'B 성과', 0);

    // a2가 앞으로 오는 순서지만 외부 id가 섞였다 — 전체가 롤백돼야 한다
    expectRuleViolation(await reorder('reorder_deliverables', a.id, [a2.id, foreign.id, a1.id]));

    const after = await deliverables.listDeliverables(user.client, a.id);
    expect(after.map((d) => d.id)).toEqual([a1.id, a2.id]);
    expect(after.map((d) => d.order)).toEqual([0, 1]);
    expect((await deliverables.getDeliverableById(user.client, foreign.id)).order).toBe(0);
  });

  it('중복 id는 거부한다', async () => {
    const project = await newProject('성과목표 중복 재정렬 과제');
    const d1 = await newDeliverable(project.id, '중복1', 0);
    const d2 = await newDeliverable(project.id, '중복2', 1);

    expectRuleViolation(await reorder('reorder_deliverables', project.id, [d2.id, d2.id, d1.id]));

    const after = await deliverables.listDeliverables(user.client, project.id);
    expect(after.map((d) => d.id)).toEqual([d1.id, d2.id]);
    expect(after.map((d) => d.order)).toEqual([0, 1]);
  });
});

describe('reorder_tech_targets — H-10 0..n-1 normalize (X-3)', () => {
  it('순서를 뒤집으면 order가 0..n-1로 다시 매겨진다', async () => {
    const project = await newProject('기술목표 재정렬 과제');
    await newTechTarget(project.id, '기술1', 0);
    await newTechTarget(project.id, '기술2', 3);
    await newTechTarget(project.id, '기술3', 7);

    const before = await techTargets.listTechTargets(user.client, project.id);
    const reversed = [...before].reverse().map((t) => t.id);
    expect(await reorder('reorder_tech_targets', project.id, reversed)).toBeNull();

    const after = await techTargets.listTechTargets(user.client, project.id);
    expect(after.map((t) => t.id)).toEqual(reversed);
    expect(after.map((t) => t.order)).toEqual([0, 1, 2]);
  });

  it('다른 과제의 id가 섞이면 거부하고 기존 순서를 유지한다', async () => {
    const a = await newProject('기술목표 재정렬 경계 A');
    const b = await newProject('기술목표 재정렬 경계 B');
    const t1 = await newTechTarget(a.id, 'A 기술1', 0);
    const t2 = await newTechTarget(a.id, 'A 기술2', 1);
    const foreign = await newTechTarget(b.id, 'B 기술', 0);

    expectRuleViolation(await reorder('reorder_tech_targets', a.id, [t2.id, foreign.id, t1.id]));

    const after = await techTargets.listTechTargets(user.client, a.id);
    expect(after.map((t) => t.id)).toEqual([t1.id, t2.id]);
    expect(after.map((t) => t.order)).toEqual([0, 1]);
    expect((await techTargets.getTechTargetById(user.client, foreign.id)).order).toBe(0);
  });

  it('중복 id는 거부한다', async () => {
    const project = await newProject('기술목표 중복 재정렬 과제');
    const t1 = await newTechTarget(project.id, '중복1', 0);
    const t2 = await newTechTarget(project.id, '중복2', 1);

    expectRuleViolation(await reorder('reorder_tech_targets', project.id, [t2.id, t2.id, t1.id]));

    const after = await techTargets.listTechTargets(user.client, project.id);
    expect(after.map((t) => t.id)).toEqual([t1.id, t2.id]);
    expect(after.map((t) => t.order)).toEqual([0, 1]);
  });
});
