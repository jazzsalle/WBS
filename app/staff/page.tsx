// 조직원 화면 (SOT §7.18, §5.19)
// 데이터 로딩은 서버에서만 한다 — 액션(actions/staff.ts)만 호출하고 supabase는 직접 부르지 않는다.
// 현재 급여(SL-2 "오늘 기준")는 listStaff가 서버 달력으로 한 번 고른 값이다 — 화면이 오늘을 다시
// 만들지 않는다(§6.5). 퇴사자 표시는 searchParams(retired=1)로 서버가 다시 조회한다: 퇴사자를 항상
// 받아 두고 화면에서 감추면 목록이 "재직자만"이라는 기본 상태와 건수가 어긋난다.
// staff·staff_salaries는 Realtime publication에 없다(Phase 16 T1) — RealtimeRefresher를 두지 않는다.

import { redirect } from 'next/navigation';
import { requireApprovedUser } from '@/lib/auth/guard';
import { listStaff } from '@/actions/staff';
import ErrorBanner from '@/components/ui/ErrorBanner';
import StaffScreen from '@/components/staff/StaffScreen';

const CONTENT_CLASS = 'mx-auto max-w-6xl p-8';

interface StaffPageProps {
  searchParams: Promise<{ retired?: string | string[] }>;
}

export default async function StaffPage({ searchParams }: StaffPageProps) {
  try {
    await requireApprovedUser();
  } catch {
    // 미들웨어가 이미 거르지만, 세션 만료 직후 직접 접근을 방어한다 (A-4)
    redirect('/login');
  }

  const { retired } = await searchParams;
  const includeRetired = (Array.isArray(retired) ? retired[0] : retired) === '1';

  const staff = await listStaff(includeRetired);
  // 절대 규칙 5: 빈 목록으로 대체하면 조직원이 전부 지워진 것처럼 보인다. 실패는 그대로 알린다.
  if (!staff.ok) {
    return (
      <main className={CONTENT_CLASS}>
        <ErrorBanner message={staff.error} code={staff.code} />
      </main>
    );
  }

  return (
    <main className={CONTENT_CLASS}>
      <StaffScreen items={staff.data} includeRetired={includeRetired} />
    </main>
  );
}
