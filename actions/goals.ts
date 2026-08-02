'use server';

// Deliverable / TechTarget 서버 액션 + 목표 화면 조회
// (SOT §9 Deliverable·TechTarget·조회 목록, SA-1~SA-4, §5.8, §5.9, §6.2, §6.3, §8.4)
// 반환은 ActionResult<T> — 예외를 그대로 던지지 않는다. supabase 직접 호출 금지,
// 반드시 lib/db/ 리포지토리를 거친다 (§8.6).
//
// 달성률은 파생 값이라 저장하지 않는다 (O-4). 계산은 전부 lib/goals.ts가 하고
// 여기서는 공식을 다시 쓰지 않는다 — 규칙이 두 곳에 생기면 반드시 어긋난다.

import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import type { SupabaseClient } from '@supabase/supabase-js';
import type {
  ActionResult,
  Deliverable,
  DeliverableAchievement,
  DeliverableType,
  Member,
  Organization,
  TechTarget,
  TechTargetRecord,
  Year,
} from '@/types';
import { requireApprovedUser } from '@/lib/auth/guard';
import * as appUsers from '@/lib/db/app-users';
import * as deliverablesRepo from '@/lib/db/deliverables';
import * as techTargetsRepo from '@/lib/db/tech-targets';
import * as membersRepo from '@/lib/db/members';
import * as organizationsRepo from '@/lib/db/organizations';
import * as yearsRepo from '@/lib/db/years';
import {
  NotFoundError,
  RuleViolationError,
  StaleDataError,
  ValidationError,
  toActionFailure,
} from '@/lib/db/errors';
import { deliverableTypeSchema, directionSchema, measureMethodSchema } from '@/lib/db/schema';
import {
  computeDeliverableTotal,
  computeTechTargetTotal,
  summarizeDeliverable,
  summarizeTechTarget,
} from '@/lib/goals';

// ─── 조회 모델 (§9 getGoalsData, §7.7) ────────────────────────────────────────

// 달성률·경고는 전부 계산 값이라 DB에 없다. 반올림하지 않은 원시값을 그대로 담는다 —
// 표시용 반올림은 lib/goals.ts의 formatRate() 한 곳에서만 한다 (P-8).
export interface DeliverableView {
  deliverable: Deliverable;
  achievedTotal: number;
  rate: number | null; // D-1: targetTotal 0이면 null(N/A)
  /** 키는 yearId. 목표가 없는 연차도 담아 UI가 폴백 분기를 만들지 않게 한다 (D-4, D-5) */
  byYear: Record<
    string,
    { target: number | null; achieved: number; rate: number | null; offTarget: boolean }
  >;
  yearTargetMismatch: boolean; // D-3
  /** D-3 경고 문구에 쓰는 Σ targetByYear. 판정은 yearTargetMismatch가 하고 이건 표시용 수치다 */
  yearTargetSum: number;
  /** D-4: yearId가 null인 실적 건수. 연차 셀 합계에서 빠지는 몫을 화면이 다시 세지 않게 실어 보낸다 */
  unassignedAchieved: number;
}

export interface TechTargetView {
  techTarget: TechTarget;
  current: number | null;
  rate: number | null; // T-1 클램프 적용. 미측정과 T-2는 null
  evaluatorMissing: boolean; // T-4
}

export interface GoalsData {
  projectId: string;
  years: Year[];
  organizations: Organization[];
  members: Member[];
  deliverables: DeliverableView[];
  deliverableSummary: {
    targetTotal: number;
    achievedTotal: number;
    rate: number | null;
    byType: { type: DeliverableType; target: number; achieved: number }[];
  };
  techTargets: TechTargetView[];
  techSummary: { weightedRate: number | null; weightSum: number; weightMismatch: boolean };
}

// ─── 입력 검증 ────────────────────────────────────────────────────────────────

const uuidSchema = z.uuid();
const uuidListSchema = z.array(z.uuid());
const orderedIdsSchema = z.array(z.uuid()).min(1, '정렬할 항목이 없습니다.');

const isoDateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "날짜는 'YYYY-MM-DD' 형식이어야 합니다.");

const nameSchema = z
  .string()
  .trim()
  .min(1, '이름을 입력하세요.')
  .max(200, '이름은 200자 이내여야 합니다.');

