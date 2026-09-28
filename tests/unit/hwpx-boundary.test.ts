// hwpx 모듈 경계 검증 (SOT §6.18 HX-1, S-33) — 정적 스캔으로 불변식을 고정한다.
//
// `lib/hwpx/`는 **클라이언트와 Node가 같은 코드로 도는** 층이다(HX-1 — 100MB급 파일을 서버로 올리지 않고
// 브라우저가 표 격자만 뽑아 보낸다). 그래서 두 가지가 동시에 성립해야 한다:
//   1. DOM(DOMParser·Blob·FileReader…)이나 Node(Buffer·fs·process…)에 기대지 않는다 — 어느 한쪽에서만 돌면
//      vitest가 실제 경로를 검증하지 못하거나 브라우저 번들이 깨진다. 외부 패키지는 fflate·fast-xml-parser뿐이다.
//   2. 행 해석(`rows.ts`)은 서버 전용이다 — lib/goal-form을 거쳐 lib/input-form·lib/budget-plan까지 끌려오므로
//      클라이언트가 값으로 import하면 번들이 커지고 서버 모듈이 샌다(S-33). 이것은 직접 import만 봐서는 못 잡으므로
//      'use client' 파일에서 시작하는 **전이 import 그래프**를 따라간다.
//
// 스캔 도구는 goal-form-boundary.test.ts와 같다. 그 파일·input-form-boundary.test.ts가 이미 고정하는 검사
// (lib/goal-form 무의존, 'use client'의 어댑터 직접 import, 어댑터의 server-only 가드)는 다시 쓰지 않는다.

import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(__dirname, '../..');
const HWPX_DIR = path.join(ROOT, 'lib/hwpx');
const LIB_DIR = path.join(ROOT, 'lib');

/** 'use client' 파일이 있을 수 있는 곳. node_modules·빌드 산출물은 스캔하지 않는다 */
const CLIENT_SCAN_DIRS = ['app', 'components', 'lib', 'actions', 'types'];

/** lib/hwpx가 import해도 되는 외부 패키지 — 부록 F·§4 기술 스택(hwpx 파싱) */
const ALLOWED_PACKAGES = ['fflate', 'fast-xml-parser'] as const;

/** 서버 전용 행 해석. lib/goal-form을 값으로 import해도 되는 lib/hwpx 파일은 이것 하나다(S-33) */
const SERVER_ONLY_ROWS = 'lib/hwpx/rows';

/**
 * lib/hwpx가 금지 대상(lib/db·actions·어댑터 등)에서 타입만 가져와도 되는 예외. 지금은 없다 —
 * 필요해지면 goal-form-boundary의 TYPE_ONLY_ALLOWED처럼 이유와 함께 여기 적는다
 */
const TYPE_ONLY_ALLOWED = new Set<string>();

/**
 * 클라이언트가 값으로 가져와도 되는 lib/db 모듈. 브라우저용 supabase 클라이언트이고 Realtime 구독·인증 토큰
 * 동기화에만 쓴다 — 절대 규칙 3의 유일한 예외(SOT §8.2 C-2, §8.5)다. 리포지토리는 여전히 금지다
 */
const CLIENT_DB_ALLOWED = new Set(['lib/db/client']);

/**
 * 주석·문자열 리터럴을 지운 뒤 남으면 안 되는 DOM·Node 식별자. `node:` 지정자는 문자열 안에만 있으므로
 * 여기가 아니라 외부 패키지 검사(ALLOWED_PACKAGES 밖)가 잡는다
 */
const RUNTIME_IDENTIFIERS: readonly [string, RegExp][] = [
  ['document', /\bdocument\b/],
  ['window', /\bwindow\b/],
  ['DOMParser', /\bDOMParser\b/],
  ['Blob', /\bBlob\b/],
  ['File', /\bFile\b/],
  ['FileReader', /\bFileReader\b/],
  ['Worker', /\bWorker\b/],
  ['navigator', /\bnavigator\b/],
  ['Buffer', /\bBuffer\b/],
  ['process', /\bprocess\b/],
  ['require(', /\brequire\s*\(/],
  // `node: XNode` 같은 매개변수와 구분하려고 콜론 바로 뒤에 모듈 이름이 붙은 꼴만 본다
  ['node:', /\bnode:[a-z]/],
  ['fs', /\bfs\b/],
  ['path', /\bpath\b/],
];

// ─── 정적 스캔 도구 (goal-form-boundary.test.ts와 같다) ──────────────────────

/**
 * 주석을 지운 사본. `keepStrings`가 false면 문자열·템플릿 리터럴의 내용도 비운다(따옴표 쌍만 남긴다) —
 * 사용자 문구 속 단어("파일(File)")가 식별자 검사에 오탐하지 않게 한다
 */
function stripComments(source: string, keepStrings = true): string {
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
        if (source[i] === '\\') {
          if (keepStrings) out += source.slice(i, i + 2);
          i += 2;
          continue;
        }
        if (source[i] === quote) {
          out += quote;
          i++;
          break;
        }
        if (keepStrings) out += source[i];
        i++;
      }
      continue;
    }
    out += ch;
    i++;
  }
  return out;
}

