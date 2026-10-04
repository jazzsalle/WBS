// Phase 25 연차별 정부지원 현금 마이그레이션(20261003000000) 통합 테스트
// (SOT §5.5, §5.25, §6.6 H-5a·H-7, §8.5, §8.7 K-9, §8.8, §9 Agreement Budget, §14.3 RLS-1,
//  계획서 docs/plans/phase-25-plan.md U-4·S-3·S-4·S-20)
//
// 검증의 핵심:
//  (a) 스키마 — years.gov_support_cash(bigint null, ≥ 0), agreement_gov_support RLS·정책·N-4·unique·FK·인덱스,
//      publication 불변, project_type 없음, schema_version 7
//  (b) 미승인 사용자 — 읽기·쓰기 0행
//  (c) 확정 잠금·과제 경계 — agreement_child_guard 재사용(확정 insert/update·version_id 변경·다른 과제 연차 거부)
//  (d) 연쇄 삭제 — 정부지원 행만 쓰는 연차도 delete_year·delete_stage 거부, delete_project 통과
//  (e) RPC 계약 — create p_gov_cash 저장·검증, 옛 5인자 시그니처 없음, clone 복사, security definer 0
//  (f) restore_backup — c_tables = RESTORE_TABLES(agreement_items 뒤), 가드 끄고 켜기
//
// 쓰기는 publishable 키 + 실제 세션(RLS 경로)으로 한다. 직결 SQL(postgres role)은 카탈로그 조회와 결과 확인 전용이다.
// 자기가 만든 과제·사용자만 지운다 — 파괴적 테스트가 아니다.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Sql } from 'postgres';
import { connectDirectDb, createTestUser, destroyTestUser, type TestUser } from './helpers';
import { EXPECTED_SCHEMA_VERSION } from '@/lib/constants';
import * as backup from '@/lib/db/backup';
import * as projects from '@/lib/db/projects';
import * as stages from '@/lib/db/stages';
import * as years from '@/lib/db/years';

const TABLE = 'agreement_gov_support';

let sql: Sql;
let user: TestUser;
let outsider: TestUser; // 미승인 사용자
const tempProjectIds: string[] = []; // afterAll 안전망 — 실패해도 dev DB를 원복한다

interface Fixture {
  projectId: string;
  stageId: string;
  year1Id: string;
  year2Id: string;
}

async function newFixture(name: string): Promise<Fixture> {
  const project = await projects.createProject(user.client, {
    name,
    createdBy: user.id,
    updatedBy: user.id,
  });
  tempProjectIds.push(project.id);
  const stage = await stages.createStage(user.client, { projectId: project.id, name: '1단계' });
  const year1 = await years.createYear(user.client, { stageId: stage.id, name: '1차년도' });
  const year2 = await years.createYear(user.client, { stageId: stage.id, name: '2차년도' });
  return { projectId: project.id, stageId: stage.id, year1Id: year1.id, year2Id: year2.id };
}

interface CreateResult {
  versionId: string;
  order: number;
  lines: number;
  participants: number;
  govSupport: number;
}

async function createVersionRaw(projectId: string, govCash?: unknown, name = '선정평가본') {
  const args: Record<string, unknown> = {
    p_project_id: projectId,
    p_kind: 'selection',
    p_name: name,
    p_lines: [],
    p_participants: [],
  };
  if (govCash !== undefined) args['p_gov_cash'] = govCash;
  return user.client.rpc('create_agreement_version', args);
}

async function createVersion(projectId: string, govCash?: unknown, name?: string): Promise<CreateResult> {
  const { data, error } = await createVersionRaw(projectId, govCash, name);
  if (error) throw new Error(error.message);
  return data as CreateResult;
}

async function confirm(versionId: string): Promise<void> {
  const { error } = await user.client
    .from('agreement_versions')
    .update({ status: 'confirmed', confirmed_at: new Date().toISOString() })
    .eq('id', versionId);
  if (error) throw new Error(error.message);
}

async function govRows(versionId: string) {
  return sql<{ id: string; year_id: string; gov_cash: string }[]>`
    select id, year_id, gov_cash::text as gov_cash from public.agreement_gov_support
     where version_id = ${versionId}::uuid order by gov_cash`;
}