// §5.8 증빙은 "DOI, 특허번호 조회 URL 등" 자유 입력이라 형식을 강제하지 않는다.
// 미입력은 빈 문자열이다 (N-11).
const evidenceUrlSchema = z.string().trim().max(2000, '증빙 링크는 2000자 이내여야 합니다.');

const noteSchema = z.string().max(10_000);

// §5.8 성과목표는 "건수"다 — 0 이상 정수만 받는다 (DB도 integer)
const countSchema = z
  .number()
  .int('목표 건수는 0 이상 정수로 입력하세요.')
  .min(0, '목표 건수는 0 이상 정수로 입력하세요.');

// §5.9 기술목표의 값은 단위가 %, ms, fps인 측정치라 소수·음수가 정상이다 (DB도 numeric).
// 건수(countSchema)와 달리 정수로 제한하지 않는다.
const measureValueSchema = z.number().finite('측정값이 올바르지 않습니다.');

// N-13: targetByYear의 키는 yearId지만 FK가 걸리지 않는다 — 형식은 여기서,
// "그 과제의 연차인가"는 assertGoalRefsInProject가 본다.
const deliverableYearTargetsSchema = z.record(
  z.uuid('연차 ID 형식이 올바르지 않습니다.'),
  countSchema
);
const techYearTargetsSchema = z.record(
  z.uuid('연차 ID 형식이 올바르지 않습니다.'),
  measureValueSchema
);

// order는 여기 없다 — 재정렬은 reorderDeliverables/reorderTechTargets 전용이다 (H-10, X-3)
const deliverableFieldsSchema = z.object({
  type: deliverableTypeSchema,
  name: nameSchema,
  unit: z.string().trim().max(20, '단위는 20자 이내여야 합니다.'),
  targetTotal: countSchema,
  targetByYear: deliverableYearTargetsSchema,
  orgId: z.uuid().nullable(),
  note: noteSchema,
});

// type은 DB에 기본값이 없다(not null + check) — 생성 시 반드시 받는다
const deliverableCreateSchema = deliverableFieldsSchema.partial().extend({
  type: deliverableFieldsSchema.shape.type,
  name: deliverableFieldsSchema.shape.name,
});

const deliverablePatchSchema = deliverableFieldsSchema.partial();

const achievementFieldsSchema = z.object({
  title: z
    .string()
    .trim()
    .min(1, '산출물명을 입력하세요.')
    .max(300, '산출물명은 300자 이내여야 합니다.'),
  date: isoDateSchema,
  yearId: z.uuid().nullable(),
  orgId: z.uuid().nullable(),
  memberIds: uuidListSchema,
  evidenceUrl: evidenceUrlSchema,
  note: noteSchema,
});

// date는 DB에 기본값이 없다(not null). 달성일 없는 실적은 연차 집계에 들어갈 수 없다 (D-4)
const achievementCreateSchema = achievementFieldsSchema.partial().extend({
  title: achievementFieldsSchema.shape.title,
  date: achievementFieldsSchema.shape.date,
});

const achievementPatchSchema = achievementFieldsSchema.partial();

const techTargetFieldsSchema = z.object({
  name: nameSchema,
  unit: z.string().trim().max(20, '단위는 20자 이내여야 합니다.'),
  direction: directionSchema,
  // T-3: 비중은 가중 평균의 분모다. 음수가 섞이면 전체 달성률이 뒤집힌다
  weight: z.number().nonnegative('비중은 0 이상이어야 합니다.'),
  targetValue: measureValueSchema,
  targetByYear: techYearTargetsSchema,
  baselineDomestic: measureValueSchema.nullable(),
  worldBest: measureValueSchema.nullable(),
  worldBestHolder: z.string().trim().max(200, '보유국/보유기관은 200자 이내여야 합니다.'),
  measureMethod: measureMethodSchema,
  measureDescription: noteSchema,
  orgId: z.uuid().nullable(),
});

const techTargetCreateSchema = techTargetFieldsSchema.partial().extend({
  name: techTargetFieldsSchema.shape.name,
});

const techTargetPatchSchema = techTargetFieldsSchema.partial();

const techRecordFieldsSchema = z.object({
  value: measureValueSchema,
  date: isoDateSchema,
  yearId: z.uuid().nullable(),
  method: measureMethodSchema,
  evaluator: z.string().trim().max(200, '평가기관은 200자 이내여야 합니다.'),
  evidenceUrl: evidenceUrlSchema,
  note: noteSchema,
});

