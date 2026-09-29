// import_snapshots 리포지토리 (SOT §6.8.5 I-17·I-18, §7.14, §8.6)
//
// 임포트 반영 전 계획액 스냅샷. 행을 직접 만들지 않는다 — 스냅샷은 commit_import RPC가
// 반영과 **같은 트랜잭션**에서 기록한다(I-17). 여기서 제공하는 쓰기 통로는 RPC 호출과
// 삭제뿐이다. UI·서버 액션은 supabase 클라이언트를 직접 부르지 않으므로(절대 규칙 3)
// 이 파일이 임포트 반영·복원의 유일한 통로다.

import type { PostgrestError, SupabaseClient } from '@supabase/supabase-js';
import { z } from 'zod';
import type {
  BudgetCategory,
  DetailAxis,
  DetailFactor,
  DetailFormula,
  DeliverableType,
  Direction,
  HireType,
  ImportSnapshot,
  MeasureMethod,
  MemberRole,
} from '@/types';
import { dbToApp, dbToAppArray } from './mapper';
import { importSnapshotRowSchema } from './schema';
import { ConflictError, NotFoundError, RuleViolationError, ValidationError } from './errors';

const TABLE = 'import_snapshots';

// commit_import RPC에 넘기는 행 (§9 Budget Import). 파싱 결과의 최종 형태이고
// (yearId, category)는 S-8 합산 후라 유일하다 — 중복이 오면 RPC가 거부한다.
export interface ImportCommitRow {
  yearId: string;
  category: BudgetCategory;
  plannedAmount: number;             // 원 단위 정수 (절대 규칙 4)
  cashAmount: number | null;
  inKindAmount: number | null;
}

// 스냅샷 메타 — 어떤 파일이 어떤 프로파일로 반영됐는지 남긴다
export interface ImportCommitSource {
  fileName: string;
  sheetName: string;
  profileId: string | null;
  fileHash: string;
}

export interface ImportCommitResult {
  snapshotId: string;
  updated: number;                   // 실제로 쓴 (연차, 비목) 셀 수
  locked: number;                    // S-14: 산출근거가 있어 덮어쓰지 않은 셀 수.
                                     // 오류가 아니라 정상 결과의 일부다 — 반영 후 안내에 쓴다
}

export interface ImportRestoreResult {
  snapshotId: string;
  restored: number;                  // 되돌린 (연차, 비목) 셀 수 — budget_items 기준
  // ─ D-17a: `details` 키가 있는 산출근거 스냅샷에서만 채워진다 ─
  // 총괄표 스냅샷(details 키 없음)의 반환은 종전과 완전히 같아야 하므로 선택 필드다.
  detailsDeleted?: number;           // 복원 전에 지운 현재 산출근거 행 수 (I-17의 명시적 예외)
  detailsRestored?: number;          // 되살린 스냅샷 산출근거 행 수
  cells?: number;                    // 산출근거를 다시 계산한 (연차, 비목) 셀 수
}

// ─── §6.17 GF-5·GF-11 목표 양식 반영 (Phase 21) ──────────────

/**
 * 모든 행 타입은 **RPC 페이로드 그대로**라 DB 표기(snake_case)다. RPC는 필드 키가 하나라도
 * 빠지면 거부한다 — 기본값이 조용히 들어가면 측정값 0처럼 달성률이 왜곡되기 때문이다.
 * 그래서 선택(?) 필드를 두지 않고 nullable 컬럼만 `| null`이다.
 *
 * `target_by_year`: `_meta.yearIds` 키 전부를 싣는다. null은 "그 키 삭제"이고 싣지 않은
 * 기존 키는 보존된다(S-13). 추가 행에서는 RPC가 null 키를 버린다.
 */
export type GoalFormTargetByYear = Record<string, number | null>;

export interface GoalFormDeliverableFields {
  type: DeliverableType;
  name: string;
  unit: string;
  weight: number;                    // 0 이상
  target_total: number;              // 건수 — 0 이상 정수
  target_by_year: GoalFormTargetByYear; // 값도 0 이상 정수
  org_id: string | null;
  evidence_method: string;
  note: string;
}

// row_key("row:<n>")는 같은 반영의 새 실적이 deliverable_ref로 가리키는 임시 키다(GF-10)
export interface GoalFormDeliverableAddRow extends GoalFormDeliverableFields {
  row_key?: string | null;
}

export interface GoalFormDeliverableUpdateRow extends GoalFormDeliverableFields {
  id: string;
}

export interface GoalFormAchievementFields {
  title: string;
  date: string;                      // 'YYYY-MM-DD'
  year_id: string | null;
  org_id: string | null;
  member_ids: string[];              // update는 전체 교체(빈 배열 = 관여자 없음)
  evidence_url: string;
  note: string;
}

