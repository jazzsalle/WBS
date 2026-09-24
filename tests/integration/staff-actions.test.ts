// Staff 서버 액션 통합 테스트 — Phase 16 T7
// (SOT §9 Staff, SA-1~SA-4, §5.19 ST-1~ST-3, §5.20 SL-2·SL-3·SL-5, §6.15 PS-1~PS-5, §7.18, §8.4 O-1~O-3)
//
// 서버 액션은 쿠키 세션(requireApprovedUser)에서 토큰을 읽으므로 next/headers를
// "실제 세션 토큰을 돌려주는 스텁"으로 바꿔 가드까지 포함해 그대로 호출한다
// (budget-rules-actions.test.ts와 같은 방식). revalidatePath는 요청 컨텍스트 밖이라 스텁한다.
//
// 검증의 핵심:
//  1. ST-1  — 같은 이메일 두 번 → CONFLICT.
//  2. PS-1~PS-4 — 두 과제 60%·12개월 + 50%·12개월 → 110 error. 미연결 행은 unlinkedRowCount로 센다.
//  3. SL-5  — 급여 이력을 쌓아도 연결 Member.annualSalary는 그대로다(자동 반영 없음).
//  4. SL-2  — 목록의 현재 급여는 오늘 기준 최신 이력(미래 이력 제외).
//  5. ST-3  — 명부 초안: 기존 이메일은 rejected, 여분 키는 VALIDATION.
//  6. ST-2  — 삭제 후 Member.staffId null, 연봉 유지.
//
// 조직원 연결(Member.staffId)은 리포지토리로 직접 세팅한다 — T6의 linkMemberToStaff에 기대지 않는다.
// 자기가 만든 조직원·과제·사용자만 지운다 — 파괴적 테스트가 아니다.

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Sql } from 'postgres';
import { connectDirectDb, createTestUser, destroyTestUser, type TestUser } from './helpers';
import type { ActionResult } from '@/types';
import * as projectsRepo from '@/lib/db/projects';
import * as stagesRepo from '@/lib/db/stages';
import * as yearsRepo from '@/lib/db/years';
import * as membersRepo from '@/lib/db/members';
import { todayISO } from '@/lib/dates';

const session = vi.hoisted(() => ({ accessToken: '' }));

vi.mock('next/headers', () => ({
  cookies: async () => ({ get: () => ({ value: session.accessToken }) }),
}));
vi.mock('next/cache', () => ({ revalidatePath: () => undefined }));

const actions = await import('@/actions/staff');

let sql: Sql;
let user: TestUser;
const tempProjectIds: string[] = []; // afterAll 안전망 — 이 테스트가 만든 것만 지운다
const tempStaffIds: string[] = [];

// 실행마다 다른 이메일 — 이전 실행 잔여물과 ST-1 충돌을 일으키지 않기 위해서다
const RUN = `${Date.now()}-${randomUUID().slice(0, 8)}`;
const TARGET_YEAR = 2026;

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

function email(tag: string): string {
  return `staff-act-${tag}-${RUN}@unes.co.kr`;
}

async function newStaff(tag: string, overrides: Record<string, unknown> = {}) {
  const created = unwrap(
    await actions.createStaff({ name: `조직원 ${tag}`, email: email(tag), position: '연구원', ...overrides })
  );
  tempStaffIds.push(created.id);
  return created;
}

// 과제 + 단계 + 연차(시작일 = 대상 연도 1월 1일). create_year RPC가 비목 12종을 함께 만든다
async function newProjectWithYear(name: string, startDate: string | null) {
  const project = await projectsRepo.createProject(user.client, {
    name,
    createdBy: user.id,
    updatedBy: user.id,
  });
  tempProjectIds.push(project.id);
  const stage = await stagesRepo.createStage(user.client, { projectId: project.id, name: '1단계' });
  const year = await yearsRepo.createYear(user.client, {
    stageId: stage.id,
    name: '1차년도',
    startDate,
  });
  return { projectId: project.id, yearId: year.id };
}

