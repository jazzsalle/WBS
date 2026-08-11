'use server';

// Budget Plan(산출근거) 서버 액션 + 제안 모드 조회
// (SOT §9 Budget Plan·조회, SA-1~SA-4, §5.17 PL-D1~PL-D8, §6.10, §7.9·§7.9.2, §8.4 O-1~O-3)
// 반환은 ActionResult<T> — 예외를 그대로 던지지 않는다. supabase 직접 호출 금지,
// 반드시 lib/db/ 리포지토리를 거친다 (§8.6).
//
// 이 파일이 지키는 두 가지 소유권 규칙:
//  1. PL-D7·PL-10a — `amount`는 **여기서** lib/budget-plan.ts로 계산해 RPC에 넘긴다.
//     클라이언트가 보낸 amount는 Zod 스키마에서 잘려 나가고, DB에 저장된 amount도 믿지 않는다.
//     화면이 금액을 지어낼 수 있으면 산출근거가 근거가 아니게 된다.
//  2. PL-10 — 행을 건드린 뒤 budget_items를 다시 계산하는 일은 RPC(트랜잭션) 안에 있다.
//     여기서 budget_items를 직접 갱신하지 않는다. 액션이 두 번 쓰면 사이에서 실패했을 때
//     총액이 근거와 어긋난 채 남는다.
//
// 산식·비율 공식은 lib/budget-plan.ts에만 있다 (O-4). 여기서 다시 쓰지 않는다.

import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import type { SupabaseClient } from '@supabase/supabase-js';
import type {
  ActionResult,
  BudgetCategory,
  BudgetDetail,
  BudgetItem,
  DetailFormula,
  Member,
  Project,
  Settings,
  Year,
} from '@/types';
import { requireApprovedUser } from '@/lib/auth/guard';
import * as appUsers from '@/lib/db/app-users';
import * as budgetDetailsRepo from '@/lib/db/budget-details';
import * as budgetItemsRepo from '@/lib/db/budget-items';
import * as membersRepo from '@/lib/db/members';
import * as projectsRepo from '@/lib/db/projects';
import * as settingsRepo from '@/lib/db/settings';
import * as yearsRepo from '@/lib/db/years';
import {
  RuleViolationError,
  StaleDataError,
  ValidationError,
  toActionFailure,
} from '@/lib/db/errors';
import { budgetCategorySchema, detailFormulaSchema, detailAxisSchema } from '@/lib/db/schema';
import { BUDGET_CATEGORY_ORDER, SUBCATEGORY_PRESETS } from '@/lib/constants';
import { buildBudgetMatrix, type BudgetMatrix, type YearBudgetMismatch } from '@/lib/budget';
import {
  aggregateDetails,
  buildYearTotals,
  computeAxisSplit,
  computeDetailAmount,
  evaluateBudgetRules,
  type BudgetRuleEvaluation,
  type CellTotal,
  type DetailAmountResult,
  type PlanAmounts,
  type SubcategoryTotal,
  type YearAxisSplit,
  type YearTotalSource,
} from '@/lib/budget-plan';
import { todayISO } from '@/lib/dates';

// ─── 조회 모델 (§9 getBudgetPlanData / getBudgetDetails, §7.9·§7.9.2) ─────────

/** budget_items에 저장된 계획액. 잠긴 셀에서는 산출근거 합계와 같아야 한다 (PL-10) */
export interface SavedPlanAmounts {
  plannedAmount: number;
  /** S-4: 현금/현물 분리가 없는 셀은 null이다 — 0과 구분한다 */
  cashAmount: number | null;
  inKindAmount: number | null;
}

/** 매트릭스 셀 하나가 제안 모드에서 필요로 하는 전부. 화면은 표시만 한다 */
export interface BudgetPlanCellView {
  yearId: string;
  category: BudgetCategory;
  /** PL-9: 0이 아니면 매트릭스에서 직접 편집할 수 없다(자물쇠). 클릭하면 산출근거 패널이 열린다 */
  detailCount: number;
  locked: boolean;
  /** PL-6~PL-8 산출근거 합계. detailCount가 0이면 세 값 모두 0이다 */
  total: PlanAmounts;
  saved: SavedPlanAmounts;
  /**
   * PL-10 불변식 위반 — 저장된 계획액이 산출근거 합계와 다르다.
   * 정상 경로에서는 발생할 수 없다(RPC가 같은 트랜잭션에서 맞춘다). 조용히 감추지 않는다 (절대 규칙 5)
   */
  mismatch: boolean;
  /** PL-5 음수 행 수. 0이 아니면 합계를 그대로 믿으면 안 된다 */
  negativeCount: number;
  /** 연봉 미입력으로 0원 처리된 인건비 행 수 (§7.9.2 경고) */
  missingSalaryCount: number;
  /** PL-6 세목 소계. 부록 A.5 프리셋 순서 */
  subcategories: SubcategoryTotal[];
}

