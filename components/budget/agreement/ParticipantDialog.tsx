'use client';

// 참여인원 추가·수정 대화 (SOT §6.19 AG-5, §5.23, §7.9.8 "참여인원 보기", §8.4 O-1·O-3, 계획서 S-11·G-3/Q4b)
//
// 금액 규칙(자동·수동·연봉 모름, G-3 재계산/유지)은 서버 액션이 lib/agreement/participants.ts로 정한다.
// 이 대화는 같은 순수 함수로 "저장하면 이렇게 된다"를 미리 보여 줄 뿐이고, 저장되는 값은 서버 판정이다.
//  - 추가: 연봉 칸은 고른 인력의 연봉으로 채운다. 손대지 않았으면 보내지 않는다 — 서버가 그 시점 연봉을 스냅샷한다
//  - 수정: 바뀐 칸만 patch로 보낸다. 금액 칸을 고치지 않으면 금액을 보내지 않아 직전 구분대로(G-3) 재계산/유지된다
//  - 수정 중 인력을 바꾸면 새 인력의 연봉으로 연봉 칸을 채운다 — 서버는 인력이 바뀌어도 스냅샷을 다시 뜨지 않으므로
//    (T10) 연봉이 달라졌으면 annualSalary로 보내야 한다
//  - STALE은 배너가 아니라 ConflictDialog(O-3) — 입력을 보존하고, 다시 불러오면 최신 값과 다른 칸만 비교·선택한다

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { AgreementParticipant, Settings, Year } from '@/types';
import type { ActionErrorCode } from '@/lib/db/errors';
import type { AgreementMemberOption } from '@/actions/agreement';
import {
  addAgreementParticipant,
  updateAgreementParticipant,
  type AgreementParticipantSaved,
} from '@/actions/agreement-participants';
import {
  PARTICIPANT_ROLE_MAX_LENGTH,
  computeParticipantAmount,
  resolveNewParticipant,
  resolveParticipantEdit,
  type ParticipantFields,
  type ParticipantPatch,
  type ResolvedParticipant,
} from '@/lib/agreement/participants';
import { AGREEMENT_VIEW_TEXT, PARTICIPANT_AMOUNT_KIND_LABELS } from '@/lib/constants';
import { formatAmount } from '@/lib/currency';
import Modal from '@/components/ui/Modal';
import Button from '@/components/ui/Button';
import ErrorBanner from '@/components/ui/ErrorBanner';
import ConflictDialog from '@/components/ui/ConflictDialog';
import { setRealtimePaused } from '@/components/RealtimeRefresher';

/** select의 "인력 미지정" 값. 저장할 때 null로 바꾼다 — 빈 문자열 id는 서버가 거부한다 */
const UNASSIGNED = '';

interface FormValues {
  memberId: string; // UNASSIGNED = 인력 미지정
  yearId: string;
  role: string;
  participationRate: string;
  months: string;
  annualSalary: string; // '' = 연봉 모름
  personnelCash: string; // 추가: '' = 자동 계산 / 수정: 고치지 않으면 G-3
  personnelInKind: string;
}

type FieldKey = keyof FormValues;

const FIELDS: readonly { key: FieldKey; label: string }[] = [
  { key: 'memberId', label: '인력' },
  { key: 'yearId', label: '연차' },
  { key: 'role', label: '역할' },
  { key: 'participationRate', label: '참여율(%)' },
  { key: 'months', label: '참여 개월' },
  { key: 'annualSalary', label: '연봉 스냅샷' },
  { key: 'personnelCash', label: '인건비 현금' },
  { key: 'personnelInKind', label: '인건비 현물' },
] as const;

const INPUT_CLASS =
  'mt-1 w-full rounded-lg border border-grey-300 bg-surface px-3 py-2 text-sm focus:border-grey-500 focus:outline-none';

const numText = (value: number | null): string => (value === null ? '' : String(value));

function toValues(p: AgreementParticipant): FormValues {
  return {
    memberId: p.memberId ?? UNASSIGNED,
    yearId: p.yearId,
    role: p.role,
    participationRate: String(p.participationRate),
    months: String(p.months),
    annualSalary: numText(p.annualSalary),
    personnelCash: String(p.personnelCash),
    personnelInKind: String(p.personnelInKind),
  };
}

