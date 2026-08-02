'use server';

// Task 서버 액션 + WBS 조회 모델 (SOT §9 Task·조회 목록, SA-1~SA-4, §6.1, §6.7, §6.9, §8.4)
// 반환은 ActionResult<T> — 예외를 그대로 던지지 않는다. supabase 직접 호출 금지,
// 반드시 lib/db/ 리포지토리를 거친다 (§8.6).
// 파생 값(wbsCode·progress·urgency·priorityScore)은 저장하지 않고 조회 시 계산한다 (§5.6, O-4, PR-7).

import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { ActionResult, Project, Stage, Task, Year } from '@/types';
import { requireApprovedUser } from '@/lib/auth/guard';
import * as appUsers from '@/lib/db/app-users';
import * as projectsRepo from '@/lib/db/projects';
import * as stagesRepo from '@/lib/db/stages';
import * as yearsRepo from '@/lib/db/years';
import * as tasksRepo from '@/lib/db/tasks';
import * as settingsRepo from '@/lib/db/settings';
import * as membersRepo from '@/lib/db/members';
import * as organizationsRepo from '@/lib/db/organizations';
import * as deliverablesRepo from '@/lib/db/deliverables';
import * as techTargetsRepo from '@/lib/db/tech-targets';
import {
  RuleViolationError,
  StaleDataError,
  ValidationError,
  toActionFailure,
} from '@/lib/db/errors';
import { progressModeSchema, taskStatusSchema } from '@/lib/db/schema';
import { MAX_TASK_DEPTH } from '@/lib/constants';
import { buildTaskTree, flattenTree, type TaskNode } from '@/lib/tree';
import {
  computeProgressMap,
  computeProjectProgress,
  computeStageProgress,
  computeYearProgress,
  leafFallbackProgress,
} from '@/lib/progress';
import { computePriorityScore, computeUrgency } from '@/lib/priority';
import { toISODate } from '@/lib/dates';

// ─── 조회 모델 (§9 getYearTree / getProjectFullTree) ──────────────────────────

// TaskNode(트리·WBS코드·날짜롤업)에 진척률(§6.1)과 우선순위(§6.9)를 얹은 화면용 노드.
// 전부 계산 값이라 DB에 없다.
export interface WbsNode extends Omit<TaskNode, 'children'> {
  children: WbsNode[];
  progress: number;
  urgency: 1 | 2 | 3 | 4 | 5;
  priorityScore: number;
}

export interface YearTree {
  year: Year;
  nodes: WbsNode[];
  yearProgress: number;
  // 트리에 편입되지 못한 Task. 비어 있지 않으면 UI가 경고를 띄운다 (절대 규칙 5)
  invalidTaskIds: string[];
}

export interface ProjectFullTree {
  project: Project;
  stages: Stage[];
  years: { year: Year; nodes: WbsNode[]; yearProgress: number }[];
  stageProgress: Record<string, number>;
  projectProgress: number;
  invalidTaskIds: string[];
}

// ─── 입력 검증 ────────────────────────────────────────────────────────────────

const isoDateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "날짜는 'YYYY-MM-DD' 형식이어야 합니다.");

const uuidSchema = z.uuid();
const uuidListSchema = z.array(z.uuid());

// 1~5 척도 (§6.9 importance / urgencyManual)
const levelSchema = z.union([
  z.literal(1),
  z.literal(2),
  z.literal(3),
  z.literal(4),
  z.literal(5),
]);

const urgencyModeSchema = z.enum(['auto', 'manual']);
const progressSchema = z.number().int('진척률은 0~100 정수입니다.').min(0).max(100);

// parentId·yearId·order는 여기 없다 — 이동·재정렬은 moveTask/moveTaskToYear/reorderTasks 전용이다 (X-3, X-4)
const taskFieldsSchema = z.object({
  title: z.string().trim().min(1, '작업명을 입력하세요.').max(200, '작업명은 200자 이내여야 합니다.'),
  description: z.string().max(10_000),
  status: taskStatusSchema,
  progressMode: progressModeSchema,
  manualProgress: progressSchema,
  // P-7: 음수 공수는 가중 평균을 뒤집으므로 입력 단계에서 막는다
  estimatedHours: z.number().nonnegative('공수는 0 이상이어야 합니다.').nullable(),
  actualHours: z.number().nonnegative('공수는 0 이상이어야 합니다.').nullable(),
  startDate: isoDateSchema.nullable(),
  dueDate: isoDateSchema.nullable(),
  importance: levelSchema,
  urgencyMode: urgencyModeSchema,
  urgencyManual: levelSchema,
  ownerMemberId: z.uuid().nullable(),
  memberIds: uuidListSchema,
  orgId: z.uuid().nullable(),
  deliverableIds: uuidListSchema,
  techTargetIds: uuidListSchema,
  tags: z.array(z.string().trim().min(1).max(50)),
});

