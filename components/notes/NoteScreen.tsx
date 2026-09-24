'use client';

// 노트 화면 컨테이너 (SOT §7.12, §8.4 O-2·O-3, §8.5 R-4)
// 좌측 목록 / 우측 뷰어-에디터 2단 레이아웃.
// 데이터는 전부 서버(page.tsx → getNotesData)가 조회해 내려준다.
// 정렬·필터·마크다운 파싱은 lib/notes.ts의 순수 함수만 쓴다 — 화면에서 규칙을 다시 쓰지 않는다.
// 쓰기는 전부 actions/notes.ts를 거친다. supabase를 직접 부르지 않는다 (§8.2 C-2).

import { useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import type { ActionResult, NoteType } from '@/types';
import type { ActionErrorCode } from '@/lib/db/errors';
import type { NotesData } from '@/actions/notes';
import { createNote, deleteNote, togglePinNote } from '@/actions/notes';
import { NOTE_TYPE_LABELS } from '@/lib/constants';
import { buildMeetingTemplate, collectTags, filterNotes, sortNotes, type NoteFilter } from '@/lib/notes';
import { setRealtimePaused } from '@/components/RealtimeRefresher';
import Button from '@/components/ui/Button';
import ErrorBanner from '@/components/ui/ErrorBanner';
import Modal from '@/components/ui/Modal';
import NoteList from './NoteList';
import MarkdownEditor from './MarkdownEditor';

export interface NoteScreenProps {
  data: NotesData;
  /** §6.5 기준일. 서버가 todayISO(new Date())로 Asia/Seoul 달력에 맞춰 고정한 값 */
  todayISO: string;
  /** 역참조 링크(?note=…)로 들어온 경우의 초기 선택. 목록에 없으면 무시한다 */
  initialNoteId?: string | null;
}

interface CreateDraft {
  title: string;
  type: NoteType;
  date: string;
  useTemplate: boolean;
}

export default function NoteScreen({ data, todayISO, initialNoteId = null }: NoteScreenProps) {
  const router = useRouter();
  const [filter, setFilter] = useState<NoteFilter>({});
  const [selectedId, setSelectedId] = useState<string | null>(initialNoteId);
  const [draft, setDraft] = useState<CreateDraft | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<{ message: string; code?: ActionErrorCode } | null>(null);

  const byId = useMemo(() => new Map(data.notes.map((note) => [note.id, note])), [data.notes]);

  // §7.12 고정 상단 → 날짜 내림차순. 필터를 먼저 걸고 정렬한다
  const visible = useMemo(
    () => sortNotes(filterNotes(data.notes, filter)),
    [data.notes, filter]
  );
  const tagOptions = useMemo(() => collectTags(data.notes), [data.notes]);

  const selected = selectedId === null ? null : (byId.get(selectedId) ?? null);
  const deleting = deletingId === null ? null : (byId.get(deletingId) ?? null);

  // 남이 지운 노트가 선택된 채로 남아 있으면 다음 조작이 사라진 행을 가리킨다
  useEffect(() => {
    if (selectedId !== null && !byId.has(selectedId)) setSelectedId(null);
    if (deletingId !== null && !byId.has(deletingId)) setDeletingId(null);
  }, [byId, selectedId, deletingId]);

  // R-4: 생성 모달이 열려 있는 동안 자동 새로고침을 보류한다 (입력 중인 내용 보호)
  useEffect(() => {
    if (draft === null) return;
    setRealtimePaused(true);
    return () => setRealtimePaused(false);
  }, [draft]);

  async function run<T>(
    action: () => Promise<ActionResult<T>>,
    onSuccess: (value: T) => void
  ): Promise<void> {
    setBusy(true);
    setFailure(null);
    try {
      const res = await action();
      if (!res.ok) {
        setFailure({ message: res.error, code: res.code });
        return;
      }
      onSuccess(res.data);
      router.refresh();
    } finally {
      setBusy(false);
    }
  }

  const handleCreate = (): void => {
    if (draft === null) return;
    const title = draft.title.trim();
    if (title === '') {
      setFailure({ message: '제목을 입력하세요.', code: 'VALIDATION' });
      return;
    }
    void run(
      () =>
        createNote({
          projectId: data.projectId,
          type: draft.type,
          title,
          date: draft.date,
          body: draft.useTemplate ? buildMeetingTemplate({ date: draft.date }) : '',
        }),
      (note) => {
        setDraft(null);
        setSelectedId(note.id); // 만든 노트를 바로 편집할 수 있게 연다
      }
    );
  };

  const handleDelete = (id: string): void => {
    void run(
      () => deleteNote(id),
      () => {
        setDeletingId(null);
        if (selectedId === id) setSelectedId(null);
      }
    );
  };

  const inputClass =
    'mt-1 w-full rounded-lg border border-grey-300 px-2.5 py-1.5 text-sm focus:border-grey-500 focus:outline-none';

  return (
    <div>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm text-grey-600">
          전체 {data.notes.length}건 · 마크다운으로 적고 미리보기로 확인합니다.
        </p>
        <Button
          size="sm"
          variant="primary"
          disabled={busy}
          onClick={() =>
            setDraft({ title: '', type: 'meeting', date: todayISO, useTemplate: true })
          }
        >
          새 노트
        </Button>
      </div>

      {failure && (
        <ErrorBanner
          message={failure.message}
          code={failure.code}
          onDismiss={() => setFailure(null)}
          className="mt-3"
        />
      )}

      {/* §7.12 2단 레이아웃. 좁은 화면에서는 목록이 위로 쌓인다 (§12 반응형) */}
      <div className="mt-4 grid gap-4 lg:grid-cols-[320px_minmax(0,1fr)]">
        <div className="lg:max-h-[calc(100vh-14rem)]">
          <NoteList
            notes={visible}
            totalCount={data.notes.length}
            years={data.years}
            tagOptions={tagOptions}
            filter={filter}
            onFilterChange={setFilter}
            selectedId={selectedId}
            onSelect={setSelectedId}
            onTogglePin={(id) => {
              // O-2: 단일 조작이라 낙관적 잠금 없이 저장한다
              void run(() => togglePinNote(id), () => undefined);
            }}
            busy={busy}
          />
        </div>

        {selected ? (
          <MarkdownEditor
            // 다른 노트를 고르면 초안을 새로 시작한다 (남의 본문이 섞이지 않게)
            key={selected.id}
            note={selected}
            years={data.years}
            members={data.members}
            tasks={data.tasks}
            milestones={data.milestones}
            paused={busy || deletingId !== null}
            onDelete={() => setDeletingId(selected.id)}
          />
        ) : (
          <div className="flex items-center justify-center rounded-xl border border-dashed border-grey-300 p-16 text-center text-sm text-grey-500">
            왼쪽 목록에서 노트를 고르거나 [새 노트]로 만드세요.
          </div>
        )}
      </div>

      {draft !== null && (
        <Modal
          open
          title="새 노트"
          onClose={() => setDraft(null)}
          closeOnBackdrop={false}
          footer={
            <>
              <Button size="sm" onClick={() => setDraft(null)} disabled={busy}>
                취소
              </Button>
              <Button size="sm" variant="primary" onClick={handleCreate} disabled={busy}>
                {busy ? '만드는 중…' : '만들기'}
              </Button>
            </>
          }
        >
          <label className="block">
            <span className="text-xs font-semibold text-grey-500">
              제목 <span className="text-red-600">*</span>
            </span>
            <input
              value={draft.title}
              onChange={(e) => setDraft({ ...draft, title: e.target.value })}
              maxLength={200}
              autoFocus
              className={inputClass}
            />
          </label>

          <div className="mt-3 grid grid-cols-2 gap-3">
            <label className="block">
              <span className="text-xs font-semibold text-grey-500">유형</span>
              <select
                value={draft.type}
                onChange={(e) => setDraft({ ...draft, type: e.target.value as NoteType })}
                className={`${inputClass} bg-surface`}
              >
                {(Object.keys(NOTE_TYPE_LABELS) as NoteType[]).map((type) => (
                  <option key={type} value={type}>
                    {NOTE_TYPE_LABELS[type]}
                  </option>
                ))}
              </select>
            </label>
            <label className="block">
              <span className="text-xs font-semibold text-grey-500">날짜</span>
              <input
                type="date"
                value={draft.date}
                onChange={(e) => setDraft({ ...draft, date: e.target.value })}
                className={inputClass}
              />
            </label>
          </div>

          <label className="mt-3 flex items-center gap-2 text-sm text-grey-600">
            <input
              type="checkbox"
              checked={draft.useTemplate}
              onChange={(e) => setDraft({ ...draft, useTemplate: e.target.checked })}
              className="h-4 w-4 rounded border-grey-300"
            />
            회의록 템플릿으로 시작 (일시·장소·참석자·안건·논의·결정사항·액션아이템)
          </label>
          <p className="mt-2 text-xs text-grey-500">
            연차·작업·마일스톤 연결과 참석자는 만든 뒤 편집기에서 지정합니다.
          </p>
        </Modal>
      )}

      {deleting && (
        <Modal
          open
          title="노트를 삭제합니다"
          onClose={() => setDeletingId(null)}
          closeOnBackdrop={false}
          footer={
            <>
              <Button size="sm" onClick={() => setDeletingId(null)} disabled={busy}>
                취소
              </Button>
              <Button
                size="sm"
                variant="danger"
                disabled={busy}
                onClick={() => handleDelete(deleting.id)}
              >
                {busy ? '삭제 중…' : '삭제'}
              </Button>
            </>
          }
        >
          <p className="text-sm text-grey-700">
            <strong>{deleting.title}</strong>({deleting.date})을 삭제합니다. 본문은 복구할 수 없습니다.
          </p>
          <p className="mt-3 rounded-lg bg-orange-50 p-3 text-xs text-orange-800">
            연결된 작업·마일스톤 화면의 역참조도 함께 사라집니다. 작업·마일스톤 자체는 지워지지
            않습니다.
          </p>
        </Modal>
      )}
    </div>
  );
}
