// 성과·기술목표 양식 생성기 (SOT §6.17 GF-1·GF-3·GF-4·GF-8, 부록 F-8·F-9).
//
// 앱 데이터 → `GoalFormWorkbook`(FormCell 격자). 좌표는 전부 `layout.ts`에서 온다 — 여기에 열 번호가 하나라도
// 박히면 파서와 어긋날 수 있다(GF-1). xlsx·exceljs를 import하지 않는다 — 서식은 FormSheet의 힌트로만 실어
// 보내고 쓰기는 입력 양식 어댑터(`writeInputFormWorkbook`)가 그대로 한다(S-22).
//
// 반영이 id 기반이라(GF-5) 양식에 실리지 않은 행은 "양식에서 사라진 id" = 삭제 후보가 된다. 그래서 행이
// 가리키는 연차·기관·인력이 목록에 없으면 빈 칸으로 흘려보내지 않고 던진다 — 빈 칸으로 다시 올리면 그 값이
// 지워진다(절대 규칙 5).

import { columnLetter, encodeAddr } from '@/lib/export/layouts';
import type { FormCell, FormColumnHint, FormColumnValidation, FormRowRole, FormSheet } from '@/lib/input-form/types';
import type {
  Deliverable,
  DeliverableAchievement,
  Member,
  Organization,
  Project,
  TechTarget,
  TechTargetRecord,
  Year,
} from '@/types';
import { buildGoalGuideSheet } from './guide';
import {
  GOAL_EMPTY_INPUT_ROWS,
  GOAL_FORM_VERSION,
  GOAL_TOTAL_MARKER,
  goalColumnOf,
  goalEnumLabel,
  goalEnumLabels,
  goalHiddenColumns,
  goalListRange,
  goalNameRange,
  goalSheetsFor,
  goalValidations,
  goalYearColumns,
  orderedGoalSheets,
} from './layout';
import type { GoalColumnDef, GoalFormSheets, GoalListKey, GoalListSource, GoalSheetDef, GoalSheetKey } from './layout';
import { buildGoalMetaRows, disambiguateLabels, goalYearLabels } from './meta';
import type { GoalFormMeta } from './types';

// ─── 입출력 타입 ─────────────────────────────────────────────

/**
 * 양식 한 장을 만드는 데 필요한 앱 데이터 전부. **읽기 전용이다** — 내려받기는 앱을 바꾸지 않는다.
 * `members`는 비활성 인력도 담는다 — 기존 실적의 관여자가 비활성이어도 라벨이 있어야 다시 올릴 때 지워지지 않는다.
 */
export interface GoalFormData {
  project: Pick<Project, 'id' | 'name'>;
  /** 연차 열 순서. 생성기가 `order`로 다시 정렬한다 */
  years: Pick<Year, 'id' | 'name' | 'order'>[];
  /** 드롭다운·`_meta`에 싣는 순서 그대로 */
  orgs: Pick<Organization, 'id' | 'name'>[];
  members: Pick<Member, 'id' | 'name'>[];
  /** `achievements` 포함. 시트 순서는 `order` */
  deliverables: Deliverable[];
  /** `records` 포함. 시트 순서는 `order` */
  techTargets: TechTarget[];
  /** ISO 8601. `_meta.generatedAt`·파일명·안내 부제에 쓴다 — 시각을 생성기가 읽지 않는다 */
  generatedAt: string;
}

/** 입력 양식 `InputFormWorkbook`과 같은 모양 — 어댑터가 그대로 쓴다(S-22) */
export interface GoalFormWorkbook {
  sheets: FormSheet[];
  fileName: string;
}

/** 성과목표·기술목표 합계 행의 라벨(이름 열). 파서는 `#total` 마커로 건너뛰므로 라벨은 표시용이다 */
export const GOAL_TOTAL_LABEL = '합계';
/** 관여자 구분자(GF-4) */
export const GOAL_MEMBER_SEPARATOR = ';';

// ─── 서식 힌트 (부록 F-3·F-5·F-6·F-7) ───────────────────────

