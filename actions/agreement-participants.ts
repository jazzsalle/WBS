'use server';

// 협약 예산 참여인원 편집 서버 액션 (SOT §5.23, §6.19 AG-5, §9 Agreement Budget SA-1~SA-4, §8.4 O-1,
// 계획서 docs/plans/phase-25-plan.md S-11, 확정 결정 G-3/Q4b).
// 반환은 ActionResult<T> — 예외를 그대로 던지지 않는다. supabase 직접 호출 금지, lib/db/ 리포지토리만 쓴다 (§8.6).
//
// 확정 잠금·과제 경계는 여기서 먼저 사람이 읽을 문장으로 거부한다. 가드 트리거는 INSERT/UPDATE의 경합을 막는
// 최후 방어선이고, DELETE는 트리거가 막지 않으므로 삭제의 확정 잠금은 이 파일의 선검사가 유일한 방어다.
//
// 연봉 스냅샷·금액 자동 계산·G-3 재계산/유지 판정은 lib/agreement/participants.ts가 한다 — 여기는 읽어서 넘기고
// 그 결과를 그대로 저장한다. 구분(자동·수동·연봉 모름)은 저장하지 않는다(§5.23 파생 값).

import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { ActionResult, AgreementParticipant, AgreementVersion, ParticipantAmountKind } from '@/types';
import { requireApprovedUser } from '@/lib/auth/guard';
import * as agreementsRepo from '@/lib/db/agreements';
import * as appUsers from '@/lib/db/app-users';
import * as membersRepo from '@/lib/db/members';
import * as yearsRepo from '@/lib/db/years';
import {
  RepositoryError,
  RuleViolationError,
  StaleDataError,
  ValidationError,
  toActionFailure,
} from '@/lib/db/errors';
import {
  PARTICIPANT_ROLE_MAX_LENGTH,
  resolveNewParticipant,
  resolveParticipantEdit,
  type ParticipantAmountRule,
  type ParticipantFields,
  type ResolvedParticipant,
} from '@/lib/agreement/participants';

// ─── 반환 모델 ─────────────────────────────────────────────────────────────────

/** 저장된 행과 금액이 어떻게 정해졌는지 — 화면이 "재계산했습니다/금액을 유지했습니다"를 알리는 데 쓴다 */
export interface AgreementParticipantSaved {
  participant: AgreementParticipant;
  /** explicit = 적은 금액(수동) · recalculated = 계산값으로 채움 · kept = 직전 금액 유지 */
  amountRule: ParticipantAmountRule;
  /** 저장 뒤 읽을 때의 구분(S-9) */
  kind: ParticipantAmountKind;
}

// ─── 입력 검증 ─────────────────────────────────────────────────────────────────

const uuidSchema = z.uuid();

const expectedVersionSchema = z.int('버전 번호가 올바르지 않습니다.').min(0, '버전 번호가 올바르지 않습니다.');

// 절대 규칙 4 — 원 단위 정수, 0 이상. 안전 정수 범위 밖은 bigint 왕복에서 값이 바뀐다
const wonAmountSchema = z
  .int('금액은 원 단위 정수로 입력하세요.')
  .min(0, '금액은 0 이상이어야 합니다.')
  .max(Number.MAX_SAFE_INTEGER, '금액이 너무 큽니다.');

const salarySchema = z
  .int('연봉은 원 단위 정수로 입력하세요.')
  .min(0, '연봉은 0 이상이어야 합니다.')
  .max(Number.MAX_SAFE_INTEGER, '연봉이 너무 큽니다.')
  .nullable();

// 참여율·개월은 DB가 numeric이라 소수를 허용한다(부록 B.7 9개월·28% 같은 값 외에 0.5개월도 있다)
const rateSchema = z
  .number('참여율을 숫자로 입력하세요.')
  .min(0, '참여율은 0~100% 사이여야 합니다.')
  .max(100, '참여율은 0~100% 사이여야 합니다.');

const monthsSchema = z
  .number('참여 개월을 숫자로 입력하세요.')
  .min(0, '참여 개월은 0~12 사이여야 합니다.')
  .max(12, '참여 개월은 0~12 사이여야 합니다.');

const roleSchema = z
  .string('역할이 올바르지 않습니다.')
  .trim()
  .max(PARTICIPANT_ROLE_MAX_LENGTH, `역할은 ${PARTICIPANT_ROLE_MAX_LENGTH}자 이내여야 합니다.`);

