// 협약 예산 편성 항목·증빙 엑셀 내려받기 + RL-23 꺼짐 문구 **액션 계층** 통합 테스트
// (SOT §6.19 AG-6·AG-8, §7.9.8, §6.14.8 RL-23, Phase 26 계획서 S-7·S-10)
//
// 표 모델 자체는 단위 테스트(agreement-items)가 고정했다. 여기서 보는 것은
//   (a) 액션이 DB의 버전·편성 항목·금액 줄로 시트를 만들고, 생성 xlsx를 exceljs로 다시 열면
//       시트 목록(작성안내 첫 시트)·연차 소계 수식 + 결과값(0 포함)이 남아 있는가
//   (b) 칸 값이 **같은 데이터로 만든 표 모델의 TSV**([복사])와 칸마다 같은가(원 단위, 탭·따옴표 든 메모 포함)
//   (c) 파일명 라벨·과제 경계·입력 검증·SA-4
//   (d) 변경 이력 엑셀: RL-23 규칙 행이 없거나 켜져 있으면 Phase 24와 같은 표, 꺼져 있으면 "규칙이 꺼져 있어 판정하지 않음"
// 숫자 기준값은 아래 픽스처에서 손으로 계산한 값이다(구현이 낸 값이 아니다).
// 자기가 만든 과제·사용자만 지운다 — 파괴적 테스트가 아니다.

import ExcelJS from 'exceljs';
import * as XLSX from 'xlsx';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Sql } from 'postgres';
import { connectDirectDb, createTestUser, destroyTestUser, type TestUser } from './helpers';
import type { ActionResult } from '@/types';
import * as agreements from '@/lib/db/agreements';
import * as budgetRulesRepo from '@/lib/db/budget-rules';
import * as membersRepo from '@/lib/db/members';
import * as projects from '@/lib/db/projects';
import * as stages from '@/lib/db/stages';
import * as yearsRepo from '@/lib/db/years';
import { todayISO } from '@/lib/dates';
import { buildItemsView, itemsTable } from '@/lib/agreement/items-view';
import { checkSubcategoryPreservation } from '@/lib/agreement/preservation';
import { buildPreservationTable } from '@/lib/agreement/changes-table';
import { toTsv, type TableModel } from '@/lib/agreement/table';

const session = vi.hoisted(() => ({ accessToken: '' }));

vi.mock('next/headers', () => ({
  cookies: async () => ({ get: () => ({ value: session.accessToken }) }),
}));
vi.mock('next/cache', () => ({ revalidatePath: () => undefined }));

// 리포지토리가 매핑 못 한 PostgREST 오류(일반 Error, 원문에 테이블 이름)를 흉내 낸다 — 켜져 있을 때만 던진다
const repoFault = vi.hoisted(() => ({ message: null as string | null }));
vi.mock('@/lib/db/agreements', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/db/agreements')>();
  return {
    ...actual,
    listItemsByVersionIds: async (...args: Parameters<typeof actual.listItemsByVersionIds>) => {
      if (repoFault.message !== null) throw new Error(repoFault.message);
      return actual.listItemsByVersionIds(...args);
    },
  };
});

const { buildAgreementWorkbook } = await import('@/actions/agreement-export');

let sql: Sql;
let user: TestUser;
const tempProjectIds: string[] = []; // afterAll 안전망

const PROJECT_NAME = '협약 편성 항목 내보내기 통합';
const RULE_OFF_TEXT = '규칙이 꺼져 있어 판정하지 않음';

interface Fixture {
  projectId: string;
  y1: string;
  y2: string;
}

let f: Fixture;
let versionA: string; // final '최종협약본', 확정, 편성 항목 4건
let versionB: string; // amendment '협약변경 1차', 작성 중, 편성 항목 0건
let otherVersion: string; // 다른 과제의 버전

// ─── 픽스처 ───────────────────────────────────────────────────────────────────

