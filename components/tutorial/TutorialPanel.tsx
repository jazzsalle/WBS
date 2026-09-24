'use client';

// 따라하기 드로어 (SOT §7.17 TU-2~TU-7, §5.16)
// 오버레이가 아니라 드로어다 — 화면 요소에 앵커를 달지 않으므로 레이아웃이 바뀌어도 깨지지 않는다.
//  - 완료 판정은 서버(getTutorialStatus)가 데이터로 한다(TU-4). 여기서는 그 결과에
//    LocalConfig의 수동 체크·백업 시각만 합친다(lib/tutorial.mergeStepStatus).
//  - `[예제 과제 지우기]`는 과제 개요로 가는 링크일 뿐이다 — 삭제 액션을 부르지 않는다(TU-5).
//    삭제 뒤 getTutorialStatus가 "과제 없음"을 돌려주면 sampleProjectId를 null로 되돌린다.
//  - 열림·펼친 단계는 부모(TutorialLauncher)의 useState, manualDone·dismissed·sampleProjectId는
//    LocalConfig(TU-6). DB에는 아무것도 쓰지 않는다.
//  - 데이터 접근은 actions/help·actions/projects 경유만 — supabase를 직접 호출하지 않는다.

import { useEffect, useId, useRef, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import type { LocalConfig, TutorialStepId } from '@/types';
import type { ActionErrorCode } from '@/lib/db/errors';
import type { TutorialDocument } from '@/lib/content';
import type { TutorialServerStatus } from '@/lib/tutorial';
import { TUTORIAL_STEPS, mergeStepStatus } from '@/lib/tutorial';
import { createSampleProject, getTutorialStatus } from '@/actions/help';
import type { ProjectSummary } from '@/actions/projects';
import { getProjectsSummary } from '@/actions/projects';
import Button from '@/components/ui/Button';
import ErrorBanner from '@/components/ui/ErrorBanner';
import StepItem from './StepItem';

export interface TutorialPanelProps {
  /** 현재 경로의 과제. 과제 화면 밖(대시보드)이면 null */
  projectId: string | null;
  docs: TutorialDocument[];
  config: LocalConfig;
  /** LocalConfig 저장 + 부모 state 갱신. 실패는 throw — 여기서 배너로 보인다 */
  updateConfig: (patch: Partial<LocalConfig>) => Promise<LocalConfig>;
  expandedStep: TutorialStepId | null;
  onExpandStep: (id: TutorialStepId | null) => void;
  onClose: () => void;
}

interface PanelError {
  message: string;
  code?: ActionErrorCode;
}

const toMessage = (e: unknown) => (e instanceof Error ? e.message : String(e));

export default function TutorialPanel({
  projectId,
  docs,
  config,
  updateConfig,
  expandedStep,
  onExpandStep,
  onClose,
}: TutorialPanelProps) {
  const router = useRouter();
  const titleId = useId();
  const selectId = useId();

  // 비동기 핸들러 안에서 최신 tutorial을 읽기 위한 ref — 닫힌 값(stale closure)으로 저장하면
  // 직전 갱신(예: sampleProjectId)이 덮어써진다
  const configRef = useRef(config);
  configRef.current = config;

  const [projects, setProjects] = useState<ProjectSummary[] | null>(null);
  // 현재 경로 과제 → 예제 과제 → 없음 (TU-4 "예제 과제가 아니어도 된다")
  const [selectedId, setSelectedId] = useState<string | null>(
    projectId ?? config.tutorial.sampleProjectId
  );
  const [status, setStatus] = useState<TutorialServerStatus | null>(null);
  const [statusLoading, setStatusLoading] = useState(false);
  const [error, setError] = useState<PanelError | null>(null);
  const [busy, setBusy] = useState<'create' | 'config' | null>(null);
  // 새로고침·예제 생성 뒤 목록·판정을 다시 읽게 하는 토큰
  const [reloadKey, setReloadKey] = useState(0);

  // Esc 닫기 + 뒤 본문 스크롤 잠금 (Modal과 같은 이유)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = previousOverflow;
    };
  }, [onClose]);

  // 드로어를 연 채 다른 과제로 이동하면 선택도 따라간다
  useEffect(() => {
    if (projectId !== null) setSelectedId(projectId);
  }, [projectId]);

  // 과제 선택 목록 — 비보관 과제만
  useEffect(() => {
    let cancelled = false;
    getProjectsSummary(false)
      .then((res) => {
        if (cancelled) return;
        if (res.ok) setProjects(res.data);
        else setError({ message: `과제 목록을 읽지 못했습니다: ${res.error}`, code: res.code });
      })
      .catch((e) => {
        if (!cancelled) setError({ message: `과제 목록을 읽지 못했습니다: ${toMessage(e)}` });
      });
    return () => {
      cancelled = true;
    };
  }, [reloadKey]);

  // 열릴 때·선택이 바뀔 때 서버 판정 (TU-4). 과제 없음이 예제 id를 가리키면 되돌린다 (TU-5)
  useEffect(() => {
    if (selectedId === null) {
      setStatus(null);
      return;
    }
    let cancelled = false;
    setStatusLoading(true);
    getTutorialStatus(selectedId)
      .then(async (res) => {
        if (cancelled) return;
        if (!res.ok) {
          setStatus(null);
          setError({ message: `단계 완료 여부를 읽지 못했습니다: ${res.error}`, code: res.code });
          return;
        }
        setStatus(res.data);
        const tutorial = configRef.current.tutorial;
        if (!res.data.projectExists && tutorial.sampleProjectId === selectedId) {
          try {
            await updateConfig({ tutorial: { ...tutorial, sampleProjectId: null } });
          } catch (e) {
            if (!cancelled) setError({ message: `예제 과제 기록을 지우지 못했습니다: ${toMessage(e)}` });
          }
        }
      })
      .catch((e) => {
        if (!cancelled) {
          setStatus(null);
          setError({ message: `단계 완료 여부를 읽지 못했습니다: ${toMessage(e)}` });
        }
      })
      .finally(() => {
        if (!cancelled) setStatusLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [selectedId, reloadKey, updateConfig]);

  const patchTutorial = async (partial: Partial<LocalConfig['tutorial']>) => {
    await updateConfig({ tutorial: { ...configRef.current.tutorial, ...partial } });
  };

  const handleCreateSample = async () => {
    setBusy('create');
    setError(null);
    try {
      const result = await createSampleProject(configRef.current.tutorial.sampleProjectId);
      if (result.ok) {
        await patchTutorial({ sampleProjectId: result.data.projectId });
        setSelectedId(result.data.projectId);
        setReloadKey((k) => k + 1);
        router.push(`/projects/${result.data.projectId}`);
        return;
      }
      // 일부만 만들어진 과제는 id를 기록해 [예제 과제 지우기]가 그 과제를 가리키게 한다 (TU-3)
      setError({ message: result.error, code: result.code });
      if ('projectId' in result) {
        await patchTutorial({ sampleProjectId: result.projectId });
        setReloadKey((k) => k + 1);
      }
    } catch (e) {
      setError({ message: `예제 과제를 만들지 못했습니다: ${toMessage(e)}` });
    } finally {
      setBusy(null);
    }
  };

  const handleManualChange = async (id: TutorialStepId, checked: boolean) => {
    setBusy('config');
    setError(null);
    try {
      const current = configRef.current.tutorial.manualDone;
      const next = checked ? [...new Set([...current, id])] : current.filter((s) => s !== id);
      await patchTutorial({ manualDone: next });
    } catch (e) {
      setError({ message: `완료 표시를 저장하지 못했습니다: ${toMessage(e)}` });
    } finally {
      setBusy(null);
    }
  };

  const handleDismiss = async () => {
    setBusy('config');
    setError(null);
    try {
      await patchTutorial({ dismissed: true });
      onClose();
    } catch (e) {
      setError({ message: `설정을 저장하지 못했습니다: ${toMessage(e)}` });
    } finally {
      setBusy(null);
    }
  };

  const handleRefresh = () => {
    setError(null);
    setReloadKey((k) => k + 1);
  };

  const { tutorial, lastBackupAt } = config;
  const sampleProjectId = tutorial.sampleProjectId;
  // 목록에 없는 예제(삭제·보관)는 "살아 있음"으로 치지 않는다 — 목록을 아직 못 읽었으면 기록을 믿는다
  const sampleAlive =
    sampleProjectId !== null &&
    (projects === null || projects.some((p) => p.project.id === sampleProjectId));

  const stepDone = mergeStepStatus(status, tutorial, lastBackupAt);
  const doneCount = TUTORIAL_STEPS.filter((s) => stepDone[s.id]).length;
  const docByStep = new Map(docs.map((d) => [d.step, d]));

  // 현재 경로의 과제가 보관됐거나 목록을 못 읽었을 때도 선택은 표시돼야 한다
  const options: { id: string; name: string }[] = (projects ?? []).map((p) => ({
    id: p.project.id,
    name: p.project.name,
  }));
  if (selectedId !== null && !options.some((o) => o.id === selectedId)) {
    options.unshift({ id: selectedId, name: '(현재 과제)' });
  }

  const inputsDisabled = busy !== null;

  return (
    <div
      className="fixed inset-0 z-40 bg-dimmed print:hidden"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <aside
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className="fixed inset-y-0 right-0 flex w-[26rem] max-w-full flex-col rounded-l-3xl bg-surface shadow-xl"
      >
        {/* 헤더 */}
        <div className="border-b border-hairline px-6 pb-4 pt-6">
          <div className="flex items-start justify-between gap-4">
            <div>
              <h2 id={titleId} className="text-t4 font-bold text-grey-900">
                따라하기
              </h2>
              <p className="mt-1 text-t7 text-grey-500">
                예제 과제를 만들고 9단계를 실제 화면에서 따라갑니다. 완료 {doneCount} / {TUTORIAL_STEPS.length}
              </p>
            </div>
            <button
              type="button"
              onClick={onClose}
              aria-label="닫기"
              className="shrink-0 text-xl leading-none text-grey-400 hover:text-grey-600"
            >
              ×
            </button>
          </div>

          <div
            role="progressbar"
            aria-valuemin={0}
            aria-valuemax={TUTORIAL_STEPS.length}
            aria-valuenow={doneCount}
            aria-label="따라하기 진행"
            className="mt-3 h-1.5 w-full overflow-hidden rounded-full bg-grey-200"
          >
            <div
              className={`h-full rounded-full transition-[width] ${
                doneCount === TUTORIAL_STEPS.length ? 'bg-green-500' : 'bg-blue-500'
              }`}
              style={{ width: `${(doneCount / TUTORIAL_STEPS.length) * 100}%` }}
            />
          </div>

          <label htmlFor={selectId} className="mt-4 block text-t7 font-medium text-grey-600">
            따라갈 과제
          </label>
          <select
            id={selectId}
            value={selectedId ?? ''}
            disabled={inputsDisabled}
            onChange={(e) => setSelectedId(e.target.value === '' ? null : e.target.value)}
            className="mt-1 w-full rounded-md border border-grey-300 px-3 py-2 text-t6 text-grey-900 focus:border-blue-500 focus:outline-none focus:ring-2 focus:ring-blue-100 disabled:bg-grey-50"
          >
            <option value="">{projects === null ? '과제 목록 읽는 중…' : '과제를 고르세요'}</option>
            {options.map((o) => (
              <option key={o.id} value={o.id}>
                {o.name}
              </option>
            ))}
          </select>

          <div className="mt-3 flex flex-wrap items-center gap-2">
            {sampleAlive && sampleProjectId !== null ? (
              <>
                <Link
                  href={`/projects/${sampleProjectId}`}
                  className="rounded-lg bg-blue-500 px-3 py-1.5 text-t7 font-semibold text-white transition hover:bg-blue-600"
                >
                  예제 과제로 이동
                </Link>
                {/* TU-5: 삭제는 과제 개요의 [과제 삭제](2단계 확인)만 — 여기서는 그 화면으로 보낼 뿐이다 */}
                <Link
                  href={`/projects/${sampleProjectId}`}
                  className="rounded-lg bg-grey-100 px-3 py-1.5 text-t7 font-semibold text-grey-800 transition hover:bg-grey-200"
                >
                  예제 과제 지우기
                </Link>
              </>
            ) : (
              <Button
                variant="primary"
                size="sm"
                onClick={handleCreateSample}
                disabled={inputsDisabled}
              >
                {busy === 'create' ? '만드는 중…' : '예제 과제 만들기'}
              </Button>
            )}
            <Button size="sm" onClick={handleRefresh} disabled={inputsDisabled || statusLoading}>
              {statusLoading ? '판정 중…' : '새로고침'}
            </Button>
            <Button variant="ghost" size="sm" onClick={handleDismiss} disabled={inputsDisabled} className="ml-auto">
              다시 보지 않기
            </Button>
          </div>
        </div>

        {/* 본문 */}
        <div className="flex-1 overflow-y-auto px-6 py-4">
          {error && (
            <ErrorBanner
              message={error.message}
              code={error.code}
              onDismiss={() => setError(null)}
              className="mb-4"
            />
          )}

          {selectedId === null && (
            <p className="mb-4 rounded-lg bg-grey-50 p-3 text-t7 text-grey-600">
              과제를 고르면 단계 완료 여부를 데이터로 판정합니다. 아직 과제가 없으면 [예제 과제 만들기]로
              시작하세요 — 팀 전원에게 보이는 실제 과제가 만들어집니다.
            </p>
          )}

          <ol className="space-y-2">
            {TUTORIAL_STEPS.map((step) => (
              <StepItem
                key={step.id}
                step={step}
                doc={docByStep.get(step.id)}
                done={stepDone[step.id]}
                expanded={expandedStep === step.id}
                onToggleExpand={() => onExpandStep(expandedStep === step.id ? null : step.id)}
                selectedProjectId={selectedId}
                manualLocked={step.id === 'backup' && lastBackupAt !== null}
                onManualChange={(checked) => void handleManualChange(step.id, checked)}
                disabled={inputsDisabled}
              />
            ))}
          </ol>
        </div>
      </aside>
    </div>
  );
}
