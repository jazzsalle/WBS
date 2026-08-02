// 대시보드 집계 테스트 (SOT §7.2, §6.1, §6.2, §6.3, §6.4 B-1, §6.5, §6.9 PR-5·PR-9)
// 픽스처는 과제 3개다 — 그중 하나(p3)는 archived=true이며 어떤 집계에도 나타나면 안 된다.
// 기대값은 lib/{progress,goals,priority,risk,dates}.ts의 규칙으로 손계산해 고정한다.

import { describe, expect, it } from 'vitest';
import {
  computeDashboard,
  METRIC_MILESTONE_WINDOW_DAYS,
  type DashboardInput,
  type DashboardSettings,
} from '@/lib/dashboard';
// §6.4 집행률의 원본은 lib/budget.ts다 (대시보드는 호출만 한다)
import { computeExecutionRate } from '@/lib/budget';
import { computeDeliverableTotal, computeTechTargetTotal } from '@/lib/goals';
import { addDays } from '@/lib/dates';
import type {
  BudgetItem,
  Deliverable,
  DeliverableAchievement,
  Milestone,
  MilestoneStatus,
  MilestoneType,
  Project,
  ProjectStatus,
  Risk,
  RiskLevel,
  RiskStatus,
  Stage,
  Task,
  TaskStatus,
  TechTarget,
  TechTargetRecord,
  Todo,
  Year,
  YearStatus,
} from '@/types';

const TODAY = '2026-08-02';
const d = (offset: number): string => addDays(TODAY, offset);

// ─── 픽스처 헬퍼 ─────────────────────────────────────────────

function base(id: string) {
  return {
    id,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    version: 1,
    createdBy: null,
    updatedBy: null,
  };
}

function project(spec: {
  id: string;
  name: string;
  agency?: string;
  status?: ProjectStatus;
  archived?: boolean;
  order?: number;
}): Project {
  return {
    ...base(spec.id),
    name: spec.name,
    projectNo: '',
    ministry: '',
    agency: spec.agency ?? '',
    programName: '',
    description: '',
    status: spec.status ?? 'active',
    color: '#4f46e5',
    contractStartDate: null,
    contractEndDate: null,
    totalBudget: null,
    govBudget: null,
    ownBudget: null,
    pmMemberId: null,
    leadOrgId: null,
    archived: spec.archived ?? false,
    order: spec.order ?? 0,
  };
}

function stage(spec: { id: string; projectId: string; budget?: number | null }): Stage {
  return {
    ...base(spec.id),
    projectId: spec.projectId,
    order: 0,
    name: '1단계',
    goal: '',
    startDate: null,
    endDate: null,
    budget: spec.budget ?? null,
  };
}

function year(spec: {
  id: string;
  projectId: string;
  stageId: string;
  name?: string;
  status?: YearStatus;
  budget?: number | null;
  order?: number;
}): Year {
  return {
    ...base(spec.id),
    projectId: spec.projectId,
    stageId: spec.stageId,
    order: spec.order ?? 0,
    name: spec.name ?? '1차년도',
    goal: '',
    startDate: null,
    endDate: null,
    budget: spec.budget ?? null,
    status: spec.status ?? 'planned',
  };
}

function task(spec: {
  id: string;
  projectId: string;
  yearId: string;
  parentId?: string | null;
  title?: string;
  status?: TaskStatus;
  manualProgress?: number;
  importance?: Task['importance'];
  dueDate?: string | null;
  order?: number;
}): Task {
  return {
    ...base(spec.id),
    projectId: spec.projectId,
    yearId: spec.yearId,
    parentId: spec.parentId ?? null,
    order: spec.order ?? 0,
    title: spec.title ?? spec.id,
    description: '',
    status: spec.status ?? 'todo',
    // 부모 판정은 자식 유무로 하므로(P-6) 픽스처는 전부 auto로 둔다
    progressMode: 'auto',
    manualProgress: spec.manualProgress ?? 0,
    estimatedHours: null,
    actualHours: null,
    startDate: null,
    dueDate: spec.dueDate ?? null,
    importance: spec.importance ?? 3,
    urgencyMode: 'auto',
    urgencyManual: 3,
    ownerMemberId: null,
    memberIds: [],
    orgId: null,
    deliverableIds: [],
    techTargetIds: [],
    tags: [],
  };
}

