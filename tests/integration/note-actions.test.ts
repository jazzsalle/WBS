// Note 서버 액션 통합 테스트 (SOT §9 Note, §5.14, §7.12, §8.4 O-1~O-3)
//
// 서버 액션은 쿠키 세션(requireApprovedUser)에서 토큰을 읽으므로 next/headers를
// "실제 세션 토큰을 돌려주는 스텁"으로 바꿔 액션을 가드까지 포함해 그대로 호출한다
// (milestone-actions.test.ts와 같은 방식). revalidatePath는 요청 컨텍스트 밖이라 스텁한다.
//
// 검증의 핵심:
//  1. 과제 경계 — yearId·taskId·milestoneId·attendeeMemberIds는 FK가 과제를 강제하지 않는다.
//     앱이 막지 못하면 남의 과제 작업에 붙은 노트가 저장되고 그 화면에 역참조로 뜬다.
//  2. 낙관적 잠금 — 3초 디바운스 자동 저장(§7.12)이 매번 expectedVersion을 보내므로
//     STALE 판정이 정확해야 한다.
//  3. 삭제된 노트를 자동 저장이 되살리지 못한다 — updateNote는 어떤 경우에도 insert하지 않는다.

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Sql } from 'postgres';
import { connectDirectDb, createTestUser, destroyTestUser, type TestUser } from './helpers';
import type { ActionResult } from '@/types';
import * as notesRepo from '@/lib/db/notes';
import * as yearsRepo from '@/lib/db/years';

const session = vi.hoisted(() => ({ accessToken: '' }));

vi.mock('next/headers', () => ({
  cookies: async () => ({ get: () => ({ value: session.accessToken }) }),
}));
vi.mock('next/cache', () => ({ revalidatePath: () => undefined }));

const notes = await import('@/actions/notes');
const team = await import('@/actions/team');
const tasks = await import('@/actions/tasks');
const milestones = await import('@/actions/milestones');
const { createProject } = await import('@/actions/projects');

let sql: Sql;
let user: TestUser;
const tempProjectIds: string[] = []; // afterAll 안전망 — 이 테스트가 만든 과제만 지운다
const personalNoteIds: string[] = []; // project_id=null 노트는 과제 삭제로 지워지지 않는다

let projectId: string;
let yearId: string;
let memberId: string;
let taskId: string;
let milestoneId: string;

let otherProjectId: string;
let otherYearId: string;
let otherMemberId: string;
let otherTaskId: string;
let otherMilestoneId: string;

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

function expectRuleViolation(result: ActionResult<unknown>): string {
  return expectCode(result, 'RULE');
}

async function newProject(name: string): Promise<string> {
  const project = unwrap(await createProject({ name, contractStartDate: '2026-01-01' }));
  tempProjectIds.push(project.id);
  return project.id;
}

beforeAll(async () => {
  sql = connectDirectDb();
  user = await createTestUser(sql);
  session.accessToken = user.accessToken;

  projectId = await newProject('노트 액션 테스트 과제');
  const firstYear = (await yearsRepo.listYears(user.client, projectId))[0];
  if (!firstYear) throw new Error('createProject가 연차를 만들지 않았습니다.');
  yearId = firstYear.id;
  memberId = unwrap(await team.createMember(projectId, { name: '김연구' })).id;
  taskId = unwrap(await tasks.createTask(yearId, { title: '요구사항 분석' })).id;
  milestoneId = unwrap(
    await milestones.createMilestone(projectId, {
      type: 'annual_eval',
      title: '1차년도 연차평가',
      date: '2026-12-15',
    })
  ).id;

  otherProjectId = await newProject('노트 액션 남의 과제');
  const otherYear = (await yearsRepo.listYears(user.client, otherProjectId))[0];
  if (!otherYear) throw new Error('createProject가 연차를 만들지 않았습니다.');
  otherYearId = otherYear.id;
  otherMemberId = unwrap(await team.createMember(otherProjectId, { name: '남의 연구원' })).id;
  otherTaskId = unwrap(await tasks.createTask(otherYearId, { title: '남의 작업' })).id;
  otherMilestoneId = unwrap(
    await milestones.createMilestone(otherProjectId, {
      type: 'report',
      title: '남의 보고서',
      date: '2026-06-30',
    })
  ).id;
});

