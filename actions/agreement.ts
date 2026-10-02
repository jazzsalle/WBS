'use server';

// 협약 예산(수행 모드) 서버 액션 + 조회 (SOT §5.21~§5.24 AV-1~AV-8, §6.19 AG-1·AG-2·AG-7, §9 Agreement Budget
// SA-1~SA-4, §8.4 O-1·O-2, 계획서 docs/plans/phase-24-plan.md S-2·S-4·S-5·S-6·S-10·S-12·S-15·S-16).
// 반환은 ActionResult<T> — 예외를 그대로 던지지 않는다. supabase 직접 호출 금지, lib/db/ 리포지토리만 쓴다 (§8.6).
//
// 규칙 위반(작성 중 1개·확정 잠금·확정 취소 조건·과제 경계)은 **여기서 먼저** 사람이 읽을 문장으로 거부한다.
// DB의 부분 유일 인덱스·가드 트리거는 그사이 경합을 막는 최후 방어선이다(S-14) — 정상 경로에서 사용자가
// 트리거 문구를 보게 두지 않는다.
//
// 판정·합계·증감은 전부 lib/agreement/ 순수 함수가 한다. 여기는 읽어서 넘기고, 결과를 실어 보낼 뿐이다 —
// 파생 값(현재·기준 버전, 합계, RL-23)은 저장하지 않는다(AG-1).

import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import type { SupabaseClient } from '@supabase/supabase-js';
import type {
  ActionResult,
  AgreementLine,
  AgreementVersion,
  BudgetCategory,
  DetailAxis,
  Member,
  Settings,
  Year,
} from '@/types';
import { requireApprovedUser } from '@/lib/auth/guard';
import * as agreementsRepo from '@/lib/db/agreements';
import * as appUsers from '@/lib/db/app-users';
import * as budgetDetailsRepo from '@/lib/db/budget-details';
import * as budgetItemsRepo from '@/lib/db/budget-items';
import * as membersRepo from '@/lib/db/members';
import * as projectsRepo from '@/lib/db/projects';
import * as settingsRepo from '@/lib/db/settings';
import * as yearsRepo from '@/lib/db/years';
import {
  RepositoryError,
  RuleViolationError,
  StaleDataError,
  ValidationError,
  toActionFailure,
} from '@/lib/db/errors';
import {
  agreementNoticeTypeSchema,
  agreementVersionKindSchema,
  budgetCategorySchema,
  detailAxisSchema,
} from '@/lib/db/schema';
import { agreementSubcategoryLabel } from '@/lib/constants';
import { todayISO } from '@/lib/dates';
import {
  baseVersionIds,
  canUnconfirm,
  currentVersionId,
  draftVersionId,
  suggestNextVersionMeta,
  type NextVersionMeta,
} from '@/lib/agreement/versions';
import {
  buildCategoryView,
  categoryViewTable,
  type CategoryViewModel,
} from '@/lib/agreement/category-view';
import { resolveCellEdit } from '@/lib/agreement/cell-edit';
import {
  buildBaselineFromPlan,
  type BaselineFromPlanResult,
  type BaselineIssue,
  type BaselineSummary,
} from '@/lib/agreement/from-plan';
import {
  diffAgreementLines,
  diffAgreementParticipants,
  type LineDiff,
  type ParticipantDiff,
} from '@/lib/agreement/diff';
import {
  checkSubcategoryPreservation,
  type PreservationResult,
} from '@/lib/agreement/preservation';
import {
  buildLineChangesTable,
  buildParticipantChangesTable,
  buildPreservationTable,
} from '@/lib/agreement/changes-table';
import type { TableModel } from '@/lib/agreement/table';

// ─── 조회 모델 (S-2, §10) ──────────────────────────────────────────────────────

/** 버전 하나와 그 버전의 파생 값. 화면은 표시만 한다 */
export interface AgreementVersionView {
  version: AgreementVersion;
  /** AG-2 비목별 매트릭스. 줄이 없는 칸은 null(금액 0과 구별) */
  categoryView: CategoryViewModel;
  /** 같은 매트릭스의 표 모델 — [복사](TSV)의 원본. 엑셀(AG-8)과 같은 모델이다 */
  categoryTable: TableModel;
  /** AV-5 기준 버전. null = 기준 버전 없음 */
  baseVersionId: string | null;
  /** RL-23 — 이 버전 대 base(이 버전). `no-base`는 경고 0건과 다른 값이다 */
  preservation: PreservationResult;
  /** AV-8 [확정 취소] 가능 여부 */
  canUnconfirm: boolean;
  lineCount: number;
}

