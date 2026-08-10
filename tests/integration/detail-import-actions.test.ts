// 산출근거 임포트 **액션 계층** 통합 테스트 — 서버 액션 → RPC → DB 왕복
// (SOT §9 Budget Detail Import, §6.11 전체(특히 D-1·D-12·D-15·D-16·D-19), §5.12.2, 부록 B.8)
//
// tests/unit/import-detail-samples.test.ts가 **파싱 계층**(섹션·블록·행·소계·조정액)을 이미
// 고정했고 tests/integration/detail-import-rpc.test.ts가 **RPC 계층**을 고정했다. 여기서는 그
// 사이의 유일한 통로만 본다:
//   inspectDetailSheet → previewDetailImport → commitDetailImport → commit_detail_import → DB
// 즉 SheetJS 어댑터·인증 가드·fileHash 대조·명부 조회·RPC 페이로드 변환까지 **실제 경로 그대로**다.
//
// 검증의 핵심 다섯 (태스크 완료 기준):
//   ① 결정론  — preview를 두 번 불러도 결과가 완전히 같다 (§9: 같은 파이프라인 하나)
//   ② §5.12.2 — 다른 파일로 commit하면 거부되고 아무것도 쓰이지 않는다
//   ③ D-12    — preview는 DB를 한 행도 바꾸지 않는다 (members·budget_details·budget_items 불변)
//   ④ PL-10   — commit 후 budget_items가 미리보기 행의 **축별 합계**와 일치한다
//   ⑤ D-1     — 총괄표 시트를 넣으면 §7.9.1 안내 문구로 거부한다
//
// samples/는 실제 예산 자료라 .gitignore 대상이다. 없으면 **조용히 통과시키지 않고** 무엇이
// 없어 건너뛰는지 알린 뒤 skip 한다 (import-actions.test.ts와 같은 방식, 절대 규칙 5).
//
// 자기가 만든 과제·사용자만 지운다 — 파괴적 테스트가 아니다.

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import type { Sql } from 'postgres';
import { connectDirectDb, createTestUser, destroyTestUser, type TestUser } from './helpers';
import type {
  ActionResult,
  BudgetCategory,
  DetailImportDraft,
  DetailMemberDecision,
  PreviewDetailImportResult,
} from '@/types';
import * as projectsRepo from '@/lib/db/projects';
import * as yearsRepo from '@/lib/db/years';

const session = vi.hoisted(() => ({ accessToken: '' }));

vi.mock('next/headers', () => ({
  cookies: async () => ({ get: () => ({ value: session.accessToken }) }),
}));
vi.mock('next/cache', () => ({ revalidatePath: () => undefined }));

const { commitDetailImport, inspectDetailSheet, previewDetailImport } = await import(
  '@/actions/detail-import'
);

// ─── 샘플 파일 ────────────────────────────────────────────────────────────────

const SAMPLES_DIR = path.resolve(__dirname, '../../samples');
/** D-19: 시트 하나 = 연차 하나. 부록 B.8의 출처 시트 */
const DETAIL_SHEET = '1차년도_250520';
/** §6.8.2 총괄표 시트 — D-1 거부 경로의 입력이다 */
const PLAN_SHEET = '유엔이_총괄표';
/** 부록 B.8: 산자부 1차년도 산출근거의 총액 (섹션 밖 총괄표가 섞이면 두 배가 된다) */
const B8_TOTAL = 298_510_000;

const available = fs.existsSync(SAMPLES_DIR)
  ? fs.readdirSync(SAMPLES_DIR).filter((f) => f.endsWith('.xlsx'))
  : [];

function sampleFile(prefix: string): string | null {
  const found = available.find((f) => f.startsWith(prefix));
  return found === undefined ? null : path.join(SAMPLES_DIR, found);
}

const sanjaFile = sampleFile('산자부');
const haenganFile = sampleFile('행안부');

/** §9: 파일은 FormData로 전달된다. 액션이 파일을 두 번 읽으므로 호출마다 새로 만든다 */
function formOf(file: string): FormData {
  const form = new FormData();
  const bytes = new Uint8Array(fs.readFileSync(file));
  form.set('file', new Blob([bytes as BlobPart]), path.basename(file));
  return form;
}

// ─── 공용 상태 ────────────────────────────────────────────────────────────────

let sql: Sql;
let user: TestUser;
const tempProjectIds: string[] = []; // afterAll 안전망 — 실패해도 dev DB를 원복한다

