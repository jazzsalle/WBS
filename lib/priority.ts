// 긴급도 자동 계산과 우선순위 점수·등급 (SOT §6.9)
// PR-7: priorityScore와 computedUrgency는 저장하지 않는다. 마감일이 바뀌면
// 따라 변해야 하므로 읽을 때마다 계산한다.

import { PRIORITY_SCORE_COLORS } from './constants';
import { daysBetween } from './dates';
import type { Task } from '@/types';

export type PriorityLevel = Task['importance'];
export type PriorityGrade = (typeof PRIORITY_SCORE_COLORS)[number]['grade'];

// computeUrgency에 필요한 최소 입력
export type UrgencyInput = Pick<
  Task,
  'urgencyMode' | 'urgencyManual' | 'status' | 'dueDate'
>;

export type PriorityInput = UrgencyInput & Pick<Task, 'importance'>;

// §6.9.1 의사코드의 분기 순서를 그대로 따른다. 순서가 바뀌면 PR-4(수동 고정)가
// done·마감 분기에 먹혀버린다.
export function computeUrgency(task: UrgencyInput, todayISO: string): PriorityLevel {
  if (task.urgencyMode === 'manual') return task.urgencyManual;
  if (task.status === 'done') return 1;
  if (task.dueDate === null) return 2; // 마감이 없으면 서두를 근거가 없다

  const d = daysBetween(todayISO, task.dueDate);
  if (d < 0) return 5; // 지연
  if (d <= 3) return 5; // 임박
  if (d <= 7) return 4;
  if (d <= 14) return 3;
  if (d <= 30) return 2;
  return 1;
}

// §6.9.2: priorityScore = importance × urgency (1 ~ 25)
export function computePriorityScore(task: PriorityInput, todayISO: string): number {
  return task.importance * computeUrgency(task, todayISO);
}

// 등급표는 부록 A.3(lib/constants.ts)이 원본이다. 여기서 다시 정의하지 않는다.
export function priorityGrade(score: number): { grade: PriorityGrade; color: string } {
  const band = PRIORITY_SCORE_COLORS.find((b) => score >= b.min && score <= b.max);
  // 1~25 밖의 점수는 계산이 깨졌다는 뜻이다 — 조용히 기본 등급을 주지 않는다
  if (!band) {
    throw new RangeError(`우선순위 점수가 1~25 범위를 벗어났습니다: ${score}`);
  }
  return { grade: band.grade, color: band.color };
}

// 점수 내림차순. PR-6: 완료 작업은 점수와 무관하게 최후순위로 보낸다.
export function comparePriority(
  a: PriorityInput,
  b: PriorityInput,
  todayISO: string
): number {
  const aDone = a.status === 'done';
  const bDone = b.status === 'done';
  if (aDone !== bDone) return aDone ? 1 : -1;
  return computePriorityScore(b, todayISO) - computePriorityScore(a, todayISO);
}
