// 입력 양식 서식 (SOT 부록 F F-1~F-8·F-10, §6.16 IN-7·IN-8, §7.9.7 "서식(Phase 19)", §11 Phase 19 완료 기준)
//
// 부록 B.7 축소 픽스처(인력 3명·활동비 2행·간접비 1행) → `buildInputForm` → `writeInputFormWorkbook` → **exceljs로
// 다시 열어** 파일에 실제로 기록된 서식을 본다. xlsx-style.test.ts는 헬퍼 하나하나를, input-form-adapter.test.ts는
// 힌트 없는 FormSheet를 검증한다 — 여기는 생성기의 힌트가 어댑터를 거쳐 **실제 양식의 어느 셀에** 어떤 서식으로
// 떨어지는지를 좌표 맵(`columnOf`)으로 잡아 확인한다. 기준값은 부록 F 표이고 `XLSX_STYLE` 상수를 그대로 쓴다 —
// 상수가 부록 F와 어긋나는지는 xlsx-style.test.ts가 본다.
//
// 백분율 서식 0건(F-6·X-7)은 워크북 **전 시트 전 셀**을 훑는다 — 열 하나만 보면 다른 열에 새어 든 `%`를 놓친다.

import { describe, expect, it } from 'vitest';
import ExcelJS from 'exceljs';
import {
  GUIDE_ROW_LABELS,
  GUIDE_SHEET_NAME,
  INPUT_FORM_SHEETS,
  INPUT_FORM_TITLE,
  buildInputForm,
  columnOf,
} from '@/lib/input-form';
import type { InputFormData } from '@/lib/input-form';
import { writeInputFormWorkbook } from '@/lib/input-form-adapter';
import { XLSX_STYLE, argb } from '@/lib/xlsx-style';
import type { BudgetDetail, DetailAxis, Member } from '@/types';

const PROJECT = { id: 'proj-1', name: '스마트 건설 플랫폼' };
const YEAR = { id: 'year-1', name: '1차년도', startDate: '2025-04-01', endDate: '2025-12-31', order: 0 };
const TODAY = '2026-09-25';

const PERSONNEL_DEF = INPUT_FORM_SHEETS.personnel;
const BUDGET_DEF = INPUT_FORM_SHEETS.budget;
const META_DEF = INPUT_FORM_SHEETS.meta;

// ─── 부록 B.7 축소 픽스처 ────────────────────────────────────

/** [성명, 연봉, 참여율, 축, 개월, 최종 금액, 조정액] — B.7.1에서 3행 */
const PERSONNEL: ReadonlyArray<readonly [string, number, number, DetailAxis, number, number, number]> = [
  ['여욱현', 180_000_000, 10.0, 'cash', 9, 13_500_000, 0],
  ['박선욱', 74_000_000, 28.0, 'cash', 9, 15_540_000, 0],
  ['지동민', 84_000_000, 64.0, 'in_kind', 9, 40_050_000, -270_000],
] as const;

type FormMember = Member & { staffName: string | null };

function member(partial: Partial<FormMember> & Pick<Member, 'id' | 'name' | 'order'>): FormMember {
  return {
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    version: 1,
    createdBy: null,
    updatedBy: null,
    projectId: PROJECT.id,
    orgId: null,
    role: 'researcher',
    position: '연구원',
    field: '',
    email: '',
    phone: '',
    active: true,
    annualSalary: null,
    hireType: 'existing',
    staffId: null,
    salaryIncludesRetirement: null,
    salaryIncludesInsurance: null,
    salaryAppliedFrom: null,
    staffName: null,
    ...partial,
  };
}

function detail(partial: Partial<BudgetDetail> & Pick<BudgetDetail, 'id' | 'category' | 'subcategory'>): BudgetDetail {
  return {
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    version: 1,
    createdBy: null,
    updatedBy: null,
    projectId: PROJECT.id,
    yearId: YEAR.id,
    axis: 'cash',
    formula: 'quantity',
    memberId: null,
    name: '',
    unitPrice: 0,
    spec: '',
    factors: [],
    adjustment: 0,
    note: '',
    order: 0,
    amount: 0,
    ...partial,
  };
}

const MEMBERS: FormMember[] = PERSONNEL.map(([name, salary], index) =>
  member({ id: `m-${index}`, name, order: index, annualSalary: salary })
);

