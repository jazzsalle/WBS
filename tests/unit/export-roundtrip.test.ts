// 왕복 검증 — **Phase 11의 완료 기준**이다 (SOT §11).
//
//   부록 B.7의 실측 계획 데이터 (앱 쪽 진실)
//     → buildDetailWrites + buildSummaryWrites (§6.12 X-4~X-8·X-10a~X-10e)
//     → readTemplate → applyWrites → writeWorkbookBuffer (lib/export-adapter)
//     → 그 버퍼를 lib/import-adapter로 다시 읽어 §6.11 파서에 넣는다
//     → 원래 계획 데이터와 대조
//
// DB를 타지 않는다. 순수 계층 + 두 어댑터만으로 왕복이 성립해야 하며, 성립하면 **엑셀과 앱 중
// 어느 쪽에서 작업하든 같은 결과**라는 뜻이다 (§11).
//
// **SheetJS는 수식을 재계산하지 않는다.** 그래서 X-4a("엑셀이 재계산한 소계와 앱의 소계가
// 일치한다")를 파일만 읽어서는 확인할 수 없다 — 살려 둔 `SUM` 수식을 **우리가 직접 파싱해
// 합산**한다(아래 `recalc`). 엑셀이 할 계산을 대신 하는 것이고, 모르는 함수를 만나면 조용히
// 건너뛰지 않고 **던진다** (건너뛰면 검산 자체가 사라진다).
//
// 기준값은 전부 SOT다 — 부록 B.7.1(인건비 19행)·B.7.2(quantity 행)·B.7.3(집계)·B.8.3(소계 셀).
// 구현이 낸 값을 기준으로 삼지 않는다.

import { describe, expect, it } from 'vitest';
import * as XLSX from 'xlsx';
import {
  applyWrites,
  readTemplate,
  templatePath,
  writeWorkbookBuffer,
} from '@/lib/export-adapter';
import { readWorkbook } from '@/lib/import-adapter';
import { DEFAULT_TEMPLATE_ID, encodeAddr, findTemplate } from '@/lib/export/layouts';
import { buildDetailWrites, checkCapacity } from '@/lib/export/detail-sheet';
import { buildSummaryWrites } from '@/lib/export/summary-sheet';
import type {
  CellWrite,
  ExportDetailRow,
  ExportMember,
  ExportPlanData,
  TemplateLayout,
} from '@/lib/export/types';
import { aggregateDetails } from '@/lib/budget-plan';
import { detectBlocks, detectSections, parseDetailRows } from '@/lib/import/detail-sheet';
import type { DetailDraftRow, FileSubtotal } from '@/lib/import/detail-sheet';
import type { DetailAxis } from '@/types';
import { DEFAULT_INDIRECT_BASE } from '@/lib/rules';

const entry = findTemplate(DEFAULT_TEMPLATE_ID);
if (!entry) throw new Error('표준 템플릿을 찾지 못했다');
const layout: TemplateLayout = entry.layout;
const DETAIL = layout.detail.sheet;
const SUMMARY = layout.summary.sheet;

const YEAR_1 = 'year-1';

// ─── 부록 B.7.1 인건비 19행 (실측 산자부 1차년도, 참여기간 9개월) ─────────────
//
// [성명, 연봉, 참여율, 축, 개월, **최종 금액**, 조정액]. 조정액은 `최종 − 산식`으로 역산한 값이고
// 최종 금액 열이 원본 셀 값이다 (B.7.1 주석). B.8.4: 이 조정액 열이 곧 임포트의 기대 산출물이다.

const PERSONNEL: ReadonlyArray<readonly [string, number, number, DetailAxis, number, number, number]> = [
  ['여욱현', 180_000_000, 10.0, 'cash', 9, 13_500_000, 0],
  ['김영', 90_000_000, 30.0, 'cash', 9, 20_250_000, 0],
  ['김지웅', 90_000_000, 30.0, 'in_kind', 9, 20_250_000, 0],
  ['박선욱', 74_000_000, 28.0, 'cash', 9, 15_540_000, 0],
  ['지동민', 84_000_000, 64.0, 'in_kind', 9, 40_050_000, -270_000],
  ['도상래', 64_000_000, 10.0, 'cash', 9, 4_800_000, 0],
  ['이경아', 54_000_000, 70.0, 'in_kind', 9, 28_350_000, 0],
  ['김다래', 54_000_000, 26.0, 'cash', 9, 10_500_000, -30_000],
  ['김도현', 52_000_000, 10.0, 'cash', 9, 3_900_000, 0],
  ['유태일', 46_200_000, 15.0, 'cash', 9, 5_190_000, -7_500],
  ['정우진', 51_000_000, 40.0, 'cash', 9, 15_300_000, 0],
  ['김형식', 43_500_000, 41.0, 'cash', 9, 13_370_000, -6_250],
  ['신나리', 38_000_000, 40.0, 'cash', 9, 11_400_000, 0],
  ['양소희', 39_000_000, 30.0, 'cash', 9, 8_770_000, -5_000],
  ['이다정', 41_100_000, 20.0, 'cash', 9, 6_160_000, -5_000],
  ['안승현', 36_000_000, 14.0, 'cash', 9, 3_780_000, 0],
  ['진호령', 33_000_000, 30.0, 'cash', 9, 7_420_000, -5_000],
  ['장선우', 32_000_000, 29.0, 'cash', 9, 6_960_000, 0],
  // 신규채용은 8개월 — hireType이 `new`라 서식의 별도 하위 블록으로 간다 (부록 B.8.1)
  ['신규채용1(청년의무)', 51_000_000, 100.0, 'cash', 8, 34_000_000, 0],
] as const;

const NEW_HIRE_INDEX = PERSONNEL.length - 1;