// 실패를 조용히 넘기지 않는다 — 실패 코드까지 메시지에 담아 원인을 드러낸다
function unwrap<T>(result: ActionResult<T>): T {
  if (!result.ok) {
    throw new Error(`액션 실패: ${result.error} (code=${result.code ?? '-'})`);
  }
  return result.data;
}

function expectCode(result: ActionResult<unknown>, code: string): string {
  if (result.ok) throw new Error(`실패해야 하는 호출이 통과했습니다 (기대 code=${code}).`);
  expect(result.code).toBe(code);
  return result.error;
}

async function newProjectWithYear(name: string): Promise<{ projectId: string; yearId: string }> {
  const project = await projectsRepo.createProjectWithDefaults(user.client, {
    name,
    contractStartDate: '2026-01-01',
  });
  tempProjectIds.push(project.id);
  const firstYear = (await yearsRepo.listYears(user.client, project.id))[0];
  if (!firstYear) throw new Error('createProjectWithDefaults가 연차를 만들지 않았습니다.');
  return { projectId: project.id, yearId: firstYear.id };
}

// 액션 반환이 아니라 저장된 원본을 본다 — 서버가 몰래 보정했는지는 DB만 답할 수 있다.
// bigint는 postgres.js가 문자열로 주므로 text로 캐스팅해 정수로 되돌린다 (부동소수점 경유 금지)
interface PlanRow {
  planned: number;
  cash: number | null;
  inKind: number | null;
}

async function readPlanRow(yearId: string, category: BudgetCategory): Promise<PlanRow> {
  const rows = await sql`
    select planned_amount::text as planned, cash_amount::text as cash,
           in_kind_amount::text as in_kind
      from public.budget_items
     where year_id = ${yearId}::uuid and category = ${category}`;
  const row = rows[0] as
    | { planned: string; cash: string | null; in_kind: string | null }
    | undefined;
  if (!row) throw new Error(`비목 행(${category})을 찾을 수 없습니다.`);
  return {
    planned: Number(row.planned),
    cash: row.cash === null ? null : Number(row.cash),
    inKind: row.in_kind === null ? null : Number(row.in_kind),
  };
}

/** ③의 근거 — 미리보기 전후로 이 셋이 한 건도 달라지면 안 된다 */
interface RowCounts {
  members: number;
  details: number;
  items: number;
}

async function readCounts(projectId: string): Promise<RowCounts> {
  const rows = await sql`
    select (select count(*) from public.members        where project_id = ${projectId}::uuid)::text as members,
           (select count(*) from public.budget_details where project_id = ${projectId}::uuid)::text as details,
           (select count(*) from public.budget_items   where project_id = ${projectId}::uuid)::text as items`;
  const row = rows[0] as { members: string; details: string; items: string };
  return {
    members: Number(row.members),
    details: Number(row.details),
    items: Number(row.items),
  };
}

async function countSnapshots(projectId: string): Promise<number> {
  const rows = await sql`
    select count(*)::text as n from public.import_snapshots where project_id = ${projectId}::uuid`;
  return Number((rows[0] as { n: string }).n);
}

// ─── draft 조립 (§7.9.3) ──────────────────────────────────────────────────────

function baseDraft(yearId: string, sheetName: string, fileHash = ''): DetailImportDraft {
  return { yearId, sheetName, fileHash };
}

/**
 * D-11 Step 3: 명부에 없는 성명을 전부 **새 인력으로 생성**으로 정한 draft.
 * 결정 자체는 서버가 내린 매칭 결과(`preview.members`)에서 끌어온다 — 화면이 하는 일 그대로다.
 */
function withCreateDecisions(
  draft: DetailImportDraft,
  preview: PreviewDetailImportResult
): DetailImportDraft {
  const memberDecisions: Record<string, DetailMemberDecision> = {};
  for (const match of preview.members) {
    if (match.status === 'matched') continue;
    memberDecisions[match.key] = { kind: 'create' };
  }
  return { ...draft, memberDecisions };
}

// ─── 준비 ─────────────────────────────────────────────────────────────────────

beforeAll(async () => {
  if (sanjaFile === null) return; // 샘플이 없으면 DB도 건드리지 않는다
  sql = connectDirectDb();
  user = await createTestUser(sql);
  session.accessToken = user.accessToken;
});

