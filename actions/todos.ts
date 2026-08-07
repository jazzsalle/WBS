'use server';

// Todo 서버 액션 + /todos 화면 조회
// (SOT §9 Todo, SA-1~SA-4, §5.15, §7.13 T-D1~T-D10, §8.3 X-3, §8.4 O-1~O-3)
// 반환은 ActionResult<T> — 예외를 그대로 던지지 않는다. supabase 직접 호출 금지,
// 반드시 lib/db/ 리포지토리를 거친다 (§8.6).
//
// 필터·정렬·지연 판정은 여기 없다. 전부 lib/todos.ts 순수 함수가 한다 (T-D3) —
// 정의가 두 벌이 되면 /todos와 대시보드 "오늘의 To-Do"(§7.2 6)의 건수가 조용히 어긋난다.
// 이 파일은 화면이 그 함수들에 넣을 재료(전체 목록·기준일·dueSoonDays)만 모아 준다.

import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { ActionResult, Todo } from '@/types';
import { requireApprovedUser } from '@/lib/auth/guard';
import { todayISO } from '@/lib/dates';
import * as appUsers from '@/lib/db/app-users';
import * as projectsRepo from '@/lib/db/projects';
import * as settingsRepo from '@/lib/db/settings';
import * as todosRepo from '@/lib/db/todos';
import {
  NotFoundError,
  RuleViolationError,
  StaleDataError,
  ValidationError,
  toActionFailure,
} from '@/lib/db/errors';
import { prioritySchema } from '@/lib/db/schema';

// ─── 조회 모델 (§7.13) ────────────────────────────────────────
// 타입을 types/index.ts가 아니라 여기 두는 이유: 화면 전용 조회 모델이라 DB 엔티티가
// 아니다 (actions/notes.ts의 NotesData가 같은 선례다).

/**
 * 과제 필터(T-D5)와 행의 과제 링크(§7.13)가 쓰는 최소 정보.
 * `archived`를 싣는 이유: T-D6대로 아카이브 과제의 To-Do도 감추지 않으므로
 * 화면이 그 과제를 **흐린 스타일로 구분**해 보여줘야 한다. 걸러 내라는 뜻이 아니다.
 */
export interface TodoProjectOption {
  id: string;
  name: string;
  archived: boolean;
}

export interface TodosData {
  /** 수동 순서(sort_order) 그대로의 전체 목록. 필터·정렬은 화면이 lib/todos.ts로 건다 */
  todos: Todo[];
  /** T-D6: 아카이브 과제도 포함한다 — 빠지면 그 과제 To-Do의 과제명이 사라진다 */
  projects: TodoProjectOption[];
  /** T-D4 dueSoon 경계 (§5.16 Settings) */
  dueSoonDays: number;
  /** §7.13 서문: 기준일은 서버가 Asia/Seoul 달력으로 한 번 계산해 내린다 */
  todayISO: string;
}

// ─── 입력 검증 ────────────────────────────────────────────────

const uuidSchema = z.uuid();
const uuidListSchema = z.array(z.uuid()).min(1, '정렬할 항목이 없습니다.');

// DB 컬럼은 date다. 시각이 붙은 문자열이 오면 저장 시 잘려 하루가 밀릴 수 있어 형식을 강제한다.
const isoDateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "날짜는 'YYYY-MM-DD' 형식이어야 합니다.");

// 빠른 추가(§7.13)는 제목만 받는다 — 공백만 있는 제목은 목록에서 식별이 불가능하다
const titleSchema = z
  .string()
  .trim()
  .min(1, '할 일을 입력하세요.')
  .max(200, '할 일은 200자 이내여야 합니다.');

// done·completedAt·order는 여기 없다. done/completedAt은 toggleTodo가, order는
// reorderTodos가 전담한다 (X-3) — 두 경로가 생기면 완료 시각과 순서가 서로를 덮어쓴다.
const todoFieldsSchema = z
  .object({
    title: titleSchema,
    projectId: z.uuid('과제 ID 형식이 올바르지 않습니다.').nullable(),
    dueDate: isoDateSchema.nullable(),
    priority: prioritySchema,
  })
  .strict();

