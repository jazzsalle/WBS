// 목표 양식 생성기·작성안내 (SOT §6.17 GF-1·GF-3·GF-4·GF-8, 부록 F-8·F-9)
//
// 좌표는 전부 `layout.ts`의 `goalColumnOf`·`goalYearColumns`로 얻는다 — 테스트가 열 번호를 박아 두면 맵이 바뀔 때
// 거짓 경보를 낸다. 여기서 확인하는 것은 **어느 값이 어느 칸에, 어떤 수식·드롭다운으로** 들어갔는가다.

import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import {
  GOAL_MEMBER_SEPARATOR,
  GOAL_TOTAL_LABEL,
  buildGoalForm,
  goalFormFileName,
} from '@/lib/goal-form/build';
import type { GoalFormData } from '@/lib/goal-form/build';
import { GOAL_FORM_TITLE, GOAL_GUIDE_ROW_LABELS, goalUnreadColumnsText } from '@/lib/goal-form/guide';
import {
  GOAL_EMPTY_INPUT_ROWS,
  GOAL_FORM_VERSION,
  GOAL_TOTAL_MARKER,
  goalColumnAddress,
  goalColumnOf,
  goalEnumLabels,
  goalHiddenColumns,
  goalSheetsFor,
  goalYearColumns,
  orderedGoalSheets,
} from '@/lib/goal-form/layout';
import type { GoalSheetDef } from '@/lib/goal-form/layout';
import { checkGoalMeta, parseGoalMeta } from '@/lib/goal-form/meta';
import { columnLetter } from '@/lib/export/layouts';
import type { FormCell, FormSheet } from '@/lib/input-form/types';
import type { RawCell, RawSheet } from '@/lib/import/types';
import type { Deliverable, DeliverableAchievement, TechTarget, TechTargetRecord } from '@/types';

// ─── 픽스처 ─────────────────────────────────────────────────

const GENERATED_AT = '2026-09-29T09:30:00.000Z';

const BASE = {
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
  createdBy: null,
  updatedBy: null,
};

function achievement(partial: Partial<DeliverableAchievement> & Pick<DeliverableAchievement, 'id'>): DeliverableAchievement {
  return {
    version: 1,
    title: '',
    date: '2026-05-01',
    yearId: null,
    orgId: null,
    memberIds: [],
    evidenceUrl: '',
    note: '',
    ...partial,
  };
}

function deliverable(partial: Partial<Deliverable> & Pick<Deliverable, 'id' | 'name' | 'order'>): Deliverable {
  return {
    ...BASE,
    version: 1,
    projectId: 'proj-1',
    type: 'paper_sci',
    unit: '건',
    weight: 0,
    targetTotal: 0,
    targetByYear: {},
    achievements: [],
    orgId: null,
    evidenceMethod: '',
    note: '',
    ...partial,
  };
}

function record(partial: Partial<TechTargetRecord> & Pick<TechTargetRecord, 'id'>): TechTargetRecord {
  return {
    version: 1,
    value: 0,
    date: '2026-06-01',
    yearId: null,
    method: 'self',
    evaluator: '',
    evidenceUrl: '',
    note: '',
    ...partial,
  };
}

function techTarget(partial: Partial<TechTarget> & Pick<TechTarget, 'id' | 'name' | 'order'>): TechTarget {
  return {
    ...BASE,
    version: 1,
    projectId: 'proj-1',
    group: '',
    unit: '%',
    direction: 'higher_better',
    weight: 0,
    targetValue: 0,
    targetByYear: {},
    baselineDomestic: null,
    worldBest: null,
    worldBestHolder: '',
    measureMethod: 'self',
    measureDescription: '',
    standardBasis: '',
    basisRationale: '',
    evaluationEnvironment: '',
    note: '',
    records: [],
    orgId: null,
    ...partial,
  };
}

