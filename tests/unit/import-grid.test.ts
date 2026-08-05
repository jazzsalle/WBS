// 그리드 전처리 — S-11 병합 확장, S-2 carry-forward + 리셋, S-2' 미매핑 배제 (SOT §6.8.2)

import { describe, expect, it } from 'vitest';
import { isCarryForwardable } from '@/lib/import/categorize';
import {
  buildLabelGrid,
  cellAt,
  cellText,
  expandMerges,
  gridWidth,
  normalizeGrid,
} from '@/lib/import/grid';
import type { MergeRange, RawCell, RawSheet } from '@/lib/import/types';

const cell = (value: RawCell['value']): RawCell => ({ value, isError: false });

function sheetOf(rows: (string | number | null)[][], merges: MergeRange[] = []): RawSheet {
  return { name: 'S', cells: rows.map((row) => row.map((v) => cell(v))), merges };
}

const carryable = (raw: string) => isCarryForwardable(raw);

/** 라벨 열 A~D(0~3)의 유효 라벨 */
function labelsOf(sheet: RawSheet, startRow: number, endRow: number) {
  const expanded = expandMerges(sheet);
  return buildLabelGrid(expanded.cells, [0, 1, 2, 3], startRow, endRow, carryable).effective;
}

describe('cellText', () => {
  it('에러 셀은 원문(#REF!)을 그대로 돌려준다 — 미리보기에 보여야 한다', () => {
    expect(cellText({ value: null, isError: true, errorText: '#REF!' })).toBe('#REF!');
  });

  it('숫자·불리언도 문자열로 읽는다', () => {
    expect(cellText(cell(1234))).toBe('1234');
    expect(cellText(cell(null))).toBe('');
    expect(cellText(undefined)).toBe('');
  });
});

describe('normalizeGrid / cellAt', () => {
  it('들쭉날쭉한 행 길이를 맞춘다', () => {
    const grid = normalizeGrid([[cell('a')], [cell('b'), cell('c'), cell('d')]]);
    expect(gridWidth(grid)).toBe(3);
    expect(cellText(grid[0]![2])).toBe('');
  });

  it('범위 밖은 빈 셀이다 (예외를 던지지 않는다)', () => {
    expect(cellText(cellAt([[cell('a')]], 9, 9))).toBe('');
  });
});

describe('expandMerges — S-11', () => {
  it('병합 범위 안 모든 셀을 좌상단 값으로 채운다', () => {
    const sheet = sheetOf(
      [
        ['비고', null, null],
        ['a', 'b', 'c'],
      ],
      [{ s: { r: 0, c: 0 }, e: { r: 0, c: 2 } }]
    );
    const expanded = expandMerges(sheet);
    expect(expanded.cells[0]!.map((c) => cellText(c))).toEqual(['비고', '비고', '비고']);
  });

  it('세로 병합도 펼친다', () => {
    const sheet = sheetOf(
      [['직접비', 'x'], [null, 'y'], [null, 'z']],
      [{ s: { r: 0, c: 0 }, e: { r: 2, c: 0 } }]
    );
    const expanded = expandMerges(sheet);
    expect(expanded.cells.map((row) => cellText(row[0]))).toEqual(['직접비', '직접비', '직접비']);
  });

  it('원본 시트를 변형하지 않는다', () => {
    const sheet = sheetOf([['a', null]], [{ s: { r: 0, c: 0 }, e: { r: 0, c: 1 } }]);
    expandMerges(sheet);
    expect(cellText(sheet.cells[0]![1])).toBe('');
  });

  it('잘못된 병합 범위는 무시한다', () => {
    const sheet = sheetOf([['a', 'b']], [{ s: { r: 2, c: 2 }, e: { r: 0, c: 0 } }]);
    expect(expandMerges(sheet).cells[0]!.map((c) => cellText(c))).toEqual(['a', 'b']);
  });
});

describe('buildLabelGrid — S-2 carry-forward', () => {
  it('라벨 열의 빈 셀은 위 행 값을 승계한다', () => {
    const sheet = sheetOf([
      ['직접비', '인건비', '내부인건비 (A)', '현금'],
      [null, null, null, '현물'],
    ]);
    expect(labelsOf(sheet, 0, 1)[1]).toEqual(['직접비', '인건비', '내부인건비 (A)', '현물']);
  });

  it('리셋: 왼쪽 열에 새 값이 나타나면 오른쪽 승계가 초기화된다', () => {
    const sheet = sheetOf([
      ['직접비', '인건비', '내부인건비 (A)', '현금'],
      [null, null, null, '현물'],
      ['간접비 (L)', null, null, null],
    ]);
    // `간접비` 행이 직전 행의 `현물`·`내부인건비`를 물려받으면 안 된다
    expect(labelsOf(sheet, 0, 2)[2]).toEqual(['간접비 (L)', '', '', '']);
  });

  it('병합으로 같은 값이 반복되는 것은 새 값이 아니다 (S-11 단서)', () => {
    const sheet = sheetOf(
      [
        ['직접비', '인건비', '내부인건비 (A)', '현금'],
        [null, null, null, '현물'],
      ],
      // B열(0)이 두 행에 걸쳐 병합돼 확장 후 같은 값이 반복된다
      [{ s: { r: 0, c: 0 }, e: { r: 1, c: 0 } }]
    );
    expect(labelsOf(sheet, 0, 1)[1]).toEqual(['직접비', '인건비', '내부인건비 (A)', '현물']);
  });
});

describe("buildLabelGrid — S-2' 미매핑 라벨은 승계하지 않는다", () => {
  it('세로쓰기 조각 `직`/`접`/`비`는 아래 행으로 번지지 않는다', () => {
    const sheet = sheetOf([
      ['직', null, '내부인건비 (A)', '현금'],
      ['접', null, null, '현물'],
      ['비', null, '외부인건비 (B)', '현금'],
      [null, null, null, '현물'],
    ]);
    const labels = labelsOf(sheet, 0, 3);

    // 그 행 자신의 라벨로는 보이지만
    expect(labels[0]![0]).toBe('직');
    expect(labels[2]![0]).toBe('비');
    // 아래로는 흐르지 않는다
    expect(labels[3]![0]).toBe('');
  });

  it('세로쓰기 조각은 리셋 판정에도 끼지 않는다 — 우측 라벨의 승계가 끊기면 안 된다', () => {
    const sheet = sheetOf([
      ['직', null, '내부인건비 (A)', '현금'],
      ['접', null, null, '현물'],
    ]);
    // `접`이 "새 값"으로 취급되면 D열의 `내부인건비` 승계가 초기화돼 현물 행이 미매핑된다.
    // 자기 행의 셀 값이므로 라벨 자리에는 그대로 남지만(S-12가 우측 우선으로 무시한다),
    // 오른쪽 열의 승계를 끊어서는 안 된다.
    expect(labelsOf(sheet, 0, 1)[1]).toEqual(['접', '', '내부인건비 (A)', '현물']);
  });

  it('정규화 후 빈 라벨(`(G)`)도 승계 대상이 아니다', () => {
    const sheet = sheetOf([
      [null, '연구재료비', null, '현금'],
      [null, '(G)', null, '현물'],
      [null, null, null, null],
    ]);
    const labels = labelsOf(sheet, 0, 2);
    expect(labels[1]![1]).toBe('(G)');
    // `(G)`가 아니라 마지막으로 판정에 성공한 `연구재료비`가 남는다
    expect(labels[2]![1]).toBe('연구재료비');
  });
});
