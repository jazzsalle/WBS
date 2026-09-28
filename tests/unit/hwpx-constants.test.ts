// 부록 C.3 상수 테스트 (SOT §6.18, 부록 C.3.1~C.3.6, phase-22-plan S-7·U-3·U-6·U-7)
// 표 행 수·순서를 고정한다 — SOT 표를 고치면 여기와 lib/constants.ts를 함께 고친다.
// 판정은 lib/hwpx/rows.ts의 실제 함수로 기대값을 검증한다.

import { describe, expect, it } from 'vitest';
import {
  HWPX_BASIS_RATIONALE_MARKER,
  HWPX_DELIVERABLE_COLUMN_ROLES,
  HWPX_DELIVERABLE_EXCLUDE_NAME_KEYWORDS,
  HWPX_DELIVERABLE_EXCLUDE_UNITS,
  HWPX_DELIVERABLE_TYPE_RULES,
  HWPX_MEASURE_METHOD_RULES,
  HWPX_METHOD_COLUMN_ROLES,
  HWPX_TABLE_SIGNATURES,
  HWPX_TECH_COLUMN_ROLES,
  HWPX_TIME_UNITS,
  HWPX_YEAR_COLUMN_PATTERN,
} from '@/lib/constants';
import { GOAL_FORM_ISSUES } from '@/lib/goal-form/parse';
import { deliverableTypeOf, isExcludedDeliverable, isTimeUnit, measureMethodOf } from '@/lib/hwpx/rows';
import { normalizeLabel } from '@/lib/import/normalize';

// 판정 함수는 lib/hwpx/rows.ts의 실제 구현이다(T6) — 이름만 이 파일의 옛 로컬 헬퍼에 맞춘다
const typeOf = deliverableTypeOf;
const methodOf = measureMethodOf;
const isExcluded = isExcludedDeliverable;

describe('C.3.1 헤더 서명', () => {
  it('SOT 표와 1:1', () => {
    expect(HWPX_TABLE_SIGNATURES).toEqual({
      tech: [
        { keyword: '평가항목', aliases: [] },
        { keyword: '단위', aliases: [] },
        { keyword: '비중', aliases: ['전체항목에서차지하는비중'] },
        { keyword: '세계최고', aliases: [] },
        { keyword: '국내수준', aliases: ['연구개발전국내수준'] },
        { keyword: '개발목표치', aliases: [] },
      ],
      deliverable: [
        { keyword: '항목', aliases: [] },
        { keyword: '단위', aliases: [] },
        { keyword: '가중치', aliases: [] },
        { keyword: '개발목표치', aliases: ['목표치'] },
        { keyword: '평가방법', aliases: [] },
      ],
      method: [
        { keyword: '순번', aliases: [] },
        { keyword: '평가항목', aliases: ['성능지표'] },
        { keyword: '평가방법', aliases: [] },
        { keyword: '평가환경', aliases: [] },
      ],
    });
  });

  it('키워드·별칭은 I-1 정규화해도 그대로다 — 정규화형 비교에서 어긋나지 않는다', () => {
    for (const defs of Object.values(HWPX_TABLE_SIGNATURES)) {
      for (const { keyword, aliases } of defs) {
        expect(normalizeLabel(keyword)).toBe(keyword);
        for (const alias of aliases) expect(normalizeLabel(alias)).toBe(alias);
      }
    }
  });
});