async function newFixture(name: string): Promise<Fixture> {
  const project = await projects.createProject(user.client, { name, createdBy: user.id, updatedBy: user.id });
  tempProjectIds.push(project.id);
  const stage = await stages.createStage(user.client, { projectId: project.id, name: '1단계' });
  const year1 = await yearsRepo.createYear(user.client, { stageId: stage.id, name: '1차년도' });
  const year2 = await yearsRepo.createYear(user.client, { stageId: stage.id, name: '2차년도' });
  return { projectId: project.id, y1: year1.id, y2: year2.id };
}

type Seed = agreements.AgreementLineSeed;
const L = (yearId: string, category: Seed['category'], subcategoryCode: string, axis: Seed['axis'], amount: number): Seed => ({
  yearId,
  category,
  subcategoryCode,
  axis,
  amount,
});

function linesA(x: Fixture): Seed[] {
  return [
    L(x.y1, 'facility_equipment', 'facility_purchase', 'cash', 30_000_000),
    L(x.y1, 'material', 'material_purchase', 'cash', 2_000_000),
    L(x.y1, 'activity', 'activity_outsourcing', 'cash', 5_000_000),
    L(x.y2, 'material', 'material_purchase', 'cash', 1_000_000),
  ];
}

/**
 * Y1: 장비 33,000,000 + 재료 1,500,000 + 외주 5,000,000 = 39,500,000 / Y2: 재료 0 → 소계 0(수식 결과값 0)
 * 합계 39,500,000. 메모에 탭·따옴표 — TSV는 "…"로 감싸고 엑셀 칸에는 원문이 들어가야 한다
 */
function itemsA(x: Fixture): agreements.AgreementItemSeed[] {
  return [
    {
      yearId: x.y1,
      kind: 'equipment',
      name: '분광기',
      quantity: 1,
      amount: 33_000_000,
      evidence: [
        { label: '견적서', obtained: true, memo: '3사 비교' },
        { label: '비교견적서', obtained: false, memo: '' },
      ],
    },
    {
      yearId: x.y1,
      kind: 'material',
      name: '시약 "A"',
      quantity: 2.5,
      amount: 1_500_000,
      evidence: [
        { label: '견적서', obtained: true, memo: '' },
        { label: '거래명세서', obtained: true, memo: '1차분\t2차분' },
      ],
    },
    { yearId: x.y1, kind: 'outsourcing', name: '시험분석 용역', quantity: null, amount: 5_000_000, evidence: [] },
    {
      yearId: x.y2,
      kind: 'material',
      name: '무상 샘플',
      quantity: 10,
      amount: 0,
      evidence: [{ label: '거래명세서', obtained: false, memo: '' }],
    },
  ];
}

async function confirm(versionId: string): Promise<void> {
  const v = await agreements.getVersionById(user.client, versionId);
  await agreements.confirmVersion(user.client, versionId, v.version, user.id);
}

// ─── 헬퍼 (Phase 24·25 export 테스트와 같은 판독 규약) ──────────────────────

function unwrap<T>(result: ActionResult<T>): T {
  if (!result.ok) throw new Error(`액션 실패: ${result.error} (code=${result.code ?? '-'})`);
  return result.data;
}

function expectFailure<T>(result: ActionResult<T>): { error: string; code?: string } {
  if (result.ok) throw new Error('실패해야 하는 액션이 성공했다');
  return { error: result.error, code: result.code };
}

interface Loaded {
  wb: ExcelJS.Workbook;
  raw: XLSX.WorkBook;
}

async function load(contentBase64: string): Promise<Loaded> {
  const bytes = Buffer.from(contentBase64, 'base64');
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(bytes as unknown as ArrayBuffer);
  return { wb, raw: XLSX.read(bytes, { type: 'buffer' }) };
}

/** exceljs 리더는 결과값 0을 버린다 — 그때는 SheetJS로 같은 칸의 `<v>`를 확인한다(파일에 없으면 undefined) */
function formulaResult(loaded: Loaded, ws: ExcelJS.Worksheet, address: string): number | string | undefined {
  const v = ws.getCell(address).value as ExcelJS.CellFormulaValue;
  if (v.result !== undefined && v.result !== null) return v.result as number | string;
  const raw = loaded.raw.Sheets[ws.name]?.[address] as XLSX.CellObject | undefined;
  return raw?.f === v.formula && typeof raw.v === 'number' ? raw.v : undefined;
}

