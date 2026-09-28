'use client';

// 목표 양식 올리기 모달 — 파일 → 미리보기 → 반영 (SOT §7.7 [양식 올리기], §6.17 GF-5·GF-11)
//
//  - 수행 양식 모달(ExecutionFormUpload)과 같은 흐름이다: **id 기반** 추가·변경·(선택)삭제, 충돌은 그 행만 건너뜀
//  - **[삭제 포함]은 기본 꺼짐**(GF-5). 지표 삭제는 실적·측정 이력을 cascade로 지우고 작업 연계를 끊으므로
//    "실적 N · 측정 M · 연계 작업 K"를 보고 켜야 지운다. 달성률 전후는 토글에 따라 preview.rates /
//    ratesWithDeletes를 바꿔 보일 뿐 서버를 다시 부르지 않는다
//  - blocking 오류가 1건이라도 있으면 반영 버튼 비활성(부분 반영 없음, S-21). 경고는 막지 않는다
//  - 충돌은 미리보기에서도, 반영 결과에서도 목록을 그대로 보인다 — 건너뛴 사실이 안 보이면 반영된 줄 안다 (절대 규칙 5)
//  - 목표 양식 스냅샷은 복원할 수 없다(GF-11) — 반영 전에 알린다. 수행 양식 모달의 "스냅샷으로 되돌리기" 안내와 다르다
//
// 파싱·판정은 전부 actions/goal-form.ts가 한다 — SheetJS를 클라이언트에서 import하지 않는다 (I-13).

import { useEffect, useMemo, useRef, useState } from 'react';
import type { ActionErrorCode } from '@/lib/db/errors';
import type { GoalFormConflict, GoalFormKind } from '@/lib/db/import-snapshots';
import type { GoalFormCommitOutcome, GoalFormPreviewResult } from '@/actions/goal-form';
import type { GoalFormIssue } from '@/lib/goal-form/parse';
import type { GoalConflictReason, GoalPreviewRowStatus, GoalRates } from '@/lib/goal-form/preview';
import { commitGoalForm, previewGoalForm } from '@/actions/goal-form';
import { formatRate } from '@/lib/goals';
import Badge, { type BadgeTone } from '@/components/ui/Badge';
import Button from '@/components/ui/Button';
import ErrorBanner from '@/components/ui/ErrorBanner';
import Modal from '@/components/ui/Modal';
import { setRealtimePaused } from '@/components/RealtimeRefresher';
import { MAX_UPLOAD_BYTES, buildFormData, formatBytes } from '@/components/budget/import/wizard-state';

/** GF-1: 양식은 xlsx만 */
const ACCEPT_ATTRIBUTE = '.xlsx';

/** 추가·변경 행 목록은 이 수를 넘으면 접는다 — 요약이 먼저고 목록은 확인용이다 */
const ROW_LIST_FOLD = 12;

const KINDS: readonly GoalFormKind[] = ['deliverable', 'achievement', 'techTarget', 'record'];

/** 시트 이름 그대로(GF-1) — 사용자가 엑셀에서 찾아갈 이름이어야 한다 */
const SHEET_LABELS: Record<GoalFormKind, string> = {
  deliverable: '성과목표',
  achievement: '성과실적',
  techTarget: '기술목표',
  record: '측정이력',
};

const FIELD_LABELS: Record<string, string> = {
  type: '유형',
  name: '이름',
  unit: '단위',
  weight: '가중치·비중',
  targetTotal: '전체 목표',
  targetByYear: '연차별 목표',
  orgId: '책임기관',
  evidenceMethod: '평가방법',
  note: '비고',
  parent: '지표 연결',
  title: '산출물명',
  date: '날짜',
  yearId: '연차',
  memberIds: '관여자',
  evidenceUrl: '증빙 URL',
  group: '구분',
  direction: '방향',
  targetValue: '최종 목표',
  baselineDomestic: '국내수준',
  worldBest: '세계최고',
  worldBestHolder: '보유국·기관',
  measureMethod: '측정방법',
  measureDescription: '측정방법 상세',
  standardBasis: '표준·인증기준',
  basisRationale: '기준설정 근거',
  evaluationEnvironment: '평가환경',
  value: '측정값',
  method: '방법',
  evaluator: '평가기관',
};

