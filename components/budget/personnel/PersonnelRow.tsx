'use client';

// [인건비] 탭의 행 하나 (SOT §7.9.6, §5.11 스냅샷, §6.10 PL-1·PL-2·PL-D7, §8.4 O-1·O-3)
//
//  - **금액·월급은 서버 값이다.** 이 파일에 곱셈·나눗셈이 없다 — `annualSalary`를 여기서 곱하면
//    서버와 1원씩 어긋난다(PL-2 월액 선반올림 함정). 손으로 맞추고 싶으면 `조정액`을 쓴다.
//  - 참여율·참여개월·축·조정액만 **인라인 편집**한다. 칸을 떠나거나(blur) Enter를 치면 저장이다 —
//    값이 그대로면 저장하지 않는다. 인자는 DetailRowEditor.splitPersonnelFactors와 **같은 규칙**으로
//    쪼개고 되붙인다: 첫 %가 참여율, 첫 비%가 개월, 나머지는 그대로 보존(라벨도 저장된 것을 이어 쓴다).
//  - O-3: 남이 먼저 저장해 version이 올라오면 입력값을 덮어쓰지 않고 "최신 값 사용"만 띄운다.
//  - [급여 반영]은 연결된 조직원이 있을 때만. 미연결이면 그 자리에 "조직원 연결" 링크(§7.10).
//
// 쓰기는 부모(PersonnelTab)가 actions/budget-plan.ts의 updateBudgetDetail로 보낸다. 여기서는 patch만 만든다.

import { useEffect, useState, type KeyboardEvent } from 'react';
import Link from 'next/link';
import type { DetailAxis, DetailFactor, Member, Settings } from '@/types';
import type { PersonnelTabRow, StaffYearRate } from '@/actions/budget-plan';
import { PARTICIPATION_FACTOR_LABEL } from '@/lib/budget-plan';
import { DETAIL_AXIS_LABELS, HIRE_TYPE_LABELS, SALARY_FLAG_LABELS } from '@/lib/constants';
import { formatAmount } from '@/lib/currency';
import { splitPersonnelFactors } from '@/components/budget/DetailRowEditor';
import Badge from '@/components/ui/Badge';
import Button from '@/components/ui/Button';
import { PRINT_TD } from '@/components/print/tokens';

const DETAIL_AXES: readonly DetailAxis[] = ['cash', 'in_kind'];
const DEFAULT_MONTHS_LABEL = '참여기간(월)';

/** updateBudgetDetail에 보내는 부분 patch. **`amount`가 없다** — 금액은 서버가 다시 계산한다 (PL-D7) */
export interface PersonnelRowPatch {
  axis?: DetailAxis;
  factors?: DetailFactor[];
  adjustment?: number;
}

export interface PersonnelRowProps {
  row: PersonnelTabRow;
  currencyUnit: Settings['currencyUnit'];
  projectId: string;
  /** null이면 기준일이 없어 [급여 반영]을 열 수 없다 (SL-2) */
  yearStartDate: string | null;
  busy: boolean;
  onSave: (patch: PersonnelRowPatch, expectedVersion: number) => void;
  onLink: (member: Member) => void;
  onApplySalary: (member: Member) => void;
}

const CELL_INPUT =
  'w-full rounded-md border border-grey-300 px-2 py-1 text-right text-t7 tabular-nums focus:border-blue-500 focus:outline-none focus:ring-2 focus:ring-blue-100 disabled:bg-grey-50 print:hidden';
const TD = `px-3 py-2 align-top ${PRINT_TD}`;

// PL-3·PL-D5: 인자 값은 소수를 허용하되 음수는 금액을 뒤집으므로 막는다
function parseFactorValue(draft: string): number | null {
  const value = Number(draft.trim());
  if (!Number.isFinite(value) || value < 0) return null;
  return value;
}

// 조정액은 원 단위 정수, 음수 허용 (PL-D5의 유일한 예외). 빈 칸은 0
function parseWon(draft: string): number | null {
  const trimmed = draft.trim();
  if (trimmed === '') return 0;
  const value = Number(trimmed);
  return Number.isInteger(value) ? value : null;
}

