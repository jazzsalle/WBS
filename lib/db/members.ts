// Member(참여인력) 리포지토리 (SOT §5.11, §6.6 H-9, §8.4, §8.6)
// H-9: 삭제 대신 active=false 권장. 삭제 시 정리할 참조는 8곳이고, 이를 한 트랜잭션으로
// 묶는 delete_member RPC(§8.3)가 정리한 건수를 돌려준다 — UI가 그대로 안내에 쓴다.
// 클라이언트는 호출자가 주입한다 — 서버 액션은 createServerClient(token), 테스트는 목/로컬.

import type { PostgrestError, SupabaseClient } from '@supabase/supabase-js';
import { z } from 'zod';
import type { BudgetDetail, Member } from '@/types';
import { memberRowSchema } from './schema';
import { appToDb, dbToApp } from './mapper';
import { listByMember } from './budget-details';
import {
  ConflictError,
  NotFoundError,
  RuleViolationError,
  StaleDataError,
  ValidationError,
} from './errors';

// N-4 공통 컬럼은 DB(트리거)와 서버 액션이 채운다 — 입력에서 제외
type BaseFieldKeys = 'id' | 'createdAt' | 'updatedAt' | 'version' | 'createdBy' | 'updatedBy';

// Phase 16(§5.11)의 조직원 연결·급여 기준 스냅샷 3필드. DB 기본값이 null(기록 없음)이라
// 입력에서 생략할 수 있다 — Phase 16 이전의 createMember 호출부가 그대로 컴파일된다.
type SnapshotKeys =
  | 'staffId'
  | 'salaryIncludesRetirement'
  | 'salaryIncludesInsurance'
  | 'salaryAppliedFrom';

// Phase 9(§5.11)의 annualSalary·hireType도 여기에 포함된다 — Member에서 파생되므로
// 필드를 다시 나열하지 않는다. snake_case 변환은 appToDb가 전담한다 (§8.6).
// annualSalary는 원 단위 정수 또는 null(미입력)이고, 값 검증은 서버 액션의 Zod 몫이다.
export type MemberInput = Omit<Member, BaseFieldKeys | SnapshotKeys> &
  Partial<Pick<Member, SnapshotKeys>>;
export type MemberPatch = Partial<MemberInput>;

/**
 * PL-10b(v4.7) — [급여 반영]이 급여 이력에서 복사하는 스냅샷. apply_salary_change의 p_snapshot과
 * 키가 같다(마이그레이션이 이 키 이름을 검사한다). 세 값이 전부 null인 객체는 "기록 없음"으로
 * 되돌리는 뜻이다 — 수동 연봉 수정 경로(§5.11).
 */
export interface MemberSalarySnapshot {
  salaryIncludesRetirement: boolean | null;
  salaryIncludesInsurance: boolean | null;
  salaryAppliedFrom: string | null;
}

// PostgREST 응답 상한(max-rows 1000)을 넘기려면 range로 이어 읽어야 한다 (§12).
// 조직원 연결 인력은 전 과제를 가로지르므로 과제 수 × 인력 수가 그대로 행 수다.
const PAGE_SIZE = 1000;
// `.in('staff_id', ...)`의 UUID가 쿼리스트링에 그대로 실린다 — 긴 URL을 만들지 않도록 청크로 나눈다
const ID_CHUNK_SIZE = 100;

// §7.14 내 프로필의 Member 연결 선택지용. app_users.member_id는 과제에 매이지 않는 링크라
// (§14.2) 전 과제 인력이 후보인데, 이름만으로는 동명이인을 구분할 수 없어 기관명을 함께 읽는다.
export interface MemberWithOrg extends Member {
  orgName: string | null;
}

// §5.19·§6.15 조직원 상세("연결 Member")·참여율 합산용. Member는 과제에 속하므로 과제 이름 없이는
// 어느 과제의 참여인지 알 수 없고, PS-4의 아카이브 제외 판정에 archived가 필요하다.
export interface MemberWithProject extends Member {
  projectName: string;
  projectArchived: boolean;
}

