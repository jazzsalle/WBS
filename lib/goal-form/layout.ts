// 성과·기술목표 양식의 좌표 맵 (SOT §6.17 GF-1·GF-3·GF-8, 부록 F-9).
//
// **맵은 코드가 아니라 데이터다**(IN-1과 같은 원칙). 시트 이름·순서·열·읽는 열·드롭다운 출처를 여기 한 곳에 두고
// 생성기·파서·어댑터가 같은 맵을 읽는다 — 둘이 어긋날 수 없다. 연차 열 수만 과제마다 달라서 맵을
// 함수(`goalSheetsFor`)로 만든다. 파서는 헤더 이름이 아니라 `_meta` 연차 수로 같은 맵을 다시 만든다(GF-2).
//
// xlsx·exceljs·supabase를 import하지 않는다. `FormColumnValidation`·`FormListRange`는 타입으로만 가져온다(S-22).

import { DELIVERABLE_TYPE_LABELS, DIRECTION_LABELS, MEASURE_METHOD_LABELS } from '@/lib/constants';
import { columnLetter, encodeAddr } from '@/lib/export/layouts';
import type { FormCellFormat } from '@/lib/input-form/layout';
import type { FormColumnValidation, FormListRange } from '@/lib/input-form/types';

/** 양식 구조가 바뀌면 올린다. 올린 파일의 `_meta.formVersion`과 다르면 거부한다(GF-2) */
export const GOAL_FORM_VERSION = 1;

/** `_meta`의 `form` 값. 입력 양식 `_meta`에는 이 행이 없어 목표 양식으로 올리면 거부된다(GF-2) */
export const GOAL_FORM_KIND = 'goal';

/** 합계 행의 숨김 id 열에 적는 마커 — 파서는 이 행에서 멈춘다(GF-8) */
export const GOAL_TOTAL_MARKER = '#total';

/** 기존 행 아래 빈 입력 행 수. 합계 수식 범위 안에 든다(GF-8) */
export const GOAL_EMPTY_INPUT_ROWS = 20;

/** 백분율 서식은 쓰지 않는다(F-6·X-7) — 가중치 `10`이 `1000%`로 보인다 */
export type GoalCellFormat = Exclude<FormCellFormat, 'percent'>;

export type GoalSheetKey =
  | 'guide'
  | 'deliverables'
  | 'achievements'
  | 'techTargets'
  | 'records'
  | 'lists'
  | 'meta';

/** 시트 순서(GF-1, S-7). 생성기는 이 순서로 쓴다 */
export const GOAL_SHEET_ORDER: readonly GoalSheetKey[] = [
  'guide',
  'deliverables',
  'achievements',
  'techTargets',
  'records',
  'lists',
  'meta',
];

/** `_lists` 시트의 목록 종류 — 열 하나에 목록 하나(F-9) */
export type GoalListKey = 'deliverableType' | 'direction' | 'measureMethod' | 'year' | 'org' | 'member';

/**
 * 드롭다운 목록의 출처(F-9). `lists`는 `_lists` 숨김 시트의 열, `sheet`는 같은 파일 데이터 시트의 이름 열이다 —
 * 실적·측정 시트의 지표명/평가항목은 새로 적은 지표도 목록에 떠야 해서 `_lists`에 복사하지 않고 직접 가리킨다(GF-10).
 */
export type GoalListSource =
  | { kind: 'lists'; list: GoalListKey }
  | { kind: 'sheet'; sheet: 'deliverables' | 'techTargets'; role: 'name' };

export interface GoalColumnDef<R extends string = string> {
  role: R;
  /** 헤더 행 라벨. 연차 열은 연차 라벨(GF-3) */
  label: string;
  /** 숨김 id 열. 숨김 열은 전부 파서가 읽는 키다 */
  hidden: boolean;
  /** false면 표시·계산 전용(연차 합계 수식) — 사용자가 고쳐도 무시한다(GF-8) */
  read: boolean;
  format: GoalCellFormat;
  /** 연차 열만. `_meta.yearIds`의 인덱스 — 열 순서 = yearIds 순서(GF-2) */
  yearIndex?: number;
  list?: GoalListSource;
  /** 드롭다운 오류 스타일. 없으면 'stop'. `;` 다중 입력(관여자)·다른 시트 이름 목록은 'warning'(GF-4·GF-10) */
  errorStyle?: 'stop' | 'warning';
}

