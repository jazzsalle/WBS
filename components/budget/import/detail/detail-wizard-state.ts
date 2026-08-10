// 산출근거 임포트 마법사의 공유 상태·헬퍼 (SOT §7.9.3, §6.11, DetailImportDraft)
//
// 순수 모듈이다. 서버 액션을 부르지 않고 파싱도 하지 않는다 — 파싱은 전부
// actions/detail-import.ts가 하고 여기서는 그 결과를 담을 그릇과 사용자의 결정만 다룬다 (I-13).
//
// 총괄표 마법사의 `wizard-state.ts`와 같은 자리이며, 업로드 규약·연차 목록처럼 두 흐름이
// **정말 같은 값**은 그쪽에서 가져다 쓴다 — 사전이 둘로 갈리면 반드시 어긋난다.
// 반대로 확장자 목록은 흐름마다 다르다(아래 주석).
//
// 판정(needsConfirm·세목 확정·소계 대조)은 여기서 다시 하지 않는다. 서버가 내린 값을 화면에
// 옮길 뿐이다 — 같은 규칙이 두 곳에 생기면 반드시 어긋난다 (O-4).

import type {
  BudgetCategory,
  DetailAxis,
  DetailImportDraft,
  DetailMemberDecision,
  DetailRowDecision,
  DetailSheetBlockInfo,
  DetailSheetInfo,
  InspectDetailSheetResult,
} from '@/types';
// types/index.ts가 재수출하지 않는 파서 타입들. **타입 전용 import라 번들에 남지 않는다** (I-13)
import type {
  DetailBlockIssue,
  DetailColumn,
  DetailColumnRole,
  DetailSectionKind,
  SubcategoryResolution,
} from '@/lib/import';
import { SUBCATEGORY_PRESETS } from '@/lib/constants';
import { MAX_UPLOAD_BYTES, formatBytes, type WizardYear } from '../wizard-state';

export { buildFormData, formatBytes, toWizardYears } from '../wizard-state';
export type { Failure, WizardYear } from '../wizard-state';

// ─── 업로드 규약 ─────────────────────────────────────────────
//
// 크기 상한(I-15 10MB)은 총괄표와 같으므로 `wizard-state.ts`의 값을 그대로 쓴다.

/**
 * §7.9.3 Step 1 허용 확장자. **csv가 없는 것이 총괄표와의 차이다** —
 * 산출근거 파싱은 병합 셀(S-11·D-25)과 백분율 표시 서식(D-22)을 읽어야 하는데
 * csv에는 그 정보가 없어 참여율이 1/100이 되거나 행이 두 배로 세어진다.
 */
export const DETAIL_ACCEPTED_EXTENSIONS = ['.xlsx', '.xlsm', '.xls'] as const;

export const DETAIL_ACCEPT_ATTRIBUTE = DETAIL_ACCEPTED_EXTENSIONS.join(',');

/** 업로드 **전** 거부 사유. 통과하면 null (§7.9.3 Step 1) */
export function detailRejectReason(file: File): string | null {
  const lower = file.name.toLowerCase();
  if (!DETAIL_ACCEPTED_EXTENSIONS.some((ext) => lower.endsWith(ext))) {
    return `지원하지 않는 파일 형식입니다. ${DETAIL_ACCEPTED_EXTENSIONS.join(', ')} 파일만 올릴 수 있습니다.`;
  }
  if (file.size > MAX_UPLOAD_BYTES) {
    return `파일이 ${formatBytes(file.size)}로 상한 10MB를 넘습니다. 필요한 시트만 남겨서 다시 올려주세요.`;
  }
  if (file.size === 0) return '빈 파일입니다.';
  return null;
}

// ─── 마법사 단계 ─────────────────────────────────────────────

export type DetailWizardStep = 1 | 2 | 3 | 4;

export const DETAIL_STEP_TITLES: Record<DetailWizardStep, string> = {
  1: '파일 · 연차',
  2: '시트 · 구조',
  3: '성명 매핑',
  4: '미리보기 & 반영',
};

/**
 * D-1 거부 안내. `actions/detail-import.ts`의 같은 문구다 —
 * `'use server'` 파일은 export가 전부 서버 액션이어야 해서 상수를 공유할 수 없다.
 * 총괄표를 여기 넣는 것이 가장 흔한 오조작이고, 그때 필요한 것은 "안 됩니다"가 아니라
 * **어디로 가야 하는지**다 (§7.9.3 Step 2).
 */