function milestone(spec: {
  id: string;
  projectId: string;
  date: string;
  status?: MilestoneStatus;
  type?: MilestoneType;
  title?: string;
}): Milestone {
  return {
    ...base(spec.id),
    projectId: spec.projectId,
    yearId: null,
    type: spec.type ?? 'report',
    title: spec.title ?? spec.id,
    date: spec.date,
    status: spec.status ?? 'planned',
    ownerMemberId: null,
    description: '',
    resultNote: '',
  };
}

function risk(spec: {
  id: string;
  projectId: string;
  probability: RiskLevel;
  impact: RiskLevel;
  status: RiskStatus;
  dueDate?: string | null;
}): Risk {
  return {
    ...base(spec.id),
    projectId: spec.projectId,
    yearId: null,
    taskId: null,
    title: spec.id,
    category: 'technical',
    description: '',
    probability: spec.probability,
    impact: spec.impact,
    strategy: 'mitigate',
    response: '',
    contingency: '',
    ownerMemberId: null,
    dueDate: spec.dueDate ?? null,
    status: spec.status,
    order: 0,
  };
}

function budgetItem(spec: {
  id: string;
  projectId: string;
  yearId: string;
  planned: number;
  executions?: readonly number[];
}): BudgetItem {
  return {
    ...base(spec.id),
    projectId: spec.projectId,
    yearId: spec.yearId,
    category: 'personnel',
    plannedAmount: spec.planned,
    cashAmount: null,
    inKindAmount: null,
    executions: (spec.executions ?? []).map((amount, i) => ({
      id: `${spec.id}-e${i}`,
      version: 1,
      date: d(-10),
      amount,
      description: '',
      note: '',
    })),
    note: '',
  };
}

function achievement(id: string): DeliverableAchievement {
  return {
    id,
    version: 1,
    title: id,
    date: d(-10),
    yearId: null,
    orgId: null,
    memberIds: [],
    evidenceUrl: '',
    note: '',
  };
}

function deliverable(spec: {
  id: string;
  projectId: string;
  targetTotal: number;
  achieved?: number;
}): Deliverable {
  return {
    ...base(spec.id),
    projectId: spec.projectId,
    type: 'paper_sci',
    name: spec.id,
    unit: '건',
    targetTotal: spec.targetTotal,
    targetByYear: {},
    achievements: Array.from({ length: spec.achieved ?? 0 }, (_, i) =>
      achievement(`${spec.id}-a${i}`)
    ),
    orgId: null,
    note: '',
    order: 0,
  };
}

function techRecord(id: string, value: number): TechTargetRecord {
  return {
    id,
    version: 1,
    value,
    date: d(-5),
    yearId: null,
    method: 'self',
    evaluator: '',
    evidenceUrl: '',
    note: '',
  };
}

function techTarget(spec: {
  id: string;
  projectId: string;
  weight: number;
  targetValue: number;
  baselineDomestic?: number | null;
  records?: readonly TechTargetRecord[];
}): TechTarget {
  return {
    ...base(spec.id),
    projectId: spec.projectId,
    name: spec.id,
    unit: '%',
    direction: 'higher_better',
    weight: spec.weight,
    targetValue: spec.targetValue,
    targetByYear: {},
    baselineDomestic: spec.baselineDomestic ?? null,
    worldBest: null,
    worldBestHolder: '',
    measureMethod: 'self',
    measureDescription: '',
    records: [...(spec.records ?? [])],
    orgId: null,
    order: 0,
  };
}

