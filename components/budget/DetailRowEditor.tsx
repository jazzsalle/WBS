'use client';

// 산출근거 행 편집기 (SOT §7.9.2 행 편집 표, §5.17, §6.10.1 PL-3·PL-5, §8.4 O-1·O-3)
//
//  - **컬럼 구조는 세목의 formula가 정한다.** personnel은 `인력 | 직위 | 연봉 | 참여율(%) |
//    참여기간(월)`, quantity는 `품명 | 규격·산출내역 | 단가 | 인자들`. 한 세목 안에서 두 구조가
//    섞이는 일은 없다 (PL-D3이 category로 formula를 고정한다).
//  - **직위·연봉은 Member에서 읽어 회색 읽기 전용이다.** 정의는 인력 화면 한 곳이다 (§5.11).
//    연봉이 비어 있는 인력을 고르면 금액이 0이 되므로 경고 + 인력 화면 링크를 붙인다.
//  - **금액 열은 읽기 전용이고 서버가 계산한 값만 보여준다** (PL-D7·PL-10a·O-4). 화면이 산식을
//    다시 구현하면 서버와 1원씩 어긋난다. 손으로 맞추고 싶으면 `조정액`을 쓴다.
//  - O-3: 입력값(draft)은 props가 바뀌어도 **자동으로 덮어쓰지 않는다.** 남이 먼저 저장해
//    version이 올라오면 "최신 값 사용" 버튼만 띄우고 선택은 사용자에게 맡긴다.
//
// 쓰기는 부모(BudgetPlanPanel)가 actions/budget-plan.ts로 보낸다. 여기서는 값만 만든다.

import { useEffect, useRef, useState, type DragEvent } from 'react';
import Link from 'next/link';
import type { BudgetDetail, DetailAxis, DetailFactor, Member, Settings } from '@/types';
import type { DetailAmountResult } from '@/lib/budget-plan';
import type { SubcategoryDef } from '@/lib/constants';
import { DETAIL_AXIS_LABELS, HIRE_TYPE_LABELS } from '@/lib/constants';
import type { DropPosition } from '@/lib/board';
import { formatAmount } from '@/lib/currency';
import Badge from '@/components/ui/Badge';
import Button from '@/components/ui/Button';

const DETAIL_AXES: readonly DetailAxis[] = ['cash', 'in_kind'];

// §5.17: 인자는 0~3개. 실측 서식의 최대 열 수(단가 × 인자 3)이며 Zod도 같은 상한이다
const MAX_FACTORS = 3;

/**
 * updateBudgetDetail에 보내는 근거 필드 묶음. **`amount`가 없다** — 금액은 서버가
 * lib/budget-plan.ts로 다시 계산한다 (PL-D7). 화면이 금액을 지어낼 수 있으면 근거가 근거가 아니다.
 */
export interface DetailRowPatch {
  axis: DetailAxis;
  memberId: string | null;
  name: string;
  unitPrice: number;
  spec: string;
  factors: DetailFactor[];
  adjustment: number;
  note: string;
}

interface FactorDraft {
  label: string;
  value: string;
  isPercent: boolean;
}

/**
 * personnel 행의 인자를 화면 두 칸(참여율·참여기간)에 나눈다.
 *
 * PL-1이 인자를 `isPercent` 여부로만 구분하므로 라벨이 아니라 그 플래그로 가른다 — 라벨은
 * 행마다 다를 수 있다(부록 A.5 주의 2). 첫 %가 참여율, 첫 비%가 참여기간(월)이고, 그 밖에 남는
 * 인자는 `extra`로 **그대로 보존한다.** 화면에 칸이 없다는 이유로 저장된 인자를 지우면
 * 사용자가 만진 적 없는 금액이 조용히 바뀐다.
 */
function splitPersonnelFactors(factors: readonly DetailFactor[]): {
  percent: DetailFactor | null;
  count: DetailFactor | null;
  extra: DetailFactor[];
} {
  let percent: DetailFactor | null = null;
  let count: DetailFactor | null = null;
  const extra: DetailFactor[] = [];
  for (const factor of factors) {
    if (factor.isPercent && percent === null) percent = factor;
    else if (!factor.isPercent && count === null) count = factor;
    else extra.push(factor);
  }
  return { percent, count, extra };
}

