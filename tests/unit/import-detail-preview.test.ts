// 산출근거 미리보기 조립 (SOT §6.11.2 D-3a · §6.11.3 D-8·D-8a · §6.11.4 D-11~D-14 ·
// §6.11.5 D-15·D-15b·D-18, §7.9.3 Step 3·4). 부수효과 없는 순수 함수라 DB 없이 고정된다.
//
// 핵심은 **D-8a 조정액 확정**이다: 조정액을 명부 연봉으로 역산해야 저장값과 재계산값이 같다.
// 실측 샘플(부록 B.7.1·B.8.4)은 파일 연봉 = 명부 연봉이라 이 분기가 드러나지 않으므로
// 파일 연봉 ≠ 명부 연봉 케이스를 여기서 따로 만든다.

import { describe, expect, it } from 'vitest';
import { computeDetailAmount } from '@/lib/budget-plan';
import { RuleViolationError } from '@/lib/db/errors';
import {
  buildDetailPreview,
  detailBlockKey,
  detailRowKey,
  matchDetailMembers,
  resolveDetailSubcategory,
  toDetailCommitRows,
  toHireType,
  type BuildDetailPreviewInput,
  type DetailBlockInput,
  type DetailMemberInput,
} from '@/lib/import';
import type { DetailBlock, DetailDraftRow } from '@/lib/import';
import type { BudgetCategory, DetailFactor } from '@/types';

// ─── 픽스처 ──────────────────────────────────────────────────

function makeBlock(patch: Partial<DetailBlock> & { category: BudgetCategory }): DetailBlock {
  return {
    section: 'direct',
    categoryLabel: '- 인건비',
    categoryRow: 60,
    subcategory: null,
    subcategoryLabel: null,
    subcategoryRow: null,
    numberToken: null,
    resolvedBy: null,
    numberCandidates: [],
    needsConfirm: false,
    issues: [],
    headerRows: [63],
    columns: [],
    roles: {},
    dataStartRow: 64,
    dataEndRow: 80,
    tableIndex: 0,
    ...patch,
  };
}

const RATE = '참여율(%)';
const PERIOD = '참여기간(월)';

function personnelFactors(rate: number, months: number): DetailFactor[] {
  return [
    { label: RATE, value: rate, isPercent: true },
    { label: PERIOD, value: months, isPercent: false },
  ];
}

/**
 * 파서가 내보내는 초안 행. personnel이면 파서와 같은 방식으로 **파일 연봉** 기준 잠정값을 채운다
 * (adjustmentProvisional) — 미리보기가 그것을 명부 연봉으로 다시 확정하는지 보는 것이 이 테스트다.
 */
function makeRow(patch: Partial<DetailDraftRow> & { category: BudgetCategory }): DetailDraftRow {
  const row: DetailDraftRow = {
    row: 64,
    axisIndex: 0,
    order: 0,
    section: 'direct',
    subcategory: null,
    formula: 'quantity',
    axis: 'cash',
    axisSuggested: false,
    name: '',
    spec: '',
    unitPrice: 0,
    factors: [],
    note: '',
    memberName: null,
    position: null,
    hireTypeLabel: null,
    fileSalary: null,
    formulaAmount: 0,
    fileAmount: 0,
    adjustment: 0,
    absorbed: false,
    adjustmentProvisional: false,
    status: 'included',
    issues: [],
    needsConfirm: false,
    ...patch,
  };
  const provisional = computeDetailAmount(
    {
      yearId: '',
      category: row.category,
      subcategory: row.subcategory ?? '',
      axis: row.axis,
      formula: row.formula,
      memberId: null,
      unitPrice: row.unitPrice,
      adjustment: 0,
      factors: row.factors,
    },
    row.formula === 'personnel' ? { id: '', annualSalary: row.fileSalary } : null
  ).amount;
  return {
    ...row,
    formulaAmount: provisional,
    adjustment: row.fileAmount - provisional,
    absorbed: row.fileAmount - provisional !== 0,
    adjustmentProvisional: row.formula === 'personnel',
  };
}

function entry(block: DetailBlock, rows: DetailDraftRow[], patch?: Partial<DetailBlockInput>): DetailBlockInput {
  return { block, rows, subtotals: [], currency: null, ...patch };
}

function roster(patch: Partial<DetailMemberInput> & { id: string; name: string }): DetailMemberInput {
  return { position: '책임연구원', annualSalary: null, orgId: null, ...patch };
}

function build(patch: Partial<BuildDetailPreviewInput> & { blocks: DetailBlockInput[] }) {
  return buildDetailPreview({ yearId: 'year-1', members: [], ...patch });
}

// ─── D-3a 세목 확정 ──────────────────────────────────────────