// H-9의 참조 8곳. RPC가 삭제 직전에 센 건수 그대로다 (조인 테이블은 삭제된 행 수).
// budgetDetails만 성격이 다르다: 나머지는 "정리되는 참조"지만 이것은 **삭제를 막는 참조**다
// (H-9a·PL-D8 — member_id가 on delete restrict). 화면이 별도 줄로 세고, 1건 이상이면
// 삭제 버튼 대신 연구비 화면 링크를 보여 준다.
export interface MemberReferenceCounts {
  tasks: number;
  taskMembers: number;
  milestones: number;
  risks: number;
  projects: number;
  achievementMembers: number;
  noteAttendees: number;
  appUsers: number;
  budgetDetails: number;
}

// ─── 파일 내부 헬퍼 ──────────────────────────────────────────

// P0001(PL/pgSQL raise exception) 해석 규칙. budget-details.ts와 **같은 규약**을 쓴다 —
// PostgREST는 모든 raise exception을 P0001 하나로 내려보내므로 코드만으로는 낙관적 잠금 실패와
// 규칙 위반을 가를 수 없다. 전부 RuleViolationError로 보내면 apply_salary_change의 version
// 불일치가 RULE로 보고돼 §8.4 O-3 충돌 다이얼로그가 뜨지 않는다.
// H-9a 거부 문구('인건비 산출근거 N건이 …')는 두 패턴 어디에도 걸리지 않아 RULE로 간다 — 의도된 것이다.
const STALE_MESSAGE_PATTERN = /먼저 수정|stale/i;
const NOT_FOUND_MESSAGE_PATTERN = /찾을 수 없습니다|not found/i;

// 23505(유니크 충돌)와 P0001(RPC raise exception)만 의미를 부여하고, 나머지는 일반 Error로
// 던져 toActionFailure가 테이블·제약명 노출을 막게 한다 (SA-4). 무음 처리는 없다.
function throwDbError(error: PostgrestError): never {
  if (error.code === '23505') throw new ConflictError();
  if (error.code === 'P0001') {
    // O-3 표시용 updated_by는 예외에 실려 오지 않는다 — 필요한 호출부가 행을 한 번 더 읽어 채운다
    if (STALE_MESSAGE_PATTERN.test(error.message)) throw new StaleDataError();
    if (NOT_FOUND_MESSAGE_PATTERN.test(error.message)) throw new NotFoundError(error.message);
    throw new RuleViolationError(error.message);
  }
  throw new Error(`[db] ${error.code}: ${error.message}`);
}

// DB 응답 검증 실패 = 스키마 드리프트 신호. 조용히 넘기지 않는다 (§8.6, 절대 규칙 5).
function parseRow<T>(schema: z.ZodType<T>, row: unknown): T {
  const result = schema.safeParse(row);
  if (!result.success) {
    console.error('[db] members 응답 스키마 검증 실패:', result.error.issues);
    throw new ValidationError('저장소 응답이 기대 스키마와 다릅니다. 앱과 DB 버전을 확인하세요.');
  }
  return result.data;
}

// 0행 갱신의 원인 구분: 행이 없으면 NotFound, 있으면 version 불일치(§8.4).
// O-3: 최신 updated_by를 담아 "OO님이 먼저 수정했습니다"를 표시할 수 있게 한다.
async function throwStaleOrNotFound(client: SupabaseClient, id: string): Promise<never> {
  const { data, error } = await client
    .from('members')
    .select('updated_by')
    .eq('id', id)
    .maybeSingle();
  if (error) throwDbError(error);
  if (!data) throw new NotFoundError('참여인력을 찾을 수 없습니다.');
  throw new StaleDataError(parseRow(z.object({ updated_by: z.uuid().nullable() }), data).updated_by);
}

function toMember(row: unknown): Member {
  return dbToApp<Member>(parseRow(memberRowSchema, row));
}

// members.org_id → organizations 임베드. 관계가 끊긴 인력(org_id=null)은 null로 온다.
const memberWithOrgRowSchema = memberRowSchema.extend({
  organizations: z.object({ name: z.string() }).nullable(),
});

function toMemberWithOrg(row: unknown): MemberWithOrg {
  const { organizations, ...memberRow } = parseRow(memberWithOrgRowSchema, row);
  return { ...dbToApp<Member>(memberRow), orgName: organizations?.name ?? null };
}

