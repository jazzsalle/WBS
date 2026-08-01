// 계층 리포지토리 통합 테스트 — projects / stages / years / tasks (SOT §5.3~5.6, §8.4, 부록 B.1)
// 실제 dev DB에 대해 publishable 키 + 실제 세션(RLS 경로)으로 CRUD 왕복을 검증한다.
// 시드는 supabase/seed.sql(부록 B.1 구조 그대로)을 직결 SQL로 적용·제거한다.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Sql } from 'postgres';
import {
  ALL_BUDGET_CATEGORIES,
  SEED,
  applySeed,
  connectDirectDb,
  createTestUser,
  destroyTestUser,
  removeSeed,
  type TestUser,
} from './helpers';
import * as projects from '@/lib/db/projects';
import * as stages from '@/lib/db/stages';
import * as years from '@/lib/db/years';
import * as tasks from '@/lib/db/tasks';
import * as members from '@/lib/db/members';
import * as deliverables from '@/lib/db/deliverables';
import * as techTargets from '@/lib/db/tech-targets';
import * as budgetItems from '@/lib/db/budget-items';
import { ConflictError, NotFoundError } from '@/lib/db/errors';

let sql: Sql;
let user: TestUser;
const tempProjectIds: string[] = []; // afterAll 안전망 — 테스트 실패 시에도 직결 SQL로 지운다

beforeAll(async () => {
  sql = connectDirectDb();
  await applySeed(sql);
  user = await createTestUser(sql);
});

afterAll(async () => {
  await removeSeed(sql);
  for (const id of tempProjectIds) {
    await sql`delete from public.projects where id = ${id}::uuid`;
  }
  await destroyTestUser(sql, user);
  await sql.end();
});

describe('시드(부록 B.1) 조회 — §5 앱 형태(camelCase)', () => {
  it('과제 A가 앱 형태로 조회된다', async () => {
    const project = await projects.getProjectById(user.client, SEED.projectId);
    expect(project.name).toBe('과제 A');
    expect(project.projectNo).toBe('2026-0-01234'); // snake project_no → camel
    expect(project.totalBudget).toBe(600_000_000);  // 원 단위 정수 그대로
    expect(project.status).toBe('active');
    expect(project.order).toBe(0);                  // sort_order → order (N-9)
    expect(project.version).toBe(1);
  });

  it('1단계(600M) + 연차 2개(200M/400M)가 order 순으로 조회된다', async () => {
    const stageList = await stages.listStages(user.client, SEED.projectId);
    expect(stageList).toHaveLength(1);
    expect(stageList[0]!.budget).toBe(600_000_000);

    const yearList = await years.listYears(user.client, SEED.projectId);
    expect(yearList).toHaveLength(2);
    expect(yearList.map((y) => y.order)).toEqual([0, 1]);
    expect(yearList.map((y) => y.budget)).toEqual([200_000_000, 400_000_000]);
    expect(yearList[0]!.stageId).toBe(SEED.stageId);
  });

  it('Task 트리(B.1)가 임베드 배열 포함 앱 형태로 조회된다', async () => {
    const year1Tasks = await tasks.listTasksByYear(user.client, SEED.year1Id);
    expect(year1Tasks).toHaveLength(3);

    const root = year1Tasks.find((t) => t.title === '요구사항 분석');
    expect(root).toBeDefined();
    expect(root!.parentId).toBeNull();
    expect(root!.estimatedHours).toBe(40);
    expect(root!.progressMode).toBe('auto');

    const leaf = year1Tasks.find((t) => t.title === '문헌조사');
    expect(leaf!.parentId).toBe(root!.id);
    expect(leaf!.estimatedHours).toBe(16);
    expect(leaf!.status).toBe('done');
    // 조인 테이블(N-2) → 앱의 xxxIds 배열, jsonb → tags 배열
    expect(leaf!.memberIds).toEqual([]);
    expect(leaf!.deliverableIds).toEqual([]);
    expect(leaf!.techTargetIds).toEqual([]);
    expect(leaf!.tags).toEqual([]);

    const year2Tasks = await tasks.listTasksByYear(user.client, SEED.year2Id);
    expect(year2Tasks).toHaveLength(4);
    expect(year2Tasks.find((t) => t.title === '학습·튜닝')!.manualProgress).toBe(30);

    const all = await tasks.listTasksByProject(user.client, SEED.projectId);
    expect(all).toHaveLength(7);
  });
});

