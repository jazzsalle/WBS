'use server';

// 성과·기술목표 양식 서버 액션 (SOT §9 Goal Form, §6.17 GF-1~GF-11, §7.7)
//
// 수행 양식(actions/input-form.ts의 수행 모드)과 같은 뼈대다:
//   · 좌표·파싱·미리보기·페이로드는 lib/goal-form/의 순수 함수가 정한다 (GF-1)
//   · 워크북 쓰기는 lib/input-form-adapter.ts, 읽기는 lib/import-adapter.ts (S-22, IN-8)
//   · 여기서는 인증·검증·리포지토리 호출과 **막을 것과 알릴 것의 구분**만 한다
//
// 핵심 불변식:
//   IN-6  previewGoalForm과 commitGoalForm은 runGoalFormPipeline 하나를 탄다. fileHash 대조로 같은 파일임을 보장한다.
//   GF-5  충돌·삭제 후보는 파일의 `_meta`(내려받을 때 version)로 정해진다 — 반영 시점 DB로 다시 정하지 않는다.
//         충돌 행은 건너뛰고(전체 롤백 아님) 미리보기 단계·RPC 단계 충돌을 **둘 다 그대로** 돌려준다(절대 규칙 5).
//   S-21  blocking이 하나라도 있으면 RPC를 부르지 않는다 — 부분 반영 없음.
//
// supabase 직접 호출 금지 — 반드시 lib/db/ 리포지토리를 거친다 (절대 규칙 3, §8.6).

import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { ActionResult } from '@/types';
import { requireApprovedUser } from '@/lib/auth/guard';
import { RuleViolationError, ValidationError, toActionFailure } from '@/lib/db/errors';
import * as deliverablesRepo from '@/lib/db/deliverables';
import * as membersRepo from '@/lib/db/members';
import * as organizationsRepo from '@/lib/db/organizations';
import * as projectsRepo from '@/lib/db/projects';
import * as snapshotsRepo from '@/lib/db/import-snapshots';
import * as tasksRepo from '@/lib/db/tasks';
import * as techTargetsRepo from '@/lib/db/tech-targets';
import * as yearsRepo from '@/lib/db/years';
import type { GoalFormCommitResult, GoalFormConflict, GoalFormKind } from '@/lib/db/import-snapshots';
import { buildGoalForm as buildGoalFormWorkbook } from '@/lib/goal-form/build';
import { goalSheetsFor } from '@/lib/goal-form/layout';
import { parseGoalForm } from '@/lib/goal-form/parse';
import {
  buildGoalFormCommit,
  previewGoalForm as buildGoalFormPreview,
  type GoalFormPreview,
  type GoalFormPreviewInput,
  type GoalRates,
} from '@/lib/goal-form/preview';
import type { GoalFormMeta, GoalMetaLabel } from '@/lib/goal-form/types';
import { writeInputFormWorkbook } from '@/lib/input-form-adapter';
import { MAX_UPLOAD_BYTES, UPLOAD_FIELD, readUploadedWorkbook } from '@/lib/import-adapter';

// ─── 화면 계약 (§7.7 [목표 양식 올리기]) ──────────────────────────────────────
// 전부 직렬화 가능한 값이다(클라이언트 컴포넌트로 그대로 넘어간다) — Map·Date·함수를 싣지 않는다

export interface GoalFormPreviewResult {
  fileName: string;
  /** sha256 hex. commitGoalForm이 대조한다 (IN-6) */
  fileHash: string;
  /** `[삭제 포함]` 꺼짐 기준 미리보기. `preview.rates.after`도 꺼짐 기준이다 */
  preview: GoalFormPreview;
  /** `[삭제 포함]` 켜짐 기준 달성률 전후 — 토글마다 서버를 다시 부르지 않는다 */
  ratesWithDeletes: { before: GoalRates; after: GoalRates };
  /** 행 값의 id(연차·기관·관여자)를 양식에 적힌 라벨로 되돌리는 표. `_meta` 그대로다 */
  labels: { years: GoalMetaLabel[]; orgs: GoalMetaLabel[]; members: GoalMetaLabel[] };
  /** 반영을 막은 첫 이유(`성과목표 시트 5행: …`). blocked가 false면 null */
  blockingReason: string | null;
}

