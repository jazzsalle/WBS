'use server';

// Note 서버 액션 + 노트 화면 조회
// (SOT §9 Note, SA-1~SA-4, §5.14, §7.12, §8.4 O-1~O-3)
// 반환은 ActionResult<T> — 예외를 그대로 던지지 않는다. supabase 직접 호출 금지,
// 반드시 lib/db/ 리포지토리를 거친다 (§8.6).
//
// 조회 모델 타입은 여기 둔다 (actions/budget.ts의 BudgetMatrixData와 같은 방식) —
// types/index.ts는 SOT §5의 도메인 모델 전용이다.

import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { ActionResult, Member, Note, NoteType, Year } from '@/types';
import { requireApprovedUser } from '@/lib/auth/guard';
import { todayISO } from '@/lib/dates';
import * as appUsers from '@/lib/db/app-users';
import * as membersRepo from '@/lib/db/members';
import * as milestonesRepo from '@/lib/db/milestones';
import * as notesRepo from '@/lib/db/notes';
import * as tasksRepo from '@/lib/db/tasks';
import * as yearsRepo from '@/lib/db/years';
import {
  NotFoundError,
  RuleViolationError,
  StaleDataError,
  ValidationError,
  toActionFailure,
} from '@/lib/db/errors';
import { noteTypeSchema } from '@/lib/db/schema';

// ─── 조회 모델 (§7.12) ────────────────────────────────────────

/** 연결 대상 선택지. 노트 화면은 작업의 제목·연차만 쓰므로 트리·진척률은 싣지 않는다 */
export interface NoteTaskOption {
  id: string;
  title: string;
  yearId: string;
}

export interface NoteMilestoneOption {
  id: string;
  title: string;
  date: string;
}

export interface NotesData {
  projectId: string;
  notes: Note[];
  years: Year[];
  /** 참석자 다중 선택 후보 (§7.12) */
  members: Member[];
  tasks: NoteTaskOption[];
  milestones: NoteMilestoneOption[];
}

/**
 * §7.12 마지막 줄 "연결되면 해당 화면에서 역참조로 보인다".
 * Task·Milestone 화면이 쓰는 최소 정보만 담는다 — 본문(마크다운 원문)은 싣지 않는다.
 * 연결이 없는 노트는 애초에 돌려주지 않는다.
 */
export interface LinkedNote {
  id: string;
  title: string;
  type: NoteType;
  date: string;
  pinned: boolean;
  taskId: string | null;
  milestoneId: string | null;
}

// ─── 입력 검증 ────────────────────────────────────────────────

const uuidSchema = z.uuid();

const isoDateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "날짜는 'YYYY-MM-DD' 형식이어야 합니다.");

const titleSchema = z
  .string()
  .trim()
  .min(1, '제목을 입력하세요.')
  .max(200, '제목은 200자 이내여야 합니다.');

// 노트 본문은 회의록 여러 건이 쌓이는 자리라 다른 메모 필드(10,000자)보다 넉넉하게 잡는다.
// 무제한은 두지 않는다 — Realtime 페이로드와 백업 JSON이 함께 커진다.
const bodySchema = z.string().max(100_000, '본문은 100,000자 이내여야 합니다.');

const tagsSchema = z
  .array(z.string().trim().min(1, '빈 태그는 넣을 수 없습니다.').max(40, '태그는 40자 이내여야 합니다.'))
  .max(30, '태그는 30개까지 붙일 수 있습니다.');

const attendeeIdsSchema = z.array(z.uuid('참석자 ID 형식이 올바르지 않습니다.'));

const noteFieldsSchema = z.object({
  yearId: z.uuid().nullable(),
  taskId: z.uuid().nullable(),
  milestoneId: z.uuid().nullable(),
  type: noteTypeSchema,
  title: titleSchema,
  body: bodySchema,
  date: isoDateSchema,
  attendeeMemberIds: attendeeIdsSchema,
  tags: tagsSchema,
  pinned: z.boolean(),
});

