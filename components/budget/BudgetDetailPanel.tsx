'use client';

// 셀 상세 패널 — 집행 내역 + 현금/현물 분리 편집 (SOT §7.9, §5.12, §6.4, §8.4 O-1·O-3)
//
//  - 요약(예산·집행·집행률·잔액)은 서버가 계산한 셀 값을 그대로 쓴다. 여기서 다시 나누지 않는다.
//  - 현금·현물이 하나라도 입력되면 총액은 두 값의 합이라 읽기 전용이 된다. 화면이 차액을
//    임의로 배분하지 않는다 — 서버도 배분하지 않고 VALIDATION으로 거부한다 (§5.12).
//  - 예산 저장·집행 편집은 여러 필드를 한 번에 바꾸므로 낙관적 잠금을 건다 (O-1).
//    STALE이면 부모가 ConflictDialog를 띄우고, 이 패널의 입력값은 그대로 남는다 (O-3).
//  - R-4: 패널이 열려 있는 동안 자동 새로고침을 보류한다.
// 쓰기는 전부 actions/budget.ts를 거친다 (§8.2 C-2).

import { useEffect, useState } from 'react';
import type { ActionResult, BudgetExecution, BudgetItem, Settings } from '@/types';
import type { ActionErrorCode } from '@/lib/db/errors';
import type { BudgetMatrixCell } from '@/lib/budget';
import {
  addExecution,
  deleteExecution,
  updateBudgetPlan,
  updateExecution,
} from '@/actions/budget';
import { formatAmount } from '@/lib/currency';
import { formatRate } from '@/lib/goals';
import Badge from '@/components/ui/Badge';
import Button from '@/components/ui/Button';
import Modal from '@/components/ui/Modal';
import { setRealtimePaused } from '@/components/RealtimeRefresher';

/** 저장 성공·실패를 부모(BudgetScreen)가 한 곳에서 다루기 위한 공통 계약 */
export interface BudgetActionCallbacks {
  busy: boolean;
  onBusyChange: (busy: boolean) => void;
  onError: (message: string, code?: ActionErrorCode) => void;
  /** O-3: STALE은 배너가 아니라 선택 다이얼로그로. 입력값은 이 패널이 그대로 들고 있는다 */
  onConflict: (message: string) => void;
  onDone: () => void;
}

export interface BudgetDetailPanelProps extends BudgetActionCallbacks {
  /** 서버가 계산한 셀 요약 (§6.4) */
  cell: BudgetMatrixCell;
  yearName: string;
  categoryLabel: string;
  /** 이 (연차, 비목)의 원본 행. 유일 제약(§5.12)상 1개다 */
  items: BudgetItem[];
  currencyUnit: Settings['currencyUnit'];
  onClose: () => void;
}

type ParsedAmount = { ok: true; value: number | null } | { ok: false };

// B-4: 금액은 원 단위 정수다. 빈 문자열은 "미입력"(null)이고 0원과 구분한다.
function parseAmount(draft: string): ParsedAmount {
  const trimmed = draft.trim();
  if (trimmed === '') return { ok: true, value: null };
  const value = Number(trimmed);
  if (!Number.isInteger(value) || value < 0) return { ok: false };
  return { ok: true, value };
}

function toDraft(amount: number | null): string {
  return amount === null ? '' : String(amount);
}

const inputClass =
  'mt-1 w-full rounded-lg border border-slate-300 px-2.5 py-1.5 text-sm tabular-nums focus:border-slate-500 focus:outline-none';

