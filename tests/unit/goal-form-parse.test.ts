// 목표 양식 파서 (SOT §6.17 GF-2~GF-10, 부록 C.3.4)
//
// 픽스처는 좌표 맵 `goalSheetsFor`로 손으로 만든다 — 생성기(T6)와 무관하게. 결과 행 모델(GoalFormRows)은
// xlsx를 모르는 모양이어야 한다(Phase 22 hwpx가 같은 모양을 만든다).

import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { GOAL_FORM_VERSION, GOAL_TOTAL_MARKER, goalColumnOf, goalSheetsFor, goalYearColumns } from '@/lib/goal-form/layout';
import type { GoalSheetDef } from '@/lib/goal-form/layout';
import { buildGoalMetaRows } from '@/lib/goal-form/meta';
import { GOAL_FORM_ISSUES, GOAL_FORM_MAX_LENGTH, parseGoalForm } from '@/lib/goal-form/parse';
import type { GoalFormIssueKind, GoalFormRows, ParseGoalFormResult } from '@/lib/goal-form/parse';
import type { GoalFormMeta } from '@/lib/goal-form/types';
import { buildMetaRows } from '@/lib/input-form/meta';
import { INPUT_FORM_VERSION } from '@/lib/input-form/layout';
import type { RawCell, RawSheet } from '@/lib/import/types';

// ─── 픽스처 빌더 ─────────────────────────────────────────────

type CellInput = RawCell | string | number | null | undefined;

function toCell(input: CellInput): RawCell {
  if (input === undefined || input === null) return { value: null, isError: false };
  if (typeof input === 'object') return input;
  return { value: input, isError: false };
}

const YEAR_LABELS = ['1차년도', '2차년도', '3차년도'];

const META: GoalFormMeta = {
  formVersion: GOAL_FORM_VERSION,
  projectId: 'proj-1',
  generatedAt: '2026-09-29T09:00:00.000Z',
  years: [
    { id: 'y-1', label: YEAR_LABELS[0] as string },
    { id: 'y-2', label: YEAR_LABELS[1] as string },
    { id: 'y-3', label: YEAR_LABELS[2] as string },
  ],
  orgs: [
    { id: 'o-1', label: '주관기관' },
    { id: 'o-2', label: '공동기관' },
  ],
  members: [
    { id: 'm-1', label: '홍길동' },
    { id: 'm-2', label: '김철수' },
    { id: 'm-3', label: '홍길동 (2)' },
  ],
  deliverables: { 'd-1': 1, 'd-2': 3 },
  achievements: { 'a-1': 2 },
  techTargets: { 't-1': 1, 't-2': 1 },
  records: { 'r-1': 1 },
};

const EXPECTED = { projectId: 'proj-1' };

type DataKey = 'deliverables' | 'achievements' | 'techTargets' | 'records';
type RowInput = Record<string, CellInput | CellInput[]>;

/** 역할 → 값. `years`는 yearIds 순서. `total: true`면 첫 숨김 열에 `#total` */
function sheetOf(key: DataKey, rows: (RowInput | 'total' | 'blank')[], headerLabels: string[] = YEAR_LABELS): RawSheet {
  const def = goalSheetsFor(headerLabels)[key] as GoalSheetDef;
  const yearCols = goalYearColumns(def);
  const cells: RawCell[][] = [];
  for (let r = 1; r < def.headerRow; r += 1) cells.push([]);
  cells.push(def.columns.map((column) => toCell(column.label)));
  for (let r = def.headerRow + 1; r < def.dataStartRow; r += 1) cells.push([]);
  for (const row of rows) {
    const line: RawCell[] = def.columns.map(() => toCell(null));
    if (row === 'total') {
      line[0] = toCell(GOAL_TOTAL_MARKER);
      // 합계 행의 수식 셀은 어댑터가 null로 읽지만, 계산값이 들어와도 건너뛰어야 한다
      const weightCol = def.columns.findIndex((column) => column.role === 'weight');
      if (weightCol >= 0) line[weightCol] = toCell(100);
    } else if (row !== 'blank') {
      for (const [role, value] of Object.entries(row)) {
        if (role === 'years') continue;
        line[goalColumnOf(def, role as never)] = toCell(value as CellInput);
      }
      ((row.years ?? []) as CellInput[]).forEach((value, i) => {
        line[yearCols[i] as number] = toCell(value);
      });
    }
    cells.push(line);
  }
  return { name: def.name, cells, merges: [] };
}

function metaSheet(meta: GoalFormMeta = META): RawSheet {
  const cells = buildGoalMetaRows(meta).map((row) => row.map((cell) => toCell((cell.value ?? null) as CellInput)));
  return { name: '_meta', cells, merges: [] };
}

interface Book {
  deliverables?: (RowInput | 'total' | 'blank')[];
  achievements?: (RowInput | 'total' | 'blank')[];
  techTargets?: (RowInput | 'total' | 'blank')[];
  records?: (RowInput | 'total' | 'blank')[];
}

function book(input: Book, meta: GoalFormMeta = META): RawSheet[] {
  return [
    metaSheet(meta),
    sheetOf('deliverables', input.deliverables ?? []),
    sheetOf('achievements', input.achievements ?? []),
    sheetOf('techTargets', input.techTargets ?? []),
    sheetOf('records', input.records ?? []),
  ];
}

function parseOk(sheets: RawSheet[]): GoalFormRows {
  const result = parseGoalForm(sheets, EXPECTED);
  if (!result.ok) throw new Error(`거부됨: ${result.rejection.kind}`);
  return result.rows;
}

function kinds(issues: readonly { kind: GoalFormIssueKind }[]): GoalFormIssueKind[] {
  return issues.map((i) => i.kind);
}

// 기본 행 — 필수값이 다 있는 "문제 없음" 행
const D_OK: RowInput = { type: 'SCI(E) 논문', name: '논문 게재', years: [1, 2, 3] };
const T_OK: RowInput = { name: '정확도', unit: '%', direction: '높을수록 우수', years: [80, 85, 90], targetValue: 90 };

function rejectionOf(result: ParseGoalFormResult): string {
  if (result.ok) throw new Error('거부되어야 한다');
  return result.rejection.kind;
}

// ─── 거부 (GF-2) ─────────────────────────────────────────────

