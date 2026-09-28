// 성과·기술목표 양식 — 미리보기·커밋 페이로드 (SOT §6.17 GF-5·GF-7·GF-10·GF-11, §6.2·§6.3, §8.4 O-1).
//
// 행 모델(`GoalFormRows`) + 현재 목표 → 시트별 id 기반 diff, 삭제 후보, 경고, 달성률 전후, `commit_goal_form` 페이로드.
// 부수효과 없는 순수 함수다: DB·네트워크·현재 시각을 쓰지 않는다. 입력이 xlsx가 아니라 행 모델인 이유는
// Phase 22 hwpx(HX-8)도 같은 모양을 넣기 때문이다 — 그래서 투영은 생성기를 돌리지 않고 필드 단위로 한다.
//
// **투영 비교(IN-10 선례)**: 기존 행을 "양식이 표현하는 모습"(파서가 읽었을 값: 앞뒤 공백 없음, 빈 단위는 유형
// 기본 단위, 연차 목표는 `_meta.yearIds` 키만)으로 바꿔 파싱 행과 비교한다. 투영과 같은 필드는 **기존 값**을
// 유지한다 — 내려받은 그대로 올리면 공백 하나 때문에 "변경"이 되지 않는다.
//
// **충돌·삭제 후보는 `_meta`로 정한다(GF-5)**: 기준 version은 내려받은 시점 값, 삭제 후보는 "`_meta` id − 시트 id".
//
// **달성률 식을 다시 쓰지 않는다**: 적용 후 상태를 `Deliverable[]`/`TechTarget[]`로 만들어 lib/goals.ts에 넘긴다.

import { DELIVERABLE_TYPE_DEFAULT_UNITS } from '@/lib/constants';
import type {
  GoalFormAchievementAddRow,
  GoalFormAchievementFields,
  GoalFormAchievementUpdateRow,
  GoalFormCommitPayload,
  GoalFormDeliverableAddRow,
  GoalFormDeliverableFields,
  GoalFormDeliverableUpdateRow,
  GoalFormExpected,
  GoalFormKind,
  GoalFormRecordAddRow,
  GoalFormRecordFields,
  GoalFormRecordUpdateRow,
  GoalFormTechTargetAddRow,
  GoalFormTechTargetFields,
  GoalFormTechTargetUpdateRow,
} from '@/lib/db/import-snapshots';
import { computeDeliverableTotal, computeTechTargetTotal, summarizeWeights } from '@/lib/goals';
import type { DeliverableTotal, TechTargetTotal, WeightSummary } from '@/lib/goals';
import type {
  Deliverable,
  DeliverableAchievement,
  DeliverableType,
  Direction,
  MeasureMethod,
  TechTarget,
  TechTargetRecord,
} from '@/types';
import { goalSheetsFor } from './layout';
import { goalMetaYearIds } from './meta';
import { goalFormIssue } from './parse';
import type {
  GoalFormAchievementRow,
  GoalFormDeliverableRow,
  GoalFormIssue,
  GoalFormRecordRow,
  GoalFormRows,
  GoalFormTechTargetRow,
  GoalParentRef,
  GoalYearTargets,
} from './parse';
import type { GoalFormMeta } from './types';

// ─── 입력 ────────────────────────────────────────────────────

export interface GoalFormPreviewOptions {
  /** `[삭제 포함]`. 기본 false — 삭제 후보는 보이기만 하고 반영하지 않는다 */
  includeDeletes?: boolean;
  /** false면 삭제 후보 자체를 만들지 않는다(Phase 22 HX-8 — 계획서는 일부 표만 담는다). 기본 true */
  allowDeletes?: boolean;
}

export interface GoalFormPreviewInput {
  meta: GoalFormMeta;
  rows: GoalFormRows;
  /** 미리보기 시점 과제의 목표 **전부**(achievements·records 포함). 투영·충돌·달성률 "전"이 여기서 나온다 */
  current: { deliverables: Deliverable[]; techTargets: TechTarget[] };
  /** 삭제 후보에 보일 WBS 연계 작업 수(id → 건수). 없는 id는 0 */
  linkedTaskCounts: {
    deliverable: Readonly<Record<string, number>>;
    techTarget: Readonly<Record<string, number>>;
  };
  options?: GoalFormPreviewOptions;
}

// ─── 출력 ────────────────────────────────────────────────────

/** 반영될 값(앱 표기). `targetByYear`는 `_meta.yearIds` 키 전부이고 null = 그 키 삭제(S-13) */
export interface GoalDeliverableValues {
  type: DeliverableType;
  name: string;
  unit: string;
  weight: number;
  targetTotal: number;
  targetByYear: GoalYearTargets;
  orgId: string | null;
  evidenceMethod: string;
  note: string;
}

export interface GoalAchievementValues {
  parent: GoalParentRef;
  title: string;
  date: string;
  yearId: string | null;
  orgId: string | null;
  memberIds: string[];
  evidenceUrl: string;
  note: string;
}

export interface GoalTechTargetValues {
  group: string;
  name: string;
  unit: string;
  direction: Direction;
  weight: number;
  targetValue: number;
  targetByYear: GoalYearTargets;
  baselineDomestic: number | null;
  worldBest: number | null;
  worldBestHolder: string;
  measureMethod: MeasureMethod;
  measureDescription: string;
  standardBasis: string;
  basisRationale: string;
  evaluationEnvironment: string;
  orgId: string | null;
  note: string;
}

export interface GoalRecordValues {
  parent: GoalParentRef;
  value: number;
  date: string;
  yearId: string | null;
  method: MeasureMethod;
  evaluator: string;
  evidenceUrl: string;
  note: string;
}

export const GOAL_DELIVERABLE_FIELDS = [
  'type',
  'name',
  'unit',
  'weight',
  'targetTotal',
  'targetByYear',
  'orgId',
  'evidenceMethod',
  'note',
] as const satisfies readonly (keyof GoalDeliverableValues)[];

export const GOAL_ACHIEVEMENT_FIELDS = [
  'parent',
  'title',
  'date',
  'yearId',
  'orgId',
  'memberIds',
  'evidenceUrl',
  'note',
] as const satisfies readonly (keyof GoalAchievementValues)[];

