// 연구실 안전관리비 = 붙임4 8-2 내역 행(breakdown) — SOT §6.19 AG-3, §5.21 AV-7 ②, 부록 C.4.1, 계획서 S-16·"C.4 안전관리비".
//
// 핵심은 이중 계산 0이다: 안전관리비 줄(`indirect`/`indirect_lab_safety`)은 간접비 L에 이미 들어 있으므로
// 보기는 값을 보이기만 하고 K·L·M·양식 분모를 바꾸지 않으며, 가져오기는 L의 default 줄을 그만큼 줄여 L 합 = 파일 L을 지킨다.
// 숫자는 계획서 픽스처 그대로(버전 A Y1 indirect_hr 2,500,000 → hr 2,000,000 + lab 500,000) — 안 맞으면 구현이 틀린 것이다.
// tests/fixtures/attachment4/synthetic-lab-safety.json은 synthetic.json의 40행(통합관리비(현금))을
// "(간접비 중 연구실 안전관리비)" 500(천원)·0으로 바꾼 익명 합성 변형이다.

import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import {
  attachment4Tables,
  buildAttachment4View,
  type Attachment4ViewModel,
  type FormViewCell,
} from '@/lib/agreement/attachment4-view';
import {
  parseAttachment4,
  type Attachment4Line,
  type Attachment4ParseResult,
  type Attachment4YearInput,
} from '@/lib/agreement/attachment4-parse';
import { resolveFormCellEdit } from '@/lib/agreement/form-edit';
import { breakdownRowOf, formRowOf, type FormRowLine } from '@/lib/agreement/form-rows';
import { assertTableModel } from '@/lib/agreement/table';
import type { RawCell, RawSheet } from '@/lib/import/types';
import type { BudgetCategory, DetailAxis } from '@/types';

// ─── 보기 픽스처 ──────────────────────────────────────────────────────────────

const STAGES = [{ id: 'S1', name: '1단계', order: 0 }];
const YEARS = [
  { id: 'Y1', name: '1차년도', order: 0, stageId: 'S1' },
  { id: 'Y2', name: '2차년도', order: 1, stageId: 'S1' },
];

function line(yearId: string, category: BudgetCategory, sub: string, axis: DetailAxis, amount: number): FormRowLine {
  return { yearId, category, subcategoryCode: sub, axis, amount };
}

/** Phase 24 S-20 버전 A */
const VERSION_A: FormRowLine[] = [
  line('Y1', 'personnel', 'personnel_internal', 'cash', 30_000_000),
  line('Y1', 'personnel', 'personnel_internal', 'in_kind', 10_000_000),
  line('Y1', 'material', 'material_purchase', 'cash', 5_000_000),
  line('Y1', 'activity', 'activity_meeting', 'cash', 1_200_000),
  line('Y1', 'activity', 'activity_travel_dom', 'cash', 800_000),
  line('Y1', 'allowance', 'default', 'cash', 3_000_000),
  line('Y1', 'indirect', 'indirect_hr', 'cash', 2_500_000),
  line('Y2', 'personnel', 'personnel_internal', 'cash', 32_000_000),
  line('Y2', 'personnel', 'personnel_internal', 'in_kind', 10_000_000),
  line('Y2', 'material', 'material_purchase', 'cash', 4_000_000),
  line('Y2', 'activity', 'activity_meeting', 'cash', 1_000_000),
  line('Y2', 'allowance', 'default', 'cash', 3_000_000),
  line('Y2', 'indirect', 'indirect_hr', 'cash', 2_700_000),
];

/** C.4 안전관리비: Y1 indirect_hr 2,500,000 → hr 2,000,000 + lab 500,000 */
const VERSION_A_LAB: FormRowLine[] = VERSION_A.flatMap((l) =>
  l.yearId === 'Y1' && l.subcategoryCode === 'indirect_hr'
    ? [line('Y1', 'indirect', 'indirect_hr', 'cash', 2_000_000), line('Y1', 'indirect', 'indirect_lab_safety', 'cash', 500_000)]
    : [l]
);

const GOV = [
  { yearId: 'Y1', govCash: 35_000_000 },
  { yearId: 'Y2', govCash: 35_000_000 },
];

function view(lines: readonly FormRowLine[]): Attachment4ViewModel {
  return buildAttachment4View({ lines, years: YEARS, stages: STAGES, govSupport: GOV, rules: [] });
}

function cell82(v: Attachment4ViewModel, rowKey: string, colKey: string): FormViewCell {
  const row = v.plan82.rows.find((r) => r.key === rowKey);
  if (row === undefined) throw new Error(`8-2 행 없음: ${rowKey}`);
  const ci = v.plan82.columns.findIndex((c) => c.key === colKey);
  if (ci < 0) throw new Error(`8-2 열 없음: ${colKey}`);
  return row.cells[ci]!;
}