/** 역할 → 열 너비(F-7). 숨김 열은 표를 보지 않는다. 표에 없는 역할은 던진다 */
const COLUMN_WIDTHS: Readonly<Record<string, number>> = {
  name: 26,
  deliverableName: 26,
  techTargetName: 26,
  title: 26,
  note: 40,
  evidenceMethod: 40,
  evidenceUrl: 40,
  measureDescription: 40,
  standardBasis: 40,
  basisRationale: 40,
  evaluationEnvironment: 40,
  worldBestHolder: 20,
  org: 20,
  members: 20,
  evaluator: 20,
  type: 16,
  group: 12,
  unit: 10,
  direction: 14,
  measureMethod: 12,
  method: 12,
  year: 12,
  date: 12,
  weight: 12,
  targetTotal: 12,
  yearTarget: 12,
  yearTotal: 12,
  targetValue: 12,
  baselineDomestic: 12,
  worldBest: 12,
  value: 12,
};
const HIDDEN_COLUMN_WIDTH = 10;
/** F-5 짧은 분류는 가운데 */
const CENTER_ROLES: ReadonlySet<string> = new Set(['type', 'direction', 'measureMethod', 'method', 'year']);

function columnHint(column: GoalColumnDef): FormColumnHint {
  // 타입이 이미 percent를 막지만(GoalCellFormat) 맵이 캐스트로 우회해도 여기서 막는다(F-6·X-7)
  if ((column.format as string) === 'percent') {
    throw new Error(`열 '${column.label}'의 서식이 percent다 — 목표 양식은 백분율 서식을 쓰지 않는다(F-6)`);
  }
  let width: number;
  if (column.hidden) {
    width = HIDDEN_COLUMN_WIDTH;
  } else {
    const w = COLUMN_WIDTHS[column.role];
    if (w === undefined) throw new Error(`열 역할 '${column.role}'의 너비가 정해지지 않았다(F-7)`);
    width = w;
  }
  const numeric = column.format === 'int' || column.format === 'decimal' || column.format === 'formula';
  const align: FormColumnHint['align'] = numeric ? 'right' : CENTER_ROLES.has(column.role) ? 'center' : 'left';
  return { key: !column.hidden && !column.read, format: column.format, width, align };
}

// ─── 셀 헬퍼 ────────────────────────────────────────────────

type SetCell<R extends string> = (role: R, cell: FormCell) => void;

function makeRow<R extends string>(def: GoalSheetDef<R>): { cells: FormCell[]; set: SetCell<R> } {
  const cells: FormCell[] = def.columns.map(() => ({}));
  return {
    cells,
    set: (role, cell) => {
      cells[goalColumnOf(def, role)] = cell;
    },
  };
}

function address(columnIndex: number, row1based: number): string {
  return encodeAddr(columnLetter(columnIndex), row1based);
}

/** 같은 열의 `first`~`last` 행 합계 수식. `=` 없이(FormCell 규약) */
function sumColumn(columnIndex: number, first: number, last: number): string {
  return `SUM(${address(columnIndex, first)}:${address(columnIndex, last)})`;
}

function byOrder<T extends { order: number }>(a: T, b: T): number {
  return a.order - b.order;
}

/** id → 라벨. 목록 밖 id는 던진다(파일 머리말) */
function labelLookup(kind: string, entries: readonly { id: string }[], labels: readonly string[]) {
  const map = new Map(entries.map((entry, i) => [entry.id, labels[i] as string]));
  return (id: string | null, owner: string): string | null => {
    if (id === null) return null;
    const label = map.get(id);
    if (label === undefined) throw new Error(`${owner}의 ${kind}(${id})이 양식 ${kind} 목록에 없다`);
    return label;
  };
}

/** 연차 열 값. 키가 없으면 빈 칸, 0이면 0 — 둘은 다르다(D-5: 목표 없음 vs 목표 0) */
function yearTargetCells(
  def: GoalSheetDef,
  cells: FormCell[],
  targetByYear: Record<string, number>,
  yearIds: readonly string[]
): void {
  goalYearColumns(def).forEach((columnIndex, i) => {
    const yearId = yearIds[i] as string;
    cells[columnIndex] = { value: Object.hasOwn(targetByYear, yearId) ? (targetByYear[yearId] as number) : null };
  });
}

interface SheetBody {
  rows: FormCell[][];
  roles: FormRowRole[];
}

function headerBody(def: GoalSheetDef): SheetBody {
  const rows: FormCell[][] = [];
  for (let r = 1; r < def.headerRow; r += 1) rows.push([]);
  rows.push(def.columns.map((column) => ({ value: column.label })));
  for (let r = def.headerRow + 1; r < def.dataStartRow; r += 1) rows.push([]);
  return { rows, roles: rows.map(() => 'header') };
}

/**
 * 데이터 시트 골격(GF-8): 헤더 → 기존 행 → 빈 입력 행 20 → 합계 행(숨김 id 첫 열 = `#total`).
 * `fill`은 기존 행(entry)과 빈 입력 행(null) 모두에 불린다 — 행마다 수식(연차 합계)이 필요한 시트가 있다.
 * `total`은 합계 행에 추가로 쓸 셀이고 인자는 합계 범위(첫 데이터 행 ~ 합계 행 직전)다.
 */
