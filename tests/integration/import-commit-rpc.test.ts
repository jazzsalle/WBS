// 임포트 RPC 통합 테스트 — commit_import / restore_import_snapshot
// (SOT §6.8.5 I-17·I-18, §6.8.2 S-9, §5.12, §7.14, §8.3 X-2)
//
// publishable 키 + 실제 세션(RLS 경로)으로 리포지토리를 호출한다. 직결 SQL은 결과 확인 전용 —
// 리포지토리가 조용히 보정했는지는 저장된 원본만 답할 수 있다.
//
// 검증의 핵심 넷:
//  1. S-9  — 파일에 등장한 (연차, 비목)만 갱신되고 나머지 비목은 그대로다.
//  2. I-17 — 반영 **전** 값이 같은 트랜잭션에서 스냅샷으로 남고, 복원이 정확히 되돌린다.
//  3. I-18 — 남의 과제 연차가 한 건이라도 섞이면 전부 거부되고 아무것도 반영되지 않는다.
//  4. I-17 — 스냅샷은 과제별 최근 20개만 남는다.
//
// 자기가 만든 과제·사용자만 지운다 — 파괴적 테스트가 아니다.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Sql } from 'postgres';
import { connectDirectDb, createTestUser, destroyTestUser, type TestUser } from './helpers';
import type { BudgetCategory } from '@/types';
import * as projects from '@/lib/db/projects';
import * as stages from '@/lib/db/stages';
import * as years from '@/lib/db/years';
import * as budgetItems from '@/lib/db/budget-items';
import * as importSnapshots from '@/lib/db/import-snapshots';
import { RuleViolationError } from '@/lib/db/errors';

let sql: Sql;
let user: TestUser;
const tempProjectIds: string[] = []; // afterAll 안전망 — 실패해도 dev DB를 원복한다

let projectId: string;
let year1Id: string;
let year2Id: string;
let otherProjectId: string;
let otherYearId: string;

function source(fileName: string) {
  return { fileName, sheetName: '사업비 총괄표', profileId: null, fileHash: 'a'.repeat(64) };
}

async function newProject(name: string) {
  const project = await projects.createProjectWithDefaults(user.client, {
    name,
    contractStartDate: '2026-01-01',
  });
  tempProjectIds.push(project.id);
  return project;
}

// 액션 반환이 아니라 저장된 원본을 본다. bigint는 postgres.js가 문자열로 주므로
// text로 캐스팅해 정수로 되돌린다 (부동소수점 경유 금지)
interface PlanRow {
  planned: number;
  cash: number | null;
  inKind: number | null;
  version: number;
}

async function readPlanRow(yearId: string, category: BudgetCategory): Promise<PlanRow> {
  const rows = await sql`
    select planned_amount::text as planned, cash_amount::text as cash,
           in_kind_amount::text as in_kind, version::text as version
      from public.budget_items
     where year_id = ${yearId}::uuid and category = ${category}`;
  const row = rows[0] as
    | { planned: string; cash: string | null; in_kind: string | null; version: string }
    | undefined;
  if (!row) throw new Error(`비목 행(${category})을 찾을 수 없습니다.`);
  return {
    planned: Number(row.planned),
    cash: row.cash === null ? null : Number(row.cash),
    inKind: row.in_kind === null ? null : Number(row.in_kind),
    version: Number(row.version),
  };
}

async function countSnapshots(pid: string): Promise<number> {
  const rows = await sql`
    select count(*)::text as n from public.import_snapshots where project_id = ${pid}::uuid`;
  return Number((rows[0] as { n: string }).n);
}

beforeAll(async () => {
  sql = connectDirectDb();
  user = await createTestUser(sql);

  const project = await newProject('임포트 RPC 테스트 과제');
  projectId = project.id;

  const firstYear = (await years.listYears(user.client, projectId))[0];
  if (!firstYear) throw new Error('createProjectWithDefaults가 연차를 만들지 않았습니다.');
  year1Id = firstYear.id;

  const stage = (await stages.listStages(user.client, projectId))[0];
  if (!stage) throw new Error('createProjectWithDefaults가 단계를 만들지 않았습니다.');
  year2Id = (
    await years.createYear(user.client, {
      stageId: stage.id,
      name: '2차년도',
      startDate: '2027-01-01',
      endDate: '2027-12-31',
    })
  ).id;

  // N-13(과제 경계) 검증용 — 다른 과제의 연차
  const other = await newProject('임포트 RPC 남의 과제');
  otherProjectId = other.id;
  const otherYear = (await years.listYears(user.client, otherProjectId))[0];
  if (!otherYear) throw new Error('남의 과제에 연차가 없습니다.');
  otherYearId = otherYear.id;
});

