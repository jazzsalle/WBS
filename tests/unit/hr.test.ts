// 사내 인사 명부 연동 순수 함수 (SOT §6.13.5, HR-4·HR-5·HR-8·HR-9·HR-14·HR-16)

import { describe, expect, it } from 'vitest';
import {
  assembleDirectory,
  formatHrError,
  markSelectable,
  normalizeHrEmail,
  parseHrUsers,
  toMemberDraft,
  type HrParseResult,
  type HrUser,
} from '@/lib/hr';

/** HR-1의 8필드를 모두 갖춘 항목 */
function makeUser(overrides: Partial<HrUser> = {}): HrUser {
  return {
    user_id: 1,
    user_email: 'hong@unes.co.kr',
    user_name: '홍길동',
    user_division: '연구본부',
    user_team: '1팀',
    user_position: '선임연구원',
    user_role: 'user',
    user_is_active: true,
    ...overrides,
  };
}

function okResult(payload: unknown): Extract<HrParseResult, { ok: true }> {
  const parsed = parseHrUsers(payload);
  if (!parsed.ok) throw new Error(`parse 실패: ${parsed.reason}`);
  return parsed;
}

// ─── parseHrUsers (HR-16) ─────────────────────────────────────────────────────

describe('parseHrUsers — HR-16 응답 검증', () => {
  it('8필드 정상 응답을 rows로 옮기고 count가 맞으면 countMismatch=false', () => {
    const a = makeUser({ user_id: 1 });
    const b = makeUser({ user_id: 2, user_email: 'kim@unes.co.kr', user_name: '김철수', user_team: null });
    const parsed = okResult({ success: true, count: 2, users: [a, b] });

    expect(parsed.rows).toEqual([a, b]);
    expect(parsed.malformed).toEqual([]);
    expect(parsed.count).toBe(2);
    expect(parsed.countMismatch).toBe(false);
  });

  it('8필드 밖의 필드는 rows로 새지 않는다', () => {
    const parsed = okResult({
      success: true,
      count: 1,
      users: [{ ...makeUser(), user_salary: 99999999, user_phone: '010' }],
    });
    expect(Object.keys(parsed.rows[0]!).sort()).toEqual(
      [
        'user_division',
        'user_email',
        'user_id',
        'user_is_active',
        'user_name',
        'user_position',
        'user_role',
        'user_team',
      ].sort()
    );
  });

  it('success !== true면 실패값 — 빈 배열 폴백이 아니다', () => {
    const parsed = parseHrUsers({ success: false, count: 0, users: [] });
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.reason).toContain('success');

    // 실측 401 본문 형태(users 없음)도 같은 경로
    const errBody = parseHrUsers({
      success: false,
      code: 'INVALID_API_KEY',
      message: '유효하지 않은 API 키입니다.',
    });
    expect(errBody.ok).toBe(false);
  });

  it('users가 배열이 아니면 실패값', () => {
    expect(parseHrUsers({ success: true, count: 1, users: { 0: makeUser() } }).ok).toBe(false);
    expect(parseHrUsers({ success: true, count: 1 }).ok).toBe(false);
    expect(parseHrUsers({ success: true, count: 1, users: 'nope' }).ok).toBe(false);
  });

  it('JSON 객체가 아닌 payload도 예외 없이 실패값', () => {
    expect(parseHrUsers(null).ok).toBe(false);
    expect(parseHrUsers(undefined).ok).toBe(false);
    expect(parseHrUsers('<html>').ok).toBe(false);
    expect(parseHrUsers([makeUser()]).ok).toBe(false);
  });

  it('필드 결손 항목은 malformed에 index·사유·읽을 수 있던 name/email을 남기고 rows에서 빠진다', () => {
    const good = makeUser({ user_id: 1 });
    const { user_position: _dropped, ...missingPosition } = makeUser({
      user_id: 2,
      user_name: '박영희',
      user_email: 'park@unes.co.kr',
    });
    const parsed = okResult({ success: true, count: 2, users: [good, missingPosition] });

    expect(parsed.rows).toEqual([good]);
    expect(parsed.malformed).toHaveLength(1);
    expect(parsed.malformed[0]).toEqual({
      index: 1,
      reason: expect.stringContaining('user_position'),
      name: '박영희',
      email: 'park@unes.co.kr',
    });
    expect(parsed.malformed[0]!.reason).toContain('결손');
  });

  it('필드 타입 오류 항목도 malformed로 — user_id 문자열, user_is_active 문자열', () => {
    const bad = { ...makeUser({ user_name: '이몽룡' }), user_id: '7', user_is_active: 'true' };
    const parsed = okResult({ success: true, count: 1, users: [bad] });

    expect(parsed.rows).toEqual([]);
    expect(parsed.malformed).toHaveLength(1);
    const m = parsed.malformed[0]!;
    expect(m.index).toBe(0);
    expect(m.reason).toContain('user_id');
    expect(m.reason).toContain('user_is_active');
    expect(m.reason).toContain('타입 오류');
    expect(m.name).toBe('이몽룡');
  });

  it('user_team·user_division은 null을 허용하지만 다른 필드의 null은 타입 오류다', () => {
    const teamNull = makeUser({ user_team: null });
    const emailNull = { ...makeUser({ user_id: 2 }), user_email: null };
    const parsed = okResult({ success: true, count: 2, users: [teamNull, emailNull] });

    expect(parsed.rows).toEqual([teamNull]);
    expect(parsed.malformed[0]).toMatchObject({ index: 1, email: null, name: '홍길동' });
    expect(parsed.malformed[0]!.reason).toContain('user_email');
  });

  it('user_division이 null인 항목은 rows에 남고 malformed가 아니다 (실측 명부 1건, HR-6 표시 전용)', () => {
    const divisionNull = makeUser({ user_division: null });
    const parsed = okResult({ success: true, count: 1, users: [divisionNull] });

    expect(parsed.rows).toEqual([divisionNull]);
    expect(parsed.malformed).toEqual([]);
    expect(markSelectable(parsed.rows, [])[0]).toMatchObject({ kind: 'user', selectable: true });
  });

  it('객체가 아닌 항목(null·문자열)은 name/email 없이 malformed로 남는다', () => {
    const parsed = okResult({ success: true, count: 3, users: [null, 'x', makeUser()] });
    expect(parsed.rows).toHaveLength(1);
    expect(parsed.malformed.map((m) => m.index)).toEqual([0, 1]);
    expect(parsed.malformed[0]).toMatchObject({ name: null, email: null });
  });

  it('count가 users.length와 다르면 countMismatch=true (malformed 포함 길이 기준)', () => {
    const { user_role: _r, ...broken } = makeUser({ user_id: 2 });
    const parsed = okResult({ success: true, count: 5, users: [makeUser(), broken] });
    expect(parsed.count).toBe(5);
    expect(parsed.countMismatch).toBe(true);

    // malformed 항목도 응답의 한 행이다. count=2면 일치
    expect(okResult({ success: true, count: 2, users: [makeUser(), broken] }).countMismatch).toBe(
      false
    );
  });

  it('count가 number가 아니면 count:null·countMismatch=true', () => {
    for (const count of [undefined, '2', null]) {
      const parsed = okResult({ success: true, count, users: [makeUser(), makeUser({ user_id: 2 })] });
      expect(parsed.count).toBeNull();
      expect(parsed.countMismatch).toBe(true);
      expect(parsed.rows).toHaveLength(2);
    }
  });
});

