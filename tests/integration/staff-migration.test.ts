// staff·staff_salaries 마이그레이션 통합 테스트 — 20260925000000_staff_salary.sql
// (SOT §5.11 Phase 16 추가 4필드, §5.19 ST-1·ST-2, §5.20, §6.10 PL-10b(v4.7), §8.7 K-7, §8.8, §14.3 RLS-1)
//
// 검증의 핵심:
//  (a) ST-1 — 대소문자·공백만 다른 이메일은 같은 사람이다 (unique index on lower(trim(email))).
//  (b) (staff_id, effective_from) 유일 — 같은 날짜에 두 급여가 있으면 SL-2가 고를 수 없다.
//  (c) check 제약 — amount ≥ 0, basis enum. DB가 최후 방어선으로 동작한다 (Zod는 액션이 따로 검증).
//  (d) ST-2 — 조직원 삭제 시 이력 cascade, members.staff_id set null, 연봉·스냅샷은 남는다.
//  (e) apply_salary_change — p_snapshot 없이 부르면 기존 동작(스냅샷 불변), 있으면 같은 UPDATE에서 세팅.
//  (f) schema_version = 4, RLS 활성·정책, Realtime publication 미포함, members 4컬럼.
//
// 직결 SQL(postgres role)만 쓴다 — 검증 대상이 스키마·RPC 계약 자체이고 리포지토리(T4)는 아직 없다.
// 자기가 만든 조직원·과제만 지운다 — 파괴적 테스트가 아니다.

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Sql } from 'postgres';
import { connectDirectDb } from './helpers';

let sql: Sql;
const staffIds: string[] = [];   // afterAll 안전망 — 실패해도 dev DB를 원복한다
const projectIds: string[] = [];

// 테스트 실행마다 다른 이메일 — 이전 실행 잔여물과 ST-1 충돌을 일으키지 않기 위해서다
const RUN = `${Date.now()}-${randomUUID().slice(0, 8)}`;

interface StaffRow { id: string }

async function newStaff(email: string, name = '테스트 조직원'): Promise<string> {
  const rows = await sql<StaffRow[]>`
    insert into public.staff (name, email) values (${name}, ${email}) returning id`;
  const id = rows[0]!.id;
  staffIds.push(id);
  return id;
}

async function newProject(name: string): Promise<string> {
  const rows = await sql<{ id: string }[]>`
    insert into public.projects (name) values (${name}) returning id`;
  const id = rows[0]!.id;
  projectIds.push(id);
  return id;
}

function insertSalary(staffId: string, row: {
  effectiveFrom: string;
  basis?: string;
  amount?: number;
}) {
  return sql`
    insert into public.staff_salaries
      (staff_id, effective_from, basis, amount, includes_retirement, includes_insurance)
    values (${staffId}::uuid, ${row.effectiveFrom}::date, ${row.basis ?? 'annual'},
            ${row.amount ?? 40000000}, true, false)`;
}

beforeAll(async () => {
  sql = connectDirectDb();
});

afterAll(async () => {
  if (projectIds.length > 0) {
    await sql`delete from public.projects where id = any(${projectIds}::uuid[])`;
  }
  if (staffIds.length > 0) {
    await sql`delete from public.staff where id = any(${staffIds}::uuid[])`;
  }
  await sql.end();
});

// ─── (f) 스키마 상태 ─────────────────────────────────────────