export interface GoalSheetDef<R extends string = string> {
  key: GoalSheetKey;
  name: string;
  hidden: boolean;
  /** 부록 F 서식 분기. guide는 F-8, lists·meta는 서식 없는 숨김 시트 */
  kind: 'guide' | 'data' | 'lists' | 'meta';
  /** 1-based */
  headerRow: number;
  /** 1-based. 파서는 여기서부터 `#total` 행 직전까지 읽는다(GF-8) */
  dataStartRow: number;
  columns: readonly GoalColumnDef<R>[];
}

export type DeliverableColumnRole =
  | 'deliverableId'
  | 'type'
  | 'name'
  | 'unit'
  | 'weight'
  | 'targetTotal'
  | 'yearTarget'
  | 'yearTotal'
  | 'org'
  | 'evidenceMethod'
  | 'note';

export type AchievementColumnRole =
  | 'deliverableId'
  | 'achievementId'
  | 'deliverableName'
  | 'title'
  | 'date'
  | 'year'
  | 'org'
  | 'members'
  | 'evidenceUrl'
  | 'note';

export type TechTargetColumnRole =
  | 'techTargetId'
  | 'group'
  | 'name'
  | 'unit'
  | 'direction'
  | 'weight'
  | 'yearTarget'
  | 'targetValue'
  | 'baselineDomestic'
  | 'worldBest'
  | 'worldBestHolder'
  | 'measureMethod'
  | 'measureDescription'
  | 'standardBasis'
  | 'basisRationale'
  | 'evaluationEnvironment'
  | 'org'
  | 'note';

export type RecordColumnRole =
  | 'techTargetId'
  | 'recordId'
  | 'techTargetName'
  | 'value'
  | 'date'
  | 'year'
  | 'method'
  | 'evaluator'
  | 'evidenceUrl'
  | 'note';

export type GoalMetaColumnRole = 'key' | 'value';

export interface GoalFormSheets {
  guide: GoalSheetDef<never>;
  deliverables: GoalSheetDef<DeliverableColumnRole>;
  achievements: GoalSheetDef<AchievementColumnRole>;
  techTargets: GoalSheetDef<TechTargetColumnRole>;
  records: GoalSheetDef<RecordColumnRole>;
  lists: GoalSheetDef<GoalListKey>;
  meta: GoalSheetDef<GoalMetaColumnRole>;
}

/** `_meta` 고정 키와 id 목록 접두(GF-1). 접두 행의 값은 라벨(연차·기관·인력) 또는 내려받은 시점 version(S-5) */
export const GOAL_META_KEYS = {
  form: 'form',
  formVersion: 'formVersion',
  projectId: 'projectId',
  generatedAt: 'generatedAt',
} as const;

export const GOAL_META_PREFIXES = {
  year: 'year:',
  org: 'org:',
  member: 'member:',
  deliverable: 'deliverable:',
  achievement: 'achievement:',
  techTarget: 'techTarget:',
  record: 'record:',
} as const;

// ─── 부록 A.2·A.4 라벨 ↔ 코드 (GF-3) ─────────────────────────

/**
 * 양식에 적는 enum 라벨. 원본은 `lib/constants.ts`(부록 A.2·A.4) — 화면 라벨과 양식 라벨이 갈라지면
 * 화면에서 본 값을 양식에 적었을 때 모르는 라벨이 된다.
 */
export const GOAL_ENUM_LABELS = {
  deliverableType: DELIVERABLE_TYPE_LABELS,
  direction: DIRECTION_LABELS,
  measureMethod: MEASURE_METHOD_LABELS,
} as const;

export type GoalEnumKind = keyof typeof GOAL_ENUM_LABELS;
export type GoalEnumCode<K extends GoalEnumKind> = keyof (typeof GOAL_ENUM_LABELS)[K] & string;

function reverseLabels(kind: GoalEnumKind): ReadonlyMap<string, string> {
  const out = new Map<string, string>();
  for (const [code, label] of Object.entries(GOAL_ENUM_LABELS[kind])) {
    // 라벨이 겹치면 역방향이 한쪽을 조용히 덮는다 — 모듈 로드 시점에 터뜨린다
    if (out.has(label)) throw new Error(`${kind} 라벨 '${label}'이 둘 이상의 코드에 쓰였다`);
    out.set(label, code);
  }
  return out;
}