// 연차는 순서를 뒤섞어 넘긴다 — 생성기가 order로 정렬해야 한다. y2는 이름이 비어 `2차년도`, y3은 y1과 동명
const DATA: GoalFormData = {
  project: { id: 'proj-1', name: '스마트 건설: 플랫폼' },
  years: [
    { id: 'y3', name: '1차년도', order: 2 },
    { id: 'y1', name: '1차년도', order: 0 },
    { id: 'y2', name: '', order: 1 },
  ],
  orgs: [
    { id: 'o1', name: '가나대학교' },
    { id: 'o2', name: '다라연구원' },
    { id: 'o3', name: '가나대학교' },
  ],
  members: [
    { id: 'm1', name: '홍길동' },
    { id: 'm2', name: '김철수' },
    { id: 'm3', name: '홍길동' }, // 비활성이어도 싣는다 — 동명이라 `홍길동 (2)`
  ],
  // order 역순으로 넘긴다
  deliverables: [
    deliverable({
      id: 'd2',
      name: '국내 특허 출원',
      order: 1,
      type: 'patent_dom_apply',
      weight: 40,
      targetTotal: 3,
      targetByYear: { y1: 1, y3: 2 },
      version: 7,
      achievements: [
        achievement({
          id: 'a3',
          title: '특허 A',
          date: '2026-07-01',
          yearId: 'y2',
          orgId: 'o3',
          memberIds: ['m3', 'm2'],
          version: 2,
        }),
      ],
    }),
    deliverable({
      id: 'd1',
      name: 'SCI 논문',
      order: 0,
      type: 'paper_sci',
      unit: '편',
      weight: 60.5,
      targetTotal: 4,
      // y2 키 없음 → 빈 칸, y3 = 0 → 0 (D-5)
      targetByYear: { y1: 2, y3: 0 },
      orgId: 'o1',
      evidenceMethod: 'SCI 게재 증빙',
      note: '비고1',
      version: 3,
      achievements: [
        achievement({ id: 'a1', title: '논문 1', yearId: 'y1', orgId: 'o1', memberIds: ['m1'], version: 4 }),
        achievement({ id: 'a2', title: '논문 2', memberIds: [], evidenceUrl: 'https://doi.org/x', version: 5 }),
      ],
    }),
  ],
  techTargets: [
    techTarget({
      id: 't1',
      name: '인식 정확도',
      order: 0,
      group: '성능',
      direction: 'higher_better',
      weight: 70,
      targetValue: 95,
      targetByYear: { y1: 90, y2: 0 },
      baselineDomestic: 85,
      worldBest: 97.5,
      worldBestHolder: '미국 A사',
      measureMethod: 'certified_lab',
      measureDescription: '시험셋 1만 장',
      standardBasis: 'ISO 1234',
      basisRationale: '선행 연구',
      evaluationEnvironment: '실내',
      orgId: 'o2',
      note: '[원문] 최종 목표: ≥95',
      version: 9,
      records: [record({ id: 'r1', value: 91.2, yearId: 'y1', method: 'expert_review', evaluator: 'KTL', version: 2 })],
    }),
    techTarget({
      id: 't2',
      name: '응답 시간',
      order: 1,
      direction: 'lower_better',
      unit: 'ms',
      weight: 30,
      targetValue: 100,
      targetByYear: { y3: 100 },
      version: 1,
    }),
  ],
  generatedAt: GENERATED_AT,
};

const WORKBOOK = buildGoalForm(DATA);
const YEAR_LABELS = ['1차년도', '2차년도', '1차년도 (2)'];
const SHEETS = goalSheetsFor(YEAR_LABELS);

function sheetNamed(name: string): FormSheet {
  const sheet = WORKBOOK.sheets.find((s) => s.name === name);
  if (!sheet) throw new Error(`시트 ${name} 없음`);
  return sheet;
}

function toRawSheet(sheet: FormSheet): RawSheet {
  const cells: RawCell[][] = sheet.rows.map((row) => row.map((cell) => ({ value: cell.value ?? null, isError: false })));
  return { name: sheet.name, cells, merges: [] };
}

/** 1-based 행 · 역할 → 셀 */
function cellAt<R extends string>(sheet: FormSheet, def: GoalSheetDef<R>, row1based: number, role: R): FormCell {
  return sheet.rows[row1based - 1]?.[goalColumnOf(def, role)] ?? {};
}

function yearCells(sheet: FormSheet, def: GoalSheetDef, row1based: number): FormCell[] {
  return goalYearColumns(def).map((c) => sheet.rows[row1based - 1]?.[c] ?? {});
}

