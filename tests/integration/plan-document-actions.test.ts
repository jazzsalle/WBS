// hwpx 계획서 가져오기 **액션 계층** 통합 테스트 — 격자 → 미리보기 → 반영 → DB
// (SOT §6.18 HX-5~HX-8, §9 Plan Document, 부록 C.3, §11 Phase 22 완료 기준)
//
// tests/unit/hwpx-*.test.ts가 순수 계층(추출·식별·행 해석)을 고정했다.
// 여기서 보는 것은 **commit_goal_form이 DB에 남기는 것**이다:
//   (a) 미리보기: 찾은 표 요약·반영 제외 3행·삭제 후보 0·tablesHash
//   (b) 반영: 새 기술목표(평가방법 상세·평가환경 채움, 읽지 않는 열은 비움 — U-2·U-8)·방향(U-3)·기관 매칭(U-4)·
//       성과목표 지표명(U-6)·반영 제외 행 없음(U-7)·전부 `-` 행은 목표 0
//   (c) 공백만 다른 기존 목표는 **같은 id** update + 읽지 않는 필드 보존(S-18), 실적·측정 무변경, 계획서 밖 목표 보존
//   (d) 같은 격자 재미리보기 → 전 행 unchanged → 반영은 RULE (멱등)
//   (e) 미리보기 뒤 DB가 바뀌어도 commit 시점 DB로 다시 계산해 덮어쓴다 (U-10 — 다이제스트 없음)
//   (f) 거부: tablesHash 불일치, 크기 상한, 목표 표 없음 — DB 무변경
//   (g) 스냅샷: kind goal_form·sheetName '계획서(hwpx)', 목록 Zod, 복원 거부
//   (h) 달성률(§6.2·§6.3) 손계산
//
// 격자는 tests/fixtures/hwpx의 합성 XML을 실제 추출기(lib/hwpx/extract)로 뽑는다 — 클라이언트가 보내는 것과 같다.
// 기준값은 픽스처 README·격자 원문에서 손으로 읽은 값이다. 자기가 만든 과제·사용자만 지운다.

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Sql } from 'postgres';
import { connectDirectDb, createTestUser, destroyTestUser, type TestUser } from './helpers';
import type { ActionResult, Deliverable, TechTarget } from '@/types';
import * as deliverablesRepo from '@/lib/db/deliverables';
import * as stagesRepo from '@/lib/db/stages';
import * as techTargetsRepo from '@/lib/db/tech-targets';
import * as yearsRepo from '@/lib/db/years';
import { extractHwpxTables } from '@/lib/hwpx/extract';
import { selectPayloadTables } from '@/lib/hwpx/tables';
import type { HwpxTable, PlanDocumentPayload } from '@/lib/hwpx/types';

const session = vi.hoisted(() => ({ accessToken: '' }));

vi.mock('next/headers', () => ({
  cookies: async () => ({ get: () => ({ value: session.accessToken }) }),
}));
vi.mock('next/cache', () => ({ revalidatePath: () => undefined }));

const { previewPlanTables, commitPlanTables } = await import('@/actions/plan-document');
const goals = await import('@/actions/goals');
const team = await import('@/actions/team');
const imports = await import('@/actions/import');
const { createProject } = await import('@/actions/projects');
const years = await import('@/actions/years');

let sql: Sql;
let user: TestUser;
const tempProjectIds: string[] = [];

let projectId: string;
/** 과제 연차 4개 — order 순 (표의 1~4차년도 열과 순서로 대응, S-29) */
let yearIds: string[] = [];
let ganaId: string;
let daraId: string;

/** 이름 → id (시드 + 반영으로 생긴 행) */
const ids = new Map<string, string>();

// 시드 기존 목표 — 계획서 행과 이름 키(NFC + 공백 제거)만 같다
const TT_DELAY_OLD = '합성 전파지연'; // 계획서 2행 '2. 합성 전파 지연'
const TT_THROUGHPUT_OLD = '합성  동시 처리량'; // 계획서 4행 '4. 합성 동시 처리량'
const TT_OUTSIDE = '계획서 밖 기술목표';
const D_PATENT_OLD = '특허 국내출원건수'; // 계획서 '특허 국내출원 건수'
const D_OUTSIDE = '계획서 밖 지표';

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
  if (!id) throw new Error(`'${name}' id가 없다`);
  return id;
}

const FIXTURE_DIR = path.resolve(__dirname, '../fixtures/hwpx');

