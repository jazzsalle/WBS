// 협약 예산 리포지토리(lib/db/agreements.ts) 통합 테스트 — Phase 24 T6
// (SOT §5.21~§5.24, §8.4 O-1·O-3, §8.6, §9 Agreement Budget, §12 1000행 페이징,
//  계획서 docs/plans/phase-24-plan.md S-3·S-4·S-14~S-16)
//
// publishable 키 + 실제 세션으로 리포지토리를 부른다 — 검증 대상은 RPC·가드 트리거·유일 인덱스의 거부가
// 계약대로 RuleViolationError/StaleDataError/NotFoundError로 바뀌는지, DB 응답이 Zod·매퍼를 거쳐 앱 형태로
// 오는지다. 스키마·트리거 자체는 agreement-migration.test.ts가 직결 SQL로 검증한다.
// 직결 SQL은 결과 확인과 정리 전용이다. 자기가 만든 과제·사용자만 지운다 — 파괴적 테스트가 아니다.

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Sql } from 'postgres';
import { connectDirectDb, createTestUser, destroyTestUser, type TestUser } from './helpers';
import * as agreements from '@/lib/db/agreements';
import * as projects from '@/lib/db/projects';
import * as stages from '@/lib/db/stages';
import * as years from '@/lib/db/years';
import { NotFoundError, RuleViolationError, StaleDataError } from '@/lib/db/errors';

let sql: Sql;
let user: TestUser;
const tempProjectIds: string[] = []; // afterAll 안전망 — 실패해도 dev DB를 원복한다

// PostgREST 기본 max-rows(1000)를 반드시 넘겨야 절단이 드러난다
const BULK_LINES = 1005;

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
  // 인력 리포지토리 입력 검증은 이 파일의 관심이 아니다 — 직결 SQL로 최소 행만 만든다
  const member = await sql<{ id: string }[]>`
    insert into public.members (project_id, name, role, active, created_by, updated_by)
    values (${project.id}::uuid, '협약 참여자', 'researcher', true, ${user.id}::uuid, ${user.id}::uuid)
    returning id`;
  return { projectId: project.id, year1Id: year1.id, year2Id: year2.id, memberId: member[0]!.id };
}

function line(yearId: string, amount: number, subcategoryCode = 'material_purchase', axis: 'cash' | 'in_kind' = 'cash'): agreements.AgreementLineSeed {
  return { yearId, category: 'material', subcategoryCode, axis, amount };
}

function participant(yearId: string, memberId: string | null, personnelCash: number): agreements.AgreementParticipantSeed {
  return {
    memberId,
    yearId,
    participationRate: 37.5,
    months: 12,
    annualSalary: 60_000_000,
    personnelCash,
    personnelInKind: 0,
    role: '책임연구원',
  };
}

async function createDraft(
  f: Fixture,
  name = '최종협약본',
  lines: agreements.AgreementLineSeed[] = [],
  participants: agreements.AgreementParticipantSeed[] = []
) {
  return agreements.createVersion(user.client, f.projectId, { kind: 'final', name, lines, participants });
}

async function confirm(versionId: string) {
  const v = await agreements.getVersionById(user.client, versionId);
  return agreements.confirmVersion(user.client, versionId, v.version, user.id);
}

// 복제 검증용 편성 항목 — Phase 26부터 리포지토리 경유(§8.6). 쓰기 자체의 검증은 repos-agreement-items.test.ts
async function insertItem(versionId: string, yearId: string) {
  await agreements.insertItem(user.client, {
    versionId,
    yearId,
    kind: 'equipment',
    name: '분석 장비',
    amount: 33_000_000,
    quantity: 1.5,
    evidence: [
      { label: '견적서', obtained: true, memo: '2개사' },
      { label: '비교견적서', obtained: false, memo: '' },
    ],
  });
}

