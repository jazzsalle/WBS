'use server';

// Help · Tutorial 서버 액션 (SOT §9 "Help · Tutorial", §7.16 HP-5, §7.17)
// 반환은 ActionResult<T> — 예외를 그대로 던지지 않는다. 도움말은 DB를 읽지 않지만 인증 뒤에만
// 열린다(HP-5) — 미들웨어 예외 없음, 액션도 SA-1 가드를 그대로 탄다.

import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { ActionResult } from '@/types';
import { requireApprovedUser } from '@/lib/auth/guard';
import {
  NotFoundError,
  ValidationError,
  toActionFailure,
  type ActionErrorCode,
} from '@/lib/db/errors';
import { HELP_SLUGS } from '@/lib/help';
import type { TutorialServerStatus } from '@/lib/tutorial';
import { SAMPLE_DESCRIPTION_FIRST_LINE, SAMPLE_PROJECT_PREFIX } from '@/lib/tutorial';
import type { HelpDocument } from '@/lib/content';
import { readHelpDocument } from '@/lib/content';
import * as projectsRepo from '@/lib/db/projects';
import * as stagesRepo from '@/lib/db/stages';
import * as yearsRepo from '@/lib/db/years';
import * as membersRepo from '@/lib/db/members';
import * as tasksRepo from '@/lib/db/tasks';
import * as deliverablesRepo from '@/lib/db/deliverables';
import * as techTargetsRepo from '@/lib/db/tech-targets';
import * as milestonesRepo from '@/lib/db/milestones';
import * as budgetDetailsRepo from '@/lib/db/budget-details';
import * as budgetRulesRepo from '@/lib/db/budget-rules';
import { createProject } from '@/actions/projects';
import { createYear, updateYear } from '@/actions/years';
import { createMember, createOrganization, setProjectPM } from '@/actions/team';
import { createTask } from '@/actions/tasks';
import { createDeliverable, createTechTarget } from '@/actions/goals';
import { generateDefaultMilestones } from '@/actions/milestones';
import { createBudgetDetail } from '@/actions/budget-plan';
import { applyRulePreset } from '@/actions/budget-rules';

export type { HelpDocument } from '@/lib/content';

const helpSlugSchema = z.enum(HELP_SLUGS);

// ─── 도움말 (§7.16) ───────────────────────────────────────────────────────────

/** content/help/<slug>.md → 제목·intro·AST. 없는 slug·파일은 실패로 돌려준다(빈 문서 폴백 없음) */
export async function getHelpDocument(slug: unknown): Promise<ActionResult<HelpDocument>> {
  try {
    await requireApprovedUser();
    const parsed = helpSlugSchema.safeParse(slug);
    if (!parsed.success) {
      throw new ValidationError(`알 수 없는 도움말입니다: ${String(slug)}`);
    }
    return { ok: true, data: await readHelpDocument(parsed.data) };
  } catch (e) {
    // 파일 부재·형식 위반은 RepositoryError가 아니라 일반 메시지로 감춰진다(SA-4) — 원인은 로그에 남긴다
    if (!(e instanceof ValidationError)) {
      console.error('[actions/help] 도움말 조회 실패:', e);
    }
    return toActionFailure(e);
  }
}

// ─── 따라하기 (§7.17) ─────────────────────────────────────────────────────────

// 단계 id·판정 결과형·예제 과제 표식은 lib/tutorial.ts가 원본이다(드로어·배지·[과제 삭제]와 한 정의).
// 'use server' 파일은 값 재수출이 안 되므로 타입만 별칭으로 내보낸다
export type { AutoStepId } from '@/lib/tutorial';
export type TutorialStatus = TutorialServerStatus;

// LocalConfig.tutorial.sampleProjectId는 문자열이면 무엇이든 담길 수 있다. uuid가 아닌 값을
// VALIDATION으로 돌려주면 드로어가 "과제 없음"을 받지 못해 영영 되돌리지 못한다(TU-5) —
// 과제를 가리킬 수 없는 값은 곧 "과제 없음"이다
const optionalProjectIdSchema = z.uuid().nullable().optional();

