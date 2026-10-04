// 붙임4형 보기 — 8-1 지원·부담계획 + 8-2 사용계획 모델, 검토사항, 표 모델 (SOT §6.19 AG-3·AG-8, 부록 C.4, 계획서 S-6·S-7·S-19).
//
// 양식 전용 저장 칸은 없다(AG-1): 8-2는 금액 줄을 양식 행으로 묶은 것(`form-rows.ts`)이고, 8-1은 같은 줄의
// 연차별 현금·현물 합 + 버전의 연차별 정부지원 현금(§5.25)에서 나온다. 비율은 표시만 하고(8-2 판정은 Phase 26),
// 8-1만 RL-8 `gov_share_max`·RL-9 `own_cash_min` 규칙 행이 켜져 있고 값이 있을 때 판정한다(G-1).
// 판정 경계는 `lib/rules.ts`와 같다 — `RULE_SPECS`의 종류(ratio_max는 초과, ratio_min은 미만이 위반)를 그대로 쓴다.
//
// "—"는 이유가 있다: 줄 없음 · 분모 0 · 정부지원 현금 미입력·초과. 이유는 검토사항에 문장으로 남긴다 — 조용히
// 0이나 빈칸으로 보이지 않게(절대 규칙 5). 연구실 안전관리비는 L 안의 내역 행이라(Phase 26) 값을 보이기만 하고
// K·L·M·양식 분모에는 다시 더하지 않는다.

import {
  AGREEMENT_VIEW_TEXT,
  ATTACHMENT4_FORM_ROWS,
  ATTACHMENT4_OUTSIDE_CATEGORIES,
  ATTACHMENT8_1_COLUMNS,
  BUDGET_CATEGORY_LABELS,
} from '@/lib/constants';
import { RULE_SPECS, type RuleInput } from '@/lib/rules';
import type { AgreementGovSupport, Attachment4RowId, Attachment81ColumnId, DetailAxis, RuleCode } from '@/types';
import {
  aggregateFormRows,
  buildStageColumns,
  formColumnMetrics,
  type FormColumn,
  type FormBreakdownRowId,
  type FormColumnMetrics,
  type FormDataRowId,
  type FormRowLine,
  type FormRowsResult,
  type FormRowStage,
  type FormRowStageYear,
} from './form-rows';
import { computeRate, formatRate, noRate, RATE_NONE_TEXT, type Rate } from './rates';
import type { TableCell, TableCellRef, TableColumn, TableModel, TableRow } from './table';

// ─── 공통 칸 ──────────────────────────────────────────────────────────────────

/**
 * 보기 칸. `empty` = 줄 없음("—"), `none` = 소스 없음·변환 실패 등 이유 있는 "—", `rate` = 비율(값 없으면 "—").
 * 금액 0(`amount` 0)과 "—"는 다른 사실이다(절대 규칙 5).
 */
export type FormViewCell =
  | { kind: 'amount'; value: number }
  | { kind: 'empty' }
  | { kind: 'none'; reason: string }
  | { kind: 'rate'; rate: Rate; text: string };

export function amountOrEmpty(value: number | null): FormViewCell {
  return value === null ? { kind: 'empty' } : { kind: 'amount', value };
}

export function rateCell(rate: Rate): FormViewCell {
  return { kind: 'rate', rate, text: formatRate(rate) };
}

/** 원 표시. Intl에 기대지 않는다 — 테스트·서버·Tauri 웹뷰에서 같은 문자열이어야 한다 */
export function formatWon(value: number): string {
  const sign = value < 0 ? '-' : '';
  return `${sign}${Math.abs(value).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',')}원`;
}

const NO_LINES_REASON = '금액 줄 없음';

// ─── 검토사항 ─────────────────────────────────────────────────────────────────

export type ReviewNoteCode =
  /** 세목 미지정 인건비를 내부인건비(A)에 넣었다(C.4.1) */
  | 'unassigned_personnel'
  /** 세목 미지정 학생인건비를 학생인건비 일반(D)에 넣었다(C.4.1) */
  | 'unassigned_student'
  /** 양식에 없는 비목이 0이 아니다(U-2) */
  | 'outside_categories'
  /** 8-1 정부지원 현금 미입력 연차 */
  | 'gov_cash_missing'
  /** 8-1 정부지원 현금 > 그 연차 현금 합 */
  | 'gov_cash_exceeds'
  /** 비율의 분모가 0이라 계산하지 않았다 */
  | 'zero_denominator';

