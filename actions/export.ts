'use server';

// 제출 서식 내보내기 서버 액션 (SOT §6.12 X-1~X-12, §7.9.4)
//
// **읽기 전용이다** (X-11): 앱 데이터를 한 줄도 바꾸지 않고 스냅샷도 남기지 않는다 —
// 되돌릴 것이 없으므로 revalidatePath도 부르지 않는다.
//
// 구조는 임포트(actions/detail-import.ts)의 거울상이다:
//   · "어느 값을 어느 셀에 쓸까"는 lib/export/의 순수 함수가 정한다 (§6.12.4)
//   · 워크북을 열고 쓰는 일은 lib/export-adapter.ts가 한다 (SheetJS는 거기서만 쓴다)
//   · 여기서는 인증·검증·과제 경계·리포지토리 호출과 **막을 것과 알릴 것의 구분**만 한다
//
// 금액 산식을 여기 다시 쓰지 않는다 (PL-10a·O-4). 저장된 amount도 읽지 않는다 —
// aggregateDetails가 근거로 다시 계산한 값만 믿는다 (PL-D7).
//
// supabase 직접 호출 금지 — 반드시 lib/db/ 리포지토리를 거친다 (절대 규칙 3, §8.6).

import { z } from 'zod';
import type {
  ActionResult,
  BudgetDetail,
  IndirectBase,
  Member,
  Project,
  RuleCode,
  RuleSeverity,
  Year,
} from '@/types';
import { requireApprovedUser } from '@/lib/auth/guard';
import { RuleViolationError, ValidationError, toActionFailure } from '@/lib/db/errors';
import * as budgetDetailsRepo from '@/lib/db/budget-details';
import * as budgetRulesRepo from '@/lib/db/budget-rules';
import * as membersRepo from '@/lib/db/members';
import * as projectsRepo from '@/lib/db/projects';
import * as yearsRepo from '@/lib/db/years';
import { aggregateDetails, buildYearTotals } from '@/lib/budget-plan';
import type { DetailAggregate } from '@/lib/budget-plan';
import {
  DEFAULT_INDIRECT_BASE,
  RULE_SPECS,
  evaluateRules,
  type RuleFinding,
  type RuleRowInput,
  type RuleYearInput,
} from '@/lib/rules';
import { todayISO } from '@/lib/dates';
import { DEFAULT_TEMPLATE_ID, TEMPLATE_REGISTRY, findTemplate, validateLayout } from '@/lib/export/layouts';
import { buildDetailWrites, checkCapacity, exportFileName } from '@/lib/export/detail-sheet';
import { buildSummaryWrites } from '@/lib/export/summary-sheet';
import type { CapacityReport } from '@/lib/export/detail-sheet';
import type { SummarySkip } from '@/lib/export/summary-sheet';
import type { ExportPlanData, LayoutViolation, TemplateLayout } from '@/lib/export/types';
import {
  applyWrites,
  listTemplateFiles,
  readTemplate,
  templatePath,
  writeWorkbookBuffer,
  type TemplateWorkbook,
} from '@/lib/export-adapter';

// ─── 화면 계약 (§7.9.4 내보내기 전 확인) ──────────────────────────────────────

export interface ExportTemplateOption {
  id: string;
  label: string;
}

/** 내보내기를 **막는** 것. 하나라도 있으면 파일을 만들지 않는다 (X-5: 조용히 자르지 않는다) */
export interface ExportBlocker {
  kind: 'overflow' | 'unmapped' | 'layout';
  /** 사람이 읽는 말. `학생인건비 > 일반` 같은 — 코드만 던지면 무엇을 고칠지 알 수 없다 */
  label: string;
  detail: string;
}

/**
 * 막지는 않지만 **알려야 하는** 것 (§7.9.4).
 *
 * 협의 중인 계획도 내보낼 수 있어야 한다 — 음수 금액(PL-5)·연봉 미입력(D-8a)·연구비 사용 규칙
 * 위반(§6.14)은 계획이 아직 확정되지 않았다는 뜻이지 파일을 못 만든다는 뜻이 아니다
 * (PL-15와 같은 태도). **규칙 finding은 severity가 `error`여도 여기다** — blockers에 넣는 코드는
 * RL-1 위반이다.
 */
