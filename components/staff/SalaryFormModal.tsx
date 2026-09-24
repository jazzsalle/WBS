'use client';

// 급여 이력 추가·편집 모달 (SOT §7.18 상세 패널, §5.20 SL-1·SL-3, §9 addStaffSalary/updateStaffSalary, §8.4 O-1·O-3)
//
//  - 환산 미리보기(연봉 ↔ 월급)는 lib/salary.ts만 부른다. 산식이 두 곳에 생기면 반드시 어긋난다(PL-10a).
//  - 편집 저장은 마지막으로 읽은 version을 건다(O-1). STALE이면 ConflictDialog → [다시 불러오기]는
//    부모(StaffDetailPanel)가 상세를 다시 받아 최신 `salary`를 내려주고, 여기서는 입력값을 그대로 둔 채
//    다른 항목만 비교한다(O-3). 부모가 router.refresh()로는 client 상태에 닿지 못하므로 onReload를 받는다.
//  - 같은 적용일 중복(CONFLICT)은 이 모달 안의 배너로 보인다 — 사용자가 적용일을 고쳐 다시 저장한다.
//  - 이 모달은 Member(과제 인건비)를 건드리지 않는다(SL-5).

import { useEffect, useMemo, useRef, useState } from 'react';
import type { SalaryBasis, StaffSalary } from '@/types';
import type { ActionErrorCode } from '@/lib/db/errors';
import { SALARY_BASIS_LABELS } from '@/lib/constants';
import { formatAmount } from '@/lib/currency';
import { monthlyDisplay, toAnnualSalary } from '@/lib/salary';
import { addStaffSalary, updateStaffSalary } from '@/actions/staff';
import Modal from '@/components/ui/Modal';
import Button from '@/components/ui/Button';
import ErrorBanner from '@/components/ui/ErrorBanner';
import ConflictDialog from '@/components/ui/ConflictDialog';
import { setRealtimePaused } from '@/components/RealtimeRefresher';

interface FormValues {
  effectiveFrom: string;
  basis: SalaryBasis;
  amount: string; // 숫자만 남긴 문자열. '' = 미입력 — 0원과 구분한다
  includesRetirement: boolean;
  includesInsurance: boolean;
  note: string;
}

type FieldKey = keyof FormValues;

// 폼과 O-3 비교 패널이 같은 정의를 쓴다 — 한쪽에만 있는 필드가 조용히 덮어써지지 않게
const FIELDS: readonly { key: FieldKey; label: string }[] = [
  { key: 'effectiveFrom', label: '적용일' },
  { key: 'basis', label: '단위' },
  { key: 'amount', label: '금액' },
  { key: 'includesRetirement', label: '퇴직금 포함' },
  { key: 'includesInsurance', label: '4대보험 포함' },
  { key: 'note', label: '메모' },
] as const;

// 원 단위 정수 15자리(999조)까지. Number.MAX_SAFE_INTEGER 안쪽이라 정수 정밀도가 보장된다
const MAX_AMOUNT_DIGITS = 15;

const EMPTY_VALUES: FormValues = {
  effectiveFrom: '',
  basis: 'annual',
  amount: '',
  includesRetirement: false,
  includesInsurance: false,
  note: '',
};

function toValues(salary: StaffSalary): FormValues {
  return {
    effectiveFrom: salary.effectiveFrom,
    basis: salary.basis,
    amount: String(salary.amount),
    includesRetirement: salary.includesRetirement,
    includesInsurance: salary.includesInsurance,
    note: salary.note,
  };
}

// 쉼표 입력을 허용한다 — 숫자가 아닌 문자는 버리고 정수 문자열만 상태에 남긴다 (MemberFormModal과 같은 관례)
function toDigits(raw: string): string {
  return raw.replace(/[^0-9]/g, '').replace(/^0+(?=\d)/, '');
}

function formatDigits(digits: string): string {
  return digits === '' ? '' : Number(digits).toLocaleString('ko-KR');
}

export interface SalaryFormModalProps {
  mode: 'create' | 'edit';
  staffId: string;
  /** edit 모드 필수. 부모가 서버 데이터를 그대로 내려준다(다시 불러오기 후 최신값이 여기로 온다) */
  salary?: StaffSalary;
  onClose: () => void;
  /** 저장 성공 시 — 부모가 상세를 다시 받고 모달을 닫는다 */
  onSaved: () => void;
  /** O-3 [다시 불러오기] — 부모가 상세를 다시 받아 최신 `salary`를 내려준다 */
  onReload: () => void;
}

