// Budget Rules 서버 액션 — Phase 26 새 코드 (SOT §5.18, §6.14.8 RL-22·RL-23, §7.9.5, 부록 D, phase-26-plan S-4·S-7)
//
// budget-rules-actions.test.ts와 같은 방식(next/headers 스텁 + 실제 세션)으로 액션을 그대로 부른다.
// 여기서 고정하는 것:
//  1. lab_safety_min·lab_safety_max — 값(%)이 필요하고 0~100 범위만 받는다(RL-D2). 범위 밖은 DB에 닿기 전 VALIDATION
//  2. preserve_subcategory_totals — 값 없는 규칙. 값을 주면 VALIDATION, 없이 만들고 끄고 켤 수 있다(행이 꺼짐 = RL-23 세 번째 상태)
//  3. 프리셋 D.1(msit_profit)·D.2(moe_energy_sme)가 간사 지침 3행을 출처 그대로 넣는다(10→13, 17→20)
//
// 자기가 만든 과제·사용자만 지운다 — 파괴적 테스트가 아니다.

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Sql } from 'postgres';
import { connectDirectDb, createTestUser, destroyTestUser, type TestUser } from './helpers';
import type { ActionResult } from '@/types';
import * as projectsRepo from '@/lib/db/projects';
import { RULE_PRESETS } from '@/lib/rules-presets';

const session = vi.hoisted(() => ({ accessToken: '' }));

vi.mock('next/headers', () => ({
  cookies: async () => ({ get: () => ({ value: session.accessToken }) }),
}));
vi.mock('next/cache', () => ({ revalidatePath: () => undefined }));

const rules = await import('@/actions/budget-rules');

let sql: Sql;
let user: TestUser;
const tempProjectIds: string[] = [];

const SOURCE = '공고 2026-01 (Phase 26 액션 테스트)';
const LAB_MIN_SOURCE = '간사 지침 연구실 안전관리비 (인건비 + 학생인건비의 1% 이상)';
const LAB_MAX_SOURCE = '간사 지침 연구실 안전관리비 (인건비 + 학생인건비의 2% 이하)';
const PRESERVE_SOURCE = '간사 지침 세목 총액 보존 (연차 간 이동 시 세목별 총액 유지)';

function unwrap<T>(result: ActionResult<T>): T {
  if (!result.ok) {
    throw new Error(`액션 실패: ${result.error} (code=${result.code ?? '-'})`);
  }
  return result.data;
}

function expectCode(result: ActionResult<unknown>, code: string): string {
  if (result.ok) throw new Error(`실패해야 하는 호출이 통과했습니다 (기대 code=${code}).`);
  expect(result.code).toBe(code);
  return result.error;
}

async function newProject(name: string): Promise<string> {
  const project = await projectsRepo.createProjectWithDefaults(user.client, {
    name,
    contractStartDate: '2026-01-01',
  });
  tempProjectIds.push(project.id);
  return project.id;
}

async function ruleByCode(projectId: string, code: string) {
  return unwrap(await rules.listBudgetRules(projectId)).find((r) => r.code === code);
}

beforeAll(async () => {
  sql = connectDirectDb();
  user = await createTestUser(sql);
  session.accessToken = user.accessToken;
});

afterAll(async () => {
  for (const id of tempProjectIds) {
    await sql`delete from public.projects where id = ${id}::uuid`;
  }
  let remaining = 0;
  for (const id of tempProjectIds) {
    const rows = await sql`
      select ((select count(*) from public.projects     where id         = ${id}::uuid)
            + (select count(*) from public.budget_rules where project_id = ${id}::uuid))::text as n`;
    remaining += Number((rows[0] as { n: string }).n);
  }
  if (remaining !== 0) {
    throw new Error(`테스트가 만든 데이터가 ${remaining}건 남았습니다.`);
  }
  await destroyTestUser(sql, user);
  await sql.end();
});

// ─── RL-22 ───────────────────────────────────────────────────