describe('resolveDetailSubcategory (D-3a)', () => {
  it('프리셋 세목이 default 하나뿐인 비목은 확인 없이 default로 확정한다', () => {
    for (const category of ['allowance', 'international', 'consignment', 'burden'] as const) {
      const resolution = resolveDetailSubcategory(makeBlock({ category }), []);
      expect(resolution).toEqual({
        subcategory: 'default',
        source: 'single-preset',
        needsConfirm: false,
      });
    }
  });

  it('세목 헤더를 파서가 이미 정했으면 그대로 잇는다 (needsConfirm 포함)', () => {
    const block = makeBlock({
      category: 'activity',
      subcategory: 'activity_travel_dom',
      needsConfirm: true,
      issues: ['travel-undecided'],
    });
    expect(resolveDetailSubcategory(block, [])).toEqual({
      subcategory: 'activity_travel_dom',
      source: 'sheet',
      needsConfirm: true,
    });
  });

  it('인건비는 자동 확정하지 않는다 — 라벨이 없으면 personnel_internal 제안 + 확인', () => {
    const rows = [makeRow({ category: 'personnel', formula: 'personnel', memberName: '지동민' })];
    expect(resolveDetailSubcategory(makeBlock({ category: 'personnel' }), rows)).toEqual({
      subcategory: 'personnel_internal',
      source: 'suggested',
      needsConfirm: true,
    });
  });

  it('행에 세목 라벨이 있으면 그것으로 정한다 (확인 불필요)', () => {
    const rows = [
      makeRow({ category: 'personnel', formula: 'personnel', memberName: '홍길동', spec: '외부인건비' }),
    ];
    expect(resolveDetailSubcategory(makeBlock({ category: 'personnel' }), rows)).toEqual({
      subcategory: 'personnel_external',
      source: 'row-label',
      needsConfirm: false,
    });
  });

  it('비목 헤더가 세목 라벨이면 그것으로 정한다 (`- 연구지원인력인건비`)', () => {
    const block = makeBlock({ category: 'personnel', categoryLabel: '- 연구지원인력인건비' });
    expect(resolveDetailSubcategory(block, []).subcategory).toBe('personnel_support');
  });

  it('학생인건비도 2종이라 자동 확정하지 않는다', () => {
    expect(resolveDetailSubcategory(makeBlock({ category: 'student_personnel' }), [])).toEqual({
      subcategory: 'student_general',
      source: 'suggested',
      needsConfirm: true,
    });
  });

  it('사용자 선택이 시트·제안보다 앞선다', () => {
    const resolution = resolveDetailSubcategory(
      makeBlock({ category: 'personnel' }),
      [],
      'personnel_support'
    );
    expect(resolution).toEqual({
      subcategory: 'personnel_support',
      source: 'user',
      needsConfirm: false,
    });
  });

  it('세목이 여럿인 그 밖의 비목은 지어내지 않고 미해결로 남긴다', () => {
    expect(resolveDetailSubcategory(makeBlock({ category: 'facility_equipment' }), [])).toEqual({
      subcategory: null,
      source: 'unresolved',
      needsConfirm: true,
    });
  });
});

// ─── D-11~D-14 성명 매칭 ─────────────────────────────────────

