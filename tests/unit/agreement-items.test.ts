// 협약 예산 편성 항목·증빙 모델 (SOT §5.24, §6.19 AG-6·AG-8, §7.9.8, 계획서 S-1·S-2·S-10·S-12·U-1·U-3·픽스처 "증빙 잠금").
//
// 경고 배지는 판정기 결과를 붙일 뿐이다 — 여기 테스트는 금액이 기준 이상이어도 finding이 없으면 배지가 없고,
// 금액이 작아도 finding이 있으면 붙는 것으로 "보기에 비교 코드가 없다"를 고정한다.

import { describe, expect, it } from 'vitest';
import { AGREEMENT_EVIDENCE_DEFAULTS } from '@/lib/constants';
import {
  EVIDENCE_LOCKED_MESSAGE,
  assertStoredEvidence,
  defaultEvidence,
  evidenceDetailText,
  evidenceProgress,
  evidenceProgressText,
  resolveEvidenceUpdate,
  sameEvidenceLabels,
  validateEvidence,
} from '@/lib/agreement/evidence';
import { ITEMS_SHEET_NAME, buildItemsView, itemsTable } from '@/lib/agreement/items-view';
import type { ItemReconcileLine, ViewItem } from '@/lib/agreement/items-view';
import { assertTableModel, toFormSheet, toTsv } from '@/lib/agreement/table';
import type { RuleFinding } from '@/lib/rules';
import type { AgreementEvidenceCheck, AgreementItemKind } from '@/types';

// ─── 픽스처 ───────────────────────────────────────────────────────────────────

const YEARS = [
  { id: 'y2', name: '2차년도', order: 2 },
  { id: 'y1', name: '1차년도', order: 1 },
];

function item(id: string, fields: Partial<ViewItem> & Pick<ViewItem, 'yearId' | 'kind' | 'name' | 'amount'>): ViewItem {
  return { id, quantity: null, evidence: [], ...fields };
}

function line(
  yearId: string,
  category: ItemReconcileLine['category'],
  subcategoryCode: string,
  axis: 'cash' | 'in_kind',
  amount: number
): ItemReconcileLine {
  return { yearId, category, subcategoryCode, axis, amount };
}

function itemFinding(itemId: string, yearId: string, code: RuleFinding['code'] = 'equipment_review_threshold'): RuleFinding {
  return {
    code,
    severity: 'warn',
    scope: { kind: 'item', yearId, itemId, category: 'facility_equipment' },
    actual: 33_000_000,
    limit: 30_000_000,
    message: '장비 사전 승인 대상',
    approximate: false,
  };
}

const ev = (label: string, obtained = false, memo = ''): AgreementEvidenceCheck => ({ label, obtained, memo });

// ─── 기본 목록 복사 (S-2, U-1) ────────────────────────────────────────────────

describe('defaultEvidence — 기본 목록 복사', () => {
  it.each<[AgreementItemKind, string[]]>([
    ['equipment', ['견적서', '비교견적서', '구매요청서', '계약서', '거래명세서', '검수조서', '세금계산서', 'ZEUS 등록 확인']],
    ['material', ['견적서', '비교견적서', '구매요청서', '거래명세서', '검수조서', '세금계산서']],
    ['outsourcing', ['과업지시서', '견적서', '비교견적서', '계약서', '중간산출물', '최종 결과물', '검수조서', '세금계산서']],
  ])('%s — §5.24 표 순서, 전부 안 받음·메모 없음', (kind, labels) => {
    expect(defaultEvidence(kind)).toEqual(labels.map((label) => ({ label, obtained: false, memo: '' })));
  });

  it('부를 때마다 새 배열·새 객체 — 한쪽을 고쳐도 다른 쪽·상수는 그대로', () => {
    const a = defaultEvidence('equipment');
    const b = defaultEvidence('equipment');
    expect(a).not.toBe(b);
    expect(a[0]).not.toBe(b[0]);
    a[0]!.obtained = true;
    a[0]!.label = '바뀐 이름';
    a.push(ev('추가'));
    expect(b[0]).toEqual(ev('견적서'));
    expect(b).toHaveLength(8);
    expect(AGREEMENT_EVIDENCE_DEFAULTS.equipment[0]).toBe('견적서');
    expect(AGREEMENT_EVIDENCE_DEFAULTS.equipment).toHaveLength(8);
  });

  it('상수가 바뀌어도 이미 만든(저장된) 목록은 그대로 — 복사본은 독립', () => {
    const stored = defaultEvidence('material');
    const constant = AGREEMENT_EVIDENCE_DEFAULTS.material as string[];
    const original = [...constant];
    try {
      constant.push('새 서류');
      constant[0] = '바뀐 견적서';
      expect(stored.map((c) => c.label)).toEqual(original);
      expect(defaultEvidence('material').map((c) => c.label)).toEqual(['바뀐 견적서', ...original.slice(1), '새 서류']);
    } finally {
      constant.splice(0, constant.length, ...original);
    }
  });
});

