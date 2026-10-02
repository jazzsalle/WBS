// 제안 편성 → 협약 기준선 (SOT §5.21 AV-6, 계획서 S-6·Q2).
//
// [협약 기준선으로 보내기]가 만들 버전의 내용(금액 줄·참여인원·편성 항목)을 계산한다. 쓰기는 단일 트랜잭션
// RPC가 하고, 여기는 순수 함수다. 보낸 뒤 두 모드는 독립이다 — 그래서 산출근거 금액은 저장된 `amount`를
// 그대로 옮긴다(재계산하지 않는다): 사용자가 제안 화면에서 본 숫자가 버전의 숫자여야 한다.
//
// 금액을 조용히 잃지 않는 것이 이 모듈의 전부다: 축이 반만 적힌 셀이 계획액과 어긋나거나, 합이 음수인
// 그룹은 위치를 적어 거부한다. 현금·현물을 모르는 셀(둘 다 null)만 현금으로 보내고 그 건수를 알린다(Q2).

import {
  agreementSubcategoryLabel,
  BUDGET_CATEGORY_LABELS,
  BUDGET_CATEGORY_ORDER,
  DEFAULT_SUBCATEGORY_CODE,
  SUBCATEGORY_PRESETS,
} from '@/lib/constants';
import { personnelParticipation } from '@/lib/budget-plan';
import { personnelMonths } from '@/lib/participation';
import type { BudgetCategory, BudgetDetail, BudgetItem, DetailAxis, Member, Year } from '@/types';

// ─── 입력 ─────────────────────────────────────────────────────────────────────

export type PlanItemInput = Pick<BudgetItem, 'yearId' | 'category' | 'plannedAmount' | 'cashAmount' | 'inKindAmount'>;
export type PlanDetailInput = Pick<
  BudgetDetail,
  'yearId' | 'category' | 'subcategory' | 'axis' | 'formula' | 'memberId' | 'factors' | 'amount'
>;
export type PlanMemberInput = Pick<Member, 'id' | 'annualSalary'>;
export type PlanYearInput = Pick<Year, 'id' | 'name' | 'order'>;

export interface BaselineFromPlanInput {
  items: readonly PlanItemInput[];
  details: readonly PlanDetailInput[];
  /** 참여인원 연봉 스냅샷의 출처 — 보낼 때의 값(§5.23) */
  members: readonly PlanMemberInput[];
  /** 위치 표시·순서·연차 경계 확인용. 과제의 연차 전부 */
  years: readonly PlanYearInput[];
}

// ─── 출력 ─────────────────────────────────────────────────────────────────────

export interface BaselineLine {
  yearId: string;
  category: BudgetCategory;
  subcategoryCode: string;
  axis: DetailAxis;
  amount: number;
}

export interface BaselineParticipant {
  memberId: string | null;
  yearId: string;
  participationRate: number;
  months: number;
  annualSalary: number | null;
  personnelCash: number;
  personnelInKind: number;
  role: string;
}

/** 현금·현물을 모른 채 계획액만 있던 셀 — 현금으로 보냈다(Q2) */
export interface UnsplitCell {
  yearId: string;
  category: BudgetCategory;
  amount: number;
}

export type BaselineIssueCode =
  /** 현금·현물 중 하나만 적혔는데 둘의 합(null = 0)이 계획액과 다르다 */
  | 'split_mismatch'
  /** (연차, 비목, 세목, 축) 합이 음수다 — 0 이상만 줄이 된다 */
  | 'negative_group'
  /** 인건비 산출 행의 금액이 음수다(PL-5) */
  | 'negative_participant'
  /** 인건비 산출 행의 참여율·개월이 협약 참여인원 범위(0~100 / 0~12) 밖이다 */
  | 'participant_out_of_range'
  /** 인건비 산출 행이 가리키는 인력이 입력에 없다 */
  | 'unknown_member'
  /** 산출 행 세목이 부록 A.5에도 'default'도 아니다 — 협약 금액 줄은 그 세목을 받지 않는다(§5.22) */
  | 'unknown_subcategory'
  /** 과제 연차 목록에 없는 연차 */
  | 'unknown_year'
  /** 금액이 원 단위 정수가 아니다 */
  | 'invalid_amount';

export interface BaselineIssue {
  code: BaselineIssueCode;
  yearId: string;
  category: BudgetCategory;
  /** 위치(연차·비목)를 담은 사용자용 문장 */
  message: string;
}

