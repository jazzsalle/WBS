"use server";

// 협약 예산 보기 엑셀 내려받기 (SOT §9 Agreement Budget, §6.19 AG-8, 부록 F, Phase 24 계획서 S-11·S-15,
// Phase 25 계획서 S-19 — 붙임4형·조정회의형·참여인원)
//
// 화면의 보기(비목별·붙임4형·조정회의형·참여인원·변경 이력)가 쓰는 것과 **같은 순수 함수**로 표 모델을 만들고, 그 모델을 그대로 시트로 옮긴다
// — [복사](TSV)와 엑셀이 같은 모델에서 나와야 "받은 표"와 "붙여 넣은 표"가 칸마다 같다(AG-8).
//   · 표 계산은 lib/agreement/ (category-view·attachment4-view·adjustment-view·participants·from-plan·diff·
//     preservation·changes-table·table)
//   · 워크북 쓰기는 lib/input-form-adapter.ts(server-only) — exceljs를 import하는 파일을 늘리지 않는다(IN-8)
//   · 여기서는 인증(SA-1)·입력 검증·과제 경계·리포지토리 조회만 한다. **읽기 전용** — 앱 데이터를 바꾸지 않는다
//
// 확정·작성 중 버전 모두 내려받을 수 있다 — 내려받기는 내용 쓰기가 아니다(AV-2 잠금은 쓰기만 막는다).
//
// supabase 직접 호출 금지 — 반드시 lib/db/ 리포지토리를 거친다 (절대 규칙 3, §8.6).

import { z } from "zod";
import type { ActionResult, AgreementVersion } from "@/types";
import { requireApprovedUser } from "@/lib/auth/guard";
import {
  RepositoryError,
  RuleViolationError,
  ValidationError,
  toActionFailure,
} from "@/lib/db/errors";
import * as agreementsRepo from "@/lib/db/agreements";
import * as budgetDetailsRepo from "@/lib/db/budget-details";
import * as budgetItemsRepo from "@/lib/db/budget-items";
import * as budgetRulesRepo from "@/lib/db/budget-rules";
import * as membersRepo from "@/lib/db/members";
import * as projectsRepo from "@/lib/db/projects";
import * as stagesRepo from "@/lib/db/stages";
import * as yearsRepo from "@/lib/db/years";
import {
  AGREEMENT_VERSION_KIND_LABELS,
  AGREEMENT_VERSION_STATUS_LABELS,
  AGREEMENT_VIEW_TEXT,
  BUDGET_CATEGORY_LABELS,
} from "@/lib/constants";
import { todayISO } from "@/lib/dates";
import {
  buildCategoryView,
  categoryViewTable,
} from "@/lib/agreement/category-view";
import {
  diffAgreementLines,
  diffAgreementParticipants,
} from "@/lib/agreement/diff";
import { checkSubcategoryPreservation } from "@/lib/agreement/preservation";
import {
  buildLineChangesTable,
  buildParticipantChangesTable,
  buildPreservationTable,
} from "@/lib/agreement/changes-table";
import {
  attachment4Tables,
  buildAttachment4View,
  formatWon,
} from "@/lib/agreement/attachment4-view";
import {
  adjustmentTable,
  buildAdjustmentView,
} from "@/lib/agreement/adjustment-view";
import {
  buildParticipantsView,
  participantsTable,
} from "@/lib/agreement/participants";
import { buildBaselineFromPlan } from "@/lib/agreement/from-plan";
import { RATE_NONE_TEXT } from "@/lib/agreement/rates";
import { baseVersionId, currentVersionId } from "@/lib/agreement/versions";
import {
  agreementWorkbookFileName,
  toFormWorkbook,
  type TableGuide,
} from "@/lib/agreement/table";
import type { InputFormWorkbook } from "@/lib/input-form/types";
import { writeInputFormWorkbook } from "@/lib/input-form-adapter";

// ─── 입력 검증 (§9: 모든 액션은 Zod로 입력 검증) ──────────────────────────────

const uuidSchema = z.uuid();

