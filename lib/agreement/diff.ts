// 협약 예산 두 버전 간 증감 (SOT §6.19 AG-7, 계획서 S-12).
//
// 금액 줄은 키 (연차, 비목, 세목, 축), 참여인원은 키 (인력, 연차)로 맞춘다. 증감은 파생 값이라 저장하지 않고
// 읽을 때 계산한다(AG-1). 같은 키가 한 버전에 두 번 나오면 합치지 않고 던진다 — DB 유일 제약이 막았어야 하는
// 상태이고, 조용히 합치면 증감 숫자가 맞는 것처럼 보인다(절대 규칙 5).
//
// 경계(AG-9): 순수 함수. 버전 판정(어느 버전이 A·B인지)은 호출자 몫이다.

import { BUDGET_CATEGORY_ORDER, DEFAULT_SUBCATEGORY_CODE, SUBCATEGORY_PRESETS } from '@/lib/constants';
import type { AgreementLine, AgreementParticipant, BudgetCategory, DetailAxis, Year } from '@/types';

// ─── 공통 ─────────────────────────────────────────────────────────────────────

export type AgreementChangeStatus = 'added' | 'removed' | 'changed' | 'unchanged';

export type AgreementLineKey = Pick<AgreementLine, 'yearId' | 'category' | 'subcategoryCode' | 'axis'>;
export type DiffLine = AgreementLineKey & Pick<AgreementLine, 'amount'>;
export type DiffYear = Pick<Year, 'id' | 'order'>;

const AXIS_ORDER: readonly DetailAxis[] = ['cash', 'in_kind'];

function emptyCounts(): Record<AgreementChangeStatus, number> {
  return { added: 0, removed: 0, changed: 0, unchanged: 0 };
}

