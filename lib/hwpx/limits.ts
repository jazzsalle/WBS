// 계획서 격자 페이로드 상한 (SOT §6.18 HX-1, §9 Plan Document, S-14).
//
// 서버 액션 본문 기본 한도(1MB) 안에 들게 하려는 값이다. 클라이언트는 보내기 전에, 서버는 받은 뒤에 같은
// 함수로 검사한다 — 상한이 두 곳에 따로 적히면 한쪽만 바뀌어 "클라이언트는 통과, 서버는 거부"가 생긴다.

import { serializePlanTables } from './serialize';
import type { PlanDocumentPayload } from './types';

export const PLAN_PAYLOAD_MAX_BYTES = 800_000;
export const PLAN_PAYLOAD_MAX_TABLES = 20;
export const PLAN_TABLE_MAX_ROWS = 300;
export const PLAN_TABLE_MAX_COLS = 40;
export const PLAN_CELL_MAX_CHARS = 20_000;

const TOO_LARGE = '표만 추출해도 너무 큽니다';

export type PlanPayloadCheck = { ok: true } | { ok: false; reason: string };

/**
 * UTF-8 바이트 길이. TextEncoder에 기대지 않는다 — 이 모듈은 브라우저·Node 공용 순수 함수여야 한다(S-33).
 * 짝 없는 서로게이트는 TextEncoder처럼 U+FFFD(3바이트)로 센다.
 */
export function utf8ByteLength(s: string): number {
  let bytes = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 0x80) bytes += 1;
    else if (c < 0x800) bytes += 2;
    else if (c >= 0xd800 && c <= 0xdbff) {
      const next = i + 1 < s.length ? s.charCodeAt(i + 1) : 0;
      if (next >= 0xdc00 && next <= 0xdfff) {
        bytes += 4;
        i++;
      } else bytes += 3;
    } else bytes += 3;
  }
  return bytes;
}

function isCount(n: unknown): n is number {
  return typeof n === 'number' && Number.isInteger(n) && n >= 0;
}

/** 상한·모양 검사. 던지지 않는다 — 호출자가 reason을 그대로 사용자에게 보여 준다 */
export function checkPlanPayload(payload: PlanDocumentPayload): PlanPayloadCheck {
  const { tables } = payload;
  if (tables.length > PLAN_PAYLOAD_MAX_TABLES) {
    return { ok: false, reason: `${TOO_LARGE} — 표가 ${tables.length}개입니다(최대 ${PLAN_PAYLOAD_MAX_TABLES}개).` };
  }
  for (const t of tables) {
    const where = `표 ${t.index + 1}`;
    if (!isCount(t.rowCnt) || !isCount(t.colCnt)) {
      return { ok: false, reason: `${where}의 행·열 수가 올바르지 않습니다.` };
    }
    if (t.rowCnt > PLAN_TABLE_MAX_ROWS) {
      return { ok: false, reason: `${TOO_LARGE} — ${where}이 ${t.rowCnt}행입니다(최대 ${PLAN_TABLE_MAX_ROWS}행).` };
    }
    if (t.colCnt > PLAN_TABLE_MAX_COLS) {
      return { ok: false, reason: `${TOO_LARGE} — ${where}이 ${t.colCnt}열입니다(최대 ${PLAN_TABLE_MAX_COLS}열).` };
    }
    // 모양이 어긋난 격자를 받아들이면 행 해석이 열을 잘못 읽는다 — 조용히 자르지 않는다(HX-2)
    if (t.cells.length !== t.rowCnt || t.cells.some((row) => row.length !== t.colCnt)) {
      return { ok: false, reason: `${where}의 격자가 ${t.rowCnt}행 × ${t.colCnt}열과 맞지 않습니다.` };
    }
    for (const [r, row] of t.cells.entries()) {
      for (const [c, cell] of row.entries()) {
        const len = cell.length;
        if (len > PLAN_CELL_MAX_CHARS) {
          return {
            ok: false,
            reason: `${TOO_LARGE} — ${where} ${r + 1}행 ${c + 1}열 셀이 ${len}자입니다(최대 ${PLAN_CELL_MAX_CHARS}자).`,
          };
        }
      }
    }
  }
  const bytes = utf8ByteLength(serializePlanTables(payload));
  if (bytes > PLAN_PAYLOAD_MAX_BYTES) {
    return { ok: false, reason: `${TOO_LARGE} — ${bytes}바이트입니다(최대 ${PLAN_PAYLOAD_MAX_BYTES}바이트).` };
  }
  return { ok: true };
}