const MEMBERS: ExportMember[] = PERSONNEL.map(([name, salary], index) => ({
  id: name,
  name,
  position: '연구원',
  annualSalary: salary,
  hireType: index === NEW_HIRE_INDEX ? ('new' as const) : ('existing' as const),
}));

function personnelRow(
  row: readonly [string, number, number, DetailAxis, number, number, number],
  order: number
): ExportDetailRow {
  const [name, , rate, axis, months, , adjustment] = row;
  return {
    yearId: YEAR_1,
    category: 'personnel',
    subcategory: 'personnel_internal',
    axis,
    formula: 'personnel',
    memberId: name,
    unitPrice: 0, // PL-D1: 인건비의 단가는 명부 연봉이다
    adjustment,
    factors: [
      { label: '참여율(%)', value: rate, isPercent: true },
      { label: '참여기간(월)', value: months, isPercent: false },
    ],
    name: '',
    spec: '',
    note: '',
    order,
  };
}

function quantityRow(
  partial: Partial<ExportDetailRow> & Pick<ExportDetailRow, 'category' | 'subcategory' | 'name'>
): ExportDetailRow {
  return {
    yearId: YEAR_1,
    axis: 'cash',
    formula: 'quantity',
    memberId: null,
    unitPrice: 0,
    adjustment: 0,
    factors: [],
    spec: '',
    note: '',
    order: 0,
    ...partial,
  };
}

// ─── 부록 B.7.2 quantity 행 + B.7.3 간접비 ───────────────────────────────────
//
// 연구활동비 5행 = 27,020,000, 간접비 2,000,000. 둘을 합쳐야 B.7.3의 총액 298,510,000이 나온다.

const MEETING = quantityRow({
  category: 'activity',
  subcategory: 'activity_meeting',
  name: '회의비',
  unitPrice: 500_000,
  factors: [{ label: '회', value: 6, isPercent: false }],
});

const SOFTWARE = quantityRow({
  category: 'activity',
  subcategory: 'activity_software',
  name: 'AEC Collection',
  unitPrice: 540_000,
  // B.8.2: 실측 라벨이 `시트(수량)`다. PL-3이 라벨을 자유롭게 두는 이유
  factors: [
    { label: '시트(수량)', value: 4, isPercent: false },
    { label: '월', value: 9, isPercent: false },
  ],
});

const TRAVEL = quantityRow({
  category: 'activity',
  subcategory: 'activity_travel_dom',
  name: '국내출장비',
  unitPrice: 150_000,
  factors: [
    { label: '인원', value: 2, isPercent: false },
    { label: '횟수', value: 4, isPercent: false },
  ],
});

const PRINTING = quantityRow({
  category: 'activity',
  subcategory: 'activity_etc',
  name: '인쇄/복사/인화/슬라이드 제작',
  unitPrice: 450_000,
  factors: [{ label: '회', value: 2, isPercent: false }],
  order: 0,
});

const SETTLEMENT = quantityRow({
  category: 'activity',
  subcategory: 'activity_etc',
  name: '위탁정산 수수료',
  unitPrice: 2_480_000,
  factors: [{ label: '회', value: 1, isPercent: false }],
  order: 1,
});

const SAFETY = quantityRow({
  category: 'indirect',
  subcategory: 'indirect_support',
  name: '연구실 안전관리비',
  unitPrice: 2_000_000,
  factors: [{ label: '수량', value: 1, isPercent: false }],
});

const QUANTITY = [MEETING, SOFTWARE, TRAVEL, PRINTING, SETTLEMENT, SAFETY] as const;

const plan: ExportPlanData = {
  details: [...PERSONNEL.map((row, index) => personnelRow(row, index)), ...QUANTITY],
  members: MEMBERS,
  years: [{ id: YEAR_1, order: 0, name: '1차년도' }],
  indirectBase: DEFAULT_INDIRECT_BASE,
};

// ─── 앱 → 파일 (한 번만 만든다) ───────────────────────────────────────────────

const detailWrites = buildDetailWrites(plan, YEAR_1, layout);
const summaryResult = buildSummaryWrites(plan, layout);
const writes: CellWrite[] = [...detailWrites, ...summaryResult.writes];

/** 쓰기를 반영한 워크북. 직렬화 **전** 상태라 낡은 `w`(표시 문자열)가 남았는지 여기서 본다 */
const applied = (() => {
  const template = readTemplate(templatePath(entry.file));
  applyWrites(template.workbook, writes);
  return template.workbook;
})();

const exported: Buffer = writeWorkbookBuffer(applied);

/** 내보낸 파일을 **수식·서식까지 살려** 다시 읽은 워크북. (b)·(c)가 쓴다 */
const reread = XLSX.read(exported, {
  type: 'buffer',
  cellFormula: true,
  cellStyles: true,
  cellNF: true,
});

/** 값을 쓰지 않은 템플릿 원본. 총괄표 행 ↔ 산출근거 셀 대응을 **맵이 아니라 파일에서** 읽는다 */
const pristine = readTemplate(templatePath(entry.file)).workbook;

// ─── 파일 → 앱 (§6.11 임포트 경로 그대로) ─────────────────────────────────────

const reimported = (() => {
  const sheets = readWorkbook(new Uint8Array(exported));
  const sheet = sheets.find((s) => s.name === DETAIL);
  if (!sheet) throw new Error(`내보낸 파일에 '${DETAIL}' 시트가 없다`);
  const sections = detectSections(sheet);
  const blocks = detectBlocks(sheet, sections);
  const rows: DetailDraftRow[] = [];
  const subtotals: FileSubtotal[] = [];
  for (const block of blocks) {
    const parsed = parseDetailRows(sheet, block);
    rows.push(...parsed.rows);
    subtotals.push(...parsed.subtotals);
  }
  return { sheet, sections, blocks, rows, subtotals };
})();