const D_SHEET = sheetNamed(SHEETS.deliverables.name);
const A_SHEET = sheetNamed(SHEETS.achievements.name);
const T_SHEET = sheetNamed(SHEETS.techTargets.name);
const R_SHEET = sheetNamed(SHEETS.records.name);
const LISTS_SHEET = sheetNamed(SHEETS.lists.name);
const META_SHEET = sheetNamed(SHEETS.meta.name);
const GUIDE_SHEET = sheetNamed(SHEETS.guide.name);

const FIRST = SHEETS.deliverables.dataStartRow; // 모든 데이터 시트가 같다

// ─── 시트 목록 ──────────────────────────────────────────────

describe('시트 목록·순서 (GF-1, S-7)', () => {
  it('GOAL_SHEET_ORDER 순서, _lists·_meta만 숨김', () => {
    expect(WORKBOOK.sheets.map((s) => s.name)).toEqual(orderedGoalSheets(SHEETS).map((s) => s.name));
    expect(WORKBOOK.sheets.map((s) => s.name)).toEqual([
      '작성안내',
      '성과목표',
      '성과실적',
      '기술목표',
      '측정이력',
      '_lists',
      '_meta',
    ]);
    expect(WORKBOOK.sheets.filter((s) => s.hidden).map((s) => s.name)).toEqual(['_lists', '_meta']);
    expect(GUIDE_SHEET.kind).toBe('guide');
  });

  it('파일명: 과제명(금지 문자 치환)·생성일', () => {
    expect(WORKBOOK.fileName).toBe('목표양식_스마트 건설_ 플랫폼_20260929.xlsx');
    expect(goalFormFileName({ name: '  ' }, '2026-01-02')).toBe('목표양식_과제_20260102.xlsx');
    expect(() => goalFormFileName({ name: 'a' }, '어제')).toThrow();
  });

  it('같은 입력이면 같은 출력(시각을 읽지 않는다)', () => {
    expect(buildGoalForm(DATA)).toEqual(WORKBOOK);
  });

  it('데이터 시트 서식 힌트: 헤더·숨김 열·열 힌트·행 역할', () => {
    for (const def of [SHEETS.deliverables, SHEETS.achievements, SHEETS.techTargets, SHEETS.records] as GoalSheetDef[]) {
      const sheet = sheetNamed(def.name);
      expect(sheet.kind).toBe('data');
      expect(sheet.headerRow).toBe(def.headerRow);
      expect(sheet.dataStartRow).toBe(def.dataStartRow);
      expect(sheet.hiddenColumns).toEqual(goalHiddenColumns(def));
      expect(sheet.columnHints).toHaveLength(def.columns.length);
      expect(sheet.rowRoles).toHaveLength(sheet.rows.length);
      expect(sheet.rows[def.headerRow - 1]?.map((c) => c.value)).toEqual(def.columns.map((c) => c.label));
      // 키 열(F-3)은 보이는 read:false 열뿐 — 실적 지표명·측정 평가항목은 읽는 열이라 키 열이 아니다(GF-10)
      const keyRoles = def.columns.filter((_, i) => sheet.columnHints?.[i]?.key).map((c) => c.role);
      expect(keyRoles).toEqual(def.key === 'deliverables' ? ['yearTotal'] : []);
    }
  });

  it('백분율 서식 0건(F-6)', () => {
    const formats = WORKBOOK.sheets.flatMap((s) => (s.columnHints ?? []).map((h) => h.format as string));
    expect(formats.length).toBeGreaterThan(0);
    expect(formats).not.toContain('percent');
  });

  it('_lists·_meta는 서식 힌트 없는 숨김 시트', () => {
    for (const sheet of [LISTS_SHEET, META_SHEET]) {
      expect(sheet.columnHints).toBeUndefined();
      expect(sheet.validations).toBeUndefined();
      expect(sheet.kind).toBeUndefined();
    }
  });
});

// ─── 행 채우기 ──────────────────────────────────────────────

