'use client';

// [협약 기준선으로 보내기] 확인 대화 (SOT §7.9, §5.21 AV-2·AV-6, 계획서 S-6·S-17, Q2·Q4)
// 열리면 previewAgreementBaseline으로 실제 보내기와 같은 계산을 미리 받아 무엇이 만들어질지 보인다 —
// 숫자를 여기서 다시 계산하지 않는다(규칙이 두 곳에 생기면 어긋난다).
// - 작성 중 버전이 있으면 이유와 함께 보내기 비활성(AV-2). 서버도 RULE로 거부한다
// - 거부 사유(issues)가 있으면 위치 문장을 전부 보이고 비활성 — 금액을 잃는 기준선을 만들지 않는다
// - 미분리 셀(현금·현물 둘 다 비어 있는 셀)은 계획액 전부를 현금으로 보낸다는 것을 건수·합계와 함께 미리 알린다(Q2)
// - 버전이 이미 있으면 직전 버전을 복제하지 않는다는 것을 알린다(Q4)
// 결과 문장은 부모가 토스트로 남긴다 — 대화가 닫혀도 사용자가 무엇이 만들어졌는지 볼 수 있어야 한다.

import { useCallback, useEffect, useState } from 'react';
import type { AgreementVersionKind, Settings } from '@/types';
import type { ActionErrorCode } from '@/lib/db/errors';
import type { NextVersionMeta } from '@/lib/agreement/versions';
import {
  createAgreementVersionFromPlan,
  previewAgreementBaseline,
  type AgreementBaselinePreview,
} from '@/actions/agreement';
import {
  AGREEMENT_VERSION_KIND_LABELS,
  AGREEMENT_VERSION_KIND_ORDER,
  BUDGET_CATEGORY_LABELS,
} from '@/lib/constants';
import { formatAmount } from '@/lib/currency';
import Modal from '@/components/ui/Modal';
import Button from '@/components/ui/Button';
import ErrorBanner from '@/components/ui/ErrorBanner';
import { setRealtimePaused } from '@/components/RealtimeRefresher';
import { draftExistsReason } from './VersionBar';

const INPUT_CLASS =
  'mt-1 w-full rounded-lg border border-grey-300 bg-surface px-3 py-2 text-sm focus:border-grey-500 focus:outline-none disabled:opacity-50';

// SOT §5.21 AV-6 문구 그대로(Q4)
const NOT_CLONED_NOTICE = '직전 버전을 복제하지 않고 제안 편성으로 새로 만듭니다';

type Failure = { message: string; code?: ActionErrorCode };

export interface SendBaselineDialogProps {
  projectId: string;
  /** 미분리 셀 위치를 연차 이름으로 보이기 위한 제안 스냅샷의 연차 */
  years: readonly { id: string; name: string }[];
  currencyUnit: Settings['currencyUnit'];
  /** 종류·이름 초깃값(S-22, getAgreementData.nextVersionMeta). 사용자가 고칠 수 있다 */
  initialMeta: NextVersionMeta;
  onClose: () => void;
  /** 결과 문장. 부모가 토스트로 남기고 router.refresh()한다 */
  onSent: (message: string) => void;
}

