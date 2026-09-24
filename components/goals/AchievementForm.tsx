'use client';

// 성과 실적 추가·편집 인라인 폼 (SOT §7.7 탭 1 "실적 추가", §5.8, §9 addAchievement/updateAchievement)
// 연차(yearId)는 비워둘 수 있다 — D-4에 따라 연차별 집계에서만 빠지고 전체 집계에는 들어간다.
// 그래서 "연차 미지정"을 선택지로 드러내고 폼이 임의로 연차를 채우지 않는다.
// O-1: 실적 편집은 제목·날짜·연차·기관·참여자·증빙·비고를 한 번에 바꾸므로 낙관적 잠금을 건다.
//      마지막으로 받아들인 서버 값(baseline)의 version을 expectedVersion으로 넘긴다(§5.8, §8.4).
//      STALE이면 ConflictDialog를 띄우고 입력값은 그대로 둔 채 최신 값과 다른 항목만 비교시킨다(O-3).

import { useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import type { DeliverableAchievement, Member, Organization, Year } from '@/types';
import type { ActionErrorCode } from '@/lib/db/errors';
import { addAchievement, updateAchievement } from '@/actions/goals';
import Button from '@/components/ui/Button';
import ErrorBanner from '@/components/ui/ErrorBanner';
import ConflictDialog from '@/components/ui/ConflictDialog';
import { setRealtimePaused } from '@/components/RealtimeRefresher';

interface FormValues {
  title: string;
  date: string;
  yearId: string; // '' = 연차 미지정 (D-4)
  orgId: string; // '' = 기관 미지정
  memberIds: string[];
  evidenceUrl: string;
  note: string;
}

type FieldKey = keyof FormValues;

// 폼과 O-3 비교 패널이 같은 정의를 쓴다 — 한쪽에만 있는 필드가 조용히 덮어써지지 않게
const FIELDS: readonly { key: FieldKey; label: string }[] = [
  { key: 'title', label: '산출물명' },
  { key: 'date', label: '달성일' },
  { key: 'yearId', label: '연차' },
  { key: 'orgId', label: '기관' },
  { key: 'memberIds', label: '참여자' },
  { key: 'evidenceUrl', label: '증빙 링크' },
  { key: 'note', label: '비고' },
] as const;

const EMPTY_VALUES: FormValues = {
  title: '',
  date: '',
  yearId: '',
  orgId: '',
  memberIds: [],
  evidenceUrl: '',
  note: '',
};

function toValues(achievement: DeliverableAchievement): FormValues {
  return {
    title: achievement.title,
    date: achievement.date,
    yearId: achievement.yearId ?? '',
    orgId: achievement.orgId ?? '',
    memberIds: [...achievement.memberIds],
    evidenceUrl: achievement.evidenceUrl,
    note: achievement.note,
  };
}

function sameMemberIds(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  const set = new Set(a);
  return b.every((id) => set.has(id));
}

export interface AchievementFormProps {
  deliverableId: string;
  mode: 'create' | 'edit';
  /** edit 모드 필수. 부모가 서버 데이터를 그대로 내려준다 */
  achievement?: DeliverableAchievement;
  years: Year[];
  organizations: Organization[];
  members: Member[];
  onCancel: () => void;
  /** 저장 성공 시 — 부모가 목록을 새로고침한다 */
  onSaved: () => void;
}

export default function AchievementForm({
  deliverableId,
  mode,
  achievement,
  years,
  organizations,
  members,
  onCancel,
  onSaved,
}: AchievementFormProps) {
  const router = useRouter();
  const [values, setValues] = useState<FormValues>(() =>
    achievement ? toValues(achievement) : EMPTY_VALUES
  );
  const [saving, setSaving] = useState(false);
  const [failure, setFailure] = useState<{ message: string; code?: ActionErrorCode } | null>(null);
  const [conflict, setConflict] = useState<string | null>(null);
  // O-3 비교 기준: 마지막으로 받아들인 서버 값. 저장에 쓰는 version도 여기서만 나온다.
  const [baseline, setBaseline] = useState<DeliverableAchievement | null>(achievement ?? null);
  const [reloaded, setReloaded] = useState(false);

  // R-4: 폼이 열려 있는 동안 자동 새로고침을 보류해 입력 중인 내용을 지킨다
  useEffect(() => {
    setRealtimePaused(true);
    return () => setRealtimePaused(false);
  }, []);

  // 다시 불러오기(또는 남의 저장) 후 부모가 최신 실적을 내려주면 비교 기준만 갱신한다.
  // 입력값(values)은 건드리지 않는다(O-3) — 새 version이 다음 저장의 expectedVersion이 된다.
  const baselineVersion = baseline?.version;
  useEffect(() => {
    if (!achievement || achievement.version === baselineVersion) return;
    setBaseline(achievement);
    setConflict(null);
    setReloaded(true);
  }, [achievement, baselineVersion]);

  const titleInputRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    titleInputRef.current?.focus();
  }, []);

  // id는 사용자에게 아무 의미가 없다. 목록에 없는 참조도 값을 숨기지 않고 사실을 드러낸다.
  const yearLabel = (yearId: string): string => {
    if (yearId === '') return '연차 미지정';
    return years.find((year) => year.id === yearId)?.name ?? '(삭제된 연차)';
  };

  const orgLabel = (orgId: string): string => {
    if (orgId === '') return '기관 미지정';
    return organizations.find((org) => org.id === orgId)?.name ?? '(삭제된 기관)';
  };

  const memberLabel = (memberIds: readonly string[]): string => {
    if (memberIds.length === 0) return '(없음)';
    return memberIds
      .map((id) => members.find((member) => member.id === id)?.name ?? '(삭제된 인력)')
      .join(', ');
  };

  const displayValue = (key: FieldKey, source: FormValues): string => {
    if (key === 'yearId') return yearLabel(source.yearId);
    if (key === 'orgId') return orgLabel(source.orgId);
    if (key === 'memberIds') return memberLabel(source.memberIds);
    return source[key] === '' ? '(비어 있음)' : source[key];
  };

  // 최신 서버 값과 내 입력이 다른 항목만 (O-3 비교 UI)
  const differences = useMemo(() => {
    if (!reloaded || !baseline) return [];
    const latest = toValues(baseline);
    return FIELDS.filter((field) =>
      field.key === 'memberIds'
        ? !sameMemberIds(latest.memberIds, values.memberIds)
        : latest[field.key] !== values[field.key]
    ).map((field) => ({ field, latest }));
  }, [reloaded, baseline, values]);

  const setField = <K extends FieldKey>(key: K, value: FormValues[K]): void => {
    setValues((prev) => ({ ...prev, [key]: value }));
  };

  const toggleMember = (memberId: string): void => {
    setValues((prev) => ({
      ...prev,
      memberIds: prev.memberIds.includes(memberId)
        ? prev.memberIds.filter((id) => id !== memberId)
        : [...prev.memberIds, memberId],
    }));
  };

  const handleSubmit = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault();
    setFailure(null);

    if (values.title.trim() === '') {
      setFailure({ message: '산출물명을 입력하세요.', code: 'VALIDATION' });
      return;
    }
    if (values.date === '') {
      setFailure({ message: '달성일을 입력하세요.', code: 'VALIDATION' });
      return;
    }

    const payload = {
      title: values.title.trim(),
      date: values.date,
      yearId: values.yearId === '' ? null : values.yearId,
      orgId: values.orgId === '' ? null : values.orgId,
      memberIds: values.memberIds,
      evidenceUrl: values.evidenceUrl.trim(),
      note: values.note,
    };

    if (mode === 'edit' && (!achievement || !baseline)) {
      setFailure({ message: '편집할 실적을 찾을 수 없습니다. 목록을 새로고침하세요.' });
      return;
    }

    setSaving(true);
    try {
      const res =
        mode === 'edit' && achievement && baseline
          ? // O-1: 여러 필드를 한 번에 바꾸므로 마지막으로 읽은 version을 조건으로 건다
            await updateAchievement(deliverableId, achievement.id, payload, baseline.version)
          : await addAchievement(deliverableId, payload);
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

  const inputClass =
    'mt-1 w-full rounded-lg border border-grey-300 px-3 py-2 text-sm focus:border-grey-500 focus:outline-none';

  return (
    <>
      <form
        onSubmit={handleSubmit}
        className="rounded-xl border border-grey-200 bg-surface p-4"
        aria-label={mode === 'edit' ? '실적 편집' : '실적 추가'}
      >
        <p className="text-sm font-semibold text-grey-800">
          {mode === 'edit' ? '실적 편집' : '실적 추가'}
        </p>

        {failure && (
          <ErrorBanner
            message={failure.message}
            code={failure.code}
            onDismiss={() => setFailure(null)}
            className="mt-3"
          />
        )}

        {reloaded && (
          <div className="mt-3 rounded-xl border border-orange-200 bg-orange-50 p-3 text-sm text-orange-800">
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
                      <span className="text-grey-500">
                        내 입력: {displayValue(field.key, values)}
                      </span>
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

        <div className="mt-3 grid gap-3 sm:grid-cols-2">
          <label className="sm:col-span-2">
            <span className="text-sm font-medium text-grey-700">
              산출물명 <span className="text-red-600">*</span>
            </span>
            <input
              ref={titleInputRef}
              type="text"
              value={values.title}
              onChange={(e) => setField('title', e.target.value)}
              maxLength={300}
              required
              placeholder="예: 논문 제목, 특허명"
              className={inputClass}
            />
          </label>

          <label>
            <span className="text-sm font-medium text-grey-700">
              달성일 <span className="text-red-600">*</span>
            </span>
            <input
              type="date"
              value={values.date}
              onChange={(e) => setField('date', e.target.value)}
              required
              className={inputClass}
            />
          </label>

          <label>
            <span className="text-sm font-medium text-grey-700">연차</span>
            <select
              value={values.yearId}
              onChange={(e) => setField('yearId', e.target.value)}
              className={`${inputClass} bg-surface`}
            >
              <option value="">연차 미지정</option>
              {years.map((year) => (
                <option key={year.id} value={year.id}>
                  {year.name}
                </option>
              ))}
              {/* 목록에 없는 연차를 가리키고 있으면 선택값을 조용히 바꾸지 않고 그대로 보인다 */}
              {values.yearId !== '' && !years.some((year) => year.id === values.yearId) && (
                <option value={values.yearId}>(삭제된 연차)</option>
              )}
            </select>
            <span className="mt-1 block text-xs text-grey-500">
              연차를 비우면 연차별 집계에서 빠지고 전체 집계에만 포함됩니다.
            </span>
          </label>

          <label>
            <span className="text-sm font-medium text-grey-700">기관</span>
            <select
              value={values.orgId}
              onChange={(e) => setField('orgId', e.target.value)}
              className={`${inputClass} bg-surface`}
            >
              <option value="">기관 미지정</option>
              {organizations.map((org) => (
                <option key={org.id} value={org.id}>
                  {org.name}
                </option>
              ))}
              {values.orgId !== '' && !organizations.some((org) => org.id === values.orgId) && (
                <option value={values.orgId}>(삭제된 기관)</option>
              )}
            </select>
          </label>

          <label>
            <span className="text-sm font-medium text-grey-700">증빙 링크</span>
            <input
              type="text"
              value={values.evidenceUrl}
              onChange={(e) => setField('evidenceUrl', e.target.value)}
              maxLength={2000}
              placeholder="DOI, 특허번호 조회 URL 등"
              className={inputClass}
            />
          </label>

          <div className="sm:col-span-2">
            <span className="text-sm font-medium text-grey-700">참여자</span>
            {members.length === 0 ? (
              <p className="mt-1 text-xs text-grey-500">
                등록된 인력이 없습니다. 인력·기관 화면에서 먼저 등록하세요.
              </p>
            ) : (
              <div className="mt-1 flex max-h-32 flex-wrap gap-x-4 gap-y-1.5 overflow-y-auto rounded-lg border border-grey-200 p-2.5">
                {members.map((member) => (
                  <label key={member.id} className="flex items-center gap-1.5 text-sm text-grey-700">
                    <input
                      type="checkbox"
                      checked={values.memberIds.includes(member.id)}
                      onChange={() => toggleMember(member.id)}
                    />
                    <span className={member.active ? '' : 'text-grey-400'}>
                      {member.name}
                      {member.active ? '' : ' (비활성)'}
                    </span>
                  </label>
                ))}
                {/* 목록에 없는 인력이 걸려 있으면 감추지 않고 드러낸다 */}
                {values.memberIds
                  .filter((id) => !members.some((member) => member.id === id))
                  .map((id) => (
                    <label key={id} className="flex items-center gap-1.5 text-sm text-red-600">
                      <input type="checkbox" checked onChange={() => toggleMember(id)} />
                      (삭제된 인력)
                    </label>
                  ))}
              </div>
            )}
          </div>

          <label className="sm:col-span-2">
            <span className="text-sm font-medium text-grey-700">비고</span>
            <textarea
              value={values.note}
              onChange={(e) => setField('note', e.target.value)}
              rows={2}
              maxLength={10000}
              className={inputClass}
            />
          </label>
        </div>

        <div className="mt-4 flex justify-end gap-2">
          <Button size="sm" onClick={onCancel} disabled={saving}>
            취소
          </Button>
          <Button type="submit" size="sm" variant="primary" disabled={saving}>
            {saving ? '저장 중…' : mode === 'edit' ? '저장' : '실적 추가'}
          </Button>
        </div>
      </form>

      {conflict && (
        <ConflictDialog
          message={conflict}
          // 서버 데이터를 다시 가져오면 부모가 최신 실적을 내려주고, 위 effect가 비교 패널을 연다
          onReload={() => router.refresh()}
          onKeepEditing={() => setConflict(null)}
        />
      )}
    </>
  );
}
