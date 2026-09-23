// 사내 인사 명부 연동 경계 검증 (SOT §6.13.5, HR-13, HR-15, HR-12) — 정적 스캔으로 불변식을 고정한다.
//
// `lib/hr.ts`는 `lib/import/`·`lib/export/`와 **같은 경계**다: fetch·server-only·supabase 없이
// 응답을 옮기고 판정만 한다. 네트워크는 서버 액션의 몫이다(§6.13.5). 키가 브라우저에서 HR로
// 직접 가지 않고(HR-13), 429에 재시도를 얹지 않으며(HR-15), 키가 localStorage에 남지
// 않는다(HR-12)는 것도 파일 내용을 읽어 확인한다.
//
// 검사는 **파일 내용을 읽는 정적 스캔**이다(tests/unit/export-boundary.test.ts와 같은 방식).
// 아직 없는 파일: Phase 12의 다른 태스크가 만드는 중이다. 없는 항목은 건너뛰되
// **무엇을 검사하지 못했는지 화면에 남긴다**(절대 규칙 5). 파일이 생기면 자동으로 켜진다.

import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(__dirname, '../..');
const HR_MODULE = path.join(ROOT, 'lib/hr.ts');
const HR_KEY_MODULE = path.join(ROOT, 'lib/hr-key.ts');
const TEAM_ACTIONS = path.join(ROOT, 'actions/team.ts');

/** HR-13: 키가 브라우저에서 HR로 직접 가지 않는지 볼 'use client' 파일의 위치 */
const CLIENT_SCAN_DIRS = ['components', 'app'];

/** HR-12: 키체인 밖(localStorage·sessionStorage)에 키를 두지 않아야 하는 파일 */
const NO_WEB_STORAGE_FILES = [
  'lib/hr-key.ts',
  'components/settings/HrApiKeyPanel.tsx',
  'components/team/HrDirectoryModal.tsx',
];

// ─── 정적 스캔 도구 ───────────────────────────────────────────────────────────

/**
 * 주석을 지운 사본을 만든다. 이 저장소의 주석은 "fetch를 하지 않는다" 같은 규칙 설명을
 * 자주 담는다 — 주석 속 `fetch(` 예시가 위반으로 잡히면 거짓 경보가 된다. 문자열 리터럴은
 * 그대로 남긴다(안내 문구의 'hr.unes.kr'를 봐야 하므로).
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

/** 주석·빈 줄을 걷어낸 첫 구문. 'use client'인지 볼 때 쓴다 */
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

