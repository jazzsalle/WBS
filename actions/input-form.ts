'use server';

// 사업비 입력 양식 서버 액션 (SOT §9 Budget Input Form, §6.16 IN-1~IN-8, §7.9.7)
//
// 구조는 산출근거 임포트(actions/detail-import.ts)와 내보내기(actions/export.ts)의 합이다:
//   · "어느 값이 어느 칸에 있는가"는 lib/input-form/의 순수 함수가 정한다 (IN-1)
//   · 워크북 쓰기는 lib/input-form-adapter.ts, 읽기는 lib/import-adapter.ts (SheetJS는 거기서만, IN-8)
//   · 여기서는 인증·검증·과제 경계·리포지토리 호출과 **막을 것과 알릴 것의 구분**만 한다
//
// 핵심 불변식:
//   IN-6  previewInputForm과 commitInputForm은 **같은 파싱 경로**(runInputFormPipeline)를 탄다.
//         fileHash 대조로 같은 파일임을 보장한다.
//   IN-5  반영은 양식에 행이 있는 비목 단위 교체 — 기존 `commit_detail_import` RPC를 그대로 쓴다
//         (D-16 단일 트랜잭션 · D-17 스냅샷). 새 인력은 만들지 않는다(p_new_members = []).
//         **교체 목록은 미리보기 시점의 것**(IN-6): 클라이언트가 미리보기 결과를 그대로 넘기고 서버는
//         파일의 유효 비목 부분집합인지만 본다. 반영 시점 DB로 재판정하면 미리보기 뒤 다른 경로로 들어온
//         행이 있는 비목이 교체 대상이 되어 사용자가 본 적 없는 삭제가 일어난다(D-15a 보호 무력화).
//   PL-10a 금액 산식이 이 파일에 없다 — buildInputFormPreview가 computeDetailAmount로 계산해 둔 값만 옮긴다.
//   RL-1·PL-15 규칙 findings·개월 초과·연봉 없음·유지 비목은 **알림**이다. 반영을 막는 것은 `blocked`뿐이다.
//
// supabase 직접 호출 금지 — 반드시 lib/db/ 리포지토리를 거친다 (절대 규칙 3, §8.6).

import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import type { SupabaseClient } from '@supabase/supabase-js';
import type {
  ActionResult,
  BudgetCategory,
  BudgetDetail,
  DetailAxis,
  Member,
  RuleCode,
  RuleSeverity,
  Year,
} from '@/types';
import { requireApprovedUser } from '@/lib/auth/guard';
import { RuleViolationError, ValidationError, toActionFailure } from '@/lib/db/errors';
import { budgetCategorySchema } from '@/lib/db/schema';
import * as budgetDetailsRepo from '@/lib/db/budget-details';
import * as budgetRulesRepo from '@/lib/db/budget-rules';
import * as membersRepo from '@/lib/db/members';
import * as projectsRepo from '@/lib/db/projects';
import * as snapshotsRepo from '@/lib/db/import-snapshots';
import * as staffRepo from '@/lib/db/staff';
import * as yearsRepo from '@/lib/db/years';
import { aggregateDetails, buildYearTotals } from '@/lib/budget-plan';
import { RULE_SPECS, evaluateRules, type RuleFinding, type RuleRowInput, type RuleYearInput } from '@/lib/rules';
import { monthSpan, todayISO } from '@/lib/dates';
import {
  INPUT_FORM_VERSION,
  buildInputForm as buildInputFormWorkbook,
  buildInputFormPreview,
  parseInputForm,
} from '@/lib/input-form';
import type {
  InputFormData,
  InputFormDeletedRow,
  InputFormPreview,
  InputFormRowStatus,
  InputFormUntouchedCategory,
  InputFormWarning,
  ParseIssue,
} from '@/lib/input-form';
import { writeInputFormWorkbook } from '@/lib/input-form-adapter';
import { readUploadedWorkbook } from '@/lib/import-adapter';

// ─── 화면 계약 (§7.9.7) ───────────────────────────────────────────────────────

