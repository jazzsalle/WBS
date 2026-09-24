// 부록 B.7 종단 테스트 — SOT §11 Phase 9 완료 기준을 자동 테스트로 고정한다.
// "실측 산자부 1차년도 인건비 18행을 앱에 넣으면 부록 B.7의 합계(현금 180,840,000 /
//  현물 88,650,000)와 간접비 비율 0.9622%가 그대로 나온다"
//
// (SOT 부록 B.7.1~B.7.3, 부록 B.6, §6.10.2 PL-10·PL-10a, §6.10.3 PL-11~PL-13, 부록 A.5)
//
// 다른 통합 테스트와 겹치지 않게 여기서는 **부록 B.7 데이터로 하는 종단 확인**만 한다:
// 규칙 위반 거부(PL-D1~D5)·낙관적 잠금·재정렬은 budget-plan-actions.test.ts가,
// RPC 계약 자체는 budget-plan-rpc.test.ts가 이미 고정했다.
//
// 확인하는 다섯 가지:
//  1. B.7.1 — 실제 액션으로 저장한 19행의 금액이 서식의 최종 금액과 원 단위까지 같다.
//  2. PL-10 — 그 합계가 **DB의 budget_items에** 현금 180,840,000 / 현물 88,650,000으로 있다.
//             액션 반환값이 아니라 직결 SQL로 되읽는다 — 트랜잭션 불변식의 종단 검증이다.
//  3. B.7.3 — getBudgetPlanData의 지침 검증이 E1 269,490,000 · 간접비 비율 0.9622%를 낸다.
//  4. PL-10a — lib/budget-plan.ts의 aggregateDetails 결과 = DB 저장값. 산식이 TS 한 곳에만
//              있다는 설계가 실제로 성립하는지 본다.
//  5. 부록 B.6 등가 — 같은 연차를 총괄표 임포트로 넣어도 총액 298,510,000과 지침 검증 결과가
//              같다. 두 경로가 어긋나면 어느 한쪽이 틀린 것이다(부록 B.7 말미).
//  6. Phase 13 — 같은 시드에 `moe_energy_sme` 프리셋을 적용하면 부록 B.9.1의 판정이 나오고
//              (allowance_min info · indirect_max 0.9622%), 행을 끄면 검사는 사라지되 비율은 남는다.
//              규칙이 0건일 때 Phase 9의 비율(0.00% / 0.9622%)이 그대로인 것도 여기서 고정한다.
//
// 서버 액션은 쿠키 세션(requireApprovedUser)에서 토큰을 읽으므로 next/headers를 실제 세션
// 토큰을 돌려주는 스텁으로 바꾼다 (budget-plan-actions.test.ts와 같은 방식).
//
// 자기가 만든 과제·사용자만 지운다 — 파괴적 테스트가 아니다.

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Sql } from 'postgres';
import { connectDirectDb, createTestUser, destroyTestUser, type TestUser } from './helpers';
import type { ActionResult, BudgetCategory, BudgetDetail, DetailAxis, DetailFactor } from '@/types';
import * as projectsRepo from '@/lib/db/projects';
import * as stagesRepo from '@/lib/db/stages';
import * as yearsRepo from '@/lib/db/years';
import * as membersRepo from '@/lib/db/members';
import * as budgetDetailsRepo from '@/lib/db/budget-details';
import * as importSnapshots from '@/lib/db/import-snapshots';
import type { ImportCommitRow } from '@/lib/db/import-snapshots';
import { aggregateDetails } from '@/lib/budget-plan';
import { DEFAULT_INDIRECT_BASE, RATIO_CODES } from '@/lib/rules';
import { RULE_PRESETS } from '@/lib/rules-presets';

const session = vi.hoisted(() => ({ accessToken: '' }));

vi.mock('next/headers', () => ({
  cookies: async () => ({ get: () => ({ value: session.accessToken }) }),
}));
vi.mock('next/cache', () => ({ revalidatePath: () => undefined }));

const plan = await import('@/actions/budget-plan');
const rulesActions = await import('@/actions/budget-rules');

// ─── 부록 B.7.1 인건비 (기존인력 18행 + 신규채용1) ────────────
//
// `조정액`은 서식의 참고 열이 아니라 **`최종 금액 − 산식 결과`로 역산한 값**이다(부록 B.7.1 주석):
// 유태일·김형식은 원본 참고 열이 천원 단위로 절사돼(−7,000 · −6,000) 그대로 쓰면 최종 금액이
// 각각 500원·250원 어긋난다. `최종 금액` 열이 원본의 실제 셀 값이고 그것이 기준이다.
//
// 조정액이 음수인 행은 PL-5의 "음수 금액"과 무관하다 — 최종 금액은 전부 양수다.

interface PersonnelRow {
  name: string;
  annualSalary: number;
  /** 참여율(%) */
  rate: number;
  axis: DetailAxis;
  /** 참여기간(월). 기존인력 9개월 · 신규채용 8개월 */
  months: number;
  adjustment: number;
  /** 서식의 `최종` 열 — 구현이 다른 값을 내면 구현이 틀린 것이다 */
  expected: number;
  /** 'new'는 아직 사람이 정해지지 않은 자리 (§5.11) */
  hireType: 'existing' | 'new';
}

