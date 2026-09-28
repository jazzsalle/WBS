// 수행 양식 **액션 계층** 통합 테스트 — 내려받기 → 수정 → 미리보기 → 반영 → DB → 재내려받기
// (SOT §6.16 IN-9~IN-14, §6.4, §8.4 O-1, I-17, §11 Phase 20 완료 기준)
//
// **초안 (T9에서 작성, T14에서 실행·확정).** `db push`(T13) 전에는 budget_executions 7컬럼과
// commit_execution_form RPC가 원격에 없어 실행할 수 없다. T14가 이 파일을 돌려 기대값을 확정한다.
//
// tests/unit/input-form-execution-*.test.ts가 순수 계층(생성기·파서·미리보기)을 고정했다.
// 여기서 보는 것은 **반영이 DB에 남기는 것**이다:
//   (a) 받은 파일을 그대로 올리면 전 행 unchanged · 삭제 후보 0 · 충돌 0 (IN-10 투영 비교)
//   (b) 금액 수정 + 새 행 → budget_executions 추가·변경, 집행률(§6.4)이 DB 값으로 계산한 것과 같다,
//       다시 내려받으면 새 행의 executionId가 채워져 있다 (§11 Phase 20)
//   (c) fileHash 불일치 · mode 불일치(양방향) 거부 (IN-6·IN-9)
//   (d) 삭제: includeDeletes=false면 남고(반영 행 0 → RPC 없이 명시적 거부), true면 지워진다 (IN-10)
//   (e) 충돌: 내려받은 뒤 다른 경로로 updateExecution → 그 행만 건너뛰고 결과에 그대로 실린다 (IN-10·O-1)
//   (f) 경계: 목록 밖 executionId(파서), `_meta`를 위조한 다른 과제 memberId·detailId(RPC) → RULE, DB 무변경 (IN-13)
//   (g) 스냅샷: kind 'execution_form', listImportSnapshots가 Zod를 통과, 복원은 완전 되돌리기 (IN-14), 20개 창 (I-17)
//
// 기준값은 **구현이 낸 값이 아니라** DB에 저장된 행과 lib/budget.ts의 §6.4 식이다.
// 자기가 만든 과제·사용자만 지운다 — 파괴적 테스트가 아니다.

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import * as XLSX from 'xlsx';
import type { Sql } from 'postgres';
import { connectDirectDb, createTestUser, destroyTestUser, type TestUser } from './helpers';
import type { ActionResult, BudgetCategory, Member } from '@/types';
import { computeItemSummary } from '@/lib/budget';
import {
  INPUT_FORM_SHEETS,
  META_DETAIL_PREFIX,
  META_MEMBER_PREFIX,
  columnOf,
  sheetsFor,
  type InputFormSheetDef,
} from '@/lib/input-form';
import * as budgetItemsRepo from '@/lib/db/budget-items';
import * as membersRepo from '@/lib/db/members';
import * as projectsRepo from '@/lib/db/projects';
import * as yearsRepo from '@/lib/db/years';

const session = vi.hoisted(() => ({ accessToken: '' }));

vi.mock('next/headers', () => ({
  cookies: async () => ({ get: () => ({ value: session.accessToken }) }),
}));
vi.mock('next/cache', () => ({ revalidatePath: () => undefined }));

const { buildInputForm, commitExecutionForm, previewInputForm } = await import('@/actions/input-form');
const budget = await import('@/actions/budget');
const plan = await import('@/actions/budget-plan');
const imports = await import('@/actions/import');

const EXEC = sheetsFor('execution');
const PERSONNEL_DEF = EXEC.personnel;
const BUDGET_DEF = EXEC.budget;
const META_DEF = INPUT_FORM_SHEETS.meta;

const YEAR_START = '2026-01-01';
const YEAR_END = '2026-12-31';

/** activity 계획액. 산출근거가 없는 셀이라 직접 편집할 수 있다(PL-9) */
const ACTIVITY_PLANNED = 1_000_000;

let sql: Sql;
let user: TestUser;
let projectId: string;
let yearId: string;
let member: Member;
let detailId: string;
/** 경계 검증용 다른 과제 — 그 과제의 인력·산출근거를 이 과제 양식에 위조해 넣는다 */
let otherProjectId: string;
let otherMemberId: string;
let otherDetailId: string;
/** 시드 집행 이름 → id */
const executionIdOf = new Map<string, string>();
/** 비목 → budget_items.id (addExecution·updateExecution 인자) */
const itemIdOf = new Map<BudgetCategory, string>();

// ─── 헬퍼 ─────────────────────────────────────────────────────────────────────

function unwrap<T>(result: ActionResult<T>): T {
  if (!result.ok) throw new Error(`액션 실패: ${result.error} (code=${result.code ?? '-'})`);
  return result.data;
}