export interface BaselineSummary {
  lineCount: number;
  participantCount: number;
  cashTotal: number;
  inKindTotal: number;
  unsplit: { count: number; amount: number; cells: UnsplitCell[] };
}

export type BaselineFromPlanResult =
  | {
      ok: true;
      lines: BaselineLine[];
      participants: BaselineParticipant[];
      /** 편성 항목은 Phase 26까지 0건이다(AV-6 ③) — 빈 배열이 "만들 것 없음"이라는 값이다 */
      items: [];
      summary: BaselineSummary;
    }
  | { ok: false; issues: BaselineIssue[] };

// ─── 계산 ─────────────────────────────────────────────────────────────────────

const AXES: readonly DetailAxis[] = ['cash', 'in_kind'];

function subcategoryRank(category: BudgetCategory, code: string): number {
  const index = SUBCATEGORY_PRESETS[category].findIndex((d) => d.code === code);
  // default가 프리셋에 없는 비목에서는 세목들 뒤, 프리셋에 없는 코드는 그보다 뒤(입력 순서 유지는 안정 정렬이 한다)
  if (index >= 0) return index;
  return code === DEFAULT_SUBCATEGORY_CODE ? 1000 : 2000;
}

/**
 * 제안 편성(산출근거·셀 금액) → 협약 기준선(AV-6). 거부 사유가 하나라도 있으면 전부 모아 `ok: false` —
 * 버전을 반쯤 만들지 않는다. 결과 줄은 연차 `order` → 부록 A.1 비목 → A.5 세목 → 현금·현물 순이다.
 */