const EXISTING = 9;
const NEW_HIRE = 8;

const B71_ROWS: PersonnelRow[] = [
  { name: '여욱현', annualSalary: 180_000_000, rate: 10.0, axis: 'cash', months: EXISTING, adjustment: 0, expected: 13_500_000, hireType: 'existing' },
  { name: '김영', annualSalary: 90_000_000, rate: 30.0, axis: 'cash', months: EXISTING, adjustment: 0, expected: 20_250_000, hireType: 'existing' },
  { name: '김지웅', annualSalary: 90_000_000, rate: 30.0, axis: 'in_kind', months: EXISTING, adjustment: 0, expected: 20_250_000, hireType: 'existing' },
  // PL-2 회귀 고정 행: 월액을 먼저 반올림하면 15,540,001이 된다
  { name: '박선욱', annualSalary: 74_000_000, rate: 28.0, axis: 'cash', months: EXISTING, adjustment: 0, expected: 15_540_000, hireType: 'existing' },
  { name: '지동민', annualSalary: 84_000_000, rate: 64.0, axis: 'in_kind', months: EXISTING, adjustment: -270_000, expected: 40_050_000, hireType: 'existing' },
  { name: '도상래', annualSalary: 64_000_000, rate: 10.0, axis: 'cash', months: EXISTING, adjustment: 0, expected: 4_800_000, hireType: 'existing' },
  { name: '이경아', annualSalary: 54_000_000, rate: 70.0, axis: 'in_kind', months: EXISTING, adjustment: 0, expected: 28_350_000, hireType: 'existing' },
  { name: '김다래', annualSalary: 54_000_000, rate: 26.0, axis: 'cash', months: EXISTING, adjustment: -30_000, expected: 10_500_000, hireType: 'existing' },
  { name: '김도현', annualSalary: 52_000_000, rate: 10.0, axis: 'cash', months: EXISTING, adjustment: 0, expected: 3_900_000, hireType: 'existing' },
  { name: '유태일', annualSalary: 46_200_000, rate: 15.0, axis: 'cash', months: EXISTING, adjustment: -7_500, expected: 5_190_000, hireType: 'existing' },
  { name: '정우진', annualSalary: 51_000_000, rate: 40.0, axis: 'cash', months: EXISTING, adjustment: 0, expected: 15_300_000, hireType: 'existing' },
  { name: '김형식', annualSalary: 43_500_000, rate: 41.0, axis: 'cash', months: EXISTING, adjustment: -6_250, expected: 13_370_000, hireType: 'existing' },
  { name: '신나리', annualSalary: 38_000_000, rate: 40.0, axis: 'cash', months: EXISTING, adjustment: 0, expected: 11_400_000, hireType: 'existing' },
  { name: '양소희', annualSalary: 39_000_000, rate: 30.0, axis: 'cash', months: EXISTING, adjustment: -5_000, expected: 8_770_000, hireType: 'existing' },
  { name: '이다정', annualSalary: 41_100_000, rate: 20.0, axis: 'cash', months: EXISTING, adjustment: -5_000, expected: 6_160_000, hireType: 'existing' },
  { name: '안승현', annualSalary: 36_000_000, rate: 14.0, axis: 'cash', months: EXISTING, adjustment: 0, expected: 3_780_000, hireType: 'existing' },
  { name: '진호령', annualSalary: 33_000_000, rate: 30.0, axis: 'cash', months: EXISTING, adjustment: -5_000, expected: 7_420_000, hireType: 'existing' },
  { name: '장선우', annualSalary: 32_000_000, rate: 29.0, axis: 'cash', months: EXISTING, adjustment: 0, expected: 6_960_000, hireType: 'existing' },
  { name: '신규채용1(청년의무)', annualSalary: 51_000_000, rate: 100.0, axis: 'cash', months: NEW_HIRE, adjustment: 0, expected: 34_000_000, hireType: 'new' },
];

/** 기존인력 18행 소계 (부록 B.7.1) */
const B71_EXISTING_CASH = 146_840_000;
/** 인건비 셀 합계 (기존인력 + 신규채용1) */
const B71_CASH = 180_840_000;
/** 현물은 기존인력 소계와 셀 합계가 같다 — 신규채용1이 현금 행이기 때문이다 */
const B71_IN_KIND = 88_650_000;
const B71_TOTAL = 269_490_000;

// ─── 부록 B.7.2 연구활동비 + 간접비 ──────────────────────────

interface QuantityRow {
  category: BudgetCategory;
  subcategory: string;
  name: string;
  unitPrice: number;
  factors: DetailFactor[];
  expected: number;
}

