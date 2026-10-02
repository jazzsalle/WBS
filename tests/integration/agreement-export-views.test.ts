// 협약 예산 Phase 25 보기 3종 엑셀 내려받기 **액션 계층** 통합 테스트 (SOT §6.19 AG-3~AG-5·AG-8, 부록 F, 계획서 S-19)
//
// 표 모델 자체는 단위 테스트(agreement-views·agreement-participants)가 고정했다. 여기서 보는 것은
//   (a) 액션이 DB의 버전·줄·정부지원 현금·참여인원·제안 데이터로 시트를 만들고, 생성 xlsx를 exceljs로 다시 열면
//       시트 목록(작성안내 첫 시트)·수식 + 결과값(0 포함)·비율 글자 칸이 남아 있는가
//   (b) 칸 값이 **같은 데이터로 만든 표 모델의 TSV**([복사])와 칸마다 같은가
//   (c) 조정회의형 변경전 = 제안 모드(buildBaselineFromPlan), 변환 실패면 0이 아니라 사유
//   (d) 파일명 라벨·과제 경계·입력 검증·SA-4
// 숫자 기준값은 Phase 24 S-20 / Phase 25 합성 픽스처에서 손으로 계산한 값이다(구현이 낸 값이 아니다).
// 자기가 만든 과제·사용자만 지운다 — 파괴적 테스트가 아니다.

import ExcelJS from 'exceljs';
import * as XLSX from 'xlsx';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Sql } from 'postgres';
import { connectDirectDb, createTestUser, destroyTestUser, type TestUser } from './helpers';
import type { ActionResult } from '@/types';
import * as agreements from '@/lib/db/agreements';
import * as budgetDetailsRepo from '@/lib/db/budget-details';
import * as budgetItemsRepo from '@/lib/db/budget-items';
import * as budgetRulesRepo from '@/lib/db/budget-rules';
import * as membersRepo from '@/lib/db/members';
import * as projects from '@/lib/db/projects';
import * as stages from '@/lib/db/stages';
import * as yearsRepo from '@/lib/db/years';
import { todayISO } from '@/lib/dates';
import { attachment4Tables, buildAttachment4View } from '@/lib/agreement/attachment4-view';
import { adjustmentTable, buildAdjustmentView } from '@/lib/agreement/adjustment-view';
import { buildParticipantsView, participantsTable } from '@/lib/agreement/participants';
import { buildBaselineFromPlan } from '@/lib/agreement/from-plan';
import { currentVersionId } from '@/lib/agreement/versions';
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
    listLinesByVersionIds: async (...args: Parameters<typeof actual.listLinesByVersionIds>) => {
      if (repoFault.message !== null) throw new Error(repoFault.message);
      return actual.listLinesByVersionIds(...args);
    },
  };
});

const { buildAgreementWorkbook } = await import('@/actions/agreement-export');

let sql: Sql;
let user: TestUser;
const tempProjectIds: string[] = []; // afterAll 안전망

const PROJECT_NAME = '협약 보기 내보내기 통합';

interface Fixture {
  projectId: string;
  y1: string;
  y2: string;
  m1: string;
  m2: string;
}

let f: Fixture;
let versionA: string; // final '최종협약본', 확정, order 1 — 현재 버전
let versionB: string; // amendment '협약변경 1차', 작성 중, order 2
let otherVersion: string; // 다른 과제의 버전

// ─── 픽스처 ───────────────────────────────────────────────────────────────────

async function newFixture(name: string): Promise<Fixture> {
  const project = await projects.createProject(user.client, { name, createdBy: user.id, updatedBy: user.id });
  tempProjectIds.push(project.id);
  const stage = await stages.createStage(user.client, { projectId: project.id, name: '1단계' });
  const year1 = await yearsRepo.createYear(user.client, { stageId: stage.id, name: '1차년도' });
  const year2 = await yearsRepo.createYear(user.client, { stageId: stage.id, name: '2차년도' });
  // 인력 리포지토리 입력 검증은 이 파일의 관심이 아니다 — 직결 SQL로 최소 행만 만든다. order로 정렬을 고정한다
  const members = await sql<{ id: string; name: string }[]>`
    insert into public.members (project_id, name, role, active, sort_order, created_by, updated_by)
    values (${project.id}::uuid, '김연구', 'researcher', true, 0, ${user.id}::uuid, ${user.id}::uuid),
           (${project.id}::uuid, '이연구', 'researcher', true, 1, ${user.id}::uuid, ${user.id}::uuid)
    returning id, name`;
  const byName = new Map(members.map((m) => [m.name, m.id]));
  return { projectId: project.id, y1: year1.id, y2: year2.id, m1: byName.get('김연구')!, m2: byName.get('이연구')! };
}

