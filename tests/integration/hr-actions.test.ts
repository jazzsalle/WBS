// 사내 명부 연동 서버 액션 통합 테스트 (SOT §6.13, §9 fetchHrDirectory·createMembersFromHr,
// HR-4·HR-5·HR-6·HR-8·HR-9·HR-13·HR-14·HR-15·HR-16·HR-17)
//
// HR 서버는 부르지 않는다 — 전역 fetch를 hr.unes.kr 요청만 가로채는 라우터로 바꾼다.
// Supabase REST·Auth도 같은 전역 fetch를 쓰므로 통째로 목으로 바꾸면 가드·리포지토리가
// 죽는다. 그 밖의 URL은 실제 fetch로 넘겨 RLS 경로까지 그대로 검증한다.
// 세션·revalidatePath 스텁은 team-actions.test.ts와 같은 방식이다.
//
// 검증의 핵심 두 가지:
//  1. 키는 X-API-Key 헤더로 **정확히 한 번** 나가고, 실패 문구·반환값 어디에도 실리지 않는다
//     (HR-13·HR-15). 429에서 두 번 부르면 한도를 더 빨리 태운다.
//  2. 생성은 name·position·email 3필드뿐이고 기존 Member를 덮어쓰지 않는다 (HR-4·HR-8).

import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Sql } from 'postgres';
import { connectDirectDb, createTestUser, destroyTestUser, type TestUser } from './helpers';
import type { ActionResult } from '@/types';
import * as membersRepo from '@/lib/db/members';

const session = vi.hoisted(() => ({ accessToken: '' }));

vi.mock('next/headers', () => ({
  cookies: async () => ({ get: () => ({ value: session.accessToken }) }),
}));
vi.mock('next/cache', () => ({ revalidatePath: () => undefined }));

const team = await import('@/actions/team');
const { createProject } = await import('@/actions/projects');

// ─── fetch 라우터 ─────────────────────────────────────────────────────────────

const HR_URL = 'https://hr.unes.kr/api/external/users';
const API_KEY = 'hrk_test_SECRET_9f3a1c7e';
const KEY_TAIL = API_KEY.slice(-8); // 부분 노출도 잡는다 (끝 4자리 마스킹은 화면의 몫이지 액션의 몫이 아니다)

const realFetch = globalThis.fetch;
const hrFetch = vi.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>();

function urlOf(input: RequestInfo | URL): string {
  if (typeof input === 'string') return input;
  if (input instanceof URL) return input.href;
  return input.url;
}

vi.stubGlobal('fetch', (input: RequestInfo | URL, init?: RequestInit) => {
  if (urlOf(input).startsWith('https://hr.unes.kr/')) return hrFetch(input, init);
  return realFetch(input, init);
});

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function hrUser(overrides: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    user_id: 1,
    user_email: 'hong@unes.co.kr',
    user_name: '홍길동',
    user_division: '연구본부',
    user_team: 'AI팀',
    user_position: '선임연구원',
    user_role: 'member',
    user_is_active: true,
    ...overrides,
  };
}

// ─── 검증 도우미 ──────────────────────────────────────────────────────────────

function unwrap<T>(result: ActionResult<T>): T {
  if (!result.ok) {
    throw new Error(`액션 실패: ${result.error} (code=${result.code ?? '-'})`);
  }
  return result.data;
}

function expectFailure(result: ActionResult<unknown>): { error: string; code?: string } {
  if (result.ok) throw new Error('실패해야 할 호출이 성공으로 보고됐습니다.');
  return result;
}

// HR-13: 반환값을 통째로 직렬화해 키(전체·꼬리)가 어디에도 없는지 본다
function expectNoKey(result: ActionResult<unknown>): void {
  const serialized = JSON.stringify(result);
  expect(serialized).not.toContain(API_KEY);
  expect(serialized).not.toContain(KEY_TAIL);
}

function firstHrRequest(): {
  url: string;
  headers: Record<string, string>;
  init: RequestInit | undefined;
} {
  const call = hrFetch.mock.calls[0];
  if (!call) throw new Error('HR fetch가 호출되지 않았습니다.');
  const [input, init] = call;
  const headers = new Headers(init?.headers);
  const flat: Record<string, string> = {};
  headers.forEach((value, name) => {
    flat[name.toLowerCase()] = value;
  });
  return { url: urlOf(input), headers: flat, init };
}

// ─── 시드 ─────────────────────────────────────────────────────────────────────

let sql: Sql;
let user: TestUser;
const tempProjectIds: string[] = [];

let projectId: string;
const REGISTERED_EMAIL = 'kim@unes.co.kr';
let registeredMemberId: string;