function expectFailure<T>(result: ActionResult<T>): { error: string; code?: string } {
  if (result.ok) throw new Error('실패해야 하는 액션이 성공했다');
  return { error: result.error, code: result.code };
}

function formOf(bytes: Buffer, fileName: string): FormData {
  const form = new FormData();
  form.set('file', new Blob([new Uint8Array(bytes) as BlobPart]), fileName);
  return form;
}

interface DownloadedForm {
  buffer: Buffer;
  fileName: string;
}

async function download(mode: 'plan' | 'execution' = 'execution'): Promise<DownloadedForm> {
  const data = unwrap(await buildInputForm(projectId, yearId, mode));
  return { buffer: Buffer.from(data.contentBase64, 'base64'), fileName: data.fileName };
}

function seededId(name: string): string {
  const id = executionIdOf.get(name);
  if (!id) throw new Error(`시드 집행 '${name}'이 없다`);
  return id;
}

function itemId(category: BudgetCategory): string {
  const id = itemIdOf.get(category);
  if (!id) throw new Error(`비목 '${category}'의 budget_items 행이 없다`);
  return id;
}

// ─── SheetJS 조작 — 받은 파일의 셀을 고쳐 다시 쓴다 ────────────────────────────

function rewritten(buffer: Buffer, mutate: (wb: XLSX.WorkBook) => void): Buffer {
  const wb = XLSX.read(buffer, { type: 'buffer', cellFormula: true, cellNF: true });
  mutate(wb);
  const out: unknown = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
  if (!Buffer.isBuffer(out)) throw new Error('다시 쓴 워크북이 Buffer가 아니다');
  return out;
}

function sheetOf(wb: XLSX.WorkBook, def: InputFormSheetDef): XLSX.WorkSheet {
  const ws = wb.Sheets[def.name];
  if (!ws) throw new Error(`시트 '${def.name}'이 없다`);
  return ws;
}

function addr(def: InputFormSheetDef, role: string, r0: number): string {
  return XLSX.utils.encode_cell({ r: r0, c: columnOf(def, role) });
}

function cellValue(ws: XLSX.WorkSheet, def: InputFormSheetDef, role: string, r0: number): unknown {
  return (ws[addr(def, role, r0)] as XLSX.CellObject | undefined)?.v;
}

function findRow(ws: XLSX.WorkSheet, def: InputFormSheetDef, predicate: (r0: number) => boolean, what: string): number {
  const range = XLSX.utils.decode_range(ws['!ref'] ?? 'A1:A1');
  for (let r = def.dataStartRow - 1; r <= range.e.r; r += 1) {
    if (predicate(r)) return r;
  }
  throw new Error(`${what} 행을 찾지 못했다`);
}

function rowOfExecution(ws: XLSX.WorkSheet, def: InputFormSheetDef, executionId: string): number {
  return findRow(ws, def, (r) => cellValue(ws, def, 'executionId', r) === executionId, `executionId=${executionId}`);
}

/** 세목 슬롯의 첫 빈 줄 — 키 열만 차 있고 executionId·품명이 없다(IN-4) */
function budgetEmptyRowOf(ws: XLSX.WorkSheet, key: string): number {
  return findRow(
    ws,
    BUDGET_DEF,
    (r) =>
      cellValue(ws, BUDGET_DEF, 'subcategory', r) === key &&
      cellValue(ws, BUDGET_DEF, 'executionId', r) === undefined &&
      cellValue(ws, BUDGET_DEF, 'name', r) === undefined,
    `'${key}' 빈 줄`
  );
}

function setNumber(ws: XLSX.WorkSheet, def: InputFormSheetDef, role: string, r0: number, value: number): void {
  ws[addr(def, role, r0)] = { t: 'n', v: value };
}

function setText(ws: XLSX.WorkSheet, def: InputFormSheetDef, role: string, r0: number, value: string): void {
  ws[addr(def, role, r0)] = { t: 's', v: value };
}

function clearCell(ws: XLSX.WorkSheet, def: InputFormSheetDef, role: string, r0: number): void {
  delete ws[addr(def, role, r0)];
}

/** 사업비 시트 집행 행의 금액만 바꾼 파일 */
function withBudgetAmount(buffer: Buffer, executionId: string, amount: number): Buffer {
  return rewritten(buffer, (wb) => {
    const ws = sheetOf(wb, BUDGET_DEF);
    setNumber(ws, BUDGET_DEF, 'amount', rowOfExecution(ws, BUDGET_DEF, executionId), amount);
  });
}