export type ExportNotice =
  | {
      kind: 'skipped-row' | 'negative-amount' | 'missing-salary' | 'truncated-factor';
      label: string;
      detail: string;
    }
  | {
      /** §6.14.6 RuleFinding 한 건. 화면이 severity 색과 "근사" 표기를 그린다 */
      kind: 'rule-finding';
      label: string;
      detail: string;
      code: RuleCode;
      severity: RuleSeverity;
      /** RL-7·RL-9처럼 가정이 들어간 판정 */
      approximate: boolean;
    };

export interface ExportPreview {
  /** X-3: 하나뿐이면 화면이 묻지 않는다 */
  templates: ExportTemplateOption[];
  templateId: string;
  yearLabel: string;
  rowCount: number;
  /** 원 단위 정수 (X-6). 표시 단위 환산은 화면의 몫이다 */
  totalAmount: number;
  /** 비어 있어야 내보낼 수 있다 */
  blockers: ExportBlocker[];
  notices: ExportNotice[];
  /** 총괄표 간접비 비율 행(X-10c)의 수정직접비 정의 — 과제 `indirect_max` 규칙 행의 base (RL-3) */
  indirectBase: IndirectBase;
}

// ─── 입력 검증 ────────────────────────────────────────────────────────────────

const uuidSchema = z.uuid();
const templateIdSchema = z.string().trim().min(1);

function parseOrThrow<T>(schema: z.ZodType<T>, value: unknown, fallback: string): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new ValidationError(parsed.error.issues[0]?.message ?? fallback);
  return parsed.data;
}

// ─── 템플릿 목록 (X-3) ────────────────────────────────────────────────────────

/** `산출근거_표준.xlsx` → `산출근거_표준`. 사용자가 고르는 이름은 파일명이 원본이다 */
function templateLabel(file: string): string {
  return file.replace(/\.xlsx$/i, '');
}

/**
 * `templates/*.xlsx`를 훑어 만든 선택지. **맵이 없는 파일은 목록에 넣지 않는다** —
 * 셀 좌표 맵 없이는 어느 칸에 무엇을 쓸지 알 수 없어 고를 수 있게 두면 반드시 실패한다.
 * 다만 그 사실은 로그로 남긴다 (절대 규칙 5).
 *
 * 반대로 **맵은 있는데 파일이 없으면 던진다.** 배포 산출물에서 템플릿이 빠졌다는 뜻이고,
 * 목록에서 조용히 빼면 사용자는 "서식이 원래 없었나 보다"라고 읽는다.
 */
function buildTemplateOptions(): ExportTemplateOption[] {
  const files = new Set(listTemplateFiles());

  const missing = TEMPLATE_REGISTRY.filter((entry) => !files.has(entry.file)).map((e) => e.file);
  if (missing.length > 0) {
    throw new ValidationError(
      `제출 서식 템플릿 파일이 없습니다: ${missing.join(', ')}. 앱 설치 상태를 확인하세요.`
    );
  }

  const mapped = new Set(TEMPLATE_REGISTRY.map((entry) => entry.file));
  const unmapped = [...files].filter((file) => !mapped.has(file));
  if (unmapped.length > 0) {
    console.error(
      `[actions/export] 셀 좌표 맵이 없는 템플릿 파일: ${unmapped.join(', ')} — ` +
        '내보내기 목록에서 제외했습니다 (templates/<파일명>.map.json이 필요합니다).'
    );
  }

  return TEMPLATE_REGISTRY.map((entry) => ({
    id: entry.templateId,
    label: templateLabel(entry.file),
  }));
}

// ─── 막을 것 / 알릴 것 ────────────────────────────────────────────────────────

function toBlockers(
  capacity: CapacityReport,
  layout: TemplateLayout,
  violations: readonly LayoutViolation[]
): ExportBlocker[] {
  const blockers: ExportBlocker[] = [];

  // 좌표 맵이 템플릿과 어긋나면 어디에 쓸지부터 틀린다. 여기서 멈추지 않으면 값이 엉뚱한
  // 칸에 들어간 파일이 나가고, 그건 잘린 예산보다 알아채기 어렵다
  for (const violation of violations) {
    blockers.push({
      kind: 'layout',
      label: `${violation.sheet}${violation.addr ? `!${violation.addr}` : ''}`,
      detail: `${violation.detail} (${violation.path})`,
    });
  }

  for (const overflow of capacity.overflows) {
    blockers.push({
      kind: 'overflow',
      label: `${overflow.label} ${overflow.needed}행`,
      detail:
        `이 서식은 ${overflow.label} 자리에 빈 줄을 ${overflow.capacity}개만 두고 있는데 ` +
        `${overflow.needed}행이 필요합니다. 잘라내지 않습니다 — 서식을 바꾸거나 항목을 줄이세요 (X-5).`,
    });
  }

  for (const unmapped of capacity.unmapped) {
    blockers.push({
      kind: 'unmapped',
      label: `${unmapped.label} ${unmapped.count}행`,
      detail:
        `'${layout.templateFile}'의 산출근거에는 ${unmapped.label}을(를) 적을 표가 없습니다. ` +
        `서식을 바꾸거나 그 항목을 빼야 합니다 (${unmapped.category}/${unmapped.subcategory}).`,
    });
  }

  return blockers;
}

