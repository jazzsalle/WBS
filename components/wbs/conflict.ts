// 작업 상세 편집의 낙관적 잠금 비교 로직 + 저장 payload 생성 (SOT §8.4 O-1·O-3)
// O-3: 충돌이 나도 입력값을 날리지 않는다. 최신 서버 값(baseline)과 내 입력(form)의
// 상이 필드만 뽑아 사용자가 항목별로 판단하게 한다.
// 저장 payload를 여기서 만드는 이유: 비교 대상(DetailFormValues)과 저장 대상이 어긋나면
// "비교되지 않는 필드가 조용히 덮어써진다". 타입(TaskUpdatePatch)과 테스트로 둘을 묶는다.
// 순수 함수만 둔다 — UI 없이 단위 테스트로 고정한다 (tests/unit/wbs-conflict.test.ts).

import type { Task, TaskStatus } from '@/types';
import { TASK_STATUS_LABELS } from '@/lib/constants';

export type Level = 1 | 2 | 3 | 4 | 5;

// 상세 패널이 편집하는 필드 전체. 빈 문자열이 곧 "값 없음"이다(날짜·공수).
export interface DetailFormValues {
  title: string;
  description: string;
  startDate: string;
  dueDate: string;
  estimatedHours: string;
  actualHours: string;
  status: TaskStatus;
  importance: Level;
  urgencyMode: 'auto' | 'manual';
  urgencyManual: Level;
  ownerMemberId: string; // '' = 미지정
  memberIds: string; // 쉼표 구분 id 목록
  orgId: string; // '' = 미지정
  deliverableIds: string; // 쉼표 구분 id 목록 (§7.4 연계)
  techTargetIds: string; // 쉼표 구분 id 목록 (§7.4 연계)
  tags: string;
}

export type DetailFieldKey = keyof DetailFormValues;

export const DETAIL_FIELDS: readonly { key: DetailFieldKey; label: string }[] = [
  { key: 'title', label: '작업명' },
  { key: 'description', label: '설명' },
  { key: 'startDate', label: '시작일' },
  { key: 'dueDate', label: '마감일' },
  { key: 'estimatedHours', label: '예상 공수' },
  { key: 'actualHours', label: '실적 공수' },
  { key: 'status', label: '상태' },
  { key: 'importance', label: '중요도' },
  { key: 'urgencyMode', label: '긴급도 모드' },
  { key: 'urgencyManual', label: '고정 긴급도' },
  { key: 'ownerMemberId', label: '담당자' },
  { key: 'memberIds', label: '참여 담당자' },
  { key: 'orgId', label: '수행 기관' },
  { key: 'deliverableIds', label: '연계 성과목표' },
  { key: 'techTargetIds', label: '연계 기술목표' },
  { key: 'tags', label: '태그' },
];

export function toDetailFormValues(task: Task): DetailFormValues {
  return {
    title: task.title,
    description: task.description,
    startDate: task.startDate ?? '',
    dueDate: task.dueDate ?? '',
    estimatedHours: task.estimatedHours === null ? '' : String(task.estimatedHours),
    actualHours: task.actualHours === null ? '' : String(task.actualHours),
    status: task.status,
    importance: task.importance,
    urgencyMode: task.urgencyMode,
    urgencyManual: task.urgencyManual,
    ownerMemberId: task.ownerMemberId ?? '',
    // 정렬 고정: 참여자 순서만 다른 두 값이 "상이"로 잡히면 O-3 비교가 가짜 충돌로 뒤덮인다
    memberIds: [...task.memberIds].sort().join(','),
    orgId: task.orgId ?? '',
    // 연계도 같은 이유로 정렬해 둔다 — 순서만 다른 목록이 O-3 비교에 가짜 충돌로 뜨면 안 된다
    deliverableIds: [...task.deliverableIds].sort().join(','),
    techTargetIds: [...task.techTargetIds].sort().join(','),
    tags: task.tags.join(', '),
  };
}