function fieldsOf(p: AgreementParticipant): ParticipantFields {
  return {
    memberId: p.memberId,
    yearId: p.yearId,
    participationRate: p.participationRate,
    months: p.months,
    annualSalary: p.annualSalary,
    personnelCash: p.personnelCash,
    personnelInKind: p.personnelInKind,
    role: p.role,
  };
}

interface Parsed {
  memberId: string | null;
  yearId: string;
  role: string;
  participationRate: number;
  months: number;
  annualSalary: number | null;
  /** null = 칸이 비어 있음 */
  personnelCash: number | null;
  personnelInKind: number | null;
}

/** 입력 문자열 → 값. 첫 오류 문장을 돌려준다(서버도 같은 범위를 다시 검사한다) */
function parseValues(v: FormValues): { ok: true; value: Parsed } | { ok: false; error: string } {
  if (v.yearId === '') return { ok: false, error: '연차를 고르세요.' };
  const role = v.role.trim();
  if (role.length > PARTICIPANT_ROLE_MAX_LENGTH) {
    return { ok: false, error: `역할은 ${PARTICIPANT_ROLE_MAX_LENGTH}자 이내여야 합니다.` };
  }
  const rate = Number(v.participationRate.trim());
  if (v.participationRate.trim() === '' || !Number.isFinite(rate) || rate < 0 || rate > 100) {
    return { ok: false, error: '참여율은 0~100% 사이 숫자로 입력하세요.' };
  }
  const months = Number(v.months.trim());
  if (v.months.trim() === '' || !Number.isFinite(months) || months < 0 || months > 12) {
    return { ok: false, error: '참여 개월은 0~12 사이 숫자로 입력하세요.' };
  }
  const won = (text: string, label: string): { ok: true; value: number | null } | { ok: false; error: string } => {
    const t = text.trim();
    if (t === '') return { ok: true, value: null };
    const n = Number(t);
    if (!Number.isSafeInteger(n) || n < 0) return { ok: false, error: `${label}은 0 이상의 원 단위 정수로 입력하세요.` };
    return { ok: true, value: n };
  };
  const salary = won(v.annualSalary, '연봉');
  if (!salary.ok) return salary;
  const cash = won(v.personnelCash, '인건비 현금');
  if (!cash.ok) return cash;
  const inKind = won(v.personnelInKind, '인건비 현물');
  if (!inKind.ok) return inKind;
  return {
    ok: true,
    value: {
      memberId: v.memberId === UNASSIGNED ? null : v.memberId,
      yearId: v.yearId,
      role,
      participationRate: rate,
      months,
      annualSalary: salary.value,
      personnelCash: cash.value,
      personnelInKind: inKind.value,
    },
  };
}

/** 추가 입력. 연봉 칸이 고른 인력의 연봉 그대로면 보내지 않는다 — 서버가 그 시점 연봉을 스냅샷한다(S-11) */
function buildAddInput(p: Parsed, memberSalary: number | null) {
  const salaryUntouched = p.annualSalary === memberSalary;
  return {
    memberId: p.memberId,
    yearId: p.yearId,
    participationRate: p.participationRate,
    months: p.months,
    role: p.role,
    ...(salaryUntouched ? {} : { annualSalary: p.annualSalary }),
    ...(p.personnelCash !== null ? { personnelCash: p.personnelCash } : {}),
    ...(p.personnelInKind !== null ? { personnelInKind: p.personnelInKind } : {}),
  };
}

/**
 * 수정 patch — 최신 서버 값(base)과 다른 칸만. 금액은 두 칸 중 하나라도 바뀌었을 때만 보낸다(그러면 수동, G-3).
 * 두 칸을 모두 비우면 "자동으로 되돌리기" — 새 값의 계산값을 직전 축(0 아닌 쪽, 둘 다 0이면 현금)에 넣어 보낸다.
 * 연봉 모름이면 계산값이 없으니 0·0이다.
 */
