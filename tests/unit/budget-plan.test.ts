// 예산 제안 산출근거 테스트 (SOT §6.10 PL-1~PL-13, §5.17, 부록 A.5, 부록 B.7)
// 한도 판정(PL-14·PL-15)은 Phase 13에서 lib/rules.ts로 옮겨졌다 — tests/unit/rules.test.ts
// 부록 B.7의 숫자는 실측 워크북 `1차년도_250520` 시트가 담고 있는 값이다 —
// 구현이 다른 값을 내면 구현이 틀린 것이다.
// PL-2(중간 반올림 금지)는 §6.1 P-8·§6.2 D-5·§6.4 B-1과 같은 계열의 함정이라
// "틀린 경로가 내는 값"을 명시적으로 배제하는 회귀 테스트를 둔다.

import { describe, expect, it } from 'vitest';
import {
  DIRECT_CATEGORIES,
  aggregateDetails,
  buildYearTotals,
  computeAxisSplit,
  computeDetailAmount,
  evaluateBudgetRules,
  modifiedDirectCost,
  modifiedPersonnel,
  personnelParticipation,
  type BudgetDetailInput,
  type MemberSalaryInput,
} from '@/lib/budget-plan';
import { SUBCATEGORY_PRESETS } from '@/lib/constants';
import type { BudgetCategory, BudgetDetail, DetailAxis, DetailFactor, IndirectBase } from '@/types';

// ─── 픽스처 헬퍼 ─────────────────────────────────────────────

let seq = 0;

// BudgetDetail(§5.17) 전체를 만들어 넘긴다 — 계산 함수가 실제 엔티티를 그대로 받는지도 함께 고정한다
function detail(spec: {
  yearId?: string;
  category: BudgetCategory;
  subcategory?: string;
  axis?: DetailAxis;
  formula?: BudgetDetail['formula'];
  memberId?: string | null;
  name?: string;
  unitPrice?: number;
  factors?: DetailFactor[];
  adjustment?: number;
}): BudgetDetail {
  seq += 1;
  const formula = spec.formula ?? (spec.memberId ? 'personnel' : 'quantity');
  return {
    id: `d${seq}`,
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    version: 1,
    createdBy: null,
    updatedBy: null,
    projectId: 'p1',
    yearId: spec.yearId ?? 'y1',
    category: spec.category,
    subcategory: spec.subcategory ?? 'default',
    axis: spec.axis ?? 'cash',
    formula,
    memberId: spec.memberId ?? null,
    name: spec.name ?? '',
    unitPrice: spec.unitPrice ?? 0,
    spec: '',
    factors: spec.factors ?? [],
    adjustment: spec.adjustment ?? 0,
    note: '',
    order: seq,
    amount: -1, // PL-D7: 저장된 amount는 계산에 쓰이지 않는다. 쓰이면 이 값 때문에 테스트가 깨진다
  };
}

/** 인건비 인자 한 쌍 (부록 A.5 personnel 세목의 기본 인자) */
function personnelFactors(ratePercent: number, months: number): DetailFactor[] {
  return [
    { label: '참여율(%)', value: ratePercent, isPercent: true },
    { label: '참여기간(월)', value: months, isPercent: false },
  ];
}

function member(id: string, annualSalary: number | null): MemberSalaryInput {
  return { id, annualSalary };
}

// ─── 부록 B.7.1 인건비 19행 ──────────────────────────────────

// [성명, 연봉, 참여율, 축, 산식 결과, 조정액, 최종] — 부록 B.7.1 표 그대로.
// 참여기간은 9개월(신규채용1만 8개월)이다.
const PERSONNEL_ROWS: ReadonlyArray<
  readonly [string, number, number, DetailAxis, number, number, number, number]
> = [
  // 이름, 연봉, 참여율, 축, 개월, 산식 결과, 조정액, 최종
  ['여욱현', 180_000_000, 10.0, 'cash', 9, 13_500_000, 0, 13_500_000],
  ['김영', 90_000_000, 30.0, 'cash', 9, 20_250_000, 0, 20_250_000],
  ['김지웅', 90_000_000, 30.0, 'in_kind', 9, 20_250_000, 0, 20_250_000],
  ['박선욱', 74_000_000, 28.0, 'cash', 9, 15_540_000, 0, 15_540_000],
  ['지동민', 84_000_000, 64.0, 'in_kind', 9, 40_320_000, -270_000, 40_050_000],
  ['도상래', 64_000_000, 10.0, 'cash', 9, 4_800_000, 0, 4_800_000],
  ['이경아', 54_000_000, 70.0, 'in_kind', 9, 28_350_000, 0, 28_350_000],
  ['김다래', 54_000_000, 26.0, 'cash', 9, 10_530_000, -30_000, 10_500_000],
  ['김도현', 52_000_000, 10.0, 'cash', 9, 3_900_000, 0, 3_900_000],
  // 유태일·김형식의 조정액은 역산값이다. 원본 서식의 참고 열(−7,000/−6,000)을 그대로 쓰면
  // 최종이 5,190,500·13,370,250이 되어 실제 셀 값과 어긋난다 (부록 B.7.1 주석)
  ['유태일', 46_200_000, 15.0, 'cash', 9, 5_197_500, -7_500, 5_190_000],
  ['정우진', 51_000_000, 40.0, 'cash', 9, 15_300_000, 0, 15_300_000],
  ['김형식', 43_500_000, 41.0, 'cash', 9, 13_376_250, -6_250, 13_370_000],
  ['신나리', 38_000_000, 40.0, 'cash', 9, 11_400_000, 0, 11_400_000],
  ['양소희', 39_000_000, 30.0, 'cash', 9, 8_775_000, -5_000, 8_770_000],
  ['이다정', 41_100_000, 20.0, 'cash', 9, 6_165_000, -5_000, 6_160_000],
  ['안승현', 36_000_000, 14.0, 'cash', 9, 3_780_000, 0, 3_780_000],
  ['진호령', 33_000_000, 30.0, 'cash', 9, 7_425_000, -5_000, 7_420_000],
  ['장선우', 32_000_000, 29.0, 'cash', 9, 6_960_000, 0, 6_960_000],
  ['신규채용1(청년의무)', 51_000_000, 100.0, 'cash', 8, 34_000_000, 0, 34_000_000],
] as const;