afterAll(async () => {
  for (const id of tempProjectIds) {
    await sql`delete from public.projects where id = ${id}::uuid`;
  }

  // 잔여 데이터 0 확인 — 사용자 삭제 전에 본다(삭제하면 created_by가 null이 되어 추적이 끊긴다).
  // 스냅샷은 과제 cascade로 지워져야 하므로 고아 행이 남으면 즉시 실패시킨다 (절대 규칙 5)
  let remaining = 0;
  for (const id of tempProjectIds) {
    const rows = await sql`
      select ((select count(*) from public.projects        where id         = ${id}::uuid)
            + (select count(*) from public.budget_items    where project_id = ${id}::uuid)
            + (select count(*) from public.import_snapshots where project_id = ${id}::uuid))::text as n`;
    remaining += Number((rows[0] as { n: string }).n);
  }
  if (remaining !== 0) {
    throw new Error(`테스트가 만든 데이터가 ${remaining}건 남았습니다.`);
  }

  await destroyTestUser(sql, user);
  await sql.end();
});

describe('commit_import — 반영 범위 (S-9)', () => {
  it('파일에 등장한 (연차, 비목)만 갱신하고 나머지 비목은 그대로 둔다', async () => {
    // 파일에 없을 비목에 미리 값을 넣어 둔다 — 임포트가 이걸 건드리면 안 된다
    await budgetItems.updateBudgetPlan(user.client, year1Id, 'indirect', {
      plannedAmount: 7_000_000,
      cashAmount: null,
      inKindAmount: null,
      updatedBy: user.id,
    });
    const untouchedBefore = await readPlanRow(year1Id, 'indirect');
    const otherYearBefore = await readPlanRow(year2Id, 'personnel');

    const result = await importSnapshots.commitImport(
      user.client,
      projectId,
      [
        {
          yearId: year1Id,
          category: 'personnel',
          plannedAmount: 120_000_000,
          cashAmount: 100_000_000,
          inKindAmount: 20_000_000,
        },
        { yearId: year1Id, category: 'material', plannedAmount: 40_000_000, cashAmount: null, inKindAmount: null },
      ],
      source('산자부_총괄표.xlsx')
    );

    expect(result.updated).toBe(2);
    expect(result.snapshotId).toMatch(/^[0-9a-f-]{36}$/);

    expect(await readPlanRow(year1Id, 'personnel')).toMatchObject({
      planned: 120_000_000,
      cash: 100_000_000,
      inKind: 20_000_000,
    });
    expect(await readPlanRow(year1Id, 'material')).toMatchObject({
      planned: 40_000_000,
      cash: null,
      inKind: null,
    });

    // S-9: 파일에 없는 비목·연차는 version조차 오르지 않는다
    expect(await readPlanRow(year1Id, 'indirect')).toEqual(untouchedBefore);
    expect(await readPlanRow(year2Id, 'personnel')).toEqual(otherYearBefore);

    // create_year가 만든 12종은 그대로 12종이다 — 임포트가 행을 늘리거나 지우지 않는다
    const items = await budgetItems.listBudgetItemsByYear(user.client, year1Id);
    expect(items).toHaveLength(12);
  });
});

describe('commit_import — 스냅샷 (I-17)', () => {
  it('반영 전 계획액이 스냅샷에 남고 restore_import_snapshot이 그대로 되돌린다', async () => {
    const beforePersonnel = await readPlanRow(year1Id, 'personnel');
    const beforeActivity = await readPlanRow(year1Id, 'activity');

    const { snapshotId } = await importSnapshots.commitImport(
      user.client,
      projectId,
      [
        { yearId: year1Id, category: 'personnel', plannedAmount: 999_000_000, cashAmount: null, inKindAmount: null },
        { yearId: year1Id, category: 'activity', plannedAmount: 5_000_000, cashAmount: null, inKindAmount: null },
      ],
      source('덮어쓰기.xlsx')
    );

    const snapshot = await importSnapshots.getImportSnapshotById(user.client, snapshotId);
    expect(snapshot.projectId).toBe(projectId);
    expect(snapshot.snapshot.source.fileName).toBe('덮어쓰기.xlsx');
    expect(snapshot.snapshot.source.profileId).toBeNull();
    expect(snapshot.snapshot.items).toHaveLength(2);

    // 스냅샷에 담긴 값은 **반영 후**가 아니라 반영 전 값이어야 한다
    const snapPersonnel = snapshot.snapshot.items.find((i) => i.category === 'personnel');
    expect(snapPersonnel).toMatchObject({
      yearId: year1Id,
      plannedAmount: beforePersonnel.planned,
      cashAmount: beforePersonnel.cash,
      inKindAmount: beforePersonnel.inKind,
      existed: true,
    });

    expect(await readPlanRow(year1Id, 'personnel')).toMatchObject({
      planned: 999_000_000,
      cash: null,
      inKind: null,
    });

    const restored = await importSnapshots.restoreImportSnapshot(user.client, snapshotId);
    expect(restored).toEqual({ snapshotId, restored: 2 });

    // 금액·현금·현물이 전부 정확히 되돌아간다 (version만 트리거가 올린다)
    const afterPersonnel = await readPlanRow(year1Id, 'personnel');
    expect(afterPersonnel).toMatchObject({
      planned: beforePersonnel.planned,
      cash: beforePersonnel.cash,
      inKind: beforePersonnel.inKind,
    });
    expect(afterPersonnel.version).toBeGreaterThan(beforePersonnel.version);

    const afterActivity = await readPlanRow(year1Id, 'activity');
    expect(afterActivity).toMatchObject({
      planned: beforeActivity.planned,
      cash: beforeActivity.cash,
      inKind: beforeActivity.inKind,
    });

    // 복원은 새 스냅샷을 만들지 않는다 — import_snapshots는 "임포트 반영 전" 이력이다
    const listed = await importSnapshots.listImportSnapshots(user.client, projectId);
    expect(listed[0]!.id).toBe(snapshotId); // 최신순
  });
});

