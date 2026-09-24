'use client';

// [급여 반영] 확인 대화상자 (SOT §7.10, §5.20 SL-1·SL-2·SL-4·SL-5, §6.10 PL-10b)
// 인력 화면(MemberSection)과 [인건비] 탭(§7.9.6)이 같이 쓴다 — 반영 경로가 둘이면 문구·확인 순서가 갈린다.
// 흐름: 기준 연차(시작일이 기준일, SL-2) → previewStaffSalaryApply(저장 안 함) → 사용자가 [반영] →
// applyStaffSalary. 연차가 하나면 셀렉트를 숨기고, 시작일이 없는 연차는 기준일이 없으므로 고를 수 없다.
// 이 컴포넌트는 급여 환산·금액 산식을 갖지 않는다 — 전부 서버가 준 값을 그대로 보여준다(PL-10a).
// 이력이 없으면(RULE) 여기서 문구와 /staff 링크를 보여준다. 자동 반영 경로는 없다(SL-5).

import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import type { Member } from '@/types';
import type { ActionErrorCode } from '@/lib/db/errors';
import {
  applyStaffSalary,
  previewStaffSalaryApply,
  type StaffSalaryApplyPreview,
} from '@/actions/team';
import { SALARY_BASIS_LABELS, SALARY_FLAG_LABELS } from '@/lib/constants';
import { setRealtimePaused } from '@/components/RealtimeRefresher';
import Badge from '@/components/ui/Badge';
import Button from '@/components/ui/Button';
import ErrorBanner from '@/components/ui/ErrorBanner';
import Modal from '@/components/ui/Modal';

export interface SalaryApplyDialogYear {
  id: string;
  name: string;
  /** null이면 기준일이 없어 이 연차로는 반영할 수 없다 */
  startDate: string | null;
}

export interface SalaryApplyDialogProps {
  memberId: string;
  memberName: string;
  /** O-1: 미리보기 뒤 누가 인력 행을 고쳤으면 STALE로 막는다 */
  memberVersion: number;
  years: SalaryApplyDialogYear[];
  defaultYearId?: string;
  onClose: () => void;
  /**
   * 반영 성공. 두 번째 인자는 재계산된 산출근거 건수 — 호출자가 "산출근거 N건 재계산" 문구를 만든다.
   * (Member만 받는 호출자도 그대로 쓸 수 있다)
   */
  onApplied: (member: Member, detailCount: number) => void;
}

type PreviewState =
  | { phase: 'idle' }
  | { phase: 'loading' }
  | { phase: 'ready'; preview: StaffSalaryApplyPreview }
  | { phase: 'error'; message: string; code?: ActionErrorCode };

function formatWon(amount: number): string {
  return `${amount.toLocaleString('ko-KR')}원`;
}

/** 서버 문구에 의존하지 않고 "이력 없음"을 가려 /staff 링크를 붙인다 — 문구가 바뀌어도 링크는 남아야 한다 */
function isNoSalaryHistory(message: string): boolean {
  return message.includes('급여 이력이 없습니다');
}

