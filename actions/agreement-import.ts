'use server';

// 붙임4 가져오기 서버 액션 (SOT §5.21 AV-7·AV-1·AV-2, §9 Agreement Budget SA-1~SA-4, §6.8 I-13,
// 계획서 docs/plans/phase-25-plan.md G-4·G-11·S-13~S-16).
// 반환은 ActionResult<T> — 예외를 그대로 던지지 않는다. supabase 직접 호출 금지, lib/db/ 리포지토리만 쓴다 (§8.6).
//
// 미리보기와 반영은 **같은 경로**(어댑터 → 파서)를 타고, 반영은 `fileHash`로 미리보기와 같은 파일인지 대조한다
// (I-13·IN-6과 같은 원칙). 파일은 서버에 남지 않는다 — 반영 때 다시 올려 다시 파싱한다.
// 버전 생성 규칙은 [협약 기준선으로 보내기]와 같다(G-4): 작성 중 버전이 있으면 RULE, 있어도 작성 중이 없으면 허용.
// 참여인원·편성 항목은 만들지 않고 스냅샷도 없다 — 되돌리기는 그 버전 삭제(AV-4).

import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import type { ActionResult, AgreementVersion, AgreementVersionKind, BudgetCategory, Year } from '@/types';
import { requireApprovedUser } from '@/lib/auth/guard';
import * as agreementsRepo from '@/lib/db/agreements';
import * as projectsRepo from '@/lib/db/projects';
import * as yearsRepo from '@/lib/db/years';
import { RepositoryError, RuleViolationError, ValidationError, toActionFailure } from '@/lib/db/errors';
import { agreementVersionKindSchema, budgetCategorySchema, detailAxisSchema } from '@/lib/db/schema';
import { BUDGET_CATEGORY_ORDER, agreementSubcategoryLabel } from '@/lib/constants';
import { readAttachment4Upload } from '@/lib/import-adapter';
import {
  parseAttachment4,
  type Attachment4Line,
  type Attachment4ParseResult,
  type Attachment4Warning,
} from '@/lib/agreement/attachment4-parse';
import { suggestNextVersionMeta, type NextVersionMeta } from '@/lib/agreement/versions';

// ─── 반환 모델 ─────────────────────────────────────────────────────────────────

/** 미리보기에 넘긴 선택 그대로 — 반영 때 이 값을 다시 넘긴다. null = 지정하지 않음(파서 기본: 블록 하나·8-1 자동) */
export interface Attachment4ImportSelection {
  blockIndex: number | null;
  plan81Row: number | 'none' | null;
}

export interface Attachment4ImportCategoryAmount {
  cash: number;
  inKind: number;
}

export interface Attachment4ImportYearSummary {
  yearId: string;
  yearName: string;
  /** `Attachment4ImportSummary.categories`의 비목마다 하나(없으면 0) */
  byCategory: Partial<Record<BudgetCategory, Attachment4ImportCategoryAmount>>;
  cash: number;
  inKind: number;
  total: number;
  /** 그 연차 정부지원 현금(8-1 A, 원). null = 미입력(행을 만들지 않는다 — §5.25) */
  govCash: number | null;
  lineCount: number;
}

/** 파서가 ok일 때만 — 연차 × 비목 현금/현물 합. 파생 값이라 저장하지 않는다 */
export interface Attachment4ImportSummary {
  /** 어느 연차에든 금액이 있는 비목, 부록 A.1 순서 */
  categories: BudgetCategory[];
  /** 과제 연차 전부, order 순 — 줄 없는 연차도 0으로 보인다(연차 열 수 불일치 확인용) */
  years: Attachment4ImportYearSummary[];
  lineCount: number;
  cash: number;
  inKind: number;
  total: number;
  /** 정부지원 현금 행 수(= 반영 시 §5.25 행 수) */
  govCashYearCount: number;
}

