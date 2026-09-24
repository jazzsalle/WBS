'use client';

// 입력 양식 올리기 모달 — 파일 → 미리보기 → 반영 (SOT §7.9.7 [입력 양식 올리기], §6.16 IN-2~IN-6)
//
//  - ① 파일 선택(xlsx만, IN-8) → previewInputForm ② 미리보기(연차·요약·비목별 합계·경고·오류 행·변경 행)
//    → [반영] → commitInputForm ③ 결과
//  - **막는 것은 `blocked`뿐이다.** 규칙 findings(§6.14)·개월 초과·연봉 없음은 severity가 error여도
//    알림이다 — 경고만 있으면 [반영]이 활성이다 (PL-15·RL-1). 협의 중인 계획은 한도를 넘나드는 것이
//    정상이고, 막으면 사용자가 엑셀로 나간다
//  - 미리보기와 반영은 서버에서 **같은 파싱 경로**를 탄다(IN-6). 여기서는 미리보기가 준 fileHash를
//    반영에 되돌려 같은 파일임을 대조할 뿐, 판정을 다시 하지 않는다 (O-4)
//  - 반영이 끝난 뒤에는 되돌아가 두 번 넣을 수 없다 — 되돌리기는 스냅샷의 몫이다 (D-17)
//  - 실패는 모달 안 ErrorBanner로 남긴다 (절대 규칙 5). 모달을 닫으면 진행 상태는 언마운트로 폐기된다
//
// 파싱·판정은 전부 actions/input-form.ts가 한다 — SheetJS를 클라이언트에서 import하지 않는다 (I-13).

import { useEffect, useMemo, useRef, useState } from 'react';
import type { BudgetCategory, RuleSeverity, Settings } from '@/types';
import type { ActionErrorCode } from '@/lib/db/errors';
import type {
  InputFormCommitResult,
  InputFormPreviewResult,
  InputFormPreviewRowView,
} from '@/actions/input-form';
import { commitInputForm, previewInputForm } from '@/actions/input-form';
import { BUDGET_CATEGORY_LABELS } from '@/lib/constants';
import { formatAmount } from '@/lib/currency';
import Badge, { type BadgeTone } from '@/components/ui/Badge';
import Button from '@/components/ui/Button';
import ErrorBanner from '@/components/ui/ErrorBanner';
import Modal from '@/components/ui/Modal';
import { setRealtimePaused } from '@/components/RealtimeRefresher';
import { MAX_UPLOAD_BYTES, buildFormData, formatBytes } from '@/components/budget/import/wizard-state';

/** IN-8: 양식은 xlsx만. 부처 서식 마법사(.xls·.xlsm)와 달리 우리가 만든 파일만 받는다 */
const ACCEPT_ATTRIBUTE = '.xlsx';

/** 변경 행 목록은 이 수를 넘으면 접는다 — 요약이 먼저고 목록은 확인용이다 */
const ROW_LIST_FOLD = 12;

// RL-1: severity는 색만 정한다. ExportModal과 같은 톤 — error red · warn orange(amber 톤) · info blue
const SEVERITY_TONES: Record<RuleSeverity, BadgeTone> = { error: 'red', warn: 'amber', info: 'blue' };
const SEVERITY_LABELS: Record<RuleSeverity, string> = { error: '위반', warn: '주의', info: '권고' };

const SHEET_LABELS: Record<InputFormPreviewRowView['sheet'], string> = {
  personnel: '인건비',
  budget: '사업비',
};

const AXIS_LABELS = { cash: '현금', in_kind: '현물' } as const;

type ChangeStatus = 'add' | 'change' | 'deleted';

const STATUS_PRESENTATION: Record<ChangeStatus, { label: string; tone: BadgeTone }> = {
  add: { label: '추가', tone: 'green' },
  change: { label: '변경', tone: 'blue' },
  deleted: { label: '삭제', tone: 'red' },
};

