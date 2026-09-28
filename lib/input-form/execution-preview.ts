// 사업비 입력 양식 — 수행 모드 미리보기·커밋 페이로드 (SOT §6.16 IN-10·IN-11·IN-12·IN-13, §6.4 B-1·B-2,
// §8.4 O-1, 부록 B.4).
//
// 파싱 결과 + 현재 집행·명부·예산 → id 기반 diff, 연차 집행률 전후, `commit_execution_form` 페이로드.
// 부수효과 없는 순수 함수다: DB·네트워크·현재 시각을 쓰지 않는다.
//
// **투영 비교(IN-10)**: "기존 집행이 양식에 어떻게 보였을까"를 따로 계산하지 않는다 — 현재 집행으로
// 생성기(`buildInputForm`)를 돌리고 그 결과를 같은 파서(`parseInputForm`)로 읽은 행이 투영이다.
// 생성기·파서의 규칙(세목 미지정 슬롯, 인건비 기본 라벨, 인자 라벨 고정·/100, 사업비 시트에 없는 memberId)을
// 여기서 두 벌로 적으면 한쪽이 바뀔 때 왕복이 조용히 "변경"이 된다. 투영과 같은 필드는 기존 값을 유지한다.
//
// **충돌·삭제 후보는 파일의 `_meta`로 정한다(IN-10)**: 기준 version은 `_meta` `execution:<id>`, 삭제 후보는
// "`_meta` id − 시트 id"다. 반영 시점 DB로 삭제 후보를 다시 정하지 않는다.
//
// **금액 산식을 다시 쓰지 않는다**(PL-10a): 인건비 행 보완은 `computeDetailAmount`만 부른다.
// 집행률은 lib/budget.ts의 요약 함수만 쓴다(식은 한 곳).

import { MONTHS_FACTOR_LABEL, buildInputForm } from './build';
import { PARTICIPATION_FACTOR_LABEL, computeDetailAmount } from '@/lib/budget-plan';
import { computeItemSummary, computeYearSummary } from '@/lib/budget';
import type { BudgetItemInput, BudgetSummary } from '@/lib/budget';
import { BUDGET_CATEGORY_ORDER } from '@/lib/constants';
import type {
  ExecutionFormAddRow,
  ExecutionFormExpected,
  ExecutionFormFields,
  ExecutionFormUpdateRow,
} from '@/lib/db/import-snapshots';
import type { RawSheet } from '@/lib/import/types';
import type { BudgetCategory, DetailAxis, DetailFactor } from '@/types';
import { INPUT_FORM_SHEETS, INPUT_FORM_VERSION } from './layout';
import { parseInputForm } from './parse';
import { dateOutOfYearIssue } from './parse-execution';
import { EXECUTION_ISSUES } from './types';
import type {
  ExecutionIssueKind,
  FormSheet,
  InputFormData,
  InputFormExecution,
  ParseIssue,
  ParsedExecutionForm,
  ParsedExecutionRow,
} from './types';

// ─── 입력 ────────────────────────────────────────────────────

/**
 * 현재(미리보기 시점) DB 기준의 양식 데이터 — `buildInputForm(…, 'execution')`에 넘기는 것과 같은 모양이다.
 * `executions`는 **그 연차의 집행 전부**여야 한다(투영과 집행률 "전"이 여기서 나온다).
 */
export type ExecutionPreviewCurrent = InputFormData & { executions: InputFormExecution[] };

/** 그 연차의 예산 셀(§5.12 BudgetItem). 집행은 `current.executions`에서 모은다 */
export type ExecutionPreviewBudgetItem = Omit<BudgetItemInput, 'executions'>;

export interface ExecutionPreviewInput {
  parsed: ParsedExecutionForm;
  current: ExecutionPreviewCurrent;
  /** 그 연차 budget_items. 연차 생성 시 12비목이 다 생기므로(§5.12) 빠진 비목은 데이터 손상이다 */
  budgetItems: readonly ExecutionPreviewBudgetItem[];
}

// ─── 출력 ────────────────────────────────────────────────────

