'use client';

// Step 1 — 파일 · 연차 (SOT §7.9.3)
//  - 드래그앤드롭 또는 파일 선택 (xlsx/xlsm/xls — csv는 병합·서식 정보가 없어 받지 않는다)
//  - 10MB 초과·확장자 위반은 **업로드 전에** 막고 이유를 표시한다 (I-15)
//  - 대상 연차를 사용자가 확정한다. 시트명 제안은 초기값일 뿐이다 (D-19)

import { useRef, useState, type DragEvent } from 'react';
import type { InspectDetailSheetResult } from '@/types';
import Badge from '@/components/ui/Badge';
import ErrorBanner from '@/components/ui/ErrorBanner';
import {
  DETAIL_ACCEPTED_EXTENSIONS,
  DETAIL_ACCEPT_ATTRIBUTE,
  detailRejectReason,
  formatBytes,
  type WizardYear,
} from './detail-wizard-state';

export interface DetailStep1FileYearProps {
  file: File | null;
  busy: boolean;
  /** 파일을 읽은 결과. 연차 제안(D-19)의 근거인 시트명을 여기서 찾는다 */
  inspect: InspectDetailSheetResult | null;
  years: WizardYear[];
  /** 빈 문자열이면 아직 고르지 않았다 */
  yearId: string;
  /** D-19 시트명 제안. 사용자가 아직 손대지 않았으면 이 값이 선택되어 있다 */
  suggestedYearId: string | null;
  /** 제안의 근거가 된 시트명 (없으면 제안이 없었다는 뜻) */
  suggestedFromSheet: string | null;
  /** 검증을 통과한 파일만 넘어온다 */
  onFileAccepted: (file: File) => void;
  onYearChange: (yearId: string) => void;
}

export default function DetailStep1FileYear({
  file,
  busy,
  inspect,
  years,
  yearId,
  suggestedYearId,
  suggestedFromSheet,
  onFileAccepted,
  onYearChange,
}: DetailStep1FileYearProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);
  const [rejected, setRejected] = useState<string | null>(null);

  const accept = (picked: File | null | undefined): void => {
    if (!picked) return;
    const reason = detailRejectReason(picked);
    if (reason) {
      // 업로드하지 않고 이유를 남긴다 — 조용히 잘라 보내지 않는다 (I-15)
      setRejected(reason);
      return;
    }
    setRejected(null);
    onFileAccepted(picked);
  };

  const onDrop = (e: DragEvent<HTMLDivElement>): void => {
    e.preventDefault();
    setDragging(false);
    if (busy) return;
    accept(e.dataTransfer.files?.[0]);
  };

  return (
    <div className="space-y-5">
      <div
        onDragOver={(e) => {
          e.preventDefault();
          if (!busy) setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={onDrop}
        className={`rounded-xl border-2 border-dashed p-8 text-center transition ${
          dragging ? 'border-slate-900 bg-slate-50' : 'border-slate-300 bg-white'
        }`}
      >
        <p className="text-sm font-semibold text-slate-700">
          산출근거 시트가 든 엑셀 파일을 끌어다 놓거나 선택하세요
        </p>
        <p className="mt-1 text-xs text-slate-500">
          {DETAIL_ACCEPTED_EXTENSIONS.join(' · ')} · 최대 10MB · 20,000행
        </p>
        <p className="mt-1 text-[11px] text-slate-400">
          총괄표(연차 × 비목 매트릭스)는 이 마법사가 아니라 [엑셀 가져오기]로 넣습니다.
        </p>
        <button
          type="button"
          disabled={busy}
          onClick={() => inputRef.current?.click()}
          className="mt-4 rounded-lg bg-slate-900 px-4 py-2 text-sm font-semibold text-white transition hover:bg-slate-700 disabled:cursor-not-allowed disabled:opacity-50"
        >
          파일 선택
        </button>
        <input
          ref={inputRef}
          type="file"
          accept={DETAIL_ACCEPT_ATTRIBUTE}
          className="hidden"
          onChange={(e) => {
            accept(e.target.files?.[0]);
            // 같은 파일을 다시 골라도 change가 발생하도록 비운다
            e.target.value = '';
          }}
        />
        {file && (
          <p className="mt-4 text-xs text-slate-600">
            선택됨 · <span className="font-semibold">{file.name}</span> ({formatBytes(file.size)})
            {inspect && <span className="ml-2 text-slate-400">시트 {inspect.sheets.length}개</span>}
          </p>
        )}
      </div>

      {rejected && (
        <ErrorBanner message={rejected} code="VALIDATION" onDismiss={() => setRejected(null)} />
      )}

      {/* D-19: 시트 하나 = 연차 하나. 제안은 초기값일 뿐이고 **확정은 사용자가 한다** */}
      <section className="space-y-2">
        <h3 className="text-sm font-semibold text-slate-700">대상 연차</h3>
        <p className="text-xs text-slate-500">
          산출근거 시트는 한 연차만 담습니다. 반영된 내역은 여기서 고른 연차의 비목 셀에 들어갑니다.
        </p>

        {years.length === 0 ? (
          <p className="rounded-lg border border-dashed border-slate-300 px-3 py-3 text-xs text-slate-400">
            이 과제에 연차가 없습니다. 과제 개요에서 단계·연차를 먼저 만드세요.
          </p>
        ) : (
          <div className="space-y-1.5">
            {years.map((year) => (
              <label
                key={year.id}
                className={`flex cursor-pointer items-center gap-3 rounded-lg border px-3 py-2 text-sm ${
                  yearId === year.id ? 'border-slate-900 bg-slate-50' : 'border-slate-200'
                }`}
              >
                <input
                  type="radio"
                  name="detail-import-year"
                  checked={yearId === year.id}
                  disabled={busy}
                  onChange={() => onYearChange(year.id)}
                />
                <span className="min-w-0 flex-1">
                  <span className="font-medium text-slate-700">{year.order + 1}차년도</span>
                  <span className="ml-2 text-xs text-slate-500">{year.name}</span>
                </span>
                {suggestedYearId === year.id && <Badge tone="blue">시트명 제안</Badge>}
              </label>
            ))}
          </div>
        )}

        {suggestedFromSheet !== null && suggestedYearId !== null ? (
          <p className="text-[11px] text-slate-400">
            시트명 <span className="font-mono">{suggestedFromSheet}</span>에서 연차를 제안했습니다.
            제안일 뿐이니 실제 시트 내용을 보고 확정하세요 (D-19).
          </p>
        ) : (
          inspect !== null && (
            <p className="text-[11px] text-slate-400">
              시트명에서 <span className="font-mono">N차년도</span> 표기를 찾지 못해 제안이 없습니다.
              대상 연차를 직접 고르세요.
            </p>
          )
        )}
      </section>
    </div>
  );
}
