// 협약 예산 참여인원 — 계산값·구분 판정·편집 해석·금액 줄 대조·보기 모델 (SOT §5.23, §6.19 AG-5, 계획서 S-9~S-11).
//
// 계산값은 PL-1(`연봉 × 참여율/100 × 개월/12`, 중간 반올림 없음 — PL-2·PL-4)이고 산식은 `lib/budget-plan.ts`의
// `computeDetailAmount` 하나뿐이다(PL-10a — 같은 식이 두 곳에 있으면 언젠가 1원이 어긋난다). 구분(자동·수동·
// 연봉 모름)은 저장하지 않고 읽을 때 판정한다(§5.23 — 파생 값). 대조는 표시만 한다(Q4) — 어느 쪽도 고치지 않는다.
//
// 손상 입력(범위 밖 참여율·개월, 정수가 아닌 금액, 모르는 연차·인력)은 던진다 — DB check·FK가 막았어야 하는
// 상태이고, 조용히 넘기면 틀린 합계가 맞는 것처럼 보인다(절대 규칙 5).
//
// 경계(AG-9): 순수 함수. xlsx·exceljs·supabase·`lib/db`·`actions`를 import하지 않는다.

import { computeDetailAmount } from '@/lib/budget-plan';
import { AGREEMENT_VIEW_TEXT, PARTICIPANT_AMOUNT_KIND_LABELS } from '@/lib/constants';
import type { AgreementLine, AgreementParticipant, BudgetCategory, Member, ParticipantAmountKind, Year } from '@/types';
import type { TableCell, TableCellRef, TableColumn, TableModel, TableRow } from './table';

// ─── 입력 ─────────────────────────────────────────────────────────────────────

/** 편집 가능한 필드 전부 — 행 하나의 "값". 액션·화면이 저장 전후로 주고받는 형태다 */
export type ParticipantFields = Pick<
  AgreementParticipant,
  'memberId' | 'yearId' | 'participationRate' | 'months' | 'annualSalary' | 'personnelCash' | 'personnelInKind' | 'role'
>;

/** 계산값을 내는 데 필요한 필드 */
export type ParticipantCalcInput = Pick<AgreementParticipant, 'participationRate' | 'months' | 'annualSalary'>;

/** 구분 판정에 필요한 필드 */
export type ParticipantAmountInput = ParticipantCalcInput & Pick<AgreementParticipant, 'personnelCash' | 'personnelInKind'>;

/** S-11 역할 길이 상한(§6.19 AG-5). 액션의 Zod 스키마도 이 값을 쓴다 */
export const PARTICIPANT_ROLE_MAX_LENGTH = 100;

// ─── 검증 ─────────────────────────────────────────────────────────────────────

function assertRate(value: number, where: string): void {
  if (!Number.isFinite(value) || value < 0 || value > 100) {
    throw new Error(`${where}: 참여율이 0~100%가 아닙니다 (${value}).`);
  }
}

function assertMonths(value: number, where: string): void {
  if (!Number.isFinite(value) || value < 0 || value > 12) {
    throw new Error(`${where}: 참여 개월이 0~12가 아닙니다 (${value}).`);
  }
}