// type은 DB에 기본값이 없다(not null + check). title은 기본값 ''이지만 제목 없는 노트는
// 목록에서 식별이 불가능하므로 생성 시 함께 받는다.
// projectId는 §5.14대로 nullable이다 — null이면 과제 무관 개인 노트다.
const noteCreateSchema = noteFieldsSchema.partial().extend({
  projectId: z.uuid().nullable(),
  type: noteFieldsSchema.shape.type,
  title: noteFieldsSchema.shape.title,
});

// projectId는 patch에 없다 — 노트를 다른 과제로 옮기면 연차·작업·마일스톤·참석자 참조가
// 전부 남의 과제를 가리키게 된다 (H-11과 같은 이유).
const notePatchSchema = noteFieldsSchema.partial();

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
      console.error('[actions/notes] 수정자 이름 조회 실패:', lookupError);
    }
  }
  return toActionFailure(e);
}

// 노트는 WBS 상세 패널·마일스톤 목록에도 역참조로 나온다 (§7.12) — 노트 화면만 다시
// 그리면 연결 배지가 낡은 채로 남는다
function revalidateNotes(projectId: string | null): void {
  if (projectId === null) return; // 개인 노트는 과제 화면에 나오지 않는다
  revalidatePath(`/projects/${projectId}/notes`);
  revalidatePath(`/projects/${projectId}/wbs`);
  revalidatePath(`/projects/${projectId}/milestones`);
}

// 연차·작업·마일스톤·참석자 참조는 반드시 그 노트가 속한 과제의 것이어야 한다.
// FK는 테이블만 강제할 뿐 과제 경계를 막지 못해서, 앱이 거르지 않으면 남의 과제 작업에
// 붙은 노트가 조용히 저장되고 그 화면에 역참조로 떠 버린다 (N-13, H-11과 같은 근거).
interface NoteRefs {
  yearId?: string | null;
  taskId?: string | null;
  milestoneId?: string | null;
  attendeeMemberIds?: readonly string[];
}

function hasAnyRef(refs: NoteRefs): boolean {
  return (
    refs.yearId != null ||
    refs.taskId != null ||
    refs.milestoneId != null ||
    (refs.attendeeMemberIds ?? []).length > 0
  );
}

/** NotFound만 흡수해 RULE로 바꾼다. 그 밖의 실패는 그대로 올린다 (절대 규칙 5) */
async function findOrNull<T>(load: () => Promise<T>): Promise<T | null> {
  try {
    return await load();
  } catch (e) {
    if (e instanceof NotFoundError) return null;
    throw e;
  }
}

async function assertNoteRefsInProject(
  client: SupabaseClient,
  projectId: string | null,
  refs: NoteRefs
): Promise<void> {
  if (projectId === null) {
    // 개인 노트(§5.14)에는 붙일 과제가 없다. 연차·작업·마일스톤·참석자는 전부 과제의 것이다.
    if (hasAnyRef(refs)) {
      throw new RuleViolationError('과제에 속하지 않은 개인 노트에는 연차·작업·마일스톤·참석자를 연결할 수 없습니다.');
    }
    return;
  }

  if (refs.yearId != null) {
    const years = await yearsRepo.listYears(client, projectId);
    if (!years.some((y) => y.id === refs.yearId)) {
      throw new RuleViolationError('이 과제에 속하지 않은 연차는 지정할 수 없습니다.');
    }
  }

  if (refs.taskId != null) {
    // 작업은 과제당 수백 건이라 목록 대신 대상 한 건만 읽는다
    const task = await findOrNull(() => tasksRepo.getTaskById(client, refs.taskId as string));
    if (!task || task.projectId !== projectId) {
      throw new RuleViolationError('이 과제에 속하지 않은 작업에는 노트를 연결할 수 없습니다.');
    }
  }

  if (refs.milestoneId != null) {
    const milestone = await findOrNull(() =>
      milestonesRepo.getMilestoneById(client, refs.milestoneId as string)
    );
    if (!milestone || milestone.projectId !== projectId) {
      throw new RuleViolationError('이 과제에 속하지 않은 마일스톤에는 노트를 연결할 수 없습니다.');
    }
  }

  const attendeeIds = new Set(refs.attendeeMemberIds ?? []);
  if (attendeeIds.size > 0) {
    const projectMembers = new Set(
      (await membersRepo.listMembers(client, projectId)).map((m) => m.id)
    );
    if ([...attendeeIds].some((id) => !projectMembers.has(id))) {
      throw new RuleViolationError('이 과제에 속하지 않은 인력은 참석자로 지정할 수 없습니다.');
    }
  }
}

