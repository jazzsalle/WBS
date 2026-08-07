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
import { budgetExecutionRowSchema, budgetItemRowSchema, type BudgetItemRow } from './schema';
import { ConflictError, NotFoundError, StaleDataError, ValidationError } from './errors';
import {
  countDetailsByCell,
  detailCountKey,
  fetchDetailCountsByYearIds,
} from './budget-details';

const TABLE = 'budget_items';
const CHILD_TABLE = 'budget_executions';

// 앱의 BudgetExecution(§5.12)이 노출하는 필드만 읽는다.
// version을 함께 싣는 이유: 집행 편집 폼이 expectedVersion을 걸려면 읽은 버전을 알아야 한다 (§8.4 O-1).
// (snake/camel 표기가 동일한 컬럼들이라 매퍼 변환 결과도 같다)
const EXECUTION_COLUMNS = 'id, version, date, amount, description, note';
// 집행 내역은 임베드(`executions:budget_executions(...)`)로 읽지 않는다:
// PostgREST는 임베드 자식이 max-rows(기본 1000)에 걸려도 에러 없이 잘린 배열을 준다.
// 그러면 집행액 합계가 조용히 작아지고 집행률(§6.4)이 틀린 값으로 표시된다 (절대 규칙 5, §12).
// 대신 부모만 읽고 자식은 아래 fetchExecutionsByItemIds가 페이징으로 따로 읽어 붙인다.
// export인 이유: 전 과제 벌크 조회(lib/db/dashboard.ts)가 같은 문자열을 써야 조회 모양이 갈라지지 않는다
export const ITEM_SELECT = '*';

const executionEmbedSchema = budgetExecutionRowSchema.pick({
  id: true,
  version: true,
  date: true,
  amount: true,
  description: true,
  note: true,
});
// 자식을 따로 읽으므로 어느 비목의 집행인지 알아야 병합할 수 있다
const executionWithParentSchema = executionEmbedSchema.extend({
  budget_item_id: budgetExecutionRowSchema.shape.budget_item_id,
});
const EXECUTION_ROW_COLUMNS = `budget_item_id, ${EXECUTION_COLUMNS}`;

// PostgREST 응답 상한(Supabase 기본 max-rows 1000)을 넘기려면 range로 이어 읽어야 한다.
const PAGE_SIZE = 1000;
// `.in('budget_item_id', ...)`는 UUID가 그대로 쿼리스트링에 들어간다. 과제 30개 × 연차 5 ×
// 비목 12 = 1,800개를 한 URL에 넣으면(≈ 66KB) 요청 URL 길이 한계에 걸린다 — 청크로 나눈다.
const ID_CHUNK_SIZE = 100;

// §9 updateBudgetPlan이 다루는 필드만 허용한다. plannedAmount = 현금 + 현물이지만
// 합산 검증은 서버 액션(Zod)의 몫 — 리포지토리는 금액 연산을 하지 않는다.
export type BudgetPlanPatch = {
  plannedAmount?: number;
  cashAmount?: number | null;
  inKindAmount?: number | null;
  note?: string;
  updatedBy?: string | null; // 서버 액션이 세션 사용자로 채운다 (SA-2)
};

// version은 DB 트리거가 올린다(N-4, N-5) — 입력으로 받지 않고 조회에만 실어 보낸다 (§8.4 O-1)
export type BudgetExecutionInput = Omit<BudgetExecution, 'id' | 'version'> & {
  createdBy?: string | null;
  updatedBy?: string | null;
};

