'use client';

// 협약 예산 참여인원 보기 (SOT §6.19 AG-5, §5.23, §7.9.8 "참여인원 보기", 계획서 S-9~S-11)
//
// 목록·연차 소계·총계·구분·대조는 전부 서버(getAgreementData → lib/agreement/participants)가 만든 값이다 —
// 이 파일에는 금액 덧셈이 없다(파생 값은 한 곳에서만 계산한다).
//  - 구분(자동·수동·연봉 모름)은 저장값이 아니라 읽을 때 판정한 값이다. 연봉 모름의 계산값은 "—"(0원이 아니다)
//  - 금액 줄 대조는 표시만 한다(Q4) — 어느 쪽도 고치지 않으므로 이 화면에 [맞추기] 같은 버튼이 없다
//  - 작성 중 버전만 추가·수정·삭제한다. 서버도 확정 버전 편집·삭제를 RULE로 거부한다
// 인쇄 머리말·가로 방향은 셸(AgreementScreen)의 몫이다. 편집 컨트롤은 종이에 남기지 않는다(P-R4).

import { useEffect, useState } from 'react';
import type { ParticipantAmountKind, Settings, Year } from '@/types';
import type { ActionErrorCode } from '@/lib/db/errors';
import type { AgreementMemberOption, AgreementVersionView } from '@/actions/agreement';
import { deleteAgreementParticipant, type AgreementParticipantSaved } from '@/actions/agreement-participants';
import type { ParticipantViewRow } from '@/lib/agreement/participants';
import { AGREEMENT_VERSION_STATUS_LABELS, DETAIL_AXIS_LABELS, PARTICIPANT_AMOUNT_KIND_LABELS } from '@/lib/constants';
import { formatAmount } from '@/lib/currency';
import Badge, { type BadgeTone } from '@/components/ui/Badge';
import Button from '@/components/ui/Button';
import ErrorBanner from '@/components/ui/ErrorBanner';
import Modal from '@/components/ui/Modal';
import HelpLink from '@/components/help/HelpLink';
import { PRINT_TABLE, PRINT_TABLE_WRAP, PRINT_TD, PRINT_TH } from '@/components/print/tokens';
import TableActions from './TableActions';
import ParticipantDialog from './ParticipantDialog';

const NONE = '—';

/** 성공 안내가 떠 있는 시간. 실패 배너는 사용자가 닫을 때까지 남는다 */
const NOTICE_MS = 5000;

// 세 구분을 색으로도 가른다 — 수동은 계산값과 다르다는 신호, 연봉 모름은 계산할 수 없다는 신호
const KIND_TONE: Record<ParticipantAmountKind, BadgeTone> = {
  auto: 'neutral',
  manual: 'blue',
  salary_unknown: 'amber',
};

const AMOUNT_RULE_NOTICE: Record<AgreementParticipantSaved['amountRule'], string> = {
  explicit: '적은 금액으로 저장했습니다',
  recalculated: '금액을 계산값으로 채웠습니다',
  kept: '직전 금액을 유지했습니다',
};

interface Failure {
  message: string;
  code?: ActionErrorCode;
}

type DialogState = { mode: 'add' } | { mode: 'edit'; id: string };

function formatRate(value: number): string {
  return `${value.toLocaleString('ko-KR', { maximumFractionDigits: 4 })}%`;
}

function formatMonths(value: number): string {
  return value.toLocaleString('ko-KR', { maximumFractionDigits: 4 });
}

export interface ParticipantsViewProps {
  projectId: string;
  view: AgreementVersionView;
  /** 편집 대화의 인력 선택지·연봉 초깃값(과제 인력 order 순) */
  members: AgreementMemberOption[];
  /** 편집 대화의 연차 선택지 */
  years: Year[];
  currencyUnit: Settings['currencyUnit'];
  /** 작성 중 버전을 보고 있을 때만 true(AG-5·AV-2) */
  editable: boolean;
  /** 저장·삭제 성공, 충돌 후 다시 불러오기 — 셸이 router.refresh 등으로 새 값을 받는다 */
  onChanged: () => void;
}

