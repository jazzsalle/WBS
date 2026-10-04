'use client';

// 편성 항목 추가·수정 대화 (SOT §5.24, §6.19 AG-6, §7.9.8 "편성 항목·증빙 보기", §8.4 O-1·O-3, 계획서 S-2·S-10·U-3)
//
// 작성 중 버전에서만 열린다(확정 버전은 체크·메모만 — EvidenceEditor). 서버도 확정 버전을 RULE로 거부한다.
//  - 추가: 증빙은 보내지 않는다 — 서버가 그 종류의 기본 목록을 복사해 채운다(§5.24 "복사", 상수 원본은 한 곳)
//  - 수정: 바뀐 칸만 patch로 보낸다. 종류를 바꿔도 증빙 목록은 그대로다(저장된 것이 진실 — 액션과 같은 규칙)
//  - 금액은 부가세 별도 원 단위 정수다. 장비 기준(RL-17) 비교는 판정기만 한다 — 여기서 ×1.1을 계산하지 않는다
//  - STALE은 배너가 아니라 ConflictDialog(O-3) — 입력을 보존하고, 다시 불러오면 최신 값과 다른 칸만 비교·선택한다

import { useEffect, useMemo, useRef, useState } from 'react';
import type { AgreementItem, AgreementItemKind, Settings, Year } from '@/types';
import type { ActionErrorCode } from '@/lib/db/errors';
import { addAgreementItem, updateAgreementItem } from '@/actions/agreement-items';
import { AGREEMENT_ITEM_MAX_LENGTH } from '@/lib/constants';
import { AGREEMENT_ITEM_KIND_ORDER } from '@/lib/agreement/items-view';
import { defaultEvidence, itemKindLabel } from '@/lib/agreement/evidence';
import { formatAmount } from '@/lib/currency';
import Modal from '@/components/ui/Modal';
import Button from '@/components/ui/Button';
import ErrorBanner from '@/components/ui/ErrorBanner';
import ConflictDialog from '@/components/ui/ConflictDialog';
import { setRealtimePaused } from '@/components/RealtimeRefresher';

/** 금액 칸 안내(§5.24·§7.9.8 문구 그대로) */
export const ITEM_AMOUNT_VAT_NOTE = '부가세 별도 금액 — 장비 기준(부가세 포함 3천만 원)은 ×1.1로 비교합니다';

interface FormValues {
  yearId: string;
  kind: AgreementItemKind;
  name: string;
  quantity: string; // '' = 수량 없음
  amount: string;
}

type FieldKey = keyof FormValues;

const FIELDS: readonly { key: FieldKey; label: string }[] = [
  { key: 'yearId', label: '연차' },
  { key: 'kind', label: '종류' },
  { key: 'name', label: '품명' },
  { key: 'quantity', label: '수량' },
  { key: 'amount', label: '금액' },
] as const;

const INPUT_CLASS =
  'mt-1 w-full rounded-lg border border-grey-300 bg-surface px-3 py-2 text-sm focus:border-grey-500 focus:outline-none';

function toValues(item: AgreementItem): FormValues {
  return {
    yearId: item.yearId,
    kind: item.kind,
    name: item.name,
    quantity: item.quantity === null ? '' : String(item.quantity),
    amount: String(item.amount),
  };
}

interface Parsed {
  yearId: string;
  kind: AgreementItemKind;
  name: string;
  quantity: number | null;
  amount: number;
}

/** 입력 문자열 → 값. 첫 오류 문장을 돌려준다(서버 Zod가 같은 범위를 다시 검사한다) */
function parseValues(v: FormValues): { ok: true; value: Parsed } | { ok: false; error: string } {
  if (v.yearId === '') return { ok: false, error: '연차를 고르세요.' };
  if (!AGREEMENT_ITEM_KIND_ORDER.includes(v.kind)) return { ok: false, error: '종류를 고르세요.' };
  const name = v.name.trim();
  if (name.length === 0) return { ok: false, error: '품명을 입력하세요.' };
  if (name.length > AGREEMENT_ITEM_MAX_LENGTH.name) {
    return { ok: false, error: `품명은 ${AGREEMENT_ITEM_MAX_LENGTH.name}자 이내여야 합니다.` };
  }
  const q = v.quantity.trim();
  let quantity: number | null = null;
  if (q !== '') {
    const n = Number(q);
    if (!Number.isFinite(n) || n < 0) return { ok: false, error: '수량은 0 이상의 숫자로 입력하세요(없으면 비워 두세요).' };
    quantity = n;
  }
  const a = v.amount.trim();
  const amount = Number(a);
  if (a === '' || !Number.isSafeInteger(amount) || amount < 0) {
    return { ok: false, error: '금액은 0 이상의 원 단위 정수로 입력하세요.' };
  }
  return { ok: true, value: { yearId: v.yearId, kind: v.kind, name, quantity, amount } };
}