export interface AgreementData {
  projectId: string;
  /** 인쇄 머리말(S-17) */
  projectName: string;
  todayISO: string;
  /** 연차 order 순 — 매트릭스 열 순서와 같다 */
  years: Year[];
  /** order 오름차순(쌓인 순서). 지운 순번은 빈자리로 남는다(AV-4) */
  versions: AgreementVersionView[];
  /** AV-3. 확정 0개면 작성 중 버전, 버전 0개면 null */
  currentVersionId: string | null;
  /** AV-2 과제당 하나. 없으면 null */
  draftVersionId: string | null;
  /** 새 버전·빈 버전·보내기 대화의 종류·이름 초깃값(S-22) */
  nextVersionMeta: NextVersionMeta;
  /** 화면 표시 단위. 표 모델(TSV·엑셀)은 원 단위 그대로다(AG-8) */
  currencyUnit: Settings['currencyUnit'];
}

/** 생성 3경로 공통 결과 — 새 버전은 항상 작성 중이다(AV-1) */
export interface AgreementVersionCreated {
  versionId: string;
  order: number;
  lineCount: number;
  participantCount: number;
  itemCount: number;
}

/** 보내기 결과 — 미분리 셀(현금으로 보낸 계획액) 건수·합계를 결과에 명시한다(Q2) */
export interface AgreementBaselineCreated extends AgreementVersionCreated {
  summary: BaselineSummary;
}

/**
 * [협약 기준선으로 보내기] 확인 대화용 미리보기(S-17) — 실제 보내기와 같은 조회·계산 경로다.
 * `draftVersionName`이 있으면 보내기가 RULE로 거부된다(AV-2) — 대화가 미리 비활성 이유를 보인다.
 * `hasVersions`면 "직전 버전을 복제하지 않고 제안 편성으로 새로 만듭니다"(Q4)를 함께 적는다.
 */
export type AgreementBaselinePreview = { draftVersionName: string | null; hasVersions: boolean } & (
  | { ok: true; summary: BaselineSummary }
  | { ok: false; issues: BaselineIssue[] }
);

export interface AgreementClonedVersion extends AgreementVersionCreated {
  /** 복제 원본 = 과제의 마지막 버전(AV-1) */
  sourceVersionId: string;
}

export interface AgreementCellEditResult {
  /** 'update' = 기존 줄 갱신, 'insert' = default 줄 신설 (AG-2) */
  kind: 'update' | 'insert';
  line: AgreementLine;
}

export interface AgreementChangesData {
  projectId: string;
  from: AgreementVersion;
  to: AgreementVersion;
  years: Year[];
  /** 참여인원 증감 표의 인력 이름 원본 */
  members: Pick<Member, 'id' | 'name'>[];
  lineDiff: LineDiff;
  participantDiff: ParticipantDiff;
  /** base(B) — 비교 기준 A와 별개(S-12). null = 기준 버전 없음 */
  baseVersionId: string | null;
  /** RL-23: B 대 base(B) */
  preservation: PreservationResult;
  tables: { lines: TableModel; participants: TableModel; preservation: TableModel };
}

// ─── 입력 검증 ─────────────────────────────────────────────────────────────────

const uuidSchema = z.uuid();

const isoDateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "날짜는 'YYYY-MM-DD' 형식이어야 합니다.");

const versionNameSchema = z
  .string()
  .trim()
  .min(1, '버전 이름을 입력하세요.')
  .max(100, '버전 이름은 100자 이내여야 합니다.');

const versionCreateSchema = z.object({
  kind: agreementVersionKindSchema,
  name: versionNameSchema,
});

