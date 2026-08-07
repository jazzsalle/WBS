// 대시보드 집계 (SOT §7.2, §9 getDashboardData)
// 부수효과 없는 순수 함수다. 파생 값은 저장하지 않고 읽을 때 계산한다.
//
// 계산식을 여기서 다시 쓰지 않는다 — 진척률 §6.1은 lib/progress.ts, 달성률 §6.2·§6.3은
// lib/goals.ts, 집행률 §6.4는 lib/budget.ts, 마감·임박 판정 §6.5는 lib/dates.ts,
// 리스크 등급 §6.5는 lib/risk.ts, 우선순위 §6.9는 lib/priority.ts,
// 트리 구성 §6.6은 lib/tree.ts, To-Do 필터·정렬 §7.13은 lib/todos.ts가 원본이다.
// 단위 테스트: tests/unit/dashboard.test.ts

import { buildTaskTree } from './tree';
import { computeProjectProgress, computeStageProgress, computeYearProgress } from './progress';
import { computeDeliverableTotal, computeTechTargetTotal } from './goals';
import { computeProjectSummary } from './budget';
import { computePriorityScore, computeUrgency, priorityGrade, type PriorityGrade } from './priority';
import { daysBetween, formatDday, isOverdueTask, isUpcomingMilestone } from './dates';
import { needsAttention, riskScore, riskSeverity } from './risk';
import { filterTodos, sortTodos } from './todos';
import type {
  BudgetItem,
  Deliverable,
  Milestone,
  MilestoneType,
  Project,
  Risk,
  RiskStatus,
  Settings,
  Stage,
  Task,
  TaskStatus,
  TechTarget,
  Todo,
  Year,
} from '@/types';

// §7.2 지표 카드 ③의 "30일"은 문구에 박힌 고정값이다. settings.milestoneAlertDays(임박
// 타임라인 기준)와 별개이므로 화면이 툴팁으로 그 사실을 밝힐 수 있게 함께 내보낸다.
export const METRIC_MILESTONE_WINDOW_DAYS = 30;

// "다음 마일스톤"(요약 카드)은 §6.5 upcoming 판정에서 기간 상한만 없앤 것이다.
// {done, cancelled} 제외 규칙을 여기서 다시 쓰지 않으려고 상한을 사실상 무한으로 넘긴다.
const NO_WINDOW_LIMIT = Number.MAX_SAFE_INTEGER;

/** §7.2 "오늘 집중할 작업"은 상위 5건 */
export const FOCUS_TASK_LIMIT = 5;

// ─── 입력 ────────────────────────────────────────────────────

export type DashboardSettings = Pick<
  Settings,
  'progressWeightBasis' | 'milestoneAlertDays' | 'dueSoonDays' | 'currencyUnit'
>;

export interface DashboardInput {
  /** 아카이브 과제를 포함한 전체 목록. 제외 판정은 이 함수가 한다 (§7.2) */
  projects: readonly Project[];
  stages: readonly Stage[];
  years: readonly Year[];
  tasks: readonly Task[];
  milestones: readonly Milestone[];
  risks: readonly Risk[];
  budgetItems: readonly BudgetItem[];
  deliverables: readonly Deliverable[];
  techTargets: readonly TechTarget[];
  todos: readonly Todo[];
  /** 기준일. 호출자가 todayISO(new Date())로 만들어 넘긴다 (§6.5 Asia/Seoul 고정) */
  todayISO: string;
  settings: DashboardSettings;
}

// ─── 출력 ────────────────────────────────────────────────────

export interface DashboardMetrics {
  /** ① archived=false AND status='active' */
  activeProjectCount: number;
  /** ② 아카이브 제외 전 과제의 §6.1 ④ 진척률 산술평균. 모집단이 0이면 null(N/A) */
  averageProgress: number | null;
  /** ② 모집단 크기 — 카드가 "아카이브 제외 전 과제 N개"를 밝힐 수 있게 */
  averageProgressProjectCount: number;
  /** ③ 0 ≤ date - today ≤ 30 AND status ∉ {done, cancelled}. 설정과 무관한 고정 창이다 */
  milestonesWithin30Days: number;
  /** ③ 툴팁이 "설정(milestoneAlertDays)과 별개"임을 말할 수 있게 창 길이를 함께 싣는다 */
  milestoneMetricWindowDays: number;
  /** ④ 점수 15+ 리프 작업 수. focusTasks와 같은 모집단이라 카드와 목록이 어긋나지 않는다 */
  topPriorityTaskCount: number;
  /** ⑤ riskSeverity === 'high' */
  highRiskCount: number;
}

