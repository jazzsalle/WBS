// 내보내기 모듈 경계 검증 (SOT §6.12.4, §6.8.5 I-13) — 정적 스캔으로 불변식을 고정한다.
//
// `lib/export/`는 `lib/import/`와 **같은 경계**를 갖는다: SheetJS를 import하지 않는 순수 함수만
// 두고, 워크북을 열고 쓰는 일은 어댑터(`lib/export-adapter.ts`)가 맡는다. 그래야 "무엇을 어디에
// 쓸까"를 워크북 없이 단위 테스트로 고정할 수 있고, SheetJS가 클라이언트 번들로 새지 않는다(I-13).
//
// 검사는 **파일 내용을 읽는 정적 스캔**이다. 모듈을 import해서 확인하지 않는다 —
// `lib/export-adapter.ts`는 `import 'server-only'`로 시작하고, 그 가드가 있는지가 검사 대상이다.
//
// 아직 없는 파일: Phase 11의 다른 태스크가 만드는 중이다. 없는 항목은 건너뛰되
// **무엇을 검사하지 못했는지 화면에 남긴다**(절대 규칙 5). 파일이 생기면 자동으로 켜진다.

import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(__dirname, '../..');
const EXPORT_DIR = path.join(ROOT, 'lib/export');
const EXPORT_ADAPTER = path.join(ROOT, 'lib/export-adapter.ts');

/** 'use client' 파일이 있을 수 있는 곳. node_modules·빌드 산출물은 스캔하지 않는다 */
const CLIENT_SCAN_DIRS = ['app', 'components', 'lib', 'actions', 'types'];

// ─── 정적 스캔 도구 ───────────────────────────────────────────────────────────

/**
 * 주석을 지운 사본을 만든다.
 *
 * 이 저장소의 주석은 "SheetJS를 import하지 않는다" 같은 규칙 설명을 자주 담는다.
 * 주석 안의 `from 'xlsx'` 예시가 위반으로 잡히면 경계 테스트가 거짓 경보를 내고,
 * 결국 사람이 테스트를 믿지 않게 된다. 문자열 리터럴은 그대로 남긴다.
 */
function stripComments(source: string): string {
  let out = '';
  let i = 0;
  while (i < source.length) {
    const ch = source[i];
    const next = source[i + 1];
    if (ch === '/' && next === '/') {
      while (i < source.length && source[i] !== '\n') i++;
      continue;
    }
    if (ch === '/' && next === '*') {
      i += 2;
      while (i < source.length && !(source[i] === '*' && source[i + 1] === '/')) i++;
      i += 2;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '`') {
      const quote = ch;
      out += ch;
      i++;
      while (i < source.length) {
        out += source[i];
        if (source[i] === '\\') {
          i++;
          if (i < source.length) out += source[i];
          i++;
          continue;
        }
        if (source[i] === quote) {
          i++;
          break;
        }
        i++;
      }
      continue;
    }
    out += ch;
    i++;
  }
  return out;
}

/** `from '...'` · `import '...'` · `import('...')` · `require('...')`의 모듈 지정자 */
function importedModules(source: string): string[] {
  const code = stripComments(source);
  const specifiers: string[] = [];
  const patterns = [
    /\bfrom\s*['"]([^'"]+)['"]/g,
    /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
    /\bimport\s+['"]([^'"]+)['"]/g,
    /\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
  ];
  for (const pattern of patterns) {
    for (const match of code.matchAll(pattern)) {
      if (match[1]) specifiers.push(match[1]);
    }
  }
  return specifiers;
}

/** 주석·빈 줄을 걷어낸 첫 구문. `import 'server-only'`가 맨 앞인지 볼 때 쓴다 */
function firstStatement(source: string): string {
  return (
    stripComments(source)
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find((line) => line.length > 0) ?? ''
  );
}

function listFiles(dir: string, extensions: readonly string[]): string[] {
  if (!fs.existsSync(dir)) return [];
  const found: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
      found.push(...listFiles(full, extensions));
    } else if (extensions.some((ext) => entry.name.endsWith(ext))) {
      found.push(full);
    }
  }
  return found.sort();
}

function relative(file: string): string {
  return path.relative(ROOT, file).split(path.sep).join('/');
}

/** 모듈 지정자가 lib/export-adapter를 가리키는가 (`@/` 별칭·상대경로 모두) */
function pointsToExportAdapter(specifier: string, fromFile: string): boolean {
  let resolved: string;
  if (specifier.startsWith('@/')) resolved = path.join(ROOT, specifier.slice(2));
  else if (specifier.startsWith('.')) resolved = path.resolve(path.dirname(fromFile), specifier);
  else return false;
  return resolved.replace(/\.(ts|tsx)$/, '') === EXPORT_ADAPTER.replace(/\.ts$/, '');
}

// ─── 검사 대상 수집 ───────────────────────────────────────────────────────────

