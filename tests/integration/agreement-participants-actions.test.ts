// 협약 예산 참여인원 편집 액션 통합 테스트 — Phase 25 T10
// (SOT §5.23, §6.19 AG-5, §9 Agreement Budget SA-1~SA-4, §8.4 O-1, 계획서 docs/plans/phase-25-plan.md S-11·G-3/Q4b·S-20)
//
// next/headers를 실제 세션 토큰 스텁으로 바꿔 가드(SA-1)까지 포함해 액션을 그대로 부른다(agreement-actions.test.ts와 같은 방식).
// 결과 확인은 액션 반환값이 아니라 직결 SQL로 저장된 원본을 본다 — 재계산·유지가 실제로 DB에 반영됐는지는 DB만 답한다.
// 리포지토리는 SA-4 시험을 위해 insertParticipant 하나만 고장 주입 스위치를 둔다 — 평소에는 원본을 그대로 부른다.
// 자기가 만든 과제·사용자만 지운다 — 파괴적 테스트가 아니다.

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Sql } from 'postgres';
import { connectDirectDb, createTestUser, destroyTestUser, type TestUser } from './helpers';
import type { ActionResult } from '@/types';
import { RuleViolationError } from '@/lib/db/errors';
import * as projectsRepo from '@/lib/db/projects';
import * as stagesRepo from '@/lib/db/stages';
import * as yearsRepo from '@/lib/db/years';
import * as membersRepo from '@/lib/db/members';

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
    insertParticipant: (...args: Parameters<typeof original.insertParticipant>) =>
      fault.insert
        ? Promise.reject(
            new Error(
              '[db] 23503: insert or update on table "agreement_participants" violates foreign key constraint "agreement_participants_member_id_fkey"'
            )
          )
        : original.insertParticipant(...args),
  };
});

const actions = await import('@/actions/agreement-participants');
const agreementsRepo = await import('@/lib/db/agreements');

let sql: Sql;
let user: TestUser;
const tempProjectIds: string[] = [];

let projectId: string;
let year1Id: string;
let year2Id: string;
let m1Id: string; // 연봉 60,000,000 (S-20 M1)
let m2Id: string; // 연봉 50,000,000 (S-20 M2)
let mNoSalaryId: string; // 연봉 미입력

let otherYearId: string;
let otherMemberId: string;

let confirmedVersionId: string;
let confirmedRowId: string;
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

async function newMember(pid: string, name: string, annualSalary: number | null) {
  return membersRepo.createMember(
    user.client,
    {
      projectId: pid,
      orgId: null,
      name,
      role: 'researcher',
      position: '선임연구원',
      field: '',
      email: '',
      phone: '',
      active: true,
      order: 0,
      annualSalary,
      hireType: 'existing',
    },
    user.id
  );
}

// ─── 직결 SQL 조회 (bigint·numeric은 text로 받아 숫자로 — 부동소수점 경유 금지) ──────────

interface ParticipantRow {
  memberId: string | null;
  yearId: string;
  participationRate: number;
  months: number;
  annualSalary: number | null;
  cash: number;
  inKind: number;
  role: string;
  version: number;
}

async function readRow(id: string): Promise<ParticipantRow | undefined> {
  const rows = await sql<
    {
      member_id: string | null;
      year_id: string;
      participation_rate: string;
      months: string;
      annual_salary: string | null;
      personnel_cash: string;
      personnel_in_kind: string;
      role: string;
      version: string;
    }[]
  >`
    select member_id::text, year_id::text, participation_rate::text, months::text, annual_salary::text,
           personnel_cash::text, personnel_in_kind::text, role, version::text
      from public.agreement_participants where id = ${id}::uuid`;
  const r = rows[0];
  if (!r) return undefined;
  return {
    memberId: r.member_id,
    yearId: r.year_id,
    participationRate: Number(r.participation_rate),
    months: Number(r.months),
    annualSalary: r.annual_salary === null ? null : Number(r.annual_salary),
    cash: Number(r.personnel_cash),
    inKind: Number(r.personnel_in_kind),
    role: r.role,
    version: Number(r.version),
  };
}