// 제목만으로 추가할 수 있어야 한다(한 줄 빠른 추가). 나머지는 행에서 붙인다.
const todoCreateSchema = todoFieldsSchema.partial().extend({
  title: todoFieldsSchema.shape.title,
});

const todoPatchSchema = todoFieldsSchema.partial();

// O-1의 조건 값. version은 BEFORE UPDATE 트리거가 +1 하는 양의 정수다 (N-5)
const versionSchema = z.number().int().nonnegative('버전 값이 올바르지 않습니다.');

function parseOrThrow<T>(schema: z.ZodType<T>, value: unknown, fallback: string): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    throw new ValidationError(parsed.error.issues[0]?.message ?? fallback);
  }
  return parsed.data;
}

// O-3: 낙관적 잠금 실패는 "누가 먼저 고쳤는지"까지 알려야 사용자가 판단할 수 있다.
// 이름 조회 실패도 삼키지 않고 로그를 남긴 뒤 이름 없는 기본 메시지로 폴백한다.
async function toFailure(e: unknown, client?: SupabaseClient): Promise<ActionResult<never>> {
  if (e instanceof StaleDataError && e.updatedBy !== null && client) {
    try {
      const editor = await appUsers.getAppUserById(client, e.updatedBy);
      const label = editor.name.trim() || editor.email;
      return {
        ok: false,
        error: `${label}님이 먼저 수정했습니다. 최신 내용을 확인하세요.`,
        code: 'STALE',
      };
    } catch (lookupError) {
      console.error('[actions/todos] 수정자 이름 조회 실패:', lookupError);
    }
  }
  return toActionFailure(e);
}

// 대시보드가 "오늘의 To-Do"를 집계하므로(§7.2 6) To-Do 화면만 다시 그리면 건수가 낡은 채로 남는다
function revalidateTodos(): void {
  revalidatePath('/');
  revalidatePath('/todos');
}

/**
 * FK(`todos.project_id`)가 없는 과제를 막아 주긴 하지만 그 실패는 제약 위반 메시지라
 * 사용자에게 보여줄 문장이 아니다. 여기서 미리 확인해 사용자용 메시지로 바꾼다.
 *
 * **아카이브 과제도 허용한다 (T-D6).** /todos는 To-Do의 유일한 접근 경로라
 * 아카이브 과제의 To-Do를 감추지 않는다 — 여기서 아카이브를 거부하면 그 과제로
 * 되돌릴 방법이 사라진다. 아카이브 제외는 집계 화면인 대시보드(§7.2)만의 규칙이다.
 */
async function assertProjectExists(
  client: SupabaseClient,
  projectId: string | null | undefined
): Promise<void> {
  if (projectId == null) return; // null = "(과제 없음)"은 정상 값이다 (T-D5)
  try {
    await projectsRepo.getProjectById(client, projectId);
  } catch (e) {
    if (e instanceof NotFoundError) {
      throw new RuleViolationError('존재하지 않는 과제입니다. 목록을 새로고침한 뒤 다시 선택하세요.');
    }
    throw e; // 그 밖의 실패는 삼키지 않는다 (절대 규칙 5)
  }
}

// ─── CRUD (§5.15, §9 Todo) ────────────────────────────────────