describe('(f) 스키마 상태 — schema_version 4, RLS, publication, members 4컬럼', () => {
  it('app_settings.schema_version = 4', async () => {
    const rows = await sql<{ v: string }[]>`select schema_version::text as v from public.app_settings`;
    expect(rows).toHaveLength(1);
    expect(rows[0]!.v).toBe('4');
  });

  it.each(['staff', 'staff_salaries'])('%s에 RLS가 켜져 있고 승인 사용자 정책이 있다 (RLS-1)', async (table) => {
    const rls = await sql<{ enabled: boolean }[]>`
      select c.relrowsecurity as enabled
        from pg_class c join pg_namespace n on n.oid = c.relnamespace
       where n.nspname = 'public' and c.relname = ${table}`;
    expect(rls[0]?.enabled).toBe(true);

    const policies = await sql<{ policyname: string; roles: string[] }[]>`
      select policyname, roles::text[] as roles from pg_policies
       where schemaname = 'public' and tablename = ${table}`;
    expect(policies).toHaveLength(1);
    expect(policies[0]!.policyname).toBe('approved users full access');
    expect(policies[0]!.roles).toEqual(['authenticated']);
  });

  it('staff·staff_salaries는 Realtime publication에 없다 (§8.5 구독표 밖)', async () => {
    const rows = await sql`
      select tablename from pg_publication_tables
       where pubname = 'supabase_realtime' and schemaname = 'public'
         and tablename in ('staff', 'staff_salaries')`;
    expect(rows).toEqual([]);
  });

  it('members에 staff_id·스냅샷 3컬럼이 nullable로 있고 staff_id FK는 set null', async () => {
    const cols = await sql<{ column_name: string; is_nullable: string; data_type: string }[]>`
      select column_name, is_nullable, data_type from information_schema.columns
       where table_schema = 'public' and table_name = 'members'
         and column_name in ('staff_id', 'salary_includes_retirement',
                             'salary_includes_insurance', 'salary_applied_from')
       order by column_name`;
    expect(cols).toEqual([
      { column_name: 'salary_applied_from', is_nullable: 'YES', data_type: 'date' },
      { column_name: 'salary_includes_insurance', is_nullable: 'YES', data_type: 'boolean' },
      { column_name: 'salary_includes_retirement', is_nullable: 'YES', data_type: 'boolean' },
      { column_name: 'staff_id', is_nullable: 'YES', data_type: 'uuid' },
    ]);

    const fk = await sql<{ confdeltype: string }[]>`
      select confdeltype from pg_constraint
       where conrelid = 'public.members'::regclass and contype = 'f'
         and confrelid = 'public.staff'::regclass`;
    expect(fk).toHaveLength(1);
    expect(fk[0]!.confdeltype).toBe('n'); // set null
  });

  it('apply_salary_change는 5인자(p_snapshot 포함) 정의 하나만 있다', async () => {
    const rows = await sql<{ args: string }[]>`
      select pg_get_function_identity_arguments(p.oid) as args
        from pg_proc p join pg_namespace n on n.oid = p.pronamespace
       where n.nspname = 'public' and p.proname = 'apply_salary_change'`;
    expect(rows).toHaveLength(1);
    expect(rows[0]!.args).toBe(
      'p_member_id uuid, p_annual_salary bigint, p_amounts jsonb, p_expected_version bigint, p_snapshot jsonb'
    );
  });
});

// ─── (a) ST-1 ────────────────────────────────────────────────

describe('(a) ST-1 — 이메일은 대소문자·공백 정규화 후 유일', () => {
  it('"A@X.com"과 " a@x.com "은 같은 사람이라 두 번째 insert가 23505로 거부된다', async () => {
    await newStaff(`Staff-${RUN}@Unes.co.kr`);
    await expect(newStaff(`  staff-${RUN}@unes.co.kr  `)).rejects.toMatchObject({ code: '23505' });
  });

  it('갱신 시 set_updated_meta가 version을 올린다 (O-1)', async () => {
    const id = await newStaff(`meta-${RUN}@unes.co.kr`);
    await sql`update public.staff set position = '선임' where id = ${id}::uuid`;
    const rows = await sql<{ version: string; position: string }[]>`
      select version::text as version, position from public.staff where id = ${id}::uuid`;
    expect(rows[0]).toEqual({ version: '2', position: '선임' });
  });
});

// ─── (b)(c) staff_salaries 제약 ──────────────────────────────