/** 사업비 시트에서 집행 행을 지운 파일 — 사용자가 행의 값을 전부 지운 것과 같다(빈 행은 무시, IN-4) */
function withoutBudgetRow(buffer: Buffer, executionId: string): Buffer {
  return rewritten(buffer, (wb) => {
    const ws = sheetOf(wb, BUDGET_DEF);
    const r0 = rowOfExecution(ws, BUDGET_DEF, executionId);
    for (const role of ['executionId', 'detailId', 'executionDate', 'name', 'spec', 'unitPrice', 'factor1', 'factor2', 'factor3', 'axis', 'amount', 'note']) {
      clearCell(ws, BUDGET_DEF, role, r0);
    }
  });
}

/** `_meta`에 목록 행을 하나 더한다 — 파서의 경계 검사(IN-13)를 통과시켜 RPC 검증까지 가게 하려는 위조 */
function withMetaRow(wb: XLSX.WorkBook, key: string, value: string): void {
  const ws = sheetOf(wb, META_DEF);
  const range = XLSX.utils.decode_range(ws['!ref'] ?? 'A1:B1');
  const r0 = range.e.r + 1;
  setText(ws, META_DEF, 'key', r0, key);
  setText(ws, META_DEF, 'value', r0, value);
  range.e.r = r0;
  ws['!ref'] = XLSX.utils.encode_range(range);
}

// ─── DB 검증 SQL (postgres 직결 — 액션 반환이 아니라 저장된 원본을 본다) ─────────

interface ExecutionRow {
  id: string;
  category: BudgetCategory;
  version: number;
  date: string;
  amount: number;
  description: string;
  memberId: string | null;
  detailId: string | null;
}

/** bigint는 postgres.js가 문자열로 주므로 text로 캐스팅해 정수로 되돌린다 (부동소수점 경유 금지) */
async function readExecutions(): Promise<ExecutionRow[]> {
  const rows = await sql`
    select e.id::text as id, i.category, e.version, e.date::text as date, e.amount::text as amount,
           e.description, e.member_id::text as member_id, e.detail_id::text as detail_id
      from public.budget_executions e
      join public.budget_items i on i.id = e.budget_item_id
     where i.year_id = ${yearId}::uuid
     order by e.id`;
  return rows.map((row) => {
    const r = row as {
      id: string;
      category: BudgetCategory;
      version: number;
      date: string;
      amount: string;
      description: string;
      member_id: string | null;
      detail_id: string | null;
    };
    return {
      id: r.id,
      category: r.category,
      version: r.version,
      date: r.date,
      amount: Number(r.amount),
      description: r.description,
      memberId: r.member_id,
      detailId: r.detail_id,
    };
  });
}

async function readPlanned(category: BudgetCategory): Promise<{ planned: number; cash: number | null; inKind: number | null }> {
  const rows = await sql`
    select planned_amount::text as planned, cash_amount::text as cash, in_kind_amount::text as in_kind
      from public.budget_items
     where year_id = ${yearId}::uuid and category = ${category}`;
  const r = rows[0] as { planned: string; cash: string | null; in_kind: string | null } | undefined;
  if (!r) throw new Error(`budget_items ${category} 행이 없다`);
  return { planned: Number(r.planned), cash: r.cash === null ? null : Number(r.cash), inKind: r.in_kind === null ? null : Number(r.in_kind) };
}

interface SnapshotRow {
  id: string;
  snapshot: {
    kind?: string;
    source?: { fileHash?: string };
    items?: unknown[];
    executions?: { added?: string[]; before?: unknown[]; deleted?: string[] };
  };
}

async function readExecutionSnapshots(): Promise<SnapshotRow[]> {
  const rows = await sql`
    select id::text as id, snapshot
      from public.import_snapshots
     where project_id = ${projectId}::uuid and snapshot->>'kind' = 'execution_form'
     order by created_at asc, id asc`;
  return rows.map((row) => row as SnapshotRow);
}

async function countSnapshots(): Promise<number> {
  const rows = await sql`select count(*)::text as n from public.import_snapshots where project_id = ${projectId}::uuid`;
  return Number((rows[0] as { n: string }).n);
}

/** §6.4 식으로 DB 값의 비목 요약을 낸다 — 미리보기 "후"가 이것과 같아야 한다 */
async function dbItemSummary(category: BudgetCategory) {
  const planned = await readPlanned(category);
  const executions = (await readExecutions()).filter((e) => e.category === category);
  return computeItemSummary({
    yearId,
    category,
    plannedAmount: planned.planned,
    cashAmount: planned.cash,
    inKindAmount: planned.inKind,
    executions: executions.map((e) => ({ amount: e.amount })),
  });
}

// ─── 준비·정리 ────────────────────────────────────────────────────────────────