const backPersonnel = reimported.rows.filter((row) => row.category === 'personnel');
const backByName = new Map(reimported.rows.map((row) => [row.name, row]));

function sumBack(axis: DetailAxis, filter: (row: DetailDraftRow) => boolean): number {
  return reimported.rows
    .filter((row) => row.axis === axis && filter(row))
    .reduce((sum, row) => sum + row.fileAmount, 0);
}

// ═══ (a) 왕복 동일성 ═════════════════════════════════════════════════════════

describe('(a) 왕복 — 부록 B.7.1 인건비 19행이 원 단위까지 돌아온다', () => {
  it('섹션·행 수가 그대로다 — 19행이 나가고 19행이 돌아온다 (D-1·D-5)', () => {
    expect(reimported.sections.map((section) => section.kind)).toEqual(['direct', 'indirect']);
    expect(backPersonnel.length).toBe(PERSONNEL.length);
    // D-5: 인건비는 `합계`(기존) → `합계`(신규) → `소 계` 3단이다. 첫 소계에서 멈추면
    // 신규채용 34,000,000을 통째로 놓친다 (부록 B.8.1)
    expect(backPersonnel[NEW_HIRE_INDEX]?.memberName).toBe(PERSONNEL[NEW_HIRE_INDEX]![0]);
  });

  it('돌아온 행 수가 나간 행 수와 같다 — 서식 잔재가 유령 행을 만들지 않는다', () => {
    // X-8이 빈 슬롯을 비우므로 템플릿에 남아 있던 예시 라벨(`회의비`·`국외출장비`…)이 행으로
    // 되살아나면 안 된다. 반대로 한 행이라도 줄면 예산이 조용히 사라진 것이다
    expect(reimported.rows.length).toBe(plan.details.length);
  });

  it('성명·직위·연봉·축·참여율·참여기간·금액·조정액이 전건 일치한다', () => {
    backPersonnel.forEach((back, index) => {
      const [name, salary, rate, axis, months, amount, adjustment] = PERSONNEL[index]!;
      const where = `${index}행(${name})`;
      expect(back.memberName, where).toBe(name);
      expect(back.position, where).toBe('연구원');
      expect(back.fileSalary, where).toBe(salary);
      expect(back.axis, where).toBe(axis);
      expect(back.fileAmount, where).toBe(amount);
      // D-8·B.8.4: 파일의 합계 열이 진실이고 차액이 조정액으로 돌아온다.
      // 파일 연봉 = 명부 연봉이라 이 값이 곧 최종 조정액이다 (D-8a)
      expect(back.adjustment, where).toBe(adjustment);
      expect(back.factors, where).toEqual([
        { label: '참여율(%)', value: rate, isPercent: true },
        { label: '참여기간(월)', value: months, isPercent: false },
      ]);
    });
  });

  it('조정액이 붙은 행이 정확히 돌아온다 — 지동민·유태일·김형식 (B.7.1)', () => {
    const find = (name: string): DetailDraftRow => {
      const row = backPersonnel.find((back) => back.memberName === name);
      if (!row) throw new Error(`${name} 행이 돌아오지 않았다`);
      return row;
    };
    expect([find('지동민').fileAmount, find('지동민').adjustment]).toEqual([40_050_000, -270_000]);
    expect([find('유태일').fileAmount, find('유태일').adjustment]).toEqual([5_190_000, -7_500]);
    expect([find('김형식').fileAmount, find('김형식').adjustment]).toEqual([13_370_000, -6_250]);
  });

  it('인건비 합계가 부록 B.7.1 그대로다 — 현금 180,840,000 / 현물 88,650,000', () => {
    const isPersonnel = (row: DetailDraftRow): boolean => row.category === 'personnel';
    expect(sumBack('cash', isPersonnel)).toBe(180_840_000);
    expect(sumBack('in_kind', isPersonnel)).toBe(88_650_000);
  });
});

describe('(a) 왕복 — X-7 ↔ D-22 참여율 백분율', () => {
  it('앱 64 → 파일 0.64 → 파서 64. 100배 오차가 어느 방향으로도 나지 않는다', () => {
    const existing = layout.detail.blocks.find((block) => block.key === 'personnel/null#existing');
    if (!existing) throw new Error('맵에 인건비(기존인력) 블록이 없다');
    const rateColumn = existing.columns.find((column) => column.role === 'rate');
    expect(rateColumn?.percentFormat).toBe(true);

    // 지동민은 B.7.1의 5번째 행이고 참여율 64%다
    const addr = encodeAddr(rateColumn!.column, existing.slotRows[4]!);
    expect(detailWrites.find((write) => write.addr === addr)?.value).toBe(0.64);

    const inFile = reread.Sheets[DETAIL]?.[addr] as XLSX.CellObject | undefined;
    expect(inFile?.v).toBe(0.64);
    expect(String(inFile?.z)).toContain('%');

    const back = backPersonnel.find((row) => row.memberName === '지동민');
    expect(back?.factors[0]).toEqual({ label: '참여율(%)', value: 64, isPercent: true });
  });
});

