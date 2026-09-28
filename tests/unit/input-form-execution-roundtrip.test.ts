// 수행 양식 왕복 (SOT §6.16 IN-9~IN-14, 부록 F-6·F-9, §11 Phase 20 완료 기준)
//
// `buildInputForm(…, 'execution')` → `writeInputFormWorkbook`(exceljs, 실제 xlsx 바이트) → `readWorkbook`(올리기
// 경로 그대로, `cellDates: false`) → `parseInputForm(…, 'execution')` → `buildExecutionPreview` →
// `executionCommitPayload`를 한 번에 잇는다. 각 모듈의 단위 테스트는 따로 있고, 여기서는 **경계를 넘을 때**
// 값이 살아 있는가를 본다 — 특히 집행일은 exceljs가 날짜 셀로 쓰고 SheetJS가 직렬값(숫자)으로 읽어 오므로
// FormSheet를 곧장 RawSheet로 옮기는 미리보기 테스트로는 드러나지 않는 하루 밀림이 여기서만 잡힌다.
//
// 사용자 편집은 읽어 온 RawSheet의 셀을 고쳐 흉내 낸다(엑셀에서 고친 뒤 다시 읽은 모습과 같다). 새 집행일은
// 엑셀이 저장하는 모양 그대로 직렬값(숫자)으로 넣는다.

import { beforeAll, describe, expect, it } from 'vitest';
import ExcelJS from 'exceljs';
import {
  INPUT_FORM_VERSION,
  MODE_MISMATCH_MESSAGES,
  buildExecutionPreview,
  buildInputForm,
  columnOf,
  executionCommitPayload,
  parseInputForm,
  sheetsFor,
} from '@/lib/input-form';
import type {
  ExecutionFormPreview,
  ExecutionPreviewBudgetItem,
  ExecutionPreviewCurrent,
  ExecutionPreviewRow,
  InputFormExecution,
  InputFormMode,
} from '@/lib/input-form';
import { excelSerialToISO } from '@/lib/input-form/parse-execution';
import { writeInputFormWorkbook } from '@/lib/input-form-adapter';
import { readWorkbook } from '@/lib/import-adapter';
import { BUDGET_CATEGORY_ORDER, DETAIL_AXIS_LABELS } from '@/lib/constants';
import type { RawCell, RawSheet } from '@/lib/import/types';
import type { BudgetCategory, BudgetDetail, Member } from '@/types';

const PROJECT = { id: 'proj-1', name: '스마트 건설 플랫폼' };
const YEAR = { id: 'year-1', name: '1차년도', startDate: '2025-04-01', endDate: '2025-12-31', order: 0 };
const TODAY = '2026-09-28';
const EXEC = sheetsFor('execution');
const PLAN = sheetsFor('plan');

type FormMember = Member & { staffName: string | null };

