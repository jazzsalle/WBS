'use client';

// 작업 상세 패널 (SOT §7.4 "행 클릭 → 우측 상세 패널", §6.9 중요도·긴급도 고정)
// 여러 필드를 한 번에 바꾸므로 낙관적 잠금을 필수로 건다 — updateTask에 expectedVersion 전달 (O-1).
// O-3: STALE이면 ConflictDialog를 띄우고, 다시 불러온 뒤에는 최신 서버 값(baseline)과 내 입력의
//      상이 항목을 나란히 보여준다. 입력값은 절대 덮어쓰지 않는다.
//      저장에 쓰는 version은 항상 baseline(사용자가 비교를 끝낸 서버 값)의 것이고,
//      확인하지 않은 충돌 항목이 남아 있으면 저장 자체를 막는다 — 자동 갱신된 version으로
//      남의 수정이 조용히 덮어써지는 경로를 없앤다.
// 패널이 열려 있는 동안은 Realtime 자동 새로고침을 보류한다 (R-4).

import { useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import type { Deliverable, Member, Organization, Task, TaskStatus, TechTarget } from '@/types';
import type { ActionErrorCode } from '@/lib/db/errors';
import { TASK_STATUS_LABELS } from '@/lib/constants';
import { priorityGrade } from '@/lib/priority';
import { updateTask } from '@/actions/tasks';
import type { LinkedNote } from '@/actions/notes';
import { setRealtimePaused } from '@/components/RealtimeRefresher';
import LinkedNoteList from '@/components/notes/LinkedNoteList';
import Button from '@/components/ui/Button';
import Badge from '@/components/ui/Badge';
import ErrorBanner from '@/components/ui/ErrorBanner';
import ConflictDialog from '@/components/ui/ConflictDialog';
import {
  DELETED_GOAL,
  DETAIL_FIELDS,
  adoptLatestValue,
  buildUpdatePatch,
  diffDetailValues,
  displayDetailValue,
  toDetailFormValues,
  unresolvedConflicts,
  type DetailFieldKey,
  type DetailFormValues,
  type Level,
} from './conflict';

export interface TaskDetailPanelProps {
  task: Task;
  /** 표시용 계산값 (§6.9). 저장하지 않는다 */
  urgency: number;
  priorityScore: number;
  wbsCode: string;
  /** 배정 후보 (§5.11). 정렬은 서버가 sort_order로 맞춰 준다 */
  members: Member[];
  organizations: Organization[];
  /** 연계 후보 (§7.4 목표 연계, §5.8·§5.9). 같은 과제의 목표만 내려온다 */
  deliverables: Deliverable[];
  techTargets: TechTarget[];
  /** 충돌 비교(O-3)에서 id를 이름으로 바꾸는 사전. 트리와 같은 사전을 쓴다 */
  memberNames: Record<string, string>;
  orgNames: Record<string, string>;
  deliverableNames: Record<string, string>;
  techTargetNames: Record<string, string>;
  /** §7.12 역참조 — 이 작업에 연결된 노트만 부모가 걸러서 내려준다 */
  linkedNotes: LinkedNote[];
  onClose: () => void;
}

const DELETED_MEMBER = '(삭제된 인력)';
const DELETED_ORG = '(삭제된 기관)';

/** 쉼표 문자열 → id 집합. 폼 값이 곧 저장 payload라 여기서 형태를 바꾸지 않는다 */
function parseIds(raw: string): string[] {
  return raw
    .split(',')
    .map((part) => part.trim())
    .filter((part) => part !== '');
}

// 정렬을 고정한다. toDetailFormValues가 서버 값을 정렬해 주므로, 내 입력도 같은 순서여야
// "순서만 다른" 가짜 충돌이 O-3 비교에 뜨지 않는다.
function toggleId(raw: string, id: string, checked: boolean): string {
  const ids = new Set(parseIds(raw));
  if (checked) ids.add(id);
  else ids.delete(id);
  return [...ids].sort().join(',');
}

/** 후보 목록 + 목록에 없는데 이미 연계된 id(다른 사람이 지운 목표)를 함께 돌려준다 */
function withSelectedMissing(
  goals: readonly { id: string; name: string }[],
  rawSelected: string
): { id: string; label: string }[] {
  const options = goals.map((goal) => ({ id: goal.id, label: goal.name }));
  const known = new Set(goals.map((goal) => goal.id));
  for (const id of new Set(parseIds(rawSelected))) {
    if (!known.has(id)) options.push({ id, label: DELETED_GOAL });
  }
  return options;
}

export default function TaskDetailPanel({
  task,
  urgency,
  priorityScore,
  wbsCode,
  members,
  organizations,
  deliverables,
  techTargets,
  memberNames,
  orgNames,
  deliverableNames,
  techTargetNames,
  linkedNotes,
  onClose,
}: TaskDetailPanelProps) {
  const router = useRouter();
  const [form, setForm] = useState<DetailFormValues>(() => toDetailFormValues(task));
  // O-3 비교 기준: 마지막으로 받아들인 서버 값. 저장에 쓰는 version도 여기서만 나온다.
  const [baseline, setBaseline] = useState<Task>(task);
  const [reloaded, setReloaded] = useState(false);
  const [keptKeys, setKeptKeys] = useState<ReadonlySet<DetailFieldKey>>(
    () => new Set<DetailFieldKey>()
  );
  const [saving, setSaving] = useState(false);
  const [failure, setFailure] = useState<{ message: string; code?: ActionErrorCode } | null>(null);
  const [conflict, setConflict] = useState<string | null>(null);

  // R-4: 편집 중에는 남의 변경으로 화면이 다시 그려지지 않게 보류한다("새 변경 있음" 배너만)
  useEffect(() => {
    setRealtimePaused(true);
    return () => setRealtimePaused(false);
  }, []);

  // 다시 불러오기(또는 남의 저장) 후 부모가 최신 task를 내려주면 비교 기준만 갱신한다.
  // 입력값(form)은 건드리지 않는다 — 작업 내용을 날리지 않는 것이 O-3의 핵심이다.
  const baselineVersion = baseline.version;
  useEffect(() => {
    if (task.version === baselineVersion) return;
    setBaseline(task);
    setConflict(null);
    setReloaded(true);
    // 새 기준이 왔으므로 이전 판단은 무효다 — 다시 확인하게 한다
    setKeptKeys(new Set<DetailFieldKey>());
  }, [task, baselineVersion]);

  const latest = useMemo(() => toDetailFormValues(baseline), [baseline]);
  const diffKeys = useMemo(
    () => (reloaded ? diffDetailValues(latest, form) : []),
    [reloaded, latest, form]
  );
  const unresolved = useMemo(() => unresolvedConflicts(diffKeys, keptKeys), [diffKeys, keptKeys]);

  // O-3 비교 UI에 id 대신 이름을 보여주기 위한 사전
  const valueLabels = useMemo(
    () => ({
      members: memberNames,
      orgs: orgNames,
      deliverables: deliverableNames,
      techTargets: techTargetNames,
    }),
    [memberNames, orgNames, deliverableNames, techTargetNames]
  );

  const selectedMemberIds = useMemo(() => new Set(parseIds(form.memberIds)), [form.memberIds]);
  const selectedDeliverableIds = useMemo(
    () => new Set(parseIds(form.deliverableIds)),
    [form.deliverableIds]
  );
  const selectedTechTargetIds = useMemo(
    () => new Set(parseIds(form.techTargetIds)),
    [form.techTargetIds]
  );

  // 목록에 없는 id(다른 사람이 지운 인력)도 선택지로 남긴다. 빼 버리면 select가 빈 값으로
  // 보여 "미지정"과 구분되지 않고, 그대로 저장하면 배정이 조용히 사라진다.
  const memberOptions = useMemo(() => {
    const options = members.map((member) => ({
      id: member.id,
      // §7.10의 참여 종료는 삭제가 아니다 — 이미 배정된 사람을 목록에서 없애지 않고 표시만 구분한다
      label: member.active ? member.name : `${member.name} (참여종료)`,
    }));
    const known = new Set(members.map((member) => member.id));
    const assigned = [form.ownerMemberId, ...parseIds(form.memberIds)];
    for (const id of new Set(assigned)) {
      if (id !== '' && !known.has(id)) options.push({ id, label: DELETED_MEMBER });
    }
    return options;
  }, [members, form.ownerMemberId, form.memberIds]);

  const orgOptions = useMemo(() => {
    const options = organizations.map((org) => ({ id: org.id, label: org.name }));
    if (form.orgId !== '' && !organizations.some((org) => org.id === form.orgId)) {
      options.push({ id: form.orgId, label: DELETED_ORG });
    }
    return options;
  }, [organizations, form.orgId]);

  // 연계도 같은 이유로 "목록에 없는 선택된 id"를 남긴다 — 후보에서 빼면 체크가 풀린 것처럼
  // 보이고, 그대로 저장하면 전체 치환이라 연계가 조용히 사라진다
  const deliverableOptions = useMemo(
    () => withSelectedMissing(deliverables, form.deliverableIds),
    [deliverables, form.deliverableIds]
  );
  const techTargetOptions = useMemo(
    () => withSelectedMissing(techTargets, form.techTargetIds),
    [techTargets, form.techTargetIds]
  );

  const patch = <K extends keyof DetailFormValues>(key: K, value: DetailFormValues[K]): void => {
    setForm((prev) => ({ ...prev, [key]: value }));
  };

  const handleSave = async (): Promise<void> => {
    setFailure(null);

    // 확인하지 않은 충돌이 남아 있으면 저장하지 않는다 (O-3: 조용한 덮어쓰기 차단)
    if (unresolved.length > 0) {
      setFailure({
        message:
          '최신 내용과 다른 항목이 남아 있습니다. 각 항목에서 [최신 값 사용] 또는 [내 입력 유지]를 고른 뒤 저장하세요.',
        code: 'STALE',
      });
      return;
    }

    // 저장 payload는 비교 대상(DetailFormValues)에서만 만든다 — 비교되지 않는 필드가
    // 끼어들 수 없게 conflict.ts가 키를 강제한다
    const built = buildUpdatePatch(form);
    if (!built.ok) {
      setFailure({ message: built.message, code: 'VALIDATION' });
      return;
    }

    setSaving(true);
    // O-1: 여러 필드 동시 갱신 — 비교를 끝낸 baseline의 version을 조건으로 건다
    const res = await updateTask(task.id, built.patch, baseline.version);
    setSaving(false);

    if (!res.ok) {
      if (res.code === 'STALE') {
        setConflict(res.error); // 입력값은 그대로 두고 선택지를 준다
        return;
      }
      setFailure({ message: res.error, code: res.code });
      return;
    }

    // 내 저장이 새 기준이 된다 — 뒤따라 들어올 refresh는 같은 version이라 비교가 뜨지 않는다
    setBaseline(res.data);
    setReloaded(false);
    setKeptKeys(new Set<DetailFieldKey>());
    router.refresh();
  };

  const grade = priorityGrade(priorityScore);

  return (
    <aside
      aria-label="작업 상세"
      className="fixed top-0 right-0 z-30 flex h-full w-[380px] flex-col border-l border-grey-200 bg-white shadow-xl"
    >
      <header className="flex items-start justify-between gap-2 border-b border-grey-200 p-4">
        <div className="min-w-0">
          <p className="font-mono text-xs text-grey-400">{wbsCode}</p>
          <h2 className="truncate text-base font-bold">{task.title}</h2>
        </div>
        <button
          type="button"
          onClick={onClose}
          aria-label="상세 패널 닫기"
          className="shrink-0 text-xl leading-none text-grey-400 hover:text-grey-600"
        >
          ×
        </button>
      </header>

      <div className="flex-1 space-y-4 overflow-y-auto p-4 text-sm">
        {failure && (
          <ErrorBanner
            message={failure.message}
            code={failure.code}
            onDismiss={() => setFailure(null)}
          />
        )}

        {reloaded && (
          // O-3 비교 UI: 최신 값과 내 입력을 나란히 두고 항목마다 사용자가 고르게 한다
          <div
            role="status"
            className="rounded-xl border border-orange-200 bg-orange-50 p-3 text-sm text-orange-800"
          >
            <p className="font-semibold">최신 내용을 다시 불러왔습니다.</p>
            {diffKeys.length === 0 ? (
              <p className="mt-1 text-xs">내 입력과 다른 항목이 없습니다. 그대로 저장하면 됩니다.</p>
            ) : (
              <>
                <p className="mt-1 text-xs">
                  아래 항목이 서로 다릅니다. 내 입력은 그대로 두었습니다 — 항목마다 최신 값을 쓸지
                  내 입력을 유지할지 고르세요. 고르기 전에는 저장할 수 없습니다.
                </p>
                <ul className="mt-2 space-y-1.5">
                  {DETAIL_FIELDS.filter((field) => diffKeys.includes(field.key)).map((field) => {
                    const kept = keptKeys.has(field.key);
                    return (
                      <li key={field.key} className="rounded-lg bg-white/70 px-2.5 py-1.5 text-xs">
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="font-semibold text-grey-700">{field.label}</span>
                          <span className="text-grey-500">
                            내 입력: {displayDetailValue(field.key, form, valueLabels)}
                          </span>
                          <span className="text-grey-500">
                            최신: {displayDetailValue(field.key, latest, valueLabels)}
                          </span>
                        </div>
                        <div className="mt-1 flex flex-wrap items-center gap-2">
                          <button
                            type="button"
                            onClick={() =>
                              setForm((prev) => adoptLatestValue(prev, latest, field.key))
                            }
                            className="rounded-md border border-orange-300 px-2 py-0.5 font-semibold text-orange-800"
                          >
                            최신 값 사용
                          </button>
                          <button
                            type="button"
                            onClick={() =>
                              setKeptKeys((prev) => {
                                const next = new Set(prev);
                                next.add(field.key);
                                return next;
                              })
                            }
                            className={`rounded-md border px-2 py-0.5 font-semibold ${
                              kept
                                ? 'border-grey-300 bg-grey-100 text-grey-500'
                                : 'border-orange-300 text-orange-800'
                            }`}
                          >
                            {kept ? '내 입력 유지됨' : '내 입력 유지'}
                          </button>
                          {kept && (
                            <span className="text-grey-500">저장하면 최신 값을 덮어씁니다.</span>
                          )}
                        </div>
                      </li>
                    );
                  })}
                </ul>
              </>
            )}
          </div>
        )}

        <label className="block">
          <span className="text-xs font-semibold text-grey-500">작업명</span>
          <input
            value={form.title}
            onChange={(e) => patch('title', e.target.value)}
            className="mt-1 w-full rounded-lg border border-grey-300 px-2.5 py-1.5 focus:border-grey-500 focus:outline-none"
          />
        </label>

        <label className="block">
          <span className="text-xs font-semibold text-grey-500">설명</span>
          <textarea
            rows={4}
            value={form.description}
            onChange={(e) => patch('description', e.target.value)}
            className="mt-1 w-full rounded-lg border border-grey-300 px-2.5 py-1.5 focus:border-grey-500 focus:outline-none"
          />
        </label>

        <div className="grid grid-cols-2 gap-3">
          <label className="block">
            <span className="text-xs font-semibold text-grey-500">시작일</span>
            <input
              type="date"
              value={form.startDate}
              onChange={(e) => patch('startDate', e.target.value)}
              className="mt-1 w-full rounded-lg border border-grey-300 px-2.5 py-1.5 focus:border-grey-500 focus:outline-none"
            />
          </label>
          <label className="block">
            <span className="text-xs font-semibold text-grey-500">마감일</span>
            <input
              type="date"
              value={form.dueDate}
              onChange={(e) => patch('dueDate', e.target.value)}
              className="mt-1 w-full rounded-lg border border-grey-300 px-2.5 py-1.5 focus:border-grey-500 focus:outline-none"
            />
          </label>
          <label className="block">
            <span className="text-xs font-semibold text-grey-500">예상 공수(h)</span>
            <input
              inputMode="decimal"
              value={form.estimatedHours}
              placeholder="미입력 시 가중치 1"
              onChange={(e) => patch('estimatedHours', e.target.value)}
              className="mt-1 w-full rounded-lg border border-grey-300 px-2.5 py-1.5 focus:border-grey-500 focus:outline-none"
            />
          </label>
          <label className="block">
            <span className="text-xs font-semibold text-grey-500">실적 공수(h)</span>
            <input
              inputMode="decimal"
              value={form.actualHours}
              onChange={(e) => patch('actualHours', e.target.value)}
              className="mt-1 w-full rounded-lg border border-grey-300 px-2.5 py-1.5 focus:border-grey-500 focus:outline-none"
            />
          </label>
        </div>

        <label className="block">
          <span className="text-xs font-semibold text-grey-500">상태</span>
          <select
            value={form.status}
            onChange={(e) => patch('status', e.target.value as TaskStatus)}
            className="mt-1 w-full rounded-lg border border-grey-300 bg-white px-2.5 py-1.5 focus:border-grey-500 focus:outline-none"
          >
            {(Object.keys(TASK_STATUS_LABELS) as TaskStatus[]).map((status) => (
              <option key={status} value={status}>
                {TASK_STATUS_LABELS[status]}
              </option>
            ))}
          </select>
        </label>

        <fieldset className="rounded-lg border border-grey-200 p-3">
          <legend className="px-1 text-xs font-semibold text-grey-500">우선순위</legend>

          <label className="block">
            <span className="text-xs text-grey-500">중요도 {form.importance}</span>
            <input
              type="range"
              min={1}
              max={5}
              step={1}
              value={form.importance}
              onChange={(e) => patch('importance', Number(e.target.value) as Level)}
              className="mt-1 w-full"
              aria-label="중요도"
            />
          </label>

          <label className="mt-3 flex items-center gap-2 text-xs text-grey-600">
            <input
              type="checkbox"
              checked={form.urgencyMode === 'manual'}
              onChange={(e) => patch('urgencyMode', e.target.checked ? 'manual' : 'auto')}
              className="h-4 w-4 rounded border-grey-300"
            />
            긴급도 고정 (마감일이 바뀌어도 값을 유지)
          </label>

          {form.urgencyMode === 'manual' ? (
            <label className="mt-2 block">
              <span className="text-xs text-grey-500">고정 긴급도 {form.urgencyManual}</span>
              <input
                type="range"
                min={1}
                max={5}
                step={1}
                value={form.urgencyManual}
                onChange={(e) => patch('urgencyManual', Number(e.target.value) as Level)}
                className="mt-1 w-full"
                aria-label="고정 긴급도"
              />
            </label>
          ) : (
            <p className="mt-2 text-xs text-grey-500">
              마감일에서 자동 계산한 긴급도: <strong>{urgency}</strong>
            </p>
          )}

          <p className="mt-2 text-xs text-grey-500">
            현재 점수{' '}
            <Badge tone={grade.grade === '최우선' ? 'red' : grade.grade === '높음' ? 'amber' : 'neutral'}>
              {priorityScore}
            </Badge>{' '}
            {grade.grade} · 저장하지 않고 매번 계산합니다 (PR-7)
          </p>
        </fieldset>

        <fieldset className="rounded-lg border border-grey-200 p-3">
          <legend className="px-1 text-xs font-semibold text-grey-500">담당 · 기관</legend>

          {memberOptions.length === 0 ? (
            <p className="text-xs text-grey-500">
              등록된 인력이 없습니다. [인력·기관] 화면에서 먼저 등록하세요.
            </p>
          ) : (
            <>
              <label className="block">
                <span className="text-xs text-grey-500">담당자 (책임자 1명)</span>
                <select
                  value={form.ownerMemberId}
                  onChange={(e) => patch('ownerMemberId', e.target.value)}
                  className="mt-1 w-full rounded-lg border border-grey-300 bg-white px-2.5 py-1.5 focus:border-grey-500 focus:outline-none"
                >
                  <option value="">미지정</option>
                  {memberOptions.map((option) => (
                    <option key={option.id} value={option.id}>
                      {option.label}
                    </option>
                  ))}
                </select>
              </label>

              <div className="mt-3">
                <p className="text-xs text-grey-500">참여 담당자</p>
                {/* 저장하면 task_members가 이 목록으로 전체 치환된다 (체크 해제 = 배정 해제) */}
                <div className="mt-1 max-h-40 space-y-1 overflow-y-auto rounded-lg border border-grey-200 p-2">
                  {memberOptions.map((option) => (
                    <label key={option.id} className="flex items-center gap-2 text-xs text-grey-600">
                      <input
                        type="checkbox"
                        checked={selectedMemberIds.has(option.id)}
                        onChange={(e) =>
                          patch('memberIds', toggleId(form.memberIds, option.id, e.target.checked))
                        }
                        className="h-4 w-4 rounded border-grey-300"
                      />
                      {option.label}
                    </label>
                  ))}
                </div>
              </div>
            </>
          )}

          <label className="mt-3 block">
            <span className="text-xs text-grey-500">수행 기관</span>
            <select
              value={form.orgId}
              onChange={(e) => patch('orgId', e.target.value)}
              disabled={orgOptions.length === 0}
              className="mt-1 w-full rounded-lg border border-grey-300 bg-white px-2.5 py-1.5 focus:border-grey-500 focus:outline-none disabled:bg-grey-50"
            >
              <option value="">미지정</option>
              {orgOptions.map((option) => (
                <option key={option.id} value={option.id}>
                  {option.label}
                </option>
              ))}
            </select>
          </label>
          {orgOptions.length === 0 && (
            <p className="mt-1 text-xs text-grey-500">
              등록된 기관이 없습니다. [인력·기관] 화면에서 먼저 등록하세요.
            </p>
          )}
        </fieldset>

        <label className="block">
          <span className="text-xs font-semibold text-grey-500">태그 (쉼표 구분)</span>
          <input
            value={form.tags}
            onChange={(e) => patch('tags', e.target.value)}
            className="mt-1 w-full rounded-lg border border-grey-300 px-2.5 py-1.5 focus:border-grey-500 focus:outline-none"
          />
        </label>

        <fieldset className="rounded-lg border border-grey-200 p-3">
          <legend className="px-1 text-xs font-semibold text-grey-500">목표 연계</legend>

          <p className="text-xs text-grey-500">
            {/* PR-3: 목표에 연계된 작업은 중요도 4를 제안받는다 — 이미 정한 중요도는 바뀌지 않는다 */}
            이 작업이 기여하는 목표를 고릅니다. 저장하면 선택한 목록으로 통째로 바뀝니다.
          </p>

          <div className="mt-2">
            <p className="text-xs text-grey-500">성과목표</p>
            {deliverableOptions.length === 0 ? (
              <p className="mt-1 text-xs text-grey-500">
                등록된 성과목표가 없습니다. [목표 관리] 화면에서 먼저 등록하세요.
              </p>
            ) : (
              <div className="mt-1 max-h-40 space-y-1 overflow-y-auto rounded-lg border border-grey-200 p-2">
                {deliverableOptions.map((option) => (
                  <label key={option.id} className="flex items-start gap-2 text-xs text-grey-600">
                    <input
                      type="checkbox"
                      checked={selectedDeliverableIds.has(option.id)}
                      onChange={(e) =>
                        patch(
                          'deliverableIds',
                          toggleId(form.deliverableIds, option.id, e.target.checked)
                        )
                      }
                      className="mt-0.5 h-4 w-4 shrink-0 rounded border-grey-300"
                    />
                    <span>{option.label}</span>
                  </label>
                ))}
              </div>
            )}
          </div>

          <div className="mt-3">
            <p className="text-xs text-grey-500">기술목표</p>
            {techTargetOptions.length === 0 ? (
              <p className="mt-1 text-xs text-grey-500">
                등록된 기술목표가 없습니다. [목표 관리] 화면에서 먼저 등록하세요.
              </p>
            ) : (
              <div className="mt-1 max-h-40 space-y-1 overflow-y-auto rounded-lg border border-grey-200 p-2">
                {techTargetOptions.map((option) => (
                  <label key={option.id} className="flex items-start gap-2 text-xs text-grey-600">
                    <input
                      type="checkbox"
                      checked={selectedTechTargetIds.has(option.id)}
                      onChange={(e) =>
                        patch(
                          'techTargetIds',
                          toggleId(form.techTargetIds, option.id, e.target.checked)
                        )
                      }
                      className="mt-0.5 h-4 w-4 shrink-0 rounded border-grey-300"
                    />
                    <span>{option.label}</span>
                  </label>
                ))}
              </div>
            )}
          </div>
        </fieldset>

        <fieldset className="rounded-lg border border-grey-200 p-3">
          {/* §7.12 역참조. 연결은 Note.taskId 단방향이라 여기서는 보여주기만 한다 */}
          <legend className="px-1 text-xs font-semibold text-grey-500">관련 노트</legend>
          <LinkedNoteList
            notes={linkedNotes}
            projectId={task.projectId}
            emptyText="이 작업에 연결된 노트가 없습니다. [노트] 화면에서 노트를 이 작업에 연결하세요."
          />
        </fieldset>
      </div>

      <footer className="flex items-center justify-between gap-2 border-t border-grey-200 p-4">
        <span className="text-xs text-grey-400" title="저장 시 조건으로 거는 version (O-1)">
          기준 v{baseline.version}
        </span>
        <div className="flex gap-2">
          <Button size="sm" onClick={onClose} disabled={saving}>
            닫기
          </Button>
          <Button
            size="sm"
            variant="primary"
            onClick={() => void handleSave()}
            disabled={saving || unresolved.length > 0}
            title={
              unresolved.length > 0
                ? `확인하지 않은 충돌 항목이 ${unresolved.length}건 있습니다`
                : undefined
            }
          >
            {saving ? '저장 중…' : '저장'}
          </Button>
        </div>
      </footer>

      {conflict !== null && (
        <ConflictDialog
          message={conflict}
          onReload={() => {
            setConflict(null);
            // 최신 값을 다시 가져온다. 도착하면 baseline만 갱신되고 비교 UI가 열린다 (O-3)
            router.refresh();
          }}
          onKeepEditing={() => setConflict(null)}
        />
      )}
    </aside>
  );
}
