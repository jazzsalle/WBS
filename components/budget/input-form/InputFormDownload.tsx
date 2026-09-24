'use client';

// 입력 양식 내려받기 모달 (SOT §7.9.7 [입력 양식 내려받기], §6.16 IN-1·IN-2·IN-7)
//
//  - **연차 하나**를 골라 그 연차의 인건비·사업비 시트가 든 우리 양식(xlsx)을 받는다.
//    연차가 하나뿐이면 묻지 않는다 (ExportModal의 템플릿 선택과 같은 태도, X-3)
//  - 내려받기는 읽기 전용이다 — 앱 데이터를 바꾸지 않고 스냅샷도 남기지 않는다
//  - 파일 내용(좌표·수식·_meta)은 전부 서버(actions/input-form → lib/input-form)가 만든다.
//    SheetJS를 클라이언트에서 import하지 않는다 (IN-8·I-13)

import { useState } from 'react';
import type { Year } from '@/types';
import type { ActionErrorCode } from '@/lib/db/errors';
import { buildInputForm } from '@/actions/input-form';
import Button from '@/components/ui/Button';
import ErrorBanner from '@/components/ui/ErrorBanner';
import Modal from '@/components/ui/Modal';

const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

interface Failure {
  message: string;
  code?: ActionErrorCode;
}

/**
 * 바이너리 다운로드 (ExportModal과 같은 흐름). atob은 바이트를 latin1 코드포인트로 주므로 그대로 옮긴다 —
 * 문자열을 Blob에 바로 넣으면 UTF-8로 다시 인코딩돼 xlsx가 깨진다.
 */
function downloadWorkbook(fileName: string, contentBase64: string): void {
  const binary = atob(contentBase64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);

  const url = URL.createObjectURL(new Blob([bytes], { type: XLSX_MIME }));
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName; // 과제명·연차·생성일은 서버가 파일명에 넣었다
  a.click();
  URL.revokeObjectURL(url);
}

export interface InputFormDownloadProps {
  projectId: string;
  /** 양식은 연차 단위다 (§7.9.7). 이 목록에서 고른다 */
  years: Year[];
  onClose: () => void;
}

export default function InputFormDownload({ projectId, years, onClose }: InputFormDownloadProps) {
  const [yearId, setYearId] = useState(years[0]?.id ?? '');
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<Failure | null>(null);
  const [done, setDone] = useState<string | null>(null);

  async function handleDownload(): Promise<void> {
    if (yearId === '') return;
    setBusy(true);
    setFailure(null);
    setDone(null);
    try {
      const res = await buildInputForm(projectId, yearId);
      if (!res.ok) {
        // 절대 규칙 5: 실패를 조용히 삼키지 않는다
        setFailure({ message: res.error, code: res.code });
        return;
      }
      downloadWorkbook(res.data.fileName, res.data.contentBase64);
      setDone(res.data.fileName);
    } catch (e) {
      // 다운로드 자체가 실패해도 알린다 — 파일이 없는데 성공으로 보이면 안 된다
      setFailure({
        message: `파일을 저장하지 못했습니다: ${e instanceof Error ? e.message : String(e)}`,
      });
    } finally {
      setBusy(false);
    }
  }

  const blocker = years.length === 0 ? '이 과제에 연차가 없습니다.' : null;

  return (
    <Modal
      open
      size="md"
      closeOnBackdrop={false}
      title="입력 양식 내려받기"
      description="고른 연차의 인건비·사업비 시트가 든 입력 양식(xlsx)을 내려받습니다. 앱의 데이터는 바뀌지 않습니다."
      onClose={() => {
        if (!busy) onClose();
      }}
      footer={
        <>
          <span className="mr-auto text-t7 text-grey-500">
            {blocker !== null && <span className="text-red-600">{blocker}</span>}
          </span>
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            닫기
          </Button>
          <Button
            variant="primary"
            onClick={() => void handleDownload()}
            disabled={busy || blocker !== null}
            title={blocker ?? undefined}
          >
            {busy ? '만드는 중…' : '내려받기'}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        {years.length === 0 ? (
          <p className="rounded-xl border border-dashed border-grey-300 p-6 text-center text-t7 text-grey-400">
            연차가 없어 만들 양식이 없습니다. 과제 개요에서 단계·연차를 먼저 만드세요.
          </p>
        ) : (
          <>
            {/* 연차가 하나뿐이면 묻지 않는다 — 고를 것이 없는 셀렉트는 소음이다 */}
            {years.length > 1 ? (
              <label className="block text-t7 text-grey-600">
                <span className="mb-1 block font-semibold">대상 연차</span>
                <select
                  value={yearId}
                  disabled={busy}
                  onChange={(e) => {
                    setYearId(e.target.value);
                    setDone(null);
                  }}
                  className="rounded-md border border-grey-300 px-2 py-1.5 text-t7 focus:border-blue-500 focus:outline-none focus:ring-2 focus:ring-blue-100 disabled:bg-grey-50"
                >
                  {years.map((year) => (
                    <option key={year.id} value={year.id}>
                      {year.order + 1}차년도 · {year.name}
                    </option>
                  ))}
                </select>
              </label>
            ) : (
              <p className="text-t7 text-grey-600">
                대상 연차{' '}
                <span className="font-semibold text-grey-800">
                  {years[0]!.order + 1}차년도 · {years[0]!.name}
                </span>
              </p>
            )}

            <p className="rounded-xl border border-grey-200 bg-grey-50 px-3 py-2 text-t7 text-grey-600">
              받은 파일의 인건비·사업비 시트에 값을 적고 [입력 양식 올리기]로 올리면 산출근거가 만들어집니다.
              금액 열은 참고용 수식이며 앱이 다시 계산합니다.
            </p>

            {failure && (
              <ErrorBanner
                message={failure.message}
                code={failure.code}
                onRetry={() => void handleDownload()}
                onDismiss={() => setFailure(null)}
              />
            )}

            {done !== null && (
              <p
                role="status"
                className="rounded-xl border border-green-300 bg-green-50 px-3 py-2 text-t7 text-green-900"
              >
                {done} 파일을 내려받았습니다.
              </p>
            )}
          </>
        )}
      </div>
    </Modal>
  );
}
