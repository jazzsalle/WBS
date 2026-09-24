'use server';

// Staff(조직원)·StaffSalary(급여 이력)·참여율 합산 서버 액션
// (SOT §9 Staff, SA-1~SA-4, §5.19 ST-1~ST-3, §5.20 SL-2·SL-3·SL-5, §6.15 PS-1~PS-5, §7.18, §8.4 O-1~O-3)
// 반환은 ActionResult<T> — 예외를 그대로 던지지 않는다. supabase 직접 호출 금지,
// 반드시 lib/db/ 리포지토리를 거친다 (§8.6).
//
// 이 파일은 Member를 **읽기만** 한다. 급여 이력을 쌓거나 고쳐도 과제 인건비는 움직이지 않는다(SL-5) —
// 반영은 과제 화면의 [급여 반영](actions/team.ts applyStaffSalary)뿐이다. 여기서 Member의 연봉을 쓰는
// 리포지토리 함수(PL-10b RPC 경로 포함)를 부르면 "급여를 고쳤더니 과제 예산이 바뀌었다"는 자동 반영
// 경로가 되므로 평가 항목(Phase 16 정적 검사)이 이를 실패로 본다.
//
// 조직원 삭제가 Member에 미치는 영향(staff_id set null, 연봉·스냅샷 유지)은 DB FK가 정한다(ST-2).

import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { ActionResult, Member, Staff, StaffSalary } from '@/types';
import { requireApprovedUser } from '@/lib/auth/guard';
import { todayISO } from '@/lib/dates';
import { normalizeHrEmail } from '@/lib/hr';
import { computeStaffParticipation, type StaffParticipation } from '@/lib/participation';
import { monthlyDisplay, pickSalaryAsOf, toAnnualSalary } from '@/lib/salary';
import * as appUsers from '@/lib/db/app-users';
import * as budgetDetailsRepo from '@/lib/db/budget-details';
import * as membersRepo from '@/lib/db/members';
import * as projectsRepo from '@/lib/db/projects';
import * as staffRepo from '@/lib/db/staff';
import * as yearsRepo from '@/lib/db/years';
import { StaleDataError, ValidationError, toActionFailure } from '@/lib/db/errors';
import { salaryBasisSchema } from '@/lib/db/schema';

export type { StaffReferenceCounts } from '@/lib/db/staff';
export type { StaffParticipation, StaffParticipationRow, ParticipationTone } from '@/lib/participation';

// ─── 조회 모델 (§7.18) ────────────────────────────────────────────────────────

// 목록 한 행. 현재 급여는 오늘(§6.5 Asia/Seoul) 기준 SL-2 — 화면이 오늘을 스스로 만들지 않도록 서버가 고른다
export interface StaffListItem {
  staff: Staff;
  currentSalary: StaffSalary | null;
  /** SL-1 연봉 환산. 이력이 없으면 null — 0으로 채우지 않는다 */
  annualSalary: number | null;
  /** 표시용 월급(반올림). 산식에 넣지 않는다(PL-2) */
  monthlyDisplay: number | null;
  /** 연결된 과제 수 — 과제 id 중복 제거, 아카이브 제외 */
  linkedProjectCount: number;
}

export interface StaffLinkedMember {
  member: Member;
  projectId: string;
  projectName: string;
  projectArchived: boolean;
  /** 조직원의 현재 연봉(오늘 기준 SL-2 → SL-1)과 Member.annualSalary가 다르다. 현재 급여가 없으면 false */
  differsFromCurrent: boolean;
}

export interface StaffDetail {
  staff: Staff;
  /** effectiveFrom 내림차순 — 최신이 먼저 */
  salaries: StaffSalary[];
  linkedMembers: StaffLinkedMember[];
}

// createMembersFromHr(HrImportResult)와 같은 모양. rejected는 모달을 연 뒤 다른 사용자가 같은 이메일을
// 먼저 등록한 경우다(HR-8) — 조용히 빼지 않는다
export interface StaffHrImportResult {
  created: Staff[];
  rejected: { name: string; email: string; reason: string }[];
}

