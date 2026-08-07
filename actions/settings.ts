'use server';

// Settings 서버 액션 (SOT §5.16, §7.14 팀 설정, §9 updateSettings, SA-1~SA-4, §8.4 O-1·O-3)
// 반환은 ActionResult<T> — 예외를 그대로 던지지 않는다. supabase 직접 호출 금지,
// 반드시 lib/db/ 리포지토리를 거친다 (§8.6).
//
// app_settings는 N-10에 따라 단일 행이고 INSERT/DELETE 정책이 없다 — 생성·삭제 액션은 없다.
// schema_version은 마이그레이션만 갱신할 수 있어 트리거가 앱의 변경을 거부한다(N-10).
// 그 거부를 DB까지 보내지 않고 patch 스키마에서 미리 막는다 — actions/projects.ts의
// updateProject가 pmMemberId/leadOrgId를 막는 것과 같은 방식이다.

import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { ActionResult } from '@/types';
import { requireApprovedUser } from '@/lib/auth/guard';
import * as appUsers from '@/lib/db/app-users';
import * as membersRepo from '@/lib/db/members';
import * as settingsRepo from '@/lib/db/settings';
import type { SettingsRecord } from '@/lib/db/settings';
import { StaleDataError, ValidationError, toActionFailure } from '@/lib/db/errors';
import { appSettingsRowSchema } from '@/lib/db/schema';

// ─── 조회 모델 (§7.14) ────────────────────────────────────────────────────────

/**
 * 내 프로필의 Member 연결 선택지 (§7.14, §14.2).
 * app_users.member_id는 과제에 매이지 않는 링크라 전 과제 인력이 후보다.
 * 동명이인이 흔해 기관명을 함께 싣는다 — 표시 조립은 화면이 한다.
 */
export interface MemberOption {
  id: string;
  name: string;
  orgName: string | null;
  /** 참여 종료자(active=false)도 후보에 남긴다 — 기존 연결이 그 인력을 가리킬 수 있다 */
  active: boolean;
}

export interface SettingsData {
  settings: SettingsRecord;
  memberOptions: MemberOption[];
}

// ─── 입력 검증 (§5.16 6필드) ──────────────────────────────────────────────────

// 값 집합은 DB row 스키마(= 마이그레이션의 check 제약)를 그대로 재사용한다 —
// 허용 값을 두 곳에 적으면 한쪽만 늘었을 때 조용히 어긋난다.
const rowShape = appSettingsRowSchema.shape;

// 마감 임박·마일스톤 알림 기준일은 "며칠 전부터"라서 0일은 의미가 없다(§6.5).
// 상한은 업무 규칙이 아니라 integer 컬럼의 물리 한계다 — 넘기면 Postgres가 범위 초과로 거부한다.
const positiveDaysSchema = z
  .number()
  .int('기준일은 정수로 입력하세요.')
  .positive('기준일은 1 이상이어야 합니다.')
  .max(2_147_483_647, '기준일이 너무 큽니다.');

const settingsFieldsSchema = z.object({
  dueSoonDays: positiveDaysSchema,
  milestoneAlertDays: positiveDaysSchema,
  weekStartsOn: rowShape.week_starts_on,
  defaultGanttScale: rowShape.default_gantt_scale,
  currencyUnit: rowShape.currency_unit,
  progressWeightBasis: rowShape.progress_weight_basis,
});

// schemaVersion은 여기 없다 — N-10 트리거가 거부하는 값이라 액션에서 먼저 막는다.
// strict: 모르는 키를 조용히 버리지 않는다 (절대 규칙 5).
const settingsPatchSchema = settingsFieldsSchema.partial().strict();

// 트리거·마이그레이션만 바꿀 수 있는 필드 → 안내 메시지
const GUARDED_SETTINGS_FIELDS: Record<string, string> = {
  schemaVersion: '스키마 버전은 DB 마이그레이션만 갱신할 수 있습니다 (SOT N-10).',
};

