// 사업비 입력 양식 — 미리보기·커밋 페이로드 (SOT §6.16 IN-3·IN-4·IN-5, §6.10 PL-1~PL-5·PL-10a,
// §6.11 D-8a·D-15·D-15b).
//
// 파싱 결과(시트만 아는 값)에 기존 산출근거·인력 명부를 합쳐 "무엇이 어떻게 바뀌는가"를 낸다 —
// `lib/import/detail-preview.ts`와 같은 층이다. 부수효과 없는 순수 함수: DB·네트워크·현재 시각을 쓰지 않는다.
//
// **금액 산식을 다시 구현하지 않는다** (PL-10a): `computeDetailAmount`만 부른다. 연봉을 여기서 곱하면
// 반올림 경계에서 저장값과 재계산값이 1원 갈린다.
// **판정 키는 숨김 `detailId`뿐이다** (IN-5): 이름·품명으로 기존 행을 찾지 않는다.
// **비목 단위 교체** (IN-5·D-15): 양식에 유효 행이 있고 기존 행도 있는 비목만 교체한다. 양식에 유효 행이
// 없는 비목의 기존 행은 지우지 않고 "유지"로 드러낸다 — 내용 없는 삭제(D-15b)를 여기서 구조적으로 막는다.
// 기존 행이 없는 비목은 교체 지정 없이 추가만 한다: RPC의 D-15a가 미리보기 이후 누가 넣은 행을 지키게 두려면
// 교체 목록에 올리면 안 된다(교체는 "그 셀의 기존 행을 전부 지운다"이다).

import { aggregateDetails, computeDetailAmount } from '@/lib/budget-plan';
import type { BudgetDetailInput, CellTotal, PlanAmounts } from '@/lib/budget-plan';
import { BUDGET_CATEGORY_LABELS, BUDGET_CATEGORY_ORDER, SUBCATEGORY_PRESETS } from '@/lib/constants';
import type { DetailImportRow } from '@/lib/db/import-snapshots';
import type { BudgetCategory, BudgetDetail, DetailAxis, DetailFactor, DetailFormula, Member } from '@/types';
import type { ParseIssue, ParsedInputForm, ParsedPersonnelRow, ParsedQuantityRow } from './types';

// ─── 출력 타입 ───────────────────────────────────────────────

export type InputFormRowStatus =
  /** detailId가 없거나(새 행) 복사한 행 */
  | 'add'
  /** detailId가 기존 행과 이어지고 값이 달라졌다 */
  | 'change'
  | 'unchanged'
  /** 반영을 막는 문제(범위 밖·읽을 수 없는 값·비목 이동). 결과에 남기고 파일째 차단한다(blocked) — 조용히 빠지면 사용자가 못 본다 */
  | 'error'
  /** 양식에 없던 인력·알 수 없는 세목(IN-3·IN-4). 결과에 남고 커밋에서 빠진다 */
  | 'unknown';

export interface InputFormPreviewRow {
  /** `인건비:3`처럼 시트와 1-based 행 번호. 사용자 메시지·React key용 */
  key: string;
  sheet: 'personnel' | 'budget';
  rowIndex: number;
  status: InputFormRowStatus;
  detailId: string | null;
  /** unknown 행은 null일 수 있다 */
  category: BudgetCategory | null;
  subcategory: string | null;
  formula: DetailFormula;
  memberId: string | null;
  axis: DetailAxis | null;
  name: string;
  spec: string;
  note: string;
  unitPrice: number;
  /** 저장 모양 그대로 — isPercent 인자는 사람이 보는 % 값(IN-4: 양식의 /100 값을 되돌린 것) */
  factors: DetailFactor[];
  adjustment: number;
  /** `computeDetailAmount` 결과. error·unknown 행은 0 */
  amount: number;
  /** PL-5: 최종 금액이 음수. 저장은 허용하고 드러낸다 */
  negative: boolean;
  /** D-8a: 명부 연봉이 없어 0원으로 반영된다 */
  missingSalary: boolean;
  /** status='change'일 때 달라진 필드 이름 */
  changedFields: string[];
  /** 파서 issue + 미리보기가 덧붙인 issue. blocking이 하나라도 있으면 error/unknown이다 */
  issues: ParseIssue[];
}

