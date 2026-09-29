// 목표 양식 모듈 경계 검증 (SOT §6.17 GF-1·GF-8, 부록 F F-9, §6.8.5 I-13) — 정적 스캔으로 불변식을 고정한다.
//
// `lib/goal-form/`은 `lib/input-form/`과 같은 경계다: 서식·워크북 라이브러리와 DB를 모르는 순수 함수만 두고,
// 워크북을 만드는 일은 `writeInputFormWorkbook`(server-only 어댑터)을 재사용한다(S-22). 그래서 exceljs를
// import하는 파일 목록은 Phase 20과 같다 — 그 허용 목록·클라이언트의 input-form-adapter·xlsx-style import 검사는
// input-form-boundary.test.ts가 이미 고정하므로 여기서 다시 쓰지 않는다. 여기는 goal-form 고유 검사와,
// 목표 양식 경로가 새로 기대는 **다른 server-only 어댑터**(import-adapter 읽기 등)에 대한 클라이언트 검사만 둔다.
//
// 검사 방식은 input-form-boundary.test.ts와 같은 파일 스캔이다. 아직 없는 디렉터리는 건너뛰되
// 무엇을 검사하지 못했는지 화면에 남긴다(절대 규칙 5).

import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(__dirname, '../..');
const GOAL_FORM_DIR = path.join(ROOT, 'lib/goal-form');
const LIB_DIR = path.join(ROOT, 'lib');

/** 'use client' 파일이 있을 수 있는 곳. node_modules·빌드 산출물은 스캔하지 않는다 */
const CLIENT_SCAN_DIRS = ['app', 'components', 'lib', 'actions', 'types'];

// ─── 정적 스캔 도구 (input-form-boundary.test.ts와 같다) ─────────────────────

/** 주석을 지운 사본. 규칙을 설명하는 주석 속 예시(`exceljs를 import하지 않는다`)가 위반으로 잡히지 않게 한다 */
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

const TYPE_ONLY_IMPORT = /\bimport\s+type\s[^;]*?\bfrom\s*['"]([^'"]+)['"]\s*;?/g;

/** `import type … from '…'` 문의 모듈 지정자 — 컴파일 뒤 사라져 런타임 의존이 생기지 않는다 */
function typeOnlyImports(source: string): string[] {
  return [...stripComments(source).matchAll(TYPE_ONLY_IMPORT)].map((m) => m[1]!);
}

/** 타입 전용 import 문을 뺀 나머지 지정자 — 실제로 실행 시점에 끌려오는 모듈 */
function valueImports(source: string): string[] {
  return importedModules(stripComments(source).replace(TYPE_ONLY_IMPORT, ''));
}

/**
 * RPC 페이로드 계약 타입은 리포지토리(lib/db/import-snapshots)가 원본이다 — 미리보기가 그 모양을 만들어야 하므로
 * 타입만은 가져온다. 입력 양식 미리보기와 같은 선례이고, 값 import는 여전히 금지다
 */
const TYPE_ONLY_ALLOWED = new Set(['lib/db/import-snapshots']);

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

/** SheetJS(읽기)·exceljs(쓰기)·Supabase — lib/goal-form이 알면 안 되는 바깥 세계다(IN-8·S-22, 절대 규칙 3) */
function isForbiddenPackage(specifier: string): boolean {
  return (
    specifier === 'xlsx' ||
    specifier.startsWith('xlsx/') ||
    specifier === 'exceljs' ||
    specifier.startsWith('exceljs/') ||
    specifier === '@supabase' ||
    specifier.startsWith('@supabase/')
  );
}

// ─── 검사 대상 수집 ───────────────────────────────────────────────────────────

const goalFormModules = listFiles(GOAL_FORM_DIR, ['.ts']);

/**
 * server-only 어댑터 — `lib/*-adapter.ts` 전부(입력·목표 양식 쓰기, 올린 파일 읽기, 서식 내보내기).
 * 이름 규약으로 모으므로 목표 양식용 어댑터가 새로 생겨도 검사가 자동으로 따라간다
 */
const serverAdapters = fs.existsSync(LIB_DIR)
  ? fs
      .readdirSync(LIB_DIR)
      .filter((name) => name.endsWith('-adapter.ts'))
      .map((name) => `lib/${name.replace(/\.ts$/, '')}`)
      .sort()
  : [];

