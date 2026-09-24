// 산출근거 패널의 호출 계약 (SOT §7.9.2)
//
// **props 타입만** 둔다. 연구비 화면(BudgetScreen)은 이 파일만 읽으면 패널을 열 수 있고,
// 패널은 화면을 import 하지 않는다 — 의존이 한 방향이다.
//
// 패널이 스스로 갖는 것(부모가 넘기지 않는 것):
//  - **데이터**: 셀이 열릴 때 getBudgetDetails(yearId, category)를 직접 호출한다. 매트릭스가
//    이미 들고 있는 셀 요약(BudgetPlanCellView)으로는 행 단위 편집을 할 수 없고, 저장 뒤
//    다시 받아야 하는 것도 이 목록뿐이다. 조회 실패는 패널 안의 배너로 드러낸다
//    (절대 규칙 5 — 빈 목록 폴백 금지).
//  - **실패 배너·STALE 충돌 다이얼로그(§8.4 O-3)**: O-3의 "다시 불러오기"는 패널이 가진
//    행 목록을 다시 받아야 한다. 부모의 router.refresh()는 서버 컴포넌트만 다시 그리므로
//    패널이 client에서 받아 둔 데이터에 닿지 못한다. 그래서 다이얼로그를 패널이 소유한다.
//
// 부모가 알아야 하는 것은 두 가지뿐이다: "합계가 바뀌었다"(onSaved)와 "닫아 달라"(onClose).

import type { BudgetCategory, Settings } from '@/types';

export interface BudgetPlanPanelProps {
  /** "연봉 미입력" 경고가 거는 `/projects/[id]/team` 링크에 쓴다 (§7.9.2) */
  projectId: string;
  yearId: string;
  category: BudgetCategory;
  /** 패널 머리말 — 어느 셀을 보고 있는지 (연차 이름) */
  yearName: string;
  /** 패널 머리말 — BUDGET_CATEGORY_LABELS[category] */
  categoryLabel: string;
  /** 표시 단위 (§5.16). 입력은 언제나 원 단위 정수다 (절대 규칙 4) */
  currencyUnit: Settings['currencyUnit'];
  /**
   * §7.9 규칙 검증 패널의 행 단위 finding에서 열렸을 때 강조할 산출 행. 그 행이 이 셀에 없으면
   * 패널이 그 사실을 화면에 남긴다 — 판정과 목록의 시점이 다를 수 있다 (절대 규칙 5)
   */
  highlightDetailId?: string | null;
  /**
   * 행이 추가·수정·삭제·정렬되어 (연차 × 비목) 셀 합계가 바뀌었다 (PL-7·PL-10).
   * 부모는 router.refresh()로 매트릭스·지침 검증 줄을 다시 그린다.
   */
  onSaved: () => void;
  /** 저장이 도는 동안 매트릭스 조작을 잠그고 싶을 때 (선택) */
  onBusyChange?: (busy: boolean) => void;
  onClose: () => void;
}