function amount82(v: Attachment4ViewModel, rowKey: string, colKey: string): number | null {
  const c = cell82(v, rowKey, colKey);
  if (c.kind === 'amount') return c.value;
  if (c.kind === 'empty') return null;
  throw new Error(`금액 칸이 아닙니다: ${rowKey}/${colKey} (${c.kind})`);
}

function rate82(v: Attachment4ViewModel, rowKey: string, colKey: string): number | null {
  const c = cell82(v, rowKey, colKey);
  if (c.kind !== 'rate') throw new Error(`비율 칸이 아닙니다: ${rowKey}/${colKey}`);
  return c.rate.value === null ? null : Math.round(c.rate.value * 10_000) / 10_000;
}

function metrics(v: Attachment4ViewModel, colKey: string) {
  return v.plan82.metrics[v.plan82.columns.findIndex((c) => c.key === colKey)]!;
}

// ─── 대응 ─────────────────────────────────────────────────────────────────────

describe('대응 — 안전관리비 줄은 L 한 행에만 들어가고 내역 행에도 보인다', () => {
  it('formRowOf = indirect(L), breakdownRowOf = lab_safety. 다른 간접비 세목·default는 내역 아님', () => {
    expect(formRowOf('indirect', 'indirect_lab_safety')).toBe('indirect');
    expect(breakdownRowOf('indirect', 'indirect_lab_safety')).toBe('lab_safety');
    expect(breakdownRowOf('indirect', 'indirect_hr')).toBeNull();
    expect(breakdownRowOf('indirect', 'default')).toBeNull();
    expect(breakdownRowOf('personnel', 'indirect_lab_safety')).toBeNull();
  });
});

// ─── 보기 (AG-3) ──────────────────────────────────────────────────────────────

describe('8-2 보기 — C.4 안전관리비 픽스처', () => {
  const base = view(VERSION_A);
  const v = view(VERSION_A_LAB);

  it('lab 행 Y1 500,000 · Y2 "—"(줄 없음) · 합계 500,000, 종류 breakdown, 편집 불가', () => {
    const row = v.plan82.rows.find((r) => r.key === 'lab_safety')!;
    expect(row).toMatchObject({ kind: 'breakdown', editable: false, axis: null, label: '(간접비 중 연구실 안전관리비)' });
    expect(cell82(v, 'lab_safety', 'Y1')).toEqual({ kind: 'amount', value: 500_000 });
    expect(cell82(v, 'lab_safety', 'Y2')).toEqual({ kind: 'empty' });
    expect(amount82(v, 'lab_safety', 'total')).toBe(500_000);
  });

  it.each([
    // [열, K, L, 양식 분모, 간접비 비율, M]
    ['Y1', 50_000_000, 2_500_000, 40_000_000, 6.25, 52_500_000],
    ['Y2', 50_000_000, 2_700_000, 40_000_000, 6.75, 52_700_000],
    ['total', 100_000_000, 5_200_000, 80_000_000, 6.5, 105_200_000],
  ] as const)('%s: K %d · L %d · 양식 분모 %d → %d%% · M %d 불변(이중 계산 0)', (col, k, l, den, ir, m) => {
    expect(amount82(v, 'direct_subtotal', col)).toBe(k);
    expect(amount82(v, 'indirect', col)).toBe(l);
    expect(metrics(v, col).formIndirectBase).toBe(den);
    expect(rate82(v, 'indirect_ratio', col)).toBe(ir);
    expect(amount82(v, 'total', col)).toBe(m);
  });

  it('내역 행 말고는 세목을 나누기 전과 칸·집계·8-1이 전부 같다', () => {
    const strip = (model: Attachment4ViewModel) => ({
      rows: model.plan82.rows.filter((r) => r.key !== 'lab_safety'),
      metrics: model.plan82.metrics.map(({ breakdowns: _ignored, ...rest }) => rest),
      plan81: model.plan81,
      reviewNotes: model.reviewNotes,
    });
    expect(strip(v)).toEqual(strip(base));
  });

  it('세목 줄이 없으면 전 칸 "—"(empty) — 금액 0과 구별, 검토사항 lab_safety_no_source 없음', () => {
    for (const c of base.plan82.rows.find((r) => r.key === 'lab_safety')!.cells) expect(c).toEqual({ kind: 'empty' });
    expect(base.reviewNotes.map((n) => n.code as string)).not.toContain('lab_safety_no_source');
    expect(v.reviewNotes.map((n) => n.code as string)).not.toContain('lab_safety_no_source');
  });

  it('금액 0인 안전관리비 줄은 "—"가 아니라 0', () => {
    const zero = view([...VERSION_A, line('Y2', 'indirect', 'indirect_lab_safety', 'cash', 0)]);
    expect(cell82(zero, 'lab_safety', 'Y2')).toEqual({ kind: 'amount', value: 0 });
    expect(cell82(zero, 'lab_safety', 'Y1')).toEqual({ kind: 'empty' });
    expect(amount82(zero, 'indirect', 'Y2')).toBe(2_700_000);
  });

  it('현금 + 현물을 더해 보인다 — 현물은 L에도 그대로 한 번만', () => {
    const mixed = view([
      ...VERSION_A_LAB,
      line('Y1', 'indirect', 'indirect_lab_safety', 'in_kind', 100_000),
    ]);
    expect(amount82(mixed, 'lab_safety', 'Y1')).toBe(600_000);
    expect(amount82(mixed, 'indirect', 'Y1')).toBe(2_600_000);
    expect(amount82(mixed, 'total', 'Y1')).toBe(52_600_000);
  });

  it('표 모델: 내역 행 합계 열은 연차 칸의 합(sum), 표 검증 통과', () => {
    const t = attachment4Tables(v, { plan81: '8-1', plan82: '8-2' });
    assertTableModel(t.plan82);
    const r = v.plan82.rows.findIndex((x) => x.key === 'lab_safety');
    const row = t.plan82.rows[r]!;
    expect(row.cells[2]).toEqual({ kind: 'amount', value: 500_000 });
    expect(row.cells[3]).toEqual({ kind: 'empty' });
    expect(row.cells[4]).toEqual({ kind: 'sum', value: 500_000, terms: [{ row: r, col: 2 }, { row: r, col: 3 }] });
  });

  it('8-2 칸 편집(form-edit)에서 lab 행은 not_editable', () => {
    const lines = VERSION_A_LAB.map((l, i) => ({ ...l, id: `L${i}` }));
    expect(resolveFormCellEdit(lines, { yearId: 'Y1', rowId: 'lab_safety', axis: null, amount: 700_000 })).toMatchObject({
      kind: 'reject',
      reason: 'not_editable',
    });
  });
});

