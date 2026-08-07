// To-Do 우선순위 뱃지 톤 (SOT 부록 A.3)
//
// 대시보드 "오늘의 To-Do"(§7.2 6)와 /todos(§7.13)가 같은 값을 쓴다 — T-D3와 같은 이유로
// 두 벌이 되면 같은 항목이 화면마다 다른 색으로 보인다.
// Task의 우선순위 **점수(1~25)** 색과는 다른 축이다 (§7.13, To-Do는 점수를 계산하지 않는다).

import type { BadgeTone } from '@/components/ui/Badge';
import type { Priority } from '@/types';

export const PRIORITY_TONES: Record<Priority, BadgeTone> = {
  high: 'red',
  normal: 'blue',
  low: 'neutral',
};
