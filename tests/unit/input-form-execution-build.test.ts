// 수행 모드 입력 양식 생성기 (SOT §6.16 IN-2·IN-4·IN-9·IN-11·IN-12, §7.9.7 수행 모드, 부록 F-8·F-9)
//
// 행은 산출근거가 아니라 집행이다. 확인하는 것: 인건비 시트 = 인력 × 인력 있는 인건비 집행(없으면 빈 1행),
// 사업비 시트 = 세목 슬롯 + 비목마다 `세목 미지정`(S-6), **모든 집행이 정확히 한 행**, 금액은 값(수식 없음),
// `_meta`의 mode·execution:<id>=version·detail:<id>. 좌표는 전부 `sheetsFor('execution')`에서 얻는다.

import { describe, expect, it } from 'vitest';
import {
  EMPTY_ROWS_PER_SUBCATEGORY,
  GUIDE_SHEET_NAME,
  columnOf,
  hiddenColumnIndexes,
  parseMeta,
  sheetsFor,
} from '@/lib/input-form';
import type { FormCell, FormSheet, InputFormData, InputFormExecution } from '@/lib/input-form';
import {
  AXIS_OPTIONS,
  PERSONNEL_SUBCATEGORY_OPTIONS,
  UNASSIGNED_SUBCATEGORY_LABEL,
  buildInputForm,
} from '@/lib/input-form/build';
import { unreadColumnsText } from '@/lib/input-form/guide';
import { subcategoryKeyOf } from '@/lib/input-form/parse';
import { BUDGET_CATEGORY_LABELS, BUDGET_CATEGORY_ORDER, SUBCATEGORY_PRESETS } from '@/lib/constants';
import type { RawCell, RawSheet } from '@/lib/import/types';
import type { BudgetDetail, Member } from '@/types';

const PROJECT = { id: 'proj-1', name: '스마트 건설 플랫폼' };
const YEAR = { id: 'year-1', name: '1차년도', startDate: '2025-04-01', endDate: '2025-12-31', order: 0 };
const TODAY = '2026-09-28';

const EXEC_SHEETS = sheetsFor('execution');
const PERSONNEL_DEF = EXEC_SHEETS.personnel;
const BUDGET_DEF = EXEC_SHEETS.budget;

type FormMember = Member & { staffName: string | null };

function member(partial: Partial<FormMember> & Pick<Member, 'id' | 'name' | 'order'>): FormMember {
  return {
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    version: 1,
    createdBy: null,
    updatedBy: null,
    projectId: PROJECT.id,
    orgId: null,
    role: 'researcher',
    position: '연구원',
    field: '',
    email: '',
    phone: '',
    active: true,
    annualSalary: 60_000_000,
    hireType: 'existing',
    staffId: null,
    salaryIncludesRetirement: null,
    salaryIncludesInsurance: null,
    salaryAppliedFrom: null,
    staffName: null,
    ...partial,
  };
}

function detail(id: string): BudgetDetail {
  return {
    id,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    version: 1,
    createdBy: null,
    updatedBy: null,
    projectId: PROJECT.id,
    yearId: YEAR.id,
    category: 'activity',
    subcategory: 'activity_meeting',
    axis: 'cash',
    formula: 'quantity',
    memberId: null,
    name: '회의비',
    unitPrice: 500_000,
    spec: '',
    factors: [{ label: '회', value: 6, isPercent: false }],
    adjustment: 0,
    note: '',
    order: 0,
    amount: 3_000_000,
  };
}

function execution(
  partial: Partial<InputFormExecution> & Pick<InputFormExecution, 'id' | 'category' | 'date' | 'amount'>
): InputFormExecution {
  return {
    version: 1,
    description: '',
    note: '',
    subcategoryCode: null,
    spec: '',
    unitPrice: null,
    factors: null,
    axis: null,
    memberId: null,
    detailId: null,
    ...partial,
  };
}