type ItemPatch = Partial<Parsed>;

/** 최신 서버 행(base)과 다른 칸만 */
function buildPatch(base: AgreementItem, p: Parsed): ItemPatch {
  const patch: ItemPatch = {};
  if (p.yearId !== base.yearId) patch.yearId = p.yearId;
  if (p.kind !== base.kind) patch.kind = p.kind;
  if (p.name !== base.name) patch.name = p.name;
  if (p.quantity !== base.quantity) patch.quantity = p.quantity;
  if (p.amount !== base.amount) patch.amount = p.amount;
  return patch;
}

export interface ItemDialogProps {
  /** 보고 있는(작성 중) 버전 */
  versionId: string;
  /** null = 추가. 수정이면 부모가 최신 서버 행(version 포함)을 내려준다 — 다시 불러오기 후 최신 값이 여기로 온다 */
  item: AgreementItem | null;
  /** 수정 중 그 행이 다른 사람에 의해 지워졌으면 true — 저장을 막고 알린다 */
  removed?: boolean;
  /** 연차 선택지(과제 연차) */
  years: Year[];
  currencyUnit: Settings['currencyUnit'];
  onClose: () => void;
  /** 저장 성공 — 부모가 새로 불러오고 안내를 띄운다 */
  onSaved: (saved: AgreementItem) => void;
  /** O-3 [다시 불러오기] — 부모가 서버 값을 새로 받는다 */
  onReload: () => void;
}

