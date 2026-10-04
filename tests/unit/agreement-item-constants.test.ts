// Phase 26 기반 상수·스키마 (SOT §5.18, §5.24, 부록 A.5 주의 4, 부록 C 주의 3·C.4, 계획서 S-2·S-4·S-12·S-16)
//
// 증빙 기본 목록은 §5.24 표를 리터럴로 옮겨 대조한다 — 표가 원본이고 상수가 틀리면 상수를 고친다.
// 규칙 코드 집합은 DB check(마이그레이션)·RuleCode·Zod·RULE_SPECS 네 곳이 같아야 한다(§5.18 Phase 26).

import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { z } from 'zod';
import {
  AGREEMENT_EVIDENCE_DEFAULTS,
  AGREEMENT_ITEM_KIND_LABELS,
  AGREEMENT_ITEM_MAX_LENGTH,
  AGREEMENT_ITEM_SUBCATEGORY,
  ATTACHMENT4_FORM_ROWS,
  BUDGET_CATEGORY_ORDER,
  SKIP_ROW_PATTERNS,
  SUBCATEGORY_PRESETS,
  agreementSubcategoryLabel,
} from '@/lib/constants';
import {
  agreementEvidenceInputSchema,
  agreementItemAddInputSchema,
  agreementItemPatchInputSchema,
  ruleCodeSchema,
} from '@/lib/db/schema';
import { normalizeLabel } from '@/lib/import/normalize';
import { RATIO_CODES, RULE_SPECS } from '@/lib/rules';
import type { RuleSource } from '@/lib/rules-presets';
import type { AgreementItemKind, RuleCode } from '@/types';

const YEAR_ID = '00000000-0000-4000-8000-000000000001';

// ─── 세목 (부록 A.5) ─────────────────────────────────────────

describe('SUBCATEGORY_PRESETS — indirect_lab_safety (A.5 주의 4)', () => {
  it('간접비 끝에 연구실 안전관리비가 있고 기존 세목 코드·순서는 그대로다', () => {
    expect(SUBCATEGORY_PRESETS.indirect).toEqual([
      { code: 'indirect_hr', label: '가. 인력지원비', formula: 'quantity', defaultFactors: [] },
      { code: 'indirect_support', label: '나. 연구지원비', formula: 'quantity', defaultFactors: [] },
      { code: 'indirect_outcome', label: '다. 성과활용지원비', formula: 'quantity', defaultFactors: [] },
      { code: 'indirect_lab_safety', label: '연구실 안전관리비', formula: 'quantity', defaultFactors: [] },
    ]);
  });

  it('다른 비목의 세목 코드 순서는 Phase 25와 같다', () => {
    const codes = Object.fromEntries(
      BUDGET_CATEGORY_ORDER.filter((c) => c !== 'indirect').map((c) => [c, SUBCATEGORY_PRESETS[c].map((d) => d.code)]),
    );
    expect(codes).toEqual({
      personnel: ['personnel_internal', 'personnel_external', 'personnel_support'],
      student_personnel: ['student_general', 'student_managed'],
      facility_equipment: ['facility_purchase', 'facility_lease', 'facility_maintain', 'facility_infra'],
      material: ['material_purchase', 'material_manage', 'material_make'],
      consignment: ['default'],
      international: ['default'],
      burden: ['default'],
      activity: [
        'activity_outsourcing', 'activity_ip', 'activity_expert', 'activity_meeting',
        'activity_travel_dom', 'activity_travel_intl', 'activity_software', 'activity_lab_ops',
        'activity_hr_support', 'activity_pmo', 'activity_cloud', 'activity_etc',
      ],
      promotion: ['default'],
      allowance: ['default'],
      other: ['default'],
    });
  });

  it('협약 금액 줄 세목 표시가 A.5 라벨을 따른다', () => {
    expect(agreementSubcategoryLabel('indirect', 'indirect_lab_safety')).toBe('연구실 안전관리비');
  });
});

// ─── 편성 항목 (§5.24) ───────────────────────────────────────