/** 비교 UI에서 id를 사람 이름·기관명·목표명으로 바꾸는 사전. 없으면 id를 감춘 문구로 대체한다 */
export interface DetailValueLabels {
  members?: Record<string, string>;
  orgs?: Record<string, string>;
  deliverables?: Record<string, string>;
  techTargets?: Record<string, string>;
}

/** 연계는 남았는데 목표가 지워진 경우. 트리 뱃지·상세 패널도 같은 문구를 쓴다 */
export const DELETED_GOAL = '(삭제된 목표)';

// id는 사용자에게 아무 의미도 없다. 사전에 없더라도 값을 숨기지는 않는다 —
// "누군가 배정돼 있는데 그 인력이 지워졌다"는 사실 자체가 사용자가 판단할 정보다.
function labelForId(id: string, dict: Record<string, string> | undefined, missing: string): string {
  return dict?.[id] ?? missing;
}

/** 비교 UI에 보여줄 사람이 읽는 값. 빈 값은 '—'로 구분해 "지웠다"를 드러낸다 */
export function displayDetailValue(
  key: DetailFieldKey,
  values: DetailFormValues,
  labels?: DetailValueLabels
): string {
  switch (key) {
    case 'status':
      return TASK_STATUS_LABELS[values.status];
    case 'urgencyMode':
      return values.urgencyMode === 'manual' ? '고정(수동)' : '자동';
    case 'importance':
      return String(values.importance);
    case 'urgencyManual':
      return String(values.urgencyManual);
    case 'ownerMemberId':
      return values.ownerMemberId === ''
        ? '미지정'
        : labelForId(values.ownerMemberId, labels?.members, '(삭제된 인력)');
    case 'memberIds': {
      const ids = splitIds(values.memberIds);
      if (ids.length === 0) return '미지정';
      return ids.map((id) => labelForId(id, labels?.members, '(삭제된 인력)')).join(', ');
    }
    case 'orgId':
      return values.orgId === '' ? '미지정' : labelForId(values.orgId, labels?.orgs, '(삭제된 기관)');
    case 'deliverableIds': {
      const ids = splitIds(values.deliverableIds);
      if (ids.length === 0) return '연계 없음';
      return ids.map((id) => labelForId(id, labels?.deliverables, DELETED_GOAL)).join(', ');
    }
    case 'techTargetIds': {
      const ids = splitIds(values.techTargetIds);
      if (ids.length === 0) return '연계 없음';
      return ids.map((id) => labelForId(id, labels?.techTargets, DELETED_GOAL)).join(', ');
    }
    default: {
      const raw = values[key];
      return raw === '' ? '—' : String(raw);
    }
  }
}

/** 최신 서버 값과 내 입력이 다른 필드 (O-3 비교 대상) */
export function diffDetailValues(
  latest: DetailFormValues,
  mine: DetailFormValues
): DetailFieldKey[] {
  return DETAIL_FIELDS.filter((field) => latest[field.key] !== mine[field.key]).map((f) => f.key);
}

/**
 * 아직 사용자가 판단하지 않은 충돌 항목.
 * 최신 값을 받아들이면 diff에서 사라지고, 내 입력을 유지하기로 하면 keptKeys에 들어온다.
 * 이 목록이 비어야 저장할 수 있다 — 확인 없이 남의 수정을 덮어쓰지 못하게 하는 잠금이다.
 */
export function unresolvedConflicts(
  diffKeys: readonly DetailFieldKey[],
  keptKeys: ReadonlySet<DetailFieldKey>
): DetailFieldKey[] {
  return diffKeys.filter((key) => !keptKeys.has(key));
}

/** 한 항목만 최신 값으로 교체한다. 나머지 입력은 그대로 둔다 (O-3) */
export function adoptLatestValue<K extends DetailFieldKey>(
  values: DetailFormValues,
  latest: DetailFormValues,
  key: K
): DetailFormValues {
  const next: DetailFormValues = { ...values };
  next[key] = latest[key];
  return next;
}