beforeAll(async () => {
  sql = connectDirectDb();
  user = await createTestUser(sql);
  session.accessToken = user.accessToken;

  projectId = unwrap(await createProject({ name: 'HR 연동 테스트 과제' })).id;
  tempProjectIds.push(projectId);

  // HR-8 판정 대상: 이 과제에 이미 있는 인력. 대소문자·공백이 달라도 같은 사람으로 봐야 한다
  registeredMemberId = unwrap(
    await team.createMember(projectId, {
      name: '김기존',
      position: '책임연구원',
      email: REGISTERED_EMAIL,
    })
  ).id;
});

afterEach(() => {
  hrFetch.mockReset();
});

afterAll(async () => {
  vi.unstubAllGlobals();
  for (const id of tempProjectIds) {
    await sql`delete from public.projects where id = ${id}::uuid`;
  }
  await destroyTestUser(sql, user);
  await sql.end();
});

// ─── fetchHrDirectory ─────────────────────────────────────────────────────────

describe('fetchHrDirectory — 호출 형태 (HR-13, §9)', () => {
  it('200이면 명부를 옮기고, fetch는 X-API-Key 헤더로 정확히 1회 GET한다', async () => {
    hrFetch.mockResolvedValueOnce(
      jsonResponse(200, {
        success: true,
        count: 2,
        users: [
          hrUser(),
          hrUser({
            user_id: 2,
            user_email: 'lee@unes.co.kr',
            user_name: '이영희',
            user_division: null,
            user_team: null,
          }),
        ],
      })
    );

    const result = await team.fetchHrDirectory(API_KEY, projectId);
    const directory = unwrap(result);

    expect(hrFetch).toHaveBeenCalledTimes(1);
    const { url, headers, init } = firstHrRequest();
    expect(url).toBe(HR_URL);
    expect(init?.method).toBe('GET');
    expect(headers['x-api-key']).toBe(API_KEY);
    expect(headers['authorization']).toBeUndefined(); // Bearer가 아니다
    expect(init?.cache).toBe('no-store'); // HR-17
    expect(init?.signal).toBeInstanceOf(AbortSignal); // 타임아웃 (§9)

    expect(directory.count).toBe(2);
    expect(directory.rowCount).toBe(2);
    expect(directory.countMismatch).toBe(false);
    expect(directory.entries).toHaveLength(2);

    const [first, second] = directory.entries;
    if (first?.kind !== 'user' || second?.kind !== 'user') throw new Error('user 항목이 아닙니다.');
    expect(first.draft).toEqual({ name: '홍길동', position: '선임연구원', email: 'hong@unes.co.kr' });
    expect(first.selectable).toBe(true);
    expect(first.blockReason).toBeNull();
    expect(first.user.user_division).toBe('연구본부');
    // HR-1: 본부·팀 null은 표시 전용이라 읽을 수 없음으로 막지 않는다
    expect(second.user.user_division).toBeNull();
    expect(second.selectable).toBe(true);

    expectNoKey(result);
  });

  it('이 과제에 같은 이메일의 Member가 있으면 already-registered로 선택을 막는다 (HR-8)', async () => {
    hrFetch.mockResolvedValueOnce(
      jsonResponse(200, {
        success: true,
        count: 2,
        // 대소문자·공백이 달라도 같은 사람이다 (HR-9 정규화)
        users: [
          hrUser({ user_email: '  KIM@unes.co.kr ' }),
          hrUser({ user_id: 2, user_email: 'park@unes.co.kr', user_name: '박신규' }),
        ],
      })
    );

    const directory = unwrap(await team.fetchHrDirectory(API_KEY, projectId));
    const [kim, park] = directory.entries;
    if (kim?.kind !== 'user' || park?.kind !== 'user') throw new Error('user 항목이 아닙니다.');

    expect(kim.selectable).toBe(false);
    expect(kim.blockReason).toBe('already-registered');
    expect(park.selectable).toBe(true);
  });

  it('projectId가 null이면 이미 등록됨 판정을 생략한다 (§7.14 [연결 확인])', async () => {
    hrFetch.mockResolvedValueOnce(
      jsonResponse(200, { success: true, count: 1, users: [hrUser({ user_email: REGISTERED_EMAIL })] })
    );

    const directory = unwrap(await team.fetchHrDirectory(API_KEY, null));
    const [entry] = directory.entries;
    if (entry?.kind !== 'user') throw new Error('user 항목이 아닙니다.');

    expect(entry.selectable).toBe(true);
    expect(entry.blockReason).toBeNull();
    expect(hrFetch).toHaveBeenCalledTimes(1);
  });

  it('이메일이 빈 계정·필드가 빠진 항목은 목록에 사유와 함께 남는다 (HR-9·HR-16)', async () => {
    hrFetch.mockResolvedValueOnce(
      jsonResponse(200, {
        success: true,
        count: 3,
        users: [
          hrUser({ user_email: '   ' }),
          { user_id: 2, user_name: '반쪽' }, // 필드 결손
          hrUser({ user_id: 3, user_email: 'ok@unes.co.kr', user_is_active: false }),
        ],
      })
    );

    const directory = unwrap(await team.fetchHrDirectory(API_KEY, projectId));
    expect(directory.entries).toHaveLength(3);

    const [noEmail, unreadable, retired] = directory.entries;
    if (noEmail?.kind !== 'user') throw new Error('user 항목이 아닙니다.');
    expect(noEmail.selectable).toBe(false);
    expect(noEmail.blockReason).toBe('no-email');

    expect(unreadable?.kind).toBe('unreadable');
    if (unreadable?.kind === 'unreadable') expect(unreadable.name).toBe('반쪽');

    // HR-5: 퇴사는 표시만 — 선택을 막지 않는다
    if (retired?.kind !== 'user') throw new Error('user 항목이 아닙니다.');
    expect(retired.retired).toBe(true);
    expect(retired.selectable).toBe(true);
  });

  it('count와 실제 행 수가 다르면 그 사실을 돌려준다 (HR-16)', async () => {
    hrFetch.mockResolvedValueOnce(
      jsonResponse(200, { success: true, count: 38, users: [hrUser()] })
    );
    const directory = unwrap(await team.fetchHrDirectory(API_KEY, projectId));
    expect(directory.count).toBe(38);
    expect(directory.rowCount).toBe(1);
    expect(directory.countMismatch).toBe(true);
  });

  it('키가 비어 있으면 HR을 부르지 않고 VALIDATION으로 거부한다', async () => {
    const result = await team.fetchHrDirectory('   ', projectId);
    expect(expectFailure(result).code).toBe('VALIDATION');
    expect(hrFetch).not.toHaveBeenCalled();
  });

  it('projectId가 uuid가 아니면 HR을 부르지 않고 VALIDATION으로 거부한다', async () => {
    const result = await team.fetchHrDirectory(API_KEY, 'not-a-uuid');
    expect(expectFailure(result).code).toBe('VALIDATION');
    expect(hrFetch).not.toHaveBeenCalled();
    expectNoKey(result);
  });
});

