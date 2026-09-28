// lib/db/mapper.ts 단위 테스트 (SOT §5.1 N-9, N-3, N-13, §8.6)

import { describe, it, expect } from 'vitest';
import { dbToApp, appToDb, dbToAppArray } from '@/lib/db/mapper';
import {
  budgetExecutionRowSchema,
  deliverableRowSchema,
  importKindSchema,
  importSnapshotRowSchema,
  techTargetRowSchema,
} from '@/lib/db/schema';
import type { BudgetExecution, Deliverable, ImportSnapshot, TechTarget } from '@/types';

describe('mapper: snake_case ↔ camelCase 기본 변환', () => {
  it('DB row(snake) → 앱 객체(camel)', () => {
    const row = {
      id: 'a1',
      project_no: '2026-0-01234',
      program_name: '차세대 AI',
      contract_start_date: '2026-01-01',
      total_budget: 500_000_000,
      pm_member_id: 'm1',
      archived: false,
    };
    expect(dbToApp(row)).toEqual({
      id: 'a1',
      projectNo: '2026-0-01234',
      programName: '차세대 AI',
      contractStartDate: '2026-01-01',
      totalBudget: 500_000_000,
      pmMemberId: 'm1',
      archived: false,
    });
  });

  it('앱 객체(camel) → DB row(snake)', () => {
    const app = {
      projectId: 'p1',
      inKindAmount: 1_000,
      worldBestHolder: '미국/NIST',
      lastSeenAt: '2026-08-02T00:00:00+00:00',
    };
    expect(appToDb(app)).toEqual({
      project_id: 'p1',
      in_kind_amount: 1_000,
      world_best_holder: '미국/NIST',
      last_seen_at: '2026-08-02T00:00:00+00:00',
    });
  });

  it('세그먼트가 많은 실제 컬럼명도 왕복이 성립한다', () => {
    // 숫자 단독 세그먼트(line_2_total 등)는 camel에서 경계가 사라져 왕복 불가 —
    // 실제 스키마에 존재하지 않으며, 추가 시 매퍼 특례가 필요하다
    const row = {
      in_kind_amount: 1,
      world_best_holder: 'x',
      week_starts_on: 1,
      last_seen_at: 't',
    };
    expect(appToDb(dbToApp(row))).toEqual(row);
  });
});

describe('mapper: N-9 특례 sort_order ↔ order', () => {
  it('DB sort_order → 앱 order', () => {
    expect(dbToApp({ sort_order: 3 })).toEqual({ order: 3 });
  });

  it('앱 order → DB sort_order', () => {
    expect(appToDb({ order: 0 })).toEqual({ sort_order: 0 });
  });

  it('중첩 객체·배열 안의 sort_order에도 적용된다', () => {
    const row = {
      id: 'y1',
      sort_order: 1,
      tasks: [
        { id: 't1', sort_order: 0 },
        { id: 't2', sort_order: 1 },
      ],
    };
    expect(dbToApp(row)).toEqual({
      id: 'y1',
      order: 1,
      tasks: [
        { id: 't1', order: 0 },
        { id: 't2', order: 1 },
      ],
    });
  });
});

