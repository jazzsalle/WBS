// §7.10 조직원 연결 · [급여 반영] 서버 액션 통합 테스트 — Phase 16 T6
// (SOT §5.11 스냅샷, §5.19 ST-2, §5.20 SL-1·SL-2·SL-4·SL-5, §6.10 PL-10a·PL-10b, §8.4 O-1·O-3, §9 Staff 블록)
//
// 세션·revalidatePath 스텁은 team-actions.test.ts와 같은 방식이다. 산출근거 시드는
// budget-plan-actions.test.ts처럼 리포지토리로 직접 넣는다(액션의 검증 경로는 그쪽 테스트가 본다).
//
// 검증의 핵심:
//  1. [급여 반영]은 새 산식이 아니라 PL-10b 경로(apply_salary_change)를 탄다 — 저장된 연봉·산출근거
//     금액·비목 총액·스냅샷 3필드가 **한 번에** 바뀐다. 월급 3,000,000 → 36,000,000 → 50%·12개월 = 18,000,000
//  2. 연결·이력·기준일 — 하나라도 없으면 명시적 실패(절대 규칙 5). 빈 값으로 채우지 않는다(SL-2)
//  3. 수동 연봉 수정은 스냅샷을 null로 되돌린다(PL-10b v4.7) — 거짓 배지가 남지 않는다
//  4. 급여 이력을 고쳐도 과제 Member는 움직이지 않는다(SL-5)
//  5. 한 과제 안에서 같은 조직원을 두 Member가 가리킬 수 없다 — 다른 과제는 가능하다
//
// 자기가 만든 조직원·과제·사용자만 지운다 — 파괴적 테스트가 아니다.

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Sql } from 'postgres';
import { connectDirectDb, createTestUser, destroyTestUser, type TestUser } from './helpers';
import type { ActionResult } from '@/types';
import * as projectsRepo from '@/lib/db/projects';
import * as yearsRepo from '@/lib/db/years';
import * as membersRepo from '@/lib/db/members';
import * as budgetDetails from '@/lib/db/budget-details';
import * as staffRepo from '@/lib/db/staff';

const session = vi.hoisted(() => ({ accessToken: '' }));

vi.mock('next/headers', () => ({
  cookies: async () => ({ get: () => ({ value: session.accessToken }) }),
}));
vi.mock('next/cache', () => ({ revalidatePath: () => undefined }));

const team = await import('@/actions/team');

let sql: Sql;
let user: TestUser;
const tempProjectIds: string[] = []; // afterAll 안전망 — 실패해도 dev DB를 원복한다
const tempStaffIds: string[] = [];

// 실행마다 다른 이메일 — 이전 실행 잔여물과 ST-1 충돌을 일으키지 않기 위해서다
const RUN = `${Date.now()}-${randomUUID().slice(0, 8)}`;

let projectId: string;
let yearId: string; // 2026-01-01 시작 — [급여 반영] 기준일의 출처
let memberId: string; // 연봉 30,000,000으로 시작 → 반영 후 36,000,000
let unlinkedMemberId: string;
let staffId: string; // 급여 이력 있음
let salaryId: string;
let bareStaffId: string; // 급여 이력 없음
let detailId: string;

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

// 액션 반환값이 아니라 저장된 원본을 본다 — "같은 트랜잭션에서 함께 바뀌었는가"는 DB만 답한다.
// bigint는 postgres.js가 문자열로 주므로 text로 캐스팅해 정수로 되돌린다 (부동소수점 경유 금지)
interface MemberRow {
  annualSalary: number | null;
  staffId: string | null;
  includesRetirement: boolean | null;
  includesInsurance: boolean | null;
  appliedFrom: string | null;
}

