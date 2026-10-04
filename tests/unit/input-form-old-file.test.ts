// 입력 양식 — 연구실 안전관리비 세목 행과 옛 양식 파일 (SOT §6.16 IN-4a, 부록 A.5 주의 4, Phase 26 S-17)
//
// 옛 양식은 **진짜로 옛 생성기로** 만든다: `@/lib/constants`의 간접비 프리셋에서 `indirect_lab_safety`만 뺀
// 모듈 그래프를 따로 올려(`vi.doMock` + `vi.resetModules`) 같은 데이터를 생성한다. 손으로 행을 지운 흉내가 아니라
// Phase 25 생성기와 같은 입력으로 같은 코드를 탄 결과다 — 그래서 새 양식과의 차이가 "새 세목 행 + 그 아래 좌표
// 이동"뿐인지를 격자째 대조할 수 있다(IN-4a "기대 바이트·layout·build 갱신은 새 행과 좌표 이동분에 한정").
// 어댑터(exceljs 쓰기·SheetJS 읽기)는 FormSheet만 보므로 FormSheet가 같으면 그 시트의 바이트도 같다.

import { describe, expect, it, vi } from 'vitest';
import * as current from '@/lib/input-form';
import type { FormSheet, InputFormData, InputFormPreview, InputFormWorkbook } from '@/lib/input-form';
import { writeInputFormWorkbook } from '@/lib/input-form-adapter';
import { readWorkbook } from '@/lib/import-adapter';
import { SUBCATEGORY_PRESETS } from '@/lib/constants';
import { columnLetter } from '@/lib/export/layouts';
import type { RawSheet } from '@/lib/import/types';
import type { BudgetDetail, Member } from '@/types';

const {
  EMPTY_ROWS_PER_SUBCATEGORY,
  GUIDE_SHEET_NAME,
  INPUT_FORM_SHEETS,
  INPUT_FORM_VERSION,
  LAB_SAFETY_META_KEY,
  SUBTOTAL_SUFFIX,
  buildInputForm,
  buildInputFormPreview,
  columnOf,
  labSafetyMissingMessage,
  parseInputForm,
} = current;

// ─── 옛 생성기 (간접비 세목 3개 — Phase 25까지) ──────────────────

vi.resetModules();
vi.doMock('@/lib/constants', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/constants')>();
  return {
    ...actual,
    SUBCATEGORY_PRESETS: {
      ...actual.SUBCATEGORY_PRESETS,
      indirect: actual.SUBCATEGORY_PRESETS.indirect.filter((def) => def.code !== 'indirect_lab_safety'),
    },
  };
});
const legacy = await import('@/lib/input-form');
vi.doUnmock('@/lib/constants');

// ─── 픽스처 ─────────────────────────────────────────────────

const PROJECT = { id: 'proj-1', name: '스마트 건설 플랫폼' };
const YEAR = { id: 'year-1', name: '1차년도', startDate: '2025-04-01', endDate: '2025-12-31', order: 0 };
const TODAY = '2026-10-05';
const BUDGET_DEF = INPUT_FORM_SHEETS.budget;
const LAB_LABEL = '연구실 안전관리비';

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

