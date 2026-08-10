// destroyTestUser가 소유자를 끊기 전에 표식을 남기는지 검증한다.
//
// 이 표식이 조용히 빠지면 증상이 없다 — 테스트는 계속 통과하고, dev DB에만
// 소유자 끊긴 고아 행이 매 실행마다 쌓여 자동 청소가 영영 못 되찾는다
// (2026-08-09에 213건 중 197건이 이 경우였다). 그래서 표식 자체를 테스트로 못 박는다.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Sql } from 'postgres';
import { connectDirectDb, createTestUser, destroyTestUser, type TestUser } from './helpers';
import { TEST_ROW_MARK, TEST_ROW_MARK_PATTERN } from '../test-marker';
import * as projects from '@/lib/db/projects';

let sql: Sql;
let user: TestUser;
let projectId: string;

beforeAll(async () => {
  sql = connectDirectDb();
  user = await createTestUser(sql);
  const project = await projects.createProjectWithDefaults(user.client, {
    name: '표식 검증 과제',
    projectNo: 'PN-1',
    contractStartDate: '2026-01-01',
  });
  projectId = project.id;
});

afterAll(async () => {
  // 검증 대상 자체가 고아 행이므로 여기서 직접 치운다 (global-setup의 2시간 대기를 기다리지 않는다)
  await sql`delete from public.projects where id = ${projectId}::uuid`;
  await sql.end();
});

describe('테스트 잔여 행 표식', () => {
  it('destroyTestUser가 소유자를 끊기 전에 표식을 찍고, 그 표식으로 고아 행을 찾을 수 있다', async () => {
    await destroyTestUser(sql, user);

    const rows = await sql<{ project_no: string; created_by: string | null }[]>`
      select project_no, created_by::text from public.projects where id = ${projectId}::uuid`;
    // created_by가 끊긴(N-8 set null) 뒤에도 표식은 남아 있어야 한다
    expect(rows[0]!.created_by).toBeNull();
    expect(rows[0]!.project_no).toBe(`${TEST_ROW_MARK}PN-1`);

    // global-setup.cleanupMarkedOrphans와 같은 술어 (경과 시간 조건 제외)
    const matched = await sql<{ id: string }[]>`
      select id from public.projects
       where project_no like ${TEST_ROW_MARK_PATTERN} and created_by is null`;
    expect(matched.map((r) => r.id)).toContain(projectId);
  });
});
