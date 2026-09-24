// 규칙 편집 패널의 순수 보조 함수 (SOT §7.9.5, §5.18 RL-D2·D5, §8.4 O-3)
// 행 입력값(draft) ↔ BudgetRule 변환, 바뀐 필드만 뽑는 patch 생성, O-3 비교용 표시 문자열.
// UI 없이 단위 테스트로 고정한다 (tests/unit/rule-form.test.ts). fetch·supabase·next 무의존.
//
// 값은 문자열(draft.valueText)로 들고 있다 — 입력 중인 "20." 같은 상태를 number로 표현할 수 없고,
// 파싱 실패를 저장 시점에 문구로 돌려줘야 하기 때문이다. 금액은 원 단위 정수만 받는다(절대 규칙 4).

import type { BudgetRule, IndirectBase, RuleCode, RuleSeverity } from '@/types';
import { INDIRECT_BASE_LABELS } from '@/lib/constants';
import { RULE_SPECS } from '@/lib/rules';
import { PRESET_IDS, RULE_PRESETS } from '@/lib/rules-presets';

// ─── 라벨 ─────────────────────────────────────────────────────────────────────

/** §5.18 RuleCode 선언 순서 = RULE_SPECS 키 순서. "코드 순" 정렬의 기준 */
export const RULE_CODE_ORDER: readonly RuleCode[] = Object.keys(RULE_SPECS) as RuleCode[];

export const SEVERITY_ORDER: readonly RuleSeverity[] = ['error', 'warn', 'info'];

export const SEVERITY_LABELS: Record<RuleSeverity, string> = {
  error: '오류',
  warn: '주의',
  info: '권고',
};

export const INDIRECT_BASE_ORDER: readonly IndirectBase[] = [
  'direct_cash_excl_intl_consign_burden',
  'direct_cash_excl_intl',
];

// ─── draft ────────────────────────────────────────────────────────────────────

export interface RuleDraft {
  enabled: boolean;
  /** 입력 문자열. ''는 null. 금액은 쉼표를 허용한다 */
  valueText: string;
  base: IndirectBase | null;
  severity: RuleSeverity;
  source: string;
  note: string;
}

export type RuleDraftKey = keyof RuleDraft;

export const RULE_DRAFT_FIELDS: readonly { key: RuleDraftKey; label: string }[] = [
  { key: 'enabled', label: '켜짐' },
  { key: 'valueText', label: '값' },
  { key: 'base', label: '분모' },
  { key: 'severity', label: '심각도' },
  { key: 'source', label: '출처' },
  { key: 'note', label: '메모' },
];

export function toRuleDraft(
  rule: Pick<BudgetRule, 'enabled' | 'value' | 'base' | 'severity' | 'source' | 'note'>
): RuleDraft {
  return {
    enabled: rule.enabled,
    valueText: rule.value === null ? '' : String(rule.value),
    base: rule.base,
    severity: rule.severity,
    source: rule.source,
    note: rule.note,
  };
}

// ─── 값 파싱·표시 ─────────────────────────────────────────────────────────────

export type ValueUnit = 'percent' | 'won';

export type ParsedValue = { ok: true; value: number | null } | { ok: false; message: string };

/**
 * 모양만 본다(숫자인가, 금액이면 정수인가). 범위(0~100 등)는 서버의 RL-D2 검증이 VALIDATION으로
 * 돌려주고 행 옆에 그대로 보인다 — 같은 규칙을 두 곳에 쓰지 않는다.
 */
export function parseValueText(text: string, unit: ValueUnit | null): ParsedValue {
  const trimmed = text.trim();
  if (trimmed === '') return { ok: true, value: null };
  if (unit === null) {
    return { ok: false, message: '이 규칙은 값을 쓰지 않습니다. 값을 비워 두세요.' };
  }
  const normalized = unit === 'won' ? trimmed.replace(/,/g, '') : trimmed;
  if (!/^-?\d+(\.\d+)?$/.test(normalized)) {
    return { ok: false, message: '숫자만 입력하세요.' };
  }
  const value = Number(normalized);
  if (!Number.isFinite(value)) return { ok: false, message: '숫자만 입력하세요.' };
  if (unit === 'won' && !Number.isInteger(value)) {
    return { ok: false, message: '금액은 원 단위 정수로 입력하세요.' };
  }
  return { ok: true, value };
}

export function formatRuleValue(value: number | null, unit: ValueUnit | null): string {
  if (value === null || unit === null) return '—';
  if (unit === 'percent') return `${value}%`;
  return `${value.toLocaleString('ko-KR')}원`;
}

// ─── 비교·patch (O-3) ─────────────────────────────────────────────────────────

function sameValueText(a: string, b: string, unit: ValueUnit | null): boolean {
  const pa = parseValueText(a, unit);
  const pb = parseValueText(b, unit);
  // 둘 다 파싱되면 숫자로 비교한다 — "20"과 "20.0"은 같은 값이다
  if (pa.ok && pb.ok) return pa.value === pb.value;
  return a.trim() === b.trim();
}