/**
 * RPC 결과(건수 4종·conflicts·snapshotId)를 **그대로** 싣고, RPC가 모르는 두 가지를 덧붙인다.
 * 미리보기 단계 충돌 행은 페이로드에 들어가지 않으므로 RPC의 `conflicts`에 나타나지 않는다 — 따로 싣지 않으면 사라진다.
 */
export interface GoalFormCommitOutcome extends GoalFormCommitResult {
  /** 미리보기 단계에서 이미 충돌로 판정돼 페이로드에 넣지 않은 행 (GF-5) */
  previewConflicts: GoalFormConflict[];
  /** `includeDeletes`가 꺼져 지우지 않은 삭제 후보 수 */
  skippedDeletes: number;
}

// ─── 입력 검증 (§9: 모든 액션은 Zod로 입력 검증) ──────────────────────────────

const uuidSchema = z.uuid();
const fileHashSchema = z.string().trim().min(1, '미리보기를 먼저 실행해야 반영할 수 있습니다.');
// 문자열 'false'가 truthy로 삭제를 켜는 일이 없도록 boolean만 받는다 — 지표 삭제는 실적·측정을 cascade로 지운다
const includeDeletesSchema = z.boolean('삭제 포함 여부가 올바르지 않습니다.');
// 문구·상한은 readUploadedWorkbook과 같다 — 어댑터가 한 번 더 본다. 여기서는 인증·DB 조회 전에 빨리 거른다
const uploadSchema = z
  .instanceof(FormData, { message: '업로드된 파일이 없습니다.' })
  .refine((data) => {
    const entry = data.get(UPLOAD_FIELD);
    return entry !== null && typeof entry !== 'string';
  }, '업로드된 파일이 없습니다.')
  .refine((data) => (data.get(UPLOAD_FIELD) as Blob).size > 0, '빈 파일입니다.')
  .refine(
    (data) => (data.get(UPLOAD_FIELD) as Blob).size <= MAX_UPLOAD_BYTES,
    `파일이 ${MAX_UPLOAD_BYTES / 1024 / 1024}MB 상한을 넘습니다. 필요한 시트만 남겨서 다시 올려주세요.`
  );

function parseOrThrow<T>(schema: z.ZodType<T>, value: unknown, fallback: string): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new ValidationError(parsed.error.issues[0]?.message ?? fallback);
  return parsed.data;
}

// ─── 공통 헬퍼 ────────────────────────────────────────────────────────────────

// 목표 양식 반영은 목표·실적·측정과 WBS 연계(삭제 시 끊김)를 바꾼다. 대시보드('/')는 달성률을, 설정은 스냅샷 목록을 보인다
function revalidateGoalForm(projectId: string): void {
  revalidatePath('/');
  revalidatePath(`/projects/${projectId}`);
  revalidatePath(`/projects/${projectId}/goals`);
  revalidatePath(`/projects/${projectId}/wbs`);
  revalidatePath('/settings');
}

const SHEET_KEY_OF_KIND = {
  deliverable: 'deliverables',
  achievement: 'achievements',
  techTarget: 'techTargets',
  record: 'records',
} as const satisfies Record<GoalFormKind, string>;

/** 스냅샷 출처의 시트명. 양식은 네 시트를 한 번에 반영하므로 하나를 고르지 않는다 */
function sourceSheetName(meta: GoalFormMeta): string {
  const defs = goalSheetsFor(meta.years.map((year) => year.label));
  return [defs.deliverables.name, defs.achievements.name, defs.techTargets.name, defs.records.name].join('+');
}

/** 삭제 후보에 보일 "연계 작업 K"(GF-5). 작업 하나가 같은 목표를 두 번 가리키지 않는다(조인 테이블 PK) */
function linkedTaskCountsOf(
  tasks: readonly { deliverableIds: string[]; techTargetIds: string[] }[]
): GoalFormPreviewInput['linkedTaskCounts'] {
  const deliverable: Record<string, number> = {};
  const techTarget: Record<string, number> = {};
  for (const task of tasks) {
    for (const id of task.deliverableIds) deliverable[id] = (deliverable[id] ?? 0) + 1;
    for (const id of task.techTargetIds) techTarget[id] = (techTarget[id] ?? 0) + 1;
  }
  return { deliverable, techTarget };
}

