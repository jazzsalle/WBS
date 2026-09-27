// 부록 F 스타일 헬퍼 테스트 (SOT 부록 F F-1~F-10, §6.16 IN-8).
//
// 상수는 부록 F 원문과 대조하고, 헬퍼는 **작은 워크북을 만들어 바이트로 쓰고 exceljs로 다시 읽어**
// 검증한다 — 메모리의 셀 객체가 아니라 파일에 실제로 기록된 서식이 기준이다.
// `samples/exel style.xlsx`는 읽지 않는다(값의 원본은 SOT 표).

import { describe, expect, it, beforeAll } from 'vitest';
import ExcelJS from 'exceljs';
import {
  XLSX_STYLE,
  argb,
  createStyledWorkbook,
  finishDataSheet,
  finishGuideSheet,
  numFmtFor,
  styleDataCell,
  styleGuideSheet,
  styleHeaderRow,
  styleSummaryRow,
  type XlsxCellFormat,
} from '@/lib/xlsx-style';

// ─── 픽스처: 안내 + 데이터(헤더 1 · 데이터 2 · 요약 1) + 숨김 시트 ──────────────

const HEADER_ROW = 1;
const DATA_START = 2;
const COLUMN_COUNT = 4; // [숨김 id, 키 열(성명), 입력 열(품명), 숫자 열(금액)]
const SUMMARY_ROW = 4;

async function buildAndReload(): Promise<ExcelJS.Workbook> {
  const wb = createStyledWorkbook();

  const guide = wb.addWorksheet('작성안내');
  guide.getCell('A1').value = '테스트 과제 — 사업비 입력 양식';
  guide.getCell('A2').value = '생성 2026-09-27 · 1차년도 · 제안';
  guide.getCell('A4').value = '목적';
  guide.getCell('B4').value = '연차 사업비를 엑셀에서 적는다';
  guide.getCell('A5').value = '주의';
  guide.getCell('B5').value = '금액 열은 읽지 않는다';
  styleGuideSheet(guide, { titleRow: 1, subtitleRow: 2, tableStartRow: 4, tableRowCount: 2 });
  finishGuideSheet(guide);

  const data = wb.addWorksheet('사업비');
  data.getRow(HEADER_ROW).values = ['detailId', '성명', '품명', '금액'];
  styleHeaderRow(data, HEADER_ROW, COLUMN_COUNT);

  const rows: (string | number)[][] = [
    ['d-1', '홍길동', '노트북', 1500000],
    ['d-2', '김철수', '모니터', 300000],
  ];
  rows.forEach((values, i) => {
    const row = data.getRow(DATA_START + i);
    row.values = values;
    styleDataCell(row.getCell(1), { key: true, format: 'text', align: 'left' });
    styleDataCell(row.getCell(2), { key: true, format: 'text', align: 'left' });
    styleDataCell(row.getCell(3), { key: false, format: 'text', align: 'left' });
    styleDataCell(row.getCell(4), { key: false, format: 'int', align: 'right' });
  });

  const summary = data.getRow(SUMMARY_ROW);
  summary.getCell(2).value = '총액';
  summary.getCell(4).value = { formula: 'SUM(D2:D3)' } as ExcelJS.CellFormulaValue;
  styleSummaryRow(data, SUMMARY_ROW, COLUMN_COUNT, 'total');

  finishDataSheet(data, {
    headerRow: HEADER_ROW,
    dataStartRow: DATA_START,
    columnCount: COLUMN_COUNT,
    hiddenColumns: [1],
    widths: [10, 26, 40, 14],
  });

  const meta = wb.addWorksheet('_meta', { state: 'hidden' });
  meta.getCell('A1').value = 'formVersion';
  meta.getCell('B1').value = 1;

  const buffer = await wb.xlsx.writeBuffer();
  const reloaded = new ExcelJS.Workbook();
  await reloaded.xlsx.load(buffer as ArrayBuffer);
  return reloaded;
}

// ─── 상수 (부록 F 원문) ────────────────────────────────────────────────────────

