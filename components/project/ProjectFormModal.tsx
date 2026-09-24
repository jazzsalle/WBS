'use client';

// 과제 생성·편집 모달 (SOT §7.15, §9 createProject/updateProject, §8.4 O-1·O-3)
// 생성: createProject — Stage 1개 + Year 1개(비목 12종)를 서버 RPC가 함께 만든다.
// 편집: updateProject(id, patch, expectedVersion) — 여러 필드를 한 번에 바꾸므로 낙관적 잠금을 건다(O-1).
//       STALE이면 ConflictDialog를 띄우고, 어떤 선택을 하든 입력값은 유지한다(O-3).
//       "다시 불러오기"는 서버 데이터를 새로 가져와(부모가 최신 project를 다시 내려준다)
//       내 입력과 다른 항목만 비교해 보여준다 — 덮어쓰기는 사용자가 항목별로 선택한다.
// 금액은 원 단위 정수로 다룬다. 화면에는 천 단위 구분만 넣고 단위 환산은 하지 않는다.

import { useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import type { Project, ProjectStatus } from '@/types';
import type { ActionErrorCode } from '@/lib/db/errors';
import { PROJECT_STATUS_LABELS } from '@/lib/constants';
import { createProject, updateProject } from '@/actions/projects';
import Modal from '@/components/ui/Modal';
import Button from '@/components/ui/Button';
import ErrorBanner from '@/components/ui/ErrorBanner';
import ConflictDialog from '@/components/ui/ConflictDialog';
import { setRealtimePaused } from '@/components/RealtimeRefresher';

/** projects.color는 hex 문자열이고 DB 기본값은 ''다. 미지정 과제의 색상 띠 기본값 (grey-500) */
export const DEFAULT_PROJECT_COLOR = '#8b95a1';

interface FormValues {
  name: string;
  projectNo: string;
  ministry: string;
  agency: string;
  programName: string;
  contractStartDate: string;
  contractEndDate: string;
  totalBudget: string; // 원 단위 정수 문자열 ('' = 미입력)
  govBudget: string;
  ownBudget: string;
  status: ProjectStatus;
  color: string;
}

type FieldKind = 'text' | 'date' | 'amount' | 'status' | 'color';

interface FieldDef {
  key: keyof FormValues;
  label: string;
  kind: FieldKind;
  placeholder?: string;
}

// 비교 패널(O-3)과 폼이 같은 정의를 쓴다 — 한쪽만 빠지는 일이 없게
const FIELDS: readonly FieldDef[] = [
  { key: 'name', label: '과제명', kind: 'text', placeholder: '예: AI 기반 공정 최적화 기술 개발' },
  { key: 'projectNo', label: '과제번호', kind: 'text', placeholder: '예: 2026-0-01234' },
  { key: 'ministry', label: '부처', kind: 'text', placeholder: '예: 산업통상자원부' },
  { key: 'agency', label: '전문기관', kind: 'text', placeholder: '예: KEIT' },
  { key: 'programName', label: '사업명', kind: 'text' },
  { key: 'contractStartDate', label: '협약 시작일', kind: 'date' },
  { key: 'contractEndDate', label: '협약 종료일', kind: 'date' },
  { key: 'totalBudget', label: '총 연구개발비(원)', kind: 'amount' },
  { key: 'govBudget', label: '정부지원연구개발비(원)', kind: 'amount' },
  { key: 'ownBudget', label: '기관부담연구개발비(원)', kind: 'amount' },
  { key: 'status', label: '상태', kind: 'status' },
  { key: 'color', label: '색상', kind: 'color' },
] as const;

// 폼 렌더와 비교 패널이 같은 정의를 참조하도록 — 정의가 빠지면 조용히 넘기지 않고 터뜨린다
function fieldOf(key: keyof FormValues): FieldDef {
  const found = FIELDS.find((f) => f.key === key);
  if (!found) throw new Error(`필드 정의가 없습니다: ${key}`);
  return found;
}

const EMPTY_VALUES: FormValues = {
  name: '',
  projectNo: '',
  ministry: '',
  agency: '',
  programName: '',
  contractStartDate: '',
  contractEndDate: '',
  totalBudget: '',
  govBudget: '',
  ownBudget: '',
  status: 'planning',
  color: DEFAULT_PROJECT_COLOR,
};

function toValues(project: Project): FormValues {
  return {
    name: project.name,
    projectNo: project.projectNo,
    ministry: project.ministry,
    agency: project.agency,
    programName: project.programName,
    contractStartDate: project.contractStartDate ?? '',
    contractEndDate: project.contractEndDate ?? '',
    totalBudget: project.totalBudget === null ? '' : String(project.totalBudget),
    govBudget: project.govBudget === null ? '' : String(project.govBudget),
    ownBudget: project.ownBudget === null ? '' : String(project.ownBudget),
    status: project.status,
    color: project.color || DEFAULT_PROJECT_COLOR,
  };
}

// 금액은 원 단위 정수다. 입력에서 숫자가 아닌 문자는 버리고 정수 문자열만 상태에 남긴다.
function toDigits(raw: string): string {
  const digits = raw.replace(/[^0-9]/g, '').replace(/^0+(?=\d)/, '');
  return digits;
}

function formatAmount(digits: string): string {
  return digits === '' ? '' : Number(digits).toLocaleString('ko-KR');
}

// 부동소수점 오차 없이 다룰 수 있는 자리수 한계. 초과 입력은 저장 전에 막는다.
const MAX_AMOUNT_DIGITS = 15;

function toAmount(digits: string): number | null {
  return digits === '' ? null : Number(digits);
}

function displayValue(field: FieldDef, values: FormValues): string {
  const raw = values[field.key];
  if (field.kind === 'amount') return raw === '' ? '(미입력)' : `${formatAmount(raw)}원`;
  if (field.kind === 'status') return PROJECT_STATUS_LABELS[values.status];
  if (raw === '') return '(비어 있음)';
  return raw;
}

export interface ProjectFormModalProps {
  mode: 'create' | 'edit';
  /** edit 모드 필수. 부모가 서버 데이터를 그대로 내려준다(다시 불러오기 후 최신값이 여기로 온다) */
  project?: Project;
  onClose: () => void;
  /** 저장 성공 시 — 부모가 목록을 새로고침한다 */
  onSaved: () => void;
}

export default function ProjectFormModal({
  mode,
  project,
  onClose,
  onSaved,
}: ProjectFormModalProps) {
  const router = useRouter();
  const [values, setValues] = useState<FormValues>(() =>
    project ? toValues(project) : EMPTY_VALUES
  );
  const [saving, setSaving] = useState(false);
  const [failure, setFailure] = useState<{ message: string; code?: ActionErrorCode } | null>(null);
  const [conflict, setConflict] = useState<string | null>(null);
  // O-3 비교 기준: 마지막으로 받아들인 서버 값. 다시 불러오기로 갱신된다.
  const [baseline, setBaseline] = useState<Project | null>(project ?? null);
  const [reloaded, setReloaded] = useState(false);

  // R-4: 폼이 열려 있는 동안 자동 새로고침을 보류해 입력 중인 내용을 지키지 않게 한다
  useEffect(() => {
    setRealtimePaused(true);
    return () => setRealtimePaused(false);
  }, []);

  // 다시 불러오기(또는 남의 저장) 후 부모가 최신 project를 내려주면 비교 기준을 갱신한다.
  // 입력값(values)은 건드리지 않는다 — 작업 내용을 날리지 않는 것이 O-3의 핵심이다.
  const baselineVersion = baseline?.version;
  useEffect(() => {
    if (!project || project.version === baselineVersion) return;
    setBaseline(project);
    setConflict(null);
    setReloaded(true);
  }, [project, baselineVersion]);

  const nameInputRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    nameInputRef.current?.focus();
  }, []);

  // 최신 서버 값과 내 입력이 다른 항목만 (O-3 비교 UI)
  const differences = useMemo(() => {
    if (!reloaded || !baseline) return [];
    const latest = toValues(baseline);
    return FIELDS.filter((field) => latest[field.key] !== values[field.key]).map((field) => ({
      field,
      latest,
    }));
  }, [reloaded, baseline, values]);

  const setField = <K extends keyof FormValues>(key: K, value: FormValues[K]) => {
    setValues((prev) => ({ ...prev, [key]: value }));
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setFailure(null);

    if (values.name.trim() === '') {
      setFailure({ message: '과제명을 입력하세요.', code: 'VALIDATION' });
      return;
    }
    const tooLong = (['totalBudget', 'govBudget', 'ownBudget'] as const).find(
      (key) => values[key].length > MAX_AMOUNT_DIGITS
    );
    if (tooLong) {
      setFailure({ message: '금액이 너무 큽니다. 입력값을 확인하세요.', code: 'VALIDATION' });
      return;
    }

    const payload = {
      name: values.name.trim(),
      projectNo: values.projectNo.trim(),
      ministry: values.ministry.trim(),
      agency: values.agency.trim(),
      programName: values.programName.trim(),
      status: values.status,
      color: values.color,
      contractStartDate: values.contractStartDate || null,
      contractEndDate: values.contractEndDate || null,
      totalBudget: toAmount(values.totalBudget),
      govBudget: toAmount(values.govBudget),
      ownBudget: toAmount(values.ownBudget),
    };

    if (mode === 'edit' && (!project || !baseline)) {
      setFailure({ message: '편집할 과제 정보를 찾을 수 없습니다. 목록을 새로고침하세요.' });
      return;
    }

    setSaving(true);
    try {
      const res =
        mode === 'edit' && project && baseline
          ? // O-1: 여러 필드를 한 번에 바꾸므로 마지막으로 읽은 version을 조건으로 건다
            await updateProject(project.id, payload, baseline.version)
          : await createProject(payload);
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
        title={isEdit ? '과제 편집' : '새 과제'}
        description={
          isEdit
            ? '협약 정보를 수정합니다.'
            : '최소 정보만 입력하면 됩니다. 1단계와 1차년도(비목 12종)가 함께 만들어집니다.'
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
            <label className="sm:col-span-2">
              <span className="text-sm font-medium text-grey-700">
                과제명 <span className="text-red-600">*</span>
              </span>
              <input
                ref={nameInputRef}
                type="text"
                value={values.name}
                onChange={(e) => setField('name', e.target.value)}
                maxLength={200}
                required
                placeholder={fieldOf('name').placeholder}
                className="mt-1 w-full rounded-lg border border-grey-300 px-3 py-2 text-sm focus:border-grey-500 focus:outline-none"
              />
            </label>

            {(['projectNo', 'ministry', 'agency'] as const).map((key) => {
              const field = fieldOf(key);
              return (
                <label key={key}>
                  <span className="text-sm font-medium text-grey-700">{field.label}</span>
                  <input
                    type="text"
                    value={values[key]}
                    onChange={(e) => setField(key, e.target.value)}
                    maxLength={100}
                    placeholder={field.placeholder}
                    className="mt-1 w-full rounded-lg border border-grey-300 px-3 py-2 text-sm focus:border-grey-500 focus:outline-none"
                  />
                </label>
              );
            })}

            <label>
              <span className="text-sm font-medium text-grey-700">상태</span>
              <select
                value={values.status}
                onChange={(e) => setField('status', e.target.value as ProjectStatus)}
                className="mt-1 w-full rounded-lg border border-grey-300 bg-surface px-3 py-2 text-sm focus:border-grey-500 focus:outline-none"
              >
                {(Object.keys(PROJECT_STATUS_LABELS) as ProjectStatus[]).map((status) => (
                  <option key={status} value={status}>
                    {PROJECT_STATUS_LABELS[status]}
                  </option>
                ))}
              </select>
            </label>

            <label className="sm:col-span-2">
              <span className="text-sm font-medium text-grey-700">사업명</span>
              <input
                type="text"
                value={values.programName}
                onChange={(e) => setField('programName', e.target.value)}
                maxLength={200}
                className="mt-1 w-full rounded-lg border border-grey-300 px-3 py-2 text-sm focus:border-grey-500 focus:outline-none"
              />
            </label>

            <label>
              <span className="text-sm font-medium text-grey-700">협약 시작일</span>
              <input
                type="date"
                value={values.contractStartDate}
                onChange={(e) => setField('contractStartDate', e.target.value)}
                className="mt-1 w-full rounded-lg border border-grey-300 px-3 py-2 text-sm focus:border-grey-500 focus:outline-none"
              />
              {!isEdit && (
                <span className="mt-1 block text-xs text-grey-500">
                  1차년도 기간(시작일 ~ +1년-1일)의 기준이 됩니다.
                </span>
              )}
            </label>

            <label>
              <span className="text-sm font-medium text-grey-700">협약 종료일</span>
              <input
                type="date"
                value={values.contractEndDate}
                onChange={(e) => setField('contractEndDate', e.target.value)}
                className="mt-1 w-full rounded-lg border border-grey-300 px-3 py-2 text-sm focus:border-grey-500 focus:outline-none"
              />
            </label>

            {(['totalBudget', 'govBudget', 'ownBudget'] as const).map((key) => {
              const field = fieldOf(key);
              return (
                <label key={key}>
                  <span className="text-sm font-medium text-grey-700">{field.label}</span>
                  <input
                    type="text"
                    inputMode="numeric"
                    value={formatAmount(values[key])}
                    onChange={(e) => setField(key, toDigits(e.target.value))}
                    placeholder="0"
                    className="mt-1 w-full rounded-lg border border-grey-300 px-3 py-2 text-right text-sm tabular-nums focus:border-grey-500 focus:outline-none"
                  />
                </label>
              );
            })}

            <label className="flex items-center gap-3">
              <span className="text-sm font-medium text-grey-700">색상</span>
              <input
                type="color"
                value={values.color}
                onChange={(e) => setField('color', e.target.value)}
                aria-label="과제 색상"
                className="h-9 w-16 cursor-pointer rounded border border-grey-300"
              />
              <span className="text-xs text-grey-500">목록 카드의 색상 띠에 쓰입니다.</span>
            </label>
          </div>

          <div className="mt-6 flex justify-end gap-2">
            <Button size="md" onClick={onClose} disabled={saving}>
              취소
            </Button>
            <Button type="submit" size="md" variant="primary" disabled={saving}>
              {saving ? '저장 중…' : isEdit ? '저장' : '과제 만들기'}
            </Button>
          </div>
        </form>
      </Modal>

      {conflict && (
        <ConflictDialog
          message={conflict}
          // 서버 데이터를 다시 가져오면 부모가 최신 project를 내려주고, 위 effect가 비교 패널을 연다
          onReload={() => router.refresh()}
          onKeepEditing={() => setConflict(null)}
        />
      )}
    </>
  );
}
