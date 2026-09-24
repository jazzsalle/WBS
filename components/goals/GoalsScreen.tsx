'use client';

// 목표 관리 화면 컨테이너 (SOT §7.7 "성과목표 + 기술목표 (탭 2개)")
// 데이터는 전부 서버(page.tsx)가 조회해 내려준다 — 여기서는 어떤 탭을 보여줄지만 소유한다.
// 달성률·경고 판정은 서버가 끝낸 값을 섹션이 그대로 쓴다(O-4). 여기서 가공하지 않는다.
// 비활성 탭은 언마운트한다: §7.7 탭 2의 인쇄용 레이아웃이 감춰진 탭까지 함께 인쇄하는 것을 막고,
// 열려 있던 폼의 R-4 보류 카운터도 정리 함수로 함께 풀린다.

import { useState } from 'react';
import type { GoalsData } from '@/actions/goals';
import DeliverableSection from './DeliverableSection';
import TechTargetSection from './TechTargetSection';

type GoalTab = 'deliverables' | 'techTargets';

const TABS: readonly { id: GoalTab; label: string }[] = [
  { id: 'deliverables', label: '정량적 성과목표' },
  { id: 'techTargets', label: '정량적 기술목표' },
] as const;

const ACTIVE_CLASSES = 'border-grey-900 text-grey-900';
const INACTIVE_CLASSES = 'border-transparent text-grey-500 hover:text-grey-800';

export interface GoalsScreenProps {
  projectId: string;
  data: GoalsData;
}

export default function GoalsScreen({ projectId, data }: GoalsScreenProps) {
  const [tab, setTab] = useState<GoalTab>('deliverables');

  return (
    <div>
      {/* 인쇄(§7.7)에서는 탭 자체가 의미 없으므로 감춘다 — 표만 남는다 */}
      <div role="tablist" aria-label="목표 종류" className="flex gap-1 border-b border-grey-200 print:hidden">
        {TABS.map((item) => (
          <button
            key={item.id}
            type="button"
            role="tab"
            id={`goal-tab-${item.id}`}
            aria-selected={tab === item.id}
            aria-controls={`goal-panel-${item.id}`}
            onClick={() => setTab(item.id)}
            className={`shrink-0 border-b-2 px-4 py-2.5 text-sm font-semibold ${
              tab === item.id ? ACTIVE_CLASSES : INACTIVE_CLASSES
            }`}
          >
            {item.label}
          </button>
        ))}
      </div>

      <div
        role="tabpanel"
        id={`goal-panel-${tab}`}
        aria-labelledby={`goal-tab-${tab}`}
        className="mt-6"
      >
        {tab === 'deliverables' ? (
          <DeliverableSection
            projectId={projectId}
            views={data.deliverables}
            summary={data.deliverableSummary}
            years={data.years}
            organizations={data.organizations}
            members={data.members}
          />
        ) : (
          <TechTargetSection
            projectId={projectId}
            projectName={data.projectName}
            todayISO={data.todayISO}
            views={data.techTargets}
            summary={data.techSummary}
            years={data.years}
            organizations={data.organizations}
          />
        )}
      </div>
    </div>
  );
}
