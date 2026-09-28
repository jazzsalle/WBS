// 입력 양식 파서 — 수행 모드 (SOT §6.16 IN-9·IN-11·IN-12·IN-13, §5.12 amount, 부록 F-6)
//
// 제안 모드 결과가 불변인지는 input-form-parse.test.ts가 (수정 없이) 고정한다. 여기는 수행 모드 행 읽기와
// mode 거부만 본다. 픽스처는 좌표 맵 `sheetsFor('execution')`으로 손으로 만든다 — 생성기(T4)와 무관하게.

import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import {
  EXECUTION_ISSUES,
  INPUT_FORM_VERSION,
  MODE_MISMATCH_MESSAGES,
  buildMetaRows,
  columnOf,
  sheetsFor,
} from '@/lib/input-form';
import type { FormCell, InputFormMeta, InputFormSheetKey, ParsedExecutionForm, ParsedExecutionRow } from '@/lib/input-form';
import { parseInputForm } from '@/lib/input-form/parse';
import { dateOutOfYearIssue, excelSerialToISO } from '@/lib/input-form/parse-execution';
import type { RawCell, RawSheet } from '@/lib/import/types';

// ─── 픽스처 빌더 ─────────────────────────────────────────────

type CellInput = RawCell | string | number | null | undefined;

function toCell(input: CellInput): RawCell {
  if (input === undefined || input === null) return { value: null, isError: false };
  if (typeof input === 'object') return input;
  return { value: input, isError: false };
}

function sheetOf(
  key: Exclude<InputFormSheetKey, 'meta'>,
  rows: Record<string, CellInput>[],
  mode: 'plan' | 'execution' = 'execution'
): RawSheet {
  const def = sheetsFor(mode)[key];
  const cells: RawCell[][] = [];
  for (let r = 1; r < def.headerRow; r += 1) cells.push([]);
  cells.push(def.columns.map((column) => toCell(column.label)));
  for (let r = def.headerRow + 1; r < def.dataStartRow; r += 1) cells.push([]);
  for (const row of rows) {
    const line: RawCell[] = def.columns.map(() => toCell(null));
    for (const [role, value] of Object.entries(row)) line[columnOf(def, role)] = toCell(value);
    cells.push(line);
  }
  return { name: def.name, cells, merges: [] };
}

function metaSheetOf(meta: InputFormMeta): RawSheet {
  const cells: RawCell[][] = buildMetaRows(meta).map((row: FormCell[]) =>
    row.map((cell) => ({ value: cell.value ?? null, isError: false }))
  );
  return { name: sheetsFor('execution').meta.name, cells, merges: [] };
}

const META: InputFormMeta = {
  formVersion: INPUT_FORM_VERSION,
  projectId: 'proj-1',
  yearId: 'year-1',
  generatedAt: '2026-09-28T09:00:00.000Z',
  subcategoryCodes: ['activity:activity_meeting', 'activity:', 'personnel:', 'indirect:'],
  memberIds: ['m-1', 'm-2'],
  mode: 'execution',
  executions: { 'e-1': 3, 'e-2': 1 },
  detailIds: ['d-1', 'd-9'],
};

const PLAN_META: InputFormMeta = {
  formVersion: INPUT_FORM_VERSION,
  projectId: 'proj-1',
  yearId: 'year-1',
  generatedAt: '2026-09-28T09:00:00.000Z',
  subcategoryCodes: ['activity:activity_meeting'],
  memberIds: ['m-1'],
};

const EXPECTED = { projectId: 'proj-1', formVersion: INPUT_FORM_VERSION };

// 2026-03-05의 엑셀 직렬값 (2026-01-01 = 46023)
const SERIAL_2026_03_05 = 46086;

function parseExecution(
  personnel: Record<string, CellInput>[],
  budget: Record<string, CellInput>[],
  meta: InputFormMeta = META
): ParsedExecutionForm {
  const result = parseInputForm(
    [metaSheetOf(meta), sheetOf('personnel', personnel), sheetOf('budget', budget)],
    EXPECTED,
    'execution'
  );
  if (!result.ok) throw new Error(`거부됨: ${result.rejection.message}`);
  return result.parsed;
}

function onlyBudget(row: Record<string, CellInput>): ParsedExecutionRow {
  const parsed = parseExecution([], [row]);
  expect(parsed.budget).toHaveLength(1);
  return parsed.budget[0]!;
}

