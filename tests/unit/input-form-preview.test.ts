// 입력 양식 미리보기·커밋 페이로드 (SOT §6.16 IN-3·IN-4·IN-5, §6.10 PL-1~PL-5·PL-10a, §6.11 D-8a·D-15·D-15b, 부록 B.7)
//
// 픽스처는 부록 B.7.1 인건비 19행 + B.7.2 연구활동비 5행 + B.7.3 간접비 1행이다. 파싱 결과는 생성기가 양식에
// 적는 모양(isPercent 인자는 /100 값, 인건비는 참여율·개월만)을 그대로 흉내 낸다. 금액 24건은 SOT 값과
// 원 단위로 일치해야 하고 — 다르면 구현이 틀린 것이다(부록 B 서문).

import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { buildInputFormPreview } from '@/lib/input-form';
import type { InputFormPreview } from '@/lib/input-form';
import type { ParsedInputForm, ParsedPersonnelRow, ParsedQuantityRow } from '@/lib/input-form/types';
import { INPUT_FORM_VERSION } from '@/lib/input-form/layout';
import type { BudgetDetail, DetailAxis, Member } from '@/types';

const PROJECT_ID = 'proj-1';
const YEAR_ID = 'year-1';
/** 2025-04-01~2025-12-31 (부록 B.7.1 "참여기간 9개월") */
const YEAR_MONTHS = 9;

// ─── 부록 B.7.1 인건비 19행 — [성명, 연봉, 참여율, 축, 개월, 최종 금액, 조정액] ──

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

