// lib/db/mapper.ts 단위 테스트 (SOT §5.1 N-9, N-3, N-13, §8.6)

import { describe, it, expect } from 'vitest';
import { dbToApp, appToDb, dbToAppArray } from '@/lib/db/mapper';
import {
  agreementGovSupportRowSchema,
  agreementItemRowSchema,
  agreementLineRowSchema,
  agreementParticipantRowSchema,
  agreementVersionRowSchema,
  deliverableRowSchema,
  importKindSchema,
  importSnapshotRowSchema,
  techTargetRowSchema,
  yearRowSchema,
} from '@/lib/db/schema';
import type {
  AgreementGovSupport,
  AgreementItem,
  AgreementLine,
  AgreementParticipant,
  AgreementVersion,
  Deliverable,
  ImportSnapshot,
  TechTarget,
  Year,
} from '@/types';

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
      budget_details: [
        { id: 'd1', unit_price: 500_000, created_at: '2026-08-01T00:00:00+00:00' },
      ],
    };
    expect(dbToApp(row)).toEqual({
      id: 'b1',
      plannedAmount: 10_000_000,
      cashAmount: null,
      budgetDetails: [
        { id: 'd1', unitPrice: 500_000, createdAt: '2026-08-01T00:00:00+00:00' },
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

const UUID_ROW = '11111111-1111-4111-8111-111111111111';
const UUID_MEMBER = '33333333-3333-4333-8333-333333333333';
const UUID_PROJECT = '55555555-5555-4555-8555-555555555555';
const UUID_SNAPSHOT = '66666666-6666-4666-8666-666666666666';
const UUID_ADDED = '77777777-7777-4777-8777-777777777777';

describe('schema: ImportKind와 스냅샷 kind (§5.12.1)', () => {
  // Phase 23(S-1): 수행 양식 종류가 빠져 세 값만 남는다 — options 전체를 대조해 옛 값이 되살아나면 깨진다
  it('ImportKind는 세 값만 받는다', () => {
    expect(importKindSchema.options).toEqual(['budget_plan', 'budget_detail', 'goal_form']);
    expect(importKindSchema.safeParse('unknown_kind').success).toBe(false);
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

  const planSnapshot = {
    schemaVersion: 1,
    projectId: UUID_PROJECT,
    capturedAt: '2026-09-28T00:00:00+00:00',
    source: { fileName: '총괄표.xlsx', sheetName: '사업비', profileId: null, fileHash: 'abc' },
    items: [],
  };

  it('총괄표(kind 없음)·산출근거 스냅샷은 통과한다', () => {
    const detail = { ...planSnapshot, kind: 'budget_detail' };
    expect(importSnapshotRowSchema.safeParse(snapshotRow(planSnapshot)).success).toBe(true);
    expect(importSnapshotRowSchema.safeParse(snapshotRow(detail)).success).toBe(true);
  });

  it('모르는 kind는 거부한다 — 조용히 총괄표로 취급하지 않는다', () => {
    const unknown = { ...planSnapshot, kind: 'something_else' };
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
        achievement_members: [{ achievement_id: UUID_ROW, member_id: UUID_MEMBER }],
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

// ─── §5.21~§5.24 협약 예산 (Phase 24) ────────────────────────

const UUID_AV = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const UUID_AL = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const UUID_AP = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const UUID_AI = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';

function agreementBase(id: string): Record<string, unknown> {
  return {
    id,
    version: 3,
    created_at: '2026-10-01T00:00:00+00:00',
    updated_at: '2026-10-01T00:00:00+00:00',
    created_by: null,
    updated_by: null,
  };
}

function agreementVersionRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    ...agreementBase(UUID_AV),
    project_id: UUID_PROJECT,
    kind: 'amendment',
    name: '협약변경 1차',
    base_date: '2026-10-01',
    change_reason: '재료비 연차 간 이동',
    notice_type: 'approval',
    iris_requested_at: '2026-09-20',
    note: '',
    status: 'confirmed',
    confirmed_at: '2026-10-02T09:00:00+00:00',
    sort_order: 2,
    ...overrides,
  };
}

function agreementLineRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    ...agreementBase(UUID_AL),
    version_id: UUID_AV,
    year_id: UUID_YEAR,
    category: 'activity',
    subcategory_code: 'activity_travel_intl',
    axis: 'in_kind',
    amount: 9_007_199_254_740_991, // bigint가 JSON 숫자로 올 때 안전 정수 상한까지 정수로 남는다
    ...overrides,
  };
}

function agreementParticipantRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    ...agreementBase(UUID_AP),
    version_id: UUID_AV,
    member_id: UUID_MEMBER,
    year_id: UUID_YEAR,
    participation_rate: 12.5,
    months: 6,
    annual_salary: 60_000_000,
    personnel_cash: 3_750_000,
    personnel_in_kind: 0,
    role: '참여연구원',
    ...overrides,
  };
}

function agreementItemRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    ...agreementBase(UUID_AI),
    version_id: UUID_AV,
    year_id: UUID_YEAR,
    kind: 'equipment',
    name: '고속 카메라',
    amount: 33_000_000,
    quantity: 1.5,
    evidence: [
      { label: '견적서', obtained: true, memo: 'A사' },
      { label: '비교견적서', obtained: false, memo: '' },
    ],
    ...overrides,
  };
}

describe('mapper·schema: 협약 예산 4종 (§5.21~§5.24 Phase 24)', () => {
  it('agreement_versions: sort_order ↔ order, 메타 7개·confirmedAt이 camel 필드로 온다', () => {
    const app = dbToApp<AgreementVersion>(agreementVersionRowSchema.parse(agreementVersionRow()));
    const expected: AgreementVersion = {
      id: UUID_AV,
      version: 3,
      createdAt: '2026-10-01T00:00:00+00:00',
      updatedAt: '2026-10-01T00:00:00+00:00',
      createdBy: null,
      updatedBy: null,
      projectId: UUID_PROJECT,
      kind: 'amendment',
      name: '협약변경 1차',
      baseDate: '2026-10-01',
      changeReason: '재료비 연차 간 이동',
      noticeType: 'approval',
      irisRequestedAt: '2026-09-20',
      note: '',
      status: 'confirmed',
      confirmedAt: '2026-10-02T09:00:00+00:00',
      order: 2,
    };
    // toEqual 전체 비교 — 삭제된 officialDocNo·irisApprovedAt 같은 여분 필드가 있으면 깨진다
    expect(app).toEqual(expected);
    expect(app).not.toHaveProperty('sortOrder');
    expect(appToDb({ order: 7 })).toEqual({ sort_order: 7 });
  });

  it('agreement_versions DB → 앱 → DB 왕복 (작성 중: null 메타·confirmed_at null)', () => {
    const row = agreementVersionRow({
      status: 'draft',
      confirmed_at: null,
      notice_type: null,
      base_date: null,
      iris_requested_at: null,
    });
    expect(agreementVersionRowSchema.safeParse(row).success).toBe(true);
    expect(appToDb(dbToApp(row))).toEqual(row);
  });

  it('agreement_lines: subcategory_code·bigint 금액 왕복, 금액은 number 정수', () => {
    const row = agreementLineRow();
    const app = dbToApp<AgreementLine>(agreementLineRowSchema.parse(row));
    expect(app).toMatchObject({
      versionId: UUID_AV,
      yearId: UUID_YEAR,
      category: 'activity',
      subcategoryCode: 'activity_travel_intl',
      axis: 'in_kind',
    });
    expect(typeof app.amount).toBe('number');
    expect(Number.isSafeInteger(app.amount)).toBe(true);
    expect(appToDb(dbToApp(row))).toEqual(row);
  });

  it('agreement_lines: default 세목은 모든 비목에서 통과한다(세목 목록 검증은 액션 Zod 몫)', () => {
    const row = agreementLineRow({ category: 'personnel', subcategory_code: 'default' });
    expect(agreementLineRowSchema.safeParse(row).success).toBe(true);
  });

  it('agreement_participants: 숫자 컬럼이 camel로, member_id null(인력 미지정)·annual_salary null 보존', () => {
    const app = dbToApp<AgreementParticipant>(agreementParticipantRowSchema.parse(agreementParticipantRow()));
    expect(app).toMatchObject({
      memberId: UUID_MEMBER,
      participationRate: 12.5,
      months: 6,
      annualSalary: 60_000_000,
      personnelCash: 3_750_000,
      personnelInKind: 0,
      role: '참여연구원',
    });
    const unassigned = agreementParticipantRow({ member_id: null, annual_salary: null });
    expect(agreementParticipantRowSchema.safeParse(unassigned).success).toBe(true);
    expect(appToDb(dbToApp(unassigned))).toEqual(unassigned);
  });

  it('agreement_items: evidence jsonb 배열이 내부 그대로 왕복한다', () => {
    const row = agreementItemRow();
    const app = dbToApp<AgreementItem>(agreementItemRowSchema.parse(row));
    expect(app.evidence).toEqual([
      { label: '견적서', obtained: true, memo: 'A사' },
      { label: '비교견적서', obtained: false, memo: '' },
    ]);
    expect(app.quantity).toBe(1.5);
    expect(appToDb(dbToApp(row))).toEqual(row);
    // N-3: 내부 키는 손대지 않는다 — 나중에 여러 단어 키가 생겨도 그대로 남는다
    expect(appToDb({ evidence: [{ checkedAt: 'x' }] })).toEqual({ evidence: [{ checkedAt: 'x' }] });
    expect(dbToApp({ evidence: [{ checked_at: 'x' }] })).toEqual({ evidence: [{ checked_at: 'x' }] });
  });

  it('agreement_items: 빈 evidence·null quantity가 통과한다', () => {
    const row = agreementItemRow({ evidence: [], quantity: null });
    expect(agreementItemRowSchema.safeParse(row).success).toBe(true);
    expect(appToDb(dbToApp(row))).toEqual(row);
  });

  it('금액이 정수가 아니거나 음수면 거부한다 — 손상을 조용히 넘기지 않는다(절대 규칙 4·5)', () => {
    expect(agreementLineRowSchema.safeParse(agreementLineRow({ amount: 1.5 })).success).toBe(false);
    expect(agreementLineRowSchema.safeParse(agreementLineRow({ amount: -1 })).success).toBe(false);
    expect(agreementLineRowSchema.safeParse(agreementLineRow({ amount: '1000' })).success).toBe(false);
    expect(agreementParticipantRowSchema.safeParse(agreementParticipantRow({ personnel_cash: 0.5 })).success).toBe(false);
    expect(agreementParticipantRowSchema.safeParse(agreementParticipantRow({ annual_salary: -1 })).success).toBe(false);
    expect(agreementItemRowSchema.safeParse(agreementItemRow({ amount: 10.1 })).success).toBe(false);
  });

  it('범위·enum·형태가 어긋난 행은 거부한다', () => {
    expect(agreementParticipantRowSchema.safeParse(agreementParticipantRow({ participation_rate: 100.1 })).success).toBe(false);
    expect(agreementParticipantRowSchema.safeParse(agreementParticipantRow({ months: 13 })).success).toBe(false);
    expect(agreementVersionRowSchema.safeParse(agreementVersionRow({ kind: 'draft' })).success).toBe(false);
    expect(agreementVersionRowSchema.safeParse(agreementVersionRow({ status: 'locked' })).success).toBe(false);
    expect(agreementVersionRowSchema.safeParse(agreementVersionRow({ notice_type: 'report' })).success).toBe(false);
    expect(agreementItemRowSchema.safeParse(agreementItemRow({ kind: 'travel' })).success).toBe(false);
    expect(agreementItemRowSchema.safeParse(agreementItemRow({ evidence: {} })).success).toBe(false);
    expect(agreementItemRowSchema.safeParse(agreementItemRow({ evidence: [{ label: '견적서' }] })).success).toBe(false);
    expect(agreementLineRowSchema.safeParse(agreementLineRow({ axis: 'inKind' })).success).toBe(false);
  });

  it('컬럼이 빠진 응답(마이그레이션 누락)은 거부된다', () => {
    const v = agreementVersionRow();
    delete v.confirmed_at;
    expect(agreementVersionRowSchema.safeParse(v).success).toBe(false);
    const p = agreementParticipantRow();
    delete p.annual_salary;
    expect(agreementParticipantRowSchema.safeParse(p).success).toBe(false);
    const i = agreementItemRow();
    delete i.evidence;
    expect(agreementItemRowSchema.safeParse(i).success).toBe(false);
  });
});

// ─── §5.5 years.gov_support_cash · §5.25 agreement_gov_support (Phase 25) ─

const UUID_AGS = 'ffffffff-ffff-4fff-8fff-ffffffffffff';

function yearRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    ...agreementBase(UUID_YEAR),
    project_id: UUID_PROJECT,
    stage_id: UUID_PROJECT,
    sort_order: 0,
    name: '1차년도',
    goal: '',
    start_date: '2026-01-01',
    end_date: '2026-12-31',
    budget: 52_500_000,
    status: 'active',
    gov_support_cash: 35_000_000,
    ...overrides,
  };
}

function govSupportRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    ...agreementBase(UUID_AGS),
    version_id: UUID_AV,
    year_id: UUID_YEAR,
    gov_cash: 35_000_000,
    ...overrides,
  };
}

describe('mapper·schema: 연차별 정부지원 현금 (§5.5·§5.25 Phase 25)', () => {
  it('years.gov_support_cash ↔ Year.govSupportCash 왕복', () => {
    const row = yearRow();
    const app = dbToApp<Year>(yearRowSchema.parse(row));
    expect(app.govSupportCash).toBe(35_000_000);
    expect(app).not.toHaveProperty('gov_support_cash');
    expect(appToDb(dbToApp(row))).toEqual(row);
    expect(appToDb({ govSupportCash: 0 })).toEqual({ gov_support_cash: 0 });
  });

  it('years.gov_support_cash null(미입력)은 null로 남는다 — 0과 다르다', () => {
    const row = yearRow({ gov_support_cash: null });
    const app = dbToApp<Year>(yearRowSchema.parse(row));
    expect(app.govSupportCash).toBeNull();
    expect(appToDb(dbToApp(row))).toEqual(row);
    expect(dbToApp<Year>(yearRowSchema.parse(yearRow({ gov_support_cash: 0 }))).govSupportCash).toBe(0);
  });

  it('years.gov_support_cash가 정수가 아니거나 음수거나 빠지면 거부한다', () => {
    expect(yearRowSchema.safeParse(yearRow({ gov_support_cash: 1.5 })).success).toBe(false);
    expect(yearRowSchema.safeParse(yearRow({ gov_support_cash: -1 })).success).toBe(false);
    expect(yearRowSchema.safeParse(yearRow({ gov_support_cash: '35000000' })).success).toBe(false);
    const missing = yearRow();
    delete missing.gov_support_cash;
    expect(yearRowSchema.safeParse(missing).success).toBe(false);
  });

  it('agreement_gov_support: gov_cash ↔ govCash, 공통 컬럼까지 전체 비교', () => {
    const app = dbToApp<AgreementGovSupport>(agreementGovSupportRowSchema.parse(govSupportRow()));
    const expected: AgreementGovSupport = {
      id: UUID_AGS,
      version: 3,
      createdAt: '2026-10-01T00:00:00+00:00',
      updatedAt: '2026-10-01T00:00:00+00:00',
      createdBy: null,
      updatedBy: null,
      versionId: UUID_AV,
      yearId: UUID_YEAR,
      govCash: 35_000_000,
    };
    expect(app).toEqual(expected);
    expect(appToDb(dbToApp(govSupportRow()))).toEqual(govSupportRow());
  });

  it('agreement_gov_support: 0은 입력값으로 통과한다', () => {
    const row = govSupportRow({ gov_cash: 0 });
    expect(agreementGovSupportRowSchema.safeParse(row).success).toBe(true);
    expect(dbToApp<AgreementGovSupport>(row).govCash).toBe(0);
  });

  it('agreement_gov_support: 음수·소수·null·문자·컬럼 누락은 거부한다', () => {
    expect(agreementGovSupportRowSchema.safeParse(govSupportRow({ gov_cash: -1 })).success).toBe(false);
    expect(agreementGovSupportRowSchema.safeParse(govSupportRow({ gov_cash: 0.5 })).success).toBe(false);
    expect(agreementGovSupportRowSchema.safeParse(govSupportRow({ gov_cash: null })).success).toBe(false);
    expect(agreementGovSupportRowSchema.safeParse(govSupportRow({ gov_cash: '1' })).success).toBe(false);
    expect(agreementGovSupportRowSchema.safeParse(govSupportRow({ year_id: 'y1' })).success).toBe(false);
    const missing = govSupportRow();
    delete missing.version_id;
    expect(agreementGovSupportRowSchema.safeParse(missing).success).toBe(false);
  });
});
