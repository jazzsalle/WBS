// 산출근거 시트 임포트 RPC 통합 테스트 — commit_detail_import / restore_import_snapshot(D-17a)
// (SOT §6.11.5 D-15·D-15a·D-16·D-17·D-17a, §6.11.4 D-12, §6.10.2 PL-10·PL-10a,
//  §6.8.5 I-17·I-18, §5.17 PL-D1~PL-D5, §8.3 X-2)
//
// publishable 키 + 실제 세션(RLS 경로)으로 리포지토리를 호출한다. 직결 SQL은 결과 확인 전용 —
// RPC가 조용히 보정했는지는 저장된 원본만 답할 수 있다.
//
// 검증의 핵심 일곱:
//  1. D-12·PL-10  — 새 인력 생성 + 행 삽입 후 budget_items가 축별 sum(amount)와 일치한다.
//                   amount는 산식과 무관하게 넘긴 값 그대로 저장된다 (PL-10a).
//  2. D-16        — 중간 행이 실패하면 인력·산출근거·비목 총액·스냅샷이 전부 롤백된다.
//  3. D-15·D-17   — 교체 시 삭제되는 행 전문이 스냅샷 details에 담긴다.
//  4. D-17a       — 그 스냅샷 복원이 삭제된 행과 총액을 되살린다(행을 지우는 I-17의 예외).
//  5. D-15a       — 교체로 지정되지 않았는데 기존 행이 있는 셀은 건너뛰고 skippedLocked로 센다.
//  6. N-13        — 남의 과제 연차·인력은 거부된다.
//  7. I-17 회귀   — details 키가 없는 총괄표 스냅샷의 복원은 종전과 완전히 같다.
//
// 자기가 만든 과제·사용자만 지운다 — 파괴적 테스트가 아니다.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Sql } from 'postgres';
import { connectDirectDb, createTestUser, destroyTestUser, type TestUser } from './helpers';
import type { BudgetCategory } from '@/types';
import * as projects from '@/lib/db/projects';
import * as years from '@/lib/db/years';
import * as members from '@/lib/db/members';
import * as budgetDetails from '@/lib/db/budget-details';
import * as importSnapshots from '@/lib/db/import-snapshots';
import { RuleViolationError } from '@/lib/db/errors';

let sql: Sql;
let user: TestUser;
const tempProjectIds: string[] = []; // afterAll 안전망 — 실패해도 dev DB를 원복한다

let otherProjectId: string;
let otherYearId: string;
let otherMemberId: string;

// ─── 저장된 원본 읽기 (직결 SQL) ───────────────────────────
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

interface StoredDetail {
  id: string;
  amount: number;
  axis: string;
  member_id: string | null;
  sort_order: number;
}

async function readDetails(yearId: string, category: BudgetCategory): Promise<StoredDetail[]> {
  const rows = await sql`
    select id, amount::text as amount, axis, member_id, sort_order
      from public.budget_details
     where year_id = ${yearId}::uuid and category = ${category}
     order by sort_order, id`;
  return (rows as unknown as {
    id: string;
    amount: string;
    axis: string;
    member_id: string | null;
    sort_order: number;
  }[]).map((r) => ({
    id: r.id,
    amount: Number(r.amount),
    axis: r.axis,
    member_id: r.member_id,
    sort_order: r.sort_order,
  }));
}

// 스냅샷 jsonb 원본. 리포지토리 조회는 Zod가 모르는 키를 떨어뜨릴 수 있어 저장된 값을 직접 본다
async function readSnapshot(id: string): Promise<Record<string, unknown>> {
  const rows = await sql`select snapshot from public.import_snapshots where id = ${id}::uuid`;
  const row = rows[0] as { snapshot: Record<string, unknown> } | undefined;
  if (!row) throw new Error('스냅샷을 찾을 수 없습니다.');
  return row.snapshot;
}