const PERSONNEL_DETAILS: BudgetDetail[] = PERSONNEL.map(([, , rate, axis, months, amount, adjustment], index) =>
  detail({
    id: `p-${index}`,
    category: 'personnel',
    subcategory: 'personnel_internal',
    axis,
    formula: 'personnel',
    memberId: `m-${index}`,
    adjustment,
    factors: [
      { label: '참여율(%)', value: rate, isPercent: true },
      { label: '참여기간(월)', value: months, isPercent: false },
    ],
    order: index,
    amount,
  })
);

/** B.7.2 활동비 2행 + B.7.3 간접비 1행 */
const QUANTITY_DETAILS: BudgetDetail[] = [
  detail({
    id: 'q-meeting',
    category: 'activity',
    subcategory: 'activity_meeting',
    name: '회의비',
    unitPrice: 500_000,
    factors: [{ label: '회', value: 6, isPercent: false }],
    amount: 3_000_000,
  }),
  detail({
    id: 'q-travel',
    category: 'activity',
    subcategory: 'activity_travel_dom',
    name: '국내출장비',
    unitPrice: 150_000,
    factors: [
      { label: '인원', value: 2, isPercent: false },
      { label: '횟수', value: 4, isPercent: false },
    ],
    amount: 1_200_000,
  }),
  detail({
    id: 'q-safety',
    category: 'indirect',
    subcategory: 'indirect_support',
    name: '연구실 안전관리비',
    unitPrice: 2_000_000,
    amount: 2_000_000,
  }),
];

const DATA: InputFormData = {
  project: PROJECT,
  year: YEAR,
  members: MEMBERS,
  details: [...PERSONNEL_DETAILS, ...QUANTITY_DETAILS],
};

// ─── 파이프라인: 생성 → exceljs 쓰기 → exceljs 다시 열기 ───────

const form = buildInputForm(DATA, TODAY);
const buffer = await writeInputFormWorkbook(form);
const workbook = new ExcelJS.Workbook();
await workbook.xlsx.load(buffer as unknown as ArrayBuffer);

function sheet(name: string): ExcelJS.Worksheet {
  const ws = workbook.getWorksheet(name);
  if (!ws) throw new Error(`다시 연 워크북에 '${name}' 시트가 없다`);
  return ws;
}

function formSheet(name: string) {
  const found = form.sheets.find((s) => s.name === name);
  if (!found) throw new Error(`FormSheet '${name}'이 없다`);
  return found;
}

/** 역할 → 1-based 열 번호 */
function col(def: typeof PERSONNEL_DEF, role: string): number {
  return columnOf(def, role) + 1;
}

const guide = sheet(GUIDE_SHEET_NAME);
const personnel = sheet(PERSONNEL_DEF.name);
const budget = sheet(BUDGET_DEF.name);
const meta = sheet(META_DEF.name);

const HEADER_FILL = argb(XLSX_STYLE.color.headerFill);
const KEY_FILL = argb(XLSX_STYLE.color.keyFill);
const SUMMARY_FILL = argb(XLSX_STYLE.color.summaryFill);
const BORDER = argb(XLSX_STYLE.color.border);
const TEXT = argb(XLSX_STYLE.color.text);
const MUTED = argb(XLSX_STYLE.color.muted);
const WHITE = argb(XLSX_STYLE.color.headerText);

function fillArgb(cell: ExcelJS.Cell): string | undefined {
  const fill = cell.fill as ExcelJS.FillPattern | undefined;
  if (!fill || fill.type !== 'pattern' || fill.pattern !== 'solid') return undefined;
  return fill.fgColor?.argb;
}

function expectThinBorders(cell: ExcelJS.Cell, where: string): void {
  for (const side of ['top', 'left', 'bottom', 'right'] as const) {
    expect(cell.border?.[side]?.style, `${where} ${side}`).toBe('thin');
    expect(cell.border?.[side]?.color?.argb, `${where} ${side} 색`).toBe(BORDER);
  }
}

/** 첫 데이터 행(1-based). 두 시트 모두 dataStartRow다 */
const P_ROW = PERSONNEL_DEF.dataStartRow;
const B_ROW = BUDGET_DEF.dataStartRow;

// ═══ 시트 구성 ═══════════════════════════════════════════════════

