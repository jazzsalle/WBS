// 계획서 표 식별·헤더·잇기·열 역할 (SOT §6.18 HX-3·HX-4, 부록 C.3.1·C.3.5, S-1·S-2·S-3·S-14·S-28, U-1·U-2·U-5·U-8).
//
// 클라이언트(전송할 표 고르기)와 서버(행 해석 전 표 정리)가 같은 코드를 쓴다 — lib/goal-form을 import하지 않고
// DOM·Node 전역을 쓰지 않는다(S-33). 입력 격자는 읽기만 한다.

import {
  HWPX_DELIVERABLE_COLUMN_ROLES,
  HWPX_METHOD_COLUMN_ROLES,
  HWPX_TABLE_SIGNATURES,
  HWPX_TECH_COLUMN_ROLES,
  HWPX_YEAR_COLUMN_PATTERN,
  type HwpxColumnRoleDef,
  type HwpxDeliverableColumnRole,
  type HwpxMethodColumnRole,
  type HwpxTechColumnRole,
} from '@/lib/constants';
import { normalizeLabel } from '@/lib/import/normalize';
import { PLAN_TABLE_LABELS, duplicateTableIssue, planIssue, type PlanIssue } from './issues';
import type { HwpxExtractResult, HwpxTable, PlanTableKind } from './types';

// ─── 결과 타입 ───────────────────────────────────────────────

export interface TechColumns {
  /** 번호 붙은 평가항목명 열(U-1) */
  name: number | null;
  unit: number | null;
  weight: number | null;
  /** 연차 열, 왼쪽부터(= 1차년도, 2차년도… 표기 순) */
  year: number[];
  measureMethod: number | null;
  org: number | null;
}

export interface DeliverableColumns {
  category: number | null;
  /** `항목` 열 전부, 왼쪽부터(U-6 지표명은 이 열들을 잇는다) */
  item: number[];
  unit: number | null;
  weight: number | null;
  year: number[];
  total: number | null;
  evidenceMethod: number | null;
}

export interface MethodColumns {
  seq: number | null;
  name: number | null;
  measureDescription: number | null;
  evaluationEnvironment: number | null;
}

export interface UnreadColumn {
  col: number;
  /** 머리행 원문(개행 → 공백). 두 머리행이 다르면 `위 / 아래` */
  header: string;
  /** ignored = 읽지 않기로 정한 열(U-2), unknown = 역할 라벨이 없음, duplicate = 같은 역할의 다른 열이 먼저 잡힘 */
  reason: 'ignored' | 'unknown' | 'duplicate';
}

interface PlanTableBase<K extends PlanTableKind, C> {
  kind: K;
  /** 이은 조각들의 원본 표 index, 문서 순 */
  pieces: number[];
  /** 첫 조각의 머리행 수(S-2). 뒤 조각은 각자의 머리행을 떼고 이었다 */
  headerRows: number;
  /** 열마다 머리행 원문(UnreadColumn.header와 같은 형식) — 미리보기 표시용 */
  headers: string[];
  colCnt: number;
  /** 이은 데이터 행. 셀은 추출 결과 그대로다(한 줄/여러 줄 가공은 행 해석이 한다) */
  rows: string[][];
  /** rows[i]가 온 원본 위치 — `index`는 표 index, `row`는 그 표 안 0-based 행 */
  rowOrigins: { index: number; row: number }[];
  columns: C;
  unreadColumns: UnreadColumn[];
}

export type TechPlanTable = PlanTableBase<'tech', TechColumns>;
export type DeliverablePlanTable = PlanTableBase<'deliverable', DeliverableColumns>;
export type MethodPlanTable = PlanTableBase<'method', MethodColumns>;
export type PlanTable = TechPlanTable | DeliverablePlanTable | MethodPlanTable;

export interface PlanTablesResult {
  tech: TechPlanTable | null;
  deliverable: DeliverablePlanTable | null;
  method: MethodPlanTable | null;
  issues: PlanIssue[];
}

// ─── 서명 (HX-3, C.3.1) ──────────────────────────────────────

// 판정 순서가 곧 우선순위다 — 한 표가 두 서명에 다 맞으면 앞의 종류로 본다(T5 판단: SOT 미정, 실측·픽스처엔 없는 경우)
const KINDS: readonly PlanTableKind[] = ['tech', 'deliverable', 'method'];

