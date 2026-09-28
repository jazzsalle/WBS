// 목표 양식 좌표 맵·라벨 맵·`_meta` 왕복·거부 규칙 (SOT §6.17 GF-1~GF-4, 부록 A.2·A.4·F-9)
//
// 생성기·파서·어댑터가 같은 맵을 보므로(GF-1) 맵의 불변식이 깨지면 셋 다 조용히 틀린다.

import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import {
  GOAL_EMPTY_INPUT_ROWS,
  GOAL_ENUM_LABELS,
  GOAL_FORM_VERSION,
  GOAL_SHEET_ORDER,
  GOAL_TOTAL_MARKER,
  goalColumnAddress,
  goalColumnOf,
  goalEnumFromLabel,
  goalEnumLabel,
  goalEnumLabels,
  goalHiddenColumns,
  goalListRange,
  goalNameRange,
  goalSheetsFor,
  goalValidations,
  goalYearColumns,
  orderedGoalSheets,
} from '@/lib/goal-form/layout';
import type { GoalEnumKind, GoalFormSheets, GoalSheetDef } from '@/lib/goal-form/layout';
import {
  buildGoalMetaRows,
  checkGoalMeta,
  disambiguateLabels,
  goalMetaYearIds,
  goalYearLabels,
  parseGoalMeta,
} from '@/lib/goal-form/meta';
import type { GoalFormMeta } from '@/lib/goal-form/types';
import { buildMetaRows } from '@/lib/input-form/meta';
import { INPUT_FORM_VERSION } from '@/lib/input-form/layout';
import type { FormCell } from '@/lib/input-form/types';
import type { RawCell, RawSheet } from '@/lib/import/types';
import { deliverableTypeSchema, directionSchema, measureMethodSchema } from '@/lib/db/schema';

function toRawSheet(name: string, rows: FormCell[][]): RawSheet {
  const cells: RawCell[][] = rows.map((row) => row.map((cell) => ({ value: cell.value ?? null, isError: false })));
  return { name, cells, merges: [] };
}

const YEAR_LABELS = ['1차년도', '2차년도', '3차년도'];
const SHEETS = goalSheetsFor(YEAR_LABELS);

function roles(def: GoalSheetDef): string[] {
  return def.columns.map((c) => c.role);
}
function labels(def: GoalSheetDef): string[] {
  return def.columns.map((c) => c.label);
}
function visibleLabels(def: GoalSheetDef): string[] {
  return def.columns.filter((c) => !c.hidden).map((c) => c.label);
}

describe('시트 목록·순서 (GF-1, S-7)', () => {
  it('7장, 순서와 숨김', () => {
    const ordered = orderedGoalSheets(SHEETS);
    expect(ordered.map((s) => s.name)).toEqual([
      '작성안내',
      '성과목표',
      '성과실적',
      '기술목표',
      '측정이력',
      '_lists',
      '_meta',
    ]);
    expect(ordered.filter((s) => s.hidden).map((s) => s.name)).toEqual(['_lists', '_meta']);
    expect(ordered.map((s) => s.key)).toEqual([...GOAL_SHEET_ORDER]);
    expect(SHEETS.guide.kind).toBe('guide');
    expect(SHEETS.guide.columns).toEqual([]);
  });

  it('상수', () => {
    expect(GOAL_FORM_VERSION).toBe(1);
    expect(GOAL_TOTAL_MARKER).toBe('#total');
    expect(GOAL_EMPTY_INPUT_ROWS).toBe(20);
  });

  it.each(orderedGoalSheets(SHEETS).map((s) => [s.name, s] as const))('%s: 헤더 행 < 데이터 시작 행', (_n, def) => {
    expect(def.headerRow).toBeGreaterThanOrEqual(1);
    expect(def.dataStartRow).toBeGreaterThan(def.headerRow);
  });
});

