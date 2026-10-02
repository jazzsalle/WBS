// 협약 예산 리포지토리(lib/db/agreements.ts) Phase 25 확장 통합 테스트 — T7
// (SOT §5.23·§5.25, §8.4 O-1·O-2·O-3, §8.6, 계획서 docs/plans/phase-25-plan.md S-3·S-4·S-11·S-15)
//
// 참여인원 단일 행 쓰기와 정부지원 현금(agreement_gov_support) 쓰기가 가드 트리거·유일 제약·version 조건의
// 거부를 RuleViolationError/StaleDataError/NotFoundError로 바꾸는지, createVersion의 govCash와 복제가
// 정부지원 현금 행을 만드는지 본다. 스키마·트리거 자체는 agreement-forms-migration.test.ts 몫이다.
// 직결 SQL은 결과 확인·정리 전용이다. 자기가 만든 과제·사용자만 지운다.

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Sql } from 'postgres';
import { connectDirectDb, createTestUser, destroyTestUser, type TestUser } from './helpers';
import * as agreements from '@/lib/db/agreements';
import * as projects from '@/lib/db/projects';
import * as stages from '@/lib/db/stages';
import * as years from '@/lib/db/years';
import { NotFoundError, RuleViolationError, StaleDataError, ValidationError } from '@/lib/db/errors';

let sql: Sql;
let user: TestUser;
const tempProjectIds: string[] = [];

interface Fixture {
  projectId: string;
  year1Id: string;
  year2Id: string;
  memberId: string;
}

async function newFixture(name: string): Promise<Fixture> {
  const project = await projects.createProject(user.client, {
    name,
    createdBy: user.id,
    updatedBy: user.id,
  });
  tempProjectIds.push(project.id);
  const stage = await stages.createStage(user.client, { projectId: project.id, name: '1단계' });
  const year1 = await years.createYear(user.client, { stageId: stage.id, name: '1차년도' });
  const year2 = await years.createYear(user.client, { stageId: stage.id, name: '2차년도' });
  const member = await sql<{ id: string }[]>`
    insert into public.members (project_id, name, role, active, created_by, updated_by)
    values (${project.id}::uuid, '협약 참여자', 'researcher', true, ${user.id}::uuid, ${user.id}::uuid)
    returning id`;
  return { projectId: project.id, year1Id: year1.id, year2Id: year2.id, memberId: member[0]!.id };
}

async function createDraft(f: Fixture, name = '최종협약본', govCash?: Record<string, number>) {
  return agreements.createVersion(user.client, f.projectId, {
    kind: 'final',
    name,
    lines: [],
    participants: [],
    ...(govCash === undefined ? {} : { govCash }),
  });
}

async function confirm(versionId: string) {
  const v = await agreements.getVersionById(user.client, versionId);
  return agreements.confirmVersion(user.client, versionId, v.version, user.id);
}

function participantInput(
  versionId: string,
  yearId: string,
  memberId: string | null
): agreements.AgreementParticipantInsert {
  return {
    versionId,
    memberId,
    yearId,
    participationRate: 50,
    months: 12,
    annualSalary: 48_000_000,
    personnelCash: 24_000_000,
    personnelInKind: 0,
    role: '연구원',
    createdBy: user.id,
    updatedBy: user.id,
  };
}

async function govRows(versionId: string) {
  return agreements.listGovSupportByVersionIds(user.client, [versionId]);
}

beforeAll(async () => {
  sql = connectDirectDb();
  user = await createTestUser(sql);
});

afterAll(async () => {
  if (tempProjectIds.length > 0) {
    // 버전을 먼저 지운다 — 연차·인력의 no action FK(agreement_gov_support.year_id 포함)를 피한다
    await sql`delete from public.agreement_versions where project_id = any(${tempProjectIds}::uuid[])`;
    await sql`delete from public.projects where id = any(${tempProjectIds}::uuid[])`;
  }
  await destroyTestUser(sql, user);
  await sql.end();
});

// ─── 참여인원 ────────────────────────────────────────────────

