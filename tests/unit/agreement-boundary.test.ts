// lib/agreement/ 모듈 경계 검증 (SOT §6.19 AG-8·AG-9, evaluation_criteria Phase 24) — 정적 스캔으로 고정한다.
//
// `lib/agreement/`는 `lib/input-form/`과 같은 경계다: 순수 함수만 두고 워크북 라이브러리(xlsx·exceljs)·
// Supabase·리포지토리(`lib/db`)·서버 액션·server-only 어댑터를 import하지 않는다. 엑셀 산출물은 `FormSheet`
// 타입으로만 넘기고 바이트는 `lib/input-form-adapter.ts`가 쓴다 — exceljs를 import하는 파일 목록(정확히 2개)은
// tests/unit/input-form-boundary.test.ts가 지킨다.
//
// 아직 없는 모듈(T4·T5가 만드는 중)은 디렉터리 스캔이라 생기는 대로 자동으로 검사된다.

import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(__dirname, '../..');
const AGREEMENT_DIR = path.join(ROOT, 'lib/agreement');
const INPUT_FORM_DIR = path.join(ROOT, 'lib/input-form');

/** 주석을 지운 사본. 주석 속 "exceljs를 import하지 않는다" 같은 설명이 위반으로 잡히지 않게. 문자열은 남긴다 */
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

interface ImportSite {
  specifier: string;
  /** `import type …` / `export type … from` — 컴파일 후 사라진다 */
  typeOnly: boolean;
}

function importSites(source: string): ImportSite[] {
  const code = stripComments(source);
  const sites: ImportSite[] = [];
  for (const m of code.matchAll(/\b(import|export)\s+(type\s+)?[^'";]*?\bfrom\s*['"]([^'"]+)['"]/g)) {
    if (m[3]) sites.push({ specifier: m[3], typeOnly: m[2] !== undefined });
  }
  const valueOnly = [
    /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
    /\bimport\s+['"]([^'"]+)['"]/g,
    /\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
  ];
  for (const pattern of valueOnly) {
    for (const m of code.matchAll(pattern)) if (m[1]) sites.push({ specifier: m[1], typeOnly: false });
  }
  return sites;
}

function listFiles(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  const found: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) found.push(...listFiles(full));
    else if (/\.(ts|tsx)$/.test(entry.name)) found.push(full);
  }
  return found.sort();
}

function relative(file: string): string {
  return path.relative(ROOT, file).split(path.sep).join('/');
}

/** 앱 내부 경로로 풀 수 있으면 ROOT 기준 경로(확장자 없음), 패키지면 null */
function resolveLocal(specifier: string, fromFile: string): string | null {
  let resolved: string;
  if (specifier.startsWith('@/')) resolved = path.join(ROOT, specifier.slice(2));
  else if (specifier.startsWith('.')) resolved = path.resolve(path.dirname(fromFile), specifier);
  else return null;
  return relative(resolved).replace(/\.(ts|tsx)$/, '');
}

function isPackage(specifier: string, name: string): boolean {
  return specifier === name || specifier.startsWith(`${name}/`);
}

/** 금지 대상이면 이유, 아니면 null */
function violation(site: ImportSite, fromFile: string): string | null {
  const s = site.specifier;
  if (isPackage(s, 'xlsx') || isPackage(s, 'exceljs')) return '워크북 라이브러리';
  if (s.startsWith('@supabase/')) return 'Supabase';
  if (s === 'server-only') return 'server-only(순수 모듈이 아니다)';
  const local = resolveLocal(s, fromFile);
  if (local === null) return null;
  if (local === 'lib/db' || local.startsWith('lib/db/')) return '리포지토리(lib/db)';
  if (local === 'actions' || local.startsWith('actions/')) return '서버 액션';
  if (/^lib\/[^/]*-adapter$/.test(local)) return 'server-only 어댑터';
  if (local === 'lib/xlsx-style') return '부록 F 헬퍼(exceljs)';
  // 입력 양식 모듈은 FormSheet 등 **타입만** — 값 import는 생성기·파서를 끌고 와 경계가 섞인다
  if ((local === 'lib/input-form' || local.startsWith('lib/input-form/')) && !site.typeOnly) {
    return 'lib/input-form 값 import(타입만 허용)';
  }
  return null;
}

const modules = listFiles(AGREEMENT_DIR);

describe('lib/agreement 경계 검사 준비 상태', () => {
  it(`검사 대상 — lib/agreement ${modules.length}개 파일`, () => {
    // 0개면 스캔 경로가 틀렸거나 table.ts가 사라진 것이다 — 빈 목록을 통과로 읽지 않는다
    expect(modules.map(relative)).toContain('lib/agreement/table.ts');
  });
});

describe('lib/agreement는 순수 모듈이다 (AG-9)', () => {
  it.each(modules.map(relative))('%s가 xlsx·exceljs·supabase·lib/db·actions·어댑터를 import하지 않는다', (rel) => {
    const file = path.join(ROOT, rel);
    const offenders = importSites(fs.readFileSync(file, 'utf8'))
      .map((site) => ({ site, why: violation(site, file) }))
      .filter((x) => x.why !== null)
      .map((x) => `${x.site.specifier} — ${x.why}`);
    expect(offenders, `${rel}이 경계 밖 모듈을 import합니다 (AG-9)`).toEqual([]);
  });

  it("'use client'·브라우저 전역에 기대지 않는다", () => {
    for (const file of modules) {
      const code = stripComments(fs.readFileSync(file, 'utf8'));
      expect(/^\s*['"]use client['"]/.test(code), relative(file)).toBe(false);
      expect(/\b(window|document|navigator)\./.test(code), relative(file)).toBe(false);
    }
  });
});

describe('스캐너 자체 검사', () => {
  // 검사기가 아무것도 못 잡으면 통과가 무의미하다 — 알려진 위반 문자열로 확인한다
  const fake = path.join(AGREEMENT_DIR, 'fake.ts');
  it.each([
    ["import ExcelJS from 'exceljs';", '워크북 라이브러리'],
    ["import * as XLSX from 'xlsx';", '워크북 라이브러리'],
    ["import { createClient } from '@supabase/supabase-js';", 'Supabase'],
    ["import { listYears } from '@/lib/db/years';", '리포지토리(lib/db)'],
    ["import { x } from '../db';", '리포지토리(lib/db)'],
    ["import { getAgreementData } from '@/actions/agreement';", '서버 액션'],
    ["import { writeInputFormWorkbook } from '@/lib/input-form-adapter';", 'server-only 어댑터'],
    ["import { buildGuideSheet } from '@/lib/input-form/guide';", 'lib/input-form 값 import(타입만 허용)'],
  ])('%s → 위반', (line, why) => {
    const sites = importSites(line);
    expect(sites.map((s) => violation(s, fake))).toEqual([why]);
  });

  it('입력 양식 타입만 가져오는 것은 허용', () => {
    const sites = importSites("import type { FormSheet } from '@/lib/input-form/types';");
    expect(sites.map((s) => violation(s, fake))).toEqual([null]);
  });

  it('lib/input-form 디렉터리가 있다(타입 출처)', () => {
    expect(fs.existsSync(INPUT_FORM_DIR)).toBe(true);
  });
});