afterAll(async () => {
  for (const id of personalNoteIds) {
    await sql`delete from public.notes where id = ${id}::uuid`;
  }
  for (const id of tempProjectIds) {
    await sql`delete from public.projects where id = ${id}::uuid`;
  }
  await destroyTestUser(sql, user);
  await sql.end();
});

describe('Note CRUD 액션 (§9, §5.14)', () => {
  let noteId: string;

  it('생성 시 §5.14 기본값을 채운다', async () => {
    const created = unwrap(
      await notes.createNote({ projectId, type: 'meeting', title: '킥오프 회의' })
    );
    noteId = created.id;

    expect(created.projectId).toBe(projectId);
    expect(created.body).toBe('');
    expect(created.tags).toEqual([]);
    expect(created.attendeeMemberIds).toEqual([]);
    expect(created.pinned).toBe(false);
    expect(created.yearId).toBeNull();
    expect(created.taskId).toBeNull();
    expect(created.milestoneId).toBeNull();
    expect(created.date).toMatch(/^\d{4}-\d{2}-\d{2}$/); // 기본 오늘 (Asia/Seoul, §6.5)
    expect(created.version).toBe(1); // N-4 default
  });

  it('유형·제목은 생략할 수 없고 날짜 형식을 강제한다', async () => {
    expectCode(await notes.createNote({ projectId, title: '유형 없음' }), 'VALIDATION');
    expectCode(await notes.createNote({ projectId, type: 'tech' }), 'VALIDATION');
    expectCode(await notes.createNote({ projectId, type: 'tech', title: '  ' }), 'VALIDATION');
    expectCode(
      await notes.createNote({ projectId, type: 'tech', title: '메모', date: '2026/01/01' }),
      'VALIDATION'
    );
    expectCode(
      await notes.createNote({ projectId, type: '회의록', title: '메모' }),
      'VALIDATION'
    );
  });

  it('연차·작업·마일스톤 연결과 참석자를 함께 저장한다 (§7.12)', async () => {
    const updated = unwrap(
      await notes.updateNote(
        noteId,
        {
          yearId,
          taskId,
          milestoneId,
          attendeeMemberIds: [memberId, memberId], // 중복 선택은 리포지토리가 흡수한다 (N-2)
          tags: ['킥오프', '1차년도'],
          body: '- 참석자: 김연구\n\n## 결정사항\n- [ ] 데이터 수집 일정 확정',
          date: '2026-02-10',
        },
        1
      )
    );

    expect(updated.yearId).toBe(yearId);
    expect(updated.taskId).toBe(taskId);
    expect(updated.milestoneId).toBe(milestoneId);
    expect(updated.attendeeMemberIds).toEqual([memberId]);
    expect(updated.tags).toEqual(['킥오프', '1차년도']);
    expect(updated.date).toBe('2026-02-10');
    expect(updated.version).toBe(2); // N-5 트리거
  });

  it('다른 과제의 연차·작업·마일스톤·참석자는 거부한다 (FK는 과제 경계를 막지 못한다)', async () => {
    const before = await notesRepo.getNoteById(user.client, noteId);

    expect(
      expectRuleViolation(await notes.updateNote(noteId, { yearId: otherYearId }))
    ).toContain('연차');
    expect(
      expectRuleViolation(await notes.updateNote(noteId, { taskId: otherTaskId }))
    ).toContain('작업');
    expect(
      expectRuleViolation(await notes.updateNote(noteId, { milestoneId: otherMilestoneId }))
    ).toContain('마일스톤');
    expect(
      expectRuleViolation(await notes.updateNote(noteId, { attendeeMemberIds: [otherMemberId] }))
    ).toContain('참석자');

    // 거부됐으므로 아무것도 저장되지 않아야 한다 (version도 그대로)
    const after = await notesRepo.getNoteById(user.client, noteId);
    expect(after.yearId).toBe(before.yearId);
    expect(after.taskId).toBe(before.taskId);
    expect(after.milestoneId).toBe(before.milestoneId);
    expect(after.attendeeMemberIds).toEqual(before.attendeeMemberIds);
    expect(after.version).toBe(before.version);
  });

  it('생성 시점에도 남의 과제 참조를 거부하고 행을 만들지 않는다', async () => {
    const countBefore = (await notesRepo.listNotes(user.client, projectId)).length;

    const base = { projectId, type: 'issue' as const, title: '경계 침범 시도' };
    expectRuleViolation(await notes.createNote({ ...base, yearId: otherYearId }));
    expectRuleViolation(await notes.createNote({ ...base, taskId: otherTaskId }));
    expectRuleViolation(await notes.createNote({ ...base, milestoneId: otherMilestoneId }));
    expectRuleViolation(await notes.createNote({ ...base, attendeeMemberIds: [otherMemberId] }));

    expect((await notesRepo.listNotes(user.client, projectId)).length).toBe(countBefore);
  });

  it('존재하지 않는 작업·마일스톤도 거부한다', async () => {
    const missing = '00000000-0000-4000-8000-000000000000';
    expectRuleViolation(await notes.updateNote(noteId, { taskId: missing }));
    expectRuleViolation(await notes.updateNote(noteId, { milestoneId: missing }));
  });

  it('수정은 낙관적 잠금을 건다 (O-1, O-3)', async () => {
    const before = await notesRepo.getNoteById(user.client, noteId);

    const updated = unwrap(
      await notes.updateNote(noteId, { title: '킥오프 회의(확정)' }, before.version)
    );
    expect(updated.title).toBe('킥오프 회의(확정)');
    expect(updated.version).toBe(before.version + 1);

    // 같은(이제는 낡은) version으로 다시 저장하면 STALE이다
    const message = expectCode(
      await notes.updateNote(noteId, { title: '덮어쓰기' }, before.version),
      'STALE'
    );
    expect(message).toContain('먼저 수정했습니다'); // O-3

    // 실패한 저장이 내용을 바꾸지 않았는지 확인한다
    const after = await notesRepo.getNoteById(user.client, noteId);
    expect(after.title).toBe('킥오프 회의(확정)');

    // 자동 저장은 성공 응답의 새 version을 기준으로 이어간다 — 가짜 STALE이 없어야 한다
    const again = unwrap(await notes.updateNote(noteId, { body: '이어 쓰기' }, updated.version));
    expect(again.body).toBe('이어 쓰기');
  });

  it('고정 토글은 잠금 없이 뒤집는다 (O-2)', async () => {
    const before = await notesRepo.getNoteById(user.client, noteId);
    const pinned = unwrap(await notes.togglePinNote(noteId));
    expect(pinned.pinned).toBe(!before.pinned);

    const unpinned = unwrap(await notes.togglePinNote(noteId));
    expect(unpinned.pinned).toBe(before.pinned);
  });

  it('본문에 스크립트를 넣어도 원문 그대로 저장된다 (렌더가 막는다 — tests/unit/notes.test.ts)', async () => {
    const hostile = '<script>alert(1)</script>\n\n[클릭](javascript:alert(1))';
    const current = await notesRepo.getNoteById(user.client, noteId);
    const saved = unwrap(await notes.updateNote(noteId, { body: hostile }, current.version));
    // 저장 단계에서 임의로 지우지 않는다 — 사용자가 쓴 글자를 조용히 바꾸지 않는다
    expect(saved.body).toBe(hostile);
  });

  it('삭제하면 목록에서 사라지고, 뒤늦은 자동 저장이 되살리지 못한다', async () => {
    const current = await notesRepo.getNoteById(user.client, noteId);
    unwrap(await notes.deleteNote(noteId));

    const list = await notesRepo.listNotes(user.client, projectId);
    expect(list.map((n) => n.id)).not.toContain(noteId);

    // in-flight 자동 저장이 뒤늦게 도착한 상황 — update는 어떤 경우에도 insert하지 않는다
    const late = await notes.updateNote(noteId, { body: '늦게 도착한 자동 저장' }, current.version);
    if (late.ok) throw new Error('삭제된 노트에 대한 자동 저장이 통과했습니다.');
    const after = await notesRepo.listNotes(user.client, projectId);
    expect(after.map((n) => n.id)).not.toContain(noteId);

    // 두 번 지울 수 없다
    const failed = await notes.deleteNote(noteId);
    if (failed.ok) throw new Error('이미 지운 노트 삭제가 통과했습니다.');
    expect(failed.code).toBeUndefined(); // NotFound — §9 코드 체계에 NOT_FOUND가 없다
  });
});