async function newMember(projectId: string, staffId: string | null, annualSalary: number | null) {
  return membersRepo.createMember(
    user.client,
    {
      projectId,
      orgId: null,
      name: `인력 ${RUN}`,
      role: 'researcher',
      position: '',
      field: '',
      email: '',
      phone: '',
      active: true,
      order: 0,
      annualSalary,
      hireType: 'existing',
      staffId,
    },
    user.id
  );
}

// 인건비 산출근거 — 참여율(%)·참여개월 인자 2개. 금액은 이 테스트의 관심사가 아니므로 0
async function seedPersonnelDetail(
  projectId: string,
  yearId: string,
  memberId: string,
  participation: number,
  months: number
): Promise<void> {
  // 문자열로 넘기면 postgres.js가 JSON 문자열로 한 번 더 감싼다 — 배열 그대로 sql.json에 준다
  const factors = sql.json([
    { label: '참여율(%)', value: participation, isPercent: true },
    { label: '참여개월', value: months, isPercent: false },
  ]);
  await sql`
    insert into public.budget_details
      (project_id, year_id, category, subcategory, axis, formula, member_id,
       factors, amount, sort_order, created_by, updated_by)
    values (${projectId}::uuid, ${yearId}::uuid, 'personnel', 'default', 'cash', 'personnel',
            ${memberId}::uuid, ${factors}, 0, 0, ${user.id}::uuid, ${user.id}::uuid)`;
}

beforeAll(async () => {
  sql = connectDirectDb();
  user = await createTestUser(sql);
  session.accessToken = user.accessToken;
});

afterAll(async () => {
  // 과제 삭제가 members·years·budget_details를 cascade로 함께 지운다 (H-5, PL-D8)
  if (tempProjectIds.length > 0) {
    await sql`delete from public.projects where id = any(${tempProjectIds}::uuid[])`;
  }
  // 이미 테스트 안에서 지운 id가 섞여 있어도 무해하다. 급여 이력은 cascade(ST-2)
  if (tempStaffIds.length > 0) {
    await sql`delete from public.staff where id = any(${tempStaffIds}::uuid[])`;
  }
  const remaining = await sql<{ n: string }[]>`
    select ((select count(*) from public.staff    where id = any(${tempStaffIds}::uuid[]))
          + (select count(*) from public.projects where id = any(${tempProjectIds}::uuid[])))::text as n`;
  if (Number(remaining[0]!.n) !== 0) {
    throw new Error(`테스트가 만든 데이터가 ${remaining[0]!.n}건 남았습니다.`);
  }
  await destroyTestUser(sql, user);
  await sql.end();
});

// ─── Staff CRUD (ST-1, O-1~O-3) ──────────────────────────────

describe('createStaff / updateStaff — ST-1 이메일 유일, O-1 잠금', () => {
  it('같은 이메일(대소문자·공백 다름)로 두 번 → CONFLICT', async () => {
    const first = await newStaff('dup', { email: `Dup-${RUN}@Unes.co.kr` });
    expect(first.email).toBe(`dup-${RUN}@unes.co.kr`);
    expect(first).toMatchObject({ employed: true, note: '', version: 1 });

    const dup = await actions.createStaff({ name: '중복', email: `  dup-${RUN}@unes.co.kr  ` });
    expect(expectCode(dup, 'CONFLICT')).toContain('같은 이메일의 조직원이 있습니다');
  });

  it('입력 검증 — 이름 없음·이메일 형식·여분 없는 patch는 VALIDATION', async () => {
    expectCode(await actions.createStaff({ name: '  ', email: email('v1') }), 'VALIDATION');
    expectCode(await actions.createStaff({ name: '이름', email: 'not-an-email' }), 'VALIDATION');
    expectCode(await actions.updateStaff(randomUUID(), {}), 'VALIDATION');
    expectCode(await actions.updateStaff('not-a-uuid', { note: 'x' }), 'VALIDATION');
  });

  it('updateStaff — version이 맞으면 갱신, 낡은 version은 STALE + 수정자 이름 (O-3)', async () => {
    const created = await newStaff('upd');
    const updated = unwrap(await actions.updateStaff(created.id, { position: '선임' }, created.version));
    expect(updated).toMatchObject({ position: '선임', version: created.version + 1 });

    const stale = await actions.updateStaff(created.id, { note: '늦음' }, created.version);
    expect(expectCode(stale, 'STALE')).toContain('먼저 수정했습니다');
  });
});

