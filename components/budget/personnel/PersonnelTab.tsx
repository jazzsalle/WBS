'use client';

// 제안 모드 [인건비] 탭 (SOT §7.9.6, §6.10 PL-1·PL-2·PL-11·PL-D7, §6.15 PS-6, §5.11, §7.10, §8.4 O-3, §12 P-R1~P-R5)
//
// `personnel`·`student_personnel` 산출근거를 **사람 중심**으로 본다 — "월급 × 참여율 × 참여기간" 표.
// 이 탭이 소유하는 것: 선택 연차, 조회(getPersonnelTabData)와 그 로딩·실패 상태, 인라인 저장의 진행 상태,
// STALE 다이얼로그(O-3), [조직원 연결]·[급여 반영] 모달. 부모(BudgetScreen)에게는 "금액이 바뀌었다"(onSaved)만 알린다.
//
// **이 파일에는 곱셈·나눗셈이 없다.** 행 금액·월급·합계·E1·다른 과제 계상률은 전부 서버가 계산해 내린 값이다
// (PL-D7·PL-10a·O-4). 화면이 `annualSalary`를 곱하기 시작하면 서버와 1원씩 어긋난다.
//
// 데이터는 매트릭스(plan)와 **다른 조회**다 — 그래서 저장 뒤에는 이 탭이 스스로 다시 받고(load), 부모의
// router.refresh()가 매트릭스를 다시 그린다. 같은 저장이 두 표에 같은 시점으로 반영되는 경로가 그것뿐이다.
//
// 인쇄(P-R1 가로·P-R3 머리말): 표 그대로. 입력 칸·버튼은 print:hidden이고 그 자리의 값은 print:inline으로 남는다.

import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import type { Member, Staff } from '@/types';
import type { ActionErrorCode } from '@/lib/db/errors';
import {
  getPersonnelTabData,
  updateBudgetDetail,
  type PersonnelTabData,
  type StaffYearRate,
} from '@/actions/budget-plan';
import { BUDGET_CATEGORY_LABELS } from '@/lib/constants';
import { formatAmount } from '@/lib/currency';
import { setRealtimePaused } from '@/components/RealtimeRefresher';
import Button from '@/components/ui/Button';
import ConflictDialog from '@/components/ui/ConflictDialog';
import ErrorBanner from '@/components/ui/ErrorBanner';
import { SkeletonBlock } from '@/components/ui/Skeleton';
import PrintHeader from '@/components/print/PrintHeader';
import { PRINT_TABLE, PRINT_TABLE_WRAP, PRINT_TH } from '@/components/print/tokens';
import StaffLinkPicker from '@/components/staff/StaffLinkPicker';
import SalaryApplyDialog from './SalaryApplyDialog';
import PersonnelRow, { formatRate, rateToneClass, type PersonnelRowPatch } from './PersonnelRow';

export interface PersonnelTabProps {
  projectId: string;
  /** 연차 셀렉트의 원본 — 제안 스냅샷(plan.years)의 순서 그대로. 비어 있으면 탭을 열 수 없다 */
  years: readonly { id: string; name: string }[];
  /** 행이 저장되어 (연차 × 비목) 셀 합계가 바뀌었다 (PL-7·PL-10). 부모는 매트릭스를 다시 그린다 */
  onSaved: () => void;
  onBusyChange?: (busy: boolean) => void;
}

type DataState =
  | { phase: 'loading' }
  | { phase: 'ready'; data: PersonnelTabData }
  | { phase: 'error'; message: string; code?: ActionErrorCode };

const TH = `px-3 py-2 font-medium ${PRINT_TH}`;

/** 표 열 수 — PersonnelRow의 메시지 줄 colSpan과 같아야 한다 */
const COLUMN_COUNT = 13;

function formatWon(amount: number): string {
  return `${amount.toLocaleString('ko-KR')}원`;
}

