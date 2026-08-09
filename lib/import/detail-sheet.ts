// 산출근거 시트 구조 감지 — D-1 섹션 · D-2 비목 · D-3 세목 · D-4 컬럼 헤더 · D-6 메모 열 · D-7 role
// + 행 변환 D-5 소계 · D-8 조정액 흡수 · D-9 축 · D-10 통화 · D-21 금액 0 · D-18 소계 대조
// (SOT §6.11.1~§6.11.3·§6.11.5·§6.11.6, 부록 B.7·B.8, 부록 C.2).
//
// 부수효과 없는 순수 함수다. `lib/import/`의 다른 모듈과 같이 SheetJS를 import하지 않는다 (I-13) —
// 어댑터가 만든 RawSheet(§5.12.2)만 받는다. 단위 테스트: tests/unit/import-detail-sheet.test.ts
//
// 이 파일은 **시트만 안다.** DB도 Member도 모른다 — 성명 매칭·미리보기 조립은 detail-preview.ts의 몫이다 (§6.11.6).
// 금액 산식도 여기 다시 구현하지 않는다 — `lib/budget-plan.ts`의 computeDetailAmount를 부른다 (PL-10a).

import { computeDetailAmount } from '@/lib/budget-plan';
import {
  CASH_INKIND_AXIS,
  SUBCATEGORY_PRESETS,
  subcategoryLookupKey,
  subcategoryLookupTable,
} from '@/lib/constants';
import type { BudgetCategory, DetailAxis, DetailFactor, DetailFormula } from '@/types';
import { parseAmountCell, parseAmountText } from './amount';
import { classifyLabel } from './categorize';
import { cellAt, cellText, expandMerges, gridWidth } from './grid';
import { indexToColumnLetter, normalizeLabel } from './normalize';
import type { AmountError, MatchContext, MergeRange, RawCell, RawSheet } from './types';

// ─── D-1 섹션 ────────────────────────────────────────────────

export type DetailSectionKind = 'direct' | 'indirect';

export interface DetailSection {
  kind: DetailSectionKind;
  /** 섹션 헤더 원문 */
  label: string;
  headerRow: number;
  /** 헤더 바로 다음 행 */
  startRow: number;
  /** 다음 섹션 헤더 직전 행. 마지막 섹션은 시트 끝 */
  endRow: number;
}

const SECTION_KEYS: Readonly<Record<string, DetailSectionKind>> = {
  '1직접비소요명세': 'direct',
  '2간접비소요명세': 'indirect',
};

/**
 * 섹션 조회 키.
 *
 * normalizeLabel(I-1)은 마침표도 전각 숫자도 지우지 않으므로 여기서 전처리한다 — 실측 표기가
 * `1. 직접비 소요명세` / `1.직접비 소요명세` / `１． 직접비소요명세`로 갈리고, 셋이 같은 섹션이다.
 * NFKC로 전각을 접은 뒤 마침표를 뗀다.
 */
export function sectionLookupKey(text: string | null | undefined): string {
  if (text === null || text === undefined) return '';
  return normalizeLabel(String(text).normalize('NFKC')).replace(/[.]/g, '');
}

/**
 * D-1: `1. 직접비 소요명세` / `2. 간접비 소요명세` 행을 찾아 섹션 경계를 만든다.
 *
 * **섹션 밖의 행은 결과에 한 행도 담기지 않는다** — 시트 상단(실측 1~59행)은 총괄표·요약 블록이고
 * 그것은 §6.8의 대상이다. 여기서 읽으면 같은 금액을 두 번 계상한다.
 *
 * 섹션이 하나도 없으면 **빈 배열**을 돌려준다. 산출근거 시트가 아니라는 판정과 거부 문구는
 * 액션·마법사(§7.9.3 Step 2)의 몫이지 파서의 몫이 아니다.
 */
export function detectSections(sheet: RawSheet): DetailSection[] {
  const cells = expandMerges(sheet).cells;
  const width = gridWidth(cells);

  const found: { kind: DetailSectionKind; label: string; headerRow: number }[] = [];
  for (let r = 0; r < cells.length; r += 1) {
    for (let c = 0; c < width; c += 1) {
      const text = cellText(cellAt(cells, r, c));
      if (text === '') continue;
      const kind = SECTION_KEYS[sectionLookupKey(text)];
      if (kind === undefined) continue;
      found.push({ kind, label: text, headerRow: r });
      break; // 병합으로 같은 헤더가 여러 열에 펼쳐진다 — 행마다 한 번만 잡는다
    }
  }

  const lastRow = Math.max(cells.length - 1, 0);
  return found.map((section, i) => ({
    kind: section.kind,
    label: section.label,
    headerRow: section.headerRow,
    startRow: section.headerRow + 1,
    endRow: (found[i + 1]?.headerRow ?? lastRow + 1) - 1,
  }));
}

// ─── D-7 컬럼 role ───────────────────────────────────────────

/**
 * 컬럼의 의미. **위치가 아니라 헤더 텍스트로** 정한다 (D-7) — 인건비 열 위치가 부처마다 다르다
 * (산자부 `인력구분|성명|…`, 행안부 `구 분|번호|인력 구분|성명|…`).
 * `factor`는 PL-3대로 라벨을 보존한다 — 세목마다 인자의 의미가 다르고 실측에 `시트(수량)`도 있다.
 *
 * **타입을 배열에서 파생시킨다**: D-7의 재지정(`applyColumnRoleOverrides`)은 사용자 입력이라
 * 서버 Zod가 같은 목록으로 값을 검증해야 하는데, 목록을 두 곳에 적으면 role을 늘릴 때 한쪽만
 * 늘어나 새 role이 조용히 거부된다.
 */
export const DETAIL_COLUMN_ROLES = [
  'memberName',
  'position',
  'salary',
  'rate',
  'period',
  'hireType',
  'name',
  'spec',
  'unitPrice',
  'factor',
  'cashTotal',
  'inKindTotal',
  'total',
  'note',
] as const;

export type DetailColumnRole = (typeof DETAIL_COLUMN_ROLES)[number];

// 정규화(I-1) 키 → role. 정규화가 공백·괄호·하이픈을 지우므로 `참여율(%)`·`인력 구분`은 여기 없어도 된다.
const ROLE_KEYS: Readonly<Record<string, DetailColumnRole>> = {
  // 인건비 (부처별 열 순서가 달라도 텍스트는 같다)
  '성명': 'memberName',
  '이름': 'memberName',
  '직위': 'position',
  '직급': 'position',
  '직책': 'position',
  '연봉': 'salary',
  '연봉액': 'salary',
  '연간급여': 'salary',
  '급여': 'salary',
  // D-7: **정규화 후의 형태**를 키로 둔다. 실측 연봉 열 헤더가 괄호 안에 `연봉`을 숨기고 있어
  // I-1이 그것을 지운다 — 산자부 `실지급액\n(연봉)` → `실지급액`,
  // 행안부 `실지급액-월`+`(연봉` → `실지급액월`. `연봉`만 찾으면 두 부처 모두 매핑에 실패해
  // formulaAmount가 0이 되고 조정액이 금액 전액을 떠안는다 (D-8의 의미가 사라진다).
  // `실지급액월`은 산자부에서 월액(연봉/12) 열이기도 하지만 role 맵은 **첫 열**을 쓰고
  // 연봉 열이 언제나 왼쪽이라 연봉이 잡힌다 (buildRoleMap 주석).
  '실지급액': 'salary',
  '실지급액월': 'salary',
  '참여율': 'rate',
  '참여기간': 'period',
  '참여개월': 'period',
  '참여월수': 'period',
  '인력구분': 'hireType',
  '채용구분': 'hireType',
  '인력유형': 'hireType',
  '고용형태': 'hireType',

  // 물품·내역
  '품명': 'name',
  '품목': 'name',
  '내역': 'name',
  '내역명': 'name',
  '항목': 'name',
  '세부내역': 'name',
  '품명및규격': 'name',
  '규격': 'spec',
  '산출내역': 'spec',
  '산출근거': 'spec',

  // 단가. `산출비용`은 출장비(형태 5)에서 단가 자리를 대신한다 — 단가와 함께 나오면(형태 4·6)
  // 왼쪽의 `단가`가 먼저 잡히고 이 열은 중복이 된다 (roles는 첫 열을 가리킨다)
  '단가': 'unitPrice',
  '단위단가': 'unitPrice',
  '산출비용': 'unitPrice',

  // 인자 (PL-3: 라벨 보존). `시트`는 실측 ⑥ 소프트웨어 활용비의 `시트(수량)`이다 (부록 B.8.2)
  '수량': 'factor',
  '회': 'factor',
  '월': 'factor',
  '개월': 'factor',
  '인원': 'factor',
  '횟수': 'factor',
  '명': 'factor',
  '건': 'factor',
  '시트': 'factor',

  // 금액
  '합계': 'total',
  '계': 'total',
  '총액': 'total',
  '금액': 'total',
  '비고': 'note',
  '메모': 'note',
  '참고': 'note',
};

// 현금/현물 라벨은 상수(S-4)를 재사용한다 — 여기 다시 적으면 두 사전이 반드시 어긋난다.
// 'unassigned'(일반·통합관리)는 총괄표의 학생인건비 축이라 산출근거 컬럼 role이 아니다.
const AXIS_ROLE_KEYS: ReadonlyMap<string, DetailColumnRole> = new Map(
  Object.entries(CASH_INKIND_AXIS)
    .filter(([, axis]) => axis === 'cash' || axis === 'inKind')
    .map(([label, axis]) => [
      normalizeLabel(label),
      axis === 'cash' ? ('cashTotal' as const) : ('inKindTotal' as const),
    ])
);

function lookupRole(key: string): DetailColumnRole | null {
  if (key === '') return null;
  return ROLE_KEYS[key] ?? AXIS_ROLE_KEYS.get(key) ?? null;
}

/**
 * 여러 행에 걸친 헤더(D-4·D-7)를 결합해 읽는다. 조회 순서는 **결합 → 아래에서 위로**다 —
 * `총액`+`현금`은 하위가, `산출내역`+`단가`도 하위가 의미를 정한다. 상위만 보면 셋 다 `총액`이 되어
 * 현금·현물·합계가 한 열로 뭉개진다.
 *
 * 실측 행안부 인건비는 헤더가 **3행**이다(`참여기간(월)`+`©`+``) — 결합 키가 `참여기간©`이 되어
 * 사전에 없으므로 조각을 하나씩 되짚어야 `참여기간`을 찾는다.
 */
