// 부록 B.7 ↔ B.8 등가 통합 테스트 — 손 입력과 엑셀 임포트가 **같은 budget_items에 도달**한다.
//
// 부록 B.8.3 말미가 정한 그 테스트다: "부록 B.7은 같은 값을 손으로 입력했을 때의 기대치이고,
// B.8은 엑셀에서 임포트했을 때의 기대치다. 두 경로가 같은 budget_items(현금 180,840,000 /
// 현물 88,650,000 / 계 269,490,000)에 도달해야 한다 — 어긋나면 어느 한쪽이 틀렸다.
// **통합 테스트에서 이 등가를 확인한다.**"
//
// (SOT 부록 B.7.1~B.7.3, 부록 B.8.1~B.8.4, §6.10.2 PL-10·PL-10a, §6.10.3 PL-11~PL-13, §11 Phase 10)
//
// ─ 등가를 어떻게 고정하는가 ─
// 상수 표를 다른 테스트 파일에서 가져오지 않는다(테스트 파일을 import하면 그 파일의 테스트까지
// 다시 등록된다). 대신 **이 파일 안에서 두 경로를 다 돌린다**:
//   · 손 입력 경로 — tests/integration/budget-plan-b7.test.ts와 **같은 상수 표**를 그대로 옮겨
//     실제 서버 액션(createBudgetDetail)으로 한 과제에 쌓는다.
//   · 임포트 경로 — 마법사와 같은 액션 3종(inspect → preview → commit)으로 다른 과제에 넣는다.
// 그리고 두 과제의 `budget_items`·`budget_details`·지침 검증 결과를 **직결 SQL과 조회 액션으로
// 되읽어 대조**한다. 기대값을 두 곳에 적어 두고 눈으로 맞추는 방식이 아니라, 두 경로의 산출물을
// 직접 비교하므로 어느 한쪽이 바뀌면 즉시 깨진다.
//
// ─ 왜 과제를 둘로 나누는가 ─
// 한 과제에 손 입력 19명을 먼저 넣으면 임포트의 성명 매칭(D-11)이 그 명부에 붙어 D-12(새 인력
// 생성) 경로가 아예 실행되지 않는다. 등가를 볼 대상은 **서로를 모르는 두 경로**여야 한다.
//
// samples/는 실제 예산 자료라 .gitignore 대상이다. 없으면 **조용히 통과시키지 않고** 무엇이 없어
// 건너뛰는지 알린 뒤 skip 한다 (detail-import-actions.test.ts와 같은 방식, 절대 규칙 5).
//
// 자기가 만든 과제·사용자만 지운다 — 파괴적 테스트가 아니다.

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import type { Sql } from 'postgres';
import {
  ALL_BUDGET_CATEGORIES,
  connectDirectDb,
  createTestUser,
  destroyTestUser,
  type TestUser,
} from './helpers';
import type {
  ActionResult,
  BudgetCategory,
  DetailAxis,
  DetailFactor,
  DetailImportDraft,
  DetailMemberDecision,
  PreviewDetailImportResult,
} from '@/types';
import * as projectsRepo from '@/lib/db/projects';
import * as yearsRepo from '@/lib/db/years';
import * as membersRepo from '@/lib/db/members';

const session = vi.hoisted(() => ({ accessToken: '' }));

vi.mock('next/headers', () => ({
  cookies: async () => ({ get: () => ({ value: session.accessToken }) }),
}));
vi.mock('next/cache', () => ({ revalidatePath: () => undefined }));

const plan = await import('@/actions/budget-plan');
const { commitDetailImport, inspectDetailSheet, previewDetailImport } = await import(
  '@/actions/detail-import'
);

// ─── 샘플 파일 ────────────────────────────────────────────────────────────────

const SAMPLES_DIR = path.resolve(__dirname, '../../samples');
/** D-19: 시트 하나 = 연차 하나. 부록 B.8의 출처 시트 */
const DETAIL_SHEET = '1차년도_250520';

const available = fs.existsSync(SAMPLES_DIR)
  ? fs.readdirSync(SAMPLES_DIR).filter((f) => f.endsWith('.xlsx'))
  : [];
const sanjaName = available.find((f) => f.startsWith('산자부'));
const sanjaFile = sanjaName === undefined ? null : path.join(SAMPLES_DIR, sanjaName);