/** diff 대상 필드(§5.12 BudgetExecution). 비목은 바뀔 수 없어(category-moved) 여기 없다 */
export const EXECUTION_FIELDS = [
  'date',
  'amount',
  'description',
  'note',
  'subcategoryCode',
  'spec',
  'unitPrice',
  'factors',
  'axis',
  'memberId',
  'detailId',
] as const;
export type ExecutionField = (typeof EXECUTION_FIELDS)[number];

/** 반영될 값(앱 표기). add·update·unchanged 행에만 있다 */
export interface ExecutionValues {
  date: string;
  amount: number;
  description: string;
  note: string;
  subcategoryCode: string | null;
  spec: string;
  unitPrice: number | null;
  factors: DetailFactor[] | null;
  axis: DetailAxis | null;
  memberId: string | null;
  detailId: string | null;
}

export type ExecutionRowStatus = 'add' | 'update' | 'unchanged' | 'conflict' | 'error';

/** 'changed' = 내려받은 뒤 version이 바뀜, 'deleted' = 이미 없음 (RPC 결과의 reason과 같은 값) */
export type ExecutionConflictReason = 'changed' | 'deleted';

export interface ExecutionPreviewRow {
  /** `사업비:12`처럼 시트 이름과 1-based 행 번호. 사용자 메시지·React key용 */
  key: string;
  sheet: 'personnel' | 'budget';
  rowIndex: number;
  /** 시트의 숨김 id 그대로. 복사 행이 추가로 바뀌어도 원래 값을 보인다(`copiedFrom` 참고) */
  executionId: string | null;
  status: ExecutionRowStatus;
  category: BudgetCategory | null;
  /** add·update·unchanged에서만 채운다 */
  values: ExecutionValues | null;
  /** update에서만 비어 있지 않다 — 기존 값과 반영될 값이 다른 필드 */
  changedFields: ExecutionField[];
  /** IN-10: 같은 executionId의 복사 행이라 추가로 본 경우 원본 id */
  copiedFrom: string | null;
  conflict: ExecutionConflictReason | null;
  issues: ParseIssue[];
}

export interface ExecutionDeleteCandidate {
  id: string;
  /** `_meta`의 내려받을 때 version */
  expectedVersion: number;
  /** 현재 집행. 이미 지워졌으면 null */
  existing: InputFormExecution | null;
  /** null이면 삭제할 수 있다. 아니면 지우지 않고 충돌로 돌려준다(IN-10) */
  conflict: ExecutionConflictReason | null;
}

export interface ExecutionCellSummary {
  category: BudgetCategory;
  before: BudgetSummary;
  after: BudgetSummary;
}

export interface ExecutionYearSummary {
  before: BudgetSummary;
  after: BudgetSummary;
  /** BUDGET_CATEGORY_ORDER 순 12비목 */
  cells: ExecutionCellSummary[];
  /** B-2: 반영 후 집행률 100% 초과 셀. `newly`는 반영 전엔 초과가 아니었던 셀 */
  overCells: (ExecutionCellSummary & { newly: boolean })[];
  /** B-1: 반영 후 계획 0인데 집행이 있는 셀 */
  offBudgetCells: ExecutionCellSummary[];
}

export interface ExecutionPreviewCounts {
  add: number;
  update: number;
  unchanged: number;
  /** 충돌 행 + 충돌 삭제 후보 */
  conflict: number;
  /** 오류 행 + 파일 단위 차단 문제 */
  error: number;
  /** 막지 않는 문제(행·파일) 건수 */
  warning: number;
  /** 삭제할 수 있는 삭제 후보(충돌 제외) */
  deleteCandidates: number;
}

export interface ExecutionFormPreview {
  rows: ExecutionPreviewRow[];
  deleteCandidates: ExecutionDeleteCandidate[];
  /** 반영에서 건너뛰는 id와 사유 — 충돌 행과 충돌 삭제 후보. 반영 결과에 그대로 보인다 */
  conflicts: { id: string; reason: ExecutionConflictReason }[];
  /** 파일 단위 문제(파서가 준 것) */
  issues: ParseIssue[];
  counts: ExecutionPreviewCounts;
  /** 오류 행이나 파일 단위 차단 문제가 있으면 반영 불가 */
  blocked: boolean;
  /** `[삭제 포함]` 꺼짐 기준 */
  summary: ExecutionYearSummary;
  /** `[삭제 포함]` 켜짐 기준 — 토글마다 서버를 다시 부르지 않도록 둘 다 싣는다 */
  summaryWithDeletes: ExecutionYearSummary;
  /** 반영에 쓰는 `_meta` version(IN-10). 페이로드의 expected가 여기서 나온다 */
  expectedVersions: Readonly<Record<string, number>>;
}

