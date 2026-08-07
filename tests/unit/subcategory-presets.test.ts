// 세목 프리셋 + Phase 9 라벨 맵 테스트 (SOT 부록 A.5, 부록 A.4, §5.17 PL-D3)
// 프리셋이 틀리면 산출근거의 세목이 갈라져 §6.10.2 소계가 어긋난다.

import { describe, expect, it } from 'vitest';
import {
  BUDGET_CATEGORY_ORDER,
  DETAIL_AXIS_LABELS,
  DETAIL_FORMULA_LABELS,
  HIRE_TYPE_LABELS,
  SUBCATEGORY_PRESETS,
} from '@/lib/constants';
import type { BudgetCategory, DetailAxis, DetailFormula, HireType } from '@/types';

// PL-D3: 이 두 비목만 인건비 산식이다
const PERSONNEL_CATEGORIES: BudgetCategory[] = ['personnel', 'student_personnel'];

// 부록 A.5 표의 행 수. 표를 늘리면 이 숫자도 함께 고친다
const PRESET_ROW_COUNT = 33;

describe('SUBCATEGORY_PRESETS', () => {
  it('비목 12종을 빠짐없이 덮는다', () => {
    expect(Object.keys(SUBCATEGORY_PRESETS).sort()).toEqual([...BUDGET_CATEGORY_ORDER].sort());
  });

  it('세목이 하나도 없는 비목은 없다 — 서식에 세목 구분이 없으면 default 한 줄을 둔다', () => {
    for (const category of BUDGET_CATEGORY_ORDER) {
      expect(SUBCATEGORY_PRESETS[category].length, category).toBeGreaterThan(0);
    }
  });

  it('세목 코드 총 개수가 부록 A.5 표와 일치한다', () => {
    const total = BUDGET_CATEGORY_ORDER.reduce(
      (sum, category) => sum + SUBCATEGORY_PRESETS[category].length,
      0
    );
    expect(total).toBe(PRESET_ROW_COUNT);
  });

  it('비목별 세목 수가 부록 A.5 표와 일치한다', () => {
    const counts: Record<BudgetCategory, number> = {
      personnel: 3,
      student_personnel: 2,
      facility_equipment: 4,
      material: 3,
      consignment: 1,
      international: 1,
      burden: 1,
      activity: 12,
      promotion: 1,
      allowance: 1,
      indirect: 3,
      other: 1,
    };
    for (const category of BUDGET_CATEGORY_ORDER) {
      expect(SUBCATEGORY_PRESETS[category].length, category).toBe(counts[category]);
    }
  });

  it('PL-D3: 인건비·학생인건비의 세목만 personnel 산식이고 나머지는 전부 quantity다', () => {
    for (const category of BUDGET_CATEGORY_ORDER) {
      const expected: DetailFormula = PERSONNEL_CATEGORIES.includes(category)
        ? 'personnel'
        : 'quantity';
      for (const def of SUBCATEGORY_PRESETS[category]) {
        expect(def.formula, `${category}.${def.code}`).toBe(expected);
      }
    }
  });

  it('같은 비목 안에서 세목 코드가 중복되지 않는다', () => {
    for (const category of BUDGET_CATEGORY_ORDER) {
      const codes = SUBCATEGORY_PRESETS[category].map((def) => def.code);
      expect(new Set(codes).size, category).toBe(codes.length);
    }
  });

  it('코드·표시명이 비어 있는 세목이 없다', () => {
    for (const category of BUDGET_CATEGORY_ORDER) {
      for (const def of SUBCATEGORY_PRESETS[category]) {
        expect(def.code.length, category).toBeGreaterThan(0);
        expect(def.label.length, `${category}.${def.code}`).toBeGreaterThan(0);
      }
    }
  });

  it('인건비 산식 세목의 기본 인자는 참여율(%)·참여기간(월)이고 참여율만 isPercent다 (PL-1)', () => {
    for (const category of PERSONNEL_CATEGORIES) {
      for (const def of SUBCATEGORY_PRESETS[category]) {
        expect(def.defaultFactors.map((f) => f.label), `${category}.${def.code}`).toEqual([
          '참여율(%)',
          '참여기간(월)',
        ]);
        expect(def.defaultFactors.map((f) => f.isPercent)).toEqual([true, false]);
      }
    }
  });

  it('quantity 세목의 기본 인자에는 % 인자가 없다 — 단가에 곱해지는 수량이다 (주의 1)', () => {
    for (const category of BUDGET_CATEGORY_ORDER) {
      if (PERSONNEL_CATEGORIES.includes(category)) continue;
      for (const def of SUBCATEGORY_PRESETS[category]) {
        expect(def.defaultFactors.some((f) => f.isPercent), `${category}.${def.code}`).toBe(false);
        // PL-3: 인자는 최대 3개
        expect(def.defaultFactors.length, `${category}.${def.code}`).toBeLessThanOrEqual(3);
      }
    }
  });

  it('세목 구분이 없는 비목은 default 코드 하나만 갖는다 (주의 3)', () => {
    for (const category of ['allowance', 'burden', 'consignment', 'international', 'promotion', 'other'] as const) {
      expect(SUBCATEGORY_PRESETS[category].map((def) => def.code), category).toEqual(['default']);
    }
  });
});

// 부록 A.4: 라벨 맵은 모든 enum 값을 빠짐없이 덮는다 (누락 시 화면에 원시 코드가 노출된다)
describe('부록 A.4 Phase 9 라벨 맵', () => {
  it('HireType 2종을 덮는다', () => {
    const values: HireType[] = ['existing', 'new'];
    expect(Object.keys(HIRE_TYPE_LABELS).sort()).toEqual([...values].sort());
    expect(HIRE_TYPE_LABELS).toEqual({ existing: '기존인력', new: '채용예정' });
  });

  it('DetailAxis 2종을 덮는다 — 값은 in_kind(스네이크)다', () => {
    const values: DetailAxis[] = ['cash', 'in_kind'];
    expect(Object.keys(DETAIL_AXIS_LABELS).sort()).toEqual([...values].sort());
    expect(DETAIL_AXIS_LABELS).toEqual({ cash: '현금', in_kind: '현물' });
  });

  it('DetailFormula 2종을 덮는다', () => {
    const values: DetailFormula[] = ['personnel', 'quantity'];
    expect(Object.keys(DETAIL_FORMULA_LABELS).sort()).toEqual([...values].sort());
    expect(DETAIL_FORMULA_LABELS).toEqual({ personnel: '인건비산식', quantity: '단가×수량' });
  });

  it('라벨이 빈 문자열인 항목이 없다', () => {
    const all = [
      ...Object.values(HIRE_TYPE_LABELS),
      ...Object.values(DETAIL_AXIS_LABELS),
      ...Object.values(DETAIL_FORMULA_LABELS),
    ];
    for (const label of all) expect(label.length).toBeGreaterThan(0);
  });
});