function onlyPersonnel(row: Record<string, CellInput>): ParsedExecutionRow {
  const parsed = parseExecution([row], []);
  expect(parsed.personnel).toHaveLength(1);
  return parsed.personnel[0]!;
}

function kinds(row: ParsedExecutionRow): string[] {
  return row.issues.map((issue) => issue.kind);
}

function blockingKinds(row: ParsedExecutionRow): string[] {
  return row.issues.filter((issue) => issue.blocking).map((issue) => issue.kind);
}

const BUDGET_OK: Record<string, CellInput> = {
  subcategory: 'activity:activity_meeting',
  detailId: 'd-9',
  executionId: 'e-1',
  executionDate: '2026-03-05',
  name: '착수회의',
  spec: '10인',
  unitPrice: 50_000,
  factor1: 4,
  axis: '현금',
  amount: 200_000,
  note: '비고',
};

const PERSONNEL_OK: Record<string, CellInput> = {
  memberId: 'm-1',
  detailId: 'd-1',
  executionId: 'e-2',
  executionDate: SERIAL_2026_03_05,
  subcategory: '내부인건비',
  participation: 28,
  months: 9,
  axis: '현물',
  amount: 15_540_000,
  note: '3월분',
};

// ─── mode 거부 (IN-9) ────────────────────────────────────────

describe('parseInputForm — mode 거부 (IN-9)', () => {
  it('제안 양식을 수행 모드로 올리면 파일의 mode 문구로 거부한다', () => {
    const result = parseInputForm(
      [metaSheetOf(PLAN_META), sheetOf('personnel', [], 'plan'), sheetOf('budget', [], 'plan')],
      EXPECTED,
      'execution'
    );
    expect(result).toEqual({
      ok: false,
      rejection: { kind: 'mode-mismatch', message: MODE_MISMATCH_MESSAGES.plan },
    });
  });

  it('수행 양식을 제안 모드(생략)로 올리면 거부한다', () => {
    const sheets = [metaSheetOf(META), sheetOf('personnel', []), sheetOf('budget', [])];
    const expectedRejection = {
      ok: false,
      rejection: { kind: 'mode-mismatch', message: MODE_MISMATCH_MESSAGES.execution },
    };
    expect(parseInputForm(sheets, EXPECTED)).toEqual(expectedRejection);
    expect(parseInputForm(sheets, EXPECTED, 'plan')).toEqual(expectedRejection);
  });

  it('과제가 다르면 mode보다 먼저 과제 불일치다', () => {
    const result = parseInputForm(
      [metaSheetOf(PLAN_META), sheetOf('personnel', []), sheetOf('budget', [])],
      { projectId: 'other', formVersion: INPUT_FORM_VERSION },
      'execution'
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.rejection.kind).toBe('project-mismatch');
  });

  it('수행 모드에서도 _meta·시트가 없으면 거부한다', () => {
    const noMeta = parseInputForm([sheetOf('personnel', []), sheetOf('budget', [])], EXPECTED, 'execution');
    expect(noMeta.ok).toBe(false);
    if (!noMeta.ok) expect(noMeta.rejection.kind).toBe('no-meta');

    const noBudget = parseInputForm([metaSheetOf(META), sheetOf('personnel', [])], EXPECTED, 'execution');
    expect(noBudget.ok).toBe(false);
    if (!noBudget.ok) expect(noBudget.rejection.kind).toBe('missing-sheet');
  });

  it('통과하면 _meta의 수행 목록을 그대로 싣는다', () => {
    const parsed = parseExecution([], []);
    expect(parsed.meta.mode).toBe('execution');
    expect(parsed.meta.executions).toEqual({ 'e-1': 3, 'e-2': 1 });
    expect(parsed.meta.detailIds).toEqual(['d-1', 'd-9']);
    expect(parsed.issues).toEqual([]);
  });
});

// ─── 집행일 (IN-11, F-6) ─────────────────────────────────────