describe('matchDetailMembers (D-11~D-14)', () => {
  const rows = [
    makeRow({
      category: 'personnel',
      formula: 'personnel',
      row: 65,
      memberName: '박 선 욱',
      position: '책임연구원',
      hireTypeLabel: '기존인력',
      fileSalary: 74_000_000,
      factors: personnelFactors(28, 9),
      fileAmount: 15_540_000,
    }),
    makeRow({
      category: 'personnel',
      formula: 'personnel',
      row: 66,
      memberName: '김철수',
      hireTypeLabel: '신규채용',
      fileSalary: 60_000_000,
      factors: personnelFactors(100, 12),
      fileAmount: 60_000_000,
    }),
    makeRow({
      category: 'personnel',
      formula: 'personnel',
      row: 67,
      memberName: '이영희',
      fileSalary: 50_000_000,
      factors: personnelFactors(50, 12),
      fileAmount: 25_000_000,
    }),
  ];

  const members: DetailMemberInput[] = [
    roster({ id: 'm-park', name: '박선욱', annualSalary: 74_000_000 }),
    roster({ id: 'm-lee-1', name: '이영희', annualSalary: 50_000_000, orgId: 'org-a', orgName: '유엔이' }),
    roster({ id: 'm-lee-2', name: '이영희', annualSalary: 48_000_000, orgId: 'org-b', orgName: '한국대', position: '연구원' }),
  ];

  it('정규화 후 완전일치만 자동 제안한다', () => {
    const match = matchDetailMembers(rows, members).find((m) => m.key === '박선욱');
    expect(match?.status).toBe('matched');
    expect(match?.memberId).toBe('m-park');
    expect(match?.decision).toEqual({ kind: 'existing', memberId: 'm-park' });
    expect(match?.rowKeys).toEqual(['65:0']);
  });

  it('동명이인은 자동 선택하지 않고 소속 기관·직위를 후보로 싣는다 (D-13)', () => {
    const match = matchDetailMembers(rows, members).find((m) => m.key === '이영희');
    expect(match?.status).toBe('ambiguous');
    expect(match?.memberId).toBeNull();
    expect(match?.decision).toBeNull();
    expect(match?.issues).toContain('ambiguous');
    expect(match?.candidates).toEqual([
      {
        id: 'm-lee-1',
        name: '이영희',
        position: '책임연구원',
        orgId: 'org-a',
        orgName: '유엔이',
        annualSalary: 50_000_000,
      },
      {
        id: 'm-lee-2',
        name: '이영희',
        position: '연구원',
        orgId: 'org-b',
        orgName: '한국대',
        annualSalary: 48_000_000,
      },
    ]);
  });

  it('미매칭 성명은 결정을 비워 둔다 — 파일의 연봉·직위·인력구분은 새 인력 초기값으로 싣는다', () => {
    const match = matchDetailMembers(rows, members).find((m) => m.key === '김철수');
    expect(match?.status).toBe('unmatched');
    expect(match?.decision).toBeNull();
    expect(match?.fileSalary).toBe(60_000_000);
    expect(match?.hireType).toBe('new');
  });

  it('파일 연봉 ≠ 명부 연봉이면 양쪽을 싣고 경고한다 (D-14)', () => {
    const match = matchDetailMembers(
      [rows[0]!],
      [roster({ id: 'm-park', name: '박선욱', annualSalary: 90_000_000 })]
    )[0];
    expect(match?.salaryMismatch).toEqual({ file: 74_000_000, roster: 90_000_000 });
    expect(match?.issues).toContain('salary-mismatch');
  });

  it('명부 연봉이 비어 있으면 "연봉 미입력"을 경고한다 (D-8a)', () => {
    const match = matchDetailMembers([rows[0]!], [roster({ id: 'm-park', name: '박선욱' })])[0];
    expect(match?.issues).toContain('roster-salary-missing');
    expect(match?.salaryMismatch).toBeNull();
  });

  it('명부를 고치지 않는다 (D-14) — 입력 배열·객체가 그대로다', () => {
    const snapshot = structuredClone(members);
    matchDetailMembers(rows, members);
    buildDetailPreview({
      yearId: 'year-1',
      blocks: [entry(makeBlock({ category: 'personnel' }), rows)],
      members,
    });
    expect(members).toEqual(snapshot);
  });

  it('인력구분 원문에서 hireType을 정한다 (D-12)', () => {
    expect(toHireType('신규 채용')).toBe('new');
    expect(toHireType('기존인력')).toBe('existing');
    expect(toHireType(null)).toBe('existing');
  });
});

// ─── D-8a 조정액 확정 ────────────────────────────────────────