describe('(a) 왕복 — 부록 B.7.2 quantity 행', () => {
  const cases: ReadonlyArray<readonly [string, number, readonly number[], number]> = [
    // [품명, 단가, 인자 값(열 순서), 금액]
    ['회의비', 500_000, [6], 3_000_000],
    ['AEC Collection', 540_000, [4, 9], 19_440_000],
    ['국내출장비', 150_000, [2, 4], 1_200_000],
    ['인쇄/복사/인화/슬라이드 제작', 450_000, [2], 900_000],
    ['위탁정산 수수료', 2_480_000, [1], 2_480_000],
  ];

  it.each(cases)('%s — 단가·인자·금액이 그대로 돌아온다', (name, unitPrice, factors, amount) => {
    const back = backByName.get(name);
    expect(back, `${name} 행이 돌아오지 않았다`).toBeDefined();
    expect(back!.unitPrice).toBe(unitPrice);
    expect(back!.factors.map((factor) => factor.value)).toEqual([...factors]);
    expect(back!.fileAmount).toBe(amount);
    expect(back!.axis).toBe('cash');
    // 근거가 온전히 돌아왔으므로 조정액이 없다 — 산식 결과가 파일 값과 같다 (D-8)
    expect(back!.adjustment).toBe(0);
  });

  it('세목이 나간 그대로 돌아온다 — 라벨이 아니라 **코드**가 같다 (D-3a)', () => {
    // 금액이 맞아도 세목이 어긋나면 다른 칸에 들어간 예산이다. `회의비`가 `activity_meeting`으로
    // 돌아오는지는 X-8이 비운 서식에서 파서가 표 라벨만으로 세목을 되찾는다는 뜻이기도 하다
    const wanted = QUANTITY.map((row) => [row.name, row.subcategory]);
    const back = QUANTITY.map((row) => [row.name, backByName.get(row.name)?.subcategory]);
    expect(back).toEqual(wanted);

    // 인건비 표에는 세목 헤더가 없다 — 파서는 null을 그대로 두고, `personnel_internal` 확정은
    // D-3a ②의 **제안**이라 미리보기 계층의 몫이다 (tests/integration/export-actions.test.ts가
    // 그 다음 단계에서 실제로 `personnel_internal`에 도달하는지 본다)
    expect([...new Set(backPersonnel.map((row) => row.subcategory))]).toEqual([null]);
  });

  it('연구활동비 셀 합계가 27,020,000이다 (B.7.2)', () => {
    expect(sumBack('cash', (row) => row.category === 'activity')).toBe(27_020_000);
  });

  it('인자 라벨은 파일이 아니라 **템플릿 헤더**에서 온다 — 값이 아니라 이름만 달라진다 (PL-3)', () => {
    // 내보내기는 값만 쓴다. 라벨은 서식의 컬럼 헤더가 갖고 있고 파서가 그것을 읽는다.
    // 금액에는 영향이 없지만 왕복이 라벨까지 보존하지 **않는다**는 사실은 고정해 둔다
    expect(backByName.get('AEC Collection')?.factors.map((factor) => factor.label)).toEqual([
      '산출내역 시트(수량)',
      '산출내역 월',
    ]);
  });
});

describe('(a) 왕복 — 서식에 자리가 없는 근거는 조용히 사라지지 않는다', () => {
  it('간접비 행은 금액이 돌아오지만 단가·수량은 돌아오지 않는다 (템플릿에 그 열이 없다)', () => {
    const back = backByName.get('연구실 안전관리비');
    expect(back?.fileAmount).toBe(2_000_000);
    // 표준 서식의 `나. 연구지원비`는 내역·산출내역(텍스트)·합계뿐이라 단가·수량 칸이 없다.
    // 금액은 원 단위로 살아 돌아오고, 근거는 조정액이 통째로 떠안는다 (D-8)
    expect(back?.unitPrice).toBe(0);
    expect(back?.factors).toEqual([]);
    expect(back?.adjustment).toBe(2_000_000);
  });

  it('그 사실을 내보내기 단계에서 이미 경고한다 — checkCapacity.truncatedFactors', () => {
    const report = checkCapacity(plan.details, MEMBERS, layout);
    expect(report.overflows).toEqual([]);
    expect(report.unmapped).toEqual([]);
    // `unitPriceDropped`는 X-5a — 이 표에는 인자 열뿐 아니라 **단가 열도 없다.**
    // 인자 개수만 세면(`total > kept`) 인자가 0개인 행이 판정을 통째로 빠져나간다.
    expect(report.truncatedFactors).toEqual([
      {
        blockKey: 'indirect/indirect_support',
        rowLabel: '연구실 안전관리비',
        kept: 0,
        total: 1,
        unitPriceDropped: true,
      },
    ]);
  });

  it('세목 구분이 서식 라벨에 기대는 자리는 확인을 요구한다 — ⑤ 출장비 두 표 (C.2 주의 2)', () => {
    // X-8이 빈 표의 템플릿 잔재 라벨(`국외출장비`)까지 비우므로, 데이터가 없는 두 번째 ⑤ 표는
    // 국내/국외를 가를 근거가 사라진다. **조용히 합치지 않고** travel-undecided로 확인을 요구한다
    const undecided = reimported.blocks.filter((block) => block.issues.includes('travel-undecided'));
    expect(undecided.length).toBe(1);
    expect(undecided[0]?.needsConfirm).toBe(true);
    // 그 표에는 행이 없다 — 금액이 잘못된 세목으로 넘어가지는 않는다
    expect(
      parseDetailRows(reimported.sheet, undecided[0]!).rows.length
    ).toBe(0);
  });
});

describe('(a) 왕복 — 파일의 소계 칸은 비어 있다 (그래서 (b)가 필요하다)', () => {
  it('D-18 대조 대상이 하나도 없다 — 소계는 캐시 없는 수식이라 임포트가 읽을 값이 없다', () => {
    // 임포트 어댑터는 `cellFormula: false`로 계산값(`v`)만 읽는데, X-4a대로 살려 둔 소계 수식에는
    // 캐시된 값이 없다(= (c)의 검사). 그래서 소계 검산은 파일을 읽는 것으로는 불가능하고
    // 아래 (b)에서 **수식을 우리가 직접 계산**해야 한다
    expect(reimported.subtotals).toEqual([]);
  });
});

// ═══ (b) 소계 검산 — 살려 둔 SUM을 우리가 합산한다 (X-4a) ════════════════════
//
// SheetJS는 재계산하지 않는다. 그래서 **엑셀이 할 계산을 여기서 대신 한다.**
// 지원하는 것은 실측 템플릿에 실제로 남아 있는 문법뿐이고, 그 밖을 만나면 던진다.

