// Budget Rules 서버 액션 통합 테스트
// (SOT §9 Budget Rules, SA-1~SA-4, §5.18 RL-D1~RL-D5, §8.4 O-1~O-3, 부록 D)
//
// 서버 액션은 쿠키 세션(requireApprovedUser)에서 토큰을 읽으므로 next/headers를
// "실제 세션 토큰을 돌려주는 스텁"으로 바꿔 가드까지 포함해 그대로 호출한다
// (budget-plan-actions.test.ts와 같은 방식). revalidatePath는 요청 컨텍스트 밖이라 스텁한다.
//
// 검증의 핵심:
//  1. RL-D2·D3·D5 — 값 범위·base·출처 위반은 DB에 닿기 전 VALIDATION으로 거른다(RULE이 아니다).
//  2. O-1·O-3     — 낡은 expectedVersion은 STALE + "OO님이 먼저 수정했습니다".
//  3. RL-D4       — 프리셋 fill은 기존 행을 보존하고 overwrite는 프리셋 코드만 덮는다. note는 지키지 않는다.
//  4. 과제 경계   — 없는 과제는 빈 배열이 아니라 실패다(절대 규칙 5).
// 판정(getBudgetPlanData × 프리셋)은 부록 B.7 시드가 있는 budget-plan-b7.test.ts가 고정한다.
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
const tempProjectIds: string[] = []; // afterAll 안전망 — 이 테스트가 만든 과제만 지운다

const MISSING_PROJECT_ID = '00000000-0000-4000-8000-000000000000';
const SOURCE = '공고 2026-01 (액션 테스트)';

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