export async function createTodo(input: unknown): Promise<ActionResult<Todo>> {
  try {
    const fields = parseOrThrow(todoCreateSchema, input, '할 일 정보가 올바르지 않습니다.');
    const { user, client } = await requireApprovedUser();

    await assertProjectExists(client, fields.projectId);

    // 새 항목은 목록 끝에 붙인다. 순서 변경은 reorderTodos 전용이다 (X-3).
    const existing = await todosRepo.listTodos(client);
    const nextOrder = existing.reduce((max, t) => Math.max(max, t.order + 1), 0);

    const created = await todosRepo.createTodo(client, {
      title: fields.title,
      done: false,
      projectId: fields.projectId ?? null,
      dueDate: fields.dueDate ?? null,
      // §5.15 DB 기본값과 같은 'normal'. 지어낸 값이 아니라 스키마 default를 따른다.
      priority: fields.priority ?? 'normal',
      order: nextOrder,
      completedAt: null, // done=false와 짝이다 (T-D8)
      createdBy: user.id,
      updatedBy: user.id,
    });

    revalidateTodos();
    return { ok: true, data: created };
  } catch (e) {
    return toFailure(e);
  }
}

/**
 * 제목·마감일·우선순위·과제 편집 — §8.4 **O-1** 대상이다(§7.13).
 * 여러 필드를 한 번에 바꾸는 경로라 `expectedVersion`을 **필수**로 받는다.
 * (SA-2는 선택 인자로 규정하지만, To-Do의 O-2 경로는 별도 액션 `toggleTodo`로
 *  갈라 두었으므로 이 경로에서 잠금을 생략할 정당한 사유가 없다.)
 * STALE이면 O-3대로 수정자 이름과 함께 code:'STALE'을 돌려주고, 화면은 입력값을
 * 유지한 채 비교 UI를 띄운다 — 사용자가 친 글자를 날리지 않는다.
 *
 * `done`은 patch에 없다. 체크박스는 toggleTodo가 전담한다 (아래 O-2 주석 참조).
 */
export async function updateTodo(
  id: string,
  patch: unknown,
  expectedVersion: number
): Promise<ActionResult<Todo>> {
  let client: SupabaseClient | undefined;
  try {
    const tid = parseOrThrow(uuidSchema, id, '할 일 ID 형식이 올바르지 않습니다.');
    const parsed = parseOrThrow(todoPatchSchema, patch, '할 일 정보가 올바르지 않습니다.');
    const version = parseOrThrow(versionSchema, expectedVersion, '버전 값이 올바르지 않습니다.');
    // 리포지토리는 updatedBy를 patch에 담아 받으므로 "빈 patch" 판정을 여기서 한다 —
    // 그러지 않으면 아무 내용도 없는 저장이 version만 올려 남의 편집을 STALE로 만든다
    if (Object.keys(parsed).length === 0) {
      throw new ValidationError('갱신할 내용이 없습니다.');
    }
    const ctx = await requireApprovedUser();
    client = ctx.client;

    // 과제를 바꿀 때만 확인한다 (조회 1회를 아끼기 위해). null로 떼는 것도 정상 값이다.
    if (parsed.projectId !== undefined) {
      await assertProjectExists(client, parsed.projectId);
    }

    const updated = await todosRepo.updateTodo(
      client,
      tid,
      { ...parsed, updatedBy: ctx.user.id },
      version
    );

    revalidateTodos();
    return { ok: true, data: updated };
  } catch (e) {
    return toFailure(e, client);
  }
}

/**
 * 체크박스 토글 — §8.4 **O-2**다. 사용자가 UI에서 직접 조작한 필드가 `done` 하나뿐이라
 * 낙관적 잠금을 생략한다: `expectedVersion`을 받지 않고 **마지막 것이 이긴다.**
 * 여기서 잠금을 걸면 남이 제목을 고친 직후의 체크 한 번이 STALE 대화상자로 막히는데,
 * 잃을 작업이 없는 조작이라 그 마찰이 순수한 손해다.
 *
 * `completedAt`은 O-2가 말하는 **파생 갱신**이다(P-1~P-3처럼 규칙이 함께 바꾸는 필드).
 * T-D8: 완료로 바꾸면 지금 시각을 채우고, 해제하면 null로 되돌린다 — 되돌릴 때 값을
 * 남겨 두면 "완료된 적 있음"이 다음 완료 시각을 덮어쓰지 못한 채 남아 통계가 어긋난다.
 */
