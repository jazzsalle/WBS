// 나머지 리포지토리 통합 테스트 — budget-items(+executions) / risks / notes /
// todos / import-profiles / app-users / settings (SOT §5.12~5.16, §14.2, N-10)
// app_settings의 두 거부 케이스(⑤)는 반드시 PostgREST(authenticated) 경로로 확인한다 —
// postgres 직결은 RLS·보호 트리거를 우회하므로 검증이 되지 않는다.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Sql } from 'postgres';
import { connectDirectDb, createTestUser, destroyTestUser, type TestUser } from './helpers';
import * as projects from '@/lib/db/projects';
import * as stages from '@/lib/db/stages';
import * as years from '@/lib/db/years';
import * as members from '@/lib/db/members';
import * as budgetItems from '@/lib/db/budget-items';
import * as risks from '@/lib/db/risks';
import * as notes from '@/lib/db/notes';
import * as todos from '@/lib/db/todos';
import * as importProfiles from '@/lib/db/import-profiles';
import * as appUsers from '@/lib/db/app-users';
import * as settings from '@/lib/db/settings';
import { NotFoundError } from '@/lib/db/errors';

let sql: Sql;
let user: TestUser;
let projectId: string;
let yearId: string;
let memberId: string;

beforeAll(async () => {
  sql = connectDirectDb();
  user = await createTestUser(sql);
  const project = await projects.createProject(user.client, {
    name: '연구비·노트 테스트 과제',
    createdBy: user.id,
    updatedBy: user.id,
  });
  projectId = project.id;
  const stage = await stages.createStage(user.client, { projectId, name: '1단계' });
  const year = await years.createYear(user.client, { stageId: stage.id, name: '1차년도' });
  yearId = year.id;
  const member = await members.createMember(
    user.client,
    {
      projectId,
      orgId: null,
      name: '최참석',
      role: 'researcher',
      position: '',
      field: '',
      email: '',
      phone: '',
      active: true,
      order: 0,
    },
    user.id
  );
  memberId = member.id;
});

afterAll(async () => {
  await sql`delete from public.projects where id = ${projectId}::uuid`;
  // 이 파일이 만든 To-Do·전역 프로파일 잔여물 안전망 (테스트 실패 시 대비)
  await sql`delete from public.todos where created_by = ${user.id}::uuid`;
  await sql`delete from public.import_profiles where created_by = ${user.id}::uuid`;
  await destroyTestUser(sql, user);
  await sql.end();
});

describe('budget-items + executions (§5.12, 원 단위 정수)', () => {
  it('계획액(현금/현물) 갱신 → 집행 CRUD → 임베드 조회', async () => {
    const updated = await budgetItems.updateBudgetPlan(user.client, yearId, 'personnel', {
      plannedAmount: 70_000_000,
      cashAmount: 50_000_000,
      inKindAmount: 20_000_000,
      updatedBy: user.id,
    });
    expect(updated.plannedAmount).toBe(70_000_000);
    expect(updated.cashAmount).toBe(50_000_000);
    expect(updated.inKindAmount).toBe(20_000_000);

    const execution = await budgetItems.addExecution(user.client, updated.id, {
      date: '2026-03-15',
      amount: 3_500_000,
      description: '3월 인건비',
      note: '',
      createdBy: user.id,
      updatedBy: user.id,
    });
    expect(execution.amount).toBe(3_500_000);

    const item = await budgetItems.getBudgetItemById(user.client, updated.id);
    expect(item.executions).toHaveLength(1);
    expect(item.executions[0]!.description).toBe('3월 인건비');

    const patched = await budgetItems.updateExecution(user.client, updated.id, execution.id, {
      amount: 3_600_000,
      updatedBy: user.id,
    });
    expect(patched.amount).toBe(3_600_000);

    await budgetItems.removeExecution(user.client, updated.id, execution.id);
    const after = await budgetItems.getBudgetItemById(user.client, updated.id);
    expect(after.executions).toEqual([]);
  });
});

