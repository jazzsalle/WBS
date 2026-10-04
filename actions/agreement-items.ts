'use server';

// 협약 예산 편성 항목·증빙 서버 액션 (SOT §5.24, §6.19 AG-6, §9 Agreement Budget SA-1~SA-4, §8.4 O-1,
// 계획서 docs/plans/phase-26-plan.md S-1·S-12·U-3).
// 반환은 ActionResult<T> — 예외를 그대로 던지지 않는다. supabase 직접 호출 금지, lib/db/ 리포지토리만 쓴다 (§8.6).
//
// 확정 잠금·과제 경계는 여기서 먼저 사람이 읽을 문장으로 거부한다. 가드 트리거(agreement_child_guard)는 경합을 막는
// 최후 방어선이고, DELETE는 트리거가 막지 않으므로 삭제의 확정 잠금은 이 파일의 선검사가 유일한 방어다.
// 확정 버전에서 증빙의 받음 체크·메모만 바꾸는 예외(S-1)의 해석은 lib/agreement/evidence.ts가 한다.

import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { ActionResult, AgreementItem, AgreementVersion } from '@/types';
import { requireApprovedUser } from '@/lib/auth/guard';
import * as agreementsRepo from '@/lib/db/agreements';
import * as appUsers from '@/lib/db/app-users';
import * as yearsRepo from '@/lib/db/years';
import {
  RepositoryError,
  RuleViolationError,
  StaleDataError,
  ValidationError,
  toActionFailure,
} from '@/lib/db/errors';
import {
  agreementEvidenceInputSchema,
  agreementItemAddInputSchema,
  agreementItemPatchInputSchema,
} from '@/lib/db/schema';
import { defaultEvidence, resolveEvidenceUpdate } from '@/lib/agreement/evidence';

// ─── 입력 검증 ─────────────────────────────────────────────────────────────────

const uuidSchema = z.uuid();

const expectedVersionSchema = z.int('버전 번호가 올바르지 않습니다.').min(0, '버전 번호가 올바르지 않습니다.');

const EVIDENCE_KEY_MESSAGE = '증빙은 이 경로로 바꿀 수 없습니다 — 증빙 갱신을 쓰세요.';
const KIND_MESSAGE = '편성 항목 종류가 올바르지 않습니다.';

// strict 스키마의 모르는 키·enum 오류는 Zod 기본 문구(영문)라 사용자에게 그대로 보이면 안 된다 — 여기서 바꾼다
function issueMessage(issue: z.core.$ZodIssue, fallback: string): string {
  if (issue.code === 'unrecognized_keys') {
    return issue.keys.includes('evidence')
      ? EVIDENCE_KEY_MESSAGE
      : `알 수 없는 입력 항목입니다 (${issue.keys.join(', ')}).`;
  }
  if (issue.path.length === 1 && issue.path[0] === 'kind') return KIND_MESSAGE;
  return issue.message || fallback;
}

function parseOrThrow<T>(schema: z.ZodType<T>, value: unknown, fallback: string): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new ValidationError(issue ? issueMessage(issue, fallback) : fallback);
  }
  return parsed.data;
}

// ─── 공통 (actions/agreement.ts의 사본 — 'use server' 파일은 동기 헬퍼를 내보낼 수 없다) ──────────

// O-3: 낙관적 잠금 실패는 "누가 먼저 고쳤는지"까지 알린다
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
      console.error('[actions/agreement-items] 수정자 이름 조회 실패:', lookupError);
    }
  }
  // 리포지토리의 plain Error(매핑하지 않은 DB 에러)는 테이블·제약 이름을 담을 수 있다 — 로그에만 남기고
  // toActionFailure가 일반 문구로 감춘다(SA-4)
  if (!(e instanceof RepositoryError)) console.error('[actions/agreement-items] 처리 실패:', e);
  return toActionFailure(e);
}

function revalidateAgreement(projectId: string): void {
  revalidatePath(`/projects/${projectId}/budget`);
}

/**
 * evidence.ts는 손상된 저장 증빙(DB check가 막았어야 하는 모양)에 던진다. SA-4 일반 메시지로 감추면 사용자는
 * "무언가 실패했다"만 본다 — 데이터 손상은 손상이라고 알린다(절대 규칙 5). 순수 함수 메시지에는 테이블·제약 이름이 없다.
 */
function computeOrCorrupt<T>(compute: () => T): T {
  try {
    return compute();
  } catch (e) {
    if (e instanceof RepositoryError) throw e;
    console.error('[actions/agreement-items] 증빙 해석 실패:', e);
    const detail = e instanceof Error ? e.message : String(e);
    throw new ValidationError(`협약 예산 데이터가 손상되었습니다 — ${detail}`);
  }
}

const CONFIRMED_LOCK_MESSAGE =
  '확정된 협약 예산 버전의 내용은 고칠 수 없습니다 — 확정을 취소하거나 새 버전을 만드세요';
const FOREIGN_YEAR_MESSAGE = '이 과제에 속하지 않은 연차입니다.';

function assertDraft(version: AgreementVersion): void {
  if (version.status === 'confirmed') throw new RuleViolationError(CONFIRMED_LOCK_MESSAGE);
}

async function assertYearInProject(client: SupabaseClient, yearId: string, projectId: string): Promise<void> {
  const year = await yearsRepo.getYearById(client, yearId);
  if (year.projectId !== projectId) throw new RuleViolationError(FOREIGN_YEAR_MESSAGE);
}

// ─── 액션 ─────────────────────────────────────────────────────────────────────