describe('성과목표 시트', () => {
  const def = SHEETS.deliverables;

  it('order 순, 유형은 한글 라벨, 기관은 동명 구분 라벨', () => {
    expect(cellAt(D_SHEET, def, FIRST, 'deliverableId').value).toBe('d1');
    expect(cellAt(D_SHEET, def, FIRST + 1, 'deliverableId').value).toBe('d2');
    expect(cellAt(D_SHEET, def, FIRST, 'type').value).toBe('SCI(E) 논문');
    expect(cellAt(D_SHEET, def, FIRST + 1, 'type').value).toBe('국내 특허 출원');
    expect(cellAt(D_SHEET, def, FIRST, 'name').value).toBe('SCI 논문');
    expect(cellAt(D_SHEET, def, FIRST, 'unit').value).toBe('편');
    expect(cellAt(D_SHEET, def, FIRST, 'weight').value).toBe(60.5);
    expect(cellAt(D_SHEET, def, FIRST, 'targetTotal').value).toBe(4);
    expect(cellAt(D_SHEET, def, FIRST, 'org').value).toBe('가나대학교');
    expect(cellAt(D_SHEET, def, FIRST + 1, 'org').value).toBeNull();
    expect(cellAt(D_SHEET, def, FIRST, 'evidenceMethod').value).toBe('SCI 게재 증빙');
    expect(cellAt(D_SHEET, def, FIRST, 'note').value).toBe('비고1');
  });

  it('연차 열 = 연차 order 순, 헤더 = 동명 구분 라벨', () => {
    expect(goalYearColumns(def).map((c) => D_SHEET.rows[def.headerRow - 1]?.[c]?.value)).toEqual(YEAR_LABELS);
  });

  it('연차 목표: 키 없음 = 빈 칸, 0 = 0 (D-5)', () => {
    // d1: { y1: 2, y3: 0 } — 열 순서 y1, y2, y3
    expect(yearCells(D_SHEET, def, FIRST).map((c) => c.value)).toEqual([2, null, 0]);
    // d2: { y1: 1, y3: 2 }
    expect(yearCells(D_SHEET, def, FIRST + 1).map((c) => c.value)).toEqual([1, null, 2]);
  });

  it('연차 합계 열은 행마다 =SUM(연차 열) 수식, 캐시값 없음(GF-8)', () => {
    const years = goalYearColumns(def);
    const first = columnLetter(years[0] as number);
    const last = columnLetter(years[years.length - 1] as number);
    const totalRow = D_SHEET.rows.length;
    for (let row = FIRST; row < totalRow; row += 1) {
      const cell = cellAt(D_SHEET, def, row, 'yearTotal');
      expect(cell).toEqual({ formula: `SUM(${first}${row}:${last}${row})` });
    }
  });

  it('빈 입력 행 20개 뒤 합계 행: #total 마커 + 가중치 SUM', () => {
    const dataRows = 2 + GOAL_EMPTY_INPUT_ROWS;
    const totalRow = FIRST + dataRows;
    expect(D_SHEET.rows).toHaveLength(totalRow);
    for (let row = FIRST + 2; row < totalRow; row += 1) {
      expect(cellAt(D_SHEET, def, row, 'deliverableId').value ?? null).toBeNull();
      expect(cellAt(D_SHEET, def, row, 'name').value ?? null).toBeNull();
      expect(D_SHEET.rowRoles?.[row - 1]).toBe('data');
    }
    expect(D_SHEET.rows[totalRow - 1]?.[0]).toEqual({ value: GOAL_TOTAL_MARKER });
    expect(D_SHEET.rowRoles?.[totalRow - 1]).toBe('total');
    expect(cellAt(D_SHEET, def, totalRow, 'name').value).toBe(GOAL_TOTAL_LABEL);
    const w = goalColumnAddress(def, 'weight', FIRST);
    const wLast = goalColumnAddress(def, 'weight', totalRow - 1);
    expect(cellAt(D_SHEET, def, totalRow, 'weight')).toEqual({ formula: `SUM(${w}:${wLast})` });
    // 합계 행에는 연차 합계 수식이 없다
    expect(cellAt(D_SHEET, def, totalRow, 'yearTotal').formula).toBeUndefined();
  });

  it('헤더 행 역할', () => {
    expect(D_SHEET.rowRoles?.slice(0, FIRST - 1).every((r) => r === 'header')).toBe(true);
  });
});

