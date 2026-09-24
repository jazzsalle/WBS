// staff(조직원 마스터)·staff_salaries(급여 이력) 리포지토리 (SOT §5.19 ST-1·ST-2, §5.20 SL-3, §8.4 O-1~O-3, §8.6)
// Staff는 "우리 회사 사람", Member는 "이 과제의 참여자"다. 이 파일은 Member를 건드리지 않는다 —
// 조직원 삭제가 Member에 미치는 영향(staff_id set null, 연봉·스냅샷 유지)은 DB FK가 정한다(ST-2).
//
// 급여 이력은 덮어쓰지 않고 쌓는다(SL-3). 잘못 넣은 행의 수정·삭제만 있고, "현재 급여"를 고르는
// 산식(SL-2)은 lib/salary.ts 순수 함수의 몫이다 — 여기서는 effective_from 내림차순으로 실어 나른다.
//
// 금액은 원 단위 정수다 (절대 규칙 4). 유일 제약(ST-1 이메일, (staff_id, effective_from))과
// check(amount ≥ 0, basis)는 액션의 Zod 뒤에 서는 최종 방어선이다 — 위반은 사용자 문구로 올린다.

import type { PostgrestError, SupabaseClient } from '@supabase/supabase-js';
import { z } from 'zod';
import type { BaseEntity, Staff, StaffSalary } from '@/types';
import { appToDb, dbToApp } from './mapper';
import { staffRowSchema, staffSalaryRowSchema } from './schema';
import {
  ConflictError,
  NotFoundError,
  RuleViolationError,
  StaleDataError,
  ValidationError,
} from './errors';

const STAFF_TABLE = 'staff';
const SALARY_TABLE = 'staff_salaries';
type Table = typeof STAFF_TABLE | typeof SALARY_TABLE;

// PostgREST 응답 상한(max-rows 1000) — budget-details.ts와 같은 이유로 전량 조회는 전부 페이징한다 (§12)
const PAGE_SIZE = 1000;
// `.in(...)`의 UUID가 쿼리스트링에 그대로 실린다 — 긴 URL을 만들지 않도록 청크로 나눈다
const ID_CHUNK_SIZE = 100;

// SA-4: 테이블명·제약명 같은 내부 정보를 사용자 메시지에 싣지 않는다
const SCHEMA_MISMATCH_MESSAGE =
  'DB 응답이 앱이 기대하는 형식과 다릅니다. 앱과 DB 마이그레이션 버전을 확인하세요.';
const STAFF_NOT_FOUND_MESSAGE = '조직원을 찾을 수 없습니다.';
const SALARY_NOT_FOUND_MESSAGE = '급여 이력을 찾을 수 없습니다.';

// ─── 에러 매핑 ───────────────────────────────────────────────

// 23505는 테이블마다 뜻이 다르다: staff는 ST-1(이메일), staff_salaries는 (staff_id, effective_from)
const CONFLICT_MESSAGES: Record<Table, string> = {
  staff: '같은 이메일의 조직원이 있습니다.',
  staff_salaries: '같은 적용일의 급여 이력이 있습니다.',
};
const NOT_FOUND_MESSAGES: Record<Table, string> = {
  staff: STAFF_NOT_FOUND_MESSAGE,
  staff_salaries: SALARY_NOT_FOUND_MESSAGE,
};

// 23514(check 위반) 메시지의 제약 이름으로 어느 규칙에 걸렸는지 가른다.
// 20260925000000_staff_salary.sql의 제약 이름(Postgres 자동 명명 <table>_<column>_check)이 바뀌면 여기도 같이 바꾼다.
const CHECK_CONSTRAINT_MESSAGES: ReadonlyArray<readonly [RegExp, string]> = [
  [/staff_salaries_amount_check/, '급여 금액은 0 이상의 원 단위 정수여야 합니다.'],
  [/staff_salaries_basis_check/, '급여 단위는 연봉(annual)·월급(monthly) 중 하나여야 합니다.'],
];
const UNKNOWN_CHECK_MESSAGE = '입력값이 DB 제약을 위반했습니다. 값을 확인하세요.';

// RPC는 쓰지 않지만 관례를 맞춘다 — 트리거의 raise exception도 P0001로 온다
const STALE_MESSAGE_PATTERN = /먼저 수정|stale/i;
const NOT_FOUND_MESSAGE_PATTERN = /찾을 수 없습니다|not found/i;

function checkViolationMessage(error: PostgrestError): string {
  const text = `${error.message} ${error.details ?? ''}`;
  for (const [pattern, message] of CHECK_CONSTRAINT_MESSAGES) {
    if (pattern.test(text)) return message;
  }
  return UNKNOWN_CHECK_MESSAGE;
}

