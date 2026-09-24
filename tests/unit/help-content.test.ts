// 도움말·따라하기 본문 파일 검사 (SOT §7.16 HP-1·HP-2·HP-6, §7.17 TU-7) — 파일을 읽는 정적 스캔.
//
// content/**.md는 서버가 fs로 읽어 lib/notes.ts로 파싱한다. 파서가 모르는 문법(표)은 원문
// 그대로 보이고 상대 링크는 글자로 남는다 — 그래서 파일 쪽에서 미리 막는다(HP-6·TU-7).
// T3(도움말 본문)·T4(튜토리얼 본문)가 끝나기 전에는 파일 부재로 실패하는 것이 **정상**이다 —
// 없는 파일을 건너뛰면 slug 누락이 조용히 통과한다(절대 규칙 5, evaluation_criteria Phase 14).

import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { parseMarkdown } from '@/lib/notes';
import {
  HELP_SCREEN_SLUGS,
  HELP_SLUGS,
  TUTORIAL_STEP_SLUGS,
  parseHelpHead,
  parseTutorialHead,
} from '@/lib/help';

const ROOT = path.resolve(__dirname, '../..');
const HELP_DIR = path.join(ROOT, 'content/help');
const TUTORIAL_DIR = path.join(ROOT, 'content/tutorial');

/** HP-6: A4 한 쪽 이내 */
const MAX_HELP_CHARS = 3500;

/** 상대 링크 `](/help#x)`·`](wbs)` — 파서가 링크로 만들지 않는다(HP-6·TU-7). 절대 URL만 허용 */
const RELATIVE_LINK = /\]\((?!https?:\/\/|mailto:)[^)]*\)/g;
/** 표 행 — 파서 미지원(HP-6). 코드블록 안은 제외한다 */
const TABLE_ROW = /^\s*\|/;

function readIfExists(file: string): string | null {
  return fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null;
}

/** 코드블록(```) 안은 검사에서 뺀다 — 예시로 적은 `|`·상대 경로는 글자다 */
function proseLines(source: string): string[] {
  const out: string[] = [];
  let inFence = false;
  for (const line of source.replace(/\r\n?/g, '\n').split('\n')) {
    if (/^\s*```/.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (!inFence) out.push(line);
  }
  return out;
}

function headingTexts(source: string): string[] {
  return parseMarkdown(source)
    .filter((b) => b.kind === 'heading')
    .map((b) => (b.kind === 'heading' ? b.children.map((n) => ('text' in n ? n.text : '')).join('') : ''));
}

// ─── content/help (HP-1·HP-6) ────────────────────────────────────────────────

describe('content/help — 17편 (HP-1)', () => {
  it('HELP_SLUGS 17개 파일이 모두 있다', () => {
    const missing = HELP_SLUGS.filter((slug) => !fs.existsSync(path.join(HELP_DIR, `${slug}.md`)));
    expect(missing, `없는 도움말: ${missing.join(', ')} (T3 미완이면 정상)`).toEqual([]);
  });

  it('레지스트리에 없는 파일이 content/help에 남아 있지 않다', () => {
    if (!fs.existsSync(HELP_DIR)) return; // 위 테스트가 이미 실패로 알린다
    const extra = fs
      .readdirSync(HELP_DIR)
      .filter((name) => name.endsWith('.md'))
      .map((name) => name.replace(/\.md$/, ''))
      .filter((slug) => !(HELP_SLUGS as readonly string[]).includes(slug));
    expect(extra, 'HELP_SLUGS에 등록되지 않은 파일은 목차·`?`에서 닿을 수 없다').toEqual([]);
  });

  describe.each(HELP_SLUGS)('content/help/%s.md', (slug) => {
    const file = path.join(HELP_DIR, `${slug}.md`);
    const source = readIfExists(file);

    it('1행 `# 제목`·2행 `> 언제 쓰나:` (HP-6)', () => {
      expect(source, `파일 없음: content/help/${slug}.md`).not.toBeNull();
      const head = parseHelpHead(source ?? '');
      expect(head, JSON.stringify(head)).not.toHaveProperty('error');
    });

    it('표 행(`|`로 시작)이 없다 — 파서 미지원(HP-2·HP-6)', () => {
      expect(source).not.toBeNull();
      const rows = proseLines(source ?? '').filter((l) => TABLE_ROW.test(l));
      expect(rows, '표는 목록으로 바꾸세요').toEqual([]);
    });

    it('상대 링크가 없다 — 파서가 링크로 만들지 않는다(HP-6)', () => {
      expect(source).not.toBeNull();
      const links = proseLines(source ?? '').join('\n').match(RELATIVE_LINK) ?? [];
      expect(links, '관련 도움말은 lib/help.ts HELP_RELATED로 페이지가 그립니다').toEqual([]);
    });

    it(`${MAX_HELP_CHARS}자 이하 (HP-6 A4 한 쪽)`, () => {
      expect(source).not.toBeNull();
      expect((source ?? '').length).toBeLessThanOrEqual(MAX_HELP_CHARS);
    });
  });

  describe.each(HELP_SCREEN_SLUGS)('화면 도움말 content/help/%s.md 구성 (HP-6)', (slug) => {
    it('`## 할 수 있는 것`·`## 자주 하는 실수` 헤딩이 있다', () => {
      const source = readIfExists(path.join(HELP_DIR, `${slug}.md`));
      expect(source, `파일 없음: content/help/${slug}.md`).not.toBeNull();
      const headings = headingTexts(source ?? '');
      expect(headings).toContain('할 수 있는 것');
      expect(headings).toContain('자주 하는 실수');
    });
  });
});

