'use client';

// Step 1 — 파일 (SOT §7.9.1)
//  - 드래그앤드롭 또는 파일 선택 (xlsx/xlsm/xls/csv)
//  - 10MB 초과·확장자 위반은 **업로드 전에** 막고 이유를 표시한다 (I-15)
//  - 저장된 프로파일(부처 템플릿)을 고르면 Step 4로 점프한다 (§6.8.1 — 비목 매핑·미리보기는 건너뛰지 않는다)

import { useRef, useState, type DragEvent } from 'react';
import type { ImportProfile } from '@/types';
import Badge from '@/components/ui/Badge';
import ErrorBanner from '@/components/ui/ErrorBanner';
import { ACCEPT_ATTRIBUTE, ACCEPTED_EXTENSIONS, formatBytes, rejectReason } from './wizard-state';

export interface Step1FileProps {
  file: File | null;
  busy: boolean;
  profiles: ImportProfile[];
  /** 프로파일 목록 조회 실패 문구. 조용히 빈 목록으로 대체하지 않는다 (절대 규칙 5) */
  profilesError: string | null;
  selectedProfileId: string | null;
  onSelectProfile: (profileId: string | null) => void;
  /** 검증을 통과한 파일만 넘어온다 */
  onFileAccepted: (file: File) => void;
}

export default function Step1File({
  file,
  busy,
  profiles,
  profilesError,
  selectedProfileId,
  onSelectProfile,
  onFileAccepted,
}: Step1FileProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);
  const [rejected, setRejected] = useState<string | null>(null);

  const accept = (picked: File | null | undefined): void => {
    if (!picked) return;
    const reason = rejectReason(picked);
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
          dragging ? 'border-grey-900 bg-grey-50' : 'border-grey-300 bg-white'
        }`}
      >
        <p className="text-sm font-semibold text-grey-700">
          엑셀 파일을 여기에 끌어다 놓거나 선택하세요
        </p>
        <p className="mt-1 text-xs text-grey-500">
          {ACCEPTED_EXTENSIONS.join(' · ')} · 최대 10MB · 20,000행
        </p>
        <button
          type="button"
          disabled={busy}
          onClick={() => inputRef.current?.click()}
          className="mt-4 rounded-lg bg-grey-900 px-4 py-2 text-sm font-semibold text-white transition hover:bg-grey-700 disabled:cursor-not-allowed disabled:opacity-50"
        >
          파일 선택
        </button>
        <input
          ref={inputRef}
          type="file"
          accept={ACCEPT_ATTRIBUTE}
          className="hidden"
          onChange={(e) => {
            accept(e.target.files?.[0]);
            // 같은 파일을 다시 골라도 change가 발생하도록 비운다
            e.target.value = '';
          }}
        />
        {file && (
          <p className="mt-4 text-xs text-grey-600">
            선택됨 · <span className="font-semibold">{file.name}</span> ({formatBytes(file.size)})
          </p>
        )}
      </div>

      {rejected && (
        <ErrorBanner message={rejected} code="VALIDATION" onDismiss={() => setRejected(null)} />
      )}

      <section className="space-y-2">
        <h3 className="text-sm font-semibold text-grey-700">저장된 프로파일 (부처 템플릿)</h3>
        <p className="text-xs text-grey-500">
          프로파일을 고르면 시트·범위·열 매핑을 건너뛰고 <strong>비목 매핑(Step 4)</strong>부터
          시작합니다. 자동 인식은 제안일 뿐이므로 비목 매핑 확인과 미리보기는 건너뛰지 않습니다.
        </p>

        {profilesError && <ErrorBanner message={profilesError} />}

        <div className="space-y-1.5">
          <label
            className={`flex cursor-pointer items-center gap-3 rounded-lg border px-3 py-2 text-sm ${
              selectedProfileId === null ? 'border-grey-900 bg-grey-50' : 'border-grey-200'
            }`}
          >
            <input
              type="radio"
              name="import-profile"
              checked={selectedProfileId === null}
              disabled={busy}
              onChange={() => onSelectProfile(null)}
            />
            <span className="font-medium text-grey-700">프로파일 없이 시작 (자동 감지)</span>
          </label>

          {profiles.map((profile) => (
            <label
              key={profile.id}
              className={`flex cursor-pointer items-center gap-3 rounded-lg border px-3 py-2 text-sm ${
                selectedProfileId === profile.id ? 'border-grey-900 bg-grey-50' : 'border-grey-200'
              }`}
            >
              <input
                type="radio"
                name="import-profile"
                checked={selectedProfileId === profile.id}
                disabled={busy}
                onChange={() => onSelectProfile(profile.id)}
              />
              <span className="min-w-0 flex-1">
                <span className="font-medium text-grey-700">{profile.name}</span>
                <span className="ml-2 text-xs text-grey-500">
                  {profile.sheetName ?? '첫 시트'} · 헤더 {profile.headerRow + 1}행 · 라벨{' '}
                  {profile.labelColumns.join(',') || '-'} · 연차 열{' '}
                  {profile.yearColumnMappings.length}개 · ×{profile.amountUnit.toLocaleString()}
                </span>
              </span>
              {profile.ministry && <Badge tone="violet">{profile.ministry}</Badge>}
              {profile.projectId === null && <Badge tone="neutral">전역</Badge>}
              <span className="shrink-0 text-xs text-grey-400">{profile.useCount}회 사용</span>
            </label>
          ))}

          {profiles.length === 0 && !profilesError && (
            <p className="rounded-lg border border-dashed border-grey-300 px-3 py-3 text-xs text-grey-400">
              저장된 프로파일이 없습니다. 마지막 단계에서 이번 매핑을 프로파일로 저장할 수 있습니다.
            </p>
          )}
        </div>
      </section>
    </div>
  );
}