/** PL-11~PL-13 지침 검증 줄 (연차별). 한도가 null이면 비율만 나오고 배지는 없다 (PL-15) */
export interface BudgetPlanYearView {
  yearId: string;
  rules: BudgetRuleEvaluation;
}

/**
 * §7.9 제안 모드 하단 '현금/현물 비중' (연차별).
 * 비중은 여기서(서버에서) 나온 값이다 — 화면에는 나눗셈이 없다 (O-4).
 */
export interface BudgetPlanYearAxisView {
  yearId: string;
  axis: YearAxisSplit;
}

export interface BudgetPlanData {
  projectId: string;
  /** 인쇄 머리말(§12 P-R3)에 쓴다 — 종이만 보고 어느 과제인지 알 수 있어야 한다 */
  projectName: string;
  todayISO: string;
  /** matrix.columns와 같은 순서 */
  years: Year[];
  /**
   * 제안 모드가 그리는 매트릭스 (§7.9). 계획액·집행액은 여기서 읽는다.
   * 수행 조회(getBudgetMatrix)의 매트릭스와 **같은 표지만 같은 시점은 아니다** — 두 조회는
   * 트랜잭션이 아니므로 제안 모드는 이 한 벌만 본다 (아래 items·yearBudgetChecks도 같은 이유다)
   */
  matrix: BudgetMatrix;
  /** columns × BUDGET_CATEGORY_ORDER 전 조합. 비어 있는 셀도 담는다 (화면이 폴백 분기를 만들지 않게) */
  cells: BudgetPlanCellView[];
  /**
   * 위 matrix·cells를 만든 **바로 그** 원본 행. 제안 모드 매트릭스의 셀 잠금이 이걸로 갈린다:
   * PL-9(detailCount > 0), S-4(현금·현물 분리 입력), 그리고 행이 없거나 2개 이상인 어긋난 상태.
   *
   * `cells`로는 그 판정을 낼 수 없다 — cells는 (연차 × 12비목) 전 조합을 채우므로 "행이 없는 셀"을
   * 0원 셀과 구분하지 못하고, (연차, 비목) Map으로 접히므로 중복 행도 보이지 않는다.
   *
   * 수행 조회의 items를 빌려 쓰지 않는 이유는 왕복 절약이 아니라 **시점의 일치**다. 두 스냅샷을
   * 한 표에 섞으면 옛 금액에 새 잠금이 걸린다 (BudgetMatrixData.items의 같은 주석 참고).
   */
  items: BudgetItem[];
  /** B-3: matrix.columns의 mismatch를 yearId로 색인한 것. year.budget이 null이면 값도 null이다 */
  yearBudgetChecks: Record<string, YearBudgetMismatch | null>;
  yearRules: BudgetPlanYearView[];
  /** yearRules와 **같은 소스**로 만든 연차별 축 합계. 순서도 matrix.columns와 같다 */
  yearAxisSplits: BudgetPlanYearAxisView[];
  /** 과제 전체 산출근거 합계 (PL-7) */
  detailTotal: PlanAmounts;
  detailCount: number;
  negativeCount: number;
  missingSalaryCount: number;
  /** 0이 아니면 PL-10 불변식이 깨진 셀이 있다는 뜻이다 */
  mismatchCount: number;
  /** PL-14 한도. setBudgetRateLimits의 O-1 잠금에 projectVersion을 쓴다 */
  allowanceRateLimit: number | null;
  indirectRateLimit: number | null;
  projectVersion: number;
  currencyUnit: Settings['currencyUnit'];
}

/** 산출 행 하나 + 서버가 계산한 금액. 화면은 산식을 다시 구현하지 않는다 (§9 조회 주석, O-4) */
export interface BudgetDetailRowView {
  detail: BudgetDetail;
  /** PL-1~PL-4. 저장된 detail.amount가 아니라 근거로 다시 계산한 값이다 (PL-D7) */
  computed: DetailAmountResult;
}

