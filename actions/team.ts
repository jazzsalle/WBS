'use server';

// Organization / Member 서버 액션 + 팀 화면 조회 (SOT §9 Organization/Member 목록,
// SA-1~SA-4, §5.10, §5.11, §6.6 H-8·H-9·H-10, §7.10, §8.4)
// 반환은 ActionResult<T> — 예외를 그대로 던지지 않는다. supabase 직접 호출 금지,
// 반드시 lib/db/ 리포지토리를 거친다 (§8.6).
//
// H-8("과제당 주관기관은 항상 정확히 1개")의 판정과 차단은 이 계층의 몫이다:
//  - 주관기관 삭제는 막는다.
//  - role='lead'로 만드는 모든 쓰기(생성 포함)는 set_lead_organization RPC를 거친다 —
//    직접 insert/update하면 lead 2개, 강등만 하면 lead 0개인 중간 상태가 남아 삭제 차단이 무너진다.

import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import type { SupabaseClient } from '@supabase/supabase-js';
import type {
  ActionResult,
  BudgetCategory,
  BudgetDetail,
  Member,
  Organization,
  Project,
  Task,
} from '@/types';
import { requireApprovedUser } from '@/lib/auth/guard';
import { computeDetailAmount, type DetailAmountResult } from '@/lib/budget-plan';
import * as appUsers from '@/lib/db/app-users';
import * as organizationsRepo from '@/lib/db/organizations';
import * as membersRepo from '@/lib/db/members';
import * as projectsRepo from '@/lib/db/projects';
import * as tasksRepo from '@/lib/db/tasks';
import * as yearsRepo from '@/lib/db/years';
import { RuleViolationError, StaleDataError, ValidationError, toActionFailure } from '@/lib/db/errors';
import { hireTypeSchema, memberRoleSchema, orgRoleSchema } from '@/lib/db/schema';

export type { MemberReferenceCounts } from '@/lib/db/members';

// ─── 조회 모델 (§7.10) ────────────────────────────────────────────────────────

// WBS·간트 등에서 담당자·기관 이름을 표시하기 위한 경량 조회 결과
export interface Team {
  organizations: Organization[];
  members: Member[];
}

// §7.10 "인력 행 클릭 → 배정된 작업 목록" 사이드 패널용. 책임자(owner)와 참여자를
// 한 목록으로 합치고 구분은 isOwner로 준다 — 화면이 다시 조인하지 않도록 서버에서 집계한다.
export interface AssignedTask {
  id: string;
  title: string;
  yearId: string;
  status: Task['status'];
  isOwner: boolean;
}

export interface TeamScreenData {
  project: Project;
  organizations: Organization[];
  members: Member[];
  /** 키는 memberId. 배정이 없는 인력도 빈 배열로 담는다 */
  assignedTasksByMember: Record<string, AssignedTask[]>;
}

// PM 지정 결과. previousPmMemberId가 있으면 UI가 "기존 PM은 역할이 그대로입니다" 경고를
// 띄운다 — §7.10은 자동 강등을 금지하고 경고만 요구한다.
export interface ProjectPMResult {
  project: Project;
  previousPmMemberId: string | null;
}

// PL-10b 확인 대화상자용 — (연차 × 비목) 단위의 전후 금액. 연차 이름을 여기서 붙여
// 화면이 연차를 다시 조회하지 않게 한다.
export interface SalaryImpactCell {
  yearId: string;
  /** 목록에 없는 연차도 감추지 않는다 (절대 규칙 5) */
  yearName: string;
  category: BudgetCategory;
  rowCount: number;
  beforeAmount: number;
  afterAmount: number;
}