describe('열 정의 (GF-1)', () => {
  it('성과목표: 구분 열 없음(S-16), 연차 열 N개 + 합계 수식', () => {
    expect(visibleLabels(SHEETS.deliverables)).toEqual([
      '유형',
      '지표명',
      '단위',
      '가중치(%)',
      '전체 목표',
      ...YEAR_LABELS,
      '연차 합계',
      '책임기관',
      '평가방법',
      '비고',
    ]);
    expect(labels(SHEETS.deliverables)).not.toContain('구분');
    expect(roles(SHEETS.deliverables)).not.toContain('group');
  });

  it('성과실적', () => {
    expect(visibleLabels(SHEETS.achievements)).toEqual([
      '지표명',
      '산출물명',
      '달성일',
      '연차',
      '기관',
      '관여자',
      '증빙 URL',
      '비고',
    ]);
  });

  it('기술목표', () => {
    expect(visibleLabels(SHEETS.techTargets)).toEqual([
      '구분',
      '평가항목',
      '단위',
      '방향',
      '비중(%)',
      ...YEAR_LABELS,
      '최종 목표',
      '국내수준',
      '세계최고',
      '보유국·기관',
      '측정방법',
      '측정방법 상세',
      '표준·인증기준',
      '기준설정 근거',
      '평가환경',
      '책임기관',
      '비고',
    ]);
  });

  it('측정이력', () => {
    expect(visibleLabels(SHEETS.records)).toEqual([
      '평가항목',
      '측정값',
      '측정일',
      '연차',
      '방법',
      '평가기관',
      '증빙 URL',
      '비고',
    ]);
  });

  it('숨김 id 열', () => {
    const hiddenRoles = (def: GoalSheetDef) => goalHiddenColumns(def).map((i) => def.columns[i]?.role);
    expect(hiddenRoles(SHEETS.deliverables)).toEqual(['deliverableId']);
    expect(hiddenRoles(SHEETS.achievements)).toEqual(['deliverableId', 'achievementId']);
    expect(hiddenRoles(SHEETS.techTargets)).toEqual(['techTargetId']);
    expect(hiddenRoles(SHEETS.records)).toEqual(['techTargetId', 'recordId']);
    // 숨김 id 열은 전부 읽는 키 열이다
    for (const def of [SHEETS.deliverables, SHEETS.achievements, SHEETS.techTargets, SHEETS.records]) {
      for (const i of goalHiddenColumns(def)) expect(def.columns[i]?.read).toBe(true);
    }
  });

  it('합계 마커를 적는 숨김 id 열은 각 데이터 시트의 첫 열이다', () => {
    for (const def of [SHEETS.deliverables, SHEETS.achievements, SHEETS.techTargets, SHEETS.records]) {
      expect(def.columns[0]?.hidden).toBe(true);
    }
  });

  it('읽지 않는 열은 성과목표 연차 합계뿐(GF-8). 실적 지표명·측정 평가항목은 읽는 열(GF-10)', () => {
    const unread = [SHEETS.deliverables, SHEETS.achievements, SHEETS.techTargets, SHEETS.records].flatMap((def) =>
      def.columns.filter((c) => !c.read).map((c) => `${def.name}.${c.role}`)
    );
    expect(unread).toEqual(['성과목표.yearTotal']);
    expect(SHEETS.deliverables.columns[goalColumnOf(SHEETS.deliverables, 'yearTotal')]?.format).toBe('formula');
    expect(SHEETS.achievements.columns[goalColumnOf(SHEETS.achievements, 'deliverableName')]?.read).toBe(true);
    expect(SHEETS.records.columns[goalColumnOf(SHEETS.records, 'techTargetName')]?.read).toBe(true);
  });

  it('format', () => {
    const fmt = <R extends string>(def: GoalSheetDef<R>, role: R) => def.columns[goalColumnOf(def, role)]?.format;
    expect(fmt(SHEETS.deliverables, 'name')).toBe('text');
    expect(fmt(SHEETS.deliverables, 'weight')).toBe('decimal');
    expect(fmt(SHEETS.deliverables, 'targetTotal')).toBe('int');
    expect(goalYearColumns(SHEETS.deliverables).map((i) => SHEETS.deliverables.columns[i]?.format)).toEqual([
      'int',
      'int',
      'int',
    ]);
    expect(fmt(SHEETS.achievements, 'date')).toBe('date');
    expect(fmt(SHEETS.techTargets, 'weight')).toBe('decimal');
    expect(fmt(SHEETS.techTargets, 'targetValue')).toBe('decimal');
    expect(fmt(SHEETS.techTargets, 'baselineDomestic')).toBe('decimal');
    expect(fmt(SHEETS.techTargets, 'worldBest')).toBe('decimal');
    expect(goalYearColumns(SHEETS.techTargets).map((i) => SHEETS.techTargets.columns[i]?.format)).toEqual([
      'decimal',
      'decimal',
      'decimal',
    ]);
    expect(fmt(SHEETS.records, 'value')).toBe('decimal');
    expect(fmt(SHEETS.records, 'date')).toBe('date');
    // 백분율 서식 금지(F-6·X-7)
    for (const def of orderedGoalSheets(SHEETS)) {
      for (const c of def.columns) expect(c.format).not.toBe('percent');
    }
  });

  it.each(orderedGoalSheets(SHEETS).map((s) => [s.name, s] as const))(
    '%s: 연차 열 외 역할 중복 0',
    (_n, def) => {
      const rs = def.columns.filter((c) => c.yearIndex === undefined).map((c) => c.role);
      expect(new Set(rs).size).toBe(rs.length);
    }
  );
});

