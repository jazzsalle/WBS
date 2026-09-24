// 사업비 입력 양식 **액션 계층** 통합 테스트 — 내려받기 → 미리보기 → 수정 반영 → DB → 재내려받기
// (SOT §6.16 IN-5·IN-6, §6.11 D-15a·D-17, §6.10 PL-10, §11 Phase 17 완료 기준)
//
// tests/unit/input-form-roundtrip.test.ts가 순수 계층 + 어댑터의 왕복(앱 데이터 → 파일 → 파서 → 미리보기)을
// 고정했고, tests/integration/input-form-smoke.test.ts가 액션 셋이 세션·RLS 경로에서 이어지는지를 봤다.
// 여기서 보는 것은 **반영이 DB에 남기는 것**이다:
//   (a) 수정 커밋 → `budget_details` 금액이 PL-1 재계산값 · 비목 행 수 · `budget_items` 축별 합계(PL-10) ·
//       `import_snapshots`에 `details` 키(D-17)와 `source.fileHash`
//   (b) 다시 내려받으면 적은 값이 채워져 있다 (§11 행 왕복)
//   (c) fileHash 불일치 · 다른 과제의 양식 · formVersion 불일치 → 거부 (IN-2·IN-6)
//   (d) 경고(연차 개월 초과)만 있는 파일은 반영된다 (PL-15·RL-1)
//   (e) 미리보기 뒤 다른 경로로 들어온 행은 지우지 않고 `skippedLocked`로 드러낸다 (D-15a)
//   (f) blocking(참여율 범위 밖)이면 거부하고 DB가 한 행도 변하지 않는다
//   (g) 양식에 없는 비목의 기존 행은 유지된다 (IN-5)
//
// 기준값은 **구현이 낸 값이 아니라** `computeDetailAmount`(PL-10a의 단일 산식)와 SOT 숫자다. 부록 B.7.1의
// 박선욱 행(74,000,000 × 28% × 9/12 = 15,540,000)을 소형 시드로 가져와 참여율만 40으로 바꾼다.
//
// 자기가 만든 과제·사용자만 지운다 — 파괴적 테스트가 아니다.

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import * as XLSX from 'xlsx';
import type { Sql } from 'postgres';
import { connectDirectDb, createTestUser, destroyTestUser, type TestUser } from './helpers';
import type { ActionResult, BudgetCategory, DetailAxis, DetailFactor, Member } from '@/types';
import { computeDetailAmount } from '@/lib/budget-plan';
import { DETAIL_AXIS_LABELS } from '@/lib/constants';
import { INPUT_FORM_SHEETS, INPUT_FORM_VERSION, META_KEYS, columnOf } from '@/lib/input-form';
import { readWorkbook } from '@/lib/import-adapter';
import * as membersRepo from '@/lib/db/members';
import * as projectsRepo from '@/lib/db/projects';
import * as yearsRepo from '@/lib/db/years';

const session = vi.hoisted(() => ({ accessToken: '' }));

vi.mock('next/headers', () => ({
  cookies: async () => ({ get: () => ({ value: session.accessToken }) }),
}));
vi.mock('next/cache', () => ({ revalidatePath: () => undefined }));

const { buildInputForm, commitInputForm, previewInputForm } = await import('@/actions/input-form');
const plan = await import('@/actions/budget-plan');

const PERSONNEL_DEF = INPUT_FORM_SHEETS.personnel;
const BUDGET_DEF = INPUT_FORM_SHEETS.budget;
const META_DEF = INPUT_FORM_SHEETS.meta;

/** 연차 2026-01-01 ~ 2026-09-30 — 부록 B.7.1의 "참여기간 9개월"과 같다. 12개월이면 개월 초과 경고(d)를 낼 수 없다(13은 범위 밖 blocking) */
const YEAR_START = '2026-01-01';
const YEAR_END = '2026-09-30';
const YEAR_MONTHS = 9;

// ─── 소형 시드 (인건비 2행 + 회의비 1행 + 간접비 1행) ─────────────────────────
//
// 인건비는 부록 B.7.1의 두 행 그대로다 — 기대 금액이 SOT에 있다

interface PersonnelSeed {
  name: string;
  annualSalary: number;
  rate: number;
  months: number;
  axis: DetailAxis;
  /** 부록 B.7.1 최종 금액 */
  expected: number;
}

const PERSONNEL_SEED: PersonnelSeed[] = [
  { name: '박선욱', annualSalary: 74_000_000, rate: 28, months: 9, axis: 'cash', expected: 15_540_000 },
  { name: '김영', annualSalary: 90_000_000, rate: 30, months: 9, axis: 'in_kind', expected: 20_250_000 },
];