export interface Attachment4ImportPreview {
  fileName: string;
  fileSize: number;
  fileHash: string;
  selection: Attachment4ImportSelection;
  /**
   * 파서 결과 원본(상태별). `choose-block` → 블록 목록, `choose-81-row` → 8-1 후보, `ok` → 줄·정부지원 현금·8-1 정합·
   * 경고, `blocked` → issues. 반영은 같은 입력으로 같은 함수를 다시 부른다
   */
  parse: Attachment4ParseResult;
  /** `parse.status === 'ok'`일 때만 */
  summary: Attachment4ImportSummary | null;
  /** 있으면 반영이 RULE로 거부된다(AV-2) — 대화가 미리 비활성 이유를 보인다 */
  draftVersionName: string | null;
  hasVersions: boolean;
  /** 종류·이름 초깃값(AV-1) */
  nextVersionMeta: NextVersionMeta;
}

export interface Attachment4ImportCreated {
  versionId: string;
  order: number;
  lineCount: number;
  /** 항상 0 — 가져오기는 참여인원·편성 항목을 만들지 않는다(AV-7 ⑤) */
  participantCount: number;
  itemCount: number;
  govCashYearCount: number;
  blockLabel: string;
  /** 반영된 파싱의 경고(정합·집계 차액 등) — 반영을 막지 않았지만 결과에 남긴다 */
  warnings: Attachment4Warning[];
}

// ─── 입력 검증 ─────────────────────────────────────────────────────────────────

const uuidSchema = z.uuid();

const selectionIndexSchema = z.int('선택 번호가 올바르지 않습니다.').min(0, '선택 번호가 올바르지 않습니다.');

const commitOptionsSchema = z.object({
  fileHash: z.string().regex(/^[0-9a-f]{64}$/, '미리보기를 먼저 실행해야 가져올 수 있습니다.'),
  blockIndex: selectionIndexSchema.nullable(),
  plan81Row: z.union([z.literal('none'), selectionIndexSchema]).nullable(),
  kind: agreementVersionKindSchema,
  name: z.string().trim().min(1, '버전 이름을 입력하세요.').max(100, '버전 이름은 100자 이내여야 합니다.'),
});

export type Attachment4ImportCommitOptions = {
  fileHash: string;
  blockIndex: number | null;
  plan81Row: number | 'none' | null;
  kind: AgreementVersionKind;
  name: string;
};