describe('시트 구성 (F-8·IN-2)', () => {
  it('순서 [작성안내, 인건비, 사업비, _meta] — _meta만 hidden', () => {
    expect(workbook.worksheets.map((ws) => ws.name)).toEqual([
      GUIDE_SHEET_NAME,
      PERSONNEL_DEF.name,
      BUDGET_DEF.name,
      META_DEF.name,
    ]);
    expect(meta.state).toBe('hidden');
    expect(guide.state).toBe('visible');
    expect(personnel.state).toBe('visible');
    expect(budget.state).toBe('visible');
  });

  it('탭 색: 모든 시트 1A1A1A — 안내 시트 포함 (F-10, 샘플 실측)', () => {
    expect(guide.properties.tabColor?.argb).toBe(argb(XLSX_STYLE.tab.guide));
    expect(personnel.properties.tabColor?.argb).toBe(argb(XLSX_STYLE.tab.data));
    expect(budget.properties.tabColor?.argb).toBe(argb(XLSX_STYLE.tab.data));
  });

  it('인쇄: 세 시트 모두 가로, 페이지 너비 맞춤. 데이터 시트는 헤더 행 반복 (F-10)', () => {
    for (const ws of [guide, personnel, budget]) {
      expect(ws.pageSetup.orientation, ws.name).toBe('landscape');
      expect(ws.pageSetup.fitToPage, ws.name).toBe(true);
      expect(ws.pageSetup.fitToWidth, ws.name).toBe(1);
    }
    expect(personnel.pageSetup.printTitlesRow).toBe(`${PERSONNEL_DEF.headerRow}:${PERSONNEL_DEF.headerRow}`);
    expect(budget.pageSetup.printTitlesRow).toBe(`${BUDGET_DEF.headerRow}:${BUDGET_DEF.headerRow}`);
  });
});

// ═══ 작성안내 (F-8) ═══════════════════════════════════════════════

describe('작성안내 시트 (F-8)', () => {
  it('A1 "{과제명} — 사업비 입력 양식" 20pt 굵게 Pretendard', () => {
    const a1 = guide.getCell('A1');
    expect(a1.value).toBe(`${PROJECT.name} — ${INPUT_FORM_TITLE}`);
    expect(a1.font?.size).toBe(XLSX_STYLE.titleSize);
    expect(a1.font?.bold).toBe(true);
    expect(a1.font?.name).toBe(XLSX_STYLE.font.name);
    expect(a1.font?.color?.argb).toBe(TEXT);
  });

  it('A2 부제 "생성 {일시} · {연차} · 제안" 보조 색', () => {
    const a2 = guide.getCell('A2');
    expect(a2.value).toBe(`생성 ${TODAY} · ${YEAR.name} · 제안`);
    expect(a2.font?.color?.argb).toBe(MUTED);
    expect(a2.font?.size).toBe(XLSX_STYLE.font.size);
    expect(a2.font?.bold).toBeFalsy();
  });

  it('A4부터 라벨 5개 — 키 열 F7F7F7 굵게, 값 열 줄바꿈·thin 테두리', () => {
    GUIDE_ROW_LABELS.forEach((label, i) => {
      const r = 4 + i;
      const labelCell = guide.getCell(r, 1);
      const valueCell = guide.getCell(r, 2);
      expect(labelCell.value, `A${r}`).toBe(label);
      expect(fillArgb(labelCell), `A${r} 채움`).toBe(SUMMARY_FILL);
      expect(labelCell.font?.bold, `A${r} 굵게`).toBe(true);
      expect(typeof valueCell.value, `B${r}`).toBe('string');
      expect(valueCell.alignment?.wrapText, `B${r} 줄바꿈`).toBe(true);
      expectThinBorders(labelCell, `A${r}`);
      expectThinBorders(valueCell, `B${r}`);
    });
    // 3행은 빈 줄
    expect(guide.getCell('A3').value).toBeNull();
  });

  it('"주의"에 "금액 열은 읽지 않는다"가 있다 (제안 모드, §7.9.7)', () => {
    const cautionRow = 4 + GUIDE_ROW_LABELS.indexOf('주의');
    expect(String(guide.getCell(cautionRow, 2).value)).toContain('금액 열은 읽지 않는다');
  });

  it('라벨 열 16 · 값 열 120 (F-8)', () => {
    expect(guide.getColumn(1).width).toBe(XLSX_STYLE.guide.labelColumnWidth);
    expect(guide.getColumn(2).width).toBe(XLSX_STYLE.guide.valueColumnWidth);
  });
});

