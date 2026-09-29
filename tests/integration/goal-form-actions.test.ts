// 목표 양식 **액션 계층** 통합 테스트 — 내려받기 → 셀 수정 → 미리보기 → 반영 → DB → 재내려받기
// (SOT §6.17 GF-1~GF-11, §6.2·§6.3, §8.4 O-1, I-17, §11 Phase 21 완료 기준)
//
// tests/unit/goal-form-*.test.ts가 순수 계층(생성기·파서·미리보기)을 고정했다.
// 여기서 보는 것은 **commit_goal_form이 DB에 남기는 것**이다:
//   (a) 받은 파일을 그대로 올리면 전 행 unchanged, 반영은 RPC 없이 RULE (GF-5 투영 비교)
//   (b) §11: 지표 1개·기술목표 1개(연차별 목표)를 추가 → 조회에 나타나고 달성률(§6.2·§6.3)이 기대값.
//       같은 파일의 새 지표에 붙인 새 실적(임시 키 row:n, GF-10), GF-6 `≤10`·`LOD 2.5`
//   (c) 다시 내려받아 이름을 고치면 **같은 id**가 바뀐다(실적 딸린 지표 포함)
//   (d) targetByYear: `_meta` 밖 키 보존, `_meta` 연차가 삭제됐으면 전체 거부 (S-13)
//   (e) 충돌: 내려받은 뒤 updateDeliverable → 그 행만 건너뛴다 (O-1)
//   (f) parent-moved: 파일(미리보기 차단)과 RPC(raise) 둘 다
//   (g) 경계: 다른 과제의 연차·기관·인력·id → RULE, DB 무변경 (N-13)
//   (h) 삭제: 연쇄 삭제, [삭제 포함] 꺼짐, orphan-child, 내려받은 뒤 자식이 붙은 부모 (S-6②)
//   (i) 스냅샷: kind goal_form + goals 키, 목록 Zod, **복원 거부 + DB 무변경**, 20개 창
//   (j) 거부: fileHash 불일치, 입력 양식 파일
//
// 기준값은 **구현이 낸 값이 아니라** DB에 저장된 행과 §6.2·§6.3 식으로 손으로 계산한 값이다.
// 자기가 만든 과제·사용자만 지운다 — 파괴적 테스트가 아니다.

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import * as XLSX from 'xlsx';
import type { Sql } from 'postgres';
import { connectDirectDb, createTestUser, destroyTestUser, type TestUser } from './helpers';
import type { ActionResult } from '@/types';
import { RuleViolationError } from '@/lib/db/errors';
import * as snapshotsRepo from '@/lib/db/import-snapshots';
import type { GoalFormCommitPayload, GoalFormExpected } from '@/lib/db/import-snapshots';
import * as stagesRepo from '@/lib/db/stages';
import * as yearsRepo from '@/lib/db/years';
import {
  GOAL_META_PREFIXES,
  GOAL_TOTAL_MARKER,
  goalColumnOf,
  goalEnumLabel,
  goalSheetsFor,
  goalYearColumns,
  type GoalFormSheets,
  type GoalSheetDef,
} from '@/lib/goal-form/layout';
import { GOAL_FORM_REJECTION_MESSAGES } from '@/lib/goal-form/meta';

const session = vi.hoisted(() => ({ accessToken: '' }));

vi.mock('next/headers', () => ({
  cookies: async () => ({ get: () => ({ value: session.accessToken }) }),
}));
vi.mock('next/cache', () => ({ revalidatePath: () => undefined }));

const { buildGoalForm, commitGoalForm, previewGoalForm } = await import('@/actions/goal-form');
const { buildInputForm } = await import('@/actions/input-form');
const goals = await import('@/actions/goals');
const team = await import('@/actions/team');
const imports = await import('@/actions/import');
const tasks = await import('@/actions/tasks');
const { createProject } = await import('@/actions/projects');
const years = await import('@/actions/years');

let sql: Sql;
let user: TestUser;
const tempProjectIds: string[] = [];

let projectId: string;
let year1Id: string;
let year2Id: string;
let stageId: string;
let orgId: string;
let member1Id: string;
let member2Id: string;

/** 시드 목표 id — 이름 → id */
const ids = new Map<string, string>();

let otherProjectId: string;
let otherYearId: string;
let otherOrgId: string;
let otherMemberId: string;
let otherDeliverableId: string;

// ─── 헬퍼 ─────────────────────────────────────────────────────────────────────

function unwrap<T>(result: ActionResult<T>): T {
  if (!result.ok) throw new Error(`액션 실패: ${result.error} (code=${result.code ?? '-'})`);
  return result.data;
}

function expectFailure<T>(result: ActionResult<T>): { error: string; code?: string } {
  if (result.ok) throw new Error('실패해야 하는 액션이 성공했다');
  return { error: result.error, code: result.code };
}

