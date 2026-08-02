'use server';

// Auth 서버 액션 (SOT §9 Auth 목록, SA-1~SA-4, §14.2 A-5)
// 반환은 ActionResult<T> — 예외를 그대로 던지지 않는다. supabase 직접 호출 금지,
// 반드시 lib/db/app-users 리포지토리를 거친다 (C-2, §8.6).

import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import type { ActionResult, AppUser } from '@/types';
import { requireApprovedUser, requireSession } from '@/lib/auth/guard';
import * as appUsers from '@/lib/db/app-users';
import { ValidationError, toActionFailure } from '@/lib/db/errors';

const uuidSchema = z.uuid();

const profilePatchSchema = z.object({
  name: z.string().trim().min(1, '표시 이름을 입력하세요.').max(100).optional(),
  memberId: z.uuid().nullable().optional(),
});

// 세션 + app_users 프로필 조회. active 확인을 하지 않는 유일한 액션 —
// 승인 대기 화면(§7.0 /pending)이 본인 프로필(이메일·상태)을 읽어야 한다.
export async function getCurrentUser(): Promise<ActionResult<AppUser>> {
  try {
    const { user } = await requireSession();
    return { ok: true, data: user };
  } catch (e) {
    return toActionFailure(e);
  }
}

// 설정 화면 사용자 관리(§7.14)의 승인 대기자 목록
export async function listPendingUsers(): Promise<ActionResult<AppUser[]>> {
  try {
    const { client } = await requireApprovedUser();
    const users = await appUsers.listAppUsers(client);
    return { ok: true, data: users.filter((u) => !u.active) };
  } catch (e) {
    return toActionFailure(e);
  }
}

// A-5: 승인된 사용자는 누구나 대기자를 승인할 수 있다.
// 자기 자신 승인 거부는 approve_user RPC(security definer)가 최종 판정한다.
export async function approveUser(userId: string): Promise<ActionResult<null>> {
  try {
    const parsed = uuidSchema.safeParse(userId);
    if (!parsed.success) throw new ValidationError('사용자 ID 형식이 올바르지 않습니다.');
    const { client } = await requireApprovedUser();
    await appUsers.approveUser(client, parsed.data);
    revalidatePath('/settings');
    return { ok: true, data: null };
  } catch (e) {
    return toActionFailure(e);
  }
}

// 자기 자신 비활성화 거부(마지막 사용자 잠금 사고 방지)는 deactivate_user RPC가 판정한다
export async function deactivateUser(userId: string): Promise<ActionResult<null>> {
  try {
    const parsed = uuidSchema.safeParse(userId);
    if (!parsed.success) throw new ValidationError('사용자 ID 형식이 올바르지 않습니다.');
    const { client } = await requireApprovedUser();
    await appUsers.deactivateUser(client, parsed.data);
    revalidatePath('/settings');
    return { ok: true, data: null };
  } catch (e) {
    return toActionFailure(e);
  }
}

// 표시 이름·Member 연결 편집 (§7.14, §14.4 ③). 본인 행만 — 대상 id는 세션에서 얻는다.
export async function updateMyProfile(patch: {
  name?: string;
  memberId?: string | null;
}): Promise<ActionResult<AppUser>> {
  try {
    const parsed = profilePatchSchema.safeParse(patch);
    if (!parsed.success) {
      throw new ValidationError(parsed.error.issues[0]?.message ?? '입력값이 올바르지 않습니다.');
    }
    const { user, client } = await requireApprovedUser();
    const updated = await appUsers.updateProfile(client, user.id, parsed.data);
    revalidatePath('/settings');
    return { ok: true, data: updated };
  } catch (e) {
    return toActionFailure(e);
  }
}