// 부모는 기존 지표(deliverable_id) 또는 새 지표의 임시 키(deliverable_ref) 중 **정확히 하나**다.
// 유니온으로 둬 둘 다 싣거나 둘 다 빠진 페이로드를 타입 단계에서 막는다
export type GoalFormAchievementAddRow = GoalFormAchievementFields &
  (
    | { deliverable_id: string; deliverable_ref?: never }
    | { deliverable_ref: string; deliverable_id?: never }
  );

// deliverable_id는 현재 부모여야 한다 — 다르면 RPC가 parent-moved로 거부한다
export interface GoalFormAchievementUpdateRow extends GoalFormAchievementFields {
  id: string;
  deliverable_id: string;
}

export interface GoalFormTechTargetFields {
  name: string;
  group_name: string;
  unit: string;
  direction: Direction;
  weight: number;                    // 0 이상 (DB check가 아니라 RPC가 막는다)
  target_value: number;              // null 불가
  target_by_year: GoalFormTargetByYear;
  baseline_domestic: number | null;
  world_best: number | null;
  world_best_holder: string;
  measure_method: MeasureMethod;
  measure_description: string;
  standard_basis: string;
  basis_rationale: string;
  evaluation_environment: string;
  org_id: string | null;
  note: string;
}

export interface GoalFormTechTargetAddRow extends GoalFormTechTargetFields {
  row_key?: string | null;
}

export interface GoalFormTechTargetUpdateRow extends GoalFormTechTargetFields {
  id: string;
}

export interface GoalFormRecordFields {
  value: number;                     // null 불가
  date: string;                      // 'YYYY-MM-DD'
  year_id: string | null;
  method: MeasureMethod;
  evaluator: string;
  evidence_url: string;
  note: string;
}

export type GoalFormRecordAddRow = GoalFormRecordFields &
  (
    | { tech_target_id: string; tech_target_ref?: never }
    | { tech_target_ref: string; tech_target_id?: never }
  );

export interface GoalFormRecordUpdateRow extends GoalFormRecordFields {
  id: string;
  tech_target_id: string;            // 현재 부모
}

// 종류별 블록. RPC는 키 생략을 빈 배열로 보지만 래퍼 호출자는 셋 다 명시한다
export interface GoalFormCommitBlock<A, U> {
  adds: A[];
  updates: U[];
  deleteIds: string[];               // [삭제 포함]을 켰을 때만 채운다 — 판정은 서버 액션의 몫
}

export interface GoalFormCommitPayload {
  deliverables: GoalFormCommitBlock<GoalFormDeliverableAddRow, GoalFormDeliverableUpdateRow>;
  achievements: GoalFormCommitBlock<GoalFormAchievementAddRow, GoalFormAchievementUpdateRow>;
  techTargets: GoalFormCommitBlock<GoalFormTechTargetAddRow, GoalFormTechTargetUpdateRow>;
  records: GoalFormCommitBlock<GoalFormRecordAddRow, GoalFormRecordUpdateRow>;
}

// GF-5: 충돌 기준은 **내려받은 시점**의 version(_meta)이다. 변경·삭제 대상 전부와
// 삭제할 부모의 현재 자식 전부를 담아야 한다(S-6②) — 빠지면 RPC가 거부하거나 conflict로 돌린다
export type GoalFormExpected = Record<string, number>;

// 우리 양식은 프로파일을 쓰지 않는다 — 스냅샷의 profileId는 RPC가 null로 채운다
export interface GoalFormSource {
  fileName: string;
  sheetName: string;
  fileHash: string;
}

export type GoalFormKind = 'deliverable' | 'achievement' | 'techTarget' | 'record';

export interface GoalFormConflict {
  kind: GoalFormKind;                // `_meta` 접두어와 같다
  id: string;
  reason: 'changed' | 'deleted';
}

export interface GoalFormKindCounts {
  added: number;
  updated: number;
  deleted: number;                   // deleteIds로 지운 행만. cascade된 자식은 스냅샷에만 남는다
}

export interface GoalFormCommitResult {
  snapshotId: string;
  deliverables: GoalFormKindCounts;
  achievements: GoalFormKindCounts;
  techTargets: GoalFormKindCounts;
  records: GoalFormKindCounts;
  // version이 달라 건너뛴 변경·삭제. 오류가 아니라 정상 결과의 일부다(전체 롤백 아님, GF-5)
  conflicts: GoalFormConflict[];
}

// ─── §6.11 산출근거 시트 임포트 (Phase 10) ───────────────────

