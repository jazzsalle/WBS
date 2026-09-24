// staff·members·budget-details·years 리포지토리 통합 테스트 — Phase 16 T4
// (SOT §5.19 ST-1·ST-2, §5.20 SL-3, §6.15 PS-5, §8.4 O-1~O-3, §8.6, §12 1000행 페이징)
//
// publishable 키 + 실제 세션으로 리포지토리를 부른다 — RLS 경로·PostgREST 에러 코드
// (23505·23514)가 사용자 문구의 RepositoryError로 바뀌는지가 검증 대상이다.
// 스키마·RPC 계약 자체는 staff-migration.test.ts가 직결 SQL로 이미 검증한다.
// 직결 SQL은 벌크 시드(1,005행 — API 왕복 1,005번은 무의미하게 느리다)와 정리 전용이다.
//
// 자기가 만든 조직원·과제·사용자만 지운다 — 파괴적 테스트가 아니다.

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Sql } from 'postgres';
import { connectDirectDb, createTestUser, destroyTestUser, type TestUser } from './helpers';
import * as projects from '@/lib/db/projects';
import * as stages from '@/lib/db/stages';
import * as years from '@/lib/db/years';
import * as members from '@/lib/db/members';
import * as budgetDetails from '@/lib/db/budget-details';
import * as staff from '@/lib/db/staff';
import { ConflictError, NotFoundError, RuleViolationError, StaleDataError } from '@/lib/db/errors';

let sql: Sql;
let user: TestUser;
const tempProjectIds: string[] = []; // afterAll 안전망 — 실패해도 dev DB를 원복한다
const tempStaffIds: string[] = [];

// 실행마다 다른 이메일 — 이전 실행 잔여물과 ST-1 충돌을 일으키지 않기 위해서다
const RUN = `${Date.now()}-${randomUUID().slice(0, 8)}`;

// PostgREST 기본 max-rows(1000)를 반드시 넘겨야 절단이 드러난다
const BULK_COUNT = 1005;

async function newProject(name: string): Promise<string> {
  const project = await projects.createProject(user.client, {
    name,
    createdBy: user.id,
    updatedBy: user.id,
  });
  tempProjectIds.push(project.id);
  return project.id;
}

function staffInput(overrides: Partial<staff.StaffInput> = {}): staff.StaffInput {
  return {
    name: '테스트 조직원',
    email: `staff-${RUN}-${randomUUID().slice(0, 6)}@unes.co.kr`,
    position: '연구원',
    employed: true,
    note: '',
    order: 0,
    createdBy: user.id,
    updatedBy: user.id,
    ...overrides,
  };
}

async function newStaff(overrides: Partial<staff.StaffInput> = {}): Promise<staff.StaffInput & { id: string; version: number }> {
  const created = await staff.createStaff(user.client, staffInput(overrides));
  tempStaffIds.push(created.id);
  return { ...staffInput(overrides), ...created };
}

function salaryInput(
  staffId: string,
  overrides: Partial<staff.StaffSalaryInput> = {}
): staff.StaffSalaryInput {
  return {
    staffId,
    effectiveFrom: '2026-01-01',
    basis: 'annual',
    amount: 40_000_000,
    includesRetirement: true,
    includesInsurance: false,
    note: '',
    createdBy: user.id,
    updatedBy: user.id,
    ...overrides,
  };
}

function memberInput(projectId: string, overrides: Partial<members.MemberInput> = {}): members.MemberInput {
  return {
    projectId,
    orgId: null,
    name: '연결 인력',
    role: 'researcher',
    position: '',
    field: '',
    email: '',
    phone: '',
    active: true,
    order: 0,
    annualSalary: null,
    hireType: 'existing',
    ...overrides,
  };
}

beforeAll(async () => {
  sql = connectDirectDb();
  user = await createTestUser(sql);
});