export default function SalaryApplyDialog({
  memberId,
  memberName,
  memberVersion,
  years,
  defaultYearId,
  onClose,
  onApplied,
}: SalaryApplyDialogProps) {
  const router = useRouter();
  // 기본값: 지정된 연차 → 시작일이 있는 첫 연차 → 첫 연차(시작일 없음 안내가 보이도록)
  const [yearId, setYearId] = useState<string | null>(() => {
    if (defaultYearId && years.some((y) => y.id === defaultYearId)) return defaultYearId;
    return years.find((y) => y.startDate !== null)?.id ?? years[0]?.id ?? null;
  });
  const [state, setState] = useState<PreviewState>({ phase: 'idle' });
  const [applying, setApplying] = useState(false);
  const [applyFailure, setApplyFailure] = useState<{ message: string; code?: ActionErrorCode } | null>(
    null
  );

  const year = useMemo(() => years.find((y) => y.id === yearId) ?? null, [years, yearId]);
  const asOfDate = year?.startDate ?? null;

  // R-4: 확인 중에 자동 새로고침이 끼어들면 보고 있던 전후 금액이 바뀐다
  useEffect(() => {
    setRealtimePaused(true);
    return () => setRealtimePaused(false);
  }, []);

  const loadPreview = useCallback(async () => {
    if (asOfDate === null) {
      setState({ phase: 'idle' });
      return;
    }
    setState({ phase: 'loading' });
    const res = await previewStaffSalaryApply(memberId, asOfDate);
    if (!res.ok) {
      setState({ phase: 'error', message: res.error, code: res.code });
      return;
    }
    setState({ phase: 'ready', preview: res.data });
  }, [memberId, asOfDate]);

  useEffect(() => {
    setApplyFailure(null);
    void loadPreview();
  }, [loadPreview]);

  const handleApply = async (): Promise<void> => {
    if (asOfDate === null || state.phase !== 'ready') return;
    setApplying(true);
    setApplyFailure(null);
    const res = await applyStaffSalary(memberId, asOfDate, memberVersion);
    setApplying(false);
    if (!res.ok) {
      setApplyFailure({ message: res.error, code: res.code });
      return;
    }
    onApplied(res.data, state.preview.detailCount);
  };

  const preview = state.phase === 'ready' ? state.preview : null;
  const canApply = preview !== null && !applying;

  return (
    <Modal
      open
      title="급여 반영"
      description={`${memberName}님의 연봉을 조직원 급여 이력에서 가져옵니다. 반영 전까지 저장되지 않습니다.`}
      onClose={onClose}
      closeOnBackdrop={false}
      size="lg"
      footer={
        <>
          <Button size="sm" onClick={onClose} disabled={applying}>
            취소
          </Button>
          <Button size="sm" variant="primary" disabled={!canApply} onClick={() => void handleApply()}>
            {applying ? '반영 중…' : '반영'}
          </Button>
        </>
      }
    >
      {years.length === 0 && (
        <p className="rounded-lg bg-orange-50 p-3 text-sm text-orange-800">
          이 과제에 연차가 없습니다. 기준일은 연차 시작일이므로 연차를 먼저 만들어야 반영할 수 있습니다.
        </p>
      )}

      {/* 연차가 하나면 고를 것이 없다 — 셀렉트를 숨기고 기준일만 알린다 */}
      {years.length > 1 && (
        <label className="block text-sm">
          <span className="font-medium text-grey-700">기준 연차</span>
          <select
            value={yearId ?? ''}
            onChange={(e) => setYearId(e.target.value)}
            disabled={applying}
            className="mt-1 w-full max-w-sm rounded-md border border-grey-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none focus:ring-2 focus:ring-blue-100"
          >
            {years.map((y) => (
              <option key={y.id} value={y.id} disabled={y.startDate === null}>
                {y.name}
                {y.startDate === null ? ' (시작일 없음)' : ` — ${y.startDate}`}
              </option>
            ))}
          </select>
        </label>
      )}

      {year && asOfDate !== null && (
        <p className={`text-sm text-grey-600 ${years.length > 1 ? 'mt-2' : ''}`}>
          기준일 <span className="font-medium tabular-nums text-grey-900">{asOfDate}</span>
          <span className="text-grey-500"> ({year.name} 시작일)</span> 이하의 가장 늦은 급여 이력을 씁니다.
        </p>
      )}

      {year && asOfDate === null && (
        <p className="mt-2 rounded-lg bg-orange-50 p-3 text-sm text-orange-800">
          <strong>{year.name}</strong>에 시작일이 없어 기준일을 정할 수 없습니다. 연차 시작일을 먼저
          입력하거나 시작일이 있는 다른 연차를 고르세요.
        </p>
      )}

      {state.phase === 'loading' && (
        <p className="mt-4 text-sm text-grey-500">급여 이력과 영향 범위를 확인하는 중…</p>
      )}

      {state.phase === 'error' && (
        <div className="mt-4">
          <ErrorBanner message={state.message} code={state.code} onRetry={() => void loadPreview()} />
          {isNoSalaryHistory(state.message) && (
            <p className="mt-2 text-sm text-grey-700">
              <Link href="/staff" className="font-semibold text-blue-600 underline underline-offset-2">
                조직원 화면(/staff)
              </Link>
              에서 이 조직원의 급여 이력을 추가한 뒤 다시 시도하세요.
            </p>
          )}
        </div>
      )}

      {preview && (
        <div className="mt-4 space-y-4">
          <section className="rounded-xl border border-grey-200 bg-grey-50 p-4">
            <h3 className="text-t7 font-semibold text-grey-500">고른 급여 이력</h3>
            <dl className="mt-2 grid grid-cols-2 gap-x-4 gap-y-1.5 text-sm">
              <dt className="text-grey-600">적용일</dt>
              <dd className="tabular-nums text-grey-900">{preview.salary.effectiveFrom}</dd>
              <dt className="text-grey-600">입력 단위 · 금액</dt>
              <dd className="tabular-nums text-grey-900">
                {SALARY_BASIS_LABELS[preview.salary.basis]} {formatWon(preview.salary.amount)}
              </dd>
              <dt className="text-grey-600">연봉 환산</dt>
              <dd className="font-semibold tabular-nums text-grey-900">{formatWon(preview.annualSalary)}</dd>
              <dt className="text-grey-600">월급(표시)</dt>
              <dd className="tabular-nums text-grey-900">{formatWon(preview.monthlyDisplay)}</dd>
              <dt className="text-grey-600">포함 항목</dt>
              <dd className="flex flex-wrap gap-1">
                {preview.salary.includesRetirement && (
                  <Badge tone="blue">{SALARY_FLAG_LABELS.retirement}</Badge>
                )}
                {preview.salary.includesInsurance && (
                  <Badge tone="blue">{SALARY_FLAG_LABELS.insurance}</Badge>
                )}
                {!preview.salary.includesRetirement && !preview.salary.includesInsurance && (
                  <Badge tone="neutral">포함 없음</Badge>
                )}
              </dd>
              {preview.salary.note !== '' && (
                <>
                  <dt className="text-grey-600">메모</dt>
                  <dd className="break-words text-grey-700">{preview.salary.note}</dd>
                </>
              )}
            </dl>
          </section>

          <p className="text-sm text-grey-700">
            연봉{' '}
            <span className="tabular-nums">
              {preview.currentAnnualSalary === null
                ? '(미입력)'
                : formatWon(preview.currentAnnualSalary)}
            </span>{' '}
            →{' '}
            <span className="font-semibold tabular-nums text-grey-900">{formatWon(preview.annualSalary)}</span>
            {preview.currentAnnualSalary === preview.annualSalary && (
              <span className="ml-2 text-grey-500">(금액은 같습니다 — 기준 배지만 갱신됩니다)</span>
            )}
          </p>

          {preview.detailCount === 0 ? (
            <p className="rounded-lg bg-grey-50 p-3 text-sm text-grey-600">
              산출근거 없음 — 연봉과 기준(퇴직금·4대보험 포함, 적용 이력)만 갱신합니다.
            </p>
          ) : (
            <div>
              {/* PL-10b: 협의 끝난 예산이 얼마나 흔들리는지 보여주고 확인받는다 */}
              <p className="text-sm text-grey-700">
                이 연봉을 쓰는 <strong>산출근거 {preview.detailCount}건</strong>의 금액이 함께 바뀝니다.
              </p>
              <table className="mt-2 w-full text-left text-sm">
                <thead className="text-xs text-grey-500">
                  <tr className="border-b border-grey-200">
                    <th className="py-2 font-medium">연차</th>
                    <th className="py-2 text-right font-medium">변경 전</th>
                    <th className="py-2 text-right font-medium">변경 후</th>
                    <th className="py-2 text-right font-medium">차액</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-grey-100">
                  {preview.byYear.map((row) => {
                    const delta = row.after - row.before;
                    return (
                      <tr key={row.yearId}>
                        <td className="py-2 text-grey-700">{row.name}</td>
                        <td className="py-2 text-right tabular-nums text-grey-500">{formatWon(row.before)}</td>
                        <td className="py-2 text-right font-semibold tabular-nums text-grey-900">
                          {formatWon(row.after)}
                        </td>
                        <td
                          className={`py-2 text-right tabular-nums ${
                            delta > 0 ? 'text-red-600' : delta < 0 ? 'text-blue-600' : 'text-grey-500'
                          }`}
                        >
                          {delta > 0 ? '+' : ''}
                          {formatWon(delta)}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}

          <p className="text-xs text-grey-500">
            급여 이력이 나중에 바뀌어도 이 과제의 연봉은 자동으로 따라가지 않습니다. 다시 반영하려면 이 버튼을 다시
            누르세요.
          </p>
        </div>
      )}

      {applyFailure && (
        <div className="mt-4">
          <ErrorBanner message={applyFailure.message} code={applyFailure.code} />
          {applyFailure.code === 'STALE' && (
            <div className="mt-2 flex flex-wrap items-center gap-2 text-sm text-grey-700">
              <span>다른 사람이 이 인력을 먼저 수정했습니다. 새로고침한 뒤 다시 반영하세요.</span>
              <Button
                size="sm"
                onClick={() => {
                  router.refresh();
                  onClose();
                }}
              >
                새로고침
              </Button>
            </div>
          )}
          {isNoSalaryHistory(applyFailure.message) && (
            <p className="mt-2 text-sm text-grey-700">
              <Link href="/staff" className="font-semibold text-blue-600 underline underline-offset-2">
                조직원 화면(/staff)
              </Link>
              에서 급여 이력을 확인하세요.
            </p>
          )}
        </div>
      )}
    </Modal>
  );
}