beforeAll(async () => {
  sql = connectDirectDb();
  user = await createTestUser(sql);
  outsider = await createTestUser(sql);
  await sql`update public.app_users set active = false where id = ${outsider.id}::uuid`;
});

afterAll(async () => {
  if (tempProjectIds.length > 0) {
    // 버전을 먼저 지운다 — delete_project(H-7)와 같은 순서. 연차의 no action FK를 피한다
    await sql`delete from public.agreement_versions where project_id = any(${tempProjectIds}::uuid[])`;
    await sql`delete from public.projects where id = any(${tempProjectIds}::uuid[])`;
  }
  await destroyTestUser(sql, outsider);
  await destroyTestUser(sql, user);
  await sql.end();
});

// ─── (a) 스키마 ──────────────────────────────────────────────

describe('(a) 스키마 — 컬럼·테이블·제약·RLS·publication', () => {
  it('years.gov_support_cash는 bigint null이고 음수는 check가 거부한다 (§5.5)', async () => {
    const col = await sql<{ data_type: string; is_nullable: string; column_default: string | null }[]>`
      select data_type, is_nullable, column_default from information_schema.columns
       where table_schema = 'public' and table_name = 'years' and column_name = 'gov_support_cash'`;
    expect(col).toEqual([{ data_type: 'bigint', is_nullable: 'YES', column_default: null }]);

    const f = await newFixture('Phase 25 연차 정부지원 현금 check');
    const negative = await user.client.from('years').update({ gov_support_cash: -1 }).eq('id', f.year1Id);
    expect(negative.error?.code).toBe('23514');
    const zero = await user.client.from('years').update({ gov_support_cash: 0 }).eq('id', f.year1Id);
    expect(zero.error).toBeNull();
    const big = await user.client
      .from('years')
      .update({ gov_support_cash: 35000000 })
      .eq('id', f.year2Id);
    expect(big.error).toBeNull();
    const rows = await sql<{ id: string; cash: string | null }[]>`
      select id, gov_support_cash::text as cash from public.years
       where id in ${sql([f.year1Id, f.year2Id])} order by sort_order`;
    expect(rows.map((r) => r.cash)).toEqual(['0', '35000000']);
    const back = await user.client.from('years').update({ gov_support_cash: null }).eq('id', f.year1Id);
    expect(back.error).toBeNull();
  });

  it('과제 유형·기업 유형 컬럼은 없다 (Phase 25 결정 — ProjectType 폐기)', async () => {
    const rows = await sql<{ column_name: string }[]>`
      select column_name from information_schema.columns
       where table_schema = 'public' and table_name = 'projects'
         and (column_name like '%project_type%' or column_name like '%company_type%' or column_name like '%enterprise%')`;
    expect(rows).toEqual([]);
  });

  it('agreement_gov_support에 RLS가 켜져 있고 승인 사용자 정책 하나만 있다 (RLS-1)', async () => {
    const rls = await sql<{ enabled: boolean }[]>`
      select c.relrowsecurity as enabled
        from pg_class c join pg_namespace n on n.oid = c.relnamespace
       where n.nspname = 'public' and c.relname = ${TABLE}`;
    expect(rls[0]?.enabled).toBe(true);

    const policies = await sql<
      { policyname: string; roles: string[]; cmd: string; qual: string; with_check: string }[]
    >`
      select policyname, roles::text[] as roles, cmd, qual, with_check from pg_policies
       where schemaname = 'public' and tablename = ${TABLE}`;
    expect(policies).toHaveLength(1);
    expect(policies[0]).toMatchObject({
      policyname: 'approved users full access',
      roles: ['authenticated'],
      cmd: 'ALL',
      qual: 'is_approved()',
      with_check: 'is_approved()',
    });
  });

  it('컬럼 — gov_cash bigint not null, N-4 공통 컬럼, project_id 없음', async () => {
    const rows = await sql<{ column_name: string; data_type: string; is_nullable: string }[]>`
      select column_name, data_type, is_nullable from information_schema.columns
       where table_schema = 'public' and table_name = ${TABLE}`;
    const col = (c: string) => rows.find((r) => r.column_name === c);
    expect(col('gov_cash')).toMatchObject({ data_type: 'bigint', is_nullable: 'NO' });
    expect(col('version_id')).toMatchObject({ data_type: 'uuid', is_nullable: 'NO' });
    expect(col('year_id')).toMatchObject({ data_type: 'uuid', is_nullable: 'NO' });
    for (const c of ['id', 'created_at', 'updated_at', 'version', 'created_by', 'updated_by']) {
      expect(col(c), c).toBeDefined();
    }
    expect(col('project_id')).toBeUndefined();
    expect(rows.map((r) => r.column_name).sort()).toEqual(
      ['created_at', 'created_by', 'gov_cash', 'id', 'updated_at', 'updated_by', 'version', 'version_id', 'year_id'].sort()
    );
  });

  it('FK — version_id cascade, year_id no action. unique(version_id, year_id), year_id 인덱스', async () => {
    const fks = await sql<{ col: string; ref: string; deltype: string }[]>`
      select a.attname as col, c.confrelid::regclass::text as ref, c.confdeltype as deltype
        from pg_constraint c
        join pg_attribute a on a.attrelid = c.conrelid and a.attnum = c.conkey[1]
       where c.conrelid = 'public.agreement_gov_support'::regclass and c.contype = 'f'`;
    const fk = (col: string) => fks.find((r) => r.col === col);
    expect(fk('version_id')).toMatchObject({ ref: 'agreement_versions', deltype: 'c' });
    expect(fk('year_id')).toMatchObject({ ref: 'years', deltype: 'a' });

    const uniques = await sql<{ def: string }[]>`
      select pg_get_constraintdef(c.oid) as def from pg_constraint c
       where c.conrelid = 'public.agreement_gov_support'::regclass and c.contype = 'u'`;
    expect(uniques.map((r) => r.def)).toEqual(['UNIQUE (version_id, year_id)']);

    const indexes = await sql<{ def: string }[]>`
      select indexdef as def from pg_indexes where schemaname = 'public' and tablename = ${TABLE}`;
    expect(indexes.some((r) => /\(year_id\)$/.test(r.def))).toBe(true);
  });

  it('set_updated_meta·agreement_child_guard 트리거가 있다 (N-5, §9)', async () => {
    const rows = await sql<{ name: string; enabled: string }[]>`
      select t.tgname as name, t.tgenabled as enabled from pg_trigger t
       where not t.tgisinternal and t.tgrelid = 'public.agreement_gov_support'::regclass`;
    expect(rows.map((r) => [r.name, r.enabled]).sort()).toEqual([
      ['agreement_child_guard', 'O'],
      ['set_updated_meta', 'O'],
    ]);
  });

  it('Realtime publication은 바뀌지 않았다 — 새 테이블·years 추가 없음 (§8.5, S-18)', async () => {
    const rows = await sql<{ tablename: string }[]>`
      select tablename from pg_publication_tables
       where pubname = 'supabase_realtime' and schemaname = 'public'
         and tablename in ('agreement_gov_support', 'agreement_participants', 'agreement_items',
                           'agreement_versions', 'agreement_lines')`;
    expect(rows.map((r) => r.tablename).sort()).toEqual(['agreement_lines', 'agreement_versions']);
  });

  it('app_settings.schema_version = 7 (§8.8)', async () => {
    const rows = await sql<{ v: number }[]>`select schema_version::int as v from public.app_settings`;
    expect(rows).toEqual([{ v: 7 }]);
  });

  it('EXPECTED_SCHEMA_VERSION = 7 — 마이그레이션과 같은 커밋 (§8.8)', () => {
    expect(EXPECTED_SCHEMA_VERSION).toBe(7);
  });
});