// Map으로 찾는다 — 객체 조회는 'constructor' 같은 셀 값에 프로토타입 멤버를 돌려준다
const REVERSE_LABELS: Readonly<Record<GoalEnumKind, ReadonlyMap<string, string>>> = {
  deliverableType: reverseLabels('deliverableType'),
  direction: reverseLabels('direction'),
  measureMethod: reverseLabels('measureMethod'),
};

export function goalEnumLabel<K extends GoalEnumKind>(kind: K, code: GoalEnumCode<K>): string {
  return (GOAL_ENUM_LABELS[kind] as Record<string, string>)[code] as string;
}

/**
 * 라벨 → 코드. 앞뒤 공백만 떼고 **완전 일치**만 받는다 — 부록 C.3.3 별칭은 hwpx 전용이다(GF-3, S-10).
 * 모르는 라벨은 null(파서가 오류 행으로 만든다).
 */
export function goalEnumFromLabel<K extends GoalEnumKind>(kind: K, text: string): GoalEnumCode<K> | null {
  return (REVERSE_LABELS[kind].get(text.trim()) as GoalEnumCode<K> | undefined) ?? null;
}

/** `_lists` 열에 싣는 라벨 목록 — 부록 순서 그대로 */
export function goalEnumLabels(kind: GoalEnumKind): string[] {
  return Object.values(GOAL_ENUM_LABELS[kind]);
}

// ─── 좌표 맵 ────────────────────────────────────────────────

type Col<R extends string> = GoalColumnDef<R>;

const visible = <R extends string>(role: R, label: string, extra: Partial<Col<R>> = {}): Col<R> => ({
  role,
  label,
  hidden: false,
  read: true,
  format: 'text',
  ...extra,
});

const hiddenId = <R extends string>(role: R): Col<R> => ({
  role,
  label: role,
  hidden: true,
  read: true,
  format: 'text',
});

const fromList = (list: GoalListKey): GoalListSource => ({ kind: 'lists', list });

function yearTargetColumns(labels: readonly string[], format: GoalCellFormat): Col<'yearTarget'>[] {
  return labels.map((label, yearIndex) => ({
    role: 'yearTarget',
    label,
    hidden: false,
    read: true,
    format,
    yearIndex,
  }));
}

function deliverableColumns(yearLabels: readonly string[]): Col<DeliverableColumnRole>[] {
  return [
    // 숨김 id 열이 첫 열이다 — 합계 행 마커 `#total`도 여기 적는다(GF-8)
    hiddenId('deliverableId'),
    visible('type', '유형', { list: fromList('deliverableType') }),
    visible('name', '지표명'),
    visible('unit', '단위'),
    visible('weight', '가중치(%)', { format: 'decimal' }),
    visible('targetTotal', '전체 목표', { format: 'int' }),
    ...yearTargetColumns(yearLabels, 'int'),
    visible('yearTotal', '연차 합계', { read: false, format: 'formula' }),
    visible('org', '책임기관', { list: fromList('org') }),
    visible('evidenceMethod', '평가방법'),
    visible('note', '비고'),
  ];
}

const ACHIEVEMENT_COLUMNS: readonly Col<AchievementColumnRole>[] = [
  hiddenId('deliverableId'),
  hiddenId('achievementId'),
  // 읽는 열이다 — 새 행의 부모를 이 이름으로 찾는다(GF-10). 기존 행은 숨김 id가 부모다
  visible('deliverableName', '지표명', {
    list: { kind: 'sheet', sheet: 'deliverables', role: 'name' },
    errorStyle: 'warning',
  }),
  visible('title', '산출물명'),
  visible('date', '달성일', { format: 'date' }),
  visible('year', '연차', { list: fromList('year') }),
  visible('org', '기관', { list: fromList('org') }),
  visible('members', '관여자', { list: fromList('member'), errorStyle: 'warning' }),
  visible('evidenceUrl', '증빙 URL'),
  visible('note', '비고'),
];