describe('D-8a 조정액 확정 — 기준 연봉은 명부다', () => {
  const fileRow = makeRow({
    category: 'personnel',
    formula: 'personnel',
    row: 65,
    memberName: '지동민',
    position: '책임연구원',
    hireTypeLabel: '기존인력',
    fileSalary: 84_000_000,
    factors: personnelFactors(64, 9),
    fileAmount: 40_050_000,
  });

  it('파서의 잠정값은 파일 연봉 기준이다 (전제 확인)', () => {
    // 84,000,000 × 64% × 9/12 = 40,320,000 → 파일 40,050,000 → -270,000 (부록 B.8.4)
    expect(fileRow.formulaAmount).toBe(40_320_000);
    expect(fileRow.adjustment).toBe(-270_000);
    expect(fileRow.adjustmentProvisional).toBe(true);
  });

  it('파일 연봉 ≠ 명부 연봉: 명부 연봉으로 조정액을 다시 낸다', () => {
    const preview = build({
      blocks: [entry(makeBlock({ category: 'personnel' }), [fileRow])],
      members: [roster({ id: 'm1', name: '지동민', annualSalary: 90_000_000 })],
    });
    const row = preview.rows[0]!;

    // 90,000,000 × 64% × 9/12 = 43,200,000 → 조정액 = 40,050,000 − 43,200,000
    expect(row.formulaAmount).toBe(43_200_000);
    expect(row.adjustment).toBe(-3_150_000);
    // ① 저장될 금액이 파일 합계와 같다
    expect(row.amount).toBe(40_050_000);
    expect(row.amount).toBe(row.fileAmount);
    // 파일 연봉으로 역산한 잠정값을 그대로 쓰지 않았다
    expect(row.adjustment).not.toBe(fileRow.adjustment);
  });

  it('② 저장된 행을 명부 연봉으로 재계산해도 같은 금액이다 (PL-D7)', () => {
    const member = roster({ id: 'm1', name: '지동민', annualSalary: 90_000_000 });
    const preview = build({
      blocks: [entry(makeBlock({ category: 'personnel' }), [fileRow])],
      members: [member],
    });
    const row = preview.rows[0]!;
    const payload = toDetailCommitRows(preview).rows[0]!;

    const recomputed = computeDetailAmount(
      {
        yearId: 'year-1',
        category: payload.category,
        subcategory: payload.subcategory,
        axis: payload.axis,
        formula: payload.formula,
        memberId: payload.member_id ?? null,
        unitPrice: payload.unit_price ?? 0,
        adjustment: payload.adjustment ?? 0,
        factors: payload.factors ?? [],
      },
      { id: member.id, annualSalary: member.annualSalary }
    );
    expect(recomputed.amount).toBe(payload.amount);
    expect(recomputed.amount).toBe(row.fileAmount);
  });

  it('새 인력으로 생성하는 행은 명부 연봉 = 파일 연봉이라 잠정값이 그대로 확정된다 (부록 B.8.4)', () => {
    const preview = build({
      blocks: [entry(makeBlock({ category: 'personnel' }), [fileRow])],
      members: [],
      memberDecisions: { 지동민: { kind: 'create' } },
    });
    const row = preview.rows[0]!;
    expect(row.formulaAmount).toBe(40_320_000);
    expect(row.adjustment).toBe(-270_000);
    expect(row.amount).toBe(40_050_000);
    expect(row.memberRef).toEqual({ kind: 'create', tempKey: 'new:지동민' });
    expect(preview.newMembers).toEqual([
      {
        tempKey: 'new:지동민',
        name: '지동민',
        position: '책임연구원',
        annual_salary: 84_000_000,
        hire_type: 'existing',
        org_id: null,
      },
    ]);
  });

  // D-8a는 "조정액이 금액 전부를 떠안아 숫자는 파일과 맞는다"고 적었지만 PL-1의 구현
  // (computeDetailAmount)은 단가를 모르면 조정액을 더하지 않고 0원 + 경고로 끝낸다.
  // 파일 값을 만들어 넣으려면 산식을 다시 구현해야 하고(PL-10a 위반) 그 값은 첫 재계산에서
  // 0원으로 떨어진다 — D-8a가 막으려던 어긋남 그 자체다. 그래서 0원 + 경고를 고정한다.
  it('명부 연봉이 없으면 0원으로 반영하고 "연봉 미입력"을 경고한다', () => {
    const member = roster({ id: 'm1', name: '지동민' });
    const preview = build({
      blocks: [entry(makeBlock({ category: 'personnel' }), [fileRow])],
      members: [member],
    });
    const row = preview.rows[0]!;
    expect(row.formulaAmount).toBe(0);
    expect(row.amount).toBe(0);
    // 나중에 명부에 연봉을 채우면 `산식 + 조정액`이 두 배로 튀므로 조정액을 남기지 않는다
    expect(row.adjustment).toBe(0);
    expect(row.issues).toContain('roster-salary-missing');
    // 얼마가 빠지는지 숫자로 밝힌다 (절대 규칙 5)
    expect(row.reason).toContain('파일 40,050,000원 → 반영 0원');
    // 경고이지 오류가 아니다 — 반영을 막지 않는다
    expect(row.status).toBe('new');
    expect(preview.blocked).toBe(false);

    // 저장값 = 재계산값은 이 경우에도 지켜진다
    const payload = toDetailCommitRows(preview).rows[0]!;
    const recomputed = computeDetailAmount(
      {
        yearId: 'year-1',
        category: payload.category,
        subcategory: payload.subcategory,
        axis: payload.axis,
        formula: payload.formula,
        memberId: payload.member_id ?? null,
        unitPrice: payload.unit_price ?? 0,
        adjustment: payload.adjustment ?? 0,
        factors: payload.factors ?? [],
      },
      { id: member.id, annualSalary: member.annualSalary }
    );
    expect(recomputed.amount).toBe(payload.amount);
  });

  it('quantity 행의 조정액은 단가·인자 기준 그대로다 (D-8)', () => {
    const row = makeRow({
      category: 'activity',
      name: '회의비',
      unitPrice: 500_000,
      factors: [{ label: '회', value: 6, isPercent: false }],
      fileAmount: 3_000_001,
    });
    const preview = build({
      blocks: [
        entry(makeBlock({ category: 'activity', subcategory: 'activity_meeting', subcategoryRow: 174 }), [row]),
      ],
    });
    expect(preview.rows[0]!.formulaAmount).toBe(3_000_000);
    expect(preview.rows[0]!.adjustment).toBe(1);
    expect(preview.rows[0]!.amount).toBe(3_000_001);
    expect(preview.rows[0]!.absorbed).toBe(true);
  });
});

// ─── D-15 · D-15b 셀 충돌 ────────────────────────────────────

