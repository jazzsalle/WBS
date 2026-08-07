'use server';

// Risk 서버 액션 + 리스크 관리대장 조회
// (SOT §9 Risk·조회 목록, SA-1~SA-4, §5.13, §6.5, §7.11, §8.3 X-1·X-3, §8.4 O-1~O-3)
// 반환은 ActionResult<T> — 예외를 그대로 던지지 않는다. supabase 직접 호출 금지,
// 반드시 lib/db/ 리포지토리를 거친다 (§8.6).
//
// score(probability × impact)와 등급은 **저장하지 않는다**. 판정은 전부 lib/risk.ts가 한다
// (§5.13 주석, §6.5). 여기서 점수·등급 공식을 다시 쓰지 않는다 — 규칙이 두 곳에 생기면
// 대시보드(§7.2)의 "고위험/주의 필요" 집계와 이 화면이 반드시 어긋난다 (O-4와 같은 이유).

import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { ActionResult, Member, Risk, RiskLevel, Year } from '@/types';
import { requireApprovedUser } from '@/lib/auth/guard';
import * as appUsers from '@/lib/db/app-users';
import * as membersRepo from '@/lib/db/members';
import * as projectsRepo from '@/lib/db/projects';
import * as risksRepo from '@/lib/db/risks';
import * as tasksRepo from '@/lib/db/tasks';
import * as yearsRepo from '@/lib/db/years';
import {
  RuleViolationError,
  StaleDataError,
  ValidationError,
  toActionFailure,
} from '@/lib/db/errors';
import { riskCategorySchema, riskStatusSchema, riskStrategySchema } from '@/lib/db/schema';
import { todayISO } from '@/lib/dates';
import {
  isActiveRisk,
  needsAttention,
  riskColor,
  riskScore,
  riskSeverity,
  type RiskSeverity,
} from '@/lib/risk';

// ─── 조회 모델 (§9 getRiskMatrix, §7.11) ──────────────────────────────────────
// 타입을 types/index.ts가 아니라 여기에 두는 이유: 화면 전용 조회 모델이라 DB 엔티티가
// 아니다. actions/budget.ts의 BudgetMatrixData가 같은 선례다.

/** 목록 한 줄. 점수·등급·주의 판정은 전부 lib/risk.ts가 끝낸 값이다 (§6.5) */
export interface RiskView {
  risk: Risk;
  /** riskScore: probability × impact (1~25). 저장하지 않는다 */
  score: number;
  /** riskSeverity: 해결·종료는 등급 판정 대상이 아니라 null이다 (§6.5) */
  severity: RiskSeverity | null;
  /** isActiveRisk: status ∉ {resolved, closed} */
  active: boolean;
  /** §6.5 마지막 문장: status='occurred'는 점수와 무관하게 "주의 필요"다 */
  attention: boolean;
  /** 부록 A.3 RISK_SCORE_COLORS의 색상 토큰. 화면은 토큰 → 클래스 매핑만 한다 */
  colorToken: string;
}

/** 5×5 히트맵 한 칸 (§7.11: 가로 발생가능성, 세로 영향도, 셀에 리스크 개수) */
export interface RiskMatrixCell {
  probability: RiskLevel;
  impact: RiskLevel;
  score: number;
  colorToken: string;
  /** 미해결 리스크 id — 기본 표시 대상 */
  activeIds: string[];
  /** 해결·종료 리스크 id — "해결/종료 표시" 토글에서만 더한다 (§7.11) */
  inactiveIds: string[];
}

/** 관련 작업 링크(§7.11)와 폼 선택지에 필요한 최소 정보만 싣는다 */
export interface RiskTaskRef {
  id: string;
  title: string;
  yearId: string;
}

