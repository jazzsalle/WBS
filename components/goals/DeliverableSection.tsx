'use client';

// 정량적 성과목표 섹션 (SOT §7.7 탭 1, §6.2 D-1~D-5, 부록 A.2)
// 표시 규칙:
//  - 달성률·경고 판정은 서버(getGoalsData → lib/goals.ts)가 계산한 DeliverableView 필드만 쓴다.
//    여기서 다시 나누면 규칙이 두 곳에 생긴다(O-4). 표시 반올림도 formatRate() 한 곳뿐이다(P-8).
//  - D-1 rate=null → N/A(진행바 없음) / D-2 rate>100 → 바는 100에서 잘리고 숫자는 실제 값
//    D-3 yearTargetMismatch → 행 경고 / D-4 yearId=null 실적 → "연차 미지정" / D-5 offTarget → "목표 외 달성"
// 쓰기는 전부 actions/goals.ts를 거친다. supabase를 직접 부르지 않는다(§8.2 C-2).

import { Fragment, useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import type {
  ActionResult,
  Deliverable,
  DeliverableAchievement,
  Member,
  Organization,
  Year,
} from '@/types';
import type { ActionErrorCode } from '@/lib/db/errors';
import type { DeliverableView, GoalsData } from '@/actions/goals';
import { DELIVERABLE_TYPE_LABELS } from '@/lib/constants';
import { formatRate } from '@/lib/goals';
import {
  deleteAchievement,
  deleteDeliverable,
  reorderDeliverables,
  setDeliverableYearTargets,
} from '@/actions/goals';
import Badge from '@/components/ui/Badge';
import Button from '@/components/ui/Button';
import Modal from '@/components/ui/Modal';
import ProgressBar from '@/components/ui/ProgressBar';
import ErrorBanner from '@/components/ui/ErrorBanner';
import { setRealtimePaused } from '@/components/RealtimeRefresher';
import DeliverableFormModal from './DeliverableFormModal';
import AchievementForm from './AchievementForm';

export interface DeliverableSectionProps {
  projectId: string;
  views: DeliverableView[];
  summary: GoalsData['deliverableSummary'];
  years: Year[];
  organizations: Organization[];
  members: Member[];
}

type YearCell = DeliverableView['byYear'][string];

// 유형별 도넛 색. 부록 A.3에는 성과목표 유형 색이 없어 새 색 규약을 만들지 않는다 —
// 대신 진행바(blue-500)와 같은 색조의 명도 단계만 순환시키고, 식별은 범례가 맡는다.
// 부록 A에 없는 값이므로 lib/constants.ts가 아니라 이 컴포넌트 안에만 둔다.
// 헥스가 아니라 var(--color-*)로 두어야 다크 팔레트(부록 E.5)에서 같이 뒤집힌다.
const TYPE_SHADES: readonly string[] = [
  'var(--color-blue-900)',
  'var(--color-blue-700)',
  'var(--color-blue-600)',
  'var(--color-blue-500)',
  'var(--color-blue-300)',
  'var(--color-blue-200)',
  'var(--color-blue-100)',
] as const;

function typeShade(index: number): string {
  // 유형이 색 수보다 많으면 명도가 반복된다 — 범례가 옆에 붙어 있어 식별은 유지된다
  return TYPE_SHADES[index % TYPE_SHADES.length] ?? 'var(--color-blue-500)';
}

/**
 * §7.7 탭 1 "유형별 도넛". 조각 길이는 유형별 **목표 건수 구성비**다 — 달성률이 아니다
 * (달성률은 서버가 준 값만 쓴다). 새 의존성 없이 인라인 SVG로 그린다.
 */
function TypeDonut({
  byType,
  targetTotal,
}: {
  byType: GoalsData['deliverableSummary']['byType'];
  targetTotal: number;
}) {
  const radius = 34;
  const circumference = 2 * Math.PI * radius;

  // 목표가 0인 유형은 조각이 없다. 색 인덱스는 전체 목록 기준이라 범례와 어긋나지 않는다
  let consumed = 0;
  const arcs = byType.map((bucket, index) => {
    const length = targetTotal === 0 ? 0 : (bucket.target / targetTotal) * circumference;
    const offset = consumed;
    consumed += length;
    return { type: bucket.type, length, offset, color: typeShade(index) };
  });

  return (
    <svg
      viewBox="0 0 88 88"
      role="img"
      aria-label={`유형별 목표 구성. 전체 목표 ${targetTotal}건`}
      className="h-24 w-24 shrink-0"
    >
      <circle cx="44" cy="44" r={radius} fill="none" stroke="var(--color-grey-200)" strokeWidth="10" />
      {arcs
        .filter((arc) => arc.length > 0)
        .map((arc) => (
          <circle
            key={arc.type}
            cx="44"
            cy="44"
            r={radius}
            fill="none"
            stroke={arc.color}
            strokeWidth="10"
            strokeDasharray={`${arc.length} ${circumference - arc.length}`}
            strokeDashoffset={-arc.offset}
            transform="rotate(-90 44 44)"
          />
        ))}
      <text x="44" y="49" textAnchor="middle" className="fill-grey-900 text-[13px] font-bold">
        {targetTotal}건
      </text>
    </svg>
  );
}

/** 연차별 목표 매트릭스 셀 (§7.7 "연차별 목표는 매트릭스 셀에서 직접 편집") */
interface YearTargetCellProps {
  cell: YearCell;
  unit: string;
  disabled: boolean;
  /** null = 목표 미설정(키 삭제). 0(목표 0건)과 구분한다 */
  onSave: (target: number | null) => void;
}

function YearTargetCell({ cell, unit, disabled, onSave }: YearTargetCellProps) {
  const [draft, setDraft] = useState<string>(cell.target === null ? '' : String(cell.target));
  const [editing, setEditing] = useState(false);
  const [invalid, setInvalid] = useState(false);

  // 편집 중에는 서버 값을 따라가지 않는다 — 입력하던 값이 새로고침으로 덮이면 작업이 사라진다
  useEffect(() => {
    if (editing) return;
    setDraft(cell.target === null ? '' : String(cell.target));
  }, [cell.target, editing]);

  // R-4: 셀을 편집하는 동안 자동 새로고침을 보류한다
  useEffect(() => {
    if (!editing) return;
    setRealtimePaused(true);
    return () => setRealtimePaused(false);
  }, [editing]);

  const commit = (): void => {
    setEditing(false);
    const trimmed = draft.trim();

    if (trimmed === '') {
      setInvalid(false);
      if (cell.target === null) return;
      onSave(null);
      return;
    }

    const next = Number(trimmed);
    // §5.8 목표는 건수다. 서버도 거부하는 값이라 여기서 먼저 사실을 알리고 저장을 보내지 않는다
    if (!Number.isInteger(next) || next < 0) {
      setInvalid(true);
      return;
    }
    setInvalid(false);
    if (next === cell.target) return;
    onSave(next);
  };

  return (
    <div className="min-w-[5.5rem]">
      <input
        type="number"
        inputMode="numeric"
        min={0}
        step={1}
        value={draft}
        disabled={disabled}
        aria-label={`연차 목표(${unit})`}
        placeholder="미설정"
        onFocus={() => setEditing(true)}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            e.currentTarget.blur();
          }
          if (e.key === 'Escape') {
            setDraft(cell.target === null ? '' : String(cell.target));
            setInvalid(false);
            setEditing(false);
            e.currentTarget.blur();
          }
        }}
        className={`w-20 rounded-md border px-2 py-1 text-right text-xs tabular-nums focus:outline-none ${
          invalid ? 'border-red-400 bg-red-50' : 'border-grey-300 focus:border-grey-500'
        }`}
      />
      {invalid && <p className="mt-0.5 text-[11px] text-red-600">0 이상 정수만 저장됩니다.</p>}

      <div className="mt-1 text-xs text-grey-600">
        실적 <span className="font-semibold tabular-nums">{cell.achieved}</span>
      </div>

      {/* D-5: 목표가 없거나 0인데 실적이 있으면 달성률은 N/A이고 "목표 외 달성"을 드러낸다 */}
      {cell.offTarget ? (
        <Badge tone="amber" title="이 연차에 목표가 없는데 실적이 있습니다 (D-5)">
          목표 외 달성
        </Badge>
      ) : (
        <span className="text-xs text-grey-500 tabular-nums">{formatRate(cell.rate)}</span>
      )}
    </div>
  );
}