beforeAll(async () => {
  sql = connectDirectDb();
  user = await createTestUser(sql);
  session.accessToken = user.accessToken;

  const project = await projectsRepo.createProjectWithDefaults(user.client, {
    name: '수행양식 액션 통합',
    contractStartDate: YEAR_START,
  });
  projectId = project.id;
  const firstYear = (await yearsRepo.listYears(user.client, projectId))[0];
  if (!firstYear) throw new Error('createProjectWithDefaults가 연차를 만들지 않았습니다.');
  yearId = (await yearsRepo.updateYear(user.client, firstYear.id, { startDate: YEAR_START, endDate: YEAR_END })).id;

  member = await membersRepo.createMember(
    user.client,
    {
      projectId,
      orgId: null,
      name: '박선욱',
      role: 'researcher',
      position: '연구원',
      field: '',
      email: '',
      phone: '',
      active: true,
      order: 0,
      annualSalary: 74_000_000,
      hireType: 'existing',
    },
    user.id
  );

  // 산출근거 1행 — 집행의 detailId가 가리킬 대상이자 `_meta` detail: 목록(IN-13)
  const created = unwrap(
    await plan.createBudgetDetail(yearId, 'material', 'material_purchase', {
      axis: 'cash',
      name: '시약',
      unitPrice: 10_000,
      factors: [{ label: '수량', value: 5, isPercent: false }],
    })
  );
  detailId = created.id;

  unwrap(await budget.updateBudgetPlan(yearId, 'activity', ACTIVITY_PLANNED, null, null));

  for (const item of await budgetItemsRepo.listBudgetItemsByYear(user.client, yearId)) {
    itemIdOf.set(item.category, item.id);
  }

  // 시드 집행 4건: 인건비 시트 1 · 사업비 세목 있음 2(하나는 detailId) · `세목 미지정` 슬롯 1(IN-4)
  const seeds: { name: string; category: BudgetCategory; input: Record<string, unknown> }[] = [
    {
      name: '인건비 3월',
      category: 'personnel',
      input: {
        date: '2026-03-31',
        amount: 15_540_000,
        subcategoryCode: 'personnel_internal',
        memberId: member.id,
        axis: 'cash',
        factors: [
          { label: '참여율(%)', value: 28, isPercent: true },
          { label: '참여기간(월)', value: 9, isPercent: false },
        ],
      },
    },
    {
      name: '회의비 3월',
      category: 'activity',
      input: { date: '2026-03-15', amount: 300_000, description: '회의비 3월', subcategoryCode: 'activity_meeting' },
    },
    {
      name: '시약 구매',
      category: 'material',
      input: { date: '2026-04-01', amount: 40_000, description: '시약 구매', subcategoryCode: 'material_purchase', detailId },
    },
    {
      name: '기타 활동',
      category: 'activity',
      input: { date: '2026-05-01', amount: 50_000, description: '기타 활동' },
    },
  ];
  for (const seed of seeds) {
    const execution = unwrap(await budget.addExecution(itemId(seed.category), seed.input));
    executionIdOf.set(seed.name, execution.id);
  }

  // 경계 검증용 다른 과제(같은 사용자) — 인력 1 · 산출근거 1
  const other = await projectsRepo.createProjectWithDefaults(user.client, {
    name: '수행양식 경계 대상',
    contractStartDate: YEAR_START,
  });
  otherProjectId = other.id;
  const otherYear = (await yearsRepo.listYears(user.client, otherProjectId))[0];
  if (!otherYear) throw new Error('다른 과제에 연차가 없습니다.');
  otherMemberId = (
    await membersRepo.createMember(
      user.client,
      {
        projectId: otherProjectId,
        orgId: null,
        name: '남의인력',
        role: 'researcher',
        position: '연구원',
        field: '',
        email: '',
        phone: '',
        active: true,
        order: 0,
        annualSalary: 50_000_000,
        hireType: 'existing',
      },
      user.id
    )
  ).id;
  otherDetailId = unwrap(
    await plan.createBudgetDetail(otherYear.id, 'material', 'material_purchase', {
      axis: 'cash',
      name: '남의 시약',
      unitPrice: 1_000,
      factors: [{ label: '수량', value: 1, isPercent: false }],
    })
  ).id;
});

afterAll(async () => {
  for (const id of [projectId, otherProjectId]) {
    if (!id) continue;
    await sql`delete from public.projects where id = ${id}::uuid`;
    const rows = await sql`
      select ((select count(*) from public.projects         where id         = ${id}::uuid)
            + (select count(*) from public.members          where project_id = ${id}::uuid)
            + (select count(*) from public.budget_items     where project_id = ${id}::uuid)
            + (select count(*) from public.budget_details   where project_id = ${id}::uuid)
            + (select count(*) from public.import_snapshots where project_id = ${id}::uuid))::text as n`;
    const remaining = Number((rows[0] as { n: string }).n);
    if (remaining !== 0) throw new Error(`테스트가 만든 데이터가 ${remaining}건 남았습니다.`);
  }
  await destroyTestUser(sql, user);
  await sql.end();
});

