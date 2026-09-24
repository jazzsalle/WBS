'use client';

// 뷰 전환 토글 (SOT §7.6 상단 "보드 / 매트릭스"). 연차 필터는 두 뷰가 공유하므로
// 여기서 다루지 않는다 — BoardScreen이 URL(?yearId=)로 들고 있다.

export type BoardView = 'board' | 'matrix';

const VIEWS: readonly { value: BoardView; label: string }[] = [
  { value: 'board', label: '보드' },
  { value: 'matrix', label: '매트릭스' },
];

export interface ViewToggleProps {
  value: BoardView;
  onChange: (view: BoardView) => void;
  disabled?: boolean;
}

export default function ViewToggle({ value, onChange, disabled = false }: ViewToggleProps) {
  return (
    <div className="inline-flex items-center gap-1" role="tablist" aria-label="뷰 전환">
      {VIEWS.map((view) => {
        const active = view.value === value;
        return (
          <button
            key={view.value}
            type="button"
            role="tab"
            aria-selected={active}
            disabled={disabled}
            onClick={() => onChange(view.value)}
            className={`rounded-lg px-3 py-1.5 text-sm font-semibold transition ${
              active
                ? 'bg-grey-900 text-surface'
                : 'border border-grey-300 bg-surface text-grey-700 hover:bg-grey-50'
            }`}
          >
            {view.label}
          </button>
        );
      })}
    </div>
  );
}