// ─── 가져오기 (AV-7 ②) ────────────────────────────────────────────────────────

const FIXTURES = path.resolve(__dirname, '../fixtures/attachment4');
const S82 = '8-2. 연구개발비 사용계획';

function load(name: string): RawSheet[] {
  return JSON.parse(fs.readFileSync(path.join(FIXTURES, name), 'utf8')) as RawSheet[];
}

function set(sheets: RawSheet[], a1: string, value: RawCell['value']): void {
  const m = /^([A-Z]+)(\d+)$/.exec(a1)!;
  const c = m[1]!.split('').reduce((n, ch) => n * 26 + ch.charCodeAt(0) - 64, 0) - 1;
  const r = Number(m[2]) - 1;
  const s = sheets.find((x) => x.name === S82)!;
  while (s.cells.length <= r) s.cells.push([]);
  const row = s.cells[r]!;
  while (row.length <= c) row.push({ value: null, isError: false });
  row[c] = { value, isError: false };
}

const YEARS2: Attachment4YearInput[] = [
  { id: 'Y1', name: '1차년도', order: 1 },
  { id: 'Y2', name: '2차년도', order: 2 },
];

function ok(result: Attachment4ParseResult) {
  if (result.status !== 'ok') throw new Error(`expected ok, got ${result.status}: ${JSON.stringify(result).slice(0, 600)}`);
  return result;
}
function blockedIssues(result: Attachment4ParseResult) {
  if (result.status !== 'blocked') throw new Error(`expected blocked, got ${result.status}`);
  return result.issues;
}
const total = (lines: readonly Attachment4Line[]) => lines.reduce((s, l) => s + l.amount, 0);
const indirectOf = (lines: readonly Attachment4Line[], yearId: string) =>
  lines.filter((l) => l.yearId === yearId && l.category === 'indirect');

// synthetic-lab-safety.json — 기관가 블록, 연차 열 H·I, L = 48행(2,500·2,700천원), 안전관리비 = 40행(500·0천원)
const parse = (sheets: RawSheet[]) => parseAttachment4({ sheets, years: YEARS2, blockIndex: 0 });