// ─── toMemberDraft (HR-4) ─────────────────────────────────────────────────────

describe('toMemberDraft — HR-4 채우는 필드는 3개뿐', () => {
  it("키 집합이 정확히 ['name','position','email']이다", () => {
    const draft = toMemberDraft(makeUser());
    expect(Object.keys(draft).sort()).toEqual(['email', 'name', 'position']);
  });

  it('값은 trim한다', () => {
    const draft = toMemberDraft(
      makeUser({ user_name: '  홍길동 ', user_position: ' 선임연구원\t', user_email: ' Hong@unes.co.kr ' })
    );
    expect(draft).toEqual({ name: '홍길동', position: '선임연구원', email: 'Hong@unes.co.kr' });
  });

  it('annualSalary·hireType·field·phone·orgId·role·active가 어떤 이름으로도 들어오지 않는다', () => {
    const draft = toMemberDraft(makeUser({ user_is_active: false, user_role: 'admin' }));
    for (const forbidden of ['annualSalary', 'hireType', 'field', 'phone', 'orgId', 'role', 'active', 'user_id']) {
      expect(draft).not.toHaveProperty(forbidden);
    }
  });
});

// ─── markSelectable (HR-8·HR-9·HR-5) ─────────────────────────────────────────

describe('normalizeHrEmail', () => {
  it('trim + 소문자', () => {
    expect(normalizeHrEmail('  Hong@UNES.co.kr ')).toBe('hong@unes.co.kr');
    expect(normalizeHrEmail('   ')).toBe('');
  });
});

