// 입력 양식 파서 (SOT §6.16 IN-2·IN-3·IN-4·IN-6, §6.11 D-22)
//
// 거부 3종+시트 누락은 파일째 돌려보내고, 그 뒤의 문제는 행을 버리지 않고 `issues`로 남긴다.
// 읽지 않는 열(연봉·월급·금액)은 값을 넣어도 결과에 흔적이 없어야 한다 — 타입에 필드가 없고
// 코드가 그 열 인덱스를 구하지도 않는다는 것을 정적으로도 고정한다.

import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import {
  INPUT_FORM_SHEETS,
  INPUT_FORM_VERSION,
  NO_META_MESSAGE,
  PROJECT_MISMATCH_MESSAGE,
  VERSION_MISMATCH_MESSAGE,
  buildMetaRows,
  columnOf,
} from '@/lib/input-form';
import type { FormCell, InputFormMeta, InputFormSheetDef, InputFormSheetKey } from '@/lib/input-form';
import { parseInputForm, parseSubcategoryKey, subcategoryKeyOf } from '@/lib/input-form/parse';
import type { RawCell, RawSheet } from '@/lib/import/types';

// ─── 픽스처 빌더 ─────────────────────────────────────────────

type CellInput = RawCell | string | number | null | undefined;

function toCell(input: CellInput): RawCell {
  if (input === undefined || input === null) return { value: null, isError: false };
  if (typeof input === 'object') return input;
  return { value: input, isError: false };
}

/** 역할 → 값 맵으로 행을 적는다. 헤더 행·데이터 시작 행은 좌표 맵을 그대로 따른다 */
function sheetOf(key: InputFormSheetKey, rows: Record<string, CellInput>[]): RawSheet {
  const def: InputFormSheetDef = INPUT_FORM_SHEETS[key];
  const cells: RawCell[][] = [];
  for (let r = 1; r < def.headerRow; r += 1) cells.push([]);
  cells.push(def.columns.map((column) => toCell(column.label)));
  for (let r = def.headerRow + 1; r < def.dataStartRow; r += 1) cells.push([]);
  for (const row of rows) {
    const line: RawCell[] = def.columns.map(() => toCell(null));
    for (const [role, value] of Object.entries(row)) line[columnOf(def, role)] = toCell(value);
    cells.push(line);
  }
  return { name: def.name, cells, merges: [] };
}

function metaSheetOf(meta: InputFormMeta): RawSheet {
  const cells: RawCell[][] = buildMetaRows(meta).map((row: FormCell[]) =>
    row.map((cell) => ({ value: cell.value ?? null, isError: false }))
  );
  return { name: INPUT_FORM_SHEETS.meta.name, cells, merges: [] };
}

const META: InputFormMeta = {
  formVersion: INPUT_FORM_VERSION,
  projectId: 'proj-1',
  yearId: 'year-1',
  generatedAt: '2026-09-25T09:00:00.000Z',
  subcategoryCodes: ['activity:activity_meeting', 'material:material_purchase', 'allowance:default'],
  memberIds: ['m-1', 'm-2'],
};

const EXPECTED = { projectId: 'proj-1', formVersion: INPUT_FORM_VERSION };

const PERSONNEL_OK = {
  memberId: 'm-1',
  detailId: 'd-1',
  subcategory: '내부인건비',
  participation: 28,
  months: 9,
  axis: '현금',
  adjustment: 0,
  note: '',
};

const BUDGET_OK = {
  subcategory: 'activity:activity_meeting',
  detailId: 'd-9',
  name: '착수회의',
  spec: '10인',
  unitPrice: 300000,
  factor1: 2,
  adjustment: 0,
  axis: '현금',
  note: '',
};

function workbook(
  personnel: Record<string, CellInput>[] = [],
  budget: Record<string, CellInput>[] = [],
  meta: InputFormMeta = META
): RawSheet[] {
  return [sheetOf('personnel', personnel), sheetOf('budget', budget), metaSheetOf(meta)];
}

function parseOk(sheets: RawSheet[]) {
  const result = parseInputForm(sheets, EXPECTED);
  if (!result.ok) throw new Error(`거부됨: ${result.rejection.kind}`);
  return result.parsed;
}

function kinds(issues: { kind: string; blocking: boolean }[]): string[] {
  return issues.map((issue) => `${issue.kind}${issue.blocking ? '!' : ''}`);
}