// ─── (b) 미승인 사용자 ──────────────────────────────────────

describe('(b) 미승인 사용자는 읽기·쓰기 0행 (RLS-1)', () => {
  it('select는 빈 결과, insert는 RLS 위반', async () => {
    const f = await newFixture('Phase 25 미승인');
    const v = await createVersion(f.projectId, { [f.year1Id]: 1000 });

    const read = await outsider.client.from(TABLE).select('id').eq('version_id', v.versionId);
    expect(read.error).toBeNull();
    expect(read.data).toEqual([]);

    const write = await outsider.client
      .from(TABLE)
      .insert({ version_id: v.versionId, year_id: f.year2Id, gov_cash: 1 });
    // BEFORE 가드 트리거가 RLS의 with check보다 먼저 돈다 — 미승인 사용자에게는 버전 행도 RLS로
    // 안 보이므로 가드가 "찾을 수 없습니다"로 먼저 거부한다. 어느 쪽이든 쓰기 0행이 요점이다
    expect(write.error).not.toBeNull();
    expect(['42501', 'P0001']).toContain(write.error?.code);

    const update = await outsider.client.from(TABLE).update({ gov_cash: 5 }).eq('version_id', v.versionId);
    expect(update.error).toBeNull();
    expect((await govRows(v.versionId)).map((r) => r.gov_cash)).toEqual(['1000']);
  });
});

