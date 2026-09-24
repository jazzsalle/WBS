// 연구비 사용 규칙 프리셋 — 부록 D 상수 (SOT §5.18, §6.14.7, 부록 D)
//
// **값마다 조문 출처가 붙는다.** `source`를 `string`이 아니라 고시명 접두가 박힌 템플릿
// 리터럴로 두어, 출처 없는 값이 컴파일 단계에서 이 표에 들어오지 못하게 한다(RL-D5·PL-16).
//
// 프리셋은 과제별 행을 **만드는** 기본값일 뿐이다(RL-D4). `applyRulePreset`이 `presetToRows`로
// 행을 만들어 RPC `apply_rule_preset`에 넘기고, 그 뒤에는 행만 진실이다 — 이 상수를 고쳐도
// 이미 만들어진 행은 움직이지 않는다.
//
// 코드의 *의미*(무엇을 무엇으로 나누는가)는 `lib/rules.ts`의 RULE_SPECS가 갖는다. 여기는 값만.
// fetch·supabase·next 무의존. 단위 테스트: tests/unit/rules-presets.test.ts

import type { IndirectBase, RuleCode, RuleSeverity } from '@/types';

// ─── 타입 ─────────────────────────────────────────────────────────────────────

export type PresetId = 'msit_profit' | 'moe_energy_sme';

/**
 * RL-D5: 출처는 고시명 접두 + 공백 + 조문. 접두가 없는 문자열은 타입 오류다.
 * ㉠ 과학기술정보통신부고시 제2026-38호 「국가연구개발사업 연구개발비 사용 기준」
 * ㉡ 기후에너지환경부고시 제2026-29호 「에너지기술개발사업 공통 운영요령」
 */
export type RuleSource = `과기부고시 ${string}` | `기후부고시 ${string}`;

export interface PresetRule {
  code: RuleCode;
  enabled: boolean;
  value: number | null;
  base: IndirectBase | null;
  severity: RuleSeverity;
  source: RuleSource;
  /** 고시가 유형별로 값을 달리 정한 경우의 다른 후보. 행에는 들어가지 않고 편집 UI가 고르게 한다 */
  alternatives?: { value: number; label: string }[];
}

export interface RulePreset {
  id: PresetId;
  label: string;
  description: string;
  rules: PresetRule[];
  /** 부록 D.3 — 앱이 판정하지 않는 조항. 읽기 전용 안내이며 저장하지 않는다 */
  advisories: string[];
}

/** RPC `apply_rule_preset`의 `p_rows` 한 항목. alternatives는 행이 아니므로 빠진다 */
export interface PresetRow {
  code: RuleCode;
  enabled: boolean;
  value: number | null;
  base: IndirectBase | null;
  severity: RuleSeverity;
  source: RuleSource;
  /** null = 메모를 건드리지 않는다. RPC가 insert면 ''로, overwrite면 기존 메모를 보존한다 */
  note: string | null;
}

// ─── 출처 접두 ────────────────────────────────────────────────────────────────

const MSIT = '과기부고시 제2026-38호' as const;
const MOE = '기후부고시 제2026-29호' as const;

// ─── 부록 D.3 안내 목록 ───────────────────────────────────────────────────────

/** 공통(㉠). 부록 D.3 문장 그대로 — "— 판정하지 않는 이유"까지 포함 */
const ADVISORIES_MSIT: readonly string[] = [
  '연구수당 1인 지급 ≤ 계상액의 70% (제26조⑥) — 개인별 지급 데이터 없음',
  '연구수당 지급비율 − 직접비 사용비율 > 20%p 회수 (제26조⑦2) — 집행 단계, §13 20번',
  '총인건비계상률: 같은 사람의 전 과제 참여율 합 ≤ 월 100% (제65조⑦) — 과제 간 합산 없음, §13 23번',
  '인건비 월 급여에 연구수당·능률성과급 불포함 (제65조③) — 연봉 입력 시 사람이 뺀다',
  '신규채용의 "채용일부터 공고일까지 6개월 이내" (제65조④1) — 채용일·공고일 없음',
  '장비 현물 ≤ 구입가 20%, 구입 5년 이내, 내용연수 조건, 여러 과제 합 ≤ 구입가 (제66조①②) — 장비별 구입가·구입일 없음',
  '기술도입비 현물 ≤ 실제 도입비 50%, 도입 2년 이내 (제68조①) — 세목 없음',
  'SW 현물 ≤ 구입가 20%, 구입 5년 이내 (제68조②③) — SW별 구입가 없음',
  '연구실운영비: 소모성 비용 계상 금지, 사무용 기기·SW는 활용·관리계획 첨부 시만 (제68조④) — 품목 없음',
  '능률성과급 ≤ 과제 간접비 10% (제69조③) — `indirect_hr` 안에 성과급 구분 없음',
  '장비·SW 구입은 종료일 2개월 전까지 (제23조⑥·제25조⑨) — 집행일 비교는 수행 모드',
  '원래계획 대비 변경 시 사전승인: 총액·연도별 정부/기관부담·간접비 증액·연구수당 증액·위탁 20% 증액·3천만 원 장비 변경 (제73조①) — 원래계획 스냅샷 없음',
  '연구혁신비 ≤ (재료비+활동비) 10%·연차 평균 5천만 원 (제25조의2) — 세목 없음, §13 21번',
  '보안수당 ≤ 개인 인건비 3% (제26조의2) — 세목 없음, §13 21번',
  // 부록 D.3에서는 한 글머리표에 " / "로 묶여 있으나 체크리스트 항목으로는 별개다
  '참여연구자만 참석하는 회의의 식비 계상 금지 (제25조④)',
  '회의비 10만 원 이하 증빙 간소화 (제25조⑤)',
  '환급 가능 관세·부가세, 유흥성 비용, 현금·현물 중복, 직접비·간접비 중복 계상 금지 (제21조④)',
];