function todo(spec: {
  id: string;
  done?: boolean;
  dueDate: string | null;
  priority?: Todo['priority'];
  projectId?: string | null;
  order?: number;
}): Todo {
  return {
    ...base(spec.id),
    title: spec.id,
    done: spec.done ?? false,
    projectId: spec.projectId ?? null,
    dueDate: spec.dueDate,
    priority: spec.priority ?? 'normal',
    order: spec.order ?? 0,
    completedAt: null,
  };
}

// ─── 픽스처 ──────────────────────────────────────────────────
// p1(진행 중) / p2(계획) / p3(아카이브). p3에는 모든 종류의 눈에 띄는 데이터를 심어
// "아카이브 제외"가 빠짐없이 걸리는지 본다.

const SETTINGS: DashboardSettings = {
  progressWeightBasis: 'budget',
  milestoneAlertDays: 7,
  dueSoonDays: 7,
  currencyUnit: '천원',
};

const projects: Project[] = [
  project({ id: 'p1', name: '과제 A', agency: 'IITP', status: 'active', order: 0 }),
  project({ id: 'p2', name: '과제 B', agency: 'KEIT', status: 'planning', order: 1 }),
  project({ id: 'p3', name: '보관 과제', agency: 'NRF', status: 'active', archived: true, order: 2 }),
];

const stages: Stage[] = [
  stage({ id: 's1', projectId: 'p1', budget: 1000 }),
  stage({ id: 's2', projectId: 'p2' }),
  stage({ id: 's3', projectId: 'p3', budget: 500 }),
];

const years: Year[] = [
  year({ id: 'y1', projectId: 'p1', stageId: 's1', status: 'active', budget: 1000 }),
  year({ id: 'y2', projectId: 'p2', stageId: 's2', status: 'planned' }),
  year({ id: 'y3', projectId: 'p3', stageId: 's3', status: 'active' }),
];

const tasks: Task[] = [
  // p1: 부모 1 + 리프 3 → 연차 진척률 (40 + 100 + 0) / 3
  task({ id: 'p1-parent', projectId: 'p1', yearId: 'y1', importance: 5, dueDate: d(1), status: 'in_progress' }),
  task({
    id: 'p1-a',
    projectId: 'p1',
    yearId: 'y1',
    parentId: 'p1-parent',
    status: 'in_progress',
    manualProgress: 40,
    importance: 5,
    dueDate: d(1), // 긴급도 5 → 점수 25
  }),
  task({ id: 'p1-b', projectId: 'p1', yearId: 'y1', parentId: 'p1-parent', status: 'done' }),
  task({
    id: 'p1-over',
    projectId: 'p1',
    yearId: 'y1',
    parentId: 'p1-parent',
    status: 'in_progress',
    importance: 1,
    dueDate: d(-1), // 지연 → 긴급도 5 → 점수 5
  }),

  // p2: 전부 리프
  task({ id: 'p2-c', projectId: 'p2', yearId: 'y2', status: 'in_progress', importance: 3, dueDate: d(2) }), // 15
  task({ id: 'p2-d', projectId: 'p2', yearId: 'y2', status: 'blocked', importance: 5, dueDate: d(-2) }), // 지연 + blocked
  task({ id: 'p2-e', projectId: 'p2', yearId: 'y2', status: 'todo', importance: 3, dueDate: d(5) }), // 12
  task({ id: 'p2-f', projectId: 'p2', yearId: 'y2', status: 'todo', importance: 1, dueDate: null }), // 2
  task({ id: 'p2-g', projectId: 'p2', yearId: 'y2', status: 'todo', importance: 1, dueDate: null }), // 2

  // p3(아카이브): 최우선 점수·지연·blocked를 모두 갖췄지만 어디에도 나오면 안 된다
  task({
    id: 'p3-x',
    projectId: 'p3',
    yearId: 'y3',
    status: 'in_progress',
    manualProgress: 100,
    importance: 5,
    dueDate: d(1),
  }),
  task({ id: 'p3-y', projectId: 'p3', yearId: 'y3', status: 'blocked', dueDate: d(-5) }),
];

