// budget_details(산출근거) 리포지토리 (SOT §5.17, §6.10, §8.6)
// BudgetItem이 "연차 × 비목에 얼마"라면 여기는 "그 금액이 어떻게 나왔는가"다.
//
// 두 가지가 이 파일의 형태를 결정한다.
//  1) PL-10 — 행을 건드리는 쓰기는 전부 RPC를 거친다. budget_items의 세 금액 재계산이
//     같은 트랜잭션 안에 있어야 하므로, 여기서 insert/update/delete를 직접 하면
//     총액이 근거와 어긋난 채 남는 중간 상태가 생긴다.
//  2) PL-10a·PL-D7 — 금액 산식은 lib/budget-plan.ts 한 곳에만 있다. 리포지토리는
//     계산된 amount를 그대로 실어 나르기만 하고 어떤 금액 연산도 하지 않는다.
//
// 금액은 원 단위 정수다 (절대 규칙 4).

import type { PostgrestError, SupabaseClient } from '@supabase/supabase-js';
import { z } from 'zod';
import type { BudgetCategory, BudgetDetail } from '@/types';
import { appToDb, dbToApp } from './mapper';
import { budgetDetailRowSchema } from './schema';
import {
  ConflictError,
  NotFoundError,
  RuleViolationError,
  StaleDataError,
  ValidationError,
} from './errors';

const TABLE = 'budget_details';

// PostgREST 응답 상한(Supabase 기본 max-rows 1000)을 넘기려면 range로 이어 읽어야 한다.
// Phase 5에서 임베드 자식이 1000행에서 에러 없이 잘려 집행률이 조용히 틀린 전례가 있다
// (budget-items.ts ITEM_SELECT 주석). 산출근거는 한 셀에 수십 행이 흔하므로
// 과제 전체 조회는 그 위험에 그대로 해당한다 — 전부 페이징해 읽는다.
const PAGE_SIZE = 1000;
// `.in('year_id', ...)`은 UUID가 그대로 쿼리스트링에 들어간다 — 긴 URL을 만들지 않도록 청크로 나눈다
const ID_CHUNK_SIZE = 100;

// SA-4: 테이블명·제약명 같은 내부 정보를 사용자 메시지에 싣지 않는다
const SCHEMA_MISMATCH_MESSAGE =
  'DB 응답이 앱이 기대하는 형식과 다릅니다. 앱과 DB 마이그레이션 버전을 확인하세요.';

// ─── P0001(RPC raise exception) 해석 규칙 ─────────────────────
// PostgREST는 PL/pgSQL의 raise exception을 전부 P0001 하나로 내려보낸다. 그래서 코드만으로는
// "낙관적 잠금 실패(STALE)"와 "규칙 위반(RULE)"을 구분할 수 없고 **메시지로 가른다**:
//   · /먼저 수정|stale/i        → StaleDataError (§8.4 O-1). O-3 표시용 updated_by는
//                                 예외에 실을 수 없으므로 대상 행을 한 번 더 읽어 채운다
//   · /찾을 수 없습니다|not found/i → NotFoundError (대상 행이 이미 사라진 경우)
//   · 그 외                      → RuleViolationError (PL-D1~PL-D5·과제 경계 검증 등)
// RPC 메시지 문구가 바뀌면 이 정규식도 같이 바꾼다 — 판정이 갈라지면 STALE이 RULE로 보고된다.
const STALE_MESSAGE_PATTERN = /먼저 수정|stale/i;
const NOT_FOUND_MESSAGE_PATTERN = /찾을 수 없습니다|not found/i;

function raiseDbError(error: PostgrestError): never {
  if (error.code === '23505') throw new ConflictError();
  if (error.code === 'P0001') {
    if (NOT_FOUND_MESSAGE_PATTERN.test(error.message)) throw new NotFoundError(error.message);
    throw new RuleViolationError(error.message);
  }
  // 매핑하지 않은 에러는 삼키지 않고 그대로 올린다 — toActionFailure가 일반 메시지로 감춘다 (SA-4)
  throw new Error(`[db] ${error.code}: ${error.message}`);
}

// DB 응답 검증 실패 = 스키마 드리프트 신호. 조용히 넘기지 않는다 (§8.6, 절대 규칙 5).
function parseRow<T>(schema: z.ZodType<T>, row: unknown): T {
  const result = schema.safeParse(row);
  if (!result.success) {
    console.error('[db/budget-details] row 검증 실패:', result.error.issues);
    throw new ValidationError(SCHEMA_MISMATCH_MESSAGE);
  }
  return result.data;
}