function noProjectStatus(): TutorialStatus {
  return {
    projectExists: false,
    steps: {
      project: false,
      years: false,
      team: false,
      wbs: false,
      goals: false,
      milestones: false,
      budget: false,
    },
  };
}

/** 없는 과제는 예외가 아니라 null — TU-5가 이 값으로 sampleProjectId를 되돌린다 */
async function findProject(client: SupabaseClient, projectId: unknown) {
  const parsed = optionalProjectIdSchema.safeParse(projectId);
  if (!parsed.success || parsed.data == null) return null;
  try {
    return await projectsRepo.getProjectById(client, parsed.data);
  } catch (e) {
    if (e instanceof NotFoundError) return null;
    throw e;
  }
}

/**
 * TU-4: 단계 완료는 서버가 데이터로 판정한다. 조회만 하고 아무것도 쓰지 않는다.
 * ⑦은 산출근거 **와** 규칙이 둘 다 있어야 한다 — 드로어 7단계가 "산출근거 한 행 + 규칙 프리셋"이다.
 */
export async function getTutorialStatus(projectId: unknown): Promise<ActionResult<TutorialStatus>> {
  try {
    const { client } = await requireApprovedUser();
    const project = await findProject(client, projectId);
    if (project === null) return { ok: true, data: noProjectStatus() };

    // 하나라도 실패하면 실패를 그대로 올린다 — 빈 배열 폴백은 미완료로 둔갑한다 (절대 규칙 5)
    const [years, members, tasks, deliverables, techTargets, milestones, details, rules] =
      await Promise.all([
        yearsRepo.listYears(client, project.id),
        membersRepo.listMembers(client, project.id),
        tasksRepo.listTasksByProject(client, project.id),
        deliverablesRepo.listDeliverables(client, project.id),
        techTargetsRepo.listTechTargets(client, project.id),
        milestonesRepo.listMilestones(client, project.id),
        budgetDetailsRepo.listByProject(client, project.id),
        budgetRulesRepo.listByProject(client, project.id),
      ]);

    return {
      ok: true,
      data: {
        projectExists: true,
        steps: {
          project: true,
          years: years.length >= 1,
          team: members.length >= 1,
          wbs: tasks.length >= 1,
          goals: deliverables.length + techTargets.length >= 1,
          milestones: milestones.length >= 1,
          budget: details.length >= 1 && rules.length >= 1,
        },
      },
    };
  } catch (e) {
    return toActionFailure(e);
  }
}

// ─── 예제 과제 (TU-3) ─────────────────────────────────────────────────────────

/**
 * TU-3: 실패 분기에 `projectId`를 덧붙인 확장. 2단계 이후 실패는 과제가 이미 DB에 있으므로
 * 사용자가 [과제 삭제]로 치울 수 있게 id를 돌려준다 — `ActionResult` 자체는 바꾸지 않는다.
 */
export type CreateSampleProjectResult =
  | ActionResult<{ projectId: string; created: boolean }>
  | { ok: false; error: string; code?: ActionErrorCode; projectId: string };

// 한 트랜잭션이 아니다(TU-3) — 어느 단계에서 멈췄는지가 사용자 안내의 전부다
class SampleStepError extends Error {
  constructor(
    readonly step: number,
    readonly stepName: string,
    readonly cause: string,
    readonly code: ActionErrorCode | undefined
  ) {
    super(`${step} ${stepName}: ${cause}`);
    this.name = 'SampleStepError';
  }
}

// 하위 액션의 ok:false와 던져진 예외를 같은 모양(단계 번호 + 원인)으로 모은다
async function runStep<T>(
  step: number,
  stepName: string,
  fn: () => Promise<ActionResult<T>>
): Promise<T> {
  let result: ActionResult<T>;
  try {
    result = await fn();
  } catch (e) {
    const failure = toActionFailure(e);
    throw new SampleStepError(step, stepName, failure.error, failure.code);
  }
  if (!result.ok) throw new SampleStepError(step, stepName, result.error, result.code);
  return result.data;
}