export interface ReviewNote {
  code: ReviewNoteCode;
  severity: 'warning' | 'info';
  /** 연차 단위 문구면 그 연차, 아니면 null */
  yearId: string | null;
  message: string;
}

// ─── 8-2 사용계획 ─────────────────────────────────────────────────────────────

export interface Form82Row {
  /** 화면 key. split 행은 `{rowId}:{axis}` */
  key: string;
  rowId: Attachment4RowId;
  kind: 'data' | 'aggregate' | 'ratio' | 'breakdown';
  symbol: string | null;
  label: string;
  /** `현금`·`현물`(split 행) 또는 `일반`·`통합관리`(학생 인건비) */
  subLabel: string | null;
  /** split 데이터 행의 축 — 칸 편집 대상(`form-edit.ts`). 한 줄 행은 null */
  axis: DetailAxis | null;
  /**
   * 데이터 행이고 양식에 없는 비목 행이 아니다 — 연차 열 칸만 편집할 수 있다(단계·합계 열 불가).
   * 작성 중 버전인지는 화면이 따로 본다
   */
  editable: boolean;
  /** `Form82Model.columns`와 같은 순서·길이 */
  cells: FormViewCell[];
}

export interface Form82Model {
  /** 연차 + 단계 소계(단계 2개 이상) + 합계 */
  columns: FormColumn[];
  /** `columns`와 같은 순서 */
  metrics: FormColumnMetrics[];
  /** C.4.1 순서. 통합관리비(현금) 행 없음, 양식에 없는 비목 행은 0이 아닐 때만 */
  rows: Form82Row[];
  /** 양식에 없는 비목 행을 보이는가 */
  showOutsideRow: boolean;
}

const AXIS_LABEL: Record<DetailAxis, string> = { cash: '현금', in_kind: '현물' };

const ZERO_REASON: Partial<Record<Attachment4RowId, string>> = {
  allowance_ratio: '양식 E2(수정인건비)가 0',
  indirect_ratio: '양식 분모(A현금+B현금+C+D+F현금+G현금+H현금+I)가 0',
  personnel_ratio: '연구개발비 총액(M)이 0',
};

function rowRate(rowId: Attachment4RowId, m: FormColumnMetrics): Rate {
  const reasons = { noLines: NO_LINES_REASON, zero: ZERO_REASON[rowId] ?? '분모가 0' };
  // 줄이 있는 열에서 분모 재료 줄만 없으면 분모는 0이다 — "줄 없음"은 열 전체에 줄이 없을 때만 사유가 된다
  const den = (v: number | null): number | null => (m.hasLines ? (v ?? 0) : v);
  switch (rowId) {
    case 'allowance_ratio':
      return computeRate(m.rows.allowance.total, den(m.modifiedPersonnel), reasons);
    case 'indirect_ratio':
      return computeRate(m.rows.indirect.total, den(m.formIndirectBase), reasons);
    case 'personnel_ratio':
      return computeRate(m.totalPersonnel, den(m.total), reasons);
    default:
      throw new Error(`비율 행이 아닙니다 (${rowId}).`);
  }
}

function aggregateValue(rowId: Attachment4RowId, m: FormColumnMetrics): number | null {
  switch (rowId) {
    case 'personnel_subtotal':
      return m.personnelSubtotal;
    case 'total_personnel':
      return m.totalPersonnel;
    case 'modified_personnel':
      return m.modifiedPersonnel;
    case 'direct_subtotal':
      return m.directSubtotal;
    case 'total':
      return m.total;
    default:
      throw new Error(`집계 행이 아닙니다 (${rowId}).`);
  }
}

