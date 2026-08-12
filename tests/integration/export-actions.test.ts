// 제출 서식 내보내기 **액션 계층** 통합 테스트 — 서버 액션 → 템플릿 → 파일 → 다시 임포트 → DB
// (SOT §6.12 X-9~X-12, §7.9.4, §6.11 D-1·D-3a·D-11~D-15, §11 Phase 11 왕복 기준, 부록 B.7·B.8)
//
// tests/unit/export-roundtrip.test.ts가 **순수 계층 + 두 어댑터**의 왕복(앱 데이터 → 파일 →
// 파서)을 이미 고정했다. 거기서 멈추면 두 가지가 비어 있다:
//   ① 액션이 DB를 건드리지 않는다는 사실 (X-11) — 순수 계층에는 DB가 없으니 확인할 수 없다
//   ② 파서까지가 아니라 **`budget_details`까지** 왕복이 닫히는가 (§11 Phase 11 완료 기준)
// 이 파일이 그 둘을 본다. 검증의 축은 다섯이다:
//   ① X-11    — 내보내기 전후로 DB가 한 행도 달라지지 않는다 (스냅샷도 남기지 않는다)
//   ② N-13    — 다른 과제의 연차를 넘기면 거부한다 (FK가 막지 못하는 경계)
//   ③ X-5     — blockers가 있으면 파일을 만들지 않는다
//   ④ X-12    — 파일명에 과제명·연차·생성일이 들어가고 금지 문자가 치환된다
//   ⑤ ⭐왕복  — 내보낸 파일을 §6.11 임포트 3종(inspect→preview→commit)에 그대로 먹이면
//                **다른 과제의 `budget_details`가 원본과 같은 값**에 도달한다
//
// ⑤는 tests/integration/detail-import-b8.test.ts의 방식 그대로다 — 기대값을 두 곳에 적어 눈으로
// 맞추는 대신 **두 과제의 산출물을 직접 대조**한다. 다만 왕복이 보존하지 **못하는** 것이 둘 있고
// (서식에 자리가 없는 근거 · 인자 라벨), 그건 감추지 않고 이 파일에서 명시적으로 못 박는다.
//
// 입력은 samples/가 아니라 **부록 B.7의 상수 표**다(budget-plan-b7 / detail-import-b8과 같은 표).
// 템플릿은 저장소에 커밋돼 있으므로 이 왕복은 실측 파일 없이도 항상 돌아야 한다.
//
// 자기가 만든 과제·사용자만 지운다 — 파괴적 테스트가 아니다.

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
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
import { todayISO } from '@/lib/dates';
import * as projectsRepo from '@/lib/db/projects';
import * as yearsRepo from '@/lib/db/years';
import * as membersRepo from '@/lib/db/members';

const session = vi.hoisted(() => ({ accessToken: '' }));

vi.mock('next/headers', () => ({
  cookies: async () => ({ get: () => ({ value: session.accessToken }) }),
}));
vi.mock('next/cache', () => ({ revalidatePath: () => undefined }));

const plan = await import('@/actions/budget-plan');
const { exportSubmissionWorkbook, previewSubmissionExport } = await import('@/actions/export');
const { commitDetailImport, inspectDetailSheet, previewDetailImport } = await import(
  '@/actions/detail-import'
);

// ─── 부록 B.7.1 인건비 19행 (내보낼 원본 데이터) ──────────────────────────────
//
// budget-plan-b7 / detail-import-b8과 **같은 표**다. `조정액`은 서식의 참고 열이 아니라
// `최종 금액 − 산식 결과`로 역산한 값이다 (부록 B.7.1 주석).

interface PersonnelRow {
  name: string;
  annualSalary: number;
  /** 참여율(%) */
  rate: number;
  axis: DetailAxis;
  /** 참여기간(월). 기존인력 9개월 · 신규채용 8개월 */
  months: number;
  adjustment: number;
  /** 서식의 `최종` 열 */
  expected: number;
  hireType: 'existing' | 'new';
}

const EXISTING = 9;
const NEW_HIRE = 8;

