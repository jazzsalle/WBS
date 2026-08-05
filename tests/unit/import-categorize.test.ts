// 비목 라벨 판정 (SOT 부록 C 주의 1의 4단계, §6.8.3 I-2~I-6, §6.8.2 S-2')
//
// 판정 순서: ① 완전일치 비목(표준 명칭) → ② 별칭 사전(I-2 우선순위) → ③ 축 라벨 → ④ 스킵 패턴.
// `간접비`는 ①에서 확정되므로 스킵되지 않고, `직접비`는 비목이 아니라 ④에서 걸러진다.

import { describe, expect, it } from 'vitest';
import {
  classifyLabel,
  findFuzzyCandidate,
  isCarryForwardable,
  isCategoryLabel,
  lookupAlias,
} from '@/lib/import/categorize';
import { MINISTRY_ALIAS_PRESETS } from '@/lib/constants';
import { normalizeLabel } from '@/lib/import/normalize';
import type { MatchContext } from '@/lib/import/types';

describe('classifyLabel — 부록 C 주의 1의 4단계', () => {
  it('① 완전일치 비목: 표준 명칭과 일치하면 비목이다', () => {
    const result = classifyLabel('간접비 (L)');
    expect(result.kind).toBe('category');
    expect(result.category).toBe('indirect');
    expect(result.categorySource).toBe('exact');
  });

  it('① `간접비`는 스킵 패턴(`간접비계`)과 섞이지 않는다', () => {
    expect(classifyLabel('간접비').kind).toBe('category');
    expect(classifyLabel('간접비계').kind).toBe('skip');
    expect(classifyLabel('간접비 소계').kind).toBe('skip');
  });

  it('② 별칭 사전: 세목은 상위 비목으로 귀속된다 (S-3)', () => {
    expect(classifyLabel('내부인건비 (A)')).toMatchObject({
      kind: 'category',
      category: 'personnel',
      categorySource: 'alias-common',
    });
    expect(classifyLabel('외부인건비 (B)').category).toBe('personnel');
    expect(classifyLabel('연구지원인력인건비(C)').category).toBe('personnel');
  });

  it('③ 축 라벨은 비목도 스킵도 아니다 (S-4)', () => {
    expect(classifyLabel('현금 (N)')).toMatchObject({ kind: 'axis', axis: 'cash' });
    expect(classifyLabel('현물')).toMatchObject({ kind: 'axis', axis: 'inKind' });
    expect(classifyLabel('현금액').axis).toBe('cash');
    expect(classifyLabel('현물액').axis).toBe('inKind');
  });

  it('③ `일반`/`통합관리`는 현금도 현물도 아닌 unassigned다', () => {
    expect(classifyLabel('일반').axis).toBe('unassigned');
    expect(classifyLabel('통합관리').axis).toBe('unassigned');
  });

  it('④ 스킵 패턴: `직접비`는 비목 목록에 없으므로 걸러진다', () => {
    expect(classifyLabel('직접비').kind).toBe('skip');
    expect(classifyLabel('직접비 소계 (K)').kind).toBe('skip');
    expect(classifyLabel('소 계').kind).toBe('skip');
    expect(classifyLabel('연구개발비 총액 (M=K+L)').kind).toBe('skip');
  });

  it('I-5: 원래 빈 셀(empty)과 정규화로 비워진 라벨(blank-after-normalize)을 구분한다', () => {
    expect(classifyLabel('').kind).toBe('empty');
    expect(classifyLabel(null).kind).toBe('empty');
    expect(classifyLabel('   ').kind).toBe('empty');

    expect(classifyLabel('(간접비 중 연구실 안전관리비)').kind).toBe('blank-after-normalize');
    expect(classifyLabel('(K=E1+F+G+H+I)').kind).toBe('blank-after-normalize');
    expect(classifyLabel('(G)').kind).toBe('blank-after-normalize');
    // 원본 텍스트는 남겨 둔다 — 미리보기에 무엇을 건너뛰었는지 보여야 한다
    expect(classifyLabel('(G)').raw).toBe('(G)');
  });

  it('I-6: 구 비목 체계는 자동 분할하지 않고 후보를 돌려준다', () => {
    const result = classifyLabel('연구장비·재료비');
    expect(result.kind).toBe('ambiguous');
    expect(result.category).toBeNull();
    expect(result.ambiguousCandidates).toEqual(['facility_equipment', 'material']);

    expect(classifyLabel('연구활동 및 과제추진비').ambiguousCandidates).toEqual([
      'activity',
      'promotion',
    ]);
  });

  it('세로쓰기 조각·미지의 라벨은 unknown이다 (I-4로 내려간다)', () => {
    for (const fragment of ['직', '접', '비']) {
      expect(classifyLabel(fragment).kind).toBe('unknown');
    }
    expect(classifyLabel('알 수 없는 항목').kind).toBe('unknown');
  });
});

