// 성과·기술목표 양식 파서 (SOT §6.17 GF-2~GF-10, 부록 C.3.4).
//
// 결과는 xlsx를 모르는 **행 모델**(`GoalFormRows`)이다 — Phase 22 hwpx(HX-8)도 격자에서 같은 모양을 만들어
// 미리보기·페이로드 생성기(T9)에 넣는다. 그래서 행 모델에는 셀·열 인덱스가 없고 앱 camelCase 값과 사유만 있다.
//
// 좌표는 헤더가 아니라 `_meta`에서 온다(GF-2): 연차 열은 `_meta.yearIds` 순서로 읽고 헤더 텍스트는 보지 않는다.
// 라벨(유형·방향·측정방법·연차·기관·관여자)은 완전 일치만(GF-3·GF-4) — 퍼지 매칭 없음.
// 버리는 행이 없다 — 빈 행·합계 행 말고는 전부 행 모델에 남고 문제는 행별 `issues`다(IN-6과 같은 태도).
// 합계 행 아래 행도 버리지 않고 `below-total` 오류 행으로 남긴다 — 읽는 범위(GF-8) 밖이지만 조용히 사라지면 안 된다.
//
// 여기서 판정하지 **않는** 것 (DB가 필요해 미리보기의 몫이다):
// - `duplicate-row`(GF-5, IN-10): 같은 숨김 id가 여러 행이면 투영 비교로 원본을 가려야 한다 — 행은 그대로 둔다
// - `parent-moved`의 DB 대조분: `_meta`에는 실적·측정 id → version만 있고 원래 부모가 없다
// - `conflict`: 현재 DB version이 필요하다
//
// xlsx·exceljs·supabase를 import하지 않는다.

import { DELIVERABLE_TYPE_DEFAULT_UNITS } from '@/lib/constants';
import { cellAt, cellText } from '@/lib/import/grid';
import type { RawCell, RawSheet } from '@/lib/import/types';
import { readExecutionDate } from '@/lib/input-form/parse-execution';
import type { DeliverableType, Direction, MeasureMethod } from '@/types';
import {
  GOAL_TOTAL_MARKER,
  goalColumnOf,
  goalEnumFromLabel,
  goalEnumLabel,
  goalSheetsFor,
  goalYearColumns,
} from './layout';
import type { GoalEnumCode, GoalFormSheets, GoalSheetDef } from './layout';
import { checkGoalMeta, goalMetaYearIds, goalMissingSheetRejection, parseGoalMeta } from './meta';
import type { GoalFormMeta, GoalFormRejection, GoalMetaLabel } from './types';
import { appendOriginalNote, combineHints, parseGoalValue } from './value';
import type { GoalValueHint, ParsedGoalValue } from './value';

// ─── 사유 표 ─────────────────────────────────────────────────

/**
 * 사유 코드·차단 여부·문구는 이 표 한 곳에서만 정한다(파서·미리보기 공용). 셀 값은 문구 뒤에 덧붙이기만 한다.
 * blocking이 1건이라도 있으면 반영 전체가 비활성이다(GF-5, S-21).
 */