// S-3·Q3 메타 7개. status·confirmedAt·order는 여기서 바꾸지 않는다 — z.object가 모르는 키를 잘라낸다
const metaPatchSchema = z
  .object({
    kind: agreementVersionKindSchema,
    name: versionNameSchema,
    baseDate: isoDateSchema.nullable(),
    changeReason: z.string().max(2_000, '변경 사유는 2000자 이내여야 합니다.'),
    noticeType: agreementNoticeTypeSchema.nullable(),
    irisRequestedAt: isoDateSchema.nullable(),
    note: z.string().max(10_000, '비고는 10000자 이내여야 합니다.'),
  })
  .partial();

const expectedVersionSchema = z.int('버전 번호가 올바르지 않습니다.').min(0, '버전 번호가 올바르지 않습니다.');

// 절대 규칙 4 — 원 단위 정수, 0 이상. 안전 정수 범위 밖은 bigint 왕복에서 값이 바뀐다
const wonAmountSchema = z
  .int('금액은 원 단위 정수로 입력하세요.')
  .min(0, '금액은 0 이상이어야 합니다.')
  .max(Number.MAX_SAFE_INTEGER, '금액이 너무 큽니다.');

// §5.22: 세목은 그 비목의 부록 A.5 코드 또는 'default'. DB는 세목 목록을 모른다 — 여기가 유일한 검사다
const lineSeedSchema = z
  .object({
    yearId: z.uuid(),
    category: budgetCategorySchema,
    subcategoryCode: z.string(),
    axis: detailAxisSchema,
    amount: wonAmountSchema,
  })
  .superRefine((line, ctx) => {
    if (agreementSubcategoryLabel(line.category, line.subcategoryCode) === null) {
      ctx.addIssue({ code: 'custom', message: '이 비목에 없는 세목입니다.' });
    }
  });

function parseOrThrow<T>(schema: z.ZodType<T>, value: unknown, fallback: string): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    throw new ValidationError(parsed.error.issues[0]?.message ?? fallback);
  }
  return parsed.data;
}

// ─── 공통 ─────────────────────────────────────────────────────────────────────

// O-3: 낙관적 잠금 실패는 "누가 먼저 고쳤는지"까지 알린다 (actions/budget-plan.ts와 같은 방식)
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
      console.error('[actions/agreement] 수정자 이름 조회 실패:', lookupError);
    }
  }
  if (!(e instanceof RepositoryError)) console.error('[actions/agreement] 처리 실패:', e);
  return toActionFailure(e);
}

function revalidateAgreement(projectId: string): void {
  revalidatePath(`/projects/${projectId}/budget`);
}

/**
 * lib/agreement/ 순수 함수는 손상된 입력(같은 칸 줄 2개, 과제 밖 연차 등)에 던진다. 그대로 두면 SA-4 일반
 * 메시지로 감춰져 사용자는 "무언가 실패했다"만 본다 — 데이터 손상은 손상이라고 알린다(절대 규칙 5).
 * 순수 함수 메시지에는 테이블·제약 이름이 없다.
 */
function computeOrCorrupt<T>(compute: () => T): T {
  try {
    return compute();
  } catch (e) {
    if (e instanceof RepositoryError) throw e;
    console.error('[actions/agreement] 협약 예산 계산 실패:', e);
    const detail = e instanceof Error ? e.message : String(e);
    throw new ValidationError(`협약 예산 데이터가 손상되었습니다 — ${detail}`);
  }
}

const CONFIRMED_LOCK_MESSAGE =
  '확정된 협약 예산 버전의 내용은 고칠 수 없습니다 — 확정을 취소하거나 새 버전을 만드세요';

function draftExistsMessage(name: string): string {
  return `작성 중 버전 "${name}"이 있습니다 — 확정하거나 삭제한 뒤 만드세요`;
}

/** AV-2 작성 중 1개 — 생성 3경로가 RPC 전에 먼저 거부한다 */
function assertNoDraft(versions: readonly AgreementVersion[]): void {
  const draft = versions.find((v) => v.status === 'draft');
  if (draft) throw new RuleViolationError(draftExistsMessage(draft.name));
}

/** O-1: 화면이 본 버전과 지금 버전이 다르면 규칙 판정보다 먼저 STALE — 판정 근거가 낡았다 */
function assertExpectedVersion(version: AgreementVersion, expectedVersion: number): void {
  if (version.version !== expectedVersion) throw new StaleDataError(version.updatedBy);
}