// 리포지토리 조회는 ActionResult가 아니다 — 같은 단계 번호로 감싼다
async function readStep<T>(step: number, stepName: string, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    const failure = toActionFailure(e);
    throw new SampleStepError(step, stepName, failure.error, failure.code);
  }
}

// 부록 B.7 규모의 1/10 수준 합성값 (TU-3). 원 단위 정수.
const SAMPLE = {
  name: `${SAMPLE_PROJECT_PREFIX}따라하기 예제 과제`,
  description: `${SAMPLE_DESCRIPTION_FIRST_LINE}\n중소기업 에너지기술개발사업을 본뜬 2년짜리 합성 과제입니다. 화면을 따라가며 자유롭게 고쳐 보세요.`,
  ministry: '기후에너지환경부',
  agency: '한국에너지기술평가원',
  contract: { start: '2026-01-01', end: '2027-12-31' },
  govBudget: 225_000_000,
  ownBudget: 100_000_000,
  totalBudget: 325_000_000,
  year1: { start: '2026-01-01', end: '2026-12-31', budget: 160_000_000 },
  year2: { start: '2027-01-01', end: '2027-12-31', budget: 165_000_000 },
} as const;

// 인력 4 — 기존 3·신규 1, 연봉 입력 (TU-3). 인건비 행은 축(현금 3·현물 1)과 참여율을 함께 정한다.
// 기존인력 현금 합(9.6M + 12.6M)이 신규 인건비(27M)를 넘지 않게 골랐다 — RL-15(error)를
// 예제가 스스로 어기면 7단계에서 사용자가 자기 잘못이라 오해한다. RL-14(warn)는 남는다.
const SAMPLE_MEMBERS = [
  { name: '김책임', role: 'pm', position: '수석연구원', email: 'pm@example.com', annualSalary: 60_000_000, hireType: 'existing', axis: 'in_kind', participation: 40 },
  { name: '이선임', role: 'pl', position: '선임연구원', email: 'pl@example.com', annualSalary: 48_000_000, hireType: 'existing', axis: 'cash', participation: 20 },
  { name: '박연구', role: 'researcher', position: '연구원', email: 'r1@example.com', annualSalary: 42_000_000, hireType: 'existing', axis: 'cash', participation: 30 },
  { name: '최신입', role: 'researcher', position: '연구원(신규)', email: 'r2@example.com', annualSalary: 54_000_000, hireType: 'new', axis: 'cash', participation: 50 },
] as const;

/**
 * TU-3: `[예제] ` 과제 + 데이터 세트를 **기존 액션 순서 호출**로 만든다. 새 RPC·리포지토리 직접
 * 쓰기가 없으므로 H-8(주관 승격 RPC)·PL-D1·PL-D7·PL-10(RPC 재계산)을 각 액션이 그대로 지킨다 —
 * 예제가 실제 사용 경로와 다르면 튜토리얼이 거짓말을 한다(§9).
 * 이미 만든 과제가 살아 있으면 다시 만들지 않는다.
 */