export default function ItemDialog({
  versionId,
  item,
  removed = false,
  years,
  currencyUnit,
  onClose,
  onSaved,
  onReload,
}: ItemDialogProps) {
  const sortedYears = useMemo(() => [...years].sort((a, b) => a.order - b.order), [years]);

  const [values, setValues] = useState<FormValues>(() =>
    item !== null
      ? toValues(item)
      : { yearId: sortedYears[0]?.id ?? '', kind: 'equipment', name: '', quantity: '', amount: '' }
  );
  const [saving, setSaving] = useState(false);
  const [failure, setFailure] = useState<{ message: string; code?: ActionErrorCode } | null>(null);
  const [conflict, setConflict] = useState<string | null>(null);
  // O-3 비교 기준: 마지막으로 받아들인 서버 행. patch와 expectedVersion은 여기서만 나온다
  const [baseline, setBaseline] = useState<AgreementItem | null>(item);
  const [reloaded, setReloaded] = useState(false);
  // 수정 중 행이 지워져 부모가 null을 내려줘도 추가 대화로 바뀌지 않게 — 모드는 열 때 정해진다
  const editing = baseline !== null;

  // R-4: 대화가 열린 동안 자동 새로고침을 보류해 입력 중인 내용을 지킨다
  useEffect(() => {
    setRealtimePaused(true);
    return () => setRealtimePaused(false);
  }, []);

  // 다시 불러오기 후 부모가 새 행을 내려주면 비교 기준만 바꾼다. 입력값은 건드리지 않는다(O-3)
  const baselineVersion = baseline?.version ?? null;
  useEffect(() => {
    if (item === null || item.version === baselineVersion) return;
    setBaseline(item);
    setConflict(null);
    setReloaded(true);
  }, [item, baselineVersion]);

  const nameRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    nameRef.current?.focus();
  }, []);

  const setField = <K extends FieldKey>(key: K, value: FormValues[K]): void => {
    setValues((prev) => ({ ...prev, [key]: value }));
  };

  const yearLabel = (id: string): string => sortedYears.find((y) => y.id === id)?.name ?? '(목록에 없는 연차)';

  const displayValue = (key: FieldKey, source: FormValues): string => {
    if (key === 'yearId') return yearLabel(source.yearId);
    if (key === 'kind') return itemKindLabel(source.kind);
    const raw = source[key].trim();
    if (raw === '') return '(비어 있음)';
    if (key === 'amount') {
      const n = Number(raw);
      return Number.isSafeInteger(n) ? `${n.toLocaleString('ko-KR')}원` : raw;
    }
    return raw;
  };

  const differences = useMemo(() => {
    if (!reloaded || baseline === null) return [];
    const latest = toValues(baseline);
    return FIELDS.filter((f) => latest[f.key].trim() !== values[f.key].trim()).map((field) => ({ field, latest }));
  }, [reloaded, baseline, values]);

  const amountPreview = useMemo(() => {
    const n = Number(values.amount.trim());
    return values.amount.trim() !== '' && Number.isSafeInteger(n) && n >= 0 ? formatAmount(n, currencyUnit) : null;
  }, [values.amount, currencyUnit]);

  const handleSubmit = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault();
    setFailure(null);
    const parsed = parseValues(values);
    if (!parsed.ok) {
      setFailure({ message: parsed.error, code: 'VALIDATION' });
      return;
    }
    const p = parsed.value;

    setSaving(true);
    try {
      let res;
      if (baseline === null) {
        // evidence 생략 = 서버가 그 종류의 기본 목록을 복사한다(§5.24)
        res = await addAgreementItem(versionId, {
          yearId: p.yearId,
          kind: p.kind,
          name: p.name,
          quantity: p.quantity,
          amount: p.amount,
        });
      } else {
        const patch = buildPatch(baseline, p);
        if (Object.keys(patch).length === 0) {
          onClose();
          return;
        }
        // O-1: 마지막으로 받아들인 서버 행의 version을 조건으로 건다
        res = await updateAgreementItem(baseline.id, patch, baseline.version);
      }
      if (!res.ok) {
        // O-3: STALE은 배너가 아니라 선택 대화로 — 입력을 유지한 채 사용자가 고른다
        if (res.code === 'STALE') setConflict(res.error);
        else setFailure({ message: res.error, code: res.code });
        return;
      }
      onSaved(res.data);
    } catch (err) {
      // 네트워크 단절 등 — 저장됐는지 모르는 채로 넘어가지 않는다
      setFailure({ message: `편성 항목을 저장하지 못했습니다: ${err instanceof Error ? err.message : String(err)}` });
    } finally {
      setSaving(false);
    }
  };

  const kindChanged = baseline !== null && values.kind !== baseline.kind;

  return (
    <>
      <Modal
        open
        title={editing ? '편성 항목 수정' : '편성 항목 추가'}
        description={
          editing
            ? '바꾼 칸만 저장합니다. 증빙은 행의 [증빙]에서 고칩니다.'
            : '장비·재료·외주용역을 건별로 적습니다. 그 종류의 증빙 기본 목록이 함께 만들어집니다.'
        }
        onClose={onClose}
        closeOnBackdrop={false}
        size="lg"
      >
        <form onSubmit={handleSubmit}>
          {failure && (
            <ErrorBanner
              message={failure.message}
              code={failure.code}
              onDismiss={() => setFailure(null)}
              className="mb-4 whitespace-pre-line"
            />
          )}

          {removed && (
            <div role="alert" className="mb-4 rounded-xl border border-red-100 bg-red-50 p-3 text-sm text-red-700">
              이 편성 항목은 다른 사람이 삭제했습니다. 저장할 수 없습니다 — 필요하면 닫고 새로 추가하세요.
            </div>
          )}

          {reloaded && !removed && (
            <div className="mb-4 rounded-xl border border-orange-200 bg-orange-50 p-3 text-sm text-orange-800">
              <p className="font-semibold">최신 내용을 다시 불러왔습니다.</p>
              {differences.length === 0 ? (
                <p className="mt-1 text-xs">내 입력과 다른 항목이 없습니다. 그대로 저장하면 됩니다.</p>
              ) : (
                <>
                  <p className="mt-1 text-xs">
                    아래 항목이 서로 다릅니다. 내 입력은 그대로 두었습니다 — 최신 값을 쓰려면 항목별로 선택하세요.
                  </p>
                  <ul className="mt-2 space-y-1.5">
                    {differences.map(({ field, latest }) => (
                      <li
                        key={field.key}
                        className="flex flex-wrap items-center gap-2 rounded-lg bg-surface/70 px-2.5 py-1.5 text-xs"
                      >
                        <span className="font-semibold text-grey-700">{field.label}</span>
                        <span className="text-grey-500">내 입력: {displayValue(field.key, values)}</span>
                        <span className="text-grey-500">최신: {displayValue(field.key, latest)}</span>
                        <button
                          type="button"
                          onClick={() => setField(field.key, latest[field.key])}
                          className="ml-auto rounded-md border border-orange-300 px-2 py-0.5 font-semibold text-orange-800"
                        >
                          최신 값 사용
                        </button>
                      </li>
                    ))}
                  </ul>
                </>
              )}
            </div>
          )}

          <div className="grid gap-4 sm:grid-cols-2">
            <label>
              <span className="text-sm font-medium text-grey-700">
                연차 <span className="text-red-600">*</span>
              </span>
              <select
                value={values.yearId}
                onChange={(e) => setField('yearId', e.target.value)}
                required
                className={INPUT_CLASS}
              >
                {values.yearId === '' && <option value="">연차를 고르세요</option>}
                {sortedYears.map((y) => (
                  <option key={y.id} value={y.id}>
                    {y.name}
                  </option>
                ))}
              </select>
            </label>

            <label>
              <span className="text-sm font-medium text-grey-700">
                종류 <span className="text-red-600">*</span>
              </span>
              <select
                value={values.kind}
                onChange={(e) => setField('kind', e.target.value as AgreementItemKind)}
                required
                className={INPUT_CLASS}
              >
                {AGREEMENT_ITEM_KIND_ORDER.map((kind) => (
                  <option key={kind} value={kind}>
                    {itemKindLabel(kind)}
                  </option>
                ))}
              </select>
            </label>

            <label className="sm:col-span-2">
              <span className="text-sm font-medium text-grey-700">
                품명 <span className="text-red-600">*</span>
              </span>
              <input
                ref={nameRef}
                type="text"
                value={values.name}
                onChange={(e) => setField('name', e.target.value)}
                maxLength={AGREEMENT_ITEM_MAX_LENGTH.name}
                required
                className={INPUT_CLASS}
              />
            </label>

            <label>
              <span className="text-sm font-medium text-grey-700">수량</span>
              <input
                type="number"
                inputMode="decimal"
                min={0}
                step="any"
                value={values.quantity}
                onChange={(e) => setField('quantity', e.target.value)}
                placeholder="비우면 수량 없음"
                className={INPUT_CLASS}
              />
            </label>

            <label>
              <span className="text-sm font-medium text-grey-700">
                금액(원) <span className="text-red-600">*</span>
              </span>
              <input
                type="number"
                inputMode="numeric"
                min={0}
                step={1}
                value={values.amount}
                onChange={(e) => setField('amount', e.target.value)}
                required
                aria-describedby="item-amount-vat-note"
                className={INPUT_CLASS}
              />
              <span id="item-amount-vat-note" className="mt-1 block text-xs text-grey-500">
                {ITEM_AMOUNT_VAT_NOTE}
                {amountPreview !== null && <> · 표시 {amountPreview}</>}
              </span>
            </label>
          </div>

          {!editing && (
            <p className="mt-3 text-xs text-grey-500">
              함께 만들어질 증빙({itemKindLabel(values.kind)}):{' '}
              {defaultEvidence(values.kind)
                .map((check) => check.label)
                .join(' · ')}
            </p>
          )}
          {kindChanged && (
            <p className="mt-3 text-xs text-orange-700">
              종류를 바꿔도 이 항목의 증빙 목록은 그대로입니다 — 필요하면 저장 뒤 [증빙]에서 고치세요.
            </p>
          )}

          <div className="mt-6 flex justify-end gap-2">
            <Button onClick={onClose} disabled={saving}>
              취소
            </Button>
            <Button type="submit" variant="primary" disabled={saving || removed || sortedYears.length === 0}>
              {saving ? '저장 중…' : editing ? '저장' : '추가'}
            </Button>
          </div>
        </form>
      </Modal>

      {conflict && (
        <ConflictDialog
          message={conflict}
          // 다시 가져오면 부모가 최신 행을 내려주고, 위 effect가 비교 패널을 연다
          onReload={() => {
            setConflict(null);
            onReload();
          }}
          onKeepEditing={() => setConflict(null)}
        />
      )}
    </>
  );
}
