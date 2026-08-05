'use client';

// 마일스톤 목록 테이블 (SOT §7.8 "하단 목록 테이블: 날짜 / 유형 / 제목 / 연차 / 담당 / 상태 / D-day")
// 표시 규칙:
//  - 지연·임박·D-day는 서버 기준일로 lib/dates.ts가 판정한 값(MilestoneView)만 쓴다.
//    여기서 날짜를 다시 비교하지 않는다 (§6.5).
//  - 유형·상태는 부록 A.4 라벨 맵으로만 그린다 — 원시 enum 문자열을 노출하지 않는다.
//  - 상태 변경은 사용자가 만지는 필드가 하나뿐이라 낙관적 잠금 없이 바로 저장한다 (O-2).
//  - 결과 메모는 행을 펼쳐 입력한다. 저장은 상태와 함께 setMilestoneStatus로 보낸다 (§7.8).
// 쓰기는 전부 부모(MilestoneScreen)가 actions/milestones.ts를 거쳐 수행한다.

import { Fragment, useEffect, useState } from 'react';
import type { Milestone, MilestoneStatus } from '@/types';
import { MILESTONE_STATUS_LABELS, MILESTONE_TYPE_LABELS } from '@/lib/constants';
import Badge from '@/components/ui/Badge';
import Button from '@/components/ui/Button';
import { setRealtimePaused } from '@/components/RealtimeRefresher';
import LinkedNoteList from '@/components/notes/LinkedNoteList';
import type { LinkedNote } from '@/actions/notes';

/** 목록·타임라인이 함께 쓰는 행 모델. 판정은 전부 lib/dates.ts가 끝낸 값이다 (§6.5) */
export interface MilestoneView {
  milestone: Milestone;
  /** isOverdueMilestone: date < today AND status ∉ {done, cancelled} */
  overdue: boolean;
  /** isUpcomingMilestone: 0 ≤ date - today ≤ milestoneAlertDays AND status ∉ {done, cancelled} */
  upcoming: boolean;
  /** formatDday: 'D-DAY' / 'D-n' / 'D+n' */
  dday: string;
}

// 날짜 / 유형 / 제목 / 연차 / 담당 / 상태 / D-day / 동작
const COLUMN_COUNT = 8;

const TH_CLASS = 'px-3 py-2 font-medium print:border print:border-slate-500';
const TD_CLASS = 'px-3 py-2 align-top print:border print:border-slate-400';

// done·cancelled는 §6.5의 판정 대상이 아니다 — 목록에서도 시선을 덜 끌게 낮춘다
const CLOSED_STATUSES: ReadonlySet<MilestoneStatus> = new Set(['done', 'cancelled']);

const SELECT_CLASS =
  'w-full rounded-md border border-slate-300 bg-white px-1.5 py-1 text-xs font-medium focus:border-slate-500 focus:outline-none disabled:opacity-50';

// ─── 결과 메모 편집기 (§7.8 "결과 메모 입력") ─────────────────────────────────
// 마운트되어 있는 동안이 곧 "편집 중인 폼이 열려 있는" 상태다 — R-4로 자동 새로고침을 보류해
// 입력 중인 메모가 지워지지 않게 한다.

interface NoteEditorProps {
  milestone: Milestone;
  busy: boolean;
  onSave: (note: string) => void;
  onCancel: () => void;
}

function NoteEditor({ milestone, busy, onSave, onCancel }: NoteEditorProps) {
  const [draft, setDraft] = useState(milestone.resultNote);

  useEffect(() => {
    setRealtimePaused(true);
    return () => setRealtimePaused(false);
  }, []);

  return (
    <div>
      <label className="block">
        <span className="text-xs font-semibold text-slate-600">결과 메모</span>
        <textarea
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          rows={4}
          maxLength={10000}
          placeholder="평가 결과, 제출 결과 등을 적습니다."
          className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm focus:border-slate-500 focus:outline-none"
        />
      </label>
      <div className="mt-2 flex justify-end gap-2">
        <Button size="sm" onClick={onCancel} disabled={busy}>
          취소
        </Button>
        <Button
          size="sm"
          variant="primary"
          disabled={busy || draft === milestone.resultNote}
          onClick={() => onSave(draft)}
        >
          {busy ? '저장 중…' : '메모 저장'}
        </Button>
      </div>
    </div>
  );
}

// ─── 목록 ────────────────────────────────────────────────────────────────────