// ─── 파이프라인 (미리보기·반영이 같은 경로를 쓴다 — IN-6) ────────────────────

interface GoalFormPipelineResult {
  fileName: string;
  fileHash: string;
  meta: GoalFormMeta;
  /** options만 바꿔 다시 부를 수 있는 미리보기 입력 — `[삭제 포함]` 켜짐 기준 달성률에 쓴다 */
  input: Omit<GoalFormPreviewInput, 'options'>;
  preview: GoalFormPreview;
}

/**
 * previewGoalForm과 commitGoalForm이 **공유하는 유일한 파싱 경로**. 판정을 두 번 쓰면 반드시 어긋난다.
 *
 * 순서: 파일 읽기(어댑터) → `_meta` 거부(GF-2) + 행 모델 파싱 → 과제·현재 목표 전부·연계 작업 → 미리보기(GF-5).
 * lib/goal-form이 던지는 `Error`(현재 데이터 손상·판정 불변식 위반)는 toGoalFormFailure가 문구째 올린다.
 */
async function runGoalFormPipeline(
  client: SupabaseClient,
  projectId: string,
  formData: FormData,
  includeDeletes: boolean
): Promise<GoalFormPipelineResult> {
  const upload = await readUploadedWorkbook(formData); // I-13·I-14·I-15는 어댑터가 지킨다

  const parsed = parseGoalForm(upload.sheets, { projectId });
  // 거부 문구는 파서가 정한다("입력 양식입니다…"·"다른 과제의 양식입니다" 등). 여기서 다시 쓰면 두 사전이 갈린다
  if (!parsed.ok) throw new RuleViolationError(parsed.rejection.message);

  // 하나라도 실패하면 실패를 그대로 올린다 — 빈 배열 폴백은 목표가 사라진 것을 감추고 전 행을 '이미 삭제됨'으로 만든다 (절대 규칙 5)
  const [, deliverables, techTargets, tasks] = await Promise.all([
    // 과제가 없으면(또는 RLS로 안 보이면) 목록이 비어 전 행이 충돌로 보인다 — 먼저 "찾을 수 없습니다"로 끊는다
    projectsRepo.getProjectById(client, projectId),
    deliverablesRepo.listDeliverables(client, projectId),
    techTargetsRepo.listTechTargets(client, projectId),
    tasksRepo.listTasksByProject(client, projectId),
  ]);

  const input: Omit<GoalFormPreviewInput, 'options'> = {
    meta: parsed.meta,
    rows: parsed.rows,
    current: { deliverables, techTargets },
    linkedTaskCounts: linkedTaskCountsOf(tasks),
  };
  const preview = buildGoalFormPreview({ ...input, options: { includeDeletes } });

  return { fileName: upload.fileName, fileHash: upload.fileHash, meta: parsed.meta, input, preview };
}

/** 반영을 막은 첫 이유. "안 됩니다"만으로는 어느 행을 고칠지 알 수 없다 */
function firstGoalBlockingReason(preview: GoalFormPreview, meta: GoalFormMeta): string {
  const fileIssue = preview.issues.find((issue) => issue.blocking);
  if (fileIssue) return fileIssue.message;
  const defs = goalSheetsFor(meta.years.map((year) => year.label));
  const rows = [
    ...preview.rows.deliverables,
    ...preview.rows.achievements,
    ...preview.rows.techTargets,
    ...preview.rows.records,
  ];
  for (const row of rows) {
    const issue = row.issues.find((candidate) => candidate.blocking);
    if (issue) return `${defs[SHEET_KEY_OF_KIND[row.kind]].name} 시트 ${row.sheetRow}행: ${issue.message}`;
  }
  // blocked인데 이유를 못 찾으면 판정과 설명이 어긋난 것이다 — 이유 없이 막았다고 말하지 않는다
  throw new Error('목표 양식이 차단됐지만 차단 사유를 찾지 못했습니다.');
}

