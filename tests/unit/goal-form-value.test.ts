// GF-6 숫자 해석 테스트 (SOT §6.17 GF-6, 부록 C.3.4, §11 Phase 21 완료 기준)

import { describe, expect, it } from 'vitest';
import { GOAL_VALUE_HINT_KEYWORDS, GOAL_VALUE_NONE_SYMBOLS } from '@/lib/constants';
import { appendOriginalNote, combineHints, parseGoalValue } from '@/lib/goal-form/value';

describe('부록 C.3.4 상수', () => {
  it('키워드 표가 SOT와 같다', () => {
    expect(GOAL_VALUE_HINT_KEYWORDS.higher_better).toEqual(['≥', '>', '이상', '↑', '초과']);
    expect(GOAL_VALUE_HINT_KEYWORDS.lower_better).toEqual(['≤', '<', '이하', '미만', '이내', '↓']);
    expect(GOAL_VALUE_NONE_SYMBOLS).toEqual(['-', '—', '없음']);
  });
});

describe('parseGoalValue — §11 완료 기준', () => {
  it("'≤10' → 10 · lower_better, 경고 없음", () => {
    expect(parseGoalValue('≤10', '')).toEqual({
      value: 10,
      hint: 'lower_better',
      original: null,
      warning: null,
    });
  });

  it("'LOD 2.5' → 2.5 + 원문 + unparsed-text", () => {
    expect(parseGoalValue('LOD 2.5', 'ppm')).toEqual({
      value: 2.5,
      hint: null,
      original: 'LOD 2.5',
      warning: 'unparsed-text',
    });
  });
});

describe('parseGoalValue — 없음·빈 값', () => {
  it.each([null, undefined, '', '   ', '-', '—', '없음', ' 없음 '])('%j → null, 경고 없음', (raw) => {
    expect(parseGoalValue(raw, '건')).toEqual({ value: null, hint: null, original: null, warning: null });
  });

  it('없음 기호는 셀 전체일 때만 — 선두 -는 음수', () => {
    expect(parseGoalValue('-40', '')).toMatchObject({ value: -40, warning: null });
    expect(parseGoalValue('-5', '')).toMatchObject({ value: -5, warning: null });
    expect(parseGoalValue('-0.25', '')).toMatchObject({ value: -0.25, warning: null });
  });
});

describe('parseGoalValue — 숫자 셀', () => {
  it('숫자형은 그대로 쓰고 힌트·원문이 없다', () => {
    expect(parseGoalValue(0.1 + 0.2, '%')).toEqual({ value: 0.1 + 0.2, hint: null, original: null, warning: null });
    expect(parseGoalValue(-3, '')).toMatchObject({ value: -3, warning: null });
    expect(parseGoalValue(0, '건')).toMatchObject({ value: 0, warning: null });
  });

  it('유한하지 않은 숫자는 no-number', () => {
    expect(parseGoalValue(Number.NaN, '')).toMatchObject({ value: null, warning: 'no-number', original: 'NaN' });
  });
});