// ─── 검증 경계 (S-12) ─────────────────────────────────────────────────────────

describe('validateEvidence — Zod·DB check와 같은 규칙', () => {
  it('빈 목록 통과', () => {
    expect(validateEvidence([])).toEqual({ ok: true, evidence: [] });
  });

  it('30개 통과 · 31개 거부', () => {
    const many = (n: number) => Array.from({ length: n }, (_, i) => ev(`서류 ${i + 1}`));
    expect(validateEvidence(many(30)).ok).toBe(true);
    const r = validateEvidence(many(31));
    expect(r).toEqual({ ok: false, messages: ['증빙은 30개 이하여야 합니다 (31개).'] });
  });

  it('라벨 100자 통과 · 101자 거부 — trim 뒤 길이', () => {
    expect(validateEvidence([ev('가'.repeat(100))]).ok).toBe(true);
    expect(validateEvidence([ev(`  ${'가'.repeat(100)}  `)]).ok).toBe(true);
    const r = validateEvidence([ev('가'.repeat(101))]);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.messages).toEqual(['증빙 1번째: 증빙 이름은 100자 이내여야 합니다 (101자).']);
  });

  it('공백만인 라벨 거부', () => {
    const r = validateEvidence([ev('견적서'), ev('   ')]);
    expect(r).toEqual({ ok: false, messages: ['증빙 2번째: 증빙 이름을 입력하세요.'] });
  });

  it('메모 500자 통과 · 501자 거부(메모는 trim하지 않는다)', () => {
    expect(validateEvidence([ev('견적서', false, '메'.repeat(500))]).ok).toBe(true);
    const r = validateEvidence([ev('견적서', false, '메'.repeat(501))]);
    expect(r).toEqual({ ok: false, messages: ['증빙 1번째: 증빙 메모는 500자 이내여야 합니다 (501자).'] });
  });

  it('중복 라벨 거부 — trim 뒤 같으면 중복', () => {
    const r = validateEvidence([ev('견적서'), ev(' 견적서 ')]);
    expect(r).toEqual({ ok: false, messages: ['증빙 2번째: 증빙 이름 "견적서"이(가) 중복됩니다.'] });
  });

  it('통과하면 라벨을 trim한 새 배열 — 입력은 그대로', () => {
    const input = [ev(' 견적서 ', true, ' 2개사 ')];
    const r = validateEvidence(input);
    expect(r).toEqual({ ok: true, evidence: [ev('견적서', true, ' 2개사 ')] });
    expect(input[0]!.label).toBe(' 견적서 ');
  });

  it('런타임 모양이 틀리면 거부(문구 전부 모음)', () => {
    const bad = [{ label: 1, obtained: true, memo: '' }, { label: '계약서', obtained: 'yes', memo: null }, null] as unknown as AgreementEvidenceCheck[];
    const r = validateEvidence(bad);
    expect(r).toEqual({
      ok: false,
      messages: [
        '증빙 1번째: 증빙 이름이 올바르지 않습니다.',
        '증빙 2번째: 받음 여부가 올바르지 않습니다.',
        '증빙 2번째: 증빙 메모가 올바르지 않습니다.',
        '증빙 3번째: 증빙 항목이 올바르지 않습니다.',
      ],
    });
  });
});

