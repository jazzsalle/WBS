// 조직원 참여율 합산 (SOT §6.15 PS-1~PS-4). 순수 함수 — 입력은 호출부(actions/staff.ts)가 벌크로
// 읽어 넘기고(PS-5), 결과는 저장하지 않는다.
//
// 금액은 다루지 않는다. 참여율·개월 인자를 읽는 규칙은 lib/budget-plan.ts(PL-1)와 같아야 하므로
// 참여율은 `personnelParticipation`을 그대로 쓰고, 개월은 DetailRowEditor.splitPersonnelFactors와
// 같은 규칙(첫 비% 인자)으로 읽는다.

import { personnelParticipation } from '@/lib/budget-plan';
import type { BudgetDetail, DetailFactor, Member, Project, Staff, Year } from '@/types';

export type ParticipationTone = 'ok' | 'warn' | 'error';

export interface StaffParticipationRow {
  staffId: string;
  name: string;
  employed: boolean;
  /** 과제 id → 그 해 계상률(%). 값이 있는 과제만 실린다 */
  byProject: Record<string, number>;
  /** 전 과제 합(%). 원값 — 표시 반올림은 화면이 한다(PS-4) */
  total: number;
  tone: ParticipationTone;
}

export interface StaffParticipationInput {
  details: BudgetDetail[];
  members: Member[];
  years: Year[];
  projects: Pick<Project, 'id' | 'name' | 'archived'>[];
  staff: Staff[];
}

export interface StaffParticipation {
  year: number;
  /** 조직원 이름 순. 그 해 행이 없는 조직원도 total 0으로 실린다 */
  rows: StaffParticipationRow[];
  /** 그 해에 값이 있는 과제만, 이름 순 */
  projects: { id: string; name: string }[];
  /** PS-1: Member가 없거나 조직원에 연결되지 않은 인건비 행. 합산에서 빠졌음을 화면이 알린다 */
  unlinkedRowCount: number;
  /** PS-3: 연차 startDate가 없어 어느 해에도 넣지 못한 인건비 행 */
  undatedRowCount: number;
}

/**
 * 참여개월. PL-1이 인자를 `isPercent`로만 가르므로 첫 비% 인자가 개월이다(라벨은 행마다 다를 수 있다 —
 * 부록 A.5 주의 2). 없으면 12 — PL-1에서 개월 인자가 없는 행은 연봉 전액(12/12)이므로 금액과 같은 값이다.
 * [인건비] 탭(§7.9.6)의 참여개월 열도 이 함수로 읽는다 — 읽는 규칙이 두 곳이면 표와 합산이 어긋난다.
 */
export function personnelMonths(detail: { factors: readonly DetailFactor[] }): number {
  const factor = detail.factors.find((f) => !f.isPercent);
  return factor ? factor.value : 12;
}

/** PS-2: 연차별 계상률(%) = 참여율 × 개월 / 12. 중간 반올림 없음 */
function yearlyRate(detail: { factors: readonly DetailFactor[] }): number {
  return (personnelParticipation(detail) * personnelMonths(detail)) / 12;
}

/** PS-4: 원값으로 판정한다. 99.96처럼 표시가 100.0이어도 초과가 아니면 error가 아니다 */
function toneOf(total: number): ParticipationTone {
  if (total > 100) return 'error';
  if (total > 90) return 'warn';
  return 'ok';
}

// 'YYYY-MM-DD'의 앞 네 자리. Date 객체를 쓰면 타임존에 따라 12-31이 다음 해로 넘어갈 수 있다
function calendarYear(date: string): number {
  return Number(date.slice(0, 4));
}

/**
 * 조직원 × 달력 연도 참여율 매트릭스 (PS-1~PS-4).
 *
 * 걸러내는 순서: 아카이브 과제 → 비대상 행(quantity·학생인건비) → 연도(startDate 없음은 "연도 미정",
 * 다른 해는 제외) → 연결 여부(미연결은 "연결 안 된 행"). 연도를 먼저 보는 이유는 두 카운트가
 * "이 해 매트릭스에서 빠진 행"을 뜻해야 화면 안내(§7.18)와 맞기 때문이다.
 */
export function computeStaffParticipation(input: StaffParticipationInput, year: number): StaffParticipation {
  const projectById = new Map(input.projects.map((p) => [p.id, p]));
  const yearById = new Map(input.years.map((y) => [y.id, y]));
  const memberById = new Map(input.members.map((m) => [m.id, m]));
  const staffById = new Map(input.staff.map((s) => [s.id, s]));

  // staffId → projectId → 합(%)
  const matrix = new Map<string, Map<string, number>>();
  const usedProjects = new Set<string>();
  let unlinkedRowCount = 0;
  let undatedRowCount = 0;

  for (const detail of input.details) {
    if (detail.formula !== 'personnel' || detail.category === 'student_personnel') continue;

    // budget_details.project_id·year_id는 FK다 — 없으면 호출부가 벌크 조회를 빠뜨린 것이지 데이터가 아니다
    const project = projectById.get(detail.projectId);
    if (project === undefined) throw new Error(`과제를 찾을 수 없습니다: ${detail.projectId} (산출근거 ${detail.id})`);
    if (project.archived) continue;

    const detailYear = yearById.get(detail.yearId);
    if (detailYear === undefined) throw new Error(`연차를 찾을 수 없습니다: ${detail.yearId} (산출근거 ${detail.id})`);
    if (detailYear.startDate === null) {
      undatedRowCount += 1;
      continue;
    }
    if (calendarYear(detailYear.startDate) !== year) continue;

    // PS-1: Member가 없거나 staffId가 없으면 합산 불가. 연결된 staffId가 조직원 목록에 없는 경우도
    // 같다 — 이름을 붙일 수 없는 행을 매트릭스에 넣으면 누구 것인지 모르는 숫자가 된다
    const member = detail.memberId === null ? undefined : memberById.get(detail.memberId);
    const staff = member?.staffId == null ? undefined : staffById.get(member.staffId);
    if (staff === undefined) {
      unlinkedRowCount += 1;
      continue;
    }

    let byProject = matrix.get(staff.id);
    if (byProject === undefined) {
      byProject = new Map();
      matrix.set(staff.id, byProject);
    }
    byProject.set(detail.projectId, (byProject.get(detail.projectId) ?? 0) + yearlyRate(detail));
    usedProjects.add(detail.projectId);
  }

  const rows: StaffParticipationRow[] = [...input.staff]
    .sort((a, b) => a.name.localeCompare(b.name, 'ko') || a.id.localeCompare(b.id))
    .map((staff) => {
      const byProject: Record<string, number> = {};
      let total = 0;
      for (const [projectId, rate] of matrix.get(staff.id) ?? []) {
        byProject[projectId] = rate;
        total += rate;
      }
      return { staffId: staff.id, name: staff.name, employed: staff.employed, byProject, total, tone: toneOf(total) };
    });

  const projects = [...usedProjects]
    .map((id) => {
      const project = projectById.get(id)!; // 위 루프에서 존재를 확인한 id만 들어온다
      return { id, name: project.name };
    })
    .sort((a, b) => a.name.localeCompare(b.name, 'ko') || a.id.localeCompare(b.id));

  return { year, rows, projects, unlinkedRowCount, undatedRowCount };
}