async function mustRead(id: string): Promise<ParticipantRow> {
  const row = await readRow(id);
  if (!row) throw new Error(`참여인원 ${id}가 DB에 없습니다.`);
  return row;
}

async function countRows(versionId: string): Promise<number> {
  const rows = await sql<{ n: number }[]>`
    select count(*)::int as n from public.agreement_participants where version_id = ${versionId}::uuid`;
  return rows[0]!.n;
}

// ─── 준비 ─────────────────────────────────────────────────────────────────────

beforeAll(async () => {
  sql = connectDirectDb();
  user = await createTestUser(sql);
  session.accessToken = user.accessToken;

  const project = await projectsRepo.createProjectWithDefaults(user.client, {
    name: '참여인원 액션 테스트 과제',
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
  m1Id = (await newMember(projectId, 'M1', 60_000_000)).id;
  m2Id = (await newMember(projectId, 'M2', 50_000_000)).id;
  mNoSalaryId = (await newMember(projectId, '연봉 미입력', null)).id;

  const other = await projectsRepo.createProjectWithDefaults(user.client, {
    name: '참여인원 액션 남의 과제',
    contractStartDate: '2026-01-01',
  });
  tempProjectIds.push(other.id);
  const otherYear = (await yearsRepo.listYears(user.client, other.id))[0];
  if (!otherYear) throw new Error('남의 과제에 연차가 없습니다.');
  otherYearId = otherYear.id;
  otherMemberId = (await newMember(other.id, '남의 인력', 70_000_000)).id;

  // 확정 버전(참여인원 1행) → 그 뒤 작성 중 버전. 작성 중은 과제당 하나라(AV-2) 이 순서로만 둘 다 가질 수 있다
  confirmedVersionId = (
    await agreementsRepo.createVersion(user.client, projectId, {
      kind: 'selection',
      name: '선정평가본',
      lines: [],
      participants: [
        {
          memberId: m1Id,
          yearId: year1Id,
          participationRate: 50,
          months: 12,
          annualSalary: 60_000_000,
          personnelCash: 30_000_000,
          personnelInKind: 0,
          role: '책임',
        },
      ],
    })
  ).versionId;
  const confirmedRows = await agreementsRepo.listParticipantsByVersionIds(user.client, [confirmedVersionId]);
  confirmedRowId = confirmedRows[0]!.id;
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
    // 버전을 먼저 지운다 — 연차·인력 FK가 no action이라(H-5a·H-9b) 과제 cascade가 막힌다(delete_project와 같은 순서)
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

// ─── 추가 (S-11) ──────────────────────────────────────────────────────────────

// 아래 편집 시나리오가 쓰는 행 id
let m1y1Id: string; // M1 Y1 50%·12 자동 현금 30,000,000
let m1y2Id: string; // M1 Y2 현금 32,000,000 수동(계산 30,000,000)
let m2y1Id: string; // M2 Y1 20%·12 현물 10,000,000 자동
let unassignedId: string; // 인력 미지정 Y2 30%·6 현금 5,000,000 연봉 모름
let unknownZeroId: string; // 인력 미지정 Y2 30%·6 금액 없음·연봉 모름

describe('참여인원 추가 (S-11)', () => {
  it('연봉·금액을 비우면 Member 연봉 스냅샷 + 계산값을 현금으로 (자동)', async () => {
    const saved = unwrap(
      await actions.addAgreementParticipant(draftVersionId, {
        memberId: m1Id,
        yearId: year1Id,
        participationRate: 50,
        months: 12,
        role: '  책임연구원  ',
      })
    );
    expect(saved.amountRule).toBe('recalculated');
    expect(saved.kind).toBe('auto');
    m1y1Id = saved.participant.id;
    expect(await mustRead(m1y1Id)).toMatchObject({
      memberId: m1Id,
      yearId: year1Id,
      annualSalary: 60_000_000,
      cash: 30_000_000,
      inKind: 0,
      role: '책임연구원',
    });
  });

  it('금액을 명시하면 수동 — 안 적은 축은 0', async () => {
    const saved = unwrap(
      await actions.addAgreementParticipant(draftVersionId, {
        memberId: m1Id,
        yearId: year2Id,
        participationRate: 50,
        months: 12,
        role: '책임연구원',
        personnelCash: 32_000_000,
      })
    );
    expect(saved.amountRule).toBe('explicit');
    expect(saved.kind).toBe('manual');
    m1y2Id = saved.participant.id;
    expect(await mustRead(m1y2Id)).toMatchObject({ annualSalary: 60_000_000, cash: 32_000_000, inKind: 0 });
  });

  it('현물에 계산값과 같은 금액을 적으면 구분은 자동(현물 축)', async () => {
    const saved = unwrap(
      await actions.addAgreementParticipant(draftVersionId, {
        memberId: m2Id,
        yearId: year1Id,
        participationRate: 20,
        months: 12,
        role: '연구원',
        personnelInKind: 10_000_000,
      })
    );
    expect(saved.kind).toBe('auto');
    m2y1Id = saved.participant.id;
    expect(await mustRead(m2y1Id)).toMatchObject({ annualSalary: 50_000_000, cash: 0, inKind: 10_000_000 });
  });

  it('인력 미지정 행 — member_id null, 연봉 모름(스냅샷 출처 없음)', async () => {
    const saved = unwrap(
      await actions.addAgreementParticipant(draftVersionId, {
        memberId: null,
        yearId: year2Id,
        participationRate: 30,
        months: 6,
        role: '',
        personnelCash: 5_000_000,
      })
    );
    expect(saved.kind).toBe('salary_unknown');
    unassignedId = saved.participant.id;
    expect(await mustRead(unassignedId)).toMatchObject({
      memberId: null,
      annualSalary: null,
      cash: 5_000_000,
      inKind: 0,
      participationRate: 30,
      months: 6,
    });

    const zero = unwrap(
      await actions.addAgreementParticipant(draftVersionId, {
        memberId: null,
        yearId: year2Id,
        participationRate: 30,
        months: 6,
        role: '',
      })
    );
    // 연봉 모름이면 계산값이 없다 — 0·0으로 두고 "연봉 모름"(0원 인건비가 아니다)
    expect(zero.amountRule).toBe('kept');
    expect(zero.kind).toBe('salary_unknown');
    unknownZeroId = zero.participant.id;
    expect(await mustRead(unknownZeroId)).toMatchObject({ annualSalary: null, cash: 0, inKind: 0 });
  });

  it('연봉 미입력 인력은 스냅샷이 null(연봉 모름)', async () => {
    const saved = unwrap(
      await actions.addAgreementParticipant(draftVersionId, {
        memberId: mNoSalaryId,
        yearId: year1Id,
        participationRate: 10,
        months: 12,
        role: '',
      })
    );
    expect(saved.kind).toBe('salary_unknown');
    expect(await mustRead(saved.participant.id)).toMatchObject({ annualSalary: null, cash: 0, inKind: 0 });
    unwrap(await actions.deleteAgreementParticipant(saved.participant.id));
  });

  it('연봉을 명시하면 Member 연봉 대신 그 값 — 부록 B.7 74,000,000·28%·9개월 → 15,540,000', async () => {
    const saved = unwrap(
      await actions.addAgreementParticipant(draftVersionId, {
        memberId: m2Id,
        yearId: year2Id,
        participationRate: 28,
        months: 9,
        role: '',
        annualSalary: 74_000_000,
      })
    );
    expect(saved.kind).toBe('auto');
    expect(await mustRead(saved.participant.id)).toMatchObject({
      annualSalary: 74_000_000,
      cash: 15_540_000,
      inKind: 0,
      participationRate: 28,
      months: 9,
    });

    const manual = unwrap(
      await actions.addAgreementParticipant(draftVersionId, {
        memberId: m2Id,
        yearId: year2Id,
        participationRate: 28,
        months: 9,
        role: '',
        annualSalary: 74_000_000,
        personnelCash: 15_540_001,
      })
    );
    expect(manual.kind).toBe('manual');
    unwrap(await actions.deleteAgreementParticipant(saved.participant.id));
    unwrap(await actions.deleteAgreementParticipant(manual.participant.id));
  });

  it('새 행(연봉 60,000,000·10%·12개월·금액 없음) → 현금 6,000,000', async () => {
    const saved = unwrap(
      await actions.addAgreementParticipant(draftVersionId, {
        memberId: null,
        yearId: year1Id,
        participationRate: 10,
        months: 12,
        role: '',
        annualSalary: 60_000_000,
      })
    );
    expect(await mustRead(saved.participant.id)).toMatchObject({ cash: 6_000_000, inKind: 0 });
    unwrap(await actions.deleteAgreementParticipant(saved.participant.id));
  });

  it('입력 검증: 범위 밖·정수 아닌 금액·긴 역할·빈 인력 id는 VALIDATION, 행이 생기지 않는다', async () => {
    const before = await countRows(draftVersionId);
    const base = { memberId: m1Id, yearId: year1Id, participationRate: 50, months: 12, role: '' };
    expectCode(await actions.addAgreementParticipant('not-a-uuid', base), 'VALIDATION');
    expectCode(await actions.addAgreementParticipant(draftVersionId, { ...base, participationRate: 100.5 }), 'VALIDATION');
    expectCode(await actions.addAgreementParticipant(draftVersionId, { ...base, participationRate: -1 }), 'VALIDATION');
    expectCode(await actions.addAgreementParticipant(draftVersionId, { ...base, months: 13 }), 'VALIDATION');
    expectCode(await actions.addAgreementParticipant(draftVersionId, { ...base, personnelCash: -1 }), 'VALIDATION');
    expectCode(await actions.addAgreementParticipant(draftVersionId, { ...base, personnelInKind: 1.5 }), 'VALIDATION');
    expectCode(await actions.addAgreementParticipant(draftVersionId, { ...base, annualSalary: 0.5 }), 'VALIDATION');
    expectCode(await actions.addAgreementParticipant(draftVersionId, { ...base, role: 'x'.repeat(101) }), 'VALIDATION');
    expectCode(await actions.addAgreementParticipant(draftVersionId, { ...base, memberId: '' }), 'VALIDATION');
    expectCode(await actions.addAgreementParticipant(draftVersionId, { ...base, participationRate: '50' }), 'VALIDATION');
    // 경계값은 통과한다
    const edge = unwrap(
      await actions.addAgreementParticipant(draftVersionId, {
        ...base,
        participationRate: 100,
        months: 0,
        role: 'x'.repeat(100),
      })
    );
    expect(await countRows(draftVersionId)).toBe(before + 1);
    unwrap(await actions.deleteAgreementParticipant(edge.participant.id));
    expect(await countRows(draftVersionId)).toBe(before);
  });
});

// ─── 과제 경계 (액션 선검사 + 트리거) ──────────────────────────────────────────

describe('과제 경계 — 다른 과제의 인력·연차는 RULE', () => {
  it('추가: 다른 과제 연차·인력은 RULE, 행이 생기지 않는다', async () => {
    const before = await countRows(draftVersionId);
    const base = { memberId: m1Id, yearId: year1Id, participationRate: 10, months: 12, role: '' };
    expect(
      expectCode(await actions.addAgreementParticipant(draftVersionId, { ...base, yearId: otherYearId }), 'RULE')
    ).toContain('연차');
    expect(
      expectCode(await actions.addAgreementParticipant(draftVersionId, { ...base, memberId: otherMemberId }), 'RULE')
    ).toContain('인력');
    expect(await countRows(draftVersionId)).toBe(before);
  });

  it('수정: 다른 과제 연차·인력으로 옮기기는 RULE, 행은 그대로', async () => {
    const row = await mustRead(m1y1Id);
    expectCode(await actions.updateAgreementParticipant(m1y1Id, { yearId: otherYearId }, row.version), 'RULE');
    expectCode(await actions.updateAgreementParticipant(m1y1Id, { memberId: otherMemberId }, row.version), 'RULE');
    expect(await mustRead(m1y1Id)).toEqual(row);
  });

  it('트리거가 최후 방어선 — 리포지토리로 직접 써도 RuleViolationError', async () => {
    await expect(
      agreementsRepo.insertParticipant(user.client, {
        versionId: draftVersionId,
        memberId: otherMemberId,
        yearId: year1Id,
        participationRate: 10,
        months: 12,
        annualSalary: null,
        personnelCash: 0,
        personnelInKind: 0,
        role: '',
      })
    ).rejects.toBeInstanceOf(RuleViolationError);
    const row = await mustRead(m1y1Id);
    await expect(
      agreementsRepo.updateParticipant(user.client, m1y1Id, { yearId: otherYearId }, row.version)
    ).rejects.toBeInstanceOf(RuleViolationError);
    expect(await mustRead(m1y1Id)).toEqual(row);
  });
});

// ─── 수정 (G-3/Q4b) ───────────────────────────────────────────────────────────

describe('참여인원 수정 — 직전 구분대로 재계산/유지 (G-3/Q4b)', () => {
  it('자동 행 참여율 50 → 60%: 현금 36,000,000으로 재계산', async () => {
    const row = await mustRead(m1y1Id);
    const saved = unwrap(await actions.updateAgreementParticipant(m1y1Id, { participationRate: 60 }, row.version));
    expect(saved.amountRule).toBe('recalculated');
    expect(saved.kind).toBe('auto');
    expect(await mustRead(m1y1Id)).toMatchObject({
      participationRate: 60,
      cash: 36_000_000,
      inKind: 0,
      version: row.version + 1,
    });
  });

  it('수동 행 개월 12 → 10: 금액 32,000,000 유지', async () => {
    const row = await mustRead(m1y2Id);
    const saved = unwrap(await actions.updateAgreementParticipant(m1y2Id, { months: 10 }, row.version));
    expect(saved.amountRule).toBe('kept');
    expect(saved.kind).toBe('manual');
    expect(await mustRead(m1y2Id)).toMatchObject({ months: 10, cash: 32_000_000, inKind: 0 });
  });

  it('현물 자동 행 참여율 20 → 25%: 현물 축 그대로 12,500,000', async () => {
    const row = await mustRead(m2y1Id);
    unwrap(await actions.updateAgreementParticipant(m2y1Id, { participationRate: 25 }, row.version));
    expect(await mustRead(m2y1Id)).toMatchObject({ participationRate: 25, cash: 0, inKind: 12_500_000 });
  });

  it('연봉 모름·금액 0 행에 연봉 40,000,000: 40M×30%×6/12 = 6,000,000 재계산', async () => {
    const row = await mustRead(unknownZeroId);
    const saved = unwrap(
      await actions.updateAgreementParticipant(unknownZeroId, { annualSalary: 40_000_000 }, row.version)
    );
    expect(saved.amountRule).toBe('recalculated');
    expect(saved.kind).toBe('auto');
    expect(await mustRead(unknownZeroId)).toMatchObject({ annualSalary: 40_000_000, cash: 6_000_000, inKind: 0 });
  });

  it('연봉 모름·금액 있는 행(인력 미지정)에 연봉을 넣어도 손으로 넣은 금액은 유지', async () => {
    const row = await mustRead(unassignedId);
    const saved = unwrap(
      await actions.updateAgreementParticipant(unassignedId, { annualSalary: 40_000_000 }, row.version)
    );
    expect(saved.amountRule).toBe('kept');
    expect(await mustRead(unassignedId)).toMatchObject({ memberId: null, annualSalary: 40_000_000, cash: 5_000_000 });
  });

  it('금액 7,000,000 명시 → 수동, 그 뒤 참여율만 바꾸면 유지', async () => {
    let row = await mustRead(m1y1Id);
    const explicit = unwrap(
      await actions.updateAgreementParticipant(m1y1Id, { personnelCash: 7_000_000 }, row.version)
    );
    expect(explicit.amountRule).toBe('explicit');
    expect(explicit.kind).toBe('manual');
    expect(await mustRead(m1y1Id)).toMatchObject({ cash: 7_000_000, inKind: 0 });

    row = await mustRead(m1y1Id);
    unwrap(await actions.updateAgreementParticipant(m1y1Id, { participationRate: 70 }, row.version));
    expect(await mustRead(m1y1Id)).toMatchObject({ participationRate: 70, cash: 7_000_000 });
  });

  it('인력을 같은 과제의 다른 인력·미지정으로 바꿀 수 있다 — 연봉 스냅샷은 명시해야 바뀐다', async () => {
    let row = await mustRead(m2y1Id);
    unwrap(await actions.updateAgreementParticipant(m2y1Id, { memberId: m1Id }, row.version));
    expect(await mustRead(m2y1Id)).toMatchObject({ memberId: m1Id, annualSalary: 50_000_000 });
    row = await mustRead(m2y1Id);
    unwrap(await actions.updateAgreementParticipant(m2y1Id, { memberId: null }, row.version));
    expect(await mustRead(m2y1Id)).toMatchObject({ memberId: null });
  });

  it('O-1: 낡은 expectedVersion은 STALE, DB는 그대로', async () => {
    const row = await mustRead(m1y2Id);
    const err = expectCode(
      await actions.updateAgreementParticipant(m1y2Id, { months: 11 }, row.version - 1),
      'STALE'
    );
    expect(err).toContain('먼저 수정했습니다');
    expect(await mustRead(m1y2Id)).toEqual(row);
  });

  it('입력 검증: 빈 patch·범위 밖·잘못된 id는 VALIDATION', async () => {
    const row = await mustRead(m1y2Id);
    expectCode(await actions.updateAgreementParticipant(m1y2Id, {}, row.version), 'VALIDATION');
    expectCode(await actions.updateAgreementParticipant(m1y2Id, { months: 12.5 }, row.version), 'VALIDATION');
    expectCode(await actions.updateAgreementParticipant(m1y2Id, { personnelCash: -5 }, row.version), 'VALIDATION');
    expectCode(await actions.updateAgreementParticipant(m1y2Id, { months: 11 }, -1), 'VALIDATION');
    expectCode(await actions.updateAgreementParticipant('nope', { months: 11 }, row.version), 'VALIDATION');
    expect(await mustRead(m1y2Id)).toEqual(row);
  });
});

// ─── 확정 버전 (AV-2) ─────────────────────────────────────────────────────────

describe('확정 버전은 추가·수정·삭제 모두 RULE — 데이터 불변', () => {
  it('추가·수정·삭제 거부, 행은 그대로', async () => {
    const row = await mustRead(confirmedRowId);
    expectCode(
      await actions.addAgreementParticipant(confirmedVersionId, {
        memberId: m1Id,
        yearId: year1Id,
        participationRate: 10,
        months: 12,
        role: '',
      }),
      'RULE'
    );
    expect(
      expectCode(await actions.updateAgreementParticipant(confirmedRowId, { participationRate: 60 }, row.version), 'RULE')
    ).toContain('확정');
    expectCode(await actions.deleteAgreementParticipant(confirmedRowId), 'RULE');
    expect(await countRows(confirmedVersionId)).toBe(1);
    expect(await mustRead(confirmedRowId)).toEqual(row);
  });
});

// ─── 삭제 ─────────────────────────────────────────────────────────────────────

describe('참여인원 삭제', () => {
  it('작성 중 버전의 행을 지우고, 다시 지우면 찾을 수 없음', async () => {
    const before = await countRows(draftVersionId);
    unwrap(await actions.deleteAgreementParticipant(m1y2Id));
    expect(await readRow(m1y2Id)).toBeUndefined();
    expect(await countRows(draftVersionId)).toBe(before - 1);
    const err = expectCode(await actions.deleteAgreementParticipant(m1y2Id), undefined);
    expect(err).toContain('찾을 수 없습니다');
    expectCode(await actions.deleteAgreementParticipant('nope'), 'VALIDATION');
  });
});

// ─── SA-4 ─────────────────────────────────────────────────────────────────────

describe('SA-4: DB 내부 메시지를 사용자에게 노출하지 않는다', () => {
  it('리포지토리의 매핑 안 된 에러는 일반 문구로 — 테이블·제약 이름이 없다', async () => {
    const before = await countRows(draftVersionId);
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    fault.insert = true;
    try {
      const result = await actions.addAgreementParticipant(draftVersionId, {
        memberId: m1Id,
        yearId: year1Id,
        participationRate: 10,
        months: 12,
        role: '',
      });
      const err = expectCode(result, undefined);
      expect(err).toBe('요청 처리 중 오류가 발생했습니다.');
      expect(err).not.toMatch(/agreement_participants|fkey|23503/);
    } finally {
      fault.insert = false;
      spy.mockRestore();
    }
    expect(await countRows(draftVersionId)).toBe(before);
  });
});
