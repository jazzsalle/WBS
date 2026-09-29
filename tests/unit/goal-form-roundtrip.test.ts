// 목표 양식 왕복 (SOT §6.17 GF-1~GF-10, 부록 F-6·F-9, §11 Phase 21 완료 기준)
//
// `buildGoalForm` → `writeInputFormWorkbook`(exceljs, 실제 xlsx 바이트) → `readUploadedWorkbook`(올리기 경로 그대로 —
// SheetJS, cellDates:false·cellFormula:false) → `parseGoalForm` → `previewGoalForm` → `buildGoalFormCommit`을 한 번에
// 잇는다. 모듈별 단위 테스트는 따로 있고, 여기서는 **파일 경계를 넘을 때** 값이 살아 있는가를 본다 — 날짜는 exceljs가
// 날짜 셀로 쓰고 SheetJS가 직렬값으로 읽고, 수식 셀은 캐시값이 없어 레코드째 빠지고, 빈 연차 칸과 0은 달라야 한다.
//
// 사용자 편집은 **exceljs로 파일을 다시 열어 셀을 바꾸고 다시 저장**해 흉내 낸다(엑셀에서 고친 뒤 저장한 파일과 같은
// 경로). 수식·유효성·서식 확인도 exceljs 재로드로 한다 — SheetJS는 캐시값 없는 수식 셀을 버린다(PROGRESS 함정).

import { beforeAll, describe, expect, it } from 'vitest';
import ExcelJS from 'exceljs';
import { buildGoalForm } from '@/lib/goal-form/build';
import type { GoalFormData } from '@/lib/goal-form/build';
import {
  GOAL_EMPTY_INPUT_ROWS,
  GOAL_TOTAL_MARKER,
  goalColumnOf,
  goalSheetsFor,
  goalYearColumns,
} from '@/lib/goal-form/layout';
import type { GoalFormSheets, GoalSheetDef } from '@/lib/goal-form/layout';
import { parseGoalForm } from '@/lib/goal-form/parse';
import type { GoalFormRows, ParseGoalFormResult } from '@/lib/goal-form/parse';
import { buildGoalFormCommit, previewGoalForm } from '@/lib/goal-form/preview';
import type { GoalFormPreview, GoalFormPreviewOptions } from '@/lib/goal-form/preview';
import type { GoalFormMeta } from '@/lib/goal-form/types';
import { buildInputForm } from '@/lib/input-form';
import { writeInputFormWorkbook } from '@/lib/input-form-adapter';
import { readUploadedWorkbook } from '@/lib/import-adapter';
import { excelSerialToISO } from '@/lib/input-form/sheet-date';
import type { RawSheet } from '@/lib/import/types';
import type { Deliverable, DeliverableAchievement, TechTarget, TechTargetRecord } from '@/types';

// ─── 픽스처 ──────────────────────────────────────────────────
// 연차 3(셋째는 이름이 비어 `3차년도`) · 기관 2(동명 → `한국대학교 (2)`) · 인력 3(동명 2 → `홍길동 (2)`)
// 성과목표 2(연차 목표 빈 키 vs 0) · 실적 3(관여자 3명·동명 포함) · 기술목표 3방향(baseline null 포함) · 측정 3

const PROJECT_ID = 'proj-1';
const GENERATED_AT = '2026-09-29T09:00:00.000Z';
const YEAR_LABELS = ['1차년도', '2차년도', '3차년도'];
const DEFS: GoalFormSheets = goalSheetsFor(YEAR_LABELS);

const ENTITY = {
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
  createdBy: null,
  updatedBy: null,
};

function achievement(id: string, over: Partial<DeliverableAchievement> = {}): DeliverableAchievement {
  return {
    id,
    version: 1,
    title: `산출물 ${id}`,
    date: '2026-03-02',
    yearId: 'y-1',
    orgId: 'o-1',
    memberIds: [],
    evidenceUrl: '',
    note: '',
    ...over,
  };
}

function record(id: string, over: Partial<TechTargetRecord> = {}): TechTargetRecord {
  return {
    id,
    version: 1,
    value: 80,
    date: '2026-06-30',
    yearId: 'y-1',
    method: 'self',
    evaluator: '',
    evidenceUrl: '',
    note: '',
    ...over,
  };
}

function techTarget(over: Partial<TechTarget> & Pick<TechTarget, 'id' | 'name' | 'direction'>): TechTarget {
  return {
    ...ENTITY,
    version: 1,
    projectId: PROJECT_ID,
    group: '',
    unit: '',
    weight: 0,
    targetValue: 0,
    targetByYear: {},
    baselineDomestic: null,
    worldBest: null,
    worldBestHolder: '',
    measureMethod: 'self',
    measureDescription: '',
    standardBasis: '',
    basisRationale: '',
    evaluationEnvironment: '',
    note: '',
    records: [],
    orgId: null,
    order: 0,
    ...over,
  };
}