function excelText(loaded: Loaded, ws: ExcelJS.Worksheet, address: string): string {
  const v = ws.getCell(address).value;
  if (v === null || v === undefined) return '';
  if (typeof v === 'number' || typeof v === 'string') return String(v);
  if (typeof v === 'object' && 'formula' in v) {
    const result = formulaResult(loaded, ws, address);
    return result === undefined ? '<결과값 없음>' : String(result);
  }
  return `<예상 밖 값 ${JSON.stringify(v)}>`;
}

function formulaCell(loaded: Loaded, ws: ExcelJS.Worksheet, address: string) {
  const v = ws.getCell(address).value;
  if (v === null || typeof v !== 'object' || !('formula' in v)) return { notFormula: v };
  return { formula: (v as ExcelJS.CellFormulaValue).formula, result: formulaResult(loaded, ws, address) };
}

/** 엑셀 붙여넣기 규약의 TSV 파서 — `"…"` 안의 탭·개행, `""` → `"` */
function parseTsv(tsv: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let i = 0;
  let quoted = false;
  while (i < tsv.length) {
    const ch = tsv[i]!;
    if (quoted) {
      if (ch === '"' && tsv[i + 1] === '"') {
        field += '"';
        i += 2;
        continue;
      }
      if (ch === '"') {
        quoted = false;
        i += 1;
        continue;
      }
      field += ch;
      i += 1;
      continue;
    }
    if (ch === '"' && field === '') {
      quoted = true;
      i += 1;
    } else if (ch === '\t') {
      row.push(field);
      field = '';
      i += 1;
    } else if (ch === '\r' && tsv[i + 1] === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
      i += 2;
    } else {
      field += ch;
      i += 1;
    }
  }
  row.push(field);
  rows.push(row);
  return rows;
}

function sheetGrid(loaded: Loaded, sheetName: string, width: number): string[][] {
  const ws = loaded.wb.getWorksheet(sheetName)!;
  const grid: string[][] = [];
  for (let r = 1; r <= ws.actualRowCount; r += 1) {
    const row: string[] = [];
    for (let c = 1; c <= width; c += 1) row.push(excelText(loaded, ws, ws.getCell(r, c).address));
    grid.push(row);
  }
  return grid;
}

/** 시트 격자 = 같은 데이터로 만든 표 모델의 TSV(칸마다), 표 아래로 새는 행 없음 */
function expectSheetEqualsTsv(loaded: Loaded, sheetName: string, model: TableModel): void {
  expect(loaded.wb.getWorksheet(sheetName)).toBeDefined();
  expect(sheetGrid(loaded, sheetName, model.columns.length)).toEqual(parseTsv(toTsv(model)));
}

function expectAllSumsAreFormulas(loaded: Loaded, sheetName: string, model: TableModel): number {
  const ws = loaded.wb.getWorksheet(sheetName)!;
  let count = 0;
  model.rows.forEach((row, r) => {
    row.cells.forEach((cell, c) => {
      if (cell.kind !== 'sum') return;
      const address = ws.getCell(r + 2, c + 1).address;
      const got = formulaCell(loaded, ws, address);
      expect(got, `${sheetName}!${address}`).toMatchObject({ result: cell.value });
      expect(typeof (got as { formula?: unknown }).formula, `${sheetName}!${address}`).toBe('string');
      count += 1;
    });
  });
  return count;
}

function guideText(wb: ExcelJS.Workbook): string {
  return wb.getWorksheet('작성안내')!.getSheetValues().flat().map(String).join('\n');
}

function yyyymmdd(): string {
  return todayISO(new Date()).replace(/-/g, '');
}

/** 액션과 독립적으로 리포지토리 데이터 → 순수 함수 */
async function expectedItems(versionId: string, versionName: string): Promise<TableModel> {
  const [years, items, lines] = await Promise.all([
    yearsRepo.listYears(user.client, f.projectId),
    agreements.listItemsByVersionIds(user.client, [versionId]),
    agreements.listLinesByVersionIds(user.client, [versionId]),
  ]);
  return itemsTable(buildItemsView({ items, lines, years, findings: [] }), `편성 항목·증빙 — ${versionName}`);
}