export const GOAL_TECH_TARGET_FIELDS = [
  'group',
  'name',
  'unit',
  'direction',
  'weight',
  'targetValue',
  'targetByYear',
  'baselineDomestic',
  'worldBest',
  'worldBestHolder',
  'measureMethod',
  'measureDescription',
  'standardBasis',
  'basisRationale',
  'evaluationEnvironment',
  'orgId',
  'note',
] as const satisfies readonly (keyof GoalTechTargetValues)[];

export const GOAL_RECORD_FIELDS = [
  'parent',
  'value',
  'date',
  'yearId',
  'method',
  'evaluator',
  'evidenceUrl',
  'note',
] as const satisfies readonly (keyof GoalRecordValues)[];

export type GoalDeliverableField = (typeof GOAL_DELIVERABLE_FIELDS)[number];
export type GoalAchievementField = (typeof GOAL_ACHIEVEMENT_FIELDS)[number];
export type GoalTechTargetField = (typeof GOAL_TECH_TARGET_FIELDS)[number];
export type GoalRecordField = (typeof GOAL_RECORD_FIELDS)[number];

export type GoalPreviewRowStatus = 'add' | 'update' | 'unchanged' | 'conflict' | 'error';

/** 'changed' = 내려받은 뒤 version이 바뀜, 'deleted' = 이미 없음 (RPC 결과의 reason과 같은 값) */
export type GoalConflictReason = 'changed' | 'deleted';

export interface GoalPreviewRow<V, F extends string> {
  kind: GoalFormKind;
  /** `성과목표:5`처럼 시트 이름과 1-based 행 번호. 사용자 메시지·React key용 */
  key: string;
  sheetRow: number;
  /** 시트의 숨김 id 그대로 */
  id: string | null;
  status: GoalPreviewRowStatus;
  /** add·update·unchanged에서만 채운다 */
  values: V | null;
  /** update에서만 비어 있지 않다 — 기존 값과 반영될 값이 다른 필드 */
  changedFields: F[];
  /** 같은 숨김 id의 복사 행이라 추가로 본 경우 원본 id(S-18) */
  copiedFrom: string | null;
  conflict: GoalConflictReason | null;
  issues: GoalFormIssue[];
}

export type GoalDeliverablePreviewRow = GoalPreviewRow<GoalDeliverableValues, GoalDeliverableField>;
export type GoalAchievementPreviewRow = GoalPreviewRow<GoalAchievementValues, GoalAchievementField>;
export type GoalTechTargetPreviewRow = GoalPreviewRow<GoalTechTargetValues, GoalTechTargetField>;
export type GoalRecordPreviewRow = GoalPreviewRow<GoalRecordValues, GoalRecordField>;

export interface GoalDeleteCandidate {
  kind: GoalFormKind;
  id: string;
  /** 현재 이름(지표명·평가항목·산출물명, 측정은 `측정일 값`). 이미 지워졌으면 '' */
  label: string;
  /** `_meta`의 내려받을 때 version */
  expectedVersion: number;
  /** null이면 지울 수 있다. 아니면 지우지 않고 충돌로 돌려준다(GF-5, S-6②) */
  conflict: GoalConflictReason | null;
  /** 함께 사라지는 현재 성과실적 수(성과목표 후보만) */
  achievementCount: number;
  /** 함께 사라지는 현재 측정이력 수(기술목표 후보만) */
  recordCount: number;
  /** 끊기는 WBS 연계 작업 수(성과목표·기술목표 후보만) */
  linkedTaskCount: number;
  /** 부모 후보의 현재 자식 id — 페이로드 expected에 싣는다(S-6②) */
  childIds: string[];
}

export interface GoalRates {
  deliverables: DeliverableTotal;
  techTargets: TechTargetTotal;
  deliverableWeights: WeightSummary;
  techTargetWeights: WeightSummary;
}

export interface GoalFormPreviewCounts {
  add: number;
  update: number;
  unchanged: number;
  /** 충돌 행 + 충돌 삭제 후보 */
  conflict: number;
  /** 차단 사유가 있는 행 */
  error: number;
  /** 막지 않는 문제(행·파일) 건수 */
  warning: number;
  /** 지울 수 있는 삭제 후보(충돌 제외) */
  deleteCandidates: number;
}

export interface GoalFormPreview {
  rows: {
    deliverables: GoalDeliverablePreviewRow[];
    achievements: GoalAchievementPreviewRow[];
    techTargets: GoalTechTargetPreviewRow[];
    records: GoalRecordPreviewRow[];
  };
  deleteCandidates: GoalDeleteCandidate[];
  /** 반영에서 건너뛰는 행 — 충돌 행과 충돌 삭제 후보 */
  conflicts: { kind: GoalFormKind; id: string; reason: GoalConflictReason }[];
  /** 파일 단위 경고(가중치·비중 합계) */
  issues: GoalFormIssue[];
  counts: GoalFormPreviewCounts;
  /** blocking 사유가 하나라도 있으면 반영 불가(S-21, 부분 반영 없음) */
  blocked: boolean;
  /** 전 = 현재, 후 = 적용 후 상태(삭제는 includeDeletes일 때만) */
  rates: { before: GoalRates; after: GoalRates };
  /** 적용 후 상태. 새 행의 id는 `new:<종류>:<시트 행>`(저장되지 않은 임시 값) */
  after: { deliverables: Deliverable[]; techTargets: TechTarget[] };
  options: Required<GoalFormPreviewOptions>;
  /** `_meta` 연차 열 순서 — 페이로드 target_by_year 키 */
  yearIds: string[];
  /** 반영에 쓰는 `_meta` version(GF-5). 페이로드의 expected가 여기서 나온다 */
  expectedVersions: Pick<GoalFormMeta, 'deliverables' | 'achievements' | 'techTargets' | 'records'>;
}

// ─── 비교 헬퍼 ───────────────────────────────────────────────

type Loose<F extends string> = Record<F, unknown>;

/**
 * 필드 값 비교. 배열은 관여자뿐이라 집합으로 비교하고(achievement_members는 순서가 없다),
 * 객체(연차 목표·부모 참조)는 키 합집합에서 undefined ≡ null로 본다.
 */
function sameValue(a: unknown, b: unknown): boolean {
  if (a === undefined) a = null;
  if (b === undefined) b = null;
  if (a === null || b === null) return a === b;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    const sa = [...(a as string[])].sort();
    const sb = [...(b as string[])].sort();
    return sa.every((v, i) => v === sb[i]);
  }
  if (typeof a === 'object' && typeof b === 'object') {
    const ra = a as Record<string, unknown>;
    const rb = b as Record<string, unknown>;
    const keys = new Set([...Object.keys(ra), ...Object.keys(rb)]);
    return [...keys].every((k) => sameValue(ra[k], rb[k]));
  }
  return a === b;
}

