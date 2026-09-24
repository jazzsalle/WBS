'use client';

// 안내 목록 — 앱이 판정하지 않는 조항 (SOT §7.9.5, 부록 D.3)
// 프리셋별 **읽기 전용** 체크리스트. 체크는 이 컴포넌트의 로컬 state뿐이고 어디에도 저장하지 않는다 —
// 규칙(§5.18)이 아니라 사람이 원문으로 확인할 안내다. 모달을 닫으면 언마운트로 사라지고,
// 프리셋이 바뀌면 부모가 key={presetId}로 다시 마운트해 체크가 초기화된다.

import { useState } from 'react';
import { RULE_PRESETS, type PresetId } from '@/lib/rules-presets';

export interface AdvisoryListProps {
  presetId: PresetId;
}

export default function AdvisoryList({ presetId }: AdvisoryListProps) {
  const preset = RULE_PRESETS[presetId];
  const [checked, setChecked] = useState<ReadonlySet<number>>(() => new Set());

  const toggle = (index: number): void => {
    setChecked((prev) => {
      const next = new Set(prev);
      if (next.has(index)) next.delete(index);
      else next.add(index);
      return next;
    });
  };

  return (
    <section aria-label="안내 목록" className="space-y-3">
      {/* 부록 D.3 상단 고정 문구 — 이 목록의 성격을 먼저 알린다 */}
      <p
        role="note"
        className="rounded-lg border border-orange-100 bg-orange-50 px-4 py-3 text-t6 font-semibold text-orange-800"
      >
        앱이 판정하지 않습니다 — 사람이 확인하세요
      </p>
      <div className="flex flex-wrap items-baseline justify-between gap-2 text-t7 text-grey-500">
        <p>
          <span className="font-semibold text-grey-700">{preset.label}</span> 프리셋의 조항{' '}
          {preset.advisories.length}건. 괄호는 조문, 줄표 뒤는 앱이 판정하지 못하는 이유입니다.
        </p>
        <p>
          확인 {checked.size} / {preset.advisories.length} · 체크는 저장되지 않으며 창을 닫으면
          사라집니다
        </p>
      </div>
      <ul className="divide-y divide-grey-100 rounded-xl border border-grey-200">
        {preset.advisories.map((text, index) => {
          const done = checked.has(index);
          return (
            <li key={index}>
              <label className="flex cursor-pointer items-start gap-3 px-4 py-2.5 hover:bg-grey-50">
                <input
                  type="checkbox"
                  checked={done}
                  onChange={() => toggle(index)}
                  className="mt-0.5 h-4 w-4 shrink-0 rounded border-grey-300"
                />
                <span className={`text-t7 ${done ? 'text-grey-400 line-through' : 'text-grey-800'}`}>
                  {text}
                </span>
              </label>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
