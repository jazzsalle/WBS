// §7.9.6 [인건비] 탭 조회(getPersonnelTabData) 통합 테스트 — Phase 16 T12
// (SOT §7.9.6, §6.10 PL-1·PL-2·PL-11·PL-D7, §6.15 PS-2~PS-4·PS-6, §5.11, N-13)
//
// 소형 시드(부록 B.7 전체가 아니라 PL-2 회귀 행 + C>0 행 + 학생인건비 + 연봉 미입력 행)로 확인한다:
//  1. PL-D7 — 탭이 내리는 행 금액 = DB `budget_details.amount` (액션 경로가 RPC에 넣은 값). 박선욱 행
//     (74,000,000 × 28% × 9/12 = 15,540,000)이 월액 선반올림 없이 그대로다(PL-2).
//  2. PL-11 — E1 = `modifiedPersonnel(buildYearTotals(...))`. 연구지원인력인건비(C > 0)만 빠지고
//     학생인건비는 들어간다. 제안 모드 하단 요약(getBudgetPlanData)의 E1과도 같다.
//  3. PS-6 — 두 과제에 연결된 조직원 60%·12개월 + 50%·12개월 → otherProjectsRate 110, tone error.
//     연차 startDate가 없으면 null(0%가 아니다).
//  4. 행 모양 — 조직원·월급 표시(SL-1)·참여율·개월·기준 배지·연봉 미입력 플래그.
//  5. N-13 — 다른 과제의 연차 id로 부르면 RULE, uuid가 아니면 VALIDATION.
//
// 산출근거는 **실제 액션(createBudgetDetail)** 으로 넣는다 — 그래야 RPC가 budget_items를 함께 갱신하고(PL-10)
// 저장된 amount가 "서버가 계산한 값"이 된다. 세션·revalidatePath 스텁은 budget-plan-b7.test.ts와 같다.
// 자기가 만든 조직원·과제·사용자만 지운다 — 파괴적 테스트가 아니다.

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Sql } from 'postgres';
import { connectDirectDb, createTestUser, destroyTestUser, type TestUser } from './helpers';
import type { ActionResult, BudgetCategory, DetailAxis } from '@/types';
import * as projectsRepo from '@/lib/db/projects';
import * as yearsRepo from '@/lib/db/years';
import * as membersRepo from '@/lib/db/members';
import * as budgetDetailsRepo from '@/lib/db/budget-details';
import * as staffRepo from '@/lib/db/staff';
import { aggregateDetails, buildYearTotals, modifiedPersonnel } from '@/lib/budget-plan';
import { monthlyDisplay } from '@/lib/salary';

const session = vi.hoisted(() => ({ accessToken: '' }));

vi.mock('next/headers', () => ({
  cookies: async () => ({ get: () => ({ value: session.accessToken }) }),
}));
vi.mock('next/cache', () => ({ revalidatePath: () => undefined }));

const plan = await import('@/actions/budget-plan');

let sql: Sql;
let user: TestUser;
const tempProjectIds: string[] = []; // afterAll 안전망 — 이 테스트가 만든 것만 지운다
const tempStaffIds: string[] = [];

const RUN = `${Date.now()}-${randomUUID().slice(0, 8)}`;

let staffId: string; // 두 과제에 연결된 조직원
let projectA: string;
let yearA: string; // 2026-01-01 시작
let projectB: string;
let yearB: string; // 2026-03-01 시작 — 같은 달력 연도(PS-3)
let projectC: string;
let yearC: string; // startDate 없음
let linkedMemberA: string; // 조직원 연결, 36,000,000 → 60%·12 = 21,600,000
let pl2Member: string; // 미연결, 74,000,000 → 28%·9 = 15,540,000 (PL-2 회귀)
let supportMember: string; // 미연결, 36,000,000 → 연구지원인력 50%·12 현물 = 18,000,000 (C), 학생 100%·12 = 36,000,000
let nullSalaryMember: string; // 연봉 null → 0원 + missingSalary
// 과제 A의 산출근거 id. beforeAll이 전부 채운다 — 채우지 못하면 시드 자체가 실패한 것이다
const detailIdsA = {} as { linked: string; pl2: string; support: string; nullSalary: string; student: string };

