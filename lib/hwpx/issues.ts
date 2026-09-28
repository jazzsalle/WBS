// 계획서 표 단위 사유 (SOT §6.18 HX-2~HX-8, S-27·S-28).
//
// 행 단위 사유는 lib/goal-form의 GOAL_FORM_ISSUES에 있고, 표를 찾고 잇는 단계의 사유는 이 표 한 곳에서만 정한다.
// 클라이언트(추출 직후 요약)도 import하므로 외부 import가 없다(S-33).

import type { PlanTableKind } from './types';

export const PLAN_ISSUES = {
  // ── 추출 (HX-2) ──
  'structure-mismatch': {
    message: '행 수가 선언과 달라 읽지 않은 표가 있습니다(구조 불일치)',
    blocking: false,
  },
  // ── 식별 (HX-3, S-28) ──
  'table-not-found': { message: '표를 찾지 못했습니다 — 헤더 서명', blocking: false },
  'no-goal-tables': {
    message: '기술목표 표와 성과목표 표를 둘 다 찾지 못했습니다 — 계획서의 목표 표 머리행이 양식과 같은지 확인하세요',
    blocking: true,
  },
  'header-not-found': {
    message: '헤더 서명은 맞지만 머리행을 정할 수 없어 읽지 않습니다',
    blocking: false,
  },
  'duplicate-table': { message: '같은 표가 더 있습니다 — 첫 표만 읽습니다', blocking: false },
  // ── 잇기 (HX-4) ──
  'sequence-gap': { message: '순번이 1씩 늘지 않습니다 — 쪽 나뉨으로 빠진 행이 없는지 확인하세요', blocking: false },
  // ── 열 역할 (C.3.5, S-3) ──
  'unread-column': { message: '읽지 않은 열', blocking: false },
  'missing-column': { message: '이 열을 찾지 못해 해당 값을 읽지 않습니다', blocking: false },
  // ── 행 해석 (HX-5·HX-7, S-29 — T6이 쓴다) ──
  'year-count-mismatch': {
    message: '표의 연차 열 수와 과제 연차 수가 다릅니다 — 앞에서부터 짝지은 연차만 반영합니다',
    blocking: false,
  },
  'unlinked-method-row': {
    message: '평가방법 표의 행을 기술목표에 잇지 못했습니다 — 순번·평가항목이 맞는 기술목표가 없습니다',
    blocking: false,
  },
} as const satisfies Record<string, { message: string; blocking: boolean }>;

export type PlanIssueKind = keyof typeof PLAN_ISSUES;

export interface PlanIssue {
  kind: PlanIssueKind;
  /** 표 문구 + (있으면) `: {표·열·값}` */
  message: string;
  blocking: boolean;
}

export function planIssue(kind: PlanIssueKind, detail?: string): PlanIssue {
  const def = PLAN_ISSUES[kind];
  return { kind, message: detail === undefined ? def.message : `${def.message}: ${detail}`, blocking: def.blocking };
}

/** 사용자 문구의 표 이름 */
export const PLAN_TABLE_LABELS: Record<PlanTableKind, string> = {
  tech: '기술목표 표',
  deliverable: '성과목표 표',
  method: '평가방법 표',
};

/** "같은 표가 N개 더 있습니다"(HX-3) — 개수를 문구 안에 넣어야 해서 detail이 아니라 문구를 만든다 */
export function duplicateTableIssue(kind: PlanTableKind, extraBundles: number, indexes: readonly number[]): PlanIssue {
  const where = indexes.map((i) => `표 ${i + 1}`).join(', ');
  return {
    kind: 'duplicate-table',
    message: `${PLAN_TABLE_LABELS[kind]}와 같은 표가 ${extraBundles}개 더 있습니다 — 첫 표만 읽습니다: ${where}`,
    blocking: PLAN_ISSUES['duplicate-table'].blocking,
  };
}