const B72_ROWS: QuantityRow[] = [
  {
    category: 'activity',
    subcategory: 'activity_meeting',
    name: '회의비',
    unitPrice: 500_000,
    factors: [{ label: '회', value: 6, isPercent: false }],
    expected: 3_000_000,
  },
  {
    category: 'activity',
    subcategory: 'activity_software',
    name: 'AEC Collection',
    unitPrice: 540_000,
    // 부록 A.5 주의 2: 실측 서식의 수량 라벨은 `시트(수량)`였다 — 라벨은 행마다 바뀐다
    factors: [
      { label: '시트(수량)', value: 4, isPercent: false },
      { label: '월', value: 9, isPercent: false },
    ],
    expected: 19_440_000,
  },
  {
    category: 'activity',
    subcategory: 'activity_travel_dom',
    name: '국내출장비',
    unitPrice: 150_000,
    factors: [
      { label: '인원', value: 2, isPercent: false },
      { label: '횟수', value: 4, isPercent: false },
    ],
    expected: 1_200_000,
  },
  {
    category: 'activity',
    subcategory: 'activity_etc',
    name: '인쇄/복사/인화/슬라이드 제작',
    unitPrice: 450_000,
    factors: [{ label: '회', value: 2, isPercent: false }],
    expected: 900_000,
  },
  {
    category: 'activity',
    subcategory: 'activity_etc',
    name: '위탁정산 수수료',
    unitPrice: 2_480_000,
    factors: [{ label: '회', value: 1, isPercent: false }],
    expected: 2_480_000,
  },
  {
    category: 'indirect',
    subcategory: 'indirect_support',
    name: '연구실 안전관리비',
    // PL-3: 인자가 없으면 곱이 1이다 — 산식 없이 금액만 적는 세목이 이 경우다
    unitPrice: 2_000_000,
    factors: [],
    expected: 2_000_000,
  },
];

const B72_ACTIVITY_CASH = 27_020_000;
const B72_INDIRECT_CASH = 2_000_000;

// ─── 부록 B.7.3 집계와 지침 검증 ─────────────────────────────

const B73 = {
  modifiedPersonnel: 269_490_000, // PL-11 E1 = 인건비 + 학생인건비(0)
  allowanceRate: '0.00', // PL-12 = 0 / 269,490,000
  modifiedDirectCost: 207_860_000, // PL-13 = 인건비현금 180,840,000 + 활동비현금 27,020,000
  indirectRate: '0.9622', // PL-13 = 2,000,000 / 207,860,000 (서식 셀과 소수 4자리 일치)
  directTotal: 296_510_000,
  grandTotal: 298_510_000,
} as const;

// ─── 부록 B.6 총괄표 임포트 기대값 (산자부 1차년도) ───────────
//
// 파싱 계층은 tests/unit/import-samples.test.ts가 실측 파일로 이미 고정했다.
// 여기서는 그 **결과값**을 임포트 경로(commit_import)로 넣어 산출근거 경로와 맞는지만 본다.

const B6_ROWS: Omit<ImportCommitRow, 'yearId'>[] = [
  { category: 'personnel', plannedAmount: 269_490_000, cashAmount: 180_840_000, inKindAmount: 88_650_000 },
  { category: 'student_personnel', plannedAmount: 0, cashAmount: null, inKindAmount: null },
  { category: 'facility_equipment', plannedAmount: 0, cashAmount: 0, inKindAmount: 0 },
  { category: 'material', plannedAmount: 0, cashAmount: 0, inKindAmount: 0 },
  { category: 'activity', plannedAmount: 27_020_000, cashAmount: 27_020_000, inKindAmount: 0 },
  { category: 'allowance', plannedAmount: 0, cashAmount: 0, inKindAmount: 0 },
  { category: 'consignment', plannedAmount: 0, cashAmount: 0, inKindAmount: 0 },
  // 서식의 간접비 행에는 현금/현물 축이 없다 (S-4 쌍이 아니다)
  { category: 'indirect', plannedAmount: 2_000_000, cashAmount: null, inKindAmount: null },
];

// ─── 셋업 ────────────────────────────────────────────────────

let sql: Sql;
let user: TestUser;
const tempProjectIds: string[] = []; // afterAll 안전망 — 이 테스트가 만든 과제만 지운다

let projectId: string;
/** 산출근거(제안) 경로로 쌓는 연차 — 부록 B.7 */
let planYearId: string;
/** 총괄표 임포트 경로로 넣는 연차 — 부록 B.6 등가 확인용 */
let importYearId: string;

const memberIdByName = new Map<string, string>();
/** 부록 B.7.1 행 순서와 같은 순서의 저장 결과 */
const personnelDetails: BudgetDetail[] = [];
const quantityDetails: BudgetDetail[] = [];

function unwrap<T>(result: ActionResult<T>): T {
  if (!result.ok) {
    throw new Error(`액션 실패: ${result.error} (code=${result.code ?? '-'})`);
  }
  return result.data;
}

// 액션 반환값이 아니라 저장된 원본을 본다 — PL-10 불변식은 DB만 답할 수 있다.
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

