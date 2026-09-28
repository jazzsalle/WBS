// 입력 양식 쓰기 어댑터 (SOT §6.16 IN-2·IN-7·IN-8, §6.11 D-22, 부록 F)
//
// 검증하려는 것은 "어느 값이 어느 칸에 가는가"(그건 생성기 테스트의 몫)가 아니라
// **FormSheet → xlsx 바이트 → 다시 열었을 때** 수식·숨김 시트·숨김 열·숫자가 살아 있는가다.
// 특히 (d)는 올린 양식을 읽는 실제 경로(`lib/import-adapter.readWorkbook`)로 다시 읽어
// 숨김 `_meta` 시트가 RawSheet에 포함되고 값이 그대로인지 본다 — 파서(IN-1)는 이 격자를 믿는다.
// 서식(부록 F)은 SheetJS로는 볼 수 없으므로 exceljs로 다시 열어 확인한다 — 힌트 없는 시트에 서식이
// 새어 들지 않는 것까지 본다.

import { describe, expect, it } from 'vitest';
import ExcelJS from 'exceljs';
import * as XLSX from 'xlsx';
import { writeInputFormWorkbook } from '@/lib/input-form-adapter';
import { readWorkbook } from '@/lib/import-adapter';
import type { FormCell, FormSheet, InputFormWorkbook } from '@/lib/input-form';

// ─── 픽스처: 3시트(인건비·사업비·_meta), 수식 셀·숨김 열·숨김 시트 포함 — 서식 힌트 없음 ─────

const s = (value: string): FormCell => ({ value });
const n = (value: number): FormCell => ({ value });
const f = (formula: string): FormCell => ({ formula });
const empty: FormCell = {};

/** 열: A memberId(숨김) · B 성명 · C 연봉 · D 참여율(%) · E 참여개월 · F 금액(수식) · G 비고 */
const PERSONNEL: FormSheet = {
  name: '인건비',
  hidden: false,
  hiddenColumns: [0],
  rows: [
    [s('memberId'), s('성명'), s('연봉'), s('참여율(%)'), s('참여개월'), s('금액'), s('비고')],
    // IN-7: ROUND(연봉×참여율/100×개월/12,0) — 74,000,000×28%×9/12 = 15,540,000 (부록 B.7)
    [s('m-1'), s('홍길동'), n(74_000_000), n(28), n(9), f('ROUND(C2*D2/100*E2/12,0)'), empty],
    // 연봉 없는 인력: 수식 대신 빈 칸 + 비고 (IN-7)
    [s('m-2'), s('김철수'), { value: null }, n(10.5), n(12), empty, s('연봉 미입력')],
  ],
};

/** 열: A subcategory(숨김) · B detailId(숨김) · C 품명 · D 단가 · E 인자1 · F 금액(수식) */
const BUDGET: FormSheet = {
  name: '사업비',
  hidden: false,
  hiddenColumns: [0, 1],
  rows: [
    [s('subcategory'), s('detailId'), s('품명'), s('단가'), s('인자1'), s('금액')],
    [s('material'), s('d-1'), s('시약'), n(150_000), n(2.5), f('ROUND(D2*E2,0)')],
    [s('material'), { value: undefined }, empty, empty, empty, empty],
  ],
};

const META: FormSheet = {
  name: '_meta',
  hidden: true,
  hiddenColumns: [],
  rows: [
    [s('키'), s('값')],
    [s('formVersion'), n(1)],
    [s('projectId'), s('p-1')],
    [s('member:m-1'), s('0')],
  ],
};

const WORKBOOK: InputFormWorkbook = {
  sheets: [PERSONNEL, BUDGET, META],
  fileName: 'test.xlsx',
};

function readRaw(buffer: Buffer): XLSX.WorkBook {
  // `!cols`는 cellStyles 없이는 파싱되지 않고, `f`는 cellFormula 없이는 사라진다.
  // cellStyles는 sheetStubs도 켠다(xlsx.mjs `if(o.cellStyles) { o.cellNF = true; o.sheetStubs = true; }`) —
  // exceljs가 쓴 `<v>` 없는 수식 셀(`<c r="F2"><f>…</f></c>`)은 sheetStubs 없이는 SheetJS가 레코드째 버린다
  // (v=0을 합성한 뒤 'n' 분기에서 `0 == ""`가 참이라 continue). 옛 SheetJS 쓰기는 `t="e"`로 써서 살아남았었다
  return XLSX.read(buffer, { type: 'buffer', cellFormula: true, cellStyles: true, cellNF: true });
}