export interface MilestoneRef {
  id: string;
  title: string;
  type: MilestoneType;
  date: string;
  /** 'D-3' / 'D-DAY' / 'D+2' (§6.5 formatDday) */
  dday: string;
  /** 오늘로부터 남은 일수. 과거면 음수 */
  daysLeft: number;
}

export interface ProjectBudgetSummary {
  planned: number;
  executed: number;
  /** B-1: planned 합계가 0이면 null(N/A) */
  rate: number | null;
  /** B-1: 계획 0인데 집행이 있는 "예산 외 집행" 경고 */
  offBudgetExecution: boolean;
}

export interface ProjectSummaryCard {
  projectId: string;
  name: string;
  /** 전문기관 */
  agency: string;
  color: string;
  status: Project['status'];
  /** status='active'인 연차. 없으면 null */
  currentYear: { id: string; name: string; order: number } | null;
  /** §6.1 ④ 과제 진척률 */
  progress: number;
  /** §6.2 과제 전체 성과목표 달성률. D-1이면 null */
  deliverableRate: number | null;
  /** §6.3 가중 달성률. 가중치 합이 0이면 null */
  techTargetRate: number | null;
  budget: ProjectBudgetSummary;
  /** date ≥ today이고 status ∉ {done, cancelled}인 것 중 최근접 */
  nextMilestone: MilestoneRef | null;
}

export interface UpcomingMilestoneItem extends MilestoneRef {
  projectId: string;
  projectName: string;
  status: Milestone['status'];
}

export interface FocusTaskItem {
  id: string;
  projectId: string;
  projectName: string;
  title: string;
  dueDate: string | null;
  /** 마감이 없으면 null */
  dday: string | null;
  status: TaskStatus;
  importance: Task['importance'];
  urgency: Task['importance'];
  score: number;
  grade: PriorityGrade;
  /** 부록 A.3 등급 색상 */
  color: string;
}

// §7.2 "주의 필요" 통합 리스트의 항목 종류.
// 지연+blocked, 고위험+발생처럼 한 항목이 두 종류에 동시에 해당할 수 있다.
export type AttentionKind = 'occurred_risk' | 'high_risk' | 'overdue_task' | 'blocked_task';

export interface AttentionItem {
  entity: 'task' | 'risk';
  id: string;
  /** 대표 종류(정렬·아이콘용). kinds 중 KIND_ORDER가 가장 앞선 것 */
  kind: AttentionKind;
  /** 해당하는 종류 전부. 같은 항목을 두 번 싣지 않기 위해 배열로 담는다 */
  kinds: AttentionKind[];
  projectId: string;
  projectName: string;
  title: string;
  dueDate: string | null;
  /** 지연 작업만. 오늘 기준 며칠 지났는지 */
  daysOverdue: number | null;
  /** 리스크만. probability × impact */
  score: number | null;
  status: TaskStatus | RiskStatus;
}

export interface TodayTodoItem {
  id: string;
  title: string;
  dueDate: string;
  dday: string;
  priority: Todo['priority'];
  projectId: string | null;
  projectName: string | null;
}

export interface DashboardData {
  /** 기준일. 클라이언트 컴포넌트는 오늘을 스스로 만들지 않고 이 값을 쓴다 (§6.5) */
  todayISO: string;
  settings: DashboardSettings;
  metrics: DashboardMetrics;
  projectCards: ProjectSummaryCard[];
  upcomingMilestones: UpcomingMilestoneItem[];
  focusTasks: FocusTaskItem[];
  attention: AttentionItem[];
  todayTodos: TodayTodoItem[];
}

// ─── 보조 순수 함수 ──────────────────────────────────────────

function groupBy<T>(items: readonly T[], keyOf: (item: T) => string): Map<string, T[]> {
  const map = new Map<string, T[]>();
  for (const item of items) {
    const key = keyOf(item);
    const bucket = map.get(key);
    if (bucket) bucket.push(item);
    else map.set(key, [item]);
  }
  return map;
}

function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