async function readDetailAmounts(ids: readonly string[]): Promise<Map<string, number>> {
  const rows = await sql`
    select id::text as id, amount::text as amount
      from public.budget_details
     where id = any(${sql.array([...ids])}::uuid[])`;
  const map = new Map<string, number>();
  for (const row of rows as unknown as { id: string; amount: string }[]) {
    map.set(row.id, Number(row.amount));
  }
  if (map.size !== ids.length) {
    throw new Error(`산출근거 ${ids.length}건 중 ${map.size}건만 저장돼 있습니다.`);
  }
  return map;
}

async function yearRules(yearId: string) {
  const data = unwrap(await plan.getBudgetPlanData(projectId));
  const view = data.yearRules.find((y) => y.yearId === yearId);
  if (!view) throw new Error('연차 지침 검증 결과가 없습니다.');
  return view.rules;
}

beforeAll(async () => {
  sql = connectDirectDb();
  user = await createTestUser(sql);
  session.accessToken = user.accessToken;

  const project = await projectsRepo.createProjectWithDefaults(user.client, {
    name: '부록 B.7 종단 테스트 과제',
    contractStartDate: '2026-01-01',
  });
  projectId = project.id;
  tempProjectIds.push(projectId);

  const firstYear = (await yearsRepo.listYears(user.client, projectId))[0];
  if (!firstYear) throw new Error('createProjectWithDefaults가 연차를 만들지 않았습니다.');
  planYearId = firstYear.id;

  const stage = (await stagesRepo.listStages(user.client, projectId))[0];
  if (!stage) throw new Error('createProjectWithDefaults가 단계를 만들지 않았습니다.');
  importYearId = (
    await yearsRepo.createYear(user.client, {
      stageId: stage.id,
      name: '2차년도(임포트 경로)',
      startDate: '2027-01-01',
      endDate: '2027-12-31',
    })
  ).id;

  // 인력 19명. 연봉이 인건비 산출의 유일한 단가 원본이다 (§5.11, PL-1)
  for (const [index, row] of B71_ROWS.entries()) {
    const member = await membersRepo.createMember(
      user.client,
      {
        projectId,
        orgId: null,
        name: row.name,
        role: 'researcher',
        position: '연구원',
        field: '',
        email: '',
        phone: '',
        active: true,
        order: index,
        annualSalary: row.annualSalary,
        hireType: row.hireType,
      },
      user.id
    );
    memberIdByName.set(row.name, member.id);
  }

  // B.7.1 인건비 19행 — 실제 서버 액션으로 저장한다.
  // 순차 실행이다: 같은 세목 안의 order는 기존 행 수로 정해지므로 병렬이면 순서가 겹친다
  for (const row of B71_ROWS) {
    const created = unwrap(
      await plan.createBudgetDetail(planYearId, 'personnel', 'personnel_internal', {
        axis: row.axis,
        memberId: memberIdByName.get(row.name),
        factors: [
          { label: '참여율(%)', value: row.rate, isPercent: true },
          { label: '참여기간(월)', value: row.months, isPercent: false },
        ],
        adjustment: row.adjustment,
      })
    );
    personnelDetails.push(created);
  }

  // B.7.2 연구활동비 5행 + 간접비 1행
  for (const row of B72_ROWS) {
    const created = unwrap(
      await plan.createBudgetDetail(planYearId, row.category, row.subcategory, {
        axis: 'cash',
        name: row.name,
        unitPrice: row.unitPrice,
        factors: row.factors,
      })
    );
    quantityDetails.push(created);
  }

  // 부록 B.6 경로 — 같은 1차년도 수치를 총괄표 임포트로 다른 연차에 넣는다
  const commit = await importSnapshots.commitImport(
    user.client,
    projectId,
    B6_ROWS.map((row) => ({ ...row, yearId: importYearId })),
    {
      fileName: '산자부_총괄표_1차년도.xlsx',
      sheetName: '유엔이_총괄표',
      profileId: null,
      fileHash: 'b'.repeat(64),
    }
  );
  if (commit.updated !== B6_ROWS.length || commit.locked !== 0) {
    throw new Error(`임포트 반영이 기대와 다릅니다: updated=${commit.updated} locked=${commit.locked}`);
  }
});

afterAll(async () => {
  for (const id of tempProjectIds) {
    await sql`delete from public.projects where id = ${id}::uuid`;
  }

  // 잔여 데이터 0 확인 — 사용자 삭제 전에 본다(삭제하면 created_by가 null이 되어 추적이 끊긴다)
  let remaining = 0;
  for (const id of tempProjectIds) {
    const rows = await sql`
      select ((select count(*) from public.projects        where id         = ${id}::uuid)
            + (select count(*) from public.budget_items    where project_id = ${id}::uuid)
            + (select count(*) from public.budget_details  where project_id = ${id}::uuid)
            + (select count(*) from public.members         where project_id = ${id}::uuid)
            + (select count(*) from public.import_snapshots where project_id = ${id}::uuid))::text as n`;
    remaining += Number((rows[0] as { n: string }).n);
  }
  if (remaining !== 0) {
    throw new Error(`테스트가 만든 데이터가 ${remaining}건 남았습니다.`);
  }

  await destroyTestUser(sql, user);
  await sql.end();
});