function buildForm82(formRows: FormRowsResult, columns: FormColumn[]): Form82Model {
  const metrics = columns.map((col) => formColumnMetrics(formRows, col.yearIds));
  const totalMetrics = metrics[metrics.length - 1]!;
  const outside = totalMetrics.rows.outside;
  // U-2: 0이 아닐 때만 보인다. 금액은 0 이상이라 "전 연차 합 ≠ 0" = "어느 연차든 ≠ 0"이다
  const showOutsideRow = (outside.total ?? 0) !== 0;

  const rows: Form82Row[] = [];
  for (const def of ATTACHMENT4_FORM_ROWS) {
    if (def.kind === 'ignored') continue; // U-3 통합관리비(현금) — 행 없음
    if (def.id === 'outside' && !showOutsideRow) continue;
    const base = { rowId: def.id, symbol: def.symbol, label: def.label };
    if (def.kind === 'data') {
      const id = def.id as FormDataRowId;
      const editable = def.id !== 'outside';
      if (def.axes === 'split') {
        for (const axis of ['cash', 'in_kind'] as const) {
          rows.push({
            ...base,
            key: `${def.id}:${axis}`,
            kind: 'data',
            subLabel: AXIS_LABEL[axis],
            axis,
            editable,
            cells: metrics.map((m) => amountOrEmpty(axis === 'cash' ? m.rows[id].cash : m.rows[id].inKind)),
          });
        }
      } else {
        rows.push({
          ...base,
          key: def.id,
          kind: 'data',
          subLabel: def.subLabel,
          axis: null,
          editable,
          cells: metrics.map((m) => amountOrEmpty(m.rows[id].total)),
        });
      }
      continue;
    }
    if (def.kind === 'aggregate') {
      rows.push({
        ...base, key: def.id, kind: 'aggregate', subLabel: def.subLabel, axis: null, editable: false,
        cells: metrics.map((m) => amountOrEmpty(aggregateValue(def.id, m))),
      });
      continue;
    }
    if (def.kind === 'ratio') {
      rows.push({
        ...base, key: def.id, kind: 'ratio', subLabel: def.subLabel, axis: null, editable: false,
        cells: metrics.map((m) => rateCell(rowRate(def.id, m))),
      });
      continue;
    }
    if (def.kind === 'breakdown') {
      // 내역 칸은 상위 행(L)을 고쳐 바꾼다 — 따로 고치면 L 합이 어긋난다(AG-3 편집 대상 아님)
      const id = def.id as FormBreakdownRowId;
      rows.push({
        ...base, key: def.id, kind: 'breakdown', subLabel: def.subLabel, axis: null, editable: false,
        cells: metrics.map((m) => amountOrEmpty(m.breakdowns[id].total)),
      });
      continue;
    }
    throw new Error(`부록 C.4 8-2 행 '${def.id}'(${def.kind})의 보기 규칙이 없습니다.`);
  }
  return { columns, metrics, rows, showOutsideRow };
}

// ─── 8-1 지원·부담계획 ────────────────────────────────────────────────────────

export type GovCashInput = Pick<AgreementGovSupport, 'yearId' | 'govCash'>;

/** ok = 계산 가능, missing = 미입력(행 없음), exceeds = 그 연차 현금 합보다 크다 */
export type GovCashStatus = 'ok' | 'missing' | 'exceeds';

export type Form81JudgedCode = Extract<RuleCode, 'gov_share_max' | 'own_cash_min'>;

export type RatioJudgement =
  | { status: 'pass' | 'fail'; label: string; actual: number; limit: number }
  | { status: 'skipped'; label: string; reason: string };

export interface Form81Row {
  /** 연차 id 또는 'total' */
  key: string;
  kind: 'year' | 'total';
  label: string;
  /** "중소기업" 고정(과제 유형·기업 유형 필드 없음) */
  companyType: string;
  /** 저장된 정부지원 현금(연차 행만 — 편집 칸의 현재 값). 미입력이면 null. 합계 행은 null */
  govCashInput: number | null;
  govCashStatus: GovCashStatus;
  /** A·B·D는 정부지원 현금을 쓸 수 없으면 null("—") */
  govCash: number | null;
  ownCash: number | null;
  ownInKind: number;
  ownSubtotal: number | null;
  /** 그 외 기관 지원금 E·F·G — 0 고정 */
  otherCash: number;
  otherInKind: number;
  otherSubtotal: number;
  totalCash: number;
  totalInKind: number;
  /** H = 현금 + 현물 */
  total: number;
  /** 정부출연금비율 A/H */
  govShare: Rate;
  /** 민간현금비율 B/D */
  ownCashShare: Rate;
  govShareJudgement: RatioJudgement;
  ownCashJudgement: RatioJudgement;
}

