// 붙임4 파서(격자 → 금액 줄 + 정부지원 현금) — SOT §5.21 AV-7, 부록 C.4, 계획서 S-13·S-14 "파서" 픽스처.
//
// 픽스처(tests/fixtures/attachment4/*.json)는 **실데이터가 아니다.** 실측 양식(samples/ 붙임4)의 행·열 배치,
// 병합, 머리 행 구조만 본뜬 익명 합성 격자다 — 기관명(`기관가`·`가나\n연구원` 등)·과제명·숫자는 전부 지어낸 값이다.
// - synthetic.json: 총합 + 기관 블록 2개, 천원 단위, 기관 블록 `기관가` = Phase 24 S-20 버전 A ÷ 1,000
// - synthetic-single-block.json: 같은 것에서 기관 블록 1개
// - synthetic-3-year-columns.json: 연차 열 3개
// - real-structure.json: 실측 배치(기관 블록 6개 × 23행, 1단계 1~4차년도 + 합계 + 검토사항, 8-2 단위 표기 없음,
//   인건비 소계 행이 입력 칸 0) — 숫자는 합성

import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import {
  parseAttachment4,
  type Attachment4Line,
  type Attachment4ParseResult,
  type Attachment4YearInput,
} from '@/lib/agreement/attachment4-parse';
import type { RawCell, RawSheet } from '@/lib/import/types';

const FIXTURES = path.resolve(__dirname, '../fixtures/attachment4');

function load(name: string): RawSheet[] {
  return JSON.parse(fs.readFileSync(path.join(FIXTURES, name), 'utf8')) as RawSheet[];
}

const S82 = '8-2. 연구개발비 사용계획';
const S81 = '8-1. 연구개발비 지원 및 부담계획';

function sheet(sheets: RawSheet[], name: string): RawSheet {
  const found = sheets.find((s) => s.name === name);
  if (!found) throw new Error(`no sheet ${name}`);
  return found;
}

function at(a1: string): { r: number; c: number } {
  const m = /^([A-Z]+)(\d+)$/.exec(a1)!;
  const c = m[1]!.split('').reduce((n, ch) => n * 26 + ch.charCodeAt(0) - 64, 0) - 1;
  return { r: Number(m[2]) - 1, c };
}

function set(sheets: RawSheet[], name: string, a1: string, value: RawCell['value'] | RawCell): void {
  const { r, c } = at(a1);
  const s = sheet(sheets, name);
  while (s.cells.length <= r) s.cells.push([]);
  const row = s.cells[r]!;
  while (row.length <= c) row.push({ value: null, isError: false });
  row[c] = value !== null && typeof value === 'object' ? value : { value, isError: false };
}

function get(sheets: RawSheet[], name: string, a1: string): RawCell['value'] {
  const { r, c } = at(a1);
  return sheet(sheets, name).cells[r]?.[c]?.value ?? null;
}

function removeUnitMarks(s: RawSheet): void {
  for (const row of s.cells) {
    for (let c = 0; c < row.length; c += 1) {
      if (typeof row[c]!.value === 'string' && String(row[c]!.value).includes('단위')) row[c] = { value: null, isError: false };
    }
  }
}

const YEARS2: Attachment4YearInput[] = [
  { id: 'Y1', name: '1차년도', order: 1 },
  { id: 'Y2', name: '2차년도', order: 2 },
];
const YEARS3: Attachment4YearInput[] = [...YEARS2, { id: 'Y3', name: '3차년도', order: 3 }];
const YEARS4: Attachment4YearInput[] = [...YEARS3, { id: 'Y4', name: '4차년도', order: 4 }];

function ok(result: Attachment4ParseResult) {
  if (result.status !== 'ok') throw new Error(`expected ok, got ${result.status}: ${JSON.stringify(result).slice(0, 600)}`);
  return result;
}
function blockedIssues(result: Attachment4ParseResult) {
  if (result.status !== 'blocked') throw new Error(`expected blocked, got ${result.status}`);
  return result.issues;
}
const total = (lines: readonly Attachment4Line[]) => lines.reduce((s, l) => s + l.amount, 0);
const codes = (warnings: readonly { code: string }[]) => warnings.map((w) => w.code);