// ─── 1) 부록 B.7.1 인건비 ────────────────────────────────────

describe('부록 B.7.1 — 인건비 19행 (PL-1·PL-2·PL-4)', () => {
  it('행별 금액이 서식의 최종 금액과 원 단위까지 같다 (DB 저장값으로 확인)', async () => {
    const stored = await readDetailAmounts(personnelDetails.map((d) => d.id));

    // 실패해도 어느 사람의 행이 몇 원 틀렸는지 한눈에 보이게 이름 → 금액으로 비교한다
    const actual: Record<string, number> = {};
    const expected: Record<string, number> = {};
    for (const [index, row] of B71_ROWS.entries()) {
      const detail = personnelDetails[index]!;
      actual[row.name] = stored.get(detail.id)!;
      expected[row.name] = row.expected;
      // 액션 반환값도 같은 값이어야 한다 — 화면과 DB가 갈리면 안 된다
      expect(detail.amount).toBe(row.expected);
    }
    expect(actual).toEqual(expected);
  });

  it('기존인력 18행 소계가 현금 146,840,000 / 현물 88,650,000이다', async () => {
    // Phase 9 완료 기준의 "인건비 18행"이다. 신규채용 1행을 뺀 소계가 서식과 맞아야
    // 나머지 34,000,000(8개월 행)도 제자리에 있다는 뜻이 된다.
    const existingIndexes = B71_ROWS.flatMap((row, index) =>
      row.hireType === 'existing' ? [index] : []
    );
    expect(existingIndexes).toHaveLength(18);

    // 테스트 상수끼리 더하는 것은 서식 전사(轉寫) 확인일 뿐이다 — DB에 저장된 값을 더한다
    const stored = await readDetailAmounts(personnelDetails.map((d) => d.id));
    const sum = (axis: DetailAxis) =>
      existingIndexes
        .filter((index) => B71_ROWS[index]!.axis === axis)
        .reduce((acc, index) => acc + stored.get(personnelDetails[index]!.id)!, 0);

    expect(sum('cash')).toBe(B71_EXISTING_CASH);
    expect(sum('in_kind')).toBe(B71_IN_KIND);
  });

  it('PL-10 종단: budget_items에 현금 180,840,000 / 현물 88,650,000 / 계 269,490,000이 저장돼 있다', async () => {
    // 이것이 Phase 9 완료 기준의 본문이다. 액션 반환값이 아니라 DB에 그 값이 있어야 한다
    expect(await readPlanRow(planYearId, 'personnel')).toEqual({
      planned: B71_TOTAL,
      cash: B71_CASH,
      inKind: B71_IN_KIND,
    });
  });
});

// ─── 2) 부록 B.7.2 연구활동비 + 간접비 ───────────────────────

describe('부록 B.7.2 — 연구활동비 5행 + 간접비 (PL-3)', () => {
  it('행별 금액이 서식과 같고 셀 합계가 27,020,000 / 2,000,000이다', async () => {
    const stored = await readDetailAmounts(quantityDetails.map((d) => d.id));

    for (const [index, row] of B72_ROWS.entries()) {
      const detail = quantityDetails[index]!;
      expect({ name: row.name, amount: stored.get(detail.id) }).toEqual({
        name: row.name,
        amount: row.expected,
      });
      expect(detail.subcategory).toBe(row.subcategory);
    }

    expect(await readPlanRow(planYearId, 'activity')).toEqual({
      planned: B72_ACTIVITY_CASH,
      cash: B72_ACTIVITY_CASH,
      inKind: 0,
    });
    expect(await readPlanRow(planYearId, 'indirect')).toEqual({
      planned: B72_INDIRECT_CASH,
      cash: B72_INDIRECT_CASH,
      inKind: 0,
    });
  });

  it('⑪ 그 밖의 비용 세목 소계는 두 행의 합이다 (PL-6)', async () => {
    const data = unwrap(await plan.getBudgetDetails(planYearId, 'activity'));
    const etc = data.subcategories.find((s) => s.subcategory === 'activity_etc');
    expect(etc?.rowCount).toBe(2);
    expect(etc?.plannedAmount).toBe(900_000 + 2_480_000);
    expect(data.total.cashAmount).toBe(B72_ACTIVITY_CASH);
  });
});

// ─── 3) 부록 B.7.3 지침 검증 ─────────────────────────────────