describe('연차 열 (GF-2·GF-3)', () => {
  it('헤더 = 연차 라벨, yearIndex 순서 = 열 순서', () => {
    const cols = goalYearColumns(SHEETS.deliverables);
    expect(cols.map((i) => SHEETS.deliverables.columns[i]?.label)).toEqual(YEAR_LABELS);
    expect(cols.map((i) => SHEETS.deliverables.columns[i]?.yearIndex)).toEqual([0, 1, 2]);
    expect([...cols].sort((a, b) => a - b)).toEqual(cols);
  });

  it('연차 수로 만든 맵은 라벨로 만든 맵과 좌표가 같다 — 파서는 헤더를 읽지 않는다', () => {
    const byCount = goalSheetsFor(3);
    const byLabels = goalSheetsFor(['가', '나', '다']);
    for (const key of GOAL_SHEET_ORDER) {
      expect(roles(byCount[key] as GoalSheetDef)).toEqual(roles(byLabels[key] as GoalSheetDef));
    }
    expect(goalYearColumns(byCount.techTargets)).toEqual(goalYearColumns(byLabels.techTargets));
    expect(goalYearColumns(byCount.deliverables).map((i) => byCount.deliverables.columns[i]?.label)).toEqual(
      YEAR_LABELS
    );
  });

  it('연차 0개면 연차 열이 없다', () => {
    const none = goalSheetsFor(0);
    expect(goalYearColumns(none.deliverables)).toEqual([]);
    expect(goalYearColumns(none.techTargets)).toEqual([]);
    expect(goalColumnOf(none.deliverables, 'yearTotal')).toBe(goalColumnOf(none.deliverables, 'targetTotal') + 1);
  });

  it('연차 수가 음수·소수면 throw', () => {
    expect(() => goalSheetsFor(-1)).toThrow();
    expect(() => goalSheetsFor(1.5)).toThrow();
  });

  it('yearTarget은 goalColumnOf로 찾을 수 없다(여럿) — 조용히 첫 열을 돌려주지 않는다', () => {
    expect(() => goalColumnOf(SHEETS.deliverables, 'yearTarget')).toThrow();
    expect(goalColumnOf(goalSheetsFor(1).deliverables, 'yearTarget')).toBeGreaterThan(0);
  });

  it('A1 주소', () => {
    // deliverableId A, 유형 B, 지표명 C
    expect(goalColumnAddress(SHEETS.deliverables, 'name', 5)).toBe('C5');
  });
});

