'use client';

// 로그인 후 최초 1회 온보딩 모달 (SOT §7.0, §14.4 ③·④)
// ③ 표시 이름 확인: 구글 프로필 이름(app_users.name) 기본값 → updateMyProfile 액션.
// ④ 백업 폴더 지정: Tauri 환경에서만 노출. 드라이브 동기화 폴더 권장(§14.4).
// "최초 1회" 판정과 백업 폴더는 LocalConfig 저장소(lib/local-config, §5.16)에 남는다 —
// Tauri는 app config dir 파일, 브라우저 개발 모드는 localStorage.

import { useEffect, useState } from 'react';
import { updateMyProfile } from '@/actions/auth';
import { completeOnboarding, loadOnboardingState } from '@/lib/local-config';
import { isTauri } from '@/lib/tauri/env';

export interface OnboardingConfig {
  completed: boolean;
  backupFolder: string | null;
}

// 테스트가 저장소를 대체 주입하는 지점. 기본 구현은 lib/local-config다.
export interface OnboardingConfigStore {
  load(): Promise<OnboardingConfig>;
  save(config: OnboardingConfig): Promise<void>;
}

const localConfigStore: OnboardingConfigStore = {
  load: () => loadOnboardingState(),
  // 모달은 완료 시점에만 저장한다 — completed=true 저장이 곧 "최초 1회" 종료 표식
  save: (config) => completeOnboarding(config.backupFolder),
};

interface OnboardingModalProps {
  /** 구글 프로필 기반 app_users.name — 표시 이름 기본값 */
  defaultName: string;
  /** 테스트 주입용. 기본은 LocalConfig 저장소 */
  store?: OnboardingConfigStore;
}

export default function OnboardingModal({
  defaultName,
  store = localConfigStore,
}: OnboardingModalProps) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState(defaultName);
  const [backupFolder, setBackupFolder] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // isTauri()는 window 의존 — SSR/hydration 불일치를 피해 마운트 후 판정한다
  const [showBackupField, setShowBackupField] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void store.load().then((config) => {
      if (cancelled || config.completed) return;
      setBackupFolder(config.backupFolder ?? '');
      setShowBackupField(isTauri());
      setOpen(true);
    });
    return () => {
      cancelled = true;
    };
  }, [store]);

  if (!open) return null;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);
    setError(null);
    try {
      const trimmed = name.trim();
      if (!trimmed) {
        setError('표시 이름을 입력하세요.');
        return;
      }
      const res = await updateMyProfile({ name: trimmed });
      if (!res.ok) {
        setError(res.error);
        return;
      }
      await store.save({
        completed: true,
        backupFolder: backupFolder.trim() || null,
      });
      setOpen(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-dimmed p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="onboarding-title"
    >
      <form
        onSubmit={handleSubmit}
        className="w-full max-w-md rounded-2xl bg-surface p-6 shadow-xl"
      >
        <h2 id="onboarding-title" className="text-lg font-bold">
          시작하기 전에
        </h2>
        <p className="mt-1 text-sm text-grey-500">
          팀원에게 보일 이름을 확인해 주세요.
        </p>

        {error && (
          <p
            role="alert"
            className="mt-4 rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-700"
          >
            {error}
          </p>
        )}

        <label className="mt-4 block">
          <span className="text-sm font-medium text-grey-700">표시 이름</span>
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            maxLength={100}
            className="mt-1 w-full rounded-lg border border-grey-300 px-3 py-2 text-sm focus:border-grey-500 focus:outline-none"
          />
        </label>

        {showBackupField && (
          <label className="mt-4 block">
            <span className="text-sm font-medium text-grey-700">백업 폴더</span>
            <input
              type="text"
              value={backupFolder}
              onChange={(e) => setBackupFolder(e.target.value)}
              placeholder="예: D:\백업\wbs (드라이브 동기화 폴더 권장)"
              className="mt-1 w-full rounded-lg border border-grey-300 px-3 py-2 text-sm focus:border-grey-500 focus:outline-none"
            />
            <span className="mt-1 block text-xs text-grey-500">
              자동 내보내기(§8.7) 저장 위치. 나중에 설정에서 바꿀 수 있습니다.
            </span>
          </label>
        )}

        <button
          type="submit"
          disabled={saving}
          className="mt-6 w-full rounded-lg bg-grey-900 px-4 py-2.5 text-sm font-semibold text-surface transition hover:bg-grey-700 disabled:opacity-50"
        >
          {saving ? '저장 중…' : '시작하기'}
        </button>
      </form>
    </div>
  );
}
