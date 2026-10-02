// 부록 C.4 붙임4 양식 행 대응표 상수 (SOT §6.19 AG-3, §5.21 AV-7, Phase 25 계획서 S-5·S-22)
// 상수가 부록 A.1 비목·A.5 세목만 가리키는지, 12비목이 data 행 또는 "양식에 없는 비목" 중
// 정확히 한 곳에 들어가는지(C.4.1 판정 세부 ⑤), 실측 라벨이 행 식별 키로 정규화되는지 본다.

import { describe, expect, it } from 'vitest';
import {
  ATTACHMENT4_FORM_ROWS,
  ATTACHMENT4_OUTSIDE_CATEGORIES,
  ATTACHMENT8_1_COLUMNS,
  BUDGET_CATEGORY_ORDER,
  DEFAULT_SUBCATEGORY_CODE,
  SUBCATEGORY_PRESETS,
  attachment4LabelKey,
} from '@/lib/constants';
import { normalizeLabel } from '@/lib/import/normalize';
import type { Attachment4RowKind, BudgetCategory } from '@/types';

const row = (id: string) => {
  const found = ATTACHMENT4_FORM_ROWS.find((r) => r.id === id);
  if (!found) throw new Error(`행 없음: ${id}`);
  return found;
};

const presetCodes = (category: BudgetCategory) => SUBCATEGORY_PRESETS[category].map((d) => d.code);