describe('parseGoalForm — 거부', () => {
  it('_meta가 없으면 not-goal-form', () => {
    const sheets = book({}).filter((s) => s.name !== '_meta');
    expect(rejectionOf(parseGoalForm(sheets, EXPECTED))).toBe('not-goal-form');
  });

  it('입력 양식 _meta 파일은 not-goal-form (과제·버전이 맞아 보여도)', () => {
    const inputMeta = buildMetaRows({
      formVersion: INPUT_FORM_VERSION,
      projectId: 'proj-1',
      yearId: 'y-1',
      generatedAt: '2026-09-29T09:00:00.000Z',
      subcategoryCodes: [],
      memberIds: [],
    }).map((row) => row.map((cell) => toCell((cell.value ?? null) as CellInput)));
    const sheets = [{ name: '_meta', cells: inputMeta, merges: [] }, ...book({}).slice(1)];
    expect(rejectionOf(parseGoalForm(sheets, EXPECTED))).toBe('not-goal-form');
  });

  it('다른 과제면 project-mismatch', () => {
    expect(rejectionOf(parseGoalForm(book({}), { projectId: 'proj-2' }))).toBe('project-mismatch');
  });

  it('버전이 다르면 version-mismatch', () => {
    const sheets = book({});
    const meta = sheets[0] as RawSheet;
    const row = meta.cells.find((line) => line[0]?.value === 'formVersion') as RawCell[];
    row[1] = toCell(GOAL_FORM_VERSION + 1);
    expect(rejectionOf(parseGoalForm(sheets, EXPECTED))).toBe('version-mismatch');
  });

  it('_meta 본문이 깨지면 invalid-meta', () => {
    const sheets = book({});
    (sheets[0] as RawSheet).cells.push([toCell('deliverable:d-9'), toCell('abc')]);
    expect(rejectionOf(parseGoalForm(sheets, EXPECTED))).toBe('invalid-meta');
  });

  it.each(['성과목표', '성과실적', '기술목표', '측정이력'])('%s 시트가 없으면 missing-sheet', (name) => {
    const sheets = book({}).filter((s) => s.name !== name);
    const result = parseGoalForm(sheets, EXPECTED);
    expect(rejectionOf(result)).toBe('missing-sheet');
    if (!result.ok) expect(result.rejection.message).toContain(name);
  });

  it('통과하면 meta를 그대로 돌려준다', () => {
    const result = parseGoalForm(book({}), EXPECTED);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.meta.years.map((y) => y.id)).toEqual(['y-1', 'y-2', 'y-3']);
      expect(result.rows).toEqual({ deliverables: [], achievements: [], techTargets: [], records: [] });
    }
  });
});

// ─── 연차 열 (GF-2) ──────────────────────────────────────────

describe('연차 열은 _meta.yearIds 순서로 읽는다', () => {
  it('헤더 텍스트를 바꿔도 결과가 같다', () => {
    const input: Book = { deliverables: [D_OK], techTargets: [T_OK] };
    const normal = book(input);
    const renamed = [
      metaSheet(),
      sheetOf('deliverables', input.deliverables ?? [], ['3차년도', '엉뚱한 헤더', '']),
      sheetOf('achievements', []),
      sheetOf('techTargets', input.techTargets ?? [], ['2028', '2027', '2026']),
      sheetOf('records', []),
    ];
    expect(parseOk(renamed)).toEqual(parseOk(normal));
    const rows = parseOk(normal);
    expect(rows.deliverables[0]?.targetByYear).toEqual({ 'y-1': 1, 'y-2': 2, 'y-3': 3 });
    expect(rows.techTargets[0]?.targetByYear).toEqual({ 'y-1': 80, 'y-2': 85, 'y-3': 90 });
  });

  it('targetByYear는 yearIds 전부가 키이고 빈 칸은 null (0과 다르다)', () => {
    const rows = parseOk(book({ deliverables: [{ ...D_OK, years: [null, 0, 2] }] }));
    expect(rows.deliverables[0]?.targetByYear).toEqual({ 'y-1': null, 'y-2': 0, 'y-3': 2 });
  });
});

// ─── 행 범위 (GF-8·GF-9) ─────────────────────────────────────

describe('행 범위', () => {
  it('#total 행과 사용자 열이 전부 빈 행은 건너뛴다 — 합계 행 위 행은 사유 없이 읽는다', () => {
    const rows = parseOk(
      book({
        deliverables: [D_OK, 'blank', { deliverableId: 'd-1' }, 'total', 'blank', { deliverableId: 'd-2' }],
        techTargets: [T_OK, 'blank', 'total'],
      })
    );
    expect(rows.deliverables.map((d) => [d.sheetRow, d.name, d.issues])).toEqual([[2, '논문 게재', []]]);
    expect(rows.techTargets).toHaveLength(1);
  });

  it('합계 행 아래에 사용자 열 값이 있는 행은 버리지 않고 blocking below-total (첫 합계 행에서 멈춘다)', () => {
    const rows = parseOk(
      book({
        deliverables: [D_OK, 'total', { ...D_OK, name: '특허' }, 'total', { ...D_OK, name: '인력' }],
        achievements: [{ deliverableName: '논문 게재', title: 'A', date: '2026-01-01' }, 'total', { title: 'B' }],
        techTargets: [T_OK, 'total', { ...T_OK, name: '속도' }],
        records: ['total', { techTargetName: '정확도', value: 1, date: '2026-01-01' }],
      })
    );
    expect(rows.deliverables.map((d) => [d.sheetRow, d.name])).toEqual([
      [2, '논문 게재'],
      [4, '특허'],
      [6, '인력'],
    ]);
    expect(rows.deliverables[0]?.issues).toEqual([]);
    expect(kinds(rows.deliverables[1]?.issues ?? [])).toEqual(['below-total']);
    expect(rows.deliverables[1]?.issues[0]).toEqual({
      kind: 'below-total',
      message: `${GOAL_FORM_ISSUES['below-total'].message}: 4행`,
      blocking: true,
    });
    expect(kinds(rows.deliverables[2]?.issues ?? [])).toEqual(['below-total']);
    expect(rows.achievements[0]?.issues).toEqual([]);
    expect(kinds(rows.achievements[1]?.issues ?? [])[0]).toBe('below-total');
    expect(kinds(rows.techTargets[1]?.issues ?? [])).toEqual(['below-total']);
    expect(kinds(rows.records[0]?.issues ?? [])).toEqual(['below-total']);
  });

  it('수식 칸(연차 합계, read: false)은 읽지 않는다 — 값이 있어도 무시하고 빈 행 판정에도 넣지 않는다', () => {
    const rows = parseOk(book({ deliverables: [{ yearTotal: 999 }, { ...D_OK, yearTotal: 999 }] }));
    expect(rows.deliverables).toHaveLength(1);
    expect(rows.deliverables[0]?.targetTotal).toBe(6);
  });

  it('문제 없는 행은 issues가 비고 앱 camelCase 값으로 나온다', () => {
    const rows = parseOk(book({ deliverables: [{ ...D_OK, deliverableId: 'd-1', org: '주관기관', evidenceMethod: 'DOI' }] }));
    expect(rows.deliverables[0]).toEqual({
      sheetRow: 2,
      id: 'd-1',
      type: 'paper_sci',
      name: '논문 게재',
      unit: '건',
      weight: 0,
      targetTotal: 6,
      targetByYear: { 'y-1': 1, 'y-2': 2, 'y-3': 3 },
      orgId: 'o-1',
      evidenceMethod: 'DOI',
      note: '',
      issues: [],
    });
  });
});

