// 엑셀 예산 임포트 **액션 계층** 통합 테스트 — 서버 액션 → RPC → DB 왕복
// (SOT §9 Budget Import, §6.8 전체(특히 I-17·I-18), §5.12·§5.12.2, 부록 B.6)
//
// tests/unit/import-samples.test.ts가 **파싱 계층**(시트 추천·구조 감지·미매핑 0건·소계 교차검증)을
// 이미 고정했다. 여기서는 그것을 다시 하지 않고, 그 위의 계층만 본다:
//   inspectWorkbook → analyzeSheet → previewImport → commitImport → commit_import RPC → budget_items
// 즉 SheetJS 어댑터(lib/import-adapter)·인증 가드·fileHash 대조·스냅샷까지 **실제 경로 그대로**다.
//
// 서버 액션은 쿠키 세션(requireApprovedUser)에서 토큰을 읽으므로 next/headers를
// "실제 세션 토큰을 돌려주는 스텁"으로 바꿔 가드까지 포함해 그대로 호출한다
// (budget-actions.test.ts와 같은 방식). revalidatePath는 요청 컨텍스트 밖이라 스텁한다.
//
// 검증의 핵심 일곱:
//   1. 왕복    — 실측 샘플 2종의 1차년도 계획액이 부록 B.6 기대값과 **원 단위까지** 일치한다.
//   2. §9      — 미리보기에서 본 것과 반영되는 것이 같다 (행별·합계 모두).
//   3. §5.12.2 — 미리보기와 **다른 파일**을 반영하면 거부되고 아무것도 쓰이지 않는다.
//   4. §7.9.1  — 오류 셀·미대응 연차 열이 남은 draft는 commit이 거부한다.
//   5. I-17    — 반영 전 계획액이 스냅샷에 남고 복원이 정확히 되돌린다.
//   6. S-9     — 파일에 없는 비목의 기존 계획액은 변하지 않는다.
//   7. 멱등성  — 같은 파일을 두 번 반영하면 결과가 같다(스냅샷만 2개).
//
// samples/는 실제 예산 자료라 .gitignore 대상이다. 없으면 **조용히 통과시키지 않고**
// 무엇이 없어 건너뛰는지 알린 뒤 skip 한다 (부록 B.6, 절대 규칙 5).
//
// 스냅샷 목록·복원도 §7.14 설정 화면이 쓰는 **액션**(listImportSnapshots/restoreImportSnapshot)을
// 그대로 부른다 — 화면이 지나는 길과 다른 길을 검증하면 액션 계층 테스트가 아니다.
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
  CommitImportResult,
  ImportDraft,
  PreviewImportResult,
} from '@/types';
import { BUDGET_CATEGORY_ORDER } from '@/lib/constants';
import * as budgetItemsRepo from '@/lib/db/budget-items';
import * as projectsRepo from '@/lib/db/projects';
import * as stagesRepo from '@/lib/db/stages';
import * as yearsRepo from '@/lib/db/years';

const session = vi.hoisted(() => ({ accessToken: '' }));

vi.mock('next/headers', () => ({
  cookies: async () => ({ get: () => ({ value: session.accessToken }) }),
}));
vi.mock('next/cache', () => ({ revalidatePath: () => undefined }));

const {
  analyzeSheet,
  commitImport,
  inspectWorkbook,
  listImportSnapshots,
  previewImport,
  restoreImportSnapshot,
} = await import('@/actions/import');

// ─── 샘플 파일 ────────────────────────────────────────────────────────────────

const SAMPLES_DIR = path.resolve(__dirname, '../../samples');
/** 자기 기관 총괄표 = 임포트 표준 대상 시트 (§6.8.2) */
const TARGET_SHEET = '유엔이_총괄표';

const available = fs.existsSync(SAMPLES_DIR)
  ? fs.readdirSync(SAMPLES_DIR).filter((f) => f.endsWith('.xlsx'))
  : [];

function hasSample(prefix: string): boolean {
  return available.some((f) => f.startsWith(prefix));
}

function samplePath(prefix: string): string {
  const file = available.find((f) => f.startsWith(prefix));
  if (!file) throw new Error(`samples/에 ${prefix} 파일이 없습니다.`);
  return path.join(SAMPLES_DIR, file);
}