describe('드롭다운 (F-9, GF-4, GF-10)', () => {
  const sources = (def: GoalSheetDef) =>
    def.columns.flatMap((c) => (c.list === undefined ? [] : [{ role: c.role, list: c.list, style: c.errorStyle }]));

  it('목록 열과 출처', () => {
    expect(sources(SHEETS.deliverables)).toEqual([
      { role: 'type', list: { kind: 'lists', list: 'deliverableType' }, style: undefined },
      { role: 'org', list: { kind: 'lists', list: 'org' }, style: undefined },
    ]);
    expect(sources(SHEETS.achievements)).toEqual([
      { role: 'deliverableName', list: { kind: 'sheet', sheet: 'deliverables', role: 'name' }, style: 'warning' },
      { role: 'year', list: { kind: 'lists', list: 'year' }, style: undefined },
      { role: 'org', list: { kind: 'lists', list: 'org' }, style: undefined },
      { role: 'members', list: { kind: 'lists', list: 'member' }, style: 'warning' },
    ]);
    expect(sources(SHEETS.techTargets)).toEqual([
      { role: 'direction', list: { kind: 'lists', list: 'direction' }, style: undefined },
      { role: 'measureMethod', list: { kind: 'lists', list: 'measureMethod' }, style: undefined },
      { role: 'org', list: { kind: 'lists', list: 'org' }, style: undefined },
    ]);
    expect(sources(SHEETS.records)).toEqual([
      { role: 'techTargetName', list: { kind: 'sheet', sheet: 'techTargets', role: 'name' }, style: 'warning' },
      { role: 'year', list: { kind: 'lists', list: 'year' }, style: undefined },
      { role: 'method', list: { kind: 'lists', list: 'measureMethod' }, style: undefined },
    ]);
  });

  it('축 열은 없다(S-8)', () => {
    for (const def of orderedGoalSheets(SHEETS)) expect(labels(def)).not.toContain('현금/현물');
  });

  it('_lists 열: 목록 6종, 파서가 읽지 않는다', () => {
    expect(roles(SHEETS.lists)).toEqual(['deliverableType', 'direction', 'measureMethod', 'year', 'org', 'member']);
    expect(SHEETS.lists.columns.every((c) => !c.read)).toBe(true);
  });

  it('goalListRange: `_lists` 절대 범위, 빈 목록도 한 칸', () => {
    expect(goalListRange(SHEETS, 'deliverableType', 13)).toEqual({ sheet: '_lists', range: '$A$2:$A$14' });
    expect(goalListRange(SHEETS, 'member', 0)).toEqual({ sheet: '_lists', range: '$F$2:$F$2' });
    expect(() => goalListRange(SHEETS, 'org', -1)).toThrow();
  });

  it('goalNameRange: 같은 파일 성과목표·기술목표 이름 열', () => {
    expect(goalNameRange(SHEETS, 'deliverables', 25)).toEqual({ sheet: '성과목표', range: '$C$2:$C$25' });
    expect(goalNameRange(SHEETS, 'techTargets', 21)).toEqual({ sheet: '기술목표', range: '$C$2:$C$21' });
    expect(() => goalNameRange(SHEETS, 'deliverables', 1)).toThrow();
  });

  it('goalValidations: 범위 참조, values 빈 배열, errorStyle 기본 stop', () => {
    const resolve = (sheets: GoalFormSheets) => (source: Parameters<Parameters<typeof goalValidations>[1]>[0]) =>
      source.kind === 'lists' ? goalListRange(sheets, source.list, 3) : goalNameRange(sheets, source.sheet, 30);
    const v = goalValidations(SHEETS.achievements, resolve(SHEETS));
    expect(v).toEqual([
      {
        column: goalColumnOf(SHEETS.achievements, 'deliverableName'),
        values: [],
        listRange: { sheet: '성과목표', range: '$C$2:$C$30' },
        errorStyle: 'warning',
      },
      {
        column: goalColumnOf(SHEETS.achievements, 'year'),
        values: [],
        listRange: { sheet: '_lists', range: '$D$2:$D$4' },
        errorStyle: 'stop',
      },
      {
        column: goalColumnOf(SHEETS.achievements, 'org'),
        values: [],
        listRange: { sheet: '_lists', range: '$E$2:$E$4' },
        errorStyle: 'stop',
      },
      {
        column: goalColumnOf(SHEETS.achievements, 'members'),
        values: [],
        listRange: { sheet: '_lists', range: '$F$2:$F$4' },
        errorStyle: 'warning',
      },
    ]);
  });
});

