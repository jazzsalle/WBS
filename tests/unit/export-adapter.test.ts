// SheetJS 어댑터 단위 테스트 (SOT §6.12 X-4·X-4a·X-8·X-10a, §6.12.4)
//
// **실제 템플릿 파일을 대상으로 한다.** 여기서 지키려는 것은 "값을 어디에 쓰는가"(그건
// export-writes.test.ts의 몫이다)가 아니라 **워크북을 열고 → 쓰고 → 저장하고 → 다시 열었을 때
// 서식·병합·수식이 살아 있는가**이고, 그건 진짜 파일 없이는 확인할 수 없다.
//
// X-1의 전제가 바로 이 왕복 보존이다. 여기가 깨지면 템플릿에 값만 채운다는 방식 전체가 무너진다.

import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import * as XLSX from 'xlsx';
import {
  applyWrites,
  listTemplateFiles,
  readTemplate,
  templatePath,
  writeWorkbookBuffer,
} from '@/lib/export-adapter';
import { DEFAULT_TEMPLATE_ID, findTemplate, validateLayout } from '@/lib/export/layouts';
import { buildDetailWrites } from '@/lib/export/detail-sheet';
import { buildSummaryWrites } from '@/lib/export/summary-sheet';
import type { CellWrite, ExportPlanData, TemplateLayout } from '@/lib/export/types';
import { DEFAULT_INDIRECT_BASE } from '@/lib/rules';

const entry = findTemplate(DEFAULT_TEMPLATE_ID);
if (!entry) throw new Error('표준 템플릿을 찾지 못했다');
const layout: TemplateLayout = entry.layout;
const TEMPLATE_FILE = templatePath(entry.file);

const DETAIL = layout.detail.sheet;

// ─── 워크북 관찰 도구 (검증 대상인 어댑터를 쓰지 않고 직접 읽는다) ────────────

interface SheetStats {
  cells: number;
  styled: number;
  formulas: number;
  merges: number;
  /** 캐시된 계산값을 물고 있는 수식 셀 (X-4a 위반 신호) */
  cachedFormulas: string[];
}

function readRaw(buffer: Buffer): XLSX.WorkBook {
  return XLSX.read(buffer, { type: 'buffer', cellFormula: true, cellStyles: true, cellNF: true });
}

function statsOf(workbook: XLSX.WorkBook, sheetName: string): SheetStats {
  const sheet = workbook.Sheets[sheetName];
  if (!sheet) throw new Error(`시트가 없다: ${sheetName}`);
  const stats: SheetStats = { cells: 0, styled: 0, formulas: 0, merges: 0, cachedFormulas: [] };
  for (const addr of Object.keys(sheet)) {
    if (addr.startsWith('!')) continue;
    const cell = sheet[addr] as XLSX.CellObject;
    stats.cells += 1;
    if (cell.s) stats.styled += 1;
    if (typeof cell.f === 'string') {
      stats.formulas += 1;
      if (cell.v !== undefined) stats.cachedFormulas.push(`${sheetName}!${addr} → ${String(cell.v)}`);
    }
  }
  stats.merges = (sheet['!merges'] ?? []).length;
  return stats;
}

function cellOf(workbook: XLSX.WorkBook, sheetName: string, addr: string): XLSX.CellObject {
  const cell = workbook.Sheets[sheetName]?.[addr] as XLSX.CellObject | undefined;
  if (!cell) throw new Error(`셀 레코드가 없다: ${sheetName}!${addr}`);
  return cell;
}

/** 어댑터로 열어 쓰기를 적용하고 파일 바이트까지 만든 뒤 **다시 읽는다** */
function roundTrip(writes: readonly CellWrite[]): XLSX.WorkBook {
  const template = readTemplate(TEMPLATE_FILE);
  applyWrites(template.workbook, writes);
  return readRaw(writeWorkbookBuffer(template.workbook));
}

// ─── 템플릿 읽기 ─────────────────────────────────────────────

