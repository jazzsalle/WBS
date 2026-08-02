// 성과·기술목표 달성률 테스트 (SOT §6.2 D-1~D-5, §6.3 T-1~T-4, 부록 B.2·B.3)
// 부록 B.2·B.3 수치를 소수 그대로 고정한다 — 중간 반올림하면 값이 달라진다(P-8).

import { describe, expect, it } from 'vitest';
import {
  computeDeliverableRate,
  computeDeliverableTotal,
  computeDeliverableYearRate,
  computeTechTargetRate,
  computeTechTargetTotal,
  formatRate,
  latestRecord,
  summarizeDeliverable,
  summarizeTechTarget,
  type DeliverableInput,
  type TechTargetInput,
} from '@/lib/goals';
import type { DeliverableAchievement, Direction, MeasureMethod, TechTargetRecord } from '@/types';

// ─── 픽스처 헬퍼 ─────────────────────────────────────────────

function achievements(yearIds: readonly (string | null)[]): DeliverableAchievement[] {
  return yearIds.map((yearId, i) => ({
    id: `a${i}`,
    version: 1,
    title: `산출물 ${i}`,
    date: '2026-03-01',
    yearId,
    orgId: null,
    memberIds: [],
    evidenceUrl: '',
    note: '',
  }));
}

function deliverable(spec: {
  targetTotal: number;
  targetByYear?: Record<string, number>;
  achieved?: readonly (string | null)[];
}): DeliverableInput {
  return {
    targetTotal: spec.targetTotal,
    targetByYear: spec.targetByYear ?? {},
    achievements: achievements(spec.achieved ?? []),
  };
}

function record(spec: {
  value: number;
  date?: string;
  id?: string;
  evaluator?: string;
  method?: MeasureMethod;
}): TechTargetRecord {
  return {
    id: spec.id ?? `r-${spec.value}`,
    version: 1,
    value: spec.value,
    date: spec.date ?? '2026-06-30',
    yearId: null,
    method: spec.method ?? 'self',
    evaluator: spec.evaluator ?? '한국산업기술시험원',
    evidenceUrl: '',
    note: '',
  };
}

function techTarget(spec: {
  direction: Direction;
  targetValue: number;
  baselineDomestic?: number | null;
  weight?: number;
  measureMethod?: MeasureMethod;
  records?: readonly TechTargetRecord[];
}): TechTargetInput {
  return {
    direction: spec.direction,
    targetValue: spec.targetValue,
    baselineDomestic: spec.baselineDomestic ?? null,
    weight: spec.weight ?? 100,
    measureMethod: spec.measureMethod ?? 'self',
    records: [...(spec.records ?? [])],
  };
}

// ─── 부록 B.3: 성과목표 달성률 ───────────────────────────────

describe('부록 B.3 성과목표 달성률', () => {
  // SCI 논문 4건(1차 1, 2차 3) 중 3건 달성
  const sciPaper = deliverable({
    targetTotal: 4,
    targetByYear: { y1: 1, y2: 3 },
    achieved: ['y1', 'y2', 'y2'],
  });
  // 국내 특허 출원 6건(1차 2, 2차 4) 중 7건 달성 — 초과
  const patent = deliverable({
    targetTotal: 6,
    targetByYear: { y1: 2, y2: 4 },
    achieved: ['y1', 'y1', 'y1', 'y2', 'y2', 'y2', 'y2'],
  });
  // SW 등록 2건(1차 0, 2차 2) 중 0건
  const swReg = deliverable({
    targetTotal: 2,
    targetByYear: { y1: 0, y2: 2 },
    achieved: [],
  });

  it('SCI 논문 = 3/4 = 75', () => {
    expect(computeDeliverableRate(sciPaper)).toBe(75);
    expect(formatRate(computeDeliverableRate(sciPaper))).toBe('75.0%');
  });

  it('국내 특허 = 7/6 = 116.666… (D-2 초과 허용, 클램프하지 않는다)', () => {
    const rate = computeDeliverableRate(patent);
    expect(rate).toBeCloseTo(116.6666667, 6);
    expect(rate).toBeGreaterThan(100);
    expect(formatRate(rate)).toBe('116.7%');
    expect(summarizeDeliverable(patent).overAchieved).toBe(true);
  });

  it('SW 등록 = 0/2 = 0', () => {
    expect(computeDeliverableRate(swReg)).toBe(0);
    expect(formatRate(0)).toBe('0.0%');
  });

  it('합계 = 10/12 = 83.333… (단순 합산, 지표별 가중 없음)', () => {
    const total = computeDeliverableTotal([sciPaper, patent, swReg]);
    expect(total.target).toBe(12);
    expect(total.achieved).toBe(10);
    expect(total.rate).toBeCloseTo(83.3333333, 6);
    expect(formatRate(total.rate)).toBe('83.3%');
    expect(total.anyYearTargetMismatch).toBe(false);
  });

  it('합계는 지표별 달성률의 평균이 아니다', () => {
    // (75 + 116.666… + 0) / 3 = 63.888… — 이 값이 나오면 구현이 틀린 것이다
    const total = computeDeliverableTotal([sciPaper, patent, swReg]);
    expect(total.rate).not.toBeCloseTo(63.8888889, 3);
  });

  it('연차 달성률 = 해당 연차 실적 / 해당 연차 목표', () => {
    expect(computeDeliverableYearRate(sciPaper, 'y1').rate).toBe(100); // 1/1
    expect(computeDeliverableYearRate(sciPaper, 'y2').rate).toBeCloseTo(66.6666667, 6); // 2/3
    expect(computeDeliverableYearRate(patent, 'y1').rate).toBe(150); // 3/2
  });
});