describe('buildDetailPreview — D-15 셀 충돌', () => {
  const meetingBlock = makeBlock({
    category: 'activity',
    categoryLabel: '마. 연구활동비',
    subcategory: 'activity_meeting',
    subcategoryRow: 174,
  });
  const meetingRow = makeRow({
    category: 'activity',
    row: 177,
    name: '회의비',
    unitPrice: 500_000,
    factors: [{ label: '회', value: 6, isPercent: false }],
    fileAmount: 3_000_000,
  });

  it('기존 산출근거가 있는 셀은 기본 건너뜀이다', () => {
    const preview = build({
      blocks: [entry(meetingBlock, [meetingRow])],
      existingCells: [{ category: 'activity', rowCount: 4 }],
    });
    expect(preview.rows[0]!.status).toBe('skipped');
    expect(preview.rows[0]!.issues).toContain('cell-skipped');
    expect(preview.cells).toEqual([
      expect.objectContaining({ category: 'activity', status: 'skipped', existingRows: 4, replace: false }),
    ]);
    expect(preview.summary).toMatchObject({ new: 0, skipped: 1, error: 0, totalAmount: 0 });
    expect(preview.blocked).toBe(false);
  });

  it('교체를 고른 셀만 반영 대상이 된다', () => {
    const preview = build({
      blocks: [entry(meetingBlock, [meetingRow])],
      existingCells: [{ category: 'activity', rowCount: 4 }],
      replaceCategories: ['activity'],
    });
    expect(preview.rows[0]!.status).toBe('new');
    expect(preview.cells[0]).toMatchObject({ status: 'replace', existingRows: 4, rowCount: 1, amount: 3_000_000 });
    expect(preview.summary.replaceCells).toBe(1);
    expect(toDetailCommitRows(preview).replaceCategories).toEqual(['activity']);
  });

  it('D-15b: 교체로 지정했는데 넣을 행이 없으면 오류다 (내용 없는 삭제 방지)', () => {
    const zeroRow = makeRow({
      category: 'activity',
      row: 178,
      name: '문헌구입비',
      status: 'skip-suggested',
      issues: ['zero-amount'],
      fileAmount: 0,
    });
    const preview = build({
      blocks: [entry(meetingBlock, [zeroRow])],
      existingCells: [{ category: 'activity', rowCount: 4 }],
      replaceCategories: ['activity'],
    });
    expect(preview.cells[0]!.status).toBe('error');
    expect(preview.summary.error).toBe(1);
    expect(preview.blocked).toBe(true);
    expect(() => toDetailCommitRows(preview)).toThrow(RuleViolationError);
  });

  it('D-15b: 파일에 아예 없는 비목의 교체 지정도 오류다', () => {
    const preview = build({
      blocks: [entry(meetingBlock, [meetingRow])],
      replaceCategories: ['material'],
    });
    expect(preview.cells.find((cell) => cell.category === 'material')?.status).toBe('error');
    expect(preview.blocked).toBe(true);
  });

  it('D-21 ②: 금액 0인 행은 기본 건너뜀이되 사용자가 포함시킬 수 있다', () => {
    const zeroRow = makeRow({
      category: 'activity',
      row: 178,
      name: '문헌구입비',
      status: 'skip-suggested',
      issues: ['zero-amount'],
      fileAmount: 0,
    });
    const base = build({ blocks: [entry(meetingBlock, [meetingRow, zeroRow])] });
    expect(base.summary).toMatchObject({ new: 1, skipped: 1 });

    const included = build({
      blocks: [entry(meetingBlock, [meetingRow, zeroRow])],
      rowDecisions: { [detailRowKey(zeroRow)]: 'include' },
    });
    expect(included.summary).toMatchObject({ new: 2, skipped: 0 });
  });
});

// ─── D-10 통화 · D-11 미결정 ─────────────────────────────────

