// 협약 예산 참여인원 모델 (SOT §5.23, §6.19 AG-5, 계획서 S-9~S-11·G-3/Q4b·합성 픽스처 "참여인원").
//
// 숫자는 계획서 픽스처 그대로다. 계산값은 PL-1(부록 B.7)과 같은 함수에서 나와야 한다 — 15,540,000이
// 15,540,001이 되면 월액 선반올림(PL-2 위반) 경로가 섞인 것이다.

import { describe, expect, it } from 'vitest';
import { computeDetailAmount } from '@/lib/budget-plan';
import {
  buildParticipantsView,
  classifyParticipantAmount,
  computeParticipantAmount,
  participantsTable,
  reconcileParticipants,
  resolveNewParticipant,
  resolveParticipantEdit,
} from '@/lib/agreement/participants';
import type { ParticipantFields, ReconcileLine, ViewParticipant } from '@/lib/agreement/participants';
import { assertTableModel, toTsv } from '@/lib/agreement/table';

// ─── 픽스처 ───────────────────────────────────────────────────────────────────

const M1_SALARY = 60_000_000;
const M2_SALARY = 50_000_000;

const YEARS = [
  { id: 'y2', name: '2차년도', order: 2 },
  { id: 'y1', name: '1차년도', order: 1 },
];
const MEMBERS = [
  { id: 'm2', name: '이연구', order: 2 },
  { id: 'm1', name: '김책임', order: 1 },
];

function p(id: string, fields: Partial<ParticipantFields> & Pick<ParticipantFields, 'yearId'>): ViewParticipant {
  return {
    id,
    memberId: null,
    participationRate: 0,
    months: 0,
    annualSalary: null,
    personnelCash: 0,
    personnelInKind: 0,
    role: '',
    ...fields,
  };
}

const M1_Y1 = p('p1', {
  memberId: 'm1', yearId: 'y1', participationRate: 50, months: 12, annualSalary: M1_SALARY,
  personnelCash: 30_000_000, role: '책임연구원',
});
const M1_Y2 = p('p2', {
  memberId: 'm1', yearId: 'y2', participationRate: 50, months: 12, annualSalary: M1_SALARY,
  personnelCash: 32_000_000, role: '책임연구원',
});
const M2_Y1 = p('p3', {
  memberId: 'm2', yearId: 'y1', participationRate: 20, months: 12, annualSalary: M2_SALARY, personnelInKind: 10_000_000,
});
const M2_Y2 = p('p4', {
  memberId: 'm2', yearId: 'y2', participationRate: 20, months: 12, annualSalary: M2_SALARY, personnelInKind: 10_000_000,
});
const UNASSIGNED_Y2 = p('p5', {
  memberId: null, yearId: 'y2', participationRate: 30, months: 6, annualSalary: null, personnelCash: 5_000_000,
});
// 입력 순서를 섞어 둔다 — 보기 정렬이 입력 순서에 기대지 않는지 본다
const BASE = [M2_Y2, M1_Y2, M2_Y1, M1_Y1];

// Phase 24 S-20 버전 A의 금액 줄 — 인건비 외 비목은 대조에서 빠져야 한다
const LINES: ReconcileLine[] = [
  { yearId: 'y1', category: 'personnel', axis: 'cash', amount: 30_000_000 },
  { yearId: 'y1', category: 'personnel', axis: 'in_kind', amount: 10_000_000 },
  { yearId: 'y1', category: 'material', axis: 'cash', amount: 5_000_000 },
  { yearId: 'y1', category: 'activity', axis: 'cash', amount: 1_200_000 },
  { yearId: 'y1', category: 'activity', axis: 'cash', amount: 800_000 },
  { yearId: 'y1', category: 'allowance', axis: 'cash', amount: 3_000_000 },
  { yearId: 'y1', category: 'indirect', axis: 'cash', amount: 2_500_000 },
  { yearId: 'y2', category: 'personnel', axis: 'cash', amount: 32_000_000 },
  { yearId: 'y2', category: 'personnel', axis: 'in_kind', amount: 10_000_000 },
  { yearId: 'y2', category: 'material', axis: 'cash', amount: 4_000_000 },
  { yearId: 'y2', category: 'activity', axis: 'cash', amount: 1_000_000 },
  { yearId: 'y2', category: 'allowance', axis: 'cash', amount: 3_000_000 },
  { yearId: 'y2', category: 'indirect', axis: 'cash', amount: 2_700_000 },
];