export const NOT_A_DETAIL_SHEET_GUIDE =
  '산출근거 시트가 아닙니다 — `1. 직접비 소요명세` 섹션을 찾지 못했습니다. 총괄표는 [엑셀 가져오기](§7.9.1)로 넣으세요.';

// ─── DetailImportDraft ───────────────────────────────────────

/**
 * 마법사 시작 상태.
 *
 * `yearId`는 **빈 문자열**로 시작한다 — 대상 연차는 사용자가 Step 1에서 확정하며(D-19),
 * 그 전에는 고른 연차가 없다. `fileHash`가 미리보기 전에 빈 문자열인 것과 같은 규약이다
 * (§5.12.2). 액션에 넘기기 전에 `isYearChosen`으로 막는다 — 서버 Zod도 uuid로 다시 막는다.
 */
export function initialDetailDraft(): DetailImportDraft {
  return {
    yearId: '',
    sheetName: null,
    subcategoryChoices: {},
    columnRoleOverrides: {},
    axisOverrides: {},
    memberDecisions: {},
    replaceCategories: [],
    confirmedCurrencyBlocks: [],
    rowDecisions: {},
    fileHash: '',
  };
}

export function isYearChosen(draft: DetailImportDraft): boolean {
  return draft.yearId !== '';
}

export function withYear(draft: DetailImportDraft, yearId: string): DetailImportDraft {
  return { ...draft, yearId };
}

/**
 * 시트를 바꾸면 **시트에서 파생된 결정을 전부 버린다.**
 *
 * 세목·통화 확인의 키는 그 시트의 블록 좌표이고(`detailBlockKey`), 행 결정은 시트 행 번호이며
 * (`detailRowKey`), 성명 결정도 그 시트의 인건비 표에서 나온 이름이다. 남겨 두면 다른 시트의
 * 엉뚱한 표에 붙거나(사용자가 고르지 않은 세목으로 반영된다) 서버 검증에 걸린다.
 * 컬럼 role 재지정(D-7)도 같다 — 열 인덱스는 그 시트 그 표의 좌표다.
 * 축 재지정(D-9)의 키도 시트 행 번호다.
 */
export function withSheet(draft: DetailImportDraft, sheetName: string | null): DetailImportDraft {
  return {
    ...draft,
    sheetName,
    subcategoryChoices: {},
    columnRoleOverrides: {},
    axisOverrides: {},
    memberDecisions: {},
    replaceCategories: [],
    confirmedCurrencyBlocks: [],
    rowDecisions: {},
  };
}

/** D-3·D-3a 세목 선택. null이면 파서의 판정으로 되돌린다 */
export function withSubcategoryChoice(
  draft: DetailImportDraft,
  blockKey: string,
  code: string | null
): DetailImportDraft {
  const choices = { ...(draft.subcategoryChoices ?? {}) };
  if (code === null) delete choices[blockKey];
  else choices[blockKey] = code;
  return { ...draft, subcategoryChoices: choices };
}

/**
 * D-7 컬럼 role 재지정.
 *
 * `role`의 세 값이 각각 다른 뜻이다: role이면 그 역할로 덮고, `null`이면 **역할을 없애며**,
 * `undefined`면 재지정을 지워 **파서의 자동 감지로 되돌린다**(세목 선택의 null과 같은 자리).
 * 자동 감지와 같은 값을 고른 것은 재지정이 아니므로 화면이 `undefined`로 넘긴다 — 그래야
 * "사용자가 바꾼 것"만 파랑으로 남는다 (§7.9.1 Step 3 관례).
 *
 * **그 표의 축 재지정(D-9)을 함께 버린다.** 열 역할이 금액을 어디서 읽을지 정하므로, 역할이
 * 바뀌면 그 표에서 나온 행이 갈리거나 합쳐지고 `axisSuggested`도 뒤집힌다. 남겨 두면 Step 4에서
 * 고른 축이 이제 축을 바꿀 수 없는 행(`axisSuggested = false`)을 가리키게 되어 서버가 매
 * 미리보기마다 거부하는데, 그 행에는 셀렉트가 없어 화면에서 지울 통로가 없다 — 사용자가 갇힌다.
 *
 * `blocks`는 Step 2가 보고 있는 시트의 블록들이다. 축 재지정의 키(`detailRowKey`)에는 블록
 * 정보가 없어 **행 번호를 블록의 데이터 행 범위와 맞춰** 가려낸다.
 */