describe('commit_import — 과제 경계 (I-18, N-13)', () => {
  it('남의 과제 연차가 섞이면 전체를 거부하고 아무것도 반영하지 않는다', async () => {
    const before = await readPlanRow(year1Id, 'promotion');
    const otherBefore = await readPlanRow(otherYearId, 'promotion');
    const snapshotsBefore = await countSnapshots(projectId);

    await expect(
      importSnapshots.commitImport(
        user.client,
        projectId,
        [
          { yearId: year1Id, category: 'promotion', plannedAmount: 3_000_000, cashAmount: null, inKindAmount: null },
          { yearId: otherYearId, category: 'promotion', plannedAmount: 4_000_000, cashAmount: null, inKindAmount: null },
        ],
        source('경계위반.xlsx')
      )
    ).rejects.toBeInstanceOf(RuleViolationError);

    // 부분 반영 금지 — 같은 과제의 정상 행도 반영되면 안 된다
    expect(await readPlanRow(year1Id, 'promotion')).toEqual(before);
    expect(await readPlanRow(otherYearId, 'promotion')).toEqual(otherBefore);
    // 스냅샷도 롤백된다 (같은 트랜잭션)
    expect(await countSnapshots(projectId)).toBe(snapshotsBefore);
  });

  it('현금+현물 ≠ 계획액이면 전체를 거부한다 (§5.12)', async () => {
    const before = await readPlanRow(year1Id, 'burden');
    const snapshotsBefore = await countSnapshots(projectId);

    await expect(
      importSnapshots.commitImport(
        user.client,
        projectId,
        [
          {
            yearId: year1Id,
            category: 'burden',
            plannedAmount: 10_000_000,
            cashAmount: 6_000_000,
            inKindAmount: 5_000_000,
          },
        ],
        source('금액불일치.xlsx')
      )
    ).rejects.toBeInstanceOf(RuleViolationError);

    expect(await readPlanRow(year1Id, 'burden')).toEqual(before);
    expect(await countSnapshots(projectId)).toBe(snapshotsBefore);
  });
});

describe('commit_import — 스냅샷 보존 한도 (I-17)', () => {
  it('21번째 반영에서 가장 오래된 스냅샷이 지워지고 20개가 유지된다', async () => {
    // 이 테스트만의 과제를 써서 앞 테스트가 만든 스냅샷 수에 의존하지 않는다
    const project = await newProject('임포트 RPC 스냅샷 한도 과제');
    const yearId = (await years.listYears(user.client, project.id))[0]!.id;

    const ids: string[] = [];
    for (let i = 0; i < 21; i += 1) {
      const { snapshotId } = await importSnapshots.commitImport(
        user.client,
        project.id,
        [
          {
            yearId,
            category: 'activity',
            plannedAmount: (i + 1) * 1_000,
            cashAmount: null,
            inKindAmount: null,
          },
        ],
        source(`반복-${i}.xlsx`)
      );
      ids.push(snapshotId);
    }

    expect(await countSnapshots(project.id)).toBe(20);

    const listed = await importSnapshots.listImportSnapshots(user.client, project.id);
    expect(listed).toHaveLength(20);
    expect(listed[0]!.id).toBe(ids[20]); // 최신순
    expect(listed.map((s) => s.id)).not.toContain(ids[0]); // 가장 오래된 것이 밀려났다

    // 밀려난 스냅샷은 조회도 되지 않는다 — 목록에만 없고 남아 있으면 20개 한도가 거짓말이 된다
    await expect(
      importSnapshots.getImportSnapshotById(user.client, ids[0]!)
    ).rejects.toThrow();
  });
});

describe('removeImportSnapshot (§7.14)', () => {
  it('스냅샷을 지우고, 없는 스냅샷 삭제는 실패시킨다', async () => {
    const { snapshotId } = await importSnapshots.commitImport(
      user.client,
      projectId,
      [{ yearId: year2Id, category: 'other', plannedAmount: 1_000, cashAmount: null, inKindAmount: null }],
      source('삭제대상.xlsx')
    );

    await importSnapshots.removeImportSnapshot(user.client, snapshotId);
    await expect(importSnapshots.removeImportSnapshot(user.client, snapshotId)).rejects.toThrow();

    // 스냅샷 삭제는 예산을 되돌리지 않는다 — 이력만 지운다
    expect((await readPlanRow(year2Id, 'other')).planned).toBe(1_000);
  });
});