describe('fetchHrDirectory — 실패를 감추지 않는다 (HR-14·HR-15·HR-16)', () => {
  it('401 본문의 code와 message가 함께 실리고, 키는 실리지 않는다', async () => {
    hrFetch.mockResolvedValueOnce(
      jsonResponse(401, { success: false, code: 'INVALID_API_KEY', message: '유효하지 않은 API 키입니다.' })
    );

    const result = await team.fetchHrDirectory(API_KEY, projectId);
    const failure = expectFailure(result);

    expect(failure.code).toBeUndefined(); // HR 실패는 STALE·AUTH·VALIDATION 어느 것도 아니다
    expect(failure.error).toContain('INVALID_API_KEY');
    expect(failure.error).toContain('유효하지 않은 API 키입니다.');
    expect(failure.error).toMatch(/틀렸거나 폐기/);
    expectNoKey(result);
  });

  it('403은 허용 IP 가능성을 언급한다', async () => {
    hrFetch.mockResolvedValueOnce(
      jsonResponse(403, { success: false, code: 'IP_NOT_ALLOWED', message: '허용되지 않은 IP입니다.' })
    );
    const failure = expectFailure(await team.fetchHrDirectory(API_KEY, projectId));
    expect(failure.error).toContain('허용 IP');
    expect(failure.error).toContain('IP_NOT_ALLOWED');
  });

  it('429는 한도 초과를 알리고 fetch를 정확히 1회만 부른다 (HR-15)', async () => {
    hrFetch.mockResolvedValue(
      jsonResponse(429, { success: false, code: 'RATE_LIMITED', message: '요청 한도를 초과했습니다.' })
    );

    const result = await team.fetchHrDirectory(API_KEY, projectId);
    const failure = expectFailure(result);

    expect(hrFetch).toHaveBeenCalledTimes(1);
    expect(failure.error).toContain('300회');
    expect(failure.error).toContain('RATE_LIMITED');
    expectNoKey(result);
  });

  it('503 NOT_CONFIGURED는 HR 서버 문제로 알린다', async () => {
    hrFetch.mockResolvedValueOnce(
      jsonResponse(503, { success: false, code: 'NOT_CONFIGURED', message: '외부 API가 설정되지 않았습니다.' })
    );
    const failure = expectFailure(await team.fetchHrDirectory(API_KEY, projectId));
    expect(failure.error).toContain('HR 서버 문제');
    expect(failure.error).toContain('NOT_CONFIGURED');
  });

  it('본문이 JSON이 아닌 비2xx도 상태 문장으로 실패한다', async () => {
    hrFetch.mockResolvedValueOnce(
      new Response('<html>Bad Gateway</html>', { status: 502, headers: { 'content-type': 'text/html' } })
    );
    const failure = expectFailure(await team.fetchHrDirectory(API_KEY, projectId));
    expect(failure.error).toContain('502');
  });

  it('fetch가 거부되면(타임아웃·DNS) 연결 실패로 돌려주고 다시 부르지 않는다', async () => {
    const timeout = new DOMException('The operation was aborted due to timeout', 'TimeoutError');
    hrFetch.mockRejectedValue(timeout);
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    const result = await team.fetchHrDirectory(API_KEY, projectId);
    const failure = expectFailure(result);

    expect(hrFetch).toHaveBeenCalledTimes(1);
    expect(failure.error).toMatch(/연결하지 못했습니다/);
    expectNoKey(result);
    // 로그에도 키가 없다 (HR-13)
    const logged = JSON.stringify(spy.mock.calls);
    expect(logged).not.toContain(API_KEY);
    expect(logged).not.toContain(KEY_TAIL);
    spy.mockRestore();
  });

  it('success:false인 200은 실패다 — 빈 목록으로 폴백하지 않는다 (HR-16)', async () => {
    hrFetch.mockResolvedValueOnce(jsonResponse(200, { success: false, users: [] }));
    const result = await team.fetchHrDirectory(API_KEY, projectId);
    const failure = expectFailure(result);
    expect(failure.error).toContain('success');
    expectNoKey(result);
  });

  it('users가 배열이 아닌 200은 실패다 (HR-16)', async () => {
    hrFetch.mockResolvedValueOnce(jsonResponse(200, { success: true, count: 0, users: null }));
    expectFailure(await team.fetchHrDirectory(API_KEY, projectId));
  });

  it('본문이 JSON이 아닌 200도 실패다', async () => {
    hrFetch.mockResolvedValueOnce(
      new Response('not json', { status: 200, headers: { 'content-type': 'text/plain' } })
    );
    expectFailure(await team.fetchHrDirectory(API_KEY, projectId));
  });
});