function isClientFile(file: string): boolean {
  return /^['"]use client['"]/.test(firstStatement(fs.readFileSync(file, 'utf8')));
}

/** `fetch(` 호출. `fetchHrDirectory(` 같은 식별자는 단어 경계로 걸러진다 */
const FETCH_CALL = /\bfetch\s*\(/;

// ─── 검사 대상 수집 ───────────────────────────────────────────────────────────

const hrModuleExists = fs.existsSync(HR_MODULE);
const hrKeyExists = fs.existsSync(HR_KEY_MODULE);
const teamActionsExists = fs.existsSync(TEAM_ACTIONS);

const clientFiles = [
  ...CLIENT_SCAN_DIRS.flatMap((dir) => listFiles(path.join(ROOT, dir), ['.ts', '.tsx'])),
  ...(hrKeyExists ? [HR_KEY_MODULE] : []),
].filter(isClientFile);

const webStorageTargets = NO_WEB_STORAGE_FILES.map((rel) => ({
  rel,
  exists: fs.existsSync(path.join(ROOT, rel)),
}));

// ─── 준비 상태 ────────────────────────────────────────────────────────────────

describe('HR 연동 경계 검사 준비 상태', () => {
  // Phase 12가 끝난 뒤에는 다섯 파일이 전부 있어야 한다. skipIf는 병렬 생성 중 파일 부재를
  // 허용하려던 것이라, 파일이 지워지면 경계 검사가 조용히 꺼진다 — 그 상태를 여기서 실패로 만든다.
  it('Phase 12 산출물 5개가 모두 존재한다 (없으면 아래 경계 검사가 조용히 꺼진다)', () => {
    const missing = [
      ...(hrModuleExists ? [] : ['lib/hr.ts']),
      ...(hrKeyExists ? [] : ['lib/hr-key.ts']),
      ...(teamActionsExists ? [] : ['actions/team.ts']),
      ...webStorageTargets.filter((t) => !t.exists).map((t) => t.rel),
    ];
    expect(missing, `없는 파일: ${missing.join(', ')}`).toEqual([]);
  });
  // 안내는 **항상 실행되는 테스트 안에서** 낸다. skip된 describe 안의 출력은 리포터가 삼켜
  // 검사가 통째로 생략된 사실이 화면에 남지 않는다(export-boundary.test.ts와 같은 방식).
  it(`검사 대상 확인 — lib/hr.ts ${hrModuleExists ? '있음' : '없음'}, actions/team.ts ${teamActionsExists ? '있음' : '없음'}`, () => {
    const inactive: string[] = [];
    if (!hrModuleExists) {
      inactive.push('  - lib/hr.ts 없음 → fetch·server-only·supabase 무의존 검사(§6.13.5) 비활성');
    }
    if (!hrKeyExists) {
      inactive.push('  - lib/hr-key.ts 없음 → 해당 파일의 HR 직접 호출(HR-13)·웹 스토리지(HR-12) 검사 비활성');
    }
    if (!teamActionsExists) {
      inactive.push('  - actions/team.ts 없음 → 재시도 없음(HR-15)·키 로그 없음(HR-13) 검사 비활성');
    }
    for (const target of webStorageTargets) {
      if (!target.exists && target.rel !== 'lib/hr-key.ts') {
        inactive.push(`  - ${target.rel} 없음 → 웹 스토리지 검사(HR-12) 비활성`);
      }
    }
    if (inactive.length > 0) {
      // process.stderr에 직접 쓴다 — console.warn은 통과한 테스트에서 리포터에 감춰진다
      process.stderr.write(
        `\n[hr-boundary] 아직 없는 파일이 있어 경계 검사 일부가 비활성입니다.\n` +
          `${inactive.join('\n')}\n` +
          `  파일이 생기면 이 테스트가 자동으로 켜집니다. 별도 조치는 필요 없습니다.\n\n`
      );
    }
    // 없는 것 자체는 실패가 아니다(다른 태스크가 만드는 중). 다만 생략 사실은 위 출력으로 남는다
    expect(inactive.length).toBeLessThanOrEqual(NO_WEB_STORAGE_FILES.length + 2);
  });
});

// ─── (a) lib/hr.ts는 fetch·server-only·supabase·db·next 무의존이다 (§6.13.5) ───

describe.skipIf(!hrModuleExists)('lib/hr.ts는 네트워크·서버·DB를 모른다 (§6.13.5)', () => {
  const source = hrModuleExists ? fs.readFileSync(HR_MODULE, 'utf8') : '';

  it("'server-only'·'@supabase/*'·'@/lib/db/*'·'next/*'를 import하지 않는다", () => {
    const offenders = importedModules(source).filter(
      (s) =>
        s === 'server-only' ||
        s.startsWith('@supabase/') ||
        s === '@/lib/db' ||
        s.startsWith('@/lib/db/') ||
        s.startsWith('./db/') ||
        s === './db' ||
        s === 'next' ||
        s.startsWith('next/')
    );
    expect(
      offenders,
      'lib/hr.ts는 순수 함수만 둡니다. 네트워크·DB는 actions/team.ts의 몫입니다 (§6.13.5)'
    ).toEqual([]);
  });

  it('본문에 fetch( 호출이 없다', () => {
    expect(
      FETCH_CALL.test(stripComments(source)),
      'lib/hr.ts가 fetch를 호출합니다. HR 호출은 서버 액션에서만 합니다 (§6.13.5, HR-13)'
    ).toBe(false);
  });
});

// ─── (b) 'use client' 파일에서 hr.unes.kr을 fetch하지 않는다 (HR-13) ─────────

describe("'use client' 파일은 HR을 직접 호출하지 않는다 (HR-13)", () => {
  it(`클라이언트 파일 ${clientFiles.length}개 중 fetch(와 'hr.unes.kr'가 공존하는 파일이 없다`, () => {
    // 안내 문구("hr.unes.kr 로그인 → …")는 허용한다. 같은 파일에 fetch( 호출까지 있을 때만 위반
    const offenders = clientFiles
      .filter((file) => {
        const code = stripComments(fs.readFileSync(file, 'utf8'));
        return code.includes('hr.unes.kr') && FETCH_CALL.test(code);
      })
      .map(relative);
    expect(
      offenders,
      "'use client' 파일이 hr.unes.kr을 직접 fetch합니다. 키가 네트워크 탭에 노출됩니다 — " +
        '서버 액션 fetchHrDirectory를 거치십시오 (HR-13)'
    ).toEqual([]);
  });

  it('스캔이 실제로 클라이언트 파일을 찾았다', () => {
    // 0개면 스캔 경로가 틀린 것이다. 빈 목록을 통과로 읽으면 검사가 조용히 죽는다
    expect(clientFiles.length).toBeGreaterThan(0);
  });
});

// ─── (c) actions/team.ts: 재시도 없음(HR-15)·키 로그 없음(HR-13) ─────────────

describe.skipIf(!teamActionsExists)('actions/team.ts는 재시도하지 않고 키를 로그에 남기지 않는다', () => {
  const code = teamActionsExists ? stripComments(fs.readFileSync(TEAM_ACTIONS, 'utf8')) : '';

  it('retry 식별자가 없다 (HR-15)', () => {
    expect(
      /\bretry\b/i.test(code),
      'actions/team.ts에 retry가 있습니다. 429에 재시도를 얹으면 한도를 더 빨리 태웁니다 (HR-15)'
    ).toBe(false);
  });

  it('console. 줄에 apiKey가 없다 (HR-13)', () => {
    const offenders = code
      .split(/\r?\n/)
      .map((line, i) => ({ line, no: i + 1 }))
      .filter(({ line }) => line.includes('console.') && /apiKey/.test(line));
    expect(
      offenders.map((o) => `${o.no}: ${o.line.trim()}`),
      'actions/team.ts가 apiKey를 console에 씁니다. 키는 로그에 실리면 안 됩니다 (HR-13)'
    ).toEqual([]);
  });
});

// ─── (c) 키를 localStorage·sessionStorage에 두지 않는다 (HR-12) ──────────────

const existingWebStorageTargets = webStorageTargets.filter((t) => t.exists);

describe.skipIf(existingWebStorageTargets.length === 0)('HR API 키는 웹 스토리지에 가지 않는다 (HR-12)', () => {
  it.each(existingWebStorageTargets.map((t) => t.rel))('%s에 localStorage·sessionStorage가 없다', (rel) => {
    const code = stripComments(fs.readFileSync(path.join(ROOT, rel), 'utf8'));
    expect(
      /localStorage|sessionStorage/.test(code),
      `${rel}이 웹 스토리지를 씁니다. 키는 OS 키체인(lib/tauri/keychain.ts)에만 둡니다 (HR-12)`
    ).toBe(false);
  });
});