// 버전 A(Phase 24 S-20)를 가져오면 나와야 하는 줄 — 인건비 A는 세목, 나머지는 default
const VERSION_A_LINES: Attachment4Line[] = [
  { yearId: 'Y1', category: 'personnel', subcategoryCode: 'personnel_internal', axis: 'cash', amount: 30_000_000 },
  { yearId: 'Y1', category: 'personnel', subcategoryCode: 'personnel_internal', axis: 'in_kind', amount: 10_000_000 },
  { yearId: 'Y1', category: 'material', subcategoryCode: 'default', axis: 'cash', amount: 5_000_000 },
  { yearId: 'Y1', category: 'activity', subcategoryCode: 'default', axis: 'cash', amount: 2_000_000 },
  { yearId: 'Y1', category: 'allowance', subcategoryCode: 'default', axis: 'cash', amount: 3_000_000 },
  { yearId: 'Y1', category: 'indirect', subcategoryCode: 'default', axis: 'cash', amount: 2_500_000 },
  { yearId: 'Y2', category: 'personnel', subcategoryCode: 'personnel_internal', axis: 'cash', amount: 32_000_000 },
  { yearId: 'Y2', category: 'personnel', subcategoryCode: 'personnel_internal', axis: 'in_kind', amount: 10_000_000 },
  { yearId: 'Y2', category: 'material', subcategoryCode: 'default', axis: 'cash', amount: 4_000_000 },
  { yearId: 'Y2', category: 'activity', subcategoryCode: 'default', axis: 'cash', amount: 1_000_000 },
  { yearId: 'Y2', category: 'allowance', subcategoryCode: 'default', axis: 'cash', amount: 3_000_000 },
  { yearId: 'Y2', category: 'indirect', subcategoryCode: 'default', axis: 'cash', amount: 2_700_000 },
];

// synthetic.json 좌표 — 기관가 블록 28~50행(실측과 같은 오프셋), 연차 열 H·I, 8-1 기관가 행 10(Y1)·14(Y2)

