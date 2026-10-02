// 협약 예산 증감·세목 총액 보존·변경 이력 표 (SOT §6.19 AG-7·AG-8, §6.14.8 RL-23, 계획서 S-12·S-20).
// 기대값은 계획서 S-20 합성 픽스처 그대로다 — 숫자가 안 맞으면 구현이 틀린 것이다.

import { describe, expect, it } from 'vitest';
import { diffAgreementLines, diffAgreementParticipants } from '@/lib/agreement/diff';
import type { DiffLine, DiffParticipant } from '@/lib/agreement/diff';
import { checkSubcategoryPreservation } from '@/lib/agreement/preservation';
import {
  PRESERVATION_NO_BASE_TEXT,
  buildLineChangesTable,
  buildParticipantChangesTable,
  buildPreservationTable,
  participationTermsText,
} from '@/lib/agreement/changes-table';
import { assertTableModel, toTsv } from '@/lib/agreement/table';
import type { BudgetCategory, DetailAxis } from '@/types';

// ─── S-20 픽스처 ──────────────────────────────────────────────────────────────

const YEARS = [
  { id: 'y1', order: 0, name: '1차년도' },
  { id: 'y2', order: 1, name: '2차년도' },
];

const line = (yearId: string, category: BudgetCategory, subcategoryCode: string, axis: DetailAxis, amount: number): DiffLine => ({
  yearId,
  category,
  subcategoryCode,
  axis,
  amount,
});

const A_LINES: DiffLine[] = [
  line('y1', 'personnel', 'personnel_internal', 'cash', 30_000_000),
  line('y1', 'personnel', 'personnel_internal', 'in_kind', 10_000_000),
  line('y1', 'material', 'material_purchase', 'cash', 5_000_000),
  line('y1', 'activity', 'activity_meeting', 'cash', 1_200_000),
  line('y1', 'activity', 'activity_travel_dom', 'cash', 800_000),
  line('y1', 'allowance', 'default', 'cash', 3_000_000),
  line('y1', 'indirect', 'indirect_hr', 'cash', 2_500_000),
  line('y2', 'personnel', 'personnel_internal', 'cash', 32_000_000),
  line('y2', 'personnel', 'personnel_internal', 'in_kind', 10_000_000),
  line('y2', 'material', 'material_purchase', 'cash', 4_000_000),
  line('y2', 'activity', 'activity_meeting', 'cash', 1_000_000),
  line('y2', 'allowance', 'default', 'cash', 3_000_000),
  line('y2', 'indirect', 'indirect_hr', 'cash', 2_700_000),
];

/** A 복제 후 S-20 변경 5건 */
const B_LINES: DiffLine[] = A_LINES.flatMap((l): DiffLine[] => {
  if (l.yearId === 'y1' && l.subcategoryCode === 'material_purchase') return [{ ...l, amount: 3_000_000 }];
  if (l.yearId === 'y2' && l.subcategoryCode === 'material_purchase') return [{ ...l, amount: 6_000_000 }];
  if (l.yearId === 'y1' && l.subcategoryCode === 'activity_travel_dom') return [];
  if (l.yearId === 'y2' && l.subcategoryCode === 'indirect_hr') return [{ ...l, amount: 2_900_000 }];
  return [l];
}).concat([line('y2', 'activity', 'activity_travel_intl', 'cash', 500_000)]);

const participant = (
  memberId: string | null,
  yearId: string,
  participationRate: number,
  months: number,
  personnelCash: number,
  personnelInKind: number
): DiffParticipant => ({ memberId, yearId, participationRate, months, personnelCash, personnelInKind });

const A_PARTS: DiffParticipant[] = [
  participant('m1', 'y1', 50, 12, 30_000_000, 0),
  participant('m1', 'y2', 50, 12, 32_000_000, 0),
  participant('m2', 'y1', 20, 12, 0, 10_000_000),
  participant('m2', 'y2', 20, 12, 0, 10_000_000),
];