/**
 * D-12 — 반영 시점에 만드는 새 인력. **RPC 페이로드 그대로다**:
 * `tempKey`만 행이 참조하는 임시 키이고 나머지는 DB 표기(snake_case)다.
 * 연봉·직위는 파일에서 오고, 임포트가 **기존 Member의 연봉은 고치지 않는다**(D-14).
 */
export interface DetailImportNewMember {
  tempKey: string;                   // p_rows[].memberTempKey가 가리키는 키. 유일해야 한다
  name: string;
  position: string;
  annual_salary: number | null;      // 원 단위 정수 (절대 규칙 4). 미입력은 null
  hire_type: HireType;               // 파일의 인력구분(기존인력/신규채용)에서 정한다
  org_id: string | null;
  role?: MemberRole;                 // 파일에 없는 값이라 생략하면 RPC가 'researcher'로 둔다
}

/**
 * 반영할 산출근거 행. **RPC 페이로드 그대로**라 budget_details의 DB 표기(snake_case)이고,
 * 아직 존재하지 않는 인력을 가리키는 `memberTempKey`만 얹는다.
 *
 * `amount`는 서버 액션이 `lib/budget-plan.ts`로 계산해 넣은 값이며 **RPC는 그대로 저장한다**
 * (PL-10a — 산식은 한 곳에만 있다). 리포지토리도 어떤 금액 연산도 하지 않는다.
 */
export interface DetailImportRow {
  category: BudgetCategory;
  subcategory: string;               // 부록 A.5 세목 코드. 세목이 없는 비목은 'default'
  axis: DetailAxis;
  formula: DetailFormula;
  amount: number;                    // 원 단위 정수
  member_id?: string | null;         // 기존 인력 (formula='personnel' 전용)
  memberTempKey?: string | null;     // 새 인력 (D-12). member_id와 함께 쓸 수 없다
  name?: string;
  spec?: string;
  note?: string;
  unit_price?: number;
  factors?: DetailFactor[];
  adjustment?: number;               // 음수 허용 (PL-D5)
  sort_order?: number;
}

// D-20: 산출근거 임포트는 프로파일을 저장하지 않으므로 profileId가 없다
export interface DetailImportSource {
  fileName: string;
  sheetName: string;
  fileHash: string;
}

export interface DetailImportCommitResult {
  snapshotId: string;
  inserted: number;                  // 새로 만든 산출근거 행 수
  deleted: number;                   // D-15 교체로 지운 기존 행 수
  membersCreated: number;            // D-12로 만든 인력 수
  cells: number;                     // 총액을 다시 계산한 (연차, 비목) 셀 수
  skippedLocked: number;             // D-15a: 커밋 시점에 기존 행이 생겨 건너뛴 셀 수.
                                     // 오류가 아니라 정상 결과의 일부다 — 반영 후 안내에 쓴다
}

// 23505(unique 충돌)만 의미 있는 코드로 바꾸고 나머지는 그대로 던진다 —
// RepositoryError가 아닌 예외는 toActionFailure가 내부 정보를 감춘다 (SA-4).
function throwDbError(error: PostgrestError): never {
  if (error.code === '23505') throw new ConflictError();
  throw error;
}

// RPC의 raise exception(P0001)은 규칙 위반이다 — 일반 Error로 뭉개면 UI가 안내를 못 한다.
// commit_import/restore_import_snapshot의 거부 사유는 전부 사용자에게 보여줄 문장이다.
function throwRpcError(error: PostgrestError): never {
  if (error.code === 'P0001') throw new RuleViolationError(error.message);
  throwDbError(error);
}

// DB 응답 검증 실패 = 스키마 드리프트 신호. 조용히 넘기지 않는다 (§8.6, 절대 규칙 5).
function parseRow<T>(schema: z.ZodType<T>, row: unknown): T {
  const result = schema.safeParse(row);
  if (!result.success) {
    throw new ValidationError('DB 응답이 스키마와 일치하지 않습니다. 마이그레이션 누락 가능성이 있습니다.');
  }
  return result.data;
}