describe('기본 — 총합 + 기관 블록 2개, 천원', () => {
  it('블록이 여럿이고 blockIndex가 없으면 choose-block — 총합 블록은 목록에 없고 B열 텍스트 그대로', () => {
    const result = parseAttachment4({ sheets: load('synthetic.json'), years: YEARS2 });
    expect(result).toEqual({
      status: 'choose-block',
      blocks: [
        { index: 0, label: '기관가', startRow: 28, endRow: 50 },
        { index: 1, label: '가나\n연구원', startRow: 51, endRow: 73 },
      ],
    });
  });

  it('blockIndex 0 → 버전 A 줄(합계 105,200,000), 정부지원 현금 {Y1: 35,000,000, Y2: 35,000,000}, 경고 없음', () => {
    const result = ok(parseAttachment4({ sheets: load('synthetic.json'), years: YEARS2, blockIndex: 0 }));
    expect(result.lines).toEqual(VERSION_A_LINES);
    expect(total(result.lines)).toBe(105_200_000);
    expect(result.govCash).toEqual({ Y1: 35_000_000, Y2: 35_000_000 });
    expect(result.warnings).toEqual([]);
    expect(result.blockLabel).toBe('기관가');
    expect(result.unit).toEqual({ unit: 1000, text: '(단위: 천원)', sheet: S82 });
    expect(result.plan81.mode).toBe('auto');
    expect(result.plan81.years.map((y) => [y.yearId, y.cell, y.govCash, y.matches])).toEqual([
      ['Y1', 'C10', 35_000_000, true],
      ['Y2', 'C14', 35_000_000, true],
    ]);
    expect(result.plan81.years[0]!.imported).toEqual({ cash: 42_500_000, inKind: 10_000_000, total: 52_500_000 });
  });

  it('연차 입력 순서와 무관하게 order로 맞춘다', () => {
    const result = ok(parseAttachment4({ sheets: load('synthetic.json'), years: [YEARS2[1]!, YEARS2[0]!], blockIndex: 0 }));
    expect(result.lines).toEqual(VERSION_A_LINES);
  });

  it('두 번째 블록 — 8-2 `가나\\n연구원` ↔ 8-1 `가나연구원`(공백 정규화), 인건비 B·C·D 세목 줄, 통합관리비 값은 무시', () => {
    const result = ok(parseAttachment4({ sheets: load('synthetic.json'), years: YEARS2, blockIndex: 1 }));
    expect(result.warnings).toEqual([]);
    expect(result.govCash).toEqual({ Y1: 30_000_000, Y2: 30_000_000 });
    const y1 = result.lines.filter((l) => l.yearId === 'Y1');
    expect(y1).toEqual([
      { yearId: 'Y1', category: 'personnel', subcategoryCode: 'personnel_external', axis: 'cash', amount: 1_000_000 },
      { yearId: 'Y1', category: 'personnel', subcategoryCode: 'personnel_internal', axis: 'cash', amount: 20_000_000 },
      { yearId: 'Y1', category: 'personnel', subcategoryCode: 'personnel_support', axis: 'cash', amount: 500_000 },
      { yearId: 'Y1', category: 'student_personnel', subcategoryCode: 'student_general', axis: 'cash', amount: 2_000_000 },
      { yearId: 'Y1', category: 'facility_equipment', subcategoryCode: 'default', axis: 'cash', amount: 3_000_000 },
      { yearId: 'Y1', category: 'material', subcategoryCode: 'default', axis: 'cash', amount: 1_500_000 },
      { yearId: 'Y1', category: 'activity', subcategoryCode: 'default', axis: 'cash', amount: 700_000 },
      { yearId: 'Y1', category: 'allowance', subcategoryCode: 'default', axis: 'cash', amount: 1_200_000 },
      { yearId: 'Y1', category: 'indirect', subcategoryCode: 'default', axis: 'cash', amount: 2_900_000 },
    ]);
  });
});

describe('블록 선택 (G-11)', () => {
  it('블록 1개 → blockIndex 없이 바로', () => {
    const result = ok(parseAttachment4({ sheets: load('synthetic-single-block.json'), years: YEARS2 }));
    expect(result.blockIndex).toBe(0);
    expect(total(result.lines)).toBe(105_200_000);
    expect(result.blocks).toHaveLength(1);
  });

  it.each([2, -1, 0.5])('범위 밖 blockIndex %s → blocking', (blockIndex) => {
    const issues = blockedIssues(parseAttachment4({ sheets: load('synthetic.json'), years: YEARS2, blockIndex }));
    expect(issues.map((i) => i.code)).toEqual(['block_out_of_range']);
  });

  it('총합 블록은 읽지 않는다 — 그 안의 모르는 라벨도 막지 않는다', () => {
    const sheets = load('synthetic.json');
    set(sheets, S82, 'D14', '이상한 라벨');
    expect(ok(parseAttachment4({ sheets, years: YEARS2, blockIndex: 0 })).lines).toEqual(VERSION_A_LINES);
  });
});

