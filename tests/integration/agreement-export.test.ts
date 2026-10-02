// 협약 예산 엑셀 내려받기 **액션 계층** 통합 테스트 (SOT §6.19 AG-8, 부록 F, 계획서 S-11·S-15·S-20)
//
// tests/unit/agreement-table.test.ts가 표 모델 → 시트 변환을 고정했다. 여기서 보는 것은
//   (a) 액션이 DB의 버전·줄·참여인원으로 시트를 만들고, 생성 xlsx를 exceljs로 다시 열면
//       시트 목록(작성안내 첫 시트)·부록 F 서식·수식 + 결과값이 남아 있는가
//   (b) 칸 값이 **같은 데이터로 만든 표 모델의 TSV**([복사])와 칸마다 같은가
//   (c) 확정·작성 중 버전 모두 내려받히는가, 기준 버전이 없을 때 "기준 버전 없음"이 나가는가
//   (d) 과제 경계·입력 검증
// 숫자 기준값은 계획서 S-20 합성 픽스처에서 손으로 계산한 값이다(구현이 낸 값이 아니다).
// 자기가 만든 과제·사용자만 지운다 — 파괴적 테스트가 아니다.

import ExcelJS from 'exceljs';
import * as XLSX from 'xlsx';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Sql } from 'postgres';
import { connectDirectDb, createTestUser, destroyTestUser, type TestUser } from './helpers';
import type { ActionResult } from '@/types';
import * as agreements from '@/lib/db/agreements';
import * as membersRepo from '@/lib/db/members';
import * as projects from '@/lib/db/projects';
import * as stages from '@/lib/db/stages';
import * as yearsRepo from '@/lib/db/years';
import { todayISO } from '@/lib/dates';
import { buildCategoryView, categoryViewTable } from '@/lib/agreement/category-view';
import { diffAgreementLines, diffAgreementParticipants } from '@/lib/agreement/diff';
import { checkSubcategoryPreservation } from '@/lib/agreement/preservation';
import {
  PRESERVATION_NO_BASE_TEXT,
  buildLineChangesTable,
  buildParticipantChangesTable,
  buildPreservationTable,
} from '@/lib/agreement/changes-table';
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

const PROJECT_NAME = '협약 내보내기 통합';

interface Fixture {
  projectId: string;
  y1: string;
  y2: string;
  m1: string;
  m2: string;
}

let f: Fixture;
let versionA: string; // final, 확정, order 1
let versionB: string; // amendment '협약변경 1차', 작성 중, order 2
let otherVersion: string; // 다른 과제의 버전

// ─── 픽스처 ───────────────────────────────────────────────────────────────────