function hasBlocking(issues: readonly GoalFormIssue[]): boolean {
  return issues.some((issue) => issue.blocking);
}

/** `_meta.yearIds` 키만, 없는 키는 null — 양식의 연차 열이 보이는 모습 */
function yearTargetsOf(targetByYear: Readonly<Record<string, number>>, yearIds: readonly string[]): GoalYearTargets {
  const out: GoalYearTargets = {};
  for (const id of yearIds) out[id] = Object.hasOwn(targetByYear, id) ? (targetByYear[id] as number) : null;
  return out;
}

/** yearIds 키만 교체(null = 삭제), 그 밖 키 보존(S-13) */
function mergeYearTargets(existing: Readonly<Record<string, number>>, incoming: GoalYearTargets): Record<string, number> {
  const out: Record<string, number> = { ...existing };
  for (const [id, value] of Object.entries(incoming)) {
    if (value === null) delete out[id];
    else out[id] = value;
  }
  return out;
}

function uniqueIds(ids: readonly string[]): string[] {
  return [...new Set(ids)];
}

function need<T>(value: T | null, where: string, field: string): T {
  // 오류 없는 행이면 파서가 채웠다 — 아니면 판정 순서가 깨진 것이다
  if (value === null) throw new Error(`${where}: 오류 없는 행에 ${field} 값이 없다`);
  return value;
}

// ─── 종류별 규칙 ─────────────────────────────────────────────

interface ParsedBase {
  sheetRow: number;
  id: string | null;
  issues: GoalFormIssue[];
}

interface KindRule<R extends ParsedBase, E extends { id: string; version: number }, V, F extends string> {
  kind: GoalFormKind;
  sheetName: string;
  fields: readonly F[];
  versions: Readonly<Record<string, number>>;
  current: ReadonlyMap<string, E>;
  /** 파싱 행 → 비교용 값(오류 행이면 null 필드가 있다) */
  comparable(row: R): Loose<F>;
  /** 기존 행이 양식에 보였을 모습 */
  projection(existing: E): Loose<F>;
  /** 기존 행의 실제 값(연차 목표는 yearIds 키만) */
  existingValues(existing: E): V;
  /** 오류 없는 파싱 행 → 반영 값 */
  valuesOf(row: R, where: string): V;
  /** DB 대조로만 알 수 있는 차단 사유(parent-moved) */
  dbIssues?(row: R, existing: E): GoalFormIssue[];
}

interface Work<R> {
  row: R;
  issues: GoalFormIssue[];
  copiedFrom: string | null;
}

function classify<R extends ParsedBase, E extends { id: string; version: number }, V, F extends string>(
  rule: KindRule<R, E, V, F>,
  parsed: readonly R[]
): GoalPreviewRow<V, F>[] {
  const inMeta = (id: string | null): id is string => id !== null && Object.hasOwn(rule.versions, id);
  const work: Work<R>[] = parsed.map((row) => ({ row, issues: [...row.issues], copiedFrom: null }));

  const equalsProjection = (w: Work<R>, existing: E): boolean => {
    const a = rule.comparable(w.row);
    const b = rule.projection(existing);
    return rule.fields.every((f) => sameValue(a[f], b[f]));
  };

  // S-18: 같은 숨김 id가 여러 행 — 투영과 전 필드가 같은 행이 정확히 하나면 원본, 나머지는 추가
  const groups = new Map<string, Work<R>[]>();
  for (const w of work) {
    if (!inMeta(w.row.id)) continue;
    const list = groups.get(w.row.id);
    if (list) list.push(w);
    else groups.set(w.row.id, [w]);
  }
  for (const [id, list] of groups) {
    if (list.length < 2) continue;
    const existing = rule.current.get(id);
    const originals = existing === undefined ? [] : list.filter((w) => equalsProjection(w, existing));
    if (originals.length === 1) {
      for (const w of list) if (w !== originals[0]) w.copiedFrom = id;
    } else {
      for (const w of list) w.issues.push(goalFormIssue('duplicate-row', id));
    }
  }

  return work.map((w) => {
    const { row } = w;
    const isNew = row.id === null || w.copiedFrom !== null;
    const existing = !isNew && inMeta(row.id) ? rule.current.get(row.id) : undefined;
    if (existing !== undefined && rule.dbIssues) w.issues.push(...rule.dbIssues(row, existing));

    const key = `${rule.sheetName}:${row.sheetRow}`;
    const base = { kind: rule.kind, key, sheetRow: row.sheetRow, id: row.id, copiedFrom: w.copiedFrom };
    const empty = { values: null, changedFields: [] as F[], conflict: null, issues: w.issues };

    if (hasBlocking(w.issues)) return { ...base, ...empty, status: 'error' as const };
    if (isNew) return { ...base, ...empty, status: 'add' as const, values: rule.valuesOf(row, key) };

    // 여기 오는 행은 _meta에 있는 id다 — 밖이면 파서가 unknown-id로 막았다
    const id = row.id as string;
    const expectedVersion = rule.versions[id] as number;
    if (existing === undefined || existing.version !== expectedVersion) {
      const reason: GoalConflictReason = existing === undefined ? 'deleted' : 'changed';
      const issues = [...w.issues, goalFormIssue('conflict', reason === 'deleted' ? '이미 삭제됨' : '내용이 바뀜')];
      return { ...base, ...empty, issues, status: 'conflict' as const, conflict: reason };
    }

    // 투영과 같은 필드는 기존 값을 유지한다(IN-10) — 공백·기본 단위 차이로 "변경"이 되지 않게
    const parsedValues = rule.valuesOf(row, key) as Record<F, unknown>;
    const projection = rule.projection(existing);
    const current = rule.existingValues(existing) as Record<F, unknown>;
    const merged = { ...current };
    for (const f of rule.fields) {
      if (!sameValue(parsedValues[f], projection[f])) merged[f] = parsedValues[f];
    }
    const changedFields = rule.fields.filter((f) => !sameValue(merged[f], current[f]));
    const values = merged as unknown as V;
    if (changedFields.length === 0) return { ...base, ...empty, status: 'unchanged' as const, values };
    return { ...base, ...empty, status: 'update' as const, values, changedFields };
  });
}

