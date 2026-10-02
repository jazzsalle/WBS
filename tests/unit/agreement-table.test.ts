// 협약 예산 표 모델 (SOT §6.19 AG-8, 부록 F) — TSV·FormSheet·exceljs 재로드 일치.
//
// 핵심 불변식: **같은 표 모델에서 나온 TSV와 엑셀 셀 값이 칸마다 같다.** 엑셀은 exceljs로 다시 열어 확인한다
// — SheetJS(cellFormula:true)는 `<v>` 없는 수식 셀을 버려 검증이 조용히 비는 함정이 있었다(Phase 19).

import { describe, expect, it } from 'vitest';
import ExcelJS from 'exceljs';
import { writeInputFormWorkbook } from '@/lib/input-form-adapter';
import {
  AGREEMENT_GUIDE_SHEET_NAME,
  agreementWorkbookFileName,
  assertTableModel,
  columnLetter,
  sumFormula,
  toFormSheet,
  toFormWorkbook,
  toGuideSheet,
  toTsv,
} from '@/lib/agreement/table';
import type { TableCell, TableCellRef, TableModel } from '@/lib/agreement/table';

// ─── 픽스처 ───────────────────────────────────────────────────────────────────

const t = (text: string): TableCell => ({ kind: 'text', text });
const a = (value: number): TableCell => ({ kind: 'amount', value });
const e: TableCell = { kind: 'empty' };
const sum = (value: number, terms: TableCellRef[]): TableCell => ({ kind: 'sum', value, terms });
const ref = (row: number, col: number, negate?: true): TableCellRef => (negate ? { row, col, negate } : { row, col });

/**
 * 비목별 보기 모양(계획서 S-20 버전 A의 Y1 일부). 열: A 연차 · B 비목 · C 현금 · D 현물 · E 계.
 * 행 0~2 데이터, 3 Y1 소계, 4 총계. 재료비 현물은 줄이 없는 칸(empty), 비목 라벨에 탭·개행·따옴표.
 */
const CATEGORY: TableModel = {
  title: '비목별 — 최종협약본',
  columns: [
    { label: '연차', type: 'text', key: true, width: 10 },
    { label: '비목', type: 'text', key: true },
    { label: '현금', type: 'amount' },
    { label: '현물', type: 'amount' },
    { label: '계', type: 'amount' },
  ],
  rows: [
    { kind: 'data', cells: [t('1차년도'), t('인건비'), a(30_000_000), a(10_000_000), sum(40_000_000, [ref(0, 2), ref(0, 3)])] },
    { kind: 'data', cells: [t('1차년도'), t('재료비\t"특수"'), a(5_000_000), e, sum(5_000_000, [ref(1, 2), ref(1, 3)])] },
    { kind: 'data', cells: [t('1차년도'), t('연구활동비\n(회의·출장)'), a(2_000_000), a(0), sum(2_000_000, [ref(2, 2), ref(2, 3)])] },
    {
      kind: 'subtotal',
      cells: [
        t('1차년도'),
        t('소계'),
        sum(37_000_000, [ref(0, 2), ref(1, 2), ref(2, 2)]),
        sum(10_000_000, [ref(0, 3), ref(1, 3), ref(2, 3)]),
        sum(47_000_000, [ref(3, 2), ref(3, 3)]),
      ],
    },
    {
      kind: 'total',
      cells: [t('총계'), t(''), sum(37_000_000, [ref(3, 2)]), sum(10_000_000, [ref(3, 3)]), sum(47_000_000, [ref(3, 4)])],
    },
  ],
};