type CellRecord = { f?: string; v?: unknown; t?: string };

interface Token {
  kind: 'number' | 'ref' | 'func' | 'op';
  text: string;
}

const REF = String.raw`(?:'[^']+'!|[^\s!+\-*/(),:'"]+!)?\$?[A-Z]{1,3}\$?\d{1,7}`;
const TOKEN_PATTERN = new RegExp(
  String.raw`\s*(?:(\d+(?:\.\d+)?)|([A-Za-z]+)\s*\(|(${REF})|([+\-*/(),:]))`,
  'gy'
);

function tokenize(formula: string): Token[] {
  const tokens: Token[] = [];
  TOKEN_PATTERN.lastIndex = 0;
  while (TOKEN_PATTERN.lastIndex < formula.length) {
    const match = TOKEN_PATTERN.exec(formula);
    if (!match) {
      throw new Error(
        `수식을 읽지 못했다: '${formula}' (${TOKEN_PATTERN.lastIndex}번째 글자부터). ` +
          `조용히 건너뛰면 X-4a 검산이 사라진다`
      );
    }
    if (match[1] !== undefined) tokens.push({ kind: 'number', text: match[1] });
    else if (match[2] !== undefined) tokens.push({ kind: 'func', text: match[2].toUpperCase() });
    else if (match[3] !== undefined) tokens.push({ kind: 'ref', text: match[3] });
    else tokens.push({ kind: 'op', text: match[4]! });
  }
  return tokens;
}

/** 실측 템플릿에 남아 있는 함수. 그 밖의 함수를 만나면 통과시키지 않고 던진다 */
const KNOWN_FUNCTIONS = new Set(['SUM', 'TRUNC', 'ROUND']);

/** 엑셀 대신 수식을 계산하는 최소 계산기. 값이 아니라 **범위**인 항은 SUM 안에서만 허용한다 */
class Recalc {
  private readonly evaluating = new Set<string>();

  constructor(private readonly workbook: XLSX.WorkBook) {}

  /** 셀 하나의 수치. 수식이면 계산하고, 문자·빈 칸은 `null`이다 (SUM이 무시하는 값) */
  cell(sheet: string, addr: string): number | null {
    const record = this.workbook.Sheets[sheet]?.[addr] as CellRecord | undefined;
    if (!record) return null;
    // 캐시된 계산값은 **믿지 않는다** — 엑셀처럼 수식에서 다시 낸다
    if (typeof record.f === 'string') {
      const key = `${sheet}!${addr}`;
      if (this.evaluating.has(key)) throw new Error(`수식이 순환한다: ${key}`);
      this.evaluating.add(key);
      try {
        return this.evaluate(sheet, record.f);
      } finally {
        this.evaluating.delete(key);
      }
    }
    return typeof record.v === 'number' ? record.v : null;
  }

  /** 계산 결과를 숫자로. 빈 칸·문자는 0이다 (엑셀의 산술 문맥과 같다) */
  value(sheet: string, addr: string): number {
    return this.cell(sheet, addr) ?? 0;
  }

  evaluate(sheet: string, formula: string): number {
    const tokens = tokenize(formula);
    const parser = new Parser(this, sheet, tokens);
    const value = parser.parseExpression();
    parser.expectEnd(formula);
    return value;
  }

  /** `J65:J87` → 그 범위 안 셀들의 합. 문자·빈 칸은 건너뛴다 (SUM의 규칙) */
  sumRange(sheet: string, from: string, to: string): number {
    const start = XLSX.utils.decode_cell(from.replace(/\$/g, ''));
    const end = XLSX.utils.decode_cell(to.replace(/\$/g, ''));
    let sum = 0;
    for (let r = Math.min(start.r, end.r); r <= Math.max(start.r, end.r); r += 1) {
      for (let c = Math.min(start.c, end.c); c <= Math.max(start.c, end.c); c += 1) {
        sum += this.cell(sheet, XLSX.utils.encode_cell({ r, c })) ?? 0;
      }
    }
    return sum;
  }
}

/** 시트 이름이 붙은 참조(`산출근거!G13`)를 시트와 주소로 가른다 */
function splitRef(ref: string, current: string): { sheet: string; addr: string } {
  const bang = ref.lastIndexOf('!');
  if (bang === -1) return { sheet: current, addr: ref.replace(/\$/g, '') };
  const name = ref.slice(0, bang).replace(/^'|'$/g, '');
  return { sheet: name, addr: ref.slice(bang + 1).replace(/\$/g, '') };
}

class Parser {
  private index = 0;

  constructor(
    private readonly recalc: Recalc,
    private readonly sheet: string,
    private readonly tokens: readonly Token[]
  ) {}

  expectEnd(formula: string): void {
    if (this.index !== this.tokens.length) {
      throw new Error(`수식을 끝까지 읽지 못했다: '${formula}'`);
    }
  }

  parseExpression(): number {
    let value = this.parseTerm();
    for (;;) {
      const token = this.peek();
      if (token?.kind !== 'op' || (token.text !== '+' && token.text !== '-')) return value;
      this.index += 1;
      const right = this.parseTerm();
      value = token.text === '+' ? value + right : value - right;
    }
  }

  private parseTerm(): number {
    let value = this.parseUnary();
    for (;;) {
      const token = this.peek();
      if (token?.kind !== 'op' || (token.text !== '*' && token.text !== '/')) return value;
      this.index += 1;
      const right = this.parseUnary();
      if (token.text === '/' && right === 0) {
        // 엑셀이라면 #DIV/0!이다. 0으로 조용히 두면 비율 검산이 무의미해진다
        throw new Error(`0으로 나눈다 (${this.sheet})`);
      }
      value = token.text === '*' ? value * right : value / right;
    }
  }

