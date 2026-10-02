// 금액 줄 → 붙임4 양식 행 금액 (SOT §6.19 AG-3·AG-4, 부록 C.4.1, 계획서 S-5·S-6).
//
// 붙임4형·조정회의형은 같은 집계를 쓴다 — 그래서 양식 행 대응(C.4)을 여기 한 곳에서만 한다. 대응표 원본은
// `ATTACHMENT4_FORM_ROWS`이고 여기는 그것을 읽어 (비목, 세목) → 양식 행 표를 만든다. 12비목·세목 미지정 줄까지
// **전부** 한 행에만 들어가야 총액이 보존된다(C.4.1 ⑤) — 들어갈 행이 없는 줄은 손상 데이터라 던진다.
//
// 양식 E2(= PL-11 수정인건비)는 `modifiedPersonnel`을 그대로 받아 쓴다(AG-3 — 산식을 다시 구현하지 않는다).
// 줄이 없는 칸은 null로 남겨 금액 0과 구별한다(절대 규칙 5). 금액은 원 단위 정수 덧셈만 한다.

import {
  agreementSubcategoryLabel,
  ATTACHMENT4_FORM_ROWS,
  BUDGET_CATEGORY_ORDER,
  DEFAULT_SUBCATEGORY_CODE,
} from '@/lib/constants';
import { buildYearTotals, modifiedPersonnel, type YearCategoryTotals, type YearTotalSource } from '@/lib/budget-plan';
import type { AgreementLine, Attachment4RowId, BudgetCategory, DetailAxis, Stage, Year } from '@/types';

// ─── 입력 ─────────────────────────────────────────────────────────────────────

export type FormRowLine = Pick<AgreementLine, 'yearId' | 'category' | 'subcategoryCode' | 'axis' | 'amount'>;
export type FormRowYear = Pick<Year, 'id' | 'name' | 'order'>;
export type FormRowStageYear = Pick<Year, 'id' | 'name' | 'order' | 'stageId'>;
export type FormRowStage = Pick<Stage, 'id' | 'name' | 'order'>;

// ─── 출력 ─────────────────────────────────────────────────────────────────────

/** 금액 줄에서 오는 양식 행(C.4.1 종류 data). 순서는 ATTACHMENT4_FORM_ROWS를 따른다 */
export const FORM_DATA_ROW_IDS = [
  'personnel_internal',
  'personnel_external',
  'personnel_support',
  'student_general',
  'student_managed',
  'facility_equipment',
  'material',
  'activity',
  'allowance',
  'outside',
  'indirect',
] as const satisfies readonly Attachment4RowId[];

export type FormDataRowId = (typeof FORM_DATA_ROW_IDS)[number];

/** 한 양식 행의 축별 금액. 그 축의 줄이 하나도 없으면 null, `total`은 두 축 모두 없을 때만 null */
export interface FormRowAmounts {
  cash: number | null;
  inKind: number | null;
  total: number | null;
}

export interface FormRowsYear {
  yearId: string;
  name: string;
  /** 이 연차에 금액 줄이 하나라도 있는가(금액 0인 줄 포함) */
  hasLines: boolean;
  rows: Record<FormDataRowId, FormRowAmounts>;
  /**
   * `lib/budget-plan.ts` 집계(비목 합계 + personnelSupportTotal). 양식 E2를 `modifiedPersonnel`로,
   * 교차 검증을 `modifiedDirectCost`·`evaluateRules`로 내기 위해 그대로 싣는다
   */
  totals: YearCategoryTotals;
  /** 세목 미지정(`default`) 줄 금액(현금 + 현물) — A·D 일반에 넣었다고 검토사항에 적는다(C.4.1) */
  unassigned: { personnel: number; studentPersonnel: number };
  cashTotal: number;
  inKindTotal: number;
}

export interface FormRowsResult {
  /** 연차 `order` 순, 줄이 없는 연차도 있다 */
  years: FormRowsYear[];
}

/**
 * 여러 연차(한 연차·단계·전체)를 묶은 양식 집계. 줄이 없는 값은 null —
 * 집계 행은 재료가 전부 null일 때만 null이다(category-view의 nullable 덧셈과 같은 태도).
 */
export interface FormColumnMetrics {
  yearIds: string[];
  hasLines: boolean;
  rows: Record<FormDataRowId, FormRowAmounts>;
  /** 인건비 소계 = A + B + C */
  personnelSubtotal: number | null;
  /** 양식 E1 = A + B + C + D (총 인건비) */
  totalPersonnel: number | null;
  /** 양식 E2 = PL-11 `modifiedPersonnel` (A + B + D — 연구지원인력인건비 C 제외) */
  modifiedPersonnel: number | null;
  /** K = E1 + F + G + H + I + 양식에 없는 비목 */
  directSubtotal: number | null;
  /** M = K + L */
  total: number | null;
  /**
   * 양식 분모 = A현금 + B현금 + C + D일반 + D통합관리 + F현금 + G현금 + H현금 + I (AG-3).
   * RL-3 `modifiedDirectCost`와 별개다 — C·D·I는 현물 포함, 양식에 없는 비목 제외
   */
  formIndirectBase: number | null;
  cashTotal: number;
  inKindTotal: number;
}