// ─── 참여율 합산 + SL-5 + 목록·상세 ──────────────────────────

describe('getStaffParticipation · listStaff · getStaffDetail — 두 과제에 연결된 조직원', () => {
  let staffId: string;
  let projectA: { projectId: string; yearId: string };
  let projectB: { projectId: string; yearId: string };
  let memberA: { id: string; version: number };
  let memberB: { id: string; version: number };

  beforeAll(async () => {
    staffId = (await newStaff('part')).id;
    projectA = await newProjectWithYear(`staff-act-A-${RUN}`, `${TARGET_YEAR}-01-01`);
    projectB = await newProjectWithYear(`staff-act-B-${RUN}`, `${TARGET_YEAR}-03-01`);
    // 과제 A는 조직원 현재 연봉과 같은 값, B는 다른 값 → differsFromCurrent 판정용
    memberA = await newMember(projectA.projectId, staffId, 36_000_000);
    memberB = await newMember(projectB.projectId, staffId, 38_400_000);
    await seedPersonnelDetail(projectA.projectId, projectA.yearId, memberA.id, 60, 12);
    await seedPersonnelDetail(projectB.projectId, projectB.yearId, memberB.id, 50, 12);
  });

  it('60%·12개월 + 50%·12개월 → total 110, tone error, 과제 열 2개 (PS-2~PS-4)', async () => {
    const result = unwrap(await actions.getStaffParticipation(TARGET_YEAR));
    expect(result.year).toBe(TARGET_YEAR);

    const row = result.rows.find((r) => r.staffId === staffId);
    expect(row).toBeDefined();
    expect(row!.total).toBe(110);
    expect(row!.tone).toBe('error');
    expect(row!.byProject).toEqual({ [projectA.projectId]: 60, [projectB.projectId]: 50 });

    const projectIds = result.projects.map((p) => p.id);
    expect(projectIds).toContain(projectA.projectId);
    expect(projectIds).toContain(projectB.projectId);

    // 다른 해에는 이 조직원의 행이 없다(PS-3 — 연차 시작 연도 기준)
    const other = unwrap(await actions.getStaffParticipation(TARGET_YEAR + 1));
    expect(other.rows.find((r) => r.staffId === staffId)?.total).toBe(0);
    expect(other.projects.map((p) => p.id)).not.toContain(projectA.projectId);
  });

  it('연결 안 된 Member의 인건비 행 → unlinkedRowCount +1 (PS-1), startDate 없는 연차 → undatedRowCount +1 (PS-3)', async () => {
    const before = unwrap(await actions.getStaffParticipation(TARGET_YEAR));

    const unlinked = await newMember(projectA.projectId, null, 30_000_000);
    await seedPersonnelDetail(projectA.projectId, projectA.yearId, unlinked.id, 30, 12);

    const undated = await newProjectWithYear(`staff-act-undated-${RUN}`, null);
    const undatedMember = await newMember(undated.projectId, staffId, null);
    await seedPersonnelDetail(undated.projectId, undated.yearId, undatedMember.id, 20, 12);

    const after = unwrap(await actions.getStaffParticipation(TARGET_YEAR));
    expect(after.unlinkedRowCount - before.unlinkedRowCount).toBe(1);
    expect(after.undatedRowCount - before.undatedRowCount).toBe(1);
    // 미연결·연도 미정 행은 합계에 들어가지 않는다
    expect(after.rows.find((r) => r.staffId === staffId)!.total).toBe(110);
  });

  it('연도 검증 — 정수가 아니거나 범위 밖이면 VALIDATION', async () => {
    expectCode(await actions.getStaffParticipation(2026.5), 'VALIDATION');
    expectCode(await actions.getStaffParticipation(99), 'VALIDATION');
  });

  it('addStaffSalary — 이력이 쌓여도 연결 Member.annualSalary는 그대로 (SL-5)', async () => {
    const past = unwrap(
      await actions.addStaffSalary(staffId, {
        effectiveFrom: '2025-01-01',
        basis: 'annual',
        amount: 40_000_000,
        includesRetirement: true,
        includesInsurance: false,
        note: '2025 연봉계약',
      })
    );
    expect(past).toMatchObject({ staffId, effectiveFrom: '2025-01-01', amount: 40_000_000, version: 1 });

    unwrap(
      await actions.addStaffSalary(staffId, {
        effectiveFrom: `${TARGET_YEAR}-01-01`,
        basis: 'monthly',
        amount: 3_000_000,
        includesRetirement: true,
      })
    );
    // 미래 이력 — 오늘 기준 SL-2에서 제외돼야 한다
    unwrap(
      await actions.addStaffSalary(staffId, { effectiveFrom: '2099-01-01', basis: 'annual', amount: 99_000_000 })
    );

    const a = await membersRepo.getMemberById(user.client, memberA.id);
    const b = await membersRepo.getMemberById(user.client, memberB.id);
    expect(a).toMatchObject({ annualSalary: 36_000_000, version: memberA.version, salaryAppliedFrom: null });
    expect(b).toMatchObject({ annualSalary: 38_400_000, version: memberB.version, salaryAppliedFrom: null });
  });

  it('addStaffSalary — 같은 적용일은 CONFLICT, 음수·소수 금액은 VALIDATION, 없는 조직원은 실패', async () => {
    const dup = await actions.addStaffSalary(staffId, {
      effectiveFrom: '2025-01-01',
      basis: 'annual',
      amount: 1,
    });
    expect(expectCode(dup, 'CONFLICT')).toContain('같은 적용일의 급여 이력이 있습니다');

    expectCode(
      await actions.addStaffSalary(staffId, { effectiveFrom: '2025-02-01', basis: 'annual', amount: -1 }),
      'VALIDATION'
    );
    expectCode(
      await actions.addStaffSalary(staffId, { effectiveFrom: '2025-02-01', basis: 'annual', amount: 1.5 }),
      'VALIDATION'
    );
    expectCode(
      await actions.addStaffSalary(staffId, { effectiveFrom: '2025/02/01', basis: 'annual', amount: 1 }),
      'VALIDATION'
    );

    const missing = await actions.addStaffSalary(randomUUID(), {
      effectiveFrom: '2025-02-01',
      basis: 'annual',
      amount: 1,
    });
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(missing.error).toContain('찾을 수 없습니다');
  });

  it('listStaff — currentSalary는 오늘 기준 최신 이력(SL-2), 연봉·월급 환산, 연결 과제 수 2', async () => {
    const today = todayISO(new Date());
    expect(today >= `${TARGET_YEAR}-01-01` && today < '2099-01-01').toBe(true); // 이 테스트의 전제

    const items = unwrap(await actions.listStaff());
    const item = items.find((i) => i.staff.id === staffId);
    expect(item).toBeDefined();
    expect(item!.currentSalary).toMatchObject({ effectiveFrom: `${TARGET_YEAR}-01-01`, basis: 'monthly' });
    expect(item!.annualSalary).toBe(36_000_000);
    expect(item!.monthlyDisplay).toBe(3_000_000);
    // 과제 A·B + 연도 미정 과제 = 3 (같은 과제에 인력이 둘이어도 과제는 하나)
    expect(item!.linkedProjectCount).toBe(3);

    // 이력이 없는 조직원은 null — 0으로 채우지 않는다
    const bare = await newStaff('bare');
    const bareItem = unwrap(await actions.listStaff()).find((i) => i.staff.id === bare.id);
    expect(bareItem).toMatchObject({ currentSalary: null, annualSalary: null, monthlyDisplay: null, linkedProjectCount: 0 });
  });

  it('listStaff — 기본은 재직자만, includeRetired면 퇴사자 포함', async () => {
    const retired = await newStaff('ret', { employed: false });
    expect(unwrap(await actions.listStaff()).some((i) => i.staff.id === retired.id)).toBe(false);
    expect(unwrap(await actions.listStaff(true)).some((i) => i.staff.id === retired.id)).toBe(true);
  });

  it('linkedProjectCount — 아카이브 과제는 세지 않는다', async () => {
    await projectsRepo.updateProject(user.client, projectB.projectId, { archived: true });
    const item = unwrap(await actions.listStaff()).find((i) => i.staff.id === staffId);
    expect(item!.linkedProjectCount).toBe(2);
    // 참여율도 아카이브 과제를 뺀다(PS-4)
    const part = unwrap(await actions.getStaffParticipation(TARGET_YEAR));
    expect(part.rows.find((r) => r.staffId === staffId)!.total).toBe(60);
    await projectsRepo.updateProject(user.client, projectB.projectId, { archived: false });
  });

  it('getStaffDetail — 이력 내림차순, 연결 Member에 과제명·differsFromCurrent', async () => {
    const detail = unwrap(await actions.getStaffDetail(staffId));
    expect(detail.staff.id).toBe(staffId);
    expect(detail.salaries.map((s) => s.effectiveFrom)).toEqual(['2099-01-01', `${TARGET_YEAR}-01-01`, '2025-01-01']);

    const a = detail.linkedMembers.find((m) => m.member.id === memberA.id);
    const b = detail.linkedMembers.find((m) => m.member.id === memberB.id);
    expect(a).toMatchObject({
      projectId: projectA.projectId,
      projectName: `staff-act-A-${RUN}`,
      projectArchived: false,
      differsFromCurrent: false,
    });
    expect(b).toMatchObject({ projectName: `staff-act-B-${RUN}`, differsFromCurrent: true });
    expect(a!.member).not.toHaveProperty('projectName');

    // 현재 급여가 없는 조직원은 differsFromCurrent가 항상 false
    const bare = await newStaff('bare-detail');
    const bareMember = await newMember(projectA.projectId, bare.id, 10_000_000);
    const bareDetail = unwrap(await actions.getStaffDetail(bare.id));
    expect(bareDetail.linkedMembers.find((m) => m.member.id === bareMember.id)!.differsFromCurrent).toBe(false);

    const missing = await actions.getStaffDetail(randomUUID());
    expect(missing.ok).toBe(false);
  });

  it('updateStaffSalary / deleteStaffSalary — O-1 잠금, 삭제 후 목록에서 사라진다', async () => {
    const detail = unwrap(await actions.getStaffDetail(staffId));
    const future = detail.salaries.find((s) => s.effectiveFrom === '2099-01-01')!;

    const updated = unwrap(await actions.updateStaffSalary(future.id, { note: '가정' }, future.version));
    expect(updated).toMatchObject({ note: '가정', version: future.version + 1 });
    expectCode(await actions.updateStaffSalary(future.id, { note: 'x' }, future.version), 'STALE');
    expectCode(await actions.updateStaffSalary(future.id, {}), 'VALIDATION');
    expectCode(
      await actions.updateStaffSalary(future.id, { effectiveFrom: '2025-01-01' }),
      'CONFLICT'
    );

    unwrap(await actions.deleteStaffSalary(future.id));
    const after = unwrap(await actions.getStaffDetail(staffId));
    expect(after.salaries.map((s) => s.id)).not.toContain(future.id);
    const again = await actions.deleteStaffSalary(future.id);
    expect(again.ok).toBe(false);
  });

  it('countStaffReferences → deleteStaff → Member.staffId null·연봉 유지 (ST-2)', async () => {
    const counts = unwrap(await actions.countStaffReferences(staffId));
    // Member: A·B·연도 미정 과제 = 3, 이력: 2025·2026 = 2 (2099는 위에서 지웠다)
    expect(counts).toEqual({ members: 3, salaries: 2 });
    expect((await actions.countStaffReferences(randomUUID())).ok).toBe(false);

    unwrap(await actions.deleteStaff(staffId));
    tempStaffIds.splice(tempStaffIds.indexOf(staffId), 1);

    const a = await membersRepo.getMemberById(user.client, memberA.id);
    expect(a).toMatchObject({ staffId: null, annualSalary: 36_000_000 });
    expect((await actions.getStaffDetail(staffId)).ok).toBe(false);
    expect((await actions.deleteStaff(staffId)).ok).toBe(false);

    // 연결이 끊긴 행은 이제 "연결 안 된 인건비 행"이다 — 조용히 사라지지 않는다(PS-1)
    const part = unwrap(await actions.getStaffParticipation(TARGET_YEAR));
    expect(part.rows.find((r) => r.staffId === staffId)).toBeUndefined();
  });
});