const MEMBERS: FormMember[] = [
  member({ id: 'm-kim', name: '김영', order: 0 }),
  member({ id: 'm-park', name: '박선욱', order: 1 }),
];

const PERSONNEL_FACTORS = (rate: number, months: number) => [
  { label: '참여율(%)', value: rate, isPercent: true },
  { label: '참여기간(월)', value: months, isPercent: false },
];

// 날짜 순서를 일부러 뒤섞어 둔다 — 생성기가 날짜·id로 정렬하는지 본다
const EXECUTIONS: InputFormExecution[] = [
  // 김영의 인건비 3건: 세목 있음(factors 있음), 세목 없음(인건비 → 내부인건비), 학생인건비 세목 없음(→ 일반)
  execution({
    id: 'e-kim-2',
    category: 'personnel',
    date: '2025-06-25',
    amount: 2_250_000,
    memberId: 'm-kim',
    version: 3,
    note: '6월분',
  }),
  execution({
    id: 'e-kim-1',
    category: 'personnel',
    date: '2025-05-25',
    amount: 2_250_000,
    memberId: 'm-kim',
    subcategoryCode: 'personnel_external',
    factors: PERSONNEL_FACTORS(30, 1),
    axis: 'cash',
  }),
  execution({ id: 'e-kim-3', category: 'student_personnel', date: '2025-07-25', amount: 900_000, memberId: 'm-kim' }),
  // 인력 없는 인건비 — 세목이 있어도 사업비 시트 `personnel:` 슬롯(IN-12)
  execution({
    id: 'e-personnel-nomember',
    category: 'personnel',
    date: '2025-05-01',
    amount: 1_000_000,
    subcategoryCode: 'personnel_internal',
    factors: PERSONNEL_FACTORS(10, 12),
  }),
  // 사업비: 세목 있음 + 산출근거 연결
  execution({
    id: 'e-meeting',
    category: 'activity',
    date: '2025-05-10',
    amount: 3_100_000,
    description: '1차 회의',
    spec: '10인',
    subcategoryCode: 'activity_meeting',
    unitPrice: 500_000,
    factors: [{ label: '회', value: 6, isPercent: false }],
    axis: 'in_kind',
    detailId: 'd-1',
    version: 2,
  }),
  // 세목 없음 + default 없는 비목 → `activity:`
  execution({ id: 'e-activity-null', category: 'activity', date: '2025-08-01', amount: 50_000, description: '잡비' }),
  // 세목 없음 + default 있는 비목 → `consignment:default`
  execution({ id: 'e-consign-null', category: 'consignment', date: '2025-09-01', amount: 10_000_000 }),
  // 세목 없음 + default 없는 간접비 → `indirect:`
  execution({ id: 'e-indirect-null', category: 'indirect', date: '2025-10-01', amount: 700_000 }),
  // 인건비가 아닌데 memberId가 있는 집행 — 인건비 시트가 아니라 사업비 시트(IN-12는 인건비 비목만)
  execution({
    id: 'e-material-member',
    category: 'material',
    date: '2025-05-02',
    amount: 120_000,
    subcategoryCode: 'material_purchase',
    memberId: 'm-park',
  }),
  // 프리셋 밖 세목 코드 — 그 비목 끝의 추가 슬롯(제안 모드와 같은 태도)
  execution({ id: 'e-weird', category: 'activity', date: '2025-05-03', amount: 1, subcategoryCode: 'zz_legacy' }),
];

const DATA: InputFormData = {
  project: PROJECT,
  year: YEAR,
  members: MEMBERS,
  details: [detail('d-1'), detail('d-2')],
  executions: EXECUTIONS,
};

// ─── 도구 ────────────────────────────────────────────────────

function sheetNamed(sheets: FormSheet[], name: string): FormSheet {
  const found = sheets.find((s) => s.name === name);
  if (!found) throw new Error(`시트 '${name}'이 없다`);
  return found;
}

