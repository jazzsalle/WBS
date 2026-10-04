// Phase 26 규칙 검증 공통 + 증빙 마이그레이션(20261005000000) 통합 테스트
// (SOT §5.18 RL-D2, §5.21 AV-2, §5.24, §8.5, §8.8, §9 Agreement Budget,
//  계획서 docs/plans/phase-26-plan.md S-1·S-4·S-12·S-14·S-21)
//
// 검증의 핵심:
//  (a) budget_rules — code check 20종(새 3종, RL-20·RL-21 없음), value_range·enabled_value가 새 코드를 덮는다
//  (b) agreement_items.evidence — agreement_evidence_is_valid check가 모양이 틀린 원소를 INSERT·UPDATE에서 거부
//  (c) 확정 잠금 증빙 예외(S-1) — 확정 버전 편성 항목은 체크·메모만 통과, 라벨·다른 컬럼·INSERT 거부,
//      다른 3테이블은 그대로 거부
//  (d) create_agreement_version p_items — 저장·건수·검증, 옛 6인자 시그니처 없음
//  (e) security definer 0, publication 불변, schema_version 7
//
// 쓰기는 publishable 키 + 실제 세션(RLS 경로)으로 한다 — 가드 트리거·RLS가 앱과 같은 조건에서 돈다.
// budget_rules check만 직결 SQL로 넣는다(20260817000000 테스트와 같은 방식 — 검증 대상이 check 자체다).
// 자기가 만든 과제·사용자만 지운다 — 파괴적 테스트가 아니다.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Sql } from 'postgres';
import { connectDirectDb, createTestUser, destroyTestUser, type TestUser } from './helpers';
import * as projects from '@/lib/db/projects';
import * as stages from '@/lib/db/stages';
import * as years from '@/lib/db/years';

const LOCKED = /확정된 협약 예산 버전의 내용은 고칠 수 없습니다/;

const RULE_CODES_20 = [
  'allowance_max', 'allowance_min', 'indirect_max', 'consignment_max',
  'external_tech_max', 'gov_share_max', 'own_cash_min',
  'indirect_cash_only', 'no_personnel_support', 'no_student_personnel',
  'no_burden', 'existing_personnel_cash', 'existing_cash_le_new',
  'min_participation',
  'equipment_review_threshold', 'material_notice_threshold', 'outsourcing_notice_threshold',
  'lab_safety_min', 'lab_safety_max', 'preserve_subcategory_totals',
];

let sql: Sql;
let user: TestUser;
const tempProjectIds: string[] = []; // afterAll 안전망 — 실패해도 dev DB를 원복한다

interface Fixture {
  projectId: string;
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
  const member = await sql<{ id: string }[]>`
    insert into public.members (project_id, name, role, active, created_by, updated_by)
    values (${project.id}::uuid, '협약 참여자', 'researcher', true, ${user.id}::uuid, ${user.id}::uuid)
    returning id`;
  return { projectId: project.id, year1Id: year1.id, year2Id: year2.id, memberId: member[0]!.id };
}

interface CreateResult {
  versionId: string;
  order: number;
  lines: number;
  participants: number;
  govSupport: number;
  items: number;
}

function createVersionRaw(projectId: string, extra: Record<string, unknown> = {}) {
  return user.client.rpc('create_agreement_version', {
    p_project_id: projectId,
    p_kind: 'final',
    p_name: '최종협약본',
    p_lines: [],
    p_participants: [],
    ...extra,
  });
}