async function expectedPreservationOn(): Promise<TableModel> {
  const [versions, lines] = await Promise.all([
    agreements.listVersionsByProject(user.client, f.projectId),
    agreements.listLinesByVersionIds(user.client, [versionA, versionB]),
  ]);
  const a = versions.find((v) => v.id === versionA)!;
  const b = versions.find((v) => v.id === versionB)!;
  return buildPreservationTable(
    checkSubcategoryPreservation(
      lines.filter((l) => l.versionId === versionB),
      { versionId: versionA, lines: lines.filter((l) => l.versionId === versionA) }
    ),
    { target: b, base: a }
  );
}

// ─── 준비·정리 ────────────────────────────────────────────────────────────────

beforeAll(async () => {
  sql = connectDirectDb();
  user = await createTestUser(sql);
  session.accessToken = user.accessToken;

  f = await newFixture(PROJECT_NAME);
  versionA = (
    await agreements.createVersion(user.client, f.projectId, {
      kind: 'final',
      name: '최종협약본',
      lines: linesA(f),
      participants: [],
      items: itemsA(f),
    })
  ).versionId;
  await confirm(versionA);
  // B: 재료 1차년도 → 2차년도 500,000 이동 + 외주 −1,000,000 → RL-23 차이 경고가 있는 상태
  versionB = (
    await agreements.createVersion(user.client, f.projectId, {
      kind: 'amendment',
      name: '협약변경 1차',
      lines: [
        L(f.y1, 'facility_equipment', 'facility_purchase', 'cash', 30_000_000),
        L(f.y1, 'material', 'material_purchase', 'cash', 1_500_000),
        L(f.y1, 'activity', 'activity_outsourcing', 'cash', 4_000_000),
        L(f.y2, 'material', 'material_purchase', 'cash', 1_500_000),
      ],
      participants: [],
    })
  ).versionId;

  const other = await newFixture('협약 편성 항목 내보내기 — 다른 과제');
  otherVersion = (
    await agreements.createVersion(user.client, other.projectId, {
      kind: 'final',
      name: '남의 버전',
      lines: [L(other.y1, 'material', 'material_purchase', 'cash', 1_000)],
      participants: [],
    })
  ).versionId;
}, 60_000);

afterAll(async () => {
  if (tempProjectIds.length > 0) {
    // 버전을 먼저 지운다 — delete_project(H-7)와 같은 순서. 연차의 no action FK를 피한다
    await sql`delete from public.agreement_versions where project_id = any(${tempProjectIds}::uuid[])`;
    await sql`delete from public.projects where id = any(${tempProjectIds}::uuid[])`;
  }
  await destroyTestUser(sql, user);
  await sql.end();
});

// ─── 편성 항목·증빙 ───────────────────────────────────────────────────────────

