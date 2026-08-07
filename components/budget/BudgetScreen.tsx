'use client';

// 연구비 화면 컨테이너 (SOT §7.9, §7.9.2)
// 데이터는 전부 서버(page.tsx)가 조회해 내려준다. 비율·합계·잔액을 여기서 다시 계산하지 않는다 —
// 규칙이 두 곳에 생기면 반드시 어긋난다(§6.4는 lib/budget.ts 한 곳이 원본, O-4).
// 이 컴포넌트가 소유하는 것: 선택된 셀, 진행 중(busy), 실패 배너, STALE 충돌 다이얼로그(O-3),
// 저장 성공 후 router.refresh() 한 번.
// 쓰기는 전부 actions/budget.ts를 거친다. supabase를 직접 부르지 않는다 (§8.2 C-2).
//
// **모드 토글 `[제안 | 수행]`** (§7.9): 같은 매트릭스를 두 관점으로 본다. 기본은 `수행`이고,
// 모드는 **화면 로컬 상태**다 — URL을 바꾸지도 저장하지도 않으므로 새로고침하면 `수행`으로
// 돌아간다(§7.9.2, §7.5 접힘 상태와 같은 결정). 탭(TabNav)을 늘리지 않는 이유는 두 모드가
// **같은 숫자**를 다루기 때문이다: 화면을 나누면 같은 값이 두 곳에 나타난다.
// 인쇄(§12 P-R1)도 현재 모드를 따른다 — 모드가 DOM을 정하고 인쇄는 그 DOM을 그대로 뽑는다.

import { useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import type { ActionResult, BudgetItem, ImportProfile } from '@/types';
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
import ImportWizard from './import/ImportWizard';

// §7.9 표의 순서대로 `[제안 | 수행]`. 기본 선택은 `수행`이다
const MODES: readonly { value: BudgetMode; label: string; hint: string }[] = [
  { value: 'plan', label: '제안', hint: '셀에 예산 / 현금 / 현물을 보여주고, 클릭하면 산출근거 패널이 열립니다 (§7.9.2)' },
  { value: 'execution', label: '수행', hint: '셀에 예산 / 집행 / 집행률을 보여주고, 클릭하면 집행 내역 패널이 열립니다' },
];

export interface BudgetScreenProps {
  data: BudgetMatrixData;
  /** 매트릭스 집계에는 없는 원본 행 — 집행 CRUD의 부모 id, version(O-1), 현금/현물 null 여부 */
  items: BudgetItem[];
  /** §7.9.1 Step 1 — 이 과제에서 쓸 수 있는 엑셀 매핑 프로파일 (전역 + 과제 소속) */
  importProfiles: ImportProfile[];
  /** 프로파일 조회 실패 문구. 빈 목록으로 눙치지 않는다 (절대 규칙 5) */
  importProfilesError: string | null;
  /** 제안 모드 한 벌 (§6.10). 조회에 실패하면 null이고 planError가 이유를 말한다 */
  plan: BudgetPlanData | null;
  /** 절대 규칙 5: 실패를 빈 제안 데이터로 대체하지 않는다 — 0원짜리 계획으로 보이면 안 된다 */
  planError: { message: string; code?: ActionErrorCode } | null;
}

export default function BudgetScreen({
  data,
  items,
  importProfiles,
  importProfilesError,
  plan,
  planError,
}: BudgetScreenProps) {
  const router = useRouter();
  // §7.9.2: 화면 로컬 상태. 기본은 `수행`이고 새로고침하면 되돌아온다
  const [mode, setMode] = useState<BudgetMode>('execution');
  const [selected, setSelected] = useState<CellRef | null>(null);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<{ message: string; code?: ActionErrorCode } | null>(null);
  const [conflict, setConflict] = useState<string | null>(null);
  const [importOpen, setImportOpen] = useState(false);
  const [importResult, setImportResult] = useState<string | null>(null);

  // (연차, 비목) → 원본 행. 유일 제약(§5.12)상 1개지만 2개 이상이면 감추지 않고 드러낸다
  const itemsByCell = useMemo(() => {
    const map = new Map<string, BudgetItem[]>();
    for (const item of items) {
      const key = cellKey(item.yearId, item.category);
      const bucket = map.get(key);
      if (bucket) bucket.push(item);
      else map.set(key, [item]);
    }
    return map;
  }, [items]);

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

  const selectedColumn =
    selected === null ? null : data.matrix.columns.find((c) => c.yearId === selected.yearId) ?? null;
  const selectedCell =
    selected === null
      ? null
      : data.matrix.rows
          .find((row) => row.category === selected.category)
          ?.cells.find((c) => c.yearId === selected.yearId) ?? null;
  const selectedItems = selected === null ? [] : itemsByCell.get(cellKey(selected.yearId, selected.category)) ?? [];

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
                    setSelected(null);
                    setFailure(null);
                  }}
                  className={`rounded-lg px-3 py-1.5 text-sm font-semibold transition disabled:opacity-50 ${
                    active
                      ? 'bg-slate-900 text-white'
                      : 'border border-slate-300 bg-white text-slate-700 hover:bg-slate-50'
                  }`}
                >
                  {item.label}
                </button>
              );
            })}
          </div>
          <p className="text-xs text-slate-500">
            표시 단위 <span className="font-semibold text-slate-700">{data.currencyUnit}</span>
            <span className="ml-2">· 입력은 언제나 원 단위 정수입니다 (B-4)</span>
          </p>
        </div>
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

      {/* 반영 결과 토스트 (§7.9.1 Step 5) */}
      {importResult && (
        <p
          role="status"
          className="flex items-center gap-2 rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-xs text-emerald-800 print:hidden"
        >
          {importResult}
          <button
            type="button"
            onClick={() => setImportResult(null)}
            aria-label="알림 닫기"
            className="ml-auto font-bold text-emerald-500 hover:text-emerald-700"
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

      {/* 매트릭스에 실리지 못한 예산이 있으면 조용히 넘기지 않는다 (절대 규칙 5) */}
      {data.matrix.unmatchedItemCount > 0 && (
        <ErrorBanner
          message={`이 과제의 연차 목록에 없는 비목 ${data.matrix.unmatchedItemCount}건이 있어 매트릭스에 표시되지 않았습니다. 연차가 삭제되었거나 데이터가 어긋난 상태입니다.`}
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

      {data.matrix.columns.length === 0 ? (
        <p className="rounded-xl border border-dashed border-slate-300 bg-white p-6 text-center text-sm text-slate-400">
          연차가 없습니다. 과제 개요에서 단계·연차를 먼저 만드세요.
        </p>
      ) : mode === 'execution' ? (
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
            onSelect={setSelected}
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
              onClose={() => setSelected(null)}
              {...callbacks}
            />
          ) : (
            <aside className="h-fit rounded-xl border border-dashed border-slate-300 bg-white p-6 text-sm text-slate-400 print:hidden">
              셀을 클릭하면 집행 내역과 현금·현물 편집 패널이 열립니다.
            </aside>
          )}
        </div>
      ) : plan === null ? (
        // planError 배너가 이미 이유를 말했다. 여기서 표를 그리면 "계획이 비었다"는 거짓말이 된다
        <p className="rounded-xl border border-dashed border-slate-300 bg-white p-6 text-center text-sm text-slate-400 print:hidden">
          제안 모드 데이터를 불러오지 못해 매트릭스를 표시하지 않습니다. 수행 모드로 돌아가면 예산·집행은
          그대로 볼 수 있습니다.
        </p>
      ) : (
        // 제안 모드는 **1열**이다. 산출근거 패널의 행 표는 최소 52rem이라 24rem 사이드바에 넣으면
        // 가로 스크롤이 상시 생기고, 매트릭스도 연차 수만큼 넓어져 둘 다 좁아진다.
        // 산출근거 편집은 셀 하나에 집중하는 작업이라 매트릭스와 나란히 볼 필요가 낮아
        // 매트릭스 → 지침 검증 줄 → 패널(전폭) 순으로 세로로 쌓는다.
        <div className="space-y-6">
          <BudgetMatrixTable
            mode="plan"
            planCells={planCells}
            matrix={data.matrix}
            currencyUnit={data.currencyUnit}
            projectName={data.projectName}
            todayISO={data.todayISO}
            yearBudgetChecks={data.yearBudgetChecks}
            itemsByCell={itemsByCell}
            selected={selected}
            busy={busy}
            onSelect={setSelected}
            onInlineSave={handleInlineSave}
          />

          {/* 하단 요약 (§7.9): 연차별 합계 · 현금/현물 비중 · 지침 검증 배지. 매트릭스 바로
              아래에 고정해 패널이 열려도 표와 떨어지지 않게 한다. 인쇄에도 함께 나간다 (§7.9.2) */}
          <BudgetPlanSummary
            columns={data.matrix.columns}
            yearRules={plan.yearRules}
            yearAxisSplits={plan.yearAxisSplits}
            currencyUnit={data.currencyUnit}
            projectId={data.projectId}
            negativeCount={plan.negativeCount}
            missingSalaryCount={plan.missingSalaryCount}
            mismatchCount={plan.mismatchCount}
          />

          <div ref={planPanelRef}>
            {selected && selectedColumn ? (
              <BudgetPlanPanel
                // 셀이 바뀌면 패널을 새로 시작한다 (다른 셀의 입력이 섞이지 않게)
                key={cellKey(selected.yearId, selected.category)}
                projectId={data.projectId}
                yearId={selected.yearId}
                category={selected.category}
                yearName={selectedColumn.name}
                categoryLabel={BUDGET_CATEGORY_LABELS[selected.category]}
                currencyUnit={data.currencyUnit}
                // 패널은 실패 배너·ConflictDialog·R-4 보류를 스스로 다룬다 (plan-panel-contract.ts).
                // 부모가 알아야 하는 것은 "합계가 바뀌었다"와 "닫아 달라" 둘뿐이다
                onSaved={() => {
                  setFailure(null);
                  router.refresh();
                }}
                onBusyChange={setBusy}
                onClose={() => setSelected(null)}
              />
            ) : (
              <p className="rounded-xl border border-dashed border-slate-300 bg-white p-6 text-center text-sm text-slate-400 print:hidden">
                셀을 클릭하면 이 자리에 산출근거 패널이 열립니다. 산출근거가 있는 셀은 계획액이 내역
                합계로 확정되어 표에서 직접 고칠 수 없습니다 (PL-9).
              </p>
            )}
          </div>
        </div>
      )}

      {/* 모달을 닫으면 진행 상태는 폐기한다 — 언마운트로 상태를 버린다 (§7.9.1 설계 원칙) */}
      {importOpen && (
        <ImportWizard
          projectId={data.projectId}
          years={data.years}
          currencyUnit={data.currencyUnit}
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