function assertWon(value: number, label: string, where: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${where}: ${label}이 0 이상의 원 단위 정수가 아닙니다 (${value}).`);
  }
}

function assertSalary(value: number | null, where: string): void {
  if (value !== null) assertWon(value, '연봉 스냅샷', where);
}

function assertCalcInput(p: ParticipantCalcInput, where: string): void {
  assertRate(p.participationRate, where);
  assertMonths(p.months, where);
  assertSalary(p.annualSalary, where);
}

function assertAmountInput(p: ParticipantAmountInput, where: string): void {
  assertCalcInput(p, where);
  assertWon(p.personnelCash, '인건비 현금', where);
  assertWon(p.personnelInKind, '인건비 현물', where);
}

function assertFields(p: ParticipantFields, where: string): void {
  assertAmountInput(p, where);
  if (p.yearId === '') throw new Error(`${where}: 연차가 비어 있습니다.`);
  if (p.memberId === '') throw new Error(`${where}: 인력 id가 빈 문자열입니다 — 미지정은 null입니다.`);
  if (p.role.length > PARTICIPANT_ROLE_MAX_LENGTH) {
    throw new Error(`${where}: 역할이 ${PARTICIPANT_ROLE_MAX_LENGTH}자를 넘습니다 (${p.role.length}자).`);
  }
}

// ─── 계산값·구분 (S-9) ────────────────────────────────────────────────────────

/**
 * 계산값 = PL-1. 연봉 스냅샷이 null이면 **null** — 0으로 계산하지 않는다(AG-5: "연봉 모름"은 계산값이 없다는 뜻이고
 * 0원 인건비와 다르다). 세목 칸(category·subcategory 등)은 PL-1이 읽지 않는 자리라 인건비 기본값을 채운다.
 */
export function computeParticipantAmount(p: ParticipantCalcInput): number | null {
  assertCalcInput(p, '참여인원');
  if (p.annualSalary === null) return null;
  const result = computeDetailAmount(
    {
      yearId: '',
      category: 'personnel',
      subcategory: 'personnel_internal',
      axis: 'cash',
      formula: 'personnel',
      memberId: null,
      unitPrice: 0,
      adjustment: 0,
      factors: [
        { label: '참여율(%)', value: p.participationRate, isPercent: true },
        { label: '참여기간(월)', value: p.months, isPercent: false },
      ],
    },
    { id: 'agreement-participant-snapshot', annualSalary: p.annualSalary }
  );
  // 검증한 입력에서는 나올 수 없다 — 나왔다면 산식 쪽이 바뀐 것이니 숫자를 믿지 않는다
  if (result.missingSalary || result.negative) {
    throw new Error(`참여인원 계산값을 낼 수 없습니다 (연봉 ${p.annualSalary}, 결과 ${result.amount}).`);
  }
  return result.amount;
}

/**
 * 구분(S-9): 연봉 null → 연봉 모름, (현금 = 계산값 & 현물 0) 또는 (현물 = 계산값 & 현금 0) → 자동, 그 밖 수동.
 * 계산값이 0이고 두 금액이 0이면 자동이다(두 조건이 다 맞는다).
 */
export function classifyParticipantAmount(p: ParticipantAmountInput): ParticipantAmountKind {
  assertAmountInput(p, '참여인원');
  const computed = computeParticipantAmount(p);
  if (computed === null) return 'salary_unknown';
  const cashSide = p.personnelCash === computed && p.personnelInKind === 0;
  const inKindSide = p.personnelInKind === computed && p.personnelCash === 0;
  return cashSide || inKindSide ? 'auto' : 'manual';
}

// ─── 편집 해석 (S-11, G-3/Q4b) ────────────────────────────────────────────────

/** `undefined` = 바꾸지 않음. `annualSalary: null`은 "연봉 모름으로 바꾼다"이지 "안 바꾼다"가 아니다 */
export type ParticipantPatch = Partial<ParticipantFields>;

/**
 * 금액이 어떻게 정해졌는지 — 화면·액션이 사용자에게 알릴 때 쓴다.
 * explicit = 사용자가 금액을 적음(수동) · recalculated = 계산값으로 다시 채움 · kept = 직전 금액 유지
 */
export type ParticipantAmountRule = 'explicit' | 'recalculated' | 'kept';

export interface ResolvedParticipant {
  values: ParticipantFields;
  amountRule: ParticipantAmountRule;
  /** 저장 뒤 읽을 때의 구분(S-9) — 같은 판정 함수의 결과다 */
  kind: ParticipantAmountKind;
}

function hasExplicitAmount(patch: Pick<ParticipantPatch, 'personnelCash' | 'personnelInKind'>): boolean {
  return patch.personnelCash !== undefined || patch.personnelInKind !== undefined;
}

function resolved(values: ParticipantFields, amountRule: ParticipantAmountRule): ResolvedParticipant {
  assertFields(values, '참여인원 편집 결과');
  return { values, amountRule, kind: classifyParticipantAmount(values) };
}

/**
 * 수정(G-3/Q4b). 금액(현금·현물 중 하나라도)을 명시하면 그 값 — 수동. 명시하지 않으면 **직전 구분대로**:
 * - 자동 → 새 참여율·개월·연봉으로 재계산. 축은 기존 0 아닌 쪽, 둘 다 0이면 현금
 * - 수동 → 금액 유지
 * - 연봉 모름 → 금액 둘 다 0이면 재계산(현금), 아니면 유지 — 사용자가 손으로 넣은 금액을 덮지 않는다
 *
 * 재계산하려는데 새 연봉이 null이면(자동 행의 연봉을 지운 경우) 계산값이 없으므로 금액을 유지한다 —
 * 0으로 덮으면 "연봉 모름"이 "인건비 0원"으로 둔갑한다.
 */
export function resolveParticipantEdit(before: ParticipantFields, patch: ParticipantPatch): ResolvedParticipant {
  assertFields(before, '참여인원 편집 전 값');
  const next: ParticipantFields = {
    memberId: patch.memberId !== undefined ? patch.memberId : before.memberId,
    yearId: patch.yearId ?? before.yearId,
    participationRate: patch.participationRate ?? before.participationRate,
    months: patch.months ?? before.months,
    annualSalary: patch.annualSalary !== undefined ? patch.annualSalary : before.annualSalary,
    personnelCash: patch.personnelCash ?? before.personnelCash,
    personnelInKind: patch.personnelInKind ?? before.personnelInKind,
    role: patch.role ?? before.role,
  };
  if (hasExplicitAmount(patch)) return resolved(next, 'explicit');

  const beforeKind = classifyParticipantAmount(before);
  const recalcAllowed =
    beforeKind === 'auto' ||
    (beforeKind === 'salary_unknown' && before.personnelCash === 0 && before.personnelInKind === 0);
  if (!recalcAllowed) return resolved(next, 'kept');

  const computed = computeParticipantAmount(next);
  if (computed === null) return resolved(next, 'kept');
  const toInKind = before.personnelInKind !== 0 && before.personnelCash === 0;
  return resolved(
    { ...next, personnelCash: toInKind ? 0 : computed, personnelInKind: toInKind ? computed : 0 },
    'recalculated'
  );
}

/** 새 행 입력. `annualSalary`·금액을 비우면(`undefined`) 기본값을 채운다 */
export type NewParticipantInput = Pick<ParticipantFields, 'memberId' | 'yearId' | 'participationRate' | 'months' | 'role'> &
  Partial<Pick<ParticipantFields, 'annualSalary' | 'personnelCash' | 'personnelInKind'>>;

/**
 * 추가(S-11). 연봉을 비우면 그 시점 Member 연봉 스냅샷(`memberAnnualSalary` — 인력 미지정·연봉 미입력이면 호출자가
 * null), 금액을 둘 다 비우면 계산값을 현금으로(연봉 모름이면 0·0). 금액을 하나라도 적으면 수동 — 안 적은 쪽은 0.
 */
export function resolveNewParticipant(input: NewParticipantInput, memberAnnualSalary: number | null): ResolvedParticipant {
  if (input.memberId === null && memberAnnualSalary !== null) {
    throw new Error('인력 미지정 행에 인력 연봉이 넘어왔습니다 — 스냅샷 출처가 없습니다.');
  }
  assertSalary(memberAnnualSalary, '인력 연봉');
  const annualSalary = input.annualSalary !== undefined ? input.annualSalary : memberAnnualSalary;
  const base: ParticipantFields = {
    memberId: input.memberId,
    yearId: input.yearId,
    participationRate: input.participationRate,
    months: input.months,
    annualSalary,
    personnelCash: input.personnelCash ?? 0,
    personnelInKind: input.personnelInKind ?? 0,
    role: input.role,
  };
  if (hasExplicitAmount(input)) return resolved(base, 'explicit');
  assertCalcInput(base, '새 참여인원');
  const computed = computeParticipantAmount(base);
  if (computed === null) return resolved(base, 'kept');
  return resolved({ ...base, personnelCash: computed, personnelInKind: 0 }, 'recalculated');
}

// ─── 금액 줄 대조 (S-10) ──────────────────────────────────────────────────────

/** 대조 대상 금액 줄 비목 — 참여인원이 기록하는 인건비가 들어가는 두 비목(§5.23) */
export const PARTICIPANT_RECONCILE_CATEGORIES: readonly BudgetCategory[] = ['personnel', 'student_personnel'];

export type ReconcileLine = Pick<AgreementLine, 'yearId' | 'category' | 'axis' | 'amount'>;
export type ParticipantYear = Pick<Year, 'id' | 'name' | 'order'>;

export interface AxisPair {
  cash: number;
  inKind: number;
}

export interface ParticipantReconcileYear {
  yearId: string;
  yearName: string;
  /** Σ참여인원 인건비 */
  participants: AxisPair;
  /** Σ(personnel + student_personnel 금액 줄) */
  lines: AxisPair;
  /** participants − lines. 양수 = 참여인원이 금액 줄보다 많다 */
  diff: AxisPair;
}

export interface ParticipantReconciliation {
  /** 연차 `order` 순 */
  years: ParticipantReconcileYear[];
  total: Omit<ParticipantReconcileYear, 'yearId' | 'yearName'>;
  /** 어느 연차·축이든 차이가 0이 아니면 true */
  hasDifference: boolean;
}

function sortYears(years: readonly ParticipantYear[]): { sorted: ParticipantYear[]; index: Map<string, number> } {
  const sorted = [...years].sort((a, b) => a.order - b.order);
  const index = new Map<string, number>();
  sorted.forEach((y, i) => {
    if (index.has(y.id)) throw new Error(`연차 목록에 같은 연차가 두 번 있습니다 (${y.id}).`);
    index.set(y.id, i);
  });
  return { sorted, index };
}

const zeroPair = (): AxisPair => ({ cash: 0, inKind: 0 });
const subPair = (a: AxisPair, b: AxisPair): AxisPair => ({ cash: a.cash - b.cash, inKind: a.inKind - b.inKind });
const sumPairs = (pairs: AxisPair[]): AxisPair =>
  pairs.reduce((acc, p) => ({ cash: acc.cash + p.cash, inKind: acc.inKind + p.inKind }), zeroPair());

/** 연차·축별 Σ참여인원 − Σ(인건비 금액 줄). 표시만(Q4) — 결과로 무엇도 고치지 않는다 */
export function reconcileParticipants(
  participants: readonly (ParticipantAmountInput & Pick<AgreementParticipant, 'yearId'>)[],
  lines: readonly ReconcileLine[],
  years: readonly ParticipantYear[]
): ParticipantReconciliation {
  const { sorted, index } = sortYears(years);
  const fromParticipants = sorted.map(zeroPair);
  const fromLines = sorted.map(zeroPair);

  for (const p of participants) {
    const yi = index.get(p.yearId);
    if (yi === undefined) throw new Error(`참여인원이 과제에 없는 연차를 가리킵니다 (${p.yearId}).`);
    assertAmountInput(p, '참여인원');
    fromParticipants[yi]!.cash += p.personnelCash;
    fromParticipants[yi]!.inKind += p.personnelInKind;
  }
  for (const line of lines) {
    if (!PARTICIPANT_RECONCILE_CATEGORIES.includes(line.category)) continue;
    const yi = index.get(line.yearId);
    if (yi === undefined) throw new Error(`협약 금액 줄이 과제에 없는 연차를 가리킵니다 (${line.yearId}).`);
    assertWon(line.amount, '협약 금액 줄 금액', '협약 금액 줄');
    if (line.axis === 'cash') fromLines[yi]!.cash += line.amount;
    else if (line.axis === 'in_kind') fromLines[yi]!.inKind += line.amount;
    else throw new Error(`협약 금액 줄의 축을 알 수 없습니다 (${String(line.axis)}).`);
  }

  const rows: ParticipantReconcileYear[] = sorted.map((y, i) => ({
    yearId: y.id,
    yearName: y.name,
    participants: fromParticipants[i]!,
    lines: fromLines[i]!,
    diff: subPair(fromParticipants[i]!, fromLines[i]!),
  }));
  const total = {
    participants: sumPairs(rows.map((r) => r.participants)),
    lines: sumPairs(rows.map((r) => r.lines)),
    diff: sumPairs(rows.map((r) => r.diff)),
  };
  return { years: rows, total, hasDifference: rows.some((r) => r.diff.cash !== 0 || r.diff.inKind !== 0) };
}

// ─── 보기 모델 (S-9) ──────────────────────────────────────────────────────────

export type ViewParticipant = ParticipantFields & Pick<AgreementParticipant, 'id'>;
export type ParticipantMember = Pick<Member, 'id' | 'name' | 'order'>;

export interface ParticipantViewRow {
  id: string;
  memberId: string | null;
  /** 인력 이름, 미지정이면 "인력 미지정" */
  memberLabel: string;
  yearId: string;
  yearName: string;
  role: string;
  participationRate: number;
  months: number;
  annualSalary: number | null;
  /** 계산값. 연봉 모름이면 null(0이 아니다) */
  computed: number | null;
  cash: number;
  inKind: number;
  total: number;
  kind: ParticipantAmountKind;
  kindLabel: string;
}

export interface ParticipantYearSubtotal {
  yearId: string;
  yearName: string;
  rowCount: number;
  cash: number;
  inKind: number;
  total: number;
}

export interface ParticipantsViewModel {
  /** 인력 order(미지정 뒤) → 연차 order → id */
  rows: ParticipantViewRow[];
  /** 연차 order 순, 참여인원이 없는 연차도 0으로 있다 */
  yearSubtotals: ParticipantYearSubtotal[];
  grandTotal: { cash: number; inKind: number; total: number };
  reconciliation: ParticipantReconciliation;
}

/**
 * 참여인원 보기(AG-5). 과제 인력 목록에 없는 `memberId`·연차 목록에 없는 `yearId`·같은 id 두 번은 던진다
 * (FK·PK가 막았어야 하는 상태).
 */
export function buildParticipantsView(input: {
  participants: readonly ViewParticipant[];
  members: readonly ParticipantMember[];
  years: readonly ParticipantYear[];
  lines: readonly ReconcileLine[];
}): ParticipantsViewModel {
  const { sorted: years, index: yearIndex } = sortYears(input.years);
  const memberById = new Map<string, ParticipantMember>();
  for (const m of input.members) {
    if (memberById.has(m.id)) throw new Error(`인력 목록에 같은 인력이 두 번 있습니다 (${m.id}).`);
    memberById.set(m.id, m);
  }

  const seen = new Set<string>();
  const keyed = input.participants.map((p) => {
    if (seen.has(p.id)) throw new Error(`같은 참여인원 행이 두 번 있습니다 (${p.id}).`);
    seen.add(p.id);
    assertFields(p, `참여인원 ${p.id}`);
    const yi = yearIndex.get(p.yearId);
    if (yi === undefined) throw new Error(`참여인원이 과제에 없는 연차를 가리킵니다 (${p.yearId}).`);
    const member = p.memberId === null ? null : memberById.get(p.memberId);
    if (member === undefined) throw new Error(`참여인원이 과제에 없는 인력을 가리킵니다 (${p.memberId}).`);
    const row: ParticipantViewRow = {
      id: p.id,
      memberId: p.memberId,
      memberLabel: member === null ? AGREEMENT_VIEW_TEXT.unassignedMember : member.name,
      yearId: p.yearId,
      yearName: years[yi]!.name,
      role: p.role,
      participationRate: p.participationRate,
      months: p.months,
      annualSalary: p.annualSalary,
      computed: computeParticipantAmount(p),
      cash: p.personnelCash,
      inKind: p.personnelInKind,
      total: p.personnelCash + p.personnelInKind,
      kind: classifyParticipantAmount(p),
      kindLabel: '',
    };
    row.kindLabel = PARTICIPANT_AMOUNT_KIND_LABELS[row.kind];
    // 미지정은 어느 인력보다 뒤 — order가 음수여도 뒤로 가게 무한대로
    return { row, memberOrder: member === null ? Number.POSITIVE_INFINITY : member.order, yearOrder: yi };
  });

  keyed.sort(
    (a, b) =>
      a.memberOrder - b.memberOrder ||
      a.yearOrder - b.yearOrder ||
      (a.row.id < b.row.id ? -1 : a.row.id > b.row.id ? 1 : 0)
  );
  const rows = keyed.map((k) => k.row);

  const yearSubtotals: ParticipantYearSubtotal[] = years.map((y) => {
    const inYear = rows.filter((r) => r.yearId === y.id);
    const cash = inYear.reduce((s, r) => s + r.cash, 0);
    const inKind = inYear.reduce((s, r) => s + r.inKind, 0);
    return { yearId: y.id, yearName: y.name, rowCount: inYear.length, cash, inKind, total: cash + inKind };
  });
  const cash = yearSubtotals.reduce((s, y) => s + y.cash, 0);
  const inKind = yearSubtotals.reduce((s, y) => s + y.inKind, 0);

  return {
    rows,
    yearSubtotals,
    grandTotal: { cash, inKind, total: cash + inKind },
    reconciliation: reconcileParticipants(input.participants, input.lines, input.years),
  };
}

// ─── 표 모델 (AG-8) ───────────────────────────────────────────────────────────

/** 열 순서(S-9). 참여율·개월은 소수가 될 수 있어 text 열이다 — amount 칸은 원 단위 정수만 받는다 */
const COL = {
  member: 0,
  year: 1,
  role: 2,
  rate: 3,
  months: 4,
  salary: 5,
  computed: 6,
  cash: 7,
  inKind: 8,
  total: 9,
  kind: 10,
} as const;

const PARTICIPANT_COLUMNS: TableColumn[] = [
  { label: '인력', type: 'text', key: true, width: 14 },
  { label: '연차', type: 'text', key: true, width: 10 },
  { label: '역할', type: 'text', width: 20 },
  { label: '참여율(%)', type: 'text', width: 10 },
  { label: '개월', type: 'text', width: 8 },
  { label: '연봉 스냅샷', type: 'amount' },
  { label: '계산값', type: 'amount' },
  { label: '현금', type: 'amount' },
  { label: '현물', type: 'amount' },
  { label: '계', type: 'amount' },
  { label: '구분', type: 'text', width: 10 },
];

const text = (value: string): TableCell => ({ kind: 'text', text: value });
const amountOrEmpty = (value: number | null): TableCell =>
  value === null ? { kind: 'empty' } : { kind: 'amount', value };

/** 항이 없으면 amount 0 — 항 없는 SUM은 엑셀 오류다(assertTableModel) */
function sumOrZero(value: number, terms: TableCellRef[]): TableCell {
  return terms.length === 0 ? { kind: 'amount', value } : { kind: 'sum', value, terms };
}

/**
 * 참여인원 보기 → 표 모델. 데이터 행 다음에 연차 소계 행(연차 order 순), 마지막에 총계 행.
 * 계·소계·총계는 `sum` 칸이라 엑셀에서 금액을 고치면 따라 움직인다. 대조는 표에 넣지 않는다 —
 * 같은 열에 성격이 다른 차액이 섞이면 열 합계가 의미를 잃는다(화면에서 별도 행으로 보인다).
 */
export function participantsTable(view: ParticipantsViewModel, title: string): TableModel {
  const rows: TableRow[] = view.rows.map((r, i) => ({
    kind: 'data',
    cells: [
      text(r.memberLabel),
      text(r.yearName),
      text(r.role),
      text(String(r.participationRate)),
      text(String(r.months)),
      amountOrEmpty(r.annualSalary),
      amountOrEmpty(r.computed),
      { kind: 'amount', value: r.cash },
      { kind: 'amount', value: r.inKind },
      { kind: 'sum', value: r.total, terms: [{ row: i, col: COL.cash }, { row: i, col: COL.inKind }] },
      text(r.kindLabel),
    ],
  }));

  const subtotalRowIndex: number[] = [];
  for (const y of view.yearSubtotals) {
    const members = view.rows.flatMap((r, i) => (r.yearId === y.yearId ? [i] : []));
    const terms = (col: number): TableCellRef[] => members.map((row) => ({ row, col }));
    subtotalRowIndex.push(rows.length);
    rows.push({
      kind: 'subtotal',
      cells: [
        text('소계'),
        text(y.yearName),
        text(''),
        text(''),
        text(''),
        { kind: 'empty' },
        { kind: 'empty' },
        sumOrZero(y.cash, terms(COL.cash)),
        sumOrZero(y.inKind, terms(COL.inKind)),
        sumOrZero(y.total, terms(COL.total)),
        text(''),
      ],
    });
  }

  const g = view.grandTotal;
  const totalTerms = (col: number): TableCellRef[] => subtotalRowIndex.map((row) => ({ row, col }));
  rows.push({
    kind: 'total',
    cells: [
      text('총계'),
      text(''),
      text(''),
      text(''),
      text(''),
      { kind: 'empty' },
      { kind: 'empty' },
      sumOrZero(g.cash, totalTerms(COL.cash)),
      sumOrZero(g.inKind, totalTerms(COL.inKind)),
      sumOrZero(g.total, totalTerms(COL.total)),
      text(''),
    ],
  });

  return { title, columns: PARTICIPANT_COLUMNS, rows };
}
