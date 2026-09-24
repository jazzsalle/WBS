// 보드·우선순위 매트릭스 순수 함수 (SOT §7.6, §6.9, 부록 B.0)
// 점수·등급은 lib/priority.ts가 원본이므로 여기서는 "매트릭스 좌표가 부록 B.0과 같은
// 점수·등급을 내는가"와 "셀 분배·재정렬이 규칙대로인가"만 확인한다.

import { describe, expect, it } from 'vitest';
import {
  BOARD_COLUMNS,
  buildPriorityCells,
  containerKey,
  priorityCellScore,
  reorderIds,
  type MatrixItemInput,
} from '@/lib/board';

describe('BOARD_COLUMNS', () => {
  it('§7.6 컬럼 4개를 고정 순서로 유지한다', () => {
    expect(BOARD_COLUMNS).toEqual(['todo', 'in_progress', 'done', 'blocked']);
  });
});

describe('priorityCellScore — 부록 B.0', () => {
  it.each([
    [5, 5, 25],
    [4, 4, 16],
    [3, 5, 15],
    [2, 2, 4],
    [3, 2, 6],
    [4, 1, 4],
  ] as const)('중요도 %i × 긴급도 %i = %i', (importance, urgency, expected) => {
    expect(priorityCellScore(importance, urgency)).toBe(expected);
  });
});

describe('buildPriorityCells', () => {
  it('25칸을 중요도 5→1, 긴급도 1→5 순으로 만든다', () => {
    const cells = buildPriorityCells([]);
    expect(cells).toHaveLength(25);
    expect(cells[0]).toMatchObject({ importance: 5, urgency: 1 });
    expect(cells[4]).toMatchObject({ importance: 5, urgency: 5 });
    expect(cells[24]).toMatchObject({ importance: 1, urgency: 5 });
  });

  it('부록 B.0의 등급 경계를 셀 색상 토큰이 그대로 따른다', () => {
    const cells = buildPriorityCells([]);
    const at = (importance: number, urgency: number) =>
      cells.find((c) => c.importance === importance && c.urgency === urgency)!;

    expect(at(3, 5)).toMatchObject({ score: 15, grade: '최우선', colorToken: 'red-600' });
    expect(at(3, 4)).toMatchObject({ score: 12, grade: '높음', colorToken: 'orange-500' });
    expect(at(3, 2)).toMatchObject({ score: 6, grade: '보통', colorToken: 'grey-500' });
    expect(at(1, 3)).toMatchObject({ score: 3, grade: '낮음', colorToken: 'grey-400' });
  });

  it('PR-6: 완료 작업은 별도 목록에 담아 셀 개수를 토글할 수 있게 한다', () => {
    const items: MatrixItemInput[] = [
      { id: 'a', importance: 5, urgency: 5, done: false },
      { id: 'b', importance: 5, urgency: 5, done: true },
      { id: 'c', importance: 1, urgency: 1, done: false },
    ];
    const cells = buildPriorityCells(items);
    const top = cells.find((c) => c.importance === 5 && c.urgency === 5)!;
    expect(top.activeIds).toEqual(['a']);
    expect(top.doneIds).toEqual(['b']);
    expect(cells.find((c) => c.importance === 1 && c.urgency === 1)!.activeIds).toEqual(['c']);
  });

  it('1~5를 벗어난 값은 조용히 버리지 않고 드러낸다', () => {
    expect(() =>
      buildPriorityCells([{ id: 'x', importance: 6 as 5, urgency: 1, done: false }])
    ).toThrow(RangeError);
  });
});

describe('containerKey', () => {
  it('연차 루트와 자식 컨테이너를 구분한다', () => {
    expect(containerKey('y1', null)).not.toBe(containerKey('y1', 'p1'));
    expect(containerKey('y1', null)).toBe(containerKey('y1', null));
  });
});

describe('reorderIds', () => {
  const ids = ['a', 'b', 'c', 'd'];

  it('대상 앞으로 옮긴다', () => {
    expect(reorderIds(ids, 'd', 'b', 'before')).toEqual(['a', 'd', 'b', 'c']);
  });

  it('대상 뒤로 옮긴다', () => {
    expect(reorderIds(ids, 'a', 'c', 'after')).toEqual(['b', 'c', 'a', 'd']);
  });

  it('컨테이너 전체를 그대로 유지한다 (X-3: 일부만 넘기면 순서가 깨진다)', () => {
    const next = reorderIds(ids, 'a', 'd', 'after')!;
    expect([...next].sort()).toEqual([...ids].sort());
  });

  it('자기 자신이나 목록에 없는 대상은 null', () => {
    expect(reorderIds(ids, 'a', 'a', 'before')).toBeNull();
    expect(reorderIds(ids, 'a', 'z', 'before')).toBeNull();
    expect(reorderIds(ids, 'z', 'a', 'before')).toBeNull();
  });
});
