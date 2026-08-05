// lib/notes.ts 단위 테스트 (SOT §5.14, §7.12)
//
// 이 파일의 첫 번째 목적은 **XSS가 구조적으로 불가능하다는 사실을 고정하는 것**이다.
// 파서는 HTML 문자열을 만들지 않고 AST만 만든다 — 그래서 <script>·on* 속성은 'text'
// 노드(= 글자)로만 나올 수 있고, 위험한 스킴의 링크는 'link' 노드가 되지 못한다.
// 렌더러(MarkdownViewer)는 이 AST만 React 엘리먼트로 옮기므로 주입 경로 자체가 없다.

import { describe, expect, it } from 'vitest';
import type { MdBlock, MdInline } from '@/lib/notes';
import {
  applyAttendeeLine,
  buildMeetingTemplate,
  collectTags,
  filterNotes,
  isSafeUrl,
  matchesQuery,
  parseInline,
  parseMarkdown,
  parseTags,
  sortNotes,
} from '@/lib/notes';
import type { Note, NoteType } from '@/types';

// ─── 헬퍼 ─────────────────────────────────────────────────────

/** AST 전체를 훑어 text·code 노드의 글자를 모은다 (원문이 사라지지 않았는지 확인용) */
function collectText(blocks: MdBlock[]): string {
  const fromInline = (nodes: MdInline[]): string =>
    nodes
      .map((node) => {
        switch (node.kind) {
          case 'text':
          case 'code':
            return node.text;
          case 'strong':
          case 'em':
          case 'link':
            return fromInline(node.children);
        }
      })
      .join('');

  return blocks
    .map((block) => {
      switch (block.kind) {
        case 'heading':
        case 'paragraph':
          return fromInline(block.children);
        case 'codeBlock':
          return block.text;
        case 'quote':
          return block.lines.map(fromInline).join('\n');
        case 'list':
          return block.items.map((item) => fromInline(item.children)).join('\n');
        case 'hr':
          return '';
      }
    })
    .join('\n');
}

/** AST 안에 link 노드가 하나라도 있는지 */
function hasLink(blocks: MdBlock[]): boolean {
  const inInline = (nodes: MdInline[]): boolean =>
    nodes.some((node) => {
      if (node.kind === 'link') return true;
      if (node.kind === 'strong' || node.kind === 'em') return inInline(node.children);
      return false;
    });

  return blocks.some((block) => {
    switch (block.kind) {
      case 'heading':
      case 'paragraph':
        return inInline(block.children);
      case 'quote':
        return block.lines.some(inInline);
      case 'list':
        return block.items.some((item) => inInline(item.children));
      default:
        return false;
    }
  });
}

let seq = 0;
function makeNote(patch: Partial<Note> = {}): Note {
  seq += 1;
  return {
    id: `note-${seq}`,
    createdAt: `2026-01-0${(seq % 9) + 1}T00:00:00.000Z`,
    updatedAt: '2026-01-01T00:00:00.000Z',
    version: 1,
    createdBy: null,
    updatedBy: null,
    projectId: 'p1',
    yearId: null,
    taskId: null,
    milestoneId: null,
    type: 'meeting' as NoteType,
    title: '노트',
    body: '',
    date: '2026-01-01',
    attendeeMemberIds: [],
    tags: [],
    pinned: false,
    ...patch,
  };
}

// ─── XSS 방어 (완료 기준 4) ───────────────────────────────────