describe('성과실적 시트', () => {
  const def = SHEETS.achievements;

  it('지표 order 순 → 지표 안 배열 순, 숨김 부모 id·지표명', () => {
    const ids = [FIRST, FIRST + 1, FIRST + 2].map((r) => cellAt(A_SHEET, def, r, 'achievementId').value);
    expect(ids).toEqual(['a1', 'a2', 'a3']);
    expect(cellAt(A_SHEET, def, FIRST, 'deliverableId').value).toBe('d1');
    expect(cellAt(A_SHEET, def, FIRST + 2, 'deliverableId').value).toBe('d2');
    expect(cellAt(A_SHEET, def, FIRST, 'deliverableName').value).toBe('SCI 논문');
    expect(cellAt(A_SHEET, def, FIRST + 2, 'deliverableName').value).toBe('국내 특허 출원');
  });

  it('연차·기관·관여자 라벨(동명 구분), 관여자는 `;`로 잇는다', () => {
    expect(cellAt(A_SHEET, def, FIRST, 'year').value).toBe('1차년도');
    expect(cellAt(A_SHEET, def, FIRST, 'org').value).toBe('가나대학교');
    expect(cellAt(A_SHEET, def, FIRST, 'members').value).toBe('홍길동');
    expect(cellAt(A_SHEET, def, FIRST + 1, 'year').value).toBeNull();
    expect(cellAt(A_SHEET, def, FIRST + 1, 'members').value).toBe('');
    expect(cellAt(A_SHEET, def, FIRST + 1, 'evidenceUrl').value).toBe('https://doi.org/x');
    expect(cellAt(A_SHEET, def, FIRST + 2, 'year').value).toBe('2차년도');
    expect(cellAt(A_SHEET, def, FIRST + 2, 'org').value).toBe('가나대학교 (2)');
    expect(GOAL_MEMBER_SEPARATOR).toBe(';');
    expect(cellAt(A_SHEET, def, FIRST + 2, 'members').value).toBe('홍길동 (2);김철수');
    expect(cellAt(A_SHEET, def, FIRST + 2, 'date').value).toBe('2026-07-01');
  });

  it('빈 입력 행 20개 + #total 합계 행(수식 없음)', () => {
    const totalRow = FIRST + 3 + GOAL_EMPTY_INPUT_ROWS;
    expect(A_SHEET.rows).toHaveLength(totalRow);
    expect(A_SHEET.rows[totalRow - 1]?.[0]).toEqual({ value: GOAL_TOTAL_MARKER });
    expect(A_SHEET.rowRoles?.[totalRow - 1]).toBe('total');
    expect(A_SHEET.rows[totalRow - 1]?.slice(1).every((c) => c.value === undefined && c.formula === undefined)).toBe(true);
  });
});

describe('기술목표 시트', () => {
  const def = SHEETS.techTargets;

  it('필드와 라벨', () => {
    expect(cellAt(T_SHEET, def, FIRST, 'techTargetId').value).toBe('t1');
    expect(cellAt(T_SHEET, def, FIRST, 'group').value).toBe('성능');
    expect(cellAt(T_SHEET, def, FIRST, 'direction').value).toBe('높을수록 우수');
    expect(cellAt(T_SHEET, def, FIRST + 1, 'direction').value).toBe('낮을수록 우수');
    expect(cellAt(T_SHEET, def, FIRST, 'measureMethod').value).toBe('공인시험');
    expect(cellAt(T_SHEET, def, FIRST, 'targetValue').value).toBe(95);
    expect(cellAt(T_SHEET, def, FIRST, 'baselineDomestic').value).toBe(85);
    expect(cellAt(T_SHEET, def, FIRST + 1, 'baselineDomestic').value).toBeNull();
    expect(cellAt(T_SHEET, def, FIRST, 'worldBest').value).toBe(97.5);
    expect(cellAt(T_SHEET, def, FIRST, 'worldBestHolder').value).toBe('미국 A사');
    expect(cellAt(T_SHEET, def, FIRST, 'standardBasis').value).toBe('ISO 1234');
    expect(cellAt(T_SHEET, def, FIRST, 'basisRationale').value).toBe('선행 연구');
    expect(cellAt(T_SHEET, def, FIRST, 'evaluationEnvironment').value).toBe('실내');
    expect(cellAt(T_SHEET, def, FIRST, 'org').value).toBe('다라연구원');
    expect(cellAt(T_SHEET, def, FIRST, 'note').value).toBe('[원문] 최종 목표: ≥95');
  });

  it('연차 목표: 키 없음 = 빈 칸, 0 = 0', () => {
    expect(yearCells(T_SHEET, def, FIRST).map((c) => c.value)).toEqual([90, 0, null]);
    expect(yearCells(T_SHEET, def, FIRST + 1).map((c) => c.value)).toEqual([null, null, 100]);
  });

  it('합계 행: #total + 비중 SUM(첫 데이터 행 ~ 합계 직전)', () => {
    const totalRow = FIRST + 2 + GOAL_EMPTY_INPUT_ROWS;
    expect(T_SHEET.rows).toHaveLength(totalRow);
    expect(T_SHEET.rows[totalRow - 1]?.[0]).toEqual({ value: GOAL_TOTAL_MARKER });
    const w = goalColumnAddress(def, 'weight', FIRST);
    const wLast = goalColumnAddress(def, 'weight', totalRow - 1);
    expect(cellAt(T_SHEET, def, totalRow, 'weight')).toEqual({ formula: `SUM(${w}:${wLast})` });
    expect(cellAt(T_SHEET, def, totalRow, 'name').value).toBe(GOAL_TOTAL_LABEL);
  });
});