// ─── 진입점 ──────────────────────────────────────────────────

interface Located<T> {
  item: T;
  parentId: string;
}

/**
 * 목표 양식 미리보기(GF-5). 미리보기와 반영이 같은 행 모델로 이 함수를 부른다 — 반영 페이로드는
 * `buildGoalFormCommit`이 이 결과에서만 만든다.
 */
export function previewGoalForm(input: GoalFormPreviewInput): GoalFormPreview {
  const { meta, rows, current, linkedTaskCounts } = input;
  const options: Required<GoalFormPreviewOptions> = {
    includeDeletes: input.options?.includeDeletes ?? false,
    allowDeletes: input.options?.allowDeletes ?? true,
  };
  // 다른 과제의 현재 데이터가 섞이면 투영·충돌이 전부 엉뚱해진다 — 조용히 진행하지 않는다
  const stray = [...current.deliverables, ...current.techTargets].find((g) => g.projectId !== meta.projectId);
  if (stray) throw new Error(`목표 양식 미리보기: 다른 과제(${stray.projectId})의 목표가 섞였다`);

  const yearIds = goalMetaYearIds(meta);
  const sheets = goalSheetsFor(meta.years.map((y) => y.label));

  const deliverableById = new Map(current.deliverables.map((d) => [d.id, d]));
  const techTargetById = new Map(current.techTargets.map((t) => [t.id, t]));
  const achievementById = new Map<string, Located<DeliverableAchievement>>();
  for (const d of current.deliverables) {
    for (const a of d.achievements) achievementById.set(a.id, { item: a, parentId: d.id });
  }
  const recordById = new Map<string, Located<TechTargetRecord>>();
  for (const t of current.techTargets) {
    for (const r of t.records) recordById.set(r.id, { item: r, parentId: t.id });
  }

  const parentMoved = (row: { parent: GoalParentRef | null }, dbParentId: string): GoalFormIssue[] => {
    // 파서는 파일 안에서만 판정한다 — 숨김 부모 id 자체를 바꾼 행은 DB 현재 부모와 대조해야 드러난다
    if (row.parent === null || (row.parent.kind === 'existing' && row.parent.id === dbParentId)) return [];
    const to = row.parent.kind === 'existing' ? row.parent.id : `${row.parent.row}행`;
    return [goalFormIssue('parent-moved', `${dbParentId} → ${to}`)];
  };

  // ── 성과목표
  const dRows = classify<GoalFormDeliverableRow, Deliverable, GoalDeliverableValues, GoalDeliverableField>(
    {
      kind: 'deliverable',
      sheetName: sheets.deliverables.name,
      fields: GOAL_DELIVERABLE_FIELDS,
      versions: meta.deliverables,
      current: deliverableById,
      comparable: (row) => ({
        type: row.type,
        name: row.name,
        unit: row.unit,
        weight: row.weight,
        targetTotal: row.targetTotal,
        targetByYear: row.targetByYear,
        orgId: row.orgId,
        evidenceMethod: row.evidenceMethod,
        note: row.note,
      }),
      projection: (d) => {
        const unit = d.unit.trim();
        return {
          type: d.type,
          name: d.name.trim(),
          // 파서가 빈 단위를 유형 기본 단위로 채운다(GF-9)
          unit: unit === '' ? DELIVERABLE_TYPE_DEFAULT_UNITS[d.type] : unit,
          weight: d.weight,
          targetTotal: d.targetTotal,
          targetByYear: yearTargetsOf(d.targetByYear, yearIds),
          orgId: d.orgId,
          evidenceMethod: d.evidenceMethod.trim(),
          note: d.note.trim(),
        };
      },
      existingValues: (d) => ({
        type: d.type,
        name: d.name,
        unit: d.unit,
        weight: d.weight,
        targetTotal: d.targetTotal,
        targetByYear: yearTargetsOf(d.targetByYear, yearIds),
        orgId: d.orgId,
        evidenceMethod: d.evidenceMethod,
        note: d.note,
      }),
      valuesOf: (row, where) => ({
        type: need(row.type, where, 'type'),
        name: row.name,
        unit: row.unit,
        weight: need(row.weight, where, 'weight'),
        targetTotal: need(row.targetTotal, where, 'targetTotal'),
        targetByYear: { ...row.targetByYear },
        orgId: row.orgId,
        evidenceMethod: row.evidenceMethod,
        note: row.note,
      }),
    },
    rows.deliverables
  );

  // ── 성과실적
  const aRows = classify<
    GoalFormAchievementRow,
    DeliverableAchievement & { parentId: string },
    GoalAchievementValues,
    GoalAchievementField
  >(
    {
      kind: 'achievement',
      sheetName: sheets.achievements.name,
      fields: GOAL_ACHIEVEMENT_FIELDS,
      versions: meta.achievements,
      current: new Map([...achievementById].map(([id, { item, parentId }]) => [id, { ...item, parentId }])),
      comparable: (row) => ({
        parent: row.parent,
        title: row.title,
        date: row.date,
        yearId: row.yearId,
        orgId: row.orgId,
        memberIds: row.memberIds,
        evidenceUrl: row.evidenceUrl,
        note: row.note,
      }),
      projection: (a) => ({
        parent: { kind: 'existing', id: a.parentId },
        title: a.title.trim(),
        date: a.date,
        yearId: a.yearId,
        orgId: a.orgId,
        memberIds: uniqueIds(a.memberIds),
        evidenceUrl: a.evidenceUrl.trim(),
        note: a.note.trim(),
      }),
      existingValues: (a) => ({
        parent: { kind: 'existing', id: a.parentId },
        title: a.title,
        date: a.date,
        yearId: a.yearId,
        orgId: a.orgId,
        memberIds: [...a.memberIds],
        evidenceUrl: a.evidenceUrl,
        note: a.note,
      }),
      valuesOf: (row, where) => ({
        parent: need(row.parent, where, 'parent'),
        title: row.title,
        date: need(row.date, where, 'date'),
        yearId: row.yearId,
        orgId: row.orgId,
        memberIds: [...row.memberIds],
        evidenceUrl: row.evidenceUrl,
        note: row.note,
      }),
      dbIssues: (row, a) => parentMoved(row, a.parentId),
    },
    rows.achievements
  );

  // ── 기술목표
  const tRows = classify<GoalFormTechTargetRow, TechTarget, GoalTechTargetValues, GoalTechTargetField>(
    {
      kind: 'techTarget',
      sheetName: sheets.techTargets.name,
      fields: GOAL_TECH_TARGET_FIELDS,
      versions: meta.techTargets,
      current: techTargetById,
      comparable: (row) => ({
        group: row.group,
        name: row.name,
        unit: row.unit,
        direction: row.direction,
        weight: row.weight,
        targetValue: row.targetValue,
        targetByYear: row.targetByYear,
        baselineDomestic: row.baselineDomestic,
        worldBest: row.worldBest,
        worldBestHolder: row.worldBestHolder,
        measureMethod: row.measureMethod,
        measureDescription: row.measureDescription,
        standardBasis: row.standardBasis,
        basisRationale: row.basisRationale,
        evaluationEnvironment: row.evaluationEnvironment,
        orgId: row.orgId,
        note: row.note,
      }),
      projection: (t) => ({
        group: t.group.trim(),
        name: t.name.trim(),
        unit: t.unit.trim(),
        direction: t.direction,
        weight: t.weight,
        targetValue: t.targetValue,
        targetByYear: yearTargetsOf(t.targetByYear, yearIds),
        baselineDomestic: t.baselineDomestic,
        worldBest: t.worldBest,
        worldBestHolder: t.worldBestHolder.trim(),
        measureMethod: t.measureMethod,
        measureDescription: t.measureDescription.trim(),
        standardBasis: t.standardBasis.trim(),
        basisRationale: t.basisRationale.trim(),
        evaluationEnvironment: t.evaluationEnvironment.trim(),
        orgId: t.orgId,
        note: t.note.trim(),
      }),
      existingValues: (t) => ({
        group: t.group,
        name: t.name,
        unit: t.unit,
        direction: t.direction,
        weight: t.weight,
        targetValue: t.targetValue,
        targetByYear: yearTargetsOf(t.targetByYear, yearIds),
        baselineDomestic: t.baselineDomestic,
        worldBest: t.worldBest,
        worldBestHolder: t.worldBestHolder,
        measureMethod: t.measureMethod,
        measureDescription: t.measureDescription,
        standardBasis: t.standardBasis,
        basisRationale: t.basisRationale,
        evaluationEnvironment: t.evaluationEnvironment,
        orgId: t.orgId,
        note: t.note,
      }),
      valuesOf: (row, where) => ({
        group: row.group,
        name: row.name,
        unit: row.unit,
        direction: need(row.direction, where, 'direction'),
        weight: need(row.weight, where, 'weight'),
        targetValue: need(row.targetValue, where, 'targetValue'),
        targetByYear: { ...row.targetByYear },
        baselineDomestic: row.baselineDomestic,
        worldBest: row.worldBest,
        worldBestHolder: row.worldBestHolder,
        measureMethod: need(row.measureMethod, where, 'measureMethod'),
        measureDescription: row.measureDescription,
        standardBasis: row.standardBasis,
        basisRationale: row.basisRationale,
        evaluationEnvironment: row.evaluationEnvironment,
        orgId: row.orgId,
        note: row.note,
      }),
    },
    rows.techTargets
  );

  // ── 측정이력
  const rRows = classify<GoalFormRecordRow, TechTargetRecord & { parentId: string }, GoalRecordValues, GoalRecordField>(
    {
      kind: 'record',
      sheetName: sheets.records.name,
      fields: GOAL_RECORD_FIELDS,
      versions: meta.records,
      current: new Map([...recordById].map(([id, { item, parentId }]) => [id, { ...item, parentId }])),
      comparable: (row) => ({
        parent: row.parent,
        value: row.value,
        date: row.date,
        yearId: row.yearId,
        method: row.method,
        evaluator: row.evaluator,
        evidenceUrl: row.evidenceUrl,
        note: row.note,
      }),
      projection: (r) => ({
        parent: { kind: 'existing', id: r.parentId },
        value: r.value,
        date: r.date,
        yearId: r.yearId,
        method: r.method,
        evaluator: r.evaluator.trim(),
        evidenceUrl: r.evidenceUrl.trim(),
        note: r.note.trim(),
      }),
      existingValues: (r) => ({
        parent: { kind: 'existing', id: r.parentId },
        value: r.value,
        date: r.date,
        yearId: r.yearId,
        method: r.method,
        evaluator: r.evaluator,
        evidenceUrl: r.evidenceUrl,
        note: r.note,
      }),
      valuesOf: (row, where) => ({
        parent: need(row.parent, where, 'parent'),
        value: need(row.value, where, 'value'),
        date: need(row.date, where, 'date'),
        yearId: row.yearId,
        method: need(row.method, where, 'method'),
        evaluator: row.evaluator,
        evidenceUrl: row.evidenceUrl,
        note: row.note,
      }),
      dbIssues: (row, r) => parentMoved(row, r.parentId),
    },
    rows.records
  );

  // ── 삭제 후보(GF-5): `_meta` id − 시트 id. 오류 행·복사 행이 가리키는 id도 시트에 있는 것으로 친다
  const deleteCandidates: GoalDeleteCandidate[] = [];
  if (options.allowDeletes) {
    const onSheet = (list: readonly { id: string | null }[]) =>
      new Set(list.map((r) => r.id).filter((id): id is string => id !== null));
    const missing = (versions: Readonly<Record<string, number>>, list: readonly { id: string | null }[]) => {
      const seen = onSheet(list);
      return Object.entries(versions).filter(([id]) => !seen.has(id));
    };
    const base = { achievementCount: 0, recordCount: 0, linkedTaskCount: 0, childIds: [] as string[] };
    // S-6②: 내려받은 뒤 추가·변경된 자식이 cascade로 사라지지 않게 — RPC와 같은 판정을 미리 보인다
    const childrenChanged = (children: readonly { id: string; version: number }[], versions: Readonly<Record<string, number>>) =>
      children.some((c) => !Object.hasOwn(versions, c.id) || versions[c.id] !== c.version);
    const conflictOf = (existing: { version: number } | undefined, expected: number): GoalConflictReason | null =>
      existing === undefined ? 'deleted' : existing.version !== expected ? 'changed' : null;

    for (const [id, expectedVersion] of missing(meta.deliverables, rows.deliverables)) {
      const d = deliverableById.get(id);
      let conflict = conflictOf(d, expectedVersion);
      if (conflict === null && d !== undefined && childrenChanged(d.achievements, meta.achievements)) conflict = 'changed';
      deleteCandidates.push({
        ...base,
        kind: 'deliverable',
        id,
        label: d?.name ?? '',
        expectedVersion,
        conflict,
        achievementCount: d?.achievements.length ?? 0,
        linkedTaskCount: linkedTaskCounts.deliverable[id] ?? 0,
        childIds: d?.achievements.map((a) => a.id) ?? [],
      });
    }
    for (const [id, expectedVersion] of missing(meta.achievements, rows.achievements)) {
      const a = achievementById.get(id)?.item;
      deleteCandidates.push({ ...base, kind: 'achievement', id, label: a?.title ?? '', expectedVersion, conflict: conflictOf(a, expectedVersion) });
    }
    for (const [id, expectedVersion] of missing(meta.techTargets, rows.techTargets)) {
      const t = techTargetById.get(id);
      let conflict = conflictOf(t, expectedVersion);
      if (conflict === null && t !== undefined && childrenChanged(t.records, meta.records)) conflict = 'changed';
      deleteCandidates.push({
        ...base,
        kind: 'techTarget',
        id,
        label: t?.name ?? '',
        expectedVersion,
        conflict,
        recordCount: t?.records.length ?? 0,
        linkedTaskCount: linkedTaskCounts.techTarget[id] ?? 0,
        childIds: t?.records.map((r) => r.id) ?? [],
      });
    }
    for (const [id, expectedVersion] of missing(meta.records, rows.records)) {
      const r = recordById.get(id)?.item;
      deleteCandidates.push({
        ...base,
        kind: 'record',
        id,
        label: r === undefined ? '' : `${r.date} ${r.value}`,
        expectedVersion,
        conflict: conflictOf(r, expectedVersion),
      });
    }
  }

  const allRows = [...dRows, ...aRows, ...tRows, ...rRows];
  const conflicts = [
    ...allRows.filter((r) => r.status === 'conflict').map((r) => ({ kind: r.kind, id: r.id as string, reason: r.conflict as GoalConflictReason })),
    ...deleteCandidates
      .filter((d) => d.conflict !== null)
      .map((d) => ({ kind: d.kind, id: d.id, reason: d.conflict as GoalConflictReason })),
  ];

  // ── 적용 후 상태 → 달성률 전후(§6.2·§6.3)
  const deleting = new Set(
    options.includeDeletes ? deleteCandidates.filter((d) => d.conflict === null).map((d) => d.id) : []
  );
  const after = applyToCurrent(current, { dRows, aRows, tRows, rRows }, deleting, meta.projectId);
  const rates = { before: ratesOf(current), after: ratesOf(after) };

  // ── 파일 단위 경고: 가중치·비중 합계(§7.7 탭 1, T-3) — 적용 후 상태 기준
  const issues: GoalFormIssue[] = [];
  if (rates.after.deliverableWeights.weightMismatch) {
    issues.push(goalFormIssue('weight-sum', `성과목표 가중치 합계 ${rates.after.deliverableWeights.totalWeight}`));
  }
  if (rates.after.techTargetWeights.weightMismatch) {
    issues.push(goalFormIssue('weight-sum', `기술목표 비중 합계 ${rates.after.techTargetWeights.totalWeight}`));
  }

  const errorRows = allRows.filter((r) => r.status === 'error').length;
  const warning =
    allRows.reduce((n, r) => n + r.issues.filter((i) => !i.blocking).length, 0) +
    issues.filter((i) => !i.blocking).length;

  return {
    rows: { deliverables: dRows, achievements: aRows, techTargets: tRows, records: rRows },
    deleteCandidates,
    conflicts,
    issues,
    counts: {
      add: allRows.filter((r) => r.status === 'add').length,
      update: allRows.filter((r) => r.status === 'update').length,
      unchanged: allRows.filter((r) => r.status === 'unchanged').length,
      conflict: conflicts.length,
      error: errorRows,
      warning,
      deleteCandidates: deleteCandidates.filter((d) => d.conflict === null).length,
    },
    blocked: errorRows > 0 || hasBlocking(issues),
    rates,
    after,
    options,
    yearIds,
    expectedVersions: {
      deliverables: meta.deliverables,
      achievements: meta.achievements,
      techTargets: meta.techTargets,
      records: meta.records,
    },
  };
}

