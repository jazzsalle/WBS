'use client';

// 수행 양식 올리기 모달 — 파일 → 미리보기 → 반영 (SOT §7.9.7 수행 모드, §6.16 IN-9~IN-11·IN-14)
//
//  - 제안 모드 모달(InputFormUpload)과 흐름은 같지만 반영의 뜻이 다르다: 연차·비목 교체가 아니라
//    집행 행의 **id 기반** 추가·변경·(선택)삭제다(IN-10). 그래서 파일을 나눴다 — 한 모달에 두 계약을 섞으면
//    "삭제"가 교체 비목의 산출근거인지 집행 삭제 후보인지 화면이 구분하지 못한다
//  - **[삭제 포함]은 기본 꺼짐**(IN-10). 집행은 되돌리기 어려운 실적이라 사용자가 목록을 보고 켜야 지운다.
//    집행률 전후는 토글에 따라 summary / summaryWithDeletes를 바꿔 보일 뿐 서버를 다시 부르지 않는다
//  - 충돌(내려받은 뒤 다른 경로로 바뀐 행)은 반영을 막지 않고 그 행만 건너뛴다. 미리보기에서도, 반영 결과에서도
//    목록을 그대로 보인다 — 건너뛴 사실이 안 보이면 사용자는 반영된 줄 안다 (절대 규칙 5)
//  - 막는 것은 `blocked`(오류 행·파일 문제)와 "반영할 변경 없음"뿐이다. 경고·B-2 초과는 알림이다 (PL-15·RL-1)
//  - 미리보기와 반영은 서버에서 같은 파싱 경로를 탄다(IN-6). 여기서는 fileHash를 되돌려 대조할 뿐이다 (O-4)
//
// 파싱·판정은 전부 actions/input-form.ts가 한다 — SheetJS를 클라이언트에서 import하지 않는다 (I-13).

import { useEffect, useMemo, useRef, useState } from 'react';
import type { BudgetCategory, Settings } from '@/types';
import type { ActionErrorCode } from '@/lib/db/errors';
import type {
  ExecutionFormCommitOutcome,
  ExecutionFormPreviewResult,
  ExecutionFormPreviewRowView,
} from '@/actions/input-form';
import type { ExecutionConflictReason, ExecutionField, ExecutionYearSummary } from '@/lib/input-form';
import { commitExecutionForm, previewInputForm } from '@/actions/input-form';
import { BUDGET_CATEGORY_LABELS } from '@/lib/constants';
import { formatAmount } from '@/lib/currency';
import { formatRate } from '@/lib/goals';
import Badge, { type BadgeTone } from '@/components/ui/Badge';
import Button from '@/components/ui/Button';
import ErrorBanner from '@/components/ui/ErrorBanner';
import Modal from '@/components/ui/Modal';
import { setRealtimePaused } from '@/components/RealtimeRefresher';
import { MAX_UPLOAD_BYTES, buildFormData, formatBytes } from '@/components/budget/import/wizard-state';

/** IN-8: 양식은 xlsx만 */
const ACCEPT_ATTRIBUTE = '.xlsx';

/** 추가·변경 행 목록은 이 수를 넘으면 접는다 — 요약이 먼저고 목록은 확인용이다 */
const ROW_LIST_FOLD = 12;

const SHEET_LABELS: Record<ExecutionFormPreviewRowView['sheet'], string> = {
  personnel: '인건비',
  budget: '사업비',
};

const AXIS_LABELS = { cash: '현금', in_kind: '현물' } as const;

const FIELD_LABELS: Record<ExecutionField, string> = {
  date: '집행일',
  amount: '금액',
  description: '품명',
  note: '비고',
  subcategoryCode: '세목',
  spec: '규격',
  unitPrice: '단가',
  factors: '인자',
  axis: '현금/현물',
  memberId: '인력',
  detailId: '산출근거',
};

const CONFLICT_LABELS: Record<ExecutionConflictReason, string> = {
  changed: '내려받은 뒤 다른 경로로 바뀜',
  deleted: '이미 삭제됨',
};

const STATUS_PRESENTATION = {
  add: { label: '추가', tone: 'green' },
  update: { label: '변경', tone: 'blue' },
} as const satisfies Record<'add' | 'update', { label: string; tone: BadgeTone }>;

