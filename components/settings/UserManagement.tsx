'use client';

// 설정 > 사용자 관리 (SOT §7.14, §14.2 A-5)
// 승인 대기자(active=false)는 상단에 뱃지 + [승인] 버튼 — 역할 구분이 없으므로
// 승인된 사용자 누구나 승인할 수 있다(A-5). 활성 사용자는 [비활성화] 가능하되
// 본인은 제외한다(자기 잠금 방지 — 최종 판정은 deactivate_user RPC).

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import type { ActionResult, AppUser } from '@/types';
import { approveUser, deactivateUser } from '@/actions/auth';

function formatDate(iso: string): string {
  return iso.slice(0, 10);
}

interface UserManagementProps {
  users: AppUser[];
  currentUserId: string;
}

export default function UserManagement({ users, currentUserId }: UserManagementProps) {
  const router = useRouter();
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [, startTransition] = useTransition();

  const pendingUsers = users.filter((u) => !u.active);
  const activeUsers = users.filter((u) => u.active);

  const run = (userId: string, action: (id: string) => Promise<ActionResult<null>>) => {
    setPendingId(userId);
    setError(null);
    void action(userId).then((res) => {
      setPendingId(null);
      if (!res.ok) {
        setError(res.error);
        return;
      }
      // revalidatePath('/settings')가 서버 데이터를 갱신했으므로 화면만 다시 가져온다
      startTransition(() => router.refresh());
    });
  };

  return (
    <section aria-labelledby="user-management-title">
      <h2 id="user-management-title" className="text-lg font-bold">
        사용자 관리
      </h2>

      {error && (
        <p
          role="alert"
          className="mt-3 rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-700"
        >
          {error}
        </p>
      )}

      {pendingUsers.length > 0 && (
        <div className="mt-4 rounded-xl border border-amber-200 bg-amber-50 p-4">
          <h3 className="flex items-center gap-2 text-sm font-semibold text-amber-800">
            승인 대기
            <span className="rounded-full bg-amber-200 px-2 py-0.5 text-xs font-bold text-amber-900">
              {pendingUsers.length}
            </span>
          </h3>
          <ul className="mt-2 divide-y divide-amber-200/60">
            {pendingUsers.map((user) => (
              <li key={user.id} className="flex items-center justify-between gap-4 py-2.5">
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium text-slate-900">{user.name}</p>
                  <p className="truncate text-xs text-slate-500">{user.email}</p>
                </div>
                <button
                  type="button"
                  onClick={() => run(user.id, approveUser)}
                  disabled={pendingId !== null}
                  className="shrink-0 rounded-lg bg-slate-900 px-3 py-1.5 text-xs font-semibold text-white transition hover:bg-slate-700 disabled:opacity-50"
                >
                  {pendingId === user.id ? '처리 중…' : '승인'}
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}

      <div className="mt-4 overflow-hidden rounded-xl border border-slate-200 bg-white">
        <table className="w-full text-left text-sm">
          <thead className="bg-slate-50 text-xs text-slate-500">
            <tr>
              <th className="px-4 py-2.5 font-medium">이름</th>
              <th className="px-4 py-2.5 font-medium">이메일</th>
              <th className="px-4 py-2.5 font-medium">마지막 접속</th>
              <th className="px-4 py-2.5 font-medium sr-only">동작</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {activeUsers.map((user) => (
              <tr key={user.id}>
                <td className="px-4 py-2.5 font-medium text-slate-900">
                  {user.name}
                  {user.id === currentUserId && (
                    <span className="ml-2 rounded-full bg-slate-100 px-2 py-0.5 text-xs text-slate-500">
                      나
                    </span>
                  )}
                </td>
                <td className="px-4 py-2.5 text-slate-600">{user.email}</td>
                <td className="px-4 py-2.5 text-slate-500">{formatDate(user.lastSeenAt)}</td>
                <td className="px-4 py-2.5 text-right">
                  {user.id !== currentUserId && (
                    <button
                      type="button"
                      onClick={() => run(user.id, deactivateUser)}
                      disabled={pendingId !== null}
                      className="rounded-lg border border-slate-300 px-3 py-1.5 text-xs font-semibold text-slate-600 transition hover:bg-slate-50 disabled:opacity-50"
                    >
                      {pendingId === user.id ? '처리 중…' : '비활성화'}
                    </button>
                  )}
                </td>
              </tr>
            ))}
            {activeUsers.length === 0 && (
              <tr>
                <td colSpan={4} className="px-4 py-6 text-center text-slate-400">
                  활성 사용자가 없습니다.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </section>
  );
}