/** 기후부 에너지기술개발사업(㉡) 추가 */
const ADVISORIES_MOE_EXTRA: readonly string[] = [
  '동시수행 과제 5개 이내, 책임자 3개 이내 (제18조②) — 앱 밖 과제 모름',
  '사업조정비 ≤ 정부지원금 10% (제23조⑤) — 항목 없음',
  '창업초기(3년 미만) 중소기업은 기존인력 인건비 현금 가능 (별표 5 인건비 나) — 사업개시일 없음',
  '인건비 현금 인정 분야(별표 4) 평가단 인정 시 현금 가능 (별표 5 인건비 다) — 인정 여부 없음. 해당하면 `existing_personnel_cash`를 끄고 note에 적는다',
  '연구지원전문가 1명, 신규 100% / 기존 50% 현금 (별표 5 간접비) — 역할 없음',
  '기술도입비 ≤ 총 연구개발비 30%(해외 50%) (별표 5 연구활동비) — 세목 없음',
  '표준연계 과제 표준화 비용 ≤ 1억 원 (별표 5 지식재산) — 플래그 없음',
  '연구수당 개인별 ≤ 개인 인건비 70% (별표 6 연구수당-7) — 개인별 배분 없음',
  '단계·최종평가 미흡 시 연구수당 50% 감액 (별표 5) — 평가 결과 없음',
  '3천만 원 이상 장비 변경·1억 원 경계 승인 (제25조②9) — 원래계획 스냅샷 없음',
  '직접비 사용비율 ≤ 50%인 과제의 간접비 사용비율 초과 회수 (별표 6 간접비-6) — 집행 단계, §13 20번',
  '영리기관 계좌 일괄 흡수 후 3주 내 개인 지급 (별표 6 연구수당-10)',
];

// ─── 부록 D.1 · D.2 ───────────────────────────────────────────────────────────