export interface RiskMatrixData {
  projectId: string;
  /** 인쇄 머리말(§12 P-R3)에 쓴다 — 종이만 보고 어느 과제인지 알 수 있어야 한다 */
  projectName: string;
  /** 인쇄 출력일(§12 P-R3). 서버가 Asia/Seoul 달력으로 만든다 (§6.5) */
  todayISO: string;
  /** §7.11 기본 정렬 — 미해결 먼저, 그 안에서 점수 내림차순 */
  risks: RiskView[];
  /** 25칸. impact 5→1(위에서 아래), probability 1→5(왼→오른) 순 */
  cells: RiskMatrixCell[];
  years: Year[];
  members: Member[];
  tasks: RiskTaskRef[];
  /** 화면 상단 요약 — 화면이 목록을 다시 세지 않게 함께 싣는다 */
  activeCount: number;
  resolvedCount: number;
  highCount: number;
  attentionCount: number;
}

// ─── 입력 검증 ────────────────────────────────────────────────────────────────

const uuidSchema = z.uuid();
const uuidListSchema = z.array(z.uuid()).min(1, '정렬할 항목이 없습니다.');

// §5.13 dueDate는 선택이다(대응 완료 목표일). 값이 오면 형식을 강제한다.
const isoDateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "날짜는 'YYYY-MM-DD' 형식이어야 합니다.");

const titleSchema = z
  .string()
  .trim()
  .min(1, '리스크명을 입력하세요.')
  .max(200, '리스크명은 200자 이내여야 합니다.');

const longTextSchema = z.string().max(10_000);

// 1~5 척도 (§5.13 RiskLevel). DB check 제약과 같은 범위다.
const levelSchema = z.union([
  z.literal(1), z.literal(2), z.literal(3), z.literal(4), z.literal(5),
]);

// order는 여기 없다 — 재정렬은 reorderRisks 전용이다 (X-3)
const riskFieldsSchema = z.object({
  yearId: z.uuid().nullable(),
  taskId: z.uuid().nullable(),
  title: titleSchema,
  category: riskCategorySchema,
  description: longTextSchema,
  probability: levelSchema,
  impact: levelSchema,
  strategy: riskStrategySchema,
  response: longTextSchema,
  contingency: longTextSchema,
  ownerMemberId: z.uuid().nullable(),
  dueDate: isoDateSchema.nullable(),
  status: riskStatusSchema,
});

// category·strategy는 DB에 기본값이 없다(not null + check). title은 기본값이 ''이지만
// 이름 없는 리스크는 목록에서 식별이 불가능하므로 생성 시 함께 받는다.
const riskCreateSchema = riskFieldsSchema.partial().extend({
  title: riskFieldsSchema.shape.title,
  category: riskFieldsSchema.shape.category,
  strategy: riskFieldsSchema.shape.strategy,
});

const riskPatchSchema = riskFieldsSchema.partial();

function parseOrThrow<T>(schema: z.ZodType<T>, value: unknown, fallback: string): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    throw new ValidationError(parsed.error.issues[0]?.message ?? fallback);
  }
  return parsed.data;
}

// O-3: 낙관적 잠금 실패는 "누가 먼저 고쳤는지"까지 알려야 사용자가 판단할 수 있다.
// 이름 조회 실패도 삼키지 않고 로그를 남긴 뒤 이름 없는 기본 메시지로 폴백한다.
async function toFailure(e: unknown, client?: SupabaseClient): Promise<ActionResult<never>> {
  if (e instanceof StaleDataError && e.updatedBy !== null && client) {
    try {
      const editor = await appUsers.getAppUserById(client, e.updatedBy);
      const label = editor.name.trim() || editor.email;
      return {
        ok: false,
        error: `${label}님이 먼저 수정했습니다. 최신 내용을 확인하세요.`,
        code: 'STALE',
      };
    } catch (lookupError) {
      console.error('[actions/risks] 수정자 이름 조회 실패:', lookupError);
    }
  }
  return toActionFailure(e);
}

// 대시보드(§7.2)가 "고위험 리스크 수"·"주의 필요"를 집계하므로 리스크 화면만 다시 그리면 부족하다
function revalidateRisks(projectId: string): void {
  revalidatePath('/');
  revalidatePath(`/projects/${projectId}`);
  revalidatePath(`/projects/${projectId}/risks`);
}

