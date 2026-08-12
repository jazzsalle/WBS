// 셀 좌표 맵 × 템플릿 파일 대조 (SOT §6.12.1 X-3, §6.12.2 X-4, 부록 B.8.1)
//
// **여기가 Phase 11의 기초다.** 좌표 맵이 틀리면 내보내기 전부가 틀린다.
// `lib/export/`는 SheetJS를 import하지 않으므로(§6.12.4) 워크북 → TemplateSheetInfo 변환은
// 이 테스트가 직접 한다 — 어댑터에 의존하면 검증 대상(좌표 규칙)이 흐려진다.

import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import * as XLSX from 'xlsx';
import {
  DEFAULT_TEMPLATE_ID,
  TEMPLATE_REGISTRY,
  columnLetter,
  decodeAddr,
  findTemplate,
  parseLayout,
  validateLayout,
} from '@/lib/export/layouts';
import type { TemplateLayout, TemplateSheetInfo } from '@/lib/export/types';

const TEMPLATES_DIR = path.resolve(__dirname, '../../templates');

/** 수식이 가리키는 **다른 시트** 이름. 따옴표가 있을 수도(`'1차년도_250520'!`) 없을 수도 있다 */
function referencedSheetsOf(formula: string): string[] {
  const names = new Set<string>();
  for (const m of formula.matchAll(/'([^']+)'!/g)) names.add(m[1] as string);
  for (const m of formula.matchAll(/(?:^|[^A-Za-z0-9_.'!])([^\s!+\-*/(),:'"]+)!/g)) names.add(m[1] as string);
  return [...names];
}

function toSheetInfos(file: string): TemplateSheetInfo[] {
  const wb = XLSX.read(fs.readFileSync(file), { cellStyles: true, cellFormula: true, cellNF: true });
  return wb.SheetNames.map((name) => {
    const ws = wb.Sheets[name];
    const ref = ws?.['!ref'] ?? 'A1:A1';
    const decoded = XLSX.utils.decode_range(ref);
    const presentCells: string[] = [];
    const formulaCells: string[] = [];
    const referenced = new Set<string>();
    for (const addr of Object.keys(ws ?? {})) {
      if (addr.startsWith('!')) continue;
      presentCells.push(addr);
      const f = ws?.[addr]?.f;
      if (typeof f === 'string') {
        formulaCells.push(addr);
        for (const sheet of referencedSheetsOf(f)) referenced.add(sheet);
      }
    }
    return {
      name,
      range: { s: { r: decoded.s.r, c: decoded.s.c }, e: { r: decoded.e.r, c: decoded.e.c } },
      presentCells,
      formulaCells,
      merges: (ws?.['!merges'] ?? []).map((m) => ({ s: { r: m.s.r, c: m.s.c }, e: { r: m.e.r, c: m.e.c } })),
      referencedSheets: [...referenced].filter((sheet) => sheet !== name),
    };
  });
}

const entry = TEMPLATE_REGISTRY[0];
if (!entry) throw new Error('템플릿 레지스트리가 비어 있다');
const templateFile = entry.file;
const baseLayout: TemplateLayout = entry.layout;
const sheetInfos = toSheetInfos(path.join(TEMPLATES_DIR, templateFile));

// ─── A1 좌표 헬퍼 ────────────────────────────────────────────

describe('A1 좌표', () => {
  it('열 문자와 인덱스가 왕복한다', () => {
    expect(decodeAddr('A1')).toEqual({ r: 0, c: 0 });
    expect(decodeAddr('L65')).toEqual({ r: 64, c: 11 });
    expect(decodeAddr('AA10')).toEqual({ r: 9, c: 26 });
    expect(columnLetter(0)).toBe('A');
    expect(columnLetter(26)).toBe('AA');
  });

  it('A1이 아닌 문자열은 null이다 — 조용히 0,0으로 떨어지지 않는다', () => {
    expect(decodeAddr('')).toBeNull();
    expect(decodeAddr('1A')).toBeNull();
    expect(decodeAddr('산출근거!A1')).toBeNull();
  });
});

// ─── 레지스트리 ──────────────────────────────────────────────

describe('템플릿 레지스트리 (X-3)', () => {
  it('표준 템플릿을 id로 찾는다', () => {
    expect(findTemplate(DEFAULT_TEMPLATE_ID)?.file).toBe(templateFile);
  });

  it('모르는 id는 거부한다 — 기본값으로 되돌리면 엉뚱한 서식으로 제출된다', () => {
    expect(findTemplate('없는부처')).toBeNull();
  });

  it('맵 JSON이 스키마를 만족한다', () => {
    expect(() => parseLayout(baseLayout)).not.toThrow();
  });

  it('형태가 깨진 맵은 던진다 — 빈 좌표로 계속 가면 조용히 아무것도 안 쓴다', () => {
    expect(() => parseLayout({ templateId: 'x' })).toThrow();
  });
});

// ─── 실제 템플릿 대조 ────────────────────────────────────────

describe('validateLayout — 실제 템플릿', () => {
  it('위반 0건이다', () => {
    const violations = validateLayout(baseLayout, sheetInfos);
    expect(violations.map((v) => `${v.kind} ${v.sheet}!${v.addr ?? ''} (${v.path})`)).toEqual([]);
  });

  it('없는 시트를 가리키는 수식이 없다 — 있으면 열자마자 #REF!다', () => {
    const workbookSheets = new Set(sheetInfos.map((s) => s.name));
    const dangling = sheetInfos.flatMap((info) =>
      info.referencedSheets.filter((name) => !workbookSheets.has(name)).map((name) => `${info.name} → ${name}`)
    );
    expect(dangling).toEqual([]);
  });

  it('부록 B.8.1: 인건비는 기존인력/신규채용 두 하위 블록에 소계 3단이다', () => {
    const existing = baseLayout.detail.blocks.find((b) => b.key === 'personnel/null#existing');
    const newHire = baseLayout.detail.blocks.find((b) => b.key === 'personnel/null#newHire');
    expect(existing?.dataStartRow).toBe(65);
    expect(existing?.dataEndRow).toBe(87);
    expect(existing?.slotCount).toBe(23);
    expect(existing?.subtotals.map((s) => s.row)).toEqual([88]);
    expect(newHire?.dataStartRow).toBe(89);
    expect(newHire?.dataEndRow).toBe(90);
    expect(newHire?.slotCount).toBe(2);
    // 합계(89~90) → 소 계(65~90 전체). 첫 소계에서 멈추면 신규채용을 통째로 놓친다 (D-5)
    expect(newHire?.subtotals.map((s) => s.row)).toEqual([91, 92]);
    expect(newHire?.subtotals.map((s) => s.total)).toEqual(['L91', 'L92']);
  });

  it('X-7: 백분율 서식 열은 인건비 참여율뿐이다 — 금액 열에는 하나도 없다', () => {
    const percentColumns = baseLayout.detail.blocks.flatMap((block) =>
      block.columns.filter((c) => c.percentFormat).map((c) => `${block.key}.${c.column}=${c.role}`)
    );
    expect(percentColumns).toEqual([
      'personnel/null#existing.H=rate',
      'personnel/null#newHire.H=rate',
      // 실측 잔재: `나. 연구지원비`의 비고 열(L273:L278)에 `0.00%` 서식이 남아 있다.
      // 비고는 텍스트라 X-7의 ÷100 대상이 아니지만, 서식이 그렇다는 사실을 숨기지 않는다
      'indirect/indirect_support.L=note',
    ]);
  });

  it('D-25: 세로 병합된 국내출장비는 두 행이지만 슬롯 하나다', () => {
    const travel = baseLayout.detail.blocks.find((b) => b.subcategory === 'activity_travel_dom');
    expect(travel?.dataStartRow).toBe(186);
    expect(travel?.dataEndRow).toBe(187);
    expect(travel?.slotRows).toEqual([186]);
  });

  it('D-23: 비목 합계 줄이 비목 헤더의 앞·뒤·같은 행 어디에 있어도 잡힌다', () => {
    const byCategory = Object.fromEntries(
      baseLayout.detail.categoryTotals.map((t) => [t.category, `${t.labelAddr}→${t.valueAddr}`])
    );
    expect(byCategory.facility_equipment).toBe('K96→L96'); // 비목 헤더와 같은 행
    expect(byCategory.activity).toBe('K150→L150'); // 바로 다음 행
    expect(byCategory.allowance).toBe('K246→L246'); // 바로 앞 행
  });

  it('총괄표 1차년도 열만 수식 연결이다 — X-10a대로 그 열도 값으로 덮어쓴다', () => {
    const linked = baseLayout.summary.yearColumns.filter((y) => y.linked);
    expect(linked.map((y) => y.column)).toEqual(['F']);
  });

  it('X-10b: 24·25행은 서식 모순을 달고 있고 비목이 비어 있다', () => {
    const conflicted = baseLayout.summary.rows.filter((r) => r.conflict !== undefined);
    expect(conflicted.map((r) => r.row)).toEqual([24, 25]);
    expect(conflicted.every((r) => r.category === null)).toBe(true);
  });
});

// ─── 어긋난 맵을 잡는가 ──────────────────────────────────────

/** 맵은 전부 readonly라 어긋뜨리려면 깊은 복사본의 readonly를 벗겨야 한다 */
type DeepMutable<T> = {
  -readonly [K in keyof T]: T[K] extends readonly (infer U)[]
    ? DeepMutable<U>[]
    : T[K] extends object
      ? DeepMutable<T[K]>
      : T[K];
};

function mutate(fn: (layout: DeepMutable<TemplateLayout>) => void): TemplateLayout {
  const clone = structuredClone(baseLayout) as DeepMutable<TemplateLayout>;
  fn(clone);
  return clone as TemplateLayout;
}

describe('validateLayout — 어긋난 좌표를 잡는다', () => {
  it('① 시트 사용 범위 밖을 가리키면 missing-cell', () => {
    const broken = mutate((layout) => {
      const block = layout.detail.blocks[0];
      if (block) block.slotRows = [9999];
    });
    const violations = validateLayout(broken, sheetInfos);
    expect(violations.some((v) => v.kind === 'missing-cell' && v.addr === 'D9999')).toBe(true);
  });

  it('② 병합 범위 안쪽을 가리키면 merge-interior — 거기 쓰면 값이 안 보인다', () => {
    // 인건비 인력구분 열은 `C65:C87` 한 덩어리다. C66은 병합 안쪽이라 쓸 수 없다
    const broken = mutate((layout) => {
      const block = layout.detail.blocks.find((b) => b.key === 'personnel/null#existing');
      if (block) {
        block.columns = [
          { column: 'C', role: 'hireType', label: '인력구분', percentFormat: false, overwritesFormula: false },
        ];
      }
    });
    const violations = validateLayout(broken, sheetInfos);
    expect(violations.filter((v) => v.kind === 'merge-interior').map((v) => v.addr)).toContain('C66');
  });

  it('③ 소계 셀을 데이터 대상으로 지정하면 formula-target (X-4a)', () => {
    // 슬롯 행이 소계 줄(88행)까지 내려가면 `J88 = SUM(J65:J87)`에 값이 박힌다.
    // 그러면 사용자가 엑셀에서 한 칸을 고쳐도 소계가 따라오지 않고 검산이 사라진다
    const broken = mutate((layout) => {
      const block = layout.detail.blocks.find((b) => b.key === 'personnel/null#existing');
      if (block) block.slotRows = [88];
    });
    const violations = validateLayout(broken, sheetInfos);
    expect(violations.filter((v) => v.kind === 'formula-target').map((v) => v.addr)).toContain('J88');
  });

  it('③-1 행 금액 열이 수식인 것은 위반이 아니다 (X-4) — 앱 값으로 덮어쓴다', () => {
    // `J65 = TRUNC(G65*H65*I65,-3)`는 정상이다. 원본 조정상수가 박혀 있던 자리이며,
    // §5.17 adjustment를 표현할 방법이 없어 사용자 결정으로 값 덮어쓰기를 택했다
    const personnel = baseLayout.detail.blocks.find((b) => b.key === 'personnel/null#existing');
    expect(personnel?.columns.find((c) => c.role === 'cashTotal')?.column).toBe('J');
    expect(personnel?.columns.find((c) => c.role === 'cashTotal')?.overwritesFormula).toBe(true);
    expect(validateLayout(baseLayout, sheetInfos).filter((v) => v.kind === 'formula-target')).toEqual([]);
  });

  it('④ 비목을 정할 수 없는 총괄표 행에서 conflict를 지우면 unresolved-summary-row (X-10b)', () => {
    const broken = mutate((layout) => {
      for (const row of layout.summary.rows) {
        if (row.row === 24 || row.row === 25) delete row.conflict;
      }
    });
    const violations = validateLayout(broken, sheetInfos);
    expect(violations.filter((v) => v.kind === 'unresolved-summary-row').map((v) => v.path)).toEqual([
      'summary.rows[24]',
      'summary.rows[25]',
    ]);
  });

  it('⑤ 집계 행에서 aggregate·memo를 둘 다 지우면 unresolved-summary-row (X-10c)', () => {
    // 표시를 지우면 그 줄은 검증도 통과하고 값도 안 들어간 채 **다른 연차의 수식만 남는다**
    const broken = mutate((layout) => {
      for (const row of layout.summary.rows) {
        if (row.row === 12 || row.row === 16) {
          delete row.aggregate;
          delete row.memo;
        }
      }
    });
    const violations = validateLayout(broken, sheetInfos);
    expect(violations.filter((v) => v.kind === 'unresolved-summary-row').map((v) => v.path)).toEqual([
      'summary.rows[12]',
      'summary.rows[16]',
    ]);
  });

  it('집계·비율 행의 연차 칸은 formula-target이 아니다 — 앱이 값으로 덮어쓴다 (X-10c)', () => {
    // 총괄표에서 템플릿이 굴리는 것은 연차 합계 열뿐이다. 집계 행의 연차 칸을 보호 대상으로
    // 잡아 두면 X-10c의 쓰기가 전부 위반으로 잡혀 내보내기가 막힌다
    const aggregated = baseLayout.summary.rows.filter((r) => r.kind !== 'amount');
    expect(aggregated.length).toBeGreaterThan(0);
    const violations = validateLayout(baseLayout, sheetInfos);
    expect(violations.filter((v) => v.kind === 'formula-target')).toEqual([]);
  });

  it('없는 시트를 가리키면 missing-sheet', () => {
    const broken = mutate((layout) => {
      layout.detail.sheet = '1차년도_250520';
    });
    const violations = validateLayout(broken, sheetInfos);
    expect(violations.some((v) => v.kind === 'missing-sheet' && v.sheet === '1차년도_250520')).toBe(true);
  });

  it('수식이 없는 시트를 가리키면 dangling-sheet-ref — 시트명만 바꾼 템플릿을 잡는다', () => {
    const renamed = sheetInfos.map((info) =>
      info.name === '총괄표' ? { ...info, referencedSheets: ['1차년도_250520'] } : info
    );
    const violations = validateLayout(baseLayout, renamed);
    expect(violations.some((v) => v.kind === 'dangling-sheet-ref')).toBe(true);
  });

  it('위반을 첫 건에서 멈추지 않고 전부 모은다', () => {
    const broken = mutate((layout) => {
      const block = layout.detail.blocks.find((b) => b.key === 'personnel/null#existing');
      // 소계 3줄(88·91·92)을 슬롯으로 지정 — 금액 열마다 한 건씩 잡혀야 한다
      if (block) block.slotRows = [88, 91, 92];
    });
    const violations = validateLayout(broken, sheetInfos);
    expect(violations.filter((v) => v.kind === 'formula-target').length).toBeGreaterThanOrEqual(2);
  });
});