function unwrap<T>(result: ActionResult<T>): T {
  if (!result.ok) throw new Error(`액션 실패: ${result.error} (code=${result.code ?? '-'})`);
  return result.data;
}

function expectCode(result: ActionResult<unknown>, code: string): string {
  if (result.ok) throw new Error(`실패해야 하는 호출이 통과했습니다 (기대 code=${code}).`);
  expect(result.code).toBe(code);
  return result.error;
}

async function newProject(name: string, contractStartDate: string | null): Promise<{ id: string; yearId: string }> {
  const project = await projectsRepo.createProjectWithDefaults(user.client, { name, contractStartDate });
  tempProjectIds.push(project.id);
  const first = (await yearsRepo.listYears(user.client, project.id))[0];
  if (!first) throw new Error('createProjectWithDefaults가 연차를 만들지 않았습니다.');
  if (first.startDate !== contractStartDate) {
    throw new Error(`연차 시작일이 기대와 다릅니다: ${first.startDate} (기대 ${contractStartDate})`);
  }
  return { id: project.id, yearId: first.id };
}

async function newMember(
  pid: string,
  name: string,
  annualSalary: number | null,
  linkedStaffId: string | null
): Promise<string> {
  const created = await membersRepo.createMember(
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
      staffId: linkedStaffId,
    },
    user.id
  );
  return created.id;
}

// 실제 액션 경로 — RPC가 같은 트랜잭션에서 budget_items를 갱신한다(PL-10)
async function seedRow(
  yearId: string,
  category: BudgetCategory,
  subcategory: string,
  memberId: string,
  rate: number,
  months: number,
  axis: DetailAxis
): Promise<string> {
  const created = unwrap(
    await plan.createBudgetDetail(yearId, category, subcategory, {
      axis,
      memberId,
      factors: [
        { label: '참여율(%)', value: rate, isPercent: true },
        { label: '참여기간(월)', value: months, isPercent: false },
      ],
      adjustment: 0,
    })
  );
  return created.id;
}

// bigint는 postgres.js가 문자열로 주므로 text로 캐스팅해 정수로 되돌린다 (부동소수점 경유 금지)
async function readStoredAmount(id: string): Promise<number> {
  const rows = await sql`select amount::text as amount from public.budget_details where id = ${id}::uuid`;
  const row = rows[0] as { amount: string } | undefined;
  if (!row) throw new Error('산출근거 행을 찾을 수 없습니다.');
  return Number(row.amount);
}

beforeAll(async () => {
  sql = connectDirectDb();
  user = await createTestUser(sql);
  session.accessToken = user.accessToken;

  staffId = (
    await staffRepo.createStaff(user.client, {
      name: '두 과제 조직원',
      email: `personnel-tab-${RUN}@unes.co.kr`,
      position: '책임연구원',
      employed: true,
      note: '',
      order: 0,
      createdBy: user.id,
      updatedBy: user.id,
    })
  ).id;
  tempStaffIds.push(staffId);

  ({ id: projectA, yearId: yearA } = await newProject(`인건비 탭 A ${RUN}`, '2026-01-01'));
  ({ id: projectB, yearId: yearB } = await newProject(`인건비 탭 B ${RUN}`, '2026-03-01'));
  ({ id: projectC, yearId: yearC } = await newProject(`인건비 탭 C ${RUN}`, null));

  linkedMemberA = await newMember(projectA, '연결된 인력', 36_000_000, staffId);
  pl2Member = await newMember(projectA, '박선욱', 74_000_000, null);
  supportMember = await newMember(projectA, '지원 인력', 36_000_000, null);
  nullSalaryMember = await newMember(projectA, '연봉 미입력 인력', null, null);

  detailIdsA.linked = await seedRow(yearA, 'personnel', 'personnel_internal', linkedMemberA, 60, 12, 'cash');
  detailIdsA.pl2 = await seedRow(yearA, 'personnel', 'personnel_internal', pl2Member, 28, 9, 'cash');
  detailIdsA.support = await seedRow(yearA, 'personnel', 'personnel_support', supportMember, 50, 12, 'in_kind');
  detailIdsA.nullSalary = await seedRow(yearA, 'personnel', 'personnel_internal', nullSalaryMember, 10, 12, 'cash');
  detailIdsA.student = await seedRow(yearA, 'student_personnel', 'student_general', supportMember, 100, 12, 'cash');

  // 과제 B: 같은 조직원 50%·12개월 → A의 60%와 합쳐 110 (PS-2·PS-4)
  const linkedMemberB = await newMember(projectB, '연결된 인력 B', 36_000_000, staffId);
  await seedRow(yearB, 'personnel', 'personnel_internal', linkedMemberB, 50, 12, 'cash');

  // 과제 C: startDate 없는 연차 — 연도 미정
  const linkedMemberC = await newMember(projectC, '연결된 인력 C', 36_000_000, staffId);
  await seedRow(yearC, 'personnel', 'personnel_internal', linkedMemberC, 20, 12, 'cash');
});