// ─── §6.2 D-1~D-5 ────────────────────────────────────────────

describe('§6.2 성과목표 규칙', () => {
  it('D-1: targetTotal이 0이면 N/A (0으로 나누지 않는다)', () => {
    const d = deliverable({ targetTotal: 0, achieved: ['y1'] });
    expect(computeDeliverableRate(d)).toBeNull();
    expect(summarizeDeliverable(d).rate).toBeNull();
    expect(formatRate(computeDeliverableRate(d))).toBe('N/A');
    // 실적이 0건이어도 마찬가지다 (NaN·Infinity 금지)
    expect(computeDeliverableRate(deliverable({ targetTotal: 0 }))).toBeNull();
  });

  it('D-1: 목표가 전부 0이면 과제 전체도 N/A', () => {
    const total = computeDeliverableTotal([deliverable({ targetTotal: 0, achieved: ['y1'] })]);
    expect(total.rate).toBeNull();
    expect(total.achieved).toBe(1);
  });

  it('D-2: 100 초과를 클램프하지 않는다', () => {
    const d = deliverable({ targetTotal: 1, achieved: ['y1', 'y1', 'y1'] });
    expect(computeDeliverableRate(d)).toBe(300);
    expect(summarizeDeliverable(d).overAchieved).toBe(true);
  });

  it('D-3: Σ targetByYear ≠ targetTotal이면 경고 (저장은 막지 않는다)', () => {
    const mismatch = deliverable({ targetTotal: 4, targetByYear: { y1: 1, y2: 1 } });
    expect(summarizeDeliverable(mismatch).yearTargetMismatch).toBe(true);
    expect(summarizeDeliverable(mismatch).rate).toBe(0); // 경고여도 계산은 한다

    const ok = deliverable({ targetTotal: 4, targetByYear: { y1: 1, y2: 3 } });
    expect(summarizeDeliverable(ok).yearTargetMismatch).toBe(false);

    // 연차 목표를 아직 배분하지 않은 상태도 불일치로 본다 (규칙 그대로)
    expect(summarizeDeliverable(deliverable({ targetTotal: 4 })).yearTargetMismatch).toBe(true);
    expect(summarizeDeliverable(deliverable({ targetTotal: 0 })).yearTargetMismatch).toBe(false);

    expect(
      computeDeliverableTotal([ok, mismatch]).anyYearTargetMismatch
    ).toBe(true);
  });

  it('D-4: yearId가 null인 실적은 연차 집계에서 빠지고 전체 집계에는 들어간다', () => {
    const d = deliverable({
      targetTotal: 4,
      targetByYear: { y1: 2, y2: 2 },
      achieved: ['y1', null, null],
    });
    expect(computeDeliverableRate(d)).toBe(75); // 3/4 — 전체는 포함
    expect(computeDeliverableYearRate(d, 'y1').achieved).toBe(1); // 연차는 제외
    expect(computeDeliverableYearRate(d, 'y1').rate).toBe(50);
    expect(computeDeliverableYearRate(d, 'y2').achieved).toBe(0);
    expect(summarizeDeliverable(d).unassignedAchieved).toBe(2);
  });

  it('D-5: 연차 목표가 0/없으면 N/A, 실적이 있으면 목표 외 달성', () => {
    const d = deliverable({
      targetTotal: 2,
      targetByYear: { y1: 0, y2: 2 },
      achieved: ['y1', 'y3'],
    });
    // 목표 0 + 실적 있음
    expect(computeDeliverableYearRate(d, 'y1')).toEqual({
      yearId: 'y1',
      target: 0,
      achieved: 1,
      rate: null,
      offTarget: true,
    });
    // 목표 키 자체가 없음 + 실적 있음
    expect(computeDeliverableYearRate(d, 'y3')).toEqual({
      yearId: 'y3',
      target: 0,
      achieved: 1,
      rate: null,
      offTarget: true,
    });
    // 목표 0 + 실적 없음 → N/A이되 목표 외 달성은 아니다
    const empty = deliverable({ targetTotal: 2, targetByYear: { y1: 0 } });
    expect(computeDeliverableYearRate(empty, 'y1')).toEqual({
      yearId: 'y1',
      target: 0,
      achieved: 0,
      rate: null,
      offTarget: false,
    });
    // 목표가 없는 연차도 byYear 목록에 나타나야 UI가 경고를 띄울 수 있다
    expect(summarizeDeliverable(d).byYear.map((y) => y.yearId)).toEqual(['y1', 'y2', 'y3']);
  });
});

