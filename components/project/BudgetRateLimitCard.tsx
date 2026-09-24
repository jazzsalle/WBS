'use client';

// 과제 개요 > 지침 한도 2종 (SOT §7.3, §5.3, §6.10.3 PL-14·PL-15·PL-16, §9 setBudgetRateLimits)
// 한도는 부처 고시율 표를 코드에 넣는 대신 과제별로 사용자가 넣는다(PL-16) — 이 카드가 그 입력 자리다.
// 두 필드를 한 번에 저장하므로 낙관적 잠금 대상이다(O-1). STALE이면 ConflictDialog를 띄우고
// 어떤 선택을 하든 입력값은 유지한다(O-3) — SettingsForm과 같은 구조다.
// 빈 값은 null이며 "이 검사를 하지 않는다"는 뜻이다. 0과 다르다(PL-14).

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import type { Project } from '@/types';
import type { ActionErrorCode } from '@/lib/db/errors';
import { setBudgetRateLimits } from '@/actions/budget-plan';
import Button from '@/components/ui/Button';
import ErrorBanner from '@/components/ui/ErrorBanner';
import ConflictDialog from '@/components/ui/ConflictDialog';
import { setRealtimePaused } from '@/components/RealtimeRefresher';

/** 이 카드가 다루는 부분. version은 O-1 잠금 조건이다 */
type RateLimitSource = Pick<Project, 'allowanceRateLimit' | 'indirectRateLimit' | 'version'>;

interface FormValues {
  allowanceRateLimit: string; // '' = 미입력(null) = 검사하지 않음
  indirectRateLimit: string;
}

interface FieldDef {
  key: keyof FormValues;
  label: string;
  /** 이 한도가 무엇을 재는 비율인지 — 기준액이 다르면 같은 %가 다른 뜻이 된다 (PL-12 vs PL-13) */
  hint: string;
  placeholder: string;
}

// 폼과 비교 패널(O-3)이 같은 정의를 쓴다 — 한쪽만 빠지는 일이 없게
const FIELDS: readonly FieldDef[] = [
  {
    key: 'allowanceRateLimit',
    label: '연구수당 한도율(%)',
    hint: '연구수당 ÷ 수정인건비(E1)를 잽니다. 20%는 혁신법 공통이라 새 과제의 기본값입니다 (PL-12).',
    placeholder: '20',
  },
  {
    key: 'indirectRateLimit',
    label: '간접비 한도율(%)',
    // PL-16: 부처·기관 유형별 고시율을 이 도구가 지어내면 그것이 조용히 틀린 예산이 된다
    hint: '간접비 ÷ 직접비 현금 기준액을 잽니다. 부처·기관 유형(영리·비영리·대학)마다 고시율이 달라 기본값을 두지 않습니다 (PL-13·PL-16).',
    placeholder: '부처 지침의 고시율을 입력하세요',
  },
] as const;

function fieldOf(key: keyof FormValues): FieldDef {
  const found = FIELDS.find((f) => f.key === key);
  // 정의가 빠지면 조용히 넘기지 않고 터뜨린다 (절대 규칙 5)
  if (!found) throw new Error(`필드 정의가 없습니다: ${key}`);
  return found;
}

function toValues(source: RateLimitSource): FormValues {
  return {
    allowanceRateLimit: source.allowanceRateLimit === null ? '' : String(source.allowanceRateLimit),
    indirectRateLimit: source.indirectRateLimit === null ? '' : String(source.indirectRateLimit),
  };
}

/** '' → null(미입력), 숫자가 아니면 undefined(오류). null과 0을 구분해야 PL-14의 뜻이 지켜진다 */
function toOptionalNumber(raw: string): number | null | undefined {
  const trimmed = raw.trim();
  if (trimmed === '') return null;
  const parsed = Number(trimmed);
  return Number.isFinite(parsed) ? parsed : undefined;
}

/** 빈 값을 '0%'처럼 보이게 하지 않는다 — 검사 여부 자체가 다르다 */
function displayValue(key: keyof FormValues, values: FormValues): string {
  const raw = values[key].trim();
  return raw === '' ? '(검사하지 않음)' : `${raw}%`;
}

