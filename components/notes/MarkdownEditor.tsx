'use client';

// 노트 뷰어-에디터 (SOT §7.12, §8.4 O-1·O-3, §8.5 R-4)
//
//  - 에디터는 마크다운 textarea. 프리뷰 토글(편집 / 분할 / 미리보기)로 같은 원문을 본다.
//  - 저장은 **명시적 저장 버튼 + 3초 디바운스 자동 저장** 병행 (§7.12).
//  - O-1: 제목·유형·날짜·태그·참석자·연결·본문을 한 번에 바꾸므로 낙관적 잠금을 건다.
//    저장에 쓰는 expectedVersion은 항상 baseline(마지막으로 받아들인 서버 값)의 것이고,
//    **저장이 성공하면 응답의 새 version을 baseline으로 삼는다** — 이걸 빠뜨리면 다음
//    자동 저장이 자기 저장에 대해 가짜 STALE을 낸다(PROGRESS.md Phase 1 후속 개선 ②).
//  - R-4: 저장되지 않은 입력이 있는 동안 자동 새로고침을 보류한다. 노트는 긴 글을 쓰는
//    화면이라 화면이 다시 그려지면 잃는 게 크다.
//  - 남이 먼저 저장해 version이 바뀌면 입력을 덮어쓰지 않고 비교 배너를 띄운다(O-3).
//    확인 전에는 자동 저장을 멈춘다 — 남의 수정을 조용히 덮어쓰지 않기 위해서다.
//  - 삭제는 부모(NoteScreen)가 확인 모달과 함께 처리한다. 삭제 중에는 paused로 자동 저장을
//    멈춘다. in-flight 자동 저장이 뒤늦게 도착해도 updateNote는 insert를 하지 않으므로
//    지워진 노트가 되살아나지 않는다(통합 테스트가 고정).
// 쓰기는 전부 actions/notes.ts를 거친다. supabase를 직접 부르지 않는다 (§8.2 C-2).

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import type { Member, Note, NoteType, Year } from '@/types';
import type { ActionErrorCode } from '@/lib/db/errors';
import type { NoteMilestoneOption, NoteTaskOption } from '@/actions/notes';
import { updateNote } from '@/actions/notes';
import { NOTE_TYPE_LABELS } from '@/lib/constants';
import { applyAttendeeLine, buildMeetingTemplate, parseTags } from '@/lib/notes';
import { setRealtimePaused } from '@/components/RealtimeRefresher';
import Button from '@/components/ui/Button';
import ErrorBanner from '@/components/ui/ErrorBanner';
import ConflictDialog from '@/components/ui/ConflictDialog';
import MarkdownViewer from './MarkdownViewer';

/** §7.12 "3초 디바운스 자동 저장" */
const AUTOSAVE_MS = 3000;

type ViewMode = 'edit' | 'split' | 'preview';

const VIEW_LABELS: Record<ViewMode, string> = {
  edit: '편집',
  split: '분할',
  preview: '미리보기',
};

interface FormValues {
  title: string;
  type: NoteType;
  date: string;
  yearId: string; // '' = 연차 없음
  taskId: string;
  milestoneId: string;
  tags: string; // 쉼표 구분 입력
  attendeeIds: string[];
  body: string;
}

/** 서버로 보내는 형태. dirty 판정도 이 형태로 한다 — 서버 정규화(트림·태그 분해)를 함께 반영해
 *  "저장했는데 계속 변경됨으로 보이는" 상태를 만들지 않는다 */
function toPayload(values: FormValues) {
  return {
    title: values.title.trim(),
    type: values.type,
    date: values.date,
    yearId: values.yearId === '' ? null : values.yearId,
    taskId: values.taskId === '' ? null : values.taskId,
    milestoneId: values.milestoneId === '' ? null : values.milestoneId,
    tags: parseTags(values.tags),
    attendeeMemberIds: values.attendeeIds,
    body: values.body,
  };
}

