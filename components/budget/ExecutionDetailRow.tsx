'use client';

// 집행 내역 패널의 접힌 "내역" 줄 (SOT §7.9, §7.9.7 수행 모드 마지막 문장, §5.12 Phase 20 필드)
//
//  - 세목·규격·단가·인자·축·인력·산출근거는 **전부 선택**이다(§5.12). 손으로 넣는 집행은
//    내역 없이도 성립하므로 기본은 접혀 있고, 접힌 줄은 요약만 보인다.
//  - 저장은 **바뀐 필드만** 보낸다. 부모가 인력·산출근거 목록을 넘기지 않은 경우(선택 props)에도
//    이미 저장된 memberId·detailId를 화면이 모른다는 이유로 덮어쓰지 않기 위해서다.
//  - 목록에 없는 값(프리셋 밖 세목, 목록 밖 인력·산출근거)은 지우지 않고 "목록에 없음" 선택지로
//    남긴다. 드롭다운이 첫 항목으로 조용히 바뀌면 사용자가 만진 적 없는 값이 저장된다.
//  - O-3: 남의 저장으로 version이 올라와도 편집 중인 입력은 덮어쓰지 않는다. "최신 값 사용"만 띄운다.
//
// 쓰기는 부모(BudgetDetailPanel)가 actions/budget.ts의 updateExecution으로 보낸다. 여기서는 값만 만든다.

import { useEffect, useState } from 'react';
import type {
  BudgetCategory,
  BudgetDetail,
  BudgetExecution,
  DetailAxis,
  DetailFactor,
  Member,
  Settings,
} from '@/types';
import { BUDGET_CATEGORY_LABELS, DETAIL_AXIS_LABELS, SUBCATEGORY_PRESETS } from '@/lib/constants';
import { formatAmount } from '@/lib/currency';
import Button from '@/components/ui/Button';

const DETAIL_AXES: readonly DetailAxis[] = ['cash', 'in_kind'];

// §5.12: 인자는 0~3개. 액션의 Zod 상한과 같다
const MAX_FACTORS = 3;
// actions/budget.ts의 spec(noteSchema) 상한과 같다
const SPEC_MAX = 10_000;

/** updateExecution에 보내는 내역 필드. 바뀐 키만 들어간다 */
export interface ExecutionDetailPatch {
  subcategoryCode?: string | null;
  spec?: string;
  unitPrice?: number | null;
  factors?: DetailFactor[] | null;
  axis?: DetailAxis | null;
  memberId?: string | null;
  detailId?: string | null;
}

interface FactorDraft {
  label: string;
  value: string;
  isPercent: boolean;
}

interface Draft {
  subcategoryCode: string; // '' = 미지정(null)
  spec: string;
  unitPrice: string; // '' = 미입력(null)
  factors: FactorDraft[];
  axis: '' | DetailAxis;
  memberId: string;
  detailId: string;
}