const workbookRequestSchema = z.discriminatedUnion("view", [
  z.strictObject({
    view: z.literal("category"),
    versionId: z.uuid("버전 ID 형식이 올바르지 않습니다."),
  }),
  // Phase 25 보기 3종(S-19) — 모두 버전 하나를 본다
  z.strictObject({
    view: z.literal("attachment4"),
    versionId: z.uuid("버전 ID 형식이 올바르지 않습니다."),
  }),
  z.strictObject({
    view: z.literal("adjustment"),
    versionId: z.uuid("버전 ID 형식이 올바르지 않습니다."),
  }),
  z.strictObject({
    view: z.literal("participants"),
    versionId: z.uuid("버전 ID 형식이 올바르지 않습니다."),
  }),
  z.strictObject({
    view: z.literal("changes"),
    fromVersionId: z.uuid("비교 기준 버전 ID 형식이 올바르지 않습니다."),
    toVersionId: z.uuid("비교 대상 버전 ID 형식이 올바르지 않습니다."),
  }),
]);

export type AgreementWorkbookRequest = z.infer<typeof workbookRequestSchema>;

function parseOrThrow<T>(
  schema: z.ZodType<T>,
  value: unknown,
  fallback: string,
): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success)
    throw new ValidationError(parsed.error.issues[0]?.message ?? fallback);
  return parsed.data;
}

// ─── 공통 헬퍼 ────────────────────────────────────────────────────────────────

/** 시트 이름(AG-8). 작성안내는 table.ts가 첫 시트로 붙인다 */
const SHEET_NAMES = {
  category: "비목별",
  lineChanges: "금액 증감",
  participantChanges: "참여인원 증감",
  preservation: "세목 총액 보존",
  plan81: "8-1 지원·부담계획",
  plan82: "8-2 사용계획",
  adjustment: "조정회의형",
  participants: "참여인원",
} as const;

/** 파일명 라벨(S-19) — `{버전 이름} 붙임4형` 등. 같은 버전의 보기끼리 파일이 덮이지 않게 */
const VIEW_FILE_LABELS = {
  attachment4: "붙임4형",
  adjustment: "조정회의형",
  participants: "참여인원",
} as const;

const MODE_LABEL = "수행 모드(협약 예산)";

/** 다른 과제의 버전 id는 존재 여부를 가리지 않고 같은 문구로 거부한다 — 남의 과제 버전이 있는지 알려 주지 않는다 */
function requireVersionOfProject(
  versions: readonly AgreementVersion[],
  versionId: string,
): AgreementVersion {
  const version = versions.find((candidate) => candidate.id === versionId);
  if (!version)
    throw new RuleViolationError("이 과제에 속하지 않은 협약 예산 버전입니다.");
  return version;
}

/** `최종협약본 '최종협약본' · 확정 2026-10-02 · 순번 1` — 작성안내에서 데이터 출처를 사람이 대조할 수 있게 */
function describeVersion(version: AgreementVersion): string {
  const kind = AGREEMENT_VERSION_KIND_LABELS[version.kind];
  const status =
    version.status === "confirmed" && version.confirmedAt !== null
      ? `${AGREEMENT_VERSION_STATUS_LABELS.confirmed} ${todayISO(new Date(version.confirmedAt))}`
      : AGREEMENT_VERSION_STATUS_LABELS[version.status];
  return `${kind} '${version.name}' · ${status} · 순번 ${version.order}`;
}

/** 작성 중 버전의 숫자는 아직 바뀔 수 있다 — 받은 파일을 확정본으로 오해하지 않게 */
function draftCaution(versions: readonly AgreementVersion[]): string[] {
  const drafts = versions.filter((v) => v.status === "draft");
  if (drafts.length === 0) return [];
  return [
    `'${drafts.map((v) => v.name).join("', '")}'은(는) 작성 중 버전입니다 — 확정 전이라 금액이 바뀔 수 있습니다.`,
  ];
}

const UNIT_PRINCIPLE =
  "금액은 모두 원 단위 정수입니다(설정의 표시 단위와 관계없이 환산하지 않습니다). 빈 칸은 금액 줄이 없다는 뜻이고 0과 다릅니다.";