function currentData(): { deliverables: Deliverable[]; techTargets: TechTarget[] } {
  return {
    deliverables: [
      {
        ...ENTITY,
        id: 'd-1',
        version: 3,
        projectId: PROJECT_ID,
        type: 'paper_sci',
        name: '논문 게재',
        unit: '편',
        weight: 60,
        targetTotal: 1,
        // y-2 = 0(목표 0)과 y-3 없음(목표 없음)은 다르다 — 왕복 뒤에도 달라야 한다(D-5)
        targetByYear: { 'y-1': 1, 'y-2': 0 },
        achievements: [
          achievement('a-1', {
            version: 2,
            title: '딥러닝 기반 균열 탐지',
            orgId: 'o-2',
            // 동명 인력 둘 다 — `홍길동;홍길동 (2);김철수`로 쓰이고 읽혀야 한다
            memberIds: ['m-1', 'm-2', 'm-3'],
            evidenceUrl: 'https://doi.org/10.1000/xyz',
            note: '1저자',
          }),
          achievement('a-2', { date: '2027-01-31', yearId: 'y-2', orgId: null, memberIds: ['m-2'] }),
        ],
        orgId: 'o-1',
        evidenceMethod: '게재 증빙',
        note: '',
        order: 0,
      },
      {
        ...ENTITY,
        id: 'd-2',
        version: 1,
        projectId: PROJECT_ID,
        type: 'patent_dom_apply',
        name: '특허 출원',
        unit: '건',
        weight: 40,
        targetTotal: 3,
        targetByYear: { 'y-1': 1, 'y-2': 1, 'y-3': 1 },
        achievements: [achievement('a-3', { title: '균열 탐지 장치', date: '2026-08-15', orgId: 'o-2' })],
        orgId: 'o-2',
        evidenceMethod: '',
        note: '비고 메모',
        order: 1,
      },
    ],
    techTargets: [
      techTarget({
        id: 't-1',
        version: 2,
        name: '정확도',
        group: '성능',
        unit: '%',
        direction: 'higher_better',
        weight: 50,
        targetValue: 95,
        targetByYear: { 'y-1': 80, 'y-2': 90, 'y-3': 95 },
        baselineDomestic: 70,
        worldBest: 97.5,
        worldBestHolder: '미국 MIT',
        measureMethod: 'certified_lab',
        measureDescription: '표준 데이터셋 1,000장',
        standardBasis: 'KS X 0000',
        basisRationale: '선행연구 대비',
        evaluationEnvironment: '실내',
        records: [
          record('r-1', { value: 82.5, date: '2026-06-30', method: 'certified_lab', evaluator: 'KTL' }),
          record('r-2', { value: 88, date: '2027-06-30', yearId: 'y-2' }),
        ],
        orgId: 'o-1',
        order: 0,
      }),
      techTarget({
        id: 't-2',
        name: '응답 시간',
        group: '성능',
        unit: 'ms',
        direction: 'lower_better',
        weight: 30,
        targetValue: 100,
        targetByYear: { 'y-2': 150, 'y-3': 100 },
        baselineDomestic: null,
        worldBest: 80,
        records: [record('r-3', { value: 140, date: '2027-05-01', yearId: 'y-2', method: 'expert_review' })],
        orgId: 'o-2',
        order: 1,
      }),
      techTarget({
        id: 't-3',
        name: '출력 전압',
        group: '품질',
        unit: 'V',
        direction: 'target_exact',
        weight: 20,
        targetValue: 5,
        targetByYear: { 'y-1': 5 },
        measureMethod: 'expert_review',
        order: 2,
      }),
    ],
  };
}

function formData(): GoalFormData {
  const current = currentData();
  return {
    project: { id: PROJECT_ID, name: '스마트 건설 플랫폼' },
    years: [
      { id: 'y-3', name: '', order: 2 },
      { id: 'y-1', name: '1차년도', order: 0 },
      { id: 'y-2', name: '2차년도', order: 1 },
    ],
    orgs: [
      { id: 'o-1', name: '한국대학교' },
      { id: 'o-2', name: '한국대학교' },
    ],
    members: [
      { id: 'm-1', name: '홍길동' },
      { id: 'm-2', name: '홍길동' },
      { id: 'm-3', name: '김철수' },
    ],
    deliverables: current.deliverables,
    techTargets: current.techTargets,
    generatedAt: GENERATED_AT,
  };
}

const LINKED = { deliverable: { 'd-1': 2, 'd-2': 1 }, techTarget: { 't-1': 1 } };

// ─── 파일 경로 헬퍼 ──────────────────────────────────────────

let goalBytes: Buffer;
let inputFormBytes: Buffer;

beforeAll(async () => {
  goalBytes = await writeInputFormWorkbook(buildGoalForm(formData()));
  inputFormBytes = await writeInputFormWorkbook(
    buildInputForm(
      {
        project: { id: PROJECT_ID, name: '스마트 건설 플랫폼' },
        year: { id: 'y-1', name: '1차년도', startDate: '2026-01-01', endDate: '2026-12-31', order: 0 },
        members: [],
        details: [],
      },
      '2026-09-29'
    )
  );
});

/** 올리기 경로 그대로(FormData → SheetJS). 호출마다 새 배열이다 */
async function upload(bytes: Buffer, fileName = 'goal.xlsx'): Promise<RawSheet[]> {
  const fd = new FormData();
  fd.append('file', new File([new Uint8Array(bytes)], fileName));
  return (await readUploadedWorkbook(fd)).sheets;
}