export function buildBaselineFromPlan(input: BaselineFromPlanInput): BaselineFromPlanResult {
  const years = [...input.years].sort((a, b) => a.order - b.order);
  const yearRank = new Map(years.map((y, i) => [y.id, i]));
  const yearName = new Map(years.map((y) => [y.id, y.name]));
  const members = new Map(input.members.map((m) => [m.id, m]));
  const issues: BaselineIssue[] = [];

  const where = (yearId: string, category: BudgetCategory): string =>
    `${yearName.get(yearId) ?? '알 수 없는 연차'} ${BUDGET_CATEGORY_LABELS[category]}`;
  const issue = (code: BaselineIssueCode, yearId: string, category: BudgetCategory, message: string): void => {
    issues.push({ code, yearId, category, message: `${where(yearId, category)}: ${message}` });
  };
  const knownYear = (yearId: string, category: BudgetCategory): boolean => {
    if (yearRank.has(yearId)) return true;
    issue('unknown_year', yearId, category, '과제에 없는 연차입니다.');
    return false;
  };
  const isAmount = (v: number): boolean => Number.isSafeInteger(v);

  const groups = new Map<string, BaselineLine>();
  const addToGroup = (yearId: string, category: BudgetCategory, subcategoryCode: string, axis: DetailAxis, amount: number): void => {
    const key = `${yearId}|${category}|${subcategoryCode}|${axis}`;
    const g = groups.get(key);
    if (g === undefined) groups.set(key, { yearId, category, subcategoryCode, axis, amount });
    else g.amount += amount;
  };

  // ① 산출근거가 있는 셀 — 산출 행 amount를 세목·축별로 합산
  const detailCells = new Set<string>();
  const participants: BaselineParticipant[] = [];
  for (const d of input.details) {
    if (!knownYear(d.yearId, d.category)) continue;
    if (!isAmount(d.amount)) {
      issue('invalid_amount', d.yearId, d.category, `산출근거 금액이 원 단위 정수가 아닙니다 (${d.amount}).`);
      continue;
    }
    detailCells.add(`${d.yearId}|${d.category}`);
    if (agreementSubcategoryLabel(d.category, d.subcategory) === null) {
      issue('unknown_subcategory', d.yearId, d.category, `산출근거 세목 '${d.subcategory}'은 부록 A.5에 없는 세목입니다.`);
      continue;
    }
    addToGroup(d.yearId, d.category, d.subcategory, d.axis, d.amount);

    // ② 참여인원 — 인건비 산출 행 1개 = 1행. 금액은 산출 행 금액 그대로(재계산하면 제안 화면과 1원이라도 어긋날 수 있다)
    if (d.formula !== 'personnel') continue;
    let annualSalary: number | null = null;
    if (d.memberId !== null) {
      const member = members.get(d.memberId);
      if (member === undefined) {
        issue('unknown_member', d.yearId, d.category, '인건비 산출 행이 가리키는 인력을 찾을 수 없습니다.');
        continue;
      }
      annualSalary = member.annualSalary;
    }
    if (d.amount < 0) {
      issue('negative_participant', d.yearId, d.category, `인건비 산출 행 금액이 음수입니다 (${d.amount}원).`);
      continue;
    }
    const participationRate = personnelParticipation(d);
    const months = personnelMonths(d);
    if (!(participationRate >= 0 && participationRate <= 100) || !(months >= 0 && months <= 12)) {
      issue(
        'participant_out_of_range',
        d.yearId,
        d.category,
        `인건비 산출 행의 참여율(${participationRate}%)·개월(${months})이 범위(0~100% · 0~12개월)를 벗어났습니다.`
      );
      continue;
    }
    participants.push({
      memberId: d.memberId,
      yearId: d.yearId,
      participationRate,
      months,
      annualSalary,
      personnelCash: d.axis === 'cash' ? d.amount : 0,
      personnelInKind: d.axis === 'in_kind' ? d.amount : 0,
      role: '',
    });
  }

  // ③ 산출근거가 없는 셀 — 현금·현물 칸을 default 세목으로
  const unsplitCells: UnsplitCell[] = [];
  for (const item of input.items) {
    if (detailCells.has(`${item.yearId}|${item.category}`)) continue;
    if (!knownYear(item.yearId, item.category)) continue;
    const { plannedAmount: planned, cashAmount: cash, inKindAmount: inKind } = item;
    if (!isAmount(planned) || (cash !== null && !isAmount(cash)) || (inKind !== null && !isAmount(inKind))) {
      issue('invalid_amount', item.yearId, item.category, '계획액·현금·현물이 원 단위 정수가 아닙니다.');
      continue;
    }
    if (cash === null && inKind === null) {
      // Q2 — 축을 모르는 계획액은 현금으로. 0 이하는 아래 그룹 검사(0 생략·음수 거부)에 맡긴다
      if (planned > 0) unsplitCells.push({ yearId: item.yearId, category: item.category, amount: planned });
      addToGroup(item.yearId, item.category, DEFAULT_SUBCATEGORY_CODE, 'cash', planned);
      continue;
    }
    const c = cash ?? 0;
    const k = inKind ?? 0;
    if (c + k !== planned) {
      issue(
        'split_mismatch',
        item.yearId,
        item.category,
        `현금(${c.toLocaleString('ko-KR')}원) + 현물(${k.toLocaleString('ko-KR')}원)이 계획액(${planned.toLocaleString('ko-KR')}원)과 다릅니다 — 제안 모드에서 현금·현물을 맞춘 뒤 보내세요.`
      );
      continue;
    }
    addToGroup(item.yearId, item.category, DEFAULT_SUBCATEGORY_CODE, 'cash', c);
    addToGroup(item.yearId, item.category, DEFAULT_SUBCATEGORY_CODE, 'in_kind', k);
  }

  const lines: BaselineLine[] = [];
  for (const g of groups.values()) {
    if (g.amount < 0) {
      const sub = agreementSubcategoryLabel(g.category, g.subcategoryCode) ?? g.subcategoryCode;
      const axis = g.axis === 'cash' ? '현금' : '현물';
      issue('negative_group', g.yearId, g.category, `${sub} ${axis} 합계가 음수입니다 (${g.amount.toLocaleString('ko-KR')}원).`);
      continue;
    }
    if (g.amount === 0) continue;
    lines.push(g);
  }

  if (issues.length > 0) return { ok: false, issues };

  const categoryRank = new Map<BudgetCategory, number>(BUDGET_CATEGORY_ORDER.map((c, i) => [c, i]));
  lines.sort(
    (a, b) =>
      yearRank.get(a.yearId)! - yearRank.get(b.yearId)! ||
      categoryRank.get(a.category)! - categoryRank.get(b.category)! ||
      subcategoryRank(a.category, a.subcategoryCode) - subcategoryRank(b.category, b.subcategoryCode) ||
      AXES.indexOf(a.axis) - AXES.indexOf(b.axis)
  );

  let cashTotal = 0;
  let inKindTotal = 0;
  for (const l of lines) {
    if (l.axis === 'cash') cashTotal += l.amount;
    else inKindTotal += l.amount;
  }
  return {
    ok: true,
    lines,
    participants,
    items: [],
    summary: {
      lineCount: lines.length,
      participantCount: participants.length,
      cashTotal,
      inKindTotal,
      unsplit: {
        count: unsplitCells.length,
        amount: unsplitCells.reduce((s, u) => s + u.amount, 0),
        cells: unsplitCells,
      },
    },
  };
}