// ─── CRUD (§5.14, §9 Note) ────────────────────────────────────

export async function createNote(input: unknown): Promise<ActionResult<Note>> {
  try {
    const fields = parseOrThrow(noteCreateSchema, input, '노트 정보가 올바르지 않습니다.');
    const { user, client } = await requireApprovedUser();

    await assertNoteRefsInProject(client, fields.projectId, {
      yearId: fields.yearId,
      taskId: fields.taskId,
      milestoneId: fields.milestoneId,
      attendeeMemberIds: fields.attendeeMemberIds,
    });

    const created = await notesRepo.createNote(client, {
      projectId: fields.projectId,
      yearId: fields.yearId ?? null,
      taskId: fields.taskId ?? null,
      milestoneId: fields.milestoneId ?? null,
      type: fields.type,
      title: fields.title,
      body: fields.body ?? '',
      // §5.14 "기본 오늘". DB의 current_date(서버 UTC 달력)에 맡기지 않고 Asia/Seoul
      // 달력으로 고정한다 (§6.5) — 한국 시각 자정 무렵의 노트가 하루 전으로 저장되면
      // 목록 정렬(날짜 내림차순)과 연차 귀속이 함께 어긋난다.
      date: fields.date ?? todayISO(new Date()),
      attendeeMemberIds: fields.attendeeMemberIds ?? [],
      tags: fields.tags ?? [],
      pinned: fields.pinned ?? false,
      createdBy: user.id,
      updatedBy: user.id,
    });

    revalidateNotes(created.projectId);
    return { ok: true, data: created };
  } catch (e) {
    return toFailure(e);
  }
}

// O-1: 노트 편집은 제목·본문·유형·날짜·태그·참석자·연결을 한 번에 바꾸므로 잠금을 건다.
// 화면의 3초 디바운스 자동 저장도 같은 경로를 쓴다 — 저장이 성공하면 돌아온 노트의
// version이 다음 자동 저장의 expectedVersion이 된다(가짜 STALE 방지는 화면 몫).
export async function updateNote(
  id: string,
  patch: unknown,
  expectedVersion?: number
): Promise<ActionResult<Note>> {
  let client: SupabaseClient | undefined;
  try {
    const nid = parseOrThrow(uuidSchema, id, '노트 ID 형식이 올바르지 않습니다.');
    const parsed = parseOrThrow(notePatchSchema, patch, '노트 정보가 올바르지 않습니다.');
    const ctx = await requireApprovedUser();
    client = ctx.client;

    // 참조가 patch에 들어올 때만 소속을 확인한다 (조회를 아끼기 위해).
    // 대상 노트가 없으면 getNoteById가 NotFound로 먼저 걸러 준다 — 삭제된 노트를
    // 자동 저장이 되살릴 수 없는 이유이기도 하다(update는 insert를 하지 않는다).
    if (
      parsed.yearId !== undefined ||
      parsed.taskId !== undefined ||
      parsed.milestoneId !== undefined ||
      parsed.attendeeMemberIds !== undefined
    ) {
      const before = await notesRepo.getNoteById(client, nid);
      await assertNoteRefsInProject(client, before.projectId, {
        yearId: parsed.yearId,
        taskId: parsed.taskId,
        milestoneId: parsed.milestoneId,
        attendeeMemberIds: parsed.attendeeMemberIds,
      });
    }

    const updated = await notesRepo.updateNote(
      client,
      nid,
      { ...parsed, updatedBy: ctx.user.id },
      expectedVersion
    );

    revalidateNotes(updated.projectId);
    return { ok: true, data: updated };
  } catch (e) {
    return toFailure(e, client);
  }
}