// ─── 거부 (IN-2) ─────────────────────────────────────────────

describe('파일째 거부 (IN-2)', () => {
  it('_meta 시트 없음 → no-meta', () => {
    const result = parseInputForm([sheetOf('personnel', []), sheetOf('budget', [])], EXPECTED);
    expect(result).toEqual({ ok: false, rejection: { kind: 'no-meta', message: NO_META_MESSAGE } });
  });

  it('_meta는 있으나 필수 키가 비면 → no-meta', () => {
    const broken: RawSheet = { name: '_meta', cells: [[toCell('키'), toCell('값')]], merges: [] };
    const result = parseInputForm([sheetOf('personnel', []), sheetOf('budget', []), broken], EXPECTED);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.rejection.kind).toBe('no-meta');
  });

  it('과제 불일치 → project-mismatch (버전보다 먼저)', () => {
    const result = parseInputForm(workbook([], [], { ...META, projectId: 'other', formVersion: 99 }), EXPECTED);
    expect(result).toEqual({
      ok: false,
      rejection: { kind: 'project-mismatch', message: PROJECT_MISMATCH_MESSAGE },
    });
  });

  it('버전 불일치 → version-mismatch', () => {
    const result = parseInputForm(workbook([], [], { ...META, formVersion: INPUT_FORM_VERSION + 1 }), EXPECTED);
    expect(result).toEqual({
      ok: false,
      rejection: { kind: 'version-mismatch', message: VERSION_MISMATCH_MESSAGE },
    });
  });

  it.each([
    ['인건비', 'personnel'],
    ['사업비', 'budget'],
  ] as const)('%s 시트 누락 → missing-sheet', (name, key) => {
    const sheets = workbook().filter((sheet) => sheet.name !== INPUT_FORM_SHEETS[key].name);
    const result = parseInputForm(sheets, EXPECTED);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.rejection.kind).toBe('missing-sheet');
      expect(result.rejection.message).toContain(name);
    }
  });

  it('통과하면 meta를 그대로 돌려준다', () => {
    const parsed = parseOk(workbook());
    expect(parsed.meta).toEqual(META);
    expect(parsed.personnel).toEqual([]);
    expect(parsed.budget).toEqual([]);
    expect(parsed.issues).toEqual([]);
  });
});

// ─── 인건비 (IN-3) ───────────────────────────────────────────