type Seed = agreements.AgreementLineSeed;
const L = (yearId: string, category: Seed['category'], subcategoryCode: string, axis: Seed['axis'], amount: number): Seed => ({
  yearId,
  category,
  subcategoryCode,
  axis,
  amount,
});

/** Phase 24 S-20 버전 A 금액 줄 = Phase 25 8-2 합성 픽스처 */
function linesA(x: Fixture): Seed[] {
  return [
    L(x.y1, 'personnel', 'personnel_internal', 'cash', 30_000_000),
    L(x.y1, 'personnel', 'personnel_internal', 'in_kind', 10_000_000),
    L(x.y1, 'material', 'material_purchase', 'cash', 5_000_000),
    L(x.y1, 'activity', 'activity_meeting', 'cash', 1_200_000),
    L(x.y1, 'activity', 'activity_travel_dom', 'cash', 800_000),
    L(x.y1, 'allowance', 'default', 'cash', 3_000_000),
    L(x.y1, 'indirect', 'indirect_hr', 'cash', 2_500_000),
    L(x.y2, 'personnel', 'personnel_internal', 'cash', 32_000_000),
    L(x.y2, 'personnel', 'personnel_internal', 'in_kind', 10_000_000),
    L(x.y2, 'material', 'material_purchase', 'cash', 4_000_000),
    L(x.y2, 'activity', 'activity_meeting', 'cash', 1_000_000),
    L(x.y2, 'allowance', 'default', 'cash', 3_000_000),
    L(x.y2, 'indirect', 'indirect_hr', 'cash', 2_700_000),
  ];
}

function P(
  memberId: string | null,
  yearId: string,
  rate: number,
  months: number,
  cash: number,
  inKind: number
): agreements.AgreementParticipantSeed {
  return {
    memberId,
    yearId,
    participationRate: rate,
    months,
    annualSalary: memberId === null ? null : 60_000_000,
    personnelCash: cash,
    personnelInKind: inKind,
    role: '',
  };
}

async function confirm(versionId: string): Promise<void> {
  const v = await agreements.getVersionById(user.client, versionId);
  await agreements.confirmVersion(user.client, versionId, v.version, user.id);
}

// ─── 헬퍼 (Phase 24 agreement-export.test.ts와 같은 판독 규약) ────────────────

function unwrap<T>(result: ActionResult<T>): T {
  if (!result.ok) throw new Error(`액션 실패: ${result.error} (code=${result.code ?? '-'})`);
  return result.data;
}

function expectFailure<T>(result: ActionResult<T>): { error: string; code?: string } {
  if (result.ok) throw new Error('실패해야 하는 액션이 성공했다');
  return { error: result.error, code: result.code };
}

/** exceljs(서식·수식)와 SheetJS(수식 결과값 원문) 두 눈으로 같은 바이트를 연다 */
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

/**
 * 수식 칸의 결과값. exceljs 리더는 `<v>0</v>`을 읽을 때 결과값 0을 버린다(쓰기는 0도 쓴다 — 파일에는 있다).
 * 그래서 exceljs가 결과값을 못 주면 SheetJS로 같은 칸의 `<v>`를 직접 확인한다 — 파일에 결과값이 정말 없으면 실패한다.
 */
function formulaResult(loaded: Loaded, ws: ExcelJS.Worksheet, address: string): number | string | undefined {
  const v = ws.getCell(address).value as ExcelJS.CellFormulaValue;
  if (v.result !== undefined && v.result !== null) return v.result as number | string;
  const raw = loaded.raw.Sheets[ws.name]?.[address] as XLSX.CellObject | undefined;
  return raw?.f === v.formula && typeof raw.v === 'number' ? raw.v : undefined;
}