function cellOf(wb: XLSX.WorkBook, sheet: string, addr: string): XLSX.CellObject | undefined {
  return wb.Sheets[sheet]?.[addr] as XLSX.CellObject | undefined;
}

async function reload(buffer: Buffer): Promise<ExcelJS.Workbook> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buffer as unknown as ArrayBuffer);
  return wb;
}

function fillArgb(cell: ExcelJS.Cell): string | undefined {
  const fill = cell.fill as Partial<ExcelJS.FillPattern> | undefined;
  if (fill === undefined || fill.pattern === undefined || fill.pattern === 'none') return undefined;
  return fill.fgColor?.argb;
}

const buffer = await writeInputFormWorkbook(WORKBOOK);
const reread = readRaw(buffer);
const reloaded = await reload(buffer);

// ─── 왕복 ────────────────────────────────────────────────────

describe('writeInputFormWorkbook — xlsx 왕복', () => {
  it('Buffer를 돌려주고 시트 3장이 순서대로 있다', () => {
    expect(Buffer.isBuffer(buffer)).toBe(true);
    expect(buffer.byteLength).toBeGreaterThan(0);
    expect(reread.SheetNames).toEqual(['인건비', '사업비', '_meta']);
  });

  it('(a) _meta 시트만 Hidden === 1 (IN-2)', () => {
    const props = reread.Workbook?.Sheets ?? [];
    expect(props.map((p) => p.Hidden)).toEqual([0, 0, 1]);
  });

  it('(b) 수식 셀은 f가 있고 캐시값 result가 없다 (IN-7)', () => {
    // SheetJS는 `<v>` 없는 수식 셀을 cellFormula:true로 읽을 때 v=0을 합성한다(xlsx.mjs parse_ws_xml —
    // `if(p.f || p.F) { p.v = 0; ... }`, 결과는 `{t:'z', f, v:0}`). 그래서 "캐시가 없다"는 SheetJS의 v로는
    // 볼 수 없고 exceljs 재로드(`result === undefined`)로 본다
    expect(cellOf(reread, '인건비', 'F2')?.f).toBe('ROUND(C2*D2/100*E2/12,0)');
    expect(cellOf(reread, '사업비', 'F2')?.f).toBe('ROUND(D2*E2,0)');

    const amount = reloaded.getWorksheet('인건비')?.getCell('F2');
    expect(amount?.formula).toBe('ROUND(C2*D2/100*E2/12,0)');
    expect(amount?.result).toBeUndefined();

    const budgetAmount = reloaded.getWorksheet('사업비')?.getCell('F2');
    expect(budgetAmount?.formula).toBe('ROUND(D2*E2,0)');
    expect(budgetAmount?.result).toBeUndefined();
  });

  it('(c) 숨김 열이 !cols에 hidden: true로 남는다', () => {
    const personnelCols = reread.Sheets['인건비']?.['!cols'] ?? [];
    expect(personnelCols[0]?.hidden).toBe(true);
    expect(personnelCols[1]?.hidden).not.toBe(true);

    const budgetCols = reread.Sheets['사업비']?.['!cols'] ?? [];
    expect(budgetCols[0]?.hidden).toBe(true);
    expect(budgetCols[1]?.hidden).toBe(true);
    expect(budgetCols[2]?.hidden).not.toBe(true);
  });

  it('(e) 숫자 셀은 숫자로, 문자열은 문자열로 돌아온다', () => {
    expect(cellOf(reread, '인건비', 'C2')).toMatchObject({ t: 'n', v: 74_000_000 });
    expect(cellOf(reread, '인건비', 'D2')).toMatchObject({ t: 'n', v: 28 });
    expect(cellOf(reread, '인건비', 'D3')).toMatchObject({ t: 'n', v: 10.5 });
    expect(cellOf(reread, '사업비', 'E2')).toMatchObject({ t: 'n', v: 2.5 });
    expect(cellOf(reread, '인건비', 'B2')).toMatchObject({ t: 's', v: '홍길동' });
    expect(cellOf(reread, '_meta', 'B2')).toMatchObject({ t: 'n', v: 1 });
  });

  it('참여율·인자 열은 백분율 서식이 아니다 (D-22 회귀 방지, X-7)', () => {
    // 백분율 서식이면 화면의 28이 2800%로 보이고, 올릴 때 저장값이 0.28이 되어 금액이 1/100로 어긋난다
    for (const addr of ['D2', 'D3', 'E2']) {
      const z = cellOf(reread, '인건비', addr)?.z;
      expect(z ?? 'General', `인건비!${addr}`).not.toMatch(/%/);
    }
    expect(cellOf(reread, '사업비', 'E2')?.z ?? 'General').not.toMatch(/%/);
  });

  it('null·undefined·빈 셀은 셀 레코드를 만들지 않고, !ref는 격자 전체다', () => {
    expect(cellOf(reread, '인건비', 'C3')).toBeUndefined();
    expect(cellOf(reread, '인건비', 'F3')).toBeUndefined();
    expect(cellOf(reread, '사업비', 'B3')).toBeUndefined();
    // 끝 열(비고)이 데이터 행에서 비어 있어도 헤더 폭까지 범위에 든다 — exceljs의 <dimension>은 값이 있는
    // 셀의 경계이고 헤더 행이 전폭이라 SheetJS가 읽는 !ref가 헤더 폭과 같다
    expect(reread.Sheets['인건비']?.['!ref']).toBe('A1:G3');
    expect(reread.Sheets['사업비']?.['!ref']).toBe('A1:F3');
    expect(reread.Sheets['_meta']?.['!ref']).toBe('A1:B4');
  });

  it('힌트 없는 시트에는 채움·숫자 서식이 붙지 않는다 (서식은 힌트가 있을 때만)', () => {
    const personnel = reloaded.getWorksheet('인건비');
    for (const addr of ['A1', 'B1', 'B2', 'C2', 'F2', 'G3']) {
      expect(fillArgb(personnel!.getCell(addr)), `인건비!${addr}`).toBeUndefined();
    }
    expect(personnel!.getCell('C2').numFmt ?? '').toBe('');
    expect(fillArgb(reloaded.getWorksheet('_meta')!.getCell('A1'))).toBeUndefined();
  });
});