/** 파일을 exceljs로 다시 열어 고치고 저장한다 — 엑셀에서 고쳐 저장한 파일과 같은 경로 */
async function editFile(bytes: Buffer, edit: (wb: ExcelJS.Workbook) => void): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(bytes as unknown as ArrayBuffer);
  edit(wb);
  return Buffer.from(await wb.xlsx.writeBuffer());
}

async function loadExcel(bytes: Buffer): Promise<ExcelJS.Workbook> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(bytes as unknown as ArrayBuffer);
  return wb;
}

type DataKey = 'deliverables' | 'achievements' | 'techTargets' | 'records';

function ws(wb: ExcelJS.Workbook, key: DataKey | 'lists' | 'meta'): ExcelJS.Worksheet {
  const found = wb.getWorksheet(DEFS[key].name);
  if (!found) throw new Error(`${DEFS[key].name} 시트가 없다`);
  return found;
}

/** 역할 → 1-based 열 */
function col(key: DataKey, role: string): number {
  return goalColumnOf(DEFS[key] as GoalSheetDef, role) + 1;
}

/** 숨김 id(첫 숨김 열 기준 역할)로 1-based 행 번호 */
function rowOf(sheet: ExcelJS.Worksheet, idColumn: number, id: string): number {
  for (let r = 1; r <= sheet.rowCount; r += 1) {
    if (sheet.getCell(r, idColumn).value === id) return r;
  }
  throw new Error(`${sheet.name} 시트에 ${id} 행이 없다`);
}

/** 첫 빈 입력 행(1-based) — 기존 행 바로 아래 */
function firstEmptyRow(key: DataKey, existing: number): number {
  return DEFS[key].dataStartRow + existing;
}

function setCells(sheet: ExcelJS.Worksheet, row: number, key: DataKey, values: Record<string, ExcelJS.CellValue>): void {
  for (const [role, value] of Object.entries(values)) sheet.getCell(row, col(key, role)).value = value;
}

function clearRow(sheet: ExcelJS.Worksheet, row: number, key: DataKey): void {
  DEFS[key].columns.forEach((_, i) => {
    sheet.getCell(row, i + 1).value = null;
  });
}

function parsed(sheets: RawSheet[], projectId = PROJECT_ID): ParseGoalFormResult {
  return parseGoalForm(sheets, { projectId });
}

function parseOk(sheets: RawSheet[]): { meta: GoalFormMeta; rows: GoalFormRows } {
  const result = parsed(sheets);
  if (!result.ok) throw new Error(`거부됨: ${result.rejection.kind}`);
  return { meta: result.meta, rows: result.rows };
}

async function previewOf(bytes: Buffer, options?: GoalFormPreviewOptions): Promise<GoalFormPreview> {
  const { meta, rows } = parseOk(await upload(bytes));
  return previewGoalForm({ meta, rows, current: currentData(), linkedTaskCounts: LINKED, options });
}

function statuses(p: GoalFormPreview): string[] {
  return [...p.rows.deliverables, ...p.rows.achievements, ...p.rows.techTargets, ...p.rows.records].map(
    (r) => `${r.id ?? `new@${r.sheetRow}`}:${r.status}`
  );
}

function allIssueKinds(p: GoalFormPreview): string[] {
  return [...p.rows.deliverables, ...p.rows.achievements, ...p.rows.techTargets, ...p.rows.records].flatMap((r) =>
    r.issues.map((i) => i.kind)
  );
}

function excelSerial(iso: string): number {
  const [y, m, d] = iso.split('-').map(Number) as [number, number, number];
  return (Date.UTC(y, m - 1, d) - Date.UTC(1899, 11, 30)) / 86_400_000;
}

// ─── 그대로 올리기 ───────────────────────────────────────────

