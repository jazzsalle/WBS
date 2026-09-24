'use client';

// 리스크 생성·편집 모달
// (SOT §7.11, §5.13, §9 createRisk/updateRisk, §8.4 O-1·O-3, §8.5 R-4, 부록 A.4)
// 편집: updateRisk(id, patch, expectedVersion) — 여러 필드를 한 번에 바꾸므로 낙관적 잠금을 건다(O-1).
//       STALE이면 ConflictDialog를 띄우고 입력값은 그대로 둔 채 최신 값과 다른 항목만 비교시킨다(O-3).
// 상태만 바꾸는 조작은 목록의 드롭다운이 담당한다(O-2) — 이 폼은 상세 편집 전용이다.
// 점수(probability × impact)는 저장하지 않는다 — 미리보기도 lib/risk.ts의 riskScore로만 만든다.

import { useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import type {
  Member,
  Risk,
  RiskCategory,
  RiskLevel,
  RiskStatus,
  RiskStrategy,
  Year,
} from '@/types';
import type { ActionErrorCode } from '@/lib/db/errors';
import type { RiskTaskRef } from '@/actions/risks';
import {
  RISK_CATEGORY_LABELS,
  RISK_STATUS_LABELS,
  RISK_STRATEGY_LABELS,
} from '@/lib/constants';
import { riskColor, riskScore, riskSeverity } from '@/lib/risk';
import { createRisk, updateRisk } from '@/actions/risks';
import Modal from '@/components/ui/Modal';
import Button from '@/components/ui/Button';
import ErrorBanner from '@/components/ui/ErrorBanner';
import ConflictDialog from '@/components/ui/ConflictDialog';
import { setRealtimePaused } from '@/components/RealtimeRefresher';
import { RISK_SEVERITY_LABELS, riskColorClasses } from './severity';

interface FormValues {
  title: string;
  category: RiskCategory;
  description: string;
  probability: RiskLevel;
  impact: RiskLevel;
  strategy: RiskStrategy;
  response: string;
  contingency: string;
  yearId: string; // '' = 연차 없음
  taskId: string; // '' = 작업 연결 없음
  ownerMemberId: string; // '' = 담당 미지정
  dueDate: string; // '' = 목표일 미지정
  status: RiskStatus;
}

interface FieldDef {
  key: keyof FormValues;
  label: string;
}

// 폼과 O-3 비교 패널이 같은 정의를 쓴다 — 한쪽에만 있는 필드가 조용히 덮어써지지 않게
const FIELDS: readonly FieldDef[] = [
  { key: 'title', label: '리스크명' },
  { key: 'category', label: '유형' },
  { key: 'description', label: '리스크 내용' },
  { key: 'probability', label: '발생가능성' },
  { key: 'impact', label: '영향도' },
  { key: 'strategy', label: '대응전략' },
  { key: 'response', label: '대응 방안' },
  { key: 'contingency', label: '비상 계획' },
  { key: 'yearId', label: '연차' },
  { key: 'taskId', label: '관련 작업' },
  { key: 'ownerMemberId', label: '담당' },
  { key: 'dueDate', label: '목표일' },
  { key: 'status', label: '상태' },
] as const;

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const LEVELS: readonly RiskLevel[] = [1, 2, 3, 4, 5];

// §5.13 DB 기본값과 같다 — 지어낸 값이 아니다
const EMPTY_VALUES: FormValues = {
  title: '',
  category: 'technical',
  description: '',
  probability: 3,
  impact: 3,
  strategy: 'mitigate',
  response: '',
  contingency: '',
  yearId: '',
  taskId: '',
  ownerMemberId: '',
  dueDate: '',
  status: 'identified',
};

function toValues(risk: Risk): FormValues {
  return {
    title: risk.title,
    category: risk.category,
    description: risk.description,
    probability: risk.probability,
    impact: risk.impact,
    strategy: risk.strategy,
    response: risk.response,
    contingency: risk.contingency,
    yearId: risk.yearId ?? '',
    taskId: risk.taskId ?? '',
    ownerMemberId: risk.ownerMemberId ?? '',
    dueDate: risk.dueDate ?? '',
    status: risk.status,
  };
}

/** §5.5: name이 있으면 name, 없으면 order+1 + '차년도' */
function yearLabel(year: Year): string {
  return year.name.trim() || `${year.order + 1}차년도`;
}

const INPUT_CLASS =
  'mt-1 w-full rounded-lg border border-grey-300 px-3 py-2 text-sm focus:border-grey-500 focus:outline-none';
const SELECT_CLASS =
  'mt-1 w-full rounded-lg border border-grey-300 bg-surface px-3 py-2 text-sm focus:border-grey-500 focus:outline-none';

export interface RiskFormModalProps {
  mode: 'create' | 'edit';
  projectId: string;
  /** edit 모드 필수. 부모가 서버 데이터를 그대로 내려준다(다시 불러오기 후 최신값이 여기로 온다) */
  risk?: Risk;
  years: Year[];
  members: Member[];
  tasks: RiskTaskRef[];
  onClose: () => void;
  /** 저장 성공 시 — 부모가 목록을 새로고침한다 */
  onSaved: () => void;
}

export default function RiskFormModal({
  mode,
  projectId,
  risk,
  years,
  members,
  tasks,
  onClose,
  onSaved,
}: RiskFormModalProps) {
  const router = useRouter();
  const [values, setValues] = useState<FormValues>(() => (risk ? toValues(risk) : EMPTY_VALUES));
  const [saving, setSaving] = useState(false);
  const [failure, setFailure] = useState<{ message: string; code?: ActionErrorCode } | null>(null);
  const [conflict, setConflict] = useState<string | null>(null);
  // O-3 비교 기준: 마지막으로 받아들인 서버 값. 저장에 쓰는 version도 여기서만 나온다.
  const [baseline, setBaseline] = useState<Risk | null>(risk ?? null);
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
    if (!risk || risk.version === baselineVersion) return;
    setBaseline(risk);
    setConflict(null);
    setReloaded(true);
  }, [risk, baselineVersion]);

  const titleInputRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    titleInputRef.current?.focus();
  }, []);

  // 점수·등급은 저장하지 않는다. 미리보기도 lib/risk.ts로만 만든다 (§5.13, §6.5)
  const previewScore = riskScore({ probability: values.probability, impact: values.impact });
  const previewSeverity = riskSeverity({
    probability: values.probability,
    impact: values.impact,
    status: values.status,
  });
  // 색상 토큰도 lib/risk.ts에서만 나온다 — 등급→색 매핑을 여기서 다시 쓰지 않는다 (부록 A.3)
  const previewClasses = riskColorClasses(riskColor(previewScore));

  // id는 사용자에게 아무 의미가 없다. 목록에 없는 연차·작업·인력도 값을 숨기지 않고 사실을 드러낸다.
  const yearName = (yearId: string): string => {
    if (yearId === '') return '연차 없음';
    const year = years.find((y) => y.id === yearId);
    return year ? yearLabel(year) : '(삭제된 연차)';
  };

  const taskName = (taskId: string): string => {
    if (taskId === '') return '연결 없음';
    return tasks.find((t) => t.id === taskId)?.title ?? '(삭제된 작업)';
  };

  const memberName = (memberId: string): string => {
    if (memberId === '') return '미지정';
    return members.find((m) => m.id === memberId)?.name ?? '(삭제된 인력)';
  };

  const displayValue = (field: FieldDef, source: FormValues): string => {
    if (field.key === 'category') return RISK_CATEGORY_LABELS[source.category];
    if (field.key === 'strategy') return RISK_STRATEGY_LABELS[source.strategy];
    if (field.key === 'status') return RISK_STATUS_LABELS[source.status];
    if (field.key === 'yearId') return yearName(source.yearId);
    if (field.key === 'taskId') return taskName(source.taskId);
    if (field.key === 'ownerMemberId') return memberName(source.ownerMemberId);
    const raw = source[field.key];
    return raw === '' ? '(비어 있음)' : String(raw);
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

  // N-8: 연차·작업·인력을 지워도 리스크는 남는다. 그대로 저장하면 서버가 "이 과제 것이 아니다"로
  // 막으므로 무엇을 고쳐야 하는지 미리 알린다.
  const danglingYear = values.yearId !== '' && !years.some((y) => y.id === values.yearId);
  const danglingTask = values.taskId !== '' && !tasks.some((t) => t.id === values.taskId);
  const danglingMember =
    values.ownerMemberId !== '' && !members.some((m) => m.id === values.ownerMemberId);

  const handleSubmit = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault();
    setFailure(null);

    if (values.title.trim() === '') {
      setFailure({ message: '리스크명을 입력하세요.', code: 'VALIDATION' });
      return;
    }
    // §5.13 dueDate는 선택이다 — 값이 있을 때만 형식을 본다
    if (values.dueDate !== '' && !ISO_DATE.test(values.dueDate)) {
      setFailure({ message: "목표일을 'YYYY-MM-DD' 형식으로 입력하세요.", code: 'VALIDATION' });
      return;
    }

    const payload = {
      title: values.title.trim(),
      category: values.category,
      description: values.description.trim(),
      probability: values.probability,
      impact: values.impact,
      strategy: values.strategy,
      response: values.response.trim(),
      contingency: values.contingency.trim(),
      yearId: values.yearId === '' ? null : values.yearId,
      taskId: values.taskId === '' ? null : values.taskId,
      ownerMemberId: values.ownerMemberId === '' ? null : values.ownerMemberId,
      dueDate: values.dueDate === '' ? null : values.dueDate,
      status: values.status,
    };

    if (mode === 'edit' && (!risk || !baseline)) {
      setFailure({ message: '편집할 리스크를 찾을 수 없습니다. 목록을 새로고침하세요.' });
      return;
    }

    setSaving(true);
    try {
      const res =
        mode === 'edit' && risk && baseline
          ? // O-1: 여러 필드를 한 번에 바꾸므로 마지막으로 읽은 version을 조건으로 건다
            await updateRisk(risk.id, payload, baseline.version)
          : await createRisk(projectId, payload);
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
        title={isEdit ? '리스크 편집' : '리스크 추가'}
        description={
          isEdit
            ? '발생가능성·영향도와 대응 계획을 수정합니다. 점수와 등급은 저장하지 않고 매번 계산합니다.'
            : '리스크명·유형·대응전략만 있으면 등록됩니다. 나머지는 나중에 채워도 됩니다.'
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
            <div className="mb-4 rounded-xl border border-orange-200 bg-orange-50 p-3 text-sm text-orange-800">
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
            <label className="sm:col-span-2">
              <span className="text-sm font-medium text-grey-700">
                리스크명 <span className="text-red-600">*</span>
              </span>
              <input
                ref={titleInputRef}
                type="text"
                value={values.title}
                onChange={(e) => setField('title', e.target.value)}
                maxLength={200}
                required
                placeholder="예: 핵심 부품 수급 지연"
                className={INPUT_CLASS}
              />
            </label>

            <label>
              <span className="text-sm font-medium text-grey-700">유형</span>
              <select
                value={values.category}
                onChange={(e) => setField('category', e.target.value as RiskCategory)}
                className={SELECT_CLASS}
              >
                {(Object.keys(RISK_CATEGORY_LABELS) as RiskCategory[]).map((category) => (
                  <option key={category} value={category}>
                    {RISK_CATEGORY_LABELS[category]}
                  </option>
                ))}
              </select>
            </label>

            <label>
              <span className="text-sm font-medium text-grey-700">대응전략</span>
              <select
                value={values.strategy}
                onChange={(e) => setField('strategy', e.target.value as RiskStrategy)}
                className={SELECT_CLASS}
              >
                {(Object.keys(RISK_STRATEGY_LABELS) as RiskStrategy[]).map((strategy) => (
                  <option key={strategy} value={strategy}>
                    {RISK_STRATEGY_LABELS[strategy]}
                  </option>
                ))}
              </select>
            </label>

            <label>
              <span className="text-sm font-medium text-grey-700">발생가능성 (1~5)</span>
              <select
                value={values.probability}
                onChange={(e) => setField('probability', Number(e.target.value) as RiskLevel)}
                className={SELECT_CLASS}
              >
                {LEVELS.map((level) => (
                  <option key={level} value={level}>
                    {level}
                  </option>
                ))}
              </select>
            </label>

            <label>
              <span className="text-sm font-medium text-grey-700">영향도 (1~5)</span>
              <select
                value={values.impact}
                onChange={(e) => setField('impact', Number(e.target.value) as RiskLevel)}
                className={SELECT_CLASS}
              >
                {LEVELS.map((level) => (
                  <option key={level} value={level}>
                    {level}
                  </option>
                ))}
              </select>
            </label>

            <div className="sm:col-span-2 flex flex-wrap items-center gap-3 rounded-lg bg-grey-50 p-3">
              <span className="text-xs text-grey-600">
                점수 = 발생가능성 × 영향도 (저장하지 않고 매번 계산합니다)
              </span>
              <span
                className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-bold tabular-nums ${previewClasses.badge}`}
              >
                {previewSeverity === null
                  ? `판정 제외 ${previewScore}`
                  : `${RISK_SEVERITY_LABELS[previewSeverity]} ${previewScore}`}
              </span>
              {previewSeverity === null && (
                <span className="text-xs text-grey-500">
                  해결·종료 상태는 등급 판정 대상이 아닙니다 (§6.5).
                </span>
              )}
            </div>

            <label className="sm:col-span-2">
              <span className="text-sm font-medium text-grey-700">리스크 내용</span>
              <textarea
                value={values.description}
                onChange={(e) => setField('description', e.target.value)}
                rows={3}
                maxLength={10000}
                placeholder="어떤 상황이 언제 발생할 수 있는지"
                className={INPUT_CLASS}
              />
            </label>

            <label className="sm:col-span-2">
              <span className="text-sm font-medium text-grey-700">대응 방안</span>
              <textarea
                value={values.response}
                onChange={(e) => setField('response', e.target.value)}
                rows={3}
                maxLength={10000}
                placeholder="발생 전에 무엇을 하는지"
                className={INPUT_CLASS}
              />
            </label>

            <label className="sm:col-span-2">
              <span className="text-sm font-medium text-grey-700">비상 계획</span>
              <textarea
                value={values.contingency}
                onChange={(e) => setField('contingency', e.target.value)}
                rows={3}
                maxLength={10000}
                placeholder="그래도 발생하면 무엇을 하는지"
                className={INPUT_CLASS}
              />
            </label>

            <label>
              <span className="text-sm font-medium text-grey-700">연차</span>
              <select
                value={values.yearId}
                onChange={(e) => setField('yearId', e.target.value)}
                className={SELECT_CLASS}
              >
                <option value="">연차 없음 (과제 전체)</option>
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
              <span className="text-sm font-medium text-grey-700">관련 작업</span>
              <select
                value={values.taskId}
                onChange={(e) => setField('taskId', e.target.value)}
                className={SELECT_CLASS}
              >
                <option value="">연결 없음</option>
                {tasks.map((task) => (
                  <option key={task.id} value={task.id}>
                    {task.title}
                  </option>
                ))}
                {danglingTask && <option value={values.taskId}>(삭제된 작업)</option>}
              </select>
            </label>

            <label>
              <span className="text-sm font-medium text-grey-700">담당</span>
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
              <span className="text-sm font-medium text-grey-700">대응 완료 목표일</span>
              <input
                type="date"
                value={values.dueDate}
                onChange={(e) => setField('dueDate', e.target.value)}
                className={INPUT_CLASS}
              />
            </label>

            <label>
              <span className="text-sm font-medium text-grey-700">상태</span>
              <select
                value={values.status}
                onChange={(e) => setField('status', e.target.value as RiskStatus)}
                className={SELECT_CLASS}
              >
                {(Object.keys(RISK_STATUS_LABELS) as RiskStatus[]).map((status) => (
                  <option key={status} value={status}>
                    {RISK_STATUS_LABELS[status]}
                  </option>
                ))}
              </select>
            </label>
          </div>

          {(danglingYear || danglingTask || danglingMember) && (
            <p className="mt-4 rounded-lg bg-orange-50 p-3 text-xs text-orange-800">
              {danglingYear && '이 리스크가 가리키는 연차가 목록에 없습니다. '}
              {danglingTask && '이 리스크가 가리키는 작업이 목록에 없습니다. '}
              {danglingMember && '이 리스크의 담당 인력이 목록에 없습니다. '}
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
          // 서버 데이터를 다시 가져오면 부모가 최신 risk를 내려주고, 위 effect가 비교 패널을 연다
          onReload={() => router.refresh()}
          onKeepEditing={() => setConflict(null)}
        />
      )}
    </>
  );
}
