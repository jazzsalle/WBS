// hwpx 섹션 XML → 표 격자 (SOT §6.18 HX-1·HX-2, S-15·S-16·S-24·S-26, U-9).
//
// 클라이언트·Node 공용 순수 함수다(S-33). section XML은 18MB급이라 문서 전체를 트리로 파싱하지 않고,
// `hp:tbl` 시작·끝 태그를 깊이를 세며 훑어 가장 바깥 표 단위로 잘라 그 조각만 파싱한다(S-24).
// 표 밖 본문(수백 쪽 문단)은 트리로 만들지 않는다.

import { XMLParser } from 'fast-xml-parser';
import type { HwpxExtractResult, HwpxTable } from './types';

/** preserveOrder 출력 노드: 태그 이름 키 하나(자식 배열) 또는 '#text', 속성은 ':@' */
type XNode = Record<string, unknown>;

const ATTR = ':@';
const TEXT = '#text';

const parser = new XMLParser({
  preserveOrder: true,
  ignoreAttributes: false,
  attributeNamePrefix: '',
  // 셀 값 `007`·`1,000`·` ` 같은 원문을 그대로 둔다 — 해석은 행 해석(T6)이 필드별로 한다
  parseTagValue: false,
  parseAttributeValue: false,
  trimValues: false,
  ignoreDeclaration: true,
  ignorePiTags: true,
});

function tagOf(node: XNode): string | undefined {
  for (const k of Object.keys(node)) if (k !== ATTR) return k;
  return undefined;
}

function childrenOf(node: XNode): XNode[] {
  const tag = tagOf(node);
  if (tag === undefined || tag === TEXT) return [];
  const c = node[tag];
  return Array.isArray(c) ? (c as XNode[]) : [];
}

function attrOf(node: XNode, name: string): string | undefined {
  const a = node[ATTR] as Record<string, unknown> | undefined;
  const v = a?.[name];
  return v === undefined ? undefined : String(v);
}

function childTag(node: XNode, tag: string): XNode | undefined {
  return childrenOf(node).find((c) => tagOf(c) === tag);
}

/** 음 아닌 정수 속성만 받는다 — 빈 값·소수·음수는 구조가 깨진 것으로 본다 */
function intAttr(node: XNode | undefined, name: string): number | undefined {
  if (!node) return undefined;
  const v = attrOf(node, name);
  if (v === undefined || !/^\d+$/.test(v.trim())) return undefined;
  return Number(v.trim());
}

// ---------------------------------------------------------------------------
// 깊이 인식 스캔
// ---------------------------------------------------------------------------

const OPEN = '<hp:tbl';
const CLOSE = '</hp:tbl>';

/** `<hp:tbl` 뒤가 이름의 끝인지 — `<hp:tblX` 같은 다른 태그를 잘못 세지 않게 */
function isOpenAt(xml: string, i: number): boolean {
  const c = xml.charCodeAt(i + OPEN.length);
  return c === 0x20 || c === 0x09 || c === 0x0a || c === 0x0d || c === 0x3e /* > */ || c === 0x2f; /* / */
}

function nextOpen(xml: string, from: number): number {
  let i = xml.indexOf(OPEN, from);
  while (i !== -1 && !isOpenAt(xml, i)) i = xml.indexOf(OPEN, i + OPEN.length);
  return i;
}

function isSelfClosing(xml: string, openAt: number): boolean {
  const end = xml.indexOf('>', openAt);
  return end !== -1 && xml.charCodeAt(end - 1) === 0x2f;
}

/**
 * 가장 바깥 `hp:tbl` 조각들. 중첩 표는 바깥 조각 안에 들어 있다.
 * 태그 짝이 맞지 않으면 던진다 — 잘린 XML을 조용히 일부만 읽으면 표가 사라져도 모른다.
 */
export function sliceOuterTables(xml: string): string[] {
  const out: string[] = [];
  let pos = 0;
  for (;;) {
    const start = nextOpen(xml, pos);
    if (start === -1) {
      if (xml.indexOf(CLOSE, pos) !== -1) throw new Error('hwpx 표 태그 짝이 맞지 않습니다');
      return out;
    }
    if (xml.indexOf(CLOSE, pos) !== -1 && xml.indexOf(CLOSE, pos) < start) {
      throw new Error('hwpx 표 태그 짝이 맞지 않습니다');
    }
    if (isSelfClosing(xml, start)) {
      const end = xml.indexOf('>', start) + 1;
      out.push(xml.slice(start, end));
      pos = end;
      continue;
    }
    let depth = 1;
    let cursor = xml.indexOf('>', start) + 1;
    while (depth > 0) {
      const o = nextOpen(xml, cursor);
      const c = xml.indexOf(CLOSE, cursor);
      if (c === -1) throw new Error('hwpx 표 태그 짝이 맞지 않습니다');
      if (o !== -1 && o < c) {
        if (!isSelfClosing(xml, o)) depth++;
        cursor = xml.indexOf('>', o) + 1;
      } else {
        depth--;
        cursor = c + CLOSE.length;
      }
    }
    out.push(xml.slice(start, cursor));
    pos = cursor;
  }
}

