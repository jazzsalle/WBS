'use client';

// 설정 > 사용자 관리 > 내 프로필 (SOT §7.14, §9 updateMyProfile, §14.2)
// 표시 이름과 Member 연결만 고친다 — 이메일은 구글 계정에서 오는 값이라 편집 대상이 아니고,
// active(승인 상태)는 approve_user/deactivate_user RPC만 바꿀 수 있다.
// app_users에는 version 컬럼이 없고(§14.2 스키마) 본인 행만 고치므로 낙관적 잠금 대상이 아니다 —
// 같은 행을 동시에 고칠 수 있는 사람이 자기 자신뿐이라 O-1의 전제(다른 사람의 선행 저장)가 없다.

import { useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import type { AppUser } from '@/types';
import type { ActionErrorCode } from '@/lib/db/errors';
import type { MemberOption } from '@/actions/settings';
import { updateMyProfile } from '@/actions/auth';
import Button from '@/components/ui/Button';
import ErrorBanner from '@/components/ui/ErrorBanner';
import { setRealtimePaused } from '@/components/RealtimeRefresher';

const INPUT_CLASS =
  'mt-1 w-full rounded-lg border border-grey-300 px-3 py-2 text-sm focus:border-grey-500 focus:outline-none';

// 동명이인이 흔해 기관명을 앞에 붙인다 (§7.14). 기관 미지정 인력은 이름만 보여준다.
function optionLabel(option: MemberOption): string {
  const base = option.orgName ? `${option.orgName} · ${option.name}` : option.name;
  return option.active ? base : `${base} (참여 종료)`;
}

export interface MyProfileFormProps {
  me: AppUser;
  /** 전 과제 인력 — app_users.member_id는 과제에 매이지 않는 링크다 */
  memberOptions: MemberOption[];
}

export default function MyProfileForm({ me, memberOptions }: MyProfileFormProps) {
  const router = useRouter();
  const [name, setName] = useState(me.name);
  const [memberId, setMemberId] = useState(me.memberId ?? '');
  const [saving, setSaving] = useState(false);
  const [failure, setFailure] = useState<{ message: string; code?: ActionErrorCode } | null>(null);
  const [saved, setSaved] = useState(false);
  // 마지막으로 받아들인 서버 값. 다른 기기에서 내 프로필을 고쳤을 때의 비교 기준이다.
  const [baseline, setBaseline] = useState<AppUser>(me);

  const dirty = name !== baseline.name || memberId !== (baseline.memberId ?? '');

  // 서버가 내 프로필을 다시 내려줬을 때: 고친 값이 없으면 최신 값을 그대로 받아들이고,
  // 고쳤다면 입력을 지킨 채 기준만 갱신한다 (작업 내용을 날리지 않는다).
  useEffect(() => {
    if (me.name === baseline.name && (me.memberId ?? '') === (baseline.memberId ?? '')) return;
    setBaseline(me);
    if (!dirty) {
      setName(me.name);
      setMemberId(me.memberId ?? '');
    }
  }, [me, baseline, dirty]);

  // R-4: 고친 값이 있는 동안만 자동 새로고침을 보류한다 — 남의 승인 이벤트(app_users 구독)가
  // 입력 중인 이름을 지우지 않게. 항상 보류하면 이 화면이 영영 갱신되지 않는다.
  useEffect(() => {
    if (!dirty) return;
    setRealtimePaused(true);
    return () => setRealtimePaused(false);
  }, [dirty]);

  // 연결된 인력이 목록에 없으면(삭제·권한 변화) 선택 상자가 조용히 "연결 안 함"으로 떨어지고
  // 저장 시 연결이 사라진다. 사라지게 두지 않고 값을 유지한 채 상태를 드러낸다 (절대 규칙 5).
  const missingLink = useMemo(
    () => memberId !== '' && !memberOptions.some((o) => o.id === memberId),
    [memberId, memberOptions]
  );

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setFailure(null);
    setSaved(false);

    const trimmed = name.trim();
    if (trimmed === '') {
      setFailure({ message: '표시 이름을 입력하세요.', code: 'VALIDATION' });
      return;
    }

    setSaving(true);
    try {
      const res = await updateMyProfile({ name: trimmed, memberId: memberId === '' ? null : memberId });
      if (!res.ok) {
        setFailure({ message: res.error, code: res.code });
        return;
      }
      setBaseline(res.data);
      setName(res.data.name);
      setMemberId(res.data.memberId ?? '');
      setSaved(true);
      router.refresh(); // 사용자 목록의 내 이름도 함께 갱신된다
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="mt-6 rounded-xl border border-grey-200 bg-grey-50/60 p-4">
      <h3 className="text-sm font-bold text-grey-800">내 프로필</h3>

      <form onSubmit={handleSubmit} className="mt-3">
        {failure && (
          <ErrorBanner
            message={failure.message}
            code={failure.code}
            onDismiss={() => setFailure(null)}
            className="mb-4"
          />
        )}

        {saved && !dirty && (
          <p
            role="status"
            className="mb-4 rounded-lg border border-green-200 bg-green-50 p-3 text-sm text-green-800"
          >
            내 프로필을 저장했습니다.
          </p>
        )}

        <div className="grid gap-4 sm:grid-cols-2">
          <label>
            <span className="text-sm font-medium text-grey-700">표시 이름</span>
            <input
              type="text"
              value={name}
              onChange={(e) => {
                setName(e.target.value);
                setSaved(false);
              }}
              maxLength={100}
              required
              className={INPUT_CLASS}
            />
            <span className="mt-1 block text-xs text-grey-500">{me.email}</span>
          </label>

          <label>
            <span className="text-sm font-medium text-grey-700">참여인력 연결</span>
            <select
              value={memberId}
              onChange={(e) => {
                setMemberId(e.target.value);
                setSaved(false);
              }}
              className="mt-1 w-full rounded-lg border border-grey-300 bg-surface px-3 py-2 text-sm focus:border-grey-500 focus:outline-none"
            >
              <option value="">연결 안 함</option>
              {missingLink && (
                <option value={memberId}>(목록에 없는 인력 — 연결이 유지됩니다)</option>
              )}
              {memberOptions.map((option) => (
                <option key={option.id} value={option.id}>
                  {optionLabel(option)}
                </option>
              ))}
            </select>
            <span className="mt-1 block text-xs text-grey-500">
              담당자 배정·회의 참석자에서 나를 식별하는 데 쓰입니다.
            </span>
          </label>
        </div>

        <div className="mt-4 flex justify-end">
          <Button type="submit" size="sm" variant="primary" disabled={saving || !dirty}>
            {saving ? '저장 중…' : '프로필 저장'}
          </Button>
        </div>
      </form>
    </div>
  );
}
