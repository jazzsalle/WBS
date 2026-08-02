// 대시보드 전용 벌크 조회 리포지토리 (SOT §7.2, §9 getDashboardData, §12)
// §12는 과제 30개·작업 5,000개에서 초기 렌더 1초를 요구한다 — 과제별 루프 쿼리(N+1)를
// 만들지 않고 `.in('project_id', ids)` 한 번으로 테이블마다 몰아 읽는다.
//
// select 문자열·Zod 행 스키마·행→앱 변환은 전부 각 테이블 리포지토리의 것을 그대로 쓴다.
// 여기서 다시 정의하면 임베드 모양이 갈라지고, 그 순간 대시보드만 조용히 다른 데이터를 본다.
// 계산은 하지 않는다 — 집계는 lib/dashboard.ts(순수)의 몫이다.

import type { PostgrestError, SupabaseClient } from '@supabase/supabase-js';
import { z } from 'zod';
import type {
  BudgetItem,
  Deliverable,
  Milestone,
  Project,
  Risk,
  Stage,
  Task,
  TechTarget,
  Todo,
  Year,
} from '@/types';
import { milestoneRowSchema, riskRowSchema, stageRowSchema, yearRowSchema } from './schema';
import { dbToAppArray } from './mapper';
import * as projectsRepo from './projects';
import * as settingsRepo from './settings';
import * as todosRepo from './todos';
import { TASK_SELECT, parseTaskRow } from './tasks';
import { DELIVERABLE_SELECT, toDeliverable } from './deliverables';
import { TECH_TARGET_SELECT, toTechTarget } from './tech-targets';
import { ITEM_SELECT as BUDGET_ITEM_SELECT, itemWithExecutionsSchema, toBudgetItem } from './budget-items';
import {
  AuthError,
  ConflictError,
  OfflineError,
  RuleViolationError,
  ValidationError,
} from './errors';

const SCHEMA_MISMATCH_MESSAGE =
  'DB 응답이 앱이 기대하는 형식과 다릅니다. 앱과 DB 마이그레이션 버전을 확인하세요.';

function raiseDbError(error: PostgrestError): never {
  if (error.code === '23505') throw new ConflictError();
  if (error.code === 'P0001') throw new RuleViolationError(error.message);
  if (error.code === 'PGRST301') throw new AuthError();
  if (/fetch failed|failed to fetch/i.test(error.message)) throw new OfflineError();
  throw new Error(error.message);
}

// DB 응답 검증 실패 = 스키마 드리프트 신호. 조용히 넘기지 않는다 (§8.6, 절대 규칙 5).
function parseRows<T>(table: string, schema: z.ZodType<T>, rows: unknown): T {
  const parsed = schema.safeParse(rows);
  if (!parsed.success) {
    console.error(`[db/dashboard] ${table} row 검증 실패:`, parsed.error);
    throw new ValidationError(SCHEMA_MISMATCH_MESSAGE);
  }
  return parsed.data;
}

// PostgREST는 max-rows(Supabase 기본 1000행)에 걸려도 에러 없이 잘린 배열을 준다.
// §12의 작업 5,000건이 잘린 줄 모르고 집계되면 진척률·우선순위가 조용히 틀린다 (절대 규칙 5).
// 그래서 "빈 페이지가 나올 때까지" 이어 읽고, 다음 오프셋은 요청 폭이 아니라
// 실제로 받은 행 수만큼 전진시킨다 — 서버 max-rows가 PAGE_SIZE보다 작아도 구멍이 생기지 않는다.
const PAGE_SIZE = 1000;

type PagedResult = PromiseLike<{ data: unknown[] | null; error: PostgrestError | null }>;

async function fetchAllRows(build: (from: number, to: number) => PagedResult): Promise<unknown[]> {
  const rows: unknown[] = [];
  for (let from = 0; ; ) {
    const { data, error } = await build(from, from + PAGE_SIZE - 1);
    if (error) raiseDbError(error);
    const page = data ?? [];
    if (page.length === 0) return rows;
    rows.push(...page);
    from += page.length;
  }
}