describe('mapper: jsonb 컬럼 내부 키는 변환하지 않는다 (N-3, N-13)', () => {
  const yearId = '550e8400-e29b-41d4-a716-446655440000';

  it('target_by_year의 yearId 키가 그대로 유지된다', () => {
    const row = { target_by_year: { [yearId]: 2 } };
    expect(dbToApp(row)).toEqual({ targetByYear: { [yearId]: 2 } });
  });

  it('내부에 언더스코어·대문자가 있는 키도 절대 건드리지 않는다', () => {
    // categoryAliases의 키는 엑셀 원문 라벨 — 무엇이든 올 수 있다
    const row = {
      category_aliases: { '인건비_내부': 'personnel', 'R&D Fee': 'activity' },
    };
    expect(dbToApp(row)).toEqual({
      categoryAliases: { '인건비_내부': 'personnel', 'R&D Fee': 'activity' },
    });
  });

  it('year_column_mappings 내부의 yearOrder(camel)가 양방향 모두 보존된다', () => {
    const app = {
      yearColumnMappings: [{ column: 'E', yearOrder: 0 }, { column: 'F', yearOrder: 1 }],
    };
    const db = appToDb(app);
    expect(db).toEqual({
      year_column_mappings: [{ column: 'E', yearOrder: 0 }, { column: 'F', yearOrder: 1 }],
    });
    expect(dbToApp(db as Record<string, unknown>)).toEqual(app);
  });

  it('앱 → DB 방향에서도 targetByYear 내부 키가 유지된다', () => {
    const app = { targetByYear: { [yearId]: 95.5 } };
    expect(appToDb(app)).toEqual({ target_by_year: { [yearId]: 95.5 } });
  });

  it('tags 문자열 배열은 그대로 통과한다', () => {
    const row = { tags: ['AI_모델', 'v2_후보'] };
    expect(dbToApp(row)).toEqual({ tags: ['AI_모델', 'v2_후보'] });
  });
});

describe('mapper: null·중첩·배열 케이스', () => {
  it('null 값이 보존된다', () => {
    const row = { parent_id: null, due_date: null, estimated_hours: null };
    expect(dbToApp(row)).toEqual({ parentId: null, dueDate: null, estimatedHours: null });
  });

  it('중첩 select 결과(임베드 배열)를 재귀 변환한다', () => {
    const row = {
      id: 'b1',
      planned_amount: 10_000_000,
      cash_amount: null,
      budget_executions: [
        { id: 'e1', budget_item_id: 'b1', amount: 500_000, created_at: '2026-08-01T00:00:00+00:00' },
      ],
    };
    expect(dbToApp(row)).toEqual({
      id: 'b1',
      plannedAmount: 10_000_000,
      cashAmount: null,
      budgetExecutions: [
        { id: 'e1', budgetItemId: 'b1', amount: 500_000, createdAt: '2026-08-01T00:00:00+00:00' },
      ],
    });
  });

  it('빈 객체·빈 배열을 그대로 처리한다', () => {
    expect(dbToApp({})).toEqual({});
    expect(dbToApp({ tags: [], target_by_year: {} })).toEqual({ tags: [], targetByYear: {} });
    expect(dbToAppArray([])).toEqual([]);
  });

  it('dbToAppArray는 행마다 변환한다', () => {
    expect(dbToAppArray([{ sort_order: 0 }, { sort_order: 1 }])).toEqual([
      { order: 0 },
      { order: 1 },
    ]);
  });
});

describe('mapper: 왕복(round-trip) 동일성', () => {
  it('앱 → DB → 앱이 원본과 같다 (Task 형태)', () => {
    const app = {
      id: 't1',
      projectId: 'p1',
      yearId: 'y1',
      parentId: null,
      order: 2,
      title: '데이터 수집',
      status: 'in_progress',
      progressMode: 'manual',
      manualProgress: 40,
      estimatedHours: 80,
      actualHours: null,
      importance: 4,
      urgencyMode: 'auto',
      tags: ['1차년도_핵심'],
      version: 3,
      createdBy: 'u1',
      updatedBy: null,
    };
    expect(dbToApp(appToDb(app))).toEqual(app);
  });

  it('DB → 앱 → DB가 원본과 같다 (ImportProfile 형태, jsonb 포함)', () => {
    const row = {
      id: 'ip1',
      name: '산자부 사업비 총괄표',
      kind: 'budget_plan',
      ministry: '산업통상자원부',
      project_id: null,
      sheet_name: null,
      header_row: 3,
      data_start_row: 5,
      orientation: 'row',
      label_columns: ['B', 'C', 'D'],
      year_column_mappings: [{ column: 'E', yearOrder: 0 }],
      category_aliases: { '연구 재료비': 'material' },
      amount_unit: 1000,
      skip_row_patterns: ['소계', '합계'],
      last_used_at: null,
      use_count: 7,
    };
    expect(appToDb(dbToApp(row))).toEqual(row);
  });
});

