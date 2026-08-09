// 부록 C.2 세목 별칭 사전 + 세목 조회 키 파생 + ImportKind 확장 테스트
// (SOT 부록 C.2, 부록 A.5, §5.12.1, §6.11.2 D-2·D-3)
//
// 조회 키가 한 글자라도 어긋나면 산출근거 임포트가 세목을 조용히 놓치고,
// 놓친 세목은 미매핑으로 떨어져 사용자가 매번 손으로 고르게 된다.

import { describe, expect, it } from 'vitest';
import {
  BUDGET_CATEGORY_ORDER,
  SUBCATEGORY_ALIASES,
  SUBCATEGORY_PRESETS,
  stripSubcategoryOrdinal,
  subcategoryLookupKey,
  subcategoryLookupTable,
} from '@/lib/constants';
import { normalizeLabel } from '@/lib/import/normalize';
import { importKindSchema } from '@/lib/db/schema';
import type { ImportKind } from '@/types';

describe('SUBCATEGORY_ALIASES (부록 C.2)', () => {
  it('비목 12종을 빠짐없이 덮는다', () => {
    expect(Object.keys(SUBCATEGORY_ALIASES).sort()).toEqual([...BUDGET_CATEGORY_ORDER].sort());
  });

  it('activity 별칭이 부록 C.2 코드 블록과 키·값까지 같다', () => {
    expect(SUBCATEGORY_ALIASES.activity).toEqual({
      '기타': 'activity_etc',
      '그밖의비용': 'activity_etc',
      '국내출장비': 'activity_travel_dom',
      '국외출장비': 'activity_travel_intl',
      '출장비': 'activity_travel_dom',
      '소프트웨어활용비': 'activity_software',
      '클라우드컴퓨팅서비스이용료': 'activity_cloud',
    });
    expect(Object.keys(SUBCATEGORY_ALIASES.activity)).toHaveLength(7);
  });

  it('별칭은 activity에만 있다 — 나머지 비목은 A.5 라벨의 정규화형으로 충분하다', () => {
    for (const category of BUDGET_CATEGORY_ORDER) {
      if (category === 'activity') continue;
      expect(SUBCATEGORY_ALIASES[category], category).toEqual({});
    }
  });

  it('별칭 키는 이미 정규화형이다 — 다시 정규화해도 그대로여야 조회가 맞는다 (I-1)', () => {
    for (const category of BUDGET_CATEGORY_ORDER) {
      for (const key of Object.keys(SUBCATEGORY_ALIASES[category])) {
        expect(subcategoryLookupKey(key), `${category}.${key}`).toBe(key);
      }
    }
  });

  it('별칭 값은 그 비목의 부록 A.5 세목 코드다 (PL-D4)', () => {
    for (const category of BUDGET_CATEGORY_ORDER) {
      const codes = SUBCATEGORY_PRESETS[category].map((def) => def.code);
      for (const [key, code] of Object.entries(SUBCATEGORY_ALIASES[category])) {
        expect(codes, `${category}.${key}`).toContain(code);
      }
    }
  });
});

// normalizeLabel(I-1)이 무엇을 지우고 무엇을 남기는지 못 박아 둔다.
// 이 전제가 깨지면 stripSubcategoryOrdinal의 존재 이유가 사라지거나 반대로 이중 제거가 된다.
describe('normalizeLabel은 번호를 지우지 않는다', () => {
  it('원문자와 마침표는 남는다', () => {
    expect(normalizeLabel('① 연구시설·장비 구입·설치비')).toBe('①연구시설장비구입설치비');
    expect(normalizeLabel('가. 인력지원비')).toBe('가.인력지원비');
  });

  it('괄호 내용은 지운다 — (삭감) 같은 접미어가 자동으로 흡수된다 (C.2 주의 1)', () => {
    expect(normalizeLabel('⑦ 연구실 운영비(삭감)')).toBe('⑦연구실운영비');
  });
});

describe('stripSubcategoryOrdinal / subcategoryLookupKey', () => {
  it('원문자 번호를 뗀다 (D-3)', () => {
    expect(stripSubcategoryOrdinal('① 연구시설·장비 구입·설치비')).toBe('연구시설·장비 구입·설치비');
    expect(stripSubcategoryOrdinal('⑪ 그 밖의 비용')).toBe('그 밖의 비용');
    expect(stripSubcategoryOrdinal('⑫ 가상의 세목')).toBe('가상의 세목');
  });

  it('한글 순서 접두어를 뗀다 (D-2 — 간접비 세목이 이 형태다)', () => {
    expect(stripSubcategoryOrdinal('가. 인력지원비')).toBe('인력지원비');
    expect(stripSubcategoryOrdinal('다. 성과활용지원비')).toBe('성과활용지원비');
  });

  it('번호가 없는 라벨은 건드리지 않는다', () => {
    expect(stripSubcategoryOrdinal('내부인건비')).toBe('내부인건비');
    // 마침표가 뒤따르지 않는 '가'로 시작하는 낱말을 잘라 먹지 않는다
    expect(stripSubcategoryOrdinal('가족수당')).toBe('가족수당');
  });

  it('부록 A.5 라벨 → 정규화 키', () => {
    expect(subcategoryLookupKey('① 연구시설·장비 구입·설치비')).toBe('연구시설장비구입설치비');
    expect(subcategoryLookupKey('⑩ 클라우드컴퓨팅서비스 이용료')).toBe('클라우드컴퓨팅서비스이용료');
    expect(subcategoryLookupKey('가. 인력지원비')).toBe('인력지원비');
    expect(subcategoryLookupKey(null)).toBe('');
  });
});