function toValues(note: Note): FormValues {
  return {
    title: note.title,
    type: note.type,
    date: note.date,
    yearId: note.yearId ?? '',
    taskId: note.taskId ?? '',
    milestoneId: note.milestoneId ?? '',
    tags: note.tags.join(', '),
    attendeeIds: [...note.attendeeMemberIds],
    body: note.body,
  };
}

/** §5.5: name이 있으면 name, 없으면 order+1 + '차년도' */
function yearLabel(year: Year): string {
  return year.name.trim() || `${year.order + 1}차년도`;
}

/**
 * 현재 선택된 id가 후보 목록에 없으면 선택지로 끼워 넣는다.
 * 빼 버리면 select가 빈 값으로 보여 '연결 없음'과 구분되지 않고, 그대로 저장하면
 * 연결이 조용히 끊긴다.
 */
function withSelected(
  options: { id: string; label: string }[],
  selected: string
): { id: string; label: string }[] {
  if (selected === '' || options.some((o) => o.id === selected)) return options;
  return [...options, { id: selected, label: '(목록에 없는 항목)' }];
}

export interface MarkdownEditorProps {
  /** 서버가 내려준 최신 노트. 부모가 note.id를 key로 주므로 노트를 바꾸면 새로 마운트된다 */
  note: Note;
  years: Year[];
  members: Member[];
  tasks: NoteTaskOption[];
  milestones: NoteMilestoneOption[];
  /** 삭제 확인 모달 등 부모가 바쁜 동안 자동 저장을 멈춘다 */
  paused?: boolean;
  onDelete: () => void;
}