const SIGNATURES: Record<PlanTableKind, readonly (readonly string[])[]> = {
  tech: HWPX_TABLE_SIGNATURES.tech.map((k) => [k.keyword, ...k.aliases].map(normalizeLabel)),
  deliverable: HWPX_TABLE_SIGNATURES.deliverable.map((k) => [k.keyword, ...k.aliases].map(normalizeLabel)),
  method: HWPX_TABLE_SIGNATURES.method.map((k) => [k.keyword, ...k.aliases].map(normalizeLabel)),
};

type RoleDefs = readonly HwpxColumnRoleDef<string>[];

const NORMALIZED_ROLE_DEFS: Record<PlanTableKind, readonly { role: string; labels: readonly string[] }[]> = {
  tech: normalizeRoleDefs(HWPX_TECH_COLUMN_ROLES),
  deliverable: normalizeRoleDefs(HWPX_DELIVERABLE_COLUMN_ROLES),
  method: normalizeRoleDefs(HWPX_METHOD_COLUMN_ROLES),
};

function normalizeRoleDefs(defs: RoleDefs): { role: string; labels: string[] }[] {
  return defs.map((d) => ({ role: d.role, labels: d.labels.map(normalizeLabel) }));
}

/** S-2 머리행 판정에 쓰는 완전 일치 라벨 — 서명 키워드·별칭 + 열 역할 라벨 */
const HEADER_LABELS: Record<PlanTableKind, ReadonlySet<string>> = {
  tech: headerLabelSet('tech'),
  deliverable: headerLabelSet('deliverable'),
  method: headerLabelSet('method'),
};

function headerLabelSet(kind: PlanTableKind): Set<string> {
  const set = new Set<string>();
  for (const group of SIGNATURES[kind]) for (const w of group) set.add(w);
  for (const def of NORMALIZED_ROLE_DEFS[kind]) for (const w of def.labels) set.add(w);
  set.delete('');
  return set;
}

function headRows(t: HwpxTable): string[][] {
  return t.cells.slice(0, 2);
}

/** 첫 2행 정규화 텍스트가 키워드(또는 별칭)를 전부 부분 문자열로 포함하는가(C.3.1) */
function matchesSignature(t: HwpxTable, kind: PlanTableKind): boolean {
  const texts = headRows(t).flat().map(normalizeLabel).filter((s) => s !== '');
  return SIGNATURES[kind].every((group) => group.some((w) => texts.some((text) => text.includes(w))));
}

/** 서명이 맞는 첫 종류. 없으면 null */
export function signatureKind(t: HwpxTable): PlanTableKind | null {
  for (const kind of KINDS) if (matchesSignature(t, kind)) return kind;
  return null;
}

function isYearLabel(normalized: string): boolean {
  return HWPX_YEAR_COLUMN_PATTERN.test(normalized);
}

/**
 * 머리행 수(S-2): 첫 2행 중 완전 일치 셀이 2개 이상인 행이 앞에서 연속된 수.
 * `N차년도`도 C.3.5 열 역할 라벨이라 완전 일치로 센다. 병합으로 복사된 칸도 한 칸씩 센다.
 */
export function countHeaderRows(t: HwpxTable, kind: PlanTableKind): number {
  const labels = HEADER_LABELS[kind];
  let count = 0;
  for (const row of headRows(t)) {
    const hits = row.map(normalizeLabel).filter((s) => labels.has(s) || isYearLabel(s)).length;
    if (hits < 2) break;
    count += 1;
  }
  return count;
}

// ─── 열 역할 (C.3.5) ─────────────────────────────────────────

function displayHeader(t: HwpxTable, headerRows: number, col: number): string {
  const parts: string[] = [];
  for (let r = 0; r < headerRows; r++) {
    const text = (t.cells[r]?.[col] ?? '').replace(/\s+/g, ' ').trim();
    if (text !== '' && !parts.includes(text)) parts.push(text);
  }
  return parts.join(' / ');
}

interface RoleMatch {
  role: string;
  exact: boolean;
  labelLength: number;
}

