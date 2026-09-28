'use server';

// hwpx 계획서 가져오기 서버 액션 (SOT §9 Plan Document, §6.18 HX-1·HX-8, §7.7 [계획서(hwpx) 가져오기])
//
// hwpx는 목표 양식 파서의 앞단일 뿐이다(HX-8) — 별도 반영 경로가 없다:
//   격자(클라이언트 추출, HX-1) → identifyPlanTables → buildPlanRows → previewGoalForm(allowDeletes: false)
//   → buildGoalFormCommit → commit_goal_form
//
// 핵심 불변식:
//   IN-6  previewPlanTables와 commitPlanTables는 runPlanPipeline 하나를 탄다. tablesHash 대조로 같은 격자임을 보장한다(S-13).
//   U-10  commit은 **그 시점 DB**로 `_meta`·대응·투영을 다시 계산한다 — 미리보기 뒤 바뀐 목표도 덮어쓴다(나중 쓰기 승).
//         그래서 미리보기 다이제스트 인자가 없다.
//   S-21  blocking이 하나라도 있으면 RPC를 부르지 않는다 — 부분 반영 없음.
//
// supabase 직접 호출 금지 — 반드시 lib/db/ 리포지토리를 거친다 (절대 규칙 3, §8.6).

import { createHash } from 'node:crypto';
import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { ActionResult } from '@/types';
import { requireApprovedUser } from '@/lib/auth/guard';
import { RuleViolationError, ValidationError, toActionFailure } from '@/lib/db/errors';
import * as deliverablesRepo from '@/lib/db/deliverables';
import * as organizationsRepo from '@/lib/db/organizations';
import * as projectsRepo from '@/lib/db/projects';
import * as snapshotsRepo from '@/lib/db/import-snapshots';
import * as techTargetsRepo from '@/lib/db/tech-targets';
import * as yearsRepo from '@/lib/db/years';
import type { GoalFormCommitResult, GoalFormConflict } from '@/lib/db/import-snapshots';
import {
  buildGoalFormCommit,
  previewGoalForm as buildGoalFormPreview,
  type GoalFormPreview,
  type GoalRates,
} from '@/lib/goal-form/preview';
import type { GoalMetaLabel } from '@/lib/goal-form/types';
import { PLAN_ISSUES, PLAN_TABLE_LABELS, type PlanIssue } from '@/lib/hwpx/issues';
import { checkPlanPayload } from '@/lib/hwpx/limits';
import { buildPlanRows, type PlanExcludedRow, type PlanRowsResult } from '@/lib/hwpx/rows';
import { serializePlanTables } from '@/lib/hwpx/serialize';
import { identifyPlanTables, type PlanTablesResult, type UnreadColumn } from '@/lib/hwpx/tables';
import { PLAN_DOCUMENT_SHEET_NAME, type PlanDocumentPayload, type PlanTableKind } from '@/lib/hwpx/types';

// ─── 화면 계약 (§7.7 [계획서(hwpx) 가져오기]) ─────────────────────────────────
// 전부 직렬화 가능한 값이다(클라이언트 컴포넌트로 그대로 넘어간다) — Map·Date·함수를 싣지 않는다

/** 찾은 표 요약 — 미리보기 전에 "무엇을 읽었는지"를 보인다(§7.7) */
export interface PlanTableSummary {
  kind: PlanTableKind;
  found: boolean;
  /** 이어 붙인 데이터 행 수(머리행 제외). 못 찾으면 0 */
  dataRows: number;
  /** 쪽 나뉨으로 이은 조각 수. 못 찾으면 0 */
  pieces: number;
  /** "…와 같은 표가 N개 더 있습니다 — 첫 표만 읽습니다: …"(HX-3). 없으면 null */
  duplicateNote: string | null;
  /** 읽지 않은 열(U-2 ignored·역할 없음·중복). 못 찾으면 [] */
  unreadColumns: UnreadColumn[];
}

export interface PlanPreviewResult {
  /** 격자 정규 직렬화의 sha256 hex. commitPlanTables에 그대로 되보낸다(S-13) */
  tablesHash: string;
  fileName: string;
  /** 삭제 후보 없음(allowDeletes: false, HX-8) */
  preview: GoalFormPreview;
  /** 반영 제외 행(U-7) — blocking·건수에 영향 없음 */
  excluded: PlanExcludedRow[];
  tableSummary: Record<PlanTableKind, PlanTableSummary>;
  /** 표 단위 사유(식별·잇기·열 역할 + 행 해석 중 표 수준). 행 사유는 preview 행마다 있다 */
  planIssues: PlanIssue[];
  /** sheetRow → "기술목표 표 N행 (순번 k)" / "성과목표 표 N행"(S-10) */
  locations: PlanRowsResult['locations'];
  /** 행 값의 id(연차·기관)를 라벨로 되돌리는 표. 합성 `_meta` 그대로다(S-11) */
  labels: { years: GoalMetaLabel[]; orgs: GoalMetaLabel[] };
  /** 반영을 막은 첫 이유(`기술목표 표 3행 (순번 3): …`). blocked가 false면 null */
  blockingReason: string | null;
  rates: { before: GoalRates; after: GoalRates };
}