/** 증감 표 모양: 열 A 세목 · B A 버전 · C B 버전 · D 증감(=C−B). 한쪽에만 있는 줄은 empty */
const CHANGES: TableModel = {
  title: '금액 증감',
  columns: [
    { label: '세목', type: 'text', key: true },
    { label: '최종협약본', type: 'amount' },
    { label: '협약변경 1차', type: 'amount' },
    { label: '증감', type: 'amount' },
  ],
  rows: [
    { kind: 'data', cells: [t('재료비/구입'), a(5_000_000), a(3_000_000), sum(-2_000_000, [ref(0, 2), ref(0, 1, true)])] },
    { kind: 'data', cells: [t('국내출장비'), a(800_000), e, sum(-800_000, [ref(1, 2), ref(1, 1, true)])] },
    { kind: 'data', cells: [t('국외출장비'), e, a(500_000), sum(500_000, [ref(2, 2), ref(2, 1, true)])] },
    {
      kind: 'total',
      cells: [
        t('계'),
        sum(5_800_000, [ref(0, 1), ref(1, 1), ref(2, 1)]),
        sum(3_500_000, [ref(0, 2), ref(1, 2), ref(2, 2)]),
        sum(-2_300_000, [ref(3, 2), ref(3, 1, true)]),
      ],
    },
  ],
};

/** 엑셀 붙여넣기 규약대로 TSV를 칸 격자로 되돌린다 — 따옴표 안의 탭·개행·`""` 처리 */
function parseTsv(tsv: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let i = 0;
  let quoted = false;
  while (i < tsv.length) {
    const ch = tsv[i]!;
    if (quoted) {
      if (ch === '"' && tsv[i + 1] === '"') {
        field += '"';
        i += 2;
      } else if (ch === '"') {
        quoted = false;
        i += 1;
      } else {
        field += ch;
        i += 1;
      }
      continue;
    }
    if (ch === '"' && field === '') {
      quoted = true;
      i += 1;
    } else if (ch === '\t') {
      row.push(field);
      field = '';
      i += 1;
    } else if (ch === '\r' && tsv[i + 1] === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
      i += 2;
    } else {
      field += ch;
      i += 1;
    }
  }
  row.push(field);
  rows.push(row);
  return rows;
}

/** exceljs 셀 → TSV와 같은 문자열. 수식 칸은 결과값 */
function excelText(cell: ExcelJS.Cell): string {
  const v = cell.value;
  if (v === null || v === undefined) return '';
  if (typeof v === 'number' || typeof v === 'string') return String(v);
  if (typeof v === 'object' && 'formula' in v) {
    const result = (v as ExcelJS.CellFormulaValue).result;
    return result === undefined || result === null ? '<결과값 없음>' : String(result);
  }
  return `<예상 밖 값 ${JSON.stringify(v)}>`;
}

async function reload(model: TableModel, sheetName: string): Promise<ExcelJS.Workbook> {
  const wb = toFormWorkbook({
    guide: { title: '과제 — 협약 예산', subtitle: '생성 2026-10-02 · 최종협약본 · 수행', entries: [{ label: '목적', body: '보기' }] },
    tables: [{ sheetName, model }],
    fileName: 'x.xlsx',
  });
  const buffer = await writeInputFormWorkbook(wb);
  const loaded = new ExcelJS.Workbook();
  await loaded.xlsx.load(buffer as unknown as ArrayBuffer);
  return loaded;
}

// ─── TSV ──────────────────────────────────────────────────────────────────────

