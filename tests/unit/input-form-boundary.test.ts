// 입력 양식 모듈 경계 검증 (SOT §6.16 IN-7·IN-8, §6.8.5 I-13) — 정적 스캔으로 불변식을 고정한다.
//
// `lib/input-form/`은 `lib/import/`·`lib/export/`와 **같은 경계**다: SheetJS를 import하지 않는
// 순수 함수만 두고, 워크북을 만드는 일은 어댑터(`lib/input-form-adapter.ts`, server-only)가 맡는다.
// 거기에 한 가지가 더 있다 — **생성기는 수식만 쓰고 파서는 읽기만 한다**(IN-7·IN-3). 인건비 금액을
// 앱 산식으로 여기서 다시 계산하기 시작하면 PL-1과 두 벌이 되어 언젠가 어긋난다. 금액을 계산하는
// 유일한 자리는 `lib/budget-plan.ts`의 computeDetailAmount이고, 그것을 부르는 것은 미리보기
// (`preview.ts`, 앱 값과 대조하려면 필요하다)뿐이다.
//
// 검사는 **파일 내용을 읽는 정적 스캔**이다(tests/unit/export-boundary.test.ts와 같은 방식).
// 아직 없는 파일(T2~T4가 만드는 중)은 건너뛰되 **무엇을 검사하지 못했는지 화면에 남긴다**(절대 규칙 5).

import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(__dirname, '../..');
const INPUT_FORM_DIR = path.join(ROOT, 'lib/input-form');
const INPUT_FORM_ADAPTER = path.join(ROOT, 'lib/input-form-adapter.ts');
const XLSX_STYLE = path.join(ROOT, 'lib/xlsx-style.ts');

/** exceljs를 import해도 되는 파일 — 정확히 이 둘이고 둘 다 server-only다(IN-8, 부록 F) */
const EXCELJS_ALLOWED = ['lib/input-form-adapter.ts', 'lib/xlsx-style.ts'] as const;

/** 금액 산식을 부를 수 있는 파일. 미리보기만 부른다(IN-7 — 금액은 엑셀 수식) */
const AMOUNT_CALLER_ALLOWED: readonly string[] = ['lib/input-form/preview.ts'];

/** 'use client' 파일이 있을 수 있는 곳. node_modules·빌드 산출물은 스캔하지 않는다 */
const CLIENT_SCAN_DIRS = ['app', 'components', 'lib', 'actions', 'types'];

// ─── 정적 스캔 도구 ───────────────────────────────────────────────────────────

/**
 * 주석을 지운 사본을 만든다. 이 저장소의 주석은 "SheetJS를 import하지 않는다"·"annualSalary를
 * 곱하지 않는다" 같은 규칙 설명을 자주 담는다 — 주석 속 예시가 위반으로 잡히면 거짓 경보가 된다.
 * 문자열 리터럴은 그대로 남긴다(수식 문자열이 셀 주소가 아니라 필드명을 곱하는지 봐야 하므로).
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

/** SheetJS(읽기)·exceljs(쓰기) — 둘 다 어댑터 밖에서는 보이면 안 되는 서식·워크북 라이브러리다(IN-8) */
function isXlsx(specifier: string): boolean {
  return (
    specifier === 'xlsx' ||
    specifier.startsWith('xlsx/') ||
    specifier === 'exceljs' ||
    specifier.startsWith('exceljs/')
  );
}

function isExcelJS(specifier: string): boolean {
  return specifier === 'exceljs' || specifier.startsWith('exceljs/');
}

/** `@/lib/xlsx-style`(부록 F 헬퍼)을 가리키는가 — 클라이언트에 실리면 exceljs가 딸려 들어간다 */
function pointsToXlsxStyle(specifier: string, fromFile: string): boolean {
  let resolved: string;
  if (specifier.startsWith('@/')) resolved = path.join(ROOT, specifier.slice(2));
  else if (specifier.startsWith('.')) resolved = path.resolve(path.dirname(fromFile), specifier);
  else return false;
  return resolved.replace(/\.(ts|tsx)$/, '') === XLSX_STYLE.replace(/\.ts$/, '');
}

/** 모듈 지정자가 lib/input-form-adapter를 가리키는가 (`@/` 별칭·상대경로 모두) */
function pointsToInputFormAdapter(specifier: string, fromFile: string): boolean {
  let resolved: string;
  if (specifier.startsWith('@/')) resolved = path.join(ROOT, specifier.slice(2));
  else if (specifier.startsWith('.')) resolved = path.resolve(path.dirname(fromFile), specifier);
  else return false;
  return resolved.replace(/\.(ts|tsx)$/, '') === INPUT_FORM_ADAPTER.replace(/\.ts$/, '');
}