describe('assertStoredEvidence — 손상 저장값은 던진다', () => {
  it.each([
    ['배열 아님', { label: '견적서' }],
    ['빈 라벨', [ev('  ')]],
    ['중복', [ev('견적서'), ev('견적서')]],
    ['obtained 누락', [{ label: '견적서', memo: '' }]],
    ['31개', Array.from({ length: 31 }, (_, i) => ev(`서류 ${i}`))],
  ])('%s', (_, value) => {
    expect(() => assertStoredEvidence(value, '편성 항목')).toThrow();
  });
});

// ─── 확정 잠금 해석 (S-1, U-3, 픽스처 "증빙 잠금") ─────────────────────────────

describe('resolveEvidenceUpdate — 증빙 잠금', () => {
  // 확정 버전 장비 33,000,000, 증빙 [견적서 true "2개사"]
  const before = [ev('견적서', true, '2개사')];

  it('확정: 체크 해제 성공', () => {
    expect(resolveEvidenceUpdate(before, [ev('견적서', false, '2개사')], true)).toEqual({
      kind: 'ok',
      evidence: [ev('견적서', false, '2개사')],
    });
  });

  it('확정: 메모 변경 성공', () => {
    expect(resolveEvidenceUpdate(before, [ev('견적서', true, '3개사 비교')], true)).toEqual({
      kind: 'ok',
      evidence: [ev('견적서', true, '3개사 비교')],
    });
  });

  it('확정: 라벨 앞뒤 공백만 다르면 정규화 뒤 같으므로 허용', () => {
    expect(resolveEvidenceUpdate(before, [ev(' 견적서 ', false, '')], true).kind).toBe('ok');
  });

  it.each([
    ['이름 변경', [ev('비교견적서', true, '2개사')]],
    ['추가', [ev('견적서', true, '2개사'), ev('계약서')]],
    ['삭제', []],
  ])('확정: 라벨 %s → locked', (_, after) => {
    expect(resolveEvidenceUpdate(before, after, true)).toEqual({
      kind: 'reject',
      reason: 'locked',
      messages: [EVIDENCE_LOCKED_MESSAGE],
    });
  });

  it('확정: 순서 변경 → locked', () => {
    const two = [ev('견적서'), ev('계약서')];
    expect(resolveEvidenceUpdate(two, [ev('계약서'), ev('견적서')], true).kind).toBe('reject');
  });

  it('작성 중: 이름 변경·추가·삭제·순서 전부 허용', () => {
    expect(resolveEvidenceUpdate(before, [ev('비교견적서')], false).kind).toBe('ok');
    expect(resolveEvidenceUpdate(before, [ev('견적서', true, '2개사'), ev('계약서')], false).kind).toBe('ok');
    expect(resolveEvidenceUpdate(before, [], false)).toEqual({ kind: 'ok', evidence: [] });
  });

  it('검증 실패는 확정 여부와 무관하게 invalid', () => {
    const r = resolveEvidenceUpdate(before, [ev('견적서', true, '메'.repeat(501))], true);
    expect(r).toMatchObject({ kind: 'reject', reason: 'invalid' });
  });

  it('저장값이 손상돼 있으면 던진다', () => {
    expect(() => resolveEvidenceUpdate([ev('a'), ev('a')], [], false)).toThrow();
  });

  it('sameEvidenceLabels — 순서 포함', () => {
    expect(sameEvidenceLabels([ev('a', true)], [ev('a', false, 'm')])).toBe(true);
    expect(sameEvidenceLabels([ev('a'), ev('b')], [ev('b'), ev('a')])).toBe(false);
    expect(sameEvidenceLabels([ev('a')], [ev('a'), ev('b')])).toBe(false);
  });
});