// ═══ 헤더 (F-2) ═══════════════════════════════════════════════════

describe('헤더 행 (F-2)', () => {
  it.each([
    [PERSONNEL_DEF.name, personnel, PERSONNEL_DEF],
    [BUDGET_DEF.name, budget, BUDGET_DEF],
  ])('%s: 전 열이 1A1A1A 채움·흰 굵은 Pretendard·아래 medium·세로 가운데·줄바꿈', (_, ws, def) => {
    def.columns.forEach((column, i) => {
      const cell = ws.getCell(def.headerRow, i + 1);
      const where = `${def.name} 헤더 ${column.label}`;
      expect(cell.value, where).toBe(column.label);
      expect(fillArgb(cell), `${where} 채움`).toBe(HEADER_FILL);
      expect(cell.font?.bold, `${where} 굵게`).toBe(true);
      expect(cell.font?.color?.argb, `${where} 글자색`).toBe(WHITE);
      expect(cell.font?.name, `${where} 글꼴`).toBe(XLSX_STYLE.font.name);
      expect(cell.font?.size, `${where} 크기`).toBe(XLSX_STYLE.font.size);
      expect(cell.border?.bottom?.style, `${where} 아래 테두리`).toBe('medium');
      expect(cell.alignment?.vertical, `${where} 세로`).toBe('middle');
      expect(cell.alignment?.horizontal, `${where} 가로`).toBe('left');
      expect(cell.alignment?.wrapText, `${where} 줄바꿈`).toBe(true);
    });
  });
});

// ═══ 키 열·입력 열 (F-3) ══════════════════════════════════════════

describe('키 열 베이지·입력 열 흰색 (F-3)', () => {
  it('인건비: 성명·연봉·산식 금액·금액은 F4F1EA + 보조 글자, 참여율·개월·조정액·비고는 채움 없음 + 본문 글자', () => {
    for (const role of ['name', 'position', 'staff', 'salaryBasis', 'annualSalary', 'monthlySalary', 'formulaAmount', 'amount']) {
      const cell = personnel.getCell(P_ROW, col(PERSONNEL_DEF, role));
      expect(fillArgb(cell), `인건비 ${role} 채움`).toBe(KEY_FILL);
      expect(cell.font?.color?.argb, `인건비 ${role} 글자색`).toBe(MUTED);
    }
    for (const role of ['subcategory', 'participation', 'months', 'axis', 'adjustment', 'note']) {
      const cell = personnel.getCell(P_ROW, col(PERSONNEL_DEF, role));
      expect(fillArgb(cell), `인건비 ${role} 채움`).toBeUndefined();
      expect(cell.font?.color?.argb, `인건비 ${role} 글자색`).toBe(TEXT);
    }
  });

  it('사업비: 비목·세목 라벨·금액은 F4F1EA + 보조 글자, 품명·규격·단가·인자·조정액·축·비고는 채움 없음', () => {
    for (const role of ['category', 'subcategoryLabel', 'amount']) {
      const cell = budget.getCell(B_ROW, col(BUDGET_DEF, role));
      expect(fillArgb(cell), `사업비 ${role} 채움`).toBe(KEY_FILL);
      expect(cell.font?.color?.argb, `사업비 ${role} 글자색`).toBe(MUTED);
    }
    for (const role of ['name', 'spec', 'unitPrice', 'factor1', 'factor2', 'factor3', 'adjustment', 'axis', 'note']) {
      const cell = budget.getCell(B_ROW, col(BUDGET_DEF, role));
      expect(fillArgb(cell), `사업비 ${role} 채움`).toBeUndefined();
      expect(cell.font?.color?.argb, `사업비 ${role} 글자색`).toBe(TEXT);
    }
  });

  it('키 열 판정은 좌표 맵의 !hidden && !read와 일치한다 — 두 시트 전 열', () => {
    for (const [ws, def, row] of [
      [personnel, PERSONNEL_DEF, P_ROW],
      [budget, BUDGET_DEF, B_ROW],
    ] as const) {
      def.columns.forEach((column, i) => {
        if (column.hidden) return;
        const expected = column.read ? undefined : KEY_FILL;
        expect(fillArgb(ws.getCell(row, i + 1)), `${def.name} ${column.label}`).toBe(expected);
      });
    }
  });
});

// ═══ 테두리·정렬·소계 (F-4·F-5) ══════════════════════════════════

