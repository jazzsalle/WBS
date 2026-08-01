// notes 리포지토리 (SOT §5.14, §8.6)
// attendeeMemberIds는 note_attendees 조인 테이블이다 (N-2) — Member 삭제 시
// FK cascade가 참조 제거를 보장하도록 jsonb가 아니라 조인으로 관리한다.

import type { PostgrestError, SupabaseClient } from '@supabase/supabase-js';
import { z } from 'zod';
import type { BaseEntity, Note } from '@/types';
import { appToDb, dbToApp } from './mapper';
import { noteRowSchema } from './schema';
import { ConflictError, NotFoundError, StaleDataError, ValidationError } from './errors';

const TABLE = 'notes';
const JOIN_TABLE = 'note_attendees';
const NOTE_SELECT = '*, note_attendees(member_id)';

// 조인 임베드 포함 select 결과 형태
const noteWithAttendeesSchema = noteRowSchema.extend({
  note_attendees: z.array(z.object({ member_id: z.uuid() })),
});
type NoteWithAttendeesRow = z.infer<typeof noteWithAttendeesSchema>;

// 서버 액션이 createdBy/updatedBy를 세션 사용자로 채운다 (SA-2)
export type NoteInput = Omit<Note, keyof BaseEntity> & {
  createdBy?: string | null;
  updatedBy?: string | null;
};

export type NotePatch = Partial<Omit<Note, keyof BaseEntity>> & {
  updatedBy?: string | null;
};

// 23505(unique 충돌)만 의미 있는 코드로 바꾸고 나머지는 그대로 던진다 —
// RepositoryError가 아닌 예외는 toActionFailure가 내부 정보를 감춘다 (SA-4).
function throwDbError(error: PostgrestError): never {
  if (error.code === '23505') throw new ConflictError();
  throw error;
}

// DB 응답 검증 실패 = 스키마 드리프트 신호. 조용히 넘기지 않는다 (§8.6, 절대 규칙 5).
function parseRow<T>(schema: z.ZodType<T>, row: unknown): T {
  const result = schema.safeParse(row);
  if (!result.success) {
    throw new ValidationError('DB 응답이 스키마와 일치하지 않습니다. 마이그레이션 누락 가능성이 있습니다.');
  }
  return result.data;
}

// undefined 값 키 제거 — JSON 직렬화에서 빠져 빈 body가 되는 것을 막고,
// "갱신할 내용 없음"을 명시적으로 판정하기 위함
function definedOnly(obj: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined));
}

// 조인 임베드를 앱 형태(§5.14 attendeeMemberIds)로 조립한다.
// note_attendees 키는 dbToApp에 넣기 전에 분리한다 — 매퍼가 키를 camelCase로 바꿔버리기 때문
function toNote(row: NoteWithAttendeesRow): Note {
  const { note_attendees, ...noteRow } = row;
  return {
    ...dbToApp<Omit<Note, 'attendeeMemberIds'>>(noteRow),
    attendeeMemberIds: note_attendees.map((a) => a.member_id),
  };
}

// 참석자 목록 전체 교체 (부분 갱신 없음 — UI가 항상 전체 목록을 보낸다).
// note+attendees 2단계 쓰기는 RPC 없이 수행한다 — X-1: 단순 CRUD는 PostgREST 직접.
// 중간 실패 시 예외를 그대로 던져 사용자에게 알린다 (절대 규칙 5).
async function replaceAttendees(
  client: SupabaseClient,
  noteId: string,
  memberIds: string[]
): Promise<void> {
  const { error: deleteError } = await client.from(JOIN_TABLE).delete().eq('note_id', noteId);
  if (deleteError) throwDbError(deleteError);
  // 같은 사람 중복 선택은 입력 정규화로 흡수한다 — unique(note_id, member_id) 충돌 방지
  const unique = [...new Set(memberIds)];
  if (unique.length === 0) return;
  const rows = unique.map((memberId) => appToDb({ noteId, memberId }));
  const { error: insertError } = await client.from(JOIN_TABLE).insert(rows);
  if (insertError) throwDbError(insertError);
}

