'use client';

// 기관 생성·편집 모달 (SOT §7.10, §5.10, §9 createOrganization/updateOrganization, §8.4 O-1·O-3)
// 편집은 여러 필드를 한 번에 바꾸므로 expectedVersion으로 낙관적 잠금을 건다(O-1).
// STALE이면 ConflictDialog를 띄우고 어떤 선택을 하든 입력값은 유지한다(O-3) —
// "다시 불러오기"는 부모가 내려주는 최신 organization으로 비교 패널을 연다.
// 금액은 원 단위 정수로 다룬다. 표시에만 천 단위 구분을 넣고 단위 환산은 하지 않는다.

import { useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import type { Organization, OrgRole } from '@/types';
import type { ActionErrorCode } from '@/lib/db/errors';
import { ORG_ROLE_LABELS } from '@/lib/constants';
import { createOrganization, updateOrganization } from '@/actions/team';
import Modal from '@/components/ui/Modal';
import Button from '@/components/ui/Button';
import ErrorBanner from '@/components/ui/ErrorBanner';
import ConflictDialog from '@/components/ui/ConflictDialog';
import { setRealtimePaused } from '@/components/RealtimeRefresher';

// H-8: 주관기관의 역할은 재지정([주관으로 지정])으로만 바뀐다. 서버(actions/team)와 같은 문장.
const LEAD_ROLE_LOCKED =
  '주관기관의 역할은 직접 바꿀 수 없습니다. 다른 기관을 주관으로 먼저 지정하세요.';

interface FormValues {
  name: string;
  role: OrgRole;
  type: string;
  representative: string;
  contact: string;
  responsibility: string;
  budget: string; // 원 단위 정수 문자열 ('' = 미입력)
}

type FieldKind = 'text' | 'role' | 'amount';

interface FieldDef {
  key: keyof FormValues;
  label: string;
  kind: FieldKind;
  placeholder?: string;
}

// 비교 패널(O-3)과 폼이 같은 정의를 쓴다 — 한쪽만 빠지는 일이 없게
const FIELDS: readonly FieldDef[] = [
  { key: 'name', label: '기관명', kind: 'text', placeholder: '예: 한국전자기술연구원' },
  { key: 'role', label: '역할', kind: 'role' },
  { key: 'type', label: '유형', kind: 'text', placeholder: '기업 / 대학 / 출연연 / 기타' },
  { key: 'representative', label: '기관 책임자', kind: 'text' },
  { key: 'contact', label: '연락처', kind: 'text', placeholder: '전화번호 또는 이메일' },
  { key: 'responsibility', label: '담당 연구개발 내용', kind: 'text' },
  { key: 'budget', label: '배분 연구개발비(원)', kind: 'amount' },
] as const;

function fieldOf(key: keyof FormValues): FieldDef {
  const found = FIELDS.find((f) => f.key === key);
  if (!found) throw new Error(`필드 정의가 없습니다: ${key}`);
  return found;
}

function toValues(org: Organization): FormValues {
  return {
    name: org.name,
    role: org.role,
    type: org.type,
    representative: org.representative,
    contact: org.contact,
    responsibility: org.responsibility,
    budget: org.budget === null ? '' : String(org.budget),
  };
}

// 금액은 원 단위 정수다. 숫자가 아닌 문자는 버리고 정수 문자열만 상태에 남긴다.
function toDigits(raw: string): string {
  return raw.replace(/[^0-9]/g, '').replace(/^0+(?=\d)/, '');
}

function formatAmount(digits: string): string {
  return digits === '' ? '' : Number(digits).toLocaleString('ko-KR');
}

// 부동소수점 오차 없이 다룰 수 있는 자리수 한계. 초과 입력은 저장 전에 막는다.
const MAX_AMOUNT_DIGITS = 15;

function toAmount(digits: string): number | null {
  return digits === '' ? null : Number(digits);
}

function displayValue(field: FieldDef, values: FormValues): string {
  const raw = values[field.key];
  if (field.kind === 'amount') return raw === '' ? '(미입력)' : `${formatAmount(raw)}원`;
  if (field.kind === 'role') return ORG_ROLE_LABELS[values.role];
  return raw === '' ? '(비어 있음)' : raw;
}

export interface OrganizationFormModalProps {
  mode: 'create' | 'edit';
  projectId: string;
  /** edit 모드 필수. 부모가 서버 데이터를 그대로 내려준다(다시 불러오기 후 최신값이 여기로 온다) */
  organization?: Organization;
  /** 아직 주관기관이 없으면 첫 기관의 기본 역할을 '주관'으로 둔다 (H-8: 과제당 정확히 1곳) */
  hasLeadOrganization: boolean;
  onClose: () => void;
  /** 저장 성공 시 — 부모가 목록을 새로고침한다 */
  onSaved: () => void;
}

export default function OrganizationFormModal({
  mode,
  projectId,
  organization,
  hasLeadOrganization,
  onClose,
  onSaved,
}: OrganizationFormModalProps) {
  const router = useRouter();
  const [values, setValues] = useState<FormValues>(() =>
    organization
      ? toValues(organization)
      : {
          name: '',
          role: hasLeadOrganization ? 'joint' : 'lead',
          type: '',
          representative: '',
          contact: '',
          responsibility: '',
          budget: '',
        }
  );
  const [saving, setSaving] = useState(false);
  const [failure, setFailure] = useState<{ message: string; code?: ActionErrorCode } | null>(null);
  const [conflict, setConflict] = useState<string | null>(null);
  // O-3 비교 기준: 마지막으로 받아들인 서버 값. 다시 불러오기로 갱신된다.
  const [baseline, setBaseline] = useState<Organization | null>(organization ?? null);
  const [reloaded, setReloaded] = useState(false);

  // R-4: 폼이 열려 있는 동안 자동 새로고침을 보류해 입력 중인 내용을 지키지 않게 한다
  useEffect(() => {
    setRealtimePaused(true);
    return () => setRealtimePaused(false);
  }, []);

  // 다시 불러오기(또는 남의 저장) 후 부모가 최신 기관을 내려주면 비교 기준만 갱신한다.
  // 입력값(values)은 건드리지 않는다 — 작업 내용을 날리지 않는 것이 O-3의 핵심이다.
  const baselineVersion = baseline?.version;
  useEffect(() => {
    if (!organization || organization.version === baselineVersion) return;
    setBaseline(organization);
    setConflict(null);
    setReloaded(true);
  }, [organization, baselineVersion]);

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

  const isEdit = mode === 'edit';
  // H-8: 현재 주관기관의 역할을 내리는 저장은 서버가 거부한다. 셀렉트를 먼저 잠가 같은 말을 한다.
  const roleLocked = isEdit && baseline?.role === 'lead';

  const handleSubmit = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault();
    setFailure(null);

    if (values.name.trim() === '') {
      setFailure({ message: '기관명을 입력하세요.', code: 'VALIDATION' });
      return;
    }
    if (values.budget.length > MAX_AMOUNT_DIGITS) {
      setFailure({ message: '금액이 너무 큽니다. 입력값을 확인하세요.', code: 'VALIDATION' });
      return;
    }
    if (isEdit && !organization) {
      setFailure({ message: '편집할 기관 정보를 찾을 수 없습니다. 화면을 새로고침하세요.' });
      return;
    }

    const payload = {
      name: values.name.trim(),
      role: values.role,
      type: values.type.trim(),
      representative: values.representative.trim(),
      contact: values.contact.trim(),
      responsibility: values.responsibility,
      budget: toAmount(values.budget),
    };

    setSaving(true);
    try {
      const res =
        isEdit && organization && baseline
          ? // O-1: 여러 필드를 한 번에 바꾸므로 마지막으로 읽은 version을 조건으로 건다
            await updateOrganization(organization.id, payload, baseline.version)
          : await createOrganization(projectId, payload);
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
      <Modal
        open
        title={isEdit ? '기관 편집' : '새 기관'}
        description={
          isEdit
            ? '기관 정보를 수정합니다.'
            : '컨소시엄 참여 기관을 등록합니다. 주관기관은 과제당 1곳입니다.'
        }
        onClose={onClose}
        closeOnBackdrop={false}
        size="lg"
      >
        <form onSubmit={(e) => void handleSubmit(e)}>
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
            <label className="sm:col-span-2">
              <span className="text-sm font-medium text-grey-700">
                기관명 <span className="text-red-600">*</span>
              </span>
              <input
                ref={nameInputRef}
                type="text"
                value={values.name}
                onChange={(e) => setField('name', e.target.value)}
                maxLength={200}
                required
                placeholder={fieldOf('name').placeholder}
                className="mt-1 w-full rounded-lg border border-grey-300 px-3 py-2 text-sm focus:border-grey-500 focus:outline-none"
              />
            </label>

            <label>
              <span className="text-sm font-medium text-grey-700">역할</span>
              <select
                value={values.role}
                disabled={roleLocked}
                onChange={(e) => setField('role', e.target.value as OrgRole)}
                className="mt-1 w-full rounded-lg border border-grey-300 bg-surface px-3 py-2 text-sm focus:border-grey-500 focus:outline-none disabled:bg-grey-100 disabled:text-grey-500"
              >
                {(Object.keys(ORG_ROLE_LABELS) as OrgRole[]).map((role) => (
                  <option key={role} value={role}>
                    {ORG_ROLE_LABELS[role]}
                  </option>
                ))}
              </select>
              {roleLocked && (
                <span className="mt-1 block text-xs text-grey-500">{LEAD_ROLE_LOCKED}</span>
              )}
              {!roleLocked && values.role === 'lead' && (
                <span className="mt-1 block text-xs text-grey-500">
                  저장하면 기존 주관기관은 공동으로 바뀝니다.
                </span>
              )}
            </label>

            <label>
              <span className="text-sm font-medium text-grey-700">유형</span>
              <input
                type="text"
                value={values.type}
                onChange={(e) => setField('type', e.target.value)}
                maxLength={50}
                placeholder={fieldOf('type').placeholder}
                className="mt-1 w-full rounded-lg border border-grey-300 px-3 py-2 text-sm focus:border-grey-500 focus:outline-none"
              />
            </label>

            <label>
              <span className="text-sm font-medium text-grey-700">기관 책임자</span>
              <input
                type="text"
                value={values.representative}
                onChange={(e) => setField('representative', e.target.value)}
                maxLength={100}
                className="mt-1 w-full rounded-lg border border-grey-300 px-3 py-2 text-sm focus:border-grey-500 focus:outline-none"
              />
            </label>

            <label>
              <span className="text-sm font-medium text-grey-700">연락처</span>
              <input
                type="text"
                value={values.contact}
                onChange={(e) => setField('contact', e.target.value)}
                maxLength={200}
                placeholder={fieldOf('contact').placeholder}
                className="mt-1 w-full rounded-lg border border-grey-300 px-3 py-2 text-sm focus:border-grey-500 focus:outline-none"
              />
            </label>

            <label className="sm:col-span-2">
              <span className="text-sm font-medium text-grey-700">담당 연구개발 내용</span>
              <textarea
                value={values.responsibility}
                onChange={(e) => setField('responsibility', e.target.value)}
                rows={3}
                maxLength={10_000}
                className="mt-1 w-full rounded-lg border border-grey-300 px-3 py-2 text-sm focus:border-grey-500 focus:outline-none"
              />
            </label>

            <label>
              <span className="text-sm font-medium text-grey-700">배분 연구개발비(원)</span>
              <input
                type="text"
                inputMode="numeric"
                value={formatAmount(values.budget)}
                onChange={(e) => setField('budget', toDigits(e.target.value))}
                placeholder="0"
                className="mt-1 w-full rounded-lg border border-grey-300 px-3 py-2 text-right text-sm tabular-nums focus:border-grey-500 focus:outline-none"
              />
            </label>
          </div>

          <div className="mt-6 flex justify-end gap-2">
            <Button size="md" onClick={onClose} disabled={saving}>
              취소
            </Button>
            <Button type="submit" size="md" variant="primary" disabled={saving}>
              {saving ? '저장 중…' : isEdit ? '저장' : '기관 추가'}
            </Button>
          </div>
        </form>
      </Modal>

      {conflict && (
        <ConflictDialog
          message={conflict}
          // 서버 데이터를 다시 가져오면 부모가 최신 기관을 내려주고, 위 effect가 비교 패널을 연다
          onReload={() => router.refresh()}
          onKeepEditing={() => setConflict(null)}
        />
      )}
    </>
  );
}