describe('risks CRUD', () => {
  it('create → read → update → delete', async () => {
    const created = await risks.createRisk(user.client, {
      projectId,
      yearId: null,
      taskId: null,
      title: '핵심 인력 이탈',
      category: 'resource',
      description: '',
      probability: 2,
      impact: 5,
      strategy: 'mitigate',
      response: '지식 공유 체계화',
      contingency: '',
      ownerMemberId: memberId,
      dueDate: null,
      status: 'identified',
      order: 0,
      createdBy: user.id,
      updatedBy: user.id,
    });
    expect(created.probability).toBe(2);
    expect(created.impact).toBe(5);

    const list = await risks.listRisks(user.client, projectId);
    expect(list.some((r) => r.id === created.id)).toBe(true);

    const updated = await risks.updateRisk(user.client, created.id, {
      status: 'monitoring',
      updatedBy: user.id,
    });
    expect(updated.status).toBe('monitoring');

    await risks.removeRisk(user.client, created.id);
    await expect(risks.getRiskById(user.client, created.id)).rejects.toBeInstanceOf(NotFoundError);
  });
});

describe('notes CRUD (참석자 조인 N-2, tags jsonb)', () => {
  it('create → read → update(참석자 치환) → delete', async () => {
    const created = await notes.createNote(user.client, {
      projectId,
      yearId,
      taskId: null,
      milestoneId: null,
      type: 'meeting',
      title: '킥오프 회의',
      body: '# 안건\n- 일정 확정',
      date: '2026-01-05',
      attendeeMemberIds: [memberId],
      tags: ['회의', '킥오프'],
      pinned: true,
      createdBy: user.id,
      updatedBy: user.id,
    });
    expect(created.attendeeMemberIds).toEqual([memberId]);
    expect(created.tags).toEqual(['회의', '킥오프']);
    expect(created.pinned).toBe(true);

    const list = await notes.listNotes(user.client, projectId);
    expect(list.some((n) => n.id === created.id)).toBe(true);

    const updated = await notes.updateNote(user.client, created.id, {
      body: '# 안건\n- 일정 확정\n- 역할 분담',
      attendeeMemberIds: [],
      updatedBy: user.id,
    });
    expect(updated.attendeeMemberIds).toEqual([]);
    expect(updated.body).toContain('역할 분담');

    await notes.removeNote(user.client, created.id);
    await expect(notes.getNoteById(user.client, created.id)).rejects.toBeInstanceOf(NotFoundError);
  });
});

describe('todos CRUD', () => {
  it('create → read → update → delete', async () => {
    const created = await todos.createTodo(user.client, {
      title: '정산 서류 준비',
      done: false,
      projectId,
      dueDate: '2026-12-15',
      priority: 'high',
      order: 0,
      completedAt: null,
      createdBy: user.id,
      updatedBy: user.id,
    });
    expect(created.priority).toBe('high');

    const updated = await todos.updateTodo(user.client, created.id, {
      done: true,
      completedAt: new Date().toISOString(),
      updatedBy: user.id,
    });
    expect(updated.done).toBe(true);
    expect(updated.completedAt).not.toBeNull();

    await todos.removeTodo(user.client, created.id);
    await expect(todos.getTodoById(user.client, created.id)).rejects.toBeInstanceOf(NotFoundError);
  });
});

