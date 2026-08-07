'use client';

// 과제 하위 공통 탭 네비게이션 (SOT §7.1 라우팅표)
// 탭이 10개라 1차(개요·WBS·간트·보드·목표) / 2차(마일스톤·연구비·인력·리스크·노트)로 시각 그룹을 나눈다.
// 아직 구현되지 않은 Phase의 탭은 링크로 걸지 않는다 — 죽은 링크 대신 "Phase N에서 구현" 안내를 띄운다.
// 구현 Phase는 SOT §11 순서표를 따른다.

import { useState } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';

interface TabDef {
  /** `/projects/[id]` 뒤에 붙는 경로. 개요는 '' */
  segment: string;
  label: string;
  /** SOT §11 구현 순서. IMPLEMENTED_THROUGH 이하면 링크로 활성화한다 */
  phase: number;
}

const PRIMARY_TABS: readonly TabDef[] = [
  { segment: '', label: '개요', phase: 1 },
  { segment: '/wbs', label: 'WBS', phase: 1 },
  { segment: '/gantt', label: '간트', phase: 7 },
  { segment: '/board', label: '보드', phase: 7 },
  { segment: '/goals', label: '목표', phase: 3 },
] as const;

const SECONDARY_TABS: readonly TabDef[] = [
  { segment: '/milestones', label: '마일스톤', phase: 4 },
  { segment: '/budget', label: '연구비', phase: 5 },
  { segment: '/team', label: '인력·기관', phase: 2 },
  { segment: '/risks', label: '리스크', phase: 6 },
  { segment: '/notes', label: '노트', phase: 6 },
] as const;

/**
 * 현재까지 구현된 Phase. 다음 Phase를 마칠 때 이 값을 올린다 (§11).
 * Phase 8로 올려도 화면은 그대로다 — 위 탭 10개가 전부 phase ≤ 7이라 비활성 탭이 애초에 없다.
 * Phase 8 산출물(To-Do·설정)은 과제 밖 라우트라 이 탭 배열에 들어가지 않는다 (§7.1).
 * 이 값은 "어디까지 구현됐는가"를 코드에 남기는 용도다.
 */
const IMPLEMENTED_THROUGH = 8;

const ACTIVE_CLASSES = 'border-slate-900 text-slate-900';
const INACTIVE_CLASSES = 'border-transparent text-slate-500 hover:text-slate-800';

export interface TabNavProps {
  projectId: string;
}

export default function TabNav({ projectId }: TabNavProps) {
  const pathname = usePathname();
  const [notice, setNotice] = useState<string | null>(null);

  const base = `/projects/${projectId}`;

  const isActive = (segment: string): boolean =>
    segment === '' ? pathname === base : pathname.startsWith(`${base}${segment}`);

  const renderTab = (tab: TabDef, group: 'primary' | 'secondary') => {
    const active = isActive(tab.segment);
    const sizeClasses =
      group === 'primary' ? 'px-4 py-2.5 text-sm font-semibold' : 'px-3 py-2 text-xs font-medium';

    if (tab.phase > IMPLEMENTED_THROUGH) {
      return (
        <button
          key={tab.segment || 'overview'}
          type="button"
          aria-disabled
          title={`Phase ${tab.phase}에서 구현됩니다`}
          onClick={() => setNotice(`${tab.label} 화면은 Phase ${tab.phase}에서 구현됩니다.`)}
          className={`shrink-0 border-b-2 border-transparent text-slate-300 ${sizeClasses}`}
        >
          {tab.label}
        </button>
      );
    }

    return (
      <Link
        key={tab.segment || 'overview'}
        href={`${base}${tab.segment}`}
        aria-current={active ? 'page' : undefined}
        onClick={() => setNotice(null)}
        className={`shrink-0 border-b-2 ${sizeClasses} ${active ? ACTIVE_CLASSES : INACTIVE_CLASSES}`}
      >
        {tab.label}
      </Link>
    );
  };

  return (
    <div>
      <nav aria-label="과제 화면" className="flex flex-wrap items-end gap-x-6 gap-y-1">
        <div className="flex items-end gap-1 border-b border-slate-200">
          {PRIMARY_TABS.map((tab) => renderTab(tab, 'primary'))}
        </div>
        <div className="flex items-end gap-1 border-b border-slate-200">
          {SECONDARY_TABS.map((tab) => renderTab(tab, 'secondary'))}
        </div>
      </nav>

      {notice && (
        <p
          role="status"
          className="mt-2 flex items-center gap-2 rounded-lg bg-slate-100 px-3 py-1.5 text-xs text-slate-600"
        >
          {notice}
          <button
            type="button"
            onClick={() => setNotice(null)}
            aria-label="안내 닫기"
            className="ml-auto font-bold text-slate-400 hover:text-slate-600"
          >
            ×
          </button>
        </p>
      )}
    </div>
  );
}