  private parseUnary(): number {
    const token = this.peek();
    if (token?.kind === 'op' && (token.text === '+' || token.text === '-')) {
      this.index += 1;
      const value = this.parseUnary();
      return token.text === '-' ? -value : value;
    }
    return this.parsePrimary();
  }

  private parsePrimary(): number {
    const token = this.next();
    if (token.kind === 'number') return Number(token.text);
    if (token.kind === 'op' && token.text === '(') {
      const value = this.parseExpression();
      this.expect(')');
      return value;
    }
    if (token.kind === 'ref') {
      const next = this.peek();
      if (next?.kind === 'op' && next.text === ':') {
        throw new Error(`범위는 SUM 안에서만 쓸 수 있다: ${token.text}`);
      }
      const { sheet, addr } = splitRef(token.text, this.sheet);
      return this.recalc.value(sheet, addr);
    }
    if (token.kind === 'func') return this.parseFunction(token.text);
    throw new Error(`예상치 못한 토큰: '${token.text}'`);
  }

  private parseFunction(name: string): number {
    if (!KNOWN_FUNCTIONS.has(name)) {
      // 조용히 건너뛰면 검산이 사라진다 — 템플릿에 새 함수가 들어온 사실을 여기서 드러낸다
      throw new Error(`모르는 함수다: ${name}. 계산기를 넓히거나 템플릿을 확인해야 한다`);
    }
    const args: number[] = [];
    if (this.peekIsClose()) {
      this.expect(')');
    } else {
      for (;;) {
        args.push(name === 'SUM' ? this.parseSumArgument() : this.parseExpression());
        const token = this.next();
        if (token.kind === 'op' && token.text === ',') continue;
        if (token.kind === 'op' && token.text === ')') break;
        throw new Error(`인자 구분이 잘못됐다: '${token.text}'`);
      }
    }
    if (name === 'SUM') return args.reduce((sum, value) => sum + value, 0);
    const digits = args[1] ?? 0;
    const scale = 10 ** digits;
    const value = (args[0] ?? 0) * scale;
    const rounded =
      name === 'TRUNC' ? Math.trunc(value) : Math.sign(value) * Math.round(Math.abs(value));
    return rounded / scale;
  }

  /** SUM의 인자는 범위일 수 있다 (`J65:J87`) */
  private parseSumArgument(): number {
    const token = this.peek();
    const after = this.tokens[this.index + 1];
    if (token?.kind === 'ref' && after?.kind === 'op' && after.text === ':') {
      const end = this.tokens[this.index + 2];
      if (end?.kind !== 'ref') throw new Error(`범위의 끝이 참조가 아니다: '${token.text}:'`);
      this.index += 3;
      const from = splitRef(token.text, this.sheet);
      const to = splitRef(end.text, this.sheet);
      if (from.sheet !== to.sheet) throw new Error(`범위가 두 시트에 걸쳐 있다: ${token.text}`);
      return this.recalc.sumRange(from.sheet, from.addr, to.addr);
    }
    return this.parseExpression();
  }

  private peek(): Token | undefined {
    return this.tokens[this.index];
  }

  private peekIsClose(): boolean {
    const token = this.peek();
    return token?.kind === 'op' && token.text === ')';
  }

  private next(): Token {
    const token = this.tokens[this.index];
    if (!token) throw new Error('수식이 도중에 끝났다');
    this.index += 1;
    return token;
  }

  private expect(text: string): void {
    const token = this.next();
    if (token.kind !== 'op' || token.text !== text) {
      throw new Error(`'${text}'가 와야 하는데 '${token.text}'가 왔다`);
    }
  }
}

const recalc = new Recalc(reread);

/** 살려 둔 수식 전부 (주소 → 수식) */
function formulasOf(sheetName: string): Map<string, string> {
  const sheet = reread.Sheets[sheetName];
  if (!sheet) throw new Error(`시트가 없다: ${sheetName}`);
  const found = new Map<string, string>();
  for (const addr of Object.keys(sheet)) {
    if (addr.startsWith('!')) continue;
    const cell = sheet[addr] as CellRecord;
    if (typeof cell.f === 'string') found.set(addr, cell.f);
  }
  return found;
}

