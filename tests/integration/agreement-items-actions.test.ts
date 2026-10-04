// 협약 예산 편성 항목·증빙 액션 통합 테스트 — Phase 26 T10
// (SOT §5.24, §6.19 AG-6, §9 Agreement Budget SA-1~SA-4, §8.4 O-1, 계획서 docs/plans/phase-26-plan.md S-1·S-12·U-3,
// 픽스처 "증빙 잠금")
//
// next/headers를 실제 세션 토큰 스텁으로 바꿔 가드(SA-1)까지 포함해 액션을 그대로 부른다(agreement-participants-actions와 같은 방식).
// 결과 확인은 직결 SQL로 저장된 원본을 본다. 리포지토리는 SA-4 시험을 위해 insertItem 하나만 고장 주입 스위치를 둔다.
// 자기가 만든 과제·사용자만 지운다 — 파괴적 테스트가 아니다.

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Sql } from 'postgres';
import { connectDirectDb, createTestUser, destroyTestUser, type TestUser } from './helpers';
import type { ActionResult, AgreementEvidenceCheck } from '@/types';
import { AGREEMENT_EVIDENCE_DEFAULTS } from '@/lib/constants';
import * as projectsRepo from '@/lib/db/projects';
import * as stagesRepo from '@/lib/db/stages';
import * as yearsRepo from '@/lib/db/years';

const session = vi.hoisted(() => ({ accessToken: '' }));
const fault = vi.hoisted(() => ({ insert: false }));

vi.mock('next/headers', () => ({
  cookies: async () => ({ get: () => ({ value: session.accessToken }) }),
}));
vi.mock('next/cache', () => ({ revalidatePath: () => undefined }));
vi.mock('@/lib/db/agreements', async (importOriginal) => {
  const original = await importOriginal<typeof import('@/lib/db/agreements')>();
  return {
    ...original,
    insertItem: (...args: Parameters<typeof original.insertItem>) =>
      fault.insert
        ? Promise.reject(
            new Error(
              '[db] 23503: insert or update on table "agreement_items" violates foreign key constraint "agreement_items_year_id_fkey"'
            )
          )
        : original.insertItem(...args),
  };
});

const actions = await import('@/actions/agreement-items');
const agreementsRepo = await import('@/lib/db/agreements');

let sql: Sql;
let user: TestUser;
const tempProjectIds: string[] = [];

let projectId: string;
let year1Id: string;
let year2Id: string;
let otherYearId: string;
let otherDraftVersionId: string;

let confirmedVersionId: string;
let confirmedItemId: string;
let draftVersionId: string;

function unwrap<T>(result: ActionResult<T>): T {
  if (!result.ok) throw new Error(`액션 실패: ${result.error} (code=${result.code ?? '-'})`);
  return result.data;
}

function expectCode(result: ActionResult<unknown>, code: string | undefined): string {
  if (result.ok) throw new Error(`실패해야 하는 호출이 통과했습니다 (기대 code=${code ?? '-'}).`);
  expect(result.code).toBe(code);
  return result.error;
}

// ─── 직결 SQL 조회 (bigint·numeric은 text로 받아 숫자로 — 부동소수점 경유 금지) ──────────

interface ItemRow {
  versionId: string;
  yearId: string;
  kind: string;
  name: string;
  amount: number;
  quantity: number | null;
  evidence: AgreementEvidenceCheck[];
  version: number;
}

async function readRow(id: string): Promise<ItemRow | undefined> {
  const rows = await sql<
    {
      version_id: string;
      year_id: string;
      kind: string;
      name: string;
      amount: string;
      quantity: string | null;
      evidence: string;
      version: string;
    }[]
  >`
    select version_id::text, year_id::text, kind, name, amount::text, quantity::text, evidence::text, version::text
      from public.agreement_items where id = ${id}::uuid`;
  const r = rows[0];
  if (!r) return undefined;
  return {
    versionId: r.version_id,
    yearId: r.year_id,
    kind: r.kind,
    name: r.name,
    amount: Number(r.amount),
    quantity: r.quantity === null ? null : Number(r.quantity),
    evidence: JSON.parse(r.evidence) as AgreementEvidenceCheck[],
    version: Number(r.version),
  };
}

