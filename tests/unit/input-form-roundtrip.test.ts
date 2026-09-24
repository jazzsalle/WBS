// 입력 양식 왕복 (SOT §6.16 IN-2·IN-3·IN-4·IN-5·IN-6·IN-7, 부록 B.7, §11 Phase 17 완료 기준)
//
// 부록 B.7 1차년도 → `buildInputForm` → `writeInputFormWorkbook`(xlsx 바이트) → `readWorkbook`(올리기 경로 그대로)
// → `parseInputForm` → `buildInputFormPreview`. 생성기·어댑터·파서·미리보기를 **실제 xlsx 바이트**로 이어
// 같은 산출근거에 도달하는지 본다 — 부록 B.7 ↔ B.8 등가와 같은 방식이다. 각 모듈의 단위 테스트는 따로 있으므로
// 여기서는 경계를 넘을 때 값이 살아 있는가만 본다.
//
// 수식 검산(b)은 SheetJS가 재계산을 하지 않으므로 **우리가 수식 문자열을 직접 파싱해 계산한다**
// (export-roundtrip.test.ts의 recalc와 같은 원칙): 허용 문법은 생성기가 실제로 쓰는 ROUND·IF·사칙연산·`=`뿐이고,
// 그 밖의 토큰을 만나면 조용히 건너뛰지 않고 던진다 — 건너뛰면 검산이 사라진다.
//
// 기준값은 전부 SOT다(부록 B.7.1~B.7.3). 구현이 낸 값을 기준으로 삼지 않는다.

import { describe, expect, it } from 'vitest';
import * as XLSX from 'xlsx';
import {
  INPUT_FORM_SHEETS,
  INPUT_FORM_VERSION,
  META_KEYS,
  buildInputForm,
  buildInputFormPreview,
  columnOf,
  parseInputForm,
} from '@/lib/input-form';
import type { InputFormData, InputFormPreview, ParsedInputForm } from '@/lib/input-form';
import { writeInputFormWorkbook } from '@/lib/input-form-adapter';
import { readWorkbook } from '@/lib/import-adapter';
import { DETAIL_AXIS_LABELS } from '@/lib/constants';
import { monthSpan } from '@/lib/dates';
import type { RawSheet } from '@/lib/import/types';
import type { BudgetDetail, DetailAxis, Member } from '@/types';

const PROJECT = { id: 'proj-1', name: '스마트 건설 플랫폼' };
/** 2025-04-01~2025-12-31 — 부록 B.7.1 "참여기간 9개월" */
const YEAR = { id: 'year-1', name: '1차년도', startDate: '2025-04-01', endDate: '2025-12-31', order: 0 };
const TODAY = '2026-09-25';
const YEAR_MONTHS = monthSpan(YEAR.startDate, YEAR.endDate);

const PERSONNEL_DEF = INPUT_FORM_SHEETS.personnel;
const BUDGET_DEF = INPUT_FORM_SHEETS.budget;
const META_DEF = INPUT_FORM_SHEETS.meta;

// ─── 부록 B.7.1 인건비 19행 — [성명, 연봉, 참여율, 축, 개월, 최종 금액, 조정액] ──
// 조정액은 `최종 − 산식`으로 역산한 값이고 최종 금액 열이 원본 셀 값이다 (B.7.1 주석)

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
  ['신규채용1(청년의무)', 51_000_000, 100.0, 'cash', 8, 34_000_000, 0],
] as const;

const NEW_HIRE_INDEX = PERSONNEL.length - 1;

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
  member({
    id: `m-${index}`,
    name,
    order: index,
    annualSalary: salary,
    hireType: index === NEW_HIRE_INDEX ? 'new' : 'existing',
  })
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

// ─── 부록 B.7.2 연구활동비 5행 + B.7.3 간접비 1행 ─────────────

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
    id: 'q-aec',
    category: 'activity',
    subcategory: 'activity_software',
    name: 'AEC Collection',
    unitPrice: 540_000,
    // 실측 라벨 `시트(수량)` — IN-4: 왕복하면 프리셋 라벨 `수량`으로 돌아온다(값만 보존)
    factors: [
      { label: '시트(수량)', value: 4, isPercent: false },
      { label: '월', value: 9, isPercent: false },
    ],
    amount: 19_440_000,
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
    id: 'q-print',
    category: 'activity',
    subcategory: 'activity_etc',
    name: '인쇄/복사/인화/슬라이드 제작',
    unitPrice: 450_000,
    factors: [{ label: '회', value: 2, isPercent: false }],
    order: 0,
    amount: 900_000,
  }),
  detail({
    id: 'q-fee',
    category: 'activity',
    subcategory: 'activity_etc',
    name: '위탁정산 수수료',
    unitPrice: 2_480_000,
    factors: [{ label: '회', value: 1, isPercent: false }],
    order: 1,
    amount: 2_480_000,
  }),
  detail({
    id: 'q-safety',
    category: 'indirect',
    subcategory: 'indirect_support',
    name: '연구실 안전관리비',
    unitPrice: 2_000_000,
    factors: [],
    amount: 2_000_000,
  }),
];

/** B.7.2 기대 금액 (품명 → 금액) */
const QUANTITY_EXPECTED: ReadonlyMap<string, number> = new Map([
  ['회의비', 3_000_000],
  ['AEC Collection', 19_440_000],
  ['국내출장비', 1_200_000],
  ['인쇄/복사/인화/슬라이드 제작', 900_000],
  ['위탁정산 수수료', 2_480_000],
]);