describe('readTemplate', () => {
  it('맵이 가리키는 두 시트를 모두 담는다', () => {
    const { sheets } = readTemplate(TEMPLATE_FILE);
    const names = sheets.map((sheet) => sheet.name);
    expect(names).toContain(layout.detail.sheet);
    expect(names).toContain(layout.summary.sheet);
  });

  it('cellStyles·cellNF·cellFormula를 살려 읽는다 — 하나라도 빠지면 서식이 통째로 날아간다', () => {
    const { workbook } = readTemplate(TEMPLATE_FILE);
    const stats = statsOf(workbook, DETAIL);
    expect(stats.cells).toBeGreaterThan(0);
    // 실측 워크북은 셀이 **전부** 스타일을 갖는다 (X-1)
    expect(stats.styled).toBe(stats.cells);
    expect(stats.formulas).toBeGreaterThan(0);
    // D-22: cellNF가 없으면 z가 비어 백분율 판정이 영영 false가 된다
    expect(cellOf(workbook, DETAIL, 'H65').z).toContain('%');
  });

  it('validateLayout에 그대로 넘겨 위반 0건이다 — dangling-sheet-ref 포함', () => {
    const { sheets } = readTemplate(TEMPLATE_FILE);
    const violations = validateLayout(layout, sheets);
    expect(violations.map((v) => `${v.kind} ${v.sheet}!${v.addr ?? ''} (${v.path})`)).toEqual([]);
    // 검사가 실제로 돌았는지 — referencedSheets가 비면 dangling 검사가 조용히 죽는다
    const referencing = sheets.filter((sheet) => sheet.referencedSheets.length > 0);
    expect(referencing.length).toBeGreaterThan(0);
    expect(referencing.flatMap((sheet) => sheet.referencedSheets)).toContain(layout.detail.sheet);
  });

  it('templates/*.xlsx 목록에 표준 템플릿이 있다 (X-3)', () => {
    expect(listTemplateFiles()).toContain(entry.file);
  });

  it('없는 파일은 던진다 — 빈 워크북으로 계속 가면 아무것도 안 쓰고 "성공"한다', () => {
    expect(() => readTemplate(path.join(path.dirname(TEMPLATE_FILE), '없는서식.xlsx'))).toThrow();
  });
});

// ─── 왕복 보존 (X-1) ─────────────────────────────────────────

describe('왕복 보존', () => {
  const writes: CellWrite[] = [
    // X-4: 행 금액 열은 템플릿 수식(`TRUNC(G65*H65*I65,-3)`)을 지우고 앱 값으로 덮어쓴다
    { sheet: DETAIL, addr: 'J65', value: 40_320_000, clearFormula: true },
    { sheet: DETAIL, addr: 'D65', value: '홍길동' },
    // X-7: 백분율 서식 셀 — 순수 계층이 이미 100으로 나눈 값을 준다
    { sheet: DETAIL, addr: 'H65', value: 0.64 },
    // X-8: 값을 비우되 자리는 남긴다 (축이 바뀐 슬롯의 반대편 금액 칸)
    { sheet: DETAIL, addr: 'K65', value: null, clearFormula: true },
  ];

  const before = readRaw(fs.readFileSync(TEMPLATE_FILE));
  const after = roundTrip(writes);

  it('셀 수·스타일 수·병합 수가 그대로다', () => {
    const b = statsOf(before, DETAIL);
    const a = statsOf(after, DETAIL);
    expect(a.cells).toBe(b.cells);
    expect(a.styled).toBe(b.styled);
    expect(a.merges).toBe(b.merges);
    expect(a.merges).toBeGreaterThan(0);
  });

  it('X-4: clearFormula 쓰기 뒤 그 셀에 수식이 없다 — 남기면 엑셀이 값을 덮어쓴다', () => {
    const cell = cellOf(after, DETAIL, 'J65');
    expect(cell.f).toBeUndefined();
    expect(cell.v).toBe(40_320_000);
    // 표시 문자열은 다시 읽는 쪽이 v와 z로 만든다 — 남아 있던 옛 문자열이 아니라 **새 값**이어야 한다
    expect(cell.w).toContain('40,320,000');
    // 표시형식은 그대로여야 천단위·테두리가 산다
    expect(cell.z).toBeDefined();
  });

  it('X-4a: 살려 둔 SUM 셀은 수식을 유지하고 캐시된 값이 없다', () => {
    // J88 = SUM(J65:J87). 캐시값이 남으면 엑셀이 옛 과제의 소계를 그대로 보여 준다
    const subtotal = cellOf(after, DETAIL, 'J88');
    expect(subtotal.f).toBe('SUM(J65:J87)');
    expect(subtotal.v).toBeUndefined();
    expect(statsOf(after, DETAIL).cachedFormulas).toEqual([]);
    expect(statsOf(after, layout.summary.sheet).cachedFormulas).toEqual([]);
  });

  it('X-8: value:null은 값만 비우고 스타일·표시형식은 남긴다', () => {
    const cleared = cellOf(after, DETAIL, 'K65');
    expect(cleared.v).toBeUndefined();
    expect(cleared.f).toBeUndefined();
    expect(cleared.s).toBeDefined();
    expect(cleared.z).toBeDefined();
  });

  it('X-7: 백분율 셀은 서식과 값이 함께 살아 돌아온다', () => {
    const rate = cellOf(after, DETAIL, 'H65');
    expect(rate.v).toBe(0.64);
    expect(rate.z).toContain('%');
  });

  it('맵이 가리키지 않은 셀은 건드리지 않는다', () => {
    // 소계 라벨. 값 쓰기 대상이 아니므로 원문 그대로 남아야 한다
    expect(cellOf(after, DETAIL, 'C88').v).toBe('합계');
    expect(cellOf(after, DETAIL, 'C62').v).toBe('인력구분');
  });
});

