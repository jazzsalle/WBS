// 협약 예산 라벨 맵 (SOT 부록 A.4 v4.9, §5.21~§5.24, §5.22 세목 default)
// 라벨 맵은 모든 enum 값을 빠짐없이 덮는다 — 누락 시 화면에 원시 코드가 노출된다.
// 키 집합은 DB 응답 Zod enum과 대조한다: 마이그레이션 check·Zod·라벨이 한 값이라도 어긋나면 여기서 깨진다.

import { describe, expect, it } from 'vitest';
import {
  AGREEMENT_DEFAULT_SUBCATEGORY_LABEL,
  AGREEMENT_ITEM_KIND_LABELS,
  AGREEMENT_NOTICE_TYPE_LABELS,
  AGREEMENT_VERSION_KIND_LABELS,
  AGREEMENT_VERSION_KIND_ORDER,
  AGREEMENT_VERSION_STATUS_LABELS,
  BUDGET_CATEGORY_ORDER,
  DEFAULT_SUBCATEGORY_CODE,
  EXPECTED_SCHEMA_VERSION,
  SUBCATEGORY_PRESETS,
  agreementSubcategoryLabel,
} from '@/lib/constants';
import {
  agreementItemKindSchema,
  agreementNoticeTypeSchema,
  agreementVersionKindSchema,
  agreementVersionStatusSchema,
} from '@/lib/db/schema';

const sorted = (values: readonly string[]) => [...values].sort();

describe('부록 A.4 협약 예산 라벨 맵 (Phase 24)', () => {
  it('AgreementVersionKind 4종을 덮는다', () => {
    expect(sorted(Object.keys(AGREEMENT_VERSION_KIND_LABELS))).toEqual(sorted(agreementVersionKindSchema.options));
    expect(AGREEMENT_VERSION_KIND_LABELS).toEqual({
      selection: '선정평가본',
      adjustment: '조정회의본',
      final: '최종협약본',
      amendment: '협약변경',
    });
  });

  it('AgreementVersionStatus 2종을 덮는다', () => {
    expect(sorted(Object.keys(AGREEMENT_VERSION_STATUS_LABELS))).toEqual(sorted(agreementVersionStatusSchema.options));
    expect(AGREEMENT_VERSION_STATUS_LABELS).toEqual({ draft: '작성 중', confirmed: '확정' });
  });

  it('AgreementNoticeType 2종을 덮는다', () => {
    expect(sorted(Object.keys(AGREEMENT_NOTICE_TYPE_LABELS))).toEqual(sorted(agreementNoticeTypeSchema.options));
    expect(AGREEMENT_NOTICE_TYPE_LABELS).toEqual({ notice: '통보', approval: '승인' });
  });

  it('AgreementItemKind 3종을 덮는다', () => {
    expect(sorted(Object.keys(AGREEMENT_ITEM_KIND_LABELS))).toEqual(sorted(agreementItemKindSchema.options));
    expect(AGREEMENT_ITEM_KIND_LABELS).toEqual({ equipment: '장비', material: '재료', outsourcing: '외주용역' });
  });

  it('종류 순서는 쌓이는 순서이고 4종을 한 번씩 담는다', () => {
    expect(AGREEMENT_VERSION_KIND_ORDER).toEqual(['selection', 'adjustment', 'final', 'amendment']);
    expect(sorted(AGREEMENT_VERSION_KIND_ORDER)).toEqual(sorted(agreementVersionKindSchema.options));
  });

  it('라벨이 빈 문자열인 항목이 없다', () => {
    const all = [
      ...Object.values(AGREEMENT_VERSION_KIND_LABELS),
      ...Object.values(AGREEMENT_VERSION_STATUS_LABELS),
      ...Object.values(AGREEMENT_NOTICE_TYPE_LABELS),
      ...Object.values(AGREEMENT_ITEM_KIND_LABELS),
      AGREEMENT_DEFAULT_SUBCATEGORY_LABEL,
    ];
    for (const label of all) expect(label.length).toBeGreaterThan(0);
  });
});

describe('협약 금액 줄 세목 표시 (§5.22, 부록 A.4 세목 default)', () => {
  it('default 라벨 상수는 "세목 미지정"', () => {
    expect(AGREEMENT_DEFAULT_SUBCATEGORY_LABEL).toBe('세목 미지정');
  });

  it('세목이 default뿐인 비목은 부록 A.5 표시를 그대로 쓴다', () => {
    expect(agreementSubcategoryLabel('allowance', 'default')).toBe('연구수당');
    expect(agreementSubcategoryLabel('promotion', 'default')).toBe('연구과제추진비');
    expect(agreementSubcategoryLabel('other', 'default')).toBe('기타');
  });

  it('세목이 여럿인 비목의 default는 "세목 미지정"', () => {
    expect(agreementSubcategoryLabel('activity', 'default')).toBe('세목 미지정');
    expect(agreementSubcategoryLabel('material', 'default')).toBe('세목 미지정');
    expect(agreementSubcategoryLabel('personnel', 'default')).toBe('세목 미지정');
    expect(agreementSubcategoryLabel('indirect', 'default')).toBe('세목 미지정');
  });

  it('모든 비목에서 default가 표시를 갖는다(모든 비목에 default 허용)', () => {
    for (const category of BUDGET_CATEGORY_ORDER) {
      const label = agreementSubcategoryLabel(category, DEFAULT_SUBCATEGORY_CODE);
      const presets = SUBCATEGORY_PRESETS[category];
      const onlyDefault = presets.length === 1 && presets[0]!.code === DEFAULT_SUBCATEGORY_CODE;
      expect(label, category).toBe(onlyDefault ? presets[0]!.label : '세목 미지정');
    }
  });

  it('A.5 세목 코드는 A.5 표시를 쓴다', () => {
    for (const category of BUDGET_CATEGORY_ORDER) {
      for (const def of SUBCATEGORY_PRESETS[category]) {
        expect(agreementSubcategoryLabel(category, def.code), `${category}/${def.code}`).toBe(def.label);
      }
    }
  });

  it('A.5 밖 코드·다른 비목의 코드는 null — 원시 코드를 표시로 흘리지 않는다', () => {
    expect(agreementSubcategoryLabel('activity', 'unknown_code')).toBeNull();
    expect(agreementSubcategoryLabel('material', 'activity_meeting')).toBeNull();
  });
});

describe('§8.8 schema_version', () => {
  it('Phase 25(agreement_gov_support 신설 + years.gov_support_cash) = 7', () => {
    expect(EXPECTED_SCHEMA_VERSION).toBe(7);
  });
});