const milestones: Milestone[] = [
  milestone({ id: 'm-past', projectId: 'p1', date: d(-3) }),
  milestone({ id: 'm-a', projectId: 'p1', date: d(5), type: 'annual_eval' }),
  milestone({ id: 'm-done', projectId: 'p1', date: d(5), status: 'done' }),
  milestone({ id: 'm-30', projectId: 'p1', date: d(METRIC_MILESTONE_WINDOW_DAYS) }),
  milestone({ id: 'm-31', projectId: 'p1', date: d(METRIC_MILESTONE_WINDOW_DAYS + 1) }),
  milestone({ id: 'm-7', projectId: 'p2', date: d(7), status: 'preparing' }),
  milestone({ id: 'm-8', projectId: 'p2', date: d(8) }),
  milestone({ id: 'm-p3', projectId: 'p3', date: d(2) }),
];

const risks: Risk[] = [
  risk({ id: 'r-high', projectId: 'p1', probability: 5, impact: 4, status: 'identified' }), // 20 → high
  risk({ id: 'r-resolved', projectId: 'p1', probability: 5, impact: 3, status: 'resolved' }), // 해결됨 → 등급 없음
  risk({ id: 'r-occurred', projectId: 'p2', probability: 3, impact: 3, status: 'occurred' }), // 9지만 발생
  risk({ id: 'r-p3', projectId: 'p3', probability: 5, impact: 5, status: 'identified' }),
];

const budgetItems: BudgetItem[] = [
  budgetItem({ id: 'b1', projectId: 'p1', yearId: 'y1', planned: 10_000_000, executions: [2_000_000, 500_000] }),
  budgetItem({ id: 'b2', projectId: 'p1', yearId: 'y1', planned: 0 }),
  // B-1: 계획 0 + 집행 있음 → 집행률 N/A + "예산 외 집행" 경고
  budgetItem({ id: 'b3', projectId: 'p2', yearId: 'y2', planned: 0, executions: [1_000_000] }),
  budgetItem({ id: 'b4', projectId: 'p3', yearId: 'y3', planned: 999_999 }),
];

const deliverables: Deliverable[] = [
  deliverable({ id: 'd1', projectId: 'p1', targetTotal: 4, achieved: 3 }), // 75%
  deliverable({ id: 'd2', projectId: 'p2', targetTotal: 0 }), // D-1 → N/A
  deliverable({ id: 'd3', projectId: 'p3', targetTotal: 1, achieved: 1 }),
];

const techTargets: TechTarget[] = [
  techTarget({
    id: 't1',
    projectId: 'p1',
    weight: 60,
    targetValue: 100,
    baselineDomestic: 0,
    records: [techRecord('t1-r1', 50)], // 달성률 50
  }),
  techTarget({ id: 't2', projectId: 'p1', weight: 40, targetValue: 10 }), // 미측정 → 0, 분모 포함
  techTarget({
    id: 't3',
    projectId: 'p3',
    weight: 100,
    targetValue: 10,
    baselineDomestic: 0,
    records: [techRecord('t3-r1', 10)],
  }),
];

const todos: Todo[] = [
  todo({ id: 'todo-a', dueDate: TODAY, priority: 'normal', projectId: 'p1', order: 0 }),
  todo({ id: 'todo-b', dueDate: d(-1), priority: 'low', order: 1 }),
  todo({ id: 'todo-c', dueDate: d(1), order: 2 }),
  todo({ id: 'todo-d', done: true, dueDate: d(-5), order: 3 }),
  todo({ id: 'todo-e', dueDate: null, order: 4 }),
  todo({ id: 'todo-f', dueDate: TODAY, priority: 'high', order: 5 }),
  todo({ id: 'todo-g', dueDate: d(-1), projectId: 'p3', order: 6 }),
];

