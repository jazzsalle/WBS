// 작업 상세 패널의 낙관적 잠금 비교 로직 테스트 (SOT §8.4 O-1·O-3)
// O-3의 핵심은 "입력값을 유지한 채 비교 UI를 보여준다"이다. 비교 산출이 틀리면
// 확인하지 않은 충돌이 그대로 저장돼 남의 수정이 조용히 사라진다.

import { describe, expect, it } from 'vitest';
import type { Task } from '@/types';
import {
  DETAIL_FIELDS,
  adoptLatestValue,
  buildUpdatePatch,
  diffDetailValues,
  displayDetailValue,
  toDetailFormValues,
  unresolvedConflicts,
  type DetailFieldKey,
} from '@/components/wbs/conflict';

function makeTask(patch: Partial<Task> = {}): Task {
  return {
    id: 'task-1',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    version: 1,
    createdBy: null,
    updatedBy: null,
    projectId: 'project-1',
    yearId: 'year-1',
    parentId: null,
    order: 0,
    title: '데이터 구축',
    description: '수집·정제',
    status: 'in_progress',
    progressMode: 'manual',
    manualProgress: 30,
    estimatedHours: 40,
    actualHours: null,
    startDate: '2026-03-01',
    dueDate: '2026-06-30',
    importance: 3,
    urgencyMode: 'auto',
    urgencyManual: 3,
    ownerMemberId: null,
    memberIds: [],
    orgId: null,
    deliverableIds: [],
    techTargetIds: [],
    tags: ['데이터'],
    ...patch,
  };
}

describe('toDetailFormValues', () => {
  it('null 값은 빈 문자열로, 태그는 쉼표 문자열로 옮긴다', () => {
    const values = toDetailFormValues(makeTask({ actualHours: null, dueDate: null, tags: ['a', 'b'] }));
    expect(values.actualHours).toBe('');
    expect(values.dueDate).toBe('');
    expect(values.estimatedHours).toBe('40');
    expect(values.tags).toBe('a, b');
  });

  it('같은 Task에서 만든 값끼리는 상이 항목이 없다', () => {
    const task = makeTask();
    expect(diffDetailValues(toDetailFormValues(task), toDetailFormValues(task))).toEqual([]);
  });
});

describe('diffDetailValues', () => {
  it('서버가 바꾼 필드와 내가 바꾼 필드를 모두 잡아낸다', () => {
    // 상대가 마감일과 상태를 고쳤고, 나는 제목을 고쳤다
    const latest = toDetailFormValues(makeTask({ dueDate: '2026-07-31', status: 'blocked' }));
    const mine = { ...toDetailFormValues(makeTask()), title: '데이터 구축(개정)' };

    expect(diffDetailValues(latest, mine).sort()).toEqual(['dueDate', 'status', 'title']);
  });

  it('숫자 척도(중요도·고정 긴급도)의 차이도 잡는다', () => {
    const latest = toDetailFormValues(makeTask({ importance: 5, urgencyManual: 4 }));
    const mine = toDetailFormValues(makeTask({ importance: 3, urgencyManual: 3 }));
    expect(diffDetailValues(latest, mine).sort()).toEqual(['importance', 'urgencyManual']);
  });

  it('DETAIL_FIELDS에 없는 필드는 비교하지 않는다 (파생·읽기 전용 값 제외)', () => {
    const keys = DETAIL_FIELDS.map((f) => f.key);
    expect(keys).not.toContain('version' as DetailFieldKey);
    expect(keys).not.toContain('manualProgress' as DetailFieldKey);
  });
});

describe('adoptLatestValue', () => {
  it('고른 항목만 최신 값으로 바꾸고 나머지 입력은 그대로 둔다 (O-3)', () => {
    const latest = toDetailFormValues(makeTask({ dueDate: '2026-07-31', status: 'blocked' }));
    const mine = { ...toDetailFormValues(makeTask()), title: '내가 쓰던 제목' };

    const next = adoptLatestValue(mine, latest, 'dueDate');

    expect(next.dueDate).toBe('2026-07-31');
    expect(next.title).toBe('내가 쓰던 제목'); // 입력값을 날리지 않는다
    expect(next.status).toBe(mine.status); // 고르지 않은 항목은 유지
  });

  it('최신 값을 받아들이면 그 항목은 비교 목록에서 사라진다', () => {
    const latest = toDetailFormValues(makeTask({ dueDate: '2026-07-31' }));
    const mine = toDetailFormValues(makeTask());

    expect(diffDetailValues(latest, mine)).toEqual(['dueDate']);
    expect(diffDetailValues(latest, adoptLatestValue(mine, latest, 'dueDate'))).toEqual([]);
  });
});

