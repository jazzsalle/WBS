// 붙임4 가져오기 액션 통합 테스트 — Phase 25 T11
// (SOT §5.21 AV-7·AV-1·AV-2, §9 Agreement Budget SA-1~SA-4, §6.8 I-13, 계획서 G-4·G-11·S-13~S-16)
//
// 파일은 실데이터가 아니다 — 파서 단위 테스트의 익명 합성 격자(tests/fixtures/attachment4/*.json, RawSheet)를
// SheetJS로 xlsx 바이트로 다시 써서 FormData로 올린다. 어댑터(SheetJS 읽기)·가드·fileHash 대조·RPC까지 실제 경로다.
// 서버 액션은 쿠키 세션에서 토큰을 읽으므로 next/headers를 실제 세션 토큰 스텁으로 바꾼다(agreement-actions와 같은 방식).
// 저장 결과는 액션 반환값이 아니라 직결 SQL·리포지토리로 본다. 자기가 만든 과제·사용자만 지운다.

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import * as XLSX from 'xlsx';
import type { Sql } from 'postgres';
import { connectDirectDb, createTestUser, destroyTestUser, type TestUser } from './helpers';
import type { ActionResult, Year } from '@/types';
import type { RawCell, RawSheet } from '@/lib/import/types';
import * as agreementsRepo from '@/lib/db/agreements';
import * as projectsRepo from '@/lib/db/projects';
import * as stagesRepo from '@/lib/db/stages';
import * as yearsRepo from '@/lib/db/years';
import { MAX_UPLOAD_BYTES, UNREADABLE_WORKBOOK_MESSAGE } from '@/lib/import-adapter';
import { buildAttachment4View } from '@/lib/agreement/attachment4-view';

const session = vi.hoisted(() => ({ accessToken: '' }));

vi.mock('next/headers', () => ({
  cookies: async () => ({ get: () => ({ value: session.accessToken }) }),
}));
vi.mock('next/cache', () => ({ revalidatePath: () => undefined }));

const { previewAttachment4Import, commitAttachment4Import } = await import('@/actions/agreement-import');

const FIXTURES = path.resolve(__dirname, '../fixtures/attachment4');
const S82 = '8-2. 연구개발비 사용계획';
const S81 = '8-1. 연구개발비 지원 및 부담계획';

let sql: Sql;
let user: TestUser;
const tempProjectIds: string[] = [];

// synthetic.json — 연차 2개, 기관 블록 2개
let p2Id: string;
let p2Years: Year[];
// real-structure.json — 1단계 4연차, 기관 블록 6개
let p4Id: string;
let p4Years: Year[];

// ─── 픽스처 → xlsx ────────────────────────────────────────────────────────────

function load(name: string): RawSheet[] {
  return JSON.parse(fs.readFileSync(path.join(FIXTURES, name), 'utf8')) as RawSheet[];
}

function at(a1: string): { r: number; c: number } {
  const m = /^([A-Z]+)(\d+)$/.exec(a1)!;
  const c = m[1]!.split('').reduce((n, ch) => n * 26 + ch.charCodeAt(0) - 64, 0) - 1;
  return { r: Number(m[2]) - 1, c };
}

function set(sheets: RawSheet[], name: string, a1: string, value: RawCell['value']): RawSheet[] {
  const { r, c } = at(a1);
  const s = sheets.find((x) => x.name === name)!;
  while (s.cells.length <= r) s.cells.push([]);
  const row = s.cells[r]!;
  while (row.length <= c) row.push({ value: null, isError: false });
  row[c] = { value, isError: false };
  return sheets;
}

function get(sheets: RawSheet[], name: string, a1: string): number {
  const { r, c } = at(a1);
  return Number(sheets.find((x) => x.name === name)!.cells[r]?.[c]?.value ?? 0);
}