const ALL_DETAILS: BudgetDetail[] = [...PERSONNEL_DETAILS, ...QUANTITY_DETAILS];

const DATA: InputFormData = { project: PROJECT, year: YEAR, members: MEMBERS, details: ALL_DETAILS };

// ─── 파이프라인 ──────────────────────────────────────────────

/** 생성 → 쓰기 → 올리기 경로로 읽기. 파서가 받는 것과 정확히 같은 RawSheet 목록이다 */
function roundtripSheets(data: InputFormData): { buffer: Buffer; sheets: RawSheet[] } {
  const buffer = writeInputFormWorkbook(buildInputForm(data, TODAY));
  return { buffer, sheets: readWorkbook(new Uint8Array(buffer)) };
}

function parseOrThrow(sheets: readonly RawSheet[]): ParsedInputForm {
  const result = parseInputForm(sheets, { projectId: PROJECT.id, formVersion: INPUT_FORM_VERSION });
  if (!result.ok) throw new Error(`파싱 거부: ${result.rejection.kind} — ${result.rejection.message}`);
  return result.parsed;
}

function previewOf(
  sheets: readonly RawSheet[],
  existingDetails: readonly BudgetDetail[] = ALL_DETAILS,
  members: readonly Member[] = MEMBERS
): InputFormPreview {
  return buildInputFormPreview({
    parsed: parseOrThrow(sheets),
    yearId: YEAR.id,
    projectId: PROJECT.id,
    members,
    existingDetails,
    yearMonths: YEAR_MONTHS,
  });
}

function rowOf(result: InputFormPreview, detailId: string) {
  const row = result.rows.find((r) => r.detailId === detailId);
  if (!row) throw new Error(`행 ${detailId} 없음`);
  return row;
}

function cellOf(result: InputFormPreview, category: string) {
  const cell = result.totals.cells.find((c) => c.category === category);
  if (!cell) throw new Error(`셀 ${category} 없음`);
  return cell;
}

// ─── RawSheet 조작 (테스트 안에서만) ──────────────────────────

function sheetNamed(sheets: readonly RawSheet[], name: string): RawSheet {
  const found = sheets.find((s) => s.name === name);
  if (!found) throw new Error(`시트 '${name}'이 없다`);
  return found;
}

/** 0-based 행 인덱스. 데이터 행만 훑고 못 찾으면 던진다 — 조용히 -1을 돌려주면 아래 덮어쓰기가 헛돈다 */
function findRow(sheet: RawSheet, def: typeof PERSONNEL_DEF, role: string, value: string | null): number {
  const column = columnOf(def, role);
  for (let r = def.dataStartRow - 1; r < sheet.cells.length; r += 1) {
    if ((sheet.cells[r]?.[column]?.value ?? null) === value) return r;
  }
  throw new Error(`'${sheet.name}' 시트에서 ${role}=${String(value)} 행을 찾지 못했다`);
}

function setRaw(sheet: RawSheet, def: typeof PERSONNEL_DEF, r: number, role: string, value: string | number | null): void {
  const row = sheet.cells[r];
  if (!row) throw new Error(`행 ${r + 1}이 없다`);
  row[columnOf(def, role)] = { value, isError: false };
}

/** 원본 RawSheet를 건드리지 않도록 복제한 뒤 고친다 */
function mutated(sheets: readonly RawSheet[], mutate: (copy: RawSheet[]) => void): RawSheet[] {
  const copy = structuredClone(sheets) as RawSheet[];
  mutate(copy);
  return copy;
}

// ─── SheetJS 조작 — 버퍼를 열어 셀을 바꾸고 다시 써서 올리기 경로로 읽는다 ──

function rewritten(buffer: Buffer, mutate: (wb: XLSX.WorkBook) => void): RawSheet[] {
  const wb = XLSX.read(buffer, { type: 'buffer', cellFormula: true, cellNF: true });
  mutate(wb);
  const out: unknown = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
  if (!Buffer.isBuffer(out)) throw new Error('다시 쓴 워크북이 Buffer가 아니다');
  return readWorkbook(new Uint8Array(out));
}

function addr(def: typeof PERSONNEL_DEF, role: string, r0: number): string {
  return XLSX.utils.encode_cell({ r: r0, c: columnOf(def, role) });
}

/** `_meta` 시트에서 키 행(0-based)을 찾는다 */
function metaRowOf(ws: XLSX.WorkSheet, key: string): number {
  const keyCol = columnOf(META_DEF, 'key');
  const range = XLSX.utils.decode_range(ws['!ref'] ?? 'A1:A1');
  for (let r = META_DEF.dataStartRow - 1; r <= range.e.r; r += 1) {
    const cell = ws[XLSX.utils.encode_cell({ r, c: keyCol })] as XLSX.CellObject | undefined;
    if (cell?.v === key) return r;
  }
  throw new Error(`_meta에 '${key}' 행이 없다`);
}

// ─── 수식 계산기 (b) ──────────────────────────────────────────
//
// 생성기가 쓰는 문법만: 숫자 · "" 문자열 · 같은 시트 참조 · ROUND · IF · + - * / · `=`.
// 그 밖(다른 함수·범위·시트 참조)은 던진다 — 모르는 것을 통과시키면 검산이 아니다.

