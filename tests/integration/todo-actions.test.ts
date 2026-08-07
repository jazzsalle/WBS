// Todo 서버 액션 + reorder_todos RPC 통합 테스트
// (SOT §5.15, §7.13 T-D5·T-D6·T-D8·T-D10, §8.3 X-3, §8.4 O-1~O-3, N-8)
//
// 서버 액션은 쿠키 세션(requireApprovedUser)에서 토큰을 읽으므로 next/headers를
// "실제 세션 토큰을 돌려주는 스텁"으로 바꿔 액션을 가드까지 포함해 그대로 호출한다
// (risk-actions.test.ts와 같은 방식). revalidatePath는 요청 컨텍스트 밖이라 스텁한다.
//
// 검증의 핵심 세 가지:
//  1. O-2/O-1의 갈림 — toggleTodo는 version을 받지 않으므로 남이 먼저 고쳐도 통과해야 하고,
//     updateTodo는 낡은 version이면 STALE이어야 한다. 둘이 뒤바뀌면 체크 한 번이 대화상자로
//     막히거나(O-2 위반) 여러 필드 저장이 남의 편집을 조용히 덮어쓴다(O-1 위반).
//  2. T-D8 — completedAt은 완료 시 채워지고 해제 시 null로 되돌아간다. 값이 남으면
//     "완료된 적 있음"이 다음 완료 시각을 덮어쓰지 못한 채 통계가 어긋난다.
//  3. T-D10/X-3 — reorder_todos는 "배열 길이 = 갱신 행 수"를 엄격히 검사한다.
//     존재하지 않는 id·중복을 조용히 넘기면 화면 상태가 깨진 신호를 놓친다.
//
// N-8(과제 삭제 시 To-Do가 남고 projectId가 null)은 cascade-delete.test.ts의
// 'H-7: Project 삭제' 시나리오에 이미 있다 — 여기서 중복 검증하지 않는다.

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Sql } from 'postgres';
import { connectDirectDb, createTestUser, destroyTestUser, type TestUser } from './helpers';
import type { ActionResult, Todo } from '@/types';
import * as todosRepo from '@/lib/db/todos';

const session = vi.hoisted(() => ({ accessToken: '' }));

vi.mock('next/headers', () => ({
  cookies: async () => ({ get: () => ({ value: session.accessToken }) }),
}));
vi.mock('next/cache', () => ({ revalidatePath: () => undefined }));

const todos = await import('@/actions/todos');
const { createProject, archiveProject } = await import('@/actions/projects');

let sql: Sql;
let user: TestUser;
/** O-2 검증용 "다른 세션" — todos는 팀 공유라 승인된 사용자 전원이 서로의 항목을 고칠 수 있다 (§7.13) */
let otherUser: TestUser;
const tempProjectIds: string[] = []; // afterAll 안전망 — 이 테스트가 만든 과제만 지운다

let projectId: string;
let archivedProjectId: string;

// 실패를 조용히 넘기지 않는다 — 실패 코드까지 메시지에 담아 원인을 드러낸다
function unwrap<T>(result: ActionResult<T>): T {
  if (!result.ok) {
    throw new Error(`액션 실패: ${result.error} (code=${result.code ?? '-'})`);
  }
  return result.data;
}

function expectCode(result: ActionResult<unknown>, code: string): string {
  if (result.ok) throw new Error(`실패해야 하는 호출이 통과했습니다 (기대 code=${code}).`);
  expect(result.code).toBe(code);
  return result.error;
}

async function newProject(name: string): Promise<string> {
  const project = unwrap(await createProject({ name, contractStartDate: '2026-01-01' }));
  tempProjectIds.push(project.id);
  return project.id;
}

async function addTodo(title: string, extra: Record<string, unknown> = {}): Promise<Todo> {
  return unwrap(await todos.createTodo({ title, ...extra }));
}

// To-Do는 전역 목록이라 dev DB의 다른 행이 섞인다 — 이 테스트가 만든 것만 골라 본다
async function orderOf(ids: string[]): Promise<{ id: string; order: number }[]> {
  const all = await todosRepo.listTodos(user.client);
  const wanted = new Set(ids);
  return all.filter((t) => wanted.has(t.id)).map((t) => ({ id: t.id, order: t.order }));
}

beforeAll(async () => {
  sql = connectDirectDb();
  user = await createTestUser(sql);
  otherUser = await createTestUser(sql);
  session.accessToken = user.accessToken;

  projectId = await newProject('To-Do 액션 테스트 과제');
  archivedProjectId = await newProject('To-Do 액션 아카이브 과제');
  unwrap(await archiveProject(archivedProjectId, true));
});

afterAll(async () => {
  // 사용자보다 먼저 지운다 — auth.users 삭제는 created_by를 null로 만들어 소유 흔적을 지운다
  await sql`delete from public.todos where created_by = ${user.id}::uuid`;
  for (const id of tempProjectIds) {
    await sql`delete from public.projects where id = ${id}::uuid`;
  }
  await destroyTestUser(sql, otherUser);
  await destroyTestUser(sql, user);
  await sql.end();
});