const FORMULA_PRINCIPLE =
  "합계·증감 칸은 엑셀 수식이고 내려받을 때의 결과값이 함께 들어 있습니다 — 칸을 고치면 수식이 다시 계산합니다.";
const RATE_PRINCIPLE =
  `비율 칸은 수식이 아니라 글자(소수 둘째 자리 + %)입니다 — 금액 칸을 고쳐도 비율은 다시 계산되지 않습니다. 계산할 수 없는 칸은 "${RATE_NONE_TEXT}"입니다.`;
const SOURCE_PRINCIPLE =
  "이 양식의 칸은 협약 예산 금액 줄(소스)에서 자동으로 채운 것입니다 — 양식 전용으로 저장된 값은 없습니다.";
const READ_ONLY_CAUTION =
  "이 파일은 보기용 내보내기입니다. 고쳐도 앱에 반영되지 않습니다 — 협약 예산은 연구비 화면 수행 모드에서 고칩니다.";

/**
 * lib/agreement 순수 함수가 던지는 일반 Error는 저장된 데이터가 표 모델의 전제(연차 소속·세목 코드·정수)를 벗어났다는
 * 뜻이다 — 일반 실패 문구로 덮으면 무엇이 어긋났는지 알 수 없으므로 사람 메시지로 바꿔 알린다(절대 규칙 5).
 * 이 감싸기는 순수 함수 호출에만 쓴다 — 리포지토리의 일반 Error(테이블·제약 이름이 든 원문)까지 여기로 오면
 * 내부 이름이 사용자에게 새어 나간다(SA-4). 리포지토리 오류는 바깥 catch의 toActionFailure가 일반 문구로 감춘다.
 */
function computeOrCorrupt<T>(compute: () => T): T {
  try {
    return compute();
  } catch (e) {
    if (e instanceof RepositoryError) throw e;
    console.error("[actions/agreement-export] 협약 예산 표 계산 실패:", e);
    const detail = e instanceof Error ? e.message : String(e);
    throw new ValidationError(`협약 예산 데이터가 손상되었습니다 — ${detail}`);
  }
}

/** 어댑터 오류도 같은 이유로 사람 메시지로 바꾼다 — 어댑터 메시지는 시트·셀 위치뿐이다 */
async function encode(
  workbook: InputFormWorkbook,
): Promise<{ fileName: string; contentBase64: string }> {
  let buffer: Buffer;
  try {
    buffer = await writeInputFormWorkbook(workbook);
  } catch (e) {
    console.error("[actions/agreement-export] 협약 예산 엑셀 쓰기 실패:", e);
    const detail = e instanceof Error ? e.message : String(e);
    throw new ValidationError(`협약 예산 엑셀을 만들지 못했습니다 — ${detail}`);
  }
  return {
    fileName: workbook.fileName,
    contentBase64: buffer.toString("base64"),
  };
}

// ─── Phase 25 보기 3종 (S-19) ─────────────────────────────────────────────────

type ActionClient = Awaited<ReturnType<typeof requireApprovedUser>>["client"];

interface ViewContext {
  client: ActionClient;
  project: { id: string; name: string };
  years: Awaited<ReturnType<typeof yearsRepo.listYears>>;
  versions: readonly AgreementVersion[];
  version: AgreementVersion;
  today: string;
}