/**
 * 기술목표 → 평가방법 → 성과목표 순서로 섹션을 나눠 추출한다. 기술목표(index 0)와 평가방법(index 1)이
 * index로 붙어 있어도 서명이 달라 한 묶음으로 이어지면 안 된다(HX-4) — (a)에서 조각 수로 확인한다.
 */
function fixtureTables(): HwpxTable[] {
  const files = ['section-tech.xml', 'section-method.xml', 'section-deliverable.xml'];
  const result = extractHwpxTables(
    files.map((file, section) => ({ section, xml: readFileSync(path.join(FIXTURE_DIR, file), 'utf8') }))
  );
  if (result.skipped.length > 0) throw new Error(`픽스처 표가 구조 불일치로 빠졌다: ${JSON.stringify(result.skipped)}`);
  return selectPayloadTables(result);
}

function cloneTables(tables: HwpxTable[]): HwpxTable[] {
  return tables.map((t) => ({ ...t, cells: t.cells.map((row) => [...row]) }));
}

/** 격자 셀 하나를 고친다 — 클라이언트가 보낸 격자가 달라진 것과 같다 */
function setCell(tables: HwpxTable[], tableIndex: number, r: number, c: number, value: string): void {
  const table = tables.find((t) => t.index === tableIndex);
  const row = table?.cells[r];
  if (!row || row[c] === undefined) throw new Error(`표 ${tableIndex}에 (${r}, ${c}) 칸이 없다`);
  row[c] = value;
}

// section-tech.xml 11×14: 헤더 2행 + 순번 1~9. 13열 = 담당연구개발기관
const TECH_INDEX = 0;
const TECH_ORG_COL = 13;

/**
 * 반영에 쓰는 격자. 2행(순번 2 '합성 전파 지연')의 담당기관 칸을 비운다 — 표가 기관을 주지 않으면
 * 대응된 기존 행의 orgId를 보존하는지 보려는 것이다(HX-8 S-18). 나머지는 픽스처 그대로다.
 */
function basePayload(): PlanDocumentPayload {
  const tables = cloneTables(fixtureTables());
  setCell(tables, TECH_INDEX, 3, TECH_ORG_COL, '');
  return { fileName: '계획서.hwpx', tables };
}

// ─── DB 검증 SQL (postgres 직결 — 액션 반환이 아니라 저장된 원본을 본다) ─────────

/** 과제의 목표 4테이블 + 작업 연계 전부 — "DB 무변경" 비교용 */
async function goalState(): Promise<unknown> {
  const rows = await sql`
    select jsonb_build_object(
      'deliverables', (select coalesce(jsonb_agg(to_jsonb(d) order by d.id), '[]') from public.deliverables d where d.project_id = ${projectId}::uuid),
      'achievements', (select coalesce(jsonb_agg(to_jsonb(a) order by a.id), '[]')
                         from public.deliverable_achievements a join public.deliverables d on d.id = a.deliverable_id
                        where d.project_id = ${projectId}::uuid),
      'techTargets', (select coalesce(jsonb_agg(to_jsonb(t) order by t.id), '[]') from public.tech_targets t where t.project_id = ${projectId}::uuid),
      'records', (select coalesce(jsonb_agg(to_jsonb(r) order by r.id), '[]')
                    from public.tech_target_records r join public.tech_targets t on t.id = r.tech_target_id
                   where t.project_id = ${projectId}::uuid)
    ) as state`;
  return (rows[0] as { state: unknown }).state;
}

/** 실적·측정 이력 전부 (id·version) — "실적·측정 무변경" 비교용 */
async function childState(): Promise<{ achievements: unknown; records: unknown }> {
  const achievements = await sql`
    select a.id::text as id, a.version::int as version, a.deliverable_id::text as parent, a.title
      from public.deliverable_achievements a join public.deliverables d on d.id = a.deliverable_id
     where d.project_id = ${projectId}::uuid order by a.id`;
  const records = await sql`
    select r.id::text as id, r.version::int as version, r.tech_target_id::text as parent, r.value::text as value
      from public.tech_target_records r join public.tech_targets t on t.id = r.tech_target_id
     where t.project_id = ${projectId}::uuid order by r.id`;
  return { achievements: [...achievements], records: [...records] };
}

