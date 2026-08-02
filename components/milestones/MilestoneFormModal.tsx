'use client';

// 마일스톤 생성·편집 모달
// (SOT §7.8, §5.7, §9 createMilestone/updateMilestone, §8.4 O-1·O-3, §8.5 R-4, 부록 A.4)
// 편집: updateMilestone(id, patch, expectedVersion) — 여러 필드를 한 번에 바꾸므로 낙관적 잠금을 건다(O-1).
//       STALE이면 ConflictDialog를 띄우고 입력값은 그대로 둔 채 최신 값과 다른 항목만 비교시킨다(O-3).
// 상태만 바꾸는 조작은 목록의 드롭다운이 담당한다(O-2) — 이 폼은 상세 편집 전용이다.

import { useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import type { Member, Milestone, MilestoneStatus, MilestoneType, Year } from '@/types';
import type { ActionErrorCode } from '@/lib/db/errors';
import { MILESTONE_STATUS_LABELS, MILESTONE_TYPE_LABELS } from '@/lib/constants';
import { createMilestone, updateMilestone } from '@/actions/milestones';
import Modal from '@/components/ui/Modal';
import Button from '@/components/ui/Button';
import ErrorBanner from '@/components/ui/ErrorBanner';
import ConflictDialog from '@/components/ui/ConflictDialog';
import { setRealtimePaused } from '@/components/RealtimeRefresher';

interface FormValues {
  type: MilestoneType;
  title: string;
  date: string; // 'YYYY-MM-DD' (§5.7 필수)
  yearId: string; // '' = 연차 없음(과제 전체 이벤트)
  ownerMemberId: string; // '' = 담당 미지정
  status: MilestoneStatus;
  description: string;
  resultNote: string;
}

interface FieldDef {
  key: keyof FormValues;
  label: string;
}

// 폼과 O-3 비교 패널이 같은 정의를 쓴다 — 한쪽에만 있는 필드가 조용히 덮어써지지 않게
const FIELDS: readonly FieldDef[] = [
  { key: 'type', label: '유형' },
  { key: 'title', label: '제목' },
  { key: 'date', label: '날짜' },
  { key: 'yearId', label: '연차' },
  { key: 'ownerMemberId', label: '담당' },
  { key: 'status', label: '상태' },
  { key: 'description', label: '설명' },
  { key: 'resultNote', label: '결과 메모' },
] as const;

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

// 부록 A.4 나열 순서의 첫 유형을 초기값으로 쓴다 — 국가R&D 일정에서 가장 흔한 항목이다
const DEFAULT_TYPE: MilestoneType = 'annual_eval';

const EMPTY_VALUES: FormValues = {
  type: DEFAULT_TYPE,
  title: '',
  date: '',
  yearId: '',
  ownerMemberId: '',
  status: 'planned', // §5.7 기본값
  description: '',
  resultNote: '',
};

function toValues(milestone: Milestone): FormValues {
  return {
    type: milestone.type,
    title: milestone.title,
    date: milestone.date,
    yearId: milestone.yearId ?? '',
    ownerMemberId: milestone.ownerMemberId ?? '',
    status: milestone.status,
    description: milestone.description,
    resultNote: milestone.resultNote,
  };
}

/** §5.5: name이 있으면 name, 없으면 order+1 + '차년도' */
function yearLabel(year: Year): string {
  return year.name.trim() || `${year.order + 1}차년도`;
}

const INPUT_CLASS =
  'mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm focus:border-slate-500 focus:outline-none';
const SELECT_CLASS =
  'mt-1 w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm focus:border-slate-500 focus:outline-none';

export interface MilestoneFormModalProps {
  mode: 'create' | 'edit';
  projectId: string;
  /** edit 모드 필수. 부모가 서버 데이터를 그대로 내려준다(다시 불러오기 후 최신값이 여기로 온다) */
  milestone?: Milestone;
  years: Year[];
  members: Member[];
  onClose: () => void;
  /** 저장 성공 시 — 부모가 목록을 새로고침한다 */
  onSaved: () => void;
}

export default function MilestoneFormModal({
  mode,
  projectId,
  milestone,
  years,
  members,
  onClose,
  onSaved,
}: MilestoneFormModalProps) {
  const router = useRouter();
  const [values, setValues] = useState<FormValues>(() =>
    milestone ? toValues(milestone) : EMPTY_VALUES
  );
  const [saving, setSaving] = useState(false);
  const [failure, setFailure] = useState<{ message: string; code?: ActionErrorCode } | null>(null);
  const [conflict, setConflict] = useState<string | null>(null);
  // O-3 비교 기준: 마지막으로 받아들인 서버 값. 저장에 쓰는 version도 여기서만 나온다.
  const [baseline, setBaseline] = useState<Milestone | null>(milestone ?? null);
  const [reloaded, setReloaded] = useState(false);

  // R-4: 폼이 열려 있는 동안 자동 새로고침을 보류해 입력 중인 내용을 지키지 않게 한다
  useEffect(() => {
    setRealtimePaused(true);
    return () => setRealtimePaused(false);
  }, []);

  // 다시 불러오기(또는 남의 저장) 후 부모가 최신 값을 내려주면 비교 기준만 갱신한다.
  // 입력값(values)은 건드리지 않는다 — 작업 내용을 날리지 않는 것이 O-3의 핵심이다.
  const baselineVersion = baseline?.version;
  useEffect(() => {
    if (!milestone || milestone.version === baselineVersion) return;
    setBaseline(milestone);
    setConflict(null);
    setReloaded(true);
  }, [milestone, baselineVersion]);

  const titleInputRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    titleInputRef.current?.focus();
  }, []);

  // id는 사용자에게 아무 의미가 없다. 목록에 없는 연차·인력도 값을 숨기지 않고 사실을 드러낸다.
  const yearName = (yearId: string): string => {
    if (yearId === '') return '연차 없음';
    const year = years.find((y) => y.id === yearId);
    return year ? yearLabel(year) : '(삭제된 연차)';
  };

  const memberName = (memberId: string): string => {
    if (memberId === '') return '미지정';
    return members.find((m) => m.id === memberId)?.name ?? '(삭제된 인력)';
  };

  const displayValue = (field: FieldDef, source: FormValues): string => {
    if (field.key === 'type') return MILESTONE_TYPE_LABELS[source.type];
    if (field.key === 'status') return MILESTONE_STATUS_LABELS[source.status];
    if (field.key === 'yearId') return yearName(source.yearId);
    if (field.key === 'ownerMemberId') return memberName(source.ownerMemberId);
    return source[field.key] === '' ? '(비어 있음)' : source[field.key];
  };

  // 최신 서버 값과 내 입력이 다른 항목만 (O-3 비교 UI)
  const differences = useMemo(() => {
    if (!reloaded || !baseline) return [];
    const latest = toValues(baseline);
    return FIELDS.filter((field) => latest[field.key] !== values[field.key]).map((field) => ({
      field,
      latest,
    }));
  }, [reloaded, baseline, values]);

  const setField = <K extends keyof FormValues>(key: K, value: FormValues[K]): void => {
    setValues((prev) => ({ ...prev, [key]: value }));
  };

  // H-5: 연차를 지워도 마일스톤은 남는다. 그대로 저장하면 서버가 "이 과제 연차가 아니다"로 막으므로
  // 무엇을 고쳐야 하는지 미리 알린다.
  const danglingYear = values.yearId !== '' && !years.some((y) => y.id === values.yearId);
  const danglingMember =
    values.ownerMemberId !== '' && !members.some((m) => m.id === values.ownerMemberId);

  const handleSubmit = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault();
    setFailure(null);

    if (values.title.trim() === '') {
      setFailure({ message: '제목을 입력하세요.', code: 'VALIDATION' });
      return;
    }
    // §5.7 date는 필수다 — 날짜 없는 마일스톤은 D-day도 타임라인 위치도 없다
    if (!ISO_DATE.test(values.date)) {
      setFailure({ message: "날짜를 'YYYY-MM-DD' 형식으로 입력하세요.", code: 'VALIDATION' });
      return;
    }

    const payload = {
      type: values.type,
      title: values.title.trim(),
      date: values.date,
      yearId: values.yearId === '' ? null : values.yearId,
      ownerMemberId: values.ownerMemberId === '' ? null : values.ownerMemberId,
      status: values.status,
      description: values.description.trim(),
      resultNote: values.resultNote.trim(),
    };

    if (mode === 'edit' && (!milestone || !baseline)) {
      setFailure({ message: '편집할 마일스톤을 찾을 수 없습니다. 목록을 새로고침하세요.' });
      return;
    }

    setSaving(true);
    try {
      const res =
        mode === 'edit' && milestone && baseline
          ? // O-1: 여러 필드를 한 번에 바꾸므로 마지막으로 읽은 version을 조건으로 건다
            await updateMilestone(milestone.id, payload, baseline.version)
          : await createMilestone(projectId, payload);
      if (!res.ok) {
        // O-3: STALE은 배너가 아니라 선택 다이얼로그로 — 입력을 유지한 채 사용자가 고른다
        if (res.code === 'STALE') setConflict(res.error);
        else setFailure({ message: res.error, code: res.code });
        return;
      }
      onSaved();
    } finally {
      setSaving(false);
    }
  };

  const isEdit = mode === 'edit';

  return (
    <>
      <Modal
        open
        title={isEdit ? '마일스톤 편집' : '마일스톤 추가'}
        description={
          isEdit
            ? '일정과 담당, 결과 메모를 수정합니다.'
            : '유형·제목·날짜만 있으면 등록됩니다. 나머지는 나중에 채워도 됩니다.'
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
              className="mb-4"
            />
          )}

          {reloaded && (
            <div className="mb-4 rounded-xl border border-amber-200 bg-amber-50 p-3 text-sm text-amber-800">
              <p className="font-semibold">최신 내용을 다시 불러왔습니다.</p>
              {differences.length === 0 ? (
                <p className="mt-1 text-xs">
                  내 입력과 다른 항목이 없습니다. 그대로 저장하면 됩니다.
                </p>
              ) : (
                <>
                  <p className="mt-1 text-xs">
                    아래 항목이 서로 다릅니다. 내 입력은 그대로 두었습니다 — 최신 값을 쓰려면
                    항목별로 선택하세요.
                  </p>
                  <ul className="mt-2 space-y-1.5">
                    {differences.map(({ field, latest }) => (
                      <li
                        key={field.key}
                        className="flex flex-wrap items-center gap-2 rounded-lg bg-white/70 px-2.5 py-1.5 text-xs"
                      >
                        <span className="font-semibold text-slate-700">{field.label}</span>
                        <span className="text-slate-500">내 입력: {displayValue(field, values)}</span>
                        <span className="text-slate-500">최신: {displayValue(field, latest)}</span>
                        <button
                          type="button"
                          onClick={() => setField(field.key, latest[field.key])}
                          className="ml-auto rounded-md border border-amber-300 px-2 py-0.5 font-semibold text-amber-800"
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
            <label className="sm:col-span-2">
              <span className="text-sm font-medium text-slate-700">
                제목 <span className="text-red-600">*</span>
              </span>
              <input
                ref={titleInputRef}
                type="text"
                value={values.title}
                onChange={(e) => setField('title', e.target.value)}
                maxLength={200}
                required
                placeholder="예: 1차년도 연차평가"
                className={INPUT_CLASS}
              />
            </label>

            <label>
              <span className="text-sm font-medium text-slate-700">유형</span>
              <select
                value={values.type}
                onChange={(e) => setField('type', e.target.value as MilestoneType)}
                className={SELECT_CLASS}
              >
                {(Object.keys(MILESTONE_TYPE_LABELS) as MilestoneType[]).map((type) => (
                  <option key={type} value={type}>
                    {MILESTONE_TYPE_LABELS[type]}
                  </option>
                ))}
              </select>
            </label>

            <label>
              <span className="text-sm font-medium text-slate-700">
                날짜 <span className="text-red-600">*</span>
              </span>
              <input
                type="date"
                value={values.date}
                onChange={(e) => setField('date', e.target.value)}
                required
                className={INPUT_CLASS}
              />
            </label>

            <label>
              <span className="text-sm font-medium text-slate-700">연차</span>
              <select
                value={values.yearId}
                onChange={(e) => setField('yearId', e.target.value)}
                className={SELECT_CLASS}
              >
                <option value="">연차 없음 (과제 전체 이벤트)</option>
                {years.map((year) => (
                  <option key={year.id} value={year.id}>
                    {yearLabel(year)}
                  </option>
                ))}
                {/* 목록에 없는 연차를 가리키고 있으면 선택값을 조용히 바꾸지 않고 그대로 보인다 */}
                {danglingYear && <option value={values.yearId}>(삭제된 연차)</option>}
              </select>
            </label>

            <label>
              <span className="text-sm font-medium text-slate-700">담당</span>
              <select
                value={values.ownerMemberId}
                onChange={(e) => setField('ownerMemberId', e.target.value)}
                className={SELECT_CLASS}
              >
                <option value="">미지정</option>
                {members.map((member) => (
                  <option key={member.id} value={member.id}>
                    {member.name}
                  </option>
                ))}
                {danglingMember && <option value={values.ownerMemberId}>(삭제된 인력)</option>}
              </select>
            </label>

            <label>
              <span className="text-sm font-medium text-slate-700">상태</span>
              <select
                value={values.status}
                onChange={(e) => setField('status', e.target.value as MilestoneStatus)}
                className={SELECT_CLASS}
              >
                {(Object.keys(MILESTONE_STATUS_LABELS) as MilestoneStatus[]).map((status) => (
                  <option key={status} value={status}>
                    {MILESTONE_STATUS_LABELS[status]}
                  </option>
                ))}
              </select>
            </label>

            <label className="sm:col-span-2">
              <span className="text-sm font-medium text-slate-700">설명</span>
              <textarea
                value={values.description}
                onChange={(e) => setField('description', e.target.value)}
                rows={3}
                maxLength={10000}
                placeholder="준비 사항, 제출 서류 등"
                className={INPUT_CLASS}
              />
            </label>

            <label className="sm:col-span-2">
              <span className="text-sm font-medium text-slate-700">결과 메모</span>
              <textarea
                value={values.resultNote}
                onChange={(e) => setField('resultNote', e.target.value)}
                rows={3}
                maxLength={10000}
                placeholder="평가 결과 / 제출 결과"
                className={INPUT_CLASS}
              />
            </label>
          </div>

          {(danglingYear || danglingMember) && (
            <p className="mt-4 rounded-lg bg-amber-50 p-3 text-xs text-amber-800">
              {danglingYear && '이 마일스톤이 가리키는 연차가 목록에 없습니다. '}
              {danglingMember && '이 마일스톤의 담당 인력이 목록에 없습니다. '}
              다른 사용자가 삭제했을 수 있습니다. 다시 선택하거나 비워야 저장됩니다.
            </p>
          )}

          <div className="mt-6 flex justify-end gap-2">
            <Button size="md" onClick={onClose} disabled={saving}>
              취소
            </Button>
            <Button type="submit" size="md" variant="primary" disabled={saving}>
              {saving ? '저장 중…' : isEdit ? '저장' : '추가'}
            </Button>
          </div>
        </form>
      </Modal>

      {conflict && (
        <ConflictDialog
          message={conflict}
          // 서버 데이터를 다시 가져오면 부모가 최신 milestone을 내려주고, 위 effect가 비교 패널을 연다
          onReload={() => router.refresh()}
          onKeepEditing={() => setConflict(null)}
        />
      )}
    </>
  );
}