describe('C.4.1 8-2 행 순서·종류', () => {
  it('행 순서가 부록 C.4.1 표 순서와 같다', () => {
    expect(ATTACHMENT4_FORM_ROWS.map((r) => r.id)).toEqual([
      'personnel_internal',
      'personnel_external',
      'personnel_support',
      'personnel_subtotal',
      'student_general',
      'student_managed',
      'total_personnel',
      'modified_personnel',
      'facility_equipment',
      'facility_integrated_mgmt',
      'material',
      'activity',
      'allowance',
      'allowance_ratio',
      'outside',
      'direct_subtotal',
      'indirect',
      'lab_safety',
      'indirect_ratio',
      'total',
      'personnel_ratio',
    ]);
  });

  it('행 id가 겹치지 않는다', () => {
    const ids = ATTACHMENT4_FORM_ROWS.map((r) => r.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('종류 5종이 전부 쓰이고 행마다 C.4의 종류다', () => {
    const kinds: Record<string, Attachment4RowKind> = Object.fromEntries(
      ATTACHMENT4_FORM_ROWS.map((r) => [r.id, r.kind]),
    );
    expect(kinds).toEqual({
      personnel_internal: 'data',
      personnel_external: 'data',
      personnel_support: 'data',
      personnel_subtotal: 'aggregate',
      student_general: 'data',
      student_managed: 'data',
      total_personnel: 'aggregate',
      modified_personnel: 'aggregate',
      facility_equipment: 'data',
      facility_integrated_mgmt: 'ignored',
      material: 'data',
      activity: 'data',
      allowance: 'data',
      allowance_ratio: 'ratio',
      outside: 'data',
      direct_subtotal: 'aggregate',
      indirect: 'data',
      lab_safety: 'memo',
      indirect_ratio: 'ratio',
      total: 'aggregate',
      personnel_ratio: 'ratio',
    });
    expect(new Set(Object.values(kinds))).toEqual(new Set(['data', 'aggregate', 'ratio', 'memo', 'ignored']));
  });

  it('양식 기호: 양식 E1 = 총 인건비, 양식 E2 = 수정인건비 — 라벨에 "양식"이 붙는다', () => {
    expect(row('total_personnel')).toMatchObject({ symbol: 'E1', label: '양식 E1(총 인건비)' });
    expect(row('modified_personnel')).toMatchObject({ symbol: 'E2', label: '양식 E2(수정인건비)' });
    expect(ATTACHMENT4_FORM_ROWS.map((r) => r.symbol).filter((s) => s !== null)).toEqual([
      'A', 'B', 'C', 'D', 'D', 'E1', 'E2', 'F', 'G', 'H', 'I', 'K', 'L', 'M',
    ]);
  });
});

describe('C.4.1 소스·가져오기 대상은 부록 A.1·A.5 코드만 가리킨다', () => {
  it('보기 소스의 비목은 A.1, 세목은 A.5 그 비목 코드 또는 default', () => {
    for (const r of ATTACHMENT4_FORM_ROWS) {
      for (const source of r.sources) {
        expect(BUDGET_CATEGORY_ORDER, r.id).toContain(source.category);
        if (source.subcategoryCodes !== 'all') {
          expect(source.subcategoryCodes.length, r.id).toBeGreaterThan(0);
          for (const code of source.subcategoryCodes) {
            expect([...presetCodes(source.category), DEFAULT_SUBCATEGORY_CODE], `${r.id}/${code}`).toContain(code);
          }
        }
      }
    }
  });

  it('가져오기 대상은 A.1 비목 + (A.5 그 비목 코드 또는 default)', () => {
    for (const r of ATTACHMENT4_FORM_ROWS) {
      if (r.importTarget === null) continue;
      const { category, subcategoryCode } = r.importTarget;
      expect(BUDGET_CATEGORY_ORDER, r.id).toContain(category);
      expect([...presetCodes(category), DEFAULT_SUBCATEGORY_CODE], r.id).toContain(subcategoryCode);
    }
  });

  it('가져오기 대상: 인건비 A~D는 세목, 나머지는 default (S-5)', () => {
    const targets = Object.fromEntries(
      ATTACHMENT4_FORM_ROWS.filter((r) => r.importTarget !== null).map((r) => [r.id, r.importTarget]),
    );
    expect(targets).toEqual({
      personnel_internal: { category: 'personnel', subcategoryCode: 'personnel_internal' },
      personnel_external: { category: 'personnel', subcategoryCode: 'personnel_external' },
      personnel_support: { category: 'personnel', subcategoryCode: 'personnel_support' },
      student_general: { category: 'student_personnel', subcategoryCode: 'student_general' },
      student_managed: { category: 'student_personnel', subcategoryCode: 'student_managed' },
      facility_equipment: { category: 'facility_equipment', subcategoryCode: 'default' },
      material: { category: 'material', subcategoryCode: 'default' },
      activity: { category: 'activity', subcategoryCode: 'default' },
      allowance: { category: 'allowance', subcategoryCode: 'default' },
      indirect: { category: 'indirect', subcategoryCode: 'default' },
    });
  });

  it('data가 아닌 행은 소스·가져오기 대상이 없다 — 연구실 안전관리비는 소스 없음(U-3)', () => {
    for (const r of ATTACHMENT4_FORM_ROWS.filter((x) => x.kind !== 'data')) {
      expect(r.sources, r.id).toEqual([]);
      expect(r.importTarget, r.id).toBeNull();
      expect(r.axes, r.id).toBeNull();
    }
  });

  it('양식에 없는 비목 행: 4종 전 세목, 식별 라벨·가져오기 대상 없음(U-2)', () => {
    expect(ATTACHMENT4_OUTSIDE_CATEGORIES).toEqual(['consignment', 'international', 'burden', 'other']);
    const outside = row('outside');
    expect(outside.match).toEqual([]);
    expect(outside.importTarget).toBeNull();
    expect(outside.sources).toEqual(
      ATTACHMENT4_OUTSIDE_CATEGORIES.map((category) => ({ category, subcategoryCodes: 'all' })),
    );
  });

  it('H 연구활동비 = activity 전 세목 + promotion (U-1)', () => {
    expect(row('activity').sources).toEqual([
      { category: 'activity', subcategoryCodes: 'all' },
      { category: 'promotion', subcategoryCodes: 'all' },
    ]);
  });
});

describe('C.4.1 판정 세부 ⑤ — 12비목은 data 행 또는 "양식에 없는 비목" 중 한 곳에만', () => {
  // (비목, 세목) 하나를 덮는 data 행 id 목록
  const coveringRows = (category: BudgetCategory, code: string) =>
    ATTACHMENT4_FORM_ROWS.filter((r) => r.kind === 'data').filter((r) =>
      r.sources.some(
        (s) => s.category === category && (s.subcategoryCodes === 'all' || s.subcategoryCodes.includes(code)),
      ),
    ).map((r) => r.id);

  it('12비목 각각이 data 행 소스에 나온다', () => {
    expect(BUDGET_CATEGORY_ORDER).toHaveLength(12);
    for (const category of BUDGET_CATEGORY_ORDER) {
      const rows = ATTACHMENT4_FORM_ROWS.filter((r) => r.kind === 'data' && r.sources.some((s) => s.category === category));
      expect(rows.length, category).toBeGreaterThan(0);
    }
  });

  it('A.5 세목마다 덮는 data 행이 정확히 하나', () => {
    for (const category of BUDGET_CATEGORY_ORDER) {
      for (const code of presetCodes(category)) {
        expect(coveringRows(category, code), `${category}/${code}`).toHaveLength(1);
      }
    }
  });

  it('세목 미지정(default) 인건비는 A, 학생인건비는 D 일반이 덮는다', () => {
    expect(coveringRows('personnel', DEFAULT_SUBCATEGORY_CODE)).toEqual(['personnel_internal']);
    expect(coveringRows('student_personnel', DEFAULT_SUBCATEGORY_CODE)).toEqual(['student_general']);
  });

  it('12비목 모두 default 줄을 정확히 한 data 행이 덮는다', () => {
    for (const category of BUDGET_CATEGORY_ORDER) {
      expect(coveringRows(category, DEFAULT_SUBCATEGORY_CODE), category).toHaveLength(1);
    }
  });

  it('비목 전체를 받는 행은 default 줄도 한 곳에서 덮는다', () => {
    const wholeCategories = ATTACHMENT4_FORM_ROWS.flatMap((r) =>
      r.sources.filter((s) => s.subcategoryCodes === 'all').map((s) => s.category),
    );
    expect(new Set(wholeCategories).size).toBe(wholeCategories.length);
    for (const category of wholeCategories) {
      expect(coveringRows(category, DEFAULT_SUBCATEGORY_CODE), category).toHaveLength(1);
    }
  });

  it('양식 밖 4종은 "양식에 없는 비목" 행에만, 나머지 8종은 그 행에 없다', () => {
    for (const category of BUDGET_CATEGORY_ORDER) {
      const inOutside = row('outside').sources.some((s) => s.category === category);
      expect(inOutside, category).toBe((ATTACHMENT4_OUTSIDE_CATEGORIES as readonly string[]).includes(category));
    }
  });
});

describe('C.4.1 행 식별 — 실측 라벨 → 정규형', () => {
  it('split 행은 현금·현물, combined 행은 축 없음, D는 일반·통합관리', () => {
    for (const r of ATTACHMENT4_FORM_ROWS) {
      if (r.axes === 'split') {
        expect(r.match.map((m) => [m.subKey, m.axis]), r.id).toEqual([['현금', 'cash'], ['현물', 'in_kind']]);
      } else {
        for (const m of r.match) expect(m.axis, r.id).toBeNull();
      }
    }
    expect(row('student_general').match).toEqual([{ itemKey: '학생인건비', subKey: '일반', axis: null }]);
    expect(row('student_managed').match).toEqual([{ itemKey: '학생인건비', subKey: '통합관리', axis: null }]);
  });

  it('(itemKey, subKey) 조합이 행 사이에 겹치지 않는다', () => {
    const keys = ATTACHMENT4_FORM_ROWS.flatMap((r) => r.match.map((m) => `${m.itemKey}|${m.subKey ?? ''}`));
    expect(new Set(keys).size).toBe(keys.length);
  });

  // 실측 양식(samples/붙임4*.xlsx 8-2 기관 블록)의 라벨 원문 — 금액·기관명 없음
  const samples: [string, string | null, string][] = [
    ['내부인건비(A)', '현금(N)', 'personnel_internal'],
    ['내부인건비(A)', '현물', 'personnel_internal'],
    ['외부인건비(B)', '현금(O)', 'personnel_external'],
    ['연구지원인력인건비(C)', null, 'personnel_support'],
    ['소계', null, 'personnel_subtotal'],
    ['학생 인건비(D)', '일반', 'student_general'],
    ['학생 인건비(D)', '통합관리', 'student_managed'],
    ['총 인건비(E1=A+B+C+D)', null, 'total_personnel'],
    ['수정인건비(E2=A+B+D)', null, 'modified_personnel'],
    ['연구시설‧장비비(F)', '현금(P)', 'facility_equipment'],
    ['(연구시설‧장비비 중 통합관리비(현금))', null, 'facility_integrated_mgmt'],
    ['연구재료비(G)', '현금(Q)', 'material'],
    ['연구활동비(H)', '현물', 'activity'],
    ['연구수당(I)', null, 'allowance'],
    ['연구수당 비율(I/E2)', null, 'allowance_ratio'],
    ['직접비 소계(K=E1+F+G+H+I)', null, 'direct_subtotal'],
    ['간접비(L)', null, 'indirect'],
    ['(간접비 중 연구실 안전관리비)', null, 'lab_safety'],
    ['간접비 비율(L/(N+O+C+D+P+Q+R+I))', null, 'indirect_ratio'],
    ['연구개발비 총액(M=K+L)', null, 'total'],
    ['인건비 비율(E1/M)', null, 'personnel_ratio'],
  ];

  it.each(samples)('%s / %s → %s', (item, sub, expectedId) => {
    const itemKey = attachment4LabelKey(item);
    const subKey = sub === null ? null : attachment4LabelKey(sub);
    const hits = ATTACHMENT4_FORM_ROWS.filter((r) => r.match.some((m) => m.itemKey === itemKey && m.subKey === subKey));
    expect(hits.map((r) => r.id)).toEqual([expectedId]);
  });

  it('괄호로 감싼 내역 행은 괄호를 남긴다 — I-1이면 빈 문자열이 된다', () => {
    expect(normalizeLabel('(간접비 중 연구실 안전관리비)')).toBe('');
    expect(attachment4LabelKey('(간접비 중 연구실 안전관리비)')).toBe('(간접비중연구실안전관리비)');
    expect(attachment4LabelKey(' ( 간접비 중\n연구실 안전관리비 ) ')).toBe('(간접비중연구실안전관리비)');
    expect(attachment4LabelKey(null)).toBe('');
  });
});

describe('C.4.2 8-1 열', () => {
  it('열 순서·id가 C.4.2와 같다', () => {
    expect(ATTACHMENT8_1_COLUMNS.map((c) => c.id)).toEqual([
      'org', 'company_type',
      'gov_cash',
      'own_cash', 'own_in_kind', 'own_subtotal',
      'other_cash', 'other_in_kind', 'other_subtotal',
      'total_cash', 'total_in_kind', 'total',
      'gov_share_review', 'own_cash_review',
    ]);
  });

  it('정규형 키는 실측 머리의 I-1 정규화와 같고 (groupKey, labelKey)가 겹치지 않는다', () => {
    for (const c of ATTACHMENT8_1_COLUMNS) {
      expect(c.labelKey, c.id).toBe(normalizeLabel(c.label));
      expect(c.groupKey, c.id).toBe(c.groupLabel === null ? null : normalizeLabel(c.groupLabel));
    }
    const keys = ATTACHMENT8_1_COLUMNS.map((c) => `${c.groupKey}|${c.labelKey}`);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('정부지원 현금 A만 버전 정부지원 현금으로 가고, 그 외 기관 지원금은 경고, 기업유형·검토사항은 읽지 않는다', () => {
    const uses = Object.fromEntries(ATTACHMENT8_1_COLUMNS.map((c) => [c.id, c.importUse]));
    expect(uses).toEqual({
      org: 'match_org',
      company_type: 'ignore',
      gov_cash: 'gov_cash',
      own_cash: 'reconcile',
      own_in_kind: 'reconcile',
      own_subtotal: 'reconcile',
      other_cash: 'warn_nonzero',
      other_in_kind: 'warn_nonzero',
      other_subtotal: 'warn_nonzero',
      total_cash: 'reconcile',
      total_in_kind: 'reconcile',
      total: 'reconcile',
      gov_share_review: 'ignore',
      own_cash_review: 'ignore',
    });
  });

  it('실측 줄바꿈 머리도 같은 키가 된다', () => {
    expect(normalizeLabel('연구개발\n기관')).toBe('연구개발기관');
    expect(normalizeLabel('현금\n(A+B+E)')).toBe('현금');
    expect(normalizeLabel('합계\n(H)')).toBe('합계');
    expect(normalizeLabel('합 계')).toBe('합계');
  });
});