describe('(b) 소계 검산 — 살려 둔 SUM을 파싱해 우리가 합산한다 (X-4a)', () => {
  it('남은 수식을 하나도 빠짐없이 읽는다 — 모르는 문법이면 여기서 터진다', () => {
    let count = 0;
    for (const sheetName of [DETAIL, SUMMARY]) {
      for (const [addr, formula] of formulasOf(sheetName)) {
        expect(() => recalc.evaluate(sheetName, formula), `${sheetName}!${addr}={${formula}}`).not.toThrow();
        count += 1;
      }
    }
    // 소계가 통째로 사라진 파일을 "위반 0건"으로 통과시키지 않는다
    expect(count).toBeGreaterThan(100);
  });

  // 부록 B.8.3 — 파일 값과 우리 합계가 일치해야 하는 소계 셀. 실측 산자부 시트와 **같은 좌표**다
  const B8_3: Readonly<Record<string, number>> = {
    J88: 146_840_000, // 기존인력 합계 (현금)
    K88: 88_650_000, //  기존인력 합계 (현물)
    J91: 34_000_000, //  신규채용 합계
    J92: 180_840_000, // 인건비 소계 (현금)
    K92: 88_650_000, //  인건비 소계 (현물)
    L92: 269_490_000, // 인건비 소계 (계)
    K181: 3_000_000, //  회의비 소계
    K188: 1_200_000, //  출장비 소계
    K201: 19_440_000, // SW 소계
    K243: 3_380_000, //  그 밖의 비용 소계
    L150: 27_020_000, // 연구활동비 합계
    K279: 2_000_000, //  간접비 나. 소계
  };

  it.each(Object.entries(B8_3))('%s = %i (부록 B.8.3)', (addr, expected) => {
    expect(recalc.value(DETAIL, addr)).toBe(expected);
  });

  // B.8.3 표에 없는 칸이지만 부록 B.7이 값을 정해 둔 소계. 0으로 두면 검산이 헐거워진다
  const DERIVED: Readonly<Record<string, number>> = {
    L88: 235_490_000, // 기존인력 계 = 현금 146,840,000 + 현물 88,650,000 (B.7.1)
    L91: 34_000_000, //  신규채용 계 (B.7.1)
    L263: 2_000_000, //  간접비 합계 (B.7.3)
  };

  it('블록 소계·비목 합계 **전건**을 대조한다 — 나머지 칸은 0이어야 한다', () => {
    const actual: Record<string, number> = {};
    const expected: Record<string, number> = {};
    const check = (addr: string | null): void => {
      if (addr === null) return;
      actual[addr] = recalc.value(DETAIL, addr);
      expected[addr] = B8_3[addr] ?? DERIVED[addr] ?? 0;
    };
    for (const block of layout.detail.blocks) {
      for (const subtotal of block.subtotals) {
        check(subtotal.cash);
        check(subtotal.inKind);
        check(subtotal.total);
      }
    }
    for (const total of layout.detail.categoryTotals) check(total.valueAddr);
    expect(actual).toEqual(expected);
  });

  it('엑셀이 낼 소계가 **앱의 소계**와 같다 (aggregateDetails, PL-6·PL-7)', () => {
    const cells = aggregateDetails(plan.details, plan.members).cells;
    const cellOf = (category: string) => cells.find((cell) => cell.category === category);

    // 인건비 셀 합계 = 소 계 줄 (J92/K92/L92)
    expect(recalc.value(DETAIL, 'J92')).toBe(cellOf('personnel')?.cashAmount);
    expect(recalc.value(DETAIL, 'K92')).toBe(cellOf('personnel')?.inKindAmount);
    expect(recalc.value(DETAIL, 'L92')).toBe(cellOf('personnel')?.plannedAmount);
    // 비목 합계 줄 (D-23)
    expect(recalc.value(DETAIL, 'L150')).toBe(cellOf('activity')?.plannedAmount);
    expect(recalc.value(DETAIL, 'L263')).toBe(cellOf('indirect')?.plannedAmount);
    // 세목 소계 = 그 세목의 행 합계 (PL-6)
    const activity = cellOf('activity');
    const subtotalOf = (subcategory: string): number | undefined =>
      activity?.subcategories.find((sub) => sub.subcategory === subcategory)?.plannedAmount;
    expect(recalc.value(DETAIL, 'K181')).toBe(subtotalOf('activity_meeting'));
    expect(recalc.value(DETAIL, 'K201')).toBe(subtotalOf('activity_software'));
    expect(recalc.value(DETAIL, 'K188')).toBe(subtotalOf('activity_travel_dom'));
    expect(recalc.value(DETAIL, 'K243')).toBe(subtotalOf('activity_etc'));
  });

  // 산출근거 시트 위쪽(1~59행)의 요약 블록은 값을 쓰지 않고 수식 그대로 둔 자리다.
  // 여기가 §11의 "템플릿의 수식이 재계산한 값이 앱의 값과 일치한다"가 실제로 걸리는 지점이다
  it('부록 B.7.3이 템플릿 수식으로 그대로 재현된다 — 총액 298,510,000 포함', () => {
    expect(recalc.value(DETAIL, 'G13')).toBe(180_840_000); // 내부인건비 현금
    expect(recalc.value(DETAIL, 'G14')).toBe(88_650_000); //  내부인건비 현물
    expect(recalc.value(DETAIL, 'G21')).toBe(269_490_000); // 총 인건비 E
    expect(recalc.value(DETAIL, 'G22')).toBe(269_490_000); // 수정인건비 E1
    expect(recalc.value(DETAIL, 'G28')).toBe(27_020_000); //  연구활동비
    expect(recalc.value(DETAIL, 'G36')).toBe(2_000_000); //   간접비
    expect(recalc.value(DETAIL, 'G35')).toBe(296_510_000); // 직접비 계
    expect(recalc.value(DETAIL, 'G39')).toBe(298_510_000); // 연구개발비 총액
    expect(recalc.value(DETAIL, 'G32')).toBe(0); //           연구수당 비율
    expect(Number((recalc.value(DETAIL, 'G37') * 100).toFixed(4))).toBe(0.9622); // 간접비 비율
  });

  it('총괄표에 앱이 쓴 값이 산출근거의 재계산 값과 한 칸도 어긋나지 않는다 (X-10a·X-10c)', () => {
    // 대응은 **템플릿 원본의 수식**에서 읽는다 (`총괄표!F4 = 산출근거!G13`) — 맵에 다시 적으면 어긋난다
    const yearColumn = layout.summary.yearColumns.find((column) => column.yearIndex === 1);
    if (!yearColumn) throw new Error('맵에 1차년도 열이 없다');

    const compared: string[] = [];
    for (const row of layout.summary.rows) {
      const addr = encodeAddr(yearColumn.column, row.row);
      const templateFormula = (pristine.Sheets[SUMMARY]?.[addr] as CellRecord | undefined)?.f;
      if (typeof templateFormula !== 'string') continue;
      const match = new RegExp(String.raw`^'?${DETAIL}'?!(\$?[A-Z]{1,3}\$?\d+)$`).exec(templateFormula);
      if (!match) continue;

      const written = writes.find((write) => write.sheet === SUMMARY && write.addr === addr);
      expect(written, `${addr}에 쓰기가 없다`).toBeDefined();
      const counterpart = recalc.value(DETAIL, match[1]!.replace(/\$/g, ''));

      if (written!.value === null) {
        // 비운 줄(X-10b 모순 · X-10d 메모 · 축 모호)은 값이 나가지 않는다. 대신 산출근거 쪽도
        // 0이어야 한다 — 0이 아니라면 **금액이 있는데 빈 칸으로 나간 것**이고 그건 조용한 누락이다
        expect(counterpart, `${addr}(${row.label})을 비웠는데 산출근거에는 금액이 있다`).toBe(0);
        continue;
      }
      const value = written!.value as number;
      if (row.kind === 'ratio') {
        // 비율은 부동소수점이라 마지막 자리가 갈릴 수 있다 (앱은 ×100 후 ÷100을 거친다)
        expect(value, `${addr}(${row.label})`).toBeCloseTo(counterpart, 12);
      } else {
        expect(value, `${addr}(${row.label})`).toBe(counterpart);
      }
      compared.push(addr);
    }
    // 대응을 하나도 못 찾았는데 통과하는 일이 없게 한다
    expect(compared.length).toBeGreaterThanOrEqual(10);
  });

  it('총괄표 합계 열은 금액 행에만 살아 있고 그 값이 연차 값과 같다 (X-4a·X-10e)', () => {
    const internalCash = layout.summary.rows.find(
      (row) => row.subcategory === 'personnel_internal' && row.axis === 'cash'
    );
    if (!internalCash) throw new Error('맵에 내부인건비(현금) 행이 없다');
    const totalAddr = encodeAddr(layout.summary.totalColumn, internalCash.row);
    // 1차년도 하나뿐이므로 `SUM(F:I)`는 그 연차 값과 같다
    expect(recalc.value(SUMMARY, totalAddr)).toBe(180_840_000);

    // X-10e: 비율 행의 합계 열은 비운다 — 연차별 비율의 합은 의미가 없다
    for (const row of layout.summary.rows.filter((r) => r.kind === 'ratio')) {
      const addr = encodeAddr(layout.summary.totalColumn, row.row);
      const cell = reread.Sheets[SUMMARY]?.[addr] as CellRecord | undefined;
      expect(cell?.f, `${addr}에 수식이 남아 있다`).toBeUndefined();
      expect(cell?.v).toBeUndefined();
    }
  });
});

