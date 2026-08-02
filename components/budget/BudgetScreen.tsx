'use client';

// 연구비 화면 컨테이너 (SOT §7.9)
// 데이터는 전부 서버(page.tsx)가 조회해 내려준다. 비율·합계·잔액을 여기서 다시 계산하지 않는다 —
// 규칙이 두 곳에 생기면 반드시 어긋난다(§6.4는 lib/budget.ts 한 곳이 원본, O-4).
// 이 컴포넌트가 소유하는 것: 선택된 셀, 진행 중(busy), 실패 배너, STALE 충돌 다이얼로그(O-3),
// 저장 성공 후 router.refresh() 한 번.
// 쓰기는 전부 actions/budget.ts를 거친다. supabase를 직접 부르지 않는다 (§8.2 C-2).

import { useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import type { ActionResult, BudgetItem } from '@/types';
import type { ActionErrorCode } from '@/lib/db/errors';
import type { BudgetMatrixData } from '@/actions/budget';
import { updateBudgetPlan } from '@/actions/budget';
import { BUDGET_CATEGORY_LABELS } from '@/lib/constants';
import Button from '@/components/ui/Button';
import ErrorBanner from '@/components/ui/ErrorBanner';
import ConflictDialog from '@/components/ui/ConflictDialog';
import BudgetMatrixTable, { type CellRef, cellKey } from './BudgetMatrix';
import BudgetDetailPanel, { type BudgetActionCallbacks } from './BudgetDetailPanel';

export interface BudgetScreenProps {
  data: BudgetMatrixData;
  /** 매트릭스 집계에는 없는 원본 행 — 집행 CRUD의 부모 id, version(O-1), 현금/현물 null 여부 */
  items: BudgetItem[];
}

export default function BudgetScreen({ data, items }: BudgetScreenProps) {
  const router = useRouter();
  const [selected, setSelected] = useState<CellRef | null>(null);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<{ message: string; code?: ActionErrorCode } | null>(null);
  const [conflict, setConflict] = useState<string | null>(null);
  const [importNotice, setImportNotice] = useState(false);

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
      {/* 툴바 (§7.9) */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-xs text-slate-500">
          표시 단위 <span className="font-semibold text-slate-700">{data.currencyUnit}</span>
          <span className="ml-2">· 입력은 언제나 원 단위 정수입니다 (B-4)</span>
        </p>
        <Button
          size="sm"
          aria-disabled
          title="Phase 5.5에서 구현됩니다"
          onClick={() => setImportNotice(true)}
          className="cursor-not-allowed opacity-50"
        >
          엑셀 가져오기
        </Button>
      </div>

      {importNotice && (
        <p
          role="status"
          className="flex items-center gap-2 rounded-lg bg-slate-100 px-3 py-1.5 text-xs text-slate-600"
        >
          엑셀 가져오기 마법사(§7.9.1)는 Phase 5.5에서 구현됩니다.
          <button
            type="button"
            onClick={() => setImportNotice(false)}
            aria-label="안내 닫기"
            className="ml-auto font-bold text-slate-400 hover:text-slate-600"
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
        />
      )}

      {/* 매트릭스에 실리지 못한 예산이 있으면 조용히 넘기지 않는다 (절대 규칙 5) */}
      {data.matrix.unmatchedItemCount > 0 && (
        <ErrorBanner
          message={`이 과제의 연차 목록에 없는 비목 ${data.matrix.unmatchedItemCount}건이 있어 매트릭스에 표시되지 않았습니다. 연차가 삭제되었거나 데이터가 어긋난 상태입니다.`}
          code="RULE"
        />
      )}

      {data.matrix.columns.length === 0 ? (
        <p className="rounded-xl border border-dashed border-slate-300 bg-white p-6 text-center text-sm text-slate-400">
          연차가 없습니다. 과제 개요에서 단계·연차를 먼저 만드세요.
        </p>
      ) : (
        <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_24rem]">
          <BudgetMatrixTable
            matrix={data.matrix}
            currencyUnit={data.currencyUnit}
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
            <aside className="h-fit rounded-xl border border-dashed border-slate-300 bg-white p-6 text-sm text-slate-400">
              셀을 클릭하면 집행 내역과 현금·현물 편집 패널이 열립니다.
            </aside>
          )}
        </div>
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