function detail(partial: Partial<BudgetDetail> & Pick<BudgetDetail, 'id' | 'category' | 'subcategory'>): BudgetDetail {
  return {
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

const MEMBERS: FormMember[] = [
  member({ id: 'm-0', name: '여욱현', order: 0, annualSalary: 180_000_000 }),
  member({ id: 'm-1', name: '김영', order: 1, annualSalary: 90_000_000 }),
];

const PERSONNEL_DETAIL = detail({
  id: 'd-p0',
  category: 'personnel',
  subcategory: 'personnel_internal',
  formula: 'personnel',
  memberId: 'm-0',
  factors: [
    { label: '참여율(%)', value: 10, isPercent: true },
    { label: '참여기간(월)', value: 9, isPercent: false },
  ],
  amount: 13_500_000,
});
const ACTIVITY_DETAIL = detail({
  id: 'd-a0',
  category: 'activity',
  subcategory: 'activity_meeting',
  name: '회의비',
  unitPrice: 30_000,
  factors: [
    { label: '인원', value: 10, isPercent: false },
    { label: '횟수', value: 4, isPercent: false },
  ],
  amount: 1_200_000,
});
// 부록 B.7.3: 품명이 "연구실 안전관리비"여도 indirect_support 행이다(자동 이관 없음, 부록 A.5 주의 4)
const SUPPORT_DETAIL = detail({
  id: 'd-i0',
  category: 'indirect',
  subcategory: 'indirect_support',
  name: '연구실 안전관리비',
  unitPrice: 2_000_000,
  amount: 2_000_000,
});
const LAB_DETAILS = [
  detail({ id: 'd-l0', category: 'indirect', subcategory: 'indirect_lab_safety', name: '안전교육', unitPrice: 600_000, amount: 600_000, order: 0 }),
  detail({ id: 'd-l1', category: 'indirect', subcategory: 'indirect_lab_safety', name: '보호구', unitPrice: 400_000, amount: 400_000, order: 1 }),
];

const BASE_DETAILS = [PERSONNEL_DETAIL, ACTIVITY_DETAIL, SUPPORT_DETAIL];
const ALL_DETAILS = [...BASE_DETAILS, ...LAB_DETAILS];

function dataOf(details: BudgetDetail[]): InputFormData {
  return { project: PROJECT, year: YEAR, members: MEMBERS, details };
}

// ─── 헬퍼 ───────────────────────────────────────────────────

function sheetOf(workbook: InputFormWorkbook, name: string): FormSheet {
  const found = workbook.sheets.find((sheet) => sheet.name === name);
  if (!found) throw new Error(`시트 '${name}'이 없다`);
  return found;
}

function textAt(sheet: FormSheet, r0: number, role: string): unknown {
  return sheet.rows[r0]?.[columnOf(BUDGET_DEF, role)]?.value ?? null;
}

/** 0-based 행. 못 찾으면 던진다 — -1로 아래 단언이 헛돌지 않게 */
function rowWhere(sheet: FormSheet, role: string, value: string, from = 0): number {
  for (let r = from; r < sheet.rows.length; r += 1) if (textAt(sheet, r, role) === value) return r;
  throw new Error(`'${sheet.name}'에서 ${role}=${value} 행을 찾지 못했다`);
}

/** 1-based 행 번호 `threshold` 이상을 가리키는 A1 주소를 `by`만큼 민다 */
function shiftFormula(formula: string, threshold: number, by: number): string {
  return formula.replace(/([A-Z]{1,3})(\d+)/g, (_, col: string, row: string) => {
    const n = Number(row);
    return `${col}${n >= threshold ? n + by : n}`;
  });
}

async function uploadedSheets(workbook: InputFormWorkbook): Promise<RawSheet[]> {
  const buffer = await writeInputFormWorkbook(workbook);
  return readWorkbook(new Uint8Array(buffer));
}

function previewFrom(sheets: readonly RawSheet[], existingDetails: readonly BudgetDetail[]): InputFormPreview {
  const parsed = parseInputForm(sheets, { projectId: PROJECT.id, formVersion: INPUT_FORM_VERSION });
  if (!parsed.ok) throw new Error(`파싱 거부: ${parsed.rejection.kind} — ${parsed.rejection.message}`);
  return buildInputFormPreview({
    parsed: parsed.parsed,
    yearId: YEAR.id,
    projectId: PROJECT.id,
    members: MEMBERS,
    existingDetails,
    yearMonths: 9,
  });
}

// ─── 생성 ───────────────────────────────────────────────────

// 옛 양식은 Phase 25 시점 그대로 — 그때 DB에 안전관리비 행이 있을 수 없으므로 그 행 없이 만든다
const newForm = buildInputForm(dataOf(BASE_DETAILS), TODAY);
const oldForm = legacy.buildInputForm(dataOf(BASE_DETAILS), TODAY);
const newBudget = sheetOf(newForm, BUDGET_DEF.name);
const oldBudget = sheetOf(oldForm, BUDGET_DEF.name);

const labFirst = rowWhere(newBudget, 'subcategory', LAB_SAFETY_META_KEY);
const labRows = EMPTY_ROWS_PER_SUBCATEGORY + 1; // 빈 줄 3 + 세목 소계 (§7.9.7)

describe('옛 생성기 픽스처가 정말 옛것이다 (테스트 전제)', () => {
  it('옛 그래프의 간접비 프리셋에는 안전관리비가 없고 현재 그래프에는 끝에 있다', () => {
    expect(SUBCATEGORY_PRESETS.indirect.map((d) => d.code).at(-1)).toBe('indirect_lab_safety');
    expect(oldBudget.rows.some((_, r) => textAt(oldBudget, r, 'subcategory') === LAB_SAFETY_META_KEY)).toBe(false);
    expect(oldBudget.rows.length).toBe(newBudget.rows.length - labRows);
  });
});

describe('IN-4a 새 세목 행 — 다. 성과활용지원비 뒤, 그 아래 좌표만 밀린다', () => {
  it('안전관리비 슬롯은 성과활용지원비 소계 바로 뒤에서 시작하고 빈 줄 3 + "연구실 안전관리비 소계"다', () => {
    const performanceSubtotal = rowWhere(newBudget, 'subcategoryLabel', `다. 성과활용지원비${SUBTOTAL_SUFFIX}`);
    expect(labFirst).toBe(performanceSubtotal + 1);
    for (let i = 0; i < EMPTY_ROWS_PER_SUBCATEGORY; i += 1) {
      expect(textAt(newBudget, labFirst + i, 'subcategory')).toBe(LAB_SAFETY_META_KEY);
      expect(textAt(newBudget, labFirst + i, 'subcategoryLabel')).toBe(LAB_LABEL);
      expect(textAt(newBudget, labFirst + i, 'category')).toBe('간접비');
      expect(newBudget.rowRoles?.[labFirst + i]).toBe('data');
    }
    const subtotal = labFirst + EMPTY_ROWS_PER_SUBCATEGORY;
    expect(textAt(newBudget, subtotal, 'subcategoryLabel')).toBe(`${LAB_LABEL}${SUBTOTAL_SUFFIX}`);
    expect(newBudget.rowRoles?.[subtotal]).toBe('subtotal');
    expect(textAt(newBudget, subtotal + 1, 'category')).toBe(`간접비${SUBTOTAL_SUFFIX}`);
  });

  it('슬롯 앞 행은 옛 양식과 셀·역할까지 같다', () => {
    expect(newBudget.rows.slice(0, labFirst)).toEqual(oldBudget.rows.slice(0, labFirst));
    expect(newBudget.rowRoles?.slice(0, labFirst)).toEqual(oldBudget.rowRoles?.slice(0, labFirst));
  });

  it('슬롯 뒤 행은 옛 양식의 같은 행에서 수식 좌표만 +4 — 간접비 소계 SUM에만 안전관리비 소계가 더해진다', () => {
    const amountCol = columnOf(BUDGET_DEF, 'amount');
    const labSubtotalAddr = `${columnLetter(amountCol)}${labFirst + labRows}`;
    const threshold = labFirst + 1; // 1-based — 옛 양식에서 슬롯 자리 이후 행
    for (let r = labFirst; r < oldBudget.rows.length; r += 1) {
      const oldRow = oldBudget.rows[r]!;
      const newRow = newBudget.rows[r + labRows]!;
      const expected = oldRow.map((cell) =>
        cell.formula === undefined ? cell : { ...cell, formula: shiftFormula(cell.formula, threshold, labRows) }
      );
      if (textAt(oldBudget, r, 'category') === `간접비${SUBTOTAL_SUFFIX}`) {
        const cell = expected[amountCol]!;
        expected[amountCol] = { ...cell, formula: cell.formula!.replace(/\)$/, `,${labSubtotalAddr})`) };
      }
      expect(newRow, `옛 ${r + 1}행`).toEqual(expected);
      expect(newBudget.rowRoles?.[r + labRows]).toBe(oldBudget.rowRoles?.[r]);
    }
  });

  it('열 힌트·숨김 열·드롭다운은 그대로다', () => {
    expect(newBudget.columnHints).toEqual(oldBudget.columnHints);
    expect(newBudget.hiddenColumns).toEqual(oldBudget.hiddenColumns);
    expect(newBudget.validations).toEqual(oldBudget.validations);
  });
});

describe('IN-4a 바이트 불변 — 인건비·작성안내·_meta 기존 키, 양식 버전 1', () => {
  it('INPUT_FORM_VERSION은 1이다', () => {
    expect(INPUT_FORM_VERSION).toBe(1);
    expect(legacy.INPUT_FORM_VERSION).toBe(1);
  });

  it('작성안내·인건비 시트는 옛 양식과 같다', () => {
    expect(sheetOf(newForm, GUIDE_SHEET_NAME)).toEqual(sheetOf(oldForm, GUIDE_SHEET_NAME));
    const personnel = INPUT_FORM_SHEETS.personnel.name;
    expect(sheetOf(newForm, personnel)).toEqual(sheetOf(oldForm, personnel));
    expect(newForm.sheets.map((s) => s.name)).toEqual(oldForm.sheets.map((s) => s.name));
    expect(newForm.fileName).toBe(oldForm.fileName);
  });

  it('_meta는 옛 행을 순서 그대로 두고 indirect:indirect_lab_safety 한 행만 성과활용지원비 뒤에 끼운다', () => {
    const metaName = INPUT_FORM_SHEETS.meta.name;
    const newMeta = sheetOf(newForm, metaName);
    const oldMeta = sheetOf(oldForm, metaName);
    const keyCol = columnOf(INPUT_FORM_SHEETS.meta, 'key');
    const labKey = `subcategory:${LAB_SAFETY_META_KEY}`;
    const at = newMeta.rows.findIndex((row) => row[keyCol]?.value === labKey);
    expect(newMeta.rows[at - 1]?.[keyCol]?.value).toBe('subcategory:indirect:indirect_outcome');
    expect(newMeta.rows.filter((_, i) => i !== at)).toEqual(oldMeta.rows);
    expect({ ...newMeta, rows: [] }).toEqual({ ...oldMeta, rows: [] });
  });
});

// exceljs 쓰기가 Promise라 top-level await로 준비한다 — describe 콜백은 동기다
const oldSheets = await uploadedSheets(oldForm);
const newSheets = await uploadedSheets(buildInputForm(dataOf(ALL_DETAILS), TODAY));

describe('IN-4a 옛 양식 파일 — 거부하지 않고 0행으로 읽고, 기존 안전관리비 행이 있으면 경고', () => {
  it('파싱이 통과하고 안전관리비 행은 0행이다 (_meta에 그 키가 없다)', () => {
    const parsed = parseInputForm(oldSheets, { projectId: PROJECT.id, formVersion: INPUT_FORM_VERSION });
    if (!parsed.ok) throw new Error(parsed.rejection.message);
    expect(parsed.parsed.meta.subcategoryCodes).not.toContain(LAB_SAFETY_META_KEY);
    expect(parsed.parsed.budget.filter((row) => row.subcategory === 'indirect_lab_safety')).toHaveLength(0);
    expect(parsed.parsed.budget.map((row) => row.detailId)).toEqual(['d-a0', 'd-i0']);
  });

  it('DB에 안전관리비 2행 → 경고 1건(SOT 문구, N=2), 막지 않고 간접비 교체로 2행이 삭제 목록에 오른다', () => {
    const preview = previewFrom(oldSheets, ALL_DETAILS);
    const labWarnings = preview.warnings.filter((w) => w.kind === 'lab-safety-missing');
    expect(labWarnings).toEqual([
      {
        kind: 'lab-safety-missing',
        message: '이 양식에는 연구실 안전관리비 행이 없습니다 — 간접비가 교체 대상이면 기존 2행이 지워집니다',
      },
    ]);
    expect(labSafetyMissingMessage(2)).toBe(labWarnings[0]!.message);
    expect(preview.blocked).toBe(false);
    expect(preview.replaceCategories).toContain('indirect');
    expect(preview.deletedDetailIds).toEqual(['d-l0', 'd-l1']);
    // 나머지 행은 손대지 않은 그대로 — 경고 외에 달라지는 것이 없다
    expect(preview.rows.every((row) => row.status === 'unchanged')).toBe(true);
  });

  it('간접비가 교체 대상이 아니어도(양식에 간접비 행 없음) 경고는 뜨고 안전관리비 행은 유지된다', () => {
    const sheets = structuredClone(oldSheets);
    const budget = sheets.find((s) => s.name === BUDGET_DEF.name)!;
    const r = budget.cells.findIndex((row) => row[columnOf(BUDGET_DEF, 'detailId')]?.value === 'd-i0');
    for (const role of ['name', 'spec', 'unitPrice', 'factor1', 'factor2', 'factor3', 'adjustment', 'note']) {
      budget.cells[r]![columnOf(BUDGET_DEF, role)] = { value: null, isError: false };
    }
    const preview = previewFrom(sheets, ALL_DETAILS);
    expect(preview.warnings.map((w) => w.kind)).toContain('lab-safety-missing');
    expect(preview.replaceCategories).not.toContain('indirect');
    expect(preview.untouchedCategories).toEqual([{ category: 'indirect', rowCount: 3 }]);
    expect(preview.deletedDetailIds).toEqual([]);
  });

  it('DB에 안전관리비 행이 없으면 경고가 없다 — 품명이 "연구실 안전관리비"인 indirect_support 행은 세지 않는다', () => {
    const preview = previewFrom(oldSheets, BASE_DETAILS);
    expect(preview.warnings.map((w) => w.kind)).not.toContain('lab-safety-missing');
  });
});

describe('IN-4a 새 양식 파일 — 안전관리비 행이 실리고 왕복해도 그대로다', () => {
  it('경고 없이 전 행 unchanged, 삭제 0', () => {
    const preview = previewFrom(newSheets, ALL_DETAILS);
    expect(preview.warnings.map((w) => w.kind)).not.toContain('lab-safety-missing');
    expect(preview.rows.every((row) => row.status === 'unchanged')).toBe(true);
    expect(preview.deletedDetailIds).toEqual([]);
    const lab = preview.rows.filter((row) => row.subcategory === 'indirect_lab_safety');
    expect(lab.map((row) => [row.detailId, row.category, row.amount])).toEqual([
      ['d-l0', 'indirect', 600_000],
      ['d-l1', 'indirect', 400_000],
    ]);
  });
});