// RPC 반환 jsonb도 검증한다 — 마이그레이션이 덜 적용된 DB는 다른 모양을 돌려준다
const commitResultSchema = z.object({
  snapshotId: z.uuid(),
  updated: z.number(),
  locked: z.number(), // S-14. 선택으로 두면 마이그레이션이 덜 적용된 DB에서 잠김이 0으로 보인다
});
const detailCommitResultSchema = z.object({
  snapshotId: z.uuid(),
  inserted: z.number(),
  deleted: z.number(),
  membersCreated: z.number(),
  cells: z.number(),
  skippedLocked: z.number(), // D-15a. 선택으로 두면 건너뜀이 0으로 보여 사용자가 알 수 없다
});
// D-17a: 산출근거 스냅샷 복원만 details 관련 값을 싣는다. 총괄표 스냅샷의 반환은
// 종전과 같은 두 키뿐이라 선택 필드로 둔다 — 필수로 두면 기존 복원이 스키마 오류가 된다
const restoreResultSchema = z.object({
  snapshotId: z.uuid(),
  restored: z.number(),
  detailsDeleted: z.number().optional(),
  detailsRestored: z.number().optional(),
  cells: z.number().optional(),
});
const goalFormKindCountsSchema = z.object({
  added: z.number(),
  updated: z.number(),
  deleted: z.number(),
});
// GF-5. conflicts를 선택으로 두면 마이그레이션이 덜 적용된 DB에서 충돌이 0건으로 보인다
const goalFormCommitResultSchema = z.object({
  snapshotId: z.uuid(),
  deliverables: goalFormKindCountsSchema,
  achievements: goalFormKindCountsSchema,
  techTargets: goalFormKindCountsSchema,
  records: goalFormKindCountsSchema,
  conflicts: z.array(
    z.object({
      kind: z.enum(['deliverable', 'achievement', 'techTarget', 'record']),
      id: z.uuid(),
      reason: z.enum(['changed', 'deleted']),
    })
  ),
});

// commit_goal_form의 raise 해석 (lib/db/budget-details.ts와 같은 규약):
//   · /찾을 수 없습니다|not found/i → NotFoundError (과제가 사라진 경우)
//   · 그 외 P0001                  → RuleViolationError (과제 경계·연차·기관 위반 등)
// 기존 throwRpcError는 바꾸지 않는다 — commit_import·복원의 예외 종류가 달라지면 안 된다
const NOT_FOUND_MESSAGE_PATTERN = /찾을 수 없습니다|not found/i;

function throwFormRpcError(error: PostgrestError): never {
  if (error.code === 'P0001' && NOT_FOUND_MESSAGE_PATTERN.test(error.message)) {
    throw new NotFoundError(error.message);
  }
  throwRpcError(error);
}

// §7.14 설정 화면 목록. 최신순 — 되돌릴 대상은 거의 항상 방금 한 반영이다.
// 20개 상한은 commit_import RPC가 유지하므로 여기서 자르지 않는다 (I-17).
export async function listImportSnapshots(
  client: SupabaseClient,
  projectId: string
): Promise<ImportSnapshot[]> {
  const { data, error } = await client
    .from(TABLE)
    .select('*')
    .eq('project_id', projectId)
    .order('created_at', { ascending: false })
    .order('id', { ascending: false }); // 같은 트랜잭션 내 동시 생성 시 순서 고정
  if (error) throwDbError(error);
  return dbToAppArray<ImportSnapshot>(parseRow(z.array(importSnapshotRowSchema), data ?? []));
}

export async function getImportSnapshotById(
  client: SupabaseClient,
  id: string
): Promise<ImportSnapshot> {
  const { data, error } = await client.from(TABLE).select('*').eq('id', id).maybeSingle();
  if (error) throwDbError(error);
  if (!data) throw new NotFoundError('스냅샷을 찾을 수 없습니다.');
  return dbToApp<ImportSnapshot>(parseRow(importSnapshotRowSchema, data));
}

// I-18: 단일 RPC 트랜잭션. 한 행이라도 실패하면 전체 롤백이라 부분 반영이 없다.
// I-17: 반영 전 계획액 스냅샷도 같은 트랜잭션에서 기록된다.
// S-9: rows에 없는 (연차, 비목)의 기존 계획액은 건드리지 않는다.
export async function commitImport(
  client: SupabaseClient,
  projectId: string,
  rows: ImportCommitRow[],
  source: ImportCommitSource
): Promise<ImportCommitResult> {
  const { data, error } = await client.rpc('commit_import', {
    p_project_id: projectId,
    p_rows: rows,
    p_source: source,
  });
  if (error) throwRpcError(error);
  const result = commitResultSchema.safeParse(data);
  if (!result.success) {
    console.error('[db] commit_import 반환값이 기대 형식과 다릅니다:', data);
    throw new ValidationError('저장소 응답이 기대 스키마와 다릅니다. 앱과 DB 버전을 확인하세요.');
  }
  return result.data;
}