export async function deleteNote(id: string): Promise<ActionResult<null>> {
  try {
    const nid = parseOrThrow(uuidSchema, id, '노트 ID 형식이 올바르지 않습니다.');
    const { client } = await requireApprovedUser();

    // 삭제 후에는 projectId를 알 수 없으므로 먼저 읽는다 (없으면 NotFoundError)
    const note = await notesRepo.getNoteById(client, nid);
    await notesRepo.removeNote(client, nid); // note_attendees는 FK cascade (N-2)

    revalidateNotes(note.projectId);
    return { ok: true, data: null };
  } catch (e) {
    return toFailure(e);
  }
}

// §7.12 목록의 고정 토글. O-2: 사용자가 만지는 필드가 하나라 낙관적 잠금을 생략한다 —
// 마지막 것이 이기는 게 자연스럽다.
export async function togglePinNote(id: string): Promise<ActionResult<Note>> {
  try {
    const nid = parseOrThrow(uuidSchema, id, '노트 ID 형식이 올바르지 않습니다.');
    const { user, client } = await requireApprovedUser();

    const before = await notesRepo.getNoteById(client, nid);
    const updated = await notesRepo.updateNote(client, nid, {
      pinned: !before.pinned,
      updatedBy: user.id,
    });

    revalidateNotes(updated.projectId);
    return { ok: true, data: updated };
  } catch (e) {
    return toFailure(e);
  }
}

// ─── 조회 (§9 조회 목록 — 서버 컴포넌트에서 직접 호출) ────────

export async function getNotesData(projectId: string): Promise<ActionResult<NotesData>> {
  try {
    const pid = parseOrThrow(uuidSchema, projectId, '과제 ID 형식이 올바르지 않습니다.');
    const { client } = await requireApprovedUser();

    // 하나라도 실패하면 실패를 그대로 올린다 — 빈 배열 폴백은 데이터 손상을 감춘다 (절대 규칙 5)
    const [notes, years, members, tasks, milestones] = await Promise.all([
      notesRepo.listNotes(client, pid),
      yearsRepo.listYears(client, pid),
      membersRepo.listMembers(client, pid),
      tasksRepo.listTasksByProject(client, pid),
      milestonesRepo.listMilestones(client, pid),
    ]);

    return {
      ok: true,
      data: {
        projectId: pid,
        notes,
        years,
        members,
        tasks: tasks.map((task) => ({ id: task.id, title: task.title, yearId: task.yearId })),
        milestones: milestones.map((m) => ({ id: m.id, title: m.title, date: m.date })),
      },
    };
  } catch (e) {
    return toFailure(e);
  }
}

/** §7.12 역참조용. Task·Milestone에 연결된 노트만 추린다 */
export async function getLinkedNotes(projectId: string): Promise<ActionResult<LinkedNote[]>> {
  try {
    const pid = parseOrThrow(uuidSchema, projectId, '과제 ID 형식이 올바르지 않습니다.');
    const { client } = await requireApprovedUser();

    const notes = await notesRepo.listNotes(client, pid);
    return {
      ok: true,
      data: notes
        .filter((note) => note.taskId !== null || note.milestoneId !== null)
        .map((note) => ({
          id: note.id,
          title: note.title,
          type: note.type,
          date: note.date,
          pinned: note.pinned,
          taskId: note.taskId,
          milestoneId: note.milestoneId,
        })),
    };
  } catch (e) {
    return toFailure(e);
  }
}
