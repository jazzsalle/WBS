// 계획서 표 행 해석·이름 대응·`_meta` 합성 (SOT §6.18 HX-5~HX-8, 부록 C.3.2~C.3.6, S-9~S-11·S-16~S-18·S-20·S-22·S-29, U-1~U-8)
//
// 격자는 tests/fixtures/hwpx/README.md의 합성 표 모양을 손으로 만든 것이고 식별은 실제 identifyPlanTables(T5)를 탄다.
// 결과를 previewGoalForm({ allowDeletes: false })에 넣어 추가·멱등·투영 보존·삭제 후보 0을 함께 본다(HX-8).
// 끝의 한 묶음만 합성 XML 픽스처를 extractHwpxTables로 뽑아 건수·구조를 확인한다.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { previewGoalForm } from '@/lib/goal-form/preview';
import type { GoalFormPreview } from '@/lib/goal-form/preview';
import { extractHwpxTables } from '@/lib/hwpx/extract';
import {
  buildPlanRows,
  deliverableNameOf,
  deliverableTypeOf,
  isTimeUnit,
  measureMethodOf,
  planNameKey,
  stripBasisRationale,
} from '@/lib/hwpx/rows';
import type { BuildPlanRowsInput, PlanRowsResult } from '@/lib/hwpx/rows';
import { identifyPlanTables } from '@/lib/hwpx/tables';
import type { HwpxTable } from '@/lib/hwpx/types';
import type { Deliverable, TechTarget } from '@/types';

// ─── 격자 ────────────────────────────────────────────────────

function grid(index: number, cells: string[][]): HwpxTable {
  return { index, section: 0, rowCnt: cells.length, colCnt: cells[0]!.length, cells };
}

const TECH_H0 = [
  '평가 항목\n(주요성능\nSpec',
  '평가 항목\n(주요성능\nSpec',
  '단위',
  '전체 항목\n에서 차지하는\n비중\n(%)',
  '세계최고 수준 보유국/\n보유기업\n(   /   )',
  '연구개발 전 국내수준',
  '개발 목표치',
  '개발 목표치',
  '개발 목표치',
  '개발 목표치',
  '표준\n(시험)\n․\n인증\n기준',
  '기준\n설정\n근거',
  '평가 방법',
  '담당\n연구\n개발\n기관',
];
const TECH_H1 = [...TECH_H0.slice(0, 4), '성능수준', '성능수준', '1차\n년도', '2차\n년도', '3차\n년도', '4차\n년도', ...TECH_H0.slice(10)];

interface TechSpec {
  name: string;
  unit?: string;
  weight?: string;
  years?: [string, string, string, string];
  method?: string;
  org?: string;
  group?: string;
}

// 세계최고·국내수준·표준·기준설정근거 칸에는 값을 넣어 둔다 — 읽지 않아야 한다(U-2)
function techCells(s: TechSpec): string[] {
  const y = s.years ?? ['10', '20', '30', '40'];
  return [s.group ?? '합성 구분', s.name, s.unit ?? '%', s.weight ?? '10', '95(가상국/가상사)', '50', ...y, 'KS 합성', '합성 근거', s.method ?? '자체 평가', s.org ?? '가나기술'];
}

function techTable(index: number, rows: string[][]): HwpxTable {
  return grid(index, [[...TECH_H0], [...TECH_H1], ...rows]);
}

const DEL_H0 = ['구분', '항목', '항목', '항목', '단위', '가중치', '개발 목표치', '개발 목표치', '개발 목표치', '개발 목표치', '개발 목표치', '평가방법'];
const DEL_H1 = ['구분', '항목', '항목', '항목', '단위', '가중치', '1차\n년도', '2차\n년도', '3차\n년도', '4차\n년도', '계', '평가방법'];

function deliverableTable(index: number, rows: string[][]): HwpxTable {
  return grid(index, [[...DEL_H0], [...DEL_H1], ...rows]);
}

// 합성 성과목표 행 — 실측 표 모양(특허 4종·SMART·SCI·Impact Factor·비SCI·학술대회·시제품)
const DEL_ROWS: string[][] = [
  ['사업별\n성과지표', '인력양성 효과', '인력양성 효과', '인력양성 효과', '명', '10', '1', '1', '1', '1', '4', '재직증명'],
  ['사업별\n성과지표', '소프트웨어 등록', '소프트웨어 등록', '소프트웨어 등록', '건', '10', '-', '1', '-', '1', '2', '등록증'],
  ['특허', '국내', '등록', '건수', '건', '15', '-', '1', '1', '1', '3', '등록증'],
  ['특허', '국내', '등록', 'SMART(1∼9) 평균*', '점수', '-', '-', '-', '-', '-', '-', '-'],
  ['특허', '국내', '출원', '출원', '건', '10', '1', '1', '1', '1', '4', '출원서'],
  ['특허', '국외', '등록', '건수', '건', '-', '-', '-', '-', '-', '-', '-'],
  ['특허', '국외', '등록', 'SMART(1∼9) 평균', '점수', '-', '-', '-', '-', '-', '-', '-'],
  ['특허', '국외', '출원', '출원', '건', '5', '-', '-', '1', '-', '1', '출원서'],
  [' 학술', 'SCI급 게재논문', 'SCI급 게재논문', '게재', '건', '10', '-', '1', '1', '1', '3', '게재 증빙\n논문 사본'],
  [' 학술', 'SCI급 게재논문', 'SCI급 게재논문', 'Impact Factor 평균', '', '-', '-', '-', '-', '-', '-', '-'],
  [' 학술', '비SCI급 게재논문', '비SCI급 게재논문', '비SCI급 게재논문', '건', '10', '1', '1', '1', '1', '4', '게재 증빙'],
  [' 학술', '학술대회', '학술대회', '학술대회', '건', '10', '1', '1', '1', '1', '4', '발표 증빙'],
  ['상용화', '시제품', '시제품', '시제품', '건', '20', '-', '-', '1', '1', '2', '시제품 사진 & 보고서'],
];

