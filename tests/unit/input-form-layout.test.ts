// 입력 양식 좌표 맵·`_meta` 왕복·거부 규칙 (SOT §6.16 IN-1~IN-3, IN-8)
//
// 생성기와 파서가 같은 맵을 보므로(IN-1) 맵 자체의 불변식이 깨지면 둘 다 조용히 틀린다.
// 여기서 역할 중복·숨김/읽기 플래그·읽지 않는 열(IN-3)을 고정한다.

import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import {
  EMPTY_ROWS_PER_SUBCATEGORY,
  INPUT_FORM_SHEETS,
  INPUT_FORM_VERSION,
  buildMetaRows,
  checkMeta,
  columnAddress,
  columnOf,
  hiddenColumnIndexes,
  parseMeta,
} from '@/lib/input-form';
import type { FormCell, InputFormMeta, InputFormSheetDef } from '@/lib/input-form';
import type { RawCell, RawSheet } from '@/lib/import/types';

const SHEETS = Object.values(INPUT_FORM_SHEETS);

/** 생성기 출력(FormCell)을 어댑터가 읽어 온 모양(RawSheet)으로 — 왕복의 "쓰고 읽기" 절반을 흉내 낸다 */
function toRawSheet(name: string, rows: FormCell[][]): RawSheet {
  const cells: RawCell[][] = rows.map((row) =>
    row.map((cell) => ({ value: cell.value ?? null, isError: false }))
  );
  return { name, cells, merges: [] };
}

const META: InputFormMeta = {
  formVersion: INPUT_FORM_VERSION,
  projectId: 'proj-1',
  yearId: 'year-1',
  generatedAt: '2026-09-25T09:00:00.000Z',
  subcategoryCodes: ['personnel_internal', 'activity_meeting', 'default', 'indirect_hr'],
  memberIds: ['m-3', 'm-1', 'm-2'],
};

describe('좌표 맵 불변식 (IN-1)', () => {
  it('시트 3장의 이름과 숨김', () => {
    expect(INPUT_FORM_SHEETS.personnel.name).toBe('인건비');
    expect(INPUT_FORM_SHEETS.budget.name).toBe('사업비');
    expect(INPUT_FORM_SHEETS.meta.name).toBe('_meta');
    expect(SHEETS.filter((s) => s.hidden).map((s) => s.name)).toEqual(['_meta']);
    expect(INPUT_FORM_VERSION).toBe(1);
    expect(EMPTY_ROWS_PER_SUBCATEGORY).toBe(3);
  });

  it.each(SHEETS.map((s) => [s.name, s] as const))('%s: 역할 중복 0', (_name, sheet) => {
    const roles = sheet.columns.map((c) => c.role);
    expect(new Set(roles).size).toBe(roles.length);
  });

  it.each(SHEETS.map((s) => [s.name, s] as const))('%s: 헤더 행 < 데이터 시작 행', (_name, sheet) => {
    expect(sheet.headerRow).toBeGreaterThanOrEqual(1);
    expect(sheet.dataStartRow).toBeGreaterThan(sheet.headerRow);
  });

  it('숨김 열은 전부 파서가 읽는 키 열이고, 읽지 않는 열은 전부 보이는 열이다', () => {
    for (const sheet of SHEETS) {
      for (const column of sheet.columns) {
        if (column.hidden) expect(column.read, `${sheet.name}.${column.role}`).toBe(true);
        if (!column.read) expect(column.hidden, `${sheet.name}.${column.role}`).toBe(false);
      }
    }
  });

  it('인건비: 연봉·월급·산식 금액·금액은 읽지 않는다 (IN-3, PL-D7)', () => {
    const sheet = INPUT_FORM_SHEETS.personnel;
    for (const role of ['annualSalary', 'monthlySalary', 'formulaAmount', 'amount']) {
      const column = sheet.columns[columnOf(sheet, role)];
      expect(column?.read, role).toBe(false);
    }
    expect(sheet.columns[columnOf(sheet, 'formulaAmount')]?.format).toBe('formula');
    expect(sheet.columns[columnOf(sheet, 'amount')]?.format).toBe('formula');
  });

  it('인건비: 이름 매칭에 쓰일 수 있는 성명·직위는 읽지 않고, memberId·detailId는 숨겨서 읽는다', () => {
    const sheet = INPUT_FORM_SHEETS.personnel;
    expect(sheet.columns[columnOf(sheet, 'name')]?.read).toBe(false);
    expect(sheet.columns[columnOf(sheet, 'position')]?.read).toBe(false);
    expect(hiddenColumnIndexes(sheet)).toEqual([columnOf(sheet, 'memberId'), columnOf(sheet, 'detailId')]);
  });

  it('인건비 열 순서와 라벨', () => {
    expect(INPUT_FORM_SHEETS.personnel.columns.map((c) => c.label)).toEqual([
      'memberId', 'detailId', '성명', '직위', '조직원', '급여 기준', '연봉', '월급', '세목',
      '참여율(%)', '참여개월', '현금/현물', '조정액', '산식 금액', '금액', '비고',
    ]);
  });

  it('사업비: 세목 코드·detailId는 숨김, 금액은 수식이라 읽지 않는다 (IN-4)', () => {
    const sheet = INPUT_FORM_SHEETS.budget;
    expect(hiddenColumnIndexes(sheet)).toEqual([columnOf(sheet, 'subcategory'), columnOf(sheet, 'detailId')]);
    expect(sheet.columns[columnOf(sheet, 'amount')]?.read).toBe(false);
    expect(sheet.columns.map((c) => c.label)).toEqual([
      'subcategory', 'detailId', '비목', '세목', '품명', '규격', '단가', '인자1', '인자2', '인자3',
      '조정액', '현금/현물', '금액', '비고',
    ]);
  });

  it('참여율은 백분율 서식이 아니다 — X-7·D-22 함정을 피한다', () => {
    const sheet = INPUT_FORM_SHEETS.personnel;
    expect(sheet.columns[columnOf(sheet, 'participation')]?.format).toBe('decimal');
    expect(SHEETS.flatMap((s) => s.columns).some((c) => c.format === 'percent')).toBe(false);
  });
});