// ─── 라벨·기관·관여자 (GF-3·GF-4) ────────────────────────────

describe('라벨 → 코드, 완전 일치만', () => {
  it('유형·방향·측정방법 라벨(앞뒤 공백 허용)', () => {
    const rows = parseOk(
      book({
        deliverables: [{ ...D_OK, type: '  국내 특허 출원 ' }],
        techTargets: [{ ...T_OK, direction: '낮을수록 우수', years: [3, 2, 1], targetValue: 1, measureMethod: '공인시험' }],
      })
    );
    expect(rows.deliverables[0]?.type).toBe('patent_dom_apply');
    expect(rows.techTargets[0]?.direction).toBe('lower_better');
    expect(rows.techTargets[0]?.measureMethod).toBe('certified_lab');
  });

  it('모르는 라벨은 blocking unknown-label (별칭·코드·공백 변형 불가)', () => {
    const rows = parseOk(
      book({
        deliverables: [{ ...D_OK, type: 'paper_sci' }],
        techTargets: [{ ...T_OK, direction: '높을수록우수', measureMethod: '공인기관시험평가' }],
      })
    );
    expect(rows.deliverables[0]?.type).toBeNull();
    expect(kinds(rows.deliverables[0]?.issues ?? [])).toEqual(['unknown-label']);
    expect(rows.techTargets[0]?.direction).toBeNull();
    expect(rows.techTargets[0]?.measureMethod).toBeNull();
    expect(kinds(rows.techTargets[0]?.issues ?? [])).toEqual(['unknown-label', 'unknown-label']);
    expect(rows.techTargets[0]?.issues.every((i) => i.blocking)).toBe(true);
  });

  it('연차·기관: _meta 라벨 완전 일치, 실패는 blocking', () => {
    const rows = parseOk(
      book({
        deliverables: [D_OK, { ...D_OK, name: 'X', org: '주관' }],
        achievements: [
          { deliverableName: '논문 게재', title: '논문1', date: '2026-05-01', year: ' 2차년도 ', org: '공동기관' },
          { deliverableName: '논문 게재', title: '논문2', date: '2026-05-01', year: '2차 년도', org: '공동' },
        ],
      })
    );
    expect(rows.deliverables[1]?.orgId).toBeNull();
    expect(kinds(rows.deliverables[1]?.issues ?? [])).toEqual(['unknown-org']);
    const [ok, bad] = rows.achievements;
    expect(ok?.yearId).toBe('y-2');
    expect(ok?.orgId).toBe('o-2');
    expect(ok?.issues).toEqual([]);
    expect(bad?.yearId).toBeNull();
    expect(bad?.orgId).toBeNull();
    expect(kinds(bad?.issues ?? [])).toEqual(['unknown-year', 'unknown-org']);
  });

  it('연차·기관이 비면 null(오류 아님)', () => {
    const rows = parseOk(
      book({ deliverables: [D_OK], achievements: [{ deliverableName: '논문 게재', title: 'T', date: '2026-01-02' }] })
    );
    expect(rows.achievements[0]).toMatchObject({ yearId: null, orgId: null, memberIds: [], issues: [] });
  });

  it('관여자: ; 분리, 빈 조각 무시, 중복 제거, 동명 구분 라벨', () => {
    const rows = parseOk(
      book({
        deliverables: [D_OK],
        achievements: [
          { deliverableName: '논문 게재', title: 'T', date: '2026-01-02', members: '홍길동; ;김철수;홍길동 (2);홍길동;' },
        ],
      })
    );
    expect(rows.achievements[0]?.memberIds).toEqual(['m-1', 'm-2', 'm-3']);
    expect(rows.achievements[0]?.issues).toEqual([]);
  });

  it('관여자 이름 하나라도 모르면 blocking unknown-member (모르는 이름을 문구에)', () => {
    const rows = parseOk(
      book({
        deliverables: [D_OK],
        achievements: [{ deliverableName: '논문 게재', title: 'T', date: '2026-01-02', members: '홍길동;이영희;김철' }],
      })
    );
    const issue = rows.achievements[0]?.issues[0];
    expect(issue?.kind).toBe('unknown-member');
    expect(issue?.blocking).toBe(true);
    expect(issue?.message).toContain('이영희, 김철');
  });
});

// ─── 경계 (N-13) ─────────────────────────────────────────────

describe('숨김 id 경계', () => {
  it('_meta 목록 밖 숨김 id는 오류 행으로 남긴다', () => {
    const rows = parseOk(
      book({
        deliverables: [{ ...D_OK, deliverableId: 'd-x' }],
        techTargets: [{ ...T_OK, techTargetId: 't-x' }],
        records: [{ techTargetId: 't-1', recordId: 'r-x', techTargetName: '정확도', value: 1, date: '2026-01-01' }],
      })
    );
    expect(rows.deliverables[0]?.id).toBe('d-x');
    expect(kinds(rows.deliverables[0]?.issues ?? [])).toEqual(['unknown-id']);
    expect(kinds(rows.techTargets[0]?.issues ?? [])).toEqual(['unknown-id']);
    expect(kinds(rows.records[0]?.issues ?? [])).toContain('unknown-id');
  });

  it('기존 자식의 숨김 부모 id가 _meta 밖이면 오류', () => {
    const rows = parseOk(
      book({
        deliverables: [{ ...D_OK, deliverableId: 'd-1' }],
        achievements: [
          { deliverableId: 'd-x', achievementId: 'a-1', deliverableName: '논문 게재', title: 'T', date: '2026-01-02' },
        ],
      })
    );
    expect(rows.achievements[0]?.parent).toBeNull();
    expect(kinds(rows.achievements[0]?.issues ?? [])).toEqual(['unknown-id']);
  });

  it('같은 숨김 id가 여러 행이어도 파서는 그대로 두고 사유를 달지 않는다(duplicate-row는 미리보기)', () => {
    const rows = parseOk(book({ deliverables: [{ ...D_OK, deliverableId: 'd-1' }, { ...D_OK, deliverableId: 'd-1' }] }));
    expect(rows.deliverables.map((d) => d.id)).toEqual(['d-1', 'd-1']);
    expect(rows.deliverables.every((d) => d.issues.length === 0)).toBe(true);
  });
});