// ─── Phase 20: 집행 내역 7필드와 수행 양식 스냅샷 (§5.12, §6.16 IN-10·IN-14) ─────

const UUID_EXEC = '11111111-1111-4111-8111-111111111111';
const UUID_ITEM = '22222222-2222-4222-8222-222222222222';
const UUID_MEMBER = '33333333-3333-4333-8333-333333333333';
const UUID_DETAIL = '44444444-4444-4444-8444-444444444444';
const UUID_PROJECT = '55555555-5555-4555-8555-555555555555';
const UUID_SNAPSHOT = '66666666-6666-4666-8666-666666666666';
const UUID_ADDED = '77777777-7777-4777-8777-777777777777';

function executionRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: UUID_EXEC,
    version: 2,
    created_at: '2026-09-28T00:00:00+00:00',
    updated_at: '2026-09-28T00:00:00+00:00',
    created_by: null,
    updated_by: null,
    budget_item_id: UUID_ITEM,
    date: '2026-05-10',
    amount: 1_500_000,
    description: '책임연구원 5월 인건비',
    note: '',
    subcategory_code: 'internal',
    spec: '월 지급',
    unit_price: 60_000_000,
    factors: [
      { label: '참여율(%)', value: 30, isPercent: true },
      { label: '참여기간(월)', value: 1, isPercent: false },
    ],
    axis: 'cash',
    member_id: UUID_MEMBER,
    detail_id: UUID_DETAIL,
    ...overrides,
  };
}

describe('mapper: BudgetExecution 내역 필드 (§5.12 Phase 20)', () => {
  it('snake 컬럼 7종이 camel 필드로 바뀐다', () => {
    const app = dbToApp<BudgetExecution>(budgetExecutionRowSchema.parse(executionRow()));
    expect(app).toMatchObject({
      subcategoryCode: 'internal',
      spec: '월 지급',
      unitPrice: 60_000_000,
      axis: 'cash',
      memberId: UUID_MEMBER,
      detailId: UUID_DETAIL,
    });
    expect(app).not.toHaveProperty('member_id');
    expect(app).not.toHaveProperty('unit_price');
  });

  it('factors 내부의 isPercent는 양방향 모두 camelCase 그대로다 (N-3)', () => {
    const app = dbToApp<BudgetExecution>(executionRow());
    expect(app.factors).toEqual([
      { label: '참여율(%)', value: 30, isPercent: true },
      { label: '참여기간(월)', value: 1, isPercent: false },
    ]);
    const back = appToDb(app as unknown as Record<string, unknown>);
    expect(back.factors).toEqual(executionRow().factors);
    expect(JSON.stringify(back)).not.toContain('is_percent');
  });

  it('앱 → DB에서 memberId·detailId·subcategoryCode·unitPrice가 snake로 간다', () => {
    const db = appToDb({ memberId: UUID_MEMBER, detailId: null, subcategoryCode: null, unitPrice: 0 });
    expect(db).toEqual({ member_id: UUID_MEMBER, detail_id: null, subcategory_code: null, unit_price: 0 });
  });

  it('DB → 앱 → DB 왕복이 원본과 같다', () => {
    const row = executionRow();
    expect(appToDb(dbToApp(row))).toEqual(row);
  });

  it('내역이 비어 있는 기존 집행(null·빈 spec)도 스키마를 통과한다', () => {
    const row = executionRow({
      subcategory_code: null,
      spec: '',
      unit_price: null,
      factors: null,
      axis: null,
      member_id: null,
      detail_id: null,
    });
    expect(budgetExecutionRowSchema.safeParse(row).success).toBe(true);
  });

  it('새 컬럼이 없는 응답(마이그레이션 누락)은 스키마에서 거부된다', () => {
    const row = executionRow();
    delete row.spec;
    delete row.member_id;
    expect(budgetExecutionRowSchema.safeParse(row).success).toBe(false);
  });

  it('factors 원소가 isPercent를 빠뜨리면 거부된다 — is_percent로 저장된 행도 마찬가지다', () => {
    const row = executionRow({ factors: [{ label: '수량', value: 2, is_percent: false }] });
    expect(budgetExecutionRowSchema.safeParse(row).success).toBe(false);
  });

  it('axis는 cash/in_kind/null만 받는다', () => {
    expect(budgetExecutionRowSchema.safeParse(executionRow({ axis: 'in_kind' })).success).toBe(true);
    expect(budgetExecutionRowSchema.safeParse(executionRow({ axis: 'unassigned' })).success).toBe(false);
  });
});