async function newFixture(name: string): Promise<Fixture> {
  const project = await projects.createProject(user.client, { name, createdBy: user.id, updatedBy: user.id });
  tempProjectIds.push(project.id);
  const stage = await stages.createStage(user.client, { projectId: project.id, name: '1단계' });
  const year1 = await yearsRepo.createYear(user.client, { stageId: stage.id, name: '1차년도' });
  const year2 = await yearsRepo.createYear(user.client, { stageId: stage.id, name: '2차년도' });
  // 인력 리포지토리 입력 검증은 이 파일의 관심이 아니다 — 직결 SQL로 최소 행만 만든다
  const members = await sql<{ id: string; name: string }[]>`
    insert into public.members (project_id, name, role, active, created_by, updated_by)
    values (${project.id}::uuid, '김연구', 'researcher', true, ${user.id}::uuid, ${user.id}::uuid),
           (${project.id}::uuid, '이연구', 'researcher', true, ${user.id}::uuid, ${user.id}::uuid)
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

/** S-20 버전 A 금액 줄 */
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

/** S-20 버전 B = A에서 재료비 이동·국내출장 삭제·국외출장 추가·간접비 증액 */
function linesB(x: Fixture): Seed[] {
  return [
    L(x.y1, 'personnel', 'personnel_internal', 'cash', 30_000_000),
    L(x.y1, 'personnel', 'personnel_internal', 'in_kind', 10_000_000),
    L(x.y1, 'material', 'material_purchase', 'cash', 3_000_000),
    L(x.y1, 'activity', 'activity_meeting', 'cash', 1_200_000),
    L(x.y1, 'allowance', 'default', 'cash', 3_000_000),
    L(x.y1, 'indirect', 'indirect_hr', 'cash', 2_500_000),
    L(x.y2, 'personnel', 'personnel_internal', 'cash', 32_000_000),
    L(x.y2, 'personnel', 'personnel_internal', 'in_kind', 10_000_000),
    L(x.y2, 'material', 'material_purchase', 'cash', 6_000_000),
    L(x.y2, 'activity', 'activity_meeting', 'cash', 1_000_000),
    L(x.y2, 'activity', 'activity_travel_intl', 'cash', 500_000),
    L(x.y2, 'allowance', 'default', 'cash', 3_000_000),
    L(x.y2, 'indirect', 'indirect_hr', 'cash', 2_900_000),
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

// ─── 헬퍼 ─────────────────────────────────────────────────────────────────────

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

function fillOf(ws: ExcelJS.Worksheet, address: string): string | undefined {
  return (ws.getCell(address).fill as ExcelJS.FillPattern | undefined)?.fgColor?.argb;
}

function yyyymmdd(): string {
  return todayISO(new Date()).replace(/-/g, '');
}

/** 액션과 독립적으로 리포지토리 데이터 → 순수 함수로 변경 이력 표 3종을 만든다 */
async function expectedChangesTables(fromId: string, toId: string, baseId: string | null) {
  const [years, versions, members] = await Promise.all([
    yearsRepo.listYears(user.client, f.projectId),
    agreements.listVersionsByProject(user.client, f.projectId),
    membersRepo.listMembers(user.client, f.projectId),
  ]);
  const ids = [...new Set([fromId, toId, ...(baseId === null ? [] : [baseId])])];
  const [lines, participants] = await Promise.all([
    agreements.listLinesByVersionIds(user.client, ids),
    agreements.listParticipantsByVersionIds(user.client, ids),
  ]);
  const v = (id: string) => versions.find((x) => x.id === id)!;
  const linesOf = (id: string) => lines.filter((l) => l.versionId === id);
  const partsOf = (id: string) => participants.filter((p) => p.versionId === id);
  const from = v(fromId);
  const to = v(toId);
  const base = baseId === null ? null : v(baseId);
  return {
    line: buildLineChangesTable(diffAgreementLines(linesOf(fromId), linesOf(toId), years), { years, from, to }),
    participant: buildParticipantChangesTable(diffAgreementParticipants(partsOf(fromId), partsOf(toId), years), {
      years,
      members,
      from,
      to,
    }),
    preservation: buildPreservationTable(
      checkSubcategoryPreservation(linesOf(toId), base === null ? null : { versionId: base.id, lines: linesOf(base.id) }),
      { target: to, base }
    ),
  };
}

// ─── 준비·정리 ────────────────────────────────────────────────────────────────

beforeAll(async () => {
  sql = connectDirectDb();
  user = await createTestUser(sql);
  session.accessToken = user.accessToken;

  f = await newFixture(PROJECT_NAME);
  const a = await agreements.createVersion(user.client, f.projectId, {
    kind: 'final',
    name: '최종협약본',
    lines: linesA(f),
    participants: [
      P(f.m1, f.y1, 50, 12, 30_000_000, 0),
      P(f.m1, f.y2, 50, 12, 32_000_000, 0),
      P(f.m2, f.y1, 20, 12, 0, 10_000_000),
      P(f.m2, f.y2, 20, 12, 0, 10_000_000),
    ],
  });
  versionA = a.versionId;
  await confirm(versionA);
  const b = await agreements.createVersion(user.client, f.projectId, {
    kind: 'amendment',
    name: '협약변경 1차',
    lines: linesB(f),
    participants: [
      P(f.m1, f.y1, 50, 12, 30_000_000, 0),
      P(f.m1, f.y2, 50, 12, 32_000_000, 0),
      P(f.m2, f.y1, 20, 12, 0, 10_000_000),
      P(f.m2, f.y2, 25, 12, 0, 12_500_000),
      P(null, f.y2, 30, 6, 5_000_000, 0),
    ],
  });
  versionB = b.versionId;

  const other = await newFixture('협약 내보내기 — 다른 과제');
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

// ─── 비목별 ───────────────────────────────────────────────────────────────────

describe('비목별 보기 내려받기', () => {
  it('확정 버전: 시트 목록·부록 F 서식·수식 + 결과값, 칸 값 = TSV', async () => {
    const data = unwrap(await buildAgreementWorkbook(f.projectId, { view: 'category', versionId: versionA }));
    expect(data.fileName).toBe(`${PROJECT_NAME}_협약예산_최종협약본_${yyyymmdd()}.xlsx`);
    const loaded = await load(data.contentBase64);
    const wb = loaded.wb;
    expect(wb.worksheets.map((w) => w.name)).toEqual(['작성안내', '비목별']);

    // 칸 값 = 같은 데이터의 TSV
    const [years, lines] = await Promise.all([
      yearsRepo.listYears(user.client, f.projectId),
      agreements.listLinesByVersionIds(user.client, [versionA]),
    ]);
    const model = categoryViewTable(buildCategoryView(lines, years), '비목별 — 최종협약본');
    const ws = wb.getWorksheet('비목별')!;
    expectSheetEqualsTsv(loaded, '비목별', model);

    // 열: A 비목 · B~D 1차년도 현금/현물/계 · E~G 2차년도 · H~J 총계. 행: 1 헤더 · 2~13 비목 12 · 14 합계
    expect(ws.getCell('A2').value).toBe('인건비');
    expect(formulaCell(loaded, ws, 'D2')).toEqual({ formula: 'SUM(B2:C2)', result: 40_000_000 });
    expect(ws.getCell('A14').value).toBe('합계');
    expect(formulaCell(loaded, ws, 'B14')).toEqual({ formula: 'SUM(B2:B13)', result: 42_500_000 });
    expect(formulaCell(loaded, ws, 'C14')).toEqual({ formula: 'SUM(C2:C13)', result: 10_000_000 });
    expect(formulaCell(loaded, ws, 'G14')).toEqual({ formula: 'SUM(G2:G13)', result: 52_700_000 });
    expect(formulaCell(loaded, ws, 'H14')).toEqual({ formula: 'SUM(H2:H13)', result: 85_200_000 });
    expect(formulaCell(loaded, ws, 'J14')).toEqual({ formula: 'SUM(J2:J13)', result: 105_200_000 });
    // 줄 없는 비목은 빈 칸(0이 아니다 — 절대 규칙 5). 학생인건비(3행)는 줄이 없다
    expect(ws.getCell('B3').value).toBeNull();

    // F-2 헤더
    expect(fillOf(ws, 'A1')).toBe('FF1A1A1A');
    expect(ws.getCell('B1').font?.bold).toBe(true);
    expect(ws.getCell('B1').font?.color?.argb).toBe('FFFFFFFF');
    expect(ws.getCell('B1').border?.bottom?.style).toBe('medium');
    // F-3 키 열
    expect(fillOf(ws, 'A2')).toBe('FFF4F1EA');
    // F-4 합계 행 + 데이터 칸 얇은 테두리
    expect(fillOf(ws, 'B14')).toBe('FFF7F7F7');
    expect(ws.getCell('B14').font?.bold).toBe(true);
    expect(ws.getCell('B14').border?.top?.style).toBe('medium');
    expect(ws.getCell('B2').border?.left).toMatchObject({ style: 'thin', color: { argb: 'FFDCDCDC' } });
    // F-6 금액 서식(데이터·수식·합계 칸)
    for (const address of ['B2', 'D2', 'J14']) expect(ws.getCell(address).numFmt).toBe('#,##0');
    // F-5 틀 고정
    expect(ws.views[0]).toMatchObject({ state: 'frozen', ySplit: 1, topLeftCell: 'A2' });
    // F-10 모든 시트 탭 색
    for (const sheet of wb.worksheets) expect(sheet.properties.tabColor).toEqual({ argb: 'FF1A1A1A' });

    // F-8 작성안내: 제목·부제·데이터 출처(버전·상태)·원 단위
    const guide = wb.getWorksheet('작성안내')!;
    expect(guide.getCell('A1').value).toBe(`${PROJECT_NAME} — 협약 예산 비목별`);
    expect(String(guide.getCell('A2').value)).toContain('최종협약본');
    expect(guide.getCell('A4').value).toBe('목적');
    const guideText = guide.getSheetValues().flat().map(String).join('\n');
    expect(guideText).toMatch(/최종협약본 '최종협약본' · 확정 \d{4}-\d{2}-\d{2} · 순번 1/);
    expect(guideText).toContain('원 단위');
    expect(guideText).not.toContain('작성 중 버전입니다');
  });

  it('작성 중 버전도 내려받는다 — 총계는 S-20 B 값, 작성안내에 작성 중 경고', async () => {
    const data = unwrap(await buildAgreementWorkbook(f.projectId, { view: 'category', versionId: versionB }));
    expect(data.fileName).toBe(`${PROJECT_NAME}_협약예산_협약변경 1차_${yyyymmdd()}.xlsx`);
    const loaded = await load(data.contentBase64);
    const wb = loaded.wb;
    const ws = wb.getWorksheet('비목별')!;
    expect(formulaCell(loaded, ws, 'D14')).toEqual({ formula: 'SUM(D2:D13)', result: 49_700_000 });
    expect(formulaCell(loaded, ws, 'G14')).toEqual({ formula: 'SUM(G2:G13)', result: 55_400_000 });
    expect(formulaCell(loaded, ws, 'J14')).toEqual({ formula: 'SUM(J2:J13)', result: 105_100_000 });
    const guideText = wb.getWorksheet('작성안내')!.getSheetValues().flat().map(String).join('\n');
    expect(guideText).toContain('작성 중 버전입니다');
  });
});

// ─── 변경 이력 ────────────────────────────────────────────────────────────────

describe('변경 이력 보기 내려받기', () => {
  it('A → B: 시트 4개, 칸 값 = TSV, 증감 = B−A 수식 + 결과, RL-23 기준 = base(B) = A', async () => {
    const data = unwrap(
      await buildAgreementWorkbook(f.projectId, { view: 'changes', fromVersionId: versionA, toVersionId: versionB })
    );
    expect(data.fileName).toBe(`${PROJECT_NAME}_협약예산_최종협약본→협약변경 1차_${yyyymmdd()}.xlsx`);
    const loaded = await load(data.contentBase64);
    const wb = loaded.wb;
    expect(wb.worksheets.map((w) => w.name)).toEqual(['작성안내', '금액 증감', '참여인원 증감', '세목 총액 보존']);
    for (const sheet of wb.worksheets) expect(sheet.properties.tabColor).toEqual({ argb: 'FF1A1A1A' });

    const expected = await expectedChangesTables(versionA, versionB, versionA);
    const lineWs = wb.getWorksheet('금액 증감')!;
    const partWs = wb.getWorksheet('참여인원 증감')!;
    const presWs = wb.getWorksheet('세목 총액 보존')!;
    expectSheetEqualsTsv(loaded, '금액 증감', expected.line);
    expectSheetEqualsTsv(loaded, '참여인원 증감', expected.participant);
    expectSheetEqualsTsv(loaded, '세목 총액 보존', expected.preservation);

    // 금액 증감: 줄 14개 + 소계 2 + 총계 1 → 헤더 포함 18행. 총계 행 = 18행, 순증감 −100,000
    expect(lineWs.actualRowCount).toBe(18);
    expect(lineWs.getCell('A18').value).toBe('총계');
    expect((lineWs.getCell('F18').value as ExcelJS.CellFormulaValue).result).toBe(105_200_000);
    expect((lineWs.getCell('G18').value as ExcelJS.CellFormulaValue).result).toBe(105_100_000);
    expect(formulaCell(loaded, lineWs, 'H18')).toEqual({ formula: 'G18-F18', result: -100_000 });
    expect(fillOf(lineWs, 'H18')).toBe('FFF7F7F7');
    expect(lineWs.getCell('H18').numFmt).toBe('#,##0');
    expect(lineWs.views[0]).toMatchObject({ state: 'frozen', ySplit: 1, topLeftCell: 'A2' });
    expect(fillOf(lineWs, 'A1')).toBe('FF1A1A1A');
    // 줄마다 증감 칸은 같은 행의 이후 − 이전 수식
    expect((lineWs.getCell('H2').value as ExcelJS.CellFormulaValue).formula).toBe('G2-F2');

    // 참여인원 증감: 그룹 5개 + 총계. 현물 증감 +2,500,000, 현금 증감 +5,000,000(인력 미지정 추가)
    expect(partWs.actualRowCount).toBe(7);
    expect(formulaCell(loaded, partWs, 'H7')).toEqual({ formula: 'G7-F7', result: 5_000_000 });
    expect(formulaCell(loaded, partWs, 'K7')).toEqual({ formula: 'J7-I7', result: 2_500_000 });

    // 세목 총액 보존: 총계 행 판정 칸 "차이 3건"
    const presRows = presWs.actualRowCount;
    expect(presWs.getCell(`D${presRows}`).value).toBe('차이 3건');
    expect(formulaCell(loaded, presWs, `G${presRows}`)).toEqual({ formula: `F${presRows}-E${presRows}`,
      result: -100_000,
    });

    const guide = wb.getWorksheet('작성안내')!;
    expect(guide.getCell('A1').value).toBe(`${PROJECT_NAME} — 협약 예산 변경 이력`);
    expect(String(guide.getCell('A2').value)).toContain('최종협약본 → 협약변경 1차');
    const guideText = guide.getSheetValues().flat().map(String).join('\n');
    expect(guideText).toContain('이전(A)');
    expect(guideText).toContain('이후(B)');
    expect(guideText).toContain("기준 버전 '최종협약본'");
    expect(guideText).toContain('저장·확정을 막지 않습니다');
    expect(guideText).toContain('원 단위');
    expect(guideText).toContain('작성 중 버전입니다');
  });

  it('B → A: 이후 버전(A)보다 앞선 확정 버전이 없으면 세목 총액 보존은 "기준 버전 없음"', async () => {
    const data = unwrap(
      await buildAgreementWorkbook(f.projectId, { view: 'changes', fromVersionId: versionB, toVersionId: versionA })
    );
    const loaded = await load(data.contentBase64);
    const wb = loaded.wb;
    const expected = await expectedChangesTables(versionB, versionA, null);
    const presWs = wb.getWorksheet('세목 총액 보존')!;
    expectSheetEqualsTsv(loaded, '세목 총액 보존', expected.preservation);
    expect(presWs.getCell('A2').value).toBe(PRESERVATION_NO_BASE_TEXT);
    expectSheetEqualsTsv(loaded, '금액 증감', expected.line);
    const guideText = wb.getWorksheet('작성안내')!.getSheetValues().flat().map(String).join('\n');
    expect(guideText).toContain('기준 버전이 없습니다');
  });

  it('같은 버전끼리도 내려받는다(전부 불변, 순증감 0)', async () => {
    const data = unwrap(
      await buildAgreementWorkbook(f.projectId, { view: 'changes', fromVersionId: versionA, toVersionId: versionA })
    );
    const loaded = await load(data.contentBase64);
    const wb = loaded.wb;
    const lineWs = wb.getWorksheet('금액 증감')!;
    const last = lineWs.actualRowCount;
    expect(formulaCell(loaded, lineWs, `H${last}`)).toEqual({ formula: `G${last}-F${last}`, result: 0 });
  });
});

// ─── 경계·입력 검증 ───────────────────────────────────────────────────────────

describe('과제 경계·입력 검증', () => {
  it('다른 과제의 버전 id는 RULE로 거부한다(비목별·변경 이력 양쪽)', async () => {
    const category = expectFailure(
      await buildAgreementWorkbook(f.projectId, { view: 'category', versionId: otherVersion })
    );
    expect(category.code).toBe('RULE');
    expect(category.error).toContain('이 과제에 속하지 않은');
    for (const pair of [
      { fromVersionId: otherVersion, toVersionId: versionB },
      { fromVersionId: versionA, toVersionId: otherVersion },
    ]) {
      const changes = expectFailure(await buildAgreementWorkbook(f.projectId, { view: 'changes', ...pair }));
      expect(changes.code).toBe('RULE');
    }
  });

  it('형식이 틀린 입력은 VALIDATION', async () => {
    expect(expectFailure(await buildAgreementWorkbook('not-a-uuid', { view: 'category', versionId: versionA })).code).toBe(
      'VALIDATION'
    );
    expect(expectFailure(await buildAgreementWorkbook(f.projectId, { view: 'category', versionId: 'x' })).code).toBe(
      'VALIDATION'
    );
    const unknownView = { view: 'participants', versionId: versionA } as unknown as { view: 'category'; versionId: string };
    expect(expectFailure(await buildAgreementWorkbook(f.projectId, unknownView)).code).toBe('VALIDATION');
    const missingTo = { view: 'changes', fromVersionId: versionA } as unknown as {
      view: 'changes';
      fromVersionId: string;
      toVersionId: string;
    };
    expect(expectFailure(await buildAgreementWorkbook(f.projectId, missingTo)).code).toBe('VALIDATION');
  });

  it('리포지토리의 일반 Error는 일반 문구로 감춘다 — [db]·테이블 이름이 사용자에게 가지 않는다(SA-4)', async () => {
    repoFault.message = '[db] PGRST205: Could not find the table public.agreement_lines in the schema cache';
    try {
      for (const request of [
        { view: 'category' as const, versionId: versionA },
        { view: 'changes' as const, fromVersionId: versionA, toVersionId: versionB },
      ]) {
        const failure = expectFailure(await buildAgreementWorkbook(f.projectId, request));
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