function toDraft(value: number | undefined): string {
  return value === undefined ? '' : String(value);
}

// 금액은 원 단위 정수다 (절대 규칙 4). 빈 칸은 0으로 읽는다 — 단가·조정액에 "미입력"은 없다
function parseWon(draft: string, allowNegative: boolean): number | null {
  const trimmed = draft.trim();
  if (trimmed === '') return 0;
  const value = Number(trimmed);
  if (!Number.isInteger(value)) return null;
  if (!allowNegative && value < 0) return null;
  return value;
}

// PL-3·PL-D5: 인자 값은 소수를 허용하되(참여율 10.0, 참여기간 8) 음수는 금액을 뒤집으므로 막는다
function parseFactorValue(draft: string): number | null {
  const value = Number(draft.trim());
  if (!Number.isFinite(value) || value < 0) return null;
  return value;
}

function sameFactors(a: readonly DetailFactor[], b: readonly DetailFactor[]): boolean {
  if (a.length !== b.length) return false;
  return a.every((factor, index) => {
    const other = b[index];
    return (
      other !== undefined &&
      factor.label === other.label &&
      factor.value === other.value &&
      factor.isPercent === other.isPercent
    );
  });
}

type BuildResult = { ok: true; patch: DetailRowPatch } | { ok: false; message: string };

export interface DetailRowEditorProps {
  detail: BudgetDetail;
  /** 서버가 PL-1~PL-5로 계산한 금액. 화면은 표시만 한다 */
  computed: DetailAmountResult;
  /** §7.9.2 인력 드롭다운 + 직위·연봉 읽기 전용 표시의 원본 (§5.11) */
  members: Member[];
  projectId: string;
  currencyUnit: Settings['currencyUnit'];
  /** 세목 프리셋의 기본 인자 (부록 A.5). 라벨의 **초기값**일 뿐이다 (PL-3) */
  defaultFactors: SubcategoryDef['defaultFactors'];
  /** 메시지 줄의 colspan — 세목 표의 열 수 */
  columnCount: number;
  busy: boolean;
  dragEnabled: boolean;
  dragging: boolean;
  dropPosition: DropPosition | null;
  /** §7.9 규칙 검증 패널의 행 단위 finding에서 넘어온 행. 열릴 때 한 번 끌어오고 파란 띠를 건다 */
  highlighted?: boolean;
  onSave: (patch: DetailRowPatch, expectedVersion: number) => void;
  onDelete: () => void;
  onDragStart: () => void;
  onDragEnd: () => void;
  onDragOverRow: (position: DropPosition) => void;
  onDropRow: (position: DropPosition) => void;
}

const CELL_INPUT =
  'w-full rounded-md border border-grey-300 px-2 py-1 text-xs focus:border-grey-500 focus:outline-none disabled:bg-grey-50';
const READONLY_CELL = 'rounded-md bg-grey-100 px-2 py-1 text-xs text-grey-500';

function positionFromPointer(e: DragEvent<HTMLElement>): DropPosition {
  const rect = e.currentTarget.getBoundingClientRect();
  const ratio = rect.height === 0 ? 0.5 : (e.clientY - rect.top) / rect.height;
  return ratio < 0.5 ? 'before' : 'after';
}