describe('진행·글자', () => {
  const list = [ev('견적서', true, '2개사'), ev('계약서'), ev('검수조서', true, '  ')];

  it('n/m', () => {
    expect(evidenceProgress(list)).toEqual({ obtained: 2, total: 3 });
    expect(evidenceProgressText(evidenceProgress(list))).toBe('받음 2/3');
    expect(evidenceProgressText(evidenceProgress([]))).toBe('받음 0/0');
  });

  it('"라벨: 받음/안 받음 · 메모"를 "; "로 — 빈 메모는 생략', () => {
    expect(evidenceDetailText(list)).toBe('견적서: 받음 · 2개사; 계약서: 안 받음; 검수조서: 받음');
    expect(evidenceDetailText([])).toBe('');
  });
});

// ─── 보기 모델 (AG-6) ─────────────────────────────────────────────────────────

const ITEMS: ViewItem[] = [
  item('i3', { yearId: 'y1', kind: 'material', name: '시약', amount: 5_000_000, quantity: 10, evidence: defaultEvidence('material') }),
  item('i1', { yearId: 'y1', kind: 'equipment', name: '현미경', amount: 33_000_000, evidence: [ev('견적서', true, '2개사')] }),
  item('i2', { yearId: 'y1', kind: 'equipment', name: '가속도계', amount: 2_000_000, quantity: 1.5 }),
  item('i4', { yearId: 'y2', kind: 'outsourcing', name: '시험 분석', amount: 12_000_000 }),
];

const LINES: ItemReconcileLine[] = [
  line('y1', 'facility_equipment', 'facility_purchase', 'cash', 30_000_000),
  line('y1', 'facility_equipment', 'facility_purchase', 'in_kind', 5_000_000),
  line('y1', 'facility_equipment', 'facility_lease', 'cash', 9_000_000), // 대응 세목 아님
  line('y1', 'material', 'material_purchase', 'cash', 5_000_000),
  line('y1', 'activity', 'activity_outsourcing', 'cash', 0), // y1 외주: 줄은 있고 0원, 항목 없음
  line('y2', 'material', 'material_purchase', 'cash', 1_000_000), // y2 재료: 줄만 있음
  line('y2', 'material', 'default', 'cash', 7_000_000), // 세목 미지정은 대응 아님
];

function view(findings: RuleFinding[] = []) {
  return buildItemsView({ items: ITEMS, lines: LINES, years: YEARS, findings });
}

describe('buildItemsView — 순서·대조', () => {
  it('연차 → 종류(장비·재료·외주) → 품명 순, 라벨로 표시', () => {
    const v = view();
    expect(v.rows.map((r) => [r.yearName, r.kindLabel, r.name])).toEqual([
      ['1차년도', '장비', '가속도계'],
      ['1차년도', '장비', '현미경'],
      ['1차년도', '재료', '시약'],
      ['2차년도', '외주용역', '시험 분석'],
    ]);
    expect(v.rows[1]!.progressText).toBe('받음 1/1');
    expect(v.rows[2]!.progressText).toBe('받음 0/6');
    expect(v.rows[0]!.progressText).toBe('받음 0/0');
  });

  it('연차 × 종류 대조 — Σ편성 항목 − Σ대응 세목 줄(현금+현물), 표시만', () => {
    const v = view();
    const summary = v.years.map((y) => ({
      year: y.yearName,
      amount: y.amount,
      itemCount: y.itemCount,
      kinds: y.kinds.map((k) => [k.kindLabel, k.itemsTotal, k.lineTotal, k.diff, k.matches]),
    }));
    expect(summary).toEqual([
      {
        year: '1차년도',
        amount: 40_000_000,
        itemCount: 3,
        kinds: [
          ['장비', 35_000_000, 35_000_000, 0, true],
          ['재료', 5_000_000, 5_000_000, 0, true],
          ['외주용역', 0, 0, 0, true],
        ],
      },
      {
        year: '2차년도',
        amount: 12_000_000,
        itemCount: 1,
        kinds: [
          ['재료', 0, 1_000_000, -1_000_000, false],
          ['외주용역', 12_000_000, null, 12_000_000, false],
        ],
      },
    ]);
    expect(v.grandTotal).toEqual({ itemCount: 4, amount: 52_000_000 });
    expect(v.hasDifference).toBe(true);
    expect(v.years[0]!.kinds[0]!.subcategoryLabel).toBe('① 연구시설·장비 구입·설치비');
  });

  it('편성 항목 0건·대응 줄 0건 → 빈 보기(0원 행을 지어내지 않는다)', () => {
    const v = buildItemsView({ items: [], lines: [], years: YEARS, findings: [] });
    expect(v).toEqual({ years: [], rows: [], grandTotal: { itemCount: 0, amount: 0 }, hasDifference: false });
  });

  it('증빙은 복사본 — 보기를 고쳐도 입력은 그대로', () => {
    const v = view();
    v.rows[1]!.evidence[0]!.obtained = false;
    expect(ITEMS[1]!.evidence[0]!.obtained).toBe(true);
  });
});