export default function MarkdownEditor({
  note,
  years,
  members,
  tasks,
  milestones,
  paused = false,
  onDelete,
}: MarkdownEditorProps) {
  const router = useRouter();
  const [values, setValues] = useState<FormValues>(() => toValues(note));
  // O-3 비교 기준이자 저장에 쓰는 version의 유일한 출처
  const [baseline, setBaseline] = useState<Note>(note);
  const [viewMode, setViewMode] = useState<ViewMode>('split');
  const [saving, setSaving] = useState(false);
  const [savedAt, setSavedAt] = useState<string | null>(null);
  const [failure, setFailure] = useState<{ message: string; code?: ActionErrorCode } | null>(null);
  const [conflict, setConflict] = useState<string | null>(null);
  const [reloaded, setReloaded] = useState(false);

  const savingRef = useRef(false);
  const dirtyRef = useRef(false);

  const payload = useMemo(() => toPayload(values), [values]);
  const baselinePayload = useMemo(() => toPayload(toValues(baseline)), [baseline]);
  const dirty = JSON.stringify(payload) !== JSON.stringify(baselinePayload);
  // 렌더 중에 넣는다 — 아래 version 변경 effect가 "지금 이 렌더 시점의 dirty"를 봐야
  // 하는데, effect 안에서 갱신하면 한 커밋 늦은 값을 보게 된다
  dirtyRef.current = dirty;

  const memberNameById = useMemo(
    () => new Map(members.map((m) => [m.id, m.name])),
    [members]
  );
  const attendeeNames = useMemo(
    () => values.attendeeIds.map((id) => memberNameById.get(id) ?? '(삭제된 인력)'),
    [values.attendeeIds, memberNameById]
  );

  const yearOptions = useMemo(
    () => years.map((year) => ({ id: year.id, label: yearLabel(year) })),
    [years]
  );
  const taskOptions = useMemo(
    () => tasks.map((task) => ({ id: task.id, label: task.title })),
    [tasks]
  );
  const milestoneOptions = useMemo(
    () => milestones.map((m) => ({ id: m.id, label: `${m.date} ${m.title}` })),
    [milestones]
  );

  // R-4: 저장되지 않은 입력이 있는 동안만 자동 새로고침을 보류한다.
  // 항상 보류하면 남의 변경이 영원히 안 보이고, 보류하지 않으면 쓰던 글이 날아간다.
  useEffect(() => {
    if (!dirty) return;
    setRealtimePaused(true);
    return () => setRealtimePaused(false);
  }, [dirty]);

  // 서버가 새 version을 내려주면(내 저장 후 refresh 또는 남의 저장) 기준을 갱신한다.
  // 편집 중이 아니면 최신 내용을 그대로 받아들이고, 편집 중이면 입력을 건드리지 않고
  // 비교 배너만 띄운다 (O-3: 작업 내용을 날리지 않는다).
  const baselineVersion = baseline.version;
  useEffect(() => {
    if (note.version === baselineVersion) return;
    setBaseline(note);
    setConflict(null);
    if (dirtyRef.current) {
      setReloaded(true);
      return;
    }
    setValues(toValues(note));
  }, [note, baselineVersion]);

  const save = useCallback(async (): Promise<void> => {
    if (savingRef.current) return;
    savingRef.current = true;
    setSaving(true);
    setFailure(null);
    try {
      // O-1: 비교를 끝낸 baseline의 version을 조건으로 건다
      const res = await updateNote(note.id, toPayload(values), baseline.version);
      if (!res.ok) {
        // O-3: STALE은 배너가 아니라 선택 다이얼로그로 — 입력은 그대로 둔다
        if (res.code === 'STALE') setConflict(res.error);
        else setFailure({ message: res.error, code: res.code });
        return;
      }
      // 자기 저장에 대한 가짜 STALE 방지: 응답의 새 version이 다음 저장의 기준이 된다
      setBaseline(res.data);
      setReloaded(false);
      setSavedAt(new Date().toLocaleTimeString('ko-KR'));
      router.refresh();
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  }, [note.id, values, baseline.version, router]);

  // §7.12 3초 디바운스 자동 저장. values가 바뀔 때마다 타이머가 다시 시작한다.
  // 충돌 확인 전(reloaded)·삭제 중(paused)에는 자동 저장하지 않는다.
  useEffect(() => {
    if (!dirty || saving || paused || reloaded || conflict !== null) return;
    const timer = setTimeout(() => {
      void save();
    }, AUTOSAVE_MS);
    return () => clearTimeout(timer);
  }, [dirty, saving, paused, reloaded, conflict, save]);

  const patchValue = <K extends keyof FormValues>(key: K, value: FormValues[K]): void => {
    setValues((prev) => ({ ...prev, [key]: value }));
  };

  // §7.12 "참석자는 Member에서 다중 선택 (자동으로 본문 상단에 삽입)"
  const toggleAttendee = (memberId: string, checked: boolean): void => {
    setValues((prev) => {
      const next = checked
        ? [...prev.attendeeIds, memberId]
        : prev.attendeeIds.filter((id) => id !== memberId);
      // 선택 순서가 아니라 명단 순서(members)로 고정한다 — 체크 순서로 본문이 흔들리지 않게
      const ordered = members.filter((m) => next.includes(m.id)).map((m) => m.id);
      const names = ordered.map((id) => memberNameById.get(id) ?? '(삭제된 인력)');
      return { ...prev, attendeeIds: ordered, body: applyAttendeeLine(prev.body, names) };
    });
  };

  // §7.12 회의록 템플릿 버튼. 기존 본문을 지우지 않고 위에 붙인다
  const insertTemplate = (): void => {
    setValues((prev) => {
      const template = buildMeetingTemplate({ date: prev.date, attendeeNames });
      return { ...prev, body: prev.body.trim() === '' ? template : `${template}\n${prev.body}` };
    });
  };

  const inputClass =
    'mt-1 w-full rounded-lg border border-grey-300 px-2.5 py-1.5 text-sm focus:border-grey-500 focus:outline-none';
  const busy = saving || paused;

  const statusText = saving
    ? '저장 중…'
    : dirty
      ? '변경됨 · 3초 후 자동 저장'
      : savedAt
        ? `저장됨 ${savedAt}`
        : '저장된 상태';

  return (
    <section aria-label="노트 편집" className="flex min-h-0 flex-col rounded-xl border border-grey-200 bg-surface">
      <header className="border-b border-grey-200 p-4">
        <div className="flex flex-wrap items-start gap-3">
          <label className="min-w-0 flex-1">
            <span className="text-xs font-semibold text-grey-500">
              제목 <span className="text-red-600">*</span>
            </span>
            <input
              value={values.title}
              onChange={(e) => patchValue('title', e.target.value)}
              maxLength={200}
              className={inputClass}
            />
          </label>
          <label className="w-32">
            <span className="text-xs font-semibold text-grey-500">유형</span>
            <select
              value={values.type}
              onChange={(e) => patchValue('type', e.target.value as NoteType)}
              className={`${inputClass} bg-surface`}
            >
              {(Object.keys(NOTE_TYPE_LABELS) as NoteType[]).map((type) => (
                <option key={type} value={type}>
                  {NOTE_TYPE_LABELS[type]}
                </option>
              ))}
            </select>
          </label>
          <label className="w-40">
            <span className="text-xs font-semibold text-grey-500">날짜</span>
            <input
              type="date"
              value={values.date}
              onChange={(e) => patchValue('date', e.target.value)}
              className={inputClass}
            />
          </label>
        </div>

        <div className="mt-3 grid gap-3 sm:grid-cols-3">
          <label>
            <span className="text-xs font-semibold text-grey-500">연차</span>
            <select
              value={values.yearId}
              onChange={(e) => patchValue('yearId', e.target.value)}
              className={`${inputClass} bg-surface`}
            >
              <option value="">연차 없음</option>
              {withSelected(yearOptions, values.yearId).map((option) => (
                <option key={option.id} value={option.id}>
                  {option.label}
                </option>
              ))}
            </select>
          </label>
          <label>
            <span className="text-xs font-semibold text-grey-500">작업 연결</span>
            <select
              value={values.taskId}
              onChange={(e) => patchValue('taskId', e.target.value)}
              className={`${inputClass} bg-surface`}
            >
              <option value="">연결 없음</option>
              {withSelected(taskOptions, values.taskId).map((option) => (
                <option key={option.id} value={option.id}>
                  {option.label}
                </option>
              ))}
            </select>
          </label>
          <label>
            <span className="text-xs font-semibold text-grey-500">마일스톤 연결</span>
            <select
              value={values.milestoneId}
              onChange={(e) => patchValue('milestoneId', e.target.value)}
              className={`${inputClass} bg-surface`}
            >
              <option value="">연결 없음</option>
              {withSelected(milestoneOptions, values.milestoneId).map((option) => (
                <option key={option.id} value={option.id}>
                  {option.label}
                </option>
              ))}
            </select>
          </label>
        </div>

        <label className="mt-3 block">
          <span className="text-xs font-semibold text-grey-500">태그 (쉼표 구분)</span>
          <input
            value={values.tags}
            onChange={(e) => patchValue('tags', e.target.value)}
            placeholder="예: 킥오프, 1차년도"
            className={inputClass}
          />
        </label>

        <fieldset className="mt-3 rounded-lg border border-grey-200 p-3">
          <legend className="px-1 text-xs font-semibold text-grey-500">
            참석자 ({values.attendeeIds.length}명) · 고르면 본문 상단 참석자 줄이 함께 바뀝니다
          </legend>
          {members.length === 0 ? (
            <p className="text-xs text-grey-500">
              등록된 인력이 없습니다. [인력·기관] 화면에서 먼저 등록하세요.
            </p>
          ) : (
            <div className="flex max-h-28 flex-wrap gap-x-4 gap-y-1 overflow-y-auto">
              {members.map((member) => (
                <label key={member.id} className="flex items-center gap-1.5 text-xs text-grey-600">
                  <input
                    type="checkbox"
                    checked={values.attendeeIds.includes(member.id)}
                    onChange={(e) => toggleAttendee(member.id, e.target.checked)}
                    className="h-4 w-4 rounded border-grey-300"
                  />
                  {member.active ? member.name : `${member.name} (참여종료)`}
                </label>
              ))}
            </div>
          )}
        </fieldset>
      </header>

      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-grey-200 px-4 py-2">
        <div className="flex items-center gap-1" role="group" aria-label="보기 모드">
          {(Object.keys(VIEW_LABELS) as ViewMode[]).map((mode) => (
            <button
              key={mode}
              type="button"
              onClick={() => setViewMode(mode)}
              aria-pressed={viewMode === mode}
              className={`rounded-lg px-2.5 py-1 text-xs font-semibold ${
                viewMode === mode
                  ? 'bg-grey-900 text-surface'
                  : 'border border-grey-300 bg-surface text-grey-600 hover:bg-grey-50'
              }`}
            >
              {VIEW_LABELS[mode]}
            </button>
          ))}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button size="sm" onClick={insertTemplate} disabled={busy}>
            회의록 템플릿
          </Button>
          <Button size="sm" variant="danger" onClick={onDelete} disabled={busy}>
            삭제
          </Button>
        </div>
      </div>

      {failure && (
        <ErrorBanner
          message={failure.message}
          code={failure.code}
          onDismiss={() => setFailure(null)}
          className="m-4"
        />
      )}

      {reloaded && (
        // O-3: 입력은 그대로 두고 사용자가 고르게 한다. 고르기 전에는 자동 저장을 멈춘다.
        <div role="status" className="m-4 rounded-xl border border-orange-200 bg-orange-50 p-3 text-sm text-orange-800">
          <p className="font-semibold">다른 사람이 이 노트를 수정했습니다.</p>
          <p className="mt-1 text-xs">
            내 입력은 그대로 두었습니다. 최신 본문으로 갈아끼우거나, 내 입력을 유지한 채 저장할 수
            있습니다. 유지하고 저장하면 최신 내용을 덮어씁니다.
          </p>
          <div className="mt-2 flex flex-wrap gap-2">
            <button
              type="button"
              onClick={() => {
                setValues(toValues(baseline));
                setReloaded(false);
              }}
              className="rounded-md border border-orange-300 px-2 py-0.5 text-xs font-semibold text-orange-800"
            >
              최신 내용 사용 (내 입력 버림)
            </button>
            <button
              type="button"
              onClick={() => setReloaded(false)}
              className="rounded-md border border-orange-300 px-2 py-0.5 text-xs font-semibold text-orange-800"
            >
              내 입력 유지
            </button>
          </div>
        </div>
      )}

      <div className="min-h-0 flex-1 p-4">
        <div className={viewMode === 'split' ? 'grid gap-4 lg:grid-cols-2' : ''}>
          {viewMode !== 'preview' && (
            <label className="block">
              <span className="sr-only">본문 (마크다운)</span>
              <textarea
                value={values.body}
                onChange={(e) => patchValue('body', e.target.value)}
                rows={22}
                spellCheck={false}
                placeholder="# 제목&#10;- [ ] 액션 아이템&#10;**굵게**, *기울임*, `코드`, [링크](https://…)"
                className="w-full resize-y rounded-lg border border-grey-300 p-3 font-mono text-sm leading-6 focus:border-grey-500 focus:outline-none"
              />
            </label>
          )}
          {viewMode !== 'edit' && (
            <div className="min-w-0 overflow-y-auto rounded-lg border border-grey-200 bg-grey-50/50 p-3">
              <MarkdownViewer source={values.body} />
            </div>
          )}
        </div>
      </div>

      <footer className="flex flex-wrap items-center justify-between gap-2 border-t border-grey-200 p-4">
        <div className="flex items-center gap-2 text-xs text-grey-500">
          <span
            className={dirty ? 'font-semibold text-orange-700' : undefined}
            role="status"
            aria-live="polite"
          >
            {statusText}
          </span>
          <span title="저장 시 조건으로 거는 version (O-1)">· 기준 v{baseline.version}</span>
        </div>
        <Button size="sm" variant="primary" onClick={() => void save()} disabled={busy || !dirty}>
          {saving ? '저장 중…' : '저장'}
        </Button>
      </footer>

      {conflict !== null && (
        <ConflictDialog
          message={conflict}
          onReload={() => {
            setConflict(null);
            // 최신 값을 다시 가져온다. 도착하면 baseline만 갱신되고 비교 배너가 열린다 (O-3)
            router.refresh();
          }}
          onKeepEditing={() => setConflict(null)}
        />
      )}
    </section>
  );
}
