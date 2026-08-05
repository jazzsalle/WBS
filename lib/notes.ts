// 노트 순수 함수 (SOT §5.14, §7.12)
//
// 마크다운은 **외부 라이브러리 없이 제한된 부분집합만** 파싱한다. 결과는 HTML 문자열이
// 아니라 데이터(AST)이고, 렌더는 React 엘리먼트로만 한다(MarkdownViewer). 이유는 하나다 —
// 노트 본문은 사용자 입력이고, dangerouslySetInnerHTML로 그리는 순간 저장형 XSS가 된다.
// AST에는 "HTML을 그리라"는 표현 자체가 없으므로 <script>·on* 속성·javascript: URL이
// 본문에 들어와도 그냥 글자로 남는다. 이 성질을 tests/unit/notes.test.ts가 고정한다.
//
// 지원 문법: 제목(#~######), 굵게(**), 기울임(*), 인라인 코드(`), 코드블록(```),
//            목록(-/*/+, 1.), 체크박스(- [ ] / - [x]), 인용(>), 구분선(---), 링크([]())
// 지원하지 않는 문법은 원문 그대로 글자로 보인다. 조용히 사라지지 않는다(절대 규칙 5).

import type { Note, NoteType } from '@/types';

// ─── 마크다운 AST ─────────────────────────────────────────────

export type MdInline =
  | { kind: 'text'; text: string }
  | { kind: 'code'; text: string }
  | { kind: 'strong'; children: MdInline[] }
  | { kind: 'em'; children: MdInline[] }
  | { kind: 'link'; href: string; children: MdInline[] };

export interface MdListItem {
  /** null이면 체크박스 없는 일반 항목 */
  checked: boolean | null;
  /** 들여쓰기 단계 (공백 2칸 = 1단계). 렌더는 여백으로만 표현한다 */
  depth: number;
  children: MdInline[];
}

export type MdBlock =
  | { kind: 'heading'; level: 1 | 2 | 3 | 4 | 5 | 6; children: MdInline[] }
  | { kind: 'paragraph'; children: MdInline[] }
  | { kind: 'codeBlock'; lang: string; text: string }
  | { kind: 'quote'; lines: MdInline[][] }
  | { kind: 'list'; ordered: boolean; items: MdListItem[] }
  | { kind: 'hr' };

/**
 * 링크로 만들어도 되는 URL인지 판정한다.
 *
 * 허용 스킴은 http/https/mailto **뿐**이다. `javascript:`·`data:`·`vbscript:`는 물론이고
 * 프로토콜 상대 경로(`//evil`)나 모르는 스킴도 전부 거부한다 — 판단이 서지 않는 URL을
 * 링크로 만들지 않는 쪽이 항상 안전하다. 거부된 링크는 사라지지 않고 원문 글자로 남는다.
 *
 * 스킴 검사 전에 제어문자·공백을 제거한다. `java\tscript:alert(1)` 같은 변형은
 * 브라우저가 공백을 무시하고 해석하므로, 제거하지 않으면 검사를 통과해 버린다.
 */
export function isSafeUrl(raw: string): boolean {
  // 스킴 검사 전에 제어문자·공백류를 걷어낸다. 'java\tscript:'처럼 사이에 탭·개행을 끼운
  // 변형은 브라우저가 무시하고 해석하므로, 지우지 않으면 검사를 그대로 통과해 버린다.
  const cleaned = raw.replace(
    /[\u0000-\u0020\u007f-\u00a0\u1680\u2000-\u200f\u2028\u2029\u202f\u205f\u3000\ufeff]/g,
    ''
  );
  if (cleaned === '') return false;
  const scheme = /^([a-zA-Z][a-zA-Z0-9+.-]*):/.exec(cleaned);
  if (!scheme) return false; // 스킴이 없는 상대 경로도 링크로 만들지 않는다
  const name = (scheme[1] ?? '').toLowerCase();
  return name === 'http' || name === 'https' || name === 'mailto';
}

function matchLink(src: string, start: number): { node: MdInline; next: number } | null {
  const close = src.indexOf(']', start + 1);
  if (close < 0 || src[close + 1] !== '(') return null;
  const end = src.indexOf(')', close + 2);
  if (end < 0) return null;

  const href = src.slice(close + 2, end).trim();
  if (!isSafeUrl(href)) {
    // 링크로 만들지 않고 원문을 그대로 글자로 남긴다 (사용자가 무엇을 썼는지 보이게)
    return { node: { kind: 'text', text: src.slice(start, end + 1) }, next: end + 1 };
  }
  return {
    node: { kind: 'link', href, children: parseInline(src.slice(start + 1, close)) },
    next: end + 1,
  };
}