describe('측정이력 시트', () => {
  const def = SHEETS.records;

  it('필드와 라벨', () => {
    expect(cellAt(R_SHEET, def, FIRST, 'techTargetId').value).toBe('t1');
    expect(cellAt(R_SHEET, def, FIRST, 'recordId').value).toBe('r1');
    expect(cellAt(R_SHEET, def, FIRST, 'techTargetName').value).toBe('인식 정확도');
    expect(cellAt(R_SHEET, def, FIRST, 'value').value).toBe(91.2);
    expect(cellAt(R_SHEET, def, FIRST, 'year').value).toBe('1차년도');
    expect(cellAt(R_SHEET, def, FIRST, 'method').value).toBe('전문가평가');
    expect(cellAt(R_SHEET, def, FIRST, 'evaluator').value).toBe('KTL');
    const totalRow = FIRST + 1 + GOAL_EMPTY_INPUT_ROWS;
    expect(R_SHEET.rows).toHaveLength(totalRow);
    expect(R_SHEET.rows[totalRow - 1]?.[0]).toEqual({ value: GOAL_TOTAL_MARKER });
  });
});

describe('목록 밖 참조는 던진다 (빈 칸으로 흘리면 다시 올릴 때 지워진다)', () => {
  it.each([
    ['기관', { ...DATA, orgs: DATA.orgs.slice(1) }],
    ['인력', { ...DATA, members: DATA.members.slice(0, 2) }],
    ['연차', { ...DATA, years: DATA.years.filter((y) => y.id !== 'y2') }],
  ] as const)('%s', (_label, data) => {
    expect(() => buildGoalForm(data)).toThrow();
  });

  it('같은 실적 id가 두 번 실리면 던진다', () => {
    const d = DATA.deliverables[1] as Deliverable;
    const dup = { ...d, achievements: [...d.achievements, ...d.achievements] };
    expect(() => buildGoalForm({ ...DATA, deliverables: [DATA.deliverables[0] as Deliverable, dup] })).toThrow();
  });
});

// ─── _lists·드롭다운 (F-9) ──────────────────────────────────

describe('_lists 시트', () => {
  const def = SHEETS.lists;
  const column = (role: 'deliverableType' | 'direction' | 'measureMethod' | 'year' | 'org' | 'member') => {
    const c = goalColumnOf(def, role);
    return LISTS_SHEET.rows
      .slice(def.dataStartRow - 1)
      .map((row) => row[c]?.value)
      .filter((v) => v !== null && v !== undefined);
  };

  it('A~F열 = 유형·방향·측정방법·연차·기관·관여자', () => {
    expect(LISTS_SHEET.rows[def.headerRow - 1]?.map((c) => c.value)).toEqual([
      '유형',
      '방향',
      '측정방법',
      '연차',
      '기관',
      '관여자',
    ]);
    expect(column('deliverableType')).toEqual(goalEnumLabels('deliverableType'));
    expect(column('direction')).toEqual(goalEnumLabels('direction'));
    expect(column('measureMethod')).toEqual(goalEnumLabels('measureMethod'));
    expect(column('year')).toEqual(YEAR_LABELS);
    expect(column('org')).toEqual(['가나대학교', '다라연구원', '가나대학교 (2)']);
    expect(column('member')).toEqual(['홍길동', '김철수', '홍길동 (2)']);
  });
});