describe('부록 A.2·A.4 라벨 ↔ 코드 (GF-3)', () => {
  const ENUMS: Record<GoalEnumKind, readonly string[]> = {
    deliverableType: deliverableTypeSchema.options,
    direction: directionSchema.options,
    measureMethod: measureMethodSchema.options,
  };

  it.each(Object.keys(ENUMS) as GoalEnumKind[])('%s: 모든 enum 값을 덮고 왕복한다', (kind) => {
    const codes = ENUMS[kind];
    expect(Object.keys(GOAL_ENUM_LABELS[kind]).sort()).toEqual([...codes].sort());
    for (const code of codes) {
      const label = goalEnumLabel(kind, code as never);
      expect(label).toBeTruthy();
      expect(goalEnumFromLabel(kind, label)).toBe(code);
    }
    expect(new Set(goalEnumLabels(kind)).size).toBe(codes.length);
  });

  it('부록 라벨 그대로', () => {
    expect(goalEnumLabel('deliverableType', 'paper_sci')).toBe('SCI(E) 논문');
    expect(goalEnumLabel('deliverableType', 'other')).toBe('기타');
    expect(goalEnumLabel('direction', 'lower_better')).toBe('낮을수록 우수');
    expect(goalEnumLabel('measureMethod', 'certified_lab')).toBe('공인시험');
    expect(goalEnumLabels('measureMethod')).toEqual(['자체측정', '공인시험', '전문가평가', '수요처평가', '기타']);
  });

  it('완전 일치만 — 앞뒤 공백만 뗀다, 별칭·코드·부분 일치 없음(S-10)', () => {
    expect(goalEnumFromLabel('direction', '  높을수록 우수 ')).toBe('higher_better');
    expect(goalEnumFromLabel('direction', '높을수록우수')).toBeNull();
    expect(goalEnumFromLabel('direction', 'higher_better')).toBeNull();
    // 부록 C.3.3 별칭(hwpx 전용)은 양식에서 받지 않는다
    expect(goalEnumFromLabel('measureMethod', '공인기관시험평가')).toBeNull();
    expect(goalEnumFromLabel('measureMethod', '공인')).toBeNull();
    expect(goalEnumFromLabel('deliverableType', '')).toBeNull();
    expect(goalEnumFromLabel('deliverableType', 'constructor')).toBeNull();
  });
});

describe('라벨 만들기 (GF-3·GF-4)', () => {
  it('동명은 `이름 (2)`부터', () => {
    expect(disambiguateLabels(['김철수', '이영희', '김철수', '김철수'])).toEqual([
      '김철수',
      '이영희',
      '김철수 (2)',
      '김철수 (3)',
    ]);
  });

  it('앞뒤 공백을 떼고 비교한다', () => {
    expect(disambiguateLabels([' A', 'A '])).toEqual(['A', 'A (2)']);
  });

  it('만든 라벨이 실제 이름을 가로채지 않는다', () => {
    const out = disambiguateLabels(['A', 'A', 'A (2)']);
    expect(out).toEqual(['A', 'A (3)', 'A (2)']);
    expect(new Set(out).size).toBe(3);
  });

  it('연차 라벨: name, 비면 `${order+1}차년도`, 겹치면 (2)', () => {
    expect(
      goalYearLabels([
        { name: '', order: 0 },
        { name: '  ', order: 1 },
        { name: '본연구', order: 2 },
        { name: '본연구', order: 3 },
        { name: '1차년도', order: 4 },
      ])
    ).toEqual(['1차년도', '2차년도', '본연구', '본연구 (2)', '1차년도 (2)']);
  });
});