interface QuantitySeed {
  category: BudgetCategory;
  subcategory: string;
  name: string;
  unitPrice: number;
  factors: DetailFactor[];
  expected: number;
}

const QUANTITY_SEED: QuantitySeed[] = [
  {
    category: 'activity',
    subcategory: 'activity_meeting',
    name: '회의비',
    unitPrice: 100_000,
    factors: [{ label: '회', value: 5, isPercent: false }],
    expected: 500_000,
  },
  { category: 'indirect', subcategory: 'indirect_hr', name: '인력지원비', unitPrice: 4_000_000, factors: [], expected: 4_000_000 },
];

let sql: Sql;
let user: TestUser;
let projectId: string;
let yearId: string;
/** 성명 → Member. 인건비 시트의 행은 memberId 숨김 열로 찾는다(IN-3 — 이름 매칭 없음) */
const memberByName = new Map<string, Member>();
/** 시드로 만든 산출근거 id. `(seed 이름) → id` */
const detailIdByName = new Map<string, string>();

// ─── 헬퍼 ─────────────────────────────────────────────────────────────────────

// 실패를 조용히 넘기지 않는다 — 실패 코드까지 메시지에 담아 원인을 드러낸다
function unwrap<T>(result: ActionResult<T>): T {
  if (!result.ok) throw new Error(`액션 실패: ${result.error} (code=${result.code ?? '-'})`);
  return result.data;
}

function expectFailure<T>(result: ActionResult<T>): { error: string; code?: string } {
  if (result.ok) throw new Error('실패해야 하는 액션이 성공했다');
  return { error: result.error, code: result.code };
}

/** §9: 파일은 FormData로 전달된다. 액션이 파일을 읽어 소비하므로 호출마다 새로 만든다 */
function formOf(bytes: Buffer, fileName: string): FormData {
  const form = new FormData();
  form.set('file', new Blob([new Uint8Array(bytes) as BlobPart]), fileName);
  return form;
}

interface DownloadedForm {
  buffer: Buffer;
  fileName: string;
}

async function download(): Promise<DownloadedForm> {
  const data = unwrap(await buildInputForm(projectId, yearId));
  return { buffer: Buffer.from(data.contentBase64, 'base64'), fileName: data.fileName };
}

// ─── SheetJS 조작 — 받은 파일의 셀을 고쳐 다시 쓴다 (input-form-roundtrip.test.ts와 같은 방식) ──

/** 수식·서식을 지킨 채 셀만 고쳐 다시 쓴 바이트. 사용자가 엑셀에서 값을 적고 저장한 파일에 해당한다 */
function rewritten(buffer: Buffer, mutate: (wb: XLSX.WorkBook) => void): Buffer {
  const wb = XLSX.read(buffer, { type: 'buffer', cellFormula: true, cellNF: true });
  mutate(wb);
  const out: unknown = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
  if (!Buffer.isBuffer(out)) throw new Error('다시 쓴 워크북이 Buffer가 아니다');
  return out;
}

function sheetOf(wb: XLSX.WorkBook, name: string): XLSX.WorkSheet {
  const ws = wb.Sheets[name];
  if (!ws) throw new Error(`시트 '${name}'이 없다`);
  return ws;
}

function addr(def: typeof PERSONNEL_DEF, role: string, r0: number): string {
  return XLSX.utils.encode_cell({ r: r0, c: columnOf(def, role) });
}

function cellValue(ws: XLSX.WorkSheet, def: typeof PERSONNEL_DEF, role: string, r0: number): unknown {
  return (ws[addr(def, role, r0)] as XLSX.CellObject | undefined)?.v;
}

/** 데이터 행(0-based)을 숨김 키 열로 찾는다. 못 찾으면 던진다 — -1을 돌려주면 덮어쓰기가 헛돈다 */
function findRow(
  ws: XLSX.WorkSheet,
  def: typeof PERSONNEL_DEF,
  predicate: (r0: number) => boolean,
  what: string
): number {
  const range = XLSX.utils.decode_range(ws['!ref'] ?? 'A1:A1');
  for (let r = def.dataStartRow - 1; r <= range.e.r; r += 1) {
    if (predicate(r)) return r;
  }
  throw new Error(`${what} 행을 찾지 못했다`);
}

function personnelRowOf(ws: XLSX.WorkSheet, memberId: string): number {
  return findRow(ws, PERSONNEL_DEF, (r) => cellValue(ws, PERSONNEL_DEF, 'memberId', r) === memberId, `memberId=${memberId}`);
}

function budgetRowOfDetail(ws: XLSX.WorkSheet, detailId: string): number {
  return findRow(ws, BUDGET_DEF, (r) => cellValue(ws, BUDGET_DEF, 'detailId', r) === detailId, `detailId=${detailId}`);
}