export function resolveColumnRoleFromParts(parts: readonly string[]): DetailColumnRole | null {
  const pieces = parts.filter((part) => part !== '');
  const keys: string[] = [];
  if (pieces.length > 1) keys.push(normalizeLabel(pieces.join('')));
  for (let i = pieces.length - 1; i >= 0; i -= 1) keys.push(normalizeLabel(pieces[i]!));
  for (const key of keys) {
    const role = lookupRole(key);
    if (role !== null) return role;
  }
  return null;
}

/** 2행 헤더의 짧은 형태. `resolveColumnRoleFromParts`와 같은 규칙이다 */
export function resolveColumnRole(top: string, bottom: string): DetailColumnRole | null {
  return resolveColumnRoleFromParts([top, bottom === top ? '' : bottom]);
}

export interface DetailColumn {
  /** 0-based 시트 열 */
  index: number;
  /** 엑셀 열 문자 (다른 모듈과 같은 표기) */
  column: string;
  /** 상위 헤더 원문 */
  top: string;
  /** 하위 헤더 원문. 1행 헤더거나 세로 병합이면 빈 문자열 */
  bottom: string;
  /** 표시·인자 라벨 (상·하위 결합). D-10 통화 기호 판정은 top/bottom 원문을 본다 */
  label: string;
  role: DetailColumnRole | null;
}

// ─── D-4 컬럼 헤더 행 ────────────────────────────────────────

/** D-4 헤더 힌트 어휘. SOT 표 그대로다 — 늘리거나 줄이면 헤더 행 판정이 조용히 달라진다 */
export const HEADER_HINTS = [
  '품명', '규격', '단위', '수량', '단가', '총액', '합계', '비고',
  '성명', '직위', '참여율', '참여기간', '내역', '인원', '횟수', '구분',
] as const;

/** D-4: 힌트 3개 이상이면 컬럼 헤더 행이다 */
export const HEADER_HINT_MIN = 3;

function hintCount(cells: readonly (readonly RawCell[])[], row: number, width: number): number {
  const hits = new Set<string>();
  for (let c = 0; c < width; c += 1) {
    const text = normalizeLabel(cellText(cellAt(cells, row, c)));
    if (text === '') continue;
    for (const hint of HEADER_HINTS) {
      // 부분 일치다 — `인력 구분`·`총액(현금)`처럼 힌트가 다른 낱말에 붙어 나온다
      if (text.includes(hint)) hits.add(hint);
    }
  }
  return hits.size;
}

/** 숫자로 읽히는 셀. 헤더·구조 행과 데이터 행을 가르는 유일하게 안정적인 신호다 */
function isNumericCell(cell: RawCell): boolean {
  if (cell.isError) return false;
  const value = cell.value;
  if (typeof value === 'number') return true;
  if (typeof value !== 'string') return false;
  if (!/\d/.test(value)) return false;
  return parseAmountText(value, 1).ok;
}

function hasNumericCell(
  cells: readonly (readonly RawCell[])[],
  row: number,
  width: number,
  from = 0
): boolean {
  for (let c = from; c < width; c += 1) {
    if (isNumericCell(cellAt(cells, row, c))) return true;
  }
  return false;
}

/**
 * D-7a: 그 행의 **라벨 구간** 끝 열. 힌트 어휘가 나타나는 마지막 열까지가 표의 라벨이고,
 * 그 오른쪽에 떨어져 있는 것은 메모다.
 *
 * 헤더를 찾기 전에는 열 범위를 모르므로(D-6은 찾은 **뒤**의 규칙이다) 이 근사가 필요하다.
 * 시트 전체 폭에서 숫자를 보면 실측 행안부 `⑥ 소프트웨어 활용비`의 메모(`O206=1`·`O207=1`)
 * 때문에 헤더 후보 두 줄이 모두 탈락하고 그 블록이 통째로 사라진다.
 */
function labelSpanEnd(
  cells: readonly (readonly RawCell[])[],
  row: number,
  width: number
): number {
  let end = -1;
  for (let c = 0; c < width; c += 1) {
    const text = normalizeLabel(cellText(cellAt(cells, row, c)));
    if (text === '') continue;
    if (HEADER_HINTS.some((hint) => text.includes(hint))) end = c;
  }
  return end;
}

/** 라벨 구간 안에만 숫자가 있는지 본다 (D-7a). 힌트가 하나도 없으면 전체 폭을 본다 */
function hasNumericInLabelSpan(
  cells: readonly (readonly RawCell[])[],
  row: number,
  width: number
): boolean {
  const end = labelSpanEnd(cells, row, width);
  if (end === -1) return hasNumericCell(cells, row, width);
  return hasNumericCell(cells, row, end + 1);
}

/**
 * 헤더 행 = 힌트 3개 이상 + 라벨 구간에 숫자 셀 없음.
 * 숫자 조건을 빼면 힌트 낱말을 품은 데이터 행(`구분`이 든 품명 등)이 헤더로 둔갑해 표가 쪼개진다.
 */
function isHeaderRow(
  cells: readonly (readonly RawCell[])[],
  row: number,
  width: number
): boolean {
  if (hasNumericInLabelSpan(cells, row, width)) return false;
  return hintCount(cells, row, width) >= HEADER_HINT_MIN;
}

/**
 * 다음 헤더 줄(`산출내역` 아래 `단가|회|월`). 힌트가 하나뿐일 수 있어 기준을 낮추되
 * 숫자 셀이 없어야 한다 — 데이터 행을 헤더로 먹으면 첫 행이 통째로 사라진다.
 *
 * 힌트 1개 조건을 유지하는 이유(D-7): 실측 간접비 `나. 연구지원비`의 첫 데이터 행
 * (`기관 공통지원경비`, 금액 없음)처럼 **숫자 없는 데이터 행**이 있고, 그것을 헤더로 먹으면
 * 0원 계상 자리가 통째로 사라진다. 진짜 하위 헤더 줄은 병합 확장(S-11)으로 상위 라벨을
 * 이어받거나 자체 힌트 어휘를 갖는다.
 */
function isContinuationRow(
  cells: readonly (readonly RawCell[])[],
  row: number,
  width: number
): boolean {
  if (hasNumericInLabelSpan(cells, row, width)) return false;
  return hintCount(cells, row, width) >= 1;
}

interface TableSpan {
  headerRows: number[];
  dataStartRow: number;
  /** 데이터가 없으면 dataStartRow - 1 */
  dataEndRow: number;
}

/**
 * D-7: 헤더는 **3행까지** 결합한다. 실측 행안부 인건비가 64행(`참여율`/`참여기간(월)`) +
 * 65행(`(%)`/`©`) + 66행(`(A)`/`현금`/`현물`/`계`)의 3단이다 — 2행까지만 묶으면 세 번째 줄이
 * 별도의 표 헤더로 잡혀 `rate`·`period`가 통째로 빠지고 두 부처의 role 맵이 갈린다.
 */
const HEADER_ROW_MAX = 3;

/**
 * 한 구간 안의 표들. 컬럼 헤더가 **두 번 나오면 표가 둘이다** — 실측 `⑤ 출장비`가 그렇다 (C.2 주의 2).
 * D-5대로 `소계`·`합계`에서 멈추지 않는다. 다음 헤더 행 또는 구간 끝까지가 한 표의 데이터다.
 */
function findTables(
  cells: readonly (readonly RawCell[])[],
  width: number,
  from: number,
  to: number
): TableSpan[] {
  const tables: TableSpan[] = [];
  let r = from;
  while (r <= to) {
    if (!isHeaderRow(cells, r, width)) {
      r += 1;
      continue;
    }
    const headerRows = [r];
    while (
      headerRows.length < HEADER_ROW_MAX &&
      headerRows[headerRows.length - 1]! + 1 <= to &&
      isContinuationRow(cells, headerRows[headerRows.length - 1]! + 1, width)
    ) {
      headerRows.push(headerRows[headerRows.length - 1]! + 1);
    }
    const dataStartRow = headerRows[headerRows.length - 1]! + 1;
    let next = dataStartRow;
    while (next <= to && !isHeaderRow(cells, next, width)) next += 1;
    tables.push({ headerRows, dataStartRow, dataEndRow: Math.min(next, to + 1) - 1 });
    r = next;
  }
  return tables;
}

/**
 * D-4 + D-7 + D-6.
 * 헤더 텍스트가 없는 열은 담지 않고, **매핑된 열의 최대 인덱스를 넘는 열도 버린다** — 실측
 * `N`~`P` 메모(`서울역↔실증지`·`KTX 금액`)가 금액 열로 오인되는 것을 막는 것이 D-6이다.
 */
function buildColumns(
  cells: readonly (readonly RawCell[])[],
  width: number,
  headerRows: readonly number[]
): DetailColumn[] {
  if (headerRows.length === 0) return [];

  const all: DetailColumn[] = [];
  for (let c = 0; c < width; c += 1) {
    // 세로 병합이면 아래 행에 같은 값이 펼쳐진다 (S-11) — 하위 라벨이 아니라 같은 라벨이다
    const parts: string[] = [];
    for (const row of headerRows) {
      const text = cellText(cellAt(cells, row, c));
      if (text === '' || text === parts[parts.length - 1]) continue;
      parts.push(text);
    }
    if (parts.length === 0) continue;
    const top = parts[0]!;
    const bottom = parts.slice(1).join(' ');
    all.push({
      index: c,
      column: indexToColumnLetter(c),
      top,
      bottom,
      label: parts.join(' '),
      role: resolveColumnRoleFromParts(parts),
    });
  }

  let maxMapped = -1;
  for (const column of all) {
    if (column.role !== null) maxMapped = Math.max(maxMapped, column.index);
  }
  // 매핑된 열이 하나도 없으면 자를 기준이 없다 — 조용히 전부 버리지 않고 그대로 드러낸다
  if (maxMapped === -1) return all;
  return all.filter((column) => column.index <= maxMapped);
}

