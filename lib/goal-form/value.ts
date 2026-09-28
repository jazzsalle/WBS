// SOT §6.17 GF-6 숫자 해석 (양식·hwpx 공통). 키워드·없음 기호의 원본은 부록 C.3.4(lib/constants.ts).
// 부호·범위 판정은 이 함수가 하고, 음수 허용 여부(가중치·비중 ≥ 0)·정수 여부는 열을 아는 파서가 판정한다.

import { GOAL_VALUE_HINT_KEYWORDS, GOAL_VALUE_NONE_SYMBOLS } from '@/lib/constants';
import type { Direction } from '@/types';

export type GoalValueHint = Exclude<Direction, 'target_exact'>;

export type GoalValueWarning = 'unparsed-text' | 'no-number';

export interface ParsedGoalValue {
  value: number | null;
  hint: GoalValueHint | null;
  // 경고가 있을 때만 채운다 — 비고의 `[원문] …` 줄 재료(appendOriginalNote)
  original: string | null;
  warning: GoalValueWarning | null;
}

const EMPTY: ParsedGoalValue = { value: null, hint: null, original: null, warning: null };

const PLAIN_NUMBER = /^-?\d+(?:\.\d+)?$/;
// 천 단위 쉼표만 지운다 — `1,2`처럼 목록일 수 있는 쉼표까지 지우면 12로 붙어 조용히 틀린 값이 된다
const THOUSANDS_COMMA = /(?<=\d),(?=\d{3}(?:\D|$))/g;
const FIRST_NUMBER = /-?\d+(?:\.\d+)?/;

export function parseGoalValue(
  raw: string | number | null | undefined,
  unit: string,
): ParsedGoalValue {
  if (raw === null || raw === undefined) return EMPTY;

  // 엑셀 숫자형 셀은 사용자가 이미 숫자로 넣은 값 — 문자열 해석(힌트·단위)을 하지 않는다
  if (typeof raw === 'number') {
    if (Number.isFinite(raw)) return { value: raw, hint: null, original: null, warning: null };
    return { value: null, hint: null, original: String(raw), warning: 'no-number' };
  }

  const trimmed = raw.trim();
  if (trimmed === '' || GOAL_VALUE_NONE_SYMBOLS.includes(trimmed)) return EMPTY;

  const { hint, conflict, rest } = extractHint(trimmed);
  const core = rest.replace(THOUSANDS_COMMA, '');

  const exact = parseExact(core, unit);
  // 한 셀에 상·하 방향이 함께 있으면(`10 이상 20 이하`) 어느 쪽인지 정할 수 없다 — 원문을 남기고 경고한다
  if (exact !== null && !conflict) return { value: exact, hint, original: null, warning: null };

  const found = exact ?? firstNumber(core);
  if (found === null) return { value: null, hint, original: raw, warning: 'no-number' };
  return { value: found, hint, original: raw, warning: 'unparsed-text' };
}

function extractHint(text: string): { hint: GoalValueHint | null; conflict: boolean; rest: string } {
  let rest = text;
  const seen = new Set<GoalValueHint>();
  for (const hint of Object.keys(GOAL_VALUE_HINT_KEYWORDS) as GoalValueHint[]) {
    for (const keyword of GOAL_VALUE_HINT_KEYWORDS[hint]) {
      if (rest.includes(keyword)) {
        seen.add(hint);
        rest = rest.split(keyword).join(' ');
      }
    }
  }
  if (seen.size === 1) return { hint: [...seen][0] ?? null, conflict: false, rest };
  return { hint: null, conflict: seen.size > 1, rest };
}

// 숫자·범위·%·단위 접미 말고는 아무것도 남지 않을 때만 값을 돌려준다
function parseExact(core: string, unit: string): number | null {
  // 공백을 지우기 전에 막는다 — `10 20`이 1020으로 붙으면 조용히 틀린 값이 된다
  if (/\d\s+[\d.]/.test(core)) return null;
  const compact = core.replace(/\s+/g, '').replace(/%/g, '');
  const unitCompact = unit.replace(/\s+/g, '');
  const parts = compact.split('~');
  if (parts.length > 2) return null;
  const numbers = parts.map((part) => {
    // 접미 하나만 뗀다 — 전부 지우면 unit `m`일 때 `10mm`가 10으로 풀린다
    const body =
      unitCompact !== '' && part.endsWith(unitCompact) && part.length > unitCompact.length
        ? part.slice(0, -unitCompact.length)
        : part;
    return PLAIN_NUMBER.test(body) ? Number(body) : null;
  });
  if (numbers.some((n) => n === null)) return null;
  // `a~b` 범위는 도달해야 할 쪽인 뒤 숫자를 목표로 삼는다 (GF-6)
  return numbers[numbers.length - 1] ?? null;
}

function firstNumber(core: string): number | null {
  const match = FIRST_NUMBER.exec(core);
  if (!match) return null;
  let token = match[0];
  // `LOD-2.5`·`A-10`의 `-`는 부호가 아니라 이음표다 — 앞 글자가 문자·숫자면 부호로 보지 않는다
  if (token.startsWith('-') && match.index > 0 && /[0-9A-Za-z가-힣.]/.test(core.charAt(match.index - 1))) {
    token = token.slice(1);
  }
  return Number(token);
}

// 연차별(·최종) 셀의 힌트를 하나로 모은다. 서로 다르면 어느 쪽도 고르지 않는다 —
// 방향을 정하는 것은 호출자(방향 열 폴백 + 경고)의 몫이다
export function combineHints(
  hints: readonly (GoalValueHint | null)[],
): { hint: GoalValueHint | null; conflict: boolean } {
  const distinct = new Set(hints.filter((h): h is GoalValueHint => h !== null));
  if (distinct.size === 1) return { hint: [...distinct][0] ?? null, conflict: false };
  return { hint: null, conflict: distinct.size > 1 };
}

// 비고에 `[원문] {열 라벨}: {원문}` 한 줄을 붙인다. 같은 줄이 있으면 그대로 — 다시 올려도 늘지 않는다(멱등)
export function appendOriginalNote(note: string, columnLabel: string, original: string): string {
  // hwpx 셀은 여러 문단일 수 있다 — 한 줄로 접어야 줄 단위 멱등 비교가 성립한다
  const line = `[원문] ${columnLabel}: ${original.trim().replace(/\s*\n\s*/g, ' ')}`;
  if (note.trim() === '') return line;
  if (note.split('\n').some((existing) => existing.trim() === line)) return note;
  return note.endsWith('\n') ? `${note}${line}` : `${note}\n${line}`;
}