describe('인건비 시트 (IN-3)', () => {
  it('정상 행: 숨김 키·세목 코드·값·1-based 행 번호', () => {
    const parsed = parseOk(workbook([PERSONNEL_OK]));
    expect(parsed.personnel).toEqual([
      {
        rowIndex: INPUT_FORM_SHEETS.personnel.dataStartRow,
        memberId: 'm-1',
        detailId: 'd-1',
        subcategory: 'personnel_internal',
        participation: 28,
        months: 9,
        axis: 'cash',
        adjustment: 0,
        note: '',
        issues: [],
      },
    ]);
  });

  it('인건비 2비목 프리셋 라벨 5종 → 코드', () => {
    const labels: [string, string][] = [
      ['내부인건비', 'personnel_internal'],
      ['외부인건비', 'personnel_external'],
      ['연구지원인력인건비', 'personnel_support'],
      ['일반', 'student_general'],
      ['통합관리', 'student_managed'],
    ];
    const parsed = parseOk(workbook(labels.map(([label]) => ({ ...PERSONNEL_OK, subcategory: label }))));
    expect(parsed.personnel.map((row) => row.subcategory)).toEqual(labels.map(([, code]) => code));
    expect(parsed.personnel.flatMap((row) => row.issues)).toEqual([]);
  });

  it('_meta에 없는 memberId → unknown-member(blocking) — 행은 남는다', () => {
    const parsed = parseOk(workbook([{ ...PERSONNEL_OK, memberId: 'ghost' }, { ...PERSONNEL_OK, memberId: '' }]));
    expect(parsed.personnel).toHaveLength(2);
    expect(parsed.personnel[0]?.memberId).toBe('ghost');
    expect(kinds(parsed.personnel[0]!.issues)).toEqual(['unknown-member!']);
    expect(kinds(parsed.personnel[1]!.issues)).toEqual(['unknown-member!']);
    // 값은 그대로 읽혀 있다 — 미리보기가 "알 수 없는 행"으로 보여 준다
    expect(parsed.personnel[0]?.participation).toBe(28);
  });

  it('모르는 세목 라벨 → unknown-subcategory(blocking), 빈 세목은 내부인건비 기본 + 비차단', () => {
    const parsed = parseOk(
      workbook([
        { ...PERSONNEL_OK, subcategory: '간접인건비' },
        { ...PERSONNEL_OK, subcategory: '' },
      ])
    );
    expect(parsed.personnel[0]?.subcategory).toBeNull();
    expect(kinds(parsed.personnel[0]!.issues)).toEqual(['unknown-subcategory!']);
    expect(parsed.personnel[1]?.subcategory).toBe('personnel_internal');
    expect(kinds(parsed.personnel[1]!.issues)).toEqual(['default-subcategory']);
  });

  it('참여율 120·개월 13·음수 → 범위 밖 blocking (값은 남긴다)', () => {
    const parsed = parseOk(
      workbook([
        { ...PERSONNEL_OK, participation: 120 },
        { ...PERSONNEL_OK, months: 13 },
        { ...PERSONNEL_OK, participation: -1, months: -2 },
      ])
    );
    expect(kinds(parsed.personnel[0]!.issues)).toEqual(['participation-out-of-range!']);
    expect(parsed.personnel[0]?.participation).toBe(120);
    expect(kinds(parsed.personnel[1]!.issues)).toEqual(['months-out-of-range!']);
    expect(parsed.personnel[1]?.months).toBe(13);
    expect(kinds(parsed.personnel[2]!.issues)).toEqual(['participation-out-of-range!', 'months-out-of-range!']);
  });

  it('경계값 0·100·12는 통과한다', () => {
    const parsed = parseOk(
      workbook([
        { ...PERSONNEL_OK, participation: 0, months: 0 },
        { ...PERSONNEL_OK, participation: 100, months: 12 },
      ])
    );
    expect(parsed.personnel.flatMap((row) => row.issues)).toEqual([]);
  });

  it('참여율·개월이 문자면 invalid blocking, 비면 missing blocking', () => {
    const parsed = parseOk(
      workbook([
        { ...PERSONNEL_OK, participation: '이십팔', months: 'abc' },
        { ...PERSONNEL_OK, participation: null, months: null, note: '메모만' },
      ])
    );
    expect(kinds(parsed.personnel[0]!.issues)).toEqual(['participation-invalid!', 'months-invalid!']);
    expect(parsed.personnel[0]?.participation).toBeNull();
    expect(kinds(parsed.personnel[1]!.issues)).toEqual(['participation-missing!', 'months-missing!']);
  });

  it('참여율·개월·조정액·비고가 전부 빈 행은 무시한다 — 키만 있는 자리표시 행 포함', () => {
    const parsed = parseOk(
      workbook([
        { memberId: 'm-1', detailId: '', subcategory: '내부인건비', axis: '현금' },
        {},
        { ...PERSONNEL_OK, memberId: 'm-2' },
        { memberId: 'm-2', annualSalary: 50000000, monthlySalary: 4166667, amount: 999 },
      ])
    );
    expect(parsed.personnel.map((row) => row.memberId)).toEqual(['m-2']);
    expect(parsed.personnel[0]?.rowIndex).toBe(INPUT_FORM_SHEETS.personnel.dataStartRow + 2);
  });

  it('연봉·월급·산식 금액·금액 칸에 임의 값을 넣어도 결과에 그 값이 없다 (PL-D7)', () => {
    const parsed = parseOk(
      workbook([
        {
          ...PERSONNEL_OK,
          name: '홍길동',
          position: '책임',
          staff: '홍길동(재직)',
          salaryBasis: '퇴직금 포함',
          annualSalary: 74000000,
          monthlySalary: 6166667,
          formulaAmount: 15540000,
          amount: 999,
        },
      ])
    );
    const row = parsed.personnel[0]!;
    expect(row.issues).toEqual([]);
    expect(Object.keys(row).sort()).toEqual(
      ['adjustment', 'axis', 'detailId', 'issues', 'memberId', 'months', 'note', 'participation', 'rowIndex', 'subcategory'].sort()
    );
    const serialized = JSON.stringify(row);
    for (const forbidden of ['74000000', '6166667', '15540000', '999', '홍길동', '책임', '퇴직금']) {
      expect(serialized).not.toContain(forbidden);
    }
  });

  it('축: 현물 → in_kind, 모르는 라벨 → blocking, 빈 축 → cash 기본 + 비차단', () => {
    const parsed = parseOk(
      workbook([
        { ...PERSONNEL_OK, axis: '현물' },
        { ...PERSONNEL_OK, axis: '현 금' },
        { ...PERSONNEL_OK, axis: '기타' },
        { ...PERSONNEL_OK, axis: '' },
      ])
    );
    expect(parsed.personnel[0]?.axis).toBe('in_kind');
    expect(parsed.personnel[1]?.axis).toBe('cash');
    expect(parsed.personnel[2]?.axis).toBeNull();
    expect(kinds(parsed.personnel[2]!.issues)).toEqual(['invalid-axis!']);
    expect(parsed.personnel[3]?.axis).toBe('cash');
    expect(kinds(parsed.personnel[3]!.issues)).toEqual(['default-axis']);
  });

  it('조정액: 빈 값 0, 문자열 금액 표기 허용, 소수·문자 → blocking', () => {
    const parsed = parseOk(
      workbook([
        { ...PERSONNEL_OK, adjustment: null },
        { ...PERSONNEL_OK, adjustment: '-5,000' },
        { ...PERSONNEL_OK, adjustment: 1000.5 },
        { ...PERSONNEL_OK, adjustment: '오천' },
      ])
    );
    expect(parsed.personnel[0]?.adjustment).toBe(0);
    expect(parsed.personnel[0]?.issues).toEqual([]);
    expect(parsed.personnel[1]?.adjustment).toBe(-5000);
    expect(kinds(parsed.personnel[2]!.issues)).toEqual(['adjustment-not-integer!']);
    expect(kinds(parsed.personnel[3]!.issues)).toEqual(['adjustment-invalid!']);
  });

  it('D-22: 백분율 서식 참여율 셀(0.28)은 ×100 → 28. 서식이 아니면 값 그대로', () => {
    const parsed = parseOk(
      workbook([
        { ...PERSONNEL_OK, participation: { value: 0.28, isError: false, percentFormat: true } },
        { ...PERSONNEL_OK, participation: { value: 0.28, isError: false } },
        { ...PERSONNEL_OK, participation: { value: 1, isError: false } },
      ])
    );
    expect(parsed.personnel[0]?.participation).toBe(28);
    expect(parsed.personnel[0]?.issues).toEqual([]);
    // 휴리스틱("1 이하면 ×100")을 쓰지 않는다 — 서식 정보만 믿는다
    expect(parsed.personnel[1]?.participation).toBe(0.28);
    expect(parsed.personnel[2]?.participation).toBe(1);
  });
});