export const GOAL_FORM_ISSUES = {
  // ── 파서: 셀·라벨 ──
  'cell-error': { message: '엑셀 오류 값이 있는 칸입니다', blocking: true },
  'unknown-label': { message: '목록에 없는 값입니다 — 드롭다운의 라벨을 그대로 쓰세요', blocking: true },
  'unknown-year': { message: '이 양식에 없는 연차입니다', blocking: true },
  'unknown-org': { message: '이 양식에 없는 기관입니다', blocking: true },
  'unknown-member': { message: '이 양식에 없는 관여자입니다', blocking: true },
  'unknown-id': {
    message: '이 양식에 없던 숨김 id입니다 — 다른 양식에서 복사한 행은 올릴 수 없습니다',
    blocking: true,
  },
  'missing-parent-id': {
    message: '기존 행의 숨김 부모 id가 비어 있습니다 — 숨김 열을 고치지 말고 다시 내려받으세요',
    blocking: true,
  },
  // ── 파서: 필수값·범위 (GF-9) ──
  'no-name': { message: '이름이 비어 있습니다', blocking: true },
  'no-type': { message: '유형이 비어 있습니다', blocking: true },
  'no-title': { message: '산출물명이 비어 있습니다', blocking: true },
  'no-date': { message: '날짜가 비어 있습니다', blocking: true },
  'invalid-date': { message: "날짜를 읽을 수 없습니다 — 날짜 서식 또는 'YYYY-MM-DD'로 적으세요", blocking: true },
  'no-value': { message: '측정값이 비어 있거나 숫자가 아닙니다', blocking: true },
  'no-target': { message: '연차별 목표와 최종 목표가 모두 비어 있습니다', blocking: true },
  'no-method': { message: '방법이 비어 있고 부모 기술목표의 측정방법도 정할 수 없습니다', blocking: true },
  'too-long': { message: '글자 수 상한을 넘었습니다', blocking: true },
  'negative-weight': { message: '가중치·비중은 0 이상이어야 합니다', blocking: true },
  'count-invalid': { message: '목표 건수는 0 이상 정수여야 합니다', blocking: true },
  // ── 파서: 행 범위 (GF-8) ──
  'below-total': {
    message: '합계 행 아래에 적은 행은 읽지 않습니다 — 합계 행 위에 행을 삽입해 적으세요',
    blocking: true,
  },
  // ── 파서: 숫자 해석 (GF-6·GF-7) — 경고 ──
  'unparsed-text': { message: '숫자 말고 다른 글자가 있어 첫 숫자만 썼습니다 — 원문은 비고에 남깁니다', blocking: false },
  'no-number': { message: '숫자를 찾지 못해 비워 둡니다 — 원문은 비고에 남깁니다', blocking: false },
  'hint-conflict': { message: '셀마다 방향 표시(이상·이하)가 달라 방향 열 값을 씁니다', blocking: false },
  'direction-overridden': { message: '목표 셀의 방향 표시가 방향 열과 달라 목표 셀을 따릅니다', blocking: false },
  'final-target-mismatch': {
    message: '최종 목표가 값이 있는 마지막 연차 목표와 다릅니다 — 최종 목표로 반영합니다',
    blocking: false,
  },
  'total-mismatch': { message: '전체 목표가 연차별 목표 합계와 다릅니다 — 전체 목표로 반영합니다', blocking: false },
  // ── 파서: 부모 연결 (GF-10) ──
  'parent-moved': {
    message: '기존 행의 부모를 바꿀 수 없습니다 — 옮기려면 그 행을 지우고 새 행으로 적으세요',
    blocking: true,
  },
  'ambiguous-parent': { message: '같은 이름이 둘 이상이라 부모를 정할 수 없습니다 — 이름을 서로 다르게 고치세요', blocking: true },
  'unknown-parent': { message: '같은 파일에 이 이름의 지표·기술목표가 없습니다', blocking: true },
  'orphan-child': {
    message: '시트에서 지운 지표·기술목표를 가리키는 행입니다 — 이 행도 지우거나 부모 행을 되살리세요',
    blocking: true,
  },
  // ── 미리보기(T9)가 쓴다 ──
  'duplicate-row': {
    message: '같은 숨김 id의 행이 여럿이고 원본을 가릴 수 없습니다 — 복사한 행의 숨김 id를 지우세요',
    blocking: true,
  },
  'weight-sum': { message: '가중치·비중 합계가 100이 아닙니다', blocking: false },
  conflict: { message: '양식을 받은 뒤 다른 곳에서 바뀌었거나 삭제된 행이라 건너뜁니다', blocking: false },
} as const satisfies Record<string, { message: string; blocking: boolean }>;

export type GoalFormIssueKind = keyof typeof GOAL_FORM_ISSUES;

export interface GoalFormIssue {
  kind: GoalFormIssueKind;
  /** 표 문구 + (있으면) `: {셀 값·열}` */
  message: string;
  blocking: boolean;
}

export function goalFormIssue(kind: GoalFormIssueKind, detail?: string): GoalFormIssue {
  const def = GOAL_FORM_ISSUES[kind];
  return { kind, message: detail === undefined ? def.message : `${def.message}: ${detail}`, blocking: def.blocking };
}

/** 문자열 길이 상한 — 화면 CRUD(`actions/goals.ts` Zod)와 같다(GF-9) */
export const GOAL_FORM_MAX_LENGTH = {
  name: 200,
  title: 300,
  unit: 20,
  group: 200,
  worldBestHolder: 200,
  evaluator: 200,
  evidenceUrl: 2000,
  longText: 10_000,
  note: 10_000,
} as const;

// ─── 행 모델 (xlsx 무관 — Phase 22 hwpx도 이 모양을 만든다) ─────

/** 실적·측정 행의 부모. 기존 부모는 id, 같은 파일에서 새로 적은 부모는 그 시트 행 번호(RPC 임시 키 `row:<n>`) */
export type GoalParentRef = { kind: 'existing'; id: string } | { kind: 'new'; row: number };

/** 연차 목표. `_meta.yearIds` 전부가 키이고 빈 칸은 null(= RPC가 그 키를 지운다, S-13) */
export type GoalYearTargets = Record<string, number | null>;

interface GoalFormRowBase {
  /** 1-based 시트 행 번호. 사용자 메시지·새 부모 임시 키 */
  sheetRow: number;
  /** 숨김 id. 없으면 새 행 */
  id: string | null;
  /** GF-6 원문 줄까지 붙인 비고 */
  note: string;
  issues: GoalFormIssue[];
}

/** 값이 null인 필드는 그 칸이 blocking 오류라 쓸 수 없다는 뜻이다(빈 칸 기본값은 이미 채웠다 — GF-9) */
export interface GoalFormDeliverableRow extends GoalFormRowBase {
  type: DeliverableType | null;
  name: string;
  unit: string;
  weight: number | null;
  targetTotal: number | null;
  targetByYear: GoalYearTargets;
  orgId: string | null;
  evidenceMethod: string;
}

export interface GoalFormAchievementRow extends GoalFormRowBase {
  /** 지표명 열 원문(trim) — 미리보기가 DB 부모 이름과 대조할 때 쓴다 */
  parentName: string;
  /** 부모를 정하지 못했으면 null(issues에 사유) */
  parent: GoalParentRef | null;
  title: string;
  date: string | null;
  yearId: string | null;
  orgId: string | null;
  memberIds: string[];
  evidenceUrl: string;
}