describe('목표 양식 왕복 — 그대로 올리기', () => {
  it('전 행 unchanged, 삭제 후보 0, 사유·경고 0, blocked false, 페이로드 빈 채', async () => {
    const p = await previewOf(goalBytes);
    expect(statuses(p)).toEqual([
      'd-1:unchanged',
      'd-2:unchanged',
      'a-1:unchanged',
      'a-2:unchanged',
      'a-3:unchanged',
      't-1:unchanged',
      't-2:unchanged',
      't-3:unchanged',
      'r-1:unchanged',
      'r-2:unchanged',
      'r-3:unchanged',
    ]);
    expect(allIssueKinds(p)).toEqual([]);
    expect(p.issues).toEqual([]);
    expect(p.deleteCandidates).toEqual([]);
    expect(p.conflicts).toEqual([]);
    expect(p.blocked).toBe(false);

    const { payload, expected } = buildGoalFormCommit(p);
    for (const block of Object.values(payload)) expect(block).toEqual({ adds: [], updates: [], deleteIds: [] });
    expect(expected).toEqual({});
  });

  it('파싱 값이 경계를 넘어 살아 있다 — 빈 연차 vs 0, baseline null, 날짜 하루 밀림 없음, 동명 라벨', async () => {
    const { meta, rows } = parseOk(await upload(goalBytes));
    expect(meta.years.map((y) => y.id)).toEqual(['y-1', 'y-2', 'y-3']);
    expect(meta.years.map((y) => y.label)).toEqual(YEAR_LABELS);
    expect(meta.orgs.map((o) => o.label)).toEqual(['한국대학교', '한국대학교 (2)']);
    expect(meta.members.map((m) => m.label)).toEqual(['홍길동', '홍길동 (2)', '김철수']);
    expect(meta.deliverables).toEqual({ 'd-1': 3, 'd-2': 1 });
    expect(meta.achievements).toEqual({ 'a-1': 2, 'a-2': 1, 'a-3': 1 });

    const d1 = rows.deliverables[0];
    expect(d1?.targetByYear).toEqual({ 'y-1': 1, 'y-2': 0, 'y-3': null });
    expect(d1?.weight).toBe(60);

    const a1 = rows.achievements.find((a) => a.id === 'a-1');
    expect(a1?.memberIds).toEqual(['m-1', 'm-2', 'm-3']);
    expect(a1?.orgId).toBe('o-2');
    expect(a1?.date).toBe('2026-03-02');
    expect(a1?.parent).toEqual({ kind: 'existing', id: 'd-1' });
    expect(rows.achievements.find((a) => a.id === 'a-2')?.date).toBe('2027-01-31');

    const [t1, t2, t3] = rows.techTargets;
    expect(t1?.direction).toBe('higher_better');
    expect(t1?.worldBest).toBe(97.5);
    expect(t2?.direction).toBe('lower_better');
    expect(t2?.baselineDomestic).toBeNull();
    expect(t2?.targetByYear).toEqual({ 'y-1': null, 'y-2': 150, 'y-3': 100 });
    expect(t3?.direction).toBe('target_exact');
    expect(t3?.worldBest).toBeNull();
    expect(rows.records.find((r) => r.id === 'r-1')?.value).toBe(82.5);
    expect(rows.records.find((r) => r.id === 'r-3')?.method).toBe('expert_review');
  });

  it("'#total' 합계 행은 파일에 있지만 행 모델에 없다", async () => {
    const sheets = await upload(goalBytes);
    const { rows } = parseOk(sheets);
    for (const key of ['deliverables', 'techTargets', 'achievements', 'records'] as const) {
      const sheet = sheets.find((s) => s.name === DEFS[key].name);
      const totalIndex = sheet?.cells.findIndex((row) => row[0]?.value === GOAL_TOTAL_MARKER) ?? -1;
      expect(totalIndex, `${DEFS[key].name} 합계 행`).toBeGreaterThan(0);
      expect(rows[key].map((r) => r.sheetRow)).not.toContain(totalIndex + 1);
    }
  });
});

// ─── 이름 수정 · 추가 · 삭제 ─────────────────────────────────

