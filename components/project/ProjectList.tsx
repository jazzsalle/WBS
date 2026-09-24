'use client';

// 과제 목록 (SOT §7.15)
// 카드 = 색상 띠 + 과제명 + 부처·전문기관 + 진척률 바 + 현재 연차 뱃지 + 상태 뱃지.
// 정렬은 order 수동(HTML5 네이티브 드래그) → reorderProjects, 필터는 상태 + 아카이브 표시 토글.
// 아카이브 과제는 기본 숨김이고, 표시하면 흐린 스타일로 보인다.
// 서버는 아카이브 포함 전체를 한 번에 내려준다 — 토글은 여기서 거른다(왕복 없이 즉시 반응).

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import type { ProjectSummary } from '@/actions/projects';
import type { ProjectStatus, Year } from '@/types';
import type { ActionErrorCode } from '@/lib/db/errors';
import { PROJECT_STATUS_LABELS } from '@/lib/constants';
import { archiveProject, reorderProjects } from '@/actions/projects';
import { isSampleProject } from '@/lib/tutorial';
import Badge, { type BadgeTone } from '@/components/ui/Badge';
import Button from '@/components/ui/Button';
import ErrorBanner from '@/components/ui/ErrorBanner';
import ProgressBar from '@/components/ui/ProgressBar';
import ProjectFormModal, { DEFAULT_PROJECT_COLOR } from './ProjectFormModal';

// 부록 A.3에 과제 상태 색이 없어 의미가 가까운 톤만 고른다(수행중=진행, 탈락/중단=경고)
const STATUS_TONES: Record<ProjectStatus, BadgeTone> = {
  planning: 'neutral',
  active: 'blue',
  on_hold: 'amber',
  done: 'green',
  dropped: 'red',
};

// §5.5: name이 있으면 name, 없으면 order+1 + '차년도'
function yearLabel(year: Year): string {
  return year.name.trim() || `${year.order + 1}차년도`;
}

type Modal = { mode: 'create' } | { mode: 'edit'; projectId: string } | null;

export interface ProjectListProps {
  /** 아카이브 포함 전체 (서버에서 getProjectsSummary(true)) */
  summaries: ProjectSummary[];
}

