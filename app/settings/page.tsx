// 설정 페이지 (SOT §7.14)
// §7.14의 3개 섹션 중 "사용자 관리"와 "백업·복원"을 구현한다.
// 팀 설정(§5.16) 섹션과 임포트 스냅샷(I-17) 목록은 각각 Phase 8·Phase 5.5가 채운다.
// 데이터 로딩은 서버에서: 가드(lib/auth) → app_users 리포지토리(lib/db) 경유 —
// supabase를 직접 호출하지 않는다. 백업·복원은 로컬 파일을 다뤄야 하므로
// 클라이언트 컴포넌트(BackupPanel)가 actions/backup 경유로 처리한다.

import { redirect } from 'next/navigation';
import Link from 'next/link';
import { requireApprovedUser } from '@/lib/auth/guard';
import * as appUsers from '@/lib/db/app-users';
import UserManagement from '@/components/settings/UserManagement';
import BackupPanel from '@/components/settings/BackupPanel';

export default async function SettingsPage() {
  let ctx: Awaited<ReturnType<typeof requireApprovedUser>>;
  try {
    ctx = await requireApprovedUser();
  } catch {
    // 미들웨어가 이미 거르지만, 세션 만료 직후 직접 접근을 방어한다 (A-4)
    redirect('/login');
  }

  // RLS-2: 승인 사용자는 전체 행이 보인다. 대기자 상단 배치는 UserManagement가 한다.
  const users = await appUsers.listAppUsers(ctx.client);

  return (
    <main className="mx-auto max-w-3xl p-8">
      <div className="mb-6 flex items-center justify-between">
        <h1 className="text-2xl font-bold">설정</h1>
        <Link href="/" className="text-sm text-slate-500 underline hover:text-slate-700">
          홈으로
        </Link>
      </div>

      <UserManagement users={users} currentUserId={ctx.user.id} />

      <BackupPanel />

      <p className="mt-8 text-sm text-slate-400">
        팀 설정 섹션은 이후 Phase에서 추가된다 (SOT §7.14).
      </p>
    </main>
  );
}