// ─── 입력 검증 ────────────────────────────────────────────────────────────────

const uuidSchema = z.uuid();

const nameSchema = z
  .string()
  .trim()
  .min(1, '이름을 입력하세요.')
  .max(200, '이름은 200자 이내여야 합니다.');

// ST-1: 이메일은 사내 명부·과제 Member와 잇는 키라 빈 값을 허용하지 않는다(Member의 emailSchema와 다르다).
// 정규화(trim·소문자)는 리포지토리도 하지만, 중복 판정을 액션에서 먼저 하려면 여기서도 같은 규칙이어야 한다
const emailSchema = z
  .string()
  .trim()
  .toLowerCase()
  .pipe(z.email('이메일 형식이 올바르지 않습니다.'));

const positionSchema = z.string().trim().max(100, '직위는 100자 이내여야 합니다.');
const noteSchema = z.string().max(10_000, '메모는 10,000자 이내여야 합니다.');

const staffFieldsSchema = z.object({
  name: nameSchema,
  email: emailSchema,
  position: positionSchema.default(''),
  employed: z.boolean().default(true),
  note: noteSchema.default(''),
});

const staffPatchSchema = z
  .object({
    name: nameSchema,
    email: emailSchema,
    position: positionSchema,
    employed: z.boolean(),
    note: noteSchema,
  })
  .partial();

// ST-3·HR-4: 이름·직위·이메일만. `retired`는 HR `user_is_active`의 초기값 반영용(HR-7 — 이후 동기화 없음)으로
// 선택 필드다. 여분 키(user_division 등)는 거부한다 — 부서·본부를 저장하지 않는다(ST-4)
const hrStaffDraftSchema = z
  .object(
    {
      name: nameSchema,
      position: positionSchema,
      email: emailSchema,
      retired: z.boolean().optional(),
    },
    { error: '이름·직위·이메일 외의 값은 받지 않습니다.' }
  )
  .strict();
const hrStaffDraftListSchema = z
  .array(hrStaffDraftSchema)
  .min(1, '추가할 조직원을 한 명 이상 고르세요.');

const dateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "날짜는 'YYYY-MM-DD' 형식이어야 합니다.");

// 금액은 원 단위 정수다 (절대 규칙 4). DB check(amount ≥ 0)와 같은 조건을 먼저 건다 —
// 23514로 되돌아오면 RULE로 보이는데 이것은 입력 문제라 VALIDATION이어야 화면이 입력 칸에 붙인다
const amountSchema = z
  .number()
  .int('급여 금액은 원 단위 정수로 입력하세요.')
  .min(0, '급여 금액은 0 이상이어야 합니다.');

const salaryFieldsSchema = z.object({
  effectiveFrom: dateSchema,
  basis: salaryBasisSchema,
  amount: amountSchema,
  includesRetirement: z.boolean().default(false),
  includesInsurance: z.boolean().default(false),
  note: noteSchema.default(''),
});

const salaryPatchSchema = z
  .object({
    effectiveFrom: dateSchema,
    basis: salaryBasisSchema,
    amount: amountSchema,
    includesRetirement: z.boolean(),
    includesInsurance: z.boolean(),
    note: noteSchema,
  })
  .partial();

// 달력 연도. 연차 startDate의 앞 네 자리와 비교하므로(PS-3) 네 자리 정수만 뜻이 있다
const calendarYearSchema = z
  .number()
  .int('연도는 정수여야 합니다.')
  .min(1000, '연도가 올바르지 않습니다.')
  .max(9999, '연도가 올바르지 않습니다.');

const expectedVersionSchema = z.number().int().positive().optional();

function parseOrThrow<T>(schema: z.ZodType<T>, value: unknown, fallback: string): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    throw new ValidationError(parsed.error.issues[0]?.message ?? fallback);
  }
  return parsed.data;
}

