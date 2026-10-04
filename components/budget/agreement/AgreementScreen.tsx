'use client';

// 연구비 수행 모드 — 협약 예산 화면 셸 (SOT §7.9.8, §5.21 AV-1~AV-8, §12 P-R1·P-R3·P-R4, 계획서 S-17, U-3·U-6,
// Phase 25 S-17, Phase 26 S-9·S-10)
// 데이터는 서버(getAgreementData)가 한 벌로 내려준다. 이 컴포넌트가 소유하는 것: 보고 있는 버전, 보기 탭,
// 규칙 검증 패널의 "클릭 → 이동" 강조, 쓰기 성공 뒤 router.refresh() 한 번. 현재·기준 버전·합계·판정은 서버가
// 계산한 파생 값을 그대로 쓴다(AG-1).
//
// - 조회 실패면 오류 배너만 — 빈 화면이나 0으로 눙치지 않는다(절대 규칙 5)
// - 버전이 없으면 숫자 없이 안내 + [빈 버전]·[붙임4 가져오기]만(0 매트릭스 금지)
// - 탭은 [비목별]·[붙임4형]·[조정회의형]·[참여인원]·[편성 항목·증빙]·[변경 이력] 여섯이다(AG-1, Phase 26)
// - 보기 탭 아래 공통 영역에 규칙 검증 패널(RuleFindingsPanel 재사용 — 수행용 복제 없음). 판정은 보고 있는 버전의
//   `ruleResult`다(§6.14.8). [연구비 규칙]은 버전 바 오른쪽 — 모달은 부모(BudgetScreen)가 제안 모드와 같은
//   RulesEditor 하나를 연다(같은 규칙 행, §7.9.5)
// - 인쇄는 보고 있는 보기 하나, 가로. 머리말에 버전 이름·상태를 더한다(§7.9.8 인쇄)

import { useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import type { AgreementData } from '@/actions/agreement';
import { AGREEMENT_VERSION_STATUS_LABELS } from '@/lib/constants';
import { AGREEMENT_RULE_TOTALS_SOURCE_LABEL } from '@/lib/agreement/rule-input';
import RuleFindingsPanel from '@/components/budget/rules/RuleFindingsPanel';
import Button from '@/components/ui/Button';
import ErrorBanner from '@/components/ui/ErrorBanner';
import HelpLink from '@/components/help/HelpLink';
import PrintHeader from '@/components/print/PrintHeader';
import AdjustmentView from './AdjustmentView';
import Attachment4ImportDialog from './Attachment4ImportDialog';
import Attachment4View from './Attachment4View';
import CategoryView from './CategoryView';
import ChangesView from './ChangesView';
import ItemsView from './ItemsView';
import ParticipantsView from './ParticipantsView';
import NewVersionDialog from './NewVersionDialog';
import VersionBar, { versionTitle } from './VersionBar';

type AgreementTab = 'category' | 'attachment4' | 'adjustment' | 'participants' | 'items' | 'changes';

// §7.9.8 보기 탭 6종(AG-1 순서, Phase 26 — 숨긴 탭이 더는 없다)
const TABS: readonly { value: AgreementTab; label: string; hint: string }[] = [
  { value: 'category', label: '비목별', hint: '연차 × 비목 × 현금/현물 매트릭스 (AG-2)' },
  { value: 'attachment4', label: '붙임4형', hint: '8-1 지원·부담계획 + 8-2 사용계획 (AG-3)' },
  { value: 'adjustment', label: '조정회의형', hint: '변경전(제안) · 변경후(이 버전) 두 표, 읽기 전용 (AG-4)' },
  { value: 'participants', label: '참여인원', hint: '참여인원 목록 · 연차 소계 · 금액 줄 대조 (AG-5)' },
  { value: 'items', label: '편성 항목·증빙', hint: '장비·재료·외주 건별 목록 · 증빙 체크 · 금액 줄 대조 (AG-6)' },
  { value: 'changes', label: '변경 이력', hint: '두 버전 사이 금액 줄·참여인원 증감과 세목 총액 보존 (AG-7)' },
];

// SOT §7.9.8 문구 그대로
const NO_VERSION_NOTICE =
  '협약 예산 버전이 없습니다 — 제안 모드에서 [협약 기준선으로 보내기]로 만들거나, [붙임4 가져오기]로 가져오거나, [빈 버전]으로 시작하세요';

// 규칙 패널 머리의 RL-8·RL-9 총액 출처 줄(§7.9.8 ②). 라벨만으로는 무엇의 기준인지 읽히지 않아 규칙 번호를 붙인다
const TOTALS_SOURCE_NOTICE = `RL-8·RL-9 총액: ${AGREEMENT_RULE_TOTALS_SOURCE_LABEL}`;

export interface AgreementScreenProps {
  /** getAgreementData 결과. 실패면 null이고 error에 문구가 온다 */
  data: AgreementData | null;
  /** 조회 실패 문구(VALIDATION 손상 안내 포함). 있으면 배너만 보인다 */
  error: string | null;
  /**
   * [붙임4 가져오기] 결과 문장. 부모(BudgetScreen)의 결과 토스트에 남긴다 — 반영 뒤 이 자리가 안내에서
   * 보기로 바뀌어도 무엇이 만들어졌는지 남아야 한다(제안 툴바의 같은 버튼과 같은 자리)
   */
  onImported: (message: string) => void;
  /** 버전 바 오른쪽 [연구비 규칙] — 부모가 제안 모드와 같은 RulesEditor 모달을 연다(§7.9.5) */
  onOpenRules: () => void;
}

export default function AgreementScreen({ data, error, onImported, onOpenRules }: AgreementScreenProps) {
  if (error !== null || data === null) {
    return (
      <ErrorBanner
        // 둘 다 null이면 호출부 계약 위반이다 — 빈 화면으로 넘기지 않고 사실대로 알린다
        message={error ?? '협약 예산 데이터를 받지 못했습니다. 화면을 새로고침하세요.'}
        className="whitespace-pre-line"
      />
    );
  }
  return <AgreementScreenBody data={data} onImported={onImported} onOpenRules={onOpenRules} />;
}

function AgreementScreenBody({
  data,
  onImported,
  onOpenRules,
}: {
  data: AgreementData;
  onImported: (message: string) => void;
  onOpenRules: () => void;
}) {
  const router = useRouter();
  // null = 기본(현재 버전, AV-3). 사용자가 고른 버전 id를 들고 있다 — 화면 로컬 상태, URL·DB에 남기지 않는다
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [tab, setTab] = useState<AgreementTab>('category');
  const [emptyDialogOpen, setEmptyDialogOpen] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  // §7.9.8 규칙 패널 "클릭 → 이동"의 강조. 화면 로컬 상태 — 버전을 바꾸면 버린다(다른 버전의 행 id다)
  const [highlightYearId, setHighlightYearId] = useState<string | null>(null);
  const [highlightParticipantId, setHighlightParticipantId] = useState<string | null>(null);
  const [highlightItemId, setHighlightItemId] = useState<string | null>(null);

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

  const selectVersion = (id: string | null): void => {
    setSelectedId(id);
    setHighlightYearId(null);
    setHighlightParticipantId(null);
    setHighlightItemId(null);
  };

  // 연차 finding → [비목별] 그 연차 열. 이미 [비목별]에서 같은 연차를 강조 중이면 해제(제안 모드와 같은 토글)
  const handleSelectYear = (yearId: string): void => {
    setHighlightYearId((prev) => (tab === 'category' && prev === yearId ? null : yearId));
    setTab('category');
  };
  // 참여인원 finding(scope participant) → [참여인원] 그 행
  const handleSelectParticipant = (_yearId: string, participantId: string): void => {
    setHighlightParticipantId(participantId);
    setTab('participants');
  };
  // 건 finding(scope item) → [편성 항목·증빙] 그 행
  const handleSelectItem = (_yearId: string, itemId: string): void => {
    setHighlightItemId(itemId);
    setTab('items');
  };

  if (versions.length === 0 || selected === null) {
    return (
      <div className="space-y-4">
        <div className="flex items-center justify-end print:hidden">
          <HelpLink slug="budget" anchor="수행 모드 — 협약 예산" />
        </div>
        <div className="rounded-xl border border-dashed border-grey-300 bg-surface p-8 text-center">
          <p className="text-sm text-grey-700">{NO_VERSION_NOTICE}</p>
          <div className="mt-4 flex justify-center gap-2 print:hidden">
            <Button variant="primary" onClick={() => setEmptyDialogOpen(true)}>
              빈 버전
            </Button>
            {/* 버전이 0개라 작성 중 버전도 없다 — 비활성 조건이 없다. 대화도 반영 전에 다시 검사한다(AV-2) */}
            <Button
              variant="secondary"
              title="제출용 붙임4 엑셀(8-1·8-2)에서 우리 기관 블록을 골라 작성 중 버전으로 만듭니다 (AV-7)"
              onClick={() => setImportOpen(true)}
            >
              붙임4 가져오기
            </Button>
          </div>
        </div>
        {/* §7.9.8 규칙 검증 — 판정할 버전이 없다. 0건 표·"위반 없음"을 보이면 판정했다고 읽힌다(절대 규칙 5) */}
        <p
          role="note"
          className="rounded-xl border border-dashed border-grey-300 bg-surface px-4 py-3 text-t7 text-grey-600"
        >
          규칙 검증: 판정할 버전 없음 — 협약 예산 버전을 만들면 그 버전을 연구비 규칙으로 판정합니다.
        </p>
        {emptyDialogOpen && (
          <NewVersionDialog
            mode="empty"
            projectId={data.projectId}
            sourceName={null}
            initialMeta={data.nextVersionMeta}
            onClose={() => setEmptyDialogOpen(false)}
            onCreated={(id) => {
              setEmptyDialogOpen(false);
              selectVersion(id);
              refresh();
            }}
          />
        )}
        <Attachment4ImportDialog
          projectId={data.projectId}
          currencyUnit={data.currencyUnit}
          open={importOpen}
          onClose={() => setImportOpen(false)}
          onDone={(message) => {
            // router.refresh()는 대화가 한다 — 새로 받은 데이터에서 그 버전이 현재 버전(AV-3)으로 보인다
            setImportOpen(false);
            onImported(message);
          }}
        />
      </div>
    );
  }

  const v = selected.version;
  const statusLabel = AGREEMENT_VERSION_STATUS_LABELS[v.status];
  const tabLabel = TABS.find((t) => t.value === tab)?.label ?? '';
  // AV-2: 확정 버전은 읽기 전용. 액션도 RULE로 막는다 — 화면은 편집 칸을 열지 않을 뿐이다
  const editable = v.status === 'draft';

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
            onSelect={(id) => selectVersion(id)}
            onCreated={(id) => {
              selectVersion(id);
              refresh();
            }}
            onChanged={refresh}
            onDeleted={() => {
              selectVersion(null);
              refresh();
            }}
          />
          <div className="flex shrink-0 items-center gap-2">
            <Button
              size="sm"
              variant="secondary"
              title="이 과제의 연구비 사용 규칙을 편집합니다 — 제안 모드와 같은 규칙입니다 (§7.9.5)"
              onClick={onOpenRules}
            >
              연구비 규칙
            </Button>
            <HelpLink slug="budget" anchor="수행 모드 — 협약 예산" />
          </div>
        </div>

        {selectedMissing && (
          <div className="flex items-center justify-between gap-3 rounded-xl border border-orange-200 bg-orange-50 px-3 py-2 text-xs text-orange-800">
            <span>보고 있던 버전이 삭제되어 현재 버전을 보여 줍니다.</span>
            <button
              type="button"
              onClick={() => selectVersion(null)}
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

      {/* 버전을 바꾸면 편집 중이던 칸·대화 상태를 넘겨 들고 가지 않는다 — 보기마다 key={v.id} */}
      {tab === 'category' ? (
        <CategoryView
          key={v.id}
          projectId={data.projectId}
          view={selected}
          years={data.years}
          currencyUnit={data.currencyUnit}
          editable={editable}
          highlightYearId={highlightYearId}
          onChanged={refresh}
        />
      ) : tab === 'attachment4' ? (
        <Attachment4View
          key={v.id}
          projectId={data.projectId}
          view={selected}
          currencyUnit={data.currencyUnit}
          editable={editable}
          onChanged={refresh}
        />
      ) : tab === 'adjustment' ? (
        // AG-4 읽기 전용 — editable을 받지 않는다
        <AdjustmentView key={v.id} projectId={data.projectId} view={selected} currencyUnit={data.currencyUnit} />
      ) : tab === 'participants' ? (
        <ParticipantsView
          key={v.id}
          projectId={data.projectId}
          view={selected}
          members={data.members}
          years={data.years}
          currencyUnit={data.currencyUnit}
          editable={editable}
          highlightParticipantId={highlightParticipantId}
          onChanged={refresh}
        />
      ) : tab === 'items' ? (
        <ItemsView
          key={v.id}
          projectId={data.projectId}
          version={v}
          view={selected.items.view}
          table={selected.items.table}
          items={selected.items.rows}
          years={data.years}
          currencyUnit={data.currencyUnit}
          editable={editable}
          highlightItemId={highlightItemId}
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

      {/* §7.9.8 수행 모드 규칙 검증 — 보기 탭 아래 공통 영역(어느 탭에서도 보인다). 인쇄에도 함께 나간다.
          규칙·판정은 화면과 같은 조회(data)의 것이다 — 보고 있는 버전의 ruleResult, 과제 규칙 행 data.rules */}
      <section aria-label="수행 모드 규칙 검증" className="space-y-2 border-t border-grey-200 pt-4">
        <div className="flex items-center gap-1.5">
          <h3 className="text-t6 font-semibold text-grey-900 print:text-black">규칙 검증</h3>
          <HelpLink slug="agreement" anchor="수행 모드 규칙 검증" />
        </div>
        <RuleFindingsPanel
          columns={data.years.map((y) => ({ yearId: y.id, name: y.name }))}
          rules={data.rules}
          evaluation={selected.ruleResult.evaluation}
          highlightedYearId={highlightYearId}
          onSelectYear={handleSelectYear}
          onSelectParticipant={handleSelectParticipant}
          onSelectItem={handleSelectItem}
          onOpenRules={onOpenRules}
          targetLabel={selected.ruleResult.targetLabel}
          notices={[TOTALS_SOURCE_NOTICE, ...selected.ruleResult.notes.map((note) => note.message)]}
          preservation={selected.preservationStatus}
        />
      </section>
    </div>
  );
}