const PERSONNEL_MEMBERS: MemberSalaryInput[] = PERSONNEL_ROWS.map(([name, salary]) =>
  member(name, salary)
);

function personnelDetails(): BudgetDetail[] {
  return PERSONNEL_ROWS.map(([name, , rate, axis, months, , adjustment]) =>
    detail({
      category: 'personnel',
      subcategory: 'personnel_internal',
      axis,
      formula: 'personnel',
      memberId: name,
      factors: personnelFactors(rate, months),
      adjustment,
    })
  );
}

// ─── 부록 B.7.2 연구활동비 5행 ───────────────────────────────

const ACTIVITY_ROWS: ReadonlyArray<
  readonly [string, string, number, DetailFactor[], number]
> = [
  ['activity_meeting', '회의비', 500_000, [{ label: '회', value: 6, isPercent: false }], 3_000_000],
  [
    'activity_software',
    'AEC Collection',
    540_000,
    [
      { label: '수량', value: 4, isPercent: false },
      { label: '월', value: 9, isPercent: false },
    ],
    19_440_000,
  ],
  [
    'activity_travel_dom',
    '국내출장비',
    150_000,
    [
      { label: '인원', value: 2, isPercent: false },
      { label: '횟수', value: 4, isPercent: false },
    ],
    1_200_000,
  ],
  [
    'activity_etc',
    '인쇄/복사/인화/슬라이드 제작',
    450_000,
    [{ label: '회', value: 2, isPercent: false }],
    900_000,
  ],
  ['activity_etc', '위탁정산 수수료', 2_480_000, [{ label: '회', value: 1, isPercent: false }], 2_480_000],
] as const;

function activityDetails(): BudgetDetail[] {
  return ACTIVITY_ROWS.map(([subcategory, name, unitPrice, factors]) =>
    detail({ category: 'activity', subcategory, name, unitPrice, factors })
  );
}

// ─── §6.10.1 PL-1 인건비 산식 ────────────────────────────────

describe('§6.10.1 PL-1 인건비 산식', () => {
  it('금액 = 연봉 × 참여율/100 × 개월/12 + 조정액', () => {
    const row = detail({
      category: 'personnel',
      subcategory: 'personnel_internal',
      formula: 'personnel',
      memberId: 'm1',
      factors: personnelFactors(30, 9),
    });
    expect(computeDetailAmount(row, member('m1', 90_000_000)).amount).toBe(20_250_000);
  });

  it('부록 A.5 personnel 세목의 기본 인자 구성(참여율 % + 참여기간 월)이 산식과 맞물린다', () => {
    for (const category of ['personnel', 'student_personnel'] as const) {
      for (const def of SUBCATEGORY_PRESETS[category]) {
        expect(def.formula).toBe('personnel');
        expect(def.defaultFactors.map((f) => f.isPercent)).toEqual([true, false]);
      }
    }
  });

  it('인자 0개면 곱이 1 — 연봉 전액 + 조정액 (참여율 100% · 12개월과 같다)', () => {
    const row = detail({
      category: 'personnel',
      subcategory: 'personnel_internal',
      formula: 'personnel',
      memberId: 'm1',
      factors: [],
      adjustment: -1_000,
    });
    expect(computeDetailAmount(row, member('m1', 60_000_000)).amount).toBe(59_999_000);

    const explicit = detail({
      category: 'personnel',
      formula: 'personnel',
      memberId: 'm1',
      factors: personnelFactors(100, 12),
      adjustment: -1_000,
    });
    expect(computeDetailAmount(explicit, member('m1', 60_000_000)).amount).toBe(59_999_000);
  });

  it('참여율 인자만 있으면 개월 곱이 없다 — 연봉 × 비율', () => {
    const row = detail({
      category: 'personnel',
      formula: 'personnel',
      memberId: 'm1',
      factors: [{ label: '참여율(%)', value: 50, isPercent: true }],
    });
    expect(computeDetailAmount(row, member('m1', 60_000_000)).amount).toBe(30_000_000);
  });

  it('PL-D1: personnel 행의 unitPrice는 무시하고 연봉만 단가로 쓴다', () => {
    const row = detail({
      category: 'personnel',
      formula: 'personnel',
      memberId: 'm1',
      unitPrice: 999_999_999, // 화면이 실수로 채워 넣어도 계산에 들어오지 않는다
      factors: personnelFactors(50, 12),
    });
    expect(computeDetailAmount(row, member('m1', 40_000_000)).amount).toBe(20_000_000);
  });

  it('연봉 미입력(annualSalary null)이면 금액 0 + 경고 플래그', () => {
    const row = detail({
      category: 'personnel',
      formula: 'personnel',
      memberId: 'm1',
      factors: personnelFactors(50, 12),
      adjustment: 1_000_000,
    });
    const result = computeDetailAmount(row, member('m1', null));
    expect(result.amount).toBe(0); // 단가를 모르면 조정액만 남은 금액은 근거가 없다
    expect(result.missingSalary).toBe(true);
    expect(result.negative).toBe(false);
  });

  it('member 자체가 없으면(PL-D1 위반) 같은 경고로 드러낸다 — 조용히 0원 행이 되지 않는다', () => {
    const row = detail({
      category: 'personnel',
      formula: 'personnel',
      memberId: 'm-missing',
      factors: personnelFactors(50, 12),
    });
    expect(computeDetailAmount(row).missingSalary).toBe(true);
    expect(computeDetailAmount(row, null).missingSalary).toBe(true);
  });
});

// ─── PL-2 중간 반올림 금지 (회귀) ────────────────────────────