// O-3: 낙관적 잠금 실패는 "누가 먼저 고쳤는지"까지 알려야 사용자가 판단할 수 있다
// (actions/budget-rules.ts와 같은 방식). 이름 조회 실패도 삼키지 않고 로그를 남긴 뒤 기본 메시지로 폴백한다.
async function toFailure(e: unknown, client?: SupabaseClient): Promise<ActionResult<never>> {
  if (e instanceof StaleDataError && e.updatedBy !== null && client) {
    try {
      const editor = await appUsers.getAppUserById(client, e.updatedBy);
      const label = editor.name.trim() || editor.email;
      return {
        ok: false,
        error: `${label}님이 먼저 수정했습니다. 최신 내용을 확인하세요.`,
        code: 'STALE',
      };
    } catch (lookupError) {
      console.error('[actions/staff] 수정자 이름 조회 실패:', lookupError);
    }
  }
  return toActionFailure(e);
}

// 조직원 데이터는 /staff에만 나온다. 과제 화면의 연결 표시(§7.10)는 Member.staffId를 읽으므로
// 조직원 삭제(set null)로도 바뀌지만, 그 경로는 과제 페이지가 자기 요청에서 다시 읽는다
function revalidateStaff(): void {
  revalidatePath('/staff');
}

function nextOrder(rows: readonly { order: number }[]): number {
  return rows.reduce((max, row) => Math.max(max, row.order + 1), 0);
}

// 오늘 기준(§6.5) 현재 급여 → 연봉 환산. 이력이 없으면 셋 다 null — 빈 값으로 채우지 않는다(SL-2)
function currentSalaryOf(
  salaries: readonly StaffSalary[],
  asOfDate: string
): Pick<StaffListItem, 'currentSalary' | 'annualSalary' | 'monthlyDisplay'> {
  const currentSalary = pickSalaryAsOf(salaries, asOfDate);
  if (currentSalary === null) return { currentSalary: null, annualSalary: null, monthlyDisplay: null };
  const annualSalary = toAnnualSalary(currentSalary);
  return { currentSalary, annualSalary, monthlyDisplay: monthlyDisplay(annualSalary) };
}

// MemberWithProject는 Member에 과제 열 2개를 얹은 평면 객체다. 화면 모델은 Member를 따로 떼어
// 과제 열이 Member 필드처럼 보이지 않게 한다
function splitLinkedMember(
  row: membersRepo.MemberWithProject,
  currentAnnual: number | null
): StaffLinkedMember {
  const { projectName, projectArchived, ...member } = row;
  return {
    member,
    projectId: member.projectId,
    projectName,
    projectArchived,
    differsFromCurrent: currentAnnual !== null && member.annualSalary !== currentAnnual,
  };
}

// ─── 조회 ────────────────────────────────────────────────────────────────────

/**
 * 목록(§7.18): 현재 급여(오늘 기준 SL-2)·연결 과제 수. 이력·연결 Member는 조직원 수와 무관하게
 * 벌크 조회 두 번으로 채운다 — 행마다 왕복하지 않는다 (§12).
 */
export async function listStaff(includeRetired = false): Promise<ActionResult<StaffListItem[]>> {
  try {
    const { client } = await requireApprovedUser();
    const staffList = await staffRepo.listStaff(client, { includeRetired });
    const ids = staffList.map((s) => s.id);
    const [salaries, linked] = await Promise.all([
      staffRepo.listSalariesByStaffIds(client, ids),
      membersRepo.listMembersByStaffIds(client, ids),
    ]);

    const salariesByStaff = new Map<string, StaffSalary[]>();
    for (const salary of salaries) {
      const bucket = salariesByStaff.get(salary.staffId);
      if (bucket) bucket.push(salary);
      else salariesByStaff.set(salary.staffId, [salary]);
    }
    // 같은 과제에 Member가 둘(예: 재등록)이어도 과제는 하나다. 아카이브 과제는 세지 않는다
    const projectsByStaff = new Map<string, Set<string>>();
    for (const row of linked) {
      if (row.projectArchived || row.staffId === null) continue;
      const bucket = projectsByStaff.get(row.staffId);
      if (bucket) bucket.add(row.projectId);
      else projectsByStaff.set(row.staffId, new Set([row.projectId]));
    }

    const today = todayISO(new Date());
    const items = staffList.map<StaffListItem>((staff) => ({
      staff,
      ...currentSalaryOf(salariesByStaff.get(staff.id) ?? [], today),
      linkedProjectCount: projectsByStaff.get(staff.id)?.size ?? 0,
    }));
    return { ok: true, data: items };
  } catch (e) {
    return toFailure(e);
  }
}