// ─── 숫자 해석 (GF-6) ────────────────────────────────────────

describe('GF-6 숫자 해석', () => {
  it('기술목표: ≤10은 10 + lower_better (방향 열이 비면 경고 없음)', () => {
    const rows = parseOk(book({ techTargets: [{ name: '지연', unit: 'ms', targetValue: '≤10' }] }));
    const t = rows.techTargets[0];
    expect(t?.targetValue).toBe(10);
    expect(t?.direction).toBe('lower_better');
    expect(t?.issues).toEqual([]);
  });

  it('힌트가 방향 열과 다르면 힌트 우선 + direction-overridden 경고', () => {
    const rows = parseOk(
      book({ techTargets: [{ name: '지연', unit: 'ms', direction: '높을수록 우수', years: ['20 이하', '15 이하', null] }] })
    );
    const t = rows.techTargets[0];
    expect(t?.direction).toBe('lower_better');
    expect(t?.targetValue).toBe(15);
    expect(kinds(t?.issues ?? [])).toEqual(['direction-overridden']);
    expect(t?.issues[0]?.blocking).toBe(false);
  });

  it('힌트가 방향 열과 같으면 경고 없음', () => {
    const rows = parseOk(book({ techTargets: [{ name: '지연', direction: '낮을수록 우수', targetValue: '10 이하' }] }));
    expect(rows.techTargets[0]?.issues).toEqual([]);
  });

  it('셀마다 힌트가 다르면 hint-conflict 경고, 방향은 방향 열(비면 higher)', () => {
    const rows = parseOk(
      book({
        techTargets: [
          { name: 'A', years: ['10 이상', '5 이하', null] },
          { name: 'B', direction: '목표값 일치', years: ['10 이상', null, null], targetValue: '5 이하' },
        ],
      })
    );
    expect(rows.techTargets[0]?.direction).toBe('higher_better');
    expect(kinds(rows.techTargets[0]?.issues ?? [])).toEqual(['hint-conflict']);
    expect(rows.techTargets[1]?.direction).toBe('target_exact');
    expect(kinds(rows.techTargets[1]?.issues ?? [])).toContain('hint-conflict');
  });

  it('국내수준·세계최고 셀의 힌트는 방향에 쓰지 않는다', () => {
    const rows = parseOk(
      book({ techTargets: [{ ...T_OK, baselineDomestic: '70 이하', worldBest: '95 이상' }] })
    );
    const t = rows.techTargets[0];
    expect(t?.direction).toBe('higher_better');
    expect(t?.baselineDomestic).toBe(70);
    expect(t?.worldBest).toBe(95);
    expect(t?.issues).toEqual([]);
  });

  it('성과목표 셀의 힌트는 무시한다(기술목표 연차·최종에서만)', () => {
    const rows = parseOk(book({ deliverables: [{ ...D_OK, years: ['1건 이상', 2, 3] }] }));
    expect(rows.deliverables[0]?.targetByYear['y-1']).toBe(1);
    expect(rows.deliverables[0]?.issues).toEqual([]);
  });

  it('LOD 2.5는 2.5 + unparsed-text 경고 + [원문] 비고', () => {
    const rows = parseOk(book({ techTargets: [{ name: '검출한계', unit: 'ppm', targetValue: 'LOD 2.5', note: '메모' }] }));
    const t = rows.techTargets[0];
    expect(t?.targetValue).toBe(2.5);
    expect(kinds(t?.issues ?? [])).toEqual(['unparsed-text']);
    expect(t?.note).toBe('메모\n[원문] 최종 목표: LOD 2.5');
  });

  it('숫자가 없으면 null + no-number 경고 + 원문 비고 (국내수준)', () => {
    const rows = parseOk(book({ techTargets: [{ ...T_OK, baselineDomestic: '해당 없음' }] }));
    const t = rows.techTargets[0];
    expect(t?.baselineDomestic).toBeNull();
    expect(kinds(t?.issues ?? [])).toEqual(['no-number']);
    expect(t?.note).toBe('[원문] 국내수준: 해당 없음');
  });

  it('원문 비고는 멱등 — 이미 같은 줄이 있으면 붙이지 않는다', () => {
    const rows = parseOk(
      book({ techTargets: [{ name: '검출한계', targetValue: 'LOD 2.5', note: '[원문] 최종 목표: LOD 2.5' }] })
    );
    expect(rows.techTargets[0]?.note).toBe('[원문] 최종 목표: LOD 2.5');
  });

  it('연차 열의 원문 비고 라벨은 _meta 연차 라벨이다(헤더 텍스트 무관)', () => {
    const sheets = book({});
    sheets[3] = sheetOf('techTargets', [{ name: 'X', years: ['약 3', null, null] }], ['A', 'B', 'C']);
    const rows = parseOk(sheets);
    expect(rows.techTargets[0]?.note).toBe('[원문] 1차년도: 약 3');
  });

  it('없음 기호(-, —, 없음)는 셀 전체일 때만 null, -5는 음수', () => {
    const rows = parseOk(
      book({ techTargets: [{ name: 'X', years: ['-', '—', '없음'], targetValue: '-5', baselineDomestic: '-' }] })
    );
    const t = rows.techTargets[0];
    expect(t?.targetByYear).toEqual({ 'y-1': null, 'y-2': null, 'y-3': null });
    expect(t?.targetValue).toBe(-5);
    expect(t?.baselineDomestic).toBeNull();
    expect(t?.issues).toEqual([]);
  });

  it('숫자 셀은 그대로 쓴다', () => {
    const rows = parseOk(book({ techTargets: [{ name: 'X', targetValue: 0.1 + 0.2, weight: 12.5 }] }));
    expect(rows.techTargets[0]?.targetValue).toBe(0.1 + 0.2);
    expect(rows.techTargets[0]?.weight).toBe(12.5);
  });

  it('측정값: 단위 접미는 부모 기술목표 단위로 뗀다', () => {
    const rows = parseOk(
      book({
        techTargets: [{ ...T_OK, techTargetId: 't-1' }],
        records: [{ techTargetName: '정확도', value: '92.5%', date: '2026-03-01' }],
      })
    );
    expect(rows.records[0]?.value).toBe(92.5);
    expect(rows.records[0]?.issues).toEqual([]);
  });

  it('가중치·비중 음수는 blocking negative-weight, 비면 0', () => {
    const rows = parseOk(
      book({
        deliverables: [{ ...D_OK, weight: -1 }, { ...D_OK, name: 'B' }],
        techTargets: [{ ...T_OK, weight: '-5' }, { ...T_OK, name: 'B', weight: '30%' }],
      })
    );
    expect(rows.deliverables[0]?.weight).toBeNull();
    expect(kinds(rows.deliverables[0]?.issues ?? [])).toEqual(['negative-weight']);
    expect(rows.deliverables[0]?.issues[0]?.blocking).toBe(true);
    expect(rows.deliverables[1]?.weight).toBe(0);
    expect(rows.techTargets[0]?.weight).toBeNull();
    expect(kinds(rows.techTargets[0]?.issues ?? [])).toEqual(['negative-weight']);
    expect(rows.techTargets[1]?.weight).toBe(30);
  });

  it('성과목표 건수(전체·연차)가 정수가 아니거나 음수면 blocking count-invalid', () => {
    const rows = parseOk(
      book({
        deliverables: [
          { ...D_OK, years: [1.5, 2, 3] },
          { ...D_OK, name: 'B', targetTotal: '2.5건' },
          { ...D_OK, name: 'C', years: [-1, 0, 0] },
        ],
      })
    );
    expect(kinds(rows.deliverables[0]?.issues ?? [])).toEqual(['count-invalid']);
    expect(rows.deliverables[0]?.targetByYear['y-1']).toBeNull();
    expect(kinds(rows.deliverables[1]?.issues ?? [])).toEqual(['count-invalid']);
    expect(rows.deliverables[1]?.targetTotal).toBeNull();
    expect(kinds(rows.deliverables[2]?.issues ?? [])).toEqual(['count-invalid']);
    expect(rows.deliverables.every((d) => d.issues.every((i) => i.blocking))).toBe(true);
  });

  it('성과목표 건수 문자열 `3건`은 단위 접미를 뗀다', () => {
    const rows = parseOk(book({ deliverables: [{ ...D_OK, years: ['3건', '1,000건', null] }] }));
    expect(rows.deliverables[0]?.targetByYear).toEqual({ 'y-1': 3, 'y-2': 1000, 'y-3': null });
    expect(rows.deliverables[0]?.issues).toEqual([]);
  });
});

