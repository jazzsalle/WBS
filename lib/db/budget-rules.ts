// budget_rules(연구비 사용 규칙) 리포지토리 (SOT §5.18, §8.4 O-1~O-3, §8.6, §9 Budget Rules)
// 규칙은 데이터다 — 의미(code)는 lib/rules.ts가 알고, 이 파일은 값(비율·금액·켜짐·출처)만
// 실어 나른다. 판정은 여기서 하지 않는다 (파생 값은 저장하지 않는다).
//
// 쓰기는 두 갈래다.
//  · insert / update / deleteByCode — 행 단위. update는 O-1 낙관적 잠금(.eq('version')).
//  · applyPreset — 프리셋 행 배열을 RPC apply_rule_preset이 한 트랜잭션에서 적용한다 (RL-D4).
//    행마다 insert를 돌리면 중간에 check 위반이 나왔을 때 절반만 적용된 채 남는다.
//
// check 제약(RL-D2·D3·D5)은 액션의 Zod 뒤에 서는 최종 방어선이다. 위반은 제약 이름으로
// 구분해 사용자 문구의 RuleViolationError로 올린다 — 조용히 삼키지 않는다 (절대 규칙 5).

import type { PostgrestError, SupabaseClient } from '@supabase/supabase-js';
import { z } from 'zod';
import type { BaseEntity, BudgetRule, IndirectBase, RuleCode, RuleSeverity } from '@/types';
import { appToDb, dbToApp } from './mapper';
import { budgetRuleRowSchema } from './schema';
import {
  ConflictError,
  NotFoundError,
  RuleViolationError,
  StaleDataError,
  ValidationError,
} from './errors';

const TABLE = 'budget_rules';

// SA-4: 테이블명·제약명 같은 내부 정보를 사용자 메시지에 싣지 않는다
const SCHEMA_MISMATCH_MESSAGE =
  'DB 응답이 앱이 기대하는 형식과 다릅니다. 앱과 DB 마이그레이션 버전을 확인하세요.';
const NOT_FOUND_MESSAGE = '규칙을 찾을 수 없습니다.';

// ─── 에러 매핑 ───────────────────────────────────────────────

// 23514(check 위반) 메시지에는 제약 이름이 들어온다 — 어느 규칙(RL-D2·D3·D5)에 걸렸는지
// 그 이름으로 가른다. 20260817000000_budget_rules.sql의 제약 이름이 바뀌면 여기도 같이 바꾼다.
// 이름을 못 알아보면 일반 문구로 올린다 — 마이그레이션이 앞서간 신호이지 성공이 아니다.
const CHECK_CONSTRAINT_MESSAGES: ReadonlyArray<readonly [RegExp, string]> = [
  [/budget_rules_value_range_check/,
    '규칙 값의 범위가 맞지 않습니다. 비율은 0~100, 금액은 0 이상 정수이며, 값을 쓰지 않는 규칙에는 값을 넣을 수 없습니다.'],
  [/budget_rules_enabled_value_check/,
    '켜져 있는 규칙에는 기준값이 있어야 합니다. 값을 입력하거나 규칙을 끄세요.'],
  [/budget_rules_base_code_check/,
    '간접비 분모(base)는 간접비 상한 규칙에서만, 그리고 반드시 지정해야 합니다.'],
  [/budget_rules_source_check/,
    '규칙의 출처를 비워 둘 수 없습니다. 고시 조문이나 공고명을 적으세요.'],
  [/budget_rules_code_check/, '알 수 없는 규칙 코드입니다.'],
  [/budget_rules_severity_check/, '규칙의 심각도는 error·warn·info 중 하나여야 합니다.'],
  [/budget_rules_base_check/, '알 수 없는 간접비 분모입니다.'],
];
const UNKNOWN_CHECK_MESSAGE = '규칙이 DB 제약을 위반했습니다. 입력값을 확인하세요.';

// RPC의 raise exception은 전부 P0001로 온다 — 메시지로 "없음"과 "규칙 위반"을 가른다
// (lib/db/budget-details.ts와 같은 해석 규칙)
const NOT_FOUND_MESSAGE_PATTERN = /찾을 수 없습니다|not found/i;

function checkViolationMessage(error: PostgrestError): string {
  const text = `${error.message} ${error.details ?? ''}`;
  for (const [pattern, message] of CHECK_CONSTRAINT_MESSAGES) {
    if (pattern.test(text)) return message;
  }
  return UNKNOWN_CHECK_MESSAGE;
}

function raiseDbError(error: PostgrestError): never {
  if (error.code === '23505') {
    throw new ConflictError('이 과제에 같은 규칙이 이미 있습니다. 기존 규칙을 수정하세요.');
  }
  if (error.code === '23514') throw new RuleViolationError(checkViolationMessage(error));
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
    console.error('[db/budget-rules] row 검증 실패:', result.error.issues);
    throw new ValidationError(SCHEMA_MISMATCH_MESSAGE);
  }
  return result.data;
}

function toRule(row: unknown): BudgetRule {
  return dbToApp<BudgetRule>(parseRow(budgetRuleRowSchema, row));
}

// undefined 키 제거 — JSON 직렬화에서 빠져 빈 body가 되는 것을 막고,
// "갱신할 내용 없음"을 명시적으로 판정하기 위함
function definedOnly(obj: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined));
}

// 0행 갱신의 원인 구분: 행이 없으면 NotFound, 있으면 낙관적 잠금 실패 (§8.4 O-1).
// O-3 표시("OO님이 먼저 수정했습니다")를 위해 최신 행의 updated_by를 담는다.
async function raiseStaleOrNotFound(client: SupabaseClient, id: string): Promise<never> {
  const { data, error } = await client.from(TABLE).select('updated_by').eq('id', id).maybeSingle();
  if (error) raiseDbError(error);
  if (!data) throw new NotFoundError(NOT_FOUND_MESSAGE);
  throw new StaleDataError(
    parseRow(z.object({ updated_by: z.uuid().nullable() }), data).updated_by
  );
}

