// 공통 뱃지 (상태·연차 표시. SOT §7.15, §7.2)
// 색상 의미는 부록 A.3이 정하지만 A.3에 없는 대상(과제 상태 등)은 중립 톤을 쓴다.
// 톤별 클래스는 Tailwind 정적 스캔을 위해 완전한 문자열로 나열한다.

import type { ReactNode } from 'react';

export type BadgeTone = 'neutral' | 'blue' | 'green' | 'amber' | 'red' | 'violet';

const TONE_CLASSES: Record<BadgeTone, string> = {
  neutral: 'bg-slate-100 text-slate-600',
  blue: 'bg-blue-50 text-blue-700',
  green: 'bg-emerald-50 text-emerald-700',
  amber: 'bg-amber-50 text-amber-700',
  red: 'bg-red-50 text-red-700',
  violet: 'bg-violet-50 text-violet-700',
};

export interface BadgeProps {
  children: ReactNode;
  tone?: BadgeTone;
  className?: string;
  title?: string;
}

export default function Badge({ children, tone = 'neutral', className = '', title }: BadgeProps) {
  return (
    <span
      title={title}
      className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${TONE_CLASSES[tone]} ${className}`}
    >
      {children}
    </span>
  );
}
