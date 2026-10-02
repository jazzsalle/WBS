// 조정회의형 보기 — 변경전(제안) · 변경후(협약 버전) 두 표 (SOT §6.19 AG-4, D-7 개정, 계획서 S-8·S-19).
//
// 변경전은 제안 모드 데이터를 `buildBaselineFromPlan`(AV-6 — 미분리 셀은 현금)으로 바꾼 금액 줄이고, 변경후는
// 보고 있는 협약 버전의 금액 줄이다. 둘 다 같은 양식 행 집계(`form-rows.ts`, 부록 C.4)를 지나므로 같은 숫자
// 정의를 쓴다: 인건비 A = 양식 E2(PL-11 `modifiedPersonnel` — 연구지원인력인건비 제외) · 연구수당 B = I ·
// 간접비 C = L · D = A+B+C · 총액 E = M · 직접비 F = K. 읽기 전용이다.
//
// 변환이 실패하면(한쪽만 null 불일치 등) 변경전 열을 0으로 채우지 않고 사유를 보인다 — 0으로 채우면
// "제안에서 전부 삭감됐다"로 읽힌다(절대 규칙 5).

import { AGREEMENT_VIEW_TEXT, adjustmentAfterLabel } from '@/lib/constants';
import {
  aggregateFormRows,
  buildYearColumns,
  formColumnMetrics,
  type FormColumn,
  type FormColumnMetrics,
  type FormRowLine,
  type FormRowYear,
} from './form-rows';
import { amountOrEmpty, rateCell, type FormViewCell } from './attachment4-view';
import { computeRate, RATE_NONE_TEXT, type Rate } from './rates';
import type { TableCell, TableCellRef, TableColumn, TableModel, TableRow } from './table';

// ─── 입력 ─────────────────────────────────────────────────────────────────────

/**
 * 변경전 소스 = `buildBaselineFromPlan` 결과에서 줄(또는 실패 사유)만. 그 결과 타입을 그대로 넣을 수 있다 —
 * 보내기 쪽 필드(참여인원·정부지원 현금 등)는 여기서 읽지 않는다
 */
export type AdjustmentBeforeSource =
  | { ok: true; lines: readonly FormRowLine[] }
  | { ok: false; issues: readonly { message: string }[] };

export interface AdjustmentViewInput {
  years: readonly FormRowYear[];
  before: AdjustmentBeforeSource;
  after: { versionId: string; versionName: string; lines: readonly FormRowLine[] };
  /** AV-3 현재 버전(`currentVersionId`). 보고 있는 버전과 다르면 "현재 버전 아님" */
  currentVersionId: string | null;
}

// ─── 출력 ─────────────────────────────────────────────────────────────────────

export type AdjustmentRowId =
  | 'personnel'               // A = 양식 E2
  | 'allowance'               // B = I
  | 'indirect'                // C = L
  | 'subtotal'                // D = A+B+C
  | 'total'                   // E = M
  | 'subtotal_ratio'          // D/E
  | 'allowance_ratio'         // B/A
  | 'direct'                  // F = K
  | 'personnel_direct_ratio'; // A/F

export interface AdjustmentRowDef {
  id: AdjustmentRowId;
  label: string;
  kind: 'amount' | 'rate';
}

/** 양식 행 순서(실측 조정회의 시트) */
export const ADJUSTMENT_ROWS: readonly AdjustmentRowDef[] = [
  { id: 'personnel', label: '인건비(A)', kind: 'amount' },
  { id: 'allowance', label: '연구수당(B)', kind: 'amount' },
  { id: 'indirect', label: '간접비(C)', kind: 'amount' },
  { id: 'subtotal', label: '합계(D=A+B+C)', kind: 'amount' },
  { id: 'total', label: '연구개발비 총액(E)', kind: 'amount' },
  { id: 'subtotal_ratio', label: '인건비+연구수당+간접비 비율(D/E)', kind: 'rate' },
  { id: 'allowance_ratio', label: '연구수당/인건비 비율(B/A)', kind: 'rate' },
  { id: 'direct', label: '직접비(F)', kind: 'amount' },
  { id: 'personnel_direct_ratio', label: '인건비/직접비 비율(A/F)', kind: 'rate' },
];

export const ADJUSTMENT_INDIRECT_RATE_LABEL = '간접비 비율(양식 분모)';

/** 한 열의 값. 줄이 없는 열은 금액 null·비율 값 없음 */
export interface AdjustmentColumnValues {
  personnel: number | null;
  allowance: number | null;
  indirect: number | null;
  subtotal: number | null;
  total: number | null;
  direct: number | null;
  subtotalRatio: Rate;
  allowanceRatio: Rate;
  personnelDirectRatio: Rate;
  /** 머리 "*간접비 비율" — L ÷ 양식 분모(AG-3) */
  indirectRate: Rate;
}

export interface AdjustmentRow {
  id: AdjustmentRowId;
  label: string;
  kind: 'amount' | 'rate';
  /** `AdjustmentSide.columns`와 같은 순서 */
  cells: FormViewCell[];
}

