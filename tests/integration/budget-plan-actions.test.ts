// Budget Plan(산출근거) 서버 액션 통합 테스트
// (SOT §9 Budget Plan·조회 SA-1~SA-4, §5.17 PL-D1~PL-D7, §6.10 PL-1~PL-15, §8.4 O-1~O-3, §7.9.2)
//
// 서버 액션은 쿠키 세션(requireApprovedUser)에서 토큰을 읽으므로 next/headers를
// "실제 세션 토큰을 돌려주는 스텁"으로 바꿔 가드까지 포함해 그대로 호출한다
// (budget-actions.test.ts와 같은 방식). revalidatePath는 요청 컨텍스트 밖이라 스텁한다.
//
// 검증의 핵심:
//  1. PL-D1~PL-D5 — 규칙 위반은 **저장 전에** 거부되고 서버가 조용히 보정하지 않는다.
//  2. PL-D2·N-13  — 남의 과제 인력·산출근거는 액션에서도 거부한다(FK가 막지 못한다).
//  3. PL-D7       — 클라이언트가 보낸 amount는 무시하고 서버가 다시 계산한다.
//  4. PL-10       — 행을 추가·수정·삭제한 뒤 getBudgetPlanData의 셀 합계와 budget_items
//                   저장값이 일치한다(액션 레벨에서 불변식 재확인).
//  5. PL-9        — 잠긴 셀의 계획액 직접 편집은 RULE로 거부되고, 마지막 행을 지우면
//                   잠금만 풀리고 직전 합계가 남는다.
//  6. O-1         — 낡은 expectedVersion은 STALE + "OO님이 먼저 수정했습니다"(O-3).
//
// 자기가 만든 과제·사용자만 지운다 — 파괴적 테스트가 아니다.

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Sql } from 'postgres';
import { connectDirectDb, createTestUser, destroyTestUser, type TestUser } from './helpers';
import type { ActionResult, BudgetCategory, DetailFactor } from '@/types';
import * as projectsRepo from '@/lib/db/projects';
import * as stagesRepo from '@/lib/db/stages';
import * as yearsRepo from '@/lib/db/years';
import * as membersRepo from '@/lib/db/members';

const session = vi.hoisted(() => ({ accessToken: '' }));

vi.mock('next/headers', () => ({
  cookies: async () => ({ get: () => ({ value: session.accessToken }) }),
}));
vi.mock('next/cache', () => ({ revalidatePath: () => undefined }));

const plan = await import('@/actions/budget-plan');
const budget = await import('@/actions/budget');

let sql: Sql;
let user: TestUser;
const tempProjectIds: string[] = []; // afterAll 안전망 — 이 테스트가 만든 과제만 지운다

let projectId: string;
let year1Id: string;
let year2Id: string;
let memberId: string; // 연봉 74,000,000 (부록 B.7.1 박선욱)
let supportMemberId: string; // 연봉 100,000,000 — 연구지원인력(PL-11의 C)
let noSalaryMemberId: string; // 연봉 미입력 (§7.9.2 경고)
let otherMemberId: string; // 남의 과제 인력 (PL-D2)
let otherYearId: string;

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

async function readDetailAmount(id: string): Promise<number> {
  const rows = await sql`
    select amount::text as amount from public.budget_details where id = ${id}::uuid`;
  const row = rows[0] as { amount: string } | undefined;
  if (!row) throw new Error('산출근거 행을 찾을 수 없습니다.');
  return Number(row.amount);
}

async function planCell(yearId: string, category: BudgetCategory) {
  const data = unwrap(await plan.getBudgetPlanData(projectId));
  const cell = data.cells.find((c) => c.yearId === yearId && c.category === category);
  if (!cell) throw new Error(`제안 매트릭스에 ${category} × ${yearId} 셀이 없습니다.`);
  return cell;
}