/**
 * 상세 패널(§7.18): 급여 이력 전부 + 연결 Member(과제명·스냅샷). `differsFromCurrent`는 표시만이다 —
 * 반영 버튼은 과제 화면에 있다(SL-5).
 */
export async function getStaffDetail(staffId: string): Promise<ActionResult<StaffDetail>> {
  try {
    const id = parseOrThrow(uuidSchema, staffId, '조직원 ID 형식이 올바르지 않습니다.');
    const { client } = await requireApprovedUser();
    const [staff, salaries, linked] = await Promise.all([
      staffRepo.getStaffById(client, id),
      staffRepo.listSalariesByStaff(client, id),
      membersRepo.listMembersByStaffIds(client, [id]),
    ]);
    const { annualSalary } = currentSalaryOf(salaries, todayISO(new Date()));
    return {
      ok: true,
      data: {
        staff,
        salaries,
        linkedMembers: linked.map((row) => splitLinkedMember(row, annualSalary)),
      },
    };
  } catch (e) {
    return toFailure(e);
  }
}

/** 삭제 확인 대화상자용(ST-2·§7.18 2단계 확인) — 무엇이 몇 건 영향을 받는지 미리 보여준다 */
export async function countStaffReferences(
  staffId: string
): Promise<ActionResult<staffRepo.StaffReferenceCounts>> {
  try {
    const id = parseOrThrow(uuidSchema, staffId, '조직원 ID 형식이 올바르지 않습니다.');
    const { client } = await requireApprovedUser();
    await staffRepo.getStaffById(client, id); // 없는 조직원의 참조를 0건으로 답하지 않는다
    return { ok: true, data: await staffRepo.countStaffReferences(client, id) };
  } catch (e) {
    return toFailure(e);
  }
}

/**
 * 참여율 매트릭스(§6.15 PS-1~PS-5). 벌크 5조회 → 순수 함수. 결과를 저장하지 않는다.
 * `staff`에는 퇴사자를 포함해 전원을 넘긴다 — 목록에 없는 staffId는 계산 함수가 "연결 안 됨"으로 세어
 * 버리므로, 퇴사자를 빼면 과거 과제의 계상률이 조용히 사라진다.
 */
export async function getStaffParticipation(year: number): Promise<ActionResult<StaffParticipation>> {
  try {
    const target = parseOrThrow(calendarYearSchema, year, '연도가 올바르지 않습니다.');
    const { client } = await requireApprovedUser();
    const [details, members, years, staff, projects] = await Promise.all([
      budgetDetailsRepo.listPersonnelDetailsAll(client),
      membersRepo.listLinkedMembersAll(client),
      yearsRepo.listAllYears(client),
      staffRepo.listStaff(client, { includeRetired: true }),
      projectsRepo.listProjects(client), // 아카이브 포함 — 제외(PS-4)는 계산 함수가 archived로 가른다
    ]);
    // 계산 함수는 FK가 가리키는 과제·연차가 입력에 없으면 throw한다 — 벌크 조회 누락 신호이며 실패로 올린다
    const result = computeStaffParticipation({ details, members, years, projects, staff }, target);
    return { ok: true, data: result };
  } catch (e) {
    return toFailure(e);
  }
}

// ─── Staff 쓰기 ──────────────────────────────────────────────────────────────