// value·date는 생략을 허용하지 않는다 — DB 기본값 0이 "측정 실적치 0"으로 굳으면
// 달성률(§6.3)이 조용히 왜곡된다
const techRecordCreateSchema = techRecordFieldsSchema.partial().extend({
  value: techRecordFieldsSchema.shape.value,
  date: techRecordFieldsSchema.shape.date,
});

const techRecordPatchSchema = techRecordFieldsSchema.partial();

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
      console.error('[actions/goals] 수정자 이름 조회 실패:', lookupError);
    }
  }
  return toActionFailure(e);
}

// 목표명은 WBS 행의 연계 뱃지에도 나오므로 목표 화면만 다시 그리면 부족하다
function revalidateGoals(projectId: string): void {
  revalidatePath(`/projects/${projectId}`);
  revalidatePath(`/projects/${projectId}/goals`);
  revalidatePath(`/projects/${projectId}/wbs`);
}

// H-10: 같은 컨테이너(project)의 마지막 뒤에 붙인다. DB 기본값 0을 그대로 두면 순서가 겹친다.
function nextOrder(rows: readonly { order: number }[]): number {
  return rows.reduce((max, row) => Math.max(max, row.order + 1), 0);
}

// 기관·인력·연차 참조는 반드시 그 목표가 속한 과제의 것이어야 한다. 근거는 H-11과 같다 —
// "다른 과제로 옮기면 담당자·기관·목표 연계가 전부 남의 과제를 가리키게 된다".
// FK만으로는 과제 경계를 막지 못하고, targetByYear의 yearId 키는 FK 자체가 없다(N-13).
interface GoalRefs {
  orgId?: string | null;
  memberIds?: readonly string[];
  /** 실적·측정의 yearId와 targetByYear의 키. null(연차 미지정)은 검사 대상이 아니다 */
  yearIds?: readonly (string | null)[];
}

// 참조가 없는 입력은 조회 없이 통과시킨다 — 종류별로 필요할 때만 목록을 읽는다
async function assertGoalRefsInProject(
  client: SupabaseClient,
  projectId: string,
  refs: GoalRefs
): Promise<void> {
  if (refs.orgId != null) {
    const orgs = await organizationsRepo.listOrganizations(client, projectId);
    if (!orgs.some((o) => o.id === refs.orgId)) {
      throw new RuleViolationError('이 과제에 속하지 않은 기관은 책임 기관으로 지정할 수 없습니다.');
    }
  }

  const memberIds = new Set(refs.memberIds ?? []);
  if (memberIds.size > 0) {
    const projectMembers = new Set(
      (await membersRepo.listMembers(client, projectId)).map((m) => m.id)
    );
    if ([...memberIds].some((id) => !projectMembers.has(id))) {
      throw new RuleViolationError('이 과제에 속하지 않은 인력은 참여자로 지정할 수 없습니다.');
    }
  }

  const yearIds = new Set((refs.yearIds ?? []).filter((id): id is string => id != null));
  if (yearIds.size > 0) {
    const projectYears = new Set((await yearsRepo.listYears(client, projectId)).map((y) => y.id));
    if ([...yearIds].some((id) => !projectYears.has(id))) {
      throw new RuleViolationError('이 과제에 속하지 않은 연차는 지정할 수 없습니다.');
    }
  }
}

// ─── Deliverable (§5.8, §6.2) ─────────────────────────────────────────────────

export async function createDeliverable(
  projectId: string,
  input: unknown
): Promise<ActionResult<Deliverable>> {
  try {
    const pid = parseOrThrow(uuidSchema, projectId, '과제 ID 형식이 올바르지 않습니다.');
    const fields = parseOrThrow(deliverableCreateSchema, input, '성과목표 정보가 올바르지 않습니다.');
    const { user, client } = await requireApprovedUser();

    await assertGoalRefsInProject(client, pid, {
      orgId: fields.orgId,
      yearIds: fields.targetByYear === undefined ? undefined : Object.keys(fields.targetByYear),
    });

    const existing = await deliverablesRepo.listDeliverables(client, pid);
    const created = await deliverablesRepo.createDeliverable(
      client,
      {
        projectId: pid,
        type: fields.type,
        name: fields.name,
        unit: fields.unit ?? '건', // §5.8 기본 '건'
        targetTotal: fields.targetTotal ?? 0,
        targetByYear: fields.targetByYear ?? {},
        orgId: fields.orgId ?? null,
        note: fields.note ?? '',
        order: nextOrder(existing),
      },
      user.id
    );

    revalidateGoals(pid);
    return { ok: true, data: created };
  } catch (e) {
    return toFailure(e);
  }
}