afterAll(async () => {
  // 과제 삭제가 members·years·budget_details·budget_items를 cascade로 함께 지운다 (H-5, PL-D8)
  if (tempProjectIds.length > 0) {
    await sql`delete from public.projects where id = any(${tempProjectIds}::uuid[])`;
  }
  if (tempStaffIds.length > 0) {
    await sql`delete from public.staff where id = any(${tempStaffIds}::uuid[])`;
  }
  const rows = await sql`
    select ((select count(*) from public.projects       where id = any(${tempProjectIds}::uuid[]))
          + (select count(*) from public.budget_details where project_id = any(${tempProjectIds}::uuid[]))
          + (select count(*) from public.staff          where id = any(${tempStaffIds}::uuid[])))::text as n`;
  const remaining = Number((rows[0] as { n: string }).n);
  if (remaining !== 0) throw new Error(`테스트가 만든 데이터가 ${remaining}건 남았습니다.`);
  await destroyTestUser(sql, user);
  await sql.end();
});

describe('getPersonnelTabData — 행·금액·E1 (PL-D7·PL-11)', () => {
  it('인건비·학생인건비 행만, 비목 → 세목 순으로 5행', async () => {
    const data = unwrap(await plan.getPersonnelTabData(projectA, yearA));
    expect(data.year.id).toBe(yearA);
    // 비목(personnel → student_personnel) → 세목(부록 A.5: internal → support) → order 순
    expect(data.rows.map((r) => r.detail.id)).toEqual([
      detailIdsA.linked,
      detailIdsA.pl2,
      detailIdsA.nullSalary,
      detailIdsA.support,
      detailIdsA.student,
    ]);
    expect(data.rows.every((r) => r.detail.formula === 'personnel')).toBe(true);
    expect(data.years.map((y) => y.id)).toContain(yearA);
    expect(data.itemOnlyCategories).toEqual([]);
  });

  it('행 금액 = DB budget_details.amount, PL-2 회귀 행은 15,540,000', async () => {
    const data = unwrap(await plan.getPersonnelTabData(projectA, yearA));
    for (const row of data.rows) {
      expect(row.amount, row.detail.id).toBe(await readStoredAmount(row.detail.id));
    }
    const byId = new Map(data.rows.map((r) => [r.detail.id, r]));
    expect(byId.get(detailIdsA.linked)!.amount).toBe(21_600_000);
    expect(byId.get(detailIdsA.pl2)!.amount).toBe(15_540_000);
    expect(byId.get(detailIdsA.support)!.amount).toBe(18_000_000);
    expect(byId.get(detailIdsA.student)!.amount).toBe(36_000_000);
    // 연봉 null → 0원 + 경고 플래그. 조용히 0으로 보이지 않는다
    const nullRow = byId.get(detailIdsA.nullSalary)!;
    expect(nullRow.amount).toBe(0);
    expect(nullRow.missingSalary).toBe(true);
    expect(nullRow.monthlyDisplay).toBeNull();
  });

  it('합계·E1 = modifiedPersonnel(buildYearTotals) — C(연구지원인력)만 빠지고 학생인건비는 들어간다', async () => {
    const data = unwrap(await plan.getPersonnelTabData(projectA, yearA));
    // 현금 21,600,000 + 15,540,000 + 0 + 36,000,000 · 현물 18,000,000
    expect(data.totals.cash).toBe(73_140_000);
    expect(data.totals.inKind).toBe(18_000_000);
    // E1 = (91,140,000 − 18,000,000 C) = 73,140,000 — 합계와 우연히 같은 값이라 C 제외를 따로 확인한다
    expect(data.totals.e1).toBe(73_140_000);
    expect(data.totals.e1).toBe(data.totals.cash + data.totals.inKind - 18_000_000);

    // 같은 원본 행으로 lib/budget-plan.ts가 내는 값과 원 단위까지 같다 (PL-10a)
    const details = (await budgetDetailsRepo.listByProject(user.client, projectA)).filter(
      (d) => d.yearId === yearA && (d.category === 'personnel' || d.category === 'student_personnel')
    );
    const members = await membersRepo.listMembers(user.client, projectA);
    const aggregate = aggregateDetails(details, members);
    expect(data.totals.e1).toBe(modifiedPersonnel(buildYearTotals(aggregate.cells)));

    // 제안 모드 하단 요약과 같은 E1 — 두 화면이 다른 값을 보이면 안 된다
    const planData = unwrap(await plan.getBudgetPlanData(projectA));
    const yearRule = planData.yearRules.find((y) => y.yearId === yearA);
    expect(yearRule?.rules.modifiedPersonnel).toBe(data.totals.e1);
  });

  it('행 모양 — 조직원·월급 표시(SL-1)·참여율·개월·기준 배지', async () => {
    const data = unwrap(await plan.getPersonnelTabData(projectA, yearA));
    const byId = new Map(data.rows.map((r) => [r.detail.id, r]));

    const linked = byId.get(detailIdsA.linked)!;
    expect(linked.staff?.id).toBe(staffId);
    expect(linked.member?.id).toBe(linkedMemberA);
    expect(linked.monthlyDisplay).toBe(monthlyDisplay(36_000_000)); // 3,000,000
    expect(linked.participation).toBe(60);
    expect(linked.months).toBe(12);
    expect(linked.basisBadge.labels).toEqual(['기록 없음']); // 수동 입력 — 스냅샷 3필드 null
    expect(linked.appliedFrom).toBeNull();

    const pl2 = byId.get(detailIdsA.pl2)!;
    expect(pl2.staff).toBeNull();
    expect(pl2.monthlyDisplay).toBe(6_166_667); // 표시만 반올림 — 금액 15,540,000에는 쓰이지 않았다
    expect(pl2.participation).toBe(28);
    expect(pl2.months).toBe(9);
  });
});