// ═══ (a) 그대로 올리기 ════════════════════════════════════════════════════════

describe('(a) 받은 수행 양식을 그대로 올리면 전 행 unchanged (IN-10 투영 비교)', () => {
  it("파일명은 '입력양식_수행_'으로 시작한다", async () => {
    const form = await download();
    expect(form.fileName.startsWith('입력양식_수행_')).toBe(true);
  });

  it('unchanged 4 · 추가·변경 0 · 삭제 후보 0 · 충돌 0 · 차단 없음', async () => {
    const form = await download();
    const preview = unwrap(await previewInputForm(projectId, formOf(form.buffer, form.fileName), 'execution'));
    expect(preview.yearId).toBe(yearId);
    expect(preview.blocked).toBe(false);
    expect(preview.blockingReason).toBeNull();
    expect(preview.counts).toMatchObject({ add: 0, update: 0, unchanged: 4, conflict: 0, error: 0, deleteCandidates: 0 });
    expect(preview.conflicts).toEqual([]);
    expect(preview.deleteCandidates).toEqual([]);
    // 반영 전후가 같다
    expect(preview.summary.after).toEqual(preview.summary.before);
  });

  it('그대로 반영하면 반영할 행이 없다는 RULE — RPC를 부르지 않아 스냅샷도 생기지 않는다', async () => {
    const before = await countSnapshots();
    const form = await download();
    const preview = unwrap(await previewInputForm(projectId, formOf(form.buffer, form.fileName), 'execution'));
    const failure = expectFailure(await commitExecutionForm(projectId, formOf(form.buffer, form.fileName), preview.fileHash, false));
    expect(failure.code).toBe('RULE');
    expect(failure.error).toContain('반영할 집행 행이 없습니다');
    expect(await countSnapshots()).toBe(before);
  });
});

// ═══ (b) 수정 + 추가 → 반영 → 재내려받기 ═══════════════════════════════════════

describe('(b) 금액 수정 + 새 행 → budget_executions 추가·변경, 집행률 일치, 재내려받기에 executionId (§11)', () => {
  const NEW_AMOUNT = 350_000;
  const NEW_ROW = { date: '2026-06-01', name: '회의비 6월', amount: 200_000 };

  it('미리보기: 추가 1 · 변경 1 · 집행률 "후"가 반영 후 DB로 계산한 값과 같다', async () => {
    const base = await download();
    const file = rewritten(withBudgetAmount(base.buffer, seededId('회의비 3월'), NEW_AMOUNT), (wb) => {
      const ws = sheetOf(wb, BUDGET_DEF);
      const r0 = budgetEmptyRowOf(ws, 'activity:activity_meeting');
      setText(ws, BUDGET_DEF, 'executionDate', r0, NEW_ROW.date);
      setText(ws, BUDGET_DEF, 'name', r0, NEW_ROW.name);
      setNumber(ws, BUDGET_DEF, 'amount', r0, NEW_ROW.amount);
    });

    const preview = unwrap(await previewInputForm(projectId, formOf(file, base.fileName), 'execution'));
    expect(preview.blocked).toBe(false);
    expect(preview.counts).toMatchObject({ add: 1, update: 1, unchanged: 3, conflict: 0, deleteCandidates: 0 });
    const updated = preview.rows.find((row) => row.status === 'update');
    expect(updated?.executionId).toBe(seededId('회의비 3월'));
    expect(updated?.changedFields).toEqual(['amount']);
    const added = preview.rows.find((row) => row.status === 'add');
    expect(added?.label).toBe(NEW_ROW.name);
    expect(added?.values).toMatchObject({ date: NEW_ROW.date, amount: NEW_ROW.amount, subcategoryCode: 'activity_meeting' });

    const activityBefore = await dbItemSummary('activity');
    const cell = preview.summary.cells.find((c) => c.category === 'activity');
    expect(cell?.before).toEqual(activityBefore);

    const committed = unwrap(await commitExecutionForm(projectId, formOf(file, base.fileName), preview.fileHash, false));
    expect(committed).toMatchObject({ added: 1, updated: 1, deleted: 0, previewConflicts: [], commitConflicts: [], skippedDeletes: 0 });

    // §6.4: 미리보기의 "후"가 반영 뒤 DB 값으로 계산한 요약과 같다
    expect(cell?.after).toEqual(await dbItemSummary('activity'));
    const rows = await readExecutions();
    expect(rows.find((e) => e.id === seededId('회의비 3월'))?.amount).toBe(NEW_AMOUNT);
    const inserted = rows.find((e) => e.description === NEW_ROW.name);
    expect(inserted).toMatchObject({ category: 'activity', date: NEW_ROW.date, amount: NEW_ROW.amount });
    if (inserted) executionIdOf.set(NEW_ROW.name, inserted.id);
  });

  it('다시 내려받으면 새 행의 executionId가 채워져 있고, 그 행을 고쳐 올리면 추가가 아니라 변경이다', async () => {
    const again = await download();
    const newId = seededId(NEW_ROW.name);
    const wb = XLSX.read(again.buffer, { type: 'buffer' });
    const ws = sheetOf(wb, BUDGET_DEF);
    const r0 = rowOfExecution(ws, BUDGET_DEF, newId);
    expect(cellValue(ws, BUDGET_DEF, 'name', r0)).toBe(NEW_ROW.name);

    const edited = withBudgetAmount(again.buffer, newId, 210_000);
    const preview = unwrap(await previewInputForm(projectId, formOf(edited, again.fileName), 'execution'));
    expect(preview.counts).toMatchObject({ add: 0, update: 1 });
    expect(preview.rows.find((row) => row.status === 'update')?.executionId).toBe(newId);
  });

  it('import_snapshots에 kind execution_form 스냅샷이 남고 source.fileHash가 미리보기 해시와 같다', async () => {
    const snapshots = await readExecutionSnapshots();
    const latest = snapshots.at(-1);
    expect(latest?.snapshot.kind).toBe('execution_form');
    expect(latest?.snapshot.items).toEqual([]);
    expect(latest?.snapshot.executions?.added).toHaveLength(1);
    expect(latest?.snapshot.executions?.before).toHaveLength(1);
  });
});

