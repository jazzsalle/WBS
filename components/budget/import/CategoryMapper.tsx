'use client';

// Step 4 비목 대응표 (SOT §7.9.1 Step 4)
//  원본 비목명 → 시스템 비목. 상태 아이콘: ✅ 완전일치 / 🔵 별칭사전(부처 프리셋 포함) /
//  ⚠️ 유사매칭(확인필요) / ❌ 미매핑
//  미매핑·유사매칭은 드롭다운으로 지정(manualCategoryByRow)하거나 "이 행 건너뛰기"(skippedRowIndexes).
//
// 판정 근거는 서버 미리보기(previewImport)와 lib/import의 순수 판정 함수가 만든 값이다 —
// 이 컴포넌트는 표시와 사용자 결정 수집만 한다.

import type { BudgetCategory } from '@/types';
import { BUDGET_CATEGORY_LABELS, BUDGET_CATEGORY_ORDER } from '@/lib/constants';
import {
  MAPPING_STATUS_CLASS,
  MAPPING_STATUS_ICON,
  MAPPING_STATUS_LABEL,
  type MappingEntry,
} from './wizard-state';

export interface CategoryMapperProps {
  entries: MappingEntry[];
  manualCategoryByRow: Record<number, BudgetCategory>;
  skippedRowIndexes: number[];
  busy: boolean;
  onAssign: (rowIndex: number, category: BudgetCategory | null) => void;
  onToggleSkip: (rowIndex: number) => void;
}

export default function CategoryMapper({
  entries,
  manualCategoryByRow,
  skippedRowIndexes,
  busy,
  onAssign,
  onToggleSkip,
}: CategoryMapperProps) {
  const skipped = new Set(skippedRowIndexes);

  if (entries.length === 0) {
    return (
      <p className="rounded-xl border border-dashed border-grey-300 p-6 text-center text-sm text-grey-400">
        표시할 항목이 없습니다.
      </p>
    );
  }

  return (
    <div className="max-h-[24rem] overflow-auto rounded-xl border border-grey-200">
      <table className="w-full text-xs">
        <thead className="sticky top-0 bg-grey-50 text-grey-500">
          <tr>
            <th className="w-14 px-2 py-1.5 text-left">행</th>
            <th className="px-2 py-1.5 text-left">원본 비목명</th>
            <th className="w-44 px-2 py-1.5 text-left">상태</th>
            <th className="w-52 px-2 py-1.5 text-left">시스템 비목</th>
            <th className="w-24 px-2 py-1.5 text-left">건너뛰기</th>
          </tr>
        </thead>
        <tbody>
          {entries.map((entry) => {
            const isSkipped = skipped.has(entry.rowIndex);
            const manual = manualCategoryByRow[entry.rowIndex] ?? null;
            return (
              <tr
                key={entry.rowIndex}
                className={`border-t border-grey-100 ${
                  isSkipped
                    ? 'bg-grey-50 text-grey-400'
                    : entry.needsDecision
                      ? 'bg-orange-50/70'
                      : ''
                }`}
              >
                <td className="px-2 py-1.5 font-mono text-grey-500">{entry.rowIndex + 1}</td>
                <td className="max-w-[16rem] truncate px-2 py-1.5 text-grey-700" title={entry.label}>
                  {entry.label}
                </td>
                <td className={`px-2 py-1.5 ${MAPPING_STATUS_CLASS[entry.status]}`}>
                  <span className="mr-1">{MAPPING_STATUS_ICON[entry.status]}</span>
                  {MAPPING_STATUS_LABEL[entry.status]}
                  {entry.reason && (
                    <span className="ml-1 text-grey-400" title={entry.reason}>
                      ⓘ
                    </span>
                  )}
                </td>
                <td className="px-2 py-1.5">
                  <select
                    value={manual ?? entry.category ?? ''}
                    disabled={busy || isSkipped}
                    aria-label={`${entry.rowIndex + 1}행의 시스템 비목`}
                    onChange={(e) =>
                      onAssign(entry.rowIndex, (e.target.value || null) as BudgetCategory | null)
                    }
                    className={`w-full rounded-lg border px-2 py-1 ${
                      manual
                        ? 'border-blue-400 font-semibold text-blue-700'
                        : entry.category
                          ? 'border-grey-300 text-grey-500'
                          : 'border-red-300 text-red-700'
                    }`}
                  >
                    <option value="">— 지정 안 함 —</option>
                    {BUDGET_CATEGORY_ORDER.map((category) => (
                      <option key={category} value={category}>
                        {BUDGET_CATEGORY_LABELS[category]}
                      </option>
                    ))}
                  </select>
                </td>
                <td className="px-2 py-1.5">
                  <label className="flex cursor-pointer items-center gap-1.5 text-grey-600">
                    <input
                      type="checkbox"
                      checked={isSkipped}
                      disabled={busy}
                      onChange={() => onToggleSkip(entry.rowIndex)}
                    />
                    건너뛰기
                  </label>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
