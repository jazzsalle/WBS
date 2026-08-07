'use client';

// 설정 > 팀 설정 (SOT §7.14, §5.16, §9 updateSettings, §8.4 O-1·O-3)
// §5.16의 6필드를 한 번에 저장한다 — 다중 필드 저장이라 낙관적 잠금이 필수다(O-1).
// STALE이면 ConflictDialog를 띄우고, 어떤 선택을 하든 입력값은 유지한다(O-3).
// schemaVersion은 편집 대상이 아니다 — 마이그레이션만 갱신할 수 있다(N-10). 읽기로만 보여준다.

import { useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import type { Settings } from '@/types';
import type { SettingsRecord } from '@/lib/db/settings';
import type { ActionErrorCode } from '@/lib/db/errors';
import { updateSettings } from '@/actions/settings';
import Button from '@/components/ui/Button';
import ErrorBanner from '@/components/ui/ErrorBanner';
import ConflictDialog from '@/components/ui/ConflictDialog';
import { setRealtimePaused } from '@/components/RealtimeRefresher';

// 선택지 라벨. 값 자체는 §5.16의 리터럴 그대로다 — 여기서 값을 만들어내지 않는다.
const WEEK_START_LABELS: Record<'0' | '1', string> = { '0': '일요일', '1': '월요일' };
const GANTT_SCALE_LABELS: Record<Settings['defaultGanttScale'], string> = {
  day: '일',
  week: '주',
  month: '월',
};
const CURRENCY_UNITS: readonly Settings['currencyUnit'][] = ['원', '천원', '백만원'];
const WEIGHT_BASIS_LABELS: Record<Settings['progressWeightBasis'], string> = {
  budget: '예산 비례',
  equal: '균등',
};

interface FormValues {
  dueSoonDays: string; // 양의 정수 문자열 — 입력 중 빈 값을 허용하려고 문자열로 다룬다
  milestoneAlertDays: string;
  weekStartsOn: '0' | '1';
  defaultGanttScale: Settings['defaultGanttScale'];
  currencyUnit: Settings['currencyUnit'];
  progressWeightBasis: Settings['progressWeightBasis'];
}

interface FieldDef {
  key: keyof FormValues;
  label: string;
  /** 이 설정이 어느 화면을 바꾸는지 — 저장 영향 범위를 사용자에게 그대로 알린다 */
  hint: string;
}

// 폼과 비교 패널(O-3)이 같은 정의를 쓴다 — 한쪽만 빠지는 일이 없게
const FIELDS: readonly FieldDef[] = [
  {
    key: 'dueSoonDays',
    label: '마감 임박 기준일',
    hint: '대시보드 마감 임박 목록과 작업·마일스톤 마감 판정에 쓰입니다 (§6.5).',
  },
  {
    key: 'milestoneAlertDays',
    label: '마일스톤 알림 기준일',
    hint: '다가오는 마일스톤을 며칠 전부터 알릴지 정합니다 (§6.5).',
  },
  {
    key: 'weekStartsOn',
    label: '주 시작 요일',
    hint: '간트 주 눈금의 시작 요일입니다 (§7.5).',
  },
  {
    key: 'defaultGanttScale',
    label: '간트 기본 스케일',
    hint: '간트 화면을 처음 열 때의 눈금 단위입니다 (§7.5).',
  },
  {
    key: 'currencyUnit',
    label: '표시 통화 단위',
    hint: '연구비 화면의 금액 표시 단위입니다. 저장은 항상 원 단위 정수입니다 (§7.9).',
  },
  {
    key: 'progressWeightBasis',
    label: '진척률 가중 기준',
    hint: '단계·과제 진척률 롤업의 가중 방식입니다 (§6.1 ③④).',
  },
] as const;

function fieldOf(key: keyof FormValues): FieldDef {
  const found = FIELDS.find((f) => f.key === key);
  // 정의가 빠지면 조용히 넘기지 않고 터뜨린다 (절대 규칙 5)
  if (!found) throw new Error(`필드 정의가 없습니다: ${key}`);
  return found;
}

function toValues(settings: Settings): FormValues {
  return {
    dueSoonDays: String(settings.dueSoonDays),
    milestoneAlertDays: String(settings.milestoneAlertDays),
    weekStartsOn: settings.weekStartsOn === 0 ? '0' : '1',
    defaultGanttScale: settings.defaultGanttScale,
    currencyUnit: settings.currencyUnit,
    progressWeightBasis: settings.progressWeightBasis,
  };
}

function displayValue(key: keyof FormValues, values: FormValues): string {
  switch (key) {
    case 'dueSoonDays':
    case 'milestoneAlertDays':
      return values[key] === '' ? '(미입력)' : `${values[key]}일`;
    case 'weekStartsOn':
      return WEEK_START_LABELS[values.weekStartsOn];
    case 'defaultGanttScale':
      return GANTT_SCALE_LABELS[values.defaultGanttScale];
    case 'currencyUnit':
      return values.currencyUnit;
    case 'progressWeightBasis':
      return WEIGHT_BASIS_LABELS[values.progressWeightBasis];
  }
}

// 숫자 입력에서 숫자가 아닌 문자는 버린다 — 소수·음수는 애초에 들어오지 않게 한다
function toDigits(raw: string): string {
  return raw.replace(/[^0-9]/g, '').replace(/^0+(?=\d)/, '');
}

const SELECT_CLASS =
  'mt-1 w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm focus:border-slate-500 focus:outline-none';
const INPUT_CLASS =
  'mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm focus:border-slate-500 focus:outline-none';

export interface SettingsFormProps {
  /** 서버가 내려준 최신 설정. 다시 불러오기·남의 저장 후 새 version이 여기로 온다 */
  settings: SettingsRecord;
}

export default function SettingsForm({ settings }: SettingsFormProps) {
  const router = useRouter();
  const [values, setValues] = useState<FormValues>(() => toValues(settings));
  const [saving, setSaving] = useState(false);
  const [failure, setFailure] = useState<{ message: string; code?: ActionErrorCode } | null>(null);
  const [saved, setSaved] = useState(false);
  const [conflict, setConflict] = useState<string | null>(null);
  // O-3 비교 기준: 마지막으로 받아들인 서버 값. 다시 불러오기로 갱신된다.
  const [baseline, setBaseline] = useState<SettingsRecord>(settings);
  const [reloaded, setReloaded] = useState(false);

  const baselineValues = useMemo(() => toValues(baseline), [baseline]);
  const dirty = useMemo(
    () => FIELDS.some((f) => values[f.key] !== baselineValues[f.key]),
    [values, baselineValues]
  );

  // R-4: 편집 중인 입력을 자동 새로고침이 지우지 않게 보류한다. 모달과 달리 이 폼은 화면에
  // 항상 떠 있으므로 "열려 있는 동안"이 아니라 "고친 값이 있는 동안"만 보류한다 —
  // 그러지 않으면 설정 화면을 열어둔 사람에게 남의 승인·설정 변경이 영영 반영되지 않는다.
  useEffect(() => {
    if (!dirty) return;
    setRealtimePaused(true);
    return () => setRealtimePaused(false);
  }, [dirty]);

  // 다시 불러오기(또는 남의 저장) 후 서버가 최신 설정을 내려주면 비교 기준을 갱신한다.
  // 고친 값이 있으면 입력(values)을 건드리지 않는다 — 작업 내용을 날리지 않는 것이 O-3의 핵심이다.
  // 고친 값이 없으면 지킬 작업이 없으므로 비교 패널 없이 최신 값을 그대로 받아들인다.
  useEffect(() => {
    if (settings.version === baseline.version) return;
    setBaseline(settings);
    setConflict(null);
    if (!dirty) {
      setValues(toValues(settings));
      setReloaded(false);
      return;
    }
    setReloaded(true);
  }, [settings, baseline.version, dirty]);

  // 최신 서버 값과 내 입력이 다른 항목만 (O-3 비교 UI)
  const differences = useMemo(() => {
    if (!reloaded) return [];
    return FIELDS.filter((field) => baselineValues[field.key] !== values[field.key]);
  }, [reloaded, baselineValues, values]);

  const setField = <K extends keyof FormValues>(key: K, value: FormValues[K]) => {
    setValues((prev) => ({ ...prev, [key]: value }));
    setSaved(false);
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setFailure(null);
    setSaved(false);

    const dueSoonDays = Number(values.dueSoonDays);
    const milestoneAlertDays = Number(values.milestoneAlertDays);
    // 서버도 다시 검증한다(§9). 여기서 막는 이유는 왕복 없이 즉시 알려주기 위해서다.
    if (!Number.isInteger(dueSoonDays) || dueSoonDays < 1) {
      setFailure({ message: '마감 임박 기준일은 1 이상의 정수여야 합니다.', code: 'VALIDATION' });
      return;
    }
    if (!Number.isInteger(milestoneAlertDays) || milestoneAlertDays < 1) {
      setFailure({
        message: '마일스톤 알림 기준일은 1 이상의 정수여야 합니다.',
        code: 'VALIDATION',
      });
      return;
    }

    const payload = {
      dueSoonDays,
      milestoneAlertDays,
      weekStartsOn: values.weekStartsOn === '0' ? (0 as const) : (1 as const),
      defaultGanttScale: values.defaultGanttScale,
      currencyUnit: values.currencyUnit,
      progressWeightBasis: values.progressWeightBasis,
    };

    setSaving(true);
    try {
      // O-1: 마지막으로 읽은 version을 조건으로 건다
      const res = await updateSettings(payload, baseline.version);
      if (!res.ok) {
        // O-3: STALE은 배너가 아니라 선택 다이얼로그로 — 입력을 유지한 채 사용자가 고른다
        if (res.code === 'STALE') setConflict(res.error);
        else setFailure({ message: res.error, code: res.code });
        return;
      }
      setBaseline(res.data);
      setValues(toValues(res.data));
      setReloaded(false);
      setSaved(true);
      router.refresh(); // 저장된 설정이 다른 화면 계산에 곧바로 쓰인다
    } finally {
      setSaving(false);
    }
  };

  return (
    <>
      <section className="rounded-2xl border border-slate-200 bg-white p-6">
        <h2 className="text-lg font-bold">팀 설정</h2>
        <p className="mt-1 text-sm text-slate-500">
          팀 전체가 공유하는 업무 규칙입니다. 저장하면 모든 사용자의 계산·표시에 반영됩니다 (SOT
          §5.16).
        </p>

        <form onSubmit={handleSubmit} className="mt-5">
          {failure && (
            <ErrorBanner
              message={failure.message}
              code={failure.code}
              onDismiss={() => setFailure(null)}
              className="mb-4"
            />
          )}

          {saved && !dirty && (
            <p
              role="status"
              className="mb-4 rounded-lg border border-emerald-200 bg-emerald-50 p-3 text-sm text-emerald-800"
            >
              팀 설정을 저장했습니다.
            </p>
          )}

          {reloaded && (
            <div className="mb-4 rounded-xl border border-amber-200 bg-amber-50 p-3 text-sm text-amber-800">
              <p className="font-semibold">최신 설정을 다시 불러왔습니다.</p>
              {differences.length === 0 ? (
                <p className="mt-1 text-xs">내 입력과 다른 항목이 없습니다. 그대로 저장하면 됩니다.</p>
              ) : (
                <>
                  <p className="mt-1 text-xs">
                    아래 항목이 서로 다릅니다. 내 입력은 그대로 두었습니다 — 최신 값을 쓰려면
                    항목별로 선택하세요.
                  </p>
                  <ul className="mt-2 space-y-1.5">
                    {differences.map((field) => (
                      <li
                        key={field.key}
                        className="flex flex-wrap items-center gap-2 rounded-lg bg-white/70 px-2.5 py-1.5 text-xs"
                      >
                        <span className="font-semibold text-slate-700">{field.label}</span>
                        <span className="text-slate-500">
                          내 입력: {displayValue(field.key, values)}
                        </span>
                        <span className="text-slate-500">
                          최신: {displayValue(field.key, baselineValues)}
                        </span>
                        <button
                          type="button"
                          onClick={() => setField(field.key, baselineValues[field.key])}
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

          <div className="grid gap-4 sm:grid-cols-2">
            {(['dueSoonDays', 'milestoneAlertDays'] as const).map((key) => {
              const field = fieldOf(key);
              return (
                <label key={key}>
                  <span className="text-sm font-medium text-slate-700">{field.label}(일)</span>
                  <input
                    type="text"
                    inputMode="numeric"
                    value={values[key]}
                    onChange={(e) => setField(key, toDigits(e.target.value))}
                    required
                    className={`${INPUT_CLASS} text-right tabular-nums`}
                  />
                  <span className="mt-1 block text-xs text-slate-500">{field.hint}</span>
                </label>
              );
            })}

            <label>
              <span className="text-sm font-medium text-slate-700">
                {fieldOf('weekStartsOn').label}
              </span>
              <select
                value={values.weekStartsOn}
                onChange={(e) => setField('weekStartsOn', e.target.value === '0' ? '0' : '1')}
                className={SELECT_CLASS}
              >
                {(['0', '1'] as const).map((v) => (
                  <option key={v} value={v}>
                    {WEEK_START_LABELS[v]}
                  </option>
                ))}
              </select>
              <span className="mt-1 block text-xs text-slate-500">
                {fieldOf('weekStartsOn').hint}
              </span>
            </label>

            <label>
              <span className="text-sm font-medium text-slate-700">
                {fieldOf('defaultGanttScale').label}
              </span>
              <select
                value={values.defaultGanttScale}
                onChange={(e) =>
                  setField('defaultGanttScale', e.target.value as Settings['defaultGanttScale'])
                }
                className={SELECT_CLASS}
              >
                {(Object.keys(GANTT_SCALE_LABELS) as Settings['defaultGanttScale'][]).map(
                  (scale) => (
                    <option key={scale} value={scale}>
                      {GANTT_SCALE_LABELS[scale]}
                    </option>
                  )
                )}
              </select>
              <span className="mt-1 block text-xs text-slate-500">
                {fieldOf('defaultGanttScale').hint}
              </span>
            </label>

            <label>
              <span className="text-sm font-medium text-slate-700">
                {fieldOf('currencyUnit').label}
              </span>
              <select
                value={values.currencyUnit}
                onChange={(e) => setField('currencyUnit', e.target.value as Settings['currencyUnit'])}
                className={SELECT_CLASS}
              >
                {CURRENCY_UNITS.map((unit) => (
                  <option key={unit} value={unit}>
                    {unit}
                  </option>
                ))}
              </select>
              <span className="mt-1 block text-xs text-slate-500">
                {fieldOf('currencyUnit').hint}
              </span>
            </label>

            <label>
              <span className="text-sm font-medium text-slate-700">
                {fieldOf('progressWeightBasis').label}
              </span>
              <select
                value={values.progressWeightBasis}
                onChange={(e) =>
                  setField(
                    'progressWeightBasis',
                    e.target.value as Settings['progressWeightBasis']
                  )
                }
                className={SELECT_CLASS}
              >
                {(Object.keys(WEIGHT_BASIS_LABELS) as Settings['progressWeightBasis'][]).map(
                  (basis) => (
                    <option key={basis} value={basis}>
                      {WEIGHT_BASIS_LABELS[basis]}
                    </option>
                  )
                )}
              </select>
              <span className="mt-1 block text-xs text-slate-500">
                {fieldOf('progressWeightBasis').hint}
              </span>
            </label>
          </div>

          <div className="mt-6 flex items-center justify-between gap-4">
            {/* N-10: 앱에서 바꿀 수 없는 값이라 읽기로만 보여준다 */}
            <p className="text-xs text-slate-400">
              스키마 버전 {settings.schemaVersion} · 마이그레이션만 갱신할 수 있습니다.
            </p>
            <Button type="submit" size="md" variant="primary" disabled={saving || !dirty}>
              {saving ? '저장 중…' : '저장'}
            </Button>
          </div>
        </form>
      </section>

      {conflict && (
        <ConflictDialog
          message={conflict}
          // 서버 데이터를 다시 가져오면 부모가 최신 settings를 내려주고, 위 effect가 비교 패널을 연다
          onReload={() => router.refresh()}
          onKeepEditing={() => setConflict(null)}
        />
      )}
    </>
  );
}