function sortYears(years: readonly Year[]): Year[] {
  return [...years].sort((a, b) => a.order - b.order);
}

function categoryTableTitle(version: AgreementVersion): string {
  return `${version.name} — 비목별`;
}

// ─── 조회 ─────────────────────────────────────────────────────────────────────

/**
 * 수행 모드 한 벌(S-2). 버전마다 비목별 매트릭스·표 모델·기준 버전·RL-23을 계산해 내린다.
 * 하나라도 실패하면 실패를 그대로 올린다 — 버전·줄을 빈 배열로 눙치면 "버전 없음" 안내나 0 매트릭스가
 * 사실처럼 보인다(절대 규칙 5).
 */
export async function getAgreementData(projectId: string): Promise<ActionResult<AgreementData>> {
  try {
    const pid = parseOrThrow(uuidSchema, projectId, '과제 ID 형식이 올바르지 않습니다.');
    const { client } = await requireApprovedUser();

    const [project, years, versions, settings] = await Promise.all([
      projectsRepo.getProjectById(client, pid),
      yearsRepo.listYears(client, pid),
      agreementsRepo.listVersionsByProject(client, pid),
      settingsRepo.getSettings(client),
    ]);
    const lines = await agreementsRepo.listLinesByVersionIds(
      client,
      versions.map((v) => v.id)
    );

    const data = computeOrCorrupt((): AgreementData => {
      const linesByVersion = new Map<string, AgreementLine[]>(versions.map((v) => [v.id, []]));
      for (const line of lines) linesByVersion.get(line.versionId)!.push(line);
      const bases = baseVersionIds(versions);

      const views = versions.map((version): AgreementVersionView => {
        const own = linesByVersion.get(version.id)!;
        const categoryView = buildCategoryView(own, years);
        const baseId = bases[version.id] ?? null;
        return {
          version,
          categoryView,
          categoryTable: categoryViewTable(categoryView, categoryTableTitle(version)),
          baseVersionId: baseId,
          preservation: checkSubcategoryPreservation(
            own,
            baseId === null ? null : { versionId: baseId, lines: linesByVersion.get(baseId)! }
          ),
          canUnconfirm: canUnconfirm(versions, version.id),
          lineCount: own.length,
        };
      });

      return {
        projectId: pid,
        projectName: project.name,
        todayISO: todayISO(new Date()), // §6.5 기준일 — Asia/Seoul 달력
        years: sortYears(years),
        versions: views,
        currentVersionId: currentVersionId(versions),
        draftVersionId: draftVersionId(versions),
        nextVersionMeta: suggestNextVersionMeta(versions),
        currencyUnit: settings.currencyUnit,
      };
    });

    return { ok: true, data };
  } catch (e) {
    return toFailure(e);
  }
}

/**
 * AG-7 두 버전 증감 + B의 RL-23(S-12). A·B는 둘 다 이 과제의 버전이어야 한다. 같은 버전끼리면 전부 불변.
 * 세목 총액 보존은 A가 아니라 base(B)와 비교한다.
 */