function cellOf(row: FormCell[], def: typeof PERSONNEL_DEF, role: string): FormCell {
  return row[columnOf(def, role)] ?? {};
}

function dataRows(sheet: FormSheet): FormCell[][] {
  const roles = sheet.rowRoles!;
  return sheet.rows.filter((_, index) => roles[index] === 'data');
}

function toRawSheet(sheet: FormSheet): RawSheet {
  const cells: RawCell[][] = sheet.rows.map((row) =>
    row.map((cell) => ({ value: cell.value ?? null, isError: false }))
  );
  return { name: sheet.name, cells, merges: [] };
}

function bodyOf(guide: FormSheet, label: string): string {
  const row = guide.rows.find((r) => r[0]?.value === label);
  return String(row?.[1]?.value ?? '');
}

const workbook = buildInputForm(DATA, TODAY, 'execution');
const personnelSheet = sheetNamed(workbook.sheets, PERSONNEL_DEF.name);
const budgetSheet = sheetNamed(workbook.sheets, BUDGET_DEF.name);
const metaSheet = sheetNamed(workbook.sheets, EXEC_SHEETS.meta.name);

function budgetRowOf(executionId: string): FormCell[] {
  const found = dataRows(budgetSheet).filter((r) => cellOf(r, BUDGET_DEF, 'executionId').value === executionId);
  expect(found, executionId).toHaveLength(1);
  return found[0]!;
}

// ─── 워크북 ──────────────────────────────────────────────────

describe('수행 양식 워크북', () => {
  it('시트 목록은 제안 양식과 같다(F-9 — _lists 없음)', () => {
    expect(workbook.sheets.map((s) => s.name)).toEqual([GUIDE_SHEET_NAME, '인건비', '사업비', '_meta']);
    expect(metaSheet.hidden).toBe(true);
  });

  it('헤더는 수행 맵의 라벨이고 숨김 열은 executionId를 포함한다(IN-9)', () => {
    expect(personnelSheet.rows[0]!.map((c) => c.value)).toEqual(PERSONNEL_DEF.columns.map((c) => c.label));
    expect(budgetSheet.rows[0]!.map((c) => c.value)).toEqual(BUDGET_DEF.columns.map((c) => c.label));
    expect(personnelSheet.hiddenColumns).toEqual(hiddenColumnIndexes(PERSONNEL_DEF));
    expect(personnelSheet.hiddenColumns).toContain(columnOf(PERSONNEL_DEF, 'executionId'));
    expect(budgetSheet.hiddenColumns).toContain(columnOf(BUDGET_DEF, 'executionId'));
  });

  it('집행일 열 힌트는 date 서식이다(F-6)', () => {
    for (const [sheet, def] of [
      [personnelSheet, PERSONNEL_DEF],
      [budgetSheet, BUDGET_DEF],
    ] as const) {
      const hint = sheet.columnHints![columnOf(def, 'executionDate')]!;
      expect(hint.format).toBe('date');
      expect(hint.key).toBe(false);
      expect(sheet.columnHints!.some((h) => (h.format as string) === 'percent')).toBe(false);
    }
  });

  it('같은 입력이면 같은 출력이다', () => {
    expect(buildInputForm(DATA, TODAY, 'execution')).toEqual(workbook);
  });

  it('제안 모드는 executions를 보지 않는다', () => {
    const { executions: _drop, ...planData } = DATA;
    expect(buildInputForm(DATA, TODAY)).toEqual(buildInputForm(planData, TODAY));
  });

  it("파일명은 '입력양식_수행_' 접두로 제안 양식과 구별된다(제안 양식은 Phase 19 그대로)", () => {
    expect(workbook.fileName).toBe('입력양식_수행_스마트 건설 플랫폼_1차년도_20260928.xlsx');
    expect(buildInputForm(DATA, TODAY).fileName).toBe('입력양식_스마트 건설 플랫폼_1차년도_20260928.xlsx');
  });
});

// ─── 인건비 시트 (IN-12) ─────────────────────────────────────