export interface Form81Model {
  /** 연차 행(연차 order 순) + 마지막 합계 행 */
  rows: Form81Row[];
}

function firstRule(rules: readonly RuleInput[], code: RuleCode): RuleInput | undefined {
  // RL-D1이 (project, code) 유일을 보장한다. 혹시 둘이면 lib/rules.ts처럼 첫 행
  return rules.find((r) => r.code === code);
}

/** G-1: 행이 켜져 있고 값이 있을 때만 판정. 경계는 lib/rules.ts와 같다(초과·미만이 위반, 같으면 통과) */
export function judgeRatio(code: Form81JudgedCode, rule: RuleInput | undefined, rate: Rate): RatioJudgement {
  const skipped = (reason: string): RatioJudgement => ({ status: 'skipped', label: AGREEMENT_VIEW_TEXT.judgementSkipped, reason });
  const spec = RULE_SPECS[code];
  if (rule === undefined) return skipped(`${spec.ruleRef} 규칙 행이 없습니다`);
  if (!rule.enabled) return skipped(`${spec.ruleRef} 규칙이 꺼져 있습니다`);
  if (rule.value === null) return skipped(`${spec.ruleRef} 한도 값이 없습니다`);
  if (rate.value === null) return skipped(rate.reason);
  const limit = rule.value;
  const actual = rate.value;
  const fails = spec.kind === 'ratio_max' ? actual > limit : spec.kind === 'ratio_min' ? actual < limit : false;
  return fails
    ? { status: 'fail', label: AGREEMENT_VIEW_TEXT.judgementFail, actual, limit }
    : { status: 'pass', label: AGREEMENT_VIEW_TEXT.judgementPass, actual, limit };
}

const GOV_MISSING_REASON = '정부지원 현금 미입력';
const GOV_EXCEEDS_REASON = '정부지원 현금이 그 연차 현금 합보다 큽니다';

function buildForm81(
  formRows: FormRowsResult,
  govByYear: Map<string, number>,
  rules: readonly RuleInput[]
): Form81Model {
  const govRule = firstRule(rules, 'gov_share_max');
  const ownRule = firstRule(rules, 'own_cash_min');

  const makeRow = (
    base: { key: string; kind: 'year' | 'total'; label: string; govCashInput: number | null },
    status: GovCashStatus,
    statusReason: string | null,
    govCash: number | null,
    cash: number,
    inKind: number
  ): Form81Row => {
    const usable = status === 'ok' && govCash !== null;
    const ownCash = usable ? cash - govCash : null;
    const ownSubtotal = ownCash === null ? null : ownCash + inKind;
    const total = cash + inKind;
    const govShare = usable
      ? computeRate(govCash, total, { noLines: NO_LINES_REASON, zero: '합계(H)가 0' })
      : noRate(statusReason!);
    const ownCashShare = usable
      ? computeRate(ownCash, ownSubtotal, { noLines: NO_LINES_REASON, zero: '기관부담 소계(D)가 0' })
      : noRate(statusReason!);
    return {
      ...base,
      companyType: AGREEMENT_VIEW_TEXT.companyType,
      govCashStatus: status,
      govCash: usable ? govCash : null,
      ownCash,
      ownInKind: inKind,
      ownSubtotal,
      otherCash: 0,
      otherInKind: 0,
      otherSubtotal: 0,
      totalCash: cash,
      totalInKind: inKind,
      total,
      govShare,
      ownCashShare,
      govShareJudgement: judgeRatio('gov_share_max', govRule, govShare),
      ownCashJudgement: judgeRatio('own_cash_min', ownRule, ownCashShare),
    };
  };

  const rows: Form81Row[] = formRows.years.map((y) => {
    const stored = govByYear.get(y.yearId) ?? null;
    const status: GovCashStatus = stored === null ? 'missing' : stored > y.cashTotal ? 'exceeds' : 'ok';
    const reason = status === 'missing' ? GOV_MISSING_REASON : status === 'exceeds' ? GOV_EXCEEDS_REASON : null;
    return makeRow(
      { key: y.yearId, kind: 'year', label: y.name, govCashInput: stored },
      status,
      reason,
      stored,
      y.cashTotal,
      y.inKindTotal
    );
  });

  // 합계 행: 미입력 연차가 하나라도 있으면 "—"(AG-3). 초과 연차도 그 연차 B가 음수라 합계를 낼 수 없다
  const missing = rows.filter((r) => r.govCashStatus === 'missing');
  const exceeds = rows.filter((r) => r.govCashStatus === 'exceeds');
  const totalStatus: GovCashStatus = missing.length > 0 ? 'missing' : exceeds.length > 0 ? 'exceeds' : 'ok';
  const totalReason =
    totalStatus === 'missing'
      ? `정부지원 현금 미입력 연차가 있습니다(${missing.map((r) => r.label).join(', ')})`
      : totalStatus === 'exceeds'
        ? `정부지원 현금이 현금 합보다 큰 연차가 있습니다(${exceeds.map((r) => r.label).join(', ')})`
        : null;
  const govSum = totalStatus === 'ok' ? rows.reduce((s, r) => s + r.govCash!, 0) : null;
  rows.push(
    makeRow(
      { key: 'total', kind: 'total', label: '합계', govCashInput: null },
      totalStatus,
      totalReason,
      govSum,
      rows.reduce((s, r) => s + r.totalCash, 0),
      rows.reduce((s, r) => s + r.totalInKind, 0)
    )
  );
  return { rows };
}