describe('toTsv (AG-8 [복사])', () => {
  it('헤더 1행 + 행, 탭·\\r\\n 구분, 금액은 구분 기호 없는 원 단위 정수, 빈 칸은 \'\', sum은 값', () => {
    expect(toTsv(CATEGORY)).toBe(
      [
        '연차\t비목\t현금\t현물\t계',
        '1차년도\t인건비\t30000000\t10000000\t40000000',
        '1차년도\t"재료비\t""특수"""\t5000000\t\t5000000',
        '1차년도\t"연구활동비\n(회의·출장)"\t2000000\t0\t2000000',
        '1차년도\t소계\t37000000\t10000000\t47000000',
        '총계\t\t37000000\t10000000\t47000000',
      ].join('\r\n')
    );
  });

  it('끝에 행 구분을 붙이지 않는다', () => {
    expect(toTsv(CATEGORY).endsWith('\r\n')).toBe(false);
  });

  it('음수 증감은 부호만 붙은 정수다', () => {
    const lines = toTsv(CHANGES).split('\r\n');
    expect(lines[1]).toBe('재료비/구입\t5000000\t3000000\t-2000000');
    expect(lines[2]).toBe('국내출장비\t800000\t\t-800000');
    expect(lines[4]).toBe('계\t5800000\t3500000\t-2300000');
  });

  it('따옴표만 든 칸·캐리지 리턴 칸도 감싼다, 평범한 칸은 그대로', () => {
    const model: TableModel = {
      title: 'x',
      columns: [
        { label: '"A"', type: 'text' },
        { label: 'B', type: 'text' },
        { label: 'C', type: 'text' },
      ],
      rows: [{ kind: 'data', cells: [t('a"b'), t('x\ry'), t('평범')] }],
    };
    expect(toTsv(model)).toBe('"""A"""\tB\tC\r\n"a""b"\t"x\ry"\t평범');
  });

  it('TSV를 붙여넣기 규약으로 되돌리면 원래 칸 값이다', () => {
    const grid = parseTsv(toTsv(CATEGORY));
    expect(grid[2]).toEqual(['1차년도', '재료비\t"특수"', '5000000', '', '5000000']);
    expect(grid[3]?.[1]).toBe('연구활동비\n(회의·출장)');
    expect(grid).toHaveLength(6);
  });
});

// ─── 검증 ─────────────────────────────────────────────────────────────────────

describe('assertTableModel — 모순된 모델은 조용히 내보내지 않는다', () => {
  const base = (cells: TableCell[], extra: TableCell[][] = []): TableModel => ({
    title: 'T',
    columns: [
      { label: 'A', type: 'amount' },
      { label: 'B', type: 'amount' },
    ],
    rows: [{ kind: 'data', cells }, ...extra.map((c) => ({ kind: 'data' as const, cells: c }))],
  });

  it('통과 예', () => {
    expect(() => assertTableModel(CATEGORY)).not.toThrow();
    expect(() => assertTableModel(CHANGES)).not.toThrow();
  });

  it('sum 값이 항들의 합과 다르면 던진다', () => {
    expect(() => assertTableModel(base([a(1), sum(2, [ref(0, 0)])]))).toThrow(/항들의 합\(1\)/);
  });

  it('소수·NaN 금액은 던진다(원 단위 정수)', () => {
    expect(() => assertTableModel(base([a(1.5), e]))).toThrow(/원 단위 정수/);
    expect(() => assertTableModel(base([a(Number.NaN), e]))).toThrow(/원 단위 정수/);
  });

  it('칸 수가 열 수와 다르면 던진다', () => {
    expect(() => assertTableModel(base([a(1)]))).toThrow(/칸 수/);
  });

  it('글자 칸·표 밖·자기 자신·중복 항·빈 항을 더하면 던진다', () => {
    const textModel: TableModel = {
      title: 'T',
      columns: [
        { label: 'A', type: 'text' },
        { label: 'B', type: 'amount' },
      ],
      rows: [{ kind: 'data', cells: [t('x'), sum(0, [ref(0, 0)])] }],
    };
    expect(() => assertTableModel(textModel)).toThrow(/글자 칸/);
    expect(() => assertTableModel(base([a(1), sum(1, [ref(5, 0)])]))).toThrow(/표 밖/);
    expect(() => assertTableModel(base([a(1), sum(1, [ref(0, 1)])]))).toThrow(/자기 자신/);
    expect(() => assertTableModel(base([a(1), sum(2, [ref(0, 0), ref(0, 0)])]))).toThrow(/두 번/);
    expect(() => assertTableModel(base([a(1), sum(0, [])]))).toThrow(/더할 칸이 없습니다/);
  });

  it('합계끼리 순환하면 던진다', () => {
    expect(() => assertTableModel(base([sum(0, [ref(1, 0)]), e], [[sum(0, [ref(0, 0)]), e]]))).toThrow(/순환/);
  });

  it('열이 없는 표는 던진다', () => {
    expect(() => assertTableModel({ title: 'T', columns: [], rows: [] })).toThrow(/열이 없습니다/);
  });
});

