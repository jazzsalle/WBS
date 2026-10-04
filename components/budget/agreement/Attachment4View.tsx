'use client';

// 협약 예산 붙임4형 보기 — 8-1 지원·부담계획 + 8-2 사용계획 + 검토사항 (SOT §6.19 AG-3, §7.9.8 "붙임4형 보기", 부록 C.4)
//
// 숫자·비율·판정·"—"의 사유는 전부 서버(getAgreementData → lib/agreement/attachment4-view)가 만든 모델이다 —
// 이 파일에는 금액 덧셈도 비율 계산도 없다(파생 값은 한 곳에서만 계산한다, AG-1).
//  - 양식 전용 저장 칸은 없다: 8-2 칸 편집은 금액 줄을, 8-1 정부지원 현금은 §5.25 행을 고친다
//  - 작성 중 버전만 편집한다(AV-2). 8-2는 데이터 행 × 연차 칸만(단계·합계 열, 집계·비율·양식 밖 행은 불가 — S-12)
//  - "—"는 사유가 있다(줄 없음·소스 없음·분모 0·정부지원 현금 미입력·초과) — 칸 툴팁과 검토사항에 그대로 보인다
//  - 실패: RULE·VALIDATION 등은 배너(서버 문구 그대로, 줄바꿈 유지), STALE은 ConflictDialog(O-3)
//
// 인쇄 머리말·가로 방향은 셸(AgreementScreen)의 몫이다. 편집 컨트롤은 종이에 남기지 않고 값만 남긴다(P-R4).

import { useEffect, useState } from 'react';
import type { ActionResult, DetailAxis, Settings } from '@/types';
import type { ActionErrorCode } from '@/lib/db/errors';
import type { AgreementVersionView } from '@/actions/agreement';
import { setAgreementFormCellAmount, setAgreementGovCash } from '@/actions/agreement';
import type { Form81Row, Form82Row, FormViewCell, RatioJudgement } from '@/lib/agreement/attachment4-view';
import type { FormColumn } from '@/lib/agreement/form-rows';
import type { Form82RuleCell, Form82RuleView } from '@/lib/agreement/rule-view';
import { formatRate, RATE_NONE_TEXT, type Rate } from '@/lib/agreement/rates';
import { AGREEMENT_VERSION_STATUS_LABELS, AGREEMENT_VIEW_TEXT, ATTACHMENT8_1_COLUMNS } from '@/lib/constants';
import { formatAmount } from '@/lib/currency';
import ConflictDialog from '@/components/ui/ConflictDialog';
import ErrorBanner from '@/components/ui/ErrorBanner';
import HelpLink from '@/components/help/HelpLink';
import { PRINT_TABLE, PRINT_TABLE_WRAP, PRINT_TD, PRINT_TH } from '@/components/print/tokens';
import { setRealtimePaused } from '@/components/RealtimeRefresher';
import TableActions from './TableActions';

const NO_LINE_TITLE = '금액 줄이 없습니다(0원과 다릅니다)';

interface Failure {
  message: string;
  code?: ActionErrorCode;
}

/** 저장 결과 — 'unchanged'는 서버가 쓸 것이 없다고 답한 경우(noop). 조용히 닫는다 */
type SaveOutcome = 'saved' | 'unchanged' | 'failed';

// ─── 칸 표시 (조정회의형도 같은 칸 모델을 쓴다) ────────────────────────────────

/** 보기 칸 하나의 글자와 툴팁. "—"에는 언제나 이유가 붙는다 */
export function formCellText(
  cell: FormViewCell,
  currencyUnit: Settings['currencyUnit']
): { text: string; title: string | undefined; muted: boolean } {
  switch (cell.kind) {
    case 'amount':
      return { text: formatAmount(cell.value, currencyUnit), title: undefined, muted: false };
    case 'empty':
      return { text: RATE_NONE_TEXT, title: NO_LINE_TITLE, muted: true };
    case 'none':
      return { text: RATE_NONE_TEXT, title: cell.reason, muted: true };
    case 'rate':
      return {
        text: cell.text,
        title: cell.rate.value === null ? cell.rate.reason : undefined,
        muted: cell.rate.value === null,
      };
  }
}

