// 리스크 등급 표시 토큰 (SOT §6.5, 부록 A.3 RISK_SCORE_COLORS)
//
// 판정(점수·등급·주의 필요)은 전부 lib/risk.ts가 한다. 이 파일은 그 결과를 화면 클래스로
// 옮기기만 한다 — 여기서 경계값(15, 8)을 다시 쓰지 않는다.
// Tailwind는 클래스명을 정적으로 스캔하므로 문자열 조합이 아니라 완전한 형태로 나열한다
// (components/ui/Badge.tsx와 같은 이유).

import type { BadgeTone } from '@/components/ui/Badge';
import type { RiskSeverity } from '@/lib/risk';

export interface RiskColorClasses {
  /** 히트맵 셀 */
  cell: string;
  /** 선택된 히트맵 셀 */
  cellSelected: string;
  /** 점수 뱃지 */
  badge: string;
}

// 키는 부록 A.3의 색상 토큰이다 (lib/risk.ts의 riskColor가 돌려주는 값)
const COLOR_CLASSES: Record<string, RiskColorClasses> = {
  'red-600': {
    cell: 'border-red-200 bg-red-50 text-red-800 hover:bg-red-100',
    cellSelected: 'border-red-600 bg-red-100 text-red-900 ring-2 ring-red-500',
    badge: 'bg-red-600 text-white',
  },
  'orange-500': {
    cell: 'border-orange-200 bg-orange-50 text-orange-800 hover:bg-orange-100',
    cellSelected: 'border-orange-600 bg-orange-100 text-orange-900 ring-2 ring-orange-500',
    badge: 'bg-orange-500 text-white',
  },
  'green-600': {
    cell: 'border-green-200 bg-green-50 text-green-800 hover:bg-green-100',
    cellSelected: 'border-green-600 bg-green-100 text-green-900 ring-2 ring-green-500',
    badge: 'bg-green-600 text-white',
  },
};

// 알 수 없는 토큰은 조용히 중립색으로 넘기지 않는다 — 부록 A.3과 어긋났다는 신호다
const UNKNOWN: RiskColorClasses = {
  cell: 'border-grey-300 bg-grey-100 text-grey-700',
  cellSelected: 'border-grey-600 bg-grey-200 text-grey-900 ring-2 ring-grey-500',
  badge: 'bg-grey-500 text-white',
};

export function riskColorClasses(colorToken: string): RiskColorClasses {
  const found = COLOR_CLASSES[colorToken];
  if (!found) {
    console.error(`[components/risks] 알 수 없는 리스크 색상 토큰: ${colorToken}`);
    return UNKNOWN;
  }
  return found;
}

// §6.5 등급 이름. 대시보드(§7.2)가 이미 'high'를 "고위험 리스크"로 부르고 있어 같은 말을 쓴다.
export const RISK_SEVERITY_LABELS: Record<RiskSeverity, string> = {
  high: '고위험',
  medium: '중위험',
  low: '저위험',
};

export const RISK_SEVERITY_TONES: Record<RiskSeverity, BadgeTone> = {
  high: 'red',
  medium: 'amber',
  low: 'green',
};