// ─── GF-7 ────────────────────────────────────────────────────

describe('GF-7 목표 채우기', () => {
  it('기술목표 최종이 비면 값 있는 마지막 연차(yearIds 순)', () => {
    const rows = parseOk(book({ techTargets: [{ name: 'X', years: [5, 7, null] }] }));
    expect(rows.techTargets[0]?.targetValue).toBe(7);
    expect(rows.techTargets[0]?.issues).toEqual([]);
  });

  it('최종과 마지막 연차가 다르면 final-target-mismatch 경고, 최종으로', () => {
    const rows = parseOk(book({ techTargets: [{ name: 'X', years: [5, 7, null], targetValue: 8 }] }));
    expect(rows.techTargets[0]?.targetValue).toBe(8);
    expect(kinds(rows.techTargets[0]?.issues ?? [])).toEqual(['final-target-mismatch']);
    expect(rows.techTargets[0]?.issues[0]?.blocking).toBe(false);
  });

  it('최종만 있으면 그대로(연차 비어도 경고 없음)', () => {
    const rows = parseOk(book({ techTargets: [{ name: 'X', targetValue: 8 }] }));
    expect(rows.techTargets[0]?.targetValue).toBe(8);
    expect(rows.techTargets[0]?.issues).toEqual([]);
  });

  it('연차·최종이 모두 비면 blocking no-target', () => {
    const rows = parseOk(book({ techTargets: [{ name: 'X', unit: '%' }] }));
    expect(rows.techTargets[0]?.targetValue).toBeNull();
    expect(kinds(rows.techTargets[0]?.issues ?? [])).toEqual(['no-target']);
    expect(rows.techTargets[0]?.issues[0]?.blocking).toBe(true);
  });

  it('숫자로 못 푼 최종 + 빈 연차도 no-target', () => {
    const rows = parseOk(book({ techTargets: [{ name: 'X', targetValue: '미정' }] }));
    expect(kinds(rows.techTargets[0]?.issues ?? [])).toEqual(['no-number', 'no-target']);
  });

  it('성과목표 전체 목표가 비면 Σ연차(빈 칸 제외)', () => {
    const rows = parseOk(book({ deliverables: [{ ...D_OK, years: [1, null, 3] }] }));
    expect(rows.deliverables[0]?.targetTotal).toBe(4);
    expect(rows.deliverables[0]?.issues).toEqual([]);
  });

  it('성과목표 전체·연차 모두 비면 0', () => {
    const rows = parseOk(book({ deliverables: [{ ...D_OK, years: [] }] }));
    expect(rows.deliverables[0]?.targetTotal).toBe(0);
  });

  it('전체 목표 ≠ Σ연차면 total-mismatch 경고(D-3), 전체 목표로', () => {
    const rows = parseOk(book({ deliverables: [{ ...D_OK, targetTotal: 10 }] }));
    expect(rows.deliverables[0]?.targetTotal).toBe(10);
    expect(kinds(rows.deliverables[0]?.issues ?? [])).toEqual(['total-mismatch']);
    expect(rows.deliverables[0]?.issues[0]?.blocking).toBe(false);
  });

  it('전체 목표 = Σ연차면 경고 없음, 연차가 비고 전체만 있어도 경고 없음', () => {
    const rows = parseOk(
      book({ deliverables: [{ ...D_OK, targetTotal: 6 }, { ...D_OK, name: 'B', years: [], targetTotal: 4 }] })
    );
    expect(rows.deliverables.map((d) => d.issues)).toEqual([[], []]);
    expect(rows.deliverables[1]?.targetTotal).toBe(4);
  });
});