function buildRoleMap(
  columns: readonly DetailColumn[]
): Partial<Record<DetailColumnRole, number>> {
  const roles: Partial<Record<DetailColumnRole, number>> = {};
  for (const column of columns) {
    // 같은 role이 여러 열이면(인자 여러 개, 형태 4·6의 `단가`+`산출비용`) 첫 열을 대표로 둔다.
    // 전부가 필요하면 columns를 순회한다
    if (column.role !== null && roles[column.role] === undefined) roles[column.role] = column.index;
  }
  return roles;
}

// ─── D-2 비목 · D-3 세목 ─────────────────────────────────────

/**
 * D-2 비목 접두어 — 한글 순서(`가.`~`차.`)와 `- `만 뗀다.
 * **원문자(`①`)는 떼지 않는다.** 떼면 세목 헤더가 비목 별칭에 걸려 블록이 통째로 어긋난다.
 */
const CATEGORY_ORDINAL_PREFIX = /^\s*(?:[가나다라마바사아자차][.．]|[-‐-―−•])\s*/;

export function stripCategoryOrdinal(label: string): string {
  return label.replace(CATEGORY_ORDINAL_PREFIX, '');
}

/** D-3 세목 번호 — 원문자(`①`~`⑳`)와 간접비 섹션의 한글 순서 접두어 */
const SUBCATEGORY_ORDINAL = /^\s*([①-⑳]|[가나다라마바사아자차][.．])\s*/;

function splitOrdinal(label: string): { token: string | null; rest: string } {
  const match = SUBCATEGORY_ORDINAL.exec(label);
  if (!match) return { token: null, rest: label };
  return { token: match[1]!.replace('．', '.'), rest: label.slice(match[0].length) };
}

function isCircledToken(token: string | null): boolean {
  return token !== null && /^[①-⑳]$/.test(token);
}

// 조회표·번호 색인은 상수에서 파생된 결정값이라 캐시해도 순수하다
const lookupTableCache = new Map<BudgetCategory, Readonly<Record<string, string>>>();
const numberIndexCache = new Map<BudgetCategory, ReadonlyMap<string, string[]>>();

function lookupTableOf(category: BudgetCategory): Readonly<Record<string, string>> {
  const cached = lookupTableCache.get(category);
  if (cached) return cached;
  const table = subcategoryLookupTable(category);
  lookupTableCache.set(category, table);
  return table;
}

/**
 * 번호 → 세목 코드. 부록 A.5 프리셋 라벨이 번호를 달고 있으므로 거기서 파생한다 —
 * 번호표를 따로 적으면 프리셋과 어긋난다. `⑤`는 국내·국외 **둘**을 가리킨다 (C.2 주의 2).
 */
function numberIndexOf(category: BudgetCategory): ReadonlyMap<string, string[]> {
  const cached = numberIndexCache.get(category);
  if (cached) return cached;
  const index = new Map<string, string[]>();
  for (const def of SUBCATEGORY_PRESETS[category]) {
    const { token } = splitOrdinal(def.label);
    if (token === null) continue;
    const codes = index.get(token);
    if (codes) codes.push(def.code);
    else index.set(token, [def.code]);
  }
  numberIndexCache.set(category, index);
  return index;
}

/** D-3 확정 근거. 세목 헤더가 없는 블록은 null이다 */
export type SubcategoryResolution = 'both' | 'label' | 'number' | 'conflict' | 'unresolved';

export type DetailBlockIssue =
  /** D-3: 번호와 라벨이 서로 다른 세목을 가리킨다 */
  | 'subcategory-conflict'
  /** D-3: 번호로만 정했다 — 서식이 순서를 바꾸면 조용히 틀린다 */
  | 'subcategory-by-number'
  /** D-3: 번호도 라벨도 못 읽었다 */
  | 'subcategory-unresolved'
  /** C.2 주의 2: `⑤ 출장비` 두 표를 국내/국외로 가르지 못했다 */
  | 'travel-undecided'
  /** D-4: 데이터로 보이는 행이 있는데 컬럼 헤더를 못 찾았다 */
  | 'no-column-header';

interface SubcategoryHeader {
  label: string;
  numberToken: string | null;
  labelCode: string | null;
  numberCodes: string[];
}

/**
 * D-3: 세목 헤더인가. **번호와 라벨을 둘 다** 본다.
 * 번호만 믿으면 서식이 순서를 바꿨을 때 조용히 틀리고, 라벨만 믿으면 실측 변형
 * (`⑪ 그 밖의 비용` vs `⑪ 기타`, `⑦ 연구실 운영비(삭감)`)을 놓친다.
 *
 * @param allowKoreanOrdinal 간접비 섹션에서만 true — 그 섹션의 세목 번호 체계가 `가.`~`다.`다.
 *   직접비 섹션에서 켜면 `가. 산출근거는 …` 같은 안내 문장이 세목 헤더로 둔갑한다
 */
function matchSubcategoryHeader(
  text: string,
  category: BudgetCategory,
  allowKoreanOrdinal: boolean
): SubcategoryHeader | null {
  const raw = String(text).normalize('NFC');
  const { token, rest } = splitOrdinal(raw);
  const usableToken = token !== null && (isCircledToken(token) || allowKoreanOrdinal) ? token : null;
  const labelCode = lookupTableOf(category)[subcategoryLookupKey(raw)] ?? null;
  const numberCodes = usableToken === null ? [] : (numberIndexOf(category).get(usableToken) ?? []);

  if (labelCode === null && numberCodes.length === 0) {
    // 번호는 붙었는데 아무것도 못 읽은 헤더도 **헤더로 잡는다** — 놓치면 그 표의 행이 앞 블록에
    // 붙어 다른 세목의 금액이 된다. 미해결 상태를 드러내고 사용자가 고르게 한다 (D-3)
    if (usableToken === null || rest.trim() === '') return null;
  }
  return { label: raw, numberToken: usableToken, labelCode, numberCodes };
}

// ─── 블록 ────────────────────────────────────────────────────

/**
 * 표 하나 = 블록 하나. 세목이 없는 비목(인건비·연구수당·국제공동연구개발비)은 `subcategory`가 null이며
 * `'default'`(부록 A.5 주의 3)로 눕힐지는 소비자가 정한다 — 파서는 시트에 없는 값을 지어내지 않는다.
 */
export interface DetailBlock {
  section: DetailSectionKind;
  category: BudgetCategory;
  /** 비목 헤더 원문. 간접비 섹션에서는 섹션 헤더 원문이다 (D-2) */
  categoryLabel: string;
  categoryRow: number;
  subcategory: string | null;
  subcategoryLabel: string | null;
  subcategoryRow: number | null;
  /** D-3 원문자·한글 순서 번호 (`①`, `가.`) */
  numberToken: string | null;
  resolvedBy: SubcategoryResolution | null;
  /** 번호가 가리키는 후보 전부. conflict일 때 사용자에게 보여 줄 대안이다 */
  numberCandidates: string[];
  /** 자동 확정하지 않고 사용자 확인을 받아야 하는가 (= issues가 비어 있지 않다) */
  needsConfirm: boolean;
  issues: DetailBlockIssue[];
  /** 컬럼 헤더 행 1~3개 (D-4·D-7) */
  headerRows: number[];
  columns: DetailColumn[];
  /** role → **첫** 열 인덱스. 같은 role이 여러 열이면 columns를 본다 */
  roles: Partial<Record<DetailColumnRole, number>>;
  dataStartRow: number;
  /** 데이터가 없으면 dataStartRow - 1 */
  dataEndRow: number;
  /** 같은 헤더 아래 표가 여럿이면 0,1,… (`⑤ 출장비`) */
  tableIndex: number;
  /**
   * D-23 비목 합계 줄의 행 번호. 비목 헤더의 앞·같은·다음 행 중 `합계` 라벨과 금액만 있는 줄이며
   * **그 비목의 첫 블록에만** 실린다 (같은 값을 세목마다 되풀이하지 않는다).
   * 데이터가 아니라 D-18 대조 대상이므로 `parseDetailRows`가 `subtotals`로만 담는다.
   *
   * 손으로 만든 블록에서는 생략할 수 있다 — 없으면 비목 합계 줄이 없다는 뜻이다.
   */
  categoryTotalRows?: number[];
}

// ─── D-7 컬럼 role 재지정 ────────────────────────────────────

/**
 * 한 role이 여러 열에 걸쳐도 정상인가.
 *
 * `factor`만 그렇다 (형태 3의 `단가|회|월`, 형태 5의 `인원|횟수` — PL-3). 나머지는
 * `parseDetailRows`가 `columnOfRole`로 **첫 열 하나만** 읽으므로 두 열이 되면 하나는 버려진다.
 */
export function allowsMultipleColumns(role: DetailColumnRole): boolean {
  return role === 'factor';
}

/** 열 인덱스(0-based) → 사용자가 지정한 role. `null`은 **역할 없음**이다 */
export type DetailColumnRoleOverrides = Readonly<Record<number, DetailColumnRole | null>>;

/**
 * D-7: 감지한 컬럼 role을 사용자 지정으로 덮는다. **`parseDetailRows` 이전에** 적용한다.
 *
 * 자동 인식은 제안이지 확정이 아니다 (§6.8 대원칙). role 사전이 모르는 헤더가 나오면 —
 * 실측 `실지급액\n(연봉)` 하나 때문에 인건비 전체가 0원이 될 뻔했다 — 우회 수단이 없으면
 * 임포트가 통째로 막힌다. 미매핑을 사용자가 지정하는 I-4와 같은 형태다.
 *
 * **중복 role 규칙**: 사용자가 단일 값 role(= `allowsMultipleColumns`가 false)을 지정하면
 * 같은 블록에서 **자동 감지로** 그 role을 얻은 다른 열의 role을 떨어뜨린다 — 사용자 지정이
 * 이긴다. 그러지 않으면 `columnOfRole`이 왼쪽 열을 대표로 잡아 **사용자가 고른 열이 조용히
 * 무시된다**(잘못 잡힌 열을 고치려던 조작이 아무 일도 하지 않는 것으로 보인다).
 * 반대로 사용자가 **같은 단일 role을 두 열에 겹쳐 지정**하는 경우는 여기서 고르지 않는다 —
 * 어느 열이 맞는지는 사용자가 알고 앱이 대신 고르면 금액을 엉뚱한 열에서 읽는다.
 * 그 조합은 `actions/detail-import.ts`가 입력 검증에서 **거부**한다.
 *
 * 원본 블록을 변조하지 않고 새 블록을 돌려준다. **열을 다시 자르지 않는다**(D-6의 오른쪽 메모
 * 절단은 감지 시점의 판단이고, 여기서 되풀이하면 사용자가 role을 뗀 순간 열이 통째로 사라진다).
 * 감지 결과에 없는 열 인덱스는 여기서 조용히 건너뛴다 — 거부는 입력 검증의 몫이다.
 */
