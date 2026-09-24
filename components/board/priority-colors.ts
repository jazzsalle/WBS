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
  'orange-500': {
    cell: 'border-orange-200 bg-orange-50 text-orange-800 hover:bg-orange-100',
    cellSelected: 'border-orange-600 bg-orange-100 text-orange-900 ring-2 ring-orange-500',
    band: 'bg-orange-500',
    badge: 'amber',
  },
  'grey-500': {
    cell: 'border-grey-200 bg-grey-50 text-grey-700 hover:bg-grey-100',
    cellSelected: 'border-grey-600 bg-grey-100 text-grey-900 ring-2 ring-grey-500',
    band: 'bg-grey-500',
    badge: 'neutral',
  },
  'grey-400': {
    cell: 'border-grey-200 bg-surface text-grey-500 hover:bg-grey-50',
    cellSelected: 'border-grey-500 bg-grey-100 text-grey-800 ring-2 ring-grey-400',
    band: 'bg-grey-400',
    badge: 'neutral',
  },
};

// 알 수 없는 토큰은 조용히 중립색으로 넘기지 않는다 — 부록 A.3과 어긋났다는 신호다
const UNKNOWN: PriorityColorClasses = {
  cell: 'border-grey-300 bg-grey-100 text-grey-700',
  cellSelected: 'border-grey-600 bg-grey-200 text-grey-900 ring-2 ring-grey-500',
  band: 'bg-grey-300',
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
