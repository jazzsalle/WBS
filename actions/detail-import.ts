'use server';

// 산출근거 시트 임포트 서버 액션 (SOT §9 Budget Detail Import, §6.11, §7.9.3, SA-1~SA-4)
//
// 총괄표 임포트(actions/import.ts)와 **같은 구조**다: 파싱은 lib/import의 순수 함수가 하고,
// SheetJS 읽기는 lib/import-adapter가 하며, 여기서는 인증·검증·과제 경계·리포지토리 호출만 한다.
// 규칙(D-3a 세목 확정·D-8a 조정액·D-15 셀 판정)을 여기서 다시 쓰면 반드시 어긋난다 (O-4).
//
// 핵심 불변식 (§9 주석):
//   previewDetailImport와 commitDetailImport는 **같은 파싱 경로**(runDetailPipeline)를 쓴다.
//   미리보기에서 본 것과 반영되는 것이 다르면 안 된다. fileHash 대조로 같은 파일임을 보장한다.
//
// PL-10a: `amount`는 lib/budget-plan.ts의 computeDetailAmount가 낸 값이다 —
//   buildDetailPreview가 이미 계산해 두므로 **이 파일에 산식 사본이 없다.**
// D-12: 미리보기는 Member를 만들지 않는다. 새 인력은 반영 시점에 RPC가 같은 트랜잭션에서 만든다.
// D-14: `members.annual_salary`를 고치는 경로가 여기에 없다 — 연봉 변경은 PL-10b의 별도 조작이다.
// D-20: 프로파일을 저장·조회하지 않는다.
//
// supabase 직접 호출 금지 — 반드시 lib/db/ 리포지토리를 거친다 (절대 규칙 3, §8.6).

import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import type { SupabaseClient } from '@supabase/supabase-js';
import type {
  ActionResult,
  CommitDetailImportResult,
  DetailSheetBlockInfo,
  DetailSheetInfo,
  InspectDetailSheetResult,
  PreviewDetailImportResult,
} from '@/types';
import { requireApprovedUser } from '@/lib/auth/guard';
import { RuleViolationError, ValidationError, toActionFailure } from '@/lib/db/errors';
import { budgetCategorySchema, detailAxisSchema } from '@/lib/db/schema';
import { BUDGET_CATEGORY_LABELS, BUDGET_CATEGORY_ORDER, SUBCATEGORY_PRESETS } from '@/lib/constants';
import * as budgetDetailsRepo from '@/lib/db/budget-details';
import * as membersRepo from '@/lib/db/members';
import * as orgsRepo from '@/lib/db/organizations';
import * as snapshotsRepo from '@/lib/db/import-snapshots';
import * as yearsRepo from '@/lib/db/years';
import {
  DETAIL_COLUMN_ROLES,
  allowsMultipleColumns,
  applyColumnRoleOverrides,
  buildDetailPreview,
  detailBlockKey,
  detectBlocks,
  detectSections,
  detailRowKey,
  indexToColumnLetter,
  parseDetailRows,
  parseYearOrderFromLabel,
  toDetailCommitRows,
} from '@/lib/import';
import type {
  DetailBlockInput,
  DetailColumnRole,
  DetailColumnRoleOverrides,
  DetailImportPreview,
  DetailMemberInput,
  ExistingDetailCell,
  RawSheet,
} from '@/lib/import';
import { readUploadedWorkbook, toGridPreview } from '@/lib/import-adapter';

// ─── 입력 검증 (§9: 모든 액션은 Zod로 입력 검증) ──────────────────────────────

const uuidSchema = z.uuid();

// D-11의 결정 3종. `create`는 **미리보기에서 만들지 않는다** — RPC의 p_new_members로만 간다 (D-12)
const memberDecisionSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('existing'), memberId: uuidSchema }),
  z.object({ kind: z.literal('create'), orgId: uuidSchema.nullable().optional() }),
  z.object({ kind: z.literal('skip') }),
]);