const B71_ROWS: PersonnelRow[] = [
  { name: '여욱현', annualSalary: 180_000_000, rate: 10.0, axis: 'cash', months: EXISTING, adjustment: 0, expected: 13_500_000, hireType: 'existing' },
  { name: '김영', annualSalary: 90_000_000, rate: 30.0, axis: 'cash', months: EXISTING, adjustment: 0, expected: 20_250_000, hireType: 'existing' },
  { name: '김지웅', annualSalary: 90_000_000, rate: 30.0, axis: 'in_kind', months: EXISTING, adjustment: 0, expected: 20_250_000, hireType: 'existing' },
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

// ─── 부록 B.7.2 연구활동비 5행 + B.7.3 간접비 1행 ─────────────────────────────

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
    // 부록 A.5 주의 2: 실측 서식의 수량 라벨은 `시트(수량)`였다
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

/** 부록 B.7.1·B.7.3 — 두 과제가 함께 도달해야 하는 값 */
const B7_PERSONNEL_CASH = 180_840_000;
const B7_PERSONNEL_IN_KIND = 88_650_000;
const B7_PERSONNEL_TOTAL = 269_490_000;
const B7_ACTIVITY_CASH = 27_020_000;
const B7_INDIRECT_CASH = 2_000_000;
/** 부록 B.7.3 연구개발비 총액 = 부록 B.8의 1차년도 총액 */
const B7_GRAND_TOTAL = 298_510_000;

/** 부록 B.7.1 19행 + B.7.2 6행 */
const ROW_COUNT = B71_ROWS.length + B72_ROWS.length;

/** X-2: 템플릿은 시트명에서 조직명·판본 날짜를 뗐다 */
const DETAIL_SHEET = '산출근거';
const SUMMARY_SHEET = '총괄표';

/** X-12: 윈도우·POSIX 양쪽에서 파일명에 쓸 수 없는 문자 */
const FORBIDDEN_FILENAME_CHARS = /[\\/:*?"<>|]/;

// ─── 공용 상태 ────────────────────────────────────────────────────────────────

let sql: Sql;
let user: TestUser;
const tempProjectIds: string[] = []; // afterAll 안전망 — 이 테스트가 만든 과제만 지운다

/** 부록 B.7을 손으로 넣은 과제 — 내보내기의 원본 */
let originProjectId: string;
let originYearId: string;
/** 내보낸 파일을 다시 임포트해 복원하는 과제 */
let restoreProjectId: string;
let restoreYearId: string;
/** X-5 blocker 경로 전용 (템플릿에 자리가 없는 비목 1행) */
let blockedProjectId: string;
let blockedYearId: string;

/** 원본 과제를 내보낸 xlsx. 왕복의 입력이다 */
let exportedFile: Buffer;
let exportedFileName: string;

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

/** §9: 파일은 FormData로 전달된다. 액션이 파일을 두 번 읽으므로 호출마다 새로 만든다 */
function formOf(bytes: Buffer, fileName: string): FormData {
  const form = new FormData();
  form.set('file', new Blob([new Uint8Array(bytes) as BlobPart]), fileName);
  return form;
}

// ─── DB 되읽기 (액션 반환이 아니라 저장된 원본을 본다) ────────────────────────

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

/** 12비목 전부 — 손대지 않은 비목까지 같아야 왕복이다 */
async function readAllPlanRows(yearId: string): Promise<Record<string, PlanRow>> {
  const result: Record<string, PlanRow> = {};
  for (const category of ALL_BUDGET_CATEGORIES) {
    result[category] = await readPlanRow(yearId, category);
  }
  return result;
}

/** 왕복 대조의 단위. 인건비 행은 금액이 **누구에게** 붙었는지까지 본다 */
interface StoredDetail {
  category: string;
  subcategory: string;
  axis: DetailAxis;
  formula: string;
  /** 인건비는 성명, quantity는 품명 — 두 과제의 member_id는 다를 수밖에 없다 */
  label: string;
  sortOrder: number;
  unitPrice: number;
  amount: number;
  adjustment: number;
  factors: DetailFactor[];
}

/** 파일은 `신규채용1 (청년의무)`, 손 입력은 `신규채용1(청년의무)` — 공백 차이는 왕복의 대상이 아니다 */
function normalizeLabel(label: string): string {
  return label.replace(/\s+/g, '');
}

async function readDetails(yearId: string): Promise<StoredDetail[]> {
  const rows = await sql`
    select d.category, d.subcategory, d.axis, d.formula,
           coalesce(m.name, d.name) as label,
           d.sort_order::text as sort_order, d.unit_price::text as unit_price,
           d.amount::text as amount, d.adjustment::text as adjustment, d.factors
      from public.budget_details d
      left join public.members m on m.id = d.member_id
     where d.year_id = ${yearId}::uuid
     order by d.category, d.subcategory, d.sort_order`;
  return (
    rows as unknown as {
      category: string;
      subcategory: string;
      axis: DetailAxis;
      formula: string;
      label: string;
      sort_order: string;
      unit_price: string;
      amount: string;
      adjustment: string;
      factors: DetailFactor[];
    }[]
  ).map((row) => ({
    category: row.category,
    subcategory: row.subcategory,
    axis: row.axis,
    formula: row.formula,
    label: normalizeLabel(row.label),
    sortOrder: Number(row.sort_order),
    unitPrice: Number(row.unit_price),
    amount: Number(row.amount),
    adjustment: Number(row.adjustment),
    factors: row.factors,
  }));
}

/**
 * X-11의 근거. 행 수만 보면 **삭제 1건 + 삽입 1건**이 상쇄돼 통과하므로 내용까지 함께 센다.
 * `updated_at`을 넣는 이유도 같다 — 값을 그대로 다시 쓴 UPDATE는 행 수로 드러나지 않는다.
 */
interface DbFootprint {
  counts: Record<string, number>;
  digest: string;
}

async function readFootprint(): Promise<DbFootprint> {
  const counted = await sql`
    select (select count(*) from public.budget_details)::text  as details,
           (select count(*) from public.budget_items)::text    as items,
           (select count(*) from public.members)::text         as members,
           (select count(*) from public.import_snapshots)::text as snapshots`;
  const row = counted[0] as {
    details: string;
    items: string;
    members: string;
    snapshots: string;
  };

  const digested = await sql`
    select md5(coalesce(string_agg(line, '|' order by line), '')) as digest
      from (
        select concat_ws(':', 'd', id::text, category, subcategory, axis, amount::text,
                         adjustment::text, factors::text, updated_at::text) as line
          from public.budget_details
        union all
        select concat_ws(':', 'i', id::text, category, planned_amount::text,
                         cash_amount::text, in_kind_amount::text, updated_at::text)
          from public.budget_items
        union all
        select concat_ws(':', 'm', id::text, name, annual_salary::text, updated_at::text)
          from public.members
        union all
        select concat_ws(':', 's', id::text, created_at::text) from public.import_snapshots
      ) as t`;

  return {
    counts: {
      budget_details: Number(row.details),
      budget_items: Number(row.items),
      members: Number(row.members),
      import_snapshots: Number(row.snapshots),
    },
    digest: (digested[0] as { digest: string }).digest,
  };
}

// ─── 원본 과제 만들기 (부록 B.7 손 입력) ──────────────────────────────────────

async function buildOrigin(): Promise<void> {
  // X-12: 파일명 금지 문자(`:`)를 일부러 넣는다 — 치환되지 않으면 저장할 수 없는 이름이 나간다
  ({ projectId: originProjectId, yearId: originYearId } = await newProjectWithYear(
    '제출서식 왕복:검증'
  ));

  const memberIdByName = new Map<string, string>();
  for (const [index, row] of B71_ROWS.entries()) {
    const member = await membersRepo.createMember(
      user.client,
      {
        projectId: originProjectId,
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
      await plan.createBudgetDetail(originYearId, 'personnel', 'personnel_internal', {
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
      await plan.createBudgetDetail(originYearId, row.category, row.subcategory, {
        axis: 'cash',
        name: row.name,
        unitPrice: row.unitPrice,
        factors: row.factors,
      })
    );
  }
}

// ─── 준비 ─────────────────────────────────────────────────────────────────────

beforeAll(async () => {
  sql = connectDirectDb();
  user = await createTestUser(sql);
  session.accessToken = user.accessToken;

  await buildOrigin();
  ({ projectId: restoreProjectId, yearId: restoreYearId } =
    await newProjectWithYear('제출서식 왕복 복원'));

  // X-5: 표준 서식의 산출근거에는 `연구과제추진비` 표가 없다 — 자리가 없는 비목 1행이면 막힌다
  ({ projectId: blockedProjectId, yearId: blockedYearId } =
    await newProjectWithYear('제출서식 내보내기 거부'));
  unwrap(
    await plan.createBudgetDetail(blockedYearId, 'promotion', 'default', {
      axis: 'cash',
      name: '국내 학회 참가',
      unitPrice: 300_000,
      factors: [{ label: '회', value: 2, isPercent: false }],
    })
  );

  // 왕복의 입력. 같은 파일을 여러 번 만들 이유가 없다 — X-11 검사는 자기 몫으로 한 번 더 부른다
  const exported = unwrap(await exportSubmissionWorkbook(originProjectId, originYearId));
  exportedFile = Buffer.from(exported.contentBase64, 'base64');
  exportedFileName = exported.fileName;
}, 180_000);

afterAll(async () => {
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

// ─── ① X-11 읽기 전용 ─────────────────────────────────────────────────────────

describe('X-11 — 내보내기는 앱 데이터를 한 줄도 바꾸지 않는다', () => {
  it('미리보기·내보내기 전후로 행 수와 내용이 완전히 같다 (스냅샷도 남기지 않는다)', async () => {
    const before = await readFootprint();

    // 미리보기와 실제 내보내기를 **둘 다** 태운다 — 둘은 같은 collectExport를 쓰지만
    // 파일을 만드는 쪽에만 쓰기가 섞여 들어갈 수 있다
    unwrap(await previewSubmissionExport(originProjectId, originYearId));
    unwrap(await exportSubmissionWorkbook(originProjectId, originYearId));

    const after = await readFootprint();

    // 행 수는 삭제+삽입이 상쇄되면 속는다 — 내용 digest까지 함께 본다
    expect(after.counts).toEqual(before.counts);
    expect(after.digest).toBe(before.digest);
    // 검사가 헛돌지 않았는지 — 원본 25행이 실제로 세어졌다
    expect(before.counts.budget_details).toBeGreaterThanOrEqual(ROW_COUNT);
  });
});

// ─── §7.9.4 미리보기 ──────────────────────────────────────────────────────────

describe('previewSubmissionExport — 내보내기 전 확인 (§7.9.4)', () => {
  it('반영 행 수·합계 금액이 부록 B.7 그대로이고 막을 것이 없다', async () => {
    const preview = unwrap(await previewSubmissionExport(originProjectId, originYearId));

    expect(preview.blockers).toEqual([]);
    expect(preview.rowCount).toBe(ROW_COUNT);
    // X-6: 원 단위 정수 그대로 — 표시 단위 환산은 화면의 몫이다
    expect(preview.totalAmount).toBe(B7_GRAND_TOTAL);
    // 연차 이름은 사용자 입력이라 기본 생성 직후에는 비어 있다 — 미리보기는 그것을 그대로 보여
    // 주고, 파일명만 `N차년도`로 대신한다 (X-12의 fallback. 아래 파일명 테스트가 그것을 본다)
    const year = (await yearsRepo.listYears(user.client, originProjectId))[0];
    expect(preview.yearLabel).toBe(year!.name);
    // X-3: 템플릿이 하나뿐이면 화면이 묻지 않는다. 목록은 그래도 실려 온다
    expect(preview.templates.length).toBeGreaterThanOrEqual(1);
    expect(preview.templates.map((t) => t.id)).toContain(preview.templateId);

    // 협의 중인 계획이 아니다 — 음수·연봉 미입력 경고가 뜨면 원본 구성이 틀린 것이다
    expect(preview.notices.filter((n) => n.kind === 'negative-amount')).toEqual([]);
    expect(preview.notices.filter((n) => n.kind === 'missing-salary')).toEqual([]);
  });

  it('② 다른 과제의 연차를 넘기면 거부한다 (N-13)', async () => {
    const message = expectCode(
      await previewSubmissionExport(originProjectId, restoreYearId),
      'RULE'
    );
    expect(message).toContain('속하지 않은 연차');

    // 파일을 만드는 쪽도 같은 경계를 지킨다 — 미리보기를 우회할 수 없다
    expect(
      expectCode(await exportSubmissionWorkbook(originProjectId, restoreYearId), 'RULE')
    ).toContain('속하지 않은 연차');
  });

  it('③ 서식에 자리가 없는 비목이 있으면 파일을 만들지 않는다 (X-5)', async () => {
    const preview = unwrap(await previewSubmissionExport(blockedProjectId, blockedYearId));
    expect(preview.blockers.map((b) => b.kind)).toEqual(['unmapped']);
    // 무엇이 몇 행 넘쳤는지 밝힌다 — 코드만 던지면 무엇을 고칠지 알 수 없다 (§7.9.4)
    expect(preview.blockers[0]?.label).toContain('연구과제추진비');
    expect(preview.blockers[0]?.label).toContain('1행');

    const refused = await exportSubmissionWorkbook(blockedProjectId, blockedYearId);
    expect(expectCode(refused, 'RULE')).toContain('연구과제추진비');
  });
});

// ─── ④ X-12 파일명 · 파일 형식 ────────────────────────────────────────────────

describe('exportSubmissionWorkbook — 파일명과 형식', () => {
  it('④ 파일명에 과제명·연차·생성일이 들어가고 금지 문자가 치환된다 (X-12)', () => {
    const stamp = todayISO(new Date()).replace(/-/g, '');
    expect(exportedFileName).toBe(`제출서식 왕복_검증_1차년도_${stamp}.xlsx`);
    // 과제명의 `:`가 남으면 윈도우에서 저장 자체가 실패한다
    expect(FORBIDDEN_FILENAME_CHARS.test(exportedFileName)).toBe(false);
  });

  it('내용이 실제 xlsx다 — zip 시그니처로 시작한다', () => {
    expect(exportedFile.length).toBeGreaterThan(0);
    expect(exportedFile.subarray(0, 2).toString('latin1')).toBe('PK');
  });
});

// ─── ⑤ 왕복 — 내보낸 파일을 §6.11 임포트에 그대로 먹인다 ──────────────────────

describe('⑤ 왕복 — 내보낸 파일 → §6.11 임포트 → budget_details', () => {
  let preview: PreviewDetailImportResult;
  let committed: Awaited<ReturnType<typeof commitDetailImport>> extends ActionResult<infer T>
    ? T
    : never;

  beforeAll(async () => {
    const draft: DetailImportDraft = {
      yearId: restoreYearId,
      sheetName: DETAIL_SHEET,
      fileHash: '',
    };

    // §7.9.3 Step 3 — D-11: 복원 과제의 명부가 비어 있으므로 19명이 전부 미매칭이다.
    // 화면이 하는 그대로 서버가 낸 매칭 결과에서 결정을 끌어온다 (D-12: 새 인력으로 생성)
    const first = unwrap(await previewDetailImport(formOf(exportedFile, exportedFileName), draft));
    const memberDecisions: Record<string, DetailMemberDecision> = {};
    for (const match of first.members) {
      if (match.status === 'matched') continue;
      memberDecisions[match.key] = { kind: 'create' };
    }

    preview = unwrap(
      await previewDetailImport(formOf(exportedFile, exportedFileName), { ...draft, memberDecisions })
    );
    committed = unwrap(
      await commitDetailImport(formOf(exportedFile, exportedFileName), {
        ...draft,
        fileHash: preview.fileHash,
        memberDecisions,
      })
    );
  }, 120_000);

  it('§7.9.3 Step 1·2 — 한 파일에 산출근거 + 총괄표가 들어 있다 (X-10)', async () => {
    const inspected = unwrap(await inspectDetailSheet(formOf(exportedFile, exportedFileName)));
    expect([...inspected.sheets.map((s) => s.name)].sort()).toEqual(
      [SUMMARY_SHEET, DETAIL_SHEET].sort()
    );
    expect(inspected.recommendedSheet).toBe(DETAIL_SHEET);
    // D-1: 총괄표는 산출근거 임포트의 대상이 아니다 (§7.9.1로 간다)
    expect(inspected.sheets.find((s) => s.name === SUMMARY_SHEET)?.eligible).toBe(false);
    expect(inspected.sheets.find((s) => s.name === DETAIL_SHEET)?.eligible).toBe(true);
    // X-2가 시트명에서 조직명·판본을 뗐으므로 D-19 연차 제안이 없다 — 연차는 사용자가 고른다
    expect(inspected.sheets.find((s) => s.name === DETAIL_SHEET)?.suggestedYearOrder).toBeNull();
  });

  it('나간 행 수가 그대로 돌아온다 — 서식 잔재가 유령 행을 만들지 않는다', () => {
    const errors = preview.rows
      .filter((row) => row.status === 'error')
      .map((row) => `${row.sourceRow + 1}행 ${row.name || row.memberName}: ${row.issues.join(',')}`);
    expect(errors).toEqual([]);
    expect(preview.blocked).toBe(false);
    expect(preview.summary.new).toBe(ROW_COUNT);
    expect(preview.summary.newMembers).toBe(B71_ROWS.length);
    expect(preview.summary.totalAmount).toBe(B7_GRAND_TOTAL);

    expect(committed.inserted).toBe(ROW_COUNT);
    expect(committed.membersCreated).toBe(B71_ROWS.length);
    expect(committed.deleted).toBe(0);
    expect(committed.skippedLocked).toBe(0);
  });

  // X-8이 빈 표의 템플릿 잔재 라벨(`국외출장비`)까지 비우므로 데이터가 없는 두 번째 ⑤ 표는
  // 국내/국외를 가를 근거가 사라진다. **조용히 합치지 않고 확인을 요구한다** (부록 C.2 주의 2).
  // 확인 요구가 남아 있어도 커밋이 지나가는 이유는 하나뿐이다 — 그 표에 행이 없다.
  // 금액이 실린 표가 확인 대기로 남는다면 그건 조용한 오분류이므로 여기서 걸려야 한다.
  it('확인이 필요한 표에는 금액이 한 푼도 실리지 않는다 (D-3a·C.2 주의 2)', () => {
    const unconfirmed = preview.blocks.filter((block) => block.needsConfirm);
    const withRows = unconfirmed.filter((block) => block.rowCount > 0);

    // 인건비 블록은 세목 헤더가 없어 `personnel_internal`을 **제안**받는다 (D-3a ②) —
    // 확인 요구이지 오류가 아니고, 제안 자체가 원본과 같은 세목이다
    expect(withRows.map((block) => `${block.category}/${block.subcategory}`)).toEqual([
      'personnel/personnel_internal',
    ]);
    expect(withRows[0]?.source).toBe('suggested');

    // 나머지 확인 요구 표(⑤ 출장비 둘째 표 등)는 전부 빈 표다
    for (const block of unconfirmed) {
      if (block === withRows[0]) continue;
      expect({ key: block.key, rows: block.rowCount }).toEqual({ key: block.key, rows: 0 });
    }
  });

  it('⭐ 복원 과제의 budget_details가 원본과 같은 값에 도달한다', async () => {
    const origin = await readDetails(originYearId);
    const restored = await readDetails(restoreYearId);

    // 양쪽이 나란히 비어 있으면 대조가 아무것도 지키지 않는다
    expect(origin).toHaveLength(ROW_COUNT);
    expect(restored).toHaveLength(ROW_COUNT);

    // (비목, 세목, 축, 라벨, 금액)은 한 건도 어긋나면 안 된다 — 왕복의 본체다
    const core = (rows: StoredDetail[]) =>
      rows.map((row) => ({
        category: row.category,
        subcategory: row.subcategory,
        axis: row.axis,
        formula: row.formula,
        label: row.label,
        sortOrder: row.sortOrder,
        amount: row.amount,
      }));
    expect(core(restored)).toEqual(core(origin));

    // 부록 B.7.1 표의 금액 그대로인지도 본다 — 두 경로가 나란히 틀릴 수 있다
    const b71 = Object.fromEntries(
      B71_ROWS.map((row) => [normalizeLabel(row.name), `${row.axis}:${row.expected}`])
    );
    expect(
      Object.fromEntries(
        restored
          .filter((row) => row.formula === 'personnel')
          .map((row) => [row.label, `${row.axis}:${row.amount}`])
      )
    ).toEqual(b71);
  });

  it('⭐ 산출근거(단가·인자·조정액)도 돌아온다 — 서식에 자리가 있는 한', async () => {
    const origin = await readDetails(originYearId);
    const restored = await readDetails(restoreYearId);

    // 인자 **라벨**은 파일이 아니라 템플릿 헤더에서 온다(`회` → `산출내역 회`). 값만 대조한다 —
    // 금액에 영향이 없고, 왕복이 라벨까지 보존하지 **않는다**는 사실은 아래에서 따로 못 박는다
    const basis = (rows: StoredDetail[]) =>
      rows.map((row) => ({
        label: row.label,
        unitPrice: row.unitPrice,
        adjustment: row.adjustment,
        factors: row.factors.map((factor) => `${factor.value}${factor.isPercent ? '%' : ''}`),
      }));

    // 서식에 단가·수량 칸이 있는 행 전부 (인건비 19행 + 연구활동비 5행)
    const hasBasisColumns = (row: StoredDetail) => row.subcategory !== 'indirect_support';
    expect(basis(restored.filter(hasBasisColumns))).toEqual(basis(origin.filter(hasBasisColumns)));

    // 인건비는 라벨까지 같다 — 참여율·참여기간은 서식의 헤더도 같은 말을 쓴다
    const personnelFactors = (rows: StoredDetail[]) =>
      rows.filter((row) => row.formula === 'personnel').map((row) => row.factors);
    expect(personnelFactors(restored)).toEqual(personnelFactors(origin));

    // quantity 행의 라벨은 템플릿 헤더로 갈린다 (PL-3: 라벨은 세목마다 자유롭다)
    const software = restored.find((row) => row.label === normalizeLabel('AEC Collection'));
    expect(software, 'AEC Collection 행이 돌아오지 않았습니다').toBeDefined();
    expect(software?.factors.map((factor) => factor.label)).toEqual([
      '산출내역 시트(수량)',
      '산출내역 월',
    ]);
  });

  it('⭐ 서식에 근거 칸이 없는 행은 금액만 돌아오고 근거는 조정액이 떠안는다 (D-8)', async () => {
    // 표준 서식의 `나. 연구지원비`는 내역·산출내역(텍스트)·합계뿐이라 단가·수량 칸이 없다.
    // 왕복이 닫히지 **않는** 유일한 자리이고, 내보내기 단계에서 이미 알리는 사실이다
    // (checkCapacity.truncatedFactors / ExportNotice 'truncated-factor').
    const restored = (await readDetails(restoreYearId)).find(
      (row) => row.subcategory === 'indirect_support'
    );
    const origin = (await readDetails(originYearId)).find(
      (row) => row.subcategory === 'indirect_support'
    );

    expect(origin, '원본에 간접비 행이 없습니다').toBeDefined();
    expect(restored, '복원 과제에 간접비 행이 없습니다').toBeDefined();
    expect(origin).toMatchObject({ unitPrice: B7_INDIRECT_CASH, adjustment: 0, factors: [] });
    // 금액은 원 단위로 살아 돌아온다 — 사라지는 것은 그 금액이 어떻게 나왔는지 보여 주는 칸이다
    expect(restored).toMatchObject({
      amount: B7_INDIRECT_CASH,
      unitPrice: 0,
      adjustment: B7_INDIRECT_CASH,
      factors: [],
    });
  });

  it('⭐ 두 과제의 budget_items 12비목이 원 단위까지 같다 (PL-10)', async () => {
    const origin = await readAllPlanRows(originYearId);
    const restored = await readAllPlanRows(restoreYearId);

    // 값 하나가 아니라 12비목 전부를 대조한다 — 손대지 않은 비목까지 같아야 왕복이다
    expect(restored).toEqual(origin);

    // 그 값이 부록 B.7이 정한 숫자인지도 못 박는다 (둘 다 틀린 경우를 잡는다)
    expect(origin.personnel).toEqual({
      planned: B7_PERSONNEL_TOTAL,
      cash: B7_PERSONNEL_CASH,
      inKind: B7_PERSONNEL_IN_KIND,
    });
    expect(origin.activity).toEqual({
      planned: B7_ACTIVITY_CASH,
      cash: B7_ACTIVITY_CASH,
      inKind: 0,
    });
    expect(origin.indirect).toEqual({
      planned: B7_INDIRECT_CASH,
      cash: B7_INDIRECT_CASH,
      inKind: 0,
    });

    const total = Object.values(restored).reduce((sum, row) => sum + row.planned, 0);
    expect(total).toBe(B7_GRAND_TOTAL);
  });
});