afterAll(async () => {
  // 과제 삭제가 members·years·budget_details를 cascade로 함께 지운다 (H-5, PL-D8)
  if (tempProjectIds.length > 0) {
    await sql`delete from public.projects where id = any(${tempProjectIds}::uuid[])`;
  }
  // 이미 테스트 안에서 지운 id가 섞여 있어도 무해하다
  if (tempStaffIds.length > 0) {
    await sql`delete from public.staff where id = any(${tempStaffIds}::uuid[])`;
  }
  await destroyTestUser(sql, user);
  await sql.end();
});

// ─── Staff CRUD ──────────────────────────────────────────────

describe('createStaff — ST-1 이메일 정규화·유일', () => {
  it('"A@X.com"으로 만든 뒤 " a@x.com "은 ConflictError, 저장된 email은 소문자 trim', async () => {
    const created = await newStaff({ email: `Dup-${RUN}@Unes.co.kr` });
    expect(created.email).toBe(`dup-${RUN}@unes.co.kr`);
    expect(created).toMatchObject({ version: 1, createdBy: user.id, employed: true });
    expect(created).not.toHaveProperty('sort_order');

    await expect(
      staff.createStaff(user.client, staffInput({ email: `  dup-${RUN}@unes.co.kr  ` }))
    ).rejects.toBeInstanceOf(ConflictError);
    await expect(
      staff.createStaff(user.client, staffInput({ email: `  dup-${RUN}@unes.co.kr  ` }))
    ).rejects.toThrow('같은 이메일의 조직원이 있습니다.');

    // 저장값 자체가 정규화되어 있다 — 앱이 lower(trim)을 DB에만 맡기지 않는다
    const stored = await sql<{ email: string }[]>`
      select email from public.staff where id = ${created.id}::uuid`;
    expect(stored[0]!.email).toBe(`dup-${RUN}@unes.co.kr`);
  });

  it('getStaffById — 없는 id는 NotFoundError', async () => {
    await expect(staff.getStaffById(user.client, randomUUID())).rejects.toBeInstanceOf(NotFoundError);
  });

  it('listStaff — 기본은 재직자만, includeRetired면 퇴사자 포함, 이름 순', async () => {
    const active = await newStaff({ name: `가-${RUN}` });
    const retired = await newStaff({ name: `나-${RUN}`, employed: false });

    const defaults = await staff.listStaff(user.client);
    expect(defaults.map((s) => s.id)).toContain(active.id);
    expect(defaults.map((s) => s.id)).not.toContain(retired.id);

    const all = await staff.listStaff(user.client, { includeRetired: true });
    const ids = all.map((s) => s.id);
    expect(ids).toContain(active.id);
    expect(ids).toContain(retired.id);
    expect(ids.indexOf(active.id)).toBeLessThan(ids.indexOf(retired.id));
    const names = all.map((s) => s.name);
    expect([...names].sort((a, b) => a.localeCompare(b, 'ko'))).toEqual(names);
  });
});

describe('updateStaff — O-1 낙관적 잠금', () => {
  it('version이 맞으면 갱신되고 version +1, email patch도 정규화된다', async () => {
    const created = await newStaff();
    const updated = await staff.updateStaff(
      user.client,
      created.id,
      { position: '선임', email: `  Upd-${RUN}@Unes.co.kr `, updatedBy: user.id },
      1
    );
    expect(updated).toMatchObject({ position: '선임', email: `upd-${RUN}@unes.co.kr`, version: 2 });
  });

  it('stale version → StaleDataError(updatedBy = 먼저 수정한 사용자)', async () => {
    const created = await newStaff();
    // "다른 사람"이 먼저 저장했다 — version 1 → 2
    await staff.updateStaff(user.client, created.id, { note: '먼저', updatedBy: user.id });

    const err = await staff
      .updateStaff(user.client, created.id, { note: '나중', updatedBy: user.id }, 1)
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(StaleDataError);
    expect((err as StaleDataError).updatedBy).toBe(user.id);
    expect((err as StaleDataError).code).toBe('STALE');

    // 입력값은 반영되지 않았다
    expect((await staff.getStaffById(user.client, created.id)).note).toBe('먼저');
  });

  it('없는 id는 NotFoundError, 빈 patch는 ValidationError', async () => {
    await expect(
      staff.updateStaff(user.client, randomUUID(), { note: 'x' }, 1)
    ).rejects.toBeInstanceOf(NotFoundError);
    await expect(staff.updateStaff(user.client, randomUUID(), {})).rejects.toThrow('갱신할 내용이 없습니다.');
  });
});