export function FormCell({
  cell,
  currencyUnit,
  strong = false,
}: {
  cell: FormViewCell;
  currencyUnit: Settings['currencyUnit'];
  strong?: boolean;
}) {
  const { text, title, muted } = formCellText(cell, currencyUnit);
  return (
    <span
      title={title}
      className={`block px-1.5 py-1 tabular-nums print:text-black ${
        muted ? 'text-grey-400' : strong ? 'font-semibold text-grey-900' : 'text-grey-700'
      }`}
    >
      {text}
    </span>
  );
}

function amountText(value: number | null, currencyUnit: Settings['currencyUnit']): string {
  return value === null ? RATE_NONE_TEXT : formatAmount(value, currencyUnit);
}

// ─── 편집 칸 ──────────────────────────────────────────────────────────────────

/**
 * 누르면 원 단위 입력이 열리는 칸(B-4 — 입력은 언제나 원 단위 정수).
 * `allowEmpty`면 빈 입력이 "미입력"(null) 저장이다(8-1 정부지원 현금 — §5.25). 아니면 빈 입력은 취소다 —
 * 빈칸을 0원 저장으로 눙치지 않는다(줄 없음과 0원은 다르다).
 * 저장이 실패하면 입력값을 지우지 않고 열어 둔다 — 고쳐서 다시 보내거나 Esc로 버린다.
 */
function EditableAmount({
  value,
  displayText,
  displayTitle,
  label,
  disabled,
  allowEmpty,
  onSave,
}: {
  /** 편집의 출발값(저장된 값). null = 줄 없음 또는 미입력 */
  value: number | null;
  /** 편집 중이 아닐 때 보일 글자 — 저장값과 표시값이 다를 수 있다(정부지원 현금 초과 → "—") */
  displayText: string;
  displayTitle: string | undefined;
  label: string;
  disabled: boolean;
  allowEmpty: boolean;
  onSave: (amount: number | null) => Promise<SaveOutcome>;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const [invalid, setInvalid] = useState(false);
  // 저장은 됐지만 새 모델이 아직 내려오지 않은 동안 — 옛 값이 잠깐 되살아나 보이지 않게 흐리게 둔다
  const [pending, setPending] = useState(false);
  // 방금 실패한 입력값. 충돌 대화·배너로 포커스가 빠질 때(blur) 같은 값을 다시 보내지 않게 한다
  const [failedDraft, setFailedDraft] = useState<string | null>(null);

  useEffect(() => {
    setPending(false);
  }, [value, displayText]);

  // R-4: 칸을 고치는 동안 자동 새로고침을 보류한다 — 입력하던 값이 덮이지 않게
  useEffect(() => {
    if (!editing) return;
    setRealtimePaused(true);
    return () => setRealtimePaused(false);
  }, [editing]);

  const open = (): void => {
    setDraft(value === null ? '' : String(value));
    setInvalid(false);
    setFailedDraft(null);
    setEditing(true);
  };

  const cancel = (): void => {
    setEditing(false);
    setInvalid(false);
  };

  const commit = async (): Promise<void> => {
    const trimmed = draft.trim();
    let next: number | null;
    if (trimmed === '') {
      if (!allowEmpty) {
        cancel();
        return;
      }
      next = null;
    } else {
      next = Number(trimmed);
      if (!Number.isSafeInteger(next) || next < 0) {
        setInvalid(true);
        return;
      }
    }
    if (next === value) {
      cancel();
      return;
    }
    setInvalid(false);
    const outcome = await onSave(next);
    if (outcome === 'failed') {
      setFailedDraft(draft);
      return;
    }
    setPending(outcome === 'saved');
    setEditing(false);
  };

  if (!editing) {
    return (
      <>
        <button
          type="button"
          onClick={open}
          disabled={disabled}
          aria-label={`${label} 고치기`}
          title={displayTitle ?? '눌러서 금액(원)을 고칩니다'}
          className={`w-full rounded-md px-1.5 py-1 text-right tabular-nums hover:bg-grey-100 disabled:cursor-not-allowed print:hidden ${
            displayText === RATE_NONE_TEXT ? 'text-grey-400' : 'text-grey-800'
          } ${pending ? 'opacity-60' : ''}`}
        >
          {displayText}
        </button>
        <span className="hidden tabular-nums print:inline">{displayText}</span>
      </>
    );
  }

  return (
    <span className="inline-flex flex-col items-end gap-0.5 print:hidden">
      <span className="inline-flex items-center gap-1">
        <input
          type="number"
          inputMode="numeric"
          min={0}
          step={1}
          autoFocus
          value={draft}
          disabled={disabled}
          placeholder={allowEmpty ? '미입력' : RATE_NONE_TEXT}
          aria-label={`${label}(원)`}
          onChange={(e) => {
            setDraft(e.target.value);
            setInvalid(false);
            setFailedDraft(null);
          }}
          onBlur={() => {
            if (!disabled && draft !== failedDraft) void commit();
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              void commit();
            }
            if (e.key === 'Escape') {
              e.preventDefault();
              cancel();
            }
          }}
          className={`w-28 rounded-md border px-1.5 py-1 text-right text-xs tabular-nums focus:outline-none ${
            invalid ? 'border-red-400 bg-red-50' : 'border-grey-300 bg-surface focus:border-grey-500'
          }`}
        />
        <span className="text-[10px] text-grey-400">원</span>
      </span>
      {invalid && <span className="text-[10px] text-red-600">0 이상 정수(원)만 저장됩니다.</span>}
      {allowEmpty && <span className="text-[10px] text-grey-400">비우면 미입력으로 저장됩니다.</span>}
    </span>
  );
}