export interface MilestoneTableProps {
  /** 날짜 오름차순으로 정렬된 상태로 받는다 (§7.8 기본 정렬) */
  views: MilestoneView[];
  /** yearId → 표시 이름. 없는 키는 목록에 없는 연차다 (H-5) */
  yearNameById: Map<string, string>;
  memberNameById: Map<string, string>;
  /** §7.12 역참조 — 마일스톤에 연결된 노트. 없는 키는 연결된 노트가 없는 마일스톤이다 */
  notesByMilestoneId: Map<string, LinkedNote[]>;
  projectId: string;
  busy: boolean;
  /** 타임라인 마커에서 고른 행 — 어디를 보라는 표시만 한다 */
  selectedId: string | null;
  expandedId: string | null;
  onToggleExpand: (id: string) => void;
  onStatusChange: (id: string, status: MilestoneStatus) => void;
  onSaveNote: (id: string, note: string) => void;
  onEdit: (id: string) => void;
  onDelete: (id: string) => void;
}

export default function MilestoneTable({
  views,
  yearNameById,
  memberNameById,
  notesByMilestoneId,
  projectId,
  busy,
  selectedId,
  expandedId,
  onToggleExpand,
  onStatusChange,
  onSaveNote,
  onEdit,
  onDelete,
}: MilestoneTableProps) {
  // §5.7 yearId가 null이면 과제 전체 이벤트다. 연차를 지워도 마일스톤은 남으므로(H-5)
  // 목록에 없는 연차를 가리키는 행도 감추지 않고 사실을 드러낸다.
  const yearLabel = (yearId: string | null): string => {
    if (yearId === null) return '연차 없음';
    return yearNameById.get(yearId) ?? '(삭제된 연차)';
  };

  const memberLabel = (memberId: string | null): string => {
    if (memberId === null) return '미지정';
    return memberNameById.get(memberId) ?? '(삭제된 인력)';
  };

  return (
    <div className="overflow-x-auto rounded-xl border border-slate-200 bg-white print:overflow-visible print:rounded-none print:border-0">
      <table className="w-full min-w-[900px] text-left text-sm print:min-w-0 print:border-collapse print:text-xs">
        <caption className="hidden px-3 py-2 text-left text-sm font-bold text-slate-900 print:table-caption">
          마일스톤 목록
        </caption>
        <thead className="text-xs text-slate-500 print:text-black">
          <tr className="border-b border-slate-100">
            <th className={TH_CLASS}>날짜</th>
            <th className={TH_CLASS}>유형</th>
            <th className={TH_CLASS}>제목</th>
            <th className={TH_CLASS}>연차</th>
            <th className={TH_CLASS}>담당</th>
            <th className={TH_CLASS}>상태</th>
            <th className={TH_CLASS}>D-day</th>
            <th className={`${TH_CLASS} text-right print:hidden`}>동작</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-100">
          {views.length === 0 && (
            <tr>
              <td colSpan={COLUMN_COUNT} className="px-3 py-8 text-center text-sm text-slate-400">
                등록된 마일스톤이 없습니다. [마일스톤 추가]로 시작하세요.
              </td>
            </tr>
          )}

          {views.map((view) => {
            const m = view.milestone;
            const expanded = expandedId === m.id;
            const closed = CLOSED_STATUSES.has(m.status);

            return (
              <Fragment key={m.id}>
                <tr
                  className={
                    selectedId === m.id ? 'bg-blue-50/70' : expanded ? 'bg-slate-50' : undefined
                  }
                >
                  <td className={`${TD_CLASS} tabular-nums ${closed ? 'text-slate-400' : 'text-slate-700'}`}>
                    {m.date}
                  </td>
                  <td className={TD_CLASS}>
                    <span className="text-slate-600">{MILESTONE_TYPE_LABELS[m.type]}</span>
                  </td>
                  <td className={TD_CLASS}>
                    <div className="flex flex-wrap items-center gap-1.5">
                      <button
                        type="button"
                        onClick={() => onToggleExpand(m.id)}
                        aria-expanded={expanded}
                        aria-label={`${m.title} 상세 ${expanded ? '접기' : '펼치기'}`}
                        className="shrink-0 rounded-md border border-slate-200 px-1.5 text-xs text-slate-500 hover:bg-slate-100 print:hidden"
                      >
                        {expanded ? '▾' : '▸'}
                      </button>
                      <span
                        className={`font-medium ${m.status === 'cancelled' ? 'text-slate-400 line-through' : 'text-slate-900'}`}
                      >
                        {m.title}
                      </span>
                      {m.resultNote.trim() !== '' && (
                        <Badge tone="neutral" title={m.resultNote}>
                          메모
                        </Badge>
                      )}
                    </div>
                  </td>
                  <td className={`${TD_CLASS} text-slate-600`}>{yearLabel(m.yearId)}</td>
                  <td className={`${TD_CLASS} text-slate-600`}>{memberLabel(m.ownerMemberId)}</td>
                  <td className={TD_CLASS}>
                    {/* O-2: 단일 조작이므로 낙관적 잠금 없이 바로 저장한다 */}
                    <select
                      value={m.status}
                      disabled={busy}
                      aria-label={`${m.title} 상태`}
                      onChange={(e) => onStatusChange(m.id, e.target.value as MilestoneStatus)}
                      className={`${SELECT_CLASS} print:hidden`}
                    >
                      {(Object.keys(MILESTONE_STATUS_LABELS) as MilestoneStatus[]).map((status) => (
                        <option key={status} value={status}>
                          {MILESTONE_STATUS_LABELS[status]}
                        </option>
                      ))}
                    </select>
                    {/* 인쇄에는 드롭다운 대신 값만 남긴다 */}
                    <span className="hidden text-slate-700 print:inline">
                      {MILESTONE_STATUS_LABELS[m.status]}
                    </span>
                  </td>
                  <td className={TD_CLASS}>
                    {view.overdue ? (
                      // §6.5 지연: date < 오늘 AND 상태 ∉ {완료, 취소}
                      <Badge tone="red" title="마감일이 지났는데 아직 완료·취소되지 않았습니다 (§6.5).">
                        지연 {view.dday}
                      </Badge>
                    ) : view.upcoming ? (
                      // §6.5 임박: 0 ≤ date - 오늘 ≤ settings.milestoneAlertDays
                      <Badge tone="amber" title="마감 임박 기준일 안에 들어왔습니다 (§6.5).">
                        임박 {view.dday}
                      </Badge>
                    ) : (
                      <span className={`tabular-nums ${closed ? 'text-slate-400' : 'text-slate-600'}`}>
                        {view.dday}
                      </span>
                    )}
                  </td>
                  <td className={`${TD_CLASS} text-right print:hidden`}>
                    <div className="flex flex-wrap justify-end gap-1.5">
                      <Button size="sm" disabled={busy} onClick={() => onEdit(m.id)}>
                        수정
                      </Button>
                      <Button
                        size="sm"
                        variant="danger"
                        disabled={busy}
                        onClick={() => onDelete(m.id)}
                      >
                        삭제
                      </Button>
                    </div>
                  </td>
                </tr>

                {expanded && (
                  <tr className="bg-slate-50 print:hidden">
                    <td colSpan={COLUMN_COUNT} className="px-4 py-4">
                      <div className="grid gap-4 lg:grid-cols-3">
                        <div className="min-w-0">
                          <p className="text-xs font-semibold text-slate-600">설명</p>
                          <p className="mt-1 whitespace-pre-wrap text-sm text-slate-700">
                            {m.description.trim() === '' ? (
                              <span className="text-slate-400">등록된 설명이 없습니다.</span>
                            ) : (
                              m.description
                            )}
                          </p>
                        </div>

                        <NoteEditor
                          // 대상이 바뀌면 초안을 새로 시작한다 (다른 마일스톤의 메모가 섞이지 않게)
                          key={m.id}
                          milestone={m}
                          busy={busy}
                          onSave={(note) => onSaveNote(m.id, note)}
                          onCancel={() => onToggleExpand(m.id)}
                        />

                        <div className="min-w-0">
                          {/* §7.12 역참조. 연결은 Note.milestoneId 단방향이라 보여주기만 한다 */}
                          <p className="text-xs font-semibold text-slate-600">관련 노트</p>
                          <LinkedNoteList
                            className="mt-1"
                            notes={notesByMilestoneId.get(m.id) ?? []}
                            projectId={projectId}
                            emptyText="이 마일스톤에 연결된 노트가 없습니다. [노트] 화면에서 연결하세요."
                          />
                        </div>
                      </div>
                    </td>
                  </tr>
                )}
              </Fragment>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