// ─── (c) 확정 잠금·과제 경계 ─────────────────────────────────

describe('(c) 확정 잠금·과제 경계 — agreement_child_guard 재사용 (S-4)', () => {
  it('작성 중 버전에는 insert·update되고, 두 번째 행은 23505, 음수는 23514', async () => {
    const f = await newFixture('Phase 25 작성 중 쓰기');
    const v = await createVersion(f.projectId);

    const ins = await user.client
      .from(TABLE)
      .insert({ version_id: v.versionId, year_id: f.year1Id, gov_cash: 30000000 })
      .select('id, version')
      .single();
    expect(ins.error).toBeNull();
    const dup = await user.client
      .from(TABLE)
      .insert({ version_id: v.versionId, year_id: f.year1Id, gov_cash: 1 });
    expect(dup.error?.code).toBe('23505');
    const neg = await user.client
      .from(TABLE)
      .insert({ version_id: v.versionId, year_id: f.year2Id, gov_cash: -1 });
    expect(neg.error?.code).toBe('23514');

    // 0은 입력값이다 — 갱신으로 남고 set_updated_meta가 version을 올린다
    const upd = await user.client
      .from(TABLE)
      .update({ gov_cash: 0 })
      .eq('id', ins.data!.id)
      .select('gov_cash, version')
      .single();
    expect(upd.error).toBeNull();
    expect(upd.data).toMatchObject({ gov_cash: 0, version: Number(ins.data!.version) + 1 });
  });

  it('확정 버전 아래 insert·update는 거부되고 데이터는 그대로다. 행 삭제는 트리거가 막지 않는다', async () => {
    const f = await newFixture('Phase 25 확정 잠금');
    const v = await createVersion(f.projectId, { [f.year1Id]: 35000000 });
    await confirm(v.versionId);
    const LOCKED = /확정된 협약 예산 버전의 내용은 고칠 수 없습니다/;

    const ins = await user.client
      .from(TABLE)
      .insert({ version_id: v.versionId, year_id: f.year2Id, gov_cash: 1 });
    expect(ins.error?.message).toMatch(LOCKED);
    const upd = await user.client.from(TABLE).update({ gov_cash: 1 }).eq('version_id', v.versionId);
    expect(upd.error?.message).toMatch(LOCKED);
    expect((await govRows(v.versionId)).map((r) => r.gov_cash)).toEqual(['35000000']);

    // DELETE는 Phase 24 하위 테이블과 같이 트리거가 막지 않는다 — 확정 버전 행 삭제 거부는 액션(RULE)의 몫
    const del = await user.client.from(TABLE).delete().eq('version_id', v.versionId);
    expect(del.error).toBeNull();
    expect(await govRows(v.versionId)).toEqual([]);
  });

  it('version_id 변경은 거부된다', async () => {
    const f = await newFixture('Phase 25 version_id 변경');
    const v1 = await createVersion(f.projectId, { [f.year1Id]: 100 });
    await confirm(v1.versionId);
    const v2 = await createVersion(f.projectId, {}, '조정회의본');
    // 작성 중 v2의 행을 확정 v1로 옮기려 해도, 반대로 해도 거부된다
    const ins = await user.client
      .from(TABLE)
      .insert({ version_id: v2.versionId, year_id: f.year1Id, gov_cash: 200 })
      .select('id')
      .single();
    expect(ins.error).toBeNull();
    const move = await user.client.from(TABLE).update({ version_id: v1.versionId }).eq('id', ins.data!.id);
    expect(move.error?.message).toMatch(/협약 예산 내용을 다른 버전으로 옮길 수 없습니다/);
    expect((await govRows(v2.versionId)).map((r) => r.gov_cash)).toEqual(['200']);
  });

  it('다른 과제의 연차는 직접 INSERT·UPDATE와 RPC 둘 다 거부된다 (N-13)', async () => {
    const a = await newFixture('Phase 25 경계 A');
    const b = await newFixture('Phase 25 경계 B');
    const v = await createVersion(a.projectId, { [a.year1Id]: 100 });
    const FOREIGN = /이 과제에 속하지 않은 연차입니다/;

    const ins = await user.client
      .from(TABLE)
      .insert({ version_id: v.versionId, year_id: b.year1Id, gov_cash: 1 });
    expect(ins.error?.message).toMatch(FOREIGN);
    const upd = await user.client.from(TABLE).update({ year_id: b.year1Id }).eq('version_id', v.versionId);
    expect(upd.error?.message).toMatch(FOREIGN);
    expect((await govRows(v.versionId)).map((r) => r.year_id)).toEqual([a.year1Id]);

    const rpc = await createVersionRaw(b.projectId, { [a.year1Id]: 1 });
    expect(rpc.error?.message).toMatch(FOREIGN);
    const left = await sql`select 1 from public.agreement_versions where project_id = ${b.projectId}::uuid`;
    expect(left).toEqual([]);
  });
});