const taskCreateSchema = taskFieldsSchema.partial().extend({
  title: taskFieldsSchema.shape.title,
  parentId: z.uuid().nullable().optional(),
});

const taskPatchSchema = taskFieldsSchema.partial();

function parseOrThrow<T>(schema: z.ZodType<T>, value: unknown, fallback: string): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    throw new ValidationError(parsed.error.issues[0]?.message ?? fallback);
  }
  return parsed.data;
}

// O-3: 낙관적 잠금 실패는 "누가 먼저 고쳤는지"까지 알려야 사용자가 판단할 수 있다.
// 이름 조회 실패도 삼키지 않고 로그를 남긴 뒤 이름 없는 기본 메시지로 폴백한다.
async function toFailure(e: unknown, client?: SupabaseClient): Promise<ActionResult<never>> {
  if (e instanceof StaleDataError && e.updatedBy !== null && client) {
    try {
      const editor = await appUsers.getAppUserById(client, e.updatedBy);
      const label = editor.name.trim() || editor.email;
      return {
        ok: false,
        error: `${label}님이 먼저 수정했습니다. 최신 내용을 확인하세요.`,
        code: 'STALE',
      };
    } catch (lookupError) {
      console.error('[actions/tasks] 수정자 이름 조회 실패:', lookupError);
    }
  }
  return toActionFailure(e);
}

function revalidateProject(projectId: string): void {
  revalidatePath('/projects');
  revalidatePath(`/projects/${projectId}`);
  revalidatePath(`/projects/${projectId}/wbs`);
}

// ─── 조회 조립 (순수 계산 — 리포지토리에서 읽은 데이터만 받는다) ────────────

// today는 호출당 1회 계산해 넘긴다 — 같은 응답 안에서 긴급도 기준일이 흔들리면 안 된다 (§6.9.1)
function toWbsNodes(roots: readonly TaskNode[], todayISO: string): WbsNode[] {
  const progressByTask = computeProgressMap(roots);

  const convert = (node: TaskNode): WbsNode => {
    const progress = progressByTask.get(node.task.id);
    if (progress === undefined) {
      // 롤업 맵은 트리의 모든 노드를 담는다 — 누락은 계산 버그이므로 조용히 0으로 덮지 않는다
      throw new Error(`진척률 계산에서 누락된 작업입니다: ${node.task.id}`);
    }
    return {
      ...node,
      children: node.children.map(convert),
      progress,
      urgency: computeUrgency(node.task, todayISO),
      priorityScore: computePriorityScore(node.task, todayISO),
    };
  };

  return roots.map(convert);
}

// ─── Task CRUD ────────────────────────────────────────────────────────────────

// H-1(같은 연차)·H-3(최대 깊이)은 생성 시점에도 확인한다. 이동은 RPC가 DB에서 검사한다 (X-4).
function assertParentAllowed(yearTasks: readonly Task[], parentId: string): void {
  if (!yearTasks.some((t) => t.id === parentId)) {
    throw new RuleViolationError('같은 연차의 작업만 부모로 지정할 수 있습니다.');
  }
  const { roots } = buildTaskTree(yearTasks);
  const parent = flattenTree(roots).find((n) => n.task.id === parentId);
  if (!parent) {
    throw new RuleViolationError('부모 작업이 트리에 편입되어 있지 않습니다. 계층을 먼저 정리하세요.');
  }
  if (parent.depth + 1 > MAX_TASK_DEPTH) {
    throw new RuleViolationError(`작업 계층은 최대 ${MAX_TASK_DEPTH}단계까지만 만들 수 있습니다.`);
  }
}

// 담당자·기관은 반드시 그 작업이 속한 과제의 것이어야 한다. 근거는 H-11과 같다 —
// "다른 과제로 옮기면 담당자·기관·목표 연계가 전부 남의 과제를 가리키게 된다".
// FK만으로는 과제 경계를 막지 못하므로(members·organizations는 과제별 테이블이 아니다)
// 여기서 확인한다. 참조가 없는 patch는 조회 없이 통과시킨다.
interface TeamRefs {
  ownerMemberId?: string | null;
  memberIds?: string[];
  orgId?: string | null;
}