describe('C.3.2 성과목표 유형 규칙', () => {
  it('SOT 표 순서 그대로 12행, 비SCI가 SCI 위(S-7)', () => {
    expect(HWPX_DELIVERABLE_TYPE_RULES.map((r) => r.type)).toEqual([
      'paper_domestic',
      'paper_sci',
      'conference',
      'patent_dom_reg',
      'patent_dom_apply',
      'patent_intl_reg',
      'patent_intl_apply',
      'sw_registration',
      'tech_transfer',
      'commercialization',
      'standard',
      'hr_training',
    ]);
  });

  it('키워드가 SOT와 같다', () => {
    expect(HWPX_DELIVERABLE_TYPE_RULES.map((r) => [r.anyOf, r.exclude])).toEqual([
      [[['비SCI'], ['국내논문'], ['국내학술지']], []],
      [[['SCI', '게재']], ['Impact Factor']],
      [[['학술대회'], ['학회발표']], []],
      [[['특허국내등록'], ['국내특허등록']], []],
      [[['특허국내출원'], ['국내특허출원']], []],
      [[['특허국외등록'], ['해외특허등록'], ['국제특허등록']], []],
      [[['특허국외출원'], ['해외특허출원'], ['PCT']], []],
      [[['소프트웨어등록'], ['SW등록'], ['프로그램등록']], []],
      [[['기술이전'], ['기술료']], []],
      [[['상용화'], ['시제품'], ['사업화'], ['매출']], []],
      [[['표준']], []],
      [[['인력양성'], ['고용창출'], ['교육프로그램'], ['학위']], []],
    ]);
  });

  // U-6 지표명 11개 → C.3.2 실측 표
  it.each([
    ['고용창출 효과', 'hr_training'],
    ['특허 국내출원 건수', 'patent_dom_apply'],
    ['특허 국내등록 건수', 'patent_dom_reg'],
    ['특허 국외출원 건수', 'patent_intl_apply'],
    ['특허 국외등록 건수', 'patent_intl_reg'],
    ['소프트웨어 등록', 'sw_registration'],
    ['비상교육 프로그램', 'hr_training'],
    ['SCI급 게재논문 게재', 'paper_sci'],
    ['비SCI급 게재논문', 'paper_domestic'],
    ['학술대회', 'conference'],
    ['시제품', 'commercialization'],
  ] as const)('실측 %s → %s', (name, type) => {
    expect(typeOf(name)).toBe(type);
    expect(isExcluded(name, '건')).toBe(false);
  });

  it('SCI는 게재가 있어야 하고 Impact Factor면 건너뛴다', () => {
    expect(typeOf('SCI급 논문')).toBe('other');
    expect(typeOf('SCI 게재 Impact Factor 평균')).toBe('other');
  });

  it('어느 규칙에도 안 맞으면 other', () => {
    expect(typeOf('기타 성과')).toBe('other');
  });
});

describe('C.3.2 반영 제외 (U-7)', () => {
  it('상수가 SOT와 같다', () => {
    expect(HWPX_DELIVERABLE_EXCLUDE_NAME_KEYWORDS).toEqual(['SMART', 'Impact Factor']);
    expect(HWPX_DELIVERABLE_EXCLUDE_UNITS).toEqual(['점수']);
  });

  it('SMART 평균·Impact Factor 평균·단위 점수만 제외', () => {
    expect(isExcluded('SMART 평균', '점')).toBe(true);
    expect(isExcluded('Impact Factor 평균', '')).toBe(true);
    expect(isExcluded('어떤 지표', '점수')).toBe(true);
    // 목표가 전부 `-`여도 제외 대상이 아니다 — 이름·단위만 본다
    expect(isExcluded('특허 국외등록 건수', '건')).toBe(false);
  });
});

describe('C.3.3 평가방법 → measureMethod', () => {
  it('SOT 표 순서·키워드 그대로', () => {
    expect(HWPX_MEASURE_METHOD_RULES).toEqual([
      { method: 'certified_lab', keywords: ['공인기관', '시험성적', '시험평가', '인증'] },
      { method: 'expert_review', keywords: ['전문가', '협의체', '자문'] },
      { method: 'customer', keywords: ['수요기업', '고객', '사용자평가'] },
      { method: 'self', keywords: ['자체'] },
    ]);
  });

  it.each([
    ['공인기관 시험성적서', 'certified_lab'],
    ['전문가 평가', 'expert_review'],
    ['수요기업 사용자 평가', 'customer'],
    ['자체 평가', 'self'],
    ['', 'self'],
    ['시뮬레이션', 'other'],
  ] as const)('%j → %s', (raw, method) => {
    expect(methodOf(raw)).toBe(method);
  });
});