// ─── §9 buildGoalForm ─────────────────────────────────────────────────────────

/**
 * 과제 하나의 목표 양식 xlsx (§7.7 [목표 양식 내려받기]). **읽기 전용이다** — 앱 데이터를 바꾸지 않는다.
 * 파일 저장은 호출자(셸)의 몫이라 base64로 돌려준다 — 서버는 디스크에 쓰지 않는다.
 *
 * 인력은 비활성까지 전부 싣는다 — 생성기는 목록에 없는 관여자를 만나면 던진다. 활성으로 거르면 참여 종료자가
 * 관여한 실적을 내려받을 수 없고, 빈 칸으로 다시 올리면 관여자가 지워진다.
 */
export async function buildGoalForm(
  projectId: string
): Promise<ActionResult<{ fileName: string; contentBase64: string }>> {
  try {
    const pid = parseOrThrow(uuidSchema, projectId, '과제 ID 형식이 올바르지 않습니다.');
    const { client } = await requireApprovedUser();

    const [project, years, orgs, members, deliverables, techTargets] = await Promise.all([
      projectsRepo.getProjectById(client, pid),
      yearsRepo.listYears(client, pid),
      organizationsRepo.listOrganizations(client, pid),
      membersRepo.listMembers(client, pid),
      deliverablesRepo.listDeliverables(client, pid),
      techTargetsRepo.listTechTargets(client, pid),
    ]);

    const workbook = buildGoalFormWorkbook({
      project: { id: project.id, name: project.name },
      years: years.map((year) => ({ id: year.id, name: year.name, order: year.order })),
      orgs: orgs.map((org) => ({ id: org.id, name: org.name })),
      members: members.map((member) => ({ id: member.id, name: member.name })),
      deliverables,
      techTargets,
      generatedAt: new Date().toISOString(),
    });
    const buffer = await writeInputFormWorkbook(workbook);

    return {
      ok: true,
      data: { fileName: workbook.fileName, contentBase64: buffer.toString('base64') },
    };
  } catch (e) {
    return toGoalFormFailure(e);
  }
}

// ─── §9 previewGoalForm ───────────────────────────────────────────────────────

/**
 * 시트별 추가·변경·유지·충돌·오류, 삭제 후보("실적 N · 측정 M · 연계 작업 K"), 경고, 달성률 전후 (GF-5~GF-7).
 * **저장하는 것은 없다.** 리포지토리 호출은 전부 읽기다.
 */
export async function previewGoalForm(
  projectId: string,
  formData: FormData
): Promise<ActionResult<GoalFormPreviewResult>> {
  try {
    const pid = parseOrThrow(uuidSchema, projectId, '과제 ID 형식이 올바르지 않습니다.');
    parseOrThrow(uploadSchema, formData, '업로드된 파일이 없습니다.');
    const { client } = await requireApprovedUser();

    const result = await runGoalFormPipeline(client, pid, formData, false);
    const { preview, meta } = result;
    // 같은 입력에 삭제만 켠 판정 — 순수 함수라 DB를 다시 읽지 않는다
    const withDeletes = buildGoalFormPreview({ ...result.input, options: { includeDeletes: true } });

    return {
      ok: true,
      data: {
        fileName: result.fileName,
        fileHash: result.fileHash,
        preview,
        ratesWithDeletes: withDeletes.rates,
        labels: { years: meta.years, orgs: meta.orgs, members: meta.members },
        blockingReason: preview.blocked ? firstGoalBlockingReason(preview, meta) : null,
      },
    };
  } catch (e) {
    return toGoalFormFailure(e);
  }
}

// ─── §9 commitGoalForm ────────────────────────────────────────────────────────

/**
 * 목표 양식 반영(GF-5): id 기반 추가·변경·(`includeDeletes`일 때만)삭제 + 스냅샷(`kind: 'goal_form'`, GF-11)이
 * `commit_goal_form` RPC **한 트랜잭션**이다. 액션은 미리보기 결과를 페이로드로 옮기기만 한다 —
 * 판정은 buildGoalFormCommit(순수)이 하고, version 인자는 받지 않는다(기준은 파일의 `_meta`, GF-5).
 *
 * 막는 것: 미리보기와 다른 파일(fileHash), `blocked`(S-21), 반영할 행 0건. 경고는 통과한다.
 * 충돌은 막지 않는다 — 그 행만 건너뛰고 미리보기 단계 충돌과 RPC 단계 충돌을 **둘 다 그대로** 돌려준다(절대 규칙 5).
 */
