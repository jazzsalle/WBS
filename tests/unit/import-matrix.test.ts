// 매트릭스 파싱 (SOT §6.8.2 S-1~S-13, 부록 B.5)
//
// 부록 B.5의 10행 표를 그대로 픽스처로 옮긴다.
// 원문의 ASCII 표는 B/C/D 3개 열만 이름을 붙였지만 행마다 라벨 토큰이 4개(비목|세목|세목|현금·현물)
// 나오므로, 여기서는 라벨 열을 B·C·D·E로, 연차 열을 F(1차)·G(2차)·H(합계)로 둔다.
// 열 문자만 다르고 행별 판정과 금액은 B.5 원문 그대로다.

import { describe, expect, it } from 'vitest';
import { parseMatrix, type ParsedRow } from '@/lib/import/matrix';
import type { MergeRange, RawCell, RawSheet } from '@/lib/import/types';

type CellSpec = string | number | null | RawCell;

const ERR = (text: string): RawCell => ({ value: null, isError: true, errorText: text });

function toCell(spec: CellSpec): RawCell {
  if (spec !== null && typeof spec === 'object') return spec;
  return { value: spec, isError: false };
}

function sheetOf(rows: CellSpec[][], merges: MergeRange[] = []): RawSheet {
  return { name: '유엔이_총괄표', cells: rows.map((r) => r.map(toCell)), merges };
}

// A B C D E F G H
const B5_SHEET = sheetOf([
  [null, '비목', '세목', null, '구분', '1차년도', '2차년도', '합계'],
  [null, '직접비', '인건비', '내부인건비 (A)', '현금 (N)', 50_000_000, 80_000_000, 130_000_000],
  [null, null, null, null, '현물', 20_000_000, 30_000_000, 50_000_000],
  [null, null, null, '외부인건비 (B)', '현금 (O)', 0, 0, 0],
  [null, null, '학생 인건비', null, '일반', 5_000_000, 5_000_000, 10_000_000],
  [null, null, '총 인건비1) (E=A+B+C+D)', null, null, 75_000_000, 115_000_000, 190_000_000],
  [null, null, '연구시설‧장비비 (F)', null, '현금 (R)', 0, 10_000_000, 10_000_000],
  [null, null, '연구활동비 (H)', null, '현금 (T)', 8_000_000, ERR('#REF!'), ERR('#REF!')],
  [null, null, '직접비 소계 (K)', null, null, 83_000_000, ERR('#REF!'), ERR('#REF!')],
  [null, '간접비 (L)', null, null, null, 1_000_000, 2_000_000, 3_000_000],
  [null, '연구개발비 총액 (M=K+L)', null, null, null, 84_000_000, ERR('#REF!'), ERR('#REF!')],
]);

const B5_OPTIONS = {
  labelColumns: ['B', 'C', 'D', 'E'],
  // S-5: H열(합계)은 넣지 않는다 — 값이 무엇이든 결과에 영향이 없다
  yearColumns: [
    { column: 'F', yearOrder: 0 },
    { column: 'G', yearOrder: 1 },
  ],
  dataStartRow: 1,
  dataEndRow: 10,
  amountUnit: 1 as const,
};

/** B.5의 1-based 행 번호 → ParsedRow */
function b5Row(rows: ParsedRow[], b5RowNumber: number): ParsedRow {
  const row = rows.find((r) => r.rowIndex === b5RowNumber);
  if (!row) throw new Error(`B.5 ${b5RowNumber}행이 없습니다`);
  return row;
}

const amountOf = (row: ParsedRow, yearOrder: number) =>
  row.amounts.find((a) => a.yearOrder === yearOrder)?.amount ?? null;