// ─── 계산값 (PL-1·PL-2·PL-4, 부록 B.7) ────────────────────────────────────────

describe('computeParticipantAmount', () => {
  it('부록 B.7 74,000,000 · 28% · 9개월 → 15,540,000 (월액 선반올림이면 15,540,001)', () => {
    expect(computeParticipantAmount({ annualSalary: 74_000_000, participationRate: 28, months: 9 })).toBe(15_540_000);
  });

  it('computeDetailAmount(personnel)와 같은 값 — 산식을 다시 쓰지 않는다', () => {
    const cases = [
      { annualSalary: 74_000_000, participationRate: 28, months: 9 },
      { annualSalary: 61_234_567, participationRate: 33.3, months: 7 },
      { annualSalary: 1, participationRate: 50, months: 1 },
    ];
    for (const c of cases) {
      const expected = computeDetailAmount(
        {
          yearId: 'y', category: 'personnel', subcategory: 'personnel_internal', axis: 'cash', formula: 'personnel',
          memberId: 'm', unitPrice: 0, adjustment: 0,
          factors: [
            { label: '참여율(%)', value: c.participationRate, isPercent: true },
            { label: '참여기간(월)', value: c.months, isPercent: false },
          ],
        },
        { id: 'm', annualSalary: c.annualSalary }
      ).amount;
      expect(computeParticipantAmount(c)).toBe(expected);
    }
  });

  it('연봉 null → null (0으로 계산하지 않는다)', () => {
    expect(computeParticipantAmount({ annualSalary: null, participationRate: 30, months: 6 })).toBeNull();
  });

  it.each([
    [{ annualSalary: 1, participationRate: 101, months: 1 }, '참여율'],
    [{ annualSalary: 1, participationRate: -1, months: 1 }, '참여율'],
    [{ annualSalary: 1, participationRate: Number.NaN, months: 1 }, '참여율'],
    [{ annualSalary: 1, participationRate: 10, months: 13 }, '개월'],
    [{ annualSalary: 1.5, participationRate: 10, months: 1 }, '연봉'],
    [{ annualSalary: -1, participationRate: 10, months: 1 }, '연봉'],
  ])('손상 입력 %o → 던진다', (input, word) => {
    expect(() => computeParticipantAmount(input)).toThrow(word);
  });
});

// ─── 구분 (S-9) ───────────────────────────────────────────────────────────────

describe('classifyParticipantAmount', () => {
  const b7 = { annualSalary: 74_000_000, participationRate: 28, months: 9, personnelInKind: 0 };

  it('부록 B.7: 15,540,000 → 자동, 15,540,001 → 수동', () => {
    expect(classifyParticipantAmount({ ...b7, personnelCash: 15_540_000 })).toBe('auto');
    expect(classifyParticipantAmount({ ...b7, personnelCash: 15_540_001 })).toBe('manual');
  });

  it('픽스처: M1 Y1 자동 · M1 Y2 수동(계산 30,000,000) · M2 현물 자동 · 미지정 연봉 모름', () => {
    expect(classifyParticipantAmount(M1_Y1)).toBe('auto');
    expect(computeParticipantAmount(M1_Y2)).toBe(30_000_000);
    expect(classifyParticipantAmount(M1_Y2)).toBe('manual');
    expect(classifyParticipantAmount(M2_Y1)).toBe('auto');
    expect(classifyParticipantAmount(M2_Y2)).toBe('auto');
    expect(classifyParticipantAmount(UNASSIGNED_Y2)).toBe('salary_unknown');
  });

  it('계산값이 현금·현물로 나뉘어 있으면 수동', () => {
    expect(
      classifyParticipantAmount({ ...M1_Y1, personnelCash: 20_000_000, personnelInKind: 10_000_000 })
    ).toBe('manual');
  });

  it('계산값 0 · 금액 0·0 → 자동, 연봉 모름 · 금액 0·0 → 연봉 모름', () => {
    expect(classifyParticipantAmount({ ...M1_Y1, participationRate: 0, personnelCash: 0 })).toBe('auto');
    expect(classifyParticipantAmount({ ...UNASSIGNED_Y2, personnelCash: 0 })).toBe('salary_unknown');
  });

  it('금액이 정수가 아니거나 음수면 던진다', () => {
    expect(() => classifyParticipantAmount({ ...M1_Y1, personnelCash: 1.5 })).toThrow('인건비 현금');
    expect(() => classifyParticipantAmount({ ...M1_Y1, personnelInKind: -1 })).toThrow('인건비 현물');
  });
});

