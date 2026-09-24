// 따라하기 서버 액션 통합 테스트 (SOT §9 "Help · Tutorial", §7.17 TU-3·TU-4·TU-5)
//
// 서버 액션은 쿠키 세션(requireApprovedUser)에서 토큰을 읽으므로 next/headers를
// "실제 세션 토큰을 돌려주는 스텁"으로 바꿔 가드까지 포함해 그대로 호출한다
// (budget-rules-actions.test.ts와 같은 방식). revalidatePath는 요청 컨텍스트 밖이라 스텁한다.
//
// 검증의 핵심:
//  1. TU-4 — 완료 판정은 데이터로 한다. 빈 과제에서 데이터를 하나씩 넣을 때마다 그 단계만 true가
//     되고, ⑦은 산출근거와 규칙이 **둘 다** 있어야 true다. null·없는 과제·삭제된 과제는 과제 없음.
//  2. TU-3 — createSampleProject가 기존 액션 경로로 예제 세트를 만들고, 만든 과제로 ①~⑦이 전부
//     true다. 주관기관 1개(H-8)·PM 지정·깊이 3·산출근거 6행·프리셋 17행·PL-10 불변식.
//  3. 살아 있는 sampleProjectId로 다시 부르면 만들지 않는다.
//
// 자기가 만든 과제·사용자만 지운다 — 파괴적 테스트가 아니다.

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Sql } from 'postgres';
import { connectDirectDb, createTestUser, destroyTestUser, type TestUser } from './helpers';
import type { ActionResult, Task } from '@/types';
import * as projectsRepo from '@/lib/db/projects';
import * as stagesRepo from '@/lib/db/stages';
import * as yearsRepo from '@/lib/db/years';
import * as organizationsRepo from '@/lib/db/organizations';
import * as membersRepo from '@/lib/db/members';
import * as tasksRepo from '@/lib/db/tasks';
import * as deliverablesRepo from '@/lib/db/deliverables';
import * as techTargetsRepo from '@/lib/db/tech-targets';
import * as milestonesRepo from '@/lib/db/milestones';
import * as budgetItemsRepo from '@/lib/db/budget-items';
import * as budgetDetailsRepo from '@/lib/db/budget-details';
import * as budgetRulesRepo from '@/lib/db/budget-rules';
import { RULE_PRESETS } from '@/lib/rules-presets';

const session = vi.hoisted(() => ({ accessToken: '' }));

vi.mock('next/headers', () => ({
  cookies: async () => ({ get: () => ({ value: session.accessToken }) }),
}));
vi.mock('next/cache', () => ({ revalidatePath: () => undefined }));

const help = await import('@/actions/help');
const { createProject, deleteProject } = await import('@/actions/projects');
const { createYear } = await import('@/actions/years');
const { createMember } = await import('@/actions/team');
const { createTask } = await import('@/actions/tasks');
const { createDeliverable } = await import('@/actions/goals');
const { generateDefaultMilestones } = await import('@/actions/milestones');
const { createBudgetDetail } = await import('@/actions/budget-plan');
const { applyRulePreset } = await import('@/actions/budget-rules');

let sql: Sql;
let user: TestUser;
const tempProjectIds: string[] = []; // afterAll 안전망 — 이 테스트가 만든 과제만 지운다

const MISSING_PROJECT_ID = '00000000-0000-4000-8000-000000000000';
const SAMPLE_PROJECT_PREFIX = '[예제] ';
const SAMPLE_DESCRIPTION_FIRST_LINE = '따라하기 예제 — 지워도 됩니다';

const ALL_FALSE = {
  project: false,
  years: false,
  team: false,
  wbs: false,
  goals: false,
  milestones: false,
  budget: false,
} as const;

function unwrap<T>(result: ActionResult<T>): T {
  if (!result.ok) {
    throw new Error(`액션 실패: ${result.error} (code=${result.code ?? '-'})`);
  }
  return result.data;
}

async function status(projectId: unknown) {
  return unwrap(await help.getTutorialStatus(projectId));
}

// 루트까지의 거리 + 1. 트리에 없는 부모를 가리키면 그 자리에서 실패시킨다 (조용히 1로 두지 않는다)
function depthOf(task: Task, byId: Map<string, Task>): number {
  let depth = 1;
  let cursor = task;
  while (cursor.parentId !== null) {
    const parent = byId.get(cursor.parentId);
    if (!parent) throw new Error(`부모가 없는 작업: ${cursor.title}`);
    cursor = parent;
    depth += 1;
  }
  return depth;
}

beforeAll(async () => {
  sql = connectDirectDb();
  user = await createTestUser(sql);
  session.accessToken = user.accessToken;
});