// §7.9.3 마법사의 진행 상태(DetailImportDraft). 파싱 결과를 바꾸는 결정이 전부 여기 담긴다.
// 프로파일 관련 필드가 하나도 없는 것이 §5.12.2 ImportDraft와의 차이다 (D-20).
// D-7: 컬럼 role 재지정. 열 인덱스는 JSON을 건너오며 문자열이 되므로 키를 숫자 문자열로 받는다.
// role 값은 파서의 목록(DETAIL_COLUMN_ROLES)만 허용한다 — 사전을 여기 다시 적으면 둘이 갈린다.
// `null`은 "역할 없음"이라 값으로 허용한다 (잘못 잡힌 role을 떼는 조작).
const columnRoleOverridesSchema = z.record(
  z.string().regex(/^\d+$/, '컬럼 역할 지정의 열 번호가 올바르지 않습니다.'),
  z.enum(DETAIL_COLUMN_ROLES).nullable()
);

const detailDraftSchema = z.object({
  yearId: uuidSchema,
  sheetName: z.string().max(200).nullable(),
  subcategoryChoices: z.record(z.string(), z.string().trim().min(1).max(60)).optional(),
  columnRoleOverrides: z.record(z.string(), columnRoleOverridesSchema).optional(),
  // D-9: 축 재지정. 키는 detailRowKey이고 값은 현금/현물뿐이다 — 축 없는 행은 없다(§5.17)
  axisOverrides: z.record(z.string(), detailAxisSchema).optional(),
  memberDecisions: z.record(z.string(), memberDecisionSchema).optional(),
  replaceCategories: z.array(budgetCategorySchema).optional(),
  confirmedCurrencyBlocks: z.array(z.string()).optional(),
  rowDecisions: z.record(z.string(), z.enum(['include', 'skip'])).optional(),
  // previewDetailImport 첫 호출에서는 비어 있다. commitDetailImport에서는 반드시 채워져 있어야 한다
  fileHash: z.string(),
});

type ParsedDetailDraft = z.infer<typeof detailDraftSchema>;

function parseOrThrow<T>(schema: z.ZodType<T>, value: unknown, fallback: string): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    throw new ValidationError(parsed.error.issues[0]?.message ?? fallback);
  }
  return parsed.data;
}

// ─── 공통 헬퍼 ────────────────────────────────────────────────────────────────

/**
 * D-1 거부 문구. 총괄표를 여기 넣는 것이 가장 흔한 오조작이고, 그때 필요한 것은
 * "안 됩니다"가 아니라 **어디로 가야 하는지**다 (§7.9.3 Step 2).
 */
const NOT_A_DETAIL_SHEET =
  '산출근거 시트가 아닙니다 — `1. 직접비 소요명세` 섹션을 찾지 못했습니다. 총괄표는 [엑셀 가져오기](§7.9.1)로 넣으세요.';

// 산출근거 반영은 budget_details와 budget_items를 함께 바꾼다 — 총괄표 임포트와 같은 범위다
function revalidateDetailImport(projectId: string): void {
  revalidatePath('/');
  revalidatePath(`/projects/${projectId}`);
  revalidatePath(`/projects/${projectId}/budget`);
  revalidatePath('/settings');
}

// actions/import.ts의 pickSheet와 같은 규약이다. 'use server' 파일은 export가 전부 서버 액션이어야
// 해서 두 액션 파일이 동기 헬퍼를 공유할 수 없다 — 문구까지 같게 두어 동작이 갈리지 않게 한다
function pickSheet(sheets: readonly RawSheet[], sheetName: string | null): RawSheet {
  if (sheets.length === 0) throw new ValidationError('워크북에 시트가 없습니다.');
  if (sheetName === null || sheetName === '') return sheets[0]!;
  const found = sheets.find((sheet) => sheet.name === sheetName);
  if (!found) {
    throw new ValidationError(`'${sheetName}' 시트를 찾을 수 없습니다. 다른 파일을 올렸는지 확인하세요.`);
  }
  return found;
}

