// 제출 서식의 연구실 안전관리비 — SOT §6.12 X-10d ①·② (Phase 26 S-19, U-4)
//
// 표준 서식에는 연구실 안전관리비 **표가 없다.** 그 산출 행은 `나. 연구지원비` 표에 이어 적고
// 경고하며(②), 총괄표 29행 "(간접비 중 연구실 안전관리비)"는 그 연차 세목 소계를 값으로 쓴다(①).
// 다시 가져오면 `indirect_support`로 돌아오고 간접비 합계는 그대로다(④).

import { describe, expect, it } from 'vitest';
import { applyWrites, readTemplate, templatePath, writeWorkbookBuffer } from '@/lib/export-adapter';
import { readWorkbook } from '@/lib/import-adapter';
import { DEFAULT_TEMPLATE_ID, encodeAddr, findTemplate, validateLayout } from '@/lib/export/layouts';
import { buildDetailWrites, checkCapacity } from '@/lib/export/detail-sheet';
import { buildSummaryWrites } from '@/lib/export/summary-sheet';
import type { CellWrite, ExportDetailRow, ExportPlanData, TemplateLayout } from '@/lib/export/types';
import { detectBlocks, detectSections, parseDetailRows } from '@/lib/import/detail-sheet';
import type { DetailDraftRow } from '@/lib/import/detail-sheet';
import { DEFAULT_INDIRECT_BASE } from '@/lib/rules';

const entry = findTemplate(DEFAULT_TEMPLATE_ID);
if (!entry) throw new Error('표준 템플릿을 찾지 못했다');
const layout: TemplateLayout = entry.layout;

const YEAR_1 = 'year-1';
const YEAR_2 = 'year-2';
const LAB_SAFETY_ROW = 29;

function indirectRow(partial: Partial<ExportDetailRow> & Pick<ExportDetailRow, 'subcategory' | 'name'>): ExportDetailRow {
  return {
    yearId: YEAR_1,
    category: 'indirect',
    axis: 'cash',
    formula: 'quantity',
    memberId: null,
    unitPrice: 0,
    adjustment: 0,
    factors: [],
    spec: '',
    note: '',
    order: 0,
    ...partial,
  };
}

// 연구실 안전관리비 행이 order 0으로 앞서 있어도 연구지원비 표의 제 행 **뒤**에 적혀야 한다
const SUPPORT = indirectRow({ subcategory: 'indirect_support', name: '기관 공통지원경비', unitPrice: 3_000_000, order: 1 });
const SAFETY = indirectRow({ subcategory: 'indirect_lab_safety', name: '연구실 안전점검', unitPrice: 1_500_000, order: 0 });
const SAFETY_2 = indirectRow({ subcategory: 'indirect_lab_safety', name: '보호구 구입', unitPrice: 500_000, order: 2 });

function planOf(details: readonly ExportDetailRow[]): ExportPlanData {
  return {
    details,
    members: [],
    years: [
      { id: YEAR_1, order: 0, name: '1차년도' },
      { id: YEAR_2, order: 1, name: '2차년도' },
    ],
    indirectBase: DEFAULT_INDIRECT_BASE,
  };
}

const supportBlock = layout.detail.blocks.find((block) => block.subcategory === 'indirect_support');
if (!supportBlock) throw new Error('맵에 나. 연구지원비 표가 없다');
const nameColumn = supportBlock.columns.find((column) => column.role === 'name')?.column;
const totalColumn = supportBlock.columns.find((column) => column.role === 'total')?.column;
if (!nameColumn || !totalColumn) throw new Error('나. 연구지원비 표에 내역·합계 열이 없다');

function valueAt(writes: readonly CellWrite[], sheet: string, addr: string): CellWrite | undefined {
  return writes.find((write) => write.sheet === sheet && write.addr === addr);
}