const METHOD_H0 = ['순번', '평가항목\n(성능지표)', '평가방법', '평가환경'];

function methodTable(index: number, rows: string[][]): HwpxTable {
  return grid(index, [[...METHOD_H0], ...rows]);
}

// ─── 과제 ────────────────────────────────────────────────────

const PROJECT = 'proj-1';
const ENTITY = { createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z', createdBy: null, updatedBy: null };

function years(n: number): BuildPlanRowsInput['years'] {
  // 순서가 뒤섞여 들어와도 order로 정렬해야 한다
  return Array.from({ length: n }, (_, i) => ({ id: `y-${i + 1}`, name: `${i + 1}차년도`, order: i })).reverse();
}

const ORGS = [
  { id: 'o-1', name: '가나기술' },
  { id: 'o-2', name: '다라연구원' },
];

function techTarget(id: string, over: Partial<TechTarget> = {}): TechTarget {
  return {
    ...ENTITY,
    id,
    version: 3,
    projectId: PROJECT,
    name: `기존 ${id}`,
    group: '',
    unit: '%',
    direction: 'higher_better',
    weight: 10,
    targetValue: 1,
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
    order: 0,
    ...over,
  };
}

function deliverable(id: string, over: Partial<Deliverable> = {}): Deliverable {
  return {
    ...ENTITY,
    id,
    version: 2,
    projectId: PROJECT,
    type: 'other',
    name: `기존 ${id}`,
    unit: '건',
    weight: 0,
    targetTotal: 0,
    targetByYear: {},
    achievements: [],
    orgId: null,
    evidenceMethod: '',
    note: '',
    order: 0,
    ...over,
  };
}

interface Scenario {
  tables: HwpxTable[];
  yearCount?: number;
  current?: { deliverables: Deliverable[]; techTargets: TechTarget[] };
}

function run(s: Scenario): PlanRowsResult {
  return buildPlanRows({
    projectId: PROJECT,
    tables: identifyPlanTables(s.tables),
    years: years(s.yearCount ?? 4),
    orgs: ORGS,
    current: s.current ?? { deliverables: [], techTargets: [] },
  });
}

function preview(result: PlanRowsResult, current: { deliverables: Deliverable[]; techTargets: TechTarget[] }): GoalFormPreview {
  return previewGoalForm({
    meta: result.meta,
    rows: result.rows,
    current,
    linkedTaskCounts: { deliverable: {}, techTarget: {} },
    options: { allowDeletes: false, includeDeletes: false },
  });
}

function kinds(issues: readonly { kind: string }[]): string[] {
  return issues.map((i) => i.kind);
}

function techByName(r: PlanRowsResult, name: string) {
  const row = r.rows.techTargets.find((t) => t.name === name);
  if (row === undefined) throw new Error(`기술목표 행 없음: ${name}`);
  return row;
}

function deliverableByName(r: PlanRowsResult, name: string) {
  const row = r.rows.deliverables.find((d) => d.name === name);
  if (row === undefined) throw new Error(`성과목표 행 없음: ${name}`);
  return row;
}

// 표준 시나리오: 기술목표 7행 + 성과목표 13행(제외 3) + 평가방법 7행
const TECH_ROWS: string[][] = [
  techCells({ name: '1. 합성 응답시간', unit: '초', weight: '20', years: ['≤10', '≤8', '≤5', '≤5'], method: '공인기관\n시험평가', org: '가나기술' }),
  techCells({ name: '2. 합성 처리 지연', unit: 'ms', weight: '10', years: ['100', '90', '80', '70'], method: '전문가\n평가' }),
  techCells({ name: '3. 합성 탐지 정확도 (가상 조건)', unit: '%', weight: '20', years: ['≥60', '≥70', '≥80', '≥90'], method: '수요기업 사용자 평가' }),
  techCells({ name: '4. 합성 탐지율', unit: '%', weight: '10', years: ['60%', '70%', '', ''], method: '' }),
  techCells({ name: '5. 합성 검출한계', unit: 'LOD', weight: '10', years: ['', '', 'LOD 2.5', '< 3'], method: '자체\n평가' }),
  techCells({ name: '6. 합성 연계 시스템', unit: '건', weight: '20', years: ['1,000', '2,000', '3,000', '4,000'], method: '시뮬레이션 기반 검증', org: '다라\n연구원' }),
  techCells({ name: '7. 합성 가용률', unit: '%', weight: '10', years: ['99', '99', '99', '99'], org: '마바대학' }),
];

const METHOD_ROWS: string[][] = [
  ['1', '합성 응답시간', '측정 방법 1\n둘째 줄', '환경 1\n[기준설정 근거] : 버릴 문단\n버릴 뒤 문단'],
  ['2', '합성 처리\n지연', '측정 방법 2', '환경 2 안의 [기준설정 근거] 문구는 문단 머리가 아니다'],
  ['3', '합성 탐지 정확도(가상 조건)', '측정 방법 3', '-'],
  ['4', '합성 탐지율', '측정 방법 4', ''],
  ['5', '합성 검출한계', '', '[기준설정 근거] : 전부 버림'],
  ['6', '합성 연계 시스템', '측정 방법 6', '환경 6'],
  ['7', '합성 가용률', '측정 방법 7', '환경 7'],
];

function standardTables(): HwpxTable[] {
  return [techTable(0, TECH_ROWS), deliverableTable(1, DEL_ROWS), methodTable(2, METHOD_ROWS)];
}

// ─── 순수 판정 함수 ──────────────────────────────────────────

describe('판정 함수', () => {
  it('이름 키 = NFC + 공백 제거, 괄호·대소문자 유지(S-17)', () => {
    expect(planNameKey(' 합성  탐지\n정확도 ')).toBe('합성탐지정확도');
    expect(planNameKey('정확도(A)')).not.toBe(planNameKey('정확도(B)'));
    expect(planNameKey('Speed')).not.toBe(planNameKey('speed'));
    // 분해형 한글(NFD)도 같은 키
    expect(planNameKey('가나'.normalize('NFD'))).toBe(planNameKey('가나'));
  });

  it('시간 단위는 완전 일치만(C.3.6)', () => {
    expect(isTimeUnit('초')).toBe(true);
    expect(isTimeUnit(' MS ')).toBe(true);
    expect(isTimeUnit('m/s')).toBe(false);
    expect(isTimeUnit('')).toBe(false);
  });

  it.each([
    ['공인기관\n시험평가', 'certified_lab'],
    ['전문가 평가', 'expert_review'],
    ['수요기업 사용자 평가', 'customer'],
    ['자체 평가', 'self'],
    ['', 'self'],
    ['시뮬레이션 기반 검증', 'other'],
  ] as const)('평가방법 %j → %s (C.3.3)', (raw, method) => {
    expect(measureMethodOf(raw)).toBe(method);
  });

  it.each([
    [['사업별 성과지표', '인력양성 효과', '인력양성 효과', '인력양성 효과'], '인력양성 효과'],
    [['사업별 성과지표', '소프트웨어 등록', '소프트웨어 등록', '소프트웨어 등록'], '소프트웨어 등록'],
    [['특허', '국내', '출원', '출원'], '특허 국내출원 건수'],
    [['특허', '국내', '등록', '건수'], '특허 국내등록 건수'],
    [['특허', '국외', '출원', '출원'], '특허 국외출원 건수'],
    [['특허', '국외', '등록', '건수'], '특허 국외등록 건수'],
    [['학술', 'SCI급 게재논문', 'SCI급 게재논문', '게재'], 'SCI급 게재논문 게재'],
    [['학술', '비SCI급 게재논문', '비SCI급 게재논문', '비SCI급 게재논문'], '비SCI급 게재논문'],
    [['학술', '학술대회', '학술대회', '학술대회'], '학술대회'],
    [['상용화', '시제품', '시제품', '시제품'], '시제품'],
  ] as const)('지표명 %j → %s (U-6)', ([category, ...items], name) => {
    expect(deliverableNameOf(category, items)).toBe(name);
  });

  it('구분이 항목까지 병합된 행은 구분을 이름으로 쓴다', () => {
    expect(deliverableNameOf('기타 성과', ['기타 성과', '기타 성과'])).toBe('기타 성과');
  });

  it('SCI 게재 → paper_sci, 비SCI → paper_domestic(S-7), 인력양성 → hr_training', () => {
    expect(deliverableTypeOf('SCI급 게재논문 게재')).toBe('paper_sci');
    expect(deliverableTypeOf('비SCI급 게재논문')).toBe('paper_domestic');
    expect(deliverableTypeOf('인력양성 효과')).toBe('hr_training');
    expect(deliverableTypeOf('합성 기타')).toBe('other');
  });

  it('[기준설정 근거]는 문단 머리일 때만 그 문단부터 버린다(U-8)', () => {
    expect(stripBasisRationale('환경\n[기준설정 근거] : x\ny')).toBe('환경');
    expect(stripBasisRationale('환경\n  [기준설정근거] x')).toBe('환경');
    expect(stripBasisRationale('환경 [기준설정 근거] 문구')).toBe('환경 [기준설정 근거] 문구');
    expect(stripBasisRationale('[기준설정 근거] : 전부')).toBe('');
  });
});

// ─── 빈 과제 → 전 행 추가 ────────────────────────────────────

describe('빈 과제 (HX-8)', () => {
  const r = run({ tables: standardTables() });
  const p = preview(r, { deliverables: [], techTargets: [] });

  it('기술목표 7 · 성과목표 10 전 행 add, 삭제 후보 0, 실적·측정 0', () => {
    expect(r.rows.techTargets).toHaveLength(7);
    expect(r.rows.deliverables).toHaveLength(10);
    expect(r.rows.achievements).toEqual([]);
    expect(r.rows.records).toEqual([]);
    expect(p.rows.techTargets.every((row) => row.status === 'add')).toBe(true);
    expect(p.rows.deliverables.every((row) => row.status === 'add')).toBe(true);
    expect(p.deleteCandidates).toEqual([]);
    expect(p.blocked).toBe(false);
    expect(p.counts.add).toBe(17);
  });

  it('meta 합성(S-11)', () => {
    expect(r.meta).toEqual({
      formVersion: 1,
      projectId: PROJECT,
      generatedAt: '',
      years: [
        { id: 'y-1', label: '1차년도' },
        { id: 'y-2', label: '2차년도' },
        { id: 'y-3', label: '3차년도' },
        { id: 'y-4', label: '4차년도' },
      ],
      orgs: [
        { id: 'o-1', label: '가나기술' },
        { id: 'o-2', label: '다라연구원' },
      ],
      members: [],
      deliverables: {},
      achievements: {},
      techTargets: {},
      records: {},
    });
  });

  it('표 단위 사유 없음(연차 수 일치·평가방법 전부 연결)', () => {
    expect(r.issues).toEqual([]);
  });

  it('locations — "기술목표 표 N행 (순번 k)" / "성과목표 표 N행"(S-10)', () => {
    expect(r.locations.techTargets[1]).toBe('기술목표 표 1행 (순번 1)');
    expect(r.locations.techTargets[7]).toBe('기술목표 표 7행 (순번 7)');
    // 성과목표 sheetRow는 제외 행을 포함한 표 데이터 행 순번이다 — 3행 다음은 5행
    expect(Object.keys(r.locations.deliverables).map(Number)).toEqual([1, 2, 3, 5, 6, 8, 9, 11, 12, 13]);
    expect(r.locations.deliverables[13]).toBe('성과목표 표 13행');
  });
});

// ─── HX-5 기술목표 ───────────────────────────────────────────

describe('HX-5 기술목표 행', () => {
  const r = run({ tables: standardTables() });

  it('이름은 `N.` 접두를 떼고 한 줄로(U-1), 구분은 채우지 않는다', () => {
    expect(r.rows.techTargets.map((t) => t.name)).toEqual([
      '합성 응답시간',
      '합성 처리 지연',
      '합성 탐지 정확도 (가상 조건)',
      '합성 탐지율',
      '합성 검출한계',
      '합성 연계 시스템',
      '합성 가용률',
    ]);
    expect(r.rows.techTargets.every((t) => t.group === '')).toBe(true);
  });

  it('세계최고·국내수준·표준·기준설정근거는 읽지 않는다(U-2) — 새 행 null/""', () => {
    for (const t of r.rows.techTargets) {
      expect(t.worldBest).toBeNull();
      expect(t.baselineDomestic).toBeNull();
      expect(t.worldBestHolder).toBe('');
      expect(t.standardBasis).toBe('');
      expect(t.basisRationale).toBe('');
    }
  });

  it('방향: 힌트 lower(≤) · 시간 단위 lower(ms) · 힌트 higher(≥) · 기본 higher(U-3)', () => {
    expect(techByName(r, '합성 응답시간').direction).toBe('lower_better');
    expect(techByName(r, '합성 처리 지연').direction).toBe('lower_better');
    expect(techByName(r, '합성 탐지 정확도 (가상 조건)').direction).toBe('higher_better');
    expect(techByName(r, '합성 탐지율').direction).toBe('higher_better');
  });

  it('`<` 힌트(실측 `< 5`) — 검출한계는 lower', () => {
    expect(techByName(r, '합성 검출한계').direction).toBe('lower_better');
  });

  it('연차 목표·최종 목표 = 값 있는 마지막 연차(GF-7)', () => {
    const t = techByName(r, '합성 탐지율');
    expect(t.targetByYear).toEqual({ 'y-1': 60, 'y-2': 70, 'y-3': null, 'y-4': null });
    expect(t.targetValue).toBe(70);
    expect(techByName(r, '합성 연계 시스템').targetValue).toBe(4000);
    expect(techByName(r, '합성 응답시간').targetByYear).toEqual({ 'y-1': 10, 'y-2': 8, 'y-3': 5, 'y-4': 5 });
  });

  it('숫자 원문 경고 — 첫 숫자 + 비고 [원문] + unparsed-text', () => {
    const t = techByName(r, '합성 검출한계');
    expect(t.targetByYear['y-3']).toBe(2.5);
    expect(kinds(t.issues)).toContain('unparsed-text');
    expect(t.note).toBe('[원문] 3차년도: LOD 2.5');
  });

  it('비중 → weight', () => {
    expect(r.rows.techTargets.map((t) => t.weight)).toEqual([20, 10, 20, 10, 10, 20, 10]);
  });

  it('평가방법 → measureMethod 4종 + 빈 칸 self + 기타(other + 비고 + method-other)', () => {
    expect(r.rows.techTargets.map((t) => t.measureMethod)).toEqual([
      'certified_lab',
      'expert_review',
      'customer',
      'self',
      'self',
      'other',
      'self',
    ]);
    const other = techByName(r, '합성 연계 시스템');
    expect(kinds(other.issues)).toContain('method-other');
    expect(other.note).toContain('[원문] 평가방법: 시뮬레이션 기반 검증');
  });

  it('담당기관: 이름 키 완전 일치(개행 무시) → orgId, 실패 → 비고 [담당기관] + org-unmatched', () => {
    expect(techByName(r, '합성 응답시간').orgId).toBe('o-1');
    expect(techByName(r, '합성 연계 시스템').orgId).toBe('o-2');
    const miss = techByName(r, '합성 가용률');
    expect(miss.orgId).toBeNull();
    expect(miss.note).toBe('[담당기관] 마바대학');
    expect(kinds(miss.issues)).toEqual(['org-unmatched']);
    expect(miss.issues[0]!.blocking).toBe(false);
  });

  it('힌트가 셀마다 다르면 hint-conflict 경고 + 단위 규칙으로', () => {
    const r2 = run({ tables: [techTable(0, [techCells({ name: '1. 상충', unit: '%', years: ['≥1', '≤2', '3', '4'] })])] });
    const t = r2.rows.techTargets[0]!;
    expect(t.direction).toBe('higher_better');
    expect(kinds(t.issues)).toContain('hint-conflict');
  });

  it('연차 목표가 전부 비면 blocking no-target', () => {
    const r2 = run({ tables: [techTable(0, [techCells({ name: '1. 빈 목표', years: ['-', '', '-', ''] })])] });
    const t = r2.rows.techTargets[0]!;
    expect(t.targetValue).toBeNull();
    expect(t.issues.find((i) => i.kind === 'no-target')?.blocking).toBe(true);
    expect(preview(r2, { deliverables: [], techTargets: [] }).blocked).toBe(true);
  });

  it('비중 음수 → blocking negative-weight', () => {
    const r2 = run({ tables: [techTable(0, [techCells({ name: '1. 음수', weight: '-5' })])] });
    expect(r2.rows.techTargets[0]!.issues.find((i) => i.kind === 'negative-weight')?.blocking).toBe(true);
  });

  it('완전히 빈 데이터 행은 건너뛰고 sheetRow는 표 순번을 유지한다', () => {
    const blank = Array.from({ length: TECH_H0.length }, () => ' ');
    const r2 = run({ tables: [techTable(0, [techCells({ name: '1. 가' }), blank, techCells({ name: '2. 나' })])] });
    expect(r2.rows.techTargets.map((t) => [t.sheetRow, t.name])).toEqual([
      [1, '가'],
      [3, '나'],
    ]);
    expect(r2.locations.techTargets[3]).toBe('기술목표 표 3행 (순번 2)');
  });
});

// ─── HX-6 성과목표 ───────────────────────────────────────────

describe('HX-6 성과목표 행', () => {
  const r = run({ tables: standardTables() });

  it('지표명·유형 — C.3.2 실측 표와 같은 규칙', () => {
    expect(r.rows.deliverables.map((d) => [d.name, d.type])).toEqual([
      ['인력양성 효과', 'hr_training'],
      ['소프트웨어 등록', 'sw_registration'],
      ['특허 국내등록 건수', 'patent_dom_reg'],
      ['특허 국내출원 건수', 'patent_dom_apply'],
      ['특허 국외등록 건수', 'patent_intl_reg'],
      ['특허 국외출원 건수', 'patent_intl_apply'],
      ['SCI급 게재논문 게재', 'paper_sci'],
      ['비SCI급 게재논문', 'paper_domestic'],
      ['학술대회', 'conference'],
      ['시제품', 'commercialization'],
    ]);
  });

  it('반영 제외 3행(SMART 2 · Impact Factor 1) — 사유와 함께 excluded, 행 모델 밖(U-7, S-9)', () => {
    expect(r.excluded).toEqual([
      { table: 'deliverable', tableRow: 4, name: '특허 국내 등록 SMART(1∼9) 평균*', unit: '점수', reason: '반영 제외: 건수 지표가 아님' },
      { table: 'deliverable', tableRow: 7, name: '특허 국외 등록 SMART(1∼9) 평균', unit: '점수', reason: '반영 제외: 건수 지표가 아님' },
      { table: 'deliverable', tableRow: 10, name: '학술 SCI급 게재논문 Impact Factor 평균', unit: '', reason: '반영 제외: 건수 지표가 아님' },
    ]);
  });

  it('목표가 전부 `-`인 행은 제외하지 않고 목표 0으로 반영(U-7)', () => {
    const d = deliverableByName(r, '특허 국외등록 건수');
    expect(d.targetTotal).toBe(0);
    expect(d.weight).toBe(0);
    expect(d.targetByYear).toEqual({ 'y-1': null, 'y-2': null, 'y-3': null, 'y-4': null });
    expect(d.evidenceMethod).toBe('');
    expect(d.issues).toEqual([]);
  });

  it('단위 그대로(`명`), 가중치, 연차, 계 → targetTotal, 평가방법 → evidenceMethod(개행 유지)', () => {
    const hr = deliverableByName(r, '인력양성 효과');
    expect(hr.unit).toBe('명');
    expect(hr.weight).toBe(10);
    expect(hr.targetByYear).toEqual({ 'y-1': 1, 'y-2': 1, 'y-3': 1, 'y-4': 1 });
    expect(hr.targetTotal).toBe(4);
    expect(deliverableByName(r, 'SCI급 게재논문 게재').evidenceMethod).toBe('게재 증빙\n논문 사본');
    expect(deliverableByName(r, '시제품').evidenceMethod).toBe('시제품 사진 & 보고서');
  });

  it('반영 대상 가중치 합 100 — weight-sum 경고 없음', () => {
    expect(r.rows.deliverables.reduce((s, d) => s + (d.weight ?? 0), 0)).toBe(100);
    expect(preview(r, { deliverables: [], techTargets: [] }).issues.map((i) => i.message).join()).not.toContain('성과목표');
  });

  it('계가 비면 Σ연차, 계 ≠ Σ면 total-mismatch 경고(계로 반영)', () => {
    const rows = [
      ['상용화', '시제품', '시제품', '시제품', '건', '10', '1', '1', '1', '1', '', '증빙'],
      ['학술', '학술대회', '학술대회', '학술대회', '건', '10', '1', '1', '1', '1', '9', '증빙'],
    ];
    const r2 = run({ tables: [deliverableTable(0, rows)] });
    expect(deliverableByName(r2, '시제품').targetTotal).toBe(4);
    const conf = deliverableByName(r2, '학술대회');
    expect(conf.targetTotal).toBe(9);
    expect(kinds(conf.issues)).toEqual(['total-mismatch']);
  });

  it('건수가 정수가 아니면 blocking count-invalid, 단위가 비면 A.2 기본 단위', () => {
    const rows = [['상용화', '시제품', '시제품', '시제품', '', '10', '1.5', '1', '1', '1', '', '증빙']];
    const r2 = run({ tables: [deliverableTable(0, rows)] });
    const d = r2.rows.deliverables[0]!;
    expect(d.unit).toBe('건');
    expect(d.issues.find((i) => i.kind === 'count-invalid')?.blocking).toBe(true);
  });
});

// ─── HX-7 평가방법 표 ────────────────────────────────────────

describe('HX-7 평가방법 표', () => {
  const r = run({ tables: standardTables() });

  it('순번으로 이어 measureDescription·evaluationEnvironment(개행 유지)', () => {
    const t = techByName(r, '합성 응답시간');
    expect(t.measureDescription).toBe('측정 방법 1\n둘째 줄');
    // [기준설정 근거] 문단부터 끝까지 버림
    expect(t.evaluationEnvironment).toBe('환경 1');
    expect(t.basisRationale).toBe('');
  });

  it('문단 머리가 아닌 표식은 그대로, `-`는 빈 값, 표식만 있으면 전부 버림', () => {
    expect(techByName(r, '합성 처리 지연').evaluationEnvironment).toBe('환경 2 안의 [기준설정 근거] 문구는 문단 머리가 아니다');
    expect(techByName(r, '합성 탐지 정확도 (가상 조건)').evaluationEnvironment).toBe('');
    expect(techByName(r, '합성 검출한계').evaluationEnvironment).toBe('');
    expect(techByName(r, '합성 검출한계').measureDescription).toBe('');
  });

  it('순번이 없으면 이름 키로 재시도해 잇는다', () => {
    const method = [['', '합성 처리\n지연', '이름으로 이음', '환경']];
    const r2 = run({ tables: [techTable(0, TECH_ROWS), methodTable(1, method)] });
    expect(techByName(r2, '합성 처리 지연').measureDescription).toBe('이름으로 이음');
    expect(r2.issues).toEqual([]);
  });

  it('맞는 순번·이름이 없으면 unlinked-method-row 경고', () => {
    const method = [['99', '없는 항목', 'x', 'y']];
    const r2 = run({ tables: [techTable(0, TECH_ROWS), methodTable(1, method)] });
    expect(kinds(r2.issues)).toEqual(['unlinked-method-row']);
    expect(r2.issues[0]!.message).toContain('평가방법 표 1행 (순번 99)');
    expect(r2.issues[0]!.blocking).toBe(false);
    expect(r2.rows.techTargets.every((t) => t.measureDescription === '')).toBe(true);
  });

  it('순번이 겹치면 경고하고 둘 다 잇지 않는다(이름 재시도 없음)', () => {
    const method = [
      ['1', '합성 응답시간', '첫째', 'e1'],
      ['1', '합성 처리 지연', '둘째', 'e2'],
    ];
    const r2 = run({ tables: [techTable(0, TECH_ROWS), methodTable(1, method)] });
    expect(kinds(r2.issues)).toEqual(['unlinked-method-row', 'unlinked-method-row']);
    expect(techByName(r2, '합성 응답시간').measureDescription).toBe('');
    expect(techByName(r2, '합성 처리 지연').measureDescription).toBe('');
  });

  it('`N.` 순번 칸도 읽는다', () => {
    const method = [['2.', '아무 이름', '점 순번', 'e']];
    const r2 = run({ tables: [techTable(0, TECH_ROWS), methodTable(1, method)] });
    expect(techByName(r2, '합성 처리 지연').measureDescription).toBe('점 순번');
  });
});

// ─── HX-8 대응·투영·멱등 ─────────────────────────────────────

/** 미리보기 적용 후 상태를 "DB"로 삼는다 — version은 반영이 올리므로 올려 둔다 */
function afterState(p: GoalFormPreview): { deliverables: Deliverable[]; techTargets: TechTarget[] } {
  return {
    deliverables: p.after.deliverables.map((d) => ({ ...d, version: d.version + 1 })),
    techTargets: p.after.techTargets.map((t) => ({ ...t, version: t.version + 1 })),
  };
}

describe('HX-8 멱등 — 같은 격자를 적용한 상태로 다시 돌리면 전 행 unchanged', () => {
  it('빈 과제에서 적용 → 재미리보기', () => {
    const first = run({ tables: standardTables() });
    const p1 = preview(first, { deliverables: [], techTargets: [] });
    const after = afterState(p1);
    const second = run({ tables: standardTables(), current: after });
    const p2 = preview(second, after);
    expect(p2.rows.techTargets.map((r) => r.status)).toEqual(Array(7).fill('unchanged'));
    expect(p2.rows.deliverables.map((r) => r.status)).toEqual(Array(10).fill('unchanged'));
    expect(p2.counts.add + p2.counts.update).toBe(0);
    expect(p2.deleteCandidates).toEqual([]);
    // 비고 원문 줄이 늘지 않는다
    expect(techByName(second, '합성 가용률').note).toBe('[담당기관] 마바대학');
  });
});

describe('HX-8 기존 동명 기술목표 — 투영 보존(S-18)', () => {
  const existing = techTarget('t-1', {
    name: '합성  가용률 ', // 공백만 다르다
    group: '기존 구분',
    unit: '%',
    direction: 'target_exact',
    worldBest: 99.9,
    baselineDomestic: 90,
    worldBestHolder: '가상국',
    standardBasis: 'KS 기존',
    basisRationale: '기존 근거',
    measureDescription: '기존 상세',
    evaluationEnvironment: '기존 환경',
    note: '기존 비고',
    orgId: 'o-2',
    targetByYear: { 'y-1': 1, 'y-5': 7 },
    records: [{ id: 'r-1', version: 1, value: 98, date: '2026-03-01', yearId: 'y-1', method: 'self', evaluator: '', evidenceUrl: '', note: '' }],
  });
  const untouched = techTarget('t-2', { name: '계획서에 없는 목표', order: 1 });
  const current = { deliverables: [], techTargets: [existing, untouched] };
  // 7번 행만: 기관 `마바대학`(불일치), 힌트·시간 단위 없음, 평가방법 표 없음
  const r = run({ tables: [techTable(0, [TECH_ROWS[6]!])], current });
  const p = preview(r, current);

  it('같은 id로 update, 이름만 바뀐다(공백) — 나머지 기존 값 보존', () => {
    const row = r.rows.techTargets[0]!;
    expect(row.id).toBe('t-1');
    const pr = p.rows.techTargets[0]!;
    expect(pr.status).toBe('update');
    expect(pr.changedFields.sort()).toEqual(['name', 'note', 'targetByYear', 'targetValue'].sort());
    const v = pr.values!;
    expect(v.orgId).toBe('o-2');
    expect(v.direction).toBe('target_exact');
    expect(v.group).toBe('기존 구분');
    expect(v.worldBest).toBe(99.9);
    expect(v.baselineDomestic).toBe(90);
    expect(v.worldBestHolder).toBe('가상국');
    expect(v.standardBasis).toBe('KS 기존');
    expect(v.basisRationale).toBe('기존 근거');
    // 평가방법 표와 연결되지 않았다 — 두 필드 보존(S-22)
    expect(v.measureDescription).toBe('기존 상세');
    expect(v.evaluationEnvironment).toBe('기존 환경');
    expect(v.note).toBe('기존 비고\n[담당기관] 마바대학');
    expect(kinds(r.rows.techTargets[0]!.issues)).toEqual(['org-unmatched']);
  });

  it('표 밖 연차 키(y-5)는 적용 후에도 남는다', () => {
    const t = p.after.techTargets.find((x) => x.id === 't-1')!;
    expect(t.targetByYear).toEqual({ 'y-1': 99, 'y-2': 99, 'y-3': 99, 'y-4': 99, 'y-5': 7 });
    expect(t.records).toHaveLength(1);
  });

  it('계획서에 없는 기존 목표는 삭제 후보가 아니고 그대로 남는다', () => {
    expect(p.deleteCandidates).toEqual([]);
    expect(p.after.techTargets.map((t) => t.id)).toEqual(['t-1', 't-2']);
  });

  it('meta version = 파이프라인 시점 DB 값(측정 이력 포함)', () => {
    expect(r.meta.techTargets).toEqual({ 't-1': 3, 't-2': 3 });
    expect(r.meta.records).toEqual({ 'r-1': 1 });
  });

  it('적용 후 다시 돌리면 unchanged(비고 줄 멱등)', () => {
    const after = afterState(p);
    const r2 = run({ tables: [techTable(0, [TECH_ROWS[6]!])], current: after });
    const p2 = preview(r2, after);
    expect(p2.rows.techTargets.map((x) => x.status)).toEqual(['unchanged']);
    expect(r2.rows.techTargets[0]!.note).toBe('기존 비고\n[담당기관] 마바대학');
  });
});

describe('HX-8 방향 — 기존 행', () => {
  it('시간 단위면 기존 방향이어도 lower_better', () => {
    const current = { deliverables: [], techTargets: [techTarget('t-1', { name: '합성 응답', direction: 'higher_better', unit: '초' })] };
    const r = run({ tables: [techTable(0, [techCells({ name: '1. 합성 응답', unit: '초', years: ['5', '4', '3', '2'] })])], current });
    expect(r.rows.techTargets[0]!.direction).toBe('lower_better');
  });

  it('힌트가 있으면 기존 방향보다 우선', () => {
    const current = { deliverables: [], techTargets: [techTarget('t-1', { name: '합성 응답', direction: 'lower_better' })] };
    const r = run({ tables: [techTable(0, [techCells({ name: '1. 합성 응답', years: ['≥5', '≥6', '≥7', '≥8'] })])], current });
    expect(r.rows.techTargets[0]!.direction).toBe('higher_better');
  });

  it('기관 칸이 맞으면 기존 orgId를 바꾼다, 빈 칸이면 보존', () => {
    const current = {
      deliverables: [],
      techTargets: [techTarget('t-1', { name: '가', orgId: 'o-2' }), techTarget('t-2', { name: '나', orgId: 'o-2' })],
    };
    const r = run({ tables: [techTable(0, [techCells({ name: '1. 가', org: '가나기술' }), techCells({ name: '2. 나', org: '' })])], current });
    expect(r.rows.techTargets.map((t) => t.orgId)).toEqual(['o-1', 'o-2']);
  });
});

describe('HX-8 성과목표 대응', () => {
  it('유형이 other로 나오면 기존 유형, 기관은 기존 값 보존 — 재미리보기 unchanged', () => {
    const current = {
      deliverables: [deliverable('d-1', { name: '합성 기타 지표', type: 'tech_transfer', orgId: 'o-1', unit: '건' })],
      techTargets: [],
    };
    const rows = [['기타', '합성 기타 지표', '합성 기타 지표', '합성 기타 지표', '건', '0', '0', '0', '0', '0', '0', '']];
    const r = run({ tables: [deliverableTable(0, rows)], current });
    const d = r.rows.deliverables[0]!;
    expect(d.id).toBe('d-1');
    expect(d.type).toBe('tech_transfer');
    expect(d.orgId).toBe('o-1');
    const p = preview(r, current);
    expect(p.rows.deliverables[0]!.status).toBe('update'); // targetByYear 0 키가 새로 생긴다
    const after = afterState(p);
    const r2 = run({ tables: [deliverableTable(0, rows)], current: after });
    expect(preview(r2, after).rows.deliverables[0]!.status).toBe('unchanged');
  });
});

describe('HX-8 이름 충돌', () => {
  it('DB에 같은 키가 둘 → blocking ambiguous-match, id 없음', () => {
    const current = { deliverables: [], techTargets: [techTarget('t-1', { name: '합성 가' }), techTarget('t-2', { name: '합성  가' })] };
    const r = run({ tables: [techTable(0, [techCells({ name: '1. 합성 가' })])], current });
    const row = r.rows.techTargets[0]!;
    expect(row.id).toBeNull();
    expect(row.issues.find((i) => i.kind === 'ambiguous-match')?.blocking).toBe(true);
    expect(preview(r, current).blocked).toBe(true);
  });

  it('계획서 안 같은 키 2행 → 둘 다 blocking duplicate-plan-name', () => {
    const r = run({ tables: [techTable(0, [techCells({ name: '1. 합성 가' }), techCells({ name: '2. 합성가' })])] });
    expect(r.rows.techTargets.map((t) => t.issues.some((i) => i.kind === 'duplicate-plan-name' && i.blocking))).toEqual([true, true]);
  });

  it('성과목표도 같은 규칙 — 특허 4종 이름이 겹치면 duplicate-plan-name', () => {
    const rows = [
      ['특허', '국내', '출원', '출원', '건', '10', '1', '1', '1', '1', '4', ''],
      ['특허', '국내', '출원', '건수', '건', '10', '1', '1', '1', '1', '4', ''],
    ];
    const r = run({ tables: [deliverableTable(0, rows)] });
    expect(r.rows.deliverables.every((d) => kinds(d.issues).includes('duplicate-plan-name'))).toBe(true);
  });
});

// ─── 연차 수 불일치 (S-29) ───────────────────────────────────

describe('연차 수 불일치', () => {
  it('과제 연차 3 < 표 4 → 경고, meta 연차 3, 4번째 열은 읽지 않는다', () => {
    const r = run({ tables: [techTable(0, [techCells({ name: '1. 가', years: ['1', '2', '3', '4'] })])], yearCount: 3 });
    expect(kinds(r.issues)).toEqual(['year-count-mismatch']);
    expect(r.issues[0]!.blocking).toBe(false);
    expect(r.meta.years.map((y) => y.id)).toEqual(['y-1', 'y-2', 'y-3']);
    expect(r.rows.techTargets[0]!.targetByYear).toEqual({ 'y-1': 1, 'y-2': 2, 'y-3': 3 });
    expect(r.rows.techTargets[0]!.targetValue).toBe(3);
  });

  it('과제 연차 5 > 표 4 → 경고, 5차년도 기존 목표 보존', () => {
    const current = { deliverables: [], techTargets: [techTarget('t-1', { name: '가', targetByYear: { 'y-5': 50 } })] };
    const r = run({ tables: [techTable(0, [techCells({ name: '1. 가' })])], yearCount: 5, current });
    expect(kinds(r.issues)).toEqual(['year-count-mismatch']);
    expect(r.meta.years).toHaveLength(4);
    const p = preview(r, current);
    expect(p.after.techTargets[0]!.targetByYear).toEqual({ 'y-1': 10, 'y-2': 20, 'y-3': 30, 'y-4': 40, 'y-5': 50 });
  });
});

// ─── 합성 XML 픽스처 (extract → identify → rows) ──────────────

describe('합성 픽스처 통합', () => {
  const dir = join(process.cwd(), 'tests', 'fixtures', 'hwpx');
  const read = (name: string) => readFileSync(join(dir, name), 'utf8');
  const extracted = extractHwpxTables([
    { section: 0, xml: read('section-tech.xml') },
    { section: 1, xml: read('section-deliverable.xml') },
    { section: 2, xml: read('section-method.xml') },
  ]);
  const r = buildPlanRows({
    projectId: PROJECT,
    tables: identifyPlanTables(extracted.tables, extracted.skipped),
    years: years(4),
    orgs: ORGS,
    current: { deliverables: [], techTargets: [] },
  });

  it('기술목표 9 · 성과목표 10 · 제외 3(SMART 2 · IF 1), 평가방법 전부 연결', () => {
    expect(r.rows.techTargets).toHaveLength(9);
    expect(r.rows.deliverables).toHaveLength(10);
    expect(r.excluded).toHaveLength(3);
    expect(r.excluded.filter((e) => /SMART/.test(e.name))).toHaveLength(2);
    expect(r.excluded.filter((e) => /Impact Factor/.test(e.name))).toHaveLength(1);
    expect(kinds(r.issues)).not.toContain('unlinked-method-row');
    expect(r.rows.techTargets.map((t) => r.locations.techTargets[t.sheetRow])).toEqual(
      Array.from({ length: 9 }, (_, i) => `기술목표 표 ${i + 1}행 (순번 ${i + 1})`),
    );
  });

  it('9번(힌트 없는 초) → lower_better, 가중치 합 100', () => {
    expect(r.rows.techTargets[8]!.direction).toBe('lower_better');
    expect(r.rows.deliverables.reduce((s, d) => s + (d.weight ?? 0), 0)).toBe(100);
    expect(r.rows.techTargets.reduce((s, t) => s + (t.weight ?? 0), 0)).toBe(100);
  });

  it('미리보기 — 빈 과제 전 행 add, 멱등', () => {
    const p = preview(r, { deliverables: [], techTargets: [] });
    expect(p.counts.add).toBe(19);
    expect(p.deleteCandidates).toEqual([]);
    const after = afterState(p);
    const r2 = buildPlanRows({
      projectId: PROJECT,
      tables: identifyPlanTables(extracted.tables, extracted.skipped),
      years: years(4),
      orgs: ORGS,
      current: after,
    });
    const p2 = preview(r2, after);
    expect(p2.counts.unchanged).toBe(19);
  });
});