// PL-10 불변식: getBudgetPlanData의 셀 합계 = budget_items 저장값 = 산출 행 합계
async function expectInvariant(yearId: string, category: BudgetCategory): Promise<void> {
  const cell = await planCell(yearId, category);
  const saved = await readPlanRow(yearId, category);
  expect(cell.mismatch).toBe(false);
  expect(saved).toMatchObject({
    planned: cell.total.plannedAmount,
    cash: cell.total.cashAmount,
    inKind: cell.total.inKindAmount,
  });
  expect(cell.saved).toEqual({
    plannedAmount: saved.planned,
    cashAmount: saved.cash,
    inKindAmount: saved.inKind,
  });
}

const PERSONNEL_FACTORS = (rate: number, months: number): DetailFactor[] => [
  { label: '참여율(%)', value: rate, isPercent: true },
  { label: '참여기간(월)', value: months, isPercent: false },
];

async function newMember(pid: string, name: string, annualSalary: number | null) {
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
      annualSalary,
      hireType: 'existing',
    },
    user.id
  );
}

beforeAll(async () => {
  sql = connectDirectDb();
  user = await createTestUser(sql);
  session.accessToken = user.accessToken;

  const project = await projectsRepo.createProjectWithDefaults(user.client, {
    name: '예산 제안 액션 테스트 과제',
    contractStartDate: '2026-01-01',
  });
  projectId = project.id;
  tempProjectIds.push(projectId);

  const firstYear = (await yearsRepo.listYears(user.client, projectId))[0];
  if (!firstYear) throw new Error('createProjectWithDefaults가 연차를 만들지 않았습니다.');
  year1Id = firstYear.id;

  const stage = (await stagesRepo.listStages(user.client, projectId))[0];
  if (!stage) throw new Error('createProjectWithDefaults가 단계를 만들지 않았습니다.');
  year2Id = (
    await yearsRepo.createYear(user.client, {
      stageId: stage.id,
      name: '2차년도',
      startDate: '2027-01-01',
      endDate: '2027-12-31',
    })
  ).id;

  memberId = (await newMember(projectId, '박선욱', 74_000_000)).id;
  supportMemberId = (await newMember(projectId, '연구지원인력', 100_000_000)).id;
  noSalaryMemberId = (await newMember(projectId, '연봉 미입력', null)).id;

  const other = await projectsRepo.createProjectWithDefaults(user.client, {
    name: '예산 제안 액션 남의 과제',
    contractStartDate: '2026-01-01',
  });
  tempProjectIds.push(other.id);
  const otherYear = (await yearsRepo.listYears(user.client, other.id))[0];
  if (!otherYear) throw new Error('남의 과제에 연차가 없습니다.');
  otherYearId = otherYear.id;
  otherMemberId = (await newMember(other.id, '남의 과제 연구원', 60_000_000)).id;
});