// ─── 저장 payload (updateTask에 보내는 patch) ────────────────

// 키를 DetailFieldKey에서 파생시켜 "비교하지 않는 필드를 저장한다"가 컴파일되지 않게 한다.
// 폼에 필드를 추가하면 여기도 반드시 따라와야 한다.
export type TaskUpdatePatch = {
  [K in DetailFieldKey]: K extends 'startDate' | 'dueDate' | 'ownerMemberId' | 'orgId'
    ? string | null
    : K extends 'estimatedHours' | 'actualHours'
      ? number | null
      : K extends 'tags' | 'memberIds' | 'deliverableIds' | 'techTargetIds'
        ? string[]
        : DetailFormValues[K];
};

export type BuildPatchResult =
  | { ok: true; patch: TaskUpdatePatch }
  | { ok: false; message: string };

const HOUR_FIELDS: readonly { key: 'estimatedHours' | 'actualHours'; label: string }[] = [
  { key: 'estimatedHours', label: '예상 공수' },
  { key: 'actualHours', label: '실적 공수' },
];

/** 쉼표 문자열 → id 배열. 중복은 접는다 — 조인 테이블에 같은 행을 두 번 넣을 수 없다 */
function splitIds(raw: string): string[] {
  const seen = new Set<string>();
  for (const part of raw.split(',')) {
    const id = part.trim();
    if (id !== '') seen.add(id);
  }
  return [...seen];
}

/**
 * 폼 값을 updateTask patch로 바꾼다. 빈 문자열은 null(값 없음)이다.
 * 잘못된 입력은 조용히 버리지 않고 사용자에게 보여줄 문구와 함께 실패로 돌려준다.
 */
export function buildUpdatePatch(values: DetailFormValues): BuildPatchResult {
  const title = values.title.trim();
  if (title === '') return { ok: false, message: '작업명을 입력하세요.' };

  const hours: Record<'estimatedHours' | 'actualHours', number | null> = {
    estimatedHours: null,
    actualHours: null,
  };
  for (const { key, label } of HOUR_FIELDS) {
    const raw = values[key].trim();
    if (raw === '') continue;
    const parsed = Number(raw);
    if (!Number.isFinite(parsed)) return { ok: false, message: `${label}는 숫자로 입력하세요.` };
    // P-7: 음수 공수는 가중 평균을 뒤집는다
    if (parsed < 0) return { ok: false, message: `${label}는 0 이상이어야 합니다.` };
    hours[key] = parsed;
  }

  return {
    ok: true,
    patch: {
      title,
      description: values.description,
      startDate: values.startDate === '' ? null : values.startDate,
      dueDate: values.dueDate === '' ? null : values.dueDate,
      estimatedHours: hours.estimatedHours,
      actualHours: hours.actualHours,
      status: values.status,
      importance: values.importance,
      urgencyMode: values.urgencyMode,
      urgencyManual: values.urgencyManual,
      ownerMemberId: values.ownerMemberId === '' ? null : values.ownerMemberId,
      // 책임자를 memberIds에 자동으로 끼워 넣지 않는다. SOT §5.6은 두 필드의 포함 관계를
      // 규정하지 않았다 — 규칙이 없는 곳에서 사용자 입력을 바꾸면 그 변형이 곧 사실이 된다.
      memberIds: splitIds(values.memberIds),
      orgId: values.orgId === '' ? null : values.orgId,
      // 연계도 전체 치환이다 — 체크를 푼 목표는 이 목록에서 빠져 조인 행이 사라진다
      deliverableIds: splitIds(values.deliverableIds),
      techTargetIds: splitIds(values.techTargetIds),
      tags: values.tags
        .split(',')
        .map((t) => t.trim())
        .filter((t) => t !== ''),
    },
  };
}