export default function PersonnelTab({ projectId, years, onSaved, onBusyChange }: PersonnelTabProps) {
  const [yearId, setYearId] = useState<string | null>(() => years[0]?.id ?? null);
  const [state, setState] = useState<DataState>({ phase: 'loading' });
  const [busy, setBusyState] = useState(false);
  const [failure, setFailure] = useState<{ message: string; code?: ActionErrorCode } | null>(null);
  const [conflict, setConflict] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [linkTarget, setLinkTarget] = useState<Member | null>(null);
  const [salaryTarget, setSalaryTarget] = useState<Member | null>(null);

  // 연차 목록이 바뀌어 고른 연차가 사라졌으면 첫 연차로 — 없는 연차를 조회해 실패를 반복하지 않게
  useEffect(() => {
    if (yearId !== null && years.some((y) => y.id === yearId)) return;
    setYearId(years[0]?.id ?? null);
  }, [years, yearId]);

  const setBusy = useCallback(
    (next: boolean) => {
      setBusyState(next);
      onBusyChange?.(next);
    },
    [onBusyChange]
  );

  // R-4: 인라인 편집 중에 자동 새로고침이 끼어들면 입력 중인 값 위로 표가 다시 그려진다
  useEffect(() => {
    setRealtimePaused(true);
    return () => setRealtimePaused(false);
  }, []);

  const load = useCallback(async (): Promise<void> => {
    if (yearId === null) return;
    setState((prev) => (prev.phase === 'ready' ? prev : { phase: 'loading' }));
    const res = await getPersonnelTabData(projectId, yearId);
    if (!res.ok) {
      // 빈 표로 눙치지 않는다 — 인건비가 0으로 보이면 그것이 곧 잘못된 예산이다 (절대 규칙 5)
      setState({ phase: 'error', message: res.error, code: res.code });
      return;
    }
    setState({ phase: 'ready', data: res.data });
  }, [projectId, yearId]);

  useEffect(() => {
    setState({ phase: 'loading' });
    setNotice(null);
    void load();
  }, [load]);

  const data = state.phase === 'ready' ? state.data : null;

  const handleSaveRow = async (detailId: string, patch: PersonnelRowPatch, expectedVersion: number): Promise<void> => {
    setBusy(true);
    setFailure(null);
    try {
      const res = await updateBudgetDetail(detailId, patch, expectedVersion);
      if (!res.ok) {
        // O-3: STALE은 배너가 아니라 선택 다이얼로그로 — 입력값은 행이 그대로 들고 있는다
        if (res.code === 'STALE') setConflict(res.error);
        else setFailure({ message: res.error, code: res.code });
        return;
      }
      onSaved();
      await load();
    } finally {
      setBusy(false);
    }
  };

  const handleLinked = (member: Member, staff: Staff | null): void => {
    setLinkTarget(null);
    setNotice(
      staff === null
        ? `${member.name}님의 조직원 연결을 해제했습니다. 연봉과 기준 배지는 그대로입니다.`
        : `${member.name}님을 조직원 ${staff.name}(${staff.email})과 연결했습니다. 연봉은 바뀌지 않습니다 — [급여 반영]으로 가져오세요.`
    );
    void load();
  };

  const handleSalaryApplied = (member: Member, detailCount: number): void => {
    setSalaryTarget(null);
    const salary = member.annualSalary === null ? '(미입력)' : formatWon(member.annualSalary);
    setNotice(`${member.name} 연봉 ${salary} 반영 — 산출근거 ${detailCount}건 재계산`);
    // PL-10b: 산출근거 금액이 같은 트랜잭션에서 바뀌었다 — 매트릭스도 다시 그린다
    onSaved();
    void load();
  };

  // PS-6 하단 참고 줄: 연결 조직원별로 한 번씩 (같은 조직원의 행이 여럿이어도 한 줄)
  const staffRates = useMemo(() => {
    if (!data) return [];
    const seen = new Map<string, { staff: Staff; rate: StaffYearRate | null }>();
    for (const row of data.rows) {
      if (row.staff === null || seen.has(row.staff.id)) continue;
      seen.set(row.staff.id, {
        staff: row.staff,
        rate: data.otherProjectsRate === null ? null : (data.otherProjectsRate[row.staff.id] ?? null),
      });
    }
    return [...seen.values()];
  }, [data]);

  const unlinkedCount = data ? data.rows.filter((r) => r.member !== null && r.staff === null).length : 0;

  if (years.length === 0) {
    return (
      <p className="rounded-xl border border-dashed border-grey-300 bg-surface p-6 text-center text-sm text-grey-400">
        연차가 없습니다. 과제 개요에서 단계·연차를 먼저 만드세요.
      </p>
    );
  }

  return (
    <section aria-labelledby="personnel-tab-title" className="space-y-4">
      {data && (
        <PrintHeader
          title="인건비 세부"
          projectName={data.projectName}
          todayISO={data.todayISO}
          orientation="landscape"
          subtitle={`${data.year.name} · 금액 표시 단위 ${data.currencyUnit} · 월급은 표시용(연봉 ÷ 12 반올림)`}
        />
      )}

      <div className="flex flex-wrap items-center justify-between gap-3 print:hidden">
        <div className="flex flex-wrap items-center gap-3">
          <h2 id="personnel-tab-title" className="text-t5 font-bold text-grey-900">
            인건비 세부
          </h2>
          <label className="flex items-center gap-2 text-t7 text-grey-600">
            연차
            <select
              value={yearId ?? ''}
              disabled={busy}
              onChange={(e) => setYearId(e.target.value)}
              className="rounded-md border border-grey-300 px-2 py-1 text-t7 text-grey-900 focus:border-blue-500 focus:outline-none disabled:bg-grey-50"
            >
              {years.map((y) => (
                <option key={y.id} value={y.id}>
                  {y.name}
                </option>
              ))}
            </select>
          </label>
          <p className="text-t7 text-grey-500">
            참여율·참여개월·현금/현물·조정액은 칸에서 바로 고칩니다(Enter 또는 칸 벗어나면 저장). 금액은 서버가 계산합니다.
          </p>
        </div>
        <Button size="sm" onClick={() => window.print()} disabled={state.phase !== 'ready'}>
          인쇄
        </Button>
      </div>

      {notice && (
        <p
          role="status"
          className="flex items-center gap-2 rounded-lg border border-green-200 bg-green-50 px-3 py-2 text-t7 text-green-800 print:hidden"
        >
          {notice}
          <button
            type="button"
            onClick={() => setNotice(null)}
            aria-label="알림 닫기"
            className="ml-auto font-bold text-green-500 hover:text-green-700"
          >
            ×
          </button>
        </p>
      )}

      {failure && (
        <ErrorBanner message={failure.message} code={failure.code} onDismiss={() => setFailure(null)} className="print:hidden" />
      )}

      {state.phase === 'loading' && (
        <div role="status" aria-label="불러오는 중" className="rounded-xl border border-hairline bg-surface p-4">
          <SkeletonBlock className="h-4 w-full" />
          {Array.from({ length: 5 }, (_, i) => (
            <SkeletonBlock key={i} className="mt-3 h-4" />
          ))}
          <span className="sr-only">불러오는 중</span>
        </div>
      )}

      {state.phase === 'error' && (
        <ErrorBanner message={state.message} code={state.code} onRetry={() => void load()} />
      )}

      {data && (
        <>
          {data.year.startDate === null && (
            <p className="rounded-lg border border-orange-200 bg-orange-50 p-3 text-t7 text-orange-800 print:hidden">
              이 연차에 시작일이 없어 [급여 반영]의 기준일(SL-2)과 다른 과제 계상률의 기준 연도(PS-3)를 정할 수
              없습니다. 과제 개요에서 연차 시작일을 입력하세요.
            </p>
          )}

          <div className={`overflow-x-auto rounded-xl border border-grey-200 bg-surface ${PRINT_TABLE_WRAP}`}>
            <table className={`w-full min-w-[72rem] text-left text-t7 ${PRINT_TABLE}`}>
              <caption className="sr-only">
                {data.year.name} 인건비·학생인건비 산출근거. 조직원 × 월급 × 참여율 × 참여개월.
              </caption>
              <thead className="bg-grey-50 text-grey-500 print:bg-transparent print:text-black">
                <tr className="border-b border-grey-200">
                  <th className={TH}>조직원</th>
                  <th className={TH}>인력 · 직위</th>
                  <th className={TH}>채용구분</th>
                  <th className={`${TH} text-right`}>월급(표시)</th>
                  <th className={`${TH} text-right`}>연봉</th>
                  <th className={`${TH} text-right`}>참여율(%)</th>
                  <th className={`${TH} text-right`}>참여개월</th>
                  <th className={TH}>현금/현물</th>
                  <th className={`${TH} text-right`}>조정액</th>
                  <th className={`${TH} text-right`}>금액</th>
                  <th className={TH}>급여 기준</th>
                  <th className={TH}>적용 이력</th>
                  <th className={`${TH} print:hidden`}>
                    <span className="sr-only">급여 반영</span>
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-grey-100">
                {data.rows.length === 0 && (
                  <tr>
                    <td colSpan={COLUMN_COUNT} className="px-3 py-8 text-center text-grey-400">
                      이 연차에 인건비·학생인건비 산출근거가 없습니다. 매트릭스 보기에서 인건비 셀을 열어 행을 추가하세요.
                    </td>
                  </tr>
                )}
                {data.rows.map((row) => (
                  <PersonnelRow
                    // 연차를 바꾸면 같은 detail id가 없으므로 입력값이 섞이지 않는다
                    key={row.detail.id}
                    row={row}
                    currencyUnit={data.currencyUnit}
                    projectId={data.projectId}
                    yearStartDate={data.year.startDate}
                    busy={busy}
                    onSave={(patch, expectedVersion) => void handleSaveRow(row.detail.id, patch, expectedVersion)}
                    onLink={setLinkTarget}
                    onApplySalary={setSalaryTarget}
                  />
                ))}
              </tbody>
              {/* 하단 합계 — 전부 서버 값 (PL-7·PL-11). 인쇄에도 함께 나간다 */}
              <tfoot className="border-t border-grey-200 bg-grey-50 text-grey-900 print:bg-transparent">
                <tr>
                  <td colSpan={9} className="px-3 py-2 text-right font-medium text-grey-600">
                    {data.year.name} 인건비 합계 (현금 {formatAmount(data.totals.cash, data.currencyUnit)} · 현물{' '}
                    {formatAmount(data.totals.inKind, data.currencyUnit)})
                  </td>
                  <td className="px-3 py-2 text-right font-semibold tabular-nums">
                    {formatAmount(data.totals.cash + data.totals.inKind, data.currencyUnit)}
                  </td>
                  <td colSpan={3} />
                </tr>
                <tr>
                  <td colSpan={9} className="px-3 py-2 text-right font-medium text-grey-600">
                    <span title="PL-11: 인건비(연구지원인력인건비 제외) + 학생인건비, 현금 + 현물. 연구수당 한도의 기준액">
                      수정인건비 E1
                    </span>
                  </td>
                  <td className="px-3 py-2 text-right font-semibold tabular-nums">
                    {formatAmount(data.totals.e1, data.currencyUnit)}
                  </td>
                  <td colSpan={3} />
                </tr>
              </tfoot>
            </table>
          </div>

          {data.itemOnlyCategories.length > 0 && (
            <p className="text-t7 text-grey-600">
              {data.itemOnlyCategories.map((c) => BUDGET_CATEGORY_LABELS[c]).join(' · ')} 비목은 산출근거 없이 총액만
              저장되어 있어 표에는 행이 없고 합계·E1에는 들어갑니다.
            </p>
          )}

          {/* PS-6 참고 — 이 과제의 조직원별 전 과제 합계. 판정은 서버(PS-4)가 했고 여기서는 색만 고른다 */}
          <div className="rounded-xl border border-grey-200 bg-surface p-4">
            <h3 className="text-t6 font-semibold text-grey-900">
              다른 과제 포함 {data.rateYear === null ? '연도' : `${data.rateYear}년`} 계상률
              <span className="ml-2 text-t7 font-normal text-grey-500">
                연차 시작 연도 기준(PS-3) · 100% 초과는 계상 불가 ·{' '}
                <Link href="/staff" className="text-blue-600 underline underline-offset-2 print:hidden">
                  조직원 화면(/staff)
                </Link>
              </span>
            </h3>
            {data.rateYear === null ? (
              <p className="mt-2 text-t7 text-grey-500">연차 시작일이 없어 기준 연도를 정할 수 없습니다.</p>
            ) : staffRates.length === 0 ? (
              <p className="mt-2 text-t7 text-grey-500">조직원에 연결된 인력이 없습니다.</p>
            ) : (
              <ul className="mt-2 flex flex-wrap gap-x-6 gap-y-1 text-t7">
                {staffRates.map(({ staff, rate }) => (
                  <li key={staff.id} className="flex items-center gap-2">
                    <span className="text-grey-700">{staff.name}</span>
                    {rate === null ? (
                      <span className="text-grey-400" title="합산 결과에 이 조직원이 없습니다">—</span>
                    ) : (
                      <span className={`tabular-nums ${rateToneClass(rate.tone)}`}>{formatRate(rate.total)}</span>
                    )}
                  </li>
                ))}
              </ul>
            )}
            {unlinkedCount > 0 && (
              <p className="mt-2 text-t7 text-orange-700 print:text-black">
                조직원에 연결되지 않은 인건비 행 {unlinkedCount}건은 합산에 들어가지 않습니다 (PS-1).
              </p>
            )}
          </div>
        </>
      )}

      {linkTarget && <StaffLinkPicker member={linkTarget} onClose={() => setLinkTarget(null)} onLinked={handleLinked} />}

      {salaryTarget && data && (
        <SalaryApplyDialog
          memberId={salaryTarget.id}
          memberName={salaryTarget.name}
          memberVersion={salaryTarget.version}
          years={data.years}
          defaultYearId={data.year.id}
          onClose={() => setSalaryTarget(null)}
          onApplied={handleSalaryApplied}
        />
      )}

      {conflict && (
        <ConflictDialog
          message={conflict}
          // 부모의 router.refresh()는 이 탭이 client에서 받아 둔 표에 닿지 않는다.
          // 최신 값을 여기서 다시 받고, 각 행은 새 version만 받아들인다 — 입력값은 그대로다 (O-3)
          onReload={() => {
            setConflict(null);
            void load();
          }}
          onKeepEditing={() => setConflict(null)}
        />
      )}
    </section>
  );
}
