// 집행 내역이 PostgREST 응답 상한(max-rows 기본 1000)을 넘어도 전량 읽히는지 검증한다.
//
// 임베드(`budget_items?select=*,budget_executions(...)`)는 자식이 상한에 걸려도 에러 없이
// 잘린 배열을 준다 → 집행액 합계가 조용히 작아지고 집행률(§6.4)이 틀린 값이 된다 (절대 규칙 5, §12).
// 그래서 자식은 별도 페이징 조회로 읽는다. 여기서는 1,200건을 넣고 리포지토리 세 경로
// (연차 조회 / 단건 조회 / 대시보드 벌크 조회)가 모두 1,200건과 정확한 합계를 돌려주는지 본다.
//
// 자기가 만든 과제·사용자만 지운다 — 파괴적 테스트가 아니다.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Sql } from 'postgres';
import { connectDirectDb, createTestUser, destroyTestUser, type TestUser } from './helpers';
import * as projects from '@/lib/db/projects';
import * as stages from '@/lib/db/stages';
import * as years from '@/lib/db/years';
import * as budgetItems from '@/lib/db/budget-items';
import { fetchDashboardSource } from '@/lib/db/dashboard';

// PostgREST 기본 max-rows(1000)를 반드시 넘겨야 절단이 드러난다
const EXECUTION_COUNT = 1200;
// 같은 연차의 다른 비목 — 청크 병합이 비목을 섞지 않는지 확인용
const OTHER_EXECUTION_COUNT = 3;

let sql: Sql;
let user: TestUser;
let projectId: string;
let yearId: string;
let personnelItemId: string;
let materialItemId: string;
let expectedSum: number;

beforeAll(async () => {
  sql = connectDirectDb();
  user = await createTestUser(sql);
  const project = await projects.createProject(user.client, {
    name: '집행 내역 페이징 테스트 과제',
    createdBy: user.id,
    updatedBy: user.id,
  });
  projectId = project.id;
  const stage = await stages.createStage(user.client, { projectId, name: '1단계' });
  const year = await years.createYear(user.client, { stageId: stage.id, name: '1차년도' });
  yearId = year.id;

  // create_year RPC가 만든 비목 12종(§5.12) 중 둘을 쓴다
  const items = await budgetItems.listBudgetItemsByYear(user.client, yearId);
  personnelItemId = items.find((i) => i.category === 'personnel')!.id;
  materialItemId = items.find((i) => i.category === 'material')!.id;

  // 벌크 삽입은 직결 SQL로 — 1,200번의 API 왕복은 테스트 시간을 무의미하게 늘린다.
  // 집행일을 id 순서와 어긋나게(내림차순 주기) 넣어야 날짜 정렬이 실제로 검증된다.
  await sql`
    insert into public.budget_executions
      (budget_item_id, date, amount, description, note, created_by, updated_by)
    select ${personnelItemId}::uuid,
           date '2026-01-01' + ((${EXECUTION_COUNT} - i) % 300),
           100000 + i,
           '집행 ' || i,
           '',
           ${user.id}::uuid,
           ${user.id}::uuid
    from generate_series(1, ${EXECUTION_COUNT}) as i`;

  await sql`
    insert into public.budget_executions
      (budget_item_id, date, amount, description, note, created_by, updated_by)
    select ${materialItemId}::uuid, date '2026-02-01' + i, 5000 + i, '재료비 ' || i, '',
           ${user.id}::uuid, ${user.id}::uuid
    from generate_series(1, ${OTHER_EXECUTION_COUNT}) as i`;

  const summed = await sql`
    select coalesce(sum(amount), 0)::bigint as total
    from public.budget_executions where budget_item_id = ${personnelItemId}::uuid`;
  expectedSum = Number((summed[0] as { total: string }).total);
});

afterAll(async () => {
  // 연차·비목·집행은 과제 삭제의 cascade로 함께 지워진다 (H-5)
  await sql`delete from public.projects where id = ${projectId}::uuid`;
  await destroyTestUser(sql, user);
  await sql.end();
});

describe('budget_executions 1,000건 초과 조회 (절대 규칙 5, §12)', () => {
  it('listBudgetItemsByYear — 집행 1,200건 전량과 합계가 일치한다', async () => {
    const items = await budgetItems.listBudgetItemsByYear(user.client, yearId);

    const personnel = items.find((i) => i.id === personnelItemId)!;
    expect(personnel.executions).toHaveLength(EXECUTION_COUNT);
    expect(personnel.executions.reduce((sum, e) => sum + e.amount, 0)).toBe(expectedSum);

    // 페이징 경계에서 행이 중복되거나 누락되지 않았는지 id 유일성으로 재확인
    expect(new Set(personnel.executions.map((e) => e.id)).size).toBe(EXECUTION_COUNT);

    // 청크 병합이 비목을 섞지 않는다
    const material = items.find((i) => i.id === materialItemId)!;
    expect(material.executions).toHaveLength(OTHER_EXECUTION_COUNT);
    const untouched = items.filter((i) => i.id !== personnelItemId && i.id !== materialItemId);
    expect(untouched.every((i) => i.executions.length === 0)).toBe(true);
  });

  it('집행일 오름차순 정렬은 페이징 후에도 유지된다', async () => {
    const items = await budgetItems.listBudgetItemsByYear(user.client, yearId);
    const dates = items.find((i) => i.id === personnelItemId)!.executions.map((e) => e.date);
    expect([...dates].sort()).toEqual(dates);
  });

  it('getBudgetItemById — 단건 조회도 전량을 돌려준다', async () => {
    const item = await budgetItems.getBudgetItemById(user.client, personnelItemId);
    expect(item.executions).toHaveLength(EXECUTION_COUNT);
    expect(item.executions.reduce((sum, e) => sum + e.amount, 0)).toBe(expectedSum);
  });

  it('fetchDashboardSource — 전 과제 벌크 조회도 같은 값을 본다 (§7.2)', async () => {
    const source = await fetchDashboardSource(user.client);
    const personnel = source.budgetItems.find((i) => i.id === personnelItemId);
    expect(personnel).toBeDefined();
    expect(personnel!.executions).toHaveLength(EXECUTION_COUNT);
    expect(personnel!.executions.reduce((sum, e) => sum + e.amount, 0)).toBe(expectedSum);
  });
});