// ─── GF-9 필수값·기본값·길이 ─────────────────────────────────

describe('GF-9 필수값', () => {
  it('성과목표: 지표명·유형 없음 blocking, 단위 없으면 유형 기본 단위, 가중치 없으면 0', () => {
    const rows = parseOk(
      book({ deliverables: [{ unit: '건', years: [1] }, { type: '인력양성', name: '박사 배출' }] })
    );
    expect(kinds(rows.deliverables[0]?.issues ?? [])).toEqual(['no-type', 'no-name']);
    expect(rows.deliverables[1]).toMatchObject({ type: 'hr_training', unit: '명', weight: 0, issues: [] });
  });

  it('성과실적: 산출물명·달성일 없음 blocking', () => {
    const rows = parseOk(book({ deliverables: [D_OK], achievements: [{ deliverableName: '논문 게재', org: '주관기관' }] }));
    expect(kinds(rows.achievements[0]?.issues ?? [])).toEqual(['no-title', 'no-date']);
  });

  it('기술목표: 평가항목 없음 blocking, 방향 없음 higher_better, 측정방법 없음 self, 비중 없음 0', () => {
    const rows = parseOk(book({ techTargets: [{ unit: '%', years: [1, 2, 3] }, { name: 'B', targetValue: 3 }] }));
    expect(kinds(rows.techTargets[0]?.issues ?? [])).toEqual(['no-name']);
    expect(rows.techTargets[1]).toMatchObject({
      direction: 'higher_better',
      measureMethod: 'self',
      weight: 0,
      group: '',
      issues: [],
    });
  });

  it('측정이력: 측정값·측정일 없음 blocking, 방법 없으면 부모 measureMethod', () => {
    const rows = parseOk(
      book({
        techTargets: [{ ...T_OK, measureMethod: '전문가평가' }],
        records: [
          { techTargetName: '정확도', evaluator: 'KTL' },
          { techTargetName: '정확도', value: 88, date: '2026-04-01' },
          { techTargetName: '정확도', value: 88, date: '2026-04-01', method: '수요처평가' },
        ],
      })
    );
    expect(kinds(rows.records[0]?.issues ?? [])).toEqual(['no-value', 'no-date']);
    expect(rows.records[0]?.issues.every((i) => i.blocking)).toBe(true);
    expect(rows.records[1]?.method).toBe('expert_review');
    expect(rows.records[1]?.issues).toEqual([]);
    expect(rows.records[2]?.method).toBe('customer');
  });

  it('측정이력: 방법이 비었는데 부모 기술목표의 측정방법이 오류(모르는 라벨)면 blocking no-method', () => {
    const rows = parseOk(
      book({
        techTargets: [{ ...T_OK, measureMethod: '엉터리' }],
        records: [
          { techTargetName: '정확도', value: 88, date: '2026-04-01' },
          { techTargetName: '정확도', value: 88, date: '2026-04-01', method: '자체측정' },
        ],
      })
    );
    expect(kinds(rows.techTargets[0]?.issues ?? [])).toEqual(['unknown-label']);
    expect(rows.records[0]?.method).toBeNull();
    expect(rows.records[0]?.parent).toEqual({ kind: 'new', row: 2 });
    expect(kinds(rows.records[0]?.issues ?? [])).toEqual(['no-method']);
    expect(rows.records[0]?.issues[0]?.blocking).toBe(true);
    // 방법 칸을 적었으면 상속하지 않으므로 막지 않는다
    expect(rows.records[1]?.method).toBe('self');
    expect(rows.records[1]?.issues).toEqual([]);
  });

  it('측정이력: 기존 행(숨김 id)도 부모 측정방법이 오류면 no-method, 부모를 못 정한 행은 부모 사유만', () => {
    const rows = parseOk(
      book({
        techTargets: [{ ...T_OK, techTargetId: 't-1', measureMethod: '엉터리' }],
        records: [
          { techTargetId: 't-1', recordId: 'r-1', techTargetName: '정확도', value: 88, date: '2026-04-01' },
          { techTargetName: '없는 항목', value: 88, date: '2026-04-01' },
        ],
      })
    );
    expect(kinds(rows.records[0]?.issues ?? [])).toEqual(['no-method']);
    expect(kinds(rows.records[1]?.issues ?? [])).toEqual(['unknown-parent']);
  });

  it('숫자로 못 푼 측정값도 blocking no-value (경고와 함께)', () => {
    const rows = parseOk(
      book({ techTargets: [T_OK], records: [{ techTargetName: '정확도', value: '측정 불가', date: '2026-04-01' }] })
    );
    expect(kinds(rows.records[0]?.issues ?? [])).toEqual(['no-number', 'no-value']);
    expect(rows.records[0]?.note).toBe('[원문] 측정값: 측정 불가');
  });

  it.each([
    ['deliverables', 'name', GOAL_FORM_MAX_LENGTH.name],
    ['deliverables', 'unit', GOAL_FORM_MAX_LENGTH.unit],
    ['deliverables', 'evidenceMethod', GOAL_FORM_MAX_LENGTH.longText],
    ['deliverables', 'note', GOAL_FORM_MAX_LENGTH.note],
    ['techTargets', 'name', GOAL_FORM_MAX_LENGTH.name],
    ['techTargets', 'group', GOAL_FORM_MAX_LENGTH.group],
    ['techTargets', 'unit', GOAL_FORM_MAX_LENGTH.unit],
    ['techTargets', 'worldBestHolder', GOAL_FORM_MAX_LENGTH.worldBestHolder],
    ['techTargets', 'measureDescription', GOAL_FORM_MAX_LENGTH.note],
    ['techTargets', 'standardBasis', GOAL_FORM_MAX_LENGTH.longText],
    ['techTargets', 'basisRationale', GOAL_FORM_MAX_LENGTH.longText],
    ['techTargets', 'evaluationEnvironment', GOAL_FORM_MAX_LENGTH.longText],
    ['achievements', 'title', GOAL_FORM_MAX_LENGTH.title],
    ['achievements', 'evidenceUrl', GOAL_FORM_MAX_LENGTH.evidenceUrl],
    ['achievements', 'note', GOAL_FORM_MAX_LENGTH.note],
    ['records', 'evaluator', GOAL_FORM_MAX_LENGTH.evaluator],
    ['records', 'evidenceUrl', GOAL_FORM_MAX_LENGTH.evidenceUrl],
  ] as const)('%s.%s 길이 상한 %d — 같으면 통과, 넘으면 too-long', (sheet, role, max) => {
    const base: Record<string, RowInput> = {
      deliverables: D_OK,
      techTargets: T_OK,
      achievements: { deliverableName: '논문 게재', title: 'T', date: '2026-01-02' },
      records: { techTargetName: '정확도', value: 1, date: '2026-01-02' },
    };
    const parents: Book = { deliverables: [D_OK], techTargets: [T_OK] };
    const run = (len: number): GoalFormIssueKind[] => {
      const row = { ...base[sheet], [role]: 'x'.repeat(len) };
      const rows = parseOk(book({ ...parents, [sheet]: [row] }));
      // 이름을 바꾸면 부모 시트의 행이 자식과 이어지지 않으므로 대상 행만 본다
      const target = sheet === 'deliverables' || sheet === 'techTargets' ? rows[sheet][rows[sheet].length - 1] : rows[sheet][0];
      return kinds(target?.issues ?? []);
    };
    expect(run(max)).not.toContain('too-long');
    expect(run(max + 1)).toContain('too-long');
  });

  it('GF-6 원문 줄을 붙인 뒤의 비고 길이로 판정한다', () => {
    const note = 'x'.repeat(GOAL_FORM_MAX_LENGTH.note - 5);
    const rows = parseOk(book({ techTargets: [{ ...T_OK, baselineDomestic: '약 70', note }] }));
    expect(kinds(rows.techTargets[0]?.issues ?? [])).toEqual(['unparsed-text', 'too-long']);
  });

  it('엑셀 오류 칸은 blocking cell-error', () => {
    const rows = parseOk(
      book({ deliverables: [{ ...D_OK, evidenceMethod: { value: '#REF!', isError: true, errorText: '#REF!' } }] })
    );
    expect(kinds(rows.deliverables[0]?.issues ?? [])).toEqual(['cell-error']);
  });
});