// ─── 사업비 (IN-4) ───────────────────────────────────────────

describe('사업비 시트 (IN-4)', () => {
  it('정상 행: 세목 코드로 비목을 정하고 인자는 값 있는 것만 순서대로', () => {
    const parsed = parseOk(workbook([], [BUDGET_OK]));
    expect(parsed.budget).toEqual([
      {
        rowIndex: INPUT_FORM_SHEETS.budget.dataStartRow,
        subcategory: 'activity_meeting',
        category: 'activity',
        detailId: 'd-9',
        name: '착수회의',
        spec: '10인',
        unitPrice: 300000,
        factors: [2],
        adjustment: 0,
        axis: 'cash',
        note: '',
        issues: [],
      },
    ]);
  });

  it('모르는 복합 키·bare 코드·빈 키 → unknown-subcategory(blocking), category null — 행은 남는다', () => {
    const parsed = parseOk(
      workbook([], [
        { ...BUDGET_OK, subcategory: 'activity:activity_karaoke' },
        { ...BUDGET_OK, subcategory: 'karaoke:activity_meeting' },
        // 비목이 다른 조합 — 프리셋에 없는 (category, subcategory)는 PL-D4로 막는다
        { ...BUDGET_OK, subcategory: 'material:activity_meeting' },
        // bare 코드는 지어내지 않는다 — `default`가 여섯 비목에 공유된다
        { ...BUDGET_OK, subcategory: 'activity_meeting' },
        { ...BUDGET_OK, subcategory: 'default' },
        { ...BUDGET_OK, subcategory: '' },
      ])
    );
    expect(parsed.budget).toHaveLength(6);
    for (const row of parsed.budget) {
      expect(row.category).toBeNull();
      expect(kinds(row.issues)).toEqual(['unknown-subcategory!']);
    }
    // 원문 키가 그대로 남아 메시지에 보인다
    expect(parsed.budget[0]?.subcategory).toBe('activity:activity_karaoke');
    expect(parsed.budget[0]?.issues[0]?.message).toContain('activity:activity_karaoke');
    expect(parsed.budget[0]?.name).toBe('착수회의');
  });

  it("'default' 세목을 공유하는 여섯 비목은 복합 키로 각각 확정된다", () => {
    const categories = ['consignment', 'international', 'burden', 'promotion', 'allowance', 'other'] as const;
    const parsed = parseOk(
      workbook([], categories.map((category) => ({ ...BUDGET_OK, subcategory: `${category}:default` })))
    );
    expect(parsed.budget.map((row) => [row.category, row.subcategory])).toEqual(
      categories.map((category) => [category, 'default'])
    );
    expect(parsed.budget.flatMap((row) => row.issues)).toEqual([]);
  });

  it('복합 키 헬퍼: subcategoryKeyOf ↔ parseSubcategoryKey 왕복', () => {
    expect(subcategoryKeyOf('activity', 'activity_meeting')).toBe('activity:activity_meeting');
    expect(parseSubcategoryKey('consignment:default')).toEqual({ category: 'consignment', subcategory: 'default' });
    expect(parseSubcategoryKey('default')).toBeNull();
    expect(parseSubcategoryKey(':default')).toBeNull();
    expect(parseSubcategoryKey('activity:')).toBeNull();
    expect(parseSubcategoryKey('toString:default')).toBeNull();
  });

  it('품명·규격·단가·인자·조정액·비고가 전부 빈 행은 무시한다 (미리 깔린 빈 줄)', () => {
    const parsed = parseOk(
      workbook([], [
        { subcategory: 'activity:activity_meeting', category: '연구활동비', subcategoryLabel: '④ 회의비', axis: '현금' },
        { subcategory: 'activity:activity_meeting', amount: 12345 },
        {},
        { ...BUDGET_OK, name: '', spec: '', unitPrice: null, factor1: null, note: '비고만' },
      ])
    );
    expect(parsed.budget).toHaveLength(1);
    expect(parsed.budget[0]?.note).toBe('비고만');
    expect(parsed.budget[0]?.rowIndex).toBe(INPUT_FORM_SHEETS.budget.dataStartRow + 3);
    expect(parsed.budget[0]?.unitPrice).toBe(0);
    expect(parsed.budget[0]?.factors).toEqual([]);
  });

  it('인자: 빈 칸은 생략(0 아님), 소수 허용, 문자는 blocking', () => {
    const parsed = parseOk(
      workbook([], [
        { ...BUDGET_OK, factor1: null, factor2: 3, factor3: null },
        { ...BUDGET_OK, factor1: 2.5, factor2: null, factor3: 4 },
        { ...BUDGET_OK, factor1: '두번', factor2: 1 },
      ])
    );
    expect(parsed.budget[0]?.factors).toEqual([3]);
    expect(parsed.budget[1]?.factors).toEqual([2.5, 4]);
    expect(parsed.budget[2]?.factors).toEqual([1]);
    expect(kinds(parsed.budget[2]!.issues)).toEqual(['factor-invalid!']);
  });

  it('D-22: 백분율 서식 인자 셀(0.1)은 ×100 → 10', () => {
    const parsed = parseOk(
      workbook([], [
        {
          ...BUDGET_OK,
          factor1: { value: 0.1, isError: false, percentFormat: true },
          factor2: { value: 0.1, isError: false },
        },
      ])
    );
    expect(parsed.budget[0]?.factors).toEqual([10, 0.1]);
  });

  it('단가: 음수·소수·문자 → blocking, 조정액 소수 → blocking', () => {
    const parsed = parseOk(
      workbook([], [
        { ...BUDGET_OK, unitPrice: -100 },
        { ...BUDGET_OK, unitPrice: 100.7 },
        { ...BUDGET_OK, unitPrice: '백만' },
        { ...BUDGET_OK, adjustment: 0.5 },
        { ...BUDGET_OK, unitPrice: '1,200,000', adjustment: '(3,000)' },
      ])
    );
    expect(kinds(parsed.budget[0]!.issues)).toEqual(['unit-price-negative!']);
    expect(parsed.budget[0]?.unitPrice).toBe(-100);
    expect(kinds(parsed.budget[1]!.issues)).toEqual(['unit-price-not-integer!']);
    expect(kinds(parsed.budget[2]!.issues)).toEqual(['unit-price-invalid!']);
    expect(kinds(parsed.budget[3]!.issues)).toEqual(['adjustment-not-integer!']);
    expect(parsed.budget[4]?.issues).toEqual([]);
    expect(parsed.budget[4]?.unitPrice).toBe(1200000);
    expect(parsed.budget[4]?.adjustment).toBe(-3000);
  });

  it('축 규칙은 인건비와 같다', () => {
    const parsed = parseOk(
      workbook([], [
        { ...BUDGET_OK, axis: '현물' },
        { ...BUDGET_OK, axis: '현금현물' },
        { ...BUDGET_OK, axis: null },
      ])
    );
    expect(parsed.budget[0]?.axis).toBe('in_kind');
    expect(parsed.budget[1]?.axis).toBeNull();
    expect(kinds(parsed.budget[1]!.issues)).toEqual(['invalid-axis!']);
    expect(parsed.budget[2]?.axis).toBe('cash');
    expect(kinds(parsed.budget[2]!.issues)).toEqual(['default-axis']);
  });

  it('비목·세목 라벨·금액 칸에 다른 값을 적어도 결과는 숨김 코드만 따른다', () => {
    const parsed = parseOk(
      workbook([], [{ ...BUDGET_OK, category: '인건비', subcategoryLabel: '엉뚱한 세목', amount: 777777 }])
    );
    const row = parsed.budget[0]!;
    expect(row.category).toBe('activity');
    expect(row.issues).toEqual([]);
    expect(JSON.stringify(row)).not.toContain('777777');
    expect(JSON.stringify(row)).not.toContain('엉뚱한');
  });
});