function buildDataBody<R extends string, T>(
  def: GoalSheetDef<R>,
  entries: readonly T[],
  fill: (set: SetCell<R>, cells: FormCell[], entry: T | null, rowNumber: number) => void,
  total: (set: SetCell<R>, firstRow: number, lastRow: number) => void
): SheetBody & { lastDataRow: number } {
  const { rows, roles } = headerBody(def as GoalSheetDef);
  const slots: (T | null)[] = [...entries, ...Array.from({ length: GOAL_EMPTY_INPUT_ROWS }, () => null)];
  for (const entry of slots) {
    const rowNumber = rows.length + 1;
    const { cells, set } = makeRow(def);
    fill(set, cells, entry, rowNumber);
    rows.push(cells);
    roles.push('data');
  }
  const lastDataRow = rows.length;
  const { cells, set } = makeRow(def);
  // 마커는 첫 열(숨김 id)에 — 파서가 어느 시트에서든 같은 자리를 본다(GF-8)
  cells[0] = { value: GOAL_TOTAL_MARKER };
  total(set, def.dataStartRow, lastDataRow);
  rows.push(cells);
  roles.push('total');
  return { rows, roles, lastDataRow };
}

function dataSheet(def: GoalSheetDef, body: SheetBody, validations: FormColumnValidation[]): FormSheet {
  if (body.rows.length !== body.roles.length) {
    throw new Error(`'${def.name}' 시트의 행 수(${body.rows.length})와 행 역할 수(${body.roles.length})가 다르다`);
  }
  if (def.columns[0]?.hidden !== true) {
    throw new Error(`'${def.name}' 시트의 첫 열이 숨김 id가 아니다 — 합계 마커를 적을 수 없다(GF-8)`);
  }
  return {
    name: def.name,
    hidden: def.hidden,
    rows: body.rows,
    hiddenColumns: goalHiddenColumns(def),
    kind: 'data',
    headerRow: def.headerRow,
    dataStartRow: def.dataStartRow,
    columnHints: def.columns.map(columnHint),
    rowRoles: body.roles,
    validations,
  };
}

// ─── 파일명 ─────────────────────────────────────────────────

