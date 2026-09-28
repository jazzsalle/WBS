'use client';

// 목표 관리 화면 컨테이너 (SOT §7.7 "성과목표 + 기술목표 (탭 2개)")
// 데이터는 전부 서버(page.tsx)가 조회해 내려준다 — 여기서는 어떤 탭을 보여줄지만 소유한다.
// 달성률·경고 판정은 서버가 끝낸 값을 섹션이 그대로 쓴다(O-4). 여기서 가공하지 않는다.
// 비활성 탭은 언마운트한다: §7.7 탭 2의 인쇄용 레이아웃이 감춰진 탭까지 함께 인쇄하는 것을 막고,
// 열려 있던 폼의 R-4 보류 카운터도 정리 함수로 함께 풀린다.
// 툴바의 목표 양식 내려받기·올리기(§7.7, GF-1·GF-5)는 두 시트를 한 파일로 다루므로 탭 밖에 둔다.

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import type { GoalsData } from '@/actions/goals';
import Button from '@/components/ui/Button';
import DeliverableSection from './DeliverableSection';
import GoalFormDownload from './GoalFormDownload';
import GoalFormUpload from './GoalFormUpload';
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
  const router = useRouter();
  const [tab, setTab] = useState<GoalTab>('deliverables');
  // 모달을 닫으면 선택·미리보기는 언마운트로 폐기된다 (연구비 화면 입력 양식과 같다)
  const [formModal, setFormModal] = useState<'download' | 'upload' | null>(null);
  const [formResult, setFormResult] = useState<string | null>(null);

  return (
    <div>
      <div className="mb-4 flex flex-wrap items-center justify-end gap-2 print:hidden">
        <Button
          size="sm"
          variant="secondary"
          title="성과목표·성과실적·기술목표·측정이력이 채워진 목표 양식(xlsx)을 내려받습니다 (§7.7). 앱 데이터는 바뀌지 않습니다"
          onClick={() => setFormModal('download')}
        >
          양식 내려받기
        </Button>
        <Button
          size="sm"
          variant="secondary"
          title="고친 목표 양식을 올려 미리보기 뒤 반영합니다 (§7.7). 반영은 되돌릴 수 없습니다"
          onClick={() => setFormModal('upload')}
        >
          양식 올리기
        </Button>
      </div>

      {formResult && (
        <p
          role="status"
          className="mb-4 flex items-center gap-2 rounded-lg border border-green-200 bg-green-50 px-3 py-2 text-xs text-green-800 print:hidden"
        >
          {formResult}
          <button
            type="button"
            onClick={() => setFormResult(null)}
            aria-label="알림 닫기"
            className="ml-auto font-bold text-green-500 hover:text-green-700"
          >
            ×
          </button>
        </p>
      )}

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

      {formModal === 'download' && <GoalFormDownload projectId={projectId} onClose={() => setFormModal(null)} />}

      {formModal === 'upload' && (
        <GoalFormUpload
          projectId={projectId}
          onClose={() => setFormModal(null)}
          onDone={(message) => {
            // 결과·충돌 목록은 모달이 먼저 보여 주고, 목표 표·달성률은 서버에서 다시 그린다
            setFormResult(message);
            router.refresh();
          }}
        />
      )}
    </div>
  );
}
