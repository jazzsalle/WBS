// 조직원 참여율 합산 테스트 (SOT §6.15 PS-1~PS-4, §11 Phase 16 행)
// "두 과제 60%·12개월 + 50%·12개월 → 110 error"는 §11의 검증 시나리오 그대로다.
// 판정은 원값이다(PS-4) — 정확히 100은 error가 아니고 정확히 90은 warn이 아니다.

import { describe, expect, it } from 'vitest';
import { computeStaffParticipation, type StaffParticipationInput } from '@/lib/participation';
import type { BudgetCategory, BudgetDetail, DetailFactor, Member, Project, Staff, Year } from '@/types';

// ─── 픽스처 헬퍼 ─────────────────────────────────────────────

const base = {
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-01T00:00:00Z',
  version: 1,
  createdBy: null,
  updatedBy: null,
};

let seq = 0;

function project(id: string, name: string, archived = false): Pick<Project, 'id' | 'name' | 'archived'> {
  return { id, name, archived };
}

function year(id: string, projectId: string, startDate: string | null): Year {
  return {
    ...base,
    id,
    projectId,
    stageId: `${projectId}-stage`,
    order: 0,
    name: '1차년도',
    goal: '',
    startDate,
    endDate: null,
    budget: null,
    status: 'planned',
  };
}

function staff(id: string, name: string, employed = true): Staff {
  return { ...base, id, name, email: `${id}@example.com`, position: '', employed, note: '', order: 0 };
}

function member(id: string, projectId: string, staffId: string | null): Member {
  return {
    ...base,
    id,
    projectId,
    orgId: null,
    name: id,
    role: 'researcher',
    position: '',
    field: '',
    email: '',
    phone: '',
    active: true,
    order: 0,
    annualSalary: null, // 참여율 합산은 금액을 보지 않는다 — null이어도 결과가 같아야 한다
    hireType: 'existing',
    staffId,
    salaryIncludesRetirement: null,
    salaryIncludesInsurance: null,
    salaryAppliedFrom: null,
  };
}

function personnelFactors(ratePercent: number, months: number): DetailFactor[] {
  return [
    { label: '참여율(%)', value: ratePercent, isPercent: true },
    { label: '참여기간(월)', value: months, isPercent: false },
  ];
}

function detail(spec: {
  projectId: string;
  yearId: string;
  memberId: string | null;
  factors?: DetailFactor[];
  category?: BudgetCategory;
  formula?: BudgetDetail['formula'];
}): BudgetDetail {
  seq += 1;
  return {
    ...base,
    id: `d${seq}`,
    projectId: spec.projectId,
    yearId: spec.yearId,
    category: spec.category ?? 'personnel',
    subcategory: 'personnel_internal',
    axis: 'cash',
    formula: spec.formula ?? 'personnel',
    memberId: spec.memberId,
    name: '',
    unitPrice: 0,
    spec: '',
    factors: spec.factors ?? [],
    adjustment: 0,
    note: '',
    order: seq,
    amount: -1, // 합산은 저장된 금액을 보지 않는다. 보면 이 값 때문에 깨진다
  };
}

/** 두 과제(A·B)에 조직원 한 명이 각각 Member로 참여하는 기본 픽스처. 연차는 둘 다 2026 시작 */
function twoProjects(spec: { a: [rate: number, months: number]; b: [rate: number, months: number] }): StaffParticipationInput {
  return {
    projects: [project('pA', '과제 A'), project('pB', '과제 B')],
    years: [year('yA', 'pA', '2026-01-01'), year('yB', 'pB', '2026-03-01')],
    staff: [staff('s1', '김연구')],
    members: [member('mA', 'pA', 's1'), member('mB', 'pB', 's1')],
    details: [
      detail({ projectId: 'pA', yearId: 'yA', memberId: 'mA', factors: personnelFactors(...spec.a) }),
      detail({ projectId: 'pB', yearId: 'yB', memberId: 'mB', factors: personnelFactors(...spec.b) }),
    ],
  };
}

function rowOf(result: ReturnType<typeof computeStaffParticipation>, staffId: string) {
  const row = result.rows.find((r) => r.staffId === staffId);
  if (!row) throw new Error(`row ${staffId} 없음`);
  return row;
}

