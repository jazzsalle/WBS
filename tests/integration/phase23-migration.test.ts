// Phase 23 집행 관리 삭제 마이그레이션(20260930000000) 통합 테스트
// (SOT §5.12·§5.12.1, §8.7 K-9, §8.8, 계획서 docs/plans/phase-23-plan.md S-1·S-2·S-12)
//
// 검증의 핵심:
//  (a) DB에 집행 테이블을 참조하는 함수·뷰·트리거·정책·publication 항목이 0건이다.
//      drop table에 cascade를 쓰지 않았지만, plpgsql 본문의 참조는 의존으로 잡히지 않아
//      drop이 성공해도 남을 수 있다 — 그러면 그 함수는 호출 시점에야 깨진다. 카탈로그로 직접 본다.
//  (b) import_profiles.kind check가 ('budget_plan','budget_detail','goal_form')이다 (S-1).
//  (c) schema_version ≥ 5 (§8.8) — 정확한 값은 최신 마이그레이션 테스트(agreement-migration)가 본다.
//  (d) 연쇄 삭제 RPC(delete_year·delete_project)가 집행 테이블 없이 그대로 동작한다.
//  (e) restore_import_snapshot의 goals 거부(GF-11)·산출근거(D-17a) 경로가 남아 있다.
//
// 이 파일의 검색 문자열은 S-11 예외 목록 4번이다(DB 잔존 참조 검사).
// 카탈로그 조회는 직결 SQL(postgres role)로 한다 — 검증 대상이 스키마 자체다.
// (d)는 publishable 키 + 실제 세션(RLS 경로)으로 리포지토리를 거친다.
// 자기가 만든 과제·사용자만 지운다 — 파괴적 테스트가 아니다.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Sql } from 'postgres';
import { connectDirectDb, createTestUser, destroyTestUser, type TestUser } from './helpers';
import { EXPECTED_SCHEMA_VERSION } from '@/lib/constants';
import * as projects from '@/lib/db/projects';
import * as stages from '@/lib/db/stages';
import * as years from '@/lib/db/years';

const DROPPED_TABLE = 'budget_executions';
const DROPPED_RPC = 'commit_execution_form';
const DROPPED_KIND = 'execution_form';

let sql: Sql;
let user: TestUser;
const tempProjectIds: string[] = []; // afterAll 안전망 — 실패해도 dev DB를 원복한다

// sql.begin 콜백에서 던지면 postgres.js가 ROLLBACK 후 같은 에러를 다시 던진다 —
// 그것으로 "검증만 하고 아무것도 남기지 않는" 트랜잭션을 만든다
class Rollback extends Error {}

beforeAll(async () => {
  sql = connectDirectDb();
  user = await createTestUser(sql);
});

afterAll(async () => {
  for (const id of tempProjectIds) {
    await sql`delete from public.projects where id = ${id}::uuid`;
  }
  await destroyTestUser(sql, user);
  await sql.end();
});

// ─── (a) 잔존 참조 0건 ───────────────────────────────────────