describe('부록 B.7.3 — 지침 검증 (PL-11~PL-13)', () => {
  it('E1 269,490,000 · 연구수당 0.00% · 간접비 기준액 207,860,000 · 간접비 비율 0.9622%', async () => {
    const rules = await yearRules(planYearId);

    // PL-11: 인건비 + 학생인건비(0). 연구지원인력인건비(C)는 이 서식에서 0이다
    expect(rules.modifiedPersonnel).toBe(B73.modifiedPersonnel);
    expect(rules.personnelSupportTotal).toBe(0);

    // PL-12: 연구수당이 없으므로 0.00%. 0으로 나누는 것과 구분된다(E1 > 0이므로 null이 아니다)
    expect(rules.allowanceTotal).toBe(0);
    expect(rules.allowanceRate).not.toBeNull();
    expect(rules.allowanceRate!.toFixed(2)).toBe(B73.allowanceRate);

    // PL-13: 수정직접비는 직접비 11비목의 **현금** 합계다 (간접비 자신은 빠진다). 이 서식은
    // promotion·other·위탁·국제공동·부담비가 0이라 어느 base로 계산해도 같은 값이다
    expect(rules.indirectTotal).toBe(B72_INDIRECT_CASH);
    expect(rules.modifiedDirectCost).toBe(B73.modifiedDirectCost);
    // 서식의 `* 간접비 비율4)` 셀과 소수 4자리까지 일치해야 한다
    expect(rules.indirectRate).not.toBeNull();
    expect(rules.indirectRate!.toFixed(4)).toBe(B73.indirectRate);

    expect(rules.directTotal).toBe(B73.directTotal);
    expect(rules.grandTotal).toBe(B73.grandTotal);
  });

  // 한도 판정(PL-14·PL-15)은 Phase 13에서 lib/rules.ts로 옮겨졌다 — 같은 B.7 수치에 프리셋을 적용한
  // 판정은 tests/unit/rules.test.ts(부록 B.9.1)가 고정한다
});

// ─── 4) PL-10a — TS 산식과 DB 저장값의 등가 ──────────────────

describe('PL-10a — lib/budget-plan.ts 집계 = DB 저장값', () => {
  it('같은 데이터에 대해 aggregateDetails와 budget_items가 원 단위까지 일치한다', async () => {
    // 산식은 TS 한 곳에만 있고 RPC는 더하기만 한다 — 그 설계가 실제로 성립하는지 본다
    const details = (await budgetDetailsRepo.listByProject(user.client, projectId)).filter(
      (d) => d.yearId === planYearId
    );
    const members = await membersRepo.listMembers(user.client, projectId);
    const aggregate = aggregateDetails(details, members);

    expect(details).toHaveLength(B71_ROWS.length + B72_ROWS.length);
    expect(aggregate.negativeCount).toBe(0);
    expect(aggregate.missingSalaryCount).toBe(0);

    // 행 단위: DB에 저장된 amount는 TS가 계산해 넘긴 값 그대로여야 한다 (PL-10a)
    details.forEach((detail, index) => {
      expect(detail.amount).toBe(aggregate.rows[index]!.amount);
    });

    // 셀 단위: 축별 합계가 budget_items의 세 금액과 같아야 한다 (PL-7·PL-10)
    for (const cell of aggregate.cells) {
      expect({ category: cell.category, ...(await readPlanRow(planYearId, cell.category)) }).toEqual({
        category: cell.category,
        planned: cell.plannedAmount,
        cash: cell.cashAmount,
        inKind: cell.inKindAmount,
      });
    }

    // 과제 전체 합계도 같은 값이어야 한다 (임포트 연차는 산출근거가 없다)
    expect(aggregate.total).toEqual({
      cashAmount: B71_CASH + B72_ACTIVITY_CASH + B72_INDIRECT_CASH,
      inKindAmount: B71_IN_KIND,
      plannedAmount: B73.grandTotal,
    });
  });
});

// ─── 5) 부록 B.6 등가 — 총괄표 임포트 경로 ───────────────────

