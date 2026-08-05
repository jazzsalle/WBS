'use client';

// 간트 막대 (SOT §7.5)
//  - 막대 안에 진척률 채움. 진척률은 서버가 계산해 내려준 값이다 (§6.1 O-4).
//  - 부모 Task는 얇은 요약 막대(양끝 캡). 그 기간은 자식에서 롤업된 값이라(P-14~P-16)
//    끌어도 저장할 곳이 없다 — 드래그를 막고 커서·툴팁으로 이유를 알린다.
//  - 좌표는 전부 lib/gantt.computeBarGeometry가 낸 값이다.

import type { TaskStatus } from '@/types';
import { TASK_STATUS_COLORS } from '@/lib/constants';
import type { BarGeometry } from '@/lib/gantt';

// Tailwind 정적 스캔 — 토큰을 문자열로 조합하지 않는다 (부록 A.3)
const STATUS_BG: Record<string, string> = {
  'slate-400': 'bg-slate-400',
  'blue-500': 'bg-blue-500',
  'emerald-500': 'bg-emerald-500',
  'rose-500': 'bg-rose-500',
};

const STATUS_FILL: Record<string, string> = {
  'slate-400': 'bg-slate-600',
  'blue-500': 'bg-blue-700',
  'emerald-500': 'bg-emerald-700',
  'rose-500': 'bg-rose-700',
};

export const BAR_HEIGHT = 14;
export const SUMMARY_HEIGHT = 6;
const HANDLE_PX = 6;

export type DragMode = 'move' | 'start' | 'end';

export interface GanttBarProps {
  geometry: BarGeometry;
  /** 0~100. 서버 계산값 */
  progress: number;
  status: TaskStatus;
  /** 부모 Task — 얇은 요약 막대 + 드래그 불가 */
  summary: boolean;
  overdue: boolean;
  /** 행 높이 안에서 세로 가운데 정렬에 쓴다 */
  rowHeight: number;
  title: string;
  /** 아직 저장되지 않은 위치(충돌·실패) — 사용자가 알아볼 수 있게 표시한다 */
  unsaved: boolean;
  dragging: boolean;
  busy: boolean;
  onDragStart: (mode: DragMode, clientX: number) => void;
}

export default function GanttBar({
  geometry,
  progress,
  status,
  summary,
  overdue,
  rowHeight,
  title,
  unsaved,
  dragging,
  busy,
  onDragStart,
}: GanttBarProps) {
  const token = TASK_STATUS_COLORS[status];
  const height = summary ? SUMMARY_HEIGHT : BAR_HEIGHT;
  const draggable = !summary && !busy;

  const notes: string[] = [];
  if (summary) notes.push('하위 작업에서 계산된 기간입니다. 하위 작업의 날짜를 바꾸세요.');
  if (geometry.partial) notes.push('시작일 또는 마감일 한쪽만 입력되어 하루로 표시합니다.');
  if (geometry.reversed) notes.push('마감일이 시작일보다 빠릅니다. 날짜를 확인하세요.');
  if (geometry.truncated) notes.push('실제 기간보다 넓게 그렸습니다(최소 표시 폭).');
  if (unsaved) notes.push('아직 저장되지 않은 위치입니다.');

  const label = `${title} · ${geometry.startDate} ~ ${geometry.endDate}${
    notes.length > 0 ? ` · ${notes.join(' ')}` : ''
  }`;

  return (
    <div
      role="img"
      aria-label={label}
      title={label}
      onPointerDown={
        draggable
          ? (e) => {
              if (e.button !== 0) return;
              e.preventDefault();
              onDragStart('move', e.clientX);
            }
          : undefined
      }
      className={`absolute rounded-sm ${STATUS_BG[token] ?? 'bg-slate-400'} ${
        summary ? 'opacity-90' : ''
      } ${overdue ? 'ring-1 ring-red-600' : ''} ${
        unsaved ? 'ring-2 ring-amber-500' : ''
      } ${dragging ? 'opacity-70 shadow-lg' : ''} ${
        geometry.truncated ? 'outline-dotted outline-1 outline-slate-500' : ''
      } ${draggable ? 'cursor-grab active:cursor-grabbing' : 'cursor-not-allowed'}`}
      style={{
        left: geometry.left,
        width: geometry.width,
        height,
        top: (rowHeight - height) / 2,
      }}
    >
      {/* 진척률 채움 — 막대 안쪽 (§7.5) */}
      <div
        aria-hidden
        className={`h-full rounded-sm ${STATUS_FILL[token] ?? 'bg-slate-600'}`}
        style={{ width: `${Math.max(0, Math.min(100, progress))}%` }}
      />

      {summary ? (
        // 요약 막대의 양끝 캡 — 자식 구간의 시작·끝을 눈으로 잡아 주는 표시
        <>
          <span
            aria-hidden
            className={`absolute -top-1 left-0 w-0.5 ${STATUS_FILL[token] ?? 'bg-slate-600'}`}
            style={{ height: SUMMARY_HEIGHT + 4 }}
          />
          <span
            aria-hidden
            className={`absolute -top-1 right-0 w-0.5 ${STATUS_FILL[token] ?? 'bg-slate-600'}`}
            style={{ height: SUMMARY_HEIGHT + 4 }}
          />
        </>
      ) : (
        // 양끝 리사이즈 핸들 (§7.5). 요약 막대에는 두지 않는다 — 저장할 곳이 없다
        draggable && (
          <>
            <span
              role="separator"
              aria-label="시작일 조정"
              onPointerDown={(e) => {
                if (e.button !== 0) return;
                e.preventDefault();
                e.stopPropagation();
                onDragStart('start', e.clientX);
              }}
              className="absolute inset-y-0 left-0 cursor-ew-resize"
              style={{ width: HANDLE_PX }}
            />
            <span
              role="separator"
              aria-label="마감일 조정"
              onPointerDown={(e) => {
                if (e.button !== 0) return;
                e.preventDefault();
                e.stopPropagation();
                onDragStart('end', e.clientX);
              }}
              className="absolute inset-y-0 right-0 cursor-ew-resize"
              style={{ width: HANDLE_PX }}
            />
          </>
        )
      )}
    </div>
  );
}