// PL-10b: 저장하지 않는다. "이 연봉을 쓰는 산출근거 N건의 금액이 함께 바뀝니다"를 만들 재료다.
export interface SalaryChangePreview {
  memberId: string;
  memberName: string;
  currentAnnualSalary: number | null;
  nextAnnualSalary: number | null;
  /** 0이면 확인 없이 저장한다 (§7.10) */
  detailCount: number;
  beforeTotal: number;
  afterTotal: number;
  /** afterTotal − beforeTotal. 예산이 얼마나 흔들리는지가 확인의 핵심이다 */
  delta: number;
  /** 연봉을 지우면 인건비 행 금액이 0이 된다 — 조용히 넘기지 않고 경고로 드러낸다 */
  missingSalaryCount: number;
  cells: SalaryImpactCell[];
}

// ─── 입력 검증 ────────────────────────────────────────────────────────────────

const uuidSchema = z.uuid();
const uuidListSchema = z.array(z.uuid()).min(1, '정렬할 항목이 없습니다.');

// 금액은 원 단위 정수 — 부동소수점 금액을 애초에 받지 않는다 (절대 규칙 4)
const amountSchema = z.number().int('금액은 원 단위 정수로 입력하세요.');

const nameSchema = z
  .string()
  .trim()
  .min(1, '이름을 입력하세요.')
  .max(200, '이름은 200자 이내여야 합니다.');

// 빈 문자열은 '미입력'이다(§5.11 email은 not null default ''). 값이 있을 때만 형식을 본다.
const emailSchema = z.union([z.literal(''), z.email('이메일 형식이 올바르지 않습니다.')]);

// order는 여기 없다 — 재정렬은 reorderOrganizations/reorderMembers 전용이다 (H-10, X-3)
const organizationFieldsSchema = z.object({
  name: nameSchema,
  role: orgRoleSchema,
  type: z.string().trim().max(50),
  representative: z.string().trim().max(100),
  // §5.10 contact는 "연락처 or 이메일" 자유 입력이라 형식을 강제하지 않는다
  contact: z.string().trim().max(200),
  responsibility: z.string().max(10_000),
  budget: amountSchema.nullable(),
});

// role은 DB에 기본값이 없다(not null + check) — 생성 시 반드시 받는다
const organizationCreateSchema = organizationFieldsSchema.partial().extend({
  name: organizationFieldsSchema.shape.name,
  role: organizationFieldsSchema.shape.role,
});

const organizationPatchSchema = organizationFieldsSchema.partial();

// §5.11 연봉은 실지급액이라 음수가 없다. 미입력은 null이다 — 0원과 구분한다
// (0원은 "연봉이 0"이고 null은 "아직 모른다"다. PL-1이 두 경우를 다르게 다룬다).
const annualSalarySchema = amountSchema.min(0, '연봉은 0원 이상이어야 합니다.').nullable();

const memberFieldsSchema = z.object({
  orgId: z.uuid().nullable(),
  name: nameSchema,
  role: memberRoleSchema,
  position: z.string().trim().max(100),
  field: z.string().trim().max(100),
  email: emailSchema,
  phone: z.string().trim().max(50),
  active: z.boolean(),
  // Phase 9 (§5.11). 참여율(%)은 여기 없다 — (연차 × 인력)의 속성이라 BudgetDetail이 갖는다
  annualSalary: annualSalarySchema,
  hireType: hireTypeSchema,
});

const memberCreateSchema = memberFieldsSchema.partial().extend({
  name: memberFieldsSchema.shape.name,
});

const memberPatchSchema = memberFieldsSchema.partial();

function parseOrThrow<T>(schema: z.ZodType<T>, value: unknown, fallback: string): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    throw new ValidationError(parsed.error.issues[0]?.message ?? fallback);
  }
  return parsed.data;
}

// O-3: 낙관적 잠금 실패는 "누가 먼저 고쳤는지"까지 알려야 사용자가 판단할 수 있다.
// 이름 조회 실패도 삼키지 않고 로그를 남긴 뒤 이름 없는 기본 메시지로 폴백한다.
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
      console.error('[actions/team] 수정자 이름 조회 실패:', lookupError);
    }
  }
  return toActionFailure(e);
}