export function parseInline(src: string): MdInline[] {
  const out: MdInline[] = [];
  let buffer = '';
  let i = 0;

  const flush = (): void => {
    if (buffer !== '') {
      out.push({ kind: 'text', text: buffer });
      buffer = '';
    }
  };

  while (i < src.length) {
    const ch = src[i] as string;

    // 코드 스팬이 가장 강하다 — 안에 든 **·[]()는 문법이 아니라 글자다
    if (ch === '`') {
      const end = src.indexOf('`', i + 1);
      if (end > i + 1) {
        flush();
        out.push({ kind: 'code', text: src.slice(i + 1, end) });
        i = end + 1;
        continue;
      }
    }

    if (ch === '[') {
      const matched = matchLink(src, i);
      if (matched) {
        flush();
        out.push(matched.node);
        i = matched.next;
        continue;
      }
    }

    if ((ch === '*' || ch === '_') && src[i + 1] === ch) {
      const end = src.indexOf(ch + ch, i + 2);
      if (end > i + 1) {
        flush();
        out.push({ kind: 'strong', children: parseInline(src.slice(i + 2, end)) });
        i = end + 2;
        continue;
      }
    }

    if (ch === '*' || ch === '_') {
      const end = src.indexOf(ch, i + 1);
      if (end > i + 1) {
        flush();
        out.push({ kind: 'em', children: parseInline(src.slice(i + 1, end)) });
        i = end + 1;
        continue;
      }
    }

    buffer += ch;
    i += 1;
  }

  flush();
  return out;
}