// 실측 서식(산자부·행안부)에서 그대로 뽑은 라벨들 — 회귀 고정
describe('실측 라벨 회귀', () => {
  it.each([
    ['총 인건비1) (E=A+B+C+D)', 'skip'],
    ['수정인건비2) (E1=A+B+D)', 'skip'],
    ['* 연구수당 비율3) (I/E1)', 'skip'],
    ['* 간접비 비율4) (L/(N+O+P+D+R+S+T+U))', 'skip'],
    ['직접비', 'skip'],
    ['(간접비 중 연구실 안전관리비)', 'blank-after-normalize'],
  ])('%s → %s', (raw, kind) => {
    expect(classifyLabel(raw).kind).toBe(kind);
  });

  it.each([
    ['연구시설‧장비비 (F)', 'facility_equipment'],
    ['장비비(F)', 'facility_equipment'],
    ['학생 인건비 (D)', 'student_personnel'],
    ['간접비 (L)', 'indirect'],
    ['연구지원인력인건비(C)', 'personnel'],
    ['연구재료비', 'material'],
    ['연구활동비 (H)', 'activity'],
    ['연구수당 (I)', 'allowance'],
    ['위탁연구개발비 (J)', 'consignment'],
  ])('%s → %s', (raw, category) => {
    const result = classifyLabel(raw);
    expect(result.kind).toBe('category');
    expect(result.category).toBe(category);
  });
});

describe('lookupAlias — I-2 조회 우선순위', () => {
  it('① draft 학습분이 부처 프리셋·공통 사전을 이긴다', () => {
    const context: MatchContext = {
      draftAliases: { '인건비': 'other' },
      ministry: '산업통상자원부',
    };
    expect(lookupAlias('인건비', context)).toEqual({ category: 'other', source: 'alias-draft' });
  });

  // MINISTRY_ALIAS_PRESETS는 지금 전부 빈 객체다 — 확보한 산자부·행안부 서식의 표기가
  // 혁신법 표준과 일치해서다(부록 C). 그래서 **조회 체인의 중간 계층이 실제 데이터로는
  // 한 번도 실행되지 않는다.** 임시 프리셋을 끼워 순서 자체를 고정해 둔다. 새 부처 서식이
  // 들어와 프리셋이 채워질 때 이 순서가 깨져 있으면 여기서 잡힌다.
  it('② 부처 프리셋이 공통 사전을 이긴다', () => {
    const ministry = '프리셋순서검증부'; // 캐시 오염을 피하려고 이 테스트 전용 키를 쓴다
    MINISTRY_ALIAS_PRESETS[ministry] = { 내부인건비: 'other' };
    try {
      expect(lookupAlias('내부인건비', { ministry })).toEqual({
        category: 'other',
        source: 'alias-ministry',
      });
      // 프리셋에 없는 라벨은 그대로 공통 사전으로 내려간다
      expect(lookupAlias('연구활동비', { ministry })?.source).toBe('alias-common');
    } finally {
      delete MINISTRY_ALIAS_PRESETS[ministry];
    }
  });

  it('②-1 프리셋이 없는 부처는 공통 사전으로 내려간다', () => {
    const context: MatchContext = { ministry: '프리셋없는부' };
    expect(lookupAlias('내부인건비', context)?.source).toBe('alias-common');
  });

  it('②-2 draft 학습분 > 부처 프리셋 (같은 라벨에 둘 다 있을 때)', () => {
    const ministry = '프리셋우선순위검증부';
    MINISTRY_ALIAS_PRESETS[ministry] = { 내부인건비: 'other' };
    try {
      expect(
        lookupAlias('내부인건비', { ministry, draftAliases: { 내부인건비: 'promotion' } })
      ).toEqual({ category: 'promotion', source: 'alias-draft' });
    } finally {
      delete MINISTRY_ALIAS_PRESETS[ministry];
    }
  });

  it('③ 공통 사전이 마지막이다', () => {
    expect(lookupAlias('내부인건비')).toEqual({
      category: 'personnel',
      source: 'alias-common',
    });
    expect(lookupAlias('없는라벨')).toBeNull();
  });

  it('사전 키는 정규화 형태로 비교한다 — 학습분에 원본 표기를 넣어도 걸린다', () => {
    const context: MatchContext = { draftAliases: { '특수 항목 (Z)': 'promotion' } };
    expect(classifyLabel('특수항목', context).category).toBe('promotion');
    expect(classifyLabel('특수 항목 (Z)', context).category).toBe('promotion');
  });

  it('draft 별칭은 축 라벨·스킵 패턴보다 먼저 평가된다 (I-2가 ②단계이므로)', () => {
    const context: MatchContext = { draftAliases: { '기타항목': 'other' } };
    expect(classifyLabel('기타항목', context).kind).toBe('category');
  });
});