export default function SalaryFormModal({
  mode,
  staffId,
  salary,
  onClose,
  onSaved,
  onReload,
}: SalaryFormModalProps) {
  const [values, setValues] = useState<FormValues>(() => (salary ? toValues(salary) : EMPTY_VALUES));
  const [saving, setSaving] = useState(false);
  const [failure, setFailure] = useState<{ message: string; code?: ActionErrorCode } | null>(null);
  const [conflict, setConflict] = useState<string | null>(null);
  // O-3 비교 기준: 마지막으로 받아들인 서버 값. 저장에 쓰는 version도 여기서만 나온다.
  const [baseline, setBaseline] = useState<StaffSalary | null>(salary ?? null);
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
    if (!salary || salary.version === baselineVersion) return;
    setBaseline(salary);
    setConflict(null);
    setReloaded(true);
  }, [salary, baselineVersion]);

  const dateInputRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    dateInputRef.current?.focus();
  }, []);

  const isEdit = mode === 'edit';
  // 편집 중 다른 사람이 이 이력을 지웠다 — 부모가 최신 목록에서 못 찾아 undefined를 내려준다.
  // 저장하면 존재하지 않는 행을 고치는 것이므로 막고 사실을 알린다 (절대 규칙 5)
  const editTargetGone = isEdit && salary === undefined;

  const displayValue = (key: FieldKey, source: FormValues): string => {
    if (key === 'basis') return SALARY_BASIS_LABELS[source.basis];
    if (key === 'amount') return source.amount === '' ? '(비어 있음)' : formatAmount(Number(source.amount), '원');
    if (key === 'includesRetirement' || key === 'includesInsurance') return source[key] ? '포함' : '미포함';
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

  // 입력 중 환산 미리보기. 금액이 비어 있으면 0으로 보여 주지 않는다 — 미리보기도 값을 지어내지 않는다
  const preview = useMemo(() => {
    if (values.amount === '' || values.amount.length > MAX_AMOUNT_DIGITS) return null;
    const annual = toAnnualSalary({ basis: values.basis, amount: Number(values.amount) });
    return { annual, monthly: monthlyDisplay(annual) };
  }, [values.basis, values.amount]);

  const handleSubmit = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault();
    setFailure(null);

    if (!/^\d{4}-\d{2}-\d{2}$/.test(values.effectiveFrom)) {
      setFailure({ message: '적용일을 입력하세요.', code: 'VALIDATION' });
      return;
    }
    if (values.amount === '') {
      setFailure({ message: '금액을 원 단위 정수로 입력하세요.', code: 'VALIDATION' });
      return;
    }
    if (values.amount.length > MAX_AMOUNT_DIGITS) {
      setFailure({ message: '금액이 너무 큽니다. 입력값을 확인하세요.', code: 'VALIDATION' });
      return;
    }
    if (isEdit && (!salary || !baseline)) {
      setFailure({ message: '편집할 급여 이력을 찾을 수 없습니다. 다른 사람이 지웠을 수 있습니다.' });
      return;
    }

    const payload = {
      effectiveFrom: values.effectiveFrom,
      basis: values.basis,
      amount: Number(values.amount),
      includesRetirement: values.includesRetirement,
      includesInsurance: values.includesInsurance,
      note: values.note,
    };

    setSaving(true);
    try {
      const res =
        isEdit && salary && baseline
          ? // O-1: 여러 필드를 한 번에 바꾸므로 마지막으로 읽은 version을 조건으로 건다
            await updateStaffSalary(salary.id, payload, baseline.version)
          : await addStaffSalary(staffId, payload);
      if (!res.ok) {
        // O-3: STALE은 배너가 아니라 선택 다이얼로그로 — 입력을 유지한 채 사용자가 고른다.
        // CONFLICT(같은 적용일)는 배너로 남겨 적용일을 고쳐 다시 저장하게 한다
        if (res.code === 'STALE') setConflict(res.error);
        else setFailure({ message: res.error, code: res.code });
        return;
      }
      onSaved();
    } finally {
      setSaving(false);
    }
  };

  const inputClass =
    'mt-1 w-full rounded-md border border-grey-300 px-3 py-2 text-t6 text-grey-900 focus:border-blue-500 focus:outline-none focus:ring-2 focus:ring-blue-100';

  return (
    <>
      <Modal
        open
        title={isEdit ? '급여 이력 편집' : '급여 이력 추가'}
        description="급여가 바뀌면 새 적용일로 이력을 추가합니다. 과제 인건비는 자동으로 바뀌지 않습니다."
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

          {editTargetGone && (
            <ErrorBanner
              message="이 급여 이력은 더 이상 없습니다. 다른 사람이 지웠을 수 있습니다 — 닫고 목록을 확인하세요."
              className="mb-4"
            />
          )}

          {reloaded && (
            <div className="mb-4 rounded-xl border border-orange-200 bg-orange-50 p-3 text-t6 text-orange-800">
              <p className="font-semibold">최신 내용을 다시 불러왔습니다.</p>
              {differences.length === 0 ? (
                <p className="mt-1 text-t7">내 입력과 다른 항목이 없습니다. 그대로 저장하면 됩니다.</p>
              ) : (
                <>
                  <p className="mt-1 text-t7">
                    아래 항목이 서로 다릅니다. 내 입력은 그대로 두었습니다 — 최신 값을 쓰려면 항목별로
                    선택하세요.
                  </p>
                  <ul className="mt-2 space-y-1.5">
                    {differences.map(({ field, latest }) => (
                      <li
                        key={field.key}
                        className="flex flex-wrap items-center gap-2 rounded-lg bg-surface/70 px-2.5 py-1.5 text-t7"
                      >
                        <span className="font-semibold text-grey-700">{field.label}</span>
                        <span className="text-grey-500">내 입력: {displayValue(field.key, values)}</span>
                        <span className="text-grey-500">최신: {displayValue(field.key, latest)}</span>
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
            <label>
              <span className="text-t7 font-medium text-grey-700">
                적용일 <span className="text-red-500">*</span>
              </span>
              <input
                ref={dateInputRef}
                type="date"
                value={values.effectiveFrom}
                onChange={(e) => setField('effectiveFrom', e.target.value)}
                required
                className={inputClass}
              />
              <span className="mt-1 block text-t7 text-grey-500">이 날부터 적용됩니다. 같은 조직원에 같은 적용일은 둘 수 없습니다.</span>
            </label>

            <fieldset>
              <legend className="text-t7 font-medium text-grey-700">단위</legend>
              <div className="mt-2 flex gap-4">
                {(Object.keys(SALARY_BASIS_LABELS) as SalaryBasis[]).map((basis) => (
                  <label key={basis} className="flex items-center gap-1.5 text-t6 text-grey-800">
                    <input
                      type="radio"
                      name="salary-basis"
                      value={basis}
                      checked={values.basis === basis}
                      onChange={() => setField('basis', basis)}
                      className="accent-blue-500"
                    />
                    {SALARY_BASIS_LABELS[basis]}
                  </label>
                ))}
              </div>
            </fieldset>

            <label className="sm:col-span-2">
              <span className="text-t7 font-medium text-grey-700">
                금액(원) <span className="text-red-500">*</span>
              </span>
              <input
                type="text"
                inputMode="numeric"
                value={formatDigits(values.amount)}
                onChange={(e) => setField('amount', toDigits(e.target.value))}
                placeholder={values.basis === 'monthly' ? '예: 3,000,000' : '예: 36,000,000'}
                className={`${inputClass} text-right tabular-nums`}
              />
              <span className="mt-1 block text-t7 text-grey-500">
                {preview === null
                  ? '원 단위 정수로 입력합니다. 입력한 단위 기준 금액입니다.'
                  : `연봉 환산 ${formatAmount(preview.annual, '원')} · 월급 환산 ${formatAmount(preview.monthly, '원')} (월급은 표시에서만 반올림)`}
              </span>
            </label>

            <label className="flex items-center gap-2 text-t6 text-grey-800">
              <input
                type="checkbox"
                checked={values.includesRetirement}
                onChange={(e) => setField('includesRetirement', e.target.checked)}
                className="accent-blue-500"
              />
              퇴직급여충당금 포함
            </label>

            <label className="flex items-center gap-2 text-t6 text-grey-800">
              <input
                type="checkbox"
                checked={values.includesInsurance}
                onChange={(e) => setField('includesInsurance', e.target.checked)}
                className="accent-blue-500"
              />
              4대보험 회사부담분 포함
            </label>

            <label className="sm:col-span-2">
              <span className="text-t7 font-medium text-grey-700">메모</span>
              <textarea
                value={values.note}
                onChange={(e) => setField('note', e.target.value)}
                rows={2}
                maxLength={10000}
                placeholder="예: 2026 연봉계약, 성과급 제외"
                className={inputClass}
              />
            </label>
          </div>

          <div className="mt-6 flex justify-end gap-2">
            <Button size="md" onClick={onClose} disabled={saving}>
              취소
            </Button>
            <Button type="submit" size="md" variant="primary" disabled={saving || editTargetGone}>
              {saving ? '저장 중…' : isEdit ? '저장' : '추가'}
            </Button>
          </div>
        </form>
      </Modal>

      {conflict && (
        <ConflictDialog
          message={conflict}
          // 부모가 상세를 다시 받아 최신 salary를 내려주면 위 effect가 비교 패널을 연다
          onReload={onReload}
          onKeepEditing={() => setConflict(null)}
        />
      )}
    </>
  );
}
