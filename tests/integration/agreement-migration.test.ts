// Phase 24 협약 예산 마이그레이션(20261001000000) 통합 테스트
// (SOT §5.21~§5.24, §6.6 H-5a·H-7·H-9b, §8.3 X-2, §8.5 R-7, §8.7 K-9, §8.8, §9 Agreement Budget, §14.3 RLS-1,
//  계획서 docs/plans/phase-24-plan.md S-3·S-4·S-7·S-8·S-9·S-13·S-14·S-15·S-18)
//
// 검증의 핵심:
//  (a) 스키마 — 4종 RLS·정책, 금액 bigint, 삭제한 메타 컬럼 없음, publication 2종, schema_version 6
//  (b) 작성 중 1개 — 부분 유일 인덱스(직접 INSERT)·RPC 선검사(사람이 읽는 메시지)
//  (c) 확정 잠금 — 하위 3종 INSERT/UPDATE 거부, 확정 버전 삭제는 cascade로 통과
//  (d) 과제 경계 — RPC와 직접 INSERT 둘 다 다른 과제 연차·인력을 거부
//  (e) 버전 트리거 — project_id·sort_order 변경 거부, 확정 취소는 마지막 버전만
//  (f) 연쇄 삭제 — delete_project 잔여 0, delete_year·delete_stage·delete_member 거부 + 데이터 불변
//  (g) RPC 계약 — 복제(새 id·원본 불변), 전체 삭제(다른 과제 불변), security definer 0
//  (h) restore_backup — c_tables = RESTORE_TABLES, 가드 끄고 켜기
//
// 쓰기는 publishable 키 + 실제 세션(RLS 경로)으로 한다 — 가드 트리거·RLS가 앱과 같은 조건에서 돈다.
// 직결 SQL(postgres role)은 카탈로그 조회와 결과 확인 전용이다.
// 자기가 만든 과제·사용자만 지운다 — 파괴적 테스트가 아니다.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Sql } from 'postgres';
import { connectDirectDb, createTestUser, destroyTestUser, type TestUser } from './helpers';
import { EXPECTED_SCHEMA_VERSION } from '@/lib/constants';
import * as backup from '@/lib/db/backup';
import * as members from '@/lib/db/members';
import * as projects from '@/lib/db/projects';
import * as stages from '@/lib/db/stages';
import * as years from '@/lib/db/years';

const TABLES = [
  'agreement_versions',
  'agreement_lines',
  'agreement_participants',
  'agreement_items',
] as const;
const CHILD_TABLES = ['agreement_lines', 'agreement_participants', 'agreement_items'] as const;

let sql: Sql;
let user: TestUser;
const tempProjectIds: string[] = []; // afterAll 안전망 — 실패해도 dev DB를 원복한다

interface Fixture {
  projectId: string;
  stageId: string;
  year1Id: string;
  year2Id: string;
  memberId: string;
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
  // 인력 리포지토리 입력 검증은 이 파일의 관심이 아니다 — 직결 SQL로 최소 행만 만든다
  const member = await sql<{ id: string }[]>`
    insert into public.members (project_id, name, role, active, created_by, updated_by)
    values (${project.id}::uuid, '협약 참여자', 'researcher', true, ${user.id}::uuid, ${user.id}::uuid)
    returning id`;
  return {
    projectId: project.id,
    stageId: stage.id,
    year1Id: year1.id,
    year2Id: year2.id,
    memberId: member[0]!.id,
  };
}

interface CreateResult {
  versionId: string;
  order: number;
  lines: number;
  participants: number;
}