describe('목표 양식 왕복 — 편집', () => {
  it('실적 딸린 지표 이름만 수정 → 같은 id update, 실적은 unchanged·parent-moved 없음(§11)', async () => {
    const bytes = await editFile(goalBytes, (wb) => {
      const sheet = ws(wb, 'deliverables');
      sheet.getCell(rowOf(sheet, col('deliverables', 'deliverableId'), 'd-1'), col('deliverables', 'name')).value =
        'SCI 논문 게재';
      const t = ws(wb, 'techTargets');
      t.getCell(rowOf(t, col('techTargets', 'techTargetId'), 't-1'), col('techTargets', 'name')).value = '인식 정확도';
    });
    const p = await previewOf(bytes);
    const d1 = p.rows.deliverables.find((r) => r.id === 'd-1');
    expect(d1?.status).toBe('update');
    expect(d1?.changedFields).toEqual(['name']);
    expect(p.rows.techTargets.find((r) => r.id === 't-1')?.changedFields).toEqual(['name']);
    expect(p.rows.achievements.map((r) => r.status)).toEqual(['unchanged', 'unchanged', 'unchanged']);
    expect(p.rows.records.map((r) => r.status)).toEqual(['unchanged', 'unchanged', 'unchanged']);
    expect(allIssueKinds(p)).not.toContain('parent-moved');
    expect(p.blocked).toBe(false);

    const { payload, expected } = buildGoalFormCommit(p);
    expect(payload.deliverables.updates.map((u) => [u.id, u.name])).toEqual([['d-1', 'SCI 논문 게재']]);
    expect(payload.deliverables.adds).toEqual([]);
    expect(payload.techTargets.updates.map((u) => [u.id, u.name])).toEqual([['t-1', '인식 정확도']]);
    expect(payload.achievements.updates).toEqual([]);
    expect(expected).toEqual({ 'd-1': 3, 't-1': 2 });
  });

  it('새 지표 + 그 지표의 새 실적(빈 입력 행) → add, row_key·deliverable_ref 일치(GF-10)', async () => {
    const dRow = firstEmptyRow('deliverables', 2);
    const aRow = firstEmptyRow('achievements', 3);
    const tRow = firstEmptyRow('techTargets', 3);
    const rRow = firstEmptyRow('records', 3);
    const bytes = await editFile(goalBytes, (wb) => {
      setCells(ws(wb, 'deliverables'), dRow, 'deliverables', { type: '국내 특허 등록', name: '특허 등록', weight: 0 });
      const d = ws(wb, 'deliverables');
      d.getCell(dRow, goalYearColumns(DEFS.deliverables as GoalSheetDef)[2] as number + 1).value = 2;
      setCells(ws(wb, 'achievements'), aRow, 'achievements', {
        deliverableName: '특허 등록',
        title: '균열 탐지 방법',
        date: new Date(Date.UTC(2028, 1, 10)),
        year: '3차년도',
        org: '한국대학교 (2)',
        members: '홍길동 (2); 김철수',
      });
      setCells(ws(wb, 'techTargets'), tRow, 'techTargets', {
        name: '처리 속도',
        unit: 'fps',
        direction: '높을수록 우수',
      });
      const t = ws(wb, 'techTargets');
      t.getCell(tRow, goalYearColumns(DEFS.techTargets as GoalSheetDef)[1] as number + 1).value = 30;
      // 기존 기술목표에 새 측정 — 이름으로 기존 부모를 찾는다
      setCells(ws(wb, 'records'), rRow, 'records', { techTargetName: '출력 전압', value: 5.1, date: '2026-11-11' });
    });
    const p = await previewOf(bytes);
    expect(p.blocked).toBe(false);
    const newD = p.rows.deliverables.find((r) => r.id === null);
    expect(newD?.status).toBe('add');
    expect(newD?.values).toMatchObject({
      type: 'patent_dom_reg',
      name: '특허 등록',
      targetTotal: 2,
      targetByYear: { 'y-1': null, 'y-2': null, 'y-3': 2 },
    });
    const newA = p.rows.achievements.find((r) => r.id === null);
    expect(newA?.status).toBe('add');
    expect(newA?.values).toMatchObject({
      parent: { kind: 'new', row: dRow },
      date: '2028-02-10',
      yearId: 'y-3',
      orgId: 'o-2',
      memberIds: ['m-2', 'm-3'],
    });
    const newT = p.rows.techTargets.find((r) => r.id === null);
    expect(newT?.values).toMatchObject({ targetValue: 30, measureMethod: 'self', weight: 0 });
    const newR = p.rows.records.find((r) => r.id === null);
    expect(newR?.values).toMatchObject({ parent: { kind: 'existing', id: 't-3' }, method: 'expert_review', date: '2026-11-11' });
    // 기존 행은 그대로
    expect(statuses(p).filter((s) => !s.startsWith('new@'))).toEqual(
      ['d-1', 'd-2', 'a-1', 'a-2', 'a-3', 't-1', 't-2', 't-3', 'r-1', 'r-2', 'r-3'].map((id) => `${id}:unchanged`)
    );

    const { payload } = buildGoalFormCommit(p);
    expect(payload.deliverables.adds).toHaveLength(1);
    const dAdd = payload.deliverables.adds[0];
    expect(dAdd?.row_key).toBe(`row:${dRow}`);
    expect(payload.achievements.adds).toHaveLength(1);
    const aAdd = payload.achievements.adds[0];
    expect(aAdd && 'deliverable_ref' in aAdd ? aAdd.deliverable_ref : undefined).toBe(dAdd?.row_key);
    expect(aAdd?.deliverable_id).toBeUndefined();
    expect(payload.techTargets.adds[0]?.target_by_year).toEqual({ 'y-1': null, 'y-2': 30, 'y-3': null });
    const rAdd = payload.records.adds[0];
    expect(rAdd?.tech_target_id).toBe('t-3');
  });

  it('행 삭제 → 삭제 후보. includeDeletes=false면 deleteIds 없음, true면 있음 + expected에 자식', async () => {
    const bytes = await editFile(goalBytes, (wb) => {
      const d = ws(wb, 'deliverables');
      clearRow(d, rowOf(d, col('deliverables', 'deliverableId'), 'd-2'), 'deliverables');
      // 지운 지표의 실적도 지워야 orphan-child가 아니다
      const a = ws(wb, 'achievements');
      clearRow(a, rowOf(a, col('achievements', 'achievementId'), 'a-3'), 'achievements');
      const r = ws(wb, 'records');
      clearRow(r, rowOf(r, col('records', 'recordId'), 'r-2'), 'records');
    });

    const off = await previewOf(bytes);
    expect(off.blocked).toBe(false);
    expect(off.deleteCandidates.map((c) => [c.kind, c.id])).toEqual(
      expect.arrayContaining([
        ['deliverable', 'd-2'],
        ['achievement', 'a-3'],
        ['record', 'r-2'],
      ])
    );
    expect(off.deleteCandidates).toHaveLength(3);
    const d2 = off.deleteCandidates.find((c) => c.id === 'd-2');
    expect(d2).toMatchObject({ achievementCount: 1, linkedTaskCount: 1, childIds: ['a-3'], conflict: null });
    const offCommit = buildGoalFormCommit(off);
    for (const block of Object.values(offCommit.payload)) expect(block.deleteIds).toEqual([]);
    expect(offCommit.expected).toEqual({});

    const on = await previewOf(bytes, { includeDeletes: true });
    const { payload, expected } = buildGoalFormCommit(on);
    expect(payload.deliverables.deleteIds).toEqual(['d-2']);
    expect(payload.achievements.deleteIds).toEqual(['a-3']);
    expect(payload.records.deleteIds).toEqual(['r-2']);
    expect(expected).toEqual({ 'd-2': 1, 'a-3': 1, 'r-2': 1 });
  });

  it('지표만 지우고 실적을 남기면 orphan-child로 blocked', async () => {
    const bytes = await editFile(goalBytes, (wb) => {
      const d = ws(wb, 'deliverables');
      clearRow(d, rowOf(d, col('deliverables', 'deliverableId'), 'd-2'), 'deliverables');
    });
    const p = await previewOf(bytes);
    expect(p.rows.achievements.find((r) => r.id === 'a-3')?.issues.map((i) => i.kind)).toContain('orphan-child');
    expect(p.blocked).toBe(true);
  });

  it('연차 헤더 텍스트를 바꿔도 파싱 결과가 같다(GF-2)', async () => {
    const baseline = parseOk(await upload(goalBytes));
    const bytes = await editFile(goalBytes, (wb) => {
      for (const key of ['deliverables', 'techTargets'] as const) {
        const sheet = ws(wb, key);
        goalYearColumns(DEFS[key] as GoalSheetDef).forEach((c, i) => {
          sheet.getCell(DEFS[key].headerRow, c + 1).value = `바뀐 헤더 ${3 - i}`;
        });
      }
    });
    const changed = parseOk(await upload(bytes));
    expect(changed).toEqual(baseline);
  });

  it('달성일·측정일이 숫자 직렬값 셀로 와도 ISO로 읽는다', async () => {
    const bytes = await editFile(goalBytes, (wb) => {
      const a = ws(wb, 'achievements');
      const aCell = a.getCell(rowOf(a, col('achievements', 'achievementId'), 'a-1'), col('achievements', 'date'));
      aCell.value = excelSerial('2026-03-15');
      aCell.numFmt = 'General';
      const r = ws(wb, 'records');
      const rCell = r.getCell(rowOf(r, col('records', 'recordId'), 'r-1'), col('records', 'date'));
      rCell.value = excelSerial('2026-06-30');
      rCell.numFmt = 'General';
    });
    const sheets = await upload(bytes);
    // SheetJS가 정말 숫자로 읽었는지부터 — 날짜 문자열로 오면 이 테스트는 아무것도 보지 않는다
    const aSheet = sheets.find((s) => s.name === DEFS.achievements.name) as RawSheet;
    const serialCell = aSheet.cells[DEFS.achievements.dataStartRow - 1]?.[col('achievements', 'date') - 1];
    expect(typeof serialCell?.value).toBe('number');
    expect(excelSerialToISO(serialCell?.value as number)).toBe('2026-03-15');

    const p = await previewOf(bytes);
    const a1 = p.rows.achievements.find((r) => r.id === 'a-1');
    expect(a1?.status).toBe('update');
    expect(a1?.changedFields).toEqual(['date']);
    expect(a1?.values?.date).toBe('2026-03-15');
    expect(p.rows.records.find((r) => r.id === 'r-1')?.status).toBe('unchanged');
  });
});