afterAll(async () => {
  for (const id of tempProjectIds) {
    await sql`delete from public.projects where id = ${id}::uuid`;
  }
  // cascade가 하위 행을 전부 지우지 않으면 즉시 실패시킨다 (H-7, 절대 규칙 5)
  let remaining = 0;
  for (const id of tempProjectIds) {
    const rows = await sql`
      select ((select count(*) from public.projects       where id         = ${id}::uuid)
            + (select count(*) from public.stages         where project_id = ${id}::uuid)
            + (select count(*) from public.years          where project_id = ${id}::uuid)
            + (select count(*) from public.organizations  where project_id = ${id}::uuid)
            + (select count(*) from public.members        where project_id = ${id}::uuid)
            + (select count(*) from public.tasks          where project_id = ${id}::uuid)
            + (select count(*) from public.deliverables   where project_id = ${id}::uuid)
            + (select count(*) from public.tech_targets   where project_id = ${id}::uuid)
            + (select count(*) from public.milestones     where project_id = ${id}::uuid)
            + (select count(*) from public.budget_items   where project_id = ${id}::uuid)
            + (select count(*) from public.budget_details where project_id = ${id}::uuid)
            + (select count(*) from public.budget_rules   where project_id = ${id}::uuid))::text as n`;
    remaining += Number((rows[0] as { n: string }).n);
  }
  if (remaining !== 0) {
    throw new Error(`테스트가 만든 데이터가 ${remaining}건 남았습니다.`);
  }
  await destroyTestUser(sql, user);
  await sql.end();
});

// ─── getTutorialStatus (TU-4) ────────────────────────────────

describe('getTutorialStatus — 데이터를 하나씩 넣을 때마다 그 단계만 true (TU-4)', () => {
  let projectId: string;
  let yearId: string;

  beforeAll(async () => {
    // createProject 액션은 Stage·Year를 함께 만들므로(X-1) "연차 0"인 빈 과제는 리포지토리로 만든다
    const project = await projectsRepo.createProject(user.client, {
      name: '튜토리얼 판정 — 빈 과제',
      createdBy: user.id,
      updatedBy: user.id,
    });
    projectId = project.id;
    tempProjectIds.push(projectId);
  });

  it('빈 과제 → ①만 true, 나머지 false', async () => {
    expect(await status(projectId)).toEqual({
      projectExists: true,
      steps: { ...ALL_FALSE, project: true },
    });
  });

  it('연차 추가 → ②', async () => {
    const stage = await stagesRepo.createStage(user.client, {
      projectId,
      name: '1단계',
      createdBy: user.id,
      updatedBy: user.id,
    });
    yearId = unwrap(
      await createYear(stage.id, { name: '1차년도', startDate: '2026-01-01', endDate: '2026-12-31' })
    ).id;
    const s = await status(projectId);
    expect(s.steps).toEqual({ ...ALL_FALSE, project: true, years: true });
  });

  it('인력 추가 → ③', async () => {
    unwrap(await createMember(projectId, { name: '판정용 연구원' }));
    expect((await status(projectId)).steps).toEqual({
      ...ALL_FALSE,
      project: true,
      years: true,
      team: true,
    });
  });

  it('작업 추가 → ④', async () => {
    unwrap(await createTask(yearId, { title: '판정용 작업' }));
    expect((await status(projectId)).steps).toMatchObject({ wbs: true, goals: false });
  });

  it('성과목표만 → ⑤ (기술목표 없이도 true)', async () => {
    unwrap(await createDeliverable(projectId, { type: 'other', name: '판정용 성과목표' }));
    expect((await status(projectId)).steps).toMatchObject({ goals: true, milestones: false });
  });

  it('마일스톤 → ⑥', async () => {
    const created = unwrap(await generateDefaultMilestones(yearId));
    expect(created.length).toBeGreaterThanOrEqual(1);
    expect((await status(projectId)).steps).toMatchObject({ milestones: true, budget: false });
  });

  it('산출근거만 → ⑦ false (규칙이 없다)', async () => {
    unwrap(
      await createBudgetDetail(yearId, 'activity', 'activity_meeting', {
        axis: 'cash',
        formula: 'quantity',
        name: '판정용 회의비',
        unitPrice: 100_000,
        factors: [{ label: '회', value: 1, isPercent: false }],
      })
    );
    expect((await budgetDetailsRepo.listByProject(user.client, projectId)).length).toBe(1);
    expect((await status(projectId)).steps.budget).toBe(false);
  });

  it('규칙만 → ⑦ false (산출근거가 없다) — 다른 과제로 확인', async () => {
    const other = unwrap(await createProject({ name: '튜토리얼 판정 — 규칙만' }));
    tempProjectIds.push(other.id);
    unwrap(await applyRulePreset(other.id, 'moe_energy_sme', 'fill'));

    const s = await status(other.id);
    expect(s.projectExists).toBe(true);
    expect(s.steps).toEqual({ ...ALL_FALSE, project: true, years: true }); // createProject가 연차 1개를 만든다

    // 삭제된 과제 → 과제 없음 (TU-5: 드로어가 이 값으로 sampleProjectId를 되돌린다)
    unwrap(await deleteProject(other.id));
    expect(await status(other.id)).toEqual({ projectExists: false, steps: ALL_FALSE });
  });

  it('산출근거 + 규칙 → ⑦ true, ①~⑦ 전부 true', async () => {
    unwrap(await applyRulePreset(projectId, 'moe_energy_sme', 'fill'));
    expect(await status(projectId)).toEqual({
      projectExists: true,
      steps: {
        project: true,
        years: true,
        team: true,
        wbs: true,
        goals: true,
        milestones: true,
        budget: true,
      },
    });
  });

  it('null·없는 과제·uuid가 아닌 값 → projectExists false, 전부 false (실패가 아니다)', async () => {
    const expected = { projectExists: false, steps: ALL_FALSE };
    expect(await status(null)).toEqual(expected);
    expect(await status(undefined)).toEqual(expected);
    expect(await status(MISSING_PROJECT_ID)).toEqual(expected);
    expect(await status('not-a-uuid')).toEqual(expected);
  });
});

