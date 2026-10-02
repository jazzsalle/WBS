'use client';

// 연구비 수행 모드 — 협약 예산 화면 셸 (SOT §7.9.8, §5.21 AV-1~AV-8, §12 P-R1·P-R3·P-R4, 계획서 S-17, U-3·U-6)
// 데이터는 서버(getAgreementData)가 한 벌로 내려준다. 이 컴포넌트가 소유하는 것: 보고 있는 버전, 보기 탭,
// 쓰기 성공 뒤 router.refresh() 한 번. 현재·기준 버전·합계는 서버가 계산한 파생 값을 그대로 쓴다(AG-1).
//
// - 조회 실패면 오류 배너만 — 빈 화면이나 0으로 눙치지 않는다(절대 규칙 5)
// - 버전이 없으면 숫자 없이 안내 + [빈 버전]만(0 매트릭스 금지)
// - 탭은 [비목별]·[변경 이력] 둘뿐이다(U-6 — 아직 없는 보기는 자리표시 탭도 두지 않는다)
// - 인쇄는 보고 있는 보기 하나, 가로. 머리말에 버전 이름·상태를 더한다(§7.9.8 인쇄)

import { useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import type { AgreementData } from '@/actions/agreement';
import { AGREEMENT_VERSION_STATUS_LABELS } from '@/lib/constants';
import Button from '@/components/ui/Button';
import ErrorBanner from '@/components/ui/ErrorBanner';
import HelpLink from '@/components/help/HelpLink';
import PrintHeader from '@/components/print/PrintHeader';
import CategoryView from './CategoryView';
import ChangesView from './ChangesView';
import NewVersionDialog from './NewVersionDialog';
import VersionBar, { versionTitle } from './VersionBar';

type AgreementTab = 'category' | 'changes';

// §7.9.8 Phase 24의 보기 탭. 붙임4형·조정회의형·참여인원·편성 항목은 해당 Phase에서 여기에 더한다(U-6)
const TABS: readonly { value: AgreementTab; label: string; hint: string }[] = [
  { value: 'category', label: '비목별', hint: '연차 × 비목 × 현금/현물 매트릭스 (AG-2)' },
  { value: 'changes', label: '변경 이력', hint: '두 버전 사이 금액 줄·참여인원 증감과 세목 총액 보존 (AG-7)' },
];

// SOT §7.9.8 문구 그대로
const NO_VERSION_NOTICE =
  '협약 예산 버전이 없습니다 — 제안 모드에서 [협약 기준선으로 보내기]로 만들거나 [빈 버전]으로 시작하세요';

export interface AgreementScreenProps {
  /** getAgreementData 결과. 실패면 null이고 error에 문구가 온다 */
  data: AgreementData | null;
  /** 조회 실패 문구(VALIDATION 손상 안내 포함). 있으면 배너만 보인다 */
  error: string | null;
}

export default function AgreementScreen({ data, error }: AgreementScreenProps) {
  if (error !== null || data === null) {
    return (
      <ErrorBanner
        // 둘 다 null이면 호출부 계약 위반이다 — 빈 화면으로 넘기지 않고 사실대로 알린다
        message={error ?? '협약 예산 데이터를 받지 못했습니다. 화면을 새로고침하세요.'}
        className="whitespace-pre-line"
      />
    );
  }
  return <AgreementScreenBody data={data} />;
}

function AgreementScreenBody({ data }: { data: AgreementData }) {
  const router = useRouter();
  // null = 기본(현재 버전, AV-3). 사용자가 고른 버전 id를 들고 있다 — 화면 로컬 상태, URL·DB에 남기지 않는다
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [tab, setTab] = useState<AgreementTab>('category');
  const [emptyDialogOpen, setEmptyDialogOpen] = useState(false);

  const { versions } = data;

  const picked = selectedId ? versions.find((x) => x.version.id === selectedId) ?? null : null;
  // 고른 버전이 그사이 지워졌으면(남의 삭제 등) 현재 버전으로 돌아가되, 돌아갔다는 사실을 알린다
  const selectedMissing = selectedId !== null && picked === null;
  const selected =
    picked ??
    (data.currentVersionId ? versions.find((x) => x.version.id === data.currentVersionId) ?? null : null) ??
    versions[versions.length - 1] ??
    null;

  // 변경 이력 초깃값: A = 보고 있는 버전의 직전 버전, B = 보고 있는 버전 (S-12)
  const previousId = useMemo(() => {
    if (!selected) return null;
    const index = versions.findIndex((x) => x.version.id === selected.version.id);
    return index > 0 ? versions[index - 1]!.version.id : null;
  }, [versions, selected]);

  const refresh = (): void => router.refresh();

  if (versions.length === 0 || selected === null) {
    return (
      <div className="space-y-4">
        <div className="flex items-center justify-end print:hidden">
          <HelpLink slug="budget" anchor="수행 모드 — 협약 예산" />
        </div>
        <div className="rounded-xl border border-dashed border-grey-300 bg-surface p-8 text-center">
          <p className="text-sm text-grey-700">{NO_VERSION_NOTICE}</p>
          <div className="mt-4 flex justify-center print:hidden">
            <Button variant="primary" onClick={() => setEmptyDialogOpen(true)}>
              빈 버전
            </Button>
          </div>
        </div>
        {emptyDialogOpen && (
          <NewVersionDialog
            mode="empty"
            projectId={data.projectId}
            sourceName={null}
            initialMeta={data.nextVersionMeta}
            onClose={() => setEmptyDialogOpen(false)}
            onCreated={(id) => {
              setEmptyDialogOpen(false);
              setSelectedId(id);
              refresh();
            }}
          />
        )}
      </div>
    );
  }

  const v = selected.version;
  const statusLabel = AGREEMENT_VERSION_STATUS_LABELS[v.status];
  const tabLabel = TABS.find((t) => t.value === tab)?.label ?? '';

  return (
    <div className="space-y-4">
      {/* P-R4: 버전 바·탭·버튼은 인쇄에서 뺀다 — 무엇을 뽑았는지는 머리말이 알린다 */}
      <div className="space-y-3 print:hidden">
        <div className="flex items-start justify-between gap-3">
          <VersionBar
            projectId={data.projectId}
            versions={versions}
            selected={selected}
            currentVersionId={data.currentVersionId}
            draftVersionId={data.draftVersionId}
            nextVersionMeta={data.nextVersionMeta}
            onSelect={(id) => setSelectedId(id)}
            onCreated={(id) => {
              setSelectedId(id);
              refresh();
            }}
            onChanged={refresh}
            onDeleted={() => {
              setSelectedId(null);
              refresh();
            }}
          />
          <HelpLink slug="budget" anchor="수행 모드 — 협약 예산" />
        </div>

        {selectedMissing && (
          <div className="flex items-center justify-between gap-3 rounded-xl border border-orange-200 bg-orange-50 px-3 py-2 text-xs text-orange-800">
            <span>보고 있던 버전이 삭제되어 현재 버전을 보여 줍니다.</span>
            <button
              type="button"
              onClick={() => setSelectedId(null)}
              aria-label="알림 닫기"
              className="font-bold opacity-60 hover:opacity-100"
            >
              ×
            </button>
          </div>
        )}

        <div className="inline-flex items-center gap-1" role="tablist" aria-label="협약 예산 보기">
          {TABS.map((item) => {
            const active = item.value === tab;
            return (
              <button
                key={item.value}
                type="button"
                role="tab"
                aria-selected={active}
                title={item.hint}
                onClick={() => setTab(item.value)}
                className={`rounded-lg px-3 py-1.5 text-sm font-semibold transition ${
                  active
                    ? 'bg-blue-500 text-white'
                    : 'border border-grey-300 bg-surface text-grey-700 hover:bg-grey-50'
                }`}
              >
                {item.label}
              </button>
            );
          })}
        </div>
      </div>

      {/* P-R1 가로(예산 매트릭스와 같다) · P-R3 머리말에 버전 이름·상태를 더한다 */}
      <PrintHeader
        title={`협약 예산 ${tabLabel} — ${versionTitle(v)} · ${statusLabel}`}
        projectName={data.projectName}
        todayISO={data.todayISO}
        orientation="landscape"
      />

      {tab === 'category' ? (
        <CategoryView
          // 버전을 바꾸면 편집 중이던 셀 상태를 넘겨 들고 가지 않는다
          key={v.id}
          projectId={data.projectId}
          view={selected}
          years={data.years}
          currencyUnit={data.currencyUnit}
          // AV-2: 확정 버전은 읽기 전용. 액션도 RULE로 막는다 — 화면은 편집 칸을 열지 않을 뿐이다
          editable={v.status === 'draft'}
          onChanged={refresh}
        />
      ) : (
        <ChangesView
          // 보고 있는 버전이 바뀌면 A·B 초깃값을 다시 잡는다
          key={v.id}
          projectId={data.projectId}
          versions={versions}
          years={data.years}
          currencyUnit={data.currencyUnit}
          defaultFromId={previousId}
          defaultToId={v.id}
        />
      )}
    </div>
  );
}