describe('parseGoalValue — 방향 힌트 키워드', () => {
  it.each(['≥', '이상', '↑', '초과'])('%s → higher_better', (kw) => {
    const r = parseGoalValue(kw === '≥' || kw === '↑' ? `${kw}95` : `95 ${kw}`, '');
    expect(r).toEqual({ value: 95, hint: 'higher_better', original: null, warning: null });
  });

  it.each(['≤', '이하', '미만', '이내', '↓'])('%s → lower_better', (kw) => {
    const r = parseGoalValue(kw === '≤' || kw === '↓' ? `${kw} 3` : `3${kw}`, '');
    expect(r).toEqual({ value: 3, hint: 'lower_better', original: null, warning: null });
  });

  it('단위와 키워드가 함께 있어도 풀린다', () => {
    expect(parseGoalValue('10 ppm 이하', 'ppm')).toEqual({
      value: 10,
      hint: 'lower_better',
      original: null,
      warning: null,
    });
  });

  it('상·하 키워드가 한 셀에 섞이면 힌트 없음 + 첫 숫자 + 경고', () => {
    expect(parseGoalValue('10 이상 20 이하', '')).toEqual({
      value: 10,
      hint: null,
      original: '10 이상 20 이하',
      warning: 'unparsed-text',
    });
  });

  // `<`·`>`는 U-3로 추가(실측 `< 5`). `≤`·`≥`와는 다른 코드 포인트라 부분 문자열로 겹치지 않는다
  it("'< 5' → 5 · lower_better, 경고 없음", () => {
    expect(parseGoalValue('< 5', '')).toEqual({ value: 5, hint: 'lower_better', original: null, warning: null });
  });

  it("'> 3' → 3 · higher_better, 경고 없음", () => {
    expect(parseGoalValue('> 3', '')).toEqual({ value: 3, hint: 'higher_better', original: null, warning: null });
  });

  it('`<`·`>`도 단위와 함께 풀린다', () => {
    expect(parseGoalValue('<5ms', 'ms')).toEqual({ value: 5, hint: 'lower_better', original: null, warning: null });
    expect(parseGoalValue('>95 %', '%')).toEqual({ value: 95, hint: 'higher_better', original: null, warning: null });
  });

  it('`≤`·`≥`는 `<`·`>` 추가 뒤에도 그대로', () => {
    expect(parseGoalValue('≤ 5', '').hint).toBe('lower_better');
    expect(parseGoalValue('≥ 5', '').hint).toBe('higher_better');
  });

  // 두 글자 표기는 C.3.4에 없다 — 방향은 잡히고 남는 `=`는 조용히 버리지 않고 원문 경고로 남는다
  it.each([
    ['<= 5', 'lower_better'],
    ['>= 5', 'higher_better'],
  ] as const)('%s → 5 · %s + 원문 + unparsed-text', (raw, hint) => {
    expect(parseGoalValue(raw, '')).toEqual({ value: 5, hint, original: raw, warning: 'unparsed-text' });
  });

  it('`<`·`>`가 한 셀에 함께 있으면 힌트 없음 + 경고', () => {
    expect(parseGoalValue('> 3 < 5', '')).toEqual({
      value: 3,
      hint: null,
      original: '> 3 < 5',
      warning: 'unparsed-text',
    });
  });

  it("'수초이내' → 힌트는 남지만 숫자가 없어 no-number", () => {
    expect(parseGoalValue('수초이내', '초')).toEqual({
      value: null,
      hint: 'lower_better',
      original: '수초이내',
      warning: 'no-number',
    });
  });
});

describe('parseGoalValue — 범위·쉼표·공백·%·단위', () => {
  it('a~b 범위는 뒤 숫자', () => {
    expect(parseGoalValue('10~20', '')).toMatchObject({ value: 20, warning: null });
    expect(parseGoalValue('10 ~ 20 %', '%')).toMatchObject({ value: 20, warning: null });
    expect(parseGoalValue('5nm~3nm', 'nm')).toMatchObject({ value: 3, warning: null });
    expect(parseGoalValue('-5~-1', '')).toMatchObject({ value: -1, warning: null });
  });

  it('범위 구분자가 둘 이상이면 풀지 않는다', () => {
    expect(parseGoalValue('1~2~3', '')).toMatchObject({ value: 1, warning: 'unparsed-text' });
  });

  it('천 단위 쉼표·공백·% 제거, 원값 보존(중간 반올림 없음)', () => {
    expect(parseGoalValue('1,234.5678', '')).toMatchObject({ value: 1234.5678, warning: null });
    expect(parseGoalValue('1,000,000', '원')).toMatchObject({ value: 1000000, warning: null });
    expect(parseGoalValue(' 95 % ', '%')).toMatchObject({ value: 95, warning: null });
    expect(parseGoalValue('0.3', '')).toMatchObject({ value: 0.3 });
    expect(parseGoalValue('0.1234567890123', '')).toMatchObject({ value: 0.1234567890123 });
  });

  it('단위 접미(단위 열과 같은 문자열)를 뗀다', () => {
    expect(parseGoalValue('3건', '건')).toMatchObject({ value: 3, warning: null });
    expect(parseGoalValue('12.5 mg/L', 'mg / L')).toMatchObject({ value: 12.5, warning: null });
  });

  it('단위 접미는 한 번만 — 다른 단위는 남는 문자로 경고', () => {
    expect(parseGoalValue('10mm', 'm')).toMatchObject({ value: 10, warning: 'unparsed-text', original: '10mm' });
    expect(parseGoalValue('3개', '건')).toMatchObject({ value: 3, warning: 'unparsed-text', original: '3개' });
  });

  it('단위가 빈 문자열이면 접미를 떼지 않는다', () => {
    expect(parseGoalValue('3건', '')).toMatchObject({ value: 3, warning: 'unparsed-text' });
  });

  it('공백으로 나뉜 숫자는 붙이지 않는다', () => {
    expect(parseGoalValue('10 20', '')).toMatchObject({ value: 10, warning: 'unparsed-text', original: '10 20' });
  });

  it('목록 쉼표는 천 단위로 보지 않는다', () => {
    expect(parseGoalValue('1,2', '')).toMatchObject({ value: 1, warning: 'unparsed-text' });
  });
});