// ─── PS-4 톤 경계 (§11 시나리오) ────────────────────────────────

describe('computeStaffParticipation — PS-4 합계 판정', () => {
  it('두 과제 60%·12개월 + 50%·12개월 → 110 error (§11 Phase 16)', () => {
    const result = computeStaffParticipation(twoProjects({ a: [60, 12], b: [50, 12] }), 2026);
    const row = rowOf(result, 's1');
    expect(row.byProject).toEqual({ pA: 60, pB: 50 });
    expect(row.total).toBe(110);
    expect(row.tone).toBe('error');
    expect(result.projects.map((p) => p.id)).toEqual(['pA', 'pB']);
    expect(result.unlinkedRowCount).toBe(0);
    expect(result.undatedRowCount).toBe(0);
  });

  it('45 + 50 → 95 warn', () => {
    const row = rowOf(computeStaffParticipation(twoProjects({ a: [45, 12], b: [50, 12] }), 2026), 's1');
    expect(row.total).toBe(95);
    expect(row.tone).toBe('warn');
  });

  it('정확히 90 → ok (90 초과만 warn)', () => {
    const row = rowOf(computeStaffParticipation(twoProjects({ a: [40, 12], b: [50, 12] }), 2026), 's1');
    expect(row.total).toBe(90);
    expect(row.tone).toBe('ok');
  });

  it('정확히 100 → warn (100 초과만 error)', () => {
    const row = rowOf(computeStaffParticipation(twoProjects({ a: [50, 12], b: [50, 12] }), 2026), 's1');
    expect(row.total).toBe(100);
    expect(row.tone).toBe('warn');
  });

  it('원값으로 판정한다 — 표시가 100.0이어도 100 이하면 warn', () => {
    // 50 + 49.99 × 12/12 = 99.99 → 소수 1자리 표시는 100.0이지만 초과가 아니다
    const row = rowOf(computeStaffParticipation(twoProjects({ a: [50, 12], b: [49.99, 12] }), 2026), 's1');
    expect(row.total).toBeCloseTo(99.99, 6);
    expect(row.tone).toBe('warn');
  });
});

// ─── PS-2 계상률·같은 Member 합산 ───────────────────────────────

describe('computeStaffParticipation — PS-2 연차별 계상률', () => {
  it('한 연차 두 행 10%·4개월 + 53%·8개월 → 38.6667 (원값 합산, 반올림 없음)', () => {
    const input: StaffParticipationInput = {
      projects: [project('pA', '과제 A')],
      years: [year('yA', 'pA', '2026-01-01')],
      staff: [staff('s1', '김연구')],
      members: [member('mA', 'pA', 's1')],
      details: [
        detail({ projectId: 'pA', yearId: 'yA', memberId: 'mA', factors: personnelFactors(10, 4) }),
        detail({ projectId: 'pA', yearId: 'yA', memberId: 'mA', factors: personnelFactors(53, 8) }),
      ],
    };
    const row = rowOf(computeStaffParticipation(input, 2026), 's1');
    // 10 × 4/12 + 53 × 8/12 = 3.3333… + 35.3333… = 38.6666…
    expect(row.byProject.pA).toBeCloseTo(38.6667, 4);
    expect(row.total).toBeCloseTo((10 * 4 + 53 * 8) / 12, 10);
    expect(row.tone).toBe('ok');
  });

  it('개월 인자가 없으면 12개월로 본다 (PL-1 기본과 같다)', () => {
    const input: StaffParticipationInput = {
      projects: [project('pA', '과제 A')],
      years: [year('yA', 'pA', '2026-01-01')],
      staff: [staff('s1', '김연구')],
      members: [member('mA', 'pA', 's1')],
      details: [
        detail({
          projectId: 'pA',
          yearId: 'yA',
          memberId: 'mA',
          factors: [{ label: '참여율(%)', value: 30, isPercent: true }],
        }),
      ],
    };
    expect(rowOf(computeStaffParticipation(input, 2026), 's1').total).toBe(30);
  });

  it('인자가 하나도 없으면 100% × 12개월 = 100 (연봉 전액과 같은 뜻)', () => {
    const input: StaffParticipationInput = {
      projects: [project('pA', '과제 A')],
      years: [year('yA', 'pA', '2026-01-01')],
      staff: [staff('s1', '김연구')],
      members: [member('mA', 'pA', 's1')],
      details: [detail({ projectId: 'pA', yearId: 'yA', memberId: 'mA', factors: [] })],
    };
    const row = rowOf(computeStaffParticipation(input, 2026), 's1');
    expect(row.total).toBe(100);
    expect(row.tone).toBe('warn');
  });
});