// ─── 검사 대상 수집 ───────────────────────────────────────────────────────────

const inputFormModules = listFiles(INPUT_FORM_DIR, ['.ts']);
const adapterExists = fs.existsSync(INPUT_FORM_ADAPTER);

const appFiles = CLIENT_SCAN_DIRS.flatMap((dir) => listFiles(path.join(ROOT, dir), ['.ts', '.tsx']));

const clientFiles = appFiles.filter((file) =>
  /^['"]use client['"]/.test(firstStatement(fs.readFileSync(file, 'utf8')))
);

// ─── 준비 상태 ────────────────────────────────────────────────────────────────

describe('입력 양식 경계 검사 준비 상태', () => {
  // 안내는 **항상 실행되는 테스트 안에서** 낸다. skip된 describe 안의 출력은 리포터가 삼켜
  // 검사가 통째로 생략된 사실이 화면에 남지 않는다 (export-boundary.test.ts와 같은 방식)
  it(`검사 대상 확인 — lib/input-form ${inputFormModules.length}개 파일, 어댑터 ${adapterExists ? '있음' : '없음'}`, () => {
    const inactive: string[] = [];
    if (inputFormModules.length === 0) {
      inactive.push(`  - lib/input-form/*.ts 없음 → SheetJS 무의존·산식 미호출 검사(IN-7·IN-8) 비활성`);
    }
    if (!adapterExists) {
      inactive.push(
        `  - lib/input-form-adapter.ts 없음 → server-only 검사(I-13)와 'use client' 직접 import 검사 비활성`
      );
    }
    if (inactive.length > 0) {
      process.stderr.write(
        `\n[input-form-boundary] 아직 없는 파일이 있어 경계 검사 일부가 비활성입니다.\n` +
          `${inactive.join('\n')}\n` +
          `  파일이 생기면 이 테스트가 자동으로 켜집니다. 별도 조치는 필요 없습니다.\n\n`
      );
    }
    expect(inactive.length).toBeLessThanOrEqual(2);
  });
});

// ─── 1. lib/input-form/**/*.ts는 xlsx·exceljs를 import하지 않는다 (IN-8) ───────

describe.skipIf(inputFormModules.length === 0)('lib/input-form은 SheetJS·exceljs 무의존이다 (IN-8)', () => {
  it.each(inputFormModules.map((file) => relative(file)))('%s가 xlsx·exceljs를 import하지 않는다', (rel) => {
    const source = fs.readFileSync(path.join(ROOT, rel), 'utf8');
    expect(
      importedModules(source).filter(isXlsx),
      `${rel}이 워크북 라이브러리를 직접 씁니다. 워크북을 만드는 일은 lib/input-form-adapter.ts의 몫입니다 (IN-8)`
    ).toEqual([]);
  });
});

// ─── 1b. exceljs는 어댑터·스타일 헬퍼 두 파일에서만, 둘 다 server-only (IN-8, 부록 F) ──

describe('exceljs는 lib/input-form-adapter.ts·lib/xlsx-style.ts에서만 import한다 (IN-8)', () => {
  it(`app/components/lib/actions/types ${appFiles.length}개 파일 중 exceljs를 import하는 파일이 정확히 둘이다`, () => {
    const importers = appFiles
      .filter((file) => importedModules(fs.readFileSync(file, 'utf8')).some(isExcelJS))
      .map(relative)
      .sort();
    expect(
      importers,
      'exceljs를 import하는 파일이 허용 목록과 다릅니다. 서식은 lib/xlsx-style.ts, 워크북 쓰기는 ' +
        'lib/input-form-adapter.ts에만 둡니다 (IN-8)'
    ).toEqual([...EXCELJS_ALLOWED].sort());
  });

  it.each([...EXCELJS_ALLOWED])("%s의 첫 구문이 import 'server-only'다 (I-13)", (rel) => {
    const first = firstStatement(fs.readFileSync(path.join(ROOT, rel), 'utf8'));
    expect(
      first.replace(/["']/g, "'"),
      `${rel}은 import 'server-only'로 시작해야 합니다 — exceljs가 클라이언트 번들로 새는 것을 컴파일 타임에 막는 유일한 가드입니다`
    ).toMatch(/^import\s+'server-only'/);
  });
});

// ─── 2. 어댑터는 server-only로 시작한다 (I-13) ────────────────────────────────

describe.skipIf(!adapterExists)('lib/input-form-adapter는 서버 전용이다 (I-13)', () => {
  it("첫 구문이 import 'server-only'다", () => {
    const first = firstStatement(fs.readFileSync(INPUT_FORM_ADAPTER, 'utf8'));
    // 따옴표 종류·세미콜론 유무는 따지지 않는다. 다른 import보다 앞서는지가 요점이다
    expect(
      first.replace(/["']/g, "'"),
      "lib/input-form-adapter.ts는 import 'server-only'로 시작해야 합니다 — " +
        'SheetJS가 클라이언트 번들로 새는 것을 컴파일 타임에 막는 유일한 가드입니다 (I-13)'
    ).toMatch(/^import\s+'server-only'/);
  });
});

// ─── 3. 'use client' 파일은 어댑터·xlsx를 직접 import하지 않는다 (I-13) ────────

describe("'use client' 파일은 입력 양식 어댑터·SheetJS를 쓰지 않는다 (I-13)", () => {
  it(`클라이언트 컴포넌트 ${clientFiles.length}개 중 어댑터를 직접 import하는 파일이 없다`, () => {
    const offenders = clientFiles
      .filter((file) =>
        importedModules(fs.readFileSync(file, 'utf8')).some((specifier) =>
          pointsToInputFormAdapter(specifier, file)
        )
      )
      .map(relative);
    expect(
      offenders,
      "'use client' 파일이 lib/input-form-adapter를 직접 import했습니다. " +
        '서버 액션을 거치십시오 — 그대로 두면 SheetJS가 클라이언트 번들에 들어갑니다 (I-13)'
    ).toEqual([]);
  });

  it('xlsx·exceljs를 직접 import하는 클라이언트 파일이 없다', () => {
    const offenders = clientFiles
      .filter((file) => importedModules(fs.readFileSync(file, 'utf8')).some(isXlsx))
      .map(relative);
    expect(offenders, "'use client' 파일이 SheetJS·exceljs를 직접 import했습니다 (I-13)").toEqual([]);
  });

  it('@/lib/xlsx-style을 import하는 클라이언트 파일이 없다 (부록 F 헬퍼는 exceljs를 끌고 온다)', () => {
    const offenders = clientFiles
      .filter((file) =>
        importedModules(fs.readFileSync(file, 'utf8')).some((specifier) => pointsToXlsxStyle(specifier, file))
      )
      .map(relative);
    expect(offenders, "'use client' 파일이 lib/xlsx-style을 직접 import했습니다 (I-13)").toEqual([]);
  });

  it('스캔이 실제로 클라이언트 파일을 찾았다', () => {
    // 0개면 스캔 경로가 틀린 것이다. 빈 목록을 통과로 읽으면 검사가 조용히 죽는다
    expect(clientFiles.length).toBeGreaterThan(0);
  });
});

// ─── 4. 생성기는 수식만, 파서는 읽기만 — 금액을 여기서 계산하지 않는다 (IN-7·IN-3) ──

describe.skipIf(inputFormModules.length === 0)('lib/input-form은 인건비 금액을 계산하지 않는다 (IN-7)', () => {
  it.each(inputFormModules.map((file) => relative(file)))(
    '%s가 annualSalary·monthlySalary를 곱하지 않는다',
    (rel) => {
      const code = stripComments(fs.readFileSync(path.join(ROOT, rel), 'utf8'));
      // 필드값을 직접 곱하는 순간 PL-1의 사본이 생긴다. 수식 셀은 셀 주소(`C2*D2`)를 곱하므로 걸리지 않는다
      const hits = [...code.matchAll(/\b(annualSalary|monthlySalary)\s*\*/g)].map((m) => m[0]);
      expect(
        hits,
        `${rel}이 급여 필드를 직접 곱합니다. 인건비 금액은 엑셀 수식(IN-7) 또는 computeDetailAmount(PL-1)만 계산합니다`
      ).toEqual([]);
    }
  );

  it.each(
    inputFormModules.map((file) => relative(file)).filter((rel) => !AMOUNT_CALLER_ALLOWED.includes(rel))
  )('%s가 computeDetailAmount를 쓰지 않는다', (rel) => {
    const code = stripComments(fs.readFileSync(path.join(ROOT, rel), 'utf8'));
    expect(
      /\bcomputeDetailAmount\b/.test(code),
      `${rel}이 computeDetailAmount를 씁니다. 앱 산식으로 금액을 채우거나 대조하는 자리는 ${AMOUNT_CALLER_ALLOWED.join(', ')}뿐입니다 (IN-7·IN-11)`
    ).toBe(false);
  });
});