/** 세목 슬롯의 첫 빈 줄 — 키 열만 차 있고 detailId가 없다(IN-4) */
function budgetEmptyRowOf(ws: XLSX.WorkSheet, key: string): number {
  return findRow(
    ws,
    BUDGET_DEF,
    (r) => cellValue(ws, BUDGET_DEF, 'subcategory', r) === key && ws[addr(BUDGET_DEF, 'detailId', r)] === undefined,
    `'${key}' 빈 줄`
  );
}

function metaRowOf(ws: XLSX.WorkSheet, key: string): number {
  return findRow(ws, META_DEF, (r) => cellValue(ws, META_DEF, 'key', r) === key, `_meta '${key}'`);
}

function setNumber(ws: XLSX.WorkSheet, def: typeof PERSONNEL_DEF, role: string, r0: number, value: number): void {
  ws[addr(def, role, r0)] = { t: 'n', v: value };
}

function setText(ws: XLSX.WorkSheet, def: typeof PERSONNEL_DEF, role: string, r0: number, value: string): void {
  ws[addr(def, role, r0)] = { t: 's', v: value };
}

/** 참여율 셀 하나만 바꾼 파일 */
function withParticipation(buffer: Buffer, memberId: string, rate: number): Buffer {
  return rewritten(buffer, (wb) => {
    const ws = sheetOf(wb, PERSONNEL_DEF.name);
    setNumber(ws, PERSONNEL_DEF, 'participation', personnelRowOf(ws, memberId), rate);
  });
}

function withMonths(buffer: Buffer, memberId: string, months: number): Buffer {
  return rewritten(buffer, (wb) => {
    const ws = sheetOf(wb, PERSONNEL_DEF.name);
    setNumber(ws, PERSONNEL_DEF, 'months', personnelRowOf(ws, memberId), months);
  });
}

// ─── DB 검증 SQL (postgres 직결 — 액션 반환이 아니라 저장된 원본을 본다) ─────────

interface DetailRow {
  id: string;
  category: BudgetCategory;
  subcategory: string;
  axis: DetailAxis;
  memberId: string | null;
  amount: number;
  factors: DetailFactor[];
}

/** bigint는 postgres.js가 문자열로 주므로 text로 캐스팅해 정수로 되돌린다 (부동소수점 경유 금지) */
async function readDetails(): Promise<DetailRow[]> {
  const rows = await sql`
    select id::text as id, category, subcategory, axis, member_id::text as member_id,
           amount::text as amount, factors
      from public.budget_details
     where year_id = ${yearId}::uuid
     order by category, subcategory, sort_order, id`;
  return rows.map((row) => {
    const r = row as {
      id: string;
      category: BudgetCategory;
      subcategory: string;
      axis: DetailAxis;
      member_id: string | null;
      amount: string;
      factors: DetailFactor[];
    };
    return {
      id: r.id,
      category: r.category,
      subcategory: r.subcategory,
      axis: r.axis,
      memberId: r.member_id,
      amount: Number(r.amount),
      factors: r.factors,
    };
  });
}

interface PlanRow {
  planned: number;
  cash: number | null;
  inKind: number | null;
}

async function readPlanRows(): Promise<Map<BudgetCategory, PlanRow>> {
  const rows = await sql`
    select category, planned_amount::text as planned, cash_amount::text as cash, in_kind_amount::text as in_kind
      from public.budget_items
     where year_id = ${yearId}::uuid`;
  const out = new Map<BudgetCategory, PlanRow>();
  for (const row of rows) {
    const r = row as { category: BudgetCategory; planned: string; cash: string | null; in_kind: string | null };
    out.set(r.category, {
      planned: Number(r.planned),
      cash: r.cash === null ? null : Number(r.cash),
      inKind: r.in_kind === null ? null : Number(r.in_kind),
    });
  }
  return out;
}

interface SnapshotRow {
  id: string;
  snapshot: {
    kind?: string;
    source?: { fileName?: string; sheetName?: string; fileHash?: string };
    items?: unknown[];
    details?: unknown[];
  };
}

async function readSnapshots(): Promise<SnapshotRow[]> {
  const rows = await sql`
    select id::text as id, snapshot
      from public.import_snapshots
     where project_id = ${projectId}::uuid
     order by created_at asc, id asc`;
  return rows.map((row) => row as SnapshotRow);
}

/**
 * PL-10 불변식: 산출근거가 있는 모든 셀에서 `budget_items` 세 금액 = 축별 `sum(amount)`.
 * 저장된 amount를 더한다 — RPC는 더하기만 하므로(PL-10a) 이것이 곧 RPC가 지킨 값이다
 */
