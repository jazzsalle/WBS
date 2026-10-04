// 협약 예산 편성 항목·증빙 보기 — 보기 모델·금액 줄 대조·표 모델 (SOT §5.24, §6.19 AG-6·AG-8, §7.9.8, 계획서 S-2·S-10).
//
// 경고 배지는 판정기(`evaluateRules`) 결과에서 scope `item`인 finding을 그 건에 붙일 뿐이다 — 여기서 금액을
// 기준과 비교하지 않는다(판정기 하나 — 두 곳에서 비교하면 경계 1원에서 결론이 갈린다, RL-17 ×1.1 포함).
// 대조는 표시만 한다(§5.24) — 편성 항목 금액은 어느 합계에도 더하지 않고, 차액은 저장하지 않는다.
//
// 손상 입력(모르는 연차·종류, 정수가 아닌 금액, 모양이 틀린 증빙, 보기에 없는 건을 가리키는 finding)은 던진다 —
// DB check·FK가 막았어야 하는 상태이고, 조용히 넘기면 틀린 n/m·합계가 맞는 것처럼 보인다(절대 규칙 5).
//
// 경계(AG-9): 순수 함수. xlsx·exceljs·supabase·`lib/db`·`actions`를 import하지 않는다.

import { AGREEMENT_ITEM_MAX_LENGTH, AGREEMENT_ITEM_SUBCATEGORY, agreementSubcategoryLabel } from '@/lib/constants';
import type { RuleFinding } from '@/lib/rules';
import type { AgreementEvidenceCheck, AgreementItem, AgreementItemKind, AgreementLine, Year } from '@/types';
import {
  assertStoredEvidence,
  evidenceDetailText,
  evidenceProgress,
  evidenceProgressText,
  itemKindLabel,
  type EvidenceProgress,
} from './evidence';
import type { TableCell, TableCellRef, TableColumn, TableModel, TableRow } from './table';

// ─── 입력 ─────────────────────────────────────────────────────────────────────

export type ViewItem = Pick<AgreementItem, 'id' | 'yearId' | 'kind' | 'name' | 'amount' | 'quantity' | 'evidence'>;
export type ItemReconcileLine = Pick<AgreementLine, 'yearId' | 'category' | 'subcategoryCode' | 'axis' | 'amount'>;
export type ItemYear = Pick<Year, 'id' | 'name' | 'order'>;

/** 종류 표시 순서(§7.9.8 — 연차 → 종류 → 품명). 장비·재료·외주 = 부록 A.1 비목 순서와 같은 방향 */
export const AGREEMENT_ITEM_KIND_ORDER: readonly AgreementItemKind[] = ['equipment', 'material', 'outsourcing'];

// ─── 모델 ─────────────────────────────────────────────────────────────────────

export interface ItemViewRow {
  id: string;
  yearId: string;
  yearName: string;
  kind: AgreementItemKind;
  kindLabel: string;
  name: string;
  quantity: number | null;
  /** 원 단위 정수, 부가세 별도(§5.24) */
  amount: number;
  /** 저장값 그대로(복사본) — 화면의 [증빙] 펼침이 편집 초깃값으로 쓴다 */
  evidence: AgreementEvidenceCheck[];
  progress: EvidenceProgress;
  /** "받음 n/m" */
  progressText: string;
  /** 이 건에 붙은 RL-17~RL-19 finding(판정기 결과 순서 그대로). 없으면 [] */
  findings: RuleFinding[];
}

/** 연차 × 종류 대조(표시만). 대응 세목 = AGREEMENT_ITEM_SUBCATEGORY */
export interface ItemKindGroup {
  kind: AgreementItemKind;
  kindLabel: string;
  /** 대응 세목 표시(부록 A.5) — "① 연구시설·장비 구입·설치비" 등 */
  subcategoryLabel: string;
  /** 품명 순 */
  rows: ItemViewRow[];
  /** Σ편성 항목 금액 */
  itemsTotal: number;
  /** Σ대응 세목 금액 줄(현금 + 현물). 줄이 하나도 없으면 null — 금액 0 줄과 구별한다(절대 규칙 5) */
  lineTotal: number | null;
  /** itemsTotal − (lineTotal ?? 0). 양수 = 편성 항목이 금액 줄보다 많다 */
  diff: number;
  /** diff가 0 — 화면은 "일치" */
  matches: boolean;
}