// ─── 잘못된 쓰기는 거부한다 ──────────────────────────────────

describe('applyWrites 거부', () => {
  it('없는 시트를 가리키면 던진다', () => {
    const { workbook } = readTemplate(TEMPLATE_FILE);
    expect(() => applyWrites(workbook, [{ sheet: '없는시트', addr: 'A1', value: 1 }])).toThrow(
      /없는시트/
    );
  });

  it('A1 형식이 아닌 주소는 던진다 — 조용히 무시하면 값이 통째로 사라진다', () => {
    const { workbook } = readTemplate(TEMPLATE_FILE);
    expect(() => applyWrites(workbook, [{ sheet: DETAIL, addr: '65J', value: 1 }])).toThrow();
  });

  it('서식이 없는 칸에 값을 쓰라고 하면 던진다 — 맨 숫자로 찍힌 제출 서류는 쓸 수 없다', () => {
    const { workbook } = readTemplate(TEMPLATE_FILE);
    // 사용 범위 밖이라 셀 레코드가 없다
    expect(() => applyWrites(workbook, [{ sheet: DETAIL, addr: 'Z9000', value: 1 }])).toThrow();
  });

  it('캐시된 표시 문자열(w)을 지운다 — 남기면 엑셀이 옛 문자열을 보여 준다', () => {
    const { workbook } = readTemplate(TEMPLATE_FILE);
    const target = workbook.Sheets[DETAIL]?.J65 as XLSX.CellObject;
    // 실측 템플릿은 값을 비운 상태라 w가 없다. 다른 부처 템플릿을 실측 파일에서 뜨면 남는다
    target.w = ' 99,999,999 ';
    applyWrites(workbook, [{ sheet: DETAIL, addr: 'J65', value: 1_000, clearFormula: true }]);
    expect(target.w).toBeUndefined();
    expect(target.f).toBeUndefined();
  });

  it('살려 둔 수식 셀의 캐시된 계산값을 걷어낸다 (X-4a)', () => {
    const { workbook } = readTemplate(TEMPLATE_FILE);
    const subtotal = workbook.Sheets[DETAIL]?.J88 as XLSX.CellObject;
    // 남의 과제 소계가 캐시로 남아 있는 상황
    subtotal.t = 'n';
    subtotal.v = 123_456_789;
    subtotal.w = ' 123,456,789 ';
    applyWrites(workbook, [{ sheet: DETAIL, addr: 'J65', value: 1_000, clearFormula: true }]);
    expect(subtotal.f).toBe('SUM(J65:J87)');
    expect(subtotal.v).toBeUndefined();
    expect(subtotal.w).toBeUndefined();
  });

  it('레코드가 없는 칸을 비우라는 지시는 조용히 넘어간다 — 지울 것이 없다', () => {
    const { workbook } = readTemplate(TEMPLATE_FILE);
    expect(() =>
      applyWrites(workbook, [{ sheet: DETAIL, addr: 'Z9000', value: null, clearFormula: true }])
    ).not.toThrow();
  });
});

