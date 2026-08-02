// 홈 — 대시보드 자리 표시 (SOT §7.2는 Phase 4에서 구현)
// 승인된 사용자만 미들웨어를 통과해 여기 도달한다. 최초 1회 온보딩 모달(§14.4 ③④)을
// 여기서 띄운다 — /login·/pending에는 떠서는 안 되므로 layout이 아닌 홈에 마운트한다.

import { redirect } from 'next/navigation';
import Link from 'next/link';
import { getCurrentUser } from '@/actions/auth';
import OnboardingModal from '@/components/auth/OnboardingModal';

export default async function DashboardPage() {
  const res = await getCurrentUser();
  // 미들웨어가 이미 거르지만, 세션 만료 직후 직접 접근을 방어한다 (A-4)
  if (!res.ok) redirect('/login');

  return (
    <main className="mx-auto max-w-3xl p-8">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold">대시보드</h1>
        <div className="flex items-center gap-4">
          <span className="text-sm text-slate-500">{res.data.name}</span>
          <Link
            href="/settings"
            className="text-sm text-slate-500 underline hover:text-slate-700"
          >
            설정
          </Link>
        </div>
      </div>
      <p className="mt-2 text-slate-500">
        지표 카드·과제 요약·임박 마일스톤은 Phase 4에서 구현된다 (SOT §7.2, §11).
      </p>

      <OnboardingModal defaultName={res.data.name} />
    </main>
  );
}
