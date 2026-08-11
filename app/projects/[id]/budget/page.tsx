// 연구비 화면 (SOT §7.9, §7.1)
// 데이터 로딩은 서버에서만 한다. 집계(예산·집행·집행률·잔액·B-1~B-3 판정)는 전부
// getBudgetMatrix(→ lib/budget.ts §6.4)가 계산해 내려준 값이며, 화면은 그 값을 표시만 한다.
// 실패는 조용히 삼키지 않고 ErrorBanner로 code별 안내를 띄운다 (§9, 절대 규칙 5).

import { redirect } from 'next/navigation';
import { getCurrentUser } from '@/actions/auth';
import { getBudgetMatrix } from '@/actions/budget';
import { getBudgetPlanData } from '@/actions/budget-plan';
import { listImportProfiles } from '@/actions/import';
import ErrorBanner from '@/components/ui/ErrorBanner';
import RealtimeRefresher from '@/components/RealtimeRefresher';
import BudgetScreen from '@/components/budget/BudgetScreen';

// R-1 §8.5 구독표의 "연구비" 행 그대로 3개. 전체 구독 금지.
// budget_details는 제안 모드(§7.9.2)가 읽는다 — 남이 산출근거를 고치면 셀 합계와 지침 검증이
// 함께 바뀌므로 구독하지 않으면 화면마다 다른 예산이 보인다 (마이그레이션의 publication에도 있다, R-7).
// years는 구독표에 없다 — 남이 연차 이름·예산을 바꿔도 이 화면은 즉시 다시 그려지지 않지만,
// 바꾼 쪽이 revalidatePath로 이 경로를 무효화하므로 다음 이동·새로고침에 반영된다.
const REALTIME_TABLES = ['budget_items', 'budget_executions', 'budget_details'];

// 매트릭스는 연차 수만큼 열이 늘어난다 — 좁은 폭에 가두지 않는다
const CONTENT_CLASS = 'mx-auto max-w-7xl p-8';

interface BudgetPageProps {
  params: Promise<{ id: string }>;
}

export default async function BudgetPage({ params }: BudgetPageProps) {
  const { id: projectId } = await params;

  const me = await getCurrentUser();
  // 미들웨어가 이미 거르지만, 세션 만료 직후 직접 접근을 방어한다 (A-4)
  if (!me.ok) redirect('/login');

  // 집행 패널·현금/현물 편집이 쓰는 budget_items 원본 행은 getBudgetMatrix가 집계와 **함께**
  // 내린다 (BudgetMatrixData.items). 여기서 따로 읽으면 두 조회 사이의 저장이 매트릭스와
  // 원본 행을 다른 시점으로 갈라놓는다
  const [matrix, plan, profiles] = await Promise.all([
    getBudgetMatrix(projectId),
    // §7.9 제안 모드 한 벌 (§6.10). 모드는 화면 로컬 상태라 서버가 어느 쪽인지 알 수 없으므로
    // 두 벌을 함께 내린다 — 토글이 왕복 없이 즉시 바뀌어야 "같은 표의 두 관점"이 성립한다.
    // 이 Promise.all은 **트랜잭션이 아니다.** 두 조회 사이의 저장이 둘을 다른 시점으로 갈라놓을
    // 수 있으므로, 화면은 모드별로 **한 벌만** 본다 (BudgetScreen 머리말 C5). 여기서 두 결과를
    // 합치지 않는 이유는 §9가 둘을 독립 항목으로 두었기 때문이다 — 제안 조회는
    // budget_details·members까지 읽어 성격이 다르고, 합치면 수행 모드가 그 비용을 늘 지고 다닌다
    getBudgetPlanData(projectId),
    // §7.9.1 Step 1: 저장된 프로파일 목록. 실패해도 매트릭스는 보여야 하므로 화면을 막지 않고
    // 마법사 안에서 이유를 드러낸다 (절대 규칙 5 — 조용히 빈 목록으로 대체하지 않는다)
    listImportProfiles('budget_plan', projectId),
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

  return (
    <main className={CONTENT_CLASS}>
      <RealtimeRefresher tables={REALTIME_TABLES} selfUserId={me.data.id} />

      {/* §12 P-R4: 인쇄 제목은 매트릭스의 인쇄 머리말(과제명 · 출력일)이 대신한다 */}
      <h1 className="mb-6 text-xl font-bold print:hidden">연구비</h1>

      <BudgetScreen
        data={matrix.data}
        importProfiles={profiles.ok ? profiles.data : []}
        importProfilesError={profiles.ok ? null : profiles.error}
        // 제안 조회가 실패해도 수행 모드(예산·집행)는 보여야 하므로 화면을 막지 않는다.
        // 대신 빈 계획으로 대체하지 않고 제안 모드에서 이유를 드러낸다 (절대 규칙 5)
        plan={plan.ok ? plan.data : null}
        planError={plan.ok ? null : { message: plan.error, code: plan.code }}
      />
    </main>
  );
}