describe('upsertBudgetRule — lab_safety_min·lab_safety_max (RL-22, 값 %)', () => {
  let projectId: string;

  beforeAll(async () => {
    projectId = await newProject('규칙 액션 Phase 26 — RL-22');
  });

  it('값이 있으면 만든다 — 경계 0·100도 받는다', async () => {
    const min = unwrap(
      await rules.upsertBudgetRule(projectId, 'lab_safety_min', { value: 1, severity: 'warn', source: LAB_MIN_SOURCE })
    );
    expect(min).toMatchObject({ code: 'lab_safety_min', enabled: true, value: 1, base: null, source: LAB_MIN_SOURCE });

    const max = unwrap(
      await rules.upsertBudgetRule(projectId, 'lab_safety_max', { value: 2, severity: 'warn', source: LAB_MAX_SOURCE })
    );
    expect(max).toMatchObject({ code: 'lab_safety_max', value: 2 });

    const zero = unwrap(await rules.upsertBudgetRule(projectId, 'lab_safety_min', { value: 0 }, min.version));
    expect(zero).toMatchObject({ value: 0, version: min.version + 1 });
    const hundred = unwrap(await rules.upsertBudgetRule(projectId, 'lab_safety_max', { value: 100 }, max.version));
    expect(hundred.value).toBe(100);
    // 소수 비율도 비율 규칙이라 받는다(금액이 아니다)
    expect(unwrap(await rules.upsertBudgetRule(projectId, 'lab_safety_max', { value: 1.5 }, hundred.version)).value).toBe(1.5);
  });

  it('범위 밖(-1·101)·켜졌는데 값 없음·base 지정 → VALIDATION (RL-D2·D3)', async () => {
    const before = await ruleByCode(projectId, 'lab_safety_min');
    expect(expectCode(await rules.upsertBudgetRule(projectId, 'lab_safety_min', { value: -1 }), 'VALIDATION')).toContain(
      '0 이상 100 이하'
    );
    expectCode(await rules.upsertBudgetRule(projectId, 'lab_safety_min', { value: 101 }), 'VALIDATION');
    expectCode(await rules.upsertBudgetRule(projectId, 'lab_safety_min', { value: null }), 'VALIDATION');
    expectCode(
      await rules.upsertBudgetRule(projectId, 'lab_safety_min', { base: 'direct_cash_excl_intl' }),
      'VALIDATION'
    );
    // 새 행도 같은 검증 — 다른 과제에서 값 없이 켜서 만들면 거른다
    const other = await newProject('규칙 액션 Phase 26 — RL-22 값 없음');
    expectCode(
      await rules.upsertBudgetRule(other, 'lab_safety_max', { severity: 'warn', source: SOURCE }),
      'VALIDATION'
    );
    expect(unwrap(await rules.listBudgetRules(other))).toEqual([]);
    // 거른 호출은 아무것도 바꾸지 않았다
    expect(await ruleByCode(projectId, 'lab_safety_min')).toEqual(before);
  });

  it('꺼진 행은 값 없이 둘 수 있다', async () => {
    const row = await ruleByCode(projectId, 'lab_safety_min');
    const off = unwrap(
      await rules.upsertBudgetRule(projectId, 'lab_safety_min', { enabled: false, value: null }, row?.version)
    );
    expect(off).toMatchObject({ enabled: false, value: null });
  });
});

// ─── RL-23 ───────────────────────────────────────────────────

