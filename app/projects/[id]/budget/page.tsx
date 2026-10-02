// 연구비 화면 (SOT §7.9, §7.1)
// 데이터 로딩은 서버에서만 한다. 집계(예산·현금/현물·잠금·규칙 판정)는 전부
// getBudgetPlanData(→ lib/budget-plan.ts §6.10)가 계산해 내려준 값이며, 화면은 그 값을 표시만 한다.
// 실패는 조용히 삼키지 않고 ErrorBanner로 code별 안내를 띄운다 (§9, 절대 규칙 5).

import { redirect } from 'next/navigation';
import { getCurrentUser } from '@/actions/auth';
import { getBudgetPlanData } from '@/actions/budget-plan';
import { getAgreementData } from '@/actions/agreement';
import { listImportProfiles } from '@/actions/import';
import { requireApprovedUser } from '@/lib/auth/guard';
import * as projectsRepo from '@/lib/db/projects';
import { toActionFailure } from '@/lib/db/errors';
import type { ActionResult } from '@/types';
import ErrorBanner from '@/components/ui/ErrorBanner';
import RealtimeRefresher from '@/components/RealtimeRefresher';
import BudgetScreen from '@/components/budget/BudgetScreen';

// R-1 §8.5 구독표의 "연구비" 행. 전체 구독 금지.
// budget_details는 제안 모드(§7.9.2)가 읽는다 — 남이 산출근거를 고치면 셀 합계와 지침 검증이
// 함께 바뀌므로 구독하지 않으면 화면마다 다른 예산이 보인다 (마이그레이션의 publication에도 있다, R-7).
// years는 구독표에 없다 — 남이 연차 이름·예산을 바꿔도 이 화면은 즉시 다시 그려지지 않지만,
// 바꾼 쪽이 revalidatePath로 이 경로를 무효화하므로 다음 이동·새로고침에 반영된다.
// agreement_versions·agreement_lines는 수행 모드(§7.9.8)가 읽는다. 참여인원(Phase 25 화면 있음)·정부지원 현금
// (agreement_gov_support, 제안 years.gov_support_cash)·편성 항목은 구독하지 않는다 — 합계 4테이블이 화면당
// 상한이다(R-1, §8.5 구독표 Phase 25 결정). 내 저장은 각 화면이 onChanged/onSaved → router.refresh()로 다시
// 그리고, 남의 그 변경은 새로고침·재진입 때 보인다.
const REALTIME_TABLES = ['budget_items', 'budget_details', 'agreement_versions', 'agreement_lines'];

// 매트릭스는 연차 수만큼 열이 늘어난다 — 좁은 폭에 가두지 않는다
const CONTENT_CLASS = 'mx-auto max-w-7xl p-8';

/**
 * §7.9 정부지원 현금 행의 govBudget 정보 문구용. BudgetPlanData에 과제 필드가 없어 따로 읽는다.
 * 리포지토리 예외를 ActionResult로 바꿔 화면에 알린다 — 실패를 null(미입력)로 눙치지 않는다 (절대 규칙 5)
 */
async function loadGovBudget(projectId: string): Promise<ActionResult<number | null>> {
  try {
    const { client } = await requireApprovedUser();
    const project = await projectsRepo.getProjectById(client, projectId);
    return { ok: true, data: project.govBudget };
  } catch (e) {
    console.error('[budget/page] 협약 정보 조회 실패:', e);
    return toActionFailure(e);
  }
}

interface BudgetPageProps {
  params: Promise<{ id: string }>;
}

export default async function BudgetPage({ params }: BudgetPageProps) {
  const { id: projectId } = await params;

  const me = await getCurrentUser();
  // 미들웨어가 이미 거르지만, 세션 만료 직후 직접 접근을 방어한다 (A-4)
  if (!me.ok) redirect('/login');

  const [plan, profiles, agreement, govBudget] = await Promise.all([
    // §7.9 제안 모드 한 벌 (§6.10). 매트릭스·셀 잠금에 쓰는 budget_items 원본 행도 집계와 **함께**
    // 내린다 (BudgetPlanData.items) — 따로 읽으면 두 조회 사이의 저장이 둘을 다른 시점으로 갈라놓는다
    getBudgetPlanData(projectId),
    // §7.9.1 Step 1: 저장된 프로파일 목록. 실패해도 매트릭스는 보여야 하므로 화면을 막지 않고
    // 마법사 안에서 이유를 드러낸다 (절대 규칙 5 — 조용히 빈 목록으로 대체하지 않는다)
    listImportProfiles('budget_plan', projectId),
    // §7.9.8 수행 모드 한 벌. 제안과 별개 구조라, 실패해도 제안 모드는 막지 않고 수행 모드에만 오류를 보인다
    getAgreementData(projectId),
    // §7.9 정부지원 현금 행의 정보 문구에만 쓴다 — 실패해도 매트릭스는 막지 않고 그 행 위에 알린다
    loadGovBudget(projectId),
  ]);

  // 절대 규칙 5: 빈 매트릭스로 대체하면 예산이 0원인 것처럼 보이고, 그 화면에서 저장하면
  // 실제 계획액이 지워진다. 실패는 그대로 알린다.
  if (!plan.ok) {
    return (
      <main className={CONTENT_CLASS}>
        <ErrorBanner message={plan.error} code={plan.code} />
      </main>
    );
  }

  return (
    <main className={CONTENT_CLASS}>
      <RealtimeRefresher tables={REALTIME_TABLES} selfUserId={me.data.id} />

      {/* §12 P-R4: 인쇄 제목은 매트릭스의 인쇄 머리말(과제명 · 출력일)이 대신한다 */}
      <h1 className="mb-6 text-xl font-bold print:hidden">연구비</h1>

      <BudgetScreen
        plan={plan.data}
        importProfiles={profiles.ok ? profiles.data : []}
        importProfilesError={profiles.ok ? null : profiles.error}
        agreement={agreement.ok ? agreement.data : null}
        agreementError={agreement.ok ? null : agreement.error}
        govBudget={govBudget.ok ? govBudget.data : null}
        govBudgetError={govBudget.ok ? null : govBudget.error}
      />
    </main>
  );
}
