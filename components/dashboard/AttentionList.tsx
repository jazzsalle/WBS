// 대시보드 "주의 필요" (SOT §7.2 5)
// 지연 작업 + 막힘 작업 + 고위험 리스크 + 발생한 리스크를 한 목록으로 본다.
// 판정·정렬은 서버(§6.5 lib/risk·lib/dates)가 끝낸 상태로 온다 — 여기서 다시 걸러내지 않는다.
// 한 항목이 두 종류에 동시에 해당할 수 있어 kinds[]를 전부 뱃지로 보인다(같은 항목을 두 줄로 싣지 않는다).

import Link from 'next/link';
import type { AttentionItem, AttentionKind } from '@/actions/dashboard';
import type { RiskStatus, TaskStatus } from '@/types';
import { RISK_SCORE_COLORS, RISK_STATUS_LABELS, TASK_STATUS_LABELS } from '@/lib/constants';
import Badge, { type BadgeTone } from '@/components/ui/Badge';

const KIND_LABELS: Record<AttentionKind, string> = {
  occurred_risk: '발생한 리스크',
  high_risk: '고위험 리스크',
  overdue_task: '지연 작업',
  blocked_task: '막힘 작업',
};

const KIND_TONES: Record<AttentionKind, BadgeTone> = {
  occurred_risk: 'red',
  high_risk: 'red',
  overdue_task: 'red',
  blocked_task: 'amber',
};

// 작업 상태와 리스크 상태는 값이 겹치지 않는다 — 하나의 표로 합쳐 entity 분기 없이 읽는다
const STATUS_LABELS: Record<TaskStatus | RiskStatus, string> = {
  ...TASK_STATUS_LABELS,
  ...RISK_STATUS_LABELS,
};

// Tailwind 정적 스캔을 위해 완전한 클래스 문자열로 나열한다.
// 키는 부록 A.3 RISK_SCORE_COLORS의 color 토큰이다 — 새 색을 만들지 않는다.
const RISK_SCORE_CLASSES: Record<string, string> = {
  'red-600': 'bg-red-600 text-white',
  'orange-500': 'bg-orange-500 text-white',
  'green-600': 'bg-green-600 text-white',
};

/** 리스크 점수(서버가 준 probability × impact) 구간의 색. 구간 정의의 원본은 A.3다 */
function riskScoreClass(score: number): string {
  const band = RISK_SCORE_COLORS.find((b) => score >= b.min && score <= b.max);
  return (band && RISK_SCORE_CLASSES[band.color]) ?? 'bg-grey-400 text-white';
}

export interface AttentionListProps {
  items: AttentionItem[];
}

export default function AttentionList({ items }: AttentionListProps) {
  return (
    <section
      aria-labelledby="dashboard-attention-title"
      className="rounded-2xl border border-grey-200 bg-white p-5"
    >
      <h2 id="dashboard-attention-title" className="text-base font-bold text-grey-900">
        주의 필요
        <span className="ml-2 text-xs font-normal text-grey-500">
          지연·막힘 작업 + 고위험·발생 리스크 {items.length}건
        </span>
      </h2>

      {items.length === 0 ? (
        <p className="mt-4 rounded-xl border border-dashed border-grey-300 p-6 text-center text-xs text-grey-500">
          주의가 필요한 항목이 없습니다.
        </p>
      ) : (
        <ul className="mt-4 space-y-2">
          {items.map((item) => (
            <li
              key={`${item.entity}:${item.id}`}
              className="flex items-start gap-3 rounded-xl bg-grey-50/60 px-3 py-2"
            >
              {item.entity === 'risk' && item.score !== null && (
                <span
                  title={`리스크 점수 ${item.score} (발생확률 × 영향도)`}
                  className={`inline-flex shrink-0 items-center rounded-lg px-2 py-1 text-xs font-bold tabular-nums ${riskScoreClass(item.score)}`}
                >
                  {item.score}
                </span>
              )}

              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  {item.kinds.map((kind) => (
                    <Badge key={kind} tone={KIND_TONES[kind]}>
                      {KIND_LABELS[kind]}
                    </Badge>
                  ))}
                  <span className="min-w-0 flex-1 truncate text-sm font-medium text-grey-900" title={item.title}>
                    {item.title}
                  </span>
                </div>
                <div className="mt-0.5 flex flex-wrap items-center gap-2 text-xs text-grey-500">
                  <Link
                    href={`/projects/${item.projectId}`}
                    className="truncate hover:text-blue-600 hover:underline"
                  >
                    {item.projectName || '(이름 없는 과제)'}
                  </Link>
                  <Badge>{STATUS_LABELS[item.status]}</Badge>
                  {item.dueDate !== null && <span className="tabular-nums">{item.dueDate}</span>}
                  {item.daysOverdue !== null && (
                    <span className="font-medium tabular-nums text-red-600">
                      {item.daysOverdue}일 지남
                    </span>
                  )}
                </div>
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
