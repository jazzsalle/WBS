'use server';

// Milestone 서버 액션 + 마일스톤 화면 조회
// (SOT §9 Milestone·조회 목록, SA-1~SA-4, §5.7, §7.8, §8.3 X-1, §8.4 O-1~O-3)
// 반환은 ActionResult<T> — 예외를 그대로 던지지 않는다. supabase 직접 호출 금지,
// 반드시 lib/db/ 리포지토리를 거친다 (§8.6).
//
// 기본 마일스톤 자동 생성(§7.8)은 "중복 검사 + 2건 삽입"이 한 트랜잭션이어야 해서
// 리포지토리가 RPC를 부른다 (SA-3, X-1).

import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { ActionResult, Member, Milestone, Year } from '@/types';
import { requireApprovedUser } from '@/lib/auth/guard';
import * as appUsers from '@/lib/db/app-users';
import * as membersRepo from '@/lib/db/members';
import * as milestonesRepo from '@/lib/db/milestones';
import * as settingsRepo from '@/lib/db/settings';
import * as yearsRepo from '@/lib/db/years';
import {
  RuleViolationError,
  StaleDataError,
  ValidationError,
  toActionFailure,
} from '@/lib/db/errors';
import { milestoneStatusSchema, milestoneTypeSchema } from '@/lib/db/schema';

// ─── 조회 모델 (§9 조회 목록, §7.8) ───────────────────────────────────────────

// 타임라인은 연차 밴드 위에 마커를 놓고(§7.8), 목록은 연차·담당 이름과 D-day를 보여준다.
// 마감 임박 판정 기준(milestoneAlertDays, §6.5)까지 함께 실어 화면이 설정을 따로 읽지 않게 한다.
export interface MilestonesData {
  projectId: string;
  milestones: Milestone[];
  years: Year[];
  members: Member[];
  milestoneAlertDays: number;
}

// ─── 입력 검증 ────────────────────────────────────────────────────────────────

const uuidSchema = z.uuid();

// §5.7 date는 'YYYY-MM-DD' 필수다 — 날짜 없는 마일스톤은 D-day도 타임라인 위치도 없다
const isoDateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "날짜는 'YYYY-MM-DD' 형식이어야 합니다.");

const titleSchema = z
  .string()
  .trim()
  .min(1, '제목을 입력하세요.')
  .max(200, '제목은 200자 이내여야 합니다.');

const longTextSchema = z.string().max(10_000);

const milestoneFieldsSchema = z.object({
  yearId: z.uuid().nullable(),
  type: milestoneTypeSchema,
  title: titleSchema,
  date: isoDateSchema,
  status: milestoneStatusSchema,
  ownerMemberId: z.uuid().nullable(),
  description: longTextSchema,
  resultNote: longTextSchema,
});

// type·date는 DB에 기본값이 없다(not null). title은 기본값이 ''이지만 제목 없는
// 마일스톤은 타임라인에서 식별이 불가능하므로 생성 시 함께 받는다.
const milestoneCreateSchema = milestoneFieldsSchema.partial().extend({
  type: milestoneFieldsSchema.shape.type,
  title: milestoneFieldsSchema.shape.title,
  date: milestoneFieldsSchema.shape.date,
});

const milestonePatchSchema = milestoneFieldsSchema.partial();

// §7.8 "날짜는 연차 종료일 기준 자동 제안, 수정 가능" — 사용자가 고른 날짜를 그대로 받는다
const defaultMilestoneOptionsSchema = z.object({
  annualEvalDate: isoDateSchema.nullable().optional(),
  reportDate: isoDateSchema.nullable().optional(),
});

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
      console.error('[actions/milestones] 수정자 이름 조회 실패:', lookupError);
    }
  }
  return toActionFailure(e);
}

// 마일스톤은 대시보드의 임박 타임라인(§7.2)과 과제 개요에도 나온다 —
// 마일스톤 화면만 다시 그리면 부족하다
function revalidateMilestones(projectId: string): void {
  revalidatePath('/');
  revalidatePath(`/projects/${projectId}`);
  revalidatePath(`/projects/${projectId}/milestones`);
}

