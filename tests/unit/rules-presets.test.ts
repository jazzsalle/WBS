// 연구비 사용 규칙 프리셋 (SOT 부록 D.1~D.3, §5.18 RL-D2·D3·D5, §6.14.7)
//
// 부록 D 표를 테스트 안에 리터럴로 옮겨 상수와 1:1 대조한다. 숫자가 안 맞으면 상수가 틀린 것이다.

import { describe, expect, it } from 'vitest';
import type { IndirectBase, RuleCode, RuleSeverity } from '@/types';
import {
  PRESET_IDS,
  RULE_PRESETS,
  isPresetId,
  presetToRows,
  type PresetId,
} from '@/lib/rules-presets';

type ExpectedRow = [RuleCode, boolean, number | null, IndirectBase | null, RuleSeverity];

/** 부록 D.1 `msit_profit` — 10행 */
const D1_MSIT_PROFIT: ExpectedRow[] = [
  ['allowance_max', true, 20, null, 'error'],
  ['indirect_max', true, 10, 'direct_cash_excl_intl_consign_burden', 'error'],
  ['consignment_max', true, 40, null, 'error'],
  ['external_tech_max', true, 40, null, 'warn'],
  ['indirect_cash_only', true, null, null, 'error'],
  ['no_personnel_support', true, null, null, 'warn'],
  ['no_student_personnel', true, null, null, 'warn'],
  ['no_burden', true, null, null, 'warn'],
  ['existing_personnel_cash', true, null, null, 'warn'],
  ['equipment_review_threshold', true, 30_000_000, null, 'warn'],
];

/** 부록 D.2 `moe_energy_sme` — 17행 (gov_share_max는 기본 원천기술형 75) */
const D2_MOE_ENERGY_SME: ExpectedRow[] = [
  ['allowance_max', true, 20, null, 'error'],
  ['allowance_min', true, 10, null, 'info'],
  ['indirect_max', true, 10, 'direct_cash_excl_intl', 'error'],
  ['consignment_max', true, 40, null, 'error'],
  ['external_tech_max', true, 40, null, 'warn'],
  ['gov_share_max', true, 75, null, 'error'],
  ['own_cash_min', true, 10, null, 'error'],
  ['indirect_cash_only', true, null, null, 'error'],
  ['no_personnel_support', true, null, null, 'warn'],
  ['no_student_personnel', true, null, null, 'warn'],
  ['no_burden', true, null, null, 'warn'],
  ['existing_personnel_cash', true, null, null, 'warn'],
  ['existing_cash_le_new', true, null, null, 'error'],
  ['min_participation', true, 10, null, 'error'],
  ['equipment_review_threshold', true, 30_000_000, null, 'warn'],
  ['material_notice_threshold', true, 20_000_000, null, 'warn'],
  ['outsourcing_notice_threshold', true, 30_000_000, null, 'warn'],
];

/** RL-D2: 값을 쓰지 않는 코드 */
const NO_VALUE_CODES: RuleCode[] = [
  'indirect_cash_only',
  'no_personnel_support',
  'no_student_personnel',
  'no_burden',
  'existing_personnel_cash',
  'existing_cash_le_new',
];

function toTable(presetId: PresetId): ExpectedRow[] {
  return RULE_PRESETS[presetId].rules.map((r) => [r.code, r.enabled, r.value, r.base, r.severity]);
}

// ─── D.1 · D.2 표 1:1 대조 ────────────────────────────────────────────────────

describe('RULE_PRESETS — 부록 D 표와 1:1', () => {
  it('msit_profit은 D.1 10행과 code·enabled·value·base·severity가 순서까지 같다', () => {
    expect(toTable('msit_profit')).toEqual(D1_MSIT_PROFIT);
    expect(RULE_PRESETS.msit_profit.rules).toHaveLength(10);
  });

  it('moe_energy_sme는 D.2 17행과 code·enabled·value·base·severity가 순서까지 같다', () => {
    expect(toTable('moe_energy_sme')).toEqual(D2_MOE_ENERGY_SME);
    expect(RULE_PRESETS.moe_energy_sme.rules).toHaveLength(17);
  });

  it('msit_profit에는 ㉡ 고유 코드가 없다 (D.1 표 그대로)', () => {
    const codes = new Set(RULE_PRESETS.msit_profit.rules.map((r) => r.code));
    for (const absent of [
      'gov_share_max',
      'own_cash_min',
      'allowance_min',
      'existing_cash_le_new',
      'min_participation',
      'material_notice_threshold',
      'outsourcing_notice_threshold',
    ] as RuleCode[]) {
      expect(codes.has(absent), `${absent}가 msit_profit에 있으면 안 된다`).toBe(false);
    }
  });

  it('프리셋 안에서 code가 중복되지 않는다 (RL-D1 — RPC가 거부한다)', () => {
    for (const id of PRESET_IDS) {
      const codes = RULE_PRESETS[id].rules.map((r) => r.code);
      expect(new Set(codes).size).toBe(codes.length);
    }
  });

  it('id 키와 rules.id가 일치하고 label·description이 비어 있지 않다', () => {
    for (const id of PRESET_IDS) {
      const preset = RULE_PRESETS[id];
      expect(preset.id).toBe(id);
      expect(preset.label.length).toBeGreaterThan(0);
      expect(preset.description.length).toBeGreaterThan(0);
    }
  });
});

