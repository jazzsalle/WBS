// 제출 서식 값 쓰기 — X-4 행 금액 덮어쓰기 · X-4a 소계 보존 · X-5 용량 · X-6 원 단위
// · X-7 백분율 · X-8 빈 슬롯 · X-10a 연차 열 · X-10b 서식 모순 · X-12 파일명
// (SOT §6.12.2·§6.12.3, 부록 B.7)
//
// **부록 B.7의 실측 인건비 19행이 정확한 셀에 정확한 값으로 나가는지**가 이 파일의 중심이다.
// 좌표는 언제나 맵(`templates/*.map.json`)에서 읽는다 — 셀 주소를 손으로 적으면 템플릿이 바뀔 때
// 테스트가 조용히 다른 곳을 지킨다.

import { describe, expect, it } from 'vitest';
import {
  DEFAULT_TEMPLATE_ID,
  encodeAddr,
  findTemplate,
} from '@/lib/export/layouts';
import {
  buildDetailWrites,
  checkCapacity,
  exportFileName,
} from '@/lib/export/detail-sheet';
import { buildSummaryWrites } from '@/lib/export/summary-sheet';
import type {
  CellWrite,
  ExportDetailRow,
  ExportMember,
  ExportPlanData,
  TemplateBlock,
  TemplateLayout,
} from '@/lib/export/types';
import { detectBlocks, detectSections, parseDetailRows } from '@/lib/import/detail-sheet';
import type { RawCell, RawSheet } from '@/lib/import/types';
import type { DetailAxis, DetailFactor } from '@/types';
import { DEFAULT_INDIRECT_BASE } from '@/lib/rules';

const template = findTemplate(DEFAULT_TEMPLATE_ID);
if (!template) throw new Error('표준 템플릿을 찾지 못했다');
const layout: TemplateLayout = template.layout;

const DETAIL_SHEET = layout.detail.sheet;
const SUMMARY_SHEET = layout.summary.sheet;

function blockOf(key: string): TemplateBlock {
  const found = layout.detail.blocks.find((block) => block.key === key);
  if (!found) throw new Error(`맵에 없는 블록: ${key}`);
  return found;
}

/** 맵에서 (블록, 역할) → 열 문자. 하드코딩한 열 문자는 템플릿이 바뀌면 조용히 틀린다 */
function columnOf(block: TemplateBlock, role: string): string {
  const found = block.columns.find((column) => column.role === role);
  if (!found) throw new Error(`${block.key}에 ${role} 열이 없다`);
  return found.column;
}

function valueAt(writes: readonly CellWrite[], sheet: string, addr: string): CellWrite | undefined {
  return writes.find((write) => write.sheet === sheet && write.addr === addr);
}

// ─── 부록 B.7.1 인건비 19행 ──────────────────────────────────

// [성명, 연봉, 참여율, 축, 개월, 최종 금액, 조정액] — 부록 B.7.1 표 그대로다.
// 조정액은 `최종 − 산식`으로 역산한 값이며 최종 금액이 원본 셀 값이다 (B.7.1 주석).
const PERSONNEL: ReadonlyArray<readonly [string, number, number, DetailAxis, number, number, number]> = [
  ['여욱현', 180_000_000, 10.0, 'cash', 9, 13_500_000, 0],
  ['김영', 90_000_000, 30.0, 'cash', 9, 20_250_000, 0],
  ['김지웅', 90_000_000, 30.0, 'in_kind', 9, 20_250_000, 0],
  ['박선욱', 74_000_000, 28.0, 'cash', 9, 15_540_000, 0],
  ['지동민', 84_000_000, 64.0, 'in_kind', 9, 40_050_000, -270_000],
  ['도상래', 64_000_000, 10.0, 'cash', 9, 4_800_000, 0],
  ['이경아', 54_000_000, 70.0, 'in_kind', 9, 28_350_000, 0],
  ['김다래', 54_000_000, 26.0, 'cash', 9, 10_500_000, -30_000],
  ['김도현', 52_000_000, 10.0, 'cash', 9, 3_900_000, 0],
  ['유태일', 46_200_000, 15.0, 'cash', 9, 5_190_000, -7_500],
  ['정우진', 51_000_000, 40.0, 'cash', 9, 15_300_000, 0],
  ['김형식', 43_500_000, 41.0, 'cash', 9, 13_370_000, -6_250],
  ['신나리', 38_000_000, 40.0, 'cash', 9, 11_400_000, 0],
  ['양소희', 39_000_000, 30.0, 'cash', 9, 8_770_000, -5_000],
  ['이다정', 41_100_000, 20.0, 'cash', 9, 6_160_000, -5_000],
  ['안승현', 36_000_000, 14.0, 'cash', 9, 3_780_000, 0],
  ['진호령', 33_000_000, 30.0, 'cash', 9, 7_420_000, -5_000],
  ['장선우', 32_000_000, 29.0, 'cash', 9, 6_960_000, 0],
] as const;

const NEW_HIRE: readonly [string, number, number, DetailAxis, number, number, number] = [
  '신규채용1(청년의무)',
  51_000_000,
  100.0,
  'cash',
  8,
  34_000_000,
  0,
];

const YEAR_1 = 'year-1';
const YEAR_2 = 'year-2';

function personnelFactors(ratePercent: number, months: number): DetailFactor[] {
  return [
    { label: '참여율(%)', value: ratePercent, isPercent: true },
    { label: '참여기간(월)', value: months, isPercent: false },
  ];
}

function personnelRow(
  entry: readonly [string, number, number, DetailAxis, number, number, number],
  order: number,
  yearId = YEAR_1
): ExportDetailRow {
  const [name, , rate, axis, months, , adjustment] = entry;
  return {
    yearId,
    category: 'personnel',
    subcategory: 'personnel_internal',
    axis,
    formula: 'personnel',
    memberId: name,
    unitPrice: 0,
    adjustment,
    factors: personnelFactors(rate, months),
    name: '',
    spec: '',
    note: '',
    order,
  };
}