/** 붙임4형: 작성안내 + 8-1 + 8-2(AG-3). 정부지원 현금은 그 버전의 §5.25 행, 판정은 과제 규칙 행 */
async function attachment4Workbook(
  ctx: ViewContext,
): Promise<InputFormWorkbook> {
  const { client, project, years, version, today } = ctx;
  const [stages, lines, govSupport, rules] = await Promise.all([
    stagesRepo.listStages(client, project.id),
    agreementsRepo.listLinesByVersionIds(client, [version.id]),
    agreementsRepo.listGovSupportByVersionIds(client, [version.id]),
    budgetRulesRepo.listByProject(client, project.id),
  ]);
  return computeOrCorrupt(() => {
    const view = buildAttachment4View({
      lines,
      years,
      stages,
      govSupport,
      rules,
    });
    const tables = attachment4Tables(view, {
      plan81: `8-1 연구개발비 지원 및 부담계획 — ${version.name}`,
      plan82: `8-2 연구개발비 사용계획 — ${version.name}`,
    });
    const reviewBody =
      view.reviewNotes.length === 0
        ? "없음."
        : view.reviewNotes.map((n) => `· ${n.message}`).join("\n");
    const guide: TableGuide = {
      title: `${project.name} — 협약 예산 붙임4형`,
      subtitle: `생성 ${today} · ${version.name} · ${MODE_LABEL}`,
      entries: [
        {
          label: "목적",
          body: "협약 예산 버전 하나를 붙임4 양식 모양(8-1 연구개발비 지원 및 부담계획, 8-2 연구개발비 사용계획)으로 묶은 표입니다(붙임4형 보기와 같은 표).",
        },
        { label: "데이터 출처", body: describeVersion(version) },
        {
          label: "8-2 양식 기호",
          body:
            "양식의 E1은 총 인건비(A+B+C+D, 현금+현물), E2는 수정인건비입니다 — 앱 산출식(PL-11)의 E1(수정인건비)과 기호가 다릅니다. 연구수당 비율은 I/E2입니다. " +
            `연구활동비 H는 연구활동비와 성과 활용·확산 지원비의 합입니다. 양식에 행이 없는 비목은 '${AGREEMENT_VIEW_TEXT.outsideCategoriesRow}' 행으로 보이고(0이 아닐 때만) 직접비 소계 K·총액 M에 들어갑니다. ` +
            `(간접비 중 연구실 안전관리비) 행은 대응하는 세목이 없어(소스 없음) 전 칸 "${RATE_NONE_TEXT}"입니다 — 0원이라는 뜻이 아닙니다.`,
        },
        {
          label: "간접비 비율",
          body: "양식 시트의 식 그대로 L ÷ 양식 분모(A현금 + B현금 + C + D일반 + D통합관리 + F현금 + G현금 + H현금 + I)입니다. 이 분모는 연구비 사용 규칙(RL-3)의 수정직접비와 별개입니다. 비율은 표시만 하고 판정하지 않습니다.",
        },
        {
          label: "8-1 지원·부담계획",
          body:
            `우리 기관 한 행만 보입니다(기업유형 '${AGREEMENT_VIEW_TEXT.companyType}' 고정, 그 외 기관 지원금 0). 정부지원 현금 A = 그 연차에 입력한 정부지원 현금, 기관부담 현금 B = 그 연차 현금 합 − A, 현물 C = 그 연차 현물 합, D = B + C, 합계 H = 현금 + 현물. ` +
            `A가 미입력이거나 현금 합보다 크면 그 연차의 A·B·두 비율은 "${RATE_NONE_TEXT}"이고, 미입력 연차가 하나라도 있으면 합계 행도 "${RATE_NONE_TEXT}"입니다. ` +
            `정부출연금비율(A/H)·민간현금비율(B/D) 판정은 연구비 사용 규칙에 그 규칙 행이 켜져 있고 값이 있을 때만 하고, 없으면 '${AGREEMENT_VIEW_TEXT.judgementSkipped}'과 사유를 적습니다.`,
        },
        { label: "검토사항", body: reviewBody },
        {
          label: "원칙",
          body: `${UNIT_PRINCIPLE} ${FORMULA_PRINCIPLE} ${RATE_PRINCIPLE} ${SOURCE_PRINCIPLE}`,
        },
        {
          label: "주의",
          body: [...draftCaution([version]), READ_ONLY_CAUTION].join(" "),
        },
      ],
    };
    return toFormWorkbook({
      guide,
      tables: [
        { sheetName: SHEET_NAMES.plan81, model: tables.plan81 },
        { sheetName: SHEET_NAMES.plan82, model: tables.plan82 },
      ],
      fileName: agreementWorkbookFileName(
        project.name,
        `${version.name} ${VIEW_FILE_LABELS.attachment4}`,
        today,
      ),
    });
  });
}

