// 편성 항목 증빙 체크리스트 — 기본 목록 복사·검증·확정 잠금 해석·진행 표시 (SOT §5.24, §6.19 AG-6, 계획서 S-1·S-2·S-12·U-3).
//
// 기본 목록은 상수에서 **복사**한다 — 상수 배열을 그대로 넘기면 나중에 상수가 바뀔 때 저장 전 값이 따라 바뀌고,
// 저장값이 상수와 같은 참조를 공유하면 한쪽 변경이 다른 쪽을 오염시킨다(§5.24 "저장된 것이 진실").
// 검증은 액션 Zod(`agreementEvidenceInputSchema`)·DB check(`agreement_evidence_is_valid`)와 같은 규칙이다 —
// 순수 함수로도 두는 이유는 화면이 저장 전에 같은 문구를 보여 주고, 확정 잠금 해석이 정규화된 라벨로 비교해야 해서다.
//
// 경계(AG-9): 순수 함수. xlsx·exceljs·supabase·`lib/db`·`actions`를 import하지 않는다.

import { AGREEMENT_EVIDENCE_DEFAULTS, AGREEMENT_ITEM_KIND_LABELS, AGREEMENT_ITEM_MAX_LENGTH } from '@/lib/constants';
import type { AgreementEvidenceCheck, AgreementItemKind } from '@/types';

/** 받음 여부 표시 글자(엑셀·TSV 증빙 내역 칸, 화면 공용) */
export const EVIDENCE_TEXT = {
  obtained: '받음',
  missing: '안 받음',
} as const;

// ─── 기본 목록 (S-2, U-1) ─────────────────────────────────────────────────────

/** 그 종류의 기본 증빙 — 전부 안 받음·메모 없음. 매번 새 배열·새 객체다 */
export function defaultEvidence(kind: AgreementItemKind): AgreementEvidenceCheck[] {
  const labels = AGREEMENT_EVIDENCE_DEFAULTS[kind];
  if (labels === undefined) throw new Error(`편성 항목 종류를 알 수 없습니다 (${String(kind)}).`);
  return labels.map((label) => ({ label, obtained: false, memo: '' }));
}

// ─── 검증 (S-12 — Zod·DB check와 같은 규칙) ───────────────────────────────────

export type EvidenceValidation =
  | { ok: true; evidence: AgreementEvidenceCheck[] }
  | { ok: false; messages: string[] };

/**
 * 사용자가 보낸 증빙 목록을 검사한다. 통과하면 라벨을 trim한 **새 배열**을 돌려준다(메모는 그대로 — Zod와 같다).
 * 런타임 모양(문자열·boolean)도 본다 — 화면 상태나 jsonb에서 온 값은 타입만 믿을 수 없다.
 * 문구는 사용자에게 그대로 보인다. 첫 오류에서 멈추지 않고 전부 모은다(한 번에 다 고치게).
 */
export function validateEvidence(evidence: readonly AgreementEvidenceCheck[]): EvidenceValidation {
  const max = AGREEMENT_ITEM_MAX_LENGTH;
  if (!Array.isArray(evidence)) return { ok: false, messages: ['증빙 목록이 올바르지 않습니다.'] };

  const messages: string[] = [];
  if (evidence.length > max.evidence) messages.push(`증빙은 ${max.evidence}개 이하여야 합니다 (${evidence.length}개).`);

  const seen = new Set<string>();
  const normalized: AgreementEvidenceCheck[] = [];
  evidence.forEach((check: unknown, index) => {
    const where = `증빙 ${index + 1}번째`;
    if (typeof check !== 'object' || check === null) {
      messages.push(`${where}: 증빙 항목이 올바르지 않습니다.`);
      return;
    }
    const { label, obtained, memo } = check as Record<string, unknown>;
    if (typeof label !== 'string') {
      messages.push(`${where}: 증빙 이름이 올바르지 않습니다.`);
      return;
    }
    const trimmed = label.trim();
    if (trimmed.length === 0) messages.push(`${where}: 증빙 이름을 입력하세요.`);
    else if (trimmed.length > max.label) {
      messages.push(`${where}: 증빙 이름은 ${max.label}자 이내여야 합니다 (${trimmed.length}자).`);
    }
    // trim 뒤 비교 — "견적서"와 " 견적서"는 사용자에게 같은 서류다
    if (trimmed.length > 0 && seen.has(trimmed)) messages.push(`${where}: 증빙 이름 "${trimmed}"이(가) 중복됩니다.`);
    seen.add(trimmed);
    if (typeof obtained !== 'boolean') messages.push(`${where}: 받음 여부가 올바르지 않습니다.`);
    if (typeof memo !== 'string') messages.push(`${where}: 증빙 메모가 올바르지 않습니다.`);
    else if (memo.length > max.memo) {
      messages.push(`${where}: 증빙 메모는 ${max.memo}자 이내여야 합니다 (${memo.length}자).`);
    }
    if (typeof obtained === 'boolean' && typeof memo === 'string') normalized.push({ label: trimmed, obtained, memo });
  });

  return messages.length === 0 ? { ok: true, evidence: normalized } : { ok: false, messages };
}

/**
 * 저장된 증빙이 DB check(`agreement_evidence_is_valid`)를 통과했을 모양인지 본다. 아니면 던진다 —
 * check가 막았어야 하는 상태이고, 조용히 넘기면 n/m이 틀린 채 보인다(절대 규칙 5).
 * 저장값은 정규화하지 않는다(저장된 것이 진실) — 그래서 `validateEvidence`가 아니라 DB와 같은 원시 비교다.
 */
