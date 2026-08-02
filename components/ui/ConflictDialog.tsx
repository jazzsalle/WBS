'use client';

// 낙관적 잠금 충돌 안내 (SOT §8.4 O-3)
// StaleDataError가 나면 저장을 실패시키되 **작업 내용을 날리지 않는다.**
// 사용자는 "다시 불러오기"(최신 값을 받아 비교)와 "계속 편집"(입력 유지) 중에서 고른다.
// 어느 쪽을 골라도 폼에 입력한 값은 그대로 남는다 — 이 컴포넌트는 폼을 건드리지 않는다.

import Modal from './Modal';
import Button from './Button';

export interface ConflictDialogProps {
  /** 액션이 준 STALE 메시지 ("OO님이 먼저 수정했습니다…") */
  message: string;
  onReload: () => void;
  onKeepEditing: () => void;
}

export default function ConflictDialog({
  message,
  onReload,
  onKeepEditing,
}: ConflictDialogProps) {
  return (
    <Modal
      open
      title="다른 사람이 먼저 수정했습니다"
      onClose={onKeepEditing}
      closeOnBackdrop={false}
      footer={
        <>
          <Button size="sm" onClick={onKeepEditing}>
            계속 편집
          </Button>
          <Button size="sm" variant="primary" onClick={onReload}>
            다시 불러오기
          </Button>
        </>
      }
    >
      <p className="text-sm text-slate-700">{message}</p>
      <p className="mt-3 rounded-lg bg-slate-50 p-3 text-xs text-slate-600">
        입력하신 내용은 그대로 남아 있습니다. <strong>다시 불러오기</strong>를 누르면 최신 값을
        가져와 내 입력과 다른 항목만 비교해 보여줍니다. <strong>계속 편집</strong>을 누르면 지금
        화면 그대로 작업을 이어갈 수 있습니다.
      </p>
    </Modal>
  );
}