// ─── 정적 검사 ───────────────────────────────────────────────

describe('parse.ts 정적 검사', () => {
  const source = fs.readFileSync(path.join(process.cwd(), 'lib', 'input-form', 'parse.ts'), 'utf8');

  it('SheetJS import 0 (IN-8)', () => {
    expect(source).not.toMatch(/from\s+['"]xlsx['"]/);
  });

  it('이름 매칭 함수 import 0 (IN-3)', () => {
    expect(source).not.toMatch(/matchDetailMembers|detailMemberKey|normalizeLabel/);
    expect(source).not.toMatch(/lib\/import\/detail-preview/);
  });

  /** 시트별 파싱 함수 본문 — 각 함수는 자기 시트의 read:true 열만 columnOf로 구해야 한다 */
  function sectionOf(fnName: string): string {
    const start = source.indexOf(`function ${fnName}(`);
    expect(start, fnName).toBeGreaterThanOrEqual(0);
    const rest = source.slice(start);
    const nextSection = rest.indexOf('\n// ───', 1);
    return nextSection === -1 ? rest : rest.slice(0, nextSection);
  }

  it.each([
    ['parsePersonnelSheet', 'personnel'],
    ['parseBudgetSheet', 'budget'],
  ] as const)('%s: columnOf로 구하는 역할은 전부 read: true 열이다', (fnName, key) => {
    const section = sectionOf(fnName);
    const roles = [...section.matchAll(/columnOf\(\s*def\s*,\s*'([A-Za-z0-9]+)'\s*\)/g)].map((m) => m[1]!);
    const sheet = INPUT_FORM_SHEETS[key];
    const readable = new Set(sheet.columns.filter((column) => column.read).map((column) => column.role));
    expect(new Set(roles)).toEqual(readable);
    // 읽지 않는 열의 역할 이름은 문자열로도 등장하지 않는다 — 다른 경로로 인덱스를 구하는 것도 막는다
    for (const column of sheet.columns) {
      if (!column.read) expect(section.includes(`'${column.role}'`), `${key}.${column.role}`).toBe(false);
    }
  });

  it('columnOf 호출은 두 파싱 함수 안에만 있다', () => {
    const total = [...source.matchAll(/columnOf\(/g)].length;
    const inSections =
      [...sectionOf('parsePersonnelSheet').matchAll(/columnOf\(/g)].length +
      [...sectionOf('parseBudgetSheet').matchAll(/columnOf\(/g)].length;
    // import 줄의 `columnOf` 는 `columnOf(` 가 아니므로 세지 않는다
    expect(total).toBe(inSections);
  });
});