describe('upsertBudgetRule — preserve_subcategory_totals (RL-23, 값 없음·수행 전용)', () => {
  let projectId: string;

  beforeAll(async () => {
    projectId = await newProject('규칙 액션 Phase 26 — RL-23');
  });

  it('값을 주면 VALIDATION — 값 없는 규칙이다', async () => {
    const message = expectCode(
      await rules.upsertBudgetRule(projectId, 'preserve_subcategory_totals', {
        value: 1,
        severity: 'warn',
        source: PRESERVE_SOURCE,
      }),
      'VALIDATION'
    );
    expect(message).toContain('값을 쓰지 않습니다');
    expect(unwrap(await rules.listBudgetRules(projectId))).toEqual([]);
  });

  it('값 없이 만들고, 끄고(세 번째 상태의 재료), 다시 켠다 — O-1 version이 오른다', async () => {
    const created = unwrap(
      await rules.upsertBudgetRule(projectId, 'preserve_subcategory_totals', {
        severity: 'warn',
        source: PRESERVE_SOURCE,
      })
    );
    expect(created).toMatchObject({
      code: 'preserve_subcategory_totals',
      enabled: true,
      value: null,
      base: null,
      severity: 'warn',
      source: PRESERVE_SOURCE,
      version: 1,
    });

    const off = unwrap(
      await rules.upsertBudgetRule(projectId, 'preserve_subcategory_totals', { enabled: false }, created.version)
    );
    expect(off).toMatchObject({ enabled: false, value: null, version: 2 });

    // 낡은 version이면 STALE (O-1)
    expectCode(
      await rules.upsertBudgetRule(projectId, 'preserve_subcategory_totals', { enabled: true }, created.version),
      'STALE'
    );

    const on = unwrap(
      await rules.upsertBudgetRule(projectId, 'preserve_subcategory_totals', { enabled: true }, off.version)
    );
    expect(on).toMatchObject({ enabled: true, version: 3 });
  });

  it('삭제하면 행이 없어진다 — 행 없음 = 켜진 것으로 판정(판정은 lib/agreement 쪽)', async () => {
    unwrap(await rules.deleteBudgetRule(projectId, 'preserve_subcategory_totals'));
    expect(await ruleByCode(projectId, 'preserve_subcategory_totals')).toBeUndefined();
  });
});

// ─── 프리셋 +3행 ─────────────────────────────────────────────

describe('applyRulePreset — 간사 지침 3행 (부록 D.1 13행·D.2 20행)', () => {
  const NEW_ROWS = [
    { code: 'lab_safety_min', enabled: true, value: 1, base: null, severity: 'warn', source: LAB_MIN_SOURCE },
    { code: 'lab_safety_max', enabled: true, value: 2, base: null, severity: 'warn', source: LAB_MAX_SOURCE },
    { code: 'preserve_subcategory_totals', enabled: true, value: null, base: null, severity: 'warn', source: PRESERVE_SOURCE },
  ] as const;

  it.each([
    ['msit_profit', 13],
    ['moe_energy_sme', 20],
  ] as const)('%s fill → %i행, 새 3행은 간사 지침 출처 그대로', async (presetId, expected) => {
    expect(RULE_PRESETS[presetId].rules).toHaveLength(expected);
    const projectId = await newProject(`규칙 액션 Phase 26 — 프리셋 ${presetId}`);

    const result = unwrap(await rules.applyRulePreset(projectId, presetId, 'fill'));
    expect(result).toEqual({ added: expected, updated: 0, kept: 0 });

    const listed = unwrap(await rules.listBudgetRules(projectId));
    expect(listed).toHaveLength(expected);
    for (const row of NEW_ROWS) {
      expect(listed.find((r) => r.code === row.code)).toMatchObject({ ...row, note: '' });
    }
  });

  it('fill은 이미 있는 새 코드 행(꺼진 RL-23)을 보존하고, overwrite는 켜짐으로 되돌린다', async () => {
    const projectId = await newProject('규칙 액션 Phase 26 — 프리셋 보존');
    unwrap(
      await rules.upsertBudgetRule(projectId, 'preserve_subcategory_totals', {
        enabled: false,
        severity: 'info',
        source: SOURCE,
        note: '이번 과제는 연차 간 이동이 잦음',
      })
    );

    const filled = unwrap(await rules.applyRulePreset(projectId, 'msit_profit', 'fill'));
    expect(filled).toEqual({ added: 12, updated: 0, kept: 1 });
    expect(await ruleByCode(projectId, 'preserve_subcategory_totals')).toMatchObject({
      enabled: false,
      severity: 'info',
      source: SOURCE,
      version: 1,
    });

    const overwritten = unwrap(await rules.applyRulePreset(projectId, 'msit_profit', 'overwrite'));
    expect(overwritten).toEqual({ added: 0, updated: 1, kept: 12 });
    expect(await ruleByCode(projectId, 'preserve_subcategory_totals')).toMatchObject({
      enabled: true,
      value: null,
      severity: 'warn',
      source: PRESERVE_SOURCE,
      note: '이번 과제는 연차 간 이동이 잦음', // 덮어쓰기는 값을 되돌리고 메모는 지킨다
      version: 2,
    });
  });
});
