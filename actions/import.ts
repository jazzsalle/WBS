'use server';

// 엑셀 예산계획 임포트 서버 액션 (SOT §9 Budget Import, §6.8, §7.9.1, SA-1~SA-4)
//
// 파싱은 전부 lib/import의 순수 함수가 하고, SheetJS 읽기는 lib/import-adapter가 한다.
// 여기서는 인증·검증·과제 경계·리포지토리 호출만 한다 — 규칙을 여기서 다시 쓰면 반드시 어긋난다.
//
// 핵심 불변식 (§9 주석):
//   previewImport와 commitImport는 **같은 파싱 경로**(runImportPipeline)를 쓴다.
//   미리보기에서 본 것과 반영되는 것이 다르면 안 된다. fileHash 대조로 같은 파일임을 보장한다.
//
// supabase 직접 호출 금지 — 반드시 lib/db/ 리포지토리를 거친다 (절대 규칙 3, §8.6).

import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import type { SupabaseClient } from '@supabase/supabase-js';
import type {
  ActionResult,
  AnalyzeSheetHints,
  AnalyzeSheetResult,
  BudgetCategory,
  CommitImportResult,
  DetectedStructure,
  ImportKind,
  ImportPreview,
  ImportProfile,
  ImportSnapshot,
  InspectWorkbookResult,
  PreviewImportResult,
  SheetColumnInfo,
} from '@/types';
import { requireApprovedUser } from '@/lib/auth/guard';
import { RuleViolationError, ValidationError, toActionFailure } from '@/lib/db/errors';
import { budgetCategorySchema, importKindSchema } from '@/lib/db/schema';
import * as budgetItemsRepo from '@/lib/db/budget-items';
import * as profilesRepo from '@/lib/db/import-profiles';
import * as snapshotsRepo from '@/lib/db/import-snapshots';
import type { ImportRestoreResult } from '@/lib/db/import-snapshots';
import * as yearsRepo from '@/lib/db/years';
import {
  buildPreview,
  cellAt,
  cellText,
  columnLetterToIndex,
  detectDataRange,
  detectLabelColumns,
  detectStructure,
  detectYearColumns,
  expandMerges,
  gridWidth,
  indexToColumnLetter,
  parseMatrix,
  recommendSheet,
} from '@/lib/import';
import type { MatchContext, ParseMatrixResult, RawSheet } from '@/lib/import';
import { readUploadedWorkbook, toCommitRows, toGridPreview } from '@/lib/import-adapter';

// ─── 입력 검증 (§9: 모든 액션은 Zod로 입력 검증) ──────────────────────────────

const uuidSchema = z.uuid();

const columnLetterSchema = z
  .string()
  .trim()
  .regex(/^[A-Za-z]{1,3}$/, '엑셀 열 문자가 올바르지 않습니다.')
  .transform((s) => s.toUpperCase());

const rowIndexSchema = z.int('행 번호는 0 이상 정수여야 합니다.').min(0, '행 번호는 0 이상 정수여야 합니다.');

// I-11: 단위 배수는 세 값뿐이다. 1000배 오류가 치명적이라 자유 숫자를 받지 않는다
const amountUnitSchema = z.union([z.literal(1), z.literal(1000), z.literal(1_000_000)]);

// §5.12.1 ImportProfile에서 BaseEntity·사용 이력을 뺀 부분집합 = ImportDraft.profile
const importProfileFieldsSchema = z.object({
  name: z.string().trim().min(1, '프로파일 이름을 입력하세요.').max(100, '이름은 100자 이내여야 합니다.'),
  kind: importKindSchema,
  ministry: z.string().trim().max(100).nullable(),
  projectId: uuidSchema.nullable(),
  sheetName: z.string().max(200).nullable(),
  headerRow: rowIndexSchema,
  dataStartRow: rowIndexSchema,
  orientation: z.enum(['row', 'column']),
  labelColumns: z.array(columnLetterSchema),
  yearColumnMappings: z.array(
    z.object({
      column: columnLetterSchema,
      yearOrder: z.int('연차 순서가 올바르지 않습니다.').min(0, '연차 순서가 올바르지 않습니다.'),
    })
  ),
  // 키 = 엑셀 원문 라벨. 정규화는 조회 시 lib/import가 한다 (변환해 저장하지 않는다)
  categoryAliases: z.record(z.string(), budgetCategorySchema),
  amountUnit: amountUnitSchema,
  skipRowPatterns: z.array(z.string()),
});