export interface GoalFormTechTargetRow extends GoalFormRowBase {
  group: string;
  name: string;
  unit: string;
  direction: Direction | null;
  weight: number | null;
  targetValue: number | null;
  targetByYear: GoalYearTargets;
  baselineDomestic: number | null;
  worldBest: number | null;
  worldBestHolder: string;
  measureMethod: MeasureMethod | null;
  measureDescription: string;
  standardBasis: string;
  basisRationale: string;
  evaluationEnvironment: string;
  orgId: string | null;
}

export interface GoalFormRecordRow extends GoalFormRowBase {
  /** 평가항목 열 원문(trim) */
  parentName: string;
  parent: GoalParentRef | null;
  value: number | null;
  date: string | null;
  yearId: string | null;
  /** 빈 칸이면 부모 기술목표의 measureMethod(GF-9). 부모를 못 찾았으면 null */
  method: MeasureMethod | null;
  evaluator: string;
  evidenceUrl: string;
}

export interface GoalFormRows {
  deliverables: GoalFormDeliverableRow[];
  achievements: GoalFormAchievementRow[];
  techTargets: GoalFormTechTargetRow[];
  records: GoalFormRecordRow[];
}

export type ParseGoalFormResult =
  | { ok: false; rejection: GoalFormRejection }
  | { ok: true; meta: GoalFormMeta; rows: GoalFormRows };

// ─── 셀 읽기 ─────────────────────────────────────────────────

type Cells = readonly (readonly RawCell[])[];

interface RowReader {
  cells: Cells;
  /** 0-based */
  r: number;
  issues: GoalFormIssue[];
}

/** 에러 셀은 오류로 남기고 빈 칸으로 읽는다 — 원문(`#REF!`)을 값으로 쓰지 않는다 */
function readText(rr: RowReader, column: number, label: string): string {
  const cell = cellAt(rr.cells, rr.r, column);
  if (cell.isError) {
    rr.issues.push(goalFormIssue('cell-error', `${label}: ${cellText(cell)}`));
    return '';
  }
  return cellText(cell);
}

function checkLength(rr: RowReader, text: string, label: string, max: number): void {
  if (text.length > max) rr.issues.push(goalFormIssue('too-long', `${label} ${text.length}자 (최대 ${max}자)`));
}

function readLimited(rr: RowReader, column: number, label: string, max: number): string {
  const text = readText(rr, column, label);
  checkLength(rr, text, label, max);
  return text;
}

/** GF-6 대상 셀의 원시 값. 숫자형 셀은 숫자 그대로 넘겨 문자열 해석을 건너뛴다 */
function rawValue(rr: RowReader, column: number, label: string): string | number | null {
  const cell = cellAt(rr.cells, rr.r, column);
  if (cell.isError) {
    rr.issues.push(goalFormIssue('cell-error', `${label}: ${cellText(cell)}`));
    return null;
  }
  const value = cell.value;
  if (value === null || value === undefined) return null;
  if (typeof value === 'number' || typeof value === 'string') return value;
  return String(value);
}

/** 비고에 원문 줄을 쌓아 가는 누적기 — 경고 사유와 원문 줄이 항상 짝을 이룬다(GF-6) */
interface NoteAcc {
  note: string;
}

function readGoalNumber(
  rr: RowReader,
  acc: NoteAcc,
  column: number,
  label: string,
  unit: string
): ParsedGoalValue {
  const parsed = parseGoalValue(rawValue(rr, column, label), unit);
  if (parsed.warning !== null && parsed.original !== null) {
    rr.issues.push(goalFormIssue(parsed.warning, `${label}: ${parsed.original}`));
    acc.note = appendOriginalNote(acc.note, label, parsed.original);
  }
  return parsed;
}

/** 가중치·비중: 빈 칸(또는 숫자 없음) = 0, 음수 = 오류(GF-9, DB check `weight >= 0`) */
function readWeight(rr: RowReader, acc: NoteAcc, column: number, label: string): number | null {
  const { value } = readGoalNumber(rr, acc, column, label, '');
  if (value === null) return 0;
  if (value < 0) {
    rr.issues.push(goalFormIssue('negative-weight', `${label}: ${value}`));
    return null;
  }
  return value;
}

/** 성과목표 건수: 비면 null(호출부가 정한다), 0 이상 정수가 아니면 오류(GF-6, DB integer) */
function readCount(rr: RowReader, acc: NoteAcc, column: number, label: string, unit: string): number | null | 'invalid' {
  const { value } = readGoalNumber(rr, acc, column, label, unit);
  if (value === null) return null;
  if (!Number.isInteger(value) || value < 0) {
    rr.issues.push(goalFormIssue('count-invalid', `${label}: ${value}`));
    return 'invalid';
  }
  return value;
}

function readDate(rr: RowReader, column: number, label: string): string | null {
  const read = readExecutionDate(cellAt(rr.cells, rr.r, column));
  if (read.kind === 'empty') {
    rr.issues.push(goalFormIssue('no-date', label));
    return null;
  }
  if (read.kind === 'invalid') {
    rr.issues.push(goalFormIssue('invalid-date', `${label}: ${read.text}`));
    return null;
  }
  return read.iso;
}

/** `_meta` 라벨 → id 조회표. 라벨은 `_meta`에서 겹치지 않음이 보장된다(parseGoalMeta) */
function labelIndex(entries: readonly GoalMetaLabel[]): ReadonlyMap<string, string> {
  return new Map(entries.map((entry) => [entry.label.trim(), entry.id]));
}

