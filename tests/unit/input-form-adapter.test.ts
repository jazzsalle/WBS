// 입력 양식 쓰기 어댑터 (SOT §6.16 IN-2·IN-7·IN-8, §6.11 D-22)
//
// 검증하려는 것은 "어느 값이 어느 칸에 가는가"(그건 생성기 테스트의 몫)가 아니라
// **FormSheet → xlsx 바이트 → 다시 열었을 때** 수식·숨김 시트·숨김 열·숫자가 살아 있는가다.
// 특히 (d)는 올린 양식을 읽는 실제 경로(`lib/import-adapter.readWorkbook`)로 다시 읽어
// 숨김 `_meta` 시트가 RawSheet에 포함되고 값이 그대로인지 본다 — 파서(IN-1)는 이 격자를 믿는다.

import { describe, expect, it } from 'vitest';
import * as XLSX from 'xlsx';
import { writeInputFormWorkbook } from '@/lib/input-form-adapter';
import { readWorkbook } from '@/lib/import-adapter';
import type { FormCell, FormSheet, InputFormWorkbook } from '@/lib/input-form';

// ─── 픽스처: 3시트(인건비·사업비·_meta), 수식 셀·숨김 열·숨김 시트 포함 ─────────

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
  // `!cols`는 cellStyles 없이는 파싱되지 않고, `f`는 cellFormula 없이는 사라진다
  return XLSX.read(buffer, { type: 'buffer', cellFormula: true, cellStyles: true, cellNF: true });
}

function cellOf(wb: XLSX.WorkBook, sheet: string, addr: string): XLSX.CellObject | undefined {
  return wb.Sheets[sheet]?.[addr] as XLSX.CellObject | undefined;
}

const buffer = writeInputFormWorkbook(WORKBOOK);
const reread = readRaw(buffer);

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

  it('(b) 수식 셀은 f가 있고 캐시값 v가 없다 (IN-7)', () => {
    const amount = cellOf(reread, '인건비', 'F2');
    expect(amount?.f).toBe('ROUND(C2*D2/100*E2/12,0)');
    expect(amount?.v).toBeUndefined();

    const budgetAmount = cellOf(reread, '사업비', 'F2');
    expect(budgetAmount?.f).toBe('ROUND(D2*E2,0)');
    expect(budgetAmount?.v).toBeUndefined();
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
    // 끝 열(비고)이 데이터 행에서 비어 있어도 헤더 폭까지 범위에 든다
    expect(reread.Sheets['인건비']?.['!ref']).toBe('A1:G3');
    expect(reread.Sheets['사업비']?.['!ref']).toBe('A1:F3');
    expect(reread.Sheets['_meta']?.['!ref']).toBe('A1:B4');
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

// ─── 생성기 실수를 조용히 넘기지 않는다 ─────────────────────────

describe('writeInputFormWorkbook — 거부', () => {
  function single(rows: FormCell[][]): InputFormWorkbook {
    return { sheets: [{ name: 'x', hidden: false, hiddenColumns: [], rows }], fileName: 'x.xlsx' };
  }

  it("'='로 시작하는 수식은 거부한다 (types.ts 규약: '=' 없이)", () => {
    expect(() => writeInputFormWorkbook(single([[{ formula: '=A1*2' }]]))).toThrow(/'=' 없이/);
  });

  it('NaN·Infinity는 거부한다', () => {
    expect(() => writeInputFormWorkbook(single([[{ value: Number.NaN }]]))).toThrow(/유한한 숫자/);
    expect(() => writeInputFormWorkbook(single([[{ value: Infinity }]]))).toThrow(/유한한 숫자/);
  });

  it('시트가 없거나 이름이 중복되면 거부한다', () => {
    expect(() => writeInputFormWorkbook({ sheets: [], fileName: 'x.xlsx' })).toThrow(/시트가 하나도/);
    expect(() =>
      writeInputFormWorkbook({
        sheets: [
          { name: 'x', hidden: false, hiddenColumns: [], rows: [] },
          { name: 'x', hidden: false, hiddenColumns: [], rows: [] },
        ],
        fileName: 'x.xlsx',
      })
    ).toThrow(/중복/);
  });
});
