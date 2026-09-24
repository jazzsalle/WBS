'use client';

// 참여인력 생성·편집 모달 (SOT §7.10, §5.11, §6.10.2 PL-10b, §9 createMember/updateMember,
// §8.4 O-1·O-3, §8.5 R-4)
// 편집: updateMember(id, patch, expectedVersion) — 여러 필드를 한 번에 바꾸므로 낙관적 잠금을 건다(O-1).
//       STALE이면 ConflictDialog를 띄우고 입력값은 그대로 둔 채 최신 값과 다른 항목만 비교시킨다(O-3).
// 활성 여부는 이 폼에 없다 — 행의 토글(setMemberActive)이 단일 조작으로 처리한다(O-2, H-9).
// 참여율(%)도 이 폼에 없다 — (연차 × 인력)의 속성이라 연구비 화면의 산출근거가 갖는다 (§5.11).
// PL-10b: 연봉을 바꾸면 저장 전에 previewSalaryChange로 영향 건수·전후 금액을 보여주고 확인받는다.
//         영향 0건이면 확인 없이 바로 저장한다.

import { useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import type { HireType, Member, MemberRole, Organization } from '@/types';
import type { ActionErrorCode } from '@/lib/db/errors';
import { BUDGET_CATEGORY_LABELS, HIRE_TYPE_LABELS, MEMBER_ROLE_LABELS } from '@/lib/constants';
import {
  createMember,
  previewSalaryChange,
  updateMember,
  type SalaryChangePreview,
} from '@/actions/team';
import Modal from '@/components/ui/Modal';
import Button from '@/components/ui/Button';
import ErrorBanner from '@/components/ui/ErrorBanner';
import ConflictDialog from '@/components/ui/ConflictDialog';
import { setRealtimePaused } from '@/components/RealtimeRefresher';

interface FormValues {
  name: string;
  role: MemberRole;
  orgId: string; // '' = 소속 없음 (§5.11 orgId는 nullable)
  position: string;
  field: string;
  email: string;
  phone: string;
  annualSalary: string; // 숫자만 남긴 문자열. '' = 미입력(null) — 0원과 구분한다
  hireType: HireType;
}

interface FieldDef {
  key: keyof FormValues;
  label: string;
  /** 표시 변환이 필요한 필드 (O-3 비교 패널이 값을 사람 말로 보여준다) */
  kind?: 'role' | 'org' | 'amount' | 'hireType';
}

// 폼과 O-3 비교 패널이 같은 정의를 쓴다 — 한쪽에만 있는 필드가 조용히 덮어써지지 않게
const FIELDS: readonly FieldDef[] = [
  { key: 'name', label: '이름' },
  { key: 'role', label: '역할', kind: 'role' },
  { key: 'orgId', label: '소속 기관', kind: 'org' },
  { key: 'position', label: '직급' },
  { key: 'field', label: '분야' },
  { key: 'email', label: '이메일' },
  { key: 'phone', label: '연락처' },
  { key: 'annualSalary', label: '연봉', kind: 'amount' },
  { key: 'hireType', label: '채용구분', kind: 'hireType' },
] as const;

const EMPTY_VALUES: FormValues = {
  name: '',
  role: 'researcher',
  orgId: '',
  position: '',
  field: '',
  email: '',
  phone: '',
  annualSalary: '',
  hireType: 'existing',
};

function toValues(member: Member): FormValues {
  return {
    name: member.name,
    role: member.role,
    orgId: member.orgId ?? '',
    position: member.position,
    field: member.field,
    email: member.email,
    phone: member.phone,
    annualSalary: member.annualSalary === null ? '' : String(member.annualSalary),
    hireType: member.hireType,
  };
}

// 금액은 원 단위 정수다. 숫자가 아닌 문자는 버리고 정수 문자열만 상태에 남긴다
// (ProjectFormModal·OrganizationFormModal과 같은 관례).
function toDigits(raw: string): string {
  return raw.replace(/[^0-9]/g, '').replace(/^0+(?=\d)/, '');
}

function formatAmount(digits: string): string {
  return digits === '' ? '' : Number(digits).toLocaleString('ko-KR');
}

function formatWon(amount: number): string {
  return `${amount.toLocaleString('ko-KR')}원`;
}

// 부동소수점 오차 없이 다룰 수 있는 자리수 한계. 초과 입력은 저장 전에 막는다.
const MAX_AMOUNT_DIGITS = 15;

function toAmount(digits: string): number | null {
  return digits === '' ? null : Number(digits);
}

export interface MemberFormModalProps {
  mode: 'create' | 'edit';
  projectId: string;
  /** edit 모드 필수. 부모가 서버 데이터를 그대로 내려준다(다시 불러오기 후 최신값이 여기로 온다) */
  member?: Member;
  organizations: Organization[];
  onClose: () => void;
  /** 저장 성공 시 — 부모가 목록을 새로고침한다 */
  onSaved: () => void;
}

export default function MemberFormModal({
  mode,
  projectId,
  member,
  organizations,
  onClose,
  onSaved,
}: MemberFormModalProps) {
  const router = useRouter();
  const [values, setValues] = useState<FormValues>(() => (member ? toValues(member) : EMPTY_VALUES));
  const [saving, setSaving] = useState(false);
  const [failure, setFailure] = useState<{ message: string; code?: ActionErrorCode } | null>(null);
  const [conflict, setConflict] = useState<string | null>(null);
  // PL-10b 확인 대화상자. null이면 확인 단계가 없다는 뜻이다(영향 0건 포함)
  const [preview, setPreview] = useState<SalaryChangePreview | null>(null);
  // O-3 비교 기준: 마지막으로 받아들인 서버 값. 저장에 쓰는 version도 여기서만 나온다.
  const [baseline, setBaseline] = useState<Member | null>(member ?? null);
  const [reloaded, setReloaded] = useState(false);

  // R-4: 폼이 열려 있는 동안 자동 새로고침을 보류해 입력 중인 내용을 지키지 않게 한다
  useEffect(() => {
    setRealtimePaused(true);
    return () => setRealtimePaused(false);
  }, []);

  // 다시 불러오기(또는 남의 저장) 후 부모가 최신 member를 내려주면 비교 기준만 갱신한다.
  // 입력값(values)은 건드리지 않는다 — 작업 내용을 날리지 않는 것이 O-3의 핵심이다.
  const baselineVersion = baseline?.version;
  useEffect(() => {
    if (!member || member.version === baselineVersion) return;
    setBaseline(member);
    setConflict(null);
    setReloaded(true);
  }, [member, baselineVersion]);

  const nameInputRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    nameInputRef.current?.focus();
  }, []);

  // id는 사용자에게 아무 의미가 없다. 목록에 없는 기관도 값을 숨기지 않고 사실을 드러낸다.
  const orgLabel = (orgId: string): string => {
    if (orgId === '') return '소속 없음';
    return organizations.find((org) => org.id === orgId)?.name ?? '(삭제된 기관)';
  };

  const displayValue = (field: FieldDef, source: FormValues): string => {
    if (field.kind === 'role') return MEMBER_ROLE_LABELS[source.role];
    if (field.kind === 'org') return orgLabel(source.orgId);
    if (field.kind === 'hireType') return HIRE_TYPE_LABELS[source.hireType];
    const raw = source[field.key];
    if (field.kind === 'amount') return raw === '' ? '(미입력)' : `${formatAmount(raw)}원`;
    return raw === '' ? '(비어 있음)' : raw;
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

  const buildPayload = () => ({
    name: values.name.trim(),
    role: values.role,
    orgId: values.orgId === '' ? null : values.orgId,
    position: values.position.trim(),
    field: values.field.trim(),
    email: values.email.trim(),
    phone: values.phone.trim(),
    annualSalary: toAmount(values.annualSalary),
    hireType: values.hireType,
  });

  const save = async (): Promise<void> => {
    setSaving(true);
    try {
      const res =
        mode === 'edit' && member && baseline
          ? // O-1: 여러 필드를 한 번에 바꾸므로 마지막으로 읽은 version을 조건으로 건다
            await updateMember(member.id, buildPayload(), baseline.version)
          : await createMember(projectId, buildPayload());
      if (!res.ok) {
        // 확인 대화상자를 닫아 실패 사유가 폼 위에서 보이게 한다 — 뒤에 가려두지 않는다
        setPreview(null);
        // O-3: STALE은 배너가 아니라 선택 다이얼로그로 — 입력을 유지한 채 사용자가 고른다
        if (res.code === 'STALE') setConflict(res.error);
        else setFailure({ message: res.error, code: res.code });
        return;
      }
      setPreview(null);
      onSaved();
    } finally {
      setSaving(false);
    }
  };

  const handleSubmit = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault();
    setFailure(null);

    if (values.name.trim() === '') {
      setFailure({ message: '이름을 입력하세요.', code: 'VALIDATION' });
      return;
    }
    if (values.annualSalary.length > MAX_AMOUNT_DIGITS) {
      setFailure({ message: '연봉이 너무 큽니다. 입력값을 확인하세요.', code: 'VALIDATION' });
      return;
    }
    if (mode === 'edit' && (!member || !baseline)) {
      setFailure({ message: '편집할 인력 정보를 찾을 수 없습니다. 목록을 새로고침하세요.' });
      return;
    }

    // PL-10b: 연봉이 실제로 바뀌는 편집만 확인을 거친다. 신규 등록은 참조할 산출근거가 없다.
    const nextSalary = toAmount(values.annualSalary);
    if (mode === 'edit' && member && baseline && nextSalary !== baseline.annualSalary) {
      setSaving(true);
      const res = await previewSalaryChange(member.id, nextSalary);
      setSaving(false);
      if (!res.ok) {
        // 무엇이 함께 바뀌는지 모른 채 저장하지 않는다 (절대 규칙 5)
        setFailure({ message: res.error, code: res.code });
        return;
      }
      // §7.10: 영향 건수가 0이면 확인 없이 바로 저장한다
      if (res.data.detailCount > 0) {
        setPreview(res.data);
        return;
      }
    }

    await save();
  };

  const isEdit = mode === 'edit';

  return (
    <>
      <Modal
        open
        title={isEdit ? '인력 편집' : '인력 추가'}
        description={
          isEdit ? '참여인력 정보를 수정합니다.' : '이름만 있으면 등록됩니다. 나머지는 나중에 채워도 됩니다.'
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
                이름 <span className="text-red-600">*</span>
              </span>
              <input
                ref={nameInputRef}
                type="text"
                value={values.name}
                onChange={(e) => setField('name', e.target.value)}
                maxLength={200}
                required
                className="mt-1 w-full rounded-lg border border-grey-300 px-3 py-2 text-sm focus:border-grey-500 focus:outline-none"
              />
            </label>

            <label>
              <span className="text-sm font-medium text-grey-700">역할</span>
              <select
                value={values.role}
                onChange={(e) => setField('role', e.target.value as MemberRole)}
                className="mt-1 w-full rounded-lg border border-grey-300 bg-white px-3 py-2 text-sm focus:border-grey-500 focus:outline-none"
              >
                {(Object.keys(MEMBER_ROLE_LABELS) as MemberRole[]).map((role) => (
                  <option key={role} value={role}>
                    {MEMBER_ROLE_LABELS[role]}
                  </option>
                ))}
              </select>
              {/* 역할 pm은 라벨일 뿐이다 — 과제의 PM은 인력 목록의 [PM으로 지정]이 정한다 (§7.10) */}
              <span className="mt-1 block text-xs text-grey-500">
                과제 총괄책임자 지정은 인력 목록의 [PM으로 지정]으로 합니다.
              </span>
            </label>

            <label>
              <span className="text-sm font-medium text-grey-700">소속 기관</span>
              <select
                value={values.orgId}
                onChange={(e) => setField('orgId', e.target.value)}
                className="mt-1 w-full rounded-lg border border-grey-300 bg-white px-3 py-2 text-sm focus:border-grey-500 focus:outline-none"
              >
                <option value="">소속 없음</option>
                {organizations.map((org) => (
                  <option key={org.id} value={org.id}>
                    {org.name}
                  </option>
                ))}
                {/* 목록에 없는 기관을 가리키고 있으면 선택값을 조용히 바꾸지 않고 그대로 보인다 */}
                {values.orgId !== '' &&
                  !organizations.some((org) => org.id === values.orgId) && (
                    <option value={values.orgId}>(삭제된 기관)</option>
                  )}
              </select>
            </label>

            <label>
              <span className="text-sm font-medium text-grey-700">직급</span>
              <input
                type="text"
                value={values.position}
                onChange={(e) => setField('position', e.target.value)}
                maxLength={100}
                placeholder="예: 책임연구원"
                className="mt-1 w-full rounded-lg border border-grey-300 px-3 py-2 text-sm focus:border-grey-500 focus:outline-none"
              />
            </label>

            <label>
              <span className="text-sm font-medium text-grey-700">분야</span>
              <input
                type="text"
                value={values.field}
                onChange={(e) => setField('field', e.target.value)}
                maxLength={100}
                placeholder="예: 제어 SW"
                className="mt-1 w-full rounded-lg border border-grey-300 px-3 py-2 text-sm focus:border-grey-500 focus:outline-none"
              />
            </label>

            <label>
              <span className="text-sm font-medium text-grey-700">이메일</span>
              <input
                type="email"
                value={values.email}
                onChange={(e) => setField('email', e.target.value)}
                className="mt-1 w-full rounded-lg border border-grey-300 px-3 py-2 text-sm focus:border-grey-500 focus:outline-none"
              />
            </label>

            <label>
              <span className="text-sm font-medium text-grey-700">연락처</span>
              <input
                type="text"
                value={values.phone}
                onChange={(e) => setField('phone', e.target.value)}
                maxLength={50}
                placeholder="예: 010-0000-0000"
                className="mt-1 w-full rounded-lg border border-grey-300 px-3 py-2 text-sm focus:border-grey-500 focus:outline-none"
              />
            </label>

            <label>
              <span className="text-sm font-medium text-grey-700">연봉(원)</span>
              <input
                type="text"
                inputMode="numeric"
                value={formatAmount(values.annualSalary)}
                onChange={(e) => setField('annualSalary', toDigits(e.target.value))}
                placeholder="미입력"
                className="mt-1 w-full rounded-lg border border-grey-300 px-3 py-2 text-right text-sm tabular-nums focus:border-grey-500 focus:outline-none"
              />
              {/* 참여율은 여기 없다 — 연차마다 달라지므로 산출근거가 갖는다 (§5.11, §7.10) */}
              <span className="mt-1 block text-xs text-grey-500">
                인건비 산출근거의 단가로 쓰입니다. 참여율·참여기간은 연구비 화면에서 연차별로
                입력합니다.
              </span>
            </label>

            <label>
              <span className="text-sm font-medium text-grey-700">채용구분</span>
              <select
                value={values.hireType}
                onChange={(e) => setField('hireType', e.target.value as HireType)}
                className="mt-1 w-full rounded-lg border border-grey-300 bg-white px-3 py-2 text-sm focus:border-grey-500 focus:outline-none"
              >
                {(Object.keys(HIRE_TYPE_LABELS) as HireType[]).map((hireType) => (
                  <option key={hireType} value={hireType}>
                    {HIRE_TYPE_LABELS[hireType]}
                  </option>
                ))}
              </select>
              <span className="mt-1 block text-xs text-grey-500">
                아직 사람이 정해지지 않은 자리도 <strong>채용예정</strong>으로 등록합니다.
              </span>
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

      {/* PL-10b: 연봉 변경은 협의 끝난 예산을 흔든다 — 무엇이 얼마나 바뀌는지 보여주고 확인받는다 */}
      {preview && (
        <Modal
          open
          title="연봉을 바꾸면 산출근거 금액도 함께 바뀝니다"
          onClose={() => setPreview(null)}
          closeOnBackdrop={false}
          size="lg"
          footer={
            <>
              <Button size="sm" onClick={() => setPreview(null)} disabled={saving}>
                취소
              </Button>
              <Button size="sm" variant="primary" disabled={saving} onClick={() => void save()}>
                {saving ? '저장 중…' : '확인하고 저장'}
              </Button>
            </>
          }
        >
          <p className="text-sm text-grey-700">
            이 연봉을 쓰는 <strong>산출근거 {preview.detailCount}건</strong>의 금액이 함께 바뀝니다.
          </p>
          <p className="mt-2 text-sm text-grey-600">
            연봉{' '}
            <span className="tabular-nums">
              {preview.currentAnnualSalary === null
                ? '(미입력)'
                : formatWon(preview.currentAnnualSalary)}
            </span>{' '}
            →{' '}
            <span className="font-semibold tabular-nums text-grey-900">
              {preview.nextAnnualSalary === null ? '(미입력)' : formatWon(preview.nextAnnualSalary)}
            </span>
          </p>

          {preview.missingSalaryCount > 0 && (
            <p className="mt-3 rounded-lg bg-orange-50 p-3 text-sm text-orange-800">
              연봉이 비어 있으면 인건비 산출근거 {preview.missingSalaryCount}건이{' '}
              <strong>0원</strong>으로 계산됩니다.
            </p>
          )}

          <table className="mt-3 w-full text-left text-sm">
            <thead className="text-xs text-grey-500">
              <tr className="border-b border-grey-200">
                <th className="py-2 font-medium">연차</th>
                <th className="py-2 font-medium">비목</th>
                <th className="py-2 text-right font-medium">건수</th>
                <th className="py-2 text-right font-medium">변경 전</th>
                <th className="py-2 text-right font-medium">변경 후</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-grey-100">
              {preview.cells.map((cell) => (
                <tr key={`${cell.yearId}|${cell.category}`}>
                  <td className="py-2 text-grey-700">{cell.yearName}</td>
                  <td className="py-2 text-grey-600">{BUDGET_CATEGORY_LABELS[cell.category]}</td>
                  <td className="py-2 text-right tabular-nums text-grey-600">{cell.rowCount}건</td>
                  <td className="py-2 text-right tabular-nums text-grey-500">
                    {formatWon(cell.beforeAmount)}
                  </td>
                  <td className="py-2 text-right font-semibold tabular-nums text-grey-900">
                    {formatWon(cell.afterAmount)}
                  </td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr className="border-t border-grey-300">
                <td className="py-2 font-semibold text-grey-700" colSpan={2}>
                  합계
                </td>
                <td className="py-2 text-right tabular-nums text-grey-600">
                  {preview.detailCount}건
                </td>
                <td className="py-2 text-right tabular-nums text-grey-500">
                  {formatWon(preview.beforeTotal)}
                </td>
                <td className="py-2 text-right font-semibold tabular-nums text-grey-900">
                  {formatWon(preview.afterTotal)}
                </td>
              </tr>
            </tfoot>
          </table>

          <p className="mt-3 text-sm text-grey-700">
            총액 변동{' '}
            <span
              className={`font-semibold tabular-nums ${
                preview.delta > 0 ? 'text-red-600' : preview.delta < 0 ? 'text-blue-600' : ''
              }`}
            >
              {preview.delta > 0 ? '+' : ''}
              {formatWon(preview.delta)}
            </span>
          </p>
        </Modal>
      )}

      {conflict && (
        <ConflictDialog
          message={conflict}
          // 서버 데이터를 다시 가져오면 부모가 최신 member를 내려주고, 위 effect가 비교 패널을 연다
          onReload={() => router.refresh()}
          onKeepEditing={() => setConflict(null)}
        />
      )}
    </>
  );
}