interface Lookups {
  meta: GoalFormMeta;
  yearIds: readonly string[];
  years: ReadonlyMap<string, string>;
  orgs: ReadonlyMap<string, string>;
  members: ReadonlyMap<string, string>;
}

function readLabelRef(
  rr: RowReader,
  column: number,
  label: string,
  index: ReadonlyMap<string, string>,
  kind: 'unknown-year' | 'unknown-org'
): string | null {
  const text = readText(rr, column, label);
  if (text === '') return null;
  const id = index.get(text);
  if (id === undefined) {
    rr.issues.push(goalFormIssue(kind, text));
    return null;
  }
  return id;
}

/** 관여자: `;`로 여러 명(GF-4). 빈 조각은 무시하고 겹친 이름은 한 번만. 이름마다 `_meta` 완전 일치 */
function readMembers(rr: RowReader, column: number, label: string, index: ReadonlyMap<string, string>): string[] {
  const text = readText(rr, column, label);
  const names = [...new Set(text.split(';').map((part) => part.trim()).filter((part) => part !== ''))];
  const ids: string[] = [];
  const unknown: string[] = [];
  for (const name of names) {
    const id = index.get(name);
    if (id === undefined) unknown.push(name);
    else if (!ids.includes(id)) ids.push(id);
  }
  if (unknown.length > 0) rr.issues.push(goalFormIssue('unknown-member', unknown.join(', ')));
  return ids;
}

function readEnum<K extends 'deliverableType' | 'direction' | 'measureMethod'>(
  rr: RowReader,
  column: number,
  label: string,
  kind: K
): { empty: boolean; code: GoalEnumCode<K> | null } {
  const text = readText(rr, column, label);
  if (text === '') return { empty: true, code: null };
  const code = goalEnumFromLabel(kind, text);
  if (code === null) rr.issues.push(goalFormIssue('unknown-label', `${label}: ${text}`));
  return { empty: false, code };
}

/** 숨김 id. `_meta` 목록 밖이면 경계 오류(N-13) — 행은 버리지 않고 오류 행으로 남긴다 */
function readHiddenId(rr: RowReader, column: number, known: Readonly<Record<string, number>>, label: string): string | null {
  const text = cellText(cellAt(rr.cells, rr.r, column));
  if (text === '') return null;
  if (!Object.hasOwn(known, text)) rr.issues.push(goalFormIssue('unknown-id', `${label}: ${text}`));
  return text;
}

// ─── 행 범위 ─────────────────────────────────────────────────

/** 합계 행(숨김 id 열에 `#total`, GF-8)인가 */
function isTotalRow(def: GoalSheetDef, cells: Cells, r: number): boolean {
  return def.columns.some((column, index) => column.hidden && cellText(cellAt(cells, r, index)) === GOAL_TOTAL_MARKER);
}

/** 사용자 열(보이는 읽는 열)이 전부 비었나. 숨김 id만 남은 행도 빈 행이다 — 양식에서 지운 행이다(GF-9) */
function isBlankRow(def: GoalSheetDef, cells: Cells, r: number): boolean {
  return def.columns.every(
    (column, index) => column.hidden || !column.read || cellText(cellAt(cells, r, index)) === ''
  );
}

interface DataRow {
  /** 0-based */
  r: number;
  /** 첫 합계 행보다 아래 — GF-8 읽는 범위 밖 */
  belowTotal: boolean;
}

/**
 * 읽을 행(0-based). 읽는 범위는 헤더 다음 행 ~ 첫 합계 행 직전이다(GF-8). 그 아래에 사용자 열 값이 있는 행은
 * 조용히 버리지 않고 `belowTotal`로 돌려준다 — 호출부가 blocking 사유를 단 오류 행으로 남긴다(절대 규칙 5).
 */
function dataRows(def: GoalSheetDef, sheet: RawSheet): DataRow[] {
  const out: DataRow[] = [];
  let belowTotal = false;
  for (let r = def.dataStartRow - 1; r < sheet.cells.length; r += 1) {
    if (isTotalRow(def, sheet.cells, r)) {
      belowTotal = true;
      continue;
    }
    if (isBlankRow(def, sheet.cells, r)) continue;
    out.push({ r, belowTotal });
  }
  return out;
}

function rowReader(cells: Cells, row: DataRow): RowReader {
  const rr: RowReader = { cells, r: row.r, issues: [] };
  if (row.belowTotal) rr.issues.push(goalFormIssue('below-total', `${row.r + 1}행`));
  return rr;
}

function yearTargetsFrom(yearIds: readonly string[], values: readonly (number | null)[]): GoalYearTargets {
  const out: GoalYearTargets = {};
  yearIds.forEach((id, i) => {
    out[id] = values[i] ?? null;
  });
  return out;
}

// ─── 성과목표 ────────────────────────────────────────────────