/** 교체 비목 안에서 양식에 없어 지워질 기존 행 */
export interface InputFormDeletedRow {
  detailId: string;
  category: BudgetCategory;
  subcategory: string;
  memberId: string | null;
  name: string;
  amount: number;
}

/** IN-5: 양식에 유효 행이 없어 기존 행을 그대로 두는 비목 */
export interface InputFormUntouchedCategory {
  category: BudgetCategory;
  rowCount: number;
}

export interface InputFormWarning {
  kind: string;
  message: string;
}

export interface InputFormPreview {
  projectId: string;
  yearId: string;
  rows: InputFormPreviewRow[];
  deleted: InputFormDeletedRow[];
  /** `deleted`의 id만. 교체 비목 안의 행뿐이다 */
  deletedDetailIds: string[];
  /** D-15: 기존 행을 지우고 양식 내용으로 바꿀 비목. 유효 행 ≥ 1이 보장된다(D-15b) */
  replaceCategories: BudgetCategory[];
  /** 기존 행이 없어 교체 지정 없이 추가만 하는 비목 */
  addOnlyCategories: BudgetCategory[];
  untouchedCategories: InputFormUntouchedCategory[];
  /** 파일 단위 경고(비차단). 행별 경고는 `rows[].issues`에 있다 */
  warnings: InputFormWarning[];
  /** `commit_detail_import` RPC `p_rows` 모양 그대로(DB snake_case). error·unknown 행은 없다 */
  commitRows: DetailImportRow[];
  summary: {
    added: number;
    changed: number;
    deleted: number;
    unchanged: number;
    errors: number;
    unknown: number;
  };
  /**
   * 반영 뒤의 연차 모습: 양식의 유효 행 + 유지 비목의 기존 행. `cells`는 부록 A.1 비목 순이고
   * `buildYearTotals`에 그대로 넣을 수 있다(규칙 findings용, §6.14)
   */
  totals: { cells: CellTotal[]; total: PlanAmounts };
  /** 차단 issue가 1건이라도 있거나 교체 비목에 넣을 행이 없으면 true */
  blocked: boolean;
}

export interface InputFormPreviewInput {
  parsed: ParsedInputForm;
  yearId: string;
  projectId: string;
  members: readonly Member[];
  /** 그 연차의 산출근거 전체 (양식은 연차 단위다) */
  existingDetails: readonly BudgetDetail[];
  /** `monthSpan(year.startDate, year.endDate)`. 연차 날짜가 없으면 null — 개월 초과 경고를 내지 않는다 */
  yearMonths: number | null;
}

// ─── 상수·헬퍼 ───────────────────────────────────────────────

/** 부록 A.5 인건비 2비목의 기본 인자 라벨. `computeDetailAmount`는 라벨이 아니라 isPercent로 가르지만 저장 모양은 프리셋과 같아야 한다 */
export const PARTICIPATION_LABEL = '참여율(%)';
export const MONTHS_LABEL = '참여기간(월)';

const UNKNOWN_ISSUE_KINDS: ReadonlySet<string> = new Set(['unknown-member', 'unknown-subcategory']);

// 파서(parse.ts DECIMAL_SCALE)가 소수 인자를 소수 6자리 정수 산술로 읽으므로 되돌릴 때도 같은 자리에서 자른다 —
// `0.28 * 100`은 부동소수점에서 28.000000000000004라 그대로 저장하면 unchanged 판정과 표시가 어긋난다
const PERCENT_RESTORE_SCALE = 1_000_000;