function techTargetColumns(yearLabels: readonly string[]): Col<TechTargetColumnRole>[] {
  return [
    hiddenId('techTargetId'),
    visible('group', '구분'),
    visible('name', '평가항목'),
    visible('unit', '단위'),
    visible('direction', '방향', { list: fromList('direction') }),
    visible('weight', '비중(%)', { format: 'decimal' }),
    ...yearTargetColumns(yearLabels, 'decimal'),
    visible('targetValue', '최종 목표', { format: 'decimal' }),
    visible('baselineDomestic', '국내수준', { format: 'decimal' }),
    visible('worldBest', '세계최고', { format: 'decimal' }),
    visible('worldBestHolder', '보유국·기관'),
    visible('measureMethod', '측정방법', { list: fromList('measureMethod') }),
    visible('measureDescription', '측정방법 상세'),
    visible('standardBasis', '표준·인증기준'),
    visible('basisRationale', '기준설정 근거'),
    visible('evaluationEnvironment', '평가환경'),
    visible('org', '책임기관', { list: fromList('org') }),
    visible('note', '비고'),
  ];
}

const RECORD_COLUMNS: readonly Col<RecordColumnRole>[] = [
  hiddenId('techTargetId'),
  hiddenId('recordId'),
  visible('techTargetName', '평가항목', {
    list: { kind: 'sheet', sheet: 'techTargets', role: 'name' },
    errorStyle: 'warning',
  }),
  visible('value', '측정값', { format: 'decimal' }),
  visible('date', '측정일', { format: 'date' }),
  visible('year', '연차', { list: fromList('year') }),
  visible('method', '방법', { list: fromList('measureMethod') }),
  visible('evaluator', '평가기관'),
  visible('evidenceUrl', '증빙 URL'),
  visible('note', '비고'),
];

// 파서는 `_lists`를 읽지 않는다(GF-1) — 목록은 드롭다운 재료일 뿐, 판정은 `_meta`와 부록 라벨로 한다
const LIST_COLUMNS: readonly Col<GoalListKey>[] = (
  [
    ['deliverableType', '유형'],
    ['direction', '방향'],
    ['measureMethod', '측정방법'],
    ['year', '연차'],
    ['org', '기관'],
    ['member', '관여자'],
  ] as const
).map(([role, label]) => visible(role, label, { read: false }));

const META_COLUMNS: readonly Col<GoalMetaColumnRole>[] = [visible('key', '키'), visible('value', '값')];

function sheet<R extends string>(
  key: GoalSheetKey,
  name: string,
  kind: GoalSheetDef['kind'],
  columns: readonly Col<R>[]
): GoalSheetDef<R> {
  return { key, name, hidden: kind === 'lists' || kind === 'meta', kind, headerRow: 1, dataStartRow: 2, columns };
}

/**
 * 좌표 맵. 인자는 연차 라벨(생성기 — 헤더에 찍힌다) 또는 연차 수(파서 — `_meta.yearIds.length`).
 * 연차 수만 주면 헤더는 `${n}차년도`다. 파서는 헤더를 읽지 않으므로(GF-2) 라벨이 달라도 좌표는 같다.
 */
export function goalSheetsFor(years: readonly string[] | number): GoalFormSheets {
  let labels: readonly string[];
  if (typeof years === 'number') {
    if (!Number.isInteger(years) || years < 0) throw new Error(`연차 수가 올바르지 않습니다: ${years}`);
    labels = Array.from({ length: years }, (_, i) => `${i + 1}차년도`);
  } else {
    labels = years;
  }
  return {
    guide: sheet<never>('guide', '작성안내', 'guide', []),
    deliverables: sheet('deliverables', '성과목표', 'data', deliverableColumns(labels)),
    achievements: sheet('achievements', '성과실적', 'data', ACHIEVEMENT_COLUMNS),
    techTargets: sheet('techTargets', '기술목표', 'data', techTargetColumns(labels)),
    records: sheet('records', '측정이력', 'data', RECORD_COLUMNS),
    lists: sheet('lists', '_lists', 'lists', LIST_COLUMNS),
    meta: sheet('meta', '_meta', 'meta', META_COLUMNS),
  };
}

/** `GOAL_SHEET_ORDER` 순서의 시트 목록 */
export function orderedGoalSheets(sheets: GoalFormSheets): GoalSheetDef[] {
  return GOAL_SHEET_ORDER.map((key) => sheets[key] as GoalSheetDef);
}

// ─── 좌표 헬퍼 ──────────────────────────────────────────────

/**
 * 역할 → 열 인덱스(0-based). 정확히 하나여야 하며 아니면 throw — 맵의 오타가 빈 열을 만들지 않게.
 * 연차 열(`yearTarget`)은 여럿이므로 `goalYearColumns`로 찾는다.
 */