const HEADING_RE = /^(#{1,6})\s+(.*)$/;
const HR_RE = /^\s{0,3}(?:-{3,}|\*{3,}|_{3,})\s*$/;
const QUOTE_RE = /^\s{0,3}>\s?(.*)$/;
const BULLET_RE = /^(\s*)([-*+])\s+(.*)$/;
const ORDERED_RE = /^(\s*)(\d{1,9})[.)]\s+(.*)$/;
const CHECKBOX_RE = /^\[([ xX])\]\s*(.*)$/;
const FENCE_RE = /^\s*```(.*)$/;

function toListItem(indent: string, rest: string): MdListItem {
  const checkbox = CHECKBOX_RE.exec(rest);
  return {
    checked: checkbox ? (checkbox[1] ?? ' ').toLowerCase() === 'x' : null,
    depth: Math.min(Math.floor(indent.replace(/\t/g, '  ').length / 2), 5),
    children: parseInline(checkbox ? (checkbox[2] ?? '') : rest),
  };
}

/** 마크다운 원문을 블록 AST로 바꾼다. HTML 문자열은 어디에서도 만들지 않는다. */
export function parseMarkdown(source: string): MdBlock[] {
  const lines = source.replace(/\r\n?/g, '\n').split('\n');
  const blocks: MdBlock[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i] as string;

    if (line.trim() === '') {
      i += 1;
      continue;
    }

    const fence = FENCE_RE.exec(line);
    if (fence) {
      const lang = (fence[1] ?? '').trim();
      const body: string[] = [];
      i += 1;
      while (i < lines.length && !FENCE_RE.test(lines[i] as string)) {
        body.push(lines[i] as string);
        i += 1;
      }
      i += 1; // 닫는 펜스. 없으면 파일 끝이라 그대로 넘어간다
      blocks.push({ kind: 'codeBlock', lang, text: body.join('\n') });
      continue;
    }

    if (HR_RE.test(line)) {
      blocks.push({ kind: 'hr' });
      i += 1;
      continue;
    }

    const heading = HEADING_RE.exec(line);
    if (heading) {
      blocks.push({
        kind: 'heading',
        level: (heading[1] ?? '#').length as 1 | 2 | 3 | 4 | 5 | 6,
        children: parseInline(heading[2] ?? ''),
      });
      i += 1;
      continue;
    }

    if (QUOTE_RE.test(line)) {
      const quoted: MdInline[][] = [];
      while (i < lines.length) {
        const matched = QUOTE_RE.exec(lines[i] as string);
        if (!matched) break;
        quoted.push(parseInline(matched[1] ?? ''));
        i += 1;
      }
      blocks.push({ kind: 'quote', lines: quoted });
      continue;
    }

    const bullet = BULLET_RE.exec(line);
    const ordered = ORDERED_RE.exec(line);
    if (bullet || ordered) {
      const isOrdered = !bullet;
      const items: MdListItem[] = [];
      while (i < lines.length) {
        const current = lines[i] as string;
        const nextBullet = BULLET_RE.exec(current);
        const nextOrdered = ORDERED_RE.exec(current);
        // 종류가 바뀌면 다른 목록이다 — 한 블록에 섞지 않는다
        if (isOrdered ? !nextOrdered : !nextBullet) break;
        const matched = (isOrdered ? nextOrdered : nextBullet) as RegExpExecArray;
        items.push(toListItem(matched[1] ?? '', matched[3] ?? ''));
        i += 1;
      }
      blocks.push({ kind: 'list', ordered: isOrdered, items });
      continue;
    }

    // 문단: 빈 줄이나 다른 블록이 나올 때까지 이어 붙인다. 줄바꿈은 렌더에서 보존한다.
    const paragraph: string[] = [];
    while (i < lines.length) {
      const current = lines[i] as string;
      if (
        current.trim() === '' ||
        HEADING_RE.test(current) ||
        HR_RE.test(current) ||
        QUOTE_RE.test(current) ||
        BULLET_RE.test(current) ||
        ORDERED_RE.test(current) ||
        FENCE_RE.test(current)
      ) {
        break;
      }
      paragraph.push(current);
      i += 1;
    }
    blocks.push({ kind: 'paragraph', children: parseInline(paragraph.join('\n')) });
  }

  return blocks;
}

// ─── 회의록 템플릿 · 참석자 줄 (§7.12) ────────────────────────

/** 본문 상단 참석자 줄. 사람 이름이 아니라 라벨로 찾으므로 이름이 바뀌어도 줄을 잃지 않는다 */
const ATTENDEE_LINE_RE = /^\s*[-*+]?\s*참석자\s*:/;

function attendeeLine(names: readonly string[]): string {
  return `- 참석자: ${names.join(', ')}`;
}

/**
 * §7.12 "참석자는 Member에서 다중 선택 (자동으로 본문 상단에 삽입)".
 * 이미 참석자 줄이 있으면 그 줄만 갈아끼우고, 없으면 본문 맨 위에 넣는다 —
 * 선택을 바꿀 때마다 줄이 쌓이면 회의록이 금방 못 쓰게 된다.
 */
export function applyAttendeeLine(body: string, names: readonly string[]): string {
  const lines = body.replace(/\r\n?/g, '\n').split('\n');
  const index = lines.findIndex((line) => ATTENDEE_LINE_RE.test(line));

  if (index >= 0) {
    if (names.length === 0) {
      lines.splice(index, 1);
      return lines.join('\n');
    }
    lines[index] = attendeeLine(names);
    return lines.join('\n');
  }

  if (names.length === 0) return body;
  return body.trim() === '' ? `${attendeeLine(names)}\n` : `${attendeeLine(names)}\n${body}`;
}

export interface MeetingTemplateInput {
  /** 'YYYY-MM-DD'. 호출자가 todayISO(§6.5)로 만든 값을 넘긴다 — 여기서 new Date()를 쓰지 않는다 */
  date: string;
  place?: string;
  attendeeNames?: readonly string[];
}

/** §7.12 회의록 골격: 일시 / 장소 / 참석자 / 안건 / 논의 / 결정사항 / 액션아이템 */
export function buildMeetingTemplate({
  date,
  place = '',
  attendeeNames = [],
}: MeetingTemplateInput): string {
  return [
    '## 회의 개요',
    `- 일시: ${date}`,
    `- 장소: ${place}`,
    attendeeLine(attendeeNames),
    '',
    '## 안건',
    '1. ',
    '',
    '## 논의',
    '- ',
    '',
    '## 결정사항',
    '- ',
    '',
    '## 액션아이템',
    '- [ ] (담당자) 할 일 — 기한',
    '',
  ].join('\n');
}

// ─── 목록 정렬 · 필터 (§7.12) ─────────────────────────────────

/** §7.12 "고정(pinned) 상단 → 날짜 내림차순". 같은 날짜는 생성 시각 내림차순으로 고정한다 */
export function sortNotes(notes: readonly Note[]): Note[] {
  return [...notes].sort((a, b) => {
    if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
    if (a.date !== b.date) return a.date < b.date ? 1 : -1;
    if (a.createdAt !== b.createdAt) return a.createdAt < b.createdAt ? 1 : -1;
    return a.id.localeCompare(b.id);
  });
}

export interface NoteFilter {
  type?: NoteType | null;
  yearId?: string | null;
  tag?: string | null;
  /** §7.12 전문 검색 — 제목·본문·태그를 모두 훑는다 */
  query?: string;
}

function haystack(note: Note): string {
  return `${note.title}\n${note.body}\n${note.tags.join(' ')}`.toLowerCase();
}

/** 공백으로 나눈 모든 낱말이 들어 있어야 한다(AND). 낱말 순서는 보지 않는다 */
export function matchesQuery(note: Note, query: string): boolean {
  const terms = query.trim().toLowerCase().split(/\s+/).filter((t) => t !== '');
  if (terms.length === 0) return true;
  const target = haystack(note);
  return terms.every((term) => target.includes(term));
}

export function filterNotes(notes: readonly Note[], filter: NoteFilter): Note[] {
  return notes.filter((note) => {
    if (filter.type != null && note.type !== filter.type) return false;
    if (filter.yearId != null && note.yearId !== filter.yearId) return false;
    if (filter.tag != null && !note.tags.includes(filter.tag)) return false;
    if (filter.query != null && !matchesQuery(note, filter.query)) return false;
    return true;
  });
}

/** 필터 드롭다운용 태그 목록. 중복 제거 + 사전순 */
export function collectTags(notes: readonly Note[]): string[] {
  return [...new Set(notes.flatMap((note) => note.tags))].sort((a, b) => a.localeCompare(b, 'ko'));
}

/** 쉼표 구분 입력 → 태그 배열. 공백·중복·빈 값 제거 */
export function parseTags(raw: string): string[] {
  return [...new Set(raw.split(',').map((t) => t.trim()).filter((t) => t !== ''))];
}
