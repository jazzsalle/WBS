// 우선순위 등급 표시 토큰 (SOT §6.9.2, 부록 A.3 PRIORITY_SCORE_COLORS)
//
// 판정(점수·등급)은 전부 lib/priority.ts가 한다. 이 파일은 그 결과(색상 토큰)를 화면
// 클래스로 옮기기만 한다 — 여기서 경계값(15, 8, 4)을 다시 쓰지 않는다.
// Tailwind는 클래스명을 정적으로 스캔하므로 문자열 조합이 아니라 완전한 형태로 나열한다
// (components/risks/severity.ts와 같은 이유).

import type { BadgeTone } from '@/components/ui/Badge';
import type { Matrix5x5ColorClasses } from '@/components/ui/Matrix5x5';

export interface PriorityColorClasses extends Matrix5x5ColorClasses {
  /** 칸반 카드 좌측의 등급 색 띠 (§7.6) */
  band: string;
  badge: BadgeTone;
}

// 키는 부록 A.3의 색상 토큰이다 (lib/priority.ts의 priorityGrade가 돌려주는 값)
const COLOR_CLASSES: Record<string, PriorityColorClasses> = {
  'red-600': {
    cell: 'border-red-200 bg-red-50 text-red-800 hover:bg-red-100',
    cellSelected: 'border-red-600 bg-red-100 text-red-900 ring-2 ring-red-500',
    band: 'bg-red-600',
    badge: 'red',
  },
  'amber-500': {
    cell: 'border-amber-200 bg-amber-50 text-amber-800 hover:bg-amber-100',
    cellSelected: 'border-amber-600 bg-amber-100 text-amber-900 ring-2 ring-amber-500',
    band: 'bg-amber-500',
    badge: 'amber',
  },
  'slate-500': {
    cell: 'border-slate-200 bg-slate-50 text-slate-700 hover:bg-slate-100',
    cellSelected: 'border-slate-600 bg-slate-100 text-slate-900 ring-2 ring-slate-500',
    band: 'bg-slate-500',
    badge: 'neutral',
  },
  'slate-400': {
    cell: 'border-slate-200 bg-white text-slate-500 hover:bg-slate-50',
    cellSelected: 'border-slate-500 bg-slate-100 text-slate-800 ring-2 ring-slate-400',
    band: 'bg-slate-400',
    badge: 'neutral',
  },
};

// 알 수 없는 토큰은 조용히 중립색으로 넘기지 않는다 — 부록 A.3과 어긋났다는 신호다
const UNKNOWN: PriorityColorClasses = {
  cell: 'border-slate-300 bg-slate-100 text-slate-700',
  cellSelected: 'border-slate-600 bg-slate-200 text-slate-900 ring-2 ring-slate-500',
  band: 'bg-slate-300',
  badge: 'neutral',
};

export function priorityColorClasses(colorToken: string): PriorityColorClasses {
  const found = COLOR_CLASSES[colorToken];
  if (!found) {
    console.error(`[components/board] 알 수 없는 우선순위 색상 토큰: ${colorToken}`);
    return UNKNOWN;
  }
  return found;
}