export default function ProjectList({ summaries }: ProjectListProps) {
  const router = useRouter();
  const [statusFilter, setStatusFilter] = useState<ProjectStatus | 'all'>('all');
  const [showArchived, setShowArchived] = useState(false);
  // 드래그 직후의 낙관적 순서. 서버 순서가 갱신되면 버린다.
  const [localOrder, setLocalOrder] = useState<string[] | null>(null);
  const [dragId, setDragId] = useState<string | null>(null);
  const [dropTargetId, setDropTargetId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<{ message: string; code?: ActionErrorCode } | null>(null);
  const [modal, setModal] = useState<Modal>(null);

  const serverOrderKey = summaries.map((s) => s.project.id).join(',');
  useEffect(() => {
    // 서버가 새 순서를 내려주면 낙관적 순서는 역할이 끝났다
    setLocalOrder(null);
  }, [serverOrderKey]);

  const ordered = useMemo(() => {
    if (!localOrder) return summaries;
    const byId = new Map(summaries.map((s) => [s.project.id, s]));
    const sorted = localOrder.map((id) => byId.get(id)).filter((s): s is ProjectSummary => !!s);
    // 낙관적 순서에 없는 과제(그새 추가됨)를 잃어버리지 않는다
    const seen = new Set(localOrder);
    return [...sorted, ...summaries.filter((s) => !seen.has(s.project.id))];
  }, [summaries, localOrder]);

  const visible = ordered.filter(
    (s) =>
      (showArchived || !s.project.archived) &&
      (statusFilter === 'all' || s.project.status === statusFilter)
  );

  const archivedCount = summaries.filter((s) => s.project.archived).length;
  const editing =
    modal?.mode === 'edit'
      ? summaries.find((s) => s.project.id === modal.projectId)?.project
      : undefined;

  // 편집 중이던 과제가 사라지면(다른 사람이 삭제) 모달이 빈 채로 남는다 — 조용히 두지 않는다
  useEffect(() => {
    if (modal?.mode !== 'edit' || editing) return;
    setModal(null);
    setFailure({ message: '편집하려던 과제가 목록에 없습니다. 다른 사람이 삭제했을 수 있습니다.' });
  }, [modal, editing]);

  // 필터로 일부만 보이더라도 순서는 전체 목록 기준으로 계산한다 —
  // 부분 배열만 보내면 숨겨진 과제와 순서가 뒤엉킨다.
  const handleDrop = async (targetId: string) => {
    const sourceId = dragId;
    setDragId(null);
    setDropTargetId(null);
    if (!sourceId || sourceId === targetId) return;

    const ids = ordered.map((s) => s.project.id);
    const without = ids.filter((id) => id !== sourceId);
    const targetIndex = without.indexOf(targetId);
    if (targetIndex < 0) return;
    // 아래로 끌면 대상 뒤, 위로 끌면 대상 앞에 놓는다
    const insertAt = ids.indexOf(sourceId) < ids.indexOf(targetId) ? targetIndex + 1 : targetIndex;
    const next = [...without.slice(0, insertAt), sourceId, ...without.slice(insertAt)];

    setLocalOrder(next);
    setBusy(true);
    setFailure(null);
    const res = await reorderProjects(next);
    setBusy(false);
    if (!res.ok) {
      setLocalOrder(null); // 실패했으면 서버 순서로 되돌린다
      setFailure({ message: res.error, code: res.code });
      return;
    }
    router.refresh();
  };

  const handleArchive = async (projectId: string, archived: boolean) => {
    setBusy(true);
    setFailure(null);
    const res = await archiveProject(projectId, archived);
    setBusy(false);
    if (!res.ok) {
      setFailure({ message: res.error, code: res.code });
      return;
    }
    router.refresh();
  };

  return (
    <section>
      <div className="flex flex-wrap items-center gap-3">
        <label className="flex items-center gap-2 text-sm text-grey-600">
          상태
          <select
            value={statusFilter}
            onChange={(e) => setStatusFilter(e.target.value as ProjectStatus | 'all')}
            className="rounded-lg border border-grey-300 bg-surface px-2.5 py-1.5 text-sm focus:border-grey-500 focus:outline-none"
          >
            <option value="all">전체</option>
            {(Object.keys(PROJECT_STATUS_LABELS) as ProjectStatus[]).map((status) => (
              <option key={status} value={status}>
                {PROJECT_STATUS_LABELS[status]}
              </option>
            ))}
          </select>
        </label>

        <label className="flex items-center gap-2 text-sm text-grey-600">
          <input
            type="checkbox"
            checked={showArchived}
            onChange={(e) => setShowArchived(e.target.checked)}
            className="h-4 w-4 rounded border-grey-300"
          />
          보관 과제 표시 ({archivedCount})
        </label>

        <Button
          variant="primary"
          size="sm"
          className="ml-auto"
          onClick={() => setModal({ mode: 'create' })}
        >
          새 과제
        </Button>
      </div>

      {failure && (
        <ErrorBanner
          message={failure.message}
          code={failure.code}
          onDismiss={() => setFailure(null)}
          className="mt-4"
        />
      )}

      {visible.length === 0 ? (
        <p className="mt-6 rounded-xl border border-dashed border-grey-300 p-10 text-center text-sm text-grey-500">
          {summaries.length === 0
            ? '아직 과제가 없습니다. [새 과제]로 첫 과제를 만드세요.'
            : '조건에 맞는 과제가 없습니다. 필터를 바꿔보세요.'}
        </p>
      ) : (
        <ul className="mt-4 grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
          {visible.map(({ project, currentYear, progress, invalidTaskCount }) => (
            <li
              key={project.id}
              onDragOver={(e) => {
                if (!dragId || dragId === project.id) return;
                e.preventDefault(); // preventDefault를 해야 drop이 발생한다
                e.dataTransfer.dropEffect = 'move';
                setDropTargetId(project.id);
              }}
              onDragLeave={() => setDropTargetId((prev) => (prev === project.id ? null : prev))}
              onDrop={(e) => {
                e.preventDefault();
                void handleDrop(project.id);
              }}
              className={`flex overflow-hidden rounded-xl border bg-surface shadow-sm transition ${
                dropTargetId === project.id ? 'border-blue-400 ring-2 ring-blue-200' : 'border-grey-200'
              } ${dragId === project.id ? 'opacity-40' : ''} ${
                project.archived ? 'opacity-60 grayscale' : ''
              }`}
            >
              {/* 색상 띠 (§7.15). projects.color는 hex, 미지정이면 기본색 */}
              <span
                aria-hidden
                className="w-1.5 shrink-0"
                style={{ backgroundColor: project.color || DEFAULT_PROJECT_COLOR }}
              />

              <div className="min-w-0 flex-1 p-4">
                <div className="flex items-start justify-between gap-2">
                  <Link
                    href={`/projects/${project.id}`}
                    className="min-w-0 text-base font-semibold text-grey-900 hover:underline"
                  >
                    {project.name}
                  </Link>
                  <span
                    draggable
                    onDragStart={(e) => {
                      e.dataTransfer.effectAllowed = 'move';
                      e.dataTransfer.setData('text/plain', project.id);
                      setDragId(project.id);
                    }}
                    onDragEnd={() => {
                      setDragId(null);
                      setDropTargetId(null);
                    }}
                    role="button"
                    aria-label={`${project.name} 순서 변경 손잡이`}
                    title="끌어서 순서 변경"
                    className="shrink-0 cursor-grab px-1 text-grey-300 hover:text-grey-500"
                  >
                    ⠿
                  </span>
                </div>

                <p className="mt-1 truncate text-xs text-grey-500">
                  {[project.ministry, project.agency].filter(Boolean).join(' · ') || '부처·전문기관 미입력'}
                </p>

                <ProgressBar value={progress} className="mt-3" />

                <div className="mt-3 flex flex-wrap items-center gap-1.5">
                  <Badge tone={STATUS_TONES[project.status]}>
                    {PROJECT_STATUS_LABELS[project.status]}
                  </Badge>
                  {currentYear ? (
                    <Badge tone="violet" title="현재 수행 중인 연차">
                      {yearLabel(currentYear)}
                    </Badge>
                  ) : (
                    <Badge title="status=active인 연차가 없습니다">연차 미지정</Badge>
                  )}
                  {project.archived && <Badge>보관됨</Badge>}
                  {/* TU-3: 팀 전원에게 보이는 실제 과제라서 "지워도 되는 것"임을 카드에서 밝힌다 */}
                  {isSampleProject(project) && (
                    <Badge tone="amber" title="따라하기 예제 — 지워도 됩니다">
                      예제
                    </Badge>
                  )}
                </div>

                {invalidTaskCount > 0 && (
                  // 절대 규칙 5: 트리에 편입되지 못한 작업을 조용히 버리지 않는다
                  <p className="mt-2 rounded-lg bg-red-50 px-2 py-1 text-xs text-red-700">
                    트리에 붙지 못한 작업 {invalidTaskCount}건이 있습니다. WBS 화면에서 확인하세요.
                  </p>
                )}

                <div className="mt-3 flex gap-2">
                  <Button
                    size="sm"
                    disabled={busy}
                    onClick={() => setModal({ mode: 'edit', projectId: project.id })}
                  >
                    편집
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={busy}
                    onClick={() => void handleArchive(project.id, !project.archived)}
                  >
                    {project.archived ? '보관 해제' : '보관'}
                  </Button>
                </div>
              </div>
            </li>
          ))}
        </ul>
      )}

      {modal?.mode === 'create' && (
        <ProjectFormModal
          mode="create"
          onClose={() => setModal(null)}
          onSaved={() => {
            setModal(null);
            router.refresh();
          }}
        />
      )}

      {modal?.mode === 'edit' && editing && (
        <ProjectFormModal
          mode="edit"
          project={editing}
          onClose={() => setModal(null)}
          onSaved={() => {
            setModal(null);
            router.refresh();
          }}
        />
      )}
    </section>
  );
}