/**
 * RPC 결과(건수 4종·conflicts·snapshotId)를 **그대로** 싣고, 미리보기 단계 충돌을 덧붙인다(actions/goal-form.ts와 같은 모양).
 * 삭제는 없으므로 skippedDeletes를 두지 않는다(HX-8).
 */
export interface PlanCommitOutcome extends GoalFormCommitResult {
  /** 미리보기 단계에서 이미 충돌로 판정돼 페이로드에 넣지 않은 행 */
  previewConflicts: GoalFormConflict[];
}

// ─── 입력 검증 (§9: 모든 액션은 Zod로 입력 검증) ──────────────────────────────

const uuidSchema = z.uuid();
const countSchema = z.number().int().nonnegative();
// 모양만 본다. 상한·rowCnt×colCnt 일치는 checkPlanPayload가 클라이언트와 같은 함수로 본다(S-14)
const payloadSchema = z.object({
  fileName: z.string().min(1, '파일 이름이 없습니다.').max(255, '파일 이름이 255자를 넘습니다.'),
  tables: z.array(
    z.object({
      index: countSchema,
      section: countSchema,
      rowCnt: countSchema,
      colCnt: countSchema,
      cells: z.array(z.array(z.string())),
    })
  ),
});
const tablesHashSchema = z
  .string()
  .trim()
  .min(1, '미리보기를 먼저 실행해야 반영할 수 있습니다.')
  .regex(/^[0-9a-f]{64}$/, '미리보기 해시 형식이 올바르지 않습니다 — 다시 올리세요');

function parseOrThrow<T>(schema: z.ZodType<T>, value: unknown, fallback: string): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new ValidationError(parsed.error.issues[0]?.message ?? fallback);
  return parsed.data;
}

function parsePayload(value: unknown): PlanDocumentPayload {
  const payload = parseOrThrow(payloadSchema, value, '계획서 표 형식이 올바르지 않습니다.');
  const check = checkPlanPayload(payload);
  if (!check.ok) throw new ValidationError(check.reason);
  return payload;
}

// ─── 공통 헬퍼 ────────────────────────────────────────────────────────────────

// actions/goal-form.ts와 같은 5곳 — 반영이 바꾸는 것(목표·달성률·WBS 연계 표시·스냅샷 목록)이 같다
function revalidatePlanDocument(projectId: string): void {
  revalidatePath('/');
  revalidatePath(`/projects/${projectId}`);
  revalidatePath(`/projects/${projectId}/goals`);
  revalidatePath(`/projects/${projectId}/wbs`);
  revalidatePath('/settings');
}

function hashTables(payload: PlanDocumentPayload): string {
  return createHash('sha256').update(serializePlanTables(payload), 'utf8').digest('hex');
}

const TABLE_KINDS: readonly PlanTableKind[] = ['tech', 'deliverable', 'method'];

function summarizeTables(tables: PlanTablesResult): Record<PlanTableKind, PlanTableSummary> {
  const summary = {} as Record<PlanTableKind, PlanTableSummary>;
  for (const kind of TABLE_KINDS) {
    const table = tables[kind];
    // duplicateTableIssue는 종류별로 한 번, 표 이름으로 시작한다(lib/hwpx/issues.ts)
    const duplicate = tables.issues.find(
      (issue) => issue.kind === 'duplicate-table' && issue.message.startsWith(PLAN_TABLE_LABELS[kind])
    );
    summary[kind] = {
      kind,
      found: table !== null,
      dataRows: table?.rows.length ?? 0,
      pieces: table?.pieces.length ?? 0,
      duplicateNote: duplicate?.message ?? null,
      unreadColumns: table?.unreadColumns ?? [],
    };
  }
  return summary;
}

// ─── 파이프라인 (미리보기·반영이 같은 경로를 쓴다 — IN-6) ────────────────────

interface PlanPipelineResult {
  tablesHash: string;
  tables: PlanTablesResult;
  plan: PlanRowsResult;
  preview: GoalFormPreview;
}