describe('8-1 행 찾기 (S-14)', () => {
  it('텍스트가 같은 행이 없으면 choose-81-row — 후보는 연차 블록 안 위치, 비율 행은 후보가 아니다', () => {
    const sheets = load('synthetic.json');
    set(sheets, S81, 'C10', '(주)기관가');
    set(sheets, S81, 'C14', '(주)기관가');
    const result = parseAttachment4({ sheets, years: YEARS2, blockIndex: 0 });
    if (result.status !== 'choose-81-row') throw new Error(result.status);
    expect(result.reason).toBe('no-match');
    expect(result.blockLabel).toBe('기관가');
    expect(result.candidates).toEqual([
      { index: 0, label: '(주)기관가', rows: [{ yearOrder: 0, label: '(주)기관가', cell: 'C10' }, { yearOrder: 1, label: '(주)기관가', cell: 'C14' }] },
      { index: 1, label: '가나연구원', rows: [{ yearOrder: 0, label: '가나연구원', cell: 'C12' }, { yearOrder: 1, label: '가나연구원', cell: 'C16' }] },
    ]);

    const chosen = ok(parseAttachment4({ sheets, years: YEARS2, blockIndex: 0, plan81Row: 0 }));
    expect(chosen.plan81.mode).toBe('chosen');
    expect(chosen.plan81.rowIndex).toBe(0);
    expect(chosen.govCash).toEqual({ Y1: 35_000_000, Y2: 35_000_000 });
    expect(chosen.warnings).toEqual([]);
  });

  it('한 연차에 같은 텍스트 행이 둘이면 multiple-match', () => {
    const sheets = load('synthetic.json');
    set(sheets, S81, 'C12', '기관가');
    const result = parseAttachment4({ sheets, years: YEARS2, blockIndex: 0 });
    expect(result.status).toBe('choose-81-row');
    if (result.status === 'choose-81-row') expect(result.reason).toBe('multiple-match');
  });

  it('"8-1 쓰지 않음" → 정부지원 현금 행 없음 + 경고, 줄은 그대로', () => {
    const result = ok(parseAttachment4({ sheets: load('synthetic.json'), years: YEARS2, blockIndex: 0, plan81Row: 'none' }));
    expect(result.govCash).toEqual({});
    expect(result.plan81).toEqual({ mode: 'none', rowIndex: null, years: [] });
    expect(codes(result.warnings)).toEqual(['plan81_not_used']);
    expect(result.lines).toEqual(VERSION_A_LINES);
  });

  it('범위 밖 plan81Row → blocking', () => {
    const issues = blockedIssues(parseAttachment4({ sheets: load('synthetic.json'), years: YEARS2, blockIndex: 0, plan81Row: 2 }));
    expect(issues.map((i) => i.code)).toEqual(['plan81_row_out_of_range']);
  });

  it('8-1 기관부담 현금 −1,000천원 → 정합 경고(위치·차액), 반영은 막지 않는다', () => {
    const sheets = load('synthetic.json');
    set(sheets, S81, 'F10', 6500);
    const result = ok(parseAttachment4({ sheets, years: YEARS2, blockIndex: 0 }));
    expect(result.warnings).toEqual([
      expect.objectContaining({ code: 'plan81_mismatch', sheet: S81, cell: 'F10', difference: -1_000_000 }),
    ]);
    expect(result.warnings[0]!.message).toContain('1차년도');
    expect(result.govCash).toEqual({ Y1: 35_000_000, Y2: 35_000_000 });
    expect(result.plan81.years[0]!.matches).toBe(false);
    expect(result.plan81.years[1]!.matches).toBe(true);
  });

  it('현물·합계 어긋남도 각각 경고', () => {
    const sheets = load('synthetic.json');
    set(sheets, S81, 'G14', 9000);
    set(sheets, S81, 'N14', 53_000);
    const result = ok(parseAttachment4({ sheets, years: YEARS2, blockIndex: 0 }));
    expect(result.warnings.map((w) => [w.code, w.cell, w.difference])).toEqual([
      ['plan81_mismatch', 'G14', -1_000_000],
      ['plan81_mismatch', 'N14', 300_000],
    ]);
  });

  it('그 외 기관 지원금 E·F ≠ 0 → 경고', () => {
    const sheets = load('synthetic.json');
    set(sheets, S81, 'I10', 200);
    set(sheets, S81, 'J14', 50);
    const result = ok(parseAttachment4({ sheets, years: YEARS2, blockIndex: 0 }));
    expect(result.warnings.map((w) => [w.code, w.cell, w.difference])).toEqual([
      ['plan81_other_support', 'I10', 200_000],
      ['plan81_other_support', 'J14', 50_000],
    ]);
  });

  it('정부지원 현금 0은 입력값(키 있음), 빈 칸은 미입력(키 없음 + 경고)', () => {
    const sheets = load('synthetic.json');
    set(sheets, S81, 'E10', 0);
    set(sheets, S81, 'E14', null);
    const result = ok(parseAttachment4({ sheets, years: YEARS2, blockIndex: 0 }));
    expect(result.govCash).toEqual({ Y1: 0 });
    expect(codes(result.warnings)).toContain('plan81_gov_cash_blank');
  });

  it('정부지원 현금이 음수·문자면 blocking', () => {
    const sheets = load('synthetic.json');
    set(sheets, S81, 'E10', -1);
    set(sheets, S81, 'E14', '미정');
    const issues = blockedIssues(parseAttachment4({ sheets, years: YEARS2, blockIndex: 0 }));
    expect(issues.map((i) => [i.code, i.cell])).toEqual([
      ['plan81_invalid_amount', 'E10'],
      ['plan81_invalid_amount', 'E14'],
    ]);
  });

  it('병합이 없는 8-1에서도 비율 행(기관 칸 빈 행)·비율 머리 행을 건너뛴다', () => {
    const sheets = load('synthetic.json');
    sheet(sheets, S81).merges = [];
    const result = ok(parseAttachment4({ sheets, years: YEARS2, blockIndex: 0 }));
    expect(result.govCash).toEqual({ Y1: 35_000_000, Y2: 35_000_000 });
    expect(result.warnings).toEqual([]);
  });

  it('8-1 시트가 없으면 정부지원 현금 없이 가져오고 알린다', () => {
    const sheets = load('synthetic.json').filter((s) => s.name !== S81);
    const result = ok(parseAttachment4({ sheets, years: YEARS2, blockIndex: 0 }));
    expect(result.govCash).toEqual({});
    expect(result.plan81.mode).toBe('unavailable');
    expect(codes(result.warnings)).toEqual(['plan81_unavailable']);
  });
});