async function expectPlanInvariant(): Promise<void> {
  const details = await readDetails();
  const plans = await readPlanRows();
  const categories = [...new Set(details.map((d) => d.category))];
  expect(categories.length).toBeGreaterThan(0);
  for (const category of categories) {
    const cell = details.filter((d) => d.category === category);
    const cash = cell.filter((d) => d.axis === 'cash').reduce((sum, d) => sum + d.amount, 0);
    const inKind = cell.filter((d) => d.axis === 'in_kind').reduce((sum, d) => sum + d.amount, 0);
    expect(plans.get(category), `budget_items ${category}`).toEqual({ planned: cash + inKind, cash, inKind });
  }
}

function countBy(details: readonly DetailRow[], category: BudgetCategory): number {
  return details.filter((d) => d.category === category).length;
}

/** 인건비 행의 PL-1 기대값 — 산식은 `computeDetailAmount` 한 곳뿐이다(PL-10a) */
function personnelAmount(member: Member, rate: number, months: number): number {
  return computeDetailAmount(
    {
      yearId,
      category: 'personnel',
      subcategory: 'personnel_internal',
      axis: 'cash',
      formula: 'personnel',
      memberId: member.id,
      unitPrice: 0,
      adjustment: 0,
      factors: [
        { label: '참여율(%)', value: rate, isPercent: true },
        { label: '참여기간(월)', value: months, isPercent: false },
      ],
    },
    member
  ).amount;
}

function memberOf(name: string): Member {
  const member = memberByName.get(name);
  if (!member) throw new Error(`시드에 '${name}'이 없다`);
  return member;
}

function detailIdOf(name: string): string {
  const id = detailIdByName.get(name);
  if (!id) throw new Error(`시드 산출근거 '${name}'이 없다`);
  return id;
}

// ─── 준비·정리 ────────────────────────────────────────────────────────────────

beforeAll(async () => {
  sql = connectDirectDb();
  user = await createTestUser(sql);
  session.accessToken = user.accessToken;

  const project = await projectsRepo.createProjectWithDefaults(user.client, {
    name: '입력양식 액션 통합',
    contractStartDate: YEAR_START,
  });
  projectId = project.id;

  const firstYear = (await yearsRepo.listYears(user.client, projectId))[0];
  if (!firstYear) throw new Error('createProjectWithDefaults가 연차를 만들지 않았습니다.');
  // 기본 1차년도는 12개월이다 — 9개월로 줄여야 (d)의 "개월 초과 경고"가 blocking 범위(0~12) 안에서 재현된다
  const year = await yearsRepo.updateYear(user.client, firstYear.id, { startDate: YEAR_START, endDate: YEAR_END });
  yearId = year.id;

  for (const [index, seed] of PERSONNEL_SEED.entries()) {
    const member = await membersRepo.createMember(
      user.client,
      {
        projectId,
        orgId: null,
        name: seed.name,
        role: 'researcher',
        position: '연구원',
        field: '',
        email: '',
        phone: '',
        active: true,
        order: index,
        annualSalary: seed.annualSalary,
        hireType: 'existing',
      },
      user.id
    );
    memberByName.set(seed.name, member);
  }

  // 실제 서버 액션으로 저장한다 — 순차 실행(같은 세목의 order가 기존 행 수로 정해진다)
  for (const seed of PERSONNEL_SEED) {
    const created = unwrap(
      await plan.createBudgetDetail(yearId, 'personnel', 'personnel_internal', {
        axis: seed.axis,
        memberId: memberOf(seed.name).id,
        factors: [
          { label: '참여율(%)', value: seed.rate, isPercent: true },
          { label: '참여기간(월)', value: seed.months, isPercent: false },
        ],
        adjustment: 0,
      })
    );
    if (created.amount !== seed.expected) {
      throw new Error(`시드 금액이 SOT와 다릅니다: ${seed.name} ${created.amount} ≠ ${seed.expected}`);
    }
    detailIdByName.set(seed.name, created.id);
  }
  for (const seed of QUANTITY_SEED) {
    const created = unwrap(
      await plan.createBudgetDetail(yearId, seed.category, seed.subcategory, {
        axis: 'cash',
        name: seed.name,
        unitPrice: seed.unitPrice,
        factors: seed.factors,
      })
    );
    if (created.amount !== seed.expected) {
      throw new Error(`시드 금액이 기대와 다릅니다: ${seed.name} ${created.amount} ≠ ${seed.expected}`);
    }
    detailIdByName.set(seed.name, created.id);
  }
});

