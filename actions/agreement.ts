'use server';

// 협약 예산(수행 모드) 서버 액션 + 조회 (SOT §5.21~§5.25 AV-1~AV-8, §6.19 AG-1~AG-5·AG-7, §9 Agreement Budget
// SA-1~SA-4, §8.4 O-1·O-2, 계획서 docs/plans/phase-24-plan.md S-2·S-4·S-5·S-6·S-10·S-12·S-15·S-16,
// docs/plans/phase-25-plan.md S-4·S-6~S-8·S-12, docs/plans/phase-26-plan.md S-7~S-9·S-12·S-14·S-15·S-20).
// 반환은 ActionResult<T> — 예외를 그대로 던지지 않는다. supabase 직접 호출 금지, lib/db/ 리포지토리만 쓴다 (§8.6).
//
// 규칙 위반(작성 중 1개·확정 잠금·확정 취소 조건·과제 경계)은 **여기서 먼저** 사람이 읽을 문장으로 거부한다.
// DB의 부분 유일 인덱스·가드 트리거는 그사이 경합을 막는 최후 방어선이다(S-14) — 정상 경로에서 사용자가
// 트리거 문구를 보게 두지 않는다.
//
// 판정·합계·증감은 전부 lib/agreement/ 순수 함수가 한다. 여기는 읽어서 넘기고, 결과를 실어 보낼 뿐이다 —
// 파생 값(현재·기준 버전, 합계, RL-23, 규칙 판정)은 저장하지 않는다(AG-1).

import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import type { SupabaseClient } from '@supabase/supabase-js';
import type {
  ActionResult,
  AgreementGovSupport,
  AgreementItem,
  AgreementLine,
  AgreementParticipant,
  AgreementVersion,
  BudgetCategory,
  BudgetRule,
  DetailAxis,
  Member,
  Settings,
  Stage,
  Year,
} from '@/types';
import { requireApprovedUser } from '@/lib/auth/guard';
import * as agreementsRepo from '@/lib/db/agreements';
import * as appUsers from '@/lib/db/app-users';
import * as budgetDetailsRepo from '@/lib/db/budget-details';
import * as budgetItemsRepo from '@/lib/db/budget-items';
import * as budgetRulesRepo from '@/lib/db/budget-rules';
import * as membersRepo from '@/lib/db/members';
import * as projectsRepo from '@/lib/db/projects';
import * as settingsRepo from '@/lib/db/settings';
import * as stagesRepo from '@/lib/db/stages';
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
import {
  AGREEMENT_ITEM_KIND_LABELS,
  AGREEMENT_ITEM_MAX_LENGTH,
  AGREEMENT_ITEM_SUBCATEGORY,
  AGREEMENT_VERSION_STATUS_LABELS,
  PRESERVATION_RULE_OFF_TEXT,
  ATTACHMENT4_FORM_ROWS,
  BUDGET_CATEGORY_LABELS,
  agreementSubcategoryLabel,
} from '@/lib/constants';
import type { RuleEvaluation, RuleInput } from '@/lib/rules';
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
  type BaselineItem,
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
import {
  attachment4Tables,
  buildAttachment4View,
  type Attachment4ViewModel,
} from '@/lib/agreement/attachment4-view';
import {
  adjustmentTable,
  buildAdjustmentView,
  type AdjustmentViewModel,
} from '@/lib/agreement/adjustment-view';
import {
  buildParticipantsView,
  participantsTable,
  type ParticipantsViewModel,
} from '@/lib/agreement/participants';
import { resolveFormCellEdit } from '@/lib/agreement/form-edit';
import {
  evaluateAgreementRules,
  ruleTargetVersionId,
  type AgreementRuleNote,
  type AgreementRuleTotalsSource,
} from '@/lib/agreement/rule-input';
import { buildForm82RuleView, type Form82RuleView } from '@/lib/agreement/rule-view';
import { diffEquipmentApproval, type EquipmentApprovalResult } from '@/lib/agreement/equipment-approval';
import { buildItemsView, itemsTable, type ItemsViewModel } from '@/lib/agreement/items-view';
import type { TableModel } from '@/lib/agreement/table';

// ─── 조회 모델 (S-2, §10) ──────────────────────────────────────────────────────

/**
 * RL-23 세목 총액 보존의 표시 상태(§6.14.8, Phase 26 S-7). 세 상태는 서로 다르다 — 규칙 꺼짐·기준 버전 없음·
 * 경고 0건(`checked` + 0)을 같은 모양으로 보이면 "보지 않았음"이 "문제 없음"으로 읽힌다(절대 규칙 5).
 * RuleFindingsPanel의 `RulePreservationSummary`와 같은 모양이다 — 액션이 컴포넌트를 import하지 않으려고 따로 둔다.
 */
export type AgreementPreservationStatus =
  | { kind: 'off' }
  | { kind: 'no_base' }
  | { kind: 'checked'; baseVersionName: string; warningCount: number };