export function applyColumnRoleOverrides(
  block: DetailBlock,
  overrides: DetailColumnRoleOverrides | undefined
): DetailBlock {
  if (overrides === undefined) return block;

  const chosen = new Map<number, DetailColumnRole | null>();
  for (const [key, role] of Object.entries(overrides)) {
    const index = Number(key);
    if (!Number.isInteger(index)) continue;
    if (!block.columns.some((column) => column.index === index)) continue;
    chosen.set(index, role);
  }
  if (chosen.size === 0) return block;

  const claimed = new Set<DetailColumnRole>();
  for (const role of chosen.values()) {
    if (role !== null && !allowsMultipleColumns(role)) claimed.add(role);
  }

  const columns = block.columns.map((column) => {
    if (chosen.has(column.index)) return { ...column, role: chosen.get(column.index) ?? null };
    if (column.role !== null && claimed.has(column.role)) return { ...column, role: null };
    return column;
  });

  return { ...block, columns, roles: buildRoleMap(columns) };
}

interface StructuralRow {
  row: number;
  category: BudgetCategory;
  categoryLabel: string;
  categoryRow: number;
  subcategory: SubcategoryHeader | null;
}

function hasContent(
  cells: readonly (readonly RawCell[])[],
  width: number,
  from: number,
  to: number,
  exclude: readonly number[] = []
): boolean {
  for (let r = from; r <= to; r += 1) {
    if (exclude.includes(r)) continue;
    for (let c = 0; c < width; c += 1) {
      if (cellText(cellAt(cells, r, c)) !== '') return true;
    }
  }
  return false;
}

/** 표의 첫 데이터 행 라벨 — C.2 주의 2의 국내/국외 판정 재료 */
function firstDataLabel(
  cells: readonly (readonly RawCell[])[],
  width: number,
  table: TableSpan,
  columns: readonly DetailColumn[],
  roles: Partial<Record<DetailColumnRole, number>>
): string {
  const nameColumn = roles.name;
  const fallbackColumns = columns.map((column) => column.index);
  for (let r = table.dataStartRow; r <= table.dataEndRow; r += 1) {
    if (nameColumn !== undefined) {
      const text = cellText(cellAt(cells, r, nameColumn));
      if (text !== '') return text;
      continue;
    }
    for (const c of fallbackColumns.length > 0 ? fallbackColumns : range(width)) {
      const text = cellText(cellAt(cells, r, c));
      if (text !== '') return text;
    }
  }
  return '';
}

function range(n: number): number[] {
  return Array.from({ length: n }, (_, i) => i);
}

/** 그 행에서 처음 값이 나오는 열. 구조 행이면 비목·세목 라벨이 앉은 자리다 */
function firstTextColumn(
  cells: readonly (readonly RawCell[])[],
  width: number,
  row: number
): number {
  for (let c = 0; c < width; c += 1) {
    if (cellText(cellAt(cells, row, c)) !== '') return c;
  }
  return -1;
}

/**
 * D-23: 비목 합계 줄. 실측에서 자리가 셋으로 흔들린다 —
 * 비목 헤더와 **같은 행**(`C96="다. 연구시설·장비비" K96="합계" L96=0`),
 * **다음 행**(`C149="마. 연구활동비"` → `K150="합계" L150=27,020,000`),
 * **앞 행**(`K246="합계"` → `C247="자. 연구수당"`).
 *
 * 세목 소계와 가르는 기준은 **라벨이 앉은 열**이다: 세목 소계는 비목·세목 라벨과 같은 열(실측 `C`)에
 * `소계`를 쓰고, 비목 합계 줄은 금액 표 쪽(실측 `K`)에 `합계`를 쓴다. 이 기준이 없으면 비목 헤더
 * 바로 위의 세목 소계를 비목 합계로 착각해 그 세목의 D-18 대조가 사라진다.
 *
 * 섹션 헤더 행까지만 거슬러 올라간다 — 그 위는 총괄표이고 D-1이 막는 영역이다.
 */
function findCategoryTotalRows(
  cells: readonly (readonly RawCell[])[],
  width: number,
  categoryRow: number,
  structuralRows: ReadonlySet<number>,
  section: DetailSection,
  sectionEnd: number,
  context: MatchContext | undefined
): number[] {
  const labelColumn = firstTextColumn(cells, width, categoryRow);
  if (labelColumn === -1) return [];

  const found: number[] = [];
  for (const r of [categoryRow - 1, categoryRow, categoryRow + 1]) {
    if (r < section.headerRow || r > sectionEnd) continue;
    // 다른 구조 행(다음 세목 헤더 등)은 그 자체가 계층이지 합계 줄이 아니다
    if (r !== categoryRow && structuralRows.has(r)) continue;
    if (!hasNumericCell(cells, r, width)) continue;
    for (let c = labelColumn + 1; c < width; c += 1) {
      const text = cellText(cellAt(cells, r, c));
      if (text === '') continue;
      if (classifyLabel(text, context).kind === 'skip') {
        found.push(r);
        break;
      }
    }
  }
  return found;
}

interface Resolution {
  subcategory: string | null;
  resolvedBy: SubcategoryResolution;
  issues: DetailBlockIssue[];
}

/** D-3 번호 × 라벨 이중 검증 */
function resolveSubcategory(header: SubcategoryHeader): Resolution {
  const { labelCode, numberCodes } = header;

  if (labelCode !== null) {
    if (numberCodes.length === 0) return { subcategory: labelCode, resolvedBy: 'label', issues: [] };
    if (numberCodes.includes(labelCode)) {
      return { subcategory: labelCode, resolvedBy: 'both', issues: [] };
    }
    // 어긋나면 자동 확정하지 않는다 (D-3). 제안은 사람이 읽는 라벨 쪽으로 두고
    // 번호 후보를 numberCandidates로 함께 실어 사용자가 고르게 한다
    return { subcategory: labelCode, resolvedBy: 'conflict', issues: ['subcategory-conflict'] };
  }

  if (numberCodes.length > 0) {
    return {
      subcategory: numberCodes[0]!,
      resolvedBy: 'number',
      issues: ['subcategory-by-number'],
    };
  }

  return { subcategory: null, resolvedBy: 'unresolved', issues: ['subcategory-unresolved'] };
}

/**
 * C.2 주의 2 — `⑤ 출장비`: 번호 하나가 세목 둘(국내·국외)을 덮고 컬럼 헤더가 두 번 나온다.
 * **세목 헤더가 아니라 표의 첫 데이터 행 라벨로** 가른다. 못 가르면 둘 다 국내로 제안하고
 * 확인을 요구한다 — 조용히 한 세목으로 합치면 국외 금액이 국내에 얹힌다.
 */
function resolveMultiCodeTable(
  category: BudgetCategory,
  base: Resolution,
  header: SubcategoryHeader,
  dataLabel: string,
  tableCount: number
): Resolution {
  const { numberCodes } = header;
  const byLabel = lookupCodeAmong(category, numberCodes, dataLabel);
  if (byLabel !== undefined) {
    return { subcategory: byLabel, resolvedBy: 'label', issues: [] };
  }
  // 표가 하나뿐이면 헤더 라벨이 이미 표를 가리킨다 (`⑤ 국내출장비`) — 그대로 둔다
  if (tableCount === 1 && header.labelCode !== null) return base;
  return {
    subcategory: numberCodes[0] ?? base.subcategory,
    resolvedBy: base.resolvedBy,
    issues: [...base.issues, 'travel-undecided'],
  };
}

/**
 * 첫 데이터 행 라벨 → 번호가 덮는 후보 중 하나.
 * 사전 조회가 먼저고, `국내 출장 (서울↔대전)`처럼 사전에 없는 표기는 국내/국외 낱말로 가른다.
 */
function lookupCodeAmong(
  category: BudgetCategory,
  candidates: readonly string[],
  rawLabel: string
): string | undefined {
  const key = subcategoryLookupKey(rawLabel);
  const code = key === '' ? undefined : lookupTableOf(category)[key];
  if (code !== undefined && candidates.includes(code)) return code;

  const compact = normalizeLabel(rawLabel);
  const domestic = candidates.find((code) => code.endsWith('_dom'));
  const international = candidates.find((code) => code.endsWith('_intl'));
  if (compact.includes('국내') && domestic !== undefined) return domestic;
  if ((compact.includes('국외') || compact.includes('해외')) && international !== undefined) {
    return international;
  }
  return undefined;
}

/**
 * D-2·D-3·D-4·D-6·D-7. 섹션 안의 비목·세목 블록과 각 블록의 컬럼 매핑을 뽑는다.
 *
 * **섹션 문맥이 우선한다** (D-2): 간접비 섹션에서는 비목 판정을 아예 하지 않고 `가./나./다.`를
 * `indirect`의 세목으로 읽는다. 같은 `다.`가 직접비에서는 연구시설·장비비, 간접비에서는
 * 성과활용지원비다 — 접두어만 보면 인력지원비가 인건비로 둔갑한다.
 *
 * 결과는 전부 **제안**이다 (§6.11 대원칙). `needsConfirm`이 붙은 블록은 사용자 확인 전에 반영하지 않는다.
 */