afterAll(async () => {
  if (projectId) {
    await sql`delete from public.projects where id = ${projectId}::uuid`;

    // 잔여 데이터 0 확인 — 사용자 삭제 전에 본다(삭제하면 created_by가 null이 되어 추적이 끊긴다)
    const rows = await sql`
      select ((select count(*) from public.projects         where id         = ${projectId}::uuid)
            + (select count(*) from public.members          where project_id = ${projectId}::uuid)
            + (select count(*) from public.budget_items     where project_id = ${projectId}::uuid)
            + (select count(*) from public.budget_details   where project_id = ${projectId}::uuid)
            + (select count(*) from public.import_snapshots where project_id = ${projectId}::uuid))::text as n`;
    const remaining = Number((rows[0] as { n: string }).n);
    if (remaining !== 0) throw new Error(`테스트가 만든 데이터가 ${remaining}건 남았습니다.`);
  }
  await destroyTestUser(sql, user);
  await sql.end();
});

// ═══ (a) 내려받기 → 미리보기(변경 0) → 참여율 수정 반영 ═════════════════════════

describe('(a) 내려받기 → 미리보기 → 참여율 28→40 반영 (IN-5·IN-6, PL-10, D-17)', () => {
  const SEED_ROWS = PERSONNEL_SEED.length + QUANTITY_SEED.length;
  const NEW_RATE = 40;
  let original: DownloadedForm;
  let originalHash: string;
  let modified: Buffer;

  it('받은 파일을 그대로 올리면 변경 0 · 차단 없음 · 유지 비목 없음', async () => {
    original = await download();
    const preview = unwrap(await previewInputForm(projectId, formOf(original.buffer, original.fileName)));
    originalHash = preview.fileHash;
    expect(preview.yearId).toBe(yearId);
    expect(preview.blocked).toBe(false);
    expect(preview.summary).toEqual({ added: 0, changed: 0, deleted: 0, unchanged: SEED_ROWS, errors: 0, unknown: 0 });
    expect(preview.untouchedCategories).toEqual([]);
    expect(preview.totals.total.plannedAmount).toBe(
      PERSONNEL_SEED.reduce((s, r) => s + r.expected, 0) + QUANTITY_SEED.reduce((s, r) => s + r.expected, 0)
    );
  });

  it('참여율을 바꾼 파일은 변경 1 · 나머지 unchanged · 차단 없음', async () => {
    modified = withParticipation(original.buffer, memberOf('박선욱').id, NEW_RATE);
    const preview = unwrap(await previewInputForm(projectId, formOf(modified, original.fileName)));
    expect(preview.blocked).toBe(false);
    expect(preview.summary).toEqual({ added: 0, changed: 1, deleted: 0, unchanged: SEED_ROWS - 1, errors: 0, unknown: 0 });
    // 같은 바이트가 아니므로 해시가 달라야 한다 — (c)의 불일치 거부가 여기에 기댄다
    expect(preview.fileHash).not.toBe(originalHash);
    const changed = preview.rows.find((row) => row.status === 'change');
    expect(changed?.label).toBe('박선욱');
    expect(changed?.changedFields).toEqual(expect.arrayContaining(['factors', 'amount']));
  });

  it('commitInputForm → budget_details 금액 = PL-1 재계산값 · 비목 행 수 일치', async () => {
    const preview = unwrap(await previewInputForm(projectId, formOf(modified, original.fileName)));
    const committed = unwrap(await commitInputForm(projectId, formOf(modified, original.fileName), preview.fileHash, preview.replaceCategories));

    // 양식에 행이 있는 비목 3개 전부 교체 — 기존 4행 삭제, 4행 삽입 (IN-5)
    expect(committed).toMatchObject({ inserted: SEED_ROWS, deleted: SEED_ROWS, cells: 3, skippedLocked: 0 });
    expect(committed.summary).toEqual(preview.summary);

    const details = await readDetails();
    expect(details).toHaveLength(SEED_ROWS);
    expect(countBy(details, 'personnel')).toBe(PERSONNEL_SEED.length);
    expect(countBy(details, 'activity')).toBe(1);
    expect(countBy(details, 'indirect')).toBe(1);

    const member = memberOf('박선욱');
    const row = details.find((d) => d.memberId === member.id);
    expect(row).toBeDefined();
    // 74,000,000 × 40% × 9/12 = 22,200,000 — 산식은 computeDetailAmount 한 곳(PL-10a), 숫자는 손으로 검산한 값
    expect(row?.amount).toBe(personnelAmount(member, NEW_RATE, 9));
    expect(row?.amount).toBe(22_200_000);
    expect(row?.factors).toEqual([
      { label: '참여율(%)', value: NEW_RATE, isPercent: true },
      { label: '참여기간(월)', value: 9, isPercent: false },
    ]);
    expect(row?.axis).toBe('cash');

    // 나머지 행은 값이 그대로다 (교체돼도 같은 근거 → 같은 금액)
    const other = details.find((d) => d.memberId === memberOf('김영').id);
    expect(other?.amount).toBe(20_250_000);
    expect(details.find((d) => d.category === 'activity')?.amount).toBe(500_000);
    expect(details.find((d) => d.category === 'indirect')?.amount).toBe(4_000_000);
  });

  it('budget_items 축별 합계 = 산출근거 합 (PL-10) · 미리보기 totals와 같다', async () => {
    await expectPlanInvariant();

    const preview = unwrap(await previewInputForm(projectId, formOf(modified, original.fileName)));
    const plans = await readPlanRows();
    for (const cell of preview.totals.cells) {
      const stored = plans.get(cell.category);
      if (!stored) throw new Error(`budget_items에 ${cell.category} 행이 없다`);
      expect(stored.planned, cell.category).toBe(cell.plannedAmount);
    }
    expect(plans.get('personnel')).toEqual({ planned: 22_200_000 + 20_250_000, cash: 22_200_000, inKind: 20_250_000 });
  });

  it('import_snapshots 새 행에 details 키가 있고(D-17) source.fileHash가 미리보기 해시와 같다', async () => {
    const snapshots = await readSnapshots();
    expect(snapshots).toHaveLength(1);
    const { snapshot } = snapshots[0]!;
    expect(snapshot.kind).toBe('budget_detail');
    expect(Object.hasOwn(snapshot, 'details')).toBe(true);
    // 교체 비목 3개의 기존 행 전부(4행)가 DB 원본 표기로 담긴다
    expect(snapshot.details).toHaveLength(SEED_ROWS);
    const preview = unwrap(await previewInputForm(projectId, formOf(modified, original.fileName)));
    expect(snapshot.source?.fileHash).toBe(preview.fileHash);
    expect(snapshot.source?.fileName).toBe(original.fileName);
  });

  // ═══ (b) 재내려받기 왕복 ═══
  it('(b) 다시 내려받으면 참여율 40이 채워져 있다 (§11 왕복)', async () => {
    const again = await download();
    const sheets = readWorkbook(new Uint8Array(again.buffer));
    const sheet = sheets.find((s) => s.name === PERSONNEL_DEF.name);
    if (!sheet) throw new Error('인건비 시트가 없다');
    const memberCol = columnOf(PERSONNEL_DEF, 'memberId');
    const row = sheet.cells.find((cells, r) => r >= PERSONNEL_DEF.dataStartRow - 1 && cells[memberCol]?.value === memberOf('박선욱').id);
    if (!row) throw new Error('박선욱 행이 없다');
    expect(row[columnOf(PERSONNEL_DEF, 'participation')]?.value).toBe(NEW_RATE);
    expect(row[columnOf(PERSONNEL_DEF, 'months')]?.value).toBe(9);
    expect(row[columnOf(PERSONNEL_DEF, 'axis')]?.value).toBe(DETAIL_AXIS_LABELS.cash);
    // 숨김 detailId가 방금 반영된 행의 id다 — 다음 올리기가 이 행을 "변경/유지"로 잇는다(IN-5)
    const details = await readDetails();
    expect(row[columnOf(PERSONNEL_DEF, 'detailId')]?.value).toBe(details.find((d) => d.memberId === memberOf('박선욱').id)?.id);
  });
});