async function snapshot(versionId: string) {
  const [lines, participants, items] = await Promise.all([
    agreements.listLinesByVersionIds(user.client, [versionId]),
    agreements.listParticipantsByVersionIds(user.client, [versionId]),
    agreements.listItemsByVersionIds(user.client, [versionId]),
  ]);
  return { lines, participants, items };
}

async function countChildren(versionId: string) {
  const rows = await sql<{ lines: number; participants: number; items: number }[]>`
    select
      (select count(*) from public.agreement_lines where version_id = ${versionId}::uuid)::int as lines,
      (select count(*) from public.agreement_participants where version_id = ${versionId}::uuid)::int as participants,
      (select count(*) from public.agreement_items where version_id = ${versionId}::uuid)::int as items`;
  return rows[0]!;
}

beforeAll(async () => {
  sql = connectDirectDb();
  user = await createTestUser(sql);
});

afterAll(async () => {
  if (tempProjectIds.length > 0) {
    // 버전을 먼저 지운다 — delete_project(H-7)와 같은 순서. 연차·인력의 no action FK를 피한다
    await sql`delete from public.agreement_versions where project_id = any(${tempProjectIds}::uuid[])`;
    await sql`delete from public.projects where id = any(${tempProjectIds}::uuid[])`;
  }
  await destroyTestUser(sql, user);
  await sql.end();
});

// ─── 생성·조회 왕복 ──────────────────────────────────────────

describe('생성(RPC)·조회 왕복', () => {
  it('create_agreement_version 결과와 4종 조회가 앱 형태(camelCase·order)로 돌아온다', async () => {
    const f = await newFixture('협약 리포 — 왕복');
    const created = await createDraft(
      f,
      '선정평가본',
      [line(f.year1Id, 1_000_000), line(f.year2Id, 250_000, 'default', 'in_kind')],
      [participant(f.year1Id, f.memberId, 22_500_000), participant(f.year2Id, null, 0)]
    );
    expect(created).toMatchObject({ order: 1, lines: 2, participants: 2 });

    const versions = await agreements.listVersionsByProject(user.client, f.projectId);
    expect(versions).toHaveLength(1);
    expect(versions[0]).toMatchObject({
      id: created.versionId,
      projectId: f.projectId,
      kind: 'final',
      name: '선정평가본',
      status: 'draft',
      confirmedAt: null,
      order: 1,
      baseDate: null,
      noticeType: null,
      irisRequestedAt: null,
      changeReason: '',
      note: '',
    });
    expect(versions[0]).not.toHaveProperty('sortOrder');

    const { lines, participants, items } = await snapshot(created.versionId);
    expect(lines.map(({ yearId, category, subcategoryCode, axis, amount, versionId }) => ({
      yearId, category, subcategoryCode, axis, amount, versionId,
    }))).toEqual(
      expect.arrayContaining([
        { versionId: created.versionId, yearId: f.year1Id, category: 'material', subcategoryCode: 'material_purchase', axis: 'cash', amount: 1_000_000 },
        { versionId: created.versionId, yearId: f.year2Id, category: 'material', subcategoryCode: 'default', axis: 'in_kind', amount: 250_000 },
      ])
    );
    expect(lines).toHaveLength(2);
    expect(participants).toHaveLength(2);
    expect(participants.find((p) => p.memberId === f.memberId)).toMatchObject({
      yearId: f.year1Id,
      participationRate: 37.5,
      months: 12,
      annualSalary: 60_000_000,
      personnelCash: 22_500_000,
      personnelInKind: 0,
      role: '책임연구원',
    });
    expect(participants.find((p) => p.memberId === null)?.yearId).toBe(f.year2Id);
    expect(items).toEqual([]);
  });

  it('빈 버전(빈 배열)도 만들어지고 다음 버전 order는 최댓값 + 1이다', async () => {
    const f = await newFixture('협약 리포 — 빈 버전');
    const first = await createDraft(f, '빈 버전 1');
    expect(first).toMatchObject({ order: 1, lines: 0, participants: 0 });
    await confirm(first.versionId);
    const second = await createDraft(f, '빈 버전 2');
    expect(second.order).toBe(2);
    const versions = await agreements.listVersionsByProject(user.client, f.projectId);
    expect(versions.map((v) => v.order)).toEqual([1, 2]);
  });

  it('버전 id가 비면 빈 배열(정상 결과), 없는 id는 NotFoundError', async () => {
    expect(await agreements.listLinesByVersionIds(user.client, [])).toEqual([]);
    await expect(agreements.getVersionById(user.client, randomUUID())).rejects.toBeInstanceOf(NotFoundError);
  });

  it(`줄 ${BULK_LINES}행도 잘리지 않고 전부 읽힌다 (§12 — max-rows 1000)`, async () => {
    const f = await newFixture('협약 리포 — 페이징');
    // DB는 세목 목록을 모른다(S-7) — 칸을 늘리려고 합성 세목 코드를 쓴다
    const bulk = Array.from({ length: BULK_LINES }, (_, i) => line(f.year1Id, i, `bulk_${i}`));
    const created = await createDraft(f, '대량', bulk);
    expect(created.lines).toBe(BULK_LINES);

    const lines = await agreements.listLinesByVersionIds(user.client, [created.versionId]);
    expect(lines).toHaveLength(BULK_LINES);
    expect(new Set(lines.map((l) => l.id)).size).toBe(BULK_LINES);
    expect(lines.reduce((sum, l) => sum + l.amount, 0)).toBe((BULK_LINES * (BULK_LINES - 1)) / 2);
  });
});

