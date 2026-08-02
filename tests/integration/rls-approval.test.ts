// RLS 승인 게이트 통합 테스트 (SOT §14.3 RLS-1·RLS-2, §14.2 A-5)
// "미승인 세션 = publishable 키 + 실제 auth 토큰으로도 데이터 0행"을 실제 dev DB에서
// 증명한다. 승인(approve_user RPC) 후에는 같은 세션 토큰으로 즉시 조회가 가능해야 한다
// — is_approved()는 쿼리 시점마다 평가되기 때문이다.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Sql } from 'postgres';
import {
  SEED,
  applySeed,
  connectDirectDb,
  createTestUser,
  destroyTestUser,
  removeSeed,
  type TestUser,
} from './helpers';
import * as projects from '@/lib/db/projects';
import * as stages from '@/lib/db/stages';
import * as tasks from '@/lib/db/tasks';
import * as budgetItems from '@/lib/db/budget-items';
import * as appUsers from '@/lib/db/app-users';
import { RuleViolationError } from '@/lib/db/errors';

let sql: Sql;
let approver: TestUser; // active=true — 승인자 역할
let pending: TestUser;  // active=false — 미승인 세션

beforeAll(async () => {
  sql = connectDirectDb();
  await applySeed(sql);
  approver = await createTestUser(sql);
  pending = await createTestUser(sql);
  // 헬퍼는 항상 승인 상태로 만든다 — 미승인 시나리오를 위해 직결 SQL로 되돌린다.
  // 세션 토큰은 이미 발급됐지만 is_approved()가 라이브로 평가되므로 즉시 차단된다.
  await sql`update public.app_users set active = false where id = ${pending.id}::uuid`;
});

afterAll(async () => {
  await removeSeed(sql);
  await destroyTestUser(sql, pending);
  await destroyTestUser(sql, approver);
  await sql.end();
});

describe('미승인 세션 — 주요 테이블 전부 0행 (RLS-1)', () => {
  it('projects / stages / tasks / budget_items SELECT이 0행이다', async () => {
    expect(await projects.listProjects(pending.client)).toEqual([]);
    expect(await stages.listStages(pending.client, SEED.projectId)).toEqual([]);
    expect(await tasks.listTasksByYear(pending.client, SEED.year1Id)).toEqual([]);
    expect(await budgetItems.listBudgetItemsByYear(pending.client, SEED.year1Id)).toEqual([]);
  });

  it('쓰기도 차단된다 — with check (RLS-1)', async () => {
    await expect(
      projects.createProject(pending.client, {
        name: '미승인 사용자의 침입 시도',
        createdBy: pending.id,
        updatedBy: pending.id,
      })
    ).rejects.toThrow();
  });

  it('app_users는 본인 행만 보인다 (RLS-2)', async () => {
    const rows = await appUsers.listAppUsers(pending.client);
    expect(rows.map((r) => r.id)).toEqual([pending.id]);
    expect(rows[0]!.active).toBe(false);
  });

  it('미승인 사용자는 승인 권한이 없다 — approve_user 거부 (A-5)', async () => {
    await expect(appUsers.approveUser(pending.client, approver.id)).rejects.toBeInstanceOf(
      RuleViolationError
    );
  });
});

describe('approve_user 승인 흐름 (A-5, RLS-2)', () => {
  it('자기 자신은 승인할 수 없다', async () => {
    await expect(appUsers.approveUser(approver.client, approver.id)).rejects.toBeInstanceOf(
      RuleViolationError
    );
  });

  it('승인 후 같은 세션 토큰으로 즉시 조회된다', async () => {
    await appUsers.approveUser(approver.client, pending.id);

    const list = await projects.listProjects(pending.client);
    expect(list.map((p) => p.id)).toContain(SEED.projectId);

    const stageList = await stages.listStages(pending.client, SEED.projectId);
    expect(stageList).toHaveLength(1);

    const taskList = await tasks.listTasksByYear(pending.client, SEED.year1Id);
    expect(taskList.length).toBeGreaterThan(0);
  });

  it('deactivate_user로 되돌리면 다시 0행이다', async () => {
    await appUsers.deactivateUser(approver.client, pending.id);
    expect(await projects.listProjects(pending.client)).toEqual([]);
  });

  it('자기 자신은 비활성화할 수 없다 — 마지막 사용자 잠금 사고 방지', async () => {
    await expect(appUsers.deactivateUser(approver.client, approver.id)).rejects.toBeInstanceOf(
      RuleViolationError
    );
  });
});
