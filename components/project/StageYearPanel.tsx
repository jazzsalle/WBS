'use client';

// 단계·연차 타임라인 + CRUD 패널 (SOT §7.3 "단계·연차 타임라인", §5.4, §5.5, §6.6 H-5·H-6·H-10, §9)
// 표시: 단계별로 연차 막대를 늘어놓고 각 연차의 기간·진척률·예산·상태를 보여준다.
//       status='active'인 연차가 "현재 연차"다(§5.5) — 하이라이트 대상.
// 조작: 단계 추가·수정·삭제·순서(reorderStages), 연차 추가·수정·삭제·순서(reorderYears)·상태(setYearStatus).
//       순서 변경은 HTML5 네이티브 드래그로만 한다(새 의존성 없이).
//       연차 order는 과제 전체 기준이라 단계 경계를 넘는 순서는 서버가 RULE로 거부한다(§5.5) —
//       그 경우 낙관적 순서를 버려 서버 순서로 되돌린다.
// 진척률은 서버가 계산해 내려준 값을 표시만 한다(§6.1, O-4). 금액은 원 단위 정수로 다룬다.

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import type { ActionResult, Stage, Year, YearStatus } from '@/types';
import type { ActionErrorCode } from '@/lib/db/errors';
import { YEAR_STATUS_LABELS } from '@/lib/constants';
import { createStage, deleteStage, reorderStages, updateStage } from '@/actions/stages';
import { createYear, deleteYear, reorderYears, setYearStatus, updateYear } from '@/actions/years';
import Badge, { type BadgeTone } from '@/components/ui/Badge';
import Button from '@/components/ui/Button';
import ConflictDialog from '@/components/ui/ConflictDialog';
import ErrorBanner from '@/components/ui/ErrorBanner';
import Modal from '@/components/ui/Modal';
import ProgressBar from '@/components/ui/ProgressBar';
import { setRealtimePaused } from '@/components/RealtimeRefresher';

// 부록 A.3은 planned/active/done만 정한다. evaluating·closed는 의미가 가까운 톤을 쓴다.
const YEAR_STATUS_TONES: Record<YearStatus, BadgeTone> = {
  planned: 'neutral',
  active: 'blue',
  evaluating: 'amber',
  closed: 'green',
};

/** §5.5: name이 있으면 name, 없으면 order+1 + '차년도' — Stage도 동일 규칙 */
function yearLabel(year: Year): string {
  return year.name.trim() || `${year.order + 1}차년도`;
}

function stageLabel(stage: Stage): string {
  return stage.name.trim() || `${stage.order + 1}단계`;
}

function formatWon(amount: number | null): string {
  return amount === null ? '미입력' : `${amount.toLocaleString('ko-KR')}원`;
}

function formatRange(start: string | null, end: string | null): string {
  if (!start && !end) return '기간 미입력';
  return `${start ?? '?'} ~ ${end ?? '?'}`;
}

// ─── 공용 폼 (단계·연차는 편집 필드가 같다) ────────────────────────────────────

interface FormValues {
  name: string;
  goal: string;
  startDate: string;
  endDate: string;
  budget: string; // 원 단위 정수 문자열 ('' = 미입력)
}

interface EntityPayload {
  name: string;
  goal: string;
  startDate: string | null;
  endDate: string | null;
  budget: number | null;
}

/** Stage·Year 공통으로 폼이 다루는 부분 */
type EditableEntity = Pick<Stage, 'name' | 'goal' | 'startDate' | 'endDate' | 'budget' | 'version'>;

const FORM_FIELDS = [
  { key: 'name', label: '이름' },
  { key: 'goal', label: '목표' },
  { key: 'startDate', label: '시작일' },
  { key: 'endDate', label: '종료일' },
  { key: 'budget', label: '연구개발비' },
] as const;

const EMPTY_VALUES: FormValues = { name: '', goal: '', startDate: '', endDate: '', budget: '' };

// 부동소수점 오차 없이 다룰 수 있는 자리수 한계
const MAX_AMOUNT_DIGITS = 15;

function toValues(entity: EditableEntity): FormValues {
  return {
    name: entity.name,
    goal: entity.goal,
    startDate: entity.startDate ?? '',
    endDate: entity.endDate ?? '',
    budget: entity.budget === null ? '' : String(entity.budget),
  };
}