function xlsxBytes(sheets: RawSheet[]): Uint8Array {
  const wb = XLSX.utils.book_new();
  for (const s of sheets) {
    const ws = XLSX.utils.aoa_to_sheet(s.cells.map((row) => row.map((cell) => cell?.value ?? null)));
    ws['!merges'] = s.merges.map((m) => ({ s: { ...m.s }, e: { ...m.e } }));
    XLSX.utils.book_append_sheet(wb, ws, s.name);
  }
  return new Uint8Array(XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }) as Buffer);
}

function form(bytes: Uint8Array, extra: Record<string, string> = {}, fileName = '붙임4_사업비검토양식.xlsx'): FormData {
  const fd = new FormData();
  fd.set('file', new Blob([bytes as BlobPart]), fileName);
  for (const [k, v] of Object.entries(extra)) fd.set(k, v);
  return fd;
}

// ─── 공통 ─────────────────────────────────────────────────────────────────────

function unwrap<T>(result: ActionResult<T>): T {
  if (!result.ok) throw new Error(`액션 실패: ${result.error} (code=${result.code ?? '-'})`);
  return result.data;
}

function expectCode(result: ActionResult<unknown>, code: string | undefined): string {
  if (result.ok) throw new Error(`실패해야 하는 호출이 통과했습니다 (기대 code=${code ?? '-'}).`);
  expect(result.code).toBe(code);
  return result.error;
}

async function countVersions(pid: string): Promise<number> {
  const rows = await sql<{ n: number }[]>`
    select count(*)::int as n from public.agreement_versions where project_id = ${pid}::uuid`;
  return rows[0]!.n;
}

async function readLines(versionId: string) {
  const rows = await sql<
    { year_id: string; category: string; subcategory_code: string; axis: string; amount: string }[]
  >`
    select year_id::text, category, subcategory_code, axis, amount::text
      from public.agreement_lines where version_id = ${versionId}::uuid`;
  return rows.map((r) => ({
    yearId: r.year_id,
    category: r.category,
    subcategoryCode: r.subcategory_code,
    axis: r.axis,
    amount: Number(r.amount),
  }));
}

async function readGovCash(versionId: string): Promise<Record<string, number>> {
  const rows = await sql<{ year_id: string; gov_cash: string }[]>`
    select year_id::text, gov_cash::text from public.agreement_gov_support where version_id = ${versionId}::uuid`;
  return Object.fromEntries(rows.map((r) => [r.year_id, Number(r.gov_cash)]));
}

async function countChildren(versionId: string) {
  const rows = await sql<{ participants: number; items: number }[]>`
    select
      (select count(*) from public.agreement_participants where version_id = ${versionId}::uuid)::int as participants,
      (select count(*) from public.agreement_items where version_id = ${versionId}::uuid)::int as items`;
  return rows[0]!;
}

async function readVersion(versionId: string) {
  const rows = await sql<{ status: string; kind: string; name: string }[]>`
    select status, kind, name from public.agreement_versions where id = ${versionId}::uuid`;
  return rows[0]!;
}

async function confirm(pid: string, versionId: string): Promise<void> {
  const v = (await agreementsRepo.listVersionsByProject(user.client, pid)).find((x) => x.id === versionId)!;
  await agreementsRepo.confirmVersion(user.client, versionId, v.version);
}

const sortKey = (l: { yearId: string; category: string; subcategoryCode: string; axis: string }) =>
  `${l.yearId}|${l.category}|${l.subcategoryCode}|${l.axis}`;
const byKey = <T extends { yearId: string; category: string; subcategoryCode: string; axis: string }>(lines: T[]) =>
  [...lines].sort((a, b) => sortKey(a).localeCompare(sortKey(b)));