describe('createTodo (§5.15, §9)', () => {
  it('제목만으로 만들면 §5.15 기본값을 채운다', async () => {
    const created = await addTodo('한 줄 빠른 추가');

    expect(created.title).toBe('한 줄 빠른 추가');
    expect(created.done).toBe(false);
    expect(created.completedAt).toBeNull(); // done=false와 짝이다 (T-D8)
    expect(created.projectId).toBeNull(); // "(과제 없음)"은 정상 값이다 (T-D5)
    expect(created.dueDate).toBeNull();
    expect(created.priority).toBe('normal'); // DB default
    expect(created.version).toBe(1); // N-4 default
  });

  it('공백 제목과 잘못된 날짜 형식을 거부한다', async () => {
    expectCode(await todos.createTodo({ title: '   ' }), 'VALIDATION');
    expectCode(await todos.createTodo({ title: '형식 오류', dueDate: '2026/12/31' }), 'VALIDATION');
    // done·completedAt·order는 입력 대상이 아니다 (X-3, T-D8) — strict 스키마가 막는다
    expectCode(await todos.createTodo({ title: '금지 필드', done: true }), 'VALIDATION');
  });

  it('존재하지 않는 과제는 사용자용 메시지로 거부한다', async () => {
    const message = expectCode(
      await todos.createTodo({ title: '유령 과제', projectId: '00000000-0000-4000-8000-000000000000' }),
      'RULE'
    );
    expect(message).toContain('존재하지 않는 과제');
  });

  it('아카이브 과제도 허용한다 (T-D6)', async () => {
    const onArchived = await addTodo('아카이브 과제 할 일', { projectId: archivedProjectId });
    expect(onArchived.projectId).toBe(archivedProjectId);

    // T-D6: 조회 모델도 아카이브 과제를 빼지 않는다 — 빠지면 그 행의 과제명이 사라진다
    const data = unwrap(await todos.getTodosData());
    const option = data.projects.find((p) => p.id === archivedProjectId);
    if (!option) throw new Error('아카이브 과제가 조회 모델에서 빠졌습니다.');
    expect(option.archived).toBe(true);
    expect(data.todos.map((t) => t.id)).toContain(onArchived.id);
  });
});

describe('toggleTodo (§8.4 O-2, T-D8)', () => {
  it('완료하면 completedAt을 채우고 해제하면 null로 되돌린다', async () => {
    const created = await addTodo('토글 대상');

    const done = unwrap(await todos.toggleTodo(created.id));
    expect(done.done).toBe(true);
    expect(done.completedAt).not.toBeNull();
    expect(done.version).toBe(created.version + 1); // N-5 트리거

    const undone = unwrap(await todos.toggleTodo(created.id));
    expect(undone.done).toBe(false);
    expect(undone.completedAt).toBeNull();

    // 다시 완료하면 새 시각이 들어간다 — 이전 값이 남아 있으면 안 된다
    const redone = unwrap(await todos.toggleTodo(created.id));
    expect(redone.completedAt).not.toBeNull();
    expect(redone.completedAt).not.toBe(done.completedAt);
  });

  it('다른 세션이 먼저 고쳐 version이 올라가도 성공한다 (O-2)', async () => {
    const created = await addTodo('경합 토글 대상');

    // 다른 승인 사용자가 제목을 먼저 고친다 — version이 올라간다
    const bumped = await todosRepo.updateTodo(otherUser.client, created.id, {
      title: '남이 고친 제목',
      updatedBy: otherUser.id,
    });
    expect(bumped.version).toBeGreaterThan(created.version);

    // toggleTodo는 expectedVersion을 받지 않는다 — 마지막 것이 이긴다
    const toggled = unwrap(await todos.toggleTodo(created.id));
    expect(toggled.done).toBe(true);
    expect(toggled.completedAt).not.toBeNull();
    expect(toggled.title).toBe('남이 고친 제목'); // 남의 편집을 되돌리지 않는다
  });

  it('없는 항목의 토글은 실패한다', async () => {
    const failed = await todos.toggleTodo('00000000-0000-4000-8000-000000000000');
    if (failed.ok) throw new Error('없는 To-Do 토글이 통과했습니다.');
    expect(failed.code).toBeUndefined(); // NotFound — §9 코드 체계에 NOT_FOUND가 없다
  });
});

