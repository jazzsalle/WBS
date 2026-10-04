// 협약 예산 리포지토리 — agreement_versions·agreement_lines·agreement_participants·agreement_items·
// agreement_gov_support (SOT §5.21~§5.25, §8.4, §8.6, §9 Agreement Budget,
// 계획서 docs/plans/phase-24-plan.md S-3·S-4·S-14~S-16, phase-25-plan.md S-3·S-4·S-11·S-15,
//  phase-26-plan.md S-1·S-12·S-14·S-22)
//
// 쓰기 경로가 둘로 나뉜다(§9 X-1):
//  - 여러 테이블을 한 번에 바꾸는 일(보내기·빈 버전·복제·전체 삭제)은 RPC 3종 — 단일 트랜잭션·과제 경계 검증이
//    RPC 안에 있다. 여기서 PostgREST 여러 번으로 쪼개면 줄 일부만 복사된 버전이 남을 수 있다.
//  - 단일 행 쓰기(메타·확정·확정 취소·버전 삭제·줄 추가/갱신·참여인원·편성 항목·정부지원 현금)는 PostgREST로 직접 한다.
//
// 확정 잠금(AV-2)·과제 경계·확정 취소 조건(AV-8)은 DB 가드 트리거가 최후 방어선이다. 트리거의
// raise exception은 P0001로 오고 메시지가 그대로 사용자 문구다 — 그래서 P0001은 메시지 그대로 RULE로 올린다.
//
// 금액은 원 단위 정수다 (절대 규칙 4). 리포지토리는 금액 연산을 하지 않는다 — 실어 나르기만 한다.

import type { PostgrestError, SupabaseClient } from '@supabase/supabase-js';
import { z } from 'zod';
import type {
  AgreementEvidenceCheck,
  AgreementGovSupport,
  AgreementItem,
  AgreementLine,
  AgreementParticipant,
  AgreementVersion,
  AgreementVersionKind,
  BaseEntity,
} from '@/types';
import { appToDb, dbToApp } from './mapper';
import {
  agreementGovSupportRowSchema,
  agreementItemRowSchema,
  agreementLineRowSchema,
  agreementParticipantRowSchema,
  agreementVersionRowSchema,
} from './schema';
import { NotFoundError, RuleViolationError, StaleDataError, ValidationError } from './errors';

const VERSIONS = 'agreement_versions';
const LINES = 'agreement_lines';
const PARTICIPANTS = 'agreement_participants';
const ITEMS = 'agreement_items';
const GOV_SUPPORT = 'agreement_gov_support';
type Table = typeof VERSIONS | typeof LINES | typeof PARTICIPANTS | typeof ITEMS | typeof GOV_SUPPORT;
type ChildTable = typeof LINES | typeof PARTICIPANTS | typeof ITEMS | typeof GOV_SUPPORT;

// PostgREST 응답 상한(max-rows 1000) — 줄은 버전 × 연차 × 비목 × 세목 × 축이라 버전 몇 개만 모여도
// 1000행을 넘는다. budget-details.ts와 같은 이유로 일괄 조회는 전부 페이징한다 (§12)
const PAGE_SIZE = 1000;
// `.in('version_id', ...)`의 UUID가 쿼리스트링에 그대로 실린다 — 긴 URL을 만들지 않도록 청크로 나눈다
const ID_CHUNK_SIZE = 100;

// SA-4: 테이블명·제약명 같은 내부 정보를 사용자 메시지에 싣지 않는다
const SCHEMA_MISMATCH_MESSAGE =
  'DB 응답이 앱이 기대하는 형식과 다릅니다. 앱과 DB 마이그레이션 버전을 확인하세요.';
const VERSION_NOT_FOUND_MESSAGE = '협약 예산 버전을 찾을 수 없습니다.';
const LINE_NOT_FOUND_MESSAGE = '협약 예산 금액 줄을 찾을 수 없습니다.';
const PARTICIPANT_NOT_FOUND_MESSAGE = '협약 예산 참여인원을 찾을 수 없습니다.';
const ITEM_NOT_FOUND_MESSAGE = '협약 예산 편성 항목을 찾을 수 없습니다.';

// ─── 에러 매핑 ───────────────────────────────────────────────

