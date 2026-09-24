// budget-rules 리포지토리 통합 테스트 (SOT §5.18 RL-D1~RL-D7, §8.4 O-1~O-3, §8.6, §9 Budget Rules)
//
// publishable 키 + 실제 세션으로 리포지토리를 부른다 — RLS 경로·PostgREST 에러 코드
// (23505·23514·P0001)가 실제로 어떻게 매핑되는지가 검증 대상이다. 직결 SQL은 시드·정리·
// "다른 사람이 먼저 수정" 상황 재현 전용이다.
//
// RPC 계약 자체(fill/overwrite 건수·트랜잭션 원자성)는 budget-rules-migration.test.ts가 이미
// RPC 직접 호출로 검증한다. 여기서는 래퍼가 그 결과를 {added, updated, kept}로 정확히
// 돌려주는지와 에러가 사용자 문구로 바뀌는지를 본다.
//
// 자기가 만든 과제·사용자만 지운다 — 파괴적 테스트가 아니다.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Sql } from 'postgres';
import { connectDirectDb, createTestUser, destroyTestUser, type TestUser } from './helpers';
import * as projects from '@/lib/db/projects';
import * as rules from '@/lib/db/budget-rules';
import {
  ConflictError,
  NotFoundError,
  RuleViolationError,
  StaleDataError,
  ValidationError,
} from '@/lib/db/errors';

let sql: Sql;
let user: TestUser;
const tempProjectIds: string[] = []; // afterAll 안전망 — 실패해도 dev DB를 원복한다

async function newProject(name: string): Promise<string> {
  const project = await projects.createProject(user.client, {
    name,
    createdBy: user.id,
    updatedBy: user.id,
  });
  tempProjectIds.push(project.id);
  return project.id;
}

function ruleInput(
  projectId: string,
  overrides: Partial<rules.BudgetRuleInput> & { code: rules.BudgetRuleInput['code'] }
): rules.BudgetRuleInput {
  return {
    projectId,
    enabled: true,
    value: null,
    base: null,
    severity: 'error',
    source: '공고 2026-01',
    note: '',
    createdBy: user.id,
    updatedBy: user.id,
    ...overrides,
  };
}

beforeAll(async () => {
  sql = connectDirectDb();
  user = await createTestUser(sql);
});

afterAll(async () => {
  if (tempProjectIds.length > 0) {
    await sql`delete from public.projects where id = any(${tempProjectIds}::uuid[])`;
  }
  await destroyTestUser(sql, user);
  await sql.end();
});

// ─── 삽입·조회 ───────────────────────────────────────────────

describe('insert / listByProject / getByCode', () => {
  let projectId: string;

  beforeAll(async () => {
    projectId = await newProject('규칙 리포지토리 — 조회');
  });

  it('insert — camelCase 행을 돌려주고 value는 number, version은 1', async () => {
    const created = await rules.insert(
      user.client,
      ruleInput(projectId, { code: 'indirect_max', value: 69.2308, base: 'direct_cash_excl_intl_consign_burden' })
    );
    expect(created).toMatchObject({
      projectId,
      code: 'indirect_max',
      enabled: true,
      value: 69.2308,
      base: 'direct_cash_excl_intl_consign_burden',
      severity: 'error',
      source: '공고 2026-01',
      note: '',
      version: 1,
      createdBy: user.id,
      updatedBy: user.id,
    });
    expect(typeof created.value).toBe('number');
    expect(created).not.toHaveProperty('project_id');
  });

  it('금액 코드는 원 단위 정수 그대로 돌아온다 (절대 규칙 4)', async () => {
    const created = await rules.insert(
      user.client,
      ruleInput(projectId, { code: 'equipment_review_threshold', value: 30_000_000, severity: 'warn' })
    );
    expect(created.value).toBe(30_000_000);
    expect(Number.isInteger(created.value)).toBe(true);
  });

  it('값 없는 코드(no_burden)는 value null로 들어간다', async () => {
    const created = await rules.insert(user.client, ruleInput(projectId, { code: 'no_burden' }));
    expect(created.value).toBeNull();
    expect(created.base).toBeNull();
  });

  it('listByProject — code 순 정렬, 다른 과제 행은 섞이지 않는다', async () => {
    const otherId = await newProject('규칙 리포지토리 — 다른 과제');
    await rules.insert(user.client, ruleInput(otherId, { code: 'allowance_max', value: 20 }));

    const listed = await rules.listByProject(user.client, projectId);
    expect(listed.map((r) => r.code)).toEqual([
      'equipment_review_threshold', 'indirect_max', 'no_burden',
    ]);
    expect(listed.every((r) => r.projectId === projectId)).toBe(true);
  });

  it('getByCode — 있으면 행, 없으면 null (행 없음 = 검사 안 함, 오류 아님)', async () => {
    const found = await rules.getByCode(user.client, projectId, 'indirect_max');
    expect(found?.value).toBe(69.2308);

    const missing = await rules.getByCode(user.client, projectId, 'gov_share_max');
    expect(missing).toBeNull();
  });
});