function toDetail(row: unknown): BudgetDetail {
  return dbToApp<BudgetDetail>(parseRow(budgetDetailRowSchema, row));
}

// O-3: "OO님이 먼저 수정했습니다"를 띄우려면 최신 행의 updated_by가 필요하다.
// 그새 행이 사라졌으면 낙관적 잠금 실패가 아니라 삭제된 것이다.
async function raiseStaleOrNotFound(client: SupabaseClient, id: string): Promise<never> {
  const { data, error } = await client
    .from(TABLE)
    .select('updated_by')
    .eq('id', id)
    .maybeSingle();
  if (error) raiseDbError(error);
  if (!data) throw new NotFoundError('산출근거 행을 찾을 수 없습니다.');
  throw new StaleDataError(
    parseRow(z.object({ updated_by: z.uuid().nullable() }), data).updated_by
  );
}

// undefined 키 제거 — JSON 직렬화에서 사라져 RPC가 "값 없음"과 "명시적 null"을 구분하지 못하는 것을 막는다
function definedOnly(obj: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined));
}

type PagedResult = PromiseLike<{ data: unknown[] | null; error: PostgrestError | null }>;

// "빈 페이지가 나올 때까지" 이어 읽고, 다음 오프셋은 요청 폭이 아니라 실제로 받은 행 수만큼
// 전진시킨다 — 서버 max-rows가 PAGE_SIZE보다 작아도 구멍이 생기지 않는다
// (lib/db/dashboard.ts의 fetchAllRows·budget-items.ts의 fetchExecutionsByItemIds와 같은 전략).
async function fetchAllRows(build: (from: number, to: number) => PagedResult): Promise<unknown[]> {
  const rows: unknown[] = [];
  for (let from = 0; ; ) {
    const { data, error } = await build(from, from + PAGE_SIZE - 1);
    if (error) raiseDbError(error);
    const page = data ?? [];
    if (page.length === 0) return rows;
    rows.push(...page);
    from += page.length;
  }
}

function chunk(ids: readonly string[]): string[][] {
  const out: string[][] = [];
  for (let start = 0; start < ids.length; start += ID_CHUNK_SIZE) {
    out.push([...ids.slice(start, start + ID_CHUNK_SIZE)]);
  }
  return out;
}

// 조회는 id 순으로 페이징하고(결정적 정렬이 없으면 range 페이징이 행을 새거나 중복시킨다)
// 표시 순서는 여기서 최종적으로 맞춘다. §5.17 order는 "세목 안에서의 순서"라
// 세목을 먼저 묶어야 의미가 산다. 세목 자체의 나열 순서(부록 A.5 프리셋 순)는 화면 몫이다.
function compareForDisplay(a: BudgetDetail, b: BudgetDetail): number {
  if (a.yearId !== b.yearId) return a.yearId < b.yearId ? -1 : 1;
  if (a.category !== b.category) return a.category < b.category ? -1 : 1;
  if (a.subcategory !== b.subcategory) return a.subcategory < b.subcategory ? -1 : 1;
  if (a.order !== b.order) return a.order - b.order;
  return a.id < b.id ? -1 : 1;
}

function toDetails(rows: readonly unknown[]): BudgetDetail[] {
  return rows.map(toDetail).sort(compareForDisplay);
}

// ─── 조회 ────────────────────────────────────────────────────

/** §7.9.2 산출근거 패널 — 선택한 (연차 × 비목) 한 셀의 전 행. Member 정보 결합은 액션 몫이다 */
export async function listByCell(
  client: SupabaseClient,
  yearId: string,
  category: BudgetCategory
): Promise<BudgetDetail[]> {
  const rows = await fetchAllRows((from, to) =>
    client
      .from(TABLE)
      .select('*')
      .eq('year_id', yearId)
      .eq('category', category)
      .order('id', { ascending: true })
      .range(from, to)
  );
  return toDetails(rows);
}

/**
 * 행 하나. `updateBudgetDetail`이 부분 patch를 받으므로(§9) 근거 필드 전체를 알아야
 * amount를 다시 계산할 수 있고(PL-D7), `deleteBudgetDetail`은 삭제 뒤 projectId를 알 수 없어
 * 먼저 읽어야 한다.
 */
export async function getDetailById(client: SupabaseClient, id: string): Promise<BudgetDetail> {
  const { data, error } = await client.from(TABLE).select('*').eq('id', id).maybeSingle();
  if (error) raiseDbError(error);
  if (!data) throw new NotFoundError('산출근거 행을 찾을 수 없습니다.');
  return toDetail(data);
}

