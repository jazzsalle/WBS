// 제안 연차 정부지원 현금 — updateYear patch.govSupportCash 통합 테스트
// (SOT §5.5 govSupportCash, §9 updateYear, §8.4 O-1·O-3, Phase 25 계획 S-3·S-4·T13)
//
// 서버 액션은 쿠키 세션(requireApprovedUser)에서 토큰을 읽으므로 next/headers를 실제 세션 토큰
// 스텁으로 바꿔 가드까지 그대로 호출한다(budget-actions.test.ts와 같은 방식). revalidatePath는
// 요청 컨텍스트 밖이라 스텁하되, 호출된 경로를 모아 연구비 화면이 다시 그려지는지 본다.
//
// 검증의 핵심:
//  1. null(미입력)과 0원은 다른 값이다 — 저장된 원본을 직결 SQL로 본다(액션 반환만 믿지 않는다).
//  2. 음수·소수는 VALIDATION이고 서버가 보정해 저장하지 않는다.
//  3. 정부지원 현금은 제안 규칙 판정(§6.14 — budget_rules)의 입력이 아니다. RL-8·RL-9는 협약 정보
//     govBudget·ownBudget을 쓴다(사용자 결정 — 과제 유형 폐기). 값이 바뀌어도 판정은 그대로여야 한다.
//
// 자기가 만든 과제·사용자만 지운다 — 파괴적 테스트가 아니다.

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Sql } from 'postgres';
import { connectDirectDb, createTestUser, destroyTestUser, type TestUser } from './helpers';
import type { ActionResult } from '@/types';
import * as yearsRepo from '@/lib/db/years';

const session = vi.hoisted(() => ({ accessToken: '' }));
const revalidated = vi.hoisted(() => ({ paths: [] as string[] }));

vi.mock('next/headers', () => ({
  cookies: async () => ({ get: () => ({ value: session.accessToken }) }),
}));
vi.mock('next/cache', () => ({
  revalidatePath: (path: string) => {
    revalidated.paths.push(path);
  },
}));

const { createProject } = await import('@/actions/projects');
const { updateYear } = await import('@/actions/years');
const budget = await import('@/actions/budget');
const rules = await import('@/actions/budget-rules');
const plan = await import('@/actions/budget-plan');

let sql: Sql;
let user: TestUser;
const tempProjectIds: string[] = [];

let projectId: string;
let yearId: string;

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

// bigint는 postgres.js가 문자열로 주므로 text로 캐스팅해 정수로 되돌린다 (부동소수점 경유 금지)
async function readGovCash(id: string): Promise<{ cash: number | null; version: number }> {
  const rows = await sql`
    select gov_support_cash::text as cash, version::text as version
      from public.years where id = ${id}::uuid`;
  const row = rows[0] as { cash: string | null; version: string } | undefined;
  if (!row) throw new Error('연차 행을 찾을 수 없습니다.');
  return { cash: row.cash === null ? null : Number(row.cash), version: Number(row.version) };
}

async function currentVersion(): Promise<number> {
  return (await readGovCash(yearId)).version;
}

beforeAll(async () => {
  sql = connectDirectDb();
  user = await createTestUser(sql);
  session.accessToken = user.accessToken;

  const project = unwrap(
    await createProject({
      name: '정부지원 현금 테스트 과제',
      contractStartDate: '2026-01-01',
      totalBudget: 200_000_000,
      govBudget: 150_000_000,
      ownBudget: 50_000_000,
    })
  );
  projectId = project.id;
  tempProjectIds.push(projectId);

  const firstYear = (await yearsRepo.listYears(user.client, projectId))[0];
  if (!firstYear) throw new Error('createProject가 연차를 만들지 않았습니다.');
  yearId = firstYear.id;
});

afterAll(async () => {
  for (const id of tempProjectIds) {
    await sql`delete from public.projects where id = ${id}::uuid`;
  }
  let remaining = 0;
  for (const id of tempProjectIds) {
    const rows = await sql`
      select ((select count(*) from public.projects where id = ${id}::uuid)
            + (select count(*) from public.years where project_id = ${id}::uuid))::text as n`;
    remaining += Number((rows[0] as { n: string }).n);
  }
  if (remaining !== 0) {
    throw new Error(`테스트가 만든 데이터가 ${remaining}건 남았습니다.`);
  }
  await destroyTestUser(sql, user);
  await sql.end();
});