describe('excelSerialToISO — 1900 날짜 체계', () => {
  it.each([
    [1, '1900-01-01'],
    [59, '1900-02-28'],
    [61, '1900-03-01'],
    [45292, '2024-01-01'],
    [45658, '2025-01-01'],
    [46023, '2026-01-01'],
    [SERIAL_2026_03_05, '2026-03-05'],
    [2_958_465, '9999-12-31'],
  ])('%d → %s', (serial, iso) => {
    expect(excelSerialToISO(serial)).toBe(iso);
  });

  it.each([
    [60, '엑셀이 넣은 없는 날 1900-02-29'],
    [0, '0일'],
    [-1, '음수'],
    [45658.5, '시각이 섞인 값'],
    [2_958_466, '9999년 이후'],
    [Number.NaN, 'NaN'],
  ])('%d는 날짜가 아니다 (%s)', (serial) => {
    expect(excelSerialToISO(serial)).toBeNull();
  });
});

describe('수행 행 — 집행일', () => {
  it('직렬값과 yyyy-mm-dd 문자열이 모두 ISO가 된다', () => {
    expect(onlyBudget({ ...BUDGET_OK, executionDate: SERIAL_2026_03_05 }).date).toBe('2026-03-05');
    expect(onlyBudget({ ...BUDGET_OK, executionDate: '2026-03-05' }).date).toBe('2026-03-05');
    expect(onlyBudget({ ...BUDGET_OK, executionDate: '  2026-03-05 ' }).date).toBe('2026-03-05');
  });

  it('비면 blocking no-date', () => {
    const row = onlyBudget({ ...BUDGET_OK, executionDate: null });
    expect(row.date).toBeNull();
    expect(blockingKinds(row)).toEqual(['no-date']);
    expect(row.issues[0]!.message).toBe(EXECUTION_ISSUES['no-date'].message);
  });

  it.each([
    ['2026-02-30', '달력에 없는 날'],
    ['2026/03/05', '다른 구분자'],
    ['26-03-05', '두 자리 연도'],
    ['3월 5일', '한글 표기'],
    ['46086', '숫자 문자열'],
  ])('%s는 blocking invalid-date (%s)', (text) => {
    const row = onlyBudget({ ...BUDGET_OK, executionDate: text });
    expect(row.date).toBeNull();
    expect(blockingKinds(row)).toEqual(['invalid-date']);
  });

  it('직렬값이 날짜가 아니면(소수·60) blocking invalid-date', () => {
    expect(blockingKinds(onlyBudget({ ...BUDGET_OK, executionDate: 46086.25 }))).toEqual(['invalid-date']);
    expect(blockingKinds(onlyBudget({ ...BUDGET_OK, executionDate: 60 }))).toEqual(['invalid-date']);
  });

  it('에러 셀은 blocking invalid-date', () => {
    const row = onlyBudget({ ...BUDGET_OK, executionDate: { value: '#REF!', isError: true, errorText: '#REF!' } });
    expect(blockingKinds(row)).toEqual(['invalid-date']);
  });
});

describe('dateOutOfYearIssue (S-14 — 미리보기가 부른다)', () => {
  const year = { startDate: '2026-04-01', endDate: '2026-12-31' };

  it('연차 기간 안이면 null (양끝 포함)', () => {
    expect(dateOutOfYearIssue('2026-04-01', year)).toBeNull();
    expect(dateOutOfYearIssue('2026-12-31', year)).toBeNull();
  });

  it('밖이면 막지 않는 경고', () => {
    const issue = dateOutOfYearIssue('2026-03-31', year);
    expect(issue).toMatchObject({ kind: 'date-out-of-year', blocking: false });
    expect(dateOutOfYearIssue('2027-01-01', year)?.kind).toBe('date-out-of-year');
  });

  it('연차 날짜가 없으면 그 끝은 판정하지 않는다', () => {
    expect(dateOutOfYearIssue('2000-01-01', { startDate: null, endDate: null })).toBeNull();
    expect(dateOutOfYearIssue('2000-01-01', { startDate: null, endDate: '2026-12-31' })).toBeNull();
    expect(dateOutOfYearIssue('2027-01-01', { startDate: null, endDate: '2026-12-31' })?.kind).toBe(
      'date-out-of-year'
    );
  });
});

// ─── 금액 (§5.12, IN-11) ─────────────────────────────────────