describe('schema: ImportKind와 수행 양식 스냅샷 (§5.12.1, IN-14)', () => {
  it('ImportKind는 네 값을 받는다', () => {
    for (const kind of ['budget_plan', 'budget_detail', 'execution_form', 'goal_form']) {
      expect(importKindSchema.safeParse(kind).success).toBe(true);
    }
    expect(importKindSchema.safeParse('execution').success).toBe(false);
  });

  function snapshotRow(snapshot: Record<string, unknown>): Record<string, unknown> {
    return {
      id: UUID_SNAPSHOT,
      version: 1,
      created_at: '2026-09-28T00:00:00+00:00',
      updated_at: '2026-09-28T00:00:00+00:00',
      created_by: null,
      updated_by: null,
      project_id: UUID_PROJECT,
      snapshot,
    };
  }

  const executionSnapshot = {
    schemaVersion: 1,
    projectId: UUID_PROJECT,
    capturedAt: '2026-09-28T00:00:00+00:00',
    kind: 'execution_form',
    source: { fileName: '수행양식.xlsx', sheetName: '사업비', profileId: null, fileHash: 'abc' },
    items: [],
    executions: { added: [UUID_ADDED], before: [executionRow()] },
  };

  it('수행 스냅샷 행이 Zod를 통과하고, before 행은 snake_case 원본 그대로 남는다', () => {
    const parsed = importSnapshotRowSchema.safeParse(snapshotRow(executionSnapshot));
    expect(parsed.success).toBe(true);
    const app = dbToApp<ImportSnapshot>(parsed.data as Record<string, unknown>);
    expect(app.snapshot.kind).toBe('execution_form');
    expect(app.snapshot.executions?.added).toEqual([UUID_ADDED]);
    // 복원은 RPC가 이 원본으로 하므로 키가 변환되면 안 된다 (N-3)
    expect(app.snapshot.executions?.before[0]).toEqual(executionRow());
  });

  it('before 행은 식별 키(id·budget_item_id·version)만 요구한다 — 이후 컬럼 추가로 옛 스냅샷이 깨지지 않는다', () => {
    const snapshot = {
      ...executionSnapshot,
      executions: { added: [], before: [{ id: UUID_EXEC, budget_item_id: UUID_ITEM, version: 3 }] },
    };
    expect(importSnapshotRowSchema.safeParse(snapshotRow(snapshot)).success).toBe(true);
    const broken = {
      ...executionSnapshot,
      executions: { added: [], before: [{ id: UUID_EXEC, version: 3 }] },
    };
    expect(importSnapshotRowSchema.safeParse(snapshotRow(broken)).success).toBe(false);
  });

  it('기존 총괄표(kind 없음)·산출근거 스냅샷은 그대로 통과한다', () => {
    const plan = { ...executionSnapshot, kind: undefined, executions: undefined };
    const detail = { ...executionSnapshot, kind: 'budget_detail', executions: undefined };
    expect(importSnapshotRowSchema.safeParse(snapshotRow(plan)).success).toBe(true);
    expect(importSnapshotRowSchema.safeParse(snapshotRow(detail)).success).toBe(true);
  });

  it('모르는 kind는 거부한다 — 조용히 총괄표로 취급하지 않는다', () => {
    const unknown = { ...executionSnapshot, kind: 'something_else' };
    expect(importSnapshotRowSchema.safeParse(snapshotRow(unknown)).success).toBe(false);
  });
});

// ─── Phase 21: 목표 새 필드와 목표 양식 스냅샷 (§5.8·§5.9, N-9, GF-11) ─────

