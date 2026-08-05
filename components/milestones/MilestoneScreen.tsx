'use client';

// 마일스톤 화면 컨테이너 (SOT §7.8, §6.5, §8.4 O-2·O-3, §8.5 R-4)
// 데이터는 전부 서버(page.tsx → getMilestonesData)가 조회해 내려준다.
// 지연·임박·D-day 판정은 lib/dates.ts를 호출한 결과(MilestoneView)만 쓴다 — 화면에서 날짜를
// 다시 비교하지 않는다(§6.5). 기준일(todayISO)도 서버가 고정해 내려준 값을 그대로 쓴다.
// 쓰기는 전부 actions/milestones.ts를 거친다. supabase를 직접 부르지 않는다(§8.2 C-2).

import { useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import type { ActionResult, Milestone, MilestoneStatus, Year } from '@/types';
import type { ActionErrorCode } from '@/lib/db/errors';
import type { MilestonesData } from '@/actions/milestones';
import type { LinkedNote } from '@/actions/notes';
import { deleteMilestone, setMilestoneStatus } from '@/actions/milestones';
import { formatDday, isOverdueMilestone, isUpcomingMilestone } from '@/lib/dates';
import { MILESTONE_STATUS_LABELS } from '@/lib/constants';
import Button from '@/components/ui/Button';
import ErrorBanner from '@/components/ui/ErrorBanner';
import Modal from '@/components/ui/Modal';
import MilestoneTimeline from './MilestoneTimeline';
import MilestoneTable, { type MilestoneView } from './MilestoneTable';
import MilestoneFormModal from './MilestoneFormModal';

/** §5.5: name이 있으면 name, 없으면 order+1 + '차년도' */
function yearLabel(year: Year): string {
  return year.name.trim() || `${year.order + 1}차년도`;
}

export interface MilestoneScreenProps {
  data: MilestonesData;
  /** §6.5 기준일. 서버가 todayISO(new Date())로 Asia/Seoul 달력에 맞춰 고정한 값 */
  todayISO: string;
  /** §7.12 역참조 — 마일스톤에 연결된 노트 (서버가 함께 조회해 내려준다) */
  linkedNotes: LinkedNote[];
}

export default function MilestoneScreen({ data, todayISO, linkedNotes }: MilestoneScreenProps) {
  const router = useRouter();
  const [formMode, setFormMode] = useState<'create' | 'edit' | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<{ message: string; code?: ActionErrorCode } | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  // §7.8 기본 정렬은 날짜 오름차순. 같은 날짜는 제목 순으로 고정해 새로고침마다 순서가 흔들리지 않게 한다.
  const views = useMemo<MilestoneView[]>(
    () =>
      [...data.milestones]
        .sort((a, b) => a.date.localeCompare(b.date) || a.title.localeCompare(b.title, 'ko'))
        .map((milestone) => ({
          milestone,
          overdue: isOverdueMilestone(milestone, todayISO),
          upcoming: isUpcomingMilestone(milestone, todayISO, data.milestoneAlertDays),
          dday: formatDday(todayISO, milestone.date),
        })),
    [data.milestones, data.milestoneAlertDays, todayISO]
  );

  const byId = useMemo(
    () => new Map(data.milestones.map((m) => [m.id, m])),
    [data.milestones]
  );
  const yearNameById = useMemo(
    () => new Map(data.years.map((year) => [year.id, yearLabel(year)])),
    [data.years]
  );
  const memberNameById = useMemo(
    () => new Map(data.members.map((member) => [member.id, member.name])),
    [data.members]
  );

  // 마일스톤에 연결된 노트만 마일스톤별로 묶는다 (작업에만 붙은 노트는 여기 나오지 않는다)
  const notesByMilestoneId = useMemo(() => {
    const grouped = new Map<string, LinkedNote[]>();
    for (const note of linkedNotes) {
      if (note.milestoneId === null) continue;
      const bucket = grouped.get(note.milestoneId) ?? [];
      bucket.push(note);
      grouped.set(note.milestoneId, bucket);
    }
    return grouped;
  }, [linkedNotes]);

  // 편집·삭제 대상은 매번 최신 props에서 다시 찾는다 — O-3의 "다시 불러오기"가 모달까지 닿는 경로다
  const editingMilestone = editingId === null ? undefined : byId.get(editingId);
  const deletingMilestone = deletingId === null ? null : (byId.get(deletingId) ?? null);

  const overdueCount = views.filter((view) => view.overdue).length;
  const upcomingCount = views.filter((view) => view.upcoming).length;

  // 남이 지운 항목의 확장·선택 상태가 남아 있으면 다음 저장이 엉뚱한 행을 가리킨다
  useEffect(() => {
    if (expandedId !== null && !byId.has(expandedId)) setExpandedId(null);
    if (selectedId !== null && !byId.has(selectedId)) setSelectedId(null);
  }, [byId, expandedId, selectedId]);

  async function run<T>(
    action: () => Promise<ActionResult<T>>,
    onSuccess: (data: T) => void
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

  // 사라진 행을 조작하려 할 때 조용히 넘기지 않는다 (절대 규칙 5)
  const requireMilestone = (id: string): Milestone | null => {
    const milestone = byId.get(id);
    if (!milestone) {
      setFailure({
        message: '대상 마일스톤이 더 이상 없습니다. 다른 사용자가 삭제했을 수 있습니다.',
      });
      return null;
    }
    return milestone;
  };

  // O-2: 상태 드롭다운은 사용자가 만지는 필드가 하나뿐이라 낙관적 잠금 없이 저장한다.
  // resultNote를 넘기지 않으므로 기존 메모는 그대로 유지된다.
  const handleStatusChange = (id: string, status: MilestoneStatus): void => {
    const milestone = requireMilestone(id);
    if (!milestone) return;
    void run(
      () => setMilestoneStatus(id, status),
      () =>
        setNotice(
          `${milestone.title} 상태를 '${MILESTONE_STATUS_LABELS[status]}'로 바꿨습니다.`
        )
    );
  };

  // §7.8 결과 메모. 상태는 지금 값을 그대로 함께 보낸다(액션이 상태를 필수로 받는다).
  const handleSaveNote = (id: string, note: string): void => {
    const milestone = requireMilestone(id);
    if (!milestone) return;
    void run(
      () => setMilestoneStatus(id, milestone.status, note),
      () => {
        setExpandedId(null);
        setNotice(`${milestone.title}의 결과 메모를 저장했습니다.`);
      }
    );
  };

  const handleDelete = (milestone: Milestone): void => {
    void run(
      () => deleteMilestone(milestone.id),
      () => {
        setDeletingId(null);
        if (expandedId === milestone.id) setExpandedId(null);
        if (selectedId === milestone.id) setSelectedId(null);
        setNotice(`${milestone.title} 마일스톤을 삭제했습니다.`);
      }
    );
  };

  return (
    <div>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm text-slate-600">
          전체 {views.length}건
          {overdueCount > 0 && (
            <span className="ml-2 font-semibold text-red-700">지연 {overdueCount}건</span>
          )}
          {upcomingCount > 0 && (
            <span className="ml-2 font-semibold text-amber-700">
              임박 {upcomingCount}건 (기준 {data.milestoneAlertDays}일)
            </span>
          )}
        </p>
        <Button
          size="sm"
          variant="primary"
          disabled={busy}
          onClick={() => {
            setEditingId(null);
            setFormMode('create');
          }}
        >
          마일스톤 추가
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

      {notice && (
        <div
          role="status"
          className="mt-3 flex items-start justify-between gap-4 rounded-xl border border-slate-200 bg-slate-50 p-3 text-sm text-slate-700"
        >
          <p className="min-w-0 break-words">{notice}</p>
          <button
            type="button"
            onClick={() => setNotice(null)}
            aria-label="알림 닫기"
            className="shrink-0 font-bold text-slate-400 hover:text-slate-600"
          >
            ×
          </button>
        </div>
      )}

      <div className="mt-4">
        <MilestoneTimeline
          views={views}
          years={data.years}
          todayISO={todayISO}
          selectedId={selectedId}
          onSelect={(id) => setSelectedId((prev) => (prev === id ? null : id))}
        />
      </div>

      <div className="mt-4">
        <MilestoneTable
          views={views}
          yearNameById={yearNameById}
          memberNameById={memberNameById}
          notesByMilestoneId={notesByMilestoneId}
          projectId={data.projectId}
          busy={busy}
          selectedId={selectedId}
          expandedId={expandedId}
          onToggleExpand={(id) => setExpandedId((prev) => (prev === id ? null : id))}
          onStatusChange={handleStatusChange}
          onSaveNote={handleSaveNote}
          onEdit={(id) => {
            setEditingId(id);
            setFormMode('edit');
          }}
          onDelete={(id) => setDeletingId(id)}
        />
      </div>

      {formMode && (
        <MilestoneFormModal
          mode={formMode}
          projectId={data.projectId}
          milestone={formMode === 'edit' ? editingMilestone : undefined}
          years={data.years}
          members={data.members}
          onClose={() => {
            setFormMode(null);
            setEditingId(null);
          }}
          onSaved={() => {
            setFormMode(null);
            setEditingId(null);
            router.refresh();
          }}
        />
      )}

      {deletingMilestone && (
        <Modal
          open
          title="마일스톤을 삭제합니다"
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
                onClick={() => handleDelete(deletingMilestone)}
              >
                {busy ? '삭제 중…' : '삭제'}
              </Button>
            </>
          }
        >
          <p className="text-sm text-slate-700">
            <strong>{deletingMilestone.title}</strong>({deletingMilestone.date})을 삭제합니다.
          </p>
          <p className="mt-3 rounded-lg bg-amber-50 p-3 text-xs text-amber-800">
            이 마일스톤에 연결된 노트는 지워지지 않고 연결만 끊어집니다.
          </p>
        </Modal>
      )}
    </div>
  );
}