export async function getAgreementChanges(
  projectId: string,
  fromVersionId: string,
  toVersionId: string
): Promise<ActionResult<AgreementChangesData>> {
  try {
    const pid = parseOrThrow(uuidSchema, projectId, '과제 ID 형식이 올바르지 않습니다.');
    const fromId = parseOrThrow(uuidSchema, fromVersionId, '버전 ID 형식이 올바르지 않습니다.');
    const toId = parseOrThrow(uuidSchema, toVersionId, '버전 ID 형식이 올바르지 않습니다.');
    const { client } = await requireApprovedUser();

    const [years, versions, members] = await Promise.all([
      yearsRepo.listYears(client, pid),
      agreementsRepo.listVersionsByProject(client, pid),
      membersRepo.listMembers(client, pid),
    ]);
    const from = versions.find((v) => v.id === fromId);
    const to = versions.find((v) => v.id === toId);
    if (!from || !to) {
      throw new RuleViolationError('이 과제에 속하지 않은 협약 예산 버전은 비교할 수 없습니다.');
    }

    const baseId = computeOrCorrupt(() => baseVersionIds(versions)[toId] ?? null);
    const ids = [...new Set([fromId, toId, ...(baseId === null ? [] : [baseId])])];
    const [lines, participants] = await Promise.all([
      agreementsRepo.listLinesByVersionIds(client, ids),
      agreementsRepo.listParticipantsByVersionIds(client, [...new Set([fromId, toId])]),
    ]);

    const data = computeOrCorrupt((): AgreementChangesData => {
      const linesOf = (id: string) => lines.filter((l) => l.versionId === id);
      const participantsOf = (id: string) => participants.filter((p) => p.versionId === id);
      const base = baseId === null ? null : versions.find((v) => v.id === baseId)!;

      const lineDiff = diffAgreementLines(linesOf(fromId), linesOf(toId), years);
      const participantDiff = diffAgreementParticipants(participantsOf(fromId), participantsOf(toId), years);
      const preservation = checkSubcategoryPreservation(
        linesOf(toId),
        base === null ? null : { versionId: base.id, lines: linesOf(base.id) }
      );
      const memberNames = members.map((m) => ({ id: m.id, name: m.name }));

      return {
        projectId: pid,
        from,
        to,
        years: sortYears(years),
        members: memberNames,
        lineDiff,
        participantDiff,
        baseVersionId: baseId,
        preservation,
        tables: {
          lines: buildLineChangesTable(lineDiff, { years, from, to }),
          participants: buildParticipantChangesTable(participantDiff, { years, members: memberNames, from, to }),
          preservation: buildPreservationTable(preservation, { target: to, base }),
        },
      };
    });

    return { ok: true, data };
  } catch (e) {
    return toFailure(e);
  }
}

// ─── 생성 3경로 (AV-1·AV-2·AV-6) ───────────────────────────────────────────────

/**
 * 미리보기와 실제 보내기가 공유하는 조회·계산(AV-6). 두 경로가 따로 읽으면 대화에 보인 건수와 만든 버전이
 * 어긋날 수 있다 — 같은 함수가 같은 순서로 읽고 같은 순수 함수에 넘긴다.
 */
async function loadBaseline(
  client: SupabaseClient,
  projectId: string
): Promise<{ versions: AgreementVersion[]; baseline: BaselineFromPlanResult }> {
  const [versions, years, items, details, members] = await Promise.all([
    agreementsRepo.listVersionsByProject(client, projectId),
    yearsRepo.listYears(client, projectId),
    budgetItemsRepo.listBudgetItemsByProject(client, projectId),
    budgetDetailsRepo.listByProject(client, projectId),
    membersRepo.listMembers(client, projectId),
  ]);
  const baseline = computeOrCorrupt(() => buildBaselineFromPlan({ items, details, members, years }));
  return { versions, baseline };
}

/** 보내기 확인 대화의 미리보기 — 쓰기 없음. 거부 사유(issues)도 실패가 아니라 값으로 돌려준다 */
export async function previewAgreementBaseline(
  projectId: string
): Promise<ActionResult<AgreementBaselinePreview>> {
  try {
    const pid = parseOrThrow(uuidSchema, projectId, '과제 ID 형식이 올바르지 않습니다.');
    const { client } = await requireApprovedUser();

    const { versions, baseline } = await loadBaseline(client, pid);
    const meta = {
      draftVersionName: versions.find((v) => v.status === 'draft')?.name ?? null,
      hasVersions: versions.length > 0,
    };
    const data: AgreementBaselinePreview = baseline.ok
      ? { ...meta, ok: true, summary: baseline.summary }
      : { ...meta, ok: false, issues: baseline.issues };
    return { ok: true, data };
  } catch (e) {
    return toFailure(e);
  }
}

/**
 * [협약 기준선으로 보내기](AV-6). 제안 편성(budget_items·budget_details·인력 연봉)을 지금 읽어 기준선을 만들고
 * 단일 트랜잭션 RPC로 작성 중 버전을 만든다. 버전이 이미 있어도 작성 중 버전이 없으면 허용한다(Q4).
 * 금액을 잃을 셀(축 반쪽 불일치·음수 그룹)이 하나라도 있으면 위치를 모두 적어 RULE — 버전을 반쯤 만들지 않는다.
 */
