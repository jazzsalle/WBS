'use client';

// 긴 서술형 텍스트: 한 줄 + … + [더보기] (Phase 22 U-12)
// - 접힘: 첫 줄만 말줄임으로. 마우스 오버·키보드 포커스 때 전체 내용을 오버레이로 띄운다.
// - [더보기]: 제자리에서 아래로 펼친다. 펼친 뒤에는 전부 보이므로 오버레이를 띄우지 않는다.
// - 인쇄: 화면 상태와 무관하게 항상 전부 펼친다 (계획서 표 형식 §7.7).
// 오버레이는 body 포털 + fixed 좌표다 — 표 래퍼의 overflow에 잘리지 않게 하려는 것.
// 텍스트는 React 텍스트 노드로만 그린다(사용자 입력이다).

import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { placeOverlay, splitFirstLine, type OverlayPlacement } from './expandableTextLayout';

export interface ExpandableTextProps {
  text: string;
  /** 스크린리더용 대상 이름 (예: "평가환경") */
  label?: string;
  /** 비어 있을 때 보일 문자 */
  emptyText?: string;
  /** 폭 제한 등. 표 칸에서는 max-w-* 를 줘야 말줄임이 걸린다 */
  className?: string;
}

const OPEN_DELAY_MS = 150;
// 텍스트에서 오버레이로 마우스를 옮기는 사이에 닫히지 않게 둔 여유
const CLOSE_DELAY_MS = 120;

export default function ExpandableText({ text, label, emptyText = '—', className = '' }: ExpandableTextProps) {
  const { first, hasMore } = splitFirstLine(text);
  const [expanded, setExpanded] = useState(false);
  const [overflowing, setOverflowing] = useState(false);
  const [placement, setPlacement] = useState<OverlayPlacement | null>(null);
  const anchorRef = useRef<HTMLDivElement>(null);
  const lineRef = useRef<HTMLSpanElement>(null);
  const openTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const tooltipId = useId();

  // 한 줄 폭을 넘는지는 글꼴·칸 폭에 달려 있어 실제 렌더 폭으로만 판정할 수 있다
  useLayoutEffect(() => {
    const el = lineRef.current;
    if (!el) return;
    const measure = () => setOverflowing(el.scrollWidth > el.clientWidth + 1);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, [expanded, first]);

  const collapsible = hasMore || overflowing;

  const clearTimers = () => {
    if (openTimer.current) clearTimeout(openTimer.current);
    if (closeTimer.current) clearTimeout(closeTimer.current);
    openTimer.current = null;
    closeTimer.current = null;
  };

  const showNow = useCallback(() => {
    const anchor = anchorRef.current;
    if (!anchor) return;
    const rect = anchor.getBoundingClientRect();
    setPlacement(placeOverlay(rect, window.innerWidth, window.innerHeight));
  }, []);

  const hide = useCallback(() => {
    clearTimers();
    setPlacement(null);
  }, []);

  const scheduleOpen = () => {
    if (expanded || !collapsible) return;
    if (closeTimer.current) clearTimeout(closeTimer.current);
    closeTimer.current = null;
    if (placement || openTimer.current) return;
    openTimer.current = setTimeout(() => {
      openTimer.current = null;
      showNow();
    }, OPEN_DELAY_MS);
  };

  const scheduleClose = () => {
    if (openTimer.current) clearTimeout(openTimer.current);
    openTimer.current = null;
    if (closeTimer.current) clearTimeout(closeTimer.current);
    closeTimer.current = setTimeout(() => {
      closeTimer.current = null;
      setPlacement(null);
    }, CLOSE_DELAY_MS);
  };

  // fixed 좌표는 스크롤·리사이즈 순간 앵커에서 떨어진다 — 따라가지 않고 닫는다
  useEffect(() => {
    if (!placement) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') hide();
    };
    const onScroll = (e: Event) => {
      // 오버레이 안쪽 스크롤은 긴 내용을 읽는 동작이라 닫지 않는다
      if (e.target instanceof Node && document.getElementById(tooltipId)?.contains(e.target)) return;
      hide();
    };
    document.addEventListener('keydown', onKey);
    window.addEventListener('scroll', onScroll, true);
    window.addEventListener('resize', hide);
    return () => {
      document.removeEventListener('keydown', onKey);
      window.removeEventListener('scroll', onScroll, true);
      window.removeEventListener('resize', hide);
    };
  }, [placement, hide, tooltipId]);

  useEffect(() => () => clearTimers(), []);

  if (text.trim() === '') return <span className={className}>{emptyText}</span>;

  const full = <span className="block whitespace-pre-wrap break-words">{text.trim()}</span>;

  if (expanded) {
    return (
      <div className={className}>
        {full}
        <button
          type="button"
          onClick={() => setExpanded(false)}
          aria-expanded
          aria-label={label ? `${label} 접기` : undefined}
          className="mt-0.5 text-xs font-medium text-blue-500 hover:underline print:hidden"
        >
          접기
        </button>
      </div>
    );
  }

  return (
    <div className={className}>
      <div
        ref={anchorRef}
        className="flex min-w-0 items-baseline gap-1.5 print:hidden"
        onMouseEnter={scheduleOpen}
        onMouseLeave={scheduleClose}
      >
        <span ref={lineRef} className="min-w-0 truncate">
          {first}
          {hasMore && ' …'}
        </span>
        {collapsible && (
          <button
            type="button"
            onClick={() => {
              hide();
              setExpanded(true);
            }}
            onFocus={() => {
              clearTimers();
              showNow();
            }}
            onBlur={hide}
            aria-expanded={false}
            aria-describedby={placement ? tooltipId : undefined}
            aria-label={label ? `${label} 더보기` : undefined}
            className="shrink-0 text-xs font-medium text-blue-500 hover:underline"
          >
            더보기
          </button>
        )}
      </div>
      {/* 인쇄는 화면 상태와 무관하게 전부 */}
      <div className="hidden print:block">{full}</div>

      {placement &&
        createPortal(
          <div
            id={tooltipId}
            role="tooltip"
            onMouseEnter={() => {
              if (closeTimer.current) clearTimeout(closeTimer.current);
              closeTimer.current = null;
            }}
            onMouseLeave={scheduleClose}
            style={{
              left: placement.left,
              width: placement.width,
              maxHeight: placement.maxHeight,
              top: placement.top ?? undefined,
              bottom: placement.bottom ?? undefined,
            }}
            className="fixed z-40 overflow-auto whitespace-pre-wrap break-words rounded-lg border border-grey-200 bg-surface p-3 text-xs leading-relaxed text-grey-800 shadow-lg print:hidden"
          >
            {text.trim()}
          </div>,
          document.body,
        )}
    </div>
  );
}