// ─── 보기 ─────────────────────────────────────────────────────────────────────

export interface Attachment4ViewInput {
  lines: readonly FormRowLine[];
  years: readonly FormRowStageYear[];
  stages: readonly FormRowStage[];
  /** 그 버전의 연차별 정부지원 현금(§5.25). 행 없음 = 미입력 */
  govSupport: readonly GovCashInput[];
  /** 과제 규칙 행 — `gov_share_max`·`own_cash_min`만 읽는다 */
  rules: readonly RuleInput[];
}

export interface Attachment4ViewModel {
  plan81: Form81Model;
  plan82: Form82Model;
  reviewNotes: ReviewNote[];
  /** 연차별 양식 행 집계 — 교차 검증·조회 액션이 다시 집계하지 않게 싣는다 */
  formRows: FormRowsResult;
}

function govSupportMap(govSupport: readonly GovCashInput[], yearIds: Set<string>): Map<string, number> {
  const map = new Map<string, number>();
  for (const g of govSupport) {
    if (!yearIds.has(g.yearId)) throw new Error(`정부지원 현금이 과제에 없는 연차를 가리킵니다 (${g.yearId}).`);
    if (map.has(g.yearId)) throw new Error(`한 연차의 정부지원 현금 행이 두 개입니다 (${g.yearId}).`);
    if (!Number.isSafeInteger(g.govCash) || g.govCash < 0) {
      throw new Error(`정부지원 현금이 0 이상의 원 단위 정수가 아닙니다 (${g.govCash}).`);
    }
    map.set(g.yearId, g.govCash);
  }
  return map;
}