export const RULE_PRESETS: Record<PresetId, RulePreset> = {
  msit_profit: {
    id: 'msit_profit',
    label: '과기부 공통 기준 · 영리기관',
    description:
      '과학기술정보통신부고시 제2026-38호만으로 만든 프리셋. 부처 고유 요령이 없는 과제, 또는 기후부 외 부처 과제의 출발점.',
    rules: [
      { code: 'allowance_max', enabled: true, value: 20, base: null, severity: 'error', source: `${MSIT} 제26조①` },
      {
        code: 'indirect_max',
        enabled: true,
        value: 10,
        base: 'direct_cash_excl_intl_consign_burden',
        severity: 'error',
        source: `${MSIT} 제2조 9호 · 제63조 · 제114조④`,
      },
      { code: 'consignment_max', enabled: true, value: 40, base: null, severity: 'error', source: `${MSIT} 제27조①` },
      { code: 'external_tech_max', enabled: true, value: 40, base: null, severity: 'warn', source: `${MSIT} 제25조② (근사, RL-7)` },
      { code: 'indirect_cash_only', enabled: true, value: null, base: null, severity: 'error', source: `${MSIT} 제64조③` },
      { code: 'no_personnel_support', enabled: true, value: null, base: null, severity: 'warn', source: `${MSIT} 제6조 2호 · 제15조 1호` },
      { code: 'no_student_personnel', enabled: true, value: null, base: null, severity: 'warn', source: `${MSIT} 제7조` },
      { code: 'no_burden', enabled: true, value: null, base: null, severity: 'warn', source: `${MSIT} 제29조` },
      { code: 'existing_personnel_cash', enabled: true, value: null, base: null, severity: 'warn', source: `${MSIT} 제65조④` },
      {
        code: 'equipment_review_threshold',
        enabled: true,
        value: 30_000_000,
        base: null,
        severity: 'warn',
        source: `${MSIT} 제23조④ (ZEUS 공동활용 확인)`,
      },
    ],
    advisories: [...ADVISORIES_MSIT],
  },

  moe_energy_sme: {
    id: 'moe_energy_sme',
    label: '기후부 에너지기술개발사업 · 중소기업',
    description:
      '기후에너지환경부고시 제2026-29호가 과기부고시 위에 얹는 값. 기후부고시가 침묵한 항목은 과기부고시 값을 그대로 가져온다.',
    rules: [
      { code: 'allowance_max', enabled: true, value: 20, base: null, severity: 'error', source: `${MOE} 별표 5 연구수당 (= ${MSIT} 제26조①)` },
      {
        code: 'allowance_min',
        enabled: true,
        value: 10,
        base: null,
        severity: 'info',
        source: `${MOE} 별표 5 연구수당 "중소·중견기업 10% 이상 권고"`,
      },
      {
        code: 'indirect_max',
        enabled: true,
        value: 10,
        base: 'direct_cash_excl_intl',
        severity: 'error',
        source: `${MOE} 별표 5 간접비 "수정직접비(직접비 현금 총액에서 국제공동연구개발비를 제외한 금액)의 10% 이내"`,
      },
      { code: 'consignment_max', enabled: true, value: 40, base: null, severity: 'error', source: `${MSIT} 제27조①` },
      { code: 'external_tech_max', enabled: true, value: 40, base: null, severity: 'warn', source: `${MOE} 별표 5 연구활동비 (= ${MSIT} 제25조②)` },
      {
        // 기본은 원천기술형 75. 혁신제품형이면 사용자가 67을 고른다 (부록 D.2)
        code: 'gov_share_max',
        enabled: true,
        value: 75,
        base: null,
        severity: 'error',
        source: `${MOE} 제22조② 표 · 제22조⑥`,
        alternatives: [{ value: 67, label: '혁신제품형' }],
      },
      { code: 'own_cash_min', enabled: true, value: 10, base: null, severity: 'error', source: `${MOE} 제23조③ 표` },
      { code: 'indirect_cash_only', enabled: true, value: null, base: null, severity: 'error', source: `${MSIT} 제64조③` },
      { code: 'no_personnel_support', enabled: true, value: null, base: null, severity: 'warn', source: `${MSIT} 제6조 2호` },
      { code: 'no_student_personnel', enabled: true, value: null, base: null, severity: 'warn', source: `${MSIT} 제7조` },
      { code: 'no_burden', enabled: true, value: null, base: null, severity: 'warn', source: `${MSIT} 제29조` },
      {
        code: 'existing_personnel_cash',
        enabled: true,
        value: null,
        base: null,
        severity: 'warn',
        source: `${MOE} 별표 5 인건비 현금/현물 계상 기준`,
      },
      {
        code: 'existing_cash_le_new',
        enabled: true,
        value: null,
        base: null,
        severity: 'error',
        source: `${MOE} 별표 5 인건비 현금 계상 가 · 별표 6 인건비-1자`,
      },
      { code: 'min_participation', enabled: true, value: 10, base: null, severity: 'error', source: `${MOE} 제18조② · 별표 6-17` },
      { code: 'equipment_review_threshold', enabled: true, value: 30_000_000, base: null, severity: 'warn', source: `${MOE} 제29조①` },
      {
        code: 'material_notice_threshold',
        enabled: true,
        value: 20_000_000,
        base: null,
        severity: 'warn',
        source: `${MOE} 제25조②18 · 제29조의2`,
      },
      { code: 'outsourcing_notice_threshold', enabled: true, value: 30_000_000, base: null, severity: 'warn', source: `${MOE} 제28조⑦` },
    ],
    advisories: [...ADVISORIES_MSIT, ...ADVISORIES_MOE_EXTRA],
  },
};

export const PRESET_IDS: readonly PresetId[] = ['msit_profit', 'moe_energy_sme'];

export function isPresetId(value: unknown): value is PresetId {
  return typeof value === 'string' && (PRESET_IDS as readonly string[]).includes(value);
}

// ─── 행 변환 ──────────────────────────────────────────────────────────────────

/**
 * RPC `apply_rule_preset`의 `p_rows`. note는 null — 덮어쓰기는 값을 되돌리는 것이지 사용자가
 * 행에 적어 둔 메모("평가단 인정으로 현금 가능" 등)를 지우는 것이 아니다.
 */
export function presetToRows(presetId: PresetId): PresetRow[] {
  return RULE_PRESETS[presetId].rules.map(({ code, enabled, value, base, severity, source }) => ({
    code,
    enabled,
    value,
    base,
    severity,
    source,
    note: null,
  }));
}