// ─── 수식 ─────────────────────────────────────────────────────────────────────

describe('sumFormula — 시트 좌표(헤더 1행, 모델 0행 = 시트 2행)', () => {
  it('열 문자', () => {
    expect([0, 1, 25, 26, 27, 51, 52, 701, 702].map(columnLetter)).toEqual([
      'A', 'B', 'Z', 'AA', 'AB', 'AZ', 'BA', 'ZZ', 'AAA',
    ]);
  });

  it('같은 열 연속 행은 세로 범위, 같은 행 연속 열은 가로 범위', () => {
    expect(sumFormula([ref(0, 2), ref(1, 2), ref(2, 2)])).toBe('SUM(C2:C4)');
    expect(sumFormula([ref(0, 2), ref(0, 3)])).toBe('SUM(C2:D2)');
    expect(sumFormula([ref(0, 2), ref(2, 2), ref(3, 2)])).toBe('SUM(C4:C5,C2)');
    expect(sumFormula([ref(0, 2)])).toBe('SUM(C2)');
  });

  it('빼는 항이 있으면 B−A 꼴', () => {
    expect(sumFormula([ref(0, 2), ref(0, 1, true)])).toBe('C2-B2');
    expect(sumFormula([ref(3, 2), ref(3, 1, true)])).toBe('C5-B5');
    expect(sumFormula([ref(0, 1, true)])).toBe('0-B2');
    expect(sumFormula([ref(0, 2), ref(1, 2), ref(0, 1, true), ref(1, 1, true)])).toBe('SUM(C2:C3)-SUM(B2:B3)');
  });

  it('범위로 묶고도 255개를 넘으면 던진다(조용히 자르지 않는다)', () => {
    const terms = Array.from({ length: 256 }, (_, i) => ref(i * 2, 0));
    expect(() => sumFormula(terms)).toThrow(/엑셀 한도/);
  });
});

// ─── FormSheet ────────────────────────────────────────────────────────────────

