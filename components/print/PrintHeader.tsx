'use client';

// 인쇄 머리말 + 용지 방향 (SOT §12 P-R1·P-R3)
//
// 방향을 화면별로 거는 방법:
//  - @page는 선택자를 받지 못한다. "이 표만 가로"를 CSS 파일 하나로 나눌 수 없다.
//  - 이름 붙은 페이지(`@page landscape` + `page: landscape`)는 크로미움에서만 안전하다.
//    §12 브라우저 기준에 Safari가 있고, 지원하지 않는 엔진에서는 경고 없이 세로로 나온다.
//    "동작하는 척"이 되므로 쓰지 않는다.
//  - 그래서 방향이 필요한 화면이 마운트되어 있는 동안에만 <style>을 head 끝에 붙였다 뗀다.
//    globals.css의 기본 @page(세로)보다 뒤에 오므로 캐스케이드에서 확실히 이기고,
//    클라이언트 내비게이션으로 화면을 떠나면 정리 함수가 원복한다.
//    @page의 size/margin은 일반 선언처럼 캐스케이드되므로 방향만 덮어써도 되지만,
//    나중에 기본값을 고칠 때 어긋나지 않도록 margin도 함께 명시한다.
//
// 머리말은 화면에서 숨기고 인쇄에만 남긴다(P-R3). 출력일은 서버가 Asia/Seoul 달력으로
// 만든 todayISO를 그대로 쓴다 — 여기서 new Date()를 부르면 사용자 PC 시간대에 따라
// §6.5의 기준일과 다른 날짜가 종이에 찍힌다.

import { useEffect } from 'react';

export type PrintOrientation = 'portrait' | 'landscape';

const PAGE_MARGIN = '12mm'; // P-R1

function usePageOrientation(orientation: PrintOrientation): void {
  useEffect(() => {
    // 세로는 globals.css의 기본값이라 덧씌울 것이 없다
    if (orientation === 'portrait') return;

    const style = document.createElement('style');
    style.media = 'print';
    style.setAttribute('data-print-orientation', orientation);
    style.textContent = `@page { size: A4 ${orientation}; margin: ${PAGE_MARGIN}; }`;
    document.head.appendChild(style);
    return () => style.remove();
  }, [orientation]);
}

export interface PrintHeaderProps {
  /** 표 이름 (예: '리스크 관리대장') */
  title: string;
  projectName: string;
  /** 'YYYY-MM-DD'. 서버가 만든 오늘을 받는다 (§6.5 Asia/Seoul 고정) */
  todayISO: string;
  orientation: PrintOrientation;
  /** 표를 읽는 데 필요한 한 줄 (예: 금액 표시 단위). 없으면 생략한다 */
  subtitle?: string;
}

export default function PrintHeader({
  title,
  projectName,
  todayISO,
  orientation,
  subtitle,
}: PrintHeaderProps) {
  usePageOrientation(orientation);

  return (
    <header className="hidden text-black print:mb-2 print:block print:border-b print:border-slate-400 print:pb-1">
      <p className="text-sm font-bold">
        {/* 과제명이 비어 있어도 무엇을 뽑았는지 알 수 있게 사실대로 적는다 */}
        {projectName.trim() === '' ? '(이름 없는 과제)' : projectName} · {title}
      </p>
      <p className="text-[11px]">
        출력일 {todayISO}
        {subtitle && <span className="ml-3">{subtitle}</span>}
      </p>
    </header>
  );
}