// O-1: 지표 행 편집은 여러 필드를 한 번에 바꾸므로 expectedVersion을 받아 잠금을 건다.
// D-3(Σ targetByYear ≠ targetTotal)은 저장을 막지 않는다 — 경고는 getGoalsData가 실어 보낸다.
export async function updateDeliverable(
  id: string,
  patch: unknown,
  expectedVersion?: number
): Promise<ActionResult<Deliverable>> {
  let client: SupabaseClient | undefined;
  try {
    const did = parseOrThrow(uuidSchema, id, '성과목표 ID 형식이 올바르지 않습니다.');
    const parsed = parseOrThrow(deliverablePatchSchema, patch, '성과목표 정보가 올바르지 않습니다.');
    const ctx = await requireApprovedUser();
    client = ctx.client;

    // 기관·연차가 patch에 들어올 때만 소속을 확인한다 (조회 1~2회를 아끼기 위해)
    if (parsed.orgId !== undefined || parsed.targetByYear !== undefined) {
      const before = await deliverablesRepo.getDeliverableById(client, did);
      await assertGoalRefsInProject(client, before.projectId, {
        orgId: parsed.orgId,
        yearIds: parsed.targetByYear === undefined ? undefined : Object.keys(parsed.targetByYear),
      });
    }

    const updated = await deliverablesRepo.updateDeliverable(
      client,
      did,
      parsed,
      ctx.user.id,
      expectedVersion
    );
    revalidateGoals(updated.projectId);
    return { ok: true, data: updated };
  } catch (e) {
    return toFailure(e, client);
  }
}

// 실적(deliverable_achievements)과 조인(achievement_members)은 FK cascade로 함께 지워진다 (N-1, N-2).
// tasks와의 연계(task_deliverables)도 cascade다 — 작업 자체는 남는다.
export async function deleteDeliverable(id: string): Promise<ActionResult<null>> {
  try {
    const did = parseOrThrow(uuidSchema, id, '성과목표 ID 형식이 올바르지 않습니다.');
    const { client } = await requireApprovedUser();

    const deliverable = await deliverablesRepo.getDeliverableById(client, did);
    await deliverablesRepo.removeDeliverable(client, did);

    revalidateGoals(deliverable.projectId);
    return { ok: true, data: null };
  } catch (e) {
    return toFailure(e);
  }
}

// H-10, X-3: 넘어온 순서대로 0..n-1. 다른 과제 목표가 섞이면 RPC가 거부한다 (SA-3).
export async function reorderDeliverables(
  projectId: string,
  orderedIds: string[]
): Promise<ActionResult<null>> {
  try {
    const pid = parseOrThrow(uuidSchema, projectId, '과제 ID 형식이 올바르지 않습니다.');
    const ids = parseOrThrow(orderedIdsSchema, orderedIds, '정렬 목록이 올바르지 않습니다.');
    const { client } = await requireApprovedUser();
    await deliverablesRepo.reorderDeliverables(client, pid, ids);
    revalidateGoals(pid);
    return { ok: true, data: null };
  } catch (e) {
    return toFailure(e);
  }
}

// §7.7 연차별 목표 매트릭스 셀 편집. O-2: 단일 조작이라 낙관적 잠금을 생략한다.
// 넘어온 맵으로 통째로 교체한다 — 셀을 비우는 조작(키 삭제)이 표현돼야 하기 때문이다.
export async function setDeliverableYearTargets(
  id: string,
  targetByYear: unknown
): Promise<ActionResult<Deliverable>> {
  try {
    const did = parseOrThrow(uuidSchema, id, '성과목표 ID 형식이 올바르지 않습니다.');
    const targets = parseOrThrow(
      deliverableYearTargetsSchema,
      targetByYear,
      '연차별 목표 값이 올바르지 않습니다.'
    );
    const { user, client } = await requireApprovedUser();

    const before = await deliverablesRepo.getDeliverableById(client, did);
    await assertGoalRefsInProject(client, before.projectId, { yearIds: Object.keys(targets) });

    const updated = await deliverablesRepo.updateDeliverable(
      client,
      did,
      { targetByYear: targets },
      user.id
    );
    revalidateGoals(updated.projectId);
    return { ok: true, data: updated };
  } catch (e) {
    return toFailure(e);
  }
}

