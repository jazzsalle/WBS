// 수행 양식 미리보기·커밋 페이로드 (SOT §6.16 IN-10·IN-11·IN-12·IN-13, §6.4 B-1·B-2, §8.4 O-1, 부록 B.4)
//
// 픽스처는 실제 생성기 → (FormSheet를 RawSheet로) → 실제 파서를 거친다 — 왕복에서 필드가 바뀌지 않는지가
// 이 모듈의 핵심이라(IN-10 투영 비교) 손으로 만든 행으로는 확인할 수 없다. 사용자 편집은 RawSheet 셀을
// executionId로 찾아 고치는 방식으로 흉내 낸다.

import { describe, expect, it } from 'vitest';
import {
  EXECUTION_ISSUES,
  INPUT_FORM_VERSION,
  buildExecutionPreview,
  columnOf,
  executionCommitPayload,
  sheetsFor,
} from '@/lib/input-form';
import type {
  ExecutionFormPreview,
  ExecutionPreviewBudgetItem,
  ExecutionPreviewCurrent,
  ExecutionPreviewRow,
  FormSheet,
  InputFormExecution,
  InputFormSheetKey,
} from '@/lib/input-form';
import { buildInputForm } from '@/lib/input-form/build';
import { parseInputForm } from '@/lib/input-form/parse';
import { BUDGET_CATEGORY_ORDER } from '@/lib/constants';
import type { RawCell, RawSheet } from '@/lib/import/types';
import type { BudgetCategory, BudgetDetail, Member } from '@/types';

const PROJECT = { id: 'proj-1', name: '스마트 건설 플랫폼' };
const YEAR = { id: 'year-1', name: '1차년도', startDate: '2025-04-01', endDate: '2025-12-31', order: 0 };
const TODAY = '2026-09-28';
const EXEC = sheetsFor('execution');

type FormMember = Member & { staffName: string | null };

