'use client';

// 협약 예산 보기 툴바 — [엑셀 내려받기] · [복사] (SOT §6.19 AG-8, §7.9.8 "각 보기 툴바")
//
// 엑셀과 복사는 **같은 표 모델**에서 나온다(AG-8). 복사는 화면이 이미 받은 모델을 `toTsv`로 바꿔 넣고,
// 엑셀은 서버가 같은 순수 함수로 모델을 다시 만들어 시트로 쓴다(exceljs는 server-only 어댑터에만 있다).
// 둘 다 원 단위다 — 표시 단위(currencyUnit)로 환산하지 않는다(붙여 넣은 숫자가 단위를 잃지 않게).
//
// 실패는 배너로 알린다(절대 규칙 5). 특히 클립보드는 권한·포커스·Tauri 웹뷰 사정으로 거부될 수 있어서,
// 조용히 넘어가면 사용자는 이전 클립보드 내용을 표라고 믿고 붙여 넣는다.
// 버튼은 화면 조작이라 인쇄에서 뺀다(P-R4).

import { useEffect, useState } from 'react';
import type { ActionErrorCode } from '@/lib/db/errors';
import { toTsv, type TableModel } from '@/lib/agreement/table';
import { buildAgreementWorkbook, type AgreementWorkbookRequest } from '@/actions/agreement-export';
import Button from '@/components/ui/Button';
import ErrorBanner from '@/components/ui/ErrorBanner';

const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

/** 성공 안내가 떠 있는 시간. 실패 배너는 사용자가 닫을 때까지 남는다 */
const NOTICE_MS = 4000;

/**
 * 여러 표를 한 번에 복사할 때의 구분 — 빈 행 하나. 표 제목은 격자에 넣지 않는다(AG-8 — 제목은 화면·인쇄용)
 * 엑셀에 붙이면 표마다 빈 행으로 떨어져 각 헤더 행이 그대로 보인다.
 */
const TABLE_SEPARATOR = '\r\n\r\n';

interface Failure {
  message: string;
  code?: ActionErrorCode;
}

/**
 * 바이너리 다운로드 (InputFormDownload·ExportModal과 같은 흐름). atob은 바이트를 latin1 코드포인트로 주므로
 * 그대로 옮긴다 — 문자열을 Blob에 바로 넣으면 UTF-8로 다시 인코딩돼 xlsx가 깨진다.
 */
function downloadWorkbook(fileName: string, contentBase64: string): void {
  const binary = atob(contentBase64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);

  const url = URL.createObjectURL(new Blob([bytes], { type: XLSX_MIME }));
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName; // 과제명·버전·생성일은 서버가 파일명에 넣었다
  a.click();
  URL.revokeObjectURL(url);
}

function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export interface TableActionsProps {
  projectId: string;
  /** 복사할 표. 여러 개면 빈 행 하나를 사이에 두고 이어 붙인다 */
  model: TableModel | TableModel[];
  /** 같은 보기의 엑셀 요청 — 화면의 표 모델과 같은 순수 함수로 서버가 만든다 */
  workbook: AgreementWorkbookRequest;
}

export default function TableActions({ projectId, model, workbook }: TableActionsProps) {
  const [busy, setBusy] = useState<'download' | 'copy' | null>(null);
  const [failure, setFailure] = useState<Failure | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    if (notice === null) return;
    const timer = window.setTimeout(() => setNotice(null), NOTICE_MS);
    return () => window.clearTimeout(timer);
  }, [notice]);

  async function handleDownload(): Promise<void> {
    setBusy('download');
    setFailure(null);
    setNotice(null);
    try {
      const res = await buildAgreementWorkbook(projectId, workbook);
      if (!res.ok) {
        setFailure({ message: res.error, code: res.code });
        return;
      }
      downloadWorkbook(res.data.fileName, res.data.contentBase64);
      setNotice(`${res.data.fileName} 파일을 내려받았습니다.`);
    } catch (e) {
      // 파일이 없는데 성공으로 보이면 안 된다
      setFailure({ message: `엑셀 파일을 내려받지 못했습니다: ${errorText(e)}` });
    } finally {
      setBusy(null);
    }
  }

  async function handleCopy(): Promise<void> {
    setBusy('copy');
    setFailure(null);
    setNotice(null);
    try {
      const models = Array.isArray(model) ? model : [model];
      // toTsv는 모순된 표 모델(합계 ≠ 항의 합)을 던진다 — 틀린 숫자를 붙여 넣게 두지 않는다
      const tsv = models.map(toTsv).join(TABLE_SEPARATOR);
      if (typeof navigator === 'undefined' || navigator.clipboard === undefined) {
        throw new Error('이 환경에서는 클립보드를 쓸 수 없습니다.');
      }
      await navigator.clipboard.writeText(tsv);
      setNotice(
        models.length > 1
          ? `표 ${models.length}개를 복사했습니다 — 엑셀에 붙여 넣으세요(원 단위).`
          : '표를 복사했습니다 — 엑셀에 붙여 넣으세요(원 단위).'
      );
    } catch (e) {
      setFailure({
        message: `클립보드에 복사하지 못했습니다: ${errorText(e)} — [엑셀 내려받기]로 같은 표를 받을 수 있습니다.`,
      });
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="space-y-2 print:hidden">
      <div className="flex flex-wrap items-center justify-end gap-2">
        {notice !== null && (
          <span role="status" className="mr-auto text-t7 text-green-700">
            {notice}
          </span>
        )}
        <Button size="sm" onClick={() => void handleCopy()} disabled={busy !== null}>
          {busy === 'copy' ? '복사하는 중…' : '복사'}
        </Button>
        <Button size="sm" onClick={() => void handleDownload()} disabled={busy !== null}>
          {busy === 'download' ? '만드는 중…' : '엑셀 내려받기'}
        </Button>
      </div>
      {failure !== null && (
        <ErrorBanner
          message={failure.message}
          code={failure.code}
          className="whitespace-pre-line"
          onDismiss={() => setFailure(null)}
        />
      )}
    </div>
  );
}
