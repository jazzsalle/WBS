'use client';

// Step 3 — 열 매핑 (SOT §7.9.1)
//  - 좌: 엑셀 열 목록 (열 문자 + 헤더 텍스트 + 샘플값 3개)
//  - 라벨 열 지정 (S-3 다중 라벨 열 범위, 자동 추정 하이라이트)
//  - 연차 열 매핑: 연차로 감지된 열마다 "이 열 = N차년도" 드롭다운 (S-5)
//    자동 추정은 `N차년도` 라벨 → order = N-1 인 Year.
//    **미대응 연차 열이 남아 있으면 다음 단계로 갈 수 없다** (판정은 ImportWizard가 한다)
//  - 자동 추정된 매핑은 회색, 사용자가 바꾼 것은 파랑

import type { SheetColumnInfo } from '@/types';
import type { YearColumn } from '@/lib/import';
import type { WizardYear } from './wizard-state';

/** 연차 열을 아예 쓰지 않겠다는 명시적 선택. 빈 값(미지정)과 구분한다 */
export const EXCLUDE_VALUE = '__exclude__';

export interface Step3ColumnsProps {
  columns: SheetColumnInfo[];
  /** 감지된 연차 열 전부 (제외한 것도 목록에는 남긴다) */
  detectedYearColumns: YearColumn[];
  /** 이번 반영에 쓰는 연차 열 (제외한 열은 빠져 있다) */
  includedYearColumns: { column: string; yearOrder: number }[];
  labelColumns: string[];
  labelColumnsTouched: boolean;
  yearMapping: Record<string, string>;
  touchedYearColumns: string[];
  years: WizardYear[];
  busy: boolean;
  onToggleLabelColumn: (column: string) => void;
  onResetLabelColumns: () => void;
  onYearColumnChange: (column: string, value: string) => void;
}