describe('C.3.5 열 역할', () => {
  it('기술목표 6역할 + 연차 + 읽지 않음', () => {
    expect(HWPX_TECH_COLUMN_ROLES).toEqual([
      { role: 'name', labels: ['평가항목'] },
      { role: 'unit', labels: ['단위'] },
      { role: 'weight', labels: ['비중', '전체항목에서차지하는비중'] },
      { role: 'year', labels: [] },
      { role: 'measureMethod', labels: ['평가방법'] },
      { role: 'org', labels: ['담당기관', '담당연구개발기관'] },
      { role: 'ignored', labels: ['세계최고', '국내수준', '표준', '인증', '기준설정근거'] },
    ]);
  });

  it('성과목표 7역할', () => {
    expect(HWPX_DELIVERABLE_COLUMN_ROLES).toEqual([
      { role: 'category', labels: ['구분'] },
      { role: 'item', labels: ['항목'] },
      { role: 'unit', labels: ['단위'] },
      { role: 'weight', labels: ['가중치'] },
      { role: 'year', labels: [] },
      { role: 'total', labels: ['계'] },
      { role: 'evidenceMethod', labels: ['평가방법'] },
    ]);
  });

  it('평가방법 4역할', () => {
    expect(HWPX_METHOD_COLUMN_ROLES).toEqual([
      { role: 'seq', labels: ['순번'] },
      { role: 'name', labels: ['평가항목', '성능지표'] },
      { role: 'measureDescription', labels: ['평가방법'] },
      { role: 'evaluationEnvironment', labels: ['평가환경'] },
    ]);
  });

  it('연차 열은 정규화 후 N차년도', () => {
    expect(HWPX_YEAR_COLUMN_PATTERN.exec(normalizeLabel('1차년도'))?.[1]).toBe('1');
    expect(HWPX_YEAR_COLUMN_PATTERN.exec(normalizeLabel('3차 년도 (2028)'))?.[1]).toBe('3');
    expect(HWPX_YEAR_COLUMN_PATTERN.test(normalizeLabel('개발목표치'))).toBe(false);
  });

  it('평가환경 버림 표식', () => {
    expect(HWPX_BASIS_RATIONALE_MARKER).toBe('[기준설정 근거]');
  });
});

describe('C.3.6 시간 단위', () => {
  it('SOT 목록 그대로', () => {
    expect(HWPX_TIME_UNITS).toEqual(['초', 's', 'sec', 'ms', '분', 'min', '시간', 'hr']);
  });

  it.each(['초', 'S', ' sec ', 'ms', '분', 'Min', '시간', 'hr'])('%j → 시간 단위', (unit) => {
    expect(isTimeUnit(unit)).toBe(true);
  });

  // 완전 일치만 — 부분 문자열(`ms`의 `s`, `mm`)로 잡히면 안 된다
  it.each(['%', 'mm', 'fps', 'ms/frame', '초당', 'm/s', ''])('%j → 시간 단위 아님', (unit) => {
    expect(isTimeUnit(unit)).toBe(false);
  });
});

describe('GOAL_FORM_ISSUES — hwpx 행 사유', () => {
  it('4종 추가, blocking 값', () => {
    expect(GOAL_FORM_ISSUES['ambiguous-match'].blocking).toBe(true);
    expect(GOAL_FORM_ISSUES['duplicate-plan-name'].blocking).toBe(true);
    expect(GOAL_FORM_ISSUES['org-unmatched'].blocking).toBe(false);
    expect(GOAL_FORM_ISSUES['method-other'].blocking).toBe(false);
  });

  it('direction-default는 없다 (U-3)', () => {
    expect('direction-default' in GOAL_FORM_ISSUES).toBe(false);
  });
});