describe('부록 B.5 — 행별 판정', () => {
  const { rows, errorRowIndexes, unresolvedRowIndexes } = parseMatrix(B5_SHEET, B5_OPTIONS);

  it('1행: 내부인건비 → personnel 현금 (S-3). 합계 열은 파싱 대상이 아니다 (S-5)', () => {
    const row = b5Row(rows, 1);
    expect(row.status).toBe('mapped');
    expect(row.category).toBe('personnel');
    expect(row.axis).toBe('cash');
    expect(amountOf(row, 0)).toBe(50_000_000);
    expect(amountOf(row, 1)).toBe(80_000_000);
    expect(row.amounts).toHaveLength(2);
  });

  it('2행: 빈 라벨은 위 행 carry-forward (S-2), `현물` 행 쌍 (S-4)', () => {
    const row = b5Row(rows, 2);
    expect(row.category).toBe('personnel');
    expect(row.axis).toBe('inKind');
    expect(row.labels).toEqual(['직접비', '인건비', '내부인건비 (A)', '현물']);
    expect(amountOf(row, 0)).toBe(20_000_000);
    expect(amountOf(row, 1)).toBe(30_000_000);
  });

  it('3행: 외부인건비 → personnel 현금에 0 합산', () => {
    const row = b5Row(rows, 3);
    expect(row.category).toBe('personnel');
    expect(row.axis).toBe('cash');
    expect(amountOf(row, 0)).toBe(0);
  });

  it('4행: `학생 인건비` → 공백 정규화 → student_personnel, 축은 `일반`(unassigned)', () => {
    const row = b5Row(rows, 4);
    expect(row.category).toBe('student_personnel');
    expect(row.axis).toBe('unassigned');
    expect(amountOf(row, 0)).toBe(5_000_000);
  });

  it('5행: `총 인건비1) (E=A+B+C+D)` → `총인건비` → 건너뜀', () => {
    const row = b5Row(rows, 5);
    expect(row.status).toBe('skipped');
    expect(row.category).toBeNull();
  });

  it('6행: `연구시설‧장비비 (F)` → facility_equipment, 2차 현금 10,000,000', () => {
    const row = b5Row(rows, 6);
    expect(row.category).toBe('facility_equipment');
    expect(row.axis).toBe('cash');
    expect(amountOf(row, 1)).toBe(10_000_000);
  });

  it('7행: 2차년도 `#REF!` → 오류로 반영 차단 (I-12). 1차년도 값은 그대로 읽는다', () => {
    const row = b5Row(rows, 7);
    expect(row.status).toBe('mapped');
    expect(row.category).toBe('activity');
    expect(row.hasBlockingError).toBe(true);
    expect(amountOf(row, 0)).toBe(8_000_000);
    expect(row.amounts[1]!.error?.reason).toBe('formula-error');
    expect(errorRowIndexes).toEqual([7]);
  });

  it('8행: `직접비 소계` → 건너뜀. 스킵 행의 `#REF!`는 오류로 집계하지 않는다', () => {
    const row = b5Row(rows, 8);
    expect(row.status).toBe('skipped');
    expect(row.hasBlockingError).toBe(false);
    expect(errorRowIndexes).not.toContain(8);
  });

  it('9행: `간접비 (L)` → 완전일치 비목 (스킵 아님, 부록 C 주의 1). 축 없음', () => {
    const row = b5Row(rows, 9);
    expect(row.status).toBe('mapped');
    expect(row.category).toBe('indirect');
    expect(row.categorySource).toBe('exact');
    expect(row.axis).toBeNull();
    expect(amountOf(row, 0)).toBe(1_000_000);
  });

  it('10행: `연구개발비 총액` → 건너뜀', () => {
    expect(b5Row(rows, 10).status).toBe('skipped');
  });

  it('미매핑은 한 건도 없다', () => {
    expect(unresolvedRowIndexes).toEqual([]);
  });

  it('S-2 리셋: `간접비` 행이 직전 `현금`·`내부인건비` 라벨을 물려받지 않는다', () => {
    expect(b5Row(rows, 9).labels).toEqual(['간접비 (L)', '', '', '']);
    expect(b5Row(rows, 10).labels).toEqual(['연구개발비 총액 (M=K+L)', '', '', '']);
  });

  it('S-12: 4행 B열 `직접비`(스킵)보다 D열 `내부인건비`가 우선한다', () => {
    const row = b5Row(rows, 1);
    expect(row.labels[0]).toBe('직접비');
    expect(row.matchedLabel).toBe('내부인건비 (A)');
  });
});