// ─── 복제 ────────────────────────────────────────────────────

describe('복제(clone_agreement_version) — AV-1', () => {
  it('줄·참여인원·편성 항목(증빙 포함)을 새 id로 모두 복사하고 원본은 그대로다', async () => {
    const f = await newFixture('협약 리포 — 복제');
    const source = await createDraft(
      f,
      '최종협약본',
      [line(f.year1Id, 5_000_000), line(f.year2Id, 7_000_000, 'default')],
      [participant(f.year1Id, f.memberId, 22_500_000)]
    );
    await insertItem(source.versionId, f.year1Id);
    await confirm(source.versionId);
    const before = await snapshot(source.versionId);
    const sourceMeta = await agreements.getVersionById(user.client, source.versionId);

    const cloned = await agreements.cloneVersion(user.client, source.versionId, {
      kind: 'amendment',
      name: '협약변경 1차',
    });
    expect(cloned).toMatchObject({ order: 2, lines: 2, participants: 1, items: 1 });

    const copy = await snapshot(cloned.versionId);
    const stripLine = ({ yearId, category, subcategoryCode, axis, amount }: (typeof copy.lines)[number]) =>
      ({ yearId, category, subcategoryCode, axis, amount });
    expect(copy.lines.map(stripLine)).toEqual(before.lines.map(stripLine));
    expect(copy.participants.map(({ memberId, yearId, participationRate, months, annualSalary, personnelCash, personnelInKind, role }) =>
      ({ memberId, yearId, participationRate, months, annualSalary, personnelCash, personnelInKind, role })))
      .toEqual(before.participants.map(({ memberId, yearId, participationRate, months, annualSalary, personnelCash, personnelInKind, role }) =>
        ({ memberId, yearId, participationRate, months, annualSalary, personnelCash, personnelInKind, role })));
    expect(copy.items).toHaveLength(1);
    expect(copy.items[0]).toMatchObject({
      versionId: cloned.versionId,
      kind: 'equipment',
      name: '분석 장비',
      amount: 33_000_000,
      quantity: 1.5,
      evidence: [
        { label: '견적서', obtained: true, memo: '2개사' },
        { label: '비교견적서', obtained: false, memo: '' },
      ],
    });

    // 새 id — 원본 행 id와 하나도 겹치지 않는다
    const sourceIds = new Set([...before.lines, ...before.participants, ...before.items].map((r) => r.id));
    for (const row of [...copy.lines, ...copy.participants, ...copy.items]) {
      expect(sourceIds.has(row.id)).toBe(false);
      expect(row.versionId).toBe(cloned.versionId);
    }

    // 원본 불변 — 행·메타 모두
    expect(await snapshot(source.versionId)).toEqual(before);
    expect(await agreements.getVersionById(user.client, source.versionId)).toEqual(sourceMeta);

    const clonedMeta = await agreements.getVersionById(user.client, cloned.versionId);
    expect(clonedMeta).toMatchObject({ kind: 'amendment', name: '협약변경 1차', status: 'draft', confirmedAt: null });
  });

  it('없는 원본은 NotFoundError', async () => {
    await expect(
      agreements.cloneVersion(user.client, randomUUID(), { kind: 'final', name: 'x' })
    ).rejects.toBeInstanceOf(NotFoundError);
  });
});