export default function DetailRowEditor({
  detail,
  computed,
  members,
  projectId,
  currencyUnit,
  defaultFactors,
  columnCount,
  busy,
  dragEnabled,
  dragging,
  dropPosition,
  highlighted = false,
  onSave,
  onDelete,
  onDragStart,
  onDragEnd,
  onDragOverRow,
  onDropRow,
}: DetailRowEditorProps) {
  const isPersonnel = detail.formula === 'personnel';

  // 규칙 검증 패널에서 넘어오면 세목 표가 화면 밖에 있을 수 있다 — 강조가 시작될 때 한 번 끌어온다
  const rowRef = useRef<HTMLTableRowElement | null>(null);
  useEffect(() => {
    if (!highlighted) return;
    rowRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }, [highlighted]);

  const [axis, setAxis] = useState<DetailAxis>(detail.axis);
  const [memberId, setMemberId] = useState(detail.memberId ?? '');
  const [name, setName] = useState(detail.name);
  const [unitPriceDraft, setUnitPriceDraft] = useState(String(detail.unitPrice));
  const [spec, setSpec] = useState(detail.spec);
  const [adjustmentDraft, setAdjustmentDraft] = useState(String(detail.adjustment));
  const [note, setNote] = useState(detail.note);

  // personnel: 참여율·참여기간은 화면 두 칸이지만 저장은 factors 하나다. 라벨은 저장된 값을
  // 그대로 이어 쓰고, 없으면 프리셋 기본값을 쓴다 (부록 A.5 주의 2)
  const [personnelDraft, setPersonnelDraft] = useState(() => {
    const split = splitPersonnelFactors(detail.factors);
    return {
      rate: toDraft(split.percent?.value),
      months: toDraft(split.count?.value),
      rateLabel: split.percent?.label ?? defaultFactors.find((f) => f.isPercent)?.label ?? '참여율(%)',
      monthsLabel:
        split.count?.label ?? defaultFactors.find((f) => !f.isPercent)?.label ?? '참여기간(월)',
      extra: split.extra,
    };
  });

  // quantity: 라벨·개수를 행마다 바꿀 수 있다 (PL-3). 서식 변형이 와도 스키마를 고치지 않는다
  const [factorDrafts, setFactorDrafts] = useState<FactorDraft[]>(() =>
    detail.factors.map((factor) => ({
      label: factor.label,
      value: String(factor.value),
      isPercent: factor.isPercent,
    }))
  );

  // O-1: 마지막으로 받아들인 서버 version. 저장의 expectedVersion이 여기서만 나온다
  const [baselineVersion, setBaselineVersion] = useState(detail.version);
  const [refreshed, setRefreshed] = useState(false);

  useEffect(() => {
    if (detail.version === baselineVersion) return;
    // 새 version이 다음 저장의 조건이 된다. 입력값(draft)은 건드리지 않는다 (O-3)
    setBaselineVersion(detail.version);
    setRefreshed(true);
  }, [detail.version, baselineVersion]);

  const resetDrafts = (): void => {
    const split = splitPersonnelFactors(detail.factors);
    setAxis(detail.axis);
    setMemberId(detail.memberId ?? '');
    setName(detail.name);
    setUnitPriceDraft(String(detail.unitPrice));
    setSpec(detail.spec);
    setAdjustmentDraft(String(detail.adjustment));
    setNote(detail.note);
    setPersonnelDraft((prev) => ({
      ...prev,
      rate: toDraft(split.percent?.value),
      months: toDraft(split.count?.value),
      rateLabel: split.percent?.label ?? prev.rateLabel,
      monthsLabel: split.count?.label ?? prev.monthsLabel,
      extra: split.extra,
    }));
    setFactorDrafts(
      detail.factors.map((factor) => ({
        label: factor.label,
        value: String(factor.value),
        isPercent: factor.isPercent,
      }))
    );
    setRefreshed(false);
  };

  const build = (): BuildResult => {
    const adjustment = parseWon(adjustmentDraft, true); // PL-D5의 유일한 예외 — 조정액만 음수 허용
    if (adjustment === null) {
      return { ok: false, message: '조정액은 원 단위 정수로 입력하세요 (음수 허용).' };
    }

    if (isPersonnel) {
      // PL-D1: 인건비 행은 memberId가 필수다 — 단가(연봉)의 유일한 출처다
      if (memberId === '') return { ok: false, message: '참여인력을 선택하세요.' };

      const factors: DetailFactor[] = [];
      if (personnelDraft.rate.trim() !== '') {
        const value = parseFactorValue(personnelDraft.rate);
        if (value === null) return { ok: false, message: '참여율은 0 이상 숫자로 입력하세요.' };
        factors.push({ label: personnelDraft.rateLabel, value, isPercent: true });
      }
      if (personnelDraft.months.trim() !== '') {
        const value = parseFactorValue(personnelDraft.months);
        if (value === null) return { ok: false, message: '참여기간(월)은 0 이상 숫자로 입력하세요.' };
        factors.push({ label: personnelDraft.monthsLabel, value, isPercent: false });
      }
      factors.push(...personnelDraft.extra);

      return {
        ok: true,
        patch: {
          axis,
          memberId,
          // PL-D1: 인건비 행의 품명·단가·규격은 이 표에 칸이 없다. 저장된 값을 그대로 되돌려
          // 보내 서버가 정규화하게 둔다 (여기서 지우면 화면에 없는 값을 화면이 바꾸는 셈이다)
          name: detail.name,
          unitPrice: detail.unitPrice,
          spec: detail.spec,
          factors,
          adjustment,
          note,
        },
      };
    }

    const unitPrice = parseWon(unitPriceDraft, false);
    if (unitPrice === null) {
      return { ok: false, message: '단가는 0 이상 원 단위 정수로 입력하세요.' };
    }

    const factors: DetailFactor[] = [];
    for (const draft of factorDrafts) {
      const label = draft.label.trim();
      // 라벨도 값도 비어 있으면 아직 채우지 않은 칸이다 — 0으로 저장하면 금액이 0이 된다
      if (label === '' && draft.value.trim() === '') continue;
      if (label.length > 20) return { ok: false, message: '인자 라벨은 20자 이내여야 합니다.' };
      const value = parseFactorValue(draft.value);
      if (value === null) {
        return {
          ok: false,
          message: `인자 "${label === '' ? '(이름 없음)' : label}" 값은 0 이상 숫자로 입력하세요.`,
        };
      }
      factors.push({ label, value, isPercent: draft.isPercent });
    }

    return {
      ok: true,
      patch: { axis, memberId: null, name: name.trim(), unitPrice, spec, factors, adjustment, note },
    };
  };

  const built = build();
  // 입력이 서버 값과 다른가. 형식이 틀린 상태도 "저장할 것이 남았다"이므로 dirty로 본다
  const dirty =
    !built.ok ||
    built.patch.axis !== detail.axis ||
    built.patch.memberId !== detail.memberId ||
    built.patch.name !== detail.name ||
    built.patch.unitPrice !== detail.unitPrice ||
    built.patch.spec !== detail.spec ||
    built.patch.adjustment !== detail.adjustment ||
    built.patch.note !== detail.note ||
    !sameFactors(built.patch.factors, detail.factors);

  // 내 저장이 반영돼 입력값과 서버 값이 같아졌으면 비교할 것이 없다 — 안내를 남겨 두면
  // 다음에 칸을 고칠 때 "남이 먼저 고쳤다"는 지난 안내가 되살아난다
  useEffect(() => {
    if (!dirty && refreshed) setRefreshed(false);
  }, [dirty, refreshed]);

  const selectedMember = memberId === '' ? null : members.find((m) => m.id === memberId) ?? null;
  // 저장 전이라도 연봉이 빈 인력을 고른 순간 알린다 — 저장하고 나서 0원을 발견하면 늦다
  const salaryMissing = isPersonnel && (selectedMember === null || selectedMember.annualSalary === null);
  const memberDeleted = isPersonnel && memberId !== '' && selectedMember === null;

  const handleSave = (): void => {
    if (!built.ok) return;
    onSave(built.patch, baselineVersion);
  };

  const disabled = busy;
  // 음수(PL-5)가 강조보다 우선한다 — 규칙이 가리킨 행이 동시에 음수면 음수가 더 급한 문제다
  const rowTone = computed.negative
    ? 'bg-red-50'
    : dragging
      ? 'opacity-40'
      : highlighted
        ? 'bg-blue-50 shadow-[inset_3px_0_0_0_#3182f6]'
        : dirty
          ? 'bg-orange-50/60'
          : '';

  const messages: { tone: 'red' | 'amber'; text: string }[] = [];
  if (!built.ok) messages.push({ tone: 'red', text: built.message });
  // PL-5: 음수는 0으로 자르지 않는다. 조정액을 잘못 넣은 것이지 0원짜리 행이 아니다
  if (computed.negative) {
    messages.push({
      tone: 'red',
      text: `최종 금액이 음수입니다 (${formatAmount(computed.amount, currencyUnit)}). 조정액을 확인하세요 — 저장은 되지만 셀 합계가 그만큼 줄어듭니다.`,
    });
  }
  if (memberDeleted) {
    messages.push({
      tone: 'red',
      text: '이 행이 가리키는 인력을 이 과제의 인력 목록에서 찾지 못했습니다. 인력을 다시 선택하세요.',
    });
  }

  return (
    <>
      <tr
        ref={rowRef}
        // 세목을 넘는 이동은 없다 (§7.9.2) — 어느 세목의 드래그인지는 부모가 판정한다
        onDragOver={(e) => {
          if (!dragEnabled) return;
          e.preventDefault();
          onDragOverRow(positionFromPointer(e));
        }}
        onDrop={(e) => {
          if (!dragEnabled) return;
          e.preventDefault();
          onDropRow(positionFromPointer(e));
        }}
        className={[
          'align-top',
          rowTone,
          dropPosition === 'before' ? 'shadow-[inset_0_2px_0_0_#2563eb]' : '',
          dropPosition === 'after' ? 'shadow-[inset_0_-2px_0_0_#2563eb]' : '',
        ].join(' ')}
      >
        <td className="py-1.5 pr-1">
          <span
            draggable={dragEnabled && !disabled}
            onDragStart={(e) => {
              e.dataTransfer.effectAllowed = 'move';
              e.dataTransfer.setData('text/plain', detail.id);
              onDragStart();
            }}
            onDragEnd={onDragEnd}
            title={
              dragEnabled
                ? '끌어서 이 세목 안에서 순서를 바꿉니다'
                : '지금은 순서를 바꿀 수 없습니다'
            }
            className={`select-none text-sm leading-none ${
              dragEnabled && !disabled ? 'cursor-grab text-grey-400' : 'cursor-not-allowed text-grey-200'
            }`}
          >
            ⠿
          </span>
        </td>

        {isPersonnel ? (
          <>
            {/* 인력 — 같은 인력의 중복 행을 막지 않는다 (참여율이 기간별로 갈리는 실측 사례) */}
            <td className="py-1.5 pr-2 min-w-[9rem]">
              <select
                value={memberId}
                disabled={disabled}
                aria-label="인력"
                onChange={(e) => setMemberId(e.target.value)}
                className={CELL_INPUT}
              >
                <option value="">선택하세요</option>
                {memberDeleted && <option value={memberId}>(이 과제에 없는 인력)</option>}
                {members.map((member) => (
                  <option key={member.id} value={member.id}>
                    {member.name}
                    {member.hireType === 'new' ? ` (${HIRE_TYPE_LABELS.new})` : ''}
                    {member.active ? '' : ' (참여종료)'}
                  </option>
                ))}
              </select>
            </td>
            {/* 직위·연봉은 Member가 원본이다. 여기서 고치지 않는다 (§5.11 — 정의는 인력 화면 한 곳) */}
            <td className="py-1.5 pr-2">
              <span className={READONLY_CELL} title="직위는 인력 화면에서 관리합니다">
                {selectedMember?.position.trim() ? selectedMember.position : '—'}
              </span>
            </td>
            <td className="py-1.5 pr-2 text-right">
              <span className={`${READONLY_CELL} tabular-nums`} title="연봉은 인력 화면에서 관리합니다">
                {selectedMember?.annualSalary === null || selectedMember === null
                  ? '—'
                  : formatAmount(selectedMember.annualSalary, currencyUnit)}
              </span>
            </td>
            <td className="py-1.5 pr-2 w-24">
              <input
                type="number"
                inputMode="decimal"
                min={0}
                step="any"
                value={personnelDraft.rate}
                disabled={disabled}
                aria-label={personnelDraft.rateLabel}
                placeholder="0"
                onChange={(e) => setPersonnelDraft((prev) => ({ ...prev, rate: e.target.value }))}
                className={`${CELL_INPUT} text-right tabular-nums`}
              />
            </td>
            <td className="py-1.5 pr-2 w-24">
              <input
                type="number"
                inputMode="decimal"
                min={0}
                step="any"
                value={personnelDraft.months}
                disabled={disabled}
                aria-label={personnelDraft.monthsLabel}
                placeholder="0"
                onChange={(e) => setPersonnelDraft((prev) => ({ ...prev, months: e.target.value }))}
                className={`${CELL_INPUT} text-right tabular-nums`}
              />
            </td>
          </>
        ) : (
          <>
            <td className="py-1.5 pr-2 min-w-[9rem]">
              <input
                type="text"
                maxLength={200}
                value={name}
                disabled={disabled}
                aria-label="품명"
                placeholder="품명"
                onChange={(e) => setName(e.target.value)}
                className={CELL_INPUT}
              />
            </td>
            <td className="py-1.5 pr-2 min-w-[10rem]">
              <input
                type="text"
                value={spec}
                disabled={disabled}
                aria-label="규격·산출내역"
                placeholder="규격 · 산출내역"
                onChange={(e) => setSpec(e.target.value)}
                className={CELL_INPUT}
              />
            </td>
            <td className="py-1.5 pr-2 w-32">
              <input
                type="number"
                inputMode="numeric"
                min={0}
                step={1}
                value={unitPriceDraft}
                disabled={disabled}
                aria-label="단가(원)"
                onChange={(e) => setUnitPriceDraft(e.target.value)}
                className={`${CELL_INPUT} text-right tabular-nums`}
              />
            </td>
            {/* 인자들 — 라벨·개수를 행마다 바꿀 수 있다 (PL-3). 단가는 인자가 아니다 (부록 A.5 주의 1) */}
            <td className="py-1.5 pr-2 min-w-[14rem]">
              <div className="space-y-1">
                {factorDrafts.map((factor, index) => (
                  <div key={index} className="flex items-center gap-1">
                    <input
                      type="text"
                      maxLength={20}
                      value={factor.label}
                      disabled={disabled}
                      aria-label={`인자 ${index + 1} 라벨`}
                      placeholder="라벨"
                      onChange={(e) =>
                        setFactorDrafts((prev) =>
                          prev.map((f, i) => (i === index ? { ...f, label: e.target.value } : f))
                        )
                      }
                      className={`${CELL_INPUT} w-24`}
                    />
                    <input
                      type="number"
                      inputMode="decimal"
                      min={0}
                      step="any"
                      value={factor.value}
                      disabled={disabled}
                      aria-label={`인자 ${index + 1} 값`}
                      placeholder="0"
                      onChange={(e) =>
                        setFactorDrafts((prev) =>
                          prev.map((f, i) => (i === index ? { ...f, value: e.target.value } : f))
                        )
                      }
                      className={`${CELL_INPUT} w-20 text-right tabular-nums`}
                    />
                    {/* isPercent는 계산 규칙을 바꾼다 (PL-3: value/100). 새로 만든 인자를 비율로
                        쓸 수 있어야 하므로 라벨과 함께 행에서 고른다 */}
                    <label
                      className="flex items-center gap-0.5 text-[11px] text-grey-500"
                      title="체크하면 계산 시 100으로 나눕니다 (PL-3)"
                    >
                      <input
                        type="checkbox"
                        checked={factor.isPercent}
                        disabled={disabled}
                        onChange={(e) =>
                          setFactorDrafts((prev) =>
                            prev.map((f, i) =>
                              i === index ? { ...f, isPercent: e.target.checked } : f
                            )
                          )
                        }
                        className="h-3 w-3 rounded border-grey-300"
                      />
                      %
                    </label>
                    <button
                      type="button"
                      disabled={disabled}
                      aria-label={`인자 ${index + 1} 삭제`}
                      title="이 인자를 뺍니다"
                      onClick={() => setFactorDrafts((prev) => prev.filter((_, i) => i !== index))}
                      className="px-1 text-sm leading-none text-grey-400 hover:text-red-600 disabled:opacity-50"
                    >
                      ×
                    </button>
                  </div>
                ))}
                {factorDrafts.length < MAX_FACTORS && (
                  <button
                    type="button"
                    disabled={disabled}
                    onClick={() =>
                      setFactorDrafts((prev) => [
                        ...prev,
                        {
                          label: defaultFactors[prev.length]?.label ?? '',
                          value: '',
                          isPercent: defaultFactors[prev.length]?.isPercent ?? false,
                        },
                      ])
                    }
                    className="rounded-md border border-dashed border-grey-300 px-2 py-0.5 text-[11px] text-grey-500 hover:border-grey-400 disabled:opacity-50"
                  >
                    + 인자
                  </button>
                )}
                {factorDrafts.length === 0 && (
                  <p className="text-[11px] text-grey-400">
                    인자가 없으면 금액 = 단가 + 조정액입니다 (PL-3).
                  </p>
                )}
              </div>
            </td>
          </>
        )}

        {/* 축 — null이 없다. 축이 없으면 합계를 현금/현물로 나눌 수 없다 (§5.17) */}
        <td className="py-1.5 pr-2 w-20">
          <select
            value={axis}
            disabled={disabled}
            aria-label="축(현금/현물)"
            onChange={(e) => setAxis(e.target.value as DetailAxis)}
            className={CELL_INPUT}
          >
            {DETAIL_AXES.map((value) => (
              <option key={value} value={value}>
                {DETAIL_AXIS_LABELS[value]}
              </option>
            ))}
          </select>
        </td>

        <td className="py-1.5 pr-2 w-28">
          <input
            type="number"
            inputMode="numeric"
            step={1}
            value={adjustmentDraft}
            disabled={disabled}
            aria-label="조정액(원)"
            title="서식의 절사·미세조정용. 음수를 넣을 수 있습니다 (PL-D5)"
            onChange={(e) => setAdjustmentDraft(e.target.value)}
            className={`${CELL_INPUT} text-right tabular-nums`}
          />
        </td>

        {/* 금액 — 읽기 전용이다. 계산 결과지 입력이 아니다 (§7.9.2, PL-D7) */}
        <td className="py-1.5 pr-2 text-right">
          <span
            className={`block font-semibold tabular-nums ${
              computed.negative ? 'text-red-600' : 'text-grey-800'
            }`}
            title="금액은 단가 × 인자들 + 조정액으로 서버가 계산합니다. 손으로 맞추려면 조정액을 쓰세요"
          >
            {formatAmount(computed.amount, currencyUnit)}
          </span>
          {dirty && (
            <span className="text-[11px] text-orange-700">저장 전 (금액은 마지막 저장 기준)</span>
          )}
        </td>

        {/* §7.9.2 컬럼 목록에는 없지만 BudgetDetail.note(§5.17)를 편집할 화면이 여기뿐이다 —
            칸을 두지 않으면 저장된 비고가 영원히 손에 닿지 않는다 */}
        <td className="py-1.5 pr-2 min-w-[8rem]">
          <input
            type="text"
            value={note}
            disabled={disabled}
            aria-label="비고"
            placeholder="비고"
            onChange={(e) => setNote(e.target.value)}
            className={CELL_INPUT}
          />
        </td>

        <td className="py-1.5 text-right">
          <div className="flex flex-wrap justify-end gap-1">
            <Button
              size="sm"
              variant="primary"
              disabled={disabled || !dirty}
              title={dirty ? undefined : '바뀐 값이 없습니다'}
              onClick={handleSave}
            >
              저장
            </Button>
            <Button size="sm" variant="danger" disabled={disabled} onClick={onDelete}>
              삭제
            </Button>
          </div>
        </td>
      </tr>

      {(messages.length > 0 || salaryMissing || (refreshed && dirty)) && (
        <tr className={computed.negative ? 'bg-red-50' : dirty ? 'bg-orange-50/60' : ''}>
          <td />
          <td colSpan={columnCount - 1} className="pb-2 text-[11px]">
            {messages.map((message, index) => (
              <p
                key={index}
                className={message.tone === 'red' ? 'text-red-700' : 'text-orange-700'}
              >
                {message.text}
              </p>
            ))}

            {/* 연봉이 비어 있으면 금액이 0이 된다 — 어디서 고치는지까지 알려준다 (§7.9.2, §5.11) */}
            {salaryMissing && !memberDeleted && (
              <p className="text-orange-700">
                <Badge tone="amber">연봉 미입력</Badge>{' '}
                {memberId === ''
                  ? '참여인력을 선택하면 연봉을 단가로 씁니다.'
                  : '이 인력의 연봉이 비어 있어 금액이 0원으로 계산됩니다.'}{' '}
                <Link
                  href={`/projects/${projectId}/team`}
                  className="font-semibold underline underline-offset-2"
                >
                  인력 화면에서 연봉 입력
                </Link>
              </p>
            )}

            {/* O-3: 남이 먼저 저장했다. 내 입력은 그대로 두고 선택지만 준다 */}
            {refreshed && dirty && (
              <p className="mt-1 text-orange-700">
                이 행의 최신 값을 다시 불러왔습니다. 입력하신 값은 그대로 두었습니다.{' '}
                <button
                  type="button"
                  onClick={resetDrafts}
                  className="rounded-md border border-orange-300 px-1.5 py-0.5 font-semibold"
                >
                  최신 값 사용
                </button>
              </p>
            )}
          </td>
        </tr>
      )}
    </>
  );
}