async function mustRead(id: string): Promise<ItemRow> {
  const row = await readRow(id);
  if (!row) throw new Error(`편성 항목 ${id}가 DB에 없습니다.`);
  return row;
}

async function countRows(versionId: string): Promise<number> {
  const rows = await sql<{ n: number }[]>`
    select count(*)::int as n from public.agreement_items where version_id = ${versionId}::uuid`;
  return rows[0]!.n;
}

// ─── 준비 ─────────────────────────────────────────────────────────────────────

beforeAll(async () => {
  sql = connectDirectDb();
  user = await createTestUser(sql);
  session.accessToken = user.accessToken;

  const project = await projectsRepo.createProjectWithDefaults(user.client, {
    name: '편성 항목 액션 테스트 과제',
    contractStartDate: '2026-01-01',
  });
  projectId = project.id;
  tempProjectIds.push(projectId);
  const firstYear = (await yearsRepo.listYears(user.client, projectId))[0];
  if (!firstYear) throw new Error('createProjectWithDefaults가 연차를 만들지 않았습니다.');
  year1Id = firstYear.id;
  const stage = (await stagesRepo.listStages(user.client, projectId))[0];
  if (!stage) throw new Error('createProjectWithDefaults가 단계를 만들지 않았습니다.');
  year2Id = (
    await yearsRepo.createYear(user.client, {
      stageId: stage.id,
      name: '2차년도',
      startDate: '2027-01-01',
      endDate: '2027-12-31',
    })
  ).id;

  const other = await projectsRepo.createProjectWithDefaults(user.client, {
    name: '편성 항목 액션 남의 과제',
    contractStartDate: '2026-01-01',
  });
  tempProjectIds.push(other.id);
  const otherYear = (await yearsRepo.listYears(user.client, other.id))[0];
  if (!otherYear) throw new Error('남의 과제에 연차가 없습니다.');
  otherYearId = otherYear.id;
  otherDraftVersionId = (
    await agreementsRepo.createVersion(user.client, other.id, {
      kind: 'final',
      name: '남의 작성 중',
      lines: [],
      participants: [],
    })
  ).versionId;

  // 픽스처 "증빙 잠금": 확정 버전 장비 33,000,000, 증빙 [견적서 true "2개사"]
  // 확정 → 그 뒤 작성 중. 작성 중은 과제당 하나라(AV-2) 이 순서로만 둘 다 가질 수 있다
  confirmedVersionId = (
    await agreementsRepo.createVersion(user.client, projectId, {
      kind: 'selection',
      name: '선정평가본',
      lines: [],
      participants: [],
      items: [
        {
          yearId: year1Id,
          kind: 'equipment',
          name: '분광 분석기',
          amount: 33_000_000,
          quantity: 1,
          evidence: [{ label: '견적서', obtained: true, memo: '2개사' }],
        },
      ],
    })
  ).versionId;
  confirmedItemId = (await agreementsRepo.listItemsByVersionIds(user.client, [confirmedVersionId]))[0]!.id;
  const fresh = await agreementsRepo.getVersionById(user.client, confirmedVersionId);
  await agreementsRepo.confirmVersion(user.client, confirmedVersionId, fresh.version, user.id);

  draftVersionId = (
    await agreementsRepo.createVersion(user.client, projectId, {
      kind: 'final',
      name: '최종협약본',
      lines: [],
      participants: [],
    })
  ).versionId;
});