/**
 * D-19: 시트명의 `N차년도` → `order = N-1`. **제안일 뿐이다.**
 *
 * 실측 시트명은 `1차년도_250520`·`1단계_2차년도_250604`처럼 접미가 붙는데
 * `parseYearOrderFromLabel`(S-5)은 라벨 **전체**가 `N차년도`일 때만 매칭한다. 그래서 구분자로
 * 쪼개 훑는다 — 패턴을 여기서 다시 적으면 S-5와 두 사전이 갈린다. `1단계`는 매칭되지 않는다.
 */
function suggestYearOrder(sheetName: string): number | null {
  for (const token of sheetName.split(/[^0-9A-Za-z가-힣]+/)) {
    const order = parseYearOrderFromLabel(token);
    if (order !== null) return order;
  }
  return null;
}

function columnCountOf(sheet: RawSheet): number {
  let width = 0;
  for (const row of sheet.cells) width = Math.max(width, row.length);
  return width;
}

/**
 * D-2·D-3·D-4·D-7 감지 + D-5·D-8~D-10·D-21 행 변환. 미리보기 조립의 입력 형태로 묶는다.
 *
 * D-7 재지정은 **행을 읽기 전에** 적용한다 — 열 role이 금액·성명·인자를 어디서 읽을지 정하므로
 * 나중에 덮으면 이미 읽은 값이 그대로 남는다. 블록 키(`detailBlockKey`)는 좌표로만 만들어져
 * role 재지정에 흔들리지 않으므로 감지 결과에서 그대로 찾을 수 있다.
 */
function parseBlocks(
  sheet: RawSheet,
  columnRoleOverrides?: Readonly<Record<string, DetailColumnRoleOverrides>>
): DetailBlockInput[] {
  return detectBlocks(sheet, detectSections(sheet)).map((detected) => {
    const block = applyColumnRoleOverrides(detected, columnRoleOverrides?.[detailBlockKey(detected)]);
    return { block, ...parseDetailRows(sheet, block) };
  });
}

function toBlockInfo(entry: DetailBlockInput): DetailSheetBlockInfo {
  return {
    key: detailBlockKey(entry.block),
    block: entry.block,
    rowCount: entry.rows.length,
    skipSuggestedCount: entry.rows.filter((row) => row.status === 'skip-suggested').length,
    fileAmount: entry.rows.reduce((sum, row) => sum + row.fileAmount, 0),
    subtotalCount: entry.subtotals.length,
    currency: entry.currency,
  };
}

/**
 * 사용자가 고른 세목이 그 블록의 비목에 실제로 있는 코드인지(PL-D4), 컬럼 역할 재지정이
 * 실재하는 표·열을 가리키는지(D-7), 축 재지정이 바꿀 수 있는 행을 가리키는지(D-9) 본다.
 *
 * 검증하지 않으면 엉뚱한 코드가 RPC까지 내려가 DB 제약 위반으로 튕기고, 사용자는
 * 내부 정보가 섞인 메시지를 보게 된다 (SA-4). 없는 블록 키도 거부한다 — 그 선택은
 * 조용히 무시되어 **사용자가 고르지 않은 세목**으로 반영되기 때문이다.
 */