export function withColumnRoleOverride(
  draft: DetailImportDraft,
  blockKey: string,
  columnIndex: number,
  role: DetailColumnRole | null | undefined,
  blocks: readonly DetailSheetBlockInfo[]
): DetailImportDraft {
  const all = { ...(draft.columnRoleOverrides ?? {}) };
  const forBlock = { ...(all[blockKey] ?? {}) };
  const had = Object.prototype.hasOwnProperty.call(forBlock, columnIndex);
  // 같은 값을 다시 고른 것은 바꾼 것이 아니다 — 멀쩡한 축 재지정을 공짜로 버리지 않는다
  if (role === undefined ? !had : had && forBlock[columnIndex] === role) return draft;

  if (role === undefined) delete forBlock[columnIndex];
  else forBlock[columnIndex] = role;
  if (Object.keys(forBlock).length === 0) delete all[blockKey];
  else all[blockKey] = forBlock;

  return {
    ...draft,
    columnRoleOverrides: all,
    axisOverrides: axisOverridesOutsideBlock(draft.axisOverrides ?? {}, blockKey, blocks),
  };
}

/**
 * 그 블록의 데이터 행에서 나온 축 재지정만 걷어낸다.
 *
 * 블록을 찾지 못했거나 행 번호를 읽지 못한 키는 **버린다.** 어느 블록에 속하는지 모르는 재지정은
 * 앞으로도 어떤 열 역할 변경으로도 지워지지 않아 그대로 갇히기 때문이다 — 과하게 비우는 쪽이
 * 조용히 갇히는 것보다 낫다 (사용자는 Step 4에서 다시 고를 수 있다).
 */
function axisOverridesOutsideBlock(
  overrides: Readonly<Record<string, DetailAxis>>,
  blockKey: string,
  blocks: readonly DetailSheetBlockInfo[]
): Record<string, DetailAxis> {
  const block = blocks.find((info) => info.key === blockKey)?.block;
  if (block === undefined) return {};

  const kept: Record<string, DetailAxis> = {};
  for (const [key, axis] of Object.entries(overrides)) {
    // `detailRowKey` = `${row}:${axisIndex}` — 앞쪽이 0-based 시트 행이다
    const row = Number.parseInt(key.split(':')[0] ?? '', 10);
    if (!Number.isInteger(row)) continue;
    if (row >= block.dataStartRow && row <= block.dataEndRow) continue;
    kept[key] = axis;
  }
  return kept;
}

export function columnRoleOverridesOf(
  draft: DetailImportDraft,
  blockKey: string
): Readonly<Record<number, DetailColumnRole | null>> {
  return (draft.columnRoleOverrides ?? {})[blockKey] ?? {};
}

/**
 * 화면에 표시할 역할 — 사용자 지정이 자동 감지보다 앞선다 (D-7).
 * `overridden`이 자동/수동 시각 구분의 근거다.
 */
export function effectiveColumnRole(
  column: DetailColumn,
  overrides: Readonly<Record<number, DetailColumnRole | null>>
): { role: DetailColumnRole | null; overridden: boolean } {
  if (!Object.prototype.hasOwnProperty.call(overrides, column.index)) {
    return { role: column.role, overridden: false };
  }
  return { role: overrides[column.index] ?? null, overridden: true };
}

/**
 * D-9 축 재지정.
 *
 * `axis`가 `undefined`면 재지정을 지워 **파서의 제안(현금)으로 되돌린다** — 세목 선택의 null,
 * 컬럼 role의 undefined와 같은 자리다. 자동 제안과 같은 값을 고른 것은 재지정이 아니므로
 * 화면이 `undefined`로 넘긴다. 그래야 "사용자가 바꾼 것"만 파랑으로 남는다 (§7.9.1 Step 3 관례).
 *
 * **대상은 `axisSuggested`인 행뿐이다.** 현금·현물 열에 값이 둘 다 있어 행이 갈린 경우(D-9)는
 * 파일이 축을 명시한 것이라 바꿀 이유가 없고, 바꾸면 같은 시트 행에서 나온 두 행이 한 축으로
 * 겹친다. 화면이 그런 행에 셀렉트를 두지 않고 서버도 거부한다.
 */
export function withAxisOverride(
  draft: DetailImportDraft,
  rowKey: string,
  axis: DetailAxis | undefined
): DetailImportDraft {
  const overrides = { ...(draft.axisOverrides ?? {}) };
  if (axis === undefined) delete overrides[rowKey];
  else overrides[rowKey] = axis;
  return { ...draft, axisOverrides: overrides };
}