// ─── _meta 거부 (GF-2) ───────────────────────────────────────

describe('목표 양식 왕복 — _meta 거부', () => {
  function metaRow(sheet: ExcelJS.Worksheet, key: string): number {
    for (let r = 1; r <= sheet.rowCount; r += 1) if (sheet.getCell(r, 1).value === key) return r;
    throw new Error(`_meta에 ${key} 행이 없다`);
  }

  it('다른 과제 → project-mismatch', async () => {
    const result = parsed(await upload(goalBytes), 'proj-other');
    expect(result.ok ? null : result.rejection.kind).toBe('project-mismatch');

    const edited = await editFile(goalBytes, (wb) => {
      const meta = ws(wb, 'meta');
      meta.getCell(metaRow(meta, 'projectId'), 2).value = 'proj-other';
    });
    const again = parsed(await upload(edited));
    expect(again.ok ? null : again.rejection.kind).toBe('project-mismatch');
  });

  it('formVersion 불일치 → version-mismatch', async () => {
    const edited = await editFile(goalBytes, (wb) => {
      const meta = ws(wb, 'meta');
      meta.getCell(metaRow(meta, 'formVersion'), 2).value = 2;
    });
    const result = parsed(await upload(edited));
    expect(result.ok ? null : result.rejection.kind).toBe('version-mismatch');
  });

  it('_meta 시트 삭제 → not-goal-form', async () => {
    const edited = await editFile(goalBytes, (wb) => {
      wb.removeWorksheet(ws(wb, 'meta').id);
    });
    const sheets = await upload(edited);
    expect(sheets.map((s) => s.name)).not.toContain(DEFS.meta.name);
    const result = parsed(sheets);
    expect(result.ok ? null : result.rejection.kind).toBe('not-goal-form');
  });

  it('입력 양식 파일(buildInputForm 산출물) → not-goal-form', async () => {
    const sheets = await upload(inputFormBytes);
    // 입력 양식에도 `_meta`가 있고 projectId가 같다 — 형식 검사가 먼저여야 막힌다
    expect(sheets.map((s) => s.name)).toContain('_meta');
    const result = parsed(sheets);
    expect(result.ok ? null : result.rejection.kind).toBe('not-goal-form');
  });
});

