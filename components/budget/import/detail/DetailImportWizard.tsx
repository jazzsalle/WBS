'use client';

// 산출근거 가져오기 마법사 — 모달 + 4단계 상태 기계 (SOT §7.9.3, §6.11)
//
// **§7.9.1(총괄표) 마법사와 별개 흐름이다** — 대상 계층이 다르고(셀 총액 vs 행 내역) 성명 매핑
// 단계가 있다. 흐름을 공유하지 않고 모달·단계 표시·실패 배너·R-4 보류 같은 관례만 따른다.
//
// 설계 원칙 (§7.9.3):
//  - 어느 단계에서든 뒤로 갈 수 있고, 마지막 반영 전까지 저장되는 것은 없다 (새 인력도 그때 만든다 — D-12)
//  - 모달을 닫으면 진행 상태는 폐기한다 (부모가 언마운트한다)
//  - 실패는 반드시 화면에 남긴다 (ErrorBanner, 절대 규칙 5)
//
// 파싱·판정은 전부 actions/detail-import.ts가 한다 — SheetJS를 클라이언트에서 import하지 않는다
// (I-13). 여기서는 사용자의 결정을 DetailImportDraft 한 값에 모아 넘길 뿐이고, 세목 확정·통화
// 경고 같은 판정은 서버가 내린 값을 그대로 표시한다 (O-4).

import { useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import type {
  ActionResult,
  BudgetCategory,
  CommitDetailImportResult,
  DetailImportDraft,
  DetailMemberDecision,
  DetailRowDecision,
  InspectDetailSheetResult,
  Member,
  Organization,
  PreviewDetailImportResult,
  Year,
} from '@/types';
import { commitDetailImport, inspectDetailSheet, previewDetailImport } from '@/actions/detail-import';
import { getTeam } from '@/actions/team';
import Button from '@/components/ui/Button';
import ErrorBanner from '@/components/ui/ErrorBanner';
import Modal from '@/components/ui/Modal';
import { setRealtimePaused } from '@/components/RealtimeRefresher';
import DetailStep1FileYear from './DetailStep1FileYear';
import DetailStep2Structure from './DetailStep2Structure';
import DetailStep3Members from './DetailStep3Members';
import DetailStep4Preview from './DetailStep4Preview';
import {
  DETAIL_STEP_TITLES,
  buildFormData,
  detailStep1Blockers,
  detailStep2Blockers,
  initialDetailDraft,
  sheetByName,
  suggestedYearId,
  toWizardYears,
  withAxisOverride,
  withColumnRoleOverride,
  withCurrencyConfirmed,
  withSheet,
  withSubcategoryChoice,
  withYear,
  type DetailWizardStep,
  type Failure,
} from './detail-wizard-state';

export interface DetailImportWizardProps {
  /** D-19: 대상 연차 후보. 과제는 연차에서 파생되므로 projectId를 따로 받지 않는다 */
  years: Year[];
  onClose: () => void;
}

export default function DetailImportWizard({ years, onClose }: DetailImportWizardProps) {
  const router = useRouter();
  const wizardYears = useMemo(() => toWizardYears(years), [years]);

  const [step, setStep] = useState<DetailWizardStep>(1);
  const [file, setFile] = useState<File | null>(null);
  const [inspect, setInspect] = useState<InspectDetailSheetResult | null>(null);
  const [draft, setDraft] = useState<DetailImportDraft>(initialDetailDraft);
  const [preview, setPreview] = useState<PreviewDetailImportResult | null>(null);
  const [committed, setCommitted] = useState<CommitDetailImportResult | null>(null);
  // 사용자 결정이 현재 미리보기에 아직 반영되지 않았는가 (§6.11 대원칙: 확인 전에는 저장하지 않는다)
  const [dirty, setDirty] = useState(false);
  // D-19: 사용자가 연차를 직접 고른 뒤에는 시트를 바꿔도 제안이 그것을 덮지 않는다
  const [yearTouched, setYearTouched] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [failure, setFailure] = useState<Failure | null>(null);

  // D-11 ①의 후보는 그 과제의 **명부 전체**다. 미리보기가 싣는 동명이인 후보만으로는
  // 표기가 다른 사람(`홍길동(책임)`)을 이을 수 없다. 조회는 반영 대상 연차가 정해진 뒤에 한다
  const [roster, setRoster] = useState<{ projectId: string; members: Member[]; organizations: Organization[] } | null>(
    null
  );
  const [rosterError, setRosterError] = useState<string | null>(null);

  // 비동기 흐름에서 최신 draft를 읽어야 한다 (await 뒤의 클로저는 낡은 값을 본다)
  const draftRef = useRef(draft);
  draftRef.current = draft;

  // R-4: 마법사가 열려 있는 동안 자동 새로고침을 보류해 진행 중인 입력을 지킨다
  useEffect(() => {
    setRealtimePaused(true);
    return () => setRealtimePaused(false);
  }, []);

  const sheet = useMemo(
    () => sheetByName(inspect?.sheets ?? [], draft.sheetName),
    [inspect, draft.sheetName]
  );
  const grid = inspect?.grids.find((item) => item.sheetName === draft.sheetName) ?? null;
  const suggestedId = suggestedYearId(sheet, wizardYears);
  const chosenYear = wizardYears.find((year) => year.id === draft.yearId) ?? null;

  // §7.9.3 Step 3은 **인건비 행이 있을 때만** 나타난다. 없으면 2 → 4로 건너뛴다
  const hasPersonnel = preview !== null && preview.rows.some((row) => row.formula === 'personnel');
  const namelessRows =
    preview === null
      ? 0
      : preview.rows.filter(
          (row) => row.formula === 'personnel' && (row.memberName === null || row.memberName.trim() === '')
        ).length;

  function applyDraft(next: DetailImportDraft): void {
    draftRef.current = next;
    setDraft(next);
  }

  /** 사용자 결정이 바뀌면 현재 미리보기는 더 이상 그 결정의 결과가 아니다 */
  function decide(next: DetailImportDraft): void {
    applyDraft(next);
    setDirty(true);
  }

  async function run<T>(label: string, action: () => Promise<ActionResult<T>>): Promise<T | null> {
    setBusy(label);
    setFailure(null);
    try {
      const res = await action();
      if (!res.ok) {
        // 절대 규칙 5: 실패를 조용히 삼키지 않는다. 섹션이 없는 파일도 여기로 온다 (D-1)
        setFailure({ message: res.error, code: res.code });
        return null;
      }
      return res.data;
    } finally {
      setBusy(null);
    }
  }

  // ─── Step 1 ────────────────────────────────────────────────

  async function handleFileAccepted(picked: File): Promise<void> {
    setFile(picked);
    setInspect(null);
    setDraft(initialDetailDraft());
    setYearTouched(false);
    resetPreview();

    const data = await run('파일을 읽는 중입니다…', () => inspectDetailSheet(buildFormData(picked)));
    if (!data) return;
    setInspect(data);

    // 추천은 하이라이트일 뿐이지만 초기 선택은 있어야 트리를 볼 수 있다 (D-1)
    const chosen =
      data.sheets.find((item) => item.name === data.recommendedSheet) ??
      data.sheets.find((item) => item.eligible) ??
      data.sheets[0] ??
      null;

    setDraft((prev) => {
      const next = withSheet(prev, chosen?.name ?? null);
      const yearId = suggestedYearId(chosen, wizardYears);
      return yearId === null ? next : withYear(next, yearId);
    });
  }

  /** 시트·연차·파일이 바뀌면 이전 미리보기는 그 구조의 결과가 아니다 */
  function resetPreview(): void {
    setPreview(null);
    setCommitted(null);
    setDirty(false);
  }

  // ─── Step 2 ────────────────────────────────────────────────

  function handleSelectSheet(name: string): void {
    resetPreview();
    setDraft((prev) => {
      const next = withSheet(prev, name);
      if (yearTouched) return next;
      const yearId = suggestedYearId(sheetByName(inspect?.sheets ?? [], name), wizardYears);
      return yearId === null ? next : withYear(next, yearId);
    });
  }

  // ─── 미리보기 ──────────────────────────────────────────────

  async function runPreview(): Promise<PreviewDetailImportResult | null> {
    const currentFile = file;
    if (currentFile === null) return null;
    const data = await run('반영 예정 내역을 계산하는 중입니다…', () =>
      previewDetailImport(buildFormData(currentFile), draftRef.current)
    );
    if (!data) return null;

    setPreview(data);
    // §5.12.2와 같은 규약: 미리보기가 계산한 fileHash를 draft에 심어 commit이 같은 파일임을 대조한다
    applyDraft({ ...draftRef.current, fileHash: data.fileHash });
    setDirty(false);
    return data;
  }

  async function ensurePreview(): Promise<PreviewDetailImportResult | null> {
    if (preview !== null && !dirty) return preview;
    return runPreview();
  }

  /**
   * D-11 ①의 후보 목록. 실패해도 마법사를 멈추지 않고 Step 3에 문구로 드러낸다 —
   * ②·③은 명부 없이도 고를 수 있어야 하고, 빈 목록을 "명부가 비었다"로 오해하면 안 된다.
   */
  async function loadRoster(projectId: string): Promise<void> {
    if (roster !== null && roster.projectId === projectId) return;
    setRosterError(null);
    const res = await getTeam(projectId);
    if (!res.ok) {
      setRoster({ projectId, members: [], organizations: [] });
      setRosterError(res.error);
      return;
    }
    setRoster({ projectId, members: res.data.members, organizations: res.data.organizations });
  }

  // ─── 단계 이동 ─────────────────────────────────────────────

  async function goNext(): Promise<void> {
    if (step === 1) {
      setStep(2);
      return;
    }
    if (step === 2) {
      const data = await ensurePreview();
      if (!data) return;
      if (data.rows.some((row) => row.formula === 'personnel')) {
        void loadRoster(data.projectId);
        setStep(3);
        return;
      }
      setStep(4);
      return;
    }
    if (step === 3) {
      const data = await ensurePreview();
      if (!data) return;
      setStep(4);
    }
  }

  function goBack(): void {
    if (step === 1) return;
    if (step === 4 && !hasPersonnel) {
      setStep(2);
      return;
    }
    setStep((step - 1) as DetailWizardStep);
  }

  // ─── 반영 ──────────────────────────────────────────────────

  async function handleCommit(): Promise<void> {
    const currentFile = file;
    if (currentFile === null || preview === null || preview.blocked || dirty || committed !== null) {
      return;
    }
    const result = await run('산출근거를 반영하는 중입니다…', () =>
      commitDetailImport(buildFormData(currentFile), draftRef.current)
    );
    if (!result) return;
    setCommitted(result);
    // 매트릭스·지침 검증 줄은 서버에서 다시 그린다 (총괄표 마법사가 부모에서 하는 것과 같은 갱신)
    router.refresh();
  }

  // ─── 단계 이동 판정 ────────────────────────────────────────

  const blockers =
    step === 1
      ? detailStep1Blockers(file, inspect, draft, wizardYears)
      : step === 2
        ? detailStep2Blockers(sheet)
        : [];
  const canGoNext = step < 4 && busy === null && blockers.length === 0;

  const commitBlocker =
    preview === null
      ? '미리보기를 먼저 확인하세요.'
      : dirty
        ? '바꾼 내용을 [다시 확인]해야 반영할 수 있습니다.'
        : preview.blocked
          ? `오류 ${preview.summary.error}건이 있어 반영할 수 없습니다.`
          : null;

  return (
    <Modal
      open
      size="xl"
      closeOnBackdrop={false}
      title={`산출근거 가져오기 — ${step}/4 ${DETAIL_STEP_TITLES[step]}`}
      description="반영 버튼을 누르기 전에는 아무것도 저장되지 않습니다. 모달을 닫으면 진행 상태는 폐기됩니다."
      // 진행 중에는 Esc·×로 닫히지 않게 한다 — 결과를 못 본 채 닫히면 무엇이 됐는지 알 수 없다
      onClose={() => {
        if (busy === null) onClose();
      }}
      footer={
        <>
          <span className="mr-auto text-xs text-slate-500">
            {step < 4 && blockers.length > 0 && <span className="text-red-600">{blockers[0]}</span>}
            {step === 4 && committed === null && commitBlocker !== null && (
              <span className="text-red-600">{commitBlocker}</span>
            )}
          </span>
          {committed === null ? (
            <>
              <Button variant="ghost" onClick={onClose} disabled={busy !== null}>
                취소
              </Button>
              <Button variant="secondary" onClick={goBack} disabled={step === 1 || busy !== null}>
                이전
              </Button>
              {step < 4 ? (
                <Button variant="primary" onClick={() => void goNext()} disabled={!canGoNext}>
                  다음
                </Button>
              ) : (
                <Button
                  variant="primary"
                  onClick={() => void handleCommit()}
                  disabled={busy !== null || commitBlocker !== null}
                  title={commitBlocker ?? undefined}
                >
                  산출근거 반영
                </Button>
              )}
            </>
          ) : (
            // 반영이 끝난 뒤에는 되돌아가 두 번 넣을 수 없게 한다 — 되돌리기는 스냅샷의 몫이다 (D-17)
            <Button variant="primary" onClick={onClose} disabled={busy !== null}>
              닫기
            </Button>
          )}
        </>
      }
    >
      <div className="space-y-4">
        <StepIndicator step={step} skipStep3={preview !== null && !hasPersonnel} />

        {file && (
          <p className="text-[11px] text-slate-400">
            {file.name} · 시트 {draft.sheetName ?? '(미선택)'} · 대상 연차{' '}
            {chosenYear === null ? '(미선택)' : `${chosenYear.order + 1}차년도 · ${chosenYear.name}`}
          </p>
        )}

        {busy && (
          <p
            role="status"
            className="flex items-center gap-2 rounded-lg border border-blue-200 bg-blue-50 px-3 py-2 text-sm text-blue-800"
          >
            <span className="inline-block h-3 w-3 animate-spin rounded-full border-2 border-blue-300 border-t-blue-700" />
            {busy}
          </p>
        )}

        {failure && (
          <ErrorBanner
            message={failure.message}
            code={failure.code}
            onDismiss={() => setFailure(null)}
          />
        )}

        {step === 1 && (
          <DetailStep1FileYear
            file={file}
            busy={busy !== null}
            inspect={inspect}
            years={wizardYears}
            yearId={draft.yearId}
            suggestedYearId={suggestedId}
            suggestedFromSheet={suggestedId === null ? null : (sheet?.name ?? null)}
            onFileAccepted={(picked) => void handleFileAccepted(picked)}
            onYearChange={(yearId) => {
              setYearTouched(true);
              // 연차가 바뀌면 기존 셀 판정(D-15)과 명부가 달라진다
              resetPreview();
              setDraft((prev) => withYear(prev, yearId));
            }}
          />
        )}

        {step === 2 && inspect && (
          <DetailStep2Structure
            inspect={inspect}
            sheet={sheet}
            grid={grid}
            draft={draft}
            busy={busy !== null}
            onSelectSheet={handleSelectSheet}
            onSubcategoryChoice={(blockKey, code) =>
              decide(withSubcategoryChoice(draftRef.current, blockKey, code))
            }
            onCurrencyConfirm={(blockKey, confirmed) =>
              decide(withCurrencyConfirmed(draftRef.current, blockKey, confirmed))
            }
            // D-7: 헤더 텍스트로 정한 매핑은 제안이다. 사용자가 고칠 수 있어야 한다
            onColumnRoleOverride={(blockKey, columnIndex, role) =>
              decide(withColumnRoleOverride(draftRef.current, blockKey, columnIndex, role))
            }
          />
        )}

        {step === 3 && preview && (
          <DetailStep3Members
            matches={preview.members}
            decisions={draft.memberDecisions ?? {}}
            roster={roster?.members ?? []}
            organizations={roster?.organizations ?? []}
            rosterError={rosterError}
            projectId={preview.projectId}
            namelessRows={namelessRows}
            busy={busy !== null}
            onDecision={(key, decision) =>
              decide(withMemberDecision(draftRef.current, key, decision))
            }
          />
        )}

        {step === 4 && (
          <DetailStep4Preview
            preview={preview}
            draft={draft}
            committed={committed}
            dirty={dirty}
            busy={busy !== null}
            hasPersonnel={hasPersonnel}
            onRecheck={() => void runPreview()}
            onToggleReplace={(category, replace) =>
              decide(withReplaceCategory(draftRef.current, category, replace))
            }
            onRowDecision={(rowKey, decision) =>
              decide(withRowDecision(draftRef.current, rowKey, decision))
            }
            // D-9: 합계 열만 있어 현금으로 제안한 축이다. 확정이 아니므로 사용자가 바꾼다
            onAxisOverride={(rowKey, axis) =>
              decide(withAxisOverride(draftRef.current, rowKey, axis))
            }
            onCurrencyConfirm={(blockKey, confirmed) =>
              decide(withCurrencyConfirmed(draftRef.current, blockKey, confirmed))
            }
            onGoToStep={setStep}
          />
        )}
      </div>
    </Modal>
  );
}

// ─── draft 갱신 (Step 3·4 전용) ──────────────────────────────
//
// `detail-wizard-state.ts`의 `withSubcategoryChoice`·`withCurrencyConfirmed`와 같은 규약이다.
// 그 파일에 대응 헬퍼가 없어 여기 둔다 — 순수 함수이며 draft를 갈아엎지 않고 얕은 복사만 한다.

/** D-11: 성명 결정. null이면 자동 제안(matchDetailMembers의 판정)으로 되돌린다 */
function withMemberDecision(
  draft: DetailImportDraft,
  key: string,
  decision: DetailMemberDecision | null
): DetailImportDraft {
  const decisions = { ...(draft.memberDecisions ?? {}) };
  if (decision === null) delete decisions[key];
  else decisions[key] = decision;
  return { ...draft, memberDecisions: decisions };
}

/** D-15: [기존 삭제 후 교체]. 담기지 않은 비목은 기존 행이 있으면 건너뛴다 */
function withReplaceCategory(
  draft: DetailImportDraft,
  category: BudgetCategory,
  replace: boolean
): DetailImportDraft {
  const current = draft.replaceCategories ?? [];
  if (replace) {
    return current.includes(category) ? draft : { ...draft, replaceCategories: [...current, category] };
  }
  return { ...draft, replaceCategories: current.filter((item) => item !== category) };
}

/** D-21 ②: 행 단위 포함·제외. 0원 행의 기본 건너뜀을 사용자가 뒤집을 수 있다 */
function withRowDecision(
  draft: DetailImportDraft,
  rowKey: string,
  decision: DetailRowDecision
): DetailImportDraft {
  return { ...draft, rowDecisions: { ...(draft.rowDecisions ?? {}), [rowKey]: decision } };
}

function StepIndicator({ step, skipStep3 }: { step: DetailWizardStep; skipStep3: boolean }) {
  return (
    <ol className="flex flex-wrap items-center gap-1.5 text-xs">
      {([1, 2, 3, 4] as DetailWizardStep[]).map((n) => {
        // 인건비 행이 없으면 Step 3은 아예 나타나지 않는다 (§7.9.3) — 지나친 것이 아니라 해당 없음이다
        const skipped = n === 3 && skipStep3;
        return (
          <li
            key={n}
            className={`rounded-full px-2.5 py-1 ${
              n === step
                ? 'bg-slate-900 font-semibold text-white'
                : skipped
                  ? 'bg-slate-50 text-slate-300 line-through'
                  : n < step
                    ? 'bg-slate-200 text-slate-600'
                    : 'bg-slate-50 text-slate-400'
            }`}
          >
            {n}. {DETAIL_STEP_TITLES[n]}
            {skipped && ' (해당 없음)'}
          </li>
        );
      })}
    </ol>
  );
}