export function detectBlocks(
  sheet: RawSheet,
  sections: readonly DetailSection[],
  context?: MatchContext
): DetailBlock[] {
  const cells = expandMerges(sheet).cells;
  const width = gridWidth(cells);
  const lastRow = Math.max(cells.length - 1, 0);
  const blocks: DetailBlock[] = [];

  for (const section of sections) {
    const sectionEnd = Math.min(section.endRow, lastRow);
    const structural: StructuralRow[] = [];

    // 간접비 섹션의 비목은 시작부터 `indirect`로 고정된다 (D-2). 세목 판정에 문맥이 필요하므로
    // 비목이 열려 있지 않으면 세목도 잡지 않는다
    let openCategory: { category: BudgetCategory; label: string; row: number } | null =
      section.kind === 'indirect'
        ? { category: 'indirect', label: section.label, row: section.headerRow }
        : null;

    for (let r = section.startRow; r <= sectionEnd; r += 1) {
      const numeric = hasNumericCell(cells, r, width);
      let label = '';
      for (let c = 0; c < width; c += 1) {
        const text = cellText(cellAt(cells, r, c));
        if (text !== '') {
          label = text;
          break;
        }
      }
      if (label === '') continue;

      if (section.kind === 'direct') {
        // D-24: **비목 헤더 행에 금액이 있어도 비목 헤더다** — 실측 `C96="다. 연구시설·장비비"
        // K96="합계" L96=0`. 숫자 조건으로 걸러 내면 비목이 통째로 사라지고 그 아래 세목들이
        // 직전 비목(인건비)에 붙어 시설·장비비가 인건비로 계상된다.
        //
        // 단 **순서 접두어가 붙은 라벨에만** 예외를 준다. 접두어 없이 비목 이름과 같은
        // 데이터 행이 실측에 있다 — `C249="연구수당" K249=0`은 연구수당 표의 데이터 행이지
        // 비목 헤더가 아니다. 접두어를 요구하면 둘이 갈린다.
        const named = label.normalize('NFC');
        if (!numeric || CATEGORY_ORDINAL_PREFIX.test(named)) {
          const classified = classifyLabel(stripCategoryOrdinal(named), context);
          // I-6 모호 별칭(`연구장비재료비`)은 자동 분할 금지라 블록으로 열지 않는다
          if (classified.kind === 'category' && classified.category !== null) {
            openCategory = { category: classified.category, label, row: r };
            structural.push({
              row: r,
              category: classified.category,
              categoryLabel: label,
              categoryRow: r,
              subcategory: null,
            });
            continue;
          }
        }
      }

      // 세목 판정에는 숫자 조건을 그대로 둔다 (D-24 단서): 실측 행안부
      // `C208="소프트웨어 활용비"`처럼 세목과 이름이 같은 데이터 행이 있어, 이 조건을 빼면
      // 표가 그 행에서 쪼개진다
      if (numeric) continue;
      if (openCategory === null) continue;
      const header = matchSubcategoryHeader(
        label,
        openCategory.category,
        section.kind === 'indirect'
      );
      if (header === null) continue;
      structural.push({
        row: r,
        category: openCategory.category,
        categoryLabel: openCategory.label,
        categoryRow: openCategory.row,
        subcategory: header,
      });
    }

    // D-23: 비목 합계 줄은 비목마다 **한 번만** 담는다 — 세목 블록마다 되풀이하면 같은 값이 여러 번 센다.
    // 실제로 블록을 만들 때 소비하므로, 표가 없어 건너뛴 세목 때문에 값이 사라지지 않는다
    const structuralRows = new Set(structural.map((node) => node.row));
    const totalsTaken = new Set<number>();
    const takeCategoryTotals = (categoryRow: number): number[] => {
      if (totalsTaken.has(categoryRow)) return [];
      totalsTaken.add(categoryRow);
      return findCategoryTotalRows(cells, width, categoryRow, structuralRows, section, sectionEnd, context);
    };

    for (let i = 0; i < structural.length; i += 1) {
      const node = structural[i]!;
      const from = node.row + 1;
      const to = (structural[i + 1]?.row ?? sectionEnd + 1) - 1;
      if (to < from) continue;

      const tables = findTables(cells, width, from, to);
      if (tables.length === 0) {
        // 세목을 거느린 비목 헤더는 자기 표가 없다 — 정상이다. 하지만 내용이 있는데 헤더를
        // 못 찾았다면 조용히 버리지 않고 드러낸다 (CLAUDE.md 5번)
        if (!hasContent(cells, width, from, to)) continue;
        const categoryTotalRows = takeCategoryTotals(node.categoryRow);
        // 그 구간의 내용이 비목 합계 줄뿐이면 헤더가 없는 것이 정상이다 (D-23) — 겁주지 않는다
        const onlyTotals = !hasContent(cells, width, from, to, categoryTotalRows);
        blocks.push(
          makeBlock(section, node, {
            tableIndex: 0,
            headerRows: [],
            columns: [],
            roles: {},
            dataStartRow: from,
            dataEndRow: to,
            categoryTotalRows,
            extraIssues: onlyTotals ? [] : ['no-column-header'],
          })
        );
        continue;
      }

      tables.forEach((table, tableIndex) => {
        const columns = buildColumns(cells, width, table.headerRows);
        const roles = buildRoleMap(columns);
        let resolution: Resolution | null = null;
        if (node.subcategory !== null) {
          const base = resolveSubcategory(node.subcategory);
          resolution =
            node.subcategory.numberCodes.length > 1
              ? resolveMultiCodeTable(
                  node.category,
                  base,
                  node.subcategory,
                  firstDataLabel(cells, width, table, columns, roles),
                  tables.length
                )
              : base;
        }
        blocks.push(
          makeBlock(section, node, {
            tableIndex,
            headerRows: table.headerRows,
            columns,
            roles,
            dataStartRow: table.dataStartRow,
            dataEndRow: table.dataEndRow,
            resolution,
            categoryTotalRows: tableIndex === 0 ? takeCategoryTotals(node.categoryRow) : [],
          })
        );
      });
    }
  }

  return blocks;
}

interface BlockParts {
  tableIndex: number;
  headerRows: number[];
  columns: DetailColumn[];
  roles: Partial<Record<DetailColumnRole, number>>;
  dataStartRow: number;
  dataEndRow: number;
  resolution?: Resolution | null;
  extraIssues?: DetailBlockIssue[];
  categoryTotalRows?: number[];
}

function makeBlock(
  section: DetailSection,
  node: StructuralRow,
  parts: BlockParts
): DetailBlock {
  const resolution = parts.resolution ?? null;
  const issues = [...(resolution?.issues ?? []), ...(parts.extraIssues ?? [])];
  return {
    section: section.kind,
    category: node.category,
    categoryLabel: node.categoryLabel,
    categoryRow: node.categoryRow,
    subcategory: resolution?.subcategory ?? null,
    subcategoryLabel: node.subcategory?.label ?? null,
    subcategoryRow: node.subcategory === null ? null : node.row,
    numberToken: node.subcategory?.numberToken ?? null,
    resolvedBy: resolution?.resolvedBy ?? null,
    numberCandidates: [...(node.subcategory?.numberCodes ?? [])],
    needsConfirm: issues.length > 0,
    issues,
    headerRows: parts.headerRows,
    columns: parts.columns,
    roles: parts.roles,
    dataStartRow: parts.dataStartRow,
    dataEndRow: parts.dataEndRow,
    tableIndex: parts.tableIndex,
    categoryTotalRows: parts.categoryTotalRows ?? [],
  };
}

// ─── D-5·D-8~D-10·D-21 행 변환 ───────────────────────────────

/** D-21: 금액 0인 행. 근거가 아예 없는 빈 줄(①)은 애초에 결과에 담기지 않는다 */
export type DetailRowStatus = 'included' | 'skip-suggested';

export type DetailRowIssue =
  /** I-12: 금액 셀이 수식 에러이거나 숫자로 읽히지 않는다 — 0으로 삼키지 않는다 */
  | 'amount-unparsable'
  /** I-11: 소수 금액을 원 단위로 반올림했다 */
  | 'amount-rounded'
  /** 표에 금액 열(현금·현물·합계)이 하나도 없다 */
  | 'no-amount-column'
  /** D-10: 원화가 아닌 통화 기호가 보인다 — 환율을 지어내지 않는다 */
  | 'currency'
  /** D-21 ②: 근거는 있는데 금액이 0이다 */
  | 'zero-amount'
  /** D-8a: 인건비 행인데 파일에 연봉이 없다 — 산식의 근거가 비었다 */
  | 'salary-missing';

/**
 * 산출 행 초안 (§5.17 BudgetDetail로 눕히기 직전의 형태).
 *
 * 세목(`subcategory`)이 null일 수 있다 — D-3a대로 시트에 세목 헤더가 없으면 파서는 지어내지 않고
 * 그대로 통과시킨다. 세목을 정하는 것도, 성명을 Member에 잇는 것도 detail-preview.ts의 몫이다.
 */
export interface DetailDraftRow {
  /** 0-based 시트 행. 미리보기가 원본을 가리킬 수 있게 남긴다 */
  row: number;
  /** D-9로 한 행이 축 둘로 갈렸을 때 0·1 */
  axisIndex: number;
  /** 블록 안의 표시 순서 (§5.17 order) */
  order: number;
  section: DetailSectionKind;
  category: BudgetCategory;
  /** D-3a: 세목 헤더가 없으면 null 그대로다 */
  subcategory: string | null;
  formula: DetailFormula;
  axis: DetailAxis;
  /** D-9: 합계 열만 있어 현금으로 **제안**했다. 자동 확정이 아니다 */
  axisSuggested: boolean;
  name: string;
  spec: string;
  unitPrice: number;
  factors: DetailFactor[];
  note: string;
  // ─ 인건비 원본 보존. 성명 매칭(D-11~D-13)·연봉 대조(D-8a·D-14)는 detail-preview.ts가 한다 ─
  memberName: string | null;
  position: string | null;
  /** 파일의 인력구분 원문 (`기존인력`/`신규채용`). HireType 변환은 D-12의 몫이다 */
  hireTypeLabel: string | null;
  /**
   * D-3a ②: 행에 적힌 인건비 세목 라벨 원문 (`내부인건비`/`외부인건비`/`연구지원인력인건비`).
   * 실측 행안부에만 있다. **`hireTypeLabel`과 다른 축이다** — 이쪽은 세목, 저쪽은 기존/신규다.
   * 이 라벨로 세목을 정하는 것은 detail-preview.ts의 몫이다.
   *
   * 파서는 인건비 행에서 언제나 채운다(없으면 null). 손으로 만든 초안에서는 생략할 수 있다.
   */
  personnelKindLabel?: string | null;
  /** 파일의 연봉. **명부 연봉이 아니다** (D-8a) */
  fileSalary: number | null;
  /** PL-1/PL-3 산식 결과 (조정액 0으로 계산). personnel이면 **파일 연봉** 기준이다 */
  formulaAmount: number;
  /** 파일의 합계 열 값 — D-8의 진실 */
  fileAmount: number;
  /** D-8: `파일 합계 − 산식 결과` */
  adjustment: number;
  /** 조정액으로 흡수한 차액이 있는가 — 미리보기가 드러낸다 (조용히 넣지 않는다) */
  absorbed: boolean;
  /**
   * D-8a 경계: personnel 행의 `formulaAmount`·`adjustment`는 **파일 연봉**으로 낸 잠정값이다.
   * 최종 조정액은 **명부 연봉**(`Member.annualSalary`)으로 다시 내야 하며 그 확정은
   * detail-preview.ts가 한다 — 파서는 명부를 모른다.
   */
  adjustmentProvisional: boolean;
  status: DetailRowStatus;
  issues: DetailRowIssue[];
  /** 사용자 확인 없이 반영하면 안 되는가 */
  needsConfirm: boolean;
}

