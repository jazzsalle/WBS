'use client';

// 따라하기 되돌리기 (SOT §7.14 "따라하기 다시 열기", §7.17 TU-1)
// 드로어의 [다시 보지 않기]는 LocalConfig.tutorial.dismissed만 바꾼다 — 그 값을 여기서 되돌린다.
// LocalConfig는 이 PC의 파일이라 서버가 모른다 — 마운트 후 읽는다(BackupPanel과 같은 패턴).
// DB에는 아무것도 쓰지 않는다(TU-6).

import { useEffect, useState } from 'react';
import Link from 'next/link';
import type { LocalConfig } from '@/types';
import { loadLocalConfig, updateLocalConfig } from '@/lib/local-config';
import Button from '@/components/ui/Button';

const toMessage = (e: unknown) => (e instanceof Error ? e.message : String(e));

export default function TutorialResetPanel() {
  const [config, setConfig] = useState<LocalConfig | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    loadLocalConfig()
      .then(setConfig)
      .catch((e) => setError(`로컬 설정을 읽지 못했습니다: ${toMessage(e)}`));
  }, []);

  const handleReopen = async () => {
    if (config === null) return;
    setBusy(true);
    setError(null);
    try {
      setConfig(await updateLocalConfig({ tutorial: { ...config.tutorial, dismissed: false } }));
    } catch (e) {
      setError(`설정을 저장하지 못했습니다: ${toMessage(e)}`);
    } finally {
      setBusy(false);
    }
  };

  const dismissed = config?.tutorial.dismissed ?? false;
  const sampleProjectId = config?.tutorial.sampleProjectId ?? null;

  return (
    <section className="mt-8 rounded-2xl border border-grey-200 bg-white p-6">
      <h2 className="text-t5 font-bold text-grey-900">따라하기</h2>
      <p className="mt-1 text-t7 text-grey-500">
        대시보드·과제 화면 오른쪽 아래의 [따라하기] 버튼. 이 PC에만 저장되는 설정입니다 (SOT §7.17).
      </p>

      {error && (
        <p role="alert" className="mt-4 rounded-lg border border-red-100 bg-red-50 p-3 text-t7 text-red-700">
          {error}
        </p>
      )}

      <dl className="mt-4 space-y-1 text-t7">
        <div className="flex gap-2">
          <dt className="w-28 shrink-0 font-medium text-grey-500">현재 상태</dt>
          <dd className={dismissed ? 'text-orange-600' : 'text-grey-700'}>
            {config === null
              ? '읽는 중…'
              : dismissed
                ? '따라하기 버튼이 숨겨져 있습니다 (작은 아이콘으로 표시)'
                : '표시 중'}
          </dd>
        </div>
        {sampleProjectId !== null && (
          <div className="flex gap-2">
            <dt className="w-28 shrink-0 font-medium text-grey-500">예제 과제</dt>
            <dd>
              <Link
                href={`/projects/${sampleProjectId}`}
                className="text-blue-600 underline underline-offset-2 hover:text-blue-800"
              >
                예제 과제 열기
              </Link>
              <span className="ml-2 text-grey-500">지우려면 과제 개요의 [과제 삭제]를 쓰세요</span>
            </dd>
          </div>
        )}
      </dl>

      <div className="mt-5">
        <Button variant="primary" onClick={handleReopen} disabled={config === null || busy || !dismissed}>
          {busy ? '저장 중…' : '따라하기 다시 열기'}
        </Button>
      </div>
    </section>
  );
}