/** IN-4: 양식의 `/100` 값 → 저장 모양(%). 곱한 뒤 6자리에서 반올림해 부동소수점 찌꺼기를 없앤다 */
function restorePercent(value: number): number {
  return Math.round(value * 100 * PERCENT_RESTORE_SCALE) / PERCENT_RESTORE_SCALE;
}

function warning(kind: string, message: string): ParseIssue {
  return { kind, message, blocking: false };
}

function blocking(kind: string, message: string): ParseIssue {
  return { kind, message, blocking: true };
}

function hasBlocking(issues: readonly ParseIssue[]): boolean {
  return issues.some((issue) => issue.blocking);
}

/** 인건비 시트의 세목 코드는 인건비·학생인건비 프리셋 5종 중 하나다 — 코드로 비목을 정한다 */
function personnelCategoryOf(subcategory: string): BudgetCategory | null {
  for (const category of ['personnel', 'student_personnel'] as const) {
    if (SUBCATEGORY_PRESETS[category].some((def) => def.code === subcategory)) return category;
  }
  return null;
}

function categoryRank(category: BudgetCategory): number {
  return BUDGET_CATEGORY_ORDER.indexOf(category);
}

function sortCategories(categories: Iterable<BudgetCategory>): BudgetCategory[] {
  return [...new Set(categories)].sort((a, b) => categoryRank(a) - categoryRank(b));
}

function sameFactors(a: readonly DetailFactor[], b: readonly DetailFactor[]): boolean {
  if (a.length !== b.length) return false;
  return a.every((f, i) => f.value === b[i]!.value && f.isPercent === b[i]!.isPercent);
}

// ─── 행 조립 ─────────────────────────────────────────────────

/** 상태 판정 전의 행. status·changedFields·amount는 뒤에서 채운다 */
type DraftRow = Omit<InputFormPreviewRow, 'status' | 'changedFields' | 'amount' | 'negative' | 'missingSalary'>;

function personnelDraft(row: ParsedPersonnelRow, existingById: ReadonlyMap<string, BudgetDetail>): DraftRow {
  const issues = [...row.issues];
  const category = row.subcategory === null ? null : personnelCategoryOf(row.subcategory);
  if (row.subcategory !== null && category === null) {
    // 파서가 인건비 라벨 5종만 받으므로 오면 안 되는 경로다 — 조용히 personnel로 두지 않는다
    issues.push(blocking('unknown-subcategory', `인건비 비목을 정할 수 없는 세목입니다: ${row.subcategory}`));
  }
  const existing = row.detailId === null ? undefined : existingById.get(row.detailId);
  const factors: DetailFactor[] = [
    { label: PARTICIPATION_LABEL, value: row.participation ?? 0, isPercent: true },
    { label: MONTHS_LABEL, value: row.months ?? 0, isPercent: false },
  ];
  return {
    key: `personnel:${row.rowIndex}`,
    sheet: 'personnel',
    rowIndex: row.rowIndex,
    detailId: row.detailId,
    category,
    subcategory: row.subcategory,
    formula: 'personnel',
    memberId: row.memberId === '' ? null : row.memberId,
    axis: row.axis,
    name: '',
    // 양식에 규격 열이 없다 — 이어진 기존 행의 값을 그대로 지킨다(양식이 못 실은 값을 지우지 않는다)
    spec: existing?.formula === 'personnel' ? existing.spec : '',
    note: row.note,
    unitPrice: 0,
    factors,
    adjustment: row.adjustment,
    issues,
  };
}

/**
 * IN-4: 인자 라벨은 프리셋 `defaultFactors`로 고정, isPercent도 프리셋 그대로. 양식의 isPercent 칸은 생성기가
 * `/100`해 둔 값이므로 `×100`으로 되돌린다 — 금액만 보존된다. 프리셋보다 인자가 많으면(프리셋 밖 코드·
 * 빈 프리셋에 적은 값) 기존 행의 라벨을 잇고, 그것도 없으면 `인자N`이다.
 */