describe('buildDetailPreview — 반영 대상 제외와 오류', () => {
  const swBlock = makeBlock({
    category: 'activity',
    subcategory: 'activity_software',
    subcategoryRow: 195,
  });
  const swRow = makeRow({
    category: 'activity',
    row: 198,
    name: '소프트웨어 활용비',
    unitPrice: 540_000,
    factors: [
      { label: '시트(수량)', value: 4, isPercent: false },
      { label: '월', value: 9, isPercent: false },
    ],
    fileAmount: 19_440_000,
    issues: ['currency'],
  });
  const currency = { symbol: '$', text: '합계($)', row: 196, column: 'K' } as const;

  it('D-10: 통화를 확인하지 않은 세목은 반영 대상에서 뺀다 (오류가 아니다)', () => {
    const preview = build({ blocks: [entry(swBlock, [swRow], { currency })] });
    expect(preview.rows[0]!.status).toBe('skipped');
    expect(preview.rows[0]!.issues).toContain('currency-unconfirmed');
    expect(preview.blocks[0]!.currencyConfirmed).toBe(false);
    expect(preview.blocked).toBe(false);
    expect(preview.summary.totalAmount).toBe(0);
  });

  it('D-10: 확인하면 반영 대상에 들어간다', () => {
    const preview = build({
      blocks: [entry(swBlock, [swRow], { currency })],
      confirmedCurrencyBlocks: [detailBlockKey(swBlock)],
    });
    expect(preview.rows[0]!.status).toBe('new');
    expect(preview.summary.totalAmount).toBe(19_440_000);
  });

  it('D-11: 성명을 잇지 못한 인건비 행은 오류다 (I-4와 같은 형태)', () => {
    const row = makeRow({
      category: 'personnel',
      formula: 'personnel',
      memberName: '홍길동',
      fileSalary: 60_000_000,
      factors: personnelFactors(50, 12),
      fileAmount: 30_000_000,
    });
    const preview = build({ blocks: [entry(makeBlock({ category: 'personnel' }), [row])] });
    expect(preview.rows[0]!.status).toBe('error');
    expect(preview.rows[0]!.issues).toContain('member-unresolved');
    expect(preview.blocked).toBe(true);
  });

  it('건너뛰기로 지정한 성명의 행은 오류가 아니라 건너뜀이다 — 새 인력도 만들지 않는다', () => {
    const row = makeRow({
      category: 'personnel',
      formula: 'personnel',
      memberName: '홍길동',
      fileSalary: 60_000_000,
      factors: personnelFactors(50, 12),
      fileAmount: 30_000_000,
    });
    const preview = build({
      blocks: [entry(makeBlock({ category: 'personnel' }), [row])],
      memberDecisions: { 홍길동: { kind: 'skip' } },
    });
    expect(preview.rows[0]!.status).toBe('skipped');
    expect(preview.newMembers).toEqual([]);
    expect(preview.blocked).toBe(false);
  });

  it('세목을 정하지 못한 블록의 행은 오류다 (세목 없이 저장할 수 없다)', () => {
    const row = makeRow({ category: 'facility_equipment', name: '서버', unitPrice: 1000, fileAmount: 1000 });
    const preview = build({ blocks: [entry(makeBlock({ category: 'facility_equipment' }), [row])] });
    expect(preview.rows[0]!.status).toBe('error');
    expect(preview.rows[0]!.issues).toContain('subcategory-unresolved');
    expect(preview.blocked).toBe(true);
  });

  it('I-12 금액을 못 읽은 행은 오류다', () => {
    const row = makeRow({
      category: 'activity',
      name: '회의비',
      fileAmount: 0,
      issues: ['amount-unparsable'],
    });
    const preview = build({ blocks: [entry(swBlock, [row])] });
    expect(preview.rows[0]!.status).toBe('error');
    expect(preview.blocked).toBe(true);
  });
});

// ─── D-18 소계 대조 ──────────────────────────────────────────

describe('buildDetailPreview — D-18 소계 대조', () => {
  const block = makeBlock({
    category: 'personnel',
    subcategory: null,
    dataStartRow: 64,
    dataEndRow: 91,
  });
  const cashRow = makeRow({
    category: 'personnel',
    formula: 'personnel',
    row: 65,
    memberName: '지동민',
    fileSalary: 84_000_000,
    factors: personnelFactors(64, 9),
    fileAmount: 40_050_000,
  });
  const inKindRow = makeRow({
    category: 'personnel',
    formula: 'personnel',
    row: 66,
    axis: 'in_kind',
    memberName: '지동민',
    fileSalary: 84_000_000,
    factors: personnelFactors(20, 9),
    fileAmount: 12_600_000,
  });

  it('세목 소계는 블록 단위로 대조하고, 어긋나도 반영을 막지 않는다', () => {
    const preview = build({
      blocks: [
        entry(block, [cashRow, inKindRow], {
          subtotals: [
            { row: 88, label: '합계', column: 'J', columnIndex: 9, axis: 'cash', value: 40_050_000, error: null },
            { row: 88, label: '합계', column: 'K', columnIndex: 10, axis: 'in_kind', value: 9_999_999, error: null },
          ],
        }),
      ],
      members: [roster({ id: 'm1', name: '지동민', annualSalary: 84_000_000 })],
    });
    expect(preview.subtotals[0]).toMatchObject({ matches: true, fold: 'block', ourSum: 40_050_000 });
    expect(preview.subtotals[1]).toMatchObject({
      matches: false,
      fileValue: 9_999_999,
      ourSum: 12_600_000,
      difference: 9_999_999 - 12_600_000,
    });
    expect(preview.blocked).toBe(false);
    expect(preview.summary.error).toBe(0);
  });

  it('비목 합계는 그 비목의 블록을 합쳐 대조한다 (부록 B.8.3 L150)', () => {
    const otherBlock = makeBlock({
      category: 'personnel',
      subcategoryRow: 93,
      dataStartRow: 95,
      dataEndRow: 99,
    });
    const otherRow = makeRow({
      category: 'personnel',
      formula: 'personnel',
      row: 95,
      memberName: '지동민',
      fileSalary: 84_000_000,
      factors: personnelFactors(50, 12),
      fileAmount: 34_000_000,
    });
    const preview = build({
      blocks: [
        entry(block, [cashRow], {
          subtotals: [
            { row: 88, label: '합계', column: 'J', columnIndex: 9, axis: 'cash', value: 40_050_000, error: null },
          ],
        }),
        entry(otherBlock, [otherRow], {
          subtotals: [
            // 이 블록의 행만으로는 절대 맞지 않는다 — 비목 전체(40,050,000 + 34,000,000)여야 맞는다
            { row: 99, label: '소 계', column: 'J', columnIndex: 9, axis: 'cash', value: 74_050_000, error: null },
          ],
        }),
      ],
      members: [roster({ id: 'm1', name: '지동민', annualSalary: 84_000_000 })],
    });
    const categoryTotal = preview.subtotals.find((check) => check.row === 99);
    expect(categoryTotal).toMatchObject({
      matches: true,
      fold: 'category',
      ourSum: 74_050_000,
      categorySum: 74_050_000,
    });
  });
});

