// 엑셀 날짜 셀 읽기 (부록 F-6, §6.17 GF-6) — 양식 파서들이 같은 규칙으로 날짜를 읽는다.

import { describe, expect, it } from 'vitest';
import type { RawCell } from '@/lib/import/types';
import { excelSerialToISO, readSheetDate } from '@/lib/input-form/sheet-date';

function cell(value: RawCell['value']): RawCell {
  return { value, isError: false };
}

describe('excelSerialToISO — 1900 날짜 체계', () => {
  it.each([
    [1, '1900-01-01'],
    [59, '1900-02-28'],
    [61, '1900-03-01'],
    [45292, '2024-01-01'],
    [45658, '2025-01-01'],
    [46023, '2026-01-01'],
    [46086, '2026-03-05'],
    [46112, '2026-03-31'],
    [46113, '2026-04-01'],
    [2_958_465, '9999-12-31'],
  ])('%d → %s', (serial, iso) => {
    expect(excelSerialToISO(serial)).toBe(iso);
  });

  it.each([
    [60, '엑셀이 넣은 없는 날 1900-02-29'],
    [0, '0일'],
    [-1, '음수'],
    [45658.5, '시각이 섞인 값'],
    [2_958_466, '9999년 이후'],
    [Number.NaN, 'NaN'],
    [Number.POSITIVE_INFINITY, '무한대'],
  ])('%d는 날짜가 아니다 (%s)', (serial) => {
    expect(excelSerialToISO(serial)).toBeNull();
  });
});

describe('readSheetDate', () => {
  it('직렬값 숫자 → ISO', () => {
    expect(readSheetDate(cell(46086))).toEqual({ kind: 'value', iso: '2026-03-05' });
  });

  it('yyyy-mm-dd 문자열 → 같은 ISO (앞뒤 공백은 무시)', () => {
    expect(readSheetDate(cell('2026-03-05'))).toEqual({ kind: 'value', iso: '2026-03-05' });
    expect(readSheetDate(cell('  2026-03-05 '))).toEqual({ kind: 'value', iso: '2026-03-05' });
  });

  it('윤년 2월 29일은 받고, 평년 2월 29일은 invalid', () => {
    expect(readSheetDate(cell('2028-02-29'))).toEqual({ kind: 'value', iso: '2028-02-29' });
    expect(readSheetDate(cell('2026-02-29'))).toEqual({ kind: 'invalid', text: '2026-02-29' });
  });

  it.each([null, '', '   '])('빈 셀(%j)은 empty', (value) => {
    expect(readSheetDate(cell(value))).toEqual({ kind: 'empty' });
  });

  it.each([
    ['2026-02-30', '달력에 없는 날'],
    ['2026-13-01', '없는 달'],
    ['2026/03/05', '다른 구분자'],
    ['26-03-05', '두 자리 연도'],
    ['2026-3-5', '한 자리 월·일'],
    ['3월 5일', '한글 표기'],
    ['46086', '숫자 문자열'],
  ])('%s는 invalid (%s) — 원문을 그대로 돌려준다', (text) => {
    expect(readSheetDate(cell(text))).toEqual({ kind: 'invalid', text });
  });

  it('날짜가 아닌 직렬값(소수·60)은 invalid', () => {
    expect(readSheetDate(cell(46086.25)).kind).toBe('invalid');
    expect(readSheetDate(cell(60)).kind).toBe('invalid');
  });

  it('엑셀 오류 셀은 invalid', () => {
    expect(readSheetDate({ value: '#REF!', isError: true, errorText: '#REF!' }).kind).toBe('invalid');
  });

  it('불리언 셀은 날짜가 아니다', () => {
    expect(readSheetDate(cell(true)).kind).toBe('invalid');
  });
});
