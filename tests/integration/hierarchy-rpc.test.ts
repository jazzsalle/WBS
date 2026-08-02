// 계층 RPC 통합 테스트 — create_project_with_defaults / reorder_* / set_year_status
// (SOT §5.4, §5.5, §6.6 H-10, §8.3 X-3, §9)
// publishable 키 + 실제 세션(RLS 경로)으로 리포지토리를 호출한다. 직결 SQL은 결과 확인 전용.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Sql } from 'postgres';
import {
  ALL_BUDGET_CATEGORIES,
  connectDirectDb,
  createTestUser,
  destroyTestUser,
  type TestUser,
} from './helpers';
import * as projects from '@/lib/db/projects';
import * as stages from '@/lib/db/stages';
import * as years from '@/lib/db/years';
import * as budgetItems from '@/lib/db/budget-items';
import { RuleViolationError } from '@/lib/db/errors';

let sql: Sql;
let user: TestUser;
const tempProjectIds: string[] = []; // afterAll 안전망 — 실패해도 dev DB를 원복한다

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

async function newProject(input: projects.ProjectWithDefaultsInput) {
  const project = await projects.createProjectWithDefaults(user.client, input);
  tempProjectIds.push(project.id);
  return project;
}

describe('createProjectWithDefaults — Stage 1개 + Year 1개 자동 생성 (§9)', () => {
  it('협약시작일이 있으면 연차 기간이 시작일 ~ +1년-1일로 채워진다', async () => {
    const project = await newProject({
      name: '기본값 과제',
      projectNo: 'DEF-001',
      ministry: '과학기술정보통신부',
      agency: 'IITP',
      status: 'planning',
      contractStartDate: '2026-04-01',
      contractEndDate: '2029-03-31',
      totalBudget: 900_000_000,
      govBudget: 700_000_000,
      ownBudget: 200_000_000,
    });

    expect(project.name).toBe('기본값 과제');
    expect(project.totalBudget).toBe(900_000_000); // 원 단위 정수 그대로
    expect(project.createdBy).toBe(user.id); // RPC가 auth.uid()로 채운다

    const stageList = await stages.listStages(user.client, project.id);
    expect(stageList).toHaveLength(1);
    expect(stageList[0]!.order).toBe(0);
    expect(stageList[0]!.name).toBe('1단계');

    const yearList = await years.listYears(user.client, project.id);
    expect(yearList).toHaveLength(1);
    expect(yearList[0]!.order).toBe(0);
    expect(yearList[0]!.stageId).toBe(stageList[0]!.id);
    expect(yearList[0]!.status).toBe('planned');
    expect(yearList[0]!.name).toBe(''); // 표시는 §5.5 폴백 '1차년도'
    expect(yearList[0]!.startDate).toBe('2026-04-01');
    expect(yearList[0]!.endDate).toBe('2027-03-31'); // 시작일 + 1년 - 1일

    // create_year에 위임했으므로 비목 12종도 함께 생긴다 (§5.12)
    const items = await budgetItems.listBudgetItemsByYear(user.client, yearList[0]!.id);
    expect(items).toHaveLength(12);
    expect(items.map((i) => i.category).sort()).toEqual([...ALL_BUDGET_CATEGORIES].sort());
  });

  it('협약시작일이 없으면 연차 기간은 미정(null)으로 남는다', async () => {
    const project = await newProject({ name: '기간 미정 과제' });
    const yearList = await years.listYears(user.client, project.id);
    expect(yearList).toHaveLength(1);
    expect(yearList[0]!.startDate).toBeNull();
    expect(yearList[0]!.endDate).toBeNull();
  });

  it('새 과제의 order는 기존 과제 뒤에 붙는다 (§7.15)', async () => {
    const first = await newProject({ name: 'order 확인 A' });
    const second = await newProject({ name: 'order 확인 B' });
    expect(second.order).toBe(first.order + 1);
  });
});