/** 미리보기 행의 화면용 축약. 근거 필드 전체(인자·단가·규격)는 화면이 그리지 않으므로 싣지 않는다 */
export interface InputFormPreviewRowView {
  /** `personnel:3`처럼 시트와 1-based 행 번호. React key용 */
  key: string;
  sheet: 'personnel' | 'budget';
  rowIndex: number;
  status: InputFormRowStatus;
  /** 인건비는 성명, 사업비는 품명. 사람이 알아볼 이름 */
  label: string;
  category: BudgetCategory | null;
  subcategory: string | null;
  axis: DetailAxis | null;
  /** 원 단위 정수. error·unknown 행은 0 */
  amount: number;
  /** status='change'일 때 달라진 필드 이름 */
  changedFields: string[];
  /** blocking이 하나라도 있으면 error/unknown 행이다 */
  issues: ParseIssue[];
}

/**
 * §6.14 규칙 finding 한 건. **반영을 막지 않는다** (RL-1·PL-15) — severity가 `error`여도 알림이다.
 * 협의 중인 계획은 한도를 넘나드는 것이 정상이고, 막으면 사용자가 엑셀로 나간다.
 */
export interface InputFormNotice {
  code: RuleCode;
  severity: RuleSeverity;
  /** `규칙 이름 · 어디` — 코드만 던지면 무엇을 고칠지 알 수 없다 */
  label: string;
  message: string;
  /** RL-7·RL-9처럼 가정이 들어간 판정 */
  approximate: boolean;
}

/** 교체 비목 안에서 양식에 없어 지워질 기존 행. 화면이 "무엇이 지워지는지" 보여 주는 재료다 */
export interface InputFormDeletedRowView {
  detailId: string;
  category: BudgetCategory;
  subcategory: string;
  /** 인건비는 성명, 사업비는 품명 */
  label: string;
  amount: number;
}

export interface InputFormPreviewResult {
  fileName: string;
  /** sha256 hex. commitInputForm이 대조한다 (IN-6) */
  fileHash: string;
  yearId: string;
  yearLabel: string;
  summary: InputFormPreview['summary'];
  /** 반영 뒤 연차 모습의 비목별 합계·총액 (원 단위 정수) */
  totals: InputFormPreview['totals'];
  rows: InputFormPreviewRowView[];
  deleted: InputFormDeletedRowView[];
  /** IN-6: 반영 때 클라이언트가 **그대로** commitInputForm에 넘긴다 — 교체 목록은 미리보기 시점의 것이다 */
  replaceCategories: BudgetCategory[];
  /** IN-5: 양식에 유효 행이 없어 기존 행을 그대로 두는 비목 */
  untouchedCategories: InputFormUntouchedCategory[];
  /** 파일 단위 경고(개월 초과·연봉 없음·유지 비목 등). 막지 않는다 */
  warnings: InputFormWarning[];
  /** §6.14 규칙 findings. 막지 않는다 */
  notices: InputFormNotice[];
  /** true면 commitInputForm이 거부한다 — 유일하게 반영을 막는 값 */
  blocked: boolean;
}

export interface InputFormCommitResult {
  snapshotId: string;
  inserted: number;
  deleted: number;
  cells: number;
  /** D-15a: RPC가 실제로 건너뛴 셀 수. 미리보기 시점이 아니라 DB가 맞다 */
  skippedLocked: number;
  summary: InputFormPreview['summary'];
}

// ─── 입력 검증 (§9: 모든 액션은 Zod로 입력 검증) ──────────────────────────────

const uuidSchema = z.uuid();
const fileHashSchema = z.string().trim().min(1, '미리보기를 먼저 실행해야 반영할 수 있습니다.');
// 같은 비목이 두 번 오면 RPC가 한 셀을 두 번 지우려 든다 — 여기서 거른다
const replaceCategoriesSchema = z
  .array(budgetCategorySchema)
  .refine((list) => new Set(list).size === list.length, '교체 비목 목록에 중복이 있습니다.');

function parseOrThrow<T>(schema: z.ZodType<T>, value: unknown, fallback: string): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new ValidationError(parsed.error.issues[0]?.message ?? fallback);
  return parsed.data;
}

// ─── 공통 헬퍼 ────────────────────────────────────────────────────────────────

/** 스냅샷 출처의 시트명. 양식은 두 시트를 한 번에 반영하므로 하나를 고르지 않는다 */
const SOURCE_SHEET_NAME = '인건비+사업비';