describe('X-10d ② 산출근거 — 서식에 표가 없는 세목은 나. 연구지원비 표에 적는다', () => {
  it('표준 서식에는 연구실 안전관리비 표가 없다 (그래서 이 규칙이 필요하다)', () => {
    expect(layout.detail.blocks.some((block) => block.subcategory === 'indirect_lab_safety')).toBe(false);
  });

  const report = checkCapacity([SAFETY, SUPPORT, SAFETY_2], [], layout);

  it('거부하지 않는다 — unmapped가 아니다', () => {
    expect(report.unmapped).toEqual([]);
    expect(report.overflows).toEqual([]);
  });

  it('연구지원비 표의 제 행 뒤에 order 순으로 이어 적는다', () => {
    const assigned = report.assignments.find((assignment) => assignment.block.key === supportBlock.key);
    expect(assigned?.rows.map((row) => row.name)).toEqual(['기관 공통지원경비', '연구실 안전점검', '보호구 구입']);
  });

  it('옮겨 적은 사실을 세목·표·행 수로 알린다', () => {
    expect(report.relocated).toEqual([
      {
        blockKey: supportBlock.key,
        fromLabel: '연구실 안전관리비',
        toLabel: '나. 연구지원비',
        category: 'indirect',
        subcategory: 'indirect_lab_safety',
        count: 2,
      },
    ]);
  });

  it('안전관리비 행이 없으면 relocated가 비어 있다 — 기존 과제에는 경고가 없다', () => {
    expect(checkCapacity([SUPPORT], [], layout).relocated).toEqual([]);
  });

  it('품명 그대로, 금액은 앱 계산값으로 쓴다', () => {
    const writes = buildDetailWrites(planOf([SAFETY, SUPPORT]), YEAR_1, layout);
    const [first, second] = supportBlock.slotRows;
    const sheet = layout.detail.sheet;
    expect(valueAt(writes, sheet, encodeAddr(nameColumn, first!))?.value).toBe('기관 공통지원경비');
    expect(valueAt(writes, sheet, encodeAddr(nameColumn, second!))?.value).toBe('연구실 안전점검');
    expect(valueAt(writes, sheet, encodeAddr(totalColumn, second!))?.value).toBe(1_500_000);
  });

  it('빈 줄이 모자라면 X-5 그대로 넘침으로 막는다', () => {
    const many = Array.from({ length: supportBlock.slotCount }, (_, index) =>
      indirectRow({ subcategory: 'indirect_lab_safety', name: `안전 ${index}`, unitPrice: 1, order: index })
    );
    const overflow = checkCapacity([SUPPORT, ...many], [], layout).overflows;
    expect(overflow).toEqual([
      {
        blockKey: supportBlock.key,
        label: supportBlock.label,
        needed: supportBlock.slotCount + 1,
        capacity: supportBlock.slotCount,
      },
    ]);
  });
});

