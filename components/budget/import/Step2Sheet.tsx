'use client';

// Step 2 — 시트 & 범위 (SOT §7.9.1)
//  - 시트 탭 + 원본 미리보기 그리드(상위 30행). S-13 추천 시트를 **하이라이트**하되 확정은 사용자가 한다
//  - 헤더 행을 클릭으로 지정 (자동 추정값을 흐린 하이라이트로 함께 제시)
//  - 데이터 시작 행 지정
//  - 감지 결과(방향·라벨 열 범위·추정 금액 단위)를 모두 보여주고 수정 가능하게 한다
//
// I-10: 금액 단위는 **자동 확정하지 않는다.** 1000배 오류는 치명적이라 사용자가 확인 체크를 해야 넘어간다.

import type { AmountUnit, AnalyzeSheetResult, InspectWorkbookResult, SheetGridPreview } from '@/types';
import Badge from '@/components/ui/Badge';
import Button from '@/components/ui/Button';
import SheetGrid, { type PickTarget } from './SheetGrid';

const AMOUNT_UNIT_OPTIONS: { value: AmountUnit; label: string }[] = [
  { value: 1, label: '원 (×1)' },
  { value: 1000, label: '천원 (×1,000)' },
  { value: 1_000_000, label: '백만원 (×1,000,000)' },
];

export interface Step2SheetProps {
  inspect: InspectWorkbookResult;
  analysis: AnalyzeSheetResult | null;
  grid: SheetGridPreview | null;
  sheetName: string | null;
  headerRow: number;
  dataStartRow: number;
  orientation: 'row' | 'column';
  amountUnit: AmountUnit;
  unitConfirmed: boolean;
  busy: boolean;
  pickTarget: PickTarget;
  onPickTargetChange: (target: PickTarget) => void;
  onSelectSheet: (sheetName: string) => void;
  onPickRow: (rowIndex: number) => void;
  onHeaderRowChange: (row: number) => void;
  onDataStartRowChange: (row: number) => void;
  onOrientationChange: (orientation: 'row' | 'column') => void;
  onAmountUnitChange: (unit: AmountUnit) => void;
  onUnitConfirmedChange: (confirmed: boolean) => void;
  onReanalyze: () => void;
}