/** §7.9 매트릭스 집계(PL-6~PL-8)용 — 과제의 산출근거 전량. 행 수가 커질 수 있어 페이징한다 */
export async function listByProject(
  client: SupabaseClient,
  projectId: string
): Promise<BudgetDetail[]> {
  const rows = await fetchAllRows((from, to) =>
    client
      .from(TABLE)
      .select('*')
      .eq('project_id', projectId)
      .order('id', { ascending: true })
      .range(from, to)
  );
  return toDetails(rows);
}

/**
 * PL-10b — 연봉이 바뀌면 파급되는 인건비 산출근거 전량 (연차·비목·현재 amount·근거 필드 포함).
 * 서버 액션이 이 행들로 새 amount를 계산해 previewSalaryChange의 전후 비교를 만들고,
 * 확인 뒤 같은 값으로 저장한다. 행 전체를 돌려주는 이유: 새 금액 계산에 factors·adjustment가
 * 필요한데, 일부만 실어 보내면 액션이 다시 조회해야 하고 그 사이 값이 어긋날 수 있다.
 */
export async function listByMember(
  client: SupabaseClient,
  memberId: string
): Promise<BudgetDetail[]> {
  const rows = await fetchAllRows((from, to) =>
    client
      .from(TABLE)
      .select('*')
      .eq('member_id', memberId)
      .order('id', { ascending: true })
      .range(from, to)
  );
  return toDetails(rows);
}

/**
 * PS-5 — 전 과제의 인건비(formula='personnel') 산출근거 전량. 참여율 합산(§6.15)의 입력이다.
 * student_personnel 제외·연결 안 된 Member 분리(PS-1)는 lib/participation.ts가 판정한다 —
 * 여기서 걸러 버리면 "연결 안 된 인건비 행 N건"을 셀 수 없다. 과제 경계를 넘으므로 페이징한다 (§12).
 */
export async function listPersonnelDetailsAll(client: SupabaseClient): Promise<BudgetDetail[]> {
  const rows = await fetchAllRows((from, to) =>
    client
      .from(TABLE)
      .select('*')
      .eq('formula', 'personnel')
      .order('id', { ascending: true })
      .range(from, to)
  );
  return toDetails(rows);
}

// ─── detailCount 집계 (§5.12, PL-9) ──────────────────────────

/** (연차, 비목) 셀 하나의 키. Map의 키로만 쓴다 — 저장되거나 화면에 나가지 않는다 */
export function detailCountKey(yearId: string, category: BudgetCategory): string {
  return `${yearId}::${category}`;
}

/**
 * 셀 하나의 산출근거 건수. PL-9 잠금 판정(updateBudgetPlan 거부·임포트 S-14)의 근거다.
 * head + count='exact'라 행을 받지 않으므로 max-rows 절단과 무관하게 정확하다.
 */
export async function countDetailsByCell(
  client: SupabaseClient,
  yearId: string,
  category: BudgetCategory
): Promise<number> {
  const { count, error } = await client
    .from(TABLE)
    .select('id', { count: 'exact', head: true })
    .eq('year_id', yearId)
    .eq('category', category);
  if (error) raiseDbError(error);
  // count가 없으면 "0건"이 아니라 "세지 못했다"는 뜻이다. 0으로 채우면 잠긴 셀이
  // 편집 가능해 보이고 계획액이 근거 없이 덮인다 (절대 규칙 5).
  if (count === null) {
    throw new ValidationError('산출근거 건수를 확인하지 못했습니다. 잠시 후 다시 시도하세요.');
  }
  return count;
}

// 건수만 필요하므로 최소 컬럼만 읽는다. id는 페이징 정렬 키로 반드시 있어야 한다
const COUNT_COLUMNS = 'id, year_id, category';
const countRowSchema = budgetDetailRowSchema.pick({ id: true, year_id: true, category: true });

/**
 * 여러 연차의 (연차 × 비목)별 산출근거 건수. detailCountKey로 색인된 Map을 돌려준다.
 *
 * 임베드(`budget_items ... budget_details(count)`)로 세지 않는 이유는 ITEM_SELECT 주석과 같다 —
 * 임베드 자식은 max-rows에 걸려도 에러 없이 잘려 건수가 조용히 작아진다. 잠긴 셀이 0건으로
 * 보이면 계획액이 근거를 무시하고 덮이므로, 별도 질의로 **전 행을 페이징해** 세는 쪽을 택했다.
 */