/** 라벨 하나에 대한 최선의 역할 — 완전 일치 > 부분 일치, 같으면 더 긴 라벨(T5 판단) */
function bestRole(normalized: string, kind: PlanTableKind): RoleMatch | null {
  if (normalized === '') return null;
  if (isYearLabel(normalized)) return { role: 'year', exact: true, labelLength: normalized.length };
  let best: RoleMatch | null = null;
  for (const def of NORMALIZED_ROLE_DEFS[kind]) {
    for (const label of def.labels) {
      if (label === '' || !normalized.includes(label)) continue;
      const cand: RoleMatch = { role: def.role, exact: normalized === label, labelLength: label.length };
      if (
        best === null ||
        (cand.exact && !best.exact) ||
        (cand.exact === best.exact && cand.labelLength > best.labelLength)
      ) {
        best = cand;
      }
    }
  }
  return best;
}

/**
 * 열 하나의 역할 — 아래 머리행(하위 헤더) 라벨을 먼저 보고, 역할이 없으면 위 머리행으로 내려간다(T5 판단).
 * `개발목표치` 아래 `1차년도`, `세계최고…` 아래 `성능수준` 같은 2단 머리행을 둘 다 다루려는 순서다.
 */
function columnRole(t: HwpxTable, headerRows: number, col: number, kind: PlanTableKind): string | null {
  for (let r = headerRows - 1; r >= 0; r--) {
    const m = bestRole(normalizeLabel(t.cells[r]?.[col] ?? ''), kind);
    if (m !== null) return m.role;
  }
  return null;
}

const NUMBERED_NAME = /^\s*(\d+)\.\s*/;

/** U-1: `평가항목`이 여러 열이면 데이터가 `N.`로 시작하는 행이 가장 많은 열(같으면 왼쪽) */
function pickNumberedColumn(rows: readonly string[][], cols: readonly number[]): number {
  let best = cols[0]!;
  let bestCount = -1;
  for (const c of cols) {
    const count = rows.filter((r) => NUMBERED_NAME.test(r[c] ?? '')).length;
    if (count > bestCount) {
      best = c;
      bestCount = count;
    }
  }
  return best;
}

// 여러 열을 모두 쓰는 역할. 그 밖의 역할은 왼쪽 첫 열만 쓴다(T5 판단)
const MULTI_ROLES: Record<PlanTableKind, ReadonlySet<string>> = {
  tech: new Set(['year']),
  deliverable: new Set(['year', 'item']),
  method: new Set(),
};

interface ColumnAssignment {
  single: Map<string, number>;
  multi: Map<string, number[]>;
  unread: UnreadColumn[];
}

function assignColumns(
  first: HwpxTable,
  headerRows: number,
  kind: PlanTableKind,
  rows: readonly string[][],
): ColumnAssignment {
  const byRole = new Map<string, number[]>();
  const unread: UnreadColumn[] = [];
  for (let c = 0; c < first.colCnt; c++) {
    const role = columnRole(first, headerRows, c, kind);
    const header = displayHeader(first, headerRows, c);
    if (role === null) unread.push({ col: c, header, reason: 'unknown' });
    else if (role === 'ignored') unread.push({ col: c, header, reason: 'ignored' });
    else byRole.set(role, [...(byRole.get(role) ?? []), c]);
  }

  const single = new Map<string, number>();
  const multi = new Map<string, number[]>();
  for (const [role, cols] of byRole) {
    if (MULTI_ROLES[kind].has(role)) {
      multi.set(role, cols);
      continue;
    }
    const chosen = kind === 'tech' && role === 'name' ? pickNumberedColumn(rows, cols) : cols[0]!;
    single.set(role, chosen);
    for (const c of cols) {
      if (c === chosen) continue;
      // 기술목표 평가항목의 번호 없는 열은 구분 성격이라 읽지 않기로 한 열이다(U-1)
      const reason = kind === 'tech' && role === 'name' ? 'ignored' : 'duplicate';
      unread.push({ col: c, header: displayHeader(first, headerRows, c), reason });
    }
  }
  unread.sort((a, b) => a.col - b.col);
  return { single, multi, unread };
}

function one(a: ColumnAssignment, role: string): number | null {
  return a.single.get(role) ?? null;
}

function many(a: ColumnAssignment, role: string): number[] {
  return a.multi.get(role) ?? [];
}

// ─── 묶음 (HX-4) ─────────────────────────────────────────────

interface Piece {
  table: HwpxTable;
  headerRows: number;
}

/**
 * 같은 종류 조각을 묶는다. index가 바로 앞 조각 + 1이어야 잇는다 — 사이에 다른 표(건너뛴 표 포함)가
 * 있으면 index가 비므로 별개 묶음이다. 서버는 서명 일치 표만 받으므로 index 간격이 유일한 단서다.
 * 열 수가 다르면 이을 수 없어 별개 묶음으로 본다(T5 판단).
 */
