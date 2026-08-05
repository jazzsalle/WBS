'use client';

// Step 5 — 미리보기 & 반영 (SOT §7.9.1)
//  - 상단 요약: 신규 N · 덮어씀 N · 건너뜀 N건(합계 X원) · 오류 N · 합계 금액 ·
//    "이 파일에 없는 비목 N건은 유지됩니다" (S-9)
//  - 오류가 1건이라도 있으면 반영 버튼 비활성화. **셀 인라인 수정은 지원하지 않는다** —
//    해당 행을 건너뛰기로 제외하거나 원본 파일에서 고쳐 다시 올린다.
//
// 반영 가능 판정은 서버가 준 `blocked`/`unmappedYearOrders`를 그대로 쓴다. 여기서 다시 계산하지 않는다.

import type { PreviewImportResult, Settings } from '@/types';
import Button from '@/components/ui/Button';
import ImportPreviewTable from './ImportPreviewTable';

export interface Step5PreviewProps {
  preview: PreviewImportResult | null;
  yearNameById: Record<string, string>;
  currencyUnit: Settings['currencyUnit'];
  busy: boolean;
  /** Step 4의 결정이 아직 미리보기에 반영되지 않았는가 */
  dirty: boolean;
  onRecheck: () => void;
  onGoToStep: (step: 3 | 4) => void;
}

export default function Step5Preview({
  preview,
  yearNameById,
  currencyUnit,
  busy,
  dirty,
  onRecheck,
  onGoToStep,
}: Step5PreviewProps) {
  if (!preview) {
    return (
      <p className="rounded-xl border border-dashed border-slate-300 p-6 text-center text-sm text-slate-400">
        미리보기를 불러오는 중입니다.
      </p>
    );
  }

  const { summary } = preview;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5 rounded-xl border border-slate-200 bg-slate-50 px-3 py-2 text-xs">
        <span className="text-emerald-700">
          신규 <strong>{summary.new}</strong>건
        </span>
        <span className="text-amber-700">
          덮어씀 <strong>{summary.overwrite}</strong>건
        </span>
        <span className="text-slate-500">
          건너뜀 <strong>{summary.skipped}</strong>건 (합계{' '}
          {summary.skippedAmount.toLocaleString('ko-KR')}원)
        </span>
        <span className={summary.error > 0 ? 'font-semibold text-red-700' : 'text-slate-500'}>
          오류 <strong>{summary.error}</strong>건
        </span>
        <span className="ml-auto font-semibold text-slate-700">
          합계 {summary.totalAmount.toLocaleString('ko-KR')}원
        </span>
      </div>

      <p className="text-xs text-slate-500">
        이 파일에 없는 비목 <strong>{summary.untouchedCategories.length}</strong>건은 유지됩니다
        (S-9). 덮어쓰기 범위는 파일에 등장한 (연차, 비목) 조합뿐입니다.
        {summary.untouchedCategories.length > 0 && (
          <span
            className="ml-1 text-slate-400"
            title={summary.untouchedCategories
              .map((c) => `${(c.yearOrder ?? 0) + 1}차년도 ${c.category}`)
              .join(', ')}
          >
            ⓘ
          </span>
        )}
      </p>

      {dirty && (
        <div className="flex flex-wrap items-center gap-3 rounded-xl border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-900">
          <span>Step 4에서 바꾼 내용이 아직 반영되지 않은 미리보기입니다.</span>
          <Button size="sm" variant="secondary" disabled={busy} onClick={onRecheck} className="ml-auto">
            다시 확인
          </Button>
        </div>
      )}

      {summary.error > 0 && (
        <div className="rounded-xl border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700">
          <p className="font-semibold">오류 {summary.error}건이 있어 반영할 수 없습니다.</p>
          <p className="mt-1">
            해당 행을 Step 4에서 <strong>건너뛰기</strong>로 제외하거나, 원본 엑셀에서 값을 고쳐 다시
            올리세요. <strong>셀 값의 인라인 수정은 지원하지 않습니다.</strong>
          </p>
          <Button size="sm" variant="secondary" className="mt-2" onClick={() => onGoToStep(4)}>
            Step 4 비목 매핑으로
          </Button>
        </div>
      )}

      {preview.unmappedYearOrders.length > 0 && (
        <div className="rounded-xl border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700">
          <p className="font-semibold">
            대응되지 않은 연차 열이 있습니다 (
            {preview.unmappedYearOrders.map((order) => `${order + 1}차년도`).join(', ')}).
          </p>
          <Button size="sm" variant="secondary" className="mt-2" onClick={() => onGoToStep(3)}>
            Step 3 열 매핑으로
          </Button>
        </div>
      )}

      <ImportPreviewTable
        rows={preview.rows}
        yearNameById={yearNameById}
        currencyUnit={currencyUnit}
      />

      <p className="text-[11px] text-slate-400">
        반영 직전의 기존 계획액은 스냅샷으로 저장되어 설정 화면에서 되돌릴 수 있습니다 (I-17).
        파일: {preview.fileName} · 시트: {preview.sheetName}
      </p>
    </div>
  );
}