describe('import-profiles CRUD (jsonb 통과 필드)', () => {
  it('create → read → update → markUsed → delete', async () => {
    const created = await importProfiles.createImportProfile(user.client, {
      name: '산자부 사업비 총괄표',
      kind: 'budget_plan',
      ministry: '산업통상자원부',
      projectId,
      sheetName: null,
      headerRow: 2,
      dataStartRow: 4,
      orientation: 'row',
      labelColumns: ['B', 'C', 'D'],
      yearColumnMappings: [{ column: 'E', yearOrder: 0 }],
      categoryAliases: { 내부인건비: 'personnel' },
      amountUnit: 1000,
      skipRowPatterns: ['소계', '합계'],
      createdBy: user.id,
      updatedBy: user.id,
    });
    // jsonb 내부 키는 변환하지 않는다 (매퍼 특례) — yearOrder가 camel 그대로 왕복해야 한다
    expect(created.labelColumns).toEqual(['B', 'C', 'D']);
    expect(created.yearColumnMappings).toEqual([{ column: 'E', yearOrder: 0 }]);
    expect(created.categoryAliases).toEqual({ 내부인건비: 'personnel' });
    expect(created.amountUnit).toBe(1000);
    expect(created.useCount).toBe(0);
    expect(created.lastUsedAt).toBeNull();

    const list = await importProfiles.listImportProfiles(user.client, 'budget_plan', projectId);
    expect(list.some((p) => p.id === created.id)).toBe(true);

    const updated = await importProfiles.updateImportProfile(user.client, created.id, {
      name: '산자부 총괄표 v2',
      updatedBy: user.id,
    });
    expect(updated.name).toBe('산자부 총괄표 v2');

    const used = await importProfiles.markImportProfileUsed(user.client, created.id, user.id);
    expect(used.useCount).toBe(1);
    expect(used.lastUsedAt).not.toBeNull();

    await importProfiles.removeImportProfile(user.client, created.id);
    await expect(
      importProfiles.getImportProfileById(user.client, created.id)
    ).rejects.toBeInstanceOf(NotFoundError);
  });
});

describe('app-users (§14.2 — 생성은 트리거, 승인은 RPC 전용)', () => {
  it('getCurrentUser / list / updateProfile(본인 행) 왕복', async () => {
    const me = await appUsers.getCurrentUser(user.client, user.accessToken);
    expect(me.id).toBe(user.id);
    expect(me.email).toBe(user.email);
    expect(me.active).toBe(true); // 직결 SQL로 승인된 상태

    const list = await appUsers.listAppUsers(user.client);
    expect(list.some((u) => u.id === user.id)).toBe(true);

    const renamed = await appUsers.updateProfile(user.client, user.id, { name: '테스트 사용자' });
    expect(renamed.name).toBe('테스트 사용자');
  });

  it('보호 컬럼(active)은 authenticated 경로에서 직접 변경할 수 없다 (RLS-2 가드 트리거)', async () => {
    const { error } = await user.client
      .from('app_users')
      .update({ active: false })
      .eq('id', user.id);
    expect(error).not.toBeNull();
    expect(error!.message).toContain('직접 변경할 수 없습니다');
  });
});

describe('settings (§5.16, N-10 — 단일 행)', () => {
  it('get → update → 원복 (dev DB 원상 유지)', async () => {
    const original = await settings.getSettings(user.client);
    expect(original.schemaVersion).toBe(1); // Phase 0 최초 스키마 = 1

    const changed = await settings.updateSettings(user.client, {
      dueSoonDays: original.dueSoonDays + 3,
      updatedBy: user.id,
    });
    expect(changed.dueSoonDays).toBe(original.dueSoonDays + 3);
    expect(changed.version).toBe(original.version + 1);

    // 원복 — 테스트가 팀 공유 설정을 바꾼 채로 끝나면 안 된다
    const restored = await settings.updateSettings(user.client, {
      dueSoonDays: original.dueSoonDays,
      updatedBy: null,
    });
    expect(restored.dueSoonDays).toBe(original.dueSoonDays);
  });

  it('두 번째 행 INSERT는 거부된다 — INSERT 정책 없음 (N-10, authenticated 경로)', async () => {
    const { error } = await user.client
      .from('app_settings')
      .insert({ id: true, due_soon_days: 5 });
    expect(error).not.toBeNull();
    // 어떤 이유든(단일 행 PK 충돌 이전에 RLS가 먼저 막는다) 행이 1개로 유지되어야 한다
    const count = await sql`select count(*)::int as n from public.app_settings`;
    expect(count[0]!.n).toBe(1);
  });

  it('schema_version은 앱(authenticated) 갱신이 거부된다 (N-10 가드 트리거)', async () => {
    const { error } = await user.client
      .from('app_settings')
      .update({ schema_version: 999 })
      .eq('id', true);
    expect(error).not.toBeNull();
    expect(error!.message).toContain('마이그레이션만 갱신');

    const row = await sql`select schema_version::int as v from public.app_settings`;
    expect(row[0]!.v).toBe(1); // 값이 바뀌지 않았음을 직결 SQL로 재확인
  });
});