// ─── 비교 헬퍼 ───────────────────────────────────────────────

/** 파싱 행은 집행일·금액이 빌 수 있다(오류 행) — 나머지는 반영 값과 같은 형이다 */
type Comparable = Omit<ExecutionValues, 'date' | 'amount'> & { date: string | null; amount: number | null };

function sameFactors(a: readonly DetailFactor[] | null, b: readonly DetailFactor[] | null): boolean {
  if (a === null || b === null) return a === b;
  if (a.length !== b.length) return false;
  return a.every((f, i) => {
    const g = b[i]!;
    return f.label === g.label && f.value === g.value && f.isPercent === g.isPercent;
  });
}

function sameField<K extends ExecutionField>(field: K, a: Comparable[K], b: Comparable[K]): boolean {
  if (field === 'factors') return sameFactors(a as DetailFactor[] | null, b as DetailFactor[] | null);
  return a === b;
}

function comparableOf(row: ParsedExecutionRow, amount: number | null): Comparable {
  return {
    date: row.date,
    amount,
    description: row.description,
    note: row.note,
    subcategoryCode: row.subcategoryCode,
    spec: row.spec,
    unitPrice: row.unitPrice,
    factors: row.factors,
    axis: row.axis,
    memberId: row.memberId,
    detailId: row.detailId,
  };
}

function valuesOfExecution(e: InputFormExecution): ExecutionValues {
  return {
    date: e.date,
    amount: e.amount,
    description: e.description,
    note: e.note,
    subcategoryCode: e.subcategoryCode,
    spec: e.spec,
    unitPrice: e.unitPrice,
    factors: e.factors,
    axis: e.axis,
    memberId: e.memberId,
    detailId: e.detailId,
  };
}

function executionIssue(kind: ExecutionIssueKind, detail?: string): ParseIssue {
  const def = EXECUTION_ISSUES[kind];
  return { kind, message: detail === undefined ? def.message : `${def.message}: ${detail}`, blocking: def.blocking };
}

function hasBlocking(issues: readonly ParseIssue[]): boolean {
  return issues.some((issue) => issue.blocking);
}

// ─── 투영 (IN-10) ────────────────────────────────────────────

interface Projected {
  sheet: 'personnel' | 'budget';
  row: ParsedExecutionRow;
}

/** 생성기 FormSheet → 파서 RawSheet. 수식 셀은 값이 없다 — 수행 양식의 데이터 행에는 수식이 없다(IN-11) */
function rawOf(sheet: FormSheet): RawSheet {
  return {
    name: sheet.name,
    cells: sheet.rows.map((row) => row.map((cell) => ({ value: cell.value ?? null, isError: false }))),
    merges: [],
  };
}

/**
 * 현재 집행을 생성기가 쓰고 파서가 읽은 모습. 키는 executionId. 생성기는 집행을 정확히 한 행씩 싣는다(IN-4) —
 * 두 번 나오면 그 불변식이 깨진 것이라 던진다.
 */
function projectExecutions(current: ExecutionPreviewCurrent, generatedAt: string): Map<string, Projected> {
  const workbook = buildInputForm(current, generatedAt, 'execution');
  const result = parseInputForm(
    workbook.sheets.map(rawOf),
    { projectId: current.project.id, formVersion: INPUT_FORM_VERSION },
    'execution'
  );
  if (!result.ok) {
    throw new Error(`수행 양식 투영을 다시 읽지 못했다: ${result.rejection.message}`);
  }
  const projected = new Map<string, Projected>();
  const add = (sheet: Projected['sheet'], row: ParsedExecutionRow) => {
    if (row.executionId === null) return;
    if (projected.has(row.executionId)) {
      throw new Error(`수행 양식 투영에 집행 ${row.executionId}가 두 번 나왔다(IN-4)`);
    }
    projected.set(row.executionId, { sheet, row });
  };
  for (const row of result.parsed.personnel) add('personnel', row);
  for (const row of result.parsed.budget) add('budget', row);
  return projected;
}

