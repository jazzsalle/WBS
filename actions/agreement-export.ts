"use server";

// 협약 예산 보기 엑셀 내려받기 (SOT §9 Agreement Budget, §6.19 AG-8, 부록 F, 계획서 S-11·S-15)
//
// 화면의 보기(비목별·변경 이력)가 쓰는 것과 **같은 순수 함수**로 표 모델을 만들고, 그 모델을 그대로 시트로 옮긴다
// — [복사](TSV)와 엑셀이 같은 모델에서 나와야 "받은 표"와 "붙여 넣은 표"가 칸마다 같다(AG-8).
//   · 표 계산은 lib/agreement/ (category-view·diff·preservation·changes-table·table)
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
import * as membersRepo from "@/lib/db/members";
import * as projectsRepo from "@/lib/db/projects";
import * as yearsRepo from "@/lib/db/years";
import {
  AGREEMENT_VERSION_KIND_LABELS,
  AGREEMENT_VERSION_STATUS_LABELS,
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
import { baseVersionId } from "@/lib/agreement/versions";
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

// ─── §9 buildAgreementWorkbook ────────────────────────────────────────────────

/**
 * 협약 예산 보기 하나의 xlsx(AG-8). 첫 시트 `작성안내`, 이어서
 * - 비목별: `비목별` 시트(AG-2 매트릭스)
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