afterAll(async () => {
  if (sanjaFile === null) return;

  for (const id of tempProjectIds) {
    await sql`delete from public.projects where id = ${id}::uuid`;
  }

  // 잔여 데이터 0 확인 — 사용자 삭제 전에 본다(삭제하면 created_by가 null이 되어 추적이 끊긴다).
  // 임포트가 만든 인력(D-12)·산출근거도 과제 cascade로 지워져야 한다 (절대 규칙 5)
  let remaining = 0;
  for (const id of tempProjectIds) {
    const rows = await sql`
      select ((select count(*) from public.projects         where id         = ${id}::uuid)
            + (select count(*) from public.members          where project_id = ${id}::uuid)
            + (select count(*) from public.budget_items     where project_id = ${id}::uuid)
            + (select count(*) from public.budget_details   where project_id = ${id}::uuid)
            + (select count(*) from public.import_snapshots where project_id = ${id}::uuid))::text as n`;
    remaining += Number((rows[0] as { n: string }).n);
  }
  if (remaining !== 0) {
    throw new Error(`테스트가 만든 데이터가 ${remaining}건 남았습니다.`);
  }

  await destroyTestUser(sql, user);
  await sql.end();
});

// ─── 샘플 준비 상태 안내 ──────────────────────────────────────────────────────

// 안내는 **항상 실행되는 테스트 안에서** 낸다. vitest 기본 리포터는 통과한 테스트의 console
// 출력을 감추므로 process.stderr에 직접 쓴다 (import-actions.test.ts와 같은 이유).
describe('실측 산출근거 샘플 준비 상태', () => {
  it(`samples/ 확인 — 산자부 ${sanjaFile ? '있음' : '없음'} / 행안부 ${haenganFile ? '있음' : '없음'}`, () => {
    if (sanjaFile !== null) {
      expect(sanjaFile).toContain('산자부');
      return;
    }
    process.stderr.write(
      `\n[detail-import-actions] samples/에 산자부 .xlsx가 없어 산출근거 임포트 액션 왕복 검증을 건너뜁니다.\n` +
        `  samples/는 실제 예산 자료라 .gitignore 대상입니다 — 회사 PC에서 복사해 오면 이 테스트가 살아납니다.\n` +
        `  기대 경로: ${SAMPLES_DIR} (시트 ${DETAIL_SHEET})\n\n`
    );
    // 실패시키지 않는다: 샘플이 없는 것은 다른 PC에서 정상 상태다
    expect(sanjaFile).toBeNull();
  });
});

// ─── inspectDetailSheet (D-1·D-19) ────────────────────────────────────────────

describe.skipIf(sanjaFile === null)('inspectDetailSheet — 시트 목록 · 트리 · 연차 제안', () => {
  it('산출근거 시트만 eligible이고 총괄표 시트는 아니다 (D-1)', async () => {
    const result = unwrap(await inspectDetailSheet(formOf(sanjaFile!)));

    const detail = result.sheets.find((s) => s.name === DETAIL_SHEET);
    const plan = result.sheets.find((s) => s.name === PLAN_SHEET);
    expect(detail?.eligible).toBe(true);
    expect(plan?.eligible).toBe(false);
    expect(plan?.blocks).toEqual([]); // 섹션이 없는 시트는 트리를 만들지 않는다
    expect(result.recommendedSheet).toBe(DETAIL_SHEET);

    // 섹션·비목·세목 트리 + 컬럼 매핑(D-4·D-7)이 실려 온다
    expect(detail!.sections.map((s) => s.kind)).toEqual(['direct', 'indirect']);
    const personnel = detail!.blocks.find(
      (b) => b.block.category === 'personnel' && b.block.roles.cashTotal !== undefined
    );
    expect(personnel).toBeDefined();
    expect(personnel!.rowCount).toBeGreaterThan(0);
    expect(Object.keys(personnel!.block.roles)).toContain('memberName');
  });

  it('시트명 `1차년도_250520`에서 연차를 제안한다 — 확정은 사용자가 한다 (D-19)', async () => {
    const result = unwrap(await inspectDetailSheet(formOf(sanjaFile!)));
    const detail = result.sheets.find((s) => s.name === DETAIL_SHEET);
    expect(detail?.suggestedYearOrder).toBe(0);
    // 총괄표 시트에는 `N차년도`가 없다 — 제안도 없다
    expect(result.sheets.find((s) => s.name === PLAN_SHEET)?.suggestedYearOrder).toBeNull();
  });
});

// ─── ①③ 결정론 · 미리보기는 DB를 바꾸지 않는다 ────────────────────────────────

