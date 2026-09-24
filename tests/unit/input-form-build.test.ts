// 입력 양식 생성기 (SOT §6.16 IN-1·IN-3·IN-4·IN-7, §7.9.7, 부록 A.5·B.7)
//
// 픽스처는 부록 B.7.1 인건비 19행 + B.7.2 연구활동비 5행이다. 생성기는 금액을 계산하지 않으므로
// 여기서 확인하는 것은 **어느 값이 어느 칸에, 어떤 수식으로** 들어갔는가다. 좌표는 전부 `layout.ts`의
// `columnOf`/`columnAddress`로 얻는다 — 테스트가 열 번호를 박아 두면 맵이 바뀔 때 테스트가 거짓 경보를 낸다.
// 단, "월급 열(H)을 참조하지 않는다"는 PL-2 회귀는 맵이 정한 열 글자로도 한 번 더 못박는다.

import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import {
  EMPTY_ROWS_PER_SUBCATEGORY,
  INPUT_FORM_SHEETS,
  INPUT_FORM_VERSION,
  columnAddress,
  columnOf,
  hiddenColumnIndexes,
  parseMeta,
} from '@/lib/input-form';
import type { FormCell, FormSheet, InputFormData } from '@/lib/input-form';
import {
  DEFAULT_PERSONNEL_SUBCATEGORY,
  NO_INCLUSION_LABEL,
  NO_SALARY_NOTE,
  buildInputForm,
  inputFormFileName,
} from '@/lib/input-form/build';
import { subcategoryKeyOf } from '@/lib/input-form/parse';
import { BUDGET_CATEGORY_ORDER, SUBCATEGORY_PRESETS } from '@/lib/constants';
import { columnLetter } from '@/lib/export/layouts';
import type { RawCell, RawSheet } from '@/lib/import/types';
import type { BudgetDetail, DetailAxis, Member } from '@/types';

const PROJECT = { id: 'proj-1', name: '스마트 건설 플랫폼' };
const YEAR = { id: 'year-1', name: '1차년도', startDate: '2025-04-01', endDate: '2025-12-31', order: 0 };
const TODAY = '2026-09-25';

const PERSONNEL_DEF = INPUT_FORM_SHEETS.personnel;
const BUDGET_DEF = INPUT_FORM_SHEETS.budget;

// ─── 부록 B.7.1 인건비 19행 ──────────────────────────────────
// [성명, 연봉, 참여율, 축, 개월, 최종 금액, 조정액] — export-roundtrip.test.ts와 같은 표

const PERSONNEL: ReadonlyArray<readonly [string, number, number, DetailAxis, number, number, number]> = [
  ['여욱현', 180_000_000, 10.0, 'cash', 9, 13_500_000, 0],
  ['김영', 90_000_000, 30.0, 'cash', 9, 20_250_000, 0],
  ['김지웅', 90_000_000, 30.0, 'in_kind', 9, 20_250_000, 0],
  ['박선욱', 74_000_000, 28.0, 'cash', 9, 15_540_000, 0],
  ['지동민', 84_000_000, 64.0, 'in_kind', 9, 40_050_000, -270_000],
  ['도상래', 64_000_000, 10.0, 'cash', 9, 4_800_000, 0],
  ['이경아', 54_000_000, 70.0, 'in_kind', 9, 28_350_000, 0],
  ['김다래', 54_000_000, 26.0, 'cash', 9, 10_500_000, -30_000],
  ['김도현', 52_000_000, 10.0, 'cash', 9, 3_900_000, 0],
  ['유태일', 46_200_000, 15.0, 'cash', 9, 5_190_000, -7_500],
  ['정우진', 51_000_000, 40.0, 'cash', 9, 15_300_000, 0],
  ['김형식', 43_500_000, 41.0, 'cash', 9, 13_370_000, -6_250],
  ['신나리', 38_000_000, 40.0, 'cash', 9, 11_400_000, 0],
  ['양소희', 39_000_000, 30.0, 'cash', 9, 8_770_000, -5_000],
  ['이다정', 41_100_000, 20.0, 'cash', 9, 6_160_000, -5_000],
  ['안승현', 36_000_000, 14.0, 'cash', 9, 3_780_000, 0],
  ['진호령', 33_000_000, 30.0, 'cash', 9, 7_420_000, -5_000],
  ['장선우', 32_000_000, 29.0, 'cash', 9, 6_960_000, 0],
  ['신규채용1(청년의무)', 51_000_000, 100.0, 'cash', 8, 34_000_000, 0],
] as const;