export interface BudgetDetailsData {
  projectId: string;
  yearId: string;
  category: BudgetCategory;
  /** 세목 → order 순 (리포지토리 정렬). 세목 나열 순서는 부록 A.5 프리셋을 화면이 따른다 */
  rows: BudgetDetailRowView[];
  subcategories: SubcategoryTotal[];
  /** 셀 합계(현금 / 현물 / 계) — 매트릭스 셀에 그대로 올라가는 값 (§7.9.2 하단) */
  total: PlanAmounts;
  negativeCount: number;
  missingSalaryCount: number;
  /** §7.9.2 인력 드롭다운 + "연봉 미입력" 경고의 원본 (이름·직위·연봉·hireType) */
  members: Member[];
}

// ─── 입력 검증 (§5.17 PL-D1~PL-D5) ───────────────────────────────────────────

const uuidSchema = z.uuid();
const orderedIdsSchema = z.array(z.uuid());

// PL-D5: 단가는 0 이상. 금액은 원 단위 정수다 (절대 규칙 4)
const unitPriceSchema = z
  .int('단가는 원 단위 정수로 입력하세요.')
  .min(0, '단가는 0 이상이어야 합니다.');

// PL-D5의 유일한 예외 — 조정액만 음수를 허용한다 (서식의 절사·미세조정용)
const adjustmentSchema = z.int('조정액은 원 단위 정수로 입력하세요.');

// PL-3: 인자 값은 소수를 허용한다(참여율 10.0, 참여기간 8). 음수는 금액을 뒤집으므로 막는다
const factorSchema = z.object({
  label: z.string().trim().max(20, '인자 라벨은 20자 이내여야 합니다.'),
  value: z
    .number()
    .finite('인자 값이 올바르지 않습니다.')
    .min(0, '인자 값은 0 이상이어야 합니다.'),
  isPercent: z.boolean(),
});

// §5.17: 0~3개. 실측 서식의 최대 열 수(단가 × 인자 3)를 넘는 입력은 서식 오해이지 데이터가 아니다
const factorsSchema = z.array(factorSchema).max(3, '인자는 3개까지 넣을 수 있습니다.');

const nameSchema = z.string().trim().max(200, '품명은 200자 이내여야 합니다.');
const textSchema = z.string().max(10_000);

// PL-D7: `amount`가 여기 없는 것이 핵심이다. z.object는 모르는 키를 잘라내므로
// 클라이언트가 amount를 실어 보내도 RPC까지 가지 않는다 — 금액은 항상 서버가 계산한다.
const detailFieldsSchema = z.object({
  axis: detailAxisSchema,
  formula: detailFormulaSchema,
  memberId: z.uuid('인력 ID 형식이 올바르지 않습니다.').nullable(),
  name: nameSchema,
  unitPrice: unitPriceSchema,
  spec: textSchema,
  factors: factorsSchema,
  adjustment: adjustmentSchema,
  note: textSchema,
});

// axis만 생성 시 필수다 — 축이 없으면 합계를 현금/현물로 나눌 수 없고(§5.17), 서버가
// 한쪽으로 지어내면 사용자가 입력한 적 없는 축에 금액이 쌓인다.
// formula는 PL-D3이 category로부터 완전히 결정하므로 생략을 허용한다(어긋나면 거부).
const detailCreateSchema = detailFieldsSchema.partial().extend({
  axis: detailFieldsSchema.shape.axis,
});

// 세목·연차·비목은 patch에 없다: 세목을 넘는 이동은 없고(§7.9.2), 셀 이동은 제안 화면의
// 조작이 아니다. order도 없다 — 순서는 reorderBudgetDetails가 소유한다 (X-3)
const detailPatchSchema = detailFieldsSchema.partial();

// PL-14: 백분율 한도값. null은 "검사하지 않는다"는 뜻이라 0과 구분해 그대로 저장한다
const rateLimitSchema = z
  .number()
  .finite('한도율이 올바르지 않습니다.')
  .min(0, '한도율은 0 이상이어야 합니다.')
  .max(100, '한도율은 100 이하여야 합니다.')
  .nullable();

const rateLimitsSchema = z
  .object({
    allowanceRateLimit: rateLimitSchema,
    indirectRateLimit: rateLimitSchema,
  })
  .partial();

function parseOrThrow<T>(schema: z.ZodType<T>, value: unknown, fallback: string): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    throw new ValidationError(parsed.error.issues[0]?.message ?? fallback);
  }
  return parsed.data;
}