function member(id: string, name: string, order: number, annualSalary: number | null = 60_000_000): FormMember {
  return {
    id,
    name,
    order,
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
    annualSalary,
    hireType: 'existing',
    staffId: null,
    salaryIncludesRetirement: null,
    salaryIncludesInsurance: null,
    salaryAppliedFrom: null,
    staffName: null,
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
    category: 'material',
    subcategory: 'material_purchase',
    axis: 'cash',
    formula: 'quantity',
    memberId: null,
    name: '시약',
    unitPrice: 10_000,
    spec: '',
    factors: [{ label: '수량', value: 5, isPercent: false }],
    adjustment: 0,
    note: '',
    order: 0,
    amount: 50_000,
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

const PERSONNEL_FACTORS = (rate: number, months: number) => [
  { label: '참여율(%)', value: rate, isPercent: true },
  { label: '참여기간(월)', value: months, isPercent: false },
];

const MEMBERS: FormMember[] = [member('m-kim', '김영', 0), member('m-park', '박선욱', 1)];

const EXECUTIONS: InputFormExecution[] = [
  // 인건비 시트: 세목·인자 있음. 60,000,000 × 30% × 1/12 = 1,500,000
  execution({
    id: 'e-kim-1',
    category: 'personnel',
    date: '2025-05-25',
    amount: 1_500_000,
    memberId: 'm-kim',
    subcategoryCode: 'personnel_external',
    factors: PERSONNEL_FACTORS(30, 1),
    axis: 'cash',
    note: '5월분',
  }),
  // 인건비 시트: 세목 없음 → 기본 라벨 '내부인건비'로 보인다
  execution({ id: 'e-kim-2', category: 'personnel', date: '2025-06-25', amount: 2_250_000, memberId: 'm-kim' }),
  // 학생인건비 세목 없음 → '일반'
  execution({ id: 'e-stu', category: 'student_personnel', date: '2025-07-25', amount: 900_000, memberId: 'm-park' }),
  // 인건비 시트에 보이지 않는 셋째 인자. 60,000,000 × 20% × 3/12 = 3,000,000
  execution({
    id: 'e-extra',
    category: 'personnel',
    date: '2025-08-25',
    amount: 3_000_000,
    memberId: 'm-park',
    subcategoryCode: 'personnel_internal',
    factors: [...PERSONNEL_FACTORS(20, 3), { label: '가산', value: 2, isPercent: false }],
  }),
  // 인력 없는 인건비 → 사업비 시트 `personnel:` 슬롯. 세목이 있어도 슬롯에선 null로 읽힌다
  execution({
    id: 'e-nomember',
    category: 'personnel',
    date: '2025-05-01',
    amount: 1_000_000,
    subcategoryCode: 'personnel_internal',
    factors: PERSONNEL_FACTORS(50, 2),
  }),
  // 사업비 행 memberId(비목 제한 없음) + 앱에서 바꾼 인자 라벨 + 산출근거 연결
  execution({
    id: 'e-mat',
    category: 'material',
    date: '2025-05-02',
    amount: 50_000,
    description: '시약',
    spec: '500ml',
    subcategoryCode: 'material_purchase',
    unitPrice: 10_000,
    factors: [{ label: '박스(수량)', value: 5, isPercent: false }],
    axis: 'cash',
    memberId: 'm-kim',
    detailId: 'd-1',
    note: '긴급',
  }),
  // 연구활동비 세목 없음 → `activity:` 슬롯. 세목마다 인자가 달라 파서는 인자N 라벨로 읽는다
  execution({
    id: 'e-act',
    category: 'activity',
    date: '2025-06-10',
    amount: 60_000,
    description: '자문',
    unitPrice: 10_000,
    factors: [
      { label: '회', value: 2, isPercent: false },
      { label: '월', value: 3, isPercent: false },
    ],
  }),
  // 세목 없음 + default 있는 비목 → `consignment:default` 슬롯(투영 세목은 'default')
  execution({ id: 'e-cons', category: 'consignment', date: '2025-09-01', amount: 10_000_000, description: '위탁' }),
];

const CURRENT: ExecutionPreviewCurrent = {
  project: PROJECT,
  year: YEAR,
  members: MEMBERS,
  details: [detail('d-1')],
  executions: EXECUTIONS,
};

function budgetItems(planned: Partial<Record<BudgetCategory, number>> = {}): ExecutionPreviewBudgetItem[] {
  return BUDGET_CATEGORY_ORDER.map((category) => ({
    yearId: YEAR.id,
    category,
    plannedAmount: planned[category] ?? 0,
    cashAmount: null,
    inKindAmount: null,
  }));
}

const ITEMS = budgetItems({
  personnel: 20_000_000,
  student_personnel: 1_000_000,
  material: 1_000_000,
  activity: 1_000_000,
  consignment: 10_000_000,
});

// ─── 양식 조작 ───────────────────────────────────────────────

function toRaw(sheet: FormSheet): RawSheet {
  return {
    name: sheet.name,
    cells: sheet.rows.map((row) => row.map((cell): RawCell => ({ value: cell.value ?? null, isError: false }))),
    merges: [],
  };
}

interface Form {
  sheets: RawSheet[];
  sheet(key: Exclude<InputFormSheetKey, 'meta'>): RawSheet;
}

function download(current: ExecutionPreviewCurrent = CURRENT): Form {
  const sheets = buildInputForm(current, TODAY, 'execution').sheets.map(toRaw);
  return {
    sheets,
    sheet: (key) => sheets.find((s) => s.name === EXEC[key].name)!,
  };
}

type SheetKey = 'personnel' | 'budget';

function rowIndexOf(form: Form, key: SheetKey, executionId: string): number {
  const col = columnOf(EXEC[key], 'executionId');
  const found = form.sheet(key).cells.findIndex((row) => row[col]?.value === executionId);
  if (found < 0) throw new Error(`${key} 시트에 ${executionId} 행이 없다`);
  return found;
}

function setCell(form: Form, key: SheetKey, executionId: string, role: string, value: string | number | null): void {
  const r = rowIndexOf(form, key, executionId);
  form.sheet(key).cells[r]![columnOf(EXEC[key], role)] = { value, isError: false };
}

/** 행을 복사해 시트 끝에 붙인다(숨김 id가 따라온다) */
function copyRow(form: Form, key: SheetKey, executionId: string): RawCell[] {
  const cells = form.sheet(key).cells;
  const copy = cells[rowIndexOf(form, key, executionId)]!.map((c) => ({ ...c }));
  cells.push(copy);
  return copy;
}

function setIn(row: RawCell[], key: SheetKey, role: string, value: string | number | null): void {
  row[columnOf(EXEC[key], role)] = { value, isError: false };
}

/** 행을 비운다(사용자가 행을 지운 것) */
function clearRow(form: Form, key: SheetKey, executionId: string): void {
  const cells = form.sheet(key).cells;
  const r = rowIndexOf(form, key, executionId);
  cells[r] = cells[r]!.map(() => ({ value: null, isError: false }));
}

function preview(
  form: Form,
  current: ExecutionPreviewCurrent = CURRENT,
  items: ExecutionPreviewBudgetItem[] = ITEMS
): ExecutionFormPreview {
  const result = parseInputForm(form.sheets, { projectId: PROJECT.id, formVersion: INPUT_FORM_VERSION }, 'execution');
  if (!result.ok) throw new Error(`거부됨: ${result.rejection.message}`);
  return buildExecutionPreview({ parsed: result.parsed, current, budgetItems: items });
}

function rowsOf(p: ExecutionFormPreview, executionId: string): ExecutionPreviewRow[] {
  return p.rows.filter((r) => r.executionId === executionId);
}

function rowOf(p: ExecutionFormPreview, executionId: string): ExecutionPreviewRow {
  const rows = rowsOf(p, executionId);
  expect(rows, executionId).toHaveLength(1);
  return rows[0]!;
}

function kinds(row: ExecutionPreviewRow): string[] {
  return row.issues.map((i) => i.kind);
}

function withVersion(id: string, version: number): ExecutionPreviewCurrent {
  return { ...CURRENT, executions: EXECUTIONS.map((e) => (e.id === id ? { ...e, version } : e)) };
}

// ─── 왕복 = 변화 없음 (IN-10 투영 비교) ──────────────────────

describe('내려받은 그대로 올리면 (IN-10)', () => {
  const p = preview(download());

  it('전 행 unchanged, 삭제 후보 0, 충돌 0, 차단 없음', () => {
    expect(p.rows.map((r) => [r.executionId, r.status])).toEqual(
      expect.arrayContaining(EXECUTIONS.map((e) => [e.id, 'unchanged']))
    );
    expect(p.rows).toHaveLength(EXECUTIONS.length);
    expect(p.deleteCandidates).toEqual([]);
    expect(p.conflicts).toEqual([]);
    expect(p.blocked).toBe(false);
    expect(p.counts).toMatchObject({ add: 0, update: 0, unchanged: EXECUTIONS.length, conflict: 0, error: 0 });
  });

  it('양식이 표현하지 못하는 값은 기존 값 그대로다', () => {
    // 세목 없는 인건비(기본 라벨 '내부인건비'로 보임) → null 유지
    expect(rowOf(p, 'e-kim-2').values?.subcategoryCode).toBeNull();
    expect(rowOf(p, 'e-stu').values?.subcategoryCode).toBeNull();
    // 인력 없는 인건비 슬롯: 세목 코드 유지
    expect(rowOf(p, 'e-nomember').values?.subcategoryCode).toBe('personnel_internal');
    // 사업비 행 memberId 유지, 앱에서 바꾼 인자 라벨 유지
    expect(rowOf(p, 'e-mat').values).toMatchObject({
      memberId: 'm-kim',
      factors: [{ label: '박스(수량)', value: 5, isPercent: false }],
    });
    // 연구활동비 미지정 슬롯: 파서는 인자N으로 읽지만 기존 라벨이 남는다
    expect(rowOf(p, 'e-act').values?.factors?.map((f) => f.label)).toEqual(['회', '월']);
    // default 슬롯의 세목 없는 집행
    expect(rowOf(p, 'e-cons').values?.subcategoryCode).toBeNull();
    // 인건비 시트에 보이지 않는 셋째 인자
    expect(rowOf(p, 'e-extra').values?.factors).toHaveLength(3);
  });

  it('페이로드가 비어 있다', () => {
    expect(executionCommitPayload(p)).toEqual({ adds: [], updates: [], deleteIds: [], expected: {} });
    expect(executionCommitPayload(p, true)).toEqual({ adds: [], updates: [], deleteIds: [], expected: {} });
  });

  it('집행률 전후가 같다', () => {
    expect(p.summary.after).toEqual(p.summary.before);
    expect(p.summaryWithDeletes.after).toEqual(p.summary.before);
  });
});

// ─── 변경 ────────────────────────────────────────────────────

describe('변경 (IN-10)', () => {
  it('바꾼 필드만 바뀌고 나머지는 기존 값이다', () => {
    const form = download();
    setCell(form, 'budget', 'e-mat', 'name', '시약 A');
    const row = rowOf(preview(form), 'e-mat');
    expect(row.status).toBe('update');
    expect(row.changedFields).toEqual(['description']);
    expect(row.values).toMatchObject({ description: '시약 A', memberId: 'm-kim', detailId: 'd-1' });
    expect(row.values?.factors?.[0]?.label).toBe('박스(수량)');
  });

  it('사업비 인자 값을 바꾸면 프리셋 라벨로 돌아온다(IN-4 한계)', () => {
    const form = download();
    setCell(form, 'budget', 'e-mat', 'factor1', 6);
    setCell(form, 'budget', 'e-mat', 'amount', 60_000);
    const row = rowOf(preview(form), 'e-mat');
    expect(row.changedFields.sort()).toEqual(['amount', 'factors']);
    expect(row.values?.factors).toEqual([{ label: '수량', value: 6, isPercent: false }]);
  });

  it('인건비 시트 factors는 보이는 두 라벨만 교체하고 나머지 인자는 보존한다', () => {
    const form = download();
    setCell(form, 'personnel', 'e-extra', 'participation', 25);
    setCell(form, 'personnel', 'e-extra', 'amount', 3_750_000);
    const row = rowOf(preview(form), 'e-extra');
    expect(row.status).toBe('update');
    expect(row.changedFields.sort()).toEqual(['amount', 'factors']);
    expect(row.values?.factors).toEqual([
      { label: '참여율(%)', value: 25, isPercent: true },
      { label: '참여기간(월)', value: 3, isPercent: false },
      { label: '가산', value: 2, isPercent: false },
    ]);
    expect(kinds(row)).not.toContain('amount-mismatch');
  });

  it('인건비 시트에서 참여율을 지우면 그 인자만 빠진다', () => {
    const form = download();
    setCell(form, 'personnel', 'e-extra', 'participation', null);
    const row = rowOf(preview(form), 'e-extra');
    expect(row.values?.factors).toEqual([
      { label: '참여기간(월)', value: 3, isPercent: false },
      { label: '가산', value: 2, isPercent: false },
    ]);
  });

  it('인건비 시트에서 세목 라벨을 바꾸면 세목이 바뀐다(같은 비목 안)', () => {
    const form = download();
    setCell(form, 'personnel', 'e-kim-2', 'subcategory', '외부인건비');
    const row = rowOf(preview(form), 'e-kim-2');
    expect(row.status).toBe('update');
    expect(row.changedFields).toEqual(['subcategoryCode']);
    expect(row.values?.subcategoryCode).toBe('personnel_external');
  });

  it('집행일이 연차 기간 밖이면 경고만 하고 반영한다', () => {
    const form = download();
    setCell(form, 'budget', 'e-cons', 'executionDate', '2026-01-15');
    const p = preview(form);
    const row = rowOf(p, 'e-cons');
    expect(row.status).toBe('update');
    expect(kinds(row)).toContain('date-out-of-year');
    expect(p.blocked).toBe(false);
    expect(p.counts.warning).toBeGreaterThan(0);
  });
});

// ─── 인건비 행 금액 (IN-11·IN-12) ────────────────────────────

describe('인건비 행 금액 (IN-11)', () => {
  it('금액이 비면 연봉 × 참여율 × 개월로 채운다 — 같은 값이면 unchanged', () => {
    const form = download();
    setCell(form, 'personnel', 'e-kim-1', 'amount', null);
    const row = rowOf(preview(form), 'e-kim-1');
    expect(row.status).toBe('unchanged');
    expect(row.values?.amount).toBe(1_500_000);
  });

  it('PL-2: 박선욱 74,000,000 × 28% × 9개월 = 15,540,000 (중간 반올림 없음)', () => {
    const current: ExecutionPreviewCurrent = {
      ...CURRENT,
      members: [member('m-kim', '김영', 0), member('m-park', '박선욱', 1, 74_000_000)],
    };
    const form = download(current);
    setCell(form, 'personnel', 'e-extra', 'participation', 28);
    setCell(form, 'personnel', 'e-extra', 'months', 9);
    setCell(form, 'personnel', 'e-extra', 'amount', null);
    const row = rowOf(preview(form, current), 'e-extra');
    expect(row.values?.amount).toBe(15_540_000);
  });

  it('입력 금액이 산식과 다르면 amount-mismatch 경고, 입력이 이긴다', () => {
    const form = download();
    setCell(form, 'personnel', 'e-kim-1', 'amount', 1_400_000);
    const p = preview(form);
    const row = rowOf(p, 'e-kim-1');
    expect(row.status).toBe('update');
    expect(row.values?.amount).toBe(1_400_000);
    const issue = row.issues.find((i) => i.kind === 'amount-mismatch');
    expect(issue?.blocking).toBe(false);
    expect(p.blocked).toBe(false);
  });

  it('채울 수 없으면(참여율 없음) blocking no-amount', () => {
    const form = download();
    setCell(form, 'personnel', 'e-kim-1', 'participation', null);
    setCell(form, 'personnel', 'e-kim-1', 'amount', null);
    const p = preview(form);
    const row = rowOf(p, 'e-kim-1');
    expect(row.status).toBe('error');
    expect(kinds(row)).toContain('no-amount');
    expect(p.blocked).toBe(true);
    expect(() => executionCommitPayload(p)).toThrow();
  });

  it('연봉 미입력이면 채울 수 없다', () => {
    const current: ExecutionPreviewCurrent = {
      ...CURRENT,
      members: [member('m-kim', '김영', 0, null), member('m-park', '박선욱', 1)],
    };
    const form = download(current);
    setCell(form, 'personnel', 'e-kim-1', 'amount', null);
    expect(kinds(rowOf(preview(form, current), 'e-kim-1'))).toContain('no-amount');
  });
});

// ─── 추가 ────────────────────────────────────────────────────

describe('추가 (IN-10)', () => {
  it('executionId 없는 행은 add, 페이로드는 snake_case + category', () => {
    const form = download();
    // 비어 있는 인력 행이 없으므로 기존 행을 복사해 id를 지운다 = 새 행
    const row = copyRow(form, 'personnel', 'e-kim-1');
    setIn(row, 'personnel', 'executionId', null);
    setIn(row, 'personnel', 'executionDate', '2025-09-25');
    setIn(row, 'personnel', 'amount', null);
    const p = preview(form);
    const added = p.rows.filter((r) => r.status === 'add');
    expect(added).toHaveLength(1);
    expect(added[0]!.values?.amount).toBe(1_500_000);

    const payload = executionCommitPayload(p);
    expect(payload.adds).toEqual([
      {
        category: 'personnel',
        date: '2025-09-25',
        amount: 1_500_000,
        description: '',
        note: '5월분',
        subcategory_code: 'personnel_external',
        spec: '',
        unit_price: null,
        factors: PERSONNEL_FACTORS(30, 1),
        axis: 'cash',
        member_id: 'm-kim',
        detail_id: null,
      },
    ]);
    expect(payload.updates).toEqual([]);
    expect(payload.expected).toEqual({});
  });
});

// ─── executionId 중복 (IN-10) ────────────────────────────────

describe('같은 executionId가 여러 행 (IN-10)', () => {
  it('투영과 같은 행이 하나면 그것이 원본, 복사 행은 추가', () => {
    const form = download();
    const copy = copyRow(form, 'budget', 'e-mat');
    setIn(copy, 'budget', 'name', '시약 B');
    setIn(copy, 'budget', 'amount', 70_000);
    const p = preview(form);
    const rows = rowsOf(p, 'e-mat');
    expect(rows.map((r) => r.status).sort()).toEqual(['add', 'unchanged']);
    const added = rows.find((r) => r.status === 'add')!;
    expect(added.copiedFrom).toBe('e-mat');
    expect(added.values).toMatchObject({ description: '시약 B', amount: 70_000 });
    expect(p.deleteCandidates).toEqual([]);

    const payload = executionCommitPayload(p);
    expect(payload.adds).toHaveLength(1);
    expect(payload.adds[0]).toMatchObject({ category: 'material', description: '시약 B', amount: 70_000 });
    expect(payload.updates).toEqual([]);
  });

  it('그대로 복사한 행(투영과 같은 행이 둘)은 전부 duplicate-execution', () => {
    const form = download();
    copyRow(form, 'budget', 'e-mat');
    const p = preview(form);
    const rows = rowsOf(p, 'e-mat');
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      expect(row.status).toBe('error');
      expect(kinds(row)).toContain('duplicate-execution');
    }
    expect(EXECUTION_ISSUES['duplicate-execution'].blocking).toBe(true);
    expect(p.blocked).toBe(true);
    // 오류 행의 id도 시트에 있는 것으로 친다
    expect(p.deleteCandidates).toEqual([]);
  });

  it('둘 다 고친 경우도 가려지지 않으므로 duplicate-execution', () => {
    const form = download();
    const copy = copyRow(form, 'budget', 'e-mat');
    setIn(copy, 'budget', 'name', '시약 B');
    setCell(form, 'budget', 'e-mat', 'spec', '1L');
    const rows = rowsOf(preview(form), 'e-mat');
    expect(rows.every((r) => kinds(r).includes('duplicate-execution'))).toBe(true);
  });
});

// ─── category-moved (IN-10) ──────────────────────────────────

describe('category-moved (IN-10)', () => {
  it('기존 행의 세목 키를 다른 비목으로 바꾸면 blocking', () => {
    const form = download();
    setCell(form, 'budget', 'e-cons', 'subcategory', 'international:default');
    const p = preview(form);
    const row = rowOf(p, 'e-cons');
    expect(row.status).toBe('error');
    expect(kinds(row)).toContain('category-moved');
    expect(p.blocked).toBe(true);
  });

  it('인력 없는 인건비를 학생인건비 슬롯으로 옮겨도 blocking', () => {
    const form = download();
    setCell(form, 'budget', 'e-nomember', 'subcategory', 'student_personnel:');
    expect(kinds(rowOf(preview(form), 'e-nomember'))).toContain('category-moved');
  });

  it('인건비 시트에서 학생인건비 라벨로 바꾸면 blocking', () => {
    const form = download();
    setCell(form, 'personnel', 'e-kim-2', 'subcategory', '일반');
    expect(kinds(rowOf(preview(form), 'e-kim-2'))).toContain('category-moved');
  });

  it('같은 비목 안의 세목 변경은 변경이다', () => {
    const form = download();
    setCell(form, 'budget', 'e-mat', 'subcategory', 'material:material_make');
    const row = rowOf(preview(form), 'e-mat');
    expect(row.status).toBe('update');
    expect(row.values?.subcategoryCode).toBe('material_make');
  });
});

// ─── 삭제 후보·충돌 (IN-10, O-1) ─────────────────────────────

describe('삭제 후보 (IN-10)', () => {
  it('_meta id − 시트 id. includeDeletes가 꺼져 있으면 페이로드에 없다', () => {
    const form = download();
    clearRow(form, 'budget', 'e-cons');
    const p = preview(form);
    expect(p.deleteCandidates.map((d) => [d.id, d.conflict])).toEqual([['e-cons', null]]);
    expect(p.counts.deleteCandidates).toBe(1);

    expect(executionCommitPayload(p)).toEqual({ adds: [], updates: [], deleteIds: [], expected: {} });
    expect(executionCommitPayload(p, true)).toEqual({
      adds: [],
      updates: [],
      deleteIds: ['e-cons'],
      expected: { 'e-cons': 1 },
    });

    // 집행률 전후: 삭제 포함일 때만 위탁 10,000,000이 빠진다
    const consBefore = p.summary.cells.find((c) => c.category === 'consignment')!;
    expect(consBefore.after.executed).toBe(10_000_000);
    const consDeleted = p.summaryWithDeletes.cells.find((c) => c.category === 'consignment')!;
    expect(consDeleted.after.executed).toBe(0);
    expect(p.summaryWithDeletes.after.executed).toBe(p.summary.before.executed - 10_000_000);
  });

  it('오류 행이 가리키는 id는 삭제 후보가 아니다', () => {
    const form = download();
    setCell(form, 'budget', 'e-cons', 'executionDate', '2025-13-40');
    const p = preview(form);
    expect(rowOf(p, 'e-cons').status).toBe('error');
    expect(p.deleteCandidates).toEqual([]);
  });

  it('내려받은 뒤 version이 바뀐 삭제 후보는 지우지 않고 충돌이다', () => {
    const form = download();
    clearRow(form, 'budget', 'e-cons');
    const p = preview(form, withVersion('e-cons', 2));
    expect(p.deleteCandidates[0]).toMatchObject({ id: 'e-cons', conflict: 'changed', expectedVersion: 1 });
    expect(p.conflicts).toEqual([{ id: 'e-cons', reason: 'changed' }]);
    expect(p.counts.deleteCandidates).toBe(0);
    expect(executionCommitPayload(p, true).deleteIds).toEqual([]);
  });
});

describe('충돌 (IN-10, O-1)', () => {
  it('현재 version ≠ _meta version이면 그 행만 conflict로 건너뛴다', () => {
    const form = download();
    setCell(form, 'budget', 'e-mat', 'name', '시약 A');
    setCell(form, 'budget', 'e-act', 'name', '자문 2');
    const p = preview(form, withVersion('e-mat', 2));
    expect(rowOf(p, 'e-mat')).toMatchObject({ status: 'conflict', conflict: 'changed', values: null });
    expect(rowOf(p, 'e-act').status).toBe('update');
    expect(p.blocked).toBe(false);
    expect(p.conflicts).toEqual([{ id: 'e-mat', reason: 'changed' }]);

    const payload = executionCommitPayload(p);
    expect(payload.updates.map((u) => u.id)).toEqual(['e-act']);
    expect(payload.expected).toEqual({ 'e-act': 1 });
  });

  it('내려받은 뒤 다른 경로로 지워진 행은 conflict(deleted)', () => {
    const form = download();
    const current = { ...CURRENT, executions: EXECUTIONS.filter((e) => e.id !== 'e-act') };
    const p = preview(form, current);
    expect(rowOf(p, 'e-act')).toMatchObject({ status: 'conflict', conflict: 'deleted' });
    expect(p.counts.conflict).toBe(1);
  });

  it('비교 기준은 _meta version이다 — 내려받을 때 version이 2였으면 현재 2와 같아 충돌이 아니다', () => {
    const current = withVersion('e-mat', 2);
    const form = download(current);
    setCell(form, 'budget', 'e-mat', 'name', '시약 A');
    const p = preview(form, current);
    expect(rowOf(p, 'e-mat').status).toBe('update');
    expect(executionCommitPayload(p).expected).toEqual({ 'e-mat': 2 });
  });
});

// ─── 페이로드 (IN-10) ────────────────────────────────────────

describe('커밋 페이로드', () => {
  it('update 행은 id·category·전 필드(snake_case)와 expected version을 싣는다', () => {
    const form = download();
    setCell(form, 'budget', 'e-mat', 'note', '긴급 2');
    const payload = executionCommitPayload(preview(form));
    expect(payload.updates).toEqual([
      {
        id: 'e-mat',
        category: 'material',
        date: '2025-05-02',
        amount: 50_000,
        description: '시약',
        note: '긴급 2',
        subcategory_code: 'material_purchase',
        spec: '500ml',
        unit_price: 10_000,
        factors: [{ label: '박스(수량)', value: 5, isPercent: false }],
        axis: 'cash',
        member_id: 'm-kim',
        detail_id: 'd-1',
      },
    ]);
    expect(payload.expected).toEqual({ 'e-mat': 1 });
  });

  it('다른 과제·연차의 현재 데이터를 넘기면 던진다', () => {
    const form = download();
    expect(() => preview(form, { ...CURRENT, year: { ...YEAR, id: 'year-2' } })).toThrow();
  });

  it('예산 셀이 12비목을 다 갖지 않으면 던진다(데이터 손상)', () => {
    expect(() => preview(download(), CURRENT, ITEMS.slice(1))).toThrow();
  });
});

// ─── 부록 B.4 검산 (§6.4 B-1·B-2) ────────────────────────────

describe('부록 B.4 집행률 전후', () => {
  const K = 1_000; // 천원
  const B4_ITEMS = budgetItems({
    personnel: 120_000 * K,
    material: 40_000 * K,
    activity: 25_000 * K,
    allowance: 8_000 * K,
    indirect: 7_000 * K,
  });
  const B4_CURRENT: ExecutionPreviewCurrent = {
    project: PROJECT,
    year: YEAR,
    members: MEMBERS,
    details: [],
    executions: [
      execution({ id: 'b-per', category: 'personnel', date: '2025-06-01', amount: 118_400 * K }),
      execution({ id: 'b-mat', category: 'material', date: '2025-06-01', amount: 30_000 * K, description: '재료' }),
      execution({ id: 'b-act', category: 'activity', date: '2025-06-01', amount: 12_000 * K, description: '활동' }),
      execution({ id: 'b-alw', category: 'allowance', date: '2025-06-01', amount: 8_000 * K, description: '수당' }),
      execution({ id: 'b-ind', category: 'indirect', date: '2025-06-01', amount: 7_000 * K, description: '간접' }),
    ],
  };

  function addMaterialRow(form: Form, amount: number): void {
    const copy = copyRow(form, 'budget', 'b-mat');
    setIn(copy, 'budget', 'executionId', null);
    setIn(copy, 'budget', 'name', '재료 추가');
    setIn(copy, 'budget', 'amount', amount);
  }

  it('반영 전 87.7% → 반영 후 94.3%, 연구재료비 108.0%가 B-2 초과 목록에 새로 오른다', () => {
    const form = download(B4_CURRENT);
    addMaterialRow(form, 13_200 * K);
    const p = preview(form, B4_CURRENT, B4_ITEMS);
    const s = p.summary;

    expect(s.before.planned).toBe(200_000 * K);
    expect(s.before.executed).toBe(175_400 * K);
    expect(s.before.rate).toBeCloseTo(87.7, 10);
    expect(s.after.executed).toBe(188_600 * K);
    expect(s.after.rate).toBeCloseTo(94.3, 10);

    const rate = (c: BudgetCategory) => s.cells.find((x) => x.category === c)!.after.rate;
    expect(rate('personnel')).toBeCloseTo(98.666_666, 5);
    expect(rate('material')).toBeCloseTo(108.0, 10);
    expect(rate('activity')).toBeCloseTo(48.0, 10);
    expect(rate('allowance')).toBe(100);
    expect(rate('indirect')).toBe(100);

    expect(s.overCells.map((c) => [c.category, c.newly])).toEqual([['material', true]]);
    expect(s.cells.find((c) => c.category === 'material')!.before.over).toBe(false);
    expect(s.offBudgetCells).toEqual([]);
  });

  it('B-1: 계획 0인 비목에 집행을 추가하면 예산 외 집행 목록에 오른다', () => {
    const form = download(B4_CURRENT);
    const copy = copyRow(form, 'budget', 'b-mat');
    setIn(copy, 'budget', 'executionId', null);
    setIn(copy, 'budget', 'subcategory', 'consignment:default');
    setIn(copy, 'budget', 'amount', 1_000 * K);
    const p = preview(form, B4_CURRENT, B4_ITEMS);
    expect(p.summary.offBudgetCells.map((c) => c.category)).toEqual(['consignment']);
    expect(p.summary.cells.find((c) => c.category === 'consignment')!.after.rate).toBeNull();
  });
});
