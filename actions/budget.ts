'use server';

// Budget 서버 액션 — 제안 모드 계획액 편집 (SOT §9 Budget, SA-1~SA-4, §5.12, §6.4 B-3·B-4, §8.4 O-1~O-3)
// 반환은 ActionResult<T> — 예외를 그대로 던지지 않는다. supabase 직접 호출 금지,
// 반드시 lib/db/ 리포지토리를 거친다 (§8.6).
//
// 연구비 페이지 조회는 actions/budget-plan.ts의 getBudgetPlanData 한 벌이다 (Phase 23 S-5).

import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { ActionResult, BudgetItem } from '@/types';
import { requireApprovedUser } from '@/lib/auth/guard';
import * as appUsers from '@/lib/db/app-users';
import * as budgetItemsRepo from '@/lib/db/budget-items';
import {
  RuleViolationError,
  StaleDataError,
  ValidationError,
  toActionFailure,
} from '@/lib/db/errors';
import { budgetCategorySchema } from '@/lib/db/schema';

// ─── 입력 검증 ────────────────────────────────────────────────────────────────

const uuidSchema = z.uuid();

// §5.12 + B-4: 금액은 원 단위 정수다. 계획액(현금/현물 포함)은 0 이상만 받는다.
const amountSchema = z
  .int('금액은 원 단위 정수로 입력하세요.')
  .min(0, '금액은 0 이상이어야 합니다.');

function parseOrThrow<T>(schema: z.ZodType<T>, value: unknown, fallback: string): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    throw new ValidationError(parsed.error.issues[0]?.message ?? fallback);
  }
  return parsed.data;
}

// §5.12: plannedAmount = cashAmount + inKindAmount. DB에 check 제약이 없어 앱이 지킨다.
// 현금/현물이 둘 다 null이면 "분리 미입력"이므로 계획액을 그대로 받는다 (S-4와 같은 취급).
// 하나라도 들어오면 나머지를 0으로 보고 합계를 강제한다. 차액을 서버가 임의 배분하지 않는다 —
// 배분 규칙이 SOT에 없고, 지어내면 사용자가 입력하지 않은 금액이 저장된다.
function assertPlanSplit(
  plannedAmount: number,
  cashAmount: number | null,
  inKindAmount: number | null
): void {
  if (cashAmount === null && inKindAmount === null) return;
  if ((cashAmount ?? 0) + (inKindAmount ?? 0) !== plannedAmount) {
    throw new ValidationError('현금과 현물의 합이 계획액과 같아야 합니다.');
  }
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
      console.error('[actions/budget] 수정자 이름 조회 실패:', lookupError);
    }
  }
  return toActionFailure(e);
}

// 대시보드(§7.2)·과제 개요(§7.3)도 같은 과제의 연구비 행을 읽을 수 있다 —
// 경로 단위 캐시라 연구비 화면만 다시 그리면 옛 값이 남는다
function revalidateBudget(projectId: string): void {
  revalidatePath('/');
  revalidatePath(`/projects/${projectId}`);
  revalidatePath(`/projects/${projectId}/budget`);
}

// ─── 예산 계획 (§5.12, §9 updateBudgetPlan) ───────────────────────────────────

// (yearId, category)가 유일 키라 id가 아니라 이 조합으로 갱신한다 (§5.12).
// O-1: 계획액·현금·현물을 한 번에 바꾸는 셀 편집이므로 expectedVersion을 받아 잠금을 건다.
export async function updateBudgetPlan(
  yearId: string,
  category: unknown,
  plannedAmount: unknown,
  cashAmount: unknown,
  inKindAmount: unknown,
  expectedVersion?: number
): Promise<ActionResult<BudgetItem>> {
  let client: SupabaseClient | undefined;
  try {
    const yid = parseOrThrow(uuidSchema, yearId, '연차 ID 형식이 올바르지 않습니다.');
    const cat = parseOrThrow(budgetCategorySchema, category, '비목 값이 올바르지 않습니다.');
    const planned = parseOrThrow(amountSchema, plannedAmount, '계획액이 올바르지 않습니다.');
    const cash = parseOrThrow(amountSchema.nullable(), cashAmount, '현금액이 올바르지 않습니다.');
    const inKind = parseOrThrow(amountSchema.nullable(), inKindAmount, '현물액이 올바르지 않습니다.');
    assertPlanSplit(planned, cash, inKind);

    const ctx = await requireApprovedUser();
    client = ctx.client;

    // PL-9: 산출근거가 있는 셀의 계획액은 사람이 입력하는 값이 아니라 내역 합계다
    // (§5.12 "계획액의 소유권"). 저장을 허용하면 화면은 산출 행을 그대로 보여주는데
    // 총액만 다른 숫자가 되고, RPC가 다음 편집에서 그 값을 덮어 입력이 조용히 사라진다.
    if ((await budgetItemsRepo.getCellDetailCount(client, yid, cat)) > 0) {
      throw new RuleViolationError(
        '산출근거가 있는 셀은 내역 합계로 확정됩니다. 산출근거 패널에서 수정하세요.'
      );
    }

    const updated = await budgetItemsRepo.updateBudgetPlan(
      client,
      yid,
      cat,
      {
        plannedAmount: planned,
        cashAmount: cash,
        inKindAmount: inKind,
        updatedBy: ctx.user.id,
      },
      expectedVersion
    );

    revalidateBudget(updated.projectId);
    return { ok: true, data: updated };
  } catch (e) {
    return toFailure(e, client);
  }
}
