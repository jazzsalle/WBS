// 보내기 편성 항목(SOT §5.21 AV-6 ③, Phase 26 S-14, 부록 B.9.7 EQ-3)

import { describe, expect, it } from 'vitest';
import { buildBaselineFromPlan, type PlanDetailInput } from '@/lib/agreement/from-plan';
import { AGREEMENT_EVIDENCE_DEFAULTS } from '@/lib/constants';
import type { AgreementItemKind, DetailFactor } from '@/types';

const YEARS = [
  { id: 'Y2', name: '2차년도', order: 1 },
  { id: 'Y1', name: '1차년도', order: 0 },
];

const QTY = (n: number): DetailFactor[] => [{ label: '수량', value: n, isPercent: false }];

function detail(
  over: Partial<PlanDetailInput> & Pick<PlanDetailInput, 'category' | 'subcategory' | 'amount'>
): PlanDetailInput {
  return { yearId: 'Y1', axis: 'cash', formula: 'quantity', memberId: null, factors: [], name: '', ...over };
}

const evidenceOf = (kind: AgreementItemKind) =>
  AGREEMENT_EVIDENCE_DEFAULTS[kind].map((label) => ({ label, obtained: false, memo: '' }));

function send(details: PlanDetailInput[]) {
  const r = buildBaselineFromPlan({ items: [], details, members: [], years: YEARS });
  if (!r.ok) throw new Error(r.issues.map((i) => i.message).join('\n'));
  return r;
}

describe('buildBaselineFromPlan 편성 항목 (AV-6 ③) — B.9.3/EQ-3 4건', () => {
  // B.9.3: 장비 35,000,000 × 1, 재료 같은 품명 두 행 12,000,000·9,000,000, 외주 29,990,000
  const B93: PlanDetailInput[] = [
    detail({ category: 'facility_equipment', subcategory: 'facility_purchase', name: '분석 장비', factors: QTY(1), amount: 35_000_000 }),
    detail({ category: 'material', subcategory: 'material_purchase', name: '시약', factors: QTY(1), amount: 12_000_000 }),
    detail({ category: 'material', subcategory: 'material_purchase', name: '시약', factors: QTY(1), amount: 9_000_000 }),
    detail({ category: 'activity', subcategory: 'activity_outsourcing', name: '시제품 가공', factors: QTY(1), amount: 29_990_000 }),
  ];
  const r = send(B93);

  it('산출 행 1개 = 1건, 같은 품명도 합치지 않는다', () => {
    expect(r.items).toEqual([
      { yearId: 'Y1', kind: 'equipment', name: '분석 장비', amount: 35_000_000, quantity: 1, evidence: evidenceOf('equipment') },
      { yearId: 'Y1', kind: 'material', name: '시약', amount: 12_000_000, quantity: 1, evidence: evidenceOf('material') },
      { yearId: 'Y1', kind: 'material', name: '시약', amount: 9_000_000, quantity: 1, evidence: evidenceOf('material') },
      { yearId: 'Y1', kind: 'outsourcing', name: '시제품 가공', amount: 29_990_000, quantity: 1, evidence: evidenceOf('outsourcing') },
    ]);
    expect(r.itemSummary).toEqual({ count: 4, unnamedCount: 0 });
  });

  it('금액 줄은 그대로 세목 합산 — 편성 항목 합 = 대응 세목 줄(대조 0)', () => {
    const lineOf = (sub: string) => r.lines.find((l) => l.subcategoryCode === sub)?.amount;
    const itemsOf = (kind: AgreementItemKind) => r.items.filter((i) => i.kind === kind).reduce((s, i) => s + i.amount, 0);
    expect(lineOf('facility_purchase')).toBe(itemsOf('equipment'));
    expect(lineOf('material_purchase')).toBe(21_000_000);
    expect(itemsOf('material')).toBe(21_000_000);
    expect(lineOf('activity_outsourcing')).toBe(itemsOf('outsourcing'));
    expect(r.summary.lineCount).toBe(3);
    expect(r.summary.cashTotal).toBe(85_990_000);
  });

  it('증빙은 복사본이다 — 상수 배열과 같은 참조가 아니다', () => {
    r.items[0]!.evidence[0]!.obtained = true;
    expect(send(B93).items[0]!.evidence[0]!.obtained).toBe(false);
    expect(AGREEMENT_EVIDENCE_DEFAULTS.equipment[0]).toBe('견적서');
  });
});