// NotFoundError는 §9 코드 체계에 없어 code 없이 돌아온다 (lib/db/errors.ts) — 메시지로 확인한다
function expectNotFound(result: ActionResult<unknown>): void {
  if (result.ok) throw new Error('없는 과제에 대한 호출이 통과했습니다.');
  expect(result.code).toBeUndefined();
  expect(result.error).toContain('찾을 수 없습니다');
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
  // 규칙이 과제 cascade로 지워지지 않으면 즉시 실패시킨다 (RL-D7, 절대 규칙 5)
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

// ─── listBudgetRules / upsertBudgetRule ──────────────────────

describe('listBudgetRules + upsertBudgetRule — 정상 경로 (§9, O-1~O-3)', () => {
  let projectId: string;

  beforeAll(async () => {
    projectId = await newProject('규칙 액션 — 정상 경로');
  });

  it('규칙이 없는 과제는 빈 목록이고, 없는 과제는 실패다 (빈 배열 폴백 금지)', async () => {
    expect(unwrap(await rules.listBudgetRules(projectId))).toEqual([]);
    expectNotFound(await rules.listBudgetRules(MISSING_PROJECT_ID));
    expectCode(await rules.listBudgetRules('not-a-uuid'), 'VALIDATION');
  });

  it('없는 코드는 insert — source·severity 필수, 나머지는 기본값(enabled true·value null·base null·note "")', async () => {
    const created = unwrap(
      await rules.upsertBudgetRule(projectId, 'no_burden', { severity: 'warn', source: SOURCE })
    );
    expect(created).toMatchObject({
      projectId,
      code: 'no_burden',
      enabled: true,
      value: null,
      base: null,
      severity: 'warn',
      source: SOURCE,
      note: '',
      version: 1,
      createdBy: user.id,
      updatedBy: user.id,
    });

    // 생성에 출처·심각도가 빠지면 VALIDATION (RL-D5·§5.18)
    expectCode(await rules.upsertBudgetRule(projectId, 'allowance_max', { value: 20, severity: 'error' }), 'VALIDATION');
    expectCode(await rules.upsertBudgetRule(projectId, 'allowance_max', { value: 20, source: SOURCE }), 'VALIDATION');
    expect(await ruleByCode(projectId, 'allowance_max')).toBeUndefined();
  });

  it('있는 코드는 update — expectedVersion이 맞으면 version +1, 낡으면 STALE + 수정자 이름 (O-3)', async () => {
    const created = unwrap(
      await rules.upsertBudgetRule(projectId, 'indirect_max', {
        value: 10,
        base: 'direct_cash_excl_intl_consign_burden',
        severity: 'error',
        source: SOURCE,
      })
    );
    expect(created.version).toBe(1);

    const updated = unwrap(
      await rules.upsertBudgetRule(
        projectId,
        'indirect_max',
        { value: 12.5, note: '공고에서 달리 정함', base: 'direct_cash_excl_intl' },
        created.version
      )
    );
    expect(updated).toMatchObject({
      id: created.id,
      value: 12.5,
      base: 'direct_cash_excl_intl',
      note: '공고에서 달리 정함',
      source: SOURCE, // patch에 없는 필드는 그대로
      version: 2,
    });

    // O-1: 낡은 expectedVersion → STALE. O-3: 누가 먼저 고쳤는지 이름을 싣는다
    const message = expectCode(
      await rules.upsertBudgetRule(projectId, 'indirect_max', { value: 9 }, created.version),
      'STALE'
    );
    expect(message).toContain('님이 먼저 수정했습니다');
    expect((await ruleByCode(projectId, 'indirect_max'))?.value).toBe(12.5); // 값은 바뀌지 않았다

    // O-2: expectedVersion 없이 단일 필드 토글
    const toggled = unwrap(await rules.upsertBudgetRule(projectId, 'indirect_max', { enabled: false }));
    expect(toggled).toMatchObject({ enabled: false, value: 12.5, version: 3 });

    // 빈 patch로 있는 행을 부르면 갱신할 내용이 없다
    expectCode(await rules.upsertBudgetRule(projectId, 'indirect_max', {}), 'VALIDATION');
  });

  it('목록은 code 순이고 다른 과제·없는 과제와 섞이지 않는다', async () => {
    const otherId = await newProject('규칙 액션 — 다른 과제');
    unwrap(await rules.upsertBudgetRule(otherId, 'allowance_max', { value: 20, severity: 'error', source: SOURCE }));

    const listed = unwrap(await rules.listBudgetRules(projectId));
    expect(listed.map((r) => r.code)).toEqual(['indirect_max', 'no_burden']);
    expect(listed.every((r) => r.projectId === projectId)).toBe(true);

    expectNotFound(await rules.upsertBudgetRule(MISSING_PROJECT_ID, 'no_burden', { severity: 'warn', source: SOURCE }));
  });
});

// ─── 입력 검증 (RL-D2·RL-D3·RL-D5) ───────────────────────────

describe('upsertBudgetRule — RL-D2·D3·D5는 DB에 닿기 전 VALIDATION으로 거른다', () => {
  let projectId: string;

  beforeAll(async () => {
    projectId = await newProject('규칙 액션 — 입력 검증');
  });

  afterAll(async () => {
    // 거부된 입력이 하나라도 저장됐으면 여기서 드러난다
    expect(unwrap(await rules.listBudgetRules(projectId))).toEqual([]);
  });

  it('값 없는 코드(no_burden)에 값 → VALIDATION', async () => {
    const message = expectCode(
      await rules.upsertBudgetRule(projectId, 'no_burden', { value: 0, severity: 'warn', source: SOURCE }),
      'VALIDATION'
    );
    expect(message).toContain('값을 쓰지 않습니다');
  });

  it('빈(공백) source로 신규 → VALIDATION (RL-D5)', async () => {
    const message = expectCode(
      await rules.upsertBudgetRule(projectId, 'allowance_max', { value: 20, severity: 'error', source: '   ' }),
      'VALIDATION'
    );
    expect(message).toContain('출처');
  });

  it('base 없는 indirect_max → VALIDATION, indirect_max가 아닌 코드의 base → VALIDATION (RL-D3)', async () => {
    expect(
      expectCode(
        await rules.upsertBudgetRule(projectId, 'indirect_max', { value: 10, severity: 'error', source: SOURCE }),
        'VALIDATION'
      )
    ).toContain('분모');
    expect(
      expectCode(
        await rules.upsertBudgetRule(projectId, 'consignment_max', {
          value: 40,
          base: 'direct_cash_excl_intl',
          severity: 'error',
          source: SOURCE,
        }),
        'VALIDATION'
      )
    ).toContain('분모');
  });

  it('비율 101·-1, 금액 소수·음수 → VALIDATION (RL-D2, 절대 규칙 4)', async () => {
    expect(
      expectCode(
        await rules.upsertBudgetRule(projectId, 'allowance_max', { value: 101, severity: 'error', source: SOURCE }),
        'VALIDATION'
      )
    ).toContain('0 이상 100 이하');
    expectCode(
      await rules.upsertBudgetRule(projectId, 'allowance_max', { value: -1, severity: 'error', source: SOURCE }),
      'VALIDATION'
    );
    expect(
      expectCode(
        await rules.upsertBudgetRule(projectId, 'equipment_review_threshold', {
          value: 30_000_000.5,
          severity: 'warn',
          source: SOURCE,
        }),
        'VALIDATION'
      )
    ).toContain('원 단위 정수');
    expectCode(
      await rules.upsertBudgetRule(projectId, 'equipment_review_threshold', { value: -1, severity: 'warn', source: SOURCE }),
      'VALIDATION'
    );
  });

  it('enabled인데 값이 필요한 코드의 value가 null → VALIDATION (RL-D2)', async () => {
    const message = expectCode(
      await rules.upsertBudgetRule(projectId, 'min_participation', { severity: 'error', source: SOURCE }),
      'VALIDATION'
    );
    expect(message).toContain('기준값');
  });

  it('알 수 없는 코드·심각도·분모·모양 → VALIDATION', async () => {
    expectCode(await rules.upsertBudgetRule(projectId, 'not_a_rule', { severity: 'error', source: SOURCE }), 'VALIDATION');
    expectCode(
      await rules.upsertBudgetRule(projectId, 'no_burden', { severity: 'fatal', source: SOURCE }),
      'VALIDATION'
    );
    expectCode(
      await rules.upsertBudgetRule(projectId, 'indirect_max', { value: 10, base: 'unknown', severity: 'error', source: SOURCE }),
      'VALIDATION'
    );
    expectCode(await rules.upsertBudgetRule(projectId, 'no_burden', 'patch'), 'VALIDATION');
  });

  it('꺼진 행은 값 없이 둘 수 있지만, 켜는 순간 값이 있어야 한다 — 최종 모양으로 판정', async () => {
    const created = unwrap(
      await rules.upsertBudgetRule(projectId, 'gov_share_max', {
        enabled: false,
        severity: 'error',
        source: SOURCE,
      })
    );
    expect(created).toMatchObject({ enabled: false, value: null });

    // patch 자체(enabled만)는 멀쩡하지만 저장될 모양이 "켜짐 + 값 없음"이다
    expectCode(await rules.upsertBudgetRule(projectId, 'gov_share_max', { enabled: true }), 'VALIDATION');
    expect(await ruleByCode(projectId, 'gov_share_max')).toMatchObject({ enabled: false, version: 1 });

    unwrap(await rules.upsertBudgetRule(projectId, 'gov_share_max', { enabled: true, value: 67 }));
    unwrap(await rules.deleteBudgetRule(projectId, 'gov_share_max')); // afterAll의 "0건" 확인을 위해
  });
});

// ─── applyRulePreset ─────────────────────────────────────────

describe('applyRulePreset — fill / overwrite (§9, RL-D4, 부록 D)', () => {
  let projectId: string;
  const preset = RULE_PRESETS.moe_energy_sme;

  beforeAll(async () => {
    projectId = await newProject('규칙 액션 — 프리셋');
    // 사용자가 미리 손본 행(프리셋에도 있는 코드) + 프리셋에 없는 행
    unwrap(
      await rules.upsertBudgetRule(projectId, 'allowance_max', {
        value: 15,
        severity: 'warn',
        source: '공고 2026-XX',
        note: '공고에서 달리 정함',
      })
    );
  });

  it('잘못된 presetId·mode → VALIDATION, 없는 과제 → 실패', async () => {
    expectCode(await rules.applyRulePreset(projectId, 'nope', 'fill'), 'VALIDATION');
    expectCode(await rules.applyRulePreset(projectId, 'moe_energy_sme', 'replace'), 'VALIDATION');
    expectNotFound(await rules.applyRulePreset(MISSING_PROJECT_ID, 'moe_energy_sme', 'fill'));
    expect(unwrap(await rules.listBudgetRules(projectId))).toHaveLength(1); // 아무것도 안 바뀌었다
  });

  it('fill — 없는 코드만 추가하고 기존 행 값은 보존한다 (건수 반환)', async () => {
    const result = unwrap(await rules.applyRulePreset(projectId, 'moe_energy_sme', 'fill'));
    expect(result).toEqual({ added: preset.rules.length - 1, updated: 0, kept: 1 });

    const listed = unwrap(await rules.listBudgetRules(projectId));
    expect(listed).toHaveLength(preset.rules.length);
    expect(listed.find((r) => r.code === 'allowance_max')).toMatchObject({
      value: 15,
      severity: 'warn',
      source: '공고 2026-XX',
      note: '공고에서 달리 정함',
      version: 1,
    });
    // 프리셋의 조문 출처가 각 행 source로 들어간다 (§7.9.5)
    const indirect = listed.find((r) => r.code === 'indirect_max');
    const fromPreset = preset.rules.find((r) => r.code === 'indirect_max');
    expect(indirect).toMatchObject({
      value: fromPreset?.value,
      base: fromPreset?.base,
      severity: fromPreset?.severity,
      source: fromPreset?.source,
      note: '',
      createdBy: user.id,
    });
    // gov_share_max는 기본 75 — 67은 화면이 고르게 한다
    expect(listed.find((r) => r.code === 'gov_share_max')?.value).toBe(75);
  });

  it('overwrite — 프리셋 코드는 덮고(version +1), 프리셋 밖 행과 note는 지킨다', async () => {
    // 프리셋에 없는 사용자 규칙 — 과기부 프리셋에는 없는 코드가 없어 다른 프리셋 밖 코드를 만들 수 없으므로
    // 프리셋 행 하나에 메모를 달아 "note는 되돌리지 않는다"를 본다
    unwrap(await rules.upsertBudgetRule(projectId, 'no_burden', { note: '정부출연기관 아님 — 확인 완료' }));
    const noBurdenBefore = await ruleByCode(projectId, 'no_burden');

    const result = unwrap(await rules.applyRulePreset(projectId, 'moe_energy_sme', 'overwrite'));
    // allowance_max만 값이 달랐다. no_burden은 note만 달라 "같은 행"으로 유지된다
    expect(result).toEqual({ added: 0, updated: 1, kept: preset.rules.length - 1 });

    const listed = unwrap(await rules.listBudgetRules(projectId));
    const allowanceFromPreset = preset.rules.find((r) => r.code === 'allowance_max');
    expect(listed.find((r) => r.code === 'allowance_max')).toMatchObject({
      value: allowanceFromPreset?.value,
      severity: allowanceFromPreset?.severity,
      source: allowanceFromPreset?.source,
      note: '공고에서 달리 정함', // 덮어쓰기는 값을 되돌리는 것이지 메모를 지우는 것이 아니다
      version: 2,
    });
    expect(listed.find((r) => r.code === 'no_burden')).toMatchObject({
      note: '정부출연기관 아님 — 확인 완료',
      version: noBurdenBefore?.version,
    });
  });

  it('overwrite는 프리셋에 없는 기존 행을 지우지 않는다', async () => {
    // msit_profit에는 없는 코드(min_participation)가 moe_energy_sme 적용으로 이미 있다
    const msit = RULE_PRESETS.msit_profit;
    expect(msit.rules.some((r) => r.code === 'min_participation')).toBe(false);

    const result = unwrap(await rules.applyRulePreset(projectId, 'msit_profit', 'overwrite'));
    expect(result.added).toBe(0);
    expect(result.updated + result.kept).toBe(msit.rules.length);

    const listed = unwrap(await rules.listBudgetRules(projectId));
    expect(listed).toHaveLength(preset.rules.length); // 행 수는 그대로
    expect(listed.find((r) => r.code === 'min_participation')).toMatchObject({ value: 10 });
    // 두 프리셋의 간접비 분모가 다르다 — 덮어쓰기 뒤 과기부 정의로 바뀌어 있어야 한다
    expect(listed.find((r) => r.code === 'indirect_max')?.base).toBe('direct_cash_excl_intl_consign_burden');
  });
});

// ─── deleteBudgetRule ────────────────────────────────────────

describe('deleteBudgetRule', () => {
  let projectId: string;

  beforeAll(async () => {
    projectId = await newProject('규칙 액션 — 삭제');
    unwrap(await rules.upsertBudgetRule(projectId, 'no_student_personnel', { severity: 'warn', source: SOURCE }));
    unwrap(await rules.upsertBudgetRule(projectId, 'no_burden', { severity: 'warn', source: SOURCE }));
  });

  it('해당 코드만 지우고 목록에서 사라진다', async () => {
    expect(unwrap(await rules.deleteBudgetRule(projectId, 'no_student_personnel'))).toBeNull();
    expect(unwrap(await rules.listBudgetRules(projectId)).map((r) => r.code)).toEqual(['no_burden']);
  });

  it('없는 행·없는 과제·잘못된 코드는 조용히 성공하지 않는다', async () => {
    expectNotFound(await rules.deleteBudgetRule(projectId, 'no_student_personnel'));
    expectNotFound(await rules.deleteBudgetRule(MISSING_PROJECT_ID, 'no_burden'));
    expectCode(await rules.deleteBudgetRule(projectId, 'not_a_rule'), 'VALIDATION');
    expect(unwrap(await rules.listBudgetRules(projectId))).toHaveLength(1);
  });
});
