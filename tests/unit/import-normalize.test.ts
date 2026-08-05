// I-1 정규화 · I-3 유사도 · 엑셀 열 문자 (SOT §6.8.3, 부록 C 주의 2)
//
// I-1의 **순서**가 규칙이다: ② 각주 마커 `숫자)` 제거를 ③ 괄호 제거보다 먼저 해야 한다.
// 순서를 뒤집으면 `총 인건비1) (E=A+B+C+D)`의 짝 없는 `)`가 뒤 괄호의 짝으로 소비되어
// `총인건비1`이 남고 스킵 패턴에 걸리지 않는다 — 실측에서 집계·비율 행이 비목으로 반영됐다.

import { describe, expect, it } from 'vitest';
import {
  FUZZY_THRESHOLD,
  columnLetterToIndex,
  indexToColumnLetter,
  levenshtein,
  normalizeLabel,
  similarity,
  stripFootnoteMarkers,
  stripParentheses,
} from '@/lib/import/normalize';
import { SKIP_ROW_PATTERNS } from '@/lib/constants';

describe('normalizeLabel — I-1 정규화 순서', () => {
  // 회귀: ②를 ③보다 먼저 하지 않으면 전부 스킵 패턴을 빗나간다
  it.each([
    ['총 인건비1) (E=A+B+C+D)', '총인건비'],
    ['수정인건비2) (E1=A+B+D)', '수정인건비'],
    ['* 연구수당 비율3) (I/E1)', '연구수당비율'],
    ['* 간접비 비율4) (L/(N+O+P+D+R+S+T+U))', '간접비비율'], // 중첩 괄호
    ['인건비 비율(E1/M)', '인건비비율'],
  ])('%s → %s', (raw, expected) => {
    expect(normalizeLabel(raw)).toBe(expected);
  });

  it('위 5개는 전부 스킵 패턴에 걸린다 (부록 C 주의 2)', () => {
    const skip = new Set(SKIP_ROW_PATTERNS.map(normalizeLabel));
    for (const raw of [
      '총 인건비1) (E=A+B+C+D)',
      '수정인건비2) (E1=A+B+D)',
      '* 연구수당 비율3) (I/E1)',
      '* 간접비 비율4) (L/(N+O+P+D+R+S+T+U))',
      '인건비 비율(E1/M)',
    ]) {
      expect(skip.has(normalizeLabel(raw))).toBe(true);
    }
  });

  it('① 가운뎃점 4종을 제거한다', () => {
    expect(normalizeLabel('연구시설·장비비')).toBe('연구시설장비비'); // U+00B7
    expect(normalizeLabel('연구시설‧장비비')).toBe('연구시설장비비'); // U+2027
    expect(normalizeLabel('연구시설ㆍ장비비')).toBe('연구시설장비비'); // U+318D
    expect(normalizeLabel('연구시설•장비비')).toBe('연구시설장비비'); // U+2022
  });

  it('③ 괄호와 괄호 안 내용을 제거한다 (중첩·전각 포함)', () => {
    expect(normalizeLabel('내부인건비 (A)')).toBe('내부인건비');
    expect(normalizeLabel('현금 (N)')).toBe('현금');
    expect(normalizeLabel('장비비(F)')).toBe('장비비');
    expect(normalizeLabel('인건비（현금）')).toBe('인건비');
    expect(normalizeLabel('간접비 (L/(N+O))')).toBe('간접비');
  });

  it('③ 짝 없는 여는 괄호는 끝까지 지운다 — 잘린 메모를 반쯤 살려 두지 않는다', () => {
    expect(normalizeLabel('(간접비 중 연구실 안전관리비')).toBe('');
  });

  it('④ 내부 공백을 전부 제거한다', () => {
    expect(normalizeLabel('소 계')).toBe('소계');
    expect(normalizeLabel('학생 인건비')).toBe('학생인건비');
    expect(normalizeLabel('학생　인건비')).toBe('학생인건비'); // 전각 공백
  });

  it('⑤ 별표·하이픈을 제거하고 ⑥ 소문자화한다', () => {
    expect(normalizeLabel('* 연구활동비')).toBe('연구활동비');
    expect(normalizeLabel('※연구-활동비')).toBe('연구활동비');
    expect(normalizeLabel('R&D')).toBe('r&d');
  });

  it('I-5: 전체가 괄호 메모면 빈 문자열이 된다', () => {
    expect(normalizeLabel('(간접비 중 연구실 안전관리비)')).toBe('');
    expect(normalizeLabel('(K=E1+F+G+H+I)')).toBe('');
    expect(normalizeLabel('(G)')).toBe('');
  });

  it('null·undefined·공백은 빈 문자열', () => {
    expect(normalizeLabel(null)).toBe('');
    expect(normalizeLabel(undefined)).toBe('');
    expect(normalizeLabel('   ')).toBe('');
  });

  it('분해형 한글(NFD)도 같은 결과가 나온다', () => {
    expect(normalizeLabel('인건비'.normalize('NFD'))).toBe('인건비');
  });
});