describe('수행 양식 — 인건비 시트', () => {
  const rows = dataRows(personnelSheet);

  it('행 = 인력 × 인력 있는 인건비·학생인건비 집행(날짜 순). 집행 없는 인력은 빈 1행', () => {
    expect(rows.map((r) => [cellOf(r, PERSONNEL_DEF, 'memberId').value, cellOf(r, PERSONNEL_DEF, 'executionId').value])).toEqual([
      ['m-kim', 'e-kim-1'],
      ['m-kim', 'e-kim-2'],
      ['m-kim', 'e-kim-3'],
      ['m-park', null],
    ]);
  });

  it('세목 라벨은 subcategoryCode로, 없으면 비목별 기본 라벨(학생인건비는 학생인건비 세목)', () => {
    expect(rows.map((r) => cellOf(r, PERSONNEL_DEF, 'subcategory').value)).toEqual([
      '외부인건비',
      '내부인건비',
      '일반',
      '내부인건비',
    ]);
  });

  it("참여율·개월은 factors 라벨 '참여율(%)'·'참여기간(월)'에서 — 없으면 빈 칸(100·12로 채우지 않는다)", () => {
    expect(rows.map((r) => cellOf(r, PERSONNEL_DEF, 'participation').value)).toEqual([30, null, null, null]);
    expect(rows.map((r) => cellOf(r, PERSONNEL_DEF, 'months').value)).toEqual([1, null, null, null]);
  });

  it('금액은 값이다(수식 없음, IN-11). 조정액·산식 금액은 비운다(IN-9)', () => {
    expect(rows.map((r) => cellOf(r, PERSONNEL_DEF, 'amount'))).toEqual([
      { value: 2_250_000 },
      { value: 2_250_000 },
      { value: 900_000 },
      { value: null },
    ]);
    for (const row of personnelSheet.rows) {
      for (const cell of row) expect(cell.formula).toBeUndefined();
    }
    for (const row of rows) {
      expect(cellOf(row, PERSONNEL_DEF, 'adjustment')).toEqual({});
      expect(cellOf(row, PERSONNEL_DEF, 'formulaAmount')).toEqual({});
    }
  });

  it('집행일·축·비고를 채우고 인력 표시 열은 제안 모드와 같다', () => {
    expect(rows.map((r) => cellOf(r, PERSONNEL_DEF, 'executionDate').value)).toEqual([
      '2025-05-25',
      '2025-06-25',
      '2025-07-25',
      null,
    ]);
    expect(rows.map((r) => cellOf(r, PERSONNEL_DEF, 'axis').value)).toEqual(['현금', null, null, null]);
    expect(cellOf(rows[1]!, PERSONNEL_DEF, 'note').value).toBe('6월분');
    expect(cellOf(rows[0]!, PERSONNEL_DEF, 'name').value).toBe('김영');
    expect(cellOf(rows[0]!, PERSONNEL_DEF, 'annualSalary').value).toBe(60_000_000);
  });
});

// ─── 사업비 시트 (IN-4, S-6) ─────────────────────────────────