// ─── 대응표 ───────────────────────────────────────────────────────────────────

interface CategoryRouting {
  explicit: Map<string, FormDataRowId>;
  all: FormDataRowId | null;
}

const DATA_ROW_SET = new Set<string>(FORM_DATA_ROW_IDS);

function isDataRowId(id: Attachment4RowId): id is FormDataRowId {
  return DATA_ROW_SET.has(id);
}

/** C.4.1 보기 소스 → (비목, 세목) 라우팅. 대응표가 겹치거나 비목을 빠뜨리면 상수가 틀린 것이라 던진다 */
function buildRouting(): Map<BudgetCategory, CategoryRouting> {
  const routing = new Map<BudgetCategory, CategoryRouting>(
    BUDGET_CATEGORY_ORDER.map((c) => [c, { explicit: new Map(), all: null }])
  );
  for (const row of ATTACHMENT4_FORM_ROWS) {
    if (row.sources.length === 0) continue;
    if (row.kind !== 'data' || !isDataRowId(row.id)) {
      throw new Error(`부록 C.4 대응표: 금액 행이 아닌 '${row.id}'에 보기 소스가 있습니다.`);
    }
    for (const source of row.sources) {
      const r = routing.get(source.category)!;
      if (source.subcategoryCodes === 'all') {
        if (r.all !== null || r.explicit.size > 0) {
          throw new Error(`부록 C.4 대응표: ${source.category} 비목이 두 행에 들어갑니다.`);
        }
        r.all = row.id;
        continue;
      }
      for (const code of source.subcategoryCodes) {
        if (r.all !== null || r.explicit.has(code)) {
          throw new Error(`부록 C.4 대응표: ${source.category}/${code} 세목이 두 행에 들어갑니다.`);
        }
        r.explicit.set(code, row.id);
      }
    }
  }
  return routing;
}

const ROUTING = buildRouting();

/** (비목, 세목)이 들어가는 양식 행. 없으면 null — 호출자가 손상 데이터로 다룬다 */
export function formRowOf(category: BudgetCategory, subcategoryCode: string): FormDataRowId | null {
  const r = ROUTING.get(category);
  if (r === undefined) return null;
  return r.explicit.get(subcategoryCode) ?? r.all;
}

// ─── nullable 덧셈 ────────────────────────────────────────────────────────────

export function addNullable(a: number | null, b: number | null): number | null {
  if (a === null) return b;
  if (b === null) return a;
  return a + b;
}

export function sumNullable(values: readonly (number | null)[]): number | null {
  return values.reduce<number | null>((acc, v) => addNullable(acc, v), null);
}

const EMPTY_AMOUNTS: FormRowAmounts = { cash: null, inKind: null, total: null };

function addAmounts(a: FormRowAmounts, b: FormRowAmounts): FormRowAmounts {
  return { cash: addNullable(a.cash, b.cash), inKind: addNullable(a.inKind, b.inKind), total: addNullable(a.total, b.total) };
}

function emptyRows(): Record<FormDataRowId, FormRowAmounts> {
  return Object.fromEntries(FORM_DATA_ROW_IDS.map((id) => [id, { ...EMPTY_AMOUNTS }])) as Record<FormDataRowId, FormRowAmounts>;
}

// ─── 집계 ─────────────────────────────────────────────────────────────────────

interface CategoryAccumulator {
  cash: number;
  inKind: number;
  personnelSupport: number;
  seen: boolean;
}

function toYearTotals(acc: Map<BudgetCategory, CategoryAccumulator>): YearCategoryTotals {
  const sources: YearTotalSource[] = [];
  for (const category of BUDGET_CATEGORY_ORDER) {
    const a = acc.get(category)!;
    if (!a.seen) continue;
    const amounts = { plannedAmount: a.cash + a.inKind, cashAmount: a.cash, inKindAmount: a.inKind };
    if (category === 'personnel') sources.push({ ...amounts, category, personnelSupportTotal: a.personnelSupport });
    else sources.push({ ...amounts, category });
  }
  return buildYearTotals(sources);
}