describe('개인 노트 (§5.14 projectId null)', () => {
  it('과제 참조를 붙이면 거부한다', () => {
    // 붙일 과제가 없으므로 연차·작업·마일스톤·참석자는 전부 남의 것이다
    return (async () => {
      expectRuleViolation(
        await notes.createNote({ projectId: null, type: 'idea', title: '개인 메모', taskId })
      );
      expectRuleViolation(
        await notes.createNote({
          projectId: null,
          type: 'idea',
          title: '개인 메모',
          attendeeMemberIds: [memberId],
        })
      );
    })();
  });

  it('참조 없는 개인 노트는 만들 수 있고 과제 목록에는 나오지 않는다', async () => {
    const created = unwrap(
      await notes.createNote({ projectId: null, type: 'idea', title: '개인 메모' })
    );
    personalNoteIds.push(created.id);

    expect(created.projectId).toBeNull();
    const projectNotes = await notesRepo.listNotes(user.client, projectId);
    expect(projectNotes.map((n) => n.id)).not.toContain(created.id);

    unwrap(await notes.deleteNote(created.id));
  });
});

describe('getNotesData / getLinkedNotes (§9 조회, §7.12)', () => {
  it('노트·연차·인력·작업·마일스톤 후보를 함께 싣는다', async () => {
    const created = unwrap(
      await notes.createNote({
        projectId,
        type: 'tech',
        title: '전처리 파이프라인 메모',
        date: '2026-03-02',
        taskId,
        attendeeMemberIds: [memberId],
        tags: ['전처리'],
      })
    );

    const data = unwrap(await notes.getNotesData(projectId));
    expect(data.projectId).toBe(projectId);
    expect(data.notes.map((n) => n.id)).toContain(created.id);
    expect(data.years.map((y) => y.id)).toContain(yearId);
    expect(data.members.map((m) => m.id)).toEqual([memberId]);
    expect(data.tasks.map((t) => t.id)).toContain(taskId);
    expect(data.milestones.map((m) => m.id)).toContain(milestoneId);
    // 남의 과제 것은 후보에 섞이지 않는다
    expect(data.tasks.map((t) => t.id)).not.toContain(otherTaskId);
    expect(data.milestones.map((m) => m.id)).not.toContain(otherMilestoneId);

    const linked = unwrap(await notes.getLinkedNotes(projectId));
    expect(linked.map((n) => n.id)).toEqual([created.id]);
    expect(linked[0]?.taskId).toBe(taskId);
    expect(linked[0]?.milestoneId).toBeNull();

    unwrap(await notes.deleteNote(created.id));
  });

  it('연결이 없는 노트는 역참조 목록에 나오지 않는다', async () => {
    const created = unwrap(
      await notes.createNote({ projectId, type: 'other', title: '연결 없는 노트' })
    );
    expect(unwrap(await notes.getLinkedNotes(projectId))).toEqual([]);
    unwrap(await notes.deleteNote(created.id));
  });

  it('노트가 없는 과제도 실패가 아니라 빈 목록을 돌려준다', async () => {
    const emptyProjectId = await newProject('노트 없는 과제');
    const data = unwrap(await notes.getNotesData(emptyProjectId));
    expect(data.notes).toEqual([]);
    expect(data.tasks).toEqual([]);
    expect(data.years.length).toBe(1); // createProject가 만든 기본 연차
  });

  it('§7.12 목록 순서의 원본 정렬은 날짜 내림차순이다 (고정 정렬은 화면 몫)', async () => {
    const dates = ['2026-01-05', '2026-04-20', '2026-02-11'];
    const ids: string[] = [];
    for (const date of dates) {
      ids.push(
        unwrap(await notes.createNote({ projectId, type: 'other', title: `노트 ${date}`, date })).id
      );
    }

    const data = unwrap(await notes.getNotesData(projectId));
    const created = data.notes.filter((n) => ids.includes(n.id));
    expect(created.map((n) => n.date)).toEqual([...dates].sort().reverse());

    for (const id of ids) unwrap(await notes.deleteNote(id));
  });
});
