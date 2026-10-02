'use client';

// 협약 예산 변경 이력 보기 (SOT §6.19 AG-7, §6.14.8 RL-23, §7.9.8 "변경 이력 보기", 계획서 S-12)
//
// 버전 목록(메타 포함) → 두 버전 A(이전)·B(이후) 선택 → 금액 줄 증감 · 참여인원 증감 → 세목 총액 보존.
//  - 증감·보존 판정은 서버(getAgreementChanges → lib/agreement/diff·preservation·changes-table)가 한다.
//    화면은 서버가 만든 **표 모델을 그대로** 그린다 — [복사]·[엑셀 내려받기]와 같은 표다(AG-8)
//  - 세목 총액 보존은 A가 아니라 **B 대 base(B)**다(S-12). 기준 버전이 없으면 "기준 버전 없음"이고,
//    이는 경고 0건과 다른 사실이라 다르게 보인다(절대 규칙 5)
//  - 증감 상태 4종(추가·삭제·변경·불변)은 라벨과 색 두 가지로 구별한다 — 색만으로 가르지 않는다

import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { Settings, Year } from '@/types';
import type { ActionErrorCode } from '@/lib/db/errors';
import type { AgreementChangeStatus } from '@/lib/agreement/diff';
import type { TableCell, TableModel } from '@/lib/agreement/table';
import {
  AGREEMENT_CHANGE_STATUS_LABELS,
  PRESERVATION_JUDGEMENT_LABELS,
  PRESERVATION_NO_BASE_TEXT,
} from '@/lib/agreement/changes-table';
import {
  getAgreementChanges,
  type AgreementChangesData,
  type AgreementVersionView,
} from '@/actions/agreement';
import {
  AGREEMENT_NOTICE_TYPE_LABELS,
  AGREEMENT_VERSION_KIND_LABELS,
  AGREEMENT_VERSION_STATUS_LABELS,
} from '@/lib/constants';
import { formatAmount } from '@/lib/currency';
import Badge, { type BadgeTone } from '@/components/ui/Badge';
import ErrorBanner from '@/components/ui/ErrorBanner';
import { PRINT_TABLE, PRINT_TABLE_WRAP, PRINT_TD, PRINT_TH } from '@/components/print/tokens';
import TableActions from './TableActions';

const NO_VALUE = '—';

/** 표 모델에서 상태·판정 칸을 찾는 헤더 — changes-table.ts가 정한 열 이름이다 */
const STATUS_HEADER = '상태';
const JUDGEMENT_HEADER = '판정';

const STATUS_ORDER: AgreementChangeStatus[] = ['added', 'removed', 'changed', 'unchanged'];

const STATUS_TONES: Record<AgreementChangeStatus, BadgeTone> = {
  added: 'green',
  removed: 'red',
  changed: 'amber',
  unchanged: 'neutral',
};

/** 행 배경 — 불변 행은 칠하지 않아 바뀐 행이 눈에 들어온다 */
const STATUS_ROW_CLASSES: Record<AgreementChangeStatus, string> = {
  added: 'bg-green-50',
  removed: 'bg-red-50',
  changed: 'bg-orange-50',
  unchanged: '',
};

const STATUS_BY_LABEL = new Map<string, AgreementChangeStatus>(
  STATUS_ORDER.map((s) => [AGREEMENT_CHANGE_STATUS_LABELS[s], s])
);

interface Failure {
  message: string;
  code?: ActionErrorCode;
}

type Loaded =
  | { state: 'idle' }
  | { state: 'loading' }
  | { state: 'error'; failure: Failure }
  | { state: 'done'; data: AgreementChangesData };

function versionOptionLabel(view: AgreementVersionView): string {
  const v = view.version;
  return `${v.order}. ${AGREEMENT_VERSION_KIND_LABELS[v.kind]} · ${v.name} · ${AGREEMENT_VERSION_STATUS_LABELS[v.status]}`;
}

/** 증감 칸(`=B−A` — 빼는 항이 있는 합)은 부호를 붙이고 색을 준다. 0은 부호 없이 */
function isDifference(cell: TableCell): boolean {
  return cell.kind === 'sum' && cell.terms.some((t) => t.negate === true);
}

