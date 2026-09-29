// Budget 서버 액션 통합 테스트
// (SOT §9 Budget·조회 목록 SA-1~SA-4, §6.4 B-3, §5.12, §8.4 O-1~O-3, 부록 A.1)
//
// 서버 액션은 쿠키 세션(requireApprovedUser)에서 토큰을 읽으므로 next/headers를
// "실제 세션 토큰을 돌려주는 스텁"으로 바꿔 가드까지 포함해 그대로 호출한다
// (milestone-actions.test.ts와 같은 방식). revalidatePath는 요청 컨텍스트 밖이라 스텁한다.
//
// 검증의 핵심 두 가지:
//  1. 금액 규칙(§5.12) — 현금+현물 ≠ 계획액, 음수·소수는 거부하고 **서버가 임의로 보정하지 않는다.**
//     보정하면 사용자가 입력한 적 없는 금액이 저장되고, 그 값이 B-3·규칙 판정(§6.14)의 입력이 된다.
//     그래서 거부 후 상태는 액션 반환이 아니라 직결 SQL 재조회로 확인한다.
//  2. 연구비 페이지 조회(getBudgetPlanData)의 매트릭스 형태(12행 고정 × 연차)와 B-3 경고.
//     행이 하나라도 빠지면 화면에서 비목이 사라진다. Phase 23 S-5로 getBudgetMatrix가 삭제되어
//     그 조회가 지키던 계획액 단언을 여기로 옮겼다.
//
// 자기가 만든 과제·사용자만 지운다 — 파괴적 테스트가 아니다.

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Sql } from 'postgres';
import { connectDirectDb, createTestUser, destroyTestUser, type TestUser } from './helpers';
import type { ActionResult, BudgetCategory } from '@/types';
import type { BudgetPlanData } from '@/actions/budget-plan';
import { BUDGET_CATEGORY_ORDER } from '@/lib/constants';
import * as stagesRepo from '@/lib/db/stages';
import * as yearsRepo from '@/lib/db/years';

const session = vi.hoisted(() => ({ accessToken: '' }));

vi.mock('next/headers', () => ({
  cookies: async () => ({ get: () => ({ value: session.accessToken }) }),
}));
vi.mock('next/cache', () => ({ revalidatePath: () => undefined }));

const budget = await import('@/actions/budget');
const { createProject } = await import('@/actions/projects');
const { createYear, updateYear } = await import('@/actions/years');
const plan = await import('@/actions/budget-plan');

let sql: Sql;
let user: TestUser;
const tempProjectIds: string[] = []; // afterAll 안전망 — 이 테스트가 만든 과제만 지운다

let projectId: string;
let year1Id: string;
let year2Id: string;

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

// 액션 반환값이 아니라 저장된 원본을 본다 — 서버가 몰래 보정했는지는 DB만 답할 수 있다.
// bigint는 postgres.js가 문자열로 주므로 text로 캐스팅해 정수로 되돌린다 (부동소수점 경유 금지)
interface PlanRow {
  planned: number;
  cash: number | null;
  inKind: number | null;
  version: number;
}

async function readPlanRow(yearId: string, category: BudgetCategory): Promise<PlanRow> {
  const rows = await sql`
    select planned_amount::text as planned, cash_amount::text as cash,
           in_kind_amount::text as in_kind, version::text as version
      from public.budget_items
     where year_id = ${yearId}::uuid and category = ${category}`;
  const row = rows[0] as
    | { planned: string; cash: string | null; in_kind: string | null; version: string }
    | undefined;
  if (!row) throw new Error(`비목 행(${category})을 찾을 수 없습니다.`);
  return {
    planned: Number(row.planned),
    cash: row.cash === null ? null : Number(row.cash),
    inKind: row.in_kind === null ? null : Number(row.in_kind),
    version: Number(row.version),
  };
}

function cellOf(
  data: BudgetPlanData,
  yearId: string,
  category: BudgetCategory
) {
  const row = data.matrix.rows.find((r) => r.category === category);
  if (!row) throw new Error(`매트릭스에 ${category} 행이 없습니다.`);
  const cell = row.cells.find((c) => c.yearId === yearId);
  if (!cell) throw new Error(`매트릭스에 ${category} × ${yearId} 셀이 없습니다.`);
  return cell;
}

beforeAll(async () => {
  sql = connectDirectDb();
  user = await createTestUser(sql);
  session.accessToken = user.accessToken;

  const project = unwrap(
    await createProject({ name: '연구비 액션 테스트 과제', contractStartDate: '2026-01-01' })
  );
  projectId = project.id;
  tempProjectIds.push(projectId);

  // createProject가 만든 기본 연차가 1차년도, B-3 비교용으로 2차년도를 하나 더 붙인다
  const firstYear = (await yearsRepo.listYears(user.client, projectId))[0];
  if (!firstYear) throw new Error('createProject가 연차를 만들지 않았습니다.');
  year1Id = firstYear.id;

  const stage = (await stagesRepo.listStages(user.client, projectId))[0];
  if (!stage) throw new Error('createProject가 단계를 만들지 않았습니다.');
  year2Id = unwrap(
    await createYear(stage.id, { name: '2차년도', startDate: '2027-01-01', endDate: '2027-12-31' })
  ).id;
});