describe('행 종류·금액 (S-13 ⑥~⑧)', () => {
  it('모르는 라벨 → blocking(위치·라벨)', () => {
    const sheets = load('synthetic.json');
    set(sheets, S82, 'E30', '기타인건비(X)');
    const issues = blockedIssues(parseAttachment4({ sheets, years: YEARS2, blockIndex: 0 }));
    expect(issues.map((i) => [i.code, i.cell])).toEqual([
      ['unknown_label', 'E30'],
      ['unknown_label', 'E31'],
    ]);
    expect(issues[0]!.message).toContain('기타인건비(X)');
    expect(issues[0]!.message).toContain('현금(O)');
  });

  it.each([
    ['빈 칸', null],
    ['0', 0],
    ['대시', '-'],
  ])('%s → 줄 없음 (집계 행은 파일 값과 어긋나 경고)', (_name, value) => {
    const sheets = load('synthetic.json');
    set(sheets, S82, 'H41', value);
    const result = ok(parseAttachment4({ sheets, years: YEARS2, blockIndex: 0 }));
    expect(result.lines.some((l) => l.yearId === 'Y1' && l.category === 'material')).toBe(false);
    expect(total(result.lines)).toBe(100_200_000);
    expect(result.warnings.filter((w) => w.code === 'aggregate_mismatch').map((w) => [w.cell, w.difference])).toEqual([
      ['H47', 5_000_000],
      ['H50', 5_000_000],
    ]);
  });

  it.each([
    ['음수', -5000, 'negative_amount'],
    ['문자', '오천', 'invalid_amount'],
    ['비정수(0.5원)', 0.0005, 'invalid_amount'],
    ['수식 에러', { value: '#REF!', isError: true, errorText: '#REF!' }, 'invalid_amount'],
  ] as const)('%s → blocking', (_name, value, code) => {
    const sheets = load('synthetic.json');
    set(sheets, S82, 'H41', value as RawCell['value'] | RawCell);
    const issues = blockedIssues(parseAttachment4({ sheets, years: YEARS2, blockIndex: 0 }));
    expect(issues.map((i) => [i.code, i.sheet, i.cell])).toEqual([[code, S82, 'H41']]);
  });

  it('집계 행 불일치 → 경고(위치·차액), 반영은 된다', () => {
    const sheets = load('synthetic.json');
    set(sheets, S82, 'H36', 41_000); // 양식 E1 Y1
    set(sheets, S82, 'I33', 41_000); // 인건비 소계 Y2 — 0이 아닌데 Σ(42,000)와 다르다
    const result = ok(parseAttachment4({ sheets, years: YEARS2, blockIndex: 0 }));
    expect(result.warnings.map((w) => [w.code, w.cell, w.difference])).toEqual([
      ['aggregate_mismatch', 'I33', -1_000_000],
      ['aggregate_mismatch', 'H36', 1_000_000],
    ]);
    expect(result.lines).toEqual(VERSION_A_LINES);
  });

  it.each([
    ['0', 0],
    ['빈 칸', null],
  ])('인건비 소계 칸이 %s이면 대조하지 않는다(실측 입력 칸) — 다른 집계 행은 그대로 대조', (_name, value) => {
    const sheets = load('synthetic.json');
    set(sheets, S82, 'H33', value);
    set(sheets, S82, 'I33', value);
    expect(ok(parseAttachment4({ sheets, years: YEARS2, blockIndex: 0 })).warnings).toEqual([]);
    set(sheets, S82, 'H36', 0); // 양식 E1이 0이면 경고
    expect(ok(parseAttachment4({ sheets, years: YEARS2, blockIndex: 0 })).warnings.map((w) => [w.code, w.cell])).toEqual([
      ['aggregate_mismatch', 'H36'],
    ]);
  });

  it('비율 행은 읽지 않는다 — 수식 에러여도 그대로', () => {
    const sheets = load('synthetic.json');
    set(sheets, S82, 'H46', { value: '#DIV/0!', isError: true, errorText: '#DIV/0!' });
    set(sheets, S82, 'I49', '알 수 없음');
    expect(ok(parseAttachment4({ sheets, years: YEARS2, blockIndex: 0 })).warnings).toEqual([]);
  });

  it('통합관리비(현금) 행 값 → 경고 0·줄 0 (U-3 무시)', () => {
    const sheets = load('synthetic.json');
    set(sheets, S82, 'H40', 500);
    set(sheets, S82, 'I40', 700);
    const result = ok(parseAttachment4({ sheets, years: YEARS2, blockIndex: 0 }));
    expect(result.warnings).toEqual([]);
    expect(result.lines).toEqual(VERSION_A_LINES);
  });

  it('연구실 안전관리비 행 값 ≠ 0 → 경고, 줄 0 (U-3 memo)', () => {
    const sheets = load('synthetic.json');
    set(sheets, S82, 'D40', '(간접비 중 연구실 안전관리비)');
    set(sheets, S82, 'H40', 300);
    const result = ok(parseAttachment4({ sheets, years: YEARS2, blockIndex: 0 }));
    expect(result.warnings.map((w) => [w.code, w.cell])).toEqual([['memo_nonzero', 'H40']]);
    expect(result.warnings[0]!.message).toContain('300,000원');
    expect(result.lines).toEqual(VERSION_A_LINES);
  });

  it('괄호 내역 행의 가운뎃점 변형(`·`)도 같은 행으로 본다', () => {
    const sheets = load('synthetic.json');
    set(sheets, S82, 'D40', '(연구시설·장비비 중 통합관리비(현금))');
    set(sheets, S82, 'H40', 500);
    expect(ok(parseAttachment4({ sheets, years: YEARS2, blockIndex: 0 })).warnings).toEqual([]);
  });

  it('같은 키가 두 행에서 오면 합산 + 경고', () => {
    const sheets = load('synthetic.json');
    set(sheets, S82, 'D43', '연구재료비(G)'); // 연구활동비(H) 행(D43:F44 병합)을 재료비로
    const result = ok(parseAttachment4({ sheets, years: YEARS2, blockIndex: 0 }));
    const y1Material = result.lines.find((l) => l.yearId === 'Y1' && l.category === 'material' && l.axis === 'cash');
    expect(y1Material?.amount).toBe(7_000_000);
    expect(result.lines.some((l) => l.category === 'activity')).toBe(false);
    expect(total(result.lines)).toBe(105_200_000);
    expect(codes(result.warnings)).toEqual(['duplicate_key', 'duplicate_key']);
    expect(result.warnings[0]!.cell).toBe('H43');
  });

  // 금액 줄 0개를 ok로 통과시키면 0원 협약 버전이 조용히 생긴다(AV-7 ②, 절대 규칙 5)
  function emptyBlock(value: 0 | null): RawSheet[] {
    const sheets = load('synthetic-single-block.json');
    for (let r = 28; r <= 50; r += 1) {
      for (const col of ['H', 'I', 'J']) set(sheets, S82, `${col}${r}`, value);
    }
    return sheets;
  }

  it.each([
    ['전부 0', 0],
    ['전부 빈 칸', null],
  ] as const)('블록 금액이 %s이면 blocking(no_amounts — 블록 이름·위치)', (_name, value) => {
    const result = parseAttachment4({ sheets: emptyBlock(value), years: YEARS2, plan81Row: 'none' });
    const issues = blockedIssues(result);
    expect(issues.map((i) => [i.code, i.sheet])).toEqual([['no_amounts', S82]]);
    expect(issues[0]!.message).toContain('기관가');
    expect(issues[0]!.message).toContain('28~50행');
  });

  it('8-1 정부지원 현금(A)만 있고 8-2 블록 금액이 0이어도 blocking', () => {
    const sheets = emptyBlock(0);
    expect(get(sheets, S81, 'E10')).toBe(35_000);
    const issues = blockedIssues(parseAttachment4({ sheets, years: YEARS2 }));
    expect(issues.map((i) => i.code)).toEqual(['no_amounts']);
  });
});

