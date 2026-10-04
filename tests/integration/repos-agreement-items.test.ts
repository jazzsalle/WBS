// 편성 항목 쓰기 리포지토리(lib/db/agreements.ts) 통합 테스트 — Phase 26 T7
// (SOT §5.24, §8.4 O-1, §8.6, §9 Agreement Budget, 계획서 docs/plans/phase-26-plan.md S-1·S-12·S-14·S-22)
//
// publishable 키 + 실제 세션으로 리포지토리를 부른다 — 검증 대상은 재정의된 가드 트리거(확정 버전 증빙 예외)·
// evidence check·version 조건의 거부가 계약대로 RuleViolationError/StaleDataError/NotFoundError로 바뀌는지다.
// 트리거·check 자체는 rules-evidence-migration.test.ts가 직결 SQL로 검증한다.
// 직결 SQL은 결과 확인과 정리 전용이다. 자기가 만든 과제·사용자만 지운다.

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Sql } from 'postgres';
import { connectDirectDb, createTestUser, destroyTestUser, type TestUser } from './helpers';
import * as agreements from '@/lib/db/agreements';
import * as projects from '@/lib/db/projects';
import * as stages from '@/lib/db/stages';
import * as years from '@/lib/db/years';
import { NotFoundError, RuleViolationError, StaleDataError, ValidationError } from '@/lib/db/errors';
import type { AgreementEvidenceCheck } from '@/types';

let sql: Sql;
let user: TestUser;
const tempProjectIds: string[] = []; // afterAll 안전망 — 실패해도 dev DB를 원복한다

interface Fixture {
  projectId: string;
  year1Id: string;
  year2Id: string;
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
  return { projectId: project.id, year1Id: year1.id, year2Id: year2.id };
}

const EVIDENCE: AgreementEvidenceCheck[] = [
  { label: '견적서', obtained: false, memo: '' },
  { label: '비교견적서', obtained: false, memo: '' },
];

async function createDraft(f: Fixture, items: agreements.AgreementItemSeed[] = []) {
  return agreements.createVersion(user.client, f.projectId, {
    kind: 'final',
    name: '최종협약본',
    lines: [],
    participants: [],
    items,
  });
}

async function confirm(versionId: string) {
  const v = await agreements.getVersionById(user.client, versionId);
  return agreements.confirmVersion(user.client, versionId, v.version, user.id);
}

async function addItem(versionId: string, yearId: string, evidence: AgreementEvidenceCheck[] = EVIDENCE) {
  return agreements.insertItem(user.client, {
    versionId,
    yearId,
    kind: 'equipment',
    name: '분석 장비',
    amount: 30_000_000,
    quantity: 1,
    evidence,
    createdBy: user.id,
    updatedBy: user.id,
  });
}

beforeAll(async () => {
  sql = connectDirectDb();
  user = await createTestUser(sql);
});

afterAll(async () => {
  if (tempProjectIds.length > 0) {
    // 버전을 먼저 지운다 — delete_project(H-7)와 같은 순서. 연차의 no action FK를 피한다
    await sql`delete from public.agreement_versions where project_id = any(${tempProjectIds}::uuid[])`;
    await sql`delete from public.projects where id = any(${tempProjectIds}::uuid[])`;
  }
  await destroyTestUser(sql, user);
  await sql.end();
});

// ─── 작성 중 버전 CRUD ───────────────────────────────────────