function parseDeliverables(def: GoalFormSheets['deliverables'], sheet: RawSheet, lk: Lookups): GoalFormDeliverableRow[] {
  const col = {
    id: goalColumnOf(def, 'deliverableId'),
    type: goalColumnOf(def, 'type'),
    name: goalColumnOf(def, 'name'),
    unit: goalColumnOf(def, 'unit'),
    weight: goalColumnOf(def, 'weight'),
    targetTotal: goalColumnOf(def, 'targetTotal'),
    years: goalYearColumns(def),
    org: goalColumnOf(def, 'org'),
    evidenceMethod: goalColumnOf(def, 'evidenceMethod'),
    note: goalColumnOf(def, 'note'),
  };
  const label = (index: number): string => def.columns[index]?.label ?? '';

  return dataRows(def, sheet).map((row) => {
    const rr = rowReader(sheet.cells, row);
    const r = row.r;
    const id = readHiddenId(rr, col.id, lk.meta.deliverables, 'deliverableId');

    const type = readEnum(rr, col.type, label(col.type), 'deliverableType');
    if (type.empty) rr.issues.push(goalFormIssue('no-type'));
    const name = readLimited(rr, col.name, label(col.name), GOAL_FORM_MAX_LENGTH.name);
    if (name === '') rr.issues.push(goalFormIssue('no-name', label(col.name)));

    let unit = readLimited(rr, col.unit, label(col.unit), GOAL_FORM_MAX_LENGTH.unit);
    // GF-9: 단위가 비면 그 유형의 기본 단위(부록 A.2)
    if (unit === '' && type.code !== null) unit = DELIVERABLE_TYPE_DEFAULT_UNITS[type.code];

    const acc: NoteAcc = { note: readText(rr, col.note, label(col.note)) };
    const weight = readWeight(rr, acc, col.weight, label(col.weight));
    const total = readCount(rr, acc, col.targetTotal, label(col.targetTotal), unit);
    const yearReads = col.years.map((column) => readCount(rr, acc, column, label(column), unit));
    const yearValues = yearReads.map((v) => (v === 'invalid' ? null : v));

    // GF-7: 전체 목표가 비면 Σ연차(빈 칸 제외). 둘 다 있고 다르면 D-3 경고 — 저장은 전체 목표로
    let targetTotal: number | null = null;
    if (total !== 'invalid') {
      const sum = yearValues.reduce<number>((acc2, v) => acc2 + (v ?? 0), 0);
      const anyYear = yearValues.some((v) => v !== null);
      if (total === null) targetTotal = sum;
      else {
        targetTotal = total;
        if (anyYear && !yearReads.includes('invalid') && total !== sum) {
          rr.issues.push(goalFormIssue('total-mismatch', `전체 ${total} · 연차 합계 ${sum}`));
        }
      }
    }

    const orgId = readLabelRef(rr, col.org, label(col.org), lk.orgs, 'unknown-org');
    const evidenceMethod = readLimited(rr, col.evidenceMethod, label(col.evidenceMethod), GOAL_FORM_MAX_LENGTH.longText);
    checkLength(rr, acc.note, label(col.note), GOAL_FORM_MAX_LENGTH.note);

    return {
      sheetRow: r + 1,
      id,
      type: type.code,
      name,
      unit,
      weight,
      targetTotal,
      targetByYear: yearTargetsFrom(lk.yearIds, yearValues),
      orgId,
      evidenceMethod,
      note: acc.note,
      issues: rr.issues,
    };
  });
}

// ─── 기술목표 ────────────────────────────────────────────────