async function createVersion(projectId: string, extra: Record<string, unknown> = {}): Promise<CreateResult> {
  const { data, error } = await createVersionRaw(projectId, extra);
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

const EVIDENCE = [
  { label: '견적서', obtained: true, memo: '2개사' },
  { label: '비교견적서', obtained: false, memo: '' },
];

function item(yearId: string, overrides: Record<string, unknown> = {}) {
  return {
    year_id: yearId,
    kind: 'equipment',
    name: '분석 장비',
    amount: 33000000,
    quantity: 1,
    evidence: EVIDENCE,
    ...overrides,
  };
}

interface ItemRow {
  id: string;
  year_id: string;
  kind: string;
  name: string;
  amount: string;
  quantity: string | null;
  evidence: unknown;
  version: string;
}

async function itemRows(versionId: string): Promise<ItemRow[]> {
  return sql<ItemRow[]>`
    select id, year_id, kind, name, amount::text as amount, quantity::text as quantity, evidence,
           version::text as version
      from public.agreement_items where version_id = ${versionId}::uuid order by name, amount`;
}

beforeAll(async () => {
  sql = connectDirectDb();
  user = await createTestUser(sql);
});

afterAll(async () => {
  if (tempProjectIds.length > 0) {
    // 버전을 먼저 지운다 — delete_project(H-7)와 같은 순서. 연차의 no action FK를 피한다
    await sql`delete from public.agreement_versions where project_id = any(${tempProjectIds}::uuid[])`;
    await sql`delete from public.projects where id = any(${tempProjectIds}::uuid[])`;
  }
  await destroyTestUser(sql, user);
  await sql.end();
});

// ─── (a) budget_rules ───────────────────────────────────────

describe('(a) budget_rules 새 코드 3종 (§5.18 RL-D2, S-4)', () => {
  let projectId: string;

  beforeAll(async () => {
    projectId = (await newFixture('Phase 26 규칙 코드 check')).projectId;
  });

  function insert(row: { code: string; enabled?: boolean; value?: number | null; severity?: string }) {
    return sql`
      insert into public.budget_rules (project_id, code, enabled, value, base, severity, source)
      values (${projectId}::uuid, ${row.code}, ${row.enabled ?? true}, ${row.value ?? null}, null,
              ${row.severity ?? 'warn'}, '간사 지침 테스트')`;
  }

  async function clear() {
    await sql`delete from public.budget_rules where project_id = ${projectId}::uuid`;
  }

  it('code check는 정확히 20종이다 — 새 3종 포함, RL-20·RL-21 코드 없음', async () => {
    const rows = await sql<{ def: string }[]>`
      select pg_get_constraintdef(oid) as def from pg_constraint
       where conrelid = 'public.budget_rules'::regclass and conname = 'budget_rules_code_check'`;
    expect(rows).toHaveLength(1);
    const codes = [...rows[0]!.def.matchAll(/'([a-z_]+)'::text/g)].map((m) => m[1]);
    expect([...codes].sort()).toEqual([...RULE_CODES_20].sort());
    expect(codes).toHaveLength(20);
  });

  it('새 코드 3종을 값 종류대로 넣을 수 있다 — 비율은 소수도 된다', async () => {
    await insert({ code: 'lab_safety_min', value: 1 });
    await insert({ code: 'lab_safety_max', value: 2 });
    await insert({ code: 'preserve_subcategory_totals', value: null });
    const rows = await sql<{ code: string; value: string | null; enabled: boolean }[]>`
      select code, value::text as value, enabled from public.budget_rules
       where project_id = ${projectId}::uuid order by code`;
    expect(rows).toEqual([
      { code: 'lab_safety_max', value: '2', enabled: true },
      { code: 'lab_safety_min', value: '1', enabled: true },
      { code: 'preserve_subcategory_totals', value: null, enabled: true },
    ]);
    await clear();
    // 비율 코드는 소수를 가진다(RL-D2 — 중간 반올림 금지). 경계 0·100도 통과
    await insert({ code: 'lab_safety_min', value: 1.5 });
    await insert({ code: 'lab_safety_max', value: 100 });
    await clear();
    await insert({ code: 'lab_safety_min', value: 0 });
    await clear();
  });

  it('lab_safety_* 범위 밖(101·음수)은 value_range가 거부한다', async () => {
    for (const code of ['lab_safety_min', 'lab_safety_max']) {
      await expect(insert({ code, value: 101 }), code).rejects.toThrow(/budget_rules_value_range_check/);
      await expect(insert({ code, value: -0.5 }), code).rejects.toThrow(/budget_rules_value_range_check/);
    }
  });

  it('preserve_subcategory_totals에 값(정수·소수·0)이 오면 거부한다 — 값 없는 코드', async () => {
    for (const value of [1, 1.5, 0]) {
      await expect(insert({ code: 'preserve_subcategory_totals', value }), String(value)).rejects.toThrow(
        /budget_rules_value_range_check/
      );
    }
  });

  it('켜진 lab_safety_*에 값이 없으면 거부, 꺼지면 통과. RL-23은 켜져도 null이 정상', async () => {
    for (const code of ['lab_safety_min', 'lab_safety_max']) {
      await expect(insert({ code, value: null }), code).rejects.toThrow(/budget_rules_enabled_value_check/);
      await insert({ code, enabled: false, value: null });
    }
    await insert({ code: 'preserve_subcategory_totals', enabled: true, value: null });
    await clear();
    await insert({ code: 'preserve_subcategory_totals', enabled: false, value: null });
    await clear();
  });

  it('기존 코드의 제약 결과는 그대로다', async () => {
    await expect(insert({ code: 'no_burden', value: 0 })).rejects.toThrow(/budget_rules_value_range_check/);
    await expect(insert({ code: 'allowance_max', value: null })).rejects.toThrow(
      /budget_rules_enabled_value_check/
    );
    await expect(insert({ code: 'equipment_review_threshold', value: 30000000.5 })).rejects.toThrow(
      /budget_rules_value_range_check/
    );
    await expect(insert({ code: 'not_a_rule', value: 1 })).rejects.toThrow(/budget_rules_code_check/);
    await insert({ code: 'no_burden', value: null, severity: 'error' });
    await insert({ code: 'equipment_review_threshold', value: 30000000 });
    await clear();
  });
});

// ─── (b) evidence 모양 check ─────────────────────────────────

describe('(b) agreement_items.evidence 모양 check (§5.24, S-12)', () => {
  let f: Fixture;
  let versionId: string;

  beforeAll(async () => {
    f = await newFixture('Phase 26 증빙 check');
    versionId = (await createVersion(f.projectId)).versionId;
  });

  function insertWith(evidence: unknown) {
    return user.client
      .from('agreement_items')
      .insert({ ...item(f.year1Id, { evidence }), version_id: versionId })
      .select('id');
  }

  const ok = { label: '견적서', obtained: false, memo: '' };
  const BAD: [string, unknown][] = [
    ['배열이 아님', { label: '견적서', obtained: false, memo: '' }],
    ['원소가 문자열', ['견적서']],
    ['memo 없음', [{ label: '견적서', obtained: false }]],
    ['obtained 없음', [{ label: '견적서', memo: '' }]],
    ['label 없음', [{ obtained: false, memo: '' }]],
    ['obtained가 문자열', [{ label: '견적서', obtained: 'true', memo: '' }]],
    ['memo가 null', [{ label: '견적서', obtained: false, memo: null }]],
    ['label이 숫자', [{ label: 1, obtained: false, memo: '' }]],
    ['label 빈 문자열', [{ label: '', obtained: false, memo: '' }]],
    ['label 공백만', [{ label: '   ', obtained: false, memo: '' }]],
    ['label 101자', [{ label: 'a'.repeat(101), obtained: false, memo: '' }]],
    ['memo 501자', [{ label: '견적서', obtained: false, memo: 'm'.repeat(501) }]],
    ['label 중복', [ok, { ...ok, obtained: true }]],
    ['31개', Array.from({ length: 31 }, (_, i) => ({ label: `서류${i}`, obtained: false, memo: '' }))],
  ];

  it('모양이 틀린 evidence는 직접 INSERT를 check(23514)가 거부한다', async () => {
    for (const [name, evidence] of BAD) {
      const { error } = await insertWith(evidence);
      expect(error?.code, name).toBe('23514');
    }
    expect(await itemRows(versionId)).toEqual([]);
  });

  it('경계 안(빈 배열·30개·label 100자·memo 500자)은 통과한다', async () => {
    const good: unknown[] = [
      [],
      Array.from({ length: 30 }, (_, i) => ({ label: `서류${i}`, obtained: i % 2 === 0, memo: '' })),
      [{ label: 'a'.repeat(100), obtained: true, memo: 'm'.repeat(500) }],
      EVIDENCE,
    ];
    for (const evidence of good) {
      const { error } = await insertWith(evidence);
      expect(error, JSON.stringify(evidence).slice(0, 60)).toBeNull();
    }
    await sql`delete from public.agreement_items where version_id = ${versionId}::uuid`;
  });

  it('모양이 틀린 evidence로의 UPDATE도 거부하고 행은 그대로다', async () => {
    const { data, error } = await insertWith(EVIDENCE);
    expect(error).toBeNull();
    const id = (data as { id: string }[])[0]!.id;
    for (const [name, evidence] of BAD) {
      const upd = await user.client.from('agreement_items').update({ evidence }).eq('id', id);
      expect(upd.error?.code, name).toBe('23514');
    }
    expect((await itemRows(versionId))[0]!.evidence).toEqual(EVIDENCE);
  });

  it('agreement_evidence_is_valid는 immutable·security invoker다', async () => {
    const rows = await sql<{ provolatile: string; prosecdef: boolean }[]>`
      select p.provolatile, p.prosecdef from pg_proc p join pg_namespace n on n.oid = p.pronamespace
       where n.nspname = 'public' and p.proname = 'agreement_evidence_is_valid'`;
    expect(rows).toEqual([{ provolatile: 'i', prosecdef: false }]);
  });
});

// ─── (c) 확정 잠금 증빙 예외 ─────────────────────────────────

describe('(c) 확정 버전 편성 항목 — 증빙 체크·메모만 통과 (AV-2, S-1)', () => {
  let f: Fixture;
  let versionId: string;
  let itemId: string;

  beforeAll(async () => {
    f = await newFixture('Phase 26 증빙 잠금');
    const v = await createVersion(f.projectId, {
      p_lines: [
        { year_id: f.year1Id, category: 'material', subcategory_code: 'material_purchase', axis: 'cash', amount: 5000000 },
      ],
      p_participants: [
        {
          member_id: f.memberId, year_id: f.year1Id, participation_rate: 50, months: 12,
          annual_salary: 60000000, personnel_cash: 30000000, personnel_in_kind: 0, role: '',
        },
      ],
      p_gov_cash: { [f.year1Id]: 35000000 },
      p_items: [item(f.year1Id)],
    });
    versionId = v.versionId;
    itemId = (await itemRows(versionId))[0]!.id;
    await confirm(versionId);
  });

  function update(patch: Record<string, unknown>) {
    return user.client.from('agreement_items').update(patch).eq('id', itemId);
  }

  it('체크 해제·메모 변경은 통과하고 저장된다 (version은 set_updated_meta가 올린다)', async () => {
    const before = (await itemRows(versionId))[0]!;
    const next = [
      { label: '견적서', obtained: false, memo: '2개사 — 재발행 요청' },
      { label: '비교견적서', obtained: true, memo: '1개사' },
    ];
    const { error } = await update({ evidence: next });
    expect(error).toBeNull();
    const after = (await itemRows(versionId))[0]!;
    expect(after.evidence).toEqual(next);
    expect(Number(after.version)).toBe(Number(before.version) + 1);
    expect({ ...after, evidence: null, version: null }).toEqual({ ...before, evidence: null, version: null });
  });

  it('증빙 라벨 변경(이름·추가·삭제·순서)은 거부하고 행은 그대로다', async () => {
    const before = await itemRows(versionId);
    const current = before[0]!.evidence as typeof EVIDENCE;
    const cases: [string, unknown][] = [
      ['이름 변경', [{ ...current[0]!, label: '견적서(갱신)' }, current[1]]],
      ['추가', [...current, { label: '계약서', obtained: false, memo: '' }]],
      ['삭제', [current[0]]],
      ['순서', [current[1], current[0]]],
      ['비움', []],
    ];
    for (const [name, evidence] of cases) {
      const { error } = await update({ evidence });
      expect(error?.message, name).toMatch(LOCKED);
    }
    expect(await itemRows(versionId)).toEqual(before);
  });

  it('다른 컬럼 변경은 증빙과 함께든 혼자든 거부한다', async () => {
    const before = await itemRows(versionId);
    const current = before[0]!.evidence as typeof EVIDENCE;
    const patches: Record<string, unknown>[] = [
      { name: '다른 장비' },
      { amount: 1 },
      { quantity: 2 },
      { quantity: null },
      { kind: 'material' },
      { year_id: f.year2Id },
      { amount: 1, evidence: current.map((e) => ({ ...e, memo: '함께 바꿈' })) },
    ];
    for (const patch of patches) {
      const { error } = await update(patch);
      expect(error?.message, JSON.stringify(patch)).toMatch(LOCKED);
    }
    expect(await itemRows(versionId)).toEqual(before);
  });

  it('version_id 변경은 이전처럼 거부한다', async () => {
    const other = await newFixture('Phase 26 증빙 잠금 — 다른 버전');
    const v2 = await createVersion(other.projectId);
    const { error } = await update({ version_id: v2.versionId });
    expect(error?.message).toMatch(/협약 예산 내용을 다른 버전으로 옮길 수 없습니다/);
  });

  it('확정 버전 아래 INSERT는 거부한다', async () => {
    const before = await itemRows(versionId);
    const { error } = await user.client
      .from('agreement_items')
      .insert({ ...item(f.year1Id, { name: '추가 장비' }), version_id: versionId });
    expect(error?.message).toMatch(LOCKED);
    expect(await itemRows(versionId)).toEqual(before);
  });

  it('다른 3테이블은 값이 같은 UPDATE도 이전처럼 거부한다 — 예외는 편성 항목뿐', async () => {
    const lines = await user.client.from('agreement_lines').update({ amount: 5000000 }).eq('version_id', versionId);
    expect(lines.error?.message).toMatch(LOCKED);
    const parts = await user.client
      .from('agreement_participants')
      .update({ personnel_cash: 30000000 })
      .eq('version_id', versionId);
    expect(parts.error?.message).toMatch(LOCKED);
    const gov = await user.client
      .from('agreement_gov_support')
      .update({ gov_cash: 35000000 })
      .eq('version_id', versionId);
    expect(gov.error?.message).toMatch(LOCKED);
    const insLine = await user.client.from('agreement_lines').insert({
      version_id: versionId, year_id: f.year2Id, category: 'material',
      subcategory_code: 'material_purchase', axis: 'cash', amount: 1,
    });
    expect(insLine.error?.message).toMatch(LOCKED);
  });

  it('작성 중 버전은 라벨·다른 컬럼 변경이 전부 된다', async () => {
    const draft = await newFixture('Phase 26 증빙 작성 중');
    const v = await createVersion(draft.projectId, { p_items: [item(draft.year1Id)] });
    const id = (await itemRows(v.versionId))[0]!.id;
    const { error } = await user.client
      .from('agreement_items')
      .update({
        name: '바뀐 장비', amount: 1000, quantity: null, kind: 'material', year_id: draft.year2Id,
        evidence: [{ label: '계약서', obtained: true, memo: '' }],
      })
      .eq('id', id);
    expect(error).toBeNull();
    expect((await itemRows(v.versionId))[0]).toMatchObject({
      name: '바뀐 장비', amount: '1000', quantity: null, kind: 'material', year_id: draft.year2Id,
      evidence: [{ label: '계약서', obtained: true, memo: '' }],
    });
  });

  it('확정 버전 편성 항목 DELETE는 트리거가 막지 않는다 (액션이 RULE로 거부 — S-1)', async () => {
    const { error } = await user.client.from('agreement_items').delete().eq('id', itemId);
    expect(error).toBeNull();
    expect(await itemRows(versionId)).toEqual([]);
  });
});

// ─── (d) create_agreement_version p_items ────────────────────

describe('(d) create_agreement_version p_items (§9, AV-6 ③, S-14)', () => {
  it('편성 항목을 저장하고 반환에 items 건수를 싣는다. 이름·증빙 생략은 \'\'·[]', async () => {
    const f = await newFixture('Phase 26 create p_items');
    const v = await createVersion(f.projectId, {
      p_items: [
        item(f.year1Id),
        { year_id: f.year2Id, kind: 'material', name: '시약', amount: 0, quantity: 2.5, evidence: [] },
        { year_id: f.year2Id, kind: 'outsourcing', amount: 7000000, quantity: null },
      ],
    });
    expect(v).toMatchObject({ order: 1, lines: 0, participants: 0, govSupport: 0, items: 3 });
    const rows = (await itemRows(v.versionId)).map(({ id: _id, version: _v, ...rest }) => rest);
    expect(rows).toEqual([
      { year_id: f.year2Id, kind: 'outsourcing', name: '', amount: '7000000', quantity: null, evidence: [] },
      { year_id: f.year1Id, kind: 'equipment', name: '분석 장비', amount: '33000000', quantity: '1', evidence: EVIDENCE },
      { year_id: f.year2Id, kind: 'material', name: '시약', amount: '0', quantity: '2.5', evidence: [] },
    ]);
  });

  it('p_items를 생략하면 0건 — 빈 버전·붙임4 가져오기 경로', async () => {
    const f = await newFixture('Phase 26 create p_items 생략');
    const v = await createVersion(f.projectId);
    expect(v.items).toBe(0);
    expect(await itemRows(v.versionId)).toEqual([]);
  });

  it('모양·금액·수량·종류가 틀리면 사람이 읽는 메시지로 거부하고 버전을 만들지 않는다', async () => {
    const f = await newFixture('Phase 26 create p_items 검증');
    const other = await newFixture('Phase 26 create p_items 다른 과제');
    const y = f.year1Id;
    const cases: [unknown, RegExp][] = [
      [{}, /편성 항목 목록이 배열이 아닙니다/],
      ['[]', /배열이 아닙니다/],
      [[1], /편성 항목이 객체가 아닙니다/],
      [[item(y, { kind: 'lease' })], /편성 항목 종류는 장비·재료·외주 중 하나여야 합니다/],
      [[{ year_id: y, amount: 1 }], /편성 항목 종류/],
      [[item(y, { amount: -1 })], /편성 항목 금액은 0 이상의 원 단위 정수여야 합니다/],
      [[item(y, { amount: 1.5 })], /0 이상의 원 단위 정수/],
      [[item(y, { amount: '1000' })], /0 이상의 원 단위 정수/],
      [[item(y, { amount: null })], /0 이상의 원 단위 정수/],
      [[{ year_id: y, kind: 'equipment', name: 'x' }], /0 이상의 원 단위 정수/],
      [[item(y, { quantity: -1 })], /편성 항목 수량은 비우거나 0 이상의 수여야 합니다/],
      [[item(y, { quantity: '1' })], /편성 항목 수량/],
      [[item(y, { name: 3 })], /품명은 문자열, 증빙은 배열이어야 합니다/],
      [[item(y, { evidence: {} })], /품명은 문자열, 증빙은 배열/],
      [[item(other.year1Id)], /이 과제에 속하지 않은 연차입니다/],
      [[item(y, { year_id: null })], /이 과제에 속하지 않은 연차입니다/],
    ];
    for (const [items, message] of cases) {
      const { error } = await createVersionRaw(f.projectId, { p_items: items });
      expect(error?.message, JSON.stringify(items)).toMatch(message);
      expect(error?.code, JSON.stringify(items)).toBe('P0001');
    }
    // 증빙 모양은 check가 막는다 — 트랜잭션이 통째로 되돌아간다
    const bad = await createVersionRaw(f.projectId, {
      p_items: [item(y, { evidence: [{ label: '견적서', obtained: 'yes', memo: '' }] })],
    });
    expect(bad.error?.code).toBe('23514');
    const left = await sql`select 1 from public.agreement_versions where project_id = ${f.projectId}::uuid`;
    expect(left).toEqual([]);
  });

  it('옛 6인자 시그니처는 pg_proc에 없다 — 7인자 하나, authenticated만 실행', async () => {
    const rows = await sql<{ args: string; auth: boolean; anon: boolean }[]>`
      select pg_get_function_identity_arguments(p.oid) as args,
             has_function_privilege('authenticated', p.oid, 'execute') as auth,
             has_function_privilege('anon', p.oid, 'execute') as anon
        from pg_proc p join pg_namespace n on n.oid = p.pronamespace
       where n.nspname = 'public' and p.proname = 'create_agreement_version'`;
    expect(rows).toEqual([
      {
        args:
          'p_project_id uuid, p_kind text, p_name text, p_lines jsonb, p_participants jsonb, ' +
          'p_gov_cash jsonb, p_items jsonb',
        auth: true,
        anon: false,
      },
    ]);
  });

  it('clone_agreement_version은 편성 항목을 증빙째 복사한다 (재정의 없음)', async () => {
    const f = await newFixture('Phase 26 clone 편성 항목');
    const v1 = await createVersion(f.projectId, { p_items: [item(f.year1Id)] });
    await confirm(v1.versionId);
    const { data, error } = await user.client.rpc('clone_agreement_version', {
      p_source_id: v1.versionId,
      p_kind: 'amendment',
      p_name: '협약변경 1차',
    });
    expect(error).toBeNull();
    expect(data).toMatchObject({ items: 1 });
    const strip = (rows: ItemRow[]) => rows.map(({ id: _id, version: _v, ...rest }) => rest);
    const newId = (data as { versionId: string }).versionId;
    expect(strip(await itemRows(newId))).toEqual(strip(await itemRows(v1.versionId)));
  });
});

// ─── (e) 보안·publication·schema_version ─────────────────────

describe('(e) security invoker·publication·schema_version', () => {
  it('새·재정의 함수 중 security definer가 없다 (X-2)', async () => {
    const names = ['agreement_evidence_is_valid', 'agreement_child_guard', 'create_agreement_version'];
    const rows = await sql<{ proname: string; prosecdef: boolean }[]>`
      select p.proname, p.prosecdef from pg_proc p join pg_namespace n on n.oid = p.pronamespace
       where n.nspname = 'public' and p.proname in ${sql(names)}`;
    expect(rows.map((r) => r.proname).sort()).toEqual([...names].sort());
    expect(rows.filter((r) => r.prosecdef).map((r) => r.proname)).toEqual([]);
  });

  it('Realtime publication은 바뀌지 않았다 — agreement_items 구독 없음 (§8.5, S-11)', async () => {
    const rows = await sql<{ tablename: string }[]>`
      select tablename from pg_publication_tables
       where pubname = 'supabase_realtime' and schemaname = 'public'
         and tablename in ('agreement_gov_support', 'agreement_participants', 'agreement_items',
                           'agreement_versions', 'agreement_lines', 'budget_rules')`;
    expect(rows.map((r) => r.tablename).sort()).toEqual(['agreement_lines', 'agreement_versions']);
  });

  it('app_settings.schema_version = 7 유지 (§8.8)', async () => {
    const rows = await sql<{ v: number }[]>`select schema_version::int as v from public.app_settings`;
    expect(rows).toEqual([{ v: 7 }]);
  });

  it('agreement_items 가드 트리거는 그대로 BEFORE INSERT/UPDATE에 걸려 있다', async () => {
    const rows = await sql<{ tgname: string; tgenabled: string }[]>`
      select tgname, tgenabled from pg_trigger
       where tgrelid = 'public.agreement_items'::regclass and not tgisinternal order by tgname`;
    expect(rows).toEqual([
      { tgname: 'agreement_child_guard', tgenabled: 'O' },
      { tgname: 'set_updated_meta', tgenabled: 'O' },
    ]);
  });
});
