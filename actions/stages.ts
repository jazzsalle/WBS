'use server';

// Stage 서버 액션 (SOT §9 Stage 목록, SA-1~SA-4, §8.4 O-1·O-3, §6.6 H-6·H-10)
// 반환은 ActionResult<T> — 예외를 그대로 던지지 않는다. supabase 직접 호출 금지,
// 반드시 lib/db/ 리포지토리를 거친다 (§8.6).

import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { ActionResult, Stage } from '@/types';
import { requireApprovedUser } from '@/lib/auth/guard';
import * as appUsers from '@/lib/db/app-users';
import * as stagesRepo from '@/lib/db/stages';
import { StaleDataError, ValidationError, toActionFailure } from '@/lib/db/errors';

const isoDateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "날짜는 'YYYY-MM-DD' 형식이어야 합니다.");

const amountSchema = z.number().int('금액은 원 단위 정수로 입력하세요.');

const uuidSchema = z.uuid();
const uuidListSchema = z.array(z.uuid()).min(1, '정렬할 단계가 없습니다.');

// order는 생성 시 자동 부여, 변경은 reorderStages 전용이다 (H-10, X-3)
const stageFieldsSchema = z.object({
  name: z.string().trim().max(100, '단계명은 100자 이내여야 합니다.'),
  goal: z.string().max(2000),
  startDate: isoDateSchema.nullable(),
  endDate: isoDateSchema.nullable(),
  budget: amountSchema.nullable(),
});

const stageCreateSchema = stageFieldsSchema.partial();
const stagePatchSchema = stageFieldsSchema.partial();

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
      console.error('[actions/stages] 수정자 이름 조회 실패:', lookupError);
    }
  }
  return toActionFailure(e);
}

function revalidateProject(projectId: string): void {
  revalidatePath('/projects');
  revalidatePath(`/projects/${projectId}`);
  revalidatePath(`/projects/${projectId}/wbs`);
}

export async function createStage(
  projectId: string,
  input: unknown
): Promise<ActionResult<Stage>> {
  try {
    const pid = parseOrThrow(uuidSchema, projectId, '과제 ID 형식이 올바르지 않습니다.');
    const parsed = parseOrThrow(stageCreateSchema, input, '단계 정보가 올바르지 않습니다.');
    const { user, client } = await requireApprovedUser();

    // H-10: 새 단계는 과제 내 마지막 뒤에 붙는다 (DB 기본값 0을 그대로 두면 순서가 겹친다)
    const siblings = await stagesRepo.listStages(client, pid);
    const order = siblings.reduce((max, s) => Math.max(max, s.order + 1), 0);

    const stage = await stagesRepo.createStage(client, {
      projectId: pid,
      ...parsed,
      order,
      createdBy: user.id,
      updatedBy: user.id,
    });
    revalidateProject(pid);
    return { ok: true, data: stage };
  } catch (e) {
    return toFailure(e);
  }
}

// O-1: 여러 필드를 한 번에 바꾸는 저장은 expectedVersion으로 잠금을 건다
export async function updateStage(
  id: string,
  patch: unknown,
  expectedVersion?: number
): Promise<ActionResult<Stage>> {
  let client: SupabaseClient | undefined;
  try {
    const stageId = parseOrThrow(uuidSchema, id, '단계 ID 형식이 올바르지 않습니다.');
    const parsed = parseOrThrow(stagePatchSchema, patch, '단계 정보가 올바르지 않습니다.');
    const ctx = await requireApprovedUser();
    client = ctx.client;
    const updated = await stagesRepo.updateStage(
      client,
      stageId,
      { ...parsed, updatedBy: ctx.user.id },
      expectedVersion
    );
    revalidateProject(updated.projectId);
    return { ok: true, data: updated };
  } catch (e) {
    return toFailure(e, client);
  }
}

// H-6: 마지막 단계 삭제 거부는 RPC가 판정한다 — RuleViolationError가 code 'RULE'로 전달된다
export async function deleteStage(id: string): Promise<ActionResult<null>> {
  try {
    const stageId = parseOrThrow(uuidSchema, id, '단계 ID 형식이 올바르지 않습니다.');
    const { client } = await requireApprovedUser();
    // 삭제 후에는 projectId를 알 수 없으므로 먼저 읽는다 (없으면 NotFoundError)
    const stage = await stagesRepo.getStageById(client, stageId);
    await stagesRepo.deleteStage(client, stageId);
    revalidateProject(stage.projectId);
    return { ok: true, data: null };
  } catch (e) {
    return toFailure(e);
  }
}

// H-10: 컨테이너는 project. 한 번의 RPC로 0..n-1을 일괄 부여한다 (X-3)
export async function reorderStages(
  projectId: string,
  orderedIds: string[]
): Promise<ActionResult<null>> {
  try {
    const pid = parseOrThrow(uuidSchema, projectId, '과제 ID 형식이 올바르지 않습니다.');
    const ids = parseOrThrow(uuidListSchema, orderedIds, '정렬 목록이 올바르지 않습니다.');
    const { client } = await requireApprovedUser();
    await stagesRepo.reorderStages(client, pid, ids);
    revalidateProject(pid);
    return { ok: true, data: null };
  } catch (e) {
    return toFailure(e);
  }
}