const INPUT_CLASS =
  'mt-1 w-full rounded-lg border border-grey-300 px-3 py-2 text-right text-sm tabular-nums focus:border-grey-500 focus:outline-none';

export interface BudgetRateLimitCardProps {
  projectId: string;
  /** 서버가 내려준 최신 과제. 다시 불러오기·남의 저장 후 새 version이 여기로 온다 */
  project: RateLimitSource;
}

export default function BudgetRateLimitCard({ projectId, project }: BudgetRateLimitCardProps) {
  const router = useRouter();
  const [values, setValues] = useState<FormValues>(() => toValues(project));
  const [saving, setSaving] = useState(false);
  const [failure, setFailure] = useState<{ message: string; code?: ActionErrorCode } | null>(null);
  const [saved, setSaved] = useState(false);
  const [conflict, setConflict] = useState<string | null>(null);
  // O-3 비교 기준: 마지막으로 받아들인 서버 값. 다시 불러오기로 갱신된다.
  const [baseline, setBaseline] = useState<RateLimitSource>(project);
  const [reloaded, setReloaded] = useState(false);

  const baselineValues = useMemo(() => toValues(baseline), [baseline]);
  const dirty = useMemo(
    () => FIELDS.some((f) => values[f.key] !== baselineValues[f.key]),
    [values, baselineValues]
  );

  // R-4: 개요 화면은 projects를 구독한다. 고친 값이 있는 동안만 자동 새로고침을 보류해
  // 입력 중인 내용을 지키고, 그 외에는 남의 변경이 평소처럼 따라오게 둔다 (SettingsForm과 같은 판단).
  useEffect(() => {
    if (!dirty) return;
    setRealtimePaused(true);
    return () => setRealtimePaused(false);
  }, [dirty]);

  // 다시 불러오기(또는 남의 저장) 후 서버가 최신 과제를 내려주면 비교 기준을 갱신한다.
  // 고친 값이 있으면 입력(values)을 건드리지 않는다 — 작업 내용을 날리지 않는 것이 O-3의 핵심이다.
  useEffect(() => {
    if (project.version === baseline.version) return;
    setBaseline(project);
    setConflict(null);
    if (!dirty) {
      setValues(toValues(project));
      setReloaded(false);
      return;
    }
    setReloaded(true);
  }, [project, baseline.version, dirty]);

  const differences = useMemo(() => {
    if (!reloaded) return [];
    return FIELDS.filter((field) => baselineValues[field.key] !== values[field.key]);
  }, [reloaded, baselineValues, values]);

  const setField = (key: keyof FormValues, value: string) => {
    setValues((prev) => ({ ...prev, [key]: value }));
    setSaved(false);
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setFailure(null);
    setSaved(false);

    // 서버도 다시 검증한다(§9 rateLimitsSchema). 여기서 막는 이유는 왕복 없이 즉시 알려주기 위해서다.
    const parsed: Partial<Record<keyof FormValues, number | null>> = {};
    for (const field of FIELDS) {
      const value = toOptionalNumber(values[field.key]);
      if (value === undefined) {
        setFailure({ message: `${field.label}은(는) 숫자로 입력하세요.`, code: 'VALIDATION' });
        return;
      }
      // PL-14: 둘 다 백분율 한도다. 기준액의 100%를 넘는 한도는 한도가 아니다
      if (value !== null && (value < 0 || value > 100)) {
        setFailure({ message: `${field.label}은(는) 0 이상 100 이하여야 합니다.`, code: 'VALIDATION' });
        return;
      }
      parsed[field.key] = value;
    }

    setSaving(true);
    try {
      // O-1: 마지막으로 읽은 version을 조건으로 건다
      const res = await setBudgetRateLimits(
        projectId,
        {
          allowanceRateLimit: parsed.allowanceRateLimit ?? null,
          indirectRateLimit: parsed.indirectRateLimit ?? null,
        },
        baseline.version
      );
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
      router.refresh(); // 저장된 한도가 연구비 화면의 지침 검증에 곧바로 쓰인다
    } finally {
      setSaving(false);
    }
  };

  return (
    <>
      <section className="rounded-2xl border border-grey-200 bg-white p-5">
        <div className="flex items-center justify-between gap-3">
          <h2 className="text-base font-bold text-grey-900">지침 한도</h2>
          <Link
            href={`/projects/${projectId}/budget`}
            className="text-xs font-medium text-blue-600 hover:underline"
          >
            연구비 →
          </Link>
        </div>
        <p className="mt-1 text-xs text-grey-500">
          연구비 제안 화면의 지침 검증에 쓰는 한도율입니다. 과제마다 다르므로 사용자가 직접
          입력합니다 (§6.10.3 PL-14).
        </p>

        <form onSubmit={handleSubmit} className="mt-4">
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
              className="mb-4 rounded-lg border border-green-200 bg-green-50 p-3 text-sm text-green-800"
            >
              지침 한도를 저장했습니다.
            </p>
          )}

          {reloaded && (
            <div className="mb-4 rounded-xl border border-orange-200 bg-orange-50 p-3 text-sm text-orange-800">
              <p className="font-semibold">최신 내용을 다시 불러왔습니다.</p>
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
                        <span className="font-semibold text-grey-700">{field.label}</span>
                        <span className="text-grey-500">
                          내 입력: {displayValue(field.key, values)}
                        </span>
                        <span className="text-grey-500">
                          최신: {displayValue(field.key, baselineValues)}
                        </span>
                        <button
                          type="button"
                          onClick={() => setField(field.key, baselineValues[field.key])}
                          className="ml-auto rounded-md border border-orange-300 px-2 py-0.5 font-semibold text-orange-800"
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
            {FIELDS.map((field) => {
              const empty = values[field.key].trim() === '';
              return (
                <label key={field.key}>
                  <span className="text-sm font-medium text-grey-700">
                    {fieldOf(field.key).label}
                  </span>
                  <input
                    type="number"
                    step="any"
                    min={0}
                    max={100}
                    value={values[field.key]}
                    onChange={(e) => setField(field.key, e.target.value)}
                    placeholder={field.placeholder}
                    className={INPUT_CLASS}
                  />
                  {/* 지금 이 필드가 검사 대상인지 아닌지를 값 옆에서 바로 읽을 수 있게 한다 */}
                  <span
                    className={`mt-1 block text-xs font-medium ${empty ? 'text-grey-400' : 'text-grey-600'}`}
                  >
                    {empty
                      ? '비어 있음 — 이 검사를 하지 않습니다'
                      : `${values[field.key].trim()}%를 넘으면 경고합니다`}
                  </span>
                  <span className="mt-1 block text-xs text-grey-500">{field.hint}</span>
                </label>
              );
            })}
          </div>

          <div className="mt-5 flex flex-wrap items-end justify-between gap-4">
            <div className="max-w-md space-y-1 text-xs text-grey-500">
              {/* §5.3 주석 그대로: 모르는 값을 0으로 취급하면 전 과제에 빨간 경고가 뜬다 */}
              <p>
                빈 값은 <strong>0%가 아니라 &ldquo;검사하지 않음&rdquo;</strong>입니다. 모르는 값을
                0으로 취급해 전 과제에 빨간 경고를 띄우는 것이 더 나쁩니다.
              </p>
              {/* PL-15: 협의 중인 계획이 일시적으로 한도를 넘는 것은 정상이다 */}
              <p>한도를 넘겨도 저장·반영을 막지 않습니다. 경고 배지로만 표시합니다.</p>
            </div>
            <Button type="submit" size="md" variant="primary" disabled={saving || !dirty}>
              {saving ? '저장 중…' : '저장'}
            </Button>
          </div>
        </form>
      </section>

      {conflict && (
        <ConflictDialog
          message={conflict}
          // 서버 데이터를 다시 가져오면 부모가 최신 project를 내려주고, 위 effect가 비교 패널을 연다
          onReload={() => router.refresh()}
          onKeepEditing={() => setConflict(null)}
        />
      )}
    </>
  );
}