// ─── (d) 연쇄 삭제 ───────────────────────────────────────────

describe('(d) 연쇄 삭제 — H-5a·H-7', () => {
  it('정부지원 현금 행만 쓰는 연차도 delete_year·delete_stage가 거부하고 데이터는 그대로다', async () => {
    const f = await newFixture('Phase 25 연차 삭제');
    // delete_stage는 마지막 단계 거부(H-6)가 먼저다 — 두 번째 단계에 연차를 만들어 그 단계를 지운다
    const stage2 = await stages.createStage(user.client, { projectId: f.projectId, name: '2단계' });
    const year3 = await years.createYear(user.client, { stageId: stage2.id, name: '3차년도' });
    const v = await createVersion(f.projectId, { [year3.id]: 1000 });
    await confirm(v.versionId);

    const MESSAGE = '협약 예산 버전 1개가 이 연차를 씁니다 — 해당 버전을 먼저 삭제하세요';
    await expect(years.deleteYear(user.client, year3.id)).rejects.toThrow(MESSAGE);
    await expect(stages.deleteStage(user.client, stage2.id)).rejects.toThrow(MESSAGE);
    const kept = await sql<{ years: number; stages: number }[]>`
      select (select count(*) from public.years where id = ${year3.id}::uuid)::int as years,
             (select count(*) from public.stages where id = ${stage2.id}::uuid)::int as stages`;
    expect(kept[0]).toEqual({ years: 1, stages: 1 });
    expect((await govRows(v.versionId)).map((r) => r.gov_cash)).toEqual(['1000']);

    // 버전을 쓰지 않는 연차는 그대로 지워진다 (기존 H-5 동작)
    await years.deleteYear(user.client, f.year2Id);

    // 버전을 지우면(cascade) 연차·단계를 지울 수 있다
    const del = await user.client.from('agreement_versions').delete().eq('id', v.versionId);
    expect(del.error).toBeNull();
    await stages.deleteStage(user.client, stage2.id);
    expect(await sql`select 1 from public.years where id = ${year3.id}::uuid`).toEqual([]);
  });

  it('여러 버전이 정부지원 현금으로 쓰면 버전 수를 센다', async () => {
    const f = await newFixture('Phase 25 연차 삭제 2버전');
    const v1 = await createVersion(f.projectId, { [f.year2Id]: 1 });
    await confirm(v1.versionId);
    const v2 = await user.client.rpc('clone_agreement_version', {
      p_source_id: v1.versionId,
      p_kind: 'adjustment',
      p_name: '조정회의본',
    });
    expect(v2.error).toBeNull();
    await expect(years.deleteYear(user.client, f.year2Id)).rejects.toThrow(
      '협약 예산 버전 2개가 이 연차를 씁니다'
    );
  });

  it('delete_project는 재정의 없이 통과하고 정부지원 현금 행을 남기지 않는다', async () => {
    const f = await newFixture('Phase 25 과제 삭제');
    await sql`update public.years set gov_support_cash = 10 where id = ${f.year1Id}::uuid`;
    const v = await createVersion(f.projectId, { [f.year1Id]: 100, [f.year2Id]: 200 });
    await confirm(v.versionId);

    await projects.deleteProject(user.client, f.projectId);

    const left = await sql<{ n: number }[]>`
      select (
        (select count(*) from public.agreement_gov_support where version_id = ${v.versionId}::uuid) +
        (select count(*) from public.agreement_versions where id = ${v.versionId}::uuid) +
        (select count(*) from public.years where project_id = ${f.projectId}::uuid) +
        (select count(*) from public.projects where id = ${f.projectId}::uuid)
      )::int as n`;
    expect(left[0]!.n).toBe(0);
  });
});