const input: DashboardInput = {
  projects,
  stages,
  years,
  tasks,
  milestones,
  risks,
  budgetItems,
  deliverables,
  techTargets,
  todos,
  todayISO: TODAY,
  settings: SETTINGS,
};

const data = computeDashboard(input);

// p1 연차 진척률 = (40 + 100 + 0) / 3 (P-1: done 리프는 100)
const P1_PROGRESS = 140 / 3;

// ─── 테스트 ──────────────────────────────────────────────────

describe('아카이브 과제 제외 (§7.2)', () => {
  it('요약 카드에 아카이브 과제가 없다', () => {
    expect(data.projectCards.map((c) => c.projectId)).toEqual(['p1', 'p2']);
  });

  it('마일스톤 타임라인·집중 작업·주의 필요·To-Do 어디에도 p3가 없다', () => {
    expect(data.upcomingMilestones.some((m) => m.projectId === 'p3')).toBe(false);
    expect(data.focusTasks.some((t) => t.projectId === 'p3')).toBe(false);
    expect(data.attention.some((a) => a.projectId === 'p3')).toBe(false);
    // To-Do는 과제에 매이지 않지만 projectId가 아카이브 과제를 가리키면 빠진다
    expect(data.todayTodos.some((t) => t.id === 'todo-g')).toBe(false);
  });

  it('지표도 아카이브 과제를 세지 않는다', () => {
    // p3는 status='active'이고 최우선 작업·고위험 리스크·임박 마일스톤을 모두 갖고 있다
    expect(data.metrics.activeProjectCount).toBe(1);
    expect(data.metrics.averageProgressProjectCount).toBe(2);
    expect(data.metrics.highRiskCount).toBe(1);
  });

  it('아카이브만 있으면 평균 진척률은 N/A(null)다', () => {
    const onlyArchived = computeDashboard({
      ...input,
      projects: projects.filter((p) => p.archived),
    });
    expect(onlyArchived.metrics.averageProgress).toBeNull();
    expect(onlyArchived.projectCards).toEqual([]);
  });
});

describe('지표 카드 5개 (§7.2 1)', () => {
  it('① 진행 중 과제 수 = archived=false AND status=active', () => {
    expect(data.metrics.activeProjectCount).toBe(1);
  });

  it('② 평균 진척률 = 아카이브 제외 전 과제의 §6.1 ④ 산술평균', () => {
    expect(data.metrics.averageProgress).toBeCloseTo((P1_PROGRESS + 0) / 2, 10);
  });

  it('③ 30일 내 마일스톤 수는 D+30을 포함하고 D+31을 뺀다 (설정과 무관한 고정 창)', () => {
    expect(data.metrics.milestoneMetricWindowDays).toBe(30);
    // m-a(+5), m-7(+7), m-8(+8), m-30(+30). m-31·완료·지난 것·아카이브는 제외
    expect(data.metrics.milestonesWithin30Days).toBe(4);
    // 임박 타임라인(milestoneAlertDays=7)과 모집단이 다르다는 것을 함께 고정한다
    expect(data.settings.milestoneAlertDays).toBe(7);
  });

  it('④ 최우선 작업 수는 점수 15를 포함하고 그 아래는 뺀다', () => {
    // p1-a=25, p2-c=15 → 2건. p2-e=12는 '높음' 구간이라 제외.
    // (점수는 importance×urgency라 1~5의 곱이다 — 14는 나올 수 없고 15 아래 최댓값은 12다)
    expect(data.metrics.topPriorityTaskCount).toBe(2);
  });

  it('④ 카드 숫자와 집중 작업 목록이 같은 모집단이다', () => {
    const topInList = data.focusTasks.filter((t) => t.grade === '최우선');
    expect(topInList.map((t) => t.id)).toEqual(['p1-a', 'p2-c']);
    expect(topInList).toHaveLength(data.metrics.topPriorityTaskCount);
  });

  it('⑤ 고위험 리스크 수 = riskSeverity high (해결된 리스크는 등급 없음)', () => {
    expect(data.metrics.highRiskCount).toBe(1);
  });
});