// JSON을 거치면 숫자 키가 문자열이 된다 — Record<number, _>를 문자열 키로 검증한다
const manualCategoryByRowSchema = z.record(
  z.string().regex(/^\d+$/, '행 번호가 올바르지 않습니다.'),
  budgetCategorySchema
);

// §5.12.2 ImportDraft. yearMapping의 키는 **엑셀 열 문자**다 (아래 resolveYearMapping 주석 참조)
const importDraftSchema = z.object({
  profile: importProfileFieldsSchema,
  yearMapping: z.record(columnLetterSchema, uuidSchema),
  skippedRowIndexes: z.array(rowIndexSchema),
  manualCategoryByRow: manualCategoryByRowSchema,
  // previewImport 첫 호출에서는 비어 있다. commitImport에서는 반드시 채워져 있어야 한다
  fileHash: z.string(),
});

const analyzeHintsSchema = z
  .object({
    headerRow: rowIndexSchema.nullable().optional(),
    dataStartRow: rowIndexSchema.nullable().optional(),
    dataEndRow: rowIndexSchema.nullable().optional(),
    labelColumns: z.array(columnLetterSchema).nullable().optional(),
    amountUnit: amountUnitSchema.nullable().optional(),
    ministry: z.string().trim().max(100).nullable().optional(),
    categoryAliases: z.record(z.string(), budgetCategorySchema).nullable().optional(),
    skipRowPatterns: z.array(z.string()).nullable().optional(),
  })
  .nullable()
  .optional();

const profileCreateSchema = importProfileFieldsSchema;
const profilePatchSchema = importProfileFieldsSchema.partial();

function parseOrThrow<T>(schema: z.ZodType<T>, value: unknown, fallback: string): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    throw new ValidationError(parsed.error.issues[0]?.message ?? fallback);
  }
  return parsed.data;
}

type ParsedDraft = z.infer<typeof importDraftSchema>;

// ─── 공통 헬퍼 ────────────────────────────────────────────────────────────────

// 임포트는 예산 매트릭스·과제 개요·대시보드 집행률을 전부 바꾼다. 스냅샷은 설정 화면에 뜬다
function revalidateImport(projectId: string): void {
  revalidatePath('/');
  revalidatePath(`/projects/${projectId}`);
  revalidatePath(`/projects/${projectId}/budget`);
  revalidatePath('/settings');
}

function pickSheet(sheets: readonly RawSheet[], sheetName: string | null): RawSheet {
  if (sheets.length === 0) throw new ValidationError('워크북에 시트가 없습니다.');
  // §5.12.1: sheetName이 null이면 첫 시트
  if (sheetName === null || sheetName === '') return sheets[0]!;
  const found = sheets.find((sheet) => sheet.name === sheetName);
  if (!found) {
    throw new ValidationError(`'${sheetName}' 시트를 찾을 수 없습니다. 다른 파일을 올렸는지 확인하세요.`);
  }
  return found;
}

// I-2 조회 우선순위(① 학습 별칭 → ② 부처 프리셋 → ③ 공통)를 lib/import에 그대로 넘긴다.
// skipRowPatterns가 비면 공통 SKIP_ROW_PATTERNS가 쓰인다 (I-5)
function matchContextOf(input: {
  categoryAliases?: Record<string, BudgetCategory> | null;
  ministry?: string | null;
  skipRowPatterns?: string[] | null;
}): MatchContext {
  return {
    draftAliases: input.categoryAliases ?? undefined,
    ministry: input.ministry ?? null,
    skipPatterns: input.skipRowPatterns && input.skipRowPatterns.length > 0 ? input.skipRowPatterns : undefined,
  };
}

/**
 * hints를 반영한 구조 추정. 감지 함수는 전부 lib/import의 순수 함수를 재사용하고
 * 여기서는 "사용자가 지정한 값이 추정을 이긴다"만 정한다 (§6.8 대원칙: 자동 인식은 제안이다).
 */
