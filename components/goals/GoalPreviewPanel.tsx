'use client';

// 목표 반영 미리보기 본문 — 목표 양식(xlsx) 모달과 계획서(hwpx) 모달이 함께 쓴다 (SOT §6.17 GF-5, §6.18 HX-8)
//
//  - 두 경로는 같은 `GoalFormPreview`를 만든다(HX-8: 별도 반영 경로 없음). 그래서 건수·달성률·오류·충돌·추가·변경
//    표시도 하나여야 한다 — 한쪽만 고치면 같은 판정이 다르게 보인다
//  - 판정은 하지 않는다. 서버가 만든 preview를 펼쳐 보일 뿐이다 (O-4)
//  - 위치 문구만 경로마다 다르다: xlsx는 시트 행("기술목표 5행"), hwpx는 표 행과 순번 — placeOf로 받는다
//  - 삭제 후보·[삭제 포함]은 xlsx에만 있다. hwpx는 삭제하지 않으므로(allowDeletes:false) showDeletes=false로 숨긴다

import { useMemo, useState, type ReactNode } from 'react';
import type { GoalFormConflict, GoalFormKind } from '@/lib/db/import-snapshots';
import type { GoalFormIssue } from '@/lib/goal-form/parse';
import type { GoalConflictReason, GoalFormPreview, GoalPreviewRowStatus, GoalRates } from '@/lib/goal-form/preview';
import { formatRate } from '@/lib/goals';
import Badge, { type BadgeTone } from '@/components/ui/Badge';

/** 추가·변경 행 목록은 이 수를 넘으면 접는다 — 요약이 먼저고 목록은 확인용이다 */
const ROW_LIST_FOLD = 12;

export const GOAL_FORM_KINDS: readonly GoalFormKind[] = ['deliverable', 'achievement', 'techTarget', 'record'];