// ─── ST-3 사내 명부에서 추가 ──────────────────────────────────

describe('createStaffFromHr — 이름·직위·이메일만, 기존 이메일은 rejected', () => {
  it('기존 이메일 항목만 rejected, 나머지는 생성. retired는 employed 초기값', async () => {
    const existing = await newStaff('hr-exist');

    const result = unwrap(
      await actions.createStaffFromHr([
        { name: '기존', position: '책임', email: existing.email.toUpperCase() },
        { name: '신규 재직', position: '연구원', email: email('hr-new') },
        { name: '신규 퇴사', position: '연구원', email: email('hr-ret'), retired: true },
      ])
    );
    tempStaffIds.push(...result.created.map((s) => s.id));

    // 이메일은 Zod에서 trim·소문자로 정규화된다 — rejected도 비교에 쓴 값 그대로 돌려준다
    expect(result.rejected).toEqual([{ name: '기존', email: existing.email, reason: '이미 등록됨' }]);
    expect(result.created).toHaveLength(2);
    expect(result.created[0]).toMatchObject({ name: '신규 재직', email: email('hr-new'), employed: true, note: '' });
    expect(result.created[1]).toMatchObject({ name: '신규 퇴사', employed: false });
    // 순서는 기존 목록 뒤에 이어 붙는다
    expect(result.created[1]!.order).toBe(result.created[0]!.order + 1);
  });

  it('여분 키(부서 등)·빈 목록·요청 안 중복 → VALIDATION, 아무것도 만들지 않는다', async () => {
    const before = unwrap(await actions.listStaff(true)).length;
    expect(
      expectCode(
        await actions.createStaffFromHr([
          { name: 'x', position: 'y', email: email('extra'), user_division: '연구소' },
        ]),
        'VALIDATION'
      )
    ).toContain('이름·직위·이메일 외의 값은 받지 않습니다');
    expectCode(await actions.createStaffFromHr([]), 'VALIDATION');
    expectCode(
      await actions.createStaffFromHr([
        { name: 'a', position: '', email: email('twice') },
        { name: 'b', position: '', email: email('twice').toUpperCase() },
      ]),
      'VALIDATION'
    );
    expect(unwrap(await actions.listStaff(true)).length).toBe(before);
  });
});