// 연차·작업·담당자 참조는 반드시 그 리스크가 속한 과제의 것이어야 한다. 근거는 H-11과 같다 —
// FK는 테이블만 강제할 뿐 과제 경계를 막지 못해서, 남의 과제 연차·작업·인력을 가리키는
// 리스크가 조용히 저장된다. null(미지정)은 검사 대상이 아니다.
interface RiskRefs {
  yearId?: string | null;
  taskId?: string | null;
  ownerMemberId?: string | null;
}

async function assertRiskRefsInProject(
  client: SupabaseClient,
  projectId: string,
  refs: RiskRefs
): Promise<void> {
  if (refs.yearId != null) {
    const years = await yearsRepo.listYears(client, projectId);
    if (!years.some((y) => y.id === refs.yearId)) {
      throw new RuleViolationError('이 과제에 속하지 않은 연차는 지정할 수 없습니다.');
    }
  }

  if (refs.taskId != null) {
    // 작업은 과제당 수백 건일 수 있어 목록 대신 단건 조회로 소속만 본다.
    // 없는 작업은 getTaskById가 NotFound로 막는다.
    const task = await tasksRepo.getTaskById(client, refs.taskId);
    if (task.projectId !== projectId) {
      throw new RuleViolationError('이 과제에 속하지 않은 작업은 연결할 수 없습니다.');
    }
  }

  if (refs.ownerMemberId != null) {
    const members = await membersRepo.listMembers(client, projectId);
    if (!members.some((m) => m.id === refs.ownerMemberId)) {
      throw new RuleViolationError('이 과제에 속하지 않은 인력은 담당자로 지정할 수 없습니다.');
    }
  }
}

// ─── CRUD (§5.13, §9 Risk) ────────────────────────────────────────────────────

export async function createRisk(projectId: string, input: unknown): Promise<ActionResult<Risk>> {
  try {
    const pid = parseOrThrow(uuidSchema, projectId, '과제 ID 형식이 올바르지 않습니다.');
    const fields = parseOrThrow(riskCreateSchema, input, '리스크 정보가 올바르지 않습니다.');
    const { user, client } = await requireApprovedUser();

    await assertRiskRefsInProject(client, pid, {
      yearId: fields.yearId,
      taskId: fields.taskId,
      ownerMemberId: fields.ownerMemberId,
    });

    // 새 리스크는 목록 끝에 붙인다. 순서 변경은 reorderRisks 전용이다 (X-3).
    const existing = await risksRepo.listRisks(client, pid);
    const nextOrder = existing.reduce((max, r) => Math.max(max, r.order + 1), 0);

    const created = await risksRepo.createRisk(client, {
      projectId: pid,
      yearId: fields.yearId ?? null,
      taskId: fields.taskId ?? null,
      title: fields.title,
      category: fields.category,
      description: fields.description ?? '',
      // §5.13 DB 기본값과 같은 3(보통). 지어낸 값이 아니라 스키마 default를 따른다.
      probability: fields.probability ?? 3,
      impact: fields.impact ?? 3,
      strategy: fields.strategy,
      response: fields.response ?? '',
      contingency: fields.contingency ?? '',
      ownerMemberId: fields.ownerMemberId ?? null,
      dueDate: fields.dueDate ?? null,
      status: fields.status ?? 'identified',
      order: nextOrder,
      createdBy: user.id,
      updatedBy: user.id,
    });

    revalidateRisks(pid);
    return { ok: true, data: created };
  } catch (e) {
    return toFailure(e);
  }
}