describe('작성 중 버전 — 편성 항목 CRUD', () => {
  it('추가·조회·수정·증빙 교체·삭제가 앱 형태로 왕복한다', async () => {
    const f = await newFixture('편성 항목 리포 — CRUD');
    const v = await createDraft(f);

    const inserted = await addItem(v.versionId, f.year1Id);
    expect(inserted).toMatchObject({
      versionId: v.versionId,
      yearId: f.year1Id,
      kind: 'equipment',
      name: '분석 장비',
      amount: 30_000_000,
      quantity: 1,
      evidence: EVIDENCE,
      createdBy: user.id,
    });
    expect(await agreements.getItemById(user.client, inserted.id)).toEqual(inserted);

    const updated = await agreements.updateItem(
      user.client,
      inserted.id,
      { yearId: f.year2Id, kind: 'material', name: '시약', amount: 1_200_000, quantity: 2.5, updatedBy: user.id },
      inserted.version
    );
    expect(updated).toMatchObject({
      id: inserted.id,
      yearId: f.year2Id,
      kind: 'material',
      name: '시약',
      amount: 1_200_000,
      quantity: 2.5,
      evidence: EVIDENCE, // updateItem은 증빙을 건드리지 않는다
      version: inserted.version + 1,
    });

    // 작성 중 버전은 라벨 추가·이름 변경도 된다
    const nextEvidence: AgreementEvidenceCheck[] = [
      { label: '견적서(갱신)', obtained: true, memo: '3개사' },
      { label: '비교견적서', obtained: false, memo: '' },
      { label: '계약서', obtained: false, memo: '' },
    ];
    const withEvidence = await agreements.updateItemEvidence(
      user.client,
      inserted.id,
      nextEvidence,
      updated.version,
      user.id
    );
    expect(withEvidence.evidence).toEqual(nextEvidence);
    expect(withEvidence).toMatchObject({ name: '시약', amount: 1_200_000, version: updated.version + 1 });

    const listed = await agreements.listItemsByVersionIds(user.client, [v.versionId]);
    expect(listed).toEqual([withEvidence]);

    await agreements.removeItem(user.client, inserted.id);
    await expect(agreements.getItemById(user.client, inserted.id)).rejects.toBeInstanceOf(NotFoundError);
    await expect(agreements.removeItem(user.client, inserted.id)).rejects.toBeInstanceOf(NotFoundError);
  });

  it('evidence 생략 = 빈 배열, 수량 null', async () => {
    const f = await newFixture('편성 항목 리포 — 기본값');
    const v = await createDraft(f);
    const item = await agreements.insertItem(user.client, {
      versionId: v.versionId,
      yearId: f.year1Id,
      kind: 'outsourcing',
      name: '분석 용역',
      amount: 0,
      quantity: null,
    });
    expect(item).toMatchObject({ evidence: [], quantity: null, amount: 0 });
  });

  it('갱신할 내용이 없으면 ValidationError — evidence를 섞어 보내도 updateItem은 무시한다', async () => {
    const f = await newFixture('편성 항목 리포 — 빈 patch');
    const v = await createDraft(f);
    const item = await addItem(v.versionId, f.year1Id);
    const wide = { updatedBy: user.id, evidence: [] } as agreements.AgreementItemPatch;
    await expect(agreements.updateItem(user.client, item.id, wide, item.version)).rejects.toBeInstanceOf(
      ValidationError
    );
    expect((await agreements.getItemById(user.client, item.id)).evidence).toEqual(EVIDENCE);
  });

  it('없는 id는 NotFoundError(조회·수정·증빙·삭제)', async () => {
    const missing = randomUUID();
    await expect(agreements.getItemById(user.client, missing)).rejects.toBeInstanceOf(NotFoundError);
    await expect(agreements.updateItem(user.client, missing, { name: 'x' }, 1)).rejects.toBeInstanceOf(
      NotFoundError
    );
    await expect(agreements.updateItemEvidence(user.client, missing, EVIDENCE, 1)).rejects.toBeInstanceOf(
      NotFoundError
    );
    await expect(agreements.removeItem(user.client, missing)).rejects.toBeInstanceOf(NotFoundError);
  });

  it('다른 과제의 연차는 RuleViolationError(가드 트리거)', async () => {
    const f = await newFixture('편성 항목 리포 — 경계');
    const other = await newFixture('편성 항목 리포 — 경계 다른 과제');
    const v = await createDraft(f);
    await expect(addItem(v.versionId, other.year1Id)).rejects.toBeInstanceOf(RuleViolationError);
  });
});

// ─── 낙관적 잠금 ─────────────────────────────────────────────