const NEW_HIRE_INDEX = PERSONNEL.length - 1;

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
    annualSalary: null,
    hireType: 'existing',
    staffId: null,
    salaryIncludesRetirement: null,
    salaryIncludesInsurance: null,
    salaryAppliedFrom: null,
    staffName: null,
    ...partial,
  };
}

let detailSeq = 0;
function detail(partial: Partial<BudgetDetail> & Pick<BudgetDetail, 'category' | 'subcategory'>): BudgetDetail {
  detailSeq += 1;
  return {
    id: `d-${detailSeq}`,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    version: 1,
    createdBy: null,
    updatedBy: null,
    projectId: PROJECT.id,
    yearId: YEAR.id,
    axis: 'cash',
    formula: 'quantity',
    memberId: null,
    name: '',
    unitPrice: 0,
    spec: '',
    factors: [],
    adjustment: 0,
    note: '',
    order: 0,
    amount: 0,
    ...partial,
  };
}

function personnelDetail(
  row: readonly [string, number, number, DetailAxis, number, number, number],
  order: number
): BudgetDetail {
  const [name, , rate, axis, months, amount, adjustment] = row;
  return detail({
    category: 'personnel',
    subcategory: 'personnel_internal',
    axis,
    formula: 'personnel',
    memberId: name,
    adjustment,
    factors: [
      { label: '참여율(%)', value: rate, isPercent: true },
      { label: '참여기간(월)', value: months, isPercent: false },
    ],
    order,
    amount,
  });
}

const MEMBERS = PERSONNEL.map(([name, salary], index) =>
  member({
    id: name,
    name,
    order: index,
    annualSalary: salary,
    hireType: index === NEW_HIRE_INDEX ? 'new' : 'existing',
  })
);

// ─── 부록 B.7.2 연구활동비 5행 ───────────────────────────────

const QUANTITY: BudgetDetail[] = [
  detail({
    category: 'activity',
    subcategory: 'activity_meeting',
    name: '회의비',
    unitPrice: 500_000,
    factors: [{ label: '회', value: 6, isPercent: false }],
    amount: 3_000_000,
  }),
  detail({
    category: 'activity',
    subcategory: 'activity_software',
    name: 'AEC Collection',
    unitPrice: 540_000,
    // 실측 라벨 `시트(수량)` — IN-4: 왕복하면 프리셋 라벨로 돌아온다(값만 보존)
    factors: [
      { label: '시트(수량)', value: 4, isPercent: false },
      { label: '월', value: 9, isPercent: false },
    ],
    amount: 19_440_000,
  }),
  detail({
    category: 'activity',
    subcategory: 'activity_travel_dom',
    name: '국내출장비',
    unitPrice: 150_000,
    factors: [
      { label: '인원', value: 2, isPercent: false },
      { label: '횟수', value: 4, isPercent: false },
    ],
    amount: 1_200_000,
  }),
  detail({
    category: 'activity',
    subcategory: 'activity_etc',
    name: '인쇄/복사/인화/슬라이드 제작',
    unitPrice: 450_000,
    factors: [{ label: '회', value: 2, isPercent: false }],
    order: 0,
    amount: 900_000,
  }),
  detail({
    category: 'activity',
    subcategory: 'activity_etc',
    name: '위탁정산 수수료',
    unitPrice: 2_480_000,
    factors: [{ label: '회', value: 1, isPercent: false }],
    order: 1,
    amount: 2_480_000,
  }),
];

const DATA: InputFormData = {
  project: PROJECT,
  year: YEAR,
  members: MEMBERS,
  details: [...PERSONNEL.map((row, index) => personnelDetail(row, index)), ...QUANTITY],
};

// ─── 도구 ────────────────────────────────────────────────────

function sheetNamed(sheets: FormSheet[], name: string): FormSheet {
  const found = sheets.find((s) => s.name === name);
  if (!found) throw new Error(`시트 '${name}'이 없다`);
  return found;
}

