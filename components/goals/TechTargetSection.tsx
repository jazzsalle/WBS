'use client';

// 정량적 기술목표 탭 (SOT §7.7 탭 2, §5.9, §6.3 T-1~T-4, 부록 A.4, §8.5 R-4)
// 표시 규칙:
//  - 달성률·가중 달성률은 서버(getGoalsData → lib/goals.ts)가 계산해 내려준 값만 쓴다.
//    화면에서 다시 계산하지 않는다(O-4). 표시용 반올림도 formatRate() 한 곳에서만 한다(P-8).
//  - 달성률은 0~100 클램프값이다(T-1) — 100을 넘는 표시는 없다(성과목표와 반대).
//  - rate가 null이면 N/A. lower_better인데 국내수준이 없으면 그 이유를 title로 알린다(T-2).
//  - current가 null이면 '미측정'. 미측정 항목도 전체 가중 계산에 0으로 들어간다(§6.3).
//  - 비중 합계가 100이 아니면 경고(T-3), 공인시험인데 평가기관이 비어 있으면 경고(T-4).
//  - 인쇄(§7.7 "국가R&D 계획서 표 형식")에서는 버튼·확장 영역을 감추고 표만 남긴다.
// 쓰기는 전부 actions/goals.ts를 거친다. supabase를 직접 부르지 않는다(§8.2 C-2).

