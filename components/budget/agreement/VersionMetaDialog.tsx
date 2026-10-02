'use client';

// [버전 정보] — 협약 예산 버전 메타 7개 편집 (SOT §7.9.8, §5.21 AV-2·AV-5, §8.4 O-1·O-3, 계획서 S-3·S-17)
// 확정 버전에서도 열린다 — 잠기는 것은 내용(금액 줄·참여인원·편성 항목)이고 메타는 기록용 부가정보다(AV-2).
// 여러 필드를 한 번에 바꾸므로 expectedVersion을 건다(O-1). STALE이면 ConflictDialog를 띄우고,
// 입력값은 그대로 둔 채 최신 값과 다른 항목만 비교시킨다(O-3 — MilestoneFormModal과 같은 방식).
// 공문 번호·IRIS 승인일 칸은 두지 않는다(U-2·Q3).

import { useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import type { AgreementNoticeType, AgreementVersion, AgreementVersionKind } from '@/types';
import type { ActionErrorCode } from '@/lib/db/errors';
import {
  AGREEMENT_NOTICE_TYPE_LABELS,
  AGREEMENT_VERSION_KIND_LABELS,
  AGREEMENT_VERSION_KIND_ORDER,
  AGREEMENT_VERSION_STATUS_LABELS,
} from '@/lib/constants';
import { updateAgreementVersionMeta } from '@/actions/agreement';
import Modal from '@/components/ui/Modal';
import Button from '@/components/ui/Button';
import ErrorBanner from '@/components/ui/ErrorBanner';
import ConflictDialog from '@/components/ui/ConflictDialog';
import { setRealtimePaused } from '@/components/RealtimeRefresher';

interface FormValues {
  kind: AgreementVersionKind;
  name: string;
  baseDate: string; // '' = 없음
  changeReason: string;
  noticeType: AgreementNoticeType | ''; // '' = 미지정
  irisRequestedAt: string; // '' = 없음
  note: string;
}

interface FieldDef {
  key: keyof FormValues;
  label: string;
}

// 폼과 O-3 비교 패널이 같은 정의를 쓴다 — 한쪽에만 있는 필드가 조용히 덮어써지지 않게
const FIELDS: readonly FieldDef[] = [
  { key: 'kind', label: '종류' },
  { key: 'name', label: '이름' },
  { key: 'baseDate', label: '기준일' },
  { key: 'changeReason', label: '변경 사유' },
  { key: 'noticeType', label: '통보/승인' },
  { key: 'irisRequestedAt', label: 'IRIS 신청일' },
  { key: 'note', label: '비고' },
] as const;

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

const NOTICE_TYPES = Object.keys(AGREEMENT_NOTICE_TYPE_LABELS) as AgreementNoticeType[];

function toValues(v: AgreementVersion): FormValues {
  return {
    kind: v.kind,
    name: v.name,
    baseDate: v.baseDate ?? '',
    changeReason: v.changeReason,
    noticeType: v.noticeType ?? '',
    irisRequestedAt: v.irisRequestedAt ?? '',
    note: v.note,
  };
}

const INPUT_CLASS =
  'mt-1 w-full rounded-lg border border-grey-300 bg-surface px-3 py-2 text-sm focus:border-grey-500 focus:outline-none';

export interface VersionMetaDialogProps {
  /** 부모가 서버 데이터를 그대로 내려준다 — 다시 불러오기 후 최신 값이 여기로 온다 */
  version: AgreementVersion;
  onClose: () => void;
  /** 저장 성공 — 부모가 router.refresh()한다 */
  onSaved: () => void;
}

export default function VersionMetaDialog({ version, onClose, onSaved }: VersionMetaDialogProps) {
  const router = useRouter();
  const [values, setValues] = useState<FormValues>(() => toValues(version));
  const [saving, setSaving] = useState(false);
  const [failure, setFailure] = useState<{ message: string; code?: ActionErrorCode } | null>(null);
  const [conflict, setConflict] = useState<string | null>(null);
  // O-3 비교 기준: 마지막으로 받아들인 서버 값. 저장에 쓰는 version도 여기서만 나온다
  const [baseline, setBaseline] = useState<AgreementVersion>(version);
  const [reloaded, setReloaded] = useState(false);

  // R-4: 대화가 열린 동안 자동 새로고침을 보류해 입력 중인 내용을 지킨다
  useEffect(() => {
    setRealtimePaused(true);
    return () => setRealtimePaused(false);
  }, []);

  // 다시 불러오기 후 부모가 최신 값을 내려주면 비교 기준만 갱신한다. 입력값은 건드리지 않는다(O-3)
  const baselineVersion = baseline.version;
  useEffect(() => {
    if (version.version === baselineVersion) return;
    setBaseline(version);
    setConflict(null);
    setReloaded(true);
  }, [version, baselineVersion]);

  const nameRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    nameRef.current?.focus();
  }, []);

  const displayValue = (field: FieldDef, source: FormValues): string => {
    if (field.key === 'kind') return AGREEMENT_VERSION_KIND_LABELS[source.kind];
    if (field.key === 'noticeType') {
      return source.noticeType === '' ? '미지정' : AGREEMENT_NOTICE_TYPE_LABELS[source.noticeType];
    }
    return source[field.key] === '' ? '(비어 있음)' : source[field.key];
  };

  const differences = useMemo(() => {
    if (!reloaded) return [];
    const latest = toValues(baseline);
    return FIELDS.filter((field) => latest[field.key] !== values[field.key]).map((field) => ({
      field,
      latest,
    }));
  }, [reloaded, baseline, values]);

  const setField = <K extends keyof FormValues>(key: K, value: FormValues[K]): void => {
    setValues((prev) => ({ ...prev, [key]: value }));
  };

  const handleSubmit = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault();
    setFailure(null);

    if (values.name.trim() === '') {
      setFailure({ message: '버전 이름을 입력하세요.', code: 'VALIDATION' });
      return;
    }
    for (const key of ['baseDate', 'irisRequestedAt'] as const) {
      if (values[key] !== '' && !ISO_DATE.test(values[key])) {
        const label = FIELDS.find((f) => f.key === key)?.label ?? key;
        setFailure({ message: `${label}을 'YYYY-MM-DD' 형식으로 입력하세요.`, code: 'VALIDATION' });
        return;
      }
    }

    const patch = {
      kind: values.kind,
      name: values.name.trim(),
      baseDate: values.baseDate === '' ? null : values.baseDate,
      changeReason: values.changeReason.trim(),
      noticeType: values.noticeType === '' ? null : values.noticeType,
      irisRequestedAt: values.irisRequestedAt === '' ? null : values.irisRequestedAt,
      note: values.note.trim(),
    };

    setSaving(true);
    try {
      // O-1: 마지막으로 받아들인 서버 값의 version을 조건으로 건다
      const res = await updateAgreementVersionMeta(version.id, patch, baseline.version);
      if (!res.ok) {
        // O-3: STALE은 배너가 아니라 선택 대화로 — 입력을 유지한 채 사용자가 고른다
        if (res.code === 'STALE') setConflict(res.error);
        else setFailure({ message: res.error, code: res.code });
        return;
      }
      onSaved();
    } finally {
      setSaving(false);
    }
  };

  const confirmed = baseline.status === 'confirmed';

  return (
    <>
      <Modal
        open
        title="버전 정보"
        description={
          confirmed
            ? `${AGREEMENT_VERSION_STATUS_LABELS.confirmed} 버전입니다. 금액 등 내용은 잠겨 있지만 아래 정보는 고칠 수 있습니다.`
            : '버전의 종류·이름과 협약 관련 기록을 고칩니다.'
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

          {reloaded && (
            <div className="mb-4 rounded-xl border border-orange-200 bg-orange-50 p-3 text-sm text-orange-800">
              <p className="font-semibold">최신 내용을 다시 불러왔습니다.</p>
              {differences.length === 0 ? (
                <p className="mt-1 text-xs">내 입력과 다른 항목이 없습니다. 그대로 저장하면 됩니다.</p>
              ) : (
                <>
                  <p className="mt-1 text-xs">
                    아래 항목이 서로 다릅니다. 내 입력은 그대로 두었습니다 — 최신 값을 쓰려면 항목별로
                    선택하세요.
                  </p>
                  <ul className="mt-2 space-y-1.5">
                    {differences.map(({ field, latest }) => (
                      <li
                        key={field.key}
                        className="flex flex-wrap items-center gap-2 rounded-lg bg-surface/70 px-2.5 py-1.5 text-xs"
                      >
                        <span className="font-semibold text-grey-700">{field.label}</span>
                        <span className="text-grey-500">내 입력: {displayValue(field, values)}</span>
                        <span className="text-grey-500">최신: {displayValue(field, latest)}</span>
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
              <span className="text-sm font-medium text-grey-700">종류</span>
              <select
                value={values.kind}
                onChange={(e) => setField('kind', e.target.value as AgreementVersionKind)}
                className={INPUT_CLASS}
              >
                {AGREEMENT_VERSION_KIND_ORDER.map((k) => (
                  <option key={k} value={k}>
                    {AGREEMENT_VERSION_KIND_LABELS[k]}
                  </option>
                ))}
              </select>
            </label>

            <label>
              <span className="text-sm font-medium text-grey-700">
                이름 <span className="text-red-600">*</span>
              </span>
              <input
                ref={nameRef}
                type="text"
                value={values.name}
                onChange={(e) => setField('name', e.target.value)}
                maxLength={100}
                required
                className={INPUT_CLASS}
              />
            </label>

            <label>
              <span className="text-sm font-medium text-grey-700">기준일</span>
              <input
                type="date"
                value={values.baseDate}
                onChange={(e) => setField('baseDate', e.target.value)}
                className={INPUT_CLASS}
              />
            </label>

            <label>
              <span className="text-sm font-medium text-grey-700">통보/승인</span>
              <select
                value={values.noticeType}
                onChange={(e) => setField('noticeType', e.target.value as AgreementNoticeType | '')}
                className={INPUT_CLASS}
              >
                <option value="">미지정</option>
                {NOTICE_TYPES.map((t) => (
                  <option key={t} value={t}>
                    {AGREEMENT_NOTICE_TYPE_LABELS[t]}
                  </option>
                ))}
              </select>
            </label>

            <label>
              <span className="text-sm font-medium text-grey-700">IRIS 신청일</span>
              <input
                type="date"
                value={values.irisRequestedAt}
                onChange={(e) => setField('irisRequestedAt', e.target.value)}
                className={INPUT_CLASS}
              />
            </label>

            <label className="sm:col-span-2">
              <span className="text-sm font-medium text-grey-700">변경 사유</span>
              <textarea
                value={values.changeReason}
                onChange={(e) => setField('changeReason', e.target.value)}
                rows={3}
                maxLength={2000}
                className={INPUT_CLASS}
              />
            </label>

            <label className="sm:col-span-2">
              <span className="text-sm font-medium text-grey-700">비고</span>
              <textarea
                value={values.note}
                onChange={(e) => setField('note', e.target.value)}
                rows={3}
                maxLength={10000}
                className={INPUT_CLASS}
              />
            </label>
          </div>

          <p className="mt-3 text-xs text-grey-500">
            종류를 바꾸면 이 버전을 기준으로 삼는 다른 버전의 기준 버전 표시가 바로 바뀝니다.
          </p>

          <div className="mt-6 flex justify-end gap-2">
            <Button onClick={onClose} disabled={saving}>
              취소
            </Button>
            <Button type="submit" variant="primary" disabled={saving}>
              {saving ? '저장 중…' : '저장'}
            </Button>
          </div>
        </form>
      </Modal>

      {conflict && (
        <ConflictDialog
          message={conflict}
          // 다시 가져오면 부모가 최신 version을 내려주고, 위 effect가 비교 패널을 연다
          onReload={() => router.refresh()}
          onKeepEditing={() => setConflict(null)}
        />
      )}
    </>
  );
}