function validateBlockChoices(draft: ParsedDetailDraft, blocks: readonly DetailBlockInput[]): void {
  const blockByKey = new Map(blocks.map((entry) => [detailBlockKey(entry.block), entry.block]));

  for (const [key, code] of Object.entries(draft.subcategoryChoices ?? {})) {
    const category = blockByKey.get(key)?.category;
    if (category === undefined) {
      throw new ValidationError(
        '세목 선택이 이 시트에서 감지한 표와 맞지 않습니다. 시트를 바꿨다면 미리보기부터 다시 진행하세요.'
      );
    }
    if (!SUBCATEGORY_PRESETS[category].some((preset) => preset.code === code)) {
      throw new ValidationError(
        `'${code}'는 ${BUDGET_CATEGORY_LABELS[category]}의 세목이 아닙니다. 세목을 다시 고르세요.`
      );
    }
  }

  // D-9 축 재지정. 모르는 행 키는 **거부**한다 — 조용히 버리면 사용자는 현물로 바꿨다고 믿는데
  // 파일은 현금 그대로 반영된다(D-7에서 겪은 "조용한 무동작"이 그대로 재현된다).
  // `axisSuggested`가 아닌 행도 거부한다: 현금·현물 열에 값이 둘 다 있어 갈린 행은 파일이 축을
  // 명시한 것이라 바꿀 대상이 아니고, 바꾸면 두 행이 한 축으로 겹친다 (D-9)
  if (Object.keys(draft.axisOverrides ?? {}).length > 0) {
    const rowByKey = new Map(
      blocks.flatMap((entry) => entry.rows.map((row) => [detailRowKey(row), row] as const))
    );
    for (const key of Object.keys(draft.axisOverrides ?? {})) {
      const row = rowByKey.get(key);
      if (row === undefined) {
        throw new ValidationError(
          '축 지정이 이 시트에서 감지한 행과 맞지 않습니다. 시트를 바꿨다면 미리보기부터 다시 진행하세요.'
        );
      }
      if (!row.axisSuggested) {
        throw new ValidationError(
          `${row.row + 1}행은 파일에 현금·현물이 명시되어 있어 축을 바꿀 수 없습니다. 합계 열만 있는 행만 축을 고를 수 있습니다 (D-9).`
        );
      }
    }
  }

  for (const key of draft.confirmedCurrencyBlocks ?? []) {
    if (!blockByKey.has(key)) {
      throw new ValidationError(
        '통화 확인이 이 시트에서 감지한 표와 맞지 않습니다. 시트를 바꿨다면 미리보기부터 다시 진행하세요.'
      );
    }
  }

  // D-7 재지정. 모르는 블록 키·없는 열은 **거부**한다 — 조용히 버리면 사용자는 역할을 고쳤다고
  // 믿는데 파일은 옛 매핑 그대로 반영된다(D-7이 막으려는 상황이 그대로 재현된다)
  for (const [key, overrides] of Object.entries(draft.columnRoleOverrides ?? {})) {
    const block = blockByKey.get(key);
    if (block === undefined) {
      throw new ValidationError(
        '컬럼 역할 지정이 이 시트에서 감지한 표와 맞지 않습니다. 시트를 바꿨다면 미리보기부터 다시 진행하세요.'
      );
    }

    const columnsByRole = new Map<DetailColumnRole, string[]>();
    for (const [rawIndex, role] of Object.entries(overrides)) {
      const index = Number(rawIndex);
      const column = block.columns.find((candidate) => candidate.index === index);
      if (column === undefined) {
        throw new ValidationError(
          `이 표에 없는 열에 역할을 지정했습니다 (${indexToColumnLetter(index)}열). 컬럼 매핑을 다시 확인하세요.`
        );
      }
      // 인자(수량·회·월)는 여러 열이 정상이라 겹침을 세지 않는다 (PL-3)
      if (role === null || allowsMultipleColumns(role)) continue;
      const letters = columnsByRole.get(role) ?? [];
      letters.push(column.column);
      columnsByRole.set(role, letters);
    }

    for (const letters of columnsByRole.values()) {
      if (letters.length > 1) {
        // 앱이 대신 고르면 금액·성명을 엉뚱한 열에서 읽는다. 어느 열이 맞는지는 사용자가 안다
        throw new ValidationError(
          `${letters.join('·')}열에 같은 역할을 겹쳐 지정했습니다. 한 열만 남기세요 — 인자(수량·회·월) 외의 역할은 표마다 열 하나입니다.`
        );
      }
    }
  }
}