const CONFLICT_LABELS: Record<GoalConflictReason, string> = {
  changed: '내려받은 뒤 다른 경로로 바뀜',
  deleted: '이미 삭제됨',
};

const STATUS_PRESENTATION = {
  add: { label: '추가', tone: 'green' },
  update: { label: '변경', tone: 'blue' },
} as const satisfies Record<'add' | 'update', { label: string; tone: BadgeTone }>;

/** 사용자가 되풀이해 볼 안내라 한 곳에 둔다 — 미리보기와 결과가 같은 문장을 써야 한다 */
const CONFLICT_GUIDE = '내려받은 뒤 바뀐 행 — 다시 내려받아 고치세요';

/** GF-11. 반영 전(미리보기)과 반영 후(결과)에 같은 문장을 보인다 */
const IRREVERSIBLE_NOTICE =
  '목표 양식 반영은 되돌릴 수 없습니다 — 설정 화면 스냅샷 목록에 "목표 양식"으로 남지만 복원할 수 없습니다 (GF-11).';

type Step = 'pick' | 'preview' | 'done';

interface Failure {
  message: string;
  code?: ActionErrorCode;
}

/** 네 시트의 행을 한 모양으로 편 것. 시트마다 values 모양이 달라 화면이 쓰는 것만 남긴다 */
interface RowView {
  kind: GoalFormKind;
  key: string;
  sheetRow: number;
  id: string | null;
  status: GoalPreviewRowStatus;
  label: string;
  changedFields: string[];
  copiedFrom: string | null;
  issues: GoalFormIssue[];
}

interface SheetCounts {
  add: number;
  update: number;
  unchanged: number;
  conflict: number;
  error: number;
  warning: number;
  deleteCandidates: number;
}

function toRowViews(preview: GoalFormPreviewResult['preview']): RowView[] {
  const { deliverables, achievements, techTargets, records } = preview.rows;
  type RowLike = Omit<RowView, 'label' | 'changedFields'> & { changedFields: readonly string[] };
  const common = (row: RowLike, label: string): RowView => ({
    kind: row.kind,
    key: row.key,
    sheetRow: row.sheetRow,
    id: row.id,
    status: row.status,
    label,
    changedFields: [...row.changedFields],
    copiedFrom: row.copiedFrom,
    issues: row.issues,
  });
  // values는 add·update·unchanged에서만 있다. 오류·충돌 행은 시트 행 번호로 찾아가게 한다
  return [
    ...deliverables.map((row) => common(row, row.values?.name ?? '')),
    ...achievements.map((row) => common(row, row.values?.title ?? '')),
    ...techTargets.map((row) => common(row, row.values?.name ?? '')),
    ...records.map((row) => common(row, row.values === null ? '' : `${row.values.date} · ${row.values.value}`)),
  ];
}

function rowPlace(row: Pick<RowView, 'kind' | 'sheetRow'>): string {
  return `${SHEET_LABELS[row.kind]} ${row.sheetRow}행`;
}

/** 오류·경고 행 판정은 행의 issues를 그대로 따른다 — 서버의 counts와 같은 기준이다 */
function isWarningRow(row: RowView): boolean {
  return row.status !== 'error' && row.issues.some((issue) => !issue.blocking);
}

function sheetCounts(
  rows: readonly RowView[],
  preview: GoalFormPreviewResult['preview']
): Record<GoalFormKind, SheetCounts> {
  const empty = (): SheetCounts => ({
    add: 0,
    update: 0,
    unchanged: 0,
    conflict: 0,
    error: 0,
    warning: 0,
    deleteCandidates: 0,
  });
  const result: Record<GoalFormKind, SheetCounts> = {
    deliverable: empty(),
    achievement: empty(),
    techTarget: empty(),
    record: empty(),
  };
  for (const row of rows) {
    result[row.kind][row.status] += 1;
    if (isWarningRow(row)) result[row.kind].warning += 1;
  }
  for (const candidate of preview.deleteCandidates) {
    if (candidate.conflict === null) result[candidate.kind].deleteCandidates += 1;
    else result[candidate.kind].conflict += 1;
  }
  return result;
}

