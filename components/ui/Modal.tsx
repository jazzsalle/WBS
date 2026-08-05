'use client';

// 공통 모달 (SOT §7 전반의 생성·편집 모달 공용 껍데기)
// 폼 모달은 배경 클릭으로 닫히면 입력 내용이 날아간다 — closeOnBackdrop=false로 막는다 (§8.4 O-3 정신).

import { useEffect, useId, type ReactNode } from 'react';

export interface ModalProps {
  open: boolean;
  title: string;
  description?: string;
  onClose: () => void;
  /** 배경 클릭으로 닫을지. 폼 모달은 false를 준다 */
  closeOnBackdrop?: boolean;
  /** xl은 표·그리드를 담는 마법사용 (§7.9.1 엑셀 가져오기) */
  size?: 'md' | 'lg' | 'xl';
  footer?: ReactNode;
  children: ReactNode;
}

const SIZE_CLASSES = {
  md: 'max-w-md',
  lg: 'max-w-2xl',
  xl: 'max-w-6xl',
} as const;

export default function Modal({
  open,
  title,
  description,
  onClose,
  closeOnBackdrop = true,
  size = 'md',
  footer,
  children,
}: ModalProps) {
  const titleId = useId();

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    // 모달 뒤 본문이 스크롤되면 어떤 화면을 보고 있는지 흐려진다
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = previousOverflow;
    };
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center overflow-y-auto bg-slate-900/40 p-4"
      onMouseDown={(e) => {
        if (closeOnBackdrop && e.target === e.currentTarget) onClose();
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className={`w-full ${SIZE_CLASSES[size]} rounded-2xl bg-white p-6 shadow-xl`}
      >
        <div className="flex items-start justify-between gap-4">
          <div>
            <h2 id={titleId} className="text-lg font-bold">
              {title}
            </h2>
            {description && <p className="mt-1 text-sm text-slate-500">{description}</p>}
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="닫기"
            className="shrink-0 text-xl leading-none text-slate-400 hover:text-slate-600"
          >
            ×
          </button>
        </div>

        <div className="mt-4">{children}</div>

        {footer && <div className="mt-6 flex justify-end gap-2">{footer}</div>}
      </div>
    </div>
  );
}