// O-3: 낙관적 잠금 실패는 "누가 먼저 고쳤는지"까지 알려야 사용자가 판단할 수 있다 (actions/budget.ts와 같은 방식).
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
      console.error('[actions/budget-plan] 수정자 이름 조회 실패:', lookupError);
    }
  }
  return toActionFailure(e);
}

// 계획액은 대시보드 과제 카드(§7.2)와 과제 개요(§7.3)에도 나온다 —
// actions/budget.ts의 revalidateBudget와 같은 대상이어야 화면마다 다른 예산이 보이지 않는다
function revalidateBudget(projectId: string): void {
  revalidatePath('/');
  revalidatePath(`/projects/${projectId}`);
  revalidatePath(`/projects/${projectId}/budget`);
}

// ─── 규칙 검증 (PL-D1~PL-D4, N-13) ───────────────────────────────────────────

// PL-D3: 인건비 셀에 단가 행이 섞이면 §6.10.3 검증의 기준액이 흔들린다
const PERSONNEL_CATEGORIES: readonly BudgetCategory[] = ['personnel', 'student_personnel'];

function formulaFor(category: BudgetCategory): DetailFormula {
  return PERSONNEL_CATEGORIES.includes(category) ? 'personnel' : 'quantity';
}

function assertFormula(category: BudgetCategory, formula: DetailFormula | undefined): DetailFormula {
  const expected = formulaFor(category);
  if (formula !== undefined && formula !== expected) {
    throw new ValidationError(
      '인건비·학생인건비는 인건비 산식만, 나머지 비목은 수량 산식만 허용합니다.'
    );
  }
  return expected;
}

// PL-D4: 자유 문자열을 허용하면 세목이 오타로 갈라져 소계가 어긋난다.
// 실무에서 새 세목이 나타나면 부록 A.5(lib/constants.ts)를 먼저 고친다
function assertSubcategory(category: BudgetCategory, subcategory: string): string {
  if (!SUBCATEGORY_PRESETS[category].some((def) => def.code === subcategory)) {
    throw new ValidationError('이 비목에 없는 세목입니다.');
  }
  return subcategory;
}

// PL-D1: personnel이면 memberId가 필수이고, quantity면 null이어야 한다
function assertMemberRef(formula: DetailFormula, memberId: string | null): void {
  if (formula === 'personnel' && memberId === null) {
    throw new ValidationError('인건비 산출근거에는 참여인력을 지정하세요.');
  }
  if (formula === 'quantity' && memberId !== null) {
    throw new ValidationError('수량 산식 산출근거에는 참여인력을 지정할 수 없습니다.');
  }
}

/**
 * PL-D2·N-13: 그 과제의 인력인지 액션에서도 확인한다. FK는 "존재하는 인력"만 보장한다.
 * RPC도 같은 검사를 하지만(이중 방어), 단가(연봉)를 여기서 읽어야 amount를 계산할 수 있다.
 */
async function loadProjectMember(
  client: SupabaseClient,
  projectId: string,
  memberId: string
): Promise<Member> {
  const member = (await membersRepo.listMembers(client, projectId)).find((m) => m.id === memberId);
  if (!member) {
    throw new RuleViolationError('이 과제에 속하지 않은 인력은 산출근거에 지정할 수 없습니다.');
  }
  return member;
}

/** PL-D2·N-13: yearId가 그 과제 소속인지. 연차에서 과제를 얻는 것이 곧 검증이다 */
async function loadYear(client: SupabaseClient, yearId: string): Promise<Year> {
  return yearsRepo.getYearById(client, yearId);
}

// ─── 쓰기 액션 (§9 Budget Plan) ──────────────────────────────────────────────

/**
 * 산출 행 추가. RPC가 같은 트랜잭션에서 budget_items를 다시 계산한다 (PL-10).
 * `input.amount`는 무시된다 — 금액은 아래에서 계산한다 (PL-D7).
 */