// ─── 편집 해석 (G-3/Q4b) ──────────────────────────────────────────────────────

describe('resolveParticipantEdit / resolveNewParticipant (G-3 6케이스)', () => {
  it('① M1 Y1(자동) 참여율 60% → 현금 36,000,000 재계산', () => {
    const r = resolveParticipantEdit(M1_Y1, { participationRate: 60 });
    expect(r.amountRule).toBe('recalculated');
    expect(r.values).toMatchObject({ participationRate: 60, personnelCash: 36_000_000, personnelInKind: 0 });
    expect(r.kind).toBe('auto');
  });

  it('② M1 Y2(수동) 개월 10 → 32,000,000 유지', () => {
    const r = resolveParticipantEdit(M1_Y2, { months: 10 });
    expect(r.amountRule).toBe('kept');
    expect(r.values).toMatchObject({ months: 10, personnelCash: 32_000_000, personnelInKind: 0 });
    expect(r.kind).toBe('manual');
  });

  it('③ M2 Y1(현물 자동) 25% → 현물 12,500,000', () => {
    const r = resolveParticipantEdit(M2_Y1, { participationRate: 25 });
    expect(r.amountRule).toBe('recalculated');
    expect(r.values).toMatchObject({ personnelCash: 0, personnelInKind: 12_500_000 });
    expect(r.kind).toBe('auto');
  });

  it('④ 새 행(연봉 60M · 10% · 12개월 · 금액 없음) → 현금 6,000,000', () => {
    const r = resolveNewParticipant(
      { memberId: 'm1', yearId: 'y1', participationRate: 10, months: 12, role: '', annualSalary: 60_000_000 },
      M1_SALARY
    );
    expect(r.amountRule).toBe('recalculated');
    expect(r.values).toMatchObject({ annualSalary: 60_000_000, personnelCash: 6_000_000, personnelInKind: 0 });
    expect(r.kind).toBe('auto');
  });

  it('④-b 새 행 연봉을 비우면 그 시점 Member 연봉 스냅샷', () => {
    const r = resolveNewParticipant({ memberId: 'm1', yearId: 'y1', participationRate: 10, months: 12, role: '' }, M1_SALARY);
    expect(r.values).toMatchObject({ annualSalary: M1_SALARY, personnelCash: 6_000_000 });
  });

  it('⑤ 금액 7,000,000 명시 → 수동 (수정·추가 둘 다)', () => {
    const edit = resolveParticipantEdit(M1_Y1, { personnelCash: 7_000_000 });
    expect(edit.amountRule).toBe('explicit');
    expect(edit.values).toMatchObject({ personnelCash: 7_000_000, personnelInKind: 0 });
    expect(edit.kind).toBe('manual');

    const added = resolveNewParticipant(
      { memberId: 'm1', yearId: 'y1', participationRate: 10, months: 12, role: '', personnelCash: 7_000_000 },
      M1_SALARY
    );
    expect(added.amountRule).toBe('explicit');
    expect(added.values).toMatchObject({ annualSalary: M1_SALARY, personnelCash: 7_000_000, personnelInKind: 0 });
    expect(added.kind).toBe('manual');
  });

  it('⑥ 연봉 모름 · 금액 0 행에 연봉 40M → 40M×30%×6/12 = 6,000,000', () => {
    const zero = { ...UNASSIGNED_Y2, personnelCash: 0 };
    const r = resolveParticipantEdit(zero, { annualSalary: 40_000_000 });
    expect(r.amountRule).toBe('recalculated');
    expect(r.values).toMatchObject({ annualSalary: 40_000_000, personnelCash: 6_000_000, personnelInKind: 0 });
    expect(r.kind).toBe('auto');
  });

  it('연봉 모름이지만 금액이 있으면 연봉을 넣어도 금액 유지(사용자 값을 덮지 않는다)', () => {
    const r = resolveParticipantEdit(UNASSIGNED_Y2, { annualSalary: 40_000_000 });
    expect(r.amountRule).toBe('kept');
    expect(r.values.personnelCash).toBe(5_000_000);
    expect(r.kind).toBe('manual');
  });

  it('자동 행의 축: 둘 다 0이면 현금으로 재계산', () => {
    const zeroAuto = { ...M2_Y1, participationRate: 0, personnelInKind: 0 };
    expect(classifyParticipantAmount(zeroAuto)).toBe('auto');
    const r = resolveParticipantEdit(zeroAuto, { participationRate: 20 });
    expect(r.values).toMatchObject({ personnelCash: 10_000_000, personnelInKind: 0 });
  });

  it('자동 행에서 연봉을 지우면 계산값이 없어 금액 유지(0으로 덮지 않는다)', () => {
    const r = resolveParticipantEdit(M1_Y1, { annualSalary: null });
    expect(r.amountRule).toBe('kept');
    expect(r.values).toMatchObject({ annualSalary: null, personnelCash: 30_000_000 });
    expect(r.kind).toBe('salary_unknown');
  });

  it('인력·역할만 바꿔도 직전 구분대로 — 자동이면 같은 값으로 재계산', () => {
    const r = resolveParticipantEdit(M1_Y1, { memberId: null, role: '변경' });
    expect(r.amountRule).toBe('recalculated');
    expect(r.values).toMatchObject({ memberId: null, role: '변경', personnelCash: 30_000_000 });
  });

  it('새 행: 인력 미지정 · 연봉 모름 · 금액 없음 → 0·0, 연봉 모름', () => {
    const r = resolveNewParticipant({ memberId: null, yearId: 'y2', participationRate: 30, months: 6, role: '' }, null);
    expect(r.amountRule).toBe('kept');
    expect(r.values).toMatchObject({ annualSalary: null, personnelCash: 0, personnelInKind: 0 });
    expect(r.kind).toBe('salary_unknown');
  });

  it.each([
    [{ participationRate: 120 }, '참여율'],
    [{ months: 12.5 }, '개월'],
    [{ personnelCash: -1 }, '인건비 현금'],
    [{ personnelInKind: 0.5 }, '인건비 현물'],
    [{ role: 'x'.repeat(101) }, '역할'],
    [{ memberId: '' }, '인력'],
  ])('범위 밖 patch %o → 던진다', (patch, word) => {
    expect(() => resolveParticipantEdit(M1_Y1, patch)).toThrow(word);
  });

  it('미지정 행에 인력 연봉이 넘어오면 던진다', () => {
    expect(() =>
      resolveNewParticipant({ memberId: null, yearId: 'y1', participationRate: 10, months: 12, role: '' }, 1)
    ).toThrow('인력 미지정');
  });
});