describe('_meta 왕복·거부 (GF-1·GF-2, S-5·S-17)', () => {
  const META: GoalFormMeta = {
    formVersion: GOAL_FORM_VERSION,
    projectId: 'proj-1',
    generatedAt: '2026-09-29T09:00:00.000Z',
    // 열 순서가 id 정렬과 다르게 — 순서 보존 확인
    years: [
      { id: 'y-3', label: '1차년도' },
      { id: 'y-1', label: '2차년도' },
      { id: 'y-2', label: '3차년도' },
    ],
    orgs: [
      { id: 'o-2', label: '가기관' },
      { id: 'o-1', label: '가기관 (2)' },
    ],
    members: [
      { id: 'm-1', label: '김철수' },
      { id: 'm-2', label: '김철수 (2)' },
    ],
    deliverables: { 'd-1': 3, 'd-2': 1 },
    achievements: { 'a-1': 2 },
    techTargets: { 't-1': 7 },
    records: { 'r-1': 1, 'r-2': 4 },
  };

  const metaSheet = (rows: FormCell[][]) => toRawSheet('_meta', rows);
  const keyValue = (rows: FormCell[][]) => rows.slice(1).map((r) => [r[0]?.value, r[1]?.value]);

  it('행 모양: 헤더 → form=goal → 고정 키 → year·org·member 라벨 → id=version', () => {
    expect(keyValue(buildGoalMetaRows(META))).toEqual([
      ['form', 'goal'],
      ['formVersion', 1],
      ['projectId', 'proj-1'],
      ['generatedAt', '2026-09-29T09:00:00.000Z'],
      ['year:y-3', '1차년도'],
      ['year:y-1', '2차년도'],
      ['year:y-2', '3차년도'],
      ['org:o-2', '가기관'],
      ['org:o-1', '가기관 (2)'],
      ['member:m-1', '김철수'],
      ['member:m-2', '김철수 (2)'],
      ['deliverable:d-1', 3],
      ['deliverable:d-2', 1],
      ['achievement:a-1', 2],
      ['techTarget:t-1', 7],
      ['record:r-1', 1],
      ['record:r-2', 4],
    ]);
    expect(buildGoalMetaRows(META)[0]?.map((c) => c.value)).toEqual(['키', '값']);
  });

  it('왕복: build → parse → 같은 값, yearIds 순서 보존', () => {
    const parsed = parseGoalMeta(metaSheet(buildGoalMetaRows(META)));
    expect(parsed).toEqual({ form: 'goal', projectId: 'proj-1', formVersion: 1, meta: META });
    expect(goalMetaYearIds(parsed.meta as GoalFormMeta)).toEqual(['y-3', 'y-1', 'y-2']);
    expect(checkGoalMeta(parsed, { projectId: 'proj-1' })).toEqual({ ok: true, meta: META });
  });

  it('빈 목록 왕복', () => {
    const empty: GoalFormMeta = {
      ...META,
      years: [],
      orgs: [],
      members: [],
      deliverables: {},
      achievements: {},
      techTargets: {},
      records: {},
    };
    expect(parseGoalMeta(metaSheet(buildGoalMetaRows(empty))).meta).toEqual(empty);
  });

  it('숫자 셀이 문자열로 와도 같다(엑셀이 형식을 바꿔도)', () => {
    const rows = buildGoalMetaRows(META).map((r) => r.map((c) => ({ value: c.value === undefined ? null : String(c.value) })));
    expect(parseGoalMeta(metaSheet(rows)).meta).toEqual(META);
  });

  it('모르는 키는 무시', () => {
    const rows = [...buildGoalMetaRows(META), [{ value: 'future:x' }, { value: '1' }]];
    expect(parseGoalMeta(metaSheet(rows)).meta).toEqual(META);
  });

  const replaceValue = (key: string, value: string | number): FormCell[][] =>
    buildGoalMetaRows(META).map((r) => (r[0]?.value === key ? [r[0], { value }] : r));

  it.each([0, -1, 1.5, 'abc', ''])('version이 양의 정수가 아니면(%s) meta null → invalid-meta', (bad) => {
    const parsed = parseGoalMeta(metaSheet(replaceValue('record:r-2', bad)));
    expect(parsed.meta).toBeNull();
    expect(parsed.form).toBe('goal');
    expect(checkGoalMeta(parsed, { projectId: 'proj-1' })).toMatchObject({
      ok: false,
      rejection: { kind: 'invalid-meta' },
    });
  });

  it('같은 id가 두 번이면 meta null', () => {
    const rows = [...buildGoalMetaRows(META), [{ value: 'deliverable:d-1' }, { value: 3 }]];
    expect(parseGoalMeta(metaSheet(rows)).meta).toBeNull();
    const rows2 = [...buildGoalMetaRows(META), [{ value: 'year:y-1' }, { value: '4차년도' }]];
    expect(parseGoalMeta(metaSheet(rows2)).meta).toBeNull();
  });

  it('같은 라벨이 두 번이면 meta null — 완전 일치가 하나로 정해지지 않는다(GF-4)', () => {
    const rows = replaceValue('member:m-2', '김철수');
    expect(parseGoalMeta(metaSheet(rows)).meta).toBeNull();
  });

  it('생성기는 파서가 거부할 메타를 쓰지 않는다', () => {
    expect(() => buildGoalMetaRows({ ...META, records: { 'r-1': 0 } })).toThrow();
    expect(() => buildGoalMetaRows({ ...META, deliverables: { 'd-1': 1.5 } })).toThrow();
    expect(() =>
      buildGoalMetaRows({
        ...META,
        members: [
          { id: 'm-1', label: '김' },
          { id: 'm-2', label: '김' },
        ],
      })
    ).toThrow();
    expect(() =>
      buildGoalMetaRows({
        ...META,
        years: [
          { id: 'y-1', label: 'a' },
          { id: 'y-1', label: 'b' },
        ],
      })
    ).toThrow();
  });

  describe('거부 순서: 형식 → 과제 → 버전', () => {
    const check = (rows: FormCell[][] | null, projectId = 'proj-1') =>
      checkGoalMeta(parseGoalMeta(rows === null ? null : metaSheet(rows)), { projectId });
    const kind = (result: ReturnType<typeof check>) => (result.ok ? 'ok' : result.rejection.kind);

    it('_meta 시트 없음', () => {
      expect(kind(check(null))).toBe('not-goal-form');
    });

    it('form 행 없음', () => {
      expect(kind(check(buildGoalMetaRows(META).filter((r) => r[0]?.value !== 'form')))).toBe('not-goal-form');
    });

    it('form ≠ goal', () => {
      expect(kind(check(replaceValue('form', 'input')))).toBe('not-goal-form');
    });

    it('입력 양식 파일(과제·버전이 같아도) → not-goal-form', () => {
      const inputRows = buildMetaRows({
        formVersion: INPUT_FORM_VERSION,
        projectId: 'proj-1',
        yearId: 'y-1',
        generatedAt: '2026-09-29T00:00:00.000Z',
        subcategoryCodes: ['activity_meeting'],
        memberIds: ['m-1'],
      });
      const result = check(inputRows);
      expect(kind(result)).toBe('not-goal-form');
      expect(result.ok ? '' : result.rejection.message).toContain('목표 양식');
    });

    it('형식이 과제보다 먼저: form 틀림 + 과제 틀림 → not-goal-form', () => {
      expect(kind(check(replaceValue('form', 'input'), 'other'))).toBe('not-goal-form');
    });

    it('과제 불일치', () => {
      expect(kind(check(buildGoalMetaRows(META), 'proj-2'))).toBe('project-mismatch');
    });

    it('과제가 버전보다 먼저', () => {
      expect(kind(check(replaceValue('formVersion', 2), 'proj-2'))).toBe('project-mismatch');
    });

    it('버전 불일치·비정수', () => {
      expect(kind(check(replaceValue('formVersion', 2)))).toBe('version-mismatch');
      expect(kind(check(replaceValue('formVersion', 'x')))).toBe('version-mismatch');
    });

    it('버전이 본문보다 먼저 — 다른 버전 파일의 본문은 "손상"이 아니다', () => {
      const rows = replaceValue('formVersion', 2).map((r) => (r[0]?.value === 'record:r-1' ? [r[0], { value: 0 }] : r));
      expect(kind(check(rows))).toBe('version-mismatch');
    });

    it('사유마다 사용자 문구가 있다', () => {
      const r = check(buildGoalMetaRows(META), 'proj-2');
      expect(r.ok ? '' : r.rejection.message).toBe('이 과제의 양식이 아닙니다');
      const v = check(replaceValue('formVersion', 2));
      expect(v.ok ? '' : v.rejection.message).toContain('다시 내려받으세요');
    });
  });
});

describe('경계 (S-22)', () => {
  it('lib/goal-form은 xlsx·exceljs·supabase를 import하지 않는다', () => {
    const dir = path.join(process.cwd(), 'lib', 'goal-form');
    for (const file of fs.readdirSync(dir).filter((f) => f.endsWith('.ts'))) {
      const source = fs.readFileSync(path.join(dir, file), 'utf8');
      expect(source, file).not.toMatch(/from\s+['"](xlsx|exceljs|@supabase\/[^'"]*)['"]/);
      expect(source, file).not.toMatch(/import\(\s*['"](xlsx|exceljs)['"]\s*\)/);
    }
  });
});