export async function createBudgetDetail(
  yearId: string,
  category: unknown,
  subcategory: unknown,
  input: unknown
): Promise<ActionResult<BudgetDetail>> {
  let client: SupabaseClient | undefined;
  try {
    const yid = parseOrThrow(uuidSchema, yearId, '연차 ID 형식이 올바르지 않습니다.');
    const cat = parseOrThrow(budgetCategorySchema, category, '비목 값이 올바르지 않습니다.');
    const sub = parseOrThrow(z.string(), subcategory, '세목 값이 올바르지 않습니다.');
    const fields = parseOrThrow(detailCreateSchema, input, '산출근거 정보가 올바르지 않습니다.');

    const ctx = await requireApprovedUser();
    client = ctx.client;

    assertSubcategory(cat, sub);
    const formula = assertFormula(cat, fields.formula);
    const memberId = fields.memberId ?? null;
    assertMemberRef(formula, memberId);

    const year = await loadYear(client, yid);
    const member = memberId === null ? null : await loadProjectMember(client, year.projectId, memberId);

    // PL-D1: personnel 행의 품명·단가는 무시한다 — 단가의 유일한 출처는 Member.annualSalary다.
    // 빈 값으로 정규화해 두어야 표시가 "쓰이지 않는 숫자"를 보여주지 않는다
    const isPersonnel = formula === 'personnel';
    const unitPrice = isPersonnel ? 0 : (fields.unitPrice ?? 0);
    const name = isPersonnel ? '' : (fields.name ?? '');
    const factors = fields.factors ?? [];
    const adjustment = fields.adjustment ?? 0;

    // 새 행은 그 세목의 맨 끝에 붙인다 (order는 세목 안에서의 순서다, §5.17)
    const siblings = (await budgetDetailsRepo.listByCell(client, yid, cat)).filter(
      (d) => d.subcategory === sub
    );
    const order = siblings.reduce((max, d) => Math.max(max, d.order + 1), 0);

    const { amount } = computeDetailAmount(
      {
        yearId: yid,
        category: cat,
        subcategory: sub,
        axis: fields.axis,
        formula,
        memberId,
        unitPrice,
        adjustment,
        factors,
      },
      member
    );

    const created = await budgetDetailsRepo.upsertDetail(client, {
      projectId: year.projectId,
      yearId: yid,
      category: cat,
      subcategory: sub,
      axis: fields.axis,
      formula,
      memberId,
      name,
      unitPrice,
      spec: fields.spec ?? '',
      factors,
      adjustment,
      note: fields.note ?? '',
      order,
      amount, // PL-10a: RPC는 더하기만 한다
    });

    revalidateBudget(year.projectId);
    return { ok: true, data: created };
  } catch (e) {
    return toFailure(e, client);
  }
}

/**
 * 산출 행 수정. O-1: 단가·인자·조정액을 한 번에 바꾸므로 expectedVersion을 받는다.
 *
 * 부분 patch를 받지만 RPC에는 행 전체를 넘긴다 — PL-D7이 "근거 필드가 바뀌면 amount도
 * 반드시 같은 쓰기에서 다시 계산된다"를 요구하므로, 저장된 행과 patch를 여기서 합친 뒤
 * 합친 값으로 금액을 다시 계산한다. 저장된 amount는 읽지 않는다.
 */
export async function updateBudgetDetail(
  id: string,
  patch: unknown,
  expectedVersion?: number
): Promise<ActionResult<BudgetDetail>> {
  let client: SupabaseClient | undefined;
  try {
    const did = parseOrThrow(uuidSchema, id, '산출근거 ID 형식이 올바르지 않습니다.');
    const fields = parseOrThrow(detailPatchSchema, patch, '산출근거 정보가 올바르지 않습니다.');

    const ctx = await requireApprovedUser();
    client = ctx.client;

    const current = await budgetDetailsRepo.getDetailById(client, did);
    const formula = assertFormula(current.category, fields.formula);
    const memberId = fields.memberId === undefined ? current.memberId : fields.memberId;
    assertMemberRef(formula, memberId);

    const member =
      memberId === null ? null : await loadProjectMember(client, current.projectId, memberId);

    const isPersonnel = formula === 'personnel';
    const unitPrice = isPersonnel ? 0 : (fields.unitPrice ?? current.unitPrice);
    const name = isPersonnel ? '' : (fields.name ?? current.name);
    const axis = fields.axis ?? current.axis;
    const factors = fields.factors ?? current.factors;
    const adjustment = fields.adjustment ?? current.adjustment;

    const { amount } = computeDetailAmount(
      {
        yearId: current.yearId,
        category: current.category,
        subcategory: current.subcategory,
        axis,
        formula,
        memberId,
        unitPrice,
        adjustment,
        factors,
      },
      member
    );

    const updated = await budgetDetailsRepo.upsertDetail(
      client,
      {
        id: current.id,
        projectId: current.projectId,
        yearId: current.yearId,
        category: current.category,
        subcategory: current.subcategory,
        axis,
        formula,
        memberId,
        name,
        unitPrice,
        spec: fields.spec ?? current.spec,
        factors,
        adjustment,
        note: fields.note ?? current.note,
        order: current.order, // 순서는 reorderBudgetDetails만 바꾼다
        amount,
      },
      expectedVersion
    );

    revalidateBudget(current.projectId);
    return { ok: true, data: updated };
  } catch (e) {
    return toFailure(e, client);
  }
}