// ─── 적용 후 상태 ────────────────────────────────────────────

function ratesOf(state: { deliverables: readonly Deliverable[]; techTargets: readonly TechTarget[] }): GoalRates {
  return {
    deliverables: computeDeliverableTotal(state.deliverables),
    techTargets: computeTechTargetTotal(state.techTargets),
    deliverableWeights: summarizeWeights(state.deliverables),
    techTargetWeights: summarizeWeights(state.techTargets),
  };
}

const NEW_ENTITY = { createdAt: '', updatedAt: '', version: 0, createdBy: null, updatedBy: null } as const;

function nextOrder(items: readonly { order: number }[]): number {
  return items.reduce((max, item) => Math.max(max, item.order), -1) + 1;
}

/**
 * 현재 상태에 add·update(와 includeDeletes면 충돌 없는 삭제)를 적용한 상태. 충돌·오류·unchanged 행은 현재 값
 * 그대로다. 삭제된 부모의 자식은 cascade로 함께 빠진다. 입력을 바꾸지 않는다.
 */
function applyToCurrent(
  current: { deliverables: readonly Deliverable[]; techTargets: readonly TechTarget[] },
  rows: {
    dRows: readonly GoalDeliverablePreviewRow[];
    aRows: readonly GoalAchievementPreviewRow[];
    tRows: readonly GoalTechTargetPreviewRow[];
    rRows: readonly GoalRecordPreviewRow[];
  },
  deleting: ReadonlySet<string>,
  projectId: string
): { deliverables: Deliverable[]; techTargets: TechTarget[] } {
  const updatesOf = <V>(list: readonly GoalPreviewRow<V, string>[]) =>
    new Map(list.filter((r) => r.status === 'update' && r.values !== null).map((r) => [r.id as string, r.values as V]));
  const addsOf = <V>(list: readonly GoalPreviewRow<V, string>[]) =>
    list.filter((r) => r.status === 'add' && r.values !== null) as (GoalPreviewRow<V, string> & { values: V })[];

  // 성과목표
  const dUpdates = updatesOf(rows.dRows);
  const deliverables: Deliverable[] = current.deliverables
    .filter((d) => !deleting.has(d.id))
    .map((d) => {
      const v = dUpdates.get(d.id);
      const achievements = d.achievements.filter((a) => !deleting.has(a.id)).map((a) => ({ ...a, memberIds: [...a.memberIds] }));
      if (v === undefined) return { ...d, targetByYear: { ...d.targetByYear }, achievements };
      return {
        ...d,
        type: v.type,
        name: v.name,
        unit: v.unit,
        weight: v.weight,
        targetTotal: v.targetTotal,
        targetByYear: mergeYearTargets(d.targetByYear, v.targetByYear),
        orgId: v.orgId,
        evidenceMethod: v.evidenceMethod,
        note: v.note,
        achievements,
      };
    });
  const newDeliverables = new Map<number, Deliverable>();
  let order = nextOrder(current.deliverables);
  for (const r of addsOf(rows.dRows)) {
    const v = r.values;
    const d: Deliverable = {
      ...NEW_ENTITY,
      id: `new:deliverable:${r.sheetRow}`,
      projectId,
      type: v.type,
      name: v.name,
      unit: v.unit,
      weight: v.weight,
      targetTotal: v.targetTotal,
      targetByYear: mergeYearTargets({}, v.targetByYear),
      achievements: [],
      orgId: v.orgId,
      evidenceMethod: v.evidenceMethod,
      note: v.note,
      order: order++,
    };
    deliverables.push(d);
    newDeliverables.set(r.sheetRow, d);
  }

  const aUpdates = updatesOf(rows.aRows);
  for (const d of deliverables) {
    d.achievements = d.achievements.map((a) => {
      const v = aUpdates.get(a.id);
      if (v === undefined) return a;
      return { ...a, title: v.title, date: v.date, yearId: v.yearId, orgId: v.orgId, memberIds: [...v.memberIds], evidenceUrl: v.evidenceUrl, note: v.note };
    });
  }
  for (const r of addsOf(rows.aRows)) {
    const v = r.values;
    const parent =
      v.parent.kind === 'new' ? newDeliverables.get(v.parent.row) : deliverables.find((d) => d.id === (v.parent as { id: string }).id);
    // 받은 뒤 지워진 부모 — 반영에서도 붙일 곳이 없다(RPC가 거부한다)
    if (parent === undefined) continue;
    parent.achievements.push({
      id: `new:achievement:${r.sheetRow}`,
      version: 0,
      title: v.title,
      date: v.date,
      yearId: v.yearId,
      orgId: v.orgId,
      memberIds: [...v.memberIds],
      evidenceUrl: v.evidenceUrl,
      note: v.note,
    });
  }

  // 기술목표
  const tUpdates = updatesOf(rows.tRows);
  const techTargets: TechTarget[] = current.techTargets
    .filter((t) => !deleting.has(t.id))
    .map((t) => {
      const v = tUpdates.get(t.id);
      const records = t.records.filter((r) => !deleting.has(r.id)).map((r) => ({ ...r }));
      if (v === undefined) return { ...t, targetByYear: { ...t.targetByYear }, records };
      const { targetByYear, ...rest } = v;
      return { ...t, ...rest, targetByYear: mergeYearTargets(t.targetByYear, targetByYear), records };
    });
  const newTechTargets = new Map<number, TechTarget>();
  order = nextOrder(current.techTargets);
  for (const r of addsOf(rows.tRows)) {
    const { targetByYear, ...rest } = r.values;
    const t: TechTarget = {
      ...NEW_ENTITY,
      ...rest,
      id: `new:techTarget:${r.sheetRow}`,
      projectId,
      targetByYear: mergeYearTargets({}, targetByYear),
      records: [],
      order: order++,
    };
    techTargets.push(t);
    newTechTargets.set(r.sheetRow, t);
  }

  const rUpdates = updatesOf(rows.rRows);
  for (const t of techTargets) {
    t.records = t.records.map((rec) => {
      const v = rUpdates.get(rec.id);
      if (v === undefined) return rec;
      const { parent: _parent, ...rest } = v;
      return { ...rec, ...rest };
    });
  }
  for (const r of addsOf(rows.rRows)) {
    const { parent: ref, ...rest } = r.values;
    const parent = ref.kind === 'new' ? newTechTargets.get(ref.row) : techTargets.find((t) => t.id === ref.id);
    if (parent === undefined) continue;
    parent.records.push({ ...rest, id: `new:record:${r.sheetRow}`, version: 0 });
  }

  return { deliverables, techTargets };
}