async function addYears(pid: string, total: number): Promise<Year[]> {
  const stage = (await stagesRepo.listStages(user.client, pid))[0]!;
  for (let n = 2; n <= total; n += 1) {
    await yearsRepo.createYear(user.client, {
      stageId: stage.id,
      name: `${n}차년도`,
      startDate: `${2025 + n}-01-01`,
      endDate: `${2025 + n}-12-31`,
    });
  }
  return [...(await yearsRepo.listYears(user.client, pid))].sort((a, b) => a.order - b.order);
}

// ─── 준비 ─────────────────────────────────────────────────────────────────────

beforeAll(async () => {
  sql = connectDirectDb();
  user = await createTestUser(sql);
  session.accessToken = user.accessToken;

  const p2 = await projectsRepo.createProjectWithDefaults(user.client, {
    name: '붙임4 가져오기 테스트 과제(2연차)',
    contractStartDate: '2026-01-01',
  });
  p2Id = p2.id;
  tempProjectIds.push(p2Id);
  p2Years = await addYears(p2Id, 2);

  const p4 = await projectsRepo.createProjectWithDefaults(user.client, {
    name: '붙임4 가져오기 테스트 과제(4연차)',
    contractStartDate: '2026-01-01',
  });
  p4Id = p4.id;
  tempProjectIds.push(p4Id);
  p4Years = await addYears(p4Id, 4);
});

afterAll(async () => {
  if (tempProjectIds.length > 0) {
    // 버전을 먼저 지운다 — 연차 FK가 no action이라(H-5a) 과제 cascade가 막힌다
    await sql`delete from public.agreement_versions where project_id = any(${tempProjectIds}::uuid[])`;
    await sql`delete from public.projects where id = any(${tempProjectIds}::uuid[])`;
    const rows = await sql<{ n: number }[]>`
      select ((select count(*) from public.projects where id = any(${tempProjectIds}::uuid[]))
            + (select count(*) from public.agreement_versions where project_id = any(${tempProjectIds}::uuid[])))::int as n`;
    if (rows[0]!.n !== 0) throw new Error(`테스트가 만든 데이터가 ${rows[0]!.n}건 남았습니다.`);
  }
  await destroyTestUser(sql, user);
  await sql.end();
});

// ─── 시나리오 (2연차 과제 위에서 순서대로 쌓인다 — 작성 중·확정 규칙이 이력에 대한 것이라) ──────────