/** 두 draft에서 다른 필드. O-3 비교 UI의 목록이자 patch의 키 */
export function diffRuleDraft(a: RuleDraft, b: RuleDraft, unit: ValueUnit | null): RuleDraftKey[] {
  return RULE_DRAFT_FIELDS.flatMap(({ key }) => {
    if (key === 'valueText') return sameValueText(a.valueText, b.valueText, unit) ? [] : [key];
    if (key === 'source' || key === 'note') return a[key].trim() === b[key].trim() ? [] : [key];
    return a[key] === b[key] ? [] : [key];
  });
}

/** 확인하지 않은 충돌 항목 — 이것이 남아 있으면 저장하지 않는다 */
export function unresolvedRuleConflicts(
  diffKeys: readonly RuleDraftKey[],
  keptKeys: ReadonlySet<RuleDraftKey>
): RuleDraftKey[] {
  return diffKeys.filter((key) => !keptKeys.has(key));
}

/** upsertBudgetRule의 patch 모양. 바뀐 필드만 싣는다 */
export interface RulePatch {
  enabled?: boolean;
  value?: number | null;
  base?: IndirectBase | null;
  severity?: RuleSeverity;
  source?: string;
  note?: string;
}

export type BuiltRulePatch = { ok: true; patch: RulePatch } | { ok: false; message: string };

/**
 * baseline과 다른 필드만 patch로. 빈 patch는 "저장할 것 없음"이며 호출부가 액션을 부르지 않는다
 * (액션은 빈 patch를 VALIDATION으로 거부한다).
 */
export function buildRulePatch(draft: RuleDraft, baseline: BudgetRule): BuiltRulePatch {
  const unit = RULE_SPECS[baseline.code].valueUnit;
  const keys = diffRuleDraft(draft, toRuleDraft(baseline), unit);
  const patch: RulePatch = {};
  for (const key of keys) {
    switch (key) {
      case 'enabled':
        patch.enabled = draft.enabled;
        break;
      case 'valueText': {
        const parsed = parseValueText(draft.valueText, unit);
        if (!parsed.ok) return parsed;
        patch.value = parsed.value;
        break;
      }
      case 'base':
        patch.base = draft.base;
        break;
      case 'severity':
        patch.severity = draft.severity;
        break;
      case 'source': {
        // RL-D5: 출처 없는 한도는 지어낸 숫자다. 서버도 거르지만 왕복 전에 알려 준다
        const source = draft.source.trim();
        if (source === '') {
          return { ok: false, message: '출처를 비워 둘 수 없습니다. 고시 조문이나 공고명을 적으세요.' };
        }
        patch.source = source;
        break;
      }
      case 'note':
        patch.note = draft.note;
        break;
    }
  }
  return { ok: true, patch };
}

/** O-3 비교 UI의 표시 문자열 */
export function displayDraftValue(key: RuleDraftKey, draft: RuleDraft, unit: ValueUnit | null): string {
  switch (key) {
    case 'enabled':
      return draft.enabled ? '켜짐' : '꺼짐';
    case 'valueText': {
      const parsed = parseValueText(draft.valueText, unit);
      return parsed.ok ? formatRuleValue(parsed.value, unit) : draft.valueText;
    }
    case 'base':
      return draft.base === null ? '—' : INDIRECT_BASE_LABELS[draft.base];
    case 'severity':
      return SEVERITY_LABELS[draft.severity];
    case 'source':
      return draft.source.trim() === '' ? '(비어 있음)' : draft.source;
    case 'note':
      return draft.note.trim() === '' ? '(비어 있음)' : draft.note;
  }
}

// ─── 목록 보조 ────────────────────────────────────────────────────────────────

export function sortRulesByCode<T extends { code: RuleCode }>(rules: readonly T[]): T[] {
  const index = new Map(RULE_CODE_ORDER.map((code, i) => [code, i]));
  return [...rules].sort((a, b) => (index.get(a.code) ?? 0) - (index.get(b.code) ?? 0));
}

/** 과제에 아직 없는 코드 — [규칙 추가] 셀렉트의 후보. 비면 셀렉트를 비활성한다 */
export function missingRuleCodes(rules: readonly { code: RuleCode }[]): RuleCode[] {
  const present = new Set(rules.map((r) => r.code));
  return RULE_CODE_ORDER.filter((code) => !present.has(code));
}

// ─── gov_share_max 후보 (부록 D.2) ────────────────────────────────────────────

export interface GovShareOption {
  value: number;
  label: string;
}

// 부록 D.2: 프리셋 기본값(75)은 원천기술형이다. 상수에는 alternatives의 라벨만 있어 기본값 라벨은 여기서 붙인다
const GOV_SHARE_PRIMARY_LABEL = '원천기술형';

/** 프리셋이 제안한 정부지원 비율 상한 후보. 값 기준으로 중복을 없애고 큰 값부터 */
export function govShareOptions(): GovShareOption[] {
  const byValue = new Map<number, string>();
  for (const id of PRESET_IDS) {
    const rule = RULE_PRESETS[id].rules.find((r) => r.code === 'gov_share_max');
    if (!rule) continue;
    if (rule.value !== null && !byValue.has(rule.value)) byValue.set(rule.value, GOV_SHARE_PRIMARY_LABEL);
    for (const alt of rule.alternatives ?? []) {
      if (!byValue.has(alt.value)) byValue.set(alt.value, alt.label);
    }
  }
  return [...byValue.entries()]
    .sort((a, b) => b[0] - a[0])
    .map(([value, label]) => ({ value, label }));
}
