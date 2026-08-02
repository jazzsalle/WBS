'use server';

// Project 서버 액션 (SOT §9 Project 목록, SA-1~SA-4, §8.4 O-1·O-3, §7.15)
// 반환은 ActionResult<T> — 예외를 그대로 던지지 않는다. supabase 직접 호출 금지,
// 반드시 lib/db/ 리포지토리를 거친다 (§8.6).
// 진척률은 저장하지 않고 읽을 때 계산한다 (O-4) — getProjectsSummary가 §6.1 4단계 롤업을 수행한다.

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
import { StaleDataError, ValidationError, toActionFailure } from '@/lib/db/errors';
import { projectStatusSchema } from '@/lib/db/schema';
import { buildTaskTree } from '@/lib/tree';
import {
  computeProjectProgress,
  computeStageProgress,
  computeYearProgress,
} from '@/lib/progress';

// §7.15 과제 카드: 과제 + 현재 연차 뱃지 + 진척률 바.
// invalidTaskCount는 트리에 편입되지 못한 Task 수 — 0이 아니면 UI가 경고를 띄운다 (절대 규칙 5)
export interface ProjectSummary {
  project: Project;
  currentYear: Year | null; // status='active' — 과제당 1개 (§5.5)
  progress: number; // §6.1 ④ (저장하지 않는다)
  invalidTaskCount: number;
}

const isoDateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "날짜는 'YYYY-MM-DD' 형식이어야 합니다.");

// 금액은 원 단위 정수 — 부동소수점 금액을 애초에 받지 않는다
const amountSchema = z.number().int('금액은 원 단위 정수로 입력하세요.');

const uuidSchema = z.uuid();
const uuidListSchema = z.array(z.uuid()).min(1, '정렬할 과제가 없습니다.');

const projectFieldsSchema = z.object({
  name: z.string().trim().min(1, '과제명을 입력하세요.').max(200, '과제명은 200자 이내여야 합니다.'),
  projectNo: z.string().trim().max(100),
  ministry: z.string().trim().max(100),
  agency: z.string().trim().max(100),
  programName: z.string().trim().max(200),
  description: z.string().max(10_000),
  status: projectStatusSchema,
  color: z.string().trim().max(20),
  contractStartDate: isoDateSchema.nullable(),
  contractEndDate: isoDateSchema.nullable(),
  totalBudget: amountSchema.nullable(),
  govBudget: amountSchema.nullable(),
  ownBudget: amountSchema.nullable(),
});

// 생성은 과제명만 필수 (§7.15 "이름·협약정보 최소 입력")
const projectCreateSchema = projectFieldsSchema.partial().extend({
  name: projectFieldsSchema.shape.name,
});

// pmMemberId·leadOrgId는 인력·기관이 생긴 뒤 지정한다. order는 reorderProjects 전용 (H-10)
const projectPatchSchema = projectFieldsSchema
  .extend({
    pmMemberId: z.uuid().nullable(),
    leadOrgId: z.uuid().nullable(),
    archived: z.boolean(),
  })
  .partial();

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
      console.error('[actions/projects] 수정자 이름 조회 실패:', lookupError);
    }
  }
  return toActionFailure(e);
}

function revalidateProject(projectId: string): void {
  revalidatePath('/projects');
  revalidatePath(`/projects/${projectId}`);
  revalidatePath(`/projects/${projectId}/wbs`);
}

// §6.1 ②③④ — Year는 estimatedHours 가중(②), Stage·Project는 budget 가중(③④).
// P-13: Task가 없는 연차도 progress 0으로 분모에 포함한다(연차 목록을 그대로 넘긴다).
function rollupProjectProgress(
  stages: readonly Stage[],
  years: readonly Year[],
  tasks: readonly Task[],
  basis: 'budget' | 'equal'
): { progress: number; invalidTaskCount: number } {
  let invalidTaskCount = 0;
  const progressByYear = new Map<string, number>();
  for (const year of years) {
    const { roots, invalid } = buildTaskTree(tasks.filter((t) => t.yearId === year.id));
    invalidTaskCount += invalid.length;
    progressByYear.set(year.id, computeYearProgress(roots));
  }
  // 연차가 사라진 Task는 FK상 있을 수 없지만, 있으면 조용히 버리지 않고 세어 알린다
  const yearIds = new Set(years.map((y) => y.id));
  invalidTaskCount += tasks.filter((t) => !yearIds.has(t.yearId)).length;

  const progress = computeProjectProgress(
    stages.map((stage) => ({
      progress: computeStageProgress(
        years
          .filter((y) => y.stageId === stage.id)
          .map((y) => ({ progress: progressByYear.get(y.id) ?? 0, budget: y.budget })),
        basis
      ),
      budget: stage.budget,
    })),
    basis
  );
  return { progress, invalidTaskCount };
}