// ─── D-9 축 재지정 ───────────────────────────────────────────
//
// 합계 열만 있는 세목의 축은 **제안**이다(현금). 자동 확정하지 않고 사용자가 바꿀 수 있어야 하며,
// 축이 바뀌면 그 행의 금액 귀속(현금 합계 ↔ 현물 합계)이 함께 따라가야 한다.

describe('buildDetailPreview — D-9 축 재지정', () => {
  const block = makeBlock({
    category: 'allowance',
    categoryLabel: '- 연구수당',
    dataStartRow: 70,
    dataEndRow: 79,
  });
  const quantity = [{ label: '수량', value: 3, isPercent: false }];

  /** 합계 열만 있어 현금으로 제안된 행 (D-9) */
  const suggestedRow = makeRow({
    category: 'allowance',
    row: 70,
    axis: 'cash',
    axisSuggested: true,
    name: '연구수당',
    unitPrice: 1_000_000,
    factors: quantity,
    fileAmount: 3_000_000,
  });

  const subtotals = [
    { row: 80, label: '소 계', column: 'J', columnIndex: 9, axis: 'cash' as const, value: 3_000_000, error: null },
    { row: 80, label: '소 계', column: 'K', columnIndex: 10, axis: 'in_kind' as const, value: 3_000_000, error: null },
  ];

  it('제안된 축은 그대로 두고 재지정이 없으면 axis = axisAuto다', () => {
    const preview = build({ blocks: [entry(block, [suggestedRow])] });
    expect(preview.rows[0]).toMatchObject({ axis: 'cash', axisAuto: 'cash', axisSuggested: true });
  });

  it('축 재지정이 적용된다 — 반영 페이로드까지 바뀐 축으로 나간다', () => {
    const key = detailRowKey(suggestedRow);
    const preview = build({
      blocks: [entry(block, [suggestedRow])],
      axisOverrides: { [key]: 'in_kind' },
    });
    expect(preview.rows[0]).toMatchObject({ axis: 'in_kind', axisAuto: 'cash', axisSuggested: true });
    expect(toDetailCommitRows(preview).rows[0]!.axis).toBe('in_kind');
  });

  it('현금 → 현물로 바꾸면 축별 합계가 옮겨간다 (총액은 그대로다)', () => {
    const before = build({ blocks: [entry(block, [suggestedRow], { subtotals })] });
    expect(before.subtotals).toMatchObject([
      { axis: 'cash', ourSum: 3_000_000, matches: true },
      { axis: 'in_kind', ourSum: 0, matches: false },
    ]);

    const after = build({
      blocks: [entry(block, [suggestedRow], { subtotals })],
      axisOverrides: { [detailRowKey(suggestedRow)]: 'in_kind' },
    });
    expect(after.subtotals).toMatchObject([
      { axis: 'cash', ourSum: 0, matches: false },
      { axis: 'in_kind', ourSum: 3_000_000, matches: true },
    ]);
    // 축만 옮겼을 뿐 금액을 만들거나 지운 것이 아니다
    expect(after.summary.totalAmount).toBe(before.summary.totalAmount);
  });

  it('파일이 축을 명시해 행이 갈린 경우(axisSuggested=false)는 재지정을 무시한다', () => {
    const splitCash = makeRow({
      category: 'allowance',
      row: 71,
      axisIndex: 0,
      axis: 'cash',
      unitPrice: 1_000_000,
      factors: quantity,
      fileAmount: 3_000_000,
    });
    const splitInKind = makeRow({
      category: 'allowance',
      row: 71,
      axisIndex: 1,
      axis: 'in_kind',
      unitPrice: 500_000,
      factors: quantity,
      fileAmount: 1_500_000,
    });
    const preview = build({
      blocks: [entry(block, [splitCash, splitInKind])],
      // 서버가 이미 거부하는 조합이다 — 순수 함수도 같은 판단이어야 한다
      axisOverrides: {
        [detailRowKey(splitCash)]: 'in_kind',
        [detailRowKey(splitInKind)]: 'cash',
      },
    });
    expect(preview.rows.map((row) => row.axis)).toEqual(['cash', 'in_kind']);
    expect(preview.rows.map((row) => row.axisAuto)).toEqual(['cash', 'in_kind']);
  });

  it('원본을 고치지 않는다 — 입력 블록·행이 그대로다', () => {
    const blocks = [entry(block, [suggestedRow], { subtotals })];
    const snapshot = structuredClone(blocks);
    build({ blocks, axisOverrides: { [detailRowKey(suggestedRow)]: 'in_kind' } });
    expect(blocks).toEqual(snapshot);
    expect(suggestedRow.axis).toBe('cash');
  });
});

