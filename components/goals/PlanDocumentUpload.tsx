'use client';

// 계획서(hwpx) 가져오기 모달 — 파일 → (브라우저) 표 추출 → 미리보기 → 반영 (SOT §7.7, §6.18 HX-1·HX-3·HX-8)
//
//  - 파일은 서버로 보내지 않는다(HX-1). 계획서는 이미지 때문에 100MB급이라 서버 액션 본문 한도를 넘는다 —
//    브라우저가 section XML만 풀어 표 격자를 뽑고, 서명이 맞는 표의 격자만 보낸다
//  - 추출은 메인 스레드에서 동기로 돈다(Worker는 실측 1.5초 초과 시에만, S-24). 단계 사이에 한 번씩 양보해
//    진행 표시가 실제로 그려지게 한다 — 안 그러면 큰 파일에서 화면이 멈춘 것처럼 보인다
//  - 상한 초과·목표 표 없음은 서버를 부르기 전에 끊는다(§9 S-14, S-28). 서버도 같은 판정을 다시 한다
//  - 삭제 후보가 없다(HX-8) — [삭제 포함] 토글을 두지 않는다
//  - 미리보기 뒤 다른 사람이 고쳐도 덮어쓴다(U-10) — commit이 그 시점 DB로 다시 계산한다
//  - 충돌·반영 제외·표 수준 경고는 목록 그대로 보인다 — 빠진 사실이 안 보이면 반영된 줄 안다 (절대 규칙 5)
//
// 행 해석(lib/hwpx/rows.ts)·lib/goal-form은 서버 전용이다 — 여기서는 타입만 가져온다(S-33).

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ActionErrorCode } from '@/lib/db/errors';
import type { PlanCommitOutcome, PlanPreviewResult } from '@/actions/plan-document';
import { commitPlanTables, previewPlanTables } from '@/actions/plan-document';
import { extractHwpxTables } from '@/lib/hwpx/extract';
import { PLAN_ISSUES, PLAN_TABLE_LABELS, type PlanIssue, type PlanIssueKind } from '@/lib/hwpx/issues';
import { checkPlanPayload } from '@/lib/hwpx/limits';
import { identifyPlanTables, selectPayloadTables } from '@/lib/hwpx/tables';
import type { PlanDocumentPayload, PlanTableKind } from '@/lib/hwpx/types';
import { readHwpxSections } from '@/lib/hwpx/zip';
import Button from '@/components/ui/Button';
import ErrorBanner from '@/components/ui/ErrorBanner';
import Modal from '@/components/ui/Modal';
import { setRealtimePaused } from '@/components/RealtimeRefresher';
import { formatBytes } from '@/components/budget/import/wizard-state';
import GoalPreviewPanel, {
  GOAL_SHEET_LABELS,
  GoalConflictList,
  buildGoalConflictLabels,
  type GoalRowPlace,
} from '@/components/goals/GoalPreviewPanel';

/** HX-1: hwpx만. .hwp·PDF는 readHwpxSections가 "hwpx로 저장해 다시 올려 주세요"로 거부한다 */
const ACCEPT_ATTRIBUTE = '.hwpx';

/** GF-11·U-11. 반영 전(미리보기)과 반영 후(결과)에 같은 문장을 보인다 */
const IRREVERSIBLE_NOTICE =
  "계획서 반영은 되돌릴 수 없습니다 — 설정 화면 스냅샷에 '계획서(hwpx)'로 남습니다 (복원 불가, GF-11).";

const TABLE_KINDS: readonly PlanTableKind[] = ['tech', 'deliverable', 'method'];

/** 요약(summary 슬롯)이 이미 종류별로 보이는 사유 — extra 목록에 다시 싣지 않는다 */
const SUMMARIZED_ISSUE_KINDS: ReadonlySet<PlanIssueKind> = new Set<PlanIssueKind>([
  'table-not-found',
  'duplicate-table',
  'unread-column',
]);

