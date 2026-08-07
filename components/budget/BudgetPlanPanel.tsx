'use client';

// 산출근거 패널 — 제안 모드에서 셀을 클릭하면 열린다 (SOT §7.9.2, §5.17, §6.10, 부록 A.5)
//
// 이 패널이 소유하는 것: 행 목록 조회·행 CRUD·세목 안 정렬·실패 배너·STALE 다이얼로그(O-3).
// 부모(BudgetScreen)에게는 "합계가 바뀌었다"(onSaved)만 알린다 — 계약은 plan-panel-contract.ts.
//
//  - **금액을 여기서 계산하지 않는다.** 행 금액·세목 소계·셀 합계는 전부 서버가
//    lib/budget-plan.ts로 계산해 내려준 값이다 (PL-D7·PL-10a·O-4). 같은 규칙이 두 곳에
//    생기면 반드시 어긋나고, 금액에서 1원 차이는 합계 검증을 통과하지 못한다.
//  - **세목 섹션은 부록 A.5 프리셋 순서대로** 나열한다. 행이 하나도 없는 세목은 접어 두고
//    `+ 행 추가`만 노출한다 — 실측 서식은 세목 11개 중 절반이 비어 있다.
//  - 정렬은 세목 경계를 넘지 않는다. 세목이 바뀌면 컬럼 구조가 바뀐다.
//  - R-4: 패널이 열려 있는 동안 자동 새로고침을 보류한다.
//  - 조회 실패는 배너로 드러낸다. 빈 목록으로 눙치지 않는다 (절대 규칙 5).
//
// 쓰기·조회는 전부 actions/budget-plan.ts를 거친다. supabase를 직접 부르지 않는다 (§8.2 C-2).

import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import type { ActionResult, BudgetDetail, Member } from '@/types';
import type { ActionErrorCode } from '@/lib/db/errors';
import type { BudgetDetailRowView, BudgetDetailsData } from '@/actions/budget-plan';
import {
  createBudgetDetail,
  deleteBudgetDetail,
  getBudgetDetails,
  reorderBudgetDetails,
  updateBudgetDetail,
} from '@/actions/budget-plan';
import type { SubcategoryTotal } from '@/lib/budget-plan';
import type { SubcategoryDef } from '@/lib/constants';
import { DETAIL_AXIS_LABELS, SUBCATEGORY_PRESETS } from '@/lib/constants';
import { reorderIds, type DropPosition } from '@/lib/board';
import { formatAmount } from '@/lib/currency';
import Badge from '@/components/ui/Badge';
import Button from '@/components/ui/Button';
import Modal from '@/components/ui/Modal';
import ErrorBanner from '@/components/ui/ErrorBanner';
import ConflictDialog from '@/components/ui/ConflictDialog';
import { setRealtimePaused } from '@/components/RealtimeRefresher';
import DetailRowEditor, { type DetailRowPatch } from './DetailRowEditor';
import type { BudgetPlanPanelProps } from './plan-panel-contract';

interface Failure {
  message: string;
  code?: ActionErrorCode;
}

interface DragState {
  id: string;
  /** 세목을 넘는 이동은 없다 (§7.9.2) — 드롭 대상이 이 세목일 때만 받는다 */
  subcategory: string;
}

const PERSONNEL_HEADERS: readonly string[] = ['인력', '직위', '연봉'];
const QUANTITY_HEADERS: readonly string[] = ['품명', '규격·산출내역', '단가', '인자'];
const TAIL_HEADERS: readonly string[] = ['축', '조정액', '금액', '비고', ''];

function headersFor(def: SubcategoryDef): string[] {
  if (def.formula !== 'personnel') return ['', ...QUANTITY_HEADERS, ...TAIL_HEADERS];
  // 참여율·참여기간 머리글은 프리셋 라벨을 쓴다. 행마다 다른 라벨은 행 안에서 보인다 (PL-3)
  const rate = def.defaultFactors.find((f) => f.isPercent)?.label ?? '참여율(%)';
  const months = def.defaultFactors.find((f) => !f.isPercent)?.label ?? '참여기간(월)';
  return ['', ...PERSONNEL_HEADERS, rate, months, ...TAIL_HEADERS];
}