// 양식 반영은 budget_details와 budget_items를 함께 바꾼다 — 산출근거 임포트와 같은 범위다
function revalidateInputForm(projectId: string): void {
  revalidatePath('/');
  revalidatePath(`/projects/${projectId}`);
  revalidatePath(`/projects/${projectId}/budget`);
  revalidatePath('/settings');
}

/** 경고에 붙일 연차 이름. 이름은 사용자 입력이라 비어 있을 수 있어 번호를 앞에 둔다 */
function yearLabel(year: Year): string {
  return year.name === '' ? `${year.order + 1}차년도` : `${year.order + 1}차년도 ${year.name}`;
}

function yearLabelOf(years: readonly Year[], yearId: string): string {
  const year = years.find((candidate) => candidate.id === yearId);
  return year ? yearLabel(year) : '(알 수 없는 연차)';
}

/** 사람이 알아볼 이름. 인건비 행은 품명이 비어 있으므로 성명으로 말한다 */
function rowLabel(
  row: { formula: string; memberId: string | null; name: string },
  members: readonly Member[]
): string {
  if (row.formula === 'personnel') {
    const member = members.find((candidate) => candidate.id === row.memberId);
    return member?.name ?? '(인력 미지정)';
  }
  return row.name === '' ? '(품명 없음)' : row.name;
}

function toDeletedRowView(row: InputFormDeletedRow, members: readonly Member[]): InputFormDeletedRowView {
  // 삭제 목록에는 formula가 없다 — memberId가 있으면 인건비 행이다(quantity 행의 member_id는 항상 null)
  const formula = row.memberId === null ? 'quantity' : 'personnel';
  return {
    detailId: row.detailId,
    category: row.category,
    subcategory: row.subcategory,
    label: rowLabel({ formula, memberId: row.memberId, name: row.name }, members),
    amount: row.amount,
  };
}

/**
 * N-13: 연차가 그 과제 소속인지. FK만으로는 막지 못하는 경계다 — `_meta.yearId`는 사용자 손을
 * 거친 파일에서 온 값이라 다른 과제의 연차를 가리킬 수 있고, 그대로 두면 남의 예산이 바뀐다
 */
function requireYearOfProject(years: readonly Year[], yearId: string): Year {
  const year = years.find((candidate) => candidate.id === yearId);
  if (!year) throw new RuleViolationError('이 과제에 속하지 않은 연차입니다.');
  return year;
}

// ─── §6.14 규칙 findings (알림 전용) ──────────────────────────────────────────

/**
 * 저장된 행 → 규칙 판정 행. `amount`는 저장값이 아니라 aggregateDetails가 근거로 다시 계산한 값이다(PL-D7).
 * actions/export.ts의 buildRuleYears와 같은 조립이다 — 'use server' 파일은 async 함수만 export할 수
 * 있어 저쪽의 동기 헬퍼를 가져다 쓸 수 없다.
 */
function storedRuleRows(details: readonly BudgetDetail[], members: readonly Member[]): RuleRowInput[] {
  const memberById = new Map(members.map((member) => [member.id, member]));
  const aggregate = aggregateDetails(details, members);
  return details.map((detail, index) => {
    const computed = aggregate.rows[index];
    // 집계는 입력과 같은 순서·길이를 보장한다. 어긋나면 금액이 다른 행에 붙는다는 뜻이다
    if (!computed) throw new ValidationError('산출근거 금액을 계산하지 못했습니다.');
    const member = detail.memberId === null ? null : (memberById.get(detail.memberId) ?? null);
    return {
      detail,
      amount: computed.amount,
      member: member === null ? null : { id: member.id, hireType: member.hireType },
    };
  });
}

/**
 * 반영 대상 연차의 **반영 뒤 모습**: 양식의 유효 행 + 유지 비목의 기존 행. 규칙 경고가 "지금 DB"가 아니라
 * "반영하면 이렇게 된다"에 대한 것이어야 사용자가 올리기 전에 고칠 수 있다.
 * 새 행에는 id가 없으므로 미리보기 키를 id 자리에 둔다 — finding의 scope가 그 키를 가리키면 라벨을 되찾는다.
 */