describe('붙임4 가져오기 — synthetic.json (2연차, 기관 블록 2개)', () => {
  const bytes = xlsxBytes(load('synthetic.json'));
  let firstVersionId: string;

  it('블록이 여럿이면 미리보기가 choose-block — 요약 없음, 이름 초깃값 = 선정평가본', async () => {
    const preview = unwrap(await previewAttachment4Import(p2Id, form(bytes)));
    expect(preview.parse.status).toBe('choose-block');
    expect(preview.parse.blocks.map((b) => b.label)).toEqual(['기관가', '가나\n연구원']);
    expect(preview.summary).toBeNull();
    expect(preview.selection).toEqual({ blockIndex: null, plan81Row: null });
    expect(preview.fileName).toBe('붙임4_사업비검토양식.xlsx');
    expect(preview.fileHash).toMatch(/^[0-9a-f]{64}$/);
    expect(preview.draftVersionName).toBeNull();
    expect(preview.hasVersions).toBe(false);
    expect(preview.nextVersionMeta).toEqual({ kind: 'selection', name: '선정평가본' });

    // 블록을 고르지 않고 반영 → RULE, 버전 0개
    const error = expectCode(
      await commitAttachment4Import(p2Id, form(bytes), {
        fileHash: preview.fileHash, blockIndex: null, plan81Row: null, kind: 'selection', name: '선정평가본',
      }),
      'RULE'
    );
    expect(error).toContain('블록');
    expect(await countVersions(p2Id)).toBe(0);
  });

  it('미리보기 파일과 다른 파일을 반영하면 RULE — 버전 0개', async () => {
    const preview = unwrap(await previewAttachment4Import(p2Id, form(bytes, { blockIndex: '0' })));
    const other = xlsxBytes(set(load('synthetic.json'), S82, 'H41', 6000));
    const error = expectCode(
      await commitAttachment4Import(p2Id, form(other), {
        fileHash: preview.fileHash, blockIndex: 0, plan81Row: null, kind: 'selection', name: '선정평가본',
      }),
      'RULE'
    );
    expect(error).toContain('미리보기에 사용한 파일과 다른 파일');
    expect(await countVersions(p2Id)).toBe(0);
  });

  it('blocking(모르는 라벨)이면 미리보기는 blocked, 반영은 RULE(위치 문구 포함) — 버전 0개', async () => {
    const broken = xlsxBytes(set(load('synthetic.json'), S82, 'E30', '기타인건비(X)'));
    const preview = unwrap(await previewAttachment4Import(p2Id, form(broken, { blockIndex: '0' })));
    if (preview.parse.status !== 'blocked') throw new Error(preview.parse.status);
    expect(preview.summary).toBeNull();
    const issueMessage = preview.parse.issues[0]!.message;
    expect(issueMessage).toContain('기타인건비(X)');

    const error = expectCode(
      await commitAttachment4Import(p2Id, form(broken), {
        fileHash: preview.fileHash, blockIndex: 0, plan81Row: null, kind: 'selection', name: '선정평가본',
      }),
      'RULE'
    );
    expect(error).toContain(issueMessage);
    expect(await countVersions(p2Id)).toBe(0);
  });

  it('0 금액 파일(8-1 A만 있음)은 미리보기 blocked(no_amounts), 반영 RULE — 버전 0개', async () => {
    const sheets = load('synthetic.json');
    for (let r = 28; r <= 50; r += 1) for (const col of ['H', 'I', 'J']) set(sheets, S82, `${col}${r}`, 0);
    expect(get(sheets, S81, 'E10')).toBe(35_000);
    const zero = xlsxBytes(sheets);

    const preview = unwrap(await previewAttachment4Import(p2Id, form(zero, { blockIndex: '0' })));
    if (preview.parse.status !== 'blocked') throw new Error(preview.parse.status);
    expect(preview.summary).toBeNull();
    expect(preview.parse.issues.map((i) => i.code)).toEqual(['no_amounts']);

    for (const plan81Row of [null, 'none'] as const) {
      const error = expectCode(
        await commitAttachment4Import(p2Id, form(zero), {
          fileHash: preview.fileHash, blockIndex: 0, plan81Row, kind: 'selection', name: '선정평가본',
        }),
        'RULE'
      );
      expect(error).toContain(preview.parse.issues[0]!.message);
    }
    expect(await countVersions(p2Id)).toBe(0);
  });

  it('blockIndex 0 → 미리보기 줄 = 반영 줄(줄마다), 정부지원 현금 = 8-1 A, 참여인원·편성 0', async () => {
    const preview = unwrap(await previewAttachment4Import(p2Id, form(bytes, { blockIndex: '0' })));
    if (preview.parse.status !== 'ok') throw new Error(preview.parse.status);
    const [y1, y2] = p2Years;
    expect(preview.selection).toEqual({ blockIndex: 0, plan81Row: null });
    expect(preview.parse.blockLabel).toBe('기관가');
    expect(preview.summary).not.toBeNull();
    const summary = preview.summary!;
    expect(summary.lineCount).toBe(12);
    expect(summary.total).toBe(105_200_000);
    expect(summary.cash + summary.inKind).toBe(105_200_000);
    expect(summary.govCashYearCount).toBe(2);
    expect(summary.categories).toEqual(['personnel', 'material', 'activity', 'allowance', 'indirect']);
    expect(summary.years.map((y) => [y.yearId, y.govCash, y.lineCount])).toEqual([
      [y1!.id, 35_000_000, 6],
      [y2!.id, 35_000_000, 6],
    ]);
    expect(summary.years[0]!.byCategory.personnel).toEqual({ cash: 30_000_000, inKind: 10_000_000 });
    expect(summary.years[1]!.byCategory.activity).toEqual({ cash: 1_000_000, inKind: 0 });

    const created = unwrap(
      await commitAttachment4Import(p2Id, form(bytes), {
        fileHash: preview.fileHash, blockIndex: 0, plan81Row: null,
        kind: preview.nextVersionMeta.kind, name: preview.nextVersionMeta.name,
      })
    );
    firstVersionId = created.versionId;
    expect(created).toMatchObject({ lineCount: 12, participantCount: 0, itemCount: 0, govCashYearCount: 2, blockLabel: '기관가' });

    expect(byKey(await readLines(created.versionId))).toEqual(byKey(preview.parse.lines.map((l) => ({ ...l }))));
    expect(await readGovCash(created.versionId)).toEqual({ [y1!.id]: 35_000_000, [y2!.id]: 35_000_000 });
    expect(await countChildren(created.versionId)).toEqual({ participants: 0, items: 0 });
    expect(await readVersion(created.versionId)).toEqual({ status: 'draft', kind: 'selection', name: '선정평가본' });
  });

  it('작성 중 버전이 있으면 미리보기가 이름을 알리고 반영은 RULE(SOT 문구)', async () => {
    const preview = unwrap(await previewAttachment4Import(p2Id, form(bytes, { blockIndex: '1' })));
    expect(preview.draftVersionName).toBe('선정평가본');
    expect(preview.hasVersions).toBe(true);
    const error = expectCode(
      await commitAttachment4Import(p2Id, form(bytes), {
        fileHash: preview.fileHash, blockIndex: 1, plan81Row: null, kind: 'adjustment', name: '조정회의본',
      }),
      'RULE'
    );
    expect(error).toBe('작성 중 버전 "선정평가본"이 있습니다 — 확정하거나 삭제한 뒤 만드세요');
    expect(await countVersions(p2Id)).toBe(1);
  });

  it('버전이 있어도 작성 중이 없으면 허용 — choose-81-row → plan81Row 선택, 이름 초깃값 = 조정회의본', async () => {
    await confirm(p2Id, firstVersionId);
    const sheets = set(set(load('synthetic.json'), S81, 'C10', '(주)기관가'), S81, 'C14', '(주)기관가');
    const renamed = xlsxBytes(sheets);

    const choose = unwrap(await previewAttachment4Import(p2Id, form(renamed, { blockIndex: '0' })));
    if (choose.parse.status !== 'choose-81-row') throw new Error(choose.parse.status);
    expect(choose.parse.reason).toBe('no-match');
    expect(choose.parse.candidates.map((c) => c.label)).toEqual(['(주)기관가', '가나연구원']);
    expect(choose.draftVersionName).toBeNull();
    expect(choose.nextVersionMeta).toEqual({ kind: 'adjustment', name: '조정회의본' });

    // 8-1 행을 고르지 않고 반영 → RULE
    const error = expectCode(
      await commitAttachment4Import(p2Id, form(renamed), {
        fileHash: choose.fileHash, blockIndex: 0, plan81Row: null, kind: 'adjustment', name: '조정회의본',
      }),
      'RULE'
    );
    expect(error).toContain('8-1');
    expect(await countVersions(p2Id)).toBe(1);

    const preview = unwrap(await previewAttachment4Import(p2Id, form(renamed, { blockIndex: '0', plan81Row: '0' })));
    if (preview.parse.status !== 'ok') throw new Error(preview.parse.status);
    expect(preview.selection).toEqual({ blockIndex: 0, plan81Row: 0 });
    expect(preview.parse.plan81.mode).toBe('chosen');

    const created = unwrap(
      await commitAttachment4Import(p2Id, form(renamed), {
        fileHash: preview.fileHash, blockIndex: 0, plan81Row: 0, kind: 'adjustment', name: '조정회의본',
      })
    );
    expect(created.order).toBe(2);
    const [y1, y2] = p2Years;
    expect(byKey(await readLines(created.versionId))).toEqual(byKey(preview.parse.lines.map((l) => ({ ...l }))));
    expect(await readGovCash(created.versionId)).toEqual({ [y1!.id]: 35_000_000, [y2!.id]: 35_000_000 });
    await confirm(p2Id, created.versionId);
  });

  it("'8-1 쓰지 않음' → 정부지원 현금 행 없음 + 경고, 줄은 그대로", async () => {
    const preview = unwrap(await previewAttachment4Import(p2Id, form(bytes, { blockIndex: '0', plan81Row: 'none' })));
    if (preview.parse.status !== 'ok') throw new Error(preview.parse.status);
    expect(preview.selection).toEqual({ blockIndex: 0, plan81Row: 'none' });
    expect(preview.summary!.govCashYearCount).toBe(0);
    expect(preview.summary!.years.every((y) => y.govCash === null)).toBe(true);
    expect(preview.parse.warnings.map((w) => w.code)).toEqual(['plan81_not_used']);

    const created = unwrap(
      await commitAttachment4Import(p2Id, form(bytes), {
        fileHash: preview.fileHash, blockIndex: 0, plan81Row: 'none', kind: 'final', name: '최종협약본',
      })
    );
    expect(created.govCashYearCount).toBe(0);
    expect(created.warnings.map((w) => w.code)).toEqual(['plan81_not_used']);
    expect(await readGovCash(created.versionId)).toEqual({});
    expect(byKey(await readLines(created.versionId))).toEqual(byKey(preview.parse.lines.map((l) => ({ ...l }))));
  });
});