// ═══ (c) 거부 3종 ══════════════════════════════════════════════════════════════

describe('(c) 거부 — fileHash 불일치 · 다른 과제의 양식 · formVersion 불일치 (IN-2·IN-6)', () => {
  let base: DownloadedForm;
  let before: DetailRow[];
  let snapshotsBefore: number;

  beforeAll(async () => {
    base = await download();
    before = await readDetails();
    snapshotsBefore = (await readSnapshots()).length;
  });

  async function expectDbUntouched(): Promise<void> {
    expect(await readDetails()).toEqual(before);
    expect((await readSnapshots()).length).toBe(snapshotsBefore);
  }

  it('미리보기 해시와 다른 파일로 반영하면 거부한다', async () => {
    const preview = unwrap(await previewInputForm(projectId, formOf(base.buffer, base.fileName)));
    const other = withParticipation(base.buffer, memberOf('김영').id, 35);
    const failure = expectFailure(await commitInputForm(projectId, formOf(other, base.fileName), preview.fileHash, preview.replaceCategories));
    expect(failure.error).toContain('미리보기 때와 다릅니다');
    await expectDbUntouched();
  });

  it('`_meta.projectId`가 다른 양식은 미리보기·반영 모두 거부한다', async () => {
    const foreign = rewritten(base.buffer, (wb) => {
      const ws = sheetOf(wb, META_DEF.name);
      setText(ws, META_DEF, 'value', metaRowOf(ws, META_KEYS.projectId), '00000000-0000-4000-8000-00000000dead');
    });
    const preview = expectFailure(await previewInputForm(projectId, formOf(foreign, base.fileName)));
    expect(preview.error).toContain('이 과제의 양식이 아닙니다');
    expect(preview.code).toBe('RULE');
    const commit = expectFailure(await commitInputForm(projectId, formOf(foreign, base.fileName), 'f'.repeat(64), []));
    expect(commit.error).toContain('이 과제의 양식이 아닙니다');
    await expectDbUntouched();
  });

  it('`_meta.formVersion`이 다르면 다시 내려받으라고 거부한다', async () => {
    const stale = rewritten(base.buffer, (wb) => {
      const ws = sheetOf(wb, META_DEF.name);
      setNumber(ws, META_DEF, 'value', metaRowOf(ws, META_KEYS.formVersion), INPUT_FORM_VERSION + 1);
    });
    const preview = expectFailure(await previewInputForm(projectId, formOf(stale, base.fileName)));
    expect(preview.error).toContain('다시 내려받으세요');
    const commit = expectFailure(await commitInputForm(projectId, formOf(stale, base.fileName), 'f'.repeat(64), []));
    expect(commit.error).toContain('다시 내려받으세요');
    await expectDbUntouched();
  });
});