// 실적이 이 성과목표의 것인지 확인한다. 다른 지표의 실적 id로 갱신·삭제하면
// 화면에 보이지 않는 행이 조용히 바뀐다.
function assertAchievementBelongs(
  deliverable: Deliverable,
  achievementId: string
): DeliverableAchievement {
  const achievement = deliverable.achievements.find((a) => a.id === achievementId);
  if (!achievement) {
    throw new NotFoundError('이 성과목표에서 해당 실적을 찾을 수 없습니다.');
  }
  return achievement;
}

export async function addAchievement(
  deliverableId: string,
  input: unknown
): Promise<ActionResult<DeliverableAchievement>> {
  try {
    const did = parseOrThrow(uuidSchema, deliverableId, '성과목표 ID 형식이 올바르지 않습니다.');
    const fields = parseOrThrow(achievementCreateSchema, input, '실적 정보가 올바르지 않습니다.');
    const { user, client } = await requireApprovedUser();

    const deliverable = await deliverablesRepo.getDeliverableById(client, did);
    await assertGoalRefsInProject(client, deliverable.projectId, {
      orgId: fields.orgId,
      memberIds: fields.memberIds,
      yearIds: fields.yearId === undefined ? undefined : [fields.yearId],
    });

    const created = await deliverablesRepo.addAchievement(
      client,
      did,
      {
        title: fields.title,
        date: fields.date,
        yearId: fields.yearId ?? null,
        orgId: fields.orgId ?? null,
        memberIds: fields.memberIds ?? [],
        evidenceUrl: fields.evidenceUrl ?? '',
        note: fields.note ?? '',
      },
      user.id
    );

    revalidateGoals(deliverable.projectId);
    return { ok: true, data: created };
  } catch (e) {
    return toFailure(e);
  }
}

// O-1: 실적 편집 폼은 여러 필드를 한 번에 바꾸므로 expectedVersion을 받아 잠금을 건다
export async function updateAchievement(
  deliverableId: string,
  achievementId: string,
  patch: unknown,
  expectedVersion?: number
): Promise<ActionResult<DeliverableAchievement>> {
  let client: SupabaseClient | undefined;
  try {
    const did = parseOrThrow(uuidSchema, deliverableId, '성과목표 ID 형식이 올바르지 않습니다.');
    const aid = parseOrThrow(uuidSchema, achievementId, '실적 ID 형식이 올바르지 않습니다.');
    const parsed = parseOrThrow(achievementPatchSchema, patch, '실적 정보가 올바르지 않습니다.');
    const ctx = await requireApprovedUser();
    client = ctx.client;

    const deliverable = await deliverablesRepo.getDeliverableById(client, did);
    assertAchievementBelongs(deliverable, aid);
    await assertGoalRefsInProject(client, deliverable.projectId, {
      orgId: parsed.orgId,
      memberIds: parsed.memberIds,
      yearIds: parsed.yearId === undefined ? undefined : [parsed.yearId],
    });

    const updated = await deliverablesRepo.updateAchievement(
      client,
      aid,
      parsed,
      ctx.user.id,
      expectedVersion
    );
    revalidateGoals(deliverable.projectId);
    return { ok: true, data: updated };
  } catch (e) {
    return toFailure(e, client);
  }
}

export async function deleteAchievement(
  deliverableId: string,
  achievementId: string
): Promise<ActionResult<null>> {
  try {
    const did = parseOrThrow(uuidSchema, deliverableId, '성과목표 ID 형식이 올바르지 않습니다.');
    const aid = parseOrThrow(uuidSchema, achievementId, '실적 ID 형식이 올바르지 않습니다.');
    const { client } = await requireApprovedUser();

    const deliverable = await deliverablesRepo.getDeliverableById(client, did);
    assertAchievementBelongs(deliverable, aid);
    await deliverablesRepo.deleteAchievement(client, aid);

    revalidateGoals(deliverable.projectId);
    return { ok: true, data: null };
  } catch (e) {
    return toFailure(e);
  }
}

// ─── TechTarget (§5.9, §6.3) ──────────────────────────────────────────────────