describe('참여인원 단일 행 쓰기 (S-11)', () => {
  it('추가 → 조회 → 갱신 → 삭제 왕복이 앱 형태로 돌아온다', async () => {
    const f = await newFixture('협약 양식 리포 — 참여인원 CRUD');
    const v = await createDraft(f);

    const inserted = await agreements.insertParticipant(
      user.client,
      participantInput(v.versionId, f.year1Id, f.memberId)
    );
    expect(inserted).toMatchObject({
      versionId: v.versionId,
      memberId: f.memberId,
      yearId: f.year1Id,
      participationRate: 50,
      months: 12,
      annualSalary: 48_000_000,
      personnelCash: 24_000_000,
      personnelInKind: 0,
      role: '연구원',
      createdBy: user.id,
    });

    const fetched = await agreements.getParticipantById(user.client, inserted.id);
    expect(fetched).toEqual(inserted);

    const updated = await agreements.updateParticipant(
      user.client,
      inserted.id,
      { participationRate: 25.5, personnelCash: 10_200_000, memberId: null, yearId: f.year2Id, updatedBy: user.id },
      inserted.version
    );
    expect(updated).toMatchObject({
      participationRate: 25.5,
      personnelCash: 10_200_000,
      memberId: null,
      yearId: f.year2Id,
      role: '연구원',
      version: inserted.version + 1,
    });

    const listed = await agreements.listParticipantsByVersionIds(user.client, [v.versionId]);
    expect(listed.map((p) => p.id)).toEqual([inserted.id]);

    await agreements.removeParticipant(user.client, inserted.id);
    await expect(agreements.getParticipantById(user.client, inserted.id)).rejects.toBeInstanceOf(NotFoundError);
    await expect(agreements.removeParticipant(user.client, inserted.id)).rejects.toBeInstanceOf(NotFoundError);
  });

  it('없는 id는 NotFoundError, 빈 patch는 ValidationError', async () => {
    await expect(agreements.getParticipantById(user.client, randomUUID())).rejects.toBeInstanceOf(NotFoundError);
    await expect(
      agreements.updateParticipant(user.client, randomUUID(), { role: 'x' }, 1)
    ).rejects.toBeInstanceOf(NotFoundError);
    await expect(
      agreements.updateParticipant(user.client, randomUUID(), { updatedBy: user.id }, 1)
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it('version 불일치는 StaleDataError(최신 updated_by 포함)', async () => {
    const f = await newFixture('협약 양식 리포 — 참여인원 STALE');
    const v = await createDraft(f);
    const p = await agreements.insertParticipant(user.client, participantInput(v.versionId, f.year1Id, f.memberId));
    await agreements.updateParticipant(user.client, p.id, { role: '책임', updatedBy: user.id }, p.version);

    const stale = await agreements
      .updateParticipant(user.client, p.id, { role: '늦은 편집' }, p.version)
      .catch((e: unknown) => e);
    expect(stale).toBeInstanceOf(StaleDataError);
    expect((stale as StaleDataError).updatedBy).toBe(user.id);
    expect((await agreements.getParticipantById(user.client, p.id)).role).toBe('책임');
  });

  it('확정 버전 아래 추가·갱신은 RuleViolationError (가드 트리거)', async () => {
    const f = await newFixture('협약 양식 리포 — 참여인원 확정');
    const v = await createDraft(f);
    const p = await agreements.insertParticipant(user.client, participantInput(v.versionId, f.year1Id, f.memberId));
    await confirm(v.versionId);

    await expect(
      agreements.insertParticipant(user.client, participantInput(v.versionId, f.year1Id, null))
    ).rejects.toBeInstanceOf(RuleViolationError);
    await expect(
      agreements.updateParticipant(user.client, p.id, { role: '확정 후 편집' }, p.version)
    ).rejects.toBeInstanceOf(RuleViolationError);
    expect((await agreements.getParticipantById(user.client, p.id)).role).toBe('연구원');
  });

  it('다른 과제의 인력·연차는 RuleViolationError (추가·갱신 모두)', async () => {
    const f = await newFixture('협약 양식 리포 — 참여인원 경계');
    const other = await newFixture('협약 양식 리포 — 참여인원 경계(다른 과제)');
    const v = await createDraft(f);

    await expect(
      agreements.insertParticipant(user.client, participantInput(v.versionId, f.year1Id, other.memberId))
    ).rejects.toBeInstanceOf(RuleViolationError);
    await expect(
      agreements.insertParticipant(user.client, participantInput(v.versionId, other.year1Id, f.memberId))
    ).rejects.toBeInstanceOf(RuleViolationError);

    const p = await agreements.insertParticipant(user.client, participantInput(v.versionId, f.year1Id, f.memberId));
    await expect(
      agreements.updateParticipant(user.client, p.id, { memberId: other.memberId }, p.version)
    ).rejects.toBeInstanceOf(RuleViolationError);
    await expect(
      agreements.updateParticipant(user.client, p.id, { yearId: other.year2Id }, p.version)
    ).rejects.toBeInstanceOf(RuleViolationError);
  });
});

// ─── 정부지원 현금 ───────────────────────────────────────────

describe('정부지원 현금 쓰기 (§5.25, S-4 O-2)', () => {
  it('삽입(0도 값) → 갱신 → 삭제(미입력)', async () => {
    const f = await newFixture('협약 양식 리포 — 정부지원 왕복');
    const v = await createDraft(f);
    expect(await govRows(v.versionId)).toEqual([]);

    const zero = await agreements.upsertGovSupport(user.client, v.versionId, f.year1Id, 0, null, user.id);
    expect(zero).toMatchObject({ versionId: v.versionId, yearId: f.year1Id, govCash: 0, createdBy: user.id });
    expect(await govRows(v.versionId)).toHaveLength(1);

    const updated = await agreements.upsertGovSupport(
      user.client, v.versionId, f.year1Id, 150_000_000, zero.version, user.id
    );
    expect(updated).toMatchObject({ id: zero.id, govCash: 150_000_000, version: zero.version + 1 });

    await agreements.upsertGovSupport(user.client, v.versionId, f.year2Id, 80_000_000, null, user.id);
    const rows = await govRows(v.versionId);
    expect(rows.map(({ yearId, govCash }) => ({ yearId, govCash }))).toEqual(
      expect.arrayContaining([
        { yearId: f.year1Id, govCash: 150_000_000 },
        { yearId: f.year2Id, govCash: 80_000_000 },
      ])
    );

    await agreements.removeGovSupport(user.client, v.versionId, f.year1Id, updated.version);
    expect((await govRows(v.versionId)).map((r) => r.yearId)).toEqual([f.year2Id]);
  });

  it('경합: 이미 있는 칸에 삽입(23505)·읽은 version 불일치 갱신/삭제·그사이 지워진 행은 StaleDataError', async () => {
    const f = await newFixture('협약 양식 리포 — 정부지원 STALE');
    const v = await createDraft(f);
    const first = await agreements.upsertGovSupport(user.client, v.versionId, f.year1Id, 1_000, null, user.id);

    await expect(
      agreements.upsertGovSupport(user.client, v.versionId, f.year1Id, 2_000, null, user.id)
    ).rejects.toBeInstanceOf(StaleDataError);

    await agreements.upsertGovSupport(user.client, v.versionId, f.year1Id, 3_000, first.version, user.id);
    const staleUpdate = await agreements
      .upsertGovSupport(user.client, v.versionId, f.year1Id, 4_000, first.version, user.id)
      .catch((e: unknown) => e);
    expect(staleUpdate).toBeInstanceOf(StaleDataError);
    expect((staleUpdate as StaleDataError).updatedBy).toBe(user.id);
    await expect(
      agreements.removeGovSupport(user.client, v.versionId, f.year1Id, first.version)
    ).rejects.toBeInstanceOf(StaleDataError);
    expect((await govRows(v.versionId))[0]?.govCash).toBe(3_000);

    // 행이 없는 칸을 읽은 version으로 갱신·삭제 = 그사이 지워진 경합
    await expect(
      agreements.upsertGovSupport(user.client, v.versionId, f.year2Id, 5_000, 1, user.id)
    ).rejects.toBeInstanceOf(StaleDataError);
    await expect(
      agreements.removeGovSupport(user.client, v.versionId, f.year2Id, 1)
    ).rejects.toBeInstanceOf(StaleDataError);
  });

  it('확정 버전 아래 삽입·갱신은 RuleViolationError', async () => {
    const f = await newFixture('협약 양식 리포 — 정부지원 확정');
    const v = await createDraft(f);
    const row = await agreements.upsertGovSupport(user.client, v.versionId, f.year1Id, 7_000, null, user.id);
    await confirm(v.versionId);

    await expect(
      agreements.upsertGovSupport(user.client, v.versionId, f.year2Id, 1_000, null, user.id)
    ).rejects.toBeInstanceOf(RuleViolationError);
    await expect(
      agreements.upsertGovSupport(user.client, v.versionId, f.year1Id, 8_000, row.version, user.id)
    ).rejects.toBeInstanceOf(RuleViolationError);
    expect((await govRows(v.versionId)).map((r) => r.govCash)).toEqual([7_000]);
  });

  it('다른 과제의 연차는 RuleViolationError', async () => {
    const f = await newFixture('협약 양식 리포 — 정부지원 경계');
    const other = await newFixture('협약 양식 리포 — 정부지원 경계(다른 과제)');
    const v = await createDraft(f);
    await expect(
      agreements.upsertGovSupport(user.client, v.versionId, other.year1Id, 1_000, null, user.id)
    ).rejects.toBeInstanceOf(RuleViolationError);
    expect(await govRows(v.versionId)).toEqual([]);
  });

  it('버전 id가 비면 빈 배열(정상 결과)', async () => {
    expect(await agreements.listGovSupportByVersionIds(user.client, [])).toEqual([]);
  });
});

// ─── 생성·복제 ───────────────────────────────────────────────

describe('createVersion govCash·복제 (S-4·S-15·AV-1)', () => {
  it('govCash 맵이 연차별 행으로 저장되고(0 포함), 키 없는 연차는 행이 없다', async () => {
    const f = await newFixture('협약 양식 리포 — 생성 govCash');
    const created = await createDraft(f, '선정평가본', { [f.year1Id]: 0 });
    expect(created).toMatchObject({ order: 1, lines: 0, participants: 0, govSupport: 1 });
    const rows = await govRows(created.versionId);
    expect(rows.map(({ versionId, yearId, govCash }) => ({ versionId, yearId, govCash }))).toEqual([
      { versionId: created.versionId, yearId: f.year1Id, govCash: 0 },
    ]);
  });

  it('govCash 생략(기존 호출)은 행 0개', async () => {
    const f = await newFixture('협약 양식 리포 — 생성 생략');
    const created = await createDraft(f);
    expect(created.govSupport).toBe(0);
    expect(await govRows(created.versionId)).toEqual([]);
  });

  it('govCash에 다른 과제 연차·음수는 RuleViolationError이고 버전이 남지 않는다', async () => {
    const f = await newFixture('협약 양식 리포 — 생성 거부');
    const other = await newFixture('협약 양식 리포 — 생성 거부(다른 과제)');
    await expect(createDraft(f, '경계', { [other.year1Id]: 1_000 })).rejects.toBeInstanceOf(RuleViolationError);
    await expect(createDraft(f, '음수', { [f.year1Id]: -1 })).rejects.toBeInstanceOf(RuleViolationError);
    expect(await agreements.listVersionsByProject(user.client, f.projectId)).toEqual([]);
  });

  it('복제는 정부지원 현금 행을 새 id로 복사하고 원본은 그대로다', async () => {
    const f = await newFixture('협약 양식 리포 — 복제');
    const source = await createDraft(f, '최종협약본', { [f.year1Id]: 120_000_000, [f.year2Id]: 90_000_000 });
    expect(source.govSupport).toBe(2);
    await confirm(source.versionId);
    const before = await govRows(source.versionId);

    const cloned = await agreements.cloneVersion(user.client, source.versionId, {
      kind: 'amendment',
      name: '협약변경 1차',
    });
    expect(cloned).toMatchObject({ order: 2, govSupport: 2 });

    const copy = await govRows(cloned.versionId);
    const strip = ({ yearId, govCash }: (typeof copy)[number]) => ({ yearId, govCash });
    expect(copy.map(strip).sort((a, b) => a.yearId.localeCompare(b.yearId))).toEqual(
      before.map(strip).sort((a, b) => a.yearId.localeCompare(b.yearId))
    );
    expect(copy.every((r) => r.versionId === cloned.versionId)).toBe(true);
    const sourceIds = new Set(before.map((r) => r.id));
    expect(copy.some((r) => sourceIds.has(r.id))).toBe(false);
    expect(await govRows(source.versionId)).toEqual(before);

    // 사본은 작성 중 — 원본과 독립으로 고칠 수 있다
    const target = copy.find((r) => r.yearId === f.year1Id)!;
    await agreements.upsertGovSupport(user.client, cloned.versionId, f.year1Id, 1, target.version, user.id);
    expect(await govRows(source.versionId)).toEqual(before);
  });
});