/** D-5: 데이터에서 뺀 소계 행의 값. D-18 대조에 쓴다 */
export interface FileSubtotal {
  row: number;
  /** 소계 행의 라벨 원문 (`소 계`, `합계`) */
  label: string;
  /** 엑셀 열 문자 (부록 B.8.3이 `J88`처럼 셀 주소로 말한다) */
  column: string;
  columnIndex: number;
  axis: DetailAxis | 'total';
  value: number;
  /** I-12 파싱 실패. null이 아니면 value를 믿으면 안 된다 */
  error: AmountError | null;
}

/** D-10: 원화가 아닌 통화 기호를 본 자리 */
export interface CurrencyWarning {
  symbol: string;
  /** 근거 텍스트 (헤더 원문 또는 셀 텍스트) */
  text: string;
  row: number;
  column: string;
}

export interface DetailRowsResult {
  rows: DetailDraftRow[];
  subtotals: FileSubtotal[];
  /** null이 아니면 그 블록의 모든 행이 needsConfirm이다 (D-10) */
  currency: CurrencyWarning | null;
}

// 인건비 인자 라벨은 부록 A.5 프리셋에서 파생한다 — 여기 다시 적으면 두 사전이 반드시 어긋난다.
// 인건비 세목 5종이 모두 `참여율(%)`(isPercent) + `참여기간(월)` 한 쌍이다 (PL-1).
const PERSONNEL_FACTOR_DEFS = SUBCATEGORY_PRESETS.personnel[0]!.defaultFactors;
const RATE_FACTOR_LABEL = PERSONNEL_FACTOR_DEFS.find((f) => f.isPercent)!.label;
const PERIOD_FACTOR_LABEL = PERSONNEL_FACTOR_DEFS.find((f) => !f.isPercent)!.label;

// D-10: 원화(`₩`·`￦`)는 경고 대상이 아니다. 전각 변형까지 함께 본다
const FOREIGN_CURRENCY = /[$＄¥￥€£￡]/;

/**
 * 인자 값의 배수. 인자는 소수를 허용하는데(§5.17 `참여율 10.5`) `parseAmountCell`은 원 단위
 * **정수**로 반올림한다 — 그래서 100만 배로 읽고 도로 나눠 소수를 살린다.
 * I-8 콤마·통화 기호·괄호 음수 규칙을 그대로 쓰기 위한 재사용이다 (새 숫자 파서를 만들지 않는다).
 */
const FACTOR_SCALE = 1000000;

type AmountRole = 'cashTotal' | 'inKindTotal' | 'total';

const AXIS_OF_AMOUNT_ROLE: Readonly<Record<AmountRole, DetailAxis | 'total'>> = {
  cashTotal: 'cash',
  inKindTotal: 'in_kind',
  total: 'total',
};

interface ParsedAmount {
  column: DetailColumn;
  value: number;
  rounded: boolean;
  error: AmountError | null;
}

function columnOfRole(block: DetailBlock, role: DetailColumnRole): DetailColumn | undefined {
  return block.columns.find((column) => column.role === role);
}

function textOf(
  cells: readonly (readonly RawCell[])[],
  row: number,
  column: DetailColumn | undefined
): string {
  return column === undefined ? '' : cellText(cellAt(cells, row, column.index));
}

function amountOf(
  cells: readonly (readonly RawCell[])[],
  row: number,
  column: DetailColumn | undefined
): ParsedAmount | null {
  if (column === undefined) return null;
  const parsed = parseAmountCell(cellAt(cells, row, column.index), 1);
  return { column, value: parsed.amount ?? 0, rounded: parsed.rounded, error: parsed.error };
}

/**
 * 인자 하나. 빈 칸은 **인자가 없다는 뜻**이라 null이다 — 0으로 읽으면 곱이 0이 되어 근거가 사라진다.
 *
 * D-22: 엑셀 백분율 서식 셀은 저장값이 100배 작다(`10.0%` → `0.1`). 어댑터가 알려 준
 * `percentFormat`일 때만 100을 곱해 사람이 보는 숫자로 되돌린다 — 추측하지 않는다.
 * 곱셈을 나눗셈보다 **먼저** 해서(정수 × 100) 부동소수점 오차를 만들지 않는다.
 */
function factorOf(
  cells: readonly (readonly RawCell[])[],
  row: number,
  column: DetailColumn | undefined,
  label: string,
  isPercent: boolean
): DetailFactor | null {
  if (column === undefined) return null;
  const cell = cellAt(cells, row, column.index);
  if (cellText(cell) === '') return null;
  const parsed = parseAmountCell(cell, FACTOR_SCALE);
  if (!parsed.ok || parsed.amount === null) return null;
  const scaled = cell.percentFormat === true ? parsed.amount * 100 : parsed.amount;
  return { label, value: scaled / FACTOR_SCALE, isPercent };
}

/**
 * D-3a ②: 인건비 행의 `내부인건비`/`외부인건비`/`연구지원인력인건비` 라벨.
 * 실측 행안부는 `C`열에 있고 산자부에는 없다.
 *
 * **role을 새로 만들지 않고 값으로 찾는다**: 이 라벨이 앉는 열의 헤더가 실측에서 `구 분`인데,
 * 그것은 `인력 구분`(기존인력/신규채용)과 글자가 겹쳐 role로 만들면 hireType과 뒤섞인다.
 * 두 열은 **다른 축**이다. 세목을 정하는 것은 detail-preview.ts의 몫이고(D-3a) 여기서는 재료만 준다.
 */
function personnelKindLabelOf(
  cells: readonly (readonly RawCell[])[],
  row: number,
  columns: readonly DetailColumn[],
  category: BudgetCategory
): string | null {
  const table = lookupTableOf(category);
  for (const column of columns) {
    const text = cellText(cellAt(cells, row, column.index));
    if (text === '') continue;
    if (table[subcategoryLookupKey(text)] !== undefined) return text;
  }
  return null;
}

/**
 * D-10: 헤더·셀에서 원화가 아닌 통화 기호를 찾는다. 헤더를 먼저 보는 이유는 실측 행안부
 * `⑥ 소프트웨어 활용비`의 `합계($)`가 헤더에 있어서다. 환율은 지어내지 않고 확인만 요구한다.
 */
function detectCurrency(
  cells: readonly (readonly RawCell[])[],
  block: DetailBlock
): CurrencyWarning | null {
  const topRow = block.headerRows[0];
  const bottomRow = block.headerRows[1];
  for (const column of block.columns) {
    for (const [text, row] of [
      [column.top, topRow],
      [column.bottom, bottomRow],
    ] as const) {
      if (row === undefined) continue;
      const match = FOREIGN_CURRENCY.exec(text);
      if (match) return { symbol: match[0], text, row, column: column.column };
    }
  }
  for (let r = block.dataStartRow; r <= block.dataEndRow; r += 1) {
    for (const column of block.columns) {
      const text = cellText(cellAt(cells, r, column.index));
      const match = FOREIGN_CURRENCY.exec(text);
      if (match) return { symbol: match[0], text, row: r, column: column.column };
    }
  }
  return null;
}

/** 표가 차지하는 열 범위. D-6대로 오른쪽 메모 열은 이미 buildColumns가 잘라냈다 */
function columnSpan(block: DetailBlock): { from: number; to: number } {
  let from = Number.MAX_SAFE_INTEGER;
  let to = -1;
  for (const column of block.columns) {
    from = Math.min(from, column.index);
    to = Math.max(to, column.index);
  }
  return { from: to === -1 ? 0 : from, to };
}

/** 행의 대표 라벨 — 표 안에서 처음 만나는 텍스트와 그 열. 소계 판정(D-5·D-23)의 재료다 */
function rowLabelCell(
  cells: readonly (readonly RawCell[])[],
  row: number,
  span: { from: number; to: number }
): { text: string; column: number } {
  for (let c = span.from; c <= span.to; c += 1) {
    const text = cellText(cellAt(cells, row, c));
    if (text !== '') return { text, column: c };
  }
  return { text: '', column: -1 };
}

/**
 * D-25: 이 행이 **세로 병합 안쪽**이고 자기 값이 하나도 없는가.
 *
 * 원본(`raw`)에는 병합 좌상단에만 값이 있고 S-11 확장본에는 아래 행까지 펼쳐져 있다.
 * 표 범위 안에서 원본이 통째로 비었는데 세로 병합에 덮여 있으면 그 행은 시작 행의 복제다
 * (실측 `⑤ 국내출장비` C186:C187…K186:K187).
 *
 * "병합 범위 안이면 무조건 건너뛴다"로 하지 않는 이유: 품명만 세로로 병합하고 규격·금액은
 * 행마다 다른 서식이 흔하다. 그런 행은 **자기 값이 있으므로** 여기서 살아남아야 한다 —
 * 아니면 금액이 조용히 사라진다. 가로 병합만으로는 건너뛰지 않는 이유도 같다.
 */
function isMergeContinuationRow(
  raw: readonly (readonly RawCell[])[],
  merges: readonly MergeRange[],
  row: number,
  span: { from: number; to: number }
): boolean {
  const insideVerticalMerge = merges.some(
    (merge) =>
      merge.e.r > merge.s.r &&
      row > merge.s.r &&
      row <= merge.e.r &&
      merge.e.c >= span.from &&
      merge.s.c <= span.to
  );
  if (!insideVerticalMerge) return false;
  for (let c = span.from; c <= span.to; c += 1) {
    if (cellText(cellAt(raw, row, c)) !== '') return false;
  }
  return true;
}