export interface AdjustmentSide {
  /** "변경전 (제안)" · "변경후 ({버전 이름})" */
  label: string;
  /** false면 변경전 변환이 실패했다 — 칸은 전부 이유 있는 "—"이고 `failureReasons`를 보인다 */
  available: boolean;
  failureReasons: string[];
  /** 연차 + 합계 */
  columns: FormColumn[];
  values: AdjustmentColumnValues[];
  rows: AdjustmentRow[];
  /** 열마다 간접비 비율(양식 분모) */
  indirectRates: FormViewCell[];
  /** 머리에 보일 간접비 비율 = 합계 열 */
  headerIndirectRate: Rate;
}

export interface AdjustmentViewModel {
  before: AdjustmentSide;
  after: AdjustmentSide;
  /** 보고 있는 버전이 현재 버전(AV-3)이 아니다 */
  notCurrentVersion: boolean;
  /** `notCurrentVersion`이면 "현재 버전 아님", 아니면 null */
  notCurrentLabel: string | null;
}

// ─── 계산 ─────────────────────────────────────────────────────────────────────

const NO_LINES_REASON = '금액 줄 없음';
const BEFORE_FAILED_REASON = '제안 데이터를 협약 금액 줄로 바꾸지 못했습니다';

function columnValues(m: FormColumnMetrics): AdjustmentColumnValues {
  if (!m.hasLines) {
    const none: Rate = { value: null, reason: NO_LINES_REASON };
    return {
      personnel: null, allowance: null, indirect: null, subtotal: null, total: null, direct: null,
      subtotalRatio: none, allowanceRatio: none, personnelDirectRatio: none, indirectRate: none,
    };
  }
  // 줄이 있는 연차에서 그 행의 줄만 없으면 0이다 — 양식은 한 연차의 행을 비워 두지 않는다(픽스처: 간접비 C 0)
  const personnel = m.modifiedPersonnel ?? 0;
  const allowance = m.rows.allowance.total ?? 0;
  const indirect = m.rows.indirect.total ?? 0;
  const subtotal = personnel + allowance + indirect;
  const total = m.total ?? 0;
  const direct = m.directSubtotal ?? 0;
  const reasons = (zero: string) => ({ noLines: NO_LINES_REASON, zero });
  return {
    personnel, allowance, indirect, subtotal, total, direct,
    subtotalRatio: computeRate(subtotal, total, reasons('연구개발비 총액(E)이 0')),
    allowanceRatio: computeRate(allowance, personnel, reasons('인건비(A)가 0')),
    personnelDirectRatio: computeRate(personnel, direct, reasons('직접비(F)가 0')),
    indirectRate: computeRate(indirect, m.formIndirectBase ?? 0, reasons('양식 분모(A현금+B현금+C+D+F현금+G현금+H현금+I)가 0')),
  };
}

function cellFor(def: AdjustmentRowDef, v: AdjustmentColumnValues): FormViewCell {
  switch (def.id) {
    case 'personnel': return amountOrEmpty(v.personnel);
    case 'allowance': return amountOrEmpty(v.allowance);
    case 'indirect': return amountOrEmpty(v.indirect);
    case 'subtotal': return amountOrEmpty(v.subtotal);
    case 'total': return amountOrEmpty(v.total);
    case 'direct': return amountOrEmpty(v.direct);
    case 'subtotal_ratio': return rateCell(v.subtotalRatio);
    case 'allowance_ratio': return rateCell(v.allowanceRatio);
    case 'personnel_direct_ratio': return rateCell(v.personnelDirectRatio);
  }
}

function buildSide(label: string, lines: readonly FormRowLine[], years: readonly FormRowYear[]): AdjustmentSide {
  const formRows = aggregateFormRows(lines, years);
  const columns = buildYearColumns(years);
  const values = columns.map((c) => columnValues(formColumnMetrics(formRows, c.yearIds)));
  return {
    label,
    available: true,
    failureReasons: [],
    columns,
    values,
    rows: ADJUSTMENT_ROWS.map((def) => ({ id: def.id, label: def.label, kind: def.kind, cells: values.map((v) => cellFor(def, v)) })),
    indirectRates: values.map((v) => rateCell(v.indirectRate)),
    headerIndirectRate: values[values.length - 1]!.indirectRate,
  };
}

function failedSide(label: string, years: readonly FormRowYear[], reasons: string[]): AdjustmentSide {
  const columns = buildYearColumns(years);
  const none: FormViewCell = { kind: 'none', reason: BEFORE_FAILED_REASON };
  const noRate: Rate = { value: null, reason: BEFORE_FAILED_REASON };
  return {
    label,
    available: false,
    failureReasons: reasons,
    columns,
    values: columns.map(() => ({
      personnel: null, allowance: null, indirect: null, subtotal: null, total: null, direct: null,
      subtotalRatio: noRate, allowanceRatio: noRate, personnelDirectRatio: noRate, indirectRate: noRate,
    })),
    rows: ADJUSTMENT_ROWS.map((def) => ({ id: def.id, label: def.label, kind: def.kind, cells: columns.map(() => none) })),
    indirectRates: columns.map(() => none),
    headerIndirectRate: noRate,
  };
}