function dataRows(sheet: FormSheet, def: typeof PERSONNEL_DEF): FormCell[][] {
  return sheet.rows.slice(def.dataStartRow - 1);
}

function cellOf(row: FormCell[], def: typeof PERSONNEL_DEF, role: string): FormCell {
  return row[columnOf(def, role)] ?? {};
}

function personnelRowsOf(sheet: FormSheet, memberId: string): { row: FormCell[]; rowNumber: number }[] {
  const out: { row: FormCell[]; rowNumber: number }[] = [];
  sheet.rows.forEach((row, index) => {
    if (index < PERSONNEL_DEF.dataStartRow - 1) return;
    if (cellOf(row, PERSONNEL_DEF, 'memberId').value === memberId) out.push({ row, rowNumber: index + 1 });
  });
  return out;
}

/** 사업비 시트의 (비목 라벨, 세목 코드) 슬롯을 나열 순서대로 — 연속 같은 슬롯은 하나로 */
function slotKeys(rows: FormCell[][]): { category: string; code: string }[] {
  const out: { category: string; code: string }[] = [];
  for (const r of rows) {
    const category = String(cellOf(r, BUDGET_DEF, 'category').value);
    const code = String(cellOf(r, BUDGET_DEF, 'subcategory').value);
    const last = out[out.length - 1];
    if (!last || last.category !== category || last.code !== code) out.push({ category, code });
  }
  return out;
}

function toRawSheet(sheet: FormSheet): RawSheet {
  const cells: RawCell[][] = sheet.rows.map((row) =>
    row.map((cell) => ({ value: cell.value ?? null, isError: false }))
  );
  return { name: sheet.name, cells, merges: [] };
}

const workbook = buildInputForm(DATA, TODAY);
const personnelSheet = sheetNamed(workbook.sheets, PERSONNEL_DEF.name);
const budgetSheet = sheetNamed(workbook.sheets, BUDGET_DEF.name);
const metaSheet = sheetNamed(workbook.sheets, INPUT_FORM_SHEETS.meta.name);

// ─── 인건비 시트 ─────────────────────────────────────────────