afterAll(async () => {
  for (const id of tempProjectIds) {
    await sql`delete from public.projects where id = ${id}::uuid`;
  }

  // 잔여 데이터 0 확인 — 사용자 삭제 전에 본다(삭제하면 created_by가 null이 되어 추적이 끊긴다).
  // 산출근거가 과제 cascade로 지워지지 않으면 즉시 실패시킨다 (절대 규칙 5)
  let remaining = 0;
  for (const id of tempProjectIds) {
    const rows = await sql`
      select ((select count(*) from public.projects       where id         = ${id}::uuid)
            + (select count(*) from public.budget_items   where project_id = ${id}::uuid)
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

describe('createBudgetDetail 입력 검증 (§5.17 PL-D1~PL-D5)', () => {
  it('PL-D1: 인건비 비목인데 인력이 없으면 거부한다', async () => {
    const message = expectCode(
      await plan.createBudgetDetail(year1Id, 'personnel', 'personnel_internal', {
        axis: 'cash',
        factors: PERSONNEL_FACTORS(28, 9),
      }),
      'VALIDATION'
    );
    expect(message).toContain('참여인력');
  });

  it('PL-D1: 수량 산식 비목에 인력을 지정하면 거부한다', async () => {
    expectCode(
      await plan.createBudgetDetail(year1Id, 'material', 'material_purchase', {
        axis: 'cash',
        memberId,
        unitPrice: 1_000_000,
      }),
      'VALIDATION'
    );
  });

  it('PL-D3: 비목과 산식이 어긋나면 거부한다', async () => {
    const message = expectCode(
      await plan.createBudgetDetail(year1Id, 'material', 'material_purchase', {
        axis: 'cash',
        formula: 'personnel',
        memberId,
      }),
      'VALIDATION'
    );
    expect(message).toContain('산식');
  });

  it('PL-D4: 그 비목의 프리셋에 없는 세목은 거부한다 (부록 A.5)', async () => {
    // activity_meeting은 연구활동비의 세목이다 — 연구재료비에 쓰면 소계가 갈라진다
    const message = expectCode(
      await plan.createBudgetDetail(year1Id, 'material', 'activity_meeting', {
        axis: 'cash',
        unitPrice: 100_000,
      }),
      'VALIDATION'
    );
    expect(message).toContain('세목');

    expectCode(
      await plan.createBudgetDetail(year1Id, 'material', 'made_up_code', {
        axis: 'cash',
        unitPrice: 100_000,
      }),
      'VALIDATION'
    );
  });

  it('PL-D5: 단가·인자 값의 음수는 거부하고 조정액 음수만 허용한다', async () => {
    expectCode(
      await plan.createBudgetDetail(year1Id, 'material', 'material_purchase', {
        axis: 'cash',
        unitPrice: -1,
      }),
      'VALIDATION'
    );
    expectCode(
      await plan.createBudgetDetail(year1Id, 'material', 'material_purchase', {
        axis: 'cash',
        unitPrice: 1_000_000,
        factors: [{ label: '수량', value: -2, isPercent: false }],
      }),
      'VALIDATION'
    );
    expectCode(
      await plan.createBudgetDetail(year1Id, 'material', 'material_purchase', {
        axis: 'cash',
        unitPrice: 1_000_000.5,
      }),
      'VALIDATION'
    );

    // PL-5: 조정액 음수는 허용된다. 금액이 음수가 되어도 저장하고 화면에서 드러낸다
    const created = unwrap(
      await plan.createBudgetDetail(year1Id, 'promotion', 'default', {
        axis: 'cash',
        name: '절사 확인용',
        unitPrice: 1_000_000,
        adjustment: -1_000_001,
      })
    );
    expect(created.amount).toBe(-1);

    const panel = unwrap(await plan.getBudgetDetails(year1Id, 'promotion'));
    expect(panel.rows[0]?.computed.negative).toBe(true);
    expect(panel.negativeCount).toBe(1);

    unwrap(await plan.deleteBudgetDetail(created.id));
  });

  it('인자는 3개까지, 축은 현금·현물만 받는다 (§5.17)', async () => {
    expectCode(
      await plan.createBudgetDetail(year1Id, 'material', 'material_purchase', {
        axis: 'cash',
        unitPrice: 1_000,
        factors: [
          { label: '수량', value: 1, isPercent: false },
          { label: '회', value: 2, isPercent: false },
          { label: '월', value: 3, isPercent: false },
          { label: '인원', value: 4, isPercent: false },
        ],
      }),
      'VALIDATION'
    );
    expectCode(
      await plan.createBudgetDetail(year1Id, 'material', 'material_purchase', {
        axis: 'unassigned',
        unitPrice: 1_000,
      }),
      'VALIDATION'
    );
    // 축이 없으면 합계를 현금/현물로 나눌 수 없다 — 서버가 지어내지 않는다
    expectCode(
      await plan.createBudgetDetail(year1Id, 'material', 'material_purchase', {
        unitPrice: 1_000,
      }),
      'VALIDATION'
    );
  });
});

describe('과제 경계 (PL-D2, §9 N-13)', () => {
  it('남의 과제 인력은 인건비 산출근거에 쓸 수 없다', async () => {
    const message = expectCode(
      await plan.createBudgetDetail(year1Id, 'personnel', 'personnel_internal', {
        axis: 'cash',
        memberId: otherMemberId,
        factors: PERSONNEL_FACTORS(10, 12),
      }),
      'RULE'
    );
    expect(message).toContain('과제');

    // 거부된 호출이 행을 남기지 않았는지 원본으로 확인한다
    const rows = await sql`
      select count(*)::text as n from public.budget_details
       where year_id = ${year1Id}::uuid and category = 'personnel'`;
    expect(Number((rows[0] as { n: string }).n)).toBe(0);
  });

  it('수정에서도 남의 과제 인력으로 바꿀 수 없다', async () => {
    const created = unwrap(
      await plan.createBudgetDetail(year1Id, 'personnel', 'personnel_internal', {
        axis: 'cash',
        memberId,
        factors: PERSONNEL_FACTORS(28, 9),
      })
    );

    expectCode(
      await plan.updateBudgetDetail(created.id, { memberId: otherMemberId }),
      'RULE'
    );
    // 저장된 인력이 바뀌지 않았는지 확인한다
    const panel = unwrap(await plan.getBudgetDetails(year1Id, 'personnel'));
    expect(panel.rows[0]?.detail.memberId).toBe(memberId);

    unwrap(await plan.deleteBudgetDetail(created.id));
  });

  it('없는 연차·산출근거는 조용히 성공하지 않는다', async () => {
    const missing = '00000000-0000-4000-8000-0000000000ff';
    const result = await plan.createBudgetDetail(missing, 'material', 'material_purchase', {
      axis: 'cash',
      unitPrice: 1_000,
    });
    if (result.ok) throw new Error('없는 연차에 산출근거가 만들어졌습니다.');
    expect(await plan.deleteBudgetDetail(missing)).toMatchObject({ ok: false });

    // 다른 과제의 세목 재정렬 목록은 RPC가 거부한다 (N-13)
    expectCode(
      await plan.reorderBudgetDetails(otherYearId, 'material', 'material_purchase', [missing]),
      'RULE'
    );
  });
});

describe('PL-D7 · PL-10 — 금액은 서버가 계산하고 총액은 합계와 일치한다', () => {
  const cell: BudgetCategory = 'material';
  let cashRowId: string;
  let inKindRowId: string;

  it('클라이언트가 보낸 amount를 무시하고 다시 계산한다 (PL-D7)', async () => {
    const created = unwrap(
      await plan.createBudgetDetail(year1Id, cell, 'material_purchase', {
        axis: 'cash',
        name: '시약 세트',
        spec: '500ml',
        unitPrice: 1_200_000,
        factors: [{ label: '수량', value: 3, isPercent: false }],
        adjustment: -600_000,
        // 화면이 지어낸 금액. 스키마에서 잘려 나가고 서버 계산값으로 저장돼야 한다
        amount: 999_999_999,
      })
    );
    cashRowId = created.id;

    expect(created.amount).toBe(3_000_000); // 1,200,000 × 3 − 600,000
    expect(await readDetailAmount(cashRowId)).toBe(3_000_000);
    await expectInvariant(year1Id, cell);
  });

  it('행 추가·수정·삭제 뒤에도 셀 합계 = budget_items 저장값이다 (PL-10)', async () => {
    const inKind = unwrap(
      await plan.createBudgetDetail(year1Id, cell, 'material_make', {
        axis: 'in_kind',
        name: '자체 제작 지그',
        unitPrice: 500_000,
        factors: [{ label: '수량', value: 2, isPercent: false }],
      })
    );
    inKindRowId = inKind.id;
    expect(inKind.amount).toBe(1_000_000);

    let view = await planCell(year1Id, cell);
    expect(view.detailCount).toBe(2);
    expect(view.locked).toBe(true); // PL-9
    expect(view.total).toEqual({
      cashAmount: 3_000_000,
      inKindAmount: 1_000_000,
      plannedAmount: 4_000_000,
    });
    // PL-6: 세목 소계는 부록 A.5 프리셋 순서로 내려온다
    expect(view.subcategories.map((s) => s.subcategory)).toEqual([
      'material_purchase',
      'material_make',
    ]);
    await expectInvariant(year1Id, cell);

    // 수정: 근거가 바뀌면 amount도 같은 쓰기에서 다시 계산된다 (PL-D7)
    const updated = unwrap(
      await plan.updateBudgetDetail(cashRowId, {
        factors: [{ label: '수량', value: 5, isPercent: false }],
      })
    );
    expect(updated.amount).toBe(5_400_000); // 1,200,000 × 5 − 600,000
    view = await planCell(year1Id, cell);
    expect(view.total.plannedAmount).toBe(6_400_000);
    await expectInvariant(year1Id, cell);

    // 삭제
    unwrap(await plan.deleteBudgetDetail(inKindRowId));
    view = await planCell(year1Id, cell);
    expect(view.detailCount).toBe(1);
    expect(view.total).toEqual({
      cashAmount: 5_400_000,
      inKindAmount: 0,
      plannedAmount: 5_400_000,
    });
    await expectInvariant(year1Id, cell);
  });

  it('마지막 행을 지우면 잠금만 풀리고 직전 합계가 남는다 (PL-9)', async () => {
    unwrap(await plan.deleteBudgetDetail(cashRowId));

    const view = await planCell(year1Id, cell);
    expect(view.detailCount).toBe(0);
    expect(view.locked).toBe(false);
    expect(view.total.plannedAmount).toBe(0); // 산출근거 합계는 0이지만…
    expect(view.saved.plannedAmount).toBe(5_400_000); // …직전 합계는 그대로 남는다
    expect(view.mismatch).toBe(false); // 잠기지 않은 셀의 저장값은 사람 입력이다

    // 잠금이 풀렸으므로 이제 매트릭스에서 직접 편집할 수 있다
    unwrap(await budget.updateBudgetPlan(year1Id, cell, 1_000_000, 1_000_000, 0));
    expect(await readPlanRow(year1Id, cell)).toMatchObject({ planned: 1_000_000 });
  });
});

describe('PL-9 잠금 — updateBudgetPlan 거부', () => {
  const cell: BudgetCategory = 'facility_equipment';

  it('산출근거가 있는 셀의 계획액 직접 편집은 RULE로 거부한다', async () => {
    const created = unwrap(
      await plan.createBudgetDetail(year1Id, cell, 'facility_lease', {
        axis: 'cash',
        name: '장비 임차',
        unitPrice: 2_000_000,
        factors: [{ label: '수량', value: 4, isPercent: false }],
      })
    );
    const before = await readPlanRow(year1Id, cell);
    expect(before.planned).toBe(8_000_000);

    const message = expectCode(
      await budget.updateBudgetPlan(year1Id, cell, 99_000_000, 99_000_000, 0),
      'RULE'
    );
    expect(message).toContain('산출근거가 있는 셀은 내역 합계로 확정됩니다');

    // 거부된 호출은 version조차 올리지 않아야 한다 (부분 반영 없음)
    expect(await readPlanRow(year1Id, cell)).toEqual(before);

    unwrap(await plan.deleteBudgetDetail(created.id));
  });
});

describe('O-1 낙관적 잠금 (§8.4)', () => {
  it('낡은 expectedVersion은 STALE로 거부하고 값을 바꾸지 않는다', async () => {
    const created = unwrap(
      await plan.createBudgetDetail(year1Id, 'activity', 'activity_meeting', {
        axis: 'cash',
        name: '회의비',
        unitPrice: 100_000,
        factors: [{ label: '회', value: 10, isPercent: false }],
      })
    );
    expect(created.amount).toBe(1_000_000);

    const updated = unwrap(
      await plan.updateBudgetDetail(created.id, { unitPrice: 200_000 }, created.version)
    );
    expect(updated.amount).toBe(2_000_000);
    expect(updated.version).toBe(created.version + 1); // N-5 트리거

    const message = expectCode(
      await plan.updateBudgetDetail(created.id, { unitPrice: 900_000 }, created.version),
      'STALE'
    );
    expect(message).toContain('먼저 수정했습니다'); // O-3

    expect(await readDetailAmount(created.id)).toBe(2_000_000);
    await expectInvariant(year1Id, 'activity');

    unwrap(await plan.deleteBudgetDetail(created.id));
  });
});

describe('reorderBudgetDetails (§9 — 그 세목의 전체 id 배열)', () => {
  const cell: BudgetCategory = 'activity';
  const subcategory = 'activity_travel_dom';
  const ids: string[] = [];

  beforeAll(async () => {
    for (const name of ['서울 출장', '대전 출장', '부산 출장']) {
      const created = unwrap(
        await plan.createBudgetDetail(year1Id, cell, subcategory, {
          axis: 'cash',
          name,
          unitPrice: 100_000,
          factors: [
            { label: '인원', value: 2, isPercent: false },
            { label: '횟수', value: 1, isPercent: false },
          ],
        })
      );
      ids.push(created.id);
    }
  });

  it('부분 배열은 거부한다 — 목록에 없는 행의 순서가 조용히 어긋난다', async () => {
    expectCode(
      await plan.reorderBudgetDetails(year1Id, cell, subcategory, [ids[0]!, ids[1]!]),
      'RULE'
    );

    const panel = unwrap(await plan.getBudgetDetails(year1Id, cell));
    expect(panel.rows.map((r) => r.detail.id)).toEqual(ids);
  });

  it('전체 배열을 받으면 0..n-1을 다시 부여한다', async () => {
    const reversed = [...ids].reverse();
    unwrap(await plan.reorderBudgetDetails(year1Id, cell, subcategory, reversed));

    const panel = unwrap(await plan.getBudgetDetails(year1Id, cell));
    expect(panel.rows.map((r) => r.detail.id)).toEqual(reversed);
    expect(panel.rows.map((r) => r.detail.order)).toEqual([0, 1, 2]);

    // 순서는 금액을 바꾸지 않는다 (PL-10 불변식 유지)
    await expectInvariant(year1Id, cell);
  });

  afterAll(async () => {
    for (const id of ids) unwrap(await plan.deleteBudgetDetail(id));
  });
});

describe('getBudgetDetails (§7.9.2 산출근거 패널)', () => {
  const createdIds: string[] = [];

  afterAll(async () => {
    for (const id of createdIds) unwrap(await plan.deleteBudgetDetail(id));
  });

  it('인건비 금액을 중간 반올림 없이 계산한다 (PL-1·PL-2, 부록 B.7.1)', async () => {
    const created = unwrap(
      await plan.createBudgetDetail(year1Id, 'personnel', 'personnel_internal', {
        axis: 'cash',
        memberId,
        factors: PERSONNEL_FACTORS(28, 9),
      })
    );
    createdIds.push(created.id);

    // 74,000,000 × 0.28 × 0.75 = 15,540,000 (월액 선반올림 경로면 15,540,001이 된다)
    expect(created.amount).toBe(15_540_000);

    const panel = unwrap(await plan.getBudgetDetails(year1Id, 'personnel'));
    const row = panel.rows.find((r) => r.detail.id === created.id);
    expect(row?.computed.amount).toBe(15_540_000);
    expect(row?.computed.negative).toBe(false);
    expect(row?.computed.missingSalary).toBe(false);
    // PL-D1: personnel 행의 품명·단가는 쓰이지 않으므로 빈 값으로 정규화된다
    expect(row?.detail.name).toBe('');
    expect(row?.detail.unitPrice).toBe(0);
    expect(panel.total.cashAmount).toBe(15_540_000);
  });

  it('연봉 미입력 인력은 금액 0 + 경고로 드러낸다 (§7.9.2)', async () => {
    const created = unwrap(
      await plan.createBudgetDetail(year1Id, 'personnel', 'personnel_external', {
        axis: 'cash',
        memberId: noSalaryMemberId,
        factors: PERSONNEL_FACTORS(50, 12),
      })
    );
    createdIds.push(created.id);
    expect(created.amount).toBe(0);

    const panel = unwrap(await plan.getBudgetDetails(year1Id, 'personnel'));
    const row = panel.rows.find((r) => r.detail.id === created.id);
    expect(row?.computed.missingSalary).toBe(true);
    expect(panel.missingSalaryCount).toBe(1);

    // 인력 드롭다운 원본을 함께 내린다 (이름·직위·연봉)
    expect(panel.members.map((m) => m.id)).toContain(noSalaryMemberId);
    expect(panel.members.find((m) => m.id === memberId)?.annualSalary).toBe(74_000_000);
    expect(panel.projectId).toBe(projectId);
  });
});

describe('지침 검증 (PL-11~PL-14) + setBudgetRateLimits', () => {
  const createdIds: string[] = [];

  afterAll(async () => {
    for (const id of createdIds) unwrap(await plan.deleteBudgetDetail(id));
  });

  it('E1은 연구지원인력인건비(C)를 세목 단위로 빼고, 간접비 기준액은 넣는다', async () => {
    // 2차년도에만 편성해 1차년도 테스트와 섞이지 않게 한다
    for (const [subcategory, member, rate] of [
      ['personnel_internal', memberId, 100],
      ['personnel_support', supportMemberId, 5],
    ] as const) {
      const created = unwrap(
        await plan.createBudgetDetail(year2Id, 'personnel', subcategory, {
          axis: 'cash',
          memberId: member,
          factors: PERSONNEL_FACTORS(rate, 12),
        })
      );
      createdIds.push(created.id);
    }
    // 인건비 = 74,000,000(A) + 5,000,000(C) = 79,000,000
    expect((await planCell(year2Id, 'personnel')).total.cashAmount).toBe(79_000_000);

    // 연구수당은 산출근거 없이 직접 편성한다 — 잠기지 않은 셀이므로 PL-9에 걸리지 않는다
    unwrap(await budget.updateBudgetPlan(year2Id, 'allowance', 20_000_000, 20_000_000, 0));
    unwrap(await plan.setBudgetRateLimits(projectId, { allowanceRateLimit: 20 }));

    const data = unwrap(await plan.getBudgetPlanData(projectId));
    const rules = data.yearRules.find((y) => y.yearId === year2Id)?.rules;
    if (!rules) throw new Error('2차년도 지침 검증 결과가 없습니다.');

    // PL-11: E1 = (79,000,000 − 5,000,000) + 0 = 74,000,000
    expect(rules.personnelSupportTotal).toBe(5_000_000);
    expect(rules.modifiedPersonnel).toBe(74_000_000);
    // PL-12: 20,000,000 / 74,000,000 × 100 ≈ 27.03% > 20% → 경고
    expect(rules.allowanceRate).toBeCloseTo(27.027, 3);
    expect(rules.allowanceLimit).toBe(20);
    expect(rules.allowanceOver).toBe(true);
    // PL-13: 기준액은 C를 포함한다 — 79,000,000 + 20,000,000 = 99,000,000
    expect(rules.indirectBase).toBe(99_000_000);
    expect(rules.indirectTotal).toBe(0);
    expect(rules.indirectRate).toBe(0);
    // PL-14·PL-15: 한도가 null이면 비율만 내고 위반 판정은 하지 않는다
    expect(rules.indirectLimit).toBeNull();
    expect(rules.indirectOver).toBe(false);
    expect(data.allowanceRateLimit).toBe(20);
    expect(data.indirectRateLimit).toBeNull();
  });

  it('한도율은 0~100 백분율만 받는다 (PL-14)', async () => {
    expectCode(await plan.setBudgetRateLimits(projectId, { indirectRateLimit: -1 }), 'VALIDATION');
    expectCode(await plan.setBudgetRateLimits(projectId, { indirectRateLimit: 101 }), 'VALIDATION');

    const project = unwrap(await plan.setBudgetRateLimits(projectId, { indirectRateLimit: 17.5 }));
    expect(project.indirectRateLimit).toBe(17.5);

    // O-1: 낡은 expectedVersion은 STALE
    expectCode(
      await plan.setBudgetRateLimits(projectId, { indirectRateLimit: 20 }, project.version - 1),
      'STALE'
    );

    // null은 "검사하지 않는다"는 뜻이라 0과 구분해 저장된다 (PL-15)
    const cleared = unwrap(
      await plan.setBudgetRateLimits(projectId, { indirectRateLimit: null }, project.version)
    );
    expect(cleared.indirectRateLimit).toBeNull();
  });
});

describe('getBudgetPlanData (§7.9 제안 모드)', () => {
  it('연차 × 비목 전 조합을 싣고 매트릭스 열 순서와 일치한다', async () => {
    const data = unwrap(await plan.getBudgetPlanData(projectId));

    expect(data.projectId).toBe(projectId);
    expect(data.matrix.columns.map((c) => c.yearId)).toEqual([year1Id, year2Id]);
    expect(data.years.map((y) => y.id)).toEqual([year1Id, year2Id]);
    expect(data.cells).toHaveLength(24); // 연차 2 × 비목 12
    expect(data.matrix.unmatchedItemCount).toBe(0);
    expect(data.mismatchCount).toBe(0); // PL-10 불변식이 깨진 셀이 없다
    expect(['원', '천원', '백만원']).toContain(data.currencyUnit);

    // 산출근거 합계는 잠긴 셀의 저장값과 같아야 한다
    for (const cell of data.cells.filter((c) => c.locked)) {
      expect(cell.saved.plannedAmount).toBe(cell.total.plannedAmount);
    }
  });

  // C5: 제안 모드 화면은 이 한 벌만 보고 표·잠금·B-3 배지를 그린다. 수행 조회(getBudgetMatrix)의
  // 결과를 빌려 쓰면 두 조회 사이의 저장이 한 표를 두 시점으로 갈라놓는다 (트랜잭션이 아니다)
  it('표·잠금·B-3 판정에 필요한 것을 같은 스냅샷에 함께 싣는다', async () => {
    const data = unwrap(await plan.getBudgetPlanData(projectId));
    const columnIds = new Set(data.matrix.columns.map((c) => c.yearId));

    // 매트릭스의 셀 잠금은 원본 행으로 갈린다(PL-9 detailCount · S-4 현금/현물 분리 · 행 없음).
    // 그 행이 cells와 같은 시점의 값이어야 옛 금액에 새 잠금이 걸리지 않는다
    expect(data.items.length).toBeGreaterThan(0);
    for (const item of data.items) {
      if (!columnIds.has(item.yearId)) continue; // 연차 목록에 없는 행은 표에 실리지 않는다
      const cell = data.cells.find((c) => c.yearId === item.yearId && c.category === item.category);
      expect(cell?.detailCount).toBe(item.detailCount);
      expect(cell?.saved).toEqual({
        plannedAmount: item.plannedAmount,
        cashAmount: item.cashAmount,
        inKindAmount: item.inKindAmount,
      });
    }

    // B-3: 열의 mismatch를 yearId로 색인만 바꾼 값이다 (getBudgetMatrix와 같은 모양)
    expect(Object.keys(data.yearBudgetChecks).sort()).toEqual(
      data.matrix.columns.map((c) => c.yearId).sort()
    );
    for (const column of data.matrix.columns) {
      expect(data.yearBudgetChecks[column.yearId]).toEqual(column.mismatch);
    }
  });
});