afterAll(async () => {
  if (tempProjectIds.length > 0) {
    // 버전을 먼저 지운다 — 연차 FK가 no action이라(H-5a) 과제 cascade가 막힌다(delete_project와 같은 순서)
    await sql`delete from public.agreement_versions where project_id = any(${tempProjectIds}::uuid[])`;
    await sql`delete from public.projects where id = any(${tempProjectIds}::uuid[])`;
    const rows = await sql<{ n: number }[]>`
      select ((select count(*) from public.projects where id = any(${tempProjectIds}::uuid[]))
            + (select count(*) from public.agreement_versions where project_id = any(${tempProjectIds}::uuid[])))::int as n`;
    if (rows[0]!.n !== 0) throw new Error(`테스트가 만든 데이터가 ${rows[0]!.n}건 남았습니다.`);
  }
  await destroyTestUser(sql, user);
  await sql.end();
});

// ─── 추가 ─────────────────────────────────────────────────────────────────────

let equipmentId: string; // 작성 중 장비 — 기본 증빙
let outsourcingId: string; // 작성 중 외주 — 증빙 직접 지정

describe('편성 항목 추가 (S-12)', () => {
  it('evidence 생략 = 그 종류 기본 목록 복사(전부 안 받음·메모 없음), 품명 trim', async () => {
    const item = unwrap(
      await actions.addAgreementItem(draftVersionId, {
        yearId: year1Id,
        kind: 'equipment',
        name: '  분광 분석기  ',
        amount: 28_000_000,
        quantity: 1,
      })
    );
    equipmentId = item.id;
    const row = await mustRead(item.id);
    expect(row).toMatchObject({
      versionId: draftVersionId,
      yearId: year1Id,
      kind: 'equipment',
      name: '분광 분석기',
      amount: 28_000_000,
      quantity: 1,
    });
    expect(row.evidence).toEqual(
      AGREEMENT_EVIDENCE_DEFAULTS.equipment.map((label) => ({ label, obtained: false, memo: '' }))
    );
  });

  it('재료·외주도 각 종류의 기본 목록, evidence를 주면 그대로(라벨 trim)', async () => {
    const material = unwrap(
      await actions.addAgreementItem(draftVersionId, {
        yearId: year2Id,
        kind: 'material',
        name: '시약',
        amount: 1_200_000,
        quantity: null,
      })
    );
    const materialRow = await mustRead(material.id);
    expect(materialRow.quantity).toBeNull();
    expect(materialRow.evidence.map((c) => c.label)).toEqual([...AGREEMENT_EVIDENCE_DEFAULTS.material]);

    const outsourcing = unwrap(
      await actions.addAgreementItem(draftVersionId, {
        yearId: year1Id,
        kind: 'outsourcing',
        name: '시제품 가공',
        amount: 5_000_000,
        quantity: 2.5,
        evidence: [{ label: ' 과업지시서 ', obtained: true, memo: '초안' }],
      })
    );
    outsourcingId = outsourcing.id;
    const row = await mustRead(outsourcing.id);
    expect(row.quantity).toBe(2.5);
    expect(row.evidence).toEqual([{ label: '과업지시서', obtained: true, memo: '초안' }]);
  });

  it('evidence: [] 는 빈 목록 그대로(기본 목록으로 채우지 않는다)', async () => {
    const item = unwrap(
      await actions.addAgreementItem(draftVersionId, {
        yearId: year1Id,
        kind: 'material',
        name: '소모품',
        amount: 0,
        quantity: 0,
        evidence: [],
      })
    );
    expect((await mustRead(item.id)).evidence).toEqual([]);
  });

  it('입력 검증은 VALIDATION, DB까지 가지 않는다', async () => {
    const before = await countRows(draftVersionId);
    const base = { yearId: year1Id, kind: 'equipment', name: '장비', amount: 1, quantity: null };
    expect(expectCode(await actions.addAgreementItem(draftVersionId, { ...base, name: '   ' }), 'VALIDATION')).toBe(
      '품명을 입력하세요.'
    );
    expectCode(await actions.addAgreementItem(draftVersionId, { ...base, name: 'x'.repeat(201) }), 'VALIDATION');
    expectCode(await actions.addAgreementItem(draftVersionId, { ...base, amount: 1.5 }), 'VALIDATION');
    expectCode(await actions.addAgreementItem(draftVersionId, { ...base, amount: -1 }), 'VALIDATION');
    expectCode(
      await actions.addAgreementItem(draftVersionId, { ...base, amount: Number.MAX_SAFE_INTEGER + 1 }),
      'VALIDATION'
    );
    expectCode(await actions.addAgreementItem(draftVersionId, { ...base, quantity: -1 }), 'VALIDATION');
    expect(
      expectCode(await actions.addAgreementItem(draftVersionId, { ...base, kind: 'rental' }), 'VALIDATION')
    ).toBe('편성 항목 종류가 올바르지 않습니다.');
    expectCode(await actions.addAgreementItem(draftVersionId, { ...base, extra: 1 }), 'VALIDATION');
    expectCode(await actions.addAgreementItem('nope', base), 'VALIDATION');

    // 공백만 있는 라벨은 Zod에서 사용자 문구로 — DB check 문구(EVIDENCE_INVALID)까지 가지 않는다
    expect(
      expectCode(
        await actions.addAgreementItem(draftVersionId, {
          ...base,
          evidence: [{ label: '   ', obtained: false, memo: '' }],
        }),
        'VALIDATION'
      )
    ).toBe('증빙 이름을 입력하세요.');
    expectCode(
      await actions.addAgreementItem(draftVersionId, {
        ...base,
        evidence: [
          { label: '견적서', obtained: false, memo: '' },
          { label: ' 견적서', obtained: true, memo: '' },
        ],
      }),
      'VALIDATION'
    );
    expectCode(
      await actions.addAgreementItem(draftVersionId, {
        ...base,
        evidence: [{ label: '견적서', obtained: false, memo: 'm'.repeat(501) }],
      }),
      'VALIDATION'
    );
    expectCode(
      await actions.addAgreementItem(draftVersionId, {
        ...base,
        evidence: Array.from({ length: 31 }, (_, i) => ({ label: `서류${i}`, obtained: false, memo: '' })),
      }),
      'VALIDATION'
    );
    expect(await countRows(draftVersionId)).toBe(before);
  });

  it('과제 경계: 다른 과제의 연차는 RULE', async () => {
    const before = await countRows(draftVersionId);
    expect(
      expectCode(
        await actions.addAgreementItem(draftVersionId, {
          yearId: otherYearId,
          kind: 'equipment',
          name: '장비',
          amount: 1,
          quantity: null,
        }),
        'RULE'
      )
    ).toBe('이 과제에 속하지 않은 연차입니다.');
    expect(await countRows(draftVersionId)).toBe(before);
  });

  it('없는 버전은 찾을 수 없음', async () => {
    const err = expectCode(
      await actions.addAgreementItem('00000000-0000-4000-8000-000000000000', {
        yearId: year1Id,
        kind: 'equipment',
        name: '장비',
        amount: 1,
        quantity: null,
      }),
      undefined
    );
    expect(err).toContain('찾을 수 없습니다');
  });
});