// ─── PS-1 대상 행·미연결 ────────────────────────────────────────

describe('computeStaffParticipation — PS-1 대상 행', () => {
  it('student_personnel 행은 무시한다 (카운트에도 넣지 않는다)', () => {
    const input = twoProjects({ a: [60, 12], b: [50, 12] });
    input.details.push(
      detail({ projectId: 'pA', yearId: 'yA', memberId: 'mA', category: 'student_personnel', factors: personnelFactors(100, 12) })
    );
    const result = computeStaffParticipation(input, 2026);
    expect(rowOf(result, 's1').total).toBe(110);
    expect(result.unlinkedRowCount).toBe(0);
  });

  it('quantity 행은 무시한다', () => {
    const input = twoProjects({ a: [60, 12], b: [50, 12] });
    input.details.push(
      detail({ projectId: 'pA', yearId: 'yA', memberId: null, formula: 'quantity', category: 'material', factors: [] })
    );
    const result = computeStaffParticipation(input, 2026);
    expect(rowOf(result, 's1').total).toBe(110);
    expect(result.unlinkedRowCount).toBe(0);
  });

  it('staffId가 null인 Member의 행은 합산 제외 + unlinkedRowCount', () => {
    const input = twoProjects({ a: [60, 12], b: [50, 12] });
    input.members.push(member('mX', 'pA', null));
    input.details.push(
      detail({ projectId: 'pA', yearId: 'yA', memberId: 'mX', factors: personnelFactors(100, 12) })
    );
    const result = computeStaffParticipation(input, 2026);
    expect(rowOf(result, 's1').total).toBe(110);
    expect(result.unlinkedRowCount).toBe(1);
  });

  it('memberId의 Member가 없거나 memberId가 null이면 unlinkedRowCount', () => {
    const input = twoProjects({ a: [60, 12], b: [50, 12] });
    input.details.push(
      detail({ projectId: 'pA', yearId: 'yA', memberId: 'ghost', factors: personnelFactors(100, 12) }),
      detail({ projectId: 'pA', yearId: 'yA', memberId: null, factors: personnelFactors(100, 12) })
    );
    const result = computeStaffParticipation(input, 2026);
    expect(rowOf(result, 's1').total).toBe(110);
    expect(result.unlinkedRowCount).toBe(2);
  });

  it('연결된 staffId가 조직원 목록에 없으면 이름을 붙일 수 없으므로 unlinkedRowCount', () => {
    const input = twoProjects({ a: [60, 12], b: [50, 12] });
    input.members.push(member('mY', 'pA', 'missing-staff'));
    input.details.push(
      detail({ projectId: 'pA', yearId: 'yA', memberId: 'mY', factors: personnelFactors(100, 12) })
    );
    const result = computeStaffParticipation(input, 2026);
    expect(result.rows.map((r) => r.staffId)).toEqual(['s1']);
    expect(result.unlinkedRowCount).toBe(1);
  });

  it('Member.active와 무관하다 — 예산에 남아 있으면 계상된 것 (PS-4)', () => {
    const input = twoProjects({ a: [60, 12], b: [50, 12] });
    input.members = input.members.map((m) => ({ ...m, active: false }));
    expect(rowOf(computeStaffParticipation(input, 2026), 's1').total).toBe(110);
  });
});

// ─── PS-3 달력 연도 배정 ────────────────────────────────────────