// ─── (d) 올리기 경로로 다시 읽기 ─────────────────────────────

describe('readWorkbook(import-adapter)로 다시 읽으면', () => {
  const sheets = readWorkbook(new Uint8Array(buffer));
  const byName = new Map(sheets.map((sheet) => [sheet.name, sheet]));

  it('숨김 _meta 시트가 RawSheet 목록에 포함된다 (IN-2)', () => {
    expect(sheets.map((sheet) => sheet.name)).toEqual(['인건비', '사업비', '_meta']);
    const meta = byName.get('_meta');
    expect(meta?.cells.map((row) => row.map((cell) => cell.value))).toEqual([
      ['키', '값'],
      ['formVersion', 1],
      ['projectId', 'p-1'],
      ['member:m-1', '0'],
    ]);
  });

  it('값이 그대로고 참여율에 percentFormat이 붙지 않는다 (D-22)', () => {
    const personnel = byName.get('인건비');
    const row = personnel?.cells[1] ?? [];
    expect(row[0]?.value).toBe('m-1');
    expect(row[2]?.value).toBe(74_000_000);
    expect(row[3]?.value).toBe(28);
    expect(row[3]?.percentFormat).toBeUndefined();
    expect(row[4]?.value).toBe(9);
    expect(row[6]?.value).toBeNull();
    // 격자 폭 = 헤더 폭. 파서가 고정 좌표로 읽으므로 행마다 폭이 같아야 한다(IN-1)
    expect(personnel?.cells.every((r) => r.length === 7)).toBe(true);
  });

  it('캐시값 없는 수식 셀은 null로 읽힌다 — 앱은 금액 열을 읽지 않는다 (IN-3, I-16)', () => {
    const personnel = byName.get('인건비');
    expect(personnel?.cells[1]?.[5]).toEqual({ value: null, isError: false });
  });
});

// ─── 서식 힌트 → 부록 F ───────────────────────────────────────