describe.skipIf(sanjaFile === null)('previewDetailImport — 결정론과 무부작용', () => {
  let projectId: string;
  let yearId: string;
  let draft: DetailImportDraft;
  let preview: PreviewDetailImportResult;

  beforeAll(async () => {
    ({ projectId, yearId } = await newProjectWithYear('산출근거 액션 미리보기'));
    const first = unwrap(
      await previewDetailImport(formOf(sanjaFile!), baseDraft(yearId, DETAIL_SHEET))
    );
    // D-11: 명부가 비어 있으므로 19명 전부 미매칭 → 새 인력으로 생성을 고른다 (D-12)
    draft = withCreateDecisions(baseDraft(yearId, DETAIL_SHEET), first);
    preview = unwrap(await previewDetailImport(formOf(sanjaFile!), draft));
  });

  it('① 같은 draft·같은 파일이면 두 호출의 결과가 완전히 같다 (§9)', async () => {
    const again = unwrap(await previewDetailImport(formOf(sanjaFile!), draft));
    expect(again).toEqual(preview);
  });

  it('반영 대상 합계가 부록 B.8의 1차년도 총액과 같다 (섹션 밖 총괄표가 섞이지 않는다)', () => {
    const errors = preview.rows
      .filter((row) => row.status === 'error')
      .map((row) => `${row.sourceRow + 1}행 ${row.name || row.memberName}: ${row.reason ?? ''}`);
    expect(errors).toEqual([]);
    expect(preview.blocked).toBe(false);
    expect(preview.summary.totalAmount).toBe(B8_TOTAL);
    expect(preview.summary.newMembers).toBe(19); // 부록 B.7.1의 인건비 19행
    expect(preview.sheetName).toBe(DETAIL_SHEET);
    expect(preview.projectId).toBe(projectId);
    expect(preview.fileHash).not.toBe('');
  });

  it('세목 선택은 그 비목의 프리셋 코드만 받는다 (D-3a, PL-D4)', async () => {
    const target = preview.blocks.find((b) => b.category === 'personnel' && b.rowCount > 0);
    expect(target).toBeDefined();

    // 사용자가 D-3a ②의 제안(personnel_internal)을 바꾼 경우 — 그대로 반영된다
    const chosen = unwrap(
      await previewDetailImport(formOf(sanjaFile!), {
        ...draft,
        subcategoryChoices: { [target!.key]: 'personnel_external' },
      })
    );
    const chosenBlock = chosen.blocks.find((b) => b.key === target!.key);
    expect(chosenBlock?.subcategory).toBe('personnel_external');
    expect(chosenBlock?.needsConfirm).toBe(false); // 사용자가 골랐으므로 확인이 끝났다
    const subcategories = new Set(
      chosen.rows.filter((row) => row.blockKey === target!.key).map((row) => row.subcategory)
    );
    expect([...subcategories]).toEqual(['personnel_external']);

    // 다른 비목의 세목은 거부한다 — RPC까지 내려가면 내부 정보가 섞인 메시지가 된다 (SA-4)
    const wrongCode = await previewDetailImport(formOf(sanjaFile!), {
      ...draft,
      subcategoryChoices: { [target!.key]: 'material_purchase' },
    });
    expect(expectCode(wrongCode, 'VALIDATION')).toContain('세목이 아닙니다');

    // 이 시트에 없는 블록 키도 거부한다 — 조용히 무시하면 고르지 않은 세목으로 반영된다
    const wrongKey = await previewDetailImport(formOf(sanjaFile!), {
      ...draft,
      subcategoryChoices: { 'personnel:0:-:0': 'personnel_internal' },
    });
    expect(expectCode(wrongKey, 'VALIDATION')).toContain('감지한 표와 맞지 않습니다');
  });

  // 축 재지정 검증(validateBlockChoices)은 `'use server'` 파일 안이라 단위 테스트로 부를 수 없다.
  // 순수 함수(buildDetailPreview)는 못 바꾸는 행의 재지정을 **무시**할 뿐이고, 사용자에게 이유를
  // 알리는 **거부**는 이 경로에만 있다 — 여기서 잡지 않으면 어디서도 잡히지 않는다.
  it('축 재지정은 합계 열만 있는 행에만 듣고, 갈린 행·모르는 행은 거부한다 (D-9)', async () => {
    const suggested = preview.rows.find((row) => row.axisSuggested);
    const split = preview.rows.find((row) => !row.axisSuggested);
    expect(suggested).toBeDefined();
    expect(split).toBeDefined();

    // 파서가 현금으로 제안한 행은 사용자가 현물로 바꿀 수 있다
    const moved = unwrap(
      await previewDetailImport(formOf(sanjaFile!), {
        ...draft,
        axisOverrides: { [suggested!.key]: 'in_kind' },
      })
    );
    expect(moved.rows.find((row) => row.key === suggested!.key)).toMatchObject({
      axis: 'in_kind',
      axisAuto: suggested!.axisAuto,
    });

    // 파일이 현금·현물을 명시해 갈린 행은 거부한다 — 조용히 무시하면 사용자는 바꿨다고 믿는데
    // 파일 축 그대로 반영되고, 화면에는 그 재지정을 지울 셀렉트가 없어 갇힌다
    const splitRejected = await previewDetailImport(formOf(sanjaFile!), {
      ...draft,
      axisOverrides: { [split!.key]: split!.axis === 'cash' ? 'in_kind' : 'cash' },
    });
    expect(expectCode(splitRejected, 'VALIDATION')).toContain('축을 바꿀 수 없습니다');

    // 이 시트에 없는 행 키도 거부한다 (세목·통화 확인과 같은 규약)
    const unknownRejected = await previewDetailImport(formOf(sanjaFile!), {
      ...draft,
      axisOverrides: { '9999:0': 'in_kind' },
    });
    expect(expectCode(unknownRejected, 'VALIDATION')).toContain('감지한 행과 맞지 않습니다');
  });

  it('③ 미리보기는 DB를 한 행도 바꾸지 않는다 (D-12: 새 인력도 만들지 않는다)', async () => {
    const before = await readCounts(projectId);
    unwrap(await previewDetailImport(formOf(sanjaFile!), draft));
    unwrap(await previewDetailImport(formOf(sanjaFile!), { ...draft, replaceCategories: ['personnel'] }));
    const after = await readCounts(projectId);

    expect(after).toEqual(before);
    expect(after.members).toBe(0); // 미리보기가 19명을 만들었다면 여기서 걸린다
    expect(after.details).toBe(0);
    expect(await countSnapshots(projectId)).toBe(0);
  });
});