// ─── 인건비 행 금액 (IN-11·IN-12) ────────────────────────────

const AMOUNT_READ_KINDS: ReadonlySet<string> = new Set<ExecutionIssueKind>([
  'amount-invalid',
  'amount-negative',
  'amount-not-integer',
]);

function factorValue(factors: readonly DetailFactor[] | null, label: string): number | null {
  return factors?.find((f) => f.label === label)?.value ?? null;
}

/**
 * 인건비 시트 행의 금액. 비면 연봉 × 참여율 × 개월(computeDetailAmount, PL-10a)로 채우고, 채울 수 없으면 no-amount.
 * 둘 다 있고 다르면 amount-mismatch 경고 — 입력 금액이 이긴다(IN-11).
 */
function personnelAmount(
  row: ParsedExecutionRow,
  current: ExecutionPreviewCurrent,
  yearId: string,
  issues: ParseIssue[]
): number | null {
  const participation = factorValue(row.factors, PARTICIPATION_FACTOR_LABEL);
  const months = factorValue(row.factors, MONTHS_FACTOR_LABEL);
  const member = row.memberId === null ? undefined : current.members.find((m) => m.id === row.memberId);
  const computable =
    participation !== null &&
    months !== null &&
    row.category !== null &&
    member !== undefined &&
    member.annualSalary !== null;
  const computed = computable
    ? computeDetailAmount(
        {
          yearId,
          category: row.category!,
          subcategory: row.subcategoryCode ?? '',
          axis: row.axis ?? 'cash',
          formula: 'personnel',
          memberId: member!.id,
          unitPrice: 0,
          adjustment: 0,
          // 참여율·개월 두 인자만 — 인건비 시트가 보이는 것은 이 둘뿐이다(IN-12)
          factors: (row.factors ?? []).filter(
            (f) => f.label === PARTICIPATION_FACTOR_LABEL || f.label === MONTHS_FACTOR_LABEL
          ),
        },
        member
      ).amount
    : null;

  if (row.amount === null) {
    // 금액 칸 자체가 잘못 적혔으면(음수·소수·문자) 파서가 이미 막았다 — 빈 칸일 때만 보완을 시도한다
    if (row.issues.some((issue) => AMOUNT_READ_KINDS.has(issue.kind))) return null;
    if (computed === null) issues.push(executionIssue('no-amount', '연봉·참여율·개월이 모두 있어야 채울 수 있습니다'));
    return computed;
  }
  if (computed !== null && computed !== row.amount) {
    issues.push(executionIssue('amount-mismatch', `입력 ${row.amount} · 연봉×참여율×개월 ${computed}`));
  }
  return row.amount;
}

/**
 * 인건비 시트가 보이는 두 라벨(참여율·참여기간)만 교체하고 나머지 인자는 자리째 보존한다(IN-10) —
 * 인건비 시트에 보이지 않는 인자가 왕복만으로 지워지면 안 된다.
 */
function mergePersonnelFactors(
  existing: readonly DetailFactor[] | null,
  parsed: readonly DetailFactor[] | null
): DetailFactor[] | null {
  const merged: DetailFactor[] = [...(existing ?? [])];
  for (const label of [PARTICIPATION_FACTOR_LABEL, MONTHS_FACTOR_LABEL]) {
    const incoming = parsed?.find((f) => f.label === label);
    // 생성기는 라벨의 첫 인자를 보였다(build.ts factorByLabel) — 그 자리를 바꾼다
    const index = merged.findIndex((f) => f.label === label);
    if (incoming === undefined) {
      if (index >= 0) merged.splice(index, 1);
    } else if (index >= 0) {
      merged[index] = { ...incoming };
    } else {
      merged.push({ ...incoming });
    }
  }
  return merged.length === 0 ? null : merged;
}

/** 투영과 같은(unchanged) 행에서는 떼는 경고(IN-11) — 파서가 붙인 것도 여기서 뗀다 */
const UNCHANGED_SILENT_KINDS: ReadonlySet<string> = new Set(['amount-mismatch', 'factor-without-preset']);