function parseTechTargets(def: GoalFormSheets['techTargets'], sheet: RawSheet, lk: Lookups): GoalFormTechTargetRow[] {
  const col = {
    id: goalColumnOf(def, 'techTargetId'),
    group: goalColumnOf(def, 'group'),
    name: goalColumnOf(def, 'name'),
    unit: goalColumnOf(def, 'unit'),
    direction: goalColumnOf(def, 'direction'),
    weight: goalColumnOf(def, 'weight'),
    years: goalYearColumns(def),
    targetValue: goalColumnOf(def, 'targetValue'),
    baselineDomestic: goalColumnOf(def, 'baselineDomestic'),
    worldBest: goalColumnOf(def, 'worldBest'),
    worldBestHolder: goalColumnOf(def, 'worldBestHolder'),
    measureMethod: goalColumnOf(def, 'measureMethod'),
    measureDescription: goalColumnOf(def, 'measureDescription'),
    standardBasis: goalColumnOf(def, 'standardBasis'),
    basisRationale: goalColumnOf(def, 'basisRationale'),
    evaluationEnvironment: goalColumnOf(def, 'evaluationEnvironment'),
    org: goalColumnOf(def, 'org'),
    note: goalColumnOf(def, 'note'),
  };
  const label = (index: number): string => def.columns[index]?.label ?? '';
  const max = GOAL_FORM_MAX_LENGTH;

  return dataRows(def, sheet).map((row) => {
    const rr = rowReader(sheet.cells, row);
    const r = row.r;
    const id = readHiddenId(rr, col.id, lk.meta.techTargets, 'techTargetId');

    const group = readLimited(rr, col.group, label(col.group), max.group);
    const name = readLimited(rr, col.name, label(col.name), max.name);
    if (name === '') rr.issues.push(goalFormIssue('no-name', label(col.name)));
    const unit = readLimited(rr, col.unit, label(col.unit), max.unit);

    const directionRead = readEnum(rr, col.direction, label(col.direction), 'direction');
    const acc: NoteAcc = { note: readText(rr, col.note, label(col.note)) };
    const weight = readWeight(rr, acc, col.weight, label(col.weight));

    const years = col.years.map((column) => readGoalNumber(rr, acc, column, label(column), unit));
    const final = readGoalNumber(rr, acc, col.targetValue, label(col.targetValue), unit);

    // GF-6: 방향 힌트는 연차별·최종 목표 셀에서만. 힌트가 있으면 방향 열보다 우선한다
    const hints: (GoalValueHint | null)[] = [...years.map((y) => y.hint), final.hint];
    const combined = combineHints(hints);
    if (combined.conflict) rr.issues.push(goalFormIssue('hint-conflict'));
    let direction: Direction | null;
    if (directionRead.empty) {
      // 방향 열이 비었는데 셀이 `≤10`이면 그대로 따른다 — 사용자가 적은 값과 다를 것이 없으므로 경고하지 않는다
      direction = combined.hint ?? 'higher_better';
    } else if (directionRead.code === null) {
      direction = null;
    } else {
      direction = combined.hint ?? directionRead.code;
      if (combined.hint !== null && combined.hint !== directionRead.code) {
        rr.issues.push(goalFormIssue('direction-overridden', `${goalEnumLabel('direction', directionRead.code)} → ${goalEnumLabel('direction', combined.hint)}`));
      }
    }

    // GF-7: 최종 목표가 비면 값 있는 마지막 연차(yearIds 순). 둘 다 비면 반영 불가
    const yearValues = years.map((y) => y.value);
    const lastYear = [...yearValues].reverse().find((v): v is number => v !== null) ?? null;
    let targetValue: number | null = final.value;
    if (targetValue === null) {
      targetValue = lastYear;
      if (lastYear === null) rr.issues.push(goalFormIssue('no-target'));
    } else if (lastYear !== null && lastYear !== targetValue) {
      rr.issues.push(goalFormIssue('final-target-mismatch', `최종 ${targetValue} · 마지막 연차 ${lastYear}`));
    }

    const baselineDomestic = readGoalNumber(rr, acc, col.baselineDomestic, label(col.baselineDomestic), unit).value;
    const worldBest = readGoalNumber(rr, acc, col.worldBest, label(col.worldBest), unit).value;
    const worldBestHolder = readLimited(rr, col.worldBestHolder, label(col.worldBestHolder), max.worldBestHolder);

    const methodRead = readEnum(rr, col.measureMethod, label(col.measureMethod), 'measureMethod');
    // GF-9: 측정방법이 비면 자체측정
    const measureMethod: MeasureMethod | null = methodRead.empty ? 'self' : methodRead.code;

    const measureDescription = readLimited(rr, col.measureDescription, label(col.measureDescription), max.note);
    const standardBasis = readLimited(rr, col.standardBasis, label(col.standardBasis), max.longText);
    const basisRationale = readLimited(rr, col.basisRationale, label(col.basisRationale), max.longText);
    const evaluationEnvironment = readLimited(
      rr, col.evaluationEnvironment, label(col.evaluationEnvironment), max.longText
    );
    const orgId = readLabelRef(rr, col.org, label(col.org), lk.orgs, 'unknown-org');
    checkLength(rr, acc.note, label(col.note), max.note);

    return {
      sheetRow: r + 1,
      id,
      group,
      name,
      unit,
      direction,
      weight,
      targetValue,
      targetByYear: yearTargetsFrom(lk.yearIds, yearValues),
      baselineDomestic,
      worldBest,
      worldBestHolder,
      measureMethod,
      measureDescription,
      standardBasis,
      basisRationale,
      evaluationEnvironment,
      orgId,
      note: acc.note,
      issues: rr.issues,
    };
  });
}

// ─── 부모 연결 (GF-10) ───────────────────────────────────────

interface ParentRow {
  sheetRow: number;
  id: string | null;
  name: string;
}

/**
 * 실적·측정 행의 부모.
 * - 기존 행(자기 숨김 id 있음): 숨김 부모 id가 기준이다. 부모 id가 `_meta`에 있는데 시트에 없으면 `orphan-child`
 *   (지운 부모 — S-6①). 이름 열이 **같은 파일 부모 시트의 다른 행** 이름과 정확히 같을 때만 `parent-moved`이고,
 *   그 밖(부모 이름만 고침·옛 이름·빈 칸·어느 부모와도 안 맞음)은 사유 없이 숨김 id를 따른다.
 * - 새 행: 이름 열을 같은 파일 부모 시트 이름과 완전 일치로 찾는다 — 0개 `unknown-parent`, 2개 이상 `ambiguous-parent`.
 */