/** exceljs 셀 → TSV와 같은 문자열. 수식 칸은 결과값 */
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

/** `{ formula, result }` — 결과값은 formulaResult(0 포함)로 */
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

/** 시트 격자 = 같은 데이터로 만든 표 모델의 TSV(칸마다), 표 아래로 새는 행 없음 */
function expectSheetEqualsTsv(loaded: Loaded, sheetName: string, model: TableModel): void {
  const ws = loaded.wb.getWorksheet(sheetName);
  expect(ws).toBeDefined();
  const grid = parseTsv(toTsv(model));
  const width = model.columns.length;
  const excel: string[][] = [];
  for (let r = 1; r <= grid.length; r += 1) {
    const row: string[] = [];
    for (let c = 1; c <= width; c += 1) row.push(excelText(loaded, ws!, ws!.getCell(r, c).address));
    excel.push(row);
  }
  expect(excel).toEqual(grid);
  expect(ws!.actualRowCount).toBe(grid.length);
}

/** 첫 열 글자로 행 번호를 찾는다 — 양식 행 순서(C.4)를 이 파일에 다시 적지 않는다 */
function rowOf(ws: ExcelJS.Worksheet, label: string, subLabel?: string): number {
  for (let r = 2; r <= ws.actualRowCount; r += 1) {
    if (ws.getCell(r, 1).value !== label) continue;
    if (subLabel === undefined || ws.getCell(r, 2).value === subLabel) return r;
  }
  throw new Error(`행을 찾지 못했다: ${label} ${subLabel ?? ''}`);
}

/** 모델의 sum 칸 전부가 엑셀에서 수식 + 결과값(0 포함)인지 */
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