function buildPatch(base: AgreementParticipant, p: Parsed): ParticipantPatch {
  const patch: ParticipantPatch = {};
  if (p.memberId !== base.memberId) patch.memberId = p.memberId;
  if (p.yearId !== base.yearId) patch.yearId = p.yearId;
  if (p.role !== base.role) patch.role = p.role;
  if (p.participationRate !== base.participationRate) patch.participationRate = p.participationRate;
  if (p.months !== base.months) patch.months = p.months;
  if (p.annualSalary !== base.annualSalary) patch.annualSalary = p.annualSalary;

  if (p.personnelCash === null && p.personnelInKind === null) {
    const computed =
      computeParticipantAmount({
        participationRate: p.participationRate,
        months: p.months,
        annualSalary: p.annualSalary,
      }) ?? 0;
    const toInKind = base.personnelInKind !== 0 && base.personnelCash === 0;
    const cash = toInKind ? 0 : computed;
    const inKind = toInKind ? computed : 0;
    if (cash !== base.personnelCash || inKind !== base.personnelInKind) {
      patch.personnelCash = cash;
      patch.personnelInKind = inKind;
    }
  } else {
    const cash = p.personnelCash ?? 0;
    const inKind = p.personnelInKind ?? 0;
    if (cash !== base.personnelCash || inKind !== base.personnelInKind) {
      patch.personnelCash = cash;
      patch.personnelInKind = inKind;
    }
  }
  return patch;
}

const AMOUNT_RULE_TEXT: Record<ResolvedParticipant['amountRule'], string> = {
  explicit: '적은 금액 그대로(수동)',
  recalculated: '계산값으로 채움',
  kept: '직전 금액 유지',
};

export interface ParticipantDialogProps {
  versionId: string;
  /** null = 추가. 수정이면 부모가 최신 서버 행을 내려준다 — 다시 불러오기 후 최신 값이 여기로 온다 */
  participant: AgreementParticipant | null;
  /** 수정 중 그 행이 다른 사람에 의해 지워졌으면 true — 저장을 막고 알린다 */
  removed?: boolean;
  members: AgreementMemberOption[];
  years: Year[];
  currencyUnit: Settings['currencyUnit'];
  onClose: () => void;
  /** 저장 성공 — 부모가 새로 불러오고 안내를 띄운다 */
  onSaved: (saved: AgreementParticipantSaved) => void;
  /** O-3 [다시 불러오기] — 부모가 서버 값을 새로 받는다 */
  onReload: () => void;
}