/** D-10 통화 확인. 확인하지 않은 블록은 반영 대상에서 빠진다 */
export function withCurrencyConfirmed(
  draft: DetailImportDraft,
  blockKey: string,
  confirmed: boolean
): DetailImportDraft {
  const current = draft.confirmedCurrencyBlocks ?? [];
  if (confirmed) {
    return current.includes(blockKey)
      ? draft
      : { ...draft, confirmedCurrencyBlocks: [...current, blockKey] };
  }
  return { ...draft, confirmedCurrencyBlocks: current.filter((key) => key !== blockKey) };
}

/** D-11 성명 결정. null이면 자동 제안(matchDetailMembers의 판정)으로 되돌린다 */
export function withMemberDecision(
  draft: DetailImportDraft,
  key: string,
  decision: DetailMemberDecision | null
): DetailImportDraft {
  const decisions = { ...(draft.memberDecisions ?? {}) };
  if (decision === null) delete decisions[key];
  else decisions[key] = decision;
  return { ...draft, memberDecisions: decisions };
}

/** D-15 [기존 삭제 후 교체]. 담기지 않은 비목은 기존 행이 있으면 건너뛴다 */
export function withReplaceCategory(
  draft: DetailImportDraft,
  category: BudgetCategory,
  replace: boolean
): DetailImportDraft {
  const current = draft.replaceCategories ?? [];
  if (replace) {
    return current.includes(category) ? draft : { ...draft, replaceCategories: [...current, category] };
  }
  return { ...draft, replaceCategories: current.filter((item) => item !== category) };
}

/**
 * D-21 ② 행 단위 포함·제외. 0원 행의 기본 건너뜀을 사용자가 뒤집을 수 있다.
 *
 * 다른 결정과 달리 "지워서 되돌리기"가 없다 — 화면의 조작이 체크박스라 항상 `include`·`skip` 중
 * 하나를 명시하며, 파서의 제안은 그 체크박스의 초기값으로 이미 표시돼 있다.
 */
export function withRowDecision(
  draft: DetailImportDraft,
  rowKey: string,
  decision: DetailRowDecision
): DetailImportDraft {
  return { ...draft, rowDecisions: { ...(draft.rowDecisions ?? {}), [rowKey]: decision } };
}

// ─── D-19 연차 제안 ──────────────────────────────────────────

/**
 * D-19: 시트명의 `N차년도`로 연차를 **제안**한다. 확정은 사용자가 한다.
 *
 * 제안값(`suggestedYearOrder`)은 서버가 시트명에서 뽑아 준 것이다 — 화면이 패턴을 다시 적으면
 * 두 사전이 갈린다. `1단계_2차년도_…`의 `1단계`처럼 매칭되지 않는 토큰이 있으므로 null이 흔하다.
 */
export function suggestedYearId(
  sheet: DetailSheetInfo | null,
  years: readonly WizardYear[]
): string | null {
  if (sheet === null || sheet.suggestedYearOrder === null) return null;
  return years.find((year) => year.order === sheet.suggestedYearOrder)?.id ?? null;
}

export function sheetByName(
  sheets: readonly DetailSheetInfo[],
  name: string | null
): DetailSheetInfo | null {
  if (name === null) return null;
  return sheets.find((sheet) => sheet.name === name) ?? null;
}

// ─── 라벨 사전 (표시 전용) ───────────────────────────────────

export const COLUMN_ROLE_LABELS: Record<DetailColumnRole, string> = {
  memberName: '성명',
  position: '직위',
  salary: '연봉',
  rate: '참여율(%)',
  period: '참여기간(월)',
  hireType: '인력구분',
  name: '품명·내역',
  spec: '규격·산출내역',
  unitPrice: '단가',
  factor: '인자(수량·회·월…)',
  cashTotal: '총액 현금',
  inKindTotal: '총액 현물',
  total: '합계',
  note: '비고',
};

/** D-7 재지정 드롭다운의 선택지. 라벨 사전에서 파생시켜 목록이 둘로 갈리지 않게 한다 */
export const COLUMN_ROLE_OPTIONS = Object.entries(COLUMN_ROLE_LABELS) as [DetailColumnRole, string][];

export const SUBCATEGORY_RESOLUTION_LABELS: Record<SubcategoryResolution, string> = {
  both: '번호+라벨 일치',
  label: '라벨로 판정',
  number: '번호로만 판정',
  conflict: '번호와 라벨 충돌',
  unresolved: '판정 못함',
};

