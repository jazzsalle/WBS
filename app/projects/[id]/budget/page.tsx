// 연구비 화면 (SOT §7.9, §7.1)
// 데이터 로딩은 서버에서만 한다. 집계(예산·집행·집행률·잔액·B-1~B-3 판정)는 전부
// getBudgetMatrix(→ lib/budget.ts §6.4)가 계산해 내려준 값이며, 화면은 그 값을 표시만 한다.
// 실패는 조용히 삼키지 않고 ErrorBanner로 code별 안내를 띄운다 (§9, 절대 규칙 5).

import { redirect } from 'next/navigation';
import { getCurrentUser } from '@/actions/auth';
import { getBudgetMatrix } from '@/actions/budget';
import type { ActionResult, BudgetItem } from '@/types';
import { requireApprovedUser } from '@/lib/auth/guard';
import * as budgetItemsRepo from '@/lib/db/budget-items';
import { toActionFailure } from '@/lib/db/errors';
import ErrorBanner from '@/components/ui/ErrorBanner';
import RealtimeRefresher from '@/components/RealtimeRefresher';
import BudgetScreen from '@/components/budget/BudgetScreen';

// R-1 §8.5 구독표의 "연구비" 행 그대로 2개. 전체 구독 금지.
// years는 구독표에 없다 — 남이 연차 이름·예산을 바꿔도 이 화면은 즉시 다시 그려지지 않지만,
// 바꾼 쪽이 revalidatePath로 이 경로를 무효화하므로 다음 이동·새로고침에 반영된다.
const REALTIME_TABLES = ['budget_items', 'budget_executions'];

// 매트릭스는 연차 수만큼 열이 늘어난다 — 좁은 폭에 가두지 않는다
const CONTENT_CLASS = 'mx-auto max-w-7xl p-8';

interface BudgetPageProps {
  params: Promise<{ id: string }>;
}

// 집행 내역 패널(§7.9 "셀 클릭 → 집행 내역 패널")과 현금/현물 분리 편집에는 집계가 아니라
// 원본 행이 필요하다: budget_items.id(집행 CRUD의 부모 키), version(O-1 낙관적 잠금),
// cashAmount/inKindAmount의 null 여부(총액 인라인 편집 허용 판정), executions 목록.
// getBudgetMatrix의 BudgetMatrixData는 집계만 담고 있어 이 네 가지를 얻을 수 없으므로
// 여기서 리포지토리를 한 번 더 읽는다 (supabase 직접 호출 금지 — 리포지토리 경유, 절대 규칙 3).
// ※ 원래 자리는 getBudgetMatrix다. 그쪽이 원본 행을 함께 내려주면 이 함수는 지우고
//    matrix.data에서 꺼내 쓰면 된다 (조회 왕복 1회 절약).
async function loadBudgetItems(projectId: string): Promise<ActionResult<BudgetItem[]>> {
  try {
    const { client } = await requireApprovedUser();
    return { ok: true, data: await budgetItemsRepo.listBudgetItemsByProject(client, projectId) };
  } catch (e) {
    return toActionFailure(e);
  }
}

export default async function BudgetPage({ params }: BudgetPageProps) {
  const { id: projectId } = await params;

  const me = await getCurrentUser();
  // 미들웨어가 이미 거르지만, 세션 만료 직후 직접 접근을 방어한다 (A-4)
  if (!me.ok) redirect('/login');

  const [matrix, items] = await Promise.all([
    getBudgetMatrix(projectId),
    loadBudgetItems(projectId),
  ]);

  // 절대 규칙 5: 빈 매트릭스로 대체하면 예산이 0원인 것처럼 보이고, 그 화면에서 저장하면
  // 실제 계획액이 지워진다. 실패는 그대로 알린다.
  if (!matrix.ok) {
    return (
      <main className={CONTENT_CLASS}>
        <ErrorBanner message={matrix.error} code={matrix.code} />
      </main>
    );
  }
  if (!items.ok) {
    return (
      <main className={CONTENT_CLASS}>
        <ErrorBanner message={items.error} code={items.code} />
      </main>
    );
  }

  return (
    <main className={CONTENT_CLASS}>
      <RealtimeRefresher tables={REALTIME_TABLES} selfUserId={me.data.id} />

      <h1 className="mb-6 text-xl font-bold">연구비</h1>

      <BudgetScreen data={matrix.data} items={items.data} />
    </main>
  );
}