// members.project_id → projects 임베드. project_id는 not null이라 임베드도 항상 온다 —
// null이면 RLS나 스키마가 어긋난 것이므로 검증 실패로 드러낸다.
// members↔projects는 관계가 둘이다(projects.pm_member_id 역방향). PostgREST가 PGRST201로 거부하므로
// FK 제약 이름으로 방향을 고정한다 — 초기 스키마의 자동 명명(members_project_id_fkey)이 바뀌면 여기도 바꾼다.
const MEMBER_WITH_PROJECT_SELECT = '*, projects!members_project_id_fkey (name, archived)';
const memberWithProjectRowSchema = memberRowSchema.extend({
  projects: z.object({ name: z.string(), archived: z.boolean() }),
});

function toMemberWithProject(row: unknown): MemberWithProject {
  const { projects, ...memberRow } = parseRow(memberWithProjectRowSchema, row);
  return {
    ...dbToApp<Member>(memberRow),
    projectName: projects.name,
    projectArchived: projects.archived,
  };
}

type PagedResult = PromiseLike<{ data: unknown[] | null; error: PostgrestError | null }>;

// "빈 페이지가 나올 때까지" 이어 읽고, 다음 오프셋은 실제로 받은 행 수만큼 전진시킨다 —
// 서버 max-rows가 PAGE_SIZE보다 작아도 구멍이 생기지 않는다 (budget-details.ts fetchAllRows와 같은 전략)
async function fetchAllRows(build: (from: number, to: number) => PagedResult): Promise<unknown[]> {
  const rows: unknown[] = [];
  for (let from = 0; ; ) {
    const { data, error } = await build(from, from + PAGE_SIZE - 1);
    if (error) throwDbError(error);
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

// 페이징은 id 순으로 읽으므로 표시 순서는 여기서 맞춘다: 과제 이름 → 인력 이름 → id
function compareByProjectThenName(a: MemberWithProject, b: MemberWithProject): number {
  if (a.projectName !== b.projectName) return a.projectName < b.projectName ? -1 : 1;
  if (a.name !== b.name) return a.name < b.name ? -1 : 1;
  return a.id < b.id ? -1 : 1;
}

// RPC가 돌려주는 jsonb는 DB 표기(snake_case)다 — 케이스 변환은 매퍼에만 맡긴다.
const memberReferenceCountsRowSchema = z.object({
  tasks: z.number().int().nonnegative(),
  task_members: z.number().int().nonnegative(),
  milestones: z.number().int().nonnegative(),
  risks: z.number().int().nonnegative(),
  projects: z.number().int().nonnegative(),
  achievement_members: z.number().int().nonnegative(),
  note_attendees: z.number().int().nonnegative(),
  app_users: z.number().int().nonnegative(),
  // H-9a: 인건비 산출근거 건수. 다른 항목과 달리 이 값이 0이 아니면 삭제가 거부된다
  budget_details: z.number().int().nonnegative(),
});

function toReferenceCounts(payload: unknown): MemberReferenceCounts {
  return dbToApp<MemberReferenceCounts>(parseRow(memberReferenceCountsRowSchema, payload));
}

// ─── CRUD ────────────────────────────────────────────────────

export async function listMembers(client: SupabaseClient, projectId: string): Promise<Member[]> {
  const { data, error } = await client
    .from('members')
    .select('*')
    .eq('project_id', projectId)
    .order('sort_order', { ascending: true });
  if (error) throwDbError(error);
  if (!data) throw new Error('[db] members 조회 응답이 비어 있습니다.');
  return data.map(toMember);
}

// 전 과제 인력. listMembers는 projectId가 필수라 과제 경계를 넘는 선택지를 만들 수 없다.
// sort_order는 과제 안에서만 의미가 있으므로(H-10) 여기서는 이름순으로 읽는다 —
// 같은 이름이 여럿이면 화면이 기관명을 붙여 구분한다.
export async function listAllMembers(client: SupabaseClient): Promise<MemberWithOrg[]> {
  const { data, error } = await client
    .from('members')
    .select('*, organizations (name)')
    .order('name', { ascending: true });
  if (error) throwDbError(error);
  if (!data) throw new Error('[db] members 전체 조회 응답이 비어 있습니다.');
  return data.map(toMemberWithOrg);
}

/**
 * 조직원들에게 연결된 전 과제 인력 (§5.19 상세 "연결 Member", §7.9.6 PS-6 다른 과제 합계).
 * 과제 경계를 넘으므로 sort_order는 의미가 없다 — 과제 이름 → 인력 이름 순으로 돌려준다.
 */
export async function listMembersByStaffIds(
  client: SupabaseClient,
  staffIds: readonly string[]
): Promise<MemberWithProject[]> {
  if (staffIds.length === 0) return [];
  const requested = new Set(staffIds);
  // 청크끼리 대상이 겹치지 않으므로 동시에 쏴도 결과가 같다
  const pages = await Promise.all(
    chunk([...requested]).map((ids) =>
      fetchAllRows((from, to) =>
        client
          .from('members')
          .select(MEMBER_WITH_PROJECT_SELECT)
          .in('staff_id', ids)
          .order('id', { ascending: true })
          .range(from, to)
      )
    )
  );
  const rows = pages.flat().map(toMemberWithProject);
  for (const row of rows) {
    // 요청하지 않은 조직원의 행 = 필터가 의도대로 걸리지 않았다는 뜻. 조용히 버리지 않는다
    if (row.staffId === null || !requested.has(row.staffId)) {
      throw new ValidationError('요청하지 않은 조직원의 참여인력이 반환되었습니다.');
    }
  }
  return rows.sort(compareByProjectThenName);
}

/**
 * PS-5 — 조직원이 연결된(staff_id not null) 전 과제 인력 전량. 참여율 합산의 입력이며
 * 아카이브 제외(PS-4)는 projectArchived로 호출자가 가른다. 페이징한다 (§12).
 */
export async function listLinkedMembersAll(client: SupabaseClient): Promise<MemberWithProject[]> {
  const rows = await fetchAllRows((from, to) =>
    client
      .from('members')
      .select(MEMBER_WITH_PROJECT_SELECT)
      .not('staff_id', 'is', null)
      .order('id', { ascending: true })
      .range(from, to)
  );
  return rows.map(toMemberWithProject).sort(compareByProjectThenName);
}

export async function getMemberById(client: SupabaseClient, id: string): Promise<Member> {
  const { data, error } = await client.from('members').select('*').eq('id', id).maybeSingle();
  if (error) throwDbError(error);
  if (!data) throw new NotFoundError('참여인력을 찾을 수 없습니다.');
  return toMember(data);
}

export async function createMember(
  client: SupabaseClient,
  input: MemberInput,
  createdBy: string | null
): Promise<Member> {
  const { data, error } = await client
    .from('members')
    .insert({ ...appToDb(input), created_by: createdBy, updated_by: createdBy })
    .select()
    .single();
  if (error) throwDbError(error);
  return toMember(data);
}

// SA-2: expectedVersion이 넘어오면 낙관적 잠금(§8.4 O-1), 생략하면 마지막 저장 우선(O-2)
export async function updateMember(
  client: SupabaseClient,
  id: string,
  patch: MemberPatch,
  updatedBy: string | null,
  expectedVersion?: number
): Promise<Member> {
  let query = client
    .from('members')
    .update({ ...appToDb(patch), updated_by: updatedBy })
    .eq('id', id);
  if (expectedVersion !== undefined) query = query.eq('version', expectedVersion);
  const { data, error } = await query.select().maybeSingle();
  if (error) throwDbError(error);
  if (!data) return throwStaleOrNotFound(client, id);
  return toMember(data);
}

/**
 * PL-10b — 연봉 변경이 파급되는 인건비 산출근거 전량 (연차·비목·현재 amount·근거 필드 포함).
 * 서버 액션이 이 행들로 새 amount를 계산해 previewSalaryChange의 전후 비교를 만들고,
 * 사용자가 확인하면 같은 값으로 저장한다 (§7.10 — 조용히 바꾸지 않는다).
 *
 * 인력 화면이 연구비 리포지토리를 직접 알 필요가 없도록 여기서 한 번 감싼다.
 * 질의 자체는 budget-details.ts 한 곳에만 둔다 — 같은 조회가 두 곳에 생기면 어긋난다.
 */
export async function listSalaryImpactedDetails(
  client: SupabaseClient,
  memberId: string
): Promise<BudgetDetail[]> {
  return listByMember(client, memberId);
}

/** apply_salary_change의 p_amounts 한 항목. amount는 액션이 lib/budget-plan.ts로 계산한 값이다 */
export interface SalaryDetailAmount {
  id: string;
  amount: number;
}

export interface SalaryChangeResult {
  memberId: string;
  projectId: string;
  /** 금액이 다시 계산된 산출근거 행 수 */
  updated: number;
  /** 총액을 다시 맞춘 (연차 × 비목) 셀 수 */
  cells: number;
}

// 이 RPC는 jsonb 키를 이미 camelCase로 돌려준다(마이그레이션 참고) — 매퍼를 태우지 않는다
const salaryChangeResultSchema = z.object({
  memberId: z.uuid(),
  projectId: z.uuid(),
  updated: z.number().int().nonnegative(),
  cells: z.number().int().nonnegative(),
});

/**
 * PL-10b — 연봉 저장 + 인건비 행 금액 + 관련 budget_items를 한 트랜잭션으로 적용한다.
 *
 * `amounts`는 **그 인력의 산출근거 전량**이어야 한다(집합 일치). 일부만 보내면 RPC가 거부한다 —
 * 부분 갱신은 비목 총액이 근거와 어긋난 채 남는다는 뜻이기 때문이다.
 * PL-10a: 금액은 여기서 계산하지 않는다. 서버 액션이 computeDetailAmount로 계산해 넘긴 값을 적용만 한다.
 *
 * 확인 절차(영향 건수·전후 금액)는 액션의 previewSalaryChange가 담당한다 (§7.10).
 *
 * `snapshot`(PL-10b v4.7)이 있으면 연봉을 갱신하는 **같은 UPDATE**에서 스냅샷 3컬럼을 세팅한다 —
 * 따로 쓰면 RPC 실패 시 "적용 이력은 새 값, 연봉은 옛 값"인 행이 남는다. 생략하면 스냅샷은 그대로다.
 */
export async function applySalaryChange(
  client: SupabaseClient,
  memberId: string,
  annualSalary: number | null,
  amounts: readonly SalaryDetailAmount[],
  expectedVersion?: number,
  snapshot?: MemberSalarySnapshot
): Promise<SalaryChangeResult> {
  const { data, error } = await client.rpc('apply_salary_change', {
    p_member_id: memberId,
    p_annual_salary: annualSalary,
    p_amounts: amounts,
    p_expected_version: expectedVersion ?? null,
    // 객체 그대로 보낸다 — 문자열화하면 RPC가 jsonb 객체 대신 jsonb 문자열을 받아
    // "스냅샷이 객체가 아닙니다"로 거부한다 (마이그레이션 6절 주석)
    p_snapshot: snapshot ?? null,
  });
  if (error) {
    // O-1: 잠금 실패는 P0001로만 오므로 메시지로 가른 뒤 updated_by를 채워 던진다 (O-3)
    if (error.code === 'P0001' && STALE_MESSAGE_PATTERN.test(error.message)) {
      await throwStaleOrNotFound(client, memberId);
    }
    throwDbError(error);
  }
  return parseRow(salaryChangeResultSchema, data);
}

// 삭제 확인 대화상자용 — 어떤 참조가 몇 건 정리되는지 미리 보여준다 (H-9).
// budgetDetails가 1건 이상이면 removeMember는 H-9a로 거부된다 — 대화상자가 미리 막는다.
export async function countMemberReferences(
  client: SupabaseClient,
  id: string
): Promise<MemberReferenceCounts> {
  const { data, error } = await client.rpc('count_member_references', { p_member_id: id });
  if (error) throwDbError(error);
  return toReferenceCounts(data);
}

// H-9: 참조 8곳 정리(set null 4곳 + cascade 3곳 + app_users)를 한 트랜잭션으로 묶고
// 정리된 건수를 돌려준다 (§8.3). 대상이 없으면 RPC가 실패한다 — 무음 삭제는 없다.
// H-9a: 인건비 산출근거가 1건이라도 있으면 RPC가 거부한다(RuleViolationError) —
// 사람을 지운 조작만으로 비목 총액이 줄어드는 것을 막기 위해서다 (PL-D8).
export async function removeMember(
  client: SupabaseClient,
  id: string
): Promise<MemberReferenceCounts> {
  const { data, error } = await client.rpc('delete_member', { p_member_id: id });
  if (error) throwDbError(error);
  return toReferenceCounts(data);
}

// H-10, X-3: orderedIds는 과제의 인력 목록 순서다. 한 번의 RPC로 0..n-1을 부여한다.
export async function reorderMembers(
  client: SupabaseClient,
  projectId: string,
  orderedIds: string[]
): Promise<void> {
  const { error } = await client.rpc('reorder_members', {
    p_project_id: projectId,
    p_ordered_ids: orderedIds,
  });
  if (error) throwDbError(error);
}