/**
 * 조정회의형 보기(AG-4). 금액 줄이 과제에 없는 연차를 가리키거나 손상됐으면(`form-rows.ts`) 던진다.
 * 변경전 변환 실패는 던지지 않고 사유를 싣는다 — 제안 데이터의 정상적인 상태(사용자가 고칠 수 있다)다.
 */
export function buildAdjustmentView(input: AdjustmentViewInput): AdjustmentViewModel {
  const beforeLabel = AGREEMENT_VIEW_TEXT.adjustmentBefore;
  const before = input.before.ok
    ? buildSide(beforeLabel, input.before.lines, input.years)
    : failedSide(beforeLabel, input.years, input.before.issues.map((i) => i.message));
  const after = buildSide(adjustmentAfterLabel(input.after.versionName), input.after.lines, input.years);
  const notCurrentVersion = input.currentVersionId !== input.after.versionId;
  return {
    before,
    after,
    notCurrentVersion,
    notCurrentLabel: notCurrentVersion ? AGREEMENT_VIEW_TEXT.notCurrentVersion : null,
  };
}

// ─── 표 모델 (AG-8, S-19) ─────────────────────────────────────────────────────

const text = (value: string): TableCell => ({ kind: 'text', text: value });

function sumOrAmount(value: number | null, terms: TableCellRef[]): TableCell {
  if (value === null) return { kind: 'empty' };
  return terms.length === 0 ? { kind: 'amount', value } : { kind: 'sum', value, terms };
}

function plainCell(cell: FormViewCell): TableCell {
  switch (cell.kind) {
    case 'amount': return { kind: 'amount', value: cell.value };
    case 'empty': return { kind: 'empty' };
    case 'none': return text(RATE_NONE_TEXT);
    case 'rate': return text(cell.text);
  }
}

// D = A+B+C 행 안의 합. 같은 열의 A·B·C 행을 더한다
const SUBTOTAL_TERMS: readonly AdjustmentRowId[] = ['personnel', 'allowance', 'indirect'];

/**
 * 한 시트(S-19): 항목 · 변경전 연차… · 변경전 합계 · 변경후 연차… · 변경후 합계. D 행과 합계 열은 `sum` 칸.
 * 마지막에 간접비 비율(양식 분모) 행, 변경전 변환이 실패했으면 그 사유 행을 덧붙인다.
 */
export function adjustmentTable(view: AdjustmentViewModel, title: string): TableModel {
  const sides = [view.before, view.after];
  const columns: TableColumn[] = [{ label: '항목', type: 'text', key: true, width: 30 }];
  const offsets: number[] = [];
  for (const side of sides) {
    offsets.push(columns.length);
    for (const col of side.columns) columns.push({ label: `${side.label} ${col.label}`, type: 'amount' });
  }
  const rowIndex = new Map(ADJUSTMENT_ROWS.map((d, i) => [d.id, i]));

  const rows: TableRow[] = ADJUSTMENT_ROWS.map((def, r) => {
    const cells: TableCell[] = [text(def.label)];
    sides.forEach((side, si) => {
      const offset = offsets[si]!;
      const yearCols = side.columns.flatMap((c, ci) => (c.kind === 'year' ? [offset + ci] : []));
      side.rows[r]!.cells.forEach((cell, ci) => {
        const col = side.columns[ci]!;
        const value = cell.kind === 'amount' ? cell.value : null;
        if (def.kind === 'amount' && def.id === 'subtotal' && cell.kind !== 'none') {
          cells.push(sumOrAmount(value, SUBTOTAL_TERMS.map((id) => ({ row: rowIndex.get(id)!, col: offset + ci }))));
        } else if (def.kind === 'amount' && col.kind === 'total' && cell.kind !== 'none') {
          cells.push(sumOrAmount(value, yearCols.map((c) => ({ row: r, col: c }))));
        } else {
          cells.push(plainCell(cell));
        }
      });
    });
    return { kind: def.id === 'subtotal' ? 'subtotal' : 'data', cells };
  });

  const indirectCells: TableCell[] = [text(ADJUSTMENT_INDIRECT_RATE_LABEL)];
  for (const side of sides) for (const cell of side.indirectRates) indirectCells.push(plainCell(cell));
  rows.push({ kind: 'data', cells: indirectCells });

  if (!view.before.available) {
    const reasonCells: TableCell[] = [text('변경전 사유')];
    sides.forEach((side, si) => {
      side.columns.forEach((_, ci) => {
        reasonCells.push(text(si === 0 && ci === 0 ? view.before.failureReasons.join(' / ') : ''));
      });
    });
    rows.push({ kind: 'data', cells: reasonCells });
  }

  const fullTitle = view.notCurrentLabel === null ? title : `${title} (${view.notCurrentLabel})`;
  return { title: fullTitle, columns, rows };
}