// ─── 대조 (S-10) ──────────────────────────────────────────────────────────────

describe('reconcileParticipants', () => {
  it('기본 픽스처: 연차·축별 차이 0, 인건비 외 비목은 빼고 더한다', () => {
    const r = reconcileParticipants(BASE, LINES, YEARS);
    expect(r.years.map((y) => y.yearId)).toEqual(['y1', 'y2']);
    expect(r.years[0]).toMatchObject({
      participants: { cash: 30_000_000, inKind: 10_000_000 },
      lines: { cash: 30_000_000, inKind: 10_000_000 },
      diff: { cash: 0, inKind: 0 },
    });
    expect(r.years[1]!.lines).toEqual({ cash: 32_000_000, inKind: 10_000_000 });
    expect(r.total.diff).toEqual({ cash: 0, inKind: 0 });
    expect(r.hasDifference).toBe(false);
  });

  it('인력 미지정 Y2 현금 5,000,000 추가 → Y2 현금 +5,000,000', () => {
    const r = reconcileParticipants([...BASE, UNASSIGNED_Y2], LINES, YEARS);
    expect(r.years[0]!.diff).toEqual({ cash: 0, inKind: 0 });
    expect(r.years[1]!.diff).toEqual({ cash: 5_000_000, inKind: 0 });
    expect(r.total.diff).toEqual({ cash: 5_000_000, inKind: 0 });
    expect(r.hasDifference).toBe(true);
  });

  it('student_personnel 줄도 인건비로 센다', () => {
    const r = reconcileParticipants(
      BASE,
      [...LINES, { yearId: 'y1', category: 'student_personnel', axis: 'in_kind', amount: 1_000_000 }],
      YEARS
    );
    expect(r.years[0]!.diff).toEqual({ cash: 0, inKind: -1_000_000 });
  });

  it('모르는 연차·정수가 아닌 줄 금액 → 던진다', () => {
    expect(() => reconcileParticipants([{ ...M1_Y1, yearId: 'y9' }], [], YEARS)).toThrow('연차');
    expect(() =>
      reconcileParticipants([], [{ yearId: 'y9', category: 'personnel', axis: 'cash', amount: 1 }], YEARS)
    ).toThrow('연차');
    expect(() =>
      reconcileParticipants([], [{ yearId: 'y1', category: 'personnel', axis: 'cash', amount: 0.5 }], YEARS)
    ).toThrow('정수');
  });
});