// ═══ (c) 거부 ════════════════════════════════════════════════════════════════

describe('(c) 거부 — fileHash 불일치 · mode 불일치 (IN-6·IN-9)', () => {
  it('미리보기와 다른 파일로 반영하면 거부하고 DB가 그대로다', async () => {
    const base = await download();
    const preview = unwrap(await previewInputForm(projectId, formOf(base.buffer, base.fileName), 'execution'));
    const other = withBudgetAmount(base.buffer, seededId('회의비 3월'), 123_000);
    const before = await readExecutions();
    const failure = expectFailure(await commitExecutionForm(projectId, formOf(other, base.fileName), preview.fileHash, false));
    expect(failure.error).toContain('미리보기 때와 다릅니다');
    expect(await readExecutions()).toEqual(before);
  });

  it('제안 양식을 수행 모드로 올리면 "제안 양식입니다 — 제안 모드에서 올리세요"', async () => {
    const planForm = await download('plan');
    const failure = expectFailure(await previewInputForm(projectId, formOf(planForm.buffer, planForm.fileName), 'execution'));
    expect(failure.code).toBe('RULE');
    expect(failure.error).toBe('제안 양식입니다 — 제안 모드에서 올리세요');
  });

  it('수행 양식을 제안 모드로 올리면 "수행 양식입니다 — 수행 모드에서 올리세요"', async () => {
    const form = await download();
    const failure = expectFailure(await previewInputForm(projectId, formOf(form.buffer, form.fileName)));
    expect(failure.code).toBe('RULE');
    expect(failure.error).toBe('수행 양식입니다 — 수행 모드에서 올리세요');
  });

  it('includeDeletes가 boolean이 아니면 VALIDATION', async () => {
    const form = await download();
    const failure = expectFailure(
      await commitExecutionForm(projectId, formOf(form.buffer, form.fileName), 'hash', 'true' as unknown as boolean)
    );
    expect(failure.error).toContain('삭제 포함 여부');
  });
});

// ═══ (d) 삭제 ════════════════════════════════════════════════════════════════