/**
 * AG-6 편성 항목 추가 — 작성 중 버전만. 연차는 그 버전의 과제 것.
 * evidence를 생략하면 그 종류의 기본 목록을 복사한다(§5.24 — 전부 안 받음·메모 없음).
 */
export async function addAgreementItem(versionId: string, input: unknown): Promise<ActionResult<AgreementItem>> {
  try {
    const vid = parseOrThrow(uuidSchema, versionId, '버전 ID 형식이 올바르지 않습니다.');
    const fields = parseOrThrow(agreementItemAddInputSchema, input, '편성 항목 입력이 올바르지 않습니다.');
    const ctx = await requireApprovedUser();
    const client = ctx.client;

    const version = await agreementsRepo.getVersionById(client, vid);
    assertDraft(version);
    await assertYearInProject(client, fields.yearId, version.projectId);

    const item = await agreementsRepo.insertItem(client, {
      versionId: vid,
      yearId: fields.yearId,
      kind: fields.kind,
      name: fields.name,
      amount: fields.amount,
      quantity: fields.quantity,
      evidence: fields.evidence ?? defaultEvidence(fields.kind),
      createdBy: ctx.user.id,
      updatedBy: ctx.user.id,
    });
    revalidateAgreement(version.projectId);
    return { ok: true, data: item };
  } catch (e) {
    return toFailure(e);
  }
}

/**
 * AG-6 편성 항목 수정(O-1) — 연차·종류·품명·금액·수량. 작성 중 버전만. evidence 키는 Zod가 거부한다(증빙은
 * 확정 예외가 있어 updateAgreementItemEvidence로만). 종류를 바꿔도 증빙 목록은 그대로다 — 저장된 것이 진실(§5.24).
 */
export async function updateAgreementItem(
  id: string,
  patch: unknown,
  expectedVersion: number
): Promise<ActionResult<AgreementItem>> {
  let client: SupabaseClient | undefined;
  try {
    const iid = parseOrThrow(uuidSchema, id, '편성 항목 ID 형식이 올바르지 않습니다.');
    const changes = parseOrThrow(agreementItemPatchInputSchema, patch, '편성 항목 수정 내용이 올바르지 않습니다.');
    const expected = parseOrThrow(expectedVersionSchema, expectedVersion, '버전 번호가 올바르지 않습니다.');
    if (Object.values(changes).every((v) => v === undefined)) throw new ValidationError('갱신할 내용이 없습니다.');
    const ctx = await requireApprovedUser();
    client = ctx.client;

    const before = await agreementsRepo.getItemById(client, iid);
    // O-1: 화면이 본 행이 낡았으면 규칙 판정보다 먼저 STALE
    if (before.version !== expected) throw new StaleDataError(before.updatedBy);
    const version = await agreementsRepo.getVersionById(client, before.versionId);
    assertDraft(version);
    if (changes.yearId !== undefined) await assertYearInProject(client, changes.yearId, version.projectId);

    const item = await agreementsRepo.updateItem(client, iid, { ...changes, updatedBy: ctx.user.id }, expected);
    revalidateAgreement(version.projectId);
    return { ok: true, data: item };
  } catch (e) {
    return toFailure(e, client);
  }
}

/**
 * AG-6 증빙 목록 통째 교체(O-1). 작성 중 버전 = 추가·삭제·이름·체크·메모 자유.
 * 확정 버전 = 라벨 배열(순서 포함)이 저장값과 같을 때만 — 받음 체크·메모만(S-1, AV-2 예외). 다르면 RULE.
 */
export async function updateAgreementItemEvidence(
  id: string,
  evidence: unknown,
  expectedVersion: number
): Promise<ActionResult<AgreementItem>> {
  let client: SupabaseClient | undefined;
  try {
    const iid = parseOrThrow(uuidSchema, id, '편성 항목 ID 형식이 올바르지 않습니다.');
    const checks = parseOrThrow(agreementEvidenceInputSchema, evidence, '증빙 목록이 올바르지 않습니다.');
    const expected = parseOrThrow(expectedVersionSchema, expectedVersion, '버전 번호가 올바르지 않습니다.');
    const ctx = await requireApprovedUser();
    client = ctx.client;

    const before = await agreementsRepo.getItemById(client, iid);
    if (before.version !== expected) throw new StaleDataError(before.updatedBy);
    const version = await agreementsRepo.getVersionById(client, before.versionId);

    const resolution = computeOrCorrupt(() =>
      resolveEvidenceUpdate(before.evidence, checks, version.status === 'confirmed')
    );
    if (resolution.kind === 'reject') {
      const message = resolution.messages.join(' ');
      if (resolution.reason === 'locked') throw new RuleViolationError(message);
      throw new ValidationError(message);
    }

    const item = await agreementsRepo.updateItemEvidence(client, iid, resolution.evidence, expected, ctx.user.id);
    revalidateAgreement(version.projectId);
    return { ok: true, data: item };
  } catch (e) {
    return toFailure(e, client);
  }
}

/** AG-6 편성 항목 삭제 — 확인 대화는 화면 몫. 확정 버전은 RULE(트리거가 DELETE를 막지 않아 여기가 유일한 검사다) */
export async function deleteAgreementItem(id: string): Promise<ActionResult<null>> {
  try {
    const iid = parseOrThrow(uuidSchema, id, '편성 항목 ID 형식이 올바르지 않습니다.');
    const { client } = await requireApprovedUser();

    const current = await agreementsRepo.getItemById(client, iid);
    const version = await agreementsRepo.getVersionById(client, current.versionId);
    assertDraft(version);
    await agreementsRepo.removeItem(client, iid);
    revalidateAgreement(version.projectId);
    return { ok: true, data: null };
  } catch (e) {
    return toFailure(e);
  }
}