// ─── 메타·확정·확정 취소 ─────────────────────────────────────

describe('메타 편집 — O-1 expectedVersion', () => {
  it('맞는 version이면 메타 7개가 바뀌고, 낡은 version이면 StaleDataError(updatedBy 포함)', async () => {
    const f = await newFixture('협약 리포 — 메타');
    const created = await createDraft(f);
    const v0 = await agreements.getVersionById(user.client, created.versionId);

    const updated = await agreements.updateVersionMeta(
      user.client,
      v0.id,
      {
        kind: 'adjustment',
        name: '조정회의본',
        baseDate: '2026-03-01',
        changeReason: '조정회의 결과 반영',
        noticeType: 'approval',
        irisRequestedAt: '2026-02-20',
        note: '비고',
        updatedBy: user.id,
      },
      v0.version
    );
    expect(updated).toMatchObject({
      kind: 'adjustment',
      name: '조정회의본',
      baseDate: '2026-03-01',
      changeReason: '조정회의 결과 반영',
      noticeType: 'approval',
      irisRequestedAt: '2026-02-20',
      note: '비고',
      status: 'draft',
      version: v0.version + 1,
      updatedBy: user.id,
    });

    const stale = await agreements
      .updateVersionMeta(user.client, v0.id, { name: '덮어쓰기' }, v0.version)
      .then(() => null, (e: unknown) => e);
    expect(stale).toBeInstanceOf(StaleDataError);
    expect((stale as StaleDataError).updatedBy).toBe(user.id);
    expect((await agreements.getVersionById(user.client, v0.id)).name).toBe('조정회의본');
  });

  it('확정 버전도 메타는 고칠 수 있다(종류 포함 — AV-2), 상태는 그대로', async () => {
    const f = await newFixture('협약 리포 — 확정 후 메타');
    const created = await createDraft(f);
    const confirmed = await confirm(created.versionId);
    const updated = await agreements.updateVersionMeta(
      user.client,
      created.versionId,
      { kind: 'amendment', note: '확정 후 메모' },
      confirmed.version
    );
    expect(updated).toMatchObject({ kind: 'amendment', note: '확정 후 메모', status: 'confirmed' });
    expect(updated.confirmedAt).toBe(confirmed.confirmedAt);
  });

  it('메타 밖 키(status)는 메타 편집으로 새어 들어가지 않는다', async () => {
    const f = await newFixture('협약 리포 — 메타 밖 키');
    const created = await createDraft(f);
    const v0 = await agreements.getVersionById(user.client, created.versionId);
    const widened = { name: '이름만', status: 'confirmed' } as agreements.AgreementVersionMetaPatch;
    const updated = await agreements.updateVersionMeta(user.client, v0.id, widened, v0.version);
    expect(updated).toMatchObject({ name: '이름만', status: 'draft', confirmedAt: null });
  });

  it('바꿀 내용이 없으면 거부하고, 없는 버전은 NotFoundError', async () => {
    const f = await newFixture('협약 리포 — 빈 patch');
    const created = await createDraft(f);
    await expect(
      agreements.updateVersionMeta(user.client, created.versionId, { updatedBy: user.id }, 1)
    ).rejects.toThrow('갱신할 내용이 없습니다.');
    await expect(
      agreements.updateVersionMeta(user.client, randomUUID(), { name: 'x' }, 1)
    ).rejects.toBeInstanceOf(NotFoundError);
  });
});