export async function commitGoalForm(
  projectId: string,
  formData: FormData,
  fileHash: string,
  includeDeletes: boolean
): Promise<ActionResult<GoalFormCommitOutcome>> {
  try {
    const pid = parseOrThrow(uuidSchema, projectId, '과제 ID 형식이 올바르지 않습니다.');
    parseOrThrow(uploadSchema, formData, '업로드된 파일이 없습니다.');
    const expectedHash = parseOrThrow(fileHashSchema, fileHash, '미리보기를 먼저 실행해야 반영할 수 있습니다.');
    const withDeletes = parseOrThrow(includeDeletesSchema, includeDeletes, '삭제 포함 여부가 올바르지 않습니다.');
    const { client } = await requireApprovedUser();

    // previewGoalForm과 같은 경로 (IN-6)
    const result = await runGoalFormPipeline(client, pid, formData, withDeletes);
    if (result.fileHash !== expectedHash) {
      throw new ValidationError('파일이 미리보기 때와 다릅니다 — 다시 올리세요');
    }

    const { preview, meta } = result;
    if (preview.blocked) {
      throw new RuleViolationError(`반영할 수 없습니다 — ${firstGoalBlockingReason(preview, meta)}`);
    }

    const { payload, expected } = buildGoalFormCommit(preview);
    const skippedDeletes = withDeletes ? 0 : preview.counts.deleteCandidates;
    const total = [payload.deliverables, payload.achievements, payload.techTargets, payload.records].reduce(
      (sum, block) => sum + block.adds.length + block.updates.length + block.deleteIds.length,
      0
    );
    if (total === 0) {
      // RPC는 빈 반영을 '반영할 목표 행이 없습니다'로 거부한다 — 그 전에 왜 비었는지를 사용자 말로 알린다.
      // 충돌 건수도 문구에 넣는다: 실패 결과에는 목록을 실을 자리가 없고, 목록은 미리보기에 이미 보였다
      const reasons = [
        `변경 없음 ${preview.counts.unchanged}행`,
        preview.conflicts.length > 0
          ? `충돌 ${preview.conflicts.length}건은 내려받은 뒤 바뀌어 건너뜁니다 — 다시 내려받아 고치세요`
          : null,
        skippedDeletes > 0 ? `삭제 후보 ${skippedDeletes}건은 [삭제 포함]을 켜야 반영됩니다` : null,
      ].filter((reason): reason is string => reason !== null);
      throw new RuleViolationError(`반영할 목표 행이 없습니다 (${reasons.join(' · ')}).`);
    }

    const committed = await snapshotsRepo.commitGoalForm(client, pid, payload, expected, {
      fileName: result.fileName,
      sheetName: sourceSheetName(meta),
      fileHash: result.fileHash,
    });

    revalidateGoalForm(pid);
    return {
      ok: true,
      data: { ...committed, previewConflicts: preview.conflicts, skippedDeletes },
    };
  } catch (e) {
    return toGoalFormFailure(e);
  }
}

/**
 * 순수 계층·어댑터는 `Error`(또는 RangeError)를 던진다. 그대로 두면 toActionFailure가
 * "요청 처리 중 오류가 발생했습니다"로 덮어 **무엇이 왜 안 됐는지**가 사라진다 — actions/input-form.ts와 같은 태도다.
 * 'use server' 파일은 동기 헬퍼를 export할 수 없어 저쪽 것을 가져다 쓰지 못한다.
 */
function toGoalFormFailure(e: unknown): ActionResult<never> {
  if (e instanceof Error && (e.constructor === Error || e instanceof RangeError)) {
    console.error('[actions/goal-form] 목표 양식 처리 실패:', e);
    return { ok: false, error: e.message, code: 'RULE' };
  }
  return toActionFailure(e);
}