describe('AGREEMENT_EVIDENCE_DEFAULTS (§5.24 표, U-1)', () => {
  it('종류별 기본 증빙이 표와 같은 순서다', () => {
    expect(AGREEMENT_EVIDENCE_DEFAULTS).toEqual({
      equipment: ['견적서', '비교견적서', '구매요청서', '계약서', '거래명세서', '검수조서', '세금계산서', 'ZEUS 등록 확인'],
      material: ['견적서', '비교견적서', '구매요청서', '거래명세서', '검수조서', '세금계산서'],
      outsourcing: ['과업지시서', '견적서', '비교견적서', '계약서', '중간산출물', '최종 결과물', '검수조서', '세금계산서'],
    });
  });

  it('활용계획서·사전 승인은 목록에 없다 — RL-17 경고가 안내한다', () => {
    for (const labels of Object.values(AGREEMENT_EVIDENCE_DEFAULTS)) {
      expect(labels.some((l) => l.includes('활용계획') || l.includes('승인'))).toBe(false);
    }
  });

  it('기본 목록은 증빙 입력 검증을 통과한다(길이·개수·중복)', () => {
    for (const kind of Object.keys(AGREEMENT_ITEM_KIND_LABELS) as AgreementItemKind[]) {
      const evidence = AGREEMENT_EVIDENCE_DEFAULTS[kind].map((label) => ({ label, obtained: false, memo: '' }));
      expect(agreementEvidenceInputSchema.safeParse(evidence).success, kind).toBe(true);
    }
  });
});

describe('AGREEMENT_ITEM_SUBCATEGORY (S-2 대조 · S-8 ④ 판정 행)', () => {
  it('equipment↔facility_purchase · material↔material_purchase · outsourcing↔activity_outsourcing', () => {
    expect(AGREEMENT_ITEM_SUBCATEGORY).toEqual({
      equipment: { category: 'facility_equipment', subcategoryCode: 'facility_purchase' },
      material: { category: 'material', subcategoryCode: 'material_purchase' },
      outsourcing: { category: 'activity', subcategoryCode: 'activity_outsourcing' },
    });
  });

  it('대응 세목은 A.5에 있는 코드다', () => {
    for (const { category, subcategoryCode } of Object.values(AGREEMENT_ITEM_SUBCATEGORY)) {
      expect(SUBCATEGORY_PRESETS[category].map((d) => d.code)).toContain(subcategoryCode);
    }
  });
});

