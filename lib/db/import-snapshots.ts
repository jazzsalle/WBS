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
  HireType,
  ImportSnapshot,
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
  // ─ IN-14: `executions` 키가 있는 수행 양식 스냅샷에서만 채워진다 ─
  executionsDeleted?: number;        // ① 반영이 추가했던 집행을 지운 수
  executionsReverted?: number;       // ② 반영 전 값으로 되돌린 집행 수
  executionsRestored?: number;       // ③ id를 보존해 되살린 삭제 집행 수
}

// ─── §6.16 IN-10 수행 양식 반영 (Phase 20) ───────────────────

/**
 * 집행 한 행의 필드. **RPC 페이로드 그대로**라 budget_executions의 DB 표기(snake_case)다.
 * `amount`는 서버 액션이 IN-11로 확정한 원 단위 정수이고 RPC는 그대로 저장한다.
 * `factors` 내부 키(isPercent)는 jsonb라 camelCase 그대로 들어간다(N-3).
 */
export interface ExecutionFormFields {
  date: string;                      // 'YYYY-MM-DD'
  amount: number;                    // 원 단위 정수, 0 이상 (§5.12)
  description: string;
  note: string;
  subcategory_code: string | null;   // `세목 미지정` 슬롯은 null (IN-4)
  spec: string;
  unit_price: number | null;
  factors: DetailFactor[] | null;
  axis: DetailAxis | null;
  member_id: string | null;          // 과제 경계 검증 대상 (IN-13)
  detail_id: string | null;          // 그 과제·연차의 산출근거여야 한다 (IN-13)
}

// 새 집행. 어느 비목 행에 붙일지는 RPC가 (p_year_id, category)로 찾는다
export interface ExecutionFormAddRow extends ExecutionFormFields {
  category: BudgetCategory;
}

// 기존 집행 변경. 비목은 바꿀 수 없다(IN-10 category-moved). category를 실으면 RPC도 그 행의
// 원래 비목과 대조해 거부한다 — 파서·미리보기가 놓쳐도 DB에서 한 번 더 막힌다
export interface ExecutionFormUpdateRow extends ExecutionFormFields {
  id: string;
  category?: BudgetCategory;
}

// IN-10: 충돌 판정 기준 version은 **내려받은 시점**의 값(_meta execution:<id>)이다.
// 변경·삭제 대상 id 전부를 키로 담는다 — 반영 시점 DB에서 다시 읽지 않는다
export type ExecutionFormExpected = Record<string, number>;

// 스냅샷 메타. 수행 양식은 프로파일을 쓰지 않는다 — profileId는 래퍼가 null로 채운다
export interface ExecutionFormSource {
  fileName: string;
  sheetName: string;
  fileHash: string;
}

export interface ExecutionFormConflict {
  id: string;
  reason: 'changed' | 'deleted';     // 내려받은 뒤 바뀜 / 이미 삭제됨. 화면이 "다시 내려받아 고치라"고 안내한다
}

export interface ExecutionFormCommitResult {
  snapshotId: string;
  added: number;
  updated: number;
  deleted: number;
  // version이 달라 건너뛴 변경·삭제. 오류가 아니라 정상 결과의 일부다(전체 롤백 아님, IN-10)
  conflicts: ExecutionFormConflict[];
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
  // IN-14: 수행 스냅샷 복원만 싣는다
  executionsDeleted: z.number().optional(),
  executionsReverted: z.number().optional(),
  executionsRestored: z.number().optional(),
});
// IN-10. conflicts를 선택으로 두면 마이그레이션이 덜 적용된 DB에서 충돌이 0건으로 보인다
const executionFormCommitResultSchema = z.object({
  snapshotId: z.uuid(),
  added: z.number(),
  updated: z.number(),
  deleted: z.number(),
  conflicts: z.array(z.object({ id: z.uuid(), reason: z.enum(['changed', 'deleted']) })),
});

// commit_execution_form의 raise 해석 (lib/db/budget-details.ts와 같은 규약):
//   · /찾을 수 없습니다|not found/i → NotFoundError (연차·비목 행이 사라진 경우)
//   · 그 외 P0001                  → RuleViolationError (과제 경계·IN-13·금액 음수 등)
// 기존 throwRpcError는 바꾸지 않는다 — commit_import·복원의 예외 종류가 달라지면 안 된다
const NOT_FOUND_MESSAGE_PATTERN = /찾을 수 없습니다|not found/i;

function throwExecutionFormRpcError(error: PostgrestError): never {
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
 * §6.16 IN-10 수행 양식 반영. 추가·변경·삭제와 스냅샷(`kind: 'execution_form'`, IN-14)이
 * **한 트랜잭션**이다. version이 `expected`와 다른 변경·삭제는 그 행만 건너뛰고
 * `conflicts`로 돌아온다(예외가 아니다). 과제 경계·IN-13 위반은 전체 롤백이다.
 *
 * `deleteIds`는 사용자가 `[삭제 포함]`을 켰을 때만 채운다 — 판정은 서버 액션의 몫이다.
 */
export async function commitExecutionForm(
  client: SupabaseClient,
  projectId: string,
  yearId: string,
  adds: ExecutionFormAddRow[],
  updates: ExecutionFormUpdateRow[],
  deleteIds: string[],
  expected: ExecutionFormExpected,
  source: ExecutionFormSource
): Promise<ExecutionFormCommitResult> {
  const { data, error } = await client.rpc('commit_execution_form', {
    p_project_id: projectId,
    p_year_id: yearId,
    p_adds: adds,
    p_updates: updates,
    p_delete_ids: deleteIds,
    p_expected: expected,
    // 스냅샷 source 스키마는 profileId를 필수(nullable)로 요구한다. RPC가 p_source를 그대로
    // 적어도 목록 검증이 깨지지 않도록 여기서 명시한다
    p_source: { ...source, profileId: null },
  });
  if (error) throwExecutionFormRpcError(error);
  const result = executionFormCommitResultSchema.safeParse(data);
  if (!result.success) {
    console.error('[db] commit_execution_form 반환값이 기대 형식과 다릅니다:', data);
    throw new ValidationError('저장소 응답이 기대 스키마와 다릅니다. 앱과 DB 버전을 확인하세요.');
  }
  return result.data;
}

// §7.14: 스냅샷 시점의 계획액으로 되돌린다. 역시 단일 트랜잭션 + 과제 경계 검증.
// D-17a: 스냅샷에 `details` 키가 있으면 산출근거 행까지 되돌린다 — 그 셀의 현재 행을
// 지우고 스냅샷 행을 되살린다(I-17 "복원이 행을 삭제하지 않는다"의 명시적 예외).
// `budget_items` 행 자체는 여전히 지우지 않아 집행 내역이 보존된다.
// IN-14: `executions` 키가 있으면 수행 양식 반영을 완전히 되돌린다. 그 뒤 대상 행이 다시
// 바뀌었으면 RPC가 복원 전체를 거부한다(P0001 → RuleViolationError).
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