export default function Step2Sheet({
  inspect,
  analysis,
  grid,
  sheetName,
  headerRow,
  dataStartRow,
  orientation,
  amountUnit,
  unitConfirmed,
  busy,
  pickTarget,
  onPickTargetChange,
  onSelectSheet,
  onPickRow,
  onHeaderRowChange,
  onDataStartRowChange,
  onOrientationChange,
  onAmountUnitChange,
  onUnitConfirmedChange,
  onReanalyze,
}: Step2SheetProps) {
  const structure = analysis?.structure ?? null;
  const hint = structure?.amountUnitHint ?? null;

  return (
    <div className="space-y-4">
      {/* 시트 탭 — S-13 추천은 하이라이트일 뿐이고 확정은 사용자가 한다 */}
      <div className="flex flex-wrap gap-1.5">
        {inspect.sheets.map((sheet) => {
          const selected = sheet.name === sheetName;
          const recommended = sheet.name === inspect.recommendedSheet;
          return (
            <button
              key={sheet.name}
              type="button"
              disabled={busy}
              onClick={() => onSelectSheet(sheet.name)}
              title={`비목 판정 ${sheet.categoryRows}행 / 비어있지 않은 ${sheet.nonEmptyRows}행 · N차년도 헤더 ${sheet.yearHeaderCount}개${
                sheet.eligible ? '' : ' · 연차 열이 2개 미만이라 추천 후보가 아닙니다'
              }`}
              className={`rounded-lg border px-3 py-1.5 text-xs font-medium transition disabled:opacity-50 ${
                selected
                  ? 'border-grey-900 bg-grey-900 text-surface'
                  : recommended
                    ? 'border-green-400 bg-green-50 text-green-800'
                    : 'border-grey-200 bg-surface text-grey-600 hover:bg-grey-50'
              }`}
            >
              {sheet.name}
              {recommended && <span className="ml-1.5">★</span>}
              <span className={`ml-1.5 ${selected ? 'text-grey-300' : 'text-grey-400'}`}>
                {(sheet.score * 100).toFixed(0)}%
              </span>
            </button>
          );
        })}
      </div>
      {inspect.recommendedSheet && (
        <p className="text-xs text-grey-500">
          ★ <strong>{inspect.recommendedSheet}</strong> 시트가 비목 매칭 밀도(S-13)가 가장 높습니다.
          추천일 뿐이니 실제 총괄표 시트를 직접 확인하고 고르세요.
        </p>
      )}

      {/* 행 지정 대상 전환 */}
      <div className="flex flex-wrap items-center gap-3 rounded-xl border border-grey-200 bg-grey-50 px-3 py-2 text-xs">
        <span className="font-semibold text-grey-700">그리드 행 클릭 시 지정할 대상</span>
        {(
          [
            { value: 'header', label: '헤더 행' },
            { value: 'dataStart', label: '데이터 시작 행' },
          ] as const
        ).map((option) => (
          <label key={option.value} className="flex cursor-pointer items-center gap-1.5">
            <input
              type="radio"
              name="pick-target"
              checked={pickTarget === option.value}
              onChange={() => onPickTargetChange(option.value)}
            />
            {option.label}
          </label>
        ))}
        <span className="ml-auto text-grey-500">
          헤더 행을 바꾸면 연차 열·라벨 열을 다시 감지합니다.
        </span>
      </div>

      {grid ? (
        <SheetGrid
          grid={grid}
          headerRow={headerRow}
          suggestedHeaderRow={structure?.headerRow ?? null}
          dataStartRow={dataStartRow}
          labelColumnIndexes={structure?.labelColumnIndexes ?? []}
          yearColumnIndexes={(structure?.yearColumns ?? []).map((y) => y.columnIndex)}
          totalColumnIndexes={(structure?.totalColumns ?? []).map((t) => t.columnIndex)}
          pickTarget={pickTarget}
          onPickRow={onPickRow}
          disabled={busy}
        />
      ) : (
        <p className="rounded-xl border border-dashed border-grey-300 p-6 text-center text-sm text-grey-400">
          시트를 선택하면 원본 미리보기가 표시됩니다.
        </p>
      )}

      {/* 감지 결과 — 전부 제안이고 사용자가 확인·수정한다 (§6.8 대원칙) */}
      <section className="grid gap-3 sm:grid-cols-2">
        <div className="space-y-3 rounded-xl border border-grey-200 p-3">
          <h3 className="text-sm font-semibold text-grey-700">범위</h3>
          <label className="flex items-center justify-between gap-2 text-xs text-grey-600">
            헤더 행 (1-based)
            <input
              type="number"
              min={1}
              value={headerRow + 1}
              disabled={busy}
              onChange={(e) => onHeaderRowChange(Math.max(0, Number(e.target.value) - 1))}
              className="w-24 rounded-lg border border-grey-300 px-2 py-1 text-right"
            />
          </label>
          <label className="flex items-center justify-between gap-2 text-xs text-grey-600">
            데이터 시작 행 (1-based)
            <input
              type="number"
              min={1}
              value={dataStartRow + 1}
              disabled={busy}
              onChange={(e) => onDataStartRowChange(Math.max(0, Number(e.target.value) - 1))}
              className="w-24 rounded-lg border border-grey-300 px-2 py-1 text-right"
            />
          </label>
          <p className="text-[11px] text-grey-400">
            데이터 끝 행은 지정하지 않습니다 — 시트 끝까지 읽고, 표 아래 잔여 행은
            <span className="mx-1 font-medium">건너뜀(라벨 없음)</span>으로 미리보기에 남습니다.
          </p>
          <Button size="sm" variant="secondary" disabled={busy} onClick={onReanalyze}>
            이 범위로 다시 감지
          </Button>
        </div>

        <div className="space-y-3 rounded-xl border border-grey-200 p-3">
          <h3 className="text-sm font-semibold text-grey-700">감지 결과</h3>
          <label className="flex items-center justify-between gap-2 text-xs text-grey-600">
            방향 (비목 위치)
            <select
              value={orientation}
              disabled={busy}
              onChange={(e) => onOrientationChange(e.target.value as 'row' | 'column')}
              className="rounded-lg border border-grey-300 px-2 py-1"
            >
              <option value="row">비목이 행 (row)</option>
              <option value="column">비목이 열 (column)</option>
            </select>
          </label>
          {orientation === 'column' && (
            <p className="rounded-lg bg-red-50 px-2 py-1.5 text-[11px] text-red-700">
              비목이 열에 있는 서식(전치 매트릭스)은 v1에서 반영할 수 없습니다 (S-1). 비목이 행에
              오도록 정리한 뒤 다시 올려주세요.
            </p>
          )}

          <div className="text-xs text-grey-600">
            <p>
              라벨 열 범위:{' '}
              <span className="font-mono font-semibold">
                {(structure?.labelColumns ?? []).join(', ') || '(감지되지 않음)'}
              </span>
              <span className="ml-1 text-grey-400">— Step 3에서 수정</span>
            </p>
            <p className="mt-1">
              연차 열:{' '}
              {(structure?.yearColumns ?? []).length === 0 ? (
                <span className="text-red-600">감지되지 않음</span>
              ) : (
                (structure?.yearColumns ?? []).map((y) => (
                  <Badge key={y.column} tone="violet" className="mr-1">
                    {y.column} · {y.label}
                  </Badge>
                ))
              )}
            </p>
            {(structure?.totalColumns ?? []).length > 0 && (
              <p className="mt-1 text-grey-500">
                합계 열(자동 제외):{' '}
                {(structure?.totalColumns ?? []).map((t) => `${t.column}(${t.label})`).join(', ')}
              </p>
            )}
            {structure && !structure.rowLimit.ok && (
              <p className="mt-1 font-semibold text-red-600">
                {structure.rowCount.toLocaleString()}행으로 상한{' '}
                {structure.rowLimit.limit.toLocaleString()}행을 넘습니다.
              </p>
            )}
          </div>

          {/* I-10: 자동 확정 금지 — 사용자가 반드시 확인한다 */}
          <div className="rounded-lg border border-orange-200 bg-orange-50 p-2">
            <label className="flex items-center justify-between gap-2 text-xs font-semibold text-orange-900">
              원본 금액 단위
              <select
                value={amountUnit}
                disabled={busy}
                onChange={(e) => onAmountUnitChange(Number(e.target.value) as AmountUnit)}
                className="rounded-lg border border-orange-300 bg-surface px-2 py-1 font-normal"
              >
                {AMOUNT_UNIT_OPTIONS.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
            </label>
            <p className="mt-1 text-[11px] text-orange-800">
              {hint
                ? `시트 ${hint.row + 1}행에서 "${hint.text}"를 찾아 ×${hint.unit.toLocaleString()}로 제안합니다.`
                : '단위 표기를 찾지 못해 ×1(원)로 제안합니다.'}{' '}
              1000배 오류는 치명적이라 자동 확정하지 않습니다.
            </p>
            <label className="mt-2 flex cursor-pointer items-center gap-2 text-xs font-semibold text-orange-900">
              <input
                type="checkbox"
                checked={unitConfirmed}
                onChange={(e) => onUnitConfirmedChange(e.target.checked)}
              />
              금액 단위가 <span className="font-mono">×{amountUnit.toLocaleString()}</span> 임을
              확인했습니다
            </label>
          </div>
        </div>
      </section>
    </div>
  );
}