/** RPC가 받는 인자 수 상한(commit_execution_form, §5.17과 같은 0~3개) */
const MAX_FACTORS = 3;

// ─── 행 판정 ─────────────────────────────────────────────────

interface WorkRow {
  sheet: 'personnel' | 'budget';
  row: ParsedExecutionRow;
  issues: ParseIssue[];
  amount: number | null;
  /** 복사 행이라 추가로 본다 */
  copiedFrom: string | null;
}

function sheetName(sheet: 'personnel' | 'budget'): string {
  return INPUT_FORM_SHEETS[sheet].name;
}

function requireValues(work: WorkRow): { date: string; amount: number } {
  // 오류가 없는 행이면 파서·보완이 둘 다 채웠다 — 아니면 판정 순서가 깨진 것이다
  if (work.row.date === null || work.amount === null) {
    throw new Error(`${sheetName(work.sheet)} ${work.row.rowIndex}행: 오류 없는 행에 집행일·금액이 없다`);
  }
  return { date: work.row.date, amount: work.amount };
}

function addValues(work: WorkRow): ExecutionValues {
  const { date, amount } = requireValues(work);
  return { ...comparableOf(work.row, amount), date, amount };
}

/**
 * 투영과 같은 필드는 기존 값, 다른 필드는 파싱 값(IN-10). 인건비 시트끼리의 factors만 두 라벨 병합이다.
 */
function mergedValues(work: WorkRow, existing: InputFormExecution, projected: Projected): ExecutionValues {
  const { date, amount } = requireValues(work);
  const parsed: Comparable = { ...comparableOf(work.row, amount), date, amount };
  const projection = comparableOf(projected.row, projected.row.amount);
  const base = valuesOfExecution(existing);
  const out = { ...base } as Record<ExecutionField, unknown>;
  for (const field of EXECUTION_FIELDS) {
    if (sameField(field, parsed[field], projection[field])) continue;
    if (field === 'factors' && work.sheet === 'personnel' && projected.sheet === 'personnel') {
      out.factors = mergePersonnelFactors(existing.factors, work.row.factors);
    } else {
      out[field] = parsed[field];
    }
  }
  return out as unknown as ExecutionValues;
}

function changedFieldsOf(values: ExecutionValues, existing: InputFormExecution): ExecutionField[] {
  const base = valuesOfExecution(existing);
  return EXECUTION_FIELDS.filter((field) => !sameField(field, values[field], base[field]));
}

/** 복사 판정용: 파싱 행이 투영과 비목까지 전부 같은가(IN-10) */
function equalsProjection(work: WorkRow, projected: Projected): boolean {
  if (work.row.category !== projected.row.category) return false;
  const a = comparableOf(work.row, work.amount);
  const b = comparableOf(projected.row, projected.row.amount);
  return EXECUTION_FIELDS.every((field) => sameField(field, a[field], b[field]));
}

// ─── 요약 (§6.4) ─────────────────────────────────────────────

function summarize(
  budgetItems: readonly ExecutionPreviewBudgetItem[],
  before: ReadonlyMap<BudgetCategory, number[]>,
  after: ReadonlyMap<BudgetCategory, number[]>
): ExecutionYearSummary {
  const itemsOf = (amounts: ReadonlyMap<BudgetCategory, number[]>): BudgetItemInput[] =>
    budgetItems.map((item) => ({
      ...item,
      executions: (amounts.get(item.category) ?? []).map((amount) => ({ amount })),
    }));
  const beforeItems = itemsOf(before);
  const afterItems = itemsOf(after);
  const cells: ExecutionCellSummary[] = BUDGET_CATEGORY_ORDER.map((category) => {
    const b = beforeItems.find((item) => item.category === category);
    const a = afterItems.find((item) => item.category === category);
    if (b === undefined || a === undefined) {
      throw new Error(`연차 예산에 비목 '${category}'이(가) 없다 — 연차는 12비목을 모두 가져야 한다(§5.12)`);
    }
    return { category, before: computeItemSummary(b), after: computeItemSummary(a) };
  });
  return {
    before: computeYearSummary(beforeItems),
    after: computeYearSummary(afterItems),
    cells,
    overCells: cells.filter((c) => c.after.over).map((c) => ({ ...c, newly: !c.before.over })),
    offBudgetCells: cells.filter((c) => c.after.offBudget),
  };
}