async function readMemberRow(id: string): Promise<MemberRow> {
  const rows = await sql`
    select annual_salary::text as annual_salary, staff_id::text as staff_id,
           salary_includes_retirement, salary_includes_insurance,
           to_char(salary_applied_from, 'YYYY-MM-DD') as applied_from
      from public.members where id = ${id}::uuid`;
  const row = rows[0] as
    | {
        annual_salary: string | null;
        staff_id: string | null;
        salary_includes_retirement: boolean | null;
        salary_includes_insurance: boolean | null;
        applied_from: string | null;
      }
    | undefined;
  if (!row) throw new Error('인력 행을 찾을 수 없습니다.');
  return {
    annualSalary: row.annual_salary === null ? null : Number(row.annual_salary),
    staffId: row.staff_id,
    includesRetirement: row.salary_includes_retirement,
    includesInsurance: row.salary_includes_insurance,
    appliedFrom: row.applied_from,
  };
}

async function readDetailAmount(id: string): Promise<number> {
  const rows = await sql`
    select amount::text as amount from public.budget_details where id = ${id}::uuid`;
  const row = rows[0] as { amount: string } | undefined;
  if (!row) throw new Error('산출근거 행을 찾을 수 없습니다.');
  return Number(row.amount);
}

async function readPlanned(category: string): Promise<number> {
  const rows = await sql`
    select planned_amount::text as planned from public.budget_items
     where year_id = ${yearId}::uuid and category = ${category}`;
  const row = rows[0] as { planned: string } | undefined;
  if (!row) throw new Error(`비목 행(${category})을 찾을 수 없습니다.`);
  return Number(row.planned);
}

async function newStaff(name: string): Promise<string> {
  const created = await staffRepo.createStaff(user.client, {
    name,
    email: `apply-${RUN}-${randomUUID().slice(0, 6)}@unes.co.kr`,
    position: '연구원',
    employed: true,
    note: '',
    order: 0,
    createdBy: user.id,
    updatedBy: user.id,
  });
  tempStaffIds.push(created.id);
  return created.id;
}

async function newMember(pid: string, name: string, annualSalary: number | null): Promise<string> {
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
    },
    user.id
  );
  return created.id;
}

beforeAll(async () => {
  sql = connectDirectDb();
  user = await createTestUser(sql);
  session.accessToken = user.accessToken;

  staffId = await newStaff('급여 있는 조직원');
  salaryId = (
    await staffRepo.createSalary(user.client, {
      staffId,
      effectiveFrom: '2026-01-01',
      basis: 'monthly',
      amount: 3_000_000,
      includesRetirement: true,
      includesInsurance: false,
      note: '2026 연봉계약',
      createdBy: user.id,
      updatedBy: user.id,
    })
  ).id;
  bareStaffId = await newStaff('이력 없는 조직원');

  const project = await projectsRepo.createProjectWithDefaults(user.client, {
    name: '급여 반영 액션 테스트 과제',
    contractStartDate: '2026-01-01',
  });
  projectId = project.id;
  tempProjectIds.push(projectId);

  const firstYear = (await yearsRepo.listYears(user.client, projectId))[0];
  if (!firstYear) throw new Error('createProjectWithDefaults가 연차를 만들지 않았습니다.');
  if (firstYear.startDate !== '2026-01-01') {
    throw new Error(`연차 시작일이 기대와 다릅니다: ${firstYear.startDate}`);
  }
  yearId = firstYear.id;

  memberId = await newMember(projectId, '한봄희', 30_000_000);
  unlinkedMemberId = await newMember(projectId, '미연결 인력', null);
});

afterAll(async () => {
  if (tempProjectIds.length > 0) {
    await sql`delete from public.projects where id = any(${tempProjectIds}::uuid[])`;
  }
  // 급여 이력은 cascade로 함께 지워진다 (ST-2)
  if (tempStaffIds.length > 0) {
    await sql`delete from public.staff where id = any(${tempStaffIds}::uuid[])`;
  }

  // 잔여 데이터 0 확인 — 사용자 삭제 전에 본다(삭제하면 created_by가 null이 되어 추적이 끊긴다)
  const rows = await sql`
    select ((select count(*) from public.projects       where id = any(${tempProjectIds}::uuid[]))
          + (select count(*) from public.members        where project_id = any(${tempProjectIds}::uuid[]))
          + (select count(*) from public.budget_details where project_id = any(${tempProjectIds}::uuid[]))
          + (select count(*) from public.staff          where id = any(${tempStaffIds}::uuid[]))
          + (select count(*) from public.staff_salaries where staff_id = any(${tempStaffIds}::uuid[])))::text as n`;
  const remaining = Number((rows[0] as { n: string }).n);
  if (remaining !== 0) throw new Error(`테스트가 만든 데이터가 ${remaining}건 남았습니다.`);

  await destroyTestUser(sql, user);
  await sql.end();
});