// ─── 부록 B.2: 기술목표 달성률 ───────────────────────────────

describe('부록 B.2 기술목표 달성률', () => {
  const accuracy = techTarget({
    direction: 'higher_better',
    weight: 50,
    baselineDomestic: 75,
    targetValue: 90,
    records: [record({ value: 85 })],
  });
  const latency = techTarget({
    direction: 'lower_better',
    weight: 30,
    baselineDomestic: 200,
    targetValue: 50,
    records: [record({ value: 80 })],
  });
  const channels = techTarget({
    direction: 'higher_better',
    weight: 20,
    baselineDomestic: 4,
    targetValue: 16,
    records: [], // 미측정
  });

  it('객체 인식 정확도 = (85−75)/(90−75) = 66.666…', () => {
    const rate = computeTechTargetRate(accuracy);
    expect(rate).toBeCloseTo(66.6666667, 6);
    expect(formatRate(rate)).toBe('66.7%');
  });

  it('추론 지연시간 = (200−80)/(200−50) = 80.0', () => {
    expect(computeTechTargetRate(latency)).toBe(80);
    expect(formatRate(80)).toBe('80.0%');
  });

  it('동시 처리 채널 수 = 미측정 → null', () => {
    expect(computeTechTargetRate(channels)).toBeNull();
    expect(summarizeTechTarget(channels).measured).toBe(false);
    expect(formatRate(null)).toBe('N/A');
  });

  it('가중 달성률 = (66.666…×50 + 80×30 + 0×20)/100 = 57.333…', () => {
    const total = computeTechTargetTotal([accuracy, latency, channels]);
    expect(total.weightedRate).toBeCloseTo(57.3333333, 6);
    expect(total.totalWeight).toBe(100);
    expect(total.weightMismatch).toBe(false);
    expect(total.unmeasuredCount).toBe(1); // 미측정도 분모에 포함
    expect(formatRate(total.weightedRate)).toBe('57.3%');
  });

  it('P-8: 중간 반올림하면 57.4가 나온다 — 그 값이면 틀린 것이다', () => {
    const total = computeTechTargetTotal([accuracy, latency, channels]);
    // 66.666…을 66.7로 먼저 반올림한 계산: (66.7×50 + 80×30) / 100 = 57.35
    const roundedFirst = (66.7 * 50 + 80 * 30 + 0 * 20) / 100;
    expect(formatRate(roundedFirst)).toBe('57.4%');
    expect(total.weightedRate).not.toBeCloseTo(roundedFirst, 3);
    expect(formatRate(total.weightedRate)).not.toBe('57.4%');
  });
});

// ─── §6.3 direction × baselineDomestic 6조합 ─────────────────

