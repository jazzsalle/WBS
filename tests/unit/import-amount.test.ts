// 금액 파싱 (SOT §6.8.4 I-8~I-12, I-16)
// CLAUDE.md 절대 규칙 4·5: 결과는 원 단위 정수이고, 파싱 실패는 0으로 삼키지 않고 오류로 드러낸다.

import { describe, expect, it } from 'vitest';
import {
  DEFAULT_AMOUNT_UNIT,
  detectAmountUnit,
  parseAmountCell,
  parseAmountText,
} from '@/lib/import/amount';
import type { RawCell, RawSheet } from '@/lib/import/types';

const cell = (value: RawCell['value']): RawCell => ({ value, isError: false });
const errorCell = (text: string): RawCell => ({ value: null, isError: true, errorText: text });

function sheetOf(rows: (string | number | null)[][]): RawSheet {
  return {
    name: 'S',
    cells: rows.map((row) => row.map((value) => cell(value))),
    merges: [],
  };
}

describe('parseAmountCell — I-12 빈 셀·`-`·`0`', () => {
  it('빈 셀은 0이다', () => {
    expect(parseAmountCell(cell(null), 1)).toMatchObject({ ok: true, amount: 0 });
    expect(parseAmountCell(undefined, 1)).toMatchObject({ ok: true, amount: 0 });
    expect(parseAmountCell(cell(''), 1)).toMatchObject({ ok: true, amount: 0 });
  });

  it('`-` 표기는 0이다 (회계 서식의 빈 값)', () => {
    for (const dash of ['-', '‐', '–', '—', '−']) {
      expect(parseAmountCell(cell(dash), 1)).toMatchObject({ ok: true, amount: 0 });
    }
  });

  it('숫자 0은 0이다', () => {
    expect(parseAmountCell(cell(0), 1)).toMatchObject({ ok: true, amount: 0 });
    expect(parseAmountCell(cell('0'), 1)).toMatchObject({ ok: true, amount: 0 });
  });
});

describe('parseAmountCell — I-12 오류 셀', () => {
  it('isError 셀은 반영을 막는다 (0으로 삼키지 않는다)', () => {
    const result = parseAmountCell(errorCell('#REF!'), 1);
    expect(result.ok).toBe(false);
    expect(result.amount).toBeNull();
    expect(result.error?.reason).toBe('formula-error');
    expect(result.error?.text).toBe('#REF!');
  });

  it('isError 플래그가 없어도 에러 문자열이면 걸러낸다', () => {
    for (const text of ['#REF!', '#DIV/0!', '#VALUE!', '#N/A', '#NAME?', '#NUM!']) {
      const result = parseAmountCell(cell(text), 1);
      expect(result.ok).toBe(false);
      expect(result.error?.reason).toBe('formula-error');
    }
  });

  it('숫자로 읽을 수 없는 텍스트는 오류다', () => {
    const result = parseAmountCell(cell('미정'), 1);
    expect(result.ok).toBe(false);
    expect(result.error?.reason).toBe('unparsable');
  });

  it('참/거짓 값은 금액이 아니다', () => {
    expect(parseAmountCell(cell(true), 1).ok).toBe(false);
  });
});

describe('parseAmountText — I-8 정리 / I-9 괄호 음수', () => {
  it('I-8: 천단위 콤마·통화 기호·공백을 제거한다', () => {
    expect(parseAmountText('50,000,000', 1).amount).toBe(50_000_000);
    expect(parseAmountText(' 1,234 ', 1).amount).toBe(1234);
    expect(parseAmountText('₩1,234', 1).amount).toBe(1234);
  });

  it('I-8: `원`/`천원`/`백만원` 접미사는 떼기만 한다 (배수는 amountUnit이 정한다)', () => {
    expect(parseAmountText('1,234원', 1).amount).toBe(1234);
    expect(parseAmountText('1,234천원', 1).amount).toBe(1234);
    expect(parseAmountText('1,234천원', 1000).amount).toBe(1_234_000);
  });

  it('I-9: 괄호 표기는 음수다', () => {
    expect(parseAmountText('(1,234)', 1).amount).toBe(-1234);
    expect(parseAmountText('(1,234)', 1000).amount).toBe(-1_234_000);
  });

  it('부호는 그대로 읽는다', () => {
    expect(parseAmountText('-1234', 1).amount).toBe(-1234);
    expect(parseAmountText('+1234', 1).amount).toBe(1234);
    // 괄호 안의 음수는 두 번 뒤집혀 양수
    expect(parseAmountText('(-1234)', 1).amount).toBe(1234);
  });
});

describe('parseAmountCell — I-11 원 단위 정수', () => {
  it('배수를 곱해 원 단위로 확정한다', () => {
    expect(parseAmountCell(cell(1234), 1000).amount).toBe(1_234_000);
    expect(parseAmountCell(cell(12), 1_000_000).amount).toBe(12_000_000);
  });

  it('소수는 반올림하고 그 사실을 결과에 남긴다', () => {
    const result = parseAmountCell(cell(1234.5), 1);
    expect(result.amount).toBe(1235);
    expect(result.rounded).toBe(true);
    expect(Number.isInteger(result.amount)).toBe(true);
  });

  it('정수 × 배수는 반올림이 아니다', () => {
    expect(parseAmountCell(cell(1234), 1000).rounded).toBe(false);
  });

  it('소수 × 배수가 정수가 되면 반올림이 아니다', () => {
    const result = parseAmountCell(cell(1.5), 1000);
    expect(result.amount).toBe(1500);
    expect(result.rounded).toBe(false);
  });

  it('정수 안전 범위를 벗어나면 잘라내지 않고 오류로 만든다', () => {
    const result = parseAmountCell(cell(Number.MAX_SAFE_INTEGER), 1000);
    expect(result.ok).toBe(false);
    expect(result.error?.reason).toBe('out-of-range');
  });
});

describe('detectAmountUnit — I-10', () => {
  it('`(단위 : 원)`처럼 콜론 주변 공백 변형을 받는다', () => {
    const hint = detectAmountUnit(sheetOf([[null, '(단위 : 원)'], ['비목']]));
    expect(hint).toMatchObject({ unit: 1, row: 0, column: 1 });
  });

  it('`(단위: 천원)` → 1000', () => {
    expect(detectAmountUnit(sheetOf([['(단위: 천원)']]))?.unit).toBe(1000);
  });

  it('`(단위:백만원)` → 1000000', () => {
    expect(detectAmountUnit(sheetOf([['(단위:백만원)']]))?.unit).toBe(1_000_000);
  });

  it('시트 어디에 있든 찾는다', () => {
    const hint = detectAmountUnit(
      sheetOf([['a'], ['b'], [null, null, null, '사업비 총괄표 (단위 : 천원)']])
    );
    expect(hint?.unit).toBe(1000);
    expect(hint?.row).toBe(2);
  });

  it('표기가 없으면 null — 자동 확정하지 않고 기본 ×1을 제시한다', () => {
    expect(detectAmountUnit(sheetOf([['비목', '1차년도']]))).toBeNull();
    expect(DEFAULT_AMOUNT_UNIT).toBe(1);
  });

  it('알 수 없는 단위 표기는 후보로 삼지 않는다', () => {
    expect(detectAmountUnit(sheetOf([['(단위: 달러)']]))).toBeNull();
  });
});
