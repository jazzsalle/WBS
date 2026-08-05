// 칸반 보드 · 우선순위 매트릭스의 순수 함수 (SOT §7.6, §6.9)
//
// 점수·등급 공식(importance × urgency, 15/8/4 경계)은 lib/priority.ts가 원본이다.
// 여기서도 화면에서도 다시 쓰지 않는다 (O-4와 같은 이유 — 두 곳에 규칙이 생기면
// 매트릭스의 셀 색과 목록의 뱃지가 언젠가 어긋난다).
// 파생 값은 저장하지 않는다 (PR-7).
//
// 단위 테스트: tests/unit/board.test.ts

import { computePriorityScore, priorityGrade, type PriorityGrade, type PriorityLevel } from './priority';
import type { TaskStatus } from '@/types';

/** §7.6 "컬럼 4개 고정". 표시 순서도 이 배열이 정한다. */
export const BOARD_COLUMNS = [
  'todo',
  'in_progress',
  'done',
  'blocked',
] as const satisfies readonly TaskStatus[];

export const PRIORITY_LEVELS = [1, 2, 3, 4, 5] as const satisfies readonly PriorityLevel[];

/** 연차 필터의 "전체 연차" 값. URL(?yearId=)과 조회 인자에 같은 문자열을 쓴다 */
export const BOARD_ALL_YEARS = 'all';

// 셀 좌표의 점수는 기준일과 무관하다 — 긴급도가 좌표로 고정돼 있어 computeUrgency의
// manual 분기가 그대로 돌려준다. 그래도 공식을 여기서 다시 쓰지 않으려고 계산은
// lib/priority.ts에 맡기고, 보지 않는 기준일만 상수로 넘긴다.
const CELL_TODAY = '2000-01-01';

/** 매트릭스 한 칸의 점수 = 그 칸의 중요도 × 긴급도 */
export function priorityCellScore(importance: PriorityLevel, urgency: PriorityLevel): number {
  return computePriorityScore(
    { importance, urgencyMode: 'manual', urgencyManual: urgency, status: 'todo', dueDate: null },
    CELL_TODAY
  );
}

/** 셀 집계에 필요한 최소 입력. urgency는 서버가 §6.9.1로 이미 계산한 값이다 */
export interface MatrixItemInput {
  id: string;
  importance: PriorityLevel;
  urgency: PriorityLevel;
  /** PR-6: 완료 항목은 기본 숨김이라 셀 개수도 따로 센다 */
  done: boolean;
}

/** 5×5 히트맵 한 칸 (§7.6: 가로 긴급도, 세로 중요도, 셀에 작업 개수) */
export interface PriorityMatrixCell {
  importance: PriorityLevel;
  urgency: PriorityLevel;
  score: number;
  grade: PriorityGrade;
  /** 부록 A.3 PRIORITY_SCORE_COLORS의 색상 토큰. 화면은 토큰 → 클래스 매핑만 한다 */
  colorToken: string;
  /** 미완료 작업 id — 기본 표시 대상 */
  activeIds: string[];
  /** 완료 작업 id — "완료 표시" 토글에서만 더한다 (PR-6) */
  doneIds: string[];
}

/**
 * 25칸을 만들고 작업을 나눠 담는다. 순서는 중요도 5→1(위에서 아래), 긴급도 1→5(왼→오른)로
 * §7.6의 축 배치 그대로다 — 리스크 매트릭스(§7.11)와 같은 규칙이다.
 * 1~5를 벗어난 값은 조용히 버리지 않는다: 셀이 없으면 예외로 드러낸다 (절대 규칙 5).
 */
export function buildPriorityCells(items: readonly MatrixItemInput[]): PriorityMatrixCell[] {
  const cells: PriorityMatrixCell[] = [];
  for (const importance of [...PRIORITY_LEVELS].reverse()) {
    for (const urgency of PRIORITY_LEVELS) {
      const score = priorityCellScore(importance, urgency);
      const { grade, color } = priorityGrade(score);
      cells.push({
        importance,
        urgency,
        score,
        grade,
        colorToken: color,
        activeIds: [],
        doneIds: [],
      });
    }
  }

  const byKey = new Map(cells.map((cell) => [cellKey(cell.importance, cell.urgency), cell]));
  for (const item of items) {
    const cell = byKey.get(cellKey(item.importance, item.urgency));
    if (!cell) {
      throw new RangeError(
        `작업 ${item.id}의 중요도·긴급도가 1~5 범위를 벗어났습니다: ${item.importance} × ${item.urgency}`
      );
    }
    (item.done ? cell.doneIds : cell.activeIds).push(item.id);
  }

  return cells;
}

export function cellKey(importance: number, urgency: number): string {
  return `${importance}:${urgency}`;
}

/**
 * 재정렬 컨테이너 키. reorderTasks(§9, X-3)는 (yearId, parentId) 단위로 0..n-1을 다시 매기므로
 * 컬럼 안에서 순서를 바꿀 때도 이 단위가 같아야 한다.
 */
export function containerKey(yearId: string, parentId: string | null): string {
  return `${yearId}|${parentId ?? ''}`;
}

export type DropPosition = 'before' | 'after';

/**
 * 컨테이너의 전체 형제 순서에서 movedId를 targetId의 앞/뒤로 옮긴 새 순서를 만든다.
 * reorderTasks에는 **컨테이너의 자식 전체**를 넘겨야 하므로(X-3) 화면에 보이는 일부만
 * 재배열하면 안 된다. 대상이 목록에 없으면 null — 호출자가 실패로 알린다 (절대 규칙 5).
 */
export function reorderIds(
  ids: readonly string[],
  movedId: string,
  targetId: string,
  position: DropPosition
): string[] | null {
  if (movedId === targetId) return null;
  if (!ids.includes(movedId) || !ids.includes(targetId)) return null;

  const rest = ids.filter((id) => id !== movedId);
  const at = rest.indexOf(targetId);
  if (at < 0) return null;
  const insertAt = position === 'before' ? at : at + 1;
  return [...rest.slice(0, insertAt), movedId, ...rest.slice(insertAt)];
}