// ─── 조회 ────────────────────────────────────────────────────

/** 과제의 규칙 전부, code 순. 코드 종류는 17개라 페이징이 필요 없다 */
export async function listByProject(
  client: SupabaseClient,
  projectId: string
): Promise<BudgetRule[]> {
  const { data, error } = await client
    .from(TABLE)
    .select('*')
    .eq('project_id', projectId)
    .order('code', { ascending: true });
  if (error) raiseDbError(error);
  return (data ?? []).map(toRule);
}

/**
 * (과제, 코드) 한 행. 없으면 null — "행 없음"은 오류가 아니라 "이 검사를 하지 않는다"는
 * 정상 상태다 (PL-14). §9 upsertBudgetRule이 insert/update를 가르는 데 쓴다.
 */
export async function getByCode(
  client: SupabaseClient,
  projectId: string,
  code: RuleCode
): Promise<BudgetRule | null> {
  const { data, error } = await client
    .from(TABLE)
    .select('*')
    .eq('project_id', projectId)
    .eq('code', code)
    .maybeSingle();
  if (error) raiseDbError(error);
  return data ? toRule(data) : null;
}

// ─── 쓰기 ────────────────────────────────────────────────────

// 서버 액션이 createdBy/updatedBy를 세션 사용자로 채운다 (SA-2)
export type BudgetRuleInput = Omit<BudgetRule, keyof BaseEntity> & {
  createdBy?: string | null;
  updatedBy?: string | null;
};

// projectId·code는 행의 정체성이라 patch로 바꾸지 않는다 — 옮기려면 지우고 새로 넣는다 (§9 upsertBudgetRule 인자 순서와 같다)
export type BudgetRulePatch = Partial<Omit<BudgetRule, keyof BaseEntity | 'projectId' | 'code'>> & {
  updatedBy?: string | null;
};

export async function insert(client: SupabaseClient, input: BudgetRuleInput): Promise<BudgetRule> {
  const { data, error } = await client.from(TABLE).insert(appToDb(input)).select('*').single();
  if (error) raiseDbError(error);
  return toRule(data);
}

export async function update(
  client: SupabaseClient,
  id: string,
  patch: BudgetRulePatch,
  expectedVersion?: number
): Promise<BudgetRule> {
  const dbPatch = definedOnly(appToDb(patch));
  if (Object.keys(dbPatch).length === 0) {
    throw new ValidationError('갱신할 내용이 없습니다.');
  }
  let query = client.from(TABLE).update(dbPatch).eq('id', id);
  if (expectedVersion !== undefined) {
    query = query.eq('version', expectedVersion); // §8.4: 그새 바뀌었으면 0행 갱신
  }
  const { data, error } = await query.select('*');
  if (error) raiseDbError(error);
  const row = (data ?? [])[0];
  if (row === undefined) return raiseStaleOrNotFound(client, id);
  return toRule(row);
}

/** 물리 삭제. 지운 뒤의 뜻은 "이 검사를 하지 않는다"(PL-14)이므로 되돌리기는 다시 넣는 것이다 */
export async function deleteByCode(
  client: SupabaseClient,
  projectId: string,
  code: RuleCode
): Promise<void> {
  const { data, error } = await client
    .from(TABLE)
    .delete()
    .eq('project_id', projectId)
    .eq('code', code)
    .select('id');
  if (error) raiseDbError(error);
  if ((data ?? []).length === 0) throw new NotFoundError(NOT_FOUND_MESSAGE);
}

// ─── 프리셋 적용 (RPC — 한 트랜잭션, RL-D4) ──────────────────

export type RulePresetMode = 'fill' | 'overwrite';

/**
 * RPC에 보내는 행 하나. 부록 D 프리셋(lib/rules-presets.ts)에서 만든다.
 * note가 null이면 overwrite에서도 기존 메모를 건드리지 않는다(insert면 '').
 */
export type RulePresetRow = {
  code: RuleCode;
  enabled: boolean;
  value: number | null;
  base: IndirectBase | null;
  severity: RuleSeverity;
  source: string;
  note: string | null;
};

export interface ApplyPresetResult {
  added: number;   // 없던 code를 새로 넣은 수
  updated: number; // overwrite에서 값이 달라 갱신한 수 (version +1)
  kept: number;    // 이미 있어 그대로 둔 수. 프리셋 밖의 기존 행은 세지 않는다
}

const applyPresetResultSchema = z.object({
  added: z.number().int().nonnegative(),
  updated: z.number().int().nonnegative(),
  kept: z.number().int().nonnegative(),
});

/**
 * fill = 없는 code만 추가, overwrite = 프리셋에 있는 code 전부 덮기.
 * 어느 쪽이든 프리셋에 없는 기존 행은 보존한다 (§9). 행 하나라도 check에 걸리면 전체가 되돌아간다.
 */
export async function applyPreset(
  client: SupabaseClient,
  projectId: string,
  mode: RulePresetMode,
  rows: readonly RulePresetRow[]
): Promise<ApplyPresetResult> {
  const { data, error } = await client.rpc('apply_rule_preset', {
    p_project_id: projectId,
    p_mode: mode,
    // RPC는 jsonb_to_recordset으로 snake_case 컬럼명을 읽는다. 지금은 두 표기가 같지만
    // 컬럼이 늘어도 어긋나지 않도록 매퍼를 거친다
    p_rows: rows.map((row) => appToDb(row)),
  });
  if (error) raiseDbError(error);
  return parseRow(applyPresetResultSchema, data);
}