/**
 * 조정회의형: 작성안내 + 한 시트(AG-4). 변경전 = 제안 모드 사업비를 보내기와 같은 변환(AV-6)으로 바꾼 줄,
 * 변경후 = 그 버전. 변환 실패는 표의 사유 행으로 나간다 — 0으로 채우지 않는다(절대 규칙 5)
 */
async function adjustmentWorkbook(
  ctx: ViewContext,
): Promise<InputFormWorkbook> {
  const { client, project, years, versions, version, today } = ctx;
  const [lines, items, details, members] = await Promise.all([
    agreementsRepo.listLinesByVersionIds(client, [version.id]),
    budgetItemsRepo.listBudgetItemsByProject(client, project.id),
    budgetDetailsRepo.listByProject(client, project.id),
    membersRepo.listMembers(client, project.id),
  ]);
  return computeOrCorrupt(() => {
    const baseline = buildBaselineFromPlan({ items, details, members, years });
    const view = buildAdjustmentView({
      years,
      before: baseline,
      after: { versionId: version.id, versionName: version.name, lines },
      currentVersionId: currentVersionId(versions),
    });
    const model = adjustmentTable(view, `조정회의형 — ${version.name}`);

    const yearName = new Map(years.map((y) => [y.id, y.name]));
    let beforeBody: string;
    if (!baseline.ok) {
      beforeBody =
        `제안 데이터를 협약 금액 줄로 바꾸지 못해 변경전 칸을 "${RATE_NONE_TEXT}"로 두었습니다 — 0으로 채우지 않았습니다. 표 마지막 '변경전 사유' 행과 아래 사유를 보고 제안 모드에서 고치세요.\n` +
        baseline.issues.map((i) => `· ${i.message}`).join("\n");
    } else if (baseline.summary.unsplit.count > 0) {
      const cells = baseline.summary.unsplit.cells
        .map(
          (c) =>
            `${yearName.get(c.yearId) ?? c.yearId} ${BUDGET_CATEGORY_LABELS[c.category]} ${formatWon(c.amount)}`,
        )
        .join(", ");
      beforeBody = `현금·현물을 나누지 않은 제안 셀 ${baseline.summary.unsplit.count}개(합 ${formatWon(baseline.summary.unsplit.amount)})는 현금으로 넣었습니다: ${cells}.`;
    } else {
      beforeBody = "제안 데이터를 모두 변환했습니다.";
    }

    const guide: TableGuide = {
      title: `${project.name} — 협약 예산 조정회의형`,
      subtitle: `생성 ${today} · ${version.name} · ${MODE_LABEL}`,
      entries: [
        {
          label: "목적",
          body: "조정회의 양식의 (변경전)·(변경후) 두 표를 한 시트에 나란히 놓은 표입니다(조정회의형 보기와 같은 표).",
        },
        {
          label: "변경전",
          body: `${AGREEMENT_VIEW_TEXT.adjustmentBefore} = 협약 버전이 아니라 연구비 화면 제안 모드의 사업비입니다. [협약 기준선으로 보내기]와 같은 변환(현금·현물을 모르는 셀은 현금)으로 금액 줄을 만든 뒤 같은 양식 행 집계를 씁니다.`,
        },
        { label: "변경전 변환", body: beforeBody },
        {
          label: "변경후",
          body:
            `변경후 = 협약 예산 버전 ${describeVersion(version)}.` +
            (view.notCurrentVersion
              ? ` 이 버전은 현재 버전이 아닙니다(${AGREEMENT_VIEW_TEXT.notCurrentVersion}).`
              : ""),
        },
        {
          label: "행 정의",
          body:
            "인건비 A = 붙임4 양식 E2(수정인건비 — 연구지원인력인건비 제외) · 연구수당 B = 양식 I · 간접비 C = 양식 L · 합계 D = A + B + C · 연구개발비 총액 E = 양식 M · 직접비 F = 양식 K. 비율은 D/E · B/A · A/F입니다. " +
            "간접비 비율은 붙임4 양식 분모(A현금 + B현금 + C + D일반 + D통합관리 + F현금 + G현금 + H현금 + I)로 나눈 값이고, 연구비 사용 규칙(RL-3)의 수정직접비와 별개입니다. " +
            `금액 줄이 없는 연차는 금액 빈 칸·비율 "${RATE_NONE_TEXT}"입니다.`,
        },
        {
          label: "원칙",
          body: `${UNIT_PRINCIPLE} ${FORMULA_PRINCIPLE} ${RATE_PRINCIPLE} ${SOURCE_PRINCIPLE}`,
        },
        {
          label: "주의",
          body: [...draftCaution([version]), READ_ONLY_CAUTION].join(" "),
        },
      ],
    };
    return toFormWorkbook({
      guide,
      tables: [{ sheetName: SHEET_NAMES.adjustment, model }],
      fileName: agreementWorkbookFileName(
        project.name,
        `${version.name} ${VIEW_FILE_LABELS.adjustment}`,
        today,
      ),
    });
  });
}