async function countSnapshots(projectId: string): Promise<number> {
  const rows = await sql`
    select count(*)::text as n from public.import_snapshots where project_id = ${projectId}::uuid`;
  return Number((rows[0] as { n: string }).n);
}

async function countMembersNamed(projectId: string, name: string): Promise<number> {
  const rows = await sql`
    select count(*)::text as n from public.members
     where project_id = ${projectId}::uuid and name = ${name}`;
  return Number((rows[0] as { n: string }).n);
}

// ─── 입력 만들기 ─────────────────────────────────────────────

function source(fileName: string): importSnapshots.DetailImportSource {
  return { fileName, sheetName: '1차년도_250520', fileHash: 'b'.repeat(64) };
}

// RPC 페이로드는 DB 표기(snake_case)다 — 서버 액션이 매퍼로 만든 형태를 그대로 흉내 낸다
function qtyRow(
  patch: Partial<importSnapshots.DetailImportRow> &
    Pick<importSnapshots.DetailImportRow, 'category' | 'subcategory' | 'amount'>
): importSnapshots.DetailImportRow {
  return {
    axis: 'cash',
    formula: 'quantity',
    name: '시약',
    spec: '',
    note: '',
    unit_price: 0,
    factors: [],
    adjustment: 0,
    sort_order: 0,
    ...patch,
  };
}

async function newProject(name: string) {
  const project = await projects.createProjectWithDefaults(user.client, {
    name,
    contractStartDate: '2026-01-01',
  });
  tempProjectIds.push(project.id);
  return project;
}

// 과제 하나 + 첫 연차. 테스트끼리 셀 상태가 섞이지 않도록 대부분의 케이스가 새 과제를 쓴다
async function newProjectWithYear(name: string): Promise<{ projectId: string; yearId: string }> {
  const project = await newProject(name);
  const firstYear = (await years.listYears(user.client, project.id))[0];
  if (!firstYear) throw new Error('createProjectWithDefaults가 연차를 만들지 않았습니다.');
  return { projectId: project.id, yearId: firstYear.id };
}

async function seedDetail(
  projectId: string,
  yearId: string,
  category: BudgetCategory,
  subcategory: string,
  axis: 'cash' | 'in_kind',
  amount: number,
  order: number
) {
  return budgetDetails.upsertDetail(user.client, {
    projectId,
    yearId,
    category,
    subcategory,
    axis,
    formula: 'quantity',
    memberId: null,
    name: '기존 행',
    unitPrice: amount,
    spec: '',
    factors: [],
    adjustment: 0,
    note: '',
    order,
    amount,
  });
}

beforeAll(async () => {
  sql = connectDirectDb();
  user = await createTestUser(sql);

  // N-13(과제 경계) 검증용 — 다른 과제의 연차·인력
  const other = await newProjectWithYear('산출근거 임포트 남의 과제');
  otherProjectId = other.projectId;
  otherYearId = other.yearId;
  otherMemberId = (
    await members.createMember(
      user.client,
      {
        projectId: otherProjectId,
        orgId: null,
        name: '남의 과제 연구원',
        role: 'researcher',
        position: '선임연구원',
        field: '',
        email: '',
        phone: '',
        active: true,
        order: 0,
        annualSalary: 60_000_000,
        hireType: 'existing',
      },
      user.id
    )
  ).id;
});