function toDigits(raw: string): string {
  return raw.replace(/[^0-9]/g, '').replace(/^0+(?=\d)/, '');
}

function formatAmountInput(digits: string): string {
  return digits === '' ? '' : Number(digits).toLocaleString('ko-KR');
}

function displayValue(key: (typeof FORM_FIELDS)[number]['key'], values: FormValues): string {
  const raw = values[key];
  if (key === 'budget') return raw === '' ? '(미입력)' : `${formatAmountInput(raw)}원`;
  return raw === '' ? '(비어 있음)' : raw;
}

interface EntityFormModalProps {
  title: string;
  description?: string;
  namePlaceholder: string;
  /** edit 모드 전용. 부모가 서버 최신 값을 계속 내려준다 (O-3 비교 기준) */
  entity?: EditableEntity;
  submitLabel: string;
  onSubmit: (payload: EntityPayload, expectedVersion?: number) => Promise<ActionResult<unknown>>;
  onClose: () => void;
  onSaved: () => void;
}

function EntityFormModal({
  title,
  description,
  namePlaceholder,
  entity,
  submitLabel,
  onSubmit,
  onClose,
  onSaved,
}: EntityFormModalProps) {
  const router = useRouter();
  const [values, setValues] = useState<FormValues>(() => (entity ? toValues(entity) : EMPTY_VALUES));
  const [saving, setSaving] = useState(false);
  const [failure, setFailure] = useState<{ message: string; code?: ActionErrorCode } | null>(null);
  const [conflict, setConflict] = useState<string | null>(null);
  // O-3 비교 기준: 마지막으로 받아들인 서버 값. "다시 불러오기" 후 부모가 최신 값을 내려주면 갱신된다.
  const [baseline, setBaseline] = useState<EditableEntity | null>(entity ?? null);
  const [reloaded, setReloaded] = useState(false);

  // R-4: 폼이 열려 있는 동안에는 자동 새로고침을 보류해 입력 중인 내용을 지키지 않게 한다
  useEffect(() => {
    setRealtimePaused(true);
    return () => setRealtimePaused(false);
  }, []);

  const baselineVersion = baseline?.version;
  useEffect(() => {
    if (!entity || entity.version === baselineVersion) return;
    // 입력값(values)은 건드리지 않는다 — 작업 내용을 날리지 않는 것이 O-3의 핵심이다
    setBaseline(entity);
    setConflict(null);
    setReloaded(true);
  }, [entity, baselineVersion]);

  const differences = useMemo(() => {
    if (!reloaded || !baseline) return [];
    const latest = toValues(baseline);
    return FORM_FIELDS.filter((f) => latest[f.key] !== values[f.key]).map((f) => ({
      field: f,
      latest,
    }));
  }, [reloaded, baseline, values]);

  const setField = <K extends keyof FormValues>(key: K, value: FormValues[K]) => {
    setValues((prev) => ({ ...prev, [key]: value }));
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setFailure(null);

    if (values.budget.length > MAX_AMOUNT_DIGITS) {
      setFailure({ message: '금액이 너무 큽니다. 입력값을 확인하세요.', code: 'VALIDATION' });
      return;
    }
    if (values.startDate && values.endDate && values.startDate > values.endDate) {
      setFailure({ message: '종료일이 시작일보다 빠릅니다.', code: 'VALIDATION' });
      return;
    }

    const payload: EntityPayload = {
      name: values.name.trim(),
      goal: values.goal,
      startDate: values.startDate || null,
      endDate: values.endDate || null,
      budget: values.budget === '' ? null : Number(values.budget),
    };

    setSaving(true);
    try {
      // O-1: 여러 필드를 한 번에 바꾸므로 마지막으로 읽은 version을 조건으로 건다
      const res = await onSubmit(payload, baseline?.version);
      if (!res.ok) {
        // O-3: STALE은 배너가 아니라 선택 다이얼로그로 — 입력을 유지한 채 사용자가 고른다
        if (res.code === 'STALE') setConflict(res.error);
        else setFailure({ message: res.error, code: res.code });
        return;
      }
      onSaved();
    } finally {
      setSaving(false);
    }
  };

  return (
    <>
      <Modal open title={title} description={description} onClose={onClose} closeOnBackdrop={false}>
        <form onSubmit={handleSubmit}>
          {failure && (
            <ErrorBanner
              message={failure.message}
              code={failure.code}
              onDismiss={() => setFailure(null)}
              className="mb-4"
            />
          )}

          {reloaded && (
            <div className="mb-4 rounded-xl border border-amber-200 bg-amber-50 p-3 text-sm text-amber-800">
              <p className="font-semibold">최신 내용을 다시 불러왔습니다.</p>
              {differences.length === 0 ? (
                <p className="mt-1 text-xs">내 입력과 다른 항목이 없습니다. 그대로 저장하면 됩니다.</p>
              ) : (
                <ul className="mt-2 space-y-1.5">
                  {differences.map(({ field, latest }) => (
                    <li
                      key={field.key}
                      className="flex flex-wrap items-center gap-2 rounded-lg bg-white/70 px-2.5 py-1.5 text-xs"
                    >
                      <span className="font-semibold text-slate-700">{field.label}</span>
                      <span className="text-slate-500">내 입력: {displayValue(field.key, values)}</span>
                      <span className="text-slate-500">최신: {displayValue(field.key, latest)}</span>
                      <button
                        type="button"
                        onClick={() => setField(field.key, latest[field.key])}
                        className="ml-auto rounded-md border border-amber-300 px-2 py-0.5 font-semibold text-amber-800"
                      >
                        최신 값 사용
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}

          <div className="grid gap-4 sm:grid-cols-2">
            <label className="sm:col-span-2">
              <span className="text-sm font-medium text-slate-700">이름</span>
              <input
                type="text"
                value={values.name}
                onChange={(e) => setField('name', e.target.value)}
                maxLength={100}
                placeholder={namePlaceholder}
                className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm focus:border-slate-500 focus:outline-none"
              />
              <span className="mt-1 block text-xs text-slate-500">
                비워 두면 순서에 따라 자동으로 표시됩니다 ({namePlaceholder}).
              </span>
            </label>

            <label>
              <span className="text-sm font-medium text-slate-700">시작일</span>
              <input
                type="date"
                value={values.startDate}
                onChange={(e) => setField('startDate', e.target.value)}
                className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm focus:border-slate-500 focus:outline-none"
              />
            </label>

            <label>
              <span className="text-sm font-medium text-slate-700">종료일</span>
              <input
                type="date"
                value={values.endDate}
                onChange={(e) => setField('endDate', e.target.value)}
                className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm focus:border-slate-500 focus:outline-none"
              />
            </label>

            <label className="sm:col-span-2">
              <span className="text-sm font-medium text-slate-700">연구개발비(원)</span>
              <input
                type="text"
                inputMode="numeric"
                value={formatAmountInput(values.budget)}
                onChange={(e) => setField('budget', toDigits(e.target.value))}
                placeholder="0"
                className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-right text-sm tabular-nums focus:border-slate-500 focus:outline-none"
              />
            </label>

            <label className="sm:col-span-2">
              <span className="text-sm font-medium text-slate-700">목표</span>
              <textarea
                value={values.goal}
                onChange={(e) => setField('goal', e.target.value)}
                rows={3}
                maxLength={2000}
                className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm focus:border-slate-500 focus:outline-none"
              />
            </label>
          </div>

          <div className="mt-6 flex justify-end gap-2">
            <Button size="md" onClick={onClose} disabled={saving}>
              취소
            </Button>
            <Button type="submit" size="md" variant="primary" disabled={saving}>
              {saving ? '저장 중…' : submitLabel}
            </Button>
          </div>
        </form>
      </Modal>

      {conflict && (
        <ConflictDialog
          message={conflict}
          // 서버 데이터를 다시 가져오면 부모가 최신 값을 내려주고, 위 effect가 비교 패널을 연다
          onReload={() => router.refresh()}
          onKeepEditing={() => setConflict(null)}
        />
      )}
    </>
  );
}

// ─── 패널 ─────────────────────────────────────────────────────────────────────

export interface YearWithProgress {
  year: Year;
  /** §6.1 롤업 결과 (서버 계산) */
  progress: number;
}

export interface StageYearPanelProps {
  projectId: string;
  stages: Stage[];
  years: YearWithProgress[];
  /** stageId → §6.1 단계 진척률 */
  stageProgress: Record<string, number>;
}

type Dialog =
  | { kind: 'stage-create' }
  | { kind: 'stage-edit'; stageId: string }
  | { kind: 'stage-delete'; stageId: string }
  | { kind: 'year-create'; stageId: string }
  | { kind: 'year-edit'; yearId: string }
  | { kind: 'year-delete'; yearId: string }
  | null;

type DragState = { kind: 'stage' | 'year'; id: string } | null;

export default function StageYearPanel({
  projectId,
  stages,
  years,
  stageProgress,
}: StageYearPanelProps) {
  const router = useRouter();
  // 드래그 직후의 낙관적 순서. 서버 순서가 갱신되거나 요청이 실패하면 버린다.
  const [localStageOrder, setLocalStageOrder] = useState<string[] | null>(null);
  const [localYearOrder, setLocalYearOrder] = useState<string[] | null>(null);
  const [drag, setDrag] = useState<DragState>(null);
  const [dropTargetId, setDropTargetId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<{ message: string; code?: ActionErrorCode } | null>(null);
  const [dialog, setDialog] = useState<Dialog>(null);

  const stageOrderKey = stages.map((s) => s.id).join(',');
  const yearOrderKey = years.map((y) => y.year.id).join(',');
  useEffect(() => {
    setLocalStageOrder(null);
  }, [stageOrderKey]);
  useEffect(() => {
    setLocalYearOrder(null);
  }, [yearOrderKey]);

  const orderedStages = useMemo(
    () => applyLocalOrder(stages, localStageOrder, (s) => s.id),
    [stages, localStageOrder]
  );
  const orderedYears = useMemo(
    () => applyLocalOrder(years, localYearOrder, (y) => y.year.id),
    [years, localYearOrder]
  );

  const yearsByStage = useMemo(() => {
    const map = new Map<string, YearWithProgress[]>();
    for (const item of orderedYears) {
      const list = map.get(item.year.stageId);
      if (list) list.push(item);
      else map.set(item.year.stageId, [item]);
    }
    return map;
  }, [orderedYears]);

  // 단계에 속하지 않은 연차는 화면에서 사라진다 — 조용히 버리지 않고 드러낸다 (절대 규칙 5)
  const stageIds = new Set(stages.map((s) => s.id));
  const orphanYears = orderedYears.filter((y) => !stageIds.has(y.year.stageId));

  const editingStage =
    dialog?.kind === 'stage-edit' || dialog?.kind === 'stage-delete'
      ? stages.find((s) => s.id === dialog.stageId)
      : undefined;
  const editingYear =
    dialog?.kind === 'year-edit' || dialog?.kind === 'year-delete'
      ? years.find((y) => y.year.id === dialog.yearId)?.year
      : undefined;

  // 편집·삭제하려던 대상이 사라지면(다른 사람이 먼저 삭제) 빈 모달이 남는다 — 알리고 닫는다
  useEffect(() => {
    if (dialog?.kind === 'stage-edit' || dialog?.kind === 'stage-delete') {
      if (editingStage) return;
      setDialog(null);
      setFailure({ message: '해당 단계를 찾을 수 없습니다. 다른 사람이 삭제했을 수 있습니다.' });
      return;
    }
    if (dialog?.kind === 'year-edit' || dialog?.kind === 'year-delete') {
      if (editingYear) return;
      setDialog(null);
      setFailure({ message: '해당 연차를 찾을 수 없습니다. 다른 사람이 삭제했을 수 있습니다.' });
    }
  }, [dialog, editingStage, editingYear]);

  const run = async (action: () => Promise<ActionResult<unknown>>, onFail?: () => void) => {
    setBusy(true);
    setFailure(null);
    const res = await action();
    setBusy(false);
    if (!res.ok) {
      onFail?.();
      setFailure({ message: res.error, code: res.code });
      return false;
    }
    router.refresh();
    return true;
  };

  const handleStageDrop = async (targetId: string) => {
    const sourceId = drag?.kind === 'stage' ? drag.id : null;
    setDrag(null);
    setDropTargetId(null);
    if (!sourceId || sourceId === targetId) return;

    const next = moveWithin(orderedStages.map((s) => s.id), sourceId, targetId);
    if (!next) return;
    setLocalStageOrder(next);
    // 실패하면 낙관적 순서를 버려 서버 순서로 되돌린다
    await run(() => reorderStages(projectId, next), () => setLocalStageOrder(null));
  };

  // 연차 순서는 과제 전체 기준이다(§5.5 H-10). 단계 경계를 넘는 순서는 서버가 RULE로 거부하고,
  // 그때는 낙관적 순서를 버려 화면을 서버 상태로 되돌린다.
  const handleYearDrop = async (targetId: string) => {
    const sourceId = drag?.kind === 'year' ? drag.id : null;
    setDrag(null);
    setDropTargetId(null);
    if (!sourceId || sourceId === targetId) return;

    const next = moveWithin(orderedYears.map((y) => y.year.id), sourceId, targetId);
    if (!next) return;
    setLocalYearOrder(next);
    await run(() => reorderYears(projectId, next), () => setLocalYearOrder(null));
  };

  const handleYearStatus = async (yearId: string, status: YearStatus) => {
    // O-2: 상태 드롭다운은 단일 조작이라 낙관적 잠금을 걸지 않는다.
    // 'active'로 바꾸면 같은 과제의 기존 active가 서버에서 해제된다(§5.5) — refresh로 뱃지가 갱신된다.
    await run(() => setYearStatus(yearId, status));
  };

  const canDeleteStage = stages.length > 1; // H-6: 마지막 단계는 삭제 불가

  return (
    <section className="rounded-2xl border border-slate-200 bg-white p-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-base font-bold text-slate-900">단계 · 연차</h2>
          <p className="mt-0.5 text-xs text-slate-500">
            연차를 클릭하면 해당 연차의 WBS로 이동합니다. 손잡이(⠿)를 끌어 순서를 바꿉니다.
          </p>
        </div>
        <Button size="sm" variant="primary" disabled={busy} onClick={() => setDialog({ kind: 'stage-create' })}>
          단계 추가
        </Button>
      </div>

      {failure && (
        <ErrorBanner
          message={failure.message}
          code={failure.code}
          onDismiss={() => setFailure(null)}
          className="mt-4"
        />
      )}

      {orphanYears.length > 0 && (
        <ErrorBanner
          message={`소속 단계를 찾을 수 없는 연차가 ${orphanYears.length}건 있습니다. 데이터를 확인하세요.`}
          className="mt-4"
        />
      )}

      {orderedStages.length === 0 ? (
        <p className="mt-6 rounded-xl border border-dashed border-slate-300 p-8 text-center text-sm text-slate-500">
          단계가 없습니다. [단계 추가]로 첫 단계를 만드세요.
        </p>
      ) : (
        <ul className="mt-4 space-y-4">
          {orderedStages.map((stage) => {
            const stageYears = yearsByStage.get(stage.id) ?? [];
            return (
              <li
                key={stage.id}
                onDragOver={(e) => {
                  if (drag?.kind !== 'stage' || drag.id === stage.id) return;
                  e.preventDefault(); // preventDefault를 해야 drop이 발생한다
                  e.dataTransfer.dropEffect = 'move';
                  setDropTargetId(stage.id);
                }}
                onDragLeave={() => setDropTargetId((prev) => (prev === stage.id ? null : prev))}
                onDrop={(e) => {
                  e.preventDefault();
                  void handleStageDrop(stage.id);
                }}
                className={`rounded-xl border p-4 transition ${
                  dropTargetId === stage.id ? 'border-blue-400 ring-2 ring-blue-200' : 'border-slate-200'
                } ${drag?.kind === 'stage' && drag.id === stage.id ? 'opacity-40' : ''}`}
              >
                <div className="flex flex-wrap items-center gap-2">
                  {orderedStages.length > 1 && (
                    <span
                      draggable
                      onDragStart={(e) => {
                        e.dataTransfer.effectAllowed = 'move';
                        e.dataTransfer.setData('text/plain', stage.id);
                        setDrag({ kind: 'stage', id: stage.id });
                      }}
                      onDragEnd={() => {
                        setDrag(null);
                        setDropTargetId(null);
                      }}
                      role="button"
                      aria-label={`${stageLabel(stage)} 순서 변경 손잡이`}
                      title="끌어서 단계 순서 변경"
                      className="cursor-grab px-1 text-slate-300 hover:text-slate-500"
                    >
                      ⠿
                    </span>
                  )}

                  <h3 className="text-sm font-bold text-slate-900">{stageLabel(stage)}</h3>
                  <span className="text-xs text-slate-500">
                    {formatRange(stage.startDate, stage.endDate)}
                  </span>
                  <span className="text-xs text-slate-500">· {formatWon(stage.budget)}</span>
                  <Badge tone="neutral" title="단계 진척률 (§6.1)">
                    진척 {Math.round(stageProgress[stage.id] ?? 0)}%
                  </Badge>

                  <div className="ml-auto flex gap-2">
                    <Button
                      size="sm"
                      disabled={busy}
                      onClick={() => setDialog({ kind: 'year-create', stageId: stage.id })}
                    >
                      연차 추가
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={busy}
                      onClick={() => setDialog({ kind: 'stage-edit', stageId: stage.id })}
                    >
                      편집
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={busy || !canDeleteStage}
                      title={
                        canDeleteStage
                          ? '단계 삭제'
                          : '과제에는 단계가 최소 1개 필요합니다. 마지막 단계는 삭제할 수 없습니다 (H-6).'
                      }
                      onClick={() => setDialog({ kind: 'stage-delete', stageId: stage.id })}
                    >
                      삭제
                    </Button>
                  </div>
                </div>

                {stage.goal.trim() && (
                  <p className="mt-2 whitespace-pre-wrap text-xs text-slate-600">{stage.goal}</p>
                )}

                {stageYears.length === 0 ? (
                  <p className="mt-3 rounded-lg border border-dashed border-slate-300 p-4 text-center text-xs text-slate-500">
                    연차가 없습니다. [연차 추가]를 누르세요.
                  </p>
                ) : (
                  <ul className="mt-3 grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
                    {stageYears.map(({ year, progress }) => (
                      <li
                        key={year.id}
                        onDragOver={(e) => {
                          if (drag?.kind !== 'year' || drag.id === year.id) return;
                          e.preventDefault();
                          e.dataTransfer.dropEffect = 'move';
                          setDropTargetId(year.id);
                        }}
                        onDragLeave={() => setDropTargetId((prev) => (prev === year.id ? null : prev))}
                        onDrop={(e) => {
                          // 단계를 끌던 중이면 여기서 삼키지 않고 상위 단계 li가 처리하게 둔다
                          if (drag?.kind !== 'year') return;
                          e.preventDefault();
                          e.stopPropagation();
                          void handleYearDrop(year.id);
                        }}
                        className={`rounded-xl border bg-slate-50/60 p-3 transition ${
                          dropTargetId === year.id
                            ? 'border-blue-400 ring-2 ring-blue-200'
                            : year.status === 'active'
                              ? 'border-blue-300 ring-1 ring-blue-200' // §5.5 현재 연차 하이라이트
                              : 'border-slate-200'
                        } ${drag?.kind === 'year' && drag.id === year.id ? 'opacity-40' : ''}`}
                      >
                        <div className="flex items-start gap-2">
                          <Link
                            href={`/projects/${projectId}/wbs?yearId=${year.id}`}
                            className="min-w-0 text-sm font-semibold text-slate-900 hover:underline"
                          >
                            {yearLabel(year)}
                          </Link>
                          {year.status === 'active' && (
                            <Badge tone="violet" title="status=active인 현재 연차">
                              현재
                            </Badge>
                          )}
                          <span
                            draggable
                            onDragStart={(e) => {
                              e.dataTransfer.effectAllowed = 'move';
                              e.dataTransfer.setData('text/plain', year.id);
                              setDrag({ kind: 'year', id: year.id });
                            }}
                            onDragEnd={() => {
                              setDrag(null);
                              setDropTargetId(null);
                            }}
                            role="button"
                            aria-label={`${yearLabel(year)} 순서 변경 손잡이`}
                            title="끌어서 연차 순서 변경 (같은 단계 안에서만 가능)"
                            className="ml-auto cursor-grab px-1 text-slate-300 hover:text-slate-500"
                          >
                            ⠿
                          </span>
                        </div>

                        <p className="mt-1 text-xs text-slate-500">
                          {formatRange(year.startDate, year.endDate)}
                        </p>
                        <ProgressBar value={progress} className="mt-2" />
                        <p className="mt-2 text-xs text-slate-600">
                          연구개발비 <span className="tabular-nums">{formatWon(year.budget)}</span>
                        </p>

                        <div className="mt-2 flex flex-wrap items-center gap-2">
                          <Badge tone={YEAR_STATUS_TONES[year.status]}>
                            {YEAR_STATUS_LABELS[year.status]}
                          </Badge>
                          <label className="text-xs text-slate-500">
                            <span className="sr-only">{yearLabel(year)} 상태</span>
                            <select
                              value={year.status}
                              disabled={busy}
                              onChange={(e) =>
                                void handleYearStatus(year.id, e.target.value as YearStatus)
                              }
                              className="rounded-lg border border-slate-300 bg-white px-2 py-1 text-xs focus:border-slate-500 focus:outline-none"
                            >
                              {(Object.keys(YEAR_STATUS_LABELS) as YearStatus[]).map((status) => (
                                <option key={status} value={status}>
                                  {YEAR_STATUS_LABELS[status]}
                                </option>
                              ))}
                            </select>
                          </label>

                          <div className="ml-auto flex gap-1">
                            <Button
                              size="sm"
                              variant="ghost"
                              disabled={busy}
                              onClick={() => setDialog({ kind: 'year-edit', yearId: year.id })}
                            >
                              편집
                            </Button>
                            <Button
                              size="sm"
                              variant="ghost"
                              disabled={busy}
                              onClick={() => setDialog({ kind: 'year-delete', yearId: year.id })}
                            >
                              삭제
                            </Button>
                          </div>
                        </div>
                      </li>
                    ))}
                  </ul>
                )}
              </li>
            );
          })}
        </ul>
      )}

      {dialog?.kind === 'stage-create' && (
        <EntityFormModal
          title="새 단계"
          description="단계는 과제의 큰 구획입니다. 연차는 단계 아래에 만듭니다."
          namePlaceholder={`${stages.length + 1}단계`}
          submitLabel="단계 만들기"
          onSubmit={(payload) => createStage(projectId, payload)}
          onClose={() => setDialog(null)}
          onSaved={() => {
            setDialog(null);
            router.refresh();
          }}
        />
      )}

      {dialog?.kind === 'stage-edit' && editingStage && (
        <EntityFormModal
          title="단계 편집"
          namePlaceholder={`${editingStage.order + 1}단계`}
          entity={editingStage}
          submitLabel="저장"
          onSubmit={(payload, expectedVersion) =>
            updateStage(editingStage.id, payload, expectedVersion)
          }
          onClose={() => setDialog(null)}
          onSaved={() => {
            setDialog(null);
            router.refresh();
          }}
        />
      )}

      {dialog?.kind === 'year-create' && (
        <EntityFormModal
          title="새 연차"
          description="연차를 만들면 비목 12종이 함께 생성됩니다. 순서는 이 단계의 마지막 연차 뒤로 들어갑니다."
          namePlaceholder={`${years.length + 1}차년도`}
          submitLabel="연차 만들기"
          onSubmit={(payload) => createYear(dialog.stageId, payload)}
          onClose={() => setDialog(null)}
          onSaved={() => {
            setDialog(null);
            router.refresh();
          }}
        />
      )}

      {dialog?.kind === 'year-edit' && editingYear && (
        // 상태(status)는 카드의 드롭다운이 단일 조작으로 바꾼다 (O-2) — 폼에는 두지 않는다
        <EntityFormModal
          title="연차 편집"
          namePlaceholder={`${editingYear.order + 1}차년도`}
          entity={editingYear}
          submitLabel="저장"
          onSubmit={(payload, expectedVersion) =>
            updateYear(editingYear.id, payload, expectedVersion)
          }
          onClose={() => setDialog(null)}
          onSaved={() => {
            setDialog(null);
            router.refresh();
          }}
        />
      )}

      {dialog?.kind === 'year-delete' && editingYear && (
        <Modal
          open
          title="연차 삭제"
          onClose={() => setDialog(null)}
          closeOnBackdrop={false}
          footer={
            <>
              <Button size="sm" onClick={() => setDialog(null)} disabled={busy}>
                취소
              </Button>
              <Button
                size="sm"
                variant="danger"
                disabled={busy}
                onClick={async () => {
                  const ok = await run(() => deleteYear(editingYear.id));
                  if (ok) setDialog(null);
                }}
              >
                삭제
              </Button>
            </>
          }
        >
          <p className="text-sm text-slate-700">
            <strong>{yearLabel(editingYear)}</strong>를 삭제합니다.
          </p>
          {/* H-5 필수 안내 문구 */}
          <p className="mt-3 rounded-lg bg-red-50 p-3 text-xs text-red-700">
            소속 작업·예산이 함께 삭제됩니다. 관련 마일스톤·실적은 연차 없음 상태로 남습니다.
          </p>
        </Modal>
      )}

      {dialog?.kind === 'stage-delete' && editingStage && (
        <Modal
          open
          title="단계 삭제"
          onClose={() => setDialog(null)}
          closeOnBackdrop={false}
          footer={
            <>
              <Button size="sm" onClick={() => setDialog(null)} disabled={busy}>
                취소
              </Button>
              <Button
                size="sm"
                variant="danger"
                disabled={busy || !canDeleteStage}
                title={canDeleteStage ? undefined : '마지막 단계는 삭제할 수 없습니다 (H-6)'}
                onClick={async () => {
                  const ok = await run(() => deleteStage(editingStage.id));
                  if (ok) setDialog(null);
                }}
              >
                삭제
              </Button>
            </>
          }
        >
          <p className="text-sm text-slate-700">
            <strong>{stageLabel(editingStage)}</strong>를 삭제합니다. 소속 연차{' '}
            <strong>{(yearsByStage.get(editingStage.id) ?? []).length}개</strong>가 함께 삭제됩니다.
          </p>
          {/* H-6 → H-5 연쇄. 연차 삭제와 같은 결과가 연차 수만큼 일어난다 */}
          <p className="mt-3 rounded-lg bg-red-50 p-3 text-xs text-red-700">
            각 연차의 작업·예산이 함께 삭제됩니다. 관련 마일스톤·실적은 연차 없음 상태로 남습니다.
          </p>
          {!canDeleteStage && (
            <p className="mt-3 rounded-lg bg-slate-50 p-3 text-xs text-slate-600">
              과제에는 단계가 최소 1개 필요합니다. 마지막 단계는 삭제할 수 없습니다 (H-6).
            </p>
          )}
        </Modal>
      )}
    </section>
  );
}

// ─── 순서 계산 헬퍼 ───────────────────────────────────────────────────────────

/** 낙관적 순서를 서버 목록에 입힌다. 낙관적 순서에 없는 항목(그새 추가됨)은 뒤에 남긴다. */
function applyLocalOrder<T>(items: T[], order: string[] | null, idOf: (item: T) => string): T[] {
  if (!order) return items;
  const byId = new Map(items.map((item) => [idOf(item), item]));
  const sorted = order.map((id) => byId.get(id)).filter((item): item is T => item !== undefined);
  const seen = new Set(order);
  return [...sorted, ...items.filter((item) => !seen.has(idOf(item)))];
}

/** 아래로 끌면 대상 뒤, 위로 끌면 대상 앞에 놓는다. 대상이 없으면 null */
function moveWithin(ids: string[], sourceId: string, targetId: string): string[] | null {
  const without = ids.filter((id) => id !== sourceId);
  const targetIndex = without.indexOf(targetId);
  if (targetIndex < 0) return null;
  const insertAt = ids.indexOf(sourceId) < ids.indexOf(targetId) ? targetIndex + 1 : targetIndex;
  return [...without.slice(0, insertAt), sourceId, ...without.slice(insertAt)];
}