/**
 * D-13 표시용 기관명을 붙인 명부. `listAllMembers`는 전 과제를 읽으므로 쓰지 않는다 —
 * 과제 경계를 넘는 인력이 후보로 뜨면 남의 과제 사람에게 금액이 붙는다 (N-13).
 */
async function loadRoster(client: SupabaseClient, projectId: string): Promise<DetailMemberInput[]> {
  const [members, organizations] = await Promise.all([
    membersRepo.listMembers(client, projectId),
    orgsRepo.listOrganizations(client, projectId),
  ]);
  const nameByOrgId = new Map(organizations.map((org) => [org.id, org.name]));

  return members.map((member) => ({
    id: member.id,
    name: member.name,
    position: member.position,
    annualSalary: member.annualSalary,
    orgId: member.orgId,
    orgName: member.orgId === null ? null : (nameByOrgId.get(member.orgId) ?? null),
  }));
}

/** D-15: 그 연차의 (비목별) 기존 산출근거 행 수. 셀 판정의 근거다 */
async function loadExistingCells(
  client: SupabaseClient,
  yearId: string
): Promise<ExistingDetailCell[]> {
  const counts = await budgetDetailsRepo.fetchDetailCountsByYearIds(client, [yearId]);
  const cells: ExistingDetailCell[] = [];
  for (const category of BUDGET_CATEGORY_ORDER) {
    const rowCount = counts.get(budgetDetailsRepo.detailCountKey(yearId, category)) ?? 0;
    if (rowCount > 0) cells.push({ category, rowCount });
  }
  return cells;
}

interface DetailPipelineResult {
  fileName: string;
  fileHash: string;
  sheetName: string;
  projectId: string;
  preview: DetailImportPreview;
}

/**
 * previewDetailImport와 commitDetailImport가 **공유하는 유일한 파싱 경로**.
 * commitDetailImport가 자체 파싱을 갖지 않는 이유가 §9의 명시 규칙이다 —
 * "결정론적으로 같은 결과를 내야 한다 — 같은 파이프라인 하나만 쓴다".
 *
 * 여기서 하는 일은 넷뿐이다: 파일 대조(§5.12.2) → 시트 파싱(D-1~D-10·D-21) →
 * 명부·기존 셀 읽기 → buildDetailPreview 호출. 판정은 전부 lib/import가 한다.
 */
async function runDetailPipeline(
  client: SupabaseClient,
  formData: FormData,
  draft: ParsedDetailDraft,
  options: { requireFileHash: boolean }
): Promise<DetailPipelineResult> {
  const upload = await readUploadedWorkbook(formData); // I-13·I-14·I-15는 어댑터가 지킨다

  // §5.12.2: 미리보기와 다른 파일이 반영되는 것을 차단한다 (총괄표와 같은 규약)
  if (options.requireFileHash && draft.fileHash === '') {
    throw new ValidationError('미리보기를 먼저 실행해야 반영할 수 있습니다.');
  }
  if (draft.fileHash !== '' && draft.fileHash !== upload.fileHash) {
    throw new ValidationError(
      '미리보기에 사용한 파일과 다른 파일입니다. 파일을 다시 올리고 미리보기부터 진행하세요.'
    );
  }

  const sheet = pickSheet(upload.sheets, draft.sheetName);
  // D-1: 섹션이 없으면 산출근거 시트가 아니다. 총괄표를 여기서 읽으면 §6.8과 같은 금액을 두 번 계상한다
  if (detectSections(sheet).length === 0) throw new RuleViolationError(NOT_A_DETAIL_SHEET);

  const blocks = parseBlocks(sheet, draft.columnRoleOverrides);
  validateBlockChoices(draft, blocks);

  // D-19: 시트 하나 = 연차 하나. 과제는 연차에서 파생된다 — 없으면 NotFoundError
  const year = await yearsRepo.getYearById(client, draft.yearId);
  const [members, existingCells] = await Promise.all([
    loadRoster(client, year.projectId),
    loadExistingCells(client, draft.yearId),
  ]);

  // D-3a 세목 확정 · D-8a 조정액 확정 · D-15 셀 판정 · D-18 소계 대조가 전부 여기서 일어난다.
  // 액션은 명부를 넘길 뿐 금액을 계산하지 않는다 (PL-10a)
  const preview = buildDetailPreview({
    yearId: draft.yearId,
    blocks,
    members,
    existingCells,
    memberDecisions: draft.memberDecisions,
    subcategoryChoices: draft.subcategoryChoices,
    axisOverrides: draft.axisOverrides,
    replaceCategories: draft.replaceCategories,
    confirmedCurrencyBlocks: draft.confirmedCurrencyBlocks,
    rowDecisions: draft.rowDecisions,
  });

  return {
    fileName: upload.fileName,
    fileHash: upload.fileHash,
    sheetName: sheet.name,
    projectId: year.projectId,
    preview,
  };
}