describe('create_year order 부여 — 단계 추가 후 회귀 확인 (§5.5)', () => {
  it('중간 단계에 연차를 추가하면 해당 단계 마지막 뒤에 삽입되고 이후가 시프트된다', async () => {
    const project = await newProject({ name: '2단계 과제', contractStartDate: '2026-01-01' });
    const stage1 = (await stages.listStages(user.client, project.id))[0]!;

    const stage2 = await stages.createStage(user.client, {
      projectId: project.id,
      order: 1,
      name: '2단계',
      createdBy: user.id,
      updatedBy: user.id,
    });

    // 2단계에 연차 1개 → 1단계 연차(order 0) 뒤인 order 1
    const y2 = await years.createYear(user.client, { stageId: stage2.id, name: '2차년도' });
    expect(y2.order).toBe(1);

    // 1단계에 연차를 하나 더 → 1단계 마지막(order 0) 다음인 order 1에 삽입되고 y2는 2로 시프트
    const y1b = await years.createYear(user.client, { stageId: stage1.id, name: '1-2차년도' });
    expect(y1b.order).toBe(1);
    expect((await years.getYearById(user.client, y2.id)).order).toBe(2);

    const yearList = await years.listYears(user.client, project.id);
    expect(yearList.map((y) => y.order)).toEqual([0, 1, 2]);
    expect(yearList.map((y) => y.stageId)).toEqual([stage1.id, stage1.id, stage2.id]);
  });
});

describe('reorderYears — project 단위 normalize + 단계 경계 (§5.5, H-10)', () => {
  let projectId: string;
  let stage1Id: string;
  let stage2Id: string;
  let yearIds: string[];

  beforeAll(async () => {
    const project = await newProject({ name: '연차 재정렬 과제' });
    projectId = project.id;
    stage1Id = (await stages.listStages(user.client, projectId))[0]!.id;
    const stage2 = await stages.createStage(user.client, {
      projectId,
      order: 1,
      name: '2단계',
      createdBy: user.id,
      updatedBy: user.id,
    });
    stage2Id = stage2.id;

    // 1단계: 2개(자동 생성 1 + 1), 2단계: 2개
    await years.createYear(user.client, { stageId: stage1Id, name: '1-2차년도' });
    await years.createYear(user.client, { stageId: stage2Id, name: '2-1차년도' });
    await years.createYear(user.client, { stageId: stage2Id, name: '2-2차년도' });

    yearIds = (await years.listYears(user.client, projectId)).map((y) => y.id);
    expect(yearIds).toHaveLength(4);
  });

  it('단계 경계를 넘는 순서는 거부한다', async () => {
    // [1단계#1, 2단계#1, 1단계#2, 2단계#2] — 1단계 블록이 끊긴다
    const mixed = [yearIds[0]!, yearIds[2]!, yearIds[1]!, yearIds[3]!];
    await expect(years.reorderYears(user.client, projectId, mixed)).rejects.toBeInstanceOf(
      RuleViolationError
    );

    // 블록은 유지하되 단계 순서를 뒤집는 것도 거부한다 (앞 단계 마지막 < 뒷 단계 첫)
    const stageSwapped = [yearIds[2]!, yearIds[3]!, yearIds[0]!, yearIds[1]!];
    await expect(years.reorderYears(user.client, projectId, stageSwapped)).rejects.toBeInstanceOf(
      RuleViolationError
    );

    // 거부됐으므로 원래 순서 그대로다
    const after = await years.listYears(user.client, projectId);
    expect(after.map((y) => y.id)).toEqual(yearIds);
  });

  it('과제의 일부 연차만 넘기면 거부한다', async () => {
    await expect(
      years.reorderYears(user.client, projectId, [yearIds[0]!, yearIds[1]!])
    ).rejects.toBeInstanceOf(RuleViolationError);
  });

  it('같은 단계 안에서의 교환은 성공하고 order가 0..n-1로 normalize된다', async () => {
    const swapped = [yearIds[1]!, yearIds[0]!, yearIds[3]!, yearIds[2]!];
    await years.reorderYears(user.client, projectId, swapped);

    const after = await years.listYears(user.client, projectId);
    expect(after.map((y) => y.id)).toEqual(swapped);
    expect(after.map((y) => y.order)).toEqual([0, 1, 2, 3]);
    expect(after.map((y) => y.stageId)).toEqual([stage1Id, stage1Id, stage2Id, stage2Id]);

    // 원복 — 이후 테스트가 yearIds 순서를 그대로 쓴다
    await years.reorderYears(user.client, projectId, yearIds);
  });
});