/** 한 줄에 다 적으면 읽히지 않는다 — 앞의 몇 개만 이름으로 보이고 나머지는 수로 말한다 */
function joinLabels(labels: readonly string[], shown = 5): string {
  if (labels.length <= shown) return labels.join(', ');
  return `${labels.slice(0, shown).join(', ')} 외 ${labels.length - shown}건`;
}

function summarySkipNotice(skip: SummarySkip): ExportNotice {
  const reason =
    skip.reason === 'conflict'
      ? `서식의 라벨과 수식이 어긋나 어느 비목인지 정할 수 없습니다${skip.conflict ? ` (${skip.conflict})` : ''} — ` +
        '서식 소유자의 확인이 필요합니다 (X-10b).'
      : skip.reason === 'memo'
        ? '앱에 대응 데이터가 없는 괄호 메모 행입니다 — 임포트도 읽지 않는 값이라 지어내지 않습니다 (X-10d).'
        : '같은 (비목·세목·축)을 가리키는 행이 둘 이상이라 어느 줄에 넣을지 정할 수 없습니다.';
  return {
    kind: 'skipped-row',
    label: `총괄표 ${skip.row}행 '${skip.label}'`,
    detail: `${reason} 값 대신 빈 칸으로 나갑니다 — 필요하면 엑셀에서 직접 채우세요.`,
  };
}

/**
 * §6.14 판정의 재료. getBudgetPlanData(actions/budget-plan.ts)와 같은 모양으로 조립하되
 * **산출근거만** 본다 — 파일에 나가는 숫자가 전부 산출근거에서 나오므로(X-10, PL-D7) 경고도
 * 그 숫자에 대한 것이어야 한다. budget_items만 있는 셀은 파일에 없으니 여기서도 보지 않는다.
 * ('use server' 파일은 async 함수만 export할 수 있어 저쪽의 조립을 그대로 가져다 쓸 수 없다.)
 *
 * `details`는 리포지토리 행 그대로다 — 행 단위 finding이 `id`를 가리키는데 ExportDetailRow에는 없다.
 */
function buildRuleYears(
  details: readonly BudgetDetail[],
  plan: ExportPlanData,
  aggregate: DetailAggregate
): RuleYearInput[] {
  const memberById = new Map(plan.members.map((member) => [member.id, member]));
  const rowsByYear = new Map<string, RuleRowInput[]>();
  details.forEach((detail, index) => {
    const computed = aggregate.rows[index];
    // 집계는 입력과 같은 순서·길이를 보장한다. 어긋나면 금액이 다른 행에 붙는다는 뜻이다
    if (!computed) throw new ValidationError('산출근거 금액을 계산하지 못했습니다.');
    const member = detail.memberId === null ? null : (memberById.get(detail.memberId) ?? null);
    const rows = rowsByYear.get(detail.yearId) ?? [];
    rows.push({
      detail,
      amount: computed.amount,
      member: member === null ? null : { id: member.id, hireType: member.hireType },
    });
    rowsByYear.set(detail.yearId, rows);
  });
  return plan.years.map((year) => ({
    yearId: year.id,
    // 총괄표의 X-10c 비율 행과 같은 재료다 — 파일의 비율과 경고의 비율이 갈리면 안 된다
    totals: buildYearTotals(aggregate.cells.filter((cell) => cell.yearId === year.id)),
    rows: rowsByYear.get(year.id) ?? [],
  }));
}