// ═══ (d) 경고만 있는 파일 ══════════════════════════════════════════════════════

describe('(d) 경고(연차 개월 초과)만 있는 파일은 반영된다 (PL-15·RL-1)', () => {
  const OVER_MONTHS = YEAR_MONTHS + 1;

  it('previewInputForm: blocked false · warnings에 months-over-year → commitInputForm 성공', async () => {
    const base = await download();
    const member = memberOf('김영');
    const file = withMonths(base.buffer, member.id, OVER_MONTHS);

    const preview = unwrap(await previewInputForm(projectId, formOf(file, base.fileName)));
    expect(preview.blocked).toBe(false);
    expect(preview.warnings.map((w) => w.kind)).toContain('months-over-year');
    expect(preview.summary.changed).toBe(1);
    const row = preview.rows.find((r) => r.status === 'change');
    expect(row?.issues.map((i) => i.kind)).toContain('months-over-year');
    expect(row?.issues.every((i) => !i.blocking)).toBe(true);

    const committed = unwrap(await commitInputForm(projectId, formOf(file, base.fileName), preview.fileHash, preview.replaceCategories));
    expect(committed.skippedLocked).toBe(0);

    const stored = (await readDetails()).find((d) => d.memberId === member.id);
    // 90,000,000 × 30% × 10/12 = 22,500,000
    expect(stored?.amount).toBe(personnelAmount(member, 30, OVER_MONTHS));
    expect(stored?.amount).toBe(22_500_000);
    await expectPlanInvariant();
  });
});

// ═══ (e) D-15a — 미리보기 뒤 다른 경로로 들어온 행 ═══════════════════════════════

describe('(e) 미리보기 뒤 다른 경로로 추가된 비목은 건너뛰고 skippedLocked로 드러낸다 (D-15a)', () => {
  const KEY = 'material:material_purchase';

  it('createBudgetDetail이 끼어든 재료비 셀은 건너뛰고 그 행이 남는다', async () => {
    const base = await download();
    // 재료비는 기존 행이 0이라 "추가만"(교체 지정 없음)이다 — 이 조건이어야 D-15a 보호가 걸린다(IN-5)
    const file = rewritten(base.buffer, (wb) => {
      const ws = sheetOf(wb, BUDGET_DEF.name);
      const r = budgetEmptyRowOf(ws, KEY);
      setText(ws, BUDGET_DEF, 'name', r, '시약');
      setNumber(ws, BUDGET_DEF, 'unitPrice', r, 50_000);
      setNumber(ws, BUDGET_DEF, 'factor1', r, 2);
      setText(ws, BUDGET_DEF, 'axis', r, DETAIL_AXIS_LABELS.cash);
    });

    const preview = unwrap(await previewInputForm(projectId, formOf(file, base.fileName)));
    expect(preview.blocked).toBe(false);
    expect(preview.summary.added).toBe(1);
    const added = preview.rows.find((r) => r.status === 'add');
    expect(added).toMatchObject({ category: 'material', subcategory: 'material_purchase', amount: 100_000 });

    const interposed = unwrap(
      await plan.createBudgetDetail(yearId, 'material', 'material_purchase', {
        axis: 'cash',
        name: '미리보기 뒤 추가된 행',
        unitPrice: 1_000,
        factors: [{ label: '수량', value: 1, isPercent: false }],
      })
    );

    const committed = unwrap(await commitInputForm(projectId, formOf(file, base.fileName), preview.fileHash, preview.replaceCategories));
    expect(committed.skippedLocked).toBe(1);
    // 나머지 비목은 예정대로 교체됐다 — 한 셀 때문에 전체를 버리지 않는다
    expect(committed.inserted).toBe(PERSONNEL_SEED.length + QUANTITY_SEED.length);

    const details = await readDetails();
    const material = details.filter((d) => d.category === 'material');
    expect(material).toHaveLength(1);
    expect(material[0]?.id).toBe(interposed.id);
    expect(material[0]?.amount).toBe(1_000);
    expect(details.some((d) => d.category === 'material' && d.amount === 100_000)).toBe(false);
    await expectPlanInvariant();
  });
});

