// hwpx 계획서 가져오기 공용 타입 (SOT §6.18 HX-1·HX-2, §9 Plan Document).
//
// 클라이언트(추출)와 서버(액션) 양쪽이 import한다 — 그래서 순수 선언만 두고 외부 import가 없다(S-33).

/** `hp:tbl` 하나를 병합 확장한 격자(HX-2, S-15). `index`는 섹션을 넘어 통산한다(S-26) */
export interface HwpxTable {
  index: number;
  section: number;
  rowCnt: number;
  colCnt: number;
  /** rowCnt × colCnt. 병합 셀은 좌상단 값이 범위 전체에 복사돼 있다 */
  cells: string[][];
}

/** 추출 결과. `rowCnt`와 실제 `hp:tr` 수가 다른 표는 자르지 않고 skipped로 알린다(HX-2) */
export interface HwpxExtractResult {
  tables: HwpxTable[];
  skipped: { index: number; section: number; reason: 'structure-mismatch' }[];
}

/** 헤더 서명으로 식별하는 표 종류(HX-3) */
export type PlanTableKind = 'tech' | 'deliverable' | 'method';

/** 서버 액션이 받는 본문 — 파일이 아니라 서명 일치 표의 격자만이다(HX-1) */
export interface PlanDocumentPayload {
  fileName: string;
  tables: HwpxTable[];
}

/** 스냅샷 source.sheetName — 설정 화면이 이 값으로 계획서 반영을 목표 양식과 따로 표시한다(U-11) */
export const PLAN_DOCUMENT_SHEET_NAME = '계획서(hwpx)';