describe('파일·입력 오류 (S-16, SA-4)', () => {
  it('깨진 파일 → 손상 문구 그대로(VALIDATION)', async () => {
    const text = new TextEncoder().encode('이건 엑셀이 아닙니다,1,2\n');
    const error = expectCode(await previewAttachment4Import(p2Id, form(text)), 'VALIDATION');
    expect(error).toBe(UNREADABLE_WORKBOOK_MESSAGE);
  });

  it('10MB 초과 → 크기 문구(미리보기·반영 모두), 버전 늘지 않음', async () => {
    const before = await countVersions(p2Id);
    const big = new Uint8Array(MAX_UPLOAD_BYTES + 1);
    expect(expectCode(await previewAttachment4Import(p2Id, form(big)), 'VALIDATION')).toMatch(/10MB/);
    const error = expectCode(
      await commitAttachment4Import(p2Id, form(big), {
        fileHash: 'a'.repeat(64), blockIndex: 0, plan81Row: null, kind: 'amendment', name: '협약변경 1차',
      }),
      'VALIDATION'
    );
    expect(error).toMatch(/10MB/);
    expect(await countVersions(p2Id)).toBe(before);
  });

  it('지원하지 않는 확장자·잘못된 선택 값·잘못된 과제 ID는 VALIDATION', async () => {
    const bytes = xlsxBytes(load('synthetic.json'));
    expect(expectCode(await previewAttachment4Import(p2Id, form(bytes, {}, '붙임4.csv')), 'VALIDATION')).toContain(
      '.xlsx, .xlsm, .xls'
    );
    expectCode(await previewAttachment4Import(p2Id, form(bytes, { blockIndex: '-1' })), 'VALIDATION');
    expectCode(await previewAttachment4Import(p2Id, form(bytes, { plan81Row: 'x' })), 'VALIDATION');
    expectCode(await previewAttachment4Import('not-a-uuid', form(bytes)), 'VALIDATION');
  });

  it('범위 밖 blockIndex → 미리보기 blocked, 반영 RULE', async () => {
    const bytes = xlsxBytes(load('synthetic.json'));
    const preview = unwrap(await previewAttachment4Import(p2Id, form(bytes, { blockIndex: '5' })));
    expect(preview.parse.status).toBe('blocked');
    const before = await countVersions(p2Id);
    expectCode(
      await commitAttachment4Import(p2Id, form(bytes), {
        fileHash: preview.fileHash, blockIndex: 5, plan81Row: null, kind: 'amendment', name: '협약변경 1차',
      }),
      'RULE'
    );
    expect(await countVersions(p2Id)).toBe(before);
  });

  it('없는 과제 → 실패, 아무것도 만들지 않는다', async () => {
    const bytes = xlsxBytes(load('synthetic.json'));
    const ghost = '00000000-0000-4000-8000-000000000000';
    const result = await previewAttachment4Import(ghost, form(bytes));
    expect(result.ok).toBe(false);
    const commit = await commitAttachment4Import(ghost, form(bytes), {
      fileHash: 'a'.repeat(64), blockIndex: 0, plan81Row: null, kind: 'selection', name: '선정평가본',
    });
    expect(commit.ok).toBe(false);
    expect(await countVersions(ghost)).toBe(0);
  });
});