function quantityFactors(
  row: ParsedQuantityRow,
  existing: BudgetDetail | undefined
): { factors: DetailFactor[]; issues: ParseIssue[] } {
  const presets =
    row.category === null
      ? []
      : (SUBCATEGORY_PRESETS[row.category].find((def) => def.code === row.subcategory)?.defaultFactors ?? []);
  const issues: ParseIssue[] = [];
  const factors: DetailFactor[] = row.factors.map((value, index) => {
    const preset = presets[index];
    const fallback = existing?.factors[index];
    const label = preset?.label ?? fallback?.label ?? `인자${index + 1}`;
    const isPercent = preset?.isPercent ?? fallback?.isPercent ?? false;
    if (preset === undefined && fallback === undefined) {
      issues.push(warning('factor-without-preset', `인자${index + 1}에 프리셋 라벨이 없어 '${label}'로 둡니다`));
    }
    return { label, value: isPercent ? restorePercent(value) : value, isPercent };
  });
  return { factors, issues };
}

function quantityDraft(row: ParsedQuantityRow, existingById: ReadonlyMap<string, BudgetDetail>): DraftRow {
  const existing = row.detailId === null ? undefined : existingById.get(row.detailId);
  const { factors, issues: factorIssues } = quantityFactors(row, existing);
  return {
    key: `budget:${row.rowIndex}`,
    sheet: 'budget',
    rowIndex: row.rowIndex,
    detailId: row.detailId,
    category: row.category,
    subcategory: row.category === null ? null : row.subcategory,
    formula: 'quantity',
    memberId: null,
    axis: row.axis,
    name: row.name,
    spec: row.spec,
    note: row.note,
    unitPrice: row.unitPrice,
    factors,
    adjustment: row.adjustment,
    issues: [...row.issues, ...factorIssues],
  };
}

// ─── 기존 행과 대조 (IN-5) ───────────────────────────────────

/** 저장값과 달라지는 필드. 인자 라벨은 비교하지 않는다 — IN-4가 라벨 손실을 "변경"이 아니라 한계로 정했다 */
function changedFieldsOf(draft: DraftRow, existing: BudgetDetail, amount: number): string[] {
  const changed: string[] = [];
  if (draft.category !== existing.category) changed.push('category');
  if (draft.subcategory !== existing.subcategory) changed.push('subcategory');
  if (draft.axis !== existing.axis) changed.push('axis');
  if (draft.formula !== existing.formula) changed.push('formula');
  if (draft.memberId !== existing.memberId) changed.push('memberId');
  if (draft.name !== existing.name) changed.push('name');
  if (draft.spec !== existing.spec) changed.push('spec');
  if (draft.note !== existing.note) changed.push('note');
  if (draft.unitPrice !== existing.unitPrice) changed.push('unitPrice');
  if (draft.adjustment !== existing.adjustment) changed.push('adjustment');
  if (!sameFactors(draft.factors, existing.factors)) changed.push('factors');
  // 저장된 amount는 믿지 않는다(PL-D7) — 명부 연봉이 바뀐 뒤라면 같은 근거로도 금액이 달라진다
  if (amount !== existing.amount) changed.push('amount');
  return changed;
}

function factorLabelsDiffer(draft: DraftRow, existing: BudgetDetail): boolean {
  if (draft.formula !== 'quantity') return false;
  if (draft.factors.length !== existing.factors.length) return false;
  return draft.factors.some((f, i) => f.label !== existing.factors[i]!.label);
}

// ─── 진입점 ──────────────────────────────────────────────────

/**
 * 파싱 결과 + 기존 산출근거 + 인력 명부 → 미리보기와 커밋 페이로드.
 *
 * 순서: 행 조립 → 금액(PL-1~PL-5, `computeDetailAmount`) → detailId 대조(add/change/unchanged) →
 * 비목 단위 교체·유지 판정(IN-5·D-15b) → 비목 이동 검사 → 삭제 목록 → 커밋 행 → 합계.
 * 비목 이동(기존 행의 세목을 다른 비목으로 고침)은 원래 비목이 교체 대상이 아니면 막는다 —
 * 그대로 두면 원래 비목의 행이 남고 새 비목에 사본이 들어가 **같은 근거가 둘이 된다.**
 */