// ─── 커밋 페이로드 (T1 계약) ─────────────────────────────────

export interface GoalFormCommit {
  payload: GoalFormCommitPayload;
  expected: GoalFormExpected;
}

/** RPC 임시 키(GF-10). 새 부모 행과 그 행을 가리키는 새 자식이 같은 값을 쓴다 */
export function goalRowKey(sheetRow: number): string {
  return `row:${sheetRow}`;
}

function yearTargetsPayload(values: GoalYearTargets, yearIds: readonly string[]): Record<string, number | null> {
  // `_meta.yearIds` 키 전부를 싣는다 — null은 그 키 삭제, 싣지 않은 키는 보존(S-13)
  const out: Record<string, number | null> = {};
  for (const id of yearIds) out[id] = values[id] ?? null;
  return out;
}

function deliverableFields(v: GoalDeliverableValues, yearIds: readonly string[]): GoalFormDeliverableFields {
  return {
    type: v.type,
    name: v.name,
    unit: v.unit,
    weight: v.weight,
    target_total: v.targetTotal,
    target_by_year: yearTargetsPayload(v.targetByYear, yearIds),
    org_id: v.orgId,
    evidence_method: v.evidenceMethod,
    note: v.note,
  };
}

function achievementFields(v: GoalAchievementValues): GoalFormAchievementFields {
  return {
    title: v.title,
    date: v.date,
    year_id: v.yearId,
    org_id: v.orgId,
    member_ids: [...v.memberIds],
    evidence_url: v.evidenceUrl,
    note: v.note,
  };
}