describe('수행 양식 — 사업비 시트', () => {
  it('슬롯: 비목 순, 세목 프리셋 + 프리셋 밖 코드 + 비목마다 `세목 미지정`(키 `비목:`). 인건비 비목은 미지정만', () => {
    const expected: string[] = [];
    for (const category of BUDGET_CATEGORY_ORDER) {
      if (category !== 'personnel' && category !== 'student_personnel') {
        for (const def of SUBCATEGORY_PRESETS[category]) expected.push(subcategoryKeyOf(category, def.code));
        if (category === 'activity') expected.push('activity:zz_legacy');
      }
      expected.push(`${category}:`);
    }
    const keys: string[] = [];
    for (const row of dataRows(budgetSheet)) {
      const key = String(cellOf(row, BUDGET_DEF, 'subcategory').value);
      if (keys[keys.length - 1] !== key) keys.push(key);
    }
    expect(keys).toEqual(expected);
    // _meta 목록도 같은 복합 키(IN-4)
    expect(parseMeta(toRawSheet(metaSheet))!.subcategoryCodes).toEqual(expected);
  });

  it("`세목 미지정` 슬롯의 라벨은 '세목 미지정'이다", () => {
    const row = budgetRowOf('e-activity-null');
    expect(cellOf(row, BUDGET_DEF, 'subcategory').value).toBe('activity:');
    expect(cellOf(row, BUDGET_DEF, 'subcategoryLabel').value).toBe(UNASSIGNED_SUBCATEGORY_LABEL);
    expect(cellOf(row, BUDGET_DEF, 'category').value).toBe(BUDGET_CATEGORY_LABELS.activity);
  });

  it.each([
    ['e-personnel-nomember', 'personnel:'],
    ['e-activity-null', 'activity:'],
    ['e-consign-null', 'consignment:default'],
    ['e-indirect-null', 'indirect:'],
    ['e-meeting', 'activity:activity_meeting'],
    ['e-material-member', 'material:material_purchase'],
    ['e-weird', 'activity:zz_legacy'],
  ])('%s → %s', (id, key) => {
    expect(cellOf(budgetRowOf(id), BUDGET_DEF, 'subcategory').value).toBe(key);
  });

  it('행 내용: 품명·규격·단가·인자·축·금액(값)·집행일·detailId. 조정액은 비운다', () => {
    const row = budgetRowOf('e-meeting');
    expect(cellOf(row, BUDGET_DEF, 'name').value).toBe('1차 회의');
    expect(cellOf(row, BUDGET_DEF, 'spec').value).toBe('10인');
    expect(cellOf(row, BUDGET_DEF, 'unitPrice').value).toBe(500_000);
    expect(cellOf(row, BUDGET_DEF, 'factor1').value).toBe(6);
    expect(cellOf(row, BUDGET_DEF, 'factor2').value).toBeNull();
    expect(cellOf(row, BUDGET_DEF, 'axis').value).toBe('현물');
    expect(cellOf(row, BUDGET_DEF, 'amount')).toEqual({ value: 3_100_000 });
    expect(cellOf(row, BUDGET_DEF, 'executionDate').value).toBe('2025-05-10');
    expect(cellOf(row, BUDGET_DEF, 'detailId').value).toBe('d-1');
    expect(cellOf(row, BUDGET_DEF, 'adjustment')).toEqual({});
  });

  it('인력 없는 인건비 집행의 참여율(isPercent)은 /100해 인자 칸에 싣는다(IN-4 — 금액만 보존)', () => {
    const row = budgetRowOf('e-personnel-nomember');
    expect(cellOf(row, BUDGET_DEF, 'factor1').value).toBe(0.1);
    expect(cellOf(row, BUDGET_DEF, 'factor2').value).toBe(12);
  });

  it('데이터 행 금액은 수식이 없고, 소계·총액 행은 수식이다(두 모드 공통 골격)', () => {
    const roles = budgetSheet.rowRoles!;
    budgetSheet.rows.forEach((row, index) => {
      const amount = cellOf(row, BUDGET_DEF, 'amount');
      if (roles[index] === 'data') expect(amount.formula).toBeUndefined();
      if (roles[index] === 'subtotal' || roles[index] === 'total') expect(amount.formula).toMatch(/^SUM\(/);
    });
    expect(roles[roles.length - 1]).toBe('total');
  });

  it('슬롯마다 빈 줄 3개(집행 행 뒤)', () => {
    const rows = dataRows(budgetSheet);
    const bySlot = new Map<string, { filled: number; blank: number }>();
    for (const row of rows) {
      const key = String(cellOf(row, BUDGET_DEF, 'subcategory').value);
      const entry = bySlot.get(key) ?? { filled: 0, blank: 0 };
      if (cellOf(row, BUDGET_DEF, 'executionId').value === null) entry.blank += 1;
      else entry.filled += 1;
      bySlot.set(key, entry);
    }
    for (const [key, entry] of bySlot) expect(entry.blank, key).toBe(EMPTY_ROWS_PER_SUBCATEGORY);
    expect(bySlot.get('activity:')).toEqual({ filled: 1, blank: EMPTY_ROWS_PER_SUBCATEGORY });
  });
});

// ─── 모든 집행이 정확히 한 행 (IN-4) ─────────────────────────

describe('수행 양식 — 집행 싣기 불변식', () => {
  it('그 연차의 모든 집행이 두 시트 중 정확히 한 행에 실린다', () => {
    const ids = [
      ...dataRows(personnelSheet).map((r) => cellOf(r, PERSONNEL_DEF, 'executionId').value),
      ...dataRows(budgetSheet).map((r) => cellOf(r, BUDGET_DEF, 'executionId').value),
    ].filter((v) => v !== null && v !== undefined);
    expect([...ids].sort()).toEqual(EXECUTIONS.map((e) => e.id).sort());
  });

  it('인력 목록 밖 memberId의 인건비 집행이면 던진다', () => {
    const data: InputFormData = {
      ...DATA,
      executions: [execution({ id: 'x', category: 'personnel', date: '2025-05-01', amount: 1, memberId: 'm-gone' })],
    };
    expect(() => buildInputForm(data, TODAY, 'execution')).toThrow(/인력 목록에 없다/);
  });

  it('이 연차 산출근거 목록 밖 detailId면 던진다(IN-13 — 손대지 않은 행이 오류가 된다)', () => {
    const data: InputFormData = {
      ...DATA,
      executions: [execution({ id: 'x', category: 'activity', date: '2025-05-01', amount: 1, detailId: 'd-other' })],
    };
    expect(() => buildInputForm(data, TODAY, 'execution')).toThrow(/산출근거 목록에 없다/);
  });

  it('인자가 3개를 넘으면 던진다(잘라 싣지 않는다)', () => {
    const factors = [1, 2, 3, 4].map((value) => ({ label: `f${value}`, value, isPercent: false }));
    const data: InputFormData = {
      ...DATA,
      executions: [execution({ id: 'x', category: 'activity', date: '2025-05-01', amount: 24, factors })],
    };
    expect(() => buildInputForm(data, TODAY, 'execution')).toThrow(/인자가 4개/);
  });

  it('집행이 없으면 인력당 빈 1행 + 슬롯마다 빈 줄만 있다', () => {
    const empty = buildInputForm({ ...DATA, executions: [] }, TODAY, 'execution');
    const personnel = sheetNamed(empty.sheets, '인건비');
    expect(dataRows(personnel)).toHaveLength(MEMBERS.length);
    const meta = parseMeta(toRawSheet(sheetNamed(empty.sheets, '_meta')))!;
    expect(meta.executions).toEqual({});
  });
});

// ─── _meta (IN-2) ────────────────────────────────────────────

describe('수행 양식 — _meta', () => {
  const meta = parseMeta(toRawSheet(metaSheet))!;

  it("mode='execution', execution:<id>=내려받을 때 version, detail:<id>=그 연차 산출근거", () => {
    expect(meta.mode).toBe('execution');
    expect(meta.projectId).toBe(PROJECT.id);
    expect(meta.yearId).toBe(YEAR.id);
    expect(meta.generatedAt).toBe(TODAY);
    expect(meta.executions).toEqual(Object.fromEntries(EXECUTIONS.map((e) => [e.id, e.version])));
    expect(meta.executions!['e-kim-2']).toBe(3);
    expect(meta.detailIds).toEqual(['d-1', 'd-2']);
    expect(meta.memberIds).toEqual(['m-kim', 'm-park']);
  });

  it('execution: 행 순서는 시트 순서(인건비 → 사업비)다', () => {
    const personnelIds = dataRows(personnelSheet)
      .map((r) => cellOf(r, PERSONNEL_DEF, 'executionId').value)
      .filter((v) => v !== null);
    const budgetIds = dataRows(budgetSheet)
      .map((r) => cellOf(r, BUDGET_DEF, 'executionId').value)
      .filter((v) => v !== null);
    expect(Object.keys(meta.executions!)).toEqual([...personnelIds, ...budgetIds]);
  });
});

// ─── 드롭다운 (F-9) ──────────────────────────────────────────

describe('드롭다운 — 인라인 목록(F-9)', () => {
  const plan = buildInputForm(DATA, TODAY);

  it.each([
    ['plan', plan, sheetsFor('plan')],
    ['execution', workbook, EXEC_SHEETS],
  ] as const)('%s: 인건비 세목·축, 사업비 축에만 건다', (_mode, wb, defs) => {
    const personnel = sheetNamed(wb.sheets, '인건비');
    const budget = sheetNamed(wb.sheets, '사업비');
    expect(personnel.validations).toEqual([
      { column: columnOf(defs.personnel, 'subcategory'), values: [...PERSONNEL_SUBCATEGORY_OPTIONS] },
      { column: columnOf(defs.personnel, 'axis'), values: ['현금', '현물'] },
    ]);
    expect(budget.validations).toEqual([{ column: columnOf(defs.budget, 'axis'), values: ['현금', '현물'] }]);
    expect(sheetNamed(wb.sheets, GUIDE_SHEET_NAME).validations).toBeUndefined();
    expect(sheetNamed(wb.sheets, '_meta').validations).toBeUndefined();
  });

  it('인건비 세목 목록은 부록 A.5 인건비·학생인건비 라벨 5종이다', () => {
    expect(PERSONNEL_SUBCATEGORY_OPTIONS).toEqual(['내부인건비', '외부인건비', '연구지원인력인건비', '일반', '통합관리']);
    expect(AXIS_OPTIONS).toEqual(['현금', '현물']);
  });

  it('목록 값에 쉼표가 없고 인라인 한도(255자) 안이다', () => {
    for (const values of [PERSONNEL_SUBCATEGORY_OPTIONS, AXIS_OPTIONS]) {
      for (const v of values) expect(v).not.toContain(',');
      expect(values.join(',').length).toBeLessThanOrEqual(255);
    }
  });
});

// ─── 작성안내 (F-8, §7.9.7) ──────────────────────────────────

describe('수행 양식 — 작성안내', () => {
  const guide = sheetNamed(workbook.sheets, GUIDE_SHEET_NAME);

  it("'주의'에 금액 열을 읽는다, 부제에 수행", () => {
    expect(bodyOf(guide, '주의')).toContain('금액 열을 읽는다');
    expect(guide.rows[1]![0]!.value).toBe('생성 2026-09-28 · 1차년도 · 수행');
  });

  it("'읽지 않는 열'은 수행 맵에서 생성된다 — 조정액·산식 금액이 들고 금액은 빠진다", () => {
    const text = unreadColumnsText('execution');
    expect(bodyOf(guide, '읽지 않는 열')).toBe(text);
    const lines = text.split('\n');
    expect(lines[0]).toBe('「인건비」 성명 · 직위 · 조직원 · 급여 기준 · 연봉 · 월급 · 조정액 · 산식 금액');
    expect(lines[1]).toBe('「사업비」 비목 · 세목 · 조정액');
    expect(lines[3]).toBe(
      '숨김 열(memberId · detailId · executionId · subcategory)은 행을 앱의 데이터와 잇는 키입니다 — 지우거나 옮기지 마세요.'
    );
  });

  it("'작성 방법'은 집행일·세목 미지정을 말하고 조정액을 적으라고 하지 않는다", () => {
    const method = bodyOf(guide, '작성 방법');
    expect(method).toContain('집행일');
    expect(method).toContain(UNASSIGNED_SUBCATEGORY_LABEL);
    expect(method).not.toContain('현금/현물·조정액');
  });
});