export const DETAIL_BLOCK_ISSUE_LABELS: Record<DetailBlockIssue, string> = {
  'subcategory-conflict': '세목 번호·라벨 충돌',
  'subcategory-by-number': '세목을 번호로만 판정',
  'subcategory-unresolved': '세목 미확정',
  'travel-undecided': '출장비 국내/국외 미정',
  'no-column-header': '컬럼 헤더 못 찾음',
};

/** 왜 확인이 필요한지. 배지만으로는 사용자가 무엇을 결정해야 하는지 모른다 */
export const DETAIL_BLOCK_ISSUE_HINTS: Record<DetailBlockIssue, string> = {
  'subcategory-conflict':
    '원문자 번호가 가리키는 세목과 라벨이 가리키는 세목이 다릅니다. 어느 쪽이 맞는지 고르세요 (D-3).',
  'subcategory-by-number':
    '라벨을 사전에서 찾지 못해 번호로만 정했습니다. 서식이 순서를 바꾸면 조용히 틀리므로 확인이 필요합니다 (D-3).',
  'subcategory-unresolved': '번호도 라벨도 읽지 못했습니다. 세목을 직접 고르세요 (D-3).',
  'travel-undecided':
    '`⑤ 출장비` 표가 여럿이라 국내/국외를 가르지 못했습니다. 표마다 세목을 고르세요 (부록 C.2).',
  'no-column-header':
    '데이터로 보이는 행이 있는데 컬럼 헤더 행을 찾지 못했습니다. 이 표는 반영되지 않으니 원본 서식을 확인하세요 (D-4).',
};

// ─── 확인 필요 항목 (D-3·D-10) ──────────────────────────────

/**
 * 블록 하나에서 사용자 확인을 기다리는 항목.
 *
 * `resolved`는 **사용자가 이미 결정했는가**다 — 배지를 지우지 않고 해소 표시로 남긴다.
 * 지워 버리면 무엇을 확인해서 지나갔는지 되돌아볼 수 없다.
 */
export interface DetailBlockAttention {
  key: 'currency' | DetailBlockIssue;
  label: string;
  hint: string;
  resolved: boolean;
}

/** 세목 선택으로 해소되는 확인 항목 (컬럼 헤더 문제는 세목과 무관하다) */
const SUBCATEGORY_ISSUES: readonly DetailBlockIssue[] = [
  'subcategory-conflict',
  'subcategory-by-number',
  'subcategory-unresolved',
  'travel-undecided',
];

export function detailBlockAttentions(
  info: DetailSheetBlockInfo,
  draft: DetailImportDraft
): DetailBlockAttention[] {
  const chosen = (draft.subcategoryChoices ?? {})[info.key] !== undefined;
  const attentions: DetailBlockAttention[] = info.block.issues.map((issue) => ({
    key: issue,
    label: DETAIL_BLOCK_ISSUE_LABELS[issue],
    hint: DETAIL_BLOCK_ISSUE_HINTS[issue],
    resolved: SUBCATEGORY_ISSUES.includes(issue) && chosen,
  }));

  if (info.currency !== null) {
    attentions.push({
      key: 'currency',
      label: `통화 확인 필요 (${info.currency.symbol})`,
      hint: `원화가 아닌 통화 기호를 ${info.currency.row + 1}행 ${info.currency.column}열에서 봤습니다("${info.currency.text}"). 환율을 앱이 지어내지 않으므로, 확인하지 않으면 이 표는 반영되지 않습니다 (D-10).`,
      resolved: (draft.confirmedCurrencyBlocks ?? []).includes(info.key),
    });
  }
  return attentions;
}

/** 시트 전체에서 아직 결정되지 않은 확인 항목 수 (Step 2 상단 요약) */
export function unresolvedAttentionCount(
  sheet: DetailSheetInfo,
  draft: DetailImportDraft
): number {
  return sheet.blocks.reduce(
    (sum, info) =>
      sum + detailBlockAttentions(info, draft).filter((item) => !item.resolved).length,
    0
  );
}

// ─── 세목 선택지 (부록 A.5 프리셋) ──────────────────────────

export interface SubcategoryOption {
  code: string;
  label: string;
}

export function subcategoryOptions(category: BudgetCategory): SubcategoryOption[] {
  return SUBCATEGORY_PRESETS[category].map((preset) => ({
    code: preset.code,
    label: preset.label,
  }));
}