describe('linkMemberToStaff (§7.10 — 연봉은 건드리지 않는다)', () => {
  it('미연결 인력의 [급여 반영]은 RULE — 이력이 있어도 연결이 먼저다', async () => {
    const message = expectCode(await team.previewStaffSalaryApply(memberId, '2026-03-01'), 'RULE');
    expect(message).toContain('연결');
    expectCode(await team.applyStaffSalary(memberId, '2026-03-01'), 'RULE');
    expect((await readMemberRow(memberId)).annualSalary).toBe(30_000_000);
  });

  it('staffId만 바뀌고 annualSalary·스냅샷은 그대로다', async () => {
    const linked = unwrap(await team.linkMemberToStaff(memberId, staffId));
    expect(linked.staffId).toBe(staffId);
    expect(linked.annualSalary).toBe(30_000_000);
    expect(linked.salaryIncludesRetirement).toBeNull();
    expect(linked.salaryAppliedFrom).toBeNull();
    expect(await readMemberRow(memberId)).toMatchObject({ staffId, annualSalary: 30_000_000 });
  });

  it('없는 조직원은 실패한다 (FK 문구가 아니라 사용자 문구)', async () => {
    const res = await team.linkMemberToStaff(unlinkedMemberId, randomUUID());
    if (res.ok) throw new Error('없는 조직원 연결이 통과했습니다.');
    expect(res.error).toContain('조직원');
    expect((await readMemberRow(unlinkedMemberId)).staffId).toBeNull();
  });

  it('같은 과제의 다른 인력이 이미 가리키는 조직원은 RULE — 다른 과제는 정상이다', async () => {
    const message = expectCode(await team.linkMemberToStaff(unlinkedMemberId, staffId), 'RULE');
    expect(message).toContain('이미 이 과제의 다른 인력에 연결');
    expect((await readMemberRow(unlinkedMemberId)).staffId).toBeNull();

    // 같은 사람을 다시 자기 자신에게 연결하는 것은 중복이 아니다 (멱등)
    unwrap(await team.linkMemberToStaff(memberId, staffId));

    const other = await projectsRepo.createProjectWithDefaults(user.client, {
      name: '급여 반영 액션 다른 과제',
      contractStartDate: '2026-01-01',
    });
    tempProjectIds.push(other.id);
    const otherMemberId = await newMember(other.id, '다른 과제의 같은 사람', null);
    expect(unwrap(await team.linkMemberToStaff(otherMemberId, staffId)).staffId).toBe(staffId);
  });

  it('null이면 연결을 끊는다 — 연봉은 남는다', async () => {
    const tempId = await newMember(projectId, '임시 연결', 10_000_000);
    unwrap(await team.linkMemberToStaff(tempId, bareStaffId));
    const unlinked = unwrap(await team.linkMemberToStaff(tempId, null));
    expect(unlinked.staffId).toBeNull();
    expect(unlinked.annualSalary).toBe(10_000_000);
    await membersRepo.removeMember(user.client, tempId);
  });
});