afterAll(async () => {
  for (const id of tempProjectIds) {
    await sql`delete from public.projects where id = ${id}::uuid`;
  }

  // 잔여 데이터 0 확인 — 사용자 삭제 전에 본다(삭제하면 created_by가 null이 되어 추적이 끊긴다).
  // 과제 cascade로 지워지지 않은 행이 있으면 즉시 실패시킨다 (절대 규칙 5)
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

describe('① commit_detail_import — 반영 (D-12·D-16, PL-10·PL-10a)', () => {
  it('새 인력을 만들고 행을 삽입한 뒤 budget_items가 축별 합계와 일치한다', async () => {
    const { projectId, yearId } = await newProjectWithYear('산출근거 임포트 반영 과제');
    const newName = '임포트 신규채용1';

    const result = await importSnapshots.commitDetailImport(
      user.client,
      projectId,
      yearId,
      [
        {
          tempKey: 'm1',
          name: newName,
          position: '연구원',
          annual_salary: 60_000_000,
          hire_type: 'new',
          org_id: null,
        },
      ],
      [
        // PL-10a: 산식 결과(60,000,000 × 50% × 12/12 = 30,000,000)와 **다른** 값을 넘긴다.
        // RPC가 산식을 다시 구현하고 있다면 여기서 값이 갈린다
        {
          category: 'personnel',
          subcategory: 'personnel_internal',
          axis: 'cash',
          formula: 'personnel',
          memberTempKey: 'm1',
          factors: [
            { label: '참여율(%)', value: 50, isPercent: true },
            { label: '참여기간(월)', value: 12, isPercent: false },
          ],
          adjustment: -1,
          amount: 29_999_999,
          sort_order: 0,
        },
        qtyRow({
          category: 'material',
          subcategory: 'material_purchase',
          amount: 3_000_000,
          unit_price: 1_000_000,
          factors: [{ label: '수량', value: 3, isPercent: false }],
        }),
        qtyRow({
          category: 'material',
          subcategory: 'material_purchase',
          axis: 'in_kind',
          name: '현물 자재',
          amount: 2_000_000,
          unit_price: 2_000_000,
          sort_order: 1,
        }),
      ],
      [],
      source('1차년도_산출근거.xlsx')
    );

    expect(result).toMatchObject({
      inserted: 3,
      deleted: 0,
      membersCreated: 1,
      cells: 2,
      skippedLocked: 0,
    });

    // D-12: 인력이 같은 트랜잭션에서 만들어졌고 파일의 연봉·인력구분이 그대로 들어갔다
    const memberRows = await sql`
      select id, annual_salary::text as salary, hire_type, position, active
        from public.members where project_id = ${projectId}::uuid and name = ${newName}`;
    expect(memberRows).toHaveLength(1);
    const member = memberRows[0] as {
      id: string;
      salary: string;
      hire_type: string;
      position: string;
      active: boolean;
    };
    expect(member.salary).toBe('60000000');
    expect(member.hire_type).toBe('new');
    expect(member.position).toBe('연구원');

    // PL-10a: 넘긴 amount가 그대로 저장된다 (RPC가 다시 계산하지 않는다)
    const personnel = await readDetails(yearId, 'personnel');
    expect(personnel).toHaveLength(1);
    expect(personnel[0]!.amount).toBe(29_999_999);
    expect(personnel[0]!.member_id).toBe(member.id); // tempKey → uuid 치환 (D-12)

    // PL-10: budget_items = 축별 sum(amount)
    expect(await readPlanRow(yearId, 'personnel')).toMatchObject({
      planned: 29_999_999,
      cash: 29_999_999,
      inKind: 0,
    });
    expect(await readPlanRow(yearId, 'material')).toMatchObject({
      planned: 5_000_000,
      cash: 3_000_000,
      inKind: 2_000_000,
    });

    // D-17: 교체가 없어도 details 키는 항상 존재한다 — 키 유무로 스냅샷 종류를 가른다
    const snapshot = await readSnapshot(result.snapshotId);
    expect(snapshot.schemaVersion).toBe(2);
    expect(snapshot.kind).toBe('budget_detail');
    expect(Object.keys(snapshot)).toContain('details');
    expect(snapshot.details).toEqual([]);
    expect(snapshot.items).toHaveLength(2);
    expect(snapshot.source).toMatchObject({
      fileName: '1차년도_산출근거.xlsx',
      profileId: null, // D-20: 산출근거 임포트는 프로파일을 쓰지 않는다
    });

    // D-17a: 교체가 아니었어도 복원은 임포트가 만든 행을 지운다 — 남겨 두면 금액이 두 배가 된다.
    // budget_items 행 자체는 지우지 않고 반영 전 값으로 되돌린다 (I-17 유지)
    const restored = await importSnapshots.restoreImportSnapshot(user.client, result.snapshotId);
    expect(restored).toMatchObject({ restored: 2, detailsDeleted: 3, detailsRestored: 0, cells: 2 });
    expect(await readDetails(yearId, 'personnel')).toHaveLength(0);
    expect(await readDetails(yearId, 'material')).toHaveLength(0);
    expect(await readPlanRow(yearId, 'personnel')).toMatchObject({ planned: 0, cash: null, inKind: null });
    expect(await readPlanRow(yearId, 'material')).toMatchObject({ planned: 0, cash: null, inKind: null });
  });
});

describe('② commit_detail_import — 롤백 (D-16)', () => {
  it('중간 행이 실패하면 인력·산출근거·비목 총액·스냅샷이 전부 롤백된다', async () => {
    const { projectId, yearId } = await newProjectWithYear('산출근거 임포트 롤백 과제');
    const newName = '롤백 대상 인력';
    const beforePromotion = await readPlanRow(yearId, 'promotion');

    await expect(
      importSnapshots.commitDetailImport(
        user.client,
        projectId,
        yearId,
        [
          {
            tempKey: 'm1',
            name: newName,
            position: '연구원',
            annual_salary: 50_000_000,
            hire_type: 'existing',
            org_id: null,
          },
        ],
        [
          {
            category: 'personnel',
            subcategory: 'personnel_internal',
            axis: 'cash',
            formula: 'personnel',
            memberTempKey: 'm1',
            factors: [{ label: '참여율(%)', value: 100, isPercent: true }],
            amount: 50_000_000,
            sort_order: 0,
          },
          // PL-D3 위반: 인건비가 아닌 비목에 인건비 산식 — upsert_budget_detail이 거부한다
          qtyRow({
            category: 'promotion',
            subcategory: 'default',
            formula: 'personnel',
            amount: 1_000_000,
          }),
        ],
        [],
        source('실패.xlsx')
      )
    ).rejects.toBeInstanceOf(RuleViolationError);

    // 부분 반영 금지 — 앞 행도, 새 인력도, 스냅샷도 남지 않는다
    expect(await countMembersNamed(projectId, newName)).toBe(0);
    expect(await readDetails(yearId, 'personnel')).toHaveLength(0);
    expect(await readDetails(yearId, 'promotion')).toHaveLength(0);
    expect(await readPlanRow(yearId, 'personnel')).toMatchObject({ planned: 0 });
    expect(await readPlanRow(yearId, 'promotion')).toEqual(beforePromotion);
    expect(await countSnapshots(projectId)).toBe(0);
  });
});

describe('③④ 셀 교체 스냅샷과 복원 (D-15·D-17·D-17a)', () => {
  it('삭제되는 행 전문이 스냅샷에 담기고, 복원이 행과 총액을 되살린다', async () => {
    const { projectId, yearId } = await newProjectWithYear('산출근거 임포트 교체 과제');

    const oldCash = await seedDetail(projectId, yearId, 'material', 'material_purchase', 'cash', 1_000_000, 0);
    const oldInKind = await seedDetail(projectId, yearId, 'material', 'material_purchase', 'in_kind', 500_000, 1);
    const before = await readPlanRow(yearId, 'material');
    expect(before).toMatchObject({ planned: 1_500_000, cash: 1_000_000, inKind: 500_000 });

    const result = await importSnapshots.commitDetailImport(
      user.client,
      projectId,
      yearId,
      [],
      [
        qtyRow({
          category: 'material',
          subcategory: 'material_purchase',
          amount: 9_000_000,
          unit_price: 9_000_000,
        }),
      ],
      ['material'],
      source('교체.xlsx')
    );

    // D-15: 기존 행을 전부 지우고 파일 내용으로 바꾼다 — 부분 병합은 없다
    expect(result).toMatchObject({ inserted: 1, deleted: 2, membersCreated: 0, skippedLocked: 0 });
    const afterCommit = await readDetails(yearId, 'material');
    expect(afterCommit).toHaveLength(1);
    expect(afterCommit[0]!.amount).toBe(9_000_000);
    expect(await readPlanRow(yearId, 'material')).toMatchObject({
      planned: 9_000_000,
      cash: 9_000_000,
      inKind: 0,
    });

    // D-17: 스냅샷 details에 삭제된 행 **전문**(DB snake_case 원본)이 담긴다
    const snapshot = await readSnapshot(result.snapshotId);
    const details = snapshot.details as Record<string, unknown>[];
    expect(details).toHaveLength(2);
    expect(details.map((d) => d.id).sort()).toEqual([oldCash.id, oldInKind.id].sort());
    const cashRow = details.find((d) => d.id === oldCash.id)!;
    // 행 전체가 들어 있어야 id 보존 복원이 가능하다 (D-17a)
    for (const key of [
      'project_id', 'year_id', 'category', 'subcategory', 'axis', 'formula', 'member_id',
      'name', 'spec', 'note', 'unit_price', 'factors', 'adjustment', 'amount', 'sort_order',
      'created_at', 'updated_at', 'version', 'created_by', 'updated_by',
    ]) {
      expect(Object.keys(cashRow)).toContain(key);
    }
    expect(Number(cashRow.amount)).toBe(1_000_000);
    // items는 반영 **전** 총액이다
    expect(snapshot.items).toMatchObject([
      { category: 'material', plannedAmount: 1_500_000, cashAmount: 1_000_000, inKindAmount: 500_000, existed: true },
    ]);

    // D-17a: 복원은 교체로 늘어난 행을 지우고 스냅샷 행을 id 보존으로 되살린다.
    // 지우지 않으면 금액이 두 배가 된다
    const restored = await importSnapshots.restoreImportSnapshot(user.client, result.snapshotId);
    expect(restored).toMatchObject({
      snapshotId: result.snapshotId,
      restored: 1,
      detailsDeleted: 1,
      detailsRestored: 2,
      cells: 1,
    });

    const afterRestore = await readDetails(yearId, 'material');
    expect(afterRestore.map((d) => d.id)).toEqual([oldCash.id, oldInKind.id]);
    expect(afterRestore.map((d) => d.amount)).toEqual([1_000_000, 500_000]);
    expect(await readPlanRow(yearId, 'material')).toMatchObject({
      planned: 1_500_000,
      cash: 1_000_000,
      inKind: 500_000,
    });

    // I-17: 복원은 새 스냅샷을 만들지 않는다
    expect(await countSnapshots(projectId)).toBe(1);
  });
});

describe('⑤ D-15a — 교체로 지정되지 않은 셀은 건너뛴다', () => {
  it('커밋 시점에 기존 행이 있는 셀을 건너뛰고 skippedLocked로 센다', async () => {
    const { projectId, yearId } = await newProjectWithYear('산출근거 임포트 건너뜀 과제');

    // 미리보기 이후 다른 사람이 추가한 상황을 흉내 낸다
    await seedDetail(projectId, yearId, 'promotion', 'default', 'cash', 700_000, 0);
    const lockedBefore = await readPlanRow(yearId, 'promotion');

    const result = await importSnapshots.commitDetailImport(
      user.client,
      projectId,
      yearId,
      [],
      [
        qtyRow({ category: 'promotion', subcategory: 'default', amount: 4_000_000 }),
        qtyRow({ category: 'material', subcategory: 'material_purchase', amount: 1_200_000 }),
      ],
      [], // 교체 지정 없음
      source('건너뜀.xlsx')
    );

    // 전체 롤백이 아니다 — 나머지 셀은 반영되고 건너뜀만 별도로 센다
    expect(result).toMatchObject({ inserted: 1, deleted: 0, skippedLocked: 1, cells: 1 });

    const promotion = await readDetails(yearId, 'promotion');
    expect(promotion).toHaveLength(1);
    expect(promotion[0]!.amount).toBe(700_000); // 기존 행 그대로
    expect(await readPlanRow(yearId, 'promotion')).toEqual(lockedBefore);

    expect(await readDetails(yearId, 'material')).toHaveLength(1);
    expect(await readPlanRow(yearId, 'material')).toMatchObject({ planned: 1_200_000 });

    // 건너뛴 셀은 아무것도 바뀌지 않았으므로 스냅샷에도 담기지 않는다
    const snapshot = await readSnapshot(result.snapshotId);
    expect(snapshot.items).toMatchObject([{ category: 'material' }]);
    expect(snapshot.details).toEqual([]);
  });
});

describe('⑥ 과제 경계 (N-13)', () => {
  it('남의 과제 연차는 거부한다', async () => {
    const { projectId } = await newProjectWithYear('산출근거 임포트 경계 과제');

    await expect(
      importSnapshots.commitDetailImport(
        user.client,
        projectId,
        otherYearId,
        [],
        [qtyRow({ category: 'material', subcategory: 'material_purchase', amount: 1_000 })],
        [],
        source('남의연차.xlsx')
      )
    ).rejects.toBeInstanceOf(RuleViolationError);

    expect(await readDetails(otherYearId, 'material')).toHaveLength(0);
    expect(await countSnapshots(projectId)).toBe(0);
    expect(await countSnapshots(otherProjectId)).toBe(0);
  });

  it('남의 과제 인력을 가리키는 행은 거부한다', async () => {
    const { projectId, yearId } = await newProjectWithYear('산출근거 임포트 남의 인력 과제');

    await expect(
      importSnapshots.commitDetailImport(
        user.client,
        projectId,
        yearId,
        [],
        [
          {
            category: 'personnel',
            subcategory: 'personnel_internal',
            axis: 'cash',
            formula: 'personnel',
            member_id: otherMemberId,
            factors: [{ label: '참여율(%)', value: 100, isPercent: true }],
            amount: 10_000_000,
            sort_order: 0,
          },
        ],
        [],
        source('남의인력.xlsx')
      )
    ).rejects.toBeInstanceOf(RuleViolationError);

    expect(await readDetails(yearId, 'personnel')).toHaveLength(0);
    expect(await countSnapshots(projectId)).toBe(0);
  });
});

describe('⑦ restore_import_snapshot — details 없는 기존 스냅샷 (I-17 회귀)', () => {
  it('총괄표 스냅샷의 복원 동작과 반환 형태가 종전과 같다', async () => {
    const { projectId, yearId } = await newProjectWithYear('총괄표 스냅샷 회귀 과제');
    const before = await readPlanRow(yearId, 'activity');

    const { snapshotId } = await importSnapshots.commitImport(
      user.client,
      projectId,
      [
        {
          yearId,
          category: 'activity',
          plannedAmount: 5_000_000,
          cashAmount: null,
          inKindAmount: null,
        },
      ],
      { fileName: '총괄표.xlsx', sheetName: '사업비', profileId: null, fileHash: 'a'.repeat(64) }
    );

    const snapshot = await readSnapshot(snapshotId);
    expect(snapshot.schemaVersion).toBe(1);
    expect(Object.keys(snapshot)).not.toContain('details'); // 기존 형식 그대로

    expect(await readPlanRow(yearId, 'activity')).toMatchObject({ planned: 5_000_000 });

    // 반환 형태까지 종전과 같아야 한다 — details 관련 키가 붙으면 회귀다
    const restored = await importSnapshots.restoreImportSnapshot(user.client, snapshotId);
    expect(restored).toEqual({ snapshotId, restored: 1 });
    expect(await readPlanRow(yearId, 'activity')).toMatchObject({
      planned: before.planned,
      cash: before.cash,
      inKind: before.inKind,
    });
  });
});