export default function ParticipantDialog({
  versionId,
  participant,
  removed = false,
  members,
  years,
  currencyUnit,
  onClose,
  onSaved,
  onReload,
}: ParticipantDialogProps) {
  const memberById = useMemo(() => new Map(members.map((m) => [m.id, m])), [members]);
  const sortedYears = useMemo(() => [...years].sort((a, b) => a.order - b.order), [years]);

  const [values, setValues] = useState<FormValues>(() => {
    if (participant !== null) return toValues(participant);
    const first = members[0];
    return {
      memberId: first?.id ?? UNASSIGNED,
      yearId: sortedYears[0]?.id ?? '',
      role: '',
      participationRate: '',
      months: '12',
      annualSalary: numText(first?.annualSalary ?? null),
      personnelCash: '',
      personnelInKind: '',
    };
  });
  const [saving, setSaving] = useState(false);
  const [failure, setFailure] = useState<{ message: string; code?: ActionErrorCode } | null>(null);
  const [conflict, setConflict] = useState<string | null>(null);
  // O-3 비교 기준: 마지막으로 받아들인 서버 행. patch와 expectedVersion은 여기서만 나온다
  const [baseline, setBaseline] = useState<AgreementParticipant | null>(participant);
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
    if (participant === null || participant.version === baselineVersion) return;
    setBaseline(participant);
    setConflict(null);
    setReloaded(true);
  }, [participant, baselineVersion]);

  const roleRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    roleRef.current?.focus();
  }, []);

  const setField = <K extends FieldKey>(key: K, value: FormValues[K]): void => {
    setValues((prev) => ({ ...prev, [key]: value }));
  };

  const salaryOf = useCallback(
    (memberId: string | null): number | null =>
      memberId === null || memberId === UNASSIGNED ? null : (memberById.get(memberId)?.annualSalary ?? null),
    [memberById]
  );

  const changeMember = (memberId: string): void => {
    // 인력을 바꾸면 연봉 칸도 새 인력의 연봉으로 — 이전 인력의 연봉이 남아 다른 사람 인건비로 계산되지 않게
    setValues((prev) => ({ ...prev, memberId, annualSalary: numText(salaryOf(memberId)) }));
  };

  const memberLabel = (id: string): string =>
    id === UNASSIGNED ? AGREEMENT_VIEW_TEXT.unassignedMember : (memberById.get(id)?.name ?? '(목록에 없는 인력)');
  const yearLabel = (id: string): string => sortedYears.find((y) => y.id === id)?.name ?? '(목록에 없는 연차)';

  const displayValue = (key: FieldKey, source: FormValues): string => {
    if (key === 'memberId') return memberLabel(source.memberId);
    if (key === 'yearId') return yearLabel(source.yearId);
    if (key === 'annualSalary' && source.annualSalary.trim() === '') return PARTICIPANT_AMOUNT_KIND_LABELS.salary_unknown;
    const raw = source[key].trim();
    if (raw === '') return '(비어 있음)';
    if (key === 'annualSalary' || key === 'personnelCash' || key === 'personnelInKind') {
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

  // 미리보기 — 서버와 같은 순수 함수. 입력이 아직 틀렸으면 미리보기 대신 이유를 보인다
  const preview = useMemo((): { resolved: ResolvedParticipant; computed: number | null } | { error: string } => {
    const parsed = parseValues(values);
    if (!parsed.ok) return { error: parsed.error };
    const p = parsed.value;
    try {
      const memberSalary = salaryOf(p.memberId);
      const resolved =
        baseline === null
          ? resolveNewParticipant(buildAddInput(p, memberSalary), memberSalary)
          : resolveParticipantEdit(fieldsOf(baseline), buildPatch(baseline, p));
      return { resolved, computed: computeParticipantAmount(resolved.values) };
    } catch (e) {
      return { error: e instanceof Error ? e.message : String(e) };
    }
  }, [values, baseline, salaryOf]);

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
        res = await addAgreementParticipant(versionId, buildAddInput(p, salaryOf(p.memberId)));
      } else {
        const patch = buildPatch(baseline, p);
        if (Object.keys(patch).length === 0) {
          onClose();
          return;
        }
        // O-1: 마지막으로 받아들인 서버 행의 version을 조건으로 건다
        res = await updateAgreementParticipant(baseline.id, patch, baseline.version);
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
      setFailure({ message: `참여인원을 저장하지 못했습니다: ${err instanceof Error ? err.message : String(err)}` });
    } finally {
      setSaving(false);
    }
  };

  const money = (won: number | null): string => (won === null ? '—' : formatAmount(won, currencyUnit));

  return (
    <>
      <Modal
        open
        title={editing ? '참여인원 수정' : '참여인원 추가'}
        description={
          editing
            ? '바꾼 칸만 저장합니다. 금액 칸을 그대로 두면 자동 행은 다시 계산되고 수동 행은 금액이 유지됩니다.'
            : '연봉은 고른 인력의 연봉으로 채워집니다. 금액 칸을 비우면 계산값이 현금으로 들어갑니다.'
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
              이 참여인원 행은 다른 사람이 삭제했습니다. 저장할 수 없습니다 — 필요하면 닫고 새로 추가하세요.
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
              <span className="text-sm font-medium text-grey-700">인력</span>
              <select value={values.memberId} onChange={(e) => changeMember(e.target.value)} className={INPUT_CLASS}>
                {members.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.name}
                  </option>
                ))}
                <option value={UNASSIGNED}>{AGREEMENT_VIEW_TEXT.unassignedMember}</option>
              </select>
            </label>

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

            <label className="sm:col-span-2">
              <span className="text-sm font-medium text-grey-700">역할</span>
              <input
                ref={roleRef}
                type="text"
                value={values.role}
                onChange={(e) => setField('role', e.target.value)}
                maxLength={PARTICIPANT_ROLE_MAX_LENGTH}
                placeholder="예: 연구책임자"
                className={INPUT_CLASS}
              />
            </label>

            <label>
              <span className="text-sm font-medium text-grey-700">
                참여율(%) <span className="text-red-600">*</span>
              </span>
              <input
                type="number"
                inputMode="decimal"
                min={0}
                max={100}
                step="any"
                value={values.participationRate}
                onChange={(e) => setField('participationRate', e.target.value)}
                required
                className={INPUT_CLASS}
              />
            </label>

            <label>
              <span className="text-sm font-medium text-grey-700">
                참여 개월 <span className="text-red-600">*</span>
              </span>
              <input
                type="number"
                inputMode="decimal"
                min={0}
                max={12}
                step="any"
                value={values.months}
                onChange={(e) => setField('months', e.target.value)}
                required
                className={INPUT_CLASS}
              />
            </label>

            <label className="sm:col-span-2">
              <span className="text-sm font-medium text-grey-700">연봉 스냅샷(원)</span>
              <input
                type="number"
                inputMode="numeric"
                min={0}
                step={1}
                value={values.annualSalary}
                onChange={(e) => setField('annualSalary', e.target.value)}
                placeholder={`비우면 ${PARTICIPANT_AMOUNT_KIND_LABELS.salary_unknown}`}
                className={INPUT_CLASS}
              />
              <span className="mt-1 block text-xs text-grey-500">
                이 행에만 쓰는 값입니다 — 인력 정보의 연봉을 나중에 바꿔도 이 값은 그대로입니다.
              </span>
            </label>

            <label>
              <span className="text-sm font-medium text-grey-700">인건비 현금(원)</span>
              <input
                type="number"
                inputMode="numeric"
                min={0}
                step={1}
                value={values.personnelCash}
                onChange={(e) => setField('personnelCash', e.target.value)}
                placeholder="비우면 자동 계산"
                className={INPUT_CLASS}
              />
            </label>

            <label>
              <span className="text-sm font-medium text-grey-700">인건비 현물(원)</span>
              <input
                type="number"
                inputMode="numeric"
                min={0}
                step={1}
                value={values.personnelInKind}
                onChange={(e) => setField('personnelInKind', e.target.value)}
                placeholder="비우면 자동 계산"
                className={INPUT_CLASS}
              />
            </label>
          </div>

          <p className="mt-2 text-xs text-grey-500">
            금액을 적으면 {PARTICIPANT_AMOUNT_KIND_LABELS.manual}입니다. 두 칸을 모두 비우면 계산값(연봉 × 참여율 ×
            개월/12)이 {editing ? '직전에 쓰던 쪽(없으면 현금)' : '현금'}으로 들어갑니다.
          </p>

          <div className="mt-4 rounded-xl border border-grey-200 bg-grey-50 p-3 text-xs text-grey-700" aria-live="polite">
            <p className="font-semibold text-grey-800">저장하면</p>
            {'error' in preview ? (
              <p className="mt-1 text-grey-500">{preview.error}</p>
            ) : (
              <dl className="mt-1 grid grid-cols-2 gap-x-4 gap-y-0.5 sm:grid-cols-4">
                <dt className="text-grey-500">계산값</dt>
                <dd className="tabular-nums">
                  {preview.computed === null ? `없음(${PARTICIPANT_AMOUNT_KIND_LABELS.salary_unknown})` : money(preview.computed)}
                </dd>
                <dt className="text-grey-500">구분</dt>
                <dd>{PARTICIPANT_AMOUNT_KIND_LABELS[preview.resolved.kind]}</dd>
                <dt className="text-grey-500">현금</dt>
                <dd className="tabular-nums">{money(preview.resolved.values.personnelCash)}</dd>
                <dt className="text-grey-500">현물</dt>
                <dd className="tabular-nums">{money(preview.resolved.values.personnelInKind)}</dd>
                <dt className="text-grey-500">금액</dt>
                <dd className="sm:col-span-3">{AMOUNT_RULE_TEXT[preview.resolved.amountRule]}</dd>
              </dl>
            )}
          </div>

          <div className="mt-6 flex justify-end gap-2">
            <Button onClick={onClose} disabled={saving}>
              취소
            </Button>
            <Button type="submit" variant="primary" disabled={saving || removed}>
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