// ─── source (RL-D5) ───────────────────────────────────────────────────────────

describe('source — RL-D5 출처 강제', () => {
  it('모든 행의 source가 비어 있지 않고 과기부고시/기후부고시 접두를 갖는다', () => {
    for (const id of PRESET_IDS) {
      for (const rule of RULE_PRESETS[id].rules) {
        expect(rule.source.trim().length, `${id}/${rule.code}`).toBeGreaterThan(0);
        expect(rule.source, `${id}/${rule.code}`).toMatch(/^(과기부고시|기후부고시) \S/);
      }
    }
  });

  it('접두 뒤에 고시 번호와 조문이 붙는다 (제2026-38호 / 제2026-29호)', () => {
    for (const rule of RULE_PRESETS.msit_profit.rules) {
      expect(rule.source).toMatch(/^과기부고시 제2026-38호 /);
    }
    for (const rule of RULE_PRESETS.moe_energy_sme.rules) {
      expect(rule.source).toMatch(/^(과기부고시 제2026-38호|기후부고시 제2026-29호) /);
    }
  });

  it('D.2에서 ㉡가 침묵한 항목은 ㉠ 출처를 그대로 적는다', () => {
    const byCode = new Map(RULE_PRESETS.moe_energy_sme.rules.map((r) => [r.code, r.source]));
    for (const code of ['consignment_max', 'indirect_cash_only', 'no_personnel_support', 'no_student_personnel', 'no_burden'] as RuleCode[]) {
      expect(byCode.get(code), code).toMatch(/^과기부고시 /);
    }
    for (const code of ['allowance_min', 'gov_share_max', 'own_cash_min', 'min_participation', 'existing_cash_le_new'] as RuleCode[]) {
      expect(byCode.get(code), code).toMatch(/^기후부고시 /);
    }
  });
});

// ─── 값·base 제약 (RL-D2 · RL-D3) ─────────────────────────────────────────────

describe('value · base — RL-D2 · RL-D3', () => {
  it('gov_share_max는 기본 75(원천기술형)이고 후보로 67(혁신제품형)만 갖는다', () => {
    const rule = RULE_PRESETS.moe_energy_sme.rules.find((r) => r.code === 'gov_share_max');
    expect(rule).toBeDefined();
    expect(rule!.value).toBe(75);
    expect(rule!.alternatives).toEqual([{ value: 67, label: '혁신제품형' }]);
  });

  it('gov_share_max 외에는 alternatives가 없다', () => {
    for (const id of PRESET_IDS) {
      for (const rule of RULE_PRESETS[id].rules) {
        if (rule.code === 'gov_share_max') continue;
        expect(rule.alternatives, `${id}/${rule.code}`).toBeUndefined();
      }
    }
  });

  it('두 프리셋의 indirect_max base가 서로 다르다 (㉠ 위탁·국제공동·부담비 제외 vs ㉡ 국제공동만 제외)', () => {
    const msit = RULE_PRESETS.msit_profit.rules.find((r) => r.code === 'indirect_max')!;
    const moe = RULE_PRESETS.moe_energy_sme.rules.find((r) => r.code === 'indirect_max')!;
    expect(msit.base).toBe('direct_cash_excl_intl_consign_burden');
    expect(moe.base).toBe('direct_cash_excl_intl');
    expect(msit.base).not.toBe(moe.base);
    // 둘 다 영리기관 10%
    expect(msit.value).toBe(10);
    expect(moe.value).toBe(10);
  });

  it('indirect_max만 base가 non-null이다 (RL-D3)', () => {
    for (const id of PRESET_IDS) {
      for (const rule of RULE_PRESETS[id].rules) {
        if (rule.code === 'indirect_max') expect(rule.base, `${id}/${rule.code}`).not.toBeNull();
        else expect(rule.base, `${id}/${rule.code}`).toBeNull();
      }
    }
  });

  it('값을 쓰지 않는 코드(indirect_cash_only·no_*·existing_*)는 value가 null이고, 나머지는 값이 있다 (RL-D2)', () => {
    for (const id of PRESET_IDS) {
      for (const rule of RULE_PRESETS[id].rules) {
        if (NO_VALUE_CODES.includes(rule.code)) {
          expect(rule.value, `${id}/${rule.code}`).toBeNull();
        } else {
          expect(rule.value, `${id}/${rule.code}`).not.toBeNull();
        }
      }
    }
  });

  it('비율 코드는 0~100, 금액 코드는 0 이상 정수다 (RL-D2 — 프리셋이 RPC check를 통과해야 한다)', () => {
    for (const id of PRESET_IDS) {
      for (const rule of RULE_PRESETS[id].rules) {
        if (rule.value === null) continue;
        if (rule.code.endsWith('_threshold')) {
          expect(Number.isInteger(rule.value), `${id}/${rule.code}`).toBe(true);
          expect(rule.value).toBeGreaterThanOrEqual(0);
        } else {
          expect(rule.value, `${id}/${rule.code}`).toBeGreaterThanOrEqual(0);
          expect(rule.value, `${id}/${rule.code}`).toBeLessThanOrEqual(100);
        }
      }
    }
  });

  it('모든 행이 enabled=true다 (프리셋은 검사를 끄지 않는다)', () => {
    for (const id of PRESET_IDS) {
      expect(RULE_PRESETS[id].rules.every((r) => r.enabled)).toBe(true);
    }
  });
});

