'use client';

// 목표 양식 올리기 모달 — 파일 → 미리보기 → 반영 (SOT §7.7 [양식 올리기], §6.17 GF-5·GF-11)
//
//  - **id 기반** 추가·변경·(선택)삭제, 충돌은 그 행만 건너뜀
//  - **[삭제 포함]은 기본 꺼짐**(GF-5). 지표 삭제는 실적·측정 이력을 cascade로 지우고 작업 연계를 끊으므로
//    "실적 N · 측정 M · 연계 작업 K"를 보고 켜야 지운다. 달성률 전후는 토글에 따라 preview.rates /
//    ratesWithDeletes를 바꿔 보일 뿐 서버를 다시 부르지 않는다
//  - blocking 오류가 1건이라도 있으면 반영 버튼 비활성(부분 반영 없음, S-21). 경고는 막지 않는다
//  - 충돌은 미리보기에서도, 반영 결과에서도 목록을 그대로 보인다 — 건너뛴 사실이 안 보이면 반영된 줄 안다 (절대 규칙 5)
//  - 목표 양식 스냅샷은 복원할 수 없다(GF-11) — 반영 전에 알린다. 예산 임포트의 "스냅샷으로 되돌리기" 안내와 다르다
//
// 파싱·판정은 전부 actions/goal-form.ts가 한다 — SheetJS를 클라이언트에서 import하지 않는다 (I-13).
// 미리보기 본문은 GoalPreviewPanel이 그린다 — 계획서(hwpx) 모달과 같은 표시를 쓰기 위해서다 (HX-8).

import { useEffect, useMemo, useRef, useState } from 'react';
import type { ActionErrorCode } from '@/lib/db/errors';
import type { GoalFormCommitOutcome, GoalFormPreviewResult } from '@/actions/goal-form';
import { commitGoalForm, previewGoalForm } from '@/actions/goal-form';
import Button from '@/components/ui/Button';
import ErrorBanner from '@/components/ui/ErrorBanner';
import Modal from '@/components/ui/Modal';
import { setRealtimePaused } from '@/components/RealtimeRefresher';
import { MAX_UPLOAD_BYTES, buildFormData, formatBytes } from '@/components/budget/import/wizard-state';
import GoalPreviewPanel, {
  GOAL_FORM_KINDS,
  GOAL_SHEET_LABELS,
  GoalConflictList,
  buildGoalConflictLabels,
  type GoalRowPlace,
} from '@/components/goals/GoalPreviewPanel';

/** GF-1: 양식은 xlsx만 */
const ACCEPT_ATTRIBUTE = '.xlsx';

/** GF-11. 반영 전(미리보기)과 반영 후(결과)에 같은 문장을 보인다 */
const IRREVERSIBLE_NOTICE =
  '목표 양식 반영은 되돌릴 수 없습니다 — 설정 화면 스냅샷 목록에 "목표 양식"으로 남지만 복원할 수 없습니다 (GF-11).';

type Step = 'pick' | 'preview' | 'done';

interface Failure {
  message: string;
  code?: ActionErrorCode;
}

/** xlsx는 시트 이름 + 엑셀 행 번호 — 사용자가 파일에서 바로 찾아갈 수 있어야 한다 */
const rowPlace: GoalRowPlace = (row) => `${GOAL_SHEET_LABELS[row.kind]} ${row.sheetRow}행`;

/** 결과 문장. 부모의 결과 알림에도 같은 문장을 쓴다. 건수는 RPC가 실제로 반영한 수다 */
function commitMessage(result: GoalFormCommitOutcome): string {
  const byKind = {
    deliverable: result.deliverables,
    achievement: result.achievements,
    techTarget: result.techTargets,
    record: result.records,
  } as const;
  const parts = GOAL_FORM_KINDS.map(
    (kind) =>
      `${GOAL_SHEET_LABELS[kind]} 추가 ${byKind[kind].added} · 변경 ${byKind[kind].updated} · 삭제 ${byKind[kind].deleted}`
  );
  const skipped = result.previewConflicts.length + result.conflicts.length;
  const tail: string[] = [];
  if (skipped > 0) tail.push(`충돌 ${skipped}건 건너뜀`);
  if (result.skippedDeletes > 0) tail.push(`삭제 후보 ${result.skippedDeletes}건 유지`);
  return `목표 양식 반영 — ${parts.join(' / ')}${tail.length > 0 ? ` · ${tail.join(' · ')}` : ''}`;
}