function raiseDbError(error: PostgrestError, table: Table): never {
  if (error.code === '23505') throw new ConflictError(CONFLICT_MESSAGES[table]);
  if (error.code === '23514') throw new RuleViolationError(checkViolationMessage(error));
  // 23503: staff_salaries.staff_id가 가리키는 조직원이 없다 — 이력을 만드는 중에 조직원이 지워진 경우
  if (error.code === '23503') throw new NotFoundError(STAFF_NOT_FOUND_MESSAGE);
  if (error.code === 'P0001') {
    if (STALE_MESSAGE_PATTERN.test(error.message)) throw new StaleDataError();
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
    console.error('[db/staff] row 검증 실패:', result.error.issues);
    throw new ValidationError(SCHEMA_MISMATCH_MESSAGE);
  }
  return result.data;
}

function toStaff(row: unknown): Staff {
  return dbToApp<Staff>(parseRow(staffRowSchema, row));
}

function toSalary(row: unknown): StaffSalary {
  return dbToApp<StaffSalary>(parseRow(staffSalaryRowSchema, row));
}

// undefined 키 제거 — JSON 직렬화에서 빠져 빈 body가 되는 것을 막고 "갱신할 내용 없음"을 명시적으로 판정한다
function definedOnly(obj: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined));
}

// ST-1: 저장 전 정규화. DB의 lower(trim(email)) 유일 인덱스와 같은 규칙이라 저장값과 비교값이 어긋나지 않는다
function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

// 0행 갱신의 원인 구분: 행이 없으면 NotFound, 있으면 낙관적 잠금 실패 (§8.4 O-1).
// O-3 표시("OO님이 먼저 수정했습니다")를 위해 최신 행의 updated_by를 담는다.
async function raiseStaleOrNotFound(client: SupabaseClient, table: Table, id: string): Promise<never> {
  const { data, error } = await client.from(table).select('updated_by').eq('id', id).maybeSingle();
  if (error) raiseDbError(error, table);
  if (!data) throw new NotFoundError(NOT_FOUND_MESSAGES[table]);
  throw new StaleDataError(
    parseRow(z.object({ updated_by: z.uuid().nullable() }), data).updated_by
  );
}

type PagedResult = PromiseLike<{ data: unknown[] | null; error: PostgrestError | null }>;

