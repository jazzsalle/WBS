'use client';

// 정량적 기술목표(평가항목) 생성·편집 모달
// (SOT §7.7 탭 2, §5.9, §9 createTechTarget/updateTechTarget, §6.3 T-2·T-3, §8.4 O-1·O-3, §8.5 R-4, 부록 A.4)
// 편집: updateTechTarget(id, patch, expectedVersion) — 여러 필드를 한 번에 바꾸므로 낙관적 잠금을 건다(O-1).
//       STALE이면 ConflictDialog를 띄우고 입력값은 그대로 둔 채 최신 값과 다른 항목만 비교시킨다(O-3).
// 연차별 목표치(targetByYear)와 측정 이력은 이 폼이 건드리지 않는다 — 각각 매트릭스 셀과
// 측정값 추가 폼이 담당한다(§7.7).

import { useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import type { Direction, MeasureMethod, Organization, TechTarget } from '@/types';
import type { ActionErrorCode } from '@/lib/db/errors';
import { DIRECTION_LABELS, MEASURE_METHOD_LABELS } from '@/lib/constants';
import { createTechTarget, updateTechTarget } from '@/actions/goals';
import Modal from '@/components/ui/Modal';
import Button from '@/components/ui/Button';
import ErrorBanner from '@/components/ui/ErrorBanner';
import ConflictDialog from '@/components/ui/ConflictDialog';
import { setRealtimePaused } from '@/components/RealtimeRefresher';

interface FormValues {
  name: string;
  unit: string;
  direction: Direction;
  weight: string;
  targetValue: string;
  baselineDomestic: string; // '' = 미입력(null)
  worldBest: string; // '' = 미입력(null)
  worldBestHolder: string;
  measureMethod: MeasureMethod;
  measureDescription: string;
  orgId: string; // '' = 미지정 (§5.9 orgId는 nullable)
}

interface FieldDef {
  key: keyof FormValues;
  label: string;
}

// 폼과 O-3 비교 패널이 같은 정의를 쓴다 — 한쪽에만 있는 필드가 조용히 덮어써지지 않게
const FIELDS: readonly FieldDef[] = [
  { key: 'name', label: '평가항목' },
  { key: 'unit', label: '단위' },
  { key: 'direction', label: '방향성' },
  { key: 'weight', label: '비중(%)' },
  { key: 'targetValue', label: '목표치' },
  { key: 'baselineDomestic', label: '국내수준' },
  { key: 'worldBest', label: '세계최고수준' },
  { key: 'worldBestHolder', label: '보유국/보유기관' },
  { key: 'measureMethod', label: '측정방법' },
  { key: 'measureDescription', label: '측정방법 상세' },
  { key: 'orgId', label: '책임 기관' },
] as const;

const EMPTY_VALUES: FormValues = {
  name: '',
  unit: '',
  direction: 'higher_better', // §5.9 기본값
  weight: '',
  targetValue: '',
  baselineDomestic: '',
  worldBest: '',
  worldBestHolder: '',
  measureMethod: 'self',
  measureDescription: '',
  orgId: '',
};

function toValues(target: TechTarget): FormValues {
  return {
    name: target.name,
    unit: target.unit,
    direction: target.direction,
    weight: String(target.weight),
    targetValue: String(target.targetValue),
    baselineDomestic: target.baselineDomestic === null ? '' : String(target.baselineDomestic),
    worldBest: target.worldBest === null ? '' : String(target.worldBest),
    worldBestHolder: target.worldBestHolder,
    measureMethod: target.measureMethod,
    measureDescription: target.measureDescription,
    orgId: target.orgId ?? '',
  };
}

/** '' → null(미입력), 숫자가 아니면 undefined(오류). 0과 미입력을 구분해야 §6.3 계산이 어긋나지 않는다 */
function toOptionalNumber(raw: string): number | null | undefined {
  const trimmed = raw.trim();
  if (trimmed === '') return null;
  const parsed = Number(trimmed);
  return Number.isFinite(parsed) ? parsed : undefined;
}

export interface TechTargetFormModalProps {
  mode: 'create' | 'edit';
  projectId: string;
  /** edit 모드 필수. 부모가 서버 데이터를 그대로 내려준다(다시 불러오기 후 최신값이 여기로 온다) */
  techTarget?: TechTarget;
  organizations: Organization[];
  onClose: () => void;
  /** 저장 성공 시 — 부모가 목록을 새로고침한다 */
  onSaved: () => void;
}

export default function TechTargetFormModal({
  mode,
  projectId,
  techTarget,
  organizations,
  onClose,
  onSaved,
}: TechTargetFormModalProps) {
  const router = useRouter();
  const [values, setValues] = useState<FormValues>(() =>
    techTarget ? toValues(techTarget) : EMPTY_VALUES
  );
  const [saving, setSaving] = useState(false);
  const [failure, setFailure] = useState<{ message: string; code?: ActionErrorCode } | null>(null);
  const [conflict, setConflict] = useState<string | null>(null);
  // O-3 비교 기준: 마지막으로 받아들인 서버 값. 저장에 쓰는 version도 여기서만 나온다.
  const [baseline, setBaseline] = useState<TechTarget | null>(techTarget ?? null);
  const [reloaded, setReloaded] = useState(false);

  // R-4: 폼이 열려 있는 동안 자동 새로고침을 보류해 입력 중인 내용을 지키지 않게 한다
  useEffect(() => {
    setRealtimePaused(true);
    return () => setRealtimePaused(false);
  }, []);

  // 다시 불러오기(또는 남의 저장) 후 부모가 최신 값을 내려주면 비교 기준만 갱신한다.
  // 입력값(values)은 건드리지 않는다 — 작업 내용을 날리지 않는 것이 O-3의 핵심이다.
  const baselineVersion = baseline?.version;
  useEffect(() => {
    if (!techTarget || techTarget.version === baselineVersion) return;
    setBaseline(techTarget);
    setConflict(null);
    setReloaded(true);
  }, [techTarget, baselineVersion]);

  const nameInputRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    nameInputRef.current?.focus();
  }, []);

  // id는 사용자에게 아무 의미가 없다. 목록에 없는 기관도 값을 숨기지 않고 사실을 드러낸다.
  const orgLabel = (orgId: string): string => {
    if (orgId === '') return '미지정';
    return organizations.find((org) => org.id === orgId)?.name ?? '(삭제된 기관)';
  };

  const displayValue = (field: FieldDef, source: FormValues): string => {
    if (field.key === 'direction') return DIRECTION_LABELS[source.direction];
    if (field.key === 'measureMethod') return MEASURE_METHOD_LABELS[source.measureMethod];
    if (field.key === 'orgId') return orgLabel(source.orgId);
    return source[field.key] === '' ? '(비어 있음)' : source[field.key];
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

  const setField = <K extends keyof FormValues>(key: K, value: FormValues[K]): void => {
    setValues((prev) => ({ ...prev, [key]: value }));
  };

  const handleSubmit = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault();
    setFailure(null);

    if (values.name.trim() === '') {
      setFailure({ message: '평가항목명을 입력하세요.', code: 'VALIDATION' });
      return;
    }

    const targetValue = toOptionalNumber(values.targetValue);
    if (targetValue === undefined) {
      setFailure({ message: '목표치는 숫자로 입력하세요.', code: 'VALIDATION' });
      return;
    }
    if (targetValue === null) {
      setFailure({ message: '목표치를 입력하세요.', code: 'VALIDATION' });
      return;
    }

    // T-3: 비중은 가중 평균의 분모다. 빈 값은 0으로 두되 음수·문자는 막는다
    const weight = toOptionalNumber(values.weight);
    if (weight === undefined) {
      setFailure({ message: '비중은 숫자로 입력하세요.', code: 'VALIDATION' });
      return;
    }
    if (weight !== null && weight < 0) {
      setFailure({ message: '비중은 0 이상이어야 합니다.', code: 'VALIDATION' });
      return;
    }

    const baselineDomestic = toOptionalNumber(values.baselineDomestic);
    if (baselineDomestic === undefined) {
      setFailure({ message: '국내수준은 숫자로 입력하세요.', code: 'VALIDATION' });
      return;
    }

    const worldBest = toOptionalNumber(values.worldBest);
    if (worldBest === undefined) {
      setFailure({ message: '세계최고수준은 숫자로 입력하세요.', code: 'VALIDATION' });
      return;
    }

    const payload = {
      name: values.name.trim(),
      unit: values.unit.trim(),
      direction: values.direction,
      weight: weight ?? 0,
      targetValue,
      baselineDomestic,
      worldBest,
      worldBestHolder: values.worldBestHolder.trim(),
      measureMethod: values.measureMethod,
      measureDescription: values.measureDescription.trim(),
      orgId: values.orgId === '' ? null : values.orgId,
    };

    if (mode === 'edit' && (!techTarget || !baseline)) {
      setFailure({ message: '편집할 기술목표를 찾을 수 없습니다. 목록을 새로고침하세요.' });
      return;
    }

    setSaving(true);
    try {
      const res =
        mode === 'edit' && techTarget && baseline
          ? // O-1: 여러 필드를 한 번에 바꾸므로 마지막으로 읽은 version을 조건으로 건다
            await updateTechTarget(techTarget.id, payload, baseline.version)
          : await createTechTarget(projectId, payload);
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

  const isEdit = mode === 'edit';
  // T-2: 감소 목표는 국내수준(기준) 없이 감소율을 만들 수 없다 — 저장은 되지만 달성률이 N/A가 된다
  const lowerWithoutBaseline =
    values.direction === 'lower_better' && values.baselineDomestic.trim() === '';

  const numberInputClass =
    'mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm focus:border-slate-500 focus:outline-none';

  return (
    <>
      <Modal
        open
        title={isEdit ? '평가항목 편집' : '평가항목 추가'}
        description={
          isEdit
            ? '정량적 기술목표(평가항목)를 수정합니다.'
            : '평가항목명과 목표치만 있으면 등록됩니다. 나머지는 나중에 채워도 됩니다.'
        }
        onClose={onClose}
        closeOnBackdrop={false}
        size="lg"
      >
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
                <p className="mt-1 text-xs">
                  내 입력과 다른 항목이 없습니다. 그대로 저장하면 됩니다.
                </p>
              ) : (
                <>
                  <p className="mt-1 text-xs">
                    아래 항목이 서로 다릅니다. 내 입력은 그대로 두었습니다 — 최신 값을 쓰려면
                    항목별로 선택하세요.
                  </p>
                  <ul className="mt-2 space-y-1.5">
                    {differences.map(({ field, latest }) => (
                      <li
                        key={field.key}
                        className="flex flex-wrap items-center gap-2 rounded-lg bg-white/70 px-2.5 py-1.5 text-xs"
                      >
                        <span className="font-semibold text-slate-700">{field.label}</span>
                        <span className="text-slate-500">내 입력: {displayValue(field, values)}</span>
                        <span className="text-slate-500">최신: {displayValue(field, latest)}</span>
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

          <div className="grid gap-4 sm:grid-cols-2">
            <label className="sm:col-span-2">
              <span className="text-sm font-medium text-slate-700">
                평가항목 <span className="text-red-600">*</span>
              </span>
              <input
                ref={nameInputRef}
                type="text"
                value={values.name}
                onChange={(e) => setField('name', e.target.value)}
                maxLength={200}
                required
                placeholder="예: 객체 인식 정확도"
                className={numberInputClass}
              />
            </label>

            <label>
              <span className="text-sm font-medium text-slate-700">단위</span>
              <input
                type="text"
                value={values.unit}
                onChange={(e) => setField('unit', e.target.value)}
                maxLength={20}
                placeholder="예: %, ms, fps"
                className={numberInputClass}
              />
            </label>

            <label>
              <span className="text-sm font-medium text-slate-700">방향성</span>
              <select
                value={values.direction}
                onChange={(e) => setField('direction', e.target.value as Direction)}
                className="mt-1 w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm focus:border-slate-500 focus:outline-none"
              >
                {(Object.keys(DIRECTION_LABELS) as Direction[]).map((direction) => (
                  <option key={direction} value={direction}>
                    {DIRECTION_LABELS[direction]}
                  </option>
                ))}
              </select>
            </label>

            <label>
              <span className="text-sm font-medium text-slate-700">비중(%)</span>
              <input
                type="number"
                step="any"
                min={0}
                value={values.weight}
                onChange={(e) => setField('weight', e.target.value)}
                placeholder="0"
                className={numberInputClass}
              />
              <span className="mt-1 block text-xs text-slate-500">
                과제 내 합계 100 권장. 100이 아니어도 저장되며 실제 합계로 정규화해 계산합니다.
              </span>
            </label>

            <label>
              <span className="text-sm font-medium text-slate-700">
                목표치 <span className="text-red-600">*</span>
              </span>
              <input
                type="number"
                step="any"
                value={values.targetValue}
                onChange={(e) => setField('targetValue', e.target.value)}
                required
                className={numberInputClass}
              />
            </label>

            <label>
              <span className="text-sm font-medium text-slate-700">국내수준 (연구개발 전)</span>
              <input
                type="number"
                step="any"
                value={values.baselineDomestic}
                onChange={(e) => setField('baselineDomestic', e.target.value)}
                placeholder="미입력"
                className={numberInputClass}
              />
            </label>

            <label>
              <span className="text-sm font-medium text-slate-700">세계최고수준</span>
              <input
                type="number"
                step="any"
                value={values.worldBest}
                onChange={(e) => setField('worldBest', e.target.value)}
                placeholder="미입력"
                className={numberInputClass}
              />
            </label>

            <label>
              <span className="text-sm font-medium text-slate-700">보유국/보유기관</span>
              <input
                type="text"
                value={values.worldBestHolder}
                onChange={(e) => setField('worldBestHolder', e.target.value)}
                maxLength={200}
                placeholder="예: 미국 / OO연구소"
                className={numberInputClass}
              />
            </label>

            <label>
              <span className="text-sm font-medium text-slate-700">측정방법</span>
              <select
                value={values.measureMethod}
                onChange={(e) => setField('measureMethod', e.target.value as MeasureMethod)}
                className="mt-1 w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm focus:border-slate-500 focus:outline-none"
              >
                {(Object.keys(MEASURE_METHOD_LABELS) as MeasureMethod[]).map((method) => (
                  <option key={method} value={method}>
                    {MEASURE_METHOD_LABELS[method]}
                  </option>
                ))}
              </select>
            </label>

            <label>
              <span className="text-sm font-medium text-slate-700">책임 기관</span>
              <select
                value={values.orgId}
                onChange={(e) => setField('orgId', e.target.value)}
                className="mt-1 w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm focus:border-slate-500 focus:outline-none"
              >
                <option value="">미지정</option>
                {organizations.map((org) => (
                  <option key={org.id} value={org.id}>
                    {org.name}
                  </option>
                ))}
                {/* 목록에 없는 기관을 가리키고 있으면 선택값을 조용히 바꾸지 않고 그대로 보인다 */}
                {values.orgId !== '' && !organizations.some((org) => org.id === values.orgId) && (
                  <option value={values.orgId}>(삭제된 기관)</option>
                )}
              </select>
            </label>

            <label className="sm:col-span-2">
              <span className="text-sm font-medium text-slate-700">측정방법 상세</span>
              <textarea
                value={values.measureDescription}
                onChange={(e) => setField('measureDescription', e.target.value)}
                rows={3}
                maxLength={10000}
                placeholder="측정 조건, 시험 규격, 데이터셋 등"
                className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm focus:border-slate-500 focus:outline-none"
              />
            </label>
          </div>

          {lowerWithoutBaseline && (
            <p className="mt-4 rounded-lg bg-amber-50 p-3 text-xs text-amber-800">
              낮을수록 우수한 항목은 국내수준(기준)이 있어야 감소율을 계산할 수 있습니다. 비워 두면
              달성률이 N/A로 표시됩니다.
            </p>
          )}

          <div className="mt-6 flex justify-end gap-2">
            <Button size="md" onClick={onClose} disabled={saving}>
              취소
            </Button>
            <Button type="submit" size="md" variant="primary" disabled={saving}>
              {saving ? '저장 중…' : isEdit ? '저장' : '추가'}
            </Button>
          </div>
        </form>
      </Modal>

      {conflict && (
        <ConflictDialog
          message={conflict}
          // 서버 데이터를 다시 가져오면 부모가 최신 techTarget을 내려주고, 위 effect가 비교 패널을 연다
          onReload={() => router.refresh()}
          onKeepEditing={() => setConflict(null)}
        />
      )}
    </>
  );
}