// 23505는 테이블마다 뜻이 다르다.
//  - versions: 작성 중 1개 부분 유일 인덱스(AV-2) — RPC 선검사와 동시에 들어온 경합. 규칙 위반이다(S-4)
//  - lines: (버전·연차·비목·세목·축) 유일 — 셀 편집 중 다른 사람이 같은 칸에 먼저 줄을 만든 경합.
//    S-16에 따라 경합은 STALE로 알린다(다시 읽으면 그 줄을 update하게 된다)
//  - gov_support: (버전·연차) 유일 — 미입력 칸에 그사이 다른 사람이 값을 넣은 경합. lines와 같이 STALE(S-4)
const DRAFT_EXISTS_MESSAGE = '작성 중 버전이 이미 있습니다 — 확정하거나 삭제한 뒤 만드세요';
const UNKNOWN_CHECK_MESSAGE = '입력값이 DB 제약을 위반했습니다. 값을 확인하세요.';
// 증빙 모양 check(agreement_evidence_is_valid)는 보내기 RPC 안에서도 걸린다 — 테이블이 아니라 제약명으로 가른다.
// 제약명은 판별에만 쓰고 사용자 문구에는 싣지 않는다 (SA-4)
const EVIDENCE_CHECK_NAME = 'agreement_items_evidence_valid_check';
const EVIDENCE_INVALID_MESSAGE =
  '증빙 목록이 올바르지 않습니다 — 30개 이하, 이름 1~100자(한 항목 안 중복 금지), 메모 500자 이하여야 합니다.';

const NOT_FOUND_MESSAGE_PATTERN = /찾을 수 없습니다|not found/i;

function raiseDbError(error: PostgrestError, table: Table): never {
  if (error.code === '23505') {
    if (table === LINES || table === GOV_SUPPORT) throw new StaleDataError();
    throw new RuleViolationError(DRAFT_EXISTS_MESSAGE);
  }
  // check 위반(금액 < 0, 참여율 범위, status·confirmed_at 짝 등) — 액션 Zod 뒤의 방어선
  if (error.code === '23514') {
    if (`${error.message} ${error.details ?? ''}`.includes(EVIDENCE_CHECK_NAME)) {
      throw new RuleViolationError(EVIDENCE_INVALID_MESSAGE);
    }
    throw new RuleViolationError(UNKNOWN_CHECK_MESSAGE);
  }
  // P0001 = RPC·가드 트리거의 raise exception. 대상 없음만 NotFound, 나머지(확정 잠금·확정 취소 조건·
  // 과제 경계·작성 중 1개)는 메시지가 그대로 사용자 문구다 (마이그레이션 머리말의 예외 규약)
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
    console.error('[db/agreements] row 검증 실패:', result.error.issues);
    throw new ValidationError(SCHEMA_MISMATCH_MESSAGE);
  }
  return result.data;
}

function toVersion(row: unknown): AgreementVersion {
  return dbToApp<AgreementVersion>(parseRow(agreementVersionRowSchema, row));
}

function toLine(row: unknown): AgreementLine {
  return dbToApp<AgreementLine>(parseRow(agreementLineRowSchema, row));
}

function toParticipant(row: unknown): AgreementParticipant {
  return dbToApp<AgreementParticipant>(parseRow(agreementParticipantRowSchema, row));
}

function toItem(row: unknown): AgreementItem {
  return dbToApp<AgreementItem>(parseRow(agreementItemRowSchema, row));
}

function toGovSupport(row: unknown): AgreementGovSupport {
  return dbToApp<AgreementGovSupport>(parseRow(agreementGovSupportRowSchema, row));
}

// undefined 키 제거 — JSON 직렬화에서 빠져 빈 body가 되는 것을 막고 "갱신할 내용 없음"을 명시적으로 판정한다
function definedOnly(obj: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined));
}

// 0행 갱신의 원인 구분: 행이 없으면 NotFound, 있으면 낙관적 잠금 실패 (§8.4 O-1).
// O-3 표시("OO님이 먼저 수정했습니다")를 위해 최신 행의 updated_by를 담는다.
const NOT_FOUND_MESSAGES = {
  [VERSIONS]: VERSION_NOT_FOUND_MESSAGE,
  [LINES]: LINE_NOT_FOUND_MESSAGE,
  [PARTICIPANTS]: PARTICIPANT_NOT_FOUND_MESSAGE,
  [ITEMS]: ITEM_NOT_FOUND_MESSAGE,
} as const;

