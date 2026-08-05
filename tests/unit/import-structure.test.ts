// 구조 감지 — 헤더 행·데이터 범위·라벨 열·연차 열(S-5)·금액 단위(I-10)·시트 추천(S-13)·행 상한(I-15)
// 실측 파일에 의존하지 않는다 — 부록 B.6의 구조를 본뜬 합성 픽스처를 쓴다.

import { describe, expect, it } from 'vitest';
import {
  MAX_IMPORT_ROWS,
  checkRowLimit,
  detectDataRange,
  detectHeaderRow,
  detectLabelColumns,
  detectOrientation,
  detectStructure,
  detectYearColumns,
  isTotalColumnLabel,
  parseYearOrderFromLabel,
  recommendSheet,
  scoreSheet,
} from '@/lib/import/structure';
import { expandMerges } from '@/lib/import/grid';
import type { MergeRange, RawCell, RawSheet } from '@/lib/import/types';

type CellSpec = string | number | null;

function sheetOf(name: string, rows: CellSpec[][], merges: MergeRange[] = []): RawSheet {
  const cells: RawCell[][] = rows.map((row) => row.map((value) => ({ value, isError: false })));
  return { name, cells, merges };
}

describe('parseYearOrderFromLabel — S-5', () => {
  it.each([
    ['1차년도', 0],
    ['2차년도', 1],
    ['3 차 년 도', 2],
    ['제4차연도', 3],
    ['1년차', 0],
    ['1차년도(2026)', 0],
  ])('%s → order %i', (label, order) => {
    expect(parseYearOrderFromLabel(label)).toBe(order);
  });

  it('`N단계` 그룹 헤더는 연차가 아니다', () => {
    expect(parseYearOrderFromLabel('1단계')).toBeNull();
    expect(parseYearOrderFromLabel('2단계')).toBeNull();
  });

  it('연차가 아닌 라벨은 null', () => {
    expect(parseYearOrderFromLabel('비목')).toBeNull();
    expect(parseYearOrderFromLabel('합계')).toBeNull();
    expect(parseYearOrderFromLabel('')).toBeNull();
  });
});

describe('isTotalColumnLabel — S-5 합계 열 제외', () => {
  it.each(['합계', '합 계', '총계', '소계', '계', '누계'])('%s는 합계 열이다', (label) => {
    expect(isTotalColumnLabel(label)).toBe(true);
  });

  it('연차 라벨은 합계가 아니다', () => {
    expect(isTotalColumnLabel('1차년도')).toBe(false);
  });
});

// 부록 B.6 산자부 구조를 본뜬 픽스처: 헤더 1행, 데이터 3~9행, 라벨 B~E, 연차 F~I, 합계 J
const SANJA_LIKE = sheetOf(
  '유엔이_총괄표',
  [
    [null, '사업비 총괄표', null, null, null, null, null, null, null, null],
    [null, '비목', '세목', null, '구분', '1차년도', '2차년도', '3차년도', '4차년도', '합계'],
    [null, null, null, null, null, 2026, 2027, 2028, 2029, null],
    [null, '직접비', '인건비', '내부인건비 (A)', '현금 (N)', 100, 100, 100, 100, 400],
    [null, null, null, null, '현물', 50, 50, 50, 50, 200],
    [null, null, '학생 인건비', null, '일반', 10, 10, 10, 10, 40],
    [null, null, '연구활동비 (H)', null, '현금', 20, 20, 20, 20, 80],
    [null, null, '총 인건비1) (E=A+B+C+D)', null, null, 150, 150, 150, 150, 600],
    [null, '간접비 (L)', null, null, null, 5, 5, 5, 5, 20],
    [null, '연구개발비 총액 (M=K+L)', null, null, null, 185, 185, 185, 185, 740],
    // 데이터 범위 밖: 라벨 없이 금액만 남은 잔여 행 (행안부 33행 같은 것)
    [null, null, null, null, null, 999, null, null, null, null],
  ]
);