describe('편성 항목 매핑 범위', () => {
  it('구입·외주 세목만 — 임차·관리비·다른 활동비·default·인건비는 건이 아니다', () => {
    const r = send([
      detail({ category: 'facility_equipment', subcategory: 'facility_lease', name: '임차', factors: QTY(1), amount: 1_000_000 }),
      detail({ category: 'material', subcategory: 'material_manage', name: '관리', factors: QTY(1), amount: 500_000 }),
      detail({ category: 'activity', subcategory: 'activity_meeting', name: '회의', amount: 300_000 }),
      detail({ category: 'material', subcategory: 'default', name: '기타 재료', amount: 200_000 }),
    ]);
    expect(r.items).toEqual([]);
    expect(r.itemSummary).toEqual({ count: 0, unnamedCount: 0 });
    expect(r.lines).toHaveLength(4);
  });

  it('산출근거가 없는 셀은 편성 항목을 만들지 않는다', () => {
    const r = buildBaselineFromPlan({
      items: [{ yearId: 'Y1', category: 'material', plannedAmount: 5_000_000, cashAmount: 5_000_000, inKindAmount: 0 }],
      details: [],
      members: [],
      years: YEARS,
    });
    expect(r.ok && r.items).toEqual([]);
  });

  it('현물 축 행도 1건 — 축은 편성 항목에 없다', () => {
    const r = send([detail({ category: 'material', subcategory: 'material_purchase', axis: 'in_kind', name: '현물 재료', amount: 700_000 })]);
    expect(r.items.map((i) => [i.name, i.amount])).toEqual([['현물 재료', 700_000]]);
  });

  it('0원 행도 1건(금액 줄은 0이라 만들지 않는다)', () => {
    const r = send([detail({ category: 'material', subcategory: 'material_purchase', name: '무상 시료', factors: QTY(3), amount: 0 })]);
    expect(r.items).toHaveLength(1);
    expect(r.items[0]!.amount).toBe(0);
    expect(r.lines).toEqual([]);
  });

  it('순서 — 연차 order → 장비·재료·외주 → 입력 순', () => {
    const r = send([
      detail({ yearId: 'Y2', category: 'facility_equipment', subcategory: 'facility_purchase', name: 'Y2 장비', amount: 1 }),
      detail({ category: 'activity', subcategory: 'activity_outsourcing', name: 'Y1 외주', amount: 2 }),
      detail({ category: 'material', subcategory: 'material_purchase', name: 'Y1 재료 가', amount: 3 }),
      detail({ category: 'facility_equipment', subcategory: 'facility_purchase', name: 'Y1 장비', amount: 4 }),
      detail({ category: 'material', subcategory: 'material_purchase', name: 'Y1 재료 나', amount: 5 }),
    ]);
    expect(r.items.map((i) => i.name)).toEqual(['Y1 장비', 'Y1 재료 가', 'Y1 재료 나', 'Y1 외주', 'Y2 장비']);
  });
});

describe('품명', () => {
  it('앞뒤 공백을 지운다', () => {
    const r = send([detail({ category: 'material', subcategory: 'material_purchase', name: '  시약 A \n', amount: 100 })]);
    expect(r.items[0]!.name).toBe('시약 A');
    expect(r.itemSummary.unnamedCount).toBe(0);
  });

  it('비거나 공백뿐이면 세목 라벨, 그 건수를 unnamedCount에', () => {
    const r = send([
      detail({ category: 'facility_equipment', subcategory: 'facility_purchase', name: '', amount: 100 }),
      detail({ category: 'material', subcategory: 'material_purchase', name: '   ', amount: 200 }),
      detail({ category: 'activity', subcategory: 'activity_outsourcing', name: '설계 용역', amount: 300 }),
    ]);
    expect(r.items.map((i) => i.name)).toEqual(['① 연구시설·장비 구입·설치비', '① 연구재료 구입비', '설계 용역']);
    expect(r.itemSummary).toEqual({ count: 3, unnamedCount: 2 });
  });

  it('name 생략 = 빈 품명', () => {
    const { name: _omit, ...noName } = detail({ category: 'activity', subcategory: 'activity_outsourcing', amount: 300 });
    const r = send([noName]);
    expect(r.items[0]!.name).toBe('① 외주용역비');
    expect(r.itemSummary.unnamedCount).toBe(1);
  });
});

describe('수량', () => {
  const qty = (factors: DetailFactor[]) =>
    send([detail({ category: 'material', subcategory: 'material_purchase', name: '재료', factors, amount: 100 })]).items[0]!.quantity;

  it('첫 수량 인자 값(소수 허용)', () => {
    expect(qty(QTY(3))).toBe(3);
    expect(qty(QTY(2.5))).toBe(2.5);
    expect(qty([{ label: '회', value: 4, isPercent: false }, { label: '수량', value: 7, isPercent: false }, { label: '수량', value: 9, isPercent: false }])).toBe(7);
    expect(qty(QTY(0))).toBe(0);
  });

  it('없거나 음수·백분율이면 null', () => {
    expect(qty([])).toBeNull();
    expect(qty([{ label: '회', value: 4, isPercent: false }])).toBeNull();
    expect(qty(QTY(-1))).toBeNull();
    expect(qty([{ label: '수량', value: 50, isPercent: true }])).toBeNull();
  });
});

describe('음수 산출 행 — negative_item', () => {
  it('위치(연차·비목·세목)를 적어 거부하고 버전을 만들지 않는다', () => {
    const r = buildBaselineFromPlan({
      items: [],
      details: [
        detail({ category: 'material', subcategory: 'material_purchase', name: '시약', amount: 1_000_000 }),
        detail({ yearId: 'Y2', category: 'material', subcategory: 'material_purchase', name: '환불', amount: -300_000 }),
      ],
      members: [],
      years: YEARS,
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.issues).toEqual([
      {
        code: 'negative_item',
        yearId: 'Y2',
        category: 'material',
        message: '2차년도 연구재료비: ① 연구재료 구입비 산출 행 금액이 음수입니다 (-300,000원).',
      },
      expect.objectContaining({ code: 'negative_group', yearId: 'Y2' }),
    ]);
  });

  it('세목 합은 양수여도 음수 행은 거부한다(조정 행을 건으로 만들지 않는다)', () => {
    const r = buildBaselineFromPlan({
      items: [],
      details: [
        detail({ category: 'activity', subcategory: 'activity_outsourcing', name: '용역', amount: 5_000_000 }),
        detail({ category: 'activity', subcategory: 'activity_outsourcing', name: '절사', amount: -10 }),
      ],
      members: [],
      years: YEARS,
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.issues.map((i) => i.code)).toEqual(['negative_item']);
  });
});