describe('인건비 시트 (IN-3·IN-7)', () => {
  it('헤더 행이 좌표 맵의 라벨이고 B.7.1 19행이 인력 order 순으로 깔린다', () => {
    const header = personnelSheet.rows[PERSONNEL_DEF.headerRow - 1] ?? [];
    expect(header.map((c) => c.value)).toEqual(PERSONNEL_DEF.columns.map((c) => c.label));

    const rows = dataRows(personnelSheet, PERSONNEL_DEF);
    expect(rows).toHaveLength(PERSONNEL.length);
    expect(rows.map((r) => cellOf(r, PERSONNEL_DEF, 'memberId').value)).toEqual(PERSONNEL.map(([n]) => n));
  });

  it('(a) 박선욱 행: 산식 수식이 ROUND(연봉×참여율/100×개월/12,0)이고 월급 열을 참조하지 않는다 (PL-2)', () => {
    const [found] = personnelRowsOf(personnelSheet, '박선욱');
    if (!found) throw new Error('박선욱 행이 없다');
    const { row, rowNumber } = found;

    const formula = cellOf(row, PERSONNEL_DEF, 'formulaAmount').formula ?? '';
    expect(formula).toContain('ROUND(');
    expect(formula).toContain('/100');
    expect(formula).toContain('/12');
    expect(formula).toBe(
      `ROUND(${columnAddress(PERSONNEL_DEF, 'annualSalary', rowNumber)}*${columnAddress(PERSONNEL_DEF, 'participation', rowNumber)}/100*${columnAddress(PERSONNEL_DEF, 'months', rowNumber)}/12,0)`
    );

    // 월급 열(맵 기준 H)의 어떤 행도 가리키지 않는다
    const monthlyLetter = columnLetter(columnOf(PERSONNEL_DEF, 'monthlySalary'));
    expect(monthlyLetter).toBe('H');
    expect(formula).not.toMatch(new RegExp(`\\b${monthlyLetter}\\d+`));

    // 금액 = 산식 금액 + 조정액
    expect(cellOf(row, PERSONNEL_DEF, 'amount').formula).toBe(
      `${columnAddress(PERSONNEL_DEF, 'formulaAmount', rowNumber)}+${columnAddress(PERSONNEL_DEF, 'adjustment', rowNumber)}`
    );

    // 수식이 참조하는 입력 값 자체는 B.7.1 그대로 — 셀 값을 대입하면 15,540,000이 나온다
    expect(cellOf(row, PERSONNEL_DEF, 'annualSalary').value).toBe(74_000_000);
    expect(cellOf(row, PERSONNEL_DEF, 'participation').value).toBe(28);
    expect(cellOf(row, PERSONNEL_DEF, 'months').value).toBe(9);
    expect(cellOf(row, PERSONNEL_DEF, 'adjustment').value).toBe(0);
    expect(Math.round((74_000_000 * 28) / 100 * 9 / 12)).toBe(15_540_000);
  });

  it('표시 열: 월급은 표시용 반올림, 급여 기준 배지, 조정액·축·세목 라벨·채용예정 표기', () => {
    const [jidongmin] = personnelRowsOf(personnelSheet, '지동민');
    if (!jidongmin) throw new Error('지동민 행이 없다');
    expect(cellOf(jidongmin.row, PERSONNEL_DEF, 'monthlySalary').value).toBe(7_000_000);
    expect(cellOf(jidongmin.row, PERSONNEL_DEF, 'adjustment').value).toBe(-270_000);
    expect(cellOf(jidongmin.row, PERSONNEL_DEF, 'axis').value).toBe('현물');
    expect(cellOf(jidongmin.row, PERSONNEL_DEF, 'subcategory').value).toBe('내부인건비');
    expect(cellOf(jidongmin.row, PERSONNEL_DEF, 'salaryBasis').value).toBe('기록 없음');
    expect(cellOf(jidongmin.row, PERSONNEL_DEF, 'staff').value).toBe('');
    expect(cellOf(jidongmin.row, PERSONNEL_DEF, 'detailId').value).toMatch(/^d-\d+$/);

    const [newHire] = personnelRowsOf(personnelSheet, '신규채용1(청년의무)');
    if (!newHire) throw new Error('신규채용 행이 없다');
    expect(cellOf(newHire.row, PERSONNEL_DEF, 'name').value).toBe('신규채용1(청년의무) (채용예정)');
    expect(cellOf(newHire.row, PERSONNEL_DEF, 'months').value).toBe(8);
  });

  it('급여 기준 배지: 포함 플래그 조합·조직원 이름', () => {
    const data: InputFormData = {
      ...DATA,
      members: [
        member({ id: 'm-both', name: '둘다', order: 0, annualSalary: 1, salaryIncludesRetirement: true, salaryIncludesInsurance: true, staffName: '홍길동' }),
        member({ id: 'm-none', name: '없음', order: 1, annualSalary: 1, salaryIncludesRetirement: false, salaryIncludesInsurance: false }),
      ],
      details: [],
    };
    const sheet = sheetNamed(buildInputForm(data, TODAY).sheets, PERSONNEL_DEF.name);
    const [both] = personnelRowsOf(sheet, 'm-both');
    const [none] = personnelRowsOf(sheet, 'm-none');
    expect(cellOf(both!.row, PERSONNEL_DEF, 'salaryBasis').value).toBe('퇴직금 포함 · 4대보험 포함');
    expect(cellOf(both!.row, PERSONNEL_DEF, 'staff').value).toBe('홍길동');
    expect(cellOf(none!.row, PERSONNEL_DEF, 'salaryBasis').value).toBe(NO_INCLUSION_LABEL);
  });

  it('(b) 연봉 null 인력: 두 수식 대신 빈 칸 + 비고 "연봉 미입력"', () => {
    const data: InputFormData = {
      ...DATA,
      members: [
        member({ id: 'm-nosal', name: '연봉없음', order: 0, annualSalary: null }),
        member({ id: 'm-nosal-note', name: '연봉없음2', order: 1, annualSalary: null }),
      ],
      details: [
        detail({ category: 'personnel', subcategory: 'personnel_external', formula: 'personnel', memberId: 'm-nosal-note', note: '기존 비고', factors: [{ label: '참여율(%)', value: 10, isPercent: true }, { label: '참여기간(월)', value: 9, isPercent: false }] }),
      ],
    };
    const sheet = sheetNamed(buildInputForm(data, TODAY).sheets, PERSONNEL_DEF.name);

    const [blank] = personnelRowsOf(sheet, 'm-nosal');
    if (!blank) throw new Error('행이 없다');
    expect(cellOf(blank.row, PERSONNEL_DEF, 'formulaAmount')).toEqual({});
    expect(cellOf(blank.row, PERSONNEL_DEF, 'amount')).toEqual({});
    expect(cellOf(blank.row, PERSONNEL_DEF, 'annualSalary').value).toBeNull();
    expect(cellOf(blank.row, PERSONNEL_DEF, 'monthlySalary').value).toBeNull();
    expect(cellOf(blank.row, PERSONNEL_DEF, 'note').value).toBe(NO_SALARY_NOTE);

    // 기존 비고는 버리지 않는다
    const [withNote] = personnelRowsOf(sheet, 'm-nosal-note');
    if (!withNote) throw new Error('행이 없다');
    expect(cellOf(withNote.row, PERSONNEL_DEF, 'formulaAmount').formula).toBeUndefined();
    expect(cellOf(withNote.row, PERSONNEL_DEF, 'note').value).toBe(`${NO_SALARY_NOTE} · 기존 비고`);
    expect(cellOf(withNote.row, PERSONNEL_DEF, 'subcategory').value).toBe('외부인건비');
  });

  it('기존 행이 없는 인력은 빈 값 1행 — 세목 기본 내부인건비, 수식은 유지', () => {
    const data: InputFormData = {
      ...DATA,
      members: [member({ id: 'm-empty', name: '신입', order: 0, annualSalary: 40_000_000 })],
      details: [],
    };
    const sheet = sheetNamed(buildInputForm(data, TODAY).sheets, PERSONNEL_DEF.name);
    const rows = personnelRowsOf(sheet, 'm-empty');
    expect(rows).toHaveLength(1);
    const { row } = rows[0]!;
    expect(DEFAULT_PERSONNEL_SUBCATEGORY).toBe('personnel_internal');
    expect(cellOf(row, PERSONNEL_DEF, 'subcategory').value).toBe('내부인건비');
    expect(cellOf(row, PERSONNEL_DEF, 'detailId').value).toBeNull();
    expect(cellOf(row, PERSONNEL_DEF, 'participation').value).toBeNull();
    expect(cellOf(row, PERSONNEL_DEF, 'months').value).toBeNull();
    expect(cellOf(row, PERSONNEL_DEF, 'axis').value).toBeNull();
    expect(cellOf(row, PERSONNEL_DEF, 'formulaAmount').formula).toContain('ROUND(');
  });

  it('(f) 두 구간 인력(같은 member의 행 2개)은 행 2개 — 각 행이 자기 행 번호를 참조한다', () => {
    const data: InputFormData = {
      ...DATA,
      members: [member({ id: 'm-two', name: '한봄희', order: 0, annualSalary: 48_000_000 })],
      details: [
        detail({ category: 'personnel', subcategory: 'personnel_internal', formula: 'personnel', memberId: 'm-two', order: 1, factors: [{ label: '참여율(%)', value: 53, isPercent: true }, { label: '참여기간(월)', value: 8, isPercent: false }] }),
        detail({ category: 'personnel', subcategory: 'personnel_internal', formula: 'personnel', memberId: 'm-two', order: 0, factors: [{ label: '참여율(%)', value: 10, isPercent: true }, { label: '참여기간(월)', value: 4, isPercent: false }] }),
      ],
    };
    const sheet = sheetNamed(buildInputForm(data, TODAY).sheets, PERSONNEL_DEF.name);
    const rows = personnelRowsOf(sheet, 'm-two');
    expect(rows).toHaveLength(2);
    // order 순
    expect(rows.map((r) => cellOf(r.row, PERSONNEL_DEF, 'participation').value)).toEqual([10, 53]);
    expect(rows.map((r) => cellOf(r.row, PERSONNEL_DEF, 'months').value)).toEqual([4, 8]);
    for (const { row, rowNumber } of rows) {
      expect(cellOf(row, PERSONNEL_DEF, 'formulaAmount').formula).toContain(
        columnAddress(PERSONNEL_DEF, 'annualSalary', rowNumber)
      );
    }
  });

  it('인력 목록에 없는 memberId를 가진 인건비 행은 조용히 빠지지 않고 던진다', () => {
    const data: InputFormData = {
      ...DATA,
      members: [],
      details: [detail({ category: 'personnel', subcategory: 'personnel_internal', formula: 'personnel', memberId: 'ghost' })],
    };
    expect(() => buildInputForm(data, TODAY)).toThrow(/ghost/);
  });
});