function toDraft(execution: BudgetExecution): Draft {
  return {
    subcategoryCode: execution.subcategoryCode ?? '',
    spec: execution.spec,
    unitPrice: execution.unitPrice === null ? '' : String(execution.unitPrice),
    factors: (execution.factors ?? []).map((f) => ({
      label: f.label,
      value: String(f.value),
      isPercent: f.isPercent,
    })),
    axis: execution.axis ?? '',
    memberId: execution.memberId ?? '',
    detailId: execution.detailId ?? '',
  };
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

type BuildResult = { ok: true; patch: ExecutionDetailPatch } | { ok: false; message: string };

function buildPatch(draft: Draft, execution: BudgetExecution): BuildResult {
  // B-4: 단가는 원 단위 정수다. 빈 칸은 "미입력"(null)이고 0원과 구분한다
  let unitPrice: number | null = null;
  const priceText = draft.unitPrice.trim();
  if (priceText !== '') {
    const value = Number(priceText);
    if (!Number.isInteger(value) || value < 0) {
      return { ok: false, message: '단가는 0 이상 정수(원)로 입력하세요.' };
    }
    unitPrice = value;
  }

  // PL-3과 같다: 인자 값은 소수를 허용하고(참여율 10.0) 음수는 막는다. 빈 값을 0으로 채우지 않는다
  const factors: DetailFactor[] = [];
  for (const [index, f] of draft.factors.entries()) {
    const text = f.value.trim();
    const value = Number(text);
    if (text === '' || !Number.isFinite(value) || value < 0) {
      return {
        ok: false,
        message: `인자 ${index + 1}의 값을 0 이상 숫자로 입력하세요.`,
      };
    }
    factors.push({ label: f.label.trim(), value, isPercent: f.isPercent });
  }

  if (draft.spec.length > SPEC_MAX) {
    return { ok: false, message: '규격은 10,000자 이내여야 합니다.' };
  }

  const next = {
    subcategoryCode: draft.subcategoryCode === '' ? null : draft.subcategoryCode,
    spec: draft.spec,
    unitPrice,
    // 인자가 하나도 없으면 "미입력"이다(§5.12 factors null 허용)
    factors: factors.length === 0 ? null : factors,
    axis: draft.axis === '' ? null : draft.axis,
    memberId: draft.memberId === '' ? null : draft.memberId,
    detailId: draft.detailId === '' ? null : draft.detailId,
  };

  const patch: ExecutionDetailPatch = {};
  if (next.subcategoryCode !== execution.subcategoryCode)
    patch.subcategoryCode = next.subcategoryCode;
  if (next.spec !== execution.spec) patch.spec = next.spec;
  if (next.unitPrice !== execution.unitPrice) patch.unitPrice = next.unitPrice;
  if (!sameFactors(next.factors ?? [], execution.factors ?? [])) patch.factors = next.factors;
  if (next.axis !== execution.axis) patch.axis = next.axis;
  if (next.memberId !== execution.memberId) patch.memberId = next.memberId;
  if (next.detailId !== execution.detailId) patch.detailId = next.detailId;
  return { ok: true, patch };
}

// 인건비 산식(§6.10.1)을 쓰는 비목이면 인력을 고른다 — 부록 A.5에서 formula로 판정한다
function isPersonnelCategory(category: BudgetCategory): boolean {
  return SUBCATEGORY_PRESETS[category].some((def) => def.formula === 'personnel');
}

function subcategoryLabel(category: BudgetCategory, code: string): string | null {
  return SUBCATEGORY_PRESETS[category].find((def) => def.code === code)?.label ?? null;
}

function detailLabel(
  detail: BudgetDetail,
  membersById: Map<string, Member>,
  currencyUnit: Settings['currencyUnit']
): string {
  const sub = subcategoryLabel(detail.category, detail.subcategory) ?? detail.subcategory;
  const who =
    detail.formula === 'personnel'
      ? ((detail.memberId ? membersById.get(detail.memberId)?.name : undefined) ?? '(인력 없음)')
      : detail.name === ''
        ? '(품명 없음)'
        : detail.name;
  return `${BUDGET_CATEGORY_LABELS[detail.category]} · ${sub} · ${who} · ${formatAmount(detail.amount, currencyUnit)}`;
}

const fieldClass =
  'rounded-lg border border-grey-300 bg-surface px-2.5 py-1.5 text-xs focus:border-grey-500 focus:outline-none';
const inputClass = `mt-1 w-full ${fieldClass}`;

export interface ExecutionDetailRowProps {
  execution: BudgetExecution;
  category: BudgetCategory;
  yearId: string;
  /** 인력 선택지(§5.11). 넘기지 않으면 인력은 표시·유지만 하고 바꾸지 못한다 */
  members?: Member[];
  /** 산출근거 선택지(§5.17). 같은 연차만 고를 수 있다(IN-13). 넘기지 않으면 표시·유지만 한다 */
  details?: BudgetDetail[];
  currencyUnit: Settings['currencyUnit'];
  busy: boolean;
  /** 표의 열 수 — 접힌 줄이 표 전체 폭을 쓰게 한다 */
  colSpan: number;
  onValidationError: (message: string) => void;
  /** 부모가 updateExecution(expectedVersion = execution.version)으로 보낸다. 성공 시 onSaved를 부른다 */
  onSave: (patch: ExecutionDetailPatch, onSaved: () => void) => void;
}

export default function ExecutionDetailRow({
  execution,
  category,
  yearId,
  members,
  details,
  currencyUnit,
  busy,
  colSpan,
  onValidationError,
  onSave,
}: ExecutionDetailRowProps) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<Draft>(() => toDraft(execution));
  // 사용자가 손대지 않은 상태 — 이때 올라온 새 version은 그대로 받아도 입력을 잃지 않는다
  const [pristine, setPristine] = useState(true);
  const [baseVersion, setBaseVersion] = useState(execution.version);
  const [reloaded, setReloaded] = useState(false);

  useEffect(() => {
    if (execution.version === baseVersion) return;
    setBaseVersion(execution.version);
    if (pristine) {
      setDraft(toDraft(execution));
      setReloaded(false);
    } else {
      // O-3: 편집 중인 값은 두고 선택을 사용자에게 맡긴다
      setReloaded(true);
    }
  }, [execution, baseVersion, pristine]);

  const update = (patch: Partial<Draft>): void => {
    setDraft((prev) => ({ ...prev, ...patch }));
    setPristine(false);
  };

  const membersById = new Map((members ?? []).map((m) => [m.id, m]));
  const presets = SUBCATEGORY_PRESETS[category];
  const personnel = isPersonnelCategory(category);
  const showMember = personnel || execution.memberId !== null || draft.memberId !== '';
  // IN-13: 서버는 같은 과제·같은 연차만 받는다. 비목은 묻지 않지만 같은 비목을 앞에 둔다
  const yearDetails = (details ?? [])
    .filter((d) => d.yearId === yearId)
    .sort((a, b) => Number(b.category === category) - Number(a.category === category));

  // ─ 접힌 요약 ─
  const summaryParts: string[] = [];
  if (execution.subcategoryCode !== null) {
    summaryParts.push(
      subcategoryLabel(category, execution.subcategoryCode) ??
        `알 수 없는 세목(${execution.subcategoryCode})`
    );
  }
  if (execution.spec !== '') summaryParts.push(execution.spec);
  if (execution.unitPrice !== null) {
    const factorText = (execution.factors ?? [])
      .map((f) => `${f.label === '' ? '' : `${f.label} `}${f.value}${f.isPercent ? '%' : ''}`)
      .join(' × ');
    summaryParts.push(
      `${formatAmount(execution.unitPrice, currencyUnit)}${factorText === '' ? '' : ` × ${factorText}`}`
    );
  } else if ((execution.factors ?? []).length > 0) {
    summaryParts.push(
      (execution.factors ?? [])
        .map((f) => `${f.label} ${f.value}${f.isPercent ? '%' : ''}`)
        .join(' × ')
    );
  }
  if (execution.axis !== null) summaryParts.push(DETAIL_AXIS_LABELS[execution.axis]);
  if (execution.memberId !== null) {
    summaryParts.push(membersById.get(execution.memberId)?.name ?? '인력 지정됨');
  }
  if (execution.detailId !== null) summaryParts.push('산출근거 연결');

  const handleSave = (): void => {
    const built = buildPatch(draft, execution);
    if (!built.ok) {
      onValidationError(built.message);
      return;
    }
    if (Object.keys(built.patch).length === 0) {
      onValidationError('바뀐 내역이 없습니다.');
      return;
    }
    onSave(built.patch, () => {
      setPristine(true);
      setReloaded(false);
    });
  };

  const handleReset = (): void => {
    setDraft(toDraft(execution));
    setPristine(true);
    setReloaded(false);
  };

  return (
    <tr className="border-t-0">
      <td colSpan={colSpan} className="pb-2 pt-0">
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
          className="flex w-full items-start gap-1.5 rounded-md px-1 py-0.5 text-left text-[11px] text-grey-500 hover:bg-grey-50"
        >
          <span aria-hidden className="w-3 shrink-0">
            {open ? '▾' : '▸'}
          </span>
          <span className="shrink-0 font-semibold">내역</span>
          <span className="min-w-0 truncate">
            {summaryParts.length === 0 ? '없음 (선택 입력)' : summaryParts.join(' · ')}
          </span>
        </button>

        {open && (
          <div className="mt-1 space-y-2 rounded-lg bg-grey-50 p-3">
            {reloaded && (
              <div className="rounded-lg border border-orange-200 bg-orange-50 p-2 text-[11px] text-orange-800">
                <p>다른 곳에서 이 집행이 바뀌었습니다. 입력하신 내역은 그대로 두었습니다.</p>
                <button
                  type="button"
                  onClick={handleReset}
                  className="mt-1 rounded-md border border-orange-300 px-2 py-0.5 font-semibold"
                >
                  최신 값 사용
                </button>
              </div>
            )}

            <div className="grid grid-cols-2 gap-2">
              <label className="text-[11px] text-grey-600">
                세목
                <select
                  value={draft.subcategoryCode}
                  disabled={busy}
                  onChange={(e) => update({ subcategoryCode: e.target.value })}
                  className={inputClass}
                >
                  <option value="">미지정</option>
                  {presets.map((def) => (
                    <option key={def.code} value={def.code}>
                      {def.label}
                    </option>
                  ))}
                  {draft.subcategoryCode !== '' &&
                    !presets.some((def) => def.code === draft.subcategoryCode) && (
                      <option value={draft.subcategoryCode}>
                        알 수 없는 세목({draft.subcategoryCode})
                      </option>
                    )}
                </select>
              </label>
              <label className="text-[11px] text-grey-600">
                축
                <select
                  value={draft.axis}
                  disabled={busy}
                  onChange={(e) => update({ axis: e.target.value as Draft['axis'] })}
                  className={inputClass}
                >
                  <option value="">미지정</option>
                  {DETAIL_AXES.map((value) => (
                    <option key={value} value={value}>
                      {DETAIL_AXIS_LABELS[value]}
                    </option>
                  ))}
                </select>
              </label>
            </div>

            <label className="block text-[11px] text-grey-600">
              규격
              <input
                type="text"
                maxLength={SPEC_MAX}
                value={draft.spec}
                disabled={busy}
                placeholder="규격 / 산출내역 메모"
                onChange={(e) => update({ spec: e.target.value })}
                className={inputClass}
              />
            </label>

            <label className="block text-[11px] text-grey-600">
              단가(원)
              <input
                type="number"
                inputMode="numeric"
                min={0}
                step={1}
                value={draft.unitPrice}
                disabled={busy}
                placeholder="미입력"
                onChange={(e) => update({ unitPrice: e.target.value })}
                className={`${inputClass} text-right tabular-nums`}
              />
            </label>

            <div className="space-y-1">
              <p className="text-[11px] text-grey-600">인자</p>
              {draft.factors.map((factor, index) => (
                <div key={index} className="flex items-center gap-1">
                  <input
                    type="text"
                    maxLength={20}
                    value={factor.label}
                    disabled={busy}
                    aria-label={`인자 ${index + 1} 라벨`}
                    placeholder="라벨"
                    onChange={(e) =>
                      update({
                        factors: draft.factors.map((f, i) =>
                          i === index ? { ...f, label: e.target.value } : f
                        ),
                      })
                    }
                    className={`${fieldClass} w-24`}
                  />
                  <input
                    type="number"
                    inputMode="decimal"
                    min={0}
                    step="any"
                    value={factor.value}
                    disabled={busy}
                    aria-label={`인자 ${index + 1} 값`}
                    placeholder="0"
                    onChange={(e) =>
                      update({
                        factors: draft.factors.map((f, i) =>
                          i === index ? { ...f, value: e.target.value } : f
                        ),
                      })
                    }
                    className={`${fieldClass} w-20 text-right tabular-nums`}
                  />
                  {/* isPercent는 값의 의미를 바꾼다(value/100, PL-3) — 라벨과 함께 행에서 고른다 */}
                  <label
                    className="flex items-center gap-0.5 text-[11px] text-grey-500"
                    title="체크하면 백분율 값입니다 (PL-3)"
                  >
                    <input
                      type="checkbox"
                      checked={factor.isPercent}
                      disabled={busy}
                      onChange={(e) =>
                        update({
                          factors: draft.factors.map((f, i) =>
                            i === index ? { ...f, isPercent: e.target.checked } : f
                          ),
                        })
                      }
                      className="h-3 w-3 rounded border-grey-300"
                    />
                    %
                  </label>
                  <button
                    type="button"
                    disabled={busy}
                    aria-label={`인자 ${index + 1} 삭제`}
                    title="이 인자를 뺍니다"
                    onClick={() =>
                      update({
                        factors: draft.factors.filter((_, i) => i !== index),
                      })
                    }
                    className="px-1 text-sm leading-none text-grey-400 hover:text-red-600 disabled:opacity-50"
                  >
                    ×
                  </button>
                </div>
              ))}
              {draft.factors.length < MAX_FACTORS && (
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => {
                    // 세목이 정해져 있으면 그 세목의 기본 인자 라벨을 초기값으로 채운다(부록 A.5)
                    const defaults =
                      presets.find((def) => def.code === draft.subcategoryCode)?.defaultFactors ??
                      [];
                    const next = defaults[draft.factors.length];
                    update({
                      factors: [
                        ...draft.factors,
                        {
                          label: next?.label ?? '',
                          value: '',
                          isPercent: next?.isPercent ?? false,
                        },
                      ],
                    });
                  }}
                  className="rounded-md border border-dashed border-grey-300 px-2 py-0.5 text-[11px] text-grey-500 hover:border-grey-400 disabled:opacity-50"
                >
                  + 인자
                </button>
              )}
            </div>

            {showMember && (
              <label className="block text-[11px] text-grey-600">
                인력
                {members === undefined ? (
                  <p className="mt-1 text-grey-500">
                    {draft.memberId === '' ? '미지정' : '지정됨'} — 인력 목록을 받지 못해 여기서
                    바꿀 수 없습니다.
                  </p>
                ) : (
                  <select
                    value={draft.memberId}
                    disabled={busy}
                    onChange={(e) => update({ memberId: e.target.value })}
                    className={inputClass}
                  >
                    <option value="">미지정</option>
                    {members.map((m) => (
                      <option key={m.id} value={m.id}>
                        {m.name}
                        {m.position === '' ? '' : ` (${m.position})`}
                        {m.active ? '' : ' · 참여 종료'}
                      </option>
                    ))}
                    {draft.memberId !== '' && !membersById.has(draft.memberId) && (
                      <option value={draft.memberId}>목록에 없는 인력</option>
                    )}
                  </select>
                )}
              </label>
            )}

            <label className="block text-[11px] text-grey-600">
              산출근거 (선택)
              {details === undefined ? (
                <p className="mt-1 text-grey-500">
                  {draft.detailId === '' ? '연결 없음' : '연결됨'} — 산출근거 목록을 받지 못해
                  여기서 바꿀 수 없습니다.
                </p>
              ) : (
                <select
                  value={draft.detailId}
                  disabled={busy}
                  onChange={(e) => update({ detailId: e.target.value })}
                  className={inputClass}
                >
                  <option value="">연결 없음</option>
                  {yearDetails.map((d) => (
                    <option key={d.id} value={d.id}>
                      {detailLabel(d, membersById, currencyUnit)}
                    </option>
                  ))}
                  {draft.detailId !== '' && !yearDetails.some((d) => d.id === draft.detailId) && (
                    <option value={draft.detailId}>목록에 없는 산출근거</option>
                  )}
                </select>
              )}
            </label>

            <p className="text-[11px] text-grey-500">
              내역은 선택 입력입니다. 집행액은 위의 금액 그대로이며 여기서 계산하지 않습니다.
            </p>

            <div className="flex justify-end gap-1">
              <Button size="sm" disabled={busy || pristine} onClick={handleReset}>
                되돌리기
              </Button>
              <Button size="sm" variant="primary" disabled={busy || pristine} onClick={handleSave}>
                {busy ? '저장 중…' : '내역 저장'}
              </Button>
            </div>
          </div>
        )}
      </td>
    </tr>
  );
}