describe('수행 행 — 금액', () => {
  it('정상 행: 금액은 입력값, 문제 없음', () => {
    const row = onlyBudget(BUDGET_OK);
    expect(row).toEqual({
      rowIndex: 2,
      executionId: 'e-1',
      category: 'activity',
      subcategoryCode: 'activity_meeting',
      memberId: null,
      detailId: 'd-9',
      date: '2026-03-05',
      description: '착수회의',
      spec: '10인',
      unitPrice: 50_000,
      factors: [{ label: '회', value: 4, isPercent: false }],
      axis: 'cash',
      amount: 200_000,
      note: '비고',
      issues: [],
    });
  });

  it.each([
    [-1, 'amount-negative'],
    [1000.5, 'amount-not-integer'],
    ['abc', 'amount-invalid'],
  ])('금액 %s는 blocking %s이고 값은 null', (amount, kind) => {
    const row = onlyBudget({ ...BUDGET_OK, unitPrice: null, factor1: null, amount });
    expect(row.amount).toBeNull();
    expect(blockingKinds(row)).toEqual([kind]);
  });

  it('금액 0은 받는다', () => {
    const row = onlyBudget({ ...BUDGET_OK, unitPrice: null, factor1: null, amount: 0 });
    expect(row.amount).toBe(0);
    expect(row.issues).toEqual([]);
  });

  it('사업비: 금액이 비면 단가 × 인자로 채운다 (PL-1, 조정액 없음)', () => {
    const row = onlyBudget({ ...BUDGET_OK, factor2: 1.5, amount: null, adjustment: 999 });
    // 50,000 × 4(회) — activity_meeting 프리셋은 인자 1개라 인자2는 프리셋 밖(경고)이지만 곱에는 들어간다
    expect(row.amount).toBe(300_000);
    expect(blockingKinds(row)).toEqual([]);
  });

  it('사업비: 인자가 없으면 단가 그대로(PL-1의 빈 곱 = 1)', () => {
    const row = onlyBudget({ ...BUDGET_OK, subcategory: 'indirect:', unitPrice: 123_456, factor1: null, amount: null });
    expect(row.amount).toBe(123_456);
    expect(row.issues).toEqual([]);
  });

  it('사업비: 소수 인자 곱은 한 번만 반올림한다', () => {
    const row = onlyBudget({ ...BUDGET_OK, unitPrice: 33_333, factor1: 0.5, amount: null });
    expect(row.amount).toBe(16_667);
  });

  it('사업비: 둘 다 있고 다르면 경고 amount-mismatch, 입력 금액이 이긴다', () => {
    const row = onlyBudget({ ...BUDGET_OK, amount: 210_000 });
    expect(row.amount).toBe(210_000);
    expect(kinds(row)).toEqual(['amount-mismatch']);
    expect(row.issues[0]!.blocking).toBe(false);
    expect(row.issues[0]!.message).toContain('210000');
    expect(row.issues[0]!.message).toContain('200000');
  });

  it('사업비: 금액만 있으면(단가 없음) 그대로, 경고 없음', () => {
    const row = onlyBudget({ ...BUDGET_OK, unitPrice: null, factor1: null, amount: 77_000 });
    expect(row.amount).toBe(77_000);
    expect(row.unitPrice).toBeNull();
    expect(row.factors).toBeNull();
    expect(row.issues).toEqual([]);
  });

  it('사업비: 금액도 단가도 없으면 blocking no-amount', () => {
    const row = onlyBudget({ ...BUDGET_OK, unitPrice: null, amount: null });
    expect(row.amount).toBeNull();
    expect(blockingKinds(row)).toEqual(['no-amount']);
  });

  it('사업비: 단가가 틀렸으면 그 오류만 — 채우지 않고 no-amount를 겹치지 않는다', () => {
    const negative = onlyBudget({ ...BUDGET_OK, unitPrice: -5, amount: null });
    expect(negative.amount).toBeNull();
    expect(blockingKinds(negative)).toEqual(['unit-price-negative']);

    const text = onlyBudget({ ...BUDGET_OK, unitPrice: '단가', amount: null });
    expect(blockingKinds(text)).toEqual(['unit-price-invalid']);

    const badFactor = onlyBudget({ ...BUDGET_OK, factor1: '많이', amount: null });
    expect(badFactor.amount).toBeNull();
    expect(blockingKinds(badFactor)).toEqual(['factor-invalid']);
  });

  it('인건비: 금액은 입력값 그대로, 비면 null이고 파서는 막지 않는다(보완은 미리보기 — 연봉 필요)', () => {
    expect(onlyPersonnel(PERSONNEL_OK).amount).toBe(15_540_000);
    const empty = onlyPersonnel({ ...PERSONNEL_OK, amount: null });
    expect(empty.amount).toBeNull();
    expect(empty.issues).toEqual([]);
  });

  it('인건비: 음수·소수 금액은 blocking', () => {
    expect(blockingKinds(onlyPersonnel({ ...PERSONNEL_OK, amount: -100 }))).toEqual(['amount-negative']);
    expect(blockingKinds(onlyPersonnel({ ...PERSONNEL_OK, amount: 0.5 }))).toEqual(['amount-not-integer']);
  });
});