/**
 * PL-D6: 물리 삭제다. 되돌리기는 §8.7 백업·import_snapshots가 담당한다.
 * 마지막 행을 지워도 계획액은 0으로 돌아가지 않는다 — 잠금만 풀린다 (PL-9, 판단은 RPC 안에).
 */
export async function deleteBudgetDetail(id: string): Promise<ActionResult<null>> {
  let client: SupabaseClient | undefined;
  try {
    const did = parseOrThrow(uuidSchema, id, '산출근거 ID 형식이 올바르지 않습니다.');
    const ctx = await requireApprovedUser();
    client = ctx.client;

    // 삭제 후에는 projectId를 알 수 없으므로 먼저 읽는다 (없으면 NotFoundError)
    const current = await budgetDetailsRepo.getDetailById(client, did);
    await budgetDetailsRepo.deleteDetail(client, did);

    revalidateBudget(current.projectId);
    return { ok: true, data: null };
  } catch (e) {
    return toFailure(e, client);
  }
}

/**
 * X-3: 한 번의 RPC로 0..n-1을 부여한다.
 * orderedIds는 **그 세목의 전체 id 배열**이다 (§9). 화면이 접혀 일부만 보이더라도 보이는 것만
 * 보내지 않는다 — 부분 배열은 RPC가 거부한다(목록에 없는 행의 순서가 조용히 어긋나기 때문이다).
 */
export async function reorderBudgetDetails(
  yearId: string,
  category: unknown,
  subcategory: unknown,
  orderedIds: unknown
): Promise<ActionResult<null>> {
  let client: SupabaseClient | undefined;
  try {
    const yid = parseOrThrow(uuidSchema, yearId, '연차 ID 형식이 올바르지 않습니다.');
    const cat = parseOrThrow(budgetCategorySchema, category, '비목 값이 올바르지 않습니다.');
    const sub = parseOrThrow(z.string(), subcategory, '세목 값이 올바르지 않습니다.');
    const ids = parseOrThrow(orderedIdsSchema, orderedIds, '정렬 목록이 올바르지 않습니다.');

    const ctx = await requireApprovedUser();
    client = ctx.client;

    assertSubcategory(cat, sub);
    const year = await loadYear(client, yid); // N-13: 이 연차가 어느 과제인지 확인 겸 재검증 대상

    await budgetDetailsRepo.reorderDetails(client, yid, cat, sub, ids);

    revalidateBudget(year.projectId);
    return { ok: true, data: null };
  } catch (e) {
    return toFailure(e, client);
  }
}

/**
 * PL-14: 지침 한도는 과제별 사용자 입력이다. 부처 고시율 표를 코드에 넣지 않는다 (PL-16).
 * O-1: 두 값을 한 폼에서 한 번에 바꾸므로 expectedVersion을 받는다.
 */
export async function setBudgetRateLimits(
  projectId: string,
  input: unknown,
  expectedVersion?: number
): Promise<ActionResult<Project>> {
  let client: SupabaseClient | undefined;
  try {
    const pid = parseOrThrow(uuidSchema, projectId, '과제 ID 형식이 올바르지 않습니다.');
    const limits = parseOrThrow(rateLimitsSchema, input, '한도율이 올바르지 않습니다.');

    const ctx = await requireApprovedUser();
    client = ctx.client;

    const updated = await projectsRepo.updateProject(
      client,
      pid,
      { ...limits, updatedBy: ctx.user.id },
      expectedVersion
    );

    revalidateBudget(pid);
    return { ok: true, data: updated };
  } catch (e) {
    return toFailure(e, client);
  }
}

// ─── 조회 (§9 조회 목록 — 서버 컴포넌트에서 직접 호출) ────────────────────────

function cellKey(yearId: string, category: BudgetCategory): string {
  return `${yearId}|${category}`;
}

const EMPTY_AMOUNTS: PlanAmounts = { cashAmount: 0, inKindAmount: 0, plannedAmount: 0 };

/**
 * PL-11의 재료. 산출근거가 있는 셀은 `CellTotal`을 그대로 넘긴다 —
 * 그래야 `buildYearTotals`가 personnel_support 세목 소계를 직접 뽑는다.
 * 산출근거가 없는 셀은 세목 구분 자체가 없으므로 personnelSupportTotal에 0을 **명시한다**
 * (모르는 값을 0으로 때우는 것이 아니라, C 구분이 없다는 진술이다).
 */