describe('§6.10.1 PL-2 중간 반올림 금지', () => {
  const parkSeonuk = detail({
    category: 'personnel',
    subcategory: 'personnel_internal',
    formula: 'personnel',
    memberId: 'park',
    factors: personnelFactors(28, 9),
  });

  it('박선욱 74,000,000 × 28% × 9/12 = 15,540,000 (정확)', () => {
    const result = computeDetailAmount(parkSeonuk, member('park', 74_000_000));
    expect(result.amount).toBe(15_540_000);
    // 0.28이 이진수로 정확하지 않아 부동소수 잡음(±1e-9)이 남지만 0.5에 한참 못 미쳐 반올림을
    // 흔들지 못한다. 월액 선반올림 경로의 오차 0.84와는 크기가 다르다 — 그래서 PL-2가 중요하다
    expect(result.unrounded).toBeCloseTo(15_540_000, 6);
    expect(Math.abs(result.unrounded - 15_540_000)).toBeLessThan(0.5);
  });

  it('월액 선반올림 경로의 15,540,001이 나오면 틀린 것이다', () => {
    // 서식의 월액 열(연봉/12)은 표시용이다. 이것을 계산 입력으로 쓰면:
    const monthlyRounded = Math.round(74_000_000 / 12); // 6,166,667
    const wrong = Math.round(monthlyRounded * 0.28 * 9); // 15,540,000.84 → 15,540,001
    expect(monthlyRounded).toBe(6_166_667);
    expect(wrong).toBe(15_540_001);

    const result = computeDetailAmount(parkSeonuk, member('park', 74_000_000));
    expect(result.amount).not.toBe(wrong);
    expect(result.amount).toBe(15_540_000);
  });

  it('연봉/12가 나누어떨어지지 않는 3행에서 두 경로가 갈린다 — 전부 서식 값 쪽이 정답이다', () => {
    const details = personnelDetails();
    const { rows } = aggregateDetails(details, PERSONNEL_MEMBERS);

    const diverging = PERSONNEL_ROWS.filter(([, salary, rate, , months, , adjustment, final]) => {
      const wrong = Math.round(Math.round(salary / 12) * (rate / 100) * months + adjustment);
      return wrong !== final;
    }).map(([name]) => name);
    // 신나리 11,400,001 · 장선우 6,960,001도 월액 선반올림 경로에서 1원씩 튄다
    expect(diverging).toEqual(['박선욱', '신나리', '장선우']);

    // 갈리는 행에서도 구현은 서식의 최종 금액을 낸다
    for (const [i, row] of PERSONNEL_ROWS.entries()) {
      expect(rows[i]!.amount).toBe(row[7]);
    }
  });
});

// ─── PL-3 quantity 산식 ──────────────────────────────────────

describe('§6.10.1 PL-3 quantity 산식', () => {
  it('인자 0개 → 단가 + 조정액 (산식 없이 금액만 적는 간접비 세목)', () => {
    const row = detail({ category: 'indirect', subcategory: 'indirect_hr', unitPrice: 2_000_000 });
    expect(computeDetailAmount(row).amount).toBe(2_000_000);

    const adjusted = detail({
      category: 'indirect',
      subcategory: 'indirect_hr',
      unitPrice: 2_000_000,
      adjustment: -500,
    });
    expect(computeDetailAmount(adjusted).amount).toBe(1_999_500);
  });

  it('인자 1개 → 단가 × 값', () => {
    const row = detail({
      category: 'activity',
      subcategory: 'activity_meeting',
      unitPrice: 500_000,
      factors: [{ label: '회', value: 6, isPercent: false }],
    });
    expect(computeDetailAmount(row).amount).toBe(3_000_000);
  });

  it('인자 3개 → 전부 곱한다', () => {
    const row = detail({
      category: 'activity',
      subcategory: 'activity_travel_dom',
      unitPrice: 150_000,
      factors: [
        { label: '인원', value: 2, isPercent: false },
        { label: '횟수', value: 4, isPercent: false },
        { label: '일수', value: 3, isPercent: false },
      ],
    });
    expect(computeDetailAmount(row).amount).toBe(3_600_000);
  });

  it('isPercent 인자는 100으로 나눈다 — quantity에서도 개월 나눗셈은 없다', () => {
    const percentRow = detail({
      category: 'activity',
      subcategory: 'activity_etc',
      unitPrice: 1_000_000,
      factors: [{ label: '부담률(%)', value: 30, isPercent: true }],
    });
    expect(computeDetailAmount(percentRow).amount).toBe(300_000);

    // 같은 값 9가 personnel에서는 /12(9개월), quantity에서는 그대로 9다
    const months = detail({
      category: 'activity',
      subcategory: 'activity_software',
      unitPrice: 540_000,
      factors: [{ label: '월', value: 9, isPercent: false }],
    });
    expect(computeDetailAmount(months).amount).toBe(4_860_000);
  });

  it('소수 인자도 중간 반올림 없이 곱한다', () => {
    const row = detail({
      category: 'material',
      subcategory: 'material_purchase',
      unitPrice: 333_333,
      factors: [{ label: '수량', value: 1.5, isPercent: false }],
    });
    // 499,999.5 → PL-4의 단일 Math.round
    expect(computeDetailAmount(row).unrounded).toBeCloseTo(499_999.5, 6);
    expect(computeDetailAmount(row).amount).toBe(500_000);
  });
});

// ─── PL-4 / PL-5 ─────────────────────────────────────────────