describe('마크다운은 HTML을 만들지 않는다 — 스크립트·이벤트 핸들러가 실행될 수 없다', () => {
  it('<script> 태그는 글자로만 남는다 (AST에 html 종류 자체가 없다)', () => {
    const source = '# 제목\n\n<script>alert(1)</script>\n\n본문';
    const blocks = parseMarkdown(source);

    // 원문이 조용히 사라지지도 않는다 (절대 규칙 5)
    expect(collectText(blocks)).toContain('<script>alert(1)</script>');
    // 'text' 이외의 표현으로는 나올 수 없다 — 파서가 만들 수 있는 종류는 유한하다
    const kinds = new Set(blocks.map((b) => b.kind));
    expect([...kinds].every((k) => ['heading', 'paragraph', 'list', 'quote', 'codeBlock', 'hr'].includes(k))).toBe(true);
  });

  it('on* 속성이 든 태그 문자열도 글자다', () => {
    const blocks = parseMarkdown('<img src=x onerror="alert(1)">');
    expect(blocks).toHaveLength(1);
    expect(blocks[0]?.kind).toBe('paragraph');
    expect(collectText(blocks)).toBe('<img src=x onerror="alert(1)">');
  });

  it('javascript: 링크는 링크가 되지 않고 원문 글자로 남는다', () => {
    for (const href of [
      'javascript:alert(1)',
      'JaVaScRiPt:alert(1)',
      '  javascript:alert(1)',
      'java\tscript:alert(1)',
      'java\nscript:alert(1)',
      'data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==',
      'vbscript:msgbox(1)',
    ]) {
      const blocks = parseMarkdown(`[클릭](${href})`);
      expect(hasLink(blocks), `${href}가 링크로 만들어졌습니다`).toBe(false);
      expect(collectText(blocks)).toContain('클릭');
    }
  });

  it('http/https/mailto만 링크가 된다', () => {
    expect(hasLink(parseMarkdown('[문서](https://example.com/a)'))).toBe(true);
    expect(hasLink(parseMarkdown('[문서](http://example.com)'))).toBe(true);
    expect(hasLink(parseMarkdown('[메일](mailto:a@unes.co.kr)'))).toBe(true);
    // 프로토콜 상대 경로·상대 경로·모르는 스킴은 전부 거부한다
    expect(hasLink(parseMarkdown('[문서](//evil.example)'))).toBe(false);
    expect(hasLink(parseMarkdown('[문서](/local/path)'))).toBe(false);
    expect(hasLink(parseMarkdown('[문서](file:///C:/secret)'))).toBe(false);
  });

  it('isSafeUrl 진리표', () => {
    expect(isSafeUrl('https://a.b')).toBe(true);
    expect(isSafeUrl('HTTP://A.B')).toBe(true);
    expect(isSafeUrl('mailto:a@b.c')).toBe(true);
    expect(isSafeUrl('javascript:alert(1)')).toBe(false);
    expect(isSafeUrl('  java script : alert(1)')).toBe(false);
    expect(isSafeUrl('data:text/html,x')).toBe(false);
    expect(isSafeUrl('')).toBe(false);
    expect(isSafeUrl('#anchor')).toBe(false);
  });

  it('코드 블록·코드 스팬 안의 태그도 글자다', () => {
    const blocks = parseMarkdown('```html\n<script>alert(1)</script>\n```');
    expect(blocks[0]).toEqual({
      kind: 'codeBlock',
      lang: 'html',
      text: '<script>alert(1)</script>',
    });

    const inline = parseInline('`<b onclick="x">`');
    expect(inline).toEqual([{ kind: 'code', text: '<b onclick="x">' }]);
  });
});

// ─── 마크다운 부분집합 ────────────────────────────────────────

describe('parseMarkdown — 지원 문법', () => {
  it('제목 레벨', () => {
    const blocks = parseMarkdown('# 하나\n### 셋');
    expect(blocks[0]).toMatchObject({ kind: 'heading', level: 1 });
    expect(blocks[1]).toMatchObject({ kind: 'heading', level: 3 });
  });

  it('굵게·기울임·인라인 코드', () => {
    expect(parseInline('**굵게**')).toEqual([
      { kind: 'strong', children: [{ kind: 'text', text: '굵게' }] },
    ]);
    expect(parseInline('*기울임*')).toEqual([
      { kind: 'em', children: [{ kind: 'text', text: '기울임' }] },
    ]);
    expect(parseInline('`코드`')).toEqual([{ kind: 'code', text: '코드' }]);
  });

  it('닫히지 않은 표식은 문법이 아니라 글자다', () => {
    expect(parseInline('**미완')).toEqual([{ kind: 'text', text: '**미완' }]);
    expect(parseInline('[링크](미완')).toEqual([{ kind: 'text', text: '[링크](미완' }]);
  });

  it('체크박스 목록 (§5.14 액션 아이템)', () => {
    const blocks = parseMarkdown('- [ ] 할 일\n- [x] 끝난 일\n- 일반 항목');
    expect(blocks).toHaveLength(1);
    const list = blocks[0];
    if (list?.kind !== 'list') throw new Error('목록으로 파싱되지 않았습니다.');
    expect(list.ordered).toBe(false);
    expect(list.items.map((i) => i.checked)).toEqual([false, true, null]);
  });

  it('번호 목록과 글머리 목록은 다른 블록이다', () => {
    const blocks = parseMarkdown('1. 첫째\n2. 둘째\n\n- 별개');
    expect(blocks.map((b) => b.kind)).toEqual(['list', 'list']);
    expect(blocks[0]).toMatchObject({ ordered: true });
    expect(blocks[1]).toMatchObject({ ordered: false });
  });

  it('들여쓴 항목은 depth로 남는다', () => {
    const blocks = parseMarkdown('- 상위\n  - 하위');
    const list = blocks[0];
    if (list?.kind !== 'list') throw new Error('목록으로 파싱되지 않았습니다.');
    expect(list.items.map((i) => i.depth)).toEqual([0, 1]);
  });

  it('인용·구분선·문단', () => {
    const blocks = parseMarkdown('> 인용 첫줄\n> 인용 둘째줄\n\n---\n\n문단 A\n문단 A 이어짐');
    expect(blocks.map((b) => b.kind)).toEqual(['quote', 'hr', 'paragraph']);
    const quote = blocks[0];
    if (quote?.kind !== 'quote') throw new Error('인용으로 파싱되지 않았습니다.');
    expect(quote.lines).toHaveLength(2);
    expect(collectText([blocks[2] as MdBlock])).toBe('문단 A\n문단 A 이어짐');
  });

  it('빈 본문은 빈 블록 목록이다', () => {
    expect(parseMarkdown('')).toEqual([]);
    expect(parseMarkdown('\n\n  \n')).toEqual([]);
  });

  it('CRLF 줄바꿈도 같은 결과를 낸다', () => {
    expect(parseMarkdown('# 제목\r\n- 항목')).toEqual(parseMarkdown('# 제목\n- 항목'));
  });
});

