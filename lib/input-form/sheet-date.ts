// 엑셀 날짜 셀 읽기 — 양식 파서 공용 (SOT 부록 F-6, §6.17 GF-6).
//
// 공용 `readWorkbook`이 `cellDates: false`라 날짜 셀은 직렬값 숫자로 온다. 양식마다 날짜를 따로 읽으면
// 같은 셀이 양식에 따라 다르게 해석되므로 한 곳에 둔다. 다른 표기를 추측해 살리지 않는다.
// xlsx·exceljs를 import하지 않는다(IN-8).

import { cellText } from '@/lib/import/grid';
import type { RawCell } from '@/lib/import/types';

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const DAY_MS = 24 * 60 * 60 * 1000;
// 엑셀 1900 체계의 직렬값 0일. 60 = 1900-02-29는 로터스 호환으로 들어간 **없는 날**이라
// 61부터는 1899-12-30을, 1~59는 1899-12-31을 기준으로 센다
const SERIAL_EPOCH_FROM_61 = Date.UTC(1899, 11, 30);
const SERIAL_EPOCH_BELOW_60 = Date.UTC(1899, 11, 31);
const FAKE_LEAP_DAY_SERIAL = 60;
/** 9999-12-31. 엑셀이 날짜로 표시할 수 있는 마지막 직렬값 */
const MAX_DATE_SERIAL = 2_958_465;

function pad(n: number, width: number): string {
  return String(n).padStart(width, '0');
}

function isoOfUTC(epochMs: number): string {
  const d = new Date(epochMs);
  return `${pad(d.getUTCFullYear(), 4)}-${pad(d.getUTCMonth() + 1, 2)}-${pad(d.getUTCDate(), 2)}`;
}

/**
 * 엑셀 직렬값(1900 체계) → ISO `yyyy-mm-dd`.
 * 시각이 섞인 소수 직렬값은 날짜 열의 값이 아니다 — 잘라 내 하루를 정하지 않고 null이다. 없는 날(60)도 null.
 * UTC 산술만 쓴다 — 로컬 시간대를 거치면 자정 근처에서 하루가 밀린다.
 */
export function excelSerialToISO(serial: number): string | null {
  if (!Number.isInteger(serial) || serial < 1 || serial > MAX_DATE_SERIAL) return null;
  if (serial === FAKE_LEAP_DAY_SERIAL) return null;
  const epoch = serial > FAKE_LEAP_DAY_SERIAL ? SERIAL_EPOCH_FROM_61 : SERIAL_EPOCH_BELOW_60;
  return isoOfUTC(epoch + serial * DAY_MS);
}

/** `yyyy-mm-dd` 문자열 → 같은 문자열. 2026-02-30처럼 달력에 없는 날은 null */
function validIsoDate(text: string): string | null {
  const match = ISO_DATE.exec(text);
  if (match === null) return null;
  const epoch = Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  // Date.UTC는 없는 날을 다음 달로 넘기고 두 자리 연도를 1900년대로 읽는다 — 되돌려 비교해 잡는다
  return isoOfUTC(epoch) === text ? text : null;
}

export type DateRead = { kind: 'empty' } | { kind: 'invalid'; text: string } | { kind: 'value'; iso: string };

/** 날짜 셀. 숫자는 직렬값, 문자열은 `yyyy-mm-dd`만 받는다 — 다른 표기를 추측해 살리지 않는다 */
export function readSheetDate(cell: RawCell): DateRead {
  const text = cellText(cell);
  if (text === '') return { kind: 'empty' };
  if (cell.isError) return { kind: 'invalid', text };
  const iso = typeof cell.value === 'number' ? excelSerialToISO(cell.value) : validIsoDate(text);
  return iso === null ? { kind: 'invalid', text } : { kind: 'value', iso };
}
