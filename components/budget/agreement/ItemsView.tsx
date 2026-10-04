'use client';

// 협약 예산 편성 항목·증빙 보기 (SOT §5.24, §6.19 AG-6, §7.9.8 "편성 항목·증빙 보기", 계획서 S-2·S-10·U-1·U-3)
//
// 목록·소계·대조·증빙 n/m·경고 배지는 전부 서버(getAgreementData → lib/agreement/items-view)가 만든 값이다 —
// 이 파일에는 금액 덧셈도 규칙 비교도 없다(파생 값은 한 곳에서만, RL-17 ×1.1 경계는 판정기 하나).
//  - 금액 줄 대조는 표시만 한다(§5.24) — 어느 쪽도 고치지 않으므로 [맞추기] 같은 버튼이 없다
//  - 작성 중 버전 = 추가·수정·삭제·증빙 전부. 확정 버전 = [증빙]의 받음 체크·메모만(U-3). 서버도 같은 범위로 거부한다
//  - 경고 배지는 그 건의 RL-17~RL-19 finding이다. 문장은 툴팁(title)과 스크린리더 글자로 보인다
// 인쇄 머리말·가로 방향은 셸(AgreementScreen)의 몫이다. 편집 컨트롤·증빙 편집기는 종이에 남기지 않고,
// 증빙은 펼친 상태와 무관하게 "받음 n/m"만 찍는다(P-R4, §7.9.8).

import { Fragment, useEffect, useRef, useState } from 'react';
import type { AgreementItem, AgreementVersion, RuleSeverity, Settings, Year } from '@/types';
import type { ActionErrorCode } from '@/lib/db/errors';
import { deleteAgreementItem } from '@/actions/agreement-items';
import type { ItemViewRow, ItemsViewModel } from '@/lib/agreement/items-view';
import type { TableModel } from '@/lib/agreement/table';
import { AGREEMENT_VERSION_STATUS_LABELS } from '@/lib/constants';
import { formatAmount } from '@/lib/currency';
import Badge, { type BadgeTone } from '@/components/ui/Badge';
import Button from '@/components/ui/Button';
import ErrorBanner from '@/components/ui/ErrorBanner';
import Modal from '@/components/ui/Modal';
import HelpLink from '@/components/help/HelpLink';
import { PRINT_TABLE, PRINT_TABLE_WRAP, PRINT_TD, PRINT_TH } from '@/components/print/tokens';
import TableActions from './TableActions';
import ItemDialog, { ITEM_AMOUNT_VAT_NOTE } from './ItemDialog';
import EvidenceEditor from './EvidenceEditor';

const NONE = '—';

/** 성공 안내가 떠 있는 시간. 실패 배너는 사용자가 닫을 때까지 남는다 */
const NOTICE_MS = 5000;

/** 열 수(연차·종류·품명·수량·금액·증빙·경고) + 작업 열 — 펼침 행·소계 행의 colSpan */
const DATA_COLUMNS = 7;

// 규칙 패널(RuleFindingsPanel)과 같은 색 — 같은 finding이 두 곳에서 다른 색이면 다른 경고처럼 보인다
const SEVERITY_TONE: Record<RuleSeverity, BadgeTone> = { error: 'red', warn: 'amber', info: 'blue' };
const SEVERITY_RANK: Record<RuleSeverity, number> = { error: 0, warn: 1, info: 2 };

interface Failure {
  message: string;
  code?: ActionErrorCode;
}

type DialogState = { mode: 'add' } | { mode: 'edit'; id: string };

function formatQuantity(value: number | null): string {
  return value === null ? NONE : value.toLocaleString('ko-KR', { maximumFractionDigits: 4 });
}