function analyzeStructure(
  sheet: RawSheet,
  hints: AnalyzeSheetHints | null | undefined,
  context: MatchContext
): DetectedStructure {
  const base = detectStructure(sheet, context);
  const headerRow = hints?.headerRow ?? base.headerRow;
  if (headerRow === null) {
    return hints?.amountUnit ? { ...base, amountUnit: hints.amountUnit } : base;
  }

  const cells = expandMerges(sheet).cells; // S-11
  const detected =
    headerRow === base.headerRow
      ? { yearColumns: base.yearColumns, totalColumns: base.totalColumns }
      : detectYearColumns(cells, headerRow);

  const firstYearColumnIndex = detected.yearColumns[0]?.columnIndex ?? gridWidth(cells);
  const candidates = Array.from({ length: firstYearColumnIndex }, (_, c) => c);
  const range = detectDataRange(cells, headerRow, candidates, context);

  const dataStartRow = hints?.dataStartRow ?? range.dataStartRow;
  const dataEndRow = hints?.dataEndRow ?? range.dataEndRow;
  const labelColumnIndexes =
    hints?.labelColumns && hints.labelColumns.length > 0
      ? hints.labelColumns.map(columnLetterToIndex)
      : detectLabelColumns(cells, firstYearColumnIndex, dataStartRow, dataEndRow);

  return {
    ...base,
    headerRow,
    dataStartRow,
    dataEndRow,
    labelColumns: labelColumnIndexes.map(indexToColumnLetter),
    labelColumnIndexes,
    yearColumns: detected.yearColumns,
    totalColumns: detected.totalColumns,
    amountUnit: hints?.amountUnit ?? base.amountUnit,
  };
}

/** §7.9.1 Step 3 좌측 목록 — 열 문자 + 헤더 텍스트 + 샘플값 3개 */
function describeColumns(sheet: RawSheet, structure: DetectedStructure): SheetColumnInfo[] {
  const cells = expandMerges(sheet).cells;
  const width = gridWidth(cells);
  const headerRow = structure.headerRow;
  const columns: SheetColumnInfo[] = [];

  for (let c = 0; c < width; c += 1) {
    const samples: string[] = [];
    for (let r = structure.dataStartRow; r <= structure.dataEndRow && samples.length < 3; r += 1) {
      const text = cellText(cellAt(cells, r, c));
      if (text !== '') samples.push(text);
    }
    columns.push({
      column: indexToColumnLetter(c),
      columnIndex: c,
      headerText: headerRow === null ? '' : cellText(cellAt(cells, headerRow, c)),
      samples,
    });
  }
  return columns;
}

/**
 * S-5: 연차 열 → yearId.
 *
 * **`ImportDraft.yearMapping`의 키는 엑셀 열 문자다** (예: `'E'`). §5.12.2가 "연차 열 라벨"이라고만
 * 적어 두어 해석 여지가 있으나, 헤더 텍스트는 비거나 중복될 수 있고 `profile.yearColumnMappings`가
 * 이미 열 문자를 키로 쓰므로 열 문자만이 두 구조를 어긋남 없이 잇는다.
 *
 * 알 수 없는 열·남의 과제 연차·중복 지정은 전부 **거부**한다 — RPC도 막지만 사용자에게 의미 있는
 * 메시지를 주는 건 액션의 몫이다 (N-13 패턴).
 */
function resolveYearMapping(
  draft: ParsedDraft,
  projectYearIds: ReadonlySet<string>
): Record<number, string> {
  const orderByColumn = new Map(
    draft.profile.yearColumnMappings.map((m) => [m.column, m.yearOrder] as const)
  );

  const yearIdByOrder: Record<number, string> = {};
  const orderByYearId = new Map<string, number>();

  for (const [column, yearId] of Object.entries(draft.yearMapping)) {
    const order = orderByColumn.get(column);
    if (order === undefined) {
      throw new ValidationError(
        `연차 대응에 연차 열이 아닌 열(${column})이 있습니다. 연차 열 매핑을 다시 확인하세요.`
      );
    }
    if (!projectYearIds.has(yearId)) {
      throw new RuleViolationError('이 과제에 속하지 않은 연차는 지정할 수 없습니다.');
    }
    const existing = yearIdByOrder[order];
    if (existing !== undefined && existing !== yearId) {
      throw new ValidationError(`${order + 1}차년도 열에 서로 다른 연차가 지정되었습니다.`);
    }
    // 같은 연차가 두 열에 걸리면 뒤 열이 앞 열을 덮어써 금액이 조용히 사라진다
    const already = orderByYearId.get(yearId);
    if (already !== undefined && already !== order) {
      throw new ValidationError(
        `같은 연차가 ${already + 1}차년도 열과 ${order + 1}차년도 열에 중복 지정되었습니다.`
      );
    }
    yearIdByOrder[order] = yearId;
    orderByYearId.set(yearId, order);
  }

  return yearIdByOrder;
}