type Value = number | string | boolean | null;

interface Token {
  kind: 'number' | 'string' | 'ref' | 'func' | 'op';
  text: string;
}

const TOKEN_PATTERN = /\s*(?:(\d+(?:\.\d+)?)|"([^"]*)"|([A-Za-z]+)\s*\(|(\$?[A-Z]{1,3}\$?\d{1,7})|([+\-*/(),=]))/gy;

function tokenize(formula: string): Token[] {
  const tokens: Token[] = [];
  TOKEN_PATTERN.lastIndex = 0;
  while (TOKEN_PATTERN.lastIndex < formula.length) {
    const match = TOKEN_PATTERN.exec(formula);
    if (!match) throw new Error(`수식을 읽지 못했다: '${formula}' (${TOKEN_PATTERN.lastIndex}번째 글자부터)`);
    if (match[1] !== undefined) tokens.push({ kind: 'number', text: match[1] });
    else if (match[2] !== undefined) tokens.push({ kind: 'string', text: match[2] });
    else if (match[3] !== undefined) tokens.push({ kind: 'func', text: match[3].toUpperCase() });
    else if (match[4] !== undefined) tokens.push({ kind: 'ref', text: match[4].replace(/\$/g, '') });
    else tokens.push({ kind: 'op', text: match[5]! });
  }
  return tokens;
}

const KNOWN_FUNCTIONS: ReadonlySet<string> = new Set(['ROUND', 'IF']);

/** 산술 문맥의 숫자. 빈 칸은 0, 문자열은 엑셀의 #VALUE!다 — 조용히 0으로 두지 않는다 */
function toNumber(value: Value, where: string): number {
  if (value === null) return 0;
  if (typeof value === 'number') return value;
  if (typeof value === 'boolean') return value ? 1 : 0;
  throw new Error(`${where}: 문자열 '${value}'을 산술에 썼다 (#VALUE!)`);
}

/** 엑셀의 `=`: 빈 칸은 ""와도 0과도 같다. 숫자와 문자열은 같지 않다 */
function equals(a: Value, b: Value): boolean {
  if (typeof a === 'string' || typeof b === 'string') return (a ?? '') === (b ?? '');
  return toNumber(a, '=') === toNumber(b, '=');
}

class Recalc {
  private readonly evaluating = new Set<string>();

  constructor(private readonly ws: XLSX.WorkSheet, private readonly sheetName: string) {}

  cell(address: string): Value {
    const record = this.ws[address] as XLSX.CellObject | undefined;
    if (!record) return null;
    // 캐시된 계산값은 믿지 않는다 — 어댑터가 캐시를 쓰지 않기도 하지만, 있더라도 수식에서 다시 낸다
    if (typeof record.f === 'string') {
      const key = `${this.sheetName}!${address}`;
      if (this.evaluating.has(key)) throw new Error(`수식이 순환한다: ${key}`);
      this.evaluating.add(key);
      try {
        return this.evaluate(record.f);
      } finally {
        this.evaluating.delete(key);
      }
    }
    if (record.v === undefined || record.v === null) return null;
    if (typeof record.v === 'number' || typeof record.v === 'string' || typeof record.v === 'boolean') return record.v;
    throw new Error(`${this.sheetName}!${address}: 다룰 수 없는 셀 값 ${String(record.v)}`);
  }

  number(address: string): number {
    const value = this.cell(address);
    if (typeof value !== 'number') {
      throw new Error(`${this.sheetName}!${address}: 숫자가 아니다 (${String(value)})`);
    }
    return value;
  }

  evaluate(formula: string): Value {
    const parser = new Parser(this, tokenize(formula));
    const value = parser.parseComparison();
    parser.expectEnd(formula);
    return value;
  }
}

class Parser {
  private index = 0;

  constructor(
    private readonly recalc: Recalc,
    private readonly tokens: readonly Token[]
  ) {}

  expectEnd(formula: string): void {
    if (this.index !== this.tokens.length) throw new Error(`수식을 끝까지 읽지 못했다: '${formula}'`);
  }

  parseComparison(): Value {
    const left = this.parseAdditive();
    const token = this.peek();
    if (token?.kind === 'op' && token.text === '=') {
      this.index += 1;
      return equals(left, this.parseAdditive());
    }
    return left;
  }

  private parseAdditive(): Value {
    let value = this.parseTerm();
    for (;;) {
      const token = this.peek();
      if (token?.kind !== 'op' || (token.text !== '+' && token.text !== '-')) return value;
      this.index += 1;
      const right = toNumber(this.parseTerm(), token.text);
      const leftNumber = toNumber(value, token.text);
      value = token.text === '+' ? leftNumber + right : leftNumber - right;
    }
  }

  private parseTerm(): Value {
    let value = this.parseUnary();
    for (;;) {
      const token = this.peek();
      if (token?.kind !== 'op' || (token.text !== '*' && token.text !== '/')) return value;
      this.index += 1;
      const right = toNumber(this.parseUnary(), token.text);
      const leftNumber = toNumber(value, token.text);
      if (token.text === '/' && right === 0) throw new Error('0으로 나눈다 (#DIV/0!)');
      value = token.text === '*' ? leftNumber * right : leftNumber / right;
    }
  }