describe('편성 항목 입력 검증 (S-12)', () => {
  const max = AGREEMENT_ITEM_MAX_LENGTH;
  const base = { yearId: YEAR_ID, kind: 'equipment', name: '분광기', amount: 28_000_000, quantity: 1 };
  const check = (label: string, memo = '') => ({ label, obtained: false, memo });

  it('상한: 품명 200 · 증빙 이름 100 · 메모 500 · 증빙 30개', () => {
    expect(max).toEqual({ name: 200, label: 100, memo: 500, evidence: 30 });
  });

  it('추가: evidence 생략 허용, quantity null 허용', () => {
    expect(agreementItemAddInputSchema.safeParse(base).success).toBe(true);
    expect(agreementItemAddInputSchema.safeParse({ ...base, quantity: null }).success).toBe(true);
    expect(agreementItemAddInputSchema.safeParse({ ...base, quantity: 0.5 }).success).toBe(true);
  });

  it('품명은 trim 후 1~200자', () => {
    expect(agreementItemAddInputSchema.safeParse({ ...base, name: '   ' }).success).toBe(false);
    expect(agreementItemAddInputSchema.safeParse({ ...base, name: 'a'.repeat(max.name) }).success).toBe(true);
    expect(agreementItemAddInputSchema.safeParse({ ...base, name: 'a'.repeat(max.name + 1) }).success).toBe(false);
    const parsed = agreementItemAddInputSchema.parse({ ...base, name: '  분광기 ' });
    expect(parsed.name).toBe('분광기');
  });

  it.each([-1, 1.5, Number.NaN, Number.MAX_SAFE_INTEGER + 1])('금액 %s 거부', (amount) => {
    expect(agreementItemAddInputSchema.safeParse({ ...base, amount }).success).toBe(false);
  });

  it('금액 0·안전 정수 상한 허용, 음수 수량 거부', () => {
    expect(agreementItemAddInputSchema.safeParse({ ...base, amount: 0 }).success).toBe(true);
    expect(agreementItemAddInputSchema.safeParse({ ...base, amount: Number.MAX_SAFE_INTEGER }).success).toBe(true);
    expect(agreementItemAddInputSchema.safeParse({ ...base, quantity: -1 }).success).toBe(false);
  });

  it('종류는 3종만, 모르는 키는 거부한다(strict)', () => {
    expect(agreementItemAddInputSchema.safeParse({ ...base, kind: 'lease' }).success).toBe(false);
    expect(agreementItemAddInputSchema.safeParse({ ...base, versionId: YEAR_ID }).success).toBe(false);
  });

  it('수정: 부분 패치 허용, evidence 키는 거부', () => {
    expect(agreementItemPatchInputSchema.safeParse({}).success).toBe(true);
    expect(agreementItemPatchInputSchema.safeParse({ amount: 30_000_000 }).success).toBe(true);
    expect(agreementItemPatchInputSchema.safeParse({ amount: 1, evidence: [] }).success).toBe(false);
    expect(agreementItemPatchInputSchema.safeParse({ name: '' }).success).toBe(false);
  });

  it('증빙: 이름 trim 후 1~100자, 메모 500자, 30개 이하', () => {
    const ok = (value: unknown) => agreementEvidenceInputSchema.safeParse(value);
    expect(ok([check('a'.repeat(max.label))]).success).toBe(true);
    expect(ok([check('a'.repeat(max.label + 1))]).success).toBe(false);
    expect(ok([check(' ')]).success).toBe(false);
    expect(ok([check('견적서', 'm'.repeat(max.memo))]).success).toBe(true);
    expect(ok([check('견적서', 'm'.repeat(max.memo + 1))]).success).toBe(false);
    const many = Array.from({ length: max.evidence }, (_, i) => check(`서류 ${i}`));
    expect(ok(many).success).toBe(true);
    expect(ok([...many, check('하나 더')]).success).toBe(false);
    expect(ok([]).success).toBe(true);
  });

  it('증빙: 한 항목 안 이름 중복 거부(trim 후 비교), 원소 모양 strict', () => {
    expect(agreementEvidenceInputSchema.safeParse([check('견적서'), check(' 견적서 ')]).success).toBe(false);
    expect(agreementEvidenceInputSchema.safeParse([{ label: '견적서', obtained: 'yes', memo: '' }]).success).toBe(false);
    expect(agreementEvidenceInputSchema.safeParse([{ label: '견적서', obtained: true }]).success).toBe(false);
    expect(
      agreementEvidenceInputSchema.safeParse([{ label: '견적서', obtained: true, memo: '', checkedAt: 'x' }]).success,
    ).toBe(false);
  });
});

// ─── 규칙 코드 (§5.18 Phase 26) ──────────────────────────────

type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
// 컴파일 시점 단언 — Zod enum과 RuleCode 타입이 갈라지면 tsc가 실패한다
const zodMatchesRuleCode: Same<z.infer<typeof ruleCodeSchema>, RuleCode> = true;

/** 가장 최근에 budget_rules code check를 정의한 마이그레이션의 코드 목록 */
function migrationRuleCodes(): string[] {
  const dir = join(process.cwd(), 'supabase', 'migrations');
  const files = readdirSync(dir).filter((f) => f.endsWith('.sql')).sort();
  for (const file of files.reverse()) {
    const sql = readFileSync(join(dir, file), 'utf8');
    const start = sql.lastIndexOf('add constraint budget_rules_code_check check (code in (');
    if (start < 0) continue;
    const body = sql.slice(start, sql.indexOf('))', start));
    const withoutComments = body.replace(/--[^\n]*/g, '');
    return [...withoutComments.matchAll(/'([a-z_]+)'/g)].map((m) => m[1]!);
  }
  throw new Error('budget_rules_code_check를 정의한 마이그레이션이 없습니다.');
}