describe('연차 열 (S-13 ⑤)', () => {
  it('연차 열 3개 대 과제 2연차 → 앞 2개만, 경고에 남는 열 합계', () => {
    const result = ok(parseAttachment4({ sheets: load('synthetic-3-year-columns.json'), years: YEARS2, blockIndex: 0 }));
    expect(result.lines).toEqual(VERSION_A_LINES);
    const mismatch = result.warnings.find((w) => w.code === 'year_count_mismatch')!;
    expect(mismatch.difference).toBe(52_600_000);
    expect(mismatch.message).toContain('J열');
    expect(mismatch.message).toContain('52,600,000원');
    expect(codes(result.warnings)).toEqual(['year_count_mismatch', 'plan81_year_extra']);
    expect(result.govCash).toEqual({ Y1: 35_000_000, Y2: 35_000_000 });
  });

  it('연차 열 2개 대 과제 3연차 → 3연차는 줄·정부지원 현금 없음 + 경고', () => {
    const result = ok(parseAttachment4({ sheets: load('synthetic.json'), years: YEARS3, blockIndex: 0 }));
    expect(result.lines).toEqual(VERSION_A_LINES);
    expect(codes(result.warnings)).toEqual(['year_count_mismatch', 'plan81_year_missing']);
    expect(result.govCash).toEqual({ Y1: 35_000_000, Y2: 35_000_000 });
  });

  it('과제 연차가 없으면 blocking', () => {
    const issues = blockedIssues(parseAttachment4({ sheets: load('synthetic.json'), years: [], blockIndex: 0 }));
    expect(issues.map((i) => i.code)).toEqual(['no_years']);
  });
});