function bundle(pieces: readonly Piece[]): Piece[][] {
  const bundles: Piece[][] = [];
  for (const p of pieces) {
    const last = bundles[bundles.length - 1];
    const prev = last?.[last.length - 1];
    if (last !== undefined && prev !== undefined && p.table.index === prev.table.index + 1 && p.table.colCnt === prev.table.colCnt) {
      last.push(p);
    } else {
      bundles.push([p]);
    }
  }
  return bundles;
}

function joinRows(pieces: readonly Piece[]): { rows: string[][]; rowOrigins: { index: number; row: number }[] } {
  const rows: string[][] = [];
  const rowOrigins: { index: number; row: number }[] = [];
  for (const p of pieces) {
    for (let r = p.headerRows; r < p.table.cells.length; r++) {
      rows.push([...p.table.cells[r]!]);
      rowOrigins.push({ index: p.table.index, row: r });
    }
  }
  return { rows, rowOrigins };
}

/** 순번 열 값에서 순번을 읽는다. 기술목표는 `N.` 접두, 평가방법은 정수만 있는 칸 */
function sequenceOf(kind: PlanTableKind, cell: string): number | null {
  if (kind === 'tech') {
    const m = NUMBERED_NAME.exec(cell);
    return m ? Number(m[1]) : null;
  }
  const t = cell.trim();
  return /^\d+$/.test(t) ? Number(t) : null;
}

/** 순번이 있는 행끼리 1씩 늘지 않는 곳(HX-4). 순번 없는 행은 건너뛴다 */
function sequenceGaps(kind: PlanTableKind, rows: readonly string[][], col: number | null): string[] {
  if (col === null) return [];
  const gaps: string[] = [];
  let prev: number | null = null;
  for (const row of rows) {
    const n = sequenceOf(kind, row[col] ?? '');
    if (n === null) continue;
    if (prev !== null && n !== prev + 1) gaps.push(`${prev} 다음 ${n}`);
    prev = n;
  }
  return gaps;
}

const REQUIRED_ROLE_LABELS: Record<PlanTableKind, readonly { role: string; label: string; multi: boolean }[]> = {
  tech: [
    { role: 'name', label: '평가항목', multi: false },
    { role: 'unit', label: '단위', multi: false },
    { role: 'weight', label: '비중', multi: false },
    { role: 'year', label: 'N차년도', multi: true },
    { role: 'measureMethod', label: '평가방법', multi: false },
    { role: 'org', label: '담당기관', multi: false },
  ],
  deliverable: [
    { role: 'category', label: '구분', multi: false },
    { role: 'item', label: '항목', multi: true },
    { role: 'unit', label: '단위', multi: false },
    { role: 'weight', label: '가중치', multi: false },
    { role: 'year', label: 'N차년도', multi: true },
    { role: 'total', label: '계', multi: false },
    { role: 'evidenceMethod', label: '평가방법', multi: false },
  ],
  method: [
    { role: 'seq', label: '순번', multi: false },
    { role: 'name', label: '평가항목', multi: false },
    { role: 'measureDescription', label: '평가방법', multi: false },
    { role: 'evaluationEnvironment', label: '평가환경', multi: false },
  ],
};