// ─── 오류 행 → blocked ───────────────────────────────────────

describe('목표 양식 왕복 — 오류 행', () => {
  async function errorPreview(edit: (wb: ExcelJS.Workbook) => void): Promise<GoalFormPreview> {
    return previewOf(await editFile(goalBytes, edit));
  }

  it('모르는 유형 라벨 → unknown-label 오류 행 + blocked', async () => {
    const p = await errorPreview((wb) => {
      const d = ws(wb, 'deliverables');
      d.getCell(rowOf(d, col('deliverables', 'deliverableId'), 'd-1'), col('deliverables', 'type')).value = 'SCI논문';
    });
    const d1 = p.rows.deliverables.find((r) => r.id === 'd-1');
    expect(d1?.status).toBe('error');
    expect(d1?.issues.map((i) => i.kind)).toContain('unknown-label');
    expect(p.blocked).toBe(true);
    expect(() => buildGoalFormCommit(p)).toThrow();
  });

  it('_meta에 없는 기관(동명 라벨 없이 원래 이름 + 공백 변형) → unknown-org + blocked', async () => {
    const p = await errorPreview((wb) => {
      const t = ws(wb, 'techTargets');
      t.getCell(rowOf(t, col('techTargets', 'techTargetId'), 't-2'), col('techTargets', 'org')).value = '한국대학교(2)';
    });
    const t2 = p.rows.techTargets.find((r) => r.id === 't-2');
    expect(t2?.status).toBe('error');
    expect(t2?.issues.map((i) => i.kind)).toContain('unknown-org');
    expect(p.blocked).toBe(true);
  });

  it('_meta에 없는 관여자 → unknown-member + blocked', async () => {
    const p = await errorPreview((wb) => {
      const a = ws(wb, 'achievements');
      a.getCell(rowOf(a, col('achievements', 'achievementId'), 'a-2'), col('achievements', 'members')).value =
        '홍길동 (2);이몽룡';
    });
    expect(p.rows.achievements.find((r) => r.id === 'a-2')?.issues.map((i) => i.kind)).toContain('unknown-member');
    expect(p.blocked).toBe(true);
  });

  it('_meta 밖 숨김 id(다른 양식에서 복사한 행) → unknown-id + blocked', async () => {
    const row = firstEmptyRow('deliverables', 2);
    const p = await errorPreview((wb) => {
      setCells(ws(wb, 'deliverables'), row, 'deliverables', {
        deliverableId: 'd-foreign',
        type: '기술이전',
        name: '기술이전',
        targetTotal: 1,
      });
    });
    const foreign = p.rows.deliverables.find((r) => r.id === 'd-foreign');
    expect(foreign?.issues.map((i) => i.kind)).toContain('unknown-id');
    expect(foreign?.status).toBe('error');
    expect(p.blocked).toBe(true);
  });
});

// ─── 파일 구조 (exceljs 재로드) ──────────────────────────────

