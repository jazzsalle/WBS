// 디자인 토큰 경계 검사 (SOT 부록 E). Tailwind 기본 팔레트를 @theme에서 지웠으므로
// 옛 이름이 남으면 그 요소는 색 없이 그려진다 — 눈으로 잡기 전에 여기서 잡는다.
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(__dirname, '../..');
const SCAN_DIRS = ['app', 'components', 'lib'];
const OLD_PALETTE = /\b(slate|gray|zinc|neutral|stone|rose|emerald|amber|sky|indigo|violet|cyan|lime|fuchsia|pink)-\d{2,3}\b/;
const TDS_SCALES = ['grey', 'blue', 'red', 'green', 'orange', 'yellow', 'teal', 'purple'];

function listFiles(dir: string): string[] {
  const out: string[] = [];
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listFiles(p));
    else if (/\.(ts|tsx|css)$/.test(entry.name)) out.push(p);
  }
  return out;
}

describe('디자인 토큰 (부록 E)', () => {
  it('옛 Tailwind 팔레트 이름을 쓰는 파일이 없다', () => {
    const offenders: string[] = [];
    for (const dir of SCAN_DIRS) {
      for (const file of listFiles(path.join(ROOT, dir))) {
        const src = fs.readFileSync(file, 'utf8');
        const m = src.match(OLD_PALETTE);
        if (m) offenders.push(`${path.relative(ROOT, file)}: ${m[0]}`);
      }
    }
    expect(offenders, '부록 E 팔레트(grey·blue·red·green·orange·yellow·teal·purple)로 바꿔야 한다').toEqual([]);
  });

  it('globals.css가 기본 팔레트를 지우고 TDS 스케일 8종 × 10단계를 정의한다', () => {
    const css = fs.readFileSync(path.join(ROOT, 'app/globals.css'), 'utf8');
    expect(css).toContain('--color-*: initial;');
    for (const scale of TDS_SCALES) {
      for (const shade of [50, 100, 200, 300, 400, 500, 600, 700, 800, 900]) {
        expect(css, `${scale}-${shade}`).toMatch(new RegExp(`--color-${scale}-${shade}: ?#[0-9a-f]{6};`));
      }
    }
    // 부록 E.1 대표값 — 값을 바꾸면 SOT부터 고친다
    expect(css).toContain('--color-blue-500: #3182f6;');
    expect(css).toContain('--color-grey-900: #191f28;');
    expect(css).toContain('--color-red-500: #f04452;');
    expect(css).toContain('--color-green-500: #03b26c;');
    expect(css).toContain('--color-orange-500: #fe9800;');
    expect(css).toContain('--color-screen: #f6f7f9;');
    for (const t of [1, 2, 3, 4, 5, 6, 7]) expect(css).toMatch(new RegExp(`--text-t${t}: ?[0-9]+px;`));
  });
});