describe('§6.3 direction × baselineDomestic 전 조합', () => {
  it('higher_better + baseline null → base 0, current/target*100', () => {
    const t = techTarget({
      direction: 'higher_better',
      baselineDomestic: null,
      targetValue: 200,
      records: [record({ value: 50 })],
    });
    expect(computeTechTargetRate(t)).toBe(25);
  });

  it('higher_better + baseline null + targetValue 0 → current >= 0이면 100', () => {
    const zeroTarget = (value: number) =>
      techTarget({
        direction: 'higher_better',
        baselineDomestic: null,
        targetValue: 0,
        records: [record({ value })],
      });
    expect(computeTechTargetRate(zeroTarget(0))).toBe(100);
    expect(computeTechTargetRate(zeroTarget(5))).toBe(100);
    expect(computeTechTargetRate(zeroTarget(-1))).toBe(0);
  });

  it('higher_better + baseline 있음 → (current−base)/(target−base)*100', () => {
    const t = techTarget({
      direction: 'higher_better',
      baselineDomestic: 75,
      targetValue: 90,
      records: [record({ value: 82.5 })],
    });
    expect(computeTechTargetRate(t)).toBe(50);
  });

  it('higher_better + targetValue === base → 도달 여부만 본다', () => {
    const at = (value: number) =>
      techTarget({
        direction: 'higher_better',
        baselineDomestic: 90,
        targetValue: 90,
        records: [record({ value })],
      });
    expect(computeTechTargetRate(at(90))).toBe(100);
    expect(computeTechTargetRate(at(95))).toBe(100);
    expect(computeTechTargetRate(at(89.9))).toBe(0);
  });

  it('T-2: lower_better + baseline null → 실적이 있어도 N/A', () => {
    const t = techTarget({
      direction: 'lower_better',
      baselineDomestic: null,
      targetValue: 50,
      records: [record({ value: 10 })], // 목표를 넘어서도 계산 불가
    });
    expect(computeTechTargetRate(t)).toBeNull();
    expect(summarizeTechTarget(t).measured).toBe(true); // 측정은 됐다
    expect(summarizeTechTarget(t).current).toBe(10);
  });

  it('lower_better + baseline 있음 → (base−current)/(base−target)*100', () => {
    const t = techTarget({
      direction: 'lower_better',
      baselineDomestic: 200,
      targetValue: 50,
      records: [record({ value: 125 })],
    });
    expect(computeTechTargetRate(t)).toBe(50);
  });

  it('lower_better + base === targetValue → 이하면 100', () => {
    const at = (value: number) =>
      techTarget({
        direction: 'lower_better',
        baselineDomestic: 50,
        targetValue: 50,
        records: [record({ value })],
      });
    expect(computeTechTargetRate(at(50))).toBe(100);
    expect(computeTechTargetRate(at(30))).toBe(100);
    expect(computeTechTargetRate(at(51))).toBe(0);
  });

  it('target_exact + baseline null → 허용오차 ±5%', () => {
    const at = (value: number) =>
      techTarget({
        direction: 'target_exact',
        baselineDomestic: null,
        targetValue: 100,
        records: [record({ value })],
      });
    expect(computeTechTargetRate(at(100))).toBe(100); // 정확히 일치
    expect(computeTechTargetRate(at(105))).toBe(100); // 경계 +5% 포함
    expect(computeTechTargetRate(at(95))).toBe(100); // 경계 −5% 포함
    expect(computeTechTargetRate(at(105.1))).toBe(0); // 경계 초과
    expect(computeTechTargetRate(at(94.9))).toBe(0);
  });

  it('target_exact + baseline 있음 → baseline은 계산에 영향이 없다', () => {
    const withBaseline = techTarget({
      direction: 'target_exact',
      baselineDomestic: 40,
      targetValue: 100,
      records: [record({ value: 104 })],
    });
    const withoutBaseline = techTarget({
      direction: 'target_exact',
      baselineDomestic: null,
      targetValue: 100,
      records: [record({ value: 104 })],
    });
    expect(computeTechTargetRate(withBaseline)).toBe(100);
    expect(computeTechTargetRate(withBaseline)).toBe(computeTechTargetRate(withoutBaseline));
  });

  it('target_exact + targetValue 0 → 허용오차 0, 완전 일치만 100', () => {
    const at = (value: number) =>
      techTarget({
        direction: 'target_exact',
        targetValue: 0,
        records: [record({ value })],
      });
    expect(computeTechTargetRate(at(0))).toBe(100);
    expect(computeTechTargetRate(at(0.0001))).toBe(0);
    expect(computeTechTargetRate(at(-0.0001))).toBe(0);
  });

  it('records가 비면 direction·baseline과 무관하게 null (미측정 판정이 T-2보다 먼저다)', () => {
    const directions: Direction[] = ['higher_better', 'lower_better', 'target_exact'];
    for (const direction of directions) {
      for (const baselineDomestic of [null, 10]) {
        expect(
          computeTechTargetRate(techTarget({ direction, baselineDomestic, targetValue: 90 }))
        ).toBeNull();
      }
    }
  });
});