// §5.22: 세목은 그 비목의 부록 A.5 코드 또는 'default'. 파서 결과도 같은 문을 지난다(actions/agreement.ts와 같은 검사)
const lineSeedSchema = z
  .object({
    yearId: z.uuid(),
    category: budgetCategorySchema,
    subcategoryCode: z.string(),
    axis: detailAxisSchema,
    amount: z
      .int('금액은 원 단위 정수여야 합니다.')
      .min(0, '금액은 0 이상이어야 합니다.')
      .max(Number.MAX_SAFE_INTEGER, '금액이 너무 큽니다.'),
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

/** FormData 정수 필드. 없음·빈 문자열 = 지정하지 않음 */
function formIndex(formData: FormData, field: string, label: string): number | null {
  const raw = formData.get(field);
  if (raw === null || raw === '') return null;
  if (typeof raw !== 'string' || !/^\d+$/.test(raw)) {
    throw new ValidationError(`${label} 값이 올바르지 않습니다.`);
  }
  return Number(raw);
}

function readSelection(formData: FormData): Attachment4ImportSelection {
  const blockIndex = formIndex(formData, 'blockIndex', '기관 블록 선택');
  const plan81Raw = formData.get('plan81Row');
  const plan81Row = plan81Raw === 'none' ? 'none' : formIndex(formData, 'plan81Row', '8-1 행 선택');
  return { blockIndex, plan81Row };
}

// ─── 공통 ─────────────────────────────────────────────────────────────────────

function toFailure(e: unknown): ActionResult<never> {
  if (!(e instanceof RepositoryError)) console.error('[actions/agreement-import] 처리 실패:', e);
  return toActionFailure(e);
}

/**
 * 파서는 손상 입력에 결과값(blocked)을 돌려주도록 만들어졌다 — 그래도 던지면 SA-4 일반 문구로 감추지 않고
 * 파일을 해석하지 못했다고 알린다(절대 규칙 5). 파서 메시지에는 테이블·제약 이름이 없다.
 */
function parseOrCorrupt(compute: () => Attachment4ParseResult): Attachment4ParseResult {
  try {
    return compute();
  } catch (e) {
    console.error('[actions/agreement-import] 붙임4 해석 실패:', e);
    const detail = e instanceof Error ? e.message : String(e);
    throw new ValidationError(`붙임4 파일을 해석하지 못했습니다 — ${detail}`);
  }
}

function draftExistsMessage(name: string): string {
  return `작성 중 버전 "${name}"이 있습니다 — 확정하거나 삭제한 뒤 만드세요`;
}

function assertNoDraft(versions: readonly AgreementVersion[]): void {
  const draft = versions.find((v) => v.status === 'draft');
  if (draft) throw new RuleViolationError(draftExistsMessage(draft.name));
}

function sortYears(years: readonly Year[]): Year[] {
  return [...years].sort((a, b) => a.order - b.order);
}

/**
 * 미리보기·반영 공용 — 같은 파일 읽기 + 같은 연차 + 같은 파서. 두 경로가 따로 읽으면 대화에 보인 줄과
 * 만든 버전이 어긋날 수 있다.
 */
async function loadImport(
  client: Awaited<ReturnType<typeof requireApprovedUser>>['client'],
  projectId: string,
  formData: FormData,
  selection: Attachment4ImportSelection,
  expectedHash: string | null
) {
  // 과제가 없으면 NOT_FOUND로 먼저 막는다 — 연차 0개로 읽혀 "연차를 먼저 만드세요"로 잘못 안내되지 않게
  await projectsRepo.getProjectById(client, projectId);
  const upload = await readAttachment4Upload(formData);
  if (expectedHash !== null && upload.fileHash !== expectedHash) {
    throw new RuleViolationError(
      '미리보기에 사용한 파일과 다른 파일입니다 — 파일을 다시 올리고 미리보기부터 진행하세요.'
    );
  }
  const [years, versions] = await Promise.all([
    yearsRepo.listYears(client, projectId),
    agreementsRepo.listVersionsByProject(client, projectId),
  ]);
  const parse = parseOrCorrupt(() =>
    parseAttachment4({
      sheets: upload.sheets,
      years: years.map((y) => ({ id: y.id, name: y.name, order: y.order })),
      ...(selection.blockIndex === null ? {} : { blockIndex: selection.blockIndex }),
      ...(selection.plan81Row === null ? {} : { plan81Row: selection.plan81Row }),
    })
  );
  return { upload, years: sortYears(years), versions, parse };
}

function summarize(
  lines: readonly Attachment4Line[],
  govCash: Readonly<Record<string, number>>,
  years: readonly Year[]
): Attachment4ImportSummary {
  const present = new Set<BudgetCategory>(lines.map((l) => l.category));
  const categories = BUDGET_CATEGORY_ORDER.filter((c) => present.has(c));

  const yearSummaries = years.map((year): Attachment4ImportYearSummary => {
    const own = lines.filter((l) => l.yearId === year.id);
    const byCategory: Partial<Record<BudgetCategory, Attachment4ImportCategoryAmount>> = {};
    for (const c of categories) byCategory[c] = { cash: 0, inKind: 0 };
    let cash = 0;
    let inKind = 0;
    for (const l of own) {
      const slot = byCategory[l.category]!;
      if (l.axis === 'cash') {
        slot.cash += l.amount;
        cash += l.amount;
      } else {
        slot.inKind += l.amount;
        inKind += l.amount;
      }
    }
    return {
      yearId: year.id,
      yearName: year.name,
      byCategory,
      cash,
      inKind,
      total: cash + inKind,
      govCash: Object.prototype.hasOwnProperty.call(govCash, year.id) ? govCash[year.id]! : null,
      lineCount: own.length,
    };
  });

  const cash = yearSummaries.reduce((s, y) => s + y.cash, 0);
  const inKind = yearSummaries.reduce((s, y) => s + y.inKind, 0);
  return {
    categories,
    years: yearSummaries,
    lineCount: lines.length,
    cash,
    inKind,
    total: cash + inKind,
    govCashYearCount: Object.keys(govCash).length,
  };
}

// ─── 액션 ─────────────────────────────────────────────────────────────────────

/**
 * [붙임4 가져오기] 미리보기 — 쓰기 없음. `formData`: `file`(필수), `blockIndex`(choose-block 뒤), `plan81Row`
 * (choose-81-row 뒤 — 정수 또는 `'none'`). 파서의 choose·blocked도 실패가 아니라 값으로 돌려준다.
 */
export async function previewAttachment4Import(
  projectId: string,
  formData: FormData
): Promise<ActionResult<Attachment4ImportPreview>> {
  try {
    const pid = parseOrThrow(uuidSchema, projectId, '과제 ID 형식이 올바르지 않습니다.');
    const selection = readSelection(formData);
    const { client } = await requireApprovedUser();

    const { upload, years, versions, parse } = await loadImport(client, pid, formData, selection, null);
    return {
      ok: true,
      data: {
        fileName: upload.fileName,
        fileSize: upload.fileSize,
        fileHash: upload.fileHash,
        selection,
        parse,
        summary: parse.status === 'ok' ? summarize(parse.lines, parse.govCash, years) : null,
        draftVersionName: versions.find((v) => v.status === 'draft')?.name ?? null,
        hasVersions: versions.length > 0,
        nextVersionMeta: suggestNextVersionMeta(versions),
      },
    };
  } catch (e) {
    return toFailure(e);
  }
}

/**
 * [붙임4 가져오기] 반영(AV-7). 같은 파일을 다시 올려 같은 선택으로 다시 파싱하고, 미리보기의 `fileHash`와 대조한다.
 * 선택은 `options`가 정본이다(`formData`의 blockIndex·plan81Row는 읽지 않는다). 파싱이 ok가 아니면 버전을 만들지 않는다.
 */
export async function commitAttachment4Import(
  projectId: string,
  formData: FormData,
  options: Attachment4ImportCommitOptions
): Promise<ActionResult<Attachment4ImportCreated>> {
  try {
    const pid = parseOrThrow(uuidSchema, projectId, '과제 ID 형식이 올바르지 않습니다.');
    const { fileHash, blockIndex, plan81Row, kind, name } = parseOrThrow(
      commitOptionsSchema,
      options,
      '가져오기 선택이 올바르지 않습니다.'
    );
    const { client } = await requireApprovedUser();

    const { years, versions, parse } = await loadImport(client, pid, formData, { blockIndex, plan81Row }, fileHash);
    assertNoDraft(versions);

    switch (parse.status) {
      case 'choose-block':
        throw new RuleViolationError('파일에 기관 블록이 여럿입니다 — 미리보기에서 가져올 블록을 고르세요.');
      case 'choose-81-row':
        throw new RuleViolationError(
          "8-1에서 고른 블록과 같은 기관 행을 하나로 정하지 못했습니다 — 미리보기에서 8-1 행을 고르거나 '8-1 쓰지 않음'을 고르세요."
        );
      case 'blocked':
        throw new RuleViolationError(
          [
            '붙임4 파일을 가져올 수 없습니다 — 파일에서 아래를 고친 뒤 다시 올리세요.',
            ...parse.issues.map((i) => `· ${i.message}`),
          ].join('\n')
        );
      case 'ok':
        break;
    }

    const lines = parseOrThrow(z.array(lineSeedSchema), parse.lines, '가져올 금액 줄이 올바르지 않습니다.');
    // 파서가 no_amounts로 막지만 0원 버전은 되돌리기 어려운 손상이라 반영 직전에 한 번 더 막는다(절대 규칙 5)
    if (lines.length === 0) {
      throw new RuleViolationError(`'${parse.blockLabel.replace(/\s+/g, ' ')}' 블록에 가져올 금액이 없습니다 — 0원 협약 버전은 만들지 않습니다.`);
    }
    const yearIds = new Set(years.map((y) => y.id));
    for (const [yearId, amount] of Object.entries(parse.govCash)) {
      if (!yearIds.has(yearId) || !Number.isSafeInteger(amount) || amount < 0) {
        throw new ValidationError('가져올 정부지원 현금이 올바르지 않습니다.');
      }
    }

    const created = await agreementsRepo.createVersion(client, pid, {
      kind,
      name,
      lines,
      participants: [],
      govCash: parse.govCash,
    });
    revalidatePath(`/projects/${pid}/budget`);
    return {
      ok: true,
      data: {
        versionId: created.versionId,
        order: created.order,
        lineCount: created.lines,
        participantCount: created.participants,
        itemCount: 0,
        govCashYearCount: created.govSupport,
        blockLabel: parse.blockLabel,
        warnings: parse.warnings,
      },
    };
  } catch (e) {
    return toFailure(e);
  }
}