// ─── createMembersFromHr ──────────────────────────────────────────────────────

describe('createMembersFromHr (HR-4·HR-5·HR-6·HR-8·HR-9)', () => {
  it('name·position·email만 채우고 나머지는 신규 등록 기본값이다', async () => {
    const result = unwrap(
      await team.createMembersFromHr(projectId, [
        { name: '홍길동', position: '선임연구원', email: 'hong@unes.co.kr' },
        { name: '이영희', position: '', email: 'lee@unes.co.kr' },
      ])
    );

    expect(result.rejected).toEqual([]);
    expect(result.created).toHaveLength(2);

    const [hong, lee] = result.created;
    if (!hong || !lee) throw new Error('생성 결과가 비었습니다.');
    expect(hong.name).toBe('홍길동');
    expect(hong.position).toBe('선임연구원');
    expect(hong.email).toBe('hong@unes.co.kr');
    // HR-2·HR-4·HR-5·HR-6: 이 값들은 HR에서 오지 않는다
    expect(hong.annualSalary).toBeNull();
    expect(hong.orgId).toBeNull();
    expect(hong.active).toBe(true);
    expect(hong.hireType).toBe('existing');
    expect(hong.role).toBe('researcher');
    expect(hong.field).toBe('');
    expect(hong.phone).toBe('');
    expect(hong.projectId).toBe(projectId);

    // H-10: 기존 인력(김기존, order 0) 뒤에 순서대로 붙는다
    expect(hong.order).toBe(1);
    expect(lee.order).toBe(2);

    // DB에도 같은 값으로 있다 (반환값만 맞고 저장이 다른 경우를 잡는다)
    const stored = await membersRepo.getMemberById(user.client, hong.id);
    expect(stored.annualSalary).toBeNull();
    expect(stored.orgId).toBeNull();
    expect(stored.active).toBe(true);
  });

  it('user_division 같은 여분 키가 있으면 strict가 거부한다 (HR-6)', async () => {
    const before = await membersRepo.listMembers(user.client, projectId);
    const result = await team.createMembersFromHr(projectId, [
      { name: '본부포함', position: '연구원', email: 'div@unes.co.kr', user_division: '연구본부' },
    ]);
    expect(expectFailure(result).code).toBe('VALIDATION');
    expect(await membersRepo.listMembers(user.client, projectId)).toHaveLength(before.length);
  });

  it('user_is_active·annualSalary 같은 키도 거부한다 (HR-4·HR-5)', async () => {
    const a = await team.createMembersFromHr(projectId, [
      { name: 'x', position: '', email: 'x@unes.co.kr', user_is_active: false },
    ]);
    expect(expectFailure(a).code).toBe('VALIDATION');
    const b = await team.createMembersFromHr(projectId, [
      { name: 'x', position: '', email: 'x@unes.co.kr', annualSalary: 50_000_000 },
    ]);
    expect(expectFailure(b).code).toBe('VALIDATION');
  });

  it('이메일이 비면 거부한다 (HR-9 — 매칭 키)', async () => {
    const result = await team.createMembersFromHr(projectId, [
      { name: '무메일', position: '연구원', email: '' },
    ]);
    expect(expectFailure(result).code).toBe('VALIDATION');
  });

  it('빈 배열은 거부한다', async () => {
    expect(expectFailure(await team.createMembersFromHr(projectId, [])).code).toBe('VALIDATION');
  });

  it('기존 이메일의 draft는 rejected에만 남고 DB에 생기지 않는다 (HR-8)', async () => {
    const before = await membersRepo.listMembers(user.client, projectId);

    const result = unwrap(
      await team.createMembersFromHr(projectId, [
        // 대소문자·공백이 달라도 같은 사람이다 (HR-9 정규화)
        { name: '김기존HR', position: 'HR직위', email: ' KIM@unes.co.kr ' },
        { name: '박신규', position: '연구원', email: 'park@unes.co.kr' },
      ])
    );

    expect(result.rejected).toEqual([
      { name: '김기존HR', email: 'KIM@unes.co.kr', reason: '이미 등록됨' },
    ]);
    expect(result.created.map((m) => m.name)).toEqual(['박신규']);

    const after = await membersRepo.listMembers(user.client, projectId);
    expect(after).toHaveLength(before.length + 1);
    // 기존 Member는 덮어쓰이지 않는다 — 이름·직위가 HR과 달라도 그대로다
    const kim = after.find((m) => m.id === registeredMemberId);
    expect(kim?.name).toBe('김기존');
    expect(kim?.position).toBe('책임연구원');
    expect(after.filter((m) => m.email.trim().toLowerCase() === REGISTERED_EMAIL)).toHaveLength(1);
  });

  it('요청 배열 안의 중복 이메일은 VALIDATION으로 거부하고 아무도 만들지 않는다', async () => {
    const before = await membersRepo.listMembers(user.client, projectId);
    const result = await team.createMembersFromHr(projectId, [
      { name: '중복1', position: '', email: 'dup@unes.co.kr' },
      { name: '중복2', position: '', email: 'DUP@unes.co.kr ' },
    ]);
    const failure = expectFailure(result);
    expect(failure.code).toBe('VALIDATION');
    expect(failure.error).toContain('dup@unes.co.kr');
    expect(await membersRepo.listMembers(user.client, projectId)).toHaveLength(before.length);
  });

  it('중간에 실패하면 몇 명이 이미 생성됐는지 문구에 남긴다', async () => {
    const original = membersRepo.createMember;
    let calls = 0;
    const spy = vi.spyOn(membersRepo, 'createMember').mockImplementation(async (...args) => {
      calls += 1;
      if (calls === 2) throw new Error('두 번째 insert 실패(테스트 주입)');
      return original(...args);
    });
    const before = await membersRepo.listMembers(user.client, projectId);

    const result = await team.createMembersFromHr(projectId, [
      { name: '부분1', position: '', email: 'partial1@unes.co.kr' },
      { name: '부분2', position: '', email: 'partial2@unes.co.kr' },
    ]);
    spy.mockRestore();

    const failure = expectFailure(result);
    expect(failure.error).toContain('1명은 이미 생성됐습니다');
    const after = await membersRepo.listMembers(user.client, projectId);
    expect(after).toHaveLength(before.length + 1);
    expect(after.some((m) => m.email === 'partial1@unes.co.kr')).toBe(true);
    expect(after.some((m) => m.email === 'partial2@unes.co.kr')).toBe(false);
  });

  it('projectId가 uuid가 아니면 VALIDATION', async () => {
    const result = await team.createMembersFromHr('nope', [
      { name: 'x', position: '', email: 'x@unes.co.kr' },
    ]);
    expect(expectFailure(result).code).toBe('VALIDATION');
  });
});