export type BudgetExecutionPatch = Partial<Omit<BudgetExecution, 'id' | 'version'>> & {
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

// 비목 id 묶음의 집행 내역 전량을 읽어 비목별로 모아준다.
// 각 청크는 "빈 페이지가 나올 때까지" 이어 읽고, 다음 오프셋은 요청 폭이 아니라 실제로 받은
// 행 수만큼 전진시킨다 — 서버 max-rows가 PAGE_SIZE보다 작아도 구멍이 생기지 않는다
// (lib/db/dashboard.ts의 fetchAllRows와 같은 전략).
export async function fetchExecutionsByItemIds(
  client: SupabaseClient,
  itemIds: readonly string[]
): Promise<Map<string, BudgetExecution[]>> {
  // 집행이 하나도 없는 비목도 빈 배열을 갖도록 미리 채운다 (§5.12 executions는 항상 배열)
  const byItem = new Map<string, BudgetExecution[]>(itemIds.map((id) => [id, []]));
  if (itemIds.length === 0) return byItem;

  const chunks: string[][] = [];
  for (let start = 0; start < itemIds.length; start += ID_CHUNK_SIZE) {
    chunks.push([...itemIds.slice(start, start + ID_CHUNK_SIZE)]);
  }

  // 청크끼리는 대상 비목이 겹치지 않으므로 동시에 쏴도 병합 결과가 같다.
  // 순차로 돌리면 대시보드(§7.2)에서 청크 수 × 왕복이 그대로 지연이 되어 §12의 1초를 넘긴다.
  await Promise.all(
    chunks.map(async (chunk) => {
      for (let from = 0; ; ) {
        const { data, error } = await client
          .from(CHILD_TABLE)
          .select(EXECUTION_ROW_COLUMNS)
          // id 오름차순 고정 — range 페이징은 결정적 정렬이 없으면 행이 새거나 중복된다
          .in('budget_item_id', chunk)
          .order('id', { ascending: true })
          .range(from, from + PAGE_SIZE - 1);
        if (error) throwDbError(error);
        const page = parseRow(z.array(executionWithParentSchema), data ?? []);
        if (page.length === 0) return;
        for (const { budget_item_id: parentId, ...execution } of page) {
          const bucket = byItem.get(parentId);
          // 요청하지 않은 비목의 행 = 필터가 의도대로 걸리지 않았다는 뜻. 조용히 버리지 않는다
          if (!bucket) {
            throw new ValidationError('요청하지 않은 비목의 집행 내역이 반환되었습니다.');
          }
          bucket.push(dbToApp<BudgetExecution>(execution));
        }
        from += page.length;
      }
    })
  );
  return byItem;
}

// 집행 내역은 집행일 순 정렬 — 조회는 id 순(페이징 안정성)이므로 여기서 최종 정렬해 결정론을 보장
function sortByDate(executions: BudgetExecution[]): BudgetExecution[] {
  return [...executions].sort((a, b) =>
    a.date < b.date ? -1 : a.date > b.date ? 1 : a.id < b.id ? -1 : 1
  );
}

// 부모 행 + 따로 읽은 자식(집행 내역·산출근거 건수)을 앱 형태(§5.12)로 조립한다.
// export인 이유: 대시보드 벌크 조회(lib/db/dashboard.ts)와 조립 방식이 갈라지면
// 대시보드만 조용히 다른 집행액·다른 잠금 상태를 보게 된다.
// (이름은 호출부를 건드리지 않으려고 유지한다 — 지금은 detailCount도 함께 붙인다)
export async function attachExecutions(
  client: SupabaseClient,
  rows: readonly BudgetItemRow[]
): Promise<BudgetItem[]> {
  // 두 자식 조회는 서로 독립이라 동시에 쏜다. detailCount는 임베드로 세지 않는다 —
  // 임베드 자식은 max-rows에 걸려도 에러 없이 잘려 건수가 조용히 작아진다 (ITEM_SELECT 주석).
  const [byItem, detailCounts] = await Promise.all([
    fetchExecutionsByItemIds(
      client,
      rows.map((row) => row.id)
    ),
    // 산출근거는 budget_item_id가 아니라 (year_id, category)로 셀을 가리킨다 (§5.17)
    fetchDetailCountsByYearIds(client, [...new Set(rows.map((row) => row.year_id))]),
  ]);
  return rows.map((row) => ({
    ...dbToApp<Omit<BudgetItem, 'executions'>>(row),
    executions: sortByDate(byItem.get(row.id) ?? []),
    // 조회 자체가 실패하면 위에서 예외가 난다. 여기 0은 "그 셀에 행이 없다"는 뜻뿐이다 —
    // 실패를 0으로 눙치면 잠긴 셀이 편집 가능해 보인다 (PL-9, 절대 규칙 5)
    detailCount: detailCounts.get(detailCountKey(row.year_id, row.category)) ?? 0,
  }));
}

// PL-9 거부 판정용. updateBudgetPlan을 부르기 **전에** 액션이 이 값을 보고 잠긴 셀이면
// RULE로 거부한다 — 잠금은 계획액의 소유권 규칙이지 리포지토리의 저장 조건이 아니다 (§5.12).
export async function getCellDetailCount(
  client: SupabaseClient,
  yearId: string,
  category: BudgetCategory
): Promise<number> {
  return countDetailsByCell(client, yearId, category);
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
  return attachExecutions(client, parseRow(z.array(budgetItemRowSchema), data ?? []));
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
  return attachExecutions(client, parseRow(z.array(budgetItemRowSchema), data ?? []));
}

export async function getBudgetItemById(client: SupabaseClient, id: string): Promise<BudgetItem> {
  const { data, error } = await client.from(TABLE).select(ITEM_SELECT).eq('id', id).maybeSingle();
  if (error) throwDbError(error);
  if (!data) throw new NotFoundError();
  const [item] = await attachExecutions(client, [parseRow(budgetItemRowSchema, data)]);
  if (!item) throw new NotFoundError();
  return item;
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
  // §5.12 형태(executions 포함)로 반환하기 위해 재조회
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