/** 추가·변경(양식 행)과 삭제(교체 비목의 기존 행)를 한 목록에 담는 화면용 모양 */
interface ChangeListItem {
  key: string;
  status: ChangeStatus;
  /** `인건비 3행` 또는 `기존 행` */
  where: string;
  category: BudgetCategory | null;
  label: string;
  axis: InputFormPreviewRowView['axis'];
  amount: number;
  changedFields: string[];
}

type Step = 'pick' | 'preview' | 'done';

interface Failure {
  message: string;
  code?: ActionErrorCode;
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

/** 결과 문장 (§7.9.7 ③). 부모의 결과 알림에도 같은 문장을 쓴다 */
function commitMessage(result: InputFormCommitResult): string {
  return `산출근거 ${result.inserted}행 반영 · ${result.deleted}행 삭제 · 셀 ${result.cells}개 재계산`;
}

export interface InputFormUploadProps {
  projectId: string;
  /** 화면 표시 단위. 파일과 서버는 언제나 원 단위 정수다 */
  currencyUnit: Settings['currencyUnit'];
  onClose: () => void;
  /** 반영 성공 직후. 부모는 결과 알림을 띄우고 router.refresh()로 매트릭스를 다시 그린다 */
  onDone: (message: string) => void;
}

export default function InputFormUpload({ projectId, currencyUnit, onClose, onDone }: InputFormUploadProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [step, setStep] = useState<Step>('pick');
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<InputFormPreviewResult | null>(null);
  const [committed, setCommitted] = useState<InputFormCommitResult | null>(null);
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
    setShowAllRows(false);
    setBusy('양식을 읽는 중입니다…');
    setFailure(null);
    try {
      const res = await previewInputForm(projectId, buildFormData(picked));
      if (!res.ok) {
        // 절대 규칙 5: _meta 거부(IN-2)·연차 경계 위반도 여기로 온다. 빈 미리보기로 눙치지 않는다
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
    if (file === null || preview === null || preview.blocked || committed !== null) return;
    setBusy('산출근거를 반영하는 중입니다…');
    setFailure(null);
    try {
      // 액션은 스테이트리스라 파일을 다시 보낸다. 미리보기의 fileHash로 같은 파일임을 대조하고,
      // 교체 비목도 **미리보기 시점의 목록**을 그대로 넘긴다 — 사용자가 본 삭제 범위와 같아야 한다 (IN-6)
      const res = await commitInputForm(
        projectId,
        buildFormData(file),
        preview.fileHash,
        preview.replaceCategories
      );
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

  const errorRows = useMemo(
    () => (preview?.rows ?? []).filter((row) => row.status === 'error' || row.status === 'unknown'),
    [preview]
  );
  // 추가·변경은 양식 행에서, 삭제는 교체 비목 안의 기존 행에서 온다 — 한 목록으로 합쳐 "무엇이 바뀌는가"를 한 번에 본다
  const changedRows = useMemo<ChangeListItem[]>(() => {
    if (preview === null) return [];
    const items: ChangeListItem[] = [];
    for (const row of preview.rows) {
      if (row.status !== 'add' && row.status !== 'change') continue;
      items.push({
        key: row.key,
        status: row.status,
        where: `${SHEET_LABELS[row.sheet]} ${row.rowIndex}행`,
        category: row.category,
        label: row.label,
        axis: row.axis,
        amount: row.amount,
        changedFields: row.changedFields,
      });
    }
    for (const row of preview.deleted) {
      items.push({
        key: `deleted:${row.detailId}`,
        status: 'deleted',
        where: '기존 행',
        category: row.category,
        label: row.label,
        axis: null,
        amount: row.amount,
        changedFields: [],
      });
    }
    return items;
  }, [preview]);
  const visibleChangedRows = showAllRows ? changedRows : changedRows.slice(0, ROW_LIST_FOLD);

  // 막는 것은 blocked뿐이다. 경고(warnings·notices)는 여기 들어오지 않는다 (PL-15·RL-1)
  const commitBlocker =
    preview === null
      ? '양식 파일을 먼저 올리세요.'
      : preview.blocked
        ? errorRows[0]
          ? `${SHEET_LABELS[errorRows[0].sheet]} 시트 ${errorRows[0].rowIndex}행: ${firstIssue(errorRows[0])}`
          : '반영할 수 있는 행이 없습니다.'
        : null;

  const untouchedTotal = preview?.untouchedCategories.reduce((sum, item) => sum + item.rowCount, 0) ?? 0;
  const alertCount = (preview?.warnings.length ?? 0) + (preview?.notices.length ?? 0);

  return (
    <Modal
      open
      size="xl"
      closeOnBackdrop={false}
      title="입력 양식 올리기"
      description="[반영]을 누르기 전에는 아무것도 저장되지 않습니다. 모달을 닫으면 진행 상태는 폐기됩니다."
      // 진행 중에는 Esc·×로 닫히지 않게 한다 — 결과를 못 본 채 닫히면 무엇이 됐는지 알 수 없다
      onClose={() => {
        if (busy === null) onClose();
      }}
      footer={
        <>
          <span className="mr-auto text-t7 text-grey-500">
            {step === 'preview' && commitBlocker !== null && (
              <span className="text-red-600">{commitBlocker}</span>
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
          <div className="rounded-xl border-2 border-dashed border-grey-300 bg-white p-8 text-center">
            <p className="text-t6 font-semibold text-grey-700">
              [입력 양식 내려받기]로 받아 값을 적은 파일을 선택하세요
            </p>
            <p className="mt-1 text-t7 text-grey-500">.xlsx · 최대 10MB</p>
            <p className="mt-1 text-t7 text-grey-400">
              양식에 있던 인력만 받습니다 — 새 인력은 인력·기관 화면에서 먼저 만드세요. 금액 열은 읽지 않고
              앱이 다시 계산합니다.
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
        {step === 'preview' && preview !== null && (
          <>
            {/* IN-5: 추가 N · 변경 M · 삭제 K · 유지 U */}
            <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5 rounded-xl border border-grey-200 bg-grey-50 px-3 py-2 text-t7">
              <span className="font-semibold text-grey-700">{preview.yearLabel}</span>
              <span className="text-grey-600">
                추가 <strong>{preview.summary.added}</strong>
              </span>
              <span className="text-grey-600">
                변경 <strong>{preview.summary.changed}</strong>
              </span>
              <span className="text-grey-600">
                삭제 <strong>{preview.summary.deleted}</strong>
              </span>
              <span className="text-grey-600">
                유지 <strong>{preview.summary.unchanged}</strong>
              </span>
              <span className={preview.summary.errors > 0 ? 'text-red-600' : 'text-grey-600'}>
                오류 <strong>{preview.summary.errors}</strong>
              </span>
              <span className={preview.summary.unknown > 0 ? 'text-red-600' : 'text-grey-600'}>
                알 수 없음 <strong>{preview.summary.unknown}</strong>
              </span>
              {preview.blocked ? (
                <Badge tone="red">반영할 수 없음</Badge>
              ) : (
                <Badge tone="green">반영할 수 있습니다</Badge>
              )}
              {alertCount > 0 && <Badge tone="amber">확인할 경고 {alertCount}건</Badge>}
            </div>

            {/* 반영 뒤 연차 모습의 비목별 합계. 서버가 계산한 값을 표시 단위로 환산만 한다 (B-4) */}
            <section className="space-y-1.5">
              <h3 className="text-t7 font-semibold text-grey-700">반영 뒤 비목별 합계</h3>
              <div className="overflow-x-auto rounded-xl border border-grey-200">
                <table className="w-full text-t7">
                  <thead className="bg-grey-50 text-grey-600">
                    <tr>
                      <th className="px-3 py-1.5 text-left font-semibold">비목</th>
                      <th className="px-3 py-1.5 text-right font-semibold">행</th>
                      <th className="px-3 py-1.5 text-right font-semibold">현금</th>
                      <th className="px-3 py-1.5 text-right font-semibold">현물</th>
                      <th className="px-3 py-1.5 text-right font-semibold">합계</th>
                    </tr>
                  </thead>
                  <tbody>
                    {preview.totals.cells
                      .filter((cell) => cell.rowCount > 0)
                      .map((cell) => (
                        <tr key={cell.category} className="border-t border-grey-100 text-grey-700">
                          <td className="px-3 py-1.5">{BUDGET_CATEGORY_LABELS[cell.category]}</td>
                          <td className="px-3 py-1.5 text-right tabular-nums">{cell.rowCount}</td>
                          <td className="px-3 py-1.5 text-right tabular-nums">
                            {formatAmount(cell.cashAmount, currencyUnit)}
                          </td>
                          <td className="px-3 py-1.5 text-right tabular-nums">
                            {formatAmount(cell.inKindAmount, currencyUnit)}
                          </td>
                          <td className="px-3 py-1.5 text-right font-semibold tabular-nums">
                            {formatAmount(cell.plannedAmount, currencyUnit)}
                          </td>
                        </tr>
                      ))}
                    <tr className="border-t border-grey-200 bg-grey-50 font-semibold text-grey-900">
                      <td className="px-3 py-1.5">합계</td>
                      <td className="px-3 py-1.5" />
                      <td className="px-3 py-1.5 text-right tabular-nums">
                        {formatAmount(preview.totals.total.cashAmount, currencyUnit)}
                      </td>
                      <td className="px-3 py-1.5 text-right tabular-nums">
                        {formatAmount(preview.totals.total.inKindAmount, currencyUnit)}
                      </td>
                      <td className="px-3 py-1.5 text-right tabular-nums">
                        {formatAmount(preview.totals.total.plannedAmount, currencyUnit)}
                      </td>
                    </tr>
                  </tbody>
                </table>
              </div>
            </section>

            {/* IN-5: 양식에 유효 행이 없는 비목은 지우지 않는다 — 조용히 두지 않고 드러낸다 */}
            {preview.untouchedCategories.length > 0 && (
              <p className="rounded-xl border border-grey-200 bg-grey-50 px-3 py-2 text-t7 text-grey-600">
                양식에 없는 비목 <strong>{untouchedTotal}행 유지</strong> —{' '}
                {preview.untouchedCategories
                  .map((item) => `${BUDGET_CATEGORY_LABELS[item.category]} ${item.rowCount}행`)
                  .join(' · ')}
                . 기존 산출근거를 그대로 둡니다.
              </p>
            )}

            {/* 경고는 막지 않는다 (PL-15·RL-1). 접어 숨기지 않는다 — 보지 않고 지나간 경고는 없는 경고와 같다 */}
            {alertCount > 0 && (
              <div className="rounded-xl border border-orange-300 bg-orange-50 px-3 py-2 text-t7 text-orange-900">
                <p className="font-semibold">
                  확인할 내용 {alertCount}건이 있습니다. <strong>반영은 막지 않습니다</strong> — 이대로
                  반영됩니다.
                </p>
                <ul className="mt-2 space-y-1">
                  {preview.warnings.map((warning, index) => (
                    <li key={`warning:${warning.kind}:${index}`} className="rounded bg-orange-100/60 px-2 py-1">
                      <Badge tone="amber">주의</Badge>
                      <span className="ml-1">{warning.message}</span>
                    </li>
                  ))}
                  {preview.notices.map((notice, index) => (
                    <li key={`notice:${notice.code}:${index}`} className="rounded bg-orange-100/60 px-2 py-1">
                      <span className="font-semibold">[연구비 사용 규칙] {notice.label}</span>
                      <Badge tone={SEVERITY_TONES[notice.severity]} className="ml-1">
                        {SEVERITY_LABELS[notice.severity]}
                      </Badge>
                      {notice.approximate && (
                        <Badge tone="neutral" className="ml-1" title="가정이 들어간 판정입니다 (RL-7·RL-9)">
                          근사
                        </Badge>
                      )}
                      <span className="ml-1">— {notice.message}</span>
                    </li>
                  ))}
                </ul>
              </div>
            )}

            {/* 오류·알 수 없는 행: 어느 시트 몇 행이 왜 빠지는지. 이것만이 반영을 막는다 */}
            {errorRows.length > 0 && (
              <div className="rounded-xl border border-red-200 bg-red-50 px-3 py-2 text-t7 text-red-700">
                <p className="font-semibold">
                  아래 {errorRows.length}행 때문에 반영할 수 없습니다. 엑셀에서 고친 뒤 다시 올리세요.
                </p>
                <ul className="mt-2 space-y-1">
                  {errorRows.map((row) => (
                    <li key={row.key} className="rounded bg-red-100/60 px-2 py-1">
                      <span className="font-semibold">
                        {SHEET_LABELS[row.sheet]} {row.rowIndex}행
                      </span>
                      <Badge tone="red" className="ml-1">
                        {row.status === 'unknown' ? '알 수 없음' : '오류'}
                      </Badge>
                      <span className="ml-1">{row.label}</span>
                      <span className="ml-1">— {issueMessages(row)}</span>
                    </li>
                  ))}
                </ul>
              </div>
            )}

            {/* 추가·변경 행(양식) + 삭제될 기존 행(교체 비목 안, IN-5). 삭제가 요약 숫자로만 보이면
                무엇이 사라지는지 모른 채 반영하게 된다 */}
            {changedRows.length > 0 && (
              <section className="space-y-1.5">
                <h3 className="text-t7 font-semibold text-grey-700">
                  추가·변경·삭제 행 {changedRows.length}건
                </h3>
                <ul className="divide-y divide-grey-100 rounded-xl border border-grey-200 text-t7">
                  {visibleChangedRows.map((row) => {
                    const presentation = STATUS_PRESENTATION[row.status];
                    return (
                      <li key={row.key} className="flex flex-wrap items-center gap-2 px-3 py-1.5 text-grey-700">
                        <Badge tone={presentation.tone}>{presentation.label}</Badge>
                        <span className="text-grey-400">{row.where}</span>
                        <span className="text-grey-500">{categoryLabel(row.category)}</span>
                        <span className="font-medium text-grey-800">{row.label}</span>
                        {row.axis !== null && <Badge tone="neutral">{AXIS_LABELS[row.axis]}</Badge>}
                        <span className="ml-auto tabular-nums">{formatAmount(row.amount, currencyUnit)}</span>
                        {row.status === 'change' && row.changedFields.length > 0 && (
                          <span className="w-full text-grey-400">바뀐 항목: {row.changedFields.join(', ')}</span>
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
              화면 금액은 표시 단위({currencyUnit})로 환산한 값입니다. 양식의 금액 열은 읽지 않고 앱이 다시
              계산합니다(IN-3). 반영은 양식에 행이 있는 비목 단위의 교체이며 스냅샷을 남깁니다(IN-5).
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
            {/* D-15a: 잠긴 셀은 RPC가 건너뛴다. 미리보기 시점이 아니라 DB가 세었으므로 이 수가 맞다 */}
            {committed.skippedLocked > 0 && (
              <p className="rounded-xl border border-orange-300 bg-orange-50 px-3 py-2 text-t7 text-orange-900">
                잠긴 셀 {committed.skippedLocked}개는 건너뛰었습니다. 잠금을 풀고 다시 올리면 반영됩니다.
              </p>
            )}
            <p className="text-t7 text-grey-400">
              되돌리려면 임포트 스냅샷에서 복원하세요. 닫으면 매트릭스가 새 값으로 그려집니다.
            </p>
          </div>
        )}
      </div>
    </Modal>
  );
}

function categoryLabel(category: BudgetCategory | null): string {
  return category === null ? '(비목 미정)' : BUDGET_CATEGORY_LABELS[category];
}

/** 차단 issue를 앞에 둔다 — 반영을 막은 이유가 먼저 보여야 한다 */
function issueMessages(row: InputFormPreviewRowView): string {
  const sorted = [...row.issues].sort((a, b) => Number(b.blocking) - Number(a.blocking));
  return sorted.length === 0 ? '사유 없음' : sorted.map((issue) => issue.message).join(' · ');
}

function firstIssue(row: InputFormPreviewRowView): string {
  return row.issues.find((issue) => issue.blocking)?.message ?? row.issues[0]?.message ?? '알 수 없는 행';
}