export default function BudgetDetailPanel({
  cell,
  yearName,
  categoryLabel,
  items,
  currencyUnit,
  busy,
  onBusyChange,
  onError,
  onConflict,
  onDone,
  onClose,
}: BudgetDetailPanelProps) {
  const item = items[0] ?? null;
  const duplicated = items.length > 1;

  const [cashDraft, setCashDraft] = useState(() => toDraft(item?.cashAmount ?? null));
  const [inKindDraft, setInKindDraft] = useState(() => toDraft(item?.inKindAmount ?? null));
  const [totalDraft, setTotalDraft] = useState(() => String(item?.plannedAmount ?? 0));

  // 집행 추가 폼
  const [newDate, setNewDate] = useState('');
  const [newAmount, setNewAmount] = useState('');
  const [newDescription, setNewDescription] = useState('');

  // 집행 편집(행 단위)
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editDate, setEditDate] = useState('');
  const [editAmount, setEditAmount] = useState('');
  const [editDescription, setEditDescription] = useState('');

  const [deleting, setDeleting] = useState<BudgetExecution | null>(null);

  // O-3: 마지막으로 받아들인 서버 version. 저장에 쓰는 expectedVersion도 여기서만 나온다.
  const [baselineVersion, setBaselineVersion] = useState<number | null>(item?.version ?? null);
  const [reloaded, setReloaded] = useState(false);

  // R-4: 패널이 열려 있는 동안 자동 새로고침을 보류해 입력 중인 내용을 지킨다
  useEffect(() => {
    setRealtimePaused(true);
    return () => setRealtimePaused(false);
  }, []);

  // 다시 불러오기(또는 남의 저장) 후 최신 행이 내려오면 비교 기준만 갱신한다.
  // 입력값(draft)은 건드리지 않는다 (O-3) — 새 version이 다음 저장의 expectedVersion이 된다.
  const itemVersion = item?.version ?? null;
  useEffect(() => {
    if (itemVersion === null || itemVersion === baselineVersion) return;
    setBaselineVersion(itemVersion);
    setReloaded(true);
  }, [itemVersion, baselineVersion]);

  async function run<T>(
    action: () => Promise<ActionResult<T>>,
    onSuccess?: () => void
  ): Promise<void> {
    onBusyChange(true);
    try {
      const res = await action();
      if (!res.ok) {
        // O-3: STALE은 배너가 아니라 선택 다이얼로그로 — 입력을 유지한 채 사용자가 고른다
        if (res.code === 'STALE') onConflict(res.error);
        else onError(res.error, res.code);
        return;
      }
      onSuccess?.();
      onDone();
    } finally {
      onBusyChange(false);
    }
  }

  const cash = parseAmount(cashDraft);
  const inKind = parseAmount(inKindDraft);
  // 현금·현물 중 하나라도 값이 있으면 "분리 입력" 모드다. 총액은 합계라 읽기 전용이 된다.
  const splitMode = cashDraft.trim() !== '' || inKindDraft.trim() !== '';
  // 사용자가 방금 입력한 두 값을 더한 것이다 — 서버 집계를 다시 계산하는 것이 아니다.
  // 정수 덧셈만 한다 (B-4).
  const splitTotal =
    cash.ok && inKind.ok ? (cash.value ?? 0) + (inKind.value ?? 0) : null;

  const handlePlanSave = (): void => {
    if (!item) return;
    const expectedVersion = baselineVersion ?? item.version;

    if (splitMode) {
      if (!cash.ok || !inKind.ok || splitTotal === null) {
        onError('현금·현물은 0 이상 정수(원)로 입력하세요.', 'VALIDATION');
        return;
      }
      // 총액은 합계로만 저장한다. 차액을 여기서 배분하지 않는다 (§5.12)
      void run(
        () =>
          updateBudgetPlan(
            item.yearId,
            item.category,
            splitTotal,
            cash.value,
            inKind.value,
            expectedVersion
          ),
        () => setReloaded(false)
      );
      return;
    }

    const total = parseAmount(totalDraft);
    if (!total.ok || total.value === null) {
      onError('총액을 0 이상 정수(원)로 입력하세요.', 'VALIDATION');
      return;
    }
    // 현금·현물이 모두 비었으므로 "분리 미입력"(null)을 유지한다
    void run(
      () =>
        updateBudgetPlan(item.yearId, item.category, total.value, null, null, expectedVersion),
      () => setReloaded(false)
    );
  };

  const handleAddExecution = (e: React.FormEvent): void => {
    e.preventDefault();
    if (!item) return;
    if (newDate === '') {
      onError('집행일을 입력하세요.', 'VALIDATION');
      return;
    }
    const amount = parseAmount(newAmount);
    if (!amount.ok || amount.value === null) {
      onError('집행액을 0 이상 정수(원)로 입력하세요.', 'VALIDATION');
      return;
    }
    void run(
      () =>
        addExecution(item.id, {
          date: newDate,
          amount: amount.value,
          description: newDescription.trim(),
        }),
      () => {
        setNewDate('');
        setNewAmount('');
        setNewDescription('');
      }
    );
  };

  const startEdit = (execution: BudgetExecution): void => {
    setEditingId(execution.id);
    setEditDate(execution.date);
    setEditAmount(String(execution.amount));
    setEditDescription(execution.description);
  };

  const handleEditSave = (execution: BudgetExecution): void => {
    if (!item) return;
    if (editDate === '') {
      onError('집행일을 입력하세요.', 'VALIDATION');
      return;
    }
    const amount = parseAmount(editAmount);
    if (!amount.ok || amount.value === null) {
      onError('집행액을 0 이상 정수(원)로 입력하세요.', 'VALIDATION');
      return;
    }
    // O-1: 일자·금액·적요를 한 번에 바꾸므로 마지막으로 읽은 version을 조건으로 건다 (§5.12)
    void run(
      () =>
        updateExecution(
          item.id,
          execution.id,
          { date: editDate, amount: amount.value, description: editDescription.trim() },
          execution.version
        ),
      () => setEditingId(null)
    );
  };

  return (
    <aside
      aria-label={`${yearName} ${categoryLabel} 집행 내역`}
      // P-R4: 집행 등록·편집 패널은 화면 조작용이다. 인쇄물에는 매트릭스만 남는다
      className="h-fit space-y-4 rounded-xl border border-slate-200 bg-white p-4 print:hidden"
    >
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="text-sm font-bold text-slate-900">{categoryLabel}</p>
          <p className="text-xs text-slate-500">{yearName}</p>
        </div>
        <button
          type="button"
          onClick={onClose}
          aria-label="패널 닫기"
          className="text-xl leading-none text-slate-400 hover:text-slate-600"
        >
          ×
        </button>
      </div>

      {/* 요약 — 서버가 준 값만 표시한다 (§6.4) */}
      <dl className="grid grid-cols-2 gap-2 rounded-lg bg-slate-50 p-3 text-xs">
        <div>
          <dt className="text-slate-500">예산</dt>
          <dd className="font-semibold tabular-nums text-slate-800">
            {formatAmount(cell.planned, currencyUnit)}
          </dd>
        </div>
        <div>
          <dt className="text-slate-500">집행</dt>
          <dd className="font-semibold tabular-nums text-slate-800">
            {formatAmount(cell.executed, currencyUnit)}
          </dd>
        </div>
        <div>
          <dt className="text-slate-500">집행률</dt>
          <dd
            className={`font-semibold tabular-nums ${cell.over ? 'text-red-600' : 'text-slate-800'}`}
          >
            {formatRate(cell.rate)}
          </dd>
        </div>
        <div>
          <dt className="text-slate-500">잔액</dt>
          <dd
            className={`font-semibold tabular-nums ${
              cell.remaining < 0 ? 'text-red-600' : 'text-slate-800'
            }`}
          >
            {formatAmount(cell.remaining, currencyUnit)}
          </dd>
        </div>
      </dl>

      <div className="flex flex-wrap gap-1.5">
        {cell.offBudget && (
          <Badge tone="amber" title="계획액이 0인데 집행액이 있습니다 (B-1)">
            ⚠ 예산 외 집행
          </Badge>
        )}
        {cell.over && (
          <Badge tone="red" title="집행률이 100%를 넘었습니다 (B-2)">
            집행률 100% 초과
          </Badge>
        )}
      </div>

      {duplicated && (
        <p className="rounded-lg bg-red-50 p-3 text-xs text-red-700">
          이 연차·비목에 예산 행이 {items.length}개 있습니다. 유일해야 하는 조합이므로 데이터가
          어긋난 상태입니다 — 첫 번째 행만 편집합니다. 관리자에게 알리세요.
        </p>
      )}

      {item === null ? (
        <p className="rounded-lg bg-amber-50 p-3 text-xs text-amber-800">
          이 연차·비목의 예산 행이 없습니다. 연차 생성 시 자동으로 만들어지는 행이므로 데이터가
          어긋난 상태입니다. 예산·집행을 등록하려면 관리자에게 알리세요.
        </p>
      ) : (
        <>
          {reloaded && (
            <div className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-xs text-amber-800">
              <p className="font-semibold">최신 값을 다시 불러왔습니다.</p>
              <p className="mt-1">
                입력하신 값은 그대로 두었습니다. 서버 값으로 되돌리려면 아래 버튼을 누르세요.
              </p>
              <button
                type="button"
                onClick={() => {
                  setCashDraft(toDraft(item.cashAmount));
                  setInKindDraft(toDraft(item.inKindAmount));
                  setTotalDraft(String(item.plannedAmount));
                  setReloaded(false);
                }}
                className="mt-2 rounded-md border border-amber-300 px-2 py-0.5 font-semibold"
              >
                최신 값 사용
              </button>
            </div>
          )}

          {/* 예산 편집 — 현금/현물 분리 (§7.9, §5.12) */}
          <section aria-label="예산 편집" className="space-y-2">
            <p className="text-xs font-semibold text-slate-700">예산 (원 단위 정수)</p>
            <div className="grid grid-cols-2 gap-2">
              <label className="text-xs text-slate-600">
                현금(원)
                <input
                  type="number"
                  inputMode="numeric"
                  min={0}
                  step={1}
                  value={cashDraft}
                  disabled={busy}
                  placeholder="미입력"
                  onChange={(e) => setCashDraft(e.target.value)}
                  className={inputClass}
                />
              </label>
              <label className="text-xs text-slate-600">
                현물(원)
                <input
                  type="number"
                  inputMode="numeric"
                  min={0}
                  step={1}
                  value={inKindDraft}
                  disabled={busy}
                  placeholder="미입력"
                  onChange={(e) => setInKindDraft(e.target.value)}
                  className={inputClass}
                />
              </label>
            </div>

            <label className="block text-xs text-slate-600">
              총액(원)
              <input
                type="number"
                inputMode="numeric"
                min={0}
                step={1}
                value={splitMode ? (splitTotal === null ? '' : String(splitTotal)) : totalDraft}
                readOnly={splitMode}
                disabled={busy}
                onChange={(e) => setTotalDraft(e.target.value)}
                aria-describedby="plan-total-hint"
                className={`${inputClass} ${splitMode ? 'bg-slate-100 text-slate-500' : ''}`}
              />
            </label>
            <p id="plan-total-hint" className="text-[11px] text-slate-500">
              {splitMode
                ? '현금·현물이 입력되어 총액은 두 값의 합으로 자동 계산됩니다. 총액만 바꾸려면 현금·현물을 모두 비우세요.'
                : '현금·현물이 비어 있어 총액을 직접 입력합니다. 현금·현물을 채우면 총액은 합계로 바뀝니다.'}
            </p>

            <div className="flex justify-end">
              <Button size="sm" variant="primary" disabled={busy} onClick={handlePlanSave}>
                {busy ? '저장 중…' : '예산 저장'}
              </Button>
            </div>
          </section>

          {/* 집행 내역 (§7.9: 일자, 금액, 적요 + 추가/수정/삭제) */}
          <section aria-label="집행 내역" className="space-y-2">
            <p className="text-xs font-semibold text-slate-700">
              집행 내역
              <span className="ml-2 font-normal text-slate-500">{item.executions.length}건</span>
            </p>

            {item.executions.length === 0 ? (
              <p className="text-xs text-slate-400">등록된 집행 내역이 없습니다.</p>
            ) : (
              <table className="w-full text-left text-xs">
                <thead className="text-slate-500">
                  <tr className="border-b border-slate-200">
                    <th className="py-1 pr-2 font-medium">일자</th>
                    <th className="py-1 pr-2 text-right font-medium">금액</th>
                    <th className="py-1 pr-2 font-medium">적요</th>
                    <th className="py-1 text-right font-medium">동작</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {item.executions.map((execution) =>
                    editingId === execution.id ? (
                      <tr key={execution.id} className="align-top">
                        <td className="py-1.5 pr-2">
                          <input
                            type="date"
                            value={editDate}
                            disabled={busy}
                            onChange={(e) => setEditDate(e.target.value)}
                            aria-label="집행일"
                            className={inputClass}
                          />
                        </td>
                        <td className="py-1.5 pr-2">
                          <input
                            type="number"
                            inputMode="numeric"
                            min={0}
                            step={1}
                            value={editAmount}
                            disabled={busy}
                            onChange={(e) => setEditAmount(e.target.value)}
                            aria-label="집행액(원)"
                            className={`${inputClass} text-right`}
                          />
                        </td>
                        <td className="py-1.5 pr-2">
                          <input
                            type="text"
                            maxLength={200}
                            value={editDescription}
                            disabled={busy}
                            onChange={(e) => setEditDescription(e.target.value)}
                            aria-label="적요"
                            className={inputClass}
                          />
                        </td>
                        <td className="py-1.5 text-right">
                          <div className="flex flex-wrap justify-end gap-1">
                            <Button
                              size="sm"
                              variant="primary"
                              disabled={busy}
                              onClick={() => handleEditSave(execution)}
                            >
                              저장
                            </Button>
                            <Button size="sm" disabled={busy} onClick={() => setEditingId(null)}>
                              취소
                            </Button>
                          </div>
                        </td>
                      </tr>
                    ) : (
                      <tr key={execution.id} className="align-top">
                        <td className="py-1.5 pr-2 tabular-nums text-slate-600">
                          {execution.date}
                        </td>
                        <td className="py-1.5 pr-2 text-right tabular-nums text-slate-800">
                          {formatAmount(execution.amount, currencyUnit)}
                        </td>
                        <td className="py-1.5 pr-2 text-slate-600">
                          {execution.description === '' ? '—' : execution.description}
                        </td>
                        <td className="py-1.5 text-right">
                          <div className="flex flex-wrap justify-end gap-1">
                            <Button size="sm" disabled={busy} onClick={() => startEdit(execution)}>
                              수정
                            </Button>
                            <Button
                              size="sm"
                              variant="danger"
                              disabled={busy}
                              onClick={() => setDeleting(execution)}
                            >
                              삭제
                            </Button>
                          </div>
                        </td>
                      </tr>
                    )
                  )}
                </tbody>
              </table>
            )}

            <form onSubmit={handleAddExecution} className="space-y-2 rounded-lg bg-slate-50 p-3">
              <p className="text-xs font-semibold text-slate-700">집행 추가</p>
              <div className="grid grid-cols-2 gap-2">
                <label className="text-xs text-slate-600">
                  집행일
                  <input
                    type="date"
                    value={newDate}
                    disabled={busy}
                    required
                    onChange={(e) => setNewDate(e.target.value)}
                    className={inputClass}
                  />
                </label>
                <label className="text-xs text-slate-600">
                  집행액(원)
                  <input
                    type="number"
                    inputMode="numeric"
                    min={0}
                    step={1}
                    value={newAmount}
                    disabled={busy}
                    required
                    onChange={(e) => setNewAmount(e.target.value)}
                    className={`${inputClass} text-right`}
                  />
                </label>
              </div>
              <label className="block text-xs text-slate-600">
                적요
                <input
                  type="text"
                  maxLength={200}
                  value={newDescription}
                  disabled={busy}
                  placeholder="예: 시약 구매"
                  onChange={(e) => setNewDescription(e.target.value)}
                  className={inputClass}
                />
              </label>
              <div className="flex justify-end">
                <Button type="submit" size="sm" variant="primary" disabled={busy}>
                  {busy ? '저장 중…' : '집행 추가'}
                </Button>
              </div>
            </form>
          </section>
        </>
      )}

      {deleting && item && (
        <Modal
          open
          title="집행 내역을 삭제합니다"
          onClose={() => setDeleting(null)}
          closeOnBackdrop={false}
          footer={
            <>
              <Button size="sm" disabled={busy} onClick={() => setDeleting(null)}>
                취소
              </Button>
              <Button
                size="sm"
                variant="danger"
                disabled={busy}
                onClick={() =>
                  void run(() => deleteExecution(item.id, deleting.id), () => setDeleting(null))
                }
              >
                {busy ? '삭제 중…' : '삭제'}
              </Button>
            </>
          }
        >
          <p className="text-sm text-slate-700">
            {deleting.date} · <strong>{formatAmount(deleting.amount, currencyUnit)}</strong>
            {deleting.description === '' ? '' : ` · ${deleting.description}`}
          </p>
          <p className="mt-3 rounded-lg bg-amber-50 p-3 text-sm text-amber-800">
            삭제하면 이 비목의 집행액과 집행률이 줄어듭니다.
          </p>
        </Modal>
      )}
    </aside>
  );
}
