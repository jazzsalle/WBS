// budget_items + budget_executions 리포지토리 (SOT §5.12, §8.6)
// 금액은 원 단위 정수를 그대로 저장·통과시킨다 — 환산·부동소수점 연산 금지 (절대 규칙 4).
// 집행률 계산은 lib/budget.ts(§6.4) 몫이다. 여기는 저장·조회만 한다.
//
// budget_items 행 자체의 생성·삭제는 없다: 연차 생성 시 create_year RPC가 12종 비목을
// 자동 생성하고(§5.12), 연차 삭제 시 cascade로 지워진다 (H-5). 여기는 계획액 갱신과
// 자식 budget_executions CRUD만 담당한다 (§9 Budget 액션과 1:1).

import type { PostgrestError, SupabaseClient } from '@supabase/supabase-js';
import { z } from 'zod';
import type { BudgetCategory, BudgetExecution, BudgetItem } from '@/types';
import { appToDb, dbToApp } from './mapper';
import { budgetExecutionRowSchema, budgetItemRowSchema } from './schema';
import { ConflictError, NotFoundError, StaleDataError, ValidationError } from './errors';

const TABLE = 'budget_items';
const CHILD_TABLE = 'budget_executions';

// 앱의 BudgetExecution(§5.12)은 5개 필드만 노출한다 — 임베드 select도 그 형태로 맞춘다.
// (snake/camel 표기가 동일한 컬럼들이라 매퍼 변환 결과도 같다)
const EXECUTION_COLUMNS = 'id, date, amount, description, note';
// export인 이유: 전 과제 벌크 조회(lib/db/dashboard.ts)가 같은 문자열을 써야 임베드 모양이 갈라지지 않는다
export const ITEM_SELECT = `*, executions:budget_executions(${EXECUTION_COLUMNS})`;

const executionEmbedSchema = budgetExecutionRowSchema.pick({
  id: true,
  date: true,
  amount: true,
  description: true,
  note: true,
});
export const itemWithExecutionsSchema = budgetItemRowSchema.extend({
  executions: z.array(executionEmbedSchema),
});
type ItemWithExecutionsRow = z.infer<typeof itemWithExecutionsSchema>;

// §9 updateBudgetPlan이 다루는 필드만 허용한다. plannedAmount = 현금 + 현물이지만
// 합산 검증은 서버 액션(Zod)의 몫 — 리포지토리는 금액 연산을 하지 않는다.
export type BudgetPlanPatch = {
  plannedAmount?: number;
  cashAmount?: number | null;
  inKindAmount?: number | null;
  note?: string;
  updatedBy?: string | null; // 서버 액션이 세션 사용자로 채운다 (SA-2)
};

export type BudgetExecutionInput = Omit<BudgetExecution, 'id'> & {
  createdBy?: string | null;
  updatedBy?: string | null;
};

export type BudgetExecutionPatch = Partial<Omit<BudgetExecution, 'id'>> & {
  updatedBy?: string | null;
};

// 23505(unique 충돌: budget_items unique(year_id, category))만 의미 있는 코드로 바꾸고
// 나머지는 그대로 던진다 — RepositoryError가 아닌 예외는 toActionFailure가 감춘다 (SA-4).
function throwDbError(error: PostgrestError): never {
  if (error.code === '23505') throw new ConflictError();
  throw error;
}

// DB 응답 검증 실패 = 스키마 드리프트 신호. 조용히 넘기지 않는다 (§8.6, 절대 규칙 5).
function parseRow<T>(schema: z.ZodType<T>, row: unknown): T {
  const result = schema.safeParse(row);
  if (!result.success) {
    throw new ValidationError('DB 응답이 스키마와 일치하지 않습니다. 마이그레이션 누락 가능성이 있습니다.');
  }
  return result.data;
}

// undefined 값 키 제거 — JSON 직렬화에서 빠져 빈 body가 되는 것을 막고,
// "갱신할 내용 없음"을 명시적으로 판정하기 위함
function definedOnly(obj: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined));
}

// 임베드 결과를 앱 형태(§5.12 executions 포함)로 조립한다.
// 집행 내역은 집행일 순 정렬 — PostgREST 임베드 정렬 대신 여기서 정렬해 결정론을 보장
export function toBudgetItem(row: ItemWithExecutionsRow): BudgetItem {
  const { executions, ...itemRow } = row;
  const sorted = [...executions].sort((a, b) =>
    a.date < b.date ? -1 : a.date > b.date ? 1 : a.id < b.id ? -1 : 1
  );
  return {
    ...dbToApp<Omit<BudgetItem, 'executions'>>(itemRow),
    executions: sorted,
  };
}

// 연차 하나의 비목 12종 (§5.12 매트릭스의 한 열). 표시 순서(부록 A.1)는 UI 몫 —
// 여기서는 category 문자열 순으로 결정론적 정렬만 한다
export async function listBudgetItemsByYear(
  client: SupabaseClient,
  yearId: string
): Promise<BudgetItem[]> {
  const { data, error } = await client
    .from(TABLE)
    .select(ITEM_SELECT)
    .eq('year_id', yearId)
    .order('category');
  if (error) throwDbError(error);
  return parseRow(z.array(itemWithExecutionsSchema), data ?? []).map(toBudgetItem);
}

