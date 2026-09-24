// lib/rules.ts 경계 검증 (SOT §6.14.7, evaluation_criteria Phase 13) — 정적 스캔으로 불변식을 고정한다.
//
// 판정기는 순수 함수다: 서버 전용 모듈·Supabase·Next·fetch에 기대지 않는다. 그리고 금액 산식을
// 다시 구현하지 않는다 — `annualSalary`·`unitPrice`가 이 파일에 등장하면 lib/budget-plan.ts의
// PL-1·PL-3을 두 번째로 적은 것이다(PL-10a: 같은 규칙이 두 곳에 생기면 반드시 어긋난다).
//
// 검사는 파일 내용을 읽는 정적 스캔이다(tests/unit/export-boundary.test.ts와 같은 방식). 주석은
// 지우고 본다 — 이 저장소의 주석은 "연봉 곱셈이 없다" 같은 규칙 설명을 담기 때문이다.

import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(__dirname, '../..');
const RULES = path.join(ROOT, 'lib/rules.ts');

/** 주석을 지운 사본. 문자열 리터럴은 그대로 남긴다 */
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

function importedModules(code: string): string[] {
  const specifiers: string[] = [];
  const patterns = [
    /\bfrom\s*['"]([^'"]+)['"]/g,
    /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
    /\bimport\s+['"]([^'"]+)['"]/g,
    /\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
  ];
  for (const pattern of patterns) {
    for (const match of code.matchAll(pattern)) if (match[1]) specifiers.push(match[1]);
  }
  return specifiers;
}

const source = fs.readFileSync(RULES, 'utf8');
const code = stripComments(source);

describe('lib/rules.ts는 순수 함수 모듈이다 (§6.14.7)', () => {
  it('server-only · @supabase · next/ 를 import하지 않는다', () => {
    const offenders = importedModules(code).filter(
      (s) => s === 'server-only' || s.startsWith('@supabase') || s === 'next' || s.startsWith('next/')
    );
    expect(offenders, 'lib/rules.ts가 서버·프레임워크 모듈에 기댑니다').toEqual([]);
  });

  it('import는 lib/budget-plan과 타입뿐이다', () => {
    const specifiers = importedModules(code);
    expect(specifiers.length).toBeGreaterThan(0); // 스캔이 실제로 import를 읽었다
    for (const specifier of specifiers) {
      expect(['./budget-plan', '@/lib/budget-plan', '@/types'], specifier).toContain(specifier);
    }
  });

  it('fetch( 를 호출하지 않는다', () => {
    expect(/\bfetch\s*\(/.test(code)).toBe(false);
  });

  it('금액 산식을 다시 쓰지 않는다 — annualSalary · unitPrice 식별자가 없다', () => {
    // 집계·행 금액은 입력으로 받는다(§6.14.7). 곱셈이 아니라 식별자 자체를 금지한다 —
    // 읽기만 하더라도 다음 사람이 거기서 곱하기 시작한다
    expect(/\bannualSalary\b/.test(code)).toBe(false);
    expect(/\bunitPrice\b/.test(code)).toBe(false);
  });

  it('Date·Math.random 같은 비결정 입력이 없다', () => {
    expect(/\bnew Date\b|\bDate\.now\b|\bMath\.random\b/.test(code)).toBe(false);
  });
});
