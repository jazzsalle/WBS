// 긴급도·우선순위 점수·등급 테스트 (SOT §6.9, 부록 B.0)
// 오늘은 항상 인자로 고정한다 — 실행 시각에 결과가 흔들리면 안 된다.

import { describe, expect, it } from 'vitest';
import {
  comparePriority,
  computePriorityScore,
  computeUrgency,
  priorityGrade,
  type PriorityInput,
} from '@/lib/priority';
import type { Task } from '@/types';

const TODAY = '2026-08-02';

function t(over: Partial<PriorityInput> = {}): PriorityInput {
  // PR-1 기본값: importance=3, urgencyMode='auto'
  return {
    importance: 3,
    urgencyMode: 'auto',
    urgencyManual: 3,
    status: 'todo',
    dueDate: null,
    ...over,
  };
}

// 오늘로부터 offset일 뒤의 ISO 날짜 (UTC 자정 기준 — 달력일만 쓴다)
function dueIn(offsetDays: number): string {
  const base = Date.UTC(2026, 7, 2) + offsetDays * 24 * 60 * 60 * 1000;
  return new Date(base).toISOString().slice(0, 10);
}

describe('computeUrgency (§6.9.1)', () => {
  it('완료 작업은 1', () => {
    expect(computeUrgency(t({ status: 'done', dueDate: dueIn(-30) }), TODAY)).toBe(1);
  });

  it('마감이 없으면 2', () => {
    expect(computeUrgency(t({ dueDate: null }), TODAY)).toBe(2);
  });

  it('지연(d<0)은 5', () => {
    expect(computeUrgency(t({ dueDate: dueIn(-1) }), TODAY)).toBe(5);
    expect(computeUrgency(t({ dueDate: dueIn(-100) }), TODAY)).toBe(5);
  });

  it('경계값 d = 0,3,4,7,8,14,15,30,31 → 5,5,4,4,3,3,2,2,1', () => {
    const expected: Array<[number, number]> = [
      [0, 5],
      [3, 5],
      [4, 4],
      [7, 4],
      [8, 3],
      [14, 3],
      [15, 2],
      [30, 2],
      [31, 1],
    ];
    for (const [d, urgency] of expected) {
      expect(computeUrgency(t({ dueDate: dueIn(d) }), TODAY), `d=${d}`).toBe(urgency);
    }
  });

  it('PR-4: manual 고정이면 마감이 지나도 수동 값을 유지한다', () => {
    const manual = t({ urgencyMode: 'manual', urgencyManual: 2, dueDate: dueIn(-30) });
    expect(computeUrgency(manual, TODAY)).toBe(2);
  });

  it('PR-4: manual은 done·마감없음보다 우선한다 (분기 순서)', () => {
    expect(
      computeUrgency(t({ urgencyMode: 'manual', urgencyManual: 5, status: 'done' }), TODAY)
    ).toBe(5);
    expect(
      computeUrgency(t({ urgencyMode: 'manual', urgencyManual: 4, dueDate: null }), TODAY)
    ).toBe(4);
  });

  it('blocked·in_progress는 마감 기반 계산을 그대로 따른다 (PR-5는 표시 규칙)', () => {
    for (const status of ['todo', 'in_progress', 'blocked'] as const) {
      expect(computeUrgency(t({ status, dueDate: dueIn(5) }), TODAY)).toBe(4);
    }
  });
});

describe('priorityGrade (§6.9.2)', () => {
  it('구간별 등급·색상', () => {
    expect(priorityGrade(25)).toEqual({ grade: '최우선', color: 'red-600' });
    expect(priorityGrade(15)).toEqual({ grade: '최우선', color: 'red-600' });
    expect(priorityGrade(14)).toEqual({ grade: '높음', color: 'amber-500' });
    expect(priorityGrade(8)).toEqual({ grade: '높음', color: 'amber-500' });
    expect(priorityGrade(7)).toEqual({ grade: '보통', color: 'slate-500' });
    expect(priorityGrade(4)).toEqual({ grade: '보통', color: 'slate-500' });
    expect(priorityGrade(3)).toEqual({ grade: '낮음', color: 'slate-400' });
    expect(priorityGrade(1)).toEqual({ grade: '낮음', color: 'slate-400' });
  });

  it('등급 경계 3/4, 7/8, 14/15에서 전환한다', () => {
    expect(priorityGrade(3).grade).toBe('낮음');
    expect(priorityGrade(4).grade).toBe('보통');
    expect(priorityGrade(7).grade).toBe('보통');
    expect(priorityGrade(8).grade).toBe('높음');
    expect(priorityGrade(14).grade).toBe('높음');
    expect(priorityGrade(15).grade).toBe('최우선');
  });

  it('1~25 밖의 점수는 조용히 넘기지 않는다', () => {
    expect(() => priorityGrade(0)).toThrow(RangeError);
    expect(() => priorityGrade(26)).toThrow(RangeError);
  });
});