// 과제 전체 매트릭스(§7.9 getBudgetMatrix)용 — 연차 축 배열은 years 리포지토리와 조합한다
export async function listBudgetItemsByProject(
  client: SupabaseClient,
  projectId: string
): Promise<BudgetItem[]> {
  const { data, error } = await client
    .from(TABLE)
    .select(ITEM_SELECT)
    .eq('project_id', projectId)
    .order('year_id')
    .order('category');
  if (error) throwDbError(error);
  return parseRow(z.array(itemWithExecutionsSchema), data ?? []).map(toBudgetItem);
}

export async function getBudgetItemById(client: SupabaseClient, id: string): Promise<BudgetItem> {
  const { data, error } = await client.from(TABLE).select(ITEM_SELECT).eq('id', id).maybeSingle();
  if (error) throwDbError(error);
  if (!data) throw new NotFoundError();
  return toBudgetItem(parseRow(itemWithExecutionsSchema, data));
}

// (yearId, category)가 유일 키(§5.12)라 id 대신 이 조합으로 갱신한다 — §9 updateBudgetPlan과 1:1
export async function updateBudgetPlan(
  client: SupabaseClient,
  yearId: string,
  category: BudgetCategory,
  patch: BudgetPlanPatch,
  expectedVersion?: number
): Promise<BudgetItem> {
  const dbPatch = definedOnly(appToDb(patch));
  if (Object.keys(dbPatch).length === 0) {
    throw new ValidationError('갱신할 내용이 없습니다.');
  }
  let query = client.from(TABLE).update(dbPatch).eq('year_id', yearId).eq('category', category);
  if (expectedVersion !== undefined) {
    query = query.eq('version', expectedVersion); // §8.4: 그새 바뀌었으면 0행 갱신
  }
  const { data, error } = await query.select('id');
  if (error) throwDbError(error);
  const row = (data ?? [])[0] as { id: string } | undefined;
  if (row === undefined) {
    // 0행 갱신의 원인 구분: 행이 없으면 NotFound, 있으면 낙관적 잠금 실패 (§8.4, O-3)
    const { data: latest, error: fetchError } = await client
      .from(TABLE)
      .select('updated_by')
      .eq('year_id', yearId)
      .eq('category', category)
      .maybeSingle();
    if (fetchError) throwDbError(fetchError);
    if (!latest) throw new NotFoundError();
    throw new StaleDataError((latest as { updated_by: string | null }).updated_by);
  }
  // §5.12 임베드 형태로 반환하기 위해 executions 포함 재조회
  return getBudgetItemById(client, row.id);
}

// ─── budget_executions 자식 CRUD (N-1: 별도 테이블) ──────────

export async function addExecution(
  client: SupabaseClient,
  budgetItemId: string,
  input: BudgetExecutionInput
): Promise<BudgetExecution> {
  const { data, error } = await client
    .from(CHILD_TABLE)
    .insert(appToDb({ ...input, budgetItemId }))
    .select(EXECUTION_COLUMNS)
    .single();
  if (error) throwDbError(error);
  return dbToApp<BudgetExecution>(parseRow(executionEmbedSchema, data));
}

// budgetItemId를 함께 조건으로 걸어 다른 비목의 집행을 건드리는 실수를 차단한다 (§9 시그니처와 1:1)
export async function updateExecution(
  client: SupabaseClient,
  budgetItemId: string,
  executionId: string,
  patch: BudgetExecutionPatch,
  expectedVersion?: number
): Promise<BudgetExecution> {
  const dbPatch = definedOnly(appToDb(patch));
  if (Object.keys(dbPatch).length === 0) {
    throw new ValidationError('갱신할 내용이 없습니다.');
  }
  let query = client
    .from(CHILD_TABLE)
    .update(dbPatch)
    .eq('id', executionId)
    .eq('budget_item_id', budgetItemId);
  if (expectedVersion !== undefined) {
    query = query.eq('version', expectedVersion); // §8.4: 그새 바뀌었으면 0행 갱신
  }
  const { data, error } = await query.select(EXECUTION_COLUMNS);
  if (error) throwDbError(error);
  const row = (data ?? [])[0];
  if (row === undefined) {
    // 0행 갱신의 원인 구분: 행이 없으면 NotFound, 있으면 낙관적 잠금 실패 (§8.4, O-3)
    const { data: latest, error: fetchError } = await client
      .from(CHILD_TABLE)
      .select('updated_by')
      .eq('id', executionId)
      .eq('budget_item_id', budgetItemId)
      .maybeSingle();
    if (fetchError) throwDbError(fetchError);
    if (!latest) throw new NotFoundError();
    throw new StaleDataError((latest as { updated_by: string | null }).updated_by);
  }
  return dbToApp<BudgetExecution>(parseRow(executionEmbedSchema, row));
}

export async function removeExecution(
  client: SupabaseClient,
  budgetItemId: string,
  executionId: string
): Promise<void> {
  const { data, error } = await client
    .from(CHILD_TABLE)
    .delete()
    .eq('id', executionId)
    .eq('budget_item_id', budgetItemId)
    .select('id');
  if (error) throwDbError(error);
  if ((data ?? []).length === 0) throw new NotFoundError();
}