describe('X-10d ① 총괄표 29행 — 그 연차 세목 소계', () => {
  const summarySheet = layout.summary.sheet;
  const column = (yearIndex: number): string => {
    const found = layout.summary.yearColumns.find((year) => year.yearIndex === yearIndex)?.column;
    if (!found) throw new Error(`${yearIndex}차년도 열이 없다`);
    return found;
  };

  it('맵의 29행은 메모가 아니라 labSafetyTotal 집계다 — 맵 검증도 통과한다', () => {
    const row = layout.summary.rows.find((candidate) => candidate.row === LAB_SAFETY_ROW);
    expect(row?.label).toBe('(간접비 중 연구실 안전관리비)');
    expect(row?.aggregate).toBe('labSafetyTotal');
    expect(row?.memo).toBeUndefined();
    const template = readTemplate(templatePath(entry.file));
    expect(validateLayout(layout, template.sheets)).toEqual([]);
  });

  it('세목 행이 있는 연차는 소계를 값으로 쓰고, 없는 연차는 비우고 그 연차를 알린다', () => {
    const { writes, skipped } = buildSummaryWrites(planOf([SUPPORT, SAFETY, SAFETY_2]), layout);
    const year1 = valueAt(writes, summarySheet, encodeAddr(column(1), LAB_SAFETY_ROW));
    const year2 = valueAt(writes, summarySheet, encodeAddr(column(2), LAB_SAFETY_ROW));
    expect(year1).toMatchObject({ value: 2_000_000, clearFormula: true });
    expect(year2).toMatchObject({ value: null, clearFormula: true });

    const notice = skipped.filter((skip) => skip.row === LAB_SAFETY_ROW);
    expect(notice).toHaveLength(1);
    expect(notice[0]).toMatchObject({ reason: 'memo', years: ['2차년도'] });
    expect(notice[0]?.message).toContain('29행');
    expect(notice[0]?.message).toContain('2차년도');
    expect(notice[0]?.message).toContain('합계는 맞으니');
  });

  it('간접비 줄(27행)은 전 세목 합이다 — 29행을 다시 더하지 않는다', () => {
    const { writes } = buildSummaryWrites(planOf([SUPPORT, SAFETY, SAFETY_2]), layout);
    const indirect = layout.summary.rows.find((row) => row.category === 'indirect' && row.kind === 'amount');
    if (!indirect) throw new Error('간접비 줄이 없다');
    expect(valueAt(writes, summarySheet, encodeAddr(column(1), indirect.row))?.value).toBe(5_000_000);
  });

  it('0원 세목 행도 "있다" — 0을 쓰고 알리지 않는다', () => {
    const zero = indirectRow({ subcategory: 'indirect_lab_safety', name: '미정', unitPrice: 0 });
    const zero2 = { ...zero, yearId: YEAR_2 };
    const { writes, skipped } = buildSummaryWrites(planOf([zero, zero2]), layout);
    expect(valueAt(writes, summarySheet, encodeAddr(column(1), LAB_SAFETY_ROW))?.value).toBe(0);
    expect(skipped.filter((skip) => skip.row === LAB_SAFETY_ROW)).toEqual([]);
  });

  it('어느 연차에도 세목 행이 없으면 지금처럼 전부 비우고 알린다', () => {
    const { writes, skipped } = buildSummaryWrites(planOf([SUPPORT]), layout);
    for (const yearIndex of [1, 2]) {
      expect(valueAt(writes, summarySheet, encodeAddr(column(yearIndex), LAB_SAFETY_ROW))?.value).toBeNull();
    }
    expect(skipped.find((skip) => skip.row === LAB_SAFETY_ROW)?.years).toEqual(['1차년도', '2차년도']);
  });
});

describe('X-10d ④ 왕복 — 안전관리비 행은 다시 가져오면 indirect_support로 돌아온다', () => {
  const plan = planOf([SUPPORT, SAFETY]);
  const exported = (() => {
    const template = readTemplate(templatePath(entry.file));
    applyWrites(template.workbook, [
      ...buildDetailWrites(plan, YEAR_1, layout),
      ...buildSummaryWrites(plan, layout).writes,
    ]);
    return writeWorkbookBuffer(template.workbook);
  })();

  const rows: DetailDraftRow[] = (() => {
    const sheet = readWorkbook(new Uint8Array(exported)).find((candidate) => candidate.name === layout.detail.sheet);
    if (!sheet) throw new Error('내보낸 파일에 산출근거 시트가 없다');
    const blocks = detectBlocks(sheet, detectSections(sheet));
    return blocks.flatMap((block) => parseDetailRows(sheet, block).rows);
  })();

  it('두 행 모두 indirect_support 행으로 돌아온다', () => {
    const indirect = rows.filter((row) => row.category === 'indirect');
    expect(indirect.filter((row) => row.fileAmount !== 0).map((row) => [row.name, row.subcategory, row.fileAmount])).toEqual([
      ['기관 공통지원경비', 'indirect_support', 3_000_000],
      ['연구실 안전점검', 'indirect_support', 1_500_000],
    ]);
  });

  it('간접비 합계는 그대로다', () => {
    const total = rows.filter((row) => row.category === 'indirect').reduce((sum, row) => sum + row.fileAmount, 0);
    expect(total).toBe(4_500_000);
  });
});