// ─── 축·품명 (IN-11, S-14) ───────────────────────────────────

describe('수행 행 — 축·품명', () => {
  it('축이 비면 null, 경고 없음 (제안 모드의 현금 기본과 다르다)', () => {
    const budget = onlyBudget({ ...BUDGET_OK, axis: null });
    expect(budget.axis).toBeNull();
    expect(budget.issues).toEqual([]);
    const personnel = onlyPersonnel({ ...PERSONNEL_OK, axis: null });
    expect(personnel.axis).toBeNull();
    expect(personnel.issues).toEqual([]);
  });

  it('모르는 축은 blocking invalid-axis', () => {
    expect(blockingKinds(onlyBudget({ ...BUDGET_OK, axis: '카드' }))).toEqual(['invalid-axis']);
  });

  it('품명 200자는 받고 201자는 blocking', () => {
    expect(onlyBudget({ ...BUDGET_OK, name: '가'.repeat(200) }).issues).toEqual([]);
    const row = onlyBudget({ ...BUDGET_OK, name: '가'.repeat(201) });
    expect(blockingKinds(row)).toEqual(['description-too-long']);
  });
});

// ─── 경계 (IN-13) ────────────────────────────────────────────

describe('수행 행 — _meta 목록 밖의 id (IN-13)', () => {
  it('executionId가 비면 새 행(null), 목록 밖이면 blocking unknown-execution', () => {
    expect(onlyBudget({ ...BUDGET_OK, executionId: null }).executionId).toBeNull();
    const row = onlyBudget({ ...BUDGET_OK, executionId: 'e-other' });
    expect(row.executionId).toBe('e-other');
    expect(blockingKinds(row)).toEqual(['unknown-execution']);
  });

  it('detailId가 목록 밖이면 blocking unknown-detail', () => {
    const row = onlyBudget({ ...BUDGET_OK, detailId: 'd-other' });
    expect(row.detailId).toBe('d-other');
    expect(blockingKinds(row)).toEqual(['unknown-detail']);
    expect(onlyBudget({ ...BUDGET_OK, detailId: null }).detailId).toBeNull();
  });

  it('인건비 memberId가 목록 밖이거나 비면 blocking unknown-member', () => {
    const other = onlyPersonnel({ ...PERSONNEL_OK, memberId: 'm-other' });
    expect(other.memberId).toBe('m-other');
    expect(blockingKinds(other)).toEqual(['unknown-member']);

    const empty = onlyPersonnel({ ...PERSONNEL_OK, memberId: null });
    expect(empty.memberId).toBeNull();
    expect(blockingKinds(empty)).toEqual(['unknown-member']);
  });

  it('인건비 행도 executionId·detailId를 같은 목록으로 검사한다', () => {
    const row = onlyPersonnel({ ...PERSONNEL_OK, executionId: 'e-x', detailId: 'd-x' });
    expect(blockingKinds(row)).toEqual(['unknown-execution', 'unknown-detail']);
  });
});

// ─── 세목 키 (IN-4 + 세목 미지정 슬롯) ───────────────────────