describe('buildItemsView — finding 부착(비교 코드 없음)', () => {
  it('scope item만 itemId로 붙고, 다른 scope는 무시', () => {
    const findings: RuleFinding[] = [
      itemFinding('i2', 'y1'), // 2,000,000이지만 finding이 있으면 붙는다 — 보기는 금액을 보지 않는다
      { ...itemFinding('i4', 'y2', 'outsourcing_notice_threshold') },
      { code: 'indirect_max', severity: 'warn', scope: { kind: 'year', yearId: 'y1' }, actual: 20, limit: 17, message: '간접비', approximate: false },
    ];
    const v = view(findings);
    const byId = new Map(v.rows.map((r) => [r.id, r.findings.map((f) => f.code)]));
    expect(byId.get('i1')).toEqual([]); // 33,000,000이지만 finding이 없으면 배지 없음
    expect(byId.get('i2')).toEqual(['equipment_review_threshold']);
    expect(byId.get('i4')).toEqual(['outsourcing_notice_threshold']);
    expect(byId.get('i3')).toEqual([]);
  });

  it('보기에 없는 건·연차가 다른 finding은 던진다(다른 버전의 판정 결과)', () => {
    expect(() => view([itemFinding('nope', 'y1')])).toThrow('이 버전에 없는 편성 항목');
    expect(() => view([itemFinding('i1', 'y2')])).toThrow('연차');
  });
});

describe('buildItemsView — 손상 입력', () => {
  const base = { lines: [], years: YEARS, findings: [] };
  it.each<[string, ViewItem]>([
    ['소수 금액', item('x', { yearId: 'y1', kind: 'equipment', name: 'a', amount: 1.5 })],
    ['음수 금액', item('x', { yearId: 'y1', kind: 'equipment', name: 'a', amount: -1 })],
    ['음수 수량', item('x', { yearId: 'y1', kind: 'equipment', name: 'a', amount: 1, quantity: -1 })],
    ['빈 품명', item('x', { yearId: 'y1', kind: 'equipment', name: '  ', amount: 1 })],
    ['모르는 종류', item('x', { yearId: 'y1', kind: 'lease' as AgreementItemKind, name: 'a', amount: 1 })],
    ['모르는 연차', item('x', { yearId: 'y9', kind: 'equipment', name: 'a', amount: 1 })],
    ['중복 증빙', item('x', { yearId: 'y1', kind: 'equipment', name: 'a', amount: 1, evidence: [ev('a'), ev('a')] })],
  ])('%s', (_, bad) => {
    expect(() => buildItemsView({ ...base, items: [bad] })).toThrow();
  });

  it('같은 id 두 번', () => {
    const a = item('x', { yearId: 'y1', kind: 'equipment', name: 'a', amount: 1 });
    expect(() => buildItemsView({ ...base, items: [a, a] })).toThrow('두 번');
  });

  it('대응 세목 줄의 금액 손상·모르는 연차', () => {
    expect(() => buildItemsView({ ...base, items: [], lines: [line('y1', 'material', 'material_purchase', 'cash', 0.5)] })).toThrow();
    expect(() => buildItemsView({ ...base, items: [], lines: [line('y9', 'material', 'material_purchase', 'cash', 1)] })).toThrow();
  });
});

