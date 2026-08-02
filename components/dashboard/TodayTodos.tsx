// 대시보드 "오늘의 To-Do" (SOT §7.2 6)
// Phase 4 범위에서는 읽기 전용이다 — 체크·추가·수정은 To-Do 화면(§7.13, Phase 8)에서 한다.
// 목록은 서버가 미완료 + 마감이 오늘 이하인 항목을 정렬해 내려준 것이다(지난 마감 포함).
// /todos 라우트가 아직 없으므로 링크를 걸지 않는다.

import Link from 'next/link';
import type { TodayTodoItem } from '@/actions/dashboard';
import { PRIORITY_LABELS } from '@/lib/constants';
import Badge, { type BadgeTone } from '@/components/ui/Badge';
import type { Priority } from '@/types';

const PRIORITY_TONES: Record<Priority, BadgeTone> = {
  high: 'red',
  normal: 'blue',
  low: 'neutral',
};

export interface TodayTodosProps {
  items: TodayTodoItem[];
}

export default function TodayTodos({ items }: TodayTodosProps) {
  return (
    <section
      aria-labelledby="dashboard-todos-title"
      className="rounded-2xl border border-slate-200 bg-white p-5"
    >
      <h2 id="dashboard-todos-title" className="text-base font-bold text-slate-900">
        오늘의 To-Do
        <span className="ml-2 text-xs font-normal text-slate-500">오늘 마감 + 지난 마감</span>
      </h2>

      {items.length === 0 ? (
        <p className="mt-4 rounded-xl border border-dashed border-slate-300 p-6 text-center text-xs text-slate-500">
          오늘 마감인 To-Do가 없습니다.
        </p>
      ) : (
        <ul className="mt-4 space-y-2">
          {items.map((item) => (
            <li key={item.id} className="flex flex-wrap items-center gap-2 rounded-xl bg-slate-50/60 px-3 py-2">
              <Badge tone={PRIORITY_TONES[item.priority]}>{PRIORITY_LABELS[item.priority]}</Badge>
              <span className="min-w-0 flex-1 truncate text-sm text-slate-900" title={item.title}>
                {item.title}
              </span>
              {item.projectId !== null && (
                <Link
                  href={`/projects/${item.projectId}`}
                  className="max-w-[10rem] truncate text-xs text-slate-500 hover:text-blue-600 hover:underline"
                >
                  {item.projectName ?? '(삭제된 과제)'}
                </Link>
              )}
              <span className="text-xs tabular-nums text-slate-500">{item.dueDate}</span>
              {/* §6.5 지연은 빨강. 오늘을 다시 만들지 않고 서버가 준 D-day 표기('D+n')로만 가른다 */}
              <Badge tone={item.dday.startsWith('D+') ? 'red' : 'amber'} className="tabular-nums">
                {item.dday}
              </Badge>
            </li>
          ))}
        </ul>
      )}

      <p className="mt-3 text-[11px] text-slate-400">
        완료 체크·추가·수정은 To-Do 화면(Phase 8)에서 지원됩니다. 여기서는 읽기 전용입니다.
      </p>
    </section>
  );
}