describe('columnOf · columnAddress', () => {
  it('역할 → 0-based 인덱스, 시트 키로도 정의 객체로도 찾는다', () => {
    expect(columnOf('personnel', 'memberId')).toBe(0);
    expect(columnOf(INPUT_FORM_SHEETS.personnel, 'participation')).toBe(9);
    expect(columnOf('meta', 'value')).toBe(1);
  });

  it('없는 역할은 throw한다 — 좌표 맵 오타를 빈 열로 삼키지 않는다', () => {
    expect(() => columnOf('personnel', 'nope')).toThrow(/역할 'nope'/);
    expect(() => columnOf('budget', 'monthlySalary')).toThrow();
  });

  it('역할이 둘이면 throw한다', () => {
    const broken: InputFormSheetDef = {
      ...INPUT_FORM_SHEETS.budget,
      columns: [...INPUT_FORM_SHEETS.budget.columns, { role: 'name', label: '품명2', hidden: false, read: true }],
    };
    expect(() => columnOf(broken, 'name')).toThrow(/2개/);
  });

  it('A1 주소 — 수식이 같은 행의 연봉·참여율·개월 열을 가리킬 수 있다 (IN-7)', () => {
    expect(columnAddress('personnel', 'memberId', 1)).toBe('A1');
    expect(columnAddress('personnel', 'annualSalary', 7)).toBe('G7');
    expect(columnAddress('personnel', 'participation', 7)).toBe('J7');
    expect(columnAddress('personnel', 'months', 7)).toBe('K7');
    expect(columnAddress('personnel', 'note', 30)).toBe('P30');
  });
});