// ─── 요약 · 반영 대상 변환 ───────────────────────────────────

describe('toDetailCommitRows', () => {
  const personnelBlock = makeBlock({ category: 'personnel' });
  const personnelRow = makeRow({
    category: 'personnel',
    formula: 'personnel',
    row: 65,
    memberName: '지동민',
    position: '책임연구원',
    hireTypeLabel: '신규채용',
    fileSalary: 84_000_000,
    factors: personnelFactors(64, 9),
    fileAmount: 40_050_000,
  });
  const activityBlock = makeBlock({
    category: 'activity',
    categoryLabel: '마. 연구활동비',
    subcategory: 'activity_meeting',
    subcategoryRow: 174,
  });
  const activityRows = [
    makeRow({
      category: 'activity',
      row: 177,
      name: '착수회의',
      spec: '단가 × 회',
      note: '메모',
      unitPrice: 500_000,
      factors: [{ label: '회', value: 6, isPercent: false }],
      fileAmount: 3_000_000,
    }),
    makeRow({
      category: 'activity',
      row: 178,
      name: '중간회의',
      unitPrice: 200_000,
      factors: [{ label: '회', value: 2, isPercent: false }],
      fileAmount: 400_000,
    }),
  ];

  function preview() {
    return build({
      blocks: [entry(personnelBlock, [personnelRow]), entry(activityBlock, activityRows)],
      members: [],
      memberDecisions: { 지동민: { kind: 'create', orgId: 'org-a' } },
    });
  }

  it('요약은 신규·건너뜀·오류·새 인력·교체 셀·합계 금액을 센다', () => {
    expect(preview().summary).toEqual({
      new: 3,
      skipped: 0,
      error: 0,
      newMembers: 1,
      replaceCells: 0,
      totalAmount: 40_050_000 + 3_000_000 + 400_000,
    });
  });

  it('RPC 페이로드 형태로 바꾼다 — 세목 안에서 sort_order가 0부터다', () => {
    const payload = toDetailCommitRows(preview());
    expect(payload.yearId).toBe('year-1');
    expect(payload.newMembers).toEqual([
      {
        tempKey: 'new:지동민',
        name: '지동민',
        position: '책임연구원',
        annual_salary: 84_000_000,
        hire_type: 'new',
        org_id: 'org-a',
      },
    ]);
    expect(payload.rows[0]).toEqual({
      category: 'personnel',
      subcategory: 'personnel_internal',
      axis: 'cash',
      formula: 'personnel',
      amount: 40_050_000,
      member_id: null,
      memberTempKey: 'new:지동민',
      name: '',
      spec: '',
      note: '',
      unit_price: 0,
      factors: personnelFactors(64, 9),
      adjustment: -270_000,
      sort_order: 0,
    });
    expect(payload.rows.map((row) => row.sort_order)).toEqual([0, 0, 1]);
    expect(payload.rows[1]).toMatchObject({
      category: 'activity',
      subcategory: 'activity_meeting',
      member_id: null,
      memberTempKey: null,
      name: '착수회의',
      spec: '단가 × 회',
      note: '메모',
      unit_price: 500_000,
      amount: 3_000_000,
    });
  });

  it('기존 인력을 고른 행은 member_id로 나간다', () => {
    const result = build({
      blocks: [entry(personnelBlock, [personnelRow])],
      members: [roster({ id: 'm1', name: '지동민', annualSalary: 84_000_000 })],
    });
    const payload = toDetailCommitRows(result);
    expect(payload.rows[0]).toMatchObject({ member_id: 'm1', memberTempKey: null });
    expect(payload.newMembers).toEqual([]);
  });

  it('blocked면 던진다 (판정을 다시 하지 않는다)', () => {
    const blocked = build({
      blocks: [entry(personnelBlock, [personnelRow])],
      members: [],
    });
    expect(blocked.blocked).toBe(true);
    expect(() => toDetailCommitRows(blocked)).toThrow(RuleViolationError);
  });

  it('건너뛴 행은 페이로드에 실리지 않는다', () => {
    const result = build({
      blocks: [entry(activityBlock, activityRows)],
      existingCells: [{ category: 'activity', rowCount: 2 }],
    });
    expect(toDetailCommitRows(result).rows).toEqual([]);
  });
});