/** §9: 파일은 FormData로 전달된다. 액션이 파일을 두 번 읽으므로 호출마다 새로 만든다 */
function formOf(file: string): FormData {
  const form = new FormData();
  const bytes = new Uint8Array(fs.readFileSync(file));
  form.set('file', new Blob([bytes as BlobPart]), path.basename(file));
  return form;
}

/** 1차년도(order 0) 기대값 — 부록 B.6 표를 그대로 옮긴다. 어긋나면 구현이 틀린 것이다 */
interface PlanExpectation {
  planned: number;
  cash: number | null;
  inKind: number | null;
}

interface SampleSpec {
  prefix: string;
  /** 파일에 등장하는 비목의 1차년도 기대값 (B.6). 여기 없는 비목은 그 서식에 행이 없다 (S-9) */
  year1: Partial<Record<BudgetCategory, PlanExpectation>>;
  /** 원본 `직접비 소계` 행 */
  directSubtotal: number;
  /** 원본 `연구개발비 총액` 행 */
  grandTotal: number;
}

const SAMPLES: SampleSpec[] = [
  {
    prefix: '산자부',
    year1: {
      personnel: { planned: 269_490_000, cash: 180_840_000, inKind: 88_650_000 },
      student_personnel: { planned: 0, cash: null, inKind: null },
      facility_equipment: { planned: 0, cash: 0, inKind: 0 },
      material: { planned: 0, cash: 0, inKind: 0 },
      consignment: { planned: 0, cash: 0, inKind: 0 },
      activity: { planned: 27_020_000, cash: 27_020_000, inKind: 0 },
      allowance: { planned: 0, cash: 0, inKind: 0 },
      indirect: { planned: 2_000_000, cash: null, inKind: null },
    },
    directSubtotal: 296_510_000,
    grandTotal: 298_510_000,
  },
  {
    prefix: '행안부',
    year1: {
      personnel: { planned: 104_240_000, cash: 74_240_000, inKind: 30_000_000 },
      student_personnel: { planned: 0, cash: null, inKind: null },
      facility_equipment: { planned: 0, cash: 0, inKind: 0 },
      material: { planned: 0, cash: 0, inKind: 0 },
      activity: { planned: 29_100_000, cash: 29_100_000, inKind: 0 },
      allowance: { planned: 0, cash: null, inKind: null },
      indirect: { planned: 0, cash: null, inKind: null },
    },
    directSubtotal: 133_340_000,
    grandTotal: 133_340_000,
  },
];

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

/**
 * 실측 샘플은 연차 4개(order 0~3)를 요구한다. helpers의 시드는 2개뿐이고 다른 테스트가
 * 그 구조에 의존하므로 손대지 않고, 이 테스트 안에서 과제를 새로 만들어 연차를 채운다.
 */