// 기관·인력 이름은 WBS 행에도 나오므로 팀 화면만 다시 그리면 부족하다
function revalidateTeam(projectId: string): void {
  revalidatePath('/projects');
  revalidatePath(`/projects/${projectId}`);
  revalidatePath(`/projects/${projectId}/team`);
  revalidatePath(`/projects/${projectId}/wbs`);
}

// PL-10b 파급은 비목 총액(budget_items)까지 바꾼다 — 연구비 화면도 다시 그려야 한다
function revalidateBudget(projectId: string): void {
  revalidatePath(`/projects/${projectId}/budget`);
}

// H-10: 같은 컨테이너(project)의 마지막 뒤에 붙인다. DB 기본값 0을 그대로 두면 순서가 겹친다.
function nextOrder(rows: readonly { order: number }[]): number {
  return rows.reduce((max, row) => Math.max(max, row.order + 1), 0);
}

// ─── Organization ─────────────────────────────────────────────────────────────

export async function createOrganization(
  projectId: string,
  input: unknown
): Promise<ActionResult<Organization>> {
  try {
    const pid = parseOrThrow(uuidSchema, projectId, '과제 ID 형식이 올바르지 않습니다.');
    const fields = parseOrThrow(
      organizationCreateSchema,
      input,
      '기관 정보가 올바르지 않습니다.'
    );
    const { user, client } = await requireApprovedUser();

    // H-8: 주관 지정은 insert가 아니라 set_lead_organization RPC의 몫이다.
    // role='lead'로 곧바로 insert하면 그 뒤 RPC가 실패했을 때 lead가 2개인 상태가 남아
    // 삭제 차단 판정이 무너진다. joint로 만들어 두고 승격하면 실패해도 lead 수는 그대로다.
    const wantsLead = fields.role === 'lead';

    const existing = await organizationsRepo.listOrganizations(client, pid);
    let created = await organizationsRepo.createOrganization(
      client,
      {
        projectId: pid,
        name: fields.name,
        role: wantsLead ? 'joint' : fields.role,
        type: fields.type ?? '',
        representative: fields.representative ?? '',
        contact: fields.contact ?? '',
        responsibility: fields.responsibility ?? '',
        budget: fields.budget ?? null,
        order: nextOrder(existing),
      },
      user.id
    );

    if (wantsLead) {
      // 기존 주관 강등 + 대상 승격 + projects.lead_org_id 갱신이 한 트랜잭션이다
      await organizationsRepo.setLeadOrganization(client, pid, created.id);
      // RPC가 role·version을 바꿨으므로 다시 읽어 최신 행을 돌려준다 (O-1 baseline)
      created = await organizationsRepo.getOrganizationById(client, created.id);
    }

    revalidateTeam(pid);
    return { ok: true, data: created };
  } catch (e) {
    return toFailure(e);
  }
}

// O-1: 기관 카드 저장은 여러 필드를 한 번에 바꾸므로 expectedVersion을 받아 잠금을 건다
export async function updateOrganization(
  id: string,
  patch: unknown,
  expectedVersion?: number
): Promise<ActionResult<Organization>> {
  let client: SupabaseClient | undefined;
  try {
    const orgId = parseOrThrow(uuidSchema, id, '기관 ID 형식이 올바르지 않습니다.');
    const parsed = parseOrThrow(organizationPatchSchema, patch, '기관 정보가 올바르지 않습니다.');
    const ctx = await requireApprovedUser();
    client = ctx.client;

    const before = await organizationsRepo.getOrganizationById(client, orgId);

    // H-8: 주관기관을 다른 역할로 내리는 순간 그 과제의 lead가 0개가 되고
    // projects.lead_org_id는 지워진 역할을 가리킨 채 남는다. 재지정으로만 바꾸게 한다.
    if (before.role === 'lead' && parsed.role !== undefined && parsed.role !== 'lead') {
      throw new RuleViolationError(
        '주관기관의 역할은 직접 바꿀 수 없습니다. 다른 기관을 주관으로 먼저 지정하세요.'
      );
    }

    // lead 승격은 RPC 트랜잭션이 담당하므로 이번 update에서는 role을 제외한다
    const promoteToLead = parsed.role === 'lead' && before.role !== 'lead';
    const { role: _role, ...rest } = parsed;
    const payload = promoteToLead ? rest : parsed;

    let updated =
      Object.keys(payload).length > 0
        ? await organizationsRepo.updateOrganization(
            client,
            orgId,
            payload,
            ctx.user.id,
            expectedVersion
          )
        : before;

    if (promoteToLead) {
      await organizationsRepo.setLeadOrganization(client, before.projectId, orgId);
      updated = await organizationsRepo.getOrganizationById(client, orgId);
    }

    revalidateTeam(before.projectId);
    return { ok: true, data: updated };
  } catch (e) {
    return toFailure(e, client);
  }
}