// ─── §6.3 T-1 클램프 ─────────────────────────────────────────

describe('§6.3 T-1 클램프', () => {
  it('higher_better 초과 달성 → 300이 아니라 100', () => {
    const t = techTarget({
      direction: 'higher_better',
      baselineDomestic: 75,
      targetValue: 90,
      records: [record({ value: 120 })], // (120−75)/(90−75) = 300%
    });
    expect(computeTechTargetRate(t)).toBe(100);
  });

  it('higher_better 역행 → 음수가 아니라 0', () => {
    const t = techTarget({
      direction: 'higher_better',
      baselineDomestic: 75,
      targetValue: 90,
      records: [record({ value: 60 })], // (60−75)/15 = −100%
    });
    expect(computeTechTargetRate(t)).toBe(0);
    expect(formatRate(computeTechTargetRate(t))).toBe('0.0%');
  });

  it('lower_better 초과 달성 → 126.6…이 아니라 100', () => {
    const t = techTarget({
      direction: 'lower_better',
      baselineDomestic: 200,
      targetValue: 50,
      records: [record({ value: 10 })], // (200−10)/(200−50) = 126.666…
    });
    expect(computeTechTargetRate(t)).toBe(100);
  });

  it('lower_better 역행 → 0', () => {
    const t = techTarget({
      direction: 'lower_better',
      baselineDomestic: 200,
      targetValue: 50,
      records: [record({ value: 260 })],
    });
    expect(computeTechTargetRate(t)).toBe(0);
  });
});

// ─── 최신 레코드 선택 ────────────────────────────────────────

describe('현재 실적치 = 최신 레코드', () => {
  it('date가 가장 최신인 값을 쓴다 (입력 정렬을 신뢰하지 않는다)', () => {
    const records = [
      record({ id: 'r3', value: 70, date: '2026-09-01' }),
      record({ id: 'r1', value: 50, date: '2026-01-15' }),
      record({ id: 'r2', value: 60, date: '2026-05-20' }),
    ];
    expect(latestRecord(records)?.id).toBe('r3');
    const t = techTarget({
      direction: 'higher_better',
      baselineDomestic: null,
      targetValue: 140,
      records,
    });
    expect(computeTechTargetRate(t)).toBe(50); // 70/140
  });

  it('date 동률이면 배열 뒤쪽(created_at 오름차순의 나중 것)이 최신이다', () => {
    const records = [
      record({ id: 'first', value: 10, date: '2026-06-30' }),
      record({ id: 'second', value: 20, date: '2026-06-30' }),
    ];
    expect(latestRecord(records)?.id).toBe('second');
    expect(summarizeTechTarget(techTarget({
      direction: 'higher_better',
      targetValue: 40,
      records,
    })).current).toBe(20);
  });

  it('레코드가 없으면 null', () => {
    expect(latestRecord([])).toBeNull();
    const summary = summarizeTechTarget(techTarget({ direction: 'higher_better', targetValue: 10 }));
    expect(summary.current).toBeNull();
    expect(summary.latest).toBeNull();
    expect(summary.rate).toBeNull();
  });
});

// ─── §6.3 T-3 / T-4 ──────────────────────────────────────────