/** 주석과 문자열 리터럴 내용을 모두 지운 실행 코드 */
function stripCommentsAndStrings(source: string): string {
  return stripComments(source, false);
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

// goal-form-boundary와 달리 `export type … from`도 포함한다 — 전이 그래프에서 타입 재수출이 간선이 되면 안 된다
const TYPE_ONLY_IMPORT = /\b(?:import|export)\s+type\s[^;]*?\bfrom\s*['"]([^'"]+)['"]\s*;?/g;

/** `import type … from '…'` 문의 모듈 지정자 — 컴파일 뒤 사라져 런타임 의존이 생기지 않는다 */
function typeOnlyImports(source: string): string[] {
  return [...stripComments(source).matchAll(TYPE_ONLY_IMPORT)].map((m) => m[1]!);
}

/** 타입 전용 import 문을 뺀 나머지 지정자 — 실제로 실행 시점에 끌려오는 모듈 */
function valueImports(source: string): string[] {
  return importedModules(stripComments(source).replace(TYPE_ONLY_IMPORT, ''));
}

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

/** 모듈 지정자를 저장소 상대 경로(확장자 없음)로. 패키지 지정자면 null */
function resolveLocal(specifier: string, fromFile: string): string | null {
  let resolved: string;
  if (specifier.startsWith('@/')) resolved = path.join(ROOT, specifier.slice(2));
  else if (specifier.startsWith('.')) resolved = path.resolve(path.dirname(fromFile), specifier);
  else return null;
  return relative(resolved).replace(/\.(ts|tsx)$/, '');
}

/** 저장소 상대 경로(확장자 없음) → 실제 소스 파일. .ts·.tsx·index 순으로 찾는다. 소스가 아니면(css·json 등) null */
function resolveSourceFile(local: string): string | null {
  const candidates = [`${local}.ts`, `${local}.tsx`, `${local}/index.ts`, `${local}/index.tsx`];
  for (const candidate of candidates) {
    const full = path.join(ROOT, candidate);
    if (fs.existsSync(full) && fs.statSync(full).isFile()) return full;
  }
  return null;
}

function isNonSourceAsset(specifier: string): boolean {
  return /\.(css|scss|json|md|svg|png|jpe?g|gif|webp|ico|txt)$/.test(specifier);
}

function packageName(specifier: string): string {
  const parts = specifier.split('/');
  return specifier.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0]!;
}

// ─── 검사 대상 수집 ───────────────────────────────────────────────────────────

const hwpxModules = listFiles(HWPX_DIR, ['.ts', '.tsx']).map(relative);
const clientBundleHwpxModules = hwpxModules.filter((rel) => rel.replace(/\.tsx?$/, '') !== SERVER_ONLY_ROWS);

/** server-only 어댑터 — `lib/*-adapter.ts` 전부. 이름 규약은 goal-form-boundary와 같다 */
const serverAdapters = fs.existsSync(LIB_DIR)
  ? fs
      .readdirSync(LIB_DIR)
      .filter((name) => name.endsWith('-adapter.ts'))
      .map((name) => `lib/${name.replace(/\.ts$/, '')}`)
      .sort()
  : [];

/** lib/hwpx 어느 파일도 가져오면 안 되는 로컬 모듈 — DB·액션·서식 어댑터(절대 규칙 3, I-13) */
function isForbiddenLocal(local: string): boolean {
  return (
    serverAdapters.includes(local) ||
    local === 'lib/xlsx-style' ||
    local === 'lib/db' ||
    local.startsWith('lib/db/') ||
    local === 'actions' ||
    local.startsWith('actions/')
  );
}

function isForbiddenPackage(specifier: string): boolean {
  const name = packageName(specifier);
  return name === 'xlsx' || name === 'exceljs' || name === '@supabase' || specifier.startsWith('@supabase/') || name === 'server-only';
}