function quantityRow(partial: Partial<ExportDetailRow> & Pick<ExportDetailRow, 'category' | 'subcategory'>): ExportDetailRow {
  return {
    yearId: YEAR_1,
    axis: 'cash',
    formula: 'quantity',
    memberId: null,
    unitPrice: 0,
    adjustment: 0,
    factors: [],
    name: '',
    spec: '',
    note: '',
    order: 0,
    ...partial,
  };
}

const MEMBERS: ExportMember[] = [
  ...PERSONNEL.map(([name, salary]) => ({
    id: name,
    name,
    position: '연구원',
    annualSalary: salary,
    hireType: 'existing' as const,
  })),
  {
    id: NEW_HIRE[0],
    name: NEW_HIRE[0],
    position: '연구원',
    annualSalary: NEW_HIRE[1],
    hireType: 'new' as const,
  },
];

/** 부록 B.7.2 연구활동비 (회의비 · 국내출장비) */
const MEETING = quantityRow({
  category: 'activity',
  subcategory: 'activity_meeting',
  name: '회의비',
  unitPrice: 500_000,
  factors: [{ label: '회', value: 6, isPercent: false }],
  note: '월 1회',
});

const TRAVEL = quantityRow({
  category: 'activity',
  subcategory: 'activity_travel_dom',
  name: '국내출장비',
  unitPrice: 150_000,
  factors: [
    { label: '인원', value: 2, isPercent: false },
    { label: '횟수', value: 4, isPercent: false },
  ],
});

function planOf(details: readonly ExportDetailRow[]): ExportPlanData {
  return {
    details,
    members: MEMBERS,
    years: [
      { id: YEAR_1, order: 0, name: '1차년도' },
      { id: YEAR_2, order: 1, name: '2차년도' },
    ],
    indirectBase: DEFAULT_INDIRECT_BASE,
  };
}

const B7_DETAILS: ExportDetailRow[] = [
  ...PERSONNEL.map((entry, index) => personnelRow(entry, index)),
  personnelRow(NEW_HIRE, PERSONNEL.length),
  MEETING,
  TRAVEL,
];

const b7Plan = planOf(B7_DETAILS);
const b7Writes = buildDetailWrites(b7Plan, YEAR_1, layout);

// ─── 부록 B.7.1이 정확한 셀에 나간다 ─────────────────────────

describe('부록 B.7.1 인건비 — 실측 값이 실측 셀로 나간다 (X-4·X-6)', () => {
  const existing = blockOf('personnel/null#existing');
  const newHire = blockOf('personnel/null#newHire');

  it('첫 행(여욱현)이 첫 슬롯에 들어간다 — 성명·연봉·참여기간·현금', () => {
    const row = existing.slotRows[0]!;
    expect(valueAt(b7Writes, DETAIL_SHEET, encodeAddr(columnOf(existing, 'memberName'), row))?.value).toBe('여욱현');
    expect(valueAt(b7Writes, DETAIL_SHEET, encodeAddr(columnOf(existing, 'salary'), row))?.value).toBe(180_000_000);
    expect(valueAt(b7Writes, DETAIL_SHEET, encodeAddr(columnOf(existing, 'period'), row))?.value).toBe(9);
    expect(valueAt(b7Writes, DETAIL_SHEET, encodeAddr(columnOf(existing, 'cashTotal'), row))?.value).toBe(13_500_000);
  });

  it('지동민 40,050,000이 현물 칸에 들어가고 현금 칸은 비워진다 (조정액 −270,000 포함)', () => {
    const row = existing.slotRows[4]!; // B.7.1 표의 5번째 행
    expect(valueAt(b7Writes, DETAIL_SHEET, encodeAddr(columnOf(existing, 'memberName'), row))?.value).toBe('지동민');
    expect(valueAt(b7Writes, DETAIL_SHEET, encodeAddr(columnOf(existing, 'inKindTotal'), row))?.value).toBe(40_050_000);
    // 현금 칸을 비우지 않으면 실측 `K83`처럼 양쪽에 수식이 남은 슬롯에서 금액이 두 번 잡힌다
    expect(valueAt(b7Writes, DETAIL_SHEET, encodeAddr(columnOf(existing, 'cashTotal'), row))?.value).toBeNull();
    expect(valueAt(b7Writes, DETAIL_SHEET, encodeAddr(columnOf(existing, 'total'), row))?.value).toBe(40_050_000);
  });

  it('여욱현 13,500,000 — 축이 다른 행끼리 금액 칸이 섞이지 않는다', () => {
    const row = existing.slotRows[0]!;
    expect(valueAt(b7Writes, DETAIL_SHEET, encodeAddr(columnOf(existing, 'inKindTotal'), row))?.value).toBeNull();
  });

  it('신규채용은 별도 블록의 첫 슬롯이다 (부록 B.8.1 · hireType)', () => {
    const row = newHire.slotRows[0]!;
    expect(valueAt(b7Writes, DETAIL_SHEET, encodeAddr(columnOf(newHire, 'memberName'), row))?.value).toBe(NEW_HIRE[0]);
    expect(valueAt(b7Writes, DETAIL_SHEET, encodeAddr(columnOf(newHire, 'cashTotal'), row))?.value).toBe(34_000_000);
    expect(valueAt(b7Writes, DETAIL_SHEET, encodeAddr(columnOf(newHire, 'period'), row))?.value).toBe(8);
  });

  it('X-6: 금액을 1000으로 나누거나 절사하지 않는다 — 19행 합계가 부록 B.7.3 그대로다', () => {
    const cashColumns = [columnOf(existing, 'cashTotal'), columnOf(newHire, 'cashTotal')];
    const inKindColumns = [columnOf(existing, 'inKindTotal'), columnOf(newHire, 'inKindTotal')];
    const personnelRows = new Set([...existing.slotRows, ...newHire.slotRows]);

    const sumOf = (columns: readonly string[]): number =>
      b7Writes
        .filter((write) => {
          const match = /^([A-Z]+)(\d+)$/.exec(write.addr);
          return (
            write.sheet === DETAIL_SHEET &&
            match !== null &&
            columns.includes(match[1]!) &&
            personnelRows.has(Number(match[2]))
          );
        })
        .reduce((sum, write) => sum + (typeof write.value === 'number' ? write.value : 0), 0);

    expect(sumOf(cashColumns)).toBe(180_840_000);
    expect(sumOf(inKindColumns)).toBe(88_650_000);
  });

  it('조정액이 붙은 행도 원 단위 그대로다 (유태일 5,190,000 · 김형식 13,370,000)', () => {
    const cash = columnOf(existing, 'cashTotal');
    expect(valueAt(b7Writes, DETAIL_SHEET, encodeAddr(cash, existing.slotRows[9]!))?.value).toBe(5_190_000);
    expect(valueAt(b7Writes, DETAIL_SHEET, encodeAddr(cash, existing.slotRows[11]!))?.value).toBe(13_370_000);
  });

  it('금액 열은 clearFormula가 붙는다 — 남의 조정상수가 박힌 수식을 지워야 한다 (X-4)', () => {
    const row = existing.slotRows[0]!;
    expect(valueAt(b7Writes, DETAIL_SHEET, encodeAddr(columnOf(existing, 'cashTotal'), row))?.clearFormula).toBe(true);
    // 근거 열은 수식이 아니다 — 지울 것이 없다
    expect(valueAt(b7Writes, DETAIL_SHEET, encodeAddr(columnOf(existing, 'salary'), row))?.clearFormula).toBeUndefined();
  });
});