describe('detectStructure — 부록 B.6 기대 동작', () => {
  const structure = detectStructure(SANJA_LIKE);

  it('헤더 행 = `N차년도` 매칭이 가장 많은 행', () => {
    expect(structure.headerRow).toBe(1);
  });

  it('데이터 시작 행 = 헤더 아래 첫 비목 판정 행', () => {
    expect(structure.dataStartRow).toBe(3);
  });

  it('데이터 끝 행 = 마지막 비목/스킵 판정 행 — 라벨 없는 잔여 행은 범위 밖', () => {
    expect(structure.dataEndRow).toBe(9);
  });

  it('라벨 열 = 첫 연차 열 왼쪽에서 데이터 구간에 값이 있는 열 전부', () => {
    expect(structure.labelColumns).toEqual(['B', 'C', 'D', 'E']);
  });

  it('연차 열 F·G·H·I → order 0·1·2·3, 합계 J는 제외', () => {
    expect(structure.yearColumns.map((y) => [y.column, y.yearOrder])).toEqual([
      ['F', 0],
      ['G', 1],
      ['H', 2],
      ['I', 3],
    ]);
    expect(structure.totalColumns.map((t) => t.column)).toEqual(['J']);
  });

  it('S-1: 실측 서식은 비목이 행에 있다', () => {
    expect(structure.orientation).toBe('row');
  });

  it('단위 표기가 없으면 ×1을 기본 제시한다 (자동 확정 아님)', () => {
    expect(structure.amountUnitHint).toBeNull();
    expect(structure.amountUnit).toBe(1);
  });
});

describe('detectStructure — 행안부처럼 위에 `N단계` 그룹 헤더가 있는 경우', () => {
  const sheet = sheetOf('유엔이_총괄표', [
    [null, '(단위 : 원)'],
    [null, '비목', '세목', null, '구분', '1단계', '1단계', '2단계', '2단계', '합계'],
    [null, null, null, null, null, '1차년도', '2차년도', '3차년도', '4차년도', null],
    [null, '직접비', '인건비', '내부인건비 (A)', '현금', 100, 100, 100, 100, 400],
    [null, '간접비', null, null, null, 5, 5, 5, 5, 20],
  ]);
  const structure = detectStructure(sheet);

  it('`N단계` 행이 아니라 `N차년도` 행을 헤더로 고른다', () => {
    expect(structure.headerRow).toBe(2);
    expect(structure.yearColumns.map((y) => y.yearOrder)).toEqual([0, 1, 2, 3]);
  });

  it('I-10: 시트 어디서든 `(단위 : 원)`을 찾아 후보로 제시한다', () => {
    expect(structure.amountUnitHint).toMatchObject({ unit: 1, row: 0, column: 1 });
  });
});

describe('detectHeaderRow — 세로 병합 동률', () => {
  it('동률이면 가장 위쪽 행을 고른다', () => {
    const sheet = sheetOf(
      'S',
      [
        [null, '비목', '1차년도', '2차년도'],
        [null, null, null, null],
        [null, '직접비', 100, 100],
      ],
      // 헤더가 두 행에 걸쳐 세로 병합된 서식
      [
        { s: { r: 0, c: 2 }, e: { r: 1, c: 2 } },
        { s: { r: 0, c: 3 }, e: { r: 1, c: 3 } },
      ]
    );
    const cells = expandMerges(sheet).cells;
    expect(detectHeaderRow(cells)).toBe(0);
  });

  it('연차 열이 없으면 null', () => {
    const cells = expandMerges(sheetOf('S', [['a', 'b']])).cells;
    expect(detectHeaderRow(cells)).toBeNull();
  });
});

describe('detectYearColumns / detectDataRange / detectLabelColumns', () => {
  const cells = expandMerges(SANJA_LIKE).cells;

  it('병합으로 같은 연차가 여러 열에 펼쳐지면 가장 왼쪽 열만 쓴다', () => {
    const sheet = sheetOf(
      'S',
      [[null, '1차년도', null, '2차년도', null]],
      [
        { s: { r: 0, c: 1 }, e: { r: 0, c: 2 } },
        { s: { r: 0, c: 3 }, e: { r: 0, c: 4 } },
      ]
    );
    const { yearColumns } = detectYearColumns(expandMerges(sheet).cells, 0);
    expect(yearColumns.map((y) => y.column)).toEqual(['B', 'D']);
  });

  it('데이터 범위는 첫 비목 행 ~ 마지막 비목/스킵 행이다', () => {
    expect(detectDataRange(cells, 1, [1, 2, 3, 4])).toEqual({ dataStartRow: 3, dataEndRow: 9 });
  });

  it('값이 없는 열(A)은 라벨 열에서 빠진다', () => {
    expect(detectLabelColumns(cells, 5, 3, 9)).toEqual([1, 2, 3, 4]);
  });

  it('S-1: 헤더 행에 비목이 2개 이상이면 비목이 열에 있는 서식이다', () => {
    const columnar = expandMerges(
      sheetOf('S', [[null, '인건비', '연구활동비', '간접비'], ['1차년도', 1, 2, 3]])
    ).cells;
    expect(detectOrientation(columnar, 0)).toBe('column');
    expect(detectOrientation(cells, 1)).toBe('row');
  });
});

