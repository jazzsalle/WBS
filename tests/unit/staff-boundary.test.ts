// lib/salary.ts · lib/participation.ts 경계 검증 (SOT §5.20, §6.15 PS-5, evaluation_criteria Phase 16)
// — tests/unit/rules-boundary.test.ts와 같은 정적 스캔.
//
// 두 모듈은 순수 함수다: 서버 전용 모듈·Supabase·Next·fetch·현재 시각에 기대지 않는다(기준일은 인자).
// 그리고 인건비 산식을 다시 쓰지 않는다 — `annualSalary`·`unitPrice`가 salary.ts에 등장하면
// PL-1을 두 번째로 적은 것이다(PL-10a). participation.ts의 참여율 읽기는 lib/budget-plan.ts에서만 온다.
//
// 주석은 지우고 본다 — 이 저장소의 주석은 "연봉 곱셈이 없다" 같은 규칙 설명을 담기 때문이다.

import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(__dirname, '../..');
const FILES = {
  salary: path.join(ROOT, 'lib/salary.ts'),
  participation: path.join(ROOT, 'lib/participation.ts'),
} as const;

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

const code = {
  salary: stripComments(fs.readFileSync(FILES.salary, 'utf8')),
  participation: stripComments(fs.readFileSync(FILES.participation, 'utf8')),
};

describe.each([
  ['lib/salary.ts', code.salary],
  ['lib/participation.ts', code.participation],
])('%s는 순수 함수 모듈이다', (_name, source) => {
  it('server-only · @supabase · next/ 를 import하지 않는다', () => {
    const offenders = importedModules(source).filter(
      (s) => s === 'server-only' || s.startsWith('@supabase') || s === 'next' || s.startsWith('next/')
    );
    expect(offenders).toEqual([]);
  });

  it('fetch( 를 호출하지 않는다', () => {
    expect(/\bfetch\s*\(/.test(source)).toBe(false);
  });

  it('Date.now · new Date( · Math.random 같은 비결정 입력이 없다 — 기준일은 인자로 받는다', () => {
    expect(/\bDate\.now\b/.test(source)).toBe(false);
    expect(/\bnew Date\s*\(/.test(source)).toBe(false);
    expect(/\bMath\.random\b/.test(source)).toBe(false);
  });
});

describe('lib/salary.ts는 인건비 산식을 다시 쓰지 않는다 (PL-10a)', () => {
  it('annualSalary · unitPrice 식별자가 없다', () => {
    // 연봉 환산(SL-1)까지가 이 모듈의 몫이다. 그 값에 참여율·개월을 곱하는 순간 PL-1이 두 곳이 된다
    expect(/\bannualSalary\b/.test(code.salary)).toBe(false);
    expect(/\bunitPrice\b/.test(code.salary)).toBe(false);
  });
});

describe('lib/participation.ts의 import는 budget-plan · types · constants뿐이다', () => {
  it('허용 목록 밖 모듈이 없다', () => {
    const specifiers = importedModules(code.participation);
    expect(specifiers.length).toBeGreaterThan(0); // 스캔이 실제로 import를 읽었다
    for (const specifier of specifiers) {
      expect(['@/lib/budget-plan', '@/types', '@/lib/constants'], specifier).toContain(specifier);
    }
  });

  it('참여율은 lib/budget-plan의 personnelParticipation으로 읽는다 (PS-2)', () => {
    expect(/\bpersonnelParticipation\b/.test(code.participation)).toBe(true);
  });
});

// SL-5: 급여 이력을 바꿔도 과제 인건비는 자동으로 바뀌지 않는다. 조직원 액션 파일에
// PL-10b 재계산 경로가 있으면 그 규칙이 깨진 것이다 — 정적 검사로 고정한다.
describe('actions/staff.ts에는 급여 자동 반영 경로가 없다 (SL-5)', () => {
  it('applySalaryChange·apply_salary_change·updateMember 호출이 없다', () => {
    const src = fs.readFileSync(path.resolve(__dirname, '../../actions/staff.ts'), 'utf8');
    const code = src.replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
    expect(code).not.toMatch(/applySalaryChange|apply_salary_change|updateMember\(/);
  });
});