interface GoalSnapshot {
  id: string;
  snapshot: { kind?: string; source?: { fileName?: string; sheetName?: string; fileHash?: string } };
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

async function techTargets(): Promise<TechTarget[]> {
  return techTargetsRepo.listTechTargets(user.client, projectId);
}

async function deliverables(): Promise<Deliverable[]> {
  return deliverablesRepo.listDeliverables(user.client, projectId);
}

function techByName(list: readonly TechTarget[], name: string): TechTarget {
  const found = list.filter((t) => t.name === name);
  if (found.length !== 1) throw new Error(`기술목표 '${name}'이 ${found.length}개다`);
  return found[0]!;
}

function deliverableByName(list: readonly Deliverable[], name: string): Deliverable {
  const found = list.filter((d) => d.name === name);
  if (found.length !== 1) throw new Error(`성과목표 '${name}'이 ${found.length}개다`);
  return found[0]!;
}

/** 연차 순번(0-based) → 값. 빈 칸(null)은 키가 없다(GF-5 targetByYear 병합) */
function byYear(values: Record<number, number>): Record<string, number> {
  return Object.fromEntries(Object.entries(values).map(([i, v]) => [yearIds[Number(i)]!, v]));
}

// ─── 준비·정리 ────────────────────────────────────────────────────────────────

beforeAll(async () => {
  sql = connectDirectDb();
  user = await createTestUser(sql);
  session.accessToken = user.accessToken;

  const project = unwrap(await createProject({ name: '계획서 액션 통합', contractStartDate: '2026-01-01' }));
  tempProjectIds.push(project.id);
  projectId = project.id;
  const stage = (await stagesRepo.listStages(user.client, projectId))[0];
  if (!stage) throw new Error('createProject가 단계를 만들지 않았습니다.');
  for (const n of [2, 3, 4]) unwrap(await years.createYear(stage.id, { name: `${n}차년도` }));
  yearIds = (await yearsRepo.listYears(user.client, projectId))
    .sort((a, b) => a.order - b.order)
    .map((y) => y.id);
  if (yearIds.length !== 4) throw new Error(`연차가 ${yearIds.length}개다 — 4개여야 한다`);

  // 픽스처 담당기관 이름(README) — '다라⏎연구원'은 개행을 빼면 '다라연구원'이다(이름 키)
  ganaId = unwrap(await team.createOrganization(projectId, { name: '가나기술', role: 'lead' })).id;
  daraId = unwrap(await team.createOrganization(projectId, { name: '다라연구원', role: 'joint' })).id;

  const delay = unwrap(
    await goals.createTechTarget(projectId, {
      name: TT_DELAY_OLD,
      group: '기존 그룹',
      unit: 'ms',
      direction: 'higher_better',
      weight: 1,
      targetValue: 9,
      targetByYear: { [yearIds[0]!]: 9 },
      baselineDomestic: 8,
      worldBest: 2,
      worldBestHolder: '기존 보유국',
      measureMethod: 'expert_review',
      measureDescription: '기존 상세',
      standardBasis: '기존 표준',
      basisRationale: '기존 근거',
      evaluationEnvironment: '기존 환경',
      note: '기존 비고',
      orgId: daraId,
    })
  );
  ids.set(TT_DELAY_OLD, delay.id);
  unwrap(await goals.addTechRecord(delay.id, { value: 5.5, date: '2026-05-01', yearId: yearIds[0]! }));

  const throughput = unwrap(
    await goals.createTechTarget(projectId, {
      name: TT_THROUGHPUT_OLD,
      unit: '건',
      direction: 'lower_better',
      weight: 5,
      targetValue: 1,
      baselineDomestic: 50,
      measureMethod: 'expert_review',
    })
  );
  ids.set(TT_THROUGHPUT_OLD, throughput.id);
  unwrap(await goals.addTechRecord(throughput.id, { value: 300, date: '2026-05-02', yearId: yearIds[0]! }));

  ids.set(
    TT_OUTSIDE,
    unwrap(await goals.createTechTarget(projectId, { name: TT_OUTSIDE, unit: '%', weight: 0, targetValue: 1 })).id
  );

  const patent = unwrap(
    await goals.createDeliverable(projectId, {
      type: 'patent_dom_apply',
      name: D_PATENT_OLD,
      targetTotal: 1,
      orgId: ganaId,
      evidenceMethod: '기존 증빙',
    })
  );
  ids.set(D_PATENT_OLD, patent.id);
  for (const title of ['출원 1', '출원 2', '출원 3']) {
    unwrap(await goals.addAchievement(patent.id, { title, date: '2026-04-01', yearId: yearIds[0]! }));
  }

  ids.set(
    D_OUTSIDE,
    unwrap(await goals.createDeliverable(projectId, { type: 'other', name: D_OUTSIDE, targetTotal: 2 })).id
  );
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

// ═══ (a)~(c) 첫 반영 ══════════════════════════════════════════════════════════

describe('(a)~(c) 합성 계획서 격자 → 미리보기 → 반영 → DB (HX-5~HX-8)', () => {
  let childrenBefore: { achievements: unknown; records: unknown };
  let outsideBefore: { tech: TechTarget; deliverable: Deliverable };
  let firstHash: string;

  it('(a) 미리보기: 표 요약·반영 제외 3행·삭제 후보 0·차단 없음', async () => {
    childrenBefore = await childState();
    outsideBefore = {
      tech: techByName(await techTargets(), TT_OUTSIDE),
      deliverable: deliverableByName(await deliverables(), D_OUTSIDE),
    };
    const snapshotsBefore = await countSnapshots();

    const result = unwrap(await previewPlanTables(projectId, basePayload()));
    firstHash = result.tablesHash;
    expect(result.tablesHash).toMatch(/^[0-9a-f]{64}$/);
    expect(result.fileName).toBe('계획서.hwpx');
    expect(result.blockingReason).toBeNull();
    expect(result.preview.blocked).toBe(false);

    // 기술목표(index 0)·평가방법(index 1)이 붙어 있어도 한 묶음으로 잇지 않는다 — 조각 1개씩(HX-4)
    expect(result.tableSummary.tech).toMatchObject({ found: true, dataRows: 9, pieces: 1, duplicateNote: null });
    expect(result.tableSummary.method).toMatchObject({ found: true, dataRows: 9, pieces: 1, duplicateNote: null });
    expect(result.tableSummary.deliverable).toMatchObject({ found: true, dataRows: 13, pieces: 1, duplicateNote: null });

    // 기술목표 9행 = 추가 7 + 기존 대응 2 / 성과목표 10행 = 추가 9 + 기존 대응 1. 삭제 후보 없음(HX-8)
    expect(result.preview.counts).toMatchObject({ add: 16, update: 3, conflict: 0, error: 0, deleteCandidates: 0 });
    expect(result.preview.conflicts).toEqual([]);

    // U-7: SMART 평균 2 · Impact Factor 평균 1 — 사유와 함께 남는다
    expect(result.excluded).toHaveLength(3);
    expect(result.excluded.every((row) => row.reason === '반영 제외: 건수 지표가 아님' && row.unit === '점수')).toBe(true);
    expect(result.excluded.filter((row) => row.name.includes('SMART'))).toHaveLength(2);
    expect(result.excluded.filter((row) => row.name.includes('Impact Factor'))).toHaveLength(1);

    // S-10 행 위치 문구
    expect(result.locations.techTargets[2]).toBe('기술목표 표 2행 (순번 2)');
    expect(result.labels.years.map((y) => y.id)).toEqual(yearIds);

    // 미리보기는 저장하지 않는다
    expect(await countSnapshots()).toBe(snapshotsBefore);
  });

  it('(b) 반영: 건수 — 기술목표 추가 7·변경 2, 성과목표 추가 9·변경 1, 실적·측정 0', async () => {
    const committed = unwrap(await commitPlanTables(projectId, basePayload(), firstHash));
    expect(committed.techTargets).toEqual({ added: 7, updated: 2, deleted: 0 });
    expect(committed.deliverables).toEqual({ added: 9, updated: 1, deleted: 0 });
    expect(committed.achievements).toEqual({ added: 0, updated: 0, deleted: 0 });
    expect(committed.records).toEqual({ added: 0, updated: 0, deleted: 0 });
    expect(committed.conflicts).toEqual([]);
    expect(committed.previewConflicts).toEqual([]);
  });

  it('(b) 새 기술목표: 평가방법 상세·평가환경 채움, 읽지 않는 열은 비움(U-2·U-8), 방향·기관·측정방법', async () => {
    const list = await techTargets();

    // 1. '≤10' 힌트 → lower, 1차년도 '-' → 키 없음, 최종 = 마지막 연차(GF-7), 공인기관 시험평가, 가나기술
    const response = techByName(list, '합성 이벤트 응답시간');
    ids.set('합성 이벤트 응답시간', response.id);
    expect(response).toMatchObject({
      group: '',
      unit: '초',
      direction: 'lower_better',
      weight: 10,
      targetValue: 5,
      targetByYear: byYear({ 1: 10, 2: 8, 3: 5 }),
      measureMethod: 'certified_lab',
      orgId: ganaId,
      // U-2: 세계최고 '3(가상국/가상사)'·국내수준·표준·기준설정근거 '합성 문헌' 열은 읽지 않는다
      worldBest: null,
      worldBestHolder: '',
      baselineDomestic: null,
      standardBasis: '',
      basisRationale: '',
      note: '',
    });
    // HX-7: 평가방법 표 1행(순번 1)에서 온다. 수식은 빠진다(U-9)
    expect(response.measureDescription).toContain('합성 이벤트를 발생시킨 뒤 표출 시각을 기록');
    // U-8: `[기준설정 근거]` 문단부터 끝까지는 버린다 — basisRationale에도 가지 않는다
    expect(response.evaluationEnvironment).toBe('합성 시험장에서 이벤트 발생부터 표출까지의 시간 측정');

    // 3. '≥' 힌트 → higher, '다라⏎연구원' → 다라연구원(이름 키 일치), 전문가 평가
    const accuracy = techByName(list, '합성 탐지 정확도 (가상 조건)');
    expect(accuracy).toMatchObject({
      direction: 'higher_better',
      targetValue: 90,
      targetByYear: byYear({ 0: 60, 1: 70, 2: 80, 3: 90 }),
      measureMethod: 'expert_review',
      orgId: daraId,
      baselineDomestic: null, // 국내수준 '80' 무시(U-2)
      worldBest: null, // '95⏎(가상국/⏎가상사)' 무시
      standardBasis: '', // '합성 인증' 무시
      basisRationale: '', // '합성 기준 B' 무시
      evaluationEnvironment: '합성 데이터셋 1,000건', // 표식 없음 → 전부
    });

    // 5. 기타 평가방법 → other + 원문 비고(S-20), 1·2차년도 빈 칸
    const availability = techByName(list, '합성 가용률');
    expect(availability).toMatchObject({
      direction: 'higher_better',
      measureMethod: 'other',
      note: '[원문] 평가방법: 시뮬레이션 기반 검증',
      targetByYear: byYear({ 2: 60, 3: 70 }),
      evaluationEnvironment: '합성 운영 환경 30일',
      basisRationale: '',
    });

    // 7. 평가환경 '-' → 빈 값, '20 이상' → higher
    expect(techByName(list, '합성 수집 지점')).toMatchObject({ direction: 'higher_better', evaluationEnvironment: '', targetValue: 20 });
    // 8. '> 3' → higher(C.3.4 U-3 추가 힌트)
    expect(techByName(list, '합성 연계 시스템')).toMatchObject({ direction: 'higher_better', targetValue: 3 });
    // 9. 힌트 없이 단위 '초'(C.3.6 시간 단위) → lower
    expect(techByName(list, '합성 알림 지연')).toMatchObject({
      direction: 'lower_better',
      targetValue: 1,
      targetByYear: byYear({ 0: 5, 1: 3, 2: 2, 3: 1 }),
      orgId: daraId,
      measureMethod: 'self',
    });
  });

  it('(c) 공백만 다른 기존 기술목표는 같은 id가 바뀌고, 표가 주지 않거나 읽지 않는 필드는 보존된다 (S-18)', async () => {
    const list = await techTargets();
    // 기술목표 9행 + 계획서 밖 1 = 10 — 기존 두 행이 새로 추가되지 않았다
    expect(list).toHaveLength(10);

    const delay = list.find((t) => t.id === idOf(TT_DELAY_OLD));
    if (!delay) throw new Error('기존 기술목표(전파 지연)가 사라졌다');
    expect(delay).toMatchObject({
      unit: 'ms',
      // '< 5' 힌트가 있으므로 기존 higher_better를 덮는다(U-3)
      direction: 'lower_better',
      weight: 15,
      targetValue: 3,
      // 1차년도 '-'(빈 칸)는 그 키를 지운다 — 기존 9가 사라진다(GF-5 병합)
      targetByYear: byYear({ 1: 5, 2: 5, 3: 3 }),
      measureMethod: 'certified_lab',
      measureDescription: '- 합성 경로로 메시지를 보내 도착 시각 차이를 측정',
      evaluationEnvironment: '합성 네트워크 환경',
      // 보존: 담당기관 칸이 비었으므로 orgId, group, 읽지 않는 열(U-2), 비고
      orgId: daraId,
      group: '기존 그룹',
      baselineDomestic: 8,
      worldBest: 2,
      worldBestHolder: '기존 보유국',
      standardBasis: '기존 표준',
      basisRationale: '기존 근거',
      note: '기존 비고',
    });
    expect(planNameKeyOf(delay.name)).toBe(planNameKeyOf(TT_DELAY_OLD));

    const throughput = list.find((t) => t.id === idOf(TT_THROUGHPUT_OLD));
    if (!throughput) throw new Error('기존 기술목표(동시 처리량)가 사라졌다');
    expect(throughput).toMatchObject({
      // 힌트('200'·'500'·'1,000')도 시간 단위('건')도 없다 → 기존 lower_better 유지(U-3)
      direction: 'lower_better',
      weight: 10,
      targetValue: 1000,
      targetByYear: byYear({ 0: 200, 1: 500, 2: 1000, 3: 1000 }),
      measureMethod: 'self',
      orgId: ganaId,
      baselineDomestic: 50,
      evaluationEnvironment: '합성 서버 환경',
    });
  });

  it('(b)(c) 성과목표: 지표명 규칙(U-6)·유형(C.3.2)·단위, 반영 제외 행 없음, 전부 `-` 행은 목표 0, 기존 행 같은 id', async () => {
    const list = await deliverables();
    // 반영 10행 + 계획서 밖 1 = 11
    expect(list).toHaveLength(11);
    const names = list.map((d) => d.name);
    expect(names.some((name) => name.includes('SMART') || name.includes('Impact Factor'))).toBe(false);
    // 구분 값('사업별 성과지표'·'학술'·'상용화')은 이름에 들어가지 않는다 — 특허만 예외
    expect(names.some((name) => name.includes('성과지표') || name.includes('학술 ') || name.includes('상용화'))).toBe(false);

    expect(deliverableByName(list, '인력양성 효과')).toMatchObject({ type: 'hr_training', unit: '명', weight: 10, targetTotal: 3 });
    expect(deliverableByName(list, '소프트웨어 등록')).toMatchObject({ type: 'sw_registration', targetTotal: 6 });
    expect(deliverableByName(list, '특허 국내등록 건수')).toMatchObject({
      type: 'patent_dom_reg',
      weight: 15,
      targetTotal: 5,
      targetByYear: byYear({ 2: 2, 3: 3 }),
      evidenceMethod: '특허 등록증(가상)',
      orgId: null,
    });
    expect(deliverableByName(list, '특허 국외출원 건수')).toMatchObject({ type: 'patent_intl_apply', weight: 5, targetTotal: 2 });
    // U-7: 가중치·연차·계·평가방법이 전부 '-' → 제외하지 않고 목표 0
    expect(deliverableByName(list, '특허 국외등록 건수')).toMatchObject({
      type: 'patent_intl_reg',
      weight: 0,
      targetTotal: 0,
      targetByYear: {},
      evidenceMethod: '',
    });
    // 연속 중복 라벨 1회, 비SCI 규칙이 SCI보다 먼저(S-7)
    expect(deliverableByName(list, 'SCI급 게재논문 게재')).toMatchObject({
      type: 'paper_sci',
      targetTotal: 4,
      evidenceMethod: '합성 증빙&\n합성 논문',
    });
    expect(deliverableByName(list, '비SCI급 게재논문')).toMatchObject({ type: 'paper_domestic', targetTotal: 6 });
    expect(deliverableByName(list, '학술대회')).toMatchObject({ type: 'conference', targetTotal: 7 });
    expect(deliverableByName(list, '시제품')).toMatchObject({ type: 'commercialization', weight: 20, targetTotal: 2 });

    // 기존 '특허 국내출원건수'는 같은 id — 표가 주지 않는 orgId는 보존
    const patent = list.find((d) => d.id === idOf(D_PATENT_OLD));
    if (!patent) throw new Error('기존 성과목표(특허 국내출원)가 사라졌다');
    expect(planNameKeyOf(patent.name)).toBe(planNameKeyOf('특허 국내출원 건수'));
    expect(patent).toMatchObject({
      type: 'patent_dom_apply',
      weight: 10,
      targetTotal: 6,
      targetByYear: byYear({ 0: 1, 1: 2, 2: 2, 3: 1 }),
      evidenceMethod: '특허 출원서(가상)',
      orgId: ganaId,
    });
  });

  it('(c) 실적·측정 이력은 건수·version 그대로이고, 계획서에 없는 기존 목표는 지워지지도 바뀌지도 않는다', async () => {
    expect(await childState()).toEqual(childrenBefore);
    const tech = techByName(await techTargets(), TT_OUTSIDE);
    const deliverable = deliverableByName(await deliverables(), D_OUTSIDE);
    expect(tech).toEqual(outsideBefore.tech);
    expect(deliverable).toEqual(outsideBefore.deliverable);
  });

  it('(g) 스냅샷: kind goal_form · sheetName 계획서(hwpx) · fileHash = tablesHash', async () => {
    const latest = (await readGoalSnapshots()).at(-1);
    expect(latest?.snapshot.kind).toBe('goal_form');
    expect(latest?.snapshot.source).toMatchObject({
      fileName: '계획서.hwpx',
      sheetName: '계획서(hwpx)',
      fileHash: firstHash,
    });
  });
});

/** 이름 키(S-17) — 비교용. lib/hwpx/rows의 planNameKey와 같은 정의(NFC + 공백 제거) */
function planNameKeyOf(name: string): string {
  return name.normalize('NFC').replace(/\s+/g, '');
}

// ═══ (d) 멱등 ══════════════════════════════════════════════════════════════════

describe('(d) 같은 격자를 다시 미리보기하면 전 행 unchanged, 반영은 RULE (HX-8 멱등)', () => {
  it('unchanged 19 · 추가·변경·충돌·오류·삭제 후보 0 → 반영하면 "반영할 목표 행이 없습니다", 스냅샷 늘지 않음', async () => {
    const before = await countSnapshots();
    const state = await goalState();
    const preview = unwrap(await previewPlanTables(projectId, basePayload()));
    expect(preview.preview.counts).toMatchObject({ add: 0, update: 0, unchanged: 19, conflict: 0, error: 0, deleteCandidates: 0 });

    const failure = expectFailure(await commitPlanTables(projectId, basePayload(), preview.tablesHash));
    expect(failure.code).toBe('RULE');
    expect(failure.error).toContain('반영할 목표 행이 없습니다');
    expect(failure.error).toContain('반영 제외 3행');
    expect(await countSnapshots()).toBe(before);
    expect(await goalState()).toEqual(state);
  });
});

// ═══ (e) 나중 쓰기 승 ═══════════════════════════════════════════════════════════

describe('(e) 미리보기 뒤 DB가 바뀌어도 commit 시점 DB로 다시 계산해 덮어쓴다 (U-10)', () => {
  it('updateTechTarget으로 비중·평가방법 상세·구분을 고친 뒤 반영 → 거부·충돌 없이 표 값으로 돌아가고, 표가 주지 않는 구분은 새 값 유지', async () => {
    const preview = unwrap(await previewPlanTables(projectId, basePayload()));
    expect(preview.preview.counts.update).toBe(0);

    const targetId = idOf('합성 이벤트 응답시간');
    const edited = unwrap(
      await goals.updateTechTarget(targetId, {
        weight: 99,
        measureDescription: '다른 사람이 고친 상세',
        group: '다른 사람이 붙인 구분',
      })
    );
    const records = await childState();

    const committed = unwrap(await commitPlanTables(projectId, basePayload(), preview.tablesHash));
    expect(committed.techTargets).toEqual({ added: 0, updated: 1, deleted: 0 });
    expect(committed.deliverables).toEqual({ added: 0, updated: 0, deleted: 0 });
    expect(committed.conflicts).toEqual([]);
    expect(committed.previewConflicts).toEqual([]);

    const after = (await techTargets()).find((t) => t.id === targetId);
    if (!after) throw new Error('덮어쓴 기술목표가 사라졌다');
    expect(after.version).toBe(edited.version + 1);
    expect(after).toMatchObject({
      weight: 10,
      measureDescription: expect.stringContaining('합성 이벤트를 발생시킨 뒤 표출 시각을 기록'),
      // group은 hwpx가 읽지 않는 필드다(U-1) — commit 시점 DB 값이 보존된다
      group: '다른 사람이 붙인 구분',
    });
    expect(await childState()).toEqual(records);
  });
});

// ═══ (f) 거부 ═══════════════════════════════════════════════════════════════════

describe('(f) 거부 — 해시 불일치 · 크기 상한 · 목표 표 없음 (HX-3·HX-8·§9)', () => {
  it('미리보기와 다른 격자로 반영하면 VALIDATION이고 DB가 그대로다', async () => {
    const preview = unwrap(await previewPlanTables(projectId, basePayload()));
    const other = basePayload();
    setCell(other.tables, TECH_INDEX, 2, 3, '11'); // 1행 비중 10 → 11
    const before = await goalState();
    const snapshots = await countSnapshots();

    const failure = expectFailure(await commitPlanTables(projectId, other, preview.tablesHash));
    expect(failure.code).toBe('VALIDATION');
    expect(failure.error).toContain('미리보기 때와 다른 표입니다');
    expect(await goalState()).toEqual(before);
    expect(await countSnapshots()).toBe(snapshots);
  });

  it('셀 상한을 넘는 격자는 미리보기·반영 모두 VALIDATION "표만 추출해도 너무 큽니다"', async () => {
    const huge = basePayload();
    setCell(huge.tables, TECH_INDEX, 2, 11, '가'.repeat(20_001));
    const before = await goalState();

    const previewFailure = expectFailure(await previewPlanTables(projectId, huge));
    expect(previewFailure.code).toBe('VALIDATION');
    expect(previewFailure.error).toContain('표만 추출해도 너무 큽니다');

    const commitFailure = expectFailure(await commitPlanTables(projectId, huge, 'a'.repeat(64)));
    expect(commitFailure.code).toBe('VALIDATION');
    expect(commitFailure.error).toContain('표만 추출해도 너무 큽니다');
    expect(await goalState()).toEqual(before);
  });

  it('기술목표·성과목표 표가 둘 다 없으면(평가방법 표만) RULE', async () => {
    const methodOnly: PlanDocumentPayload = {
      fileName: '계획서.hwpx',
      tables: fixtureTables().filter((t) => t.index === 1),
    };
    expect(methodOnly.tables).toHaveLength(1);
    const failure = expectFailure(await previewPlanTables(projectId, methodOnly));
    expect(failure.code).toBe('RULE');
    expect(failure.error).toContain('기술목표 표와 성과목표 표를 둘 다 찾지 못했습니다');

    const empty = expectFailure(await previewPlanTables(projectId, { fileName: '계획서.hwpx', tables: [] }));
    expect(empty.code).toBe('RULE');
  });
});

// ═══ (g) 스냅샷 목록·복원 ═════════════════════════════════════════════════════════

describe('(g) 스냅샷 목록 Zod 통과 · 복원 거부 (GF-11, U-11)', () => {
  it('listImportSnapshots가 계획서(hwpx) 스냅샷을 포함해 Zod 검증을 통과한다', async () => {
    const list = unwrap(await imports.listImportSnapshots(projectId));
    const plan = list.filter((s) => s.snapshot.kind === 'goal_form' && s.snapshot.source.sheetName === '계획서(hwpx)');
    // (b) 첫 반영 + (e) 덮어쓰기
    expect(plan).toHaveLength(2);
  });

  it('restoreImportSnapshot은 RULE로 거부하고 목표 데이터·스냅샷 수가 그대로다', async () => {
    const latest = (await readGoalSnapshots()).at(-1);
    if (!latest) throw new Error('계획서 스냅샷이 없다');
    const before = await goalState();
    const count = await countSnapshots();
    const failure = expectFailure(await imports.restoreImportSnapshot(latest.id));
    expect(failure.code).toBe('RULE');
    expect(await goalState()).toEqual(before);
    expect(await countSnapshots()).toBe(count);
  });
});

// ═══ (h) 달성률 ═══════════════════════════════════════════════════════════════════

describe('(h) 반영 후 달성률이 §6.2·§6.3 손계산과 같다', () => {
  it('특허 국내출원: 실적 3 / 계 6 = 50% · 전파 지연: lower (8 − 5.5) / (8 − 3) = 50% · 국외등록(목표 0) = null', async () => {
    const data = unwrap(await goals.getGoalsData(projectId));

    const patent = data.deliverables.find((v) => v.deliverable.id === idOf(D_PATENT_OLD));
    expect(patent?.achievedTotal).toBe(3);
    expect(patent?.rate).toBe(50);
    // 1차년도: 실적 3 / 목표 1 = 300% (D-2 상한 없음)
    expect(patent?.byYear[yearIds[0]!]?.rate).toBe(300);

    const intlReg = data.deliverables.find((v) => v.deliverable.name === '특허 국외등록 건수');
    expect(intlReg?.rate).toBeNull(); // D-1: 목표 0

    // 기존 국내수준 8(보존, U-2) · 방향 lower(힌트) · 최종 3(표) · 측정 5.5(보존)
    const delay = data.techTargets.find((v) => v.techTarget.id === idOf(TT_DELAY_OLD));
    expect(delay?.current).toBe(5.5);
    expect(delay?.rate).toBe(50);
  });
});