/** 화면에 표시할 세목 코드 — 사용자 선택이 파서 판정보다 앞선다 (D-3) */
export function effectiveSubcategory(
  info: DetailSheetBlockInfo,
  draft: DetailImportDraft
): string | null {
  return (draft.subcategoryChoices ?? {})[info.key] ?? info.block.subcategory;
}

// ─── Step 2 감지 트리 (§7.9.3: 섹션 → 비목 → 세목 → 행 수) ──

export interface DetailTreeCategory {
  category: BudgetCategory;
  categoryLabel: string;
  categoryRow: number;
  blocks: DetailSheetBlockInfo[];
  /** 아래 블록들의 합 — 비목 줄에서 규모를 가늠하는 값이다 */
  rowCount: number;
  fileAmount: number;
}

export interface DetailTreeSection {
  kind: DetailSectionKind;
  label: string;
  headerRow: number;
  categories: DetailTreeCategory[];
}

export interface DetailTree {
  sections: DetailTreeSection[];
  /**
   * 어느 섹션 범위에도 들지 않은 블록. 정상 시트에서는 비어 있다 —
   * 조용히 버리지 않는다 (절대 규칙 5).
   */
  orphans: DetailTreeCategory[];
}

/**
 * 감지 결과를 §7.9.3 Step 2의 트리 모양으로 접는다. **판정은 하지 않는다** —
 * 서버가 준 섹션 경계(D-1)와 블록(D-2·D-3)을 순서대로 묶을 뿐이다.
 */
export function buildDetailTree(sheet: DetailSheetInfo): DetailTree {
  const buckets = sheet.sections.map((section) => ({
    section,
    categories: [] as DetailTreeCategory[],
  }));
  const orphans: DetailTreeCategory[] = [];

  const push = (target: DetailTreeCategory[], info: DetailSheetBlockInfo): void => {
    const block = info.block;
    const last = target[target.length - 1];
    // 같은 비목 헤더(행 번호까지 같아야 한다)의 블록은 한 줄로 묶는다
    if (last && last.categoryRow === block.categoryRow && last.category === block.category) {
      last.blocks.push(info);
      last.rowCount += info.rowCount;
      last.fileAmount += info.fileAmount;
      return;
    }
    target.push({
      category: block.category,
      categoryLabel: block.categoryLabel,
      categoryRow: block.categoryRow,
      blocks: [info],
      rowCount: info.rowCount,
      fileAmount: info.fileAmount,
    });
  };

  for (const info of sheet.blocks) {
    const block = info.block;
    const bucket = buckets.find(
      (candidate) =>
        candidate.section.kind === block.section &&
        block.categoryRow >= candidate.section.startRow &&
        block.categoryRow <= candidate.section.endRow
    );
    push(bucket === undefined ? orphans : bucket.categories, info);
  }

  return {
    sections: buckets.map((bucket) => ({
      kind: bucket.section.kind,
      label: bucket.section.label,
      headerRow: bucket.section.headerRow,
      categories: bucket.categories,
    })),
    orphans,
  };
}

// ─── 단계 이동 판정 ─────────────────────────────────────────

/** Step 1 → 2를 막는 사유. 첫 줄만 표시한다 (총괄표 마법사와 같은 관례) */
export function detailStep1Blockers(
  file: File | null,
  inspect: InspectDetailSheetResult | null,
  draft: DetailImportDraft,
  years: readonly WizardYear[]
): string[] {
  const blockers: string[] = [];
  if (file === null || inspect === null) blockers.push('엑셀 파일을 먼저 선택하세요.');
  if (years.length === 0) {
    blockers.push('이 과제에 연차가 없습니다. 과제 개요에서 단계·연차를 먼저 만드세요.');
  } else if (!isYearChosen(draft)) {
    blockers.push('대상 연차를 고르세요 — 시트 하나는 연차 하나입니다 (D-19).');
  }
  return blockers;
}

/** Step 2 → 3을 막는 사유 */
export function detailStep2Blockers(sheet: DetailSheetInfo | null): string[] {
  if (sheet === null) return ['시트를 고르세요.'];
  if (!sheet.eligible) return [NOT_A_DETAIL_SHEET_GUIDE];
  if (sheet.blocks.length === 0) {
    return ['이 시트의 섹션 안에서 비목 표를 하나도 찾지 못했습니다. 다른 시트를 골라 보세요.'];
  }
  return [];
}