/** PS-4 톤 → 부록 E 색 (PersonnelTab 하단 PS-6 참고 줄이 쓴다). 인쇄에서는 검정 — 색으로만 구분되는 정보는 흑백에서도 읽혀야 한다(P-R5) */
export function rateToneClass(tone: StaffYearRate['tone']): string {
  if (tone === 'error') return 'font-semibold text-red-600 print:text-black';
  if (tone === 'warn') return 'font-semibold text-orange-700 print:text-black';
  return 'text-grey-700 print:text-black';
}

export function formatRate(total: number): string {
  return `${(Math.round(total * 10) / 10 + 0).toFixed(1)}%`; // 표시만 1자리 — 판정은 서버가 원값으로 했다
}

export default function PersonnelRow({
  row,
  currencyUnit,
  projectId,
  yearStartDate,
  busy,
  onSave,
  onLink,
  onApplySalary,
}: PersonnelRowProps) {
  const { detail, member, staff } = row;

  // 입력값. 서버가 준 참여율·개월(PL-1이 읽는 것과 같은 인자)을 초기값으로 쓴다
  const [rateDraft, setRateDraft] = useState(String(row.participation));
  const [monthsDraft, setMonthsDraft] = useState(String(row.months));
  const [adjustmentDraft, setAdjustmentDraft] = useState(String(detail.adjustment));
  const [message, setMessage] = useState<string | null>(null);

  // O-1: 마지막으로 받아들인 서버 version. 저장의 expectedVersion이 여기서만 나온다
  const [baselineVersion, setBaselineVersion] = useState(detail.version);
  const [refreshed, setRefreshed] = useState(false);
  useEffect(() => {
    if (detail.version === baselineVersion) return;
    // 새 version이 다음 저장의 조건이 된다. 입력값은 건드리지 않는다 (O-3)
    setBaselineVersion(detail.version);
    setRefreshed(true);
  }, [detail.version, baselineVersion]);

  const useLatest = (): void => {
    setRateDraft(String(row.participation));
    setMonthsDraft(String(row.months));
    setAdjustmentDraft(String(detail.adjustment));
    setRefreshed(false);
    setMessage(null);
  };

  // 참여율·개월 두 칸 → factors 하나. 라벨은 저장된 것을 이어 쓰고, 여분 인자는 그대로 보존한다
  const buildFactors = (rate: number, months: number): DetailFactor[] => {
    const split = splitPersonnelFactors(detail.factors);
    return [
      { label: split.percent?.label ?? PARTICIPATION_FACTOR_LABEL, value: rate, isPercent: true },
      { label: split.count?.label ?? DEFAULT_MONTHS_LABEL, value: months, isPercent: false },
      ...split.extra,
    ];
  };

  const commitFactors = (): void => {
    const rate = parseFactorValue(rateDraft);
    if (rate === null) {
      setMessage('참여율은 0 이상 숫자로 입력하세요.');
      return;
    }
    const months = parseFactorValue(monthsDraft);
    if (months === null) {
      setMessage('참여개월은 0 이상 숫자로 입력하세요.');
      return;
    }
    setMessage(null);
    if (rate === row.participation && months === row.months) return;
    onSave({ factors: buildFactors(rate, months) }, baselineVersion);
  };

  const commitAdjustment = (): void => {
    const adjustment = parseWon(adjustmentDraft);
    if (adjustment === null) {
      setMessage('조정액은 원 단위 정수로 입력하세요 (음수 허용).');
      return;
    }
    setMessage(null);
    if (adjustment === detail.adjustment) return;
    onSave({ adjustment }, baselineVersion);
  };

  const commitAxis = (axis: DetailAxis): void => {
    if (axis === detail.axis) return;
    onSave({ axis }, baselineVersion);
  };

  const onEnter = (commit: () => void) => (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      commit();
    }
  };

  const disabled = busy;
  const canApply = staff !== null && member !== null && yearStartDate !== null;
  // PL-5: 음수는 0으로 자르지 않는다. 조정액을 잘못 넣은 것이지 0원짜리 행이 아니다
  const rowTone = row.negative ? 'bg-red-50' : row.missingSalary ? 'bg-orange-50/60' : '';

  return (
    <>
      <tr className={`break-inside-avoid ${rowTone}`}>
        {/* 조직원 — 연결됨 이름 / 연결 링크 (§7.10) */}
        <td className={TD}>
          {staff ? (
            <div className="flex flex-wrap items-center gap-1">
              <span className="font-medium text-grey-900">{staff.name}</span>
              {!staff.employed && <Badge tone="amber">퇴사</Badge>}
              {member && (
                <button
                  type="button"
                  disabled={disabled}
                  onClick={() => onLink(member)}
                  className="text-t7 text-grey-500 underline underline-offset-2 hover:text-grey-700 disabled:opacity-50 print:hidden"
                >
                  변경
                </button>
              )}
            </div>
          ) : member ? (
            <>
              <button
                type="button"
                disabled={disabled}
                onClick={() => onLink(member)}
                className="text-t7 font-semibold text-blue-600 underline underline-offset-2 hover:text-blue-700 disabled:opacity-50 print:hidden"
              >
                조직원 연결
              </button>
              <span className="hidden text-grey-500 print:inline">미연결</span>
            </>
          ) : (
            <span className="text-grey-400">—</span>
          )}
        </td>

        {/* 인력명·직위 — 정의는 인력 화면 한 곳이다 (§5.11) */}
        <td className={TD}>
          {member ? (
            <>
              <span className="font-medium text-grey-900">{member.name}</span>
              {member.position !== '' && <span className="ml-1 text-grey-500">{member.position}</span>}
              {!member.active && (
                <Badge tone="neutral" className="ml-1">
                  종료
                </Badge>
              )}
            </>
          ) : (
            <span className="font-semibold text-red-600">인력을 찾지 못함</span>
          )}
        </td>

        <td className={TD}>
          {member &&
            (member.hireType === 'new' ? (
              <Badge tone="blue">{HIRE_TYPE_LABELS.new}</Badge>
            ) : (
              <span className="text-grey-600">{HIRE_TYPE_LABELS.existing}</span>
            ))}
        </td>

        {/* 월급 — 표시 전용(SL-1·PL-2). 산식에 넣지 않는다 */}
        <td className={`${TD} text-right tabular-nums text-grey-600`}>
          {row.monthlyDisplay === null ? '—' : formatAmount(row.monthlyDisplay, currencyUnit)}
        </td>

        <td className={`${TD} text-right tabular-nums`}>
          {member === null || member.annualSalary === null ? (
            <span className="font-semibold text-orange-700 print:text-black">연봉 미입력</span>
          ) : (
            <span className="text-grey-900">{formatAmount(member.annualSalary, currencyUnit)}</span>
          )}
        </td>

        {/* 참여율(%) */}
        <td className={`${TD} w-24`}>
          <input
            type="text"
            inputMode="decimal"
            value={rateDraft}
            disabled={disabled}
            aria-label="참여율(%)"
            onChange={(e) => setRateDraft(e.target.value)}
            onBlur={commitFactors}
            onKeyDown={onEnter(commitFactors)}
            className={CELL_INPUT}
          />
          <span className="hidden tabular-nums print:inline">{row.participation}</span>
        </td>

        {/* 참여개월 */}
        <td className={`${TD} w-20`}>
          <input
            type="text"
            inputMode="decimal"
            value={monthsDraft}
            disabled={disabled}
            aria-label="참여개월"
            onChange={(e) => setMonthsDraft(e.target.value)}
            onBlur={commitFactors}
            onKeyDown={onEnter(commitFactors)}
            className={CELL_INPUT}
          />
          <span className="hidden tabular-nums print:inline">{row.months}</span>
        </td>

        {/* 축 — 바꾸는 즉시 저장 (칸 하나짜리 선택) */}
        <td className={`${TD} w-20`}>
          <select
            value={detail.axis}
            disabled={disabled}
            aria-label="현금/현물"
            onChange={(e) => commitAxis(e.target.value as DetailAxis)}
            className="w-full rounded-md border border-grey-300 px-1 py-1 text-t7 focus:border-blue-500 focus:outline-none disabled:bg-grey-50 print:hidden"
          >
            {DETAIL_AXES.map((axis) => (
              <option key={axis} value={axis}>
                {DETAIL_AXIS_LABELS[axis]}
              </option>
            ))}
          </select>
          <span className="hidden print:inline">{DETAIL_AXIS_LABELS[detail.axis]}</span>
        </td>

        {/* 조정액 */}
        <td className={`${TD} w-28`}>
          <input
            type="text"
            inputMode="numeric"
            value={adjustmentDraft}
            disabled={disabled}
            aria-label="조정액"
            onChange={(e) => setAdjustmentDraft(e.target.value)}
            onBlur={commitAdjustment}
            onKeyDown={onEnter(commitAdjustment)}
            className={CELL_INPUT}
          />
          <span className="hidden tabular-nums print:inline">{detail.adjustment.toLocaleString('ko-KR')}</span>
        </td>

        {/* 금액 — 읽기 전용, 서버 값 (PL-D7) */}
        <td className={`${TD} text-right tabular-nums`}>
          {row.missingSalary ? (
            <span
              className="font-semibold text-orange-700 print:text-black"
              title="연봉이 없어 0원으로 처리된 행입니다. 인력 화면에서 연봉을 입력하거나 [급여 반영]을 누르세요"
            >
              연봉 미입력
            </span>
          ) : (
            <span className={row.negative ? 'font-semibold text-red-600 print:text-black' : 'font-semibold text-grey-900'}>
              {formatAmount(row.amount, currencyUnit)}
            </span>
          )}
        </td>

        {/* 급여 기준 — §5.11 스냅샷 배지 */}
        <td className={TD}>
          <div className="flex flex-wrap gap-1">
            {row.basisBadge.labels.map((label) => (
              <Badge key={label} tone={label === SALARY_FLAG_LABELS.none ? 'neutral' : 'blue'}>
                {label}
              </Badge>
            ))}
            {row.basisBadge.labels.length === 0 && <Badge tone="neutral">포함 없음</Badge>}
          </div>
        </td>

        <td className={`${TD} tabular-nums text-grey-600`}>{row.appliedFrom ?? '—'}</td>

        <td className={`${TD} print:hidden`}>
          {member && staff && (
            <Button
              size="sm"
              variant="secondary"
              disabled={disabled || !canApply}
              title={
                yearStartDate === null
                  ? '이 연차에 시작일이 없어 기준일을 정할 수 없습니다. 과제 개요에서 연차 시작일을 먼저 입력하세요 (SL-2)'
                  : '조직원 급여 이력에서 이 연차 시작일 기준 급여를 골라 반영합니다 (§7.10)'
              }
              onClick={() => onApplySalary(member)}
            >
              급여 반영
            </Button>
          )}
        </td>
      </tr>

      {(message !== null || refreshed) && (
        <tr className="print:hidden">
          <td colSpan={13} className="px-3 pb-2 pt-0">
            {message !== null && <p className="text-t7 text-red-600">{message}</p>}
            {refreshed && (
              <p className="flex flex-wrap items-center gap-2 text-t7 text-orange-700">
                다른 사람이 이 행을 먼저 저장했습니다. 입력한 값은 그대로입니다.
                <Button size="sm" onClick={useLatest}>
                  최신 값 사용
                </Button>
              </p>
            )}
          </td>
        </tr>
      )}

      {member === null && (
        <tr className="print:hidden">
          <td colSpan={13} className="px-3 pb-2 pt-0 text-t7 text-red-600">
            이 행이 가리키는 인력을 이 과제의 인력 목록에서 찾지 못했습니다.{' '}
            <Link href={`/projects/${projectId}/team`} className="underline underline-offset-2">
              인력 화면
            </Link>
            에서 확인하세요.
          </td>
        </tr>
      )}
    </>
  );
}