describe('(a) 집행 테이블·RPC 잔존 참조 0건', () => {
  it('테이블 자체가 없다', async () => {
    const rows = await sql<{ r: string | null }[]>`
      select to_regclass(${`public.${DROPPED_TABLE}`})::text as r`;
    expect(rows[0]!.r).toBeNull();
  });

  it(`${DROPPED_RPC} 함수가 없다 (시그니처 무관)`, async () => {
    const rows = await sql`
      select p.oid from pg_proc p join pg_namespace n on n.oid = p.pronamespace
       where n.nspname = 'public' and p.proname = ${DROPPED_RPC}`;
    expect(rows).toEqual([]);
  });

  it('public 함수 본문(pg_proc.prosrc)에 집행 테이블 참조가 없다 — 주석 포함', async () => {
    const rows = await sql<{ proname: string }[]>`
      select p.proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace
       where n.nspname = 'public' and p.prosrc ilike ${`%${DROPPED_TABLE}%`}`;
    expect(rows.map((r) => r.proname)).toEqual([]);
  });

  it('public 함수 본문이 삭제된 RPC를 호출하지 않는다 — 주석 속 언급은 제외', async () => {
    // commit_goal_form(20260929000000)의 주석 두 줄이 삭제된 RPC를 "같은 판단"의 선례로 적어 두었다.
    // 호출이 아니라 설계 이력이고, 그 함수를 주석 때문에 재정의하는 것은 이 Phase 범위 밖이다
    const rows = await sql<{ proname: string; src: string }[]>`
      select p.proname, p.prosrc as src from pg_proc p join pg_namespace n on n.oid = p.pronamespace
       where n.nspname = 'public' and p.prosrc ilike ${`%${DROPPED_RPC}%`}`;
    const callers = rows
      .filter((r) => r.src.replace(/--[^\n]*/g, '').toLowerCase().includes(DROPPED_RPC))
      .map((r) => r.proname);
    expect(callers).toEqual([]);
  });

  it('뷰(pg_views) 정의에 참조가 없다', async () => {
    const rows = await sql`
      select schemaname, viewname from pg_views
       where definition ilike ${`%${DROPPED_TABLE}%`}`;
    expect(rows).toEqual([]);
  });

  it('정책(pg_policies)이 참조하지 않는다 — 대상 테이블로도, 식 안에서도', async () => {
    const rows = await sql`
      select schemaname, tablename, policyname from pg_policies
       where tablename = ${DROPPED_TABLE}
          or coalesce(qual, '') ilike ${`%${DROPPED_TABLE}%`}
          or coalesce(with_check, '') ilike ${`%${DROPPED_TABLE}%`}`;
    expect(rows).toEqual([]);
  });

  it('트리거(pg_trigger)가 호출하는 함수 중 참조하는 것이 없다', async () => {
    const rows = await sql`
      select t.tgname, t.tgrelid::regclass::text as rel
        from pg_trigger t join pg_proc p on p.oid = t.tgfoid
       where not t.tgisinternal
         and p.prosrc ilike ${`%${DROPPED_TABLE}%`}`;
    expect(rows).toEqual([]);
  });

  it('Realtime publication에서 빠졌다', async () => {
    const rows = await sql`
      select pubname from pg_publication_tables where tablename = ${DROPPED_TABLE}`;
    expect(rows).toEqual([]);
  });

  it('수행 양식 스냅샷·프로파일이 남아 있지 않다 (S-1·S-2)', async () => {
    const rows = await sql<{ snapshots: number; profiles: number }[]>`
      select
        (select count(*) from public.import_snapshots
          where snapshot ->> 'kind' = ${DROPPED_KIND})::int as snapshots,
        (select count(*) from public.import_profiles
          where kind = ${DROPPED_KIND})::int as profiles`;
    expect(rows[0]).toEqual({ snapshots: 0, profiles: 0 });
  });
});

// ─── (b) import_profiles.kind check ──────────────────────────

describe('(b) import_profiles.kind check (S-1)', () => {
  it('check 정의가 세 값뿐이다', async () => {
    const rows = await sql<{ def: string }[]>`
      select pg_get_constraintdef(oid) as def from pg_constraint
       where conrelid = 'public.import_profiles'::regclass
         and conname = 'import_profiles_kind_check'`;
    expect(rows).toHaveLength(1);
    const values = [...rows[0]!.def.matchAll(/'([a-z_]+)'::text/g)].map((m) => m[1]).sort();
    expect(values).toEqual(['budget_detail', 'budget_plan', 'goal_form']);
  });

  it('옛 수행 양식 kind 삽입은 check 위반(23514)으로 거부된다', async () => {
    await expect(
      sql`insert into public.import_profiles (name, kind) values ('phase23', ${DROPPED_KIND})`
    ).rejects.toMatchObject({ code: '23514' });
  });

  it.each(['budget_plan', 'budget_detail', 'goal_form'])('kind = %s는 들어간다 (롤백)', async (kind) => {
    await expect(
      sql.begin(async (tx) => {
        await tx`insert into public.import_profiles (name, kind) values ('phase23', ${kind})`;
        throw new Rollback();
      })
    ).rejects.toBeInstanceOf(Rollback);
  });
});

// ─── (c) schema_version ──────────────────────────────────────