/** 사용자가 되풀이해 볼 안내라 한 곳에 둔다 — 미리보기와 결과가 같은 문장을 써야 한다 */
const CONFLICT_GUIDE = '내려받은 뒤 바뀐 행 — 다시 내려받아 고치세요';

type Step = 'pick' | 'preview' | 'done';

interface Failure {
  message: string;
  code?: ActionErrorCode;
}

interface ConflictItem {
  id: string;
  reason: ExecutionConflictReason;
}

/** 업로드 전에 막을 이유. 서버도 거부하지만 왕복 없이 알려 준다 (I-15) */
function rejectReason(file: File): string | null {
  if (!file.name.toLowerCase().endsWith('.xlsx')) {
    return '입력 양식은 .xlsx 파일만 올릴 수 있습니다. [입력 양식 내려받기]로 받은 파일을 그대로 올리세요.';
  }
  if (file.size > MAX_UPLOAD_BYTES) {
    return `파일이 ${formatBytes(file.size)}로 상한 10MB를 넘습니다.`;
  }
  if (file.size === 0) return '빈 파일입니다.';
  return null;
}

/** 결과 문장. 부모의 결과 알림에도 같은 문장을 쓴다. 건수는 RPC가 실제로 반영한 수다 */
function commitMessage(result: ExecutionFormCommitOutcome): string {
  const skipped = result.previewConflicts.length + result.commitConflicts.length;
  const parts = [`집행 추가 ${result.added}건 · 변경 ${result.updated}건 · 삭제 ${result.deleted}건 반영`];
  if (skipped > 0) parts.push(`충돌 ${skipped}건 건너뜀`);
  if (result.skippedDeletes > 0) parts.push(`삭제 후보 ${result.skippedDeletes}건 유지`);
  return parts.join(' · ');
}

export interface ExecutionFormUploadProps {
  projectId: string;
  /** 화면 표시 단위. 파일과 서버는 언제나 원 단위 정수다 */
  currencyUnit: Settings['currencyUnit'];
  onClose: () => void;
  /** 반영 성공 직후. 부모는 결과 알림을 띄우고 router.refresh()로 매트릭스를 다시 그린다 */
  onDone: (message: string) => void;
}