const appFiles = CLIENT_SCAN_DIRS.flatMap((dir) => listFiles(path.join(ROOT, dir), ['.ts', '.tsx']));
const directiveOf = (file: string): string => firstStatement(fs.readFileSync(file, 'utf8'));
const clientFiles = appFiles.filter((file) => /^['"]use client['"]/.test(directiveOf(file)));
const clientHwpxImporters = clientFiles.filter((file) =>
  importedModules(fs.readFileSync(file, 'utf8')).some((specifier) => {
    const local = resolveLocal(specifier, file);
    return local !== null && (local === 'lib/hwpx' || local.startsWith('lib/hwpx/'));
  })
);

// ─── 준비 상태 ────────────────────────────────────────────────────────────────

describe('hwpx 경계 검사 준비 상태', () => {
  // skip된 describe 안의 출력은 리포터가 삼키므로 항상 실행되는 테스트에서 알린다
  it(`검사 대상 확인 — lib/hwpx ${hwpxModules.length}개 파일, 'use client' ${clientFiles.length}개 중 lib/hwpx를 import하는 파일 ${clientHwpxImporters.length}개`, () => {
    process.stderr.write(
      `\n[hwpx-boundary] 'use client' 파일 ${clientFiles.length}개의 전이 import를 검사합니다. ` +
        `lib/hwpx를 직접 import하는 클라이언트 파일 ${clientHwpxImporters.length}개` +
        (clientHwpxImporters.length > 0 ? `: ${clientHwpxImporters.map(relative).join(', ')}` : '') +
        '\n'
    );
    if (hwpxModules.length === 0) {
      process.stderr.write('[hwpx-boundary] lib/hwpx/*.ts가 없어 모듈 검사가 비활성입니다.\n\n');
    }
    // rows.ts가 안 잡히면 서버 전용 예외 이름이 틀린 것이다 — 그러면 rows.ts가 클라이언트 번들 규칙을 받지 않는다
    if (hwpxModules.length > 0) expect(hwpxModules).toContain(`${SERVER_ONLY_ROWS}.ts`);
    expect(serverAdapters).toContain('lib/input-form-adapter');
    expect(clientFiles.length).toBeGreaterThan(0);
  });
});

// ─── 1. 외부 패키지는 fflate·fast-xml-parser뿐 ───────────────────────────────

describe.skipIf(hwpxModules.length === 0)('lib/hwpx의 외부 패키지는 fflate·fast-xml-parser뿐이다 (HX-1)', () => {
  it.each(hwpxModules)('%s', (rel) => {
    const source = fs.readFileSync(path.join(ROOT, rel), 'utf8');
    const offenders = importedModules(source).filter(
      (specifier) =>
        resolveLocal(specifier, path.join(ROOT, rel)) === null &&
        !(ALLOWED_PACKAGES as readonly string[]).includes(packageName(specifier))
    );
    expect(
      offenders,
      `${rel}이 허용 밖 패키지를 씁니다. lib/hwpx는 브라우저와 Node에서 같은 코드로 돌아야 합니다 — ` +
        'node:* 내장·SheetJS·exceljs·Supabase 모두 금지입니다'
    ).toEqual([]);
  });
});

// ─── 2. DB·액션·어댑터·server-only 무의존 ────────────────────────────────────

describe.skipIf(hwpxModules.length === 0)('lib/hwpx는 DB·액션·server-only 어댑터를 모른다 (절대 규칙 3, I-13)', () => {
  it.each(hwpxModules)('%s', (rel) => {
    const file = path.join(ROOT, rel);
    const source = fs.readFileSync(file, 'utf8');
    const isOffender = (specifier: string): boolean => {
      if (isForbiddenPackage(specifier)) return true;
      const local = resolveLocal(specifier, file);
      return local !== null && isForbiddenLocal(local);
    };
    const offenders = [
      ...valueImports(source).filter(isOffender),
      // 타입 전용이라도 허용 목록 밖이면 위반이다
      ...typeOnlyImports(source).filter(
        (specifier) => isOffender(specifier) && !TYPE_ONLY_ALLOWED.has(resolveLocal(specifier, file) ?? specifier)
      ),
    ];
    expect(
      offenders,
      `${rel}은 격자 추출·표 식별·행 해석 층입니다. DB·액션·어댑터는 actions/plan-document.ts의 몫입니다`
    ).toEqual([]);
  });
});

// ─── 3. 클라이언트 번들 쪽 lib/hwpx는 lib/goal-form을 모른다 (S-33) ─────────

describe.skipIf(clientBundleHwpxModules.length === 0)('rows.ts 밖의 lib/hwpx는 lib/goal-form을 import하지 않는다 (S-33)', () => {
  it.each(clientBundleHwpxModules)('%s', (rel) => {
    const file = path.join(ROOT, rel);
    const offenders = importedModules(fs.readFileSync(file, 'utf8')).filter((specifier) => {
      const local = resolveLocal(specifier, file);
      return local !== null && (local === 'lib/goal-form' || local.startsWith('lib/goal-form/') || local === SERVER_ONLY_ROWS);
    });
    expect(
      offenders,
      `${rel}은 클라이언트 번들에 들어갑니다. lib/goal-form·rows.ts를 끌어오면 lib/input-form·lib/budget-plan까지 ` +
        '따라옵니다 — 행 해석은 rows.ts(서버 전용)에서만 하십시오'
    ).toEqual([]);
  });
});

// ─── 4. DOM·Node 식별자 0 ─────────────────────────────────────────────────────

describe.skipIf(hwpxModules.length === 0)('lib/hwpx는 DOM·Node 런타임 식별자를 쓰지 않는다 (HX-1)', () => {
  it.each(hwpxModules)('%s', (rel) => {
    const code = stripCommentsAndStrings(fs.readFileSync(path.join(ROOT, rel), 'utf8'));
    const found = RUNTIME_IDENTIFIERS.filter(([, pattern]) => pattern.test(code)).map(([name]) => name);
    expect(
      found,
      `${rel}이 한쪽 런타임에만 있는 식별자를 씁니다. 입력은 Uint8Array로 받고 파일 읽기는 컴포넌트가 하십시오`
    ).toEqual([]);
  });
});

// ─── 5. 'use client'의 전이 import 그래프 (S-33) ─────────────────────────────

interface ReachedViolation {
  chain: string[];
  target: string;
}

/**
 * 'use client' 파일에서 값 import 간선만 따라 로컬 파일을 넓이 우선으로 훑는다. 'use server' 파일은
 * 들어가지 않는다 — 클라이언트가 import하면 Next가 RPC 참조로 바꾸므로 그 뒤의 서버 모듈은 번들에 안 들어간다
 */
function findClientBundleViolations(): { violations: ReachedViolation[]; unresolved: string[]; visited: number } {
  const violations: ReachedViolation[] = [];
  const unresolved: string[] = [];
  const parent = new Map<string, string | null>();
  const queue: string[] = [];
  for (const file of clientFiles) {
    const rel = relative(file);
    if (!parent.has(rel)) {
      parent.set(rel, null);
      queue.push(rel);
    }
  }
  const chainOf = (rel: string): string[] => {
    const chain: string[] = [];
    for (let cur: string | null = rel; cur !== null; cur = parent.get(cur) ?? null) chain.unshift(cur);
    return chain;
  };

  while (queue.length > 0) {
    const rel = queue.shift()!;
    const file = path.join(ROOT, rel);
    for (const specifier of valueImports(fs.readFileSync(file, 'utf8'))) {
      if (specifier === 'server-only' || specifier === 'xlsx' || specifier === 'exceljs') {
        violations.push({ chain: chainOf(rel), target: specifier });
        continue;
      }
      const local = resolveLocal(specifier, file);
      if (local === null) continue;
      if (
        local === SERVER_ONLY_ROWS ||
        local === 'lib/goal-form' ||
        local.startsWith('lib/goal-form/') ||
        local === 'lib/db' ||
        (local.startsWith('lib/db/') && !CLIENT_DB_ALLOWED.has(local)) ||
        serverAdapters.includes(local)
      ) {
        violations.push({ chain: chainOf(rel), target: local });
        continue;
      }
      const target = resolveSourceFile(local);
      if (target === null) {
        if (!isNonSourceAsset(specifier)) unresolved.push(`${rel} → ${specifier}`);
        continue;
      }
      if (/^['"]use server['"]/.test(directiveOf(target))) continue;
      const targetRel = relative(target);
      if (!parent.has(targetRel)) {
        parent.set(targetRel, rel);
        queue.push(targetRel);
      }
    }
  }
  return { violations, unresolved, visited: parent.size };
}

describe("'use client' 파일의 전이 import에 서버 전용 모듈이 없다 (S-33)", () => {
  const { violations, unresolved, visited } = findClientBundleViolations();

  it(`클라이언트 ${clientFiles.length}개에서 도달한 로컬 파일 ${visited}개에 rows.ts·lib/goal-form·lib/db·어댑터·server-only가 없다`, () => {
    expect(
      violations.map((v) => `${v.chain.join(' → ')} ⇒ ${v.target}`),
      '클라이언트 번들에 서버 전용 모듈이 끌려옵니다. 타입만 필요하면 import type으로, 값이 필요하면 서버 액션을 거치십시오 (S-33)'
    ).toEqual([]);
  });

  it('로컬 import가 전부 소스 파일로 해석된다 — 해석 실패를 통과로 읽지 않는다', () => {
    expect(unresolved, '경로 해석 규칙(.ts·.tsx·index)이 놓친 import입니다. 검사 도구를 고치십시오').toEqual([]);
  });
});