describe('updateTodo (§8.4 O-1, O-3)', () => {
  it('낡은 expectedVersion으로 저장하면 STALE로 거부한다', async () => {
    const created = await addTodo('편집 대상');

    const updated = unwrap(
      await todos.updateTodo(
        created.id,
        { title: '편집됨', dueDate: '2026-09-30', priority: 'high', projectId },
        created.version
      )
    );
    expect(updated.title).toBe('편집됨');
    expect(updated.dueDate).toBe('2026-09-30');
    expect(updated.priority).toBe('high');
    expect(updated.projectId).toBe(projectId);
    expect(updated.version).toBe(created.version + 1);

    // 같은(이제는 낡은) version으로 다시 저장하면 STALE이다
    const message = expectCode(
      await todos.updateTodo(created.id, { title: '덮어쓰기' }, created.version),
      'STALE'
    );
    expect(message).toContain('먼저 수정했습니다'); // O-3

    // 실패한 저장이 내용을 바꾸지 않았는지 확인한다
    const after = await todosRepo.getTodoById(user.client, created.id);
    expect(after.title).toBe('편집됨');
    expect(after.version).toBe(updated.version);
  });

  it('토글이 올린 version도 O-1 잠금에 그대로 반영된다', async () => {
    const created = await addTodo('토글 후 편집');
    const toggled = unwrap(await todos.toggleTodo(created.id));

    expectCode(await todos.updateTodo(created.id, { title: '낡은 버전' }, created.version), 'STALE');
    unwrap(await todos.updateTodo(created.id, { title: '최신 버전' }, toggled.version));
  });

  it('expectedVersion과 patch 형식을 검증한다', async () => {
    const created = await addTodo('검증 대상');

    // O-1 경로라 expectedVersion은 필수다 — 숫자가 아니면 거부한다
    expectCode(
      await todos.updateTodo(created.id, { title: 'x' }, undefined as unknown as number),
      'VALIDATION'
    );
    // 빈 patch는 version만 올려 남의 편집을 STALE로 만든다 — 미리 막는다
    expectCode(await todos.updateTodo(created.id, {}, created.version), 'VALIDATION');
    // done은 patch 대상이 아니다 — 체크박스는 toggleTodo가 전담한다 (O-2)
    expectCode(await todos.updateTodo(created.id, { done: true }, created.version), 'VALIDATION');

    // projectId=null("과제 없음")은 정상 값이다 (T-D5)
    const cleared = unwrap(await todos.updateTodo(created.id, { projectId: null }, created.version));
    expect(cleared.projectId).toBeNull();
  });
});

describe('reorderTodos / reorder_todos RPC (§8.3 X-3, T-D10)', () => {
  let aId: string;
  let bId: string;
  let cId: string;
  let ids: string[];

  beforeAll(async () => {
    aId = (await addTodo('정렬 A')).id;
    bId = (await addTodo('정렬 B')).id;
    cId = (await addTodo('정렬 C')).id;
    ids = [aId, bId, cId];
  });

  it('넘긴 순서대로 0..n-1을 재부여한다', async () => {
    unwrap(await todos.reorderTodos([cId, bId, aId]));

    expect(await orderOf(ids)).toEqual([
      { id: cId, order: 0 },
      { id: bId, order: 1 },
      { id: aId, order: 2 },
    ]);
  });

  it('존재하지 않는 id가 섞이면 거부하고 순서를 바꾸지 않는다', async () => {
    const message = expectCode(
      await todos.reorderTodos([aId, '00000000-0000-4000-8000-000000000000', bId, cId]),
      'RULE'
    );
    expect(message).toContain('재정렬');

    // 부분 반영이 남으면 안 된다 — RPC는 한 트랜잭션이다 (X-3)
    expect(await orderOf(ids)).toEqual([
      { id: cId, order: 0 },
      { id: bId, order: 1 },
      { id: aId, order: 2 },
    ]);
  });

  it('중복된 id도 조용히 넘기지 않는다 (T-D10)', async () => {
    expectCode(await todos.reorderTodos([aId, aId, bId, cId]), 'RULE');

    expect(await orderOf(ids)).toEqual([
      { id: cId, order: 0 },
      { id: bId, order: 1 },
      { id: aId, order: 2 },
    ]);
  });

  it('uuid가 아닌 값과 빈 목록은 액션이 먼저 막는다', async () => {
    expectCode(await todos.reorderTodos(['not-a-uuid']), 'VALIDATION');
    expectCode(await todos.reorderTodos([]), 'VALIDATION');
  });

  it('RPC에 빈 배열이 닿으면 아무것도 바꾸지 않는다 (no-op)', async () => {
    // 액션은 빈 목록을 막으므로 RPC 자체의 계약은 리포지토리로 직접 확인한다
    await todosRepo.reorderTodos(user.client, []);

    expect(await orderOf(ids)).toEqual([
      { id: cId, order: 0 },
      { id: bId, order: 1 },
      { id: aId, order: 2 },
    ]);
  });
});

describe('deleteTodo (§9)', () => {
  it('삭제하면 목록에서 사라지고 두 번 지울 수 없다', async () => {
    const created = await addTodo('삭제 대상');

    unwrap(await todos.deleteTodo(created.id));
    const list = await todosRepo.listTodos(user.client);
    expect(list.map((t) => t.id)).not.toContain(created.id);

    const failed = await todos.deleteTodo(created.id);
    if (failed.ok) throw new Error('이미 지운 To-Do 삭제가 통과했습니다.');
    expect(failed.code).toBeUndefined(); // NotFound — §9 코드 체계에 NOT_FOUND가 없다
  });
});