describe('데이터 셀 테두리·정렬 (F-4·F-5)', () => {
  it('보이는 데이터 셀 전부 4변 thin DCDCDC — 마지막 데이터 행까지', () => {
    for (const [ws, def, name] of [
      [personnel, PERSONNEL_DEF, PERSONNEL_DEF.name],
      [budget, BUDGET_DEF, BUDGET_DEF.name],
    ] as const) {
      const fs = formSheet(name);
      fs.rows.forEach((_, r) => {
        if (fs.rowRoles?.[r] !== 'data') return;
        def.columns.forEach((column, c) => {
          if (column.hidden) return;
          expectThinBorders(ws.getCell(r + 1, c + 1), `${name} ${r + 1}행 ${column.label}`);
        });
      });
    }
  });

  it('정렬: 텍스트 왼쪽·위·줄바꿈, 축 가운데, 숫자·금액 오른쪽', () => {
    const name = budget.getCell(B_ROW, col(BUDGET_DEF, 'name'));
    expect(name.alignment).toMatchObject({ horizontal: 'left', vertical: 'top', wrapText: true });
    const axis = budget.getCell(B_ROW, col(BUDGET_DEF, 'axis'));
    expect(axis.alignment?.horizontal).toBe('center');
    for (const role of ['unitPrice', 'factor1', 'adjustment', 'amount']) {
      expect(budget.getCell(B_ROW, col(BUDGET_DEF, role)).alignment?.horizontal, role).toBe('right');
    }
    for (const role of ['annualSalary', 'participation', 'months', 'formulaAmount']) {
      expect(personnel.getCell(P_ROW, col(PERSONNEL_DEF, role)).alignment?.horizontal, role).toBe('right');
    }
  });
});