describe('단위·시트 (S-13 ①·④)', () => {
  it('두 시트 모두 단위 표기 없음 → blocking', () => {
    const sheets = load('synthetic.json');
    sheets.forEach(removeUnitMarks);
    const issues = blockedIssues(parseAttachment4({ sheets, years: YEARS2, blockIndex: 0 }));
    expect(issues.map((i) => i.code)).toEqual(['unit_missing']);
  });

  it('8-2에만 없으면 8-1 표기를 쓰고 알린다(실측 배치)', () => {
    const sheets = load('synthetic.json');
    removeUnitMarks(sheet(sheets, S82));
    const result = ok(parseAttachment4({ sheets, years: YEARS2, blockIndex: 0 }));
    expect(result.unit).toEqual({ unit: 1000, text: '(단위: 천원)', sheet: S81 });
    expect(codes(result.warnings)).toEqual(['unit_from_other_sheet']);
    expect(total(result.lines)).toBe(105_200_000);
  });

  it('8-2 시트가 없으면 blocking, 시트 이름 공백 차이는 같은 시트로 본다', () => {
    const missing = load('synthetic.json').filter((s) => s.name !== S82);
    expect(blockedIssues(parseAttachment4({ sheets: missing, years: YEARS2 })).map((i) => i.code)).toEqual(['sheet_missing']);

    const renamed = load('synthetic.json');
    sheet(renamed, S82).name = '8-2.연구개발비  사용계획';
    expect(ok(parseAttachment4({ sheets: renamed, years: YEARS2, blockIndex: 0 })).lines).toEqual(VERSION_A_LINES);
  });
});