interface AxisSlot {
  axis: DetailAxis;
  amount: number;
  suggested: boolean;
  rounded: boolean;
  error: AmountError | null;
  missingColumn: boolean;
}

/**
 * D-9 축 판정.
 *
 * 현금·현물 열이 **둘 다 값이면 행을 둘로 나눈다** — §5.17은 행마다 축이 하나이기 때문이다.
 * 합계 열만 있는 세목(활동비 대부분·연구수당·간접비)은 현금으로 **제안**하되 확정하지 않는다.
 * 축 열이 둘 다 비었는데 합계에는 값이 있으면 합계를 쓴다 — 그러지 않으면 금액이 통째로 사라진다.
 */
function resolveAxes(
  cash: ParsedAmount | null,
  inKind: ParsedAmount | null,
  total: ParsedAmount | null
): AxisSlot[] {
  const slot = (parsed: ParsedAmount, axis: DetailAxis, suggested: boolean): AxisSlot => ({
    axis,
    amount: parsed.value,
    suggested,
    rounded: parsed.rounded,
    error: parsed.error,
    missingColumn: false,
  });

  /** 값이 있거나 읽지 못한 열. 0은 "이 축이 아니다"라는 뜻이라 축을 만들지 않는다 */
  const used = (parsed: ParsedAmount | null): parsed is ParsedAmount =>
    parsed !== null && (parsed.value !== 0 || parsed.error !== null);

  if (used(cash) && used(inKind)) return [slot(cash, 'cash', false), slot(inKind, 'in_kind', false)];
  if (used(cash)) return [slot(cash, 'cash', false)];
  if (used(inKind)) return [slot(inKind, 'in_kind', false)];

  // 축 열이 비었어도 합계에 값이 있으면 그것이 금액이다. 축은 제안일 뿐이다
  if (total !== null && (total.value !== 0 || total.error !== null)) {
    return [slot(total, 'cash', true)];
  }
  if (cash !== null) return [slot(cash, 'cash', false)];
  if (total !== null) return [slot(total, 'cash', true)];
  if (inKind !== null) return [slot(inKind, 'in_kind', false)];

  return [
    { axis: 'cash', amount: 0, suggested: true, rounded: false, error: null, missingColumn: true },
  ];
}

/**
 * D-23: 비목 합계 줄을 `subtotals`로만 담는다. 데이터 행으로 만들지 않는다 —
 * 비목 총계를 산출 행으로 세면 그 비목의 금액이 두 배가 된다.
 *
 * 컬럼 헤더가 없는 자리에 오는 경우가 많아(실측 `L150`) 열 role을 모를 수 있다.
 * 그럴 때 축은 `'total'`로 둔다 — 비목 합계 줄에 현금·현물이 갈려 적힌 실측 사례가 없고,
 * 지어낸 축으로 D-18 대조를 어긋나게 만드는 것보다 낫다.
 */
function collectCategoryTotals(
  cells: readonly (readonly RawCell[])[],
  width: number,
  block: DetailBlock,
  subtotals: FileSubtotal[]
): void {
  const axisByIndex = new Map<number, DetailAxis | 'total'>();
  for (const column of block.columns) {
    if (column.role === 'cashTotal') axisByIndex.set(column.index, 'cash');
    else if (column.role === 'inKindTotal') axisByIndex.set(column.index, 'in_kind');
    else if (column.role === 'total') axisByIndex.set(column.index, 'total');
  }

  for (const row of block.categoryTotalRows ?? []) {
    // 줄을 가리키는 라벨은 `합계`다 — 같은 행의 비목 라벨(`다. 연구시설·장비비`)이나
    // 오른쪽 메모가 아니라 그것을 쓴다
    let label = '';
    for (let c = 0; c < width; c += 1) {
      const text = cellText(cellAt(cells, row, c));
      if (text === '' || label !== '') continue;
      if (classifyLabel(text).kind === 'skip') label = text;
    }
    for (let c = 0; c < width; c += 1) {
      const cell = cellAt(cells, row, c);
      if (!isNumericCell(cell)) continue;
      const parsed = parseAmountCell(cell, 1);
      const value = parsed.amount ?? 0;
      if (value === 0 && parsed.error === null) continue;
      subtotals.push({
        row,
        label,
        column: indexToColumnLetter(c),
        columnIndex: c,
        axis: axisByIndex.get(c) ?? 'total',
        value,
        error: parsed.error,
      });
    }
  }
}

/**
 * D-5·D-8·D-8a·D-9·D-10·D-21. 블록 하나의 데이터 행을 산출근거 초안으로 바꾸고,
 * 소계 행의 값을 따로 모은다.
 *
 * **소계에서 멈추지 않는다** (D-5): 인건비는 `합계`(기존인력) → `합계`(신규채용) → `소 계`의
 * 3단이고, 첫 소계에서 멈추면 신규채용 금액을 통째로 놓친다 (부록 B.8.1).
 *
 * **파일의 합계 열이 진실이다** (D-8): 산식 결과와의 차액을 `adjustment`가 흡수한다.
 * 단 인건비의 조정액은 **잠정**이다 — 산식 기준 연봉은 명부(`Member.annualSalary`)인데
 * 파서는 명부를 모르기 때문이다 (D-8a). 여기서 확정하면 저장값과 재계산값이 어긋난다.
 *
 * 컬럼 헤더를 못 찾은 블록(`no-column-header`)은 읽을 표가 없어 행이 나오지 않는다 —
 * 그 사실은 블록의 `issues`가 이미 드러내고 있다. 다만 D-23 비목 합계 줄은 그런 블록에도
 * 실려 오므로 **표가 없어도 소계는 담는다.**
 */