function itemSource(item: BudgetItem): YearTotalSource {
  const amounts = {
    plannedAmount: item.plannedAmount,
    cashAmount: item.cashAmount,
    inKindAmount: item.inKindAmount,
  };
  return item.category === 'personnel'
    ? { category: 'personnel', ...amounts, personnelSupportTotal: 0 }
    : { category: item.category, ...amounts };
}

/**
 * 제안 모드 화면 한 벌 (§7.9·§7.9.2). 매트릭스 + 셀별 산출근거 요약 + 연차별 지침 검증.
 * 금액·비율은 전부 서버에서 계산해 내린다 — 화면이 산식을 다시 구현하지 않는다 (O-4).
 */
export async function getBudgetPlanData(projectId: string): Promise<ActionResult<BudgetPlanData>> {
  try {
    const pid = parseOrThrow(uuidSchema, projectId, '과제 ID 형식이 올바르지 않습니다.');
    const { client } = await requireApprovedUser();

    // 하나라도 실패하면 실패를 그대로 올린다 — 빈 배열 폴백은 데이터 손상을 감춘다 (절대 규칙 5).
    // 산출근거가 부분 조회되면 셀 합계가 조용히 작아져 지침 검증까지 틀린 값이 된다
    const [project, years, items, details, members, settings] = await Promise.all([
      projectsRepo.getProjectById(client, pid),
      yearsRepo.listYears(client, pid),
      budgetItemsRepo.listBudgetItemsByProject(client, pid),
      budgetDetailsRepo.listByProject(client, pid),
      membersRepo.listMembers(client, pid),
      settingsRepo.getSettings(client),
    ]);

    const matrix = buildBudgetMatrix(years, items);
    // 산출 행 금액·세목 소계·셀 합계는 lib/budget-plan.ts가 전담한다 (PL-1~PL-8)
    const aggregate = aggregateDetails(details, members);

    const yearById = new Map(years.map((year) => [year.id, year]));
    const orderedYears = matrix.columns
      .map((column) => yearById.get(column.yearId))
      .filter((year): year is Year => year !== undefined);

    const cellTotals = new Map<string, CellTotal>(
      aggregate.cells.map((cell) => [cellKey(cell.yearId, cell.category), cell])
    );
    const itemByCell = new Map<string, BudgetItem>(
      items.map((item) => [cellKey(item.yearId, item.category), item])
    );

    // B-3 판정은 buildBudgetMatrix가 이미 열에 실어 놨다 — 여기서는 yearId로 색인만 바꾼다
    // (getBudgetMatrix와 같은 모양이어야 매트릭스 컴포넌트가 두 모드에서 같은 prop을 받는다)
    const yearBudgetChecks: Record<string, YearBudgetMismatch | null> = {};
    for (const column of matrix.columns) {
      yearBudgetChecks[column.yearId] = column.mismatch;
    }

    const cells: BudgetPlanCellView[] = [];
    let mismatchCount = 0;
    for (const column of matrix.columns) {
      for (const category of BUDGET_CATEGORY_ORDER) {
        const key = cellKey(column.yearId, category);
        const item = itemByCell.get(key);
        const cell = cellTotals.get(key);
        const saved: SavedPlanAmounts = {
          plannedAmount: item?.plannedAmount ?? 0,
          cashAmount: item?.cashAmount ?? null,
          inKindAmount: item?.inKindAmount ?? null,
        };
        // detailCount는 리포지토리가 센 값이다. 집계 rowCount와 갈리면 둘 중 하나가 부분 조회다
        const detailCount = item?.detailCount ?? cell?.rowCount ?? 0;
        const total: PlanAmounts = cell
          ? {
              cashAmount: cell.cashAmount,
              inKindAmount: cell.inKindAmount,
              plannedAmount: cell.plannedAmount,
            }
          : EMPTY_AMOUNTS;
        // PL-10: 잠긴 셀에서만 의미가 있다. 잠기지 않은 셀의 저장값은 사람이 넣은 값이다
        const mismatch =
          cell !== undefined &&
          (saved.plannedAmount !== total.plannedAmount ||
            (saved.cashAmount ?? 0) !== total.cashAmount ||
            (saved.inKindAmount ?? 0) !== total.inKindAmount);
        if (mismatch) mismatchCount += 1;

        cells.push({
          yearId: column.yearId,
          category,
          detailCount,
          locked: detailCount > 0,
          total,
          saved,
          mismatch,
          negativeCount: cell?.negativeCount ?? 0,
          missingSalaryCount: cell?.missingSalaryCount ?? 0,
          subcategories: cell?.subcategories ?? [],
        });
      }
    }

    // PL-11~PL-13은 연차 단위다. 산출근거가 있는 셀은 세목 소계를 아는 CellTotal로,
    // 없는 셀은 저장된 비목 총액으로 재료를 만든다 (같은 셀을 두 번 세지 않는다).
    // §7.9의 현금/현물 비중도 **같은 sources 배열**에서 낸다 — 두 줄이 다른 재료를 보면
    // 하단 요약의 총액과 축 합계가 어긋난 채 나란히 놓인다
    const yearRules: BudgetPlanYearView[] = [];
    const yearAxisSplits: BudgetPlanYearAxisView[] = [];
    for (const column of matrix.columns) {
      const sources: YearTotalSource[] = [];
      for (const category of BUDGET_CATEGORY_ORDER) {
        const key = cellKey(column.yearId, category);
        const cell = cellTotals.get(key);
        if (cell) {
          sources.push(cell);
          continue;
        }
        const item = itemByCell.get(key);
        if (item) sources.push(itemSource(item));
      }
      yearRules.push({
        yearId: column.yearId,
        rules: evaluateBudgetRules(buildYearTotals(sources), project),
      });
      yearAxisSplits.push({ yearId: column.yearId, axis: computeAxisSplit(sources) });
    }

    return {
      ok: true,
      data: {
        projectId: pid,
        projectName: project.name,
        todayISO: todayISO(new Date()), // §6.5 기준일 — Asia/Seoul 달력
        years: orderedYears,
        matrix,
        cells,
        items, // 위 buildBudgetMatrix·집계에 넘긴 것과 같은 배열 — 표와 잠금이 같은 시점을 본다
        yearBudgetChecks,
        yearRules,
        yearAxisSplits,
        detailTotal: aggregate.total,
        detailCount: details.length,
        negativeCount: aggregate.negativeCount,
        missingSalaryCount: aggregate.missingSalaryCount,
        mismatchCount,
        allowanceRateLimit: project.allowanceRateLimit,
        indirectRateLimit: project.indirectRateLimit,
        projectVersion: project.version,
        currencyUnit: settings.currencyUnit,
      },
    };
  } catch (e) {
    return toFailure(e);
  }
}

