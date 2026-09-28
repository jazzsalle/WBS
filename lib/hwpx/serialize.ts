// 격자 정규 직렬화 (SOT §6.18 HX-8 해시, S-13).
//
// 서버가 preview에서 이 문자열을 해시해 돌려주고 commit에서 다시 해시해 대조한다. 같은 격자면 입력 객체의
// 키 순서와 무관하게 같은 문자열이어야 하므로 키를 직접 나열한다. fileName은 넣지 않는다 — 같은 표를 다른
// 이름으로 저장해 올려도 반영 결과는 같다. 해시 함수는 두지 않는다(여기는 클라이언트와 공용이라 node:crypto 불가).

import type { HwpxTable, PlanDocumentPayload } from './types';

function canonicalTable(t: HwpxTable): HwpxTable {
  return {
    index: t.index,
    section: t.section,
    rowCnt: t.rowCnt,
    colCnt: t.colCnt,
    cells: t.cells.map((row) => row.map((cell) => cell)),
  };
}

/** 해시 대상 문자열. 표·행·셀 순서는 입력 그대로 유지한다 */
export function serializePlanTables(payload: Pick<PlanDocumentPayload, 'tables'>): string {
  return JSON.stringify(payload.tables.map(canonicalTable));
}