describe('S-11 병합 확장', () => {
  it('C..E를 가로지르는 병합 메모 행은 위 행의 `현물` 축을 승계하지 않는다', () => {
    const sheet = sheetOf(
      [
        [null, '직접비', '인건비', '내부인건비 (A)', '현금', 100],
        [null, null, null, null, '현물', 200],
        // C..E 병합 메모. 확장하지 않으면 D·E가 빈 셀로 남아 위 행의 `현물`을 승계한다
        [null, null, '(간접비 중 연구실 안전관리비)', null, null, 300],
      ],
      [{ s: { r: 2, c: 2 }, e: { r: 2, c: 4 } }]
    );
    const { rows } = parseMatrix(sheet, {
      labelColumns: ['B', 'C', 'D', 'E'],
      yearColumns: [{ column: 'F', yearOrder: 0 }],
      dataStartRow: 0,
      dataEndRow: 2,
      amountUnit: 1,
    });

    const memo = rows[2]!;
    expect(memo.labels).toEqual([
      '직접비',
      '(간접비 중 연구실 안전관리비)',
      '(간접비 중 연구실 안전관리비)',
      '(간접비 중 연구실 안전관리비)',
    ]);
    expect(memo.axis).toBeNull();
    expect(memo.status).toBe('skipped');
    expect(memo.category).toBeNull();
  });
});

describe('S-10 빈 라벨 행의 분기', () => {
  const sheet = sheetOf([
    [null, '비', null, '연구재료비', '현금', 100],
    // `(G)` = 정규화 후 빈 라벨 + 축 `현물` → 위 비목을 승계한다
    [null, null, null, '(G)', '현물', 200],
    // 축 없는 빈 라벨 메모 → 승계하지 않고 건너뛴다
    [null, null, null, '(간접비 중 연구실 안전관리비)', null, 300],
  ]);
  const { rows } = parseMatrix(sheet, {
    labelColumns: ['B', 'C', 'D', 'E'],
    yearColumns: [{ column: 'F', yearOrder: 0 }],
    dataStartRow: 0,
    dataEndRow: 2,
    amountUnit: 1,
  });

  it('축 라벨이 있으면 직전 비목을 승계한다 — 현물 금액이 유실되지 않는다', () => {
    const row = rows[1]!;
    expect(row.status).toBe('mapped');
    expect(row.category).toBe('material');
    expect(row.categorySource).toBe('inherited');
    expect(row.inheritedFromRow).toBe(0);
    expect(row.axis).toBe('inKind');
    expect(amountOf(row, 0)).toBe(200);
  });

  it('축 라벨이 없는 빈 라벨 행은 승계하지 않고 건너뛴다', () => {
    const row = rows[2]!;
    expect(row.status).toBe('skipped');
    expect(row.category).toBeNull();
  });

  it('carry-forward로 물려받은 축은 S-10 승계 근거가 되지 않는다 (그 행에 축 라벨이 있어야 한다)', () => {
    // 메모 행의 E열은 비어 있어 위 행의 `현물`을 이어받지만, 자기 행의 축 라벨은 아니다
    expect(rows[2]!.labels[3]).toBe('현물');
    expect(rows[2]!.status).toBe('skipped');
  });

  it("S-2': 세로쓰기 조각 `비`가 승계되지 않아 `(G)` 행이 미매핑되지 않는다", () => {
    expect(rows[1]!.labels[0]).toBe('');
    expect(rows.every((r) => r.status !== 'unmapped')).toBe(true);
  });
});

describe("S-2' 세로쓰기 조각 (행안부 B열 직/접/비)", () => {
  it('우측 라벨이 빈 행에서 `비`가 채택되지 않는다', () => {
    const sheet = sheetOf([
      [null, '직', null, '내부인건비 (A)', '현금', 100],
      [null, '접', null, null, '현물', 200],
      [null, '비', null, '외부인건비 (B)', '현금', 300],
      [null, null, null, null, '현물', 400],
    ]);
    const { rows, unresolvedRowIndexes } = parseMatrix(sheet, {
      labelColumns: ['B', 'C', 'D', 'E'],
      yearColumns: [{ column: 'F', yearOrder: 0 }],
      dataStartRow: 0,
      dataEndRow: 3,
      amountUnit: 1,
    });

    expect(unresolvedRowIndexes).toEqual([]);
    expect(rows.map((r) => r.category)).toEqual([
      'personnel',
      'personnel',
      'personnel',
      'personnel',
    ]);
    expect(rows.map((r) => r.axis)).toEqual(['cash', 'inKind', 'cash', 'inKind']);
    // 마지막 행은 B열이 비어 있고 `비`를 물려받지 않았다
    expect(rows[3]!.labels[0]).toBe('');
  });
});