const B_PARTS: DiffParticipant[] = [
  participant('m1', 'y1', 50, 12, 30_000_000, 0),
  participant('m1', 'y2', 50, 12, 32_000_000, 0),
  participant('m2', 'y1', 20, 12, 0, 10_000_000),
  participant('m2', 'y2', 25, 12, 0, 12_500_000),
  participant(null, 'y2', 30, 6, 5_000_000, 0),
];

const MEMBERS = [
  { id: 'm1', name: '김연구' },
  { id: 'm2', name: '박참여' },
];

const VERSION_A = { name: '최종협약본', status: 'confirmed' as const };
const VERSION_B = { name: '협약변경 1차', status: 'draft' as const };

const tsvRows = (tsv: string): string[][] => tsv.split('\r\n').map((r) => r.split('\t'));

// ─── 금액 줄 증감 ─────────────────────────────────────────────────────────────

describe('diffAgreementLines (AG-7 ①)', () => {
  it('S-20 A→B: changed 3 · removed 1 · added 1 · unchanged 9, 순증감 −100,000, B 총계 105,100,000', () => {
    const diff = diffAgreementLines(A_LINES, B_LINES, YEARS);
    expect(diff.counts).toEqual({ changed: 3, removed: 1, added: 1, unchanged: 9 });
    expect(diff.netDelta).toBe(-100_000);
    expect(diff.fromTotal).toBe(105_200_000);
    expect(diff.toTotal).toBe(105_100_000);
    expect(diff.yearTotals).toEqual([
      { yearId: 'y1', fromTotal: 52_500_000, toTotal: 49_700_000, delta: -2_800_000 },
      { yearId: 'y2', fromTotal: 52_700_000, toTotal: 55_400_000, delta: 2_700_000 },
    ]);
  });

  it('S-20 각 분기의 금액·차액', () => {
    const diff = diffAgreementLines(A_LINES, B_LINES, YEARS);
    const pick = (yearId: string, code: string) => diff.changes.find((c) => c.yearId === yearId && c.subcategoryCode === code);
    expect(pick('y1', 'material_purchase')).toMatchObject({ status: 'changed', fromAmount: 5_000_000, toAmount: 3_000_000, delta: -2_000_000 });
    expect(pick('y2', 'material_purchase')).toMatchObject({ status: 'changed', fromAmount: 4_000_000, toAmount: 6_000_000, delta: 2_000_000 });
    expect(pick('y1', 'activity_travel_dom')).toMatchObject({ status: 'removed', fromAmount: 800_000, toAmount: null, delta: -800_000 });
    expect(pick('y2', 'activity_travel_intl')).toMatchObject({ status: 'added', fromAmount: null, toAmount: 500_000, delta: 500_000 });
    expect(pick('y2', 'indirect_hr')).toMatchObject({ status: 'changed', delta: 200_000 });
    expect(pick('y1', 'personnel_internal')).toMatchObject({ status: 'unchanged', delta: 0 });
  });

  it('정렬: 연차 → 부록 A.1 비목 → A.5 세목 → 현금·현물', () => {
    const diff = diffAgreementLines(A_LINES, B_LINES, YEARS);
    expect(diff.changes.filter((c) => c.yearId === 'y2').map((c) => `${c.subcategoryCode}/${c.axis}`)).toEqual([
      'personnel_internal/cash',
      'personnel_internal/in_kind',
      'material_purchase/cash',
      'activity_meeting/cash',
      'activity_travel_intl/cash',
      'default/cash',
      'indirect_hr/cash',
    ]);
    // 입력 순서와 무관하다
    expect(diffAgreementLines([...A_LINES].reverse(), [...B_LINES].reverse(), [...YEARS].reverse()).changes).toEqual(diff.changes);
  });

  it('세목이 여럿인 비목의 default("세목 미지정")는 그 비목 맨 뒤', () => {
    const diff = diffAgreementLines(
      [],
      [line('y1', 'activity', 'default', 'cash', 1), line('y1', 'activity', 'activity_etc', 'cash', 1), line('y1', 'activity', 'activity_outsourcing', 'cash', 1)],
      YEARS
    );
    expect(diff.changes.map((c) => c.subcategoryCode)).toEqual(['activity_outsourcing', 'activity_etc', 'default']);
  });

  it('자기 자신과 비교 — 전부 unchanged, 증감 0', () => {
    const diff = diffAgreementLines(A_LINES, A_LINES, YEARS);
    expect(diff.counts).toEqual({ added: 0, removed: 0, changed: 0, unchanged: 13 });
    expect(diff.netDelta).toBe(0);
    expect(diff.changes.every((c) => c.delta === 0)).toBe(true);
  });

  it('빈 버전과 비교 — 빈 → A는 전부 added, A → 빈은 전부 removed', () => {
    const up = diffAgreementLines([], A_LINES, YEARS);
    expect(up.counts).toEqual({ added: 13, removed: 0, changed: 0, unchanged: 0 });
    expect(up.netDelta).toBe(105_200_000);
    expect(up.changes.every((c) => c.fromAmount === null)).toBe(true);
    const down = diffAgreementLines(A_LINES, [], YEARS);
    expect(down.counts).toEqual({ added: 0, removed: 13, changed: 0, unchanged: 0 });
    expect(down.toTotal).toBe(0);
    expect(down.netDelta).toBe(-105_200_000);
  });

  it('빈 버전끼리 — 변경 없음, 연차 합계도 없음', () => {
    const diff = diffAgreementLines([], [], YEARS);
    expect(diff.changes).toEqual([]);
    expect(diff.yearTotals).toEqual([]);
    expect(diff.netDelta).toBe(0);
  });

  it('연차 간 이동(한 연차 감소 + 다른 연차 증가) — 두 줄 changed, 순증감 0', () => {
    const from = [line('y1', 'material', 'material_purchase', 'cash', 5_000_000), line('y2', 'material', 'material_purchase', 'cash', 4_000_000)];
    const to = [line('y1', 'material', 'material_purchase', 'cash', 3_000_000), line('y2', 'material', 'material_purchase', 'cash', 6_000_000)];
    const diff = diffAgreementLines(from, to, YEARS);
    expect(diff.counts).toEqual({ added: 0, removed: 0, changed: 2, unchanged: 0 });
    expect(diff.changes.map((c) => c.delta)).toEqual([-2_000_000, 2_000_000]);
    expect(diff.netDelta).toBe(0);
  });

  it('금액 0인 줄은 줄 없음과 다르다 — 0 → 줄 삭제는 removed', () => {
    const diff = diffAgreementLines([line('y1', 'other', 'default', 'cash', 0)], [], YEARS);
    expect(diff.changes[0]).toMatchObject({ status: 'removed', fromAmount: 0, toAmount: null, delta: 0 });
  });

  it('축이 다르면 다른 키다', () => {
    const diff = diffAgreementLines(
      [line('y1', 'personnel', 'personnel_internal', 'cash', 100)],
      [line('y1', 'personnel', 'personnel_internal', 'in_kind', 100)],
      YEARS
    );
    expect(diff.changes.map((c) => `${c.axis}:${c.status}`)).toEqual(['cash:removed', 'in_kind:added']);
  });

  it('손상 데이터는 던진다 — 중복 키·모르는 연차·A.5 밖 세목·정수 아닌 금액', () => {
    const dup = line('y1', 'other', 'default', 'cash', 1);
    expect(() => diffAgreementLines([dup, dup], [], YEARS)).toThrow(/두 번/);
    expect(() => diffAgreementLines([], [line('y9', 'other', 'default', 'cash', 1)], YEARS)).toThrow(/연차/);
    expect(() => diffAgreementLines([], [line('y1', 'other', 'bogus', 'cash', 1)], YEARS)).toThrow(/세목/);
    expect(() => diffAgreementLines([], [line('y1', 'other', 'default', 'cash', 1.5)], YEARS)).toThrow(/정수/);
    expect(() => diffAgreementLines([], [line('y1', 'other', 'default', 'cash', -1)], YEARS)).toThrow(/정수/);
  });
});