function CellContent({ cell, currencyUnit }: { cell: TableCell; currencyUnit: Settings['currencyUnit'] }) {
  switch (cell.kind) {
    case 'empty':
      return <span className="text-grey-400">{NO_VALUE}</span>;
    case 'text':
      return <>{cell.text}</>;
    case 'amount':
      return <span className="tabular-nums">{formatAmount(cell.value, currencyUnit)}</span>;
    case 'sum': {
      if (!isDifference(cell)) return <span className="tabular-nums">{formatAmount(cell.value, currencyUnit)}</span>;
      if (cell.value === 0) return <span className="tabular-nums text-grey-500">{formatAmount(0, currencyUnit)}</span>;
      return (
        <span className={`font-semibold tabular-nums ${cell.value > 0 ? 'text-blue-600' : 'text-red-600'} print:text-black`}>
          {cell.value > 0 ? '+' : ''}
          {formatAmount(cell.value, currencyUnit)}
        </span>
      );
    }
  }
}

/**
 * 서버가 만든 표 모델 하나를 그린다. 상태 칸은 배지로, 판정 칸의 "차이"는 경고 배지로.
 * 헤더 1행 · data/subtotal/total 행 그대로 — 복사·엑셀과 행·열이 같다(AG-8).
 */
function ModelTable({ model, currencyUnit }: { model: TableModel; currencyUnit: Settings['currencyUnit'] }) {
  const statusCol = model.columns.findIndex((c) => c.label === STATUS_HEADER);
  const judgementCol = model.columns.findIndex((c) => c.label === JUDGEMENT_HEADER);

  return (
    <div className={`overflow-x-auto rounded-xl border border-grey-200 bg-surface ${PRINT_TABLE_WRAP}`}>
      <table className={`w-full min-w-max text-xs ${PRINT_TABLE}`}>
        <caption className="sr-only">{model.title}</caption>
        <thead className="text-grey-500 print:text-black">
          <tr className="border-b border-grey-100">
            {model.columns.map((col, c) => (
              <th
                key={c}
                scope="col"
                className={`px-3 py-2 font-medium ${col.type === 'amount' ? 'text-right' : 'text-left'} ${PRINT_TH}`}
              >
                {col.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y divide-grey-100">
          {model.rows.map((row, r) => {
            const statusCell = statusCol >= 0 ? row.cells[statusCol] : undefined;
            const status =
              row.kind === 'data' && statusCell?.kind === 'text' ? STATUS_BY_LABEL.get(statusCell.text) : undefined;
            const rowClass =
              row.kind === 'total'
                ? 'border-t-2 border-grey-200 bg-grey-50 font-semibold text-grey-900'
                : row.kind === 'subtotal'
                  ? 'bg-grey-50 font-semibold text-grey-800'
                  : `text-grey-700 ${status === undefined ? '' : STATUS_ROW_CLASSES[status]}`;
            return (
              <tr key={r} className={`${rowClass} print:bg-transparent print:text-black`}>
                {row.cells.map((cell, c) => {
                  const col = model.columns[c]!;
                  let content = <CellContent cell={cell} currencyUnit={currencyUnit} />;
                  if (c === statusCol && status !== undefined) {
                    content = <Badge tone={STATUS_TONES[status]}>{AGREEMENT_CHANGE_STATUS_LABELS[status]}</Badge>;
                  } else if (c === judgementCol && row.kind === 'data' && cell.kind === 'text' && cell.text !== '') {
                    const differs = cell.text === PRESERVATION_JUDGEMENT_LABELS.differs;
                    content = <Badge tone={differs ? 'amber' : 'neutral'}>{cell.text}</Badge>;
                  }
                  return (
                    <td
                      key={c}
                      className={`px-3 py-1.5 ${col.type === 'amount' ? 'text-right' : 'text-left'} ${PRINT_TD}`}
                    >
                      {content}
                    </td>
                  );
                })}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function StatusCounts({ counts }: { counts: Record<AgreementChangeStatus, number> }) {
  return (
    <span className="inline-flex flex-wrap gap-1.5">
      {STATUS_ORDER.map((s) => (
        <Badge key={s} tone={counts[s] > 0 ? STATUS_TONES[s] : 'neutral'}>
          {AGREEMENT_CHANGE_STATUS_LABELS[s]} {counts[s]}
        </Badge>
      ))}
    </span>
  );
}

function Section({ title, aside, children }: { title: string; aside?: ReactNode; children: ReactNode }) {
  return (
    <section className="space-y-2">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-t6 font-semibold text-grey-900">{title}</h3>
        {aside}
      </div>
      {children}
    </section>
  );
}

function VersionList({
  versions,
  fromId,
  toId,
}: {
  versions: AgreementVersionView[];
  fromId: string | null;
  toId: string | null;
}) {
  return (
    <div className={`overflow-x-auto rounded-xl border border-grey-200 bg-surface ${PRINT_TABLE_WRAP}`}>
      <table className={`w-full min-w-max text-xs ${PRINT_TABLE}`}>
        <caption className="sr-only">협약 예산 버전 목록</caption>
        <thead className="text-grey-500 print:text-black">
          <tr className="border-b border-grey-100 text-left">
            {['순번', '종류', '이름', '기준일', '상태', '통보/승인', 'IRIS 신청일', '변경 사유', '비고', '비교'].map((h) => (
              <th key={h} scope="col" className={`px-3 py-2 font-medium ${PRINT_TH}`}>
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y divide-grey-100 text-grey-700 print:text-black">
          {versions.map(({ version: v }) => (
            <tr key={v.id}>
              <td className={`px-3 py-1.5 tabular-nums ${PRINT_TD}`}>{v.order}</td>
              <td className={`px-3 py-1.5 ${PRINT_TD}`}>{AGREEMENT_VERSION_KIND_LABELS[v.kind]}</td>
              <td className={`px-3 py-1.5 font-medium text-grey-900 print:text-black ${PRINT_TD}`}>{v.name}</td>
              <td className={`px-3 py-1.5 tabular-nums ${PRINT_TD}`}>{v.baseDate ?? NO_VALUE}</td>
              <td className={`px-3 py-1.5 ${PRINT_TD}`}>
                <Badge tone={v.status === 'confirmed' ? 'blue' : 'amber'}>{AGREEMENT_VERSION_STATUS_LABELS[v.status]}</Badge>
              </td>
              <td className={`px-3 py-1.5 ${PRINT_TD}`}>
                {v.noticeType === null ? NO_VALUE : AGREEMENT_NOTICE_TYPE_LABELS[v.noticeType]}
              </td>
              <td className={`px-3 py-1.5 tabular-nums ${PRINT_TD}`}>{v.irisRequestedAt ?? NO_VALUE}</td>
              <td className={`max-w-xs whitespace-pre-line px-3 py-1.5 ${PRINT_TD}`}>{v.changeReason || NO_VALUE}</td>
              <td className={`max-w-xs whitespace-pre-line px-3 py-1.5 ${PRINT_TD}`}>{v.note || NO_VALUE}</td>
              <td className={`px-3 py-1.5 ${PRINT_TD}`}>
                <span className="inline-flex gap-1">
                  {v.id === fromId && <Badge tone="neutral">A 이전</Badge>}
                  {v.id === toId && <Badge tone="blue">B 이후</Badge>}
                </span>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** 세목 총액 보존(RL-23) 요약 — 기준 없음 · 경고 0건 · 경고 N건이 서로 다르게 보인다 */
function PreservationSummary({
  data,
  baseName,
}: {
  data: AgreementChangesData;
  baseName: string | null;
}) {
  const p = data.preservation;
  if (p.status === 'no-base') {
    return (
      <p
        role="note"
        className="rounded-xl border border-dashed border-grey-300 bg-grey-50 px-3 py-2 text-t7 text-grey-600 print:text-black"
      >
        {PRESERVATION_NO_BASE_TEXT}
      </p>
    );
  }
  const against = `${data.to.name} 대 기준 버전 ${baseName ?? NO_VALUE}`;
  if (p.warnings.length === 0) {
    return (
      <p className="rounded-xl border border-green-300 bg-green-50 px-3 py-2 text-t7 text-green-900 print:text-black">
        경고 0건 — {against}: 모든 세목의 전 연차 합이 같습니다.
      </p>
    );
  }
  return (
    <div
      role="alert"
      className="rounded-xl border border-orange-100 bg-orange-50 px-3 py-2 text-t7 text-orange-800 print:text-black"
    >
      <p className="font-semibold">
        세목 총액 보존 경고 {p.warnings.length}건 — {against}
      </p>
      <p className="mt-0.5 opacity-80">
        연차 간 이동은 괜찮지만 세목별 전 연차 합은 기준 버전과 같아야 합니다. 경고일 뿐 저장·확정은 막지 않습니다.
      </p>
    </div>
  );
}

export interface ChangesViewProps {
  projectId: string;
  /** order 오름차순 */
  versions: AgreementVersionView[];
  /** 계약상 받는다 — 표의 연차 이름은 서버가 만든 표 모델에 들어 있다 */
  years: Year[];
  currencyUnit: Settings['currencyUnit'];
  /** A 초깃값 = 보고 있는 버전의 직전 버전(AG-7). null이면 B와 같은 버전으로 시작한다 */
  defaultFromId: string | null;
  /** B 초깃값 = 보고 있는 버전 */
  defaultToId: string | null;
}

export default function ChangesView({
  projectId,
  versions,
  currencyUnit,
  defaultFromId,
  defaultToId,
}: ChangesViewProps) {
  const ids = useMemo(() => new Set(versions.map((v) => v.version.id)), [versions]);
  const pick = (id: string | null): string | null => (id !== null && ids.has(id) ? id : null);
  const initialTo = (): string | null => pick(defaultToId) ?? versions[versions.length - 1]?.version.id ?? null;
  // 직전 버전이 없으면(버전 1개) 같은 버전끼리 비교한다 — 증감은 전부 불변이고 세목 총액 보존은 그대로 보인다
  const initialFrom = (): string | null => pick(defaultFromId) ?? initialTo();

  const [fromId, setFromId] = useState<string | null>(initialFrom);
  const [toId, setToId] = useState<string | null>(initialTo);
  const [loaded, setLoaded] = useState<Loaded>({ state: 'idle' });
  const [reloadTick, setReloadTick] = useState(0);
  const requestSeq = useRef(0);

  // 보고 있는 버전이 바뀌면(버전 바) 초깃값 규칙대로 다시 맞춘다
  useEffect(() => {
    setFromId(initialFrom());
    setToId(initialTo());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [defaultFromId, defaultToId]);

  // 고른 버전이 지워졌으면 초깃값으로 돌아간다 — 없는 버전을 비교하라고 보내지 않는다
  useEffect(() => {
    if (fromId !== null && !ids.has(fromId)) setFromId(initialFrom());
    if (toId !== null && !ids.has(toId)) setToId(initialTo());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ids]);

  // 다른 사람이 금액을 고쳐 새로고침되면 비교도 다시 한다. 참여인원은 Phase 24에 편집 화면이 없다
  const versionsSignature = versions
    .map((v) => `${v.version.id}:${v.version.version}:${v.lineCount}:${v.categoryView.grandTotal.total ?? '-'}`)
    .join('|');

  useEffect(() => {
    if (fromId === null || toId === null || !ids.has(fromId) || !ids.has(toId)) {
      setLoaded({ state: 'idle' });
      return;
    }
    const seq = ++requestSeq.current;
    setLoaded({ state: 'loading' });
    getAgreementChanges(projectId, fromId, toId)
      .then((res) => {
        // 늦게 도착한 옛 요청이 새 선택의 결과를 덮지 않게
        if (seq !== requestSeq.current) return;
        setLoaded(
          res.ok ? { state: 'done', data: res.data } : { state: 'error', failure: { message: res.error, code: res.code } }
        );
      })
      .catch((e: unknown) => {
        if (seq !== requestSeq.current) return;
        setLoaded({
          state: 'error',
          failure: { message: `변경 이력을 불러오지 못했습니다: ${e instanceof Error ? e.message : String(e)}` },
        });
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId, fromId, toId, versionsSignature, reloadTick]);

  if (versions.length === 0) {
    return (
      <p className="rounded-xl border border-dashed border-grey-300 bg-surface p-6 text-center text-t7 text-grey-500">
        비교할 협약 예산 버전이 없습니다.
      </p>
    );
  }

  const byId = new Map(versions.map((v) => [v.version.id, v]));
  const data = loaded.state === 'done' ? loaded.data : null;
  const baseName = data === null || data.baseVersionId === null ? null : (byId.get(data.baseVersionId)?.version.name ?? null);
  const fromName = fromId === null ? NO_VALUE : (byId.get(fromId)?.version.name ?? NO_VALUE);
  const toName = toId === null ? NO_VALUE : (byId.get(toId)?.version.name ?? NO_VALUE);

  const selectClass =
    'rounded-md border border-grey-300 bg-surface px-2 py-1.5 text-t7 text-grey-800 focus:border-blue-500 focus:outline-none focus:ring-2 focus:ring-blue-100';

  return (
    <div className="space-y-5">
      <Section title="버전 목록">
        <VersionList versions={versions} fromId={fromId} toId={toId} />
      </Section>

      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="flex flex-wrap items-end gap-3 print:hidden">
          <label className="block text-t7 text-grey-600">
            <span className="mb-1 block font-semibold">A 이전 버전</span>
            <select value={fromId ?? ''} onChange={(e) => setFromId(e.target.value)} className={selectClass}>
              {versions.map((v) => (
                <option key={v.version.id} value={v.version.id}>
                  {versionOptionLabel(v)}
                </option>
              ))}
            </select>
          </label>
          <span className="pb-2 text-grey-400">→</span>
          <label className="block text-t7 text-grey-600">
            <span className="mb-1 block font-semibold">B 이후 버전</span>
            <select value={toId ?? ''} onChange={(e) => setToId(e.target.value)} className={selectClass}>
              {versions.map((v) => (
                <option key={v.version.id} value={v.version.id}>
                  {versionOptionLabel(v)}
                </option>
              ))}
            </select>
          </label>
          {fromId !== null && fromId === toId && (
            <span className="pb-2 text-t7 text-grey-500">같은 버전끼리는 모든 줄이 불변입니다.</span>
          )}
        </div>
        {/* 종이에는 선택 상자 대신 비교 대상을 글로 남긴다 */}
        <p className="hidden text-t7 text-black print:block">
          비교: A {fromName} → B {toName} · 금액 표시 단위 {currencyUnit}
        </p>
        {data !== null && fromId !== null && toId !== null && (
          <TableActions
            projectId={projectId}
            model={[data.tables.lines, data.tables.participants, data.tables.preservation]}
            workbook={{ view: 'changes', fromVersionId: fromId, toVersionId: toId }}
          />
        )}
      </div>

      {loaded.state === 'loading' && (
        <p role="status" className="text-t7 text-grey-500">
          변경 이력을 계산하는 중…
        </p>
      )}

      {loaded.state === 'error' && (
        <ErrorBanner
          message={loaded.failure.message}
          code={loaded.failure.code}
          className="whitespace-pre-line"
          onRetry={() => setReloadTick((n) => n + 1)}
        />
      )}

      {data !== null && (
        <>
          <p className="text-t7 text-grey-500 print:hidden">
            금액 표시 단위 {currencyUnit} · {NO_VALUE}는 그 버전에 줄이 없다는 뜻입니다(0원과 다릅니다).
          </p>

          <Section title="금액 증감" aside={<StatusCounts counts={data.lineDiff.counts} />}>
            {data.tables.lines.rows.length === 0 ? (
              <p className="rounded-xl border border-dashed border-grey-300 bg-surface p-4 text-center text-t7 text-grey-500">
                두 버전 모두 금액 줄이 없습니다.
              </p>
            ) : (
              <ModelTable model={data.tables.lines} currencyUnit={currencyUnit} />
            )}
          </Section>

          <Section title="참여인원 증감" aside={<StatusCounts counts={data.participantDiff.counts} />}>
            {data.tables.participants.rows.length === 0 ? (
              <p className="rounded-xl border border-dashed border-grey-300 bg-surface p-4 text-center text-t7 text-grey-500">
                두 버전 모두 참여인원이 없습니다.
              </p>
            ) : (
              <ModelTable model={data.tables.participants} currencyUnit={currencyUnit} />
            )}
          </Section>

          <Section title={`세목 총액 보존 — B ${data.to.name} 대 기준 버전`}>
            <PreservationSummary data={data} baseName={baseName} />
            {data.preservation.status === 'checked' && data.tables.preservation.rows.length > 0 && (
              <ModelTable model={data.tables.preservation} currencyUnit={currencyUnit} />
            )}
          </Section>
        </>
      )}

      {loaded.state === 'idle' && <p className="text-t7 text-grey-500">비교할 두 버전을 고르세요.</p>}
    </div>
  );
}
