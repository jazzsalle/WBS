'use client';

// 인력별 배정 작업 패널 (SOT §7.10 "인력 행 클릭 → 배정된 작업 목록 사이드 패널")
// 읽기 전용이다 — 배정 변경은 WBS 작업 상세(§7.4)의 몫이다.
// 목록은 getTeamScreenData가 서버에서 이미 집계해 내려준 값을 그대로 그린다
// (담당/참여 구분은 isOwner).

import type { Member, TaskStatus } from '@/types';
import type { AssignedTask } from '@/actions/team';
import { TASK_STATUS_LABELS } from '@/lib/constants';
import Badge, { type BadgeTone } from '@/components/ui/Badge';

// 부록 A.3 Task 상태 색을 뱃지 톤으로 옮긴다
const STATUS_TONES: Record<TaskStatus, BadgeTone> = {
  todo: 'neutral',
  in_progress: 'blue',
  done: 'green',
  blocked: 'red',
};

export interface MemberTasksPanelProps {
  member: Member;
  /** assignedTasksByMember[member.id]. 배정이 없으면 빈 배열 */
  tasks: AssignedTask[];
  onClose: () => void;
}

export default function MemberTasksPanel({ member, tasks, onClose }: MemberTasksPanelProps) {
  // 책임자로 맡은 작업을 위로 — 인력 화면에서 먼저 확인하는 것은 "이 사람이 책임진 일"이다
  const sorted = [...tasks].sort((a, b) => Number(b.isOwner) - Number(a.isOwner));

  return (
    <aside
      aria-label={`${member.name} 배정 작업`}
      className="w-full shrink-0 rounded-xl border border-slate-200 bg-white lg:w-80"
    >
      <div className="flex items-start justify-between gap-3 border-b border-slate-100 px-4 py-3">
        <div className="min-w-0">
          <p className="truncate text-sm font-bold text-slate-900">{member.name}</p>
          <p className="mt-0.5 text-xs text-slate-500">배정된 작업 {tasks.length}건</p>
        </div>
        <button
          type="button"
          onClick={onClose}
          aria-label="배정 작업 패널 닫기"
          className="shrink-0 text-lg leading-none text-slate-400 hover:text-slate-600"
        >
          ×
        </button>
      </div>

      {sorted.length === 0 ? (
        <p className="px-4 py-6 text-center text-sm text-slate-400">배정된 작업이 없습니다.</p>
      ) : (
        <ul className="max-h-[28rem] divide-y divide-slate-100 overflow-y-auto">
          {sorted.map((task) => (
            <li key={task.id} className="px-4 py-2.5">
              <p className="text-sm text-slate-900">{task.title}</p>
              <div className="mt-1 flex items-center gap-1.5">
                <Badge tone={STATUS_TONES[task.status]}>{TASK_STATUS_LABELS[task.status]}</Badge>
                <Badge tone={task.isOwner ? 'violet' : 'neutral'}>
                  {task.isOwner ? '담당' : '참여'}
                </Badge>
              </div>
            </li>
          ))}
        </ul>
      )}
    </aside>
  );
}
