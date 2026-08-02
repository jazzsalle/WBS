// WBS 조회 모델 통합 테스트 — getYearTree / getProjectFullTree / getProjectsSummary
// SOT §9(조회 목록), §6.1 진척률 4단계 롤업, §6.7 WBS 코드, §6.9 우선순위, 부록 B.1
//
// 기대값은 부록 B.1의 검증 예시 그대로다 (시드 supabase/seed.sql이 그 구조다):
//   모델 개발 58 / 2차년도 38.666… / 1단계·과제 59.111…
// 서버 액션은 쿠키 세션(requireApprovedUser)에서 토큰을 읽으므로 next/headers를
// "실제 세션 토큰을 돌려주는 스텁"으로 바꿔 액션을 가드까지 포함해 그대로 호출한다.
// 조회 액션은 revalidatePath를 부르지 않지만 모듈이 next/cache를 import하므로 함께 스텁한다.

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Sql } from 'postgres';
import {
  applySeed,
  connectDirectDb,
  createTestUser,
  destroyTestUser,
  removeSeed,
  SEED,
  type TestUser,
} from './helpers';
import type { ActionResult } from '@/types';

const session = vi.hoisted(() => ({ accessToken: '' }));

vi.mock('next/headers', () => ({
  cookies: async () => ({ get: () => ({ value: session.accessToken }) }),
}));
vi.mock('next/cache', () => ({ revalidatePath: () => undefined }));

const { getProjectFullTree, getYearTree } = await import('@/actions/tasks');
const { getProjectsSummary } = await import('@/actions/projects');

let sql: Sql;
let user: TestUser;
let originalBasis: 'budget' | 'equal';

// 실패를 조용히 넘기지 않는다 — 실패 코드까지 메시지에 담아 원인을 드러낸다
function unwrap<T>(result: ActionResult<T>): T {
  if (!result.ok) {
    throw new Error(`액션 실패: ${result.error} (code=${result.code ?? '-'})`);
  }
  return result.data;
}

async function setWeightBasis(basis: 'budget' | 'equal'): Promise<void> {
  await sql`update public.app_settings set progress_weight_basis = ${basis} where id = true`;
}

beforeAll(async () => {
  sql = connectDirectDb();
  await applySeed(sql);
  user = await createTestUser(sql);
  session.accessToken = user.accessToken;

  // §6.1 ③④ 가중 기준은 팀 공유 설정이다. 다른 테스트가 바꿔 뒀을 수 있으므로
  // 'budget'을 명시하고 종료 시 원래 값으로 되돌린다 (dev DB 원복).
  const rows = await sql<{ progress_weight_basis: 'budget' | 'equal' }[]>`
    select progress_weight_basis from public.app_settings where id = true`;
  const current = rows[0];
  if (!current) throw new Error('app_settings 행이 없습니다. 마이그레이션 적용 여부를 확인하세요.');
  originalBasis = current.progress_weight_basis;
  await setWeightBasis('budget');
});

afterAll(async () => {
  await setWeightBasis(originalBasis);
  await removeSeed(sql);
  await destroyTestUser(sql, user);
  await sql.end();
});