// null = 인력 미지정(§5.23). 빈 문자열은 미지정이 아니라 잘못된 id다
const memberIdSchema = z.uuid('인력 ID 형식이 올바르지 않습니다.').nullable();

// annualSalary: 생략 = 그 시점 Member 연봉 스냅샷, null = "연봉 모름"으로 명시.
// 금액: 둘 다 생략 = 자동 계산(현금), 하나라도 적으면 수동(안 적은 쪽 0)
const newParticipantSchema = z.object({
  memberId: memberIdSchema,
  yearId: z.uuid('연차 ID 형식이 올바르지 않습니다.'),
  participationRate: rateSchema,
  months: monthsSchema,
  role: roleSchema,
  annualSalary: salarySchema.optional(),
  personnelCash: wonAmountSchema.optional(),
  personnelInKind: wonAmountSchema.optional(),
});

// 생략 = 바꾸지 않음. z.object가 모르는 키(versionId 등)를 잘라낸다
const participantPatchSchema = newParticipantSchema.partial();

function parseOrThrow<T>(schema: z.ZodType<T>, value: unknown, fallback: string): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    throw new ValidationError(parsed.error.issues[0]?.message ?? fallback);
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
      console.error('[actions/agreement-participants] 수정자 이름 조회 실패:', lookupError);
    }
  }
  // 리포지토리의 plain Error(매핑하지 않은 DB 에러)는 테이블·제약 이름을 담을 수 있다 — 로그에만 남기고
  // toActionFailure가 일반 문구로 감춘다(SA-4)
  if (!(e instanceof RepositoryError)) console.error('[actions/agreement-participants] 처리 실패:', e);
  return toActionFailure(e);
}

function revalidateAgreement(projectId: string): void {
  revalidatePath(`/projects/${projectId}/budget`);
}

/**
 * participants.ts는 손상된 저장값(범위 밖 참여율, 정수가 아닌 금액)에 던진다. SA-4 일반 메시지로 감추면 사용자는
 * "무언가 실패했다"만 본다 — 데이터 손상은 손상이라고 알린다(절대 규칙 5). 순수 함수 메시지에는 테이블·제약 이름이 없다.
 */
function computeOrCorrupt<T>(compute: () => T): T {
  try {
    return compute();
  } catch (e) {
    if (e instanceof RepositoryError) throw e;
    console.error('[actions/agreement-participants] 참여인원 계산 실패:', e);
    const detail = e instanceof Error ? e.message : String(e);
    throw new ValidationError(`협약 예산 데이터가 손상되었습니다 — ${detail}`);
  }
}

const CONFIRMED_LOCK_MESSAGE =
  '확정된 협약 예산 버전의 내용은 고칠 수 없습니다 — 확정을 취소하거나 새 버전을 만드세요';
const FOREIGN_YEAR_MESSAGE = '이 과제에 속하지 않은 연차입니다.';
const FOREIGN_MEMBER_MESSAGE = '이 과제에 속하지 않은 참여인력입니다.';

function assertDraft(version: AgreementVersion): void {
  if (version.status === 'confirmed') throw new RuleViolationError(CONFIRMED_LOCK_MESSAGE);
}

async function assertYearInProject(client: SupabaseClient, yearId: string, projectId: string): Promise<void> {
  const year = await yearsRepo.getYearById(client, yearId);
  if (year.projectId !== projectId) throw new RuleViolationError(FOREIGN_YEAR_MESSAGE);
}

/** 그 과제의 인력이면 연봉(스냅샷 출처)을 돌려준다 */
async function memberSalaryInProject(
  client: SupabaseClient,
  memberId: string,
  projectId: string
): Promise<number | null> {
  const member = await membersRepo.getMemberById(client, memberId);
  if (member.projectId !== projectId) throw new RuleViolationError(FOREIGN_MEMBER_MESSAGE);
  return member.annualSalary;
}

function fieldsOf(p: AgreementParticipant): ParticipantFields {
  return {
    memberId: p.memberId,
    yearId: p.yearId,
    participationRate: p.participationRate,
    months: p.months,
    annualSalary: p.annualSalary,
    personnelCash: p.personnelCash,
    personnelInKind: p.personnelInKind,
    role: p.role,
  };
}

function saved(participant: AgreementParticipant, resolved: ResolvedParticipant): AgreementParticipantSaved {
  return { participant, amountRule: resolved.amountRule, kind: resolved.kind };
}

// ─── 액션 ─────────────────────────────────────────────────────────────────────