// ─── ④ commit → budget_items = 축별 합계 (PL-10) ──────────────────────────────

describe.skipIf(sanjaFile === null)('commitDetailImport — 반영 결과', () => {
  let projectId: string;
  let yearId: string;
  let preview: PreviewDetailImportResult;
  let committed: Awaited<ReturnType<typeof commitDetailImport>> extends ActionResult<infer T>
    ? T
    : never;

  beforeAll(async () => {
    ({ projectId, yearId } = await newProjectWithYear('산출근거 액션 반영'));
    const first = unwrap(
      await previewDetailImport(formOf(sanjaFile!), baseDraft(yearId, DETAIL_SHEET))
    );
    const draft = withCreateDecisions(baseDraft(yearId, DETAIL_SHEET), first);
    preview = unwrap(await previewDetailImport(formOf(sanjaFile!), draft));
    committed = unwrap(
      await commitDetailImport(formOf(sanjaFile!), { ...draft, fileHash: preview.fileHash })
    );
  });

  it('미리보기에서 본 행 수·인력 수가 그대로 반영된다 (§9, D-12)', async () => {
    expect(committed.inserted).toBe(preview.summary.new);
    expect(committed.membersCreated).toBe(preview.summary.newMembers);
    expect(committed.deleted).toBe(0);
    expect(committed.skippedLocked).toBe(0); // D-15a: 빈 셀뿐이라 건너뛸 것이 없다
    expect(committed.summary).toEqual(preview.summary);

    const counts = await readCounts(projectId);
    expect(counts.details).toBe(preview.summary.new);
    expect(counts.members).toBe(preview.summary.newMembers);
    expect(await countSnapshots(projectId)).toBe(1); // D-17
  });

  it('④ budget_items가 미리보기 행의 축별 합계와 일치한다 (PL-10)', async () => {
    const expected = new Map<BudgetCategory, PlanRow>();
    for (const row of preview.rows) {
      if (row.status !== 'new') continue;
      const current = expected.get(row.category) ?? { planned: 0, cash: 0, inKind: 0 };
      current.planned += row.amount;
      if (row.axis === 'cash') current.cash = (current.cash ?? 0) + row.amount;
      else current.inKind = (current.inKind ?? 0) + row.amount;
      expected.set(row.category, current);
    }
    expect(expected.size).toBeGreaterThan(0);

    const mismatched: string[] = [];
    let total = 0;
    for (const [category, want] of expected) {
      const saved = await readPlanRow(yearId, category);
      total += want.planned;
      if (
        saved.planned !== want.planned ||
        saved.cash !== want.cash ||
        saved.inKind !== want.inKind
      ) {
        mismatched.push(
          `${category}: 미리보기 ${want.planned}/${want.cash}/${want.inKind} ≠ DB ${saved.planned}/${saved.cash}/${saved.inKind}`
        );
      }
    }
    expect(mismatched).toEqual([]);
    expect(total).toBe(B8_TOTAL);

    // 부록 B.7: 인건비 셀의 현금/현물이 총괄표(§6.8)의 값과 같아야 한다 — 두 임포트의 접점이다
    expect(await readPlanRow(yearId, 'personnel')).toEqual({
      planned: 269_490_000,
      cash: 180_840_000,
      inKind: 88_650_000,
    });
  });

  it('반영된 amount가 PL-10a대로 미리보기 값 그대로다 (산식 사본이 없다)', async () => {
    const rows = await sql`
      select amount::text as amount, sort_order, name
        from public.budget_details
       where year_id = ${yearId}::uuid and category = 'personnel'
       order by sort_order`;
    const saved = (rows as unknown as { amount: string }[]).map((r) => Number(r.amount));
    const wanted = preview.rows
      .filter((row) => row.status === 'new' && row.category === 'personnel')
      .sort((a, b) => a.sortOrder - b.sortOrder)
      .map((row) => row.amount);
    expect(saved).toEqual(wanted);
  });
});