// 마감 없는 항목은 뒤로 — "언젠가"가 "오늘"보다 앞설 수는 없다
function compareDueDate(a: string | null, b: string | null): number {
  if (a === b) return 0;
  if (a === null) return 1;
  if (b === null) return -1;
  return compareText(a, b);
}

function toMilestoneRef(milestone: Milestone, today: string): MilestoneRef {
  return {
    id: milestone.id,
    title: milestone.title,
    type: milestone.type,
    date: milestone.date,
    dday: formatDday(today, milestone.date),
    daysLeft: daysBetween(today, milestone.date),
  };
}

// §6.1 ②③④: 연차 → 단계 → 과제 롤업. P-13에 따라 작업이 없는 연차도 진척률 0으로 분모에 든다.
function computeProgressOfProject(
  stages: readonly Stage[],
  yearsByStage: Map<string, Year[]>,
  tasksByYear: Map<string, Task[]>,
  basis: Settings['progressWeightBasis']
): number {
  const stageEntries = stages.map((stage) => {
    const yearEntries = (yearsByStage.get(stage.id) ?? []).map((year) => ({
      // buildTaskTree의 TaskNode는 ProgressNode를 구조적으로 만족한다 (lib/progress.ts 주석)
      progress: computeYearProgress(buildTaskTree(tasksByYear.get(year.id) ?? []).roots),
      budget: year.budget,
    }));
    return { progress: computeStageProgress(yearEntries, basis), budget: stage.budget };
  });
  return computeProjectProgress(stageEntries, basis);
}

// PR-9: 자식이 하나도 없는 Task만 실행 단위다. 부모 판정은 트리를 세우지 않고 parentId만 본다 —
// 부모 사슬이 끊긴 Task도 집계에서 조용히 사라지지 않게 하기 위함이다.
function collectParentIds(tasks: readonly Task[]): Set<string> {
  const parentIds = new Set<string>();
  for (const task of tasks) {
    if (task.parentId !== null) parentIds.add(task.parentId);
  }
  return parentIds;
}

// 대표 종류 결정 순서. 리스크가 작업보다 앞이고, 이미 터진 일이 아직 안 터진 일보다 앞이다.
const ATTENTION_KIND_ORDER: readonly AttentionKind[] = [
  'occurred_risk',
  'high_risk',
  'overdue_task',
  'blocked_task',
];

function kindRank(kind: AttentionKind): number {
  return ATTENTION_KIND_ORDER.indexOf(kind);
}

// ─── 집계 ────────────────────────────────────────────────────