/** 시트 이름 그대로(GF-1) — 사용자가 엑셀에서 찾아갈 이름이어야 한다 */
export const GOAL_SHEET_LABELS: Record<GoalFormKind, string> = {
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

/** 위치 문구를 만드는 데 필요한 것. xlsx는 시트 행, hwpx는 표 행으로 되돌린다 */
export type GoalRowPlace = (row: { kind: GoalFormKind; sheetRow: number }) => string;

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

function toRowViews(preview: GoalFormPreview): RowView[] {
  const { deliverables, achievements, techTargets, records } = preview.rows;
  type RowLike = Omit<RowView, 'label' | 'changedFields'> & {
    changedFields: readonly string[];
  };
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

/** 오류·경고 행 판정은 행의 issues를 그대로 따른다 — 서버의 counts와 같은 기준이다 */
function isWarningRow(row: RowView): boolean {
  return row.status !== 'error' && row.issues.some((issue) => !issue.blocking);
}

function sheetCounts(rows: readonly RowView[], preview: GoalFormPreview): Record<GoalFormKind, SheetCounts> {
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

/**
 * 충돌 id → 사용자가 알아볼 이름. 반영 결과의 RPC conflicts도 이 표로 이름을 붙이므로 모달이 결과 화면에서도 쓴다 —
 * 반영 대상은 전부 미리보기 행이나 삭제 후보에서 왔으므로 모르는 id는 없어야 하지만, 모르면 id를 그대로 보인다
 */
export function buildGoalConflictLabels(preview: GoalFormPreview, placeOf: GoalRowPlace): Map<string, string> {
  const map = new Map<string, string>();
  for (const row of toRowViews(preview)) {
    if (row.id !== null && !map.has(`${row.kind}:${row.id}`)) {
      map.set(`${row.kind}:${row.id}`, row.label === '' ? placeOf(row) : `${placeOf(row)} · ${row.label}`);
    }
  }
  for (const candidate of preview.deleteCandidates) {
    const key = `${candidate.kind}:${candidate.id}`;
    if (!map.has(key)) {
      map.set(
        key,
        `삭제 후보 · ${GOAL_SHEET_LABELS[candidate.kind]} · ${candidate.label === '' ? '(이미 없음)' : candidate.label}`
      );
    }
  }
  return map;
}

export interface GoalPreviewPanelProps {
  preview: GoalFormPreview;
  /** 표시할 달성률 전후. xlsx는 [삭제 포함] 토글에 따라 preview.rates / ratesWithDeletes 중 하나를 넘긴다 */
  rates: { before: GoalRates; after: GoalRates };
  /** 행 위치 문구 — xlsx "기술목표 5행", hwpx "기술목표 표 N행 (순번 k)" */
  placeOf: GoalRowPlace;
  /** 삭제 후보 목록과 [삭제 포함] 토글을 보일지. hwpx는 삭제하지 않으므로 false */
  showDeletes: boolean;
  includeDeletes: boolean;
  onToggleDeletes: (next: boolean) => void;
  /** 진행 중(반영 등)에는 토글을 막는다 */
  disabled?: boolean;
  /** 반영 불가 목록 머리의 고칠 곳 안내. 기본은 xlsx 문구 */
  fixHint?: string;
  /** 상태 배지 줄 바로 아래 — hwpx가 찾은 표 요약을 끼운다 */
  summary?: ReactNode;
  /** 오류·경고 목록 다음, 충돌 목록 앞 — hwpx가 반영 제외 행 목록을 끼운다 */
  extra?: ReactNode;
}

export default function GoalPreviewPanel({
  preview,
  rates,
  placeOf,
  showDeletes,
  includeDeletes,
  onToggleDeletes,
  disabled = false,
  fixHint = '엑셀에서 고친 뒤 다시 올리세요.',
  summary,
  extra,
}: GoalPreviewPanelProps) {
  const [showAllRows, setShowAllRows] = useState(false);

  const rows = useMemo(() => toRowViews(preview), [preview]);
  const counts = useMemo(() => sheetCounts(rows, preview), [rows, preview]);
  const conflictLabels = useMemo(() => buildGoalConflictLabels(preview, placeOf), [preview, placeOf]);
  const errorRows = rows.filter((row) => row.status === 'error');
  const warningRows = rows.filter(isWarningRow);
  const changedRows = rows.filter((row) => row.status === 'add' || row.status === 'update');
  const visibleChangedRows = showAllRows ? changedRows : changedRows.slice(0, ROW_LIST_FOLD);
  const blockingFileIssues = preview.issues.filter((issue) => issue.blocking);
  const warningFileIssues = preview.issues.filter((issue) => !issue.blocking);

  return (
    <>
      <div className="flex flex-wrap items-center gap-2">
        {preview.blocked ? <Badge tone="red">반영할 수 없음</Badge> : <Badge tone="green">반영할 수 있습니다</Badge>}
        <span className="text-t7 text-grey-500">
          경고 <strong>{preview.counts.warning}</strong>건 · 충돌 <strong>{preview.counts.conflict}</strong>건 · 오류{' '}
          <strong>{preview.counts.error}</strong>건
        </span>
      </div>

      {summary}

      {/* GF-5 시트별 건수 */}
      <div className="overflow-x-auto rounded-xl border border-grey-200">
        <table className="w-full text-t7">
          <thead className="bg-grey-50 text-grey-600">
            <tr>
              <th className="px-3 py-1.5 text-left font-semibold">시트</th>
              <th className="px-3 py-1.5 text-right font-semibold">추가</th>
              <th className="px-3 py-1.5 text-right font-semibold">변경</th>
              <th className="px-3 py-1.5 text-right font-semibold">변경 없음</th>
              {showDeletes && <th className="px-3 py-1.5 text-right font-semibold">삭제 후보</th>}
              <th className="px-3 py-1.5 text-right font-semibold">충돌</th>
              <th className="px-3 py-1.5 text-right font-semibold">오류</th>
              <th className="px-3 py-1.5 text-right font-semibold">경고</th>
            </tr>
          </thead>
          <tbody>
            {GOAL_FORM_KINDS.map((kind) => {
              const c = counts[kind];
              return (
                <tr key={kind} className="border-t border-grey-100 text-grey-700">
                  <td className="px-3 py-1.5 font-medium">{GOAL_SHEET_LABELS[kind]}</td>
                  <td className="px-3 py-1.5 text-right tabular-nums">{c.add}</td>
                  <td className="px-3 py-1.5 text-right tabular-nums">{c.update}</td>
                  <td className="px-3 py-1.5 text-right tabular-nums">{c.unchanged}</td>
                  {showDeletes && <td className="px-3 py-1.5 text-right tabular-nums">{c.deleteCandidates}</td>}
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
          달성률 전후
          {showDeletes && (
            <>
              {' '}
              <span className="font-normal text-grey-400">({includeDeletes ? '삭제 포함' : '삭제 제외'} 기준)</span>
            </>
          )}
        </h3>
        <RatesTable rates={rates} />
      </section>

      {/* 파일 단위 차단 문제 + 오류 행. 이것만이 반영을 막는다 (S-21) */}
      {(blockingFileIssues.length > 0 || errorRows.length > 0) && (
        <div className="rounded-xl border border-red-200 bg-red-50 px-3 py-2 text-t7 text-red-700">
          <p className="font-semibold">
            아래 {blockingFileIssues.length + errorRows.length}건 때문에 반영할 수 없습니다 — 부분 반영은 하지 않습니다.{' '}
            {fixHint}
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
                <span className="font-semibold">{placeOf(row)}</span>
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
                <span className="font-semibold">{placeOf(row)}</span>
                {row.label !== '' && <span className="ml-1">({row.label})</span>}
                <span className="ml-1">: {issueMessages(row.issues, true)}</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {extra}

      {/* GF-5 충돌: 반영에서 건너뛴다. 무엇이 빠지는지 반영 전에 보여 준다 */}
      {preview.conflicts.length > 0 && (
        <GoalConflictList
          title={`충돌 ${preview.conflicts.length}건 — 반영에서 건너뜁니다`}
          conflicts={preview.conflicts}
          labels={conflictLabels}
        />
      )}

      {/* GF-5 삭제 후보 + [삭제 포함] 토글(기본 꺼짐) */}
      {showDeletes && preview.deleteCandidates.length > 0 && (
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
                disabled={disabled || preview.counts.deleteCandidates === 0}
                onChange={(e) => onToggleDeletes(e.target.checked)}
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
                <span className="text-grey-500">{GOAL_SHEET_LABELS[candidate.kind]}</span>
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
                  <span className="text-grey-400">{placeOf(row)}</span>
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
    </>
  );
}

function RatesTable({ rates }: { rates: { before: GoalRates; after: GoalRates } }) {
  const { before, after } = rates;
  const lines: {
    label: string;
    before: string;
    after: string;
    warn: boolean;
  }[] = [
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

/** 충돌 목록 — 미리보기와 반영 결과가 같은 모양으로 보인다. 건너뛴 사실이 안 보이면 반영된 줄 안다 (절대 규칙 5) */
export function GoalConflictList({
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
              {labels.get(`${conflict.kind}:${conflict.id}`) ?? `${GOAL_SHEET_LABELS[conflict.kind]} ${conflict.id}`}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}