describe('mapper: N-9 특례 group_name ↔ group (tech_targets, Phase 21)', () => {
  it('DB group_name → 앱 group', () => {
    expect(dbToApp({ group_name: '디지털 트윈 플랫폼' })).toEqual({ group: '디지털 트윈 플랫폼' });
  });

  it('앱 group → DB group_name', () => {
    expect(appToDb({ group: '' })).toEqual({ group_name: '' });
  });

  it('jsonb 내부의 group·group_name 키는 바꾸지 않는다 (N-3)', () => {
    const row = { target_by_year: { group_name: 1 }, snapshot: { group: 'x' } };
    expect(dbToApp(row)).toEqual({ targetByYear: { group_name: 1 }, snapshot: { group: 'x' } });
    expect(appToDb({ targetByYear: { group: 1 } })).toEqual({ target_by_year: { group: 1 } });
  });
});

const UUID_TT = '88888888-8888-4888-8888-888888888888';
const UUID_DV = '99999999-9999-4999-8999-999999999999';
const UUID_YEAR = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

function goalBase(id: string): Record<string, unknown> {
  return {
    id,
    version: 1,
    created_at: '2026-09-29T00:00:00+00:00',
    updated_at: '2026-09-29T00:00:00+00:00',
    created_by: null,
    updated_by: null,
    project_id: UUID_PROJECT,
  };
}

function techTargetRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    ...goalBase(UUID_TT),
    name: '객체 인식 정확도',
    group_name: '디지털 트윈 자율안전관리 플랫폼',
    unit: '%',
    direction: 'higher_better',
    weight: 12.5,
    target_value: 90,
    target_by_year: { [UUID_YEAR]: 80 },
    baseline_domestic: null,
    world_best: 95,
    world_best_holder: '미국',
    measure_method: 'certified_lab',
    measure_description: '공인시험',
    standard_basis: 'KS X 0000',
    basis_rationale: '국내 최고 수준 대비',
    evaluation_environment: '실증 현장',
    note: '[원문] 목표: LOD 2.5',
    org_id: null,
    sort_order: 0,
    ...overrides,
  };
}

function deliverableRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    ...goalBase(UUID_DV),
    type: 'sw_registration',
    name: 'SW 등록',
    unit: '건',
    weight: 7.5,
    target_total: 2,
    target_by_year: { [UUID_YEAR]: 1 },
    org_id: null,
    evidence_method: 'SW 등록증',
    note: '',
    sort_order: 1,
    ...overrides,
  };
}

describe('mapper·schema: TechTarget·Deliverable 새 필드 (§5.8·§5.9 Phase 21)', () => {
  it('tech_targets 행이 스키마를 통과하고 새 컬럼이 camel 필드로 바뀐다', () => {
    const app = dbToApp<TechTarget>(techTargetRowSchema.parse(techTargetRow()));
    expect(app).toMatchObject({
      group: '디지털 트윈 자율안전관리 플랫폼',
      standardBasis: 'KS X 0000',
      basisRationale: '국내 최고 수준 대비',
      evaluationEnvironment: '실증 현장',
      note: '[원문] 목표: LOD 2.5',
      weight: 12.5,
      order: 0,
    });
    expect(app).not.toHaveProperty('groupName');
    expect(app).not.toHaveProperty('group_name');
    expect(app.targetByYear).toEqual({ [UUID_YEAR]: 80 });
  });

  it('tech_targets DB → 앱 → DB 왕복이 원본과 같다', () => {
    const row = techTargetRow();
    expect(appToDb(dbToApp(row))).toEqual(row);
  });

  it('deliverables 행이 스키마를 통과하고 weight·evidenceMethod가 온다 (소수 가중치 허용)', () => {
    const app = dbToApp<Deliverable>(deliverableRowSchema.parse(deliverableRow()));
    expect(app).toMatchObject({ weight: 7.5, evidenceMethod: 'SW 등록증', order: 1 });
    expect(appToDb(dbToApp(deliverableRow()))).toEqual(deliverableRow());
  });

  it('새 컬럼이 없는 응답(마이그레이션 누락)은 거부된다', () => {
    const tt = techTargetRow();
    delete tt.group_name;
    expect(techTargetRowSchema.safeParse(tt).success).toBe(false);
    const dv = deliverableRow();
    delete dv.evidence_method;
    expect(deliverableRowSchema.safeParse(dv).success).toBe(false);
  });
});