// ─── ② fileHash 대조 (§5.12.2) ────────────────────────────────────────────────

describe.skipIf(sanjaFile === null || haenganFile === null)('반영 거부 — fileHash (§5.12.2)', () => {
  let projectId: string;
  let yearId: string;

  beforeAll(async () => {
    ({ projectId, yearId } = await newProjectWithYear('산출근거 액션 거부'));
  });

  async function expectNothingWritten(): Promise<void> {
    expect(await readCounts(projectId)).toMatchObject({ members: 0, details: 0 });
    expect(await countSnapshots(projectId)).toBe(0);
  }

  it('미리보기를 건너뛴 draft(fileHash 없음)는 거부한다', async () => {
    const result = await commitDetailImport(
      formOf(sanjaFile!),
      baseDraft(yearId, DETAIL_SHEET)
    );
    expect(expectCode(result, 'VALIDATION')).toContain('미리보기를 먼저 실행');
    await expectNothingWritten();
  });

  it('② 미리보기와 다른 파일을 올리면 거부하고 아무것도 반영하지 않는다', async () => {
    const draft = baseDraft(yearId, DETAIL_SHEET);
    const preview = unwrap(await previewDetailImport(formOf(sanjaFile!), draft));

    // 미리보기는 산자부로 했는데 반영에 행안부 파일을 올린다
    const result = await commitDetailImport(formOf(haenganFile!), {
      ...draft,
      fileHash: preview.fileHash,
    });
    expect(expectCode(result, 'VALIDATION')).toContain('다른 파일');
    await expectNothingWritten();
  });
});

// ─── ⑤ D-1 총괄표 거부 ────────────────────────────────────────────────────────

describe.skipIf(sanjaFile === null)('총괄표 시트 거부 (D-1)', () => {
  let yearId: string;

  beforeAll(async () => {
    ({ yearId } = await newProjectWithYear('산출근거 액션 총괄표 거부'));
  });

  it('⑤ 총괄표 시트를 넣으면 §7.9.1로 안내하며 거부한다', async () => {
    const result = await previewDetailImport(formOf(sanjaFile!), baseDraft(yearId, PLAN_SHEET));
    const message = expectCode(result, 'RULE');
    expect(message).toContain('엑셀 가져오기');
    expect(message).toContain('§7.9.1');
  });

  it('반영 경로도 같은 문구로 거부한다 — 미리보기를 우회할 수 없다', async () => {
    const result = await commitDetailImport(formOf(sanjaFile!), {
      ...baseDraft(yearId, PLAN_SHEET),
      // fileHash가 맞아도 D-1에서 막힌다
      fileHash: unwrap(await inspectDetailSheet(formOf(sanjaFile!))).fileHash,
    });
    expect(expectCode(result, 'RULE')).toContain('§7.9.1');
  });
});