/**
 * I-7: 사용자가 수동 지정한 매핑을 프로파일 저장용 별칭 후보로 모은다.
 * **I-6 모호 별칭(`연구장비·재료비` 등)의 선택은 학습하지 않는다** (§7.9.1 Step 4 명시) —
 * 그 라벨은 서식마다 다르게 쪼개져서, 한 번의 선택을 사전에 굳히면 다음 파일을 조용히 오분류한다.
 */
function collectLearnedAliases(parsed: ParseMatrixResult): Record<string, BudgetCategory> {
  const learned: Record<string, BudgetCategory> = {};
  for (const row of parsed.rows) {
    if (row.categorySource !== 'manual' || row.category === null) continue;
    if (row.classifications.some((c) => c.kind === 'ambiguous')) continue;
    const label = (row.matchedLabel ?? '').trim();
    if (label === '') continue;
    learned[label] = row.category;
  }
  return learned;
}

interface ImportPipelineResult {
  fileName: string;
  fileHash: string;
  sheetName: string;
  preview: ImportPreview;
  learnedAliases: Record<string, BudgetCategory>;
}

/**
 * previewImport와 commitImport가 **공유하는 유일한 파싱 경로**.
 * commitImport가 자체 파싱을 갖지 않는 이유가 §9의 명시 규칙이다 —
 * "미리보기에서 본 것과 반영되는 것이 다르면 안 된다".
 */
async function runImportPipeline(
  client: SupabaseClient,
  formData: FormData,
  draft: ParsedDraft,
  projectId: string,
  options: { requireFileHash: boolean }
): Promise<ImportPipelineResult> {
  const upload = await readUploadedWorkbook(formData);

  // §5.12.2: 미리보기와 다른 파일이 반영되는 것을 차단한다
  if (options.requireFileHash && draft.fileHash === '') {
    throw new ValidationError('미리보기를 먼저 실행해야 반영할 수 있습니다.');
  }
  if (draft.fileHash !== '' && draft.fileHash !== upload.fileHash) {
    throw new ValidationError(
      '미리보기에 사용한 파일과 다른 파일입니다. 파일을 다시 올리고 미리보기부터 진행하세요.'
    );
  }

  // parseMatrix는 행=비목 매트릭스 전용이다. 'column' 서식을 억지로 넣으면 라벨과 금액이
  // 통째로 어긋난 채 "성공"한다 — 조용히 틀리느니 거부한다 (실측 서식은 전부 'row'다, S-1)
  if (draft.profile.orientation !== 'row') {
    throw new RuleViolationError(
      '비목이 열에 있는 서식(전치 매트릭스)은 아직 반영할 수 없습니다. 비목이 행에 오도록 정리한 뒤 다시 올려주세요.'
    );
  }
  if (draft.profile.labelColumns.length === 0) {
    throw new ValidationError('라벨 열을 1개 이상 지정해야 합니다.');
  }
  if (draft.profile.yearColumnMappings.length === 0) {
    throw new ValidationError('연차 열을 1개 이상 지정해야 합니다.');
  }

  const sheet = pickSheet(upload.sheets, draft.profile.sheetName);

  const years = await yearsRepo.listYears(client, projectId);
  const yearIdByOrder = resolveYearMapping(draft, new Set(years.map((y) => y.id)));

  const parsed = parseMatrix(sheet, {
    labelColumns: draft.profile.labelColumns,
    yearColumns: draft.profile.yearColumnMappings,
    dataStartRow: draft.profile.dataStartRow,
    amountUnit: draft.profile.amountUnit,
    match: matchContextOf(draft.profile),
    skippedRowIndexes: draft.skippedRowIndexes,
    // JSON 왕복으로 문자열 키가 됐지만 런타임 조회(obj[number])는 동일하다
    manualCategoryByRow: draft.manualCategoryByRow as unknown as Record<number, BudgetCategory>,
  });

  const existingItems = await budgetItemsRepo.listBudgetItemsByProject(client, projectId);

  // S-5·§7.9.1 Step 5의 반영 가능 판정(blocked)은 buildPreview가 한다. 액션에서 다시 계산하지 않는다
  const preview = buildPreview({ rows: parsed.rows, yearIdByOrder, existingItems });

  return {
    fileName: upload.fileName,
    fileHash: upload.fileHash,
    sheetName: sheet.name,
    preview,
    learnedAliases: collectLearnedAliases(parsed),
  };
}