function resolveParent(
  rr: RowReader,
  ownId: string | null,
  parentIdText: string,
  parentName: string,
  parents: readonly ParentRow[],
  knownParents: Readonly<Record<string, number>>,
  parentIdLabel: string
): GoalParentRef | null {
  if (parentIdText !== '' && !Object.hasOwn(knownParents, parentIdText)) {
    rr.issues.push(goalFormIssue('unknown-id', `${parentIdLabel}: ${parentIdText}`));
    if (ownId !== null) return null;
  }

  if (ownId !== null) {
    if (parentIdText === '') {
      rr.issues.push(goalFormIssue('missing-parent-id', parentIdLabel));
      return null;
    }
    const onSheet = parents.filter((p) => p.id === parentIdText);
    if (onSheet.length === 0) {
      rr.issues.push(goalFormIssue('orphan-child', parentName === '' ? parentIdText : parentName));
      return null;
    }
    // 옮기려는 뜻이 드러날 때만 막는다 — 다른 부모 행의 이름과 정확히 같을 때. 부모 이름만 고쳤거나 옛 이름·빈 칸이면
    // 숨김 id를 따른다(실적 딸린 지표의 이름 변경이 막히면 안 된다)
    const movedTo =
      parentName === '' || onSheet.some((p) => p.name === parentName)
        ? undefined
        : parents.find((p) => p.id !== parentIdText && p.name === parentName);
    if (movedTo !== undefined) {
      rr.issues.push(goalFormIssue('parent-moved', `${onSheet[0]?.name ?? ''} → ${parentName} (${movedTo.sheetRow}행)`));
      return null;
    }
    return { kind: 'existing', id: parentIdText };
  }

  const matches = parents.filter((p) => p.name !== '' && p.name === parentName);
  if (matches.length === 0) {
    rr.issues.push(goalFormIssue('unknown-parent', parentName === '' ? '(비어 있음)' : parentName));
    return null;
  }
  if (matches.length > 1) {
    rr.issues.push(goalFormIssue('ambiguous-parent', `${parentName} (${matches.map((m) => `${m.sheetRow}행`).join(', ')})`));
    return null;
  }
  const match = matches[0] as ParentRow;
  return match.id === null ? { kind: 'new', row: match.sheetRow } : { kind: 'existing', id: match.id };
}

function findParent<T extends { sheetRow: number; id: string | null }>(
  rows: readonly T[],
  ref: GoalParentRef | null
): T | undefined {
  if (ref === null) return undefined;
  return ref.kind === 'existing' ? rows.find((row) => row.id === ref.id) : rows.find((row) => row.sheetRow === ref.row);
}

// ─── 성과실적 ────────────────────────────────────────────────

function parseAchievements(
  def: GoalFormSheets['achievements'],
  sheet: RawSheet,
  lk: Lookups,
  deliverables: readonly GoalFormDeliverableRow[]
): GoalFormAchievementRow[] {
  const col = {
    parentId: goalColumnOf(def, 'deliverableId'),
    id: goalColumnOf(def, 'achievementId'),
    parentName: goalColumnOf(def, 'deliverableName'),
    title: goalColumnOf(def, 'title'),
    date: goalColumnOf(def, 'date'),
    year: goalColumnOf(def, 'year'),
    org: goalColumnOf(def, 'org'),
    members: goalColumnOf(def, 'members'),
    evidenceUrl: goalColumnOf(def, 'evidenceUrl'),
    note: goalColumnOf(def, 'note'),
  };
  const label = (index: number): string => def.columns[index]?.label ?? '';
  const parents: ParentRow[] = deliverables.map((d) => ({ sheetRow: d.sheetRow, id: d.id, name: d.name }));

  return dataRows(def, sheet).map((row) => {
    const rr = rowReader(sheet.cells, row);
    const r = row.r;
    const id = readHiddenId(rr, col.id, lk.meta.achievements, 'achievementId');
    const parentIdText = cellText(cellAt(sheet.cells, r, col.parentId));
    const parentName = readText(rr, col.parentName, label(col.parentName));
    const parent = resolveParent(rr, id, parentIdText, parentName, parents, lk.meta.deliverables, 'deliverableId');

    const title = readLimited(rr, col.title, label(col.title), GOAL_FORM_MAX_LENGTH.title);
    if (title === '') rr.issues.push(goalFormIssue('no-title'));
    const date = readDate(rr, col.date, label(col.date));
    const yearId = readLabelRef(rr, col.year, label(col.year), lk.years, 'unknown-year');
    const orgId = readLabelRef(rr, col.org, label(col.org), lk.orgs, 'unknown-org');
    const memberIds = readMembers(rr, col.members, label(col.members), lk.members);
    const evidenceUrl = readLimited(rr, col.evidenceUrl, label(col.evidenceUrl), GOAL_FORM_MAX_LENGTH.evidenceUrl);
    const note = readLimited(rr, col.note, label(col.note), GOAL_FORM_MAX_LENGTH.note);

    return {
      sheetRow: r + 1,
      id,
      parentName,
      parent,
      title,
      date,
      yearId,
      orgId,
      memberIds,
      evidenceUrl,
      note,
      issues: rr.issues,
    };
  });
}

// ─── 측정이력 ────────────────────────────────────────────────