describe('toFormSheet (AG-8 엑셀 셀, 부록 F 힌트)', () => {
  const sheet = toFormSheet(CATEGORY, '비목별');

  it('헤더 1행(병합 없음) + 데이터, 행 역할, 힌트', () => {
    expect(sheet.name).toBe('비목별');
    expect(sheet.kind).toBe('data');
    expect(sheet.hidden).toBe(false);
    expect(sheet.headerRow).toBe(1);
    expect(sheet.dataStartRow).toBe(2);
    expect(sheet.rows[0]).toEqual(['연차', '비목', '현금', '현물', '계'].map((value) => ({ value })));
    expect(sheet.rowRoles).toEqual(['header', 'data', 'data', 'data', 'subtotal', 'total']);
    expect(sheet.columnHints).toEqual([
      { key: true, format: 'text', width: 10, align: 'left' },
      { key: true, format: 'text', width: 20, align: 'left' },
      { key: false, format: 'int', width: 14, align: 'right' },
      { key: false, format: 'int', width: 14, align: 'right' },
      { key: false, format: 'int', width: 14, align: 'right' },
    ]);
  });

  it('sum 칸 = SUM 수식 + 결과값, 금액은 값, empty·빈 글자는 빈 칸', () => {
    expect(sheet.rows[1]?.[4]).toEqual({ formula: 'SUM(C2:D2)', result: 40_000_000 });
    expect(sheet.rows[4]?.[2]).toEqual({ formula: 'SUM(C2:C4)', result: 37_000_000 });
    expect(sheet.rows[4]?.[4]).toEqual({ formula: 'SUM(C5:D5)', result: 47_000_000 });
    expect(sheet.rows[5]?.[4]).toEqual({ formula: 'SUM(E5)', result: 47_000_000 });
    expect(sheet.rows[2]?.[2]).toEqual({ value: 5_000_000 });
    expect(sheet.rows[2]?.[3]).toEqual({});
    expect(sheet.rows[5]?.[1]).toEqual({});
  });

  it('증감 칸 = B−A 수식 + 결과값', () => {
    const changes = toFormSheet(CHANGES, '금액 증감');
    expect(changes.rows[1]?.[3]).toEqual({ formula: 'C2-B2', result: -2_000_000 });
    expect(changes.rows[4]?.[3]).toEqual({ formula: 'C5-B5', result: -2_300_000 });
  });

  it('시트 이름 규칙을 어기면 던진다', () => {
    expect(() => toFormSheet(CATEGORY, '')).toThrow(/1~31자/);
    expect(() => toFormSheet(CATEGORY, 'x'.repeat(32))).toThrow(/1~31자/);
    expect(() => toFormSheet(CATEGORY, 'A/B')).toThrow(/쓸 수 없는 문자/);
    expect(() => toFormSheet(CATEGORY, "'A")).toThrow(/작은따옴표/);
  });

  it('작성안내 시트는 F-8 격자(A1 제목, A2 부제, A4부터 2열)', () => {
    const guide = toGuideSheet({ title: 'T', subtitle: 'S', entries: [{ label: '목적', body: 'B' }] });
    expect(guide).toEqual({
      name: AGREEMENT_GUIDE_SHEET_NAME,
      hidden: false,
      hiddenColumns: [],
      kind: 'guide',
      rows: [[{ value: 'T' }], [{ value: 'S' }], [], [{ value: '목적' }, { value: 'B' }]],
    });
  });

  it('워크북: 작성안내가 첫 시트, 표 0개·시트 이름 중복은 던진다', () => {
    const guide = { title: 'T', subtitle: 'S', entries: [] };
    const wb = toFormWorkbook({ guide, tables: [{ sheetName: '비목별', model: CATEGORY }], fileName: 'f.xlsx' });
    expect(wb.sheets.map((s) => s.name)).toEqual(['작성안내', '비목별']);
    expect(wb.fileName).toBe('f.xlsx');
    expect(() => toFormWorkbook({ guide, tables: [], fileName: 'f.xlsx' })).toThrow(/표가 하나도/);
    expect(() =>
      toFormWorkbook({ guide, tables: [{ sheetName: '작성안내', model: CATEGORY }], fileName: 'f.xlsx' })
    ).toThrow(/중복/);
  });
});

// ─── exceljs 재로드: 엑셀 = TSV ───────────────────────────────────────────────