export default function DeliverableSection({
  projectId,
  views,
  summary,
  years,
  organizations,
  members,
}: DeliverableSectionProps) {
  const router = useRouter();
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  const [formMode, setFormMode] = useState<'create' | 'edit' | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  // 실적 인라인 폼: achievementId가 null이면 추가, 있으면 편집
  const [achievementForm, setAchievementForm] = useState<{
    deliverableId: string;
    achievementId: string | null;
  } | null>(null);
  const [deletingAchievement, setDeletingAchievement] = useState<{
    deliverableId: string;
    achievement: DeliverableAchievement;
  } | null>(null);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<{ message: string; code?: ActionErrorCode } | null>(null);

  // 표시 순서는 과제 전체 기준 연차 순서를 따른다 (§5.5 order는 0-based)
  const orderedYears = useMemo(() => [...years].sort((a, b) => a.order - b.order), [years]);

  const byId = useMemo(
    () => new Map(views.map((view) => [view.deliverable.id, view])),
    [views]
  );
  // 편집 대상은 매번 최신 props에서 다시 찾는다 — O-3의 "다시 불러오기"가 모달까지 닿는 경로다
  const editingDeliverable: Deliverable | undefined =
    editingId === null ? undefined : byId.get(editingId)?.deliverable;
  const deletingDeliverable = deletingId === null ? null : (byId.get(deletingId) ?? null);

  const editingAchievement: DeliverableAchievement | undefined =
    achievementForm === null || achievementForm.achievementId === null
      ? undefined
      : byId
          .get(achievementForm.deliverableId)
          ?.deliverable.achievements.find((a) => a.id === achievementForm.achievementId);

  const orgName = (orgId: string | null): string => {
    if (orgId === null) return '—';
    return organizations.find((org) => org.id === orgId)?.name ?? '(삭제된 기관)';
  };

  const yearName = (yearId: string | null): string | null => {
    if (yearId === null) return null;
    return orderedYears.find((year) => year.id === yearId)?.name ?? '(삭제된 연차)';
  };

  const memberNames = (memberIds: readonly string[]): string => {
    if (memberIds.length === 0) return '—';
    return memberIds
      .map((id) => members.find((member) => member.id === id)?.name ?? '(삭제된 인력)')
      .join(', ');
  };

  async function run<T>(
    action: () => Promise<ActionResult<T>>,
    onSuccess?: (data: T) => void
  ): Promise<void> {
    setBusy(true);
    setFailure(null);
    try {
      const res = await action();
      if (!res.ok) {
        setFailure({ message: res.error, code: res.code });
        return;
      }
      onSuccess?.(res.data);
      router.refresh();
    } finally {
      setBusy(false);
    }
  }

  const toggleExpanded = (id: string): void => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const handleYearTarget = (view: DeliverableView, yearId: string, target: number | null): void => {
    // 액션이 맵을 통째로 교체하므로 기존 값을 그대로 옮기고 이 연차만 바꾼다
    const next: Record<string, number> = { ...view.deliverable.targetByYear };
    if (target === null) delete next[yearId];
    else next[yearId] = target;
    void run(() => setDeliverableYearTargets(view.deliverable.id, next));
  };

  const handleMove = (index: number, direction: -1 | 1): void => {
    const target = index + direction;
    if (target < 0 || target >= views.length) return;
    const ids = views.map((view) => view.deliverable.id);
    const moved = ids[index];
    const swapped = ids[target];
    if (moved === undefined || swapped === undefined) return;
    ids[index] = swapped;
    ids[target] = moved;
    void run(() => reorderDeliverables(projectId, ids));
  };

  const columnCount = 8 + orderedYears.length;

  return (
    <section aria-labelledby="deliverable-section-title">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 id="deliverable-section-title" className="text-base font-bold text-grey-900">
          정량적 성과목표
          <span className="ml-2 text-xs font-normal text-grey-500">{views.length}개 지표</span>
        </h2>
        <Button
          size="sm"
          variant="primary"
          disabled={busy}
          onClick={() => {
            setEditingId(null);
            setFormMode('create');
          }}
        >
          성과목표 추가
        </Button>
      </div>

      {failure && (
        <ErrorBanner
          message={failure.message}
          code={failure.code}
          onDismiss={() => setFailure(null)}
          className="mt-3"
        />
      )}

      {/* 상단 요약 (§7.7 "전체 목표 건수 vs 달성 건수, 유형별") */}
      <div className="mt-3 grid gap-4 rounded-xl border border-grey-200 bg-surface p-4 lg:grid-cols-2">
        <div>
          <p className="text-xs text-grey-500">전체 목표 대비 달성</p>
          <p className="mt-1 text-2xl font-bold tabular-nums text-grey-900">
            {summary.achievedTotal}
            <span className="text-base font-normal text-grey-500"> / {summary.targetTotal}건</span>
          </p>

          <div className="mt-2 flex items-center gap-2">
            {summary.rate === null ? (
              // D-1: 목표 건수가 0이면 나눌 수 없다 — 진행바를 그리지 않는다
              <Badge tone="neutral" title="목표 건수가 0이라 달성률을 계산할 수 없습니다 (D-1)">
                N/A
              </Badge>
            ) : (
              <>
                {/* D-2: 바는 100%에서 잘리고(ProgressBar가 클램프) 숫자는 실제 값을 쓴다 */}
                <ProgressBar
                  value={summary.rate}
                  showValue={false}
                  label="전체 달성률"
                  className="w-48"
                />
                <span className="text-sm font-semibold tabular-nums text-grey-800">
                  {formatRate(summary.rate)}
                </span>
                {summary.rate > 100 && (
                  <Badge tone="green" title="목표를 넘겨 달성했습니다 (D-2)">
                    초과 달성
                  </Badge>
                )}
              </>
            )}
          </div>
        </div>

        <div>
          <p className="text-xs text-grey-500">유형별 목표 구성</p>
          {summary.byType.length === 0 ? (
            <p className="mt-2 text-sm text-grey-400">등록된 성과목표가 없습니다.</p>
          ) : (
            <div className="mt-2 flex items-start gap-4">
              <TypeDonut byType={summary.byType} targetTotal={summary.targetTotal} />
              {/* 도넛만으로는 유형을 못 읽는다 — 색 칩과 건수를 나란히 둔다 */}
              <ul className="min-w-0 flex-1 space-y-1">
                {summary.byType.map((bucket, index) => (
                  <li key={bucket.type} className="flex items-center gap-2 text-xs">
                    <span
                      aria-hidden
                      className="h-2.5 w-2.5 shrink-0 rounded-sm"
                      style={{ backgroundColor: typeShade(index) }}
                    />
                    <span
                      className="min-w-0 flex-1 truncate text-grey-600"
                      title={DELIVERABLE_TYPE_LABELS[bucket.type]}
                    >
                      {DELIVERABLE_TYPE_LABELS[bucket.type]}
                    </span>
                    <span className="shrink-0 text-right tabular-nums text-grey-600">
                      달성 {bucket.achieved} / 목표 {bucket.target}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      </div>

      {views.length === 0 ? (
        <p className="mt-3 rounded-xl border border-dashed border-grey-300 bg-surface p-6 text-center text-sm text-grey-400">
          등록된 성과목표가 없습니다. [성과목표 추가]로 시작하세요.
        </p>
      ) : (
        <div className="mt-3 overflow-x-auto rounded-xl border border-grey-200 bg-surface">
          <table className="w-full text-left text-sm">
            <thead className="text-xs text-grey-500">
              <tr className="border-b border-grey-100">
                <th className="px-4 py-2 font-medium">지표명</th>
                <th className="px-3 py-2 font-medium">유형</th>
                <th className="px-3 py-2 font-medium">단위</th>
                <th className="px-3 py-2 text-right font-medium">목표(총)</th>
                <th className="px-3 py-2 text-right font-medium">달성</th>
                <th className="px-3 py-2 font-medium">달성률</th>
                {orderedYears.map((year) => (
                  <th key={year.id} className="px-3 py-2 font-medium">
                    {year.name}
                  </th>
                ))}
                <th className="px-3 py-2 font-medium">책임기관</th>
                <th className="px-3 py-2 text-right font-medium">동작</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-grey-100">
              {views.map((view, index) => {
                const { deliverable } = view;
                const isExpanded = expanded.has(deliverable.id);

                return (
                  // 행과 확장 상세가 형제 <tr>이라 Fragment로 묶는다 — 키는 여기에 있어야 한다
                  <Fragment key={deliverable.id}>
                    <tr className="align-top hover:bg-grey-50">
                      <td className="px-4 py-2.5">
                        <button
                          type="button"
                          onClick={() => toggleExpanded(deliverable.id)}
                          aria-expanded={isExpanded}
                          className="text-left font-medium text-grey-900 underline-offset-2 hover:underline"
                        >
                          <span aria-hidden className="mr-1 text-grey-400">
                            {isExpanded ? '▾' : '▸'}
                          </span>
                          {deliverable.name}
                        </button>
                        {view.yearTargetMismatch && (
                          // D-3: 저장은 허용하되 경고만 띄운다
                          <Badge
                            tone="amber"
                            className="ml-2"
                            title={`Σ연차목표 ${view.yearTargetSum}${deliverable.unit} vs 총목표 ${deliverable.targetTotal}${deliverable.unit}`}
                          >
                            연차 합계 불일치
                          </Badge>
                        )}
                        {deliverable.note !== '' && (
                          <p className="mt-1 max-w-xs truncate text-xs text-grey-500" title={deliverable.note}>
                            {deliverable.note}
                          </p>
                        )}
                      </td>
                      <td className="px-3 py-2.5 text-grey-600">
                        {DELIVERABLE_TYPE_LABELS[deliverable.type]}
                      </td>
                      <td className="px-3 py-2.5 text-grey-600">{deliverable.unit || '—'}</td>
                      <td className="px-3 py-2.5 text-right tabular-nums text-grey-800">
                        {deliverable.targetTotal}
                      </td>
                      <td className="px-3 py-2.5 text-right tabular-nums text-grey-800">
                        {view.achievedTotal}
                        {/* D-4: 연차 미지정 실적은 연차 셀 합계에서 빠지고 전체 달성에는 들어간다 —
                            표의 가로 합이 안 맞아 보이는 이유를 이 자리에서 밝힌다 */}
                        {view.unassignedAchieved > 0 && (
                          <span
                            className="mt-0.5 block text-[11px] font-normal text-orange-700"
                            title="연차 미지정 실적은 연차 셀 합계에서 빠지고 전체 달성에만 포함됩니다 (D-4)"
                          >
                            연차 미지정 {view.unassignedAchieved}
                          </span>
                        )}
                      </td>
                      <td className="px-3 py-2.5">
                        {view.rate === null ? (
                          // D-1: targetTotal이 0이면 N/A. 진행바를 그리지 않는다
                          <Badge
                            tone="neutral"
                            title="목표 건수가 0이라 달성률을 계산할 수 없습니다 (D-1)"
                          >
                            N/A
                          </Badge>
                        ) : (
                          <div className="min-w-[7rem]">
                            {/* D-2: 바는 100%에서 잘리고 숫자는 실제 값(예 116.7%) */}
                            <ProgressBar value={view.rate} showValue={false} label="달성률" />
                            <div className="mt-1 flex items-center gap-1.5">
                              <span className="text-xs font-semibold tabular-nums text-grey-700">
                                {formatRate(view.rate)}
                              </span>
                              {view.rate > 100 && (
                                <Badge tone="green" title="목표를 넘겨 달성했습니다 (D-2)">
                                  초과 달성
                                </Badge>
                              )}
                            </div>
                          </div>
                        )}
                      </td>

                      {orderedYears.map((year) => {
                        const cell = view.byYear[year.id];
                        // byYear에는 과제의 모든 연차 키가 들어 있다. 없으면 데이터가 어긋난 것이라
                        // 빈 칸으로 감추지 않고 사실을 드러낸다(절대 규칙 5)
                        if (!cell) {
                          return (
                            <td key={year.id} className="px-3 py-2.5">
                              <Badge tone="red" title="서버 집계에 이 연차가 없습니다">
                                집계 없음
                              </Badge>
                            </td>
                          );
                        }
                        return (
                          <td key={year.id} className="px-3 py-2.5">
                            <YearTargetCell
                              cell={cell}
                              unit={deliverable.unit}
                              disabled={busy}
                              onSave={(target) => handleYearTarget(view, year.id, target)}
                            />
                          </td>
                        );
                      })}

                      <td className="px-3 py-2.5 text-grey-600">{orgName(deliverable.orgId)}</td>
                      <td className="px-3 py-2.5 text-right">
                        <div className="flex flex-wrap justify-end gap-1.5">
                          <Button
                            size="sm"
                            disabled={busy || index === 0}
                            aria-label="위로 이동"
                            onClick={() => handleMove(index, -1)}
                          >
                            ↑
                          </Button>
                          <Button
                            size="sm"
                            disabled={busy || index === views.length - 1}
                            aria-label="아래로 이동"
                            onClick={() => handleMove(index, 1)}
                          >
                            ↓
                          </Button>
                          <Button
                            size="sm"
                            disabled={busy}
                            onClick={() => {
                              setEditingId(deliverable.id);
                              setFormMode('edit');
                            }}
                          >
                            수정
                          </Button>
                          <Button
                            size="sm"
                            variant="danger"
                            disabled={busy}
                            onClick={() => setDeletingId(deliverable.id)}
                          >
                            삭제
                          </Button>
                        </div>
                      </td>
                    </tr>

                    {isExpanded && (
                      <tr className="bg-grey-50">
                        <td colSpan={columnCount} className="px-4 py-3">
                          <div className="flex flex-wrap items-center justify-between gap-2">
                            <p className="text-sm font-semibold text-grey-800">
                              실적 목록
                              <span className="ml-2 text-xs font-normal text-grey-500">
                                {deliverable.achievements.length}건
                              </span>
                            </p>
                            <Button
                              size="sm"
                              disabled={busy}
                              onClick={() =>
                                setAchievementForm({
                                  deliverableId: deliverable.id,
                                  achievementId: null,
                                })
                              }
                            >
                              실적 추가
                            </Button>
                          </div>

                          {deliverable.achievements.length === 0 ? (
                            <p className="mt-2 text-sm text-grey-400">등록된 실적이 없습니다.</p>
                          ) : (
                            <table className="mt-2 w-full text-left text-xs">
                              <thead className="text-grey-500">
                                <tr className="border-b border-grey-200">
                                  <th className="py-1.5 pr-3 font-medium">산출물명</th>
                                  <th className="py-1.5 pr-3 font-medium">달성일</th>
                                  <th className="py-1.5 pr-3 font-medium">연차</th>
                                  <th className="py-1.5 pr-3 font-medium">기관</th>
                                  <th className="py-1.5 pr-3 font-medium">참여자</th>
                                  <th className="py-1.5 pr-3 font-medium">증빙</th>
                                  <th className="py-1.5 text-right font-medium">동작</th>
                                </tr>
                              </thead>
                              <tbody className="divide-y divide-grey-200">
                                {[...deliverable.achievements]
                                  // 최근 달성이 위로 — 목록이 길어져도 최신 실적을 먼저 본다
                                  .sort((a, b) => b.date.localeCompare(a.date))
                                  .map((achievement) => {
                                    const label = yearName(achievement.yearId);
                                    return (
                                      <tr key={achievement.id} className="align-top">
                                        <td className="py-1.5 pr-3 text-grey-800">
                                          {achievement.title}
                                          {achievement.note !== '' && (
                                            <p className="text-[11px] text-grey-500">
                                              {achievement.note}
                                            </p>
                                          )}
                                        </td>
                                        <td className="py-1.5 pr-3 tabular-nums text-grey-600">
                                          {achievement.date}
                                        </td>
                                        <td className="py-1.5 pr-3">
                                          {label === null ? (
                                            // D-4: 연차별 집계에서 제외되고 전체 집계에만 포함된다
                                            <Badge
                                              tone="amber"
                                              title="연차별 집계에서 제외되고 전체 집계에만 포함됩니다 (D-4)"
                                            >
                                              연차 미지정
                                            </Badge>
                                          ) : (
                                            <span className="text-grey-600">{label}</span>
                                          )}
                                        </td>
                                        <td className="py-1.5 pr-3 text-grey-600">
                                          {orgName(achievement.orgId)}
                                        </td>
                                        <td className="py-1.5 pr-3 text-grey-600">
                                          {memberNames(achievement.memberIds)}
                                        </td>
                                        <td className="py-1.5 pr-3 text-grey-600">
                                          {achievement.evidenceUrl === '' ? (
                                            '—'
                                          ) : (
                                            <a
                                              href={achievement.evidenceUrl}
                                              target="_blank"
                                              rel="noreferrer"
                                              className="break-all text-blue-700 underline underline-offset-2"
                                            >
                                              {achievement.evidenceUrl}
                                            </a>
                                          )}
                                        </td>
                                        <td className="py-1.5 text-right">
                                          <div className="flex flex-wrap justify-end gap-1.5">
                                            <Button
                                              size="sm"
                                              disabled={busy}
                                              onClick={() =>
                                                setAchievementForm({
                                                  deliverableId: deliverable.id,
                                                  achievementId: achievement.id,
                                                })
                                              }
                                            >
                                              수정
                                            </Button>
                                            <Button
                                              size="sm"
                                              variant="danger"
                                              disabled={busy}
                                              onClick={() =>
                                                setDeletingAchievement({
                                                  deliverableId: deliverable.id,
                                                  achievement,
                                                })
                                              }
                                            >
                                              삭제
                                            </Button>
                                          </div>
                                        </td>
                                      </tr>
                                    );
                                  })}
                              </tbody>
                            </table>
                          )}

                          {achievementForm?.deliverableId === deliverable.id && (
                            <div className="mt-3">
                              {achievementForm.achievementId !== null && !editingAchievement ? (
                                // 편집하려던 실적이 사라졌다(남이 지웠다). 빈 폼으로 눙치지 않고 사실을 알린다
                                <ErrorBanner
                                  message="편집하려던 실적이 더 이상 없습니다. 다른 사용자가 삭제했을 수 있습니다."
                                  onDismiss={() => setAchievementForm(null)}
                                />
                              ) : (
                                <AchievementForm
                                  // 대상이 바뀌면 폼 상태를 새로 시작한다 (입력이 섞이지 않게)
                                  key={achievementForm.achievementId ?? 'create'}
                                  deliverableId={deliverable.id}
                                  mode={achievementForm.achievementId === null ? 'create' : 'edit'}
                                  achievement={editingAchievement}
                                  years={orderedYears}
                                  organizations={organizations}
                                  members={members}
                                  onCancel={() => setAchievementForm(null)}
                                  onSaved={() => {
                                    setAchievementForm(null);
                                    router.refresh();
                                  }}
                                />
                              )}
                            </div>
                          )}
                        </td>
                      </tr>
                    )}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {formMode && (
        <DeliverableFormModal
          mode={formMode}
          projectId={projectId}
          deliverable={formMode === 'edit' ? editingDeliverable : undefined}
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

      {deletingDeliverable && (
        <Modal
          open
          title="성과목표를 삭제합니다"
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
                onClick={() =>
                  void run(() => deleteDeliverable(deletingDeliverable.deliverable.id), () => {
                    setDeletingId(null);
                    setExpanded((prev) => {
                      const next = new Set(prev);
                      next.delete(deletingDeliverable.deliverable.id);
                      return next;
                    });
                  })
                }
              >
                {busy ? '삭제 중…' : '삭제'}
              </Button>
            </>
          }
        >
          <p className="text-sm text-grey-700">
            <strong>{deletingDeliverable.deliverable.name}</strong> 지표를 삭제합니다.
          </p>
          <p className="mt-3 rounded-lg bg-orange-50 p-3 text-sm text-orange-800">
            등록된 실적 {deletingDeliverable.deliverable.achievements.length}건과 작업(WBS) 연계가
            함께 지워집니다. 작업 자체는 남습니다.
          </p>
        </Modal>
      )}

      {deletingAchievement && (
        <Modal
          open
          title="실적을 삭제합니다"
          onClose={() => setDeletingAchievement(null)}
          closeOnBackdrop={false}
          footer={
            <>
              <Button size="sm" onClick={() => setDeletingAchievement(null)} disabled={busy}>
                취소
              </Button>
              <Button
                size="sm"
                variant="danger"
                disabled={busy}
                onClick={() =>
                  void run(
                    () =>
                      deleteAchievement(
                        deletingAchievement.deliverableId,
                        deletingAchievement.achievement.id
                      ),
                    () => setDeletingAchievement(null)
                  )
                }
              >
                {busy ? '삭제 중…' : '삭제'}
              </Button>
            </>
          }
        >
          <p className="text-sm text-grey-700">
            <strong>{deletingAchievement.achievement.title}</strong> 실적을 삭제하면 달성 건수가
            줄어듭니다.
          </p>
        </Modal>
      )}
    </section>
  );
}