function techTargetFields(v: GoalTechTargetValues, yearIds: readonly string[]): GoalFormTechTargetFields {
  return {
    name: v.name,
    group_name: v.group,
    unit: v.unit,
    direction: v.direction,
    weight: v.weight,
    target_value: v.targetValue,
    target_by_year: yearTargetsPayload(v.targetByYear, yearIds),
    baseline_domestic: v.baselineDomestic,
    world_best: v.worldBest,
    world_best_holder: v.worldBestHolder,
    measure_method: v.measureMethod,
    measure_description: v.measureDescription,
    standard_basis: v.standardBasis,
    basis_rationale: v.basisRationale,
    evaluation_environment: v.evaluationEnvironment,
    org_id: v.orgId,
    note: v.note,
  };
}

function recordFields(v: GoalRecordValues): GoalFormRecordFields {
  return {
    value: v.value,
    date: v.date,
    year_id: v.yearId,
    method: v.method,
    evaluator: v.evaluator,
    evidence_url: v.evidenceUrl,
    note: v.note,
  };
}

function existingParentId(parent: GoalParentRef, where: string): string {
  // 기존 행의 부모는 파서가 숨김 id로만 정한다 — 새 부모를 가리키면 판정이 깨진 것이다
  if (parent.kind !== 'existing') throw new Error(`${where}: 기존 행의 부모가 새 행을 가리킨다`);
  return parent.id;
}