/** 참여인원: 작성안내 + 한 시트(AG-5). 금액 줄과의 대조는 표에 넣지 않으므로(열 합계가 의미를 잃는다) 작성안내에 적는다 */
async function participantsWorkbook(
  ctx: ViewContext,
): Promise<InputFormWorkbook> {
  const { client, project, years, version, today } = ctx;
  const [participants, lines, members] = await Promise.all([
    agreementsRepo.listParticipantsByVersionIds(client, [version.id]),
    agreementsRepo.listLinesByVersionIds(client, [version.id]),
    membersRepo.listMembers(client, project.id),
  ]);
  return computeOrCorrupt(() => {
    const view = buildParticipantsView({
      participants,
      members,
      years,
      lines,
    });
    const model = participantsTable(view, `참여인원 — ${version.name}`);
    const rec = view.reconciliation;
    const reconcileBody = rec.hasDifference
      ? "참여인원 인건비 합과 인건비·학생인건비 금액 줄 합이 다른 연차가 있습니다(표시만 — 저장을 막지 않습니다): " +
        rec.years
          .filter((y) => y.diff.cash !== 0 || y.diff.inKind !== 0)
          .map(
            (y) =>
              `${y.yearName} 현금 ${formatWon(y.diff.cash)} · 현물 ${formatWon(y.diff.inKind)}`,
          )
          .join(", ") +
        " (차이 = 참여인원 − 금액 줄)."
      : "연차·현금/현물마다 참여인원 인건비 합이 인건비·학생인건비 금액 줄 합과 같습니다.";
    const guide: TableGuide = {
      title: `${project.name} — 협약 예산 참여인원`,
      subtitle: `생성 ${today} · ${version.name} · ${MODE_LABEL}`,
      entries: [
        {
          label: "목적",
          body: "협약 예산 버전 하나의 참여인원(인력 × 연차 참여율·개월·인건비 현금/현물·역할) 목록입니다(참여인원 보기와 같은 표). 인력 순서(미지정은 뒤) → 연차 순서이고, 연차 소계와 총계가 이어집니다.",
        },
        { label: "데이터 출처", body: describeVersion(version) },
        {
          label: "계산값",
          body: "연봉 스냅샷 × 참여율/100 × 개월/12이고, 중간 반올림 없이 최종 결과만 원 단위 정수로 맞춥니다. 연봉이 없으면 계산값은 빈 칸입니다(0으로 계산하지 않습니다).",
        },
        {
          label: "구분",
          body: "저장된 값이 아니라 읽을 때 판정합니다: 연봉이 없으면 '연봉 모름', 현금 = 계산값이고 현물 0이거나 현물 = 계산값이고 현금 0이면 '자동', 그 밖은 '수동'.",
        },
        { label: "금액 줄 대조", body: reconcileBody },
        {
          label: "원칙",
          body: `${UNIT_PRINCIPLE} ${FORMULA_PRINCIPLE} 참여율(%)·개월은 글자 칸입니다. ${SOURCE_PRINCIPLE}`,
        },
        {
          label: "주의",
          body: [...draftCaution([version]), READ_ONLY_CAUTION].join(" "),
        },
      ],
    };
    return toFormWorkbook({
      guide,
      tables: [{ sheetName: SHEET_NAMES.participants, model }],
      fileName: agreementWorkbookFileName(
        project.name,
        `${version.name} ${VIEW_FILE_LABELS.participants}`,
        today,
      ),
    });
  });
}