// "빈 페이지가 나올 때까지" 이어 읽고, 다음 오프셋은 실제로 받은 행 수만큼 전진시킨다 —
// 서버 max-rows가 PAGE_SIZE보다 작아도 구멍이 생기지 않는다 (budget-details.ts fetchAllRows와 같은 전략)
async function fetchAllRows(
  table: Table,
  build: (from: number, to: number) => PagedResult
): Promise<unknown[]> {
  const rows: unknown[] = [];
  for (let from = 0; ; ) {
    const { data, error } = await build(from, from + PAGE_SIZE - 1);
    if (error) raiseDbError(error, table);
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

// 이력 표시 순서: 조직원별로 묶고 최신 적용일이 먼저 (SL-2가 고르는 방향과 같다).
// 페이징은 id 순으로 읽으므로(결정적 정렬이 없으면 range가 행을 새거나 중복시킨다) 순서는 여기서 맞춘다.
function compareSalaries(a: StaffSalary, b: StaffSalary): number {
  if (a.staffId !== b.staffId) return a.staffId < b.staffId ? -1 : 1;
  if (a.effectiveFrom !== b.effectiveFrom) return a.effectiveFrom < b.effectiveFrom ? 1 : -1;
  return a.id < b.id ? -1 : 1;
}

// ─── Staff 조회 ──────────────────────────────────────────────

export interface ListStaffOptions {
  /** false(기본)면 재직자만. 퇴사자는 목록에서 빼되 과거 과제의 연결은 그대로다 (HR-5) */
  includeRetired?: boolean;
}

/** 이름 순. 동명이인은 id로 순서를 고정한다 — 페이징 경계에서 행이 새지 않게 */
export async function listStaff(
  client: SupabaseClient,
  options: ListStaffOptions = {}
): Promise<Staff[]> {
  const rows = await fetchAllRows(STAFF_TABLE, (from, to) => {
    let query = client.from(STAFF_TABLE).select('*');
    if (!options.includeRetired) query = query.eq('employed', true);
    return query.order('name', { ascending: true }).order('id', { ascending: true }).range(from, to);
  });
  return rows.map(toStaff);
}

export async function getStaffById(client: SupabaseClient, id: string): Promise<Staff> {
  const { data, error } = await client.from(STAFF_TABLE).select('*').eq('id', id).maybeSingle();
  if (error) raiseDbError(error, STAFF_TABLE);
  if (!data) throw new NotFoundError(STAFF_NOT_FOUND_MESSAGE);
  return toStaff(data);
}

// ─── Staff 쓰기 ──────────────────────────────────────────────

// 서버 액션이 createdBy/updatedBy를 세션 사용자로 채운다 (SA-2). budget-rules.ts와 같은 형태
export type StaffInput = Omit<Staff, keyof BaseEntity> & {
  createdBy?: string | null;
  updatedBy?: string | null;
};

export type StaffPatch = Partial<Omit<Staff, keyof BaseEntity>> & {
  updatedBy?: string | null;
};

/** ST-1: email은 trim·소문자로 정규화해 저장한다. 중복이면 ConflictError */
export async function createStaff(client: SupabaseClient, input: StaffInput): Promise<Staff> {
  const payload = appToDb({ ...input, email: normalizeEmail(input.email) });
  const { data, error } = await client.from(STAFF_TABLE).insert(payload).select('*').single();
  if (error) raiseDbError(error, STAFF_TABLE);
  return toStaff(data);
}

/** SA-2: expectedVersion이 넘어오면 낙관적 잠금(§8.4 O-1), 생략하면 마지막 저장 우선(O-2) */
export async function updateStaff(
  client: SupabaseClient,
  id: string,
  patch: StaffPatch,
  expectedVersion?: number
): Promise<Staff> {
  const normalized = patch.email === undefined ? patch : { ...patch, email: normalizeEmail(patch.email) };
  const dbPatch = definedOnly(appToDb(normalized));
  if (Object.keys(dbPatch).length === 0) {
    throw new ValidationError('갱신할 내용이 없습니다.');
  }
  let query = client.from(STAFF_TABLE).update(dbPatch).eq('id', id);
  if (expectedVersion !== undefined) {
    query = query.eq('version', expectedVersion); // §8.4: 그새 바뀌었으면 0행 갱신
  }
  const { data, error } = await query.select('*');
  if (error) raiseDbError(error, STAFF_TABLE);
  const row = (data ?? [])[0];
  if (row === undefined) return raiseStaleOrNotFound(client, STAFF_TABLE, id);
  return toStaff(row);
}

/**
 * ST-2: 물리 삭제. 급여 이력은 cascade로 함께 지워지고 연결된 Member의 staffId는 null이 된다 —
 * Member의 annualSalary·스냅샷은 남는다(FK 정의). 미리 보여줄 건수는 countStaffReferences로 센다.
 */
export async function removeStaff(client: SupabaseClient, id: string): Promise<void> {
  const { data, error } = await client.from(STAFF_TABLE).delete().eq('id', id).select('id');
  if (error) raiseDbError(error, STAFF_TABLE);
  if ((data ?? []).length === 0) throw new NotFoundError(STAFF_NOT_FOUND_MESSAGE);
}

export interface StaffReferenceCounts {
  /** staff_id로 연결된 과제 인력 수 — 삭제 시 연결만 끊긴다(set null) */
  members: number;
  /** 급여 이력 수 — 삭제 시 함께 사라진다(cascade) */
  salaries: number;
}

// head + count='exact'라 행을 받지 않으므로 max-rows 절단과 무관하게 정확하다
async function countRows(
  client: SupabaseClient,
  table: 'members' | typeof SALARY_TABLE,
  staffId: string
): Promise<number> {
  const { count, error } = await client
    .from(table)
    .select('id', { count: 'exact', head: true })
    .eq('staff_id', staffId);
  if (error) raiseDbError(error, SALARY_TABLE);
  // count가 없으면 "0건"이 아니라 "세지 못했다"는 뜻이다. 0으로 채우면 삭제 확인 대화상자가
  // 영향 없음처럼 보인다 (절대 규칙 5)
  if (count === null) {
    throw new ValidationError('조직원 참조 건수를 확인하지 못했습니다. 잠시 후 다시 시도하세요.');
  }
  return count;
}

/** 삭제 확인 대화상자용 — 무엇이 몇 건 영향을 받는지 미리 보여준다 (ST-2) */
export async function countStaffReferences(
  client: SupabaseClient,
  id: string
): Promise<StaffReferenceCounts> {
  const [members, salaries] = await Promise.all([
    countRows(client, 'members', id),
    countRows(client, SALARY_TABLE, id),
  ]);
  return { members, salaries };
}

// ─── StaffSalary 조회 ────────────────────────────────────────

/** 한 조직원의 이력 전부, 적용일 내림차순 (최신이 먼저) */
export async function listSalariesByStaff(
  client: SupabaseClient,
  staffId: string
): Promise<StaffSalary[]> {
  const rows = await fetchAllRows(SALARY_TABLE, (from, to) =>
    client
      .from(SALARY_TABLE)
      .select('*')
      .eq('staff_id', staffId)
      .order('effective_from', { ascending: false })
      .order('id', { ascending: true })
      .range(from, to)
  );
  return rows.map(toSalary);
}

/**
 * 여러 조직원의 이력 — 목록 화면이 "현재 급여"(SL-2)를 한 번의 왕복으로 채우기 위함.
 * (staffId 오름차순, effectiveFrom 내림차순)으로 돌려주며, 조직원별 묶음은 호출자가 만든다.
 */
export async function listSalariesByStaffIds(
  client: SupabaseClient,
  staffIds: readonly string[]
): Promise<StaffSalary[]> {
  if (staffIds.length === 0) return [];
  const requested = new Set(staffIds);
  // 청크끼리 대상이 겹치지 않으므로 동시에 쏴도 결과가 같다 (§12)
  const pages = await Promise.all(
    chunk([...requested]).map((ids) =>
      fetchAllRows(SALARY_TABLE, (from, to) =>
        client
          .from(SALARY_TABLE)
          .select('*')
          .in('staff_id', ids)
          .order('id', { ascending: true })
          .range(from, to)
      )
    )
  );
  const salaries = pages.flat().map(toSalary);
  for (const salary of salaries) {
    // 요청하지 않은 조직원의 행 = 필터가 의도대로 걸리지 않았다는 뜻. 조용히 버리지 않는다
    if (!requested.has(salary.staffId)) {
      throw new ValidationError('요청하지 않은 조직원의 급여 이력이 반환되었습니다.');
    }
  }
  return salaries.sort(compareSalaries);
}

/** 전 조직원 이력 전량 — 참여율 합산(PS-5)·백업 외 벌크 경로용. 페이징한다 (§12) */
export async function listAllSalaries(client: SupabaseClient): Promise<StaffSalary[]> {
  const rows = await fetchAllRows(SALARY_TABLE, (from, to) =>
    client.from(SALARY_TABLE).select('*').order('id', { ascending: true }).range(from, to)
  );
  return rows.map(toSalary).sort(compareSalaries);
}

// ─── StaffSalary 쓰기 ────────────────────────────────────────

export type StaffSalaryInput = Omit<StaffSalary, keyof BaseEntity> & {
  createdBy?: string | null;
  updatedBy?: string | null;
};

// staffId는 행의 정체성이라 patch로 바꾸지 않는다 — 다른 사람에게 옮기려면 지우고 새로 넣는다
export type StaffSalaryPatch = Partial<Omit<StaffSalary, keyof BaseEntity | 'staffId'>> & {
  updatedBy?: string | null;
};

/**
 * SL-3: 새 이력을 쌓는다. 같은 (staffId, effectiveFrom)이 있으면 ConflictError —
 * 덮어쓰려면 updateSalary로 그 행을 고친다. amount < 0·잘못된 basis는 RuleViolationError.
 */
export async function createSalary(
  client: SupabaseClient,
  input: StaffSalaryInput
): Promise<StaffSalary> {
  const { data, error } = await client
    .from(SALARY_TABLE)
    .insert(appToDb(input))
    .select('*')
    .single();
  if (error) raiseDbError(error, SALARY_TABLE);
  return toSalary(data);
}

/** O-1: 이력 편집 폼은 여러 필드를 한 번에 바꾸므로 expectedVersion을 넘겨 낙관적 잠금을 건다 */
export async function updateSalary(
  client: SupabaseClient,
  id: string,
  patch: StaffSalaryPatch,
  expectedVersion?: number
): Promise<StaffSalary> {
  const dbPatch = definedOnly(appToDb(patch));
  if (Object.keys(dbPatch).length === 0) {
    throw new ValidationError('갱신할 내용이 없습니다.');
  }
  let query = client.from(SALARY_TABLE).update(dbPatch).eq('id', id);
  if (expectedVersion !== undefined) {
    query = query.eq('version', expectedVersion);
  }
  const { data, error } = await query.select('*');
  if (error) raiseDbError(error, SALARY_TABLE);
  const row = (data ?? [])[0];
  if (row === undefined) return raiseStaleOrNotFound(client, SALARY_TABLE, id);
  return toSalary(row);
}

/**
 * 물리 삭제. 과거 과제가 이 이력을 스냅샷으로 가지고 있어도 무관하다(SL-3) —
 * Member의 스냅샷 3필드는 복사본이라 여기 행이 사라져도 움직이지 않는다.
 */
export async function removeSalary(client: SupabaseClient, id: string): Promise<void> {
  const { data, error } = await client.from(SALARY_TABLE).delete().eq('id', id).select('id');
  if (error) raiseDbError(error, SALARY_TABLE);
  if ((data ?? []).length === 0) throw new NotFoundError(SALARY_NOT_FOUND_MESSAGE);
}