export interface GoalFormUploadProps {
  projectId: string;
  onClose: () => void;
  /** 반영 성공 직후. 부모는 결과 알림을 띄우고 router.refresh()로 목표 표를 다시 그린다 */
  onDone: (message: string) => void;
}

export default function GoalFormUpload({ projectId, onClose, onDone }: GoalFormUploadProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [step, setStep] = useState<Step>('pick');
  const [file, setFile] = useState<File | null>(null);
  const [result, setResult] = useState<GoalFormPreviewResult | null>(null);
  const [committed, setCommitted] = useState<GoalFormCommitOutcome | null>(null);
  // GF-5: 기본 꺼짐. 파일을 새로 고르면 다시 꺼진다 — 앞 파일에서 켠 선택이 새 삭제 후보에 넘어가면 안 된다
  const [includeDeletes, setIncludeDeletes] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [failure, setFailure] = useState<Failure | null>(null);

  // R-4: 모달이 열려 있는 동안 자동 새로고침을 보류해 미리보기·반영 흐름을 지킨다
  useEffect(() => {
    setRealtimePaused(true);
    return () => setRealtimePaused(false);
  }, []);

  function rejectReason(picked: File): string | null {
    if (!picked.name.toLowerCase().endsWith('.xlsx')) {
      return '목표 양식은 .xlsx 파일만 올릴 수 있습니다. [양식 내려받기]로 받은 파일을 그대로 올리세요.';
    }
    if (picked.size > MAX_UPLOAD_BYTES) return `파일이 ${formatBytes(picked.size)}로 상한 10MB를 넘습니다.`;
    if (picked.size === 0) return '빈 파일입니다.';
    return null;
  }

  async function handleFile(picked: File | null | undefined): Promise<void> {
    if (!picked) return;
    const reason = rejectReason(picked);
    if (reason) {
      setFailure({ message: reason, code: 'VALIDATION' });
      return;
    }
    setFile(picked);
    setResult(null);
    setIncludeDeletes(false);
    setBusy('양식을 읽는 중입니다…');
    setFailure(null);
    try {
      const res = await previewGoalForm(projectId, buildFormData(picked));
      if (!res.ok) {
        // 절대 규칙 5: _meta 거부(GF-2)·입력 양식 파일·과제 경계 위반도 여기로 온다. 문구 그대로 보인다
        setFailure({ message: res.error, code: res.code });
        return;
      }
      setResult(res.data);
      setStep('preview');
    } catch (e) {
      // 액션 호출 자체가 던지면(네트워크 단절 등) 조용히 멈추지 않는다
      setFailure({ message: `서버와 통신하지 못했습니다 — 잠시 뒤 다시 올리세요 (${e instanceof Error ? e.message : String(e)})` });
    } finally {
      setBusy(null);
    }
  }

  async function handleCommit(): Promise<void> {
    if (file === null || result === null || commitBlocker !== null || committed !== null) return;
    setBusy('목표를 반영하는 중입니다…');
    setFailure(null);
    try {
      // 액션은 스테이트리스라 파일을 다시 보낸다. fileHash로 미리보기와 같은 파일임을 대조한다 (IN-6).
      // 충돌 기준 version과 삭제 후보는 파일의 _meta가 정하므로 따로 넘기지 않는다 (GF-5)
      const res = await commitGoalForm(projectId, buildFormData(file), result.fileHash, includeDeletes);
      if (!res.ok) {
        setFailure({ message: res.error, code: res.code });
        return;
      }
      setCommitted(res.data);
      setStep('done');
      onDone(commitMessage(res.data));
    } catch (e) {
      // 액션 호출 자체가 던지면 반영이 됐는지 알 수 없다 — 확인을 요청한다
      setFailure({ message: `서버와 통신하지 못했습니다 — 반영 여부를 목표 화면에서 확인한 뒤 다시 시도하세요 (${e instanceof Error ? e.message : String(e)})` });
    } finally {
      setBusy(null);
    }
  }

  const preview = result?.preview ?? null;
  // 결과 화면의 충돌 목록도 미리보기 행으로 이름을 붙인다 — 패널이 내려간 뒤에도 필요해 여기서 만든다
  const conflictLabels = useMemo(
    () => (preview === null ? new Map<string, string>() : buildGoalConflictLabels(preview, rowPlace)),
    [preview]
  );

  const rates = result === null ? null : includeDeletes ? result.ratesWithDeletes : result.preview.rates;

  // 막는 것: blocked, 그리고 반영할 것이 없을 때. 후자는 서버도 RULE로 거부하지만 왕복 없이 이유를 보인다
  const commitBlocker: string | null =
    result === null || preview === null
      ? '양식 파일을 먼저 올리세요.'
      : preview.blocked
        ? (result.blockingReason ?? '반영할 수 없습니다.')
        : preview.counts.add + preview.counts.update === 0 && (!includeDeletes || preview.counts.deleteCandidates === 0)
          ? '반영할 변경이 없습니다'
          : null;

  return (
    <Modal
      open
      size="xl"
      closeOnBackdrop={false}
      title="목표 양식 올리기"
      description="[반영]을 누르기 전에는 아무것도 저장되지 않습니다. 모달을 닫으면 진행 상태는 폐기됩니다."
      // 진행 중에는 Esc·×로 닫히지 않게 한다 — 결과를 못 본 채 닫히면 무엇이 됐는지 알 수 없다
      onClose={() => {
        if (busy === null) onClose();
      }}
      footer={
        <>
          <span className="mr-auto text-t7 text-grey-500">
            {step === 'preview' && commitBlocker !== null && (
              <span className={preview?.blocked ? 'text-red-600' : 'text-grey-600'}>{commitBlocker}</span>
            )}
          </span>
          {step === 'done' ? (
            <Button variant="primary" onClick={onClose} disabled={busy !== null}>
              닫기
            </Button>
          ) : (
            <>
              <Button variant="ghost" onClick={onClose} disabled={busy !== null}>
                취소
              </Button>
              {step === 'preview' && (
                <Button
                  variant="secondary"
                  disabled={busy !== null}
                  onClick={() => {
                    setStep('pick');
                    setResult(null);
                    setIncludeDeletes(false);
                    setFailure(null);
                  }}
                >
                  다른 파일
                </Button>
              )}
              <Button
                variant="primary"
                onClick={() => void handleCommit()}
                disabled={busy !== null || commitBlocker !== null}
                title={commitBlocker ?? undefined}
              >
                반영
              </Button>
            </>
          )}
        </>
      }
    >
      <div className="space-y-4">
        {file && (
          <p className="text-t7 text-grey-400">
            {file.name} ({formatBytes(file.size)})
          </p>
        )}

        {busy && (
          <p
            role="status"
            className="flex items-center gap-2 rounded-lg border border-blue-200 bg-blue-50 px-3 py-2 text-t6 text-blue-800"
          >
            <span className="inline-block h-3 w-3 animate-spin rounded-full border-2 border-blue-300 border-t-blue-700" />
            {busy}
          </p>
        )}

        {failure && <ErrorBanner message={failure.message} code={failure.code} onDismiss={() => setFailure(null)} />}

        {/* ① 파일 선택 */}
        {step === 'pick' && (
          <div className="rounded-xl border-2 border-dashed border-grey-300 bg-surface p-8 text-center">
            <p className="text-t6 font-semibold text-grey-700">[양식 내려받기]로 받아 목표를 고친 파일을 선택하세요</p>
            <p className="mt-1 text-t7 text-grey-500">.xlsx · 최대 10MB</p>
            <p className="mt-1 text-t7 text-grey-400">
              기존 행은 숨김 id로 찾아 변경하고, 새 줄은 추가합니다. 양식에서 지운 행은 [삭제 포함]을 켜야 지워집니다.
            </p>
            <button
              type="button"
              disabled={busy !== null}
              onClick={() => inputRef.current?.click()}
              className="mt-4 rounded-lg bg-blue-500 px-4 py-2 text-t6 font-semibold text-white transition hover:bg-blue-600 disabled:cursor-not-allowed disabled:opacity-50"
            >
              파일 선택
            </button>
            <input
              ref={inputRef}
              type="file"
              accept={ACCEPT_ATTRIBUTE}
              className="hidden"
              onChange={(e) => {
                void handleFile(e.target.files?.[0]);
                // 같은 파일을 다시 골라도 change가 발생하도록 비운다
                e.target.value = '';
              }}
            />
          </div>
        )}

        {/* ② 미리보기 */}
        {step === 'preview' && result !== null && preview !== null && rates !== null && (
          <>
            <GoalPreviewPanel
              preview={preview}
              rates={rates}
              placeOf={rowPlace}
              showDeletes
              includeDeletes={includeDeletes}
              onToggleDeletes={setIncludeDeletes}
              disabled={busy !== null}
            />

            <p className="rounded-xl border border-orange-300 bg-orange-50 px-3 py-2 text-t7 text-orange-900">
              {IRREVERSIBLE_NOTICE}
            </p>
          </>
        )}

        {/* ③ 결과 */}
        {step === 'done' && committed !== null && (
          <div className="space-y-2">
            <div
              role="status"
              className="rounded-xl border border-green-300 bg-green-50 px-3 py-2 text-t7 text-green-900"
            >
              <p className="font-semibold">목표 양식을 반영했습니다.</p>
              <ul className="mt-1 space-y-0.5 tabular-nums">
                {GOAL_FORM_KINDS.map((kind) => {
                  const c = {
                    deliverable: committed.deliverables,
                    achievement: committed.achievements,
                    techTarget: committed.techTargets,
                    record: committed.records,
                  }[kind];
                  return (
                    <li key={kind}>
                      {GOAL_SHEET_LABELS[kind]} — 추가 {c.added} · 변경 {c.updated} · 삭제 {c.deleted}
                    </li>
                  );
                })}
              </ul>
            </div>
            {committed.previewConflicts.length > 0 && (
              <GoalConflictList
                title={`미리보기에서 충돌로 판정돼 건너뛴 행 ${committed.previewConflicts.length}건`}
                conflicts={committed.previewConflicts}
                labels={conflictLabels}
              />
            )}
            {/* O-1: 미리보기 뒤 반영 사이에 바뀐 행. DB가 센 것이라 미리보기에는 없던 목록이다 */}
            {committed.conflicts.length > 0 && (
              <GoalConflictList
                title={`반영 중 충돌로 건너뛴 행 ${committed.conflicts.length}건 (미리보기 뒤 다른 경로로 바뀜)`}
                conflicts={committed.conflicts}
                labels={conflictLabels}
              />
            )}
            {committed.skippedDeletes > 0 && (
              <p className="rounded-xl border border-grey-200 bg-grey-50 px-3 py-2 text-t7 text-grey-600">
                [삭제 포함]이 꺼져 있어 삭제 후보 {committed.skippedDeletes}건은 지우지 않았습니다. 지우려면 같은 파일을
                다시 올려 [삭제 포함]을 켜고 반영하세요.
              </p>
            )}
            <p className="text-t7 text-grey-400">{IRREVERSIBLE_NOTICE} 닫으면 목표 표가 새 값으로 그려집니다.</p>
          </div>
        )}
      </div>
    </Modal>
  );
}