export async function toggleTodo(id: string): Promise<ActionResult<Todo>> {
  try {
    const tid = parseOrThrow(uuidSchema, id, '할 일 ID 형식이 올바르지 않습니다.');
    const { user, client } = await requireApprovedUser();

    const before = await todosRepo.getTodoById(client, tid); // 없으면 NotFoundError
    const done = !before.done;

    const updated = await todosRepo.updateTodo(client, tid, {
      done,
      // completed_at은 timestamptz다. 달력 날짜(§6.5)가 아니라 시점 기록이므로 ISO 시각.
      completedAt: done ? new Date().toISOString() : null,
      updatedBy: user.id,
    });

    revalidateTodos();
    return { ok: true, data: updated };
  } catch (e) {
    return toFailure(e);
  }
}

export async function deleteTodo(id: string): Promise<ActionResult<null>> {
  try {
    const tid = parseOrThrow(uuidSchema, id, '할 일 ID 형식이 올바르지 않습니다.');
    const { client } = await requireApprovedUser();

    await todosRepo.removeTodo(client, tid); // 없으면 NotFoundError

    revalidateTodos();
    return { ok: true, data: null };
  } catch (e) {
    return toFailure(e);
  }
}

/**
 * X-3: 넘어온 순서대로 0..n-1을 한 번의 RPC로 부여한다.
 *
 * To-Do는 컨테이너가 없는 **전역** 목록이라 다른 reorder와 달리 `projectId`를 받지
 * 않는다 (§7.13, §9).
 *
 * **계약(T-D10): `orderedIds`는 필터로 숨겨진 항목까지 포함한 "전체 순서"다.**
 * 보이는 것만 보내면 필터를 풀었을 때 순서가 섞인다. 화면이 전체 순서를 재계산해
 * 보내 주는 덕분에 `reorder_todos` RPC가 "배열 길이 = 갱신 행 수"를 엄격히 검사할 수
 * 있고, 존재하지 않는 id·중복을 조용히 넘기지 않는다. 부분 배열은 정상 입력이 아니라
 * 화면 상태가 깨진 신호이므로 RPC의 거부가 곧 올바른 동작이다.
 */
export async function reorderTodos(orderedIds: string[]): Promise<ActionResult<null>> {
  try {
    const ids = parseOrThrow(uuidListSchema, orderedIds, '정렬 목록이 올바르지 않습니다.');
    const { client } = await requireApprovedUser();

    await todosRepo.reorderTodos(client, ids);

    revalidateTodos();
    return { ok: true, data: null };
  } catch (e) {
    return toFailure(e);
  }
}

// ─── 조회 (§7.13 화면 — 서버 컴포넌트에서 직접 호출) ──────────

/**
 * /todos 한 화면이 필요한 것을 한 번에 모은다.
 * 목록은 **거르지 않은 전체**다 — 필터(T-D1·T-D2·T-D5)와 정렬(T-D7)은 화면이
 * lib/todos.ts로 걸어야 T-D10의 "숨겨진 항목까지 포함한 전체 순서" 재계산이 된다.
 */
export async function getTodosData(): Promise<ActionResult<TodosData>> {
  try {
    const { client } = await requireApprovedUser();

    // 하나라도 실패하면 실패를 그대로 올린다 — 빈 배열 폴백은 데이터 손상을 감춘다
    // (절대 규칙 5). 특히 과제 조회가 조용히 비면 모든 행의 과제명이 사라진다.
    const [todos, projects, settings] = await Promise.all([
      todosRepo.listTodos(client),
      projectsRepo.listProjects(client),
      settingsRepo.getSettings(client),
    ]);

    return {
      ok: true,
      data: {
        todos,
        // T-D6: archived를 필터 조건이 아니라 표시용 플래그로 내린다
        projects: projects.map((p) => ({ id: p.id, name: p.name, archived: p.archived })),
        dueSoonDays: settings.dueSoonDays,
        todayISO: todayISO(new Date()),
      },
    };
  } catch (e) {
    return toFailure(e);
  }
}