function member(partial: Partial<Member> & Pick<Member, 'id' | 'name' | 'order'>): Member {
  return {
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    version: 1,
    createdBy: null,
    updatedBy: null,
    projectId: PROJECT_ID,
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
    projectId: PROJECT_ID,
    yearId: YEAR_ID,
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

const MEMBERS: Member[] = PERSONNEL.map(([name, salary], index) =>
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

const ALL_DETAILS: BudgetDetail[] = [...PERSONNEL_DETAILS, ...QUANTITY_DETAILS];

// ─── 파싱 결과 빌더 — 생성기가 양식에 적는 모양 그대로 ───────

function personnelRow(d: BudgetDetail, rowIndex: number, override: Partial<ParsedPersonnelRow> = {}): ParsedPersonnelRow {
  const participation = d.factors.find((f) => f.isPercent)?.value ?? null;
  const months = d.factors.find((f) => !f.isPercent)?.value ?? null;
  return {
    rowIndex,
    memberId: d.memberId ?? '',
    detailId: d.id,
    subcategory: d.subcategory,
    participation,
    months,
    axis: d.axis,
    adjustment: d.adjustment,
    note: d.note,
    issues: [],
    ...override,
  };
}

function quantityRow(d: BudgetDetail, rowIndex: number, override: Partial<ParsedQuantityRow> = {}): ParsedQuantityRow {
  return {
    rowIndex,
    subcategory: d.subcategory,
    category: d.category,
    detailId: d.id,
    name: d.name,
    spec: d.spec,
    unitPrice: d.unitPrice,
    // 생성기(build.ts)와 같은 규칙: isPercent 인자는 /100해 적는다(IN-4)
    factors: d.factors.map((f) => (f.isPercent ? f.value / 100 : f.value)),
    adjustment: d.adjustment,
    axis: d.axis,
    note: d.note,
    issues: [],
    ...override,
  };
}

function parsedOf(personnel: ParsedPersonnelRow[], budget: ParsedQuantityRow[]): ParsedInputForm {
  return {
    meta: {
      formVersion: INPUT_FORM_VERSION,
      projectId: PROJECT_ID,
      yearId: YEAR_ID,
      generatedAt: '2026-09-25',
      subcategoryCodes: [],
      memberIds: MEMBERS.map((m) => m.id),
    },
    personnel,
    budget,
    issues: [],
  };
}

function parsedFromDetails(details: readonly BudgetDetail[]): ParsedInputForm {
  const personnel = details.filter((d) => d.formula === 'personnel').map((d, i) => personnelRow(d, i + 2));
  const budget = details.filter((d) => d.formula === 'quantity').map((d, i) => quantityRow(d, i + 2));
  return parsedOf(personnel, budget);
}

function preview(parsed: ParsedInputForm, existingDetails: readonly BudgetDetail[] = ALL_DETAILS, extra: Partial<Parameters<typeof buildInputFormPreview>[0]> = {}): InputFormPreview {
  return buildInputFormPreview({
    parsed,
    yearId: YEAR_ID,
    projectId: PROJECT_ID,
    members: MEMBERS,
    existingDetails,
    yearMonths: YEAR_MONTHS,
    ...extra,
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

// ─── 부록 B.7 등가 ────────────────────────────────────────────

describe('buildInputFormPreview — 부록 B.7 (기존 행과 같은 양식)', () => {
  const result = preview(parsedFromDetails(ALL_DETAILS));

  it('행 25건(B.7.1 19 + B.7.2 5 + 간접비 1)이 전부 unchanged이고 차단·삭제가 없다', () => {
    expect(result.rows).toHaveLength(25);
    expect(result.summary).toEqual({ added: 0, changed: 0, deleted: 0, unchanged: 25, errors: 0, unknown: 0 });
    expect(result.blocked).toBe(false);
    expect(result.deletedDetailIds).toEqual([]);
    expect(result.untouchedCategories).toEqual([]);
  });

  it('인건비 19행 금액이 SOT 값과 원 단위로 일치한다 (PL-1·PL-2·PL-4)', () => {
    PERSONNEL.forEach(([name, , , , , amount], index) => {
      expect(rowOf(result, `p-${index}`).amount, name).toBe(amount);
    });
    // PL-2 회귀 — 월액 선반올림이면 15,540,001
    expect(rowOf(result, 'p-3').amount).toBe(15_540_000);
    expect(rowOf(result, 'p-4').amount).toBe(40_050_000);
    expect(rowOf(result, 'p-9').amount).toBe(5_190_000);
  });

  it('연구활동비 5행 + 간접비 1행 금액이 SOT 값과 일치한다 (PL-3)', () => {
    expect(rowOf(result, 'q-meeting').amount).toBe(3_000_000);
    expect(rowOf(result, 'q-aec').amount).toBe(19_440_000);
    expect(rowOf(result, 'q-travel').amount).toBe(1_200_000);
    expect(rowOf(result, 'q-print').amount).toBe(900_000);
    expect(rowOf(result, 'q-fee').amount).toBe(2_480_000);
    expect(rowOf(result, 'q-safety').amount).toBe(2_000_000);
  });

  it('비목별 합계와 총액 298,510,000 (B.7.3)', () => {
    const personnel = cellOf(result, 'personnel');
    expect(personnel.cashAmount).toBe(180_840_000);
    expect(personnel.inKindAmount).toBe(88_650_000);
    expect(personnel.plannedAmount).toBe(269_490_000);
    expect(cellOf(result, 'activity').plannedAmount).toBe(27_020_000);
    expect(cellOf(result, 'indirect').plannedAmount).toBe(2_000_000);
    expect(result.totals.total.plannedAmount).toBe(298_510_000);
    expect(result.totals.total.cashAmount + result.totals.total.inKindAmount).toBe(298_510_000);
  });

  it('교체 비목은 양식에 유효 행이 있고 기존 행도 있는 비목 전부다 (IN-5·D-15)', () => {
    expect(result.replaceCategories).toEqual(['personnel', 'activity', 'indirect']);
    expect(result.addOnlyCategories).toEqual([]);
  });

  it('인건비 행은 프리셋 라벨의 참여율·개월 인자와 memberId를 갖고 name·unitPrice는 비어 있다 (IN-3)', () => {
    const row = rowOf(result, 'p-3');
    expect(row.formula).toBe('personnel');
    expect(row.memberId).toBe('m-3');
    expect(row.category).toBe('personnel');
    expect(row.factors).toEqual([
      { label: '참여율(%)', value: 28, isPercent: true },
      { label: '참여기간(월)', value: 9, isPercent: false },
    ]);
    expect(row.name).toBe('');
    expect(row.unitPrice).toBe(0);
  });

  it('라벨이 바뀌어 있던 quantity 행은 프리셋 라벨로 돌아오고 변경이 아니라 한계 안내다 (IN-4)', () => {
    const aec = rowOf(result, 'q-aec');
    expect(aec.status).toBe('unchanged');
    expect(aec.factors.map((f) => f.label)).toEqual(['수량', '월']);
    expect(aec.issues.some((i) => i.kind === 'factor-label-reset' && !i.blocking)).toBe(true);
    expect(result.warnings.some((w) => w.kind === 'factor-label-reset')).toBe(true);
  });
});

// ─── 커밋 페이로드 ────────────────────────────────────────────

describe('commitRows — RPC p_rows 모양 (snake_case, 정수 금액)', () => {
  const result = preview(parsedFromDetails(ALL_DETAILS));

  it('유효 행 25건 전부이며 키가 DetailImportRow 그대로다', () => {
    expect(result.commitRows).toHaveLength(25);
    const personnel = result.commitRows.find((r) => r.member_id === 'm-3');
    expect(personnel).toEqual({
      category: 'personnel',
      subcategory: 'personnel_internal',
      axis: 'cash',
      formula: 'personnel',
      amount: 15_540_000,
      member_id: 'm-3',
      name: '',
      spec: '',
      note: '',
      unit_price: 0,
      factors: [
        { label: '참여율(%)', value: 28, isPercent: true },
        { label: '참여기간(월)', value: 9, isPercent: false },
      ],
      adjustment: 0,
      sort_order: 3,
    });
    const fee = result.commitRows.find((r) => r.name === '위탁정산 수수료');
    expect(fee).toMatchObject({
      category: 'activity',
      subcategory: 'activity_etc',
      formula: 'quantity',
      amount: 2_480_000,
      member_id: null,
      unit_price: 2_480_000,
      sort_order: 1,
    });
    for (const row of result.commitRows) {
      expect(Number.isInteger(row.amount)).toBe(true);
      expect(Number.isInteger(row.unit_price)).toBe(true);
      expect(Number.isInteger(row.adjustment)).toBe(true);
      expect('memberId' in row).toBe(false);
      expect('unitPrice' in row).toBe(false);
      expect('id' in row).toBe(false);
    }
  });

  it('커밋 행 금액의 합이 총액과 같다 (PL-8)', () => {
    const sum = result.commitRows.reduce((acc, r) => acc + r.amount, 0);
    expect(sum).toBe(298_510_000);
  });
});

// ─── detailId 대조 (IN-5) ─────────────────────────────────────

describe('detailId 대조 — add / change / deleted / untouched', () => {
  it('detailId 없는 행은 add', () => {
    const parsed = parsedFromDetails(ALL_DETAILS);
    parsed.budget.push(
      quantityRow(
        detail({ id: 'x', category: 'activity', subcategory: 'activity_meeting', name: '워크숍', unitPrice: 300_000, factors: [{ label: '회', value: 2, isPercent: false }] }),
        99,
        { detailId: null }
      )
    );
    const result = preview(parsed);
    expect(result.summary.added).toBe(1);
    const added = result.rows.find((r) => r.name === '워크숍')!;
    expect(added.status).toBe('add');
    expect(added.amount).toBe(600_000);
    expect(result.commitRows.some((r) => r.name === '워크숍')).toBe(true);
    expect(result.totals.total.plannedAmount).toBe(298_510_000 + 600_000);
  });

  it('값이 바뀐 행은 change이고 바뀐 필드를 말한다', () => {
    const parsed = parsedFromDetails(ALL_DETAILS);
    const target = parsed.personnel.find((r) => r.detailId === 'p-3')!;
    target.participation = 30; // 박선욱 28 → 30
    const result = preview(parsed);
    const row = rowOf(result, 'p-3');
    expect(row.status).toBe('change');
    expect(row.changedFields).toEqual(['factors', 'amount']);
    expect(row.amount).toBe(16_650_000); // 74,000,000 × 0.30 × 0.75
    expect(result.summary.changed).toBe(1);
    expect(result.summary.unchanged).toBe(24);
  });

  it('양식에서 빠진 행은 그 비목에 다른 행이 있을 때 deleted', () => {
    const parsed = parsedFromDetails(ALL_DETAILS);
    parsed.budget = parsed.budget.filter((r) => r.detailId !== 'q-fee');
    const result = preview(parsed);
    expect(result.summary.deleted).toBe(1);
    expect(result.deletedDetailIds).toEqual(['q-fee']);
    expect(result.deleted[0]).toMatchObject({ category: 'activity', name: '위탁정산 수수료', amount: 2_480_000 });
    expect(result.replaceCategories).toContain('activity');
    expect(result.totals.total.plannedAmount).toBe(298_510_000 - 2_480_000);
    expect(result.blocked).toBe(false);
  });

  it('비목 전체가 빠지면 untouched로 유지되고 deleted는 0이다 (IN-5, 결정 ①)', () => {
    const parsed = parsedFromDetails(ALL_DETAILS);
    parsed.budget = parsed.budget.filter((r) => r.category !== 'activity');
    const result = preview(parsed);
    expect(result.summary.deleted).toBe(0);
    expect(result.deletedDetailIds).toEqual([]);
    expect(result.replaceCategories).toEqual(['personnel', 'indirect']);
    expect(result.untouchedCategories).toEqual([{ category: 'activity', rowCount: 5 }]);
    expect(result.warnings).toContainEqual({ kind: 'untouched', message: "양식에 없는 비목 '연구활동비' 5행 유지" });
    // 유지 비목의 기존 행은 반영 뒤에도 남으므로 합계에 들어간다
    expect(result.totals.total.plannedAmount).toBe(298_510_000);
    expect(result.commitRows.some((r) => r.category === 'activity')).toBe(false);
    expect(result.blocked).toBe(false);
  });

  it('기존 행이 없는 비목의 새 행은 교체 지정 없이 추가만 한다 (D-15a를 살려 둔다)', () => {
    const parsed = parsedFromDetails(ALL_DETAILS);
    parsed.budget.push(
      quantityRow(
        detail({ id: 'x', category: 'material', subcategory: 'material_purchase', name: '센서', unitPrice: 100_000, factors: [{ label: '수량', value: 3, isPercent: false }] }),
        120,
        { detailId: null }
      )
    );
    const result = preview(parsed);
    expect(result.addOnlyCategories).toEqual(['material']);
    expect(result.replaceCategories).not.toContain('material');
    expect(result.commitRows.some((r) => r.category === 'material' && r.amount === 300_000)).toBe(true);
  });

  it('복사한 행(같은 detailId 두 번)은 두 번째부터 add — IN-3 두 구간 참여', () => {
    const parsed = parsedFromDetails(ALL_DETAILS);
    const first = parsed.personnel.find((r) => r.detailId === 'p-0')!;
    parsed.personnel.push({ ...first, rowIndex: 50, months: 3 });
    const result = preview(parsed);
    const copies = result.rows.filter((r) => r.detailId === 'p-0');
    expect(copies.map((r) => r.status)).toEqual(['unchanged', 'add']);
    expect(copies[1]!.issues.some((i) => i.kind === 'copied-row' && !i.blocking)).toBe(true);
    expect(result.commitRows.filter((r) => r.member_id === 'm-0')).toHaveLength(2);
  });

  it('원본이 이미 없는 detailId는 새 행으로 추가하고 알린다', () => {
    const parsed = parsedFromDetails(ALL_DETAILS);
    parsed.budget.find((r) => r.detailId === 'q-fee')!.detailId = 'gone';
    const result = preview(parsed);
    const row = rowOf(result, 'gone');
    expect(row.status).toBe('add');
    expect(row.issues.some((i) => i.kind === 'stale-detail-id')).toBe(true);
    // 원본 q-fee는 양식이 가리키지 않으므로 삭제된다
    expect(result.deletedDetailIds).toEqual(['q-fee']);
  });

  it('기존 행의 세목을 다른 비목으로 옮기면 원래 비목에 행이 없을 때 막는다 (근거 이중화 방지)', () => {
    const parsed = parsedFromDetails(ALL_DETAILS);
    // 간접비 유일 행을 연구활동비 세목으로 바꿔 적음 → 간접비는 유지 대상이 되어 원본이 남는다
    const safety = parsed.budget.find((r) => r.detailId === 'q-safety')!;
    safety.category = 'activity';
    safety.subcategory = 'activity_lab_ops';
    const result = preview(parsed);
    const row = rowOf(result, 'q-safety');
    expect(row.status).toBe('error');
    expect(row.issues.some((i) => i.kind === 'category-moved' && i.blocking)).toBe(true);
    expect(result.blocked).toBe(true);
    expect(result.commitRows.some((r) => r.subcategory === 'activity_lab_ops')).toBe(false);
  });
});

// ─── unknown·error·경고 ───────────────────────────────────────

describe('unknown 행·차단·경고', () => {
  it('unknown-member 행은 결과에 남고 commitRows에서 빠지며 blocked다 (IN-3)', () => {
    const parsed = parsedFromDetails(ALL_DETAILS);
    parsed.personnel.push(
      personnelRow(PERSONNEL_DETAILS[0]!, 60, {
        memberId: 'stranger',
        detailId: null,
        issues: [{ kind: 'unknown-member', message: '양식에 없던 인력입니다: stranger', blocking: true }],
      })
    );
    const result = preview(parsed);
    expect(result.rows).toHaveLength(26);
    const unknown = result.rows.find((r) => r.memberId === 'stranger')!;
    expect(unknown.status).toBe('unknown');
    expect(unknown.amount).toBe(0);
    expect(result.summary.unknown).toBe(1);
    expect(result.commitRows).toHaveLength(25);
    expect(result.blocked).toBe(true);
  });

  it('unknown-subcategory 행도 결과에 남고 commitRows에서 빠진다 (IN-4)', () => {
    const parsed = parsedFromDetails(ALL_DETAILS);
    parsed.budget.push({
      rowIndex: 70,
      subcategory: 'activity:nope',
      category: null,
      detailId: null,
      name: '정체불명',
      spec: '',
      unitPrice: 1_000,
      factors: [],
      adjustment: 0,
      axis: 'cash',
      note: '',
      issues: [{ kind: 'unknown-subcategory', message: '알 수 없는 세목입니다: activity:nope', blocking: true }],
    });
    const result = preview(parsed);
    const row = result.rows.find((r) => r.name === '정체불명')!;
    expect(row.status).toBe('unknown');
    expect(row.category).toBeNull();
    expect(result.commitRows.some((r) => r.name === '정체불명')).toBe(false);
    expect(result.blocked).toBe(true);
  });

  it('차단 issue(범위 밖)가 있는 행은 error이고 blocked다', () => {
    const parsed = parsedFromDetails(ALL_DETAILS);
    const target = parsed.personnel.find((r) => r.detailId === 'p-0')!;
    target.participation = 150;
    target.issues = [{ kind: 'participation-out-of-range', message: '참여율(%)은(는) 0~100 사이여야 합니다: 150', blocking: true }];
    const result = preview(parsed);
    expect(rowOf(result, 'p-0').status).toBe('error');
    expect(result.summary.errors).toBe(1);
    expect(result.blocked).toBe(true);
    expect(result.commitRows).toHaveLength(24);
    // 원본 p-0은 양식이(오류 행으로) 가리키므로 삭제 목록에 오르지 않는다
    expect(result.deletedDetailIds).toEqual([]);
  });

  it('개월 10 · 연차 9개월 → 경고만, blocked false (IN-3)', () => {
    const parsed = parsedFromDetails(ALL_DETAILS);
    parsed.personnel.find((r) => r.detailId === 'p-0')!.months = 10;
    const result = preview(parsed);
    const row = rowOf(result, 'p-0');
    expect(row.status).toBe('change');
    expect(row.issues).toContainEqual({ kind: 'months-over-year', message: '참여개월 10이(가) 연차 기간 9개월을 넘습니다', blocking: false });
    expect(result.warnings.some((w) => w.kind === 'months-over-year')).toBe(true);
    expect(result.blocked).toBe(false);
    expect(row.amount).toBe(15_000_000); // 180,000,000 × 0.10 × 10/12
  });

  it('연차 개월을 모르면(null) 개월 초과 경고를 내지 않는다', () => {
    const parsed = parsedFromDetails(ALL_DETAILS);
    parsed.personnel.find((r) => r.detailId === 'p-0')!.months = 12;
    const result = preview(parsed, ALL_DETAILS, { yearMonths: null });
    expect(rowOf(result, 'p-0').issues.some((i) => i.kind === 'months-over-year')).toBe(false);
  });

  it('명부 연봉 null → missingSalary·amount 0·조정액은 그대로, 경고만 (D-8a)', () => {
    const members = MEMBERS.map((m) => (m.id === 'm-4' ? { ...m, annualSalary: null } : m));
    const parsed = parsedFromDetails(ALL_DETAILS);
    const result = preview(parsed, ALL_DETAILS, { members });
    const row = rowOf(result, 'p-4'); // 지동민, 조정액 −270,000
    expect(row.missingSalary).toBe(true);
    expect(row.amount).toBe(0);
    expect(row.status).toBe('change');
    expect(row.issues.some((i) => i.kind === 'missing-salary' && !i.blocking)).toBe(true);
    expect(result.blocked).toBe(false);
    const commit = result.commitRows.find((r) => r.member_id === 'm-4')!;
    expect(commit.amount).toBe(0);
    expect(commit.adjustment).toBe(-270_000); // 조정액에 파일 금액을 밀어 넣지 않는다
    expect(result.warnings.some((w) => w.kind === 'missing-salary')).toBe(true);
  });

  it('최종 금액 음수는 negative로 드러내되 막지 않는다 (PL-5)', () => {
    const parsed = parsedFromDetails(ALL_DETAILS);
    parsed.budget.find((r) => r.detailId === 'q-meeting')!.adjustment = -5_000_000;
    const result = preview(parsed);
    const row = rowOf(result, 'q-meeting');
    expect(row.negative).toBe(true);
    expect(row.amount).toBe(-2_000_000);
    expect(row.issues.some((i) => i.kind === 'negative-amount' && !i.blocking)).toBe(true);
    expect(result.blocked).toBe(false);
  });
});

// ─── isPercent 인자 왕복 (IN-4) ───────────────────────────────

describe('isPercent 인자 왕복 (IN-4)', () => {
  // 프리셋에 isPercent 인자가 있는 세목이 부록 A.5에 없으므로, 프리셋 밖 인자 자리를 기존 행의 isPercent로
  // 잇는 경로로 왕복을 확인한다 — 생성기가 /100해 적은 0.28이 28로 돌아와야 금액이 같다
  const percentDetail = detail({
    id: 'q-pct',
    category: 'allowance',
    subcategory: 'default',
    name: '연구수당',
    unitPrice: 10_000_000,
    factors: [{ label: '지급률(%)', value: 28, isPercent: true }],
    amount: 2_800_000,
  });

  it('0.28 → 28로 되돌려 저장하고 금액은 2,800,000이다', () => {
    const existing = [...ALL_DETAILS, percentDetail];
    const parsed = parsedFromDetails(existing);
    const parsedRow = parsed.budget.find((r) => r.detailId === 'q-pct')!;
    expect(parsedRow.factors).toEqual([0.28]);
    const result = preview(parsed, existing);
    const row = rowOf(result, 'q-pct');
    expect(row.factors).toEqual([{ label: '지급률(%)', value: 28, isPercent: true }]);
    expect(row.amount).toBe(2_800_000);
    expect(row.status).toBe('unchanged');
  });

  it('기존 행도 프리셋도 없는 인자는 isPercent false · 인자N 라벨로 두고 알린다', () => {
    const parsed = parsedFromDetails(ALL_DETAILS);
    parsed.budget.push(
      quantityRow(
        detail({ id: 'x', category: 'allowance', subcategory: 'default', name: '수당', unitPrice: 1_000_000, factors: [{ label: '?', value: 2, isPercent: false }] }),
        130,
        { detailId: null }
      )
    );
    const result = preview(parsed);
    const row = result.rows.find((r) => r.name === '수당')!;
    expect(row.factors).toEqual([{ label: '인자1', value: 2, isPercent: false }]);
    expect(row.amount).toBe(2_000_000);
    expect(row.issues.some((i) => i.kind === 'factor-without-preset' && !i.blocking)).toBe(true);
  });
});

// ─── 경계 (PL-10a·IN-8) ───────────────────────────────────────

describe('경계', () => {
  const source = fs.readFileSync(path.join(process.cwd(), 'lib', 'input-form', 'preview.ts'), 'utf8');

  it('산식을 다시 구현하지 않는다 — annualSalary 곱셈 없음, computeDetailAmount만 (PL-10a)', () => {
    expect(source).not.toMatch(/annualSalary\s*\*/);
    expect(source).toMatch(/computeDetailAmount\(/);
  });

  it('SheetJS와 이름 매칭 함수를 import하지 않는다 (IN-8·IN-3)', () => {
    expect(source).not.toMatch(/from ['"]xlsx['"]/);
    expect(source).not.toMatch(/detailMemberKey|normalizeLabel|matchDetailMembers/);
  });
});