// ─── X-7 백분율 왕복 ─────────────────────────────────────────

describe('X-7 참여율 백분율 서식 — 임포트 D-22의 정확한 반대다', () => {
  const existing = blockOf('personnel/null#existing');

  it('참여율 64는 0.64로 나간다 (그대로 쓰면 엑셀이 6400%로 읽는다)', () => {
    const rateColumn = existing.columns.find((column) => column.role === 'rate');
    expect(rateColumn?.percentFormat).toBe(true);
    const write = valueAt(b7Writes, DETAIL_SHEET, encodeAddr(rateColumn!.column, existing.slotRows[4]!));
    expect(write?.value).toBe(0.64);
  });

  it('내보낸 0.64를 다시 임포트하면 64로 돌아온다 (D-22 왕복)', () => {
    const written = valueAt(
      b7Writes,
      DETAIL_SHEET,
      encodeAddr(columnOf(existing, 'rate'), existing.slotRows[4]!)
    )?.value;
    expect(typeof written).toBe('number');

    // 어댑터가 백분율 서식 셀에 쓴 값을 그대로 되읽는 상황을 만든다
    const specs: (string | number | null)[][] = [
      ['1. 직접비 소요명세'],
      ['- 인건비'],
      ['인력구분', '성명', '직위', '연봉', '참여율', '참여기간', '현금', '현물', '계', '비고'],
      ['기존인력', '지동민', '책임', 84_000_000, written as number, 9, null, 40_050_000, 40_050_000, null],
    ];
    const cells: RawCell[][] = specs.map((row) => row.map((value) => ({ value, isError: false })));
    cells[3]![4] = { value: written as number, isError: false, percentFormat: true };
    const sheet: RawSheet = { name: '산출근거', cells, merges: [] };

    const parsed = parseDetailRows(sheet, detectBlocks(sheet, detectSections(sheet))[0]!).rows[0]!;
    expect(parsed.factors[0]).toEqual({ label: '참여율(%)', value: 64, isPercent: true });
  });
});

// ─── X-8 빈 슬롯 ─────────────────────────────────────────────

describe('X-8 빈 슬롯 — 행을 없애지 않고 값만 비운다', () => {
  it('데이터가 없는 슬롯에도 열마다 비우는 쓰기가 나간다', () => {
    const existing = blockOf('personnel/null#existing');
    const emptySlot = existing.slotRows[PERSONNEL.length]!; // 19번째 슬롯부터는 비어 있다
    const writes = b7Writes.filter((write) => write.addr.endsWith(String(emptySlot)));
    expect(writes.length).toBe(existing.columns.length);
    expect(writes.every((write) => write.value === null)).toBe(true);
  });

  it('데이터가 하나도 없는 블록의 슬롯도 비워진다 — 이전 값이 남으면 남의 예산이 된다', () => {
    const block = blockOf('material/material_purchase');
    const addr = encodeAddr(block.columns[0]!.column, block.slotRows[0]!);
    expect(valueAt(b7Writes, DETAIL_SHEET, addr)?.value).toBeNull();
  });
});

// ─── quantity 행 (부록 B.7.2) ────────────────────────────────