function member(id: string, name: string, order: number, projectId = PROJECT.id): FormMember {
  return {
    id,
    name,
    order,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    version: 1,
    createdBy: null,
    updatedBy: null,
    projectId,
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
  // 인건비 시트 · factors 왕복. 산식 60,000,000 × 30% × 1/12 = 1,500,000인데 실제 집행은 1,450,000 —
  // 손대지 않으면 amount-mismatch가 붙지 않아야 한다(IN-11). 집행일은 연차 첫날(KST 하루 밀림이면 기간 밖이 된다)
  execution({
    id: 'e-p1',
    category: 'personnel',
    date: '2025-04-01',
    amount: 1_450_000,
    memberId: 'm-kim',
    subcategoryCode: 'personnel_internal',
    factors: PERSONNEL_FACTORS(30, 1),
    axis: 'cash',
    note: '4월분',
  }),
  // 인건비 시트 · factors 왕복(소수 참여율). 60,000,000 × 12.5% × 2/12 = 1,250,000 (산식과 같음)
  execution({
    id: 'e-p2',
    category: 'personnel',
    date: '2025-12-31',
    amount: 1_250_000,
    memberId: 'm-park',
    subcategoryCode: 'personnel_external',
    factors: PERSONNEL_FACTORS(12.5, 2),
    axis: 'in_kind',
  }),
  // 사업비 · 세목 있음 · 단가×인자 50,000과 다른 실제 집행 48,000 · 산출근거 연결
  execution({
    id: 'e-mat',
    category: 'material',
    date: '2025-05-02',
    amount: 48_000,
    description: '시약',
    spec: '500ml',
    subcategoryCode: 'material_purchase',
    unitPrice: 10_000,
    factors: [{ label: '수량', value: 5, isPercent: false }],
    axis: 'cash',
    detailId: 'd-1',
    note: '할인',
  }),
  // 사업비 · 세목 없음 + default 있는 비목 → `consignment:default` 슬롯
  execution({ id: 'e-cons', category: 'consignment', date: '2025-09-01', amount: 10_000_000, description: '위탁' }),
  // 사업비 · 세목 없음 + default 없는 비목 → `activity:` 세목 미지정 슬롯. 세목마다 인자가 달라 슬롯엔 프리셋
  // 라벨이 없다 — 파서는 인자N으로 읽고 factor-without-preset을 붙이지만 unchanged면 떼야 한다(IN-11)
  execution({
    id: 'e-slot',
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
  // 사업비 · 프리셋 밖 세목 코드 → 생성기가 `activity:zz` 슬롯을 더 깐다. 인자도 프리셋 라벨이 없다
  execution({
    id: 'e-zz',
    category: 'activity',
    subcategoryCode: 'zz',
    date: '2025-07-15',
    amount: 30_000,
    description: '기타 활동',
    unitPrice: 15_000,
    factors: [{ label: '건', value: 2, isPercent: false }],
  }),
  // 인력 없는 인건비 → 사업비 `personnel:` 슬롯
  execution({
    id: 'e-nomember',
    category: 'personnel',
    date: '2025-08-01',
    amount: 1_000_000,
    subcategoryCode: 'personnel_internal',
    factors: PERSONNEL_FACTORS(50, 2),
  }),
];

const CURRENT: ExecutionPreviewCurrent = {
  project: PROJECT,
  year: YEAR,
  members: MEMBERS,
  details: [detail('d-1')],
  executions: EXECUTIONS,
};

const ITEMS: ExecutionPreviewBudgetItem[] = BUDGET_CATEGORY_ORDER.map((category: BudgetCategory) => ({
  yearId: YEAR.id,
  category,
  plannedAmount: 50_000_000,
  cashAmount: null,
  inKindAmount: null,
}));

// ─── 왕복 ────────────────────────────────────────────────────

async function writeBytes(mode: InputFormMode): Promise<Buffer> {
  return writeInputFormWorkbook(buildInputForm(CURRENT, TODAY, mode));
}

let executionBytes: Buffer;
let planBytes: Buffer;

beforeAll(async () => {
  executionBytes = await writeBytes('execution');
  planBytes = await writeBytes('plan');
});

/** 올리기 경로 그대로 읽는다 — 호출마다 새 배열이라 편집이 테스트 사이에 새지 않는다 */
function upload(bytes: Buffer = executionBytes): RawSheet[] {
  return readWorkbook(new Uint8Array(bytes));
}

type SheetKey = 'personnel' | 'budget';

function sheetOf(sheets: RawSheet[], key: SheetKey): RawSheet {
  const found = sheets.find((s) => s.name === EXEC[key].name);
  if (!found) throw new Error(`${EXEC[key].name} 시트가 없다`);
  return found;
}

function cellValue(row: readonly RawCell[] | undefined, key: SheetKey, role: string): RawCell['value'] {
  return row?.[columnOf(EXEC[key], role)]?.value ?? null;
}

function rowIndexOf(sheets: RawSheet[], key: SheetKey, executionId: string): number {
  const found = sheetOf(sheets, key).cells.findIndex((row) => cellValue(row, key, 'executionId') === executionId);
  if (found < 0) throw new Error(`${key} 시트에 ${executionId} 행이 없다`);
  return found;
}

/** 희소 행도 칸을 채워 둔다 — SheetJS는 빈 칸을 만들지 않는다 */
function ensureRow(sheets: RawSheet[], key: SheetKey, r: number): RawCell[] {
  const cells = sheetOf(sheets, key).cells as RawCell[][];
  while (cells.length <= r) cells.push([]);
  const row = cells[r]!;
  const width = EXEC[key].columns.length;
  for (let c = 0; c < width; c += 1) row[c] ??= { value: null, isError: false };
  return row;
}

function setIn(row: RawCell[], key: SheetKey, role: string, value: string | number | null): void {
  row[columnOf(EXEC[key], role)] = { value, isError: false };
}

function setCell(sheets: RawSheet[], key: SheetKey, executionId: string, role: string, value: string | number | null) {
  setIn(ensureRow(sheets, key, rowIndexOf(sheets, key, executionId)), key, role, value);
}

/** 행 복사(숨김 id가 따라온다)를 시트 끝에 붙인다 */
function copyRow(sheets: RawSheet[], key: SheetKey, executionId: string): RawCell[] {
  const cells = sheetOf(sheets, key).cells as RawCell[][];
  const copy = ensureRow(sheets, key, rowIndexOf(sheets, key, executionId)).map((c) => ({ ...c }));
  cells.push(copy);
  return copy;
}

/** 사용자가 행을 지운 것 — 숨김 열까지 비운다 */
function clearRow(sheets: RawSheet[], key: SheetKey, executionId: string): void {
  const cells = sheetOf(sheets, key).cells as RawCell[][];
  const r = rowIndexOf(sheets, key, executionId);
  cells[r] = ensureRow(sheets, key, r).map(() => ({ value: null, isError: false }));
}

/** 사업비 시트에서 그 슬롯 키의 첫 빈 줄(생성기가 슬롯마다 3줄 깐다) */
function emptySlotRow(sheets: RawSheet[], slotKey: string): RawCell[] {
  const cells = sheetOf(sheets, 'budget').cells;
  const r = cells.findIndex(
    (row) =>
      cellValue(row, 'budget', 'subcategory') === slotKey &&
      cellValue(row, 'budget', 'executionId') === null &&
      cellValue(row, 'budget', 'name') === null
  );
  if (r < 0) throw new Error(`${slotKey} 슬롯에 빈 줄이 없다`);
  return ensureRow(sheets, 'budget', r);
}

/** ISO → 엑셀 1900 직렬값. 사용자가 엑셀에 날짜를 적고 저장한 셀이 이 숫자로 읽힌다 */
function serialOf(iso: string): number {
  const [y, m, d] = iso.split('-').map(Number) as [number, number, number];
  return Math.round((Date.UTC(y, m - 1, d) - Date.UTC(1899, 11, 30)) / 86_400_000);
}

function preview(sheets: RawSheet[]): ExecutionFormPreview {
  const result = parseInputForm(sheets, { projectId: PROJECT.id, formVersion: INPUT_FORM_VERSION }, 'execution');
  if (!result.ok) throw new Error(`거부됨: ${result.rejection.message}`);
  return buildExecutionPreview({ parsed: result.parsed, current: CURRENT, budgetItems: ITEMS });
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

// ─── 그대로 올리기 ───────────────────────────────────────────

describe('내려받은 수행 양식을 그대로 올리면 (IN-10)', () => {
  let p: ExecutionFormPreview;
  beforeAll(() => {
    p = preview(upload());
  });

  it('전 행 unchanged, 삭제 후보 0, 충돌 0, 경고 0, 차단 없음', () => {
    expect(p.rows).toHaveLength(EXECUTIONS.length);
    for (const e of EXECUTIONS) expect(rowOf(p, e.id).status, e.id).toBe('unchanged');
    expect(p.deleteCandidates).toEqual([]);
    expect(p.conflicts).toEqual([]);
    expect(p.issues).toEqual([]);
    expect(p.rows.flatMap((r) => r.issues)).toEqual([]);
    expect(p.blocked).toBe(false);
    expect(p.counts).toEqual({
      add: 0,
      update: 0,
      unchanged: EXECUTIONS.length,
      conflict: 0,
      error: 0,
      warning: 0,
      deleteCandidates: 0,
    });
  });

  it('반영될 값이 기존 집행과 전 필드 같다 — 인건비 factors·프리셋 밖 세목·슬롯 세목 포함', () => {
    for (const e of EXECUTIONS) {
      const { id: _id, version: _version, category: _category, ...fields } = e;
      expect(rowOf(p, e.id).values, e.id).toEqual(fields);
    }
    expect(rowOf(p, 'e-p1').values?.factors).toEqual(PERSONNEL_FACTORS(30, 1));
    expect(rowOf(p, 'e-p2').values?.factors).toEqual(PERSONNEL_FACTORS(12.5, 2));
    expect(rowOf(p, 'e-zz').values?.subcategoryCode).toBe('zz');
  });

  it('페이로드가 비어 있다 (삭제 포함이어도)', () => {
    expect(executionCommitPayload(p, false)).toEqual({ adds: [], updates: [], deleteIds: [], expected: {} });
    expect(executionCommitPayload(p, true)).toEqual({ adds: [], updates: [], deleteIds: [], expected: {} });
  });

  it('프리셋 밖 세목 키가 _meta에 실리고 수행 파서가 그 키로 읽는다 (IN-4)', () => {
    const result = parseInputForm(upload(), { projectId: PROJECT.id, formVersion: INPUT_FORM_VERSION }, 'execution');
    if (!result.ok) throw new Error(result.rejection.message);
    expect(result.parsed.meta.subcategoryCodes).toContain('activity:zz');
    const row = result.parsed.budget.find((r) => r.executionId === 'e-zz');
    expect(row).toMatchObject({ category: 'activity', subcategoryCode: 'zz' });
    expect(row?.issues.filter((i) => i.blocking)).toEqual([]);
  });

  it('프리셋 라벨 없는 인자는 파서가 경고하지만 unchanged 행에선 떼고, 기존 라벨이 유지된다 (IN-11)', () => {
    const result = parseInputForm(upload(), { projectId: PROJECT.id, formVersion: INPUT_FORM_VERSION }, 'execution');
    if (!result.ok) throw new Error(result.rejection.message);
    const parsedSlot = result.parsed.budget.find((r) => r.executionId === 'e-slot');
    expect(parsedSlot?.issues.map((i) => i.kind)).toContain('factor-without-preset');
    expect(rowOf(p, 'e-slot').issues).toEqual([]);
    expect(rowOf(p, 'e-slot').values?.factors?.map((f) => f.label)).toEqual(['회', '월']);
    expect(rowOf(p, 'e-zz').issues).toEqual([]);
    expect(rowOf(p, 'e-zz').values?.factors?.map((f) => f.label)).toEqual(['건']);
  });

  it('인자 라벨 경고는 고친 행에는 남는다', () => {
    const sheets = upload();
    setCell(sheets, 'budget', 'e-slot', 'note', '정정');
    const row = rowOf(preview(sheets), 'e-slot');
    expect(row.status).toBe('update');
    expect(kinds(row)).toContain('factor-without-preset');
  });
});

// ─── 날짜·서식 (F-6·F-9) ─────────────────────────────────────

describe('날짜·서식 (F-6·F-9·X-7)', () => {
  it('집행일은 직렬값(숫자)으로 읽혀도 같은 ISO로 돌아온다 — 연차 첫날·마지막 날도 하루 밀리지 않는다', () => {
    const sheets = upload();
    const firstDay = sheetOf(sheets, 'personnel').cells[rowIndexOf(sheets, 'personnel', 'e-p1')];
    const lastDay = sheetOf(sheets, 'personnel').cells[rowIndexOf(sheets, 'personnel', 'e-p2')];
    const firstSerial = cellValue(firstDay, 'personnel', 'executionDate');
    const lastSerial = cellValue(lastDay, 'personnel', 'executionDate');
    expect(typeof firstSerial).toBe('number');
    expect(firstSerial).toBe(serialOf('2025-04-01'));
    expect(excelSerialToISO(firstSerial as number)).toBe('2025-04-01');
    expect(excelSerialToISO(lastSerial as number)).toBe('2025-12-31');

    const result = parseInputForm(sheets, { projectId: PROJECT.id, formVersion: INPUT_FORM_VERSION }, 'execution');
    if (!result.ok) throw new Error(result.rejection.message);
    const parsed = [...result.parsed.personnel, ...result.parsed.budget];
    for (const e of EXECUTIONS) {
      expect(parsed.find((r) => r.executionId === e.id)?.date, e.id).toBe(e.date);
    }
  });

  it("워크북 전 시트 전 셀에 '%'가 든 numFmt가 0개, 집행일 열은 yyyy-mm-dd", async () => {
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(executionBytes as unknown as ArrayBuffer);
    const offenders: string[] = [];
    wb.eachSheet((ws) => {
      ws.eachRow({ includeEmpty: true }, (row, r) => {
        row.eachCell({ includeEmpty: true }, (cell, c) => {
          if (typeof cell.numFmt === 'string' && cell.numFmt.includes('%')) offenders.push(`${ws.name}!${r},${c}`);
        });
      });
    });
    expect(offenders).toEqual([]);

    const personnel = wb.getWorksheet(EXEC.personnel.name)!;
    const sheets = upload();
    const r = rowIndexOf(sheets, 'personnel', 'e-p1') + 1;
    expect(personnel.getCell(r, columnOf(EXEC.personnel, 'executionDate') + 1).numFmt).toBe('yyyy-mm-dd');
  });

  it('인건비 세목·축 열과 사업비 축 열에 드롭다운이 있다', async () => {
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(executionBytes as unknown as ArrayBuffer);
    const sheets = upload();
    const personnel = wb.getWorksheet(EXEC.personnel.name)!;
    const budget = wb.getWorksheet(EXEC.budget.name)!;
    const pRow = rowIndexOf(sheets, 'personnel', 'e-p1') + 1;
    const bRow = rowIndexOf(sheets, 'budget', 'e-mat') + 1;

    const subcategory = personnel.getCell(pRow, columnOf(EXEC.personnel, 'subcategory') + 1).dataValidation;
    expect(subcategory?.type).toBe('list');
    expect(subcategory?.formulae?.[0]).toContain('내부인건비');

    const axisFormula = `"${DETAIL_AXIS_LABELS.cash},${DETAIL_AXIS_LABELS.in_kind}"`;
    const pAxis = personnel.getCell(pRow, columnOf(EXEC.personnel, 'axis') + 1).dataValidation;
    expect(pAxis?.type).toBe('list');
    expect(pAxis?.formulae).toEqual([axisFormula]);
    const bAxis = budget.getCell(bRow, columnOf(EXEC.budget, 'axis') + 1).dataValidation;
    expect(bAxis?.type).toBe('list');
    expect(bAxis?.formulae).toEqual([axisFormula]);
  });
});

// ─── 편집 → 추가·변경·삭제 (IN-10) ───────────────────────────

describe('편집 (IN-10)', () => {
  it('행 수정 → update, 새 행 → add(executionId 없음)', () => {
    const sheets = upload();
    setCell(sheets, 'budget', 'e-cons', 'name', '위탁(정산)');
    setCell(sheets, 'personnel', 'e-p2', 'amount', 1_300_000);

    const fresh = emptySlotRow(sheets, 'material:material_purchase');
    setIn(fresh, 'budget', 'executionDate', serialOf('2025-10-05'));
    setIn(fresh, 'budget', 'name', '장갑');
    setIn(fresh, 'budget', 'unitPrice', 2_000);
    setIn(fresh, 'budget', 'factor1', 3);
    setIn(fresh, 'budget', 'axis', DETAIL_AXIS_LABELS.cash);

    const p = preview(sheets);
    expect(p.blocked).toBe(false);
    expect(rowOf(p, 'e-cons')).toMatchObject({ status: 'update', changedFields: ['description'] });
    expect(rowOf(p, 'e-p2')).toMatchObject({ status: 'update', changedFields: ['amount'] });

    const added = p.rows.filter((r) => r.status === 'add');
    expect(added).toHaveLength(1);
    expect(added[0]).toMatchObject({
      executionId: null,
      category: 'material',
      values: {
        date: '2025-10-05',
        amount: 6_000, // 금액이 비어 단가 × 인자로 채웠다(IN-11)
        description: '장갑',
        subcategoryCode: 'material_purchase',
        unitPrice: 2_000,
        factors: [{ label: '수량', value: 3, isPercent: false }],
        axis: 'cash',
      },
    });
    expect(p.counts).toMatchObject({ add: 1, update: 2, unchanged: EXECUTIONS.length - 2, error: 0 });

    const payload = executionCommitPayload(p);
    expect(payload.adds).toHaveLength(1);
    expect(payload.adds[0]).toMatchObject({ category: 'material', amount: 6_000, date: '2025-10-05' });
    expect(payload.updates.map((u) => u.id).sort()).toEqual(['e-cons', 'e-p2']);
    expect(payload.expected).toEqual({ 'e-cons': 1, 'e-p2': 1 });
  });

  it('행 삭제 → 삭제 후보. 삭제 포함이 꺼져 있으면 페이로드에 없고, 켜면 deleteIds·expected에 있다', () => {
    const sheets = upload();
    clearRow(sheets, 'budget', 'e-cons');
    const p = preview(sheets);
    expect(p.blocked).toBe(false);
    expect(p.deleteCandidates).toEqual([
      { id: 'e-cons', expectedVersion: 1, existing: EXECUTIONS.find((e) => e.id === 'e-cons'), conflict: null },
    ]);
    expect(p.counts.deleteCandidates).toBe(1);

    const off = executionCommitPayload(p, false);
    expect(off.deleteIds).toEqual([]);
    expect(off.expected).toEqual({});
    const on = executionCommitPayload(p, true);
    expect(on.deleteIds).toEqual(['e-cons']);
    expect(on.expected).toEqual({ 'e-cons': 1 });
  });

  it('행 복사(executionId 따라옴) 후 복사본만 고치면 원본 unchanged + 복사본 add', () => {
    const sheets = upload();
    const copy = copyRow(sheets, 'budget', 'e-mat');
    setIn(copy, 'budget', 'name', '시약(추가분)');
    setIn(copy, 'budget', 'amount', 20_000);
    const p = preview(sheets);
    expect(p.blocked).toBe(false);
    const rows = rowsOf(p, 'e-mat');
    expect(rows.map((r) => r.status).sort()).toEqual(['add', 'unchanged']);
    const added = rows.find((r) => r.status === 'add')!;
    expect(added.copiedFrom).toBe('e-mat');
    expect(added.values).toMatchObject({ description: '시약(추가분)', amount: 20_000 });
    expect(p.deleteCandidates).toEqual([]);
    const payload = executionCommitPayload(p);
    expect(payload.adds).toHaveLength(1);
    expect(payload.updates).toEqual([]);
  });

  it('원본과 복사본을 둘 다 고치면 duplicate-execution으로 막힌다', () => {
    const sheets = upload();
    const copy = copyRow(sheets, 'budget', 'e-mat');
    setIn(copy, 'budget', 'name', '시약(추가분)');
    setCell(sheets, 'budget', 'e-mat', 'note', '원본도 고침');
    const p = preview(sheets);
    const rows = rowsOf(p, 'e-mat');
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      expect(row.status).toBe('error');
      expect(kinds(row)).toContain('duplicate-execution');
    }
    expect(p.blocked).toBe(true);
  });
});

// ─── 오류·경고 ───────────────────────────────────────────────

describe('오류·경고 (IN-10·IN-11·IN-13)', () => {
  it('집행일이 비면 blocking no-date', () => {
    const sheets = upload();
    setCell(sheets, 'budget', 'e-cons', 'executionDate', null);
    const p = preview(sheets);
    const row = rowOf(p, 'e-cons');
    expect(row.status).toBe('error');
    expect(kinds(row)).toContain('no-date');
    expect(p.blocked).toBe(true);
    // 오류 행의 id는 시트에 있는 것으로 친다 — 삭제 후보가 되지 않는다
    expect(p.deleteCandidates).toEqual([]);
  });

  it('음수 금액은 blocking amount-negative', () => {
    const sheets = upload();
    setCell(sheets, 'budget', 'e-slot', 'amount', -1);
    const row = rowOf(preview(sheets), 'e-slot');
    expect(row.status).toBe('error');
    expect(kinds(row)).toContain('amount-negative');
  });

  it('amount-mismatch는 고친 행에만 붙는다 — 사업비·인건비 둘 다 (IN-11)', () => {
    const untouched = preview(upload());
    expect(kinds(rowOf(untouched, 'e-mat'))).not.toContain('amount-mismatch');
    expect(kinds(rowOf(untouched, 'e-p1'))).not.toContain('amount-mismatch');

    const sheets = upload();
    setCell(sheets, 'budget', 'e-mat', 'note', '할인 반영');
    setCell(sheets, 'personnel', 'e-p1', 'note', '4월분(정정)');
    const p = preview(sheets);
    const mat = rowOf(p, 'e-mat');
    expect(mat.status).toBe('update');
    expect(mat.issues).toContainEqual(expect.objectContaining({ kind: 'amount-mismatch', blocking: false }));
    const p1 = rowOf(p, 'e-p1');
    expect(p1.status).toBe('update');
    expect(p1.issues).toContainEqual(expect.objectContaining({ kind: 'amount-mismatch', blocking: false }));
    expect(p.counts.warning).toBe(2);
    expect(p.blocked).toBe(false);
  });

  it('새 행의 금액이 단가 × 인자와 다르면 amount-mismatch (add 행에도 남는다)', () => {
    const sheets = upload();
    const fresh = emptySlotRow(sheets, 'material:material_purchase');
    setIn(fresh, 'budget', 'executionDate', serialOf('2025-10-05'));
    setIn(fresh, 'budget', 'name', '장갑');
    setIn(fresh, 'budget', 'unitPrice', 2_000);
    setIn(fresh, 'budget', 'factor1', 3);
    setIn(fresh, 'budget', 'amount', 5_500);
    const added = preview(sheets).rows.find((r) => r.status === 'add')!;
    expect(added.values?.amount).toBe(5_500);
    expect(kinds(added)).toContain('amount-mismatch');
  });

  it('기존 행의 세목을 다른 비목으로 옮기면 blocking category-moved', () => {
    const sheets = upload();
    setCell(sheets, 'budget', 'e-mat', 'subcategory', 'facility_equipment:facility_purchase');
    const row = rowOf(preview(sheets), 'e-mat');
    expect(row.status).toBe('error');
    expect(kinds(row)).toContain('category-moved');
  });

  it('다른 과제 memberId는 blocking unknown-member (IN-13)', () => {
    const sheets = upload();
    setCell(sheets, 'personnel', 'e-p1', 'memberId', 'm-other-project');
    const row = rowOf(preview(sheets), 'e-p1');
    expect(row.status).toBe('error');
    expect(kinds(row)).toContain('unknown-member');
  });

  it('_meta 목록 밖 executionId는 blocking unknown-execution (IN-13)', () => {
    const sheets = upload();
    setCell(sheets, 'budget', 'e-slot', 'executionId', 'e-foreign');
    const p = preview(sheets);
    const row = rowOf(p, 'e-foreign');
    expect(row.status).toBe('error');
    expect(kinds(row)).toContain('unknown-execution');
    expect(p.blocked).toBe(true);
  });

  it('_meta에 없는 프리셋 밖 세목 키는 여전히 unknown-subcategory다', () => {
    const sheets = upload();
    setCell(sheets, 'budget', 'e-zz', 'subcategory', 'activity:yy');
    const row = rowOf(preview(sheets), 'e-zz');
    expect(row.status).toBe('error');
    expect(kinds(row)).toContain('unknown-subcategory');
  });
});

// ─── mode 불일치 (IN-9) ──────────────────────────────────────

describe('mode 불일치 거부 (IN-9)', () => {
  it('제안 양식을 수행 모드로 올리면 거부', () => {
    const result = parseInputForm(
      upload(planBytes),
      { projectId: PROJECT.id, formVersion: INPUT_FORM_VERSION },
      'execution'
    );
    expect(result).toEqual({
      ok: false,
      rejection: { kind: 'mode-mismatch', message: MODE_MISMATCH_MESSAGES.plan },
    });
  });

  it('수행 양식을 제안 모드로 올리면 거부', () => {
    const result = parseInputForm(upload(), { projectId: PROJECT.id, formVersion: INPUT_FORM_VERSION }, 'plan');
    expect(result).toEqual({
      ok: false,
      rejection: { kind: 'mode-mismatch', message: MODE_MISMATCH_MESSAGES.execution },
    });
  });

  it('제안 양식은 제안 모드에서 그대로 읽힌다 (PLAN 좌표 맵)', () => {
    const sheets = upload(planBytes);
    expect(sheets.map((s) => s.name)).toContain(PLAN.budget.name);
    const result = parseInputForm(sheets, { projectId: PROJECT.id, formVersion: INPUT_FORM_VERSION }, 'plan');
    expect(result.ok).toBe(true);
  });
});