describe('확정·확정 취소 — AV-2·AV-8', () => {
  it('확정은 confirmedAt을 기록하고, 낡은 version이면 StaleDataError', async () => {
    const f = await newFixture('협약 리포 — 확정');
    const created = await createDraft(f);
    const v0 = await agreements.getVersionById(user.client, created.versionId);
    const confirmed = await agreements.confirmVersion(user.client, v0.id, v0.version, user.id);
    expect(confirmed.status).toBe('confirmed');
    expect(confirmed.confirmedAt).not.toBeNull();

    await expect(
      agreements.unconfirmVersion(user.client, v0.id, v0.version, user.id)
    ).rejects.toBeInstanceOf(StaleDataError);
  });

  it('확정 취소는 마지막 버전만 — 아니면 트리거 메시지 그대로 RuleViolationError', async () => {
    const f = await newFixture('협약 리포 — 확정 취소');
    const first = await createDraft(f, '최종협약본');
    const firstConfirmed = await confirm(first.versionId);
    const second = await createDraft(f, '협약변경 1차');
    await confirm(second.versionId);

    const error = await agreements
      .unconfirmVersion(user.client, first.versionId, firstConfirmed.version, user.id)
      .then(() => null, (e: unknown) => e);
    expect(error).toBeInstanceOf(RuleViolationError);
    expect((error as Error).message).toBe('확정 취소는 과제의 마지막 버전만 할 수 있습니다 — 뒤에 쌓인 버전이 있습니다');
    expect((await agreements.getVersionById(user.client, first.versionId)).status).toBe('confirmed');

    const last = await agreements.getVersionById(user.client, second.versionId);
    const reopened = await agreements.unconfirmVersion(user.client, last.id, last.version, user.id);
    expect(reopened).toMatchObject({ status: 'draft', confirmedAt: null });
  });
});

// ─── 금액 줄 쓰기 ────────────────────────────────────────────