// ─── D.3 안내 목록 ────────────────────────────────────────────────────────────

describe('advisories — 부록 D.3', () => {
  it('msit_profit은 공통(㉠) 17건', () => {
    expect(RULE_PRESETS.msit_profit.advisories).toHaveLength(17);
  });

  it('moe_energy_sme는 공통 17건 + 기후부 추가 12건 = 29건이며 공통이 앞에 온다', () => {
    const moe = RULE_PRESETS.moe_energy_sme.advisories;
    expect(moe).toHaveLength(29);
    expect(moe.slice(0, 17)).toEqual(RULE_PRESETS.msit_profit.advisories);
  });

  it('문장이 비어 있지 않고 중복이 없다', () => {
    for (const id of PRESET_IDS) {
      const list = RULE_PRESETS[id].advisories;
      expect(list.every((s) => s.trim().length > 0)).toBe(true);
      expect(new Set(list).size).toBe(list.length);
    }
  });

  it('판정하지 않는 이유가 있는 문장은 " — "로 이유를 붙인다 (D.3 대표 항목)', () => {
    const msit = RULE_PRESETS.msit_profit.advisories;
    expect(msit[0]).toBe('연구수당 1인 지급 ≤ 계상액의 70% (제26조⑥) — 개인별 지급 데이터 없음');
    expect(msit[msit.length - 1]).toBe('환급 가능 관세·부가세, 유흥성 비용, 현금·현물 중복, 직접비·간접비 중복 계상 금지 (제21조④)');
    const moeExtra = RULE_PRESETS.moe_energy_sme.advisories.slice(17);
    expect(moeExtra[0]).toBe('동시수행 과제 5개 이내, 책임자 3개 이내 (제18조②) — 앱 밖 과제 모름');
    expect(moeExtra[moeExtra.length - 1]).toBe('영리기관 계좌 일괄 흡수 후 3주 내 개인 지급 (별표 6 연구수당-10)');
  });
});

// ─── presetToRows ─────────────────────────────────────────────────────────────

describe('presetToRows — RPC apply_rule_preset 행', () => {
  it('행 수가 프리셋 규칙 수와 같고 키가 정확히 7개(code·enabled·value·base·severity·source·note)다', () => {
    for (const id of PRESET_IDS) {
      const rows = presetToRows(id);
      expect(rows).toHaveLength(RULE_PRESETS[id].rules.length);
      for (const row of rows) {
        expect(Object.keys(row).sort()).toEqual(['base', 'code', 'enabled', 'note', 'severity', 'source', 'value']);
      }
    }
  });

  it('alternatives는 행에 들어가지 않고 gov_share_max는 기본값 75로 나간다', () => {
    const rows = presetToRows('moe_energy_sme');
    for (const row of rows) expect('alternatives' in row).toBe(false);
    expect(rows.find((r) => r.code === 'gov_share_max')?.value).toBe(75);
  });

  it('note는 null(메모 보존)이고 나머지 값은 프리셋과 같다', () => {
    for (const id of PRESET_IDS) {
      const rows = presetToRows(id);
      RULE_PRESETS[id].rules.forEach((rule, i) => {
        expect(rows[i]).toEqual({
          code: rule.code,
          enabled: rule.enabled,
          value: rule.value,
          base: rule.base,
          severity: rule.severity,
          source: rule.source,
          note: null,
        });
      });
    }
  });

  it('호출마다 새 배열을 돌려주어 호출자가 고쳐도 상수가 오염되지 않는다', () => {
    const a = presetToRows('msit_profit');
    a[0]!.value = 999;
    expect(RULE_PRESETS.msit_profit.rules[0]!.value).toBe(20);
    expect(presetToRows('msit_profit')[0]!.value).toBe(20);
  });
});

// ─── isPresetId ───────────────────────────────────────────────────────────────

describe('isPresetId', () => {
  it('두 프리셋 id만 통과시킨다', () => {
    expect(isPresetId('msit_profit')).toBe(true);
    expect(isPresetId('moe_energy_sme')).toBe(true);
    expect(isPresetId('msit')).toBe(false);
    expect(isPresetId('')).toBe(false);
    expect(isPresetId(null)).toBe(false);
    expect(isPresetId(1)).toBe(false);
  });
});
