'use client';

// 연구비 화면 컨테이너 (SOT §7.9, §7.9.2)
// 데이터는 전부 서버(page.tsx)가 조회해 내려준다. 비율·합계·잔액을 여기서 다시 계산하지 않는다 —
// 규칙이 두 곳에 생기면 반드시 어긋난다(§6.4는 lib/budget.ts 한 곳이 원본, O-4).
// 이 컴포넌트가 소유하는 것: 선택된 셀, 진행 중(busy), 실패 배너, STALE 충돌 다이얼로그(O-3),
// 저장 성공 후 router.refresh() 한 번, 그리고 §7.9 규칙 검증 패널의 "클릭 → 이동" 상태
// (강조 중인 연차 열 · 강조할 산출 행).
// 쓰기는 전부 actions/budget.ts를 거친다. supabase를 직접 부르지 않는다 (§8.2 C-2).
//
// **모드 토글 `[제안 | 수행]`** (§7.9): 같은 매트릭스를 두 관점으로 본다. 기본은 `수행`이고,
// 모드는 **화면 로컬 상태**다 — URL을 바꾸지도 저장하지도 않으므로 새로고침하면 `수행`으로
// 돌아간다(§7.9.2, §7.5 접힘 상태와 같은 결정). 탭(TabNav)을 늘리지 않는 이유는 두 모드가
// **같은 숫자**를 다루기 때문이다: 화면을 나누면 같은 값이 두 곳에 나타난다.
// 인쇄(§12 P-R1)도 현재 모드를 따른다 — 모드가 DOM을 정하고 인쇄는 그 DOM을 그대로 뽑는다.
//
// **보기 토글 `[매트릭스 | 인건비]`** (§7.9.6, Phase 16): 제안 모드 안의 두 번째 축이다. `인건비`는 같은 산출근거를
// 사람 중심(조직원 × 월급 × 참여율 × 개월)으로 보는 표라 매트릭스·산출근거 패널·규칙 패널 **대신** 그린다.
// 모드와 같은 화면 로컬 상태이고, 수행 모드에는 없다(모드를 바꾸면 `매트릭스`로 돌아온다). 인쇄는 현재 보기.
//
// **한 화면은 한 스냅샷만 본다** (C5). page.tsx는 getBudgetMatrix(수행)와 getBudgetPlanData(제안)를
// Promise.all로 함께 내리지만 **두 조회는 트랜잭션이 아니다.** 그 사이에 누가 저장하면 두 결과는
// 서로 다른 시점을 본다 — 섞어 쓰면 한 표가 옛 금액에 새 잠금을 거는 식이 된다.
// 그래서 소스는 아래 `source` 한 곳에서만 고른다: **수행 = `data`, 제안 = `plan`.**
// 표·셀·합계·잠금·인쇄 머리말이 전부 그 한 벌에서 나온다.

import { useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import type { ActionResult, BudgetCategory, BudgetItem, ImportProfile, RuleCode } from '@/types';
import type { ActionErrorCode } from '@/lib/db/errors';
import type { BudgetMatrixData } from '@/actions/budget';
import type { BudgetPlanCellView, BudgetPlanData } from '@/actions/budget-plan';
import { updateBudgetPlan } from '@/actions/budget';
import { BUDGET_CATEGORY_LABELS } from '@/lib/constants';
import Button from '@/components/ui/Button';
import ErrorBanner from '@/components/ui/ErrorBanner';
import ConflictDialog from '@/components/ui/ConflictDialog';
import BudgetMatrixTable, { type BudgetMode, type CellRef, cellKey } from './BudgetMatrix';
import BudgetDetailPanel, { type BudgetActionCallbacks } from './BudgetDetailPanel';
import BudgetPlanPanel from './BudgetPlanPanel';
import BudgetPlanSummary from './BudgetPlanSummary';
import RuleFindingsPanel from './rules/RuleFindingsPanel';
import RulesEditor from './rules/RulesEditor';
import ImportWizard from './import/ImportWizard';
import DetailImportWizard from './import/detail/DetailImportWizard';
import ExportModal from './ExportModal';
import PersonnelTab from './personnel/PersonnelTab';

// §7.9.6 제안 모드의 보기. `matrix`가 기본이고 `personnel`은 [인건비] 탭이다
type PlanView = 'matrix' | 'personnel';

const PLAN_VIEWS: readonly { value: PlanView; label: string; hint: string }[] = [
  { value: 'matrix', label: '매트릭스', hint: '비목 × 연차 매트릭스와 산출근거 패널 (§7.9)' },
  { value: 'personnel', label: '인건비', hint: '인건비·학생인건비 산출근거를 조직원 × 월급 × 참여율 × 참여개월로 봅니다 (§7.9.6)' },
];

// §7.9 표의 순서대로 `[제안 | 수행]`. 기본 선택은 `수행`이다
const MODES: readonly { value: BudgetMode; label: string; hint: string }[] = [
  { value: 'plan', label: '제안', hint: '셀에 예산 / 현금 / 현물을 보여주고, 클릭하면 산출근거 패널이 열립니다 (§7.9.2)' },
  { value: 'execution', label: '수행', hint: '셀에 예산 / 집행 / 집행률을 보여주고, 클릭하면 집행 내역 패널이 열립니다' },
];

// 원본 행(집행 CRUD의 부모 id·version(O-1)·현금/현물 null 여부·PL-9 detailCount)은 props로 따로
// 받지 않는다. `data.items`·`plan.items`가 각자의 집계와 **같은 조회**에서 나온 배열이라,
// 따로 받으면 호출부가 다른 시점의 두 스냅샷을 짝지어 넘길 수 있다 — 타입으로 그 가능성을 없앤다.
export interface BudgetScreenProps {
  /** 수행 모드 한 벌 (getBudgetMatrix). 수행 모드가 보는 유일한 스냅샷이다 */
  data: BudgetMatrixData;
  /** §7.9.1 Step 1 — 이 과제에서 쓸 수 있는 엑셀 매핑 프로파일 (전역 + 과제 소속) */
  importProfiles: ImportProfile[];
  /** 프로파일 조회 실패 문구. 빈 목록으로 눙치지 않는다 (절대 규칙 5) */
  importProfilesError: string | null;
  /**
   * 제안 모드 한 벌 (§6.10, getBudgetPlanData). 제안 모드가 보는 유일한 스냅샷이다 —
   * 표·셀·잠금·합계·인쇄 머리말이 전부 여기서 나온다 (파일 머리말 C5).
   * 조회에 실패하면 null이고 planError가 이유를 말한다
   */
  plan: BudgetPlanData | null;
  /** 절대 규칙 5: 실패를 빈 제안 데이터로 대체하지 않는다 — 0원짜리 계획으로 보이면 안 된다 */
  planError: { message: string; code?: ActionErrorCode } | null;
}

export default function BudgetScreen({
  data,
  importProfiles,
  importProfilesError,
  plan,
  planError,
}: BudgetScreenProps) {
  const router = useRouter();
  // §7.9.2: 화면 로컬 상태. 기본은 `수행`이고 새로고침하면 되돌아온다
  const [mode, setMode] = useState<BudgetMode>('execution');
  // §7.9.6: 제안 모드의 보기. 모드처럼 화면 로컬 상태다 — 모드를 바꾸면 `매트릭스`로 되돌린다
  const [planView, setPlanView] = useState<PlanView>('matrix');
  const [selected, setSelected] = useState<CellRef | null>(null);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<{ message: string; code?: ActionErrorCode } | null>(null);
  const [conflict, setConflict] = useState<string | null>(null);
  const [importOpen, setImportOpen] = useState(false);
  const [detailImportOpen, setDetailImportOpen] = useState(false);
  const [exportOpen, setExportOpen] = useState(false);
  // §7.9.5 [연구비 규칙] 모달. 제안 모드의 것이라 모드를 바꾸면 닫는다
  const [rulesOpen, setRulesOpen] = useState(false);
  const [importResult, setImportResult] = useState<string | null>(null);
  // §7.9 규칙 검증 패널의 "클릭 → 이동". 연차 finding은 매트릭스 열 강조, 행 finding은 셀 패널 + 행 강조.
  // 둘 다 화면 로컬 상태다 — URL·DB에 남기지 않고 모드를 바꾸면 버린다 (모드 토글과 같은 결정)
  const [highlightYearId, setHighlightYearId] = useState<string | null>(null);
  const [highlightDetailId, setHighlightDetailId] = useState<string | null>(null);

  // 이 화면이 보는 유일한 스냅샷. 여기서 한 번 고르고 아래에서는 섞지 않는다 (파일 머리말 C5).
  // 제안 조회가 실패하면(plan === null) 매트릭스를 아예 그리지 않으므로(아래 분기) 섞일 표가
  // 없다 — 그때 남는 툴바·마법사만 수행 스냅샷을 쓴다.
  const source: BudgetMatrixData | BudgetPlanData = mode === 'plan' && plan !== null ? plan : data;

  // (연차, 비목) → 원본 행. 유일 제약(§5.12)상 1개지만 2개 이상이면 감추지 않고 드러낸다.
  // 매트릭스의 셀 잠금(PL-9 산출근거 · S-4 현금/현물 분리)이 이 map으로 갈리므로, 표를 그린
  // 스냅샷의 items여야 한다 — 다른 조회의 items를 쓰면 옛 금액에 새 잠금이 걸린다
  const itemsByCell = useMemo(() => {
    const map = new Map<string, BudgetItem[]>();
    for (const item of source.items) {
      const key = cellKey(item.yearId, item.category);
      const bucket = map.get(key);
      if (bucket) bucket.push(item);
      else map.set(key, [item]);
    }
    return map;
  }, [source.items]);

  // (연차, 비목) → 제안 모드 셀 뷰. 서버가 연차 × 12비목 전 조합을 내려주므로 폴백 분기가 없다
  const planCells = useMemo(() => {
    const map = new Map<string, BudgetPlanCellView>();
    for (const cell of plan?.cells ?? []) map.set(cellKey(cell.yearId, cell.category), cell);
    return map;
  }, [plan]);

  // 산출근거 패널은 매트릭스 아래 전폭으로 열린다(아래 배치 근거 참고). 접힌 화면에서는 화면
  // 밖에서 열려 "클릭이 먹지 않았다"로 보이므로 열릴 때 한 번 끌어온다
  const planPanelRef = useRef<HTMLDivElement | null>(null);
  const planPanelKey = mode === 'plan' && selected ? cellKey(selected.yearId, selected.category) : null;
  useEffect(() => {
    if (planPanelKey === null) return;
    planPanelRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }, [planPanelKey]);

  const callbacks: BudgetActionCallbacks = {
    busy,
    onBusyChange: setBusy,
    // 절대 규칙 5: 실패는 반드시 화면에 남긴다
    onError: (message, code) => setFailure({ message, code }),
    onConflict: setConflict,
    onDone: () => {
      setFailure(null);
      router.refresh();
    },
  };

  async function run<T>(action: () => Promise<ActionResult<T>>): Promise<void> {
    setBusy(true);
    setFailure(null);
    try {
      const res = await action();
      if (!res.ok) {
        if (res.code === 'STALE') setConflict(res.error);
        else setFailure({ message: res.error, code: res.code });
        return;
      }
      callbacks.onDone();
    } finally {
      setBusy(false);
    }
  }

  // 총액 인라인 편집 (§7.9). O-2: 사용자가 직접 바꾼 필드가 1개이므로 낙관적 잠금을 생략한다.
  // 현금/현물이 모두 비어 있는 셀에서만 열리므로 여기서 분리값을 임의로 배분할 일이 없다 —
  // null을 그대로 넘겨 "분리 미입력" 상태를 유지한다.
  const handleInlineSave = (cell: CellRef, plannedAmount: number): void => {
    void run(() => updateBudgetPlan(cell.yearId, cell.category, plannedAmount, null, null));
  };

  // 선택된 셀도 표를 그린 스냅샷에서 찾는다 — 표와 패널이 다른 시점의 같은 셀을 가리키지 않게
  const selectedColumn =
    selected === null
      ? null
      : source.matrix.columns.find((c) => c.yearId === selected.yearId) ?? null;
  const selectedCell =
    selected === null
      ? null
      : source.matrix.rows
          .find((row) => row.category === selected.category)
          ?.cells.find((c) => c.yearId === selected.yearId) ?? null;
  const selectedItems = selected === null ? [] : itemsByCell.get(cellKey(selected.yearId, selected.category)) ?? [];

  // 사용자가 직접 고른 셀에는 규칙 검증의 행 강조가 따라가면 안 된다 — 다른 셀의 행 id가 남아
  // "찾지 못했습니다" 안내가 엉뚱한 셀에 뜬다
  const selectCell = (cell: CellRef | null): void => {
    setSelected(cell);
    setHighlightDetailId(null);
  };

  // 연차 finding 클릭: 같은 연차를 다시 누르면 해제 (토글)
  const handleSelectYear = (yearId: string): void => {
    setHighlightYearId((prev) => (prev === yearId ? null : yearId));
  };

  // 행 finding 클릭: 셀 좌표는 판정기가 scope에 실어 준 (연차, 비목)이다(§6.14.6) — 여기서 코드로 비목을
  // 추측하지 않는다. 패널이 그 행을 찾지 못하면(그 사이 삭제 등) 패널 안에서 알린다 (plan-panel-contract.ts)
  const handleSelectDetail = (target: { code: RuleCode; yearId: string; detailId: string; category: BudgetCategory }): void => {
    setSelected({ yearId: target.yearId, category: target.category });
    setHighlightDetailId(target.detailId);
    setHighlightYearId(target.yearId);
  };

  return (
    <div className="space-y-4">
      {/* 툴바 (§7.9). P-R4: 인쇄에서는 [엑셀 가져오기]와 입력 안내를 뺀다 —
          표시 단위는 매트릭스의 인쇄 머리말이 대신 알린다 */}
      <div className="flex flex-wrap items-center justify-between gap-3 print:hidden">
        <div className="flex flex-wrap items-center gap-3">
          {/* §7.9 모드 토글. 탭이 아니라 같은 표의 관점 전환이라 TabNav를 늘리지 않는다 */}
          <div className="inline-flex items-center gap-1" role="tablist" aria-label="연구비 모드">
            {MODES.map((item) => {
              const active = item.value === mode;
              return (
                <button
                  key={item.value}
                  type="button"
                  role="tab"
                  aria-selected={active}
                  title={item.hint}
                  // 저장이 도는 동안 모드를 바꾸면 패널이 언마운트되며 진행 중인 편집이 사라진다
                  disabled={busy}
                  onClick={() => {
                    if (active) return;
                    setMode(item.value);
                    // 두 모드의 패널은 서로 다른 것을 편집한다 — 선택을 넘기지 않는다
                    selectCell(null);
                    setHighlightYearId(null);
                    setRulesOpen(false);
                    setPlanView('matrix');
                    setFailure(null);
                  }}
                  className={`rounded-lg px-3 py-1.5 text-sm font-semibold transition disabled:opacity-50 ${
                    active
                      ? 'bg-grey-900 text-white'
                      : 'border border-grey-300 bg-white text-grey-700 hover:bg-grey-50'
                  }`}
                >
                  {item.label}
                </button>
              );
            })}
          </div>
          {/* §7.9.6 보기 토글 — 제안 모드에서만. 제안 스냅샷이 없으면 인건비 탭도 그릴 연차가 없다 */}
          {mode === 'plan' && plan !== null && (
            <div className="inline-flex items-center gap-1" role="tablist" aria-label="제안 모드 보기">
              {PLAN_VIEWS.map((item) => {
                const active = item.value === planView;
                return (
                  <button
                    key={item.value}
                    type="button"
                    role="tab"
                    aria-selected={active}
                    title={item.hint}
                    // 저장이 도는 동안 보기를 바꾸면 패널이 언마운트되며 진행 중인 편집이 사라진다
                    disabled={busy}
                    onClick={() => {
                      if (active) return;
                      setPlanView(item.value);
                      // 산출근거 패널·규칙 강조는 매트릭스 보기의 것이다 — 인건비 보기로 넘기지 않는다
                      selectCell(null);
                      setHighlightYearId(null);
                      setRulesOpen(false);
                      setFailure(null);
                    }}
                    className={`rounded-lg px-3 py-1.5 text-sm font-semibold transition disabled:opacity-50 ${
                      active
                        ? 'bg-blue-500 text-white'
                        : 'border border-grey-300 bg-white text-grey-700 hover:bg-grey-50'
                    }`}
                  >
                    {item.label}
                  </button>
                );
              })}
            </div>
          )}
          <p className="text-xs text-grey-500">
            표시 단위 <span className="font-semibold text-grey-700">{source.currencyUnit}</span>
            <span className="ml-2">· 입력은 언제나 원 단위 정수입니다 (B-4)</span>
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {/* §7.9.3: [산출근거 가져오기]는 **제안 모드 툴바에만** 둔다 — 수행 모드에는 노출하지
              않는다. 매트릭스·패널과 같은 `mode` 하나가 이 노출을 정하므로 조건이 갈릴 수 없다 */}
          {mode === 'plan' && (
            <Button
              size="sm"
              variant="secondary"
              disabled={busy}
              title="산출근거 시트(행 내역)를 4단계 마법사로 가져옵니다 (§7.9.3). 총괄표는 [엑셀 가져오기]입니다"
              onClick={() => setDetailImportOpen(true)}
            >
              산출근거 가져오기
            </Button>
          )}
          {/* §7.9.5: [연구비 규칙]도 **제안 모드에만** 둔다 — 계상 규칙은 제안의 것이다(수행 모드에는 없다).
              편집할 규칙은 제안 스냅샷(plan.rules)이라 plan이 없으면 열 수 없다 */}
          {mode === 'plan' && (
            <Button
              size="sm"
              variant="secondary"
              disabled={busy || plan === null}
              title={
                plan === null
                  ? '제안 모드 데이터를 불러오지 못해 규칙을 편집할 수 없습니다'
                  : '이 과제의 연구비 사용 규칙(프리셋·한도·안내)을 편집합니다 (§7.9.5)'
              }
              onClick={() => setRulesOpen(true)}
            >
              연구비 규칙
            </Button>
          )}
          {/* §7.9.4: [제출 서식 내보내기]도 **제안 모드에만** 둔다 — 제안의 산출물이다.
              §7.9.3과 같은 `mode` 하나가 두 버튼의 노출을 함께 정한다 */}
          {mode === 'plan' && (
            <Button
              size="sm"
              variant="secondary"
              disabled={busy}
              title="고른 연차의 산출근거 + 총괄표를 제출 서식(xlsx)으로 내려받습니다 (§7.9.4). 앱 데이터는 바뀌지 않습니다"
              onClick={() => setExportOpen(true)}
            >
              제출 서식 내보내기
            </Button>
          )}
          <Button
            size="sm"
            variant="primary"
            disabled={busy}
            title="예산계획 엑셀을 5단계 마법사로 가져옵니다 (§7.9.1)"
            onClick={() => setImportOpen(true)}
          >
            엑셀 가져오기
          </Button>
        </div>
      </div>

      {/* 반영 결과 토스트 (§7.9.1 Step 5) */}
      {importResult && (
        <p
          role="status"
          className="flex items-center gap-2 rounded-lg border border-green-200 bg-green-50 px-3 py-2 text-xs text-green-800 print:hidden"
        >
          {importResult}
          <button
            type="button"
            onClick={() => setImportResult(null)}
            aria-label="알림 닫기"
            className="ml-auto font-bold text-green-500 hover:text-green-700"
          >
            ×
          </button>
        </p>
      )}

      {failure && (
        <ErrorBanner
          message={failure.message}
          code={failure.code}
          onDismiss={() => setFailure(null)}
          className="print:hidden"
        />
      )}

      {/* 매트릭스에 실리지 못한 예산이 있으면 조용히 넘기지 않는다 (절대 규칙 5).
          지금 그리는 표의 스냅샷을 세야 한다 — 다른 조회의 수를 적으면 표에 없는 건수가 나온다 */}
      {source.matrix.unmatchedItemCount > 0 && (
        <ErrorBanner
          message={`이 과제의 연차 목록에 없는 비목 ${source.matrix.unmatchedItemCount}건이 있어 매트릭스에 표시되지 않았습니다. 연차가 삭제되었거나 데이터가 어긋난 상태입니다.`}
          code="RULE"
        />
      )}

      {/* 제안 데이터 조회 실패. 빈 매트릭스로 대체하면 0원짜리 계획처럼 보인다 (절대 규칙 5) */}
      {mode === 'plan' && planError && (
        <ErrorBanner
          message={planError.message}
          code={planError.code}
          onRetry={() => router.refresh()}
        />
      )}

      {source.matrix.columns.length === 0 ? (
        <p className="rounded-xl border border-dashed border-grey-300 bg-white p-6 text-center text-sm text-grey-400">
          연차가 없습니다. 과제 개요에서 단계·연차를 먼저 만드세요.
        </p>
      ) : mode === 'execution' ? (
        // 수행 모드는 data(getBudgetMatrix) 한 벌만 본다 — 이 분기의 source가 곧 data다.
        // 인쇄에서는 집행 패널이 빠지므로 2열 격자를 풀어 매트릭스가 A4 폭을 다 쓰게 한다
        <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_24rem] print:block">
          <BudgetMatrixTable
            mode="execution"
            matrix={data.matrix}
            currencyUnit={data.currencyUnit}
            projectName={data.projectName}
            todayISO={data.todayISO}
            yearBudgetChecks={data.yearBudgetChecks}
            itemsByCell={itemsByCell}
            selected={selected}
            busy={busy}
            onSelect={selectCell}
            onInlineSave={handleInlineSave}
          />

          {selected && selectedCell && selectedColumn ? (
            <BudgetDetailPanel
              // 셀이 바뀌면 폼 상태를 새로 시작한다 (다른 셀의 입력이 섞이지 않게)
              key={cellKey(selected.yearId, selected.category)}
              cell={selectedCell}
              yearName={selectedColumn.name}
              categoryLabel={BUDGET_CATEGORY_LABELS[selected.category]}
              items={selectedItems}
              currencyUnit={data.currencyUnit}
              onClose={() => selectCell(null)}
              {...callbacks}
            />
          ) : (
            <aside className="h-fit rounded-xl border border-dashed border-grey-300 bg-white p-6 text-sm text-grey-400 print:hidden">
              셀을 클릭하면 집행 내역과 현금·현물 편집 패널이 열립니다.
            </aside>
          )}
        </div>
      ) : plan === null ? (
        // planError 배너가 이미 이유를 말했다. 제안 모드에는 그릴 스냅샷이 없으므로 표를 감춘다.
        // 빈 매트릭스로 대체하면 "계획이 비었다"는 거짓말이 되고(절대 규칙 5), 수행 스냅샷으로
        // 대신 그리면 금액과 잠금이 서로 다른 시점을 보게 된다 — C5가 고친 결함 그 자체다
        <p className="rounded-xl border border-dashed border-grey-300 bg-white p-6 text-center text-sm text-grey-400 print:hidden">
          제안 모드 데이터를 불러오지 못해 매트릭스를 표시하지 않습니다. 수행 모드로 돌아가면 예산·집행은
          그대로 볼 수 있습니다.
        </p>
      ) : planView === 'personnel' ? (
        // §7.9.6 [인건비] 탭 — 매트릭스·하단 요약·규칙 패널·산출근거 패널 **대신** 그린다. 탭은 자기 조회
        // (getPersonnelTabData)를 스스로 받고, 저장 뒤 onSaved → router.refresh()로 plan 스냅샷도 다시 받는다.
        // 연차 목록만 제안 스냅샷(plan.years)에서 준다 — 셀렉트가 매트릭스 열과 같은 연차를 보여야 한다
        <PersonnelTab
          projectId={plan.projectId}
          years={plan.years.map((y) => ({ id: y.id, name: y.name }))}
          onSaved={() => {
            setFailure(null);
            router.refresh();
          }}
          onBusyChange={setBusy}
        />
      ) : (
        // 제안 모드는 **1열**이다. 산출근거 패널의 행 표는 최소 52rem이라 24rem 사이드바에 넣으면
        // 가로 스크롤이 상시 생기고, 매트릭스도 연차 수만큼 넓어져 둘 다 좁아진다.
        // 산출근거 편집은 셀 하나에 집중하는 작업이라 매트릭스와 나란히 볼 필요가 낮아
        // 매트릭스 → 지침 검증 줄 → 패널(전폭) 순으로 세로로 쌓는다.
        //
        // 이 분기의 값은 **전부 plan(getBudgetPlanData) 한 벌**에서 온다 — 표·셀 요약·잠금·합계·
        // 인쇄 머리말까지. data(수행 스냅샷)를 여기서 읽지 않는다 (파일 머리말 C5).
        // itemsByCell도 위에서 source(= plan)의 items로 만든 것이다
        <div className="space-y-6">
          <BudgetMatrixTable
            mode="plan"
            planCells={planCells}
            matrix={plan.matrix}
            currencyUnit={plan.currencyUnit}
            projectName={plan.projectName}
            todayISO={plan.todayISO}
            yearBudgetChecks={plan.yearBudgetChecks}
            itemsByCell={itemsByCell}
            selected={selected}
            highlightedYearId={highlightYearId}
            busy={busy}
            onSelect={selectCell}
            onInlineSave={handleInlineSave}
          />

          {/* 하단 요약 (§7.9): 연차별 합계 · 현금/현물 비중 · 지침 검증 값. 매트릭스 바로
              아래에 고정해 패널이 열려도 표와 떨어지지 않게 한다. 인쇄에도 함께 나간다 (§7.9.2) */}
          <BudgetPlanSummary
            columns={plan.matrix.columns}
            yearRules={plan.yearRules}
            yearAxisSplits={plan.yearAxisSplits}
            currencyUnit={plan.currencyUnit}
            projectId={plan.projectId}
            negativeCount={plan.negativeCount}
            missingSalaryCount={plan.missingSalaryCount}
            mismatchCount={plan.mismatchCount}
          />

          {/* §7.9 규칙 검증 패널 (Phase 13, §6.14) — 제안 모드 하단에만 있다. 수행 모드 분기에는 없다.
              규칙·판정은 표를 그린 plan 스냅샷의 것이다 (C5). 0건 안내의 [연구비 규칙]은 툴바 버튼과 같은
              모달(§7.9.5)을 연다 */}
          <RuleFindingsPanel
            columns={plan.matrix.columns}
            rules={plan.rules}
            evaluation={plan.ruleEvaluation}
            highlightedYearId={highlightYearId}
            onSelectYear={handleSelectYear}
            onSelectDetail={handleSelectDetail}
            onOpenRules={() => setRulesOpen(true)}
          />

          <div ref={planPanelRef}>
            {selected && selectedColumn ? (
              <BudgetPlanPanel
                // 셀이 바뀌면 패널을 새로 시작한다 (다른 셀의 입력이 섞이지 않게)
                key={cellKey(selected.yearId, selected.category)}
                projectId={plan.projectId}
                yearId={selected.yearId}
                category={selected.category}
                yearName={selectedColumn.name}
                categoryLabel={BUDGET_CATEGORY_LABELS[selected.category]}
                currencyUnit={plan.currencyUnit}
                highlightDetailId={highlightDetailId}
                // 패널은 실패 배너·ConflictDialog·R-4 보류를 스스로 다룬다 (plan-panel-contract.ts).
                // 부모가 알아야 하는 것은 "합계가 바뀌었다"와 "닫아 달라" 둘뿐이다
                onSaved={() => {
                  setFailure(null);
                  router.refresh();
                }}
                onBusyChange={setBusy}
                onClose={() => selectCell(null)}
              />
            ) : (
              <p className="rounded-xl border border-dashed border-grey-300 bg-white p-6 text-center text-sm text-grey-400 print:hidden">
                셀을 클릭하면 이 자리에 산출근거 패널이 열립니다. 산출근거가 있는 셀은 계획액이 내역
                합계로 확정되어 표에서 직접 고칠 수 없습니다 (PL-9).
              </p>
            )}
          </div>
        </div>
      )}

      {/* 모달을 닫으면 진행 상태는 폐기한다 — 언마운트로 상태를 버린다 (§7.9.1 설계 원칙).
          연차·표시 단위도 지금 보고 있는 스냅샷의 것을 쓴다 — 마법사의 연차 열 대응이 화면의
          매트릭스 열과 같아야 반영 결과를 그 자리에서 확인할 수 있다 */}
      {importOpen && (
        <ImportWizard
          projectId={source.projectId}
          years={source.years}
          currencyUnit={source.currencyUnit}
          profiles={importProfiles}
          profilesError={importProfilesError}
          onClose={() => setImportOpen(false)}
          onCommitted={(message) => {
            setImportOpen(false);
            setImportResult(message);
            router.refresh();
          }}
        />
      )}

      {/* §7.9.3도 같다 — 모달을 닫으면 진행 상태는 언마운트로 폐기된다 */}
      {detailImportOpen && (
        <DetailImportWizard years={source.years} onClose={() => setDetailImportOpen(false)} />
      )}

      {/* §7.9.4도 같다 — 모달을 닫으면 선택·미리보기는 언마운트로 폐기된다.
          연차·표시 단위는 지금 보고 있는 스냅샷의 것을 쓴다 (마법사와 같은 이유) */}
      {exportOpen && (
        <ExportModal
          projectId={source.projectId}
          years={source.years}
          currencyUnit={source.currencyUnit}
          onClose={() => setExportOpen(false)}
        />
      )}

      {/* §7.9.5 규칙 편집 모달. 항상 마운트하고 open으로 여닫는다 — 열릴 때 plan.rules를 받아들이고, 저장·적용·
          삭제 뒤 onChanged → router.refresh()로 검증 패널과 이 모달의 행이 같은 조회를 보게 한다.
          제안 스냅샷이 없으면(plan === null) 편집할 행도 없으므로 그리지 않는다 */}
      {plan !== null && (
        <RulesEditor
          projectId={plan.projectId}
          rules={plan.rules}
          open={mode === 'plan' && planView === 'matrix' && rulesOpen}
          onClose={() => setRulesOpen(false)}
          onChanged={() => {
            setFailure(null);
            router.refresh();
          }}
        />
      )}

      {conflict && (
        <ConflictDialog
          message={conflict}
          // 최신 값을 다시 가져오면 패널이 새 version을 받아 다음 저장의 기준으로 삼는다.
          // 입력값은 패널이 그대로 들고 있다 (O-3)
          onReload={() => {
            setConflict(null);
            router.refresh();
          }}
          onKeepEditing={() => setConflict(null)}
        />
      )}
    </div>
  );
}