const UNREAD_REASON_LABELS = {
  ignored: '읽지 않기로 정한 열',
  unknown: '역할을 정하지 못함',
  duplicate: '같은 역할의 열이 앞에 있음',
} as const;

/** 진행 단계(§7.7 "진행 표시"). 앞의 셋은 브라우저, 마지막만 서버다 */
const STAGES = ['파일 읽기', '압축 해제', '표 찾기', '서버 미리보기'] as const;

type Step = 'pick' | 'preview' | 'done';

interface Failure {
  message: string;
  code?: ActionErrorCode;
}

/**
 * 진행 표시가 그려질 틈을 준다. rAF 뒤 setTimeout이어야 다음 동기 작업 전에 한 번 칠해진다 —
 * setTimeout 0만으로는 브라우저가 페인트를 건너뛸 수 있다
 */
function yieldToPaint(): Promise<void> {
  return new Promise((resolve) => {
    requestAnimationFrame(() => setTimeout(resolve, 0));
  });
}

/** 결과 문장. 부모의 결과 알림에도 같은 문장을 쓴다. 건수는 RPC가 실제로 반영한 수다 */
function commitMessage(result: PlanCommitOutcome): string {
  const parts = [
    `${GOAL_SHEET_LABELS.techTarget} 추가 ${result.techTargets.added} · 변경 ${result.techTargets.updated}`,
    `${GOAL_SHEET_LABELS.deliverable} 추가 ${result.deliverables.added} · 변경 ${result.deliverables.updated}`,
  ];
  const skipped = result.previewConflicts.length + result.conflicts.length;
  return `계획서(hwpx) 반영 — ${parts.join(' / ')}${skipped > 0 ? ` · 충돌 ${skipped}건 건너뜀` : ''}`;
}

export interface PlanDocumentUploadProps {
  projectId: string;
  onClose: () => void;
  /** 반영 성공 직후. 부모는 결과 알림을 띄우고 router.refresh()로 목표 표를 다시 그린다 */
  onDone: (message: string) => void;
}