describe('드롭다운', () => {
  const byColumn = (sheet: FormSheet) => new Map((sheet.validations ?? []).map((v) => [v.column, v]));

  it('성과목표: 유형·책임기관 → _lists, stop', () => {
    const def = SHEETS.deliverables;
    const v = byColumn(D_SHEET);
    expect([...v.keys()].sort((a, b) => a - b)).toEqual(
      [goalColumnOf(def, 'type'), goalColumnOf(def, 'org')].sort((a, b) => a - b)
    );
    const type = v.get(goalColumnOf(def, 'type'));
    expect(type).toEqual({
      column: goalColumnOf(def, 'type'),
      values: [],
      listRange: { sheet: '_lists', range: `$A$2:$A$${1 + goalEnumLabels('deliverableType').length}` },
      errorStyle: 'stop',
    });
    expect(v.get(goalColumnOf(def, 'org'))?.listRange).toEqual({ sheet: '_lists', range: '$E$2:$E$4' });
  });

  it('성과실적: 지표명 → 성과목표 이름 열(빈 입력 행 포함, 합계 제외) warning, 관여자 warning, 나머지 stop', () => {
    const def = SHEETS.achievements;
    const v = byColumn(A_SHEET);
    const lastDeliverableRow = D_SHEET.rows.length - 1;
    const nameCol = columnLetter(goalColumnOf(SHEETS.deliverables, 'name'));
    expect(v.get(goalColumnOf(def, 'deliverableName'))).toEqual({
      column: goalColumnOf(def, 'deliverableName'),
      values: [],
      listRange: { sheet: '성과목표', range: `$${nameCol}$${FIRST}:$${nameCol}$${lastDeliverableRow}` },
      errorStyle: 'warning',
    });
    expect(v.get(goalColumnOf(def, 'members'))).toMatchObject({
      listRange: { sheet: '_lists', range: '$F$2:$F$4' },
      errorStyle: 'warning',
    });
    expect(v.get(goalColumnOf(def, 'year'))).toMatchObject({
      listRange: { sheet: '_lists', range: '$D$2:$D$4' },
      errorStyle: 'stop',
    });
    expect(v.get(goalColumnOf(def, 'org'))?.errorStyle).toBe('stop');
    expect(v.size).toBe(4);
  });

  it('기술목표: 방향·측정방법·책임기관 stop', () => {
    const def = SHEETS.techTargets;
    const v = byColumn(T_SHEET);
    expect(v.size).toBe(3);
    expect(v.get(goalColumnOf(def, 'direction'))).toMatchObject({
      listRange: { sheet: '_lists', range: '$B$2:$B$4' },
      errorStyle: 'stop',
    });
    expect(v.get(goalColumnOf(def, 'measureMethod'))?.listRange).toEqual({
      sheet: '_lists',
      range: `$C$2:$C$${1 + goalEnumLabels('measureMethod').length}`,
    });
  });

  it('측정이력: 평가항목 → 기술목표 이름 열 warning, 방법·연차 stop', () => {
    const def = SHEETS.records;
    const v = byColumn(R_SHEET);
    const lastTechRow = T_SHEET.rows.length - 1;
    const nameCol = columnLetter(goalColumnOf(SHEETS.techTargets, 'name'));
    expect(v.get(goalColumnOf(def, 'techTargetName'))).toMatchObject({
      listRange: { sheet: '기술목표', range: `$${nameCol}$${FIRST}:$${nameCol}$${lastTechRow}` },
      errorStyle: 'warning',
    });
    expect(v.get(goalColumnOf(def, 'method'))?.errorStyle).toBe('stop');
    expect(v.get(goalColumnOf(def, 'year'))?.errorStyle).toBe('stop');
    expect(v.size).toBe(3);
  });

  it('범위 참조만 쓴다 — 인라인 목록 0건', () => {
    for (const sheet of WORKBOOK.sheets) for (const v of sheet.validations ?? []) expect(v.values).toEqual([]);
  });

  it('목록이 비어도 한 칸은 가리킨다', () => {
    const wb = buildGoalForm({
      ...DATA,
      orgs: [],
      members: [],
      deliverables: [],
      techTargets: [],
    });
    const sheet = wb.sheets.find((s) => s.name === '성과목표') as FormSheet;
    const org = sheet.validations?.find((v) => v.column === goalColumnOf(SHEETS.deliverables, 'org'));
    expect(org?.listRange).toEqual({ sheet: '_lists', range: '$E$2:$E$2' });
  });
});