export default function ParticipantsView({
  projectId,
  view,
  members,
  years,
  currencyUnit,
  editable,
  onChanged,
}: ParticipantsViewProps) {
  const [dialog, setDialog] = useState<DialogState | null>(null);
  const [deleting, setDeleting] = useState<ParticipantViewRow | null>(null);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<Failure | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    if (notice === null) return;
    const timer = window.setTimeout(() => setNotice(null), NOTICE_MS);
    return () => window.clearTimeout(timer);
  }, [notice]);

  const version = view.version;
  const model = view.participants.view;
  const rawRows = view.participants.rows;
  const money = (won: number | null): string => (won === null ? NONE : formatAmount(won, currencyUnit));

  // 수정 대화에는 version이 있는 원본 행을 넘긴다(O-1). 다시 불러온 뒤에도 같은 id로 최신 행을 찾는다
  const editingRow = dialog?.mode === 'edit' ? (rawRows.find((r) => r.id === dialog.id) ?? null) : null;

  async function runDelete(): Promise<void> {
    if (deleting === null) return;
    setBusy(true);
    setFailure(null);
    try {
      const res = await deleteAgreementParticipant(deleting.id);
      if (!res.ok) {
        setFailure({ message: res.error, code: res.code });
        return;
      }
      setNotice(`${deleting.memberLabel} · ${deleting.yearName} 행을 삭제했습니다.`);
      setDeleting(null);
      onChanged();
    } catch (e) {
      setFailure({ message: `참여인원을 삭제하지 못했습니다: ${e instanceof Error ? e.message : String(e)}` });
    } finally {
      setBusy(false);
    }
  }

  const readOnlyReason =
    version.status === 'confirmed'
      ? `${AGREEMENT_VERSION_STATUS_LABELS.confirmed}된 버전이라 참여인원을 고칠 수 없습니다.`
      : '이 버전은 지금 읽기 전용입니다.';

  const reconciliation = model.reconciliation;
  const editColumn = editable ? 1 : 0;

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="space-y-0.5 text-t7 text-grey-500 print:text-black">
          <p className="flex items-center gap-1.5">
            <span>
              금액 표시 단위 {currencyUnit} · 계산값 = 연봉 × 참여율 × 개월/12 · 구분은 저장 금액과 계산값을 비교해
              정합니다.
            </span>
            <HelpLink slug="agreement" anchor="참여인원" />
          </p>
          <p className="print:hidden">
            {editable ? '[참여인원 추가]나 행의 [수정]·[삭제]로 고칩니다.' : readOnlyReason}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {editable && (
            <Button
              size="sm"
              variant="primary"
              onClick={() => {
                setFailure(null);
                setDialog({ mode: 'add' });
              }}
              disabled={busy || years.length === 0}
              className="print:hidden"
            >
              참여인원 추가
            </Button>
          )}
          <TableActions
            projectId={projectId}
            model={view.participants.table}
            workbook={{ view: 'participants', versionId: version.id }}
          />
        </div>
      </div>

      {failure !== null && deleting === null && (
        <ErrorBanner
          message={failure.message}
          code={failure.code}
          className="whitespace-pre-line print:hidden"
          onDismiss={() => setFailure(null)}
        />
      )}
      {notice !== null && (
        <p role="status" className="rounded-lg bg-green-50 px-3 py-2 text-t7 text-green-600 print:hidden">
          {notice}
        </p>
      )}

      {model.rows.length === 0 ? (
        <p className="rounded-xl border border-dashed border-grey-300 bg-surface p-6 text-center text-t7 text-grey-500">
          {years.length === 0
            ? '이 과제에 연차가 없어 참여인원을 넣을 수 없습니다. 과제 개요에서 단계·연차를 먼저 만드세요.'
            : editable
              ? '이 버전에 참여인원이 없습니다. [참여인원 추가]로 넣으세요.'
              : '이 버전에 참여인원이 없습니다.'}
        </p>
      ) : (
        <div className={`overflow-x-auto rounded-xl border border-grey-200 bg-surface ${PRINT_TABLE_WRAP}`}>
          <table className={`w-full min-w-max text-xs ${PRINT_TABLE}`}>
            <caption className="sr-only">
              협약 예산 참여인원 — {version.name}. 인력·연차별 참여율·개월·연봉·계산값·현금·현물·계·구분, 끝에 연차
              소계와 총계.
            </caption>
            <thead className="text-grey-500 print:text-black">
              <tr className="border-b border-grey-100">
                {['인력', '연차', '역할'].map((label) => (
                  <th key={label} scope="col" className={`px-3 py-2 text-left font-medium ${PRINT_TH}`}>
                    {label}
                  </th>
                ))}
                {['참여율', '개월', '연봉 스냅샷', '계산값', DETAIL_AXIS_LABELS.cash, DETAIL_AXIS_LABELS.in_kind, '계'].map(
                  (label) => (
                    <th key={label} scope="col" className={`px-3 py-2 text-right font-medium ${PRINT_TH}`}>
                      {label}
                    </th>
                  )
                )}
                <th scope="col" className={`px-3 py-2 text-left font-medium ${PRINT_TH}`}>
                  구분
                </th>
                {editable && (
                  <th scope="col" className="px-3 py-2 print:hidden">
                    <span className="sr-only">작업</span>
                  </th>
                )}
              </tr>
            </thead>

            <tbody className="divide-y divide-grey-100">
              {model.rows.map((row) => (
                <tr key={row.id} data-kind={row.kind}>
                  <th
                    scope="row"
                    className={`px-3 py-1.5 text-left font-medium ${
                      row.memberId === null ? 'italic text-grey-500' : 'text-grey-800'
                    } ${PRINT_TD}`}
                  >
                    {row.memberLabel}
                  </th>
                  <td className={`px-3 py-1.5 text-grey-700 ${PRINT_TD}`}>{row.yearName}</td>
                  <td className={`max-w-[16rem] truncate px-3 py-1.5 text-grey-700 ${PRINT_TD}`} title={row.role}>
                    {row.role === '' ? <span className="text-grey-400">{NONE}</span> : row.role}
                  </td>
                  <td className={`px-3 py-1.5 text-right tabular-nums text-grey-700 ${PRINT_TD}`}>
                    {formatRate(row.participationRate)}
                  </td>
                  <td className={`px-3 py-1.5 text-right tabular-nums text-grey-700 ${PRINT_TD}`}>
                    {formatMonths(row.months)}
                  </td>
                  <td
                    className={`px-3 py-1.5 text-right tabular-nums ${
                      row.annualSalary === null ? 'text-grey-400' : 'text-grey-700'
                    } ${PRINT_TD}`}
                  >
                    {money(row.annualSalary)}
                  </td>
                  <td
                    className={`px-3 py-1.5 text-right tabular-nums ${
                      row.computed === null ? 'text-grey-400' : 'text-grey-700'
                    } ${PRINT_TD}`}
                  >
                    {money(row.computed)}
                  </td>
                  <td className={`px-3 py-1.5 text-right tabular-nums text-grey-800 ${PRINT_TD}`}>{money(row.cash)}</td>
                  <td className={`px-3 py-1.5 text-right tabular-nums text-grey-800 ${PRINT_TD}`}>{money(row.inKind)}</td>
                  <td
                    className={`bg-grey-50 px-3 py-1.5 text-right font-semibold tabular-nums text-grey-900 print:bg-transparent ${PRINT_TD}`}
                  >
                    {money(row.total)}
                  </td>
                  <td className={`px-3 py-1.5 ${PRINT_TD}`}>
                    <Badge tone={KIND_TONE[row.kind]} className="print:bg-transparent print:p-0 print:text-black">
                      {PARTICIPANT_AMOUNT_KIND_LABELS[row.kind]}
                    </Badge>
                  </td>
                  {editable && (
                    <td className="whitespace-nowrap px-2 py-1 text-right print:hidden">
                      <Button
                        size="sm"
                        variant="ghost"
                        disabled={busy}
                        onClick={() => {
                          setFailure(null);
                          setDialog({ mode: 'edit', id: row.id });
                        }}
                        aria-label={`${row.memberLabel} ${row.yearName} 수정`}
                      >
                        수정
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        disabled={busy}
                        onClick={() => {
                          setFailure(null);
                          setDeleting(row);
                        }}
                        aria-label={`${row.memberLabel} ${row.yearName} 삭제`}
                      >
                        삭제
                      </Button>
                    </td>
                  )}
                </tr>
              ))}
            </tbody>

            <tfoot className="border-t-2 border-grey-200 bg-grey-50 print:bg-transparent">
              {model.yearSubtotals.map((s) => (
                <tr key={s.yearId}>
                  <th
                    scope="row"
                    colSpan={7}
                    className={`px-3 py-1.5 text-left font-medium text-grey-700 ${PRINT_TH}`}
                  >
                    {s.yearName} 소계 ({s.rowCount.toLocaleString('ko-KR')}명)
                  </th>
                  <td className={`px-3 py-1.5 text-right font-semibold tabular-nums text-grey-800 ${PRINT_TD}`}>
                    {money(s.cash)}
                  </td>
                  <td className={`px-3 py-1.5 text-right font-semibold tabular-nums text-grey-800 ${PRINT_TD}`}>
                    {money(s.inKind)}
                  </td>
                  <td className={`px-3 py-1.5 text-right font-semibold tabular-nums text-grey-900 ${PRINT_TD}`}>
                    {money(s.total)}
                  </td>
                  <td colSpan={1 + editColumn} className={PRINT_TD} />
                </tr>
              ))}
              <tr className="border-t border-grey-200">
                <th scope="row" colSpan={7} className={`px-3 py-2 text-left font-semibold text-grey-800 ${PRINT_TH}`}>
                  총계
                </th>
                <td className={`px-3 py-2 text-right font-semibold tabular-nums text-grey-900 ${PRINT_TD}`}>
                  {money(model.grandTotal.cash)}
                </td>
                <td className={`px-3 py-2 text-right font-semibold tabular-nums text-grey-900 ${PRINT_TD}`}>
                  {money(model.grandTotal.inKind)}
                </td>
                <td className={`px-3 py-2 text-right font-semibold tabular-nums text-grey-900 ${PRINT_TD}`}>
                  {money(model.grandTotal.total)}
                </td>
                <td colSpan={1 + editColumn} className={PRINT_TD} />
              </tr>
            </tfoot>
          </table>
        </div>
      )}

      {reconciliation.years.length > 0 && (
        <section
          aria-label="금액 줄 대조"
          className={`space-y-2 rounded-xl border p-3 print:border-grey-400 ${
            reconciliation.hasDifference ? 'border-orange-200 bg-orange-50' : 'border-grey-200 bg-surface'
          }`}
        >
          <div className="text-t7">
            <p className={`font-semibold ${reconciliation.hasDifference ? 'text-orange-800' : 'text-grey-800'}`}>
              금액 줄 대조 —{' '}
              {reconciliation.hasDifference ? '참여인원 합과 금액 줄 인건비가 다른 연차가 있습니다' : '차이 없음'}
            </p>
            <p className="text-grey-500 print:text-black">
              차이 = 참여인원 합 − 금액 줄(인건비 + 학생인건비). 표시만 합니다 — 어느 쪽도 자동으로 고치지 않습니다.
            </p>
          </div>
          <div className={`overflow-x-auto ${PRINT_TABLE_WRAP}`}>
            <table className={`w-full min-w-max text-xs ${PRINT_TABLE}`}>
              <caption className="sr-only">
                연차·현금/현물별 참여인원 합, 금액 줄 인건비 합, 차이
              </caption>
              <thead className="text-grey-500 print:text-black">
                <tr className="border-b border-grey-200">
                  <th scope="col" rowSpan={2} className={`px-3 py-1.5 text-left font-medium ${PRINT_TH}`}>
                    연차
                  </th>
                  {['참여인원 합', '금액 줄', '차이'].map((label) => (
                    <th
                      key={label}
                      scope="colgroup"
                      colSpan={2}
                      className={`border-l border-grey-200 px-3 py-1.5 text-center font-medium ${PRINT_TH}`}
                    >
                      {label}
                    </th>
                  ))}
                </tr>
                <tr className="border-b border-grey-200">
                  {['p', 'l', 'd'].flatMap((group) =>
                    [DETAIL_AXIS_LABELS.cash, DETAIL_AXIS_LABELS.in_kind].map((axisLabel, i) => (
                      <th
                        key={`${group}-${axisLabel}`}
                        scope="col"
                        className={`px-3 py-1 text-right font-medium ${i === 0 ? 'border-l border-grey-200' : ''} ${PRINT_TH}`}
                      >
                        {axisLabel}
                      </th>
                    ))
                  )}
                </tr>
              </thead>
              <tbody>
                {[
                  ...reconciliation.years.map((y) => ({ key: y.yearId, label: y.yearName, ...y, strong: false })),
                  { key: 'total', label: '합계', ...reconciliation.total, strong: true },
                ].map((r) => (
                  <tr key={r.key} className={r.strong ? 'border-t-2 border-grey-200' : 'border-t border-grey-100'}>
                    <th
                      scope="row"
                      className={`px-3 py-1.5 text-left ${r.strong ? 'font-semibold' : 'font-medium'} text-grey-800 ${PRINT_TH}`}
                    >
                      {r.label}
                    </th>
                    <td className={`border-l border-grey-200 px-3 py-1.5 text-right tabular-nums text-grey-700 ${PRINT_TD}`}>
                      {money(r.participants.cash)}
                    </td>
                    <td className={`px-3 py-1.5 text-right tabular-nums text-grey-700 ${PRINT_TD}`}>
                      {money(r.participants.inKind)}
                    </td>
                    <td className={`border-l border-grey-200 px-3 py-1.5 text-right tabular-nums text-grey-700 ${PRINT_TD}`}>
                      {money(r.lines.cash)}
                    </td>
                    <td className={`px-3 py-1.5 text-right tabular-nums text-grey-700 ${PRINT_TD}`}>
                      {money(r.lines.inKind)}
                    </td>
                    <DiffCell value={r.diff.cash} first money={money} />
                    <DiffCell value={r.diff.inKind} first={false} money={money} />
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {dialog !== null && (
        <ParticipantDialog
          // 다른 행으로 바꾸면 입력을 섞지 않도록 새로 시작한다
          key={dialog.mode === 'edit' ? dialog.id : 'new'}
          versionId={version.id}
          participant={dialog.mode === 'edit' ? editingRow : null}
          removed={dialog.mode === 'edit' && editingRow === null}
          members={members}
          years={years}
          currencyUnit={currencyUnit}
          onClose={() => setDialog(null)}
          onSaved={(saved) => {
            setDialog(null);
            setNotice(`${dialog.mode === 'edit' ? '수정' : '추가'}했습니다 — ${AMOUNT_RULE_NOTICE[saved.amountRule]}(${PARTICIPANT_AMOUNT_KIND_LABELS[saved.kind]}).`);
            onChanged();
          }}
          onReload={onChanged}
        />
      )}

      {deleting !== null && (
        <Modal
          open
          title="참여인원 삭제"
          onClose={() => {
            setDeleting(null);
            setFailure(null);
          }}
          closeOnBackdrop={false}
          footer={
            <>
              <Button
                size="sm"
                onClick={() => {
                  setDeleting(null);
                  setFailure(null);
                }}
                disabled={busy}
              >
                취소
              </Button>
              <Button size="sm" variant="danger" onClick={() => void runDelete()} disabled={busy}>
                {busy ? '삭제 중…' : '삭제'}
              </Button>
            </>
          }
        >
          {failure && (
            <ErrorBanner
              message={failure.message}
              code={failure.code}
              onDismiss={() => setFailure(null)}
              className="mb-4 whitespace-pre-line"
            />
          )}
          <p className="text-sm text-grey-700">
            {deleting.memberLabel} · {deleting.yearName}
            {deleting.role === '' ? '' : ` (${deleting.role})`} 행을 삭제합니다. 인건비 현금 {money(deleting.cash)} ·
            현물 {money(deleting.inKind)}이 이 버전의 참여인원 합계에서 빠지며 되돌릴 수 없습니다. 금액 줄은 바뀌지
            않습니다.
          </p>
        </Modal>
      )}
    </div>
  );
}

/** 대조 차이 칸 — 0이 아니면 강조한다. 양수 = 참여인원이 금액 줄보다 많다 */
function DiffCell({ value, first, money }: { value: number; first: boolean; money: (won: number) => string }) {
  const shown = value > 0 ? `+${money(value)}` : money(value);
  return (
    <td
      className={`px-3 py-1.5 text-right tabular-nums ${first ? 'border-l border-grey-200' : ''} ${
        value === 0 ? 'text-grey-500' : 'font-semibold text-orange-700'
      } ${PRINT_TD}`}
    >
      {shown}
    </td>
  );
}
