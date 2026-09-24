// 규칙 편집 패널 보조 함수 (components/budget/rules/rule-form.ts — SOT §7.9.5, RL-D2·D5, O-3)
import { describe, expect, it } from 'vitest';
import type { BudgetRule } from '@/types';
import {
  RULE_CODE_ORDER,
  buildRulePatch,
  diffRuleDraft,
  displayDraftValue,
  formatRuleValue,
  govShareOptions,
  missingRuleCodes,
  parseValueText,
  sortRulesByCode,
  toRuleDraft,
  unresolvedRuleConflicts,
} from '@/components/budget/rules/rule-form';

function rule(overrides: Partial<BudgetRule> = {}): BudgetRule {
  return {
    id: 'r1',
    projectId: 'p1',
    code: 'allowance_max',
    enabled: true,
    value: 20,
    base: null,
    severity: 'error',
    source: '과기부고시 제2026-38호 제26조①',
    note: '',
    version: 3,
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    createdBy: null,
    updatedBy: null,
    ...overrides,
  };
}

describe('parseValueText', () => {
  it("''는 null", () => {
    expect(parseValueText('', 'percent')).toEqual({ ok: true, value: null });
    expect(parseValueText('  ', 'won')).toEqual({ ok: true, value: null });
  });
  it('비율은 소수 허용, 금액은 쉼표 허용·정수만', () => {
    expect(parseValueText('12.5', 'percent')).toEqual({ ok: true, value: 12.5 });
    expect(parseValueText('30,000,000', 'won')).toEqual({ ok: true, value: 30_000_000 });
    expect(parseValueText('1.5', 'won').ok).toBe(false);
  });
  it('숫자가 아니면 거부, 값을 쓰지 않는 코드(unit null)에 값이 오면 거부', () => {
    expect(parseValueText('abc', 'percent').ok).toBe(false);
    expect(parseValueText('20', null).ok).toBe(false);
    expect(parseValueText('', null)).toEqual({ ok: true, value: null });
  });
});

describe('formatRuleValue', () => {
  it('단위별 표시', () => {
    expect(formatRuleValue(20, 'percent')).toBe('20%');
    expect(formatRuleValue(30_000_000, 'won')).toBe('30,000,000원');
    expect(formatRuleValue(null, 'percent')).toBe('—');
    expect(formatRuleValue(5, null)).toBe('—');
  });
});

describe('diffRuleDraft / buildRulePatch', () => {
  it('바뀐 필드만 patch에 싣는다', () => {
    const base = rule();
    const draft = { ...toRuleDraft(base), valueText: '25', note: '공고에서 25로' };
    const built = buildRulePatch(draft, base);
    expect(built).toEqual({ ok: true, patch: { value: 25, note: '공고에서 25로' } });
  });
  it('"20"과 "20.0"은 같은 값 — 빈 patch', () => {
    const base = rule();
    const built = buildRulePatch({ ...toRuleDraft(base), valueText: '20.0' }, base);
    expect(built).toEqual({ ok: true, patch: {} });
  });
  it('값을 비우면 null patch', () => {
    const base = rule();
    const built = buildRulePatch({ ...toRuleDraft(base), valueText: '' }, base);
    expect(built).toEqual({ ok: true, patch: { value: null } });
  });
  it('RL-D5: 출처를 비우면 거부', () => {
    const base = rule();
    const built = buildRulePatch({ ...toRuleDraft(base), source: '   ' }, base);
    expect(built.ok).toBe(false);
  });
  it('숫자가 아닌 값은 거부 문구', () => {
    const base = rule();
    const built = buildRulePatch({ ...toRuleDraft(base), valueText: '20%' }, base);
    expect(built.ok).toBe(false);
  });
  it('출처는 trim해서 비교·저장', () => {
    const base = rule();
    expect(buildRulePatch({ ...toRuleDraft(base), source: ` ${base.source} ` }, base)).toEqual({
      ok: true,
      patch: {},
    });
  });
  it('unresolvedRuleConflicts는 kept를 뺀다', () => {
    const a = toRuleDraft(rule());
    const b = { ...a, enabled: false, severity: 'warn' as const };
    const keys = diffRuleDraft(a, b, 'percent');
    expect(keys).toEqual(['enabled', 'severity']);
    expect(unresolvedRuleConflicts(keys, new Set(['enabled']))).toEqual(['severity']);
  });
});

describe('displayDraftValue', () => {
  it('O-3 비교 문자열', () => {
    const d = toRuleDraft(rule({ code: 'indirect_max', value: 10, base: 'direct_cash_excl_intl' }));
    expect(displayDraftValue('enabled', d, 'percent')).toBe('켜짐');
    expect(displayDraftValue('valueText', d, 'percent')).toBe('10%');
    expect(displayDraftValue('base', d, 'percent')).toContain('국제공동');
    expect(displayDraftValue('severity', d, 'percent')).toBe('오류');
    expect(displayDraftValue('note', d, 'percent')).toBe('(비어 있음)');
  });
});

describe('목록 보조', () => {
  it('sortRulesByCode는 §5.18 선언 순', () => {
    const sorted = sortRulesByCode([{ code: 'no_burden' }, { code: 'allowance_max' }, { code: 'indirect_max' }]);
    expect(sorted.map((r) => r.code)).toEqual(['allowance_max', 'indirect_max', 'no_burden']);
  });
  it('missingRuleCodes는 없는 코드만, 전부 있으면 빈 배열', () => {
    expect(missingRuleCodes([{ code: 'allowance_max' }])).toHaveLength(RULE_CODE_ORDER.length - 1);
    expect(missingRuleCodes(RULE_CODE_ORDER.map((code) => ({ code })))).toEqual([]);
  });
  it('govShareOptions는 부록 D.2의 75(원천기술형)·67(혁신제품형)', () => {
    expect(govShareOptions()).toEqual([
      { value: 75, label: '원천기술형' },
      { value: 67, label: '혁신제품형' },
    ]);
  });
});