// ─── _meta 왕복 ─────────────────────────────────────────────

describe('_meta', () => {
  it('parseGoalMeta로 다시 읽으면 같은 값, checkGoalMeta 통과', () => {
    const parsed = parseGoalMeta(toRawSheet(META_SHEET));
    expect(parsed.form).toBe('goal');
    expect(parsed.formVersion).toBe(GOAL_FORM_VERSION);
    const check = checkGoalMeta(parsed, { projectId: 'proj-1' });
    expect(check.ok).toBe(true);
    if (!check.ok) return;
    expect(check.meta).toEqual({
      formVersion: GOAL_FORM_VERSION,
      projectId: 'proj-1',
      generatedAt: GENERATED_AT,
      years: [
        { id: 'y1', label: '1차년도' },
        { id: 'y2', label: '2차년도' },
        { id: 'y3', label: '1차년도 (2)' },
      ],
      orgs: [
        { id: 'o1', label: '가나대학교' },
        { id: 'o2', label: '다라연구원' },
        { id: 'o3', label: '가나대학교 (2)' },
      ],
      members: [
        { id: 'm1', label: '홍길동' },
        { id: 'm2', label: '김철수' },
        { id: 'm3', label: '홍길동 (2)' },
      ],
      deliverables: { d1: 3, d2: 7 },
      achievements: { a1: 4, a2: 5, a3: 2 },
      techTargets: { t1: 9, t2: 1 },
      records: { r1: 2 },
    });
  });
});

// ─── 작성안내 (F-8) ─────────────────────────────────────────

describe('작성안내', () => {
  it('F-8 격자: 제목·부제·빈 줄·5행 표', () => {
    expect(GUIDE_SHEET.rows[0]?.[0]?.value).toBe(`스마트 건설: 플랫폼 — ${GOAL_FORM_TITLE}`);
    expect(GUIDE_SHEET.rows[1]?.[0]?.value).toBe(`생성 ${GENERATED_AT} · 1차년도 · 2차년도 · 1차년도 (2) · 목표`);
    expect(GUIDE_SHEET.rows[2]).toEqual([]);
    expect(GUIDE_SHEET.rows.slice(3).map((r) => r[0]?.value)).toEqual([...GOAL_GUIDE_ROW_LABELS]);
    expect(GUIDE_SHEET.hiddenColumns).toEqual([]);
  });

  it('핵심 규칙 문장을 담는다', () => {
    const text = GUIDE_SHEET.rows.map((r) => r[1]?.value ?? '').join('\n');
    for (const phrase of ['[삭제 포함]', ';', '되돌릴 수 없습니다', '숨김 열', '완전히 같아야', '연차 순서', '합계 행']) {
      expect(text).toContain(phrase);
    }
  });

  it('읽지 않는 열은 좌표 맵에서 만든다', () => {
    const unread = goalUnreadColumnsText();
    expect(unread).toContain('「성과목표」 연차 합계');
    // 읽는 열인 실적 지표명은 목록에 없다(GF-10)
    expect(unread).not.toContain('「성과실적」');
    for (const role of ['deliverableId', 'achievementId', 'techTargetId', 'recordId']) expect(unread).toContain(role);
    expect(unread).toContain('_lists');
    expect(unread).toContain('_meta');
    const row = GUIDE_SHEET.rows.find((r) => r[0]?.value === '읽지 않는 열');
    expect(row?.[1]?.value).toBe(unread);
  });
});

// ─── 경계 ───────────────────────────────────────────────────

describe('경계 (S-22)', () => {
  it('build.ts·guide.ts는 xlsx·exceljs·supabase를 import하지 않는다', () => {
    for (const file of ['build.ts', 'guide.ts']) {
      const src = fs.readFileSync(path.join(process.cwd(), 'lib/goal-form', file), 'utf8');
      expect(src).not.toMatch(/from ['"](xlsx|exceljs|@supabase\/[^'"]+)['"]/);
      expect(src).not.toMatch(/require\(['"](xlsx|exceljs)/);
    }
  });
});