async function createVersion(
  projectId: string,
  kind: string,
  name: string,
  lines: Record<string, unknown>[] = [],
  participants: Record<string, unknown>[] = []
): Promise<CreateResult> {
  const { data, error } = await user.client.rpc('create_agreement_version', {
    p_project_id: projectId,
    p_kind: kind,
    p_name: name,
    p_lines: lines,
    p_participants: participants,
  });
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

function line(yearId: string, amount: number, sub = 'material_purchase', axis = 'cash') {
  return { year_id: yearId, category: 'material', subcategory_code: sub, axis, amount };
}

function participant(yearId: string, memberId: string | null, cash: number) {
  return {
    member_id: memberId,
    year_id: yearId,
    participation_rate: 50,
    months: 12,
    annual_salary: 60000000,
    personnel_cash: cash,
    personnel_in_kind: 0,
    role: '',
  };
}

async function insertItem(versionId: string, yearId: string) {
  return user.client.from('agreement_items').insert({
    version_id: versionId,
    year_id: yearId,
    kind: 'equipment',
    name: '분석 장비',
    amount: 33000000,
    quantity: 1,
    evidence: [{ label: '견적서', obtained: true, memo: '' }],
  });
}

async function countRows(projectId: string) {
  const rows = await sql<
    { versions: number; lines: number; participants: number; items: number }[]
  >`
    select
      (select count(*) from public.agreement_versions where project_id = ${projectId}::uuid)::int as versions,
      (select count(*) from public.agreement_lines l join public.agreement_versions v on v.id = l.version_id
        where v.project_id = ${projectId}::uuid)::int as lines,
      (select count(*) from public.agreement_participants p join public.agreement_versions v on v.id = p.version_id
        where v.project_id = ${projectId}::uuid)::int as participants,
      (select count(*) from public.agreement_items i join public.agreement_versions v on v.id = i.version_id
        where v.project_id = ${projectId}::uuid)::int as items`;
  return rows[0]!;
}

beforeAll(async () => {
  sql = connectDirectDb();
  user = await createTestUser(sql);
});

afterAll(async () => {
  if (tempProjectIds.length > 0) {
    // 버전을 먼저 지운다 — delete_project(H-7)와 같은 순서. 연차·인력의 no action FK를 피한다
    await sql`delete from public.agreement_versions where project_id = any(${tempProjectIds}::uuid[])`;
    await sql`delete from public.projects where id = any(${tempProjectIds}::uuid[])`;
  }
  await destroyTestUser(sql, user);
  await sql.end();
});

// ─── (a) 스키마 ──────────────────────────────────────────────

describe('(a) 스키마 — RLS·타입·publication·schema_version', () => {
  it.each(TABLES)('%s에 RLS가 켜져 있고 승인 사용자 정책 하나만 있다 (RLS-1)', async (table) => {
    const rls = await sql<{ enabled: boolean }[]>`
      select c.relrowsecurity as enabled
        from pg_class c join pg_namespace n on n.oid = c.relnamespace
       where n.nspname = 'public' and c.relname = ${table}`;
    expect(rls[0]?.enabled).toBe(true);

    const policies = await sql<
      { policyname: string; roles: string[]; cmd: string; qual: string; with_check: string }[]
    >`
      select policyname, roles::text[] as roles, cmd, qual, with_check from pg_policies
       where schemaname = 'public' and tablename = ${table}`;
    expect(policies).toHaveLength(1);
    expect(policies[0]).toMatchObject({
      policyname: 'approved users full access',
      roles: ['authenticated'],
      cmd: 'ALL',
      qual: 'is_approved()',
      with_check: 'is_approved()',
    });
  });

  it('금액 컬럼은 bigint, 비율·개월·수량은 numeric, 증빙은 jsonb (절대 규칙 4)', async () => {
    const rows = await sql<{ table_name: string; column_name: string; data_type: string; is_nullable: string }[]>`
      select table_name, column_name, data_type, is_nullable from information_schema.columns
       where table_schema = 'public' and table_name in ${sql(TABLES)}`;
    const col = (t: string, c: string) => rows.find((r) => r.table_name === t && r.column_name === c);

    for (const [t, c] of [
      ['agreement_lines', 'amount'],
      ['agreement_participants', 'personnel_cash'],
      ['agreement_participants', 'personnel_in_kind'],
      ['agreement_participants', 'annual_salary'],
      ['agreement_items', 'amount'],
    ] as const) {
      expect(col(t, c)?.data_type, `${t}.${c}`).toBe('bigint');
    }
    for (const [t, c] of [
      ['agreement_participants', 'participation_rate'],
      ['agreement_participants', 'months'],
      ['agreement_items', 'quantity'],
    ] as const) {
      expect(col(t, c)?.data_type, `${t}.${c}`).toBe('numeric');
    }
    expect(col('agreement_items', 'evidence')).toMatchObject({ data_type: 'jsonb', is_nullable: 'NO' });
    expect(col('agreement_participants', 'annual_salary')?.is_nullable).toBe('YES');
    expect(col('agreement_participants', 'member_id')?.is_nullable).toBe('YES');
    expect(col('agreement_versions', 'confirmed_at')).toMatchObject({
      data_type: 'timestamp with time zone',
      is_nullable: 'YES',
    });
    expect(col('agreement_versions', 'sort_order')).toMatchObject({ data_type: 'integer', is_nullable: 'NO' });

    // U-2: 공문 번호·IRIS 승인일은 두지 않는다
    expect(col('agreement_versions', 'official_doc_no')).toBeUndefined();
    expect(col('agreement_versions', 'iris_approved_at')).toBeUndefined();
    // 하위 3종은 project_id를 갖지 않는다 — 과제는 버전으로만 정해진다
    for (const t of CHILD_TABLES) expect(col(t, 'project_id'), t).toBeUndefined();
    // BaseEntity 공통 컬럼 (N-4)
    for (const t of TABLES) {
      for (const c of ['id', 'created_at', 'updated_at', 'version', 'created_by', 'updated_by']) {
        expect(col(t, c), `${t}.${c}`).toBeDefined();
      }
    }
  });

  it('4종 모두 set_updated_meta 트리거가 있다 (N-5)', async () => {
    const rows = await sql<{ rel: string }[]>`
      select t.tgrelid::regclass::text as rel from pg_trigger t
       where not t.tgisinternal and t.tgname = 'set_updated_meta'
         and t.tgrelid::regclass::text in ${sql(TABLES.map((t) => `${t}`))}`;
    expect(rows.map((r) => r.rel).sort()).toEqual([...TABLES].sort());
  });

  it('Realtime publication에는 버전·금액 줄만 있다 (R-7, §8.5)', async () => {
    const rows = await sql<{ tablename: string }[]>`
      select tablename from pg_publication_tables
       where pubname = 'supabase_realtime' and schemaname = 'public' and tablename in ${sql(TABLES)}`;
    expect(rows.map((r) => r.tablename).sort()).toEqual(['agreement_lines', 'agreement_versions']);
  });

  it('새 함수·재정의 함수 중 security definer가 없다 (X-2)', async () => {
    const names = [
      'create_agreement_version', 'clone_agreement_version', 'delete_agreement_versions',
      'agreement_child_guard', 'agreement_version_guard',
      'delete_year', 'delete_stage', 'delete_project', 'count_member_references', 'delete_member',
    ];
    const rows = await sql<{ proname: string; prosecdef: boolean }[]>`
      select p.proname, p.prosecdef from pg_proc p join pg_namespace n on n.oid = p.pronamespace
       where n.nspname = 'public' and p.proname in ${sql(names)}`;
    expect(rows.map((r) => r.proname).sort()).toEqual([...names].sort());
    expect(rows.filter((r) => r.prosecdef).map((r) => r.proname)).toEqual([]);
  });

  it('schema_version = 6 = EXPECTED_SCHEMA_VERSION (§8.8)', async () => {
    const rows = await sql<{ v: number }[]>`select schema_version::int as v from public.app_settings`;
    expect(rows).toHaveLength(1);
    expect(rows[0]!.v).toBe(6);
    expect(EXPECTED_SCHEMA_VERSION).toBe(6);
  });
});

// ─── (b) 작성 중 1개 ─────────────────────────────────────────

describe('(b) 작성 중 버전은 과제당 하나 (AV-2)', () => {
  it('직접 INSERT로 두 번째 작성 중 버전은 부분 유일 인덱스(23505)가 거부한다', async () => {
    const f = await newFixture('Phase 24 작성 중 1개');
    const first = await user.client
      .from('agreement_versions')
      .insert({ project_id: f.projectId, kind: 'selection', name: '선정평가본', sort_order: 1 });
    expect(first.error).toBeNull();
    const second = await user.client
      .from('agreement_versions')
      .insert({ project_id: f.projectId, kind: 'adjustment', name: '조정회의본', sort_order: 2 });
    expect(second.error?.code).toBe('23505');
    expect((await countRows(f.projectId)).versions).toBe(1);
  });

  it('create_agreement_version·clone_agreement_version은 먼저 검사해 사람이 읽는 메시지로 거부한다', async () => {
    const f = await newFixture('Phase 24 작성 중 RPC');
    const v1 = await createVersion(f.projectId, 'selection', '선정평가본', [line(f.year1Id, 100)]);
    expect(v1).toMatchObject({ order: 1, lines: 1, participants: 0 });

    await expect(createVersion(f.projectId, 'adjustment', '조정회의본')).rejects.toThrow(
      /작성 중 버전 "선정평가본"이 있습니다/
    );
    const clone = await user.client.rpc('clone_agreement_version', {
      p_source_id: v1.versionId,
      p_kind: 'adjustment',
      p_name: '조정회의본',
    });
    expect(clone.error?.message).toMatch(/작성 중 버전 "선정평가본"이 있습니다/);
    expect(await countRows(f.projectId)).toEqual({ versions: 1, lines: 1, participants: 0, items: 0 });
  });

  it('confirmed_at과 status가 어긋나면 check가 거부한다', async () => {
    const f = await newFixture('Phase 24 confirmed_at');
    const { error } = await user.client.from('agreement_versions').insert({
      project_id: f.projectId,
      kind: 'final',
      name: '최종협약본',
      sort_order: 1,
      status: 'confirmed',
    });
    expect(error?.code).toBe('23514');
  });
});

// ─── (c) 확정 잠금 ───────────────────────────────────────────

describe('(c) 확정 잠금 DB 강제 (§9 agreement_child_guard)', () => {
  it('확정 버전 아래 INSERT·UPDATE는 거부되고 데이터는 그대로다. 버전 삭제는 cascade로 통과한다', async () => {
    const f = await newFixture('Phase 24 확정 잠금');
    const v = await createVersion(
      f.projectId,
      'final',
      '최종협약본',
      [line(f.year1Id, 5000000)],
      [participant(f.year1Id, f.memberId, 30000000)]
    );
    expect((await insertItem(v.versionId, f.year1Id)).error).toBeNull();

    // 작성 중일 때는 UPDATE가 된다 (가드가 정상 경로를 막지 않는다)
    const draftUpdate = await user.client
      .from('agreement_lines')
      .update({ amount: 5500000 })
      .eq('version_id', v.versionId);
    expect(draftUpdate.error).toBeNull();

    await confirm(v.versionId);
    const before = await countRows(f.projectId);
    expect(before).toEqual({ versions: 1, lines: 1, participants: 1, items: 1 });

    const LOCKED = /확정된 협약 예산 버전의 내용은 고칠 수 없습니다/;
    const insLine = await user.client
      .from('agreement_lines')
      .insert({ ...line(f.year2Id, 1), version_id: v.versionId });
    expect(insLine.error?.message).toMatch(LOCKED);
    const insPart = await user.client
      .from('agreement_participants')
      .insert({ ...participant(f.year2Id, null, 1), version_id: v.versionId });
    expect(insPart.error?.message).toMatch(LOCKED);
    expect((await insertItem(v.versionId, f.year2Id)).error?.message).toMatch(LOCKED);

    for (const table of CHILD_TABLES) {
      const patch =
        table === 'agreement_participants' ? { personnel_cash: 1 } : { amount: 1 };
      const upd = await user.client.from(table).update(patch).eq('version_id', v.versionId);
      expect(upd.error?.message, table).toMatch(LOCKED);
    }
    const amounts = await sql<{ line: string; part: string; item: string }[]>`
      select (select amount::text from public.agreement_lines where version_id = ${v.versionId}::uuid) as line,
             (select personnel_cash::text from public.agreement_participants where version_id = ${v.versionId}::uuid) as part,
             (select amount::text from public.agreement_items where version_id = ${v.versionId}::uuid) as item`;
    expect(amounts[0]).toEqual({ line: '5500000', part: '30000000', item: '33000000' });
    expect(await countRows(f.projectId)).toEqual(before);

    // 메타는 확정 후에도 고칠 수 있다 (AV-2) — 버전 행 자체는 가드 대상이 아니다
    const meta = await user.client
      .from('agreement_versions')
      .update({ kind: 'amendment', name: '이름 변경', note: '비고' })
      .eq('id', v.versionId);
    expect(meta.error).toBeNull();

    // AV-4: 확정 버전 삭제 — DELETE는 가드하지 않아 하위 3종이 cascade로 지워진다
    const del = await user.client.from('agreement_versions').delete().eq('id', v.versionId);
    expect(del.error).toBeNull();
    expect(await countRows(f.projectId)).toEqual({ versions: 0, lines: 0, participants: 0, items: 0 });
  });

  it('하위 행의 version_id 변경은 거부된다', async () => {
    const f = await newFixture('Phase 24 version_id 변경');
    const v1 = await createVersion(f.projectId, 'selection', '선정평가본', [line(f.year1Id, 100)]);
    await confirm(v1.versionId);
    const v2 = await createVersion(f.projectId, 'adjustment', '조정회의본', [line(f.year1Id, 200)]);
    const { error } = await user.client
      .from('agreement_lines')
      .update({ version_id: v1.versionId })
      .eq('version_id', v2.versionId);
    expect(error?.message).toMatch(/다른 버전으로 옮길 수 없습니다/);
  });
});

// ─── (d) 과제 경계 ───────────────────────────────────────────

describe('(d) 과제 경계 — RPC와 직접 INSERT (N-13)', () => {
  it('다른 과제의 연차·인력은 RPC가 거부하고 아무것도 만들지 않는다', async () => {
    const a = await newFixture('Phase 24 경계 A');
    const b = await newFixture('Phase 24 경계 B');

    await expect(
      createVersion(a.projectId, 'selection', '선정평가본', [line(b.year1Id, 100)])
    ).rejects.toThrow(/이 과제에 속하지 않은 연차입니다/);
    await expect(
      createVersion(a.projectId, 'selection', '선정평가본', [], [participant(b.year1Id, null, 1)])
    ).rejects.toThrow(/이 과제에 속하지 않은 연차입니다/);
    await expect(
      createVersion(a.projectId, 'selection', '선정평가본', [], [participant(a.year1Id, b.memberId, 1)])
    ).rejects.toThrow(/이 과제에 속하지 않은 참여인력입니다/);
    expect((await countRows(a.projectId)).versions).toBe(0);
  });

  it('직접 INSERT·UPDATE도 다른 과제의 연차·인력을 거부한다 (가드 트리거)', async () => {
    const a = await newFixture('Phase 24 경계 직접 A');
    const b = await newFixture('Phase 24 경계 직접 B');
    const v = await createVersion(a.projectId, 'selection', '선정평가본', [line(a.year1Id, 100)]);

    const insLine = await user.client
      .from('agreement_lines')
      .insert({ ...line(b.year1Id, 1), version_id: v.versionId });
    expect(insLine.error?.message).toMatch(/이 과제에 속하지 않은 연차입니다/);
    const insPart = await user.client
      .from('agreement_participants')
      .insert({ ...participant(a.year1Id, b.memberId, 1), version_id: v.versionId });
    expect(insPart.error?.message).toMatch(/이 과제에 속하지 않은 참여인력입니다/);
    expect((await insertItem(v.versionId, b.year1Id)).error?.message).toMatch(
      /이 과제에 속하지 않은 연차입니다/
    );
    const upd = await user.client
      .from('agreement_lines')
      .update({ year_id: b.year1Id })
      .eq('version_id', v.versionId);
    expect(upd.error?.message).toMatch(/이 과제에 속하지 않은 연차입니다/);

    expect(await countRows(a.projectId)).toEqual({ versions: 1, lines: 1, participants: 0, items: 0 });
  });

  it('같은 칸이 두 번 오면 RPC가 거부한다 (경합 23505와 구별)', async () => {
    const f = await newFixture('Phase 24 칸 중복');
    await expect(
      createVersion(f.projectId, 'selection', '선정평가본', [line(f.year1Id, 1), line(f.year1Id, 2)])
    ).rejects.toThrow(/같은 칸\(연차·비목·세목·축\)의 금액 줄이 두 번 있습니다/);
  });
});

// ─── (e) 버전 트리거 ─────────────────────────────────────────

describe('(e) 버전 트리거 — 순서·과제 고정, 확정 취소는 마지막 버전만 (AV-8)', () => {
  it('뒤에 버전이 있는 확정 버전의 확정 취소는 거부되고, 마지막 버전은 된다', async () => {
    const f = await newFixture('Phase 24 확정 취소');
    const v1 = await createVersion(f.projectId, 'selection', '선정평가본');
    await confirm(v1.versionId);
    const v2 = await createVersion(f.projectId, 'final', '최종협약본');
    expect(v2.order).toBe(2);
    await confirm(v2.versionId);

    const unconfirm = (id: string) =>
      user.client.from('agreement_versions').update({ status: 'draft', confirmed_at: null }).eq('id', id);

    expect((await unconfirm(v1.versionId)).error?.message).toMatch(
      /확정 취소는 과제의 마지막 버전만 할 수 있습니다/
    );
    expect((await unconfirm(v2.versionId)).error).toBeNull();
    const rows = await sql<{ id: string; status: string; confirmed_at: Date | null }[]>`
      select id, status, confirmed_at from public.agreement_versions
       where project_id = ${f.projectId}::uuid order by sort_order`;
    expect(rows.map((r) => [r.status, r.confirmed_at === null])).toEqual([
      ['confirmed', false],
      ['draft', true],
    ]);
  });

  it('project_id·sort_order 변경은 거부된다', async () => {
    const a = await newFixture('Phase 24 버전 고정 A');
    const b = await newFixture('Phase 24 버전 고정 B');
    const v = await createVersion(a.projectId, 'selection', '선정평가본');
    const moved = await user.client
      .from('agreement_versions')
      .update({ project_id: b.projectId })
      .eq('id', v.versionId);
    expect(moved.error?.message).toMatch(/과제는 바꿀 수 없습니다/);
    const reordered = await user.client
      .from('agreement_versions')
      .update({ sort_order: 9 })
      .eq('id', v.versionId);
    expect(reordered.error?.message).toMatch(/순서는 바꿀 수 없습니다/);
  });
});

// ─── (f) 연쇄 삭제 ───────────────────────────────────────────

describe('(f) 연쇄 삭제 — H-5a·H-7·H-9b', () => {
  it('delete_project는 협약 4종을 남기지 않는다 (확정 버전·참여인원·편성 항목 포함)', async () => {
    const f = await newFixture('Phase 24 과제 삭제');
    const v1 = await createVersion(
      f.projectId,
      'final',
      '최종협약본',
      [line(f.year1Id, 100), line(f.year2Id, 200)],
      [participant(f.year1Id, f.memberId, 300)]
    );
    expect((await insertItem(v1.versionId, f.year2Id)).error).toBeNull();
    await confirm(v1.versionId);
    const cloned = await user.client.rpc('clone_agreement_version', {
      p_source_id: v1.versionId,
      p_kind: 'amendment',
      p_name: '협약변경 1차',
    });
    expect(cloned.error).toBeNull();
    expect(await countRows(f.projectId)).toEqual({ versions: 2, lines: 4, participants: 2, items: 2 });
    const versionIds = (
      await sql<{ id: string }[]>`select id from public.agreement_versions where project_id = ${f.projectId}::uuid`
    ).map((r) => r.id);

    await projects.deleteProject(user.client, f.projectId);

    const left = await sql<{ n: number }[]>`
      select (
        (select count(*) from public.agreement_versions where id = any(${versionIds}::uuid[])) +
        (select count(*) from public.agreement_lines where version_id = any(${versionIds}::uuid[])) +
        (select count(*) from public.agreement_participants where version_id = any(${versionIds}::uuid[])) +
        (select count(*) from public.agreement_items where version_id = any(${versionIds}::uuid[])) +
        (select count(*) from public.projects where id = ${f.projectId}::uuid)
      )::int as n`;
    expect(left[0]!.n).toBe(0);
  });

  it.each([
    ['금액 줄', 'line'],
    ['참여인원', 'participant'],
    ['편성 항목', 'item'],
  ] as const)(
    '%s이 쓰는 연차는 delete_year·delete_stage가 거부하고 데이터는 그대로다. 버전을 지우면 된다',
    async (_label, via) => {
      const f = await newFixture(`Phase 24 연차 삭제 ${via}`);
      // delete_stage는 마지막 단계 거부(H-6)가 먼저다 — 두 번째 단계에 연차를 만들어 그 단계를 지운다
      const stage2 = await stages.createStage(user.client, { projectId: f.projectId, name: '2단계' });
      const year3 = await years.createYear(user.client, { stageId: stage2.id, name: '3차년도' });

      const v = await createVersion(
        f.projectId,
        'selection',
        '선정평가본',
        via === 'line' ? [line(year3.id, 100)] : [],
        via === 'participant' ? [participant(year3.id, null, 100)] : []
      );
      if (via === 'item') expect((await insertItem(v.versionId, year3.id)).error).toBeNull();
      await confirm(v.versionId);
      const before = await countRows(f.projectId);

      const MESSAGE = '협약 예산 버전 1개가 이 연차를 씁니다 — 해당 버전을 먼저 삭제하세요';
      await expect(years.deleteYear(user.client, year3.id)).rejects.toThrow(MESSAGE);
      await expect(stages.deleteStage(user.client, stage2.id)).rejects.toThrow(MESSAGE);

      const kept = await sql<{ years: number; stages: number }[]>`
        select (select count(*) from public.years where id = ${year3.id}::uuid)::int as years,
               (select count(*) from public.stages where id = ${stage2.id}::uuid)::int as stages`;
      expect(kept[0]).toEqual({ years: 1, stages: 1 });
      expect(await countRows(f.projectId)).toEqual(before);

      // 버전을 쓰지 않는 연차는 그대로 지워진다 (기존 H-5 동작)
      await years.deleteYear(user.client, f.year2Id);

      const del = await user.client.from('agreement_versions').delete().eq('id', v.versionId);
      expect(del.error).toBeNull();
      await stages.deleteStage(user.client, stage2.id);
      const gone = await sql`select 1 from public.years where id = ${year3.id}::uuid`;
      expect(gone).toEqual([]);
    }
  );

  it('여러 버전이 쓰면 버전 수를 센다', async () => {
    const f = await newFixture('Phase 24 연차 삭제 2버전');
    const v1 = await createVersion(f.projectId, 'selection', '선정평가본', [line(f.year2Id, 100)]);
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

  it('참여인원이 참조하는 인력은 delete_member가 거부하고, count_member_references가 별도 키로 센다', async () => {
    const f = await newFixture('Phase 24 인력 삭제');
    const v = await createVersion(
      f.projectId,
      'final',
      '최종협약본',
      [],
      [participant(f.year1Id, f.memberId, 100), participant(f.year2Id, f.memberId, 200)]
    );
    await confirm(v.versionId);

    const counts = await user.client.rpc('count_member_references', { p_member_id: f.memberId });
    expect(counts.error).toBeNull();
    expect(counts.data).toMatchObject({ agreement_participants: 2, budget_details: 0 });

    const { error } = await user.client.rpc('delete_member', { p_member_id: f.memberId });
    expect(error?.message).toMatch(
      /협약 예산 참여인원 2건이 이 인력을 참조합니다. 해당 협약 예산 버전을 먼저 삭제하세요/
    );
    await expect(members.removeMember(user.client, f.memberId)).rejects.toThrow(/협약 예산 참여인원 2건/);
    const kept = await sql`select 1 from public.members where id = ${f.memberId}::uuid`;
    expect(kept).toHaveLength(1);
    expect((await countRows(f.projectId)).participants).toBe(2);

    const del = await user.client.from('agreement_versions').delete().eq('id', v.versionId);
    expect(del.error).toBeNull();
    const removed = await user.client.rpc('delete_member', { p_member_id: f.memberId });
    expect(removed.error).toBeNull();
    expect(removed.data).toMatchObject({ agreement_participants: 0 });
  });

  it('산출근거 참조(H-9a) 거부는 그대로다 — 메시지가 협약과 섞이지 않는다', async () => {
    const f = await newFixture('Phase 24 H-9a 회귀');
    await sql`
      insert into public.budget_details
        (project_id, year_id, category, subcategory, axis, formula, member_id,
         factors, amount, created_by, updated_by)
      values (${f.projectId}::uuid, ${f.year1Id}::uuid, 'personnel', 'personnel_internal', 'cash',
              'personnel', ${f.memberId}::uuid,
              ${sql.json([{ label: '참여율', value: 50, isPercent: true }])}::jsonb, 1000,
              ${user.id}::uuid, ${user.id}::uuid)`;
    const { error } = await user.client.rpc('delete_member', { p_member_id: f.memberId });
    expect(error?.message).toMatch(/인건비 산출근거 1건이 이 인력을 참조합니다/);
  });
});

// ─── (g) RPC 계약 ────────────────────────────────────────────

describe('(g) RPC 계약 — 복제·전체 삭제', () => {
  it('clone_agreement_version은 하위 3종을 새 id로 복사하고 원본은 그대로다 (AV-1)', async () => {
    const f = await newFixture('Phase 24 복제');
    const v1 = await createVersion(
      f.projectId,
      'final',
      '최종협약본',
      [line(f.year1Id, 5000000), line(f.year2Id, 4000000, 'default', 'in_kind')],
      [participant(f.year1Id, f.memberId, 30000000), participant(f.year2Id, null, 5000000)]
    );
    expect((await insertItem(v1.versionId, f.year1Id)).error).toBeNull();
    await confirm(v1.versionId);
    const source = await sql<{ version: string; updated_at: Date }[]>`
      select version::text as version, updated_at from public.agreement_versions where id = ${v1.versionId}::uuid`;

    const { data, error } = await user.client.rpc('clone_agreement_version', {
      p_source_id: v1.versionId,
      p_kind: 'amendment',
      p_name: '협약변경 1차',
    });
    expect(error).toBeNull();
    expect(data).toMatchObject({ order: 2, lines: 2, participants: 2, items: 1 });
    const newId = (data as { versionId: string }).versionId;

    const v = await sql<{ status: string; kind: string; name: string; sort_order: number; confirmed_at: Date | null }[]>`
      select status, kind, name, sort_order, confirmed_at from public.agreement_versions where id = ${newId}::uuid`;
    expect(v[0]).toMatchObject({ status: 'draft', kind: 'amendment', name: '협약변경 1차', sort_order: 2, confirmed_at: null });

    const childRows = async (versionId: string) => ({
      lines: await sql`
        select id, year_id, category, subcategory_code, axis, amount::text as amount
          from public.agreement_lines where version_id = ${versionId}::uuid order by amount`,
      participants: await sql`
        select id, member_id, year_id, participation_rate::text as rate, months::text as months,
               annual_salary::text as salary, personnel_cash::text as cash, personnel_in_kind::text as in_kind, role
          from public.agreement_participants where version_id = ${versionId}::uuid order by personnel_cash`,
      items: await sql`
        select id, year_id, kind, name, amount::text as amount, quantity::text as quantity, evidence
          from public.agreement_items where version_id = ${versionId}::uuid`,
    });
    const src = await childRows(v1.versionId);
    const dst = await childRows(newId);
    const strip = (rows: readonly Record<string, unknown>[]) => rows.map(({ id: _id, ...rest }) => rest);
    for (const key of ['lines', 'participants', 'items'] as const) {
      expect(strip(dst[key]), key).toEqual(strip(src[key]));
      const srcIds = new Set(src[key].map((r) => r.id));
      expect(dst[key].every((r) => !srcIds.has(r.id)), `${key} 새 id`).toBe(true);
    }
    expect(dst.items[0]!.evidence).toEqual([{ label: '견적서', obtained: true, memo: '' }]);
    expect(dst.participants.map((r) => r.salary)).toEqual(['60000000', '60000000']);

    const after = await sql<{ version: string; updated_at: Date }[]>`
      select version::text as version, updated_at from public.agreement_versions where id = ${v1.versionId}::uuid`;
    expect(after).toEqual(source);
  });

  it('delete_agreement_versions는 그 과제 버전만 지운다 (AV-4)', async () => {
    const a = await newFixture('Phase 24 전체 삭제 A');
    const b = await newFixture('Phase 24 전체 삭제 B');
    const a1 = await createVersion(a.projectId, 'selection', '선정평가본', [line(a.year1Id, 1)]);
    await confirm(a1.versionId);
    await createVersion(a.projectId, 'adjustment', '조정회의본', [line(a.year1Id, 2)]);
    await createVersion(b.projectId, 'selection', '선정평가본', [line(b.year1Id, 3)]);

    const { data, error } = await user.client.rpc('delete_agreement_versions', { p_project_id: a.projectId });
    expect(error).toBeNull();
    expect(data).toEqual({ deleted: 2 });
    expect(await countRows(a.projectId)).toEqual({ versions: 0, lines: 0, participants: 0, items: 0 });
    expect(await countRows(b.projectId)).toEqual({ versions: 1, lines: 1, participants: 0, items: 0 });

    // 버전을 지워도 순번을 다시 매기지 않는다 — 다음 버전은 남은 최댓값 + 1
    const next = await createVersion(a.projectId, 'selection', '선정평가본');
    expect(next.order).toBe(1);
  });

  it('버전을 지워도 남은 순번은 그대로다 (빈자리 유지)', async () => {
    const f = await newFixture('Phase 24 순번');
    const v1 = await createVersion(f.projectId, 'selection', '선정평가본');
    await confirm(v1.versionId);
    const v2 = await createVersion(f.projectId, 'final', '최종협약본');
    await confirm(v2.versionId);
    const v3 = await createVersion(f.projectId, 'amendment', '협약변경 1차');
    await user.client.from('agreement_versions').delete().eq('id', v2.versionId);
    const rows = await sql<{ sort_order: number }[]>`
      select sort_order from public.agreement_versions where project_id = ${f.projectId}::uuid order by sort_order`;
    expect(rows.map((r) => r.sort_order)).toEqual([1, 3]);
    expect(v3.order).toBe(3);
  });
});

// ─── (h) restore_backup ──────────────────────────────────────

describe('(h) restore_backup — c_tables·가드 on/off (K-9)', () => {
  it('c_tables가 RESTORE_TABLES와 순서까지 같고, 가드 3개를 끄고 다시 켠다', async () => {
    const rows = await sql<{ src: string; prosecdef: boolean }[]>`
      select p.prosrc as src, p.prosecdef from pg_proc p join pg_namespace n on n.oid = p.pronamespace
       where n.nspname = 'public' and p.proname = 'restore_backup'`;
    expect(rows).toHaveLength(1);
    const src = rows[0]!.src;
    const arrayBody = src.match(/c_tables constant text\[\] := array\[([\s\S]*?)\];/)?.[1];
    expect(arrayBody).toBeDefined();
    const cTables = [...arrayBody!.matchAll(/'([a-z_]+)'/g)].map((m) => m[1]);
    expect(cTables).toEqual([...backup.RESTORE_TABLES]);
    expect(cTables.indexOf('agreement_versions')).toBe(cTables.indexOf('budget_rules') + 1);

    // 끄기는 삽입 루프 앞, 켜기는 그 뒤 — 순서까지 본다
    const insertLoop = src.indexOf('foreach t in array c_tables loop');
    expect(insertLoop).toBeGreaterThan(-1);
    for (const t of CHILD_TABLES) {
      const off = src.search(new RegExp(`alter table public\\.${t}\\s+disable trigger agreement_child_guard`));
      const on = src.search(new RegExp(`alter table public\\.${t}\\s+enable trigger agreement_child_guard`));
      expect(off, t).toBeGreaterThan(-1);
      expect(off, t).toBeLessThan(insertLoop);
      expect(on, t).toBeGreaterThan(insertLoop);
    }
    // 가드는 지금 켜져 있다 (tgenabled 'O' = origin 활성)
    const triggers = await sql<{ rel: string; enabled: string }[]>`
      select t.tgrelid::regclass::text as rel, t.tgenabled as enabled from pg_trigger t
       where t.tgname = 'agreement_child_guard'`;
    expect(triggers.map((r) => [r.rel, r.enabled]).sort()).toEqual(
      CHILD_TABLES.map((t) => [t, 'O']).sort()
    );
  });
});