describe('S-6 세로 분절 라벨 결합', () => {
  const sheet = sheetOf([
    [null, null, '연구시설‧', null, '현금', 100],
    [null, null, '장비비(F)', null, '현물', 200],
  ]);
  const { rows } = parseMatrix(sheet, {
    labelColumns: ['B', 'C', 'D', 'E'],
    yearColumns: [{ column: 'F', yearOrder: 0 }],
    dataStartRow: 0,
    dataEndRow: 1,
    amountUnit: 1,
  });

  it('바로 아래 행의 같은 열 라벨과 결합해 재시도한다', () => {
    expect(rows[0]!.status).toBe('mapped');
    expect(rows[0]!.category).toBe('facility_equipment');
    expect(rows[0]!.categorySource).toBe('combined');
    expect(rows[0]!.combinedWithRow).toBe(1);
  });

  it('두 행을 같은 비목의 현금/현물 쌍으로 처리한다', () => {
    expect(rows[1]!.category).toBe('facility_equipment');
    expect(rows[0]!.axis).toBe('cash');
    expect(rows[1]!.axis).toBe('inKind');
  });
});

describe('S-12 후단 · I-4 · I-6', () => {
  const sheet = sheetOf([
    [null, null, null, null, null, 500], // 라벨 없이 금액만
    [null, null, '알 수 없는 항목', null, null, 600], // 미매핑
    [null, null, '연구장비·재료비', null, null, 700], // I-6 모호
  ]);
  const { rows, unresolvedRowIndexes } = parseMatrix(sheet, {
    labelColumns: ['B', 'C', 'D', 'E'],
    yearColumns: [{ column: 'F', yearOrder: 0 }],
    dataStartRow: 0,
    dataEndRow: 2,
    amountUnit: 1,
  });

  it('라벨이 없는데 금액만 있는 행은 조용히 버리지 않고 `건너뜀(라벨 없음)`으로 남긴다', () => {
    expect(rows[0]!.status).toBe('skipped');
    expect(rows[0]!.reason).toBe('라벨 없음');
    expect(amountOf(rows[0]!, 0)).toBe(500);
  });

  it('I-4: 매칭 실패는 other로 넣지 않고 미매핑으로 남긴다', () => {
    expect(rows[1]!.status).toBe('unmapped');
    expect(rows[1]!.category).toBeNull();
  });

  it('I-6: 구 비목 체계는 후보만 제시한다', () => {
    expect(rows[2]!.status).toBe('ambiguous');
    expect(rows[2]!.ambiguousCandidates).toEqual(['facility_equipment', 'material']);
  });

  it('사용자 결정이 필요한 행을 모아 준다', () => {
    expect(unresolvedRowIndexes).toEqual([1, 2]);
  });
});

describe('사용자 결정 반영 (ImportDraft)', () => {
  const sheet = sheetOf([
    [null, null, '알 수 없는 항목', null, null, 600],
    [null, null, '연구활동비', null, null, 700],
  ]);

  it('manualCategoryByRow로 지정하면 반영 대상이 된다 (I-4)', () => {
    const { rows, unresolvedRowIndexes } = parseMatrix(sheet, {
      labelColumns: ['B', 'C', 'D', 'E'],
      yearColumns: [{ column: 'F', yearOrder: 0 }],
      dataStartRow: 0,
      dataEndRow: 1,
      amountUnit: 1,
      manualCategoryByRow: { 0: 'promotion' },
    });
    expect(rows[0]!.status).toBe('mapped');
    expect(rows[0]!.category).toBe('promotion');
    expect(rows[0]!.categorySource).toBe('manual');
    expect(unresolvedRowIndexes).toEqual([]);
  });

  it('skippedRowIndexes로 지정하면 건너뛴다', () => {
    const { rows } = parseMatrix(sheet, {
      labelColumns: ['B', 'C', 'D', 'E'],
      yearColumns: [{ column: 'F', yearOrder: 0 }],
      dataStartRow: 0,
      dataEndRow: 1,
      amountUnit: 1,
      skippedRowIndexes: [1],
    });
    expect(rows[1]!.status).toBe('skipped');
    expect(rows[1]!.reason).toBe('사용자 지정');
  });
});

describe('amountUnit', () => {
  it('천원 단위 원본은 원 단위 정수로 환산된다 (I-11)', () => {
    const sheet = sheetOf([[null, null, '연구활동비', null, '현금', 1234]]);
    const { rows } = parseMatrix(sheet, {
      labelColumns: ['B', 'C', 'D', 'E'],
      yearColumns: [{ column: 'F', yearOrder: 0 }],
      dataStartRow: 0,
      dataEndRow: 0,
      amountUnit: 1000,
    });
    expect(amountOf(rows[0]!, 0)).toBe(1_234_000);
  });
});