describe('목표 양식 파일 구조 — exceljs 재로드', () => {
  let wb: ExcelJS.Workbook;
  beforeAll(async () => {
    wb = await loadExcel(goalBytes);
  });

  it('시트 순서와 숨김: _lists·_meta만 hidden', () => {
    expect(wb.worksheets.map((s) => s.name)).toEqual([
      '작성안내',
      '성과목표',
      '성과실적',
      '기술목표',
      '측정이력',
      '_lists',
      '_meta',
    ]);
    for (const s of wb.worksheets) {
      expect(s.state, s.name).toBe(s.name.startsWith('_') ? 'hidden' : 'visible');
    }
  });

  it("워크북 전 시트 전 셀에 '%'가 든 numFmt가 0개다(F-6·X-7)", () => {
    const offenders: string[] = [];
    let scanned = 0;
    for (const s of wb.worksheets) {
      s.eachRow({ includeEmpty: true }, (row, r) => {
        row.eachCell({ includeEmpty: true }, (cell, c) => {
          scanned += 1;
          if (typeof cell.numFmt === 'string' && cell.numFmt.includes('%')) offenders.push(`${s.name}!${r},${c}`);
        });
      });
    }
    expect(scanned).toBeGreaterThan(100);
    expect(offenders).toEqual([]);
  });

  it('연차 합계는 기존 행·빈 입력 행 모두 f만(캐시값 없음)', () => {
    const sheet = ws(wb, 'deliverables');
    const c = col('deliverables', 'yearTotal');
    const years = goalYearColumns(DEFS.deliverables as GoalSheetDef);
    const first = sheet.getColumn((years[0] as number) + 1).letter;
    const last = sheet.getColumn((years[years.length - 1] as number) + 1).letter;
    const lastDataRow = DEFS.deliverables.dataStartRow + 2 + GOAL_EMPTY_INPUT_ROWS - 1;
    for (let r = DEFS.deliverables.dataStartRow; r <= lastDataRow; r += 1) {
      const cell = sheet.getCell(r, c);
      expect(cell.formula, `${r}행`).toBe(`SUM(${first}${r}:${last}${r})`);
      expect(cell.result, `${r}행 캐시`).toBeUndefined();
    }
  });

  it('가중치·비중 합계 행은 #total 마커 + SUM(데이터 행 전체, 빈 입력 행 포함) f만', () => {
    for (const [key, existing] of [
      ['deliverables', 2],
      ['techTargets', 3],
    ] as const) {
      const sheet = ws(wb, key);
      const lastDataRow = DEFS[key].dataStartRow + existing + GOAL_EMPTY_INPUT_ROWS - 1;
      const totalRow = lastDataRow + 1;
      expect(sheet.getCell(totalRow, 1).value, `${key} 마커`).toBe(GOAL_TOTAL_MARKER);
      const weightCol = col(key, 'weight');
      const letter = sheet.getColumn(weightCol).letter;
      const cell = sheet.getCell(totalRow, weightCol);
      expect(cell.formula, key).toBe(`SUM(${letter}${DEFS[key].dataStartRow}:${letter}${lastDataRow})`);
      expect(cell.result, `${key} 캐시`).toBeUndefined();
    }
  });

  it('관여자·지표명·평가항목 드롭다운은 warning, 나머지 목록은 stop', () => {
    const row = DEFS.achievements.dataStartRow;
    const a = ws(wb, 'achievements');
    expect(a.getCell(row, col('achievements', 'members')).dataValidation?.errorStyle).toBe('warning');
    expect(a.getCell(row, col('achievements', 'deliverableName')).dataValidation?.errorStyle).toBe('warning');
    const yearDv = a.getCell(row, col('achievements', 'year')).dataValidation;
    expect(yearDv?.type).toBe('list');
    expect(yearDv?.errorStyle ?? 'stop').toBe('stop');
    const r = ws(wb, 'records');
    expect(r.getCell(row, col('records', 'techTargetName')).dataValidation?.errorStyle).toBe('warning');
    const methodDv = r.getCell(row, col('records', 'method')).dataValidation;
    expect(methodDv?.type).toBe('list');
    expect(methodDv?.errorStyle ?? 'stop').toBe('stop');
    const d = ws(wb, 'deliverables');
    const typeDv = d.getCell(row, col('deliverables', 'type')).dataValidation;
    expect(typeDv?.type).toBe('list');
    expect(typeDv?.errorStyle ?? 'stop').toBe('stop');
  });

  it('지표명·평가항목 드롭다운은 성과목표·기술목표 시트 이름 열(빈 입력 행 포함)을 직접 참조한다(GF-10)', () => {
    const dName = ws(wb, 'deliverables').getColumn(col('deliverables', 'name')).letter;
    const dLast = DEFS.deliverables.dataStartRow + 2 + GOAL_EMPTY_INPUT_ROWS - 1;
    const tName = ws(wb, 'techTargets').getColumn(col('techTargets', 'name')).letter;
    const tLast = DEFS.techTargets.dataStartRow + 3 + GOAL_EMPTY_INPUT_ROWS - 1;
    // 빈 입력 행의 드롭다운도 같은 범위다 — 새로 적는 실적 행에서도 고를 수 있어야 한다
    for (const r of [DEFS.achievements.dataStartRow, DEFS.achievements.dataStartRow + 3 + GOAL_EMPTY_INPUT_ROWS - 1]) {
      const dv = ws(wb, 'achievements').getCell(r, col('achievements', 'deliverableName')).dataValidation;
      expect(dv?.formulae, `성과실적 ${r}행`).toEqual([`'성과목표'!$${dName}$2:$${dName}$${dLast}`]);
    }
    const rv = ws(wb, 'records').getCell(DEFS.records.dataStartRow, col('records', 'techTargetName')).dataValidation;
    expect(rv?.formulae).toEqual([`'기술목표'!$${tName}$2:$${tName}$${tLast}`]);
  });

  it('_lists에 동명 구분 라벨이 실리고 관여자 드롭다운이 그 범위를 가리킨다', () => {
    const lists = ws(wb, 'lists');
    const values: string[][] = [];
    lists.eachRow((row) => {
      values.push((row.values as ExcelJS.CellValue[]).slice(1).map((v) => (v === null || v === undefined ? '' : String(v))));
    });
    const header = values[0] ?? [];
    const memberCol = header.indexOf('관여자');
    const orgCol = header.indexOf('기관');
    expect(values.slice(1, 4).map((v) => v[memberCol])).toEqual(['홍길동', '홍길동 (2)', '김철수']);
    expect(values.slice(1, 3).map((v) => v[orgCol])).toEqual(['한국대학교', '한국대학교 (2)']);
    const letter = lists.getColumn(memberCol + 1).letter;
    const dv = ws(wb, 'achievements').getCell(DEFS.achievements.dataStartRow, col('achievements', 'members')).dataValidation;
    expect(dv?.formulae).toEqual([`'_lists'!$${letter}$2:$${letter}$4`]);
  });
});