function rejectGuardedFields(patch: unknown): void {
  if (typeof patch !== 'object' || patch === null) return;
  for (const [field, message] of Object.entries(GUARDED_SETTINGS_FIELDS)) {
    if (field in patch) throw new ValidationError(message);
  }
}

const expectedVersionSchema = z
  .number()
  .int()
  .positive('설정 버전이 올바르지 않습니다. 화면을 새로고침한 뒤 다시 저장하세요.');

function parseOrThrow<T>(schema: z.ZodType<T>, value: unknown, fallback: string): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    // Zod의 unrecognized_keys 기본 메시지는 영문이라 그대로 사용자에게 보이면 안 된다
    if (issue?.code === 'unrecognized_keys') {
      throw new ValidationError('저장할 수 없는 항목이 포함돼 있습니다.');
    }
    throw new ValidationError(issue?.message ?? fallback);
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
      console.error('[actions/settings] 수정자 이름 조회 실패:', lookupError);
    }
  }
  return toActionFailure(e);
}

// ─── 조회 ─────────────────────────────────────────────────────────────────────

export async function getSettingsData(): Promise<ActionResult<SettingsData>> {
  try {
    const { client } = await requireApprovedUser();
    // 하나라도 실패하면 그대로 올린다 — 빈 목록 폴백은 "인력이 없다"로 오인된다 (절대 규칙 5)
    const [settings, members] = await Promise.all([
      settingsRepo.getSettings(client),
      membersRepo.listAllMembers(client),
    ]);
    return {
      ok: true,
      data: {
        settings,
        memberOptions: members.map((m) => ({
          id: m.id,
          name: m.name,
          orgName: m.orgName,
          active: m.active,
        })),
      },
    };
  } catch (e) {
    return toFailure(e);
  }
}

// ─── 갱신 (§9 updateSettings) ─────────────────────────────────────────────────

// O-1: 팀 설정 폼은 6필드를 한 번에 저장하므로 낙관적 잠금이 필수다. SA-2의 "선택 인자"와 달리
// expectedVersion을 필수로 받는다 — 이 액션의 유일한 호출자가 그 다중 필드 폼이라, 잠금을
// 생략할 수 있게 열어두면 팀 공유 설정이 남의 저장을 조용히 덮어쓴다.
export async function updateSettings(
  patch: unknown,
  expectedVersion: number
): Promise<ActionResult<SettingsRecord>> {
  let client: SupabaseClient | undefined;
  try {
    rejectGuardedFields(patch);
    const parsed = parseOrThrow(settingsPatchSchema, patch, '설정 값이 올바르지 않습니다.');
    // 리포지토리는 updatedBy를 patch에 담아 받으므로 "빈 patch" 판정을 여기서 한다 —
    // 그러지 않으면 아무 내용도 없는 저장이 version만 올려 남의 편집을 STALE로 만든다
    if (Object.keys(parsed).length === 0) {
      throw new ValidationError('변경할 내용이 없습니다.');
    }
    const version = parseOrThrow(
      expectedVersionSchema,
      expectedVersion,
      '설정 버전이 올바르지 않습니다.'
    );

    const ctx = await requireApprovedUser();
    client = ctx.client;

    const updated = await settingsRepo.updateSettings(
      client,
      { ...parsed, updatedBy: ctx.user.id },
      version
    );

    // 팀 설정은 화면 하나에만 쓰이지 않는다. dueSoonDays는 대시보드 마감 임박·오늘의 To-Do와
    // Task/마일스톤 마감 판정(§6.5, §7.2, §7.13 T-D4), progressWeightBasis는 4단계 진척률
    // 가중(§6.1 ③④ P-9 — 과제 목록·개요·대시보드·WBS), currencyUnit은 연구비 표시(§7.9),
    // defaultGanttScale·weekStartsOn은 간트 눈금(§7.5)에 각각 즉시 영향을 준다.
    // 영향 경로를 일일이 열거하면 화면이 늘어날 때마다 빠뜨리므로 레이아웃 전체를 무효화한다.
    revalidatePath('/', 'layout');
    return { ok: true, data: updated };
  } catch (e) {
    return toFailure(e, client);
  }
}