// §9 createProject: Stage 1개 + Year 1개(비목 12종 포함)를 한 트랜잭션으로 만든다 (X-1).
// created_by/updated_by는 RPC가 auth.uid()로 채운다 (SA-2).
export async function createProject(input: unknown): Promise<ActionResult<Project>> {
  try {
    const parsed = parseOrThrow(projectCreateSchema, input, '과제 정보가 올바르지 않습니다.');
    const { client } = await requireApprovedUser();
    const project = await projectsRepo.createProjectWithDefaults(client, parsed);
    revalidateProject(project.id);
    return { ok: true, data: project };
  } catch (e) {
    return toFailure(e);
  }
}

// O-1: 상세 편집처럼 여러 필드를 한 번에 바꾸는 저장은 expectedVersion을 넘겨 잠금을 건다
export async function updateProject(
  id: string,
  patch: unknown,
  expectedVersion?: number
): Promise<ActionResult<Project>> {
  let client: SupabaseClient | undefined;
  try {
    const projectId = parseOrThrow(uuidSchema, id, '과제 ID 형식이 올바르지 않습니다.');
    const parsed = parseOrThrow(projectPatchSchema, patch, '과제 정보가 올바르지 않습니다.');
    const ctx = await requireApprovedUser();
    client = ctx.client;
    const updated = await projectsRepo.updateProject(
      client,
      projectId,
      { ...parsed, updatedBy: ctx.user.id },
      expectedVersion
    );
    revalidateProject(projectId);
    return { ok: true, data: updated };
  } catch (e) {
    return toFailure(e, client);
  }
}

// H-7: 연쇄 삭제는 RPC 트랜잭션 (SA-3)
export async function deleteProject(id: string): Promise<ActionResult<null>> {
  try {
    const projectId = parseOrThrow(uuidSchema, id, '과제 ID 형식이 올바르지 않습니다.');
    const { client } = await requireApprovedUser();
    await projectsRepo.deleteProject(client, projectId);
    revalidateProject(projectId);
    return { ok: true, data: null };
  } catch (e) {
    return toFailure(e);
  }
}

// O-2: 사용자가 직접 조작한 필드가 1개인 토글이라 낙관적 잠금을 생략한다
export async function archiveProject(
  id: string,
  archived: boolean
): Promise<ActionResult<Project>> {
  try {
    const projectId = parseOrThrow(uuidSchema, id, '과제 ID 형식이 올바르지 않습니다.');
    const flag = parseOrThrow(z.boolean(), archived, '아카이브 값이 올바르지 않습니다.');
    const { user, client } = await requireApprovedUser();
    const updated = await projectsRepo.updateProject(client, projectId, {
      archived: flag,
      updatedBy: user.id,
    });
    revalidateProject(projectId);
    return { ok: true, data: updated };
  } catch (e) {
    return toFailure(e);
  }
}

// H-10: 넘어온 순서대로 0..n-1. 한 번의 RPC로 일괄 갱신한다 (X-3)
export async function reorderProjects(orderedIds: string[]): Promise<ActionResult<null>> {
  try {
    const ids = parseOrThrow(uuidListSchema, orderedIds, '정렬 목록이 올바르지 않습니다.');
    const { client } = await requireApprovedUser();
    await projectsRepo.reorderProjects(client, ids);
    revalidatePath('/projects');
    return { ok: true, data: null };
  } catch (e) {
    return toFailure(e);
  }
}

// §7.15 과제 목록 카드용 집계. 아카이브 과제는 기본 숨김 — 토글은 인자로 받는다.
export async function getProjectsSummary(
  includeArchived = false
): Promise<ActionResult<ProjectSummary[]>> {
  try {
    const { client } = await requireApprovedUser();
    // §6.1 ③ 가중 기준은 팀 공유 설정을 따른다 (P-9의 폴백은 lib/progress가 처리)
    const { progressWeightBasis } = await settingsRepo.getSettings(client);

    const all = await projectsRepo.listProjects(client);
    const visible = includeArchived ? all : all.filter((p) => !p.archived);

    const summaries: ProjectSummary[] = [];
    for (const project of visible) {
      const [stages, years, tasks] = await Promise.all([
        stagesRepo.listStages(client, project.id),
        yearsRepo.listYears(client, project.id),
        tasksRepo.listTasksByProject(client, project.id),
      ]);
      const { progress, invalidTaskCount } = rollupProjectProgress(
        stages,
        years,
        tasks,
        progressWeightBasis
      );
      summaries.push({
        project,
        currentYear: years.find((y) => y.status === 'active') ?? null,
        progress,
        invalidTaskCount,
      });
    }
    return { ok: true, data: summaries };
  } catch (e) {
    return toFailure(e);
  }
}
