'use server';

// Budget Rules(연구비 사용 규칙) 서버 액션
// (SOT §9 Budget Rules, SA-1~SA-4, §5.18 RL-D1~RL-D7, §6.14 RL-1, §7.9.5, §8.4 O-1~O-3, 부록 D)
// 반환은 ActionResult<T> — 예외를 그대로 던지지 않는다. supabase 직접 호출 금지,
// 반드시 lib/db/ 리포지토리를 거친다 (§8.6).
//
// 규칙은 **데이터**다. 여기는 값(비율·금액·켜짐·출처)을 쓰고 지울 뿐이고, 판정(evaluateRules)은
// getBudgetPlanData가 읽을 때 한다 — 파생 값(findings)은 저장하지 않는다 (§9).
//
// RL-D2·D3·D5는 DB check 제약과 같은 뜻으로 Zod + RULE_SPECS로 **먼저** 거른다. DB까지 가서
// 23514로 되돌아오면 RULE로 보이는데, 이것은 사용자 입력 문제이지 규칙 위반이 아니므로
// VALIDATION이어야 화면이 입력 칸에 붙여 보여줄 수 있다. check는 최종 방어선으로 남는다.

import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { ActionResult, BudgetRule, IndirectBase, RuleCode } from '@/types';
import { requireApprovedUser } from '@/lib/auth/guard';
import * as appUsers from '@/lib/db/app-users';
import * as budgetRulesRepo from '@/lib/db/budget-rules';
import * as projectsRepo from '@/lib/db/projects';
import { StaleDataError, ValidationError, toActionFailure } from '@/lib/db/errors';
import { indirectBaseSchema, ruleCodeSchema, ruleSeveritySchema } from '@/lib/db/schema';
import { RULE_SPECS } from '@/lib/rules';
import { isPresetId, presetToRows, type PresetId } from '@/lib/rules-presets';

export type { ApplyPresetResult, RulePresetMode } from '@/lib/db/budget-rules';

// ─── 입력 검증 (RL-D2·RL-D3·RL-D5) ──────────────────────────────────────────

const uuidSchema = z.uuid();

// RL-D5: 출처 없는 한도는 "지어낸 숫자"다(PL-16). 공백만 있는 문자열도 빈 것으로 본다
const sourceSchema = z
  .string()
  .trim()
  .min(1, '규칙의 출처를 비워 둘 수 없습니다. 고시 조문이나 공고명을 적으세요.')
  .max(500, '출처는 500자 이내여야 합니다.');

const noteSchema = z.string().max(10_000, '메모는 10,000자 이내여야 합니다.');

// 값의 범위·필수 여부는 코드에 따라 다르므로(RULE_SPECS) 여기서는 모양만 본다 — assertRuleShape가 마저 본다
const ruleFieldsSchema = z.object({
  enabled: z.boolean(),
  value: z.number().finite('규칙 값이 올바르지 않습니다.').nullable(),
  base: indirectBaseSchema.nullable(),
  severity: ruleSeveritySchema,
  source: sourceSchema,
  note: noteSchema,
});

const rulePatchSchema = ruleFieldsSchema.partial();

const presetModeSchema = z.enum(['fill', 'overwrite'], {
  error: '프리셋 적용 방식은 채우기(fill) 또는 덮어쓰기(overwrite)여야 합니다.',
});

const presetIdSchema = z.custom<PresetId>(isPresetId, { message: '알 수 없는 프리셋입니다.' });

function parseOrThrow<T>(schema: z.ZodType<T>, value: unknown, fallback: string): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    throw new ValidationError(parsed.error.issues[0]?.message ?? fallback);
  }
  return parsed.data;
}

/**
 * RL-D2·RL-D3 — 코드 × 값 조합. 저장될 **최종 모양**(기존 행 + patch)으로 판정한다.
 * patch만 보면 "꺼진 규칙의 값을 지운 뒤 나중에 켜기"처럼 두 번에 걸친 위반을 놓친다.
 */