describe('schema: 목표 양식 스냅샷 (§5.12.1, GF-11)', () => {
  function snapshotRow(snapshot: Record<string, unknown>): Record<string, unknown> {
    return {
      id: UUID_SNAPSHOT,
      version: 1,
      created_at: '2026-09-29T00:00:00+00:00',
      updated_at: '2026-09-29T00:00:00+00:00',
      created_by: null,
      updated_by: null,
      project_id: UUID_PROJECT,
      snapshot,
    };
  }

  const goalSnapshot = {
    schemaVersion: 1,
    projectId: UUID_PROJECT,
    capturedAt: '2026-09-29T00:00:00+00:00',
    kind: 'goal_form',
    source: { fileName: '목표양식.xlsx', sheetName: '', profileId: null, fileHash: 'def' },
    items: [],
    // commit_goal_form이 쓰는 형태 — 테이블 이름별. 행 형태는 검증하지 않는다
    goals: {
      added: { deliverables: [UUID_ADDED], deliverable_achievements: [], tech_targets: [], tech_target_records: [] },
      before: {
        deliverables: [deliverableRow()],
        tech_targets: [techTargetRow()],
        achievement_members: [{ achievement_id: UUID_EXEC, member_id: UUID_MEMBER }],
      },
      deleted: { deliverables: [UUID_DV], deliverable_achievements: [], tech_targets: [], tech_target_records: [] },
    },
  };

  it('goal_form 스냅샷 행이 Zod를 통과하고, before 행은 snake_case 원본 그대로 남는다', () => {
    const parsed = importSnapshotRowSchema.safeParse(snapshotRow(goalSnapshot));
    expect(parsed.success).toBe(true);
    const app = dbToApp<ImportSnapshot>(parsed.data as Record<string, unknown>);
    expect(app.snapshot.kind).toBe('goal_form');
    expect(app.snapshot.goals?.added.deliverables).toEqual([UUID_ADDED]);
    expect(app.snapshot.goals?.deleted.deliverables).toEqual([UUID_DV]);
    // group_name이 group으로 바뀌면 나중의 되돌리기가 원본을 잃는다 (N-3)
    expect(app.snapshot.goals?.before.tech_targets?.[0]).toEqual(techTargetRow());
  });

  it('goals에 모르는 키가 더 있어도 통과하고 보존된다 (looseObject)', () => {
    const snapshot = { ...goalSnapshot, goals: { ...goalSnapshot.goals, links: [] } };
    const parsed = importSnapshotRowSchema.safeParse(snapshotRow(snapshot));
    expect(parsed.success).toBe(true);
    expect((parsed.data?.snapshot.goals as Record<string, unknown>).links).toEqual([]);
  });

  it('goals가 added·before·deleted 구조를 빠뜨리면 거부한다', () => {
    const { deleted: _deleted, ...noDeleted } = goalSnapshot.goals;
    void _deleted;
    const broken = { ...goalSnapshot, goals: noDeleted };
    expect(importSnapshotRowSchema.safeParse(snapshotRow(broken)).success).toBe(false);
    const badAdded = { ...goalSnapshot, goals: { ...goalSnapshot.goals, added: { deliverables: ['not-uuid'] } } };
    expect(importSnapshotRowSchema.safeParse(snapshotRow(badAdded)).success).toBe(false);
    // 평면 배열(테이블 키 없음)은 RPC가 쓰는 형태가 아니다
    const flat = { ...goalSnapshot, goals: { ...goalSnapshot.goals, added: [UUID_ADDED] } };
    expect(importSnapshotRowSchema.safeParse(snapshotRow(flat)).success).toBe(false);
  });
});