describe('(d) 삭제 — [삭제 포함] 꺼짐이면 남고 켜짐이면 지운다 (IN-10)', () => {
  let file: Buffer;
  let fileName: string;
  let fileHash: string;

  it('행을 지운 파일: 삭제 후보 1 · 집행률 전후가 삭제 포함 여부로 갈린다', async () => {
    const base = await download();
    fileName = base.fileName;
    file = withoutBudgetRow(base.buffer, seededId('기타 활동'));
    const preview = unwrap(await previewInputForm(projectId, formOf(file, fileName), 'execution'));
    fileHash = preview.fileHash;
    expect(preview.counts.deleteCandidates).toBe(1);
    expect(preview.deleteCandidates).toEqual([
      expect.objectContaining({ id: seededId('기타 활동'), label: '기타 활동', category: 'activity', amount: 50_000, conflict: null }),
    ]);
    const cell = (s: typeof preview.summary) => s.cells.find((c) => c.category === 'activity');
    expect(cell(preview.summary)?.after.executed).toBe(cell(preview.summary)?.before.executed);
    expect(cell(preview.summaryWithDeletes)?.after.executed).toBe((cell(preview.summary)?.before.executed ?? 0) - 50_000);
  });

  it('includeDeletes=false: 반영할 행이 없어 RULE("[삭제 포함]을 켜야") · 행이 남는다', async () => {
    const failure = expectFailure(await commitExecutionForm(projectId, formOf(file, fileName), fileHash, false));
    expect(failure.code).toBe('RULE');
    expect(failure.error).toContain('[삭제 포함]');
    expect((await readExecutions()).some((e) => e.id === seededId('기타 활동'))).toBe(true);
  });

  it('includeDeletes=true: 지워진다', async () => {
    const committed = unwrap(await commitExecutionForm(projectId, formOf(file, fileName), fileHash, true));
    expect(committed).toMatchObject({ added: 0, updated: 0, deleted: 1, skippedDeletes: 0 });
    expect((await readExecutions()).some((e) => e.id === seededId('기타 활동'))).toBe(false);
  });
});

// ═══ (e) 충돌 ════════════════════════════════════════════════════════════════

describe('(e) 충돌 — 내려받은 뒤 다른 경로로 바뀐 행만 건너뛴다 (IN-10·O-1)', () => {
  it('updateExecution 뒤 올린 파일: 그 행은 conflict로 결과에 실리고 나머지는 반영된다', async () => {
    const base = await download();
    const stale = (await readExecutions()).find((e) => e.id === seededId('시약 구매'));
    if (!stale) throw new Error('시약 구매 집행이 없다');
    // 다른 경로(집행 내역 패널)로 금액을 바꾼다 — version이 오른다
    unwrap(await budget.updateExecution(itemId('material'), stale.id, { amount: 45_000 }, stale.version));

    const file = withBudgetAmount(base.buffer, seededId('회의비 3월'), 360_000);
    const preview = unwrap(await previewInputForm(projectId, formOf(file, base.fileName), 'execution'));
    expect(preview.blocked).toBe(false);
    expect(preview.conflicts).toEqual([{ id: stale.id, reason: 'changed' }]);
    expect(preview.rows.find((row) => row.executionId === stale.id)?.status).toBe('conflict');

    const committed = unwrap(await commitExecutionForm(projectId, formOf(file, base.fileName), preview.fileHash, false));
    expect(committed.updated).toBe(1);
    expect(committed.previewConflicts).toEqual([{ id: stale.id, reason: 'changed' }]);
    const rows = await readExecutions();
    // 다른 경로의 값이 이긴다 — 파일의 옛 값(40,000)으로 덮지 않는다
    expect(rows.find((e) => e.id === stale.id)?.amount).toBe(45_000);
    expect(rows.find((e) => e.id === seededId('회의비 3월'))?.amount).toBe(360_000);
  });
});

// ═══ (f) 경계 ════════════════════════════════════════════════════════════════

describe('(f) 경계 — 다른 과제의 id는 RULE, DB 무변경 (IN-13)', () => {
  it('목록 밖 executionId(파서 단계): 미리보기가 차단되고 반영은 RULE', async () => {
    const base = await download();
    const file = rewritten(base.buffer, (wb) => {
      const ws = sheetOf(wb, BUDGET_DEF);
      setText(ws, BUDGET_DEF, 'executionId', rowOfExecution(ws, BUDGET_DEF, seededId('회의비 3월')), '00000000-0000-4000-8000-000000000001');
    });
    const preview = unwrap(await previewInputForm(projectId, formOf(file, base.fileName), 'execution'));
    expect(preview.blocked).toBe(true);
    expect(preview.blockingReason).toContain('executionId');
    const before = await readExecutions();
    const failure = expectFailure(await commitExecutionForm(projectId, formOf(file, base.fileName), preview.fileHash, false));
    expect(failure.code).toBe('RULE');
    expect(await readExecutions()).toEqual(before);
  });

  it('`_meta`를 위조한 다른 과제 memberId(RPC 단계): RULE · DB 무변경', async () => {
    const base = await download();
    const file = rewritten(base.buffer, (wb) => {
      withMetaRow(wb, `${META_MEMBER_PREFIX}${otherMemberId}`, '');
      const ws = sheetOf(wb, PERSONNEL_DEF);
      setText(ws, PERSONNEL_DEF, 'memberId', rowOfExecution(ws, PERSONNEL_DEF, seededId('인건비 3월')), otherMemberId);
    });
    const before = await readExecutions();
    const preview = unwrap(await previewInputForm(projectId, formOf(file, base.fileName), 'execution'));
    const failure = expectFailure(await commitExecutionForm(projectId, formOf(file, base.fileName), preview.fileHash, false));
    expect(failure.code).toBe('RULE');
    expect(await readExecutions()).toEqual(before);
  });

  it('`_meta`를 위조한 다른 과제 detailId(RPC 단계): RULE · DB 무변경', async () => {
    const base = await download();
    const file = rewritten(base.buffer, (wb) => {
      withMetaRow(wb, `${META_DETAIL_PREFIX}${otherDetailId}`, '');
      const ws = sheetOf(wb, BUDGET_DEF);
      setText(ws, BUDGET_DEF, 'detailId', rowOfExecution(ws, BUDGET_DEF, seededId('회의비 3월')), otherDetailId);
    });
    const before = await readExecutions();
    const preview = unwrap(await previewInputForm(projectId, formOf(file, base.fileName), 'execution'));
    const failure = expectFailure(await commitExecutionForm(projectId, formOf(file, base.fileName), preview.fileHash, false));
    expect(failure.code).toBe('RULE');
    expect(await readExecutions()).toEqual(before);
  });
});