describe('편성 항목·증빙 내려받기', () => {
  it('작성안내 + "편성 항목·증빙", 칸 값 = TSV, 연차 소계·합계 = 수식 + 결과값(0 포함), 원 단위', async () => {
    const data = unwrap(await buildAgreementWorkbook(f.projectId, { view: 'items', versionId: versionA }));
    expect(data.fileName).toBe(`${PROJECT_NAME}_협약예산_최종협약본 편성 항목_${yyyymmdd()}.xlsx`);
    const loaded = await load(data.contentBase64);
    const wb = loaded.wb;
    expect(wb.worksheets.map((w) => w.name)).toEqual(['작성안내', '편성 항목·증빙']);

    const expected = await expectedItems(versionA, '최종협약본');
    expectSheetEqualsTsv(loaded, '편성 항목·증빙', expected);
    // 소계 2(Y1·Y2) + 합계 1
    expect(expectAllSumsAreFormulas(loaded, '편성 항목·증빙', expected)).toBe(3);

    const ws = wb.getWorksheet('편성 항목·증빙')!;
    expect(ws.getRow(1).values).toEqual([
      undefined,
      '연차',
      '종류',
      '품명',
      '수량',
      '금액',
      '증빙 받음 n/m',
      '증빙 내역',
    ]);
    // 헤더 + Y1 3건 + 소계 + Y2 1건 + 소계 + 합계 = 8행. 종류 순서 장비 → 재료 → 외주(§7.9.8)
    expect(ws.actualRowCount).toBe(8);
    expect(ws.getCell('C2').value).toBe('분광기');
    expect(ws.getCell('E2').value).toBe(33_000_000);
    expect(ws.getCell('F2').value).toBe('받음 1/2');
    expect(ws.getCell('G2').value).toBe('견적서: 받음 · 3사 비교; 비교견적서: 안 받음');
    expect(ws.getCell('C3').value).toBe('시약 "A"');
    expect(ws.getCell('D3').value).toBe('2.5');
    expect(ws.getCell('G3').value).toBe('견적서: 받음; 거래명세서: 받음 · 1차분\t2차분');
    expect(excelText(loaded, ws, 'D4')).toBe(''); // 수량 미입력은 0이 아니라 빈 칸
    expect(ws.getCell('F4').value).toBe('받음 0/0');
    expect(ws.getCell('A5').value).toBe('소계');
    expect(formulaCell(loaded, ws, 'E5')).toEqual({ formula: 'SUM(E2:E4)', result: 39_500_000 });
    // Y2 소계 결과값 0 — exceljs 리더가 버리는 값을 SheetJS로 확인한다
    expect(ws.getCell('E6').value).toBe(0);
    const y2Subtotal = formulaCell(loaded, ws, 'E7');
    expect(y2Subtotal).toEqual({ formula: 'SUM(E6)', result: 0 });
    expect(loaded.raw.Sheets['편성 항목·증빙']!['E7']).toMatchObject({ f: 'SUM(E6)', v: 0 });
    expect(ws.getCell('A8').value).toBe('합계');
    expect(formulaCell(loaded, ws, 'E8')).toEqual({ formula: 'SUM(E5,E7)', result: 39_500_000 });

    const guide = wb.getWorksheet('작성안내')!;
    expect(guide.getCell('A1').value).toBe(`${PROJECT_NAME} — 협약 예산 편성 항목·증빙`);
    const text = guideText(wb);
    expect(text).toContain('원 단위 정수');
    expect(text).toContain('부가세 별도');
    expect(text).toContain('파일은 첨부하지 않습니다');
    expect(text).toContain('수행 모드에서만');
    expect(text).toContain("최종협약본 '최종협약본'");
    expect(text).not.toContain('작성 중 버전입니다');
  });

  it('편성 항목 0건인 작성 중 버전: 합계 행 0만, 0원 행을 지어내지 않는다', async () => {
    const data = unwrap(await buildAgreementWorkbook(f.projectId, { view: 'items', versionId: versionB }));
    expect(data.fileName).toBe(`${PROJECT_NAME}_협약예산_협약변경 1차 편성 항목_${yyyymmdd()}.xlsx`);
    const loaded = await load(data.contentBase64);
    const expected = await expectedItems(versionB, '협약변경 1차');
    expectSheetEqualsTsv(loaded, '편성 항목·증빙', expected);
    const ws = loaded.wb.getWorksheet('편성 항목·증빙')!;
    expect(ws.actualRowCount).toBe(2);
    expect(ws.getCell('A2').value).toBe('합계');
    expect(ws.getCell('E2').value).toBe(0);
    const text = guideText(loaded.wb);
    expect(text).toContain('편성 항목이 없습니다');
    expect(text).toContain('작성 중 버전입니다');
  });

  it('다른 과제의 버전은 RULE, 형식이 틀린 요청은 VALIDATION', async () => {
    const other = expectFailure(await buildAgreementWorkbook(f.projectId, { view: 'items', versionId: otherVersion }));
    expect(other.code).toBe('RULE');
    expect(other.error).toBe('이 과제에 속하지 않은 협약 예산 버전입니다.');

    const bad = expectFailure(await buildAgreementWorkbook(f.projectId, { view: 'items', versionId: 'not-a-uuid' }));
    expect(bad.code).toBe('VALIDATION');
    const extra = { view: 'items', versionId: versionA, findings: [] } as unknown as {
      view: 'items';
      versionId: string;
    };
    expect(expectFailure(await buildAgreementWorkbook(f.projectId, extra)).code).toBe('VALIDATION');
  });

  it('리포지토리 원문 오류(테이블 이름)는 사용자에게 새지 않는다(SA-4)', async () => {
    repoFault.message = 'relation "public.agreement_items" does not exist';
    try {
      const failure = expectFailure(await buildAgreementWorkbook(f.projectId, { view: 'items', versionId: versionA }));
      expect(failure.error).not.toContain('agreement_items');
      expect(failure.error).not.toContain('손상');
    } finally {
      repoFault.message = null;
    }
  });
});