/** 모델의 비율(…%·—) 글자 칸이 엑셀에서도 글자인지 — 숫자 서식으로 바뀌면 붙여넣기·재계산 의미가 달라진다 */
function expectRateCellsAreText(loaded: Loaded, sheetName: string, model: TableModel): number {
  const ws = loaded.wb.getWorksheet(sheetName)!;
  let count = 0;
  model.rows.forEach((row, r) => {
    row.cells.forEach((cell, c) => {
      if (cell.kind !== 'text' || !/^(-?\d+\.\d{2}%|—)$/.test(cell.text)) return;
      expect(ws.getCell(r + 2, c + 1).value).toBe(cell.text);
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

// ─── 기대 표 모델 — 액션과 독립적으로 리포지토리 데이터 → 순수 함수 ──────────────

async function expectedAttachment4(versionId: string, versionName: string) {
  const [years, stageList, lines, govSupport, rules] = await Promise.all([
    yearsRepo.listYears(user.client, f.projectId),
    stages.listStages(user.client, f.projectId),
    agreements.listLinesByVersionIds(user.client, [versionId]),
    agreements.listGovSupportByVersionIds(user.client, [versionId]),
    budgetRulesRepo.listByProject(user.client, f.projectId),
  ]);
  return attachment4Tables(buildAttachment4View({ lines, years, stages: stageList, govSupport, rules }), {
    plan81: `8-1 연구개발비 지원 및 부담계획 — ${versionName}`,
    plan82: `8-2 연구개발비 사용계획 — ${versionName}`,
  });
}

async function expectedAdjustment(versionId: string, versionName: string): Promise<TableModel> {
  const [years, versions, lines, items, details, members] = await Promise.all([
    yearsRepo.listYears(user.client, f.projectId),
    agreements.listVersionsByProject(user.client, f.projectId),
    agreements.listLinesByVersionIds(user.client, [versionId]),
    budgetItemsRepo.listBudgetItemsByProject(user.client, f.projectId),
    budgetDetailsRepo.listByProject(user.client, f.projectId),
    membersRepo.listMembers(user.client, f.projectId),
  ]);
  const view = buildAdjustmentView({
    years,
    before: buildBaselineFromPlan({ items, details, members, years }),
    after: { versionId, versionName, lines },
    currentVersionId: currentVersionId(versions),
  });
  return adjustmentTable(view, `조정회의형 — ${versionName}`);
}

async function expectedParticipants(versionId: string, versionName: string): Promise<TableModel> {
  const [years, participants, lines, members] = await Promise.all([
    yearsRepo.listYears(user.client, f.projectId),
    agreements.listParticipantsByVersionIds(user.client, [versionId]),
    agreements.listLinesByVersionIds(user.client, [versionId]),
    membersRepo.listMembers(user.client, f.projectId),
  ]);
  return participantsTable(buildParticipantsView({ participants, members, years, lines }), `참여인원 — ${versionName}`);
}

// ─── 준비·정리 ────────────────────────────────────────────────────────────────

beforeAll(async () => {
  sql = connectDirectDb();
  user = await createTestUser(sql);
  session.accessToken = user.accessToken;

  f = await newFixture(PROJECT_NAME);

  // 제안 모드(조정회의형 변경전): 1차년도만. 연구수당은 현금·현물 미분리 → 현금(AV-6 Q2)
  await budgetItemsRepo.updateBudgetPlan(user.client, f.y1, 'personnel', {
    plannedAmount: 40_000_000,
    cashAmount: 30_000_000,
    inKindAmount: 10_000_000,
  });
  await budgetItemsRepo.updateBudgetPlan(user.client, f.y1, 'material', {
    plannedAmount: 5_000_000,
    cashAmount: 5_000_000,
    inKindAmount: 0,
  });
  await budgetItemsRepo.updateBudgetPlan(user.client, f.y1, 'allowance', {
    plannedAmount: 3_000_000,
    cashAmount: null,
    inKindAmount: null,
  });

  const a = await agreements.createVersion(user.client, f.projectId, {
    kind: 'final',
    name: '최종협약본',
    lines: linesA(f),
    // 2차년도 이후로 Y2 subtotal 현물 = 0 — 0 결과값 확인용
    participants: [
      P(f.m1, f.y1, 50, 12, 30_000_000, 0),
      P(f.m1, f.y2, 50, 12, 32_000_000, 0),
      P(f.m2, f.y1, 20, 12, 0, 10_000_000),
    ],
    // 1차년도만 정부지원 현금 입력, 2차년도는 미입력 → 8-1 "—"
    govCash: { [f.y1]: 30_000_000 },
  });
  versionA = a.versionId;
  await confirm(versionA);
  versionB = (
    await agreements.createVersion(user.client, f.projectId, {
      kind: 'amendment',
      name: '협약변경 1차',
      lines: linesA(f).filter((l) => l.category !== 'indirect'),
      participants: [],
    })
  ).versionId;

  const other = await newFixture('협약 보기 내보내기 — 다른 과제');
  otherVersion = (
    await agreements.createVersion(user.client, other.projectId, {
      kind: 'final',
      name: '남의 버전',
      lines: [L(other.y1, 'material', 'default', 'cash', 1_000)],
      participants: [],
    })
  ).versionId;
}, 60_000);

afterAll(async () => {
  if (tempProjectIds.length > 0) {
    // 버전을 먼저 지운다 — delete_project(H-7)와 같은 순서. 연차·인력의 no action FK를 피한다
    await sql`delete from public.agreement_versions where project_id = any(${tempProjectIds}::uuid[])`;
    await sql`delete from public.projects where id = any(${tempProjectIds}::uuid[])`;
  }
  await destroyTestUser(sql, user);
  await sql.end();
});

// ─── 붙임4형 ──────────────────────────────────────────────────────────────────

describe('붙임4형 내려받기', () => {
  it('작성안내 + 8-1 + 8-2, 칸 값 = TSV, sum 칸 = 수식 + 결과값, 비율은 글자 칸', async () => {
    const data = unwrap(await buildAgreementWorkbook(f.projectId, { view: 'attachment4', versionId: versionA }));
    expect(data.fileName).toBe(`${PROJECT_NAME}_협약예산_최종협약본 붙임4형_${yyyymmdd()}.xlsx`);
    const loaded = await load(data.contentBase64);
    const wb = loaded.wb;
    expect(wb.worksheets.map((w) => w.name)).toEqual(['작성안내', '8-1 지원·부담계획', '8-2 사용계획']);
    for (const sheet of wb.worksheets) expect(sheet.properties.tabColor).toEqual({ argb: 'FF1A1A1A' });

    const expected = await expectedAttachment4(versionA, '최종협약본');
    expectSheetEqualsTsv(loaded, '8-1 지원·부담계획', expected.plan81);
    expectSheetEqualsTsv(loaded, '8-2 사용계획', expected.plan82);
    expect(expectAllSumsAreFormulas(loaded, '8-2 사용계획', expected.plan82)).toBeGreaterThan(0);
    expect(expectAllSumsAreFormulas(loaded, '8-1 지원·부담계획', expected.plan81)).toBeGreaterThan(0);
    expect(expectRateCellsAreText(loaded, '8-2 사용계획', expected.plan82)).toBeGreaterThan(0);
    expect(expectRateCellsAreText(loaded, '8-1 지원·부담계획', expected.plan81)).toBeGreaterThan(0);

    // 8-2 손 계산(합성 픽스처). 열: A 항목 · B 구분 · C 1차년도 · D 2차년도 · E 합계(단계 1개 — 단계 소계 열 없음)
    const p82 = wb.getWorksheet('8-2 사용계획')!;
    expect(p82.getCell('C1').value).toBe('1차년도');
    expect(p82.getCell('E1').value).toBe('합계');
    const m = rowOf(p82, '연구개발비 총액(M)');
    expect(formulaCell(loaded, p82, `C${m}`)).toMatchObject({ result: 52_500_000 });
    expect(formulaCell(loaded, p82, `E${m}`)).toMatchObject({ result: 105_200_000 });
    // 연구수당 비율 I/E2: 7.5% · 7.1429% · 7.3171% — 글자 칸
    const iE2 = rowOf(p82, '연구수당 비율(I/E2)');
    expect([p82.getCell(`C${iE2}`).value, p82.getCell(`D${iE2}`).value, p82.getCell(`E${iE2}`).value]).toEqual([
      '7.50%',
      '7.14%',
      '7.32%',
    ]);
    // 간접비 비율(양식 분모): 6.25% · 6.75% · 6.50%
    const ir = rowOf(p82, '간접비 비율(양식 분모)');
    expect([p82.getCell(`C${ir}`).value, p82.getCell(`D${ir}`).value, p82.getCell(`E${ir}`).value]).toEqual([
      '6.25%',
      '6.75%',
      '6.50%',
    ]);

    // 8-1: 열 A 연차 · B 기업유형 · C 정부지원 현금 A · D 기관부담 현금 B · E 현물 C · F D … · L 합계 H · M A/H · N B/D
    const p81 = wb.getWorksheet('8-1 지원·부담계획')!;
    expect(p81.getCell('A2').value).toBe('1차년도');
    expect(p81.getCell('B2').value).toBe('중소기업');
    expect(p81.getCell('C2').value).toBe(30_000_000);
    expect(p81.getCell('D2').value).toBe(12_500_000); // 현금 합 42,500,000 − 30,000,000
    expect(formulaCell(loaded, p81, 'F2')).toEqual({ formula: 'SUM(D2:E2)', result: 22_500_000 });
    expect(p81.getCell('M2').value).toBe('57.14%'); // 30,000,000 / 52,500,000
    expect(p81.getCell('N2').value).toBe('55.56%'); // 12,500,000 / 22,500,000
    // 2차년도 정부지원 현금 미입력 → A·B 빈 칸, 비율 "—"(0이 아니다)
    expect(p81.getCell('C3').value).toBeNull();
    expect(p81.getCell('M3').value).toBe('—');
    // 규칙 행이 없으니 판정하지 않는다
    expect(String(p81.getCell('O2').value)).toContain('판정하지 않음');
    // 0 결과값: 그 외 기관 소계(0 + 0) — exceljs는 결과값 0을 버리므로 SheetJS로 원값을 본다
    const otherSubtotal = formulaCell(loaded, p81, 'I2');
    expect(otherSubtotal).toMatchObject({ result: 0 });
    expect(typeof (otherSubtotal as { formula?: unknown }).formula).toBe('string');

    const guide = wb.getWorksheet('작성안내')!;
    expect(guide.getCell('A1').value).toBe(`${PROJECT_NAME} — 협약 예산 붙임4형`);
    expect(String(guide.getCell('A2').value)).toContain('최종협약본');
    const text = guideText(wb);
    expect(text).toContain('원 단위');
    expect(text).toContain('고쳐도 앱에 반영되지 않습니다');
    expect(text).toContain('자동으로 채운');
    expect(text).toContain('양식 분모');
    expect(text).toContain('수정직접비와 별개');
    expect(text).toContain('규칙 행이 켜져 있고 값이 있을 때만');
    expect(text).toContain('비율 칸은 수식이 아니라 글자');
    // 검토사항: 2차년도 정부지원 현금 미입력
    expect(text).toContain('2차년도: 정부지원 현금');
    expect(text).not.toContain('작성 중 버전입니다');
  });
});

// ─── 조정회의형 ───────────────────────────────────────────────────────────────

describe('조정회의형 내려받기', () => {
  it('한 시트: 변경전 = 제안, 변경후 = 버전. 칸 값 = TSV, D·합계 sum 칸, 비율 글자', async () => {
    const data = unwrap(await buildAgreementWorkbook(f.projectId, { view: 'adjustment', versionId: versionA }));
    expect(data.fileName).toBe(`${PROJECT_NAME}_협약예산_최종협약본 조정회의형_${yyyymmdd()}.xlsx`);
    const loaded = await load(data.contentBase64);
    const wb = loaded.wb;
    expect(wb.worksheets.map((w) => w.name)).toEqual(['작성안내', '조정회의형']);

    const expected = await expectedAdjustment(versionA, '최종협약본');
    expectSheetEqualsTsv(loaded, '조정회의형', expected);
    expect(expectAllSumsAreFormulas(loaded, '조정회의형', expected)).toBeGreaterThan(0);
    expect(expectRateCellsAreText(loaded, '조정회의형', expected)).toBeGreaterThan(0);

    // 열: A 항목 · B~D 변경전 1차/2차/합계 · E~G 변경후 1차/2차/합계. 행: 2 A · 3 B · 4 C · 5 D · 6 E · 7 D/E · 8 B/A · 9 F · 10 A/F · 11 간접비 비율
    const ws = wb.getWorksheet('조정회의형')!;
    expect(ws.getCell('B1').value).toBe('변경전 (제안) 1차년도');
    expect(ws.getCell('G1').value).toBe('변경후 (최종협약본) 합계');
    expect(ws.getCell('A5').value).toBe('합계(D=A+B+C)');
    // 변경후 1차년도: A 40,000,000 · B 3,000,000 · C 2,500,000 · D 45,500,000 · E 52,500,000 · F 50,000,000
    expect(ws.getCell('E2').value).toBe(40_000_000);
    expect(formulaCell(loaded, ws, 'E5')).toEqual({ formula: 'SUM(E2:E4)', result: 45_500_000 });
    expect(ws.getCell('E6').value).toBe(52_500_000);
    expect(ws.getCell('E7').value).toBe('86.67%'); // 45.5 / 52.5
    expect(ws.getCell('E9').value).toBe(50_000_000);
    // 변경후 합계 열: A 82,000,000 · D 93,200,000 · E 105,200,000
    expect(formulaCell(loaded, ws, 'G2')).toEqual({ formula: 'SUM(E2:F2)', result: 82_000_000 });
    expect(formulaCell(loaded, ws, 'G6')).toEqual({ formula: 'SUM(E6:F6)', result: 105_200_000 });
    // 변경전(제안) 1차년도: A 40,000,000 · B 3,000,000(미분리 → 현금) · C 0 · D 43,000,000 · E 48,000,000
    expect(ws.getCell('B2').value).toBe(40_000_000);
    expect(ws.getCell('B3').value).toBe(3_000_000);
    expect(ws.getCell('B6').value).toBe(48_000_000);
    expect(formulaCell(loaded, ws, 'B5')).toEqual({ formula: 'SUM(B2:B4)', result: 43_000_000 });
    // 변경전 2차년도는 제안 데이터가 없다 → 금액 빈 칸, 비율 "—"
    expect(ws.getCell('C2').value).toBeNull();
    expect(ws.getCell('C7').value).toBe('—');
    // 0 결과값: 변경전 합계 열 간접비 C = 0 — SheetJS로 원값 확인
    expect(formulaCell(loaded, ws, 'D4')).toEqual({ formula: 'SUM(B4:C4)', result: 0 });

    const guide = wb.getWorksheet('작성안내')!;
    expect(guide.getCell('A1').value).toBe(`${PROJECT_NAME} — 협약 예산 조정회의형`);
    const text = guideText(wb);
    expect(text).toContain('제안 모드의 사업비');
    expect(text).toContain('변경후 = 협약 예산 버전');
    expect(text).toContain('제안 셀 1개(합 3,000,000원)는 현금으로');
    expect(text).toContain('양식 분모');
    expect(text).toContain('원 단위');
    expect(text).toContain('고쳐도 앱에 반영되지 않습니다');
    expect(text).not.toContain('현재 버전 아님');
  });

  it('현재 버전이 아닌 작성 중 버전: 작성안내에 "현재 버전 아님"·작성 중 경고', async () => {
    const data = unwrap(await buildAgreementWorkbook(f.projectId, { view: 'adjustment', versionId: versionB }));
    expect(data.fileName).toBe(`${PROJECT_NAME}_협약예산_협약변경 1차 조정회의형_${yyyymmdd()}.xlsx`);
    const loaded = await load(data.contentBase64);
    expectSheetEqualsTsv(loaded, '조정회의형', await expectedAdjustment(versionB, '협약변경 1차'));
    const text = guideText(loaded.wb);
    expect(text).toContain('현재 버전 아님');
    expect(text).toContain('작성 중 버전입니다');
  });

  it('제안 변환이 실패하면 변경전은 0이 아니라 "—" + 사유', async () => {
    // 현금만 적혔는데 계획액과 다르다 → split_mismatch
    await budgetItemsRepo.updateBudgetPlan(user.client, f.y1, 'material', {
      plannedAmount: 5_000_000,
      cashAmount: 3_000_000,
      inKindAmount: null,
    });
    try {
      const data = unwrap(await buildAgreementWorkbook(f.projectId, { view: 'adjustment', versionId: versionA }));
      const loaded = await load(data.contentBase64);
      const expected = await expectedAdjustment(versionA, '최종협약본');
      expectSheetEqualsTsv(loaded, '조정회의형', expected);
      const ws = loaded.wb.getWorksheet('조정회의형')!;
      for (const address of ['B2', 'B5', 'D6']) expect(ws.getCell(address).value).toBe('—');
      expect(ws.getCell(`A${ws.actualRowCount}`).value).toBe('변경전 사유');
      // 변경후는 그대로
      expect(ws.getCell('E2').value).toBe(40_000_000);
      const text = guideText(loaded.wb);
      expect(text).toContain('0으로 채우지 않았습니다');
    } finally {
      await budgetItemsRepo.updateBudgetPlan(user.client, f.y1, 'material', {
        plannedAmount: 5_000_000,
        cashAmount: 5_000_000,
        inKindAmount: 0,
      });
    }
  });
});

// ─── 참여인원 ─────────────────────────────────────────────────────────────────

describe('참여인원 내려받기', () => {
  it('작성안내 + 한 시트, 칸 값 = TSV, 계·소계·총계 sum 칸(0 결과 포함), 금액 줄 대조는 작성안내에', async () => {
    const data = unwrap(await buildAgreementWorkbook(f.projectId, { view: 'participants', versionId: versionA }));
    expect(data.fileName).toBe(`${PROJECT_NAME}_협약예산_최종협약본 참여인원_${yyyymmdd()}.xlsx`);
    const loaded = await load(data.contentBase64);
    const wb = loaded.wb;
    expect(wb.worksheets.map((w) => w.name)).toEqual(['작성안내', '참여인원']);

    const expected = await expectedParticipants(versionA, '최종협약본');
    expectSheetEqualsTsv(loaded, '참여인원', expected);
    expect(expectAllSumsAreFormulas(loaded, '참여인원', expected)).toBeGreaterThan(0);

    // 열: A 인력 · B 연차 · C 역할 · D 참여율 · E 개월 · F 연봉 · G 계산값 · H 현금 · I 현물 · J 계 · K 구분
    // 행: 2 김연구 1차 · 3 김연구 2차 · 4 이연구 1차 · 5 소계 1차 · 6 소계 2차 · 7 총계
    const ws = wb.getWorksheet('참여인원')!;
    expect([ws.getCell('A2').value, ws.getCell('B2').value]).toEqual(['김연구', '1차년도']);
    expect(ws.getCell('D2').value).toBe('50'); // 참여율은 글자 칸
    expect(ws.getCell('G2').value).toBe(30_000_000); // 60,000,000 × 50% × 12/12
    expect(ws.getCell('K2').value).toBe('자동');
    expect(ws.getCell('K3').value).toBe('수동'); // 32,000,000 ≠ 계산값 30,000,000
    expect(formulaCell(loaded, ws, 'J2')).toEqual({ formula: 'SUM(H2:I2)', result: 30_000_000 });
    expect(ws.getCell('A5').value).toBe('소계');
    expect(formulaCell(loaded, ws, 'J5')).toMatchObject({ result: 40_000_000 });
    // 0 결과값: 2차년도 소계 현물 — exceljs는 결과값 0을 버리므로 SheetJS로 원값을 본다
    expect(formulaCell(loaded, ws, 'I6')).toMatchObject({ result: 0 });
    expect(ws.getCell('A7').value).toBe('총계');
    expect(formulaCell(loaded, ws, 'J7')).toMatchObject({ result: 72_000_000 });

    const guide = wb.getWorksheet('작성안내')!;
    expect(guide.getCell('A1').value).toBe(`${PROJECT_NAME} — 협약 예산 참여인원`);
    const text = guideText(wb);
    // 2차년도: 참여인원 현물 0 − 금액 줄 현물 10,000,000
    expect(text).toContain('2차년도 현금 0원 · 현물 -10,000,000원');
    expect(text).toContain('원 단위');
    expect(text).toContain('고쳐도 앱에 반영되지 않습니다');
    expect(text).toContain("'연봉 모름'");
  });
});

// ─── 경계·입력 검증 ───────────────────────────────────────────────────────────

describe('과제 경계·입력 검증', () => {
  it('다른 과제의 버전 id는 세 보기 모두 RULE', async () => {
    for (const view of ['attachment4', 'adjustment', 'participants'] as const) {
      const failure = expectFailure(await buildAgreementWorkbook(f.projectId, { view, versionId: otherVersion }));
      expect(failure.code, view).toBe('RULE');
      expect(failure.error).toContain('이 과제에 속하지 않은');
    }
  });

  it('형식이 틀린 입력은 VALIDATION', async () => {
    expect(expectFailure(await buildAgreementWorkbook(f.projectId, { view: 'attachment4', versionId: 'x' })).code).toBe(
      'VALIDATION'
    );
    const extraKey = { view: 'participants', versionId: versionA, toVersionId: versionB } as unknown as {
      view: 'participants';
      versionId: string;
    };
    expect(expectFailure(await buildAgreementWorkbook(f.projectId, extraKey)).code).toBe('VALIDATION');
    const missing = { view: 'adjustment' } as unknown as { view: 'adjustment'; versionId: string };
    expect(expectFailure(await buildAgreementWorkbook(f.projectId, missing)).code).toBe('VALIDATION');
  });

  it('리포지토리의 일반 Error는 일반 문구로 감춘다 — [db]·테이블 이름이 사용자에게 가지 않는다(SA-4)', async () => {
    repoFault.message = '[db] PGRST205: Could not find the table public.agreement_lines in the schema cache';
    try {
      for (const view of ['attachment4', 'adjustment', 'participants'] as const) {
        const failure = expectFailure(await buildAgreementWorkbook(f.projectId, { view, versionId: versionA }));
        expect(failure.error).not.toContain('[db]');
        expect(failure.error).not.toContain('agreement_lines');
        expect(failure.error).not.toContain('PGRST');
        expect(failure.code).not.toBe('RULE');
      }
    } finally {
      repoFault.message = null;
    }
  });
});