describe('projects CRUD 왕복', () => {
  it('create → read → update → delete', async () => {
    const created = await projects.createProject(user.client, {
      name: '임시 과제',
      projectNo: 'TMP-001',
      ministry: '산업통상자원부',
      status: 'planning',
      totalBudget: 100_000_000,
      createdBy: user.id,
      updatedBy: user.id,
    });
    tempProjectIds.push(created.id);
    expect(created.name).toBe('임시 과제');
    expect(created.createdBy).toBe(user.id);
    expect(created.version).toBe(1);

    const read = await projects.getProjectById(user.client, created.id);
    expect(read).toEqual(created);

    const updated = await projects.updateProject(user.client, created.id, {
      name: '임시 과제(수정)',
      govBudget: 80_000_000,
      updatedBy: user.id,
    });
    expect(updated.name).toBe('임시 과제(수정)');
    expect(updated.govBudget).toBe(80_000_000);
    expect(updated.version).toBe(2); // BEFORE UPDATE 트리거 +1 (N-5)

    await projects.deleteProject(user.client, created.id);
    await expect(projects.getProjectById(user.client, created.id)).rejects.toBeInstanceOf(
      NotFoundError
    );
  });
});

describe('stages / years / tasks CRUD 왕복 (임시 과제 위에서)', () => {
  let projectId: string;
  let stageId: string;

  beforeAll(async () => {
    const project = await projects.createProject(user.client, {
      name: 'CRUD 놀이터',
      createdBy: user.id,
      updatedBy: user.id,
    });
    projectId = project.id;
    tempProjectIds.push(projectId);
    const stage = await stages.createStage(user.client, {
      projectId,
      name: '1단계',
      budget: 500_000_000,
      createdBy: user.id,
      updatedBy: user.id,
    });
    stageId = stage.id;
  });

  it('stages: create → read → update', async () => {
    const read = await stages.getStageById(user.client, stageId);
    expect(read.projectId).toBe(projectId);
    expect(read.budget).toBe(500_000_000);

    const updated = await stages.updateStage(user.client, stageId, {
      goal: '핵심 기술 확보',
      updatedBy: user.id,
    });
    expect(updated.goal).toBe('핵심 기술 확보');
    expect(updated.version).toBe(2);
  });

  it('years: create_year RPC가 비목 12종을 자동 생성하고 order를 계산한다 (§5.5, §5.12)', async () => {
    const year1 = await years.createYear(user.client, {
      stageId,
      name: '1차년도',
      budget: 200_000_000,
    });
    expect(year1.projectId).toBe(projectId); // RPC가 stage에서 유도
    expect(year1.order).toBe(0);
    expect(year1.budget).toBe(200_000_000);

    const items = await budgetItems.listBudgetItemsByYear(user.client, year1.id);
    expect(items.map((i) => i.category).sort()).toEqual([...ALL_BUDGET_CATEGORIES].sort());
    expect(items.every((i) => i.plannedAmount === 0)).toBe(true);
    expect(items.every((i) => i.executions.length === 0)).toBe(true);

    // 재호출(연차 추가)도 충돌 없이 12종을 만든다 — insert의 on conflict do nothing 경로
    const year2 = await years.createYear(user.client, { stageId, name: '2차년도' });
    expect(year2.order).toBe(1);
    const items2 = await budgetItems.listBudgetItemsByYear(user.client, year2.id);
    expect(items2).toHaveLength(12);

    // unique(year_id, category) 위반은 ConflictError (§5.12 제약)
    await expect(
      (async () => {
        const { error } = await user.client
          .from('budget_items')
          .insert({ project_id: projectId, year_id: year1.id, category: 'personnel' });
        if (error?.code === '23505') throw new ConflictError();
        if (error) throw new Error(error.message);
      })()
    ).rejects.toBeInstanceOf(ConflictError);

    const updated = await years.updateYear(user.client, year1.id, {
      goal: '기반 구축',
      status: 'active',
      updatedBy: user.id,
    });
    expect(updated.goal).toBe('기반 구축');
    expect(updated.status).toBe('active');

    await years.deleteYear(user.client, year2.id);
    // 연차 삭제 시 비목도 함께 사라진다 (H-5 cascade) — 직결 SQL로 확인
    const left = await sql`
      select count(*)::int as n from public.budget_items where year_id = ${year2.id}::uuid`;
    expect(left[0]!.n).toBe(0);
  });

  it('tasks: create(조인 배열 포함) → read → update → delete', async () => {
    const yearList = await years.listYears(user.client, projectId);
    const yearId = yearList[0]!.id;

    // 조인 대상 준비 — memberIds/deliverableIds/techTargetIds가 실제 조인 테이블로 저장·조회되는지
    const member = await members.createMember(
      user.client,
      {
        projectId,
        orgId: null,
        name: '홍길동',
        role: 'researcher',
        position: '선임',
        field: 'AI',
        email: '',
        phone: '',
        active: true,
        order: 0,
      },
      user.id
    );
    const deliverable = await deliverables.createDeliverable(
      user.client,
      {
        projectId,
        type: 'paper_sci',
        name: 'SCI급 논문 게재',
        unit: '건',
        targetTotal: 4,
        targetByYear: { [yearId]: 1 },
        orgId: null,
        note: '',
        order: 0,
      },
      user.id
    );
    const techTarget = await techTargets.createTechTarget(
      user.client,
      {
        projectId,
        name: '객체 인식 정확도',
        unit: '%',
        direction: 'higher_better',
        weight: 50,
        targetValue: 90,
        targetByYear: {},
        baselineDomestic: 75,
        worldBest: 95,
        worldBestHolder: '미국',
        measureMethod: 'self',
        measureDescription: '',
        orgId: null,
        order: 0,
      },
      user.id
    );

    const created = await tasks.createTask(user.client, {
      projectId,
      yearId,
      title: '데이터 수집',
      status: 'in_progress',
      manualProgress: 40,
      estimatedHours: 20,
      importance: 4,
      memberIds: [member.id],
      deliverableIds: [deliverable.id],
      techTargetIds: [techTarget.id],
      tags: ['데이터'],
      createdBy: user.id,
      updatedBy: user.id,
    });
    expect(created.memberIds).toEqual([member.id]);
    expect(created.deliverableIds).toEqual([deliverable.id]);
    expect(created.techTargetIds).toEqual([techTarget.id]);
    expect(created.tags).toEqual(['데이터']);
    expect(created.importance).toBe(4);

    const child = await tasks.createTask(user.client, {
      projectId,
      yearId,
      parentId: created.id,
      title: '크롤러 구현',
      createdBy: user.id,
      updatedBy: user.id,
    });
    expect(child.parentId).toBe(created.id);

    const updated = await tasks.updateTask(user.client, created.id, {
      title: '데이터 수집·정제',
      manualProgress: 60,
      memberIds: [], // 배열 전체 치환
      updatedBy: user.id,
    });
    expect(updated.title).toBe('데이터 수집·정제');
    expect(updated.manualProgress).toBe(60);
    expect(updated.memberIds).toEqual([]);
    expect(updated.deliverableIds).toEqual([deliverable.id]); // 안 넘긴 배열은 유지

    await tasks.deleteTask(user.client, child.id);
    await expect(tasks.getTaskById(user.client, child.id)).rejects.toBeInstanceOf(NotFoundError);
  });
});