// ─── 사업비 시트 ─────────────────────────────────────────────

describe('사업비 시트 (IN-4)', () => {
  const rows = dataRows(budgetSheet, BUDGET_DEF);
  const codes = rows.map((r) => String(cellOf(r, BUDGET_DEF, 'subcategory').value));

  it('(c) 부록 A.5 인건비 외 세목 전부가 BUDGET_CATEGORY_ORDER 순으로 존재한다 — 빈 세목도, 숨김 키는 비목:세목', () => {
    const expected: string[] = [];
    for (const category of BUDGET_CATEGORY_ORDER) {
      if (category === 'personnel' || category === 'student_personnel') continue;
      for (const def of SUBCATEGORY_PRESETS[category]) expected.push(subcategoryKeyOf(category, def.code));
    }
    // 세목 코드 `default`는 여섯 비목이 공유한다 — 복합 키라서 이웃 비목의 `default`가 합쳐지지 않는다
    expect(slotKeys(rows).map((k) => k.code)).toEqual(expected);
    expect(expected).toContain('consignment:default');
    expect(expected).toContain('international:default');
    expect(codes.every((c) => c.includes(':'))).toBe(true);
    expect(codes.some((c) => c.startsWith('personnel:') || c.startsWith('student_personnel:'))).toBe(false);
  });

  it('(c) 각 세목 뒤에 빈 줄 EMPTY_ROWS_PER_SUBCATEGORY — 기존 행이 있으면 그 뒤에', () => {
    expect(EMPTY_ROWS_PER_SUBCATEGORY).toBe(3);
    const isBlank = (r: FormCell[]) =>
      cellOf(r, BUDGET_DEF, 'detailId').value === null && cellOf(r, BUDGET_DEF, 'name').value === null;

    // 세목별로 (기존 행 수, 빈 줄 수)
    const groups = new Map<string, { existing: number; blank: number }>();
    rows.forEach((r, i) => {
      const key = `${cellOf(r, BUDGET_DEF, 'category').value}/${codes[i]}`;
      const g = groups.get(key) ?? { existing: 0, blank: 0 };
      if (isBlank(r)) g.blank += 1;
      else g.existing += 1;
      groups.set(key, g);
    });
    for (const [key, g] of groups) {
      expect(g.blank, key).toBe(EMPTY_ROWS_PER_SUBCATEGORY);
    }
    expect(groups.get('연구활동비/activity:activity_etc')).toEqual({ existing: 2, blank: 3 });
    expect(groups.get('연구활동비/activity:activity_meeting')).toEqual({ existing: 1, blank: 3 });
    expect(groups.get('간접비/indirect:indirect_hr')).toEqual({ existing: 0, blank: 3 });

    // 기존 행이 먼저, 빈 줄이 뒤
    const etcIndexes = codes.map((c, i) => (c === 'activity:activity_etc' ? i : -1)).filter((i) => i >= 0);
    expect(etcIndexes.map((i) => isBlank(rows[i]!))).toEqual([false, false, true, true, true]);
    expect(rows[etcIndexes[0]!]![columnOf(BUDGET_DEF, 'name')]!.value).toBe('인쇄/복사/인화/슬라이드 제작');
    expect(rows[etcIndexes[1]!]![columnOf(BUDGET_DEF, 'name')]!.value).toBe('위탁정산 수수료');
  });

  it('B.7.2 값이 제자리에: 인자는 프리셋 자리 순, 라벨은 버린다, 금액은 수식', () => {
    const softwareIndex = rows.findIndex((r) => cellOf(r, BUDGET_DEF, 'name').value === 'AEC Collection');
    expect(softwareIndex).toBeGreaterThanOrEqual(0);
    const row = rows[softwareIndex]!;
    const rowNumber = softwareIndex + BUDGET_DEF.dataStartRow;
    expect(cellOf(row, BUDGET_DEF, 'category').value).toBe('연구활동비');
    expect(cellOf(row, BUDGET_DEF, 'subcategoryLabel').value).toBe('⑥ 소프트웨어 활용비');
    expect(cellOf(row, BUDGET_DEF, 'unitPrice').value).toBe(540_000);
    expect(cellOf(row, BUDGET_DEF, 'factor1').value).toBe(4);
    expect(cellOf(row, BUDGET_DEF, 'factor2').value).toBe(9);
    expect(cellOf(row, BUDGET_DEF, 'factor3').value).toBeNull();
    expect(cellOf(row, BUDGET_DEF, 'adjustment').value).toBe(0);
    expect(cellOf(row, BUDGET_DEF, 'axis').value).toBe('현금');

    const a = (role: string) => columnAddress(BUDGET_DEF, role, rowNumber);
    expect(cellOf(row, BUDGET_DEF, 'amount').formula).toBe(
      `ROUND(${a('unitPrice')}*IF(${a('factor1')}="",1,${a('factor1')})*IF(${a('factor2')}="",1,${a('factor2')})*IF(${a('factor3')}="",1,${a('factor3')})+${a('adjustment')},0)`
    );
    expect(cellOf(row, BUDGET_DEF, 'amount').value).toBeUndefined();
  });

  it('(g) isPercent 인자는 /100한 값으로 적는다 — 금액만 보존', () => {
    const data: InputFormData = {
      ...DATA,
      details: [
        detail({
          category: 'material',
          subcategory: 'material_purchase',
          name: '할인 재료',
          unitPrice: 1_000_000,
          factors: [
            { label: '수량', value: 3, isPercent: false },
            { label: '할인율(%)', value: 50, isPercent: true },
          ],
        }),
      ],
    };
    const sheet = sheetNamed(buildInputForm(data, TODAY).sheets, BUDGET_DEF.name);
    const row = dataRows(sheet, BUDGET_DEF).find((r) => cellOf(r, BUDGET_DEF, 'name').value === '할인 재료');
    if (!row) throw new Error('행이 없다');
    expect(cellOf(row, BUDGET_DEF, 'factor1').value).toBe(3);
    expect(cellOf(row, BUDGET_DEF, 'factor2').value).toBe(0.5);
  });

  it('프리셋에 없는 세목 코드의 기존 행도 그 비목 끝에 싣는다 — 조용히 빠뜨리지 않는다', () => {
    const data: InputFormData = {
      ...DATA,
      details: [detail({ category: 'material', subcategory: 'material_custom', name: '옛 세목 행', unitPrice: 10 })],
    };
    const sheet = sheetNamed(buildInputForm(data, TODAY).sheets, BUDGET_DEF.name);
    const rowsX = dataRows(sheet, BUDGET_DEF);
    const idx = rowsX.findIndex((r) => cellOf(r, BUDGET_DEF, 'name').value === '옛 세목 행');
    expect(idx).toBeGreaterThanOrEqual(0);
    expect(cellOf(rowsX[idx]!, BUDGET_DEF, 'subcategory').value).toBe('material:material_custom');
    expect(cellOf(rowsX[idx]!, BUDGET_DEF, 'subcategoryLabel').value).toBe('material_custom');
    // 프리셋 세목(material_make) 뒤, 다음 비목(activity) 앞
    const lastPreset = rowsX
      .map((r) => cellOf(r, BUDGET_DEF, 'subcategory').value)
      .lastIndexOf('material:material_make');
    const firstActivity = rowsX.findIndex((r) => cellOf(r, BUDGET_DEF, 'category').value === '연구활동비');
    expect(idx).toBeGreaterThan(lastPreset);
    expect(idx).toBeLessThan(firstActivity);
  });
});