// ─── 날짜 ────────────────────────────────────────────────────

describe('날짜 (readSheetDate 재사용)', () => {
  it('직렬값·yyyy-mm-dd 문자열 → ISO, 그 밖은 invalid-date', () => {
    const rows = parseOk(
      book({
        deliverables: [D_OK],
        achievements: [
          { deliverableName: '논문 게재', title: 'A', date: 46086 },
          { deliverableName: '논문 게재', title: 'B', date: '2026-03-05' },
          { deliverableName: '논문 게재', title: 'C', date: '2026/03/05' },
          { deliverableName: '논문 게재', title: 'D', date: '2026-02-30' },
          { deliverableName: '논문 게재', title: 'E', date: 46086.5 },
        ],
      })
    );
    expect(rows.achievements.map((a) => a.date)).toEqual(['2026-03-05', '2026-03-05', null, null, null]);
    expect(rows.achievements.slice(2).map((a) => kinds(a.issues))).toEqual([
      ['invalid-date'],
      ['invalid-date'],
      ['invalid-date'],
    ]);
  });
});

// ─── 부모 연결 (GF-10) ───────────────────────────────────────

describe('부모 연결', () => {
  const PARENTS: Book = {
    deliverables: [
      { ...D_OK, deliverableId: 'd-1', name: '논문 게재' },
      { ...D_OK, name: '특허 출원' },
    ],
    techTargets: [
      { ...T_OK, techTargetId: 't-1', name: '정확도' },
      { ...T_OK, name: '속도' },
    ],
  };

  it('기존 행은 숨김 부모 id로 잇는다 (existing)', () => {
    const rows = parseOk(
      book({
        ...PARENTS,
        achievements: [
          { deliverableId: 'd-1', achievementId: 'a-1', deliverableName: '논문 게재', title: 'T', date: '2026-01-02' },
        ],
        records: [{ techTargetId: 't-1', recordId: 'r-1', techTargetName: '정확도', value: 1, date: '2026-01-02' }],
      })
    );
    expect(rows.achievements[0]?.parent).toEqual({ kind: 'existing', id: 'd-1' });
    expect(rows.achievements[0]?.issues).toEqual([]);
    expect(rows.records[0]?.parent).toEqual({ kind: 'existing', id: 't-1' });
  });

  it('새 행은 같은 파일 이름 완전 일치 — 기존 부모면 existing, 새 부모면 new(시트 행 번호)', () => {
    const rows = parseOk(
      book({
        ...PARENTS,
        achievements: [
          { deliverableName: '논문 게재', title: 'A', date: '2026-01-02' },
          { deliverableName: ' 특허 출원 ', title: 'B', date: '2026-01-02' },
        ],
        records: [{ techTargetName: '속도', value: 30, date: '2026-01-02' }],
      })
    );
    expect(rows.achievements.map((a) => a.parent)).toEqual([
      { kind: 'existing', id: 'd-1' },
      { kind: 'new', row: 3 },
    ]);
    expect(rows.records[0]?.parent).toEqual({ kind: 'new', row: 3 });
    expect(rows.achievements[1]?.parentName).toBe('특허 출원');
  });

  it('새 행 이름이 둘 이상이면 blocking ambiguous-parent', () => {
    const rows = parseOk(
      book({
        deliverables: [D_OK, { ...D_OK, deliverableId: 'd-1' }],
        achievements: [{ deliverableName: '논문 게재', title: 'A', date: '2026-01-02' }],
      })
    );
    expect(rows.achievements[0]?.parent).toBeNull();
    expect(kinds(rows.achievements[0]?.issues ?? [])).toEqual(['ambiguous-parent']);
  });

  it('새 행 이름이 없거나 비면 blocking unknown-parent (퍼지 매칭 없음)', () => {
    const rows = parseOk(
      book({
        ...PARENTS,
        achievements: [
          { deliverableName: '논문게재', title: 'A', date: '2026-01-02' },
          { title: 'B', date: '2026-01-02' },
        ],
      })
    );
    expect(rows.achievements.map((a) => kinds(a.issues))).toEqual([['unknown-parent'], ['unknown-parent']]);
    expect(rows.achievements.every((a) => a.parent === null)).toBe(true);
  });

  it('기존 행의 이름 열이 같은 파일 다른 부모 행의 이름이면 blocking parent-moved', () => {
    const rows = parseOk(
      book({
        ...PARENTS,
        achievements: [
          { deliverableId: 'd-1', achievementId: 'a-1', deliverableName: '특허 출원', title: 'T', date: '2026-01-02' },
        ],
        records: [{ techTargetId: 't-1', recordId: 'r-1', techTargetName: '속도', value: 1, date: '2026-01-02' }],
      })
    );
    expect(rows.achievements[0]?.parent).toBeNull();
    expect(kinds(rows.achievements[0]?.issues ?? [])).toEqual(['parent-moved']);
    expect(rows.achievements[0]?.issues[0]?.blocking).toBe(true);
    expect(kinds(rows.records[0]?.issues ?? [])).toEqual(['parent-moved']);
  });

  it('부모 이름만 고치고 실적 행은 옛 이름 그대로면 사유 없이 숨김 id를 따른다(§11 이름 변경)', () => {
    const rows = parseOk(
      book({
        deliverables: [{ ...D_OK, deliverableId: 'd-1', name: '논문 게재(개정)' }],
        techTargets: [{ ...T_OK, techTargetId: 't-1', name: '인식 정확도' }],
        achievements: [
          { deliverableId: 'd-1', achievementId: 'a-1', deliverableName: '논문 게재', title: 'T', date: '2026-01-02' },
        ],
        records: [{ techTargetId: 't-1', recordId: 'r-1', techTargetName: '정확도', value: 1, date: '2026-01-02' }],
      })
    );
    expect(rows.achievements[0]?.parent).toEqual({ kind: 'existing', id: 'd-1' });
    expect(rows.achievements[0]?.issues).toEqual([]);
    expect(rows.records[0]?.parent).toEqual({ kind: 'existing', id: 't-1' });
    expect(rows.records[0]?.issues).toEqual([]);
  });

  it('어느 부모와도 안 맞는 이름이면 사유 없이 숨김 id를 따른다', () => {
    const rows = parseOk(
      book({
        ...PARENTS,
        achievements: [
          { deliverableId: 'd-1', achievementId: 'a-1', deliverableName: '엉뚱한 이름', title: 'T', date: '2026-01-02' },
        ],
      })
    );
    expect(rows.achievements[0]?.parent).toEqual({ kind: 'existing', id: 'd-1' });
    expect(rows.achievements[0]?.issues).toEqual([]);
  });

  it('기존 행의 이름 열이 비면 숨김 부모 id를 따른다', () => {
    const rows = parseOk(
      book({
        ...PARENTS,
        achievements: [{ deliverableId: 'd-1', achievementId: 'a-1', title: 'T', date: '2026-01-02' }],
      })
    );
    expect(rows.achievements[0]?.parent).toEqual({ kind: 'existing', id: 'd-1' });
    expect(rows.achievements[0]?.issues).toEqual([]);
  });

  it('시트에서 지운 부모(_meta엔 있음)를 숨김 id로 가리키는 기존 자식은 blocking orphan-child', () => {
    const rows = parseOk(
      book({
        ...PARENTS,
        achievements: [
          { deliverableId: 'd-2', achievementId: 'a-1', deliverableName: '옛 지표', title: 'T', date: '2026-01-02' },
        ],
        records: [{ techTargetId: 't-2', recordId: 'r-1', techTargetName: '옛 항목', value: 1, date: '2026-01-02' }],
      })
    );
    expect(kinds(rows.achievements[0]?.issues ?? [])).toEqual(['orphan-child']);
    expect(rows.achievements[0]?.parent).toBeNull();
    expect(kinds(rows.records[0]?.issues ?? [])).toEqual(['orphan-child']);
  });

  it('부모 행이 빈 행(숨김 id만 남음)이면 지운 부모다 — orphan-child', () => {
    const rows = parseOk(
      book({
        deliverables: [{ deliverableId: 'd-1' }],
        achievements: [
          { deliverableId: 'd-1', achievementId: 'a-1', deliverableName: '논문 게재', title: 'T', date: '2026-01-02' },
        ],
      })
    );
    expect(rows.deliverables).toEqual([]);
    expect(kinds(rows.achievements[0]?.issues ?? [])).toEqual(['orphan-child']);
  });

  it('기존 자식의 숨김 부모 id가 비면 blocking missing-parent-id', () => {
    const rows = parseOk(
      book({
        ...PARENTS,
        achievements: [{ achievementId: 'a-1', deliverableName: '논문 게재', title: 'T', date: '2026-01-02' }],
      })
    );
    expect(kinds(rows.achievements[0]?.issues ?? [])).toEqual(['missing-parent-id']);
  });
});