export interface ItemsViewProps {
  projectId: string;
  /** 보고 있는 버전. status로 편집 범위(작성 중 전부 / 확정 체크·메모만)를 정한다 */
  version: AgreementVersion;
  /** 이 버전의 편성 항목 보기 모델 — buildItemsView({items, lines, years, findings: 이 버전 판정 결과}) */
  view: ItemsViewModel;
  /** 같은 모델의 표 모델 — itemsTable(view, `${버전 이름} 편성 항목`). [복사](TSV) 원본, 엑셀과 같은 모델 */
  table: TableModel;
  /** 이 버전의 원본 행(version 포함) — 수정(O-1 expectedVersion)·증빙 편집 초깃값. 보기 행에는 version이 없다 */
  items: AgreementItem[];
  /** 대화의 연차 선택지(과제 연차) */
  years: Year[];
  currencyUnit: Settings['currencyUnit'];
  /** 작성 중 버전을 보고 있을 때만 true(AV-2). false여도 확정 버전이면 [증빙]의 체크·메모는 열린다 */
  editable: boolean;
  /** 규칙 패널에서 건 finding(scope `item`)을 눌렀을 때 그 행 — 스크롤하고 강조한다(§7.9.8). 없으면 null */
  highlightItemId?: string | null;
  /** 저장·삭제 성공, 충돌 후 다시 불러오기 — 셸이 router.refresh 등으로 새 값을 받는다 */
  onChanged: () => void;
}