export function assertStoredEvidence(evidence: unknown, where: string): asserts evidence is AgreementEvidenceCheck[] {
  const max = AGREEMENT_ITEM_MAX_LENGTH;
  if (!Array.isArray(evidence)) throw new Error(`${where}: 증빙 목록이 배열이 아닙니다.`);
  if (evidence.length > max.evidence) throw new Error(`${where}: 증빙이 ${max.evidence}개를 넘습니다 (${evidence.length}개).`);
  const seen = new Set<string>();
  evidence.forEach((check: unknown, index) => {
    const at = `${where} 증빙 ${index + 1}번째`;
    if (typeof check !== 'object' || check === null) throw new Error(`${at}: 증빙 항목이 객체가 아닙니다.`);
    const { label, obtained, memo } = check as Record<string, unknown>;
    if (typeof label !== 'string' || label.trim().length === 0 || label.length > max.label) {
      throw new Error(`${at}: 증빙 이름이 올바르지 않습니다.`);
    }
    if (seen.has(label)) throw new Error(`${at}: 증빙 이름 "${label}"이(가) 중복됩니다.`);
    seen.add(label);
    if (typeof obtained !== 'boolean') throw new Error(`${at}: 받음 여부가 boolean이 아닙니다.`);
    if (typeof memo !== 'string' || memo.length > max.memo) throw new Error(`${at}: 증빙 메모가 올바르지 않습니다.`);
  });
}

// ─── 확정 잠금 해석 (S-1, U-3) ────────────────────────────────────────────────

/** 라벨 배열이 순서까지 같은가 — DB 가드(`agreement_child_guard`)의 확정 예외 조건과 같다 */
export function sameEvidenceLabels(
  a: readonly Pick<AgreementEvidenceCheck, 'label'>[],
  b: readonly Pick<AgreementEvidenceCheck, 'label'>[]
): boolean {
  return a.length === b.length && a.every((check, i) => check.label === b[i]!.label);
}

export const EVIDENCE_LOCKED_MESSAGE =
  '확정 버전에서는 증빙의 받음 체크와 메모만 바꿀 수 있습니다 — 증빙 항목 추가·삭제·이름·순서 변경은 작성 중 버전에서 하세요.';

export type EvidenceUpdateResolution =
  | { kind: 'ok'; evidence: AgreementEvidenceCheck[] }
  /** invalid = 검증 실패(입력 오류) · locked = 확정 버전에서 라벨 배열을 바꾸려 함(액션은 `RULE`) */
  | { kind: 'reject'; reason: 'invalid' | 'locked'; messages: string[] };

/**
 * 증빙 갱신 해석. 작성 중 버전이면 검증만 통과하면 자유롭게 바꾼다. 확정 버전이면 라벨 배열(순서 포함)이
 * 저장값과 같을 때만 — 받음 체크·메모만 바뀐 갱신이다(AV-2 예외). 비교는 정규화(trim)한 새 값으로 한다:
 * DB에 가는 것이 그 값이라 가드와 같은 결론이 나야 한다. `before`가 손상돼 있으면 던진다.
 */
export function resolveEvidenceUpdate(
  before: readonly AgreementEvidenceCheck[],
  after: readonly AgreementEvidenceCheck[],
  confirmed: boolean
): EvidenceUpdateResolution {
  assertStoredEvidence(before, '저장된 증빙');
  const validation = validateEvidence(after);
  if (!validation.ok) return { kind: 'reject', reason: 'invalid', messages: validation.messages };
  if (confirmed && !sameEvidenceLabels(before, validation.evidence)) {
    return { kind: 'reject', reason: 'locked', messages: [EVIDENCE_LOCKED_MESSAGE] };
  }
  return { kind: 'ok', evidence: validation.evidence };
}

// ─── 진행·글자 표시 (AG-6, §7.9.8 내보내기) ───────────────────────────────────

export interface EvidenceProgress {
  obtained: number;
  total: number;
}

export function evidenceProgress(evidence: readonly AgreementEvidenceCheck[]): EvidenceProgress {
  return { obtained: evidence.filter((check) => check.obtained).length, total: evidence.length };
}

/** "받음 n/m" — 화면 배지·인쇄·엑셀 증빙 칸 공용 */
export function evidenceProgressText(progress: EvidenceProgress): string {
  return `${EVIDENCE_TEXT.obtained} ${progress.obtained}/${progress.total}`;
}

/** "라벨: 받음/안 받음 · 메모"를 `; `로 잇는다. 메모가 비면 " · 메모"를 붙이지 않는다. 증빙이 없으면 '' */
export function evidenceDetailText(evidence: readonly AgreementEvidenceCheck[]): string {
  return evidence
    .map((check) => {
      const status = check.obtained ? EVIDENCE_TEXT.obtained : EVIDENCE_TEXT.missing;
      const memo = check.memo.trim();
      return memo === '' ? `${check.label}: ${status}` : `${check.label}: ${status} · ${memo}`;
    })
    .join('; ');
}

/** 종류 표시(원시 코드 노출 금지). 모르는 종류는 던진다 — DB check가 막았어야 한다 */
export function itemKindLabel(kind: AgreementItemKind): string {
  const label = AGREEMENT_ITEM_KIND_LABELS[kind];
  if (label === undefined) throw new Error(`편성 항목 종류를 알 수 없습니다 (${String(kind)}).`);
  return label;
}