// ─── 사유 표 ─────────────────────────────────────────────────

describe('GOAL_FORM_ISSUES', () => {
  it('미리보기(T9)가 쓸 코드도 표에 있다', () => {
    expect(GOAL_FORM_ISSUES['duplicate-row'].blocking).toBe(true);
    expect(GOAL_FORM_ISSUES['parent-moved'].blocking).toBe(true);
    expect(GOAL_FORM_ISSUES.conflict.blocking).toBe(false);
    expect(GOAL_FORM_ISSUES['weight-sum'].blocking).toBe(false);
  });

  it('GF-6·GF-7 경고는 막지 않고, GF-9·GF-10 오류는 막는다', () => {
    for (const kind of ['unparsed-text', 'no-number', 'hint-conflict', 'direction-overridden', 'final-target-mismatch', 'total-mismatch'] as const) {
      expect(GOAL_FORM_ISSUES[kind].blocking).toBe(false);
    }
    for (const kind of ['no-target', 'negative-weight', 'count-invalid', 'ambiguous-parent', 'unknown-parent', 'orphan-child'] as const) {
      expect(GOAL_FORM_ISSUES[kind].blocking).toBe(true);
    }
  });
});

// ─── 경계 ────────────────────────────────────────────────────

describe('의존 경계', () => {
  it('parse.ts는 xlsx·exceljs·supabase를 import하지 않는다', () => {
    const source = fs.readFileSync(path.join(process.cwd(), 'lib/goal-form/parse.ts'), 'utf8');
    const imports = [...source.matchAll(/from\s+'([^']+)'/g)].map((m) => m[1]);
    for (const spec of imports) {
      expect(spec).not.toMatch(/^(xlsx|exceljs)$|supabase/);
    }
  });
});
