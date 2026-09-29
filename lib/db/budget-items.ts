// budget_items 리포지토리 (SOT §5.12, §8.6)
// 금액은 원 단위 정수를 그대로 저장·통과시킨다 — 환산·부동소수점 연산 금지 (절대 규칙 4).
//
// budget_items 행 자체의 생성·삭제는 없다: 연차 생성 시 create_year RPC가 12종 비목을
// 자동 생성하고(§5.12), 연차 삭제 시 cascade로 지워진다 (H-5). 여기는 계획액 갱신과
// 조회만 담당한다 (§9 Budget 액션과 1:1).

import type { PostgrestError, SupabaseClient } from '@supabase/supabase-js';
import { z } from 'zod';
import type { BudgetCategory, BudgetItem } from '@/types';
import { appToDb, dbToApp } from './mapper';
import { budgetItemRowSchema, type BudgetItemRow } from './schema';
import { ConflictError, NotFoundError, StaleDataError, ValidationError } from './errors';
import {
  countDetailsByCell,
  detailCountKey,
  fetchDetailCountsByYearIds,
} from './budget-details';

const TABLE = 'budget_items';

// 자식(산출근거 건수)은 임베드(`budget_details(count)`)로 읽지 않는다: PostgREST는 임베드 자식이
// max-rows(기본 1000)에 걸려도 에러 없이 잘린 결과를 준다. 그러면 건수가 조용히 작아져
// 잠긴 셀이 편집 가능해 보인다 (PL-9, 절대 규칙 5, §12). 부모만 읽고 건수는 따로 페이징해 붙인다.
const ITEM_SELECT = '*';

// §9 updateBudgetPlan이 다루는 필드만 허용한다. plannedAmount = 현금 + 현물이지만
// 합산 검증은 서버 액션(Zod)의 몫 — 리포지토리는 금액 연산을 하지 않는다.
export type BudgetPlanPatch = {
  plannedAmount?: number;
  cashAmount?: number | null;
  inKindAmount?: number | null;
  note?: string;
  updatedBy?: string | null; // 서버 액션이 세션 사용자로 채운다 (SA-2)
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

// 부모 행 + 따로 읽은 산출근거 건수를 앱 형태(§5.12)로 조립한다
export async function attachDetailCounts(
  client: SupabaseClient,
  rows: readonly BudgetItemRow[]
): Promise<BudgetItem[]> {
  // 산출근거는 budget_item_id가 아니라 (year_id, category)로 셀을 가리킨다 (§5.17)
  const detailCounts = await fetchDetailCountsByYearIds(client, [
    ...new Set(rows.map((row) => row.year_id)),
  ]);
  return rows.map((row) => ({
    ...dbToApp<Omit<BudgetItem, 'detailCount'>>(row),
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
  return attachDetailCounts(client, parseRow(z.array(budgetItemRowSchema), data ?? []));
}

// 과제 전체 매트릭스(§7.9)용 — 연차 축 배열은 years 리포지토리와 조합한다
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
  return attachDetailCounts(client, parseRow(z.array(budgetItemRowSchema), data ?? []));
}

export async function getBudgetItemById(client: SupabaseClient, id: string): Promise<BudgetItem> {
  const { data, error } = await client.from(TABLE).select(ITEM_SELECT).eq('id', id).maybeSingle();
  if (error) throwDbError(error);
  if (!data) throw new NotFoundError();
  const [item] = await attachDetailCounts(client, [parseRow(budgetItemRowSchema, data)]);
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
  // §5.12 형태(detailCount 포함)로 반환하기 위해 재조회
  return getBudgetItemById(client, row.id);
}