describe('금액 줄 쓰기 — AG-2 셀 편집, S-16', () => {
  it('insertLine·updateLineAmount가 작성 중 버전에 쓰고 version이 오른다', async () => {
    const f = await newFixture('협약 리포 — 줄 쓰기');
    const created = await createDraft(f, '최종협약본', [line(f.year1Id, 100)]);
    const inserted = await agreements.insertLine(user.client, {
      versionId: created.versionId,
      ...line(f.year2Id, 300, 'default', 'in_kind'),
      createdBy: user.id,
      updatedBy: user.id,
    });
    expect(inserted).toMatchObject({ versionId: created.versionId, yearId: f.year2Id, subcategoryCode: 'default', axis: 'in_kind', amount: 300 });

    const updated = await agreements.updateLineAmount(user.client, inserted.id, 0, inserted.version, user.id);
    expect(updated).toMatchObject({ id: inserted.id, amount: 0, version: inserted.version + 1, updatedBy: user.id });
  });

  it('방금 읽은 version 이후 다른 사람이 고쳤으면 StaleDataError, 줄이 사라졌으면 NotFoundError', async () => {
    const f = await newFixture('협약 리포 — 줄 경합');
    const created = await createDraft(f, '최종협약본', [line(f.year1Id, 100)]);
    const [read] = await agreements.listLinesByVersionIds(user.client, [created.versionId]);
    await agreements.updateLineAmount(user.client, read!.id, 200, read!.version);

    await expect(
      agreements.updateLineAmount(user.client, read!.id, 999, read!.version)
    ).rejects.toBeInstanceOf(StaleDataError);
    const [after] = await agreements.listLinesByVersionIds(user.client, [created.versionId]);
    expect(after!.amount).toBe(200);

    await expect(
      agreements.updateLineAmount(user.client, randomUUID(), 1, 1)
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  it('같은 칸에 그사이 줄이 생겼으면(유일 키 경합) StaleDataError', async () => {
    const f = await newFixture('협약 리포 — 줄 중복');
    const created = await createDraft(f, '최종협약본', [line(f.year1Id, 100, 'default')]);
    await expect(
      agreements.insertLine(user.client, { versionId: created.versionId, ...line(f.year1Id, 5, 'default') })
    ).rejects.toBeInstanceOf(StaleDataError);
  });

  it('확정 버전의 줄 추가·갱신은 트리거 메시지 그대로 RuleViolationError, 금액 불변', async () => {
    const f = await newFixture('협약 리포 — 확정 잠금');
    const created = await createDraft(f, '최종협약본', [line(f.year1Id, 100)]);
    await confirm(created.versionId);
    const [locked] = await agreements.listLinesByVersionIds(user.client, [created.versionId]);
    const lockMessage = '확정된 협약 예산 버전의 내용은 고칠 수 없습니다 — 확정을 취소하거나 새 버전을 만드세요';

    const updateError = await agreements
      .updateLineAmount(user.client, locked!.id, 1, locked!.version)
      .then(() => null, (e: unknown) => e);
    expect(updateError).toBeInstanceOf(RuleViolationError);
    expect((updateError as Error).message).toBe(lockMessage);

    const insertError = await agreements
      .insertLine(user.client, { versionId: created.versionId, ...line(f.year2Id, 1, 'default') })
      .then(() => null, (e: unknown) => e);
    expect(insertError).toBeInstanceOf(RuleViolationError);
    expect((insertError as Error).message).toBe(lockMessage);

    expect(await agreements.listLinesByVersionIds(user.client, [created.versionId])).toEqual([locked]);
  });
});

// ─── 작성 중 1개 ─────────────────────────────────────────────

describe('작성 중 1개 — AV-2, S-4', () => {
  it('작성 중 버전이 있으면 생성·복제 모두 RuleViolationError', async () => {
    const f = await newFixture('협약 리포 — 작성 중 1개');
    const confirmedSource = await createDraft(f, '최종협약본');
    await confirm(confirmedSource.versionId);
    await createDraft(f, '협약변경 1차');

    const createError = await createDraft(f, '두 번째 작성 중').then(() => null, (e: unknown) => e);
    expect(createError).toBeInstanceOf(RuleViolationError);
    expect((createError as Error).message).toContain('작성 중 버전 "협약변경 1차"이 있습니다');

    await expect(
      agreements.cloneVersion(user.client, confirmedSource.versionId, { kind: 'amendment', name: '복제' })
    ).rejects.toBeInstanceOf(RuleViolationError);
    expect(await agreements.listVersionsByProject(user.client, f.projectId)).toHaveLength(2);
  });

  it('동시에 두 번 만들면 하나만 성공하고 나머지는 RuleViolationError(선검사든 23505든)', async () => {
    const f = await newFixture('협약 리포 — 생성 경합');
    const results = await Promise.allSettled([
      createDraft(f, '경합 A'),
      createDraft(f, '경합 B'),
      createDraft(f, '경합 C'),
    ]);
    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    const rejected = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
    expect(fulfilled).toHaveLength(1);
    for (const r of rejected) expect(r.reason).toBeInstanceOf(RuleViolationError);
    expect(await agreements.listVersionsByProject(user.client, f.projectId)).toHaveLength(1);
  });
});

// ─── 삭제 ────────────────────────────────────────────────────

describe('삭제 — AV-4', () => {
  it('단건 삭제는 확정 버전도 지우고 하위 3종이 cascade로 사라진다, 두 번째는 NotFoundError', async () => {
    const f = await newFixture('협약 리포 — 단건 삭제');
    const created = await createDraft(
      f,
      '최종협약본',
      [line(f.year1Id, 100)],
      [participant(f.year1Id, f.memberId, 10)]
    );
    await insertItem(created.versionId, f.year1Id);
    await confirm(created.versionId);
    expect(await countChildren(created.versionId)).toEqual({ lines: 1, participants: 1, items: 1 });

    await agreements.removeVersion(user.client, created.versionId);
    expect(await countChildren(created.versionId)).toEqual({ lines: 0, participants: 0, items: 0 });
    expect(await agreements.listVersionsByProject(user.client, f.projectId)).toEqual([]);
    await expect(agreements.removeVersion(user.client, created.versionId)).rejects.toBeInstanceOf(NotFoundError);
  });

  it('전체 삭제는 그 과제 버전만 지우고 다른 과제는 그대로다', async () => {
    const target = await newFixture('협약 리포 — 전체 삭제 대상');
    const other = await newFixture('협약 리포 — 전체 삭제 이웃');
    const t1 = await createDraft(target, '최종협약본', [line(target.year1Id, 100)]);
    await confirm(t1.versionId);
    await createDraft(target, '협약변경 1차', [line(target.year1Id, 200)]);
    const o1 = await createDraft(other, '최종협약본', [line(other.year1Id, 300)], [participant(other.year1Id, other.memberId, 10)]);
    const otherBefore = await snapshot(o1.versionId);
    const otherVersionsBefore = await agreements.listVersionsByProject(user.client, other.projectId);

    expect(await agreements.removeAllVersions(user.client, target.projectId)).toEqual({ deleted: 2 });
    expect(await agreements.listVersionsByProject(user.client, target.projectId)).toEqual([]);
    expect(await agreements.listVersionsByProject(user.client, other.projectId)).toEqual(otherVersionsBefore);
    expect(await snapshot(o1.versionId)).toEqual(otherBefore);

    // 버전이 없어도 성공(0건), 없는 과제는 NotFoundError
    expect(await agreements.removeAllVersions(user.client, target.projectId)).toEqual({ deleted: 0 });
    await expect(agreements.removeAllVersions(user.client, randomUUID())).rejects.toBeInstanceOf(NotFoundError);
  });
});

// ─── 과제 경계 ───────────────────────────────────────────────

describe('과제 경계 — N-13', () => {
  it('다른 과제의 연차·인력으로 만들기·줄 추가는 RuleViolationError, 아무것도 남지 않는다', async () => {
    const mine = await newFixture('협약 리포 — 경계 내 과제');
    const foreign = await newFixture('협약 리포 — 경계 남 과제');

    const yearError = await createDraft(mine, '경계', [line(foreign.year1Id, 100)]).then(() => null, (e: unknown) => e);
    expect(yearError).toBeInstanceOf(RuleViolationError);
    expect((yearError as Error).message).toBe('이 과제에 속하지 않은 연차입니다');

    const memberError = await createDraft(mine, '경계', [], [participant(mine.year1Id, foreign.memberId, 10)])
      .then(() => null, (e: unknown) => e);
    expect(memberError).toBeInstanceOf(RuleViolationError);
    expect((memberError as Error).message).toBe('이 과제에 속하지 않은 참여인력입니다');
    expect(await agreements.listVersionsByProject(user.client, mine.projectId)).toEqual([]);

    const created = await createDraft(mine, '경계');
    const insertError = await agreements
      .insertLine(user.client, { versionId: created.versionId, ...line(foreign.year1Id, 1) })
      .then(() => null, (e: unknown) => e);
    expect(insertError).toBeInstanceOf(RuleViolationError);
    expect((insertError as Error).message).toBe('이 과제에 속하지 않은 연차입니다');
    expect(await countChildren(created.versionId)).toEqual({ lines: 0, participants: 0, items: 0 });
  });

  it('없는 과제에 만들면 NotFoundError', async () => {
    await expect(
      agreements.createVersion(user.client, randomUUID(), { kind: 'final', name: 'x', lines: [], participants: [] })
    ).rejects.toBeInstanceOf(NotFoundError);
  });
});