function buildReviewNotes(formRows: FormRowsResult, plan82: Form82Model, plan81: Form81Model): ReviewNote[] {
  const notes: ReviewNote[] = [];
  for (const y of formRows.years) {
    if (y.unassigned.personnel > 0) {
      notes.push({
        code: 'unassigned_personnel', severity: 'info', yearId: y.yearId,
        message: `${y.name}: 세목 미지정 인건비 ${formatWon(y.unassigned.personnel)}을 내부인건비(A)에 넣었습니다`,
      });
    }
    if (y.unassigned.studentPersonnel > 0) {
      notes.push({
        code: 'unassigned_student', severity: 'info', yearId: y.yearId,
        message: `${y.name}: 세목 미지정 학생인건비 ${formatWon(y.unassigned.studentPersonnel)}을 학생인건비 일반(D)에 넣었습니다`,
      });
    }
    const outsideParts = ATTACHMENT4_OUTSIDE_CATEGORIES.flatMap((c) => {
      const amount = y.totals.byCategory[c]?.plannedAmount ?? 0;
      return amount > 0 ? [`${BUDGET_CATEGORY_LABELS[c]} ${formatWon(amount)}`] : [];
    });
    if (outsideParts.length > 0) {
      notes.push({
        code: 'outside_categories', severity: 'warning', yearId: y.yearId,
        message: `${y.name}: 양식에 없는 비목(${outsideParts.join(', ')})을 '${AGREEMENT_VIEW_TEXT.outsideCategoriesRow}' 행으로 보이고 직접비 소계(K)·총액(M)에 넣었습니다`,
      });
    }
  }

  for (const r of plan81.rows) {
    if (r.kind !== 'year') continue;
    if (r.govCashStatus === 'missing') {
      notes.push({
        code: 'gov_cash_missing', severity: 'warning', yearId: r.key,
        message: `${r.label}: ${GOV_MISSING_REASON} — 8-1의 정부지원 현금·기관부담 현금·두 비율을 계산하지 않았습니다`,
      });
    } else if (r.govCashStatus === 'exceeds') {
      notes.push({
        code: 'gov_cash_exceeds', severity: 'warning', yearId: r.key,
        message: `${r.label}: 정부지원 현금 ${formatWon(r.govCashInput!)}이 그 연차 현금 합 ${formatWon(r.totalCash)}보다 큽니다 — 8-1 정부지원·기관부담 현금과 두 비율을 "${RATE_NONE_TEXT}"로 보입니다`,
      });
    } else {
      for (const [rate, label] of [
        [r.govShare, '정부출연금비율(A/H)'],
        [r.ownCashShare, '민간현금비율(B/D)'],
      ] as const) {
        if (rate.value === null) {
          notes.push({ code: 'zero_denominator', severity: 'info', yearId: r.key, message: `${r.label}: 8-1 ${label} — ${rate.reason}라 계산하지 않았습니다` });
        }
      }
    }
  }

  // 8-2 비율의 분모 0 — 연차 열만(단계·합계 열은 연차 사유의 합이다). 줄 없는 연차는 사유가 "줄 없음"이라 적지 않는다
  plan82.columns.forEach((col, ci) => {
    if (col.kind !== 'year') return;
    for (const row of plan82.rows) {
      if (row.kind !== 'ratio') continue;
      const cell = row.cells[ci]!;
      if (cell.kind === 'rate' && cell.rate.value === null && cell.rate.reason !== NO_LINES_REASON) {
        notes.push({
          code: 'zero_denominator', severity: 'info', yearId: col.key,
          message: `${col.label}: 8-2 ${row.label} — ${cell.rate.reason}라 계산하지 않았습니다`,
        });
      }
    }
  });
  return notes;
}

/**
 * 붙임4형 보기(AG-3). 과제에 없는 연차·단계, 같은 연차의 정부지원 현금 두 행, 음수·비정수 금액, 양식 행에
 * 들어가지 않는 줄은 손상 데이터라 던진다.
 */
export function buildAttachment4View(input: Attachment4ViewInput): Attachment4ViewModel {
  const formRows = aggregateFormRows(input.lines, input.years);
  const columns = buildStageColumns(input.years, input.stages);
  const govByYear = govSupportMap(input.govSupport, new Set(formRows.years.map((y) => y.yearId)));
  const plan82 = buildForm82(formRows, columns);
  const plan81 = buildForm81(formRows, govByYear, input.rules);
  return { plan81, plan82, reviewNotes: buildReviewNotes(formRows, plan82, plan81), formRows };
}

// ─── 표 모델 (AG-8, S-19) ─────────────────────────────────────────────────────

const text = (value: string): TableCell => ({ kind: 'text', text: value });

/** 값이 null이면 빈 칸, 항이 없으면 amount — 항 없는 SUM은 엑셀 오류다 */
function sumOrAmount(value: number | null, terms: TableCellRef[]): TableCell {
  if (value === null) return { kind: 'empty' };
  return terms.length === 0 ? { kind: 'amount', value } : { kind: 'sum', value, terms };
}