// 검증에 조회가 필요한지 판단한다 — 담당자·기관이 없는 입력은 추가 조회 없이 통과시킨다
function hasTeamRefs(refs: TeamRefs): boolean {
  return (
    refs.ownerMemberId !== undefined || refs.memberIds !== undefined || refs.orgId !== undefined
  );
}

async function assertTeamRefsInProject(
  client: SupabaseClient,
  projectId: string,
  refs: TeamRefs
): Promise<void> {
  const referenced = new Set<string>(refs.memberIds ?? []);
  if (refs.ownerMemberId != null) referenced.add(refs.ownerMemberId);

  if (referenced.size > 0) {
    const projectMembers = new Set(
      (await membersRepo.listMembers(client, projectId)).map((m) => m.id)
    );
    if ([...referenced].some((id) => !projectMembers.has(id))) {
      throw new RuleViolationError('이 과제에 속하지 않은 인력은 담당자로 지정할 수 없습니다.');
    }
  }

  if (refs.orgId != null) {
    const projectOrgs = await organizationsRepo.listOrganizations(client, projectId);
    if (!projectOrgs.some((o) => o.id === refs.orgId)) {
      throw new RuleViolationError('이 과제에 속하지 않은 기관은 수행 기관으로 지정할 수 없습니다.');
    }
  }
}

// 목표 연계도 같은 근거로 과제 경계를 지킨다 (H-11: "다른 과제로 옮기면 담당자·기관·목표
// 연계가 전부 남의 과제를 가리키게 된다"). task_deliverables/task_tech_targets의 FK는
// 목표가 존재하는지만 보고 어느 과제 것인지는 보지 못한다.
interface GoalRefs {
  deliverableIds?: readonly string[];
  techTargetIds?: readonly string[];
}

// 검증에 조회가 필요한지 판단한다 — 연계가 없는 입력은 추가 조회 없이 통과시킨다
function hasGoalRefs(refs: GoalRefs): boolean {
  return refs.deliverableIds !== undefined || refs.techTargetIds !== undefined;
}

async function assertGoalRefsInProject(
  client: SupabaseClient,
  projectId: string,
  refs: GoalRefs
): Promise<void> {
  const deliverableIds = new Set(refs.deliverableIds ?? []);
  if (deliverableIds.size > 0) {
    const projectDeliverables = new Set(
      (await deliverablesRepo.listDeliverables(client, projectId)).map((d) => d.id)
    );
    if ([...deliverableIds].some((id) => !projectDeliverables.has(id))) {
      throw new RuleViolationError('이 과제에 속하지 않은 목표는 연계할 수 없습니다.');
    }
  }

  const techTargetIds = new Set(refs.techTargetIds ?? []);
  if (techTargetIds.size > 0) {
    const projectTechTargets = new Set(
      (await techTargetsRepo.listTechTargets(client, projectId)).map((t) => t.id)
    );
    if ([...techTargetIds].some((id) => !projectTechTargets.has(id))) {
      throw new RuleViolationError('이 과제에 속하지 않은 목표는 연계할 수 없습니다.');
    }
  }
}

export async function createTask(yearId: string, input: unknown): Promise<ActionResult<Task>> {
  try {
    const yid = parseOrThrow(uuidSchema, yearId, '연차 ID 형식이 올바르지 않습니다.');
    const { parentId = null, ...fields } = parseOrThrow(
      taskCreateSchema,
      input,
      '작업 정보가 올바르지 않습니다.'
    );
    const { user, client } = await requireApprovedUser();

    const year = await yearsRepo.getYearById(client, yid);
    const yearTasks = await tasksRepo.listTasksByYear(client, yid);
    if (parentId !== null) assertParentAllowed(yearTasks, parentId);

    // 생성 시점에도 담당자·기관·목표 연계는 그 연차가 속한 과제의 것이어야 한다 (updateTask와 같은 기준)
    if (hasTeamRefs(fields)) await assertTeamRefsInProject(client, year.projectId, fields);
    if (hasGoalRefs(fields)) await assertGoalRefsInProject(client, year.projectId, fields);

    // H-10: 같은 컨테이너(yearId, parentId)의 마지막 뒤에 붙인다 (DB 기본값 0을 두면 순서가 겹친다)
    const siblings = yearTasks.filter((t) => t.parentId === parentId);
    const order = siblings.reduce((max, t) => Math.max(max, t.order + 1), 0);

    // PR-3: 성과·기술목표에 연계된 작업은 중요도 4를 "제안"한다 — 사용자가 지정했으면 그 값을 쓴다
    const linked =
      (fields.deliverableIds?.length ?? 0) > 0 || (fields.techTargetIds?.length ?? 0) > 0;
    const importance = fields.importance ?? (linked ? 4 : undefined);

    const created = await tasksRepo.createTask(client, {
      projectId: year.projectId,
      yearId: yid,
      parentId,
      order,
      ...fields,
      ...(importance === undefined ? {} : { importance }),
      createdBy: user.id,
      updatedBy: user.id,
    });

    // P-6: 리프에 자식이 처음 생기면 부모를 'auto'로 전환한다. 이미 자식이 있었다면
    // 사용자가 고른 manual 토글(P-4)을 존중해 건드리지 않는다.
    if (parentId !== null && siblings.length === 0) {
      await tasksRepo.updateTask(client, parentId, {
        progressMode: 'auto',
        updatedBy: user.id,
      });
    }

    revalidateProject(year.projectId);
    return { ok: true, data: created };
  } catch (e) {
    return toFailure(e);
  }
}

