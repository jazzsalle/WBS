// 대시보드 "오늘 집중할 작업" (SOT §7.2 4)
// 서버가 전 과제 리프 Task 중 완료·막힘을 뺀 뒤 우선순위 점수 상위 5건을 정렬해 내려준다 —
// 여기서 다시 자르거나 점수를 계산하지 않는다 (§6.9, O-4).
// 등급·색은 항목에 실려 온 값(부록 A.3 PRIORITY_SCORE_COLORS 토큰)을 클래스로 옮기기만 한다.

import Link from 'next/link';
import type { FocusTaskItem } from '@/actions/dashboard';
import { PRIORITY_SCORE_COLORS, TASK_STATUS_LABELS } from '@/lib/constants';
import Badge from '@/components/ui/Badge';

// Tailwind 정적 스캔을 위해 완전한 클래스 문자열로 나열한다.
// 키는 PRIORITY_SCORE_COLORS의 color 토큰이다 — 새 색을 만들지 않는다.
const SCORE_BADGE_CLASSES: Record<string, string> = {
  'red-600': 'bg-red-600 text-white',
  'orange-500': 'bg-orange-500 text-white',
  'grey-500': 'bg-grey-500 text-white',
  'grey-400': 'bg-grey-400 text-white',
};

// 점수 구간의 상한(=최우선 시작점)을 문구에 쓰기 위해 상수에서 읽는다. 15를 다시 적지 않는다.
const TOP_GRADE_MIN = PRIORITY_SCORE_COLORS[0].min;

export interface FocusTasksProps {
  items: FocusTaskItem[];
}

export default function FocusTasks({ items }: FocusTasksProps) {
  return (
    <section
      aria-labelledby="dashboard-focus-title"
      className="rounded-2xl border border-grey-200 bg-surface p-5"
    >
      <h2 id="dashboard-focus-title" className="text-base font-bold text-grey-900">
        오늘 집중할 작업
        <span className="ml-2 text-xs font-normal text-grey-500">
          우선순위 점수 상위 {items.length}건
        </span>
      </h2>

      {items.length === 0 ? (
        <p className="mt-4 rounded-xl border border-dashed border-grey-300 p-6 text-center text-xs text-grey-500">
          집중할 작업이 없습니다(완료·막힘을 제외한 실행 대상 작업이 없습니다).
        </p>
      ) : (
        <ol className="mt-4 space-y-2">
          {items.map((item) => (
            <li
              key={item.id}
              className="flex items-start gap-3 rounded-xl bg-grey-50/60 px-3 py-2"
            >
              <span
                title={`${item.grade} · 중요도 ${item.importance} × 긴급도 ${item.urgency}${
                  item.score >= TOP_GRADE_MIN ? ` (${TOP_GRADE_MIN}점 이상 = 최우선)` : ''
                }`}
                className={`inline-flex shrink-0 flex-col items-center rounded-lg px-2 py-1 text-xs font-bold tabular-nums ${
                  SCORE_BADGE_CLASSES[item.color] ?? 'bg-grey-400 text-white'
                }`}
              >
                {item.score}
                <span className="text-[10px] font-medium">{item.grade}</span>
              </span>

              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium text-grey-900" title={item.title}>
                  {item.title}
                </p>
                <div className="mt-0.5 flex flex-wrap items-center gap-2 text-xs text-grey-500">
                  <Link
                    href={`/projects/${item.projectId}`}
                    className="truncate hover:text-blue-600 hover:underline"
                  >
                    {item.projectName || '(이름 없는 과제)'}
                  </Link>
                  <Badge>{TASK_STATUS_LABELS[item.status]}</Badge>
                  {item.dueDate === null ? (
                    <span className="text-grey-400">마감 없음</span>
                  ) : (
                    <>
                      <span className="tabular-nums">{item.dueDate}</span>
                      {/* §6.5 지연은 빨강. 오늘을 다시 만들지 않고 서버가 준 D-day 표기('D+n')로만 가른다 */}
                      {item.dday !== null && (
                        <Badge
                          tone={item.dday.startsWith('D+') ? 'red' : 'amber'}
                          className="tabular-nums"
                        >
                          {item.dday}
                        </Badge>
                      )}
                    </>
                  )}
                </div>
              </div>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}