describe('§6.10.1 PL-4·PL-5 반올림과 음수', () => {
  it('PL-4: 조정액을 더한 뒤 한 번만 반올림한다', () => {
    // 산식 결과 1,000.4 + 조정액 0.2 = 1,000.6 → 1,001.
    // 각각 반올림해 더하면 1,000 + 0 = 1,000이 되어 어긋난다
    const row = detail({
      category: 'activity',
      subcategory: 'activity_etc',
      unitPrice: 2_501,
      factors: [{ label: '회', value: 0.4, isPercent: false }],
      adjustment: 0.2,
    });
    expect(computeDetailAmount(row).amount).toBe(1_001);
    expect(Math.round(2_501 * 0.4) + Math.round(0.2)).toBe(1_000);
  });

  it('PL-5: 최종이 음수면 0으로 자르지 않고 오류 플래그를 실어 그대로 돌려준다', () => {
    const row = detail({
      category: 'activity',
      subcategory: 'activity_etc',
      unitPrice: 100_000,
      factors: [{ label: '회', value: 1, isPercent: false }],
      adjustment: -150_000,
    });
    const result = computeDetailAmount(row);
    expect(result.amount).toBe(-50_000);
    expect(result.negative).toBe(true);
  });

  it('PL-5: 조정액이 음수여도 최종이 양수면 오류가 아니다 (부록 B.7.1 7행)', () => {
    const negativeAdjustmentNames = ['지동민', '김다래', '유태일', '김형식', '양소희', '이다정', '진호령'];
    const rows = personnelDetails();
    const { rows: results } = aggregateDetails(rows, PERSONNEL_MEMBERS);

    const withNegativeAdjustment = PERSONNEL_ROWS.filter(([, , , , , , adj]) => adj < 0).map(
      ([name]) => name
    );
    expect(withNegativeAdjustment).toEqual(negativeAdjustmentNames);
    expect(results.every((r) => r.negative === false)).toBe(true);
  });

  it('금액 0은 -0이 되지 않는다', () => {
    const row = detail({ category: 'other', unitPrice: 0, adjustment: -0.2 });
    expect(Object.is(computeDetailAmount(row).amount, 0)).toBe(true);
  });
});

// ─── 부록 B.7.1 인건비 19행 ──────────────────────────────────

describe('부록 B.7.1 인건비 19행 (1차년도, 참여기간 9개월)', () => {
  const details = personnelDetails();
  const { rows } = aggregateDetails(details, PERSONNEL_MEMBERS);

  PERSONNEL_ROWS.forEach(([name, salary, rate, axis, months, formulaResult, adjustment, final], i) => {
    it(`${name} ${salary.toLocaleString()} × ${rate}% × ${months}/12 ${adjustment} → ${final.toLocaleString()}`, () => {
      const result = rows[i]!;
      expect(result.unrounded).toBeCloseTo(formulaResult + adjustment, 6);
      expect(result.amount).toBe(final);
      expect(details[i]!.axis).toBe(axis);
    });
  });

  it('기존인력 소계 = 현금 146,840,000 / 현물 88,650,000', () => {
    const existing = details.slice(0, 18); // 신규채용1 제외
    const { total } = aggregateDetails(existing, PERSONNEL_MEMBERS);
    expect(total.cashAmount).toBe(146_840_000);
    expect(total.inKindAmount).toBe(88_650_000);
  });

  it('인건비 셀 합계 = 현금 180,840,000 / 현물 88,650,000 / 계 269,490,000 (PL-7)', () => {
    const { cells } = aggregateDetails(details, PERSONNEL_MEMBERS);
    expect(cells).toHaveLength(1);
    const cell = cells[0]!;
    expect(cell.category).toBe('personnel');
    expect(cell.cashAmount).toBe(180_840_000);
    expect(cell.inKindAmount).toBe(88_650_000);
    expect(cell.plannedAmount).toBe(269_490_000);
    expect(cell.rowCount).toBe(19);
    expect(cell.negativeCount).toBe(0);
    expect(cell.missingSalaryCount).toBe(0);
  });

  it('PL-8: 셀 합계는 반올림된 행 금액의 합과 정확히 같다', () => {
    const { cells, rows: results } = aggregateDetails(details, PERSONNEL_MEMBERS);
    const handSum = results.reduce((s, r) => s + r.amount, 0);
    expect(cells[0]!.plannedAmount).toBe(handSum);
    // 실수 합계를 나중에 반올림한 경로와도 같은지 확인한다 — 갈리면 어느 쪽이든 화면과 어긋난다
    expect(handSum).toBe(269_490_000);
  });
});

// ─── 부록 B.7.2 연구활동비 ───────────────────────────────────

describe('부록 B.7.2 quantity 행 (연구활동비 1차년도)', () => {
  const details = activityDetails();
  const { rows } = aggregateDetails(details, []);

  ACTIVITY_ROWS.forEach(([subcategory, name, unitPrice, , amount], i) => {
    it(`${subcategory} ${name} ${unitPrice.toLocaleString()} → ${amount.toLocaleString()}`, () => {
      expect(rows[i]!.amount).toBe(amount);
    });
  });

  it('연구활동비 셀 합계 = 27,020,000 (현금)', () => {
    const { cells } = aggregateDetails(details, []);
    expect(cells[0]!.cashAmount).toBe(27_020_000);
    expect(cells[0]!.inKindAmount).toBe(0);
    expect(cells[0]!.plannedAmount).toBe(27_020_000);
  });

  it('PL-6: 세목 소계는 부록 A.5 프리셋 순서로 나온다 (⑪ 그 밖의 비용 2행 = 3,380,000)', () => {
    const { cells } = aggregateDetails(details, []);
    const subtotals = cells[0]!.subcategories;
    expect(subtotals.map((s) => s.subcategory)).toEqual([
      'activity_meeting', // ④
      'activity_travel_dom', // ⑤
      'activity_software', // ⑥
      'activity_etc', // ⑪
    ]);
    const etc = subtotals.find((s) => s.subcategory === 'activity_etc')!;
    expect(etc.rowCount).toBe(2);
    expect(etc.plannedAmount).toBe(3_380_000);
    expect(etc.cashAmount).toBe(3_380_000);
  });
});

// ─── PL-6 축별 분리 ──────────────────────────────────────────