// O-1: 상세 패널 저장처럼 여러 필드를 한 번에 바꾸는 갱신이므로 낙관적 잠금을 필수로 건다
export async function updateTask(
  id: string,
  patch: unknown,
  expectedVersion: number
): Promise<ActionResult<Task>> {
  let client: SupabaseClient | undefined;
  try {
    const taskId = parseOrThrow(uuidSchema, id, '작업 ID 형식이 올바르지 않습니다.');
    const parsed = parseOrThrow(taskPatchSchema, patch, '작업 정보가 올바르지 않습니다.');
    const version = parseOrThrow(
      z.number().int(),
      expectedVersion,
      '수정 기준 버전이 필요합니다.'
    );
    const ctx = await requireApprovedUser();
    client = ctx.client;

    // 담당자·기관·목표 연계가 patch에 들어올 때만 소속을 확인한다 (조회를 아끼기 위해).
    // 대상 작업은 한 번만 읽어 두 검증이 같은 projectId를 본다.
    const needsTeamCheck = hasTeamRefs(parsed);
    const needsGoalCheck = hasGoalRefs(parsed);
    if (needsTeamCheck || needsGoalCheck) {
      const before = await tasksRepo.getTaskById(client, taskId);
      if (needsTeamCheck) await assertTeamRefsInProject(client, before.projectId, parsed);
      if (needsGoalCheck) await assertGoalRefsInProject(client, before.projectId, parsed);
    }

    const updated = await tasksRepo.updateTask(
      client,
      taskId,
      { ...parsed, updatedBy: ctx.user.id },
      version
    );
    revalidateProject(updated.projectId);
    // 상세 패널 저장으로도 연계가 바뀐다 — 목표 화면의 연계 표시를 낡은 채로 두지 않는다
    if (needsGoalCheck) revalidatePath(`/projects/${updated.projectId}/goals`);
    return { ok: true, data: updated };
  } catch (e) {
    return toFailure(e, client);
  }
}

// H-4: 자손 전체가 함께 삭제된다(FK cascade). 삭제 개수 확인 대화상자는 UI 몫이다.
export async function deleteTask(id: string): Promise<ActionResult<null>> {
  try {
    const taskId = parseOrThrow(uuidSchema, id, '작업 ID 형식이 올바르지 않습니다.');
    const { user, client } = await requireApprovedUser();

    const task = await tasksRepo.getTaskById(client, taskId);
    const yearTasks = await tasksRepo.listTasksByYear(client, task.yearId);

    // P-12: 마지막 자식이 사라져 부모가 다시 리프가 되면 직전 롤업값으로 고정한다.
    // 삭제 전에 계산해야 "직전" 값이다.
    let parentFallback: { id: string; progress: number } | null = null;
    if (task.parentId !== null) {
      const remaining = yearTasks.filter(
        (t) => t.parentId === task.parentId && t.id !== taskId
      );
      if (remaining.length === 0) {
        const { roots } = buildTaskTree(yearTasks);
        const before = computeProgressMap(roots).get(task.parentId);
        if (before === undefined) {
          throw new Error(`진척률 계산에서 누락된 작업입니다: ${task.parentId}`);
        }
        parentFallback = { id: task.parentId, progress: before };
      }
    }

    await tasksRepo.deleteTask(client, taskId);

    if (parentFallback !== null) {
      await tasksRepo.updateTask(client, parentFallback.id, {
        progressMode: 'manual',
        manualProgress: leafFallbackProgress(parentFallback.progress),
        updatedBy: user.id,
      });
    }

    revalidateProject(task.projectId);
    return { ok: true, data: null };
  } catch (e) {
    return toFailure(e);
  }
}

