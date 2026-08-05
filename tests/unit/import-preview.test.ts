// 미리보기 조립 (SOT §7.9.1 Step 5, §9 previewImport, S-4·S-8·S-9, 부록 B.5 최종 BudgetItem)

import { describe, expect, it } from 'vitest';
import { parseMatrix } from '@/lib/import/matrix';
import { buildPreview, type ExistingBudgetItem } from '@/lib/import/preview';
import type { MergeRange, RawCell, RawSheet } from '@/lib/import/types';
import type { BudgetCategory, PreviewRow } from '@/types';

type CellSpec = string | number | null | RawCell;

const ERR = (text: string): RawCell => ({ value: null, isError: true, errorText: text });

function toCell(spec: CellSpec): RawCell {
  if (spec !== null && typeof spec === 'object') return spec;
  return { value: spec, isError: false };
}

function sheetOf(rows: CellSpec[][], merges: MergeRange[] = []): RawSheet {
  return { name: '유엔이_총괄표', cells: rows.map((r) => r.map(toCell)), merges };
}

// 부록 B.5의 10행 표 (import-matrix.test.ts와 같은 픽스처)
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

const parsed = parseMatrix(B5_SHEET, {
  labelColumns: ['B', 'C', 'D', 'E'],
  yearColumns: [
    { column: 'F', yearOrder: 0 },
    { column: 'G', yearOrder: 1 },
  ],
  dataStartRow: 1,
  dataEndRow: 10,
  amountUnit: 1,
});

const YEAR_IDS = { 0: 'y1', 1: 'y2' };

function itemOf(preview: { rows: PreviewRow[] }, yearId: string, category: BudgetCategory) {
  return preview.rows.find(
    (r) => r.yearId === yearId && r.category === category && r.status !== 'error'
  );
}

describe('부록 B.5 — 최종 BudgetItem (1차년도)', () => {
  const preview = buildPreview({ rows: parsed.rows, yearIdByOrder: YEAR_IDS, existingItems: [] });

  it('personnel planned 70,000,000 (현금 50,000,000 + 현물 20,000,000 + 외부 0)', () => {
    expect(itemOf(preview, 'y1', 'personnel')).toMatchObject({
      plannedAmount: 70_000_000,
      cashAmount: 50_000_000,
      inKindAmount: 20_000_000,
    });
  });

  it('student_personnel 5,000,000 — `일반`은 plannedAmount에만 들어가고 현금/현물은 null (S-4)', () => {
    expect(itemOf(preview, 'y1', 'student_personnel')).toMatchObject({
      plannedAmount: 5_000_000,
      cashAmount: null,
      inKindAmount: null,
    });
  });

  it('activity 8,000,000 — 2차년도가 오류여도 1차년도 값은 미리보기에 나온다', () => {
    expect(itemOf(preview, 'y1', 'activity')?.plannedAmount).toBe(8_000_000);
  });

  it('indirect 1,000,000 — 축 분리 행이 없으므로 현금/현물은 null', () => {
    expect(itemOf(preview, 'y1', 'indirect')).toMatchObject({
      plannedAmount: 1_000_000,
      cashAmount: null,
      inKindAmount: null,
    });
  });

  it('facility_equipment는 1차년도 0 (현금 축이 있으므로 0/0)', () => {
    expect(itemOf(preview, 'y1', 'facility_equipment')).toMatchObject({
      plannedAmount: 0,
      cashAmount: 0,
      inKindAmount: 0,
    });
  });

  it('1차년도 합계는 원본 `연구개발비 총액` 행(84,000,000)과 일치한다', () => {
    const sum = preview.rows
      .filter((r) => r.yearId === 'y1' && (r.status === 'new' || r.status === 'overwrite'))
      .reduce((total, r) => total + (r.plannedAmount ?? 0), 0);
    expect(sum).toBe(84_000_000);
  });

  it('S-8: 내부·외부 인건비가 한 BudgetItem으로 합산된다 (행 단위 덮어쓰기가 아니다)', () => {
    expect(itemOf(preview, 'y1', 'personnel')?.sourceRowIndexes).toEqual([1, 2, 3]);
  });

  it('2차년도도 같은 규칙으로 합산된다', () => {
    expect(itemOf(preview, 'y2', 'personnel')).toMatchObject({
      plannedAmount: 110_000_000,
      cashAmount: 80_000_000,
      inKindAmount: 30_000_000,
    });
    expect(itemOf(preview, 'y2', 'facility_equipment')?.plannedAmount).toBe(10_000_000);
    // 2차년도 연구활동비는 #REF!라 반영 대상 행이 만들어지지 않는다
    expect(itemOf(preview, 'y2', 'activity')).toBeUndefined();
  });

  it('금액은 전부 원 단위 정수다 (CLAUDE.md 절대 규칙 4)', () => {
    const amounts = preview.rows.flatMap((r) =>
      [r.plannedAmount, r.cashAmount, r.inKindAmount].filter((v): v is number => v !== null)
    );
    expect(amounts.every(Number.isInteger)).toBe(true);
  });
});

