// I-1 라벨 정규화 · I-3 레벤슈타인 유사도 · 엑셀 열 문자 변환 (SOT §6.8.3, 부록 C).
// 부수효과 없는 순수 함수다. 단위 테스트: tests/unit/import-normalize.test.ts

// ─── I-1 정규화 ──────────────────────────────────────────────

// ① 가운뎃점 전 변형. U+30FB(카타카나 중점)·U+FF65(반각)은 실측에 없지만 같은 글자류라 함께 지운다
const MIDDLE_DOTS = /[·‧ㆍ•・･]/g;

const OPEN_PARENS = '(（[［〔';
const CLOSE_PARENS = ')）]］〕';

// ⑤ 별표·하이픈. 각종 대시와 물결·밑줄까지 포함한다
const MARKS = /[*※＊＿_~〜～\-‐-―−]/g;

/**
 * ② 각주 마커 `숫자)` 제거.
 *
 * **③ 괄호 제거보다 먼저 돌려야 한다** (I-1). `총 인건비1) (E=A+B+C+D)`의 `1)`은 짝 없는
 * 닫는 괄호라, 괄호 제거를 먼저 하면 그 `)`가 `(E=...)`의 짝으로 소비되어 `총인건비1`이 남고
 * 스킵 패턴에 걸리지 않는다 (실측 산자부 12·13행, 행안부 17행).
 *
 * 짝이 맞는 괄호 안의 `숫자)`(예: `(I/E1)`의 `1)`)는 각주가 아니므로 건드리지 않는다 —
 * 괄호 깊이를 세어 **깊이 0의 짝 없는 닫는 괄호**만 각주로 본다.
 */
export function stripFootnoteMarkers(input: string): string {
  const chars = [...input];
  const out: string[] = [];
  let depth = 0;
  for (const ch of chars) {
    if (OPEN_PARENS.includes(ch)) {
      depth += 1;
      out.push(ch);
      continue;
    }
    if (CLOSE_PARENS.includes(ch)) {
      if (depth > 0) {
        depth -= 1;
        out.push(ch);
        continue;
      }
      // 짝 없는 닫는 괄호 = 각주 마커. 바로 앞의 숫자(와 그 사이 공백)까지 함께 지운다
      while (out.length > 0 && /\s/.test(out[out.length - 1]!)) out.pop();
      while (out.length > 0 && /[0-9０-９]/.test(out[out.length - 1]!)) out.pop();
      continue;
    }
    out.push(ch);
  }
  return out.join('');
}

/** ③ 괄호와 괄호 안 내용 제거. 중첩 괄호와 전각 `（）`를 처리하고, 짝 없는 여는 괄호는 끝까지 지운다 */
export function stripParentheses(input: string): string {
  let out = '';
  let depth = 0;
  for (const ch of input) {
    if (OPEN_PARENS.includes(ch)) {
      depth += 1;
      continue;
    }
    if (CLOSE_PARENS.includes(ch)) {
      if (depth > 0) depth -= 1;
      continue;
    }
    if (depth === 0) out += ch;
  }
  return out;
}

/**
 * I-1 정규화. SOT가 정한 순서를 그대로 지킨다:
 * ① 가운뎃점 변형 제거 → ② 각주 마커 `숫자)` 제거 → ③ 괄호+내용 제거(중첩·전각 포함)
 * → ④ 내부 공백 전부 제거 → ⑤ 별표·하이픈 제거 → ⑥ 소문자화.
 *
 * NFC 정규화를 먼저 한다 — 맥에서 만든 파일의 분해형 한글(NFD)이 사전 키와 어긋나는 것을 막는다.
 */
export function normalizeLabel(raw: string | null | undefined): string {
  if (raw === null || raw === undefined) return '';
  let s = String(raw).normalize('NFC');
  s = s.replace(MIDDLE_DOTS, '');
  s = stripFootnoteMarkers(s);
  s = stripParentheses(s);
  s = s.replace(/\s+/g, '');
  s = s.replace(MARKS, '');
  return s.toLowerCase();
}

// ─── I-3 레벤슈타인 유사도 ───────────────────────────────────

/** 편집 거리. 두 행만 유지하는 DP — 라벨 길이가 짧아 이 이상 최적화할 이유가 없다 */
export function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;

  const aChars = [...a];
  const bChars = [...b];
  let prev: number[] = Array.from({ length: bChars.length + 1 }, (_, i) => i);
  let curr: number[] = new Array<number>(bChars.length + 1).fill(0);

  for (let i = 1; i <= aChars.length; i += 1) {
    curr[0] = i;
    for (let j = 1; j <= bChars.length; j += 1) {
      const cost = aChars[i - 1] === bChars[j - 1] ? 0 : 1;
      curr[j] = Math.min(curr[j - 1]! + 1, prev[j]! + 1, prev[j - 1]! + cost);
    }
    [prev, curr] = [curr, prev];
  }
  return prev[bChars.length]!;
}

/**
 * I-3 유사도 = `1 - levenshtein(a, b) / max(len(a), len(b))`.
 * 한쪽이라도 비어 있으면 비교 대상이 아니므로 0 — 빈 라벨이 아무 비목에나 붙는 것을 막는다.
 */
export function similarity(a: string, b: string): number {
  if (a.length === 0 || b.length === 0) return 0;
  if (a === b) return 1;
  const max = Math.max([...a].length, [...b].length);
  return 1 - levenshtein(a, b) / max;
}

/** I-3 후보 채택 하한 */
export const FUZZY_THRESHOLD = 0.8;

// ─── 엑셀 열 문자 ↔ 0-based 인덱스 ──────────────────────────

const COLUMN_LETTER = /^[A-Za-z]+$/;

/** 'A' → 0, 'Z' → 25, 'AA' → 26 (27번째 열). 잘못된 입력은 조용히 넘기지 않고 던진다 */
export function columnLetterToIndex(letter: string): number {
  const trimmed = letter.trim();
  if (!COLUMN_LETTER.test(trimmed)) {
    throw new Error(`엑셀 열 문자가 아닙니다: ${JSON.stringify(letter)}`);
  }
  let index = 0;
  for (const ch of trimmed.toUpperCase()) {
    index = index * 26 + (ch.charCodeAt(0) - 64);
  }
  return index - 1;
}

/** 0 → 'A', 25 → 'Z', 26 → 'AA' */
export function indexToColumnLetter(index: number): string {
  if (!Number.isInteger(index) || index < 0) {
    throw new Error(`열 인덱스는 0 이상 정수여야 합니다: ${index}`);
  }
  let n = index + 1;
  let letter = '';
  while (n > 0) {
    const rest = (n - 1) % 26;
    letter = String.fromCharCode(65 + rest) + letter;
    n = Math.floor((n - 1) / 26);
  }
  return letter;
}
