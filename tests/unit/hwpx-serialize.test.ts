// hwpx 격자 직렬화·페이로드 상한 테스트 (SOT §6.18 HX-1·HX-8, §9 Plan Document, S-13·S-14)
// 직렬화가 흔들리면 같은 격자가 commit에서 해시 불일치로 거부된다. 상한은 경계에서 한 칸씩 확인한다.

import { describe, expect, it } from 'vitest';
import { serializePlanTables } from '@/lib/hwpx/serialize';
import {
  PLAN_CELL_MAX_CHARS,
  PLAN_PAYLOAD_MAX_BYTES,
  PLAN_PAYLOAD_MAX_TABLES,
  PLAN_TABLE_MAX_COLS,
  PLAN_TABLE_MAX_ROWS,
  checkPlanPayload,
  utf8ByteLength,
} from '@/lib/hwpx/limits';
import type { HwpxTable, PlanDocumentPayload } from '@/lib/hwpx/types';
import { PLAN_DOCUMENT_SHEET_NAME } from '@/lib/hwpx/types';

function table(rowCnt: number, colCnt: number, fill = '', index = 0): HwpxTable {
  return {
    index,
    section: 0,
    rowCnt,
    colCnt,
    cells: Array.from({ length: rowCnt }, () => Array.from({ length: colCnt }, () => fill)),
  };
}

function payload(tables: HwpxTable[], fileName = '계획서.hwpx'): PlanDocumentPayload {
  return { fileName, tables };
}

describe('serializePlanTables (S-13)', () => {
  const t: HwpxTable = { index: 3, section: 1, rowCnt: 2, colCnt: 2, cells: [['평가항목', '단위'], ['1. 효율', '%']] };

  it('입력 객체 키 순서가 달라도 같은 문자열이다', () => {
    const shuffled = { cells: t.cells, colCnt: 2, rowCnt: 2, section: 1, index: 3 } as HwpxTable;
    expect(serializePlanTables({ tables: [shuffled] })).toBe(serializePlanTables({ tables: [t] }));
  });

  it('fileName은 해시 대상이 아니다', () => {
    expect(serializePlanTables(payload([t], 'a.hwpx'))).toBe(serializePlanTables(payload([t], 'b.hwpx')));
  });

  it('여분 키는 직렬화에 들어가지 않는다', () => {
    const extra = { ...t, caption: 'x' } as HwpxTable;
    expect(serializePlanTables({ tables: [extra] })).toBe(serializePlanTables({ tables: [t] }));
  });

  it('표·셀 순서와 값은 그대로 반영된다', () => {
    const a = table(1, 1, 'a', 0);
    const b = table(1, 1, 'b', 1);
    expect(serializePlanTables({ tables: [a, b] })).not.toBe(serializePlanTables({ tables: [b, a] }));
    const changed = { ...t, cells: [['평가항목', '단위'], ['1. 효율', '％']] };
    expect(serializePlanTables({ tables: [changed] })).not.toBe(serializePlanTables({ tables: [t] }));
  });

  it('정해진 키 순서로 나온다', () => {
    expect(serializePlanTables({ tables: [table(1, 1, 'x', 5)] })).toBe(
      '[{"index":5,"section":0,"rowCnt":1,"colCnt":1,"cells":[["x"]]}]',
    );
  });

  it('입력을 바꾸지 않는다', () => {
    const before = JSON.stringify(t);
    serializePlanTables({ tables: [t] });
    expect(JSON.stringify(t)).toBe(before);
  });
});

describe('utf8ByteLength', () => {
  it('ASCII 1·한글 3·서로게이트 쌍 4바이트', () => {
    expect(utf8ByteLength('a')).toBe(1);
    expect(utf8ByteLength('é')).toBe(2);
    expect(utf8ByteLength('가')).toBe(3);
    expect(utf8ByteLength('😀')).toBe(4);
    expect(utf8ByteLength('\ud800')).toBe(3);
  });

  it('TextEncoder와 같다', () => {
    const s = 'a가é😀\n"\ 평가방법';
    expect(utf8ByteLength(s)).toBe(new TextEncoder().encode(s).length);
  });
});