export default function SendBaselineDialog({
  projectId,
  years,
  currencyUnit,
  initialMeta,
  onClose,
  onSent,
}: SendBaselineDialogProps) {
  const [kind, setKind] = useState<AgreementVersionKind>(initialMeta.kind);
  const [name, setName] = useState(initialMeta.name);
  const [preview, setPreview] = useState<AgreementBaselinePreview | null>(null);
  const [loading, setLoading] = useState(true);
  const [previewFailure, setPreviewFailure] = useState<Failure | null>(null);
  const [sending, setSending] = useState(false);
  const [failure, setFailure] = useState<Failure | null>(null);

  // R-4: 대화가 열린 동안 자동 새로고침을 보류해 입력 중인 이름을 지킨다
  useEffect(() => {
    setRealtimePaused(true);
    return () => setRealtimePaused(false);
  }, []);

  const loadPreview = useCallback(async (isCancelled: () => boolean): Promise<void> => {
    setLoading(true);
    setPreviewFailure(null);
    try {
      const res = await previewAgreementBaseline(projectId);
      if (isCancelled()) return;
      if (!res.ok) {
        setPreview(null);
        setPreviewFailure({ message: res.error, code: res.code });
        return;
      }
      setPreview(res.data);
    } finally {
      if (!isCancelled()) setLoading(false);
    }
  }, [projectId]);

  useEffect(() => {
    let cancelled = false;
    void loadPreview(() => cancelled);
    return () => {
      cancelled = true;
    };
  }, [loadPreview]);

  const yearName = (yearId: string): string => years.find((y) => y.id === yearId)?.name ?? '(알 수 없는 연차)';
  const money = (won: number): string => formatAmount(won, currencyUnit);

  const blockedReason: string | null =
    preview === null
      ? null
      : preview.draftVersionName !== null
        ? draftExistsReason(preview.draftVersionName)
        : null;
  const canSend = preview !== null && preview.ok && blockedReason === null && !loading && !sending;

  const handleSubmit = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault();
    if (!canSend) return;
    setFailure(null);
    const trimmed = name.trim();
    if (trimmed === '') {
      setFailure({ message: '버전 이름을 입력하세요.', code: 'VALIDATION' });
      return;
    }
    setSending(true);
    try {
      const res = await createAgreementVersionFromPlan(projectId, { kind, name: trimmed });
      if (!res.ok) {
        setFailure({ message: res.error, code: res.code });
        return;
      }
      const { lineCount, participantCount, summary } = res.data;
      const unsplit =
        summary.unsplit.count > 0
          ? `미분리 셀 ${summary.unsplit.count}건(합계 ${money(summary.unsplit.amount)})은 현금으로 보냈습니다`
          : '미분리 셀 0건';
      onSent(
        `협약 기준선 '${trimmed}'(${AGREEMENT_VERSION_KIND_LABELS[kind]}, 작성 중)을 만들었습니다 — 금액 줄 ${lineCount}개 · 참여인원 ${participantCount}행 · ${unsplit}. 수행 모드에서 확인하세요.`
      );
    } finally {
      setSending(false);
    }
  };

  return (
    <Modal
      open
      size="lg"
      title="협약 기준선으로 보내기"
      description="지금의 제안 편성(셀 금액·산출근거·인력 연봉)으로 작성 중 협약 예산 버전을 만듭니다. 보낸 뒤에는 제안 모드와 협약 예산이 서로 독립입니다 — 한쪽을 고쳐도 다른 쪽은 바뀌지 않습니다."
      onClose={onClose}
      closeOnBackdrop={false}
    >
      <form onSubmit={handleSubmit}>
        {failure && (
          <ErrorBanner
            message={failure.message}
            code={failure.code}
            onDismiss={() => setFailure(null)}
            // RULE 문장의 위치 목록 줄바꿈을 살린다
            className="mb-4 whitespace-pre-line"
          />
        )}

        {loading ? (
          <p role="status" className="rounded-lg border border-grey-200 bg-grey-50 px-3 py-2 text-sm text-grey-600">
            제안 편성을 읽어 보낼 내용을 계산하는 중…
          </p>
        ) : previewFailure ? (
          <div className="space-y-2">
            <ErrorBanner
              message={previewFailure.message}
              code={previewFailure.code}
              className="whitespace-pre-line"
            />
            <Button size="sm" onClick={() => void loadPreview(() => false)}>
              다시 계산
            </Button>
          </div>
        ) : preview ? (
          <div className="space-y-3">
            {blockedReason && (
              <p role="alert" className="rounded-lg border border-orange-200 bg-orange-50 px-3 py-2 text-sm text-orange-800">
                {blockedReason}
              </p>
            )}

            {preview.hasVersions && blockedReason === null && (
              <p className="rounded-lg border border-blue-200 bg-blue-50 px-3 py-2 text-sm text-blue-800">
                이미 협약 예산 버전이 있습니다. {NOT_CLONED_NOTICE}.
              </p>
            )}

            {preview.ok ? (
              <dl className="grid grid-cols-2 gap-x-4 gap-y-1 rounded-lg border border-grey-200 bg-surface px-3 py-2 text-sm">
                <dt className="text-grey-500">만들 금액 줄</dt>
                <dd className="text-right font-semibold text-grey-900">{preview.summary.lineCount}개</dd>
                <dt className="text-grey-500">참여인원</dt>
                <dd className="text-right font-semibold text-grey-900">{preview.summary.participantCount}행</dd>
                <dt className="text-grey-500">현금 합계</dt>
                <dd className="text-right font-semibold text-grey-900">{money(preview.summary.cashTotal)}</dd>
                <dt className="text-grey-500">현물 합계</dt>
                <dd className="text-right font-semibold text-grey-900">{money(preview.summary.inKindTotal)}</dd>
              </dl>
            ) : (
              <div role="alert" className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800">
                <p className="font-semibold">
                  협약 기준선으로 보낼 수 없습니다 — 제안 모드에서 아래를 고친 뒤 다시 보내세요.
                </p>
                <ul className="mt-1 list-disc space-y-0.5 pl-5">
                  {preview.issues.map((issue, i) => (
                    <li key={`${issue.code}-${issue.yearId}-${issue.category}-${i}`} className="whitespace-pre-line">
                      {issue.message}
                    </li>
                  ))}
                </ul>
              </div>
            )}

            {/* Q2: 미분리 셀은 계획액 전부가 현금으로 간다 — 0건이어도 0건이라고 적어 확인했음을 보인다 */}
            {preview.ok && (
              <div className="rounded-lg border border-grey-200 bg-grey-50 px-3 py-2 text-sm text-grey-700">
                {preview.summary.unsplit.count === 0 ? (
                  <p>미분리 셀(현금·현물이 모두 비어 있는 셀) 0건</p>
                ) : (
                  <>
                    <p>
                      미분리 셀(현금·현물이 모두 비어 있는 셀){' '}
                      <span className="font-semibold text-grey-900">
                        {preview.summary.unsplit.count}건 · 합계 {money(preview.summary.unsplit.amount)}
                      </span>
                      은 계획액 전부를 <span className="font-semibold text-grey-900">현금으로 보냅니다</span>.
                    </p>
                    <ul className="mt-1 list-disc space-y-0.5 pl-5 text-xs text-grey-600">
                      {preview.summary.unsplit.cells.map((cell) => (
                        <li key={`${cell.yearId}-${cell.category}`}>
                          {yearName(cell.yearId)} · {BUDGET_CATEGORY_LABELS[cell.category]} · {money(cell.amount)}
                        </li>
                      ))}
                    </ul>
                  </>
                )}
              </div>
            )}
          </div>
        ) : null}

        <div className="mt-4 grid gap-4">
          <label>
            <span className="text-sm font-medium text-grey-700">종류</span>
            <select
              value={kind}
              onChange={(e) => setKind(e.target.value as AgreementVersionKind)}
              disabled={sending}
              className={INPUT_CLASS}
            >
              {AGREEMENT_VERSION_KIND_ORDER.map((k) => (
                <option key={k} value={k}>
                  {AGREEMENT_VERSION_KIND_LABELS[k]}
                </option>
              ))}
            </select>
          </label>

          <label>
            <span className="text-sm font-medium text-grey-700">
              이름 <span className="text-red-600">*</span>
            </span>
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              maxLength={100}
              required
              disabled={sending}
              placeholder="예: 선정평가본"
              className={INPUT_CLASS}
            />
          </label>
        </div>

        <p className="mt-3 text-xs text-grey-500">
          만든 버전은 작성 중 상태입니다. 기준일·변경 사유 등은 수행 모드의 [버전 정보]에서 채웁니다.
        </p>

        <div className="mt-6 flex justify-end gap-2">
          <Button onClick={onClose} disabled={sending}>
            취소
          </Button>
          <Button
            type="submit"
            variant="primary"
            disabled={!canSend}
            title={blockedReason ?? undefined}
          >
            {sending ? '보내는 중…' : '보내기'}
          </Button>
        </div>
      </form>
    </Modal>
  );
}