// ─── §9 inspectWorkbook ───────────────────────────────────────────────────────

/** 시트 목록 + 상위 30행 원본 그리드 + 추천 시트(S-13) + 구조 추정. 저장하는 것은 없다 */
export async function inspectWorkbook(
  formData: FormData
): Promise<ActionResult<InspectWorkbookResult>> {
  try {
    await requireApprovedUser();

    const upload = await readUploadedWorkbook(formData);
    const { recommended, scores } = recommendSheet(upload.sheets);

    const scoreByName = new Map(scores.map((s) => [s.name, s]));
    const sheets = upload.sheets.map((sheet) => {
      const score = scoreByName.get(sheet.name);
      let columnCount = 0;
      for (const row of sheet.cells) columnCount = Math.max(columnCount, row.length);
      return {
        name: sheet.name,
        categoryRows: score?.categoryRows ?? 0,
        nonEmptyRows: score?.nonEmptyRows ?? 0,
        yearHeaderCount: score?.yearHeaderCount ?? 0,
        score: score?.score ?? 0,
        eligible: score?.eligible ?? false,
        rowCount: sheet.cells.length,
        columnCount,
      };
    });

    const target = upload.sheets.find((sheet) => sheet.name === recommended) ?? null;

    return {
      ok: true,
      data: {
        fileName: upload.fileName,
        fileSize: upload.fileSize,
        fileHash: upload.fileHash,
        sheets,
        recommendedSheet: recommended,
        grids: upload.sheets.map((sheet) => toGridPreview(sheet)),
        structure: target ? detectStructure(target) : null,
      },
    };
  } catch (e) {
    return toActionFailure(e);
  }
}

// ─── §9 analyzeSheet ──────────────────────────────────────────────────────────

/** 헤더행·방향·라벨열·연차열·금액단위 추정. 전부 **제안**이고 확정은 사용자가 한다 (§6.8 대원칙) */
export async function analyzeSheet(
  formData: FormData,
  sheetName: string | null,
  hints?: unknown
): Promise<ActionResult<AnalyzeSheetResult>> {
  try {
    const name = parseOrThrow(z.string().max(200).nullable(), sheetName, '시트 이름이 올바르지 않습니다.');
    const parsedHints = parseOrThrow(analyzeHintsSchema, hints, '분석 힌트가 올바르지 않습니다.');
    await requireApprovedUser();

    const upload = await readUploadedWorkbook(formData);
    const sheet = pickSheet(upload.sheets, name);

    const context = matchContextOf({
      categoryAliases: parsedHints?.categoryAliases,
      ministry: parsedHints?.ministry,
      skipRowPatterns: parsedHints?.skipRowPatterns,
    });
    const structure = analyzeStructure(sheet, parsedHints ?? null, context);

    return {
      ok: true,
      data: {
        fileHash: upload.fileHash,
        structure,
        columns: describeColumns(sheet, structure),
        grid: toGridPreview(sheet),
      },
    };
  } catch (e) {
    return toActionFailure(e);
  }
}

// ─── §9 previewImport ─────────────────────────────────────────────────────────

/** 반영 예정 내역 + 요약 + fileHash. **저장하는 것은 없다** (§6.8 대원칙) */
export async function previewImport(
  formData: FormData,
  draft: unknown,
  projectId: string
): Promise<ActionResult<PreviewImportResult>> {
  try {
    const pid = parseOrThrow(uuidSchema, projectId, '과제 ID 형식이 올바르지 않습니다.');
    const parsedDraft = parseOrThrow(importDraftSchema, draft, '임포트 설정이 올바르지 않습니다.');
    const { client } = await requireApprovedUser();

    const result = await runImportPipeline(client, formData, parsedDraft, pid, {
      requireFileHash: false,
    });

    return {
      ok: true,
      data: {
        ...result.preview,
        fileHash: result.fileHash,
        fileName: result.fileName,
        sheetName: result.sheetName,
        learnedAliases: result.learnedAliases,
      },
    };
  } catch (e) {
    return toActionFailure(e);
  }
}