describe('(b)(c) staff_salaries 제약 — 유일·amount·basis', () => {
  let staffId: string;

  beforeAll(async () => {
    staffId = await newStaff(`salary-${RUN}@unes.co.kr`);
  });

  it('같은 (staff_id, effective_from) 두 건은 23505', async () => {
    await insertSalary(staffId, { effectiveFrom: '2026-01-01' });
    await expect(insertSalary(staffId, { effectiveFrom: '2026-01-01', amount: 1 }))
      .rejects.toMatchObject({ code: '23505' });
    // 날짜가 다르면 쌓인다 (SL-3)
    await insertSalary(staffId, { effectiveFrom: '2026-07-01' });
  });

  it('amount -1은 23514, 0은 통과', async () => {
    await expect(insertSalary(staffId, { effectiveFrom: '2027-01-01', amount: -1 }))
      .rejects.toMatchObject({ code: '23514' });
    await insertSalary(staffId, { effectiveFrom: '2027-01-01', amount: 0 });
  });

  it("basis 'weekly'는 23514", async () => {
    await expect(insertSalary(staffId, { effectiveFrom: '2028-01-01', basis: 'weekly' }))
      .rejects.toMatchObject({ code: '23514' });
  });

  it('갱신 시 set_updated_meta가 version을 올린다 (O-1)', async () => {
    await sql`update public.staff_salaries set note = '2026 연봉계약'
               where staff_id = ${staffId}::uuid and effective_from = '2026-01-01'`;
    const rows = await sql<{ version: string }[]>`
      select version::text as version from public.staff_salaries
       where staff_id = ${staffId}::uuid and effective_from = '2026-01-01'`;
    expect(rows[0]!.version).toBe('2');
  });
});

// ─── (d) ST-2 ────────────────────────────────────────────────

describe('(d) ST-2 — 조직원 삭제: 이력 cascade, Member는 staff_id만 null', () => {
  it('이력 0건, members.staff_id null, annual_salary·스냅샷 3컬럼 유지', async () => {
    const staffId = await newStaff(`cascade-${RUN}@unes.co.kr`);
    await insertSalary(staffId, { effectiveFrom: '2025-01-01', amount: 36000000 });
    await insertSalary(staffId, { effectiveFrom: '2026-01-01', basis: 'monthly', amount: 3200000 });

    const projectId = await newProject(`staff-cascade-${RUN}`);
    const members = await sql<{ id: string }[]>`
      insert into public.members
        (project_id, name, role, active, annual_salary, staff_id,
         salary_includes_retirement, salary_includes_insurance, salary_applied_from)
      values (${projectId}::uuid, '연결 인력', 'researcher', true, 38400000, ${staffId}::uuid,
              true, false, '2026-01-01'::date)
      returning id`;
    const memberId = members[0]!.id;

    await sql`delete from public.staff where id = ${staffId}::uuid`;
    staffIds.splice(staffIds.indexOf(staffId), 1);

    const salaries = await sql`select 1 from public.staff_salaries where staff_id = ${staffId}::uuid`;
    expect(salaries).toEqual([]);

    const after = await sql<{
      staff_id: string | null;
      annual_salary: string | null;
      salary_includes_retirement: boolean | null;
      salary_includes_insurance: boolean | null;
      salary_applied_from: string | null;
    }[]>`
      select staff_id, annual_salary::text as annual_salary, salary_includes_retirement,
             salary_includes_insurance, salary_applied_from::text as salary_applied_from
        from public.members where id = ${memberId}::uuid`;
    expect(after[0]).toEqual({
      staff_id: null,
      annual_salary: '38400000',
      salary_includes_retirement: true,
      salary_includes_insurance: false,
      salary_applied_from: '2026-01-01',
    });
  });
});

// ─── (e) apply_salary_change ─────────────────────────────────