/**
 * AG-5 참여인원 추가 — 작성 중 버전만. 인력·연차는 그 버전의 과제 것. 연봉을 생략하면 그 시점 Member 연봉 스냅샷
 * (인력 미지정이면 null = 연봉 모름), 금액을 둘 다 생략하면 계산값을 현금으로.
 */
export async function addAgreementParticipant(
  versionId: string,
  input: unknown
): Promise<ActionResult<AgreementParticipantSaved>> {
  try {
    const vid = parseOrThrow(uuidSchema, versionId, '버전 ID 형식이 올바르지 않습니다.');
    const fields = parseOrThrow(newParticipantSchema, input, '참여인원 입력이 올바르지 않습니다.');
    const ctx = await requireApprovedUser();
    const client = ctx.client;

    const version = await agreementsRepo.getVersionById(client, vid);
    assertDraft(version);
    await assertYearInProject(client, fields.yearId, version.projectId);
    const memberSalary =
      fields.memberId === null ? null : await memberSalaryInProject(client, fields.memberId, version.projectId);

    const resolved = computeOrCorrupt(() => resolveNewParticipant(fields, memberSalary));
    const participant = await agreementsRepo.insertParticipant(client, {
      versionId: vid,
      ...resolved.values,
      createdBy: ctx.user.id,
      updatedBy: ctx.user.id,
    });
    revalidateAgreement(version.projectId);
    return { ok: true, data: saved(participant, resolved) };
  } catch (e) {
    return toFailure(e);
  }
}

/**
 * AG-5 참여인원 수정(O-1). 금액을 적으면 수동, 참여율·개월·연봉·인력만 바꾸면 직전 구분대로 재계산/유지(G-3/Q4b).
 * 인력을 바꿔도 연봉 스냅샷은 바꾸지 않는다 — 연봉은 patch로 명시해야 바뀐다(스냅샷은 추가 시점에만 뜬다, S-11).
 */
export async function updateAgreementParticipant(
  id: string,
  patch: unknown,
  expectedVersion: number
): Promise<ActionResult<AgreementParticipantSaved>> {
  let client: SupabaseClient | undefined;
  try {
    const pid = parseOrThrow(uuidSchema, id, '참여인원 ID 형식이 올바르지 않습니다.');
    const changes = parseOrThrow(participantPatchSchema, patch, '참여인원 수정 내용이 올바르지 않습니다.');
    const expected = parseOrThrow(expectedVersionSchema, expectedVersion, '버전 번호가 올바르지 않습니다.');
    const definedKeys = Object.entries(changes).filter(([, v]) => v !== undefined);
    if (definedKeys.length === 0) throw new ValidationError('갱신할 내용이 없습니다.');
    const ctx = await requireApprovedUser();
    client = ctx.client;

    const before = await agreementsRepo.getParticipantById(client, pid);
    // O-1: 화면이 본 행이 낡았으면 규칙 판정보다 먼저 STALE — 판정 근거(직전 구분)가 낡았다
    if (before.version !== expected) throw new StaleDataError(before.updatedBy);
    const version = await agreementsRepo.getVersionById(client, before.versionId);
    assertDraft(version);
    if (changes.yearId !== undefined) await assertYearInProject(client, changes.yearId, version.projectId);
    if (changes.memberId !== undefined && changes.memberId !== null) {
      await memberSalaryInProject(client, changes.memberId, version.projectId);
    }

    const resolved = computeOrCorrupt(() => resolveParticipantEdit(fieldsOf(before), changes));
    const participant = await agreementsRepo.updateParticipant(
      client,
      pid,
      { ...resolved.values, updatedBy: ctx.user.id },
      expected
    );
    revalidateAgreement(version.projectId);
    return { ok: true, data: saved(participant, resolved) };
  } catch (e) {
    return toFailure(e, client);
  }
}

/** AG-5 참여인원 삭제 — 확인 대화는 화면 몫. 확정 버전은 RULE(트리거가 DELETE를 막지 않아 여기가 유일한 검사다) */
export async function deleteAgreementParticipant(id: string): Promise<ActionResult<null>> {
  try {
    const pid = parseOrThrow(uuidSchema, id, '참여인원 ID 형식이 올바르지 않습니다.');
    const { client } = await requireApprovedUser();

    const current = await agreementsRepo.getParticipantById(client, pid);
    const version = await agreementsRepo.getVersionById(client, current.versionId);
    assertDraft(version);
    await agreementsRepo.removeParticipant(client, pid);
    revalidateAgreement(version.projectId);
    return { ok: true, data: null };
  } catch (e) {
    return toFailure(e);
  }
}