describe('사업비 — 세목 키', () => {
  it('세목 미지정 슬롯(`비목:`)은 subcategoryCode null', () => {
    const row = onlyBudget({ ...BUDGET_OK, subcategory: 'activity:', factor1: null, unitPrice: null });
    expect(row.category).toBe('activity');
    expect(row.subcategoryCode).toBeNull();
    expect(row.issues).toEqual([]);
  });

  it('default 세목 키는 코드 그대로다 (슬롯과 다르다)', () => {
    const row = onlyBudget({ ...BUDGET_OK, subcategory: 'consignment:default', factor1: 4 });
    expect(row.category).toBe('consignment');
    expect(row.subcategoryCode).toBe('default');
    expect(row.factors).toEqual([{ label: '수량', value: 4, isPercent: false }]);
  });

  it.each([
    ['', '세목 키가 없는 행입니다'],
    ['nope:', '알 수 없는 세목입니다: nope:'],
    ['activity:nope', '알 수 없는 세목입니다: activity:nope'],
    ['activity_meeting', '알 수 없는 세목입니다: activity_meeting'],
    [':', '알 수 없는 세목입니다: :'],
  ])('키 %j는 blocking unknown-subcategory', (key, message) => {
    const row = onlyBudget({ ...BUDGET_OK, subcategory: key });
    expect(row.category).toBeNull();
    expect(row.subcategoryCode).toBeNull();
    expect(row.issues).toContainEqual({ kind: 'unknown-subcategory', message, blocking: true });
  });

  it('인력 없는 인건비 집행 슬롯(`personnel:`)은 참여율 인자의 /100을 되돌린다 (IN-4·IN-12)', () => {
    const row = onlyBudget({
      ...BUDGET_OK,
      subcategory: 'personnel:',
      name: '',
      spec: '',
      unitPrice: null,
      factor1: 0.28,
      factor2: 9,
      amount: 15_540_000,
    });
    expect(row.category).toBe('personnel');
    expect(row.subcategoryCode).toBeNull();
    expect(row.memberId).toBeNull();
    expect(row.factors).toEqual([
      { label: '참여율(%)', value: 28, isPercent: true },
      { label: '참여기간(월)', value: 9, isPercent: false },
    ]);
    expect(row.issues).toEqual([]);
  });

  it('세목마다 인자가 다른 비목의 슬롯은 라벨을 정할 수 없어 `인자N` + 경고', () => {
    const row = onlyBudget({ ...BUDGET_OK, subcategory: 'activity:', factor1: 4 });
    expect(row.factors).toEqual([{ label: '인자1', value: 4, isPercent: false }]);
    expect(row.issues).toEqual([
      { kind: 'factor-without-preset', message: "인자1에 프리셋 라벨이 없어 '인자1'로 둡니다", blocking: false },
    ]);
  });
});

// ─── 인건비 시트 (IN-12) ─────────────────────────────────────

describe('인건비 — 참여율·개월 → factors', () => {
  it('정상 행', () => {
    expect(onlyPersonnel(PERSONNEL_OK)).toEqual({
      rowIndex: 2,
      executionId: 'e-2',
      category: 'personnel',
      subcategoryCode: 'personnel_internal',
      memberId: 'm-1',
      detailId: 'd-1',
      date: '2026-03-05',
      description: '',
      spec: '',
      unitPrice: null,
      factors: [
        { label: '참여율(%)', value: 28, isPercent: true },
        { label: '참여기간(월)', value: 9, isPercent: false },
      ],
      axis: 'in_kind',
      amount: 15_540_000,
      note: '3월분',
      issues: [],
    });
  });

  it('학생인건비 세목 라벨이면 비목이 student_personnel', () => {
    const row = onlyPersonnel({ ...PERSONNEL_OK, subcategory: '통합관리' });
    expect(row.category).toBe('student_personnel');
    expect(row.subcategoryCode).toBe('student_managed');
  });

  it('세목이 비면 내부인건비 + 알림 (IN-3과 같다)', () => {
    const row = onlyPersonnel({ ...PERSONNEL_OK, subcategory: null });
    expect(row.subcategoryCode).toBe('personnel_internal');
    expect(kinds(row)).toEqual(['default-subcategory']);
  });

  it('모르는 세목 라벨은 blocking', () => {
    const row = onlyPersonnel({ ...PERSONNEL_OK, subcategory: '외주용역비' });
    expect(row.category).toBeNull();
    expect(row.subcategoryCode).toBeNull();
    expect(blockingKinds(row)).toEqual(['unknown-subcategory']);
  });

  it('참여율·개월이 비면 factors null — 집행은 금액이 원본이라 막지 않는다', () => {
    const row = onlyPersonnel({ ...PERSONNEL_OK, participation: null, months: null });
    expect(row.factors).toBeNull();
    expect(row.issues).toEqual([]);
  });

  it('한쪽만 있으면 그 인자만', () => {
    expect(onlyPersonnel({ ...PERSONNEL_OK, participation: null }).factors).toEqual([
      { label: '참여기간(월)', value: 9, isPercent: false },
    ]);
  });

  it('범위 밖·문자는 제안 모드와 같은 blocking', () => {
    expect(blockingKinds(onlyPersonnel({ ...PERSONNEL_OK, participation: 120 }))).toEqual([
      'participation-out-of-range',
    ]);
    expect(blockingKinds(onlyPersonnel({ ...PERSONNEL_OK, months: 13 }))).toEqual(['months-out-of-range']);
    expect(blockingKinds(onlyPersonnel({ ...PERSONNEL_OK, months: '아홉' }))).toEqual(['months-invalid']);
  });

  it('D-22: 백분율 서식 셀의 참여율은 ×100 되돌린다', () => {
    const row = onlyPersonnel({ ...PERSONNEL_OK, participation: { value: 0.28, isError: false, percentFormat: true } });
    expect(row.factors?.[0]).toEqual({ label: '참여율(%)', value: 28, isPercent: true });
  });

  it('읽지 않는 열(조정액·산식 금액·연봉)은 결과에 흔적이 없다 (IN-9)', () => {
    const row = onlyPersonnel({
      ...PERSONNEL_OK,
      adjustment: 777_777,
      formulaAmount: 888_888,
      annualSalary: 999_999,
      name: '엉뚱한',
    });
    expect(row.issues).toEqual([]);
    const serialized = JSON.stringify(row);
    for (const forbidden of ['777777', '888888', '999999', '엉뚱한']) expect(serialized).not.toContain(forbidden);
  });
});