// ─── 참여인원 증감 ────────────────────────────────────────────────────────────

describe('diffAgreementParticipants (AG-7 ②)', () => {
  it('S-20 A→B: changed 1 · added 1 · unchanged 3', () => {
    const diff = diffAgreementParticipants(A_PARTS, B_PARTS, YEARS);
    expect(diff.counts).toEqual({ changed: 1, added: 1, unchanged: 3, removed: 0 });
    expect(diff.changes.find((c) => c.memberId === 'm2' && c.yearId === 'y2')).toMatchObject({
      status: 'changed',
      cashDelta: 0,
      inKindDelta: 2_500_000,
      from: { rowCount: 1, personnelInKind: 10_000_000, terms: [{ participationRate: 20, months: 12 }] },
      to: { rowCount: 1, personnelInKind: 12_500_000, terms: [{ participationRate: 25, months: 12 }] },
    });
    expect(diff.changes.find((c) => c.memberId === null)).toMatchObject({
      yearId: 'y2',
      status: 'added',
      from: null,
      cashDelta: 5_000_000,
      to: { terms: [{ participationRate: 30, months: 6 }] },
    });
  });

  it('정렬: 연차 → 인력, 인력 미지정은 그 연차 맨 뒤', () => {
    const diff = diffAgreementParticipants(A_PARTS, B_PARTS, YEARS);
    expect(diff.changes.map((c) => `${c.yearId}:${c.memberId ?? '-'}`)).toEqual(['y1:m1', 'y1:m2', 'y2:m1', 'y2:m2', 'y2:-']);
  });

  it('인력 미지정은 연차마다 한 그룹 — 행 여럿을 합쳐 비교한다', () => {
    const from = [participant(null, 'y1', 30, 6, 1_000, 0), participant(null, 'y1', 10, 12, 2_000, 0), participant(null, 'y2', 10, 12, 500, 0)];
    // 순서만 바꾼 같은 다중집합 → unchanged
    const same = [participant(null, 'y1', 10, 12, 2_000, 0), participant(null, 'y1', 30, 6, 1_000, 0), participant(null, 'y2', 10, 12, 500, 0)];
    const d1 = diffAgreementParticipants(from, same, YEARS);
    expect(d1.changes).toHaveLength(2);
    expect(d1.counts.unchanged).toBe(2);
    expect(d1.changes[0]).toMatchObject({ memberId: null, yearId: 'y1', from: { rowCount: 2, personnelCash: 3_000 } });

    // 합계는 같고 (참여율, 개월) 다중집합만 다름 → changed
    const swapped = [participant(null, 'y1', 30, 12, 1_000, 0), participant(null, 'y1', 10, 6, 2_000, 0), participant(null, 'y2', 10, 12, 500, 0)];
    const d2 = diffAgreementParticipants(from, swapped, YEARS);
    expect(d2.changes[0]).toMatchObject({ status: 'changed', cashDelta: 0, inKindDelta: 0 });
  });

  it('현금만 다르면 changed, 현물만 다르면 changed', () => {
    const base = [participant('m1', 'y1', 50, 12, 100, 100)];
    expect(diffAgreementParticipants(base, [participant('m1', 'y1', 50, 12, 101, 100)], YEARS).counts.changed).toBe(1);
    expect(diffAgreementParticipants(base, [participant('m1', 'y1', 50, 12, 100, 99)], YEARS).counts.changed).toBe(1);
  });

  it('삭제·빈 버전·자기 자신', () => {
    expect(diffAgreementParticipants(A_PARTS, [], YEARS).counts).toEqual({ added: 0, removed: 4, changed: 0, unchanged: 0 });
    expect(diffAgreementParticipants([], A_PARTS, YEARS).counts).toEqual({ added: 4, removed: 0, changed: 0, unchanged: 0 });
    expect(diffAgreementParticipants(B_PARTS, B_PARTS, YEARS).counts).toEqual({ added: 0, removed: 0, changed: 0, unchanged: 5 });
    expect(diffAgreementParticipants([], [], YEARS).changes).toEqual([]);
  });

  it('손상 데이터는 던진다 — 모르는 연차·정수 아닌 금액', () => {
    expect(() => diffAgreementParticipants([participant('m1', 'y9', 1, 1, 0, 0)], [], YEARS)).toThrow(/연차/);
    expect(() => diffAgreementParticipants([participant('m1', 'y1', 1, 1, 0.5, 0)], [], YEARS)).toThrow(/정수/);
  });
});