describe('과제 요약 카드 (§7.2 2)', () => {
  const p1 = data.projectCards[0]!;
  const p2 = data.projectCards[1]!;

  it('과제명·전문기관·현재 연차 뱃지', () => {
    expect(p1.name).toBe('과제 A');
    expect(p1.agency).toBe('IITP');
    expect(p1.currentYear).toEqual({ id: 'y1', name: '1차년도', order: 0 });
    // active 연차가 없으면 뱃지도 없다
    expect(p2.currentYear).toBeNull();
  });

  it('진척률은 §6.1 ④ 롤업 결과다', () => {
    expect(p1.progress).toBeCloseTo(P1_PROGRESS, 10);
    expect(p2.progress).toBe(0);
  });

  it('성과·기술목표 달성률이 lib/goals.ts 결과와 일치한다', () => {
    expect(p1.deliverableRate).toBe(computeDeliverableTotal([deliverables[0]!]).rate);
    expect(p1.deliverableRate).toBe(75);
    // D-1: targetTotal 0이면 N/A
    expect(p2.deliverableRate).toBeNull();

    expect(p1.techTargetRate).toBe(
      computeTechTargetTotal([techTargets[0]!, techTargets[1]!]).weightedRate
    );
    expect(p1.techTargetRate).toBeCloseTo(30, 10); // (50×60 + 0×40) / 100
    // 기술목표가 없으면 가중치 합이 0이라 N/A
    expect(p2.techTargetRate).toBeNull();
  });

  it('예산 집행률 — B-1: 계획 0이면 N/A, 집행이 있으면 예산 외 집행 경고', () => {
    expect(p1.budget.planned).toBe(10_000_000);
    expect(p1.budget.executed).toBe(2_500_000);
    expect(p1.budget.rate).toBe(25);
    expect(p1.budget.offBudgetExecution).toBe(false);

    expect(p2.budget.planned).toBe(0);
    expect(p2.budget.executed).toBe(1_000_000);
    expect(p2.budget.rate).toBeNull();
    expect(p2.budget.offBudgetExecution).toBe(true);
  });

  it('다음 마일스톤 D-day는 오늘 이후 최근접 미완료 건이다', () => {
    // m-past(지난 것)·m-done(완료)은 후보가 아니다
    expect(p1.nextMilestone?.id).toBe('m-a');
    expect(p1.nextMilestone?.dday).toBe('D-5');
    expect(p2.nextMilestone?.id).toBe('m-7');
  });
});

describe('임박 마일스톤 타임라인 (§7.2 3)', () => {
  it('milestoneAlertDays 이내만 날짜 오름차순으로 담는다', () => {
    expect(data.upcomingMilestones.map((m) => m.id)).toEqual(['m-a', 'm-7']);
  });

  it('항목마다 과제명·유형·D-day를 싣는다', () => {
    const first = data.upcomingMilestones[0]!;
    expect(first.projectName).toBe('과제 A');
    expect(first.type).toBe('annual_eval');
    expect(first.dday).toBe('D-5');
    expect(first.daysLeft).toBe(5);
  });
});