describe('_meta 왕복 (IN-2)', () => {
  it('buildMetaRows → parseMeta 등가 — 세목·인력 목록 순서 보존', () => {
    const rows = buildMetaRows(META);
    expect(rows[INPUT_FORM_SHEETS.meta.headerRow - 1]?.map((c) => c.value)).toEqual(['키', '값']);
    const parsed = parseMeta(toRawSheet('_meta', rows));
    expect(parsed).toEqual(META);
  });

  it('목록이 비어도 왕복한다', () => {
    const empty: InputFormMeta = { ...META, subcategoryCodes: [], memberIds: [] };
    expect(parseMeta(toRawSheet('_meta', buildMetaRows(empty)))).toEqual(empty);
  });

  it('고정 키 4개가 데이터 시작 행부터 순서대로 놓인다', () => {
    const rows = buildMetaRows(META);
    const keyCol = columnOf('meta', 'key');
    const start = INPUT_FORM_SHEETS.meta.dataStartRow - 1;
    expect(rows.slice(start, start + 4).map((r) => r[keyCol]?.value)).toEqual([
      'formVersion', 'projectId', 'yearId', 'generatedAt',
    ]);
    expect(rows[start]?.[columnOf('meta', 'value')]?.value).toBe(INPUT_FORM_VERSION);
  });

  it('숫자 셀로 돌아온 formVersion을 정수로 읽는다 (엑셀은 숫자를 숫자로 저장한다)', () => {
    const rows = buildMetaRows(META);
    const raw = toRawSheet('_meta', rows);
    const valueCol = columnOf('meta', 'value');
    const versionRow = raw.cells[INPUT_FORM_SHEETS.meta.dataStartRow - 1];
    expect(typeof versionRow?.[valueCol]?.value).toBe('number');
    expect(parseMeta(raw)?.formVersion).toBe(INPUT_FORM_VERSION);
  });

  it('필수 키가 빠지면 null — 빈 시트·헤더만 있는 시트·projectId 없는 시트', () => {
    expect(parseMeta({ name: '_meta', cells: [], merges: [] })).toBeNull();
    expect(parseMeta(toRawSheet('_meta', [[{ value: '키' }, { value: '값' }]]))).toBeNull();
    const withoutProject = buildMetaRows(META).filter((r) => r[0]?.value !== 'projectId');
    expect(parseMeta(toRawSheet('_meta', withoutProject))).toBeNull();
  });

  it('모르는 키는 무시한다', () => {
    const rows = [...buildMetaRows(META), [{ value: 'somethingElse' }, { value: 'x' }]];
    expect(parseMeta(toRawSheet('_meta', rows))).toEqual(META);
  });
});

describe('checkMeta 거부 3종 (IN-2)', () => {
  const expected = { projectId: 'proj-1', formVersion: INPUT_FORM_VERSION };

  it('정상이면 null', () => {
    expect(checkMeta(META, expected)).toBeNull();
  });

  it('_meta 없음', () => {
    const r = checkMeta(null, expected);
    expect(r?.kind).toBe('no-meta');
    expect(r?.message).toBe(
      '이 파일에는 입력 양식 정보가 없습니다 — [입력 양식 내려받기]로 받은 파일만 올릴 수 있습니다'
    );
  });

  it('과제 불일치', () => {
    const r = checkMeta({ ...META, projectId: 'proj-other' }, expected);
    expect(r?.kind).toBe('project-mismatch');
    expect(r?.message).toBe('이 과제의 양식이 아닙니다');
  });

  it('버전 불일치', () => {
    const r = checkMeta({ ...META, formVersion: INPUT_FORM_VERSION + 1 }, expected);
    expect(r?.kind).toBe('version-mismatch');
    expect(r?.message).toBe('양식 버전이 다릅니다 — 다시 내려받으세요');
  });

  it('과제도 버전도 다르면 과제 불일치가 먼저다 — 남의 과제 파일은 버전과 무관하게 남의 것이다', () => {
    const r = checkMeta({ ...META, projectId: 'x', formVersion: 99 }, expected);
    expect(r?.kind).toBe('project-mismatch');
  });
});

describe('경계 (IN-8)', () => {
  it('lib/input-form/**은 xlsx를 import하지 않는다', () => {
    const dir = path.resolve(__dirname, '../../lib/input-form');
    const files = fs.readdirSync(dir).filter((f) => f.endsWith('.ts'));
    expect(files.length).toBeGreaterThan(0);
    for (const file of files) {
      const source = fs.readFileSync(path.join(dir, file), 'utf8');
      expect(source, file).not.toMatch(/from\s+['"]xlsx['"]/);
      expect(source, file).not.toMatch(/require\(\s*['"]xlsx['"]\s*\)/);
    }
  });
});