export default function PlanDocumentUpload({ projectId, onClose, onDone }: PlanDocumentUploadProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [step, setStep] = useState<Step>('pick');
  const [file, setFile] = useState<{ name: string; size: number } | null>(null);
  // commit은 미리보기와 같은 격자를 다시 보낸다 — 서버가 해시로 대조한다(S-13)
  const [payload, setPayload] = useState<PlanDocumentPayload | null>(null);
  const [result, setResult] = useState<PlanPreviewResult | null>(null);
  // 추출이 구조 불일치로 건너뛴 표. 서버는 격자만 받아 이 사실을 모르므로 클라이언트가 보인다(HX-2)
  const [extractIssues, setExtractIssues] = useState<PlanIssue[]>([]);
  const [committed, setCommitted] = useState<PlanCommitOutcome | null>(null);
  /** 진행 중인 STAGES 인덱스. null이면 파일 처리 중이 아니다 */
  const [stage, setStage] = useState<number | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [failure, setFailure] = useState<Failure | null>(null);

  // R-4: 모달이 열려 있는 동안 자동 새로고침을 보류해 미리보기·반영 흐름을 지킨다
  useEffect(() => {
    setRealtimePaused(true);
    return () => setRealtimePaused(false);
  }, []);

  function reset(): void {
    setStep('pick');
    setPayload(null);
    setResult(null);
    setExtractIssues([]);
    setFailure(null);
  }

  async function handleFile(picked: File | null | undefined): Promise<void> {
    if (!picked) return;
    reset();
    setFile({ name: picked.name, size: picked.size });
    setBusy('계획서를 처리하는 중입니다…');
    try {
      setStage(0);
      await yieldToPaint();
      const bytes = new Uint8Array(await picked.arrayBuffer());

      setStage(1);
      await yieldToPaint();
      const unzipped = readHwpxSections(bytes, picked.name);
      if (!unzipped.ok) {
        setFailure({ message: unzipped.message, code: 'VALIDATION' });
        return;
      }

      setStage(2);
      await yieldToPaint();
      // 표 태그 짝이 안 맞으면 extract가 던진다 — catch에서 문구 그대로 보인다
      const extracted = extractHwpxTables(unzipped.sections);
      const identified = identifyPlanTables(extracted.tables, extracted.skipped);
      if (identified.tech === null && identified.deliverable === null) {
        // S-28: 기술목표·성과목표 표가 둘 다 없으면 서버를 부르지 않는다
        const notFound = identified.issues
          .filter((issue) => issue.kind === 'table-not-found' || issue.kind === 'no-goal-tables')
          .map((issue) => issue.message);
        setFailure({ message: notFound.join(' / ') || PLAN_ISSUES['table-not-found'].message, code: 'RULE' });
        return;
      }
      const nextPayload: PlanDocumentPayload = { fileName: picked.name, tables: selectPayloadTables(extracted) };
      const check = checkPlanPayload(nextPayload);
      if (!check.ok) {
        setFailure({ message: check.reason, code: 'VALIDATION' });
        return;
      }

      setStage(3);
      await yieldToPaint();
      const res = await previewPlanTables(projectId, nextPayload);
      if (!res.ok) {
        setFailure({ message: res.error, code: res.code });
        return;
      }
      setPayload(nextPayload);
      setExtractIssues(identified.issues.filter((issue) => issue.kind === 'structure-mismatch'));
      setResult(res.data);
      setStep('preview');
    } catch (e) {
      // 절대 규칙 5: 추출 실패(표 태그 짝 불일치·XML 오류)는 원인 문구 그대로 보인다
      console.error('[PlanDocumentUpload] 계획서 추출 실패:', e);
      setFailure({ message: e instanceof Error ? e.message : '계획서를 읽지 못했습니다.' });
    } finally {
      setStage(null);
      setBusy(null);
    }
  }

  async function handleCommit(): Promise<void> {
    if (payload === null || result === null || commitBlocker !== null || committed !== null) return;
    setBusy('계획서를 반영하는 중입니다…');
    setFailure(null);
    try {
      const res = await commitPlanTables(projectId, payload, result.tablesHash);
      if (!res.ok) {
        setFailure({ message: res.error, code: res.code });
        return;
      }
      setCommitted(res.data);
      setStep('done');
      onDone(commitMessage(res.data));
    } catch (e) {
      // 액션 호출 자체가 던지면(네트워크 단절 등) 반영이 됐는지 알 수 없다 — 조용히 멈추지 않고 확인을 요청한다
      setFailure({ message: `서버와 통신하지 못했습니다 — 반영 여부를 목표 화면에서 확인한 뒤 다시 시도하세요 (${e instanceof Error ? e.message : String(e)})` });
    } finally {
      setBusy(null);
    }
  }

  const preview = result?.preview ?? null;

  // S-10: 계획서 표 기준 위치. 서버가 만든 문구를 쓰고, 없으면 표 행 번호만이라도 적는다
  const placeOf = useCallback<GoalRowPlace>(
    (row) => {
      const map =
        row.kind === 'techTarget'
          ? result?.locations.techTargets
          : row.kind === 'deliverable'
            ? result?.locations.deliverables
            : undefined;
      return map?.[row.sheetRow] ?? `${GOAL_SHEET_LABELS[row.kind]} 표 ${row.sheetRow}행`;
    },
    [result]
  );

  // 결과 화면의 충돌 목록도 미리보기 행으로 이름을 붙인다 — 패널이 내려간 뒤에도 필요해 여기서 만든다
  const conflictLabels = useMemo(
    () => (preview === null ? new Map<string, string>() : buildGoalConflictLabels(preview, placeOf)),
    [preview, placeOf]
  );

  const commitBlocker: string | null =
    result === null || preview === null
      ? '계획서 파일을 먼저 올리세요.'
      : preview.blocked
        ? (result.blockingReason ?? '반영할 수 없습니다.')
        : preview.counts.add + preview.counts.update === 0
          ? '반영할 변경이 없습니다 — 계획서의 목표가 이미 모두 반영돼 있습니다'
          : null;

  const tableIssues = useMemo(
    () => [
      ...extractIssues,
      ...(result?.planIssues ?? []).filter((issue) => !SUMMARIZED_ISSUE_KINDS.has(issue.kind)),
    ],
    [extractIssues, result]
  );

  return (
    <Modal
      open
      size="xl"
      closeOnBackdrop={false}
      title="계획서(hwpx) 가져오기"
      description="계획서의 기술목표·성과목표·평가방법 표를 읽어 목표에 반영합니다. 파일은 서버로 올리지 않고 표만 보냅니다. [반영]을 누르기 전에는 아무것도 저장되지 않습니다."
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
                <Button variant="secondary" disabled={busy !== null} onClick={reset}>
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
          <div
            role="status"
            className="rounded-lg border border-blue-200 bg-blue-50 px-3 py-2 text-t6 text-blue-800"
          >
            <p className="flex items-center gap-2">
              <span className="inline-block h-3 w-3 animate-spin rounded-full border-2 border-blue-300 border-t-blue-700" />
              {busy}
            </p>
            {stage !== null && (
              <ol className="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-t7">
                {STAGES.map((label, i) => (
                  <li
                    key={label}
                    className={
                      i < stage ? 'text-blue-600' : i === stage ? 'font-semibold text-blue-900' : 'text-grey-400'
                    }
                  >
                    {i + 1}. {label}{i < stage ? ' 완료' : ''}
                  </li>
                ))}
              </ol>
            )}
          </div>
        )}

        {failure && <ErrorBanner message={failure.message} code={failure.code} onDismiss={() => setFailure(null)} />}

        {/* ① 파일 선택 */}
        {step === 'pick' && (
          <div className="rounded-xl border-2 border-dashed border-grey-300 bg-surface p-8 text-center">
            <p className="text-t6 font-semibold text-grey-700">연구개발계획서 hwpx 파일을 선택하세요</p>
            <p className="mt-1 text-t7 text-grey-500">.hwpx만 — .hwp·PDF는 한글에서 hwpx로 저장해 올리세요</p>
            <p className="mt-1 text-t7 text-grey-400">
              목표 이름이 같은 기존 행은 변경하고, 없는 행은 추가합니다. 계획서에 없는 목표는 지우지 않습니다.
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
        {step === 'preview' && result !== null && preview !== null && (
          <>
            <GoalPreviewPanel
              preview={preview}
              rates={result.rates}
              placeOf={placeOf}
              showDeletes={false}
              includeDeletes={false}
              onToggleDeletes={() => undefined}
              disabled={busy !== null}
              fixHint="계획서를 고친 뒤 hwpx로 저장해 다시 올리세요."
              summary={<PlanTableSummaryView summary={result.tableSummary} />}
              extra={<PlanExtraView excluded={result.excluded} issues={tableIssues} />}
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
              <p className="font-semibold">계획서를 반영했습니다.</p>
              <ul className="mt-1 space-y-0.5 tabular-nums">
                <li>
                  {GOAL_SHEET_LABELS.techTarget} — 추가 {committed.techTargets.added} · 변경{' '}
                  {committed.techTargets.updated}
                </li>
                <li>
                  {GOAL_SHEET_LABELS.deliverable} — 추가 {committed.deliverables.added} · 변경{' '}
                  {committed.deliverables.updated}
                </li>
              </ul>
            </div>
            {committed.previewConflicts.length > 0 && (
              <GoalConflictList
                title={`미리보기에서 충돌로 판정돼 건너뛴 행 ${committed.previewConflicts.length}건`}
                conflicts={committed.previewConflicts}
                labels={conflictLabels}
              />
            )}
            {committed.conflicts.length > 0 && (
              <GoalConflictList
                title={`반영 중 충돌로 건너뛴 행 ${committed.conflicts.length}건`}
                conflicts={committed.conflicts}
                labels={conflictLabels}
              />
            )}
            <p className="text-t7 text-grey-400">{IRREVERSIBLE_NOTICE} 닫으면 목표 표가 새 값으로 그려집니다.</p>
          </div>
        )}
      </div>
    </Modal>
  );
}