// ─── §9 buildAgreementWorkbook ────────────────────────────────────────────────

/**
 * 협약 예산 보기 하나의 xlsx(AG-8). 첫 시트 `작성안내`, 이어서
 * - 비목별: `비목별` 시트(AG-2 매트릭스)
 * - 붙임4형: `8-1 지원·부담계획`·`8-2 사용계획` 시트(AG-3) · 조정회의형: `조정회의형` 시트(AG-4 — 변경전 = 제안)
 *   · 참여인원: `참여인원` 시트(AG-5). 파일명 라벨 `{버전 이름} 붙임4형` 등(S-19)
 * - 변경 이력: `금액 증감`·`참여인원 증감`·`세목 총액 보존` 시트(AG-7). 세목 총액 보존은 이후 버전 B와
 *   base(B)의 비교다 — 비교 기준 A와 별개(S-12)
 * 파일 저장은 호출자(셸)의 몫이라 base64로 돌려준다.
 */
export async function buildAgreementWorkbook(
  projectId: string,
  request: AgreementWorkbookRequest,
): Promise<ActionResult<{ fileName: string; contentBase64: string }>> {
  try {
    const pid = parseOrThrow(
      uuidSchema,
      projectId,
      "과제 ID 형식이 올바르지 않습니다.",
    );
    const req = parseOrThrow(
      workbookRequestSchema,
      request,
      "내려받을 보기 지정이 올바르지 않습니다.",
    );
    const { client } = await requireApprovedUser();

    const [project, years, versions] = await Promise.all([
      projectsRepo.getProjectById(client, pid),
      yearsRepo.listYears(client, pid),
      agreementsRepo.listVersionsByProject(client, pid),
    ]);
    const today = todayISO(new Date());

    if (req.view === "category") {
      const version = requireVersionOfProject(versions, req.versionId);
      const lines = await agreementsRepo.listLinesByVersionIds(client, [
        version.id,
      ]);
      const workbook = computeOrCorrupt(() => {
        const model = categoryViewTable(
          buildCategoryView(lines, years),
          `비목별 — ${version.name}`,
        );
        const guide: TableGuide = {
          title: `${project.name} — 협약 예산 비목별`,
          subtitle: `생성 ${today} · ${version.name} · ${MODE_LABEL}`,
          entries: [
            {
              label: "목적",
              body: "협약 예산 버전 하나의 연차 × 비목 × 현금/현물 금액입니다(비목별 보기와 같은 표).",
            },
            { label: "데이터 출처", body: describeVersion(version) },
            { label: "원칙", body: `${UNIT_PRINCIPLE} ${FORMULA_PRINCIPLE}` },
            {
              label: "주의",
              body: [...draftCaution([version]), READ_ONLY_CAUTION].join(" "),
            },
          ],
        };
        return toFormWorkbook({
          guide,
          tables: [{ sheetName: SHEET_NAMES.category, model }],
          fileName: agreementWorkbookFileName(
            project.name,
            version.name,
            today,
          ),
        });
      });
      return { ok: true, data: await encode(workbook) };
    }

    if (
      req.view === "attachment4" ||
      req.view === "adjustment" ||
      req.view === "participants"
    ) {
      const version = requireVersionOfProject(versions, req.versionId);
      const ctx: ViewContext = { client, project, years, versions, version, today };
      const workbook =
        req.view === "attachment4"
          ? await attachment4Workbook(ctx)
          : req.view === "adjustment"
            ? await adjustmentWorkbook(ctx)
            : await participantsWorkbook(ctx);
      return { ok: true, data: await encode(workbook) };
    }

    const from = requireVersionOfProject(versions, req.fromVersionId);
    const to = requireVersionOfProject(versions, req.toVersionId);
    const baseId = computeOrCorrupt(() => baseVersionId(versions, to.id));
    const base =
      baseId === null ? null : requireVersionOfProject(versions, baseId);
    const versionIds = [
      ...new Set([from.id, to.id, ...(base === null ? [] : [base.id])]),
    ];

    const [lines, participants, members] = await Promise.all([
      agreementsRepo.listLinesByVersionIds(client, versionIds),
      agreementsRepo.listParticipantsByVersionIds(client, [
        ...new Set([from.id, to.id]),
      ]),
      membersRepo.listMembers(client, pid),
    ]);
    const workbook = computeOrCorrupt(() => {
      const linesOf = (versionId: string) =>
        lines.filter((line) => line.versionId === versionId);
      const participantsOf = (versionId: string) =>
        participants.filter((p) => p.versionId === versionId);

      const lineTable = buildLineChangesTable(
        diffAgreementLines(linesOf(from.id), linesOf(to.id), years),
        {
          years,
          from,
          to,
        },
      );
      const participantTable = buildParticipantChangesTable(
        diffAgreementParticipants(
          participantsOf(from.id),
          participantsOf(to.id),
          years,
        ),
        { years, members, from, to },
      );
      const preservation = checkSubcategoryPreservation(
        linesOf(to.id),
        base === null ? null : { versionId: base.id, lines: linesOf(base.id) },
      );
      const preservationTable = buildPreservationTable(preservation, {
        target: to,
        base,
      });

      const preservationBody =
        base === null
          ? `이후 버전 '${to.name}'보다 앞선 확정 버전이 없어 기준 버전이 없습니다 — 세목 총액을 비교하지 않았습니다(경고 0건과 다릅니다).`
          : `이후 버전 '${to.name}'을 기준 버전 '${base.name}'(${describeVersion(base)})과 (비목, 세목, 구분)별 전 연차 합으로 비교했습니다. ` +
            "기준 버전은 앞선 확정 최종협약본 중 가장 최근, 없으면 직전 확정 버전입니다 — 위 비교 기준 버전과 별개입니다. " +
            "차이는 경고일 뿐이고 저장·확정을 막지 않습니다.";
      const guide: TableGuide = {
        title: `${project.name} — 협약 예산 변경 이력`,
        subtitle: `생성 ${today} · ${from.name} → ${to.name} · ${MODE_LABEL}`,
        entries: [
          {
            label: "목적",
            body: "두 협약 예산 버전 사이의 금액 증감(연차·비목·세목·구분)과 참여인원 증감, 세목 총액 보존 검증입니다(변경 이력 보기와 같은 표).",
          },
          {
            label: "비교 버전",
            body: `이전(A): ${describeVersion(from)} / 이후(B): ${describeVersion(to)}. 증감 = B − A.`,
          },
          { label: "세목 총액 보존", body: preservationBody },
          { label: "원칙", body: `${UNIT_PRINCIPLE} ${FORMULA_PRINCIPLE}` },
          {
            label: "주의",
            body: [...draftCaution([from, to]), READ_ONLY_CAUTION].join(" "),
          },
        ],
      };
      return toFormWorkbook({
        guide,
        tables: [
          { sheetName: SHEET_NAMES.lineChanges, model: lineTable },
          {
            sheetName: SHEET_NAMES.participantChanges,
            model: participantTable,
          },
          { sheetName: SHEET_NAMES.preservation, model: preservationTable },
        ],
        fileName: agreementWorkbookFileName(
          project.name,
          `${from.name}→${to.name}`,
          today,
        ),
      });
    });
    return { ok: true, data: await encode(workbook) };
  } catch (e) {
    // 리포지토리의 매핑 안 된 일반 Error(테이블·제약 이름)는 여기서 일반 문구로 감춰진다(SA-4)
    return toActionFailure(e);
  }
}
