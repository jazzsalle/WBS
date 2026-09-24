'use client';

// 조직원 목록 표 (SOT §7.18 목록, §5.20 SL-1·SL-2·SL-4)
// 현재 급여는 서버(listStaff)가 오늘 기준으로 고른 값이다 — 여기서 이력을 다시 고르거나 환산하지 않는다.
// 연봉·월급을 둘 다 적는 이유: 입력 단위(basis)가 사람마다 달라 한쪽만 보이면 비교가 안 된다(SL-1).
// 기준 배지는 급여 이력의 플래그다(SL-4) — Member 스냅샷용 salaryBasisBadge와 원천이 다르다.

import type { StaffListItem } from '@/actions/staff';
import { SALARY_BASIS_LABELS, SALARY_FLAG_LABELS } from '@/lib/constants';
import Badge from '@/components/ui/Badge';
import Button from '@/components/ui/Button';

function formatWon(amount: number): string {
  return `${amount.toLocaleString('ko-KR')}원`;
}

export interface StaffListProps {
  items: StaffListItem[];
  /** 검색어가 걸려 있어 빈 결과가 "검색 불일치"인지 "조직원 없음"인지 가른다 */
  filtered: boolean;
  selectedId: string | null;
  busy: boolean;
  onSelect: (staffId: string) => void;
  onEdit: (item: StaffListItem) => void;
  onDelete: (item: StaffListItem) => void;
}

export default function StaffList({
  items,
  filtered,
  selectedId,
  busy,
  onSelect,
  onEdit,
  onDelete,
}: StaffListProps) {
  return (
    <div className="overflow-x-auto rounded-xl border border-hairline bg-surface">
      <table className="w-full text-left text-sm">
        <thead className="bg-grey-50 text-xs text-grey-500">
          <tr className="border-b border-grey-100">
            <th className="px-4 py-2.5 font-medium">이름</th>
            <th className="px-3 py-2.5 font-medium">직위</th>
            <th className="px-3 py-2.5 font-medium">이메일</th>
            <th className="px-3 py-2.5 font-medium">재직</th>
            <th className="px-3 py-2.5 font-medium">현재 급여</th>
            <th className="px-3 py-2.5 text-right font-medium">연결 과제</th>
            <th className="px-3 py-2.5 font-medium">
              <span className="sr-only">조작</span>
            </th>
          </tr>
        </thead>
        <tbody className="divide-y divide-grey-100">
          {items.length === 0 && (
            <tr>
              <td colSpan={7} className="px-4 py-8 text-center text-grey-400">
                {filtered ? '검색과 일치하는 조직원이 없습니다.' : '등록된 조직원이 없습니다.'}
              </td>
            </tr>
          )}
          {items.map((item) => {
            const { staff, currentSalary, annualSalary, monthlyDisplay } = item;
            const selected = staff.id === selectedId;
            return (
              <tr
                key={staff.id}
                onClick={() => onSelect(staff.id)}
                aria-selected={selected}
                className={`cursor-pointer transition ${
                  selected ? 'bg-blue-50' : 'hover:bg-grey-50'
                } ${staff.employed ? '' : 'text-grey-500'}`}
              >
                <td className="px-4 py-2.5 font-medium text-grey-900">{staff.name}</td>
                <td className="px-3 py-2.5">{staff.position || '—'}</td>
                <td className="px-3 py-2.5 text-grey-600">{staff.email}</td>
                <td className="px-3 py-2.5">
                  {staff.employed ? (
                    <Badge tone="green">재직</Badge>
                  ) : (
                    <Badge tone="neutral" title="퇴사. 과제 인력의 활성 상태와는 별개입니다(HR-5)">
                      퇴사
                    </Badge>
                  )}
                </td>
                <td className="px-3 py-2.5">
                  {currentSalary === null || annualSalary === null || monthlyDisplay === null ? (
                    // SL-2: 이력이 없으면 빈 값으로 채우지 않는다 — 그 사실을 적는다
                    <span className="text-grey-400">급여 이력 없음</span>
                  ) : (
                    <div className="flex flex-col gap-1">
                      <span className="tabular-nums">
                        연봉 <span className="font-medium text-grey-900">{formatWon(annualSalary)}</span>
                        <span className="mx-1.5 text-grey-300">·</span>
                        월급 <span className="font-medium text-grey-900">{formatWon(monthlyDisplay)}</span>
                      </span>
                      <span className="flex flex-wrap items-center gap-1">
                        <Badge tone="neutral" title={`입력 단위 · 적용일 ${currentSalary.effectiveFrom}`}>
                          {SALARY_BASIS_LABELS[currentSalary.basis]} 입력
                        </Badge>
                        {currentSalary.includesRetirement && (
                          <Badge tone="blue">{SALARY_FLAG_LABELS.retirement}</Badge>
                        )}
                        {currentSalary.includesInsurance && (
                          <Badge tone="blue">{SALARY_FLAG_LABELS.insurance}</Badge>
                        )}
                      </span>
                    </div>
                  )}
                </td>
                <td className="px-3 py-2.5 text-right tabular-nums">{item.linkedProjectCount}</td>
                <td className="px-3 py-2.5" onClick={(e) => e.stopPropagation()}>
                  <div className="flex justify-end gap-1">
                    <Button size="sm" variant="ghost" disabled={busy} onClick={() => onEdit(item)}>
                      편집
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={busy}
                      onClick={() => onDelete(item)}
                      className="text-red-500 hover:bg-red-50"
                    >
                      삭제
                    </Button>
                  </div>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
