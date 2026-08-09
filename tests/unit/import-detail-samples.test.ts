// 실측 산출근거 시트 회귀 테스트 (SOT 부록 B.8) — Phase 10의 마지막 관문.
//
// tests/unit/import-detail-sheet.test.ts는 손으로 만든 픽스처로 규칙을 고정한다. 여기는
// **실제 워크북**으로 부록 B.8의 행 수·금액·소계·조정액을 고정한다 — 합성 픽스처만 통과하고
// 실물에서 깨지는 파서를 여기서 잡는다.
//
// samples/는 .gitignore 대상(실제 예산 자료)이라 저장소에 없다. 파일이 없으면 **조용히
// 통과시키지 않고** 무엇이 없어 건너뛰는지 알린 뒤 skip 한다 (import-samples.test.ts와 같은 방식).
//
// 어댑터(SheetJS → RawSheet)는 여기서 최소 구현으로 다시 만든다. lib/import-adapter.ts는
// `import 'server-only'`라 단위 테스트에서 부를 수 없고, 검증 대상은 lib/import/의 파싱 규칙이다.

import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import * as XLSX from 'xlsx';
import {
  compareSubtotals,
  detectBlocks,
  detectSections,
  parseDetailRows,
} from '@/lib/import/detail-sheet';
import type {
  DetailBlock,
  DetailColumnRole,
  DetailDraftRow,
  DetailSection,
  FileSubtotal,
} from '@/lib/import/detail-sheet';
import type { MergeRange, RawCell, RawSheet } from '@/lib/import';

const SAMPLES_DIR = path.resolve(__dirname, '../../samples');

/** D-19: 시트 하나 = 연차 하나. 부록 B.8의 출처 시트 */
const SANJA_SHEET = '1차년도_250520';
const HAENGAN_SHEET = '1단계_2차년도_250604';

function toRawSheet(file: string, sheetName: string): RawSheet {
  // D-22: cellNF가 없으면 cell.z(서식 문자열)가 만들어지지 않아 백분율 판정이 영영 false가 되고
  // 참여율이 0.1 그대로 들어가 금액이 1/100이 된다. 운영 어댑터(lib/import-adapter.ts)와 같은 설정이어야
  // 이 테스트가 실물 임포트 경로를 대변한다.
  const wb = XLSX.read(fs.readFileSync(file), {
    cellFormula: false,
    cellDates: false,
    cellNF: true,
  });
  const ws = wb.Sheets[sheetName];
  if (!ws || !ws['!ref']) throw new Error(`시트 없음: ${sheetName}`);
  const range = XLSX.utils.decode_range(ws['!ref']);
  const cells: RawCell[][] = [];
  for (let r = 0; r <= range.e.r; r += 1) {
    const row: RawCell[] = [];
    for (let c = 0; c <= range.e.c; c += 1) {
      const cell = ws[XLSX.utils.encode_cell({ r, c })];
      // 구멍 없는 2차원 배열이어야 한다 — 빈 셀도 채운다 (RawSheet 계약)
      if (!cell) row.push({ value: null, isError: false });
      else if (cell.t === 'e') {
        row.push({ value: null, isError: true, errorText: String(cell.w ?? cell.v) });
      } else {
        row.push({
          value: cell.v as string | number | boolean | null,
          isError: false,
          // D-22: 값은 원본 그대로 두고 서식 사실만 넘긴다. 파서가 100을 곱해 되돌린다
          percentFormat: typeof cell.z === 'string' && /(^|[^\\])%/.test(cell.z),
        });
      }
    }
    cells.push(row);
  }
  const merges: MergeRange[] = (ws['!merges'] ?? []).map((m) => ({
    s: { r: m.s.r, c: m.s.c },
    e: { r: m.e.r, c: m.e.c },
  }));
  return { name: sheetName, cells, merges };
}

interface ParsedBlock {
  block: DetailBlock;
  rows: DetailDraftRow[];
  subtotals: FileSubtotal[];
  currencySymbol: string | null;
}

interface ParsedSheet {
  sheet: RawSheet;
  sections: DetailSection[];
  parsed: ParsedBlock[];
  rows: DetailDraftRow[];
  subtotals: FileSubtotal[];
}