// H-12: newIndex는 대상을 뺀 뒤의 새 형제 배열 기준 0-based 삽입 위치.
// 순환(H-2)·깊이(H-3) 검사는 RPC가 DB 안에서 한다 (X-4) — 위반은 code 'RULE'로 전달된다.
export async function moveTask(
  id: string,
  newParentId: string | null,
  newIndex: number
): Promise<ActionResult<Task>> {
  try {
    const taskId = parseOrThrow(uuidSchema, id, '작업 ID 형식이 올바르지 않습니다.');
    const parentId = parseOrThrow(
      z.uuid().nullable(),
      newParentId,
      '부모 작업 ID 형식이 올바르지 않습니다.'
    );
    const index = parseOrThrow(z.number().int(), newIndex, '삽입 위치가 올바르지 않습니다.');
    const { client } = await requireApprovedUser();
    const moved = await tasksRepo.moveTask(client, taskId, parentId, index);
    revalidateProject(moved.projectId);
    return { ok: true, data: moved };
  } catch (e) {
    return toFailure(e);
  }
}

// H-11: 자손 전체가 함께 이동하고 대상은 새 연차의 루트가 된다. 같은 과제 검증은 RPC 몫 (X-4).
export async function moveTaskToYear(
  id: string,
  newYearId: string
): Promise<ActionResult<Task>> {
  try {
    const taskId = parseOrThrow(uuidSchema, id, '작업 ID 형식이 올바르지 않습니다.');
    const yearId = parseOrThrow(uuidSchema, newYearId, '연차 ID 형식이 올바르지 않습니다.');
    const { client } = await requireApprovedUser();
    const moved = await tasksRepo.moveTaskToYear(client, taskId, yearId);
    revalidateProject(moved.projectId);
    return { ok: true, data: moved };
  } catch (e) {
    return toFailure(e);
  }
}

// H-10, X-3: orderedIds는 (yearId, parentId) 컨테이너의 자식 전체여야 한다 — RPC가 검증한다
export async function reorderTasks(
  yearId: string,
  parentId: string | null,
  orderedIds: string[]
): Promise<ActionResult<null>> {
  try {
    const yid = parseOrThrow(uuidSchema, yearId, '연차 ID 형식이 올바르지 않습니다.');
    const pid = parseOrThrow(
      z.uuid().nullable(),
      parentId,
      '부모 작업 ID 형식이 올바르지 않습니다.'
    );
    const ids = parseOrThrow(
      uuidListSchema.min(1, '정렬할 작업이 없습니다.'),
      orderedIds,
      '정렬 목록이 올바르지 않습니다.'
    );
    const { client } = await requireApprovedUser();
    const year = await yearsRepo.getYearById(client, yid);
    await tasksRepo.reorderTasks(client, yid, pid, ids);
    revalidateProject(year.projectId);
    return { ok: true, data: null };
  } catch (e) {
    return toFailure(e);
  }
}

// P-1: done이면 진척률 100은 계산이 강제한다 — manualProgress는 손대지 않는다 (P-11).
// O-2: 상태 드롭다운은 단일 조작이라 낙관적 잠금을 생략한다.
export async function setTaskStatus(id: string, status: unknown): Promise<ActionResult<Task>> {
  try {
    const taskId = parseOrThrow(uuidSchema, id, '작업 ID 형식이 올바르지 않습니다.');
    const value = parseOrThrow(taskStatusSchema, status, '작업 상태 값이 올바르지 않습니다.');
    const { user, client } = await requireApprovedUser();
    const updated = await tasksRepo.updateTask(client, taskId, {
      status: value,
      updatedBy: user.id,
    });
    revalidateProject(updated.projectId);
    return { ok: true, data: updated };
  } catch (e) {
    return toFailure(e);
  }
}