export async function createStaff(input: unknown): Promise<ActionResult<Staff>> {
  try {
    const fields = parseOrThrow(staffFieldsSchema, input, '조직원 정보가 올바르지 않습니다.');
    const { user, client } = await requireApprovedUser();
    // 퇴사자까지 포함해야 순서가 겹치지 않는다
    const existing = await staffRepo.listStaff(client, { includeRetired: true });
    const created = await staffRepo.createStaff(client, {
      ...fields,
      order: nextOrder(existing),
      createdBy: user.id,
      updatedBy: user.id,
    });
    revalidateStaff();
    return { ok: true, data: created };
  } catch (e) {
    return toFailure(e);
  }
}

/** O-1: 폼에서 여러 필드를 한 번에 바꾸므로 expectedVersion을 받는다. 생략하면 O-2(마지막 저장 우선) */
export async function updateStaff(
  staffId: string,
  patch: unknown,
  expectedVersion?: number
): Promise<ActionResult<Staff>> {
  let client: SupabaseClient | undefined;
  try {
    const id = parseOrThrow(uuidSchema, staffId, '조직원 ID 형식이 올바르지 않습니다.');
    const fields = parseOrThrow(staffPatchSchema, patch, '조직원 정보가 올바르지 않습니다.');
    const version = parseOrThrow(expectedVersionSchema, expectedVersion, 'version이 올바르지 않습니다.');
    // updatedBy를 덧붙이기 전에 본다 — 그 뒤에는 리포지토리가 빈 patch를 알아볼 수 없다
    if (Object.values(fields).every((v) => v === undefined)) {
      throw new ValidationError('갱신할 내용이 없습니다.');
    }
    const ctx = await requireApprovedUser();
    client = ctx.client;
    const updated = await staffRepo.updateStaff(client, id, { ...fields, updatedBy: ctx.user.id }, version);
    revalidateStaff();
    return { ok: true, data: updated };
  } catch (e) {
    return toFailure(e, client);
  }
}

/**
 * ST-2: 급여 이력은 cascade, 연결 Member의 staffId는 set null — Member의 연봉·스냅샷은 남는다.
 * 영향 건수는 화면이 countStaffReferences로 먼저 보여 준다(2단계 확인).
 */
export async function deleteStaff(staffId: string): Promise<ActionResult<null>> {
  try {
    const id = parseOrThrow(uuidSchema, staffId, '조직원 ID 형식이 올바르지 않습니다.');
    const { client } = await requireApprovedUser();
    await staffRepo.removeStaff(client, id);
    revalidateStaff();
    return { ok: true, data: null };
  } catch (e) {
    return toFailure(e);
  }
}

/**
 * ST-3: 사내 명부에서 고른 사람들을 이름·직위·이메일만 채운 조직원으로 만든다(HR-4).
 * 명부 자체는 fetchHrDirectoryForStaff가 이미 받았으므로 키를 받지 않는다(HR-13, 결정 ②).
 * 같은 이메일이 이미 있으면 그 항목만 rejected로 돌리고 나머지는 만든다(HR-8) —
 * 모달을 연 뒤 다른 사용자가 먼저 등록한 경우다. `employed`는 HR 재직 여부의 초기값이다(HR-7).
 */
