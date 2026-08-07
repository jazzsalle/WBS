'use server';

// Budget 서버 액션 + 연구비 매트릭스 조회
// (SOT §9 Budget·조회 목록, SA-1~SA-4, §5.12, §6.4, §8.4 O-1~O-3)
// 반환은 ActionResult<T> — 예외를 그대로 던지지 않는다. supabase 직접 호출 금지,
// 반드시 lib/db/ 리포지토리를 거친다 (§8.6).
//
// 집행액·집행률·잔액은 파생 값이라 저장하지 않는다 (O-4, B-4). 계산은 전부 lib/budget.ts가 하고
// 여기서는 나눗셈·비율 공식을 다시 쓰지 않는다 — 규칙이 두 곳에 생기면 반드시 어긋난다.

import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { ActionResult, BudgetExecution, BudgetItem, Settings, Year } from '@/types';
import { requireApprovedUser } from '@/lib/auth/guard';
import * as appUsers from '@/lib/db/app-users';
import * as budgetItemsRepo from '@/lib/db/budget-items';
import * as projectsRepo from '@/lib/db/projects';
import * as settingsRepo from '@/lib/db/settings';
import * as yearsRepo from '@/lib/db/years';
import { StaleDataError, ValidationError, toActionFailure } from '@/lib/db/errors';
import { budgetCategorySchema } from '@/lib/db/schema';
import { buildBudgetMatrix, type BudgetMatrix, type YearBudgetMismatch } from '@/lib/budget';
import { todayISO } from '@/lib/dates';

// ─── 조회 모델 (§9 getBudgetMatrix, §7.9) ─────────────────────────────────────

// 매트릭스는 행 = 비목 12종, 열 = 연차다 (§7.9). 셀·합계·경고는 전부 계산 값이라 DB에 없다.
// 표시 단위 환산은 화면(lib/currency.ts)의 몫이므로 금액은 원 단위 정수 그대로 내린다 (B-4).
export interface BudgetMatrixData {
  projectId: string;
  /** 인쇄 머리말(§12 P-R3)에 쓴다 — 종이만 보고 어느 과제인지 알 수 있어야 한다 */
  projectName: string;
  /** 인쇄 출력일(§12 P-R3). 서버가 Asia/Seoul 달력으로 만든다 (§6.5) */
  todayISO: string;
  years: Year[];
  matrix: BudgetMatrix;
  /** B-3: 키는 yearId. year.budget이 null이면 비교 대상이 없어 null (배지를 띄우지 않는다) */
  yearBudgetChecks: Record<string, YearBudgetMismatch | null>;
  currencyUnit: Settings['currencyUnit'];
}

// ─── 입력 검증 ────────────────────────────────────────────────────────────────

const uuidSchema = z.uuid();

// §5.12 집행일은 'YYYY-MM-DD' 필수다 — 날짜 없는 집행은 연차·기간 귀속을 판정할 수 없다
const isoDateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "날짜는 'YYYY-MM-DD' 형식이어야 합니다.");

// §5.12 + B-4: 금액은 원 단위 정수다. 음수를 막는 근거는 §5.12 주석 —
// "실무에서 집행액을 음수로 잡는 경우가 없다(사용자 확인). 환불·감액은 별도 행이 아니라
// 원래 집행 행을 수정한다." 계획액(현금/현물 포함)도 같은 규칙을 따른다.
const amountSchema = z
  .int('금액은 원 단위 정수로 입력하세요.')
  .min(0, '금액은 0 이상이어야 합니다.');

// 적요는 목록에서 한 줄로 식별하는 라벨이라 제목과 같은 상한을 쓴다 (milestones.ts 관례)
const descriptionSchema = z.string().trim().max(200, '적요는 200자 이내여야 합니다.');
const noteSchema = z.string().max(10_000);

const executionFieldsSchema = z.object({
  date: isoDateSchema,
  amount: amountSchema,
  description: descriptionSchema,
  note: noteSchema,
});

// date는 DB에 기본값이 없고(not null), amount 없는 집행은 집행액 합계(§6.4)에 아무 의미가 없다 —
// 둘은 생성 시 반드시 받는다. 적요·비고는 생략 가능하다 (N-11 미입력 = 빈 문자열).
const executionCreateSchema = executionFieldsSchema.partial().extend({
  date: executionFieldsSchema.shape.date,
  amount: executionFieldsSchema.shape.amount,
});

const executionPatchSchema = executionFieldsSchema.partial();

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

// 집행률은 대시보드 과제 카드(§7.2)와 과제 개요(§7.3)에도 나온다 —
// 연구비 화면만 다시 그리면 부족하다
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

// ─── 집행 내역 (§5.12 budget_executions, §9 add/update/deleteExecution) ───────