describe('unresolvedConflicts', () => {
  it('확인하지 않은 항목이 하나라도 있으면 남는다 (저장 차단 조건)', () => {
    const diff: DetailFieldKey[] = ['title', 'dueDate', 'status'];
    expect(unresolvedConflicts(diff, new Set<DetailFieldKey>(['title']))).toEqual([
      'dueDate',
      'status',
    ]);
  });

  it('내 입력을 유지하기로 고른 항목은 확인된 것으로 본다', () => {
    const diff: DetailFieldKey[] = ['title', 'dueDate'];
    expect(unresolvedConflicts(diff, new Set<DetailFieldKey>(['title', 'dueDate']))).toEqual([]);
  });

  it('비교할 항목이 없으면 확인할 것도 없다', () => {
    expect(unresolvedConflicts([], new Set<DetailFieldKey>())).toEqual([]);
  });
});

describe('buildUpdatePatch — 저장 payload와 비교 대상의 불변식', () => {
  // 이 테스트가 깨지면 "비교되지 않는 필드가 조용히 덮어써지는" 구멍이 생긴 것이다 (O-3)
  it('저장 payload의 키 집합은 비교 필드(DETAIL_FIELDS)와 정확히 같다', () => {
    const built = buildUpdatePatch(toDetailFormValues(makeTask()));
    if (!built.ok) throw new Error(built.message);

    expect(Object.keys(built.patch).sort()).toEqual(DETAIL_FIELDS.map((f) => f.key).sort());
  });

  it('비교 필드 목록은 폼 값의 키를 하나도 빠뜨리지 않는다', () => {
    const formKeys = Object.keys(toDetailFormValues(makeTask())).sort();
    expect(DETAIL_FIELDS.map((f) => f.key).sort()).toEqual(formKeys);
  });

  it('빈 문자열은 null로, 태그는 배열로, 제목은 trim해서 보낸다', () => {
    const values = {
      ...toDetailFormValues(makeTask()),
      title: '  데이터 구축  ',
      dueDate: '',
      actualHours: '',
      estimatedHours: '0',
      tags: ' 데이터 , 정제 ,, ',
    };
    const built = buildUpdatePatch(values);
    if (!built.ok) throw new Error(built.message);

    expect(built.patch.title).toBe('데이터 구축');
    expect(built.patch.dueDate).toBeNull();
    expect(built.patch.actualHours).toBeNull();
    expect(built.patch.estimatedHours).toBe(0); // 0은 "값 없음"이 아니다
    expect(built.patch.tags).toEqual(['데이터', '정제']);
  });

  it('잘못된 입력은 저장하지 않고 사용자에게 보여줄 문구로 되돌린다', () => {
    const base = toDetailFormValues(makeTask());

    expect(buildUpdatePatch({ ...base, title: '   ' })).toEqual({
      ok: false,
      message: '작업명을 입력하세요.',
    });
    expect(buildUpdatePatch({ ...base, estimatedHours: '열 시간' })).toEqual({
      ok: false,
      message: '예상 공수는 숫자로 입력하세요.',
    });
    // P-7: 음수 공수는 가중 평균을 뒤집는다
    expect(buildUpdatePatch({ ...base, actualHours: '-1' })).toEqual({
      ok: false,
      message: '실적 공수는 0 이상이어야 합니다.',
    });
  });
});

describe('displayDetailValue', () => {
  it('enum은 한글 라벨로, 빈 값은 —로 보여 "지웠다"를 구분한다', () => {
    const values = toDetailFormValues(makeTask({ status: 'blocked', dueDate: null, urgencyMode: 'manual' }));
    expect(displayDetailValue('status', values)).toBe('막힘');
    expect(displayDetailValue('dueDate', values)).toBe('—');
    expect(displayDetailValue('urgencyMode', values)).toBe('고정(수동)');
    expect(displayDetailValue('importance', values)).toBe('3');
  });
});