// ─── 수정 ─────────────────────────────────────────────────────────────────────

describe('편성 항목 수정 (O-1)', () => {
  it('연차·종류·품명·금액·수량을 바꾼다 — 증빙은 그대로', async () => {
    const row = await mustRead(equipmentId);
    unwrap(
      await actions.updateAgreementItem(
        equipmentId,
        { yearId: year2Id, name: '분광 분석기 Ⅱ', amount: 31_000_000, quantity: 2 },
        row.version
      )
    );
    const after = await mustRead(equipmentId);
    expect(after).toMatchObject({ yearId: year2Id, name: '분광 분석기 Ⅱ', amount: 31_000_000, quantity: 2 });
    expect(after.evidence).toEqual(row.evidence);
    expect(after.version).toBe(row.version + 1);

    unwrap(await actions.updateAgreementItem(equipmentId, { kind: 'material', quantity: null }, after.version));
    const again = await mustRead(equipmentId);
    expect(again).toMatchObject({ kind: 'material', quantity: null });
    expect(again.evidence).toEqual(row.evidence);
  });

  it('patch에 evidence 키가 오면 VALIDATION, DB 불변', async () => {
    const row = await mustRead(equipmentId);
    const err = expectCode(
      await actions.updateAgreementItem(equipmentId, { evidence: [], amount: 1 }, row.version),
      'VALIDATION'
    );
    expect(err).toContain('증빙');
    expect(await mustRead(equipmentId)).toEqual(row);
  });

  it('입력 검증: 빈 patch·공백 품명·잘못된 금액·버전·id는 VALIDATION', async () => {
    const row = await mustRead(equipmentId);
    expectCode(await actions.updateAgreementItem(equipmentId, {}, row.version), 'VALIDATION');
    expectCode(await actions.updateAgreementItem(equipmentId, { name: '  ' }, row.version), 'VALIDATION');
    expectCode(await actions.updateAgreementItem(equipmentId, { amount: 0.5 }, row.version), 'VALIDATION');
    expectCode(await actions.updateAgreementItem(equipmentId, { amount: 1 }, -1), 'VALIDATION');
    expectCode(await actions.updateAgreementItem('nope', { amount: 1 }, row.version), 'VALIDATION');
    expect(await mustRead(equipmentId)).toEqual(row);
  });

  it('과제 경계: 다른 과제 연차로 옮기기는 RULE', async () => {
    const row = await mustRead(equipmentId);
    expectCode(await actions.updateAgreementItem(equipmentId, { yearId: otherYearId }, row.version), 'RULE');
    expect(await mustRead(equipmentId)).toEqual(row);
  });

  it('O-1: 낡은 expectedVersion은 STALE, DB 불변', async () => {
    const row = await mustRead(equipmentId);
    const err = expectCode(await actions.updateAgreementItem(equipmentId, { amount: 1 }, row.version - 1), 'STALE');
    expect(err).toContain('먼저 수정했습니다');
    expect(await mustRead(equipmentId)).toEqual(row);
  });

  it('없는 항목은 찾을 수 없음', async () => {
    const err = expectCode(
      await actions.updateAgreementItem('00000000-0000-4000-8000-000000000000', { amount: 1 }, 1),
      undefined
    );
    expect(err).toContain('찾을 수 없습니다');
  });
});