/** 경고에 붙일 연차 이름. 이름은 사용자 입력이라 비어 있을 수 있어 번호를 앞에 둔다 */
function yearLabelOf(plan: ExportPlanData, yearId: string): string {
  const year = plan.years.find((candidate) => candidate.id === yearId);
  if (!year) return '(알 수 없는 연차)';
  return year.name === '' ? `${year.order + 1}차년도` : `${year.order + 1}차년도 ${year.name}`;
}

/**
 * RuleFinding → notice. **blockers가 아니다** — severity가 error여도 내보내기는 진행된다 (RL-1·PL-15).
 * 협의 중인 계획은 한도를 넘나드는 것이 정상이고, 막으면 사용자가 엑셀로 나간다.
 */
function ruleFindingNotice(
  finding: RuleFinding,
  details: readonly BudgetDetail[],
  plan: ExportPlanData
): ExportNotice {
  const spec = RULE_SPECS[finding.code];
  let where: string;
  if (finding.scope.kind === 'project') {
    where = '과제 전체';
  } else if (finding.scope.kind === 'year') {
    where = yearLabelOf(plan, finding.scope.yearId);
  } else {
    const detailId = finding.scope.detailId;
    const row = details.find((candidate) => candidate.id === detailId);
    const rowName = row ? rowLabel(row, plan.members) : '(알 수 없는 행)';
    where = `${yearLabelOf(plan, finding.scope.yearId)} · ${rowName}`;
  }
  return {
    kind: 'rule-finding',
    label: `${spec.label} · ${where}`,
    detail: finding.message,
    code: finding.code,
    severity: finding.severity,
    approximate: finding.approximate,
  };
}

// ─── 준비 (미리보기·내보내기가 같은 경로를 쓴다) ──────────────────────────────

interface ExportBundle {
  project: Project;
  year: Year;
  plan: ExportPlanData;
  layout: TemplateLayout;
  template: TemplateWorkbook;
  preview: ExportPreview;
  summarySkips: SummarySkip[];
}

/**
 * 미리보기에서 본 것과 파일에 들어가는 것이 같아야 하므로(§9) 두 액션이 **같은 함수**로
 * 재료를 만든다. 판정을 두 번 쓰면 반드시 어긋난다 (O-4).
 */