// H-8: 주관기관은 다른 기관을 주관으로 지정하기 전까지 삭제할 수 없다.
// role과 projects.lead_org_id를 모두 본다 — 둘 중 하나만 lead를 가리켜도 차단 대상이다.
// 참조하던 Member의 orgId는 FK set null(N-8)이 처리한다.
export async function deleteOrganization(id: string): Promise<ActionResult<null>> {
  try {
    const orgId = parseOrThrow(uuidSchema, id, '기관 ID 형식이 올바르지 않습니다.');
    const { client } = await requireApprovedUser();

    const org = await organizationsRepo.getOrganizationById(client, orgId);
    const project = await projectsRepo.getProjectById(client, org.projectId);
    if (org.role === 'lead' || project.leadOrgId === orgId) {
      throw new RuleViolationError(
        '주관기관은 삭제할 수 없습니다. 다른 기관을 주관으로 먼저 지정하세요.'
      );
    }

    await organizationsRepo.removeOrganization(client, orgId);
    revalidateTeam(org.projectId);
    return { ok: true, data: null };
  } catch (e) {
    return toFailure(e);
  }
}

// H-8: 강등·승격·포인터 갱신이 한 트랜잭션이다. 여러 행이 바뀌므로 갱신된 목록을 돌려준다.
export async function setLeadOrganization(
  projectId: string,
  orgId: string
): Promise<ActionResult<Organization[]>> {
  try {
    const pid = parseOrThrow(uuidSchema, projectId, '과제 ID 형식이 올바르지 않습니다.');
    const oid = parseOrThrow(uuidSchema, orgId, '기관 ID 형식이 올바르지 않습니다.');
    const { client } = await requireApprovedUser();
    await organizationsRepo.setLeadOrganization(client, pid, oid);
    const organizations = await organizationsRepo.listOrganizations(client, pid);
    revalidateTeam(pid);
    return { ok: true, data: organizations };
  } catch (e) {
    return toFailure(e);
  }
}

// H-10, X-3: 넘어온 순서대로 0..n-1. 다른 과제 기관이 섞이면 RPC가 거부한다.
export async function reorderOrganizations(
  projectId: string,
  orderedIds: string[]
): Promise<ActionResult<null>> {
  try {
    const pid = parseOrThrow(uuidSchema, projectId, '과제 ID 형식이 올바르지 않습니다.');
    const ids = parseOrThrow(uuidListSchema, orderedIds, '정렬 목록이 올바르지 않습니다.');
    const { client } = await requireApprovedUser();
    await organizationsRepo.reorderOrganizations(client, pid, ids);
    revalidateTeam(pid);
    return { ok: true, data: null };
  } catch (e) {
    return toFailure(e);
  }
}

// ─── Member ───────────────────────────────────────────────────────────────────