/**
 * 금액 줄 → 연차별 양식 행 금액(C.4.1). 과제에 없는 연차·같은 칸(연차·비목·세목·축)의 중복 줄·
 * 음수·정수가 아닌 금액·축 아닌 값·부록 A.5에 없는 세목은 DB 제약을 벗어난 데이터라 던진다 —
 * 조용히 빼면 양식 총액이 줄어든 채 보인다.
 */
export function aggregateFormRows(lines: readonly FormRowLine[], years: readonly FormRowYear[]): FormRowsResult {
  const sorted = [...years].sort((a, b) => a.order - b.order);
  const yearIndex = new Map<string, number>();
  sorted.forEach((y, i) => {
    if (yearIndex.has(y.id)) throw new Error(`연차 목록에 같은 연차가 두 번 있습니다 (${y.id}).`);
    yearIndex.set(y.id, i);
  });

  const perYear = sorted.map(() => ({
    rows: emptyRows(),
    hasLines: false,
    unassigned: { personnel: 0, studentPersonnel: 0 },
    categories: new Map<BudgetCategory, CategoryAccumulator>(
      BUDGET_CATEGORY_ORDER.map((c) => [c, { cash: 0, inKind: 0, personnelSupport: 0, seen: false }])
    ),
    cashTotal: 0,
    inKindTotal: 0,
  }));

  const seen = new Set<string>();
  for (const line of lines) {
    const yi = yearIndex.get(line.yearId);
    if (yi === undefined) throw new Error(`협약 금액 줄이 과제에 없는 연차를 가리킵니다 (${line.yearId}).`);
    if (!BUDGET_CATEGORY_ORDER.includes(line.category)) throw new Error(`알 수 없는 비목입니다 (${line.category}).`);
    if (line.axis !== 'cash' && line.axis !== 'in_kind') throw new Error(`알 수 없는 축입니다 (${String(line.axis)}).`);
    if (!Number.isSafeInteger(line.amount) || line.amount < 0) {
      throw new Error(`협약 금액 줄 금액이 0 이상의 원 단위 정수가 아닙니다 (${line.amount}).`);
    }
    if (agreementSubcategoryLabel(line.category, line.subcategoryCode) === null) {
      throw new Error(`협약 금액 줄 세목 '${line.category}/${line.subcategoryCode}'은 부록 A.5에 없습니다.`);
    }
    const rowId = formRowOf(line.category, line.subcategoryCode);
    if (rowId === null) {
      throw new Error(`협약 금액 줄 '${line.category}/${line.subcategoryCode}'이 붙임4 양식 행 어디에도 들어가지 않습니다.`);
    }
    const key = `${line.yearId}|${line.category}|${line.subcategoryCode}|${line.axis}`;
    if (seen.has(key)) throw new Error(`같은 칸의 협약 금액 줄이 두 개입니다 (${key}).`);
    seen.add(key);

    const y = perYear[yi]!;
    y.hasLines = true;
    const axis: DetailAxis = line.axis;
    const add: FormRowAmounts =
      axis === 'cash'
        ? { cash: line.amount, inKind: null, total: line.amount }
        : { cash: null, inKind: line.amount, total: line.amount };
    y.rows[rowId] = addAmounts(y.rows[rowId], add);

    const acc = y.categories.get(line.category)!;
    acc.seen = true;
    if (axis === 'cash') acc.cash += line.amount;
    else acc.inKind += line.amount;
    if (line.category === 'personnel' && line.subcategoryCode === 'personnel_support') acc.personnelSupport += line.amount;

    if (axis === 'cash') y.cashTotal += line.amount;
    else y.inKindTotal += line.amount;

    if (line.subcategoryCode === DEFAULT_SUBCATEGORY_CODE) {
      if (line.category === 'personnel') y.unassigned.personnel += line.amount;
      if (line.category === 'student_personnel') y.unassigned.studentPersonnel += line.amount;
    }
  }

  return {
    years: sorted.map((year, i) => {
      const y = perYear[i]!;
      return {
        yearId: year.id,
        name: year.name,
        hasLines: y.hasLines,
        rows: y.rows,
        totals: toYearTotals(y.categories),
        unassigned: y.unassigned,
        cashTotal: y.cashTotal,
        inKindTotal: y.inKindTotal,
      };
    }),
  };
}

/**
 * 연차 묶음(한 연차·단계 소계·합계)의 양식 집계(C.4.1·AG-3). `yearIds`는 `result.years`에 있어야 한다.
 */