// ─── 숨김 열·_meta·파일명 ───────────────────────────────────

describe('숨김 열·_meta·파일명 (IN-2)', () => {
  it('(d) 숨김 열에 memberId·detailId(인건비)·세목 코드·detailId(사업비)', () => {
    expect(personnelSheet.hiddenColumns).toEqual(hiddenColumnIndexes(PERSONNEL_DEF));
    expect(personnelSheet.hiddenColumns).toEqual([columnOf(PERSONNEL_DEF, 'memberId'), columnOf(PERSONNEL_DEF, 'detailId')]);
    expect(budgetSheet.hiddenColumns).toEqual([columnOf(BUDGET_DEF, 'subcategory'), columnOf(BUDGET_DEF, 'detailId')]);
    expect(personnelSheet.hidden).toBe(false);
    expect(budgetSheet.hidden).toBe(false);
  });

  it('(e) _meta 시트는 숨김이고 buildMetaRows 행이 parseMeta로 되돌아온다', () => {
    expect(metaSheet.hidden).toBe(true);
    expect(workbook.sheets.map((s) => s.name)).toEqual(['인건비', '사업비', '_meta']);
    const meta = parseMeta(toRawSheet(metaSheet));
    expect(meta).not.toBeNull();
    expect(meta!.formVersion).toBe(INPUT_FORM_VERSION);
    expect(meta!.projectId).toBe(PROJECT.id);
    expect(meta!.yearId).toBe(YEAR.id);
    expect(meta!.generatedAt).toBe(TODAY);
    expect(meta!.memberIds).toEqual(PERSONNEL.map(([n]) => n));
    // 시트에 실은 복합 키 순서 그대로 — 파서가 이 목록으로 비목·세목을 되돌린다
    expect(meta!.subcategoryCodes).toEqual(slotKeys(dataRows(budgetSheet, BUDGET_DEF)).map((k) => k.code));
    expect(meta!.subcategoryCodes).toContain('activity:activity_meeting');
    expect(meta!.subcategoryCodes.filter((k) => k.endsWith(':default'))).toHaveLength(6);
  });

  it('(h) 파일명: 입력양식_<과제명>_<연차명>_<날짜>.xlsx, 금지 문자 치환', () => {
    expect(workbook.fileName).toBe('입력양식_스마트 건설 플랫폼_1차년도_20260925.xlsx');
    expect(inputFormFileName({ id: 'p', name: 'AI/로봇: 2차*' }, YEAR, '2026-01-02')).toBe(
      '입력양식_AI_로봇_ 2차__1차년도_20260102.xlsx'
    );
    expect(() => inputFormFileName(PROJECT, YEAR, '20260102')).toThrow();
  });

  it('같은 입력이면 같은 출력 — 시각을 안에서 읽지 않는다', () => {
    expect(buildInputForm(DATA, TODAY)).toEqual(workbook);
  });
});