function buildPlanTable(kind: PlanTableKind, pieces: readonly Piece[], issues: PlanIssue[]): PlanTable {
  const first = pieces[0]!;
  const { rows, rowOrigins } = joinRows(pieces);
  const a = assignColumns(first.table, first.headerRows, kind, rows);
  const label = PLAN_TABLE_LABELS[kind];

  for (const req of REQUIRED_ROLE_LABELS[kind]) {
    const found = req.multi ? many(a, req.role).length > 0 : one(a, req.role) !== null;
    if (!found) issues.push(planIssue('missing-column', `${label} ${req.label}`));
  }
  if (a.unread.length > 0) {
    issues.push(planIssue('unread-column', `${label} ${a.unread.map((u) => u.header || `${u.col + 1}열`).join(', ')}`));
  }

  const base = {
    pieces: pieces.map((p) => p.table.index),
    headerRows: first.headerRows,
    headers: Array.from({ length: first.table.colCnt }, (_, c) => displayHeader(first.table, first.headerRows, c)),
    colCnt: first.table.colCnt,
    rows,
    rowOrigins,
    unreadColumns: a.unread,
  };

  let table: PlanTable;
  let seqCol: number | null = null;
  if (kind === 'tech') {
    const columns: TechColumns = {
      name: one(a, 'name'),
      unit: one(a, 'unit'),
      weight: one(a, 'weight'),
      year: many(a, 'year'),
      measureMethod: one(a, 'measureMethod'),
      org: one(a, 'org'),
    };
    seqCol = columns.name;
    table = { kind, ...base, columns };
  } else if (kind === 'deliverable') {
    const columns: DeliverableColumns = {
      category: one(a, 'category'),
      item: many(a, 'item'),
      unit: one(a, 'unit'),
      weight: one(a, 'weight'),
      year: many(a, 'year'),
      total: one(a, 'total'),
      evidenceMethod: one(a, 'evidenceMethod'),
    };
    table = { kind, ...base, columns };
  } else {
    const columns: MethodColumns = {
      seq: one(a, 'seq'),
      name: one(a, 'name'),
      measureDescription: one(a, 'measureDescription'),
      evaluationEnvironment: one(a, 'evaluationEnvironment'),
    };
    seqCol = columns.seq;
    table = { kind, ...base, columns };
  }

  const gaps = sequenceGaps(kind, rows, seqCol);
  if (gaps.length > 0) issues.push(planIssue('sequence-gap', `${label} ${gaps.join(', ')}`));
  return table;
}

// ─── 진입점 ──────────────────────────────────────────────────

/**
 * 표 목록에서 기술목표·성과목표·평가방법 표를 찾아 잇고 열 역할을 정한다(HX-3·HX-4).
 * `skipped`(구조 불일치로 추출이 건너뛴 표)는 사유로만 알린다 — index를 차지하므로 잇기 판정엔 이미 반영돼 있다.
 */
export function identifyPlanTables(
  tables: readonly HwpxTable[],
  skipped: HwpxExtractResult['skipped'] = [],
): PlanTablesResult {
  const issues: PlanIssue[] = [];
  for (const s of skipped) {
    issues.push(planIssue('structure-mismatch', `표 ${s.index + 1}(섹션 ${s.section})`));
  }

  const sorted = [...tables].sort((x, y) => x.index - y.index);
  const piecesByKind: Record<PlanTableKind, Piece[]> = { tech: [], deliverable: [], method: [] };
  for (const t of sorted) {
    const kind = signatureKind(t);
    if (kind === null) continue;
    const headerRows = countHeaderRows(t, kind);
    if (headerRows === 0) {
      issues.push(planIssue('header-not-found', `${PLAN_TABLE_LABELS[kind]} (표 ${t.index + 1})`));
      continue;
    }
    piecesByKind[kind].push({ table: t, headerRows });
  }

  const found: Record<PlanTableKind, PlanTable | null> = { tech: null, deliverable: null, method: null };
  for (const kind of KINDS) {
    const bundles = bundle(piecesByKind[kind]);
    const head = bundles[0];
    if (head === undefined) {
      const keywords = HWPX_TABLE_SIGNATURES[kind].map((k) => k.keyword).join('·');
      issues.push(planIssue('table-not-found', `${PLAN_TABLE_LABELS[kind]} (${keywords})`));
      continue;
    }
    found[kind] = buildPlanTable(kind, head, issues);
    if (bundles.length > 1) {
      issues.push(duplicateTableIssue(kind, bundles.length - 1, bundles.slice(1).map((b) => b[0]!.table.index)));
    }
  }

  if (found.tech === null && found.deliverable === null) issues.push(planIssue('no-goal-tables'));

  return {
    tech: found.tech as TechPlanTable | null,
    deliverable: found.deliverable as DeliverablePlanTable | null,
    method: found.method as MethodPlanTable | null,
    issues,
  };
}

/** 서버로 보낼 표 — 서명이 맞는 표 전부(뒤쪽 중복 묶음 포함, S-14). 문서 순 */
export function selectPayloadTables(result: HwpxExtractResult): HwpxTable[] {
  return [...result.tables].sort((x, y) => x.index - y.index).filter((t) => signatureKind(t) !== null);
}

// 타입 전용 재노출 — 행 해석(T6)이 역할 이름을 constants에서 따로 찾지 않게 한다
export type { HwpxDeliverableColumnRole, HwpxMethodColumnRole, HwpxTechColumnRole };