/**
 * §6.11.5 산출근거 시트 반영. 새 인력 생성(D-12)·셀 교체(D-15)·행 삽입·`budget_items`
 * 재계산(PL-10)·스냅샷(D-17)이 **한 트랜잭션**이다 (D-16). 한 행이라도 실패하면
 * 새로 만든 인력까지 함께 롤백된다.
 *
 * D-15a: 교체로 지정되지 않았는데 커밋 시점에 기존 행이 생긴 셀은 **건너뛰고**
 * `skippedLocked`로 센다. 예외가 아니다 — 한 셀 때문에 나머지 수십 행을 버리지 않는다.
 *
 * PL-10a: `rows[].amount`는 이미 `lib/budget-plan.ts`가 계산한 값이고 RPC는 그대로 저장한다.
 */
export async function commitDetailImport(
  client: SupabaseClient,
  projectId: string,
  yearId: string,
  newMembers: DetailImportNewMember[],
  rows: DetailImportRow[],
  replaceCategories: BudgetCategory[],
  source: DetailImportSource
): Promise<DetailImportCommitResult> {
  const { data, error } = await client.rpc('commit_detail_import', {
    p_project_id: projectId,
    p_year_id: yearId,
    p_new_members: newMembers,
    p_rows: rows,
    p_replace_categories: replaceCategories,
    p_source: source,
  });
  if (error) throwRpcError(error);
  const result = detailCommitResultSchema.safeParse(data);
  if (!result.success) {
    console.error('[db] commit_detail_import 반환값이 기대 형식과 다릅니다:', data);
    throw new ValidationError('저장소 응답이 기대 스키마와 다릅니다. 앱과 DB 버전을 확인하세요.');
  }
  return result.data;
}

/**
 * §6.17 GF-5 목표 양식 반영. 네 종류의 삭제(자식 → 부모)·변경(부모 → 자식)·추가(부모 → 자식)와
 * 스냅샷(`kind: 'goal_form'`, GF-11)이 **한 트랜잭션**이다. version이 `expected`와 다른
 * 변경·삭제는 그 행만 건너뛰고 `conflicts`로 돌아온다(예외가 아니다). 과제 경계·연차·기관·
 * 인력 변경·parent-moved 위반은 전체 롤백이다.
 *
 * 예외는 과제 없음만 NotFoundError, 나머지 RULE이다(throwFormRpcError).
 */
export async function commitGoalForm(
  client: SupabaseClient,
  projectId: string,
  payload: GoalFormCommitPayload,
  expected: GoalFormExpected,
  source: GoalFormSource
): Promise<GoalFormCommitResult> {
  const { data, error } = await client.rpc('commit_goal_form', {
    p_project_id: projectId,
    p_deliverables: payload.deliverables,
    p_achievements: payload.achievements,
    p_tech_targets: payload.techTargets,
    p_records: payload.records,
    p_expected: expected,
    p_source: source,
  });
  if (error) throwFormRpcError(error);
  const result = goalFormCommitResultSchema.safeParse(data);
  if (!result.success) {
    console.error('[db] commit_goal_form 반환값이 기대 형식과 다릅니다:', data);
    throw new ValidationError('저장소 응답이 기대 스키마와 다릅니다. 앱과 DB 버전을 확인하세요.');
  }
  return result.data;
}

// §7.14: 스냅샷 시점의 계획액으로 되돌린다. 역시 단일 트랜잭션 + 과제 경계 검증.
// D-17a: 스냅샷에 `details` 키가 있으면 산출근거 행까지 되돌린다 — 그 셀의 현재 행을
// 지우고 스냅샷 행을 되살린다(I-17 "복원이 행을 삭제하지 않는다"의 명시적 예외).
// `budget_items` 행 자체는 여전히 지우지 않는다.
// GF-11(S-3): `goals` 키가 있는 목표 양식 스냅샷은 RPC가 복원을 거부한다(RuleViolationError).
export async function restoreImportSnapshot(
  client: SupabaseClient,
  snapshotId: string
): Promise<ImportRestoreResult> {
  const { data, error } = await client.rpc('restore_import_snapshot', {
    p_snapshot_id: snapshotId,
  });
  if (error) throwRpcError(error);
  const result = restoreResultSchema.safeParse(data);
  if (!result.success) {
    console.error('[db] restore_import_snapshot 반환값이 기대 형식과 다릅니다:', data);
    throw new ValidationError('저장소 응답이 기대 스키마와 다릅니다. 앱과 DB 버전을 확인하세요.');
  }
  return result.data;
}

export async function removeImportSnapshot(client: SupabaseClient, id: string): Promise<void> {
  const { data, error } = await client.from(TABLE).delete().eq('id', id).select('id');
  if (error) throwDbError(error);
  if ((data ?? []).length === 0) throw new NotFoundError('스냅샷을 찾을 수 없습니다.');
}