describe('사업비 소계·총액 행 (F-4, §7.9.7)', () => {
  const budgetForm = formSheet(BUDGET_DEF.name);
  const sumRows = (budgetForm.rowRoles ?? [])
    .map((role, index) => ({ role, row: index + 1 }))
    .filter(({ role }) => role === 'subtotal' || role === 'total');

  it('소계·총액 행이 있고 총액은 마지막 행 하나다', () => {
    expect(sumRows.length).toBeGreaterThan(0);
    const totals = sumRows.filter(({ role }) => role === 'total');
    expect(totals).toHaveLength(1);
    expect(totals[0]?.row).toBe(budgetForm.rows.length);
  });

  it('전 열이 F7F7F7 채움·굵게·위 medium, 금액 셀은 SUM( 수식 + #,##0 + 오른쪽 정렬', () => {
    const amountCol = col(BUDGET_DEF, 'amount');
    for (const { role, row } of sumRows) {
      BUDGET_DEF.columns.forEach((column, i) => {
        const cell = budget.getCell(row, i + 1);
        const where = `${role} ${row}행 ${column.label}`;
        expect(fillArgb(cell), `${where} 채움`).toBe(SUMMARY_FILL);
        expect(cell.font?.bold, `${where} 굵게`).toBe(true);
        expect(cell.border?.top?.style, `${where} 위 테두리`).toBe('medium');
      });
      const amount = budget.getCell(row, amountCol);
      expect(amount.formula, `${role} ${row}행 수식`).toMatch(/^SUM\(/);
      expect(amount.result, `${role} ${row}행 캐시`).toBeUndefined();
      expect(amount.numFmt, `${role} ${row}행 서식`).toBe(XLSX_STYLE.numFmt.amount);
      expect(amount.alignment?.horizontal, `${role} ${row}행 정렬`).toBe('right');
    }
  });

  it('총액 행은 아래도 medium — 표의 끝', () => {
    const total = sumRows.find(({ role }) => role === 'total');
    if (!total) throw new Error('총액 행이 없다');
    expect(budget.getCell(total.row, col(BUDGET_DEF, 'amount')).border?.bottom?.style).toBe('medium');
  });

  it('인건비 시트에는 소계·총액 행이 없다 — 마지막 행이 데이터 행이고 채움이 F7F7F7이 아니다', () => {
    const personnelForm = formSheet(PERSONNEL_DEF.name);
    expect(personnelForm.rowRoles?.some((r) => r === 'subtotal' || r === 'total')).toBe(false);
    const last = personnelForm.rows.length;
    expect(fillArgb(personnel.getCell(last, col(PERSONNEL_DEF, 'note')))).toBeUndefined();
  });
});

// ═══ 틀 고정·자동 필터·숨김·너비 (F-3·F-5·F-7) ═════════════════════

describe('틀 고정·자동 필터·숨김 열·너비 (F-3·F-5·F-7)', () => {
  it.each([
    [PERSONNEL_DEF.name, personnel, PERSONNEL_DEF],
    [BUDGET_DEF.name, budget, BUDGET_DEF],
  ])('%s: frozen ySplit = dataStartRow-1, topLeftCell A{dataStartRow}, autoFilter = 헤더 행 전폭', (_, ws, def) => {
    const view = ws.views[0];
    expect(view?.state).toBe('frozen');
    if (view?.state !== 'frozen') throw new Error('frozen view가 아니다');
    expect(view.ySplit).toBe(def.dataStartRow - 1);
    expect(view.xSplit).toBe(0);
    expect(view.topLeftCell).toBe(`A${def.dataStartRow}`);
    // exceljs는 다시 열면 autoFilter를 범위 문자열로 돌려준다
    const lastColumn = ws.getColumn(def.columns.length).letter;
    expect(ws.autoFilter).toBe(`A${def.headerRow}:${lastColumn}${def.headerRow}`);
  });

  it('memberId·detailId(인건비), subcategory·detailId(사업비) 열이 hidden — 나머지는 보인다', () => {
    for (const role of ['memberId', 'detailId']) {
      expect(personnel.getColumn(col(PERSONNEL_DEF, role)).hidden, `인건비 ${role}`).toBe(true);
    }
    for (const role of ['subcategory', 'detailId']) {
      expect(budget.getColumn(col(BUDGET_DEF, role)).hidden, `사업비 ${role}`).toBe(true);
    }
    for (const [ws, def] of [
      [personnel, PERSONNEL_DEF],
      [budget, BUDGET_DEF],
    ] as const) {
      def.columns.forEach((column, i) => {
        expect(Boolean(ws.getColumn(i + 1).hidden), `${def.name} ${column.label}`).toBe(column.hidden);
      });
    }
  });

  it('열 너비: 품명 26 · 규격 40 · 비고 40 · 단가·금액 14 · 참여율 12 · 축 10 (F-7)', () => {
    expect(budget.getColumn(col(BUDGET_DEF, 'name')).width).toBe(26);
    expect(budget.getColumn(col(BUDGET_DEF, 'spec')).width).toBe(40);
    expect(budget.getColumn(col(BUDGET_DEF, 'note')).width).toBe(40);
    expect(budget.getColumn(col(BUDGET_DEF, 'unitPrice')).width).toBe(14);
    expect(budget.getColumn(col(BUDGET_DEF, 'amount')).width).toBe(14);
    expect(budget.getColumn(col(BUDGET_DEF, 'axis')).width).toBe(10);
    expect(personnel.getColumn(col(PERSONNEL_DEF, 'name')).width).toBe(26);
    expect(personnel.getColumn(col(PERSONNEL_DEF, 'participation')).width).toBe(12);
    expect(personnel.getColumn(col(PERSONNEL_DEF, 'annualSalary')).width).toBe(14);
  });

  it('사용 열 전체에 열 기본 글꼴 Pretendard 10 (F-1 — 빈 셀까지)', () => {
    for (const [ws, def] of [
      [personnel, PERSONNEL_DEF],
      [budget, BUDGET_DEF],
    ] as const) {
      def.columns.forEach((column, i) => {
        const font = ws.getColumn(i + 1).font;
        expect(font?.name, `${def.name} ${column.label}`).toBe(XLSX_STYLE.font.name);
        expect(font?.size, `${def.name} ${column.label}`).toBe(XLSX_STYLE.font.size);
      });
    }
    expect(guide.getColumn(1).font?.name).toBe(XLSX_STYLE.font.name);
    expect(guide.getColumn(2).font?.name).toBe(XLSX_STYLE.font.name);
  });
});

// ═══ 숫자 서식·수식 (F-6·IN-7) ═══════════════════════════════════

describe('숫자 서식·수식 (F-6·IN-7·X-7)', () => {
  it('연봉·월급·조정액·단가·금액(수식) 열은 #,##0', () => {
    for (const role of ['annualSalary', 'monthlySalary', 'adjustment', 'formulaAmount', 'amount']) {
      expect(personnel.getCell(P_ROW, col(PERSONNEL_DEF, role)).numFmt, `인건비 ${role}`).toBe(XLSX_STYLE.numFmt.amount);
    }
    for (const role of ['unitPrice', 'adjustment', 'amount']) {
      expect(budget.getCell(B_ROW, col(BUDGET_DEF, role)).numFmt, `사업비 ${role}`).toBe(XLSX_STYLE.numFmt.amount);
    }
  });

  it('참여율·개월·인자는 일반 숫자 — numFmt 없음', () => {
    for (const role of ['participation', 'months']) {
      expect(personnel.getCell(P_ROW, col(PERSONNEL_DEF, role)).numFmt, `인건비 ${role}`).toBeFalsy();
    }
    for (const role of ['factor1', 'factor2', 'factor3']) {
      expect(budget.getCell(B_ROW, col(BUDGET_DEF, role)).numFmt, `사업비 ${role}`).toBeFalsy();
    }
    // 값도 화면 숫자 그대로다 — 28이지 0.28이 아니다
    const p = personnel.getCell(PERSONNEL_DEF.dataStartRow + 1, col(PERSONNEL_DEF, 'participation'));
    expect(p.value).toBe(28);
  });

  it("워크북 전 시트 전 셀에 '%'가 든 numFmt가 0개다 (X-7)", () => {
    const offenders: string[] = [];
    let visited = 0;
    workbook.eachSheet((ws) => {
      ws.eachRow({ includeEmpty: true }, (row, r) => {
        row.eachCell({ includeEmpty: true }, (cell, c) => {
          visited += 1;
          if (typeof cell.numFmt === 'string' && cell.numFmt.includes('%')) offenders.push(`${ws.name}!${r},${c}`);
        });
      });
    });
    // 셀을 실제로 훑었다는 확인 — 0개 방문에 0건은 검사가 아니다
    expect(visited).toBeGreaterThan(100);
    expect(offenders).toEqual([]);
  });

  it('수식 셀은 formula만 있고 result가 없다 — 인건비 3행 + 사업비 데이터 행 전부 (IN-7)', () => {
    const personnelForm = formSheet(PERSONNEL_DEF.name);
    let checked = 0;
    personnelForm.rows.forEach((row, r) => {
      if (personnelForm.rowRoles?.[r] !== 'data') return;
      for (const role of ['formulaAmount', 'amount']) {
        const c = columnOf(PERSONNEL_DEF, role);
        if (row[c]?.formula === undefined) return;
        const cell = personnel.getCell(r + 1, c + 1);
        expect(cell.formula, `인건비 ${r + 1}행 ${role}`).toBe(row[c]?.formula);
        expect(cell.result, `인건비 ${r + 1}행 ${role} 캐시`).toBeUndefined();
        checked += 1;
      }
    });
    expect(checked).toBe(PERSONNEL.length * 2);

    const budgetForm = formSheet(BUDGET_DEF.name);
    const amountCol = columnOf(BUDGET_DEF, 'amount');
    let budgetChecked = 0;
    budgetForm.rows.forEach((row, r) => {
      if (budgetForm.rowRoles?.[r] !== 'data') return;
      const cell = budget.getCell(r + 1, amountCol + 1);
      expect(cell.formula, `사업비 ${r + 1}행 금액`).toMatch(/^ROUND\(/);
      expect(cell.result, `사업비 ${r + 1}행 금액 캐시`).toBeUndefined();
      budgetChecked += 1;
    });
    expect(budgetChecked).toBeGreaterThan(QUANTITY_DETAILS.length);
  });
});

// ═══ _meta는 서식 없음 ════════════════════════════════════════════

describe('_meta 시트는 값만 있고 서식이 새어 들지 않는다', () => {
  it('첫 데이터 행에 채움·테두리·numFmt·틀 고정이 없다', () => {
    const cell = meta.getCell(META_DEF.dataStartRow, 1);
    expect(fillArgb(cell)).toBeUndefined();
    expect(cell.border?.top).toBeUndefined();
    expect(cell.numFmt).toBeFalsy();
    // exceljs는 views가 없던 시트를 null로 돌려주기도 한다
    const views = meta.views ?? [];
    expect(views.length === 0 || views[0]?.state !== 'frozen').toBe(true);
    expect(meta.autoFilter).toBeFalsy();
  });
});