// O-1: 상세 편집은 여러 필드(발생가능성·영향도·대응방안…)를 한 번에 바꾸므로
// expectedVersion을 받아 잠금을 건다. STALE이면 화면이 ConflictDialog로 입력을 보존한다 (O-3).
export async function updateRisk(
  id: string,
  patch: unknown,
  expectedVersion?: number
): Promise<ActionResult<Risk>> {
  let client: SupabaseClient | undefined;
  try {
    const rid = parseOrThrow(uuidSchema, id, '리스크 ID 형식이 올바르지 않습니다.');
    const parsed = parseOrThrow(riskPatchSchema, patch, '리스크 정보가 올바르지 않습니다.');
    // 리포지토리는 updatedBy를 patch에 담아 받으므로 "빈 patch" 판정을 여기서 한다 —
    // 그러지 않으면 아무 내용도 없는 저장이 version만 올려 남의 편집을 STALE로 만든다
    if (Object.keys(parsed).length === 0) {
      throw new ValidationError('갱신할 내용이 없습니다.');
    }
    const ctx = await requireApprovedUser();
    client = ctx.client;

    // 참조가 patch에 들어올 때만 소속을 확인한다 (조회 1~3회를 아끼기 위해)
    if (
      parsed.yearId !== undefined ||
      parsed.taskId !== undefined ||
      parsed.ownerMemberId !== undefined
    ) {
      const before = await risksRepo.getRiskById(client, rid);
      await assertRiskRefsInProject(client, before.projectId, {
        yearId: parsed.yearId,
        taskId: parsed.taskId,
        ownerMemberId: parsed.ownerMemberId,
      });
    }

    const updated = await risksRepo.updateRisk(
      client,
      rid,
      { ...parsed, updatedBy: ctx.user.id },
      expectedVersion
    );
    revalidateRisks(updated.projectId);
    return { ok: true, data: updated };
  } catch (e) {
    return toFailure(e, client);
  }
}

export async function deleteRisk(id: string): Promise<ActionResult<null>> {
  try {
    const rid = parseOrThrow(uuidSchema, id, '리스크 ID 형식이 올바르지 않습니다.');
    const { client } = await requireApprovedUser();

    // 삭제 후에는 projectId를 알 수 없으므로 먼저 읽는다 (없으면 NotFoundError)
    const risk = await risksRepo.getRiskById(client, rid);
    await risksRepo.removeRisk(client, rid);

    revalidateRisks(risk.projectId);
    return { ok: true, data: null };
  } catch (e) {
    return toFailure(e);
  }
}

// §7.11 목록의 상태 인라인 변경. O-2: 사용자가 만지는 조작이 하나(상태 드롭다운)이므로
// 낙관적 잠금을 생략한다 — 마지막 것이 이기는 게 자연스럽다.
export async function setRiskStatus(id: string, status: unknown): Promise<ActionResult<Risk>> {
  try {
    const rid = parseOrThrow(uuidSchema, id, '리스크 ID 형식이 올바르지 않습니다.');
    const value = parseOrThrow(riskStatusSchema, status, '리스크 상태 값이 올바르지 않습니다.');
    const { user, client } = await requireApprovedUser();

    const updated = await risksRepo.updateRisk(client, rid, {
      status: value,
      updatedBy: user.id,
    });

    revalidateRisks(updated.projectId);
    return { ok: true, data: updated };
  } catch (e) {
    return toFailure(e);
  }
}

// X-3: 넘어온 순서대로 0..n-1. 다른 과제 리스크가 섞이면 RPC가 거부한다.
// §9는 reorderRisks(orderedIds)로 적혀 있지만 컨테이너 없이는 과제 경계를 검증할 수 없어
// reorderOrganizations/reorderMembers(§9)와 같이 projectId를 함께 받는다.
export async function reorderRisks(
  projectId: string,
  orderedIds: string[]
): Promise<ActionResult<null>> {
  try {
    const pid = parseOrThrow(uuidSchema, projectId, '과제 ID 형식이 올바르지 않습니다.');
    const ids = parseOrThrow(uuidListSchema, orderedIds, '정렬 목록이 올바르지 않습니다.');
    const { client } = await requireApprovedUser();
    await risksRepo.reorderRisks(client, pid, ids);
    revalidateRisks(pid);
    return { ok: true, data: null };
  } catch (e) {
    return toFailure(e);
  }
}

// ─── 조회 (§9 getRiskMatrix — 서버 컴포넌트에서 직접 호출) ────────────────────

const LEVELS: readonly RiskLevel[] = [1, 2, 3, 4, 5];