// ─── 진입점 ──────────────────────────────────────────────────

/**
 * 수행 양식 미리보기(IN-10~IN-13). 미리보기와 반영이 같은 파싱 결과로 이 함수를 부른다(IN-6) —
 * 반영 페이로드는 `executionCommitPayload`가 이 결과에서만 만든다.
 */
export function buildExecutionPreview(input: ExecutionPreviewInput): ExecutionFormPreview {
  const { parsed, current, budgetItems } = input;
  const meta = parsed.meta;
  // 호출부가 다른 과제·연차의 현재 데이터를 넘기면 투영·충돌이 전부 엉뚱해진다 — 조용히 진행하지 않는다
  if (current.project.id !== meta.projectId || current.year.id !== meta.yearId) {
    throw new Error('수행 양식 미리보기: 현재 데이터의 과제·연차가 양식의 _meta와 다르다');
  }
  const strayItem = budgetItems.find((item) => item.yearId !== meta.yearId);
  if (strayItem) throw new Error(`수행 양식 미리보기: 다른 연차의 예산 셀(${strayItem.category})이 섞였다`);

  const currentById = new Map(current.executions.map((e) => [e.id, e]));
  const projected = projectExecutions(current, meta.generatedAt);
  const inMeta = (id: string | null): id is string =>
    id !== null && Object.prototype.hasOwnProperty.call(meta.executions, id);

  // 1) 행별 보완: 인건비 금액(IN-11), 연차 기간 밖(IN-11)
  const work: WorkRow[] = [];
  const collect = (sheet: WorkRow['sheet'], row: ParsedExecutionRow) => {
    const issues = [...row.issues];
    const amount = sheet === 'personnel' ? personnelAmount(row, current, meta.yearId, issues) : row.amount;
    if (row.date !== null) {
      const outOfYear = dateOutOfYearIssue(row.date, current.year);
      if (outOfYear !== null) issues.push(outOfYear);
    }
    work.push({ sheet, row, issues, amount, copiedFrom: null });
  };
  for (const row of parsed.personnel) collect('personnel', row);
  for (const row of parsed.budget) collect('budget', row);

  // 2) 같은 executionId가 여러 행(IN-10): 투영과 전 필드가 같은 행이 정확히 하나면 원본, 나머지는 추가
  const groups = new Map<string, WorkRow[]>();
  for (const w of work) {
    if (!inMeta(w.row.executionId)) continue;
    const list = groups.get(w.row.executionId);
    if (list) list.push(w);
    else groups.set(w.row.executionId, [w]);
  }
  for (const [id, rows] of groups) {
    if (rows.length < 2) continue;
    const projection = projected.get(id);
    const originals = projection === undefined ? [] : rows.filter((w) => equalsProjection(w, projection));
    if (originals.length === 1) {
      for (const w of rows) if (w !== originals[0]) w.copiedFrom = id;
    } else {
      for (const w of rows) w.issues.push(executionIssue('duplicate-execution', id));
    }
  }

  // 3) 행 상태
  const rows: ExecutionPreviewRow[] = work.map((w) => {
    const { row } = w;
    const isNew = row.executionId === null || w.copiedFrom !== null;
    const existing = !isNew && inMeta(row.executionId) ? currentById.get(row.executionId) : undefined;

    // category-moved(IN-10): 기존 행을 다른 비목으로 옮기면 budget_item_id가 조용히 바뀐다
    if (existing !== undefined && row.category !== null && row.category !== existing.category) {
      w.issues.push(executionIssue('category-moved', `${existing.category} → ${row.category}`));
    }

    const base = {
      key: `${sheetName(w.sheet)}:${row.rowIndex}`,
      sheet: w.sheet,
      rowIndex: row.rowIndex,
      executionId: row.executionId,
      category: row.category,
      copiedFrom: w.copiedFrom,
    };
    const empty = { values: null, changedFields: [], conflict: null, issues: w.issues };

    if (hasBlocking(w.issues)) return { ...base, ...empty, status: 'error' };
    if (isNew) return { ...base, ...empty, status: 'add', values: addValues(w) };

    // 여기 오는 행은 _meta에 있는 id다 — 밖이면 파서가 unknown-execution으로 막았다
    const id = row.executionId!;
    const expectedVersion = meta.executions[id]!;
    if (existing === undefined) return { ...base, ...empty, status: 'conflict', conflict: 'deleted' };
    if (existing.version !== expectedVersion) {
      return { ...base, ...empty, status: 'conflict', conflict: 'changed' };
    }

    const projection = projected.get(id);
    if (projection === undefined) {
      throw new Error(`집행 ${id}의 투영이 없다 — 생성기가 모든 집행을 싣는다는 불변식(IN-4)이 깨졌다`);
    }
    const values = mergedValues(w, existing, projection);
    if ((values.factors?.length ?? 0) > MAX_FACTORS) {
      w.issues.push({
        kind: 'factor-invalid',
        message: `인자가 ${MAX_FACTORS}개를 넘습니다 — 이 집행에 참여율·참여기간을 더할 자리가 없습니다`,
        blocking: true,
      });
      return { ...base, ...empty, status: 'error' };
    }
    const changedFields = changedFieldsOf(values, existing);
    if (changedFields.length === 0) {
      // IN-11: 금액 불일치·인자 라벨 경고는 추가·변경 행에만. 실제 집행액이 산식과 다른 건 흔하고, 인자 라벨은
      // 투영과 같으면 기존 라벨이 유지돼 알릴 손실이 없다 — 손대지 않은 행에 붙이면 올릴 때마다 뜨는 소음이다
      const issues = w.issues.filter((issue) => !UNCHANGED_SILENT_KINDS.has(issue.kind));
      return { ...base, ...empty, issues, status: 'unchanged', values, changedFields };
    }
    return { ...base, ...empty, status: 'update', values, changedFields };
  });

  // 4) 삭제 후보(IN-10): `_meta` id − 시트 id. 오류 행·복사 행이 가리키는 id도 시트에 있는 것으로 친다
  const referenced = new Set(work.map((w) => w.row.executionId).filter((id): id is string => id !== null));
  const deleteCandidates: ExecutionDeleteCandidate[] = Object.entries(meta.executions)
    .filter(([id]) => !referenced.has(id))
    .map(([id, expectedVersion]) => {
      const existing = currentById.get(id) ?? null;
      const conflict: ExecutionConflictReason | null =
        existing === null ? 'deleted' : existing.version !== expectedVersion ? 'changed' : null;
      return { id, expectedVersion, existing, conflict };
    });

  const conflicts = [
    ...rows.filter((r) => r.status === 'conflict').map((r) => ({ id: r.executionId!, reason: r.conflict! })),
    ...deleteCandidates.filter((d) => d.conflict !== null).map((d) => ({ id: d.id, reason: d.conflict! })),
  ];

  // 5) 집행률 전후(§6.4). "후"는 add·update만 반영하고 충돌·오류 행은 현재 값 그대로다
  const before = new Map<BudgetCategory, number[]>();
  for (const e of current.executions) before.set(e.category, [...(before.get(e.category) ?? []), e.amount]);
  const afterAmounts = (includeDeletes: boolean): Map<BudgetCategory, number[]> => {
    const updated = new Map<string, number>();
    for (const r of rows) if (r.status === 'update' && r.values) updated.set(r.executionId!, r.values.amount);
    const deleted = new Set(
      includeDeletes ? deleteCandidates.filter((d) => d.conflict === null).map((d) => d.id) : []
    );
    const after = new Map<BudgetCategory, number[]>();
    const push = (category: BudgetCategory, amount: number) =>
      after.set(category, [...(after.get(category) ?? []), amount]);
    for (const e of current.executions) {
      if (!deleted.has(e.id)) push(e.category, updated.get(e.id) ?? e.amount);
    }
    for (const r of rows) if (r.status === 'add' && r.values && r.category) push(r.category, r.values.amount);
    return after;
  };

  const blockingFileIssues = parsed.issues.filter((i) => i.blocking).length;
  const errorRows = rows.filter((r) => r.status === 'error').length;
  const warning =
    rows.reduce((n, r) => n + r.issues.filter((i) => !i.blocking).length, 0) +
    parsed.issues.filter((i) => !i.blocking).length;

  return {
    rows,
    deleteCandidates,
    conflicts,
    issues: parsed.issues,
    counts: {
      add: rows.filter((r) => r.status === 'add').length,
      update: rows.filter((r) => r.status === 'update').length,
      unchanged: rows.filter((r) => r.status === 'unchanged').length,
      conflict: conflicts.length,
      error: errorRows + blockingFileIssues,
      warning,
      deleteCandidates: deleteCandidates.filter((d) => d.conflict === null).length,
    },
    blocked: errorRows + blockingFileIssues > 0,
    summary: summarize(budgetItems, before, afterAmounts(false)),
    summaryWithDeletes: summarize(budgetItems, before, afterAmounts(true)),
    expectedVersions: meta.executions,
  };
}