const exportModules = listFiles(EXPORT_DIR, ['.ts']);
const adapterExists = fs.existsSync(EXPORT_ADAPTER);

const clientFiles = CLIENT_SCAN_DIRS.flatMap((dir) =>
  listFiles(path.join(ROOT, dir), ['.ts', '.tsx'])
).filter((file) => /^['"]use client['"]/.test(firstStatement(fs.readFileSync(file, 'utf8'))));

// ─── 준비 상태 ────────────────────────────────────────────────────────────────

describe('내보내기 경계 검사 준비 상태', () => {
  // 안내는 **항상 실행되는 테스트 안에서** 낸다. skip된 describe 안이나 모듈 최상단의
  // 출력은 리포터가 삼켜, 검사가 통째로 생략된 사실이 화면에 남지 않는다
  // (tests/unit/import-samples.test.ts와 같은 방식).
  it(`검사 대상 확인 — lib/export ${exportModules.length}개 파일, 어댑터 ${adapterExists ? '있음' : '없음'}`, () => {
    const inactive: string[] = [];
    if (exportModules.length === 0) {
      inactive.push(`  - lib/export/*.ts 없음 → SheetJS 무의존 검사(§6.12.4) 비활성`);
    }
    if (!adapterExists) {
      inactive.push(
        `  - lib/export-adapter.ts 없음 → server-only 검사(I-13)와 'use client' 직접 import 검사 비활성`
      );
    }
    if (inactive.length > 0) {
      // process.stderr에 직접 쓴다 — console.warn은 통과한 테스트에서 리포터에 감춰진다
      process.stderr.write(
        `\n[export-boundary] 아직 없는 파일이 있어 경계 검사 일부가 비활성입니다.\n` +
          `${inactive.join('\n')}\n` +
          `  파일이 생기면 이 테스트가 자동으로 켜집니다. 별도 조치는 필요 없습니다.\n\n`
      );
    }
    // 없는 것 자체는 실패가 아니다(다른 태스크가 만드는 중). 다만 생략 사실은 위 출력으로 남는다
    expect(inactive.length).toBeLessThanOrEqual(2);
  });
});

// ─── 1. lib/export/**/*.ts는 xlsx를 import하지 않는다 (§6.12.4) ────────────────

describe.skipIf(exportModules.length === 0)('lib/export는 SheetJS 무의존이다 (§6.12.4)', () => {
  it.each(exportModules.map((file) => relative(file)))('%s가 xlsx를 import하지 않는다', (rel) => {
    const source = fs.readFileSync(path.join(ROOT, rel), 'utf8');
    const offenders = importedModules(source).filter(
      (specifier) => specifier === 'xlsx' || specifier.startsWith('xlsx/')
    );
    expect(
      offenders,
      `${rel}이 SheetJS를 직접 씁니다. 워크북을 여는 일은 lib/export-adapter.ts의 몫입니다 (§6.12.4)`
    ).toEqual([]);
  });
});

// ─── 2. 어댑터는 server-only로 시작한다 (I-13) ────────────────────────────────

describe.skipIf(!adapterExists)('lib/export-adapter는 서버 전용이다 (I-13)', () => {
  it("첫 구문이 import 'server-only'다", () => {
    const first = firstStatement(fs.readFileSync(EXPORT_ADAPTER, 'utf8'));
    // 따옴표 종류·세미콜론 유무는 따지지 않는다. 다른 import보다 앞서는지가 요점이다
    expect(
      first.replace(/["']/g, "'"),
      "lib/export-adapter.ts는 import 'server-only'로 시작해야 합니다 — " +
        'SheetJS가 클라이언트 번들로 새는 것을 컴파일 타임에 막는 유일한 가드입니다 (I-13)'
    ).toMatch(/^import\s+'server-only'/);
  });
});

// ─── 3. 'use client' 파일은 어댑터를 직접 import하지 않는다 (I-13) ─────────────

describe.skipIf(!adapterExists)("'use client' 파일은 내보내기 어댑터를 쓰지 않는다 (I-13)", () => {
  it(`클라이언트 컴포넌트 ${clientFiles.length}개 중 어댑터를 직접 import하는 파일이 없다`, () => {
    const offenders = clientFiles
      .filter((file) =>
        importedModules(fs.readFileSync(file, 'utf8')).some((specifier) =>
          pointsToExportAdapter(specifier, file)
        )
      )
      .map(relative);
    expect(
      offenders,
      "'use client' 파일이 lib/export-adapter를 직접 import했습니다. " +
        '서버 액션을 거치십시오 — 그대로 두면 SheetJS가 클라이언트 번들에 들어갑니다 (I-13)'
    ).toEqual([]);
  });

  it('스캔이 실제로 클라이언트 파일을 찾았다', () => {
    // 0개면 스캔 경로가 틀린 것이다. 빈 목록을 통과로 읽으면 검사가 조용히 죽는다
    expect(clientFiles.length).toBeGreaterThan(0);
  });
});
