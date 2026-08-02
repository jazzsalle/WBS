// 날짜 유틸과 Task·Milestone 마감 판정 (SOT §6.5)
// 기준일은 항상 호출자가 넘긴다 — 내부에서 new Date()를 부르면 테스트가
// 실행 시각에 따라 흔들린다.

import type { Milestone, Task } from '@/types';

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
//
// 이건 "사용자가 고른 Date(달력 위젯 등)를 문자열로 바꿀 때"만 쓴다.
// 마감·임박 판정의 기준일은 실행 주체(UTC일 수 있는 Next 사이드카 vs 사용자 PC)에
// 따라 달라지면 안 되므로 반드시 todayISO()를 쓴다.
export function toISODate(d: Date): string {
  return pad(d.getFullYear(), 4) + '-' + pad(d.getMonth() + 1, 2) + '-' + pad(d.getDate(), 2);
}

// 앱 전체의 기준 타임존. 서버 OS 타임존이나 PC 설정과 무관하게 이 달력으로 "오늘"을 정한다.
export const APP_TIME_ZONE = 'Asia/Seoul';

// Intl.DateTimeFormat 생성은 비싸다 — 타임존별로 한 번만 만든다.
const formatterCache = new Map<string, Intl.DateTimeFormat>();

function dateFormatter(timeZone: string): Intl.DateTimeFormat {
  const cached = formatterCache.get(timeZone);
  if (cached !== undefined) return cached;
  // 존재하지 않는 타임존이면 Intl이 RangeError를 던진다 — 조용히 UTC로 넘기지 않는다.
  const created = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  formatterCache.set(timeZone, created);
  return created;
}

// 주어진 순간(instant)을 지정 타임존의 달력 날짜 'YYYY-MM-DD'로 옮긴다.
// toLocaleDateString의 문자열 포맷은 로케일·런타임에 따라 달라지므로 formatToParts로 직접 조립한다.
export function toISODateInTimeZone(d: Date, timeZone: string): string {
  if (Number.isNaN(d.getTime())) {
    throw new RangeError('유효하지 않은 Date입니다.');
  }
  const parts = dateFormatter(timeZone).formatToParts(d);
  const year = parts.find((p) => p.type === 'year')?.value;
  const month = parts.find((p) => p.type === 'month')?.value;
  const day = parts.find((p) => p.type === 'day')?.value;
  if (year === undefined || month === undefined || day === undefined) {
    throw new RangeError(`타임존 '${timeZone}'의 날짜를 읽지 못했습니다.`);
  }
  return `${pad(Number(year), 4)}-${month}-${day}`;
}

// 마감·임박 판정의 기준일(§6.5). now를 필수로 받는 이유는 두 가지다.
// ① 내부 new Date()는 테스트를 실행 시각에 의존하게 만든다.
// ② 같은 순간에 대해 서버·클라이언트가 같은 문자열을 얻어야 한다 —
//    클라이언트 컴포넌트는 오늘을 직접 만들지 말고 서버가 내려준 prop을 쓴다.
export function todayISO(now: Date): string {
  return toISODateInTimeZone(now, APP_TIME_ZONE);
}

// 'YYYY-MM-DD'에 n일을 더한다(음수면 뺀다). 달력일 기준이라 DST·월말 영향이 없다.
export function addDays(iso: string, n: number): string {
  if (!Number.isInteger(n)) {
    throw new RangeError(`더할 일수는 정수여야 합니다: ${n}`);
  }
  return toISODateUTC(toUTCMidnight(iso) + n * DAY_MS);
}

// D-day 표기. 오늘이면 'D-DAY', 미래 n일이면 'D-n', 지난 n일이면 'D+n'.
export function formatDday(todayISO: string, dateISO: string): string {
  const d = daysBetween(todayISO, dateISO);
  if (d === 0) return 'D-DAY';
  return d > 0 ? `D-${d}` : `D+${-d}`;
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

// §6.5: Milestone은 done·cancelled면 날짜와 무관하게 판정 대상이 아니다.
// preparing·delayed는 아직 끝나지 않은 일이므로 대상에 남는다.
const MILESTONE_CLOSED_STATUSES: ReadonlySet<Milestone['status']> = new Set(['done', 'cancelled']);

// §6.5: date < today AND status ∉ {done, cancelled}
export function isOverdueMilestone(
  milestone: Pick<Milestone, 'date' | 'status'>,
  todayISO: string
): boolean {
  if (MILESTONE_CLOSED_STATUSES.has(milestone.status)) return false;
  return daysBetween(todayISO, milestone.date) < 0;
}

// §6.5: 0 ≤ date - today ≤ milestoneAlertDays AND status ∉ {done, cancelled}
export function isUpcomingMilestone(
  milestone: Pick<Milestone, 'date' | 'status'>,
  todayISO: string,
  milestoneAlertDays: number
): boolean {
  if (MILESTONE_CLOSED_STATUSES.has(milestone.status)) return false;
  const d = daysBetween(todayISO, milestone.date);
  return d >= 0 && d <= milestoneAlertDays;
}