/**
 * §6.14.8 수행 모드 규칙 판정 — 이 버전을 판정 대상으로 낸 결과. 화면은 보고 있는 버전의 것을 고른다
 * (`ruleTargetVersionId`). 버전이 0개면 고를 결과가 없다 — "판정할 버전 없음"이지 위반 0건이 아니다.
 */
export interface AgreementRuleResult {
  /** 패널 머리 "판정 대상 …" — 버전 이름 · 상태 */
  targetLabel: string;
  /** `evaluateRules` 결과 + 어댑터 skipped(뒤에 붙음) */
  evaluation: RuleEvaluation;
  /** 세목 미지정 금액·참여인원 학생 구분 없음 메모(S-9 머리 안내) */
  notes: AgreementRuleNote[];
  /** RL-8·RL-9 총액 출처 — 표시 문구는 `AGREEMENT_RULE_TOTALS_SOURCE_LABEL` */
  totalsSource: AgreementRuleTotalsSource;
}

/** 버전 하나와 그 버전의 파생 값. 화면은 표시만 한다 */
export interface AgreementVersionView {
  version: AgreementVersion;
  /** AG-2 비목별 매트릭스. 줄이 없는 칸은 null(금액 0과 구별) */
  categoryView: CategoryViewModel;
  /** 같은 매트릭스의 표 모델 — [복사](TSV)의 원본. 엑셀(AG-8)과 같은 모델이다 */
  categoryTable: TableModel;
  /** AV-5 기준 버전. null = 기준 버전 없음 */
  baseVersionId: string | null;
  /**
   * RL-23 — 이 버전 대 base(이 버전). `no-base`는 경고 0건과 다른 값이다. 규칙이 꺼져 있어도 Phase 24 모양을
   * 지키려고 계산은 해 둔다 — **표시는 `preservationStatus`를 따른다**(꺼짐이면 이 값을 보이지 않는다)
   */
  preservation: PreservationResult;
  /** RL-23 표시 상태 — 규칙 행이 있고 꺼짐이면 'off', 아니면 위 `preservation`의 요약(S-7) */
  preservationStatus: AgreementPreservationStatus;
  /** AV-8 [확정 취소] 가능 여부 */
  canUnconfirm: boolean;
  lineCount: number;
  /** AG-3 붙임4형(8-1·8-2) 모델과 그 표 모델(엑셀·[복사] 원본) */
  attachment4: {
    view: Attachment4ViewModel;
    tables: { plan81: TableModel; plan82: TableModel };
  };
  /** AG-4 조정회의형 — 변경전 = 제안 모드 변환(모든 버전 공통), 변경후 = 이 버전 */
  adjustment: { view: AdjustmentViewModel; table: TableModel };
  /**
   * AG-5 참여인원 보기 모델·표 모델과 원본 행. 원본 행은 수정(O-1 expectedVersion = 행의 `version`)·
   * 편집 폼 초깃값용이다 — 보기 행에는 version이 없다
   */
  participants: { view: ParticipantsViewModel; table: TableModel; rows: AgreementParticipant[] };
  /** §5.25 연차별 정부지원 현금 원본 행(연차 order 무관 — 리포지토리 정렬). 행 없음 = 미입력 */
  govSupport: AgreementGovSupport[];
  /** §6.14.8 이 버전을 판정 대상으로 한 규칙 판정 */
  ruleResult: AgreementRuleResult;
  /**
   * AG-6 편성 항목·증빙 보기 모델(경고 배지 = 위 `ruleResult`의 scope `item` finding)·표 모델과 원본 행.
   * 원본 행은 수정·증빙 편집(O-1 expectedVersion = 행의 `version`)용이다
   */
  items: { view: ItemsViewModel; table: TableModel; rows: AgreementItem[] };
  /** AG-3 8-2 아래 RL-4·RL-3 판정 줄 — 위 `ruleResult.evaluation`에서 옮긴 것(S-15) */
  form82Rules: Form82RuleView;
}

/** 참여인원 편집 폼이 고를 인력과 자동 계산(연봉 스냅샷)에 쓰는 값 */
export type AgreementMemberOption = Pick<Member, 'id' | 'name' | 'order' | 'annualSalary'>;

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
  /** 단계 order 순 — 붙임4형 8-2 단계 소계 열(단계 2개 이상)의 원본 */
  stages: Stage[];
  /** 과제 인력 order 순 */
  members: AgreementMemberOption[];
  /**
   * 과제 규칙 행(§6.14) 원본 — 제안 모드(`getBudgetPlanData`)와 같은 행이다. 규칙 패널·[연구비 규칙] 편집 모달이
   * 그대로 받는다. 붙임4형 8-1은 RL-8 `gov_share_max`·RL-9 `own_cash_min`만 판정에 쓴다(G-1)
   */
  rules: BudgetRule[];
  /** §6.14.8 고른 버전이 없을 때의 판정 대상(= 현재 버전, AV-3). 버전 0개면 null — "판정할 버전 없음" */
  ruleTargetVersionId: string | null;
}