describe('subcategoryLookupTable', () => {
  it('프리셋 라벨 파생 키로 세목 코드를 찾는다', () => {
    const facility = subcategoryLookupTable('facility_equipment');
    expect(facility['연구시설장비구입설치비']).toBe('facility_purchase');
    expect(facility['연구시설장비임차비']).toBe('facility_lease');
    expect(facility['연구시설장비운영유지비']).toBe('facility_maintain');
    expect(facility['연구인프라조성비']).toBe('facility_infra');
  });

  it('간접비 세목은 한글 접두어를 뗀 키로 들어간다', () => {
    const indirect = subcategoryLookupTable('indirect');
    expect(indirect).toEqual({
      '인력지원비': 'indirect_hr',
      '연구지원비': 'indirect_support',
      '성과활용지원비': 'indirect_outcome',
    });
  });

  it('모든 비목의 프리셋 세목이 조회표에 하나도 빠짐없이 들어간다', () => {
    for (const category of BUDGET_CATEGORY_ORDER) {
      const table = subcategoryLookupTable(category);
      for (const def of SUBCATEGORY_PRESETS[category]) {
        expect(table[subcategoryLookupKey(def.label)], `${category}.${def.code}`).toBe(def.code);
      }
    }
  });

  it('별칭이 조회표에 합쳐진다', () => {
    const activity = subcategoryLookupTable('activity');
    for (const [key, code] of Object.entries(SUBCATEGORY_ALIASES.activity)) {
      expect(activity[key], key).toBe(code);
    }
  });

  it('같은 비목 안에서 키가 두 세목을 가리키지 않는다 — 프리셋 파생 ∪ 별칭', () => {
    for (const category of BUDGET_CATEGORY_ORDER) {
      const derived = new Map<string, string>();
      for (const def of SUBCATEGORY_PRESETS[category]) {
        const key = subcategoryLookupKey(def.label);
        expect(derived.has(key), `${category}: 프리셋 라벨 키 충돌 ${key}`).toBe(false);
        derived.set(key, def.code);
      }
      for (const [key, code] of Object.entries(SUBCATEGORY_ALIASES[category])) {
        const existing = derived.get(key);
        // 별칭이 프리셋 파생 키를 덮는다면 같은 코드여야 한다 (덮어쓰기가 곧 오적재다)
        if (existing !== undefined) expect(existing, `${category}.${key}`).toBe(code);
      }
      // 조회표 크기 = 파생 키 ∪ 별칭 키
      const union = new Set([...derived.keys(), ...Object.keys(SUBCATEGORY_ALIASES[category])]);
      expect(Object.keys(subcategoryLookupTable(category)).length, category).toBe(union.size);
    }
  });

  it('호출자가 반환값을 고쳐도 다음 호출이 오염되지 않는다', () => {
    const first = subcategoryLookupTable('activity');
    first['회의비'] = 'activity_etc';
    expect(subcategoryLookupTable('activity')['회의비']).toBe('activity_meeting');
  });
});

// 실측 변형 (C.2 주의 1·2, D-3). 파서가 세목 헤더 원문을 그대로 넘긴다고 보고 검증한다
describe('실측 세목 헤더 변형 해석', () => {
  const activity = subcategoryLookupTable('activity');
  const lookup = (header: string) => activity[subcategoryLookupKey(header)];

  it('⑪ 그 밖의 비용(산자부) · ⑪ 기타(행안부)가 같은 세목으로 간다', () => {
    expect(lookup('⑪ 그 밖의 비용')).toBe('activity_etc');
    expect(lookup('⑪ 기타')).toBe('activity_etc');
  });

  it('⑦ 연구실 운영비(삭감)의 괄호 접미어는 I-1이 흡수한다', () => {
    expect(lookup('⑦ 연구실 운영비(삭감)')).toBe('activity_lab_ops');
    expect(lookup('⑦ 연구실 운영비')).toBe('activity_lab_ops');
  });

  it('국내/국외 출장비를 가른다 — 번호 ⑤ 하나가 표 둘을 덮는다 (C.2 주의 2)', () => {
    expect(lookup('⑤ 국내출장비')).toBe('activity_travel_dom');
    expect(lookup('국내출장비')).toBe('activity_travel_dom');
    expect(lookup('⑤ 국외출장비')).toBe('activity_travel_intl');
    expect(lookup('국외출장비')).toBe('activity_travel_intl');
    // 가르지 못하는 `⑤ 출장비`는 국내로 제안한다 — 조용히 합치지 않고 사용자가 고친다
    expect(lookup('⑤ 출장비')).toBe('activity_travel_dom');
  });

  it('⑥ 소프트웨어 활용비 · ⑩ 클라우드컴퓨팅서비스 이용료', () => {
    expect(lookup('⑥ 소프트웨어 활용비')).toBe('activity_software');
    expect(lookup('⑩ 클라우드컴퓨팅서비스 이용료')).toBe('activity_cloud');
  });

  it('모르는 라벨은 undefined다 — 임의로 붙이지 않는다 (I-4로 내려간다)', () => {
    expect(lookup('⑬ 정체불명비')).toBeUndefined();
  });
});

describe('ImportKind (§5.12.1)', () => {
  it('두 값이 Zod를 통과한다', () => {
    const kinds: ImportKind[] = ['budget_plan', 'budget_detail'];
    for (const kind of kinds) {
      expect(importKindSchema.parse(kind)).toBe(kind);
    }
    expect(importKindSchema.options).toEqual(['budget_plan', 'budget_detail']);
  });

  it('집행내역 임포트는 여전히 제외다 (§13 12-a)', () => {
    expect(importKindSchema.safeParse('execution').success).toBe(false);
  });
});