// 담당자·기관은 반드시 그 과제의 것이어야 한다 — H-11의 이유("다른 과제로 옮기면
// 담당자·기관·목표 연계가 전부 남의 과제를 가리키게 된다")가 여기에도 그대로 적용된다.
async function assertOrgInProject(
  client: SupabaseClient,
  projectId: string,
  orgId: string
): Promise<void> {
  const org = await organizationsRepo.getOrganizationById(client, orgId);
  if (org.projectId !== projectId) {
    throw new RuleViolationError('다른 과제의 기관을 소속으로 지정할 수 없습니다.');
  }
}

export async function createMember(
  projectId: string,
  input: unknown
): Promise<ActionResult<Member>> {
  try {
    const pid = parseOrThrow(uuidSchema, projectId, '과제 ID 형식이 올바르지 않습니다.');
    const fields = parseOrThrow(memberCreateSchema, input, '인력 정보가 올바르지 않습니다.');
    const { user, client } = await requireApprovedUser();

    const orgId = fields.orgId ?? null;
    if (orgId !== null) await assertOrgInProject(client, pid, orgId);

    const existing = await membersRepo.listMembers(client, pid);
    const created = await membersRepo.createMember(
      client,
      {
        projectId: pid,
        orgId,
        name: fields.name,
        role: fields.role ?? 'researcher',
        position: fields.position ?? '',
        field: fields.field ?? '',
        email: fields.email ?? '',
        phone: fields.phone ?? '',
        // N-11: DB 기본값은 false다. 새로 등록한 인력은 참여 중이므로 명시적으로 true를 넣는다
        active: fields.active ?? true,
        order: nextOrder(existing),
        // Phase 9 (§5.11): 미입력 연봉은 null이다. hireType 기본은 'existing'
        annualSalary: fields.annualSalary ?? null,
        hireType: fields.hireType ?? 'existing',
      },
      user.id
    );

    revalidateTeam(pid);
    return { ok: true, data: created };
  } catch (e) {
    return toFailure(e);
  }
}

// PL-10a: 새 금액은 액션이 lib/budget-plan.ts로 계산한다. RPC는 적용만 한다 —
// 산식이 두 곳에 생기면 반올림 경계에서 1원씩 어긋난다.
function recalcAmounts(
  details: readonly BudgetDetail[],
  memberId: string,
  annualSalary: number | null
): { amounts: membersRepo.SalaryDetailAmount[]; results: DetailAmountResult[] } {
  const member = { id: memberId, annualSalary };
  const results = details.map((detail) => computeDetailAmount(detail, member));
  return {
    amounts: details.map((detail, i) => ({ id: detail.id, amount: results[i]!.amount })),
    results,
  };
}

/**
 * PL-10b 확인용 미리보기. **저장하지 않는다.**
 *
 * 영향받는 산출근거를 전부 읽어 새 금액을 계산하고 (연차 × 비목)별 전후 금액과 건수를 돌려준다.
 * 화면은 detailCount가 0이면 확인 없이 저장하고, 1건 이상이면 이 결과로 확인 대화상자를 띄운다 (§7.10).
 */