// ─── 회의록 템플릿 · 참석자 줄 (§7.12) ────────────────────────

describe('회의록 템플릿과 참석자 줄', () => {
  it('§7.12가 요구한 7개 골격을 모두 넣는다', () => {
    const template = buildMeetingTemplate({ date: '2026-08-05', attendeeNames: ['김연구', '이선임'] });
    for (const section of ['일시', '장소', '참석자', '안건', '논의', '결정사항', '액션아이템']) {
      expect(template).toContain(section);
    }
    expect(template).toContain('2026-08-05');
    expect(template).toContain('- 참석자: 김연구, 이선임');
    // 액션아이템은 체크박스로 적는다 (§5.14 노트 아래 주석)
    expect(template).toContain('- [ ]');
  });

  it('참석자 줄이 없으면 본문 맨 위에 넣는다', () => {
    expect(applyAttendeeLine('## 논의\n- 내용', ['김연구'])).toBe(
      '- 참석자: 김연구\n## 논의\n- 내용'
    );
  });

  it('이미 있으면 그 줄만 갈아끼운다 (줄이 쌓이지 않는다)', () => {
    const body = '- 참석자: 김연구\n## 논의';
    const once = applyAttendeeLine(body, ['이선임', '박책임']);
    expect(once).toBe('- 참석자: 이선임, 박책임\n## 논의');
    expect(applyAttendeeLine(once, ['이선임']).split('참석자').length - 1).toBe(1);
  });

  it('선택을 모두 해제하면 참석자 줄을 지운다', () => {
    expect(applyAttendeeLine('- 참석자: 김연구\n## 논의', [])).toBe('## 논의');
    expect(applyAttendeeLine('## 논의', [])).toBe('## 논의');
  });
});

// ─── 목록 정렬 · 필터 (§7.12) ─────────────────────────────────

describe('sortNotes / filterNotes', () => {
  it('고정이 항상 위, 그 다음 날짜 내림차순', () => {
    const notes = [
      makeNote({ id: 'a', date: '2026-03-01', pinned: false }),
      makeNote({ id: 'b', date: '2026-01-01', pinned: true }),
      makeNote({ id: 'c', date: '2026-05-01', pinned: false }),
      makeNote({ id: 'd', date: '2026-02-01', pinned: true }),
    ];
    expect(sortNotes(notes).map((n) => n.id)).toEqual(['d', 'b', 'c', 'a']);
  });

  it('유형·연차·태그 필터', () => {
    const notes = [
      makeNote({ id: 'a', type: 'meeting', yearId: 'y1', tags: ['킥오프'] }),
      makeNote({ id: 'b', type: 'issue', yearId: 'y2', tags: ['버그', '킥오프'] }),
      makeNote({ id: 'c', type: 'meeting', yearId: null, tags: [] }),
    ];
    expect(filterNotes(notes, { type: 'meeting' }).map((n) => n.id)).toEqual(['a', 'c']);
    expect(filterNotes(notes, { yearId: 'y2' }).map((n) => n.id)).toEqual(['b']);
    expect(filterNotes(notes, { tag: '킥오프' }).map((n) => n.id)).toEqual(['a', 'b']);
    expect(filterNotes(notes, {}).map((n) => n.id)).toEqual(['a', 'b', 'c']);
  });

  it('전문 검색은 제목·본문·태그를 모두 훑고 낱말 전부를 만족해야 한다', () => {
    const note = makeNote({ title: '킥오프 회의', body: '데이터 수집 일정 확정', tags: ['1차년도'] });
    expect(matchesQuery(note, '킥오프')).toBe(true);
    expect(matchesQuery(note, '수집')).toBe(true);
    expect(matchesQuery(note, '1차년도')).toBe(true);
    expect(matchesQuery(note, '킥오프 일정')).toBe(true);
    expect(matchesQuery(note, '킥오프 예산')).toBe(false);
    expect(matchesQuery(note, '   ')).toBe(true);
  });

  it('태그 수집·파싱', () => {
    const notes = [makeNote({ tags: ['b', 'a'] }), makeNote({ tags: ['a', 'c'] })];
    expect(collectTags(notes)).toEqual(['a', 'b', 'c']);
    expect(parseTags(' 회의 , 킥오프,회의 ,, ')).toEqual(['회의', '킥오프']);
    expect(parseTags('')).toEqual([]);
  });
});