// ─── §9 inspectDetailSheet ────────────────────────────────────────────────────

/**
 * 시트 목록 + 원본 그리드 + 섹션·비목·세목 트리 + 컬럼 매핑 (D-1~D-7). **저장하는 것은 없다.**
 *
 * 트리는 섹션이 있는 시트마다 미리 만들어 둔다 — §7.9.3 Step 2에서 시트 탭을 옮길 때마다
 * 파일을 다시 올리게 하지 않으려는 것이다(§9 시그니처에 sheetName이 없는 이유이기도 하다).
 *
 * 섹션이 있는 시트가 하나도 없으면 **명시적으로 거부**한다 (D-1).
 */
export async function inspectDetailSheet(
  formData: FormData
): Promise<ActionResult<InspectDetailSheetResult>> {
  try {
    await requireApprovedUser();

    const upload = await readUploadedWorkbook(formData);

    const sheets: DetailSheetInfo[] = upload.sheets.map((sheet) => {
      const sections = detectSections(sheet);
      const eligible = sections.length > 0;
      return {
        name: sheet.name,
        rowCount: sheet.cells.length,
        columnCount: columnCountOf(sheet),
        eligible,
        sections,
        // D-19: 제안일 뿐이다. 대상 연차는 사용자가 지정한다
        suggestedYearOrder: suggestYearOrder(sheet.name),
        blocks: eligible ? parseBlocks(sheet).map(toBlockInfo) : [],
      };
    });

    if (!sheets.some((sheet) => sheet.eligible)) throw new RuleViolationError(NOT_A_DETAIL_SHEET);

    // 직접비 섹션이 있는 시트를 먼저 본다 (§7.9.3 Step 2). 하이라이트일 뿐 확정은 사용자가 한다
    const recommended =
      sheets.find((sheet) => sheet.sections.some((section) => section.kind === 'direct')) ??
      sheets.find((sheet) => sheet.eligible);

    return {
      ok: true,
      data: {
        fileName: upload.fileName,
        fileSize: upload.fileSize,
        fileHash: upload.fileHash,
        sheets,
        recommendedSheet: recommended?.name ?? null,
        grids: upload.sheets.map((sheet) => toGridPreview(sheet)),
      },
    };
  } catch (e) {
    return toActionFailure(e);
  }
}

// ─── §9 previewDetailImport ───────────────────────────────────────────────────

/**
 * 행 초안 + 성명 매칭 + 조정액 흡수 + 소계 대조 + 셀 충돌 (§7.9.3 Step 3·4).
 *
 * **저장하는 것은 없다** (§6.11 대원칙). 특히 D-12: 새 인력을 여기서 만들지 않는다 —
 * 반영을 취소했는데 인력 명부만 더러워지면 안 된다. 리포지토리 호출은 전부 읽기다.
 */