/** 생성 3경로 공통 결과 — 새 버전은 항상 작성 중이다(AV-1) */
export interface AgreementVersionCreated {
  versionId: string;
  order: number;
  lineCount: number;
  participantCount: number;
  itemCount: number;
  /** 만든 정부지원 현금 행 수(§5.25) */
  govSupportCount: number;
}

/** 보내기 미리보기의 연차별 정부지원 현금(AV-6 ④). null = 제안 연차 미입력 → 버전에 행을 만들지 않는다 */
export interface AgreementBaselineGovCash {
  yearId: string;
  yearName: string;
  amount: number | null;
}

/** 보내기 편성 항목 건수(AV-6 ③). `unnamedCount` = 품명이 비어 세목 라벨로 채운 건수 */
export interface AgreementBaselineItemSummary {
  count: number;
  unnamedCount: number;
}

/** 보내기 결과 — 미분리 셀(현금으로 보낸 계획액) 건수·합계를 결과에 명시한다(Q2) */
export interface AgreementBaselineCreated extends AgreementVersionCreated {
  summary: BaselineSummary;
  /** 미리보기와 같은 계산 — 만든 건수는 `itemCount`(RPC 결과) */
  itemSummary: AgreementBaselineItemSummary;
}

/**
 * 보내기 거부 사유. 순수 함수(`buildBaselineFromPlan`)의 사유에 액션 검사 하나를 더한다:
 * 편성 항목 품명이 200자(§5.24)를 넘는 산출 행 — 조용히 잘라 보내지 않고 위치를 적어 거부한다.
 */
export type AgreementBaselineIssue =
  | BaselineIssue
  | { code: 'item_name_too_long'; yearId: string; category: BudgetCategory; message: string };

/**
 * [협약 기준선으로 보내기] 확인 대화용 미리보기(S-17) — 실제 보내기와 같은 조회·계산 경로다.
 * `draftVersionName`이 있으면 보내기가 RULE로 거부된다(AV-2) — 대화가 미리 비활성 이유를 보인다.
 * `hasVersions`면 "직전 버전을 복제하지 않고 제안 편성으로 새로 만듭니다"(Q4)를 함께 적는다.
 */