export function formColumnMetrics(result: FormRowsResult, yearIds: readonly string[]): FormColumnMetrics {
  const byId = new Map(result.years.map((y) => [y.yearId, y]));
  const picked = yearIds.map((id) => {
    const y = byId.get(id);
    if (y === undefined) throw new Error(`양식 집계에 없는 연차입니다 (${id}).`);
    return y;
  });

  const rows = emptyRows();
  for (const id of FORM_DATA_ROW_IDS) rows[id] = picked.reduce((acc, y) => addAmounts(acc, y.rows[id]), EMPTY_AMOUNTS);
  const t = (id: FormDataRowId): number | null => rows[id].total;
  const c = (id: FormDataRowId): number | null => rows[id].cash;

  const personnelSubtotal = sumNullable([t('personnel_internal'), t('personnel_external'), t('personnel_support')]);
  const totalPersonnel = sumNullable([personnelSubtotal, t('student_general'), t('student_managed')]);
  // E2는 A·B·D 줄이 하나라도 있을 때만 값이다 — C만 있는 연차의 E2를 0으로 보이면 "줄 없음"이 0으로 둔갑한다
  const e2Sources = [t('personnel_internal'), t('personnel_external'), t('student_general'), t('student_managed')];
  const modified = e2Sources.every((v) => v === null)
    ? null
    : picked.reduce((sum, y) => sum + modifiedPersonnel(y.totals), 0);
  const directSubtotal = sumNullable([
    totalPersonnel,
    t('facility_equipment'),
    t('material'),
    t('activity'),
    t('allowance'),
    t('outside'),
  ]);
  const total = addNullable(directSubtotal, t('indirect'));
  const formIndirectBase = sumNullable([
    c('personnel_internal'),
    c('personnel_external'),
    t('personnel_support'),
    t('student_general'),
    t('student_managed'),
    c('facility_equipment'),
    c('material'),
    c('activity'),
    t('allowance'),
  ]);

  return {
    yearIds: [...yearIds],
    hasLines: picked.some((y) => y.hasLines),
    rows,
    personnelSubtotal,
    totalPersonnel,
    modifiedPersonnel: modified,
    directSubtotal,
    total,
    formIndirectBase,
    cashTotal: picked.reduce((s, y) => s + y.cashTotal, 0),
    inKindTotal: picked.reduce((s, y) => s + y.inKindTotal, 0),
  };
}

// ─── 열 (연차 + 단계 소계 + 합계) ─────────────────────────────────────────────

export type FormColumnKind = 'year' | 'stage' | 'total';

export interface FormColumn {
  kind: FormColumnKind;
  /** year = 연차 id, stage = 단계 id, total = 'total' */
  key: string;
  label: string;
  yearIds: string[];
}

/** 합계 열 라벨 */
export const FORM_TOTAL_COLUMN_LABEL = '합계';

/**
 * 8-2 열(AG-3): 단계 순 → 그 단계의 연차들, 단계가 2개 이상이면 단계마다 연차 뒤에 "{단계} 소계", 끝에 합계.
 * 단계 목록에 없는 단계를 가리키는 연차는 던진다(FK가 막았어야 하는 상태).
 */
export function buildStageColumns(years: readonly FormRowStageYear[], stages: readonly FormRowStage[]): FormColumn[] {
  const sortedStages = [...stages].sort((a, b) => a.order - b.order);
  const stageIds = new Set<string>();
  for (const s of sortedStages) {
    if (stageIds.has(s.id)) throw new Error(`단계 목록에 같은 단계가 두 번 있습니다 (${s.id}).`);
    stageIds.add(s.id);
  }
  for (const y of years) {
    if (!stageIds.has(y.stageId)) throw new Error(`연차 '${y.name}'이 단계 목록에 없는 단계를 가리킵니다 (${y.stageId}).`);
  }
  const sortedYears = [...years].sort((a, b) => a.order - b.order);
  const withSubtotals = sortedStages.length >= 2;
  const columns: FormColumn[] = [];
  for (const stage of sortedStages) {
    const inStage = sortedYears.filter((y) => y.stageId === stage.id);
    for (const y of inStage) columns.push({ kind: 'year', key: y.id, label: y.name, yearIds: [y.id] });
    if (withSubtotals) {
      columns.push({ kind: 'stage', key: stage.id, label: `${stage.name} 소계`, yearIds: inStage.map((y) => y.id) });
    }
  }
  columns.push({ kind: 'total', key: 'total', label: FORM_TOTAL_COLUMN_LABEL, yearIds: sortedYears.map((y) => y.id) });
  return columns;
}

/** 단계 없이 연차 + 합계(8-1·조정회의형) */
export function buildYearColumns(years: readonly FormRowYear[]): FormColumn[] {
  const sortedYears = [...years].sort((a, b) => a.order - b.order);
  return [
    ...sortedYears.map((y): FormColumn => ({ kind: 'year', key: y.id, label: y.name, yearIds: [y.id] })),
    { kind: 'total', key: 'total', label: FORM_TOTAL_COLUMN_LABEL, yearIds: sortedYears.map((y) => y.id) },
  ];
}