describe('stripFootnoteMarkers (I-1 ②)', () => {
  it('깊이 0의 짝 없는 닫는 괄호 앞 숫자만 각주로 본다', () => {
    expect(stripFootnoteMarkers('총 인건비1) (E=A+B+C+D)')).toBe('총 인건비 (E=A+B+C+D)');
  });

  it('짝이 맞는 괄호는 건드리지 않는다', () => {
    expect(stripFootnoteMarkers('(1) 인건비')).toBe('(1) 인건비');
    expect(stripFootnoteMarkers('내부인건비 (A)')).toBe('내부인건비 (A)');
  });
});

describe('stripParentheses (I-1 ③)', () => {
  it('중첩 괄호를 전부 소화한다', () => {
    expect(stripParentheses('간접비 (L/(N+O+P))비율')).toBe('간접비 비율');
  });
});

describe('levenshtein / similarity (I-3)', () => {
  it('같은 문자열은 거리 0, 유사도 1', () => {
    expect(levenshtein('인건비', '인건비')).toBe(0);
    expect(similarity('인건비', '인건비')).toBe(1);
  });

  it('SOT 정의 그대로 1 - lev/max(len)이다', () => {
    // '연구활동비'(5) vs '연구활동'(4): 거리 1 → 1 - 1/5 = 0.8
    expect(levenshtein('연구활동비', '연구활동')).toBe(1);
    expect(similarity('연구활동비', '연구활동')).toBeCloseTo(0.8, 10);
  });

  it('빈 문자열은 유사도 0 — 빈 라벨이 아무 비목에나 붙지 않게 한다', () => {
    expect(similarity('', '인건비')).toBe(0);
    expect(similarity('인건비', '')).toBe(0);
  });

  it('세로쓰기 조각은 임계값(0.8)에 한참 못 미친다', () => {
    expect(similarity('비', '인건비')).toBeLessThan(FUZZY_THRESHOLD);
    expect(similarity('직', '직접비')).toBeLessThan(FUZZY_THRESHOLD);
  });
});

describe('엑셀 열 문자 ↔ 0-based 인덱스', () => {
  it.each([
    ['A', 0],
    ['B', 1],
    ['Z', 25],
    ['AA', 26],
    ['AB', 27],
    ['AZ', 51],
    ['BA', 52],
    ['ZZ', 701],
    ['AAA', 702],
  ])('%s ↔ %i', (letter, index) => {
    expect(columnLetterToIndex(letter)).toBe(index);
    expect(indexToColumnLetter(index)).toBe(letter);
  });

  it('27번째 열은 AA다 (0-based 26)', () => {
    expect(indexToColumnLetter(26)).toBe('AA');
    expect(columnLetterToIndex('AA')).toBe(26);
  });

  it('소문자·공백도 받는다', () => {
    expect(columnLetterToIndex(' aa ')).toBe(26);
  });

  it('잘못된 입력은 조용히 넘기지 않고 던진다', () => {
    expect(() => columnLetterToIndex('')).toThrow();
    expect(() => columnLetterToIndex('A1')).toThrow();
    expect(() => indexToColumnLetter(-1)).toThrow();
  });
});