function assertAmount(value: number, where: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${where}: 금액이 0 이상의 원 단위 정수가 아닙니다 (${value}).`);
  }
}

function yearRanker(years: readonly DiffYear[]): (yearId: string) => number {
  const rank = new Map(years.map((y) => [y.id, y.order]));
  return (yearId) => {
    const r = rank.get(yearId);
    // 연차 삭제는 H-5a가 막는다 — 모르는 연차는 데이터가 어긋난 것이니 순서를 지어내지 않는다
    if (r === undefined) throw new Error(`협약 예산 줄이 과제에 없는 연차(${yearId})를 가리킵니다.`);
    return r;
  };
}

/**
 * 비목 안의 세목 순서(부록 A.5). 세목이 여럿인 비목의 `default`("세목 미지정")는 맨 뒤.
 * A.5 밖 코드는 던진다 — 액션 Zod가 막았어야 하는 값을 아무 자리에나 끼워 넣지 않는다.
 */
export function subcategoryRank(category: BudgetCategory, code: string): number {
  const presets = SUBCATEGORY_PRESETS[category];
  const index = presets.findIndex((def) => def.code === code);
  if (index >= 0) return index;
  if (code === DEFAULT_SUBCATEGORY_CODE) return presets.length;
  throw new Error(`비목 ${category}에 없는 세목 코드입니다: ${code}`);
}

/** (비목, 세목, 축) 비교 — 부록 A.1 비목 순서, A.5 세목 순서, 현금 → 현물 */
export function compareCategoryKey(
  a: Pick<AgreementLine, 'category' | 'subcategoryCode' | 'axis'>,
  b: Pick<AgreementLine, 'category' | 'subcategoryCode' | 'axis'>
): number {
  return (
    BUDGET_CATEGORY_ORDER.indexOf(a.category) - BUDGET_CATEGORY_ORDER.indexOf(b.category) ||
    subcategoryRank(a.category, a.subcategoryCode) - subcategoryRank(b.category, b.subcategoryCode) ||
    AXIS_ORDER.indexOf(a.axis) - AXIS_ORDER.indexOf(b.axis)
  );
}

// ─── 금액 줄 증감 ─────────────────────────────────────────────────────────────

export interface LineChange extends AgreementLineKey {
  status: AgreementChangeStatus;
  /** A(이전)의 금액. A에 줄이 없으면 null — 금액 0인 줄과 구별된다 */
  fromAmount: number | null;
  toAmount: number | null;
  /** B − A (없는 쪽은 0) */
  delta: number;
}

export interface YearLineTotals {
  yearId: string;
  fromTotal: number;
  toTotal: number;
  delta: number;
}

export interface LineDiff {
  /** 연차 순서 → 비목·세목·축 순서 */
  changes: LineChange[];
  counts: Record<AgreementChangeStatus, number>;
  fromTotal: number;
  toTotal: number;
  /** toTotal − fromTotal */
  netDelta: number;
  /** 어느 쪽에든 줄이 있는 연차만, 연차 순서 */
  yearTotals: YearLineTotals[];
}

function lineKey(line: AgreementLineKey): string {
  return `${line.yearId}\u0000${line.category}\u0000${line.subcategoryCode}\u0000${line.axis}`;
}

function indexLines(lines: readonly DiffLine[], side: string): Map<string, DiffLine> {
  const map = new Map<string, DiffLine>();
  for (const line of lines) {
    assertAmount(line.amount, `${side} 버전 줄(${line.category}/${line.subcategoryCode}/${line.axis})`);
    subcategoryRank(line.category, line.subcategoryCode);
    const key = lineKey(line);
    if (map.has(key)) {
      throw new Error(
        `${side} 버전에 같은 줄이 두 번 있습니다 (연차 ${line.yearId}, ${line.category}/${line.subcategoryCode}/${line.axis}).`
      );
    }
    map.set(key, line);
  }
  return map;
}

/**
 * 두 버전의 금액 줄 증감(AG-7 ①). `from` = A(이전), `to` = B(이후). 빈 버전과의 비교는 한쪽이 빈 배열이다.
 * 같은 버전끼리면 전부 `unchanged`.
 */
export function diffAgreementLines(
  from: readonly DiffLine[],
  to: readonly DiffLine[],
  years: readonly DiffYear[]
): LineDiff {
  const yearRank = yearRanker(years);
  const fromMap = indexLines(from, '이전');
  const toMap = indexLines(to, '이후');

  const changes: LineChange[] = [];
  for (const key of new Set([...fromMap.keys(), ...toMap.keys()])) {
    const a = fromMap.get(key);
    const b = toMap.get(key);
    const base = (b ?? a)!;
    // 정렬 비교가 한 번도 불리지 않는 경우(줄 1개)에도 모르는 연차를 잡는다
    yearRank(base.yearId);
    const fromAmount = a?.amount ?? null;
    const toAmount = b?.amount ?? null;
    const status: AgreementChangeStatus =
      a === undefined ? 'added' : b === undefined ? 'removed' : a.amount === b.amount ? 'unchanged' : 'changed';
    changes.push({
      yearId: base.yearId,
      category: base.category,
      subcategoryCode: base.subcategoryCode,
      axis: base.axis,
      status,
      fromAmount,
      toAmount,
      delta: (toAmount ?? 0) - (fromAmount ?? 0),
    });
  }
  changes.sort((x, y) => yearRank(x.yearId) - yearRank(y.yearId) || compareCategoryKey(x, y));

  const counts = emptyCounts();
  const yearMap = new Map<string, YearLineTotals>();
  let fromTotal = 0;
  let toTotal = 0;
  for (const c of changes) {
    counts[c.status] += 1;
    fromTotal += c.fromAmount ?? 0;
    toTotal += c.toAmount ?? 0;
    let yt = yearMap.get(c.yearId);
    if (yt === undefined) {
      yt = { yearId: c.yearId, fromTotal: 0, toTotal: 0, delta: 0 };
      yearMap.set(c.yearId, yt);
    }
    yt.fromTotal += c.fromAmount ?? 0;
    yt.toTotal += c.toAmount ?? 0;
    yt.delta += c.delta;
  }

  return {
    changes,
    counts,
    fromTotal,
    toTotal,
    netDelta: toTotal - fromTotal,
    // changes가 연차 순서이므로 Map 삽입 순서도 연차 순서다
    yearTotals: [...yearMap.values()],
  };
}

// ─── 참여인원 증감 ────────────────────────────────────────────────────────────

export type DiffParticipant = Pick<
  AgreementParticipant,
  'memberId' | 'yearId' | 'participationRate' | 'months' | 'personnelCash' | 'personnelInKind'
>;

export interface ParticipationTerm {
  participationRate: number;
  months: number;
}

/** 한 키 (인력, 연차)의 비교 값 — Σ현금·Σ현물·(참여율, 개월) 다중집합(정렬된 배열) */
export interface ParticipantGroupValue {
  rowCount: number;
  personnelCash: number;
  personnelInKind: number;
  terms: ParticipationTerm[];
}

export interface ParticipantChange {
  /** null = 그 연차의 "인력 미지정" 그룹(행 여럿이 한 그룹) */
  memberId: string | null;
  yearId: string;
  status: AgreementChangeStatus;
  from: ParticipantGroupValue | null;
  to: ParticipantGroupValue | null;
  cashDelta: number;
  inKindDelta: number;
}

export interface ParticipantDiff {
  /** 연차 순서 → 인력 id 순서(인력 미지정은 맨 뒤). 화면 순서(이름)는 표가 다시 정한다 */
  changes: ParticipantChange[];
  counts: Record<AgreementChangeStatus, number>;
}

function participantKey(p: Pick<DiffParticipant, 'memberId' | 'yearId'>): string {
  // memberId가 null인 행은 연차마다 한 그룹 — uuid와 겹치지 않는 표식
  return `${p.yearId}\u0000${p.memberId ?? '\u0000unassigned'}`;
}

function compareTerm(a: ParticipationTerm, b: ParticipationTerm): number {
  return a.participationRate - b.participationRate || a.months - b.months;
}

function groupParticipants(
  rows: readonly DiffParticipant[],
  side: string
): Map<string, { memberId: string | null; yearId: string; value: ParticipantGroupValue }> {
  const map = new Map<string, { memberId: string | null; yearId: string; value: ParticipantGroupValue }>();
  for (const row of rows) {
    const where = `${side} 버전 참여인원(${row.memberId ?? '인력 미지정'}, 연차 ${row.yearId})`;
    assertAmount(row.personnelCash, where);
    assertAmount(row.personnelInKind, where);
    if (!Number.isFinite(row.participationRate) || !Number.isFinite(row.months)) {
      throw new Error(`${where}: 참여율·개월이 숫자가 아닙니다.`);
    }
    const key = participantKey(row);
    let group = map.get(key);
    if (group === undefined) {
      group = {
        memberId: row.memberId,
        yearId: row.yearId,
        value: { rowCount: 0, personnelCash: 0, personnelInKind: 0, terms: [] },
      };
      map.set(key, group);
    }
    group.value.rowCount += 1;
    group.value.personnelCash += row.personnelCash;
    group.value.personnelInKind += row.personnelInKind;
    group.value.terms.push({ participationRate: row.participationRate, months: row.months });
  }
  for (const group of map.values()) group.value.terms.sort(compareTerm);
  return map;
}

function sameGroupValue(a: ParticipantGroupValue, b: ParticipantGroupValue): boolean {
  return (
    a.personnelCash === b.personnelCash &&
    a.personnelInKind === b.personnelInKind &&
    a.terms.length === b.terms.length &&
    a.terms.every((t, i) => compareTerm(t, b.terms[i]!) === 0)
  );
}

/** 두 버전의 참여인원 증감(AG-7 ②). Σ현금·Σ현물·(참여율, 개월) 다중집합 중 하나라도 다르면 `changed` */
export function diffAgreementParticipants(
  from: readonly DiffParticipant[],
  to: readonly DiffParticipant[],
  years: readonly DiffYear[]
): ParticipantDiff {
  const yearRank = yearRanker(years);
  const fromMap = groupParticipants(from, '이전');
  const toMap = groupParticipants(to, '이후');

  const changes: ParticipantChange[] = [];
  for (const key of new Set([...fromMap.keys(), ...toMap.keys()])) {
    const a = fromMap.get(key);
    const b = toMap.get(key);
    const base = (b ?? a)!;
    yearRank(base.yearId);
    const status: AgreementChangeStatus =
      a === undefined ? 'added' : b === undefined ? 'removed' : sameGroupValue(a.value, b.value) ? 'unchanged' : 'changed';
    changes.push({
      memberId: base.memberId,
      yearId: base.yearId,
      status,
      from: a?.value ?? null,
      to: b?.value ?? null,
      cashDelta: (b?.value.personnelCash ?? 0) - (a?.value.personnelCash ?? 0),
      inKindDelta: (b?.value.personnelInKind ?? 0) - (a?.value.personnelInKind ?? 0),
    });
  }
  changes.sort((x, y) => {
    const byYear = yearRank(x.yearId) - yearRank(y.yearId);
    if (byYear !== 0) return byYear;
    if (x.memberId === y.memberId) return 0;
    if (x.memberId === null) return 1;
    if (y.memberId === null) return -1;
    return x.memberId < y.memberId ? -1 : 1;
  });

  const counts = emptyCounts();
  for (const c of changes) counts[c.status] += 1;
  return { changes, counts };
}