function parseRecords(
  def: GoalFormSheets['records'],
  sheet: RawSheet,
  lk: Lookups,
  techTargets: readonly GoalFormTechTargetRow[]
): GoalFormRecordRow[] {
  const col = {
    parentId: goalColumnOf(def, 'techTargetId'),
    id: goalColumnOf(def, 'recordId'),
    parentName: goalColumnOf(def, 'techTargetName'),
    value: goalColumnOf(def, 'value'),
    date: goalColumnOf(def, 'date'),
    year: goalColumnOf(def, 'year'),
    method: goalColumnOf(def, 'method'),
    evaluator: goalColumnOf(def, 'evaluator'),
    evidenceUrl: goalColumnOf(def, 'evidenceUrl'),
    note: goalColumnOf(def, 'note'),
  };
  const label = (index: number): string => def.columns[index]?.label ?? '';
  const parents: ParentRow[] = techTargets.map((t) => ({ sheetRow: t.sheetRow, id: t.id, name: t.name }));

  return dataRows(def, sheet).map((row) => {
    const rr = rowReader(sheet.cells, row);
    const r = row.r;
    const id = readHiddenId(rr, col.id, lk.meta.records, 'recordId');
    const parentIdText = cellText(cellAt(sheet.cells, r, col.parentId));
    const parentName = readText(rr, col.parentName, label(col.parentName));
    const parent = resolveParent(rr, id, parentIdText, parentName, parents, lk.meta.techTargets, 'techTargetId');
    const parentRow = findParent(techTargets, parent);

    const acc: NoteAcc = { note: readText(rr, col.note, label(col.note)) };
    // 측정값의 단위 접미는 부모 기술목표의 단위다(GF-6)
    const value = readGoalNumber(rr, acc, col.value, label(col.value), parentRow?.unit ?? '').value;
    // DB 기본값 0이 실적치로 굳으면 달성률이 조용히 틀린다(actions/goals.ts) — 비면 반영 불가
    if (value === null) rr.issues.push(goalFormIssue('no-value', label(col.value)));
    const date = readDate(rr, col.date, label(col.date));
    const yearId = readLabelRef(rr, col.year, label(col.year), lk.years, 'unknown-year');

    const methodRead = readEnum(rr, col.method, label(col.method), 'measureMethod');
    // GF-9: 방법이 비면 그 기술목표의 measureMethod
    const method: MeasureMethod | null = methodRead.empty ? (parentRow?.measureMethod ?? null) : methodRead.code;
    // 부모를 못 정했으면 resolveParent가 이미 막았다. 부모는 정했는데 그 측정방법이 오류(모르는 라벨)라 상속할 값이
    // 없으면 여기서 막는다 — 사유 없는 null이 미리보기까지 가면 안 된다
    if (methodRead.empty && method === null && parent !== null) {
      const detail = parentRow === undefined ? parentName : `${parentRow.sheetRow}행 ${parentRow.name}`;
      rr.issues.push(goalFormIssue('no-method', detail));
    }

    const evaluator = readLimited(rr, col.evaluator, label(col.evaluator), GOAL_FORM_MAX_LENGTH.evaluator);
    const evidenceUrl = readLimited(rr, col.evidenceUrl, label(col.evidenceUrl), GOAL_FORM_MAX_LENGTH.evidenceUrl);
    checkLength(rr, acc.note, label(col.note), GOAL_FORM_MAX_LENGTH.note);

    return {
      sheetRow: r + 1,
      id,
      parentName,
      parent,
      value,
      date,
      yearId,
      method,
      evaluator,
      evidenceUrl,
      note: acc.note,
      issues: rr.issues,
    };
  });
}

// ─── 진입점 ──────────────────────────────────────────────────

// `_meta` 시트 이름은 연차 수와 무관하다
const META_SHEET_NAME = goalSheetsFor(0).meta.name;

function findSheet(sheets: readonly RawSheet[], name: string): RawSheet | undefined {
  return sheets.find((sheet) => sheet.name === name);
}

/**
 * 워크북(어댑터가 만든 RawSheet 목록) → 행 모델. 순서: `_meta` 거부(GF-2: 형식 → 과제 → 버전 → 본문)
 * → 데이터 시트 4개 존재 → 부모 시트(성과목표·기술목표) → 자식 시트(부모 이름을 알아야 GF-10을 판정한다).
 * 미리보기와 반영이 이 함수 하나를 탄다(IN-6).
 */
export function parseGoalForm(sheets: readonly RawSheet[], expected: { projectId: string }): ParseGoalFormResult {
  const check = checkGoalMeta(parseGoalMeta(findSheet(sheets, META_SHEET_NAME)), expected);
  if (!check.ok) return check;
  const meta = check.meta;

  // 헤더 라벨 대신 `_meta` 라벨로 맵을 만든다 — 좌표는 연차 수로만 정해지고, 열 라벨은 원문 비고·사유 문구에 쓴다
  const defs = goalSheetsFor(meta.years.map((year) => year.label));
  const found = {
    deliverables: findSheet(sheets, defs.deliverables.name),
    achievements: findSheet(sheets, defs.achievements.name),
    techTargets: findSheet(sheets, defs.techTargets.name),
    records: findSheet(sheets, defs.records.name),
  };
  for (const key of ['deliverables', 'achievements', 'techTargets', 'records'] as const) {
    if (found[key] === undefined) return { ok: false, rejection: goalMissingSheetRejection(defs[key].name) };
  }
  const { deliverables: dSheet, achievements: aSheet, techTargets: tSheet, records: rSheet } = found as Record<
    keyof typeof found,
    RawSheet
  >;

  const lk: Lookups = {
    meta,
    yearIds: goalMetaYearIds(meta),
    years: labelIndex(meta.years),
    orgs: labelIndex(meta.orgs),
    members: labelIndex(meta.members),
  };

  const deliverables = parseDeliverables(defs.deliverables, dSheet, lk);
  const techTargets = parseTechTargets(defs.techTargets, tSheet, lk);
  return {
    ok: true,
    meta,
    rows: {
      deliverables,
      achievements: parseAchievements(defs.achievements, aSheet, lk, deliverables),
      techTargets,
      records: parseRecords(defs.records, rSheet, lk, techTargets),
    },
  };
}
