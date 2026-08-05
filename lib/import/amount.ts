// 금액 파싱 (SOT §6.8.4 I-8~I-12, I-16).
// 부수효과 없는 순수 함수다. 단위 테스트: tests/unit/import-amount.test.ts
//
// CLAUDE.md 절대 규칙 4: 저장은 원 단위 정수다. 여기서 배수(amountUnit)를 곱해 정수로 확정하고,
// 소수가 나오면 반올림한 사실(`rounded`)을 결과에 남겨 미리보기에 드러낸다 (I-11).

import { cellText } from './grid';
import type {
  AmountError,
  AmountParseResult,
  AmountUnit,
  AmountUnitHint,
  RawCell,
  RawSheet,
} from './types';

// I-12: 수식 에러 문자열. isError 플래그가 없는 어댑터/CSV 경로에서도 텍스트로 걸러낸다
const EXCEL_ERROR = /^#(?:REF!|DIV\/0!|VALUE!|N\/A|NAME\?|NUM!|NULL!|SPILL!|CALC!|FIELD!|BLOCKED!|CONNECT!|UNKNOWN!|BUSY!|GETTING_DATA)$/i;

// I-12: 빈 셀·`-`·`0`은 0. 대시 변형과 회계 서식의 빈 표기를 함께 받는다
const DASH_ONLY = /^[-‐-―−~〜～.]+$/;

// I-8: 천단위 콤마·통화 기호·단위 접미사 제거
const CURRENCY_SYMBOLS = /[₩¥$￦￥,\s]/g;
const UNIT_SUFFIX = /(백만원|십억원|억원|만원|천원|원)$/;

function fail(reason: AmountError['reason'], text: string, message: string): AmountParseResult {
  return { ok: false, amount: null, rounded: false, error: { reason, text, message }, rawText: text };
}

function toInteger(value: number, unit: AmountUnit, text: string): AmountParseResult {
  if (!Number.isFinite(value)) {
    return fail('unparsable', text, `숫자로 읽을 수 없습니다: ${text}`);
  }
  // 정수 × 배수는 오차가 없다. 소수일 때만 곱셈 후 반올림한다 (I-11)
  const scaled = value * unit;
  const rounded = !Number.isInteger(scaled);
  const amount = rounded ? Math.round(scaled) : scaled;
  if (!Number.isSafeInteger(amount)) {
    return fail('out-of-range', text, `금액이 정수 안전 범위를 벗어납니다: ${text}`);
  }
  return { ok: true, amount, rounded, error: null, rawText: text };
}

/**
 * 셀 하나의 금액 파싱.
 * - I-12: 에러 셀·파싱 불가 텍스트는 `ok: false`. 호출자가 반영을 막는다 (조용히 0으로 삼키지 않는다)
 * - I-9: `(1,234)`는 음수 (회계 관행)
 * - I-11: 결과는 원 단위 정수
 */
export function parseAmountCell(cell: RawCell | undefined, unit: AmountUnit): AmountParseResult {
  const text = cellText(cell);

  if (cell?.isError) {
    return fail('formula-error', text || '#ERROR', `수식 에러 셀입니다: ${text || '#ERROR'}`);
  }

  const value = cell?.value ?? null;
  if (value === null) return { ok: true, amount: 0, rounded: false, error: null, rawText: '' };

  if (typeof value === 'boolean') {
    return fail('unparsable', text, `금액 자리에 참/거짓 값이 있습니다: ${text}`);
  }

  if (typeof value === 'number') return toInteger(value, unit, text);

  return parseAmountText(text, unit);
}

/** 문자열 금액 파싱 (I-8·I-9·I-12). CSV 경로와 셀 파싱이 같은 규칙을 쓰게 분리해 둔다 */
export function parseAmountText(input: string, unit: AmountUnit): AmountParseResult {
  const text = input.trim();
  if (text === '') return { ok: true, amount: 0, rounded: false, error: null, rawText: input };
  if (EXCEL_ERROR.test(text)) {
    return fail('formula-error', text, `수식 에러 셀입니다: ${text}`);
  }
  if (DASH_ONLY.test(text)) {
    return { ok: true, amount: 0, rounded: false, error: null, rawText: input };
  }

  let body = text.normalize('NFKC');
  let negative = false;

  // I-9: 괄호 표기는 음수
  const paren = body.match(/^\(\s*(.*?)\s*\)$/);
  if (paren) {
    negative = true;
    body = paren[1] ?? '';
  }

  body = body.replace(CURRENCY_SYMBOLS, '');
  body = body.replace(UNIT_SUFFIX, '');

  if (body.startsWith('-') || body.startsWith('−')) {
    negative = !negative;
    body = body.slice(1);
  } else if (body.startsWith('+')) {
    body = body.slice(1);
  }

  if (body === '' || !/^\d*\.?\d+$/.test(body)) {
    return fail('unparsable', text, `숫자로 읽을 수 없습니다: ${text}`);
  }

  const parsed = Number(body);
  const result = toInteger(negative ? -parsed : parsed, unit, text);
  return { ...result, rawText: input };
}

// ─── I-10 금액 단위 추정 ─────────────────────────────────────

const UNIT_BY_WORD: Record<string, AmountUnit> = {
  '원': 1,
  '천원': 1000,
  '백만원': 1000000,
};

// `(단위: 천원)`, `(단위 : 원)`처럼 콜론 주변 공백 변형이 실측에 있다
const UNIT_PATTERN = /단위\s*[:：]?\s*([가-힣]*원)/;

/**
 * I-10: 시트 어디서든 `단위` 표기를 찾아 **후보로만** 제시한다.
 * 1000배 오류는 치명적이므로 자동 확정하지 않는다 — 못 찾으면 null이고, 호출자가 ×1을 기본 제시한다.
 */
export function detectAmountUnit(sheet: RawSheet): AmountUnitHint | null {
  for (let r = 0; r < sheet.cells.length; r += 1) {
    const row = sheet.cells[r];
    if (!row) continue;
    for (let c = 0; c < row.length; c += 1) {
      const text = cellText(row[c]);
      if (text === '' || !text.includes('단위')) continue;
      const match = UNIT_PATTERN.exec(text.replace(/　/g, ' '));
      const word = match?.[1];
      if (!word) continue;
      const unit = UNIT_BY_WORD[word];
      if (!unit) continue;
      return { unit, text, row: r, column: c };
    }
  }
  return null;
}

/** I-10 기본값 — 표기를 못 찾았을 때 ×1을 제시한다 (자동 확정이 아니라 제시다) */
export const DEFAULT_AMOUNT_UNIT: AmountUnit = 1;