// ─── 증빙 (작성 중 = 자유) ────────────────────────────────────────────────────

describe('증빙 갱신 — 작성 중 버전은 추가·삭제·이름·순서·체크·메모 전부 허용', () => {
  it('통째 교체', async () => {
    let row = await mustRead(outsourcingId);
    const next = [
      { label: '견적서', obtained: true, memo: '3개사' },
      { label: '과업지시서 (수정)', obtained: false, memo: '' },
      { label: '계약서', obtained: false, memo: '' },
    ];
    unwrap(await actions.updateAgreementItemEvidence(outsourcingId, next, row.version));
    row = await mustRead(outsourcingId);
    expect(row.evidence).toEqual(next);

    unwrap(await actions.updateAgreementItemEvidence(outsourcingId, [next[2]!, next[0]!], row.version));
    row = await mustRead(outsourcingId);
    expect(row.evidence).toEqual([next[2], next[0]]);

    unwrap(await actions.updateAgreementItemEvidence(outsourcingId, [], row.version));
    expect((await mustRead(outsourcingId)).evidence).toEqual([]);
  });

  it('검증 실패(공백 라벨·중복·모양)는 VALIDATION, DB 불변', async () => {
    const row = await mustRead(outsourcingId);
    expect(
      expectCode(
        await actions.updateAgreementItemEvidence(outsourcingId, [{ label: ' ', obtained: false, memo: '' }], row.version),
        'VALIDATION'
      )
    ).toBe('증빙 이름을 입력하세요.');
    expectCode(
      await actions.updateAgreementItemEvidence(
        outsourcingId,
        [
          { label: 'A', obtained: false, memo: '' },
          { label: 'A', obtained: false, memo: '' },
        ],
        row.version
      ),
      'VALIDATION'
    );
    expectCode(
      await actions.updateAgreementItemEvidence(outsourcingId, [{ label: 'A', obtained: 'yes', memo: '' }], row.version),
      'VALIDATION'
    );
    expectCode(await actions.updateAgreementItemEvidence(outsourcingId, { label: 'A' }, row.version), 'VALIDATION');
    expect(await mustRead(outsourcingId)).toEqual(row);
  });

  it('O-1: 낡은 expectedVersion은 STALE', async () => {
    const row = await mustRead(outsourcingId);
    expectCode(await actions.updateAgreementItemEvidence(outsourcingId, [], row.version - 1), 'STALE');
    expect(await mustRead(outsourcingId)).toEqual(row);
  });
});