function parseSheet(file: string, sheetName: string): ParsedSheet {
  const sheet = toRawSheet(file, sheetName);
  const sections = detectSections(sheet);
  const parsed = detectBlocks(sheet, sections).map((block) => {
    const result = parseDetailRows(sheet, block);
    return {
      block,
      rows: result.rows,
      subtotals: result.subtotals,
      currencySymbol: result.currency?.symbol ?? null,
    };
  });
  return {
    sheet,
    sections,
    parsed,
    rows: parsed.flatMap((p) => p.rows),
    subtotals: parsed.flatMap((p) => p.subtotals),
  };
}

/** 부록 B.8이 셀 주소(`J88`·`L150`)로 말하므로 같은 표기로 찾는다 */
function subtotalAt(sheet: ParsedSheet, address: string): FileSubtotal | undefined {
  return sheet.subtotals.find((s) => `${s.column}${s.row + 1}` === address);
}

function blocksOfSubcategory(sheet: ParsedSheet, subcategory: string): ParsedBlock[] {
  return sheet.parsed.filter((p) => p.block.subcategory === subcategory);
}

/** 인건비 데이터 표 — 축(현금/현물) 열이 있는 표가 데이터 표다 (앞의 2행 헤더 표는 빈 표다) */
function personnelDataBlock(sheet: ParsedSheet): ParsedBlock {
  const found = sheet.parsed.find(
    (p) => p.block.category === 'personnel' && p.block.roles.cashTotal !== undefined
  );
  if (!found) throw new Error('인건비 데이터 표를 찾지 못했다');
  return found;
}

function included(rows: readonly DetailDraftRow[]): DetailDraftRow[] {
  return rows.filter((r) => r.status === 'included');
}

function sum(rows: readonly DetailDraftRow[]): number {
  return rows.reduce((acc, r) => acc + r.fileAmount, 0);
}

const available = fs.existsSync(SAMPLES_DIR)
  ? fs.readdirSync(SAMPLES_DIR).filter((f) => f.endsWith('.xlsx'))
  : [];
const sanjaFile = available.find((f) => f.startsWith('산자부'));
const haenganFile = available.find((f) => f.startsWith('행안부'));

// 안내는 **항상 실행되는 테스트 안에서** 낸다. vitest 기본 리포터는 통과한 테스트의 console 출력을
// 감추므로 process.stderr에 직접 쓴다 (import-samples.test.ts와 같은 이유).
describe('실측 산출근거 샘플 준비 상태', () => {
  it(`samples/ 확인 — 산자부 ${sanjaFile ? '있음' : '없음'} / 행안부 ${haenganFile ? '있음' : '없음'}`, () => {
    const missing = [
      sanjaFile === undefined ? `산자부_…_v1.2_kdh_250520.xlsx (시트 ${SANJA_SHEET})` : null,
      haenganFile === undefined ? `행안부_…_kdh_241204.xlsx (시트 ${HAENGAN_SHEET})` : null,
    ].filter((m): m is string => m !== null);

    if (missing.length === 0) {
      expect(missing).toEqual([]);
      return;
    }
    process.stderr.write(
      `\n[import-detail-samples] 실측 산출근거 검증(부록 B.8)을 건너뜁니다 — 다음 파일이 없습니다:\n` +
        missing.map((m) => `  - ${m}\n`).join('') +
        `  samples/는 실제 예산 자료라 .gitignore 대상입니다 — 회사 PC에서 복사해 오면 살아납니다.\n` +
        `  기대 경로: ${SAMPLES_DIR}\n\n`
    );
    // 실패시키지 않는다: 샘플이 없는 것은 다른 PC에서 정상 상태다.
    // 다만 무엇이 생략됐는지는 위 안내로 반드시 화면에 남는다 (절대 규칙 5).
    expect(missing.length).toBeGreaterThan(0);
  });
});

// ─── 산자부 1차년도_250520 (부록 B.8 전체) ────────────────────