export function computeDashboard(input: DashboardInput): DashboardData {
  const today = input.todayISO;
  const basis = input.settings.progressWeightBasis;

  // §7.2 마지막 줄: 아카이브 과제는 모든 집계에서 제외한다. 여기 한 곳에서 걸러
  // 아래 모든 목록이 같은 모집단을 보게 한다.
  const projects = input.projects.filter((p) => !p.archived);
  const projectIds = new Set(projects.map((p) => p.id));
  const projectNameById = new Map(input.projects.map((p) => [p.id, p.name]));
  const inScope = (projectId: string): boolean => projectIds.has(projectId);

  const stagesByProject = groupBy(input.stages, (s) => s.projectId);
  const yearsByStage = groupBy(input.years, (y) => y.stageId);
  const yearsByProject = groupBy(input.years, (y) => y.projectId);
  const tasksByYear = groupBy(input.tasks, (t) => t.yearId);
  const milestonesByProject = groupBy(input.milestones, (m) => m.projectId);
  const budgetItemsByProject = groupBy(input.budgetItems, (b) => b.projectId);
  const deliverablesByProject = groupBy(input.deliverables, (d) => d.projectId);
  const techTargetsByProject = groupBy(input.techTargets, (t) => t.projectId);

  const tasks = input.tasks.filter((t) => inScope(t.projectId));
  const milestones = input.milestones.filter((m) => inScope(m.projectId));
  const risks = input.risks.filter((r) => inScope(r.projectId));

  // ─ 과제 요약 카드 (§7.2 2) ─
  const projectCards: ProjectSummaryCard[] = projects.map((project) => {
    const stages = stagesByProject.get(project.id) ?? [];
    const progress = computeProgressOfProject(stages, yearsByStage, tasksByYear, basis);

    // 과제당 active 연차는 1개다 (§9 setYearStatus). 데이터가 어긋나도 화면이 흔들리지 않게
    // order가 가장 앞선 것을 고른다.
    const currentYear =
      (yearsByProject.get(project.id) ?? [])
        .filter((y) => y.status === 'active')
        .sort((a, b) => a.order - b.order || compareText(a.id, b.id))[0] ?? null;

    const deliverableRate = computeDeliverableTotal(deliverablesByProject.get(project.id) ?? []).rate;
    const techTargetRate = computeTechTargetTotal(techTargetsByProject.get(project.id) ?? []).weightedRate;

    // §6.4는 lib/budget.ts가 원본이다. 금액은 원 단위 정수 그대로 — 환산은 표시 단계에서만 (B-4)
    const budgetSummary = computeProjectSummary(budgetItemsByProject.get(project.id) ?? []);

    const nextMilestone =
      (milestonesByProject.get(project.id) ?? [])
        .filter((m) => isUpcomingMilestone(m, today, NO_WINDOW_LIMIT))
        .sort((a, b) => compareText(a.date, b.date) || compareText(a.id, b.id))[0] ?? null;

    return {
      projectId: project.id,
      name: project.name,
      agency: project.agency,
      color: project.color,
      status: project.status,
      currentYear:
        currentYear === null
          ? null
          : { id: currentYear.id, name: currentYear.name, order: currentYear.order },
      progress,
      deliverableRate,
      techTargetRate,
      budget: {
        planned: budgetSummary.planned,
        executed: budgetSummary.executed,
        rate: budgetSummary.rate,
        offBudgetExecution: budgetSummary.offBudget,
      },
      nextMilestone: nextMilestone === null ? null : toMilestoneRef(nextMilestone, today),
    };
  });

  // ─ 임박 마일스톤 타임라인 (§7.2 3) ─
  const upcomingMilestones: UpcomingMilestoneItem[] = milestones
    .filter((m) => isUpcomingMilestone(m, today, input.settings.milestoneAlertDays))
    .sort((a, b) => compareText(a.date, b.date) || compareText(a.id, b.id))
    .map((m) => ({
      ...toMilestoneRef(m, today),
      projectId: m.projectId,
      projectName: projectNameById.get(m.projectId) ?? '',
      status: m.status,
    }));

  // ─ 오늘 집중할 작업 (§7.2 4) + 지표 ④ ─
  // 카드 숫자와 목록이 어긋나면 안 되므로 같은 모집단에서 뽑는다.
  const parentIds = collectParentIds(input.tasks);
  const focusCandidates = tasks
    .filter((t) => !parentIds.has(t.id)) // PR-9: 리프만
    .filter((t) => t.status !== 'done' && t.status !== 'blocked')
    .map((task) => ({ task, score: computePriorityScore(task, today) }));

  const focusTasks: FocusTaskItem[] = focusCandidates
    .sort(
      (a, b) =>
        b.score - a.score ||
        compareDueDate(a.task.dueDate, b.task.dueDate) ||
        compareText(a.task.id, b.task.id)
    )
    .slice(0, FOCUS_TASK_LIMIT)
    .map(({ task, score }) => {
      const { grade, color } = priorityGrade(score);
      return {
        id: task.id,
        projectId: task.projectId,
        projectName: projectNameById.get(task.projectId) ?? '',
        title: task.title,
        dueDate: task.dueDate,
        dday: task.dueDate === null ? null : formatDday(today, task.dueDate),
        status: task.status,
        importance: task.importance,
        urgency: computeUrgency(task, today),
        score,
        grade,
        color,
      };
    });

  // §7.2 지표 ④ "점수 15+" = 부록 A.3의 '최우선' 구간. 경계값을 여기서 다시 쓰지 않는다.
  const topPriorityTaskCount = focusCandidates.filter(
    (c) => priorityGrade(c.score).grade === '최우선'
  ).length;

  // ─ 주의 필요 (§7.2 5) ─
  const attention: AttentionItem[] = [];

  for (const task of tasks) {
    const kinds: AttentionKind[] = [];
    if (isOverdueTask(task, today)) kinds.push('overdue_task');
    // PR-5: blocked는 마감과 무관하게 항상 포함한다
    if (task.status === 'blocked') kinds.push('blocked_task');
    if (kinds.length === 0) continue;
    kinds.sort((a, b) => kindRank(a) - kindRank(b));
    attention.push({
      entity: 'task',
      id: task.id,
      kind: kinds[0]!,
      kinds,
      projectId: task.projectId,
      projectName: projectNameById.get(task.projectId) ?? '',
      title: task.title,
      dueDate: task.dueDate,
      daysOverdue:
        kinds.includes('overdue_task') && task.dueDate !== null
          ? -daysBetween(today, task.dueDate)
          : null,
      score: null,
      status: task.status,
    });
  }

  for (const risk of risks) {
    // needsAttention이 §6.5의 "고위험 ∪ 발생"을 판정한다 — 조건을 여기서 다시 쓰지 않는다
    if (!needsAttention(risk)) continue;
    const kinds: AttentionKind[] = [];
    if (risk.status === 'occurred') kinds.push('occurred_risk');
    if (riskSeverity(risk) === 'high') kinds.push('high_risk');
    kinds.sort((a, b) => kindRank(a) - kindRank(b));
    attention.push({
      entity: 'risk',
      id: risk.id,
      kind: kinds[0]!,
      kinds,
      projectId: risk.projectId,
      projectName: projectNameById.get(risk.projectId) ?? '',
      title: risk.title,
      dueDate: risk.dueDate,
      daysOverdue: null,
      score: riskScore(risk),
      status: risk.status,
    });
  }

  attention.sort(
    (a, b) =>
      kindRank(a.kind) - kindRank(b.kind) ||
      // 리스크는 점수 높은 순, 작업은 마감 이른 순으로 읽힌다
      (b.score ?? 0) - (a.score ?? 0) ||
      compareDueDate(a.dueDate, b.dueDate) ||
      compareText(a.id, b.id)
  );

  // ─ 오늘의 To-Do (§7.2 6) ─
  // T-D3: "오늘"의 정의(미완료 + 마감 ≤ 오늘, 지난 마감 포함)와 마감일 정렬은
  // lib/todos.ts가 원본이다. 여기서 다시 쓰면 /todos와 건수가 조용히 어긋난다.
  //
  // 아카이브 제외만 이쪽에 남긴다 — T-D6: 대시보드는 집계 화면이라 아카이브를 빼지만
  // /todos는 To-Do의 유일한 접근 경로라 감추지 않는다. 두 화면의 이 차이는 의도된 것이다.
  // To-Do는 과제에 매이지 않으므로(§5.15) projectId가 아카이브 과제를 가리킬 때만 뺀다.
  const todayTodos: TodayTodoItem[] = sortTodos(
    filterTodos(input.todos, { mode: 'today' }, today).filter(
      (todo) => todo.projectId === null || inScope(todo.projectId)
    ),
    'due'
  ).map((todo) => ({
    id: todo.id,
    title: todo.title,
    // mode='today'가 dueDate != null을 보장한다. 여기서 판정을 다시 쓰지 않으려고 단언만 한다
    dueDate: todo.dueDate!,
    dday: formatDday(today, todo.dueDate!),
    priority: todo.priority,
    projectId: todo.projectId,
    projectName: todo.projectId === null ? null : (projectNameById.get(todo.projectId) ?? null),
  }));

  // ─ 지표 카드 (§7.2 1) ─
  const progressSum = projectCards.reduce((sum, card) => sum + card.progress, 0);
  const metrics: DashboardMetrics = {
    activeProjectCount: projects.filter((p) => p.status === 'active').length,
    // P-8: 여기서 반올림하지 않는다. 표시 형식은 화면(formatRate)이 정한다
    averageProgress: projectCards.length === 0 ? null : progressSum / projectCards.length,
    averageProgressProjectCount: projectCards.length,
    milestonesWithin30Days: milestones.filter((m) =>
      isUpcomingMilestone(m, today, METRIC_MILESTONE_WINDOW_DAYS)
    ).length,
    milestoneMetricWindowDays: METRIC_MILESTONE_WINDOW_DAYS,
    topPriorityTaskCount,
    highRiskCount: risks.filter((r) => riskSeverity(r) === 'high').length,
  };

  return {
    todayISO: today,
    settings: input.settings,
    metrics,
    projectCards,
    upcomingMilestones,
    focusTasks,
    attention,
    todayTodos,
  };
}