describe('§6.10.2 PL-6·PL-7 축별 분리', () => {
  it('세목 소계도 현금/현물을 따로 낸다', () => {
    const details = [
      detail({
        category: 'personnel',
        subcategory: 'personnel_internal',
        axis: 'cash',
        formula: 'personnel',
        memberId: 'm1',
        factors: personnelFactors(50, 12),
      }),
      detail({
        category: 'personnel',
        subcategory: 'personnel_internal',
        axis: 'in_kind',
        formula: 'personnel',
        memberId: 'm2',
        factors: personnelFactors(25, 12),
      }),
      detail({
        category: 'personnel',
        subcategory: 'personnel_support',
        axis: 'in_kind',
        formula: 'personnel',
        memberId: 'm3',
        factors: personnelFactors(10, 12),
      }),
    ];
    const { cells } = aggregateDetails(details, [
      member('m1', 40_000_000),
      member('m2', 40_000_000),
      member('m3', 30_000_000),
    ]);
    const [internal, support] = cells[0]!.subcategories;
    expect(internal!.subcategory).toBe('personnel_internal');
    expect(internal!.cashAmount).toBe(20_000_000);
    expect(internal!.inKindAmount).toBe(10_000_000);
    expect(support!.subcategory).toBe('personnel_support');
    expect(support!.cashAmount).toBe(0);
    expect(support!.inKindAmount).toBe(3_000_000);
    expect(cells[0]!.plannedAmount).toBe(33_000_000);
  });

  it('셀은 (연차 등장 순, 부록 A.1 비목 순)으로 나온다', () => {
    const details = [
      detail({ yearId: 'y2', category: 'activity', unitPrice: 100 }),
      detail({ yearId: 'y1', category: 'indirect', unitPrice: 200 }),
      detail({ yearId: 'y2', category: 'personnel', formula: 'personnel', memberId: 'm1', factors: [] }),
      detail({ yearId: 'y1', category: 'material', unitPrice: 300 }),
    ];
    const { cells } = aggregateDetails(details, [member('m1', 12_000_000)]);
    expect(cells.map((c) => `${c.yearId}:${c.category}`)).toEqual([
      'y2:personnel',
      'y2:activity',
      'y1:material',
      'y1:indirect',
    ]);
  });

  it('연봉 미입력 행은 0원으로 합산되고 경고 수가 남는다', () => {
    const details = [
      detail({ category: 'personnel', formula: 'personnel', memberId: 'm1', factors: personnelFactors(50, 12) }),
      detail({ category: 'personnel', formula: 'personnel', memberId: 'm2', factors: personnelFactors(50, 12) }),
    ];
    const aggregate = aggregateDetails(details, [member('m1', 40_000_000), member('m2', null)]);
    expect(aggregate.total.plannedAmount).toBe(20_000_000);
    expect(aggregate.missingSalaryCount).toBe(1);
    expect(aggregate.cells[0]!.missingSalaryCount).toBe(1);
  });

  it('행이 하나도 없으면 셀도 없고 합계는 0이다', () => {
    const aggregate = aggregateDetails([], []);
    expect(aggregate.cells).toEqual([]);
    expect(aggregate.total).toEqual({ cashAmount: 0, inKindAmount: 0, plannedAmount: 0 });
  });
});

// ─── 부록 B.7.3 집계와 지침 검증 ─────────────────────────────
//
// 한도와의 비교(allowance_max·indirect_max 위반 여부)는 Phase 13에서 lib/rules.ts로 옮겨졌다 —
// 그 단언은 tests/unit/rules.test.ts에 있다. 여기는 값(E1·비율·수정직접비)만 고정한다.

describe('부록 B.7.3 지침 검증 (1차년도)', () => {
  // 인건비 19행 + 연구활동비 5행 + 간접비(연구실 안전관리비 2,000,000 × 1)
  const details: BudgetDetailInput[] = [
    ...personnelDetails(),
    ...activityDetails(),
    detail({
      category: 'indirect',
      subcategory: 'indirect_support',
      name: '연구실 안전관리비',
      unitPrice: 2_000_000,
      factors: [{ label: '회', value: 1, isPercent: false }],
    }),
  ];

  const yearTotals = buildYearTotals(aggregateDetails(details, PERSONNEL_MEMBERS).cells);
  const evaluation = evaluateBudgetRules(yearTotals, 'direct_cash_excl_intl_consign_burden');

  it('PL-11 수정인건비 E1 = 269,490,000 (인건비 + 학생인건비 0)', () => {
    // 실측 서식은 연구지원인력인건비(C)가 0이라 뺄 것이 없다 — 그래서 이 표만으로는
    // 세목 단위 제외 여부를 구분할 수 없다. 구분은 아래 'C > 0' describe가 한다
    expect(evaluation.personnelSupportTotal).toBe(0);
    expect(evaluation.modifiedPersonnel).toBe(269_490_000);
    expect(modifiedPersonnel(yearTotals)).toBe(269_490_000);
  });

  it('PL-12 연구수당 비율 = 0.00% (연구수당 0)', () => {
    expect(evaluation.allowanceTotal).toBe(0);
    expect(evaluation.allowanceRate).toBe(0);
  });

  it('PL-13 수정직접비 = 207,860,000 (인건비 현금 + 활동비 현금) — 두 base 모두 같다', () => {
    expect(evaluation.modifiedDirectCost).toBe(180_840_000 + 27_020_000);
    expect(evaluation.modifiedDirectCost).toBe(207_860_000);
    // promotion·other·위탁·국제공동·부담비가 전부 0이라 정의가 달라도 값이 같다 (PL-13 주석)
    expect(modifiedDirectCost(yearTotals, 'direct_cash_excl_intl')).toBe(207_860_000);
    expect(evaluation.indirectBase).toBe('direct_cash_excl_intl_consign_burden');
  });

  it('PL-13 간접비 비율 = 0.9622% (소수 4자리 일치)', () => {
    expect(evaluation.indirectTotal).toBe(2_000_000);
    expect(evaluation.indirectRate).not.toBeNull();
    expect(Math.round(evaluation.indirectRate! * 10_000) / 10_000).toBe(0.9622);
    expect(evaluation.indirectRate!).toBeCloseTo(0.962186, 6);
  });

  it('직접비 소계 296,510,000 / 연구개발비 총액 298,510,000', () => {
    expect(evaluation.directTotal).toBe(296_510_000);
    expect(evaluation.grandTotal).toBe(298_510_000);
  });
});