/** §9: 파일은 FormData로 전달된다. 액션이 파일을 두 번 읽으므로 호출마다 새로 만든다 */
function formOf(file: string): FormData {
  const form = new FormData();
  const bytes = new Uint8Array(fs.readFileSync(file));
  form.set('file', new Blob([bytes as BlobPart]), path.basename(file));
  return form;
}

// ─── 부록 B.7.1 인건비 19행 (손 입력 경로의 입력값) ───────────────────────────
//
// budget-plan-b7.test.ts의 B71_ROWS를 그대로 옮긴 표다. `조정액`은 서식의 참고 열이 아니라
// **`최종 금액 − 산식 결과`로 역산한 값**이다(부록 B.7.1 주석) — 유태일·김형식은 원본 참고 열이
// 천원 단위로 절사돼 그대로 쓰면 최종 금액이 각각 500원·250원 어긋난다.

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

// ─── 부록 B.7.2 연구활동비 5행 + 간접비 1행 (손 입력 경로의 입력값) ───────────

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

// ─── 부록 B.7.1·B.7.3 기대 금액 (두 경로가 함께 도달해야 하는 값) ─────────────

/** 인건비 셀 합계 (기존인력 + 신규채용) */
const B7_PERSONNEL_CASH = 180_840_000;
const B7_PERSONNEL_IN_KIND = 88_650_000;
const B7_PERSONNEL_TOTAL = 269_490_000;
const B7_ACTIVITY_CASH = 27_020_000;
const B7_INDIRECT_CASH = 2_000_000;

const B73 = {
  modifiedPersonnel: 269_490_000, // PL-11 E1 = 인건비 + 학생인건비(0)
  allowanceRate: '0.00', // PL-12 = 0 / 269,490,000
  modifiedDirectCost: 207_860_000, // PL-13 = 인건비현금 180,840,000 + 활동비현금 27,020,000
  indirectRate: '0.9622', // PL-13 = 2,000,000 / 207,860,000 (서식 셀과 소수 4자리 일치)
  directTotal: 296_510_000,
  grandTotal: 298_510_000, // ⚠️ 실측 총액. 다른 값이 나오면 구현이 틀린 것이다
} as const;

// ─── 부록 B.8.2 블록별 행 수 (임포트가 budget_details에 넣어야 하는 것) ───────
//
// 손 입력 경로도 정확히 같은 (비목, 세목) 묶음을 만든다 — 등가 대조의 축이다.

interface GroupExpectation {
  category: BudgetCategory;
  subcategory: string;
  rows: number;
  amount: number;
}

const B82_GROUPS: GroupExpectation[] = [
  // 기존인력 18행 + 신규채용 1행
  { category: 'personnel', subcategory: 'personnel_internal', rows: 19, amount: B7_PERSONNEL_TOTAL },
  { category: 'activity', subcategory: 'activity_meeting', rows: 1, amount: 3_000_000 },
  { category: 'activity', subcategory: 'activity_travel_dom', rows: 1, amount: 1_200_000 },
  { category: 'activity', subcategory: 'activity_software', rows: 1, amount: 19_440_000 },
  // D-21 ②: 0원 4행은 건너뜀 제안이라 저장되지 않는다
  { category: 'activity', subcategory: 'activity_etc', rows: 2, amount: 3_380_000 },
  // D-21 ②: 0원 5행은 건너뜀 제안이라 저장되지 않는다
  { category: 'indirect', subcategory: 'indirect_support', rows: 1, amount: B7_INDIRECT_CASH },
];

const B82_ROW_COUNT = B82_GROUPS.reduce((sum, g) => sum + g.rows, 0);

/** 부록 B.8.2 인건비 — 기존인력/신규채용을 인력의 채용구분(§5.11)으로 가른다 */
const B82_PERSONNEL_SPLIT = {
  existing: { rows: 18, cash: 146_840_000, inKind: B7_PERSONNEL_IN_KIND },
  new: { rows: 1, cash: 34_000_000, inKind: 0 },
} as const;

/** 부록 B.8.3 — 파일 소계 셀. 우리 합계와 일치해야 한다 (D-18) */
const B83_SUBTOTALS: Record<string, number> = {
  J88: 146_840_000,
  K88: 88_650_000,
  J91: 34_000_000,
  J92: 180_840_000,
  K92: 88_650_000,
  L92: 269_490_000,
  K181: 3_000_000,
  K188: 1_200_000,
  K201: 19_440_000,
  K243: 3_380_000,
  L150: 27_020_000,
  K279: 2_000_000,
};