describe('getPersonnelTabData — PS-6 다른 과제 포함 계상률', () => {
  it('두 과제 60%·12 + 50%·12 → 110, tone error (연차 시작 연도 2026 기준)', async () => {
    const data = unwrap(await plan.getPersonnelTabData(projectA, yearA));
    expect(data.rateYear).toBe(2026);
    expect(data.otherProjectsRate).not.toBeNull();
    // 과제 C(startDate 없음)의 20%는 연도 미정이라 들어가지 않는다(PS-3)
    expect(data.otherProjectsRate![staffId]).toEqual({ total: 110, tone: 'error' });
    // 이 과제의 연결 조직원만 실린다
    expect(Object.keys(data.otherProjectsRate!)).toEqual([staffId]);

    const fromB = unwrap(await plan.getPersonnelTabData(projectB, yearB));
    expect(fromB.otherProjectsRate![staffId]).toEqual({ total: 110, tone: 'error' });
  });

  it('startDate 없는 연차 → otherProjectsRate·rateYear null (0%가 아니다)', async () => {
    const data = unwrap(await plan.getPersonnelTabData(projectC, yearC));
    expect(data.year.startDate).toBeNull();
    expect(data.rateYear).toBeNull();
    expect(data.otherProjectsRate).toBeNull();
    expect(data.rows).toHaveLength(1);
    expect(data.rows[0]!.staff?.id).toBe(staffId);
  });
});

describe('getPersonnelTabData — 경계 검증 (N-13)', () => {
  it('다른 과제의 연차 id → RULE', async () => {
    expect(expectCode(await plan.getPersonnelTabData(projectA, yearB), 'RULE')).toContain('속하지 않은 연차');
  });

  it('uuid가 아니면 VALIDATION', async () => {
    expectCode(await plan.getPersonnelTabData('not-a-uuid', yearA), 'VALIDATION');
    expectCode(await plan.getPersonnelTabData(projectA, 'not-a-uuid'), 'VALIDATION');
  });
});