// ─── PL-11 연구지원인력인건비(C) 세목 단위 제외 (회귀) ──────

describe('§6.10.3 PL-11 연구지원인력인건비(C) — 세목 단위로 뺀다', () => {
  // 인건비: 내부 100,000,000(현금) + 연구지원인력 50,000,000(현금) + 연구지원인력 10,000,000(현물)
  // 학생인건비: 20,000,000(현금) / 연구수당 30,000,000(현금) / 간접비 1,000,000(현금)
  const details: BudgetDetailInput[] = [
    detail({
      category: 'personnel',
      subcategory: 'personnel_internal',
      formula: 'personnel',
      memberId: 'internal',
      factors: personnelFactors(100, 12),
    }),
    detail({
      category: 'personnel',
      subcategory: 'personnel_support',
      formula: 'personnel',
      memberId: 'support-cash',
      factors: personnelFactors(100, 12),
    }),
    detail({
      category: 'personnel',
      subcategory: 'personnel_support',
      axis: 'in_kind',
      formula: 'personnel',
      memberId: 'support-in-kind',
      factors: personnelFactors(100, 12),
    }),
    detail({
      category: 'student_personnel',
      subcategory: 'student_general',
      formula: 'personnel',
      memberId: 'student',
      factors: personnelFactors(100, 12),
    }),
    detail({ category: 'allowance', subcategory: 'default', unitPrice: 30_000_000 }),
    detail({ category: 'indirect', subcategory: 'indirect_hr', unitPrice: 1_000_000 }),
  ];
  const members = [
    member('internal', 100_000_000),
    member('support-cash', 50_000_000),
    member('support-in-kind', 10_000_000),
    member('student', 20_000_000),
  ];

  const yearTotals = buildYearTotals(aggregateDetails(details, members).cells);
  const evaluation = evaluateBudgetRules(yearTotals, 'direct_cash_excl_intl_consign_burden');

  it('buildYearTotals가 personnel_support 세목 소계를 현금+현물로 뽑는다', () => {
    expect(yearTotals.byCategory.personnel).toEqual({
      cashAmount: 150_000_000,
      inKindAmount: 10_000_000,
      plannedAmount: 160_000_000,
    });
    expect(yearTotals.personnelSupportTotal).toBe(60_000_000);
  });

  it('E1 = (인건비 160,000,000 − C 60,000,000) + 학생인건비 20,000,000 = 120,000,000', () => {
    expect(evaluation.personnelSupportTotal).toBe(60_000_000);
    expect(evaluation.modifiedPersonnel).toBe(120_000_000);
  });

  it('비목 단위로 더한 E1 180,000,000이 나오면 틀린 것이다 — 그 경로는 한도 초과를 놓친다', () => {
    // 틀린 경로: personnel 비목 전체 + student_personnel (C를 빼지 않는다)
    const wrongE1 = 160_000_000 + 20_000_000;
    const wrongRate = (30_000_000 / wrongE1) * 100; // 16.66…%
    expect(wrongE1).toBe(180_000_000);
    expect(wrongRate).toBeLessThan(20); // 한도 이내로 보인다 = 경고가 뜨지 않는다

    expect(evaluation.modifiedPersonnel).not.toBe(wrongE1);
    expect(evaluation.allowanceRate).not.toBeCloseTo(wrongRate, 6);
    // 올바른 비율 = 30,000,000 / 120,000,000 = 25% → allowance_max 20을 넘는다 (판정은 rules.test.ts)
    expect(evaluation.allowanceRate).toBe(25);
  });

  it('PL-13 수정직접비에는 C가 그대로 들어간다 — E1과 규정이 다르다', () => {
    // 수정직접비 = 인건비 현금 150,000,000(C 현금 50,000,000 포함) + 학생 20,000,000 + 연구수당 30,000,000
    expect(evaluation.modifiedDirectCost).toBe(200_000_000);
    // C를 빼면 150,000,000이 된다. 그 값이면 PL-11을 PL-13에 잘못 옮긴 것이다
    expect(evaluation.modifiedDirectCost).not.toBe(150_000_000);
    expect(evaluation.modifiedDirectCost - evaluation.personnelSupportTotal).toBe(140_000_000);
    // 현물 C 10,000,000은 수정직접비가 현금 기준이라 애초에 빠져 있다
    expect(evaluation.indirectRate).toBe(0.5); // 1,000,000 / 200,000,000
  });

  it('두 규칙이 같은 입력에서 서로 다른 답을 낸다는 사실 자체를 고정한다', () => {
    // E1은 C를 빼고(120,000,000), 수정직접비는 C를 넣는다(200,000,000).
    // 한쪽에 맞추려는 "일관성" 리팩터링이 들어오면 이 테스트가 깨져야 한다
    expect(evaluation.modifiedPersonnel).toBe(120_000_000);
    expect(evaluation.modifiedDirectCost).toBe(200_000_000);
  });
});

// ─── PL-11~PL-13 경계 ────────────────────────────────────────