export async function createSampleProject(
  existingSampleProjectId: unknown
): Promise<CreateSampleProjectResult> {
  let projectId: string | null = null;
  try {
    const { client } = await requireApprovedUser();

    const existing = await findProject(client, existingSampleProjectId);
    if (existing !== null) {
      return { ok: true, data: { projectId: existing.id, created: false } };
    }

    // 1. 과제 — 여기서 실패하면 만들어진 것이 없으므로 일반 실패다
    const project = await createProject({
      name: SAMPLE.name,
      description: SAMPLE.description,
      ministry: SAMPLE.ministry,
      agency: SAMPLE.agency,
      status: 'active',
      contractStartDate: SAMPLE.contract.start,
      contractEndDate: SAMPLE.contract.end,
      govBudget: SAMPLE.govBudget,
      ownBudget: SAMPLE.ownBudget,
      totalBudget: SAMPLE.totalBudget,
    });
    if (!project.ok) return project;
    projectId = project.data.id;
    const pid = projectId;

    // 2. 단계·연차 — createProject가 만든 Stage 1·Year 1을 채우고 2차년도를 붙인다
    const stage = await readStep(2, '단계·연차', async () => {
      const [first] = await stagesRepo.listStages(client, pid);
      if (!first) throw new NotFoundError('과제 생성이 단계를 만들지 않았습니다.');
      return first;
    });
    const year1 = await readStep(2, '단계·연차', async () => {
      const [first] = await yearsRepo.listYears(client, pid);
      if (!first) throw new NotFoundError('과제 생성이 연차를 만들지 않았습니다.');
      return first;
    });
    await runStep(2, '단계·연차', () =>
      updateYear(year1.id, {
        startDate: SAMPLE.year1.start,
        endDate: SAMPLE.year1.end,
        budget: SAMPLE.year1.budget,
      })
    );
    const year2 = await runStep(2, '단계·연차', () =>
      createYear(stage.id, {
        name: '2차년도',
        startDate: SAMPLE.year2.start,
        endDate: SAMPLE.year2.end,
        budget: SAMPLE.year2.budget,
      })
    );

    // 3. 기관 — lead는 createOrganization이 H-8 RPC로 승격한다
    const leadOrg = await runStep(3, '기관', () =>
      createOrganization(pid, {
        name: '(주)예제에너지',
        role: 'lead',
        type: '기업',
        representative: '김책임',
        responsibility: '시스템 설계·시제품 제작',
      })
    );
    await runStep(3, '기관', () =>
      createOrganization(pid, {
        name: '예제대학교',
        role: 'joint',
        type: '대학',
        representative: '정교수',
        responsibility: '성능 평가·기초 연구',
      })
    );

    // 4. 인력 — 전원 주관기관 소속, 첫 사람이 PM
    const members = [];
    for (const m of SAMPLE_MEMBERS) {
      members.push(
        await runStep(4, '인력', () =>
          createMember(pid, {
            orgId: leadOrg.id,
            name: m.name,
            role: m.role,
            position: m.position,
            email: m.email,
            annualSalary: m.annualSalary,
            hireType: m.hireType,
          })
        )
      );
    }
    const [pm, pl, researcher1, researcher2] = members;
    if (!pm || !pl || !researcher1 || !researcher2) {
      throw new SampleStepError(4, '인력', '인력 4명이 만들어지지 않았습니다.', undefined);
    }
    await runStep(4, '인력', () => setProjectPM(pid, pm.id));

    // 5. WBS 작업 8 — 깊이 3 (요구 분석 > 자료 조사 > 문헌 정리·인터뷰)
    const addTask = (
      title: string,
      parentId: string | null,
      estimatedHours: number,
      startDate: string,
      dueDate: string,
      ownerMemberId: string
    ) =>
      runStep(5, 'WBS 작업', () =>
        createTask(year1.id, { title, parentId, estimatedHours, startDate, dueDate, ownerMemberId })
      );
    const analysis = await addTask('요구 분석', null, 120, '2026-01-05', '2026-03-31', pl.id);
    const survey = await addTask('자료 조사', analysis.id, 80, '2026-01-05', '2026-02-27', researcher1.id);
    await addTask('문헌 정리', survey.id, 40, '2026-01-05', '2026-01-30', researcher1.id);
    await addTask('인터뷰', survey.id, 40, '2026-02-02', '2026-02-27', researcher2.id);
    const design = await addTask('설계', null, 160, '2026-04-01', '2026-07-31', pm.id);
    await addTask('구조 설계', design.id, 100, '2026-04-01', '2026-06-15', pl.id);
    await addTask('검증 계획', design.id, 60, '2026-06-16', '2026-07-31', researcher2.id);
    await addTask('시제품 제작', null, 200, '2026-08-03', '2026-12-18', pm.id);

    // 6. 목표 — 성과목표 2·기술목표 1
    await runStep(6, '목표', () =>
      createDeliverable(pid, {
        type: 'paper_domestic',
        name: '국내 학술지 논문',
        unit: '건',
        targetTotal: 2,
        targetByYear: { [year1.id]: 1, [year2.id]: 1 },
        orgId: leadOrg.id,
      })
    );
    await runStep(6, '목표', () =>
      createDeliverable(pid, {
        type: 'patent_dom_apply',
        name: '국내 특허 출원',
        unit: '건',
        targetTotal: 1,
        targetByYear: { [year2.id]: 1 },
        orgId: leadOrg.id,
      })
    );
    await runStep(6, '목표', () =>
      createTechTarget(pid, {
        name: '에너지 변환 효율',
        unit: '%',
        direction: 'higher_better',
        weight: 1,
        targetValue: 92,
        targetByYear: { [year1.id]: 88, [year2.id]: 92 },
        baselineDomestic: 85,
        worldBest: 95,
        worldBestHolder: '해외 A사',
        measureMethod: 'certified_lab',
        orgId: leadOrg.id,
      })
    );

    // 7. 기본 마일스톤(연차평가·보고서) — 날짜는 1차년도 종료일에서 RPC가 정한다
    await runStep(7, '마일스톤', () => generateDefaultMilestones(year1.id));

    // 8. 1차년도 산출근거 6행 — 인건비 4 + 회의비 1 + 간접비 1. amount는 넘기지 않는다(PL-D7)
    for (let i = 0; i < SAMPLE_MEMBERS.length; i += 1) {
      const spec = SAMPLE_MEMBERS[i];
      const member = members[i];
      if (!spec || !member) {
        throw new SampleStepError(8, '산출근거', '인건비 행과 인력이 맞지 않습니다.', undefined);
      }
      await runStep(8, '산출근거', () =>
        createBudgetDetail(year1.id, 'personnel', 'personnel_internal', {
          axis: spec.axis,
          formula: 'personnel',
          memberId: member.id,
          factors: [
            { label: '참여율(%)', value: spec.participation, isPercent: true },
            { label: '참여기간(월)', value: 12, isPercent: false },
          ],
        })
      );
    }
    await runStep(8, '산출근거', () =>
      createBudgetDetail(year1.id, 'activity', 'activity_meeting', {
        axis: 'cash',
        formula: 'quantity',
        name: '월례 회의비',
        unitPrice: 500_000,
        factors: [{ label: '회', value: 6, isPercent: false }],
      })
    );
    await runStep(8, '산출근거', () =>
      createBudgetDetail(year1.id, 'indirect', 'indirect_support', {
        axis: 'cash',
        formula: 'quantity',
        name: '연구지원비',
        unitPrice: 2_000_000,
        factors: [],
      })
    );

    // 9. 규칙 프리셋 — fill: 예제는 새 과제라 전부 추가된다
    await runStep(9, '규칙 프리셋', () => applyRulePreset(pid, 'moe_energy_sme', 'fill'));

    revalidatePath('/projects');
    return { ok: true, data: { projectId: pid, created: true } };
  } catch (e) {
    if (e instanceof SampleStepError && projectId !== null) {
      // 조용히 넘기지 않는다 — 만들다 만 과제는 사용자가 지워야 한다 (TU-3)
      console.error(`[actions/help] 예제 과제 부분 생성 (${projectId}):`, e);
      return {
        ok: false,
        error: `예제 과제가 일부만 만들어졌습니다 (실패 단계: ${e.step} ${e.stepName}): ${e.cause}. 과제 개요에서 [과제 삭제] 후 다시 만드세요.`,
        code: e.code,
        projectId,
      };
    }
    if (projectId !== null) {
      // 단계 밖(예상 못 한 예외)에서 터져도 과제는 이미 있다 — id 없이 돌려주면 고아가 된다
      console.error(`[actions/help] 예제 과제 생성 중 예외 (${projectId}):`, e);
      const failure = toActionFailure(e);
      return {
        ok: false,
        error: `예제 과제가 일부만 만들어졌습니다: ${failure.error}. 과제 개요에서 [과제 삭제] 후 다시 만드세요.`,
        code: failure.code,
        projectId,
      };
    }
    return toActionFailure(e);
  }
}