async function collectExport(
  projectId: unknown,
  yearId: unknown,
  templateId: unknown
): Promise<ExportBundle> {
  const pid = parseOrThrow(uuidSchema, projectId, '과제 ID 형식이 올바르지 않습니다.');
  const yid = parseOrThrow(uuidSchema, yearId, '연차 ID 형식이 올바르지 않습니다.');
  const requestedTemplate =
    templateId === undefined || templateId === null
      ? DEFAULT_TEMPLATE_ID
      : parseOrThrow(templateIdSchema, templateId, '템플릿 ID가 올바르지 않습니다.');

  const { client } = await requireApprovedUser();

  const templates = buildTemplateOptions();
  // 모르는 templateId는 거부한다 — 기본값으로 되돌리면 엉뚱한 서식으로 제출된다
  const entry = findTemplate(requestedTemplate);
  if (!entry) {
    throw new ValidationError(`'${requestedTemplate}' 제출 서식을 찾을 수 없습니다.`);
  }

  // 하나라도 실패하면 실패를 그대로 올린다 — 빈 배열 폴백은 예산이 사라진 것을 감춘다 (절대 규칙 5)
  const [project, years, details, members, rules] = await Promise.all([
    projectsRepo.getProjectById(client, pid),
    yearsRepo.listYears(client, pid),
    budgetDetailsRepo.listByProject(client, pid),
    membersRepo.listMembers(client, pid),
    budgetRulesRepo.listByProject(client, pid),
  ]);

  // N-13: 이 연차가 그 과제 소속인지 확인한다. 아니면 다른 과제의 예산이 파일로 나간다
  const year = years.find((candidate) => candidate.id === yid);
  if (!year) {
    throw new RuleViolationError('이 과제에 속하지 않은 연차입니다.');
  }

  // X-10: 산출근거는 한 연차만 담지만(X-9) 총괄표는 전 연차 열을 채운다 — 두 시트가 같은
  // 배열을 보아야 합계가 어긋나지 않는다
  const plan: ExportPlanData = {
    details,
    members: members.map(toExportMember),
    years: years.map((candidate) => ({
      id: candidate.id,
      order: candidate.order,
      name: candidate.name,
    })),
    // RL-3: 수정직접비 분모는 과제의 indirect_max 행이 고른다. 꺼진 행의 base도 그대로 쓴다 —
    // actions/budget-plan.ts·lib/rules.ts와 같은 규칙이어야 화면·파일·경고의 비율이 한 값이다
    indirectBase: rules.find((rule) => rule.code === 'indirect_max')?.base ?? DEFAULT_INDIRECT_BASE,
  };

  const template = readTemplate(templatePath(entry.file));
  const violations = validateLayout(entry.layout, template.sheets);

  const yearRows = details.filter((row) => row.yearId === yid);
  const capacity = checkCapacity(yearRows, plan.members, entry.layout);
  const blockers = toBlockers(capacity, entry.layout, violations);

  const aggregate = aggregateDetails(yearRows, plan.members);

  const notices: ExportNotice[] = [];

  // 금액은 틀어지지 않는다 — 빠지는 것은 그 금액이 어떻게 나왔는지 보여 주는 칸이다
  for (const truncated of capacity.truncatedFactors) {
    // 단가 열이 없는 표(실측 `나. 연구지원비`)와 인자 열이 모자란 표를 갈라 쓴다 (X-5a).
    // 두 문장을 합치면 "인자 0개 중 0개"처럼 아무 말도 아닌 통지가 된다.
    const parts: string[] = [];
    if (truncated.unitPriceDropped) parts.push('이 표에는 단가 열이 없어 단가가 들어가지 않습니다');
    if (truncated.total > truncated.kept)
      parts.push(`산출내역 인자 ${truncated.total}개 중 ${truncated.kept}개만 들어갑니다`);
    notices.push({
      kind: 'truncated-factor',
      label: truncated.rowLabel,
      detail: `${parts.join('. ')}. 금액은 그대로이지만 산출 과정이 서식에 보이지 않습니다.`,
    });
  }

  const negativeLabels: string[] = [];
  const missingSalaryLabels: string[] = [];
  yearRows.forEach((row, index) => {
    const computed = aggregate.rows[index];
    if (!computed) return;
    const label = rowLabel(row, plan.members);
    if (computed.negative) negativeLabels.push(label);
    if (computed.missingSalary) missingSalaryLabels.push(label);
  });

  if (negativeLabels.length > 0) {
    notices.push({
      kind: 'negative-amount',
      label: `음수 금액 ${negativeLabels.length}행`,
      detail: `${joinLabels(negativeLabels)} — 조정액이 산출액보다 큽니다 (PL-5). 그대로 내보냅니다.`,
    });
  }
  if (missingSalaryLabels.length > 0) {
    notices.push({
      kind: 'missing-salary',
      label: `연봉 미입력 ${missingSalaryLabels.length}행`,
      detail: `${joinLabels(missingSalaryLabels)} — 인력 명부에 연봉이 없어 0원으로 나갑니다 (D-8a).`,
    });
  }

  // §6.14 연구비 사용 규칙. 규칙 0건이면 findings도 0건이라 규칙 notice가 없다 (PL-14).
  // 전 연차를 판정한다 — 총괄표에 전 연차의 비율이 나가고(X-10c) 과제 단위 규칙(RL-8·RL-9)도 있다.
  // 다만 **행 단위(detail) finding은 내보내는 연차만** 싣는다: 다른 연차의 산출 행은 이 파일에
  // 없어(X-9) 사용자가 이 파일에서 고칠 수 있는 것이 아니다.
  // severity 순서는 evaluateRules가 이미 정했다(error > warn > info) — 여기서 다시 섞지 않는다.
  const ruleEvaluation = evaluateRules(rules, {
    years: buildRuleYears(details, plan, aggregateDetails(details, plan.members)),
    project: {
      govBudget: project.govBudget,
      ownBudget: project.ownBudget,
      totalBudget: project.totalBudget,
    },
  });
  for (const finding of ruleEvaluation.findings) {
    if (finding.scope.kind === 'detail' && finding.scope.yearId !== yid) continue;
    notices.push(ruleFindingNotice(finding, details, plan));
  }

  // 좌표 맵이 깨진 상태에서 총괄표 쓰기를 만들면 판정할 수 없는 행에서 던진다 —
  // 그 전에 이미 layout blocker로 막았으므로 여기서는 시도하지 않는다
  const summary = blockers.length === 0 ? buildSummaryWrites(plan, entry.layout) : null;
  const summarySkips = summary?.skipped ?? [];
  for (const skip of summarySkips) notices.push(summarySkipNotice(skip));

  return {
    project,
    year,
    plan,
    layout: entry.layout,
    template,
    summarySkips,
    preview: {
      templates,
      templateId: entry.templateId,
      yearLabel: year.name,
      rowCount: yearRows.length,
      totalAmount: aggregate.total.plannedAmount,
      blockers,
      notices,
      indirectBase: plan.indirectBase,
    },
  };
}