describe('오늘 집중할 작업 (§7.2 4, PR-9)', () => {
  it('리프만 담고 done·blocked는 뺀다', () => {
    const ids = data.focusTasks.map((t) => t.id);
    expect(ids).not.toContain('p1-parent'); // 부모는 실행 단위가 아니다 (PR-9)
    expect(ids).not.toContain('p1-b'); // done
    expect(ids).not.toContain('p2-d'); // blocked
  });

  it('점수 내림차순 상위 5건, 동점은 마감일 → id로 결정론적이다', () => {
    // 후보 6건: p1-a(25) p2-c(15) p2-e(12) p1-over(5) p2-f(2) p2-g(2)
    expect(data.focusTasks.map((t) => t.id)).toEqual(['p1-a', 'p2-c', 'p2-e', 'p1-over', 'p2-f']);
    expect(data.focusTasks.map((t) => t.score)).toEqual([25, 15, 12, 5, 2]);
  });

  it('과제명·마감일·등급을 함께 싣는다', () => {
    const first = data.focusTasks[0]!;
    expect(first.projectName).toBe('과제 A');
    expect(first.dueDate).toBe(d(1));
    expect(first.dday).toBe('D-1');
    expect(first.grade).toBe('최우선');
    // 마감이 없으면 D-day도 없다
    expect(data.focusTasks[4]!.dday).toBeNull();
  });
});

describe('주의 필요 (§7.2 5)', () => {
  it('지연 ∪ blocked ∪ 고위험 ∪ 발생 리스크의 합집합이다', () => {
    expect(data.attention.map((a) => a.id).sort()).toEqual(
      ['p1-over', 'p2-d', 'r-high', 'r-occurred'].sort()
    );
  });

  it('한 항목이 두 종류에 해당해도 한 번만 담는다', () => {
    const ids = data.attention.map((a) => a.id);
    expect(new Set(ids).size).toBe(ids.length);

    // p2-d는 지연이면서 blocked다 (PR-5)
    const blocked = data.attention.find((a) => a.id === 'p2-d')!;
    expect(blocked.kinds).toEqual(['overdue_task', 'blocked_task']);
    expect(blocked.daysOverdue).toBe(2);
  });

  it('해결된 리스크는 들어오지 않고, 발생한 리스크는 점수와 무관하게 들어온다', () => {
    expect(data.attention.some((a) => a.id === 'r-resolved')).toBe(false);
    const occurred = data.attention.find((a) => a.id === 'r-occurred')!;
    expect(occurred.kind).toBe('occurred_risk');
    expect(occurred.score).toBe(9); // 고위험 구간이 아니어도 포함
  });
});

describe('오늘의 To-Do (§7.2 6)', () => {
  it('미완료 + 마감일이 오늘 이하인 것만 담는다', () => {
    expect(data.todayTodos.map((t) => t.id)).toEqual(['todo-b', 'todo-f', 'todo-a']);
  });

  it('마감일 오름차순 → priority(high>normal>low) 순이다', () => {
    expect(data.todayTodos.map((t) => t.dueDate)).toEqual([d(-1), TODAY, TODAY]);
    expect(data.todayTodos.map((t) => t.priority)).toEqual(['low', 'high', 'normal']);
  });

  it('과제 연결이 있으면 과제명을 싣는다', () => {
    expect(data.todayTodos.find((t) => t.id === 'todo-a')!.projectName).toBe('과제 A');
    expect(data.todayTodos.find((t) => t.id === 'todo-b')!.projectName).toBeNull();
  });
});

describe('computeExecutionRate (§6.4 B-1)', () => {
  it('계획액 0이면 null, 아니면 백분율', () => {
    expect(computeExecutionRate(0, 0)).toBeNull();
    expect(computeExecutionRate(0, 100)).toBeNull();
    expect(computeExecutionRate(1000, 250)).toBe(25);
    // B-2: 100% 초과도 그대로 돌려준다 (경고는 표시 단계의 몫)
    expect(computeExecutionRate(1000, 1200)).toBe(120);
  });
});

describe('기준일 전달 (§6.5)', () => {
  it('입력받은 기준일을 그대로 실어 클라이언트가 오늘을 다시 만들지 않게 한다', () => {
    expect(data.todayISO).toBe(TODAY);
  });
});