export async function createAgreementVersionFromPlan(
  projectId: string,
  input: unknown
): Promise<ActionResult<AgreementBaselineCreated>> {
  try {
    const pid = parseOrThrow(uuidSchema, projectId, '과제 ID 형식이 올바르지 않습니다.');
    const { kind, name } = parseOrThrow(versionCreateSchema, input, '버전 종류·이름이 올바르지 않습니다.');
    const { client } = await requireApprovedUser();

    const { versions, baseline } = await loadBaseline(client, pid);
    assertNoDraft(versions);
    if (!baseline.ok) {
      throw new RuleViolationError(
        [
          '협약 기준선으로 보낼 수 없습니다 — 제안 모드에서 아래를 고친 뒤 다시 보내세요.',
          ...baseline.issues.map((i) => `· ${i.message}`),
        ].join('\n')
      );
    }
    // §5.22 세목 검사는 액션 Zod가 유일한 관문이다 — 순수 함수 결과도 같은 문을 지난다
    const lines = parseOrThrow(z.array(lineSeedSchema), baseline.lines, '보낼 금액 줄이 올바르지 않습니다.');

    const created = await agreementsRepo.createVersion(client, pid, {
      kind,
      name,
      lines,
      participants: baseline.participants,
    });
    revalidateAgreement(pid);
    return {
      ok: true,
      data: {
        versionId: created.versionId,
        order: created.order,
        lineCount: created.lines,
        participantCount: created.participants,
        itemCount: 0,
        summary: baseline.summary,
      },
    };
  } catch (e) {
    return toFailure(e);
  }
}

/** [빈 버전] — 줄·참여인원 없이 작성 중 버전을 만든다. 버전이 있어도 작성 중 버전이 없으면 허용(AV-1) */
export async function createEmptyAgreementVersion(
  projectId: string,
  input: unknown
): Promise<ActionResult<AgreementVersionCreated>> {
  try {
    const pid = parseOrThrow(uuidSchema, projectId, '과제 ID 형식이 올바르지 않습니다.');
    const { kind, name } = parseOrThrow(versionCreateSchema, input, '버전 종류·이름이 올바르지 않습니다.');
    const { client } = await requireApprovedUser();

    assertNoDraft(await agreementsRepo.listVersionsByProject(client, pid));
    const created = await agreementsRepo.createVersion(client, pid, { kind, name, lines: [], participants: [] });
    revalidateAgreement(pid);
    return {
      ok: true,
      data: {
        versionId: created.versionId,
        order: created.order,
        lineCount: created.lines,
        participantCount: created.participants,
        itemCount: 0,
      },
    };
  } catch (e) {
    return toFailure(e);
  }
}

/** [새 버전](AV-1) — 과제의 마지막 버전(order 최대)을 통째로 복제한다. 원본은 바뀌지 않는다 */
export async function cloneLatestAgreementVersion(
  projectId: string,
  input: unknown
): Promise<ActionResult<AgreementClonedVersion>> {
  try {
    const pid = parseOrThrow(uuidSchema, projectId, '과제 ID 형식이 올바르지 않습니다.');
    const { kind, name } = parseOrThrow(versionCreateSchema, input, '버전 종류·이름이 올바르지 않습니다.');
    const { client } = await requireApprovedUser();

    const versions = await agreementsRepo.listVersionsByProject(client, pid);
    assertNoDraft(versions);
    const latest = versions.reduce<AgreementVersion | null>(
      (best, v) => (best === null || v.order > best.order ? v : best),
      null
    );
    if (latest === null) {
      throw new RuleViolationError(
        '복제할 협약 예산 버전이 없습니다 — 제안 모드에서 [협약 기준선으로 보내기]로 만들거나 [빈 버전]으로 시작하세요'
      );
    }

    const created = await agreementsRepo.cloneVersion(client, latest.id, { kind, name });
    revalidateAgreement(pid);
    return {
      ok: true,
      data: {
        versionId: created.versionId,
        order: created.order,
        lineCount: created.lines,
        participantCount: created.participants,
        itemCount: created.items,
        sourceVersionId: latest.id,
      },
    };
  } catch (e) {
    return toFailure(e);
  }
}

