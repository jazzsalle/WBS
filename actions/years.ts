'use server';

// Year 서버 액션 (SOT §9 Year 목록, SA-1~SA-4, §8.4 O-1~O-3, §5.5, §6.6 H-5·H-10)
// 반환은 ActionResult<T> — 예외를 그대로 던지지 않는다. supabase 직접 호출 금지,
// 반드시 lib/db/ 리포지토리를 거친다 (§8.6).
// 생성·삭제·상태 지정은 다중 테이블 작업이라 리포지토리가 RPC 트랜잭션을 쓴다 (SA-3, X-1).

import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { ActionResult, Year } from '@/types';
import { requireApprovedUser } from '@/lib/auth/guard';
import * as appUsers from '@/lib/db/app-users';
import * as yearsRepo from '@/lib/db/years';
import { StaleDataError, ValidationError, toActionFailure } from '@/lib/db/errors';
import { yearStatusSchema } from '@/lib/db/schema';

const isoDateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "날짜는 'YYYY-MM-DD' 형식이어야 합니다.");

const amountSchema = z.number().int('금액은 원 단위 정수로 입력하세요.');

const uuidSchema = z.uuid();
const uuidListSchema = z.array(z.uuid()).min(1, '정렬할 연차가 없습니다.');

// order는 create_year RPC가 과제 전체 기준으로 부여한다(§5.5). 변경은 reorderYears 전용 (H-10)
const yearFieldsSchema = z.object({
  name: z.string().trim().max(100, '연차명은 100자 이내여야 합니다.'),
  goal: z.string().max(2000),
  startDate: isoDateSchema.nullable(),
  endDate: isoDateSchema.nullable(),
  budget: amountSchema.nullable(),
  status: yearStatusSchema,
});

const yearCreateSchema = yearFieldsSchema.partial();
const yearPatchSchema = yearFieldsSchema.partial();

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
      console.error('[actions/years] 수정자 이름 조회 실패:', lookupError);
    }
  }
  return toActionFailure(e);
}

function revalidateProject(projectId: string): void {
  revalidatePath('/projects');
  revalidatePath(`/projects/${projectId}`);
  revalidatePath(`/projects/${projectId}/wbs`);
}

// §5.5: 해당 stage의 마지막 연차 뒤에 삽입하고 이후 전체를 +1 시프트 + 비목 12종 생성 — 전부 RPC 몫
export async function createYear(stageId: string, input: unknown): Promise<ActionResult<Year>> {
  try {
    const sid = parseOrThrow(uuidSchema, stageId, '단계 ID 형식이 올바르지 않습니다.');
    const parsed = parseOrThrow(yearCreateSchema, input, '연차 정보가 올바르지 않습니다.');
    const { client } = await requireApprovedUser();
    const year = await yearsRepo.createYear(client, { stageId: sid, ...parsed });
    revalidateProject(year.projectId);
    return { ok: true, data: year };
  } catch (e) {
    return toFailure(e);
  }
}

// O-1: 여러 필드를 한 번에 바꾸는 저장은 expectedVersion으로 잠금을 건다
export async function updateYear(
  id: string,
  patch: unknown,
  expectedVersion?: number
): Promise<ActionResult<Year>> {
  let client: SupabaseClient | undefined;
  try {
    const yearId = parseOrThrow(uuidSchema, id, '연차 ID 형식이 올바르지 않습니다.');
    const parsed = parseOrThrow(yearPatchSchema, patch, '연차 정보가 올바르지 않습니다.');
    const ctx = await requireApprovedUser();
    client = ctx.client;
    const updated = await yearsRepo.updateYear(
      client,
      yearId,
      { ...parsed, updatedBy: ctx.user.id },
      expectedVersion
    );
    revalidateProject(updated.projectId);
    return { ok: true, data: updated };
  } catch (e) {
    return toFailure(e, client);
  }
}

// H-5: Task·BudgetItem은 연쇄 삭제, 마일스톤·실적은 yearId=null로 남는다 (RPC 트랜잭션)
export async function deleteYear(id: string): Promise<ActionResult<null>> {
  try {
    const yearId = parseOrThrow(uuidSchema, id, '연차 ID 형식이 올바르지 않습니다.');
    const { client } = await requireApprovedUser();
    // 삭제 후에는 projectId를 알 수 없으므로 먼저 읽는다 (없으면 NotFoundError)
    const year = await yearsRepo.getYearById(client, yearId);
    await yearsRepo.deleteYear(client, yearId);
    revalidateProject(year.projectId);
    return { ok: true, data: null };
  } catch (e) {
    return toFailure(e);
  }
}

// O-2: 상태 드롭다운은 단일 조작이라 낙관적 잠금을 생략한다.
// 'active' 지정 시 같은 과제의 기존 active 해제는 RPC가 한 트랜잭션으로 처리한다 (§5.5)
export async function setYearStatus(id: string, status: unknown): Promise<ActionResult<Year>> {
  try {
    const yearId = parseOrThrow(uuidSchema, id, '연차 ID 형식이 올바르지 않습니다.');
    const value = parseOrThrow(yearStatusSchema, status, '연차 상태 값이 올바르지 않습니다.');
    const { client } = await requireApprovedUser();
    const year = await yearsRepo.setYearStatus(client, yearId, value);
    revalidateProject(year.projectId);
    return { ok: true, data: year };
  } catch (e) {
    return toFailure(e);
  }
}

// H-10: 컨테이너는 project 전체(§5.5). 단계 경계를 넘는 순서는 RPC가 거부한다 (code 'RULE')
export async function reorderYears(
  projectId: string,
  orderedIds: string[]
): Promise<ActionResult<null>> {
  try {
    const pid = parseOrThrow(uuidSchema, projectId, '과제 ID 형식이 올바르지 않습니다.');
    const ids = parseOrThrow(uuidListSchema, orderedIds, '정렬 목록이 올바르지 않습니다.');
    const { client } = await requireApprovedUser();
    await yearsRepo.reorderYears(client, pid, ids);
    revalidateProject(pid);
    return { ok: true, data: null };
  } catch (e) {
    return toFailure(e);
  }
}