/** 차단 issue를 앞에 둔다 — 반영을 막은 이유가 먼저 보여야 한다 */
function issueMessages(issues: readonly GoalFormIssue[], onlyWarnings = false): string {
  const picked = onlyWarnings ? issues.filter((issue) => !issue.blocking) : [...issues];
  const sorted = picked.sort((a, b) => Number(b.blocking) - Number(a.blocking));
  return sorted.length === 0 ? '사유 없음' : sorted.map((issue) => issue.message).join(' · ');
}

/** 결과 문장. 부모의 결과 알림에도 같은 문장을 쓴다. 건수는 RPC가 실제로 반영한 수다 */
function commitMessage(result: GoalFormCommitOutcome): string {
  const byKind = {
    deliverable: result.deliverables,
    achievement: result.achievements,
    techTarget: result.techTargets,
    record: result.records,
  } as const;
  const parts = KINDS.map(
    (kind) =>
      `${SHEET_LABELS[kind]} 추가 ${byKind[kind].added} · 변경 ${byKind[kind].updated} · 삭제 ${byKind[kind].deleted}`
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
  const [showAllRows, setShowAllRows] = useState(false);

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
    setShowAllRows(false);
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
    } finally {
      setBusy(null);
    }
  }

  const preview = result?.preview ?? null;
  const rows = useMemo(() => (preview === null ? [] : toRowViews(preview)), [preview]);
  const counts = useMemo(() => (preview === null ? null : sheetCounts(rows, preview)), [rows, preview]);
  const errorRows = rows.filter((row) => row.status === 'error');
  const warningRows = rows.filter(isWarningRow);
  const changedRows = rows.filter((row) => row.status === 'add' || row.status === 'update');
  const visibleChangedRows = showAllRows ? changedRows : changedRows.slice(0, ROW_LIST_FOLD);
  const blockingFileIssues = (preview?.issues ?? []).filter((issue) => issue.blocking);
  const warningFileIssues = (preview?.issues ?? []).filter((issue) => !issue.blocking);

  // 충돌 id → 사용자가 알아볼 이름. 결과의 RPC conflicts도 이 표로 이름을 붙인다 —
  // 반영 대상은 전부 미리보기 행이나 삭제 후보에서 왔으므로 모르는 id는 없어야 하지만, 모르면 id를 그대로 보인다
  const conflictLabels = useMemo(() => {
    const map = new Map<string, string>();
    for (const row of rows) {
      if (row.id !== null && !map.has(`${row.kind}:${row.id}`)) {
        map.set(`${row.kind}:${row.id}`, row.label === '' ? rowPlace(row) : `${rowPlace(row)} · ${row.label}`);
      }
    }
    for (const candidate of preview?.deleteCandidates ?? []) {
      const key = `${candidate.kind}:${candidate.id}`;
      if (!map.has(key)) {
        map.set(key, `삭제 후보 · ${SHEET_LABELS[candidate.kind]} · ${candidate.label === '' ? '(이미 없음)' : candidate.label}`);
      }
    }
    return map;
  }, [rows, preview]);

  const rates = result === null ? null : includeDeletes ? result.ratesWithDeletes : result.preview.rates;

  // 막는 것: blocked, 그리고 반영할 것이 없을 때. 후자는 서버도 RULE로 거부하지만 왕복 없이 이유를 보인다
  const commitBlocker: string | null =
    result === null || preview === null
      ? '양식 파일을 먼저 올리세요.'
      : preview.blocked
        ? (result.blockingReason ?? '반영할 수 없습니다.')
        : preview.counts.add + preview.counts.update === 0 &&
            (!includeDeletes || preview.counts.deleteCandidates === 0)
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
        {step === 'preview' && result !== null && preview !== null && counts !== null && rates !== null && (
          <>
            <div className="flex flex-wrap items-center gap-2">
              {preview.blocked ? (
                <Badge tone="red">반영할 수 없음</Badge>
              ) : (
                <Badge tone="green">반영할 수 있습니다</Badge>
              )}
              <span className="text-t7 text-grey-500">
                경고 <strong>{preview.counts.warning}</strong>건 · 충돌 <strong>{preview.counts.conflict}</strong>건 · 오류{' '}
                <strong>{preview.counts.error}</strong>건
              </span>
            </div>

            {/* GF-5 시트별 건수 */}
            <div className="overflow-x-auto rounded-xl border border-grey-200">
              <table className="w-full text-t7">
                <thead className="bg-grey-50 text-grey-600">
                  <tr>
                    <th className="px-3 py-1.5 text-left font-semibold">시트</th>
                    <th className="px-3 py-1.5 text-right font-semibold">추가</th>
                    <th className="px-3 py-1.5 text-right font-semibold">변경</th>
                    <th className="px-3 py-1.5 text-right font-semibold">변경 없음</th>
                    <th className="px-3 py-1.5 text-right font-semibold">삭제 후보</th>
                    <th className="px-3 py-1.5 text-right font-semibold">충돌</th>
                    <th className="px-3 py-1.5 text-right font-semibold">오류</th>
                    <th className="px-3 py-1.5 text-right font-semibold">경고</th>
                  </tr>
                </thead>
                <tbody>
                  {KINDS.map((kind) => {
                    const c = counts[kind];
                    return (
                      <tr key={kind} className="border-t border-grey-100 text-grey-700">
                        <td className="px-3 py-1.5 font-medium">{SHEET_LABELS[kind]}</td>
                        <td className="px-3 py-1.5 text-right tabular-nums">{c.add}</td>
                        <td className="px-3 py-1.5 text-right tabular-nums">{c.update}</td>
                        <td className="px-3 py-1.5 text-right tabular-nums">{c.unchanged}</td>
                        <td className="px-3 py-1.5 text-right tabular-nums">{c.deleteCandidates}</td>
                        <td className={`px-3 py-1.5 text-right tabular-nums ${c.conflict > 0 ? 'text-orange-700' : ''}`}>
                          {c.conflict}
                        </td>
                        <td className={`px-3 py-1.5 text-right tabular-nums ${c.error > 0 ? 'text-red-600' : ''}`}>
                          {c.error}
                        </td>
                        <td className="px-3 py-1.5 text-right tabular-nums">{c.warning}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>

            {/* §6.2·§6.3 달성률 전후. 서버가 계산한 값을 표시만 한다 (O-4) */}
            <section className="space-y-1.5">
              <h3 className="text-t7 font-semibold text-grey-700">
                달성률 전후{' '}
                <span className="font-normal text-grey-400">({includeDeletes ? '삭제 포함' : '삭제 제외'} 기준)</span>
              </h3>
              <RatesTable rates={rates} />
            </section>

            {/* 파일 단위 차단 문제 + 오류 행. 이것만이 반영을 막는다 (S-21) */}
            {(blockingFileIssues.length > 0 || errorRows.length > 0) && (
              <div className="rounded-xl border border-red-200 bg-red-50 px-3 py-2 text-t7 text-red-700">
                <p className="font-semibold">
                  아래 {blockingFileIssues.length + errorRows.length}건 때문에 반영할 수 없습니다 — 부분 반영은 하지
                  않습니다. 엑셀에서 고친 뒤 다시 올리세요.
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
                      <span className="font-semibold">{rowPlace(row)}</span>
                      <span className="ml-1">: {issueMessages(row.issues)}</span>
                    </li>
                  ))}
                </ul>
              </div>
            )}

            {/* 막지 않는 문제 — 가중치 합≠100(파일), Σ연차≠총량·숫자 해석·방향 덮어씀 등(행) */}
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
                      <span className="font-semibold">{rowPlace(row)}</span>
                      {row.label !== '' && <span className="ml-1">({row.label})</span>}
                      <span className="ml-1">: {issueMessages(row.issues, true)}</span>
                    </li>
                  ))}
                </ul>
              </div>
            )}

            {/* GF-5 충돌: 반영에서 건너뛴다. 무엇이 빠지는지 반영 전에 보여 준다 */}
            {preview.conflicts.length > 0 && (
              <ConflictList
                title={`충돌 ${preview.conflicts.length}건 — 반영에서 건너뜁니다`}
                conflicts={preview.conflicts}
                labels={conflictLabels}
              />
            )}

            {/* GF-5 삭제 후보 + [삭제 포함] 토글(기본 꺼짐) */}
            {preview.deleteCandidates.length > 0 && (
              <section className="space-y-1.5">
                <div className="flex flex-wrap items-center gap-3">
                  <h3 className="text-t7 font-semibold text-grey-700">
                    삭제 후보 {preview.deleteCandidates.length}건{' '}
                    <span className="font-normal text-grey-400">— 양식에서 사라진 기존 행</span>
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
                    ? `켜짐 — 충돌이 아닌 ${preview.counts.deleteCandidates}건을 지웁니다. 지표·기술목표를 지우면 딸린 실적·측정 이력도 함께 지워지고 작업 연계가 끊깁니다.`
                    : '꺼짐 — 아무것도 지우지 않습니다. 지표 삭제는 딸린 실적·측정 이력까지 지우므로 목록을 확인한 뒤 켜세요.'}
                </p>
                <ul className="divide-y divide-grey-100 rounded-xl border border-grey-200 text-t7">
                  {preview.deleteCandidates.map((candidate) => (
                    <li
                      key={`${candidate.kind}:${candidate.id}`}
                      className="flex flex-wrap items-center gap-2 px-3 py-1.5 text-grey-700"
                    >
                      {candidate.conflict !== null ? (
                        <Badge tone="amber" title={CONFLICT_GUIDE}>
                          충돌 · {CONFLICT_LABELS[candidate.conflict]}
                        </Badge>
                      ) : (
                        <Badge tone={includeDeletes ? 'red' : 'neutral'}>{includeDeletes ? '삭제' : '유지'}</Badge>
                      )}
                      <span className="text-grey-500">{SHEET_LABELS[candidate.kind]}</span>
                      <span className="font-medium text-grey-800">
                        {candidate.label === '' ? '(이미 없음)' : candidate.label}
                      </span>
                      {(candidate.kind === 'deliverable' || candidate.kind === 'techTarget') && (
                        <span className="ml-auto tabular-nums text-grey-500">
                          실적 {candidate.achievementCount} · 측정 {candidate.recordCount} · 연계 작업{' '}
                          {candidate.linkedTaskCount}
                        </span>
                      )}
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
                        <span className="text-grey-400">{rowPlace(row)}</span>
                        <span className="font-medium text-grey-800">{row.label}</span>
                        {row.copiedFrom !== null && (
                          <Badge tone="neutral" title="숨김 id가 복사된 행이라 새 행으로 봅니다 (GF-5)">
                            복사 행
                          </Badge>
                        )}
                        {row.status === 'update' && row.changedFields.length > 0 && (
                          <span className="w-full text-grey-400">
                            바뀐 항목: {row.changedFields.map((field) => FIELD_LABELS[field] ?? field).join(', ')}
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

            <p className="rounded-xl border border-orange-300 bg-orange-50 px-3 py-2 text-t7 text-orange-900">
              {IRREVERSIBLE_NOTICE}
            </p>
          </>
        )}

        {/* ③ 결과 */}
        {step === 'done' && committed !== null && (
          <div className="space-y-2">
            <div role="status" className="rounded-xl border border-green-300 bg-green-50 px-3 py-2 text-t7 text-green-900">
              <p className="font-semibold">목표 양식을 반영했습니다.</p>
              <ul className="mt-1 space-y-0.5 tabular-nums">
                {KINDS.map((kind) => {
                  const c = {
                    deliverable: committed.deliverables,
                    achievement: committed.achievements,
                    techTarget: committed.techTargets,
                    record: committed.records,
                  }[kind];
                  return (
                    <li key={kind}>
                      {SHEET_LABELS[kind]} — 추가 {c.added} · 변경 {c.updated} · 삭제 {c.deleted}
                    </li>
                  );
                })}
              </ul>
            </div>
            {committed.previewConflicts.length > 0 && (
              <ConflictList
                title={`미리보기에서 충돌로 판정돼 건너뛴 행 ${committed.previewConflicts.length}건`}
                conflicts={committed.previewConflicts}
                labels={conflictLabels}
              />
            )}
            {/* O-1: 미리보기 뒤 반영 사이에 바뀐 행. DB가 센 것이라 미리보기에는 없던 목록이다 */}
            {committed.conflicts.length > 0 && (
              <ConflictList
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

function RatesTable({ rates }: { rates: { before: GoalRates; after: GoalRates } }) {
  const { before, after } = rates;
  const lines: { label: string; before: string; after: string; warn: boolean }[] = [
    {
      label: '성과목표 달성률',
      before: formatRate(before.deliverables.rate),
      after: formatRate(after.deliverables.rate),
      warn: false,
    },
    {
      label: '기술목표 가중 달성률',
      before: formatRate(before.techTargets.weightedRate),
      after: formatRate(after.techTargets.weightedRate),
      warn: false,
    },
    {
      label: '성과목표 가중치 합(%)',
      before: String(before.deliverableWeights.totalWeight),
      after: String(after.deliverableWeights.totalWeight),
      warn: after.deliverableWeights.weightMismatch,
    },
    {
      label: '기술목표 비중 합(%)',
      before: String(before.techTargetWeights.totalWeight),
      after: String(after.techTargetWeights.totalWeight),
      warn: after.techTargetWeights.weightMismatch,
    },
  ];
  return (
    <div className="overflow-x-auto rounded-xl border border-grey-200">
      <table className="w-full text-t7">
        <thead className="bg-grey-50 text-grey-600">
          <tr>
            <th className="px-3 py-1.5 text-left font-semibold">항목</th>
            <th className="px-3 py-1.5 text-right font-semibold">전</th>
            <th className="px-3 py-1.5 text-right font-semibold">후</th>
          </tr>
        </thead>
        <tbody>
          {lines.map((line) => (
            <tr key={line.label} className="border-t border-grey-100 text-grey-700">
              <td className="px-3 py-1.5">
                {line.label}
                {line.warn && (
                  <Badge tone="amber" className="ml-1">
                    100이 아님
                  </Badge>
                )}
              </td>
              <td className="px-3 py-1.5 text-right tabular-nums">{line.before}</td>
              <td className="px-3 py-1.5 text-right tabular-nums">{line.after}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function ConflictList({
  title,
  conflicts,
  labels,
}: {
  title: string;
  conflicts: readonly GoalFormConflict[];
  labels: ReadonlyMap<string, string>;
}) {
  return (
    <div className="rounded-xl border border-orange-300 bg-orange-50 px-3 py-2 text-t7 text-orange-900">
      <p className="font-semibold">{title}</p>
      <p className="mt-0.5">{CONFLICT_GUIDE}</p>
      <ul className="mt-2 space-y-1">
        {conflicts.map((conflict) => (
          <li key={`${conflict.kind}:${conflict.id}:${conflict.reason}`} className="rounded bg-orange-100/60 px-2 py-1">
            <Badge tone="amber">{CONFLICT_LABELS[conflict.reason]}</Badge>
            <span className="ml-1">
              {labels.get(`${conflict.kind}:${conflict.id}`) ?? `${SHEET_LABELS[conflict.kind]} ${conflict.id}`}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}