describe('실측 구조 익명 픽스처 (real-structure.json)', () => {
  const sheets = () => load('real-structure.json');

  it('블록 6개 — 총합 제외, B열 텍스트 그대로', () => {
    const result = parseAttachment4({ sheets: sheets(), years: YEARS4 });
    if (result.status !== 'choose-block') throw new Error(result.status);
    expect(result.blocks.map((b) => [b.label, b.startRow, b.endRow])).toEqual([
      ['기관가', 28, 50],
      ['가나\n연구원', 51, 73],
      ['다라공사', 74, 96],
      ['마바안전공사 \n바연구원', 97, 119],
      ['사아', 120, 142],
      ['자차\n발전', 143, 165],
    ]);
  });

  it.each([0, 1, 2, 3, 4, 5])('블록 %i — 연차별 줄 합 = 파일 총액(M) 칸, 정부지원 현금 = 8-1 A, 정합 일치', (blockIndex) => {
    const grid = sheets();
    const result = ok(parseAttachment4({ sheets: grid, years: YEARS4, blockIndex }));
    const base = 28 + 23 * blockIndex;
    // 실측과 같이 8-2에 단위 표기가 없다. 인건비 소계 행은 0으로 남아 있지만 0이면 대조하지 않는다
    expect(result.unit.sheet).toBe(S81);
    expect(Number(get(grid, S82, `H${base + 5}`))).toBe(0);
    expect(result.warnings.map((w) => [w.code, w.cell])).toEqual([['unit_from_other_sheet', null]]);
    YEARS4.forEach((year, i) => {
      const col = 'HIJK'[i]!;
      const yearLines = result.lines.filter((l) => l.yearId === year.id);
      expect(total(yearLines)).toBe(Number(get(grid, S82, `${col}${base + 22}`)) * 1000);
      const e1 = yearLines
        .filter((l) => l.category === 'personnel' || l.category === 'student_personnel')
        .reduce((s, l) => s + l.amount, 0);
      expect(e1).toBe(Number(get(grid, S82, `${col}${base + 8}`)) * 1000);
      const govRow = 10 + 12 * i + 2 * blockIndex;
      expect(result.govCash[year.id]).toBe(Number(get(grid, S81, `E${govRow}`)) * 1000);
    });
    expect(result.plan81.years.every((y) => y.matches)).toBe(true);
    expect(result.plan81.mode).toBe('auto');
  });
});