// P-2(100 → done), P-3(1~99 & todo → in_progress). 둘 다 리프 규칙이므로 자식이 있으면
// 진척률만 바꾼다. O-2: 인라인 편집은 단일 조작이라 낙관적 잠금을 생략한다.
export async function setTaskProgress(id: string, progress: unknown): Promise<ActionResult<Task>> {
  try {
    const taskId = parseOrThrow(uuidSchema, id, '작업 ID 형식이 올바르지 않습니다.');
    const value = parseOrThrow(progressSchema, progress, '진척률 값이 올바르지 않습니다.');
    const { user, client } = await requireApprovedUser();

    const task = await tasksRepo.getTaskById(client, taskId);
    const yearTasks = await tasksRepo.listTasksByYear(client, task.yearId);
    const isLeaf = !yearTasks.some((t) => t.parentId === taskId);

    let status: Task['status'] | undefined;
    if (isLeaf) {
      if (value === 100) status = 'done';
      else if (value >= 1 && task.status === 'todo') status = 'in_progress';
    }

    const updated = await tasksRepo.updateTask(client, taskId, {
      manualProgress: value,
      ...(status === undefined ? {} : { status }),
      updatedBy: user.id,
    });
    revalidateProject(updated.projectId);
    return { ok: true, data: updated };
  } catch (e) {
    return toFailure(e);
  }
}

// P-4/P-5: manual ↔ auto 토글. auto 복귀 시 롤업 값은 조회 때 즉시 반영된다(저장 값 없음).
export async function setProgressMode(id: string, mode: unknown): Promise<ActionResult<Task>> {
  try {
    const taskId = parseOrThrow(uuidSchema, id, '작업 ID 형식이 올바르지 않습니다.');
    const value = parseOrThrow(progressModeSchema, mode, '진척률 모드 값이 올바르지 않습니다.');
    const { user, client } = await requireApprovedUser();
    const updated = await tasksRepo.updateTask(client, taskId, {
      progressMode: value,
      updatedBy: user.id,
    });
    revalidateProject(updated.projectId);
    return { ok: true, data: updated };
  } catch (e) {
    return toFailure(e);
  }
}

// PR-1: 중요도만 사람이 정한다. PR-2: 롤업하지 않는다 — 이 작업 한 행만 바꾼다.
export async function setTaskPriority(
  id: string,
  importance: unknown
): Promise<ActionResult<Task>> {
  try {
    const taskId = parseOrThrow(uuidSchema, id, '작업 ID 형식이 올바르지 않습니다.');
    const value = parseOrThrow(levelSchema, importance, '중요도는 1~5 값이어야 합니다.');
    const { user, client } = await requireApprovedUser();
    const updated = await tasksRepo.updateTask(client, taskId, {
      importance: value,
      updatedBy: user.id,
    });
    revalidateProject(updated.projectId);
    return { ok: true, data: updated };
  } catch (e) {
    return toFailure(e);
  }
}

// PR-4: manual 고정 시 마감일이 바뀌어도 긴급도가 변하지 않는다. auto 복귀 시에는
// urgencyManual을 지우지 않는다 — 다시 고정할 때 마지막 값이 남아 있는 편이 낫다.
export async function setTaskUrgency(
  id: string,
  mode: unknown,
  manualValue?: unknown
): Promise<ActionResult<Task>> {
  try {
    const taskId = parseOrThrow(uuidSchema, id, '작업 ID 형식이 올바르지 않습니다.');
    const urgencyMode = parseOrThrow(urgencyModeSchema, mode, '긴급도 모드 값이 올바르지 않습니다.');
    const { user, client } = await requireApprovedUser();

    let patch: { urgencyMode: 'auto' | 'manual'; urgencyManual?: 1 | 2 | 3 | 4 | 5 };
    if (urgencyMode === 'manual') {
      // 고정인데 값이 없으면 무엇으로 고정할지 알 수 없다 — 조용히 기본값을 넣지 않는다
      patch = {
        urgencyMode,
        urgencyManual: parseOrThrow(
          levelSchema,
          manualValue,
          '고정할 긴급도는 1~5 값이어야 합니다.'
        ),
      };
    } else {
      patch = { urgencyMode };
    }

    const updated = await tasksRepo.updateTask(client, taskId, {
      ...patch,
      updatedBy: user.id,
    });
    revalidateProject(updated.projectId);
    return { ok: true, data: updated };
  } catch (e) {
    return toFailure(e);
  }
}