function toView(risk: Risk): RiskView {
  const score = riskScore(risk);
  return {
    risk,
    score,
    severity: riskSeverity(risk),
    active: isActiveRisk(risk.status),
    attention: needsAttention(risk),
    colorToken: riskColor(score),
  };
}

// §7.11 "점수 내림차순 기본 정렬".
// 해결·종료는 §6.5의 등급 판정 대상이 아니라(severity=null) 등급 순서에 낄 자리가 없다 —
// 토글로 드러냈을 때 미해결 항목을 밀어내지 않도록 뒤로 모은다. 같은 점수는 수동 순서(order),
// 그 다음 제목으로 고정해 새로고침마다 순서가 흔들리지 않게 한다.
function compareViews(a: RiskView, b: RiskView): number {
  if (a.active !== b.active) return a.active ? -1 : 1;
  if (a.score !== b.score) return b.score - a.score;
  if (a.risk.order !== b.risk.order) return a.risk.order - b.risk.order;
  return a.risk.title.localeCompare(b.risk.title, 'ko');
}

// 5×5 히트맵. 미해결/해결을 나눠 담아 "해결·종료 표시" 토글이 셀 개수까지 함께 따라가게 한다.
function buildCells(views: RiskView[]): RiskMatrixCell[] {
  const cells: RiskMatrixCell[] = [];
  // impact 5→1(위에서 아래), probability 1→5(왼→오른) — §7.11의 축 배치 그대로다
  for (const impact of [...LEVELS].reverse()) {
    for (const probability of LEVELS) {
      const score = riskScore({ probability, impact });
      cells.push({
        probability,
        impact,
        score,
        colorToken: riskColor(score),
        activeIds: [],
        inactiveIds: [],
      });
    }
  }

  const byKey = new Map(cells.map((cell) => [`${cell.probability}:${cell.impact}`, cell]));
  for (const view of views) {
    const cell = byKey.get(`${view.risk.probability}:${view.risk.impact}`);
    // DB check 제약(1~5)을 통과한 값이면 항상 셀이 있다. 없으면 데이터가 깨진 것이므로 드러낸다.
    if (!cell) {
      throw new ValidationError(
        `리스크 '${view.risk.title}'의 발생가능성·영향도가 1~5 범위를 벗어났습니다.`
      );
    }
    (view.active ? cell.activeIds : cell.inactiveIds).push(view.risk.id);
  }

  return cells;
}

export async function getRiskMatrix(projectId: string): Promise<ActionResult<RiskMatrixData>> {
  try {
    const pid = parseOrThrow(uuidSchema, projectId, '과제 ID 형식이 올바르지 않습니다.');
    const { client } = await requireApprovedUser();

    // 하나라도 실패하면 실패를 그대로 올린다 — 빈 배열 폴백은 데이터 손상을 감춘다 (절대 규칙 5).
    // 특히 리스크 조회가 부분 실패한 채 매트릭스를 그리면 고위험 건수가 조용히 낮게 나온다.
    const [project, risks, years, members, tasks] = await Promise.all([
      // 인쇄 머리말용 과제명 (§12 P-R3). 조회 실패는 그대로 올린다 — 화면은 어차피 실패다
      projectsRepo.getProjectById(client, pid),
      risksRepo.listRisks(client, pid),
      yearsRepo.listYears(client, pid),
      membersRepo.listMembers(client, pid),
      tasksRepo.listTasksByProject(client, pid),
    ]);

    const views = risks.map(toView).sort(compareViews);

    return {
      ok: true,
      data: {
        projectId: pid,
        projectName: project.name,
        todayISO: todayISO(new Date()), // §6.5 기준일 — Asia/Seoul 달력
        risks: views,
        cells: buildCells(views),
        years,
        members,
        tasks: tasks.map((task) => ({ id: task.id, title: task.title, yearId: task.yearId })),
        activeCount: views.filter((v) => v.active).length,
        resolvedCount: views.filter((v) => !v.active).length,
        highCount: views.filter((v) => v.severity === 'high').length,
        attentionCount: views.filter((v) => v.attention).length,
      },
    };
  } catch (e) {
    return toFailure(e);
  }
}