// ─── 변경 이력 — RL-23 규칙 행 (S-7) ──────────────────────────────────────────

describe('변경 이력 내려받기 — RL-23 규칙 행', () => {
  const PRES = '세목 총액 보존';
  const request = () => ({ view: 'changes' as const, fromVersionId: versionA, toVersionId: versionB });

  it('행 없음 = 켜짐(Phase 24 그대로) → 행 켜짐도 같은 표 → 행 꺼짐이면 "규칙이 꺼져 있어 판정하지 않음"', async () => {
    const expectedOn = await expectedPreservationOn();
    const width = expectedOn.columns.length;

    // ① 행 없음
    expect(await budgetRulesRepo.getByCode(user.client, f.projectId, 'preserve_subcategory_totals')).toBeNull();
    const noRow = await load(unwrap(await buildAgreementWorkbook(f.projectId, request())).contentBase64);
    expectSheetEqualsTsv(noRow, PRES, expectedOn);
    const noRowGrid = sheetGrid(noRow, PRES, width);
    const noRowGuide = guideText(noRow.wb);
    expect(noRowGuide).not.toContain(RULE_OFF_TEXT);
    expect(noRowGuide).toContain("기준 버전 '최종협약본'");

    // ② 행 있음·켜짐 — 세목 시트·작성안내가 행 없음과 같다
    const rule = await budgetRulesRepo.insert(user.client, {
      projectId: f.projectId,
      code: 'preserve_subcategory_totals',
      enabled: true,
      value: null,
      base: null,
      severity: 'warn',
      source: '간사 지침 세목 총액 보존 (연차 간 이동 시 세목별 총액 유지)',
      note: '',
      createdBy: user.id,
      updatedBy: user.id,
    });
    const on = await load(unwrap(await buildAgreementWorkbook(f.projectId, request())).contentBase64);
    expect(sheetGrid(on, PRES, width)).toEqual(noRowGrid);
    expect(guideText(on.wb)).toBe(noRowGuide);

    // ③ 꺼짐 — 판정하지 않고 세 번째 상태 문구. 숫자 칸 없음, "기준 버전 없음"과 다르다
    await budgetRulesRepo.update(user.client, rule.id, { enabled: false, updatedBy: user.id });
    const off = await load(unwrap(await buildAgreementWorkbook(f.projectId, request())).contentBase64);
    expect(off.wb.worksheets.map((w) => w.name)).toEqual(['작성안내', '금액 증감', '참여인원 증감', PRES]);
    const offWs = off.wb.getWorksheet(PRES)!;
    expect(offWs.actualRowCount).toBe(2);
    expect(offWs.getCell('A2').value).toBe(RULE_OFF_TEXT);
    expect(sheetGrid(off, PRES, width)[0]).toEqual(noRowGrid[0]!.map((label, c) => (c === 4 ? '기준' : label)));
    for (const col of ['B', 'C', 'D', 'E', 'F', 'G']) expect(offWs.getCell(`${col}2`).value ?? '').toBe('');
    const offGuide = guideText(off.wb);
    expect(offGuide).toContain(RULE_OFF_TEXT);
    expect(offGuide).not.toContain('기준 버전이 없습니다');
    expect(offGuide).not.toContain("기준 버전 '최종협약본'");
    // 다른 두 시트는 규칙과 무관 — 그대로
    for (const sheet of ['금액 증감', '참여인원 증감']) {
      expect(sheetGrid(off, sheet, 8)).toEqual(sheetGrid(noRow, sheet, 8));
    }
  });
});
