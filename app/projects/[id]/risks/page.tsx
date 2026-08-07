// 리스크 관리대장 화면 (SOT §7.11, §7.1)
// 데이터 로딩은 서버에서만 한다 — 액션(actions/)만 호출하고 supabase는 직접 부르지 않는다.
// 점수·등급(§6.5)은 저장하지 않고 조회 시 lib/risk.ts가 계산한 값을 내려받는다.
// 실패는 조용히 삼키지 않고 ErrorBanner로 code별 안내를 띄운다 (§9).

import { redirect } from 'next/navigation';
import { getCurrentUser } from '@/actions/auth';
import { getRiskMatrix } from '@/actions/risks';
import ErrorBanner from '@/components/ui/ErrorBanner';
import RealtimeRefresher from '@/components/RealtimeRefresher';
import RiskScreen from '@/components/risks/RiskScreen';

// R-1 §8.5 구독표의 "리스크" 행 그대로 1개. 전체 구독 금지.
// years·members·tasks는 구독표에 없다 — 남이 연차·인력·작업 이름을 바꿔도 이 화면은 즉시
// 다시 그려지지 않지만, 바꾼 쪽이 revalidatePath로 이 경로를 무효화하므로 다음 이동·새로고침에 반영된다.
const REALTIME_TABLES = ['risks'];

// 목록 컬럼이 10개라 마일스톤 화면보다 넓은 폭을 쓴다 (§12 반응형)
const CONTENT_CLASS = 'mx-auto max-w-[1600px] p-8';

interface RisksPageProps {
  params: Promise<{ id: string }>;
}

export default async function RisksPage({ params }: RisksPageProps) {
  const { id: projectId } = await params;

  const me = await getCurrentUser();
  // 미들웨어가 이미 거르지만, 세션 만료 직후 직접 접근을 방어한다 (A-4)
  if (!me.ok) redirect('/login');

  const risks = await getRiskMatrix(projectId);
  // 절대 규칙 5: 빈 목록으로 대체하면 리스크가 사라진 것처럼 보이고 고위험 건수가 0으로 보인다.
  // 실패는 그대로 알린다.
  if (!risks.ok) {
    return (
      <main className={CONTENT_CLASS}>
        <ErrorBanner message={risks.error} code={risks.code} />
      </main>
    );
  }

  return (
    <main className={CONTENT_CLASS}>
      <RealtimeRefresher tables={REALTIME_TABLES} selfUserId={me.data.id} />

      {/* §12 P-R4: 인쇄 제목은 대장의 인쇄 머리말(과제명 · 출력일)이 대신한다 */}
      <h1 className="mb-6 text-xl font-bold print:hidden">리스크 관리대장</h1>

      <RiskScreen data={risks.data} />
    </main>
  );
}