describe('부록 B.7.2 quantity 행 — 인자와 금액', () => {
  it('회의비 500,000 × 6회 = 3,000,000이 합계 열에 들어간다', () => {
    const block = blockOf('activity/activity_meeting');
    const row = block.slotRows[0]!;
    expect(valueAt(b7Writes, DETAIL_SHEET, encodeAddr(columnOf(block, 'name'), row))?.value).toBe('회의비');
    expect(valueAt(b7Writes, DETAIL_SHEET, encodeAddr(columnOf(block, 'unitPrice'), row))?.value).toBe(500_000);
    expect(valueAt(b7Writes, DETAIL_SHEET, encodeAddr(columnOf(block, 'factor'), row))?.value).toBe(6);
    expect(valueAt(b7Writes, DETAIL_SHEET, encodeAddr(columnOf(block, 'total'), row))?.value).toBe(3_000_000);
  });

  it('국내출장비는 인자 열 순서대로 인원 2 · 횟수 4가 들어간다 (PL-3)', () => {
    const block = blockOf('activity/activity_travel_dom');
    const row = block.slotRows[0]!;
    const factorColumns = block.columns.filter((column) => column.role === 'factor');
    expect(factorColumns.length).toBeGreaterThanOrEqual(2);
    expect(valueAt(b7Writes, DETAIL_SHEET, encodeAddr(factorColumns[0]!.column, row))?.value).toBe(2);
    expect(valueAt(b7Writes, DETAIL_SHEET, encodeAddr(factorColumns[1]!.column, row))?.value).toBe(4);
    expect(valueAt(b7Writes, DETAIL_SHEET, encodeAddr(columnOf(block, 'total'), row))?.value).toBe(1_200_000);
  });
});

// ─── X-5 용량 ────────────────────────────────────────────────