describe('부록 B.5 — 7행 #REF!가 전체 반영을 차단한다 (§7.9.1 Step 5)', () => {
  const preview = buildPreview({ rows: parsed.rows, yearIdByOrder: YEAR_IDS, existingItems: [] });

  it('오류가 1건이라도 있으면 blocked다', () => {
    expect(preview.summary.error).toBe(1);
    expect(preview.blocked).toBe(true);
  });

  it('오류 행은 어느 열이 왜 실패했는지 남긴다 (조용히 삼키지 않는다)', () => {
    const error = preview.rows.find((r) => r.status === 'error')!;
    expect(error.sourceRowIndexes).toEqual([7]);
    expect(error.reason).toContain('G열');
    expect(error.reason).toContain('#REF!');
    expect(error.statusLabel).toBe('오류');
  });

  it('그 행을 사용자가 건너뛰기로 지정하면 반영 가능해진다', () => {
    const reparsed = parseMatrix(B5_SHEET, {
      labelColumns: ['B', 'C', 'D', 'E'],
      yearColumns: [
        { column: 'F', yearOrder: 0 },
        { column: 'G', yearOrder: 1 },
      ],
      dataStartRow: 1,
      dataEndRow: 10,
      amountUnit: 1,
      skippedRowIndexes: [7],
    });
    const unblocked = buildPreview({
      rows: reparsed.rows,
      yearIdByOrder: YEAR_IDS,
      existingItems: [],
    });
    expect(unblocked.summary.error).toBe(0);
    expect(unblocked.blocked).toBe(false);
  });
});

describe('부록 B.5 — summary (§9 previewImport)', () => {
  const preview = buildPreview({ rows: parsed.rows, yearIdByOrder: YEAR_IDS, existingItems: [] });

  it('건너뜀 3건 (5·8·10행)', () => {
    expect(preview.summary.skipped).toBe(3);
    expect(
      preview.rows.filter((r) => r.status === 'skipped').map((r) => r.sourceRowIndexes[0])
    ).toEqual([5, 8, 10]);
  });

  it('건너뜀 합계 금액 — 스킵 행의 `#REF!`는 집계에서 빼되 그 사실을 사유에 남긴다', () => {
    // 5행 190,000,000 + 8행 83,000,000 + 10행 84,000,000
    expect(preview.summary.skippedAmount).toBe(357_000_000);
    const withIgnored = preview.rows.filter(
      (r) => r.status === 'skipped' && (r.reason ?? '').includes('오류 셀')
    );
    expect(withIgnored).toHaveLength(2);
  });

  it('기존 값이 없으면 전부 신규다', () => {
    expect(preview.summary.new).toBe(9);
    expect(preview.summary.overwrite).toBe(0);
  });

  it('반영 예정 합계 = 1차 84,000,000 + 2차 127,000,000', () => {
    expect(preview.summary.totalAmount).toBe(211_000_000);
  });
});

describe('신규 / 덮어씀 판정', () => {
  const existing: ExistingBudgetItem[] = [
    // 연차 생성 시 자동 생성되는 빈 레코드는 "덮어쓸 값"이 없으므로 신규로 본다 (§5.12)
    { yearId: 'y1', category: 'personnel', plannedAmount: 0, cashAmount: null, inKindAmount: null },
    {
      yearId: 'y1',
      category: 'indirect',
      plannedAmount: 900_000,
      cashAmount: null,
      inKindAmount: null,
    },
  ];
  const preview = buildPreview({ rows: parsed.rows, yearIdByOrder: YEAR_IDS, existingItems: existing });

  it('빈 기존 레코드는 신규', () => {
    expect(itemOf(preview, 'y1', 'personnel')?.status).toBe('new');
  });

  it('값이 있는 기존 레코드는 덮어씀이고 기존 값을 함께 보여준다 (`기존 → 신규`)', () => {
    const row = itemOf(preview, 'y1', 'indirect')!;
    expect(row.status).toBe('overwrite');
    expect(row.statusLabel).toBe('덮어씀');
    expect(row.existing).toEqual({
      plannedAmount: 900_000,
      cashAmount: null,
      inKindAmount: null,
    });
    expect(row.plannedAmount).toBe(1_000_000);
  });
});

describe('S-9 — 파일에 없는 비목은 유지한다', () => {
  const existing: ExistingBudgetItem[] = [
    {
      yearId: 'y1',
      category: 'consignment',
      plannedAmount: 3_000_000,
      cashAmount: null,
      inKindAmount: null,
    },
    {
      yearId: 'y1',
      category: 'promotion',
      plannedAmount: 1_500_000,
      cashAmount: null,
      inKindAmount: null,
    },
    // 반영 대상 연차가 아닌 기존 값은 아예 논외다
    {
      yearId: 'y9',
      category: 'material',
      plannedAmount: 7_000_000,
      cashAmount: null,
      inKindAmount: null,
    },
  ];
  const preview = buildPreview({ rows: parsed.rows, yearIdByOrder: YEAR_IDS, existingItems: existing });

  it('파일에 등장하지 않은 (연차, 비목)을 그대로 보고한다', () => {
    expect(preview.summary.untouchedCategories).toEqual([
      { yearId: 'y1', yearOrder: 0, category: 'consignment', plannedAmount: 3_000_000 },
      { yearId: 'y1', yearOrder: 0, category: 'promotion', plannedAmount: 1_500_000 },
    ]);
  });

  it('파일에 등장한 비목은 유지 목록에 없다', () => {
    expect(
      preview.summary.untouchedCategories.some((c) => c.category === 'personnel')
    ).toBe(false);
  });
});