describe('computePriorityScore — 부록 B.0 표', () => {
  const cases: Array<{
    label: string;
    task: PriorityInput;
    urgency: number;
    score: number;
    grade: string;
  }> = [
    {
      label: '학습·튜닝 (기술목표 연계) — 중요도 5 / 2일 후',
      task: t({ importance: 5, dueDate: '2026-08-04' }),
      urgency: 5,
      score: 25,
      grade: '최우선',
    },
    {
      label: '중간보고서 초안 — 중요도 4 / 5일 후',
      task: t({ importance: 4, dueDate: '2026-08-07' }),
      urgency: 4,
      score: 16,
      grade: '최우선',
    },
    {
      label: '데이터 정제 — 중요도 3 / 7일 전(지연)',
      task: t({ importance: 3, dueDate: '2026-07-26' }),
      urgency: 5,
      score: 15,
      grade: '최우선',
    },
    {
      label: '문헌 추가조사 — 중요도 2 / 20일 후',
      task: t({ importance: 2, dueDate: '2026-08-22' }),
      urgency: 2,
      score: 4,
      grade: '보통',
    },
    {
      label: '코드 리팩터링 — 중요도 3 / 마감 없음',
      task: t({ importance: 3, dueDate: null }),
      urgency: 2,
      score: 6,
      grade: '보통',
    },
    {
      label: '요구사항 정의 (완료) — 중요도 4 / 지난달 마감',
      task: t({ importance: 4, dueDate: '2026-07-05', status: 'done' }),
      urgency: 1,
      score: 4,
      grade: '보통', // PR-6은 표시·정렬만 바꾸고 등급은 그대로다
    },
  ];

  for (const c of cases) {
    it(c.label, () => {
      expect(computeUrgency(c.task, TODAY)).toBe(c.urgency);
      expect(computePriorityScore(c.task, TODAY)).toBe(c.score);
      expect(priorityGrade(c.score).grade).toBe(c.grade);
    });
  }
});

describe('comparePriority (PR-6)', () => {
  it('점수 내림차순으로 정렬한다', () => {
    const high = t({ importance: 5, dueDate: dueIn(1) }); // 25
    const mid = t({ importance: 4, dueDate: dueIn(5) }); // 16
    const low = t({ importance: 2, dueDate: dueIn(20) }); // 4

    const sorted = [low, high, mid].sort((a, b) => comparePriority(a, b, TODAY));
    expect(sorted.map((x) => computePriorityScore(x, TODAY))).toEqual([25, 16, 4]);
  });

  it('완료 작업은 점수가 높아도 최후순위다', () => {
    const doneHigh = t({
      importance: 5,
      urgencyMode: 'manual',
      urgencyManual: 5,
      status: 'done',
    }); // 25점이지만 done
    const openLow = t({ importance: 1, dueDate: dueIn(60) }); // 1점

    expect(comparePriority(doneHigh, openLow, TODAY)).toBeGreaterThan(0);
    expect(comparePriority(openLow, doneHigh, TODAY)).toBeLessThan(0);

    const sorted = [doneHigh, openLow].sort((a, b) => comparePriority(a, b, TODAY));
    expect(sorted[0]).toBe(openLow);
  });

  it('완료끼리는 점수 내림차순을 유지한다', () => {
    const a = t({ importance: 5, urgencyMode: 'manual', urgencyManual: 4, status: 'done' }); // 20
    const b = t({ importance: 2, urgencyMode: 'manual', urgencyManual: 2, status: 'done' }); // 4
    expect(comparePriority(b, a, TODAY)).toBeGreaterThan(0);
  });

  it('점수가 같으면 0을 반환해 입력 순서를 보존한다', () => {
    const a = t({ importance: 3, dueDate: dueIn(2) });
    const b = t({ importance: 3, dueDate: dueIn(1) });
    expect(comparePriority(a, b, TODAY)).toBe(0);
  });
});

// PriorityInput이 Task의 부분집합인지 컴파일 타임에 확인한다
describe('타입 계약', () => {
  it('Task를 그대로 넘길 수 있다', () => {
    const task = {
      importance: 4,
      urgencyMode: 'auto',
      urgencyManual: 3,
      status: 'in_progress',
      dueDate: '2026-08-06',
    } satisfies Pick<Task, keyof PriorityInput>;
    expect(computePriorityScore(task, TODAY)).toBe(16);
  });
});