describe('서식 힌트가 있는 시트는 부록 F 서식으로 쓴다', () => {
  /** 열: A detailId(숨김) · B 성명(키) · C 품명(입력) · D 금액(수식) */
  const STYLED: FormSheet = {
    name: '사업비',
    hidden: false,
    hiddenColumns: [0],
    kind: 'data',
    headerRow: 1,
    dataStartRow: 2,
    columnHints: [
      { key: false, format: 'text', width: 10, align: 'left' },
      { key: true, format: 'text', width: 26, align: 'left' },
      { key: false, format: 'text', width: 40, align: 'left' },
      { key: false, format: 'formula', width: 14, align: 'right' },
    ],
    rowRoles: ['header', 'data', 'data', 'subtotal', 'total'],
    rows: [
      [s('detailId'), s('성명'), s('품명'), s('금액')],
      [s('d-1'), s('홍길동'), s('노트북'), n(1_500_000)],
      [s('d-2'), s('김철수'), s('모니터'), n(300_000)],
      [empty, s('재료비 소계'), empty, f('SUM(D2:D3)')],
      [empty, s('총액'), empty, f('SUM(D4)')],
    ],
  };
  const GUIDE: FormSheet = {
    name: '작성안내',
    hidden: false,
    hiddenColumns: [],
    kind: 'guide',
    rows: [
      [s('테스트 과제 — 사업비 입력 양식')],
      [s('생성 2026-09-27 · 1차년도 · 제안')],
      [],
      [s('목적'), s('연차 사업비를 엑셀에서 적는다')],
      [s('주의'), s('금액 열은 읽지 않는다')],
    ],
  };

  it('키 열·헤더·소계·안내 제목에 F-2·F-3·F-4·F-8 서식이 붙고 숨김 열·틀 고정이 산다', async () => {
    const out = await writeInputFormWorkbook({ sheets: [GUIDE, STYLED, META], fileName: 'x.xlsx' });
    const wb = await reload(out);
    expect(wb.worksheets.map((ws) => ws.name)).toEqual(['작성안내', '사업비', '_meta']);

    const data = wb.getWorksheet('사업비')!;
    expect(fillArgb(data.getCell('B1'))).toBe('FF1A1A1A');
    expect(data.getCell('B1').font.bold).toBe(true);
    expect(fillArgb(data.getCell('B2'))).toBe('FFF4F1EA');
    expect(fillArgb(data.getCell('C2'))).toBeUndefined();
    expect(data.getCell('D2').numFmt).toBe('#,##0');
    expect(fillArgb(data.getCell('B4'))).toBe('FFF7F7F7');
    expect(data.getCell('D4').formula).toBe('SUM(D2:D3)');
    expect(data.getCell('D4').result).toBeUndefined();
    expect(data.getCell('D4').border.top?.style).toBe('medium');
    expect(data.getColumn(1).hidden).toBe(true);
    expect(data.getColumn(2).width).toBe(26);
    expect(data.views[0]).toMatchObject({ state: 'frozen', ySplit: 1 });

    const guide = wb.getWorksheet('작성안내')!;
    expect(guide.getCell('A1').font.size).toBe(20);
    expect(guide.getCell('A1').font.bold).toBe(true);
    expect(fillArgb(guide.getCell('A4'))).toBe('FFF7F7F7');
    expect(guide.getColumn(2).width).toBe(120);

    // 힌트 없는 _meta는 그대로 서식 없음
    expect(fillArgb(wb.getWorksheet('_meta')!.getCell('A1'))).toBeUndefined();
  });

  it('힌트가 서로 어긋나면 조용히 절반만 입히지 않고 거부한다', async () => {
    await expect(
      writeInputFormWorkbook({ sheets: [{ ...STYLED, rowRoles: ['header'] }], fileName: 'x.xlsx' })
    ).rejects.toThrow(/행 역할 수/);
    await expect(
      writeInputFormWorkbook({ sheets: [{ ...STYLED, columnHints: STYLED.columnHints!.slice(0, 2) }], fileName: 'x.xlsx' })
    ).rejects.toThrow(/열 힌트 수/);
  });
});

// ─── 생성기 실수를 조용히 넘기지 않는다 ─────────────────────────

describe('writeInputFormWorkbook — 거부', () => {
  function single(rows: FormCell[][]): InputFormWorkbook {
    return { sheets: [{ name: 'x', hidden: false, hiddenColumns: [], rows }], fileName: 'x.xlsx' };
  }

  it("'='로 시작하는 수식은 거부한다 (types.ts 규약: '=' 없이)", async () => {
    await expect(writeInputFormWorkbook(single([[{ formula: '=A1*2' }]]))).rejects.toThrow(/'=' 없이/);
  });

  it('NaN·Infinity는 거부한다', async () => {
    await expect(writeInputFormWorkbook(single([[{ value: Number.NaN }]]))).rejects.toThrow(/유한한 숫자/);
    await expect(writeInputFormWorkbook(single([[{ value: Infinity }]]))).rejects.toThrow(/유한한 숫자/);
  });

  it('숨김 열 인덱스가 정수가 아니면 거부한다', async () => {
    await expect(
      writeInputFormWorkbook({ sheets: [{ name: 'x', hidden: false, hiddenColumns: [-1], rows: [] }], fileName: 'x.xlsx' })
    ).rejects.toThrow(/숨김 열 인덱스/);
  });

  it('시트가 없거나 이름이 중복되면 거부한다', async () => {
    await expect(writeInputFormWorkbook({ sheets: [], fileName: 'x.xlsx' })).rejects.toThrow(/시트가 하나도/);
    await expect(
      writeInputFormWorkbook({
        sheets: [
          { name: 'x', hidden: false, hiddenColumns: [], rows: [] },
          { name: 'x', hidden: false, hiddenColumns: [], rows: [] },
        ],
        fileName: 'x.xlsx',
      })
    ).rejects.toThrow(/중복/);
  });
});