// ─── 판정 배지 ────────────────────────────────────────────────────────────────

function JudgementBadge({ judgement }: { judgement: RatioJudgement }) {
  if (judgement.status === 'skipped') {
    return (
      <span className="block text-[10px] leading-tight text-grey-500 print:text-black">
        <span className="rounded bg-grey-100 px-1 py-0.5 font-medium text-grey-600 print:bg-transparent print:text-black">
          {judgement.label}
        </span>{' '}
        {judgement.reason}
      </span>
    );
  }
  const fail = judgement.status === 'fail';
  return (
    <span
      title={`실제 ${formatRate(judgement.actual)} · 한도 ${formatRate(judgement.limit)}`}
      className={`inline-block rounded px-1 py-0.5 text-[10px] font-semibold print:bg-transparent print:text-black ${
        fail ? 'bg-red-50 text-red-700' : 'bg-green-50 text-green-700'
      }`}
    >
      {judgement.label} · 한도 {formatRate(judgement.limit)}
    </span>
  );
}

function RateWithJudgement({ rate, judgement }: { rate: Rate; judgement: RatioJudgement }) {
  return (
    <span className="flex flex-col items-end gap-0.5 px-1.5 py-1">
      <span
        title={rate.value === null ? rate.reason : undefined}
        className={`tabular-nums print:text-black ${rate.value === null ? 'text-grey-400' : 'font-semibold text-grey-900'}`}
      >
        {formatRate(rate)}
      </span>
      <JudgementBadge judgement={judgement} />
    </span>
  );
}

// ─── 8-2 규칙 판정 줄 (S-15) ──────────────────────────────────────────────────

/** 판정 줄 한 칸. 글자·한도·사유는 서버가 같은 evaluateRules 결과에서 옮긴 것 — 여기서 비교하지 않는다 */
function Form82RuleCellView({ cell }: { cell: Form82RuleCell }) {
  if (cell.status === 'skipped') {
    return (
      <span className="block text-[10px] leading-tight text-grey-500 print:text-black">
        <span className="rounded bg-grey-100 px-1 py-0.5 font-medium text-grey-600 print:bg-transparent print:text-black">
          {cell.label}
        </span>{' '}
        {cell.reason}
      </span>
    );
  }
  const fail = cell.status === 'fail';
  return (
    <span className="flex flex-col items-end gap-0.5">
      <span className="font-semibold tabular-nums text-grey-900 print:text-black">{formatRate(cell.actual)}</span>
      <span
        title={fail ? cell.message : `실제 ${formatRate(cell.actual)} · 한도 ${formatRate(cell.limit)}`}
        className={`inline-block rounded px-1 py-0.5 text-[10px] font-semibold print:bg-transparent print:text-black ${
          fail ? 'bg-red-50 text-red-700' : 'bg-green-50 text-green-700'
        }`}
      >
        {cell.label} · 한도 {formatRate(cell.limit)}
      </span>
    </span>
  );
}