export async function previewSalaryChange(
  id: string,
  annualSalary: unknown
): Promise<ActionResult<SalaryChangePreview>> {
  try {
    const memberId = parseOrThrow(uuidSchema, id, '인력 ID 형식이 올바르지 않습니다.');
    const nextSalary = parseOrThrow(annualSalarySchema, annualSalary, '연봉이 올바르지 않습니다.');
    const { client } = await requireApprovedUser();

    const member = await membersRepo.getMemberById(client, memberId);
    const details = await membersRepo.listSalaryImpactedDetails(client, memberId);
    const { results } = recalcAmounts(details, memberId, nextSalary);

    // 연차 이름은 화면 표시용이다. 이름이 비어 있으면 순번으로 부른다 (GanttChart와 같은 관례).
    // 목록에 없는 연차는 감추지 않고 그대로 드러낸다
    const years = await yearsRepo.listYears(client, member.projectId);
    const yearNames = new Map(
      years.map((year) => [year.id, year.name.trim() || `${year.order + 1}차년도`])
    );

    const cells = new Map<string, SalaryImpactCell>();
    let beforeTotal = 0;
    let afterTotal = 0;
    let missingSalaryCount = 0;

    details.forEach((detail, i) => {
      const result = results[i]!;
      beforeTotal += detail.amount;
      afterTotal += result.amount;
      if (result.missingSalary) missingSalaryCount += 1;

      const key = `${detail.yearId}|${detail.category}`;
      let cell = cells.get(key);
      if (!cell) {
        cell = {
          yearId: detail.yearId,
          yearName: yearNames.get(detail.yearId) ?? '(목록에 없는 연차)',
          category: detail.category,
          rowCount: 0,
          beforeAmount: 0,
          afterAmount: 0,
        };
        cells.set(key, cell);
      }
      cell.rowCount += 1;
      cell.beforeAmount += detail.amount;
      cell.afterAmount += result.amount;
    });

    return {
      ok: true,
      data: {
        memberId,
        memberName: member.name,
        currentAnnualSalary: member.annualSalary,
        nextAnnualSalary: nextSalary,
        detailCount: details.length,
        beforeTotal,
        afterTotal,
        delta: afterTotal - beforeTotal,
        missingSalaryCount,
        cells: [...cells.values()],
      },
    };
  } catch (e) {
    return toFailure(e);
  }
}

// O-1: 인력 행 편집은 여러 필드를 한 번에 바꾸므로 expectedVersion을 받아 잠금을 건다
//
// PL-10b: 연봉이 **실제로 바뀌는** 경우에만 apply_salary_change 경로를 탄다. 그 외 필드만 바뀌면
// 기존 경로 그대로다. 금액 파급을 마지막에 두는 이유: 앞 단계가 실패하면 예산은 손대지 않은 채 남는다.
export async function updateMember(
  id: string,
  patch: unknown,
  expectedVersion?: number
): Promise<ActionResult<Member>> {
  let client: SupabaseClient | undefined;
  try {
    const memberId = parseOrThrow(uuidSchema, id, '인력 ID 형식이 올바르지 않습니다.');
    const parsed = parseOrThrow(memberPatchSchema, patch, '인력 정보가 올바르지 않습니다.');
    const ctx = await requireApprovedUser();
    client = ctx.client;

    const before = await membersRepo.getMemberById(client, memberId);
    if (parsed.orgId !== undefined && parsed.orgId !== null) {
      await assertOrgInProject(client, before.projectId, parsed.orgId);
    }

    const { annualSalary: nextSalary, ...rest } = parsed;
    const salaryChanged = nextSalary !== undefined && nextSalary !== before.annualSalary;

    if (!salaryChanged) {
      const updated = await membersRepo.updateMember(
        client,
        memberId,
        parsed,
        ctx.user.id,
        expectedVersion
      );
      revalidateTeam(before.projectId);
      return { ok: true, data: updated };
    }

    // 연봉 외 필드를 먼저 저장해 O-1 잠금을 사용자의 baseline version에서 판정한다.
    // 여기서 STALE이면 예산은 아직 아무것도 건드리지 않은 상태다.
    let lockVersion = expectedVersion;
    if (Object.keys(rest).length > 0) {
      const saved = await membersRepo.updateMember(
        client,
        memberId,
        rest,
        ctx.user.id,
        expectedVersion
      );
      // 방금 저장으로 version이 올랐다 — 잠금을 끊지 않도록 그 값으로 잇는다
      if (expectedVersion !== undefined) lockVersion = saved.version;
    }

    const details = await membersRepo.listSalaryImpactedDetails(client, memberId);
    const { amounts } = recalcAmounts(details, memberId, nextSalary ?? null);

    // 연봉 + 인건비 행 금액 + budget_items를 한 트랜잭션으로 적용한다 (PL-10b).
    // 목록이 그 사이 늘어났으면 RPC가 집합 불일치로 거부한다 — 부분 반영은 없다.
    const applied = await membersRepo.applySalaryChange(
      client,
      memberId,
      nextSalary ?? null,
      amounts,
      lockVersion
    );

    revalidateTeam(before.projectId);
    if (applied.cells > 0) revalidateBudget(before.projectId);

    // RPC는 요약 jsonb만 돌려준다 — 화면이 쓰는 최신 행(O-1 baseline)은 다시 읽어 준다
    return { ok: true, data: await membersRepo.getMemberById(client, memberId) };
  } catch (e) {
    return toFailure(e, client);
  }
}