// ═══ (c) 캐시 오염 ═══════════════════════════════════════════════════════════

describe('(c) 캐시 오염 — 엑셀이 열 때 다시 계산해야 한다', () => {
  it('살아남은 수식 셀에 캐시된 계산값이 없다 (X-4a)', () => {
    const polluted: string[] = [];
    for (const sheetName of reread.SheetNames) {
      const sheet = reread.Sheets[sheetName];
      if (!sheet) continue;
      for (const addr of Object.keys(sheet)) {
        if (addr.startsWith('!')) continue;
        const cell = sheet[addr] as CellRecord;
        if (typeof cell.f === 'string' && cell.v !== undefined) {
          polluted.push(`${sheetName}!${addr} → ${String(cell.v)}`);
        }
      }
    }
    expect(polluted).toEqual([]);
  });

  it('clearFormula 대상 셀에 수식이 남아 있지 않다 (X-4·X-10a)', () => {
    const leftovers = writes
      .filter((write) => write.clearFormula === true)
      .filter((write) => typeof (reread.Sheets[write.sheet]?.[write.addr] as CellRecord | undefined)?.f === 'string')
      .map((write) => `${write.sheet}!${write.addr}`);
    expect(leftovers).toEqual([]);
    // 검사가 실제로 돌았는지 — 대상이 0건이면 위 단언은 아무것도 지키지 않는다
    expect(writes.filter((write) => write.clearFormula === true).length).toBeGreaterThan(0);
  });

  it('값을 쓴 셀에 낡은 표시 문자열(w)이 없고 값이 그대로다', () => {
    const valued = writes.filter((write) => write.value !== null);
    expect(valued.length).toBeGreaterThan(0);

    // 낡은 `w`는 **직렬화 전** 워크북에서 본다. 다시 읽은 파일의 `w`는 SheetJS가 값과 서식으로
    // 새로 만든 것이라 거기서는 옛 문자열인지 알 수 없다
    const stale: string[] = [];
    for (const write of valued) {
      const cell = applied.Sheets[write.sheet]?.[write.addr] as (CellRecord & { w?: string }) | undefined;
      if (cell?.w !== undefined) stale.push(`${write.sheet}!${write.addr} → ${cell.w}`);
    }
    expect(stale).toEqual([]);

    const wrong: string[] = [];
    for (const write of valued) {
      const cell = reread.Sheets[write.sheet]?.[write.addr] as CellRecord | undefined;
      if (cell === undefined) {
        wrong.push(`${write.sheet}!${write.addr} 셀이 사라졌다`);
        continue;
      }
      if (cell.v !== write.value) {
        wrong.push(`${write.sheet}!${write.addr} = ${String(cell.v)} (쓴 값 ${String(write.value)})`);
      }
    }
    expect(wrong).toEqual([]);
  });

  it('비운 셀은 값도 수식도 없고 서식만 남는다 (X-8)', () => {
    const emptied = writes.filter((write) => write.value === null);
    expect(emptied.length).toBeGreaterThan(0);
    const broken: string[] = [];
    for (const write of emptied) {
      const cell = reread.Sheets[write.sheet]?.[write.addr] as
        | (CellRecord & { s?: unknown; z?: unknown })
        | undefined;
      if (cell === undefined) continue; // 애초에 레코드가 없던 칸은 지울 것이 없다
      if (cell.v !== undefined || typeof cell.f === 'string') {
        broken.push(`${write.sheet}!${write.addr}`);
      }
    }
    expect(broken).toEqual([]);
  });
});