/**
 * previewPlanTables와 commitPlanTables가 **공유하는 유일한 해석 경로**.
 *
 * 순서: 해시(S-13) → 표 식별(HX-3·HX-4) → 과제·연차·기관·현재 목표 전부 → 행 해석(HX-5~HX-8) → 미리보기(GF-5).
 * `expectedHash`가 오면(commit) 해시 직후 대조한다 — 다른 격자면 DB를 읽기 전에 끊는다.
 * lib/hwpx·lib/goal-form이 던지는 `Error`는 toPlanDocumentFailure가 문구째 올린다.
 */
async function runPlanPipeline(
  client: SupabaseClient,
  projectId: string,
  payload: PlanDocumentPayload,
  expectedHash: string | null
): Promise<PlanPipelineResult> {
  const tablesHash = hashTables(payload);
  if (expectedHash !== null && tablesHash !== expectedHash) {
    throw new ValidationError('미리보기 때와 다른 표입니다 — 다시 올리세요');
  }

  const tables = identifyPlanTables(payload.tables);
  if (tables.tech === null && tables.deliverable === null) {
    throw new RuleViolationError(PLAN_ISSUES['no-goal-tables'].message);
  }

  // 하나라도 실패하면 실패를 그대로 올린다 — 빈 배열 폴백은 기존 목표를 감춰 전 행을 '추가'로 만든다 (절대 규칙 5).
  // 과제가 없으면(또는 RLS로 안 보이면) 목록이 비어 같은 일이 생긴다 — getProjectById가 "찾을 수 없습니다"로 끊는다
  const [, years, orgs, deliverables, techTargets] = await Promise.all([
    projectsRepo.getProjectById(client, projectId),
    yearsRepo.listYears(client, projectId),
    organizationsRepo.listOrganizations(client, projectId),
    deliverablesRepo.listDeliverables(client, projectId),
    techTargetsRepo.listTechTargets(client, projectId),
  ]);

  const current = { deliverables, techTargets };
  const plan = buildPlanRows({
    projectId,
    tables,
    years: years.map((year) => ({ id: year.id, name: year.name, order: year.order })),
    orgs: orgs.map((org) => ({ id: org.id, name: org.name })),
    current,
  });

  const preview = buildGoalFormPreview({
    meta: plan.meta,
    rows: plan.rows,
    current,
    // 연계 작업 수는 삭제 후보에만 쓰인다 — 계획서는 삭제 후보를 만들지 않으므로(HX-8) 읽지 않는다
    linkedTaskCounts: { deliverable: {}, techTarget: {} },
    options: { allowDeletes: false, includeDeletes: false },
  });

  return { tablesHash, tables, plan, preview };
}

/** 반영을 막은 첫 이유. 행 위치는 격자 기준 문구로 적는다(S-10) — 양식 시트 이름이 아니다 */
function firstPlanBlockingReason(preview: GoalFormPreview, locations: PlanRowsResult['locations']): string {
  const fileIssue = preview.issues.find((issue) => issue.blocking);
  if (fileIssue) return fileIssue.message;
  for (const row of preview.rows.techTargets) {
    const issue = row.issues.find((candidate) => candidate.blocking);
    if (issue) return `${locationOf(locations.techTargets, row.sheetRow)}: ${issue.message}`;
  }
  for (const row of preview.rows.deliverables) {
    const issue = row.issues.find((candidate) => candidate.blocking);
    if (issue) return `${locationOf(locations.deliverables, row.sheetRow)}: ${issue.message}`;
  }
  // 계획서는 실적·측정 행을 만들지 않는다(HX-8). 여기까지 왔다면 판정과 설명이 어긋난 것이다
  throw new Error('계획서 반영이 차단됐지만 차단 사유를 찾지 못했습니다.');
}

function locationOf(map: Record<number, string>, sheetRow: number): string {
  const location = map[sheetRow];
  // 위치 없는 행은 buildPlanRows와 미리보기가 다른 행을 본다는 뜻이다 — 엉뚱한 행 번호를 대지 않는다
  if (location === undefined) throw new Error(`계획서 행 위치를 찾지 못했습니다: ${sheetRow}행`);
  return location;
}

// ─── §9 previewPlanTables ─────────────────────────────────────────────────────

/**
 * 찾은 표 요약 + §6.17 미리보기(추가·변경·유지·충돌·오류, 경고, 달성률 전후) + 반영 제외 행(HX-6).
 * **저장하는 것은 없다.** 리포지토리 호출은 전부 읽기다.
 */