// 연차·담당자 참조는 반드시 그 마일스톤이 속한 과제의 것이어야 한다. 근거는 H-11과 같다 —
// FK는 테이블만 강제할 뿐 과제 경계를 막지 못해서, 남의 과제 연차·인력을 가리키는
// 마일스톤이 조용히 저장된다. null(미지정)은 검사 대상이 아니다.
interface MilestoneRefs {
  yearId?: string | null;
  ownerMemberId?: string | null;
}

async function assertMilestoneRefsInProject(
  client: SupabaseClient,
  projectId: string,
  refs: MilestoneRefs
): Promise<void> {
  if (refs.yearId != null) {
    const years = await yearsRepo.listYears(client, projectId);
    if (!years.some((y) => y.id === refs.yearId)) {
      throw new RuleViolationError('이 과제에 속하지 않은 연차는 지정할 수 없습니다.');
    }
  }

  if (refs.ownerMemberId != null) {
    const members = await membersRepo.listMembers(client, projectId);
    if (!members.some((m) => m.id === refs.ownerMemberId)) {
      throw new RuleViolationError('이 과제에 속하지 않은 인력은 담당자로 지정할 수 없습니다.');
    }
  }
}

// ─── CRUD (§5.7, §9 Milestone) ────────────────────────────────────────────────

export async function createMilestone(
  projectId: string,
  input: unknown
): Promise<ActionResult<Milestone>> {
  try {
    const pid = parseOrThrow(uuidSchema, projectId, '과제 ID 형식이 올바르지 않습니다.');
    const fields = parseOrThrow(milestoneCreateSchema, input, '마일스톤 정보가 올바르지 않습니다.');
    const { user, client } = await requireApprovedUser();

    await assertMilestoneRefsInProject(client, pid, {
      yearId: fields.yearId,
      ownerMemberId: fields.ownerMemberId,
    });

    const created = await milestonesRepo.createMilestone(
      client,
      {
        projectId: pid,
        yearId: fields.yearId ?? null, // §5.7 없으면 과제 전체 이벤트
        type: fields.type,
        title: fields.title,
        date: fields.date,
        status: fields.status ?? 'planned',
        ownerMemberId: fields.ownerMemberId ?? null,
        description: fields.description ?? '',
        resultNote: fields.resultNote ?? '',
      },
      user.id
    );

    revalidateMilestones(pid);
    return { ok: true, data: created };
  } catch (e) {
    return toFailure(e);
  }
}

// O-1: 상세 편집은 여러 필드를 한 번에 바꾸므로 expectedVersion을 받아 잠금을 건다
export async function updateMilestone(
  id: string,
  patch: unknown,
  expectedVersion?: number
): Promise<ActionResult<Milestone>> {
  let client: SupabaseClient | undefined;
  try {
    const mid = parseOrThrow(uuidSchema, id, '마일스톤 ID 형식이 올바르지 않습니다.');
    const parsed = parseOrThrow(milestonePatchSchema, patch, '마일스톤 정보가 올바르지 않습니다.');
    const ctx = await requireApprovedUser();
    client = ctx.client;

    // 참조가 patch에 들어올 때만 소속을 확인한다 (조회 1~2회를 아끼기 위해)
    if (parsed.yearId !== undefined || parsed.ownerMemberId !== undefined) {
      const before = await milestonesRepo.getMilestoneById(client, mid);
      await assertMilestoneRefsInProject(client, before.projectId, {
        yearId: parsed.yearId,
        ownerMemberId: parsed.ownerMemberId,
      });
    }

    const updated = await milestonesRepo.updateMilestone(
      client,
      mid,
      parsed,
      ctx.user.id,
      expectedVersion
    );
    revalidateMilestones(updated.projectId);
    return { ok: true, data: updated };
  } catch (e) {
    return toFailure(e, client);
  }
}