describe('S-5 — 대응되지 않은 연차 열', () => {
  it('yearId가 없는 연차가 남아 있으면 반영 불가다', () => {
    const preview = buildPreview({
      rows: parsed.rows,
      yearIdByOrder: { 0: 'y1' },
      existingItems: [],
    });
    expect(preview.unmappedYearOrders).toEqual([1]);
    expect(preview.blocked).toBe(true);
  });
});

describe('미매핑 행은 반영을 막는다 (I-4)', () => {
  it('미매핑·모호·퍼지 행은 오류로 집계된다', () => {
    const sheet = sheetOf([
      [null, null, '알 수 없는 항목', null, null, 600],
      [null, null, '연구장비·재료비', null, null, 700],
    ]);
    const result = parseMatrix(sheet, {
      labelColumns: ['B', 'C', 'D', 'E'],
      yearColumns: [{ column: 'F', yearOrder: 0 }],
      dataStartRow: 0,
      dataEndRow: 1,
      amountUnit: 1,
    });
    const preview = buildPreview({
      rows: result.rows,
      yearIdByOrder: { 0: 'y1' },
      existingItems: [],
    });
    expect(preview.summary.error).toBe(2);
    expect(preview.blocked).toBe(true);
    expect(preview.rows.map((r) => r.reason)).toContain('미매핑');
  });
});

// 마법사 Step 4가 ✅/🔵를 스스로 판정하거나 라벨을 미리보기 그리드(상위 30행)에서
// 되찾지 않아도 되게, 서버가 판정 결과를 미리보기 행에 실어 보낸다 (O-4).
describe('매핑 행의 원본 라벨·판정 근거 (§7.9.1 Step 4)', () => {
  const preview = buildPreview({ rows: parsed.rows, yearIdByOrder: YEAR_IDS, existingItems: [] });

  it('S-8로 합쳐진 행은 기여한 원본 행을 전부 싣는다', () => {
    const personnel = itemOf(preview, 'y1', 'personnel')!;
    // 부록 B.5의 1·2·3행(내부 현금·내부 현물·외부 현금)이 한 BudgetItem으로 합쳐진다
    expect(personnel.sourceRows.map((s) => s.rowIndex)).toEqual(personnel.sourceRowIndexes);
    expect(personnel.sourceRows.length).toBeGreaterThan(1);
    expect(personnel.sourceRows.every((s) => s.label !== null)).toBe(true);
  });

  it('합친 라벨을 label에 담는다 — UI가 그리드에서 되찾지 않아도 된다', () => {
    const personnel = itemOf(preview, 'y1', 'personnel')!;
    expect(personnel.label).not.toBeNull();
    expect(personnel.label).toContain('내부인건비');
    expect(personnel.label).toContain('외부인건비');
  });

  it('완전일치만 기여한 행은 categorySource가 exact다', () => {
    // `간접비 (L)` → 정규화 `간접비` → 표준 명칭 완전일치 (부록 C 주의 1의 ①)
    const indirect = itemOf(preview, 'y1', 'indirect')!;
    expect(indirect.categorySource).toBe('exact');
    expect(indirect.sourceRows.map((s) => s.categorySource)).toEqual(['exact']);
  });

  it('별칭이 섞이면 대표 근거는 별칭이다 — 완전일치 하나로 ✅ 처리하지 않는다', () => {
    const personnel = itemOf(preview, 'y1', 'personnel')!;
    // 내부/외부 인건비는 전부 별칭 사전 경유다
    expect(personnel.categorySource).not.toBe('exact');
    expect(personnel.categorySource?.startsWith('alias-')).toBe(true);
  });

  it('건너뜀·오류 행도 판정 근거를 싣는다', () => {
    const skipped = preview.rows.find((r) => r.status === 'skipped')!;
    expect(skipped.sourceRows).toHaveLength(1);
    expect(skipped.sourceRows[0]!.rowIndex).toBe(skipped.sourceRowIndexes[0]);
  });
});

describe('I-11 반올림 표시', () => {
  it('반올림이 일어난 셀이 섞이면 미리보기 행에 표시된다', () => {
    const sheet = sheetOf([[null, null, '연구활동비', null, '현금', 1234.5]]);
    const result = parseMatrix(sheet, {
      labelColumns: ['B', 'C', 'D', 'E'],
      yearColumns: [{ column: 'F', yearOrder: 0 }],
      dataStartRow: 0,
      dataEndRow: 0,
      amountUnit: 1,
    });
    const preview = buildPreview({
      rows: result.rows,
      yearIdByOrder: { 0: 'y1' },
      existingItems: [],
    });
    expect(preview.rows[0]!.rounded).toBe(true);
    expect(preview.rows[0]!.plannedAmount).toBe(1235);
  });
});