export async function previewDetailImport(
  formData: FormData,
  draft: unknown
): Promise<ActionResult<PreviewDetailImportResult>> {
  try {
    const parsedDraft = parseOrThrow(detailDraftSchema, draft, '임포트 설정이 올바르지 않습니다.');
    const { client } = await requireApprovedUser();

    const result = await runDetailPipeline(client, formData, parsedDraft, {
      requireFileHash: false,
    });

    return {
      ok: true,
      data: {
        ...result.preview,
        fileHash: result.fileHash,
        fileName: result.fileName,
        sheetName: result.sheetName,
        projectId: result.projectId,
      },
    };
  } catch (e) {
    return toActionFailure(e);
  }
}

// ─── §9 commitDetailImport ────────────────────────────────────────────────────

/**
 * 새 Member 생성(D-12)·셀 교체(D-15)·행 삽입·`budget_items` 재계산(PL-10)·스냅샷(D-17)이
 * **한 트랜잭션**이다 (D-16). 액션은 미리보기 결과를 RPC 페이로드로 옮기기만 한다.
 *
 * D-20: 프로파일을 저장하지 않으므로 출처에 profileId가 없다 (RPC가 null로 둔다).
 */
export async function commitDetailImport(
  formData: FormData,
  draft: unknown
): Promise<ActionResult<CommitDetailImportResult>> {
  try {
    const parsedDraft = parseOrThrow(detailDraftSchema, draft, '임포트 설정이 올바르지 않습니다.');
    const { client } = await requireApprovedUser();

    // previewDetailImport와 같은 경로. fileHash가 다르면 여기서 막힌다
    const result = await runDetailPipeline(client, formData, parsedDraft, {
      requireFileHash: true,
    });

    // 오류 판정(blocked)은 buildDetailPreview가 이미 했다 — toDetailCommitRows가 그대로 던진다
    const payload = toDetailCommitRows(result.preview);
    if (payload.rows.length === 0) {
      // D-15로 전부 잠긴 경우를 "세목을 확인하세요"로 안내하면 사용자가 없는 문제를 찾는다
      const skippedCells = result.preview.cells.filter((cell) => cell.status === 'skipped').length;
      if (skippedCells > 0) {
        throw new RuleViolationError(
          `반영할 내역이 없습니다 — 대상 ${skippedCells}개 비목에 기존 산출근거가 있습니다. 덮어쓰려면 [기존 삭제 후 교체]를 고르세요.`
        );
      }
      throw new RuleViolationError(
        '반영할 내역이 없습니다. 세목·성명 지정과 건너뜀 설정을 확인하세요.'
      );
    }

    const committed = await snapshotsRepo.commitDetailImport(
      client,
      result.projectId,
      payload.yearId,
      payload.newMembers,
      payload.rows,
      payload.replaceCategories,
      { fileName: result.fileName, sheetName: result.sheetName, fileHash: result.fileHash }
    );

    revalidateDetailImport(result.projectId);
    return {
      ok: true,
      data: {
        snapshotId: committed.snapshotId,
        inserted: committed.inserted,
        deleted: committed.deleted,
        membersCreated: committed.membersCreated,
        cells: committed.cells,
        // D-15a. 미리보기 시점이 아니라 **RPC가 실제로 건너뛴 셀 수**다 — 미리보기 이후 다른
        // 사람이 산출근거를 추가하면 두 값이 갈리고, 이때 맞는 쪽은 DB다
        skippedLocked: committed.skippedLocked,
        summary: result.preview.summary,
      },
    };
  } catch (e) {
    return toActionFailure(e);
  }
}

// D-20: ImportProfile을 저장·조회하는 액션이 여기 없는 것은 누락이 아니다.
// 산출근거는 컬럼 헤더 텍스트로 매핑하므로(D-7) 저장할 재사용 가능한 결정이 사실상 없다.
// 스냅샷 목록·복원은 총괄표와 같은 통로(actions/import.ts)를 쓴다 — D-17a가 스냅샷 종류를
// `details` 키로 가르므로 복원 액션을 따로 둘 이유가 없다.