describe.skipIf(sanjaFile === undefined)(`산자부 ${SANJA_SHEET} (부록 B.8)`, () => {
  const load = (): ParsedSheet => parseSheet(path.join(SAMPLES_DIR, sanjaFile!), SANJA_SHEET);

  // ─ B.8.1 블록 감지 (D-1~D-5) ─

  it('B.8.1 섹션 — `1. 직접비 소요명세`(60행) · `2. 간접비 소요명세`(263행) 2개', () => {
    const sheet = load();
    expect(sheet.sections.map((s) => `${s.kind}@${s.headerRow + 1}행`)).toEqual([
      'direct@60행',
      'indirect@263행',
    ]);
  });

  it('B.8.1 비목 블록 6종 — 인건비·시설장비비·재료비·활동비·연구수당·국제공동', () => {
    const sheet = load();
    const seen = new Map<number, string>();
    for (const { block } of sheet.parsed) {
      if (block.section !== 'direct') continue;
      seen.set(block.categoryRow, `${block.category}:${block.categoryLabel}`);
    }
    expect([...seen.entries()].sort((a, b) => a[0] - b[0]).map(([row, v]) => `${row + 1}행 ${v}`)).toEqual([
      '61행 personnel:- 인건비',
      '96행 facility_equipment:다. 연구시설·장비비',
      '126행 material:라. 연구재료비',
      '149행 activity:마. 연구활동비',
      '247행 allowance:자. 연구수당',
      '254행 international:바. 국제공동연구개발비',
    ]);
  });

  it('B.8.1 간접비 세목 3종 — 비목이 아니라 indirect의 세목이다 (D-2)', () => {
    const sheet = load();
    const indirect = sheet.parsed.filter((p) => p.block.section === 'indirect');
    expect(indirect.map((p) => `${p.block.category}/${p.block.subcategory}`)).toEqual([
      'indirect/indirect_hr',
      'indirect/indirect_support',
      'indirect/indirect_outcome',
    ]);
  });

  it('B.8.1 세목 — 시설·장비비 ①~④ · 재료비 ①~③ · 활동비 ①~⑪ (D-3)', () => {
    const sheet = load();
    const codesOf = (category: string): string[] => [
      ...new Set(
        sheet.parsed
          .filter((p) => p.block.category === category && p.block.subcategory !== null)
          .map((p) => p.block.subcategory!)
      ),
    ];

    expect(codesOf('facility_equipment')).toEqual([
      'facility_purchase',
      'facility_lease',
      'facility_maintain',
      'facility_infra',
    ]);
    expect(codesOf('material')).toEqual([
      'material_purchase',
      'material_manage',
      'material_make',
    ]);
    // ⑤가 국내·국외 두 표로 갈린다 (C.2 주의 2) — ①~⑪이 12개 세목을 덮는다
    expect(codesOf('activity')).toEqual([
      'activity_outsourcing',
      'activity_ip',
      'activity_expert',
      'activity_meeting',
      'activity_travel_dom',
      'activity_travel_intl',
      'activity_software',
      'activity_lab_ops',
      'activity_hr_support',
      'activity_pmo',
      'activity_cloud',
      'activity_etc',
    ]);
  });

  it('B.8.1 인건비 소계 3단 — 합계(88) → 합계(91) → 소 계(92). 첫 소계에서 멈추면 34,000,000을 놓친다 (D-5)', () => {
    const sheet = load();
    const personnel = personnelDataBlock(sheet);
    const stages = [...new Set(personnel.subtotals.map((s) => `${s.row + 1}행 ${s.label}`))];
    expect(stages).toEqual(['88행 합계', '91행 합계', '92행 소 계']);
  });

  // ─ B.8.2 행 파싱 결과 ─

  it('B.8.2 인건비 — 기존인력 18행(현금 146,840,000 / 현물 88,650,000) · 신규채용 1행(34,000,000)', () => {
    const sheet = load();
    const rows = included(personnelDataBlock(sheet).rows);

    // 소계 행(88행)이 기존인력과 신규채용을 가른다
    const existing = rows.filter((r) => r.row + 1 < 88);
    const hired = rows.filter((r) => r.row + 1 > 88);

    expect(existing).toHaveLength(18);
    expect(sum(existing.filter((r) => r.axis === 'cash'))).toBe(146_840_000);
    expect(sum(existing.filter((r) => r.axis === 'in_kind'))).toBe(88_650_000);

    expect(hired).toHaveLength(1);
    expect(sum(hired)).toBe(34_000_000);
  });

  it('B.8.2 ④ 회의비 — 1행 3,000,000 (단가 500,000 × 회 6)', () => {
    const sheet = load();
    const rows = included(blocksOfSubcategory(sheet, 'activity_meeting').flatMap((p) => p.rows));
    expect(rows).toHaveLength(1);
    expect(sum(rows)).toBe(3_000_000);
    expect(rows[0]!.unitPrice).toBe(500_000);
    expect(rows[0]!.factors.map((f) => f.value)).toEqual([6]);
  });

  it('B.8.2 ⑤ 국내출장비 — 1행 1,200,000 (산출비용 150,000 × 인원 2 × 횟수 4)', () => {
    const sheet = load();
    const rows = included(blocksOfSubcategory(sheet, 'activity_travel_dom').flatMap((p) => p.rows));
    expect(rows).toHaveLength(1);
    expect(sum(rows)).toBe(1_200_000);
    expect(rows[0]!.unitPrice).toBe(150_000);
    expect(rows[0]!.factors.map((f) => f.value)).toEqual([2, 4]);
  });

  it('B.8.2 ⑥ 소프트웨어 활용비 — 1행 19,440,000 (단가 540,000 × 시트(수량) 4 × 월 9)', () => {
    const sheet = load();
    const rows = included(blocksOfSubcategory(sheet, 'activity_software').flatMap((p) => p.rows));
    expect(rows).toHaveLength(1);
    expect(sum(rows)).toBe(19_440_000);
    expect(rows[0]!.unitPrice).toBe(540_000);
    // PL-3: 인자 라벨은 헤더 텍스트 그대로다 — 프리셋의 `수량`이 아니라 `시트(수량)`
    expect(rows[0]!.factors.map((f) => `${f.label}=${f.value}`)).toEqual([
      '산출내역 시트(수량)=4',
      '산출내역 월=9',
    ]);
  });

  it('B.8.2 ⑪ 그 밖의 비용 — 2행 3,380,000 (+ 0원 4행은 D-21 ②로 건너뜀 제안)', () => {
    const sheet = load();
    const all = blocksOfSubcategory(sheet, 'activity_etc').flatMap((p) => p.rows);
    expect(included(all)).toHaveLength(2);
    expect(sum(included(all))).toBe(3_380_000);
    expect(included(all).map((r) => r.fileAmount)).toEqual([900_000, 2_480_000]);
    expect(all.filter((r) => r.status === 'skip-suggested')).toHaveLength(4);
  });

  it('B.8.2 간접비 나. 연구지원비 — 1행 2,000,000 (+ 0원 5행)', () => {
    const sheet = load();
    const all = blocksOfSubcategory(sheet, 'indirect_support').flatMap((p) => p.rows);
    expect(included(all)).toHaveLength(1);
    expect(sum(included(all))).toBe(2_000_000);
    expect(all.filter((r) => r.status === 'skip-suggested')).toHaveLength(5);
    // 단가·인자는 여기서 단언하지 않는다: 이 세목의 컬럼 헤더에는 `단가`·`회`가 없고
    // 산출내역(E~H 병합)에 2,000,000이, 헤더 없는 I열에 1이 들어 있다. B.8.2가 고정하는 것도
    // **읽는 행 수와 금액**이다 — 시트에 없는 헤더를 파서가 지어내면 그것이 오히려 틀린 것이다.
  });

  // ─ B.8.3 소계 대조 (D-18) ─

  it('B.8.3 파일 소계 9행의 값을 그대로 읽는다', () => {
    const sheet = load();
    const valueAt = (address: string): number | string =>
      subtotalAt(sheet, address)?.value ?? `${address} 없음`;

    expect({
      J88: valueAt('J88'),
      K88: valueAt('K88'),
      J91: valueAt('J91'),
      J92: valueAt('J92'),
      K92: valueAt('K92'),
      L92: valueAt('L92'),
      K181: valueAt('K181'),
      K188: valueAt('K188'),
      K201: valueAt('K201'),
      K243: valueAt('K243'),
      L150: valueAt('L150'),
      K279: valueAt('K279'),
    }).toEqual({
      J88: 146_840_000,
      K88: 88_650_000,
      J91: 34_000_000,
      J92: 180_840_000,
      K92: 88_650_000,
      L92: 269_490_000,
      K181: 3_000_000,
      K188: 1_200_000,
      K201: 19_440_000,
      K243: 3_380_000,
      L150: 27_020_000,
      K279: 2_000_000,
    });
  });

  it('B.8.3 인건비 3단 소계가 우리 합과 일치한다 (D-18)', () => {
    const sheet = load();
    const personnel = personnelDataBlock(sheet);
    const comparisons = compareSubtotals(personnel.rows, personnel.subtotals);
    const mismatched = comparisons
      .filter((c) => ['J88', 'K88', 'J91', 'J92', 'K92', 'L92'].includes(`${c.column}${c.row + 1}`))
      .filter((c) => !c.matches)
      .map((c) => `${c.column}${c.row + 1} 파일 ${c.fileValue} ≠ 우리 ${c.ourSum}`);
    expect(mismatched).toEqual([]);
  });

  it('B.8.3 세목 소계가 우리 합과 일치한다 (D-18)', () => {
    const sheet = load();
    const targets = ['K181', 'K188', 'K201', 'K243', 'K279'];
    const mismatched: string[] = [];
    for (const { rows, subtotals } of sheet.parsed) {
      for (const c of compareSubtotals(rows, subtotals)) {
        const address = `${c.column}${c.row + 1}`;
        if (!targets.includes(address)) continue;
        if (!c.matches) mismatched.push(`${address} 파일 ${c.fileValue} ≠ 우리 ${c.ourSum}`);
      }
    }
    expect(mismatched).toEqual([]);
  });

  it('B.8.3 연구활동비 합계(L150) 27,020,000이 그 비목의 행 합과 일치한다 (D-18)', () => {
    const sheet = load();
    const subtotal = subtotalAt(sheet, 'L150');
    expect(subtotal?.value).toBe(27_020_000);

    // 여러 블록에 걸친 비목 합계는 그 비목의 행 전부와 함께 대조한다 (compareSubtotals 계약)
    const activityRows = sheet.parsed
      .filter((p) => p.block.category === 'activity')
      .flatMap((p) => p.rows);
    const [comparison] = compareSubtotals(activityRows, [subtotal!]);
    expect(comparison!.matches).toBe(true);
  });

  // ─ B.8.4 조정액 흡수 (D-8) ─

  it('B.8.4 인건비 19행의 연봉·산식·조정액이 부록 B.7.1 표와 같다', () => {
    const sheet = load();
    const rows = included(personnelDataBlock(sheet).rows);
    const actual = rows.map(
      (r) =>
        `${r.memberName}|${r.fileSalary}|${r.axis}|${r.formulaAmount}|${r.adjustment}|${r.fileAmount}`
    );

    // 부록 B.7.1 표를 그대로 옮긴다. `조정액 = 최종 금액 − 산식 결과`이며
    // 실측 케이스는 파일 연봉 = 명부 연봉이라 D-8a 분기가 드러나지 않는다.
    expect(actual).toEqual([
      '여욱현|180000000|cash|13500000|0|13500000',
      '김영|90000000|cash|20250000|0|20250000',
      '김지웅|90000000|in_kind|20250000|0|20250000',
      '박선욱|74000000|cash|15540000|0|15540000',
      '지동민|84000000|in_kind|40320000|-270000|40050000',
      '도상래|64000000|cash|4800000|0|4800000',
      '이경아|54000000|in_kind|28350000|0|28350000',
      '김다래|54000000|cash|10530000|-30000|10500000',
      '김도현|52000000|cash|3900000|0|3900000',
      '유태일|46200000|cash|5197500|-7500|5190000',
      '정우진|51000000|cash|15300000|0|15300000',
      '김형식|43500000|cash|13376250|-6250|13370000',
      '신나리|38000000|cash|11400000|0|11400000',
      '양소희|39000000|cash|8775000|-5000|8770000',
      '이다정|41100000|cash|6165000|-5000|6160000',
      '안승현|36000000|cash|3780000|0|3780000',
      '진호령|33000000|cash|7425000|-5000|7420000',
      '장선우|32000000|cash|6960000|0|6960000',
      '신규채용1 (청년의무)|51000000|cash|34000000|0|34000000',
    ]);
  });

  it('B.8.4 지동민 −270,000은 조정액으로 흡수했음이 드러난다 (조용히 넣지 않는다)', () => {
    const sheet = load();
    const row = included(personnelDataBlock(sheet).rows).find((r) => r.memberName === '지동민');
    expect(row?.adjustment).toBe(-270_000);
    expect(row?.absorbed).toBe(true);
    // D-8a: 파서의 인건비 조정액은 파일 연봉 기준의 **잠정값**이다
    expect(row?.adjustmentProvisional).toBe(true);
  });

  // ─ 이중 계상 방지 (D-1) ─

  it('섹션 밖 1~59행(총괄표·요약)에서 온 금액이 결과에 한 푼도 섞이지 않는다', () => {
    const sheet = load();
    const sectionStart = sheet.sections[0]!.startRow;

    const strayRows = sheet.rows
      .filter((r) => r.row < sectionStart)
      .map((r) => `${r.row + 1}행 ${r.fileAmount}원`);
    expect(strayRows).toEqual([]);

    const straySubtotals = sheet.subtotals
      .filter((s) => s.row < sectionStart)
      .map((s) => `${s.column}${s.row + 1} ${s.value}원`);
    expect(straySubtotals).toEqual([]);

    // 총합이 부록 B.6·B.7의 1차년도 총액과 같다 — 총괄표 블록이 딸려 들어오면 두 배가 된다
    expect(sum(included(sheet.rows))).toBe(298_510_000);
  });
});