export async function createTechTarget(
  projectId: string,
  input: unknown
): Promise<ActionResult<TechTarget>> {
  try {
    const pid = parseOrThrow(uuidSchema, projectId, '과제 ID 형식이 올바르지 않습니다.');
    const fields = parseOrThrow(techTargetCreateSchema, input, '기술목표 정보가 올바르지 않습니다.');
    const { user, client } = await requireApprovedUser();

    await assertGoalRefsInProject(client, pid, {
      orgId: fields.orgId,
      yearIds: fields.targetByYear === undefined ? undefined : Object.keys(fields.targetByYear),
    });

    const existing = await techTargetsRepo.listTechTargets(client, pid);
    const created = await techTargetsRepo.createTechTarget(
      client,
      {
        projectId: pid,
        name: fields.name,
        unit: fields.unit ?? '',
        direction: fields.direction ?? 'higher_better', // §5.9 기본값
        weight: fields.weight ?? 0,
        targetValue: fields.targetValue ?? 0,
        targetByYear: fields.targetByYear ?? {},
        baselineDomestic: fields.baselineDomestic ?? null,
        worldBest: fields.worldBest ?? null,
        worldBestHolder: fields.worldBestHolder ?? '',
        measureMethod: fields.measureMethod ?? 'self',
        measureDescription: fields.measureDescription ?? '',
        orgId: fields.orgId ?? null,
        order: nextOrder(existing),
      },
      user.id
    );

    revalidateGoals(pid);
    return { ok: true, data: created };
  } catch (e) {
    return toFailure(e);
  }
}

// O-1: 평가항목 행 편집은 여러 필드를 한 번에 바꾸므로 expectedVersion을 받아 잠금을 건다.
// T-3(Σweight ≠ 100)은 저장을 막지 않는다 — 경고는 getGoalsData가 실어 보낸다.
export async function updateTechTarget(
  id: string,
  patch: unknown,
  expectedVersion?: number
): Promise<ActionResult<TechTarget>> {
  let client: SupabaseClient | undefined;
  try {
    const tid = parseOrThrow(uuidSchema, id, '기술목표 ID 형식이 올바르지 않습니다.');
    const parsed = parseOrThrow(techTargetPatchSchema, patch, '기술목표 정보가 올바르지 않습니다.');
    const ctx = await requireApprovedUser();
    client = ctx.client;

    if (parsed.orgId !== undefined || parsed.targetByYear !== undefined) {
      const before = await techTargetsRepo.getTechTargetById(client, tid);
      await assertGoalRefsInProject(client, before.projectId, {
        orgId: parsed.orgId,
        yearIds: parsed.targetByYear === undefined ? undefined : Object.keys(parsed.targetByYear),
      });
    }

    const updated = await techTargetsRepo.updateTechTarget(
      client,
      tid,
      parsed,
      ctx.user.id,
      expectedVersion
    );
    revalidateGoals(updated.projectId);
    return { ok: true, data: updated };
  } catch (e) {
    return toFailure(e, client);
  }
}

// 측정 이력(tech_target_records)과 작업 연계(task_tech_targets)는 FK cascade로 함께 지워진다 (N-1)
export async function deleteTechTarget(id: string): Promise<ActionResult<null>> {
  try {
    const tid = parseOrThrow(uuidSchema, id, '기술목표 ID 형식이 올바르지 않습니다.');
    const { client } = await requireApprovedUser();

    const techTarget = await techTargetsRepo.getTechTargetById(client, tid);
    await techTargetsRepo.removeTechTarget(client, tid);

    revalidateGoals(techTarget.projectId);
    return { ok: true, data: null };
  } catch (e) {
    return toFailure(e);
  }
}

// H-10, X-3: 넘어온 순서대로 0..n-1. 다른 과제 목표가 섞이면 RPC가 거부한다 (SA-3).
export async function reorderTechTargets(
  projectId: string,
  orderedIds: string[]
): Promise<ActionResult<null>> {
  try {
    const pid = parseOrThrow(uuidSchema, projectId, '과제 ID 형식이 올바르지 않습니다.');
    const ids = parseOrThrow(orderedIdsSchema, orderedIds, '정렬 목록이 올바르지 않습니다.');
    const { client } = await requireApprovedUser();
    await techTargetsRepo.reorderTechTargets(client, pid, ids);
    revalidateGoals(pid);
    return { ok: true, data: null };
  } catch (e) {
    return toFailure(e);
  }
}