const appFiles = CLIENT_SCAN_DIRS.flatMap((dir) => listFiles(path.join(ROOT, dir), ['.ts', '.tsx']));
const clientFiles = appFiles.filter((file) =>
  /^['"]use client['"]/.test(firstStatement(fs.readFileSync(file, 'utf8')))
);

// ─── 준비 상태 ────────────────────────────────────────────────────────────────

describe('목표 양식 경계 검사 준비 상태', () => {
  // skip된 describe 안의 출력은 리포터가 삼키므로 항상 실행되는 테스트에서 알린다
  it(`검사 대상 확인 — lib/goal-form ${goalFormModules.length}개 파일, server-only 어댑터 ${serverAdapters.length}개`, () => {
    if (goalFormModules.length === 0) {
      process.stderr.write(
        '\n[goal-form-boundary] lib/goal-form/*.ts가 없어 무의존 검사(S-22·IN-8)가 비활성입니다.\n' +
          '  파일이 생기면 이 테스트가 자동으로 켜집니다.\n\n'
      );
    }
    // 어댑터가 하나도 안 잡히면 이름 규약 스캔이 틀린 것이다 — 빈 목록을 통과로 읽으면 검사가 조용히 죽는다
    expect(serverAdapters).toContain('lib/input-form-adapter');
    expect(serverAdapters).toContain('lib/import-adapter');
  });
});

// ─── 1. lib/goal-form은 xlsx·exceljs·@supabase를 import하지 않는다 ───────────

describe.skipIf(goalFormModules.length === 0)('lib/goal-form은 워크북 라이브러리·DB 무의존이다 (S-22·IN-8)', () => {
  it.each(goalFormModules.map(relative))('%s가 xlsx·exceljs·@supabase를 import하지 않는다', (rel) => {
    const source = fs.readFileSync(path.join(ROOT, rel), 'utf8');
    expect(
      importedModules(source).filter(isForbiddenPackage),
      `${rel}이 워크북 라이브러리나 Supabase를 직접 씁니다. 워크북 쓰기는 lib/input-form-adapter.ts, ` +
        '읽기는 lib/import-adapter.ts, DB는 lib/db/ 리포지토리의 몫입니다'
    ).toEqual([]);
  });

  it.each(goalFormModules.map(relative))(
    '%s가 server-only 어댑터·xlsx-style·lib/db·actions·server-only를 import하지 않는다',
    (rel) => {
      const file = path.join(ROOT, rel);
      const source = fs.readFileSync(file, 'utf8');
      const isOffender = (specifier: string): boolean => {
        if (specifier === 'server-only') return true;
        const local = resolveLocal(specifier, file);
        if (local === null) return false;
        return (
          serverAdapters.includes(local) ||
          local === 'lib/xlsx-style' ||
          local === 'lib/db' ||
          local.startsWith('lib/db/') ||
          local === 'actions' ||
          local.startsWith('actions/')
        );
      };
      const offenders = [
        ...valueImports(source).filter(isOffender),
        // 타입 전용이라도 허용 목록 밖이면 위반이다
        ...typeOnlyImports(source).filter(
          (specifier) => isOffender(specifier) && !TYPE_ONLY_ALLOWED.has(resolveLocal(specifier, file) ?? '')
        ),
      ];
      expect(
        offenders,
        `${rel}은 순수 좌표·검증·파싱 층입니다(GF-1). 어댑터·DB·액션을 끌어오면 테스트와 재사용이 막힙니다`
      ).toEqual([]);
    }
  );
});

// ─── 2. 'use client' 파일은 server-only 어댑터를 import하지 않는다 (I-13) ─────

describe("'use client' 파일은 server-only 어댑터를 쓰지 않는다 (I-13)", () => {
  it(`클라이언트 컴포넌트 ${clientFiles.length}개 중 lib/*-adapter를 직접 import하는 파일이 없다`, () => {
    const offenders = clientFiles.flatMap((file) =>
      importedModules(fs.readFileSync(file, 'utf8'))
        .map((specifier) => resolveLocal(specifier, file))
        .filter((local): local is string => local !== null && serverAdapters.includes(local))
        .map((local) => `${relative(file)} → ${local}`)
    );
    expect(
      offenders,
      "'use client' 파일이 server-only 어댑터를 직접 import했습니다. 서버 액션을 거치십시오 — " +
        '그대로 두면 SheetJS·exceljs가 클라이언트 번들에 들어갑니다 (I-13)'
    ).toEqual([]);
  });

  it('스캔이 실제로 클라이언트 파일을 찾았다', () => {
    expect(clientFiles.length).toBeGreaterThan(0);
  });
});

// ─── 3. 어댑터는 server-only로 시작한다 (I-13) ────────────────────────────────

describe('server-only 어댑터는 전부 서버 전용이다 (I-13)', () => {
  it.each(serverAdapters)("%s의 첫 구문이 import 'server-only'다", (rel) => {
    const first = firstStatement(fs.readFileSync(path.join(ROOT, `${rel}.ts`), 'utf8'));
    expect(
      first.replace(/["']/g, "'"),
      `${rel}.ts는 import 'server-only'로 시작해야 합니다 — 라이브러리가 클라이언트 번들로 새는 것을 막는 가드입니다`
    ).toMatch(/^import\s+'server-only'/);
  });
});
