// 변경 이력 보기의 표 모델 3종 — 금액 증감 · 참여인원 증감 · 세목 총액 보존 (SOT §6.19 AG-7·AG-8, 계획서 S-11·S-12).
//
// 화면·엑셀·[복사]가 같은 모델을 쓴다(AG-8). 증감 칸은 `=B−A` 수식이 되도록 `sum`(B 항 + A 항 negate)으로 싣는다
// — 엑셀에서 사용자가 이전·이후 금액을 고치면 증감도 따라 바뀌어야 표가 스스로 모순되지 않는다.
// 참여율·개월은 금액이 아니므로 text다(amount는 원 단위 정수만).

import {
  AGREEMENT_VERSION_STATUS_LABELS,
  BUDGET_CATEGORY_LABELS,
  DETAIL_AXIS_LABELS,
  agreementSubcategoryLabel,
} from '@/lib/constants';
import type { AgreementChangeStatus, LineDiff, ParticipantDiff, ParticipationTerm } from '@/lib/agreement/diff';
import type { PreservationResult } from '@/lib/agreement/preservation';
import type { TableCell, TableCellRef, TableColumn, TableModel, TableRow } from '@/lib/agreement/table';
import type { AgreementVersion, BudgetCategory, Member, Year } from '@/types';

// 부록 A.4에 없는 화면 문구라 여기 둔다 — 보기 컴포넌트(T9b)도 이것을 쓴다
export const AGREEMENT_CHANGE_STATUS_LABELS: Record<AgreementChangeStatus, string> = {
  added: '추가',
  removed: '삭제',
  changed: '변경',
  unchanged: '불변',
};

export const UNASSIGNED_MEMBER_LABEL = '인력 미지정';

export const PRESERVATION_NO_BASE_TEXT = '기준 버전 없음 — 앞선 확정 버전이 없어 세목 총액을 비교하지 않았습니다';

export type ChangesTableYear = Pick<Year, 'id' | 'name'>;
export type ChangesTableVersion = Pick<AgreementVersion, 'name' | 'status'>;

// ─── 칸 헬퍼 ──────────────────────────────────────────────────────────────────

const text = (value: string): TableCell => ({ kind: 'text', text: value });
const amountOrEmpty = (value: number | null): TableCell => (value === null ? { kind: 'empty' } : { kind: 'amount', value });
const sum = (value: number, terms: TableCellRef[]): TableCell => ({ kind: 'sum', value, terms });
/** `=B−A` — 같은 행의 `toCol` − `fromCol` */
const minus = (value: number, row: number, toCol: number, fromCol: number): TableCell =>
  sum(value, [{ row, col: toCol }, { row, col: fromCol, negate: true }]);
const columnRefs = (rows: readonly number[], col: number): TableCellRef[] => rows.map((row) => ({ row, col }));

function versionLabel(version: ChangesTableVersion): string {
  // 작성 중 버전은 숫자가 아직 바뀔 수 있다 — 표만 떼어 봐도 알 수 있게
  return version.status === 'draft' ? `${version.name}(${AGREEMENT_VERSION_STATUS_LABELS.draft})` : version.name;
}

function yearNamer(years: readonly ChangesTableYear[]): (yearId: string) => string {
  const names = new Map(years.map((y) => [y.id, y.name]));
  return (yearId) => {
    const name = names.get(yearId);
    if (name === undefined) throw new Error(`과제에 없는 연차(${yearId})가 변경 이력에 있습니다.`);
    return name;
  };
}

function subcategoryText(category: BudgetCategory, code: string): string {
  const label = agreementSubcategoryLabel(category, code);
  // 원시 코드를 표에 내보내지 않는다 — A.5 밖 코드는 액션 검증을 지나온 손상 데이터다
  if (label === null) throw new Error(`${BUDGET_CATEGORY_LABELS[category]}에 없는 세목 코드입니다: ${code}`);
  return label;
}

// ─── ① 금액 증감 ──────────────────────────────────────────────────────────────

const LINE_COL = { from: 5, to: 6, delta: 7 } as const;

