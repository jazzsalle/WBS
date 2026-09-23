// 사내 인사 명부 연동 — 순수 함수 (SOT §6.13, §6.13.5)
//
// 여기는 **fetch를 하지 않는다.** `lib/import/`·`lib/export/`와 같은 경계다: 네트워크는
// 서버 액션(actions/team.ts)의 몫이고, 이 모듈은 HR 응답을 우리 모양으로 옮기고
// 무엇을 고를 수 있는지 판정하는 부분만 갖는다. 그래야 응답 검증(HR-16)과 선택 가능
// 판정(HR-8·HR-9)을 HR 서버 없이 단위 테스트로 고정할 수 있다.
//
// 이 모듈이 만드는 것은 `HrMemberDraft` = name·position·email 3개뿐이다(HR-4).
// `annualSalary`(HR-2)·`active`(HR-5)·`orgId`(HR-6)·`user_id`(HR-9)는 어떤 경로로도
// 채우지 않는다 — 키 집합은 tests/unit/hr.test.ts가 Object.keys로 고정한다.
//
// 단위 테스트: tests/unit/hr.test.ts · 경계 검사: tests/unit/hr-boundary.test.ts

import type { Member } from '@/types';

// ─── 타입 ─────────────────────────────────────────────────────────────────────

/** HR-1: `GET /api/external/users`의 `users[]` 항목. 필드는 이 8개뿐이다 */
export interface HrUser {
  user_id: number;
  user_email: string;
  user_name: string;
  /** 문서는 string이지만 실측 명부에 null 1건이 있다(HR-1). 표시 전용(HR-6)이라 null로 막지 않는다 */
  user_division: string | null;
  user_team: string | null;
  user_position: string;
  user_role: string;
  user_is_active: boolean;
}

/**
 * HR-16: 필드가 빠지거나 타입이 다른 항목. 버리지 않고 남긴다 — 조용히 사라지면
 * 명부에 있는 사람이 왜 안 보이는지 알 수 없다. 읽을 수 있던 name/email은 화면에서
 * "누구의 항목이 깨졌는지"를 보여 주기 위해 함께 둔다.
 */
export interface HrMalformed {
  index: number;
  reason: string;
  name: string | null;
  email: string | null;
}

/** HR-4: Member로 옮길 값. 정확히 이 3키다 */
export interface HrMemberDraft {
  name: string;
  position: string;
  email: string;
}

export type HrBlockReason = 'already-registered' | 'no-email';

export type HrDirectoryEntry =
  | {
      kind: 'user';
      user: HrUser;
      draft: HrMemberDraft;
      selectable: boolean;
      blockReason: HrBlockReason | null;
      /** HR-5: 퇴사 **표시**만. 선택 가능 여부에 영향을 주지 않는다 */
      retired: boolean;
    }
  | { kind: 'unreadable'; index: number; reason: string; name: string | null; email: string | null };

export type HrParseResult =
  | {
      ok: true;
      rows: HrUser[];
      malformed: HrMalformed[];
      /** 응답의 `count`. number가 아니면 null */
      count: number | null;
      /** HR-16: 페이징이 없으므로 count ≠ users.length는 무언가 잘못된 것이다 */
      countMismatch: boolean;
    }
  | { ok: false; reason: string };

/** 서버 액션 `fetchHrDirectory`의 반환형. 모달이 닫히면 버린다(HR-17) */
export interface HrDirectory {
  entries: HrDirectoryEntry[];
  count: number | null;
  /** rows + malformed — 응답의 `count`와 비교할 실제 행 수 */
  rowCount: number;
  countMismatch: boolean;
}

// ─── 응답 검증 (HR-16) ────────────────────────────────────────────────────────

type FieldCheck = (value: unknown) => boolean;

const isString: FieldCheck = (v) => typeof v === 'string';
const isStringOrNull: FieldCheck = (v) => v === null || typeof v === 'string';

