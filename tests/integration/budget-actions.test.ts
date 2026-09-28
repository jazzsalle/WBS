// Budget 서버 액션 통합 테스트
// (SOT §9 Budget·조회 목록 SA-1~SA-4, §6.4 B-1~B-3, §5.12, §8.4 O-1~O-3, 부록 A.1)
//
// 서버 액션은 쿠키 세션(requireApprovedUser)에서 토큰을 읽으므로 next/headers를
// "실제 세션 토큰을 돌려주는 스텁"으로 바꿔 가드까지 포함해 그대로 호출한다
// (milestone-actions.test.ts와 같은 방식). revalidatePath는 요청 컨텍스트 밖이라 스텁한다.
//
// 검증의 핵심 세 가지:
//  1. 금액 규칙(§5.12) — 현금+현물 ≠ 계획액, 음수·소수는 거부하고 **서버가 임의로 보정하지 않는다.**
//     보정하면 사용자가 입력한 적 없는 금액이 저장되고, 그 값이 그대로 집행률(§6.4)의 분모가 된다.
//     그래서 거부 후 상태는 액션 반환이 아니라 직결 SQL 재조회로 확인한다.
//  2. 집행 CRUD가 **자기 비목에만** 영향을 준다 — 다른 비목이 함께 흔들리면 매트릭스 전체가 틀린다.
//  3. 매트릭스 형태(12행 고정 × 연차)와 B-1·B-3 경고. 행이 하나라도 빠지면 화면에서 비목이 사라진다.
//
// 자기가 만든 과제·사용자만 지운다 — 파괴적 테스트가 아니다.

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Sql } from 'postgres';
import { connectDirectDb, createTestUser, destroyTestUser, type TestUser } from './helpers';
import type { ActionResult, BudgetCategory } from '@/types';
import { BUDGET_CATEGORY_ORDER } from '@/lib/constants';
import * as budgetItemsRepo from '@/lib/db/budget-items';
import * as membersRepo from '@/lib/db/members';
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