/** 명부의 최소 형태. 단가(연봉)의 유일한 출처는 여기다 (§5.11, D-8a) */
function toExportMember(member: Member): ExportPlanData['members'][number] {
  return {
    id: member.id,
    annualSalary: member.annualSalary,
    name: member.name,
    position: member.position,
    hireType: member.hireType,
  };
}

/** 경고에 붙일 사람이 알아볼 이름. 인건비 행은 품명이 비어 있으므로 성명으로 말한다 */
function rowLabel(
  row: { formula: string; memberId: string | null; name: string },
  members: ExportPlanData['members']
): string {
  if (row.formula === 'personnel') {
    const member = members.find((candidate) => candidate.id === row.memberId);
    return member?.name ?? '(인력 미지정)';
  }
  return row.name === '' ? '(품명 없음)' : row.name;
}

// ─── §9 액션 ──────────────────────────────────────────────────────────────────

/**
 * §7.9.4 내보내기 전 확인. 반영될 행 수·합계 금액·넘치는 세목·경고를 그대로 보여 준다.
 * 앱 데이터를 바꾸지 않는다 (X-11).
 */
export async function previewSubmissionExport(
  projectId: string,
  yearId: string,
  templateId?: string
): Promise<ActionResult<ExportPreview>> {
  try {
    const bundle = await collectExport(projectId, yearId, templateId);
    return { ok: true, data: bundle.preview };
  } catch (e) {
    return toExportFailure(e);
  }
}

/**
 * X-9·X-10: 한 연차의 **산출근거 + 총괄표**가 든 xlsx 한 파일. 파일 저장은 호출자(셸)의 몫이라
 * base64로 돌려준다 — 서버는 디스크에 쓰지 않는다.
 *
 * blockers가 하나라도 있으면 **거부한다** (X-5). 잘린 예산은 조용히 틀린 예산이다.
 */
export async function exportSubmissionWorkbook(
  projectId: string,
  yearId: string,
  templateId?: string
): Promise<ActionResult<{ fileName: string; contentBase64: string }>> {
  try {
    const bundle = await collectExport(projectId, yearId, templateId);
    const { blockers } = bundle.preview;
    if (blockers.length > 0) {
      throw new RuleViolationError(
        `제출 서식으로 내보낼 수 없습니다 (${blockers.length}건). ` +
          blockers.map((blocker) => `${blocker.label}: ${blocker.detail}`).join(' / ')
      );
    }

    // X-4~X-8은 산출근거, X-10a~X-10e는 총괄표. 두 시트를 같은 plan에서 만든다 (X-10)
    const writes = [
      ...buildDetailWrites(bundle.plan, bundle.year.id, bundle.layout),
      ...buildSummaryWrites(bundle.plan, bundle.layout).writes,
    ];
    applyWrites(bundle.template.workbook, writes);
    const buffer = writeWorkbookBuffer(bundle.template.workbook);

    return {
      ok: true,
      data: {
        fileName: exportFileName(bundle.project, bundle.year, todayISO(new Date())),
        contentBase64: buffer.toString('base64'),
      },
    };
  } catch (e) {
    return toExportFailure(e);
  }
}

/**
 * 순수 계층·어댑터는 `Error`를 던진다. 그대로 두면 toActionFailure가 "요청 처리 중 오류가
 * 발생했습니다"로 덮어 **무엇이 왜 안 됐는지**가 사라진다 — 이 경로의 메시지는 전부 사용자에게
 * 보여 주려고 쓴 문장이므로(내부 식별자를 담지 않는다) 그대로 올린다 (절대 규칙 5).
 */
function toExportFailure(e: unknown): ActionResult<never> {
  if (e instanceof Error && e.constructor === Error) {
    console.error('[actions/export] 내보내기 실패:', e);
    return { ok: false, error: e.message, code: 'RULE' };
  }
  return toActionFailure(e);
}