// ─── Phase 20: 날짜 셀·드롭다운 거부 (F-6·F-9) ──────────────────────────────────

describe('writeInputFormWorkbook — 날짜·드롭다운 힌트 거부', () => {
  const DATE_SHEET: FormSheet = {
    name: 'x',
    hidden: false,
    hiddenColumns: [],
    headerRow: 1,
    dataStartRow: 2,
    columnHints: [
      { key: false, format: 'date', width: 12, align: 'center' },
      { key: false, format: 'text', width: 10, align: 'center' },
    ],
    rows: [
      [s('집행일'), s('축')],
      [s('2025-04-01'), s('현금')],
    ],
  };
  const withDate = (value: string): InputFormWorkbook => ({
    sheets: [{ ...DATE_SHEET, rows: [DATE_SHEET.rows[0]!, [s(value), s('현금')]] }],
    fileName: 'x.xlsx',
  });
  const withList = (values: string[], column = 1): InputFormWorkbook => ({
    sheets: [{ ...DATE_SHEET, validations: [{ column, values }] }],
    fileName: 'x.xlsx',
  });

  it('형식이 틀리거나 달력에 없는 날짜는 셀 주소와 함께 거부한다', async () => {
    await expect(writeInputFormWorkbook(withDate('2025/04/01'))).rejects.toThrow(/'x'!A2.*yyyy-mm-dd/);
    await expect(writeInputFormWorkbook(withDate('2025-4-1'))).rejects.toThrow(/yyyy-mm-dd/);
    await expect(writeInputFormWorkbook(withDate('2025-04-01T00:00:00Z'))).rejects.toThrow(/yyyy-mm-dd/);
    await expect(writeInputFormWorkbook(withDate('2025-02-30'))).rejects.toThrow(/존재하지 않는 날짜/);
    await expect(writeInputFormWorkbook(withDate('2025-13-01'))).rejects.toThrow(/존재하지 않는 날짜/);
  });

  it('쉼표·큰따옴표가 든 값, 빈 목록·빈 값은 거부한다', async () => {
    await expect(writeInputFormWorkbook(withList(['현금', '현물,기타']))).rejects.toThrow(/쉼표/);
    await expect(writeInputFormWorkbook(withList(['"현금"']))).rejects.toThrow(/큰따옴표/);
    await expect(writeInputFormWorkbook(withList([]))).rejects.toThrow(/비어 있습니다/);
    await expect(writeInputFormWorkbook(withList(['현금', '']))).rejects.toThrow(/빈 값/);
  });

  it('255자 경계: 쉼표 포함 255자는 통과, 256자는 거부한다', async () => {
    // 'a'×127 + ',' + 'b'×127 = 255자
    await expect(writeInputFormWorkbook(withList(['a'.repeat(127), 'b'.repeat(127)]))).resolves.toBeInstanceOf(Buffer);
    await expect(writeInputFormWorkbook(withList(['a'.repeat(128), 'b'.repeat(127)]))).rejects.toThrow(/255자/);
  });

  it('열 인덱스가 범위 밖이거나 같은 열이 두 번이면 거부한다', async () => {
    await expect(writeInputFormWorkbook(withList(['현금'], 2))).rejects.toThrow(/드롭다운 열 인덱스/);
    await expect(writeInputFormWorkbook(withList(['현금'], -1))).rejects.toThrow(/드롭다운 열 인덱스/);
    await expect(
      writeInputFormWorkbook({
        sheets: [
          {
            ...DATE_SHEET,
            validations: [
              { column: 1, values: ['현금'] },
              { column: 1, values: ['현물'] },
            ],
          },
        ],
        fileName: 'x.xlsx',
      })
    ).rejects.toThrow(/중복/);
  });

  it('date 힌트가 없는 열의 날짜 모양 문자열은 문자열로 남는다 — 힌트 없는 경로 불변', async () => {
    const out = await writeInputFormWorkbook({
      sheets: [{ name: 'x', hidden: false, hiddenColumns: [], rows: [[s('집행일')], [s('2025-04-01')]] }],
      fileName: 'x.xlsx',
    });
    const cell = readWorkbook(new Uint8Array(out))[0]?.cells[1]?.[0];
    expect(cell?.value).toBe('2025-04-01');
    const wb = await reload(out);
    expect(wb.getWorksheet('x')?.getCell('A2').dataValidation).toBeFalsy();
  });
});
