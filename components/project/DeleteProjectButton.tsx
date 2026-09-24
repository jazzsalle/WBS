'use client';

// 과제 삭제 2단계 확인 (SOT §7.3 [과제 삭제], §7.17 TU-5, §6.6 H-7)
// 1/2: 연쇄 삭제 대상을 먼저 보여준다 — H-7이 지우는 범위가 넓어 "과제 하나"로 오해하기 쉽다.
// 2/2: 과제명을 똑같이 입력해야 [삭제]가 켜진다. 되돌릴 수 없는 작업이라 클릭 한 번으로 끝나면 안 된다.
// 삭제는 기존 deleteProject 액션 하나만 쓴다(TU-5: 별도 삭제 경로를 만들지 않는다).

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import type { ActionErrorCode } from '@/lib/db/errors';
import { deleteProject } from '@/actions/projects';
import Modal from '@/components/ui/Modal';
import Button from '@/components/ui/Button';
import ErrorBanner from '@/components/ui/ErrorBanner';
import { setRealtimePaused } from '@/components/RealtimeRefresher';
import { isSampleProject } from '@/lib/tutorial';

// H-7 연쇄 삭제 대상 — SOT §7.3 불릿의 순서 그대로
const CASCADE_TARGETS = '단계·연차·작업·목표·마일스톤·연구비·인력·기관·리스크·노트';

export interface DeleteProjectButtonProps {
  projectId: string;
  projectName: string;
}

export default function DeleteProjectButton({ projectId, projectName }: DeleteProjectButtonProps) {
  const router = useRouter();
  const [step, setStep] = useState<0 | 1 | 2>(0);
  const [typedName, setTypedName] = useState('');
  const [deleting, setDeleting] = useState(false);
  const [failure, setFailure] = useState<{ message: string; code?: ActionErrorCode } | null>(null);

  const isSample = isSampleProject({ name: projectName });
  const nameMatches = typedName === projectName;

  // R-4: 확인 중 자동 새로고침이 끼어들면 입력 중인 과제명이 날아간다
  useEffect(() => {
    if (step === 0) return;
    setRealtimePaused(true);
    return () => setRealtimePaused(false);
  }, [step]);

  const close = () => {
    // 삭제 요청이 나간 뒤에는 결과를 보여줘야 하므로 닫지 않는다
    if (deleting) return;
    setStep(0);
    setTypedName('');
    setFailure(null);
  };

  const handleDelete = async () => {
    if (!nameMatches || deleting) return;
    setDeleting(true);
    setFailure(null);
    const res = await deleteProject(projectId);
    if (res.ok) {
      router.push('/projects');
      return;
    }
    // 실패는 모달 안에서 보여준다 — 닫아버리면 무엇이 안 됐는지 알 수 없다 (절대 규칙 5)
    setFailure({ message: res.error, code: res.code });
    setDeleting(false);
  };

  return (
    <>
      <Button variant="danger" size="sm" onClick={() => setStep(1)}>
        과제 삭제
      </Button>

      <Modal
        open={step === 1}
        title="과제 삭제 (1/2)"
        description="이 과제에 속한 데이터가 함께 삭제됩니다."
        onClose={close}
        closeOnBackdrop={false}
        footer={
          <>
            <Button variant="secondary" onClick={close}>
              취소
            </Button>
            <Button variant="danger" onClick={() => setStep(2)}>
              계속
            </Button>
          </>
        }
      >
        <div className="space-y-3 text-sm text-grey-700">
          <p>
            <span className="font-semibold text-grey-900">{projectName}</span> 과제를 삭제하면{' '}
            {CASCADE_TARGETS}가 함께 삭제됩니다.
          </p>
          <p className="rounded-xl border border-red-100 bg-red-50 p-3 font-semibold text-red-700">
            삭제한 데이터는 되돌릴 수 없습니다.
          </p>
          {isSample && (
            <p className="rounded-xl border border-blue-100 bg-blue-50 p-3 text-blue-600">
              따라하기 예제 과제입니다 — 지워도 됩니다.
            </p>
          )}
        </div>
      </Modal>

      <Modal
        open={step === 2}
        title="과제 삭제 (2/2)"
        description="확인을 위해 과제명을 똑같이 입력하세요."
        onClose={close}
        closeOnBackdrop={false}
        footer={
          <>
            <Button variant="secondary" onClick={close} disabled={deleting}>
              취소
            </Button>
            <Button variant="danger" onClick={handleDelete} disabled={!nameMatches || deleting}>
              {deleting ? '삭제 중…' : '삭제'}
            </Button>
          </>
        }
      >
        {failure && (
          <ErrorBanner
            message={failure.message}
            code={failure.code}
            onDismiss={() => setFailure(null)}
            className="mb-4"
          />
        )}
        <label className="block text-sm">
          <span className="font-semibold text-grey-700">과제명</span>
          <span className="mt-1 block rounded-md bg-grey-100 px-3 py-2 text-grey-900 select-all">
            {projectName}
          </span>
        </label>
        <label className="mt-3 block text-sm">
          <span className="font-semibold text-grey-700">과제명 입력</span>
          <input
            type="text"
            value={typedName}
            onChange={(e) => setTypedName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void handleDelete();
            }}
            disabled={deleting}
            autoFocus
            autoComplete="off"
            spellCheck={false}
            placeholder={projectName}
            aria-invalid={typedName !== '' && !nameMatches}
            className="mt-1 w-full rounded-md border border-grey-300 bg-surface px-3 py-2 text-t6 text-grey-900 focus:border-blue-500 focus:outline-none focus:ring-2 focus:ring-blue-100 disabled:bg-grey-100 disabled:text-grey-400"
          />
        </label>
        {typedName !== '' && !nameMatches && (
          <p className="mt-1 text-xs text-red-600">과제명이 일치하지 않습니다.</p>
        )}
      </Modal>
    </>
  );
}