// ─── 커밋 페이로드 (IN-10) ───────────────────────────────────

export interface ExecutionCommitPayload {
  adds: ExecutionFormAddRow[];
  updates: ExecutionFormUpdateRow[];
  /** `includeDeletes`일 때만 채운다. 충돌 삭제 후보는 넣지 않는다 */
  deleteIds: string[];
  /** 변경·삭제 대상 id → 내려받을 때 version(`_meta`). RPC가 한 번 더 비교한다(O-1) */
  expected: ExecutionFormExpected;
}

function assertAmount(amount: number, where: string): void {
  // §5.12: 0 이상 원 단위 정수. 파서·보완이 보장하지만 DB에 넣기 직전에 한 번 더 막는다(B-4)
  if (!Number.isSafeInteger(amount) || amount < 0) {
    throw new Error(`${where}: 집행 금액이 0 이상 정수가 아니다 (${amount})`);
  }
}

function toFields(values: ExecutionValues): ExecutionFormFields {
  return {
    date: values.date,
    amount: values.amount,
    description: values.description,
    note: values.note,
    subcategory_code: values.subcategoryCode,
    spec: values.spec,
    unit_price: values.unitPrice,
    factors: values.factors,
    axis: values.axis,
    member_id: values.memberId,
    detail_id: values.detailId,
  };
}