// S-13: 행 수로 매기면 틀린 시트를 고른다 — 비율 + 연차열 게이트로 매긴다
describe('scoreSheet / recommendSheet — S-13', () => {
  const CATEGORIES = [
    '인건비',
    '학생인건비',
    '연구시설·장비비',
    '연구재료비',
    '연구활동비',
    '연구과제추진비',
    '연구수당',
    '간접비',
  ];

  // 산출근거 시트: 비목 8종이 250행에 흩어져 있다 (비목 언급 수는 총괄표보다 많다)
  const detailRows: CellSpec[][] = [
    ['1차년도', '2차년도', '3차년도', '4차년도'],
    ...Array.from({ length: 249 }, (_, i) => {
      const category = CATEGORIES[i % CATEGORIES.length]!;
      // 8행마다 한 번씩만 비목 라벨이 나오고 나머지는 산출 내역이다
      return i % 8 === 0 ? [category, '산출근거', i] : [`항목 ${i}`, '산출근거', i];
    }),
  ];
  const detailSheet = sheetOf('2차년도_250520', detailRows);

  // 총괄표: 비목 8종이 29행에 밀집해 있다
  const summaryRows: CellSpec[][] = [
    ['비목', '세목', '1차년도', '2차년도', '3차년도', '4차년도', '합계'],
    ...CATEGORIES.flatMap((category) => [
      [category, '현금', 100, 100, 100, 100, 400],
      [null, '현물', 50, 50, 50, 50, 200],
    ]),
    ...Array.from({ length: 12 }, (_, i) => ['소계', null, i, i, i, i, i]),
  ];
  const summarySheet = sheetOf('유엔이_총괄표', summaryRows);

  it('행 수로 매기면 산출근거 시트가 이긴다 (그래서 행 수로 매기면 안 된다)', () => {
    const detail = scoreSheet(detailSheet);
    const summary = scoreSheet(summarySheet);
    expect(detail.categoryRows).toBeGreaterThan(summary.categoryRows);
  });

  it('행 비율로 매기면 총괄표가 이긴다', () => {
    expect(scoreSheet(summarySheet).score).toBeGreaterThan(scoreSheet(detailSheet).score);
  });

  it('추천 시트는 총괄표다', () => {
    expect(recommendSheet([detailSheet, summarySheet]).recommended).toBe('유엔이_총괄표');
  });

  it('`N차년도` 헤더가 2개 미만인 시트는 후보가 아니다', () => {
    const noYears = sheetOf('검토의견', [['인건비'], ['연구활동비'], ['간접비']]);
    const score = scoreSheet(noYears);
    expect(score.eligible).toBe(false);
    expect(score.score).toBe(0);
    expect(recommendSheet([noYears, summarySheet]).recommended).toBe('유엔이_총괄표');
  });

  it('시트가 1개면 그 시트를 자동 선택한다 (§6.8.1 ②)', () => {
    expect(recommendSheet([detailSheet]).recommended).toBe('2차년도_250520');
  });

  it('후보가 하나도 없으면 첫 시트를 제시한다 — 조용히 아무것도 고르지 않고 두지 않는다', () => {
    const a = sheetOf('a', [['x']]);
    const b = sheetOf('b', [['y']]);
    expect(recommendSheet([a, b]).recommended).toBe('a');
    expect(recommendSheet([]).recommended).toBeNull();
  });
});

describe('checkRowLimit — I-15', () => {
  it('20,000행이 상한이다', () => {
    expect(MAX_IMPORT_ROWS).toBe(20_000);
    expect(checkRowLimit(20_000).ok).toBe(true);
    expect(checkRowLimit(20_001).ok).toBe(false);
    expect(checkRowLimit(20_001)).toEqual({ ok: false, rowCount: 20_001, limit: 20_000 });
  });
});