describe('§6.3 T-3 weight 합계', () => {
  const measured = (rateValue: number, weight: number) =>
    techTarget({
      direction: 'higher_better',
      baselineDomestic: null,
      targetValue: 100,
      weight,
      records: [record({ value: rateValue })],
    });

  it('Σweight = 120이면 경고 + 실제 합계로 정규화한다', () => {
    // 달성률 80(w=60), 40(w=60) → (80×60 + 40×60)/120 = 60
    const total = computeTechTargetTotal([measured(80, 60), measured(40, 60)]);
    expect(total.totalWeight).toBe(120);
    expect(total.weightMismatch).toBe(true);
    expect(total.weightedRate).toBe(60);
    // 100으로 나눴다면 72가 나온다 — 정규화하지 않은 것이다
    expect(total.weightedRate).not.toBe(72);
  });

  it('Σweight = 100이면 경고 없음', () => {
    const total = computeTechTargetTotal([measured(80, 50), measured(40, 50)]);
    expect(total.weightMismatch).toBe(false);
    expect(total.weightedRate).toBe(60);
  });

  it('Σweight = 0이면 0으로 나누지 않고 null + 경고', () => {
    const total = computeTechTargetTotal([measured(80, 0), measured(40, 0)]);
    expect(total.weightedRate).toBeNull();
    expect(total.weightMismatch).toBe(true);
    expect(formatRate(total.weightedRate)).toBe('N/A');
  });

  it('기술목표가 하나도 없으면 N/A이고 경고도 아니다', () => {
    const total = computeTechTargetTotal([]);
    expect(total.weightedRate).toBeNull();
    expect(total.weightMismatch).toBe(false);
  });

  it('T-2로 N/A가 된 항목도 0으로 가중하고 분모에 포함한다', () => {
    const naByT2 = techTarget({
      direction: 'lower_better',
      baselineDomestic: null,
      targetValue: 50,
      weight: 50,
      records: [record({ value: 10 })],
    });
    const total = computeTechTargetTotal([measured(80, 50), naByT2]);
    expect(total.weightedRate).toBe(40); // (80×50 + 0×50)/100
    expect(total.unmeasuredCount).toBe(1);
  });
});

describe('§6.3 T-4 공인시험 평가기관 누락', () => {
  const build = (measureMethod: MeasureMethod, evaluator: string) =>
    techTarget({
      direction: 'higher_better',
      baselineDomestic: null,
      targetValue: 100,
      measureMethod,
      records: [record({ value: 50, evaluator })],
    });

  it('certified_lab인데 최신 레코드의 evaluator가 비면 경고', () => {
    expect(summarizeTechTarget(build('certified_lab', '')).evaluatorMissing).toBe(true);
    expect(summarizeTechTarget(build('certified_lab', '   ')).evaluatorMissing).toBe(true);
    expect(computeTechTargetTotal([build('certified_lab', '')]).evaluatorMissingCount).toBe(1);
  });

  it('evaluator가 있거나 다른 측정방식이면 경고 없음', () => {
    expect(summarizeTechTarget(build('certified_lab', 'KTL')).evaluatorMissing).toBe(false);
    expect(summarizeTechTarget(build('self', '')).evaluatorMissing).toBe(false);
  });

  it('판정 대상은 최신 레코드다', () => {
    const t = techTarget({
      direction: 'higher_better',
      targetValue: 100,
      measureMethod: 'certified_lab',
      records: [
        record({ id: 'old', value: 40, date: '2026-01-01', evaluator: 'KTL' }),
        record({ id: 'new', value: 50, date: '2026-07-01', evaluator: '' }),
      ],
    });
    expect(summarizeTechTarget(t).evaluatorMissing).toBe(true);
  });

  it('레코드가 없으면 미측정 문제이지 T-4 경고가 아니다', () => {
    const t = techTarget({
      direction: 'higher_better',
      targetValue: 100,
      measureMethod: 'certified_lab',
    });
    expect(summarizeTechTarget(t).evaluatorMissing).toBe(false);
  });
});

// ─── P-8 표시 반올림 ─────────────────────────────────────────

describe('formatRate (표시 단계에서만 반올림)', () => {
  it('null은 N/A', () => {
    expect(formatRate(null)).toBe('N/A');
  });

  it('소수 첫째 자리까지 반올림한다', () => {
    expect(formatRate(66.6666666)).toBe('66.7%');
    expect(formatRate(57.3333333)).toBe('57.3%');
    expect(formatRate(83.3333333)).toBe('83.3%');
    expect(formatRate(116.6666666)).toBe('116.7%');
    expect(formatRate(100)).toBe('100.0%');
    expect(formatRate(0)).toBe('0.0%');
  });

  it('음수 0을 -0.0%로 표시하지 않는다', () => {
    expect(formatRate(-0)).toBe('0.0%');
  });
});