// X-12 파일명 규칙과 같은 치환(`lib/export/detail-sheet.ts`의 sanitizeFileNamePart는 내보내지 않는다)
const FORBIDDEN_FILENAME_CHARS = /[\\/:*?"<>|]|\p{Cc}/gu;

/** `목표양식_{과제명}_{yyyymmdd}.xlsx`. 목표 양식은 과제 전체를 담아 연차 부분이 없다 */
export function goalFormFileName(project: Pick<Project, 'name'>, generatedAt: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(generatedAt);
  if (!match) throw new Error(`생성일이 YYYY-MM-DD 형식이 아니다: ${generatedAt}`);
  const cleaned = project.name.replace(FORBIDDEN_FILENAME_CHARS, '_').replace(/\s+/g, ' ').trim();
  // 끝의 점·공백은 윈도우가 조용히 잘라내 파일명이 달라진다
  const trimmed = cleaned.replace(/[. ]+$/, '');
  return `목표양식_${trimmed === '' ? '과제' : trimmed}_${match[1]}${match[2]}${match[3]}.xlsx`;
}

// ─── 워크북 ─────────────────────────────────────────────────

/**
 * 양식 한 장. 시트 순서는 `GOAL_SHEET_ORDER`(작성안내·성과목표·성과실적·기술목표·측정이력·_lists·_meta).
 * 같은 입력이면 같은 출력이다 — 시각은 `data.generatedAt`으로만 받는다.
 */
export function buildGoalForm(data: GoalFormData): GoalFormWorkbook {
  const years = [...data.years].sort(byOrder);
  const yearIds = years.map((y) => y.id);
  const yearLabels = goalYearLabels(years);
  const orgLabels = disambiguateLabels(data.orgs.map((o) => o.name));
  const memberLabels = disambiguateLabels(data.members.map((m) => m.name));
  const yearLabel = labelLookup('연차', years, yearLabels);
  const orgLabel = labelLookup('기관', data.orgs, orgLabels);
  const memberLabel = labelLookup('인력', data.members, memberLabels);

  const sheets: GoalFormSheets = goalSheetsFor(yearLabels);
  const deliverables = [...data.deliverables].sort(byOrder);
  const techTargets = [...data.techTargets].sort(byOrder);

  // ── 성과목표
  const dDef = sheets.deliverables;
  const dYearColumns = goalYearColumns(dDef);
  const dBody = buildDataBody(
    dDef,
    deliverables,
    (set, cells, d: Deliverable | null, rowNumber) => {
      if (d !== null) {
        const owner = `성과목표 ${d.id}`;
        set('deliverableId', { value: d.id });
        set('type', { value: goalEnumLabel('deliverableType', d.type) });
        set('name', { value: d.name });
        set('unit', { value: d.unit });
        set('weight', { value: d.weight });
        set('targetTotal', { value: d.targetTotal });
        yearTargetCells(dDef, cells, d.targetByYear, yearIds);
        set('org', { value: orgLabel(d.orgId, owner) });
        set('evidenceMethod', { value: d.evidenceMethod });
        set('note', { value: d.note });
      }
      // 연차 열이 연속이라 범위 하나로 쓴다. 연차가 없으면 합할 것이 없어 빈 칸이다
      if (dYearColumns.length > 0) {
        const first = dYearColumns[0] as number;
        const last = dYearColumns[dYearColumns.length - 1] as number;
        set('yearTotal', { formula: `SUM(${address(first, rowNumber)}:${address(last, rowNumber)})` });
      }
    },
    (set, first, last) => {
      set('name', { value: GOAL_TOTAL_LABEL });
      set('weight', { formula: sumColumn(goalColumnOf(dDef, 'weight'), first, last) });
    }
  );

  // ── 기술목표
  const tDef = sheets.techTargets;
  const tBody = buildDataBody(
    tDef,
    techTargets,
    (set, cells, t: TechTarget | null) => {
      if (t === null) return;
      const owner = `기술목표 ${t.id}`;
      set('techTargetId', { value: t.id });
      set('group', { value: t.group });
      set('name', { value: t.name });
      set('unit', { value: t.unit });
      set('direction', { value: goalEnumLabel('direction', t.direction) });
      set('weight', { value: t.weight });
      yearTargetCells(tDef, cells, t.targetByYear, yearIds);
      set('targetValue', { value: t.targetValue });
      set('baselineDomestic', { value: t.baselineDomestic });
      set('worldBest', { value: t.worldBest });
      set('worldBestHolder', { value: t.worldBestHolder });
      set('measureMethod', { value: goalEnumLabel('measureMethod', t.measureMethod) });
      set('measureDescription', { value: t.measureDescription });
      set('standardBasis', { value: t.standardBasis });
      set('basisRationale', { value: t.basisRationale });
      set('evaluationEnvironment', { value: t.evaluationEnvironment });
      set('org', { value: orgLabel(t.orgId, owner) });
      set('note', { value: t.note });
    },
    (set, first, last) => {
      set('name', { value: GOAL_TOTAL_LABEL });
      set('weight', { formula: sumColumn(goalColumnOf(tDef, 'weight'), first, last) });
    }
  );

  // ── 성과실적 (지표 순서 → 지표 안 배열 순서)
  const aDef = sheets.achievements;
  const achievements = deliverables.flatMap((d) => d.achievements.map((a) => ({ parent: d, a })));
  const aBody = buildDataBody(
    aDef,
    achievements,
    (set, _cells, entry: { parent: Deliverable; a: DeliverableAchievement } | null) => {
      if (entry === null) return;
      const { parent, a } = entry;
      const owner = `성과실적 ${a.id}`;
      set('deliverableId', { value: parent.id });
      set('achievementId', { value: a.id });
      set('deliverableName', { value: parent.name });
      set('title', { value: a.title });
      set('date', { value: a.date });
      set('year', { value: yearLabel(a.yearId, owner) });
      set('org', { value: orgLabel(a.orgId, owner) });
      set('members', {
        value: a.memberIds.map((id) => memberLabel(id, owner) as string).join(GOAL_MEMBER_SEPARATOR),
      });
      set('evidenceUrl', { value: a.evidenceUrl });
      set('note', { value: a.note });
    },
    () => {}
  );

  // ── 측정이력 (기술목표 순서 → 기술목표 안 배열 순서)
  const rDef = sheets.records;
  const records = techTargets.flatMap((t) => t.records.map((r) => ({ parent: t, r })));
  const rBody = buildDataBody(
    rDef,
    records,
    (set, _cells, entry: { parent: TechTarget; r: TechTargetRecord } | null) => {
      if (entry === null) return;
      const { parent, r } = entry;
      const owner = `측정 이력 ${r.id}`;
      set('techTargetId', { value: parent.id });
      set('recordId', { value: r.id });
      set('techTargetName', { value: parent.name });
      set('value', { value: r.value });
      set('date', { value: r.date });
      set('year', { value: yearLabel(r.yearId, owner) });
      set('method', { value: goalEnumLabel('measureMethod', r.method) });
      set('evaluator', { value: r.evaluator });
      set('evidenceUrl', { value: r.evidenceUrl });
      set('note', { value: r.note });
    },
    () => {}
  );

  // ── _lists (F-9) — 열 하나에 목록 하나, 헤더 다음 행부터
  const listValues: Readonly<Record<GoalListKey, readonly string[]>> = {
    deliverableType: goalEnumLabels('deliverableType'),
    direction: goalEnumLabels('direction'),
    measureMethod: goalEnumLabels('measureMethod'),
    year: yearLabels,
    org: orgLabels,
    member: memberLabels,
  };
  const listsDef = sheets.lists;
  const listsBody = headerBody(listsDef as GoalSheetDef);
  const listLength = Math.max(0, ...Object.values(listValues).map((values) => values.length));
  for (let i = 0; i < listLength; i += 1) {
    listsBody.rows.push(listsDef.columns.map((column) => ({ value: listValues[column.role][i] ?? null })));
  }

  const lastDataRow: Readonly<Record<'deliverables' | 'techTargets', number>> = {
    deliverables: dBody.lastDataRow,
    techTargets: tBody.lastDataRow,
  };
  const resolve = (source: GoalListSource) =>
    source.kind === 'lists'
      ? goalListRange(sheets, source.list, listValues[source.list].length)
      : goalNameRange(sheets, source.sheet, lastDataRow[source.sheet]);

  // ── _meta (GF-1) — version은 내려받는 지금 값(S-5)
  assertUniqueIds('성과목표', deliverables.map((d) => d.id));
  assertUniqueIds('성과실적', achievements.map(({ a }) => a.id));
  assertUniqueIds('기술목표', techTargets.map((t) => t.id));
  assertUniqueIds('측정 이력', records.map(({ r }) => r.id));
  const meta: GoalFormMeta = {
    formVersion: GOAL_FORM_VERSION,
    projectId: data.project.id,
    generatedAt: data.generatedAt,
    years: years.map((y, i) => ({ id: y.id, label: yearLabels[i] as string })),
    orgs: data.orgs.map((o, i) => ({ id: o.id, label: orgLabels[i] as string })),
    members: data.members.map((m, i) => ({ id: m.id, label: memberLabels[i] as string })),
    deliverables: Object.fromEntries(deliverables.map((d) => [d.id, d.version])),
    achievements: Object.fromEntries(achievements.map(({ a }) => [a.id, a.version])),
    techTargets: Object.fromEntries(techTargets.map((t) => [t.id, t.version])),
    records: Object.fromEntries(records.map(({ r }) => [r.id, r.version])),
  };

  const built: Readonly<Record<GoalSheetKey, FormSheet>> = {
    guide: buildGoalGuideSheet(data.project.name, yearLabels, data.generatedAt),
    deliverables: dataSheet(dDef as GoalSheetDef, dBody, goalValidations(dDef as GoalSheetDef, resolve)),
    achievements: dataSheet(aDef as GoalSheetDef, aBody, goalValidations(aDef as GoalSheetDef, resolve)),
    techTargets: dataSheet(tDef as GoalSheetDef, tBody, goalValidations(tDef as GoalSheetDef, resolve)),
    records: dataSheet(rDef as GoalSheetDef, rBody, goalValidations(rDef as GoalSheetDef, resolve)),
    lists: {
      name: listsDef.name,
      hidden: listsDef.hidden,
      rows: listsBody.rows,
      hiddenColumns: goalHiddenColumns(listsDef as GoalSheetDef),
    },
    meta: {
      name: sheets.meta.name,
      hidden: sheets.meta.hidden,
      rows: buildGoalMetaRows(meta),
      hiddenColumns: goalHiddenColumns(sheets.meta as GoalSheetDef),
    },
  };

  return {
    sheets: orderedGoalSheets(sheets).map((def) => built[def.key]),
    fileName: goalFormFileName(data.project, data.generatedAt),
  };
}

/**
 * 같은 id가 두 번 실리면 `_meta`의 `Object.fromEntries`가 한쪽 version을 조용히 덮고, 다시 올리면
 * 한 행이 두 줄이라 `duplicate-row`가 된다 — 그런 파일을 내보내지 않는다.
 */
function assertUniqueIds(kind: string, ids: readonly string[]): void {
  const seen = new Set<string>();
  for (const id of ids) {
    if (seen.has(id)) throw new Error(`${kind} id(${id})가 두 번 실린다 — 양식을 만들 수 없다`);
    seen.add(id);
  }
}