describe('previewStaffSalaryApply · applyStaffSalary (SL-1·SL-2·SL-4, PL-10b 경로)', () => {
  it('이력 없는 조직원에 연결된 인력은 RULE — /staff 안내 문구', async () => {
    unwrap(await team.linkMemberToStaff(unlinkedMemberId, bareStaffId));
    const message = expectCode(
      await team.previewStaffSalaryApply(unlinkedMemberId, '2026-03-01'),
      'RULE'
    );
    expect(message).toContain('급여 이력이 없습니다');
    expect(message).toContain('/staff');
    expectCode(await team.applyStaffSalary(unlinkedMemberId, '2026-03-01'), 'RULE');
    expect((await readMemberRow(unlinkedMemberId)).annualSalary).toBeNull();
    unwrap(await team.linkMemberToStaff(unlinkedMemberId, null));
  });

  it('기준일이 첫 이력보다 앞이면 RULE — 빈 값으로 채우지 않는다 (SL-2)', async () => {
    expectCode(await team.previewStaffSalaryApply(memberId, '2025-12-31'), 'RULE');
    expectCode(await team.applyStaffSalary(memberId, '2025-12-31'), 'RULE');
    expect((await readMemberRow(memberId)).annualSalary).toBe(30_000_000);
  });

  it('기준일 형식이 틀리면 VALIDATION', async () => {
    expectCode(await team.previewStaffSalaryApply(memberId, '2026/03/01'), 'VALIDATION');
    expectCode(await team.applyStaffSalary(memberId, ''), 'VALIDATION');
  });

  it('미리보기: 월급 3,000,000 → 연봉 36,000,000, 50%·12개월 산출근거 1건 → 18,000,000. 저장하지 않는다', async () => {
    // 30,000,000 × 50% × 12/12 = 15,000,000 (PL-1)
    detailId = (
      await budgetDetails.upsertDetail(user.client, {
        projectId,
        yearId,
        category: 'personnel',
        subcategory: 'personnel_internal',
        axis: 'cash',
        formula: 'personnel',
        memberId,
        name: '',
        unitPrice: 0,
        spec: '',
        factors: [
          { label: '참여율(%)', value: 50, isPercent: true },
          { label: '참여기간(월)', value: 12, isPercent: false },
        ],
        adjustment: 0,
        note: '',
        order: 0,
        amount: 15_000_000,
      })
    ).id;
    expect(await readPlanned('personnel')).toBe(15_000_000);

    const preview = unwrap(await team.previewStaffSalaryApply(memberId, '2026-03-01'));
    expect(preview.salary.id).toBe(salaryId);
    expect(preview.annualSalary).toBe(36_000_000);
    expect(preview.monthlyDisplay).toBe(3_000_000);
    expect(preview.currentAnnualSalary).toBe(30_000_000);
    expect(preview.detailCount).toBe(1);
    expect(preview.byYear).toEqual([
      { yearId, name: '1차년도', before: 15_000_000, after: 18_000_000 },
    ]);
    expect(preview.snapshot).toEqual({
      salaryIncludesRetirement: true,
      salaryIncludesInsurance: false,
      salaryAppliedFrom: '2026-01-01',
    });

    // 미리보기는 저장하지 않는다 (§7.10)
    expect(await readMemberRow(memberId)).toMatchObject({
      annualSalary: 30_000_000,
      includesRetirement: null,
      appliedFrom: null,
    });
    expect(await readDetailAmount(detailId)).toBe(15_000_000);
  });

  it('반영: 연봉·스냅샷 3필드·산출근거 금액·비목 총액이 함께 바뀐다 (PL-10b)', async () => {
    const applied = unwrap(await team.applyStaffSalary(memberId, '2026-03-01'));
    expect(applied.annualSalary).toBe(36_000_000);
    expect(applied.salaryIncludesRetirement).toBe(true);
    expect(applied.salaryIncludesInsurance).toBe(false);
    expect(applied.salaryAppliedFrom).toBe('2026-01-01');

    expect(await readMemberRow(memberId)).toEqual({
      annualSalary: 36_000_000,
      staffId,
      includesRetirement: true,
      includesInsurance: false,
      appliedFrom: '2026-01-01',
    });
    expect(await readDetailAmount(detailId)).toBe(18_000_000);
    expect(await readPlanned('personnel')).toBe(18_000_000);
  });

  it('낡은 expectedVersion은 STALE (O-1) — 아무것도 바뀌지 않는다', async () => {
    const current = await membersRepo.getMemberById(user.client, memberId);
    const stale = await team.applyStaffSalary(memberId, '2026-03-01', current.version - 1);
    expectCode(stale, 'STALE');
    expect((await membersRepo.getMemberById(user.client, memberId)).version).toBe(current.version);
    expect(await readPlanned('personnel')).toBe(18_000_000);
  });
});