// ─── content/tutorial (TU-7) ─────────────────────────────────────────────────

describe('content/tutorial — 9단계 (TU-7)', () => {
  it('TUTORIAL_STEP_SLUGS 9개 파일이 모두 있다', () => {
    const missing = TUTORIAL_STEP_SLUGS.filter(
      (step) => !fs.existsSync(path.join(TUTORIAL_DIR, `${step}.md`))
    );
    expect(missing, `없는 단계 본문: ${missing.join(', ')} (T4 미완이면 정상)`).toEqual([]);
  });

  describe.each(TUTORIAL_STEP_SLUGS)('content/tutorial/%s.md', (step) => {
    const source = readIfExists(path.join(TUTORIAL_DIR, `${step}.md`));

    it('1행 `# 단계명`·2행 `> 할 일:` (TU-7)', () => {
      expect(source, `파일 없음: content/tutorial/${step}.md`).not.toBeNull();
      const head = parseTutorialHead(source ?? '');
      expect(head, JSON.stringify(head)).not.toHaveProperty('error');
    });

    it('`## 버튼은 어디에`·`## 완료되면` 헤딩이 있고 링크·표가 없다 (TU-7)', () => {
      expect(source).not.toBeNull();
      const headings = headingTexts(source ?? '');
      expect(headings).toContain('버튼은 어디에');
      expect(headings).toContain('완료되면');
      const prose = proseLines(source ?? '');
      // 링크는 본문에 쓰지 않는다 — [이 화면으로]·도움말 링크는 lib/tutorial.ts로 UI가 그린다
      expect(prose.join('\n').match(/\]\([^)]*\)/g) ?? []).toEqual([]);
      expect(prose.filter((l) => TABLE_ROW.test(l))).toEqual([]);
    });
  });
});

// ─── 배포·렌더 경계 (HP-1·HP-2) ─────────────────────────────────────────────

describe('배포·렌더 경계', () => {
  it('next.config.ts outputFileTracingIncludes에 ./content/**가 있다 (HP-1)', () => {
    const config = fs.readFileSync(path.join(ROOT, 'next.config.ts'), 'utf8');
    expect(config).toContain('outputFileTracingIncludes');
    expect(config, 'standalone 산출물에서 content/가 통째로 빠진다').toContain('"./content/**"');
  });

  it('app·components에 dangerouslySetInnerHTML이 없다 (HP-2, CLAUDE.md)', () => {
    // 주석("dangerouslySetInnerHTML을 쓰지 않는다")은 위반이 아니다 — 코드 줄만 본다
    const usesInCode = (source: string): boolean =>
      source
        .split(/\r?\n/)
        .filter((line) => !/^\s*(\/\/|\/\*|\*)/.test(line))
        .some((line) => line.includes('dangerouslySetInnerHTML'));
    const offenders: string[] = [];
    const walk = (dir: string): void => {
      if (!fs.existsSync(dir)) return;
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (/\.(ts|tsx)$/.test(entry.name) && usesInCode(fs.readFileSync(full, 'utf8'))) {
          offenders.push(path.relative(ROOT, full).split(path.sep).join('/'));
        }
      }
    };
    walk(path.join(ROOT, 'app'));
    walk(path.join(ROOT, 'components'));
    expect(offenders).toEqual([]);
  });
});