// ─── 픽스처 "증빙 잠금" (S-1, U-3) ────────────────────────────────────────────

describe('증빙 잠금 — 확정 버전은 체크·메모만', () => {
  it('체크 해제·메모 변경은 성공', async () => {
    let row = await mustRead(confirmedItemId);
    expect(row.evidence).toEqual([{ label: '견적서', obtained: true, memo: '2개사' }]);
    unwrap(
      await actions.updateAgreementItemEvidence(
        confirmedItemId,
        [{ label: '견적서', obtained: false, memo: '2개사' }],
        row.version
      )
    );
    row = await mustRead(confirmedItemId);
    expect(row.evidence).toEqual([{ label: '견적서', obtained: false, memo: '2개사' }]);
    unwrap(
      await actions.updateAgreementItemEvidence(
        confirmedItemId,
        [{ label: '견적서', obtained: true, memo: '3개사로 보완' }],
        row.version
      )
    );
    row = await mustRead(confirmedItemId);
    expect(row.evidence).toEqual([{ label: '견적서', obtained: true, memo: '3개사로 보완' }]);
    expect(row.amount).toBe(33_000_000);
  });

  it('라벨 변경·추가·삭제는 RULE, DB 불변', async () => {
    const row = await mustRead(confirmedItemId);
    const renamed = expectCode(
      await actions.updateAgreementItemEvidence(
        confirmedItemId,
        [{ label: '견적서(수정)', obtained: true, memo: '' }],
        row.version
      ),
      'RULE'
    );
    expect(renamed).toContain('확정 버전');
    expectCode(
      await actions.updateAgreementItemEvidence(
        confirmedItemId,
        [...row.evidence, { label: '비교견적서', obtained: false, memo: '' }],
        row.version
      ),
      'RULE'
    );
    expectCode(await actions.updateAgreementItemEvidence(confirmedItemId, [], row.version), 'RULE');
    expect(await mustRead(confirmedItemId)).toEqual(row);
  });

  it('공백 라벨은 확정이어도 VALIDATION(잠금보다 입력 검증이 먼저)', async () => {
    const row = await mustRead(confirmedItemId);
    expectCode(
      await actions.updateAgreementItemEvidence(confirmedItemId, [{ label: ' ', obtained: true, memo: '' }], row.version),
      'VALIDATION'
    );
    expect(await mustRead(confirmedItemId)).toEqual(row);
  });

  it('금액 등 수정·추가·삭제는 RULE — 데이터 불변', async () => {
    const row = await mustRead(confirmedItemId);
    const before = await countRows(confirmedVersionId);
    expect(
      expectCode(await actions.updateAgreementItem(confirmedItemId, { amount: 30_000_000 }, row.version), 'RULE')
    ).toContain('확정');
    expectCode(await actions.updateAgreementItem(confirmedItemId, { name: '다른 장비' }, row.version), 'RULE');
    expectCode(
      await actions.addAgreementItem(confirmedVersionId, {
        yearId: year1Id,
        kind: 'equipment',
        name: '추가 장비',
        amount: 1,
        quantity: null,
      }),
      'RULE'
    );
    expectCode(await actions.deleteAgreementItem(confirmedItemId), 'RULE');
    expect(await countRows(confirmedVersionId)).toBe(before);
    expect(await mustRead(confirmedItemId)).toEqual(row);
  });

  it('STALE이 잠금 판정보다 먼저', async () => {
    const row = await mustRead(confirmedItemId);
    expectCode(await actions.updateAgreementItem(confirmedItemId, { amount: 1 }, row.version - 1), 'STALE');
    expectCode(await actions.updateAgreementItemEvidence(confirmedItemId, row.evidence, row.version - 1), 'STALE');
    expect(await mustRead(confirmedItemId)).toEqual(row);
  });
});