describe('X-5 용량 — 넘치면 자르지 않고 거부한다', () => {
  const block = blockOf('activity/activity_travel_dom');
  const overRows = [
    { ...TRAVEL, order: 0 },
    { ...TRAVEL, name: '국내출장비(추가)', order: 1 },
  ];

  it('슬롯 수를 맵에서 읽어 넘침을 알린다', () => {
    const report = checkCapacity(overRows, MEMBERS, layout);
    const overflow = report.overflows.find((item) => item.blockKey === block.key);
    expect(overflow).toEqual({
      blockKey: block.key,
      label: block.label,
      needed: overRows.length,
      capacity: block.slotCount,
    });
    expect(overRows.length).toBeGreaterThan(block.slotCount);
  });

  it('넘친 채로 쓰기를 만들려 하면 던진다 — 반쯤 채운 파일을 돌려주지 않는다', () => {
    expect(() => buildDetailWrites(planOf(overRows), YEAR_1, layout)).toThrow(/X-5/);
  });

  it('템플릿에 자리가 없는 비목도 조용히 버리지 않는다', () => {
    const student = quantityRow({ category: 'student_personnel', subcategory: 'student_general' });
    const report = checkCapacity([student], MEMBERS, layout);
    expect(report.unmapped).toEqual([
      {
        category: 'student_personnel',
        subcategory: 'student_general',
        label: '학생인건비 > 일반',
        count: 1,
      },
    ]);
    expect(() => buildDetailWrites(planOf([student]), YEAR_1, layout)).toThrow();
  });

  it('거부 메시지가 무엇이 왜 안 되는지 사람 말로 말한다 — 이 서식에는 학생인건비 표가 없다', () => {
    // 실측 확인: 표준 템플릿의 산출근거에 학생인건비 블록이 없다. 그 비목을 쓴 과제는
    // 통째로 거부되므로 **어느 비목이 왜 안 되는지**가 메시지에 있어야 한다
    expect(layout.detail.blocks.some((block) => block.category === 'student_personnel')).toBe(false);

    const student = quantityRow({ category: 'student_personnel', subcategory: 'student_general' });
    let message = '';
    try {
      buildDetailWrites(planOf([student, { ...student, order: 1 }]), YEAR_1, layout);
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toContain('학생인건비 > 일반');
    expect(message).toContain('2행');
    expect(message).toContain('적을 표가 없다');
    expect(message).toContain(layout.templateFile);
  });

  it('부록 B.7의 1차년도는 넘치지 않는다', () => {
    const report = checkCapacity(B7_DETAILS, MEMBERS, layout);
    expect(report.overflows).toEqual([]);
    expect(report.unmapped).toEqual([]);
    expect(report.truncatedFactors).toEqual([]);
  });
});

// ─── X-5a 근거를 적을 열이 없으면 알린다 ─────────────────────
//
// X-5가 세로(행 수)라면 이건 가로(열)다. 금액은 맞게 나가므로 막지 않지만,
// **인자 개수만 세면 인자가 0개인 행이 판정을 통째로 빠져나간다** — 실측
// `나. 연구지원비` 표에는 단가 열조차 없어 단가 2,000,000원이 소리 없이 사라졌다.

describe('X-5a 근거 열 부족 — 인자와 단가를 따로 센다', () => {
  /** 실측 `나. 연구지원비`(indirect_support) 표는 `내역 · 산출내역 · 합계`뿐이다 */
  const noBasisBlock = layout.detail.blocks.find((block) =>
    block.key.startsWith('indirect/indirect_support')
  )!;

  it('전제 — 그 표에는 단가 열도 인자 열도 없다', () => {
    expect(noBasisBlock.columns.some((column) => column.role === 'unitPrice')).toBe(false);
    expect(noBasisBlock.columns.some((column) => column.role === 'factor')).toBe(false);
  });

  it('인자가 0개여도 단가가 있으면 통지한다 (이전에는 조용히 빠져나갔다)', () => {
    const row = quantityRow({
      category: 'indirect',
      subcategory: 'indirect_support',
      name: '연구실 안전관리비',
      unitPrice: 2_000_000,
      factors: [],
    });
    const report = checkCapacity([row], MEMBERS, layout);
    expect(report.truncatedFactors).toHaveLength(1);
    const truncated = report.truncatedFactors[0]!;
    expect(truncated.unitPriceDropped).toBe(true);
    // 인자는 애초에 없으므로 "0개 중 0개"가 아니라 단가 쪽이 사유여야 한다
    expect(truncated.total).toBe(0);
    expect(truncated.kept).toBe(0);
    expect(truncated.rowLabel).toContain('연구실 안전관리비');
  });

  it('단가가 0이면 통지하지 않는다 — 잃을 근거가 없다', () => {
    const row = quantityRow({
      category: 'indirect',
      subcategory: 'indirect_support',
      name: '연구지원비',
      unitPrice: 0,
      adjustment: 2_000_000,
      factors: [],
    });
    expect(checkCapacity([row], MEMBERS, layout).truncatedFactors).toEqual([]);
  });

  it('단가 열이 있는 표에서는 단가 사유가 붙지 않는다', () => {
    // 세목이 있는 블록으로 좁힌다 — `subcategory: null`인 표(인건비·연구수당·국제공동, D-3a)를
    // 집으면 세목 없는 행이 되어 이 테스트가 재는 것이 달라진다
    const withUnitPrice = layout.detail.blocks.find(
      (block) =>
        block.subcategory !== null && block.columns.some((column) => column.role === 'unitPrice')
    )!;
    const row = quantityRow({
      category: withUnitPrice.category,
      // `find`의 술어는 반환 타입을 좁히지 못한다 — 위에서 null을 걸렀음을 여기서 명시한다
      subcategory: withUnitPrice.subcategory!,
      name: '단가가 들어갈 자리가 있는 행',
      unitPrice: 1_000_000,
      factors: [],
    });
    expect(checkCapacity([row], MEMBERS, layout).truncatedFactors).toEqual([]);
  });

  it('인자 초과와 단가 소실이 겹치면 한 건으로 두 사유를 모두 담는다', () => {
    const row = quantityRow({
      category: 'indirect',
      subcategory: 'indirect_support',
      name: '겹친 행',
      unitPrice: 500_000,
      factors: [{ label: '수량', value: 2, isPercent: false }],
    });
    const report = checkCapacity([row], MEMBERS, layout);
    expect(report.truncatedFactors).toHaveLength(1);
    const truncated = report.truncatedFactors[0]!;
    expect(truncated.unitPriceDropped).toBe(true);
    expect(truncated.total).toBe(1);
    expect(truncated.kept).toBe(0);
  });

  it('인건비는 단가가 아니라 명부 연봉에서 오므로 대상이 아니다 (PL-1)', () => {
    const report = checkCapacity(B7_DETAILS, MEMBERS, layout);
    expect(report.truncatedFactors).toEqual([]);
  });
});

// ─── X-4a 소계·합계는 건드리지 않는다 ────────────────────────

describe('X-4a 소계·합계·비율 — 템플릿 수식이 계산한다', () => {
  const protectedAddrs = new Set<string>();
  for (const block of layout.detail.blocks) {
    for (const subtotal of block.subtotals) {
      for (const addr of [subtotal.cash, subtotal.inKind, subtotal.total]) {
        if (addr !== null) protectedAddrs.add(`${DETAIL_SHEET}!${addr}`);
      }
    }
  }
  for (const total of layout.detail.categoryTotals) {
    protectedAddrs.add(`${DETAIL_SHEET}!${total.valueAddr}`);
    protectedAddrs.add(`${DETAIL_SHEET}!${total.labelAddr}`);
  }
  // 총괄표에서 템플릿이 굴리는 것은 **연차 합계 열뿐이다**. 집계·비율 행의 연차 칸은
  // 총괄표 안의 SUM이 아니라 산출근거를 가리키는 시트 간 참조라 앱이 값으로 덮어쓴다 (X-10c).
  // 비율 행의 합계 열은 여기서 빠진다 — 비율의 합은 의미가 없어 비우는 자리다 (X-10e)
  for (const row of layout.summary.rows) {
    if (row.kind === 'ratio') continue;
    protectedAddrs.add(`${SUMMARY_SHEET}!${encodeAddr(layout.summary.totalColumn, row.row)}`);
  }

  it('산출근거·총괄표 어느 쓰기도 소계·합계·비율 좌표를 건드리지 않는다', () => {
    const all = [...b7Writes, ...buildSummaryWrites(b7Plan, layout).writes];
    const offenders = all
      .map((write) => `${write.sheet}!${write.addr}`)
      .filter((key) => protectedAddrs.has(key));
    expect(offenders).toEqual([]);
  });
});

// ─── 총괄표 (X-10·X-10a·X-10b) ───────────────────────────────

describe('총괄표 — 전 연차 열을 값으로 쓴다 (X-10a)', () => {
  const twoYearPlan = planOf([
    ...B7_DETAILS,
    // 같은 명부의 여욱현이 2차년도에 50% · 12개월 참여한다: 180,000,000 × 0.5 = 90,000,000
    personnelRow(['여욱현', 180_000_000, 50.0, 'cash', 12, 90_000_000, 0], 0, YEAR_2),
  ]);
  const result = buildSummaryWrites(twoYearPlan, layout);
  const internalCash = layout.summary.rows.find(
    (row) => row.subcategory === 'personnel_internal' && row.axis === 'cash'
  )!;
  const yearColumn = (index: number): string =>
    layout.summary.yearColumns.find((year) => year.yearIndex === index)!.column;

  it('1차년도 열도 값으로 덮어쓴다 — 수식을 살려 두면 2차년도 값이 1차년도 칸에 보인다', () => {
    const write = valueAt(result.writes, SUMMARY_SHEET, encodeAddr(yearColumn(1), internalCash.row));
    expect(write?.value).toBe(180_840_000);
    expect(write?.clearFormula).toBe(true);
  });

  it('2차년도 열에는 2차년도 값이 들어간다', () => {
    expect(valueAt(result.writes, SUMMARY_SHEET, encodeAddr(yearColumn(2), internalCash.row))?.value).toBe(
      90_000_000
    );
  });

  it('과제에 없는 연차 열은 비운다 — 남은 수식이 없는 연차에 값을 보여 준다', () => {
    expect(valueAt(result.writes, SUMMARY_SHEET, encodeAddr(yearColumn(3), internalCash.row))?.value).toBeNull();
  });

  it('현물 줄에는 현물 합계가 들어간다 (부록 B.7.3)', () => {
    const internalInKind = layout.summary.rows.find(
      (row) => row.subcategory === 'personnel_internal' && row.axis === 'inKind'
    )!;
    expect(valueAt(result.writes, SUMMARY_SHEET, encodeAddr(yearColumn(1), internalInKind.row))?.value).toBe(
      88_650_000
    );
  });

  it('연구활동비 현금은 부록 B.7.2의 4,200,000이다 (회의비 + 국내출장비)', () => {
    const activityCash = layout.summary.rows.find(
      (row) => row.category === 'activity' && row.axis === 'cash'
    )!;
    expect(valueAt(result.writes, SUMMARY_SHEET, encodeAddr(yearColumn(1), activityCash.row))?.value).toBe(
      4_200_000
    );
  });

  it('X-10b: 24·25행에는 값을 쓰지 않지만 셀은 비운다 — 남은 수식이 다른 연차 값을 보인다', () => {
    for (const row of [24, 25]) {
      for (const year of layout.summary.yearColumns) {
        const write = valueAt(result.writes, SUMMARY_SHEET, encodeAddr(year.column, row));
        expect(write?.value).toBeNull();
        expect(write?.clearFormula).toBe(true);
      }
    }
    const conflicts = result.skipped.filter((skip) => skip.reason === 'conflict');
    expect(conflicts.map((skip) => skip.row)).toEqual([24, 25]);
    expect(conflicts.every((skip) => skip.conflict === 'label-formula-mismatch')).toBe(true);
  });

  it('같은 자리를 가리키는 줄이 둘이면 짐작해서 쓰지 않는다 (학생 인건비 10·11행)', () => {
    const ambiguous = result.skipped.filter((skip) => skip.reason === 'ambiguous');
    expect(ambiguous.map((skip) => skip.row)).toEqual([10, 11]);
    for (const skip of ambiguous) {
      for (const year of layout.summary.yearColumns) {
        const write = valueAt(result.writes, SUMMARY_SHEET, encodeAddr(year.column, skip.row));
        expect(write?.value).toBeNull();
        expect(write?.clearFormula).toBe(true);
      }
    }
  });
});

// ─── X-10c 집계·비율 행도 연차마다 값으로 쓴다 ───────────────
//
// 부록 B.7.3을 그대로 재현한다: 인건비 19행(현금 180,840,000 / 현물 88,650,000) +
// 연구활동비 현금 27,020,000 + 간접비 2,000,000.

/** B.7.2의 4,200,000에 더해 활동비 현금을 B.7.3의 27,020,000으로 채운다 */
const ACTIVITY_REST = quantityRow({
  category: 'activity',
  subcategory: 'activity_etc',
  name: '그 밖의 비용',
  unitPrice: 22_820_000,
  factors: [{ label: '회', value: 1, isPercent: false }],
  order: 1,
});

const INDIRECT = quantityRow({
  category: 'indirect',
  subcategory: 'indirect_support',
  name: '연구지원비',
  unitPrice: 2_000_000,
  factors: [{ label: '수량', value: 1, isPercent: false }],
});

describe('X-10c 집계·비율 행 — 부록 B.7.3이 연차마다 나온다', () => {
  const plan = planOf([...B7_DETAILS, ACTIVITY_REST, INDIRECT]);
  const writes = buildSummaryWrites(plan, layout).writes;
  const yearColumn = (index: number): string =>
    layout.summary.yearColumns.find((year) => year.yearIndex === index)!.column;
  const rowOf = (aggregate: string): number =>
    layout.summary.rows.find((row) => row.aggregate === aggregate)!.row;
  const valueOf = (aggregate: string, yearIndex: number): CellWrite | undefined =>
    valueAt(writes, SUMMARY_SHEET, encodeAddr(yearColumn(yearIndex), rowOf(aggregate)));

  it('총 인건비 E(A+B+C+D) = 269,490,000 — 현금 + 현물', () => {
    expect(valueOf('totalPersonnel', 1)?.value).toBe(269_490_000);
    expect(valueOf('totalPersonnel', 1)?.clearFormula).toBe(true);
  });

  it('수정인건비 E1(PL-11) = 269,490,000 — 연구지원인력인건비가 0이라 E와 같다', () => {
    expect(valueOf('modifiedPersonnel', 1)?.value).toBe(269_490_000);
  });

  it('직접비 계 K = 296,510,000 · 연구개발비 총액 M = 298,510,000 (부록 B.7.3)', () => {
    expect(valueOf('directTotal', 1)?.value).toBe(296_510_000);
    expect(valueOf('grandTotal', 1)?.value).toBe(298_510_000);
  });

  it('간접비 비율 0.9622%가 그대로 재현된다 — 백분율 서식이라 100으로 나눠 쓴다 (X-7)', () => {
    const write = valueOf('indirectRate', 1);
    expect(layout.summary.rows.find((row) => row.aggregate === 'indirectRate')?.percentFormat).toBe(true);
    // 2,000,000 / 207,860,000. 반올림은 표시의 몫이므로(P-8) 값은 나누지 않은 그대로다
    const percent = (write!.value as number) * 100;
    expect(Number(percent.toFixed(4))).toBe(0.9622);
  });

  it('연구수당 비율은 0.00%다 — 연구수당이 없다 (부록 B.7.3)', () => {
    expect(valueOf('allowanceRate', 1)?.value).toBe(0);
  });

  it('E1이 0이면 비율 칸을 비운다 — 0으로 나누지 않는다 (PL-12)', () => {
    const onlyActivity = planOf([MEETING]);
    const noPersonnel = buildSummaryWrites(onlyActivity, layout).writes;
    expect(
      valueAt(noPersonnel, SUMMARY_SHEET, encodeAddr(yearColumn(1), rowOf('allowanceRate')))?.value
    ).toBeNull();
  });

  it('2차년도를 담으면 2차년도 칸에 2차년도 값이, 1차년도 칸에 1차년도 값이 들어간다', () => {
    // X-10c가 막는 그 오류다: 수식을 살려 두면 2차년도 값이 1차년도 칸에 찍히고 2차년도 칸은 빈다
    const twoYear = planOf([
      ...B7_DETAILS,
      ACTIVITY_REST,
      INDIRECT,
      personnelRow(['여욱현', 180_000_000, 50.0, 'cash', 12, 90_000_000, 0], 0, YEAR_2),
    ]);
    const both = buildSummaryWrites(twoYear, layout).writes;
    const at = (aggregate: string, yearIndex: number) =>
      valueAt(both, SUMMARY_SHEET, encodeAddr(yearColumn(yearIndex), rowOf(aggregate)))?.value;

    expect(at('totalPersonnel', 1)).toBe(269_490_000);
    expect(at('totalPersonnel', 2)).toBe(90_000_000);
    expect(at('grandTotal', 1)).toBe(298_510_000);
    expect(at('grandTotal', 2)).toBe(90_000_000);
    // 과제에 없는 3차년도는 비운다
    expect(at('grandTotal', 3)).toBeNull();
  });

  it('PL-11의 비대칭: C(연구지원인력인건비)는 E에 들어가고 E1에서만 빠진다', () => {
    const support = personnelRow(['김영', 90_000_000, 30.0, 'cash', 9, 20_250_000, 0], 99);
    const withSupport = planOf([
      ...B7_DETAILS,
      { ...support, subcategory: 'personnel_support' },
    ]);
    const supportWrites = buildSummaryWrites(withSupport, layout).writes;
    const at = (aggregate: string) =>
      valueAt(supportWrites, SUMMARY_SHEET, encodeAddr(yearColumn(1), rowOf(aggregate)))?.value;

    expect(at('totalPersonnel')).toBe(269_490_000 + 20_250_000);
    expect(at('modifiedPersonnel')).toBe(269_490_000);
  });
});

// ─── X-10e 비율 행의 합계 열은 비운다 ────────────────────────
//
// `J23 = SUM(F23:I23)`은 연차가 여럿 채워지면 **연차별 비율을 더한다**(0.96% + 1.00% → 1.96%).
// 원본은 1차년도 한 칸만 값이 있어 우연히 그 연차의 비율로 보였을 뿐이다.

describe('X-10e 합계 열 — 비율 행만 비우고 금액 행은 그대로 둔다', () => {
  const twoYear = planOf([
    ...B7_DETAILS,
    ACTIVITY_REST,
    INDIRECT,
    personnelRow(['여욱현', 180_000_000, 50.0, 'cash', 12, 90_000_000, 0], 0, YEAR_2),
    { ...INDIRECT, yearId: YEAR_2 },
  ]);
  const result = buildSummaryWrites(twoYear, layout);
  const totalAddr = (row: number): string => encodeAddr(layout.summary.totalColumn, row);
  const ratioRows = layout.summary.rows.filter((row) => row.kind === 'ratio');

  it('맵이 비율 행 두 줄(연구수당 비율 23 · 간접비 비율 28)을 알고 있다', () => {
    expect(ratioRows.map((row) => row.row)).toEqual([23, 28]);
  });

  it('비율 행의 합계 열에 clearFormula 쓰기가 나간다 — 비율의 합은 의미가 없다', () => {
    for (const row of ratioRows) {
      const write = valueAt(result.writes, SUMMARY_SHEET, totalAddr(row.row));
      expect(write, `${row.row}행 합계 열에 쓰기가 없다`).toBeDefined();
      expect(write?.value).toBeNull();
      expect(write?.clearFormula).toBe(true);
    }
  });

  it('금액 행·집계 행의 합계 열에는 아무 쓰기도 나가지 않는다 — X-4a의 검산이 거기 있다', () => {
    const untouched = layout.summary.rows.filter((row) => row.kind !== 'ratio');
    const offenders = untouched
      .filter((row) => valueAt(result.writes, SUMMARY_SHEET, totalAddr(row.row)) !== undefined)
      .map((row) => `${row.row}행(${row.kind})`);
    expect(offenders).toEqual([]);
  });

  it('두 연차 모두 비율이 있어도 합계 칸은 비운다 — 여기가 1.96%가 찍히던 자리다', () => {
    const rateRow = layout.summary.rows.find((row) => row.aggregate === 'indirectRate')!;
    const yearColumn = (index: number): string =>
      layout.summary.yearColumns.find((year) => year.yearIndex === index)!.column;
    // 두 연차 칸에는 각자의 비율이 들어간다
    expect(valueAt(result.writes, SUMMARY_SHEET, encodeAddr(yearColumn(1), rateRow.row))?.value).not.toBeNull();
    expect(valueAt(result.writes, SUMMARY_SHEET, encodeAddr(yearColumn(2), rateRow.row))?.value).not.toBeNull();
    expect(valueAt(result.writes, SUMMARY_SHEET, totalAddr(rateRow.row))?.value).toBeNull();
  });
});

// ─── X-10d 괄호 메모 행은 비운다 ─────────────────────────────

describe('X-10d 메모 행 — 앱에 없는 데이터를 지어내지 않는다', () => {
  const plan = planOf([...B7_DETAILS, ACTIVITY_REST, INDIRECT]);
  const result = buildSummaryWrites(plan, layout);
  const memoRows = layout.summary.rows.filter((row) => row.memo !== undefined);

  it('통합관리비(16행)·연구실 안전관리비(29행)가 메모 행으로 표시돼 있다', () => {
    expect(memoRows.map((row) => row.row)).toEqual([16, 29]);
  });

  it('값 쓰기가 없고 clearFormula로 셀을 비운다 — 수식을 두면 다른 연차 값이 찍힌다', () => {
    for (const row of memoRows) {
      for (const year of layout.summary.yearColumns) {
        const write = valueAt(result.writes, SUMMARY_SHEET, encodeAddr(year.column, row.row));
        expect(write?.value).toBeNull();
        expect(write?.clearFormula).toBe(true);
      }
    }
  });

  it('비운 사실을 skipped로 알린다 — 빈 칸은 사람이 채우지만 틀린 숫자는 그대로 제출된다', () => {
    const memos = result.skipped.filter((skip) => skip.reason === 'memo');
    expect(memos.map((skip) => skip.row)).toEqual([16, 29]);
    expect(memos.map((skip) => skip.label)).toEqual([
      '(연구시설‧장비비 중 통합관리비(현금))',
      '(간접비 중 연구실 안전관리비)',
    ]);
  });

  it('집계 행인데 맵이 무엇을 계산할지도 왜 비우는지도 말하지 않으면 던진다 (X-10c)', () => {
    const broken: TemplateLayout = {
      ...layout,
      summary: {
        ...layout.summary,
        rows: layout.summary.rows.map((row) =>
          row.aggregate === 'grandTotal' ? { ...row, aggregate: undefined } : row
        ),
      },
    };
    expect(() => buildSummaryWrites(plan, broken)).toThrow(/X-10c/);
  });
});

// ─── 비운 줄 알림 (X-10b·X-10d) ──────────────────────────────
//
// 24·25행(국제공동)의 서식 모순은 서식 소유자의 결정을 기다린다 — 그때까지 이 알림이 유일한
// 방어선이다. 사용자가 빈 줄을 보고 "국제공동이 빠졌다"고 읽으면 멀쩡한 예산을 다시 쓰게 된다.

describe('비운 줄 알림 — "합계에는 잡히지만 보이는 줄이 없다"를 사람 말로 말한다', () => {
  const plan = planOf([...B7_DETAILS, ACTIVITY_REST, INDIRECT]);
  const { skipped } = buildSummaryWrites(plan, layout);

  it('비운 줄 전부가 메시지를 갖는다 — reason 코드만으로는 사용자가 알 수 없다', () => {
    expect(skipped.length).toBeGreaterThan(0);
    expect(skipped.filter((skip) => skip.message.trim() === '')).toEqual([]);
  });

  it('행 번호와 서식 라벨이 메시지 안에 있다 — 어느 칸인지 찾아갈 수 있어야 한다', () => {
    for (const skip of skipped) {
      expect(skip.message).toContain(`${skip.row}행`);
      if (skip.label !== '') expect(skip.message).toContain(skip.label);
    }
  });

  it('금액이 총액에는 들어 있다는 사실을 말한다 — 빠진 것이 아니라 보이는 줄이 없는 것이다', () => {
    for (const skip of skipped) {
      expect(skip.message, `${skip.row}행`).toMatch(/이미 들어 있|합계는 맞/);
      expect(skip.message, `${skip.row}행`).toMatch(/빠진 것이 아니|합계는 맞/);
    }
  });

  it('국제공동 자리(24·25행)는 총액에 잡힌다는 것과 손으로 채우라는 것을 함께 말한다', () => {
    const conflicts = skipped.filter((skip) => skip.reason === 'conflict');
    expect(conflicts.map((skip) => skip.row)).toEqual([24, 25]);
    for (const skip of conflicts) {
      expect(skip.message).toContain('직접비 계·연구개발비 총액에는 이미 들어 있습니다');
      expect(skip.message).toContain('보이는 줄이 없는 것');
      expect(skip.message).toContain('손으로 채우십시오');
    }
  });

  it('메모 행은 상위 비목에 이미 들어 있다고 말한다 — 여기는 합계가 어긋나지 않는다', () => {
    const memos = skipped.filter((skip) => skip.reason === 'memo');
    expect(memos.map((skip) => skip.row)).toEqual([16, 29]);
    for (const skip of memos) expect(skip.message).toContain('합계는 맞으니');
  });

  it('학생 인건비 두 줄은 현금/현물을 나눠 적으라고 말한다 (ambiguous)', () => {
    const ambiguous = skipped.filter((skip) => skip.reason === 'ambiguous');
    expect(ambiguous.map((skip) => skip.row)).toEqual([10, 11]);
    for (const skip of ambiguous) expect(skip.message).toContain('나눠 적으십시오');
  });
});

// ─── X-12 파일명 ─────────────────────────────────────────────

describe('X-12 파일명 — 과제명·연차·생성일', () => {
  it('과제명·연차·생성일이 모두 들어간다', () => {
    expect(exportFileName({ name: 'AI 기반 진단' }, { order: 1, name: '2차년도' }, '2026-08-12')).toBe(
      'AI 기반 진단_2차년도_20260812.xlsx'
    );
  });

  it('파일명 금지 문자를 치환한다', () => {
    expect(
      exportFileName({ name: 'A/B:C*D?E"F<G>H|I\\J' }, { order: 0, name: '1차년도' }, '2026-01-02')
    ).toBe('A_B_C_D_E_F_G_H_I_J_1차년도_20260102.xlsx');
  });

  it('연차 이름이 비어 있으면 order로 만든다 — 이름 없는 파일을 내지 않는다', () => {
    expect(exportFileName({ name: '과제' }, { order: 2, name: '' }, '2026-12-31')).toBe(
      '과제_3차년도_20261231.xlsx'
    );
  });

  it('생성일 형식이 어긋나면 던진다 — 날짜 없는 파일명은 X-12의 목적을 잃는다', () => {
    expect(() => exportFileName({ name: '과제' }, { order: 0, name: '1차년도' }, '20260812')).toThrow();
  });
});