async function itemId(yearId: string, category: BudgetCategory): Promise<string> {
  const items = await budgetItemsRepo.listBudgetItemsByYear(user.client, yearId);
  const item = items.find((i) => i.category === category);
  if (!item) throw new Error(`비목 ${category}가 없습니다 (create_year RPC 확인).`);
  return item.id;
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

async function cellOf(
  matrix: Awaited<ReturnType<typeof budget.getBudgetMatrix>>,
  yearId: string,
  category: BudgetCategory
) {
  const data = unwrap(matrix);
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

  // 잔여 데이터 0 확인 — 사용자 삭제 전에 본다(삭제하면 created_by가 null이 되어 추적이 끊긴다).
  // 집행은 비목 cascade로 지워져야 하므로 고아 행이 남으면 즉시 실패시킨다 (절대 규칙 5)
  let remaining = 0;
  for (const id of tempProjectIds) {
    const rows = await sql`
      select ((select count(*) from public.projects where id = ${id}::uuid)
            + (select count(*) from public.budget_items where project_id = ${id}::uuid))::text as n`;
    remaining += Number((rows[0] as { n: string }).n);
  }
  const orphans = await sql`
    select count(*)::text as n from public.budget_executions where created_by = ${user.id}::uuid`;
  remaining += Number((orphans[0] as { n: string }).n);
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

describe('집행 CRUD (§9, §5.12, §6.4)', () => {
  let personnelItemId: string;
  let materialItemId: string;

  beforeAll(async () => {
    personnelItemId = await itemId(year1Id, 'personnel');
    materialItemId = await itemId(year1Id, 'material');
  });

  it('addExecution은 해당 비목 집행액만 늘리고 deleteExecution이 원복한다', async () => {
    const beforePersonnel = await cellOf(
      await budget.getBudgetMatrix(projectId),
      year1Id,
      'personnel'
    );
    const beforeMaterial = await cellOf(
      await budget.getBudgetMatrix(projectId),
      year1Id,
      'material'
    );

    const created = unwrap(
      await budget.addExecution(personnelItemId, {
        date: '2026-03-15',
        amount: 3_500_000,
        description: '3월 인건비',
      })
    );
    expect(created.amount).toBe(3_500_000);
    expect(created.note).toBe(''); // N-11 미입력 = 빈 문자열
    expect(created.version).toBe(1); // N-4 default

    const afterPersonnel = await cellOf(
      await budget.getBudgetMatrix(projectId),
      year1Id,
      'personnel'
    );
    expect(afterPersonnel.executed).toBe(beforePersonnel.executed + 3_500_000);
    expect(afterPersonnel.remaining).toBe(afterPersonnel.planned - afterPersonnel.executed);

    // 다른 비목은 흔들리지 않는다 — 흔들리면 매트릭스 전체 집행률이 틀린다
    const afterMaterial = await cellOf(
      await budget.getBudgetMatrix(projectId),
      year1Id,
      'material'
    );
    expect(afterMaterial.executed).toBe(beforeMaterial.executed);

    unwrap(await budget.deleteExecution(personnelItemId, created.id));

    const restored = await cellOf(await budget.getBudgetMatrix(projectId), year1Id, 'personnel');
    expect(restored.executed).toBe(beforePersonnel.executed);
  });

  it('집행 금액도 0 이상 정수만 받는다 (§5.12)', async () => {
    expectCode(
      await budget.addExecution(personnelItemId, { date: '2026-03-15', amount: -1 }),
      'VALIDATION'
    );
    expectCode(
      await budget.addExecution(personnelItemId, { date: '2026-03-15', amount: 1_000.5 }),
      'VALIDATION'
    );
    // 집행일 없는 집행은 연차 귀속을 판정할 수 없다
    expectCode(await budget.addExecution(personnelItemId, { amount: 1_000 }), 'VALIDATION');

    const item = await budgetItemsRepo.getBudgetItemById(user.client, personnelItemId);
    expect(item.executions).toEqual([]);
  });

  it('다른 비목 id로는 집행을 수정할 수 없다', async () => {
    const created = unwrap(
      await budget.addExecution(personnelItemId, {
        date: '2026-04-01',
        amount: 1_200_000,
        description: '4월 인건비',
      })
    );

    // materialItemId의 집행이 아니므로 0행 갱신 → NotFound (§9 코드 체계에 NOT_FOUND가 없다)
    const failed = await budget.updateExecution(materialItemId, created.id, { amount: 9_000_000 });
    if (failed.ok) throw new Error('다른 비목 id로 한 집행 수정이 통과했습니다.');
    expect(failed.code).toBeUndefined();

    const item = await budgetItemsRepo.getBudgetItemById(user.client, personnelItemId);
    expect(item.executions).toHaveLength(1);
    expect(item.executions[0]!.amount).toBe(1_200_000);

    unwrap(await budget.deleteExecution(personnelItemId, created.id));
  });

  it('낡은 expectedVersion은 STALE로 거부한다 (O-1, §5.12 version)', async () => {
    const created = unwrap(
      await budget.addExecution(personnelItemId, {
        date: '2026-05-02',
        amount: 800_000,
        description: '5월 소모품',
      })
    );

    const updated = unwrap(
      await budget.updateExecution(
        personnelItemId,
        created.id,
        { amount: 850_000, description: '5월 소모품(정정)' },
        created.version
      )
    );
    expect(updated.amount).toBe(850_000);
    expect(updated.version).toBe(created.version + 1); // N-5 트리거

    const message = expectCode(
      await budget.updateExecution(
        personnelItemId,
        created.id,
        { amount: 10_000 },
        created.version
      ),
      'STALE'
    );
    expect(message).toContain('먼저 수정했습니다'); // O-3

    const item = await budgetItemsRepo.getBudgetItemById(user.client, personnelItemId);
    expect(item.executions[0]!.amount).toBe(850_000);

    unwrap(await budget.deleteExecution(personnelItemId, created.id));
    const after = await budgetItemsRepo.getBudgetItemById(user.client, personnelItemId);
    expect(after.executions).toEqual([]);
  });
});

describe('getBudgetMatrix (§7.9, §6.4, 부록 A.1)', () => {
  it('행은 비목 12개로 고정이고 순서는 부록 A.1을 따른다 (연차 2 × 12 = 24셀)', async () => {
    const data = unwrap(await budget.getBudgetMatrix(projectId));

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

  it('예산 0 + 집행 > 0 셀은 집행률 N/A + 예산 외 집행 경고다 (B-1)', async () => {
    const activityItemId = await itemId(year1Id, 'activity');
    expect((await readPlanRow(year1Id, 'activity')).planned).toBe(0); // create_year 기본값

    const created = unwrap(
      await budget.addExecution(activityItemId, {
        date: '2026-06-10',
        amount: 500_000,
        description: '예산 미편성 회의비',
      })
    );

    const cell = await cellOf(await budget.getBudgetMatrix(projectId), year1Id, 'activity');
    expect(cell.planned).toBe(0);
    expect(cell.executed).toBe(500_000);
    expect(cell.rate).toBeNull(); // 0으로 나누지 않는다
    expect(cell.offBudget).toBe(true);
    expect(cell.remaining).toBe(-500_000);

    unwrap(await budget.deleteExecution(activityItemId, created.id));
    const restored = await cellOf(await budget.getBudgetMatrix(projectId), year1Id, 'activity');
    expect(restored.offBudget).toBe(false);
    expect(restored.rate).toBeNull(); // 예산 0이면 집행이 없어도 N/A
  });

  it('연차 예산 합계가 year.budget과 다르면 mismatch를 올린다 (B-3)', async () => {
    const plannedSum = unwrap(await budget.getBudgetMatrix(projectId)).matrix.columns[0]!.total
      .planned;
    expect(plannedSum).toBeGreaterThan(0); // 앞 테스트가 편성한 인건비·연구재료비

    unwrap(await updateYear(year1Id, { budget: plannedSum + 1_000_000 }));
    const mismatched = unwrap(await budget.getBudgetMatrix(projectId));
    expect(mismatched.yearBudgetChecks[year1Id]).toEqual({ mismatch: true, diff: -1_000_000 });

    unwrap(await updateYear(year1Id, { budget: plannedSum }));
    const matched = unwrap(await budget.getBudgetMatrix(projectId));
    expect(matched.yearBudgetChecks[year1Id]).toEqual({ mismatch: false, diff: 0 });

    // year.budget이 null이면 비교 대상이 없으므로 배지를 띄우지 않는다 (편성 전 연차가 전부
    // 불일치로 잡히면 경고가 의미를 잃는다)
    expect(matched.yearBudgetChecks[year2Id]).toBeNull();
  });

  // 화면(§7.9)이 원본 행을 두 번째 조회로 읽으면 매트릭스와 다른 시점을 볼 수 있다.
  // 집계를 만든 그 배열을 그대로 내리는지 — 셀 단위로 대조해 확인한다
  it('집계를 만든 원본 행(items)을 같은 응답에 함께 내린다', async () => {
    const personnelItemId = await itemId(year1Id, 'personnel');
    const created = unwrap(
      await budget.addExecution(personnelItemId, {
        date: '2026-07-01',
        amount: 1_000_000,
        description: '원본 행 동봉 확인',
      })
    );

    const result = await budget.getBudgetMatrix(projectId);
    const data = unwrap(result);

    // 연차 2 × 비목 12. 매트릭스에 실리지 못한 행이 없으므로 셀 수와 같다
    expect(data.items).toHaveLength(24);
    expect(data.matrix.unmatchedItemCount).toBe(0);

    for (const item of data.items) {
      const cell = await cellOf(result, item.yearId, item.category);
      // 같은 스냅샷이면 집계와 원본이 어긋날 수 없다
      expect(cell.planned).toBe(item.plannedAmount);
      expect(cell.executed).toBe(item.executions.reduce((sum, e) => sum + e.amount, 0));
    }

    // 집행 패널이 필요로 하는 것들: 부모 키·version(O-1)·집행 목록·현금/현물 null 여부
    const personnel = data.items.find((i) => i.id === personnelItemId);
    expect(personnel).toBeDefined();
    expect(personnel!.version).toBeGreaterThan(0);
    expect(personnel!.executions.map((e) => e.id)).toContain(created.id);

    unwrap(await budget.deleteExecution(personnelItemId, created.id));
  });
});

// ─── Phase 20 내역 필드 (§5.12, §9 add/updateExecution, IN-13) ────────────────
// 손으로 넣는 경로도 7필드를 받는다. 필수가 아니므로 4필드 호출은 이전과 같아야 하고,
// 참조 id(인력·산출근거)는 FK가 막지 못하는 과제·연차 경계를 액션이 RULE로 막는다.
// 거부 뒤 상태는 반환이 아니라 저장된 행으로 확인한다 — 경계 밖 id가 몰래 저장됐는지는 DB만 답한다.

describe('집행 내역 필드 (§5.12 Phase 20, IN-13)', () => {
  let personnelItemId: string;
  let materialItemId: string;
  let memberId: string;
  let detailId: string; // 1차년도 연구재료비 산출근거
  let year2DetailId: string; // 같은 과제 2차년도 — 연차 경계 검사용
  let otherMemberId: string; // 다른 과제
  let otherDetailId: string; // 다른 과제

  function newMember(pid: string, name: string) {
    return membersRepo.createMember(
      user.client,
      {
        projectId: pid,
        orgId: null,
        name,
        role: 'researcher',
        position: '선임연구원',
        field: '',
        email: '',
        phone: '',
        active: true,
        order: 0,
        annualSalary: null,
        hireType: 'existing',
      },
      user.id
    );
  }

  function newMaterialDetail(yearId: string) {
    return plan.createBudgetDetail(yearId, 'material', 'material_purchase', {
      axis: 'cash',
      name: '시약',
      unitPrice: 100_000,
      factors: [{ label: '수량', value: 2, isPercent: false }],
    });
  }

  interface ExecutionRow {
    unit_price: string | null;
    member_id: string | null;
    detail_id: string | null;
  }

  async function readExecutionRow(id: string): Promise<ExecutionRow> {
    const rows = await sql`
      select unit_price::text as unit_price, member_id::text as member_id,
             detail_id::text as detail_id
        from public.budget_executions where id = ${id}::uuid`;
    const row = rows[0] as ExecutionRow | undefined;
    if (!row) throw new Error(`집행 행(${id})을 찾을 수 없습니다.`);
    return row;
  }

  beforeAll(async () => {
    personnelItemId = await itemId(year1Id, 'personnel');
    materialItemId = await itemId(year1Id, 'material');
    memberId = (await newMember(projectId, '집행 인력')).id;
    detailId = unwrap(await newMaterialDetail(year1Id)).id;
    year2DetailId = unwrap(await newMaterialDetail(year2Id)).id;

    const other = unwrap(
      await createProject({ name: '연구비 액션 테스트 과제(경계)', contractStartDate: '2026-01-01' })
    );
    tempProjectIds.push(other.id);
    const otherYear = (await yearsRepo.listYears(user.client, other.id))[0];
    if (!otherYear) throw new Error('createProject가 연차를 만들지 않았습니다.');
    otherMemberId = (await newMember(other.id, '다른 과제 인력')).id;
    otherDetailId = unwrap(await newMaterialDetail(otherYear.id)).id;
  });

  afterAll(async () => {
    // 산출근거는 매트릭스 계획액을 잠근다(PL-9) — 이 과제에 남기지 않는다
    unwrap(await plan.deleteBudgetDetail(detailId));
    unwrap(await plan.deleteBudgetDetail(year2DetailId));
  });

  it('4필드만 넣으면 내역 필드는 DB 기본값이다 (기존 호출 불변)', async () => {
    const created = unwrap(
      await budget.addExecution(materialItemId, {
        date: '2026-03-02',
        amount: 120_000,
        description: '시약 구입',
        note: '',
      })
    );
    expect(created).toMatchObject({
      subcategoryCode: null,
      spec: '',
      unitPrice: null,
      factors: null,
      axis: null,
      memberId: null,
      detailId: null,
    });

    // 4필드 수정이 내역 필드를 건드리지 않는다
    const updated = unwrap(
      await budget.updateExecution(materialItemId, created.id, { amount: 130_000 }, created.version)
    );
    expect(updated.amount).toBe(130_000);
    expect(updated.spec).toBe('');
    expect(updated.factors).toBeNull();

    unwrap(await budget.deleteExecution(materialItemId, created.id));
  });

  it('7필드를 받아 저장하고, 인자의 isPercent를 보존한다', async () => {
    const factors = [
      { label: '참여율(%)', value: 28, isPercent: true },
      { label: '참여기간(월)', value: 1, isPercent: false },
    ];
    const created = unwrap(
      await budget.addExecution(personnelItemId, {
        date: '2026-03-25',
        amount: 2_800_000,
        description: '3월 인건비',
        subcategoryCode: 'personnel_internal',
        spec: '3월분',
        unitPrice: 10_000_000,
        factors,
        axis: 'cash',
        memberId,
        detailId: null,
      })
    );
    expect(created).toMatchObject({
      subcategoryCode: 'personnel_internal',
      spec: '3월분',
      unitPrice: 10_000_000,
      axis: 'cash',
      memberId,
      detailId: null,
    });
    expect(created.factors).toEqual(factors);

    const row = await readExecutionRow(created.id);
    expect(row.unit_price).toBe('10000000');
    expect(row.member_id).toBe(memberId);

    // 비우기(null)는 경계 검사 없이 허용된다
    const cleared = unwrap(
      await budget.updateExecution(
        personnelItemId,
        created.id,
        { memberId: null, subcategoryCode: null, factors: null },
        created.version
      )
    );
    expect(cleared).toMatchObject({ memberId: null, subcategoryCode: null, factors: null });
    expect(cleared.spec).toBe('3월분'); // patch에 없는 필드는 그대로

    unwrap(await budget.deleteExecution(personnelItemId, created.id));
  });

  it('같은 과제·연차의 산출근거를 detailId로 지정할 수 있다', async () => {
    const created = unwrap(
      await budget.addExecution(materialItemId, {
        date: '2026-04-10',
        amount: 200_000,
        subcategoryCode: 'material_purchase',
        detailId,
      })
    );
    expect(created.detailId).toBe(detailId);
    unwrap(await budget.deleteExecution(materialItemId, created.id));
  });

  it('형식 위반은 VALIDATION: 단가 음수·소수, 인자 4개, 축 값, 다른 비목의 세목', async () => {
    const base = { date: '2026-04-11', amount: 1_000 };
    expectCode(await budget.addExecution(materialItemId, { ...base, unitPrice: -1 }), 'VALIDATION');
    expectCode(await budget.addExecution(materialItemId, { ...base, unitPrice: 1.5 }), 'VALIDATION');
    const factor = { label: '수량', value: 1, isPercent: false };
    expectCode(
      await budget.addExecution(materialItemId, { ...base, factors: [factor, factor, factor, factor] }),
      'VALIDATION'
    );
    expectCode(await budget.addExecution(materialItemId, { ...base, axis: 'gov' }), 'VALIDATION');
    // personnel_internal은 인건비의 세목이다 — 연구재료비 집행에 쓰면 세목 집계가 갈라진다 (부록 A.5)
    expectCode(
      await budget.addExecution(materialItemId, { ...base, subcategoryCode: 'personnel_internal' }),
      'VALIDATION'
    );

    const item = await budgetItemsRepo.getBudgetItemById(user.client, materialItemId);
    expect(item.executions).toEqual([]);
  });

  it('다른 과제의 인력·산출근거, 다른 연차의 산출근거는 RULE로 거부하고 저장하지 않는다', async () => {
    const base = { date: '2026-04-12', amount: 1_000 };
    expectCode(
      await budget.addExecution(personnelItemId, { ...base, memberId: otherMemberId }),
      'RULE'
    );
    expectCode(
      await budget.addExecution(materialItemId, { ...base, detailId: otherDetailId }),
      'RULE'
    );
    expectCode(
      await budget.addExecution(materialItemId, { ...base, detailId: year2DetailId }),
      'RULE'
    );
    // 없는 id도 경계 밖이다 — FK 위반의 뭉뚱그린 실패가 아니라 사유를 보인다
    expectCode(
      await budget.addExecution(materialItemId, {
        ...base,
        detailId: '00000000-0000-4000-8000-000000000000',
      }),
      'RULE'
    );

    const personnel = await budgetItemsRepo.getBudgetItemById(user.client, personnelItemId);
    expect(personnel.executions).toEqual([]);
    const material = await budgetItemsRepo.getBudgetItemById(user.client, materialItemId);
    expect(material.executions).toEqual([]);

    // 수정 경로도 같은 경계다 — 거부 뒤 행이 그대로인지 저장값으로 본다
    const created = unwrap(await budget.addExecution(personnelItemId, base));
    expectCode(
      await budget.updateExecution(
        personnelItemId,
        created.id,
        { memberId: otherMemberId },
        created.version
      ),
      'RULE'
    );
    expectCode(
      await budget.updateExecution(
        personnelItemId,
        created.id,
        { detailId: otherDetailId },
        created.version
      ),
      'RULE'
    );
    const row = await readExecutionRow(created.id);
    expect(row.member_id).toBeNull();
    expect(row.detail_id).toBeNull();

    unwrap(await budget.deleteExecution(personnelItemId, created.id));
  });
});