/**
 * 미리보기 → `commit_execution_form` 페이로드(DB snake_case). 차단된 미리보기는 반영할 수 없다 — 호출부가
 * `blocked`를 먼저 보고 RULE로 돌려줘야 하며, 여기 오면 던진다. 충돌 행은 싣지 않는다(IN-10 — 그 행만 건너뜀).
 */
export function executionCommitPayload(
  preview: ExecutionFormPreview,
  includeDeletes = false
): ExecutionCommitPayload {
  if (preview.blocked) throw new Error('차단된 수행 양식 미리보기로는 반영 페이로드를 만들 수 없다');

  const adds: ExecutionFormAddRow[] = [];
  const updates: ExecutionFormUpdateRow[] = [];
  const expected: ExecutionFormExpected = {};
  for (const row of preview.rows) {
    if (row.values === null) continue;
    if (row.status === 'add') {
      assertAmount(row.values.amount, row.key);
      if (row.category === null) throw new Error(`${row.key}: 추가 행에 비목이 없다`);
      adds.push({ ...toFields(row.values), category: row.category });
    } else if (row.status === 'update') {
      assertAmount(row.values.amount, row.key);
      const id = row.executionId!;
      if (row.category === null) throw new Error(`${row.key}: 변경 행에 비목이 없다`);
      // category를 늘 싣는다 — RPC가 원래 비목과 한 번 더 대조해 이동을 막는다(IN-10)
      updates.push({ ...toFields(row.values), id, category: row.category });
      expected[id] = preview.expectedVersions[id]!;
    }
  }

  const deleteIds = includeDeletes
    ? preview.deleteCandidates.filter((d) => d.conflict === null).map((d) => d.id)
    : [];
  for (const id of deleteIds) expected[id] = preview.expectedVersions[id]!;

  return { adds, updates, deleteIds, expected };
}