export async function previewPlanTables(
  projectId: string,
  payload: PlanDocumentPayload
): Promise<ActionResult<PlanPreviewResult>> {
  try {
    const pid = parseOrThrow(uuidSchema, projectId, '과제 ID 형식이 올바르지 않습니다.');
    const input = parsePayload(payload);
    const { client } = await requireApprovedUser();

    const { tablesHash, tables, plan, preview } = await runPlanPipeline(client, pid, input, null);

    return {
      ok: true,
      data: {
        tablesHash,
        fileName: input.fileName,
        preview,
        excluded: plan.excluded,
        tableSummary: summarizeTables(tables),
        planIssues: [...tables.issues, ...plan.issues],
        locations: plan.locations,
        labels: { years: plan.meta.years, orgs: plan.meta.orgs },
        blockingReason: preview.blocked ? firstPlanBlockingReason(preview, plan.locations) : null,
        rates: preview.rates,
      },
    };
  } catch (e) {
    return toPlanDocumentFailure(e);
  }
}

// ─── §9 commitPlanTables ──────────────────────────────────────────────────────

/**
 * 계획서 반영(HX-8): id 기반 추가·변경 + 스냅샷(`kind: 'goal_form'`, sheetName '계획서(hwpx)', U-11)이
 * `commit_goal_form` RPC **한 트랜잭션**이다. 삭제는 없다.
 *
 * 막는 것: 미리보기와 다른 격자(tablesHash), `blocked`(S-21), 반영할 행 0건. 경고는 통과한다.
 * 미리보기 뒤 바뀐 목표는 막지 않고 덮어쓴다(U-10) — version 기준이 commit 시점 DB이기 때문이다.
 */
export async function commitPlanTables(
  projectId: string,
  payload: PlanDocumentPayload,
  tablesHash: string
): Promise<ActionResult<PlanCommitOutcome>> {
  try {
    const pid = parseOrThrow(uuidSchema, projectId, '과제 ID 형식이 올바르지 않습니다.');
    const input = parsePayload(payload);
    const expectedHash = parseOrThrow(tablesHashSchema, tablesHash, '미리보기를 먼저 실행해야 반영할 수 있습니다.');
    const { client } = await requireApprovedUser();

    // previewPlanTables와 같은 경로 (IN-6) — 단, commit 시점 DB 기준(U-10)
    const result = await runPlanPipeline(client, pid, input, expectedHash);
    const { preview, plan } = result;
    if (preview.blocked) {
      throw new RuleViolationError(`반영할 수 없습니다 — ${firstPlanBlockingReason(preview, plan.locations)}`);
    }

    const { payload: commitPayload, expected } = buildGoalFormCommit(preview);
    const total = [
      commitPayload.deliverables,
      commitPayload.achievements,
      commitPayload.techTargets,
      commitPayload.records,
    ].reduce((sum, block) => sum + block.adds.length + block.updates.length + block.deleteIds.length, 0);
    if (total === 0) {
      // RPC는 빈 반영을 거부한다 — 그 전에 왜 비었는지를 사용자 말로 알린다(actions/goal-form.ts와 같은 문구)
      const reasons = [
        `변경 없음 ${preview.counts.unchanged}행`,
        plan.excluded.length > 0 ? `반영 제외 ${plan.excluded.length}행` : null,
        preview.conflicts.length > 0 ? `충돌 ${preview.conflicts.length}건` : null,
      ].filter((reason): reason is string => reason !== null);
      throw new RuleViolationError(`반영할 목표 행이 없습니다 (${reasons.join(' · ')}).`);
    }

    const committed = await snapshotsRepo.commitGoalForm(client, pid, commitPayload, expected, {
      fileName: input.fileName,
      sheetName: PLAN_DOCUMENT_SHEET_NAME,
      fileHash: result.tablesHash,
    });

    revalidatePlanDocument(pid);
    return { ok: true, data: { ...committed, previewConflicts: preview.conflicts } };
  } catch (e) {
    return toPlanDocumentFailure(e);
  }
}

/**
 * 순수 계층은 `Error`(또는 RangeError)를 던진다. 그대로 두면 toActionFailure가
 * "요청 처리 중 오류가 발생했습니다"로 덮어 **무엇이 왜 안 됐는지**가 사라진다 — actions/goal-form.ts와 같은 태도다.
 * 'use server' 파일은 동기 헬퍼를 export할 수 없어 저쪽 것을 가져다 쓰지 못한다.
 */
function toPlanDocumentFailure(e: unknown): ActionResult<never> {
  if (e instanceof Error && (e.constructor === Error || e instanceof RangeError)) {
    console.error('[actions/plan-document] 계획서 처리 실패:', e);
    return { ok: false, error: e.message, code: 'RULE' };
  }
  return toActionFailure(e);
}