describe('checkPlanPayload (S-14)', () => {
  it('빈 표 목록은 통과한다', () => {
    expect(checkPlanPayload(payload([]))).toEqual({ ok: true });
  });

  it(`표 수: ${PLAN_PAYLOAD_MAX_TABLES}개 OK, +1 실패`, () => {
    const at = Array.from({ length: PLAN_PAYLOAD_MAX_TABLES }, (_, i) => table(1, 1, '', i));
    expect(checkPlanPayload(payload(at))).toEqual({ ok: true });
    const over = checkPlanPayload(payload([...at, table(1, 1, '', PLAN_PAYLOAD_MAX_TABLES)]));
    expect(over.ok).toBe(false);
    if (!over.ok) expect(over.reason).toContain('표만 추출해도 너무 큽니다');
  });

  it(`행 수: ${PLAN_TABLE_MAX_ROWS}행 OK, +1 실패`, () => {
    expect(checkPlanPayload(payload([table(PLAN_TABLE_MAX_ROWS, 1)]))).toEqual({ ok: true });
    const over = checkPlanPayload(payload([table(PLAN_TABLE_MAX_ROWS + 1, 1)]));
    expect(over.ok).toBe(false);
    if (!over.ok) expect(over.reason).toContain('표만 추출해도 너무 큽니다');
  });

  it(`열 수: ${PLAN_TABLE_MAX_COLS}열 OK, +1 실패`, () => {
    expect(checkPlanPayload(payload([table(1, PLAN_TABLE_MAX_COLS)]))).toEqual({ ok: true });
    const over = checkPlanPayload(payload([table(1, PLAN_TABLE_MAX_COLS + 1)]));
    expect(over.ok).toBe(false);
    if (!over.ok) expect(over.reason).toContain('표만 추출해도 너무 큽니다');
  });

  it(`셀 길이: ${PLAN_CELL_MAX_CHARS}자 OK, +1 실패`, () => {
    expect(checkPlanPayload(payload([table(1, 1, '가'.repeat(PLAN_CELL_MAX_CHARS))]))).toEqual({ ok: true });
    const over = checkPlanPayload(payload([table(1, 1, '가'.repeat(PLAN_CELL_MAX_CHARS + 1))]));
    expect(over.ok).toBe(false);
    if (!over.ok) expect(over.reason).toContain('표만 추출해도 너무 큽니다');
  });

  it(`직렬화 크기: 정확히 ${PLAN_PAYLOAD_MAX_BYTES}B OK, +1 실패`, () => {
    // 셀 상한(20,000자)에 걸리지 않게 여러 셀로 나눠 채우고 마지막 셀로 정확히 맞춘다
    const rows = 50;
    const cols = 1;
    const base = table(rows, cols, 'a'.repeat(16_000));
    const baseBytes = utf8ByteLength(serializePlanTables({ tables: [base] }));
    const diff = PLAN_PAYLOAD_MAX_BYTES - baseBytes;
    const lastLen = 16_000 + diff;
    expect(lastLen).toBeGreaterThanOrEqual(0);
    expect(lastLen).toBeLessThanOrEqual(PLAN_CELL_MAX_CHARS);

    const exact = table(rows, cols, 'a'.repeat(16_000));
    exact.cells[rows - 1]![0] = 'a'.repeat(lastLen);
    expect(utf8ByteLength(serializePlanTables({ tables: [exact] }))).toBe(PLAN_PAYLOAD_MAX_BYTES);
    expect(checkPlanPayload(payload([exact]))).toEqual({ ok: true });

    const over = table(rows, cols, 'a'.repeat(16_000));
    over.cells[rows - 1]![0] = 'a'.repeat(lastLen + 1);
    const result = checkPlanPayload(payload([over]));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain('표만 추출해도 너무 큽니다');
  });

  it('직렬화 크기는 UTF-8 바이트로 잰다(한글 3바이트)', () => {
    // 한글 18,000자 × 15셀 = 270,000자 → 810,000B 이상이라 글자 수로는 통과해도 바이트로는 넘는다
    const result = checkPlanPayload(payload([table(15, 1, '가'.repeat(18_000))]));
    expect(result.ok).toBe(false);
  });

  it('cells 행 수가 rowCnt와 다르면 실패', () => {
    const t = table(2, 2);
    t.cells.pop();
    const result = checkPlanPayload(payload([t]));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain('맞지 않습니다');
  });

  it('어느 행의 열 수가 colCnt와 다르면 실패', () => {
    const t = table(2, 2);
    t.cells[1]!.push('');
    expect(checkPlanPayload(payload([t])).ok).toBe(false);
    const u = table(2, 2);
    u.cells[0]!.pop();
    expect(checkPlanPayload(payload([u])).ok).toBe(false);
  });

  it('rowCnt·colCnt가 음수·비정수면 실패', () => {
    expect(checkPlanPayload(payload([{ ...table(0, 0), rowCnt: -1 }])).ok).toBe(false);
    expect(checkPlanPayload(payload([{ ...table(1, 1), colCnt: 1.5 }])).ok).toBe(false);
  });

  it('던지지 않는다', () => {
    expect(() => checkPlanPayload(payload([table(PLAN_TABLE_MAX_ROWS + 1, PLAN_TABLE_MAX_COLS + 1)]))).not.toThrow();
  });
});

describe('PLAN_DOCUMENT_SHEET_NAME (U-11)', () => {
  it('스냅샷 sheetName 값', () => {
    expect(PLAN_DOCUMENT_SHEET_NAME).toBe('계획서(hwpx)');
  });
});