describe('§6.10.3 PL-11~PL-13 경계', () => {
  function totals(
    spec: Partial<Record<BudgetCategory, [number, number]>>,
    personnelSupportTotal = 0
  ) {
    const sources = Object.entries(spec).map(([key, [cash, inKind]]) => {
      const amounts = { cashAmount: cash, inKindAmount: inKind, plannedAmount: cash + inKind };
      // personnel만 personnel_support 소계를 함께 요구한다 (PL-11) — 타입이 강제한다
      return key === 'personnel'
        ? { category: 'personnel' as const, ...amounts, personnelSupportTotal }
        : { category: key as Exclude<BudgetCategory, 'personnel'>, ...amounts };
    });
    return buildYearTotals(sources);
  }
  const MSIT: IndirectBase = 'direct_cash_excl_intl_consign_burden';
  const MOE: IndirectBase = 'direct_cash_excl_intl';

  it('PL-11: E1은 현금 + 현물이다 (학생인건비 포함)', () => {
    const evaluation = evaluateBudgetRules(
      totals({ personnel: [100_000_000, 50_000_000], student_personnel: [20_000_000, 0] }),
      MSIT
    );
    expect(evaluation.modifiedPersonnel).toBe(170_000_000);
  });

  it('PL-11: 비목 합계만 아는 경로는 C를 호출부가 명시한다 — 0은 "C가 없다"는 진술이다', () => {
    const declared = evaluateBudgetRules(
      totals({ personnel: [100_000_000, 0], student_personnel: [20_000_000, 0] }, 30_000_000),
      MSIT
    );
    expect(declared.modifiedPersonnel).toBe(90_000_000);
    expect(declared.modifiedDirectCost).toBe(120_000_000); // 수정직접비는 그대로 C 포함
  });

  it('PL-12: E1이 0이면 비율은 null이다 — 0으로 나누지 않는다', () => {
    const evaluation = evaluateBudgetRules(totals({ allowance: [5_000_000, 0] }), MSIT);
    expect(evaluation.modifiedPersonnel).toBe(0);
    expect(evaluation.allowanceRate).toBeNull();
  });

  it('PL-13: 수정직접비는 현금만 센다 — 현물은 빠진다', () => {
    const evaluation = evaluateBudgetRules(
      totals({ personnel: [100_000_000, 80_000_000], indirect: [5_000_000, 0] }),
      MSIT
    );
    expect(evaluation.modifiedDirectCost).toBe(100_000_000);
    expect(evaluation.indirectRate).toBe(5);
  });

  it('PL-13 정정: 직접비 11비목 전부가 출발점이다 — promotion·other 현금이 들어간다', () => {
    const yearTotals = totals({
      personnel: [100_000_000, 0],
      student_personnel: [10_000_000, 0],
      facility_equipment: [10_000_000, 0],
      material: [10_000_000, 0],
      activity: [10_000_000, 0],
      allowance: [10_000_000, 0],
      promotion: [1_000_000, 0],
      other: [2_000_000, 0],
      indirect: [15_000_000, 0],
    });
    const evaluation = evaluateBudgetRules(yearTotals, MSIT);
    // Phase 9의 6비목 합 150,000,000이 나오면 promotion·other가 빠진 옛 정의다
    const phase9Denominator = 150_000_000;
    expect(evaluation.modifiedDirectCost).toBe(153_000_000);
    expect(evaluation.modifiedDirectCost).not.toBe(phase9Denominator);
    expect(evaluation.indirectRate).toBeCloseTo((15_000_000 / 153_000_000) * 100, 9);
    expect(DIRECT_CATEGORIES).toHaveLength(11);
    expect(DIRECT_CATEGORIES).not.toContain('indirect');
  });

  it('PL-13·RL-3: 과기부 base는 위탁·국제공동·부담비를, 기후부 base는 국제공동만 뺀다', () => {
    const yearTotals = totals({
      personnel: [100_000_000, 0],
      international: [50_000_000, 0],
      consignment: [40_000_000, 0],
      burden: [30_000_000, 0],
      indirect: [10_000_000, 0],
    });
    expect(modifiedDirectCost(yearTotals, MSIT)).toBe(100_000_000);
    expect(modifiedDirectCost(yearTotals, MOE)).toBe(100_000_000 + 40_000_000 + 30_000_000);
    // 위탁이 있는 연차에서는 같은 간접비로 두 정의의 비율이 다르다 (부록 D 주석)
    expect(evaluateBudgetRules(yearTotals, MSIT).indirectRate).toBe(10);
    expect(evaluateBudgetRules(yearTotals, MOE).indirectRate).toBeCloseTo(
      (10_000_000 / 170_000_000) * 100,
      9
    );
    expect(evaluateBudgetRules(yearTotals, MOE).indirectBase).toBe(MOE);
    // 총액·직접비 소계는 base와 무관하다
    expect(evaluateBudgetRules(yearTotals, MSIT).grandTotal).toBe(230_000_000);
    expect(evaluateBudgetRules(yearTotals, MSIT).directTotal).toBe(220_000_000);
  });

  it('PL-13: 수정직접비가 0이면 비율은 null이다', () => {
    const evaluation = evaluateBudgetRules(totals({ indirect: [1_000_000, 0] }), MSIT);
    expect(evaluation.modifiedDirectCost).toBe(0);
    expect(evaluation.indirectRate).toBeNull();
  });

  it('P-8: 비율은 여기서 반올림하지 않는다', () => {
    const evaluation = evaluateBudgetRules(
      totals({ personnel: [300_000_000, 0], allowance: [100_000_000, 0] }),
      MSIT
    );
    expect(evaluation.allowanceRate).toBeCloseTo(33.3333333, 6);
    expect(evaluation.allowanceRate).not.toBe(33.3);
  });

  it('buildYearTotals: cash/inKind가 null인 BudgetItem은 0으로 본다 (S-4)', () => {
    const yearTotals = buildYearTotals([
      { category: 'activity', plannedAmount: 5_000_000, cashAmount: null, inKindAmount: null },
      { category: 'activity', plannedAmount: 1_000_000, cashAmount: 1_000_000, inKindAmount: 0 },
    ]);
    expect(yearTotals.byCategory.activity).toEqual({
      plannedAmount: 6_000_000,
      cashAmount: 1_000_000,
      inKindAmount: 0,
    });
  });
});

// ─── personnelParticipation — RL-16이 읽는 참여율 인자 ───────