export function parseDetailRows(
  sheet: RawSheet,
  block: DetailBlock,
  context?: MatchContext
): DetailRowsResult {
  const rows: DetailDraftRow[] = [];
  const subtotals: FileSubtotal[] = [];
  const cells = expandMerges(sheet).cells;
  const categoryTotalRows = block.categoryTotalRows ?? [];

  collectCategoryTotals(cells, gridWidth(cells), block, subtotals);
  if (block.columns.length === 0) return { rows, subtotals, currency: null };

  const span = columnSpan(block);
  const currency = detectCurrency(cells, block);

  // PL-D3: 비목이 산식을 정한다. 인건비 셀에 단가 행이 섞이면 §6.10.3 기준액이 흔들린다
  const formula: DetailFormula =
    block.category === 'personnel' || block.category === 'student_personnel'
      ? 'personnel'
      : 'quantity';

  const cashColumn = columnOfRole(block, 'cashTotal');
  const inKindColumn = columnOfRole(block, 'inKindTotal');
  const totalColumn = columnOfRole(block, 'total');
  const amountColumns = block.columns.filter(
    (column): column is DetailColumn & { role: AmountRole } =>
      column.role === 'cashTotal' || column.role === 'inKindTotal' || column.role === 'total'
  );
  const nameColumn = columnOfRole(block, 'name');
  const specColumn = columnOfRole(block, 'spec');
  const unitPriceColumn = columnOfRole(block, 'unitPrice');
  const noteColumn = columnOfRole(block, 'note');
  const memberColumn = columnOfRole(block, 'memberName');
  const positionColumn = columnOfRole(block, 'position');
  const salaryColumn = columnOfRole(block, 'salary');
  const hireTypeColumn = columnOfRole(block, 'hireType');
  const rateColumn = columnOfRole(block, 'rate');
  const periodColumn = columnOfRole(block, 'period');
  const factorColumns = block.columns.filter((column) => column.role === 'factor');

  let order = 0;
  let carriedPersonnelKind: string | null = null;

  for (let r = block.dataStartRow; r <= block.dataEndRow; r += 1) {
    // D-23: 비목 합계 줄은 이미 담았다 (collectCategoryTotals) — 다시 읽으면 두 번 센다
    if (categoryTotalRows.includes(r)) continue;

    // D-25: 세로 병합의 **시작 행에서만** 행을 만든다. 병합 안쪽 행은 S-11 확장으로 값이
    // 펼쳐져 있을 뿐 자기 값이 없다 — 그대로 읽으면 같은 행을 두 번 세어 금액이 두 배가 된다
    // (실측 `⑤ 국내출장비` C186:C187…K186:K187, 1,200,000 → 2,400,000).
    if (isMergeContinuationRow(sheet.cells, sheet.merges, r, span)) continue;

    const { text: label, column: labelColumn } = rowLabelCell(cells, r, span);

    // D-5: 소계·합계는 데이터가 아니다. 값만 챙기고 **계속 읽는다**
    if (label !== '' && classifyLabel(label, context).kind === 'skip') {
      // D-23: 표의 라벨 자리를 비워 두고 **금액 열**에 `합계`를 적은 줄은 이 세목의 소계가 아니라
      // 비목 합계 줄이다 (실측 `K246="합계"` 바로 아래가 `C247="자. 연구수당"`). 여기서 담으면
      // 그 세목의 D-18 대조가 엉뚱한 값과 비교된다 — 담는 것은 그 비목의 첫 블록이다.
      // 라벨 열이 아예 없는 표에서는 판단 근거가 없으므로 그대로 소계로 담는다
      const labelInAmountColumn = amountColumns.some((column) => column.index === labelColumn);
      const hasLabelArea = block.columns.some(
        (column) =>
          column.index < labelColumn &&
          column.role !== 'cashTotal' &&
          column.role !== 'inKindTotal' &&
          column.role !== 'total'
      );
      if (labelInAmountColumn && hasLabelArea) continue;
      for (const column of amountColumns) {
        const parsed = amountOf(cells, r, column);
        if (parsed === null) continue;
        // 0은 빈 칸과 구분되지 않아 대조 대상으로 삼지 않는다 (파일의 빈 소계 칸이 대부분이다)
        if (parsed.value === 0 && parsed.error === null) continue;
        subtotals.push({
          row: r,
          label,
          column: column.column,
          columnIndex: column.index,
          axis: AXIS_OF_AMOUNT_ROLE[column.role],
          value: parsed.value,
          error: parsed.error,
        });
      }
      continue;
    }

    const name = textOf(cells, r, nameColumn);
    const spec = textOf(cells, r, specColumn);
    const note = textOf(cells, r, noteColumn);
    const memberName = textOf(cells, r, memberColumn);
    const position = textOf(cells, r, positionColumn);
    const hireTypeLabel = textOf(cells, r, hireTypeColumn);
    // D-3a ②: 행에 적힌 세목 라벨(`내부인건비` 등). 인건비류에만 있다.
    // **아래로 이어받는다** (S-2와 같은 이유): 실측 행안부는 그룹의 첫 행에만 `내부인건비`를 적고
    // 나머지 행은 비운다. 이어받지 않으면 D-3a ②가 그 한 행에서만 동작한다
    if (formula === 'personnel') {
      const own = personnelKindLabelOf(cells, r, block.columns, block.category);
      if (own !== null) carriedPersonnelKind = own;
    }
    const personnelKindLabel = formula === 'personnel' ? carriedPersonnelKind : null;

    // 단가·인자를 못 읽으면 산식 결과가 틀어지지만 금액은 파일 값이 진실이라 그대로다 (D-8) —
    // 차액을 조정액이 떠안고 `absorbed`가 미리보기에 드러내므로 조용히 묻히지 않는다
    const unitPriceParsed = amountOf(cells, r, unitPriceColumn);
    const unitPrice = unitPriceParsed?.value ?? 0;
    const salaryParsed = amountOf(cells, r, salaryColumn);
    const fileSalary =
      salaryParsed === null || textOf(cells, r, salaryColumn) === '' ? null : salaryParsed.value;

    const factors: DetailFactor[] =
      formula === 'personnel'
        ? ([
            factorOf(cells, r, rateColumn, RATE_FACTOR_LABEL, true),
            factorOf(cells, r, periodColumn, PERIOD_FACTOR_LABEL, false),
          ].filter((factor): factor is DetailFactor => factor !== null))
        : factorColumns
            // PL-3: 라벨은 헤더 텍스트 그대로다 — 실측 `시트(수량)`가 프리셋의 `수량`과 다르다
            .map((column) => factorOf(cells, r, column, column.label, false))
            .filter((factor): factor is DetailFactor => factor !== null);

    const axes = resolveAxes(
      amountOf(cells, r, cashColumn),
      amountOf(cells, r, inKindColumn),
      amountOf(cells, r, totalColumn)
    );

    // D-21 ①: 근거가 전부 비었고 금액도 0인 서식의 빈 줄. 비고는 근거가 아니다
    const hasEvidence =
      name !== '' ||
      spec !== '' ||
      memberName !== '' ||
      position !== '' ||
      hireTypeLabel !== '' ||
      unitPrice !== 0 ||
      fileSalary !== null ||
      factors.some((factor) => factor.value !== 0);
    const hasAmount = axes.some((slot) => slot.amount !== 0 || slot.error !== null);
    if (!hasEvidence && !hasAmount) continue;

    const salaryMissing = formula === 'personnel' && fileSalary === null;

    axes.forEach((slot, axisIndex) => {
      // D-8: 산식은 다시 구현하지 않는다. 조정액 0으로 산식 결과만 얻어 차액을 흡수한다.
      // D-8a: personnel이면 여기 쓰는 연봉은 **파일 연봉**이다 — 명부 연봉으로 낸 최종 조정액은
      // detail-preview.ts가 확정한다. 파서가 확정하면 저장값과 재계산값이 어긋난다
      const formulaAmount = computeDetailAmount(
        {
          yearId: '',
          category: block.category,
          subcategory: block.subcategory ?? '',
          axis: slot.axis,
          formula,
          memberId: null,
          unitPrice,
          adjustment: 0,
          factors,
        },
        formula === 'personnel' ? { id: '', annualSalary: fileSalary } : null
      ).amount;

      const fileAmount = slot.amount;
      // D-8a: 연봉을 모르면 조정액은 **0**이다. 파일 값을 맞추려고 금액 전부를 조정액에 넣으면
      // 나중에 연봉이 채워지는 순간 `산식 + 파일금액`이 되어 두 배가 된다 — 조용히 터지는 지뢰다.
      // 그때는 금액이 아니라 "근거가 비었다"는 사실을 드러내는 것이 맞다
      const adjustment = salaryMissing ? 0 : fileAmount - formulaAmount;

      const issues: DetailRowIssue[] = [];
      if (slot.error !== null) issues.push('amount-unparsable');
      if (slot.rounded) issues.push('amount-rounded');
      if (slot.missingColumn) issues.push('no-amount-column');
      if (currency !== null) issues.push('currency');
      if (salaryMissing) issues.push('salary-missing');
      // D-21 ②: 이름·단가는 있는데 금액이 0인 행은 사람이 적어 둔 자리다. 조용히 버리지 않는다
      const zeroAmount = fileAmount === 0 && slot.error === null;
      if (zeroAmount && !slot.missingColumn) issues.push('zero-amount');

      rows.push({
        row: r,
        axisIndex,
        order,
        section: block.section,
        category: block.category,
        subcategory: block.subcategory,
        formula,
        axis: slot.axis,
        axisSuggested: slot.suggested,
        name: formula === 'personnel' ? '' : name, // PL-D1: personnel 행은 name을 쓰지 않는다
        spec,
        unitPrice: formula === 'personnel' ? 0 : unitPrice, // PL-D1: 단가는 명부 연봉이다
        factors,
        note,
        memberName: memberName === '' ? null : memberName,
        position: position === '' ? null : position,
        hireTypeLabel: hireTypeLabel === '' ? null : hireTypeLabel,
        personnelKindLabel,
        fileSalary,
        formulaAmount,
        fileAmount,
        adjustment,
        absorbed: adjustment !== 0,
        adjustmentProvisional: formula === 'personnel',
        status: zeroAmount ? 'skip-suggested' : 'included',
        issues,
        needsConfirm: issues.length > 0,
      });
      order += 1;
    });
  }

  return { rows, subtotals, currency };
}

// ─── D-18 소계 대조 ──────────────────────────────────────────

/**
 * 대조에 쓴 합의 범위. 다단 소계(D-5)에서 각 단은 구간 합이고 마지막 `소 계`는 누적 합이다.
 * `all`은 넘겨받은 행 전부 — 비목 합계 줄이 **데이터보다 위**에 오는 서식(D-23의 `L150`)이 있어서다.
 */
export type SubtotalScope = 'segment' | 'cumulative' | 'all';

export interface SubtotalComparison {
  label: string;
  row: number;
  column: string;
  axis: DetailAxis | 'total';
  /** 파일의 소계 값 */
  fileValue: number;
  /** 대조에 채택한 우리 합 */
  ourSum: number;
  scope: SubtotalScope;
  /** 직전 소계 이후의 행 합 */
  segmentSum: number;
  /** 첫 행부터의 누적 합 */
  cumulativeSum: number;
  /** 넘겨받은 행 전부의 합 (소계 줄의 위치를 따지지 않는다) */
  totalSum: number;
  /** `fileValue - ourSum`. 0이 아니면 미리보기가 양쪽을 나란히 보여 준다 */
  difference: number;
  matches: boolean;
}

function sumRows(
  rows: readonly DetailDraftRow[],
  axis: DetailAxis | 'total',
  fromRow: number,
  toRow: number
): number {
  let sum = 0;
  for (const row of rows) {
    if (row.row < fromRow || row.row > toRow) continue;
    if (axis !== 'total' && row.axis !== axis) continue;
    sum += row.fileAmount;
  }
  return sum;
}

/**
 * D-18: 파일의 소계와 우리 합을 대조한다. **어긋나도 반영을 막지 않는다** — 파일 소계가
 * 수식 오류이거나 사람이 손으로 덮어쓴 값일 수 있고, 어느 쪽이 맞는지는 사람이 안다.
 *
 * 소계는 세 뜻으로 쓰인다: 다단 구조(D-5)의 각 `합계`는 **직전 소계 이후 구간**의 합이고,
 * 마지막 `소 계`는 **누적** 합이며, 비목 합계 줄은 **자기 위에 행이 하나도 없을 수 있다**
 * (D-23의 `C149="마. 연구활동비"` → `L150` — 합계가 데이터보다 위에 온다). 위에 행이 없으면
 * 넘겨받은 행 전부와 대조하고, 아니면 구간 → 누적 → 전체 순으로 파일 값과 맞는 쪽을 채택한다.
 * 셋 다 결과에 실어 미리보기가 사람에게 그대로 보여 줄 수 있게 한다.
 *
 * 여러 블록에 걸친 비목 합계(부록 B.8.3 `L150`)는 그 비목의 행 전부와 그 소계 하나를 함께
 * 넘겨 대조한다 — 블록을 합치는 것은 미리보기(detail-preview.ts)의 몫이다.
 */
export function compareSubtotals(
  rows: readonly DetailDraftRow[],
  subtotals: readonly FileSubtotal[]
): SubtotalComparison[] {
  const ordered = [...subtotals].sort((a, b) => a.row - b.row || a.columnIndex - b.columnIndex);
  const boundaries = [...new Set(ordered.map((subtotal) => subtotal.row))].sort((a, b) => a - b);

  return ordered.map((subtotal) => {
    const previous = boundaries.filter((row) => row < subtotal.row).pop() ?? -1;
    const segmentSum = sumRows(rows, subtotal.axis, previous + 1, subtotal.row - 1);
    const cumulativeSum = sumRows(rows, subtotal.axis, Number.MIN_SAFE_INTEGER, subtotal.row - 1);
    const totalSum = sumRows(rows, subtotal.axis, Number.MIN_SAFE_INTEGER, Number.MAX_SAFE_INTEGER);
    const hasRowsAbove = rows.some((row) => row.row < subtotal.row);

    let scope: SubtotalScope = 'segment';
    if (!hasRowsAbove) scope = 'all';
    else if (segmentSum !== subtotal.value) {
      if (cumulativeSum === subtotal.value) scope = 'cumulative';
      else if (totalSum === subtotal.value) scope = 'all';
    }
    const ourSum =
      scope === 'all' ? totalSum : scope === 'cumulative' ? cumulativeSum : segmentSum;
    return {
      label: subtotal.label,
      row: subtotal.row,
      column: subtotal.column,
      axis: subtotal.axis,
      fileValue: subtotal.value,
      ourSum,
      scope,
      segmentSum,
      cumulativeSum,
      totalSum,
      difference: subtotal.value - ourSum,
      matches: subtotal.error === null && subtotal.value === ourSum,
    };
  });
}
