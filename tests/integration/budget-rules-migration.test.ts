// budget_rules 마이그레이션 통합 테스트 — 20260817000000_budget_rules.sql
// (SOT §5.18 RL-D1~RL-D7, §8.7 K-7·K-8, §8.8, §9 Budget Rules, §14.3 RLS-1)
//
// 검증의 핵심:
//  (a) 이관 — Phase 9의 projects.allowance_rate_limit·indirect_rate_limit 값이 행으로 옮겨진다.
//      컬럼은 이미 지워졌으므로 트랜잭션 안에서 임시로 다시 만들고, 마이그레이션 파일의
//      마커 블록(MIGRATE-RATE-LIMITS)을 잘라 재실행한 뒤 롤백한다 — dev DB에 흔적이 남지 않는다.
//  (b) check 제약 — RL-D2·D3·D5가 DB에서 최종 방어선으로 동작한다 (Zod는 액션이 따로 검증).
//  (c) apply_rule_preset — fill/overwrite 건수, overwrite 시 version 증가, 프리셋에 없는 행 보존.
//  (d) schema_version = 3, 한도 컬럼 삭제, RLS 활성.
//
// (c)는 publishable 키 + 실제 세션(RLS 경로)으로 RPC를 직접 부른다 — 리포지토리 래퍼(T2)가
// 아직 없고, 이 파일이 검증하는 대상이 RPC 계약 자체다. 직결 SQL은 (a)(b)(d)와 결과 확인 전용.
//
// 자기가 만든 과제·사용자만 지운다 — 파괴적 테스트가 아니다.

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Sql } from 'postgres';
import { connectDirectDb, createTestUser, destroyTestUser, type TestUser } from './helpers';
import * as projects from '@/lib/db/projects';

const MIGRATION_FILE = path.resolve(
  __dirname,
  '../../supabase/migrations/20260817000000_budget_rules.sql'
);
const MIGRATE_SOURCE_ALLOWANCE = '과기부고시 제2026-38호 제26조①';
const MIGRATE_SOURCE_INDIRECT = '(Phase 9 입력값 이관)';

let sql: Sql;
let user: TestUser;
const tempProjectIds: string[] = []; // afterAll 안전망 — 실패해도 dev DB를 원복한다

// 마이그레이션 파일에서 마커 사이의 SQL만 잘라 낸다. 마커가 없으면 파일이 바뀐 것이므로 즉시 실패
function extractMigrateBlock(): string {
  const text = readFileSync(MIGRATION_FILE, 'utf8');
  const match = text.match(
    /-- MIGRATE-RATE-LIMITS:BEGIN\r?\n([\s\S]*?)-- MIGRATE-RATE-LIMITS:END/
  );
  if (!match?.[1]) {
    throw new Error('마이그레이션 파일에 MIGRATE-RATE-LIMITS 마커가 없습니다.');
  }
  return match[1];
}

// sql.begin 콜백에서 던지면 postgres.js가 ROLLBACK 후 같은 에러를 다시 던진다 —
// 그것으로 "검증만 하고 아무것도 남기지 않는" 트랜잭션을 만든다
class Rollback extends Error {}

interface RuleRow {
  code: string;
  enabled: boolean;
  value: string | null; // numeric은 postgres.js가 문자열로 준다
  base: string | null;
  severity: string;
  source: string;
  note: string;
  version: string;
}

async function readRules(projectId: string): Promise<RuleRow[]> {
  return sql<RuleRow[]>`
    select code, enabled, value::text as value, base, severity, source, note, version::text as version
      from public.budget_rules
     where project_id = ${projectId}::uuid
     order by code`;
}