// ─── 반영 뒤 붙임4형 보기 = 파일 집계 셀 (real-structure.json, 기관 블록 6개 × 4연차) ──────────────

describe('반영 뒤 붙임4형 보기의 E1·E2·K·L·M = 파일 집계 셀', () => {
  const grid = load('real-structure.json');
  const bytes = xlsxBytes(grid);

  // 블록 시작 행 28 + 23 × index. 인건비 소계(base+5)는 실측상 입력 칸이 0이라 대조하지 않는다(T6)
  const OFFSETS = { total_personnel: 8, modified_personnel: 9, direct_subtotal: 19, indirect: 20, total: 22 } as const;

  it.each([0, 1, 2, 3, 4, 5])('블록 %i', async (blockIndex) => {
    const preview = unwrap(await previewAttachment4Import(p4Id, form(bytes, { blockIndex: String(blockIndex) })));
    if (preview.parse.status !== 'ok') throw new Error(`${preview.parse.status}: ${JSON.stringify(preview.parse).slice(0, 400)}`);
    const created = unwrap(
      await commitAttachment4Import(p4Id, form(bytes), {
        fileHash: preview.fileHash, blockIndex, plan81Row: null, kind: 'selection', name: `블록 ${blockIndex}`,
      })
    );

    const [lines, govSupport, stages] = await Promise.all([
      agreementsRepo.listLinesByVersionIds(user.client, [created.versionId]),
      agreementsRepo.listGovSupportByVersionIds(user.client, [created.versionId]),
      stagesRepo.listStages(user.client, p4Id),
    ]);
    const view = buildAttachment4View({ lines, years: p4Years, stages, govSupport, rules: [] });

    const base = 28 + 23 * blockIndex;
    p4Years.forEach((year, i) => {
      const col = 'HIJK'[i]!;
      const ci = view.plan82.columns.findIndex((c) => c.kind === 'year' && c.key === year.id);
      expect(ci).toBeGreaterThanOrEqual(0);
      for (const [rowId, offset] of Object.entries(OFFSETS)) {
        const row = view.plan82.rows.find((r) => r.rowId === rowId)!;
        const cell = row.cells[ci]!;
        const expected = get(grid, S82, `${col}${base + offset}`) * 1000;
        expect({ rowId, year: year.name, cell }).toEqual({ rowId, year: year.name, cell: { kind: 'amount', value: expected } });
      }
      // 정부지원 현금 = 8-1 A
      expect(govSupport.find((g) => g.yearId === year.id)?.govCash).toBe(get(grid, S81, `E${10 + 12 * i + 2 * blockIndex}`) * 1000);
    });

    // 다음 블록을 위해 지운다 — 작성 중 1개(AV-2)
    await agreementsRepo.removeVersion(user.client, created.versionId);
  });
});