/** HR-1의 8필드. 이 표 밖의 필드는 보지 않는다 — 있어도 무시하고, 없어도 문제 삼지 않는다 */
const HR_USER_FIELDS: ReadonlyArray<[keyof HrUser, FieldCheck]> = [
  ['user_id', (v) => typeof v === 'number' && Number.isFinite(v)],
  ['user_email', isString],
  ['user_name', isString],
  ['user_division', isStringOrNull],
  ['user_team', isStringOrNull],
  ['user_position', isString],
  ['user_role', isString],
  ['user_is_active', (v) => typeof v === 'boolean'],
];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readString(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

/**
 * HR-16: `success !== true`이거나 `users`가 배열이 아니면 실패값을 돌려준다.
 * 예외를 던지지 않고 빈 배열로 폴백하지도 않는다(절대 규칙 5).
 */
export function parseHrUsers(payload: unknown): HrParseResult {
  if (!isRecord(payload)) {
    return { ok: false, reason: 'HR 응답이 JSON 객체가 아닙니다.' };
  }
  if (payload.success !== true) {
    return { ok: false, reason: 'HR 응답의 success가 true가 아닙니다.' };
  }
  const users = payload.users;
  if (!Array.isArray(users)) {
    return { ok: false, reason: 'HR 응답의 users가 배열이 아닙니다.' };
  }

  const rows: HrUser[] = [];
  const malformed: HrMalformed[] = [];

  users.forEach((item: unknown, index) => {
    if (!isRecord(item)) {
      malformed.push({ index, reason: '항목이 객체가 아닙니다.', name: null, email: null });
      return;
    }
    const problems = HR_USER_FIELDS.filter(([field, check]) => !check(item[field])).map(
      ([field]) => `${field} ${item[field] === undefined ? '결손' : '타입 오류'}`
    );
    if (problems.length > 0) {
      malformed.push({
        index,
        reason: problems.join(', '),
        name: readString(item.user_name),
        email: readString(item.user_email),
      });
      return;
    }
    // 8필드만 옮긴다. 응답에 다른 필드가 섞여 와도 우리 쪽으로 새지 않는다
    rows.push({
      user_id: item.user_id as number,
      user_email: item.user_email as string,
      user_name: item.user_name as string,
      user_division: item.user_division as string | null,
      user_team: item.user_team as string | null,
      user_position: item.user_position as string,
      user_role: item.user_role as string,
      user_is_active: item.user_is_active as boolean,
    });
  });

  const count = typeof payload.count === 'number' ? payload.count : null;
  return {
    ok: true,
    rows,
    malformed,
    count,
    countMismatch: count === null || count !== users.length,
  };
}

// ─── Member 초안 (HR-4) ───────────────────────────────────────────────────────

/** HR-4: name·position·email만. 다른 키를 여기서 늘리면 hr.test.ts의 키 집합 고정이 깨진다 */
export function toMemberDraft(user: HrUser): HrMemberDraft {
  return {
    name: user.user_name.trim(),
    position: user.user_position.trim(),
    email: user.user_email.trim(),
  };
}

// ─── 선택 가능 판정 (HR-8·HR-9) ──────────────────────────────────────────────

/**
 * HR-9 매칭 키 정규화. 서버 액션(createMembersFromHr)의 중복 거부도 이 함수를 써야
 * "모달에서는 이미 등록됨인데 저장은 된다" 같은 어긋남이 생기지 않는다.
 */
export function normalizeHrEmail(email: string): string {
  return email.trim().toLowerCase();
}

/**
 * HR-8: 같은 이메일의 Member가 이미 있으면 선택 불가. HR-9: 이메일이 비면 선택 불가.
 * HR-5: 퇴사(`user_is_active === false`)는 표시만 하고 선택은 막지 않는다.
 */
export function markSelectable(
  rows: readonly HrUser[],
  existingMembers: readonly Pick<Member, 'email'>[]
): HrDirectoryEntry[] {
  const registered = new Set(
    existingMembers.map((m) => normalizeHrEmail(m.email)).filter((e) => e.length > 0)
  );
  return rows.map((user) => {
    const email = normalizeHrEmail(user.user_email);
    let blockReason: HrBlockReason | null = null;
    if (email.length === 0) blockReason = 'no-email';
    else if (registered.has(email)) blockReason = 'already-registered';
    return {
      kind: 'user',
      user,
      draft: toMemberDraft(user),
      selectable: blockReason === null,
      blockReason,
      retired: user.user_is_active === false,
    };
  });
}

/**
 * 파싱 결과와 기존 Member로 모달이 그릴 목록을 만든다. 읽을 수 없는 항목은 원래
 * 자리(응답의 index)에 끼워 넣는다 — 명부 순서가 그대로여야 "저 사람이 왜 안 보이지"를
 * 사람이 응답과 대조할 수 있다(HR-16).
 */
export function assembleDirectory(
  parsed: Extract<HrParseResult, { ok: true }>,
  existingMembers: readonly Pick<Member, 'email'>[]
): HrDirectory {
  const users = markSelectable(parsed.rows, existingMembers);
  const malformed = [...parsed.malformed].sort((a, b) => a.index - b.index);
  const rowCount = parsed.rows.length + parsed.malformed.length;

  const entries: HrDirectoryEntry[] = [];
  let userCursor = 0;
  let malformedCursor = 0;
  for (let index = 0; index < rowCount; index++) {
    const next = malformed[malformedCursor];
    if (next !== undefined && next.index === index) {
      entries.push({ kind: 'unreadable', ...next });
      malformedCursor++;
    } else {
      const entry = users[userCursor++];
      if (entry === undefined) {
        // index가 rowCount 밖이거나 겹치면 여기로 온다 — parseHrUsers가 만든 결과라면 불가능하다
        throw new Error(`HR 명부 조립 실패: index ${index}에 대응하는 항목이 없습니다.`);
      }
      entries.push(entry);
    }
  }

  return { entries, count: parsed.count, rowCount, countMismatch: parsed.countMismatch };
}

// ─── 오류 문장 (HR-14) ────────────────────────────────────────────────────────

/**
 * HR-14: 상태 코드를 사람 말로 옮기고 본문의 `code`·`message`를 **함께** 붙인다.
 * `status === null`은 네트워크 실패·타임아웃. body는 JSON이 아닐 수도 있다(HTML 오류
 * 페이지 등) — 그때는 본문 없이 상태 문장만 낸다.
 */
export function formatHrError(status: number | null, body: unknown): string {
  let base: string;
  if (status === null) {
    base = 'HR 서버에 연결하지 못했습니다 (네트워크 오류 또는 시간 초과).';
  } else if (status === 401) {
    base = 'HR API 키가 틀렸거나 폐기되었습니다. 설정에서 키를 다시 등록하세요.';
  } else if (status === 403) {
    base =
      'HR 계정이 비활성이거나 이 PC가 허용 IP가 아닙니다 (HR 서버의 EXTERNAL_ALLOWED_IPS 설정).';
  } else if (status === 429) {
    // HR-15: 자동 재시도는 하지 않는다. 사람에게 알리고 멈춘다
    base = 'HR 호출 한도(15분당 300회)를 초과했습니다. 잠시 후 다시 시도하세요.';
  } else if (status === 500 || status === 503) {
    base = `HR 서버 문제입니다 (HTTP ${status}). 잠시 후 다시 시도하거나 HR 담당자에게 알리세요.`;
  } else {
    base = `HR 요청이 실패했습니다 (HTTP ${status}).`;
  }

  if (!isRecord(body)) return base;
  const code = readString(body.code);
  const message = readString(body.message);
  const detail = [code, message].filter((s): s is string => s !== null && s.length > 0);
  return detail.length === 0 ? base : `${base} HR 응답: ${detail.join(' — ')}`;
}