function idOf(name: string): string {
  const id = ids.get(name);
  if (!id) throw new Error(`시드 '${name}'이 없다`);
  return id;
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

async function download(): Promise<DownloadedForm> {
  const data = unwrap(await buildGoalForm(projectId));
  return { buffer: Buffer.from(data.contentBase64, 'base64'), fileName: data.fileName };
}

/** 미리보기 → 반영. 미리보기의 fileHash를 그대로 쓴다 */
async function previewAndCommit(file: Buffer, fileName: string, includeDeletes = false) {
  const preview = unwrap(await previewGoalForm(projectId, formOf(file, fileName)));
  const committed = await commitGoalForm(projectId, formOf(file, fileName), preview.fileHash, includeDeletes);
  return { preview, committed };
}

// ─── SheetJS 조작 — 받은 파일의 셀을 고쳐 다시 쓴다 ────────────────────────────

type DataKey = 'deliverables' | 'achievements' | 'techTargets' | 'records';

/** 편집 문맥 — 워크북과 그 파일의 연차 수로 만든 좌표 맵(연차 열 수가 과제마다 다르다) */
interface Book {
  wb: XLSX.WorkBook;
  defs: GoalFormSheets;
}

function rewritten(buffer: Buffer, mutate: (book: Book) => void): Buffer {
  const wb = XLSX.read(buffer, { type: 'buffer', cellFormula: true, cellNF: true });
  const yearCount = metaKeys(wb).filter((key) => key.startsWith(GOAL_META_PREFIXES.year)).length;
  mutate({ wb, defs: goalSheetsFor(yearCount) });
  const out: unknown = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
  if (!Buffer.isBuffer(out)) throw new Error('다시 쓴 워크북이 Buffer가 아니다');
  return out;
}

function sheetByName(wb: XLSX.WorkBook, name: string): XLSX.WorkSheet {
  const ws = wb.Sheets[name];
  if (!ws) throw new Error(`시트 '${name}'이 없다`);
  return ws;
}

function metaSheet(wb: XLSX.WorkBook): XLSX.WorkSheet {
  return sheetByName(wb, goalSheetsFor(0).meta.name);
}

function metaKeys(wb: XLSX.WorkBook): string[] {
  const ws = metaSheet(wb);
  const range = XLSX.utils.decode_range(ws['!ref'] ?? 'A1:B1');
  const keys: string[] = [];
  for (let r = 0; r <= range.e.r; r += 1) {
    const v = (ws[XLSX.utils.encode_cell({ r, c: 0 })] as XLSX.CellObject | undefined)?.v;
    if (typeof v === 'string') keys.push(v);
  }
  return keys;
}

/** `_meta`의 키 행 (0-based) */
function metaRowOf(wb: XLSX.WorkBook, key: string): number {
  const ws = metaSheet(wb);
  const range = XLSX.utils.decode_range(ws['!ref'] ?? 'A1:B1');
  for (let r = 0; r <= range.e.r; r += 1) {
    if ((ws[XLSX.utils.encode_cell({ r, c: 0 })] as XLSX.CellObject | undefined)?.v === key) return r;
  }
  throw new Error(`_meta에 '${key}' 행이 없다`);
}

function metaValue(wb: XLSX.WorkBook, key: string): unknown {
  return (metaSheet(wb)[XLSX.utils.encode_cell({ r: metaRowOf(wb, key), c: 1 })] as XLSX.CellObject | undefined)?.v;
}

/** `_meta` 키 행의 키를 바꾼다 — 라벨·version은 그대로 두고 id만 바꿔치기하는 위조 */
function renameMetaKey(wb: XLSX.WorkBook, from: string, to: string): void {
  metaSheet(wb)[XLSX.utils.encode_cell({ r: metaRowOf(wb, from), c: 0 })] = { t: 's', v: to };
}

/** `_meta`에 목록 행을 더한다 — 파서의 경계 검사를 통과시켜 RPC 검증까지 가게 하려는 위조 */
function appendMetaRow(wb: XLSX.WorkBook, key: string, value: string | number): void {
  const ws = metaSheet(wb);
  const range = XLSX.utils.decode_range(ws['!ref'] ?? 'A1:B1');
  const r = range.e.r + 1;
  ws[XLSX.utils.encode_cell({ r, c: 0 })] = { t: 's', v: key };
  ws[XLSX.utils.encode_cell({ r, c: 1 })] = typeof value === 'number' ? { t: 'n', v: value } : { t: 's', v: value };
  range.e.r = r;
  ws['!ref'] = XLSX.utils.encode_range(range);
}

class Sheet {
  readonly ws: XLSX.WorkSheet;
  readonly def: GoalSheetDef;

  constructor(book: Book, key: DataKey) {
    this.def = book.defs[key] as GoalSheetDef;
    this.ws = sheetByName(book.wb, this.def.name);
  }

  private addr(column: number, r0: number): string {
    return XLSX.utils.encode_cell({ r: r0, c: column });
  }

  col(role: string): number {
    return goalColumnOf(this.def, role);
  }

  yearCol(index: number): number {
    const column = goalYearColumns(this.def)[index];
    if (column === undefined) throw new Error(`'${this.def.name}' 시트에 ${index}번째 연차 열이 없다`);
    return column;
  }

  get(column: number, r0: number): unknown {
    return (this.ws[this.addr(column, r0)] as XLSX.CellObject | undefined)?.v;
  }

  set(column: number, r0: number, value: string | number | null): void {
    if (value === null) delete this.ws[this.addr(column, r0)];
    else this.ws[this.addr(column, r0)] = typeof value === 'number' ? { t: 'n', v: value } : { t: 's', v: value };
  }

  setRole(role: string, r0: number, value: string | number | null): void {
    this.set(this.col(role), r0, value);
  }

  /** 헤더 다음 ~ `#total` 직전 (0-based) */
  private dataRows(): number[] {
    const out: number[] = [];
    for (let r = this.def.dataStartRow - 1; ; r += 1) {
      if (this.get(0, r) === GOAL_TOTAL_MARKER) return out;
      if (r > 10_000) throw new Error(`'${this.def.name}' 시트에 합계 행이 없다`);
      out.push(r);
    }
  }

  rowOf(role: string, id: string): number {
    const found = this.dataRows().find((r) => this.get(this.col(role), r) === id);
    if (found === undefined) throw new Error(`'${this.def.name}' 시트에 ${role}=${id} 행이 없다`);
    return found;
  }

  private isEmpty(r0: number): boolean {
    return this.def.columns.every((column, index) => {
      if (!column.read) return true;
      const v = this.get(index, r0);
      return v === undefined || v === null || v === '';
    });
  }

  /** 첫 빈 입력 행 (GF-8) */
  emptyRow(): number {
    const found = this.dataRows().find((r) => this.isEmpty(r));
    if (found === undefined) throw new Error(`'${this.def.name}' 시트에 빈 입력 행이 없다`);
    return found;
  }

  /** 행의 읽는 칸을 전부 지운다 — 사용자가 행을 지운 것과 같다(빈 행은 건너뛴다, GF-9) */
  clear(r0: number): void {
    this.def.columns.forEach((column, index) => {
      if (column.read) delete this.ws[this.addr(index, r0)];
    });
  }
}

// ─── DB 검증 SQL (postgres 직결 — 액션 반환이 아니라 저장된 원본을 본다) ─────────

interface DeliverableRow {
  id: string;
  version: number;
  name: string;
  type: string;
  weight: string;
  target_total: number;
  target_by_year: Record<string, number>;
  evidence_method: string;
  note: string;
  sort_order: number;
}

async function readDeliverables(): Promise<DeliverableRow[]> {
  const rows = await sql`
    select id::text as id, version::int as version, name, type, weight::text as weight, target_total,
           target_by_year, evidence_method, note, sort_order
      from public.deliverables where project_id = ${projectId}::uuid order by sort_order, id`;
  return rows.map((row) => row as unknown as DeliverableRow);
}

interface TechTargetRow {
  id: string;
  version: number;
  name: string;
  direction: string;
  target_value: string;
  target_by_year: Record<string, number>;
  baseline_domestic: string | null;
  group_name: string;
  note: string;
  sort_order: number;
}

async function readTechTargets(): Promise<TechTargetRow[]> {
  const rows = await sql`
    select id::text as id, version::int as version, name, direction, target_value::text as target_value,
           target_by_year, baseline_domestic::text as baseline_domestic, group_name, note, sort_order
      from public.tech_targets where project_id = ${projectId}::uuid order by sort_order, id`;
  return rows.map((row) => row as unknown as TechTargetRow);
}

async function achievementsOf(deliverableId: string): Promise<{ id: string; title: string; year_id: string | null }[]> {
  const rows = await sql`
    select id::text as id, title, year_id::text as year_id
      from public.deliverable_achievements where deliverable_id = ${deliverableId}::uuid order by id`;
  return rows.map((row) => row as unknown as { id: string; title: string; year_id: string | null });
}

async function recordsOf(techTargetId: string): Promise<{ id: string; value: string }[]> {
  const rows = await sql`
    select id::text as id, value::text as value
      from public.tech_target_records where tech_target_id = ${techTargetId}::uuid order by id`;
  return rows.map((row) => row as unknown as { id: string; value: string });
}

/** 과제의 목표 4테이블 + achievement_members + 작업 연계 전부 — "DB 무변경" 비교용 */
async function goalState(pid = projectId): Promise<unknown> {
  const rows = await sql`
    select jsonb_build_object(
      'deliverables', (select coalesce(jsonb_agg(to_jsonb(d) order by d.id), '[]') from public.deliverables d where d.project_id = ${pid}::uuid),
      'achievements', (select coalesce(jsonb_agg(to_jsonb(a) order by a.id), '[]')
                         from public.deliverable_achievements a join public.deliverables d on d.id = a.deliverable_id
                        where d.project_id = ${pid}::uuid),
      'members', (select coalesce(jsonb_agg(to_jsonb(m) order by m.achievement_id, m.member_id), '[]')
                    from public.achievement_members m
                    join public.deliverable_achievements a on a.id = m.achievement_id
                    join public.deliverables d on d.id = a.deliverable_id
                   where d.project_id = ${pid}::uuid),
      'techTargets', (select coalesce(jsonb_agg(to_jsonb(t) order by t.id), '[]') from public.tech_targets t where t.project_id = ${pid}::uuid),
      'records', (select coalesce(jsonb_agg(to_jsonb(r) order by r.id), '[]')
                    from public.tech_target_records r join public.tech_targets t on t.id = r.tech_target_id
                   where t.project_id = ${pid}::uuid),
      'taskDeliverables', (select coalesce(jsonb_agg(to_jsonb(x) order by x.task_id, x.deliverable_id), '[]')
                             from public.task_deliverables x join public.deliverables d on d.id = x.deliverable_id
                            where d.project_id = ${pid}::uuid)
    ) as state`;
  return (rows[0] as { state: unknown }).state;
}

interface GoalSnapshot {
  id: string;
  snapshot: {
    kind?: string;
    items?: unknown[];
    source?: { fileName?: string; sheetName?: string; fileHash?: string };
    goals?: {
      added: Record<string, string[]>;
      before: Record<string, Record<string, unknown>[]>;
      deleted: Record<string, string[]>;
    };
  };
}

async function readGoalSnapshots(): Promise<GoalSnapshot[]> {
  const rows = await sql`
    select id::text as id, snapshot
      from public.import_snapshots
     where project_id = ${projectId}::uuid and snapshot->>'kind' = 'goal_form'
     order by created_at asc, id asc`;
  return rows.map((row) => row as unknown as GoalSnapshot);
}

async function countSnapshots(): Promise<number> {
  const rows = await sql`select count(*)::text as n from public.import_snapshots where project_id = ${projectId}::uuid`;
  return Number((rows[0] as { n: string }).n);
}

const GOAL_TABLE_KEYS = ['deliverables', 'deliverable_achievements', 'tech_targets', 'tech_target_records'] as const;

// ─── 준비·정리 ────────────────────────────────────────────────────────────────

async function newProject(name: string): Promise<string> {
  const project = unwrap(await createProject({ name, contractStartDate: '2026-01-01' }));
  tempProjectIds.push(project.id);
  return project.id;
}

beforeAll(async () => {
  sql = connectDirectDb();
  user = await createTestUser(sql);
  session.accessToken = user.accessToken;

  projectId = await newProject('목표양식 액션 통합');
  const firstYear = (await yearsRepo.listYears(user.client, projectId))[0];
  if (!firstYear) throw new Error('createProject가 연차를 만들지 않았습니다.');
  year1Id = firstYear.id;
  const stage = (await stagesRepo.listStages(user.client, projectId))[0];
  if (!stage) throw new Error('createProject가 단계를 만들지 않았습니다.');
  stageId = stage.id;
  year2Id = unwrap(await years.createYear(stageId, { name: '2차년도' })).id;

  orgId = unwrap(await team.createOrganization(projectId, { name: '주관연구소', role: 'lead' })).id;
  member1Id = unwrap(await team.createMember(projectId, { name: '김연구' })).id;
  member2Id = unwrap(await team.createMember(projectId, { name: '이연구' })).id;

  const d1 = unwrap(
    await goals.createDeliverable(projectId, {
      type: 'paper_sci',
      name: 'SCI 논문',
      targetTotal: 4,
      targetByYear: { [year1Id]: 1, [year2Id]: 3 },
      orgId,
      weight: 60,
      evidenceMethod: '게재 증명',
    })
  );
  ids.set('SCI 논문', d1.id);
  const a1 = unwrap(
    await goals.addAchievement(d1.id, { title: '논문 1호', date: '2026-03-01', yearId: year1Id, memberIds: [member1Id] })
  );
  ids.set('논문 1호', a1.id);
  const d2 = unwrap(
    await goals.createDeliverable(projectId, {
      type: 'patent_dom_apply',
      name: '특허 출원',
      targetTotal: 2,
      targetByYear: { [year1Id]: 1, [year2Id]: 1 },
      weight: 40,
    })
  );
  ids.set('특허 출원', d2.id);

  const t1 = unwrap(
    await goals.createTechTarget(projectId, {
      name: '정확도',
      group: '플랫폼',
      unit: '%',
      direction: 'higher_better',
      weight: 60,
      targetValue: 95,
      targetByYear: { [year1Id]: 90, [year2Id]: 95 },
      baselineDomestic: 80,
    })
  );
  ids.set('정확도', t1.id);
  const r1 = unwrap(await goals.addTechRecord(t1.id, { value: 92, date: '2026-04-01', yearId: year1Id }));
  ids.set('정확도 측정', r1.id);
  const t2 = unwrap(
    await goals.createTechTarget(projectId, {
      name: '응답시간',
      unit: 'ms',
      direction: 'lower_better',
      weight: 40,
      targetValue: 100,
      targetByYear: { [year1Id]: 200, [year2Id]: 100 },
      baselineDomestic: 300,
    })
  );
  ids.set('응답시간', t2.id);

  // 경계 검증용 다른 과제(같은 사용자)
  otherProjectId = await newProject('목표양식 경계 대상');
  const otherYear = (await yearsRepo.listYears(user.client, otherProjectId))[0];
  if (!otherYear) throw new Error('다른 과제에 연차가 없습니다.');
  otherYearId = otherYear.id;
  otherOrgId = unwrap(await team.createOrganization(otherProjectId, { name: '남의 기관', role: 'lead' })).id;
  otherMemberId = unwrap(await team.createMember(otherProjectId, { name: '남의 연구원' })).id;
  otherDeliverableId = unwrap(
    await goals.createDeliverable(otherProjectId, { type: 'other', name: '남의 지표', targetTotal: 1 })
  ).id;
});

afterAll(async () => {
  for (const id of tempProjectIds) {
    await sql`delete from public.projects where id = ${id}::uuid`;
    const rows = await sql`
      select ((select count(*) from public.projects         where id         = ${id}::uuid)
            + (select count(*) from public.deliverables     where project_id = ${id}::uuid)
            + (select count(*) from public.tech_targets     where project_id = ${id}::uuid)
            + (select count(*) from public.import_snapshots where project_id = ${id}::uuid))::text as n`;
    const remaining = Number((rows[0] as { n: string }).n);
    if (remaining !== 0) throw new Error(`테스트가 만든 데이터가 ${remaining}건 남았습니다.`);
  }
  await destroyTestUser(sql, user);
  await sql.end();
});

// ═══ (a) 그대로 올리기 ════════════════════════════════════════════════════════

describe('(a) 받은 목표 양식을 그대로 올리면 전 행 unchanged (GF-5 투영 비교)', () => {
  it("파일명은 '목표양식_'으로 시작한다", async () => {
    const form = await download();
    expect(form.fileName.startsWith('목표양식_')).toBe(true);
  });

  it('unchanged 6 · 추가·변경·충돌·오류·삭제 후보 0 · 차단 없음', async () => {
    const form = await download();
    const result = unwrap(await previewGoalForm(projectId, formOf(form.buffer, form.fileName)));
    expect(result.blockingReason).toBeNull();
    expect(result.preview.blocked).toBe(false);
    expect(result.preview.counts).toMatchObject({ add: 0, update: 0, unchanged: 6, conflict: 0, error: 0, deleteCandidates: 0 });
    expect(result.preview.conflicts).toEqual([]);
  });

  it('그대로 반영하면 반영할 행이 없다는 RULE — RPC를 부르지 않아 스냅샷도 생기지 않는다', async () => {
    const before = await countSnapshots();
    const form = await download();
    const { committed } = await previewAndCommit(form.buffer, form.fileName);
    const failure = expectFailure(committed);
    expect(failure.code).toBe('RULE');
    expect(failure.error).toContain('반영할 목표 행이 없습니다');
    expect(await countSnapshots()).toBe(before);
  });
});

// ═══ (b) §11 완료 기준 — 추가 → 조회·달성률 ═══════════════════════════════════

describe('(b) 지표·기술목표 추가 → 조회에 나타나고 달성률이 맞는다 (§11, GF-6·GF-10)', () => {
  const NEW_D = 'SW 등록';
  const NEW_T = '지연시간';
  const LOD_T = '검출한계';

  it('새 지표 + 그 지표의 새 실적, 새 기술목표(≤20·≤10) + 새 측정, LOD 2.5를 한 파일로 반영한다', async () => {
    const base = await download();
    let year1Label = '';
    const file = rewritten(base.buffer, (book) => {
      year1Label = String(metaValue(book.wb, `${GOAL_META_PREFIXES.year}${year1Id}`));

      const d = new Sheet(book, 'deliverables');
      const dr = d.emptyRow();
      d.setRole('type', dr, goalEnumLabel('deliverableType', 'sw_registration'));
      d.setRole('name', dr, NEW_D);
      d.setRole('weight', dr, 0);
      d.setRole('targetTotal', dr, 2);
      d.set(d.yearCol(0), dr, 1);
      d.set(d.yearCol(1), dr, 1);

      // 같은 파일에서 새로 적은 지표에 붙이는 새 실적 — 이름 열로 연결(GF-10)
      const a = new Sheet(book, 'achievements');
      const ar = a.emptyRow();
      a.setRole('deliverableName', ar, NEW_D);
      a.setRole('title', ar, 'WBS 도구 v1');
      a.setRole('date', ar, '2026-05-02');
      a.setRole('year', ar, year1Label);
      a.setRole('members', ar, '김연구;이연구');

      const t = new Sheet(book, 'techTargets');
      const tr = t.emptyRow();
      t.setRole('group', tr, '플랫폼');
      t.setRole('name', tr, NEW_T);
      t.setRole('unit', tr, 'ms');
      t.setRole('weight', tr, 0);
      t.set(t.yearCol(0), tr, '≤20');
      t.set(t.yearCol(1), tr, '≤10');
      t.setRole('baselineDomestic', tr, 50);
      // 최종 목표 빈 칸 → 값 있는 마지막 연차(GF-7)

      const tr2 = t.emptyRow();
      t.setRole('name', tr2, LOD_T);
      t.setRole('unit', tr2, 'ppm');
      t.setRole('direction', tr2, goalEnumLabel('direction', 'lower_better'));
      t.setRole('targetValue', tr2, 'LOD 2.5');
      t.setRole('baselineDomestic', tr2, 10);

      const r = new Sheet(book, 'records');
      const rr = r.emptyRow();
      r.setRole('techTargetName', rr, NEW_T);
      r.setRole('value', rr, 30);
      r.setRole('date', rr, '2026-06-10');
      r.setRole('year', rr, year1Label);
    });

    const { preview, committed } = await previewAndCommit(file, base.fileName);
    expect(preview.blockingReason).toBeNull();
    expect(preview.preview.counts).toMatchObject({ add: 5, update: 0, unchanged: 6, conflict: 0, error: 0 });
    const outcome = unwrap(committed);
    expect(outcome.deliverables).toEqual({ added: 1, updated: 0, deleted: 0 });
    expect(outcome.achievements).toEqual({ added: 1, updated: 0, deleted: 0 });
    expect(outcome.techTargets).toEqual({ added: 2, updated: 0, deleted: 0 });
    expect(outcome.records).toEqual({ added: 1, updated: 0, deleted: 0 });
    expect(outcome.conflicts).toEqual([]);
    expect(outcome.previewConflicts).toEqual([]);

    // DB: 새 행은 기존 순서 뒤(S-14), 임시 키가 새 부모 id로 풀려 연결됐다(GF-10)
    const ds = await readDeliverables();
    expect(ds.map((d) => d.name)).toEqual(['SCI 논문', '특허 출원', NEW_D]);
    const newD = ds[2] as DeliverableRow;
    ids.set(NEW_D, newD.id);
    expect(newD).toMatchObject({ type: 'sw_registration', target_total: 2, target_by_year: { [year1Id]: 1, [year2Id]: 1 } });
    expect(newD.sort_order).toBeGreaterThan((ds[1] as DeliverableRow).sort_order);
    const newA = await achievementsOf(newD.id);
    expect(newA).toEqual([expect.objectContaining({ title: 'WBS 도구 v1', year_id: year1Id })]);
    const memberRows = await sql`
      select member_id::text as m from public.achievement_members where achievement_id = ${newA[0]!.id}::uuid order by member_id`;
    expect(memberRows.map((row) => (row as { m: string }).m).sort()).toEqual([member1Id, member2Id].sort());

    const ts = await readTechTargets();
    expect(ts.map((t) => t.name)).toEqual(['정확도', '응답시간', NEW_T, LOD_T]);
    const newT = ts[2] as TechTargetRow;
    ids.set(NEW_T, newT.id);
    // GF-6: '≤10' → 10 · lower_better (힌트가 방향 열보다 우선), GF-7: 최종 = 마지막 연차
    expect(newT).toMatchObject({
      direction: 'lower_better',
      target_value: '10',
      target_by_year: { [year1Id]: 20, [year2Id]: 10 },
      baseline_domestic: '50',
      group_name: '플랫폼',
    });
    expect(await recordsOf(newT.id)).toEqual([expect.objectContaining({ value: '30' })]);
    // GF-6: 'LOD 2.5' → 2.5 + 원문 비고
    const lodT = ts[3] as TechTargetRow;
    ids.set(LOD_T, lodT.id);
    expect(lodT.target_value).toBe('2.5');
    expect(lodT.note).toBe('[원문] 최종 목표: LOD 2.5');
  });

  it('getGoalsData에 나타나고 달성률이 §6.2·§6.3 손계산과 같다', async () => {
    const data = unwrap(await goals.getGoalsData(projectId));
    const newD = data.deliverables.find((v) => v.deliverable.id === idOf(NEW_D));
    // D-1: 실적 1 / 목표 2 = 50%, 1차년도: 1 / 1 = 100%
    expect(newD?.rate).toBe(50);
    expect(newD?.byYear[year1Id]?.rate).toBe(100);
    // 과제 전체: (1 + 0 + 1) / (4 + 2 + 2) = 25%
    expect(data.deliverableSummary.rate).toBe(25);

    const newT = data.techTargets.find((v) => v.techTarget.id === idOf(NEW_T));
    // §6.3 lower_better: (기준 50 − 실적 30) / (50 − 목표 10) × 100 = 50
    expect(newT?.current).toBe(30);
    expect(newT?.rate).toBe(50);
    const lod = data.techTargets.find((v) => v.techTarget.id === idOf(LOD_T));
    expect(lod?.techTarget.note).toBe('[원문] 최종 목표: LOD 2.5');
    expect(lod?.rate).toBeNull(); // 미측정
  });

  it('다시 내려받아 그대로 올리면 전 행 unchanged — 원문 비고가 늘지 않는다(GF-6 멱등)', async () => {
    const again = await download();
    const result = unwrap(await previewGoalForm(projectId, formOf(again.buffer, again.fileName)));
    expect(result.preview.counts).toMatchObject({ add: 0, update: 0, unchanged: 11, conflict: 0, error: 0, deleteCandidates: 0 });
  });
});

// ═══ (c) 이름 수정 → 같은 id ═══════════════════════════════════════════════════

describe('(c) 다시 내려받아 이름을 고쳐 올리면 같은 id가 바뀐다 (§11, GF-10)', () => {
  it('실적 딸린 지표·측정 딸린 기술목표의 이름을 고치면 그 행만 update, 자식은 그대로 붙어 있다', async () => {
    const before = await readDeliverables();
    const base = await download();
    const file = rewritten(base.buffer, (book) => {
      const d = new Sheet(book, 'deliverables');
      d.setRole('name', d.rowOf('deliverableId', idOf('SCI 논문')), 'SCI(E) 논문 게재');
      const t = new Sheet(book, 'techTargets');
      t.setRole('name', t.rowOf('techTargetId', idOf('정확도')), '분류 정확도');
      // 실적·측정 시트의 지표명/평가항목 열은 옛 이름 그대로 — 숨김 부모 id를 따른다(GF-10)
    });
    const { preview, committed } = await previewAndCommit(file, base.fileName);
    expect(preview.preview.counts).toMatchObject({ add: 0, update: 2, conflict: 0, error: 0 });
    const outcome = unwrap(committed);
    expect(outcome.deliverables).toEqual({ added: 0, updated: 1, deleted: 0 });
    expect(outcome.techTargets).toEqual({ added: 0, updated: 1, deleted: 0 });
    expect(outcome.achievements.updated).toBe(0);
    expect(outcome.records.updated).toBe(0);

    const after = await readDeliverables();
    expect(after.map((d) => d.id)).toEqual(before.map((d) => d.id));
    const renamed = after.find((d) => d.id === idOf('SCI 논문'));
    expect(renamed?.name).toBe('SCI(E) 논문 게재');
    expect(renamed?.version).toBe((before.find((d) => d.id === idOf('SCI 논문'))?.version ?? 0) + 1);
    expect(await achievementsOf(idOf('SCI 논문'))).toEqual([expect.objectContaining({ id: idOf('논문 1호') })]);
    expect((await readTechTargets()).find((t) => t.id === idOf('정확도'))?.name).toBe('분류 정확도');
    expect(await recordsOf(idOf('정확도'))).toEqual([expect.objectContaining({ id: idOf('정확도 측정') })]);
  });
});

// ═══ (d) targetByYear 병합 ═══════════════════════════════════════════════════

describe('(d) targetByYear — `_meta` 밖 키 보존 · `_meta` 연차 삭제 시 전체 거부 (S-13)', () => {
  it('`_meta` 연차 키만 교체하고 그 밖의 키는 남긴다', async () => {
    const outside = randomUUID();
    const d2 = idOf('특허 출원');
    await sql`
      update public.deliverables
         set target_by_year = target_by_year || jsonb_build_object(${outside}::text, 7)
       where id = ${d2}::uuid`;
    try {
      const base = await download();
      const file = rewritten(base.buffer, (book) => {
        const d = new Sheet(book, 'deliverables');
        const r0 = d.rowOf('deliverableId', d2);
        d.set(d.yearCol(0), r0, 2);
        d.set(d.yearCol(1), r0, null); // 빈 칸 = 그 키 삭제
        d.setRole('targetTotal', r0, 2);
      });
      const { committed } = await previewAndCommit(file, base.fileName);
      expect(unwrap(committed).deliverables.updated).toBe(1);
      const row = (await readDeliverables()).find((d) => d.id === d2);
      expect(row?.target_by_year).toEqual({ [year1Id]: 2, [outside]: 7 });
    } finally {
      await sql`
        update public.deliverables
           set target_by_year = jsonb_build_object(${year1Id}::text, 1, ${year2Id}::text, 1), target_total = 2
         where id = ${d2}::uuid`;
    }
  });

  it('내려받은 뒤 `_meta`의 연차가 삭제되면 RPC가 전체를 거부하고 DB는 그대로다', async () => {
    const year3 = unwrap(await years.createYear(stageId, { name: '3차년도' }));
    const base = await download();
    unwrap(await years.deleteYear(year3.id));
    const file = rewritten(base.buffer, (book) => {
      const d = new Sheet(book, 'deliverables');
      d.setRole('note', d.rowOf('deliverableId', idOf('특허 출원')), '연차 삭제 뒤');
    });
    const before = await goalState();
    const { committed } = await previewAndCommit(file, base.fileName);
    const failure = expectFailure(committed);
    expect(failure.code).toBe('RULE');
    expect(failure.error).toContain('양식을 받은 뒤 연차가 바뀌었습니다');
    expect(await goalState()).toEqual(before);
  });
});

// ═══ (e) 충돌 ════════════════════════════════════════════════════════════════

describe('(e) 충돌 — 내려받은 뒤 다른 경로로 바뀐 행만 건너뛴다 (GF-5·O-1)', () => {
  it('updateDeliverable 뒤 올린 파일: 그 행은 previewConflicts, 나머지는 반영된다', async () => {
    const base = await download();
    const d2 = idOf('특허 출원');
    const stale = (await readDeliverables()).find((d) => d.id === d2);
    if (!stale) throw new Error('특허 출원 지표가 없다');
    // 다른 경로(목표 화면 모달)로 비고를 바꾼다 — version이 오른다
    unwrap(await goals.updateDeliverable(d2, { note: '화면에서 고침' }, stale.version));

    const file = rewritten(base.buffer, (book) => {
      const d = new Sheet(book, 'deliverables');
      d.setRole('name', d.rowOf('deliverableId', d2), '파일의 옛 수정');
      d.setRole('weight', d.rowOf('deliverableId', idOf('SCI 논문')), 55);
    });
    const { preview, committed } = await previewAndCommit(file, base.fileName);
    expect(preview.preview.blocked).toBe(false);
    expect(preview.preview.conflicts).toEqual([{ kind: 'deliverable', id: d2, reason: 'changed' }]);
    const outcome = unwrap(committed);
    expect(outcome.deliverables.updated).toBe(1);
    expect(outcome.previewConflicts).toEqual([{ kind: 'deliverable', id: d2, reason: 'changed' }]);

    const rows = await readDeliverables();
    // 다른 경로의 값이 이긴다 — 파일의 옛 값으로 덮지 않는다
    expect(rows.find((d) => d.id === d2)).toMatchObject({ name: '특허 출원', note: '화면에서 고침' });
    expect(rows.find((d) => d.id === idOf('SCI 논문'))?.weight).toBe('55');
  });

  it('RPC 단계 충돌: expected version이 현재와 다르면 그 행만 conflicts로 돌아온다', async () => {
    const d2 = idOf('특허 출원');
    const row = (await readDeliverables()).find((d) => d.id === d2);
    if (!row) throw new Error('특허 출원 지표가 없다');
    const payload = emptyPayload();
    payload.deliverables.updates.push({ id: d2, ...deliverableFieldsOf(row, { note: 'RPC 충돌' }) });
    const result = await snapshotsRepo.commitGoalForm(user.client, projectId, payload, { [d2]: row.version - 1 }, source());
    expect(result.conflicts).toEqual([{ kind: 'deliverable', id: d2, reason: 'changed' }]);
    expect(result.deliverables.updated).toBe(0);
    expect((await readDeliverables()).find((d) => d.id === d2)?.note).toBe('화면에서 고침');
  });
});

// ─── RPC 직접 호출용 페이로드 (T1 계약) ────────────────────────────────────────

function emptyPayload(): GoalFormCommitPayload {
  return {
    deliverables: { adds: [], updates: [], deleteIds: [] },
    achievements: { adds: [], updates: [], deleteIds: [] },
    techTargets: { adds: [], updates: [], deleteIds: [] },
    records: { adds: [], updates: [], deleteIds: [] },
  };
}

function source(): { fileName: string; sheetName: string; fileHash: string } {
  return { fileName: 'rpc.xlsx', sheetName: '성과목표', fileHash: 'rpc-direct' };
}

function deliverableFieldsOf(row: DeliverableRow, over: Partial<{ note: string }> = {}) {
  return {
    type: row.type as 'other',
    name: row.name,
    unit: '건',
    weight: Number(row.weight),
    target_total: row.target_total,
    target_by_year: {},
    org_id: null,
    evidence_method: row.evidence_method,
    note: over.note ?? row.note,
  };
}

// ═══ (f) parent-moved ═══════════════════════════════════════════════════════

describe('(f) parent-moved — 미리보기 차단 + RPC raise (GF-5·GF-10)', () => {
  it('기존 실적의 지표명을 파일 안의 다른 지표 이름으로 바꾸면 미리보기가 차단되고 반영은 RULE', async () => {
    const base = await download();
    const file = rewritten(base.buffer, (book) => {
      const a = new Sheet(book, 'achievements');
      a.setRole('deliverableName', a.rowOf('achievementId', idOf('논문 1호')), '특허 출원');
    });
    const before = await goalState();
    const { preview, committed } = await previewAndCommit(file, base.fileName);
    expect(preview.preview.blocked).toBe(true);
    expect(preview.blockingReason).toContain('부모를 바꿀 수 없습니다');
    expect(expectFailure(committed).code).toBe('RULE');
    expect(await goalState()).toEqual(before);
  });

  it('RPC에 기존 실적을 다른 지표 아래로 보내면 raise하고 DB는 그대로다', async () => {
    const a1 = idOf('논문 1호');
    const versionRows = await sql`select version::int as v from public.deliverable_achievements where id = ${a1}::uuid`;
    const payload = emptyPayload();
    payload.achievements.updates.push({
      id: a1,
      deliverable_id: idOf('특허 출원'),
      title: '논문 1호',
      date: '2026-03-01',
      year_id: year1Id,
      org_id: null,
      member_ids: [member1Id],
      evidence_url: '',
      note: '',
    });
    const expected: GoalFormExpected = { [a1]: (versionRows[0] as { v: number }).v };
    const before = await goalState();
    const error = await snapshotsRepo.commitGoalForm(user.client, projectId, payload, expected, source()).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(RuleViolationError);
    expect((error as Error).message).toContain('기존 성과실적을 다른 성과목표로 옮길 수 없습니다');
    expect(await goalState()).toEqual(before);
  });
});

// ═══ (g) 경계 ════════════════════════════════════════════════════════════════

describe('(g) 경계 — 다른 과제의 연차·기관·인력·id는 RULE, DB 무변경 (N-13)', () => {
  async function expectBoundaryRejected(file: Buffer, fileName: string, message: string): Promise<void> {
    const before = await goalState();
    const otherBefore = await goalState(otherProjectId);
    const { committed } = await previewAndCommit(file, fileName);
    const failure = expectFailure(committed);
    expect(failure.code).toBe('RULE');
    expect(failure.error).toContain(message);
    expect(await goalState()).toEqual(before);
    expect(await goalState(otherProjectId)).toEqual(otherBefore);
  }

  it('`_meta` 연차 id를 다른 과제 연차로 바꿔치기 → 이 과제에 속하지 않은 연차', async () => {
    const base = await download();
    const file = rewritten(base.buffer, (book) => {
      renameMetaKey(book.wb, `${GOAL_META_PREFIXES.year}${year1Id}`, `${GOAL_META_PREFIXES.year}${otherYearId}`);
    });
    await expectBoundaryRejected(file, base.fileName, '이 과제에 속하지 않은 연차');
  });

  it('`_meta`에 다른 과제 기관을 싣고 셀에 적기 → 이 과제에 속하지 않은 기관', async () => {
    const base = await download();
    const file = rewritten(base.buffer, (book) => {
      appendMetaRow(book.wb, `${GOAL_META_PREFIXES.org}${otherOrgId}`, '남의 기관');
      const d = new Sheet(book, 'deliverables');
      d.setRole('org', d.rowOf('deliverableId', idOf('특허 출원')), '남의 기관');
    });
    await expectBoundaryRejected(file, base.fileName, '이 과제에 속하지 않은 기관');
  });

  it('`_meta`에 다른 과제 인력을 싣고 관여자로 적기 → 이 과제에 속하지 않은 참여인력', async () => {
    const base = await download();
    const file = rewritten(base.buffer, (book) => {
      appendMetaRow(book.wb, `${GOAL_META_PREFIXES.member}${otherMemberId}`, '남의 연구원');
      const a = new Sheet(book, 'achievements');
      a.setRole('members', a.rowOf('achievementId', idOf('논문 1호')), '김연구;남의 연구원');
    });
    await expectBoundaryRejected(file, base.fileName, '이 과제에 속하지 않은 참여인력');
  });

  it('`_meta` 목록 밖 숨김 id(파서 단계) → 미리보기 차단, 반영 RULE', async () => {
    const base = await download();
    const file = rewritten(base.buffer, (book) => {
      const d = new Sheet(book, 'deliverables');
      d.setRole('deliverableId', d.rowOf('deliverableId', idOf('특허 출원')), otherDeliverableId);
    });
    const preview = unwrap(await previewGoalForm(projectId, formOf(file, base.fileName)));
    expect(preview.preview.blocked).toBe(true);
    await expectBoundaryRejected(file, base.fileName, '숨김 id');
  });

  it('`_meta`까지 위조한 다른 과제 지표 id → 이 과제에서 "이미 삭제됨" 충돌로 건너뛰고 아무것도 바뀌지 않는다', async () => {
    const base = await download();
    const version = (await sql`select version::int as v from public.deliverables where id = ${otherDeliverableId}::uuid`)[0] as { v: number };
    const file = rewritten(base.buffer, (book) => {
      appendMetaRow(book.wb, `${GOAL_META_PREFIXES.deliverable}${otherDeliverableId}`, version.v);
      const d = new Sheet(book, 'deliverables');
      const r0 = d.emptyRow();
      d.setRole('deliverableId', r0, otherDeliverableId);
      d.setRole('type', r0, goalEnumLabel('deliverableType', 'other'));
      d.setRole('name', r0, '남의 지표 빼앗기');
    });
    const preview = unwrap(await previewGoalForm(projectId, formOf(file, base.fileName)));
    expect(preview.preview.conflicts).toEqual([{ kind: 'deliverable', id: otherDeliverableId, reason: 'deleted' }]);
    await expectBoundaryRejected(file, base.fileName, '반영할 목표 행이 없습니다');
  });

  it('RPC에 다른 과제 지표 id를 직접 보내면 raise한다', async () => {
    const other = (await sql`
      select id::text as id, version::int as version, name, type, weight::text as weight, target_total,
             target_by_year, evidence_method, note, sort_order
        from public.deliverables where id = ${otherDeliverableId}::uuid`)[0] as unknown as DeliverableRow;
    const payload = emptyPayload();
    payload.deliverables.updates.push({ id: other.id, ...deliverableFieldsOf(other, { note: '빼앗김' }) });
    const otherBefore = await goalState(otherProjectId);
    const error = await snapshotsRepo
      .commitGoalForm(user.client, projectId, payload, { [other.id]: other.version }, source())
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(RuleViolationError);
    expect((error as Error).message).toContain('이 과제에 속하지 않은 성과목표');
    expect(await goalState(otherProjectId)).toEqual(otherBefore);
  });
});

// ═══ (h) 삭제 ════════════════════════════════════════════════════════════════

describe('(h) 삭제 — 연쇄 삭제 · [삭제 포함] · orphan-child · 내려받은 뒤 자식이 붙은 부모 (GF-5·S-6)', () => {
  let d3: string;
  let t3: string;
  let taskId: string;

  beforeAll(async () => {
    d3 = unwrap(await goals.createDeliverable(projectId, { type: 'conference', name: '학회 발표', targetTotal: 2 })).id;
    for (const title of ['발표 1', '발표 2']) {
      unwrap(await goals.addAchievement(d3, { title, date: '2026-02-01', memberIds: [member2Id] }));
    }
    t3 = unwrap(
      await goals.createTechTarget(projectId, { name: '처리량', unit: 'TPS', targetValue: 1000, baselineDomestic: 100 })
    ).id;
    for (const value of [300, 500]) unwrap(await goals.addTechRecord(t3, { value, date: '2026-02-02' }));
    taskId = unwrap(await tasks.createTask(year1Id, { title: '학회 준비' })).id;
    unwrap(await tasks.linkTaskGoals(taskId, [d3], [t3]));
  });

  /** 지표 d3·기술목표 t3와 그 자식 행을 전부 지운 파일 */
  function withoutD3T3(buffer: Buffer): Buffer {
    return rewritten(buffer, (book) => {
      const d = new Sheet(book, 'deliverables');
      d.clear(d.rowOf('deliverableId', d3));
      const a = new Sheet(book, 'achievements');
      for (;;) {
        let r0: number;
        try {
          r0 = a.rowOf('deliverableId', d3);
        } catch {
          break;
        }
        a.clear(r0);
      }
      const t = new Sheet(book, 'techTargets');
      t.clear(t.rowOf('techTargetId', t3));
      const r = new Sheet(book, 'records');
      for (;;) {
        let r0: number;
        try {
          r0 = r.rowOf('techTargetId', t3);
        } catch {
          break;
        }
        r.clear(r0);
      }
    });
  }

  it('지표 행만 지우고 실적 행을 남기면 blocking orphan-child', async () => {
    const base = await download();
    const file = rewritten(base.buffer, (book) => {
      const d = new Sheet(book, 'deliverables');
      d.clear(d.rowOf('deliverableId', d3));
    });
    const preview = unwrap(await previewGoalForm(projectId, formOf(file, base.fileName)));
    expect(preview.preview.blocked).toBe(true);
    expect(preview.blockingReason).toContain('시트에서 지운 지표·기술목표를 가리키는 행');
  });

  it('삭제 후보에 "실적 N · 측정 M · 연계 작업 K"가 실린다, includeDeletes=false면 RULE · 아무것도 지우지 않는다', async () => {
    const base = await download();
    const file = withoutD3T3(base.buffer);
    const preview = unwrap(await previewGoalForm(projectId, formOf(file, base.fileName)));
    expect(preview.preview.blocked).toBe(false);
    expect(preview.preview.counts.deleteCandidates).toBe(6);
    expect(preview.preview.deleteCandidates.find((c) => c.id === d3)).toMatchObject({
      kind: 'deliverable',
      achievementCount: 2,
      linkedTaskCount: 1,
      conflict: null,
    });
    expect(preview.preview.deleteCandidates.find((c) => c.id === t3)).toMatchObject({
      kind: 'techTarget',
      recordCount: 2,
      linkedTaskCount: 1,
      conflict: null,
    });

    const before = await goalState();
    const failure = expectFailure(await commitGoalForm(projectId, formOf(file, base.fileName), preview.fileHash, false));
    expect(failure.code).toBe('RULE');
    expect(failure.error).toContain('[삭제 포함]');
    expect(await goalState()).toEqual(before);
  });

  it('includeDeletes=true: 지표·기술목표와 실적·측정이 지워지고 작업 연계가 끊긴다, 스냅샷 before에 원본이 남는다', async () => {
    const achievementIds = (await achievementsOf(d3)).map((a) => a.id);
    const recordIds = (await recordsOf(t3)).map((r) => r.id);
    const base = await download();
    const file = withoutD3T3(base.buffer);
    const { committed } = await previewAndCommit(file, base.fileName, true);
    const outcome = unwrap(committed);
    expect(outcome.deliverables.deleted).toBe(1);
    expect(outcome.achievements.deleted).toBe(2);
    expect(outcome.techTargets.deleted).toBe(1);
    expect(outcome.records.deleted).toBe(2);
    expect(outcome.conflicts).toEqual([]);

    expect((await readDeliverables()).some((d) => d.id === d3)).toBe(false);
    expect((await readTechTargets()).some((t) => t.id === t3)).toBe(false);
    expect(await achievementsOf(d3)).toEqual([]);
    expect(await recordsOf(t3)).toEqual([]);
    const links = await sql`
      select (select count(*) from public.task_deliverables where task_id = ${taskId}::uuid)::int as d,
             (select count(*) from public.task_tech_targets where task_id = ${taskId}::uuid)::int as t,
             (select count(*) from public.tasks where id = ${taskId}::uuid)::int as task`;
    expect(links[0]).toEqual({ d: 0, t: 0, task: 1 });

    const snapshot = (await readGoalSnapshots()).at(-1)?.snapshot;
    expect(snapshot?.goals?.deleted['deliverables']).toEqual([d3]);
    expect(snapshot?.goals?.deleted['tech_targets']).toEqual([t3]);
    expect([...(snapshot?.goals?.deleted['deliverable_achievements'] ?? [])].sort()).toEqual([...achievementIds].sort());
    expect([...(snapshot?.goals?.deleted['tech_target_records'] ?? [])].sort()).toEqual([...recordIds].sort());
    const before = snapshot?.goals?.before ?? {};
    expect(before['deliverables']?.map((row) => row['id'])).toEqual([d3]);
    expect(before['task_deliverables']).toEqual([expect.objectContaining({ task_id: taskId, deliverable_id: d3 })]);
    expect(before['task_tech_targets']).toEqual([expect.objectContaining({ task_id: taskId, tech_target_id: t3 })]);
    expect(before['achievement_members']).toHaveLength(2);
  });

  it('내려받은 뒤 실적이 추가된 지표를 지우면 충돌로 건너뛰고 지표·실적이 남는다 (S-6②)', async () => {
    const d4 = unwrap(await goals.createDeliverable(projectId, { type: 'other', name: '자식 추가될 지표', targetTotal: 1 })).id;
    const known = unwrap(await goals.addAchievement(d4, { title: '처음 실적', date: '2026-02-03' })).id;
    const base = await download();
    const late = unwrap(await goals.addAchievement(d4, { title: '나중 실적', date: '2026-02-04' })).id;

    const file = rewritten(base.buffer, (book) => {
      const d = new Sheet(book, 'deliverables');
      d.clear(d.rowOf('deliverableId', d4));
      const a = new Sheet(book, 'achievements');
      a.clear(a.rowOf('achievementId', known));
      d.setRole('note', d.rowOf('deliverableId', idOf('SCI 논문')), '삭제 충돌과 함께');
    });
    const { preview, committed } = await previewAndCommit(file, base.fileName, true);
    expect(preview.preview.conflicts).toEqual([{ kind: 'deliverable', id: d4, reason: 'changed' }]);
    const outcome = unwrap(committed);
    expect(outcome.previewConflicts).toEqual([{ kind: 'deliverable', id: d4, reason: 'changed' }]);
    expect(outcome.deliverables).toMatchObject({ updated: 1, deleted: 0 });
    // 사용자가 지운 실적 행 자체는 지워진다 — 충돌은 부모 삭제뿐이다
    expect(outcome.achievements.deleted).toBe(1);
    expect((await readDeliverables()).some((d) => d.id === d4)).toBe(true);
    expect((await achievementsOf(d4)).map((a) => a.id)).toEqual([late]);
  });

  it('RPC 단계 S-6②: expected에 없는 자식이 있으면 부모 삭제를 conflicts로 건너뛴다', async () => {
    const d5 = unwrap(await goals.createDeliverable(projectId, { type: 'other', name: 'RPC 삭제 대상', targetTotal: 1 }));
    unwrap(await goals.addAchievement(d5.id, { title: '모르는 자식', date: '2026-02-05' }));
    const payload = emptyPayload();
    payload.deliverables.deleteIds.push(d5.id);
    const version = (await sql`select version::int as v from public.deliverables where id = ${d5.id}::uuid`)[0] as { v: number };
    const result = await snapshotsRepo.commitGoalForm(user.client, projectId, payload, { [d5.id]: version.v }, source());
    expect(result.conflicts).toEqual([{ kind: 'deliverable', id: d5.id, reason: 'changed' }]);
    expect(result.deliverables.deleted).toBe(0);
    expect((await readDeliverables()).some((d) => d.id === d5.id)).toBe(true);
    expect(await achievementsOf(d5.id)).toHaveLength(1);
  });
});

// ═══ (i) 스냅샷 ══════════════════════════════════════════════════════════════

describe('(i) 스냅샷 — goals 키 · 목록 Zod · 복원 거부 · 20개 창 (GF-11, I-17)', () => {
  it('kind goal_form, items 빈 배열, goals의 added/before/deleted에 네 테이블 키가 항상 있다', async () => {
    const snapshots = await readGoalSnapshots();
    expect(snapshots.length).toBeGreaterThan(0);
    for (const { snapshot } of snapshots) {
      expect(snapshot.kind).toBe('goal_form');
      expect(snapshot.items).toEqual([]);
      for (const part of ['added', 'before', 'deleted'] as const) {
        for (const table of GOAL_TABLE_KEYS) expect(snapshot.goals?.[part], `${part}.${table}`).toHaveProperty(table);
      }
      for (const table of ['achievement_members', 'task_deliverables', 'task_tech_targets']) {
        expect(snapshot.goals?.before, `before.${table}`).toHaveProperty(table);
      }
    }
    // (b)의 추가 반영: 추가된 id 목록
    const first = snapshots.find((s) => (s.snapshot.goals?.added['deliverables'] ?? []).includes(idOf('SW 등록')));
    expect(first?.snapshot.goals?.added['tech_targets']).toEqual(expect.arrayContaining([idOf('지연시간'), idOf('검출한계')]));
    expect(first?.snapshot.goals?.added['deliverable_achievements']).toHaveLength(1);
    expect(first?.snapshot.goals?.added['tech_target_records']).toHaveLength(1);
  });

  it('listImportSnapshots가 목표 양식 스냅샷을 포함해 Zod 검증을 통과한다', async () => {
    const list = unwrap(await imports.listImportSnapshots(projectId));
    expect(list.some((s) => s.snapshot.kind === 'goal_form')).toBe(true);
  });

  it('restoreImportSnapshot은 RULE로 거부하고 목표 데이터·스냅샷 수가 그대로다', async () => {
    const latest = (await readGoalSnapshots()).at(-1);
    if (!latest) throw new Error('목표 양식 스냅샷이 없다');
    const before = await goalState();
    const count = await countSnapshots();
    const failure = expectFailure(await imports.restoreImportSnapshot(latest.id));
    expect(failure.code).toBe('RULE');
    expect(failure.error).toContain('목표 양식 스냅샷은 되돌릴 수 없습니다');
    expect(await goalState()).toEqual(before);
    expect(await countSnapshots()).toBe(count);
  });

  it('과제별 스냅샷은 20개를 넘지 않는다 (I-17 창 공유)', async () => {
    const target = idOf('특허 출원');
    for (let i = 0; i < 21; i += 1) {
      const base = await download();
      const file = rewritten(base.buffer, (book) => {
        const d = new Sheet(book, 'deliverables');
        d.setRole('note', d.rowOf('deliverableId', target), `창 ${i}`);
      });
      const { committed } = await previewAndCommit(file, base.fileName);
      unwrap(committed);
    }
    expect(await countSnapshots()).toBe(20);
    unwrap(await imports.listImportSnapshots(projectId));
  }, 180_000);
});

// ═══ (j) 거부 ════════════════════════════════════════════════════════════════

describe('(j) 거부 — fileHash 불일치 · 입력 양식 파일 (IN-6·GF-2)', () => {
  it('미리보기와 다른 파일로 반영하면 거부하고 DB가 그대로다', async () => {
    const base = await download();
    const preview = unwrap(await previewGoalForm(projectId, formOf(base.buffer, base.fileName)));
    const other = rewritten(base.buffer, (book) => {
      const d = new Sheet(book, 'deliverables');
      d.setRole('note', d.rowOf('deliverableId', idOf('특허 출원')), '해시 다른 파일');
    });
    const before = await goalState();
    const failure = expectFailure(await commitGoalForm(projectId, formOf(other, base.fileName), preview.fileHash, false));
    expect(failure.error).toContain('미리보기 때와 다릅니다');
    expect(await goalState()).toEqual(before);
  });

  it('입력 양식(buildInputForm 산출물)을 올리면 not-goal-form 문구로 거부한다', async () => {
    const input = unwrap(await buildInputForm(projectId, year1Id));
    const buffer = Buffer.from(input.contentBase64, 'base64');
    const failure = expectFailure(await previewGoalForm(projectId, formOf(buffer, input.fileName)));
    expect(failure.code).toBe('RULE');
    expect(failure.error).toBe(GOAL_FORM_REJECTION_MESSAGES['not-goal-form']);
    const commit = expectFailure(await commitGoalForm(projectId, formOf(buffer, input.fileName), 'any-hash', false));
    expect(commit.error).toBe(GOAL_FORM_REJECTION_MESSAGES['not-goal-form']);
  });
});
