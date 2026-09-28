'use client';

// 목표 양식 내려받기 모달 (SOT §7.7 [양식 내려받기], §6.17 GF-1)
//
//  - 과제 하나의 성과목표·성과실적·기술목표·측정이력이 채워진 xlsx를 받는다. 연차 단위가 아니라 고를 것이 없다
//  - 내려받기는 읽기 전용이다 — 앱 데이터를 바꾸지 않고 스냅샷도 남기지 않는다
//  - 파일 내용(좌표·드롭다운·_meta)은 전부 서버(actions/goal-form → lib/goal-form)가 만든다.
//    서식 라이브러리를 클라이언트에서 import하지 않는다 (부록 F, I-13)
//  - 버튼 하나로 바로 받지 않고 모달을 두는 이유: 충돌 기준이 "내려받은 시점"이라(GF-5) 오래 묵힌 파일을
//    올리면 충돌로 건너뛴다는 안내를 받기 전에 보여야 한다 (입력 양식 모달과 같은 태도)

import { useState } from 'react';
import type { ActionErrorCode } from '@/lib/db/errors';
import { buildGoalForm } from '@/actions/goal-form';
import Button from '@/components/ui/Button';
import ErrorBanner from '@/components/ui/ErrorBanner';
import Modal from '@/components/ui/Modal';

const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

interface Failure {
  message: string;
  code?: ActionErrorCode;
}

/**
 * 바이너리 다운로드 (InputFormDownload와 같은 흐름). atob은 바이트를 latin1 코드포인트로 주므로 그대로 옮긴다 —
 * 문자열을 Blob에 바로 넣으면 UTF-8로 다시 인코딩돼 xlsx가 깨진다.
 */
function downloadWorkbook(fileName: string, contentBase64: string): void {
  const binary = atob(contentBase64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);

  const url = URL.createObjectURL(new Blob([bytes], { type: XLSX_MIME }));
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName; // 과제명·생성일은 서버가 파일명에 넣었다
  a.click();
  URL.revokeObjectURL(url);
}

export interface GoalFormDownloadProps {
  projectId: string;
  onClose: () => void;
}

export default function GoalFormDownload({ projectId, onClose }: GoalFormDownloadProps) {
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<Failure | null>(null);
  const [done, setDone] = useState<string | null>(null);

  async function handleDownload(): Promise<void> {
    setBusy(true);
    setFailure(null);
    setDone(null);
    try {
      const res = await buildGoalForm(projectId);
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

  return (
    <Modal
      open
      size="md"
      closeOnBackdrop={false}
      title="목표 양식 내려받기"
      description="성과목표·성과실적·기술목표·측정이력이 채워진 목표 양식(xlsx)을 내려받습니다. 앱의 데이터는 바뀌지 않습니다."
      onClose={() => {
        if (!busy) onClose();
      }}
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            닫기
          </Button>
          <Button variant="primary" onClick={() => void handleDownload()} disabled={busy}>
            {busy ? '만드는 중…' : '내려받기'}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <p className="rounded-xl border border-grey-200 bg-grey-50 px-3 py-2 text-t7 text-grey-600">
          받은 파일의 시트에서 지표를 고치거나 빈 줄에 새로 적고 [양식 올리기]로 올리세요. 기존 행은 숨김 id로 찾아
          변경하고, 양식에서 지운 행은 [삭제 포함]을 켜야 지워집니다. 내려받은 뒤 다른 경로로 바뀐 행은 충돌로
          건너뛰므로, 오래 묵힌 파일보다 방금 내려받은 파일을 쓰세요.
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
          <p role="status" className="rounded-xl border border-green-300 bg-green-50 px-3 py-2 text-t7 text-green-900">
            {done} 파일을 내려받았습니다.
          </p>
        )}
      </div>
    </Modal>
  );
}