describe('부록 B.6 등가 — 임포트로 넣든 산출근거로 쌓든 같은 숫자다', () => {
  it('임포트 연차의 비목별 저장값이 부록 B.6 기대값과 같다', async () => {
    for (const row of B6_ROWS) {
      expect({ category: row.category, ...(await readPlanRow(importYearId, row.category)) }).toEqual({
        category: row.category,
        planned: row.plannedAmount,
        cash: row.cashAmount,
        inKind: row.inKindAmount,
      });
    }
  });

  it('두 경로의 지침 검증 결과가 완전히 같다 (총액 298,510,000)', async () => {
    const data = unwrap(await plan.getBudgetPlanData(projectId));
    const planRules = data.yearRules.find((y) => y.yearId === planYearId)?.rules;
    const importRules = data.yearRules.find((y) => y.yearId === importYearId)?.rules;
    if (!planRules || !importRules) throw new Error('연차 지침 검증 결과가 없습니다.');

    // 부록 B.7 말미: 총액 298,510,000은 부록 B.6과 같은 숫자다.
    // 두 경로가 어긋나면 어느 한쪽이 틀린 것이므로 값 하나가 아니라 판정 전체를 대조한다
    expect(importRules).toEqual(planRules);
    expect(importRules.grandTotal).toBe(B73.grandTotal);
    expect(importRules.directTotal).toBe(B73.directTotal); // 원본 `직접비 소계` 행
    expect(importRules.indirectRate!.toFixed(4)).toBe(B73.indirectRate);

    // 임포트 연차는 산출근거가 없으므로 잠기지 않는다 (PL-9) — 두 경로는 편집 가능성만 다르다
    const importCells = data.cells.filter((c) => c.yearId === importYearId);
    expect(importCells.every((c) => !c.locked)).toBe(true);
    expect(data.cells.filter((c) => c.yearId === planYearId && c.locked)).toHaveLength(3);
    expect(data.mismatchCount).toBe(0);
  });

  it('총액은 같지만 축 합계는 서식이 담은 만큼만 나뉜다 (S-4)', async () => {
    const data = unwrap(await plan.getBudgetPlanData(projectId));
    const planAxis = data.yearAxisSplits.find((y) => y.yearId === planYearId)?.axis;
    const importAxis = data.yearAxisSplits.find((y) => y.yearId === importYearId)?.axis;
    if (!planAxis || !importAxis) throw new Error('연차 축 합계가 없습니다.');

    expect(planAxis.total).toBe(B73.grandTotal);
    expect(importAxis.total).toBe(B73.grandTotal);

    // 산출근거 경로는 모든 행에 축이 있다
    expect(planAxis.cash).toBe(B71_CASH + B72_ACTIVITY_CASH + B72_INDIRECT_CASH);
    expect(planAxis.inKind).toBe(B71_IN_KIND);
    expect(planAxis.shareBlockedBy).toBeNull();

    // 총괄표의 간접비 행에는 현금/현물 구분이 없다 — 0으로 때우지 않고 비중을 막는다
    expect(importAxis.unspecified).toBe(B72_INDIRECT_CASH);
    expect(importAxis.shareBlockedBy).toBe('unspecified');
  });
});

// ─── 6) Phase 13 — 규칙 판정 (§6.14, 부록 B.9.1) ─────────────
//
// 부록 B.7.1의 hireType이 실제 값이므로(기존인력 18명 중 현금 15행, 신규채용 1행) RL-14·RL-15도
// 여기서 결정적으로 나온다. 과제 총액 3종은 비워 두어 RL-8·RL-9는 skipped로 남는다(B.9.4).

const B71_EXISTING_CASH_ROWS = B71_ROWS.filter((r) => r.hireType === 'existing' && r.axis === 'cash').length;
const B71_NEW_TOTAL = B71_ROWS.filter((r) => r.hireType === 'new').reduce((acc, r) => acc + r.expected, 0);