// ─── 빈 행·소계 행 ───────────────────────────────────────────

describe('건너뛰는 행', () => {
  it('키만 찬 빈 행(생성기가 까는 줄)은 건너뛴다', () => {
    const parsed = parseExecution(
      [{ memberId: 'm-2', subcategory: '내부인건비', axis: '현금' }],
      [{ subcategory: 'activity:activity_meeting' }, { subcategory: 'activity:' }]
    );
    expect(parsed.personnel).toEqual([]);
    expect(parsed.budget).toEqual([]);
  });

  it('조정액만 적힌 행도 빈 행이다 — 수행 모드는 조정액을 읽지 않는다', () => {
    expect(parseExecution([], [{ subcategory: 'activity:activity_meeting', adjustment: 5000 }]).budget).toEqual([]);
  });

  it('소계·총액 행(키 없음 + 금액 계산값 + 라벨)은 건너뛴다', () => {
    const parsed = parseExecution(
      [],
      [
        BUDGET_OK,
        { subcategoryLabel: '④ 회의비 소계', amount: 200_000 },
        { category: '연구활동비 소계', amount: 200_000 },
        { category: '합계', amount: 200_000 },
      ]
    );
    expect(parsed.budget.map((row) => row.rowIndex)).toEqual([2]);
  });

  it('키가 있는 행에 금액만 적으면 빈 행이 아니다 — 집행일이 없어 오류 행', () => {
    const parsed = parseExecution([], [{ subcategory: 'activity:activity_meeting', amount: 50_000 }]);
    expect(parsed.budget).toHaveLength(1);
    expect(blockingKinds(parsed.budget[0]!)).toEqual(['no-date']);
  });

  it('집행일만 적어도 빈 행이 아니다', () => {
    const parsed = parseExecution([{ memberId: 'm-1', executionDate: '2026-05-01' }], []);
    expect(parsed.personnel).toHaveLength(1);
    expect(parsed.personnel[0]!.date).toBe('2026-05-01');
  });

  it('행 번호는 엑셀 1-based 그대로다 (건너뛴 행이 있어도)', () => {
    const parsed = parseExecution([], [{ subcategory: 'activity:' }, BUDGET_OK, {}, { ...BUDGET_OK, executionId: 'e-2' }]);
    expect(parsed.budget.map((row) => row.rowIndex)).toEqual([3, 5]);
  });
});

// ─── 정적 검사 (IN-3·IN-8) ───────────────────────────────────

describe('parse-execution.ts 정적 경계', () => {
  const source = fs.readFileSync(path.join(process.cwd(), 'lib', 'input-form', 'parse-execution.ts'), 'utf8');

  it('SheetJS·exceljs를 import하지 않는다 (IN-8)', () => {
    expect(source).not.toMatch(/from\s+['"](xlsx|exceljs)['"]/);
  });

  it('이름 매칭 함수를 import하지 않는다 (IN-3)', () => {
    expect(source).not.toMatch(/matchDetailMembers|detailMemberKey|normalizeLabel/);
    expect(source).not.toMatch(/lib\/import\/detail-preview/);
  });
});
