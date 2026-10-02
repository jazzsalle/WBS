// 협약 예산 버전 판정 — 현재·작성 중·기준 버전, 확정 취소 가능 여부, 새 버전 종류·이름 제안
// (SOT §5.21 AV-1·AV-3·AV-5·AV-8, §6.19 AG-9, 계획서 S-5·S-22).
//
// 전부 파생 값이다 — 저장하지 않고 버전 목록에서 매번 계산한다. 그래서 버전을 지우거나 종류(메타)를
// 바꾸면 다음 계산에서 바로 반영된다(AV-5). 순서는 `order`(DB sort_order)만 본다 — 지워도 재매김하지
// 않으므로(AV-4) 빈자리가 있을 수 있고, 여기서는 크기 비교만 한다.

import { AGREEMENT_VERSION_KIND_LABELS } from '@/lib/constants';
import type { AgreementVersion, AgreementVersionKind } from '@/types';

/** 판정에 필요한 최소 형태 — AgreementVersion을 그대로 넘길 수 있다 */
export type VersionRef = Pick<AgreementVersion, 'id' | 'kind' | 'status' | 'order'>;

/**
 * 목록이 DB 제약(unique(project_id, sort_order)·작성 중 1개)을 지키는지 본다. 어긋난 목록으로 판정하면
 * "현재 버전"·"기준 버전"이 조용히 엉뚱한 버전을 가리킨다 — 데이터 손상이므로 던진다(절대 규칙 5).
 */
function assertVersionList(versions: readonly VersionRef[]): void {
  const ids = new Set<string>();
  const orders = new Set<number>();
  let drafts = 0;
  for (const v of versions) {
    if (ids.has(v.id)) throw new Error(`협약 예산 버전 목록에 같은 버전이 두 번 있습니다 (${v.id}).`);
    ids.add(v.id);
    if (!Number.isInteger(v.order)) throw new Error(`협약 예산 버전 순번이 정수가 아닙니다 (${v.order}).`);
    if (orders.has(v.order)) throw new Error(`협약 예산 버전 순번 ${v.order}이 두 버전에 겹칩니다.`);
    orders.add(v.order);
    if (v.status === 'draft') drafts += 1;
  }
  if (drafts > 1) throw new Error(`작성 중 협약 예산 버전이 ${drafts}개입니다 — 과제당 하나여야 합니다(AV-2).`);
}

function latest(versions: readonly VersionRef[]): VersionRef | null {
  let best: VersionRef | null = null;
  for (const v of versions) if (best === null || v.order > best.order) best = v;
  return best;
}

function findVersion(versions: readonly VersionRef[], versionId: string): VersionRef {
  const found = versions.find((v) => v.id === versionId);
  if (found === undefined) throw new Error(`협약 예산 버전을 찾을 수 없습니다 (${versionId}).`);
  return found;
}

/** 작성 중 버전 id. 없으면 null (AV-2 — 과제당 하나) */
export function draftVersionId(versions: readonly VersionRef[]): string | null {
  assertVersionList(versions);
  return versions.find((v) => v.status === 'draft')?.id ?? null;
}

/**
 * 현재 버전(AV-3): 확정 버전 중 `order` 최대. 확정 버전이 없으면 작성 중 버전(화면은 "작성 중"으로 표시 — U-3).
 * 버전이 없으면 null.
 */
export function currentVersionId(versions: readonly VersionRef[]): string | null {
  assertVersionList(versions);
  const confirmed = latest(versions.filter((v) => v.status === 'confirmed'));
  if (confirmed !== null) return confirmed.id;
  return versions.find((v) => v.status === 'draft')?.id ?? null;
}

/**
 * 기준 버전(AV-5, 계획서 Q1): ① V보다 앞선 확정 최종협약본 중 가장 최근 → ② V보다 앞선 확정 버전 중 가장 최근
 * → ③ 없으면 null("기준 버전 없음"). 기준은 항상 V보다 앞선 버전이다 — 뒤의 버전이 기준이면 RL-23이 미래와 비교한다.
 */
export function baseVersionId(versions: readonly VersionRef[], versionId: string): string | null {
  assertVersionList(versions);
  const target = findVersion(versions, versionId);
  const earlierConfirmed = versions.filter((v) => v.order < target.order && v.status === 'confirmed');
  const final = latest(earlierConfirmed.filter((v) => v.kind === 'final'));
  if (final !== null) return final.id;
  return latest(earlierConfirmed)?.id ?? null;
}

/** 모든 버전의 기준 버전(`getAgreementData`의 버전별 `baseVersionId`). 값 null = 기준 버전 없음 */
export function baseVersionIds(versions: readonly VersionRef[]): Record<string, string | null> {
  const out: Record<string, string | null> = {};
  for (const v of versions) out[v.id] = baseVersionId(versions, v.id);
  return out;
}

/**
 * [확정 취소] 가능 여부(AV-8, U-4): 확정 버전이고 과제의 마지막 버전(`order` 최대)일 때만.
 * 뒤에 버전이 있으면 그 버전의 복제 원본·기준 버전이 바뀐 셈이 되어 이력이 어긋난다.
 */
export function canUnconfirm(versions: readonly VersionRef[], versionId: string): boolean {
  assertVersionList(versions);
  const target = findVersion(versions, versionId);
  return target.status === 'confirmed' && latest(versions)?.id === target.id;
}

export interface NextVersionMeta {
  kind: AgreementVersionKind;
  name: string;
}

/**
 * 새 버전·빈 버전·보내기 대화의 종류·이름 초깃값(AV-1, S-22). 사용자가 고칠 수 있는 제안일 뿐이다.
 * 없음 → 선정평가본, 마지막이 선정평가본 → 조정회의본, 조정회의본 → 최종협약본,
 * 최종협약본·협약변경 → `협약변경 {협약변경 수 + 1}차`. "마지막" = `order` 최대(AV-1의 "직전 버전"과 같다).
 */
export function suggestNextVersionMeta(versions: readonly VersionRef[]): NextVersionMeta {
  assertVersionList(versions);
  const last = latest(versions);
  if (last === null) return { kind: 'selection', name: AGREEMENT_VERSION_KIND_LABELS.selection };
  switch (last.kind) {
    case 'selection':
      return { kind: 'adjustment', name: AGREEMENT_VERSION_KIND_LABELS.adjustment };
    case 'adjustment':
      return { kind: 'final', name: AGREEMENT_VERSION_KIND_LABELS.final };
    case 'final':
    case 'amendment': {
      const amendments = versions.filter((v) => v.kind === 'amendment').length;
      return { kind: 'amendment', name: `${AGREEMENT_VERSION_KIND_LABELS.amendment} ${amendments + 1}차` };
    }
  }
}