// ─── 실제 쓰기 지시 전량 (맵 × 파일 통합) ────────────────────

describe('맵이 만든 쓰기 전량을 실제 템플릿에 적용한다', () => {
  const YEAR_1 = 'year-1';
  const plan: ExportPlanData = {
    indirectBase: DEFAULT_INDIRECT_BASE,
    years: [
      { id: YEAR_1, order: 0, name: '1차년도' },
      { id: 'year-2', order: 1, name: '2차년도' },
    ],
    members: [
      { id: 'm1', annualSalary: 63_000_000, name: '김연구', position: '책임', hireType: 'existing' },
    ],
    details: [
      {
        yearId: YEAR_1,
        category: 'personnel',
        subcategory: 'personnel_internal',
        axis: 'cash',
        formula: 'personnel',
        memberId: 'm1',
        unitPrice: 0,
        adjustment: 0,
        factors: [
          { label: '참여율', value: 64, isPercent: true },
          { label: '참여기간', value: 12, isPercent: false },
        ],
        name: '',
        spec: '',
        note: '',
        order: 0,
      },
    ],
  };

  const writes = [
    ...buildDetailWrites(plan, YEAR_1, layout),
    ...buildSummaryWrites(plan, layout).writes,
  ];

  it('쓰기 지시가 두 시트를 모두 덮는다', () => {
    expect(writes.length).toBeGreaterThan(0);
    expect(writes.some((write) => write.sheet === layout.detail.sheet)).toBe(true);
    expect(writes.some((write) => write.sheet === layout.summary.sheet)).toBe(true);
  });

  it('맵이 가리키는 모든 셀에 서식이 있다 — 하나라도 없으면 applyWrites가 던진다', () => {
    expect(() => roundTrip(writes)).not.toThrow();
  });

  it('전량 적용 뒤에도 서식·병합·소계 수식이 그대로다', () => {
    const before = readRaw(fs.readFileSync(TEMPLATE_FILE));
    const after = roundTrip(writes);
    for (const sheetName of [layout.detail.sheet, layout.summary.sheet]) {
      const b = statsOf(before, sheetName);
      const a = statsOf(after, sheetName);
      expect(a.cells, sheetName).toBe(b.cells);
      expect(a.styled, sheetName).toBe(b.styled);
      expect(a.merges, sheetName).toBe(b.merges);
      expect(a.cachedFormulas, sheetName).toEqual([]);
    }
    // X-4a: 블록 소계·비목 합계는 살아 있어야 사용자가 엑셀에서 고친 값이 따라온다
    expect(cellOf(after, DETAIL, 'J88').f).toBe('SUM(J65:J87)');
    expect(cellOf(after, DETAIL, 'L96').f).toBeDefined();
  });

  it('X-4: 인건비 첫 행 금액은 앱 값이고 수식이 사라졌다', () => {
    const after = roundTrip(writes);
    const cell = cellOf(after, DETAIL, 'J65');
    expect(cell.f).toBeUndefined();
    // 63,000,000 × 64% × 12/12 = 40,320,000 (PL-1)
    expect(cell.v).toBe(40_320_000);
  });

  it('X-10a: 총괄표 1차년도 열의 시트 참조 수식이 값으로 바뀐다', () => {
    const after = roundTrip(writes);
    const firstYear = layout.summary.yearColumns.find((column) => column.yearIndex === 1);
    expect(firstYear?.linked).toBe(true);
    const cell = cellOf(after, layout.summary.sheet, `${firstYear?.column}4`);
    expect(cell.f).toBeUndefined();
  });
});