describe('version 불일치 → StaleDataError', () => {
  it('updateItem·updateItemEvidence 모두 옛 version이면 STALE이고 최신 updatedBy를 싣는다', async () => {
    const f = await newFixture('편성 항목 리포 — STALE');
    const v = await createDraft(f);
    const item = await addItem(v.versionId, f.year1Id);
    await agreements.updateItem(user.client, item.id, { amount: 1, updatedBy: user.id }, item.version);

    const stale = agreements.updateItem(user.client, item.id, { amount: 2 }, item.version);
    await expect(stale).rejects.toBeInstanceOf(StaleDataError);
    await expect(stale).rejects.toMatchObject({ updatedBy: user.id });
    await expect(
      agreements.updateItemEvidence(user.client, item.id, EVIDENCE, item.version)
    ).rejects.toBeInstanceOf(StaleDataError);
  });
});

// ─── 확정 버전 (S-1 증빙 예외) ───────────────────────────────

describe('확정 버전 — 체크·메모만 통과', () => {
  async function confirmedItem(name: string) {
    const f = await newFixture(name);
    const v = await createDraft(f);
    const item = await addItem(v.versionId, f.year1Id);
    await confirm(v.versionId);
    return { f, v, item };
  }

  it('받음 체크·메모 변경은 성공한다', async () => {
    const { item } = await confirmedItem('편성 항목 리포 — 확정 체크');
    const checked: AgreementEvidenceCheck[] = [
      { label: '견적서', obtained: true, memo: '2개사 받음' },
      { label: '비교견적서', obtained: true, memo: '' },
    ];
    const updated = await agreements.updateItemEvidence(user.client, item.id, checked, item.version, user.id);
    expect(updated).toMatchObject({ evidence: checked, version: item.version + 1, name: '분석 장비' });
  });

  it('라벨 이름·순서·추가·삭제는 RuleViolationError', async () => {
    const { item } = await confirmedItem('편성 항목 리포 — 확정 라벨');
    const cases: AgreementEvidenceCheck[][] = [
      [
        { label: '견적서(새)', obtained: false, memo: '' },
        { label: '비교견적서', obtained: false, memo: '' },
      ],
      [...EVIDENCE].reverse(),
      [...EVIDENCE, { label: '계약서', obtained: false, memo: '' }],
      EVIDENCE.slice(0, 1),
    ];
    for (const evidence of cases) {
      await expect(
        agreements.updateItemEvidence(user.client, item.id, evidence, item.version)
      ).rejects.toBeInstanceOf(RuleViolationError);
    }
    expect(await agreements.getItemById(user.client, item.id)).toEqual(item);
  });

  it('금액·품명 변경과 INSERT는 RuleViolationError', async () => {
    const { f, v, item } = await confirmedItem('편성 항목 리포 — 확정 잠금');
    await expect(
      agreements.updateItem(user.client, item.id, { amount: 1 }, item.version)
    ).rejects.toBeInstanceOf(RuleViolationError);
    await expect(
      agreements.updateItem(user.client, item.id, { name: '다른 장비' }, item.version)
    ).rejects.toBeInstanceOf(RuleViolationError);
    await expect(addItem(v.versionId, f.year1Id)).rejects.toThrow(/확정된 협약 예산 버전/);
  });
});

// ─── evidence 모양 (check 23514) ─────────────────────────────