function assertRuleShape(
  code: RuleCode,
  shape: { enabled: boolean; value: number | null; base: IndirectBase | null }
): void {
  const spec = RULE_SPECS[code];

  if (!spec.needsValue && shape.value !== null) {
    throw new ValidationError(`${spec.label} 규칙은 값을 쓰지 않습니다. 값을 비워 두세요.`);
  }
  if (spec.needsValue) {
    if (shape.value === null) {
      if (shape.enabled) {
        throw new ValidationError('켜져 있는 규칙에는 기준값이 있어야 합니다. 값을 입력하거나 규칙을 끄세요.');
      }
    } else if (spec.valueUnit === 'percent') {
      if (shape.value < 0 || shape.value > 100) {
        throw new ValidationError('비율 규칙의 값은 0 이상 100 이하여야 합니다.');
      }
    } else if (!Number.isInteger(shape.value) || shape.value < 0) {
      // 금액은 원 단위 정수다 (절대 규칙 4)
      throw new ValidationError('금액 규칙의 값은 0 이상의 원 단위 정수여야 합니다.');
    }
  }

  const needsBase = code === 'indirect_max';
  if (needsBase && shape.base === null) {
    throw new ValidationError('간접비 상한 규칙에는 수정직접비 분모(base)를 지정해야 합니다.');
  }
  if (!needsBase && shape.base !== null) {
    throw new ValidationError('수정직접비 분모(base)는 간접비 상한 규칙에서만 지정할 수 있습니다.');
  }
}

// O-3: 낙관적 잠금 실패는 "누가 먼저 고쳤는지"까지 알려야 사용자가 판단할 수 있다
// (actions/budget-plan.ts와 같은 방식). 이름 조회 실패도 삼키지 않고 로그를 남긴 뒤 기본 메시지로 폴백한다.
async function toFailure(e: unknown, client?: SupabaseClient): Promise<ActionResult<never>> {
  if (e instanceof StaleDataError && e.updatedBy !== null && client) {
    try {
      const editor = await appUsers.getAppUserById(client, e.updatedBy);
      const label = editor.name.trim() || editor.email;
      return {
        ok: false,
        error: `${label}님이 먼저 수정했습니다. 최신 내용을 확인하세요.`,
        code: 'STALE',
      };
    } catch (lookupError) {
      console.error('[actions/budget-rules] 수정자 이름 조회 실패:', lookupError);
    }
  }
  return toActionFailure(e);
}

// 규칙은 제안 모드 화면(§7.9 규칙 검증 패널·§7.9.5)에만 나온다 — actions/team.ts의 revalidateBudget와 같은 대상
function revalidateBudget(projectId: string): void {
  revalidatePath(`/projects/${projectId}/budget`);
}

/**
 * 과제 경계 검증(N-13과 같은 태도). RLS가 "보이지 않는 과제"를 막지만, 없는 과제에 대한
 * 조회가 빈 배열로 성공하면 안 된다 — 빈 배열 폴백은 데이터 손상을 감춘다 (절대 규칙 5)
 */
async function assertProject(client: SupabaseClient, projectId: string): Promise<void> {
  await projectsRepo.getProjectById(client, projectId); // 없으면 NotFoundError
}

// ─── 조회 ────────────────────────────────────────────────────────────────────

export async function listBudgetRules(projectId: string): Promise<ActionResult<BudgetRule[]>> {
  try {
    const pid = parseOrThrow(uuidSchema, projectId, '과제 ID 형식이 올바르지 않습니다.');
    const { client } = await requireApprovedUser();
    await assertProject(client, pid);
    const rules = await budgetRulesRepo.listByProject(client, pid);
    return { ok: true, data: rules };
  } catch (e) {
    return toFailure(e);
  }
}

// ─── 쓰기 ────────────────────────────────────────────────────────────────────

/**
 * (과제, 코드) 행이 있으면 갱신, 없으면 생성.
 * 갱신은 O-1 — 값·심각도·출처를 한 폼에서 한 번에 바꾸므로 expectedVersion을 받는다.
 * 생성에는 source·severity가 필수다(RL-D5·§5.18). 나머지는 enabled=true·value=null·base=null·note=''.
 * 생성 경로에서 expectedVersion은 잠글 행이 없으므로 쓰이지 않는다.
 */