// ─── RL-23 세목 총액 보존 ─────────────────────────────────────────────────────

describe('checkSubcategoryPreservation (RL-23)', () => {
  it('S-20 B 대 A: 경고 3건 — travel_dom −800,000 · travel_intl +500,000 · indirect_hr +200,000, material_purchase 보존', () => {
    const result = checkSubcategoryPreservation(B_LINES, { versionId: 'vA', lines: A_LINES });
    if (result.status !== 'checked') throw new Error('기준이 있으므로 checked여야 한다');
    expect(result.baseVersionId).toBe('vA');
    expect(result.warnings.map((w) => [w.subcategoryCode, w.axis, w.baseTotal, w.total, w.delta])).toEqual([
      ['activity_travel_dom', 'cash', 800_000, 0, -800_000],
      ['activity_travel_intl', 'cash', 0, 500_000, 500_000],
      ['indirect_hr', 'cash', 5_200_000, 5_400_000, 200_000],
    ]);
    expect(result.entries.find((e) => e.subcategoryCode === 'material_purchase')).toMatchObject({
      baseTotal: 9_000_000,
      total: 9_000_000,
      delta: 0,
      preserved: true,
    });
    expect(result.entries).toHaveLength(8);
  });

  it('기준 버전 없음은 경고 0건(빈 배열)과 구별되는 값이다', () => {
    const noBase = checkSubcategoryPreservation(B_LINES, null);
    expect(noBase).toEqual({ status: 'no-base' });
    expect('warnings' in noBase).toBe(false);

    const clean = checkSubcategoryPreservation(A_LINES, { versionId: 'vA', lines: A_LINES });
    expect(clean.status).toBe('checked');
    if (clean.status === 'checked') expect(clean.warnings).toEqual([]);
    expect(clean).not.toEqual(noBase);
  });

  it('연차 간 이동만 하면 보존 — 축은 따로 본다', () => {
    const result = checkSubcategoryPreservation(
      [line('y1', 'material', 'material_purchase', 'cash', 3), line('y2', 'material', 'material_purchase', 'cash', 6), line('y1', 'material', 'material_purchase', 'in_kind', 1)],
      { versionId: 'v0', lines: [line('y1', 'material', 'material_purchase', 'cash', 5), line('y2', 'material', 'material_purchase', 'cash', 4)] }
    );
    if (result.status !== 'checked') throw new Error('checked여야 한다');
    expect(result.warnings).toEqual([
      { category: 'material', subcategoryCode: 'material_purchase', axis: 'in_kind', baseTotal: 0, total: 1, delta: 1, preserved: false },
    ]);
  });

  it('A.5 밖 세목은 키 1개여도 던진다', () => {
    expect(() => checkSubcategoryPreservation([line('y1', 'other', 'bogus', 'cash', 1)], { versionId: 'v0', lines: [] })).toThrow(/세목/);
  });

  it('기준이 빈 버전이면 대상의 모든 키가 경고, 둘 다 비면 경고 0건', () => {
    const r1 = checkSubcategoryPreservation(A_LINES, { versionId: 'v0', lines: [] });
    if (r1.status !== 'checked') throw new Error('checked여야 한다');
    expect(r1.warnings).toHaveLength(7);
    const r2 = checkSubcategoryPreservation([], { versionId: 'v0', lines: [] });
    expect(r2).toEqual({ status: 'checked', baseVersionId: 'v0', entries: [], warnings: [] });
  });
});