// ─── §9 commitImport ──────────────────────────────────────────────────────────

/**
 * 단일 RPC 트랜잭션(I-18) + 반영 직전 계획액 스냅샷(I-17).
 *
 * `profileId`는 §9 시그니처에 없지만 스냅샷 출처(`ImportSnapshotSource.profileId`)와
 * `markImportProfileUsed`가 요구한다. `ImportDraft`(§5.12.2)에 프로파일 id 필드가 없어
 * 선택 인자로 받는다 — 프로파일 없이 반영하면 null이다.
 */
export async function commitImport(
  formData: FormData,
  draft: unknown,
  projectId: string,
  profileId?: string | null
): Promise<ActionResult<CommitImportResult>> {
  try {
    const pid = parseOrThrow(uuidSchema, projectId, '과제 ID 형식이 올바르지 않습니다.');
    const parsedDraft = parseOrThrow(importDraftSchema, draft, '임포트 설정이 올바르지 않습니다.');
    const profile = parseOrThrow(
      uuidSchema.nullable(),
      profileId ?? null,
      '프로파일 ID 형식이 올바르지 않습니다.'
    );
    const { user, client } = await requireApprovedUser();

    // previewImport와 같은 경로. fileHash가 다르면 여기서 막힌다
    const result = await runImportPipeline(client, formData, parsedDraft, pid, {
      requireFileHash: true,
    });

    // §7.9.1 Step 5 / S-5: 오류 1건 또는 미대응 연차 열이 있으면 반영 불가.
    // 판정은 buildPreview의 blocked를 그대로 쓴다 (toCommitRows가 던진다)
    const rows = toCommitRows(result.preview);
    if (rows.length === 0) {
      // S-14로 전부 잠긴 경우를 "매핑을 확인하세요"로 안내하면 사용자가 없는 문제를 찾는다
      if (result.preview.summary.locked > 0) {
        throw new RuleViolationError(
          `반영할 내역이 없습니다 — 대상 ${result.preview.summary.locked}건이 모두 산출근거가 있는 셀입니다. 덮어쓰려면 연구비 화면에서 산출근거를 먼저 지우세요.`
        );
      }
      throw new RuleViolationError('반영할 내역이 없습니다. 비목 매핑과 연차 열 대응을 확인하세요.');
    }

    const committed = await snapshotsRepo.commitImport(client, pid, rows, {
      fileName: result.fileName,
      sheetName: result.sheetName,
      profileId: profile,
      fileHash: result.fileHash,
    });

    // 반영은 이미 커밋됐다 — 사용 이력 갱신 실패로 전체를 되돌릴 수 없다.
    // 조용히 삼키지 않고 로그 + 반환값에 드러낸다 (절대 규칙 5)
    let profileUsageRecorded = false;
    if (profile !== null) {
      try {
        await profilesRepo.markImportProfileUsed(client, profile, user.id);
        profileUsageRecorded = true;
      } catch (markError) {
        console.error('[actions/import] 프로파일 사용 이력 갱신 실패:', markError);
      }
    }

    revalidateImport(pid);
    return {
      ok: true,
      data: {
        snapshotId: committed.snapshotId,
        updated: committed.updated,
        // S-14. 미리보기의 summary.locked가 아니라 **RPC가 실제로 잠근 수**를 올린다 —
        // 미리보기 이후 다른 사람이 산출근거를 추가하면 두 값이 갈리고, 이때 맞는 쪽은 DB다
        locked: committed.locked,
        summary: result.preview.summary,
        profileUsageRecorded,
      },
    };
  } catch (e) {
    return toActionFailure(e);
  }
}

// ─── §7.14 ImportSnapshot 목록·복원 (I-17) ────────────────────────────────────

/**
 * 설정 화면(§7.14)의 스냅샷 목록. 최신순이고 **과제별** 최근 20개까지만 존재한다 —
 * 20개 창 유지는 commit_import RPC의 몫이라 여기서 자르지 않는다 (I-17).
 */
export async function listImportSnapshots(
  projectId: string
): Promise<ActionResult<ImportSnapshot[]>> {
  try {
    const pid = parseOrThrow(uuidSchema, projectId, '과제 ID 형식이 올바르지 않습니다.');
    const { client } = await requireApprovedUser();

    const snapshots = await snapshotsRepo.listImportSnapshots(client, pid);
    return { ok: true, data: snapshots };
  } catch (e) {
    return toActionFailure(e);
  }
}