function viewCellToTable(cell: FormViewCell): TableCell {
  switch (cell.kind) {
    case 'amount':
      return { kind: 'amount', value: cell.value };
    case 'empty':
      return { kind: 'empty' };
    case 'none':
      return text(RATE_NONE_TEXT);
    case 'rate':
      return text(cell.text);
  }
}

/** 8-2 집계 행이 더하는 행(key). 엑셀에서 데이터 칸을 고치면 집계가 따라 움직인다 */
const AGGREGATE_TERMS: Partial<Record<Attachment4RowId, readonly string[]>> = {
  personnel_subtotal: ['personnel_internal:cash', 'personnel_internal:in_kind', 'personnel_external:cash', 'personnel_external:in_kind', 'personnel_support'],
  total_personnel: ['personnel_subtotal', 'student_general', 'student_managed'],
  modified_personnel: ['personnel_internal:cash', 'personnel_internal:in_kind', 'personnel_external:cash', 'personnel_external:in_kind', 'student_general', 'student_managed'],
  direct_subtotal: [
    'total_personnel',
    'facility_equipment:cash', 'facility_equipment:in_kind',
    'material:cash', 'material:in_kind',
    'activity:cash', 'activity:in_kind',
    'allowance',
    'outside',
  ],
  total: ['direct_subtotal', 'indirect'],
};

const FORM82_LEAD_COLUMNS = 2;

/** 8-2 → 표 모델. 데이터·내역 칸의 단계·합계 열과 집계 행은 `sum` 칸, 비율은 글자 칸 */
export function form82Table(model: Form82Model, title: string): TableModel {
  const columns: TableColumn[] = [
    { label: '항목', type: 'text', key: true, width: 24 },
    { label: '구분', type: 'text', key: true, width: 10 },
    ...model.columns.map((c): TableColumn => ({ label: c.label, type: 'amount' })),
  ];
  const rowIndex = new Map(model.rows.map((r, i) => [r.key, i]));
  const colOfYear = new Map<string, number>();
  model.columns.forEach((c, i) => {
    if (c.kind === 'year') colOfYear.set(c.key, FORM82_LEAD_COLUMNS + i);
  });

  const rows: TableRow[] = model.rows.map((row) => {
    const cells: TableCell[] = [text(row.label), text(row.subLabel ?? '')];
    row.cells.forEach((cell, ci) => {
      const col = model.columns[ci]!;
      const c = FORM82_LEAD_COLUMNS + ci;
      const value = cell.kind === 'amount' ? cell.value : null;
      if (row.kind === 'aggregate') {
        const terms = (AGGREGATE_TERMS[row.rowId] ?? [])
          .filter((key) => rowIndex.has(key))
          .map((key) => ({ row: rowIndex.get(key)!, col: c }));
        cells.push(sumOrAmount(value, terms));
      } else if ((row.kind === 'data' || row.kind === 'breakdown') && col.kind !== 'year') {
        const terms = col.yearIds.map((id) => ({ row: rowIndex.get(row.key)!, col: colOfYear.get(id)! }));
        cells.push(sumOrAmount(value, terms));
      } else {
        cells.push(viewCellToTable(cell));
      }
    });
    const kind: TableRow['kind'] = row.rowId === 'total' ? 'total' : row.kind === 'aggregate' ? 'subtotal' : 'data';
    return { kind, cells };
  });
  return { title, columns, rows };
}

function judgementText(j: RatioJudgement): string {
  return j.status === 'skipped' ? `${j.label} — ${j.reason}` : j.label;
}

const FORM81_AMOUNT_COLUMNS: readonly Attachment81ColumnId[] = [
  'gov_cash', 'own_cash', 'own_in_kind', 'own_subtotal',
  'other_cash', 'other_in_kind', 'other_subtotal',
  'total_cash', 'total_in_kind', 'total',
];

function column81Label(id: Attachment81ColumnId): string {
  const def = ATTACHMENT8_1_COLUMNS.find((c) => c.id === id);
  if (def === undefined) throw new Error(`부록 C.4.2에 없는 8-1 열입니다 (${id}).`);
  return def.groupLabel === null ? def.label : `${def.groupLabel} ${def.label}`;
}