// §9 assignTaskMembers: 책임자 1명(ownerMemberId) + 참여자 다중(memberIds)을 함께 저장한다.
// memberIds는 항상 patch에 담기므로 task_members가 매번 전체 치환된다(전체 치환 규약).
// O-2: 배정 패널의 단일 조작이라 낙관적 잠금을 생략한다.
export async function assignTaskMembers(
  id: string,
  ownerMemberId: string | null,
  memberIds: string[]
): Promise<ActionResult<Task>> {
  try {
    const taskId = parseOrThrow(uuidSchema, id, '작업 ID 형식이 올바르지 않습니다.');
    const owner = parseOrThrow(
      z.uuid().nullable(),
      ownerMemberId,
      '책임자 ID 형식이 올바르지 않습니다.'
    );
    const ids = parseOrThrow(uuidListSchema, memberIds, '담당자 목록이 올바르지 않습니다.');
    const { user, client } = await requireApprovedUser();

    const before = await tasksRepo.getTaskById(client, taskId);
    await assertTeamRefsInProject(client, before.projectId, {
      ownerMemberId: owner,
      memberIds: ids,
    });

    const updated = await tasksRepo.updateTask(client, taskId, {
      ownerMemberId: owner,
      memberIds: ids,
      updatedBy: user.id,
    });
    revalidateProject(updated.projectId);
    // 팀 화면의 "배정된 작업 목록"(§7.10)도 이 저장으로 바뀐다
    revalidatePath(`/projects/${updated.projectId}/team`);
    return { ok: true, data: updated };
  } catch (e) {
    return toFailure(e);
  }
}

// §9 linkTaskGoals: 이 작업이 기여하는 성과목표·기술목표를 함께 저장한다 (§7.4 연계 컬럼).
// 두 배열이 항상 patch에 담기므로 task_deliverables·task_tech_targets가 매번 전체 치환된다
// (assignTaskMembers와 같은 전체 치환 규약 — 체크 해제 = 연계 해제).
// O-2: 연계 목록 하나만 바꾸는 단일 조작이라 낙관적 잠금을 생략한다.
export async function linkTaskGoals(
  id: string,
  deliverableIds: string[],
  techTargetIds: string[]
): Promise<ActionResult<Task>> {
  try {
    const taskId = parseOrThrow(uuidSchema, id, '작업 ID 형식이 올바르지 않습니다.');
    const dIds = parseOrThrow(uuidListSchema, deliverableIds, '성과목표 목록이 올바르지 않습니다.');
    const tIds = parseOrThrow(uuidListSchema, techTargetIds, '기술목표 목록이 올바르지 않습니다.');
    const { user, client } = await requireApprovedUser();

    const before = await tasksRepo.getTaskById(client, taskId);
    await assertGoalRefsInProject(client, before.projectId, {
      deliverableIds: dIds,
      techTargetIds: tIds,
    });

    const updated = await tasksRepo.updateTask(client, taskId, {
      deliverableIds: dIds,
      techTargetIds: tIds,
      updatedBy: user.id,
    });
    revalidateProject(updated.projectId);
    // 목표 화면(§7.7)도 이 저장으로 바뀐다
    revalidatePath(`/projects/${updated.projectId}/goals`);
    return { ok: true, data: updated };
  } catch (e) {
    return toFailure(e);
  }
}

// 다중 선택 일괄 편집. 여러 행이라 expectedVersion을 걸 수 없다(SA-2의 "선택 인자").
// 중간 실패는 삼키지 않고 그대로 실패로 돌려준다 — 어디까지 반영됐는지는 UI가 다시 읽어 확인한다.
export async function bulkUpdateTasks(
  ids: string[],
  patch: unknown
): Promise<ActionResult<Task[]>> {
  let client: SupabaseClient | undefined;
  try {
    const taskIds = parseOrThrow(
      uuidListSchema.min(1, '수정할 작업을 선택하세요.'),
      ids,
      '작업 목록이 올바르지 않습니다.'
    );
    const parsed = parseOrThrow(taskPatchSchema, patch, '작업 정보가 올바르지 않습니다.');
    const ctx = await requireApprovedUser();
    client = ctx.client;
    const db = ctx.client; // 콜백 안에서도 좁혀진 타입을 유지하려고 상수로 받는다

    // 담당자·기관·목표는 한 과제에만 속한다 — 여러 과제의 작업을 한 번에 배정하는 요청은
    // 애초에 성립하지 않는다. 일부만 반영되는 실패 대신 먼저 거부해 이유를 분명히 알린다.
    const needsTeamCheck = hasTeamRefs(parsed);
    const needsGoalCheck = hasGoalRefs(parsed);
    if (needsTeamCheck || needsGoalCheck) {
      const targets = await Promise.all(taskIds.map((tid) => tasksRepo.getTaskById(db, tid)));
      const projectIds = new Set(targets.map((t) => t.projectId));
      if (projectIds.size > 1) {
        throw new RuleViolationError(
          '여러 과제의 작업에 담당자·기관·목표 연계를 한 번에 지정할 수 없습니다.'
        );
      }
      const [projectId] = [...projectIds];
      if (projectId === undefined) throw new ValidationError('수정할 작업을 선택하세요.');
      if (needsTeamCheck) await assertTeamRefsInProject(db, projectId, parsed);
      if (needsGoalCheck) await assertGoalRefsInProject(db, projectId, parsed);
    }

    const updated: Task[] = [];
    for (const taskId of taskIds) {
      updated.push(
        await tasksRepo.updateTask(client, taskId, { ...parsed, updatedBy: ctx.user.id })
      );
    }
    for (const projectId of new Set(updated.map((t) => t.projectId))) {
      revalidateProject(projectId);
    }
    return { ok: true, data: updated };
  } catch (e) {
    return toFailure(e, client);
  }
}