export async function addExecution(
  budgetItemId: string,
  input: unknown
): Promise<ActionResult<BudgetExecution>> {
  try {
    const bid = parseOrThrow(uuidSchema, budgetItemId, '비목 ID 형식이 올바르지 않습니다.');
    const fields = parseOrThrow(executionCreateSchema, input, '집행 정보가 올바르지 않습니다.');
    const { user, client } = await requireApprovedUser();

    // 화면 갱신 대상 과제를 알아야 하고, 없는 비목은 삽입보다 먼저 NotFound로 걸러진다
    const item = await budgetItemsRepo.getBudgetItemById(client, bid);

    const created = await budgetItemsRepo.addExecution(
      client,
      bid,
      {
        date: fields.date,
        amount: fields.amount,
        description: fields.description ?? '',
        note: fields.note ?? '',
        createdBy: user.id,
        updatedBy: user.id,
      }
    );

    revalidateBudget(item.projectId);
    return { ok: true, data: created };
  } catch (e) {
    return toFailure(e);
  }
}

// O-1: 집행 편집 폼은 일자·금액·적요를 한 번에 바꾸므로 expectedVersion을 받아 잠금을 건다 (§5.12).
// 감액·환불도 별도 행이 아니라 이 수정으로 처리하므로 동시 편집이 실제로 발생한다.
export async function updateExecution(
  budgetItemId: string,
  executionId: string,
  patch: unknown,
  expectedVersion?: number
): Promise<ActionResult<BudgetExecution>> {
  let client: SupabaseClient | undefined;
  try {
    const bid = parseOrThrow(uuidSchema, budgetItemId, '비목 ID 형식이 올바르지 않습니다.');
    const eid = parseOrThrow(uuidSchema, executionId, '집행 ID 형식이 올바르지 않습니다.');
    const parsed = parseOrThrow(executionPatchSchema, patch, '집행 정보가 올바르지 않습니다.');
    const ctx = await requireApprovedUser();
    client = ctx.client;

    const item = await budgetItemsRepo.getBudgetItemById(client, bid);

    // 다른 비목의 집행을 가리키면 리포지토리가 0행 갱신 → NotFound로 구분해 던진다
    const updated = await budgetItemsRepo.updateExecution(
      client,
      bid,
      eid,
      { ...parsed, updatedBy: ctx.user.id },
      expectedVersion
    );

    revalidateBudget(item.projectId);
    return { ok: true, data: updated };
  } catch (e) {
    return toFailure(e, client);
  }
}

export async function deleteExecution(
  budgetItemId: string,
  executionId: string
): Promise<ActionResult<null>> {
  try {
    const bid = parseOrThrow(uuidSchema, budgetItemId, '비목 ID 형식이 올바르지 않습니다.');
    const eid = parseOrThrow(uuidSchema, executionId, '집행 ID 형식이 올바르지 않습니다.');
    const { client } = await requireApprovedUser();

    // 삭제 후에는 projectId를 알 수 없으므로 먼저 읽는다 (없으면 NotFoundError)
    const item = await budgetItemsRepo.getBudgetItemById(client, bid);
    await budgetItemsRepo.removeExecution(client, bid, eid);

    revalidateBudget(item.projectId);
    return { ok: true, data: null };
  } catch (e) {
    return toFailure(e);
  }
}

// ─── 조회 (§9 조회 목록 — 서버 컴포넌트에서 직접 호출) ────────────────────────

export async function getBudgetMatrix(projectId: string): Promise<ActionResult<BudgetMatrixData>> {
  try {
    const pid = parseOrThrow(uuidSchema, projectId, '과제 ID 형식이 올바르지 않습니다.');
    const { client } = await requireApprovedUser();

    // 하나라도 실패하면 실패를 그대로 올린다 — 빈 배열 폴백은 데이터 손상을 감춘다 (절대 규칙 5).
    // 특히 비목 조회가 부분 실패한 채 매트릭스를 그리면 집행률이 조용히 낮게 나온다.
    const [project, years, items, settings] = await Promise.all([
      // 인쇄 머리말용 과제명 (§12 P-R3). 조회 실패는 그대로 올린다 — 화면은 어차피 실패다
      projectsRepo.getProjectById(client, pid),
      yearsRepo.listYears(client, pid),
      budgetItemsRepo.listBudgetItemsByProject(client, pid),
      settingsRepo.getSettings(client),
    ]);

    // 집계·B-3 판정은 전부 lib/budget.ts가 한다 (§6.4). 여기서 비율을 다시 계산하지 않는다
    const matrix = buildBudgetMatrix(years, items);

    // 열 순서(order asc)는 buildBudgetMatrix가 고정한다 — 화면이 두 배열을 각자 정렬하지 않도록
    // years도 같은 순서로 내린다
    const yearById = new Map(years.map((year) => [year.id, year]));
    const orderedYears = matrix.columns
      .map((column) => yearById.get(column.yearId))
      .filter((year): year is Year => year !== undefined);

    const yearBudgetChecks: Record<string, YearBudgetMismatch | null> = {};
    for (const column of matrix.columns) {
      yearBudgetChecks[column.yearId] = column.mismatch;
    }

    return {
      ok: true,
      data: {
        projectId: pid,
        projectName: project.name,
        todayISO: todayISO(new Date()), // §6.5 기준일 — Asia/Seoul 달력
        years: orderedYears,
        matrix,
        yearBudgetChecks,
        currencyUnit: settings.currencyUnit,
      },
    };
  } catch (e) {
    return toFailure(e);
  }
}