describe('getYearTree (§6.1 ①②, §6.7)', () => {
  it('부록 B.1: 모델 개발 58, 2차년도 38.666…', async () => {
    const tree = unwrap(await getYearTree(SEED.year2Id));

    expect(tree.year.id).toBe(SEED.year2Id);
    expect(tree.invalidTaskIds).toEqual([]); // 트리에 편입되지 못한 Task가 없어야 한다

    const model = tree.nodes.find((n) => n.task.id === SEED.taskIds.model);
    if (!model) throw new Error("루트 '모델 개발'이 트리에 없습니다.");
    expect(model.progress).toBe(58); // (100×40 + 30×60) / 100
    expect(model.isLeaf).toBe(false);

    const integration = tree.nodes.find((n) => n.task.id === SEED.taskIds.integration);
    expect(integration?.progress).toBe(0);

    // ② 루트 가중 평균 = (58×100 + 0×50) / 150
    expect(tree.yearProgress).toBeCloseTo(38.6666667, 6);
  });

  it('WBS 코드는 연차 단위로 1부터 매겨진다 (§6.7)', async () => {
    const tree = unwrap(await getYearTree(SEED.year2Id));

    expect(tree.nodes.map((n) => n.wbsCode)).toEqual(['1', '2']);
    const model = tree.nodes[0];
    if (!model) throw new Error('2차년도 루트가 비어 있습니다.');
    expect(model.children.map((c) => c.wbsCode)).toEqual(['1.1', '1.2']);
    expect(model.children.map((c) => c.progress)).toEqual([100, 30]);
    expect(model.depth).toBe(1);
    expect(model.children[0]?.depth).toBe(2);
  });

  it('1차년도는 done 리프 롤업으로 100이다 (P-1)', async () => {
    const tree = unwrap(await getYearTree(SEED.year1Id));

    const requirements = tree.nodes.find((n) => n.task.id === SEED.taskIds.requirements);
    expect(requirements?.progress).toBe(100);
    expect(tree.yearProgress).toBe(100);
  });

  it('긴급도·우선순위 점수를 함께 계산해 돌려준다 (§6.9, PR-7)', async () => {
    const tree = unwrap(await getYearTree(SEED.year1Id));
    const requirements = tree.nodes.find((n) => n.task.id === SEED.taskIds.requirements);
    if (!requirements) throw new Error("루트 '요구사항 분석'이 트리에 없습니다.");

    // status='done' → 긴급도 1, 중요도 기본 3 → 점수 3
    expect(requirements.urgency).toBe(1);
    expect(requirements.priorityScore).toBe(3);

    const model = unwrap(await getYearTree(SEED.year2Id)).nodes.find(
      (n) => n.task.id === SEED.taskIds.model
    );
    // 마감일이 없으면 긴급도 2 → 3 × 2 = 6
    expect(model?.urgency).toBe(2);
    expect(model?.priorityScore).toBe(6);
  });
});

describe('getProjectFullTree (§6.1 ③④, §6.7)', () => {
  it('부록 B.1: 1단계 59.111…, 과제 59.111… (budget 가중)', async () => {
    const full = unwrap(await getProjectFullTree(SEED.projectId));

    expect(full.project.id).toBe(SEED.projectId);
    expect(full.stages.map((s) => s.id)).toEqual([SEED.stageId]);
    expect(full.years.map((y) => y.year.id)).toEqual([SEED.year1Id, SEED.year2Id]);
    expect(full.invalidTaskIds).toEqual([]);

    expect(full.years[0]?.yearProgress).toBe(100);
    expect(full.years[1]?.yearProgress).toBeCloseTo(38.6666667, 6);

    // (100×200,000,000 + 38.666…×400,000,000) / 600,000,000
    expect(full.stageProgress[SEED.stageId]).toBeCloseTo(59.1111111, 6);
    expect(full.projectProgress).toBeCloseTo(59.1111111, 6);
  });

  it('여러 연차가 섞이므로 WBS 코드에 연차 접두가 붙는다 (§6.7)', async () => {
    const full = unwrap(await getProjectFullTree(SEED.projectId));

    expect(full.years[0]?.nodes.map((n) => n.wbsCode)).toEqual(['1차-1']);
    expect(full.years[1]?.nodes.map((n) => n.wbsCode)).toEqual(['2차-1', '2차-2']);
    expect(full.years[1]?.nodes[0]?.children.map((c) => c.wbsCode)).toEqual(['2차-1.1', '2차-1.2']);
  });

  it("progressWeightBasis='equal'이면 균등 가중으로 계산한다 (§6.1 ③)", async () => {
    await setWeightBasis('equal');
    try {
      const full = unwrap(await getProjectFullTree(SEED.projectId));
      // (100 + 38.666…) / 2 — 예산 비중을 무시한 값
      expect(full.stageProgress[SEED.stageId]).toBeCloseTo(69.3333333, 6);
      expect(full.projectProgress).toBeCloseTo(69.3333333, 6);
    } finally {
      await setWeightBasis('budget');
    }
  });
});

describe('getProjectsSummary (§7.15)', () => {
  it('현재 연차(active)와 과제 진척률을 함께 돌려준다', async () => {
    const summaries = unwrap(await getProjectsSummary());
    const seeded = summaries.find((s) => s.project.id === SEED.projectId);
    if (!seeded) throw new Error('시드 과제가 요약 목록에 없습니다.');

    expect(seeded.currentYear?.id).toBe(SEED.year2Id); // 시드의 status='active' 연차
    expect(seeded.progress).toBeCloseTo(59.1111111, 6);
    expect(seeded.invalidTaskCount).toBe(0);
  });
});