function value81(row: Form81Row, id: Attachment81ColumnId): number | null {
  switch (id) {
    case 'gov_cash': return row.govCash;
    case 'own_cash': return row.ownCash;
    case 'own_in_kind': return row.ownInKind;
    case 'own_subtotal': return row.ownSubtotal;
    case 'other_cash': return row.otherCash;
    case 'other_in_kind': return row.otherInKind;
    case 'other_subtotal': return row.otherSubtotal;
    case 'total_cash': return row.totalCash;
    case 'total_in_kind': return row.totalInKind;
    case 'total': return row.total;
    default: throw new Error(`금액 열이 아닙니다 (${id}).`);
  }
}

/** 8-1 같은 행 안의 합(D = B+C 등). 항 중 빈 칸이 있으면 수식이 값과 어긋나므로 그때는 값만 쓴다 */
const ROW_SUM_TERMS: Partial<Record<Attachment81ColumnId, readonly Attachment81ColumnId[]>> = {
  own_subtotal: ['own_cash', 'own_in_kind'],
  other_subtotal: ['other_cash', 'other_in_kind'],
  total_cash: ['gov_cash', 'own_cash', 'other_cash'],
  total_in_kind: ['own_in_kind', 'other_in_kind'],
  total: ['total_cash', 'total_in_kind'],
};

/** 8-1 → 표 모델. 연차 행 + 합계 행, 비율·판정은 글자 칸 */
export function form81Table(model: Form81Model, title: string): TableModel {
  const lead = 2;
  const colIndex = new Map(FORM81_AMOUNT_COLUMNS.map((id, i) => [id, lead + i]));
  const columns: TableColumn[] = [
    { label: '연차', type: 'text', key: true, width: 12 },
    { label: column81Label('company_type'), type: 'text', key: true, width: 10 },
    ...FORM81_AMOUNT_COLUMNS.map((id): TableColumn => ({ label: column81Label(id), type: 'amount' })),
    { label: '정부출연금비율(A/H)', type: 'text', width: 12 },
    { label: '민간현금비율(B/D)', type: 'text', width: 12 },
    { label: '정부출연금비율 판정', type: 'text', width: 24 },
    { label: '민간현금비율 판정', type: 'text', width: 24 },
  ];
  const yearRowIndexes = model.rows.flatMap((r, i) => (r.kind === 'year' ? [i] : []));

  const rows: TableRow[] = model.rows.map((row, r) => {
    const cells: TableCell[] = [text(row.label), text(row.companyType)];
    for (const id of FORM81_AMOUNT_COLUMNS) {
      const value = value81(row, id);
      const c = colIndex.get(id)!;
      if (row.kind === 'total') {
        // 합계 행은 연차 행의 같은 열을 더한다 — 연차 칸이 빈 칸이면 합계도 null이므로 수식과 값이 어긋나지 않는다
        cells.push(sumOrAmount(value, yearRowIndexes.map((yr) => ({ row: yr, col: c }))));
        continue;
      }
      const parts = ROW_SUM_TERMS[id];
      const partsKnown = parts !== undefined && parts.every((p) => value81(row, p) !== null);
      cells.push(partsKnown ? sumOrAmount(value, parts!.map((p) => ({ row: r, col: colIndex.get(p)! }))) : sumOrAmount(value, []));
    }
    cells.push(
      text(formatRate(row.govShare)),
      text(formatRate(row.ownCashShare)),
      text(judgementText(row.govShareJudgement)),
      text(judgementText(row.ownCashJudgement))
    );
    return { kind: row.kind === 'total' ? 'total' : 'data', cells };
  });
  return { title, columns, rows };
}

/** 붙임4형 = 8-1 표 + 8-2 표(S-19). 시트 이름은 내보내기 액션이 정한다 */
export function attachment4Tables(
  view: Attachment4ViewModel,
  titles: { plan81: string; plan82: string }
): { plan81: TableModel; plan82: TableModel } {
  return { plan81: form81Table(view.plan81, titles.plan81), plan82: form82Table(view.plan82, titles.plan82) };
}