// ═══ (f) blocking → 거부 · DB 불변 ═════════════════════════════════════════════

describe('(f) blocking(참여율 120)이면 commitInputForm이 거부하고 DB가 변하지 않는다', () => {
  it('previewInputForm.blocked true → commit ok:false code RULE · 산출근거·스냅샷 그대로', async () => {
    const base = await download();
    const before = await readDetails();
    const plansBefore = await readPlanRows();
    const snapshotsBefore = (await readSnapshots()).length;

    const file = withParticipation(base.buffer, memberOf('박선욱').id, 120);
    const preview = unwrap(await previewInputForm(projectId, formOf(file, base.fileName)));
    expect(preview.blocked).toBe(true);
    expect(preview.summary.errors).toBe(1);

    const failure = expectFailure(await commitInputForm(projectId, formOf(file, base.fileName), preview.fileHash, preview.replaceCategories));
    expect(failure.code).toBe('RULE');
    expect(failure.error).toContain('반영할 수 없습니다');
    expect(failure.error).toContain('참여율');

    expect(await readDetails()).toEqual(before);
    expect(await readPlanRows()).toEqual(plansBefore);
    expect((await readSnapshots()).length).toBe(snapshotsBefore);
  });
});

// ═══ (g) 양식에 없는 비목 유지 ═════════════════════════════════════════════════

describe('(g) 양식에서 지운 비목(간접비)의 기존 행은 유지된다 (IN-5 untouched)', () => {
  it('간접비 행을 비우면 untouched 1행 · 반영 후 같은 id·금액이 남는다', async () => {
    const base = await download();
    const before = await readDetails();
    const indirectId = before.find((d) => d.category === 'indirect')?.id;
    if (!indirectId) throw new Error('간접비 산출근거가 없다');
    const indirectBefore = (await readPlanRows()).get('indirect');
    // (e)가 남긴 재료비 행도 양식에 실려 오므로 교체 셀은 "간접비를 뺀 나머지 비목 전부"다
    const replacedCells = new Set(before.filter((d) => d.category !== 'indirect').map((d) => d.category)).size;

    const file = rewritten(base.buffer, (wb) => {
      const ws = sheetOf(wb, BUDGET_DEF.name);
      const r = budgetRowOfDetail(ws, indirectId);
      // 행 전체를 비운다 — 키 열까지 지워 사용자가 행을 삭제한 것과 같다
      BUDGET_DEF.columns.forEach((column) => {
        delete ws[addr(BUDGET_DEF, column.role, r)];
      });
    });

    const preview = unwrap(await previewInputForm(projectId, formOf(file, base.fileName)));
    expect(preview.blocked).toBe(false);
    expect(preview.untouchedCategories).toEqual([{ category: 'indirect', rowCount: 1 }]);
    expect(preview.warnings.map((w) => w.kind)).toContain('untouched');
    // 유지 비목의 행은 삭제 목록에 없다 — 교체 비목 안에서만 삭제가 생긴다
    expect(preview.summary.deleted).toBe(0);
    // 반영 뒤 모습(totals)에도 간접비가 그대로 들어 있다
    expect(preview.totals.cells.find((c) => c.category === 'indirect')?.plannedAmount).toBe(4_000_000);

    const committed = unwrap(await commitInputForm(projectId, formOf(file, base.fileName), preview.fileHash, preview.replaceCategories));
    // 간접비는 셀 목록에 들어가지 않는다
    expect(committed.cells).toBe(replacedCells);

    const details = await readDetails();
    const indirect = details.filter((d) => d.category === 'indirect');
    expect(indirect).toHaveLength(1);
    expect(indirect[0]?.id).toBe(indirectId);
    expect(indirect[0]?.amount).toBe(4_000_000);
    expect((await readPlanRows()).get('indirect')).toEqual(indirectBefore);
    await expectPlanInvariant();
  });
});
