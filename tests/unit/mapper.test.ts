// lib/db/mapper.ts 단위 테스트 (SOT §5.1 N-9, N-3, N-13, §8.6)

import { describe, it, expect } from 'vitest';
import { dbToApp, appToDb, dbToAppArray } from '@/lib/db/mapper';

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
