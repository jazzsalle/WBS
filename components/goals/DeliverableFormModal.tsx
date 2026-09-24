'use client';

// 성과목표(지표) 생성·편집 모달 (SOT §7.7 탭 1, §5.8, §9 createDeliverable/updateDeliverable, §8.4 O-1·O-3, §8.5 R-4)
// 연차별 목표(targetByYear)는 이 폼에 없다 — §7.7대로 매트릭스 셀에서 직접 편집한다(setDeliverableYearTargets).
// 총목표와 연차 합계가 어긋나도 저장은 막지 않는다(D-3). 경고는 서버가 계산해 행에 띄운다.

import { useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import type { Deliverable, DeliverableType, Organization } from '@/types';
import type { ActionErrorCode } from '@/lib/db/errors';
import { DELIVERABLE_TYPE_DEFAULT_UNITS, DELIVERABLE_TYPE_LABELS } from '@/lib/constants';
import { createDeliverable, updateDeliverable } from '@/actions/goals';
import Modal from '@/components/ui/Modal';
import Button from '@/components/ui/Button';
import ErrorBanner from '@/components/ui/ErrorBanner';
import ConflictDialog from '@/components/ui/ConflictDialog';
import { setRealtimePaused } from '@/components/RealtimeRefresher';

interface FormValues {
  type: DeliverableType;
  name: string;
  unit: string;
  targetTotal: string; // 입력 중 빈 문자열을 표현해야 해서 문자열로 들고 있는다
  orgId: string; // '' = 책임기관 미지정 (§5.8 orgId는 nullable)
  note: string;
}

type FieldKey = keyof FormValues;

// 폼과 O-3 비교 패널이 같은 정의를 쓴다 — 한쪽에만 있는 필드가 조용히 덮어써지지 않게
const FIELDS: readonly { key: FieldKey; label: string }[] = [
  { key: 'type', label: '유형' },
  { key: 'name', label: '지표명' },
  { key: 'unit', label: '단위' },
  { key: 'targetTotal', label: '목표(총)' },
  { key: 'orgId', label: '책임기관' },
  { key: 'note', label: '비고' },
] as const;

const DEFAULT_TYPE: DeliverableType = 'paper_sci';

const EMPTY_VALUES: FormValues = {
  type: DEFAULT_TYPE,
  name: '',
  unit: DELIVERABLE_TYPE_DEFAULT_UNITS[DEFAULT_TYPE],
  targetTotal: '0',
  orgId: '',
  note: '',
};

function toValues(deliverable: Deliverable): FormValues {
  return {
    type: deliverable.type,
    name: deliverable.name,
    unit: deliverable.unit,
    targetTotal: String(deliverable.targetTotal),
    orgId: deliverable.orgId ?? '',
    note: deliverable.note,
  };
}

export interface DeliverableFormModalProps {
  mode: 'create' | 'edit';
  projectId: string;
  /** edit 모드 필수. 부모가 서버 데이터를 그대로 내려준다(다시 불러오기 후 최신값이 여기로 온다) */
  deliverable?: Deliverable;
  organizations: Organization[];
  onClose: () => void;
  /** 저장 성공 시 — 부모가 목록을 새로고침한다 */
  onSaved: () => void;
}

export default function DeliverableFormModal({
  mode,
  projectId,
  deliverable,
  organizations,
  onClose,
  onSaved,
}: DeliverableFormModalProps) {
  const router = useRouter();
  const [values, setValues] = useState<FormValues>(() =>
    deliverable ? toValues(deliverable) : EMPTY_VALUES
  );
  const [saving, setSaving] = useState(false);
  const [failure, setFailure] = useState<{ message: string; code?: ActionErrorCode } | null>(null);
  const [conflict, setConflict] = useState<string | null>(null);
  // O-3 비교 기준: 마지막으로 받아들인 서버 값. 저장에 쓰는 version도 여기서만 나온다.
  const [baseline, setBaseline] = useState<Deliverable | null>(deliverable ?? null);
  const [reloaded, setReloaded] = useState(false);

  // R-4: 폼이 열려 있는 동안 자동 새로고침을 보류해 입력 중인 내용을 지킨다
  useEffect(() => {
    setRealtimePaused(true);
    return () => setRealtimePaused(false);
  }, []);

  // 다시 불러오기(또는 남의 저장) 후 부모가 최신 값을 내려주면 비교 기준만 갱신한다.
  // 입력값(values)은 건드리지 않는다 — 작업 내용을 날리지 않는 것이 O-3의 핵심이다.
  const baselineVersion = baseline?.version;
  useEffect(() => {
    if (!deliverable || deliverable.version === baselineVersion) return;
    setBaseline(deliverable);
    setConflict(null);
    setReloaded(true);
  }, [deliverable, baselineVersion]);

  const nameInputRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    nameInputRef.current?.focus();
  }, []);

  // id는 사용자에게 아무 의미가 없다. 목록에 없는 기관도 값을 숨기지 않고 사실을 드러낸다.
  const orgLabel = (orgId: string): string => {
    if (orgId === '') return '미지정';
    return organizations.find((org) => org.id === orgId)?.name ?? '(삭제된 기관)';
  };

  const displayValue = (key: FieldKey, source: FormValues): string => {
    if (key === 'type') return DELIVERABLE_TYPE_LABELS[source.type];
    if (key === 'orgId') return orgLabel(source.orgId);
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

  // 유형을 바꾸면 단위도 그 유형의 기본값을 따라간다 — 단, 사용자가 직접 적어 넣은 단위는 지키지 않으면
  // '인력양성(명)'을 고른 뒤에도 '건'이 남아 표가 거짓말을 한다. 기본 단위 그대로일 때만 바꾼다.
  const handleTypeChange = (nextType: DeliverableType): void => {
    setValues((prev) => {
      const wasDefaultUnit =
        prev.unit === '' || prev.unit === DELIVERABLE_TYPE_DEFAULT_UNITS[prev.type];
      return {
        ...prev,
        type: nextType,
        unit: wasDefaultUnit ? DELIVERABLE_TYPE_DEFAULT_UNITS[nextType] : prev.unit,
      };
    });
  };

  const handleSubmit = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault();
    setFailure(null);

    if (values.name.trim() === '') {
      setFailure({ message: '지표명을 입력하세요.', code: 'VALIDATION' });
      return;
    }

    // §5.8 성과목표는 "건수"다 — 소수·음수는 서버도 거부한다. 여기서 먼저 안내한다.
    const targetTotal = Number(values.targetTotal);
    if (
      values.targetTotal.trim() === '' ||
      !Number.isInteger(targetTotal) ||
      targetTotal < 0
    ) {
      setFailure({ message: '목표(총)는 0 이상 정수로 입력하세요.', code: 'VALIDATION' });
      return;
    }

    const payload = {
      type: values.type,
      name: values.name.trim(),
      unit: values.unit.trim(),
      targetTotal,
      orgId: values.orgId === '' ? null : values.orgId,
      note: values.note,
    };

    if (mode === 'edit' && (!deliverable || !baseline)) {
      setFailure({ message: '편집할 성과목표를 찾을 수 없습니다. 목록을 새로고침하세요.' });
      return;
    }

    setSaving(true);
    try {
      const res =
        mode === 'edit' && deliverable && baseline
          ? // O-1: 여러 필드를 한 번에 바꾸므로 마지막으로 읽은 version을 조건으로 건다
            await updateDeliverable(deliverable.id, payload, baseline.version)
          : await createDeliverable(projectId, payload);
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
  const inputClass =
    'mt-1 w-full rounded-lg border border-grey-300 px-3 py-2 text-sm focus:border-grey-500 focus:outline-none';

  return (
    <>
      <Modal
        open
        title={isEdit ? '성과목표 편집' : '성과목표 추가'}
        description="연차별 목표는 저장 후 표의 연차 셀에서 직접 입력합니다."
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
            <div className="mb-4 rounded-xl border border-orange-200 bg-orange-50 p-3 text-sm text-orange-800">
              <p className="font-semibold">최신 내용을 다시 불러왔습니다.</p>
              {differences.length === 0 ? (
                <p className="mt-1 text-xs">
                  내 입력과 다른 항목이 없습니다. 그대로 저장하면 됩니다.
                </p>
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
                        <span className="font-semibold text-grey-700">{field.label}</span>
                        <span className="text-grey-500">
                          내 입력: {displayValue(field.key, values)}
                        </span>
                        <span className="text-grey-500">
                          최신: {displayValue(field.key, latest)}
                        </span>
                        <button
                          type="button"
                          onClick={() => setField(field.key, latest[field.key])}
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
            <label className="sm:col-span-2">
              <span className="text-sm font-medium text-grey-700">
                지표명 <span className="text-red-600">*</span>
              </span>
              <input
                ref={nameInputRef}
                type="text"
                value={values.name}
                onChange={(e) => setField('name', e.target.value)}
                maxLength={200}
                required
                placeholder="예: SCI급 논문 게재"
                className={inputClass}
              />
            </label>

            <label>
              <span className="text-sm font-medium text-grey-700">유형</span>
              <select
                value={values.type}
                onChange={(e) => handleTypeChange(e.target.value as DeliverableType)}
                className={`${inputClass} bg-white`}
              >
                {(Object.keys(DELIVERABLE_TYPE_LABELS) as DeliverableType[]).map((type) => (
                  <option key={type} value={type}>
                    {DELIVERABLE_TYPE_LABELS[type]}
                  </option>
                ))}
              </select>
            </label>

            <label>
              <span className="text-sm font-medium text-grey-700">단위</span>
              <input
                type="text"
                value={values.unit}
                onChange={(e) => setField('unit', e.target.value)}
                maxLength={20}
                className={inputClass}
              />
            </label>

            <label>
              <span className="text-sm font-medium text-grey-700">목표(총)</span>
              <input
                type="number"
                inputMode="numeric"
                min={0}
                step={1}
                value={values.targetTotal}
                onChange={(e) => setField('targetTotal', e.target.value)}
                className={inputClass}
              />
              <span className="mt-1 block text-xs text-grey-500">
                0이면 달성률은 N/A로 표시됩니다.
              </span>
            </label>

            <label>
              <span className="text-sm font-medium text-grey-700">책임기관</span>
              <select
                value={values.orgId}
                onChange={(e) => setField('orgId', e.target.value)}
                className={`${inputClass} bg-white`}
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
              <span className="text-sm font-medium text-grey-700">비고</span>
              <textarea
                value={values.note}
                onChange={(e) => setField('note', e.target.value)}
                rows={3}
                maxLength={10000}
                className={inputClass}
              />
            </label>
          </div>

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
          // 서버 데이터를 다시 가져오면 부모가 최신 값을 내려주고, 위 effect가 비교 패널을 연다
          onReload={() => router.refresh()}
          onKeepEditing={() => setConflict(null)}
        />
      )}
    </>
  );
}