/**
 * 열: 연차 · 비목 · 세목 · 구분 · 상태 · 이전 · 이후 · 증감. 연차마다 소계, 끝에 총계.
 * 줄이 없는 쪽은 빈 칸(금액 0과 구별), 줄이 하나도 없으면(빈 버전끼리) 행 없이 헤더만이다.
 */
export function buildLineChangesTable(
  diff: LineDiff,
  ctx: { years: readonly ChangesTableYear[]; from: ChangesTableVersion; to: ChangesTableVersion }
): TableModel {
  const yearName = yearNamer(ctx.years);
  const columns: TableColumn[] = [
    { label: '연차', type: 'text', key: true, width: 10 },
    { label: '비목', type: 'text', key: true, width: 16 },
    { label: '세목', type: 'text', key: true, width: 24 },
    { label: '구분', type: 'text', key: true, width: 8 },
    { label: '상태', type: 'text', width: 8 },
    { label: `이전 ${versionLabel(ctx.from)}`, type: 'amount', width: 16 },
    { label: `이후 ${versionLabel(ctx.to)}`, type: 'amount', width: 16 },
    { label: '증감', type: 'amount', width: 16 },
  ];

  const rows: TableRow[] = [];
  const subtotalRows: number[] = [];
  for (const yt of diff.yearTotals) {
    const dataRows: number[] = [];
    for (const c of diff.changes) {
      if (c.yearId !== yt.yearId) continue;
      const r = rows.length;
      dataRows.push(r);
      rows.push({
        kind: 'data',
        cells: [
          text(yearName(c.yearId)),
          text(BUDGET_CATEGORY_LABELS[c.category]),
          text(subcategoryText(c.category, c.subcategoryCode)),
          text(DETAIL_AXIS_LABELS[c.axis]),
          text(AGREEMENT_CHANGE_STATUS_LABELS[c.status]),
          amountOrEmpty(c.fromAmount),
          amountOrEmpty(c.toAmount),
          minus(c.delta, r, LINE_COL.to, LINE_COL.from),
        ],
      });
    }
    const r = rows.length;
    subtotalRows.push(r);
    rows.push({
      kind: 'subtotal',
      cells: [
        text(yearName(yt.yearId)),
        text('소계'),
        text(''),
        text(''),
        text(''),
        sum(yt.fromTotal, columnRefs(dataRows, LINE_COL.from)),
        sum(yt.toTotal, columnRefs(dataRows, LINE_COL.to)),
        minus(yt.delta, r, LINE_COL.to, LINE_COL.from),
      ],
    });
  }
  if (subtotalRows.length > 0) {
    const r = rows.length;
    rows.push({
      kind: 'total',
      cells: [
        text('총계'),
        text(''),
        text(''),
        text(''),
        text(''),
        sum(diff.fromTotal, columnRefs(subtotalRows, LINE_COL.from)),
        sum(diff.toTotal, columnRefs(subtotalRows, LINE_COL.to)),
        minus(diff.netDelta, r, LINE_COL.to, LINE_COL.from),
      ],
    });
  }

  return { title: `금액 증감 — ${ctx.from.name} → ${ctx.to.name}`, columns, rows };
}

// ─── ② 참여인원 증감 ──────────────────────────────────────────────────────────

const PART_COL = { fromCash: 5, toCash: 6, cashDelta: 7, fromInKind: 8, toInKind: 9, inKindDelta: 10 } as const;

/** `50% × 12개월` — 한 그룹에 행이 여럿(인력 미지정 등)이면 `, `로 잇는다. 비금액 숫자라 text다 */
export function participationTermsText(terms: readonly ParticipationTerm[]): string {
  return terms.map((t) => `${t.participationRate}% × ${t.months}개월`).join(', ');
}

/**
 * 열: 연차 · 인력 · 상태 · 이전 참여 · 이후 참여 · 이전 현금 · 이후 현금 · 현금 증감 · 이전 현물 · 이후 현물 · 현물 증감.
 * 연차 순서 → 인력 이름 순서(인력 미지정은 맨 뒤). 행이 있으면 끝에 총계.
 */