describe('가져오기 — C.4 안전관리비 픽스처', () => {
  it('L 2,500천원 + lab 500천원 → default 2,000,000 + lab 500,000, L 합 = 파일 L, 줄 합계 105,200,000, 경고 0', () => {
    const result = ok(parse(load('synthetic-lab-safety.json')));
    expect(indirectOf(result.lines, 'Y1')).toEqual([
      { yearId: 'Y1', category: 'indirect', subcategoryCode: 'default', axis: 'cash', amount: 2_000_000 },
      { yearId: 'Y1', category: 'indirect', subcategoryCode: 'indirect_lab_safety', axis: 'cash', amount: 500_000 },
    ]);
    expect(total(indirectOf(result.lines, 'Y1'))).toBe(2_500_000);
    // Y2 안전관리비 0 → 줄 없음, L default 그대로
    expect(indirectOf(result.lines, 'Y2')).toEqual([
      { yearId: 'Y2', category: 'indirect', subcategoryCode: 'default', axis: 'cash', amount: 2_700_000 },
    ]);
    expect(total(result.lines)).toBe(105_200_000);
    expect(result.warnings).toEqual([]);
    // 8-1 정합(현금 = A + B)도 파일 L 그대로라 그대로 맞는다
    expect(result.plan81.years.map((y) => y.matches)).toEqual([true, true]);
    expect(result.plan81.years[0]!.imported).toEqual({ cash: 42_500_000, inKind: 10_000_000, total: 52_500_000 });
  });

  it('가져온 줄을 보기로 돌리면 lab 행 Y1 500,000 · L 2,500,000 · M 52,500,000', () => {
    const result = ok(parse(load('synthetic-lab-safety.json')));
    const v = view(result.lines);
    expect(amount82(v, 'lab_safety', 'Y1')).toBe(500_000);
    expect(amount82(v, 'lab_safety', 'Y2')).toBeNull();
    expect(amount82(v, 'indirect', 'Y1')).toBe(2_500_000);
    expect(amount82(v, 'total', 'Y1')).toBe(52_500_000);
    expect(amount82(v, 'total', 'total')).toBe(105_200_000);
  });

  it('lab = L → L default 줄 없음, lab 줄만', () => {
    const sheets = load('synthetic-lab-safety.json');
    set(sheets, 'H40', 2_500);
    const result = ok(parse(sheets));
    expect(indirectOf(result.lines, 'Y1')).toEqual([
      { yearId: 'Y1', category: 'indirect', subcategoryCode: 'indirect_lab_safety', axis: 'cash', amount: 2_500_000 },
    ]);
    expect(total(result.lines)).toBe(105_200_000);
  });

  it('lab 3,000 > L 2,500 → blocking lab_safety_exceeds_indirect(위치·두 금액)', () => {
    const sheets = load('synthetic-lab-safety.json');
    set(sheets, 'H40', 3_000);
    const issues = blockedIssues(parse(sheets));
    expect(issues.map((i) => [i.code, i.cell])).toEqual([['lab_safety_exceeds_indirect', 'H40']]);
    expect(issues[0]!.message).toContain('H40');
    expect(issues[0]!.message).toContain('H48');
    expect(issues[0]!.message).toContain('3,000,000원');
    expect(issues[0]!.message).toContain('2,500,000원');
  });

  it('L이 빈 칸인데 lab만 있다 → blocking(L 0보다 크다)', () => {
    const sheets = load('synthetic-lab-safety.json');
    set(sheets, 'H48', null);
    expect(blockedIssues(parse(sheets)).map((i) => [i.code, i.cell])).toEqual([['lab_safety_exceeds_indirect', 'H40']]);
  });

  it('두 연차 모두 안전관리비 → 연차마다 따로 뺀다', () => {
    const sheets = load('synthetic-lab-safety.json');
    set(sheets, 'I40', 200);
    const result = ok(parse(sheets));
    expect(indirectOf(result.lines, 'Y2')).toEqual([
      { yearId: 'Y2', category: 'indirect', subcategoryCode: 'default', axis: 'cash', amount: 2_500_000 },
      { yearId: 'Y2', category: 'indirect', subcategoryCode: 'indirect_lab_safety', axis: 'cash', amount: 200_000 },
    ]);
    expect(total(result.lines)).toBe(105_200_000);
  });

  it('안전관리비 음수·문자 → blocking(조용히 빠지지 않는다), 초과 판정은 겹쳐 내지 않는다', () => {
    const neg = load('synthetic-lab-safety.json');
    set(neg, 'H40', -100);
    expect(blockedIssues(parse(neg)).map((i) => [i.code, i.cell])).toEqual([['negative_amount', 'H40']]);
    const txt = load('synthetic-lab-safety.json');
    set(txt, 'H40', '미정');
    expect(blockedIssues(parse(txt)).map((i) => [i.code, i.cell])).toEqual([['invalid_amount', 'H40']]);
  });

  it('남는 연차 열의 안전관리비는 남는 열 합계에 다시 더하지 않는다(L에 이미 들어 있다)', () => {
    const sheets = load('synthetic-lab-safety.json');
    set(sheets, 'I40', 200);
    const result = ok(parseAttachment4({ sheets, years: [YEARS2[0]!], blockIndex: 0 }));
    const mismatch = result.warnings.find((w) => w.code === 'year_count_mismatch')!;
    // 기관가 블록 I열 데이터 합(천원): 32,000 + 10,000 + 4,000 + 1,000 + 3,000 + 2,700 = 52,700
    expect(mismatch.difference).toBe(52_700_000);
  });
});