  private parseUnary(): Value {
    const token = this.peek();
    if (token?.kind === 'op' && (token.text === '+' || token.text === '-')) {
      this.index += 1;
      const value = toNumber(this.parseUnary(), token.text);
      return token.text === '-' ? -value : value;
    }
    return this.parsePrimary();
  }

  private parsePrimary(): Value {
    const token = this.next();
    if (token.kind === 'number') return Number(token.text);
    if (token.kind === 'string') return token.text;
    if (token.kind === 'ref') return this.recalc.cell(token.text);
    if (token.kind === 'func') return this.parseFunction(token.text);
    if (token.kind === 'op' && token.text === '(') {
      const value = this.parseComparison();
      this.expect(')');
      return value;
    }
    throw new Error(`예상치 못한 토큰: '${token.text}'`);
  }

  private parseFunction(name: string): Value {
    if (!KNOWN_FUNCTIONS.has(name)) {
      throw new Error(`모르는 함수다: ${name}. 생성기가 새 함수를 쓰기 시작했다면 계산기를 넓혀야 한다`);
    }
    const args: Value[] = [];
    if (!this.peekIsClose()) {
      for (;;) {
        args.push(this.parseComparison());
        const token = this.next();
        if (token.kind === 'op' && token.text === ',') continue;
        if (token.kind === 'op' && token.text === ')') break;
        throw new Error(`인자 구분이 잘못됐다: '${token.text}'`);
      }
    } else {
      this.expect(')');
    }

    if (name === 'IF') {
      if (args.length !== 3) throw new Error(`IF 인자가 ${args.length}개다 (3개여야 한다)`);
      const condition = args[0];
      if (typeof condition !== 'boolean') throw new Error(`IF 조건이 논리값이 아니다: ${String(condition)}`);
      return condition ? args[1]! : args[2]!;
    }
    // ROUND: 엑셀은 .5를 0에서 먼 쪽으로 반올림한다 (Math.round는 음수에서 다르다)
    if (args.length !== 2) throw new Error(`ROUND 인자가 ${args.length}개다 (2개여야 한다)`);
    const scale = 10 ** toNumber(args[1]!, 'ROUND');
    const value = toNumber(args[0]!, 'ROUND') * scale;
    return (Math.sign(value) * Math.round(Math.abs(value))) / scale;
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
    if (token.kind !== 'op' || token.text !== text) throw new Error(`'${text}'가 와야 하는데 '${token.text}'가 왔다`);
  }
}

// ═══ 왕복 ═══════════════════════════════════════════════════════

const base = roundtripSheets(DATA);

describe('(a) 부록 B.7 왕복 — 생성 → xlsx → 읽기 → 파싱 → 미리보기가 같은 산출근거에 도달한다', () => {
  const result = previewOf(base.sheets);

  it('시트 3장이 올리기 경로에서 그대로 읽힌다 (숨김 _meta 포함, IN-2)', () => {
    expect(base.sheets.map((s) => s.name)).toEqual([PERSONNEL_DEF.name, BUDGET_DEF.name, META_DEF.name]);
  });

  it('행 25건 전부 unchanged — added·changed·deleted 0, 차단 없음', () => {
    expect(result.rows).toHaveLength(25);
    expect(result.summary).toEqual({ added: 0, changed: 0, deleted: 0, unchanged: 25, errors: 0, unknown: 0 });
    expect(result.blocked).toBe(false);
    expect(result.deletedDetailIds).toEqual([]);
    expect(result.untouchedCategories).toEqual([]);
    expect(result.replaceCategories).toEqual(['personnel', 'activity', 'indirect']);
  });

  it('인건비 19행·활동비 5행·간접비 1행의 금액이 SOT와 원 단위로 같다 (B.7.1·B.7.2)', () => {
    PERSONNEL.forEach(([name, , , , , amount], index) => {
      expect(rowOf(result, `p-${index}`).amount, name).toBe(amount);
    });
    for (const [name, amount] of QUANTITY_EXPECTED) {
      const row = result.rows.find((r) => r.name === name);
      expect(row?.amount, name).toBe(amount);
    }
    expect(rowOf(result, 'q-safety').amount).toBe(2_000_000);
  });

  it('총액 298,510,000 — 현금 180,840,000 + 27,020,000 + 2,000,000 / 현물 88,650,000 (B.7.3)', () => {
    const personnel = cellOf(result, 'personnel');
    expect(personnel.cashAmount).toBe(180_840_000);
    expect(personnel.inKindAmount).toBe(88_650_000);
    expect(cellOf(result, 'activity').cashAmount).toBe(27_020_000);
    expect(cellOf(result, 'indirect').cashAmount).toBe(2_000_000);
    expect(result.totals.total.cashAmount).toBe(180_840_000 + 27_020_000 + 2_000_000);
    expect(result.totals.total.inKindAmount).toBe(88_650_000);
    expect(result.totals.total.plannedAmount).toBe(298_510_000);
    expect(result.commitRows.reduce((sum, r) => sum + r.amount, 0)).toBe(298_510_000);
  });

  it('인건비 행의 인자·축·memberId가 원본 그대로다 — 이름 매칭 없이 숨김 열로 이어졌다 (IN-3)', () => {
    const row = rowOf(result, 'p-3'); // 박선욱
    expect(row.memberId).toBe('m-3');
    expect(row.axis).toBe('cash');
    expect(row.factors).toEqual([
      { label: '참여율(%)', value: 28, isPercent: true },
      { label: '참여기간(월)', value: 9, isPercent: false },
    ]);
    expect(rowOf(result, 'p-4').axis).toBe('in_kind');
    expect(rowOf(result, 'p-4').adjustment).toBe(-270_000);
    expect(rowOf(result, `p-${NEW_HIRE_INDEX}`).factors[1]?.value).toBe(8);
  });

  it('라벨이 바뀌어 있던 quantity 행은 프리셋 라벨로 돌아오되 변경이 아니다 (IN-4 한계 안내)', () => {
    const aec = rowOf(result, 'q-aec');
    expect(aec.status).toBe('unchanged');
    expect(aec.factors.map((f) => f.label)).toEqual(['수량', '월']);
    expect(result.warnings.some((w) => w.kind === 'factor-label-reset')).toBe(true);
  });
});