export function buildInputFormPreview(input: InputFormPreviewInput): InputFormPreview {
  const { parsed, yearId, projectId, members, existingDetails, yearMonths } = input;
  const memberById = new Map(members.map((m) => [m.id, m]));
  const existingById = new Map(existingDetails.map((d) => [d.id, d]));
  const existingCountByCategory = new Map<BudgetCategory, number>();
  for (const detail of existingDetails) {
    existingCountByCategory.set(detail.category, (existingCountByCategory.get(detail.category) ?? 0) + 1);
  }

  // ── 행 조립 + 금액 + 1차 상태 ──
  const rows: InputFormPreviewRow[] = [];
  const seenDetailIds = new Set<string>();
  const drafts: DraftRow[] = [
    ...parsed.personnel.map((row) => personnelDraft(row, existingById)),
    ...parsed.budget.map((row) => quantityDraft(row, existingById)),
  ];

  for (const draft of drafts) {
    const issues = draft.issues;
    let existing: BudgetDetail | undefined;
    if (draft.detailId !== null) {
      if (seenDetailIds.has(draft.detailId)) {
        // IN-3 "두 구간 참여는 행을 복사해 적는다" — 복사한 행은 숨김 detailId까지 딸려온다. 두 번째부터는 새 행이다
        issues.push(warning('copied-row', '같은 원본 행을 복사한 행입니다 — 새 행으로 추가합니다'));
      } else {
        seenDetailIds.add(draft.detailId);
        existing = existingById.get(draft.detailId);
        if (existing === undefined) {
          issues.push(warning('stale-detail-id', '원본 산출근거가 이미 없습니다 — 새 행으로 추가합니다'));
        }
      }
    }

    // 금액은 한 곳에서만(PL-10a). 인건비는 명부 연봉이 단가다(D-8a) — 양식의 연봉 열은 읽지도 않았다
    const member = draft.memberId === null ? null : (memberById.get(draft.memberId) ?? null);
    const amountInput: BudgetDetailInput = {
      yearId,
      category: draft.category ?? 'personnel',
      subcategory: draft.subcategory ?? '',
      axis: draft.axis ?? 'cash',
      formula: draft.formula,
      memberId: draft.memberId,
      unitPrice: draft.unitPrice,
      adjustment: draft.adjustment,
      factors: draft.factors,
    };
    const computed = computeDetailAmount(amountInput, member);

    if (computed.missingSalary && draft.formula === 'personnel' && member !== null) {
      // D-8a: 조정액으로 파일 값을 맞추지 않는다 — 0원 반영 + 안내. 명부를 채운 뒤 다시 올리면 된다
      issues.push(
        warning('missing-salary', `연봉 미입력 — 0원으로 반영합니다. 인력 화면에서 연봉을 입력한 뒤 다시 올리세요`)
      );
    }
    if (computed.negative) {
      issues.push(warning('negative-amount', `금액이 음수입니다(${computed.amount.toLocaleString('ko-KR')}원) — 조정액을 확인하세요`));
    }
    if (draft.formula === 'personnel' && yearMonths !== null) {
      const months = draft.factors.find((f) => !f.isPercent)?.value ?? 0;
      if (months > yearMonths) {
        issues.push(warning('months-over-year', `참여개월 ${months}이(가) 연차 기간 ${yearMonths}개월을 넘습니다`));
      }
    }
    if (existing !== undefined && factorLabelsDiffer(draft, existing)) {
      issues.push(
        warning(
          'factor-label-reset',
          `인자 라벨이 프리셋으로 돌아갑니다(${existing.factors.map((f) => f.label).join('·')} → ${draft.factors.map((f) => f.label).join('·')}) — 금액은 같습니다`
        )
      );
    }

    let status: InputFormRowStatus;
    let changedFields: string[] = [];
    if (issues.some((issue) => issue.blocking && UNKNOWN_ISSUE_KINDS.has(issue.kind))) {
      status = 'unknown';
    } else if (hasBlocking(issues)) {
      status = 'error';
    } else if (existing === undefined) {
      status = 'add';
    } else {
      changedFields = changedFieldsOf(draft, existing, computed.amount);
      status = changedFields.length === 0 ? 'unchanged' : 'change';
    }

    rows.push({
      ...draft,
      status,
      changedFields,
      amount: status === 'error' || status === 'unknown' ? 0 : computed.amount,
      negative: computed.negative,
      missingSalary: computed.missingSalary,
      issues,
    });
  }

  // ── 비목 단위 교체·유지 (IN-5·D-15·D-15b) + 비목 이동 검사 ──
  const isValid = (row: InputFormPreviewRow): boolean =>
    row.status === 'add' || row.status === 'change' || row.status === 'unchanged';

  let replaceCategories: BudgetCategory[] = [];
  let addOnlyCategories: BudgetCategory[] = [];
  // 이동 행을 error로 바꾸면 유효 행 집합이 줄어 교체 목록이 다시 바뀔 수 있다 — 안정될 때까지 돈다
  for (;;) {
    const validCategories = sortCategories(
      rows.filter(isValid).map((row) => row.category).filter((c): c is BudgetCategory => c !== null)
    );
    replaceCategories = validCategories.filter((c) => (existingCountByCategory.get(c) ?? 0) > 0);
    addOnlyCategories = validCategories.filter((c) => (existingCountByCategory.get(c) ?? 0) === 0);
    const replaceSet = new Set(replaceCategories);

    let moved = false;
    for (const row of rows) {
      if (!isValid(row) || row.detailId === null || row.category === null) continue;
      const existing = existingById.get(row.detailId);
      if (existing === undefined || existing.category === row.category || replaceSet.has(existing.category)) continue;
      row.issues.push(
        blocking(
          'category-moved',
          `'${BUDGET_CATEGORY_LABELS[existing.category]}'의 행을 '${BUDGET_CATEGORY_LABELS[row.category]}'로 옮겼는데 원래 비목에 남는 행이 없습니다 — 그대로 반영하면 원래 행이 남아 근거가 둘이 됩니다. 원래 비목에 행을 두거나 산출근거 패널에서 지우세요`
        )
      );
      row.status = 'error';
      row.changedFields = [];
      row.amount = 0;
      moved = true;
    }
    if (!moved) break;
  }
  const replaceSet = new Set(replaceCategories);

  const untouchedCategories: InputFormUntouchedCategory[] = sortCategories(existingCountByCategory.keys())
    .filter((category) => !replaceSet.has(category))
    .map((category) => ({ category, rowCount: existingCountByCategory.get(category) ?? 0 }));

  // ── 삭제: 교체 비목 안에서 양식의 어느 행도(오류 행 포함) 가리키지 않는 기존 행 ──
  const referenced = new Set(rows.map((row) => row.detailId).filter((id): id is string => id !== null));
  const deleted: InputFormDeletedRow[] = existingDetails
    .filter((d) => replaceSet.has(d.category) && !referenced.has(d.id))
    .map((d) => ({
      detailId: d.id,
      category: d.category,
      subcategory: d.subcategory,
      memberId: d.memberId,
      name: d.name,
      amount: d.amount,
    }));

  // ── 커밋 행 (RPC p_rows 모양, snake_case) ──
  const commitRows: DetailImportRow[] = [];
  const projected: BudgetDetailInput[] = [];
  const orderBySubcategory = new Map<string, number>();
  for (const row of rows) {
    if (!isValid(row) || row.category === null || row.subcategory === null || row.axis === null) continue;
    const orderKey = `${row.category}:${row.subcategory}`;
    const sortOrder = orderBySubcategory.get(orderKey) ?? 0;
    orderBySubcategory.set(orderKey, sortOrder + 1);
    if (!Number.isInteger(row.amount)) {
      // computeDetailAmount가 정수를 보장한다(PL-4). 깨졌다면 산식 쪽 회귀다 — 조용히 넘기지 않는다
      throw new Error(`산출 금액이 정수가 아닙니다: ${row.key} = ${row.amount}`);
    }
    commitRows.push({
      category: row.category,
      subcategory: row.subcategory,
      axis: row.axis,
      formula: row.formula,
      amount: row.amount,
      member_id: row.formula === 'personnel' ? row.memberId : null,
      name: row.name,
      spec: row.spec,
      note: row.note,
      unit_price: row.unitPrice,
      factors: row.factors,
      adjustment: row.adjustment,
      sort_order: sortOrder,
    });
    projected.push({
      yearId,
      category: row.category,
      subcategory: row.subcategory,
      axis: row.axis,
      formula: row.formula,
      memberId: row.memberId,
      unitPrice: row.unitPrice,
      adjustment: row.adjustment,
      factors: row.factors,
    });
  }
  // 유지 비목의 기존 행은 그대로 남으므로 반영 뒤 합계에 들어간다(저장 amount가 아니라 재계산 — PL-D7)
  for (const detail of existingDetails) {
    if (!replaceSet.has(detail.category)) projected.push(detail);
  }
  const aggregate = aggregateDetails(projected, members);

  // ── 경고 (파일 단위, 비차단) ──
  const warnings: InputFormWarning[] = [];
  for (const untouched of untouchedCategories) {
    warnings.push({
      kind: 'untouched',
      message: `양식에 없는 비목 '${BUDGET_CATEGORY_LABELS[untouched.category]}' ${untouched.rowCount}행 유지`,
    });
  }
  const count = (kind: string): number => rows.filter((row) => row.issues.some((i) => i.kind === kind)).length;
  const overMonths = count('months-over-year');
  if (overMonths > 0 && yearMonths !== null) {
    warnings.push({ kind: 'months-over-year', message: `참여개월이 연차 기간(${yearMonths}개월)을 넘는 행 ${overMonths}건` });
  }
  const missing = count('missing-salary');
  if (missing > 0) {
    warnings.push({ kind: 'missing-salary', message: `연봉 미입력으로 0원 반영되는 인건비 행 ${missing}건 (D-8a)` });
  }
  const negatives = count('negative-amount');
  if (negatives > 0) {
    warnings.push({ kind: 'negative-amount', message: `금액이 음수인 행 ${negatives}건 — 저장은 되지만 조정액을 확인하세요` });
  }
  const labelReset = count('factor-label-reset');
  if (labelReset > 0) {
    warnings.push({
      kind: 'factor-label-reset',
      message: `인자 라벨이 프리셋으로 돌아가는 행 ${labelReset}건 — 양식은 인자 라벨을 싣지 않아 금액만 보존됩니다(IN-4)`,
    });
  }

  // ── 요약·차단 ──
  const summary = {
    added: rows.filter((r) => r.status === 'add').length,
    changed: rows.filter((r) => r.status === 'change').length,
    deleted: deleted.length,
    unchanged: rows.filter((r) => r.status === 'unchanged').length,
    errors: rows.filter((r) => r.status === 'error').length,
    unknown: rows.filter((r) => r.status === 'unknown').length,
  };
  const emptyReplace = replaceCategories.some((c) => !commitRows.some((row) => row.category === c));
  const blocked = summary.errors > 0 || summary.unknown > 0 || hasBlocking(parsed.issues) || emptyReplace;

  return {
    projectId,
    yearId,
    rows,
    deleted,
    deletedDetailIds: deleted.map((d) => d.detailId),
    replaceCategories,
    addOnlyCategories,
    untouchedCategories,
    warnings,
    commitRows,
    summary,
    totals: { cells: aggregate.cells, total: aggregate.total },
    blocked,
  };
}