// ── 다크 팔레트 (SOT 부록 E.5, §7.19) ─────────────────────────────────────────
// 값이 두 블록([data-theme="dark"]·prefers-color-scheme)에 중복되므로 표 리터럴과 1:1로 고정하고
// 두 블록이 서로 같은지도 검사한다. 값을 바꾸면 부록 E.5부터 고친다.
const DARK_SCALES: Record<string, readonly string[]> = {
  grey: ['#202027', '#2c2c35', '#3c3c47', '#4d4d59', '#62626d', '#7e7e87', '#9e9ea4', '#c3c3c6', '#e4e4e5', '#ffffff'],
  blue: ['#202c4d', '#23386a', '#25478c', '#265ab3', '#2970d9', '#3485fa', '#449bff', '#61b0ff', '#8fcdff', '#c8e7ff'],
  red: ['#3c2020', '#562025', '#7a242d', '#9e2733', '#ca2f3d', '#f04251', '#fa616d', '#fe818b', '#ffa8ad', '#ffd1d3'],
  green: ['#153729', '#135338', '#136d47', '#138a59', '#13a065', '#16bb76', '#26cf88', '#4ee4a6', '#82f6c5', '#ccffea'],
  orange: ['#3d2500', '#563200', '#804600', '#a85f00', '#cf7200', '#f18600', '#fd9528', '#ffa861', '#ffc39e', '#ffe4d6'],
  yellow: ['#3d2d1a', '#724c1e', '#b56f1d', '#eb8b1e', '#ffa126', '#ffb134', '#ffc259', '#ffd68a', '#ffe5b2', '#fff1d4'],
  teal: ['#203537', '#224e51', '#226368', '#247e85', '#26939a', '#2eaab2', '#43bec7', '#65d4dc', '#9be8ee', '#d6fcff'],
  purple: ['#3f2447', '#522361', '#66247b', '#7b2595', '#962fb5', '#ae3dd1', '#c353e5', '#d77cf2', '#eaacfc', '#f6d9ff'],
};
const DARK_SEMANTIC: Record<string, string> = {
  screen: '#17171c',
  surface: '#202027',
  'surface-grey': '#2c2c35',
  hairline: '#3c3c47',
  dimmed: 'rgba(0, 0, 0, 0.56)',
};
const SHADES = [50, 100, 200, 300, 400, 500, 600, 700, 800, 900];
// 다크 블록·인쇄 블록이 밝은 값으로 되돌리는지 볼 때 쓰는 @theme 원본
const LIGHT_SEMANTIC: Record<string, string> = {
  screen: '#f6f7f9',
  surface: '#ffffff',
  'surface-grey': '#f2f4f6',
  hairline: '#e5e8eb',
  dimmed: 'rgba(0, 0, 0, 0.2)',
};
// G2(설정·적용 태스크)가 소유한 파일 — bg-white 치환은 그쪽에서 한다. G2가 끝나면 이 목록은 비어야 한다.
const G2_OWNED = /^(app[\\/]layout\.tsx|components[\\/]AppBootstrap\.tsx|components[\\/]settings[\\/])/;
// 옛 Tailwind 헥스 — inline style·SVG 속성에 박혀 있으면 다크에서 안 뒤집힌다
const OLD_INLINE_HEX = /#(2563eb|3b82f6|e2e8f0|bfdbfe|93c5fd|64748b|60a5fa)\b/i;

/** 중괄호 짝을 세어 selector가 여는 블록 본문을 돌려준다 — 정규식으로는 중첩 @media를 못 자른다 */
function blockBody(css: string, selector: string): string {
  const start = css.indexOf(selector);
  if (start < 0) throw new Error(`블록 없음: ${selector}`);
  const open = css.indexOf('{', start);
  let depth = 0;
  for (let i = open; i < css.length; i++) {
    if (css[i] === '{') depth++;
    else if (css[i] === '}' && --depth === 0) return css.slice(open + 1, i);
  }
  throw new Error(`블록이 닫히지 않음: ${selector}`);
}

/** 블록 본문에서 --color-* 선언을 { 이름: 값 }으로 뽑는다 */
function declarations(body: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of body.matchAll(/--color-([a-z0-9-]+):\s*([^;]+);/g)) out[m[1] ?? ''] = (m[2] ?? '').trim();
  return out;
}