export default function Step3Columns({
  columns,
  detectedYearColumns,
  includedYearColumns,
  labelColumns,
  labelColumnsTouched,
  yearMapping,
  touchedYearColumns,
  years,
  busy,
  onToggleLabelColumn,
  onResetLabelColumns,
  onYearColumnChange,
}: Step3ColumnsProps) {
  const labelSet = new Set(labelColumns);
  const includedSet = new Set(includedYearColumns.map((y) => y.column));
  const touchedSet = new Set(touchedYearColumns);
  const yearColumnSet = new Set(detectedYearColumns.map((y) => y.column));

  return (
    <div className="grid gap-4 lg:grid-cols-2">
      {/* 좌: 엑셀 열 목록 + 라벨 열 지정 */}
      <section className="space-y-2">
        <div className="flex items-baseline justify-between">
          <h3 className="text-sm font-semibold text-grey-700">엑셀 열 · 라벨 열 지정 (S-3)</h3>
          <button
            type="button"
            disabled={busy || !labelColumnsTouched}
            onClick={onResetLabelColumns}
            className="text-xs text-grey-500 underline disabled:cursor-not-allowed disabled:opacity-40"
          >
            자동 추정으로 되돌리기
          </button>
        </div>
        <p className="text-xs text-grey-500">
          비목·세목·현금/현물 라벨이 들어 있는 열을 전부 고르세요. 판정은 오른쪽 열이 우선입니다
          (가장 구체적인 라벨).{' '}
          <span className={labelColumnsTouched ? 'text-blue-600' : 'text-grey-400'}>
            {labelColumnsTouched ? '사용자가 수정함' : '자동 추정 상태'}
          </span>
        </p>

        <div className="max-h-[24rem] overflow-auto rounded-xl border border-grey-200">
          <table className="w-full text-xs">
            <thead className="sticky top-0 bg-grey-50 text-grey-500">
              <tr>
                <th className="w-16 px-2 py-1.5 text-left">라벨</th>
                <th className="w-12 px-2 py-1.5 text-left">열</th>
                <th className="px-2 py-1.5 text-left">헤더 텍스트</th>
                <th className="px-2 py-1.5 text-left">샘플값 3개</th>
              </tr>
            </thead>
            <tbody>
              {columns.map((column) => {
                const isYear = yearColumnSet.has(column.column);
                return (
                  <tr
                    key={column.column}
                    className={`border-t border-grey-100 ${
                      labelSet.has(column.column) ? 'bg-orange-50' : isYear ? 'bg-purple-50/60' : ''
                    }`}
                  >
                    <td className="px-2 py-1.5">
                      <input
                        type="checkbox"
                        checked={labelSet.has(column.column)}
                        disabled={busy}
                        aria-label={`${column.column}열을 라벨 열로 지정`}
                        onChange={() => onToggleLabelColumn(column.column)}
                      />
                    </td>
                    <td className="px-2 py-1.5 font-mono font-semibold text-grey-700">
                      {column.column}
                      {isYear && <span className="ml-1 text-[10px] text-purple-600">연차</span>}
                    </td>
                    <td className="max-w-[10rem] truncate px-2 py-1.5 text-grey-700" title={column.headerText}>
                      {column.headerText || <span className="text-grey-300">(비어 있음)</span>}
                    </td>
                    <td className="max-w-[14rem] truncate px-2 py-1.5 text-grey-500" title={column.samples.join(' / ')}>
                      {column.samples.join(' / ') || <span className="text-grey-300">(없음)</span>}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </section>

      {/* 우: 연차 열 매핑 (S-5) */}
      <section className="space-y-2">
        <h3 className="text-sm font-semibold text-grey-700">연차 열 매핑 (S-5)</h3>
        <p className="text-xs text-grey-500">
          연차로 감지된 열마다 이 과제의 어느 연차인지 지정하세요.{' '}
          <span className="text-grey-400">회색 = 자동 추정</span> ·{' '}
          <span className="text-blue-600">파랑 = 사용자 지정</span>. 미지정 열이 하나라도 남으면 다음
          단계로 갈 수 없습니다.
        </p>

        {detectedYearColumns.length === 0 ? (
          <p className="rounded-xl border border-dashed border-red-300 bg-red-50 p-4 text-xs text-red-700">
            연차 열(`N차년도`)을 찾지 못했습니다. Step 2로 돌아가 헤더 행을 다시 지정하세요.
          </p>
        ) : (
          <ul className="space-y-1.5">
            {detectedYearColumns.map((column) => {
              const excluded = !includedSet.has(column.column);
              const value = excluded ? EXCLUDE_VALUE : (yearMapping[column.column] ?? '');
              const touched = touchedSet.has(column.column);
              const unresolved = !excluded && value === '';
              return (
                <li
                  key={column.column}
                  className={`flex items-center gap-3 rounded-lg border px-3 py-2 text-xs ${
                    unresolved ? 'border-red-300 bg-red-50' : 'border-grey-200'
                  }`}
                >
                  <span className="w-10 shrink-0 font-mono font-semibold text-grey-700">
                    {column.column}
                  </span>
                  <span className="min-w-0 flex-1 truncate text-grey-600" title={column.label}>
                    {column.label}
                    <span className="ml-1 text-grey-400">(추정 {column.yearOrder + 1}차년도)</span>
                  </span>
                  <select
                    value={value}
                    disabled={busy}
                    aria-label={`${column.column}열의 연차`}
                    onChange={(e) => onYearColumnChange(column.column, e.target.value)}
                    className={`rounded-lg border px-2 py-1 ${
                      touched
                        ? 'border-blue-400 font-semibold text-blue-700'
                        : 'border-grey-300 text-grey-500'
                    }`}
                  >
                    <option value="">— 미지정 —</option>
                    {years.map((year) => (
                      <option key={year.id} value={year.id}>
                        {year.order + 1}차년도 · {year.name}
                      </option>
                    ))}
                    <option value={EXCLUDE_VALUE}>이 열 사용 안 함</option>
                  </select>
                </li>
              );
            })}
          </ul>
        )}

        {years.length === 0 && (
          <p className="rounded-lg bg-red-50 px-3 py-2 text-xs text-red-700">
            이 과제에 연차가 없습니다. 과제 개요에서 단계·연차를 먼저 만드세요.
          </p>
        )}
      </section>
    </div>
  );
}