/**
 * 미리보기 → `commit_goal_form` 페이로드(DB snake_case)와 expected. 차단된 미리보기는 반영할 수 없다 —
 * 호출부가 `blocked`를 먼저 보고 RULE로 돌려줘야 하며 여기 오면 던진다. 충돌·unchanged 행은 싣지 않는다.
 * 추가는 시트 순서(S-14), 삭제는 `includeDeletes && allowDeletes`일 때 충돌 없는 후보만.
 */
export function buildGoalFormCommit(preview: GoalFormPreview): GoalFormCommit {
  if (preview.blocked) throw new Error('차단된 목표 양식 미리보기로는 반영 페이로드를 만들 수 없다');
  const { yearIds, expectedVersions: versions } = preview;
  const expected: GoalFormExpected = {};
  const expect = (id: string, map: Readonly<Record<string, number>>, where: string) => {
    const version = map[id];
    if (version === undefined) throw new Error(`${where}: _meta에 없는 id(${id})의 기준 version이 없다`);
    expected[id] = version;
  };

  const payload: GoalFormCommitPayload = {
    deliverables: { adds: [], updates: [], deleteIds: [] },
    achievements: { adds: [], updates: [], deleteIds: [] },
    techTargets: { adds: [], updates: [], deleteIds: [] },
    records: { adds: [], updates: [], deleteIds: [] },
  };

  for (const row of preview.rows.deliverables) {
    if (row.values === null) continue;
    if (row.status === 'add') {
      const add: GoalFormDeliverableAddRow = { row_key: goalRowKey(row.sheetRow), ...deliverableFields(row.values, yearIds) };
      payload.deliverables.adds.push(add);
    } else if (row.status === 'update') {
      const id = row.id as string;
      const update: GoalFormDeliverableUpdateRow = { id, ...deliverableFields(row.values, yearIds) };
      payload.deliverables.updates.push(update);
      expect(id, versions.deliverables, row.key);
    }
  }
  for (const row of preview.rows.techTargets) {
    if (row.values === null) continue;
    if (row.status === 'add') {
      const add: GoalFormTechTargetAddRow = { row_key: goalRowKey(row.sheetRow), ...techTargetFields(row.values, yearIds) };
      payload.techTargets.adds.push(add);
    } else if (row.status === 'update') {
      const id = row.id as string;
      const update: GoalFormTechTargetUpdateRow = { id, ...techTargetFields(row.values, yearIds) };
      payload.techTargets.updates.push(update);
      expect(id, versions.techTargets, row.key);
    }
  }
  for (const row of preview.rows.achievements) {
    if (row.values === null) continue;
    const { parent } = row.values;
    if (row.status === 'add') {
      const fields = achievementFields(row.values);
      const add: GoalFormAchievementAddRow =
        parent.kind === 'new'
          ? { ...fields, deliverable_ref: goalRowKey(parent.row) }
          : { ...fields, deliverable_id: parent.id };
      payload.achievements.adds.push(add);
    } else if (row.status === 'update') {
      const id = row.id as string;
      const update: GoalFormAchievementUpdateRow = {
        id,
        deliverable_id: existingParentId(parent, row.key),
        ...achievementFields(row.values),
      };
      payload.achievements.updates.push(update);
      expect(id, versions.achievements, row.key);
    }
  }
  for (const row of preview.rows.records) {
    if (row.values === null) continue;
    const { parent } = row.values;
    if (row.status === 'add') {
      const fields = recordFields(row.values);
      const add: GoalFormRecordAddRow =
        parent.kind === 'new' ? { ...fields, tech_target_ref: goalRowKey(parent.row) } : { ...fields, tech_target_id: parent.id };
      payload.records.adds.push(add);
    } else if (row.status === 'update') {
      const id = row.id as string;
      const update: GoalFormRecordUpdateRow = {
        id,
        tech_target_id: existingParentId(parent, row.key),
        ...recordFields(row.values),
      };
      payload.records.updates.push(update);
      expect(id, versions.records, row.key);
    }
  }

  if (preview.options.includeDeletes && preview.options.allowDeletes) {
    const blockOf = {
      deliverable: { block: payload.deliverables, versions: versions.deliverables, childVersions: versions.achievements },
      achievement: { block: payload.achievements, versions: versions.achievements, childVersions: {} },
      techTarget: { block: payload.techTargets, versions: versions.techTargets, childVersions: versions.records },
      record: { block: payload.records, versions: versions.records, childVersions: {} },
    } as const;
    for (const candidate of preview.deleteCandidates) {
      if (candidate.conflict !== null) continue;
      const target = blockOf[candidate.kind];
      target.block.deleteIds.push(candidate.id);
      expect(candidate.id, target.versions, `삭제 ${candidate.kind}`);
      // S-6②: 부모를 지우려면 그 부모의 현재 자식 전부가 내려받은 그대로임을 RPC가 확인할 수 있어야 한다
      for (const childId of candidate.childIds) expect(childId, target.childVersions, `삭제 ${candidate.kind} ${candidate.id}의 자식`);
    }
  }

  return { payload, expected };
}