// ─── 행안부 1단계_2차년도_250604 ──────────────────────────────

describe.skipIf(haenganFile === undefined || sanjaFile === undefined)(
  `행안부 ${HAENGAN_SHEET}`,
  () => {
    const load = (): ParsedSheet =>
      parseSheet(path.join(SAMPLES_DIR, haenganFile!), HAENGAN_SHEET);

    it('섹션 2개를 찾는다 (D-1)', () => {
      const sheet = load();
      expect(sheet.sections.map((s) => `${s.kind}@${s.headerRow + 1}행`)).toEqual([
        'direct@62행',
        'indirect@276행',
      ]);
    });

    it('비목 6종을 찾는다 — 실측 2종의 구조가 거의 같다 (§6.11.1)', () => {
      const sheet = load();
      const seen = new Map<number, string>();
      for (const { block } of sheet.parsed) {
        if (block.section !== 'direct') continue;
        seen.set(block.categoryRow, block.category);
      }
      expect(
        [...seen.entries()].sort((a, b) => a[0] - b[0]).map(([row, v]) => `${row + 1}행 ${v}`)
      ).toEqual([
        '63행 personnel',
        '105행 facility_equipment',
        '135행 material',
        '158행 activity',
        '260행 allowance',
        '267행 international',
      ]);
    });

    it('D-7: 인건비 컬럼 role 맵이 산자부와 같다 — 열 위치는 다르다', () => {
      const haengan = personnelDataBlock(load());
      const sanja = personnelDataBlock(parseSheet(path.join(SAMPLES_DIR, sanjaFile!), SANJA_SHEET));

      // §6.11.1의 인건비 컬럼 형태: 인력구분·성명·직위·연봉·참여율·참여기간·현금·현물·계
      const expected: DetailColumnRole[] = [
        'cashTotal',
        'hireType',
        'inKindTotal',
        'memberName',
        'period',
        'position',
        'rate',
        'salary',
        'total',
      ];
      expect(Object.keys(sanja.block.roles).sort()).toEqual(expected);
      expect(Object.keys(haengan.block.roles).sort()).toEqual(expected);

      // 위치를 고정하면 반드시 깨진다는 근거 — 같은 role이 다른 열에 있다
      expect(haengan.block.roles.memberName).not.toBe(sanja.block.roles.memberName);
    });

    it('D-10: ⑥ 소프트웨어 활용비의 `합계($)`가 통화 경고를 만든다', () => {
      const sheet = load();
      const blocks = blocksOfSubcategory(sheet, 'activity_software');
      expect(blocks.length).toBeGreaterThan(0);

      const symbols = blocks.map((p) => p.currencySymbol);
      expect(symbols).toContain('$');

      // 확인 없이는 그 세목을 반영하지 않는다 — 모든 행이 needsConfirm이다
      const rows = blocks.flatMap((p) => p.rows);
      expect(rows.length).toBeGreaterThan(0);
      expect(rows.every((r) => r.issues.includes('currency') && r.needsConfirm)).toBe(true);
    });

    it('섹션 밖 1~61행(총괄표·요약)에서 온 금액이 결과에 한 푼도 섞이지 않는다', () => {
      const sheet = load();
      const sectionStart = sheet.sections[0]!.startRow;
      expect(sheet.rows.filter((r) => r.row < sectionStart).map((r) => r.row + 1)).toEqual([]);
      expect(sheet.subtotals.filter((s) => s.row < sectionStart).map((s) => s.row + 1)).toEqual([]);
    });
  }
);