// ─── 표 모델 (AG-8, §7.9.8) ───────────────────────────────────────────────────

describe('itemsTable', () => {
  const model = itemsTable(view(), '편성 항목·증빙');

  it('assertTableModel 통과, 연차 소계·합계는 sum', () => {
    expect(() => assertTableModel(model)).not.toThrow();
    expect(model.columns.map((c) => c.label)).toEqual(['연차', '종류', '품명', '수량', '금액', '증빙 받음 n/m', '증빙 내역']);
    expect(model.rows.map((r) => r.kind)).toEqual(['data', 'data', 'data', 'subtotal', 'data', 'subtotal', 'total']);
    expect(model.rows[3]!.cells[4]).toEqual({
      kind: 'sum',
      value: 40_000_000,
      terms: [{ row: 0, col: 4 }, { row: 1, col: 4 }, { row: 2, col: 4 }],
    });
    expect(model.rows[6]!.cells[4]).toEqual({ kind: 'sum', value: 52_000_000, terms: [{ row: 3, col: 4 }, { row: 5, col: 4 }] });
  });

  it('TSV — 원 단위 정수, 증빙 칸 글자, 원시 코드 없음', () => {
    const tsv = toTsv(model);
    expect(tsv.split('\r\n')).toEqual([
      '연차\t종류\t품명\t수량\t금액\t증빙 받음 n/m\t증빙 내역',
      '1차년도\t장비\t가속도계\t1.5\t2000000\t받음 0/0\t',
      '1차년도\t장비\t현미경\t\t33000000\t받음 1/1\t견적서: 받음 · 2개사',
      '1차년도\t재료\t시약\t10\t5000000\t받음 0/6\t견적서: 안 받음; 비교견적서: 안 받음; 구매요청서: 안 받음; 거래명세서: 안 받음; 검수조서: 안 받음; 세금계산서: 안 받음',
      '소계\t1차년도\t\t\t40000000\t\t',
      '2차년도\t외주용역\t시험 분석\t\t12000000\t받음 0/0\t',
      '소계\t2차년도\t\t\t12000000\t\t',
      '합계\t\t\t\t52000000\t\t',
    ]);
    expect(tsv).not.toMatch(/equipment|material|outsourcing|facility_purchase/);
  });

  it('엑셀 시트 — 소계 SUM 수식 + 결과값, 시트 이름 그대로 쓸 수 있다', () => {
    const sheet = toFormSheet(model, ITEMS_SHEET_NAME);
    expect(sheet.name).toBe('편성 항목·증빙');
    expect(sheet.rows[4]![4]).toEqual({ formula: 'SUM(E2:E4)', result: 40_000_000 });
    expect(sheet.rows[7]![4]).toEqual({ formula: 'SUM(E5,E7)', result: 52_000_000 });
  });

  it('금액 줄만 있는 연차는 소계 행을 만들지 않고, 0건이면 합계 0만', () => {
    const onlyLines = buildItemsView({ items: [], lines: LINES, years: YEARS, findings: [] });
    const t = itemsTable(onlyLines, '빈 표');
    expect(t.rows).toEqual([
      { kind: 'total', cells: [{ kind: 'text', text: '합계' }, ...Array(3).fill({ kind: 'text', text: '' }), { kind: 'amount', value: 0 }, { kind: 'text', text: '' }, { kind: 'text', text: '' }] },
    ]);
    expect(() => assertTableModel(t)).not.toThrow();
  });
});