// id 오름차순으로 고정한다 — range 페이징은 결정적 정렬이 없으면 행이 새거나 중복된다.
// 표시 순서는 집계(lib/dashboard.ts)가 스스로 정하므로 여기서 맞출 필요가 없다.
async function listByProjects(
  client: SupabaseClient,
  table: string,
  select: string,
  projectIds: readonly string[]
): Promise<unknown[]> {
  // 대상 과제가 없으면 결과도 없다 — 에러를 감춘 빈 배열 폴백이 아니라 질의 자체가 무의미하다
  if (projectIds.length === 0) return [];
  return fetchAllRows((from, to) =>
    client
      .from(table)
      .select(select)
      .in('project_id', [...projectIds])
      .order('id', { ascending: true })
      .range(from, to)
  );
}

// §7.2 대시보드 한 화면이 필요로 하는 원본 데이터 전부.
// projects는 아카이브 과제까지 담는다 — To-Do의 projectId가 아카이브 과제를 가리키는지
// 판정하려면(§7.2) 목록에 있어야 한다. 집계 제외는 lib/dashboard.ts가 한다.
export interface DashboardSource {
  projects: Project[];
  stages: Stage[];
  years: Year[];
  tasks: Task[];
  milestones: Milestone[];
  risks: Risk[];
  budgetItems: BudgetItem[];
  deliverables: Deliverable[];
  techTargets: TechTarget[];
  todos: Todo[];
  settings: settingsRepo.SettingsRecord;
}

export async function fetchDashboardSource(client: SupabaseClient): Promise<DashboardSource> {
  const [projects, settings] = await Promise.all([
    projectsRepo.listProjects(client),
    settingsRepo.getSettings(client),
  ]);

  // 아카이브 과제는 모든 집계에서 빠지므로(§7.2) 하위 데이터를 아예 읽지 않는다.
  // lib/dashboard.ts도 같은 판정을 다시 하므로 조회 최적화일 뿐 규칙의 근거지가 아니다.
  const projectIds = projects.filter((p) => !p.archived).map((p) => p.id);

  const [stageRows, yearRows, taskRows, milestoneRows, riskRows, budgetRows, deliverableRows, techTargetRows, todos] =
    await Promise.all([
      listByProjects(client, 'stages', '*', projectIds),
      listByProjects(client, 'years', '*', projectIds),
      listByProjects(client, 'tasks', TASK_SELECT, projectIds),
      listByProjects(client, 'milestones', '*', projectIds),
      listByProjects(client, 'risks', '*', projectIds),
      listByProjects(client, 'budget_items', BUDGET_ITEM_SELECT, projectIds),
      listByProjects(client, 'deliverables', DELIVERABLE_SELECT, projectIds),
      listByProjects(client, 'tech_targets', TECH_TARGET_SELECT, projectIds),
      // To-Do는 과제에 매이지 않는다 (§5.15) — 전역으로 읽는다
      todosRepo.listTodos(client),
    ]);

  return {
    projects,
    stages: dbToAppArray<Stage>(parseRows('stages', z.array(stageRowSchema), stageRows)),
    years: dbToAppArray<Year>(parseRows('years', z.array(yearRowSchema), yearRows)),
    tasks: taskRows.map(parseTaskRow),
    milestones: dbToAppArray<Milestone>(
      parseRows('milestones', z.array(milestoneRowSchema), milestoneRows)
    ),
    risks: dbToAppArray<Risk>(parseRows('risks', z.array(riskRowSchema), riskRows)),
    budgetItems: parseRows(
      'budget_items',
      z.array(itemWithExecutionsSchema),
      budgetRows
    ).map(toBudgetItem),
    deliverables: deliverableRows.map(toDeliverable),
    techTargets: techTargetRows.map(toTechTarget),
    todos,
    settings,
  };
}