export function buildParticipantChangesTable(
  diff: ParticipantDiff,
  ctx: {
    years: readonly (ChangesTableYear & Pick<Year, 'order'>)[];
    members: readonly Pick<Member, 'id' | 'name'>[];
    from: ChangesTableVersion;
    to: ChangesTableVersion;
  }
): TableModel {
  const yearName = yearNamer(ctx.years);
  const yearOrder = new Map(ctx.years.map((y) => [y.id, y.order]));
  const memberNames = new Map(ctx.members.map((m) => [m.id, m.name]));
  const memberName = (memberId: string | null): string => {
    if (memberId === null) return UNASSIGNED_MEMBER_LABEL;
    const name = memberNames.get(memberId);
    // 협약 버전이 쓰는 인력은 지울 수 없다(H-9b) — 못 찾으면 데이터가 어긋난 것이다
    if (name === undefined) throw new Error(`참여인원이 과제에 없는 인력(${memberId})을 가리킵니다.`);
    return name;
  };

  const columns: TableColumn[] = [
    { label: '연차', type: 'text', key: true, width: 10 },
    { label: '인력', type: 'text', key: true, width: 14 },
    { label: '상태', type: 'text', width: 8 },
    { label: '이전 참여율·개월', type: 'text', width: 20 },
    { label: '이후 참여율·개월', type: 'text', width: 20 },
    { label: `이전 현금 ${versionLabel(ctx.from)}`, type: 'amount', width: 16 },
    { label: `이후 현금 ${versionLabel(ctx.to)}`, type: 'amount', width: 16 },
    { label: '현금 증감', type: 'amount', width: 14 },
    { label: `이전 현물 ${versionLabel(ctx.from)}`, type: 'amount', width: 16 },
    { label: `이후 현물 ${versionLabel(ctx.to)}`, type: 'amount', width: 16 },
    { label: '현물 증감', type: 'amount', width: 14 },
  ];

  const ordered = [...diff.changes].sort((x, y) => {
    const byYear = (yearOrder.get(x.yearId) ?? 0) - (yearOrder.get(y.yearId) ?? 0);
    if (byYear !== 0) return byYear;
    if (x.memberId === null || y.memberId === null) return x.memberId === y.memberId ? 0 : x.memberId === null ? 1 : -1;
    return memberName(x.memberId).localeCompare(memberName(y.memberId), 'ko') || x.memberId.localeCompare(y.memberId);
  });

  const rows: TableRow[] = [];
  let fromCash = 0;
  let toCash = 0;
  let fromInKind = 0;
  let toInKind = 0;
  for (const c of ordered) {
    const r = rows.length;
    fromCash += c.from?.personnelCash ?? 0;
    toCash += c.to?.personnelCash ?? 0;
    fromInKind += c.from?.personnelInKind ?? 0;
    toInKind += c.to?.personnelInKind ?? 0;
    rows.push({
      kind: 'data',
      cells: [
        text(yearName(c.yearId)),
        text(memberName(c.memberId)),
        text(AGREEMENT_CHANGE_STATUS_LABELS[c.status]),
        text(c.from === null ? '' : participationTermsText(c.from.terms)),
        text(c.to === null ? '' : participationTermsText(c.to.terms)),
        amountOrEmpty(c.from?.personnelCash ?? null),
        amountOrEmpty(c.to?.personnelCash ?? null),
        minus(c.cashDelta, r, PART_COL.toCash, PART_COL.fromCash),
        amountOrEmpty(c.from?.personnelInKind ?? null),
        amountOrEmpty(c.to?.personnelInKind ?? null),
        minus(c.inKindDelta, r, PART_COL.toInKind, PART_COL.fromInKind),
      ],
    });
  }
  if (rows.length > 0) {
    const dataRows = rows.map((_, i) => i);
    const r = rows.length;
    rows.push({
      kind: 'total',
      cells: [
        text('총계'),
        text(''),
        text(''),
        text(''),
        text(''),
        sum(fromCash, columnRefs(dataRows, PART_COL.fromCash)),
        sum(toCash, columnRefs(dataRows, PART_COL.toCash)),
        minus(toCash - fromCash, r, PART_COL.toCash, PART_COL.fromCash),
        sum(fromInKind, columnRefs(dataRows, PART_COL.fromInKind)),
        sum(toInKind, columnRefs(dataRows, PART_COL.toInKind)),
        minus(toInKind - fromInKind, r, PART_COL.toInKind, PART_COL.fromInKind),
      ],
    });
  }

  return { title: `참여인원 증감 — ${ctx.from.name} → ${ctx.to.name}`, columns, rows };
}