// ─── createSampleProject (TU-3) ──────────────────────────────

describe('createSampleProject — 기존 액션 경로로 예제 세트를 만든다 (TU-3)', () => {
  let sampleId: string;
  let year1Id: string;

  beforeAll(async () => {
    const result = await help.createSampleProject(null);
    if (!result.ok) {
      // 부분 생성이면 projectId가 실려 온다 — 정리 대상에 넣고 원인을 드러낸다
      if ('projectId' in result) tempProjectIds.push(result.projectId);
      throw new Error(`예제 과제 생성 실패: ${result.error} (code=${result.code ?? '-'})`);
    }
    sampleId = result.data.projectId;
    tempProjectIds.push(sampleId);
    expect(result.data.created).toBe(true);

    const years = await yearsRepo.listYears(user.client, sampleId);
    const first = years[0];
    if (!first) throw new Error('예제 과제에 연차가 없습니다.');
    year1Id = first.id;
  });

  it('getTutorialStatus ①~⑦ 전부 true', async () => {
    expect(await status(sampleId)).toEqual({
      projectExists: true,
      steps: {
        project: true,
        years: true,
        team: true,
        wbs: true,
        goals: true,
        milestones: true,
        budget: true,
      },
    });
  });

  it('이름 `[예제] ` 접두 · 설명 첫 줄 · 협약 정보 · 연차 2', async () => {
    const project = await projectsRepo.getProjectById(user.client, sampleId);
    expect(project.name.startsWith(SAMPLE_PROJECT_PREFIX)).toBe(true);
    expect(project.description.split('\n')[0]).toBe(SAMPLE_DESCRIPTION_FIRST_LINE);
    expect(project).toMatchObject({
      ministry: '기후에너지환경부',
      agency: '한국에너지기술평가원',
      status: 'active',
      contractStartDate: '2026-01-01',
      contractEndDate: '2027-12-31',
      govBudget: 225_000_000,
      ownBudget: 100_000_000,
      totalBudget: 325_000_000,
    });

    const stages = await stagesRepo.listStages(user.client, sampleId);
    expect(stages).toHaveLength(1);
    const years = await yearsRepo.listYears(user.client, sampleId);
    expect(years.map((y) => [y.startDate, y.endDate])).toEqual([
      ['2026-01-01', '2026-12-31'],
      ['2027-01-01', '2027-12-31'],
    ]);
  });

  it('기관 2 — lead 1개가 projects.lead_org_id와 같다 (H-8), joint 1개', async () => {
    const project = await projectsRepo.getProjectById(user.client, sampleId);
    const orgs = await organizationsRepo.listOrganizations(user.client, sampleId);
    expect(orgs).toHaveLength(2);
    const leads = orgs.filter((o) => o.role === 'lead');
    expect(leads).toHaveLength(1);
    expect(leads[0]?.id).toBe(project.leadOrgId);
    expect(orgs.filter((o) => o.role === 'joint')).toHaveLength(1);
  });

  it('인력 4 — 기존 3·신규 1, 연봉 입력, PM 지정', async () => {
    const project = await projectsRepo.getProjectById(user.client, sampleId);
    const members = await membersRepo.listMembers(user.client, sampleId);
    expect(members).toHaveLength(4);
    expect(members.filter((m) => m.hireType === 'existing')).toHaveLength(3);
    expect(members.filter((m) => m.hireType === 'new')).toHaveLength(1);
    expect(members.every((m) => m.annualSalary !== null && m.annualSalary > 0)).toBe(true);
    expect(members.every((m) => m.orgId === project.leadOrgId)).toBe(true);

    const pm = members.find((m) => m.id === project.pmMemberId);
    expect(pm?.role).toBe('pm');
  });

  it('WBS 작업 8 · 최대 깊이 3 · 1차년도 · 담당자 지정', async () => {
    const tasks = await tasksRepo.listTasksByProject(user.client, sampleId);
    expect(tasks).toHaveLength(8);
    const byId = new Map(tasks.map((t) => [t.id, t]));
    expect(Math.max(...tasks.map((t) => depthOf(t, byId)))).toBe(3);
    expect(tasks.every((t) => t.yearId === year1Id)).toBe(true);
    expect(tasks.every((t) => t.ownerMemberId !== null)).toBe(true);
    expect(tasks.every((t) => t.estimatedHours !== null && t.estimatedHours > 0)).toBe(true);
  });

  it('성과목표 2 · 기술목표 1 · 마일스톤 ≥ 2', async () => {
    expect(await deliverablesRepo.listDeliverables(user.client, sampleId)).toHaveLength(2);
    const techTargets = await techTargetsRepo.listTechTargets(user.client, sampleId);
    expect(techTargets).toHaveLength(1);
    expect(techTargets[0]).toMatchObject({ direction: 'higher_better', baselineDomestic: 85 });
    expect((await milestonesRepo.listMilestones(user.client, sampleId)).length).toBeGreaterThanOrEqual(2);
  });

  it('산출근거 6행(인건비 4 + 회의비 1 + 간접비 1) · 규칙 = 부록 D.2 17행', async () => {
    const details = await budgetDetailsRepo.listByProject(user.client, sampleId);
    expect(details).toHaveLength(6);
    expect(details.every((d) => d.yearId === year1Id)).toBe(true);

    const personnel = details.filter((d) => d.category === 'personnel');
    expect(personnel).toHaveLength(4);
    expect(personnel.every((d) => d.formula === 'personnel' && d.memberId !== null)).toBe(true); // PL-D1
    expect(personnel.filter((d) => d.axis === 'cash')).toHaveLength(3);
    expect(personnel.filter((d) => d.axis === 'in_kind')).toHaveLength(1);
    // PL-D7: 서버가 연봉 × 참여율 × 12/12로 계산한 값 — 60M×40% + 48M×20% + 42M×30% + 54M×50%
    expect(personnel.reduce((sum, d) => sum + d.amount, 0)).toBe(73_200_000);

    expect(details.filter((d) => d.category === 'activity' && d.subcategory === 'activity_meeting')).toHaveLength(1);
    expect(details.find((d) => d.category === 'activity')?.amount).toBe(3_000_000); // 500,000 × 6
    expect(details.filter((d) => d.category === 'indirect' && d.subcategory === 'indirect_support')).toHaveLength(1);
    expect(details.find((d) => d.category === 'indirect')?.amount).toBe(2_000_000);

    const rules = await budgetRulesRepo.listByProject(user.client, sampleId);
    expect(RULE_PRESETS.moe_energy_sme.rules).toHaveLength(17);
    expect(rules).toHaveLength(RULE_PRESETS.moe_energy_sme.rules.length);
  });

  it('PL-10 — budget_items(1차년도, 인건비) 계획액 = 인건비 4행 amount 합', async () => {
    const details = await budgetDetailsRepo.listByProject(user.client, sampleId);
    const personnel = details.filter((d) => d.category === 'personnel');
    const items = await budgetItemsRepo.listBudgetItemsByYear(user.client, year1Id);
    const item = items.find((i) => i.category === 'personnel');
    if (!item) throw new Error('1차년도 인건비 비목 행이 없습니다.');

    expect(item.plannedAmount).toBe(personnel.reduce((sum, d) => sum + d.amount, 0));
    expect(item.cashAmount).toBe(
      personnel.filter((d) => d.axis === 'cash').reduce((sum, d) => sum + d.amount, 0)
    );
    expect(item.inKindAmount).toBe(
      personnel.filter((d) => d.axis === 'in_kind').reduce((sum, d) => sum + d.amount, 0)
    );
    expect(item.detailCount).toBe(4);
  });

  it('살아 있는 id로 다시 부르면 created:false — 과제 수 불변', async () => {
    const before = (await projectsRepo.listProjects(user.client)).length;
    const again = await help.createSampleProject(sampleId);
    if (!again.ok) throw new Error(`재호출 실패: ${again.error}`);
    expect(again.data).toEqual({ projectId: sampleId, created: false });
    expect((await projectsRepo.listProjects(user.client)).length).toBe(before);
  });
});