describe('computeStaffParticipation — PS-3 연도 배정', () => {
  it('startDate 없는 연차의 행은 undatedRowCount, 합산 제외', () => {
    const input = twoProjects({ a: [60, 12], b: [50, 12] });
    input.years = input.years.map((y) => (y.id === 'yB' ? { ...y, startDate: null } : y));
    const result = computeStaffParticipation(input, 2026);
    const row = rowOf(result, 's1');
    expect(row.byProject).toEqual({ pA: 60 });
    expect(row.total).toBe(60);
    expect(result.undatedRowCount).toBe(1);
    expect(result.projects.map((p) => p.id)).toEqual(['pA']);
  });

  it('아카이브 과제는 제외한다 (카운트에도 넣지 않는다)', () => {
    const input = twoProjects({ a: [60, 12], b: [50, 12] });
    input.projects = input.projects.map((p) => (p.id === 'pB' ? { ...p, archived: true } : p));
    const result = computeStaffParticipation(input, 2026);
    expect(rowOf(result, 's1').total).toBe(60);
    expect(result.projects.map((p) => p.id)).toEqual(['pA']);
    expect(result.unlinkedRowCount).toBe(0);
    expect(result.undatedRowCount).toBe(0);
  });

  it('2026-04-01 시작 연차(2027-03 종료)는 2026에 전부 들어간다 — 비례 배분 없음', () => {
    const input = twoProjects({ a: [60, 12], b: [50, 12] });
    input.years = input.years.map((y) => (y.id === 'yB' ? { ...y, startDate: '2026-04-01', endDate: '2027-03-31' } : y));
    expect(rowOf(computeStaffParticipation(input, 2026), 's1').byProject.pB).toBe(50);
    expect(rowOf(computeStaffParticipation(input, 2027), 's1').byProject.pB).toBeUndefined();
  });

  it('다른 해에 시작한 연차는 제외한다', () => {
    const input = twoProjects({ a: [60, 12], b: [50, 12] });
    input.years = input.years.map((y) => (y.id === 'yB' ? { ...y, startDate: '2027-01-01' } : y));
    const r2026 = computeStaffParticipation(input, 2026);
    expect(rowOf(r2026, 's1').byProject).toEqual({ pA: 60 });
    expect(r2026.projects.map((p) => p.id)).toEqual(['pA']);
    const r2027 = computeStaffParticipation(input, 2027);
    expect(rowOf(r2027, 's1').byProject).toEqual({ pB: 50 });
    expect(r2027.projects.map((p) => p.id)).toEqual(['pB']);
  });

  it('12-31 시작 연차는 그 해다 (문자열 앞 네 자리 — 타임존 영향 없음)', () => {
    const input = twoProjects({ a: [60, 12], b: [50, 12] });
    input.years = input.years.map((y) => (y.id === 'yB' ? { ...y, startDate: '2026-12-31' } : y));
    expect(rowOf(computeStaffParticipation(input, 2026), 's1').total).toBe(110);
  });
});

// ─── 출력 형태 ──────────────────────────────────────────────────

describe('computeStaffParticipation — 출력', () => {
  it('rows는 조직원 이름 순이고 그 해 행이 없는 조직원도 total 0 ok로 실린다', () => {
    const input = twoProjects({ a: [60, 12], b: [50, 12] });
    input.staff.push(staff('s2', '강퇴사', false), staff('s3', '박신입'));
    const result = computeStaffParticipation(input, 2026);
    expect(result.rows.map((r) => r.name)).toEqual(['강퇴사', '김연구', '박신입']);
    const idle = rowOf(result, 's2');
    expect(idle).toEqual({ staffId: 's2', name: '강퇴사', employed: false, byProject: {}, total: 0, tone: 'ok' });
  });

  it('year는 인자를 그대로 돌려주고 입력을 바꾸지 않는다', () => {
    const input = twoProjects({ a: [60, 12], b: [50, 12] });
    const snapshot = JSON.stringify(input);
    const result = computeStaffParticipation(input, 2026);
    expect(result.year).toBe(2026);
    expect(JSON.stringify(input)).toBe(snapshot);
  });

  it('과제 목록이 빠진 산출근거는 조용히 버리지 않고 던진다', () => {
    const input = twoProjects({ a: [60, 12], b: [50, 12] });
    input.projects = input.projects.filter((p) => p.id !== 'pB');
    expect(() => computeStaffParticipation(input, 2026)).toThrow(/pB/);
  });
});