// projectId가 null이면 과제 무관 개인 노트 목록 (§5.14)
export async function listNotes(client: SupabaseClient, projectId: string | null): Promise<Note[]> {
  let query = client.from(TABLE).select(NOTE_SELECT);
  query = projectId === null ? query.is('project_id', null) : query.eq('project_id', projectId);
  // N-7 인덱스 (project_id, date desc)와 같은 순서
  const { data, error } = await query.order('date', { ascending: false }).order('created_at', { ascending: false });
  if (error) throwDbError(error);
  return parseRow(z.array(noteWithAttendeesSchema), data ?? []).map(toNote);
}

export async function getNoteById(client: SupabaseClient, id: string): Promise<Note> {
  const { data, error } = await client.from(TABLE).select(NOTE_SELECT).eq('id', id).maybeSingle();
  if (error) throwDbError(error);
  if (!data) throw new NotFoundError();
  return toNote(parseRow(noteWithAttendeesSchema, data));
}

export async function createNote(client: SupabaseClient, input: NoteInput): Promise<Note> {
  const { attendeeMemberIds, ...noteFields } = input;
  const { data, error } = await client.from(TABLE).insert(appToDb(noteFields)).select('*').single();
  if (error) throwDbError(error);
  const created = parseRow(noteRowSchema, data);
  await replaceAttendees(client, created.id, attendeeMemberIds);
  return getNoteById(client, created.id);
}

export async function updateNote(
  client: SupabaseClient,
  id: string,
  patch: NotePatch,
  expectedVersion?: number
): Promise<Note> {
  const { attendeeMemberIds, ...noteFields } = patch;
  const dbPatch = definedOnly(appToDb(noteFields));

  if (Object.keys(dbPatch).length > 0) {
    let query = client.from(TABLE).update(dbPatch).eq('id', id);
    if (expectedVersion !== undefined) {
      query = query.eq('version', expectedVersion); // §8.4: 그새 바뀌었으면 0행 갱신
    }
    const { data, error } = await query.select('id');
    if (error) throwDbError(error);
    if ((data ?? []).length === 0) {
      // 0행 갱신의 원인 구분: 행이 없으면 NotFound, 있으면 낙관적 잠금 실패 (§8.4, O-3)
      const { data: latest, error: fetchError } = await client
        .from(TABLE).select('updated_by').eq('id', id).maybeSingle();
      if (fetchError) throwDbError(fetchError);
      if (!latest) throw new NotFoundError();
      throw new StaleDataError((latest as { updated_by: string | null }).updated_by);
    }
  } else if (attendeeMemberIds !== undefined) {
    // 참석자만 바꾸는 경우에도 낙관적 잠금 의도는 존중한다 — 노트 행의 version과 대조
    const { data, error } = await client
      .from(TABLE).select('version, updated_by').eq('id', id).maybeSingle();
    if (error) throwDbError(error);
    if (!data) throw new NotFoundError();
    const row = data as { version: number; updated_by: string | null };
    if (expectedVersion !== undefined && row.version !== expectedVersion) {
      throw new StaleDataError(row.updated_by);
    }
  } else {
    throw new ValidationError('갱신할 내용이 없습니다.');
  }

  if (attendeeMemberIds !== undefined) {
    await replaceAttendees(client, id, attendeeMemberIds);
  }
  return getNoteById(client, id);
}

export async function removeNote(client: SupabaseClient, id: string): Promise<void> {
  // note_attendees는 FK cascade로 함께 삭제된다 (N-2)
  const { data, error } = await client.from(TABLE).delete().eq('id', id).select('id');
  if (error) throwDbError(error);
  if ((data ?? []).length === 0) throw new NotFoundError();
}