afterAll(async () => {
  for (const id of tempProjectIds) {
    await sql`delete from public.projects where id = ${id}::uuid`;
  }

  // 잔여 데이터 0 확인 — 비목 행은 과제 cascade로 지워져야 하므로 남으면 즉시 실패시킨다 (절대 규칙 5)
  let remaining = 0;
  for (const id of tempProjectIds) {
    const rows = await sql`
      select ((select count(*) from public.projects where id = ${id}::uuid)
            + (select count(*) from public.budget_items where project_id = ${id}::uuid))::text as n`;
    remaining += Number((rows[0] as { n: string }).n);
  }
  if (remaining !== 0) {
    throw new Error(`테스트가 만든 데이터가 ${remaining}건 남았습니다.`);
  }

  await destroyTestUser(sql, user);
  await sql.end();
});

describe('updateBudgetPlan (§9 SA-2, §5.12)', () => {
  it('총액만 갱신하면 현금·현물은 분리 미입력(null)으로 남는다', async () => {
    const updated = unwrap(
      await budget.updateBudgetPlan(year1Id, 'material', 40_000_000, null, null)
    );
    expect(updated.plannedAmount).toBe(40_000_000);
    expect(updated.cashAmount).toBeNull();
    expect(updated.inKindAmount).toBeNull();

    const row = await readPlanRow(year1Id, 'material');
    expect(row).toMatchObject({ planned: 40_000_000, cash: null, inKind: null });
  });

  it('현금 + 현물 = 계획액이면 세 값을 그대로 저장한다', async () => {
    const updated = unwrap(
      await budget.updateBudgetPlan(year1Id, 'personnel', 120_000_000, 100_000_000, 20_000_000)
    );
    expect(updated.plannedAmount).toBe(120_000_000);
    expect(updated.cashAmount).toBe(100_000_000);
    expect(updated.inKindAmount).toBe(20_000_000);

    const row = await readPlanRow(year1Id, 'personnel');
    expect(row).toMatchObject({ planned: 120_000_000, cash: 100_000_000, inKind: 20_000_000 });
  });

  it('현금 + 현물 ≠ 계획액이면 거부하고 서버가 보정하지 않는다', async () => {
    const message = expectCode(
      await budget.updateBudgetPlan(year1Id, 'personnel', 120_000_000, 100_000_000, 30_000_000),
      'VALIDATION'
    );
    expect(message).toContain('합');

    // 차액을 서버가 임의 배분하거나 계획액을 130,000,000으로 올려버리지 않았는지 원본으로 확인한다
    const row = await readPlanRow(year1Id, 'personnel');
    expect(row).toMatchObject({ planned: 120_000_000, cash: 100_000_000, inKind: 20_000_000 });

    // 하나만 넘겨 나머지를 0으로 볼 때도 같은 규칙이다 (100,000,000 ≠ 120,000,000)
    expectCode(
      await budget.updateBudgetPlan(year1Id, 'personnel', 120_000_000, 100_000_000, null),
      'VALIDATION'
    );
    expect(await readPlanRow(year1Id, 'personnel')).toMatchObject({ planned: 120_000_000 });
  });

  it('음수·소수 금액은 거부한다 (§5.12 0 이상 정수만)', async () => {
    const before = await readPlanRow(year1Id, 'personnel');

    expectCode(await budget.updateBudgetPlan(year1Id, 'personnel', -1, null, null), 'VALIDATION');
    expectCode(
      await budget.updateBudgetPlan(year1Id, 'personnel', 1_000_000.5, null, null),
      'VALIDATION'
    );
    // 계획액이 정수·양수여도 현금/현물이 규칙을 어기면 거부한다
    expectCode(
      await budget.updateBudgetPlan(year1Id, 'personnel', 120_000_000, -1, 120_000_001),
      'VALIDATION'
    );
    expectCode(
      await budget.updateBudgetPlan(year1Id, 'personnel', 120_000_000, 100_000_000.5, 19_999_999.5),
      'VALIDATION'
    );

    // 거부된 호출은 version조차 올리지 않아야 한다 (부분 반영 없음)
    expect(await readPlanRow(year1Id, 'personnel')).toEqual(before);
  });

  it('낡은 expectedVersion은 STALE로 거부한다 (O-1, O-3)', async () => {
    const before = await readPlanRow(year1Id, 'personnel');

    const updated = unwrap(
      await budget.updateBudgetPlan(
        year1Id,
        'personnel',
        130_000_000,
        110_000_000,
        20_000_000,
        before.version
      )
    );
    expect(updated.plannedAmount).toBe(130_000_000);
    expect(updated.version).toBe(before.version + 1); // N-5 트리거

    const message = expectCode(
      await budget.updateBudgetPlan(year1Id, 'personnel', 999_000_000, null, null, before.version),
      'STALE'
    );
    expect(message).toContain('먼저 수정했습니다'); // O-3

    // 실패한 저장이 금액을 바꾸지 않았는지 원본으로 확인한다
    expect(await readPlanRow(year1Id, 'personnel')).toMatchObject({
      planned: 130_000_000,
      cash: 110_000_000,
      inKind: 20_000_000,
    });
  });
});