/**
 * 산출근거 패널 한 벌 (§7.9.2). 행별 금액은 **서버가 계산해** 내린다 (PL-D7·O-4) —
 * 저장된 amount를 그대로 보여주면 연봉이 바뀐 뒤의 행이 옛 금액으로 남는다.
 */
export async function getBudgetDetails(
  yearId: string,
  category: unknown
): Promise<ActionResult<BudgetDetailsData>> {
  try {
    const yid = parseOrThrow(uuidSchema, yearId, '연차 ID 형식이 올바르지 않습니다.');
    const cat = parseOrThrow(budgetCategorySchema, category, '비목 값이 올바르지 않습니다.');
    const { client } = await requireApprovedUser();

    // 연차에서 과제를 얻는다 — 인력 목록과 경계 검증의 기준이다 (N-13)
    const year = await loadYear(client, yid);
    const [details, members] = await Promise.all([
      budgetDetailsRepo.listByCell(client, yid, cat),
      membersRepo.listMembers(client, year.projectId),
    ]);

    const aggregate = aggregateDetails(details, members);
    const rows: BudgetDetailRowView[] = details.map((detail, index) => {
      const computed = aggregate.rows[index];
      // 집계는 입력과 같은 순서·길이를 보장한다. 어긋나면 계산이 다른 행에 붙는다는 뜻이다
      if (!computed) throw new ValidationError('산출근거 금액을 계산하지 못했습니다.');
      return { detail, computed };
    });

    const cell = aggregate.cells[0];
    return {
      ok: true,
      data: {
        projectId: year.projectId,
        yearId: yid,
        category: cat,
        rows,
        subcategories: cell?.subcategories ?? [],
        total: {
          cashAmount: aggregate.total.cashAmount,
          inKindAmount: aggregate.total.inKindAmount,
          plannedAmount: aggregate.total.plannedAmount,
        },
        negativeCount: aggregate.negativeCount,
        missingSalaryCount: aggregate.missingSalaryCount,
        members,
      },
    };
  } catch (e) {
    return toFailure(e);
  }
}