// ─── 다른 과제 버전 ───────────────────────────────────────────────────────────

describe('과제 경계 — 다른 과제의 버전에 이 과제 연차로 추가하면 RULE', () => {
  it('남의 작성 중 버전 + 이 과제 연차', async () => {
    expectCode(
      await actions.addAgreementItem(otherDraftVersionId, {
        yearId: year1Id,
        kind: 'equipment',
        name: '장비',
        amount: 1,
        quantity: null,
      }),
      'RULE'
    );
    expect(await countRows(otherDraftVersionId)).toBe(0);
  });
});

// ─── 삭제 ─────────────────────────────────────────────────────────────────────

describe('편성 항목 삭제', () => {
  it('작성 중 버전의 항목을 지우고, 다시 지우면 찾을 수 없음', async () => {
    const before = await countRows(draftVersionId);
    unwrap(await actions.deleteAgreementItem(outsourcingId));
    expect(await readRow(outsourcingId)).toBeUndefined();
    expect(await countRows(draftVersionId)).toBe(before - 1);
    expect(expectCode(await actions.deleteAgreementItem(outsourcingId), undefined)).toContain('찾을 수 없습니다');
    expectCode(await actions.deleteAgreementItem('nope'), 'VALIDATION');
  });
});

// ─── SA-1 · SA-4 ──────────────────────────────────────────────────────────────

describe('SA-1: 세션 없이는 거부', () => {
  it('토큰이 없으면 실패하고 DB 불변', async () => {
    const before = await countRows(draftVersionId);
    const token = session.accessToken;
    session.accessToken = '';
    try {
      const result = await actions.addAgreementItem(draftVersionId, {
        yearId: year1Id,
        kind: 'equipment',
        name: '장비',
        amount: 1,
        quantity: null,
      });
      expect(result.ok).toBe(false);
      expectCode(await actions.deleteAgreementItem(equipmentId), (result as { code?: string }).code);
    } finally {
      session.accessToken = token;
    }
    expect(await countRows(draftVersionId)).toBe(before);
  });
});

describe('SA-4: DB 내부 메시지를 사용자에게 노출하지 않는다', () => {
  it('리포지토리의 매핑 안 된 에러는 일반 문구로 — 테이블·제약 이름이 없다', async () => {
    const before = await countRows(draftVersionId);
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    fault.insert = true;
    try {
      const result = await actions.addAgreementItem(draftVersionId, {
        yearId: year1Id,
        kind: 'equipment',
        name: '장비',
        amount: 1,
        quantity: null,
      });
      const err = expectCode(result, undefined);
      expect(err).toBe('요청 처리 중 오류가 발생했습니다.');
      expect(err).not.toMatch(/agreement_items|fkey|23503/);
    } finally {
      fault.insert = false;
      spy.mockRestore();
    }
    expect(await countRows(draftVersionId)).toBe(before);
  });
});