/** 새 행의 기본 축. 축은 null이 될 수 없으므로(§5.17) 하나를 골라야 하고, 바꿀 칸이 행에 있다 */
const DEFAULT_AXIS = 'cash' as const;

export default function BudgetPlanPanel({
  projectId,
  yearId,
  category,
  yearName,
  categoryLabel,
  currencyUnit,
  onSaved,
  onBusyChange,
  onClose,
}: BudgetPlanPanelProps) {
  const [data, setData] = useState<BudgetDetailsData | null>(null);
  const [loading, setLoading] = useState(true);
  const [failure, setFailure] = useState<Failure | null>(null);
  const [conflict, setConflict] = useState<string | null>(null);
  const [busy, setBusyState] = useState(false);
  const [deleting, setDeleting] = useState<BudgetDetail | null>(null);
  const [drag, setDrag] = useState<DragState | null>(null);
  const [dropTarget, setDropTarget] = useState<{ id: string; position: DropPosition } | null>(null);
  // 드롭 직후 서버 응답을 기다리는 동안 행이 제자리에 남으면 조작이 먹히지 않은 것처럼 보인다.
  // 새 순서를 미리 반영하고 실패하면 지워 원위치로 되돌린다 (절대 규칙 5).
  const [pendingOrder, setPendingOrder] = useState<{ subcategory: string; ids: string[] } | null>(
    null
  );

  const setBusy = useCallback(
    (next: boolean) => {
      setBusyState(next);
      onBusyChange?.(next);
    },
    [onBusyChange]
  );

  // R-4: 패널이 열려 있는 동안 자동 새로고침을 보류해 입력 중인 내용을 지킨다
  useEffect(() => {
    setRealtimePaused(true);
    return () => setRealtimePaused(false);
  }, []);

  const load = useCallback(async (): Promise<void> => {
    setLoading(true);
    try {
      const res = await getBudgetDetails(yearId, category);
      if (!res.ok) {
        // 빈 목록으로 눙치지 않는다 — 부분 조회는 셀 합계를 조용히 작게 만든다 (절대 규칙 5)
        setFailure({ message: res.error, code: res.code });
        return;
      }
      setFailure(null);
      setData(res.data);
      setPendingOrder(null);
    } finally {
      setLoading(false);
    }
  }, [yearId, category]);

  useEffect(() => {
    void load();
  }, [load]);

  const run = useCallback(
    async <T,>(action: () => Promise<ActionResult<T>>, onOk?: () => void): Promise<void> => {
      setBusy(true);
      setFailure(null);
      try {
        const res = await action();
        if (!res.ok) {
          setPendingOrder(null); // 낙관적 순서를 되돌린다
          // O-3: STALE은 배너가 아니라 선택 다이얼로그로 — 입력값은 행이 그대로 들고 있는다
          if (res.code === 'STALE') setConflict(res.error);
          else setFailure({ message: res.error, code: res.code });
          return;
        }
        onOk?.();
        // 셀 합계가 바뀌었다 (PL-7·PL-10) — 매트릭스는 부모가 다시 그린다
        onSaved();
        await load();
      } finally {
        setBusy(false);
      }
    },
    [load, onSaved, setBusy]
  );

  const presets = SUBCATEGORY_PRESETS[category];

  // 세목 → 행. 리포지토리가 order로 정렬해 주므로 여기서는 낙관적 순서만 덧입힌다
  const rowsBySubcategory = useMemo(() => {
    const map = new Map<string, BudgetDetailRowView[]>();
    if (data === null) return map;
    for (const row of data.rows) {
      const bucket = map.get(row.detail.subcategory);
      if (bucket) bucket.push(row);
      else map.set(row.detail.subcategory, [row]);
    }
    if (pendingOrder !== null) {
      const bucket = map.get(pendingOrder.subcategory);
      if (bucket) {
        const rank = new Map(pendingOrder.ids.map((id, index) => [id, index]));
        map.set(
          pendingOrder.subcategory,
          [...bucket].sort(
            (a, b) =>
              (rank.get(a.detail.id) ?? a.detail.order) - (rank.get(b.detail.id) ?? b.detail.order)
          )
        );
      }
    }
    return map;
  }, [data, pendingOrder]);

  const subtotalByCode = useMemo(() => {
    const map = new Map<string, SubcategoryTotal>();
    for (const subtotal of data?.subcategories ?? []) map.set(subtotal.subcategory, subtotal);
    return map;
  }, [data]);

  // PL-D4 위반: 프리셋에 없는 세목이 저장돼 있다. 감추면 그 행의 금액이 어디에도 보이지 않는다
  const unknownCodes = useMemo(
    () => [...rowsBySubcategory.keys()].filter((code) => !presets.some((def) => def.code === code)),
    [rowsBySubcategory, presets]
  );

  const clearDrag = (): void => {
    setDrag(null);
    setDropTarget(null);
  };

  const handleAdd = (def: SubcategoryDef, memberId: string | null): void => {
    void run(() =>
      createBudgetDetail(yearId, category, def.code, {
        axis: DEFAULT_AXIS,
        formula: def.formula,
        memberId,
        name: '',
        unitPrice: 0,
        spec: '',
        // 프리셋 인자를 라벨만 채워 넣는다. 값 0은 "아직 입력하지 않았다"는 뜻이고, 100%·12개월
        // 같은 값을 미리 넣으면 사용자가 적은 적 없는 금액이 만들어진다
        factors: def.defaultFactors.map((factor) => ({
          label: factor.label,
          value: 0,
          isPercent: factor.isPercent,
        })),
        adjustment: 0,
        note: '',
      })
    );
  };

  const handleSaveRow = (detail: BudgetDetail, patch: DetailRowPatch, expectedVersion: number): void => {
    // O-1: 단가·인자·조정액을 한 번에 바꾸므로 마지막으로 읽은 version을 조건으로 건다
    void run(() => updateBudgetDetail(detail.id, patch, expectedVersion));
  };

  const handleDrop = (subcategory: string, targetId: string, position: DropPosition): void => {
    const moved = drag;
    clearDrag();
    // 세목이 다르면 무시한다 — 세목을 넘는 이동은 없다 (§7.9.2)
    if (moved === null || moved.subcategory !== subcategory || moved.id === targetId) return;

    const ids = (rowsBySubcategory.get(subcategory) ?? []).map((row) => row.detail.id);
    const next = reorderIds(ids, moved.id, targetId, position);
    if (next === null) {
      setFailure({
        message: '옮기려는 행이 더 이상 없습니다. 다시 불러온 뒤 시도하세요.',
      });
      return;
    }
    setPendingOrder({ subcategory, ids: next });
    // X-3: 그 세목의 **전체 id 배열**을 보낸다. 부분 배열은 RPC가 거부한다
    void run(() => reorderBudgetDetails(yearId, category, subcategory, next));
  };

  const total = data?.total ?? null;

  return (
    <aside
      aria-label={`${yearName} ${categoryLabel} 산출근거`}
      // §7.9.2 마지막 줄: 산출근거 자체의 인쇄는 Phase 9 범위 밖이다 (인쇄는 매트릭스만 나간다)
      className="h-fit space-y-4 rounded-xl border border-slate-200 bg-white p-4 print:hidden"
    >
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="text-sm font-bold text-slate-900">{categoryLabel} · 산출근거</p>
          <p className="text-xs text-slate-500">
            {yearName}
            <span className="ml-2">· 입력은 언제나 원 단위 정수입니다</span>
            <span className="ml-2">· 표시 단위 {currencyUnit}</span>
          </p>
        </div>
        <div className="flex items-center gap-2">
          {loading && <span className="text-xs text-slate-400">불러오는 중…</span>}
          <button
            type="button"
            onClick={onClose}
            aria-label="패널 닫기"
            className="text-xl leading-none text-slate-400 hover:text-slate-600"
          >
            ×
          </button>
        </div>
      </div>

      {failure && (
        <ErrorBanner
          message={failure.message}
          code={failure.code}
          onRetry={() => void load()}
          onDismiss={() => setFailure(null)}
        />
      )}

      {data === null ? (
        // 실패는 위 배너가 이미 말한다. 여기서 빈 표를 그리면 "행이 없다"는 거짓말이 된다
        !failure && (
          <p className="rounded-lg border border-dashed border-slate-300 p-6 text-center text-sm text-slate-400">
            산출근거를 불러오는 중입니다…
          </p>
        )
      ) : (
        <>
          {/* 셀 전체의 경고. 개별 행에도 같은 표시가 붙지만 접힌 세목 밖에서도 보여야 한다 */}
          {(data.negativeCount > 0 || data.missingSalaryCount > 0) && (
            <div className="flex flex-wrap gap-1.5">
              {data.negativeCount > 0 && (
                <Badge tone="red" title="조정액을 확인하세요 (PL-5). 저장은 막지 않습니다">
                  금액이 음수인 행 {data.negativeCount}건
                </Badge>
              )}
              {data.missingSalaryCount > 0 && (
                <Badge tone="amber" title="연봉이 비어 있는 인력의 인건비 행은 0원으로 계산됩니다">
                  연봉 미입력 {data.missingSalaryCount}건
                </Badge>
              )}
            </div>
          )}

          {unknownCodes.length > 0 && (
            <ErrorBanner
              code="RULE"
              message={`이 비목의 세목 프리셋(부록 A.5)에 없는 세목 ${unknownCodes.length}건이 저장돼 있습니다: ${unknownCodes.join(', ')}. 아래 맨 끝 섹션에서 확인·삭제할 수 있습니다.`}
            />
          )}

          <div className="space-y-3">
            {presets.map((def) => (
              <SubcategorySection
                key={def.code}
                def={def}
                rows={rowsBySubcategory.get(def.code) ?? []}
                subtotal={subtotalByCode.get(def.code) ?? null}
                members={data.members}
                projectId={projectId}
                currencyUnit={currencyUnit}
                busy={busy}
                drag={drag}
                dropTarget={dropTarget}
                onAdd={(memberId) => handleAdd(def, memberId)}
                onSaveRow={handleSaveRow}
                onDeleteRow={setDeleting}
                onDragStart={(id) => setDrag({ id, subcategory: def.code })}
                onDragEnd={clearDrag}
                onDragOverRow={(id, position) =>
                  setDropTarget((prev) =>
                    prev?.id === id && prev.position === position ? prev : { id, position }
                  )
                }
                onDropRow={(id, position) => handleDrop(def.code, id, position)}
              />
            ))}

            {unknownCodes.map((code) => {
              const rows = rowsBySubcategory.get(code) ?? [];
              const formula = rows[0]?.detail.formula ?? 'quantity';
              return (
                <SubcategorySection
                  key={code}
                  def={{ code, label: `(프리셋에 없는 세목: ${code})`, formula, defaultFactors: [] }}
                  rows={rows}
                  subtotal={subtotalByCode.get(code) ?? null}
                  members={data.members}
                  projectId={projectId}
                  currencyUnit={currencyUnit}
                  busy={busy}
                  drag={drag}
                  dropTarget={dropTarget}
                  // 프리셋에 없는 세목에 행을 더 만들 수는 없다 (PL-D4가 서버에서 거부한다)
                  onAdd={null}
                  onSaveRow={handleSaveRow}
                  onDeleteRow={setDeleting}
                  onDragStart={(id) => setDrag({ id, subcategory: code })}
                  onDragEnd={clearDrag}
                  onDragOverRow={(id, position) =>
                    setDropTarget((prev) =>
                      prev?.id === id && prev.position === position ? prev : { id, position }
                    )
                  }
                  onDropRow={(id, position) => handleDrop(code, id, position)}
                />
              );
            })}
          </div>

          {/* 셀 합계 — 이 값이 매트릭스 셀에 그대로 올라간다 (§7.9.2 하단, PL-7) */}
          {total && (
            <dl className="grid grid-cols-3 gap-2 rounded-lg bg-slate-50 p-3 text-xs">
              <div>
                <dt className="text-slate-500">{DETAIL_AXIS_LABELS.cash}</dt>
                <dd className="font-semibold tabular-nums text-slate-800">
                  {formatAmount(total.cashAmount, currencyUnit)}
                </dd>
              </div>
              <div>
                <dt className="text-slate-500">{DETAIL_AXIS_LABELS.in_kind}</dt>
                <dd className="font-semibold tabular-nums text-slate-800">
                  {formatAmount(total.inKindAmount, currencyUnit)}
                </dd>
              </div>
              <div>
                <dt className="text-slate-500">계</dt>
                <dd className="font-bold tabular-nums text-slate-900">
                  {formatAmount(total.plannedAmount, currencyUnit)}
                </dd>
              </div>
            </dl>
          )}
          <p className="text-[11px] text-slate-500">
            이 합계가 매트릭스의 (연차 × 비목) 셀 값이 됩니다. 행이 하나라도 있으면 셀은 잠기고
            직접 편집할 수 없습니다 (PL-9).
          </p>
        </>
      )}

      {deleting && (
        <Modal
          open
          title="산출근거 행을 삭제합니다"
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
                  void run(() => deleteBudgetDetail(deleting.id), () => setDeleting(null))
                }
              >
                {busy ? '삭제 중…' : '삭제'}
              </Button>
            </>
          }
        >
          <p className="text-sm text-slate-700">
            <strong>{formatAmount(deleting.amount, currencyUnit)}</strong>
            {deleting.name === '' ? '' : ` · ${deleting.name}`}
          </p>
          <p className="mt-3 rounded-lg bg-amber-50 p-3 text-sm text-amber-800">
            삭제하면 이 비목의 계획액이 그만큼 줄어듭니다. 되돌릴 수 없습니다 (PL-D6). 마지막 행을
            지우면 셀 잠금이 풀리고 직전 합계가 그대로 남습니다 (PL-9).
          </p>
        </Modal>
      )}

      {conflict && (
        <ConflictDialog
          message={conflict}
          // 부모의 router.refresh()는 이 패널이 client에서 받아 둔 목록에 닿지 않는다.
          // 최신 값을 여기서 다시 받고, 각 행은 새 version만 받아들인다 — 입력값은 그대로다 (O-3)
          onReload={() => {
            setConflict(null);
            void load();
          }}
          onKeepEditing={() => setConflict(null)}
        />
      )}
    </aside>
  );
}