// ─── 경계 (IN-8, PL-10a) ─────────────────────────────────────

describe('경계', () => {
  const dir = path.resolve(__dirname, '../../lib/input-form');
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.ts'));

  it('lib/input-form/**에 xlsx import가 없다 (IN-8)', () => {
    for (const file of files) {
      const source = fs.readFileSync(path.join(dir, file), 'utf8');
      expect(source, file).not.toMatch(/from\s+['"]xlsx['"]/);
      expect(source, file).not.toMatch(/require\(\s*['"]xlsx['"]\s*\)/);
    }
  });

  it('생성기는 금액을 계산하지 않는다 — computeDetailAmount 호출 0', () => {
    const source = fs.readFileSync(path.join(dir, 'build.ts'), 'utf8');
    // 주석은 규칙 설명으로 그 이름을 언급한다 — import·호출만 잡는다
    expect(source).not.toMatch(/^import\s[^;]*computeDetailAmount/m);
    expect(source).not.toMatch(/computeDetailAmount\s*\(/);
    // 어느 금액 셀에도 값이 없다 — 수식만
    for (const row of dataRows(personnelSheet, PERSONNEL_DEF)) {
      expect(cellOf(row, PERSONNEL_DEF, 'amount').value).toBeUndefined();
    }
    for (const row of dataRows(budgetSheet, BUDGET_DEF)) {
      expect(cellOf(row, BUDGET_DEF, 'amount').value).toBeUndefined();
    }
  });
});