export type AgreementBaselinePreview = { draftVersionName: string | null; hasVersions: boolean } & (
  | { ok: true; summary: BaselineSummary; govCash: AgreementBaselineGovCash[]; itemSummary: AgreementBaselineItemSummary }
  | { ok: false; issues: AgreementBaselineIssue[] }
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

/**
 * 붙임4형 8-2 칸 편집 결과(AG-3). 'noop' = 고칠 줄이 이미 그 금액이라 쓰지 않았다 — 실패가 아니다
 */
export type AgreementFormCellEditResult =
  | { kind: 'update' | 'insert'; line: AgreementLine }
  | { kind: 'noop'; line: null };

/** §5.25 정부지원 현금 편집 결과. 'delete' = 미입력으로 되돌림, 'noop' = 행 없음 + null(변화 없음) */
export type AgreementGovCashEditResult =
  | { kind: 'insert' | 'update'; row: AgreementGovSupport }
  | { kind: 'delete' | 'noop'; row: null };

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
  /**
   * RL-23: B 대 base(B). 규칙이 꺼져 있어도 계산은 해 둔다(Phase 24 모양) — **표시는 `preservationStatus`를 따른다**
   */
  preservation: PreservationResult;
  /** RL-23 표시 상태(S-7). 'off'면 `tables.preservation`도 숫자 없는 "꺼짐" 한 행이다(엑셀과 같은 모양) */
  preservationStatus: AgreementPreservationStatus;
  /** AG-7 ④ A → B 장비 사전 승인(S-20). RL-17 행이 없거나 꺼져 있으면 `not_judged` + 사유. 화면 목록만 */
  equipmentApproval: EquipmentApprovalResult;
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

// 행 id는 부록 C.4 목록 안에서만 받는다. 편집 가능 여부(데이터 행·축)는 resolveFormCellEdit가 RULE로 가른다
const ATTACHMENT4_ROW_IDS = new Set<string>(ATTACHMENT4_FORM_ROWS.map((r) => r.id));
const formCellEditSchema = z.object({
  yearId: z.uuid('연차 ID 형식이 올바르지 않습니다.'),
  rowId: z
    .string()
    .refine((id) => ATTACHMENT4_ROW_IDS.has(id), '붙임4 양식에 없는 행입니다.')
    .transform((id) => id as (typeof ATTACHMENT4_FORM_ROWS)[number]['id']),
  axis: detailAxisSchema.nullable(),
  amount: wonAmountSchema,
});

const govCashMapSchema = z.record(z.uuid(), wonAmountSchema);

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

/** 하위 행을 버전별로 나눈다. 목록에 없는 버전을 가리키는 행은 일괄 조회가 어긋났다는 뜻이다 — 던진다 */
function groupByVersion<T extends { versionId: string }>(
  versions: readonly AgreementVersion[],
  rows: readonly T[]
): Map<string, T[]> {
  const map = new Map<string, T[]>(versions.map((v) => [v.id, []]));
  for (const row of rows) {
    const bucket = map.get(row.versionId);
    if (!bucket) throw new Error(`조회한 버전 목록에 없는 버전의 행이 있습니다 (${row.versionId}).`);
    bucket.push(row);
  }
  return map;
}

function sortYears(years: readonly Year[]): Year[] {
  return [...years].sort((a, b) => a.order - b.order);
}

function categoryTableTitle(version: AgreementVersion): string {
  return `${version.name} — 비목별`;
}

function toRuleInputs(rules: readonly BudgetRule[]): RuleInput[] {
  return rules.map((r) => ({
    code: r.code,
    enabled: r.enabled,
    value: r.value,
    base: r.base,
    severity: r.severity,
    source: r.source,
  }));
}

/** RL-23은 규칙 행이 있고 꺼져 있을 때만 꺼짐이다 — 행이 없으면 켜진 것으로 본다(S-7, Phase 24 동작 유지) */
function isPreservationOff(rules: readonly RuleInput[]): boolean {
  // RL-D1이 (project, code) 유일을 보장한다. 혹시 둘이면 판정기처럼 첫 행
  const rule = rules.find((r) => r.code === 'preserve_subcategory_totals');
  return rule !== undefined && !rule.enabled;
}

function summarizePreservation(
  result: PreservationResult,
  off: boolean,
  versions: readonly AgreementVersion[]
): AgreementPreservationStatus {
  if (off) return { kind: 'off' };
  if (result.status === 'no-base') return { kind: 'no_base' };
  const base = versions.find((v) => v.id === result.baseVersionId);
  if (!base) throw new Error(`기준 버전(${result.baseVersionId})이 버전 목록에 없습니다.`);
  return { kind: 'checked', baseVersionName: base.name, warningCount: result.warnings.length };
}

/**
 * RL-23이 꺼졌을 때 변경 이력의 세목 총액 보존 표 — 엑셀(actions/agreement-export.ts)과 같은 모양이다:
 * 열은 판정한 표와 같고(기준 버전 이름 없이) 칸에는 숫자 없이 상태 문구 한 행. 판정하지 않았으니 숫자를 싣지 않는다
 */
function preservationOffTable(to: AgreementVersion): TableModel {
  const shape = buildPreservationTable({ status: 'no-base' }, { target: to, base: null });
  const text = PRESERVATION_RULE_OFF_TEXT;
  return {
    ...shape,
    title: `세목 총액 보존 — ${to.name} (${text})`,
    rows: [
      {
        kind: 'data',
        cells: shape.columns.map((column, c) =>
          c === 0
            ? { kind: 'text', text }
            : column.type === 'amount'
              ? { kind: 'empty' }
              : { kind: 'text', text: '' }
        ),
      },
    ],
  };
}

/**
 * 편성 항목 품명 길이(§5.24 1~200자). 산출근거 품명에는 길이 제한이 없어 보내기에서 처음 걸린다 —
 * 잘라 보내면 사용자가 모르는 품명이 생기므로(절대 규칙 5) 위치를 적어 거부한다. 미리보기·보내기 공용
 */
function itemNameIssues(items: readonly BaselineItem[], years: readonly Year[]): AgreementBaselineIssue[] {
  const max = AGREEMENT_ITEM_MAX_LENGTH.name;
  const yearName = new Map(years.map((y) => [y.id, y.name]));
  return items
    .filter((item) => item.name.length > max)
    .map((item) => {
      const category = AGREEMENT_ITEM_SUBCATEGORY[item.kind].category;
      return {
        code: 'item_name_too_long' as const,
        yearId: item.yearId,
        category,
        message:
          `${yearName.get(item.yearId) ?? '알 수 없는 연차'} ${BUDGET_CATEGORY_LABELS[category]}: ` +
          `${AGREEMENT_ITEM_KIND_LABELS[item.kind]} 품명 "${item.name.slice(0, 20)}…"이 ${item.name.length}자입니다 — ` +
          `편성 항목 품명은 ${max}자 이내여야 합니다. 제안 모드 산출근거에서 품명을 줄인 뒤 보내세요.`,
      };
    });
}

// ─── 조회 ─────────────────────────────────────────────────────────────────────

/**
 * 수행 모드 한 벌(S-2). 버전마다 비목별 매트릭스·표 모델·기준 버전·RL-23과 Phase 25 보기 3종(붙임4형·조정회의형·
 * 참여인원), Phase 26 규칙 판정(§6.14.8 — 각 버전을 판정 대상으로)·편성 항목 보기·8-2 판정 줄을 계산해 내린다.
 * 판정은 버전마다 미리 해 둔다 — 보고 있는 버전이 바뀔 때마다 서버를 다시 부르지 않게. 하위 행은 버전 id 묶음으로 한 번씩만 읽는다(버전 수만큼 왕복하지 않는다 — §12).
 * 조정회의형 변경전은 제안 데이터를 보내기와 같은 변환(`buildBaselineFromPlan`)으로 한 번만 바꿔 모든 버전이 쓴다.
 * 하나라도 실패하면 실패를 그대로 올린다 — 버전·줄을 빈 배열로 눙치면 "버전 없음" 안내나 0 매트릭스가
 * 사실처럼 보인다(절대 규칙 5).
 */
export async function getAgreementData(projectId: string): Promise<ActionResult<AgreementData>> {
  try {
    const pid = parseOrThrow(uuidSchema, projectId, '과제 ID 형식이 올바르지 않습니다.');
    const { client } = await requireApprovedUser();

    const [project, years, stages, versions, settings, items, details, members, rules] = await Promise.all([
      projectsRepo.getProjectById(client, pid),
      yearsRepo.listYears(client, pid),
      stagesRepo.listStages(client, pid),
      agreementsRepo.listVersionsByProject(client, pid),
      settingsRepo.getSettings(client),
      budgetItemsRepo.listBudgetItemsByProject(client, pid),
      budgetDetailsRepo.listByProject(client, pid),
      membersRepo.listMembers(client, pid),
      budgetRulesRepo.listByProject(client, pid),
    ]);
    const versionIds = versions.map((v) => v.id);
    const [lines, participants, govSupport, agreementItems] = await Promise.all([
      agreementsRepo.listLinesByVersionIds(client, versionIds),
      agreementsRepo.listParticipantsByVersionIds(client, versionIds),
      agreementsRepo.listGovSupportByVersionIds(client, versionIds),
      agreementsRepo.listItemsByVersionIds(client, versionIds),
    ]);

    const data = computeOrCorrupt((): AgreementData => {
      const linesByVersion = groupByVersion(versions, lines);
      const participantsByVersion = groupByVersion(versions, participants);
      const govByVersion = groupByVersion(versions, govSupport);
      const itemsByVersion = groupByVersion(versions, agreementItems);
      const bases = baseVersionIds(versions);
      const current = currentVersionId(versions);
      const sortedYears = sortYears(years);
      const sortedStages = [...stages].sort((a, b) => a.order - b.order);
      const sortedMembers = [...members].sort((a, b) => a.order - b.order);
      const ruleInputs = toRuleInputs(rules);
      const preservationOff = isPreservationOff(ruleInputs);
      const yearIds = sortedYears.map((y) => y.id);
      // AG-4 변경전 — 버전과 무관하다. 변환 실패(issues)는 보기의 사유로 실린다(0으로 채우지 않는다)
      const planBaseline = buildBaselineFromPlan({ items, details, members, years });

      const views = versions.map((version): AgreementVersionView => {
        const own = linesByVersion.get(version.id)!;
        const ownParticipants = participantsByVersion.get(version.id)!;
        const ownGov = govByVersion.get(version.id)!;
        const ownItems = itemsByVersion.get(version.id)!;
        const categoryView = buildCategoryView(own, years);
        const baseId = bases[version.id] ?? null;
        const preservation = checkSubcategoryPreservation(
          own,
          baseId === null ? null : { versionId: baseId, lines: linesByVersion.get(baseId)! }
        );

        // §6.14.8 판정 대상 = 이 버전. 판정기는 evaluateRules 하나(D-10) — 어댑터가 입력만 바꾼다.
        // RL-14·RL-15의 hireType은 과제 인력 원본(Member)에서 읽는다 — 화면용 `members`(AgreementMemberOption)가 아니다
        const judged = evaluateAgreementRules({
          lines: own,
          participants: ownParticipants,
          items: ownItems,
          govSupport: ownGov,
          members,
          years,
          rules: ruleInputs,
        });
        const itemsView = buildItemsView({ items: ownItems, lines: own, years, findings: judged.evaluation.findings });

        const attachment4 = buildAttachment4View({
          lines: own,
          years,
          stages,
          govSupport: ownGov,
          rules: ruleInputs,
        });
        const adjustment = buildAdjustmentView({
          years,
          before: planBaseline,
          after: { versionId: version.id, versionName: version.name, lines: own },
          currentVersionId: current,
        });
        const participantsView = buildParticipantsView({
          participants: ownParticipants,
          members,
          years,
          lines: own,
        });

        return {
          version,
          categoryView,
          categoryTable: categoryViewTable(categoryView, categoryTableTitle(version)),
          baseVersionId: baseId,
          preservation,
          preservationStatus: summarizePreservation(preservation, preservationOff, versions),
          canUnconfirm: canUnconfirm(versions, version.id),
          lineCount: own.length,
          attachment4: {
            view: attachment4,
            tables: attachment4Tables(attachment4, {
              plan81: `${version.name} — 붙임4 8-1 지원·부담계획`,
              plan82: `${version.name} — 붙임4 8-2 사용계획`,
            }),
          },
          adjustment: { view: adjustment, table: adjustmentTable(adjustment, `${version.name} — 조정회의`) },
          participants: {
            view: participantsView,
            table: participantsTable(participantsView, `${version.name} — 참여인원`),
            rows: ownParticipants,
          },
          govSupport: ownGov,
          ruleResult: {
            targetLabel: `${version.name} · ${AGREEMENT_VERSION_STATUS_LABELS[version.status]}`,
            evaluation: judged.evaluation,
            notes: judged.notes,
            totalsSource: judged.totalsSource,
          },
          items: {
            view: itemsView,
            table: itemsTable(itemsView, `${version.name} 편성 항목`),
            rows: ownItems,
          },
          form82Rules: buildForm82RuleView(judged.evaluation, ruleInputs, yearIds),
        };
      });

      return {
        projectId: pid,
        projectName: project.name,
        todayISO: todayISO(new Date()), // §6.5 기준일 — Asia/Seoul 달력
        years: sortedYears,
        versions: views,
        currentVersionId: current,
        draftVersionId: draftVersionId(versions),
        nextVersionMeta: suggestNextVersionMeta(versions),
        currencyUnit: settings.currencyUnit,
        stages: sortedStages,
        members: sortedMembers.map((m) => ({
          id: m.id,
          name: m.name,
          order: m.order,
          annualSalary: m.annualSalary,
        })),
        rules,
        ruleTargetVersionId: ruleTargetVersionId(versions, null),
      };
    });

    return { ok: true, data };
  } catch (e) {
    return toFailure(e);
  }
}

/**
 * AG-7 두 버전 증감 + B의 RL-23(S-12) + 장비 사전 승인(AG-7 ④, Phase 26 S-20). A·B는 둘 다 이 과제의 버전이어야
 * 한다. 같은 버전끼리면 전부 불변. 세목 총액 보존은 A가 아니라 base(B)와 비교한다.
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

    const [years, versions, members, rules] = await Promise.all([
      yearsRepo.listYears(client, pid),
      agreementsRepo.listVersionsByProject(client, pid),
      membersRepo.listMembers(client, pid),
      budgetRulesRepo.listByProject(client, pid),
    ]);
    const from = versions.find((v) => v.id === fromId);
    const to = versions.find((v) => v.id === toId);
    if (!from || !to) {
      throw new RuleViolationError('이 과제에 속하지 않은 협약 예산 버전은 비교할 수 없습니다.');
    }

    const baseId = computeOrCorrupt(() => baseVersionIds(versions)[toId] ?? null);
    const ids = [...new Set([fromId, toId, ...(baseId === null ? [] : [baseId])])];
    const [lines, participants, agreementItems] = await Promise.all([
      agreementsRepo.listLinesByVersionIds(client, ids),
      agreementsRepo.listParticipantsByVersionIds(client, [...new Set([fromId, toId])]),
      agreementsRepo.listItemsByVersionIds(client, [...new Set([fromId, toId])]),
    ]);

    const data = computeOrCorrupt((): AgreementChangesData => {
      const linesOf = (id: string) => lines.filter((l) => l.versionId === id);
      const participantsOf = (id: string) => participants.filter((p) => p.versionId === id);
      const itemsOf = (id: string) => agreementItems.filter((i) => i.versionId === id);
      const base = baseId === null ? null : versions.find((v) => v.id === baseId)!;
      const ruleInputs = toRuleInputs(rules);
      const preservationOff = isPreservationOff(ruleInputs);

      const lineDiff = diffAgreementLines(linesOf(fromId), linesOf(toId), years);
      const participantDiff = diffAgreementParticipants(participantsOf(fromId), participantsOf(toId), years);
      const preservation = checkSubcategoryPreservation(
        linesOf(toId),
        base === null ? null : { versionId: base.id, lines: linesOf(base.id) }
      );
      const memberNames = members.map((m) => ({ id: m.id, name: m.name }));
      const equipmentApproval = diffEquipmentApproval(
        itemsOf(fromId),
        itemsOf(toId),
        ruleInputs.find((r) => r.code === 'equipment_review_threshold')
      );

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
        preservationStatus: summarizePreservation(preservation, preservationOff, versions),
        equipmentApproval,
        tables: {
          lines: buildLineChangesTable(lineDiff, { years, from, to }),
          participants: buildParticipantChangesTable(participantDiff, { years, members: memberNames, from, to }),
          preservation: preservationOff
            ? preservationOffTable(to)
            : buildPreservationTable(preservation, { target: to, base }),
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
): Promise<{
  versions: AgreementVersion[];
  years: Year[];
  baseline: BaselineFromPlanResult;
  /** 순수 함수가 통과시킨 뒤 액션이 더 거부하는 사유(품명 길이). baseline이 ok가 아니면 빈 배열 */
  extraIssues: AgreementBaselineIssue[];
}> {
  const [versions, years, items, details, members] = await Promise.all([
    agreementsRepo.listVersionsByProject(client, projectId),
    yearsRepo.listYears(client, projectId),
    budgetItemsRepo.listBudgetItemsByProject(client, projectId),
    budgetDetailsRepo.listByProject(client, projectId),
    membersRepo.listMembers(client, projectId),
  ]);
  const baseline = computeOrCorrupt(() => buildBaselineFromPlan({ items, details, members, years }));
  const extraIssues = baseline.ok ? itemNameIssues(baseline.items, years) : [];
  return { versions, years, baseline, extraIssues };
}