export default function ItemsView({
  projectId,
  version,
  view,
  table,
  items,
  years,
  currencyUnit,
  editable,
  highlightItemId = null,
  onChanged,
}: ItemsViewProps) {
  const [dialog, setDialog] = useState<DialogState | null>(null);
  const [deleting, setDeleting] = useState<ItemViewRow | null>(null);
  const [openEvidence, setOpenEvidence] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<Failure | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const rowRefs = useRef(new Map<string, HTMLTableRowElement>());

  useEffect(() => {
    if (notice === null) return;
    const timer = window.setTimeout(() => setNotice(null), NOTICE_MS);
    return () => window.clearTimeout(timer);
  }, [notice]);

  useEffect(() => {
    if (highlightItemId === null) return;
    rowRefs.current.get(highlightItemId)?.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }, [highlightItemId]);

  const confirmed = version.status === 'confirmed';
  // 확정 버전도 체크·메모는 고친다(AV-2 예외). 그 밖의 읽기 전용 사유(작성 중인데 editable=false)면 증빙도 닫는다
  const evidenceEditable = editable || confirmed;
  const money = (won: number): string => formatAmount(won, currencyUnit);

  const itemById = new Map(items.map((i) => [i.id, i]));
  // 수정 대화에는 version이 있는 원본 행을 넘긴다(O-1). 다시 불러온 뒤에도 같은 id로 최신 행을 찾는다
  const editingItem = dialog?.mode === 'edit' ? (itemById.get(dialog.id) ?? null) : null;

  async function runDelete(): Promise<void> {
    if (deleting === null) return;
    setBusy(true);
    setFailure(null);
    try {
      const res = await deleteAgreementItem(deleting.id);
      if (!res.ok) {
        setFailure({ message: res.error, code: res.code });
        return;
      }
      setNotice(`${deleting.yearName} · ${deleting.kindLabel} "${deleting.name}"을(를) 삭제했습니다.`);
      if (openEvidence === deleting.id) setOpenEvidence(null);
      setDeleting(null);
      onChanged();
    } catch (e) {
      setFailure({ message: `편성 항목을 삭제하지 못했습니다: ${e instanceof Error ? e.message : String(e)}` });
    } finally {
      setBusy(false);
    }
  }

  const readOnlyReason = confirmed
    ? `${AGREEMENT_VERSION_STATUS_LABELS.confirmed}된 버전이라 편성 항목은 고칠 수 없습니다 — [증빙]의 받음 체크와 메모만 바꿀 수 있습니다.`
    : '이 버전은 지금 읽기 전용입니다.';

  const actionColumn = evidenceEditable ? 1 : 0;
  const reconcileGroups = view.years.flatMap((y) => y.kinds.map((k) => ({ year: y, kind: k })));

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="space-y-0.5 text-t7 text-grey-500 print:text-black">
          <p className="flex items-center gap-1.5">
            <span>
              금액 표시 단위 {currencyUnit} · 금액은 {ITEM_AMOUNT_VAT_NOTE}. 증빙은 받음 여부만 기록하고 파일은
              첨부하지 않습니다.
            </span>
            <HelpLink slug="agreement" anchor="편성 항목·증빙" />
          </p>
          <p className="print:hidden">
            {editable ? '[편성 항목 추가]나 행의 [증빙]·[수정]·[삭제]로 고칩니다.' : readOnlyReason}
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
              편성 항목 추가
            </Button>
          )}
          <TableActions projectId={projectId} model={table} workbook={{ view: 'items', versionId: version.id }} />
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

      {view.rows.length === 0 ? (
        <p className="rounded-xl border border-dashed border-grey-300 bg-surface p-6 text-center text-t7 text-grey-500">
          {years.length === 0
            ? '이 과제에 연차가 없어 편성 항목을 넣을 수 없습니다. 과제 개요에서 단계·연차를 먼저 만드세요.'
            : editable
              ? '편성 항목이 없습니다. [편성 항목 추가]로 장비·재료·외주용역을 건별로 넣으세요.'
              : '편성 항목이 없습니다.'}
        </p>
      ) : (
        <div className={`overflow-x-auto rounded-xl border border-grey-200 bg-surface ${PRINT_TABLE_WRAP}`}>
          <table className={`w-full min-w-max text-xs ${PRINT_TABLE}`}>
            <caption className="sr-only">
              협약 예산 편성 항목 — {version.name}. 연차·종류·품명별 수량·금액(부가세 별도)·증빙 받음 수·규칙 경고, 연차
              소계와 합계.
            </caption>
            <thead className="text-grey-500 print:text-black">
              <tr className="border-b border-grey-100">
                {['연차', '종류', '품명'].map((label) => (
                  <th key={label} scope="col" className={`px-3 py-2 text-left font-medium ${PRINT_TH}`}>
                    {label}
                  </th>
                ))}
                {['수량', '금액'].map((label) => (
                  <th key={label} scope="col" className={`px-3 py-2 text-right font-medium ${PRINT_TH}`}>
                    {label}
                  </th>
                ))}
                <th scope="col" className={`px-3 py-2 text-left font-medium ${PRINT_TH}`}>
                  증빙
                </th>
                <th scope="col" className={`px-3 py-2 text-left font-medium ${PRINT_TH}`}>
                  경고
                </th>
                {evidenceEditable && (
                  <th scope="col" className="px-3 py-2 print:hidden">
                    <span className="sr-only">작업</span>
                  </th>
                )}
              </tr>
            </thead>

            {view.years.map((group) => (
              <tbody key={group.yearId} className="divide-y divide-grey-100 border-b border-grey-200">
                {group.kinds.flatMap((k) => k.rows).map((row) => {
                  const raw = itemById.get(row.id);
                  const expanded = openEvidence === row.id && raw !== undefined;
                  const highlighted = highlightItemId === row.id;
                  return (
                    <Fragment key={row.id}>
                      <tr
                        ref={(el) => {
                          if (el === null) rowRefs.current.delete(row.id);
                          else rowRefs.current.set(row.id, el);
                        }}
                        data-item-id={row.id}
                        className={highlighted ? 'bg-blue-50 ring-2 ring-inset ring-blue-300 print:bg-transparent print:ring-0' : ''}
                      >
                        <td className={`px-3 py-1.5 text-grey-700 ${PRINT_TD}`}>{row.yearName}</td>
                        <td className={`px-3 py-1.5 text-grey-700 ${PRINT_TD}`}>{row.kindLabel}</td>
                        <th
                          scope="row"
                          className={`max-w-[20rem] truncate px-3 py-1.5 text-left font-medium text-grey-800 print:max-w-none print:whitespace-normal ${PRINT_TD}`}
                          title={row.name}
                        >
                          {row.name}
                        </th>
                        <td
                          className={`px-3 py-1.5 text-right tabular-nums ${
                            row.quantity === null ? 'text-grey-400' : 'text-grey-700'
                          } ${PRINT_TD}`}
                        >
                          {formatQuantity(row.quantity)}
                        </td>
                        <td className={`px-3 py-1.5 text-right tabular-nums text-grey-800 ${PRINT_TD}`}>
                          {money(row.amount)}
                        </td>
                        <td
                          className={`whitespace-nowrap px-3 py-1.5 tabular-nums ${
                            row.progress.total > 0 && row.progress.obtained === row.progress.total
                              ? 'text-green-600'
                              : 'text-grey-700'
                          } print:text-black ${PRINT_TD}`}
                        >
                          {row.progressText}
                        </td>
                        <td className={`px-3 py-1.5 ${PRINT_TD}`}>
                          <FindingBadge row={row} />
                        </td>
                        {evidenceEditable && (
                          <td className="whitespace-nowrap px-2 py-1 text-right print:hidden">
                            <Button
                              size="sm"
                              variant="ghost"
                              disabled={busy || raw === undefined}
                              onClick={() => {
                                setFailure(null);
                                setOpenEvidence(expanded ? null : row.id);
                              }}
                              aria-expanded={expanded}
                              aria-label={`${row.name} 증빙 ${expanded ? '접기' : '펼치기'}`}
                            >
                              증빙
                            </Button>
                            {editable && (
                              <>
                                <Button
                                  size="sm"
                                  variant="ghost"
                                  disabled={busy}
                                  onClick={() => {
                                    setFailure(null);
                                    setDialog({ mode: 'edit', id: row.id });
                                  }}
                                  aria-label={`${row.name} 수정`}
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
                                  aria-label={`${row.name} 삭제`}
                                >
                                  삭제
                                </Button>
                              </>
                            )}
                          </td>
                        )}
                      </tr>
                      {expanded && (
                        <tr className="print:hidden">
                          <td colSpan={DATA_COLUMNS + actionColumn} className="px-3 py-2">
                            <EvidenceEditor
                              // 다른 행으로 바꾸면 입력을 섞지 않도록 새로 시작한다
                              key={row.id}
                              item={raw}
                              confirmed={confirmed}
                              onSaved={() => {
                                setNotice(`"${row.name}"의 증빙을 저장했습니다.`);
                                onChanged();
                              }}
                              onReload={onChanged}
                              onClose={() => setOpenEvidence(null)}
                            />
                          </td>
                        </tr>
                      )}
                    </Fragment>
                  );
                })}
                {group.itemCount > 0 && (
                  <tr className="bg-grey-50 print:bg-transparent">
                    <th
                      scope="row"
                      colSpan={4}
                      className={`px-3 py-1.5 text-left font-medium text-grey-700 ${PRINT_TH}`}
                    >
                      {group.yearName} 소계 ({group.itemCount.toLocaleString('ko-KR')}건)
                    </th>
                    <td className={`px-3 py-1.5 text-right font-semibold tabular-nums text-grey-900 ${PRINT_TD}`}>
                      {money(group.amount)}
                    </td>
                    <td colSpan={2} className={PRINT_TD} />
                    {evidenceEditable && <td className="print:hidden" />}
                  </tr>
                )}
              </tbody>
            ))}

            <tfoot className="border-t-2 border-grey-200 bg-grey-50 print:bg-transparent">
              <tr>
                <th scope="row" colSpan={4} className={`px-3 py-2 text-left font-semibold text-grey-800 ${PRINT_TH}`}>
                  합계 ({view.grandTotal.itemCount.toLocaleString('ko-KR')}건)
                </th>
                <td className={`px-3 py-2 text-right font-semibold tabular-nums text-grey-900 ${PRINT_TD}`}>
                  {money(view.grandTotal.amount)}
                </td>
                <td colSpan={2} className={PRINT_TD} />
                {evidenceEditable && <td className="print:hidden" />}
              </tr>
            </tfoot>
          </table>
        </div>
      )}

      {reconcileGroups.length > 0 && (
        <section
          aria-label="금액 줄 대조"
          className={`space-y-2 rounded-xl border p-3 print:border-grey-400 ${
            view.hasDifference ? 'border-orange-200 bg-orange-50' : 'border-grey-200 bg-surface'
          }`}
        >
          <div className="text-t7">
            <p className={`font-semibold ${view.hasDifference ? 'text-orange-800' : 'text-grey-800'}`}>
              금액 줄 대조 —{' '}
              {view.hasDifference ? '편성 항목 합과 금액 줄이 다른 연차·종류가 있습니다' : '차이 없음'}
            </p>
            <p className="text-grey-500 print:text-black">
              차이 = 편성 항목 합 − 대응 세목 금액 줄(현금 + 현물). 표시만 합니다 — 어느 쪽도 자동으로 고치지 않고,
              편성 항목 금액은 다른 보기의 합계에 더하지 않습니다.
            </p>
          </div>
          <div className={`overflow-x-auto ${PRINT_TABLE_WRAP}`}>
            <table className={`w-full min-w-max text-xs ${PRINT_TABLE}`}>
              <caption className="sr-only">연차·종류별 편성 항목 합, 대응 세목 금액 줄 합, 차이</caption>
              <thead className="text-grey-500 print:text-black">
                <tr className="border-b border-grey-200">
                  {['연차', '종류', '대응 세목'].map((label) => (
                    <th key={label} scope="col" className={`px-3 py-1.5 text-left font-medium ${PRINT_TH}`}>
                      {label}
                    </th>
                  ))}
                  {['편성 항목 합', '금액 줄', '차이'].map((label) => (
                    <th key={label} scope="col" className={`px-3 py-1.5 text-right font-medium ${PRINT_TH}`}>
                      {label}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {reconcileGroups.map(({ year, kind }) => (
                  <tr key={`${year.yearId}-${kind.kind}`} className="border-t border-grey-100">
                    <th scope="row" className={`px-3 py-1.5 text-left font-medium text-grey-800 ${PRINT_TH}`}>
                      {year.yearName}
                    </th>
                    <td className={`px-3 py-1.5 text-grey-700 ${PRINT_TD}`}>{kind.kindLabel}</td>
                    <td className={`px-3 py-1.5 text-grey-700 ${PRINT_TD}`}>{kind.subcategoryLabel}</td>
                    <td className={`px-3 py-1.5 text-right tabular-nums text-grey-700 ${PRINT_TD}`}>
                      {money(kind.itemsTotal)}
                    </td>
                    <td
                      className={`px-3 py-1.5 text-right tabular-nums ${
                        kind.lineTotal === null ? 'text-grey-400' : 'text-grey-700'
                      } ${PRINT_TD}`}
                      title={kind.lineTotal === null ? '대응 세목 금액 줄이 없습니다' : undefined}
                    >
                      {kind.lineTotal === null ? NONE : money(kind.lineTotal)}
                    </td>
                    <td
                      className={`px-3 py-1.5 text-right tabular-nums ${
                        kind.matches ? 'text-grey-500' : 'font-semibold text-orange-700'
                      } ${PRINT_TD}`}
                    >
                      {kind.matches ? '일치' : kind.diff > 0 ? `+${money(kind.diff)}` : money(kind.diff)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {dialog !== null && (
        <ItemDialog
          // 다른 행으로 바꾸면 입력을 섞지 않도록 새로 시작한다
          key={dialog.mode === 'edit' ? dialog.id : 'new'}
          versionId={version.id}
          item={dialog.mode === 'edit' ? editingItem : null}
          removed={dialog.mode === 'edit' && editingItem === null}
          years={years}
          currencyUnit={currencyUnit}
          onClose={() => setDialog(null)}
          onSaved={(saved) => {
            setDialog(null);
            setNotice(
              dialog.mode === 'edit'
                ? `"${saved.name}"을(를) 수정했습니다.`
                : `"${saved.name}"을(를) 추가했습니다 — 증빙 기본 목록 ${saved.evidence.length.toLocaleString('ko-KR')}개가 함께 만들어졌습니다.`
            );
            onChanged();
          }}
          onReload={onChanged}
        />
      )}

      {deleting !== null && (
        <Modal
          open
          title="편성 항목 삭제"
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
            {deleting.yearName} · {deleting.kindLabel} &ldquo;{deleting.name}&rdquo;({money(deleting.amount)})을(를)
            삭제합니다. 증빙 기록({deleting.progressText})도 함께 지워지며 되돌릴 수 없습니다. 금액 줄은 바뀌지
            않습니다.
          </p>
        </Modal>
      )}
    </div>
  );
}

/**
 * 건의 RL-17~RL-19 경고 배지. 가장 무거운 severity의 색, 문장은 툴팁과 스크린리더 글자로.
 * 경고가 없으면 비운다 — "경고 0"을 찍으면 판정 결과가 있는 것처럼 읽힌다.
 */
function FindingBadge({ row }: { row: ItemViewRow }) {
  if (row.findings.length === 0) return null;
  const top = row.findings.reduce((a, f) => (SEVERITY_RANK[f.severity] < SEVERITY_RANK[a] ? f.severity : a), row.findings[0]!.severity);
  const messages = row.findings.map((f) => f.message).join('\n');
  return (
    <Badge tone={SEVERITY_TONE[top]} title={messages} className="print:bg-transparent print:p-0 print:text-black">
      경고 {row.findings.length.toLocaleString('ko-KR')}
      <span className="sr-only">: {messages}</span>
    </Badge>
  );
}