function Form82RuleLines({ rules, yearColumns }: { rules: Form82RuleView; yearColumns: readonly FormColumn[] }) {
  const yearName = new Map(yearColumns.map((c) => [c.key, c.label]));
  return (
    <section className="space-y-1.5">
      <h3 className="flex items-center gap-1.5 text-t6 font-semibold text-grey-800 print:text-black">
        8-2 규칙 판정
        <span className="text-t7 font-normal text-grey-500 print:text-black">
          · 아래 규칙 검증 패널과 같은 판정 결과입니다
        </span>
      </h3>
      <div className={`overflow-x-auto rounded-xl border border-grey-200 bg-surface ${PRINT_TABLE_WRAP}`}>
        <table className={`w-full min-w-max text-xs ${PRINT_TABLE}`}>
          <caption className="sr-only">8-2 규칙 판정 — 연차별 통과·경고·판정하지 않음</caption>
          <thead className="text-grey-500 print:text-black">
            <tr className="border-b border-grey-100">
              <th scope="col" className={`px-3 py-2 text-left font-medium ${PRINT_TH}`}>
                규칙
              </th>
              {(rules.lines[0]?.years ?? []).map((y) => (
                <th
                  key={y.yearId}
                  scope="col"
                  className={`border-l border-grey-100 px-3 py-2 text-right font-medium text-grey-700 ${PRINT_TH}`}
                >
                  {/* 8-2 열에 없는 연차라면 id를 보이지 않는다 — 원시 코드 노출 금지 */}
                  {yearName.get(y.yearId) ?? '(연차 이름 없음)'}
                </th>
              ))}
              <th
                scope="col"
                className={`border-l border-grey-200 px-3 py-2 text-right font-medium text-grey-700 ${PRINT_TH}`}
                title="전 연차 합계 비율 — 참고값이며 판정하지 않습니다 (RL-2)"
              >
                합계(참고)
              </th>
            </tr>
          </thead>
          <tbody className="divide-y divide-grey-100">
            {rules.lines.map((line) => (
              <tr key={line.code}>
                <th scope="row" className={`px-3 py-1.5 text-left align-top font-medium text-grey-800 ${PRINT_TD}`}>
                  <span className="block">{line.label}</span>
                  {line.baseLabel !== null && (
                    <span className="block text-[11px] font-normal text-grey-500 print:text-black">
                      분모: {line.baseLabel}
                    </span>
                  )}
                </th>
                {line.years.map((y) => (
                  <td key={y.yearId} className={`border-l border-grey-100 px-2 py-1.5 text-right align-top ${PRINT_TD}`}>
                    <Form82RuleCellView cell={y.cell} />
                  </td>
                ))}
                <td className={`border-l border-grey-200 px-2 py-1.5 text-right align-top tabular-nums text-grey-700 ${PRINT_TD}`}>
                  {formatRate(line.totalActual)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="text-[11px] text-grey-500 print:text-black">{rules.note}</p>
    </section>
  );
}

// ─── 8-1 ──────────────────────────────────────────────────────────────────────

type Form81AmountId =
  | 'gov_cash'
  | 'own_cash'
  | 'own_in_kind'
  | 'own_subtotal'
  | 'other_cash'
  | 'other_in_kind'
  | 'other_subtotal'
  | 'total_cash'
  | 'total_in_kind'
  | 'total';

const FORM81_AMOUNT_IDS: readonly Form81AmountId[] = [
  'gov_cash', 'own_cash', 'own_in_kind', 'own_subtotal',
  'other_cash', 'other_in_kind', 'other_subtotal',
  'total_cash', 'total_in_kind', 'total',
];

function column81(id: string) {
  const def = ATTACHMENT8_1_COLUMNS.find((c) => c.id === id);
  // 부록 C.4.2 상수와 이 화면이 어긋나면 머리가 틀린 표가 된다 — 조용히 넘기지 않는다
  if (def === undefined) throw new Error(`부록 C.4.2에 없는 8-1 열입니다 (${id}).`);
  return def;
}

/** 머리 1행: 같은 groupLabel이 이어지면 한 칸으로 묶는다(양식 머리 모양) */
function form81Groups(): { label: string; span: number }[] {
  const groups: { label: string; span: number }[] = [];
  for (const id of FORM81_AMOUNT_IDS) {
    const label = column81(id).groupLabel ?? '';
    const last = groups[groups.length - 1];
    if (last !== undefined && last.label === label) last.span += 1;
    else groups.push({ label, span: 1 });
  }
  return groups;
}

function value81(row: Form81Row, id: Form81AmountId): number | null {
  switch (id) {
    case 'gov_cash': return row.govCash;
    case 'own_cash': return row.ownCash;
    case 'own_in_kind': return row.ownInKind;
    case 'own_subtotal': return row.ownSubtotal;
    case 'other_cash': return row.otherCash;
    case 'other_in_kind': return row.otherInKind;
    case 'other_subtotal': return row.otherSubtotal;
    case 'total_cash': return row.totalCash;
    case 'total_in_kind': return row.totalInKind;
    case 'total': return row.total;
  }
}

/** A·B·D가 "—"인 이유 — 정부지원 현금 미입력·초과면 비율 사유와 같다(모델이 같은 문구를 싣는다) */
function govUnusableReason(row: Form81Row): string | null {
  if (row.govCashStatus === 'ok') return null;
  return row.govShare.value === null ? row.govShare.reason : null;
}

// ─── 8-2 ──────────────────────────────────────────────────────────────────────

/** 같은 라벨이 이어지는 행(A 현금/현물, D 일반/통합관리)은 항목 칸을 하나로 묶는다 */
function labelSpans(rows: readonly Form82Row[]): number[] {
  const spans = rows.map(() => 0);
  let i = 0;
  while (i < rows.length) {
    let j = i + 1;
    while (j < rows.length && rows[j]!.label === rows[i]!.label && rows[j]!.subLabel !== null) j += 1;
    spans[i] = j - i;
    i = j;
  }
  return spans;
}

function columnTone(col: FormColumn): string {
  return col.kind === 'year' ? '' : 'bg-grey-50 print:bg-transparent';
}

// ─── 화면 ─────────────────────────────────────────────────────────────────────

export interface Attachment4ViewProps {
  projectId: string;
  view: AgreementVersionView;
  currencyUnit: Settings['currencyUnit'];
  /** 작성 중 버전을 보고 있을 때만 true(AG-3·AV-2). 서버도 확정 버전 편집을 RULE로 거부한다 */
  editable: boolean;
  /** 저장 성공·충돌 후 다시 불러오기 — 셸이 router.refresh 등으로 새 모델을 받는다 */
  onChanged: () => void;
}

export default function Attachment4View({ projectId, view, currencyUnit, editable, onChanged }: Attachment4ViewProps) {
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<Failure | null>(null);
  const [conflict, setConflict] = useState<string | null>(null);

  const version = view.version;
  const { plan81, plan82, reviewNotes } = view.attachment4.view;

  async function run<T extends { kind: string }>(
    action: () => Promise<ActionResult<T>>,
    what: string
  ): Promise<SaveOutcome> {
    setBusy(true);
    setFailure(null);
    try {
      const res = await action();
      if (!res.ok) {
        if (res.code === 'STALE') setConflict(res.error);
        else setFailure({ message: res.error, code: res.code });
        return 'failed';
      }
      if (res.data.kind === 'noop') return 'unchanged';
      onChanged();
      return 'saved';
    } catch (e) {
      // 네트워크 단절 등 — 저장됐는지 모르는 채로 넘어가지 않는다
      setFailure({ message: `${what}을 저장하지 못했습니다: ${e instanceof Error ? e.message : String(e)}` });
      return 'failed';
    } finally {
      setBusy(false);
    }
  }

  const saveFormCell = (yearId: string, row: Form82Row, amount: number | null): Promise<SaveOutcome> => {
    // 8-2 칸은 빈 입력을 취소로 처리하므로 여기까지 null이 오지 않는다
    if (amount === null) return Promise.resolve('unchanged');
    const axis: DetailAxis | null = row.axis;
    return run(() => setAgreementFormCellAmount(version.id, { yearId, rowId: row.rowId, axis, amount }), '금액');
  };

  const saveGovCash = (yearId: string, amount: number | null): Promise<SaveOutcome> =>
    run(() => setAgreementGovCash(version.id, yearId, amount), '정부지원 현금');

  const readOnlyReason =
    version.status === 'confirmed'
      ? `${AGREEMENT_VERSION_STATUS_LABELS.confirmed}된 버전이라 금액을 고칠 수 없습니다. 버전 정보는 [버전 정보]에서 고칠 수 있습니다.`
      : '이 버전은 지금 읽기 전용입니다.';

  const spans = labelSpans(plan82.rows);
  const groups81 = form81Groups();

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="space-y-0.5 text-t7 text-grey-500 print:text-black">
          <p className="flex items-center gap-1.5">
            <span>
              금액 표시 단위 {currencyUnit} · {RATE_NONE_TEXT}는 값이 없는 칸입니다(0원과 다릅니다 — 칸에 마우스를 올리면 이유가
              보입니다).
            </span>
            <HelpLink slug="agreement" anchor="붙임4형 — 8-2 사용계획" />
          </p>
          {editable ? (
            <p className="print:hidden">
              8-1의 정부지원 현금, 8-2의 데이터 행 × 연차 칸을 눌러 원 단위로 고칩니다. 소계·비율·단계·합계 칸은 계산된 값입니다.
            </p>
          ) : (
            <p className="print:hidden">{readOnlyReason}</p>
          )}
        </div>
        <TableActions
          projectId={projectId}
          model={[view.attachment4.tables.plan81, view.attachment4.tables.plan82]}
          workbook={{ view: 'attachment4', versionId: version.id }}
        />
      </div>

      {failure !== null && (
        <ErrorBanner
          message={failure.message}
          code={failure.code}
          className="whitespace-pre-line print:hidden"
          onDismiss={() => setFailure(null)}
        />
      )}

      {/* ① 8-1 지원·부담계획 */}
      <section className="space-y-2">
        <h3 className="flex items-center gap-1.5 text-t6 font-semibold text-grey-800 print:text-black">
          8-1 지원·부담계획
          <HelpLink slug="agreement" anchor="붙임4형 — 8-1 지원·부담계획" />
        </h3>
        {plan81.rows.length <= 1 ? (
          <p className="rounded-xl border border-dashed border-grey-300 bg-surface p-6 text-center text-t7 text-grey-500">
            이 과제에 연차가 없어 8-1을 채울 수 없습니다. 과제 개요에서 단계·연차를 먼저 만드세요.
          </p>
        ) : (
          <div className={`overflow-x-auto rounded-xl border border-grey-200 bg-surface ${PRINT_TABLE_WRAP}`}>
            <table className={`w-full min-w-max text-xs ${PRINT_TABLE}`}>
              <caption className="sr-only">
                붙임4 8-1 지원·부담계획 — {version.name}. 연차별 행과 합계 행. 값이 없는 칸은 {RATE_NONE_TEXT}.
              </caption>
              <thead className="text-grey-500 print:text-black">
                <tr className="border-b border-grey-100">
                  <th scope="col" rowSpan={2} className={`px-3 py-2 text-left font-medium ${PRINT_TH}`}>
                    연차
                  </th>
                  <th scope="col" rowSpan={2} className={`px-3 py-2 text-left font-medium ${PRINT_TH}`}>
                    {column81('company_type').label}
                  </th>
                  {groups81.map((g) => (
                    <th
                      key={g.label}
                      scope="colgroup"
                      colSpan={g.span}
                      className={`border-l border-grey-100 px-3 py-2 text-center font-medium text-grey-700 ${PRINT_TH}`}
                    >
                      {g.label}
                    </th>
                  ))}
                  <th
                    scope="colgroup"
                    colSpan={2}
                    className={`border-l border-grey-200 px-3 py-2 text-center font-medium text-grey-700 ${PRINT_TH}`}
                  >
                    {column81('gov_share_review').groupLabel}
                  </th>
                </tr>
                <tr className="border-b border-grey-100">
                  {FORM81_AMOUNT_IDS.map((id) => (
                    <th key={id} scope="col" className={`px-3 py-1.5 text-right font-medium ${PRINT_TH}`}>
                      {column81(id).label}
                    </th>
                  ))}
                  <th scope="col" className={`border-l border-grey-200 px-3 py-1.5 text-right font-medium ${PRINT_TH}`}>
                    {column81('gov_share_review').label}(A/H)
                  </th>
                  <th scope="col" className={`px-3 py-1.5 text-right font-medium ${PRINT_TH}`}>
                    {column81('own_cash_review').label}(B/D)
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-grey-100">
                {plan81.rows.map((row) => {
                  const isTotal = row.kind === 'total';
                  const reason = govUnusableReason(row);
                  return (
                    <tr
                      key={row.key}
                      className={isTotal ? 'border-t-2 border-t-grey-200 bg-grey-50 print:bg-transparent' : ''}
                    >
                      <th
                        scope="row"
                        className={`px-3 py-1.5 text-left ${isTotal ? 'font-semibold text-grey-800' : 'font-medium text-grey-800'} ${PRINT_TD}`}
                      >
                        {row.label}
                      </th>
                      <td className={`px-3 py-1.5 text-left text-grey-700 ${PRINT_TD}`}>{row.companyType}</td>
                      {FORM81_AMOUNT_IDS.map((id) => {
                        const value = value81(row, id);
                        const title = value === null ? (reason ?? undefined) : undefined;
                        if (id === 'gov_cash' && editable && !isTotal) {
                          // 편집 출발값은 저장된 입력값이다 — 초과라 "—"로 보여도 고칠 값은 남아 있다
                          const shown = amountText(value, currencyUnit);
                          return (
                            <td key={id} className={`border-l border-grey-100 px-1.5 py-1 text-right ${PRINT_TD}`}>
                              <EditableAmount
                                value={row.govCashInput}
                                displayText={shown}
                                displayTitle={
                                  reason === null
                                    ? undefined
                                    : row.govCashInput === null
                                      ? reason
                                      : `${reason} (입력값 ${formatAmount(row.govCashInput, currencyUnit)})`
                                }
                                label={`${row.label} 정부지원 현금`}
                                disabled={busy}
                                allowEmpty
                                onSave={(amount) => saveGovCash(row.key, amount)}
                              />
                            </td>
                          );
                        }
                        return (
                          <td
                            key={id}
                            className={`px-1.5 py-1 text-right ${id === 'gov_cash' ? 'border-l border-grey-100' : ''} ${PRINT_TD}`}
                          >
                            <span
                              title={title}
                              className={`block px-1.5 py-1 tabular-nums print:text-black ${
                                value === null
                                  ? 'text-grey-400'
                                  : isTotal || id === 'total'
                                    ? 'font-semibold text-grey-900'
                                    : 'text-grey-700'
                              }`}
                            >
                              {amountText(value, currencyUnit)}
                            </span>
                          </td>
                        );
                      })}
                      <td className={`border-l border-grey-200 text-right ${PRINT_TD}`}>
                        <RateWithJudgement rate={row.govShare} judgement={row.govShareJudgement} />
                      </td>
                      <td className={`text-right ${PRINT_TD}`}>
                        <RateWithJudgement rate={row.ownCashShare} judgement={row.ownCashJudgement} />
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
        <p className="text-[11px] text-grey-500 print:text-black">
          기업유형은 {AGREEMENT_VIEW_TEXT.companyType}으로, 그 외 기관 등의 지원금은 0으로 표시합니다. 판정은 [연구비 규칙]의
          해당 행이 켜져 있고 값이 있을 때만 합니다.
        </p>
      </section>

      {/* ② 8-2 사용계획 */}
      <section className="space-y-2">
        <h3 className="flex items-center gap-1.5 text-t6 font-semibold text-grey-800 print:text-black">
          8-2 사용계획
          <span className="text-t7 font-normal text-grey-500 print:text-black">
            · {AGREEMENT_VIEW_TEXT.formE1}·{AGREEMENT_VIEW_TEXT.formE2}는 양식의 기호입니다
          </span>
        </h3>
        {plan82.columns.length <= 1 ? (
          <p className="rounded-xl border border-dashed border-grey-300 bg-surface p-6 text-center text-t7 text-grey-500">
            이 과제에 연차가 없어 8-2를 채울 수 없습니다. 과제 개요에서 단계·연차를 먼저 만드세요.
          </p>
        ) : (
          <div className={`overflow-x-auto rounded-xl border border-grey-200 bg-surface ${PRINT_TABLE_WRAP}`}>
            <table className={`w-full min-w-max text-xs ${PRINT_TABLE}`}>
              <caption className="sr-only">
                붙임4 8-2 사용계획 — {version.name}. 양식 행 × 연차·단계 소계·합계. 값이 없는 칸은 {RATE_NONE_TEXT}.
              </caption>
              <thead className="text-grey-500 print:text-black">
                <tr className="border-b border-grey-100">
                  <th scope="col" colSpan={2} className={`px-3 py-2 text-left font-medium ${PRINT_TH}`}>
                    항목
                  </th>
                  {plan82.columns.map((col) => (
                    <th
                      key={`${col.kind}-${col.key}`}
                      scope="col"
                      className={`border-l border-grey-100 px-3 py-2 text-right font-medium text-grey-700 ${columnTone(col)} ${PRINT_TH}`}
                    >
                      {col.label}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-grey-100">
                {plan82.rows.map((row, ri) => {
                  const span = spans[ri]!;
                  const strongRow = row.kind === 'aggregate';
                  const labelCell =
                    span === 0 ? null : row.subLabel === null && span === 1 ? (
                      <th
                        scope="row"
                        colSpan={2}
                        className={`px-3 py-1.5 text-left ${strongRow ? 'font-semibold text-grey-900' : 'font-medium text-grey-800'} ${PRINT_TD}`}
                      >
                        {row.label}
                      </th>
                    ) : (
                      <th
                        scope="rowgroup"
                        rowSpan={span}
                        className={`px-3 py-1.5 text-left align-top font-medium text-grey-800 ${PRINT_TD}`}
                      >
                        {row.label}
                      </th>
                    );
                  return (
                    <tr
                      key={row.key}
                      data-row={row.rowId}
                      className={strongRow ? 'bg-grey-50 print:bg-transparent' : ''}
                    >
                      {labelCell}
                      {row.subLabel !== null || span !== 1 ? (
                        <th scope="row" className={`px-2 py-1.5 text-left font-normal text-grey-600 ${PRINT_TD}`}>
                          {row.subLabel ?? ''}
                        </th>
                      ) : null}
                      {row.cells.map((cell, ci) => {
                        const col = plan82.columns[ci]!;
                        const canEdit = editable && row.editable && col.kind === 'year';
                        if (canEdit) {
                          const { text, title } = formCellText(cell, currencyUnit);
                          return (
                            <td
                              key={`${col.kind}-${col.key}`}
                              className={`border-l border-grey-100 px-1.5 py-1 text-right ${PRINT_TD}`}
                            >
                              <EditableAmount
                                value={cell.kind === 'amount' ? cell.value : null}
                                displayText={text}
                                displayTitle={title}
                                label={`${col.label} ${row.label}${row.subLabel === null ? '' : ` ${row.subLabel}`}`}
                                disabled={busy}
                                allowEmpty={false}
                                onSave={(amount) => saveFormCell(col.key, row, amount)}
                              />
                            </td>
                          );
                        }
                        return (
                          <td
                            key={`${col.kind}-${col.key}`}
                            className={`border-l border-grey-100 px-1.5 py-1 text-right ${columnTone(col)} ${PRINT_TD}`}
                          >
                            <FormCell cell={cell} currencyUnit={currencyUnit} strong={strongRow || col.kind !== 'year'} />
                          </td>
                        );
                      })}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
        <p className="text-[11px] text-grey-500 print:text-black">
          간접비 비율은 양식 시트의 식(L ÷ (A현금+B현금+C+D+F현금+G현금+H현금+I))이라 규칙 검증의 수정직접비와 분모가 다를 수
          있습니다. 비율은 보여 주기만 합니다.
          {plan82.showOutsideRow && ` '${AGREEMENT_VIEW_TEXT.outsideCategoriesRow}' 행은 직접비 소계·총액에 들어가고 고칠 수 없습니다.`}
        </p>
      </section>

      {/* 8-2 아래 RL-4·RL-3 판정 줄(AG-3, S-15). 연차가 없으면 판정할 열도 없다 — 8-2와 같은 안내로 충분하다 */}
      {plan82.columns.length > 1 && (
        <Form82RuleLines rules={view.form82Rules} yearColumns={plan82.columns.filter((c) => c.kind === 'year')} />
      )}

      {/* 검토사항 */}
      {reviewNotes.length > 0 && (
        <section className="space-y-1.5">
          <h3 className="text-t6 font-semibold text-grey-800 print:text-black">검토사항</h3>
          <ul className="space-y-1 rounded-xl border border-grey-200 bg-surface p-3 text-t7">
            {reviewNotes.map((note, i) => (
              <li key={`${note.code}-${note.yearId ?? 'all'}-${i}`} className="flex items-start gap-2">
                <span
                  className={`mt-0.5 shrink-0 rounded px-1 py-0.5 text-[10px] font-semibold print:bg-transparent print:text-black ${
                    note.severity === 'warning' ? 'bg-orange-50 text-orange-800' : 'bg-grey-100 text-grey-600'
                  }`}
                >
                  {note.severity === 'warning' ? '경고' : '참고'}
                </span>
                <span className="text-grey-700 print:text-black">{note.message}</span>
              </li>
            ))}
          </ul>
        </section>
      )}

      {conflict !== null && (
        <ConflictDialog
          message={conflict}
          // 칸 편집은 O-2 — 다시 불러오면 서버가 새로 읽은 줄 version으로 다음 저장을 판정한다
          onReload={() => {
            setConflict(null);
            onChanged();
          }}
          onKeepEditing={() => setConflict(null)}
        />
      )}
    </div>
  );
}