/** 보내기 확인 대화의 미리보기 — 쓰기 없음. 거부 사유(issues)도 실패가 아니라 값으로 돌려준다 */
export async function previewAgreementBaseline(
  projectId: string
): Promise<ActionResult<AgreementBaselinePreview>> {
  try {
    const pid = parseOrThrow(uuidSchema, projectId, '과제 ID 형식이 올바르지 않습니다.');
    const { client } = await requireApprovedUser();

    const { versions, years, baseline, extraIssues } = await loadBaseline(client, pid);
    const meta = {
      draftVersionName: versions.find((v) => v.status === 'draft')?.name ?? null,
      hasVersions: versions.length > 0,
    };
    const data: AgreementBaselinePreview = !baseline.ok
      ? { ...meta, ok: false, issues: baseline.issues }
      : extraIssues.length > 0
        ? { ...meta, ok: false, issues: extraIssues }
        : {
            ...meta,
            ok: true,
            summary: baseline.summary,
            govCash: sortYears(years).map((y) => ({
              yearId: y.id,
              yearName: y.name,
              amount: baseline.govCash[y.id] ?? null,
            })),
            itemSummary: baseline.itemSummary,
          };
    return { ok: true, data };
  } catch (e) {
    return toFailure(e);
  }
}

/**
 * [협약 기준선으로 보내기](AV-6). 제안 편성(budget_items·budget_details·인력 연봉)을 지금 읽어 기준선을 만들고
 * 단일 트랜잭션 RPC로 작성 중 버전을 만든다. 버전이 이미 있어도 작성 중 버전이 없으면 허용한다(Q4).
 * 금액을 잃을 셀(축 반쪽 불일치·음수 그룹)이 하나라도 있으면 위치를 모두 적어 RULE — 버전을 반쯤 만들지 않는다.
 * 편성 항목(AV-6 ③)도 같은 트랜잭션에서 만든다 — 음수 산출 행·200자 넘는 품명도 같은 방식으로 RULE.
 */