// ─── 공용 상태 ────────────────────────────────────────────────────────────────

let sql: Sql;
let user: TestUser;
const tempProjectIds: string[] = []; // afterAll 안전망 — 이 테스트가 만든 과제만 지운다

/** 부록 B.7 — 손으로 입력하는 과제 */
let handProjectId: string;
let handYearId: string;
/** 부록 B.8 — 엑셀에서 임포트하는 과제 */
let importProjectId: string;
let importYearId: string;

let importPreview: PreviewDetailImportResult;
let committed: Awaited<ReturnType<typeof commitDetailImport>> extends ActionResult<infer T>
  ? T
  : never;

// 실패를 조용히 넘기지 않는다 — 실패 코드까지 메시지에 담아 원인을 드러낸다
function unwrap<T>(result: ActionResult<T>): T {
  if (!result.ok) {
    throw new Error(`액션 실패: ${result.error} (code=${result.code ?? '-'})`);
  }
  return result.data;
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

/** 12비목 전부를 한 번에 되읽는다 — 손대지 않은 비목까지 같아야 등가다 */
async function readAllPlanRows(yearId: string): Promise<Record<string, PlanRow>> {
  const result: Record<string, PlanRow> = {};
  for (const category of ALL_BUDGET_CATEGORIES) {
    result[category] = await readPlanRow(yearId, category);
  }
  return result;
}

/** 부록 B.8.2 대조용 — (비목, 세목)별 행 수와 금액을 DB에서 직접 센다 */
async function readDetailGroups(yearId: string): Promise<Record<string, { rows: number; amount: number }>> {
  const rows = await sql`
    select category, subcategory, count(*)::text as n, sum(amount)::text as total
      from public.budget_details
     where year_id = ${yearId}::uuid
     group by category, subcategory
     order by category, subcategory`;
  const result: Record<string, { rows: number; amount: number }> = {};
  for (const row of rows as unknown as {
    category: string;
    subcategory: string;
    n: string;
    total: string;
  }[]) {
    result[`${row.category}/${row.subcategory}`] = { rows: Number(row.n), amount: Number(row.total) };
  }
  return result;
}

interface PersonnelStored {
  /** 공백 차이를 지운 성명 — 파일은 `신규채용1 (청년의무)`, 손 입력은 `신규채용1(청년의무)`다 */
  name: string;
  hireType: string;
  axis: DetailAxis;
  amount: number;
}

/** 인건비 행을 인력(§5.11)과 함께 되읽는다 — 금액이 누구에게 붙었는지까지 대조한다 */
async function readPersonnelRows(yearId: string): Promise<PersonnelStored[]> {
  const rows = await sql`
    select m.name as name, m.hire_type as hire_type, d.axis as axis, d.amount::text as amount
      from public.budget_details d
      join public.members m on m.id = d.member_id
     where d.year_id = ${yearId}::uuid and d.formula = 'personnel'
     order by d.sort_order`;
  return (rows as unknown as { name: string; hire_type: string; axis: DetailAxis; amount: string }[]).map(
    (row) => ({
      name: row.name.replace(/\s+/g, ''),
      hireType: row.hire_type,
      axis: row.axis,
      amount: Number(row.amount),
    })
  );
}

async function rulesOf(projectId: string, yearId: string) {
  const data = unwrap(await plan.getBudgetPlanData(projectId));
  const view = data.yearRules.find((y) => y.yearId === yearId);
  if (!view) throw new Error('연차 지침 검증 결과가 없습니다.');
  return view.rules;
}

// ─── 손 입력 경로 (부록 B.7) ──────────────────────────────────────────────────

async function buildByHand(): Promise<void> {
  ({ projectId: handProjectId, yearId: handYearId } = await newProjectWithYear(
    '부록 B.7 손 입력 경로'
  ));

  // 인력 19명. 연봉이 인건비 산출의 유일한 단가 원본이다 (§5.11, PL-1)
  const memberIdByName = new Map<string, string>();
  for (const [index, row] of B71_ROWS.entries()) {
    const member = await membersRepo.createMember(
      user.client,
      {
        projectId: handProjectId,
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

  // 순차 실행이다: 같은 세목 안의 order는 기존 행 수로 정해지므로 병렬이면 순서가 겹친다
  for (const row of B71_ROWS) {
    unwrap(
      await plan.createBudgetDetail(handYearId, 'personnel', 'personnel_internal', {
        axis: row.axis,
        memberId: memberIdByName.get(row.name),
        factors: [
          { label: '참여율(%)', value: row.rate, isPercent: true },
          { label: '참여기간(월)', value: row.months, isPercent: false },
        ],
        adjustment: row.adjustment,
      })
    );
  }

  for (const row of B72_ROWS) {
    unwrap(
      await plan.createBudgetDetail(handYearId, row.category, row.subcategory, {
        axis: 'cash',
        name: row.name,
        unitPrice: row.unitPrice,
        factors: row.factors,
      })
    );
  }
}

// ─── 임포트 경로 (부록 B.8) — 마법사와 같은 액션 3종 ──────────────────────────

async function importFromSheet(): Promise<void> {
  ({ projectId: importProjectId, yearId: importYearId } = await newProjectWithYear(
    '부록 B.8 임포트 경로'
  ));

  const draftOf = (fileHash: string): DetailImportDraft => ({
    yearId: importYearId,
    sheetName: DETAIL_SHEET,
    fileHash,
  });

  // §7.9.3 Step 1·2 — 시트 목록·트리를 받고 대상 시트를 고른다
  const inspected = unwrap(await inspectDetailSheet(formOf(sanjaFile!)));
  if (inspected.recommendedSheet !== DETAIL_SHEET) {
    throw new Error(`추천 시트가 ${DETAIL_SHEET}가 아닙니다: ${inspected.recommendedSheet}`);
  }

  // §7.9.3 Step 3 — D-11: 명부가 비어 있으므로 성명 19건이 전부 미매칭이다.
  // 화면이 하는 그대로 서버가 낸 매칭 결과에서 결정을 끌어온다 (D-12: 새 인력으로 생성)
  const first = unwrap(await previewDetailImport(formOf(sanjaFile!), draftOf('')));
  const memberDecisions: Record<string, DetailMemberDecision> = {};
  for (const match of first.members) {
    if (match.status === 'matched') continue;
    memberDecisions[match.key] = { kind: 'create' };
  }

  // §7.9.3 Step 4 — 확정 미리보기 → 반영
  importPreview = unwrap(
    await previewDetailImport(formOf(sanjaFile!), { ...draftOf(''), memberDecisions })
  );
  committed = unwrap(
    await commitDetailImport(formOf(sanjaFile!), {
      ...draftOf(importPreview.fileHash),
      memberDecisions,
    })
  );
}

// ─── 준비 ─────────────────────────────────────────────────────────────────────

beforeAll(async () => {
  if (sanjaFile === null) return; // 샘플이 없으면 DB도 건드리지 않는다
  sql = connectDirectDb();
  user = await createTestUser(sql);
  session.accessToken = user.accessToken;

  await buildByHand();
  await importFromSheet();
}, 120_000);

afterAll(async () => {
  if (sanjaFile === null) return;

  for (const id of tempProjectIds) {
    await sql`delete from public.projects where id = ${id}::uuid`;
  }

  // 잔여 데이터 0 확인 — 사용자 삭제 전에 본다(삭제하면 created_by가 null이 되어 추적이 끊긴다)
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
// 출력을 감추므로 process.stderr에 직접 쓴다 (detail-import-actions.test.ts와 같은 이유).
describe('부록 B.7↔B.8 등가 — 샘플 준비 상태', () => {
  it(`samples/ 확인 — 산자부 ${sanjaFile ? '있음' : '없음'}`, () => {
    if (sanjaFile !== null) {
      expect(sanjaFile).toContain('산자부');
      return;
    }
    process.stderr.write(
      `\n[detail-import-b8] 부록 B.7↔B.8 등가 검증을 건너뜁니다 — samples/에 산자부 .xlsx가 없습니다.\n` +
        `  이 테스트는 손 입력 경로와 엑셀 임포트 경로가 같은 budget_items에 도달하는지 대조합니다(부록 B.8.3 말미).\n` +
        `  임포트 경로의 입력이 실측 워크북이라 파일 없이는 대조 자체가 성립하지 않습니다.\n` +
        `  samples/는 실제 예산 자료라 .gitignore 대상입니다 — 회사 PC에서 복사해 오면 이 테스트가 살아납니다.\n` +
        `  기대 경로: ${SAMPLES_DIR} (시트 ${DETAIL_SHEET})\n\n`
    );
    // 실패시키지 않는다: 샘플이 없는 것은 다른 PC에서 정상 상태다
    expect(sanjaFile).toBeNull();
  });
});

// ─── ② 임포트 결과를 DB에서 되읽는다 (부록 B.7.3 / B.8.3) ─────────────────────

describe.skipIf(sanjaFile === null)('② 임포트 반영 결과 — budget_items 직결 SQL 되읽기', () => {
  it('인건비 현금 180,840,000 / 현물 88,650,000 / 계 269,490,000', async () => {
    expect(await readPlanRow(importYearId, 'personnel')).toEqual({
      planned: B7_PERSONNEL_TOTAL,
      cash: B7_PERSONNEL_CASH,
      inKind: B7_PERSONNEL_IN_KIND,
    });
  });

  it('연구활동비 27,020,000 · 간접비 2,000,000', async () => {
    expect(await readPlanRow(importYearId, 'activity')).toEqual({
      planned: B7_ACTIVITY_CASH,
      cash: B7_ACTIVITY_CASH,
      inKind: 0,
    });
    expect(await readPlanRow(importYearId, 'indirect')).toEqual({
      planned: B7_INDIRECT_CASH,
      cash: B7_INDIRECT_CASH,
      inKind: 0,
    });
  });

  it('연차 총액이 298,510,000이다 — 섹션 밖 총괄표가 한 푼도 섞이지 않았다 (D-1)', async () => {
    const saved = await readAllPlanRows(importYearId);
    const total = Object.values(saved).reduce((sum, row) => sum + row.planned, 0);
    expect(total).toBe(B73.grandTotal);
    expect(importPreview.summary.totalAmount).toBe(B73.grandTotal);
  });

  it('B.8.3 파일 소계 12셀이 우리 합계와 일치한다 (D-18)', () => {
    const seen: Record<string, number> = {};
    const mismatched: string[] = [];
    for (const check of importPreview.subtotals) {
      const address = `${check.column}${check.row + 1}`;
      if (!(address in B83_SUBTOTALS)) continue;
      seen[address] = check.fileValue;
      if (!check.matches) {
        mismatched.push(`${address} 파일 ${check.fileValue} ≠ 우리 ${check.ourSum}`);
      }
    }
    expect(seen).toEqual(B83_SUBTOTALS);
    expect(mismatched).toEqual([]);
  });
});

// ─── ③ 부록 B.8.2 블록별 행 수가 budget_details에 그대로 들어갔는가 ───────────

describe.skipIf(sanjaFile === null)('③ 부록 B.8.2 — 블록별 행 수와 금액', () => {
  it('반영 건수가 25행이고 인력 19명을 같은 트랜잭션에서 만들었다 (D-12·D-16)', async () => {
    expect(committed.inserted).toBe(B82_ROW_COUNT);
    expect(committed.membersCreated).toBe(B71_ROWS.length);
    expect(committed.deleted).toBe(0);
    expect(committed.skippedLocked).toBe(0);
  });

  it('(비목, 세목)별 행 수·금액이 부록 B.8.2와 같다', async () => {
    const expected: Record<string, { rows: number; amount: number }> = {};
    for (const group of B82_GROUPS) {
      expected[`${group.category}/${group.subcategory}`] = {
        rows: group.rows,
        amount: group.amount,
      };
    }
    expect(await readDetailGroups(importYearId)).toEqual(expected);
  });

  it('인건비 19행이 기존인력 18행 / 신규채용 1행으로 갈린다 (B.8.2)', async () => {
    const rows = await readPersonnelRows(importYearId);
    expect(rows).toHaveLength(19);

    const fold = (hireType: string) => {
      const own = rows.filter((row) => row.hireType === hireType);
      const sum = (axis: DetailAxis) =>
        own.filter((row) => row.axis === axis).reduce((acc, row) => acc + row.amount, 0);
      return { rows: own.length, cash: sum('cash'), inKind: sum('in_kind') };
    };

    expect(fold('existing')).toEqual(B82_PERSONNEL_SPLIT.existing);
    expect(fold('new')).toEqual(B82_PERSONNEL_SPLIT.new);
  });
});

// ─── ④ 등가 — 손 입력 결과와 임포트 결과가 같다 (부록 B.8.3 말미) ─────────────

describe.skipIf(sanjaFile === null)('④ 부록 B.7 ↔ B.8 등가', () => {
  it('⭐ 두 경로의 budget_items 12비목이 원 단위까지 같다', async () => {
    const hand = await readAllPlanRows(handYearId);
    const imported = await readAllPlanRows(importYearId);

    // 값 하나가 아니라 12비목 전부를 대조한다 — 손대지 않은 비목까지 같아야 등가다
    expect(imported).toEqual(hand);

    // 그 값이 부록 B.7.1이 정한 숫자인지도 못 박는다 (둘 다 틀린 경우를 잡는다)
    expect(hand.personnel).toEqual({
      planned: B7_PERSONNEL_TOTAL,
      cash: B7_PERSONNEL_CASH,
      inKind: B7_PERSONNEL_IN_KIND,
    });
  });

  it('두 경로의 (비목, 세목)별 행 수·금액이 같다', async () => {
    expect(await readDetailGroups(importYearId)).toEqual(await readDetailGroups(handYearId));
  });

  it('인건비는 사람 단위까지 같다 — 금액이 누구에게 붙었는지도 일치한다', async () => {
    const key = (rows: PersonnelStored[]) =>
      Object.fromEntries(rows.map((row) => [row.name, `${row.axis}:${row.amount}`]));

    const hand = key(await readPersonnelRows(handYearId));
    const imported = key(await readPersonnelRows(importYearId));
    expect(imported).toEqual(hand);

    // 부록 B.7.1 표의 최종 금액 그대로인지도 본다 — 두 경로가 나란히 틀릴 수 있다
    const b71 = Object.fromEntries(
      B71_ROWS.map((row) => [row.name.replace(/\s+/g, ''), `${row.axis}:${row.expected}`])
    );
    expect(imported).toEqual(b71);
  });

  it('⑤ 지침 검증도 같다 — E1 269,490,000 · 간접비 비율 0.9622% (B.7.3)', async () => {
    const handRules = await rulesOf(handProjectId, handYearId);
    const importRules = await rulesOf(importProjectId, importYearId);

    // 값 하나가 아니라 판정 전체를 대조한다 (PL-11~PL-15)
    expect(importRules).toEqual(handRules);

    // PL-11: 인건비 + 학생인건비(0). 연구지원인력인건비(C)는 이 서식에서 0이다
    expect(importRules.modifiedPersonnel).toBe(B73.modifiedPersonnel);
    expect(importRules.personnelSupportTotal).toBe(0);

    // PL-12: 연구수당이 없으므로 0.00% (E1 > 0이라 null이 아니다)
    expect(importRules.allowanceTotal).toBe(0);
    expect(importRules.allowanceRate).not.toBeNull();
    expect(importRules.allowanceRate!.toFixed(2)).toBe(B73.allowanceRate);

    // PL-13: 수정직접비는 직접비 11비목의 **현금** 합계다 (간접비 자신은 빠진다)
    expect(importRules.indirectTotal).toBe(B7_INDIRECT_CASH);
    expect(importRules.modifiedDirectCost).toBe(B73.modifiedDirectCost);
    // 서식의 `* 간접비 비율4)` 셀과 소수 4자리까지 일치해야 한다
    expect(importRules.indirectRate).not.toBeNull();
    expect(importRules.indirectRate!.toFixed(4)).toBe(B73.indirectRate);

    expect(importRules.directTotal).toBe(B73.directTotal);
    expect(importRules.grandTotal).toBe(B73.grandTotal);
  });

  it('PL-10: 두 경로 모두 산출근거가 있는 셀이 잠겨 있고 불변식 위반이 없다', async () => {
    for (const projectId of [handProjectId, importProjectId]) {
      const data = unwrap(await plan.getBudgetPlanData(projectId));
      // 저장된 계획액 ≠ 산출근거 합계인 셀이 하나라도 있으면 등가를 논할 수 없다
      expect({ projectId, mismatchCount: data.mismatchCount }).toEqual({ projectId, mismatchCount: 0 });
      expect(data.cells.filter((cell) => cell.locked).map((cell) => cell.category).sort()).toEqual([
        'activity',
        'indirect',
        'personnel',
      ]);
    }
  });
});