// ─── 찾은 표 요약 (summary 슬롯) ───────────────────────────────────────────────

function PlanTableSummaryView({ summary }: { summary: PlanPreviewResult['tableSummary'] }) {
  return (
    <div className="rounded-xl border border-grey-200 px-3 py-2 text-t7">
      <p className="font-semibold text-grey-700">찾은 표</p>
      <ul className="mt-1 space-y-1.5">
        {TABLE_KINDS.map((kind) => {
          const s = summary[kind];
          return (
            <li key={kind}>
              {s.found ? (
                <p className="text-grey-700">
                  <span className="font-semibold">{PLAN_TABLE_LABELS[kind]}</span> — {s.dataRows}행
                  {s.pieces > 1 && <span className="text-grey-500"> (쪽 나뉨 {s.pieces}조각을 이음)</span>}
                </p>
              ) : (
                <p className="text-orange-700">
                  <span className="font-semibold">{PLAN_TABLE_LABELS[kind]}</span> — {PLAN_ISSUES['table-not-found'].message}
                  {kind === 'method' ? ' (평가방법 상세·평가환경은 기존 값 유지)' : ''}
                </p>
              )}
              {s.duplicateNote !== null && <p className="text-orange-700">{s.duplicateNote}</p>}
              {s.unreadColumns.length > 0 && (
                <details className="mt-0.5 text-grey-500">
                  <summary className="cursor-pointer">읽지 않은 열 {s.unreadColumns.length}개</summary>
                  <ul className="mt-1 list-disc space-y-0.5 pl-5">
                    {s.unreadColumns.map((col) => (
                      <li key={col.col}>
                        {col.col + 1}열 {col.header === '' ? '(머리 없음)' : `"${col.header}"`} —{' '}
                        {UNREAD_REASON_LABELS[col.reason]}
                      </li>
                    ))}
                  </ul>
                </details>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

// ─── 반영 제외 행·표 수준 경고 (extra 슬롯) ───────────────────────────────────

function PlanExtraView({ excluded, issues }: { excluded: PlanPreviewResult['excluded']; issues: PlanIssue[] }) {
  if (excluded.length === 0 && issues.length === 0) return null;
  return (
    <>
      {excluded.length > 0 && (
        <div className="rounded-xl border border-grey-200 bg-grey-50 px-3 py-2 text-t7 text-grey-700">
          <p className="font-semibold">반영 제외 {excluded.length}행 — 건수·달성률에 넣지 않습니다</p>
          <ul className="mt-1 space-y-0.5">
            {excluded.map((row) => (
              <li key={`${row.table}:${row.tableRow}`}>
                {PLAN_TABLE_LABELS[row.table]} {row.tableRow}행 · {row.name}
                {row.unit !== '' && ` (${row.unit})`} — {row.reason}
              </li>
            ))}
          </ul>
        </div>
      )}
      {issues.length > 0 && (
        <div className="rounded-xl border border-orange-300 bg-orange-50 px-3 py-2 text-t7 text-orange-900">
          <p className="font-semibold">표 확인 필요 {issues.length}건</p>
          <ul className="mt-1 list-disc space-y-0.5 pl-5">
            {issues.map((issue, i) => (
              <li key={i} className={issue.blocking ? 'font-semibold text-red-700' : undefined}>
                {issue.message}
              </li>
            ))}
          </ul>
        </div>
      )}
    </>
  );
}