describe('XLSX_STYLE 상수 — 부록 F', () => {
  it('F-1 글꼴·색', () => {
    expect(XLSX_STYLE.font).toEqual({ name: 'Pretendard', size: 10 });
    expect(XLSX_STYLE.color.text).toBe('1A1A1A');
    expect(XLSX_STYLE.color.muted).toBe('6B6B6B');
  });

  it('F-2·F-3·F-4 채움·테두리', () => {
    expect(XLSX_STYLE.color.headerFill).toBe('1A1A1A');
    expect(XLSX_STYLE.color.headerText).toBe('FFFFFF');
    expect(XLSX_STYLE.color.keyFill).toBe('F4F1EA');
    expect(XLSX_STYLE.color.summaryFill).toBe('F7F7F7');
    expect(XLSX_STYLE.color.border).toBe('DCDCDC');
  });

  it('F-6 숫자 서식, F-8 제목·너비, F-10 탭 색', () => {
    expect(XLSX_STYLE.numFmt.amount).toBe('#,##0');
    expect(XLSX_STYLE.numFmt.date).toBe('yyyy-mm-dd');
    expect(XLSX_STYLE.titleSize).toBe(20);
    expect(XLSX_STYLE.guide.valueColumnWidth).toBe(120);
    expect(XLSX_STYLE.tab).toEqual({ data: '1A1A1A', guide: '1A1A1A' });
  });

  it('argb는 FF 접두', () => {
    expect(argb('1A1A1A')).toBe('FF1A1A1A');
  });
});

describe('numFmtFor — F-6', () => {
  it('금액·수식은 #,##0, 날짜는 yyyy-mm-dd', () => {
    expect(numFmtFor('int')).toBe('#,##0');
    expect(numFmtFor('formula')).toBe('#,##0');
    expect(numFmtFor('date')).toBe('yyyy-mm-dd');
  });

  it('참여율·인자·텍스트는 서식 없음', () => {
    expect(numFmtFor('percent')).toBeUndefined();
    expect(numFmtFor('decimal')).toBeUndefined();
    expect(numFmtFor('text')).toBeUndefined();
  });

  it('어떤 입력에도 백분율 서식을 돌려주지 않는다 (X-7)', () => {
    const all: XlsxCellFormat[] = ['int', 'decimal', 'percent', 'text', 'formula', 'date'];
    for (const format of all) {
      expect(numFmtFor(format) ?? '').not.toContain('%');
    }
  });
});

// ─── 왕복: 쓰고 다시 읽은 서식 ────────────────────────────────────────────────

