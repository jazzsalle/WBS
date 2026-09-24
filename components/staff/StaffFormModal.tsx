'use client';

// 조직원 생성·편집 모달 (SOT §7.18, §5.19 ST-1, §9 createStaff/updateStaff, §8.4 O-1·O-3)
// 편집: updateStaff(id, patch, expectedVersion) — 여러 필드를 한 번에 바꾸므로 낙관적 잠금을 건다(O-1).
//       STALE이면 ConflictDialog를 띄우고 입력값은 그대로 둔 채 최신 값과 다른 항목만 비교시킨다(O-3).
// 급여는 이 폼에 없다 — 이력으로 쌓는 것(SL-3)이라 상세 패널의 [이력 추가]가 갖는다.
// 이메일은 필수다(ST-1): 사내 명부·과제 Member와 잇는 키라 Member 폼과 달리 빈 값을 받지 않는다.

import { useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import type { Staff } from '@/types';
import type { ActionErrorCode } from '@/lib/db/errors';
import { createStaff, updateStaff } from '@/actions/staff';
import Modal from '@/components/ui/Modal';
import Button from '@/components/ui/Button';
import ErrorBanner from '@/components/ui/ErrorBanner';
import ConflictDialog from '@/components/ui/ConflictDialog';

interface FormValues {
  name: string;
  email: string;
  position: string;
  employed: boolean;
  note: string;
}

interface FieldDef {
  key: keyof FormValues;
  label: string;
}

// 폼과 O-3 비교 패널이 같은 정의를 쓴다 — 한쪽에만 있는 필드가 조용히 덮어써지지 않게
const FIELDS: readonly FieldDef[] = [
  { key: 'name', label: '이름' },
  { key: 'email', label: '이메일' },
  { key: 'position', label: '직위' },
  { key: 'employed', label: '재직' },
  { key: 'note', label: '메모' },
] as const;

const EMPTY_VALUES: FormValues = {
  name: '',
  email: '',
  position: '',
  employed: true,
  note: '',
};

function toValues(staff: Staff): FormValues {
  return {
    name: staff.name,
    email: staff.email,
    position: staff.position,
    employed: staff.employed,
    note: staff.note,
  };
}

function displayValue(field: FieldDef, source: FormValues): string {
  const raw = source[field.key];
  if (typeof raw === 'boolean') return raw ? '재직' : '퇴사';
  return raw === '' ? '(비어 있음)' : raw;
}

const INPUT_CLASS =
  'mt-1 w-full rounded-md border border-grey-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none focus:ring-2 focus:ring-blue-100';

export interface StaffFormModalProps {
  mode: 'create' | 'edit';
  /** edit 모드 필수. 부모가 서버 데이터를 그대로 내려준다(다시 불러오기 후 최신값이 여기로 온다) */
  staff?: Staff;
  onClose: () => void;
  /** 저장 성공 시 — 부모가 목록을 새로고침한다 */
  onSaved: (saved: Staff) => void;
}

export default function StaffFormModal({ mode, staff, onClose, onSaved }: StaffFormModalProps) {
  const router = useRouter();
  const [values, setValues] = useState<FormValues>(() => (staff ? toValues(staff) : EMPTY_VALUES));
  const [saving, setSaving] = useState(false);
  const [failure, setFailure] = useState<{ message: string; code?: ActionErrorCode } | null>(null);
  const [conflict, setConflict] = useState<string | null>(null);
  // O-3 비교 기준: 마지막으로 받아들인 서버 값. 저장에 쓰는 version도 여기서만 나온다.
  const [baseline, setBaseline] = useState<Staff | null>(staff ?? null);
  const [reloaded, setReloaded] = useState(false);

  // 다시 불러오기(또는 남의 저장) 후 부모가 최신 staff를 내려주면 비교 기준만 갱신한다.
  // 입력값(values)은 건드리지 않는다 — 작업 내용을 날리지 않는 것이 O-3의 핵심이다.
  const baselineVersion = baseline?.version;
  useEffect(() => {
    if (!staff || staff.version === baselineVersion) return;
    setBaseline(staff);
    setConflict(null);
    setReloaded(true);
  }, [staff, baselineVersion]);

  const nameInputRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    nameInputRef.current?.focus();
  }, []);

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

  const buildPayload = () => ({
    name: values.name.trim(),
    email: values.email.trim(),
    position: values.position.trim(),
    employed: values.employed,
    note: values.note,
  });

  const handleSubmit = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault();
    setFailure(null);

    if (values.name.trim() === '') {
      setFailure({ message: '이름을 입력하세요.', code: 'VALIDATION' });
      return;
    }
    if (values.email.trim() === '') {
      setFailure({
        message: '이메일을 입력하세요. 사내 명부·과제 인력과 잇는 키라 비워 둘 수 없습니다.',
        code: 'VALIDATION',
      });
      return;
    }
    if (mode === 'edit' && (!staff || !baseline)) {
      setFailure({ message: '편집할 조직원 정보를 찾을 수 없습니다. 목록을 새로고침하세요.' });
      return;
    }

    setSaving(true);
    try {
      const res =
        mode === 'edit' && staff && baseline
          ? // O-1: 여러 필드를 한 번에 바꾸므로 마지막으로 읽은 version을 조건으로 건다
            await updateStaff(staff.id, buildPayload(), baseline.version)
          : await createStaff(buildPayload());
      if (!res.ok) {
        // O-3: STALE은 배너가 아니라 선택 다이얼로그로 — 입력을 유지한 채 사용자가 고른다
        if (res.code === 'STALE') setConflict(res.error);
        else setFailure({ message: res.error, code: res.code });
        return;
      }
      onSaved(res.data);
    } finally {
      setSaving(false);
    }
  };

  const isEdit = mode === 'edit';

  return (
    <>
      <Modal
        open
        title={isEdit ? '조직원 편집' : '조직원 추가'}
        description={
          isEdit
            ? '조직원 정보를 수정합니다. 급여는 상세 패널의 급여 이력에서 다룹니다.'
            : '이름과 이메일이 필요합니다. 급여는 추가한 뒤 상세 패널에서 이력으로 쌓습니다.'
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
            <div className="mb-4 rounded-xl border border-orange-200 bg-orange-50 p-3 text-sm text-orange-800">
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
                        className="flex flex-wrap items-center gap-2 rounded-lg bg-surface/70 px-2.5 py-1.5 text-xs"
                      >
                        <span className="font-semibold text-grey-700">{field.label}</span>
                        <span className="text-grey-500">내 입력: {displayValue(field, values)}</span>
                        <span className="text-grey-500">최신: {displayValue(field, latest)}</span>
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
              <span className="text-sm font-medium text-grey-700">
                이름 <span className="text-red-500">*</span>
              </span>
              <input
                ref={nameInputRef}
                type="text"
                value={values.name}
                onChange={(e) => setField('name', e.target.value)}
                className={INPUT_CLASS}
              />
            </label>

            <label>
              <span className="text-sm font-medium text-grey-700">
                이메일 <span className="text-red-500">*</span>
              </span>
              <input
                type="email"
                value={values.email}
                onChange={(e) => setField('email', e.target.value)}
                placeholder="name@unes.co.kr"
                className={INPUT_CLASS}
              />
              {/* ST-1: 유일 키. 대소문자·공백은 서버가 정규화한다 */}
              <span className="mt-1 block text-xs text-grey-500">
                조직원마다 하나뿐이어야 합니다. 사내 명부와 과제 인력을 잇는 키로 쓰입니다.
              </span>
            </label>

            <label>
              <span className="text-sm font-medium text-grey-700">직위</span>
              <input
                type="text"
                value={values.position}
                onChange={(e) => setField('position', e.target.value)}
                className={INPUT_CLASS}
              />
            </label>

            <label className="flex items-start gap-2 pt-6">
              <input
                type="checkbox"
                checked={values.employed}
                onChange={(e) => setField('employed', e.target.checked)}
                className="mt-0.5"
              />
              <span>
                <span className="text-sm font-medium text-grey-700">재직 중</span>
                {/* HR-5: 퇴사는 과제 참여 종료(Member.active)와 다르다 — 과제 인력 상태를 건드리지 않는다 */}
                <span className="mt-0.5 block text-xs text-grey-500">
                  끄면 퇴사자로 표시됩니다. 과제 인력의 활성 상태는 바뀌지 않습니다.
                </span>
              </span>
            </label>

            <label className="sm:col-span-2">
              <span className="text-sm font-medium text-grey-700">메모</span>
              <textarea
                value={values.note}
                onChange={(e) => setField('note', e.target.value)}
                rows={3}
                className={INPUT_CLASS}
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
          // 서버 데이터를 다시 가져오면 부모가 최신 staff를 내려주고, 위 effect가 비교 패널을 연다
          onReload={() => router.refresh()}
          onKeepEditing={() => setConflict(null)}
        />
      )}
    </>
  );
}