export async function createStaffFromHr(drafts: unknown): Promise<ActionResult<StaffHrImportResult>> {
  let createdCount = 0;
  try {
    const list = parseOrThrow(hrStaffDraftListSchema, drafts, '조직원 정보가 올바르지 않습니다.');

    // 요청 안의 중복은 화면 버그다 — 한 명만 만들고 넘어가면 어느 쪽이 남았는지 알 수 없다
    const seen = new Set<string>();
    for (const draft of list) {
      const email = normalizeHrEmail(draft.email);
      if (seen.has(email)) {
        throw new ValidationError(`같은 이메일이 두 번 들어 있습니다: ${email}`);
      }
      seen.add(email);
    }

    const { user, client } = await requireApprovedUser();
    // 퇴사자도 이메일을 점유한다(ST-1) — 재직자만 보면 23505로 되돌아온다
    const existing = await staffRepo.listStaff(client, { includeRetired: true });
    const registered = new Set(existing.map((s) => normalizeHrEmail(s.email)));
    const baseOrder = nextOrder(existing);

    const created: Staff[] = [];
    const rejected: StaffHrImportResult['rejected'] = [];

    for (const draft of list) {
      if (registered.has(normalizeHrEmail(draft.email))) {
        rejected.push({ name: draft.name, email: draft.email, reason: '이미 등록됨' });
        continue;
      }
      const staff = await staffRepo.createStaff(client, {
        name: draft.name,
        email: draft.email,
        position: draft.position,
        employed: draft.retired !== true,
        note: '',
        order: baseOrder + created.length,
        createdBy: user.id,
        updatedBy: user.id,
      });
      created.push(staff);
      createdCount = created.length;
    }

    if (created.length > 0) revalidateStaff();
    return { ok: true, data: { created, rejected } };
  } catch (e) {
    const failure = await toFailure(e);
    if (failure.ok || createdCount === 0) return failure;
    // 순차 생성이라 중간 실패는 일부만 남긴다. 다시 누르면 그 사람들은 '이미 등록됨'으로 걸러지지만,
    // 몇 명이 들어갔는지는 지금 알려야 한다 — 조용히 넘기지 않는다
    revalidateStaff();
    return {
      ...failure,
      error: `${failure.error} (${createdCount}명은 이미 생성됐습니다. 다시 열면 그 조직원은 '이미 등록됨'으로 표시됩니다.)`,
    };
  }
}

// ─── StaffSalary 쓰기 (SL-3·SL-5) ────────────────────────────────────────────

/** SL-3: 이력을 쌓는다. 같은 적용일이 있으면 CONFLICT — 고치려면 updateStaffSalary로 그 행을 편집한다 */
export async function addStaffSalary(staffId: string, input: unknown): Promise<ActionResult<StaffSalary>> {
  try {
    const id = parseOrThrow(uuidSchema, staffId, '조직원 ID 형식이 올바르지 않습니다.');
    const fields = parseOrThrow(salaryFieldsSchema, input, '급여 이력 정보가 올바르지 않습니다.');
    const { user, client } = await requireApprovedUser();
    const created = await staffRepo.createSalary(client, {
      staffId: id,
      ...fields,
      createdBy: user.id,
      updatedBy: user.id,
    });
    revalidateStaff();
    return { ok: true, data: created };
  } catch (e) {
    return toFailure(e);
  }
}

/** O-1: 이력 편집 폼은 여러 필드를 한 번에 바꾸므로 expectedVersion을 받는다 */
export async function updateStaffSalary(
  salaryId: string,
  patch: unknown,
  expectedVersion?: number
): Promise<ActionResult<StaffSalary>> {
  let client: SupabaseClient | undefined;
  try {
    const id = parseOrThrow(uuidSchema, salaryId, '급여 이력 ID 형식이 올바르지 않습니다.');
    const fields = parseOrThrow(salaryPatchSchema, patch, '급여 이력 정보가 올바르지 않습니다.');
    const version = parseOrThrow(expectedVersionSchema, expectedVersion, 'version이 올바르지 않습니다.');
    if (Object.values(fields).every((v) => v === undefined)) {
      throw new ValidationError('갱신할 내용이 없습니다.');
    }
    const ctx = await requireApprovedUser();
    client = ctx.client;
    const updated = await staffRepo.updateSalary(client, id, { ...fields, updatedBy: ctx.user.id }, version);
    revalidateStaff();
    return { ok: true, data: updated };
  } catch (e) {
    return toFailure(e, client);
  }
}

/** 물리 삭제. 과거 과제가 이 이력을 스냅샷으로 가지고 있어도 무관하다(SL-3) — 스냅샷은 복사본이다 */
export async function deleteStaffSalary(salaryId: string): Promise<ActionResult<null>> {
  try {
    const id = parseOrThrow(uuidSchema, salaryId, '급여 이력 ID 형식이 올바르지 않습니다.');
    const { client } = await requireApprovedUser();
    await staffRepo.removeSalary(client, id);
    revalidateStaff();
    return { ok: true, data: null };
  } catch (e) {
    return toFailure(e);
  }
}