describe('markSelectable — HR-8·HR-9·HR-5', () => {
  it('기존 Member와 대소문자·공백만 다른 같은 이메일 → already-registered, 선택 불가', () => {
    const rows = [makeUser({ user_email: '  HONG@Unes.co.kr ' })];
    const [entry] = markSelectable(rows, [{ email: 'hong@unes.co.kr' }]);
    expect(entry).toMatchObject({
      kind: 'user',
      selectable: false,
      blockReason: 'already-registered',
      retired: false,
    });
  });

  it('기존 Member 쪽 이메일의 대소문자·공백도 정규화한다', () => {
    const [entry] = markSelectable([makeUser({ user_email: 'hong@unes.co.kr' })], [
      { email: ' Hong@UNES.CO.KR ' },
    ]);
    expect(entry).toMatchObject({ selectable: false, blockReason: 'already-registered' });
  });

  it('빈 문자열·공백 이메일 → no-email, 선택 불가', () => {
    const entries = markSelectable(
      [makeUser({ user_email: '' }), makeUser({ user_id: 2, user_email: '   ' })],
      []
    );
    for (const entry of entries) {
      expect(entry).toMatchObject({ kind: 'user', selectable: false, blockReason: 'no-email' });
    }
  });

  it('이메일이 빈 Member가 있어도 빈 이메일 HR 계정은 no-email이다 (already-registered가 아니다)', () => {
    const [entry] = markSelectable([makeUser({ user_email: '' })], [{ email: '' }]);
    expect(entry).toMatchObject({ blockReason: 'no-email' });
  });

  it('퇴사자(user_is_active=false) → retired=true이되 selectable=true (HR-5)', () => {
    const [entry] = markSelectable([makeUser({ user_is_active: false })], []);
    expect(entry).toMatchObject({ kind: 'user', retired: true, selectable: true, blockReason: null });
  });

  it('퇴사 + 이미 등록됨은 둘 다 표시된다', () => {
    const [entry] = markSelectable([makeUser({ user_is_active: false })], [{ email: 'hong@unes.co.kr' }]);
    expect(entry).toMatchObject({ retired: true, selectable: false, blockReason: 'already-registered' });
  });

  it('정상 계정은 selectable=true, draft가 함께 붙는다', () => {
    const user = makeUser({ user_email: 'new@unes.co.kr ' });
    const [entry] = markSelectable([user], [{ email: 'hong@unes.co.kr' }]);
    expect(entry).toEqual({
      kind: 'user',
      user,
      draft: { name: '홍길동', position: '선임연구원', email: 'new@unes.co.kr' },
      selectable: true,
      blockReason: null,
      retired: false,
    });
  });

  it('순서를 보존한다', () => {
    const rows = [3, 1, 2].map((id) => makeUser({ user_id: id, user_email: `u${id}@unes.co.kr` }));
    const entries = markSelectable(rows, []);
    expect(entries.map((e) => (e.kind === 'user' ? e.user.user_id : -1))).toEqual([3, 1, 2]);
  });
});

// ─── assembleDirectory ────────────────────────────────────────────────────────