describe('다크 팔레트 (부록 E.5)', () => {
  const css = fs.readFileSync(path.join(ROOT, 'app/globals.css'), 'utf8');
  const themeIdx = css.indexOf('@theme');
  const darkIdx = css.indexOf('[data-theme="dark"]');
  const dark = declarations(blockBody(css, '[data-theme="dark"]'));
  const prefers = declarations(blockBody(blockBody(css, '@media (prefers-color-scheme: dark)'), ':root:not([data-theme="light"])'));

  it('[data-theme="dark"] 블록이 @theme 뒤에 있다 — 레이어 밖에서 뒤에 와야 이긴다', () => {
    expect(themeIdx).toBeGreaterThanOrEqual(0);
    expect(darkIdx).toBeGreaterThan(themeIdx);
  });

  it('8스케일 × 10단계가 부록 E.5 표와 1:1이다', () => {
    for (const scale of TDS_SCALES) {
      SHADES.forEach((shade, i) => {
        expect(dark[`${scale}-${shade}`], `dark ${scale}-${shade}`).toBe(DARK_SCALES[scale]?.[i]);
      });
    }
  });

  it('시맨틱 5종이 다크 값으로 재정의되고 white·black은 손대지 않는다', () => {
    for (const [name, value] of Object.entries(DARK_SEMANTIC)) expect(dark[name], name).toBe(value);
    expect(dark.white).toBeUndefined();
    expect(dark.black).toBeUndefined();
  });

  it('시스템 모드(prefers-color-scheme: dark)의 :root:not([data-theme="light"])가 dark 블록과 값이 같다', () => {
    expect(prefers).toEqual(dark);
  });

  it('@media print는 밝은 팔레트로 되돌린다 (§12 P-R5)', () => {
    // 인쇄 블록은 둘이다(표 머리행 규칙 + 팔레트). 팔레트가 든 쪽을 찾는다
    const printBlocks = [...css.matchAll(/@media print\s*\{/g)].map((m) => blockBody(css.slice(m.index), '@media print'));
    const palette = printBlocks.find((b) => b.includes('--color-'));
    expect(palette, '@media print 안에 밝은 팔레트 재선언이 없다').toBeDefined();
    const printCss = palette as string;
    // 다크 선택자 둘 다 덮어야 한다 — data-theme=dark와 시스템 모드 모두
    expect(printCss).toContain('[data-theme="dark"]');
    expect(printCss).toContain(':root:not([data-theme="light"])');
    const light = declarations(printCss);
    const theme = declarations(blockBody(css, '@theme'));
    for (const scale of TDS_SCALES) {
      for (const shade of SHADES) {
        expect(light[`${scale}-${shade}`], `print ${scale}-${shade}`).toBe(theme[`${scale}-${shade}`]);
      }
    }
    for (const [name, value] of Object.entries(LIGHT_SEMANTIC)) {
      expect(theme[name], `theme ${name}`).toBe(value);
      expect(light[name], `print ${name}`).toBe(value);
    }
  });

  it('bg-white 클래스 토큰이 없다 — 카드 배경은 bg-surface (§7.19)', () => {
    const offenders: string[] = [];
    for (const dir of SCAN_DIRS) {
      for (const file of listFiles(path.join(ROOT, dir))) {
        if (!/\.tsx?$/.test(file)) continue;
        const src = fs.readFileSync(file, 'utf8');
        const rel = path.relative(ROOT, file);
        for (const m of src.matchAll(/\bbg-white\b/g)) {
          offenders.push(`${rel}: ${m[0]}${G2_OWNED.test(rel) ? ' (G2 소유)' : ''}`);
        }
      }
    }
    expect(offenders, 'bg-white → bg-surface (text-white·border-white는 그대로)').toEqual([]);
  });

  it('옛 Tailwind 헥스가 inline style·SVG 속성에 남아 있지 않다', () => {
    const offenders: string[] = [];
    for (const dir of SCAN_DIRS) {
      for (const file of listFiles(path.join(ROOT, dir))) {
        if (!/\.tsx?$/.test(file)) continue;
        const src = fs.readFileSync(file, 'utf8');
        const m = src.match(OLD_INLINE_HEX);
        if (m) offenders.push(`${path.relative(ROOT, file)}: ${m[0]}`);
      }
    }
    expect(offenders, 'var(--color-*)로 바꿔야 다크 팔레트에서 같이 뒤집힌다').toEqual([]);
  });
});

describe('다크 대비 (부록 E.5 — grey 스케일이 뒤집힌다)', () => {
  // 다크에서 grey-900은 #fff이고 white는 그대로라 "진한 회색 바탕 + 흰 글자"가 흰 바탕 + 흰 글자가 된다.
  // 글자는 text-surface(밝게 #fff / 어둡게 #202027)로 두어 배경과 함께 뒤집히게 한다. blue 바탕은 다크에서도 진하므로 제외.
  const DARK_GREY_BG_WITH_WHITE_TEXT = /bg-grey-(700|800|900)[^"'`]*\btext-white\b|\btext-white\b[^"'`]*bg-grey-(700|800|900)/;

  it('한 클래스 문자열에 bg-grey-700/800/900과 text-white가 같이 있지 않다', () => {
    const offenders: string[] = [];
    for (const dir of SCAN_DIRS) {
      for (const file of listFiles(path.join(ROOT, dir))) {
        if (!/\.tsx?$/.test(file)) continue;
        const lines = fs.readFileSync(file, 'utf8').split('\n');
        lines.forEach((line, i) => {
          if (DARK_GREY_BG_WITH_WHITE_TEXT.test(line)) offenders.push(`${path.relative(ROOT, file)}:${i + 1}`);
        });
      }
    }
    expect(offenders, 'text-white → text-surface (다크에서 흰 바탕 + 흰 글자가 된다)').toEqual([]);
  });
});
