'use client';

// 조직원 상세 패널 — 목록에서 행을 클릭하면 우측에 열린다 (SOT §7.18, §5.19, §5.20 SL-1·SL-2·SL-3·SL-5, §8.4 O-1·O-3)
//
// 이 패널이 소유하는 것: 상세 조회(getStaffDetail)·조직원 편집·급여 이력 CRUD·실패 배너·STALE 다이얼로그.
// 부모(StaffScreen)에게는 "무언가 바뀌었다"(onChanged)와 "닫아 달라"(onClose)만 알린다 —
// BudgetPlanPanel과 같은 패턴이다. 부모의 router.refresh()는 client가 받아 둔 상세에 닿지 못하므로
// 다시 불러오기도 패널이 한다.
//
//  - 연봉·월급 환산은 lib/salary.ts만 부른다. 산식을 여기서 다시 쓰지 않는다(PL-10a).
//  - **여기에 [급여 반영] 버튼은 없다.** 급여를 고쳐도 과제 인건비는 움직이지 않고(SL-5), 반영은
//    과제 인력 화면(§7.10)에서만 한다. 연결 Member의 연봉이 현재 급여와 다르면 배지와 링크로만 알린다.
//  - 조회 실패는 배너로 드러낸다. 빈 표로 눙치지 않는다(절대 규칙 5).
//
// 쓰기·조회는 전부 actions/staff.ts를 거친다. supabase를 직접 부르지 않는다(§8.2 C-2).

import { useCallback, useEffect, useId, useMemo, useState } from 'react';
import Link from 'next/link';
import type { ActionResult, Staff, StaffSalary } from '@/types';
import type { ActionErrorCode } from '@/lib/db/errors';
import type { StaffDetail, StaffLinkedMember } from '@/actions/staff';
import { deleteStaffSalary, getStaffDetail, updateStaff } from '@/actions/staff';
import { SALARY_BASIS_LABELS } from '@/lib/constants';
import { formatAmount } from '@/lib/currency';
import { todayISO } from '@/lib/dates';
import { monthlyDisplay, pickSalaryAsOf, salaryBasisBadge, toAnnualSalary } from '@/lib/salary';
import Badge from '@/components/ui/Badge';
import Button from '@/components/ui/Button';
import Modal from '@/components/ui/Modal';
import ErrorBanner from '@/components/ui/ErrorBanner';
import ConflictDialog from '@/components/ui/ConflictDialog';
import { SkeletonBlock } from '@/components/ui/Skeleton';
import { setRealtimePaused } from '@/components/RealtimeRefresher';
import SalaryFormModal from './SalaryFormModal';

export interface StaffDetailPanelProps {
  staffId: string;
  onClose: () => void;
  /** 조직원·급여 이력이 바뀌었다 — 부모는 목록(현재 급여·연결 과제 수)을 다시 그린다 */
  onChanged: () => void;
}

interface Failure {
  message: string;
  code?: ActionErrorCode;
}

type SalaryModalState = { mode: 'create' } | { mode: 'edit'; salaryId: string };

const SALARY_HEADERS: readonly string[] = [
  '적용일',
  '단위',
  '금액',
  '연봉 환산',
  '월급 환산',
  '퇴직금',
  '4대보험',
  '메모',
  '',
];

function won(amount: number): string {
  return formatAmount(amount, '원');
}