// ═══ (b) 수식 검산 ══════════════════════════════════════════════

describe('(b) 수식 검산 — 생성기의 엑셀 수식을 직접 계산하면 SOT 최종 금액이 나온다 (IN-7)', () => {
  const wb = XLSX.read(base.buffer, { type: 'buffer', cellFormula: true });
  const personnelWs = wb.Sheets[PERSONNEL_DEF.name];
  const budgetWs = wb.Sheets[BUDGET_DEF.name];
  if (!personnelWs || !budgetWs) throw new Error('인건비·사업비 시트가 없다');
  const personnel = new Recalc(personnelWs, PERSONNEL_DEF.name);
  const budget = new Recalc(budgetWs, BUDGET_DEF.name);

  /** memberId 숨김 열로 인건비 데이터 행(0-based)을 찾는다 */
  function personnelRow(memberId: string): number {
    const range = XLSX.utils.decode_range(personnelWs!['!ref'] ?? 'A1:A1');
    for (let r = PERSONNEL_DEF.dataStartRow - 1; r <= range.e.r; r += 1) {
      const cell = personnelWs![addr(PERSONNEL_DEF, 'memberId', r)] as XLSX.CellObject | undefined;
      if (cell?.v === memberId) return r;
    }
    throw new Error(`인건비 시트에 ${memberId} 행이 없다`);
  }

  function budgetRow(name: string): number {
    const range = XLSX.utils.decode_range(budgetWs!['!ref'] ?? 'A1:A1');
    for (let r = BUDGET_DEF.dataStartRow - 1; r <= range.e.r; r += 1) {
      const cell = budgetWs![addr(BUDGET_DEF, 'name', r)] as XLSX.CellObject | undefined;
      if (cell?.v === name) return r;
    }
    throw new Error(`사업비 시트에 '${name}' 행이 없다`);
  }

  it('인건비 19행: 산식 금액 = 최종 − 조정액, 금액 = SOT 최종 금액 (박선욱 15,540,000 등)', () => {
    PERSONNEL.forEach(([name, , , , , amount, adjustment], index) => {
      const r = personnelRow(`m-${index}`);
      const formulaCell = personnelWs![addr(PERSONNEL_DEF, 'formulaAmount', r)] as XLSX.CellObject | undefined;
      const amountCell = personnelWs![addr(PERSONNEL_DEF, 'amount', r)] as XLSX.CellObject | undefined;
      // 값이 아니라 수식이어야 한다 — 캐시값을 검산하면 생성기의 계산을 되풀이하는 것밖에 안 된다
      expect(formulaCell?.f, `${name} 산식 금액`).toMatch(/^ROUND\(/);
      expect(formulaCell?.v, `${name} 산식 금액 캐시`).toBeUndefined();
      expect(amountCell?.f, `${name} 금액`).toBeDefined();

      expect(personnel.number(addr(PERSONNEL_DEF, 'formulaAmount', r)), `${name} 산식`).toBe(amount - adjustment);
      expect(personnel.number(addr(PERSONNEL_DEF, 'amount', r)), `${name} 금액`).toBe(amount);
    });
  });

  it('PL-2 회귀 — 박선욱 수식은 연봉 셀을 쓰고 월급 셀을 쓰지 않아 정확히 15,540,000이다', () => {
    const r = personnelRow('m-3');
    const formula = (personnelWs![addr(PERSONNEL_DEF, 'formulaAmount', r)] as XLSX.CellObject).f ?? '';
    expect(formula).toContain(addr(PERSONNEL_DEF, 'annualSalary', r));
    expect(formula).not.toContain(addr(PERSONNEL_DEF, 'monthlySalary', r));
    expect(personnel.number(addr(PERSONNEL_DEF, 'amount', r))).toBe(15_540_000);
    // 월급 셀(표시용)을 거쳤다면 15,540,001 — 그 값이 아님을 못박는다
    const monthly = personnel.number(addr(PERSONNEL_DEF, 'monthlySalary', r));
    expect(Math.round(monthly * 0.28 * 9)).toBe(15_540_001);
  });

  it('인건비 시트의 수식 셀은 산식 금액·금액 열뿐이다 — 다른 열에 수식이 숨어 있지 않다', () => {
    const allowed = new Set([columnOf(PERSONNEL_DEF, 'formulaAmount'), columnOf(PERSONNEL_DEF, 'amount')]);
    for (const address of Object.keys(personnelWs!)) {
      if (address.startsWith('!')) continue;
      const cell = personnelWs![address] as XLSX.CellObject;
      if (typeof cell.f === 'string') {
        expect(allowed.has(XLSX.utils.decode_cell(address).c), `${address}: ${cell.f}`).toBe(true);
      }
    }
  });

  it('사업비 5행: ROUND(단가×IF(인자="",1,인자)…+조정액,0)이 SOT 금액이다 — 빈 인자는 1', () => {
    for (const [name, amount] of QUANTITY_EXPECTED) {
      const r = budgetRow(name);
      const cell = budgetWs![addr(BUDGET_DEF, 'amount', r)] as XLSX.CellObject | undefined;
      expect(cell?.f, name).toContain('IF(');
      expect(cell?.v, `${name} 캐시`).toBeUndefined();
      expect(budget.number(addr(BUDGET_DEF, 'amount', r)), name).toBe(amount);
    }
    // 인자 0개 행(간접비): 세 IF가 전부 1이라 단가 그대로
    const safety = budgetRow('연구실 안전관리비');
    expect(budgetWs![addr(BUDGET_DEF, 'factor1', safety)]).toBeUndefined();
    expect(budget.number(addr(BUDGET_DEF, 'amount', safety))).toBe(2_000_000);
  });

  it('계산기는 모르는 함수·범위를 통과시키지 않는다 (검산의 전제)', () => {
    expect(() => personnel.evaluate('SUM(A1:A2)')).toThrow(/모르는 함수|읽지 못했다/);
    expect(() => personnel.evaluate('TRUNC(1.5,0)')).toThrow(/모르는 함수/);
    expect(() => personnel.evaluate('A1+')).toThrow();
    expect(personnel.evaluate('ROUND(2.5,0)')).toBe(3);
    expect(personnel.evaluate('ROUND(-2.5,0)')).toBe(-3);
    expect(personnel.evaluate('IF(1=1,10,20)')).toBe(10);
  });
});

// ═══ (c) 금액·연봉 열은 읽지 않는다 ═══════════════════════════════

describe('(c) 금액·산식 금액·연봉·월급을 999로 덮어써도 미리보기 금액은 PL-1 값이다 (IN-3, PL-D7)', () => {
  const overwritten = mutated(base.sheets, (copy) => {
    const sheet = sheetNamed(copy, PERSONNEL_DEF.name);
    for (let r = PERSONNEL_DEF.dataStartRow - 1; r < sheet.cells.length; r += 1) {
      for (const role of ['amount', 'formulaAmount', 'annualSalary', 'monthlySalary']) {
        setRaw(sheet, PERSONNEL_DEF, r, role, 999);
      }
    }
    const budgetSheet = sheetNamed(copy, BUDGET_DEF.name);
    for (let r = BUDGET_DEF.dataStartRow - 1; r < budgetSheet.cells.length; r += 1) {
      setRaw(budgetSheet, BUDGET_DEF, r, 'amount', 999);
    }
  });
  const result = previewOf(overwritten);

  it('변경 0 · 총액 298,510,000 그대로', () => {
    expect(result.summary).toEqual({ added: 0, changed: 0, deleted: 0, unchanged: 25, errors: 0, unknown: 0 });
    expect(result.totals.total.plannedAmount).toBe(298_510_000);
    PERSONNEL.forEach(([name, , , , , amount], index) => {
      expect(rowOf(result, `p-${index}`).amount, name).toBe(amount);
    });
    expect(result.rows.some((r) => r.amount === 999)).toBe(false);
  });

  it('덮어쓴 값이 실제로 격자에 있었다 — 테스트가 헛돌지 않았다는 확인', () => {
    const sheet = sheetNamed(overwritten, PERSONNEL_DEF.name);
    const r = findRow(sheet, PERSONNEL_DEF, 'memberId', 'm-3');
    expect(sheet.cells[r]?.[columnOf(PERSONNEL_DEF, 'annualSalary')]?.value).toBe(999);
    expect(sheet.cells[r]?.[columnOf(PERSONNEL_DEF, 'amount')]?.value).toBe(999);
  });
});

// ═══ (d) 빈 인력 행에 값을 적으면 add ══════════════════════════════

describe('(d) 산출근거 0건 인력의 빈 행에 참여율 30·개월 12·현금을 적어 올리면 add 1행', () => {
  const EMPTY_MEMBER = member({ id: 'm-empty', name: '신입', order: 100, annualSalary: 40_000_000 });
  const data: InputFormData = { ...DATA, members: [...MEMBERS, EMPTY_MEMBER] };
  const { sheets } = roundtripSheets(data);

  it('생성된 빈 행은 memberId만 있고 detailId·참여율·개월·축이 비어 있다 (IN-3 "0건이면 빈 값 1행")', () => {
    const sheet = sheetNamed(sheets, PERSONNEL_DEF.name);
    const r = findRow(sheet, PERSONNEL_DEF, 'memberId', 'm-empty');
    const row = sheet.cells[r]!;
    expect(row[columnOf(PERSONNEL_DEF, 'detailId')]?.value).toBeNull();
    expect(row[columnOf(PERSONNEL_DEF, 'participation')]?.value).toBeNull();
    expect(row[columnOf(PERSONNEL_DEF, 'months')]?.value).toBeNull();
    expect(row[columnOf(PERSONNEL_DEF, 'axis')]?.value).toBeNull();
    // 값을 적지 않은 채 올리면 빈 행으로 무시되어 25행 그대로다
    expect(previewOf(sheets, ALL_DETAILS, data.members).rows).toHaveLength(25);
  });

  it('add 1 · 금액 = round(40,000,000 × 0.3) = 12,000,000 · 총액 + 12,000,000', () => {
    const filled = mutated(sheets, (copy) => {
      const sheet = sheetNamed(copy, PERSONNEL_DEF.name);
      const r = findRow(sheet, PERSONNEL_DEF, 'memberId', 'm-empty');
      setRaw(sheet, PERSONNEL_DEF, r, 'participation', 30);
      setRaw(sheet, PERSONNEL_DEF, r, 'months', 12);
      setRaw(sheet, PERSONNEL_DEF, r, 'axis', DETAIL_AXIS_LABELS.cash);
    });
    const result = previewOf(filled, ALL_DETAILS, data.members);
    expect(result.summary).toEqual({ added: 1, changed: 0, deleted: 0, unchanged: 25, errors: 0, unknown: 0 });
    const added = result.rows.find((r) => r.memberId === 'm-empty');
    expect(added).toMatchObject({
      status: 'add',
      detailId: null,
      category: 'personnel',
      subcategory: 'personnel_internal',
      axis: 'cash',
      amount: Math.round(40_000_000 * 0.3),
    });
    expect(added?.amount).toBe(12_000_000);
    // 연차 9개월인데 12개월 — 경고만, 막지 않는다
    expect(added?.issues.some((i) => i.kind === 'months-over-year' && !i.blocking)).toBe(true);
    expect(result.blocked).toBe(false);
    expect(result.commitRows.some((r) => r.member_id === 'm-empty' && r.amount === 12_000_000)).toBe(true);
    expect(result.totals.total.plannedAmount).toBe(298_510_000 + 12_000_000);
  });
});

// ═══ (e) _meta 거부 ════════════════════════════════════════════════

describe('(e) _meta를 고친 워크북은 파일째 거부한다 (IN-2)', () => {
  const expected = { projectId: PROJECT.id, formVersion: INPUT_FORM_VERSION };

  it('projectId를 바꾸면 project-mismatch', () => {
    const sheets = rewritten(base.buffer, (wb) => {
      const ws = wb.Sheets[META_DEF.name]!;
      const r = metaRowOf(ws, META_KEYS.projectId);
      ws[addr(META_DEF, 'value', r)] = { t: 's', v: 'someone-else' };
    });
    const result = parseInputForm(sheets, expected);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('거부되어야 한다');
    expect(result.rejection.kind).toBe('project-mismatch');
    expect(result.rejection.message).toContain('이 과제의 양식이 아닙니다');
  });

  it('formVersion을 바꾸면 version-mismatch', () => {
    const sheets = rewritten(base.buffer, (wb) => {
      const ws = wb.Sheets[META_DEF.name]!;
      const r = metaRowOf(ws, META_KEYS.formVersion);
      ws[addr(META_DEF, 'value', r)] = { t: 'n', v: INPUT_FORM_VERSION + 1 };
    });
    const result = parseInputForm(sheets, expected);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('거부되어야 한다');
    expect(result.rejection.kind).toBe('version-mismatch');
  });

  it('_meta 시트를 지우면 no-meta', () => {
    const sheets = base.sheets.filter((s) => s.name !== META_DEF.name);
    const result = parseInputForm(sheets, expected);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('거부되어야 한다');
    expect(result.rejection.kind).toBe('no-meta');
  });

  it('고치지 않은 원본은 통과한다 — 거부가 SheetJS 재쓰기 때문이 아니라는 대조', () => {
    const sheets = rewritten(base.buffer, () => {});
    expect(parseInputForm(sheets, expected).ok).toBe(true);
    expect(previewOf(sheets).summary.unchanged).toBe(25);
  });
});

// ═══ (f) 사업비 빈 줄·행 비움 ════════════════════════════════════

describe('(f) 사업비 시트 — 빈 줄에 적으면 add, 기존 행을 비우면 deleted (IN-4·IN-5)', () => {
  it('회의비 빈 줄에 품명·단가 500,000·인자 6 → add · 금액 3,000,000', () => {
    const sheets = rewritten(base.buffer, (wb) => {
      const ws = wb.Sheets[BUDGET_DEF.name]!;
      const range = XLSX.utils.decode_range(ws['!ref'] ?? 'A1:A1');
      // activity_meeting 슬롯의 첫 빈 줄(detailId 없음)
      let target = -1;
      for (let r = BUDGET_DEF.dataStartRow - 1; r <= range.e.r; r += 1) {
        const key = (ws[addr(BUDGET_DEF, 'subcategory', r)] as XLSX.CellObject | undefined)?.v;
        const detailId = ws[addr(BUDGET_DEF, 'detailId', r)];
        if (key === 'activity:activity_meeting' && detailId === undefined) {
          target = r;
          break;
        }
      }
      if (target < 0) throw new Error('회의비 빈 줄이 없다');
      ws[addr(BUDGET_DEF, 'name', target)] = { t: 's', v: '워크숍' };
      ws[addr(BUDGET_DEF, 'unitPrice', target)] = { t: 'n', v: 500_000 };
      ws[addr(BUDGET_DEF, 'factor1', target)] = { t: 'n', v: 6 };
    });
    const result = previewOf(sheets);
    expect(result.summary).toEqual({ added: 1, changed: 0, deleted: 0, unchanged: 25, errors: 0, unknown: 0 });
    const added = result.rows.find((r) => r.name === '워크숍');
    expect(added).toMatchObject({
      status: 'add',
      detailId: null,
      category: 'activity',
      subcategory: 'activity_meeting',
      unitPrice: 500_000,
      factors: [{ label: '회', value: 6, isPercent: false }],
      amount: 3_000_000,
    });
    // 축을 비워 두면 현금 기본 + 알림(비차단)
    expect(added?.axis).toBe('cash');
    expect(added?.issues.some((i) => i.kind === 'default-axis' && !i.blocking)).toBe(true);
    expect(result.blocked).toBe(false);
    expect(result.totals.total.plannedAmount).toBe(298_510_000 + 3_000_000);
  });

  it('위탁정산 수수료 행을 비우면(보이는 칸 전부) deleted 1 — 연구활동비에 다른 행이 남아 교체 대상', () => {
    const cleared = mutated(base.sheets, (copy) => {
      const sheet = sheetNamed(copy, BUDGET_DEF.name);
      const r = findRow(sheet, BUDGET_DEF, 'detailId', 'q-fee');
      for (const role of ['name', 'spec', 'unitPrice', 'factor1', 'factor2', 'factor3', 'adjustment', 'axis', 'note']) {
        setRaw(sheet, BUDGET_DEF, r, role, null);
      }
    });
    const result = previewOf(cleared);
    expect(result.summary).toEqual({ added: 0, changed: 0, deleted: 1, unchanged: 24, errors: 0, unknown: 0 });
    expect(result.deletedDetailIds).toEqual(['q-fee']);
    expect(result.deleted[0]).toMatchObject({ category: 'activity', name: '위탁정산 수수료', amount: 2_480_000 });
    expect(result.replaceCategories).toContain('activity');
    expect(result.blocked).toBe(false);
    expect(result.totals.total.plannedAmount).toBe(298_510_000 - 2_480_000);
  });

  it('간접비 유일 행을 비우면 삭제가 아니라 유지다 (IN-5 — 양식에 행이 없는 비목은 건드리지 않는다)', () => {
    const cleared = mutated(base.sheets, (copy) => {
      const sheet = sheetNamed(copy, BUDGET_DEF.name);
      const r = findRow(sheet, BUDGET_DEF, 'detailId', 'q-safety');
      for (const role of ['name', 'spec', 'unitPrice', 'adjustment', 'axis', 'note']) {
        setRaw(sheet, BUDGET_DEF, r, role, null);
      }
    });
    const result = previewOf(cleared);
    expect(result.summary.deleted).toBe(0);
    expect(result.untouchedCategories).toEqual([{ category: 'indirect', rowCount: 1 }]);
    expect(result.totals.total.plannedAmount).toBe(298_510_000);
  });
});

// ═══ (g) isPercent 인자 왕복 ═══════════════════════════════════════

describe('(g) isPercent 인자가 있는 세목 행은 왕복 후 값 그대로다 — 양식 0.28 ↔ 저장 28 (IN-4)', () => {
  // 부록 A.5 프리셋에는 isPercent 인자가 없으므로 기존 행의 isPercent 라벨을 잇는 경로로 확인한다
  const percentDetail = detail({
    id: 'q-pct',
    category: 'allowance',
    subcategory: 'default',
    name: '연구수당',
    unitPrice: 10_000_000,
    factors: [{ label: '지급률(%)', value: 28, isPercent: true }],
    amount: 2_800_000,
  });
  const existing = [...ALL_DETAILS, percentDetail];
  const { sheets, buffer } = roundtripSheets({ ...DATA, details: existing });

  it('양식 셀에는 0.28이 적히고 백분율 서식이 아니다', () => {
    const sheet = sheetNamed(sheets, BUDGET_DEF.name);
    const r = findRow(sheet, BUDGET_DEF, 'detailId', 'q-pct');
    const cell = sheet.cells[r]?.[columnOf(BUDGET_DEF, 'factor1')];
    expect(cell?.value).toBe(0.28);
    expect(cell?.percentFormat).toBeUndefined();
  });

  it('엑셀 수식도 0.28로 같은 금액 2,800,000을 낸다', () => {
    const wb = XLSX.read(buffer, { type: 'buffer', cellFormula: true });
    const ws = wb.Sheets[BUDGET_DEF.name]!;
    const sheet = sheetNamed(sheets, BUDGET_DEF.name);
    const r = findRow(sheet, BUDGET_DEF, 'detailId', 'q-pct');
    expect(new Recalc(ws, BUDGET_DEF.name).number(addr(BUDGET_DEF, 'amount', r))).toBe(2_800_000);
  });

  it('미리보기는 28(isPercent)로 되돌리고 unchanged · 금액 2,800,000', () => {
    const result = previewOf(sheets, existing);
    const row = rowOf(result, 'q-pct');
    expect(row.status).toBe('unchanged');
    expect(row.factors).toEqual([{ label: '지급률(%)', value: 28, isPercent: true }]);
    expect(row.amount).toBe(2_800_000);
    expect(result.summary).toEqual({ added: 0, changed: 0, deleted: 0, unchanged: 26, errors: 0, unknown: 0 });
    expect(result.totals.total.plannedAmount).toBe(298_510_000 + 2_800_000);
  });
});