import { Fragment, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import type { ActionResult, Organization, TechTarget, TechTargetRecord, Year } from '@/types';
import type { ActionErrorCode } from '@/lib/db/errors';
import type { GoalsData, TechTargetView } from '@/actions/goals';
import { DIRECTION_LABELS, MEASURE_METHOD_LABELS } from '@/lib/constants';
import { formatRate } from '@/lib/goals';
import { deleteTechRecord, deleteTechTarget } from '@/actions/goals';
import Badge from '@/components/ui/Badge';
import Button from '@/components/ui/Button';
import ErrorBanner from '@/components/ui/ErrorBanner';
import Modal from '@/components/ui/Modal';
import ProgressBar from '@/components/ui/ProgressBar';
import TechRecordForm from './TechRecordForm';
import TechTargetFormModal from './TechTargetFormModal';

export interface TechTargetSectionProps {
  projectId: string;
  views: TechTargetView[];
  summary: GoalsData['techSummary'];
  years: Year[];
  organizations: Organization[];
}

// 계획서 표 그대로: 평가항목 / 단위 / 비중 / 국내수준 / 세계최고 / 목표치 / 현재 실적 / 달성률 / 측정방법 / 동작
const COLUMN_COUNT = 10;

const TH_CLASS = 'px-3 py-2 font-medium print:border print:border-slate-500';
const TD_CLASS = 'px-3 py-2 align-top print:border print:border-slate-400';

/** §5.9 측정치는 소수·음수가 정상이다. 자릿수를 임의로 잘라 값이 달라 보이지 않게 한다 */
function formatNumber(value: number): string {
  return value.toLocaleString('ko-KR', { maximumFractionDigits: 6 });
}

function formatMeasure(value: number | null, unit: string): string {
  if (value === null) return '—';
  const text = formatNumber(value);
  return unit.trim() === '' ? text : `${text} ${unit}`;
}

/** §5.5: name이 있으면 name, 없으면 order+1 + '차년도' */
function yearLabel(year: Year): string {
  return year.name.trim() || `${year.order + 1}차년도`;
}

/**
 * 달성률이 N/A인 이유. 판정은 서버가 준 필드(rate/current)와 원본 값으로만 한다 —
 * 달성률 자체를 여기서 다시 계산하지 않는다.
 */
function unavailableRateReason(view: TechTargetView): string {
  const target = view.techTarget;
  // T-2: 기준 없이 감소율을 만들 수 없다
  if (target.direction === 'lower_better' && target.baselineDomestic === null) {
    return '국내수준(기준)이 없어 감소율을 계산할 수 없습니다';
  }
  if (view.current === null) {
    return '아직 측정값이 없습니다. 전체 가중 달성률에는 0으로 들어갑니다.';
  }
  return '달성률을 계산할 수 없습니다.';
}

/**
 * 이력 표시 순서(최신 우선). 날짜 오름차순 안정 정렬을 뒤집어
 * 동일 날짜에서는 나중에 등록된 것이 위로 온다 — lib/goals.ts의 latestRecord와 같은 기준이다.
 */
function sortRecordsAsc(records: readonly TechTargetRecord[]): TechTargetRecord[] {
  return [...records].sort((a, b) => a.date.localeCompare(b.date));
}

function isLink(url: string): boolean {
  return /^https?:\/\//i.test(url.trim());
}

// ─── 가중 달성률 게이지 (§7.7 "상단 요약: 가중 달성률 게이지") ────────────────
// 차트 라이브러리를 쓰지 않는다 — 반원 호 하나면 되는 그림이다.

const GAUGE_RADIUS = 48;
const GAUGE_CENTER_X = 60;
const GAUGE_CENTER_Y = 56;
const GAUGE_ARC = Math.PI * GAUGE_RADIUS;

function WeightedGauge({ rate }: { rate: number }) {
  // 서버가 준 값은 이미 0~100이다. 여기서 자르는 것은 SVG 좌표 보호일 뿐이며
  // 화면에 보이는 숫자는 formatRate가 낸다.
  const ratio = Math.max(0, Math.min(100, rate)) / 100;
  const arcPath = `M ${GAUGE_CENTER_X - GAUGE_RADIUS} ${GAUGE_CENTER_Y} A ${GAUGE_RADIUS} ${GAUGE_RADIUS} 0 0 1 ${GAUGE_CENTER_X + GAUGE_RADIUS} ${GAUGE_CENTER_Y}`;
  return (
    <svg
      viewBox="0 0 120 64"
      className="h-16 w-[120px]"
      role="img"
      aria-label={`전체 가중 달성률 ${formatRate(rate)}`}
    >
      <path d={arcPath} fill="none" stroke="#e2e8f0" strokeWidth={12} />
      <path
        d={arcPath}
        fill="none"
        stroke="#3b82f6"
        strokeWidth={12}
        // 0%일 때 점이 남지 않도록 butt 캡을 쓴다
        strokeLinecap="butt"
        strokeDasharray={`${GAUGE_ARC * ratio} ${GAUGE_ARC}`}
      />
    </svg>
  );
}

// ─── 추이 스파크라인 (§7.7 "행 확장 시 측정 이력 목록 + 추이 스파크라인") ─────

const SPARK_WIDTH = 240;
const SPARK_HEIGHT = 48;
const SPARK_PAD = 5;

function Sparkline({ records, unit }: { records: readonly TechTargetRecord[]; unit: string }) {
  const ordered = sortRecordsAsc(records);
  if (ordered.length < 2) {
    return (
      <p className="text-xs text-slate-400">측정값이 2건 이상이면 추이 그래프를 그립니다.</p>
    );
  }

  const values = ordered.map((record) => record.value);
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min || 1; // 값이 모두 같으면 가운데 수평선으로 그린다
  const points = ordered.map((record, index) => {
    const x = SPARK_PAD + (index * (SPARK_WIDTH - SPARK_PAD * 2)) / (ordered.length - 1);
    const y =
      SPARK_HEIGHT - SPARK_PAD - ((record.value - min) / span) * (SPARK_HEIGHT - SPARK_PAD * 2);
    return { id: record.id, x, y };
  });

  const first = ordered[0];
  const last = ordered[ordered.length - 1];
  if (!first || !last) return null; // 위 길이 검사로 도달하지 않는다

  return (
    <div>
      <svg
        viewBox={`0 0 ${SPARK_WIDTH} ${SPARK_HEIGHT}`}
        className="h-12 w-60"
        role="img"
        aria-label={`측정 추이: ${first.date} ${formatMeasure(first.value, unit)} → ${last.date} ${formatMeasure(last.value, unit)}`}
      >
        <polyline
          fill="none"
          stroke="#3b82f6"
          strokeWidth={1.5}
          points={points.map((p) => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' ')}
        />
        {points.map((point) => (
          <circle key={point.id} cx={point.x} cy={point.y} r={2} fill="#3b82f6" />
        ))}
      </svg>
      <p className="text-xs text-slate-500">
        최저 {formatMeasure(min, unit)} · 최고 {formatMeasure(max, unit)}
      </p>
    </div>
  );
}

export default function TechTargetSection({
  projectId,
  views,
  summary,
  years,
  organizations,
}: TechTargetSectionProps) {
  const router = useRouter();
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [formMode, setFormMode] = useState<'create' | 'edit' | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [deletingRecord, setDeletingRecord] = useState<{
    techTarget: TechTarget;
    record: TechTargetRecord;
  } | null>(null);
  // 측정 이력 인라인 폼: recordId가 null이면 추가, 있으면 편집(O-1 낙관적 잠금은 폼이 건다)
  const [recordForm, setRecordForm] = useState<{
    techTargetId: string;
    recordId: string | null;
  } | null>(null);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<{ message: string; code?: ActionErrorCode } | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const byId = useMemo(
    () => new Map(views.map((view) => [view.techTarget.id, view.techTarget])),
    [views]
  );
  const orgNameById = useMemo(
    () => new Map(organizations.map((org) => [org.id, org.name])),
    [organizations]
  );
  const yearById = useMemo(() => new Map(years.map((year) => [year.id, year])), [years]);

  // 편집 대상은 매번 최신 props에서 다시 찾는다 — O-3의 "다시 불러오기"가 모달까지 닿는 경로다
  const editingTarget = editingId === null ? undefined : byId.get(editingId);
  const deletingTarget = deletingId === null ? null : (byId.get(deletingId) ?? null);

  // 편집 중인 측정 이력도 최신 props에서 다시 찾는다 — 폼이 새 version을 받아야 저장이 이어진다
  const editingRecord: TechTargetRecord | undefined =
    recordForm === null || recordForm.recordId === null
      ? undefined
      : byId.get(recordForm.techTargetId)?.records.find((r) => r.id === recordForm.recordId);

  // 미측정 건수는 서버가 준 current로만 센다 (§6.3: 미측정도 분모에 포함되고 달성률 0으로 들어간다)
  const unmeasuredCount = views.filter((view) => view.current === null).length;

  async function run<T>(
    action: () => Promise<ActionResult<T>>,
    onSuccess: (data: T) => void
  ): Promise<void> {
    setBusy(true);
    setFailure(null);
    try {
      const res = await action();
      if (!res.ok) {
        setFailure({ message: res.error, code: res.code });
        return;
      }
      onSuccess(res.data);
      router.refresh();
    } finally {
      setBusy(false);
    }
  }

  const handleDeleteTarget = (target: TechTarget): void => {
    void run(
      () => deleteTechTarget(target.id),
      () => {
        setDeletingId(null);
        if (expandedId === target.id) setExpandedId(null);
        if (recordForm?.techTargetId === target.id) setRecordForm(null);
        setNotice(
          `${target.name} 평가항목을 삭제했습니다. 측정 이력 ${target.records.length}건도 함께 정리했습니다.`
        );
      }
    );
  };

  const handleDeleteRecord = (target: TechTarget, record: TechTargetRecord): void => {
    void run(
      () => deleteTechRecord(target.id, record.id),
      () => {
        setDeletingRecord(null);
        // 지운 이력을 편집하던 폼이 열려 있으면 함께 닫는다 — 사라진 대상의 폼을 남기지 않는다
        if (recordForm?.recordId === record.id) setRecordForm(null);
        setNotice(`${target.name}의 ${record.date} 측정 이력을 삭제했습니다.`);
      }
    );
  };

  const orgLabel = (orgId: string | null): string => {
    if (orgId === null) return '미지정';
    return orgNameById.get(orgId) ?? '(삭제된 기관)';
  };

  return (
    <section aria-labelledby="tech-target-section-title" className="print:text-black">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 id="tech-target-section-title" className="text-base font-bold text-slate-900">
          정량적 기술목표
          <span className="ml-2 text-xs font-normal text-slate-500">{views.length}개 항목</span>
        </h2>
        <div className="flex gap-2 print:hidden">
          <Button size="sm" onClick={() => window.print()}>
            인쇄
          </Button>
          <Button
            size="sm"
            variant="primary"
            disabled={busy}
            onClick={() => {
              setEditingId(null);
              setFormMode('create');
            }}
          >
            평가항목 추가
          </Button>
        </div>
      </div>

      {failure && (
        <ErrorBanner
          message={failure.message}
          code={failure.code}
          onDismiss={() => setFailure(null)}
          className="mt-3 print:hidden"
        />
      )}

      {notice && (
        <div
          role="status"
          className="mt-3 flex items-start justify-between gap-4 rounded-xl border border-slate-200 bg-slate-50 p-3 text-sm text-slate-700 print:hidden"
        >
          <p className="min-w-0 break-words">{notice}</p>
          <button
            type="button"
            onClick={() => setNotice(null)}
            aria-label="알림 닫기"
            className="shrink-0 font-bold text-slate-400 hover:text-slate-600"
          >
            ×
          </button>
        </div>
      )}

      {/* 상단 요약: 가중 달성률 게이지 + 비중 합계 (§7.7). 값은 전부 techSummary 그대로다 */}
      <div className="mt-3 flex flex-wrap items-center gap-x-8 gap-y-4 rounded-xl border border-slate-200 bg-white p-4 print:rounded-none print:border-slate-400">
        <div className="flex items-center gap-3">
          {summary.weightSum === 0 || summary.weightedRate === null ? (
            // T-3: 비중 합계가 0이면 나눌 분모가 없다 — 게이지 대신 N/A
            <div
              className="flex h-16 w-[120px] items-center justify-center rounded-lg bg-slate-50 text-lg font-bold text-slate-400"
              title="비중 합계가 0이라 가중 달성률을 계산할 수 없습니다."
            >
              N/A
            </div>
          ) : (
            <WeightedGauge rate={summary.weightedRate} />
          )}
          <div>
            <p className="text-xs text-slate-500">전체 가중 달성률</p>
            <p className="text-2xl font-bold tabular-nums text-slate-900">
              {formatRate(summary.weightedRate)}
            </p>
          </div>
        </div>

        <div className="min-w-0">
          <p className="text-xs text-slate-500">비중 합계</p>
          <p className="text-sm font-semibold tabular-nums text-slate-800">
            {formatNumber(summary.weightSum)}%
          </p>
          {summary.weightMismatch && (
            <Badge tone="amber" className="mt-1.5 max-w-full whitespace-normal text-left">
              비중 합계 {formatNumber(summary.weightSum)}% (100 아님). 실제 합계로 정규화해
              계산했습니다.
            </Badge>
          )}
          {unmeasuredCount > 0 && (
            <p className="mt-1.5 text-xs text-slate-500">
              미측정 {unmeasuredCount}건은 달성률 0으로 전체 계산에 포함됩니다.
            </p>
          )}
        </div>
      </div>

      <div className="mt-4 overflow-x-auto rounded-xl border border-slate-200 bg-white print:overflow-visible print:rounded-none print:border-0">
        <table className="w-full min-w-[1040px] text-left text-sm print:min-w-0 print:border-collapse print:text-xs">
          <caption className="hidden px-3 py-2 text-left text-sm font-bold text-slate-900 print:table-caption">
            정량적 기술목표
          </caption>
          <thead className="text-xs text-slate-500 print:text-black">
            <tr className="border-b border-slate-100">
              <th className={TH_CLASS}>평가항목</th>
              <th className={TH_CLASS}>단위</th>
              <th className={TH_CLASS}>비중(%)</th>
              <th className={TH_CLASS}>국내수준</th>
              <th className={TH_CLASS}>세계최고</th>
              <th className={TH_CLASS}>목표치</th>
              <th className={TH_CLASS}>현재 실적</th>
              <th className={TH_CLASS}>달성률</th>
              <th className={TH_CLASS}>측정방법</th>
              <th className={`${TH_CLASS} text-right print:hidden`}>동작</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {views.length === 0 && (
              <tr>
                <td colSpan={COLUMN_COUNT} className="px-3 py-8 text-center text-sm text-slate-400">
                  등록된 평가항목이 없습니다. [평가항목 추가]로 시작하세요.
                </td>
              </tr>
            )}

            {views.map((view) => {
              const target = view.techTarget;
              const expanded = expandedId === target.id;
              const recordsDesc = sortRecordsAsc(target.records).reverse();

              return (
                <Fragment key={target.id}>
                  <tr className={expanded ? 'bg-slate-50' : ''}>
                    <td className={TD_CLASS}>
                      <div className="flex flex-wrap items-center gap-1.5">
                        <button
                          type="button"
                          onClick={() => setExpandedId(expanded ? null : target.id)}
                          aria-expanded={expanded}
                          aria-label={`${target.name} 측정 이력 ${expanded ? '접기' : '펼치기'}`}
                          className="shrink-0 rounded-md border border-slate-200 px-1.5 text-xs text-slate-500 hover:bg-slate-100 print:hidden"
                        >
                          {expanded ? '▾' : '▸'}
                        </button>
                        <span className="font-medium text-slate-900">{target.name}</span>
                        <Badge tone="neutral">{DIRECTION_LABELS[target.direction]}</Badge>
                        {/* T-4 */}
                        {view.evaluatorMissing && (
                          <Badge tone="amber">공인시험 결과인데 평가기관이 비어 있습니다</Badge>
                        )}
                      </div>
                    </td>
                    <td className={`${TD_CLASS} text-slate-600`}>{target.unit || '—'}</td>
                    <td className={`${TD_CLASS} tabular-nums text-slate-600`}>
                      {formatNumber(target.weight)}
                    </td>
                    <td className={`${TD_CLASS} tabular-nums text-slate-600`}>
                      {formatMeasure(target.baselineDomestic, target.unit)}
                    </td>
                    <td className={`${TD_CLASS} tabular-nums text-slate-600`}>
                      {formatMeasure(target.worldBest, target.unit)}
                      {target.worldBestHolder && (
                        <span className="block text-xs text-slate-400">{target.worldBestHolder}</span>
                      )}
                    </td>
                    <td className={`${TD_CLASS} tabular-nums font-medium text-slate-800`}>
                      {formatMeasure(target.targetValue, target.unit)}
                    </td>
                    <td className={`${TD_CLASS} tabular-nums text-slate-800`}>
                      {view.current === null ? (
                        <Badge
                          tone="neutral"
                          title="아직 측정값이 없습니다. 전체 가중 달성률에는 0으로 들어갑니다 (§6.3)."
                        >
                          미측정
                        </Badge>
                      ) : (
                        formatMeasure(view.current, target.unit)
                      )}
                    </td>
                    <td className={TD_CLASS}>
                      {view.rate === null ? (
                        // T-2: 계산 불가는 숨기지 않고 이유와 함께 드러낸다
                        <Badge tone="neutral" title={unavailableRateReason(view)}>
                          N/A
                        </Badge>
                      ) : (
                        <div className="min-w-[110px]">
                          {/* T-1: 서버가 0~100으로 클램프한 값을 그대로 그린다 */}
                          <div className="print:hidden">
                            <ProgressBar value={view.rate} showValue={false} label="달성률" />
                          </div>
                          <span className="text-sm font-semibold tabular-nums text-slate-800">
                            {formatRate(view.rate)}
                          </span>
                        </div>
                      )}
                    </td>
                    <td className={`${TD_CLASS} text-slate-600`}>
                      {MEASURE_METHOD_LABELS[target.measureMethod]}
                      {target.measureDescription && (
                        <span className="block max-w-[220px] truncate text-xs text-slate-400 print:max-w-none print:overflow-visible print:whitespace-normal">
                          {target.measureDescription}
                        </span>
                      )}
                    </td>
                    <td className={`${TD_CLASS} text-right print:hidden`}>
                      <div className="flex flex-wrap justify-end gap-1.5">
                        <Button
                          size="sm"
                          disabled={busy}
                          onClick={() => {
                            setEditingId(target.id);
                            setFormMode('edit');
                          }}
                        >
                          수정
                        </Button>
                        <Button
                          size="sm"
                          variant="danger"
                          disabled={busy}
                          onClick={() => setDeletingId(target.id)}
                        >
                          삭제
                        </Button>
                      </div>
                    </td>
                  </tr>

                  {expanded && (
                    // 확장 영역은 인쇄에서 빠진다 — 계획서 표에는 본문 표만 남는다 (§7.7)
                    <tr className="bg-slate-50 print:hidden">
                      <td colSpan={COLUMN_COUNT} className="px-4 py-4">
                        <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_auto]">
                          <div className="min-w-0">
                            <dl className="grid grid-cols-2 gap-x-6 gap-y-1.5 text-xs sm:grid-cols-3">
                              <div>
                                <dt className="text-slate-500">책임 기관</dt>
                                <dd className="text-slate-800">{orgLabel(target.orgId)}</dd>
                              </div>
                              <div>
                                <dt className="text-slate-500">세계최고 보유국/기관</dt>
                                <dd className="text-slate-800">{target.worldBestHolder || '—'}</dd>
                              </div>
                              <div>
                                <dt className="text-slate-500">측정방법 상세</dt>
                                <dd className="whitespace-pre-wrap text-slate-800">
                                  {target.measureDescription || '—'}
                                </dd>
                              </div>
                            </dl>

                            {years.length > 0 && (
                              <div className="mt-3">
                                <p className="text-xs font-semibold text-slate-600">연차별 목표치</p>
                                <div className="mt-1 flex flex-wrap gap-2">
                                  {years.map((year) => {
                                    const yearTarget = target.targetByYear[year.id];
                                    return (
                                      <span
                                        key={year.id}
                                        className="rounded-lg border border-slate-200 bg-white px-2 py-1 text-xs"
                                      >
                                        <span className="text-slate-500">{yearLabel(year)}</span>{' '}
                                        <span className="font-semibold tabular-nums text-slate-800">
                                          {yearTarget === undefined
                                            ? '미설정'
                                            : formatMeasure(yearTarget, target.unit)}
                                        </span>
                                      </span>
                                    );
                                  })}
                                </div>
                              </div>
                            )}
                          </div>

                          <Sparkline records={target.records} unit={target.unit} />
                        </div>

                        <div className="mt-4">
                          <div className="flex flex-wrap items-center justify-between gap-2">
                            <p className="text-xs font-semibold text-slate-600">
                              측정 이력
                              <span className="ml-1.5 font-normal text-slate-400">
                                {target.records.length}건
                              </span>
                            </p>
                            {!(recordForm?.techTargetId === target.id &&
                              recordForm.recordId === null) && (
                              <Button
                                size="sm"
                                disabled={busy}
                                onClick={() =>
                                  setRecordForm({ techTargetId: target.id, recordId: null })
                                }
                              >
                                측정값 추가
                              </Button>
                            )}
                          </div>

                          {target.records.length === 0 ? (
                            <p className="mt-2 text-xs text-slate-400">
                              측정 이력이 없습니다. 측정값을 추가하면 최신 값이 현재 실적치가 됩니다.
                            </p>
                          ) : (
                            <ul className="mt-2 divide-y divide-slate-200 rounded-xl border border-slate-200 bg-white">
                              {recordsDesc.map((record) => (
                                <li
                                  key={record.id}
                                  className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2 text-xs"
                                >
                                  <span className="w-24 shrink-0 tabular-nums text-slate-500">
                                    {record.date}
                                  </span>
                                  <span className="font-semibold tabular-nums text-slate-900">
                                    {formatMeasure(record.value, target.unit)}
                                  </span>
                                  <Badge tone="neutral">
                                    {MEASURE_METHOD_LABELS[record.method]}
                                  </Badge>
                                  <span className="text-slate-600">
                                    {record.evaluator.trim() === '' ? (
                                      <span className="text-slate-400">평가기관 미기재</span>
                                    ) : (
                                      record.evaluator
                                    )}
                                  </span>
                                  {record.yearId !== null && (
                                    <span className="text-slate-500">
                                      {/* 목록에 없는 연차를 가리키면 감추지 않고 사실을 드러낸다 */}
                                      {(() => {
                                        const year = yearById.get(record.yearId);
                                        return year ? yearLabel(year) : '(목록에 없는 연차)';
                                      })()}
                                    </span>
                                  )}
                                  {record.evidenceUrl.trim() !== '' &&
                                    (isLink(record.evidenceUrl) ? (
                                      <a
                                        href={record.evidenceUrl}
                                        target="_blank"
                                        rel="noreferrer"
                                        className="text-blue-600 underline underline-offset-2"
                                      >
                                        증빙
                                      </a>
                                    ) : (
                                      <span className="text-slate-500">
                                        증빙: {record.evidenceUrl}
                                      </span>
                                    ))}
                                  {record.note.trim() !== '' && (
                                    <span className="min-w-0 break-words text-slate-500">
                                      {record.note}
                                    </span>
                                  )}
                                  <div className="ml-auto flex shrink-0 gap-1.5">
                                    <Button
                                      size="sm"
                                      variant="ghost"
                                      disabled={busy}
                                      onClick={() =>
                                        setRecordForm({
                                          techTargetId: target.id,
                                          recordId: record.id,
                                        })
                                      }
                                    >
                                      수정
                                    </Button>
                                    <Button
                                      size="sm"
                                      variant="ghost"
                                      disabled={busy}
                                      onClick={() =>
                                        setDeletingRecord({ techTarget: target, record })
                                      }
                                    >
                                      삭제
                                    </Button>
                                  </div>
                                </li>
                              ))}
                            </ul>
                          )}

                          {recordForm?.techTargetId === target.id &&
                            (recordForm.recordId !== null && !editingRecord ? (
                              // 편집하려던 이력이 사라졌다(남이 지웠다). 빈 폼으로 눙치지 않고 사실을 알린다
                              <ErrorBanner
                                message="편집하려던 측정 이력이 더 이상 없습니다. 다른 사용자가 삭제했을 수 있습니다."
                                onDismiss={() => setRecordForm(null)}
                                className="mt-3"
                              />
                            ) : (
                              <TechRecordForm
                                // 대상이 바뀌면 폼 상태를 새로 시작한다 (입력이 섞이지 않게)
                                key={recordForm.recordId ?? 'create'}
                                techTargetId={target.id}
                                mode={recordForm.recordId === null ? 'create' : 'edit'}
                                record={editingRecord}
                                defaultMethod={target.measureMethod}
                                unit={target.unit}
                                disabled={busy}
                                onSaved={() => {
                                  setRecordForm(null);
                                  router.refresh();
                                }}
                                onCancel={() => setRecordForm(null)}
                              />
                            ))}
                        </div>
                      </td>
                    </tr>
                  )}
                </Fragment>
              );
            })}
          </tbody>
        </table>
      </div>

      {formMode && (
        <TechTargetFormModal
          mode={formMode}
          projectId={projectId}
          techTarget={formMode === 'edit' ? editingTarget : undefined}
          organizations={organizations}
          onClose={() => {
            setFormMode(null);
            setEditingId(null);
          }}
          onSaved={() => {
            setFormMode(null);
            setEditingId(null);
            router.refresh();
          }}
        />
      )}

      {deletingTarget && (
        <Modal
          open
          title="평가항목을 삭제합니다"
          onClose={() => setDeletingId(null)}
          closeOnBackdrop={false}
          footer={
            <>
              <Button size="sm" onClick={() => setDeletingId(null)} disabled={busy}>
                취소
              </Button>
              <Button
                size="sm"
                variant="danger"
                disabled={busy}
                onClick={() => handleDeleteTarget(deletingTarget)}
              >
                {busy ? '삭제 중…' : '삭제'}
              </Button>
            </>
          }
        >
          <p className="text-sm text-slate-700">
            <strong>{deletingTarget.name}</strong> 평가항목을 삭제하면 측정 이력{' '}
            {deletingTarget.records.length}건과 작업 연계도 함께 정리됩니다.
          </p>
          <p className="mt-3 rounded-lg bg-amber-50 p-3 text-xs text-amber-800">
            삭제하면 이 항목의 비중({formatNumber(deletingTarget.weight)}%)이 빠져 전체 가중
            달성률이 달라집니다.
          </p>
        </Modal>
      )}

      {deletingRecord && (
        <Modal
          open
          title="측정 이력을 삭제합니다"
          onClose={() => setDeletingRecord(null)}
          closeOnBackdrop={false}
          footer={
            <>
              <Button size="sm" onClick={() => setDeletingRecord(null)} disabled={busy}>
                취소
              </Button>
              <Button
                size="sm"
                variant="danger"
                disabled={busy}
                onClick={() =>
                  handleDeleteRecord(deletingRecord.techTarget, deletingRecord.record)
                }
              >
                {busy ? '삭제 중…' : '삭제'}
              </Button>
            </>
          }
        >
          <p className="text-sm text-slate-700">
            <strong>{deletingRecord.techTarget.name}</strong>의 {deletingRecord.record.date} 측정값(
            {formatMeasure(deletingRecord.record.value, deletingRecord.techTarget.unit)})을
            삭제합니다.
          </p>
          <p className="mt-3 rounded-lg bg-amber-50 p-3 text-xs text-amber-800">
            가장 최근 측정값을 지우면 그 이전 측정값이 현재 실적치가 되어 달성률이 바뀝니다.
          </p>
        </Modal>
      )}
    </section>
  );
}