function projectedRuleRows(
  preview: InputFormPreview,
  existingDetails: readonly BudgetDetail[],
  members: readonly Member[]
): RuleRowInput[] {
  const memberById = new Map(members.map((member) => [member.id, member]));
  const replaceSet = new Set(preview.replaceCategories);
  const rows: RuleRowInput[] = [];
  for (const row of preview.rows) {
    if (row.status === 'error' || row.status === 'unknown') continue;
    if (row.category === null || row.subcategory === null || row.axis === null) continue;
    const member = row.memberId === null ? null : (memberById.get(row.memberId) ?? null);
    rows.push({
      detail: {
        id: row.detailId ?? row.key,
        category: row.category,
        subcategory: row.subcategory,
        axis: row.axis,
        formula: row.formula,
        memberId: row.memberId,
        name: row.name,
        factors: row.factors,
      },
      amount: row.amount,
      member: member === null ? null : { id: member.id, hireType: member.hireType },
    });
  }
  const untouched = existingDetails.filter((detail) => !replaceSet.has(detail.category));
  return [...rows, ...storedRuleRows(untouched, members)];
}

/**
 * 전 연차를 판정한다 — 과제 단위 규칙(RL-8·RL-9)이 있다. 대상 연차만 반영 뒤 모습이고 나머지는 저장된 그대로다.
 * 대상 연차의 totals는 `preview.totals.cells`다 — 미리보기 화면의 합계와 경고의 비율이 같은 재료여야 한다.
 */
function buildRuleYears(
  years: readonly Year[],
  allDetails: readonly BudgetDetail[],
  members: readonly Member[],
  preview: InputFormPreview
): RuleYearInput[] {
  return years.map((year) => {
    if (year.id === preview.yearId) {
      const existing = allDetails.filter((detail) => detail.yearId === year.id);
      return {
        yearId: year.id,
        totals: buildYearTotals(preview.totals.cells),
        rows: projectedRuleRows(preview, existing, members),
      };
    }
    const yearDetails = allDetails.filter((detail) => detail.yearId === year.id);
    const aggregate = aggregateDetails(yearDetails, members);
    return {
      yearId: year.id,
      totals: buildYearTotals(aggregate.cells),
      rows: storedRuleRows(yearDetails, members),
    };
  });
}

/** RuleFinding → 알림. `blocked`에 섞지 않는다 (RL-1·PL-15) */
function ruleFindingNotice(
  finding: RuleFinding,
  years: readonly Year[],
  preview: InputFormPreview,
  existingDetails: readonly BudgetDetail[],
  members: readonly Member[]
): InputFormNotice {
  const spec = RULE_SPECS[finding.code];
  let where: string;
  if (finding.scope.kind === 'project') {
    where = '과제 전체';
  } else if (finding.scope.kind === 'year') {
    where = yearLabelOf(years, finding.scope.yearId);
  } else {
    const detailId = finding.scope.detailId;
    // 양식 행은 미리보기 키(새 행) 또는 detailId(기존 행), 유지 비목 행은 저장된 id로 찾는다
    const formRow = preview.rows.find((row) => (row.detailId ?? row.key) === detailId);
    const stored = existingDetails.find((candidate) => candidate.id === detailId);
    const target = formRow ?? stored;
    const rowName = target ? rowLabel(target, members) : '(알 수 없는 행)';
    where = `${yearLabelOf(years, finding.scope.yearId)} · ${rowName}`;
  }
  return {
    code: finding.code,
    severity: finding.severity,
    label: `${spec.label} · ${where}`,
    message: finding.message,
    approximate: finding.approximate,
  };
}

// ─── 파이프라인 (미리보기·반영이 같은 경로를 쓴다 — IN-6) ────────────────────

interface InputFormPipelineResult {
  fileName: string;
  fileHash: string;
  year: Year;
  /** 미리보기에 쓴 명부 그대로 — 화면 라벨을 만들 때 다시 조회하면 그 사이 바뀐 명부를 보게 된다 */
  members: Member[];
  preview: InputFormPreview;
  /** 행에 매이지 않는 파일 단위 문제(파서). blocking이면 preview.blocked에 이미 반영돼 있다 */
  fileIssues: ParseIssue[];
  notices: InputFormNotice[];
}