describe('updateYear patch.govSupportCash (§5.5, §9)', () => {
  it('새 연차는 미입력(null)으로 시작한다', async () => {
    expect((await readGovCash(yearId)).cash).toBeNull();
    const year = await yearsRepo.getYearById(user.client, yearId);
    expect(year.govSupportCash).toBeNull();
  });

  it('원 단위 정수를 저장하고 앱 타입으로 돌려준다', async () => {
    const updated = unwrap(
      await updateYear(yearId, { govSupportCash: 120_000_000 }, await currentVersion())
    );
    expect(updated.govSupportCash).toBe(120_000_000);
    expect((await readGovCash(yearId)).cash).toBe(120_000_000);
  });

  it('0원은 입력값으로 저장되고 null과 구분된다', async () => {
    unwrap(await updateYear(yearId, { govSupportCash: 0 }, await currentVersion()));
    expect((await readGovCash(yearId)).cash).toBe(0);
  });

  it('null을 보내면 미입력으로 되돌린다', async () => {
    unwrap(await updateYear(yearId, { govSupportCash: 5_000 }, await currentVersion()));
    const updated = unwrap(
      await updateYear(yearId, { govSupportCash: null }, await currentVersion())
    );
    expect(updated.govSupportCash).toBeNull();
    expect((await readGovCash(yearId)).cash).toBeNull();
  });

  it('음수·소수·문자열은 VALIDATION이고 저장값은 그대로다', async () => {
    unwrap(await updateYear(yearId, { govSupportCash: 7_000 }, await currentVersion()));
    const before = await readGovCash(yearId);

    expect(expectCode(await updateYear(yearId, { govSupportCash: -1 }), 'VALIDATION')).toContain(
      '0원 이상'
    );
    expect(
      expectCode(await updateYear(yearId, { govSupportCash: 1.5 }), 'VALIDATION')
    ).toContain('정수');
    expectCode(await updateYear(yearId, { govSupportCash: '100' }), 'VALIDATION');

    expect(await readGovCash(yearId)).toEqual(before);
  });

  it('옛 version으로 저장하면 STALE이고 값은 바뀌지 않는다 (O-1·O-3)', async () => {
    const stale = await currentVersion();
    unwrap(await updateYear(yearId, { govSupportCash: 8_000 }, stale));
    const after = await readGovCash(yearId);

    const message = expectCode(
      await updateYear(yearId, { govSupportCash: 9_000 }, stale),
      'STALE'
    );
    expect(message).toContain('먼저 수정했습니다');
    expect(await readGovCash(yearId)).toEqual(after);
  });

  it('성공하면 연구비 화면 경로도 다시 그린다', async () => {
    revalidated.paths.length = 0;
    unwrap(await updateYear(yearId, { govSupportCash: 10_000 }, await currentVersion()));
    expect(revalidated.paths).toContain(`/projects/${projectId}/budget`);
    expect(revalidated.paths).toContain(`/projects/${projectId}`);
    expect(revalidated.paths).toContain(`/projects/${projectId}/wbs`);
  });

  it('연차 정보 저장 폼처럼 다른 필드만 보내면 정부지원 현금은 건드리지 않는다', async () => {
    unwrap(await updateYear(yearId, { govSupportCash: 11_000 }, await currentVersion()));
    unwrap(await updateYear(yearId, { goal: '목표 갱신' }, await currentVersion()));
    expect((await readGovCash(yearId)).cash).toBe(11_000);
  });
});

describe('제안 규칙 판정은 정부지원 현금과 무관하다 (§6.14 RL-8·RL-9, S-4)', () => {
  it('govSupportCash를 바꿔도 ruleEvaluation·축 합계가 같다', async () => {
    // 현금·현물이 갈린 셀과 미분리 셀을 함께 둔다 — 판정 입력이 실제로 0이 아니게
    unwrap(await budget.updateBudgetPlan(yearId, 'personnel', 130_000_000, 110_000_000, 20_000_000));
    unwrap(await budget.updateBudgetPlan(yearId, 'material', 40_000_000, null, null));
    unwrap(
      await rules.upsertBudgetRule(projectId, 'gov_share_max', {
        enabled: true,
        value: 75,
        severity: 'error',
        source: '테스트 고시',
      })
    );
    unwrap(
      await rules.upsertBudgetRule(projectId, 'own_cash_min', {
        enabled: true,
        value: 10,
        severity: 'warn',
        source: '테스트 고시',
      })
    );

    unwrap(await updateYear(yearId, { govSupportCash: null }, await currentVersion()));
    const before = unwrap(await plan.getBudgetPlanData(projectId));

    unwrap(await updateYear(yearId, { govSupportCash: 200_000_000 }, await currentVersion()));
    const after = unwrap(await plan.getBudgetPlanData(projectId));

    expect(after.ruleEvaluation).toEqual(before.ruleEvaluation);
    expect(after.yearRules).toEqual(before.yearRules);
    expect(after.yearAxisSplits).toEqual(before.yearAxisSplits);
    // 판정이 비어 있어 같은 것이 아님을 확인한다 — RL-8 비율은 규칙 없이도 실린다
    expect(before.ruleEvaluation.ratios.gov_share_max.length).toBeGreaterThan(0);
    // 같은 스냅샷이 새 값을 싣는다 — 화면(YearGovSupportRow)이 years에서 읽는다
    expect(after.years.find((y) => y.id === yearId)?.govSupportCash).toBe(200_000_000);
  });
});
