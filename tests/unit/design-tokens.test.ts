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