// ─── (e) RPC 계약 ────────────────────────────────────────────

describe('(e) RPC — create_agreement_version p_gov_cash·clone·security invoker', () => {
  it('p_gov_cash { 연차 id: 원 }을 행으로 저장하고 govSupport 수를 돌려준다. 키 없는 연차는 행 없음', async () => {
    const f = await newFixture('Phase 25 create p_gov_cash');
    const v = await createVersion(f.projectId, { [f.year1Id]: 35000000 });
    expect(v).toMatchObject({ order: 1, lines: 0, participants: 0, govSupport: 1 });
    const rows = await govRows(v.versionId);
    expect(rows.map((r) => [r.year_id, r.gov_cash])).toEqual([[f.year1Id, '35000000']]);
    // 감사 컬럼은 호출자
    const audit = await sql<{ created_by: string; updated_by: string }[]>`
      select created_by, updated_by from public.agreement_gov_support where version_id = ${v.versionId}::uuid`;
    expect(audit).toEqual([{ created_by: user.id, updated_by: user.id }]);
  });

  it('0은 입력값으로 저장되고, p_gov_cash 생략·빈 객체·null은 0행이다', async () => {
    const f = await newFixture('Phase 25 create 0·생략');
    const zero = await createVersion(f.projectId, { [f.year1Id]: 0, [f.year2Id]: 9007199254740991 });
    expect(zero.govSupport).toBe(2);
    expect((await govRows(zero.versionId)).map((r) => r.gov_cash)).toEqual(['0', '9007199254740991']);
    await user.client.from('agreement_versions').delete().eq('id', zero.versionId);

    for (const govCash of [undefined, {}, null]) {
      const v = await createVersion(f.projectId, govCash);
      expect(v.govSupport, String(govCash)).toBe(0);
      expect(await govRows(v.versionId)).toEqual([]);
      await user.client.from('agreement_versions').delete().eq('id', v.versionId);
    }
  });

  it('객체가 아니거나 값이 0 이상 정수가 아니면 사람이 읽는 메시지로 거부하고 버전을 만들지 않는다', async () => {
    const f = await newFixture('Phase 25 create 검증');
    const cases: [unknown, RegExp][] = [
      [[], /정부지원 현금이 "연차 → 금액" 객체가 아닙니다/],
      [[{ [f.year1Id]: 1 }], /객체가 아닙니다/],
      [42, /객체가 아닙니다/],
      ['{}', /객체가 아닙니다/],
      [{ [f.year1Id]: -1 }, /정부지원 현금은 0 이상의 원 단위 정수여야 합니다/],
      [{ [f.year1Id]: 1.5 }, /0 이상의 원 단위 정수/],
      [{ [f.year1Id]: '1000' }, /0 이상의 원 단위 정수/],
      [{ [f.year1Id]: null }, /0 이상의 원 단위 정수/],
      [{ [f.year1Id]: true }, /0 이상의 원 단위 정수/],
      [{ 'not-a-uuid': 1 }, /이 과제에 속하지 않은 연차입니다/],
    ];
    for (const [govCash, message] of cases) {
      const { error } = await createVersionRaw(f.projectId, govCash);
      expect(error?.message, JSON.stringify(govCash)).toMatch(message);
      expect(error?.code, JSON.stringify(govCash)).toBe('P0001');
    }
    const left = await sql`select 1 from public.agreement_versions where project_id = ${f.projectId}::uuid`;
    expect(left).toEqual([]);
  });

  it('옛 5인자 시그니처는 pg_proc에 없다 — 오버로드 0', async () => {
    const rows = await sql<{ args: string }[]>`
      select pg_get_function_identity_arguments(p.oid) as args
        from pg_proc p join pg_namespace n on n.oid = p.pronamespace
       where n.nspname = 'public' and p.proname = 'create_agreement_version'`;
    // Phase 26(20261005000000)이 p_items를 더해 7인자가 됐다 — 오버로드가 하나뿐인 것은 그대로다
    expect(rows).toEqual([
      {
        args:
          'p_project_id uuid, p_kind text, p_name text, p_lines jsonb, p_participants jsonb, ' +
          'p_gov_cash jsonb, p_items jsonb',
      },
    ]);
  });

  it('clone_agreement_version이 정부지원 현금 행을 새 id로 복사하고 원본은 그대로다', async () => {
    const f = await newFixture('Phase 25 clone');
    const v1 = await createVersion(f.projectId, { [f.year1Id]: 35000000, [f.year2Id]: 0 });
    await confirm(v1.versionId);
    const before = await sql`
      select id, year_id, gov_cash::text as gov_cash, version::text as version, updated_at
        from public.agreement_gov_support where version_id = ${v1.versionId}::uuid order by gov_cash`;

    const { data, error } = await user.client.rpc('clone_agreement_version', {
      p_source_id: v1.versionId,
      p_kind: 'amendment',
      p_name: '협약변경 1차',
    });
    expect(error).toBeNull();
    expect(data).toMatchObject({ order: 2, lines: 0, participants: 0, items: 0, govSupport: 2 });
    const newId = (data as { versionId: string }).versionId;

    const src = await govRows(v1.versionId);
    const dst = await govRows(newId);
    const strip = (rows: readonly { id: string; year_id: string; gov_cash: string }[]) =>
      rows.map(({ id: _id, ...rest }) => rest);
    expect(strip(dst)).toEqual(strip(src));
    const srcIds = new Set(src.map((r) => r.id));
    expect(dst.every((r) => !srcIds.has(r.id))).toBe(true);

    const after = await sql`
      select id, year_id, gov_cash::text as gov_cash, version::text as version, updated_at
        from public.agreement_gov_support where version_id = ${v1.versionId}::uuid order by gov_cash`;
    expect(after).toEqual(before);
  });

  it('새·재정의 함수 중 security definer가 없다 (X-2)', async () => {
    const names = ['create_agreement_version', 'clone_agreement_version', 'delete_year', 'agreement_child_guard'];
    const rows = await sql<{ proname: string; prosecdef: boolean }[]>`
      select p.proname, p.prosecdef from pg_proc p join pg_namespace n on n.oid = p.pronamespace
       where n.nspname = 'public' and p.proname in ${sql(names)}`;
    expect(rows.map((r) => r.proname).sort()).toEqual([...names].sort());
    expect(rows.filter((r) => r.prosecdef).map((r) => r.proname)).toEqual([]);
  });
});