export async function fetchDetailCountsByYearIds(
  client: SupabaseClient,
  yearIds: readonly string[]
): Promise<Map<string, number>> {
  const counts = new Map<string, number>();
  if (yearIds.length === 0) return counts;

  const requested = new Set(yearIds);
  // 청크끼리 대상 연차가 겹치지 않으므로 동시에 쏴도 합계가 같다. 순차로 돌리면
  // 대시보드·매트릭스에서 청크 수 × 왕복이 그대로 지연이 된다 (§12).
  await Promise.all(
    chunk([...requested]).map(async (ids) => {
      const rows = await fetchAllRows((from, to) =>
        client
          .from(TABLE)
          .select(COUNT_COLUMNS)
          .in('year_id', ids)
          .order('id', { ascending: true })
          .range(from, to)
      );
      for (const row of rows) {
        const parsed = parseRow(countRowSchema, row);
        // 요청하지 않은 연차의 행 = 필터가 의도대로 걸리지 않았다는 뜻. 조용히 버리지 않는다
        if (!requested.has(parsed.year_id)) {
          throw new ValidationError('요청하지 않은 연차의 산출근거가 반환되었습니다.');
        }
        const key = detailCountKey(parsed.year_id, parsed.category);
        counts.set(key, (counts.get(key) ?? 0) + 1);
      }
    })
  );
  return counts;
}

// ─── 쓰기 (전부 RPC — PL-10 트랜잭션 불변식이 RPC 안에 있다) ──

// N-4 공통 컬럼은 DB(트리거)와 RPC(auth.uid())가 채운다 — 입력에서 제외
type BaseFieldKeys = 'id' | 'createdAt' | 'updatedAt' | 'version' | 'createdBy' | 'updatedBy';

/**
 * 신규는 id 없이, 갱신은 id와 함께 보낸다 (§9 createBudgetDetail / updateBudgetDetail이
 * 같은 RPC를 쓴다). **부분 patch를 받지 않는다** — PL-D7에 따라 amount는 근거 필드 전체로
 * 다시 계산돼야 하고, 그러려면 액션이 이미 전 필드를 손에 쥐고 있어야 하기 때문이다.
 */
export type BudgetDetailUpsertInput = Omit<BudgetDetail, BaseFieldKeys> & { id?: string };

/**
 * 산출근거 행 추가·수정. RPC가 같은 트랜잭션에서 budget_items의
 * planned/cash/in_kind를 다시 계산한다 (PL-10). amount는 액션이 lib/budget-plan.ts로
 * 계산해 넣은 값이며 RPC는 더하기만 한다 (PL-10a).
 */
export async function upsertDetail(
  client: SupabaseClient,
  input: BudgetDetailUpsertInput,
  expectedVersion?: number
): Promise<BudgetDetail> {
  const { data, error } = await client.rpc('upsert_budget_detail', {
    // jsonb 페이로드는 DB 표기(snake_case)다 — 케이스 변환은 매퍼에만 맡긴다.
    // factors 내부(isPercent)는 매퍼가 통과시킨다 (JSONB_PASSTHROUGH_KEYS)
    p_detail: definedOnly(appToDb(input)),
    p_expected_version: expectedVersion ?? null,
  });
  if (error) {
    // §8.4 O-1: 잠금 실패는 P0001로만 오므로 메시지로 가른 뒤 updated_by를 채워 던진다
    if (error.code === 'P0001' && STALE_MESSAGE_PATTERN.test(error.message) && input.id) {
      await raiseStaleOrNotFound(client, input.id);
    }
    raiseDbError(error);
  }
  return toDetail(data);
}

/**
 * PL-D6: 물리 삭제다. 되돌리기는 §8.7 백업·import_snapshots가 담당한다.
 * 마지막 행을 지워도 budget_items의 금액은 0으로 되돌아가지 않는다 — 직전 합계가 남고
 * 잠금만 풀린다 (PL-9). 그 판단은 RPC 안에 있다.
 */
export async function deleteDetail(client: SupabaseClient, id: string): Promise<void> {
  const { error } = await client.rpc('delete_budget_detail', { p_detail_id: id });
  if (error) raiseDbError(error);
}

/**
 * X-3: 한 번의 RPC로 0..n-1을 부여한다. orderedIds는 §9의 규정대로
 * **그 세목의 전체 id 배열**이다 — 화면이 접혀 일부만 보여도 보이는 것만 보내지 않는다.
 * 순서만 바꾸므로 금액은 그대로지만, 세목 밖 id가 섞이는 경우를 RPC가 거부한다.
 */
export async function reorderDetails(
  client: SupabaseClient,
  yearId: string,
  category: BudgetCategory,
  subcategory: string,
  orderedIds: string[]
): Promise<void> {
  const { error } = await client.rpc('reorder_budget_details', {
    p_year_id: yearId,
    p_category: category,
    p_subcategory: subcategory,
    p_ordered_ids: orderedIds,
  });
  if (error) raiseDbError(error);
}
