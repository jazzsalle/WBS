'use client';

// 따라하기 입구 (SOT §7.17 TU-1·TU-6)
// 대시보드·과제 화면 오른쪽 아래 고정 버튼 `[따라하기]` → 우측 드로어(TutorialPanel).
//  - LocalConfig는 마운트 후에 읽는다 — 서버는 이 PC의 설정을 모르므로 SSR과 어긋난다.
//    읽기 전에는 아무것도 그리지 않는다(hydration 불일치 방지).
//  - `dismissed`면 작은 아이콘으로 줄어든다(설정의 "따라하기 다시 열기"가 되돌린다). 줄어든 아이콘도
//    눌러서 열 수는 있다 — 입구를 없애는 게 아니라 작게 하는 것이다(TU-1 "줄어들고").
//  - 열림·펼친 단계는 여기 useState(세션 메모리). 저장되는 것은 LocalConfig.tutorial뿐이다(TU-6).
//  - z-index는 Modal(z-50)보다 낮게 — 드로어 위에서 뜨는 확인 모달이 가려지면 안 된다.

import { useCallback, useEffect, useState } from 'react';
import { usePathname } from 'next/navigation';
import type { LocalConfig, TutorialStepId } from '@/types';
import type { TutorialDocument } from '@/lib/content';
import { loadLocalConfig, updateLocalConfig } from '@/lib/local-config';
import { stepForPath } from '@/lib/tutorial';
import TutorialPanel from './TutorialPanel';

export interface TutorialLauncherProps {
  /** 현재 경로의 과제. 대시보드처럼 과제 밖이면 null */
  projectId: string | null;
  /** 서버가 content/tutorial/*.md를 읽어 내려준 9편 (lib/content.readAllTutorialDocuments) */
  docs: TutorialDocument[];
}

function BookIcon() {
  // HelpLink의 `?`와 구분되는 책 모양 — 도움말이 아니라 따라하기임을 아이콘만으로 알 수 있게
  return (
    <svg aria-hidden="true" viewBox="0 0 20 20" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth="1.6">
      <path d="M3 4.5A1.5 1.5 0 0 1 4.5 3H9a1.5 1.5 0 0 1 1.5 1.5V17A1.5 1.5 0 0 0 9 15.5H3z" />
      <path d="M17 4.5A1.5 1.5 0 0 0 15.5 3H11a1.5 1.5 0 0 0-1.5 1.5V17a1.5 1.5 0 0 1 1.5-1.5h6z" />
    </svg>
  );
}

export default function TutorialLauncher({ projectId, docs }: TutorialLauncherProps) {
  const pathname = usePathname();
  const [config, setConfig] = useState<LocalConfig | null>(null);
  const [configError, setConfigError] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const [expandedStep, setExpandedStep] = useState<TutorialStepId | null>(null);

  useEffect(() => {
    loadLocalConfig()
      .then(setConfig)
      .catch((e) => setConfigError(e instanceof Error ? e.message : String(e)));
  }, []);

  // 열릴 때와, 연 채로 화면을 옮겼을 때 현재 화면의 단계를 펼친다 (TU-2).
  // 대응 단계가 없는 화면(간트·보드 등)은 이전 펼침을 그대로 둔다
  useEffect(() => {
    if (!open) return;
    const step = stepForPath(pathname);
    if (step !== null) setExpandedStep(step);
  }, [open, pathname]);

  const updateConfig = useCallback(async (patch: Partial<LocalConfig>) => {
    const next = await updateLocalConfig(patch);
    setConfig(next);
    return next;
  }, []);

  const close = useCallback(() => setOpen(false), []);

  if (config === null) {
    if (configError === null) return null;
    // 설정을 못 읽으면 입구를 그릴 수 없다 — 조용히 사라지는 대신 이유를 보인다
    return (
      <p
        role="alert"
        className="fixed bottom-6 right-6 z-40 max-w-xs rounded-xl border border-red-100 bg-red-50 p-3 text-t7 text-red-700 shadow print:hidden"
      >
        따라하기 설정을 읽지 못했습니다: {configError}
      </p>
    );
  }

  if (open) {
    return (
      <TutorialPanel
        projectId={projectId}
        docs={docs}
        config={config}
        updateConfig={updateConfig}
        expandedStep={expandedStep}
        onExpandStep={setExpandedStep}
        onClose={close}
      />
    );
  }

  if (config.tutorial.dismissed) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-label="따라하기 열기"
        title="따라하기 — 설정에서 버튼을 다시 크게 열 수 있습니다"
        className="fixed bottom-6 right-6 z-40 flex h-10 w-10 items-center justify-center rounded-full border border-grey-200 bg-surface text-grey-500 shadow transition hover:bg-grey-100 hover:text-grey-700 print:hidden"
      >
        <BookIcon />
      </button>
    );
  }

  return (
    <button
      type="button"
      onClick={() => setOpen(true)}
      className="fixed bottom-6 right-6 z-40 flex items-center gap-2 rounded-full bg-blue-500 px-5 py-3 text-t6 font-semibold text-white shadow-lg transition hover:bg-blue-600 print:hidden"
    >
      <BookIcon />
      따라하기
    </button>
  );
}