// ─── 조회 (§9 조회 목록 — 서버 컴포넌트에서 직접 호출) ────────────────────────

// 진척률·WBS코드·날짜롤업·우선순위 계산이 끝난 한 연차의 트리.
// 연차 진척률은 estimatedHours 가중(§6.1 ②)이라 progressWeightBasis와 무관하다.
export async function getYearTree(yearId: string): Promise<ActionResult<YearTree>> {
  try {
    const yid = parseOrThrow(uuidSchema, yearId, '연차 ID 형식이 올바르지 않습니다.');
    const { client } = await requireApprovedUser();
    const year = await yearsRepo.getYearById(client, yid);
    const list = await tasksRepo.listTasksByYear(client, yid);

    const { roots, invalid } = buildTaskTree(list);
    const todayISO = toISODate(new Date());

    return {
      ok: true,
      data: {
        year,
        nodes: toWbsNodes(roots, todayISO),
        yearProgress: computeYearProgress(roots),
        invalidTaskIds: invalid.map((t) => t.id),
      },
    };
  } catch (e) {
    return toFailure(e);
  }
}

// 전체 연차 통합 뷰 (§7.4 "전체 연차 보기"). §6.7: 연차가 섞이므로 WBS 코드에 '1차-' 접두를 붙인다.
export async function getProjectFullTree(
  projectId: string
): Promise<ActionResult<ProjectFullTree>> {
  try {
    const pid = parseOrThrow(uuidSchema, projectId, '과제 ID 형식이 올바르지 않습니다.');
    const { client } = await requireApprovedUser();

    const [project, stageList, yearList, taskList, settings] = await Promise.all([
      projectsRepo.getProjectById(client, pid),
      stagesRepo.listStages(client, pid),
      yearsRepo.listYears(client, pid),
      tasksRepo.listTasksByProject(client, pid),
      settingsRepo.getSettings(client),
    ]);

    const todayISO = toISODate(new Date());
    const basis = settings.progressWeightBasis; // §6.1 ③ (P-9 폴백은 lib/progress가 처리)

    const invalidTaskIds: string[] = [];
    const progressByYear = new Map<string, number>();
    const years = yearList.map((year) => {
      const { roots, invalid } = buildTaskTree(
        taskList.filter((t) => t.yearId === year.id),
        // §6.7 표기 예: '1차-1.2'. name이 아니라 order로 만들어 항상 같은 형태를 유지한다
        { yearPrefix: `${year.order + 1}차-` }
      );
      invalidTaskIds.push(...invalid.map((t) => t.id));
      const yearProgress = computeYearProgress(roots);
      progressByYear.set(year.id, yearProgress);
      return { year, nodes: toWbsNodes(roots, todayISO), yearProgress };
    });

    // 연차가 사라진 Task는 FK상 있을 수 없지만, 있으면 조용히 버리지 않고 알린다 (절대 규칙 5)
    const yearIds = new Set(yearList.map((y) => y.id));
    invalidTaskIds.push(...taskList.filter((t) => !yearIds.has(t.yearId)).map((t) => t.id));

    // P-13: Task가 없는 연차도 progress 0으로 분모에 포함한다(연차 목록을 그대로 넘긴다)
    const stageProgress: Record<string, number> = {};
    for (const stage of stageList) {
      stageProgress[stage.id] = computeStageProgress(
        yearList
          .filter((y) => y.stageId === stage.id)
          .map((y) => ({ progress: progressByYear.get(y.id) ?? 0, budget: y.budget })),
        basis
      );
    }

    const projectProgress = computeProjectProgress(
      stageList.map((s) => ({ progress: stageProgress[s.id] ?? 0, budget: s.budget })),
      basis
    );

    return {
      ok: true,
      data: {
        project,
        stages: stageList,
        years,
        stageProgress,
        projectProgress,
        invalidTaskIds,
      },
    };
  } catch (e) {
    return toFailure(e);
  }
}
