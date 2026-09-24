// 공통 뱃지 (상태·연차 표시. SOT §7.15, §7.2)
// 색상 의미는 부록 A.3이 정하지만 A.3에 없는 대상(과제 상태 등)은 중립 톤을 쓴다.
// 톤별 클래스는 Tailwind 정적 스캔을 위해 완전한 문자열로 나열한다.

import type { ReactNode } from 'react';

export type BadgeTone = 'neutral' | 'blue' | 'green' | 'amber' | 'red' | 'violet';

const TONE_CLASSES: Record<BadgeTone, string> = {
  neutral: 'bg-grey-100 text-grey-700',
  blue: 'bg-blue-50 text-blue-600',
  green: 'bg-green-50 text-green-600',
  amber: 'bg-orange-50 text-orange-700',
  red: 'bg-red-50 text-red-600',
  violet: 'bg-purple-50 text-purple-700',
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
      className={`inline-flex items-center rounded-md px-2 py-0.5 text-t7 font-medium ${TONE_CLASSES[tone]} ${className}`}
    >
      {children}
    </span>
  );
}