// ─── update — 낙관적 잠금 ────────────────────────────────────

describe('update — §8.4 O-1~O-3 낙관적 잠금', () => {
  let projectId: string;
  let ruleId: string;

  beforeAll(async () => {
    projectId = await newProject('규칙 리포지토리 — 갱신');
    const created = await rules.insert(
      user.client,
      ruleInput(projectId, { code: 'allowance_max', value: 20 })
    );
    ruleId = created.id;
  });

  it('expectedVersion이 맞으면 갱신되고 version이 +1', async () => {
    const updated = await rules.update(
      user.client,
      ruleId,
      { value: 18, severity: 'warn', note: '공고에서 달리 정함', updatedBy: user.id },
      1
    );
    expect(updated).toMatchObject({ value: 18, severity: 'warn', note: '공고에서 달리 정함', version: 2 });
  });

  it('expectedVersion 없이도 갱신된다 (O-2 단일 조작)', async () => {
    const updated = await rules.update(user.client, ruleId, { enabled: false });
    expect(updated).toMatchObject({ enabled: false, version: 3 });
  });

  it('expectedVersion이 낡았으면 StaleDataError — 최신 updatedBy를 담는다 (O-3)', async () => {
    const stale = rules.update(user.client, ruleId, { value: 15 }, 1);
    await expect(stale).rejects.toBeInstanceOf(StaleDataError);
    await expect(stale).rejects.toMatchObject({ code: 'STALE', updatedBy: user.id });

    // 값은 바뀌지 않았다
    const after = await rules.getByCode(user.client, projectId, 'allowance_max');
    expect(after).toMatchObject({ value: 18, version: 3 });
  });

  it('없는 id → NotFoundError (잠금 실패와 구분)', async () => {
    await expect(
      rules.update(user.client, '00000000-0000-4000-8000-000000000000', { value: 15 }, 1)
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  it('빈 patch → ValidationError', async () => {
    await expect(rules.update(user.client, ruleId, {})).rejects.toBeInstanceOf(ValidationError);
    await expect(rules.update(user.client, ruleId, { value: undefined })).rejects.toBeInstanceOf(
      ValidationError
    );
  });

  it('갱신으로 check를 깨면 RuleViolationError (RL-D2 — 꺼진 규칙을 값 없이 켜기)', async () => {
    await rules.update(user.client, ruleId, { value: null }); // enabled=false라 허용
    await expect(rules.update(user.client, ruleId, { enabled: true })).rejects.toMatchObject({
      code: 'RULE',
      message: expect.stringContaining('기준값'),
    });
  });
});

// ─── 에러 매핑 ───────────────────────────────────────────────

describe('에러 매핑 — 23505 → ConflictError, 23514 → RuleViolationError(제약별 문구)', () => {
  let projectId: string;

  beforeAll(async () => {
    projectId = await newProject('규칙 리포지토리 — 에러');
    await rules.insert(user.client, ruleInput(projectId, { code: 'allowance_max', value: 20 }));
  });

  it('같은 (project, code) 두 번 → ConflictError (RL-D1)', async () => {
    const dup = rules.insert(user.client, ruleInput(projectId, { code: 'allowance_max', value: 15 }));
    await expect(dup).rejects.toBeInstanceOf(ConflictError);
    await expect(dup).rejects.toMatchObject({ code: 'CONFLICT' });
  });

  it('값 없는 코드에 값 → RuleViolationError, 값 범위 문구 (RL-D2)', async () => {
    const bad = rules.insert(user.client, ruleInput(projectId, { code: 'no_burden', value: 0 }));
    await expect(bad).rejects.toBeInstanceOf(RuleViolationError);
    await expect(bad).rejects.toMatchObject({
      code: 'RULE',
      message: expect.stringContaining('범위'),
    });
    // SA-4: 제약 이름·테이블명이 사용자 문구에 새지 않는다
    await expect(bad).rejects.not.toMatchObject({ message: expect.stringContaining('budget_rules') });
  });

  it('빈 source → RuleViolationError, 출처 문구 (RL-D5)', async () => {
    const bad = rules.insert(user.client, ruleInput(projectId, { code: 'gov_share_max', value: 75, source: '   ' }));
    await expect(bad).rejects.toBeInstanceOf(RuleViolationError);
    await expect(bad).rejects.toMatchObject({ message: expect.stringContaining('출처') });
  });

  it('base 없는 indirect_max → RuleViolationError, 분모 문구 (RL-D3)', async () => {
    const bad = rules.insert(user.client, ruleInput(projectId, { code: 'indirect_max', value: 25 }));
    await expect(bad).rejects.toBeInstanceOf(RuleViolationError);
    await expect(bad).rejects.toMatchObject({ message: expect.stringContaining('분모') });
  });

  it('indirect_max가 아닌 코드에 base → 같은 분모 문구 (RL-D3)', async () => {
    const bad = rules.insert(
      user.client,
      ruleInput(projectId, { code: 'consignment_max', value: 40, base: 'direct_cash_excl_intl' })
    );
    await expect(bad).rejects.toMatchObject({ code: 'RULE', message: expect.stringContaining('분모') });
  });

  it('켜져 있는데 값이 없는 비율 코드 → 기준값 문구 (RL-D2)', async () => {
    const bad = rules.insert(user.client, ruleInput(projectId, { code: 'own_cash_min', value: null }));
    await expect(bad).rejects.toMatchObject({ code: 'RULE', message: expect.stringContaining('기준값') });
  });
});

// ─── applyPreset ─────────────────────────────────────────────

describe('applyPreset — fill / overwrite (§9, RL-D4)', () => {
  let projectId: string;

  // RPC 계약 검증용 임의 행 — 부록 D 값은 T4(lib/rules-presets.ts)의 몫이다
  const PRESET: rules.RulePresetRow[] = [
    { code: 'allowance_max', enabled: true, value: 20, base: null, severity: 'error',
      source: '과기부고시 제2026-38호 제26조①', note: '' },
    { code: 'indirect_max', enabled: true, value: 25, base: 'direct_cash_excl_intl_consign_burden',
      severity: 'error', source: '과기부고시 제2026-38호 제30조', note: '' },
    { code: 'no_burden', enabled: true, value: null, base: null, severity: 'error',
      source: '과기부고시 제2026-38호 제12조', note: '' },
  ];

  beforeAll(async () => {
    projectId = await newProject('규칙 리포지토리 — 프리셋');
    // 사용자가 미리 손본 행 1 + 프리셋에 없는 행 1
    await rules.insert(
      user.client,
      ruleInput(projectId, { code: 'allowance_max', value: 15, severity: 'warn', note: '공고에서 달리 정함' })
    );
    await rules.insert(user.client, ruleInput(projectId, { code: 'min_participation', value: 10 }));
  });

  it('fill — 없는 code만 추가 (added 2 · updated 0 · kept 1), 기존 행 그대로', async () => {
    const result = await rules.applyPreset(user.client, projectId, 'fill', PRESET);
    expect(result).toEqual({ added: 2, updated: 0, kept: 1 });

    const listed = await rules.listByProject(user.client, projectId);
    expect(listed.map((r) => r.code)).toEqual([
      'allowance_max', 'indirect_max', 'min_participation', 'no_burden',
    ]);
    expect(listed.find((r) => r.code === 'allowance_max')).toMatchObject({
      value: 15, severity: 'warn', note: '공고에서 달리 정함', version: 1,
    });
    expect(listed.find((r) => r.code === 'indirect_max')).toMatchObject({
      value: 25, base: 'direct_cash_excl_intl_consign_burden', version: 1,
    });
  });

  it('overwrite — 다른 행 갱신(version +1)·같은 행 유지·프리셋 밖 행 보존 (added 0 · updated 1 · kept 2)', async () => {
    const result = await rules.applyPreset(user.client, projectId, 'overwrite', PRESET);
    expect(result).toEqual({ added: 0, updated: 1, kept: 2 });

    const listed = await rules.listByProject(user.client, projectId);
    expect(listed.find((r) => r.code === 'allowance_max')).toMatchObject({
      value: 20, severity: 'error', source: '과기부고시 제2026-38호 제26조①', note: '', version: 2,
    });
    expect(listed.find((r) => r.code === 'indirect_max')?.version).toBe(1);
    // 사용자가 직접 넣은 규칙은 건드리지 않는다
    expect(listed.find((r) => r.code === 'min_participation')).toMatchObject({
      value: 10, source: '공고 2026-01', version: 1,
    });
  });

  it('overwrite에서 note null은 메모를 건드리지 않는다', async () => {
    const target = await rules.getByCode(user.client, projectId, 'no_burden');
    await rules.update(user.client, target!.id, { note: '메모 유지' });

    const result = await rules.applyPreset(user.client, projectId, 'overwrite', [
      { ...PRESET[2]!, note: null },
    ]);
    expect(result).toEqual({ added: 0, updated: 0, kept: 1 });
    expect((await rules.getByCode(user.client, projectId, 'no_burden'))?.note).toBe('메모 유지');
  });

  it('check 위반 행이 섞이면 RuleViolationError — 전체가 되돌아간다', async () => {
    const before = await rules.listByProject(user.client, projectId);
    const bad = rules.applyPreset(user.client, projectId, 'overwrite', [
      { ...PRESET[0]!, value: 21 },
      { ...PRESET[1]!, value: 101 },
    ]);
    await expect(bad).rejects.toBeInstanceOf(RuleViolationError);
    await expect(bad).rejects.toMatchObject({ message: expect.stringContaining('범위') });
    expect(await rules.listByProject(user.client, projectId)).toEqual(before);
  });

  it('없는 과제 → NotFoundError, 중복 code → RuleViolationError (RPC P0001 매핑)', async () => {
    await expect(
      rules.applyPreset(user.client, '00000000-0000-4000-8000-000000000000', 'fill', PRESET)
    ).rejects.toBeInstanceOf(NotFoundError);

    const dup = rules.applyPreset(user.client, projectId, 'fill', [PRESET[0]!, PRESET[0]!]);
    await expect(dup).rejects.toBeInstanceOf(RuleViolationError);
    await expect(dup).rejects.toMatchObject({ message: expect.stringContaining('중복') });
  });
});

// ─── deleteByCode ────────────────────────────────────────────

describe('deleteByCode', () => {
  let projectId: string;

  beforeAll(async () => {
    projectId = await newProject('규칙 리포지토리 — 삭제');
    await rules.insert(user.client, ruleInput(projectId, { code: 'no_student_personnel' }));
    await rules.insert(user.client, ruleInput(projectId, { code: 'no_burden' }));
  });

  it('해당 (project, code)만 지운다', async () => {
    await rules.deleteByCode(user.client, projectId, 'no_student_personnel');
    expect((await rules.listByProject(user.client, projectId)).map((r) => r.code)).toEqual(['no_burden']);
  });

  it('없는 행을 지우면 NotFoundError — 조용히 성공하지 않는다', async () => {
    await expect(
      rules.deleteByCode(user.client, projectId, 'no_student_personnel')
    ).rejects.toBeInstanceOf(NotFoundError);
  });
});