describe('RuleCode 집합 — DB check = RuleCode = Zod = RULE_SPECS', () => {
  const zodCodes = [...ruleCodeSchema.options].sort();

  it('20종이고 새 3종을 포함한다', () => {
    expect(zodMatchesRuleCode).toBe(true);
    expect(zodCodes).toHaveLength(20);
    expect(zodCodes).toEqual(expect.arrayContaining(['lab_safety_min', 'lab_safety_max', 'preserve_subcategory_totals']));
  });

  it('RULE_SPECS 키 = Zod enum', () => {
    expect(Object.keys(RULE_SPECS).sort()).toEqual(zodCodes);
  });

  it('마이그레이션 code check = Zod enum', () => {
    expect(migrationRuleCodes().sort()).toEqual(zodCodes);
  });

  it('RL-21 코드는 어디에도 없다(결번)', () => {
    expect(zodCodes.some((c) => c.includes('outsourcing_near') || c.includes('near_threshold'))).toBe(false);
  });

  it('새 코드의 의미: RL-22 비율 % 두 모드, RL-23 값 없음 수행 전용', () => {
    expect(RULE_SPECS.lab_safety_min).toMatchObject({ kind: 'ratio_min', needsValue: true, valueUnit: 'percent', scope: 'year', ruleRef: 'RL-22', modes: ['plan', 'agreement'] });
    expect(RULE_SPECS.lab_safety_max).toMatchObject({ kind: 'ratio_max', needsValue: true, valueUnit: 'percent', scope: 'year', ruleRef: 'RL-22', modes: ['plan', 'agreement'] });
    expect(RULE_SPECS.preserve_subcategory_totals).toMatchObject({ needsValue: false, valueUnit: null, ruleRef: 'RL-23', modes: ['agreement'] });
  });

  it('preserve_subcategory_totals 외에는 전부 두 모드다', () => {
    for (const code of Object.keys(RULE_SPECS) as RuleCode[]) {
      const expected = code === 'preserve_subcategory_totals' ? ['agreement'] : ['plan', 'agreement'];
      expect(RULE_SPECS[code].modes, code).toEqual(expected);
    }
  });

  it('RL-22는 ratios에 싣지 않는다 — RATIO_CODES 7종 유지', () => {
    expect(RATIO_CODES).toHaveLength(7);
    expect(RATIO_CODES as readonly string[]).not.toContain('lab_safety_min');
    expect(RATIO_CODES as readonly string[]).not.toContain('lab_safety_max');
  });

  it('RuleSource가 간사 지침 출처를 받는다', () => {
    const source: RuleSource = '간사 지침 연구실 안전관리비 (인건비 + 학생인건비의 1% 이상)';
    expect(source.startsWith('간사 지침 ')).toBe(true);
  });
});

// ─── 임포트·붙임4 (부록 C) ───────────────────────────────────

describe('부록 C — 연구실 안전관리비', () => {
  it('SKIP_ROW_PATTERNS가 괄호 없는 변형을 정규화 후 완전 일치로 거른다', () => {
    const skip = new Set(SKIP_ROW_PATTERNS.map(normalizeLabel));
    expect(skip.has(normalizeLabel('연구실 안전관리비'))).toBe(true);
    expect(SKIP_ROW_PATTERNS).toContain('안전관리비');
  });

  it('C.4 lab_safety는 breakdown 행 — 소스·가져오기 대상 = indirect/indirect_lab_safety', () => {
    const lab = ATTACHMENT4_FORM_ROWS.find((r) => r.id === 'lab_safety')!;
    expect(lab.kind).toBe('breakdown');
    expect(lab.sources).toEqual([{ category: 'indirect', subcategoryCodes: ['indirect_lab_safety'] }]);
    expect(lab.importTarget).toEqual({ category: 'indirect', subcategoryCode: 'indirect_lab_safety' });
    expect(ATTACHMENT4_FORM_ROWS.some((r) => r.kind === 'memo')).toBe(false);
  });
});