describe('(c) schema_version ≥ 5 (§8.8)', () => {
  // 이 마이그레이션은 5로 올렸고 이후 Phase가 더 올린다(6 = Phase 24). 현재 값의 정확한 검증은
  // 최신 마이그레이션 테스트가 맡고, 여기서는 "이 마이그레이션이 적용됐다"는 하한만 본다
  it('app_settings.schema_version >= 5, EXPECTED_SCHEMA_VERSION >= 5', async () => {
    const rows = await sql<{ v: number }[]>`select schema_version::int as v from public.app_settings`;
    expect(rows).toHaveLength(1);
    expect(rows[0]!.v).toBeGreaterThanOrEqual(5);
    expect(EXPECTED_SCHEMA_VERSION).toBeGreaterThanOrEqual(5);
  });
});

// ─── (d) 연쇄 삭제 RPC ───────────────────────────────────────

describe('(d) delete_year·delete_project가 그대로 동작한다', () => {
  it('연차 삭제 → 그 연차의 budget_items·budget_details만 사라지고, 과제 삭제 → 전부 사라진다', async () => {
    const project = await projects.createProject(user.client, {
      name: 'Phase 23 연쇄 삭제 테스트',
      createdBy: user.id,
      updatedBy: user.id,
    });
    tempProjectIds.push(project.id);
    const stage = await stages.createStage(user.client, { projectId: project.id, name: '1단계' });
    const year1 = await years.createYear(user.client, { stageId: stage.id, name: '1차년도' });
    const year2 = await years.createYear(user.client, { stageId: stage.id, name: '2차년도' });

    // 산출근거 1행씩 — 연쇄 삭제가 budget_details까지 닿는지 본다
    for (const yearId of [year1.id, year2.id]) {
      await sql`
        insert into public.budget_details
          (project_id, year_id, category, subcategory, axis, formula,
           name, spec, unit_price, factors, adjustment, amount, note, sort_order,
           created_by, updated_by)
        values
          (${project.id}::uuid, ${yearId}::uuid, 'activity', 'activity_meeting', 'cash', 'quantity',
           '회의', '', 100000, ${sql.json([{ label: '회', value: 2, isPercent: false }])}::jsonb,
           0, 200000, '', 0, ${user.id}::uuid, ${user.id}::uuid)`;
    }

    const count = async () =>
      (
        await sql<{ items: number; details: number; years: number }[]>`
          select
            (select count(*) from public.budget_items   where project_id = ${project.id}::uuid)::int as items,
            (select count(*) from public.budget_details where project_id = ${project.id}::uuid)::int as details,
            (select count(*) from public.years y join public.stages s on s.id = y.stage_id
              where s.project_id = ${project.id}::uuid)::int as years`
      )[0]!;

    expect(await count()).toEqual({ items: 24, details: 2, years: 2 });

    await years.deleteYear(user.client, year1.id);
    expect(await count()).toEqual({ items: 12, details: 1, years: 1 });

    await projects.deleteProject(user.client, project.id);
    expect(await count()).toEqual({ items: 0, details: 0, years: 0 });
    const left = await sql`select id from public.projects where id = ${project.id}::uuid`;
    expect(left).toEqual([]);
  });
});

// ─── (e) restore_import_snapshot 잔존 경로 ───────────────────

describe('(e) restore_import_snapshot — 제안 모드 경로는 남아 있다', () => {
  it('goals 거부(GF-11)·산출근거 복원(D-17a)·items 복원 문이 본문에 있다', async () => {
    const rows = await sql<{ src: string }[]>`
      select p.prosrc as src from pg_proc p join pg_namespace n on n.oid = p.pronamespace
       where n.nspname = 'public' and p.proname = 'restore_import_snapshot'`;
    expect(rows).toHaveLength(1);
    const src = rows[0]!.src;
    expect(src).toContain("if v_snapshot ? 'goals' then");
    expect(src).toContain('목표 양식 스냅샷은 되돌릴 수 없습니다');
    expect(src).toContain('insert into budget_details');
    expect(src).toContain('perform sync_budget_item_from_details');
    expect(src).toContain('on conflict (year_id, category) do update');
  });
});