async function raiseStaleOrNotFound(
  client: SupabaseClient,
  table: keyof typeof NOT_FOUND_MESSAGES,
  id: string
): Promise<never> {
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

// 여러 버전의 하위 행을 청크별로 동시에 읽는다. 청크끼리 대상 버전이 겹치지 않아 결과가 같다 (§12)
async function fetchByVersionIds<T extends { versionId: string }>(
  client: SupabaseClient,
  table: ChildTable,
  versionIds: readonly string[],
  convert: (row: unknown) => T
): Promise<T[]> {
  if (versionIds.length === 0) return [];
  const requested = new Set(versionIds);
  const pages = await Promise.all(
    chunk([...requested]).map((ids) =>
      fetchAllRows(table, (from, to) =>
        client
          .from(table)
          .select('*')
          .in('version_id', ids)
          // 결정적 정렬이 없으면 range 페이징이 행을 새거나 중복시킨다
          .order('id', { ascending: true })
          .range(from, to)
      )
    )
  );
  const rows = pages.flat().map(convert);
  for (const row of rows) {
    // 요청하지 않은 버전의 행 = 필터가 의도대로 걸리지 않았다는 뜻. 조용히 버리지 않는다
    if (!requested.has(row.versionId)) {
      throw new ValidationError('요청하지 않은 협약 예산 버전의 행이 반환되었습니다.');
    }
  }
  return rows;
}

function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

// 표시 순서(연차 order·부록 A.5 세목 순)는 lib/agreement/ 순수 함수 몫이다. 여기서는 같은 입력이면
// 같은 순서가 나오도록만 맞춘다 — 증감 계산·보내기 결과가 호출마다 흔들리지 않게
function compareLines(a: AgreementLine, b: AgreementLine): number {
  return (
    compareText(a.versionId, b.versionId) ||
    compareText(a.yearId, b.yearId) ||
    compareText(a.category, b.category) ||
    compareText(a.subcategoryCode, b.subcategoryCode) ||
    compareText(a.axis, b.axis) ||
    compareText(a.id, b.id)
  );
}

function compareByVersionYear(
  a: { versionId: string; yearId: string; id: string },
  b: { versionId: string; yearId: string; id: string }
): number {
  return compareText(a.versionId, b.versionId) || compareText(a.yearId, b.yearId) || compareText(a.id, b.id);
}

// ─── 조회 ────────────────────────────────────────────────────

/** 과제의 버전 전부, 쌓인 순서(order 오름차순). 순번은 지워도 재매김하지 않아 빈자리가 있을 수 있다(AV-4) */
export async function listVersionsByProject(
  client: SupabaseClient,
  projectId: string
): Promise<AgreementVersion[]> {
  const rows = await fetchAllRows(VERSIONS, (from, to) =>
    client
      .from(VERSIONS)
      .select('*')
      .eq('project_id', projectId)
      .order('sort_order', { ascending: true })
      .order('id', { ascending: true })
      .range(from, to)
  );
  return rows.map(toVersion);
}

/** 버전 하나. 액션이 쓰기 전에 과제 소속·상태(확정 잠금)를 확인하는 데 쓴다 */
export async function getVersionById(client: SupabaseClient, id: string): Promise<AgreementVersion> {
  const { data, error } = await client.from(VERSIONS).select('*').eq('id', id).maybeSingle();
  if (error) raiseDbError(error, VERSIONS);
  if (!data) throw new NotFoundError(VERSION_NOT_FOUND_MESSAGE);
  return toVersion(data);
}

/** 여러 버전의 금액 줄 전량 — 비목별 보기·증감·RL-23의 입력 */
export async function listLinesByVersionIds(
  client: SupabaseClient,
  versionIds: readonly string[]
): Promise<AgreementLine[]> {
  const lines = await fetchByVersionIds(client, LINES, versionIds, toLine);
  return lines.sort(compareLines);
}

/** 여러 버전의 참여인원 전량 — 증감(AG-7) 입력. 연봉은 버전 스냅샷 그대로다 */
export async function listParticipantsByVersionIds(
  client: SupabaseClient,
  versionIds: readonly string[]
): Promise<AgreementParticipant[]> {
  const participants = await fetchByVersionIds(client, PARTICIPANTS, versionIds, toParticipant);
  return participants.sort(compareByVersionYear);
}

/** 참여인원 하나. 액션이 편집 전에 버전(확정 잠금)·과제 소속을 확인하는 데 쓴다 */
export async function getParticipantById(
  client: SupabaseClient,
  id: string
): Promise<AgreementParticipant> {
  const { data, error } = await client.from(PARTICIPANTS).select('*').eq('id', id).maybeSingle();
  if (error) raiseDbError(error, PARTICIPANTS);
  if (!data) throw new NotFoundError(PARTICIPANT_NOT_FOUND_MESSAGE);
  return toParticipant(data);
}

/** 여러 버전의 연차별 정부지원 현금 전량(§5.25). 행이 없는 (버전, 연차) = 미입력 — 0과 다르다 */
export async function listGovSupportByVersionIds(
  client: SupabaseClient,
  versionIds: readonly string[]
): Promise<AgreementGovSupport[]> {
  const rows = await fetchByVersionIds(client, GOV_SUPPORT, versionIds, toGovSupport);
  return rows.sort(compareByVersionYear);
}

/** 여러 버전의 편성 항목 전량(증빙 포함) — 편성 항목 보기(AG-6)·대조·RL-17의 입력 */
export async function listItemsByVersionIds(
  client: SupabaseClient,
  versionIds: readonly string[]
): Promise<AgreementItem[]> {
  const items = await fetchByVersionIds(client, ITEMS, versionIds, toItem);
  return items.sort(compareByVersionYear);
}

// ─── 버전 쓰기 (단일 행 — PostgREST 직접) ────────────────────

/** 확정 후에도 고칠 수 있는 메타 7개(S-3·Q3). status·confirmedAt·order는 여기서 바꾸지 않는다 */
export type AgreementVersionMetaPatch = Partial<
  Pick<
    AgreementVersion,
    'kind' | 'name' | 'baseDate' | 'changeReason' | 'noticeType' | 'irisRequestedAt' | 'note'
  >
> & { updatedBy?: string | null };

// 호출자가 넓은 객체를 넘겨도 status 같은 키가 메타 편집으로 새어 들어가지 않게 고른다
function pickMeta(patch: AgreementVersionMetaPatch): Record<string, unknown> {
  return {
    kind: patch.kind,
    name: patch.name,
    baseDate: patch.baseDate,
    changeReason: patch.changeReason,
    noticeType: patch.noticeType,
    irisRequestedAt: patch.irisRequestedAt,
    note: patch.note,
    updatedBy: patch.updatedBy,
  };
}

// 버전 행 하나를 expectedVersion 조건으로 갱신한다 (§8.4 O-1 — 메타·확정·확정 취소 모두 필수, S-16)
async function updateVersionRow(
  client: SupabaseClient,
  id: string,
  dbPatch: Record<string, unknown>,
  expectedVersion: number
): Promise<AgreementVersion> {
  const { data, error } = await client
    .from(VERSIONS)
    .update(dbPatch)
    .eq('id', id)
    .eq('version', expectedVersion)
    .select('*');
  if (error) raiseDbError(error, VERSIONS);
  const row = (data ?? [])[0];
  if (row === undefined) return raiseStaleOrNotFound(client, VERSIONS, id);
  return toVersion(row);
}

/** 메타 7개 편집. 확정 버전도 허용한다(AV-2 — 잠금은 내용에만). version 불일치는 StaleDataError */
export async function updateVersionMeta(
  client: SupabaseClient,
  id: string,
  patch: AgreementVersionMetaPatch,
  expectedVersion: number
): Promise<AgreementVersion> {
  const dbPatch = definedOnly(appToDb(pickMeta(patch)));
  // updated_by만 있는 patch는 version만 올리는 빈 갱신이 된다
  if (Object.keys(dbPatch).every((key) => key === 'updated_by')) {
    throw new ValidationError('갱신할 내용이 없습니다.');
  }
  return updateVersionRow(client, id, dbPatch, expectedVersion);
}

/** AV-2 확정. 작성 중인지는 액션이 먼저 본다 — expectedVersion이 그 판단 이후 변경을 막는다 */
export async function confirmVersion(
  client: SupabaseClient,
  id: string,
  expectedVersion: number,
  updatedBy?: string | null
): Promise<AgreementVersion> {
  // DB now()를 PostgREST update에 실을 수 없다 — 서버 시각을 쓴다. check(status↔confirmed_at)가 짝을 강제한다
  const dbPatch = definedOnly({
    status: 'confirmed',
    confirmed_at: new Date().toISOString(),
    updated_by: updatedBy,
  });
  return updateVersionRow(client, id, dbPatch, expectedVersion);
}

/**
 * AV-8 확정 취소. 과제의 마지막 버전이 아니면 버전 가드 트리거가 거부한다 → RuleViolationError(트리거 메시지).
 * 액션이 먼저 같은 조건으로 거부하고 트리거는 그사이 버전이 쌓인 경합을 막는다.
 */
export async function unconfirmVersion(
  client: SupabaseClient,
  id: string,
  expectedVersion: number,
  updatedBy?: string | null
): Promise<AgreementVersion> {
  const dbPatch = definedOnly({ status: 'draft', confirmed_at: null, updated_by: updatedBy });
  return updateVersionRow(client, id, dbPatch, expectedVersion);
}

/** AV-4 버전 하나 삭제. 하위 3종은 cascade. 확정 버전도 지울 수 있다(가드는 DELETE를 막지 않는다) */
export async function removeVersion(client: SupabaseClient, id: string): Promise<void> {
  const { data, error } = await client.from(VERSIONS).delete().eq('id', id).select('id');
  if (error) raiseDbError(error, VERSIONS);
  if ((data ?? []).length === 0) throw new NotFoundError(VERSION_NOT_FOUND_MESSAGE);
}

// ─── 금액 줄 쓰기 (AG-2 셀 편집 — 단일 행) ───────────────────

type LineFieldKeys = 'yearId' | 'category' | 'subcategoryCode' | 'axis' | 'amount';

export type AgreementLineInsert = Pick<AgreementLine, 'versionId' | LineFieldKeys> & {
  createdBy?: string | null;
  updatedBy?: string | null;
};

/**
 * 줄 하나 추가(resolveCellEdit의 insert). 확정 버전·다른 과제 연차는 가드 트리거가 RuleViolationError로,
 * 같은 칸에 그사이 다른 사람이 줄을 만들었으면 StaleDataError (S-16 경합)
 */
export async function insertLine(
  client: SupabaseClient,
  input: AgreementLineInsert
): Promise<AgreementLine> {
  const { data, error } = await client
    .from(LINES)
    .insert(definedOnly(appToDb(input)))
    .select('*')
    .single();
  if (error) raiseDbError(error, LINES);
  return toLine(data);
}

/**
 * 줄 금액 갱신(resolveCellEdit의 update). S-16: 사용자가 보낸 version이 아니라 **서버가 셀 편집을 해석하려고
 * 방금 읽은 줄의 version**(`readVersion`)을 조건으로 건다 — 그 읽기와 이 쓰기 사이의 경합만 StaleDataError.
 * 확정 버전이면 가드 트리거가 RuleViolationError
 */
export async function updateLineAmount(
  client: SupabaseClient,
  id: string,
  amount: number,
  readVersion: number,
  updatedBy?: string | null
): Promise<AgreementLine> {
  const { data, error } = await client
    .from(LINES)
    .update(definedOnly({ amount, updated_by: updatedBy }))
    .eq('id', id)
    .eq('version', readVersion)
    .select('*');
  if (error) raiseDbError(error, LINES);
  const row = (data ?? [])[0];
  if (row === undefined) return raiseStaleOrNotFound(client, LINES, id);
  return toLine(row);
}

// ─── 참여인원 쓰기 (AG-5 편집 — 단일 행, Phase 25 S-11) ──────

type ParticipantFieldKeys = Exclude<keyof AgreementParticipant, keyof BaseEntity | 'versionId'>;

export type AgreementParticipantInsert = Pick<AgreementParticipant, 'versionId' | ParticipantFieldKeys> & {
  createdBy?: string | null;
  updatedBy?: string | null;
};

/** versionId는 바꾸지 않는다 — 가드 트리거도 거부하지만 patch 타입에서 먼저 뺀다 */
export type AgreementParticipantPatch = Partial<Pick<AgreementParticipant, ParticipantFieldKeys>> & {
  updatedBy?: string | null;
};

// 넓은 객체가 넘어와도 versionId 같은 키가 새어 들어가지 않게 고른다
function pickParticipantFields(patch: AgreementParticipantPatch): Record<string, unknown> {
  return {
    memberId: patch.memberId,
    yearId: patch.yearId,
    participationRate: patch.participationRate,
    months: patch.months,
    annualSalary: patch.annualSalary,
    personnelCash: patch.personnelCash,
    personnelInKind: patch.personnelInKind,
    role: patch.role,
    updatedBy: patch.updatedBy,
  };
}

/**
 * 참여인원 하나 추가. 확정 버전·다른 과제의 연차/인력은 가드 트리거가 RuleViolationError.
 * 연봉 스냅샷·금액 자동 계산은 액션 몫이다 — 여기서는 받은 값을 그대로 싣는다
 */
export async function insertParticipant(
  client: SupabaseClient,
  input: AgreementParticipantInsert
): Promise<AgreementParticipant> {
  const { data, error } = await client
    .from(PARTICIPANTS)
    .insert(definedOnly(appToDb({ ...input })))
    .select('*')
    .single();
  if (error) raiseDbError(error, PARTICIPANTS);
  return toParticipant(data);
}

/** 참여인원 갱신(§8.4 O-1 — 사용자가 읽은 expectedVersion 조건). 불일치는 StaleDataError, 확정 버전은 RuleViolationError */
export async function updateParticipant(
  client: SupabaseClient,
  id: string,
  patch: AgreementParticipantPatch,
  expectedVersion: number
): Promise<AgreementParticipant> {
  const dbPatch = definedOnly(appToDb(pickParticipantFields(patch)));
  if (Object.keys(dbPatch).every((key) => key === 'updated_by')) {
    throw new ValidationError('갱신할 내용이 없습니다.');
  }
  const { data, error } = await client
    .from(PARTICIPANTS)
    .update(dbPatch)
    .eq('id', id)
    .eq('version', expectedVersion)
    .select('*');
  if (error) raiseDbError(error, PARTICIPANTS);
  const row = (data ?? [])[0];
  if (row === undefined) return raiseStaleOrNotFound(client, PARTICIPANTS, id);
  return toParticipant(row);
}

/**
 * 참여인원 하나 삭제. 가드 트리거는 DELETE를 막지 않는다(Phase 24 하위 테이블과 같다) —
 * 확정 버전 거부(RULE)는 액션이 getParticipantById → getVersionById로 먼저 판단한다(S-11)
 */
export async function removeParticipant(client: SupabaseClient, id: string): Promise<void> {
  const { data, error } = await client.from(PARTICIPANTS).delete().eq('id', id).select('id');
  if (error) raiseDbError(error, PARTICIPANTS);
  if ((data ?? []).length === 0) throw new NotFoundError(PARTICIPANT_NOT_FOUND_MESSAGE);
}

// ─── 편성 항목 쓰기 (§5.24 — 단일 행, Phase 26 S-1·S-12·S-22) ─
// 확정 버전에서 허용되는 것은 증빙의 받음 체크·메모뿐이다(AV-2 잠금 예외). 그 판정은 가드 트리거
// (agreement_child_guard 재정의)가 하므로 리포지토리는 거부(P0001)를 RuleViolationError로 올리기만 한다.
// 증빙 갱신을 updateItem과 나눈 이유: 확정 버전에서 둘의 허용 범위가 달라 액션이 다른 검증을 건다

type ItemFieldKeys = 'yearId' | 'kind' | 'name' | 'amount' | 'quantity';

export type AgreementItemInsert = Pick<AgreementItem, 'versionId' | ItemFieldKeys> & {
  /** 생략 = 빈 배열(DB 기본값). 종류별 기본 목록 복사는 액션 몫이다 */
  evidence?: AgreementEvidenceCheck[];
  createdBy?: string | null;
  updatedBy?: string | null;
};

/** evidence·versionId는 바꾸지 않는다 — 증빙은 updateItemEvidence, 버전 이동은 가드도 거부한다 */
export type AgreementItemPatch = Partial<Pick<AgreementItem, ItemFieldKeys>> & {
  updatedBy?: string | null;
};

// 넓은 객체가 넘어와도 evidence·versionId가 새어 들어가지 않게 고른다
function pickItemFields(patch: AgreementItemPatch): Record<string, unknown> {
  return {
    yearId: patch.yearId,
    kind: patch.kind,
    name: patch.name,
    amount: patch.amount,
    quantity: patch.quantity,
    updatedBy: patch.updatedBy,
  };
}

/** 편성 항목 하나. 액션이 쓰기 전에 버전(확정 잠금)·과제 소속을 확인하는 데 쓴다 */
export async function getItemById(client: SupabaseClient, id: string): Promise<AgreementItem> {
  const { data, error } = await client.from(ITEMS).select('*').eq('id', id).maybeSingle();
  if (error) raiseDbError(error, ITEMS);
  if (!data) throw new NotFoundError(ITEM_NOT_FOUND_MESSAGE);
  return toItem(data);
}

/** 편성 항목 하나 추가. 확정 버전·다른 과제 연차는 가드 트리거가, 증빙 모양은 check가 RuleViolationError */
export async function insertItem(
  client: SupabaseClient,
  input: AgreementItemInsert
): Promise<AgreementItem> {
  const { data, error } = await client
    .from(ITEMS)
    .insert(definedOnly(appToDb({ ...input })))
    .select('*')
    .single();
  if (error) raiseDbError(error, ITEMS);
  return toItem(data);
}

// 편성 항목 행 하나를 expectedVersion 조건으로 갱신한다 (§8.4 O-1)
async function updateItemRow(
  client: SupabaseClient,
  id: string,
  dbPatch: Record<string, unknown>,
  expectedVersion: number
): Promise<AgreementItem> {
  const { data, error } = await client
    .from(ITEMS)
    .update(dbPatch)
    .eq('id', id)
    .eq('version', expectedVersion)
    .select('*');
  if (error) raiseDbError(error, ITEMS);
  const row = (data ?? [])[0];
  if (row === undefined) return raiseStaleOrNotFound(client, ITEMS, id);
  return toItem(row);
}

/** 연차·종류·품명·금액·수량 갱신. 확정 버전은 가드 트리거가 RuleViolationError, version 불일치는 StaleDataError */
export async function updateItem(
  client: SupabaseClient,
  id: string,
  patch: AgreementItemPatch,
  expectedVersion: number
): Promise<AgreementItem> {
  const dbPatch = definedOnly(appToDb(pickItemFields(patch)));
  if (Object.keys(dbPatch).every((key) => key === 'updated_by')) {
    throw new ValidationError('갱신할 내용이 없습니다.');
  }
  return updateItemRow(client, id, dbPatch, expectedVersion);
}

/**
 * 증빙 목록 통째 교체. 확정 버전이면 라벨 배열(순서 포함)이 같을 때만 가드 트리거가 통과시킨다(S-1) —
 * 라벨 추가·삭제·이름·순서 변경은 RuleViolationError. 모양 위반도 RuleViolationError, version 불일치는 StaleDataError
 */
export async function updateItemEvidence(
  client: SupabaseClient,
  id: string,
  evidence: readonly AgreementEvidenceCheck[],
  expectedVersion: number,
  updatedBy?: string | null
): Promise<AgreementItem> {
  const dbPatch = definedOnly(appToDb({ evidence: [...evidence], updatedBy }));
  return updateItemRow(client, id, dbPatch, expectedVersion);
}

/**
 * 편성 항목 하나 삭제. 가드 트리거는 DELETE를 막지 않는다 — 확정 버전 거부(RULE)는 액션이
 * getItemById → getVersionById로 먼저 판단한다(S-12)
 */
export async function removeItem(client: SupabaseClient, id: string): Promise<void> {
  const { data, error } = await client.from(ITEMS).delete().eq('id', id).select('id');
  if (error) raiseDbError(error, ITEMS);
  if ((data ?? []).length === 0) throw new NotFoundError(ITEM_NOT_FOUND_MESSAGE);
}

// ─── 정부지원 현금 쓰기 (§5.25 — 값 1개, O-2) ────────────────
// S-4: 액션이 방금 읽은 (버전, 연차) 행으로 분기한다 — 행 없음+값 = 삽입, 행 있음+값 = 그 행 version 조건 갱신,
// 행 있음+null = 그 version 조건 삭제. 그 읽기와 이 쓰기 사이의 경합(0행·23505)은 모두 StaleDataError다.
// 행이 그사이 지워진 경우도 NotFound가 아니라 STALE — 사용자가 보던 칸이 바뀐 것이기 때문이다

// 0행 갱신·삭제 — 최신 행이 있으면 그 updated_by를 담아 O-3 표시를 돕는다
async function raiseGovSupportStale(
  client: SupabaseClient,
  versionId: string,
  yearId: string
): Promise<never> {
  const { data, error } = await client
    .from(GOV_SUPPORT)
    .select('updated_by')
    .eq('version_id', versionId)
    .eq('year_id', yearId)
    .maybeSingle();
  if (error) raiseDbError(error, GOV_SUPPORT);
  if (!data) throw new StaleDataError();
  throw new StaleDataError(parseRow(z.object({ updated_by: z.uuid().nullable() }), data).updated_by);
}

/**
 * (버전, 연차)의 정부지원 현금 저장. `readVersion` = 액션이 방금 읽은 행의 version, 행이 없었으면 null(삽입).
 * 0도 입력값으로 저장한다. 확정 버전·다른 과제 연차는 가드 트리거가 RuleViolationError
 */
export async function upsertGovSupport(
  client: SupabaseClient,
  versionId: string,
  yearId: string,
  govCash: number,
  readVersion: number | null,
  updatedBy?: string | null
): Promise<AgreementGovSupport> {
  if (readVersion === null) {
    const { data, error } = await client
      .from(GOV_SUPPORT)
      .insert(
        definedOnly({
          version_id: versionId,
          year_id: yearId,
          gov_cash: govCash,
          created_by: updatedBy,
          updated_by: updatedBy,
        })
      )
      .select('*')
      .single();
    if (error) raiseDbError(error, GOV_SUPPORT);
    return toGovSupport(data);
  }
  const { data, error } = await client
    .from(GOV_SUPPORT)
    .update(definedOnly({ gov_cash: govCash, updated_by: updatedBy }))
    .eq('version_id', versionId)
    .eq('year_id', yearId)
    .eq('version', readVersion)
    .select('*');
  if (error) raiseDbError(error, GOV_SUPPORT);
  const row = (data ?? [])[0];
  if (row === undefined) return raiseGovSupportStale(client, versionId, yearId);
  return toGovSupport(row);
}

/**
 * (버전, 연차)의 정부지원 현금을 미입력으로 되돌린다(행 삭제). 가드 트리거는 DELETE를 막지 않는다 —
 * 확정 버전 거부(RULE)는 액션이 먼저 판단한다(S-4)
 */
export async function removeGovSupport(
  client: SupabaseClient,
  versionId: string,
  yearId: string,
  readVersion: number
): Promise<void> {
  const { data, error } = await client
    .from(GOV_SUPPORT)
    .delete()
    .eq('version_id', versionId)
    .eq('year_id', yearId)
    .eq('version', readVersion)
    .select('id');
  if (error) raiseDbError(error, GOV_SUPPORT);
  if ((data ?? []).length === 0) return raiseGovSupportStale(client, versionId, yearId);
}

// ─── RPC 3종 (여러 테이블 — 단일 트랜잭션, SA-3) ──────────────

// RPC 페이로드는 DB 표기(snake_case)다 — 케이스 변환은 매퍼에만 맡긴다
export type AgreementLineSeed = Pick<AgreementLine, LineFieldKeys>;
export type AgreementParticipantSeed = Omit<AgreementParticipant, keyof BaseEntity | 'versionId'>;
export type AgreementItemSeed = Pick<AgreementItem, ItemFieldKeys | 'evidence'>;

export interface CreateAgreementVersionInput {
  kind: AgreementVersionKind;
  name: string;
  /** 빈 버전은 둘 다 빈 배열 */
  lines: readonly AgreementLineSeed[];
  participants: readonly AgreementParticipantSeed[];
  /** 연차 id → 정부지원 현금(원). 키가 없는 연차는 행을 만들지 않는다(미입력). 생략 = 빈 객체 */
  govCash?: Readonly<Record<string, number>>;
  /** 보내기만 채운다(S-14). 빈 버전·붙임4 가져오기는 생략 = 빈 배열 */
  items?: readonly AgreementItemSeed[];
}

const createResultSchema = z.object({
  versionId: z.uuid(),
  order: z.number().int(),
  lines: z.number().int().min(0),
  participants: z.number().int().min(0),
  govSupport: z.number().int().min(0),
  items: z.number().int().min(0),
});
export type CreateAgreementVersionResult = z.infer<typeof createResultSchema>;

// Phase 26 p_items로 생성·복제의 반환 모양이 같아졌다 — 타입 이름은 호출부 호환을 위해 남긴다
const cloneResultSchema = createResultSchema;
export type CloneAgreementVersionResult = z.infer<typeof cloneResultSchema>;

const deleteAllResultSchema = z.object({ deleted: z.number().int().min(0) });

// RPC 반환 jsonb는 이미 앱 표기(camelCase) 키다 — 매퍼를 거치지 않고 형식만 검증한다
function parseRpcResult<T>(schema: z.ZodType<T>, data: unknown): T {
  return parseRow(schema, data);
}

/**
 * 보내기(AV-6)·빈 버전 공용. 새 버전은 작성 중, order = 과제 최댓값 + 1.
 * 작성 중 버전이 이미 있으면·다른 과제의 연차/인력이면 RuleViolationError, 과제가 없으면 NotFoundError
 */
export async function createVersion(
  client: SupabaseClient,
  projectId: string,
  input: CreateAgreementVersionInput
): Promise<CreateAgreementVersionResult> {
  const { data, error } = await client.rpc('create_agreement_version', {
    p_project_id: projectId,
    p_kind: input.kind,
    p_name: input.name,
    p_lines: input.lines.map((line) => appToDb({ ...line })),
    p_participants: input.participants.map((participant) => appToDb({ ...participant })),
    // 키가 연차 uuid라 매퍼를 거치지 않는다 — 케이스 변환 대상이 아니다
    p_gov_cash: { ...(input.govCash ?? {}) },
    p_items: (input.items ?? []).map((item) => appToDb({ ...item })),
  });
  if (error) raiseDbError(error, VERSIONS);
  return parseRpcResult(createResultSchema, data);
}

/**
 * AV-1 복제 — 원본의 줄·참여인원·편성 항목(증빙 포함)·정부지원 현금을 새 id로 복사하고 원본은 바꾸지 않는다.
 * 원본이 과제의 마지막 버전인지는 검사하지 않는다 — "직전 버전" 선택은 호출자 몫이다
 */
export async function cloneVersion(
  client: SupabaseClient,
  sourceVersionId: string,
  input: { kind: AgreementVersionKind; name: string }
): Promise<CloneAgreementVersionResult> {
  const { data, error } = await client.rpc('clone_agreement_version', {
    p_source_id: sourceVersionId,
    p_kind: input.kind,
    p_name: input.name,
  });
  if (error) raiseDbError(error, VERSIONS);
  return parseRpcResult(cloneResultSchema, data);
}

/** AV-4 전체 버전 삭제 — 그 과제의 버전만, 하위 4종 cascade. 지운 버전 수를 돌려준다 */
export async function removeAllVersions(
  client: SupabaseClient,
  projectId: string
): Promise<{ deleted: number }> {
  const { data, error } = await client.rpc('delete_agreement_versions', { p_project_id: projectId });
  if (error) raiseDbError(error, VERSIONS);
  return parseRpcResult(deleteAllResultSchema, data);
}