// ─── 변경 이력 표 3종 ─────────────────────────────────────────────────────────

describe('변경 이력 표 (AG-7·AG-8)', () => {
  it('금액 증감 표 — assertTableModel 통과, 증감 칸은 B−A, 연차 소계·총계', () => {
    const model = buildLineChangesTable(diffAgreementLines(A_LINES, B_LINES, YEARS), {
      years: YEARS,
      from: VERSION_A,
      to: VERSION_B,
    });
    expect(() => assertTableModel(model)).not.toThrow();
    const rows = tsvRows(toTsv(model));
    expect(rows[0]).toEqual(['연차', '비목', '세목', '구분', '상태', '이전 최종협약본', '이후 협약변경 1차(작성 중)', '증감']);
    // 데이터 14 + 소계 2 + 총계 1 + 헤더 1
    expect(rows).toHaveLength(18);
    expect(rows).toContainEqual(['1차년도', '연구재료비', '① 연구재료 구입비', '현금', '변경', '5000000', '3000000', '-2000000']);
    expect(rows).toContainEqual(['1차년도', '연구활동비', '⑤ 국내출장비', '현금', '삭제', '800000', '', '-800000']);
    expect(rows).toContainEqual(['2차년도', '연구활동비', '⑤ 국외출장비', '현금', '추가', '', '500000', '500000']);
    expect(rows).toContainEqual(['1차년도', '연구수당', '연구수당', '현금', '불변', '3000000', '3000000', '0']);
    expect(rows).toContainEqual(['1차년도', '소계', '', '', '', '52500000', '49700000', '-2800000']);
    expect(rows).toContainEqual(['2차년도', '소계', '', '', '', '52700000', '55400000', '2700000']);
    expect(rows[rows.length - 1]).toEqual(['총계', '', '', '', '', '105200000', '105100000', '-100000']);

    // 증감 칸은 같은 행의 이후 − 이전
    const first = model.rows[0]!.cells[7]!;
    expect(first).toEqual({ kind: 'sum', value: 0, terms: [{ row: 0, col: 6 }, { row: 0, col: 5, negate: true }] });
    expect(model.rows.map((r) => r.kind).filter((k) => k !== 'data')).toEqual(['subtotal', 'subtotal', 'total']);
  });

  it('금액 증감 표 — 빈 버전끼리는 헤더만', () => {
    const model = buildLineChangesTable(diffAgreementLines([], [], YEARS), { years: YEARS, from: VERSION_A, to: VERSION_B });
    expect(model.rows).toEqual([]);
    expect(tsvRows(toTsv(model))).toHaveLength(1);
  });

  it('참여인원 증감 표 — 참여율·개월은 글자, 인력 미지정 라벨, 총계', () => {
    const model = buildParticipantChangesTable(diffAgreementParticipants(A_PARTS, B_PARTS, YEARS), {
      years: YEARS,
      members: MEMBERS,
      from: VERSION_A,
      to: VERSION_B,
    });
    expect(() => assertTableModel(model)).not.toThrow();
    const rows = tsvRows(toTsv(model));
    expect(rows).toHaveLength(7);
    expect(rows[1]).toEqual(['1차년도', '김연구', '불변', '50% × 12개월', '50% × 12개월', '30000000', '30000000', '0', '0', '0', '0']);
    expect(rows[4]).toEqual(['2차년도', '박참여', '변경', '20% × 12개월', '25% × 12개월', '0', '0', '0', '10000000', '12500000', '2500000']);
    expect(rows[5]).toEqual(['2차년도', '인력 미지정', '추가', '', '30% × 6개월', '', '5000000', '5000000', '', '0', '0']);
    expect(rows[6]).toEqual(['총계', '', '', '', '', '62000000', '67000000', '5000000', '20000000', '22500000', '2500000']);
    // 참여율은 amount가 아니라 text다
    expect(model.rows[0]!.cells[3]).toEqual({ kind: 'text', text: '50% × 12개월' });
  });

  it('참여인원 표 — 모르는 인력은 던진다(원시 id를 표에 내보내지 않는다)', () => {
    const diff = diffAgreementParticipants([], [participant('m9', 'y1', 10, 12, 1, 0)], YEARS);
    expect(() => buildParticipantChangesTable(diff, { years: YEARS, members: MEMBERS, from: VERSION_A, to: VERSION_B })).toThrow(/인력/);
  });

  it('participationTermsText — 행 여럿은 쉼표로, 소수 참여율 그대로', () => {
    expect(participationTermsText([{ participationRate: 12.5, months: 6 }, { participationRate: 30, months: 12 }])).toBe('12.5% × 6개월, 30% × 12개월');
  });

  it('세목 총액 보존 표 — S-20 경고 3건, 판정 칸으로 보존/차이 구별', () => {
    const result = checkSubcategoryPreservation(B_LINES, { versionId: 'vA', lines: A_LINES });
    const model = buildPreservationTable(result, { target: VERSION_B, base: VERSION_A });
    expect(() => assertTableModel(model)).not.toThrow();
    const rows = tsvRows(toTsv(model));
    expect(rows[0]).toEqual(['비목', '세목', '구분', '판정', '기준 최종협약본', '대상 협약변경 1차(작성 중)', '차액']);
    expect(rows).toHaveLength(10);
    expect(rows).toContainEqual(['연구재료비', '① 연구재료 구입비', '현금', '보존', '9000000', '9000000', '0']);
    expect(rows).toContainEqual(['연구활동비', '⑤ 국내출장비', '현금', '차이', '800000', '0', '-800000']);
    expect(rows).toContainEqual(['연구활동비', '⑤ 국외출장비', '현금', '차이', '0', '500000', '500000']);
    expect(rows).toContainEqual(['간접비', '가. 인력지원비', '현금', '차이', '5200000', '5400000', '200000']);
    expect(rows[rows.length - 1]).toEqual(['총계', '', '', '차이 3건', '105200000', '105100000', '-100000']);
  });

  it('세목 총액 보존 표 — 기준 버전 없음은 안내 한 줄, 경고 0건 표와 다르다', () => {
    const noBase = buildPreservationTable(checkSubcategoryPreservation(B_LINES, null), { target: VERSION_B, base: null });
    expect(() => assertTableModel(noBase)).not.toThrow();
    expect(tsvRows(toTsv(noBase))[1]).toEqual([PRESERVATION_NO_BASE_TEXT, '', '', '', '', '', '']);
    expect(noBase.title).toContain('기준 버전 없음');

    const clean = buildPreservationTable(checkSubcategoryPreservation(A_LINES, { versionId: 'vA', lines: A_LINES }), {
      target: VERSION_A,
      base: VERSION_A,
    });
    const cleanRows = tsvRows(toTsv(clean));
    expect(cleanRows.slice(1, -1).every((r) => r[3] === '보존')).toBe(true);
    expect(cleanRows[cleanRows.length - 1]![3]).toBe('차이 0건');
  });

  it('세목 총액 보존 표 — 결과와 기준 이름이 어긋나면 던진다', () => {
    expect(() => buildPreservationTable({ status: 'no-base' }, { target: VERSION_B, base: VERSION_A })).toThrow();
    expect(() =>
      buildPreservationTable(checkSubcategoryPreservation(B_LINES, { versionId: 'vA', lines: A_LINES }), { target: VERSION_B, base: null })
    ).toThrow();
  });

  it('표에 원시 코드가 나오지 않는다', () => {
    const tsv = [
      toTsv(buildLineChangesTable(diffAgreementLines(A_LINES, B_LINES, YEARS), { years: YEARS, from: VERSION_A, to: VERSION_B })),
      toTsv(buildPreservationTable(checkSubcategoryPreservation(B_LINES, { versionId: 'vA', lines: A_LINES }), { target: VERSION_B, base: VERSION_A })),
      toTsv(
        buildParticipantChangesTable(diffAgreementParticipants(A_PARTS, B_PARTS, YEARS), {
          years: YEARS,
          members: MEMBERS,
          from: VERSION_A,
          to: VERSION_B,
        })
      ),
    ].join('\n');
    expect(tsv).not.toMatch(/personnel_internal|material_purchase|activity_|indirect_hr|\bdefault\b|\bcash\b|in_kind|added|removed|changed|unchanged|draft|\bm1\b|\by1\b/);
  });
});