// 연결된 노트는 지우지 않는다 — notes.milestone_id는 set null이다 (N-8, §5.14 단방향 참조)
export async function deleteMilestone(id: string): Promise<ActionResult<null>> {
  try {
    const mid = parseOrThrow(uuidSchema, id, '마일스톤 ID 형식이 올바르지 않습니다.');
    const { client } = await requireApprovedUser();

    // 삭제 후에는 projectId를 알 수 없으므로 먼저 읽는다 (없으면 NotFoundError)
    const milestone = await milestonesRepo.getMilestoneById(client, mid);
    await milestonesRepo.removeMilestone(client, mid);

    revalidateMilestones(milestone.projectId);
    return { ok: true, data: null };
  } catch (e) {
    return toFailure(e);
  }
}

// §7.8 "상태 인라인 변경, 결과 메모 입력". O-2: 사용자가 만지는 조작이 하나(상태 드롭다운)이고
// 결과 메모는 그에 딸린 값이라 낙관적 잠금을 생략한다 — 마지막 것이 이기는 게 자연스럽다.
export async function setMilestoneStatus(
  id: string,
  status: unknown,
  resultNote?: unknown
): Promise<ActionResult<Milestone>> {
  try {
    const mid = parseOrThrow(uuidSchema, id, '마일스톤 ID 형식이 올바르지 않습니다.');
    const value = parseOrThrow(milestoneStatusSchema, status, '마일스톤 상태 값이 올바르지 않습니다.');
    // 인자를 생략하면 기존 메모를 유지한다 — 상태만 바꾸는 조작이 메모를 지우면 안 된다
    const note =
      resultNote === undefined
        ? undefined
        : parseOrThrow(longTextSchema, resultNote, '결과 메모가 올바르지 않습니다.');
    const { user, client } = await requireApprovedUser();

    const updated = await milestonesRepo.updateMilestone(
      client,
      mid,
      note === undefined ? { status: value } : { status: value, resultNote: note },
      user.id
    );

    revalidateMilestones(updated.projectId);
    return { ok: true, data: updated };
  } catch (e) {
    return toFailure(e);
  }
}

// §7.8 연차 기본 마일스톤(연차평가 + 연차실적계획서 제출). 이미 있는 유형은 RPC가 건너뛰므로
// 재실행해도 늘어나지 않는다(멱등). 날짜를 생략하면 연차 종료일을 쓰고, 종료일이 없으면
// 아무것도 만들지 않고 RULE로 실패한다 — 틀린 마감일을 지어내지 않는다.
export async function generateDefaultMilestones(
  yearId: string,
  options?: unknown
): Promise<ActionResult<Milestone[]>> {
  try {
    const yid = parseOrThrow(uuidSchema, yearId, '연차 ID 형식이 올바르지 않습니다.');
    const dates = parseOrThrow(
      defaultMilestoneOptionsSchema,
      options ?? {},
      '기본 마일스톤 날짜가 올바르지 않습니다.'
    );
    const { client } = await requireApprovedUser();

    // 화면 갱신 대상 과제를 알아야 하고, 없는 연차는 RPC보다 먼저 NotFound로 걸러진다
    const year = await yearsRepo.getYearById(client, yid);
    const created = await milestonesRepo.generateDefaultMilestones(client, yid, dates);

    revalidateMilestones(year.projectId);
    return { ok: true, data: created };
  } catch (e) {
    return toFailure(e);
  }
}

// ─── 조회 (§9 조회 목록 — 서버 컴포넌트에서 직접 호출) ────────────────────────

export async function getMilestonesData(projectId: string): Promise<ActionResult<MilestonesData>> {
  try {
    const pid = parseOrThrow(uuidSchema, projectId, '과제 ID 형식이 올바르지 않습니다.');
    const { client } = await requireApprovedUser();

    // 하나라도 실패하면 실패를 그대로 올린다 — 빈 배열 폴백은 데이터 손상을 감춘다 (절대 규칙 5)
    const [milestones, years, members, settings] = await Promise.all([
      milestonesRepo.listMilestones(client, pid),
      yearsRepo.listYears(client, pid),
      membersRepo.listMembers(client, pid),
      settingsRepo.getSettings(client),
    ]);

    return {
      ok: true,
      data: {
        projectId: pid,
        milestones,
        years,
        members,
        milestoneAlertDays: settings.milestoneAlertDays,
      },
    };
  } catch (e) {
    return toFailure(e);
  }
}