describe('Phase 13 — 부록 B.7 시드에 moe_energy_sme 프리셋 적용 (§6.14, 부록 B.9.1)', () => {
  // 순서가 있다: 규칙 0건 → 프리셋 적용 → 값 조정 → 끄기. it 블록은 파일 순서대로 돈다

  it('규칙 0건: findings·skipped 없음, ratios 7종은 실리고, Phase 9 비율(0.00% / 0.9622%)은 그대로다', async () => {
    const data = unwrap(await plan.getBudgetPlanData(projectId));
    expect(data.rules).toEqual([]);
    expect(data.ruleEvaluation.findings).toEqual([]);
    expect(data.ruleEvaluation.skipped).toEqual([]);
    expect(Object.keys(data.ruleEvaluation.ratios).sort()).toEqual([...RATIO_CODES].sort());

    // 행이 없어도 비율은 기본 분모(과기부 공통)로 나온다 — enabled=false는 "판정 안 함"이지 0이 아니다
    const indirect = data.ruleEvaluation.ratios.indirect_max.find((r) => r.yearId === planYearId);
    expect(indirect).toMatchObject({ enabled: false, limit: null, numerator: 2_000_000, denominator: B73.modifiedDirectCost });
    expect(indirect?.actual?.toFixed(4)).toBe(B73.indirectRate);

    const values = await yearRules(planYearId);
    expect(values.indirectBase).toBe(DEFAULT_INDIRECT_BASE);
    expect(values.allowanceRate?.toFixed(2)).toBe(B73.allowanceRate);
    expect(values.indirectRate?.toFixed(4)).toBe(B73.indirectRate);
  });

  it('프리셋 적용 → allowance_min info 1건(연차당), indirect_max 0.9622% (base=direct_cash_excl_intl), RL-14·15는 실측대로', async () => {
    const preset = RULE_PRESETS.moe_energy_sme;
    expect(unwrap(await rulesActions.applyRulePreset(projectId, 'moe_energy_sme', 'fill'))).toEqual({
      added: preset.rules.length,
      updated: 0,
      kept: 0,
    });

    const data = unwrap(await plan.getBudgetPlanData(projectId));
    expect(data.rules).toHaveLength(preset.rules.length);
    const { findings, ratios, skipped } = data.ruleEvaluation;

    // RL-5: 연구수당 0 / E1 → 권고 하한 미만 info. 산출근거 연차·임포트 연차 각각 1건(연차 단위, RL-2)
    const allowanceMin = findings.filter((f) => f.code === 'allowance_min');
    expect(allowanceMin.filter((f) => f.scope.kind === 'year' && f.scope.yearId === planYearId)).toHaveLength(1);
    expect(allowanceMin).toHaveLength(2);
    expect(allowanceMin[0]).toMatchObject({ severity: 'info', actual: 0, limit: 10, approximate: false });

    // RL-3: 기후부 분모(직접비 현금 − 국제공동)라도 이 서식에서는 같은 207,860,000 — 0.9622% 통과
    const indirect = ratios.indirect_max.find((r) => r.yearId === planYearId);
    expect(indirect).toMatchObject({ enabled: true, limit: 10, numerator: 2_000_000, denominator: B73.modifiedDirectCost });
    expect(indirect?.actual?.toFixed(4)).toBe(B73.indirectRate);
    expect(findings.some((f) => f.code === 'indirect_max')).toBe(false);
    const values = await yearRules(planYearId);
    expect(values.indirectBase).toBe('direct_cash_excl_intl');
    expect(values.indirectRate?.toFixed(4)).toBe(B73.indirectRate);

    // RL-4·6·7 통과 (0%)
    for (const code of ['allowance_max', 'consignment_max', 'external_tech_max'] as const) {
      expect(findings.some((f) => f.code === code)).toBe(false);
      expect(ratios[code].find((r) => r.yearId === planYearId)?.actual).toBe(0);
    }

    // RL-14: 기존인력 현금 행마다 1건 (산출근거 연차만 — 임포트 연차에는 행이 없다)
    const existingCash = findings.filter((f) => f.code === 'existing_personnel_cash');
    expect(existingCash).toHaveLength(B71_EXISTING_CASH_ROWS);
    expect(existingCash.every((f) => f.scope.kind === 'detail' && f.scope.yearId === planYearId)).toBe(true);
    // RL-15: 기존 현금 146,840,000 > 신규 34,000,000 → error
    const balance = findings.filter((f) => f.code === 'existing_cash_le_new');
    expect(balance).toHaveLength(1);
    expect(balance[0]).toMatchObject({ severity: 'error', actual: B71_EXISTING_CASH, limit: B71_NEW_TOTAL });
    // RL-16: 최소 참여율 10% — B.7.1의 최소는 10.0이라 통과(경계 포함)
    expect(findings.some((f) => f.code === 'min_participation')).toBe(false);
    // RL-10~13·17~19 통과
    for (const code of [
      'indirect_cash_only', 'no_personnel_support', 'no_student_personnel', 'no_burden',
      'equipment_review_threshold', 'material_notice_threshold', 'outsourcing_notice_threshold',
    ] as const) {
      expect(findings.some((f) => f.code === code)).toBe(false);
    }

    // B.9.4: 과제 총액이 비어 있으면 RL-8·RL-9는 findings가 아니라 skipped에 사유와 함께 남는다
    expect(skipped.map((s) => s.code).sort()).toEqual(['gov_share_max', 'own_cash_min']);
    expect(skipped.every((s) => s.yearId === null && s.reason.length > 0)).toBe(true);

    // severity 순 정렬 (error > warn > info)
    const order = { error: 0, warn: 1, info: 2 } as const;
    for (let i = 1; i < findings.length; i += 1) {
      expect(order[findings[i - 1]!.severity]).toBeLessThanOrEqual(order[findings[i]!.severity]);
    }
  });

  it('indirect_max 값을 0.5로 낮추면 error, 끄면 findings에서 사라지고 ratios에는 enabled:false로 남는다', async () => {
    const current = unwrap(await rulesActions.listBudgetRules(projectId)).find((r) => r.code === 'indirect_max');
    if (!current) throw new Error('indirect_max 행이 없습니다.');

    unwrap(await rulesActions.upsertBudgetRule(projectId, 'indirect_max', { value: 0.5 }, current.version));
    let data = unwrap(await plan.getBudgetPlanData(projectId));
    const over = data.ruleEvaluation.findings.find(
      (f) => f.code === 'indirect_max' && f.scope.kind === 'year' && f.scope.yearId === planYearId
    );
    if (!over) throw new Error('indirect_max 위반이 없습니다.');
    expect(over).toMatchObject({ severity: 'error', limit: 0.5 });
    expect(over.actual?.toFixed(4)).toBe(B73.indirectRate);

    unwrap(await rulesActions.upsertBudgetRule(projectId, 'indirect_max', { enabled: false }));
    data = unwrap(await plan.getBudgetPlanData(projectId));
    expect(data.ruleEvaluation.findings.some((f) => f.code === 'indirect_max')).toBe(false);
    const ratio = data.ruleEvaluation.ratios.indirect_max.find((r) => r.yearId === planYearId);
    expect(ratio).toMatchObject({ enabled: false, limit: 0.5 });
    expect(ratio?.actual?.toFixed(4)).toBe(B73.indirectRate);
    // 꺼진 행의 분모 정의는 그대로 쓴다 — 지침 검증 값도 같은 분모를 본다
    const values = await yearRules(planYearId);
    expect(values.indirectBase).toBe('direct_cash_excl_intl');
    expect(values.indirectRate?.toFixed(4)).toBe(B73.indirectRate);
  });
});