// ─── 연구비 페이지 조회 (§7.9, 부록 A.1, B-3) ─────────────────────────────────
// getBudgetMatrix(Phase 23 S-5 삭제)가 지키던 계획액 단언을 getBudgetPlanData로 옮긴다.
// 위 updateBudgetPlan 테스트가 1차년도에 인건비·연구재료비를 편성해 둔 상태를 이어 쓴다.

describe('getBudgetPlanData 매트릭스 (§7.9, §6.4 B-3, 부록 A.1)', () => {
  it('행은 비목 12개로 고정이고 순서는 부록 A.1을 따른다 (연차 2 × 12 = 24셀)', async () => {
    const data = unwrap(await plan.getBudgetPlanData(projectId));

    expect(data.projectId).toBe(projectId);
    expect(data.matrix.rows.map((r) => r.category)).toEqual([...BUDGET_CATEGORY_ORDER]);
    expect(data.matrix.columns.map((c) => c.yearId)).toEqual([year1Id, year2Id]); // order asc
    expect(data.years.map((y) => y.id)).toEqual([year1Id, year2Id]); // 열과 같은 순서 (§7.9)

    const cells = data.matrix.rows.flatMap((r) => r.cells);
    expect(cells).toHaveLength(24);
    for (const row of data.matrix.rows) {
      expect(row.cells.map((c) => c.yearId)).toEqual([year1Id, year2Id]);
      expect(row.cells.every((c) => c.category === row.category)).toBe(true);
    }

    // 매트릭스에 실리지 못한 비목이 있으면 예산이 조용히 사라진다
    expect(data.matrix.unmatchedItemCount).toBe(0);
    expect(['원', '천원', '백만원']).toContain(data.currencyUnit);
  });

  it('연차 예산 합계가 year.budget과 다르면 mismatch를 올린다 (B-3)', async () => {
    const plannedSum = unwrap(await plan.getBudgetPlanData(projectId)).matrix.columns[0]!.total
      .planned;
    expect(plannedSum).toBeGreaterThan(0); // 앞 테스트가 편성한 인건비·연구재료비

    unwrap(await updateYear(year1Id, { budget: plannedSum + 1_000_000 }));
    const mismatched = unwrap(await plan.getBudgetPlanData(projectId));
    expect(mismatched.yearBudgetChecks[year1Id]).toEqual({ mismatch: true, diff: -1_000_000 });

    unwrap(await updateYear(year1Id, { budget: plannedSum }));
    const matched = unwrap(await plan.getBudgetPlanData(projectId));
    expect(matched.yearBudgetChecks[year1Id]).toEqual({ mismatch: false, diff: 0 });

    // year.budget이 null이면 비교 대상이 없으므로 배지를 띄우지 않는다 (편성 전 연차가 전부
    // 불일치로 잡히면 경고가 의미를 잃는다)
    expect(matched.yearBudgetChecks[year2Id]).toBeNull();
  });

  // 화면(§7.9)이 원본 행을 두 번째 조회로 읽으면 매트릭스와 다른 시점을 볼 수 있다.
  // 집계를 만든 그 배열을 그대로 내리는지 — 셀 단위로 대조해 확인한다
  it('집계를 만든 원본 행(items)을 같은 응답에 함께 내린다', async () => {
    const data = unwrap(await plan.getBudgetPlanData(projectId));

    // 연차 2 × 비목 12. 매트릭스에 실리지 못한 행이 없으므로 셀 수와 같다
    expect(data.items).toHaveLength(24);
    expect(data.matrix.unmatchedItemCount).toBe(0);

    for (const item of data.items) {
      // 같은 스냅샷이면 집계와 원본이 어긋날 수 없다
      expect(cellOf(data, item.yearId, item.category).planned).toBe(item.plannedAmount);
    }

    // 셀 편집이 필요로 하는 것들: version(O-1)·현금/현물 값(분리 입력 여부, S-4)
    const personnel = data.items.find((i) => i.yearId === year1Id && i.category === 'personnel');
    expect(personnel).toBeDefined();
    expect(personnel!.version).toBeGreaterThan(0);
    expect(personnel).toMatchObject({
      plannedAmount: 130_000_000,
      cashAmount: 110_000_000,
      inKindAmount: 20_000_000,
    });
    const material = data.items.find((i) => i.yearId === year1Id && i.category === 'material');
    expect(material).toMatchObject({
      plannedAmount: 40_000_000,
      cashAmount: null,
      inKindAmount: null,
    });
  });
});