// ─── 버전 쓰기 (메타·확정·확정 취소·삭제) ─────────────────────────────────────

/** 메타 7개 편집(S-3·Q3). 확정 버전도 허용한다 — 잠금은 내용에만 걸린다(AV-2). O-1 expectedVersion 필수 */
export async function updateAgreementVersionMeta(
  versionId: string,
  patch: unknown,
  expectedVersion: number
): Promise<ActionResult<AgreementVersion>> {
  let client: SupabaseClient | undefined;
  try {
    const id = parseOrThrow(uuidSchema, versionId, '버전 ID 형식이 올바르지 않습니다.');
    const meta = parseOrThrow(metaPatchSchema, patch, '버전 정보가 올바르지 않습니다.');
    const expected = parseOrThrow(expectedVersionSchema, expectedVersion, '버전 번호가 올바르지 않습니다.');
    const ctx = await requireApprovedUser();
    client = ctx.client;

    const current = await agreementsRepo.getVersionById(client, id);
    assertExpectedVersion(current, expected);
    const updated = await agreementsRepo.updateVersionMeta(
      client,
      id,
      { ...meta, updatedBy: ctx.user.id },
      expected
    );
    revalidateAgreement(updated.projectId);
    return { ok: true, data: updated };
  } catch (e) {
    return toFailure(e, client);
  }
}

/** AV-2 확정 = 내용 잠금. 이미 확정이면 RULE */
export async function confirmAgreementVersion(
  versionId: string,
  expectedVersion: number
): Promise<ActionResult<AgreementVersion>> {
  let client: SupabaseClient | undefined;
  try {
    const id = parseOrThrow(uuidSchema, versionId, '버전 ID 형식이 올바르지 않습니다.');
    const expected = parseOrThrow(expectedVersionSchema, expectedVersion, '버전 번호가 올바르지 않습니다.');
    const ctx = await requireApprovedUser();
    client = ctx.client;

    const current = await agreementsRepo.getVersionById(client, id);
    assertExpectedVersion(current, expected);
    if (current.status === 'confirmed') throw new RuleViolationError('이미 확정된 버전입니다.');

    const updated = await agreementsRepo.confirmVersion(client, id, expected, ctx.user.id);
    revalidateAgreement(updated.projectId);
    return { ok: true, data: updated };
  } catch (e) {
    return toFailure(e, client);
  }
}

/** AV-8 확정 취소 — 그 버전이 과제의 마지막 버전(order 최대)이고 확정일 때만 */
export async function unconfirmAgreementVersion(
  versionId: string,
  expectedVersion: number
): Promise<ActionResult<AgreementVersion>> {
  let client: SupabaseClient | undefined;
  try {
    const id = parseOrThrow(uuidSchema, versionId, '버전 ID 형식이 올바르지 않습니다.');
    const expected = parseOrThrow(expectedVersionSchema, expectedVersion, '버전 번호가 올바르지 않습니다.');
    const ctx = await requireApprovedUser();
    client = ctx.client;

    const current = await agreementsRepo.getVersionById(client, id);
    assertExpectedVersion(current, expected);
    if (current.status === 'draft') throw new RuleViolationError('작성 중인 버전은 확정 취소할 대상이 아닙니다.');
    const versions = await agreementsRepo.listVersionsByProject(client, current.projectId);
    if (!computeOrCorrupt(() => canUnconfirm(versions, id))) {
      throw new RuleViolationError('확정 취소는 과제의 마지막 버전만 할 수 있습니다 — 뒤에 쌓인 버전이 있습니다');
    }

    const updated = await agreementsRepo.unconfirmVersion(client, id, expected, ctx.user.id);
    revalidateAgreement(updated.projectId);
    return { ok: true, data: updated };
  } catch (e) {
    return toFailure(e, client);
  }
}