describe('personnelParticipation — 참여율 인자 (PL-3 · RL-16)', () => {
  it("라벨 '참여율(%)'인 isPercent 인자를 읽는다", () => {
    expect(personnelParticipation({ factors: personnelFactors(30, 9) })).toBe(30);
  });

  it('라벨이 달라도 isPercent 인자가 하나뿐이면 그것이다 — 금액 계산(multiplyFactors)과 같은 인자', () => {
    expect(
      personnelParticipation({
        factors: [
          { label: '참여기간(월)', value: 9, isPercent: false },
          { label: '비율', value: 12.5, isPercent: true },
        ],
      })
    ).toBe(12.5);
  });

  it('백분율 인자가 없으면 100 — PL-1에서 인자 없는 행은 연봉 전액이다', () => {
    expect(personnelParticipation({ factors: [] })).toBe(100);
    expect(personnelParticipation({ factors: [{ label: '참여기간(월)', value: 6, isPercent: false }] })).toBe(100);
  });
});

// ─── §7.9 제안 모드 하단 — 현금/현물 비중 ────────────────────
//
// 핵심은 `unspecified`다. `cashAmount`·`inKindAmount`는 §5.12·S-4상 null(미입력)일 수 있고,
// 이것을 0으로 눙쳐 합산하면 사용자가 입력한 적 없는 '현물 0원'이 만들어진다 —
// 그러면 비중이 "현금 100% / 현물 0%"라는 거짓 진술이 된다. 그 경로를 명시적으로 배제한다.

describe('§7.9 computeAxisSplit — 현금/현물 비중', () => {
  it('전 셀이 축을 갖추면 비중을 낸다', () => {
    const split = computeAxisSplit([
      { plannedAmount: 60_000_000, cashAmount: 60_000_000, inKindAmount: 0 },
      { plannedAmount: 40_000_000, cashAmount: 10_000_000, inKindAmount: 30_000_000 },
    ]);
    expect(split.cash).toBe(70_000_000);
    expect(split.inKind).toBe(30_000_000);
    expect(split.unspecified).toBe(0);
    expect(split.total).toBe(100_000_000);
    expect(split.shareBlockedBy).toBeNull();
    expect(split.cashRate).toBe(70);
    expect(split.inKindRate).toBe(30);
  });

  it('현금/현물이 둘 다 null인 셀의 계획액은 unspecified로 남는다 (S-4)', () => {
    const split = computeAxisSplit([
      { plannedAmount: 5_000_000, cashAmount: null, inKindAmount: null },
    ]);
    expect(split.cash).toBe(0);
    expect(split.inKind).toBe(0);
    expect(split.unspecified).toBe(5_000_000);
    expect(split.total).toBe(5_000_000);
  });

  it('unspecified > 0이면 비중을 내지 않는다 — 미입력을 분모에 넣지 않는다', () => {
    const split = computeAxisSplit([
      { plannedAmount: 90_000_000, cashAmount: 90_000_000, inKindAmount: 0 },
      { plannedAmount: 10_000_000, cashAmount: null, inKindAmount: null },
    ]);
    expect(split.unspecified).toBe(10_000_000);
    expect(split.shareBlockedBy).toBe('unspecified');
    expect(split.cashRate).toBeNull();
    expect(split.inKindRate).toBeNull();
    // 확정된 금액 자체는 그대로 남는다 — 비중만 막고 사실은 보여준다
    expect(split.cash).toBe(90_000_000);
    expect(split.inKind).toBe(0);
    // 틀린 경로가 내는 값(미입력을 현금으로 눙친 100%)을 명시적으로 배제한다
    expect(split.cashRate).not.toBe(100);
  });

  it('한쪽 축만 채워진 셀은 §5.12상 나머지가 0이라 unspecified를 만들지 않는다', () => {
    const split = computeAxisSplit([
      { plannedAmount: 8_000_000, cashAmount: 8_000_000, inKindAmount: null },
      { plannedAmount: 2_000_000, cashAmount: null, inKindAmount: 2_000_000 },
    ]);
    expect(split.unspecified).toBe(0);
    expect(split.shareBlockedBy).toBeNull();
    expect(split.cashRate).toBe(80);
    expect(split.inKindRate).toBe(20);
  });

  it('현금 + 현물이 계획액과 어긋난 손상 데이터는 차액이 unspecified에 남아 드러난다', () => {
    const split = computeAxisSplit([
      { plannedAmount: 10_000_000, cashAmount: 6_000_000, inKindAmount: 1_000_000 },
    ]);
    expect(split.unspecified).toBe(3_000_000);
    expect(split.shareBlockedBy).toBe('unspecified');
    // 합은 언제나 계획액과 같다 — 어느 경우에도 금액이 조용히 사라지지 않는다
    expect(split.cash + split.inKind + split.unspecified).toBe(split.total);
  });

  it('계획액이 0이면 0으로 나누지 않고 이유를 구분해 돌려준다 (PL-12와 같은 태도)', () => {
    const split = computeAxisSplit([
      { plannedAmount: 0, cashAmount: 0, inKindAmount: 0 },
      { plannedAmount: 0, cashAmount: null, inKindAmount: null },
    ]);
    expect(split.total).toBe(0);
    expect(split.unspecified).toBe(0);
    expect(split.shareBlockedBy).toBe('zero-total');
    expect(split.cashRate).toBeNull();
  });

  it('소스가 없으면 전부 0이고 비중은 없다', () => {
    const split = computeAxisSplit([]);
    expect(split).toEqual({
      cash: 0,
      inKind: 0,
      unspecified: 0,
      total: 0,
      cashRate: null,
      inKindRate: null,
      shareBlockedBy: 'zero-total',
    });
  });

  it('산출근거 셀 합계(CellTotal)를 그대로 넣을 수 있다 — 축이 필수라 unspecified가 생기지 않는다 (§5.17)', () => {
    const { cells } = aggregateDetails(
      [
        detail({ category: 'activity', axis: 'cash', unitPrice: 3_000_000 }),
        detail({ category: 'activity', axis: 'in_kind', unitPrice: 1_000_000 }),
      ],
      []
    );
    const split = computeAxisSplit(cells);
    expect(split.unspecified).toBe(0);
    expect(split.cash).toBe(3_000_000);
    expect(split.inKind).toBe(1_000_000);
    expect(split.cashRate).toBe(75);
  });
});