// ─── 보기 모델·표 (S-9, AG-8) ─────────────────────────────────────────────────

describe('buildParticipantsView / participantsTable', () => {
  const view = buildParticipantsView({
    participants: [...BASE, UNASSIGNED_Y2],
    members: MEMBERS,
    years: YEARS,
    lines: LINES,
  });

  it('정렬: 인력 order(미지정 뒤) → 연차 order', () => {
    expect(view.rows.map((r) => r.id)).toEqual(['p1', 'p2', 'p3', 'p4', 'p5']);
    expect(view.rows.map((r) => r.memberLabel)).toEqual(['김책임', '김책임', '이연구', '이연구', '인력 미지정']);
  });

  it('행: 계산값·계·구분 라벨, 연봉 모름은 계산값 null', () => {
    expect(view.rows[0]).toMatchObject({ computed: 30_000_000, total: 30_000_000, kind: 'auto', kindLabel: '자동' });
    expect(view.rows[1]).toMatchObject({ computed: 30_000_000, total: 32_000_000, kind: 'manual', kindLabel: '수동' });
    expect(view.rows[2]).toMatchObject({ computed: 10_000_000, inKind: 10_000_000, kind: 'auto' });
    expect(view.rows[4]).toMatchObject({ computed: null, kind: 'salary_unknown', kindLabel: '연봉 모름' });
  });

  it('연차 소계·총계·대조', () => {
    expect(view.yearSubtotals).toEqual([
      { yearId: 'y1', yearName: '1차년도', rowCount: 2, cash: 30_000_000, inKind: 10_000_000, total: 40_000_000 },
      { yearId: 'y2', yearName: '2차년도', rowCount: 3, cash: 37_000_000, inKind: 10_000_000, total: 47_000_000 },
    ]);
    expect(view.grandTotal).toEqual({ cash: 67_000_000, inKind: 20_000_000, total: 87_000_000 });
    expect(view.reconciliation.years[1]!.diff).toEqual({ cash: 5_000_000, inKind: 0 });
  });

  it('과제에 없는 인력·연차, 같은 id 두 번 → 던진다', () => {
    const build = (participants: ViewParticipant[]) =>
      buildParticipantsView({ participants, members: MEMBERS, years: YEARS, lines: [] });
    expect(() => build([{ ...M1_Y1, memberId: 'm9' }])).toThrow('인력');
    expect(() => build([{ ...M1_Y1, yearId: 'y9' }])).toThrow('연차');
    expect(() => build([M1_Y1, M1_Y1])).toThrow('두 번');
  });

  it('표 모델: S-9 열, 데이터 5 + 연차 소계 2 + 총계 1, assertTableModel 통과', () => {
    const model = participantsTable(view, '참여인원 — 최종협약본');
    expect(() => assertTableModel(model)).not.toThrow();
    expect(model.columns.map((c) => c.label)).toEqual([
      '인력', '연차', '역할', '참여율(%)', '개월', '연봉 스냅샷', '계산값', '현금', '현물', '계', '구분',
    ]);
    expect(model.rows.map((r) => r.kind)).toEqual([
      'data', 'data', 'data', 'data', 'data', 'subtotal', 'subtotal', 'total',
    ]);
    const tsv = toTsv(model).split('\r\n');
    expect(tsv[5]).toBe('인력 미지정\t2차년도\t\t30\t6\t\t\t5000000\t0\t5000000\t연봉 모름');
    expect(tsv[7]).toBe('소계\t2차년도\t\t\t\t\t\t37000000\t10000000\t47000000\t');
    expect(tsv[8]).toBe('총계\t\t\t\t\t\t\t67000000\t20000000\t87000000\t');
  });

  it('참여인원이 없는 연차도 소계 0, 빈 보기도 표 모델이 유효', () => {
    const empty = buildParticipantsView({ participants: [], members: MEMBERS, years: YEARS, lines: LINES });
    expect(empty.yearSubtotals.map((y) => y.total)).toEqual([0, 0]);
    expect(empty.reconciliation.years[0]!.diff).toEqual({ cash: -30_000_000, inKind: -10_000_000 });
    expect(() => assertTableModel(participantsTable(empty, '빈'))).not.toThrow();
  });
});