// ─── ③ 세목 총액 보존 (RL-23) ─────────────────────────────────────────────────

const PRES_COL = { base: 4, target: 5, delta: 6 } as const;

export const PRESERVATION_JUDGEMENT_LABELS = { preserved: '보존', differs: '차이' } as const;

/**
 * 열: 비목 · 세목 · 구분 · 판정 · 기준 · 대상 · 차액(대상 − 기준). 키 전부를 싣고 판정 칸이 보존/차이를 가른다.
 * 기준 버전이 없으면 안내 한 줄만 — 경고 0건(모든 행 "보존")과 다르게 보인다(절대 규칙 5).
 * `base`는 `result`가 `checked`일 때 기준 버전(AV-5 — 비교 기준 A와 별개)이다.
 */
export function buildPreservationTable(
  result: PreservationResult,
  ctx: { target: ChangesTableVersion; base: ChangesTableVersion | null }
): TableModel {
  const baseLabel = ctx.base === null ? '기준' : `기준 ${versionLabel(ctx.base)}`;
  const columns: TableColumn[] = [
    { label: '비목', type: 'text', key: true, width: 16 },
    { label: '세목', type: 'text', key: true, width: 24 },
    { label: '구분', type: 'text', key: true, width: 8 },
    { label: '판정', type: 'text', width: 8 },
    { label: baseLabel, type: 'amount', width: 16 },
    { label: `대상 ${versionLabel(ctx.target)}`, type: 'amount', width: 16 },
    { label: '차액', type: 'amount', width: 14 },
  ];

  if (result.status === 'no-base') {
    if (ctx.base !== null) throw new Error('세목 총액 보존: 기준 버전 없음 결과에 기준 버전이 주어졌습니다.');
    return {
      title: `세목 총액 보존 — ${ctx.target.name} (기준 버전 없음)`,
      columns,
      rows: [
        {
          kind: 'data',
          cells: [text(PRESERVATION_NO_BASE_TEXT), text(''), text(''), text(''), { kind: 'empty' }, { kind: 'empty' }, { kind: 'empty' }],
        },
      ],
    };
  }
  if (ctx.base === null) throw new Error('세목 총액 보존: 비교한 결과에 기준 버전 이름이 없습니다.');

  const rows: TableRow[] = result.entries.map((e, r) => ({
    kind: 'data',
    cells: [
      text(BUDGET_CATEGORY_LABELS[e.category]),
      text(subcategoryText(e.category, e.subcategoryCode)),
      text(DETAIL_AXIS_LABELS[e.axis]),
      text(e.preserved ? PRESERVATION_JUDGEMENT_LABELS.preserved : PRESERVATION_JUDGEMENT_LABELS.differs),
      { kind: 'amount', value: e.baseTotal },
      { kind: 'amount', value: e.total },
      minus(e.delta, r, PRES_COL.target, PRES_COL.base),
    ],
  }));
  if (rows.length > 0) {
    const dataRows = rows.map((_, i) => i);
    const baseTotal = result.entries.reduce((acc, e) => acc + e.baseTotal, 0);
    const total = result.entries.reduce((acc, e) => acc + e.total, 0);
    const r = rows.length;
    rows.push({
      kind: 'total',
      cells: [
        text('총계'),
        text(''),
        text(''),
        text(`차이 ${result.warnings.length}건`),
        sum(baseTotal, columnRefs(dataRows, PRES_COL.base)),
        sum(total, columnRefs(dataRows, PRES_COL.target)),
        minus(total - baseTotal, r, PRES_COL.target, PRES_COL.base),
      ],
    });
  }

  return { title: `세목 총액 보존 — ${ctx.target.name} 대 기준 ${ctx.base.name}`, columns, rows };
}