// H-9: 참조 8곳을 한 트랜잭션으로 정리하고 정리된 건수를 돌려준다 —
// UI가 "작업 3건의 책임자가 비었습니다"처럼 결과를 그대로 알린다 (절대 규칙 5).
// H-9a: 인건비 산출근거가 1건이라도 걸려 있으면 RPC가 거부한다(RULE). 사람을 지운 조작만으로
// 비목 총액이 줄어드는 것을 막는 차단이며, 화면은 countMemberReferences로 미리 알린다.
export async function deleteMember(
  id: string
): Promise<ActionResult<membersRepo.MemberReferenceCounts>> {
  try {
    const memberId = parseOrThrow(uuidSchema, id, '인력 ID 형식이 올바르지 않습니다.');
    const { client } = await requireApprovedUser();
    const member = await membersRepo.getMemberById(client, memberId);
    const counts = await membersRepo.removeMember(client, memberId);
    revalidateTeam(member.projectId);
    return { ok: true, data: counts };
  } catch (e) {
    return toFailure(e);
  }
}

// H-9: 삭제 확인 대화상자가 "무엇이 몇 건 정리되는지"를 미리 보여주기 위한 읽기 전용 집계
export async function countMemberReferences(
  id: string
): Promise<ActionResult<membersRepo.MemberReferenceCounts>> {
  try {
    const memberId = parseOrThrow(uuidSchema, id, '인력 ID 형식이 올바르지 않습니다.');
    const { client } = await requireApprovedUser();
    return { ok: true, data: await membersRepo.countMemberReferences(client, memberId) };
  } catch (e) {
    return toFailure(e);
  }
}

// H-9: 참여 종료는 삭제보다 이 토글이 우선이다. O-2: 단일 조작이라 낙관적 잠금을 생략한다.
export async function setMemberActive(
  id: string,
  active: boolean
): Promise<ActionResult<Member>> {
  try {
    const memberId = parseOrThrow(uuidSchema, id, '인력 ID 형식이 올바르지 않습니다.');
    const flag = parseOrThrow(z.boolean(), active, '활성 여부 값이 올바르지 않습니다.');
    const { user, client } = await requireApprovedUser();
    const updated = await membersRepo.updateMember(client, memberId, { active: flag }, user.id);
    revalidateTeam(updated.projectId);
    return { ok: true, data: updated };
  } catch (e) {
    return toFailure(e);
  }
}

// §7.10: PM은 과제당 1명. projects.pm_member_id만 갱신하고 기존 PM의 role은 건드리지 않는다
// ("자동으로 pl로 강등되지 않고 경고만"). 경고에 필요한 이전 PM을 함께 돌려준다.
export async function setProjectPM(
  projectId: string,
  memberId: string
): Promise<ActionResult<ProjectPMResult>> {
  try {
    const pid = parseOrThrow(uuidSchema, projectId, '과제 ID 형식이 올바르지 않습니다.');
    const mid = parseOrThrow(uuidSchema, memberId, '인력 ID 형식이 올바르지 않습니다.');
    const { user, client } = await requireApprovedUser();

    const project = await projectsRepo.getProjectById(client, pid);
    const member = await membersRepo.getMemberById(client, mid);
    if (member.projectId !== pid) {
      throw new RuleViolationError('다른 과제의 인력을 PM으로 지정할 수 없습니다.');
    }

    const previousPmMemberId = project.pmMemberId;
    const updated = await projectsRepo.updateProject(client, pid, {
      pmMemberId: mid,
      updatedBy: user.id,
    });

    revalidateTeam(pid);
    return { ok: true, data: { project: updated, previousPmMemberId } };
  } catch (e) {
    return toFailure(e);
  }
}