export async function upsertBudgetRule(
  projectId: string,
  code: unknown,
  patch: unknown,
  expectedVersion?: number
): Promise<ActionResult<BudgetRule>> {
  let client: SupabaseClient | undefined;
  try {
    const pid = parseOrThrow(uuidSchema, projectId, '과제 ID 형식이 올바르지 않습니다.');
    const ruleCode = parseOrThrow(ruleCodeSchema, code, '알 수 없는 규칙 코드입니다.');
    const fields = parseOrThrow(rulePatchSchema, patch, '규칙 정보가 올바르지 않습니다.');

    const ctx = await requireApprovedUser();
    client = ctx.client;
    await assertProject(client, pid);

    const existing = await budgetRulesRepo.getByCode(client, pid, ruleCode);

    if (existing) {
      // updatedBy를 덧붙이기 전에 본다 — 그 뒤에는 리포지토리가 빈 patch를 알아볼 수 없다
      if (Object.values(fields).every((v) => v === undefined)) {
        throw new ValidationError('갱신할 내용이 없습니다.');
      }
      assertRuleShape(ruleCode, {
        enabled: fields.enabled ?? existing.enabled,
        value: fields.value === undefined ? existing.value : fields.value,
        base: fields.base === undefined ? existing.base : fields.base,
      });
      const updated = await budgetRulesRepo.update(
        client,
        existing.id,
        { ...fields, updatedBy: ctx.user.id },
        expectedVersion
      );
      revalidateBudget(pid);
      return { ok: true, data: updated };
    }

    if (fields.source === undefined) {
      throw new ValidationError('새 규칙에는 출처를 적어야 합니다. 고시 조문이나 공고명을 입력하세요.');
    }
    if (fields.severity === undefined) {
      throw new ValidationError('새 규칙에는 심각도(error·warn·info)를 지정해야 합니다.');
    }
    const shape = {
      enabled: fields.enabled ?? true,
      value: fields.value ?? null,
      base: fields.base ?? null,
    };
    assertRuleShape(ruleCode, shape);

    const created = await budgetRulesRepo.insert(client, {
      projectId: pid,
      code: ruleCode,
      ...shape,
      severity: fields.severity,
      source: fields.source,
      note: fields.note ?? '',
      createdBy: ctx.user.id,
      updatedBy: ctx.user.id,
    });
    revalidateBudget(pid);
    return { ok: true, data: created };
  } catch (e) {
    return toFailure(e, client);
  }
}

/** 물리 삭제. 지운 뒤의 뜻은 "이 검사를 하지 않는다"(PL-14) — 화면이 확인 문구에 적는다 (§7.9.5) */
export async function deleteBudgetRule(
  projectId: string,
  code: unknown
): Promise<ActionResult<null>> {
  try {
    const pid = parseOrThrow(uuidSchema, projectId, '과제 ID 형식이 올바르지 않습니다.');
    const ruleCode = parseOrThrow(ruleCodeSchema, code, '알 수 없는 규칙 코드입니다.');
    const { client } = await requireApprovedUser();
    await assertProject(client, pid);

    await budgetRulesRepo.deleteByCode(client, pid, ruleCode);
    revalidateBudget(pid);
    return { ok: true, data: null };
  } catch (e) {
    return toFailure(e);
  }
}

/**
 * 부록 D 프리셋을 과제 행으로 옮긴다 (RL-D4). fill = 없는 코드만 추가, overwrite = 프리셋에 있는
 * 코드 전부 덮기(2단계 확인은 화면의 몫, §7.9.5). 어느 쪽이든 프리셋 밖의 기존 행은 보존한다.
 * RPC가 한 트랜잭션에서 적용하므로 행 하나라도 check에 걸리면 전체가 되돌아간다.
 */
export async function applyRulePreset(
  projectId: string,
  presetId: unknown,
  mode: unknown
): Promise<ActionResult<budgetRulesRepo.ApplyPresetResult>> {
  try {
    const pid = parseOrThrow(uuidSchema, projectId, '과제 ID 형식이 올바르지 않습니다.');
    const preset = parseOrThrow(presetIdSchema, presetId, '알 수 없는 프리셋입니다.');
    const presetMode = parseOrThrow(presetModeSchema, mode, '프리셋 적용 방식이 올바르지 않습니다.');
    const { client } = await requireApprovedUser();
    await assertProject(client, pid);

    const result = await budgetRulesRepo.applyPreset(client, pid, presetMode, presetToRows(preset));
    revalidateBudget(pid);
    return { ok: true, data: result };
  } catch (e) {
    return toFailure(e);
  }
}