export interface ItemYearGroup {
  yearId: string;
  yearName: string;
  /** 편성 항목이나 대응 세목 줄이 있는 종류만, AGREEMENT_ITEM_KIND_ORDER 순 */
  kinds: ItemKindGroup[];
  itemCount: number;
  /** 연차 소계 = Σ편성 항목 금액 */
  amount: number;
}

export interface ItemsViewModel {
  /** 편성 항목이나 대응 세목 줄이 있는 연차만, 연차 order 순 */
  years: ItemYearGroup[];
  /** 표시 순서대로 편 행(연차 → 종류 → 품명 → id) */
  rows: ItemViewRow[];
  grandTotal: { itemCount: number; amount: number };
  /** 어느 연차·종류든 대조 차이가 있으면 true */
  hasDifference: boolean;
}

// ─── 검증 ─────────────────────────────────────────────────────────────────────

function assertWon(value: number, label: string, where: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${where}: ${label}이 0 이상의 원 단위 정수가 아닙니다 (${value}).`);
  }
}

function assertItem(item: ViewItem, where: string): void {
  if (!AGREEMENT_ITEM_KIND_ORDER.includes(item.kind)) {
    throw new Error(`${where}: 편성 항목 종류를 알 수 없습니다 (${String(item.kind)}).`);
  }
  if (typeof item.name !== 'string' || item.name.trim().length === 0 || item.name.length > AGREEMENT_ITEM_MAX_LENGTH.name) {
    throw new Error(`${where}: 품명이 올바르지 않습니다.`);
  }
  assertWon(item.amount, '금액', where);
  if (item.quantity !== null && (!Number.isFinite(item.quantity) || item.quantity < 0)) {
    throw new Error(`${where}: 수량이 0 이상의 숫자가 아닙니다 (${item.quantity}).`);
  }
  assertStoredEvidence(item.evidence, where);
}

function sortYears(years: readonly ItemYear[]): { sorted: ItemYear[]; index: Map<string, number> } {
  const sorted = [...years].sort((a, b) => a.order - b.order);
  const index = new Map<string, number>();
  sorted.forEach((y, i) => {
    if (index.has(y.id)) throw new Error(`연차 목록에 같은 연차가 두 번 있습니다 (${y.id}).`);
    index.set(y.id, i);
  });
  return { sorted, index };
}

const compareName = (a: ItemViewRow, b: ItemViewRow): number =>
  a.name.localeCompare(b.name, 'ko') || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

function kindFor(category: string, subcategoryCode: string): AgreementItemKind | null {
  for (const kind of AGREEMENT_ITEM_KIND_ORDER) {
    const target = AGREEMENT_ITEM_SUBCATEGORY[kind];
    if (target.category === category && target.subcategoryCode === subcategoryCode) return kind;
  }
  return null;
}

// ─── 보기 모델 (AG-6) ─────────────────────────────────────────────────────────

/**
 * 편성 항목 보기. `findings`는 판정 대상 버전의 `evaluateRules` 결과(어댑터가 붙인 skipped 등은 무관) —
 * scope `item`만 골라 itemId로 붙이고 나머지 scope는 무시한다(그 finding은 규칙 패널이 보인다).
 * scope `item`인데 이 보기에 없는 건이거나 연차가 다르면 던진다 — 다른 버전의 판정 결과를 넘긴 것이다.
 */
export function buildItemsView(input: {
  items: readonly ViewItem[];
  lines: readonly ItemReconcileLine[];
  years: readonly ItemYear[];
  findings: readonly RuleFinding[];
}): ItemsViewModel {
  const { sorted: years, index: yearIndex } = sortYears(input.years);

  const rowById = new Map<string, ItemViewRow>();
  for (const item of input.items) {
    const where = `편성 항목 ${item.id}`;
    if (rowById.has(item.id)) throw new Error(`같은 편성 항목이 두 번 있습니다 (${item.id}).`);
    assertItem(item, where);
    const yi = yearIndex.get(item.yearId);
    if (yi === undefined) throw new Error(`${where}: 과제에 없는 연차를 가리킵니다 (${item.yearId}).`);
    const evidence = item.evidence.map((check) => ({ ...check }));
    const progress = evidenceProgress(evidence);
    rowById.set(item.id, {
      id: item.id,
      yearId: item.yearId,
      yearName: years[yi]!.name,
      kind: item.kind,
      kindLabel: itemKindLabel(item.kind),
      name: item.name,
      quantity: item.quantity,
      amount: item.amount,
      evidence,
      progress,
      progressText: evidenceProgressText(progress),
      findings: [],
    });
  }

  for (const finding of input.findings) {
    if (finding.scope.kind !== 'item') continue;
    const row = rowById.get(finding.scope.itemId);
    if (row === undefined) {
      throw new Error(`규칙 판정 결과가 이 버전에 없는 편성 항목을 가리킵니다 (${finding.scope.itemId}).`);
    }
    if (row.yearId !== finding.scope.yearId) {
      throw new Error(`규칙 판정 결과의 연차가 편성 항목 ${row.id}의 연차와 다릅니다 (${finding.scope.yearId}).`);
    }
    row.findings.push(finding);
  }

  // 연차 × 종류 대응 세목 줄 합(현금 + 현물). 줄이 있는지(0원 줄 포함)도 따로 센다
  const lineTotals = years.map(() => new Map<AgreementItemKind, number>());
  for (const line of input.lines) {
    const kind = kindFor(line.category, line.subcategoryCode);
    if (kind === null) continue;
    const yi = yearIndex.get(line.yearId);
    if (yi === undefined) throw new Error(`협약 금액 줄이 과제에 없는 연차를 가리킵니다 (${line.yearId}).`);
    assertWon(line.amount, '협약 금액 줄 금액', '협약 금액 줄');
    if (line.axis !== 'cash' && line.axis !== 'in_kind') {
      throw new Error(`협약 금액 줄의 축을 알 수 없습니다 (${String(line.axis)}).`);
    }
    const totals = lineTotals[yi]!;
    totals.set(kind, (totals.get(kind) ?? 0) + line.amount);
  }

  const groups: ItemYearGroup[] = [];
  years.forEach((year, yi) => {
    const kinds: ItemKindGroup[] = [];
    for (const kind of AGREEMENT_ITEM_KIND_ORDER) {
      const rows = [...rowById.values()].filter((r) => r.yearId === year.id && r.kind === kind).sort(compareName);
      const lineTotal = lineTotals[yi]!.get(kind) ?? null;
      if (rows.length === 0 && lineTotal === null) continue;
      const target = AGREEMENT_ITEM_SUBCATEGORY[kind];
      const subcategoryLabel = agreementSubcategoryLabel(target.category, target.subcategoryCode);
      if (subcategoryLabel === null) {
        throw new Error(`편성 항목 대응 세목을 부록 A.5에서 찾을 수 없습니다 (${target.subcategoryCode}).`);
      }
      const itemsTotal = rows.reduce((s, r) => s + r.amount, 0);
      const diff = itemsTotal - (lineTotal ?? 0);
      kinds.push({ kind, kindLabel: itemKindLabel(kind), subcategoryLabel, rows, itemsTotal, lineTotal, diff, matches: diff === 0 });
    }
    if (kinds.length === 0) return;
    const yearRows = kinds.flatMap((k) => k.rows);
    groups.push({
      yearId: year.id,
      yearName: year.name,
      kinds,
      itemCount: yearRows.length,
      amount: yearRows.reduce((s, r) => s + r.amount, 0),
    });
  });

  const rows = groups.flatMap((g) => g.kinds.flatMap((k) => k.rows));
  return {
    years: groups,
    rows,
    grandTotal: { itemCount: rows.length, amount: groups.reduce((s, g) => s + g.amount, 0) },
    hasDifference: groups.some((g) => g.kinds.some((k) => !k.matches)),
  };
}

// ─── 표 모델 (AG-8, §7.9.8 내보내기) ──────────────────────────────────────────

/** 엑셀·TSV 시트 이름(§7.9.8) */
export const ITEMS_SHEET_NAME = '편성 항목·증빙';

const COL = {
  year: 0,
  kind: 1,
  name: 2,
  quantity: 3,
  amount: 4,
  progress: 5,
  detail: 6,
} as const;

/** 열 순서(§7.9.8). 수량은 소수가 될 수 있어 text 열이다 — amount 칸은 원 단위 정수만 받는다 */
const ITEM_COLUMNS: TableColumn[] = [
  { label: '연차', type: 'text', key: true, width: 10 },
  { label: '종류', type: 'text', key: true, width: 10 },
  { label: '품명', type: 'text', width: 28 },
  { label: '수량', type: 'text', width: 8 },
  { label: '금액', type: 'amount', width: 16 },
  { label: '증빙 받음 n/m', type: 'text', width: 14 },
  { label: '증빙 내역', type: 'text', width: 60 },
];

const text = (value: string): TableCell => ({ kind: 'text', text: value });

/** 항이 없으면 amount 0 — 항 없는 SUM은 엑셀 오류다(assertTableModel) */
function sumOrZero(value: number, terms: TableCellRef[]): TableCell {
  return terms.length === 0 ? { kind: 'amount', value } : { kind: 'sum', value, terms };
}

/**
 * 편성 항목 보기 → 표 모델(한 시트 "편성 항목·증빙"). 연차마다 데이터 행 다음에 연차 소계(sum 칸),
 * 마지막에 합계 행(소계들의 sum). 대조는 표에 넣지 않는다 — 금액 열에 성격이 다른 차액이 섞이면 열 합계가
 * 의미를 잃는다(화면에서 별도 행으로 보인다). 증빙 받음 칸 = "받음 n/m", 증빙 내역 = 항목별 글자(§7.9.8).
 */
export function itemsTable(view: ItemsViewModel, title: string): TableModel {
  const rows: TableRow[] = [];
  const subtotalRowIndex: number[] = [];

  for (const group of view.years) {
    const dataIndex: number[] = [];
    for (const r of group.kinds.flatMap((k) => k.rows)) {
      dataIndex.push(rows.length);
      rows.push({
        kind: 'data',
        cells: [
          text(r.yearName),
          text(r.kindLabel),
          text(r.name),
          text(r.quantity === null ? '' : String(r.quantity)),
          { kind: 'amount', value: r.amount },
          text(r.progressText),
          text(evidenceDetailText(r.evidence)),
        ],
      });
    }
    // 금액 줄만 있고 편성 항목이 없는 연차는 소계 행을 만들지 않는다 — 0원 행을 지어내지 않는다(§7.9.8)
    if (dataIndex.length === 0) continue;
    subtotalRowIndex.push(rows.length);
    rows.push({
      kind: 'subtotal',
      cells: [
        text('소계'),
        text(group.yearName),
        text(''),
        text(''),
        sumOrZero(group.amount, dataIndex.map((row) => ({ row, col: COL.amount }))),
        text(''),
        text(''),
      ],
    });
  }

  rows.push({
    kind: 'total',
    cells: [
      text('합계'),
      text(''),
      text(''),
      text(''),
      sumOrZero(view.grandTotal.amount, subtotalRowIndex.map((row) => ({ row, col: COL.amount }))),
      text(''),
      text(''),
    ],
  });

  return { title, columns: ITEM_COLUMNS, rows };
}