describe('헬퍼 왕복 — 생성 파일을 exceljs로 다시 읽은 값', () => {
  let wb: ExcelJS.Workbook;
  let data: ExcelJS.Worksheet;
  let guide: ExcelJS.Worksheet;

  beforeAll(async () => {
    wb = await buildAndReload();
    data = wb.getWorksheet('사업비')!;
    guide = wb.getWorksheet('작성안내')!;
  });

  it('F-2 헤더 행: 검정 채움·흰 굵은 Pretendard·아래 medium·세로 가운데 왼쪽 줄바꿈', () => {
    for (let c = 1; c <= COLUMN_COUNT; c += 1) {
      const cell = data.getCell(HEADER_ROW, c);
      const fill = cell.fill as ExcelJS.FillPattern;
      expect(fill.type).toBe('pattern');
      expect(fill.pattern).toBe('solid');
      expect(fill.fgColor?.argb).toBe('FF1A1A1A');
      expect(cell.font.bold).toBe(true);
      expect(cell.font.color?.argb).toBe('FFFFFFFF');
      expect(cell.font.name).toBe('Pretendard');
      expect(cell.font.size).toBe(10);
      expect(cell.border.bottom?.style).toBe('medium');
      expect(cell.border.bottom?.color?.argb).toBe('FFDCDCDC');
      expect(cell.alignment.vertical).toBe('middle');
      expect(cell.alignment.horizontal).toBe('left');
      expect(cell.alignment.wrapText).toBe(true);
    }
  });

  it('F-3 키 열: 베이지 채움 + 보조 색 글자', () => {
    const cell = data.getCell(DATA_START, 2);
    const fill = cell.fill as ExcelJS.FillPattern;
    expect(fill.fgColor?.argb).toBe('FFF4F1EA');
    expect(cell.font.color?.argb).toBe('FF6B6B6B');
    expect(cell.font.name).toBe('Pretendard');
  });

  it('F-3 입력 열: 채움 없음(흰색), 본문 색', () => {
    const cell = data.getCell(DATA_START, 3);
    const fill = cell.fill as Partial<ExcelJS.FillPattern> | undefined;
    expect(fill === undefined || fill.pattern === undefined || fill.pattern === 'none').toBe(true);
    expect(cell.font.color?.argb).toBe('FF1A1A1A');
  });

  it('F-4 데이터 셀 4변 thin #DCDCDC', () => {
    for (let r = DATA_START; r < SUMMARY_ROW; r += 1) {
      for (let c = 1; c <= COLUMN_COUNT; c += 1) {
        const border = data.getCell(r, c).border;
        for (const side of ['top', 'left', 'bottom', 'right'] as const) {
          expect(border[side]?.style, `${r},${c} ${side}`).toBe('thin');
          expect(border[side]?.color?.argb, `${r},${c} ${side}`).toBe('FFDCDCDC');
        }
      }
    }
  });

  it('F-5·F-6 정렬과 숫자 서식: 텍스트 왼쪽·위·줄바꿈, 금액 오른쪽 #,##0, 텍스트는 서식 없음', () => {
    const text = data.getCell(DATA_START, 3);
    expect(text.alignment.horizontal).toBe('left');
    expect(text.alignment.vertical).toBe('top');
    expect(text.alignment.wrapText).toBe(true);
    expect(text.numFmt ?? '').not.toContain('%');

    const amount = data.getCell(DATA_START, 4);
    expect(amount.alignment.horizontal).toBe('right');
    expect(amount.numFmt).toBe('#,##0');
    expect(amount.value).toBe(1500000);
  });

  it('F-4 요약 행: 회색 채움·굵게·위 medium, 수식 셀 #,##0', () => {
    for (let c = 1; c <= COLUMN_COUNT; c += 1) {
      const cell = data.getCell(SUMMARY_ROW, c);
      expect((cell.fill as ExcelJS.FillPattern).fgColor?.argb).toBe('FFF7F7F7');
      expect(cell.font.bold).toBe(true);
      expect(cell.border.top?.style).toBe('medium');
    }
    const total = data.getCell(SUMMARY_ROW, 4);
    expect(total.formula).toBe('SUM(D2:D3)');
    expect(total.numFmt).toBe('#,##0');
  });

  it('F-5 틀 고정: 첫 데이터 행 위, 헤더 행 자동 필터', () => {
    const view = data.views[0] as ExcelJS.WorksheetViewFrozen;
    expect(view.state).toBe('frozen');
    expect(view.ySplit).toBe(DATA_START - 1);
    expect(data.autoFilter).toBe('A1:D1');
  });

  it('F-3 숨김 열, F-7 너비', () => {
    expect(data.getColumn(1).hidden).toBe(true);
    expect(data.getColumn(2).hidden).toBeFalsy();
    expect(data.getColumn(2).width).toBe(26);
    expect(data.getColumn(3).width).toBe(40);
    expect(data.getColumn(4).width).toBe(14);
  });

  it('F-1 열 기본 글꼴: 값이 없는 열의 빈 셀도 Pretendard 10', () => {
    for (let c = 1; c <= COLUMN_COUNT; c += 1) {
      expect(data.getColumn(c).style.font?.name, `col ${c}`).toBe('Pretendard');
      expect(data.getColumn(c).style.font?.size, `col ${c}`).toBe(10);
    }
    // 아직 아무도 안 쓴 셀 — 열 스타일을 상속해야 한다
    const blank = data.getCell(SUMMARY_ROW + 5, 3);
    expect(blank.font.name).toBe('Pretendard');
  });

  it('F-10 인쇄: 가로·너비 1페이지·헤더 행 반복, 탭 색', () => {
    expect(data.pageSetup.orientation).toBe('landscape');
    expect(data.pageSetup.fitToPage).toBe(true);
    expect(data.pageSetup.fitToWidth).toBe(1);
    expect(data.pageSetup.printTitlesRow).toBe('1:1');
    expect(data.properties.tabColor?.argb).toBe('FF1A1A1A');
    expect(guide.properties.tabColor?.argb).toBe('FF1A1A1A');
  });

  it('IN-2 숨김 시트는 hidden 상태로 남는다', () => {
    expect(wb.getWorksheet('_meta')?.state).toBe('hidden');
    expect(guide.state).toBe('visible');
  });

  it('F-8 작성안내: A1 20pt 굵게, A2 보조 색, 라벨 열 F7F7F7 굵게, 값 열 너비 120·줄바꿈', () => {
    const title = guide.getCell('A1');
    expect(title.font.size).toBe(20);
    expect(title.font.bold).toBe(true);
    expect(title.font.name).toBe('Pretendard');

    const subtitle = guide.getCell('A2');
    expect(subtitle.font.color?.argb).toBe('FF6B6B6B');

    for (const r of [4, 5]) {
      const label = guide.getCell(r, 1);
      expect((label.fill as ExcelJS.FillPattern).fgColor?.argb).toBe('FFF7F7F7');
      expect(label.font.bold).toBe(true);
      const value = guide.getCell(r, 2);
      expect(value.alignment.wrapText).toBe(true);
    }
    expect(guide.getColumn(1).width).toBe(16);
    expect(guide.getColumn(2).width).toBe(120);
    expect(guide.getColumn(2).style.font?.name).toBe('Pretendard');
  });
});
