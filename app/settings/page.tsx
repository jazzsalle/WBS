// 설정 페이지 (SOT §7.14)
// §7.14의 3개 섹션을 그 순서대로 둔다: 팀 설정 → 사용자 관리(내 프로필 포함) → 백업·복원.
// 데이터 로딩은 서버에서: 가드(lib/auth) → 액션·리포지토리(lib/db) 경유 —
// supabase를 직접 호출하지 않는다. 백업·복원은 로컬 파일을 다뤄야 하므로
// 클라이언트 컴포넌트(BackupPanel)가 actions/backup 경유로 처리한다.

import { redirect } from 'next/navigation';
import Link from 'next/link';
import { requireApprovedUser } from '@/lib/auth/guard';
import * as appUsers from '@/lib/db/app-users';
import * as projectsRepo from '@/lib/db/projects';
import { getSettingsData } from '@/actions/settings';
import ErrorBanner from '@/components/ui/ErrorBanner';
import RealtimeRefresher from '@/components/RealtimeRefresher';
import SettingsForm from '@/components/settings/SettingsForm';
import MyProfileForm from '@/components/settings/MyProfileForm';
import UserManagement from '@/components/settings/UserManagement';
import BackupPanel from '@/components/settings/BackupPanel';
import ImportSnapshotPanel from '@/components/settings/ImportSnapshotPanel';

// R-1 §8.5 구독표의 "설정" 행 그대로. 전체 구독 금지.
const REALTIME_TABLES = ['app_users', 'app_settings'];

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
  const settings = await getSettingsData();
  // I-17 스냅샷은 과제별로 보관된다 — 패널의 과제 선택에 쓸 목록만 넘긴다(보관 과제도 포함:
  // 잘못된 반영은 과제를 보관한 뒤에 발견될 수 있다)
  const projects = await projectsRepo.listProjects(ctx.client);

  return (
    <main className="mx-auto max-w-3xl p-8">
      <RealtimeRefresher tables={REALTIME_TABLES} selfUserId={ctx.user.id} />

      <div className="mb-6 flex items-center justify-between">
        <h1 className="text-2xl font-bold">설정</h1>
        <Link href="/" className="text-sm text-slate-500 underline hover:text-slate-700">
          홈으로
        </Link>
      </div>

      {/* 설정 조회 실패는 감추지 않는다(절대 규칙 5). 백업·복원은 무료 플랜의 유일한 안전망이라
          이 실패로 함께 가리지 않고 아래에 그대로 남긴다. */}
      {settings.ok ? (
        <SettingsForm settings={settings.data.settings} />
      ) : (
        <ErrorBanner message={settings.error} code={settings.code} />
      )}

      <div className="mt-8">
        <UserManagement users={users} currentUserId={ctx.user.id} />
        {settings.ok && (
          <MyProfileForm me={ctx.user} memberOptions={settings.data.memberOptions} />
        )}
      </div>

      {/* §7.14 백업·복원 섹션: 전체 백업/복원(K-1~K-5) + 임포트 스냅샷(I-17) */}
      <BackupPanel />
      <ImportSnapshotPanel
        projects={projects.map((p) => ({ id: p.id, name: p.name, archived: p.archived }))}
      />
    </main>
  );
}