// ─── (f) restore_backup ──────────────────────────────────────

describe('(f) restore_backup — c_tables·가드 on/off (K-9)', () => {
  it('c_tables가 RESTORE_TABLES와 순서까지 같고 agreement_gov_support는 agreement_items 바로 뒤다', async () => {
    const rows = await sql<{ src: string; prosecdef: boolean }[]>`
      select p.prosrc as src, p.prosecdef from pg_proc p join pg_namespace n on n.oid = p.pronamespace
       where n.nspname = 'public' and p.proname = 'restore_backup'`;
    expect(rows).toHaveLength(1);
    const src = rows[0]!.src;
    const arrayBody = src.match(/c_tables constant text\[\] := array\[([\s\S]*?)\];/)?.[1];
    expect(arrayBody).toBeDefined();
    const cTables = [...arrayBody!.matchAll(/'([a-z_]+)'/g)].map((m) => m[1]);
    expect(cTables).toEqual([...backup.RESTORE_TABLES]);
    expect(cTables.indexOf(TABLE)).toBe(cTables.indexOf('agreement_items') + 1);
    expect(backup.BACKUP_TABLES).toContain(TABLE);

    // 끄기는 삽입 루프 앞, 켜기는 그 뒤
    const insertLoop = src.indexOf('foreach t in array c_tables loop');
    expect(insertLoop).toBeGreaterThan(-1);
    const off = src.search(/alter table public\.agreement_gov_support\s+disable trigger agreement_child_guard/);
    const on = src.search(/alter table public\.agreement_gov_support\s+enable trigger agreement_child_guard/);
    expect(off).toBeGreaterThan(-1);
    expect(off).toBeLessThan(insertLoop);
    expect(on).toBeGreaterThan(insertLoop);
  });
});