/**
 * 스냅샷 시점의 계획액으로 되돌린다 (I-17·I-18 단일 RPC 트랜잭션).
 *
 * I-17: 복원은 **새 스냅샷을 만들지 않고**(복원분이 20개 창을 밀어내면 되돌릴 임포트 이력이
 * 사라진다) **행을 삭제하지도 않는다**(임포트 이후 그 비목에 붙은 집행 내역이 cascade로 사라진다).
 *
 * RPC는 snapshotId와 건수만 돌려주므로 revalidate 대상 과제를 알 수 없다 — 먼저 읽는다
 * (없으면 NotFoundError. deleteImportProfile과 같은 패턴).
 */
export async function restoreImportSnapshot(
  snapshotId: string
): Promise<ActionResult<ImportRestoreResult>> {
  try {
    const sid = parseOrThrow(uuidSchema, snapshotId, '스냅샷 ID 형식이 올바르지 않습니다.');
    const { client } = await requireApprovedUser();

    const snapshot = await snapshotsRepo.getImportSnapshotById(client, sid);
    const restored = await snapshotsRepo.restoreImportSnapshot(client, sid);

    revalidateImport(snapshot.projectId);
    return { ok: true, data: restored };
  } catch (e) {
    return toActionFailure(e);
  }
}

// ─── §9 ImportProfile CRUD (§5.12.1) ──────────────────────────────────────────

export async function listImportProfiles(
  kind: unknown,
  projectId: string | null
): Promise<ActionResult<ImportProfile[]>> {
  try {
    const parsedKind = parseOrThrow<ImportKind>(importKindSchema, kind, '임포트 종류가 올바르지 않습니다.');
    const pid = parseOrThrow(uuidSchema.nullable(), projectId, '과제 ID 형식이 올바르지 않습니다.');
    const { client } = await requireApprovedUser();

    const profiles = await profilesRepo.listImportProfiles(client, parsedKind, pid);
    return { ok: true, data: profiles };
  } catch (e) {
    return toActionFailure(e);
  }
}

export async function createImportProfile(input: unknown): Promise<ActionResult<ImportProfile>> {
  try {
    const fields = parseOrThrow(profileCreateSchema, input, '프로파일 정보가 올바르지 않습니다.');
    const { user, client } = await requireApprovedUser();

    const created = await profilesRepo.createImportProfile(client, {
      ...fields,
      createdBy: user.id,
      updatedBy: user.id,
    });

    revalidatePath('/settings');
    if (created.projectId) revalidatePath(`/projects/${created.projectId}/budget`);
    return { ok: true, data: created };
  } catch (e) {
    return toActionFailure(e);
  }
}

export async function updateImportProfile(
  id: string,
  patch: unknown,
  expectedVersion?: number
): Promise<ActionResult<ImportProfile>> {
  try {
    const pid = parseOrThrow(uuidSchema, id, '프로파일 ID 형식이 올바르지 않습니다.');
    const fields = parseOrThrow(profilePatchSchema, patch, '프로파일 정보가 올바르지 않습니다.');
    const { user, client } = await requireApprovedUser();

    const updated = await profilesRepo.updateImportProfile(
      client,
      pid,
      { ...fields, updatedBy: user.id },
      expectedVersion
    );

    revalidatePath('/settings');
    if (updated.projectId) revalidatePath(`/projects/${updated.projectId}/budget`);
    return { ok: true, data: updated };
  } catch (e) {
    return toActionFailure(e);
  }
}

export async function deleteImportProfile(id: string): Promise<ActionResult<null>> {
  try {
    const pid = parseOrThrow(uuidSchema, id, '프로파일 ID 형식이 올바르지 않습니다.');
    const { client } = await requireApprovedUser();

    // 삭제 후에는 projectId를 알 수 없으므로 먼저 읽는다 (없으면 NotFoundError)
    const profile = await profilesRepo.getImportProfileById(client, pid);
    await profilesRepo.removeImportProfile(client, pid);

    revalidatePath('/settings');
    if (profile.projectId) revalidatePath(`/projects/${profile.projectId}/budget`);
    return { ok: true, data: null };
  } catch (e) {
    return toActionFailure(e);
  }
}
