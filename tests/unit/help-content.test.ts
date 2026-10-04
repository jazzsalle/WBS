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
  helpHeadingId,
  isHelpSlug,
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

describe('content/help — 18편 (HP-1)', () => {
  it('HELP_SLUGS 18개 파일이 모두 있다', () => {
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

// ─── 절 앵커 (HP-4) ──────────────────────────────────────────────────────────

/** app·components의 .tsx 원문 (경로, 내용) */
function readTsxSources(): Array<{ file: string; source: string }> {
  const out: Array<{ file: string; source: string }> = [];
  const walk = (dir: string): void => {
    if (!fs.existsSync(dir)) return;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith('.tsx')) {
        out.push({ file: path.relative(ROOT, full).split(path.sep).join('/'), source: fs.readFileSync(full, 'utf8') });
      }
    }
  };
  walk(path.join(ROOT, 'app'));
  walk(path.join(ROOT, 'components'));
  return out;
}

describe('절 앵커 (HP-4)', () => {
  it('HelpLink의 anchor는 그 편에 실제로 있는 절 제목이다 — 제목을 바꾸면 여기서 깨진다', () => {
    // 속성 순서는 slug → anchor로 쓴다(한 줄 JSX). 변수로 넘기면 정적으로 못 보므로 문자열만 허용
    const usage = /<HelpLink\b[^>]*?\bslug="([^"]+)"[^>]*?\banchor=(?:"([^"]*)"|\{)/g;
    const found: string[] = [];
    const broken: string[] = [];
    for (const { file, source } of readTsxSources()) {
      for (const match of source.matchAll(usage)) {
        const [, slug, anchor] = match;
        if (anchor === undefined) {
          broken.push(`${file}: anchor는 문자열 리터럴로 쓰세요`);
          continue;
        }
        found.push(`${file}: ${slug}#${anchor}`);
        if (!isHelpSlug(slug)) {
          broken.push(`${file}: 모르는 slug ${slug}`);
          continue;
        }
        const source = readIfExists(path.join(HELP_DIR, `${slug}.md`)) ?? '';
        const ids = headingTexts(source).map((text) => helpHeadingId(slug, text));
        if (!ids.includes(helpHeadingId(slug, anchor))) {
          broken.push(`${file}: content/help/${slug}.md에 절 "${anchor}"가 없다`);
        }
      }
    }
    expect(broken).toEqual([]);
    // 수행 모드 화면의 `?`는 협약 예산 절로 간다(§7.9.8)
    expect(found.some((x) => x.includes('budget#수행 모드 — 협약 예산'))).toBe(true);
  });

  it.each(HELP_SLUGS)('content/help/%s.md 절 제목 id가 편 안에서 겹치지 않는다', (slug) => {
    const source = readIfExists(path.join(HELP_DIR, `${slug}.md`));
    expect(source).not.toBeNull();
    const ids = headingTexts(source ?? '').map((text) => helpHeadingId(slug, text));
    const dup = ids.filter((id, index) => ids.indexOf(id) !== index);
    expect(dup, '같은 id면 앵커가 첫 절로만 간다').toEqual([]);
  });
});

// ─── 협약 예산 도움말 (Phase 24, §7.9.8) ─────────────────────────────────────

describe('협약 예산 도움말 (§7.9.8)', () => {
  const budget = readIfExists(path.join(HELP_DIR, 'budget.md')) ?? '';
  const calculations = readIfExists(path.join(HELP_DIR, 'calculations.md')) ?? '';

  it('"준비 중" 문구가 도움말·따라하기에 없다', () => {
    const offenders = [HELP_DIR, TUTORIAL_DIR].flatMap((dir) =>
      fs.existsSync(dir)
        ? fs
            .readdirSync(dir)
            .filter((name) => name.endsWith('.md') && fs.readFileSync(path.join(dir, name), 'utf8').includes('준비 중'))
            .map((name) => `${path.basename(dir)}/${name}`)
        : []
    );
    expect(offenders).toEqual([]);
  });

  it('budget.md에 "수행 모드 — 협약 예산" 절, calculations.md에 협약 예산 절(RL-23·기준 버전)이 있다', () => {
    expect(headingTexts(budget)).toContain('수행 모드 — 협약 예산');
    expect(headingTexts(calculations).some((h) => h.startsWith('협약 예산'))).toBe(true);
    expect(calculations).toContain('RL-23');
    expect(calculations).toContain('기준 버전 없음');
  });

  it('폐기된 규칙(RL-20·RL-21)·과제 유형을 있는 것처럼 쓰지 않는다', () => {
    const agreement = readIfExists(path.join(HELP_DIR, 'agreement.md')) ?? '';
    const budgetRules = readIfExists(path.join(HELP_DIR, 'budget-rules.md')) ?? '';
    for (const word of ['RL-20', 'RL-21', '과제 유형']) {
      expect(budget, word).not.toContain(word);
      expect(calculations, word).not.toContain(word);
      expect(agreement, word).not.toContain(word);
      expect(budgetRules, word).not.toContain(word);
    }
  });
});

// ─── 협약 예산 양식 도움말 (Phase 25, S-21) ──────────────────────────────────

describe('협약 예산 양식 도움말 (Phase 25)', () => {
  const agreement = readIfExists(path.join(HELP_DIR, 'agreement.md')) ?? '';
  const budget = readIfExists(path.join(HELP_DIR, 'budget.md')) ?? '';

  it('agreement.md에 보기 3종·가져오기 절이 있다 — 화면 HelpLink anchor가 가리킬 제목', () => {
    const headings = headingTexts(agreement);
    for (const heading of [
      '양식은 자동으로 채워진다',
      '붙임4형 — 8-2 사용계획',
      '붙임4형 — 8-1 지원·부담계획',
      '조정회의형',
      '참여인원',
      '붙임4 가져오기',
    ]) {
      expect(headings, heading).toContain(heading);
    }
  });

  it('양식 분모·양식 E1/E2·연구과제추진비·내역 행·변경전/변경후를 설명한다', () => {
    for (const phrase of [
      '양식 E1/E2',
      '연구과제추진비',
      '양식에 없는 비목',
      '연구실 안전관리비',
      '변경전 = 제안 모드',
      '변경후 = 보고 있는 협약 버전',
      '판정하지 않음',
      '8-1 쓰지 않음',
      '연봉 모름',
    ]) {
      expect(agreement, phrase).toContain(phrase);
    }
  });

  it('budget.md는 제안 연차 정부지원 현금과 협약 예산 양식 연결 한 줄을 담는다', () => {
    expect(budget).toContain('정부지원 현금');
    expect(budget).toContain('기관부담 현금');
    expect(budget).toContain('협약 예산 양식');
  });
});

// ─── 수행 모드 규칙 검증·편성 항목 도움말 (Phase 26, S-10) ───────────────────

describe('수행 모드 규칙 검증·편성 항목 도움말 (Phase 26)', () => {
  const agreement = readIfExists(path.join(HELP_DIR, 'agreement.md')) ?? '';
  const budget = readIfExists(path.join(HELP_DIR, 'budget.md')) ?? '';
  const budgetRules = readIfExists(path.join(HELP_DIR, 'budget-rules.md')) ?? '';

  it('agreement.md에 두 절이 있다 — 화면 HelpLink anchor가 가리킬 제목', () => {
    const headings = headingTexts(agreement);
    expect(headings).toContain('수행 모드 규칙 검증');
    expect(headings).toContain('편성 항목·증빙');
  });

  it('판정 대상 버전·버전 정부지원 현금·세목 미지정·증빙 잠금 예외를 설명한다', () => {
    for (const phrase of ['보고 있는 버전', '연차별 정부지원 현금', '세목 미지정', '부가세 별도', '파일 첨부', '체크·메모만']) {
      expect(agreement, phrase).toContain(phrase);
    }
    expect(budget).toContain('편성 항목·증빙');
  });

  it('budget-rules.md가 연구실 안전관리비 1~2%·장비 ×1.1·세목 총액 보존 꺼짐을 설명한다', () => {
    for (const phrase of ['연구실 안전관리비', '1% 미만이거나 2% 초과', '× 1.1', 'IRIS/ZEUS', '사전 승인 대상', '규칙이 꺼져 있어 판정하지 않음']) {
      expect(budgetRules, phrase).toContain(phrase);
    }
    expect(budgetRules, '폐기된 "심의" 문구').not.toContain('심의');
  });
});

// ─── 배포·렌더 경계 (HP-1·HP-2)─────────────────────────────────────────────

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