export default function StaffDetailPanel({ staffId, onClose, onChanged }: StaffDetailPanelProps) {
  const titleId = useId();
  const [detail, setDetail] = useState<StaffDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [failure, setFailure] = useState<Failure | null>(null);
  const [busy, setBusy] = useState(false);
  const [editingStaff, setEditingStaff] = useState(false);
  const [salaryModal, setSalaryModal] = useState<SalaryModalState | null>(null);
  const [deleting, setDeleting] = useState<StaffSalary | null>(null);

  // R-4: 패널이 열려 있는 동안 자동 새로고침을 보류해 입력 중인 내용을 지킨다
  useEffect(() => {
    setRealtimePaused(true);
    return () => setRealtimePaused(false);
  }, []);

  const load = useCallback(async (): Promise<void> => {
    setLoading(true);
    try {
      const res = await getStaffDetail(staffId);
      if (!res.ok) {
        // 이전 상세를 남겨 두면 실패한 줄 모르고 옛 값을 본다 — 배너와 함께 비운다(절대 규칙 5)
        setFailure({ message: res.error, code: res.code });
        return;
      }
      setFailure(null);
      setDetail(res.data);
    } finally {
      setLoading(false);
    }
  }, [staffId]);

  useEffect(() => {
    void load();
  }, [load]);

  const overlayOpen = editingStaff || salaryModal !== null || deleting !== null;

  // Esc 닫기. 모달·다이얼로그가 위에 떠 있으면 그쪽 Esc가 먼저다 — 패널까지 같이 닫히면 입력이 날아간다
  useEffect(() => {
    if (overlayOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [overlayOpen, onClose]);

  // 변경이 성공하면 부모에게 알리고 스스로 다시 받는다
  const afterChange = useCallback(async (): Promise<void> => {
    onChanged();
    await load();
  }, [onChanged, load]);

  const run = useCallback(
    async <T,>(action: () => Promise<ActionResult<T>>, onOk?: () => void): Promise<void> => {
      setBusy(true);
      setFailure(null);
      try {
        const res = await action();
        if (!res.ok) {
          setFailure({ message: res.error, code: res.code });
          return;
        }
        onOk?.();
        await afterChange();
      } finally {
        setBusy(false);
      }
    },
    [afterChange]
  );

  // SL-2 오늘 기준 — 기준일 이하 이력 중 가장 늦은 것에 `현재` 배지. 미래 적용일 행은 현재가 아니다
  const currentSalaryId = useMemo(
    () => (detail ? (pickSalaryAsOf(detail.salaries, todayISO(new Date()))?.id ?? null) : null),
    [detail]
  );

  // 편집 모달이 보는 이력. 다시 불러온 뒤 없어졌으면 undefined — 모달이 그 사실을 알린다
  const editingSalary =
    salaryModal?.mode === 'edit'
      ? detail?.salaries.find((s) => s.id === salaryModal.salaryId)
      : undefined;

  const handleDeleteSalary = (): void => {
    const target = deleting;
    if (target === null) return;
    void run(() => deleteStaffSalary(target.id), () => setDeleting(null));
  };

  return (
    <div
      className="fixed inset-0 z-40 bg-dimmed print:hidden"
      onMouseDown={(e) => {
        // 편집 중 배경 클릭으로 닫히면 입력이 날아간다 — 겹친 창이 없을 때만 닫는다
        if (!overlayOpen && e.target === e.currentTarget) onClose();
      }}
    >
      <aside
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className="fixed inset-y-0 right-0 flex w-[32rem] max-w-full flex-col rounded-l-3xl bg-surface shadow-xl"
      >
        {/* 헤더 */}
        <div className="border-b border-hairline px-6 pb-4 pt-6">
          {detail === null ? (
            <div className="flex items-start justify-between gap-4">
              <div className="flex-1">
                {loading ? (
                  <SkeletonBlock className="h-7 w-40" />
                ) : (
                  <h2 id={titleId} className="text-t4 font-bold text-grey-900">
                    조직원
                  </h2>
                )}
              </div>
              <CloseButton onClose={onClose} />
            </div>
          ) : (
            <div className="flex items-start justify-between gap-4">
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2">
                  <h2 id={titleId} className="text-t4 font-bold text-grey-900">
                    {detail.staff.name}
                  </h2>
                  {detail.staff.position !== '' && (
                    <span className="text-t6 text-grey-600">{detail.staff.position}</span>
                  )}
                  {detail.staff.employed ? (
                    <Badge tone="green">재직</Badge>
                  ) : (
                    <Badge tone="neutral">퇴사</Badge>
                  )}
                </div>
                <p className="mt-1 break-all text-t7 text-grey-500">{detail.staff.email}</p>
                {detail.staff.note !== '' && (
                  <p className="mt-1 whitespace-pre-wrap text-t7 text-grey-600">{detail.staff.note}</p>
                )}
              </div>
              <div className="flex shrink-0 items-center gap-2">
                <Button size="sm" onClick={() => setEditingStaff(true)} disabled={busy || loading}>
                  편집
                </Button>
                <CloseButton onClose={onClose} />
              </div>
            </div>
          )}
        </div>

        {/* 본문 */}
        <div className="flex-1 space-y-6 overflow-y-auto px-6 py-5">
          {failure && (
            <ErrorBanner
              message={failure.message}
              code={failure.code}
              onRetry={() => void load()}
              onDismiss={() => setFailure(null)}
            />
          )}

          {detail === null ? (
            // 실패는 위 배너가 이미 말한다. 여기서 빈 표를 그리면 "이력이 없다"는 거짓말이 된다
            !failure && <DetailSkeleton />
          ) : (
            <>
              {/* 급여 이력 (SL-3) */}
              <section aria-labelledby={`${titleId}-salaries`}>
                <div className="flex items-center justify-between gap-3">
                  <h3 id={`${titleId}-salaries`} className="text-t5 font-semibold text-grey-900">
                    급여 이력
                    <span className="ml-2 text-t7 font-normal text-grey-500">{detail.salaries.length}건</span>
                  </h3>
                  <Button
                    size="sm"
                    variant="primary"
                    onClick={() => setSalaryModal({ mode: 'create' })}
                    disabled={busy}
                  >
                    이력 추가
                  </Button>
                </div>
                <p className="mt-1 text-t7 text-grey-500">
                  급여가 바뀌면 새 적용일로 이력을 추가합니다. 과제 인건비는 자동으로 바뀌지 않습니다 —
                  반영은 과제 인력 화면의 [급여 반영]뿐입니다.
                </p>

                {detail.salaries.length === 0 ? (
                  <p className="mt-3 rounded-lg border border-dashed border-grey-300 p-5 text-center text-t7 text-grey-400">
                    급여 이력이 없습니다. 이력이 없으면 과제에 [급여 반영]을 할 수 없습니다.
                  </p>
                ) : (
                  <div className="mt-3 overflow-x-auto rounded-xl border border-hairline">
                    <table className="w-full text-t7">
                      <thead className="bg-grey-50 text-left text-grey-600">
                        <tr>
                          {SALARY_HEADERS.map((h, i) => (
                            <th key={i} className="whitespace-nowrap px-2.5 py-2 font-medium">
                              {h}
                            </th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {detail.salaries.map((salary) => (
                          <SalaryRow
                            key={salary.id}
                            salary={salary}
                            isCurrent={salary.id === currentSalaryId}
                            disabled={busy}
                            onEdit={() => setSalaryModal({ mode: 'edit', salaryId: salary.id })}
                            onDelete={() => setDeleting(salary)}
                          />
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </section>

              {/* 연결된 과제 인력 (SL-5 — 반영 버튼 없음) */}
              <section aria-labelledby={`${titleId}-members`}>
                <h3 id={`${titleId}-members`} className="text-t5 font-semibold text-grey-900">
                  연결된 과제 인력
                  <span className="ml-2 text-t7 font-normal text-grey-500">{detail.linkedMembers.length}건</span>
                </h3>
                <p className="mt-1 text-t7 text-grey-500">
                  과제에 남은 연봉은 [급여 반영] 당시의 스냅샷입니다. 현재 급여와 다르면 표시만 하고, 반영은
                  과제 인력 화면에서 합니다.
                </p>

                {detail.linkedMembers.length === 0 ? (
                  <p className="mt-3 rounded-lg border border-dashed border-grey-300 p-5 text-center text-t7 text-grey-400">
                    연결된 과제 인력이 없습니다. 과제 인력 화면에서 조직원을 연결합니다.
                  </p>
                ) : (
                  <ul className="mt-3 space-y-2">
                    {detail.linkedMembers.map((linked) => (
                      <LinkedMemberItem key={linked.member.id} linked={linked} />
                    ))}
                  </ul>
                )}
              </section>
            </>
          )}
        </div>
      </aside>

      {editingStaff && detail !== null && (
        <StaffEditModal
          staff={detail.staff}
          onClose={() => setEditingStaff(false)}
          onSaved={() => {
            setEditingStaff(false);
            void afterChange();
          }}
          onReload={() => void load()}
        />
      )}

      {salaryModal !== null && detail !== null && (
        <SalaryFormModal
          mode={salaryModal.mode}
          staffId={detail.staff.id}
          salary={editingSalary}
          onClose={() => setSalaryModal(null)}
          onSaved={() => {
            setSalaryModal(null);
            void afterChange();
          }}
          onReload={() => void load()}
        />
      )}

      {deleting !== null && (
        <Modal
          open
          title="급여 이력을 삭제할까요?"
          onClose={() => setDeleting(null)}
          closeOnBackdrop={false}
          footer={
            <>
              <Button size="sm" onClick={() => setDeleting(null)} disabled={busy}>
                취소
              </Button>
              <Button size="sm" variant="danger" onClick={handleDeleteSalary} disabled={busy}>
                {busy ? '삭제 중…' : '삭제'}
              </Button>
            </>
          }
        >
          <p className="text-t6 text-grey-700">
            {deleting.effectiveFrom} 적용 · {SALARY_BASIS_LABELS[deleting.basis]} {won(deleting.amount)}
          </p>
          <p className="mt-2 text-t7 text-grey-500">
            이미 과제에 반영된 연봉은 스냅샷이라 그대로 남습니다. 이 작업은 되돌릴 수 없습니다.
          </p>
        </Modal>
      )}
    </div>
  );
}

function CloseButton({ onClose }: { onClose: () => void }) {
  return (
    <button
      type="button"
      onClick={onClose}
      aria-label="패널 닫기"
      className="shrink-0 text-xl leading-none text-grey-400 hover:text-grey-600"
    >
      ×
    </button>
  );
}

function DetailSkeleton() {
  return (
    <div role="status" aria-label="불러오는 중" className="space-y-6">
      <div>
        <SkeletonBlock className="h-5 w-24" />
        <div className="mt-3 rounded-xl border border-hairline p-3">
          <SkeletonBlock className="h-4 w-full" />
          <SkeletonBlock className="mt-3 h-4 w-full" />
          <SkeletonBlock className="mt-3 h-4 w-5/6" />
        </div>
      </div>
      <div>
        <SkeletonBlock className="h-5 w-32" />
        <SkeletonBlock className="mt-3 h-14 w-full" />
      </div>
      <span className="sr-only">불러오는 중</span>
    </div>
  );
}

interface SalaryRowProps {
  salary: StaffSalary;
  isCurrent: boolean;
  disabled: boolean;
  onEdit: () => void;
  onDelete: () => void;
}

function SalaryRow({ salary, isCurrent, disabled, onEdit, onDelete }: SalaryRowProps) {
  // SL-1: 환산은 lib/salary.ts. 월급은 표시에서만 반올림한다
  const annual = toAnnualSalary(salary);
  const monthly = monthlyDisplay(annual);
  return (
    <tr className={`border-t border-hairline ${isCurrent ? 'bg-blue-50/40' : ''}`}>
      <td className="whitespace-nowrap px-2.5 py-2 text-grey-900">
        <span className="tabular-nums">{salary.effectiveFrom}</span>
        {isCurrent && (
          <Badge tone="blue" className="ml-1.5" title="오늘 기준 적용 중인 이력 (SL-2)">
            현재
          </Badge>
        )}
      </td>
      <td className="whitespace-nowrap px-2.5 py-2 text-grey-700">{SALARY_BASIS_LABELS[salary.basis]}</td>
      <td className="whitespace-nowrap px-2.5 py-2 text-right tabular-nums text-grey-900">{won(salary.amount)}</td>
      <td className="whitespace-nowrap px-2.5 py-2 text-right tabular-nums text-grey-900">{won(annual)}</td>
      <td
        className="whitespace-nowrap px-2.5 py-2 text-right tabular-nums text-grey-700"
        title="표시용 반올림 값 — 산식에는 연봉을 씁니다"
      >
        {won(monthly)}
      </td>
      <td className="whitespace-nowrap px-2.5 py-2 text-grey-700">{salary.includesRetirement ? '포함' : '—'}</td>
      <td className="whitespace-nowrap px-2.5 py-2 text-grey-700">{salary.includesInsurance ? '포함' : '—'}</td>
      <td className="max-w-[10rem] truncate px-2.5 py-2 text-grey-600" title={salary.note}>
        {salary.note}
      </td>
      <td className="whitespace-nowrap px-2.5 py-2 text-right">
        <button
          type="button"
          onClick={onEdit}
          disabled={disabled}
          className="rounded-md px-1.5 py-0.5 font-medium text-blue-600 hover:bg-blue-50 disabled:opacity-50"
        >
          편집
        </button>
        <button
          type="button"
          onClick={onDelete}
          disabled={disabled}
          className="ml-1 rounded-md px-1.5 py-0.5 font-medium text-red-600 hover:bg-red-50 disabled:opacity-50"
        >
          삭제
        </button>
      </td>
    </tr>
  );
}

function LinkedMemberItem({ linked }: { linked: StaffLinkedMember }) {
  const { member, projectId, projectName, projectArchived, differsFromCurrent } = linked;
  // SL-4: 스냅샷 플래그를 배지로. 플래그가 둘 다 false면 labels가 비어 "포함 없음"으로 읽는다
  const badge = salaryBasisBadge(member);
  const labels = badge.labels.length === 0 ? ['포함 없음'] : badge.labels;
  return (
    <li className="rounded-xl border border-hairline p-3">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-t6 font-semibold text-grey-900">{projectName}</span>
        {projectArchived && <Badge tone="neutral">아카이브</Badge>}
        <span className="text-t7 text-grey-500">·</span>
        <span className="text-t6 text-grey-800">{member.name}</span>
        {!member.active && <Badge tone="neutral">참여 종료</Badge>}
        {differsFromCurrent && (
          <Badge tone="red" title="과제에 남은 연봉 스냅샷이 조직원의 현재 급여(연봉 환산)와 다릅니다">
            다름
          </Badge>
        )}
      </div>
      <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-t7 text-grey-600">
        <span>
          연봉 스냅샷{' '}
          <span className="tabular-nums text-grey-900">
            {member.annualSalary === null ? '미입력' : won(member.annualSalary)}
          </span>
        </span>
        <span className="flex flex-wrap gap-1">
          {labels.map((label) => (
            <Badge key={label} tone={label === '기록 없음' || label === '포함 없음' ? 'neutral' : 'blue'}>
              {label}
            </Badge>
          ))}
        </span>
        <span>
          적용 이력{' '}
          <span className="tabular-nums text-grey-900">{member.salaryAppliedFrom ?? '—'}</span>
        </span>
      </div>
      {differsFromCurrent && (
        <p className="mt-1.5 text-t7 text-grey-600">
          반영은 과제 인력 화면에서 —{' '}
          <Link href={`/projects/${projectId}/team`} className="font-medium text-blue-600 hover:underline">
            {projectName} 인력 화면 열기
          </Link>
        </p>
      )}
    </li>
  );
}

// ─── 조직원 편집 (O-1·O-3) ───────────────────────────────────────────────────

interface StaffFormValues {
  name: string;
  email: string;
  position: string;
  employed: boolean;
  note: string;
}

type StaffFieldKey = keyof StaffFormValues;

const STAFF_FIELDS: readonly { key: StaffFieldKey; label: string }[] = [
  { key: 'name', label: '이름' },
  { key: 'email', label: '이메일' },
  { key: 'position', label: '직위' },
  { key: 'employed', label: '재직' },
  { key: 'note', label: '메모' },
] as const;

function toStaffValues(staff: Staff): StaffFormValues {
  return {
    name: staff.name,
    email: staff.email,
    position: staff.position,
    employed: staff.employed,
    note: staff.note,
  };
}

interface StaffEditModalProps {
  /** 부모가 서버 데이터를 그대로 내려준다(다시 불러오기 후 최신값이 여기로 온다) */
  staff: Staff;
  onClose: () => void;
  onSaved: () => void;
  onReload: () => void;
}

// 이름·이메일·직위·재직·메모를 한 번에 바꾸므로 O-1 대상이다. STALE이면 입력을 유지한 채 비교한다(O-3).
// 생성 폼(StaffFormModal, T8)과 계약이 다르고 이 패널만 쓰므로 여기 둔다
function StaffEditModal({ staff, onClose, onSaved, onReload }: StaffEditModalProps) {
  const [values, setValues] = useState<StaffFormValues>(() => toStaffValues(staff));
  const [saving, setSaving] = useState(false);
  const [failure, setFailure] = useState<Failure | null>(null);
  const [conflict, setConflict] = useState<string | null>(null);
  // O-3 비교 기준: 마지막으로 받아들인 서버 값. 저장에 쓰는 version도 여기서만 나온다
  const [baseline, setBaseline] = useState<Staff>(staff);
  const [reloaded, setReloaded] = useState(false);

  useEffect(() => {
    setRealtimePaused(true);
    return () => setRealtimePaused(false);
  }, []);

  const baselineVersion = baseline.version;
  useEffect(() => {
    if (staff.version === baselineVersion) return;
    setBaseline(staff);
    setConflict(null);
    setReloaded(true);
  }, [staff, baselineVersion]);

  const displayValue = (key: StaffFieldKey, source: StaffFormValues): string => {
    if (key === 'employed') return source.employed ? '재직' : '퇴사';
    return source[key] === '' ? '(비어 있음)' : source[key];
  };

  const differences = useMemo(() => {
    if (!reloaded) return [];
    const latest = toStaffValues(baseline);
    return STAFF_FIELDS.filter((field) => latest[field.key] !== values[field.key]).map((field) => ({
      field,
      latest,
    }));
  }, [reloaded, baseline, values]);

  const setField = <K extends StaffFieldKey>(key: K, value: StaffFormValues[K]): void => {
    setValues((prev) => ({ ...prev, [key]: value }));
  };

  const handleSubmit = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault();
    setFailure(null);
    if (values.name.trim() === '') {
      setFailure({ message: '이름을 입력하세요.', code: 'VALIDATION' });
      return;
    }
    if (values.email.trim() === '') {
      setFailure({ message: '이메일을 입력하세요.', code: 'VALIDATION' });
      return;
    }
    setSaving(true);
    try {
      const res = await updateStaff(
        staff.id,
        {
          name: values.name.trim(),
          email: values.email.trim(),
          position: values.position.trim(),
          employed: values.employed,
          note: values.note,
        },
        baseline.version
      );
      if (!res.ok) {
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
      <Modal open title="조직원 편집" onClose={onClose} closeOnBackdrop={false} size="lg">
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
                이름 <span className="text-red-500">*</span>
              </span>
              <input
                type="text"
                value={values.name}
                onChange={(e) => setField('name', e.target.value)}
                maxLength={200}
                required
                className={inputClass}
              />
            </label>
            <label>
              <span className="text-t7 font-medium text-grey-700">직위</span>
              <input
                type="text"
                value={values.position}
                onChange={(e) => setField('position', e.target.value)}
                maxLength={100}
                className={inputClass}
              />
            </label>
            <label className="sm:col-span-2">
              <span className="text-t7 font-medium text-grey-700">
                이메일 <span className="text-red-500">*</span>
              </span>
              <input
                type="email"
                value={values.email}
                onChange={(e) => setField('email', e.target.value)}
                required
                className={inputClass}
              />
              <span className="mt-1 block text-t7 text-grey-500">
                사내 명부·과제 인력과 잇는 키입니다. 소문자로 저장되며 다른 조직원과 겹칠 수 없습니다.
              </span>
            </label>
            <label className="flex items-center gap-2 text-t6 text-grey-800 sm:col-span-2">
              <input
                type="checkbox"
                checked={values.employed}
                onChange={(e) => setField('employed', e.target.checked)}
                className="accent-blue-500"
              />
              재직 중 (해제하면 퇴사자로 표시됩니다. 과제 참여 여부와는 별개입니다)
            </label>
            <label className="sm:col-span-2">
              <span className="text-t7 font-medium text-grey-700">메모</span>
              <textarea
                value={values.note}
                onChange={(e) => setField('note', e.target.value)}
                rows={2}
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
              {saving ? '저장 중…' : '저장'}
            </Button>
          </div>
        </form>
      </Modal>

      {conflict && (
        <ConflictDialog
          message={conflict}
          onReload={onReload}
          onKeepEditing={() => setConflict(null)}
        />
      )}
    </>
  );
}