describe('사용자 지정 스킵 패턴 (ImportProfile.skipRowPatterns)', () => {
  it('넘기면 기본 목록을 대체한다', () => {
    const context: MatchContext = { skipPatterns: ['특수합계'] };
    expect(classifyLabel('특수 합계', context).kind).toBe('skip');
    // 기본 목록을 대체했으므로 `직접비`는 더 이상 스킵이 아니다
    expect(classifyLabel('직접비', context).kind).toBe('unknown');
  });
});

describe('findFuzzyCandidate — I-3', () => {
  it('유사도 ≥ 0.8이면 후보를 제시한다 (자동 확정은 하지 않는다)', () => {
    const candidate = findFuzzyCandidate(normalizeLabel('연구활동'));
    expect(candidate?.category).toBe('activity');
    expect(candidate?.similarity).toBeGreaterThanOrEqual(0.8);
  });

  it('임계값 미만이면 null', () => {
    expect(findFuzzyCandidate(normalizeLabel('비'))).toBeNull();
    expect(findFuzzyCandidate('')).toBeNull();
  });

  it('classifyLabel은 퍼지를 쓰지 않는다 — S-12가 S-6 다음에야 퍼지로 내려가기 때문', () => {
    expect(classifyLabel('연구활동').kind).toBe('unknown');
  });
});

describe('isCarryForwardable — S-2\'', () => {
  it('판정에 성공한 값(비목·스킵·축·모호)만 아래 행으로 넘긴다', () => {
    expect(isCarryForwardable('내부인건비 (A)')).toBe(true);
    expect(isCarryForwardable('직접비')).toBe(true);
    expect(isCarryForwardable('현물')).toBe(true);
    expect(isCarryForwardable('연구장비·재료비')).toBe(true);
  });

  it('세로쓰기 조각·괄호 메모·빈 셀은 넘기지 않는다', () => {
    for (const raw of ['직', '접', '비', '(G)', '(간접비 중 연구실 안전관리비)', '']) {
      expect(isCarryForwardable(raw)).toBe(false);
    }
  });
});

describe('isCategoryLabel — S-13 밀도 계산 보조', () => {
  it('비목 판정만 true다', () => {
    expect(isCategoryLabel('연구재료비')).toBe(true);
    expect(isCategoryLabel('직접비')).toBe(false);
    expect(isCategoryLabel('현금')).toBe(false);
  });
});