describe('parseGoalValue — 남는 문자·숫자 없음', () => {
  it('남는 문자가 있으면 첫 숫자 + 원문 + unparsed-text', () => {
    expect(parseGoalValue('정확도 95% (시험성적서)', '%')).toEqual({
      value: 95,
      hint: null,
      original: '정확도 95% (시험성적서)',
      warning: 'unparsed-text',
    });
  });

  it('문자 뒤 이음표 -는 부호가 아니다', () => {
    expect(parseGoalValue('LOD-2.5', '')).toMatchObject({ value: 2.5, warning: 'unparsed-text' });
  });

  it('문자 앞 선두 -는 부호다', () => {
    expect(parseGoalValue('-3 dB 수준', '')).toMatchObject({ value: -3, warning: 'unparsed-text' });
  });

  it('숫자가 아예 없으면 null + 원문 + no-number', () => {
    expect(parseGoalValue('세계 최고 수준', '')).toEqual({
      value: null,
      hint: null,
      original: '세계 최고 수준',
      warning: 'no-number',
    });
  });

  it('원문은 trim하지 않은 셀 문자열 그대로', () => {
    expect(parseGoalValue(' LOD 2.5 ', '')).toMatchObject({ original: ' LOD 2.5 ' });
  });
});

describe('combineHints', () => {
  it('모두 null이면 힌트 없음', () => {
    expect(combineHints([])).toEqual({ hint: null, conflict: false });
    expect(combineHints([null, null])).toEqual({ hint: null, conflict: false });
  });

  it('하나로 모이면 그 힌트 (null은 무시)', () => {
    expect(combineHints([null, 'lower_better', 'lower_better'])).toEqual({ hint: 'lower_better', conflict: false });
    expect(combineHints(['higher_better'])).toEqual({ hint: 'higher_better', conflict: false });
  });

  it('서로 다르면 conflict, 힌트는 고르지 않는다', () => {
    expect(combineHints(['higher_better', null, 'lower_better'])).toEqual({ hint: null, conflict: true });
  });
});

describe('appendOriginalNote', () => {
  it('빈 비고면 줄만', () => {
    expect(appendOriginalNote('', '1차년도 목표', 'LOD 2.5')).toBe('[원문] 1차년도 목표: LOD 2.5');
    expect(appendOriginalNote('  ', '최종 목표', '수초이내')).toBe('[원문] 최종 목표: 수초이내');
  });

  it('기존 비고 뒤에 한 줄 덧붙인다', () => {
    expect(appendOriginalNote('메모', '최종 목표', 'LOD 2.5')).toBe('메모\n[원문] 최종 목표: LOD 2.5');
    expect(appendOriginalNote('메모\n', '최종 목표', 'LOD 2.5')).toBe('메모\n[원문] 최종 목표: LOD 2.5');
  });

  it('멱등 — 같은 줄이 있으면 그대로', () => {
    const once = appendOriginalNote('메모', '최종 목표', 'LOD 2.5');
    expect(appendOriginalNote(once, '최종 목표', 'LOD 2.5')).toBe(once);
    const twice = appendOriginalNote(once, '1차년도 목표', 'LOD 3');
    expect(twice).toBe('메모\n[원문] 최종 목표: LOD 2.5\n[원문] 1차년도 목표: LOD 3');
    expect(appendOriginalNote(twice, '1차년도 목표', 'LOD 3')).toBe(twice);
  });

  it('열 라벨이 다르면 다른 줄', () => {
    const once = appendOriginalNote('', '최종 목표', 'LOD 2.5');
    expect(appendOriginalNote(once, '국내수준', 'LOD 2.5')).toBe('[원문] 최종 목표: LOD 2.5\n[원문] 국내수준: LOD 2.5');
  });

  it('여러 줄 원문은 한 줄로 접어 멱등을 지킨다', () => {
    const once = appendOriginalNote('', '최종 목표', ' 95%\n(시험성적서) ');
    expect(once).toBe('[원문] 최종 목표: 95% (시험성적서)');
    expect(appendOriginalNote(once, '최종 목표', ' 95%\n(시험성적서) ')).toBe(once);
  });
});