/**
 * previewInputForm과 commitInputForm이 **공유하는 유일한 파싱 경로**. 판정을 두 번 쓰면 반드시 어긋난다.
 *
 * 순서: 파일 읽기(어댑터) → 고정 좌표 파싱 + `_meta` 거부 3종(IN-2) → 연차 과제 경계(N-13) →
 * 명부·기존 산출근거 → buildInputFormPreview(IN-3~IN-5) → 규칙 findings(§6.14, 알림).
 */
async function runInputFormPipeline(
  client: SupabaseClient,
  projectId: string,
  formData: FormData
): Promise<InputFormPipelineResult> {
  const upload = await readUploadedWorkbook(formData); // I-13·I-14·I-15는 어댑터가 지킨다

  const parsed = parseInputForm(upload.sheets, { projectId, formVersion: INPUT_FORM_VERSION });
  // IN-2: 파일째 거부. 문구는 파서가 정한다 — 여기서 다시 쓰면 두 사전이 갈린다
  if (!parsed.ok) throw new RuleViolationError(parsed.rejection.message);

  // 하나라도 실패하면 실패를 그대로 올린다 — 빈 배열 폴백은 예산이 사라진 것을 감춘다 (절대 규칙 5)
  const [project, years, details, members, rules] = await Promise.all([
    projectsRepo.getProjectById(client, projectId),
    yearsRepo.listYears(client, projectId),
    budgetDetailsRepo.listByProject(client, projectId),
    membersRepo.listMembers(client, projectId),
    budgetRulesRepo.listByProject(client, projectId),
  ]);
  const year = requireYearOfProject(years, parsed.parsed.meta.yearId);
  const existingDetails = details.filter((detail) => detail.yearId === year.id);

  const preview = buildInputFormPreview({
    parsed: parsed.parsed,
    yearId: year.id,
    projectId,
    members,
    existingDetails,
    // 연차 날짜가 없으면 개월 초과 경고를 낼 수 없다 — 0으로 꾸며 전 행에 경고를 띄우지 않는다
    yearMonths:
      year.startDate !== null && year.endDate !== null ? monthSpan(year.startDate, year.endDate) : null,
  });

  // §6.14: 규칙 0건이면 findings도 0건이다 (PL-14). severity 순서는 evaluateRules가 정했다.
  // 행 단위 finding은 대상 연차만 싣는다 — 다른 연차의 행은 이 양식에서 고칠 수 있는 것이 아니다
  const evaluation = evaluateRules(rules, {
    years: buildRuleYears(years, details, members, preview),
    project: {
      govBudget: project.govBudget,
      ownBudget: project.ownBudget,
      totalBudget: project.totalBudget,
    },
  });
  const notices: InputFormNotice[] = [];
  for (const finding of evaluation.findings) {
    if (finding.scope.kind === 'detail' && finding.scope.yearId !== year.id) continue;
    notices.push(ruleFindingNotice(finding, years, preview, existingDetails, members));
  }

  return {
    fileName: upload.fileName,
    fileHash: upload.fileHash,
    year,
    members,
    preview,
    fileIssues: parsed.parsed.issues,
    notices,
  };
}

/** 반영을 막은 첫 이유. "안 됩니다"만으로는 어느 행을 고칠지 알 수 없다 */
function firstBlockingReason(preview: InputFormPreview, parsedIssues: readonly ParseIssue[]): string {
  const fileIssue = parsedIssues.find((issue) => issue.blocking);
  if (fileIssue) return fileIssue.message;
  for (const row of preview.rows) {
    const issue = row.issues.find((candidate) => candidate.blocking);
    if (issue) {
      const sheetName = row.sheet === 'personnel' ? '인건비' : '사업비';
      return `${sheetName} 시트 ${row.rowIndex}행: ${issue.message}`;
    }
  }
  // D-15b: 교체 비목에 넣을 유효 행이 없다 — 내용 없는 삭제가 된다
  return '교체할 비목에 반영할 행이 없습니다.';
}

// ─── §9 buildInputForm ────────────────────────────────────────────────────────

/**
 * 연차 하나의 입력 양식 xlsx (§7.9.7 [입력 양식 내려받기]). **읽기 전용이다** — 앱 데이터를 바꾸지 않는다.
 * 파일 저장은 호출자(셸)의 몫이라 base64로 돌려준다 — 서버는 디스크에 쓰지 않는다.
 *
 * 명부는 비활성 인력까지 전부 싣는다 — 생성기는 명부에 없는 memberId를 가진 인건비 행을 만나면 던진다
 * (조용히 빠뜨리지 않는다). 활성 여부로 거르면 참여 종료자의 산출근거가 양식에서 사라진다.
 */
