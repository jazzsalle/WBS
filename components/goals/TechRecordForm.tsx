'use client';

// 측정값 추가·편집 인라인 폼 (SOT §7.7 탭 2 "측정값 추가 인라인 폼 (값, 측정일, 방법, 평가기관, 증빙)", §5.9, §8.5 R-4)
// 최신 측정값이 곧 현재 실적치다(§6.3) — 평소에는 값을 고치는 대신 새 측정을 쌓고,
// 잘못 입력한 이력만 편집 모드로 바로잡는다.
// O-1: 편집은 값·측정일·방법·평가기관·증빙을 한 번에 바꾸므로 낙관적 잠금을 건다.
//      마지막으로 받아들인 서버 값(baseline)의 version을 expectedVersion으로 넘긴다(§5.9, §8.4).
//      STALE이면 ConflictDialog를 띄우고 입력값은 그대로 둔 채 최신 값과 다른 항목만 비교시킨다(O-3).
// 연차(yearId)·비고(note)는 이 폼의 입력 항목이 아니라 patch에 넣지 않는다 — 기존 값이 그대로 남는다.
// 쓰기는 actions/goals.ts를 거친다. supabase를 직접 부르지 않는다(§8.2 C-2).

import { useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import type { MeasureMethod, TechTargetRecord } from '@/types';
import type { ActionErrorCode } from '@/lib/db/errors';
import { MEASURE_METHOD_LABELS } from '@/lib/constants';
import { todayISO } from '@/lib/dates';
import { addTechRecord, updateTechRecord } from '@/actions/goals';
import Button from '@/components/ui/Button';
import ErrorBanner from '@/components/ui/ErrorBanner';
import ConflictDialog from '@/components/ui/ConflictDialog';
import { setRealtimePaused } from '@/components/RealtimeRefresher';

interface FormValues {
  value: string;
  date: string;
  method: MeasureMethod;
  evaluator: string;
  evidenceUrl: string;
}

type FieldKey = keyof FormValues;

// 폼과 O-3 비교 패널이 같은 정의를 쓴다 — 한쪽에만 있는 필드가 조용히 덮어써지지 않게
const FIELDS: readonly { key: FieldKey; label: string }[] = [
  { key: 'value', label: '측정값' },
  { key: 'date', label: '측정일' },
  { key: 'method', label: '측정방법' },
  { key: 'evaluator', label: '평가기관' },
  { key: 'evidenceUrl', label: '증빙' },
] as const;

export interface TechRecordFormProps {
  techTargetId: string;
  mode: 'create' | 'edit';
  /** edit 모드 필수. 부모가 서버 데이터를 그대로 내려준다 */
  record?: TechTargetRecord;
  /** 기술목표의 measureMethod. addTechRecord의 생략 시 기본값과 같은 값이라 T-4 판정 기준이 어긋나지 않는다 */
  defaultMethod: MeasureMethod;
  /** 값 입력 옆에 붙여 단위를 헷갈리지 않게 한다 (§5.9 unit) */
  unit: string;
  disabled?: boolean;
  /** 저장 성공 시 — 부모가 목록을 새로고침한다 */
  onSaved: () => void;
  onCancel: () => void;
}

/**
 * 측정일 기본값(YYYY-MM-DD). 이 폼은 사용자가 [측정값 추가]를 누른 뒤에만 마운트되므로
 * SSR/하이드레이션 차이가 없다.
 *
 * 로컬 달력이 아니라 **Asia/Seoul 달력**으로 찍는다 (§6.5, todayISO). 로컬 기준으로 만들면
 * 다른 타임존 PC에서 같은 순간에 하루 어긋난 측정일이 저장되고, 그 날짜로 연차 귀속과
 * 최신 측정값 판정(§6.3)이 갈린다.
 */
function today(): string {
  return todayISO(new Date());
}

// §5.9 측정치는 소수·음수가 정상이다 — 자릿수를 임의로 자르지 않고 입력창에 그대로 싣는다
function toValues(record: TechTargetRecord): FormValues {
  return {
    value: String(record.value),
    date: record.date,
    method: record.method,
    evaluator: record.evaluator,
    evidenceUrl: record.evidenceUrl,
  };
}

export default function TechRecordForm({
  techTargetId,
  mode,
  record,
  defaultMethod,
  unit,
  disabled = false,
  onSaved,
  onCancel,
}: TechRecordFormProps) {
  const router = useRouter();
  const [values, setValues] = useState<FormValues>(() =>
    record
      ? toValues(record)
      : { value: '', date: today(), method: defaultMethod, evaluator: '', evidenceUrl: '' }
  );
  const [saving, setSaving] = useState(false);
  const [failure, setFailure] = useState<{ message: string; code?: ActionErrorCode } | null>(null);
  const [conflict, setConflict] = useState<string | null>(null);
  // O-3 비교 기준: 마지막으로 받아들인 서버 값. 저장에 쓰는 version도 여기서만 나온다.
  const [baseline, setBaseline] = useState<TechTargetRecord | null>(record ?? null);
  const [reloaded, setReloaded] = useState(false);

  // R-4: 폼이 열려 있는 동안 자동 새로고침을 보류해 입력 중인 내용을 지킨다
  useEffect(() => {
    setRealtimePaused(true);
    return () => setRealtimePaused(false);
  }, []);

  // 다시 불러오기(또는 남의 저장) 후 부모가 최신 이력을 내려주면 비교 기준만 갱신한다.
  // 입력값(values)은 건드리지 않는다(O-3) — 새 version이 다음 저장의 expectedVersion이 된다.
  const baselineVersion = baseline?.version;
  useEffect(() => {
    if (!record || record.version === baselineVersion) return;
    setBaseline(record);
    setConflict(null);
    setReloaded(true);
  }, [record, baselineVersion]);

  const displayValue = (key: FieldKey, source: FormValues): string => {
    if (key === 'method') return MEASURE_METHOD_LABELS[source.method];
    return source[key] === '' ? '(비어 있음)' : source[key];
  };

  // 최신 서버 값과 내 입력이 다른 항목만 (O-3 비교 UI)
  const differences = useMemo(() => {
    if (!reloaded || !baseline) return [];
    const latest = toValues(baseline);
    return FIELDS.filter((field) => latest[field.key] !== values[field.key]).map((field) => ({
      field,
      latest,
    }));
  }, [reloaded, baseline, values]);

  const setField = <K extends FieldKey>(key: K, value: FormValues[K]): void => {
    setValues((prev) => ({ ...prev, [key]: value }));
  };

  const handleSubmit = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault();
    setFailure(null);

    const raw = values.value.trim();
    if (raw === '') {
      setFailure({ message: '측정값을 입력하세요.', code: 'VALIDATION' });
      return;
    }
    const parsedValue = Number(raw);
    if (!Number.isFinite(parsedValue)) {
      setFailure({ message: '측정값은 숫자로 입력하세요.', code: 'VALIDATION' });
      return;
    }
    if (values.date === '') {
      setFailure({ message: '측정일을 입력하세요.', code: 'VALIDATION' });
      return;
    }

    if (mode === 'edit' && (!record || !baseline)) {
      setFailure({ message: '편집할 측정 이력을 찾을 수 없습니다. 목록을 새로고침하세요.' });
      return;
    }

    const payload = {
      value: parsedValue,
      date: values.date,
      method: values.method,
      evaluator: values.evaluator.trim(),
      evidenceUrl: values.evidenceUrl.trim(),
    };

    setSaving(true);
    try {
      const res =
        mode === 'edit' && record && baseline
          ? // O-1: 여러 필드를 한 번에 바꾸므로 마지막으로 읽은 version을 조건으로 건다
            await updateTechRecord(techTargetId, record.id, payload, baseline.version)
          : await addTechRecord(techTargetId, payload);
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

  const busy = saving || disabled;
  // T-4를 저장 전에 알린다 — 공인시험 결과는 평가기관이 있어야 근거가 된다(§6.3)
  const evaluatorHint = values.method === 'certified_lab' && values.evaluator.trim() === '';
  const inputClass =
    'mt-1 w-full rounded-lg border border-slate-300 px-2.5 py-1.5 text-sm focus:border-slate-500 focus:outline-none';

  return (
    <>
      <form
        onSubmit={handleSubmit}
        className="mt-3 rounded-xl border border-slate-200 bg-white p-3"
        aria-label={mode === 'edit' ? '측정 이력 편집' : '측정값 추가'}
      >
        {failure && (
          <ErrorBanner
            message={failure.message}
            code={failure.code}
            onDismiss={() => setFailure(null)}
            className="mb-3"
          />
        )}

        {reloaded && (
          <div className="mb-3 rounded-xl border border-amber-200 bg-amber-50 p-3 text-sm text-amber-800">
            <p className="font-semibold">최신 내용을 다시 불러왔습니다.</p>
            {differences.length === 0 ? (
              <p className="mt-1 text-xs">내 입력과 다른 항목이 없습니다. 그대로 저장하면 됩니다.</p>
            ) : (
              <>
                <p className="mt-1 text-xs">
                  아래 항목이 서로 다릅니다. 내 입력은 그대로 두었습니다 — 최신 값을 쓰려면 항목별로
                  선택하세요.
                </p>
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
              </>
            )}
          </div>
        )}

        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
          <label className="lg:col-span-1">
            <span className="text-xs font-medium text-slate-700">
              측정값 <span className="text-red-600">*</span>
              {unit.trim() !== '' && <span className="ml-1 text-slate-400">({unit})</span>}
            </span>
            <input
              type="number"
              step="any"
              value={values.value}
              onChange={(e) => setField('value', e.target.value)}
              required
              autoFocus
              className={inputClass}
            />
          </label>

          <label>
            <span className="text-xs font-medium text-slate-700">
              측정일 <span className="text-red-600">*</span>
            </span>
            <input
              type="date"
              value={values.date}
              onChange={(e) => setField('date', e.target.value)}
              required
              className={inputClass}
            />
          </label>

          <label>
            <span className="text-xs font-medium text-slate-700">측정방법</span>
            <select
              value={values.method}
              onChange={(e) => setField('method', e.target.value as MeasureMethod)}
              className={`${inputClass} bg-white`}
            >
              {(Object.keys(MEASURE_METHOD_LABELS) as MeasureMethod[]).map((method) => (
                <option key={method} value={method}>
                  {MEASURE_METHOD_LABELS[method]}
                </option>
              ))}
            </select>
          </label>

          <label>
            <span className="text-xs font-medium text-slate-700">평가기관</span>
            <input
              type="text"
              value={values.evaluator}
              onChange={(e) => setField('evaluator', e.target.value)}
              maxLength={200}
              placeholder="예: 한국산업기술시험원"
              className={inputClass}
            />
          </label>

          <label>
            <span className="text-xs font-medium text-slate-700">증빙</span>
            <input
              type="text"
              value={values.evidenceUrl}
              onChange={(e) => setField('evidenceUrl', e.target.value)}
              maxLength={2000}
              placeholder="시험성적서 번호 또는 링크"
              className={inputClass}
            />
          </label>
        </div>

        {evaluatorHint && (
          <p className="mt-2 rounded-lg bg-amber-50 px-2.5 py-1.5 text-xs text-amber-800">
            공인시험으로 저장하면 평가기관이 비어 있어 경고가 표시됩니다. 시험기관명을 함께
            남기세요.
          </p>
        )}

        {mode === 'edit' && (
          <p className="mt-2 text-xs text-slate-500">
            가장 최근 측정값을 고치면 현재 실적치와 달성률이 바뀝니다. 연차·비고는 이 폼에서 바꾸지
            않습니다.
          </p>
        )}

        <div className="mt-3 flex justify-end gap-2">
          <Button size="sm" onClick={onCancel} disabled={saving}>
            취소
          </Button>
          <Button type="submit" size="sm" variant="primary" disabled={busy}>
            {saving ? '저장 중…' : mode === 'edit' ? '저장' : '측정값 추가'}
          </Button>
        </div>
      </form>

      {conflict && (
        <ConflictDialog
          message={conflict}
          // 서버 데이터를 다시 가져오면 부모가 최신 이력을 내려주고, 위 effect가 비교 패널을 연다
          onReload={() => router.refresh()}
          onKeepEditing={() => setConflict(null)}
        />
      )}
    </>
  );
}