export function goalColumnOf<R extends string>(def: GoalSheetDef<R>, role: R): number {
  const indexes: number[] = [];
  def.columns.forEach((column, index) => {
    if (column.role === role) indexes.push(index);
  });
  if (indexes.length !== 1) {
    throw new Error(`'${def.name}' 시트에 역할 '${role}'인 열이 ${indexes.length}개다 (정확히 1개여야 한다)`);
  }
  return indexes[0] as number;
}

/** 연차 열 인덱스(0-based)를 `yearIndex` 순서로. 결과의 i번째 = `_meta.yearIds[i]`의 열(GF-2) */
export function goalYearColumns(def: GoalSheetDef): number[] {
  return def.columns
    .map((column, index) => ({ yearIndex: column.yearIndex, index }))
    .filter((entry): entry is { yearIndex: number; index: number } => entry.yearIndex !== undefined)
    .sort((a, b) => a.yearIndex - b.yearIndex)
    .map((entry) => entry.index);
}

/** 역할 + 1-based 행 → A1 주소 */
export function goalColumnAddress<R extends string>(def: GoalSheetDef<R>, role: R, row1based: number): string {
  return encodeAddr(columnLetter(goalColumnOf(def, role)), row1based);
}

/** `FormSheet.hiddenColumns`에 그대로 넣는 값 */
export function goalHiddenColumns(def: GoalSheetDef): number[] {
  const out: number[] = [];
  def.columns.forEach((column, index) => {
    if (column.hidden) out.push(index);
  });
  return out;
}

function absoluteColumnRange(columnIndex: number, firstRow: number, lastRow: number): string {
  const letter = columnLetter(columnIndex);
  return `$${letter}$${firstRow}:$${letter}$${lastRow}`;
}

/**
 * `_lists`의 목록 범위. 목록이 비어도 한 칸(빈 칸)은 가리킨다 — 빈 범위 참조는 엑셀이 유효성 자체를 버린다.
 * `count`는 그 열에 실은 라벨 수다.
 */
export function goalListRange(sheets: GoalFormSheets, list: GoalListKey, count: number): FormListRange {
  const def = sheets.lists;
  if (!Number.isInteger(count) || count < 0) throw new Error(`'${list}' 목록 길이가 올바르지 않습니다: ${count}`);
  const first = def.dataStartRow;
  return {
    sheet: def.name,
    range: absoluteColumnRange(goalColumnOf(def, list), first, first + Math.max(count, 1) - 1),
  };
}

/**
 * 성과목표·기술목표 시트 이름 열 범위 — 실적·측정 시트 드롭다운의 출처(GF-10).
 * `lastDataRow`는 1-based 마지막 입력 행(빈 입력 행 포함, 합계 행 제외) — 새로 적은 지표도 목록에 떠야 한다.
 */
export function goalNameRange(
  sheets: GoalFormSheets,
  target: 'deliverables' | 'techTargets',
  lastDataRow: number
): FormListRange {
  const def: GoalSheetDef<'name'> = sheets[target] as GoalSheetDef<'name'>;
  const first = def.dataStartRow;
  if (!Number.isInteger(lastDataRow) || lastDataRow < first) {
    throw new Error(`'${def.name}' 시트의 마지막 입력 행이 올바르지 않습니다: ${lastDataRow}`);
  }
  return { sheet: def.name, range: absoluteColumnRange(goalColumnOf(def, 'name'), first, lastDataRow) };
}

/**
 * 시트의 드롭다운 목록(F-9). 맵의 `list`가 있는 열마다 하나. 범위의 행 수는 데이터에 달려 있어
 * 호출부(생성기)가 `resolve`로 준다 — 보통 `goalListRange`·`goalNameRange`다.
 * 범위 참조이므로 `values`는 빈 배열이다(인라인 목록과 동시에 쓰지 않는다).
 */
export function goalValidations(
  def: GoalSheetDef,
  resolve: (source: GoalListSource) => FormListRange
): FormColumnValidation[] {
  const out: FormColumnValidation[] = [];
  def.columns.forEach((column, index) => {
    if (column.list === undefined) return;
    out.push({
      column: index,
      values: [],
      listRange: resolve(column.list),
      errorStyle: column.errorStyle ?? 'stop',
    });
  });
  return out;
}