/** AV-4 버전 하나 삭제 — 확정 여부와 무관. 하위 3종 cascade, 남은 순번은 그대로 */
export async function deleteAgreementVersion(versionId: string): Promise<ActionResult<null>> {
  try {
    const id = parseOrThrow(uuidSchema, versionId, '버전 ID 형식이 올바르지 않습니다.');
    const { client } = await requireApprovedUser();

    const current = await agreementsRepo.getVersionById(client, id);
    await agreementsRepo.removeVersion(client, id);
    revalidateAgreement(current.projectId);
    return { ok: true, data: null };
  } catch (e) {
    return toFailure(e);
  }
}

/** AV-4 전체 버전 삭제 — 그 과제의 버전만. 지운 버전 수를 돌려준다 */
export async function deleteAllAgreementVersions(
  projectId: string
): Promise<ActionResult<{ deleted: number }>> {
  try {
    const pid = parseOrThrow(uuidSchema, projectId, '과제 ID 형식이 올바르지 않습니다.');
    const { client } = await requireApprovedUser();

    const result = await agreementsRepo.removeAllVersions(client, pid);
    revalidateAgreement(pid);
    return { ok: true, data: result };
  } catch (e) {
    return toFailure(e);
  }
}

// ─── 셀 편집 (AG-2) ───────────────────────────────────────────────────────────

/**
 * 비목별 보기 셀 (연차, 비목, 축)의 총액을 `amount`로. 어느 줄을 고칠지는 resolveCellEdit가 정한다
 * (줄 1개 → 그 줄, 0개·2개 이상 → default 줄이 차액 흡수). O-2: 클라이언트는 version을 보내지 않고,
 * 여기서 방금 읽은 줄의 version으로 갱신해 그사이 경합만 STALE로 알린다(S-16).
 */
export async function setAgreementCellAmount(
  versionId: string,
  yearId: string,
  category: BudgetCategory,
  axis: DetailAxis,
  amount: number
): Promise<ActionResult<AgreementCellEditResult>> {
  let client: SupabaseClient | undefined;
  try {
    const vid = parseOrThrow(uuidSchema, versionId, '버전 ID 형식이 올바르지 않습니다.');
    const yid = parseOrThrow(uuidSchema, yearId, '연차 ID 형식이 올바르지 않습니다.');
    const cat = parseOrThrow(budgetCategorySchema, category, '비목이 올바르지 않습니다.');
    const ax = parseOrThrow(detailAxisSchema, axis, '현금·현물 구분이 올바르지 않습니다.');
    const target = parseOrThrow(wonAmountSchema, amount, '금액이 올바르지 않습니다.');
    const ctx = await requireApprovedUser();
    client = ctx.client;

    const [version, year] = await Promise.all([
      agreementsRepo.getVersionById(client, vid),
      yearsRepo.getYearById(client, yid),
    ]);
    if (version.status === 'confirmed') throw new RuleViolationError(CONFIRMED_LOCK_MESSAGE);
    if (year.projectId !== version.projectId) {
      throw new RuleViolationError('이 과제에 속하지 않은 연차입니다.');
    }

    const lines = await agreementsRepo.listLinesByVersionIds(client, [vid]);
    const resolution = computeOrCorrupt(() =>
      resolveCellEdit(lines, { yearId: yid, category: cat, axis: ax }, target)
    );

    let result: AgreementCellEditResult;
    switch (resolution.kind) {
      case 'reject':
        if (resolution.reason === 'invalid_amount') throw new ValidationError(resolution.message);
        throw new RuleViolationError(resolution.message);
      case 'update': {
        const read = lines.find((l) => l.id === resolution.lineId);
        if (!read) throw new ValidationError('고칠 금액 줄을 찾지 못했습니다.');
        const line = await agreementsRepo.updateLineAmount(
          client,
          read.id,
          resolution.amount,
          read.version,
          ctx.user.id
        );
        result = { kind: 'update', line };
        break;
      }
      case 'insert': {
        const seed = parseOrThrow(lineSeedSchema, resolution.line, '새 금액 줄이 올바르지 않습니다.');
        const line = await agreementsRepo.insertLine(client, {
          versionId: vid,
          ...seed,
          createdBy: ctx.user.id,
          updatedBy: ctx.user.id,
        });
        result = { kind: 'insert', line };
        break;
      }
    }

    revalidateAgreement(version.projectId);
    return { ok: true, data: result };
  } catch (e) {
    return toFailure(e, client);
  }
}
