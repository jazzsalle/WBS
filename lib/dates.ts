// 날짜 유틸과 Task 마감 판정 (SOT §6.5)
// 기준일은 항상 호출자가 넘긴다 — 내부에서 new Date()를 부르면 테스트가
// 실행 시각에 따라 흔들린다.

import type { Task } from '@/types';

const DAY_MS = 24 * 60 * 60 * 1000;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

// 'YYYY-MM-DD'를 UTC 자정 epoch로 읽는다. 날짜 문자열끼리의 차이만 필요하므로
// UTC로 고정하면 DST 전환일(23·25시간)에도 달력일 차이가 정수로 떨어진다.
function toUTCMidnight(iso: string): number {
  if (!ISO_DATE.test(iso)) {
    throw new RangeError(`날짜 형식이 'YYYY-MM-DD'가 아닙니다: ${iso}`);
  }
  const t = Date.UTC(
    Number(iso.slice(0, 4)),
    Number(iso.slice(5, 7)) - 1,
    Number(iso.slice(8, 10))
  );
  // Date.UTC는 2026-02-30 같은 값을 조용히 넘겨버린다 — 되돌려 비교해 잡는다
  if (toISODateUTC(t) !== iso) {
    throw new RangeError(`존재하지 않는 날짜입니다: ${iso}`);
  }
  return t;
}

function toISODateUTC(epochMs: number): string {
  const d = new Date(epochMs);
  return pad(d.getUTCFullYear(), 4) + '-' + pad(d.getUTCMonth() + 1, 2) + '-' + pad(d.getUTCDate(), 2);
}

function pad(n: number, width: number): string {
  return String(n).padStart(width, '0');
}

// 로컬 타임존 기준 'YYYY-MM-DD'. Date의 toISOString()은 UTC로 밀려
// 한국 시간 오전 9시 이전에 하루 전 날짜를 내놓으므로 쓰지 않는다.
export function toISODate(d: Date): string {
  return pad(d.getFullYear(), 4) + '-' + pad(d.getMonth() + 1, 2) + '-' + pad(d.getDate(), 2);
}

// from → to 달력일 차이. to가 미래면 양수, 과거면 음수.
export function daysBetween(fromISO: string, toISO: string): number {
  return (toUTCMidnight(toISO) - toUTCMidnight(fromISO)) / DAY_MS;
}

// §6.5: dueDate < today AND status != 'done'
export function isOverdueTask(
  task: Pick<Task, 'dueDate' | 'status'>,
  todayISO: string
): boolean {
  if (task.dueDate === null) return false;
  if (task.status === 'done') return false;
  return daysBetween(todayISO, task.dueDate) < 0;
}

// §6.5: 0 ≤ dueDate - today ≤ dueSoonDays AND status != 'done'
export function isDueSoonTask(
  task: Pick<Task, 'dueDate' | 'status'>,
  todayISO: string,
  dueSoonDays: number
): boolean {
  if (task.dueDate === null) return false;
  if (task.status === 'done') return false;
  const d = daysBetween(todayISO, task.dueDate);
  return d >= 0 && d <= dueSoonDays;
}