async function newProject(name: string): Promise<string> {
  const project = await projects.createProjectWithDefaults(user.client, {
    name,
    contractStartDate: '2026-01-01',
  });
  tempProjectIds.push(project.id);
  return project.id;
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

// ─── (d) 스키마 상태 ─────────────────────────────────────────

describe('(d) 스키마 상태 — schema_version ≥ 3, 한도 컬럼 삭제, RLS', () => {
  // 이 마이그레이션은 3으로 올렸고 이후 Phase가 더 올린다(4 = Phase 16). 현재 값의 정확한 검증은
  // 최신 마이그레이션 테스트가 맡고, 여기서는 "이 마이그레이션이 적용됐다"는 하한만 본다
  it('app_settings.schema_version >= 3', async () => {
    const rows = await sql<{ v: number }[]>`select schema_version::int as v from public.app_settings`;
    expect(rows).toHaveLength(1);
    expect(rows[0]!.v).toBeGreaterThanOrEqual(3);
  });

  it('projects의 allowance_rate_limit·indirect_rate_limit 컬럼이 없다', async () => {
    const rows = await sql<{ column_name: string }[]>`
      select column_name from information_schema.columns
       where table_schema = 'public' and table_name = 'projects'
         and column_name in ('allowance_rate_limit', 'indirect_rate_limit')`;
    expect(rows).toEqual([]);
  });

  it('budget_rules에 RLS가 켜져 있고 승인 사용자 정책이 있다 (RLS-1)', async () => {
    const rls = await sql<{ enabled: boolean }[]>`
      select relrowsecurity as enabled from pg_class
       where oid = 'public.budget_rules'::regclass`;
    expect(rls[0]?.enabled).toBe(true);

    const policies = await sql<{ policyname: string; roles: string[] }[]>`
      select policyname, roles::text[] as roles from pg_policies
       where schemaname = 'public' and tablename = 'budget_rules'`;
    expect(policies).toHaveLength(1);
    expect(policies[0]!.policyname).toBe('approved users full access');
    expect(policies[0]!.roles).toEqual(['authenticated']);
  });

  it('budget_rules는 Realtime publication에 없다 (§8.5 구독표 밖)', async () => {
    const rows = await sql`
      select 1 from pg_publication_tables
       where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'budget_rules'`;
    expect(rows).toEqual([]);
  });
});

// ─── (a) 이관 ────────────────────────────────────────────────

describe('(a) 한도 컬럼 → budget_rules 행 이관 (§5.18 말미)', () => {
  it('둘 다 값 → 2행 / allowance만 → 1행 / 둘 다 null → 0행. base·source·severity가 명세 그대로', async () => {
    const block = extractMigrateBlock();
    let migrated: (RuleRow & { pname: string })[] = [];

    try {
      await sql.begin(async (tx) => {
        await tx`alter table public.projects
                   add column allowance_rate_limit numeric,
                   add column indirect_rate_limit numeric`;
        await tx`insert into public.projects (name, allowance_rate_limit, indirect_rate_limit) values
                   ('mig-both', 20, 25.5),
                   ('mig-allowance-only', 18, null),
                   ('mig-none', null, null)`;

        await tx.unsafe(block);

        migrated = await tx<(RuleRow & { pname: string })[]>`
          select p.name as pname, r.code, r.enabled, r.value::text as value, r.base,
                 r.severity, r.source, r.note, r.version::text as version
            from public.budget_rules r
            join public.projects p on p.id = r.project_id
           where p.name in ('mig-both', 'mig-allowance-only', 'mig-none')
           order by p.name, r.code`;

        throw new Rollback();
      });
    } catch (e) {
      if (!(e instanceof Rollback)) throw e;
    }

    expect(migrated.map((r) => [r.pname, r.code])).toEqual([
      ['mig-allowance-only', 'allowance_max'],
      ['mig-both', 'allowance_max'],
      ['mig-both', 'indirect_max'],
    ]);

    const [onlyAllowance, bothAllowance, bothIndirect] = migrated;
    expect(onlyAllowance).toMatchObject({
      enabled: true, value: '18', base: null, severity: 'error',
      source: MIGRATE_SOURCE_ALLOWANCE, note: '', version: '1',
    });
    expect(bothAllowance).toMatchObject({
      enabled: true, value: '20', base: null, severity: 'error',
      source: MIGRATE_SOURCE_ALLOWANCE,
    });
    expect(bothIndirect).toMatchObject({
      enabled: true, value: '25.5', base: 'direct_cash_excl_intl_consign_burden',
      severity: 'error', source: MIGRATE_SOURCE_INDIRECT, note: '',
    });

    // 롤백 확인 — 임시 과제·행·컬럼 모두 남아 있지 않다
    const leftover = await sql`select 1 from public.projects where name like 'mig-%'`;
    expect(leftover).toEqual([]);
  });
});

// ─── (b) check 제약 ──────────────────────────────────────────

describe('(b) check 제약 — RL-D1·D2·D3·D5가 DB에서 거부한다', () => {
  let projectId: string;

  beforeAll(async () => {
    projectId = await newProject('규칙 제약 검증');
  });

  function insert(row: {
    code: string;
    enabled?: boolean;
    value?: number | null;
    base?: string | null;
    severity?: string;
    source?: string;
  }) {
    return sql`
      insert into public.budget_rules (project_id, code, enabled, value, base, severity, source)
      values (${projectId}::uuid, ${row.code}, ${row.enabled ?? true},
              ${row.value ?? null}, ${row.base ?? null},
              ${row.severity ?? 'error'}, ${row.source ?? '공고 2026-01'})`;
  }

  it('값 없는 코드(no_burden)에 값이 오면 거부 (RL-D2)', async () => {
    await expect(insert({ code: 'no_burden', value: 0 })).rejects.toThrow(
      /budget_rules_value_range_check/
    );
  });

  it('빈 source·공백 source 거부 (RL-D5)', async () => {
    await expect(insert({ code: 'allowance_max', value: 20, source: '' })).rejects.toThrow(
      /budget_rules_source_check/
    );
    await expect(insert({ code: 'allowance_max', value: 20, source: '   ' })).rejects.toThrow(
      /budget_rules_source_check/
    );
  });

  it('indirect_max가 아닌 코드에 base가 있으면 거부 (RL-D3)', async () => {
    await expect(
      insert({ code: 'allowance_max', value: 20, base: 'direct_cash_excl_intl' })
    ).rejects.toThrow(/budget_rules_base_code_check/);
  });

  it('indirect_max에 base가 없으면 거부 (RL-D3 — 필수)', async () => {
    await expect(insert({ code: 'indirect_max', value: 25 })).rejects.toThrow(
      /budget_rules_base_code_check/
    );
  });

  it('enabled=true인데 값 필요 코드의 value가 null이면 거부 (RL-D2)', async () => {
    await expect(insert({ code: 'allowance_max', value: null })).rejects.toThrow(
      /budget_rules_enabled_value_check/
    );
    // 꺼진 규칙은 값이 없어도 된다 — "검사 안 함"과 같은 뜻
    await insert({ code: 'allowance_min', enabled: false, value: null });
  });

  it('비율 코드 value 101·음수 거부, 금액 코드 소수 거부 (RL-D2)', async () => {
    await expect(insert({ code: 'gov_share_max', value: 101 })).rejects.toThrow(
      /budget_rules_value_range_check/
    );
    await expect(insert({ code: 'gov_share_max', value: -1 })).rejects.toThrow(
      /budget_rules_value_range_check/
    );
    await expect(insert({ code: 'equipment_review_threshold', value: 30000000.5 })).rejects.toThrow(
      /budget_rules_value_range_check/
    );
    // 경계값은 통과한다
    await insert({ code: 'gov_share_max', value: 100 });
    await insert({ code: 'equipment_review_threshold', value: 0, severity: 'warn' });
  });

  it('code·severity·base enum 밖의 값 거부 (N-12)', async () => {
    await expect(insert({ code: 'not_a_rule', value: 1 })).rejects.toThrow(/budget_rules_code_check/);
    await expect(insert({ code: 'allowance_max', value: 20, severity: 'fatal' })).rejects.toThrow(
      /budget_rules_severity_check/
    );
    await expect(
      insert({ code: 'indirect_max', value: 25, base: 'direct_total' })
    ).rejects.toThrow(/budget_rules_base_check/);
  });

  it('같은 (project_id, code) 두 번 거부 (RL-D1)', async () => {
    await insert({ code: 'allowance_max', value: 20 });
    await expect(insert({ code: 'allowance_max', value: 15 })).rejects.toThrow(
      /budget_rules_project_code_key/
    );
  });

  it('갱신 시 set_updated_meta가 version을 올린다 (RL-D6)', async () => {
    const before = (await readRules(projectId)).find((r) => r.code === 'allowance_max');
    expect(before?.version).toBe('1');
    await sql`update public.budget_rules set value = 19
               where project_id = ${projectId}::uuid and code = 'allowance_max'`;
    const after = (await readRules(projectId)).find((r) => r.code === 'allowance_max');
    expect(after).toMatchObject({ value: '19', version: '2' });
  });
});

// ─── (c) apply_rule_preset ───────────────────────────────────

describe('(c) apply_rule_preset — fill / overwrite (§9, RL-D4)', () => {
  let projectId: string;

  // 부록 D의 값이 아니라 RPC 계약 검증용 임의 행이다 — 프리셋 상수는 T4(lib/rules-presets.ts)
  const PRESET = [
    { code: 'allowance_max', enabled: true, value: 20, base: null, severity: 'error',
      source: '과기부고시 제2026-38호 제26조①', note: '' },
    { code: 'indirect_max', enabled: true, value: 25, base: 'direct_cash_excl_intl_consign_burden',
      severity: 'error', source: '과기부고시 제2026-38호 제30조', note: '' },
    { code: 'no_burden', enabled: true, value: null, base: null, severity: 'error',
      source: '과기부고시 제2026-38호 제12조', note: '' },
  ];

  async function apply(mode: string, rows: unknown = PRESET, pid: string = projectId) {
    return user.client.rpc('apply_rule_preset', { p_project_id: pid, p_mode: mode, p_rows: rows });
  }

  beforeAll(async () => {
    projectId = await newProject('규칙 프리셋 적용');
    // 사용자가 미리 손본 행 1 + 프리셋에 없는 행 1
    await sql`
      insert into public.budget_rules (project_id, code, enabled, value, base, severity, source, note) values
        (${projectId}::uuid, 'allowance_max', true, 15, null, 'warn', '공고 2026-01', '공고에서 달리 정함'),
        (${projectId}::uuid, 'min_participation', true, 10, null, 'error', '공고 2026-01', '')`;
  });

  it('fill — 없는 code만 추가하고 있는 행은 그대로 (added 2 · updated 0 · kept 1)', async () => {
    const { data, error } = await apply('fill');
    expect(error).toBeNull();
    expect(data).toEqual({ added: 2, updated: 0, kept: 1 });

    const rows = await readRules(projectId);
    expect(rows.map((r) => r.code)).toEqual([
      'allowance_max', 'indirect_max', 'min_participation', 'no_burden',
    ]);
    expect(rows.find((r) => r.code === 'allowance_max')).toMatchObject({
      value: '15', severity: 'warn', source: '공고 2026-01', note: '공고에서 달리 정함', version: '1',
    });
    expect(rows.find((r) => r.code === 'indirect_max')).toMatchObject({
      value: '25', base: 'direct_cash_excl_intl_consign_burden', version: '1',
    });
    expect(rows.find((r) => r.code === 'no_burden')).toMatchObject({ value: null, version: '1' });
  });

  it('overwrite — 다른 행은 갱신(version +1), 같은 행은 유지, 프리셋에 없는 행은 보존', async () => {
    const { data, error } = await apply('overwrite');
    expect(error).toBeNull();
    expect(data).toEqual({ added: 0, updated: 1, kept: 2 });

    const rows = await readRules(projectId);
    expect(rows.find((r) => r.code === 'allowance_max')).toMatchObject({
      value: '20', severity: 'error', source: '과기부고시 제2026-38호 제26조①', note: '', version: '2',
    });
    expect(rows.find((r) => r.code === 'indirect_max')?.version).toBe('1');
    expect(rows.find((r) => r.code === 'no_burden')?.version).toBe('1');
    // 사용자가 직접 넣은 규칙은 건드리지 않는다 (kept에도 세지 않는다)
    expect(rows.find((r) => r.code === 'min_participation')).toMatchObject({
      value: '10', source: '공고 2026-01', version: '1',
    });
  });

  it('overwrite를 같은 값으로 다시 적용하면 전부 kept, version 불변', async () => {
    const { data, error } = await apply('overwrite');
    expect(error).toBeNull();
    expect(data).toEqual({ added: 0, updated: 0, kept: 3 });
    expect((await readRules(projectId)).map((r) => r.version)).toEqual(['2', '1', '1', '1']);
  });

  it('overwrite에서 note가 null인 행은 메모를 건드리지 않는다', async () => {
    await sql`update public.budget_rules set note = '메모 유지'
               where project_id = ${projectId}::uuid and code = 'no_burden'`;
    const { data, error } = await apply('overwrite', [{ ...PRESET[2], note: null }]);
    expect(error).toBeNull();
    expect(data).toEqual({ added: 0, updated: 0, kept: 1 });
    expect((await readRules(projectId)).find((r) => r.code === 'no_burden')?.note).toBe('메모 유지');
  });

  it('check 위반 행이 있으면 전체가 거부되고 아무것도 바뀌지 않는다 (단일 트랜잭션)', async () => {
    const before = await readRules(projectId);
    const { error } = await apply('overwrite', [
      { ...PRESET[0], value: 21 },       // 정상 갱신 대상
      { ...PRESET[1], value: 101 },      // RL-D2 위반
    ]);
    expect(error).not.toBeNull();
    expect(error!.message).toMatch(/budget_rules_value_range_check/);
    expect(await readRules(projectId)).toEqual(before);
  });

  it('잘못된 mode·중복 code·없는 과제는 거부', async () => {
    const badMode = await apply('merge');
    expect(badMode.error?.message).toMatch(/fill 또는 overwrite/);

    const dup = await apply('fill', [PRESET[0], PRESET[0]]);
    expect(dup.error?.message).toMatch(/중복된 code/);

    const missing = await apply('fill', PRESET, '00000000-0000-4000-8000-000000000000');
    expect(missing.error?.message).toMatch(/과제를 찾을 수 없습니다/);

    const notArray = await apply('fill', { code: 'no_burden' });
    expect(notArray.error?.message).toMatch(/배열이 아닙니다/);
  });
});