describe('수동 수정 · 이력 변경 이후 (PL-10b v4.7, SL-5)', () => {
  it('updateMember로 연봉을 손으로 고치면 스냅샷 3필드가 null로 돌아간다', async () => {
    const updated = unwrap(await team.updateMember(memberId, { annualSalary: 40_000_000 }));
    expect(updated.annualSalary).toBe(40_000_000);
    expect(updated.salaryIncludesRetirement).toBeNull();
    expect(updated.salaryIncludesInsurance).toBeNull();
    expect(updated.salaryAppliedFrom).toBeNull();
    // 연결 자체는 유지된다 — 스냅샷만 "기록 없음"이다
    expect(updated.staffId).toBe(staffId);

    expect(await readMemberRow(memberId)).toEqual({
      annualSalary: 40_000_000,
      staffId,
      includesRetirement: null,
      includesInsurance: null,
      appliedFrom: null,
    });
    // 40,000,000 × 50% × 12/12 = 20,000,000
    expect(await readDetailAmount(detailId)).toBe(20_000_000);
    expect(await readPlanned('personnel')).toBe(20_000_000);
  });

  it('연봉 외 필드만 고치면 스냅샷은 건드리지 않는다', async () => {
    unwrap(await team.applyStaffSalary(memberId, '2026-03-01'));
    const touched = unwrap(await team.updateMember(memberId, { position: '책임연구원' }));
    expect(touched.annualSalary).toBe(36_000_000);
    expect(touched.salaryIncludesRetirement).toBe(true);
    expect(touched.salaryAppliedFrom).toBe('2026-01-01');
  });

  it('patch에 staffId·스냅샷을 실어도 받지 않는다 — 연결·반영은 전용 액션뿐', async () => {
    // zod partial은 미지의 키를 벗겨 낸다(strict 아님). 값이 바뀌지 않았음을 저장값으로 확인한다
    const res = unwrap(
      await team.updateMember(memberId, {
        staffId: null,
        salaryIncludesRetirement: false,
        salaryAppliedFrom: '2030-01-01',
        field: '제어 SW',
      })
    );
    expect(res.field).toBe('제어 SW');
    expect(await readMemberRow(memberId)).toMatchObject({
      staffId,
      includesRetirement: true,
      appliedFrom: '2026-01-01',
    });
  });

  it('급여 이력을 4,000,000으로 고쳐도 Member는 움직이지 않는다 (SL-5) — 다시 반영해야 바뀐다', async () => {
    const salary = await staffRepo.updateSalary(user.client, salaryId, { amount: 4_000_000 });
    expect(salary.amount).toBe(4_000_000);

    expect(await readMemberRow(memberId)).toMatchObject({
      annualSalary: 36_000_000,
      includesRetirement: true,
      appliedFrom: '2026-01-01',
    });
    expect(await readDetailAmount(detailId)).toBe(18_000_000);
    expect(await readPlanned('personnel')).toBe(18_000_000);

    // 미리보기가 새 값을 보여 주고, 반영을 눌러야 비로소 바뀐다
    const preview = unwrap(await team.previewStaffSalaryApply(memberId, '2026-03-01'));
    expect(preview.annualSalary).toBe(48_000_000);
    expect(preview.byYear[0]).toMatchObject({ before: 18_000_000, after: 24_000_000 });
    unwrap(await team.applyStaffSalary(memberId, '2026-03-01'));
    expect((await readMemberRow(memberId)).annualSalary).toBe(48_000_000);
    expect(await readPlanned('personnel')).toBe(24_000_000);
  });

  it('조직원을 지우면 staffId만 null이 되고 연봉·스냅샷은 남는다 (ST-2)', async () => {
    await staffRepo.removeStaff(user.client, staffId);
    expect(await readMemberRow(memberId)).toEqual({
      annualSalary: 48_000_000,
      staffId: null,
      includesRetirement: true,
      includesInsurance: false,
      appliedFrom: '2026-01-01',
    });
    // 연결이 끊겼으니 다시 반영할 수 없다
    expectCode(await team.previewStaffSalaryApply(memberId, '2026-03-01'), 'RULE');
  });
});