export async function buildInputForm(
  projectId: string,
  yearId: string
): Promise<ActionResult<{ fileName: string; contentBase64: string }>> {
  try {
    const pid = parseOrThrow(uuidSchema, projectId, '과제 ID 형식이 올바르지 않습니다.');
    const yid = parseOrThrow(uuidSchema, yearId, '연차 ID 형식이 올바르지 않습니다.');
    const { client } = await requireApprovedUser();

    const [project, years, details, members, staff] = await Promise.all([
      projectsRepo.getProjectById(client, pid),
      yearsRepo.listYears(client, pid),
      budgetDetailsRepo.listByProject(client, pid),
      membersRepo.listMembers(client, pid),
      // 퇴사자도 포함한다 — 연결된 조직원 이름은 표시용이고, 퇴사했다고 연결이 끊긴 것이 아니다(HR-5)
      staffRepo.listStaff(client, { includeRetired: true }),
    ]);
    const year = requireYearOfProject(years, yid);
    const staffNameById = new Map(staff.map((person) => [person.id, person.name]));

    const data: InputFormData = {
      project: { id: project.id, name: project.name },
      year: {
        id: year.id,
        name: year.name,
        startDate: year.startDate,
        endDate: year.endDate,
        order: year.order,
      },
      members: members.map((member) => ({
        ...member,
        staffName: member.staffId === null ? null : (staffNameById.get(member.staffId) ?? null),
      })),
      details: details.filter((detail) => detail.yearId === year.id),
    };

    const workbook = buildInputFormWorkbook(data, todayISO(new Date()));
    const buffer = writeInputFormWorkbook(workbook);

    return {
      ok: true,
      data: { fileName: workbook.fileName, contentBase64: buffer.toString('base64') },
    };
  } catch (e) {
    return toInputFormFailure(e);
  }
}

// ─── §9 previewInputForm ──────────────────────────────────────────────────────

/**
 * 추가·변경·삭제·유지 건수 + 합계 + 경고 + 규칙 findings (§7.9.7 [입력 양식 올리기] 미리보기).
 * **저장하는 것은 없다.** 리포지토리 호출은 전부 읽기다.
 */
export async function previewInputForm(
  projectId: string,
  formData: FormData
): Promise<ActionResult<InputFormPreviewResult>> {
  try {
    const pid = parseOrThrow(uuidSchema, projectId, '과제 ID 형식이 올바르지 않습니다.');
    const { client } = await requireApprovedUser();

    const result = await runInputFormPipeline(client, pid, formData);
    const { preview, members } = result;

    return {
      ok: true,
      data: {
        fileName: result.fileName,
        fileHash: result.fileHash,
        yearId: result.year.id,
        yearLabel: yearLabel(result.year),
        summary: preview.summary,
        totals: preview.totals,
        rows: preview.rows.map((row) => ({
          key: row.key,
          sheet: row.sheet,
          rowIndex: row.rowIndex,
          status: row.status,
          label: rowLabel(row, members),
          category: row.category,
          subcategory: row.subcategory,
          axis: row.axis,
          amount: row.amount,
          changedFields: row.changedFields,
          issues: row.issues,
        })),
        deleted: preview.deleted.map((row) => toDeletedRowView(row, members)),
        replaceCategories: preview.replaceCategories,
        untouchedCategories: preview.untouchedCategories,
        warnings: preview.warnings,
        notices: result.notices,
        blocked: preview.blocked,
      },
    };
  } catch (e) {
    return toInputFormFailure(e);
  }
}

// ─── §9 commitInputForm ───────────────────────────────────────────────────────