// ─── 세목 섹션 (부록 A.5 프리셋 순서로 나열된다) ──────────────────────────────

interface SubcategorySectionProps {
  def: SubcategoryDef;
  rows: BudgetDetailRowView[];
  /** 서버가 계산한 세목 소계 (PL-6). 행이 없으면 null */
  subtotal: SubcategoryTotal | null;
  members: Member[];
  projectId: string;
  currencyUnit: BudgetPlanPanelProps['currencyUnit'];
  busy: boolean;
  drag: DragState | null;
  dropTarget: { id: string; position: DropPosition } | null;
  /** null이면 행을 추가할 수 없는 세목이다 (프리셋 밖) */
  onAdd: ((memberId: string | null) => void) | null;
  onSaveRow: (detail: BudgetDetail, patch: DetailRowPatch, expectedVersion: number) => void;
  onDeleteRow: (detail: BudgetDetail) => void;
  onDragStart: (id: string) => void;
  onDragEnd: () => void;
  onDragOverRow: (id: string, position: DropPosition) => void;
  onDropRow: (id: string, position: DropPosition) => void;
}

function SubcategorySection({
  def,
  rows,
  subtotal,
  members,
  projectId,
  currencyUnit,
  busy,
  drag,
  dropTarget,
  onAdd,
  onSaveRow,
  onDeleteRow,
  onDragStart,
  onDragEnd,
  onDragOverRow,
  onDropRow,
}: SubcategorySectionProps) {
  // 인건비 행은 memberId가 필수다 (PL-D1) — 누구의 인건비인지 고른 뒤에야 행이 생긴다
  const [newMemberId, setNewMemberId] = useState('');

  const headers = headersFor(def);
  const columnCount = headers.length;
  const empty = rows.length === 0;
  const isPersonnel = def.formula === 'personnel';
  // 세목을 넘는 이동은 없으므로 이 세목의 드래그일 때만 드롭을 받는다
  const dragInSection = drag !== null && rows.some((row) => row.detail.id === drag.id);

  return (
    <section
      aria-label={def.label}
      className={`rounded-lg border ${empty ? 'border-dashed border-slate-200' : 'border-slate-200'}`}
    >
      <header className="flex flex-wrap items-center justify-between gap-2 px-3 py-2">
        <p className="text-xs font-semibold text-slate-700">
          {def.label}
          {!empty && <span className="ml-2 font-normal text-slate-500">{rows.length}행</span>}
        </p>
        {subtotal && (
          <p className="text-xs tabular-nums text-slate-600">
            소계 {formatAmount(subtotal.plannedAmount, currencyUnit)}
            <span className="ml-2 text-slate-400">
              ({DETAIL_AXIS_LABELS.cash} {formatAmount(subtotal.cashAmount, currencyUnit)} ·{' '}
              {DETAIL_AXIS_LABELS.in_kind} {formatAmount(subtotal.inKindAmount, currencyUnit)})
            </span>
          </p>
        )}
      </header>

      {/* 행이 하나도 없는 세목은 접어 두고 `+ 행 추가`만 노출한다 (§7.9.2) */}
      {!empty && (
        <div className="overflow-x-auto px-3">
          <table className="w-full min-w-[52rem] text-left text-xs">
            <thead className="text-slate-500">
              <tr className="border-b border-slate-200">
                {headers.map((header, index) => (
                  <th
                    key={index}
                    className={`py-1 pr-2 font-medium ${
                      header === '금액' || header === '단가' || header === '조정액' || header === '연봉'
                        ? 'text-right'
                        : ''
                    }`}
                  >
                    {header}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {rows.map((row) => (
                <DetailRowEditor
                  key={row.detail.id}
                  detail={row.detail}
                  computed={row.computed}
                  members={members}
                  projectId={projectId}
                  currencyUnit={currencyUnit}
                  defaultFactors={def.defaultFactors}
                  columnCount={columnCount}
                  busy={busy}
                  dragEnabled={rows.length > 1 && !busy}
                  dragging={drag?.id === row.detail.id}
                  dropPosition={
                    dragInSection && dropTarget?.id === row.detail.id ? dropTarget.position : null
                  }
                  onSave={(patch, expectedVersion) => onSaveRow(row.detail, patch, expectedVersion)}
                  onDelete={() => onDeleteRow(row.detail)}
                  onDragStart={() => onDragStart(row.detail.id)}
                  onDragEnd={onDragEnd}
                  onDragOverRow={(position) => onDragOverRow(row.detail.id, position)}
                  onDropRow={(position) => onDropRow(row.detail.id, position)}
                />
              ))}
            </tbody>
          </table>
        </div>
      )}

      {onAdd && (
        <div className="flex flex-wrap items-center gap-2 px-3 py-2">
          {isPersonnel ? (
            members.length === 0 ? (
              <p className="text-[11px] text-amber-700">
                이 과제에 등록된 인력이 없어 인건비 행을 만들 수 없습니다.{' '}
                <Link
                  href={`/projects/${projectId}/team`}
                  className="font-semibold underline underline-offset-2"
                >
                  인력 화면에서 등록
                </Link>
              </p>
            ) : (
              <>
                <select
                  value={newMemberId}
                  disabled={busy}
                  aria-label={`${def.label} 추가할 인력`}
                  onChange={(e) => setNewMemberId(e.target.value)}
                  className="rounded-md border border-slate-300 px-2 py-1 text-xs focus:border-slate-500 focus:outline-none disabled:bg-slate-50"
                >
                  <option value="">인력 선택</option>
                  {members.map((member) => (
                    <option key={member.id} value={member.id}>
                      {member.name}
                      {member.active ? '' : ' (참여종료)'}
                    </option>
                  ))}
                </select>
                <Button
                  size="sm"
                  disabled={busy || newMemberId === ''}
                  title={newMemberId === '' ? '인건비 행은 인력을 먼저 고릅니다' : undefined}
                  onClick={() => {
                    onAdd(newMemberId);
                    setNewMemberId('');
                  }}
                >
                  + 행 추가
                </Button>
              </>
            )
          ) : (
            <Button size="sm" disabled={busy} onClick={() => onAdd(null)}>
              + 행 추가
            </Button>
          )}
        </div>
      )}
    </section>
  );
}
