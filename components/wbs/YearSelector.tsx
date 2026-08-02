'use client';

// 연차 선택 탭 (SOT §7.4 상단, §5.4·§5.5)
// 단계가 2개 이상이면 단계 > 연차 2단 셀렉터. "전체 연차 보기"를 고르면 여러 연차가 한 화면에
// 섞이므로 WBS 코드에 연차 접두('1차-1.2')가 붙는다 — 접두는 서버가 계산해 내려준다 (§6.7).
// 선택 상태는 URL(?yearId=)에 둔다. 데이터 로딩은 서버 컴포넌트가 하므로 선택이 곧 재요청이다.

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import type { Stage, Year } from '@/types';

export const ALL_YEARS = 'all';

export interface YearSelectorProps {
  projectId: string;
  stages: Stage[];
  years: Year[];
  /** 'all'이면 전체 연차 보기 */
  selectedYearId: string | typeof ALL_YEARS;
  disabled?: boolean;
}

function yearLabel(year: Year): string {
  return year.name.trim() || `${year.order + 1}차년도`;
}

function stageLabel(stage: Stage): string {
  return stage.name.trim() || `${stage.order + 1}단계`;
}

export default function YearSelector({
  projectId,
  stages,
  years,
  selectedYearId,
  disabled = false,
}: YearSelectorProps) {
  const router = useRouter();
  const twoLevel = stages.length >= 2;

  const selectedYear = years.find((y) => y.id === selectedYearId) ?? null;
  const [stageId, setStageId] = useState<string>(
    () => selectedYear?.stageId ?? stages[0]?.id ?? ''
  );

  // 다른 단계의 연차로 이동하면(개요 화면 링크 등) 단계 셀렉터도 따라간다
  useEffect(() => {
    if (selectedYear) setStageId(selectedYear.stageId);
  }, [selectedYear]);

  const go = (value: string): void => {
    router.push(`/projects/${projectId}/wbs?yearId=${value}`);
  };

  const visibleYears = twoLevel ? years.filter((y) => y.stageId === stageId) : years;

  return (
    <div className="flex flex-wrap items-center gap-2">
      {twoLevel && (
        <label className="flex items-center gap-2 text-sm text-slate-600">
          단계
          <select
            value={stageId}
            disabled={disabled}
            onChange={(e) => setStageId(e.target.value)}
            className="rounded-lg border border-slate-300 bg-white px-2.5 py-1.5 text-sm focus:border-slate-500 focus:outline-none"
          >
            {stages.map((stage) => (
              <option key={stage.id} value={stage.id}>
                {stageLabel(stage)}
              </option>
            ))}
          </select>
        </label>
      )}

      <div className="flex flex-wrap items-center gap-1" role="tablist" aria-label="연차 선택">
        {visibleYears.map((year) => {
          const active = year.id === selectedYearId;
          return (
            <button
              key={year.id}
              type="button"
              role="tab"
              aria-selected={active}
              disabled={disabled}
              onClick={() => go(year.id)}
              className={`rounded-lg px-3 py-1.5 text-sm font-semibold transition ${
                active
                  ? 'bg-slate-900 text-white'
                  : 'border border-slate-300 bg-white text-slate-700 hover:bg-slate-50'
              }`}
            >
              {yearLabel(year)}
            </button>
          );
        })}

        <button
          type="button"
          role="tab"
          aria-selected={selectedYearId === ALL_YEARS}
          disabled={disabled}
          onClick={() => go(ALL_YEARS)}
          title="모든 연차를 한 화면에서 봅니다. WBS 코드에 연차 접두가 붙습니다"
          className={`rounded-lg px-3 py-1.5 text-sm font-semibold transition ${
            selectedYearId === ALL_YEARS
              ? 'bg-slate-900 text-white'
              : 'border border-dashed border-slate-300 bg-white text-slate-600 hover:bg-slate-50'
          }`}
        >
          전체 연차 보기
        </button>
      </div>
    </div>
  );
}