describe('assembleDirectory — unreadable을 원 위치에 끼운다', () => {
  it('malformed 항목이 응답의 index 자리에 놓이고 rowCount = rows + malformed', () => {
    const u0 = makeUser({ user_id: 10, user_email: 'a@unes.co.kr' });
    const { user_role: _r, ...broken1 } = makeUser({ user_id: 11, user_name: '깨진사람', user_email: 'b@unes.co.kr' });
    const u2 = makeUser({ user_id: 12, user_email: 'c@unes.co.kr' });
    const u4 = makeUser({ user_id: 14, user_email: 'e@unes.co.kr' });

    const parsed = okResult({ success: true, count: 5, users: [u0, broken1, u2, null, u4] });
    const dir = assembleDirectory(parsed, [{ email: 'C@unes.co.kr' }]);

    expect(dir.rowCount).toBe(5);
    expect(dir.count).toBe(5);
    expect(dir.countMismatch).toBe(false);
    expect(dir.entries.map((e) => e.kind)).toEqual(['user', 'unreadable', 'user', 'unreadable', 'user']);

    expect(dir.entries[1]).toEqual({
      kind: 'unreadable',
      index: 1,
      reason: expect.stringContaining('user_role'),
      name: '깨진사람',
      email: 'b@unes.co.kr',
    });
    expect(dir.entries[3]).toMatchObject({ kind: 'unreadable', index: 3, name: null, email: null });

    // 사용자 항목은 markSelectable 결과 그대로
    expect(dir.entries[0]).toMatchObject({ kind: 'user', user: u0, selectable: true });
    expect(dir.entries[2]).toMatchObject({ kind: 'user', user: u2, selectable: false, blockReason: 'already-registered' });
    expect(dir.entries[4]).toMatchObject({ kind: 'user', user: u4, selectable: true });
  });

  it('count 불일치가 그대로 전달된다', () => {
    const parsed = okResult({ success: true, count: 9, users: [makeUser()] });
    const dir = assembleDirectory(parsed, []);
    expect(dir).toMatchObject({ rowCount: 1, count: 9, countMismatch: true });
  });

  it('malformed만 있어도 목록에 남는다 — 조용히 비지 않는다', () => {
    const parsed = okResult({ success: true, count: 1, users: [{}] });
    const dir = assembleDirectory(parsed, []);
    expect(dir.entries).toHaveLength(1);
    expect(dir.entries[0]!.kind).toBe('unreadable');
  });
});

// ─── formatHrError (HR-14) ────────────────────────────────────────────────────

describe('formatHrError — HR-14 사람 말로 옮긴다', () => {
  it('401: 키가 틀렸거나 폐기됨', () => {
    expect(formatHrError(401, null)).toMatch(/키.*(틀렸|폐기)/);
  });

  it('403: 계정 비활성 또는 허용 IP가 아님 (EXTERNAL_ALLOWED_IPS)', () => {
    const text = formatHrError(403, null);
    expect(text).toContain('허용 IP');
    expect(text).toContain('비활성');
    expect(text).toContain('EXTERNAL_ALLOWED_IPS');
  });

  it('429: 15분당 300회 초과, 다시 시도 안내 (자동 재시도 없음)', () => {
    const text = formatHrError(429, null);
    expect(text).toContain('15분');
    expect(text).toContain('300');
    expect(text).toContain('다시 시도');
  });

  it('500·503: HR 서버 문제', () => {
    expect(formatHrError(500, null)).toContain('HR 서버 문제');
    expect(formatHrError(503, null)).toContain('HR 서버 문제');
    expect(formatHrError(503, null)).toContain('503');
  });

  it('null: 네트워크 실패/타임아웃', () => {
    const text = formatHrError(null, null);
    expect(text).toMatch(/연결하지 못했/);
    expect(text).toMatch(/네트워크|시간 초과/);
  });

  it('그 외 상태는 일반 문구에 코드가 실린다', () => {
    expect(formatHrError(418, null)).toContain('418');
  });

  it('본문의 code와 message가 둘 다 문장에 들어간다 (실측 401 본문)', () => {
    const text = formatHrError(401, {
      success: false,
      code: 'INVALID_API_KEY',
      message: '유효하지 않은 API 키입니다.',
    });
    expect(text).toContain('INVALID_API_KEY');
    expect(text).toContain('유효하지 않은 API 키입니다.');
    expect(text).toMatch(/틀렸|폐기/);
  });

  it('code만·message만 있어도 있는 쪽은 들어간다', () => {
    expect(formatHrError(429, { code: 'RATE_LIMITED' })).toContain('RATE_LIMITED');
    expect(formatHrError(500, { message: '서버 오류' })).toContain('서버 오류');
  });

  it('body가 JSON 객체가 아니어도 죽지 않는다', () => {
    for (const body of [null, undefined, '<html>Bad Gateway</html>', 42, ['x'], { code: 1, message: null }]) {
      expect(() => formatHrError(502, body)).not.toThrow();
      expect(formatHrError(502, body)).toContain('502');
    }
  });
});