describe('setYearStatus — 과제당 active 1개 (§5.5)', () => {
  it('다른 연차를 active로 지정하면 기존 active가 planned로 풀린다', async () => {
    const project = await newProject({ name: 'active 연차 과제' });
    const stageId = (await stages.listStages(user.client, project.id))[0]!.id;
    await years.createYear(user.client, { stageId, name: '2차년도' });
    const [y1, y2] = await years.listYears(user.client, project.id);

    const activated1 = await years.setYearStatus(user.client, y1!.id, 'active');
    expect(activated1.status).toBe('active');

    const activated2 = await years.setYearStatus(user.client, y2!.id, 'active');
    expect(activated2.status).toBe('active');

    const after = await years.listYears(user.client, project.id);
    expect(after.filter((y) => y.status === 'active').map((y) => y.id)).toEqual([y2!.id]);
    expect(after.find((y) => y.id === y1!.id)!.status).toBe('planned');

    // active가 아닌 상태 지정은 다른 연차를 건드리지 않는다
    await years.setYearStatus(user.client, y1!.id, 'evaluating');
    const after2 = await years.listYears(user.client, project.id);
    expect(after2.find((y) => y.id === y1!.id)!.status).toBe('evaluating');
    expect(after2.find((y) => y.id === y2!.id)!.status).toBe('active');
  });

  it('알 수 없는 상태는 거부한다', async () => {
    const project = await newProject({ name: '상태 검증 과제' });
    const yearId = (await years.listYears(user.client, project.id))[0]!.id;
    await expect(
      // 타입 밖의 값이 액션 계층을 우회해 들어오는 경우 — DB가 최종 방어선이다
      years.setYearStatus(user.client, yearId, 'unknown' as never)
    ).rejects.toBeInstanceOf(RuleViolationError);
  });
});

describe('reorderProjects / reorderStages — 0..n-1 연속 (H-10, X-3)', () => {
  it('reorderStages 후 단계 order가 0..n-1이 된다', async () => {
    const project = await newProject({ name: '단계 재정렬 과제' });
    await stages.createStage(user.client, {
      projectId: project.id,
      order: 1,
      name: '2단계',
      createdBy: user.id,
      updatedBy: user.id,
    });
    await stages.createStage(user.client, {
      projectId: project.id,
      order: 2,
      name: '3단계',
      createdBy: user.id,
      updatedBy: user.id,
    });

    const before = await stages.listStages(user.client, project.id);
    const reversed = [...before].reverse().map((s) => s.id);
    await stages.reorderStages(user.client, project.id, reversed);

    const after = await stages.listStages(user.client, project.id);
    expect(after.map((s) => s.id)).toEqual(reversed);
    expect(after.map((s) => s.order)).toEqual([0, 1, 2]);
  });

  it('다른 과제의 단계 id가 섞이면 거부한다', async () => {
    const a = await newProject({ name: '경계 확인 A' });
    const b = await newProject({ name: '경계 확인 B' });
    const stageA = (await stages.listStages(user.client, a.id))[0]!;
    const stageB = (await stages.listStages(user.client, b.id))[0]!;

    await expect(
      stages.reorderStages(user.client, a.id, [stageA.id, stageB.id])
    ).rejects.toBeInstanceOf(RuleViolationError);
  });

  it('reorderProjects 후 과제 order가 0..n-1이 된다', async () => {
    const p1 = await newProject({ name: '과제 재정렬 1' });
    const p2 = await newProject({ name: '과제 재정렬 2' });
    const p3 = await newProject({ name: '과제 재정렬 3' });

    const ordered = [p3.id, p1.id, p2.id];
    await projects.reorderProjects(user.client, ordered);

    const rows = await sql`
      select id, sort_order from public.projects
       where id = any(${sql.array(ordered)}::uuid[])
       order by sort_order`;
    expect(rows.map((r) => r.id)).toEqual(ordered);
    expect(rows.map((r) => r.sort_order)).toEqual([0, 1, 2]);
  });

  it('존재하지 않는 과제 id는 조용히 넘기지 않는다', async () => {
    await expect(
      projects.reorderProjects(user.client, ['bbbb0000-0000-4000-8000-0000000000ff'])
    ).rejects.toBeInstanceOf(RuleViolationError);
  });
});