describe('evidence 모양 위반 → RuleViolationError(사람 문구)', () => {
  it('빈 라벨·중복 라벨·긴 메모·31개는 거부되고 제약명을 노출하지 않는다', async () => {
    const f = await newFixture('편성 항목 리포 — evidence check');
    const v = await createDraft(f);
    const item = await addItem(v.versionId, f.year1Id);
    const bad: AgreementEvidenceCheck[][] = [
      [{ label: '  ', obtained: false, memo: '' }],
      [
        { label: '견적서', obtained: false, memo: '' },
        { label: '견적서', obtained: true, memo: '' },
      ],
      [{ label: '견적서', obtained: false, memo: 'x'.repeat(501) }],
      Array.from({ length: 31 }, (_, i) => ({ label: `서류 ${i}`, obtained: false, memo: '' })),
    ];
    for (const evidence of bad) {
      const error = await agreements
        .updateItemEvidence(user.client, item.id, evidence, item.version)
        .then(() => null, (e: unknown) => e);
      expect(error).toBeInstanceOf(RuleViolationError);
      expect((error as Error).message).toMatch(/증빙 목록이 올바르지 않습니다/);
      expect((error as Error).message).not.toMatch(/agreement_items/); // SA-4
    }
    await expect(addItem(v.versionId, f.year1Id, bad[1])).rejects.toThrow(/증빙 목록이 올바르지 않습니다/);
  });
});

// ─── 생성·복제 RPC ───────────────────────────────────────────

describe('createVersion items · cloneVersion', () => {
  it('items가 저장되고 결과에 건수가 실린다, 생략하면 0건', async () => {
    const f = await newFixture('편성 항목 리포 — 보내기 items');
    const seeds: agreements.AgreementItemSeed[] = [
      { yearId: f.year1Id, kind: 'equipment', name: '분석 장비', amount: 30_000_000, quantity: 1, evidence: EVIDENCE },
      { yearId: f.year2Id, kind: 'outsourcing', name: '시험 용역', amount: 5_000_000, quantity: null, evidence: [] },
    ];
    const created = await createDraft(f, seeds);
    expect(created).toMatchObject({ order: 1, lines: 0, participants: 0, items: 2 });

    const items = await agreements.listItemsByVersionIds(user.client, [created.versionId]);
    expect(items).toHaveLength(2);
    for (const seed of seeds) {
      expect(items.find((i) => i.name === seed.name)).toMatchObject({ ...seed, versionId: created.versionId });
    }

    await confirm(created.versionId);
    const empty = await agreements.createVersion(user.client, f.projectId, {
      kind: 'amendment',
      name: '빈 버전',
      lines: [],
      participants: [],
    });
    expect(empty).toMatchObject({ order: 2, items: 0 });
  });

  it('items의 evidence 모양이 틀리면 버전째 거부된다(RULE)', async () => {
    const f = await newFixture('편성 항목 리포 — 보내기 evidence');
    await expect(
      createDraft(f, [
        {
          yearId: f.year1Id,
          kind: 'material',
          name: '시약',
          amount: 1,
          quantity: null,
          evidence: [{ label: '', obtained: false, memo: '' }],
        },
      ])
    ).rejects.toBeInstanceOf(RuleViolationError);
    expect(await agreements.listVersionsByProject(user.client, f.projectId)).toEqual([]);
  });

  it('복제는 편성 항목을 증빙째 새 id로 복사한다', async () => {
    const f = await newFixture('편성 항목 리포 — 복제');
    const source = await createDraft(f);
    const item = await addItem(source.versionId, f.year1Id, [
      { label: '견적서', obtained: true, memo: '받음' },
      { label: '계약서', obtained: false, memo: '' },
    ]);
    await confirm(source.versionId);

    const cloned = await agreements.cloneVersion(user.client, source.versionId, { kind: 'amendment', name: '변경 1차' });
    expect(cloned).toMatchObject({ order: 2, items: 1 });
    const [copy] = await agreements.listItemsByVersionIds(user.client, [cloned.versionId]);
    expect(copy).toMatchObject({
      versionId: cloned.versionId,
      yearId: item.yearId,
      kind: item.kind,
      name: item.name,
      amount: item.amount,
      quantity: item.quantity,
      evidence: item.evidence,
    });
    expect(copy!.id).not.toBe(item.id);
    // 복제본은 작성 중이라 고칠 수 있고 원본은 그대로다
    await agreements.updateItem(user.client, copy!.id, { amount: 1 }, copy!.version);
    expect(await agreements.getItemById(user.client, item.id)).toMatchObject({ amount: item.amount });
  });
});