// H-10, X-3: 넘어온 순서대로 0..n-1. 다른 과제 인력이 섞이면 RPC가 거부한다.
export async function reorderMembers(
  projectId: string,
  orderedIds: string[]
): Promise<ActionResult<null>> {
  try {
    const pid = parseOrThrow(uuidSchema, projectId, '과제 ID 형식이 올바르지 않습니다.');
    const ids = parseOrThrow(uuidListSchema, orderedIds, '정렬 목록이 올바르지 않습니다.');
    const { client } = await requireApprovedUser();
    await membersRepo.reorderMembers(client, pid, ids);
    revalidateTeam(pid);
    return { ok: true, data: null };
  } catch (e) {
    return toFailure(e);
  }
}

// ─── 조회 (§9 조회 목록 — 서버 컴포넌트에서 직접 호출) ────────────────────────

// 이름 표시용 경량 조회. 정렬은 리포지토리가 sort_order로 이미 맞춰 돌려준다 (H-10).
export async function getTeam(projectId: string): Promise<ActionResult<Team>> {
  try {
    const pid = parseOrThrow(uuidSchema, projectId, '과제 ID 형식이 올바르지 않습니다.');
    const { client } = await requireApprovedUser();
    const [organizations, members] = await Promise.all([
      organizationsRepo.listOrganizations(client, pid),
      membersRepo.listMembers(client, pid),
    ]);
    return { ok: true, data: { organizations, members } };
  } catch (e) {
    return toFailure(e);
  }
}

// §7.10 인력·기관 화면 전체. 배정 작업 집계는 서버에서 끝낸다 — 화면이 Task 전체를
// 다시 훑지 않게 하고, 작업 목록 패널이 곧바로 그려지게 한다.
export async function getTeamScreenData(
  projectId: string
): Promise<ActionResult<TeamScreenData>> {
  try {
    const pid = parseOrThrow(uuidSchema, projectId, '과제 ID 형식이 올바르지 않습니다.');
    const { client } = await requireApprovedUser();

    const [project, organizations, members, tasks] = await Promise.all([
      projectsRepo.getProjectById(client, pid),
      organizationsRepo.listOrganizations(client, pid),
      membersRepo.listMembers(client, pid),
      tasksRepo.listTasksByProject(client, pid),
    ]);

    // 배정이 없는 인력도 키를 갖게 해서 UI가 폴백 분기를 만들지 않도록 한다
    const assignedTasksByMember: Record<string, AssignedTask[]> = {};
    for (const member of members) assignedTasksByMember[member.id] = [];

    for (const task of tasks) {
      // 책임자이면서 참여자이기도 한 경우 한 번만 담고 isOwner를 우선한다
      const assignees = new Set(task.memberIds);
      if (task.ownerMemberId !== null) assignees.add(task.ownerMemberId);
      for (const memberId of assignees) {
        // 이 과제에 없는 인력이 배정돼 있으면 조용히 버리지 않고 목록에 드러낸다
        let bucket = assignedTasksByMember[memberId];
        if (!bucket) {
          bucket = [];
          assignedTasksByMember[memberId] = bucket;
        }
        bucket.push({
          id: task.id,
          title: task.title,
          yearId: task.yearId,
          status: task.status,
          isOwner: task.ownerMemberId === memberId,
        });
      }
    }

    return {
      ok: true,
      data: { project, organizations, members, assignedTasksByMember },
    };
  } catch (e) {
    return toFailure(e);
  }
}