export async function createAgreementVersionFromPlan(
  projectId: string,
  input: unknown
): Promise<ActionResult<AgreementBaselineCreated>> {
  try {
    const pid = parseOrThrow(uuidSchema, projectId, '과제 ID 형식이 올바르지 않습니다.');
    const { kind, name } = parseOrThrow(versionCreateSchema, input, '버전 종류·이름이 올바르지 않습니다.');
    const { client } = await requireApprovedUser();

    const { versions, baseline, extraIssues } = await loadBaseline(client, pid);
    assertNoDraft(versions);
    if (!baseline.ok || extraIssues.length > 0) {
      const issues: AgreementBaselineIssue[] = baseline.ok ? extraIssues : baseline.issues;
      throw new RuleViolationError(
        [
          '협약 기준선으로 보낼 수 없습니다 — 제안 모드에서 아래를 고친 뒤 다시 보내세요.',
          ...issues.map((i) => `· ${i.message}`),
        ].join('\n')
      );
    }
    // §5.22 세목 검사는 액션 Zod가 유일한 관문이다 — 순수 함수 결과도 같은 문을 지난다
    const lines = parseOrThrow(z.array(lineSeedSchema), baseline.lines, '보낼 금액 줄이 올바르지 않습니다.');
    const govCash = parseOrThrow(govCashMapSchema, baseline.govCash, '보낼 정부지원 현금이 올바르지 않습니다.');

    const created = await agreementsRepo.createVersion(client, pid, {
      kind,
      name,
      lines,
      participants: baseline.participants,
      govCash,
      items: baseline.items,
    });
    revalidateAgreement(pid);
    return {
      ok: true,
      data: {
        versionId: created.versionId,
        order: created.order,
        lineCount: created.lines,
        participantCount: created.participants,
        itemCount: created.items,
        govSupportCount: created.govSupport,
        summary: baseline.summary,
        itemSummary: baseline.itemSummary,
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
        itemCount: created.items,
        govSupportCount: created.govSupport,
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
        govSupportCount: created.govSupport,
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

// ─── 붙임4형 편집 (AG-3) ──────────────────────────────────────────────────────

/** 작성 중 버전의 내용 편집 공통 관문 — 확정 잠금(AV-2)·과제 경계를 트리거보다 먼저 사람이 읽을 문장으로 */
async function loadEditableVersionYear(
  client: SupabaseClient,
  versionId: string,
  yearId: string
): Promise<AgreementVersion> {
  const [version, year] = await Promise.all([
    agreementsRepo.getVersionById(client, versionId),
    yearsRepo.getYearById(client, yearId),
  ]);
  if (version.status === 'confirmed') throw new RuleViolationError(CONFIRMED_LOCK_MESSAGE);
  if (year.projectId !== version.projectId) {
    throw new RuleViolationError('이 과제에 속하지 않은 연차입니다.');
  }
  return version;
}

/**
 * 붙임4형 8-2 데이터 칸 (연차, 양식 행, 축)의 총액을 `amount`로(S-12). 어느 줄을 고칠지는 resolveFormCellEdit가
 * 정한다 — 칸에 함께 묶인 다른 줄은 건드리지 않는다. 결과는 금액 줄이라 비목별 보기도 같은 값을 보인다(AG-1).
 * O-2: 클라이언트는 version을 보내지 않고 여기서 방금 읽은 줄의 version으로 갱신해 그사이 경합만 STALE로 알린다.
 */
export async function setAgreementFormCellAmount(
  versionId: string,
  input: unknown
): Promise<ActionResult<AgreementFormCellEditResult>> {
  let client: SupabaseClient | undefined;
  try {
    const vid = parseOrThrow(uuidSchema, versionId, '버전 ID 형식이 올바르지 않습니다.');
    const target = parseOrThrow(formCellEditSchema, input, '편집할 칸이 올바르지 않습니다.');
    const ctx = await requireApprovedUser();
    client = ctx.client;

    const version = await loadEditableVersionYear(client, vid, target.yearId);
    const lines = await agreementsRepo.listLinesByVersionIds(client, [vid]);
    const resolution = computeOrCorrupt(() => resolveFormCellEdit(lines, target));

    let result: AgreementFormCellEditResult;
    switch (resolution.kind) {
      case 'reject':
        if (resolution.reason === 'invalid_amount') throw new ValidationError(resolution.message);
        throw new RuleViolationError(resolution.message);
      case 'noop':
        // 이미 그 금액이다 — 쓰지 않으므로 다시 그릴 것도 없다
        return { ok: true, data: { kind: 'noop', line: null } };
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

/**
 * §5.25 버전의 연차 정부지원 현금(붙임4형 8-1 A 칸). `null` = 미입력으로 되돌림, 0은 입력값이다.
 * O-2(S-4): 클라이언트 version 없이 서버가 방금 읽은 행으로 가른다 — 행+null → 그 version으로 삭제,
 * 행+값 → 갱신, 없음+값 → 삽입, 없음+null → 변화 없음. 0행 갱신·삭제·유일 위반(그사이 경합)은 STALE.
 * 확정 버전 행 삭제는 트리거가 막지 않는다(S-4) — 여기 관문이 유일한 잠금이다.
 */
export async function setAgreementGovCash(
  versionId: string,
  yearId: string,
  amount: number | null
): Promise<ActionResult<AgreementGovCashEditResult>> {
  let client: SupabaseClient | undefined;
  try {
    const vid = parseOrThrow(uuidSchema, versionId, '버전 ID 형식이 올바르지 않습니다.');
    const yid = parseOrThrow(uuidSchema, yearId, '연차 ID 형식이 올바르지 않습니다.');
    const value = parseOrThrow(wonAmountSchema.nullable(), amount, '정부지원 현금이 올바르지 않습니다.');
    const ctx = await requireApprovedUser();
    client = ctx.client;

    const version = await loadEditableVersionYear(client, vid, yid);
    const existing =
      (await agreementsRepo.listGovSupportByVersionIds(client, [vid])).find((g) => g.yearId === yid) ?? null;

    let result: AgreementGovCashEditResult;
    if (value === null) {
      if (existing === null) return { ok: true, data: { kind: 'noop', row: null } };
      await agreementsRepo.removeGovSupport(client, vid, yid, existing.version);
      result = { kind: 'delete', row: null };
    } else {
      const row = await agreementsRepo.upsertGovSupport(
        client,
        vid,
        yid,
        value,
        existing === null ? null : existing.version,
        ctx.user.id
      );
      result = { kind: existing === null ? 'insert' : 'update', row };
    }

    revalidateAgreement(version.projectId);
    return { ok: true, data: result };
  } catch (e) {
    return toFailure(e, client);
  }
}