// ---------------------------------------------------------------------------
// 셀 텍스트 (S-16, U-9)
// ---------------------------------------------------------------------------

/** `hp:t`의 혼합 내용. 여기 없는 인라인 요소는 글자를 싣지 않는다(실측: 이 넷뿐) */
function textOfT(t: XNode): string {
  let s = '';
  for (const c of childrenOf(t)) {
    const tag = tagOf(c);
    if (tag === TEXT) s += String(c[TEXT]);
    else if (tag === 'hp:lineBreak') s += '\n';
    else if (tag === 'hp:tab' || tag === 'hp:fwSpace') s += ' ';
    else if (tag === 'hp:hypen') s += '-';
  }
  return s;
}

/**
 * 문단 텍스트 = run들의 `hp:t` 조각을 이은 것. run의 다른 자식 — 수식·그림·그룹 도형(U-9), `hp:ctrl` 아래
 * 각주·미주, 중첩 표 — 은 읽지 않는다. 중첩 표는 따로 격자로 나온다.
 */
function textOfParagraph(p: XNode): string {
  let s = '';
  for (const run of childrenOf(p)) {
    if (tagOf(run) !== 'hp:run') continue;
    for (const c of childrenOf(run)) if (tagOf(c) === 'hp:t') s += textOfT(c);
  }
  return s;
}

function textOfCell(tc: XNode): string {
  const sub = childTag(tc, 'hp:subList');
  if (!sub) return '';
  const paras = childrenOf(sub)
    .filter((c) => tagOf(c) === 'hp:p')
    .map(textOfParagraph);
  // 빈 문단만 있는 셀을 '\n\n'으로 내보내면 행 해석이 "값 있음"으로 오판한다
  return paras.every((p) => p === '') ? '' : paras.join('\n');
}

// ---------------------------------------------------------------------------
// 격자 (HX-2)
// ---------------------------------------------------------------------------

/** 병합 확장 격자. 구조가 rowCnt·colCnt와 맞지 않으면 null — 자르거나 채워 넣지 않는다 */
function buildGrid(tbl: XNode): { rowCnt: number; colCnt: number; cells: string[][] } | null {
  const rowCnt = intAttr(tbl, 'rowCnt');
  const colCnt = intAttr(tbl, 'colCnt');
  if (rowCnt === undefined || colCnt === undefined) return null;
  const trs = childrenOf(tbl).filter((c) => tagOf(c) === 'hp:tr');
  if (trs.length !== rowCnt) return null;

  const cells: string[][] = Array.from({ length: rowCnt }, () => Array<string>(colCnt).fill(''));
  const filled: boolean[][] = Array.from({ length: rowCnt }, () => Array<boolean>(colCnt).fill(false));

  for (const tr of trs) {
    for (const tc of childrenOf(tr)) {
      if (tagOf(tc) !== 'hp:tc') continue;
      const addr = childTag(tc, 'hp:cellAddr');
      const span = childTag(tc, 'hp:cellSpan');
      const col = intAttr(addr, 'colAddr');
      const row = intAttr(addr, 'rowAddr');
      // cellSpan이 없으면 병합 없는 칸이다
      const colSpan = span ? intAttr(span, 'colSpan') : 1;
      const rowSpan = span ? intAttr(span, 'rowSpan') : 1;
      if (col === undefined || row === undefined || colSpan === undefined || rowSpan === undefined) return null;
      if (colSpan < 1 || rowSpan < 1) return null;
      if (row + rowSpan > rowCnt || col + colSpan > colCnt) return null;

      const text = textOfCell(tc);
      for (let r = row; r < row + rowSpan; r++) {
        // 범위는 위에서 검사했다 — 행 배열은 반드시 있다
        const filledRow = filled[r]!;
        const cellRow = cells[r]!;
        for (let c = col; c < col + colSpan; c++) {
          if (filledRow[c]) return null;
          filledRow[c] = true;
          cellRow[c] = text;
        }
      }
    }
  }
  return { rowCnt, colCnt, cells };
}

/** 문서(시작 태그) 순서로 표를 모은다 — 바깥 표 다음에 그 안의 중첩 표(S-26 index 정의) */
function collectTables(nodes: XNode[], out: XNode[]): void {
  for (const n of nodes) {
    if (tagOf(n) === 'hp:tbl') out.push(n);
    collectTables(childrenOf(n), out);
  }
}

export function extractHwpxTables(sections: { section: number; xml: string }[]): HwpxExtractResult {
  const ordered = [...sections].sort((a, b) => a.section - b.section);
  const result: HwpxExtractResult = { tables: [], skipped: [] };
  let index = 0;

  for (const { section, xml } of ordered) {
    for (const fragment of sliceOuterTables(xml)) {
      const tbls: XNode[] = [];
      collectTables(parser.parse(fragment) as XNode[], tbls);
      for (const tbl of tbls) {
        const grid = buildGrid(tbl);
        if (grid) {
          const table: HwpxTable = { index, section, ...grid };
          result.tables.push(table);
        } else {
          result.skipped.push({ index, section, reason: 'structure-mismatch' });
        }
        index++;
      }
    }
  }
  return result;
}