// §7.7 연차별 목표치 매트릭스 셀 편집. O-2: 단일 조작이라 낙관적 잠금을 생략한다.
export async function setTechTargetYearTargets(
  id: string,
  targetByYear: unknown
): Promise<ActionResult<TechTarget>> {
  try {
    const tid = parseOrThrow(uuidSchema, id, '기술목표 ID 형식이 올바르지 않습니다.');
    const targets = parseOrThrow(
      techYearTargetsSchema,
      targetByYear,
      '연차별 목표치가 올바르지 않습니다.'
    );
    const { user, client } = await requireApprovedUser();

    const before = await techTargetsRepo.getTechTargetById(client, tid);
    await assertGoalRefsInProject(client, before.projectId, { yearIds: Object.keys(targets) });

    const updated = await techTargetsRepo.updateTechTarget(
      client,
      tid,
      { targetByYear: targets },
      user.id
    );
    revalidateGoals(updated.projectId);
    return { ok: true, data: updated };
  } catch (e) {
    return toFailure(e);
  }
}

// 측정 이력이 이 기술목표의 것인지 확인한다. 남의 항목의 record id로 갱신하면
// 그 항목의 "현재 실적치"(§6.3)가 조용히 바뀐다.
function assertRecordBelongs(techTarget: TechTarget, recordId: string): TechTargetRecord {
  const record = techTarget.records.find((r) => r.id === recordId);
  if (!record) {
    throw new NotFoundError('이 기술목표에서 해당 측정 이력을 찾을 수 없습니다.');
  }
  return record;
}

export async function addTechRecord(
  techTargetId: string,
  input: unknown
): Promise<ActionResult<TechTargetRecord>> {
  try {
    const tid = parseOrThrow(uuidSchema, techTargetId, '기술목표 ID 형식이 올바르지 않습니다.');
    const fields = parseOrThrow(techRecordCreateSchema, input, '측정 정보가 올바르지 않습니다.');
    const { user, client } = await requireApprovedUser();

    const techTarget = await techTargetsRepo.getTechTargetById(client, tid);
    await assertGoalRefsInProject(client, techTarget.projectId, {
      yearIds: fields.yearId === undefined ? undefined : [fields.yearId],
    });

    const created = await techTargetsRepo.addRecord(
      client,
      tid,
      {
        value: fields.value,
        date: fields.date,
        yearId: fields.yearId ?? null,
        // 측정 방법을 생략하면 항목의 기본 측정방법을 따른다 — T-4 경고 판정의 기준과 맞춘다
        method: fields.method ?? techTarget.measureMethod,
        evaluator: fields.evaluator ?? '',
        evidenceUrl: fields.evidenceUrl ?? '',
        note: fields.note ?? '',
      },
      user.id
    );

    revalidateGoals(techTarget.projectId);
    return { ok: true, data: created };
  } catch (e) {
    return toFailure(e);
  }
}

// O-1: 측정 이력 편집은 여러 필드를 한 번에 바꾸므로 expectedVersion을 받아 잠금을 건다
export async function updateTechRecord(
  techTargetId: string,
  recordId: string,
  patch: unknown,
  expectedVersion?: number
): Promise<ActionResult<TechTargetRecord>> {
  let client: SupabaseClient | undefined;
  try {
    const tid = parseOrThrow(uuidSchema, techTargetId, '기술목표 ID 형식이 올바르지 않습니다.');
    const rid = parseOrThrow(uuidSchema, recordId, '측정 이력 ID 형식이 올바르지 않습니다.');
    const parsed = parseOrThrow(techRecordPatchSchema, patch, '측정 정보가 올바르지 않습니다.');
    const ctx = await requireApprovedUser();
    client = ctx.client;

    const techTarget = await techTargetsRepo.getTechTargetById(client, tid);
    assertRecordBelongs(techTarget, rid);
    await assertGoalRefsInProject(client, techTarget.projectId, {
      yearIds: parsed.yearId === undefined ? undefined : [parsed.yearId],
    });

    const updated = await techTargetsRepo.updateRecord(
      client,
      rid,
      parsed,
      ctx.user.id,
      expectedVersion
    );
    revalidateGoals(techTarget.projectId);
    return { ok: true, data: updated };
  } catch (e) {
    return toFailure(e, client);
  }
}

export async function deleteTechRecord(
  techTargetId: string,
  recordId: string
): Promise<ActionResult<null>> {
  try {
    const tid = parseOrThrow(uuidSchema, techTargetId, '기술목표 ID 형식이 올바르지 않습니다.');
    const rid = parseOrThrow(uuidSchema, recordId, '측정 이력 ID 형식이 올바르지 않습니다.');
    const { client } = await requireApprovedUser();

    const techTarget = await techTargetsRepo.getTechTargetById(client, tid);
    assertRecordBelongs(techTarget, rid);
    await techTargetsRepo.deleteRecord(client, rid);

    revalidateGoals(techTarget.projectId);
    return { ok: true, data: null };
  } catch (e) {
    return toFailure(e);
  }
}