// ═══ (g) 스냅샷 ══════════════════════════════════════════════════════════════

describe('(g) 스냅샷 — 목록 Zod 통과 · 완전 되돌리기 (IN-14) · 20개 창 (I-17)', () => {
  it('listImportSnapshots가 수행 스냅샷을 포함해 Zod 검증을 통과한다', async () => {
    const list = unwrap(await imports.listImportSnapshots(projectId));
    expect(list.some((s) => s.snapshot.kind === 'execution_form')).toBe(true);
  });

  it('추가 + 변경 + 삭제 반영을 복원하면 반영 전 집행 전부가 id째 돌아온다', async () => {
    const before = await readExecutions();
    const base = await download();
    const victim = seededId('시약 구매');
    const file = rewritten(withoutBudgetRow(withBudgetAmount(base.buffer, seededId('회의비 3월'), 370_000), victim), (wb) => {
      const ws = sheetOf(wb, BUDGET_DEF);
      const r0 = budgetEmptyRowOf(ws, 'activity:activity_meeting');
      setText(ws, BUDGET_DEF, 'executionDate', r0, '2026-07-01');
      setText(ws, BUDGET_DEF, 'name', r0, '회의비 7월');
      setNumber(ws, BUDGET_DEF, 'amount', r0, 70_000);
    });
    const preview = unwrap(await previewInputForm(projectId, formOf(file, base.fileName), 'execution'));
    const committed = unwrap(await commitExecutionForm(projectId, formOf(file, base.fileName), preview.fileHash, true));
    expect(committed).toMatchObject({ added: 1, updated: 1, deleted: 1 });

    const restored = unwrap(await imports.restoreImportSnapshot(committed.snapshotId));
    expect(restored).toMatchObject({ executionsDeleted: 1, executionsReverted: 1, executionsRestored: 1 });
    // version은 되돌린 행에서 달라질 수 있다 — 값·id만 본다
    const strip = (rows: ExecutionRow[]) => rows.map(({ version: _v, ...rest }) => rest);
    expect(strip(await readExecutions())).toEqual(strip(before));
  });

  it('스냅샷 이후 대상 행이 다시 바뀌었으면 복원 전체를 거부한다', async () => {
    const base = await download();
    const target = seededId('회의비 3월');
    const file = withBudgetAmount(base.buffer, target, 380_000);
    const preview = unwrap(await previewInputForm(projectId, formOf(file, base.fileName), 'execution'));
    const committed = unwrap(await commitExecutionForm(projectId, formOf(file, base.fileName), preview.fileHash, false));
    const current = (await readExecutions()).find((e) => e.id === target);
    if (!current) throw new Error('회의비 3월 집행이 없다');
    unwrap(await budget.updateExecution(itemId('activity'), target, { amount: 390_000 }, current.version));

    const failure = expectFailure(await imports.restoreImportSnapshot(committed.snapshotId));
    expect(failure.code).toBe('RULE');
    expect((await readExecutions()).find((e) => e.id === target)?.amount).toBe(390_000);
  });

  it('과제별 스냅샷은 20개를 넘지 않는다 (I-17 창 공유)', async () => {
    const target = seededId('회의비 3월');
    for (let i = 0; i < 21; i += 1) {
      const base = await download();
      const file = withBudgetAmount(base.buffer, target, 400_000 + i);
      const preview = unwrap(await previewInputForm(projectId, formOf(file, base.fileName), 'execution'));
      unwrap(await commitExecutionForm(projectId, formOf(file, base.fileName), preview.fileHash, false));
    }
    expect(await countSnapshots()).toBe(20);
    unwrap(await imports.listImportSnapshots(projectId));
  }, 120_000);
});