export default function ExecutionFormUpload({ projectId, currencyUnit, onClose, onDone }: ExecutionFormUploadProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [step, setStep] = useState<Step>('pick');
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<ExecutionFormPreviewResult | null>(null);
  const [committed, setCommitted] = useState<ExecutionFormCommitOutcome | null>(null);
  // IN-10: 기본 꺼짐. 파일을 새로 고르면 다시 꺼진다 — 앞 파일에서 켠 선택이 새 삭제 후보에 넘어가면 안 된다
  const [includeDeletes, setIncludeDeletes] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [failure, setFailure] = useState<Failure | null>(null);
  const [showAllRows, setShowAllRows] = useState(false);

  // R-4: 모달이 열려 있는 동안 자동 새로고침을 보류해 미리보기·반영 흐름을 지킨다
  useEffect(() => {
    setRealtimePaused(true);
    return () => setRealtimePaused(false);
  }, []);

  async function handleFile(picked: File | null | undefined): Promise<void> {
    if (!picked) return;
    const reason = rejectReason(picked);
    if (reason) {
      setFailure({ message: reason, code: 'VALIDATION' });
      return;
    }
    setFile(picked);
    setPreview(null);
    setIncludeDeletes(false);
    setShowAllRows(false);
    setBusy('양식을 읽는 중입니다…');
    setFailure(null);
    try {
      const res = await previewInputForm(projectId, buildFormData(picked), 'execution');
      if (!res.ok) {
        // 절대 규칙 5: _meta 거부(IN-2)·mode 불일치(IN-9)·연차 경계 위반도 여기로 온다
        setFailure({ message: res.error, code: res.code });
        return;
      }
      setPreview(res.data);
      setStep('preview');
    } finally {
      setBusy(null);
    }
  }

  async function handleCommit(): Promise<void> {
    if (file === null || preview === null || commitBlocker !== null || committed !== null) return;
    setBusy('집행 내역을 반영하는 중입니다…');
    setFailure(null);
    try {
      // 액션은 스테이트리스라 파일을 다시 보낸다. fileHash로 미리보기와 같은 파일임을 대조한다 (IN-6).
      // 충돌 기준 version과 삭제 후보는 파일의 _meta가 정하므로 따로 넘기지 않는다 (IN-10)
      const res = await commitExecutionForm(projectId, buildFormData(file), preview.fileHash, includeDeletes);
      if (!res.ok) {
        setFailure({ message: res.error, code: res.code });
        return;
      }
      setCommitted(res.data);
      setStep('done');
      onDone(commitMessage(res.data));
    } finally {
      setBusy(null);
    }
  }

  const errorRows = useMemo(() => (preview?.rows ?? []).filter((row) => row.status === 'error'), [preview]);
  // 오류 행이 아닌데 막지 않는 문제가 붙은 행 (연차 기간 밖·금액 불일치 등, IN-11)
  const warningRows = useMemo(
    () =>
      (preview?.rows ?? []).filter(
        (row) => row.status !== 'error' && row.issues.some((issue) => !issue.blocking)
      ),
    [preview]
  );
  const changedRows = useMemo(
    () => (preview?.rows ?? []).filter((row) => row.status === 'add' || row.status === 'update'),
    [preview]
  );
  const visibleChangedRows = showAllRows ? changedRows : changedRows.slice(0, ROW_LIST_FOLD);
  const blockingFileIssues = (preview?.fileIssues ?? []).filter((issue) => issue.blocking);
  const warningFileIssues = (preview?.fileIssues ?? []).filter((issue) => !issue.blocking);

  // 충돌 id → 사용자가 알아볼 이름. 결과의 commitConflicts도 이 표로 이름을 붙인다 —
  // 반영 대상은 전부 미리보기 행이나 삭제 후보에서 왔으므로 id를 모르는 일은 없어야 하지만, 모르면 id를 그대로 보인다
  const conflictLabels = useMemo(() => {
    const map = new Map<string, string>();
    if (preview === null) return map;
    for (const row of preview.rows) {
      if (row.executionId !== null && !map.has(row.executionId)) {
        map.set(row.executionId, `${SHEET_LABELS[row.sheet]} ${row.rowIndex}행 · ${row.label}`);
      }
    }
    for (const candidate of preview.deleteCandidates) {
      if (!map.has(candidate.id)) map.set(candidate.id, `삭제 후보 · ${candidate.label}`);
    }
    return map;
  }, [preview]);

  const summary: ExecutionYearSummary | null =
    preview === null ? null : includeDeletes ? preview.summaryWithDeletes : preview.summary;

  // 막는 것: blocked, 그리고 반영할 것이 없을 때. 후자는 서버도 RULE로 거부하지만 왕복 없이 이유를 보인다
  const commitBlocker: string | null =
    preview === null
      ? '양식 파일을 먼저 올리세요.'
      : preview.blocked
        ? (preview.blockingReason ?? '반영할 수 없습니다.')
        : preview.counts.add + preview.counts.update === 0 &&
            (!includeDeletes || preview.counts.deleteCandidates === 0)
          ? '반영할 변경이 없습니다'
          : null;

  const changedCells = summary?.cells.filter((cell) => cell.before.executed !== cell.after.executed) ?? [];

  return (
    <Modal
      open
      size="xl"
      closeOnBackdrop={false}
      title="입력 양식 올리기 (수행)"
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
                    setPreview(null);
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
            {preview && <span className="ml-2">· 대상 연차 {preview.yearLabel}</span>}
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

        {failure && (
          <ErrorBanner message={failure.message} code={failure.code} onDismiss={() => setFailure(null)} />
        )}

        {/* ① 파일 선택 */}
        {step === 'pick' && (
          <div className="rounded-xl border-2 border-dashed border-grey-300 bg-surface p-8 text-center">
            <p className="text-t6 font-semibold text-grey-700">
              수행 모드에서 [입력 양식 내려받기]로 받아 집행 내역을 적은 파일을 선택하세요
            </p>
            <p className="mt-1 text-t7 text-grey-500">.xlsx · 최대 10MB</p>
            <p className="mt-1 text-t7 text-grey-400">
              금액 열은 입력값으로 읽고 집행일은 필수입니다. 기존 집행 행은 숨김 id로 찾아 변경하고, 새 줄은
              추가합니다. 양식에서 지운 행은 [삭제 포함]을 켜야 지워집니다.
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
        {step === 'preview' && preview !== null && summary !== null && (
          <>
            {/* IN-10: 추가 · 변경 · 유지 · 삭제 후보 · 충돌 */}
            <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5 rounded-xl border border-grey-200 bg-grey-50 px-3 py-2 text-t7">
              <span className="font-semibold text-grey-700">{preview.yearLabel}</span>
              <span className="text-grey-600">
                추가 <strong>{preview.counts.add}</strong>
              </span>
              <span className="text-grey-600">
                변경 <strong>{preview.counts.update}</strong>
              </span>
              <span className="text-grey-600">
                유지 <strong>{preview.counts.unchanged}</strong>
              </span>
              <span className="text-grey-600">
                삭제 후보 <strong>{preview.counts.deleteCandidates}</strong>
              </span>
              <span className={preview.counts.conflict > 0 ? 'text-orange-700' : 'text-grey-600'}>
                충돌 <strong>{preview.counts.conflict}</strong>
              </span>
              <span className={preview.counts.error > 0 ? 'text-red-600' : 'text-grey-600'}>
                오류 <strong>{preview.counts.error}</strong>
              </span>
              <span className="text-grey-600">
                경고 <strong>{preview.counts.warning}</strong>
              </span>
              {preview.blocked ? (
                <Badge tone="red">반영할 수 없음</Badge>
              ) : (
                <Badge tone="green">반영할 수 있습니다</Badge>
              )}
            </div>

            {/* 연차 집행률 전후 (§7.9.7). 서버가 계산한 값을 표시 단위로 환산만 한다 (B-4, O-4) */}
            <section className="space-y-1.5">
              <h3 className="text-t7 font-semibold text-grey-700">
                연차 집행률 전후{' '}
                <span className="font-normal text-grey-400">
                  ({includeDeletes ? '삭제 포함' : '삭제 제외'} 기준)
                </span>
              </h3>
              <div className="overflow-x-auto rounded-xl border border-grey-200">
                <table className="w-full text-t7">
                  <thead className="bg-grey-50 text-grey-600">
                    <tr>
                      <th className="px-3 py-1.5 text-left font-semibold">비목</th>
                      <th className="px-3 py-1.5 text-right font-semibold">예산</th>
                      <th className="px-3 py-1.5 text-right font-semibold">집행 (전 → 후)</th>
                      <th className="px-3 py-1.5 text-right font-semibold">집행률 (전 → 후)</th>
                    </tr>
                  </thead>
                  <tbody>
                    {changedCells.map((cell) => (
                      <tr key={cell.category} className="border-t border-grey-100 text-grey-700">
                        <td className="px-3 py-1.5">{BUDGET_CATEGORY_LABELS[cell.category]}</td>
                        <td className="px-3 py-1.5 text-right tabular-nums">
                          {formatAmount(cell.after.planned, currencyUnit)}
                        </td>
                        <td className="px-3 py-1.5 text-right tabular-nums">
                          {formatAmount(cell.before.executed, currencyUnit)} →{' '}
                          {formatAmount(cell.after.executed, currencyUnit)}
                        </td>
                        <td className="px-3 py-1.5 text-right tabular-nums">
                          {formatRate(cell.before.rate)} → {formatRate(cell.after.rate)}
                        </td>
                      </tr>
                    ))}
                    <tr className="border-t border-grey-200 bg-grey-50 font-semibold text-grey-900">
                      <td className="px-3 py-1.5">연차 합계</td>
                      <td className="px-3 py-1.5 text-right tabular-nums">
                        {formatAmount(summary.after.planned, currencyUnit)}
                      </td>
                      <td className="px-3 py-1.5 text-right tabular-nums">
                        {formatAmount(summary.before.executed, currencyUnit)} →{' '}
                        {formatAmount(summary.after.executed, currencyUnit)}
                      </td>
                      <td className="px-3 py-1.5 text-right tabular-nums">
                        {formatRate(summary.before.rate)} → {formatRate(summary.after.rate)}
                      </td>
                    </tr>
                  </tbody>
                </table>
              </div>
              {changedCells.length === 0 && (
                <p className="text-t7 text-grey-400">집행액이 바뀌는 비목이 없습니다.</p>
              )}
            </section>

            {/* B-2·B-1: 막지 않는다. 접어 숨기지도 않는다 — 보지 않고 지나간 경고는 없는 경고와 같다 */}
            {(summary.overCells.length > 0 || summary.offBudgetCells.length > 0) && (
              <div className="rounded-xl border border-orange-300 bg-orange-50 px-3 py-2 text-t7 text-orange-900">
                <p className="font-semibold">
                  예산을 넘는 집행이 있습니다. <strong>반영은 막지 않습니다</strong> — 이대로 반영됩니다.
                </p>
                <ul className="mt-2 space-y-1">
                  {summary.overCells.map((cell) => (
                    <li key={`over:${cell.category}`} className="rounded bg-orange-100/60 px-2 py-1">
                      <Badge tone={cell.newly ? 'red' : 'amber'}>{cell.newly ? '새로 초과' : '이미 초과'}</Badge>
                      <span className="ml-1 font-semibold">{BUDGET_CATEGORY_LABELS[cell.category]}</span>
                      <span className="ml-1">
                        — 집행률 {formatRate(cell.before.rate)} → {formatRate(cell.after.rate)} (예산{' '}
                        {formatAmount(cell.after.planned, currencyUnit)} · 집행{' '}
                        {formatAmount(cell.after.executed, currencyUnit)})
                      </span>
                    </li>
                  ))}
                  {summary.offBudgetCells.map((cell) => (
                    <li key={`off:${cell.category}`} className="rounded bg-orange-100/60 px-2 py-1">
                      <Badge tone="amber">예산 외 집행</Badge>
                      <span className="ml-1 font-semibold">{BUDGET_CATEGORY_LABELS[cell.category]}</span>
                      <span className="ml-1">
                        — 예산 0원에 집행 {formatAmount(cell.after.executed, currencyUnit)}
                      </span>
                    </li>
                  ))}
                </ul>
              </div>
            )}

            {/* 파일 단위 차단 문제 + 오류 행. 이것만이 반영을 막는다 */}
            {(blockingFileIssues.length > 0 || errorRows.length > 0) && (
              <div className="rounded-xl border border-red-200 bg-red-50 px-3 py-2 text-t7 text-red-700">
                <p className="font-semibold">
                  아래 {blockingFileIssues.length + errorRows.length}건 때문에 반영할 수 없습니다. 엑셀에서 고친 뒤
                  다시 올리세요.
                </p>
                <ul className="mt-2 space-y-1">
                  {blockingFileIssues.map((issue, index) => (
                    <li key={`file:${issue.kind}:${index}`} className="rounded bg-red-100/60 px-2 py-1">
                      <Badge tone="red">파일</Badge>
                      <span className="ml-1">{issue.message}</span>
                    </li>
                  ))}
                  {errorRows.map((row) => (
                    <li key={row.key} className="rounded bg-red-100/60 px-2 py-1">
                      <span className="font-semibold">
                        {SHEET_LABELS[row.sheet]} {row.rowIndex}행
                      </span>
                      <Badge tone="red" className="ml-1">
                        오류
                      </Badge>
                      <span className="ml-1">{row.label}</span>
                      <span className="ml-1">— {issueMessages(row)}</span>
                    </li>
                  ))}
                </ul>
              </div>
            )}

            {/* 막지 않는 문제 (IN-11: 연차 기간 밖·단가×인자 불일치 등) */}
            {(warningFileIssues.length > 0 || warningRows.length > 0) && (
              <div className="rounded-xl border border-orange-300 bg-orange-50 px-3 py-2 text-t7 text-orange-900">
                <p className="font-semibold">
                  확인할 내용 {warningFileIssues.length + warningRows.length}건이 있습니다. 반영은 막지 않습니다.
                </p>
                <ul className="mt-2 space-y-1">
                  {warningFileIssues.map((issue, index) => (
                    <li key={`file-warn:${issue.kind}:${index}`} className="rounded bg-orange-100/60 px-2 py-1">
                      <Badge tone="amber">파일</Badge>
                      <span className="ml-1">{issue.message}</span>
                    </li>
                  ))}
                  {warningRows.map((row) => (
                    <li key={`warn:${row.key}`} className="rounded bg-orange-100/60 px-2 py-1">
                      <span className="font-semibold">
                        {SHEET_LABELS[row.sheet]} {row.rowIndex}행
                      </span>
                      <Badge tone="amber" className="ml-1">
                        주의
                      </Badge>
                      <span className="ml-1">{row.label}</span>
                      <span className="ml-1">
                        —{' '}
                        {row.issues
                          .filter((issue) => !issue.blocking)
                          .map((issue) => issue.message)
                          .join(' · ')}
                      </span>
                    </li>
                  ))}
                </ul>
              </div>
            )}

            {/* IN-10 충돌: 반영에서 건너뛴다. 무엇이 빠지는지 반영 전에 보여 준다 */}
            {preview.conflicts.length > 0 && (
              <ConflictList
                title={`충돌 ${preview.conflicts.length}건 — 반영에서 건너뜁니다`}
                conflicts={preview.conflicts}
                labels={conflictLabels}
              />
            )}

            {/* IN-10 삭제 후보 + [삭제 포함] 토글(기본 꺼짐) */}
            {preview.deleteCandidates.length > 0 && (
              <section className="space-y-1.5">
                <div className="flex flex-wrap items-center gap-3">
                  <h3 className="text-t7 font-semibold text-grey-700">
                    삭제 후보 {preview.deleteCandidates.length}건{' '}
                    <span className="font-normal text-grey-400">— 양식에서 사라진 기존 집행</span>
                  </h3>
                  <label className="ml-auto inline-flex items-center gap-1.5 text-t7 font-semibold text-grey-700">
                    <input
                      type="checkbox"
                      checked={includeDeletes}
                      disabled={busy !== null || preview.counts.deleteCandidates === 0}
                      onChange={(e) => setIncludeDeletes(e.target.checked)}
                      className="h-4 w-4 rounded border-grey-300"
                    />
                    삭제 포함
                  </label>
                </div>
                <p className="text-t7 text-grey-500">
                  {includeDeletes
                    ? `켜짐 — 충돌이 아닌 ${preview.counts.deleteCandidates}건을 지웁니다.`
                    : '꺼짐 — 아무것도 지우지 않습니다. 집행은 되돌리기 어려운 실적이라 목록을 확인한 뒤 켜세요.'}
                </p>
                <ul className="divide-y divide-grey-100 rounded-xl border border-grey-200 text-t7">
                  {preview.deleteCandidates.map((candidate) => (
                    <li key={candidate.id} className="flex flex-wrap items-center gap-2 px-3 py-1.5 text-grey-700">
                      {candidate.conflict !== null ? (
                        <Badge tone="amber" title={CONFLICT_GUIDE}>
                          충돌 · {CONFLICT_LABELS[candidate.conflict]}
                        </Badge>
                      ) : (
                        <Badge tone={includeDeletes ? 'red' : 'neutral'}>
                          {includeDeletes ? '삭제' : '유지'}
                        </Badge>
                      )}
                      <span className="text-grey-500">{categoryLabel(candidate.category)}</span>
                      <span className="font-medium text-grey-800">{candidate.label}</span>
                      {candidate.date !== null && <span className="text-grey-400">{candidate.date}</span>}
                      <span className="ml-auto tabular-nums">
                        {candidate.amount === null ? '—' : formatAmount(candidate.amount, currencyUnit)}
                      </span>
                    </li>
                  ))}
                </ul>
              </section>
            )}

            {/* 추가·변경 행 */}
            {changedRows.length > 0 && (
              <section className="space-y-1.5">
                <h3 className="text-t7 font-semibold text-grey-700">추가·변경 행 {changedRows.length}건</h3>
                <ul className="divide-y divide-grey-100 rounded-xl border border-grey-200 text-t7">
                  {visibleChangedRows.map((row) => {
                    const presentation = STATUS_PRESENTATION[row.status as 'add' | 'update'];
                    return (
                      <li key={row.key} className="flex flex-wrap items-center gap-2 px-3 py-1.5 text-grey-700">
                        <Badge tone={presentation.tone}>{presentation.label}</Badge>
                        <span className="text-grey-400">
                          {SHEET_LABELS[row.sheet]} {row.rowIndex}행
                        </span>
                        <span className="text-grey-500">{categoryLabel(row.category)}</span>
                        <span className="font-medium text-grey-800">{row.label}</span>
                        {row.values !== null && <span className="text-grey-400">{row.values.date}</span>}
                        {row.values?.axis != null && <Badge tone="neutral">{AXIS_LABELS[row.values.axis]}</Badge>}
                        {row.copiedFrom !== null && (
                          <Badge tone="neutral" title="숨김 id가 복사된 행이라 새 집행으로 봅니다 (IN-10)">
                            복사 행
                          </Badge>
                        )}
                        <span className="ml-auto tabular-nums">
                          {row.values === null ? '—' : formatAmount(row.values.amount, currencyUnit)}
                        </span>
                        {row.status === 'update' && row.changedFields.length > 0 && (
                          <span className="w-full text-grey-400">
                            바뀐 항목: {row.changedFields.map((field) => FIELD_LABELS[field]).join(', ')}
                          </span>
                        )}
                      </li>
                    );
                  })}
                </ul>
                {changedRows.length > ROW_LIST_FOLD && (
                  <button
                    type="button"
                    onClick={() => setShowAllRows((value) => !value)}
                    className="text-t7 font-semibold text-blue-600 hover:text-blue-700"
                  >
                    {showAllRows ? '접기' : `나머지 ${changedRows.length - ROW_LIST_FOLD}행 더 보기`}
                  </button>
                )}
              </section>
            )}

            <p className="text-t7 text-grey-400">
              화면 금액은 표시 단위({currencyUnit})로 환산한 값입니다. 반영은 집행 행 단위(추가·변경·선택 삭제)이며
              스냅샷을 남깁니다(IN-10·IN-14).
            </p>
          </>
        )}

        {/* ③ 결과 */}
        {step === 'done' && committed !== null && (
          <div className="space-y-2">
            <p
              role="status"
              className="rounded-xl border border-green-300 bg-green-50 px-3 py-2 text-t6 text-green-900"
            >
              {commitMessage(committed)}
            </p>
            {committed.previewConflicts.length > 0 && (
              <ConflictList
                title={`미리보기에서 충돌로 판정돼 건너뛴 행 ${committed.previewConflicts.length}건`}
                conflicts={committed.previewConflicts}
                labels={conflictLabels}
              />
            )}
            {/* O-1: 미리보기 뒤 반영 사이에 바뀐 행. DB가 센 것이라 미리보기에는 없던 목록이다 */}
            {committed.commitConflicts.length > 0 && (
              <ConflictList
                title={`반영 중 충돌로 건너뛴 행 ${committed.commitConflicts.length}건 (미리보기 뒤 다른 경로로 바뀜)`}
                conflicts={committed.commitConflicts}
                labels={conflictLabels}
              />
            )}
            {committed.skippedDeletes > 0 && (
              <p className="rounded-xl border border-grey-200 bg-grey-50 px-3 py-2 text-t7 text-grey-600">
                [삭제 포함]이 꺼져 있어 삭제 후보 {committed.skippedDeletes}건은 지우지 않았습니다. 지우려면 같은
                파일을 다시 올려 [삭제 포함]을 켜고 반영하세요.
              </p>
            )}
            {/* IN-14 */}
            <p className="text-t7 text-grey-400">
              되돌리려면 설정 화면의 임포트 스냅샷에서 &lsquo;수행 양식&rsquo; 스냅샷을 복원하세요 — 이번 반영
              전체(추가·변경·삭제)가 되돌아갑니다. 닫으면 매트릭스가 새 값으로 그려집니다.
            </p>
          </div>
        )}
      </div>
    </Modal>
  );
}

function ConflictList({
  title,
  conflicts,
  labels,
}: {
  title: string;
  conflicts: readonly ConflictItem[];
  labels: ReadonlyMap<string, string>;
}) {
  return (
    <div className="rounded-xl border border-orange-300 bg-orange-50 px-3 py-2 text-t7 text-orange-900">
      <p className="font-semibold">{title}</p>
      <p className="mt-0.5">{CONFLICT_GUIDE}</p>
      <ul className="mt-2 space-y-1">
        {conflicts.map((conflict) => (
          <li key={`${conflict.id}:${conflict.reason}`} className="rounded bg-orange-100/60 px-2 py-1">
            <Badge tone="amber">{CONFLICT_LABELS[conflict.reason]}</Badge>
            <span className="ml-1">{labels.get(conflict.id) ?? `집행 ${conflict.id}`}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function categoryLabel(category: BudgetCategory | null): string {
  return category === null ? '(비목 미정)' : BUDGET_CATEGORY_LABELS[category];
}

/** 차단 issue를 앞에 둔다 — 반영을 막은 이유가 먼저 보여야 한다 */
function issueMessages(row: ExecutionFormPreviewRowView): string {
  const sorted = [...row.issues].sort((a, b) => Number(b.blocking) - Number(a.blocking));
  return sorted.length === 0 ? '사유 없음' : sorted.map((issue) => issue.message).join(' · ');
}