// ─── 조회 (§9 조회 목록 — 서버 컴포넌트에서 직접 호출) ────────────────────────

// §7.7 목표 관리 화면 전체. 달성률·경고 판정은 전부 lib/goals.ts가 계산한 값을 그대로 싣는다 —
// 화면이 다시 판정하면 규칙이 두 곳에 생긴다.
export async function getGoalsData(projectId: string): Promise<ActionResult<GoalsData>> {
  try {
    const pid = parseOrThrow(uuidSchema, projectId, '과제 ID 형식이 올바르지 않습니다.');
    const { client } = await requireApprovedUser();

    // 하나라도 실패하면 실패를 그대로 올린다 — 빈 배열 폴백은 데이터 손상을 감춘다 (절대 규칙 5)
    const [years, organizations, members, deliverables, techTargets] = await Promise.all([
      yearsRepo.listYears(client, pid),
      organizationsRepo.listOrganizations(client, pid),
      membersRepo.listMembers(client, pid),
      deliverablesRepo.listDeliverables(client, pid),
      techTargetsRepo.listTechTargets(client, pid),
    ]);

    const deliverableViews: DeliverableView[] = deliverables.map((deliverable) => {
      const summary = summarizeDeliverable(deliverable);

      // 목표도 실적도 없는 연차까지 키를 채워 UI가 폴백 분기를 만들지 않게 한다.
      // summarize의 byYear는 목표가 있거나 실적이 있는 연차만 담는다 (D-5의 "목표 외 달성" 포함).
      const byYear: DeliverableView['byYear'] = {};
      for (const year of years) {
        byYear[year.id] = {
          target: deliverable.targetByYear[year.id] ?? null,
          achieved: 0,
          rate: null,
          offTarget: false,
        };
      }
      for (const yearRate of summary.byYear) {
        byYear[yearRate.yearId] = {
          // D-5: 키가 없으면 "목표 미설정"이다. 0과 구분해 null로 내린다
          target: deliverable.targetByYear[yearRate.yearId] ?? null,
          achieved: yearRate.achieved,
          rate: yearRate.rate,
          offTarget: yearRate.offTarget,
        };
      }

      return {
        deliverable,
        achievedTotal: summary.achieved,
        rate: summary.rate,
        byYear,
        yearTargetMismatch: summary.yearTargetMismatch,
        yearTargetSum: Object.values(deliverable.targetByYear).reduce((sum, v) => sum + v, 0),
        unassignedAchieved: summary.unassignedAchieved,
      };
    });

    const deliverableTotal = computeDeliverableTotal(deliverables);

    // §7.7 "유형별 도넛"용 단순 합산. 순서는 목록 등장 순(= sort_order)으로 결정적이다
    const byTypeMap = new Map<DeliverableType, { type: DeliverableType; target: number; achieved: number }>();
    for (const deliverable of deliverables) {
      const bucket = byTypeMap.get(deliverable.type) ?? {
        type: deliverable.type,
        target: 0,
        achieved: 0,
      };
      bucket.target += deliverable.targetTotal;
      bucket.achieved += deliverable.achievements.length;
      byTypeMap.set(deliverable.type, bucket);
    }

    const techTargetViews: TechTargetView[] = techTargets.map((techTarget) => {
      const summary = summarizeTechTarget(techTarget);
      return {
        techTarget,
        current: summary.current,
        rate: summary.rate,
        evaluatorMissing: summary.evaluatorMissing,
      };
    });

    const techTotal = computeTechTargetTotal(techTargets);

    return {
      ok: true,
      data: {
        projectId: pid,
        years,
        organizations,
        members,
        deliverables: deliverableViews,
        deliverableSummary: {
          targetTotal: deliverableTotal.target,
          achievedTotal: deliverableTotal.achieved,
          rate: deliverableTotal.rate,
          byType: [...byTypeMap.values()],
        },
        techTargets: techTargetViews,
        techSummary: {
          weightedRate: techTotal.weightedRate,
          weightSum: techTotal.totalWeight,
          weightMismatch: techTotal.weightMismatch,
        },
      },
    };
  } catch (e) {
    return toFailure(e);
  }
}