async function newProjectWithYears(name: string, count = 4): Promise<{
  projectId: string;
  yearIds: string[];
}> {
  const project = await projectsRepo.createProjectWithDefaults(user.client, {
    name,
    contractStartDate: '2026-01-01',
  });
  tempProjectIds.push(project.id);

  const stage = (await stagesRepo.listStages(user.client, project.id))[0];
  if (!stage) throw new Error('createProjectWithDefaults가 단계를 만들지 않았습니다.');

  // 기본 연차 1개는 RPC가 만들어 준다 — 나머지만 붙인다
  for (let i = (await yearsRepo.listYears(user.client, project.id)).length; i < count; i += 1) {
    await yearsRepo.createYear(user.client, {
      stageId: stage.id,
      name: `${i + 1}차년도`,
      startDate: `${2026 + i}-01-01`,
      endDate: `${2026 + i}-12-31`,
    });
  }

  const years = await yearsRepo.listYears(user.client, project.id);
  if (years.length !== count) throw new Error(`연차 ${count}개를 만들지 못했습니다.`);
  return { projectId: project.id, yearIds: years.map((y) => y.id) };
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

/** 연차 하나의 12비목 전부 — "나머지 비목이 0인가"까지 한 번에 본다 (§5.12: 연차당 12행) */
async function readYearPlan(yearId: string): Promise<Record<string, PlanRow>> {
  const out: Record<string, PlanRow> = {};
  for (const category of BUDGET_CATEGORY_ORDER) {
    out[category] = await readPlanRow(yearId, category);
  }
  return out;
}

async function countSnapshots(projectId: string): Promise<number> {
  const rows = await sql`
    select count(*)::text as n from public.import_snapshots where project_id = ${projectId}::uuid`;
  return Number((rows[0] as { n: string }).n);
}

/** 미리보기의 반영 대상 행만 (신규·덮어씀) */
function committedRows(preview: PreviewImportResult) {
  return preview.rows.filter((r) => r.status === 'new' || r.status === 'overwrite');
}

// ─── draft 조립 (§5.12.2) ─────────────────────────────────────────────────────

interface DraftOptions {
  /** 연차 열 중 이 열들만 yearId에 대응시킨다 (S-5 미대응 검증용) */
  onlyColumns?: string[];
  dataStartRow?: number;
  manualCategoryByRow?: Record<number, BudgetCategory>;
  fileHash?: string;
}

/**
 * analyzeSheet(액션)가 제안한 구조를 사용자가 그대로 확정한 상태의 draft.
 * 마법사 Step 2~4에서 사람이 누르는 값이 전부 여기 담긴다 (§5.12.2).
 */
async function buildDraft(
  file: string,
  yearIds: string[],
  options: DraftOptions = {}
): Promise<ImportDraft> {
  const analyzed = unwrap(await analyzeSheet(formOf(file), TARGET_SHEET));
  const structure = analyzed.structure;

  const yearColumnMappings = structure.yearColumns.map((y) => ({
    column: y.column,
    yearOrder: y.yearOrder,
  }));

  const yearMapping: Record<string, string> = {};
  for (const mapping of yearColumnMappings) {
    if (options.onlyColumns && !options.onlyColumns.includes(mapping.column)) continue;
    const yearId = yearIds[mapping.yearOrder];
    if (!yearId) throw new Error(`${mapping.yearOrder + 1}차년도에 대응할 연차가 없습니다.`);
    yearMapping[mapping.column] = yearId;
  }

  return {
    profile: {
      name: '통합 테스트 프로파일',
      kind: 'budget_plan',
      // 부처 프리셋을 쓰지 않고 공통 사전만으로 미매핑 0건이 되는지 본다 (I-2 ③)
      ministry: null,
      projectId: null,
      sheetName: TARGET_SHEET,
      headerRow: structure.headerRow ?? 0,
      dataStartRow: options.dataStartRow ?? structure.dataStartRow,
      orientation: structure.orientation,
      labelColumns: structure.labelColumns,
      yearColumnMappings,
      categoryAliases: {},
      amountUnit: structure.amountUnit,
      skipRowPatterns: [],
    },
    yearMapping,
    skippedRowIndexes: [],
    manualCategoryByRow: options.manualCategoryByRow ?? {},
    fileHash: options.fileHash ?? '',
  };
}

// ─── 준비 ─────────────────────────────────────────────────────────────────────

beforeAll(async () => {
  if (available.length === 0) return; // 샘플이 없으면 DB도 건드리지 않는다
  sql = connectDirectDb();
  user = await createTestUser(sql);
  session.accessToken = user.accessToken;
});

afterAll(async () => {
  if (available.length === 0) return;

  for (const id of tempProjectIds) {
    await sql`delete from public.projects where id = ${id}::uuid`;
  }

  // 잔여 데이터 0 확인 — 사용자 삭제 전에 본다(삭제하면 created_by가 null이 되어 추적이 끊긴다).
  // 스냅샷·예산 행은 과제 cascade로 지워져야 하므로 고아 행이 남으면 즉시 실패시킨다 (절대 규칙 5)
  let remaining = 0;
  for (const id of tempProjectIds) {
    const rows = await sql`
      select ((select count(*) from public.projects         where id         = ${id}::uuid)
            + (select count(*) from public.budget_items     where project_id = ${id}::uuid)
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

// 안내는 **항상 실행되는 테스트 안에서** 낸다. 모듈 최상단이나 skip된 describe 안에서
// console.warn을 부르면 vitest가 그 출력을 삼켜, 검증이 통째로 생략된 사실이 화면에 남지 않는다.
describe('실측 샘플 준비 상태', () => {
  it(`samples/ 확인 — ${available.length}종 발견`, () => {
    if (available.length > 0) {
      expect(available.length).toBeGreaterThan(0);
      return;
    }
    // console.warn을 쓰지 않는다 — vitest 기본 리포터는 **통과한** 테스트의 console 출력을
    // 감춰서(--reporter=verbose에서만 보인다) 안내가 화면에 남지 않는다.
    // process.stderr에 직접 쓰면 리포터를 거치지 않고 그대로 출력된다.
    process.stderr.write(
      `\n[import-actions] samples/에 .xlsx가 없어 액션 왕복 검증(부록 B.6)을 건너뜁니다.\n` +
        `  samples/는 실제 예산 자료라 .gitignore 대상입니다 — 회사 PC에서 복사해 오면 이 테스트가 살아납니다.\n` +
        `  기대 경로: ${SAMPLES_DIR}\n\n`
    );
    // 실패시키지 않는다: 샘플이 없는 것은 다른 PC에서 정상 상태다.
    // 다만 무엇이 생략됐는지는 위 안내로 반드시 화면에 남는다 (절대 규칙 5).
    expect(available).toEqual([]);
  });
});

// ─── 1·2·6. preview → commit 왕복 (부록 B.6, §9, S-9) ─────────────────────────

describe.skipIf(available.length === 0)('preview → commit 왕복 (부록 B.6)', () => {
  for (const spec of SAMPLES) {
    describe.skipIf(!hasSample(spec.prefix))(spec.prefix, () => {
      // 파일에 등장하지 않는 비목에 미리 값을 넣어 둔다 — 임포트가 이걸 건드리면 안 된다 (S-9)
      const untouchedCategory: BudgetCategory = 'promotion';
      const untouchedAmount = 3_300_000;
      // 파일에 등장하는 비목에도 값을 넣어 둔다 — 덮어씀(overwrite) 판정과 스냅샷의 대상이다
      const overwrittenBefore = 999_000_000;

      let file: string;
      let projectId: string;
      let yearIds: string[];
      let preview: PreviewImportResult;
      let committed: CommitImportResult;

      beforeAll(async () => {
        file = samplePath(spec.prefix);
        ({ projectId, yearIds } = await newProjectWithYears(`임포트 액션 ${spec.prefix}`));

        await budgetItemsRepo.updateBudgetPlan(user.client, yearIds[0]!, untouchedCategory, {
          plannedAmount: untouchedAmount,
          cashAmount: null,
          inKindAmount: null,
          updatedBy: user.id,
        });
        await budgetItemsRepo.updateBudgetPlan(user.client, yearIds[0]!, 'personnel', {
          plannedAmount: overwrittenBefore,
          cashAmount: null,
          inKindAmount: null,
          updatedBy: user.id,
        });

        const draft = await buildDraft(file, yearIds);
        preview = unwrap(await previewImport(formOf(file), draft, projectId));
        // §5.12.2: 미리보기가 계산한 fileHash를 그대로 들고 반영으로 넘어간다
        committed = unwrap(
          await commitImport(formOf(file), { ...draft, fileHash: preview.fileHash }, projectId)
        );
      });

      it(`inspectWorkbook가 ${TARGET_SHEET}를 추천한다 (S-13, 어댑터 경유)`, async () => {
        const inspected = unwrap(await inspectWorkbook(formOf(file)));
        expect(inspected.recommendedSheet).toBe(TARGET_SHEET);
        expect(inspected.fileHash).toBe(preview.fileHash);
      });

      it('미리보기가 막히지 않는다 — 사용자 결정이 필요한 행이 없다', () => {
        // 실패 시 어느 행이 왜 걸렸는지 바로 보이게 문자열로 비교한다
        const errors = preview.rows
          .filter((r) => r.status === 'error')
          .map((r) => `${r.sourceRowIndexes.join(',')}행 ${r.label ?? ''}: ${r.reason ?? ''}`);
        expect(errors).toEqual([]);
        expect(preview.unmappedYearOrders).toEqual([]);
        expect(preview.blocked).toBe(false);
        expect(preview.sheetName).toBe(TARGET_SHEET);
      });

      it('1차년도 12비목이 부록 B.6 기대값과 정확히 일치한다', async () => {
        const plan = await readYearPlan(yearIds[0]!);

        // 기대 전체 상 = B.6 값 + S-9로 유지될 기존 값 + 나머지는 0
        const expected: Record<string, PlanRow> = {};
        for (const category of BUDGET_CATEGORY_ORDER) {
          const b6 = spec.year1[category];
          if (b6) {
            expected[category] = { planned: b6.planned, cash: b6.cash, inKind: b6.inKind };
          } else if (category === untouchedCategory) {
            expected[category] = { planned: untouchedAmount, cash: null, inKind: null };
          } else {
            expected[category] = { planned: 0, cash: null, inKind: null };
          }
        }
        expect(plan).toEqual(expected);
      });

      it('원본 소계·총액과 교차검증된다 (부록 B.6)', async () => {
        const plan = await readYearPlan(yearIds[0]!);
        const direct = Object.entries(spec.year1)
          .filter(([category]) => category !== 'indirect')
          .reduce((sum, [category]) => sum + plan[category]!.planned, 0);
        expect(direct).toBe(spec.directSubtotal);
        expect(direct + plan.indirect!.planned).toBe(spec.grandTotal);
      });

      it('미리보기에서 본 것과 반영된 것이 같다 (§9)', async () => {
        const rows = committedRows(preview);
        expect(rows.length).toBeGreaterThan(0);
        expect(committed.updated).toBe(rows.length);
        // 액션이 돌려주는 summary도 미리보기의 그것이어야 한다 (두 번 계산하지 않는다)
        expect(committed.summary).toEqual(preview.summary);

        // 행별로 저장된 원본과 대조한다 — 합계만 맞고 행이 어긋나는 경우를 잡는다
        const mismatched: string[] = [];
        let total = 0;
        for (const row of rows) {
          const saved = await readPlanRow(row.yearId!, row.category!);
          total += row.plannedAmount ?? 0;
          if (
            saved.planned !== row.plannedAmount ||
            saved.cash !== row.cashAmount ||
            saved.inKind !== row.inKindAmount
          ) {
            mismatched.push(
              `${row.yearOrder}차 ${row.category}: 미리보기 ${row.plannedAmount}/${row.cashAmount}/${row.inKindAmount} ≠ DB ${saved.planned}/${saved.cash}/${saved.inKind}`
            );
          }
        }
        expect(mismatched).toEqual([]);
        expect(preview.summary.totalAmount).toBe(total);
      });

      it('덮어쓸 기존 값을 미리보기가 미리 보여준다 (§7.9.1 Step 5)', () => {
        const row = committedRows(preview).find(
          (r) => r.yearId === yearIds[0] && r.category === 'personnel'
        );
        expect(row?.status).toBe('overwrite');
        expect(row?.existing).toEqual({
          plannedAmount: overwrittenBefore,
          cashAmount: null,
          inKindAmount: null,
        });
      });

      it('S-9 — 파일에 없는 비목의 기존 계획액은 변하지 않는다', async () => {
        const kept = await readPlanRow(yearIds[0]!, untouchedCategory);
        expect(kept).toEqual({ planned: untouchedAmount, cash: null, inKind: null });

        // 미리보기도 "유지됩니다"를 사용자에게 알린다
        const reported = preview.summary.untouchedCategories.find(
          (u) => u.yearId === yearIds[0] && u.category === untouchedCategory
        );
        expect(reported).toEqual({
          yearId: yearIds[0],
          yearOrder: 0,
          category: untouchedCategory,
          plannedAmount: untouchedAmount,
        });
      });
    });
  }
});

// ─── 3·4. 반영 거부 경로 ──────────────────────────────────────────────────────

// fileHash 대조는 **다른 파일**이 필요하므로 샘플 2종이 모두 있어야 한다
const hasBothSamples = SAMPLES.every((s) => hasSample(s.prefix));

describe.skipIf(!hasBothSamples)('반영 거부 (§5.12.2 fileHash, §7.9.1 blocked)', () => {
  let projectId: string;
  let yearIds: string[];
  let file: string;
  let otherFile: string;
  let baseline: Record<string, PlanRow>;
  let snapshotsBefore: number;

  beforeAll(async () => {
    file = samplePath('산자부');
    otherFile = samplePath('행안부');
    ({ projectId, yearIds } = await newProjectWithYears('임포트 액션 거부 경로'));

    // 거부 후 "아무것도 반영되지 않았다"를 증명할 기준선
    await budgetItemsRepo.updateBudgetPlan(user.client, yearIds[0]!, 'personnel', {
      plannedAmount: 12_345_000,
      cashAmount: null,
      inKindAmount: null,
      updatedBy: user.id,
    });
    baseline = await readYearPlan(yearIds[0]!);
    snapshotsBefore = await countSnapshots(projectId);
  });

  async function expectNothingChanged(): Promise<void> {
    expect(await readYearPlan(yearIds[0]!)).toEqual(baseline);
    expect(await countSnapshots(projectId)).toBe(snapshotsBefore);
  }

  it('미리보기를 건너뛴 draft(fileHash 없음)는 거부한다', async () => {
    const draft = await buildDraft(file, yearIds);
    const result = await commitImport(formOf(file), draft, projectId);
    expect(expectCode(result, 'VALIDATION')).toContain('미리보기를 먼저 실행');
    await expectNothingChanged();
  });

  it('미리보기와 다른 파일을 올리면 거부하고 아무것도 반영하지 않는다', async () => {
    const draft = await buildDraft(file, yearIds);
    const preview = unwrap(await previewImport(formOf(file), draft, projectId));

    // 미리보기는 산자부로 했는데 반영에 행안부 파일을 올린다
    const result = await commitImport(
      formOf(otherFile),
      { ...draft, fileHash: preview.fileHash },
      projectId
    );
    expect(expectCode(result, 'VALIDATION')).toContain('다른 파일');
    await expectNothingChanged();
  });

  it('오류 셀이 있는 draft는 거부한다 (I-12)', async () => {
    // 헤더 행에 비목을 수동 지정하면 그 행의 연차 셀이 `1차년도` 텍스트라 금액 파싱이 실패한다
    const base = await buildDraft(file, yearIds);
    const headerRow = base.profile.headerRow;
    const draft: ImportDraft = {
      ...base,
      profile: { ...base.profile, dataStartRow: headerRow },
      manualCategoryByRow: { [headerRow]: 'personnel' },
    };

    const preview = unwrap(await previewImport(formOf(file), draft, projectId));
    expect(preview.blocked).toBe(true);
    expect(preview.summary.error).toBeGreaterThan(0);
    const reasons = preview.rows.filter((r) => r.status === 'error').map((r) => r.reason ?? '');
    expect(reasons.some((r) => r.includes('숫자로 읽을 수 없습니다'))).toBe(true);

    const result = await commitImport(
      formOf(file),
      { ...draft, fileHash: preview.fileHash },
      projectId
    );
    expect(expectCode(result, 'RULE')).toContain('오류');
    await expectNothingChanged();
  });

  it('미대응 연차 열이 남은 draft는 거부한다 (S-5)', async () => {
    // 4차년도(I열)를 연차에 대응시키지 않은 채로 반영을 시도한다
    const draft = await buildDraft(file, yearIds, { onlyColumns: ['F', 'G', 'H'] });

    const preview = unwrap(await previewImport(formOf(file), draft, projectId));
    expect(preview.unmappedYearOrders).toEqual([3]);
    expect(preview.blocked).toBe(true);

    const result = await commitImport(
      formOf(file),
      { ...draft, fileHash: preview.fileHash },
      projectId
    );
    expect(expectCode(result, 'RULE')).toContain('4차년도');
    await expectNothingChanged();
  });
});

// ─── 5. I-17 스냅샷 · 복원 ────────────────────────────────────────────────────

describe.skipIf(!hasSample(SAMPLES[0]!.prefix))('I-17 스냅샷과 복원', () => {
  let projectId: string;
  let yearIds: string[];
  let file: string;
  let before: Record<string, PlanRow>;

  beforeAll(async () => {
    file = samplePath(SAMPLES[0]!.prefix);
    ({ projectId, yearIds } = await newProjectWithYears('임포트 액션 스냅샷'));

    // 반영 전 상태를 서로 다른 모양으로 만들어 둔다 (덮어씀 대상 + 유지 대상)
    await budgetItemsRepo.updateBudgetPlan(user.client, yearIds[0]!, 'personnel', {
      plannedAmount: 55_000_000,
      cashAmount: 30_000_000,
      inKindAmount: 25_000_000,
      updatedBy: user.id,
    });
    await budgetItemsRepo.updateBudgetPlan(user.client, yearIds[1]!, 'activity', {
      plannedAmount: 4_000_000,
      cashAmount: null,
      inKindAmount: null,
      updatedBy: user.id,
    });
    before = await readYearPlan(yearIds[0]!);
  });

  it('반영 전 계획액이 스냅샷에 남고, 복원이 정확히 되돌린다', async () => {
    const draft = await buildDraft(file, yearIds);
    const preview = unwrap(await previewImport(formOf(file), draft, projectId));
    const committed = unwrap(
      await commitImport(formOf(file), { ...draft, fileHash: preview.fileHash }, projectId)
    );

    // 반영이 실제로 값을 바꿨는지부터 — 안 바뀌었으면 복원 검증이 무의미하다
    const after = await readYearPlan(yearIds[0]!);
    expect(after.personnel).not.toEqual(before.personnel);

    const snapshots = unwrap(await listImportSnapshots(projectId));
    expect(snapshots).toHaveLength(1);
    const snapshot = snapshots[0]!;
    expect(snapshot.id).toBe(committed.snapshotId);
    expect(snapshot.snapshot.projectId).toBe(projectId);
    expect(snapshot.snapshot.source.fileName).toBe(path.basename(file));
    expect(snapshot.snapshot.source.sheetName).toBe(TARGET_SHEET);
    expect(snapshot.snapshot.source.fileHash).toBe(preview.fileHash);
    expect(snapshot.snapshot.items).toHaveLength(committed.updated);

    // 스냅샷 항목은 **반영 직전** 값이어야 한다
    const personnelItem = snapshot.snapshot.items.find(
      (i) => i.yearId === yearIds[0] && i.category === 'personnel'
    );
    expect(personnelItem).toEqual({
      yearId: yearIds[0],
      category: 'personnel',
      plannedAmount: before.personnel!.planned,
      cashAmount: before.personnel!.cash,
      inKindAmount: before.personnel!.inKind,
      existed: true,
    });

    const restored = unwrap(await restoreImportSnapshot(snapshot.id));
    expect(restored.snapshotId).toBe(snapshot.id);
    expect(restored.restored).toBe(committed.updated);

    // 1차년도 12비목이 반영 전 상태로 정확히 돌아온다
    expect(await readYearPlan(yearIds[0]!)).toEqual(before);
    // I-17: 복원은 새 스냅샷을 만들지 않는다
    expect(await countSnapshots(projectId)).toBe(1);
  });
});

// ─── 7. 덮어쓰기 재실행 멱등성 ────────────────────────────────────────────────

describe.skipIf(!hasSample(SAMPLES[0]!.prefix))('같은 파일 두 번 반영 (덮어쓰기 멱등성)', () => {
  let projectId: string;
  let yearIds: string[];
  let file: string;

  beforeAll(async () => {
    file = samplePath(SAMPLES[0]!.prefix);
    ({ projectId, yearIds } = await newProjectWithYears('임포트 액션 멱등성'));
  });

  it('두 번째 반영 결과가 첫 번째와 같고 스냅샷만 2개가 된다', async () => {
    const draft = await buildDraft(file, yearIds);

    const first = unwrap(await previewImport(formOf(file), draft, projectId));
    const firstCommit = unwrap(
      await commitImport(formOf(file), { ...draft, fileHash: first.fileHash }, projectId)
    );
    const afterFirst = await readYearPlan(yearIds[0]!);

    const second = unwrap(await previewImport(formOf(file), draft, projectId));
    const secondCommit = unwrap(
      await commitImport(formOf(file), { ...draft, fileHash: second.fileHash }, projectId)
    );
    const afterSecond = await readYearPlan(yearIds[0]!);

    expect(afterSecond).toEqual(afterFirst);
    expect(secondCommit.updated).toBe(firstCommit.updated);
    expect(secondCommit.summary.totalAmount).toBe(firstCommit.summary.totalAmount);

    // 반영 대상 (연차, 비목) 집합은 그대로다. 첫 반영으로 값이 생긴 만큼 덮어씀이 늘어난다
    // (계획액 0 + 현금/현물 null인 셀은 두 번째에도 `신규`로 남는다 — §5.12의 12행 자동 생성 때문)
    expect(second.summary.new + second.summary.overwrite).toBe(
      first.summary.new + first.summary.overwrite
    );
    expect(second.summary.overwrite).toBeGreaterThan(first.summary.overwrite);
    expect(second.summary.totalAmount).toBe(first.summary.totalAmount);

    // I-17: 반영마다 스냅샷이 하나씩 쌓인다 (되돌릴 지점이 반영 횟수만큼 남아야 한다)
    expect(await countSnapshots(projectId)).toBe(2);
  });
});