describe('(e) apply_salary_change — p_snapshot 없으면 기존 동작, 있으면 같은 UPDATE에서 스냅샷 (PL-10b v4.7)', () => {
  let memberId: string;

  interface MemberSalaryRow {
    annual_salary: string | null;
    salary_includes_retirement: boolean | null;
    salary_includes_insurance: boolean | null;
    salary_applied_from: string | null;
    version: string;
  }

  async function readMember(): Promise<MemberSalaryRow> {
    const rows = await sql<MemberSalaryRow[]>`
      select annual_salary::text as annual_salary, salary_includes_retirement,
             salary_includes_insurance, salary_applied_from::text as salary_applied_from,
             version::text as version
        from public.members where id = ${memberId}::uuid`;
    return rows[0]!;
  }

  beforeAll(async () => {
    const projectId = await newProject(`staff-rpc-${RUN}`);
    const rows = await sql<{ id: string }[]>`
      insert into public.members (project_id, name, role, active, annual_salary)
      values (${projectId}::uuid, 'RPC 인력', 'researcher', true, 30000000) returning id`;
    memberId = rows[0]!.id;
  });

  it('p_snapshot 없이(3인자·4인자) — 연봉만 바뀌고 스냅샷 3컬럼은 그대로 null', async () => {
    const r3 = await sql<{ res: { memberId: string; updated: number; cells: number } }[]>`
      select public.apply_salary_change(${memberId}::uuid, 31000000, '[]'::jsonb) as res`;
    expect(r3[0]!.res).toMatchObject({ memberId, updated: 0, cells: 0 });
    expect(await readMember()).toEqual({
      annual_salary: '31000000',
      salary_includes_retirement: null,
      salary_includes_insurance: null,
      salary_applied_from: null,
      version: '2',
    });

    // 기존 4인자 호출(expected_version) 호환
    await sql`select public.apply_salary_change(${memberId}::uuid, 32000000, '[]'::jsonb, 2)`;
    expect((await readMember()).annual_salary).toBe('32000000');

    await expect(
      sql`select public.apply_salary_change(${memberId}::uuid, 33000000, '[]'::jsonb, 1)`
    ).rejects.toThrow(/먼저 수정/);
    expect((await readMember()).annual_salary).toBe('32000000');
  });

  // p_snapshot은 `::text::jsonb`로 넘긴다 — `::jsonb`만 쓰면 postgres.js가 서버가 추론한 jsonb 타입에
  // 맞춰 문자열을 JSON.stringify로 다시 감싸, RPC가 객체 대신 jsonb 문자열을 받는다
  it('p_snapshot으로 호출 — 연봉과 스냅샷 3컬럼이 함께 세팅된다', async () => {
    const snapshot = {
      salaryIncludesRetirement: true,
      salaryIncludesInsurance: false,
      salaryAppliedFrom: '2026-01-01',
    };
    await sql`select public.apply_salary_change(
      ${memberId}::uuid, 36000000, '[]'::jsonb, null, ${JSON.stringify(snapshot)}::text::jsonb)`;
    expect(await readMember()).toMatchObject({
      annual_salary: '36000000',
      salary_includes_retirement: true,
      salary_includes_insurance: false,
      salary_applied_from: '2026-01-01',
    });
  });

  it('p_snapshot 없이 다시 부르면 이전 스냅샷이 유지된다 (null = 건드리지 않음)', async () => {
    await sql`select public.apply_salary_change(${memberId}::uuid, 37000000, '[]'::jsonb)`;
    expect(await readMember()).toMatchObject({
      annual_salary: '37000000',
      salary_includes_retirement: true,
      salary_includes_insurance: false,
      salary_applied_from: '2026-01-01',
    });
  });

  it('세 값이 전부 null인 p_snapshot은 "기록 없음"으로 되돌린다 (수동 연봉 수정 경로)', async () => {
    const cleared = {
      salaryIncludesRetirement: null,
      salaryIncludesInsurance: null,
      salaryAppliedFrom: null,
    };
    await sql`select public.apply_salary_change(
      ${memberId}::uuid, 38000000, '[]'::jsonb, null, ${JSON.stringify(cleared)}::text::jsonb)`;
    expect(await readMember()).toMatchObject({
      annual_salary: '38000000',
      salary_includes_retirement: null,
      salary_includes_insurance: null,
      salary_applied_from: null,
    });
  });

  it('객체가 아니거나 키가 빠진 p_snapshot은 거부되고 연봉도 바뀌지 않는다 (단일 트랜잭션)', async () => {
    await expect(
      sql`select public.apply_salary_change(${memberId}::uuid, 1, '[]'::jsonb, null, '[]'::jsonb)`
    ).rejects.toThrow(/객체가 아닙니다/);
    await expect(
      sql`select public.apply_salary_change(
        ${memberId}::uuid, 1, '[]'::jsonb, null, '{"salaryIncludesRetirement": true}'::jsonb)`
    ).rejects.toThrow(/필요한 키가 없습니다/);
    expect((await readMember()).annual_salary).toBe('38000000');
  });
});