describe('writeInputFormWorkbook → exceljs 재로드 (AG-8 엑셀·TSV 일치)', () => {
  it.each([
    ['비목별', CATEGORY],
    ['금액 증감', CHANGES],
  ] as const)('%s: 칸마다 엑셀 값(수식 칸은 결과값) = TSV', async (sheetName, model) => {
    const wb = await reload(model, sheetName);
    const ws = wb.getWorksheet(sheetName);
    expect(ws).toBeDefined();
    const grid = parseTsv(toTsv(model));
    const width = model.columns.length;
    const excel: string[][] = [];
    for (let r = 1; r <= grid.length; r += 1) {
      const row: string[] = [];
      for (let c = 1; c <= width; c += 1) row.push(excelText(ws!.getCell(r, c)));
      excel.push(row);
    }
    expect(excel).toEqual(grid);
    // 표 아래에 새어 든 행이 없다
    expect(ws!.actualRowCount).toBe(grid.length);
  });

  it('수식과 결과값이 함께 남는다', async () => {
    const wb = await reload(CHANGES, '금액 증감');
    const ws = wb.getWorksheet('금액 증감')!;
    expect(ws.getCell('D2').value).toEqual({ formula: 'C2-B2', result: -2_000_000 });
    expect(ws.getCell('C5').value).toEqual({ formula: 'SUM(C2:C4)', result: 3_500_000 });
  });

  it('부록 F: 작성안내 첫 시트, 헤더 채움, #,##0, 합계 행 채움, 키 열 채움, 틀 고정, 탭 색', async () => {
    const wb = await reload(CATEGORY, '비목별');
    expect(wb.worksheets.map((w) => w.name)).toEqual(['작성안내', '비목별']);
    const ws = wb.getWorksheet('비목별')!;
    const fill = (address: string) => (ws.getCell(address).fill as ExcelJS.FillPattern | undefined)?.fgColor?.argb;
    expect(fill('A1')).toBe('FF1A1A1A'); // F-2 헤더
    expect(ws.getCell('A1').font?.bold).toBe(true);
    expect(fill('A2')).toBe('FFF4F1EA'); // F-3 키 열
    expect(fill('C2')).toBeUndefined(); // 금액 열은 키 열이 아니다
    expect(ws.getCell('C2').numFmt).toBe('#,##0'); // F-6
    expect(ws.getCell('E2').numFmt).toBe('#,##0');
    expect(fill('C5')).toBe('FFF7F7F7'); // F-4 소계
    expect(ws.getCell('C5').font?.bold).toBe(true);
    expect(ws.getCell('C5').numFmt).toBe('#,##0');
    expect(fill('A6')).toBe('FFF7F7F7'); // F-4 총계
    expect(ws.views[0]).toMatchObject({ state: 'frozen', ySplit: 1, topLeftCell: 'A2' }); // F-5
    expect(ws.properties.tabColor).toEqual({ argb: 'FF1A1A1A' }); // F-10
    expect(ws.getColumn(2).width).toBe(20); // F-7
  });
});

// ─── 어댑터 result 필드 ───────────────────────────────────────────────────────

describe('FormCell.result — 있을 때만 쓴다', () => {
  it('결과값이 유한하지 않으면 던진다', async () => {
    const sheet = { name: 'S', hidden: false, hiddenColumns: [], rows: [[{ formula: 'SUM(A2)', result: Number.NaN }]] };
    await expect(writeInputFormWorkbook({ sheets: [sheet], fileName: 'x.xlsx' })).rejects.toThrow(/결과값/);
  });

  it('result 없는 수식 셀은 결과값 없이 수식만(기존 양식 그대로)', async () => {
    const sheet = { name: 'S', hidden: false, hiddenColumns: [], rows: [[{ formula: 'SUM(B1)' }, { value: 3 }]] };
    const buffer = await writeInputFormWorkbook({ sheets: [sheet], fileName: 'x.xlsx' });
    const loaded = new ExcelJS.Workbook();
    await loaded.xlsx.load(buffer as unknown as ArrayBuffer);
    expect(loaded.getWorksheet('S')!.getCell('A1').value).toEqual({ formula: 'SUM(B1)' });
  });
});

// ─── 파일명 ───────────────────────────────────────────────────────────────────

describe('agreementWorkbookFileName', () => {
  it('{과제명}_협약예산_{라벨}_{YYYYMMDD}.xlsx', () => {
    expect(agreementWorkbookFileName('스마트 센서', '최종협약본', '2026-10-02')).toBe(
      '스마트 센서_협약예산_최종협약본_20261002.xlsx'
    );
    expect(agreementWorkbookFileName('A/B: 과제', '최종협약본→협약변경 1차', '2026-10-02T09:00:00Z')).toBe(
      'A_B_ 과제_협약예산_최종협약본→협약변경 1차_20261002.xlsx'
    );
  });

  it('금지 문자만이면 대체어, 날짜 형식이 틀리면 던진다', () => {
    expect(agreementWorkbookFileName('...', '', '2026-10-02')).toBe('과제_협약예산_버전_20261002.xlsx');
    expect(() => agreementWorkbookFileName('P', 'L', '20261002')).toThrow(/YYYY-MM-DD/);
  });
});