/**
 * 비목 단위 교체(IN-5·D-15) + `budget_items` 재계산(PL-10) + 스냅샷(D-17)이 **한 트랜잭션**이다 (D-16).
 * 액션은 미리보기 결과를 RPC 페이로드로 옮기기만 한다 — 판정을 다시 하지 않는다.
 *
 * `replaceCategories`는 **미리보기 시점의 목록**을 클라이언트가 그대로 넘긴다(IN-6). 파일은 다시 파싱하지만
 * 교체 목록은 재판정하지 않는다 — 미리보기 뒤 다른 경로로 들어온 행이 있는 비목을 여기서 교체 대상에 넣으면
 * 사용자가 본 적 없는 삭제가 일어나고, RPC의 D-15a 건너뜀은 절대 발동하지 않는다.
 *
 * 막는 것은 셋뿐이다: 미리보기와 다른 파일(fileHash), 파일의 유효 비목 밖을 가리키는 교체 목록, 그리고 `blocked`.
 * 경고는 전부 통과한다 (RL-1·PL-15).
 */
export async function commitInputForm(
  projectId: string,
  formData: FormData,
  fileHash: string,
  replaceCategories: unknown
): Promise<ActionResult<InputFormCommitResult>> {
  try {
    const pid = parseOrThrow(uuidSchema, projectId, '과제 ID 형식이 올바르지 않습니다.');
    const expectedHash = parseOrThrow(fileHashSchema, fileHash, '미리보기를 먼저 실행해야 반영할 수 있습니다.');
    const requestedReplace = parseOrThrow(
      replaceCategoriesSchema,
      replaceCategories,
      '교체 비목 목록이 올바르지 않습니다.'
    );
    const { client } = await requireApprovedUser();

    // previewInputForm과 같은 경로 (IN-6)
    const result = await runInputFormPipeline(client, pid, formData);
    if (result.fileHash !== expectedHash) {
      throw new ValidationError('파일이 미리보기 때와 다릅니다 — 다시 올리세요');
    }

    const { preview } = result;
    if (preview.blocked) {
      throw new RuleViolationError(`반영할 수 없습니다 — ${firstBlockingReason(preview, result.fileIssues)}`);
    }
    if (preview.commitRows.length === 0) {
      // RPC도 거부하지만 그 문구는 임포트용이다 — 양식이 비어 있다는 사실을 그대로 말한다
      throw new RuleViolationError('반영할 내역이 없습니다 — 양식의 인건비·사업비 시트가 비어 있습니다.');
    }

    // 파일에 유효 행이 있는 비목(교체 + 추가만)의 부분집합이어야 한다. 밖의 비목을 교체하면 D-15b의
    // "내용 없는 삭제"가 된다 — RPC도 막지만 그 문구는 임포트용이라 여기서 먼저 말한다
    const validCategories = new Set<BudgetCategory>([...preview.replaceCategories, ...preview.addOnlyCategories]);
    const outside = requestedReplace.filter((category) => !validCategories.has(category));
    if (outside.length > 0) {
      throw new ValidationError(
        `교체 비목 목록이 파일과 맞지 않습니다 (${outside.join(', ')}). 파일을 바꿨다면 미리보기부터 다시 진행하세요.`
      );
    }

    const committed = await snapshotsRepo.commitDetailImport(
      client,
      pid,
      result.year.id,
      [], // IN-3: 양식은 새 인력을 만들지 않는다 — 앱에서 먼저 만든다
      preview.commitRows,
      requestedReplace,
      { fileName: result.fileName, sheetName: SOURCE_SHEET_NAME, fileHash: result.fileHash }
    );

    revalidateInputForm(pid);
    return {
      ok: true,
      data: {
        snapshotId: committed.snapshotId,
        inserted: committed.inserted,
        deleted: committed.deleted,
        cells: committed.cells,
        skippedLocked: committed.skippedLocked,
        summary: preview.summary,
      },
    };
  } catch (e) {
    return toInputFormFailure(e);
  }
}

/**
 * 순수 계층·어댑터는 `Error`(또는 lib/dates의 RangeError)를 던진다. 그대로 두면 toActionFailure가
 * "요청 처리 중 오류가 발생했습니다"로 덮어 **무엇이 왜 안 됐는지**가 사라진다 — 이 경로의 메시지는
 * 전부 사용자에게 보여 주려고 쓴 문장이므로 그대로 올린다 (절대 규칙 5). actions/export.ts와 같은 태도다.
 */
function toInputFormFailure(e: unknown): ActionResult<never> {
  if (e instanceof Error && (e.constructor === Error || e instanceof RangeError)) {
    console.error('[actions/input-form] 입력 양식 처리 실패:', e);
    return { ok: false, error: e.message, code: 'RULE' };
  }
  return toActionFailure(e);
}