// ─── StaffSalary CRUD ────────────────────────────────────────

describe('createSalary / updateSalary / removeSalary — SL-3', () => {
  let staffId: string;

  beforeAll(async () => {
    staffId = (await newStaff()).id;
  });

  it('같은 (staffId, effectiveFrom) 두 건은 ConflictError', async () => {
    const first = await staff.createSalary(user.client, salaryInput(staffId));
    expect(first).toMatchObject({ staffId, effectiveFrom: '2026-01-01', amount: 40_000_000, version: 1 });
    expect(Number.isInteger(first.amount)).toBe(true);

    await expect(
      staff.createSalary(user.client, salaryInput(staffId, { amount: 1 }))
    ).rejects.toThrow('같은 적용일의 급여 이력이 있습니다.');
    await expect(
      staff.createSalary(user.client, salaryInput(staffId, { amount: 1 }))
    ).rejects.toBeInstanceOf(ConflictError);
  });

  it('amount -1 → RuleViolationError(한국어 문구), 0은 통과', async () => {
    const err = await staff
      .createSalary(user.client, salaryInput(staffId, { effectiveFrom: '2026-02-01', amount: -1 }))
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RuleViolationError);
    expect((err as Error).message).toBe('급여 금액은 0 이상의 원 단위 정수여야 합니다.');

    const zero = await staff.createSalary(
      user.client,
      salaryInput(staffId, { effectiveFrom: '2026-02-01', amount: 0 })
    );
    expect(zero.amount).toBe(0);
  });

  it('없는 조직원의 이력은 NotFoundError (FK)', async () => {
    await expect(
      staff.createSalary(user.client, salaryInput(randomUUID()))
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  it('listSalariesByStaff — effectiveFrom 내림차순', async () => {
    await staff.createSalary(
      user.client,
      salaryInput(staffId, { effectiveFrom: '2025-07-01', basis: 'monthly', amount: 3_000_000 })
    );
    const list = await staff.listSalariesByStaff(user.client, staffId);
    expect(list.map((s) => s.effectiveFrom)).toEqual(['2026-02-01', '2026-01-01', '2025-07-01']);
    expect(list.every((s) => s.staffId === staffId)).toBe(true);
  });

  it('updateSalary — O-1 잠금, 적용일 변경으로 중복되면 ConflictError', async () => {
    const list = await staff.listSalariesByStaff(user.client, staffId);
    const target = list.find((s) => s.effectiveFrom === '2025-07-01')!;

    const updated = await staff.updateSalary(
      user.client,
      target.id,
      { note: '2025 연봉계약', updatedBy: user.id },
      target.version
    );
    expect(updated).toMatchObject({ note: '2025 연봉계약', version: target.version + 1 });

    const stale = await staff
      .updateSalary(user.client, target.id, { note: 'x', updatedBy: user.id }, target.version)
      .catch((e: unknown) => e);
    expect(stale).toBeInstanceOf(StaleDataError);
    expect((stale as StaleDataError).updatedBy).toBe(user.id);

    await expect(
      staff.updateSalary(user.client, target.id, { effectiveFrom: '2026-01-01', updatedBy: user.id })
    ).rejects.toBeInstanceOf(ConflictError);
  });

  it('removeSalary — 지우면 목록에서 사라지고, 다시 지우면 NotFoundError', async () => {
    const list = await staff.listSalariesByStaff(user.client, staffId);
    const target = list.find((s) => s.effectiveFrom === '2026-02-01')!;
    await staff.removeSalary(user.client, target.id);
    expect((await staff.listSalariesByStaff(user.client, staffId)).map((s) => s.id)).not.toContain(target.id);
    await expect(staff.removeSalary(user.client, target.id)).rejects.toBeInstanceOf(NotFoundError);
  });

  it('listSalariesByStaffIds / listAllSalaries — 조직원별 묶음, 최신이 먼저', async () => {
    const other = await newStaff();
    await staff.createSalary(user.client, salaryInput(other.id, { effectiveFrom: '2024-01-01' }));

    const byIds = await staff.listSalariesByStaffIds(user.client, [staffId, other.id]);
    expect(byIds.filter((s) => s.staffId === staffId).map((s) => s.effectiveFrom)).toEqual(['2026-01-01', '2025-07-01']);
    expect(byIds.filter((s) => s.staffId === other.id)).toHaveLength(1);
    expect(byIds.every((s) => s.staffId === staffId || s.staffId === other.id)).toBe(true);
    expect(await staff.listSalariesByStaffIds(user.client, [])).toEqual([]);

    const all = await staff.listAllSalaries(user.client);
    expect(all.filter((s) => s.staffId === staffId)).toHaveLength(2);
    expect(all.filter((s) => s.staffId === other.id)).toHaveLength(1);
  });
});

// ─── ST-2 삭제 + 참조 건수 + 연결 Member 조회 ──────────────────

describe('removeStaff / countStaffReferences / listMembersByStaffIds — ST-2', () => {
  let staffId: string;
  let memberId: string;
  let projectId: string;

  beforeAll(async () => {
    staffId = (await newStaff()).id;
    await staff.createSalary(user.client, salaryInput(staffId, { effectiveFrom: '2025-01-01' }));
    await staff.createSalary(user.client, salaryInput(staffId, { effectiveFrom: '2026-01-01' }));
    projectId = await newProject(`staff-repo-st2-${RUN}`);
    const member = await members.createMember(
      user.client,
      memberInput(projectId, {
        annualSalary: 38_400_000,
        staffId,
        salaryIncludesRetirement: true,
        salaryIncludesInsurance: false,
        salaryAppliedFrom: '2026-01-01',
      }),
      user.id
    );
    memberId = member.id;
  });

  it('createMember — 스냅샷 키를 생략하면 null로 저장된다 (과도기 호환)', async () => {
    const plain = await members.createMember(user.client, memberInput(projectId, { name: '스냅샷 없음' }), user.id);
    expect(plain).toMatchObject({
      staffId: null,
      salaryIncludesRetirement: null,
      salaryIncludesInsurance: null,
      salaryAppliedFrom: null,
    });
  });

  it('countStaffReferences — members 1, salaries 2', async () => {
    expect(await staff.countStaffReferences(user.client, staffId)).toEqual({ members: 1, salaries: 2 });
    expect(await staff.countStaffReferences(user.client, randomUUID())).toEqual({ members: 0, salaries: 0 });
  });

  it('listMembersByStaffIds / listLinkedMembersAll — 과제 이름·archived가 함께 온다', async () => {
    const byIds = await members.listMembersByStaffIds(user.client, [staffId]);
    expect(byIds).toHaveLength(1);
    expect(byIds[0]).toMatchObject({
      id: memberId,
      staffId,
      projectName: `staff-repo-st2-${RUN}`,
      projectArchived: false,
    });
    expect(byIds[0]).not.toHaveProperty('projects');
    expect(await members.listMembersByStaffIds(user.client, [])).toEqual([]);

    const linked = await members.listLinkedMembersAll(user.client);
    expect(linked.every((m) => m.staffId !== null)).toBe(true);
    expect(linked.find((m) => m.id === memberId)).toMatchObject({ projectName: `staff-repo-st2-${RUN}` });
  });

  it('removeStaff → 이력 0, Member.staffId null, annualSalary·스냅샷 3필드 유지', async () => {
    await staff.removeStaff(user.client, staffId);
    tempStaffIds.splice(tempStaffIds.indexOf(staffId), 1);

    expect(await staff.listSalariesByStaff(user.client, staffId)).toEqual([]);
    await expect(staff.getStaffById(user.client, staffId)).rejects.toBeInstanceOf(NotFoundError);

    const after = await members.getMemberById(user.client, memberId);
    expect(after).toMatchObject({
      staffId: null,
      annualSalary: 38_400_000,
      salaryIncludesRetirement: true,
      salaryIncludesInsurance: false,
      salaryAppliedFrom: '2026-01-01',
    });
    expect(await members.listMembersByStaffIds(user.client, [staffId])).toEqual([]);
  });

  it('removeStaff — 없는 id는 NotFoundError', async () => {
    await expect(staff.removeStaff(user.client, staffId)).rejects.toBeInstanceOf(NotFoundError);
  });
});

// ─── applySalaryChange snapshot (PL-10b v4.7) ─────────────────

describe('applySalaryChange — snapshot이 있으면 3컬럼 세팅, 없으면 불변', () => {
  let memberId: string;

  beforeAll(async () => {
    const projectId = await newProject(`staff-repo-snapshot-${RUN}`);
    memberId = (await members.createMember(
      user.client,
      memberInput(projectId, { annualSalary: 30_000_000 }),
      user.id
    )).id;
  });

  it('without snapshot → 연봉만 바뀌고 스냅샷은 그대로 null', async () => {
    const result = await members.applySalaryChange(user.client, memberId, 31_000_000, []);
    expect(result).toMatchObject({ memberId, updated: 0, cells: 0 });
    expect(await members.getMemberById(user.client, memberId)).toMatchObject({
      annualSalary: 31_000_000,
      salaryIncludesRetirement: null,
      salaryIncludesInsurance: null,
      salaryAppliedFrom: null,
      version: 2,
    });
  });

  it('with snapshot → 연봉과 스냅샷 3컬럼이 함께 세팅된다 (객체 그대로 전달)', async () => {
    await members.applySalaryChange(user.client, memberId, 36_000_000, [], 2, {
      salaryIncludesRetirement: true,
      salaryIncludesInsurance: false,
      salaryAppliedFrom: '2026-01-01',
    });
    expect(await members.getMemberById(user.client, memberId)).toMatchObject({
      annualSalary: 36_000_000,
      salaryIncludesRetirement: true,
      salaryIncludesInsurance: false,
      salaryAppliedFrom: '2026-01-01',
      version: 3,
    });
  });

  it('without snapshot 다시 → 이전 스냅샷 유지; expectedVersion 불일치는 StaleDataError', async () => {
    await members.applySalaryChange(user.client, memberId, 37_000_000, []);
    expect(await members.getMemberById(user.client, memberId)).toMatchObject({
      annualSalary: 37_000_000,
      salaryIncludesRetirement: true,
      salaryAppliedFrom: '2026-01-01',
    });

    const stale = await members
      .applySalaryChange(user.client, memberId, 1, [], 1)
      .catch((e: unknown) => e);
    expect(stale).toBeInstanceOf(StaleDataError);
    expect((await members.getMemberById(user.client, memberId)).annualSalary).toBe(37_000_000);
  });

  it('세 값이 전부 null인 snapshot은 "기록 없음"으로 되돌린다', async () => {
    await members.applySalaryChange(user.client, memberId, 38_000_000, [], undefined, {
      salaryIncludesRetirement: null,
      salaryIncludesInsurance: null,
      salaryAppliedFrom: null,
    });
    expect(await members.getMemberById(user.client, memberId)).toMatchObject({
      annualSalary: 38_000_000,
      salaryIncludesRetirement: null,
      salaryIncludesInsurance: null,
      salaryAppliedFrom: null,
    });
  });
});

// ─── 1000행 페이징 (§12, PS-5) ────────────────────────────────

describe('1,000행 초과 벌크 조회 — listPersonnelDetailsAll / listAllYears', () => {
  let projectId: string;
  let stageId: string;
  let yearId: string;
  let memberId: string;

  beforeAll(async () => {
    projectId = await newProject(`staff-repo-paging-${RUN}`);
    const stage = await stages.createStage(user.client, { projectId, name: '1단계' });
    stageId = stage.id;
    yearId = (await years.createYear(user.client, { stageId, name: '1차년도', startDate: '2026-01-01' })).id;
    memberId = (await members.createMember(
      user.client,
      memberInput(projectId, { annualSalary: 40_000_000 }),
      user.id
    )).id;

    // 인건비 행 1,005건 + 같은 수량의 quantity 행 3건(필터가 formula를 실제로 거르는지 확인용)
    await sql`
      insert into public.budget_details
        (project_id, year_id, category, subcategory, axis, formula, member_id,
         factors, amount, sort_order, created_by, updated_by)
      select ${projectId}::uuid, ${yearId}::uuid, 'personnel', 'default', 'cash', 'personnel',
             ${memberId}::uuid,
             '[{"label":"참여율","value":10,"isPercent":true},{"label":"참여개월","value":12,"isPercent":false}]'::jsonb,
             4000000, i, ${user.id}::uuid, ${user.id}::uuid
      from generate_series(1, ${BULK_COUNT}) as i`;
    await sql`
      insert into public.budget_details
        (project_id, year_id, category, subcategory, axis, formula, member_id,
         name, unit_price, factors, amount, sort_order, created_by, updated_by)
      select ${projectId}::uuid, ${yearId}::uuid, 'material', 'default', 'cash', 'quantity', null,
             '재료 ' || i, 1000, '[{"label":"수량","value":1,"isPercent":false}]'::jsonb, 1000, i,
             ${user.id}::uuid, ${user.id}::uuid
      from generate_series(1, 3) as i`;

    // 연차 1,005건 — create_year RPC는 비목 12종을 함께 만들어 12,000행이 되므로 직결 SQL로 넣는다.
    // sort_order는 RPC가 만든 연차(0)와 겹치지 않게 1000부터
    await sql`
      insert into public.years (project_id, stage_id, sort_order, name, start_date, created_by, updated_by)
      select ${projectId}::uuid, ${stageId}::uuid, 1000 + i, '연차 ' || i,
             date '2026-01-01' + i, ${user.id}::uuid, ${user.id}::uuid
      from generate_series(1, ${BULK_COUNT}) as i`;
  });

  it('listPersonnelDetailsAll — 1,005건이 잘리지 않고 quantity 행은 섞이지 않는다', async () => {
    const all = await budgetDetails.listPersonnelDetailsAll(user.client);
    const mine = all.filter((d) => d.projectId === projectId);
    expect(mine).toHaveLength(BULK_COUNT);
    expect(new Set(mine.map((d) => d.id)).size).toBe(BULK_COUNT);
    expect(all.every((d) => d.formula === 'personnel')).toBe(true);
    expect(mine.every((d) => d.memberId === memberId && d.yearId === yearId)).toBe(true);
    // factors 내부 키(isPercent)는 매퍼가 건드리지 않는다
    expect(mine[0]!.factors[0]).toEqual({ label: '참여율', value: 10, isPercent: true });
  });

  it('listAllYears — 1,006건(직결 1,005 + RPC 1)이 잘리지 않고 과제 안에서 sort_order 순', async () => {
    const all = await years.listAllYears(user.client);
    const mine = all.filter((y) => y.projectId === projectId);
    expect(mine).toHaveLength(BULK_COUNT + 1);
    expect(new Set(mine.map((y) => y.id)).size).toBe(BULK_COUNT + 1);
    expect(mine[0]!.id).toBe(yearId);
    const orders = mine.map((y) => y.order);
    expect([...orders].sort((a, b) => a - b)).toEqual(orders);
    expect(mine[1]).toMatchObject({ startDate: '2026-01-02', stageId });
  });
});
