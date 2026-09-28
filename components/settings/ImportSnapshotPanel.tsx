'use client';

// 설정 > 백업·복원 > 임포트 스냅샷 (SOT §7.14, §6.8.5 I-17, §6.11.5 D-17·D-17a·D-17b)
// 임포트 반영이 남긴 "반영 직전 상태"를 과제별로 보여주고 되돌린다. 두 종류가 한 목록에 섞인다:
//   ① 총괄표(commitImport) — 계획액만 담는다
//   ② 산출근거(commitDetailImport) — 계획액 + 삭제되는 budget_details 행 (D-17)
//   ③ 수행 양식(commitExecutionForm) — 집행 행의 추가 id·변경 전 원본·삭제 id (IN-14). items는 빈 배열
//   ④ 목표 양식(commitGoalForm) — 목표 행의 추가 id·변경 전 원본·삭제 id (GF-11). 복원은 거부된다
// 계획액을 통째로 되돌리는 조작이라 전체 복원(K-4)과 같은 무게의 2단계 확인을 거친다.
// 데이터 접근은 actions/import 경유만 한다 — supabase를 직접 호출하지 않는다 (절대 규칙 3).

import { useCallback, useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import type { ImportSnapshot } from '@/types';
import type { ActionErrorCode } from '@/lib/db/errors';
import { listImportSnapshots, restoreImportSnapshot } from '@/actions/import';
import { formatAmount } from '@/lib/currency';
import Badge from '@/components/ui/Badge';
import Button from '@/components/ui/Button';
import ErrorBanner from '@/components/ui/ErrorBanner';
import Modal from '@/components/ui/Modal';

/** 2단계 확인의 마지막 관문 — 오타로 통과할 수 없게 정확히 이 문자열을 요구한다 */
const CONFIRM_WORD = '되돌리기';

export interface ImportSnapshotPanelProject {
  id: string;
  name: string;
  archived: boolean;
}

export interface ImportSnapshotPanelProps {
  projects: ImportSnapshotPanelProject[];
}

interface Failure {
  message: string;
  code?: ActionErrorCode;
}

/** 되돌아갈 계획액 합계. 원 단위 정수만 더한다 (절대 규칙 4) */
function restoredTotal(snapshot: ImportSnapshot): number {
  return snapshot.snapshot.items.reduce((sum, item) => sum + item.plannedAmount, 0);
}

function yearCount(snapshot: ImportSnapshot): number {
  return new Set(snapshot.snapshot.items.map((item) => item.yearId)).size;
}

/**
 * D-17: 산출근거 임포트가 남긴 스냅샷인가. commit_detail_import RPC가 jsonb에 `kind`를 넣는다 —
 * 총괄표 스냅샷(schemaVersion 1)에는 없어 undefined다. 복원 결과의 모양도 여기서 갈린다(D-17a).
 */
function isDetailSnapshot(snapshot: ImportSnapshot): boolean {
  return snapshot.snapshot.kind === 'budget_detail';
}

/** IN-14: 수행 양식 반영이 남긴 스냅샷인가. 계획액이 아니라 집행 행을 되돌린다 */
function isExecutionSnapshot(snapshot: ImportSnapshot): boolean {
  return snapshot.snapshot.kind === 'execution_form';
}

/** GF-11: 목표 양식 반영이 남긴 스냅샷인가. Phase 21은 복원을 거부한다(RPC raise + 버튼 비활성) */
function isGoalSnapshot(snapshot: ImportSnapshot): boolean {
  return snapshot.snapshot.kind === 'goal_form';
}

/** RPC가 복원을 거부할 때 쓰는 문구와 같게 둔다 — 화면 안내와 거부 사유가 따로 놀지 않게 */
const GOAL_RESTORE_BLOCKED = '목표 양식 스냅샷은 되돌릴 수 없습니다 — 반영 기록용입니다';

function kindLabel(snapshot: ImportSnapshot): string {
  if (isGoalSnapshot(snapshot)) return '목표 양식';
  if (isExecutionSnapshot(snapshot)) return '수행 양식';
  return isDetailSnapshot(snapshot) ? '산출근거' : '예산계획';
}

interface ExecutionCounts {
  added: number;
  changed: number;
  deleted: number;
}

/**
 * IN-14: before는 변경·삭제 전 원본을 함께 담는다 — deleted에 든 id를 빼야 "변경" 건수다.
 * 수행 스냅샷인데 executions가 없으면 스냅샷이 손상된 것이다. 0건으로 보이면 되돌릴 게 없다고
 * 오해하므로 null로 돌려 화면이 그 사실을 드러내게 한다 (절대 규칙 5).
 */
function executionCounts(snapshot: ImportSnapshot): ExecutionCounts | null {
  const executions = snapshot.snapshot.executions;
  if (!executions) return null;
  const deletedIds = new Set(executions.deleted ?? []);
  return {
    added: executions.added.length,
    changed: executions.before.filter((row) => !deletedIds.has(row.id)).length,
    deleted: deletedIds.size,
  };
}

function executionSummary(snapshot: ImportSnapshot): string {
  const counts = executionCounts(snapshot);
  if (counts === null) return '집행 변경 기록이 스냅샷에 없습니다 — 스냅샷이 손상되었을 수 있습니다';
  return `집행 추가 ${counts.added}건 · 변경 ${counts.changed}건 · 삭제 ${counts.deleted}건`;
}

/** 시트 이름 ↔ 스냅샷 키(테이블 이름). 순서는 양식 시트 순서(GF-1) */
const GOAL_TABLES = [
  { table: 'deliverables', label: '성과목표' },
  { table: 'deliverable_achievements', label: '성과실적' },
  { table: 'tech_targets', label: '기술목표' },
  { table: 'tech_target_records', label: '측정이력' },
] as const;

/** 세지는 않지만 commit_goal_form이 before에 항상 넣는 연계 행 키 — 없으면 원본이 빠진 것이다 */
const GOAL_LINK_TABLES = ['achievement_members', 'task_deliverables', 'task_tech_targets'] as const;

interface GoalSheetCounts extends ExecutionCounts {
  label: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isIdArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((id) => typeof id === 'string');
}

/**
 * GF-11: 시트별 추가·변경·삭제 건수. 변경 = before에 있는데 deleted에 없는 id(IN-14와 같은 셈).
 * jsonb는 매퍼가 검증하지 않으므로 여기서 형태를 확인한다 — 깨졌으면 null을 돌려 손상으로
 * 드러낸다. 0건으로 보이면 "아무것도 안 바뀐 반영"으로 오해한다 (절대 규칙 5).
 */
function goalCounts(snapshot: ImportSnapshot): GoalSheetCounts[] | null {
  const goals: unknown = snapshot.snapshot.goals;
  if (!isRecord(goals)) return null;
  const { added, before, deleted } = goals;
  if (!isRecord(added) || !isRecord(before) || !isRecord(deleted)) return null;
  if (GOAL_LINK_TABLES.some((table) => !Array.isArray(before[table]))) return null;

  const counts: GoalSheetCounts[] = [];
  for (const { table, label } of GOAL_TABLES) {
    const addedIds = added[table];
    const deletedIds = deleted[table];
    const beforeRows = before[table];
    if (!isIdArray(addedIds) || !isIdArray(deletedIds) || !Array.isArray(beforeRows)) return null;

    const beforeIds: string[] = [];
    for (const row of beforeRows) {
      if (!isRecord(row) || typeof row.id !== 'string') return null;
      beforeIds.push(row.id);
    }
    const deletedSet = new Set(deletedIds);
    counts.push({
      label,
      added: addedIds.length,
      changed: new Set(beforeIds.filter((id) => !deletedSet.has(id))).size,
      deleted: deletedSet.size,
    });
  }
  return counts;
}

function goalSummary(snapshot: ImportSnapshot): string {
  const counts = goalCounts(snapshot);
  if (counts === null) return '목표 변경 기록이 스냅샷에 없거나 형식이 깨졌습니다 — 스냅샷이 손상되었을 수 있습니다';
  return counts
    .map((c) => `${c.label} 추가 ${c.added} · 변경 ${c.changed} · 삭제 ${c.deleted}`)
    .join(' / ');
}

export default function ImportSnapshotPanel({ projects }: ImportSnapshotPanelProps) {
  const router = useRouter();

  const [projectId, setProjectId] = useState('');
  const [snapshots, setSnapshots] = useState<ImportSnapshot[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [failure, setFailure] = useState<Failure | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  // 2단계 확인 상태 (K-4와 같은 형태)
  const [target, setTarget] = useState<ImportSnapshot | null>(null);
  const [step, setStep] = useState<1 | 2>(1);
  const [confirmText, setConfirmText] = useState('');
  const [restoring, setRestoring] = useState(false);

  // 과제를 빠르게 바꾸면 먼저 보낸 요청이 늦게 도착해 남의 목록을 덮어쓴다
  const requestSeq = useRef(0);

  const load = useCallback(async (id: string) => {
    const seq = requestSeq.current + 1;
    requestSeq.current = seq;

    if (id === '') {
      setSnapshots(null);
      setLoading(false);
      return;
    }

    setLoading(true);
    setFailure(null);
    const res = await listImportSnapshots(id);
    if (requestSeq.current !== seq) return;

    if (!res.ok) {
      // 빈 목록으로 뭉개지 않는다 — 조회 실패와 "스냅샷 없음"은 다른 사실이다 (절대 규칙 5)
      setSnapshots(null);
      setFailure({ message: res.error, code: res.code });
    } else {
      setSnapshots(res.data);
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    void load(projectId);
  }, [projectId, load]);

  const closeModal = () => {
    setTarget(null);
    setStep(1);
    setConfirmText('');
  };

  const handleRestore = async () => {
    if (!target) return;
    setRestoring(true);
    setFailure(null);
    setNotice(null);
    try {
      const res = await restoreImportSnapshot(target.id);
      if (!res.ok) {
        setFailure({ message: res.error, code: res.code });
        closeModal();
        return;
      }
      // 총괄표 스냅샷의 안내는 종전 그대로다 — 산출근거 스냅샷일 때만 문장이 늘어난다 (D-17a)
      const messages: string[] = [];
      if (isExecutionSnapshot(target)) {
        // IN-14: 수행 스냅샷은 계획액을 건드리지 않는다 — "0건의 계획액" 문장은 오해만 부른다
        messages.push(
          `${target.snapshot.source.fileName} 반영을 되돌렸습니다 — 추가된 집행 ${res.data.executionsDeleted ?? 0}건 삭제, 변경된 집행 ${res.data.executionsReverted ?? 0}건 원래 값으로, 삭제된 집행 ${res.data.executionsRestored ?? 0}건 되살림.`
        );
      } else {
        messages.push(
          `${res.data.restored}건의 계획액을 ${target.snapshot.source.fileName} 반영 직전 상태로 되돌렸습니다.`
        );
      }
      if (res.data.detailsRestored !== undefined) {
        messages.push(
          `산출근거는 현재 ${res.data.detailsDeleted ?? 0}행을 지우고 ${res.data.detailsRestored}행을 되살렸습니다.`
        );
        // D-17b: 스냅샷은 인력을 담지 않는다. 밝히지 않으면 "되돌렸는데 왜 남아 있지"로 헤맨다
        messages.push(
          '임포트가 만든 인력은 명부에 남습니다 — 필요 없으면 인력 화면에서 지우세요.'
        );
      }
      setNotice(messages.join(' '));
      closeModal();
      // 목록 자체는 변하지 않지만(복원은 스냅샷을 만들지 않는다) 예산 화면은 다시 읽어야 한다
      router.refresh();
    } finally {
      setRestoring(false);
    }
  };

  const selected = projects.find((p) => p.id === projectId) ?? null;

  return (
    <section className="mt-4 rounded-2xl border border-grey-200 bg-surface p-6">
      <h2 className="text-lg font-bold">임포트 스냅샷</h2>
      <p className="mt-1 text-sm text-grey-500">
        엑셀 반영 직전의 상태입니다. 잘못 반영했을 때 여기서 되돌립니다. 예산계획 반영(§6.8)은
        계획액을, 산출근거 반영(§6.11)은 계획액과 <strong>삭제된 산출근거 행</strong>까지, 수행
        양식 반영(§6.16)은 <strong>추가·변경·삭제된 집행 내역</strong>을 담습니다. 목표 양식
        반영(§6.17)은 기록으로만 남고 되돌릴 수 없습니다.
      </p>

      {/* I-17의 사실을 그대로 적는다 — 안 적으면 사용자가 "복원의 복원"을 기대한다 */}
      <ul className="mt-4 list-disc space-y-1 rounded-lg bg-grey-50 p-4 pl-8 text-xs text-grey-600">
        <li>
          스냅샷은 <strong>과제별 최근 20개</strong>만 남습니다. 21번째 반영이 들어오면 가장 오래된
          것부터 사라집니다.
        </li>
        <li>
          <strong>되돌리기는 새 스냅샷을 만들지 않습니다.</strong> 복원분이 끼어들면 20개 창이
          복원 조작으로 밀려 정작 되돌릴 임포트 이력이 사라지기 때문입니다 — 즉{' '}
          <strong>되돌리기를 다시 되돌릴 수는 없습니다.</strong>
        </li>
        <li>
          <strong>되돌리기는 비목 행을 삭제하지 않습니다.</strong> 임포트 시점에 없던 행은 계획액 0,
          현금·현물 미입력 상태로 되돌릴 뿐입니다. 행을 지우면 임포트 <strong>이후</strong>에 그
          비목에 등록한 집행 내역이 함께 사라집니다.
        </li>
        <li>
          <strong>산출근거 스냅샷은 산출근거 행을 되돌립니다</strong> (D-17a) — 그 (연차, 비목)의
          현재 산출근거를 지우고 스냅샷의 행을 되살립니다. 다만{' '}
          <strong>임포트가 만든 인력은 명부에 남습니다</strong> (D-17b). 필요 없으면 인력 화면에서
          지우세요.
        </li>
        <li>
          <strong>수행 양식 스냅샷은 반영 전체를 되돌립니다</strong> (IN-14) — 반영으로 추가된 집행은
          삭제되고, 바뀐 집행은 원래 값으로, 삭제된 집행은 되살아납니다. 반영 뒤 그 집행을 다시
          고쳤거나 지웠다면 되돌리기 전체가 거부됩니다.
        </li>
        <li>
          <strong>목표 양식 스냅샷은 되돌릴 수 없습니다</strong> (GF-11) — 반영 기록용입니다. 성과목표·
          성과실적·기술목표·측정이력의 추가·변경·삭제 건수만 보여 줍니다.
        </li>
      </ul>

      <label className="mt-5 block">
        <span className="text-sm font-medium text-grey-700">과제</span>
        <select
          value={projectId}
          onChange={(e) => {
            setProjectId(e.target.value);
            setNotice(null);
          }}
          className="mt-1 w-full rounded-lg border border-grey-300 bg-surface px-3 py-2 text-sm focus:border-grey-500 focus:outline-none"
        >
          <option value="">과제를 고르세요</option>
          {projects.map((project) => (
            <option key={project.id} value={project.id}>
              {project.archived ? `${project.name} (보관됨)` : project.name}
            </option>
          ))}
        </select>
      </label>

      {failure && (
        <ErrorBanner
          message={failure.message}
          code={failure.code}
          onRetry={() => void load(projectId)}
          onDismiss={() => setFailure(null)}
          className="mt-4"
        />
      )}

      {notice && (
        <p
          role="status"
          className="mt-4 rounded-lg border border-green-200 bg-green-50 p-3 text-sm text-green-800"
        >
          {notice}
        </p>
      )}

      <div className="mt-4">
        {projectId === '' ? (
          <p className="rounded-lg border border-dashed border-grey-300 p-4 text-sm text-grey-500">
            과제를 고르세요. 스냅샷은 과제별로 보관됩니다.
          </p>
        ) : loading ? (
          <p className="text-sm text-grey-500">불러오는 중…</p>
        ) : snapshots === null ? null : snapshots.length === 0 ? (
          <p className="rounded-lg border border-dashed border-grey-300 p-4 text-sm text-grey-500">
            {selected?.name ?? '이 과제'}에 아직 엑셀 반영 이력이 없습니다.
          </p>
        ) : (
          <ul className="divide-y divide-grey-100 rounded-xl border border-grey-200">
            {snapshots.map((snapshot, index) => (
              <li key={snapshot.id} className="flex flex-wrap items-center gap-3 p-4">
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="break-all text-sm font-semibold text-grey-800">
                      {snapshot.snapshot.source.fileName}
                    </span>
                    {/* 세 종류가 한 목록에 섞이고 복원 범위가 다르다 (D-17a, IN-14) */}
                    <Badge tone="neutral">{kindLabel(snapshot)}</Badge>
                    {index === 0 && <Badge tone="blue">최근 반영</Badge>}
                  </div>
                  <p className="mt-1 text-xs text-grey-500">
                    {new Date(snapshot.snapshot.capturedAt).toLocaleString('ko-KR')} ·{' '}
                    {snapshot.snapshot.source.sheetName} 시트
                  </p>
                  {isGoalSnapshot(snapshot) ? (
                    <>
                      <p
                        className={`mt-1 text-xs ${goalCounts(snapshot) === null ? 'text-red-600' : 'text-grey-500'}`}
                      >
                        {goalSummary(snapshot)}
                      </p>
                      <p className="mt-1 text-xs text-grey-500">{GOAL_RESTORE_BLOCKED} (GF-11)</p>
                    </>
                  ) : isExecutionSnapshot(snapshot) ? (
                    <p
                      className={`mt-1 text-xs ${executionCounts(snapshot) === null ? 'text-red-600' : 'text-grey-500'}`}
                    >
                      {executionSummary(snapshot)}
                    </p>
                  ) : (
                    <p className="mt-1 text-xs text-grey-500">
                      연차 {yearCount(snapshot)}개 · 비목 {snapshot.snapshot.items.length}칸 · 되돌리면
                      계획액 합계 {formatAmount(restoredTotal(snapshot), '원')}
                    </p>
                  )}
                </div>
                <Button
                  size="sm"
                  variant="danger"
                  // GF-11: 목표 양식 스냅샷은 복원 경로가 없다 — 모달조차 열지 않는다
                  disabled={isGoalSnapshot(snapshot)}
                  title={isGoalSnapshot(snapshot) ? GOAL_RESTORE_BLOCKED : undefined}
                  onClick={() => {
                    setTarget(snapshot);
                    setStep(1);
                    setConfirmText('');
                    setNotice(null);
                  }}
                >
                  되돌리기…
                </Button>
              </li>
            ))}
          </ul>
        )}
      </div>

      <Modal
        open={target !== null}
        title={`임포트 되돌리기 — 확인 ${step}/2`}
        onClose={closeModal}
        closeOnBackdrop={false}
        footer={
          <>
            <Button onClick={closeModal} disabled={restoring}>
              취소
            </Button>
            {step === 1 ? (
              <Button variant="danger" onClick={() => setStep(2)}>
                다음
              </Button>
            ) : (
              <Button
                variant="danger"
                onClick={() => void handleRestore()}
                disabled={confirmText !== CONFIRM_WORD || restoring}
              >
                {restoring ? '되돌리는 중…' : '되돌리기 실행'}
              </Button>
            )}
          </>
        }
      >
        {target && (
          <>
            <dl className="space-y-1 rounded-lg bg-grey-50 p-3 text-sm">
              <div className="flex gap-2">
                <dt className="w-24 shrink-0 text-grey-500">파일</dt>
                <dd className="break-all">{target.snapshot.source.fileName}</dd>
              </div>
              <div className="flex gap-2">
                <dt className="w-24 shrink-0 text-grey-500">반영 시각</dt>
                <dd>{new Date(target.snapshot.capturedAt).toLocaleString('ko-KR')}</dd>
              </div>
              {isExecutionSnapshot(target) ? (
                <div className="flex gap-2">
                  <dt className="w-24 shrink-0 text-grey-500">되돌릴 범위</dt>
                  <dd>{executionSummary(target)}</dd>
                </div>
              ) : (
                <>
                  <div className="flex gap-2">
                    <dt className="w-24 shrink-0 text-grey-500">되돌릴 범위</dt>
                    <dd>
                      연차 {yearCount(target)}개 · 비목 {target.snapshot.items.length}칸
                    </dd>
                  </div>
                  <div className="flex gap-2">
                    <dt className="w-24 shrink-0 text-grey-500">계획액 합계</dt>
                    <dd>{formatAmount(restoredTotal(target), '원')}</dd>
                  </div>
                </>
              )}
            </dl>

            {step === 1 && isExecutionSnapshot(target) ? (
              // IN-14: 총괄표 안내("집행 내역은 지워지지 않습니다")가 여기선 정반대라 문장을 통째로 바꾼다
              <div className="mt-4 space-y-2 text-sm text-grey-600">
                <p>
                  이 반영 전체가 되돌아갑니다 —{' '}
                  <strong className="text-red-600">
                    이 반영으로 추가된 집행은 삭제되고, 바뀐 집행은 반영 전 값으로 돌아가며, 삭제된
                    집행은 되살아납니다.
                  </strong>
                </p>
                <p>
                  반영 뒤 그 집행을 다시 고쳤거나 지웠다면 일부만 되돌리지 않고{' '}
                  <strong>전체를 거부</strong>합니다 (IN-14). 계획액은 바뀌지 않습니다.
                </p>
                <p>
                  되돌리기는 <strong>새 스냅샷을 만들지 않으므로 이 조작을 다시 되돌릴 수
                  없습니다</strong> (I-17).
                </p>
              </div>
            ) : step === 1 ? (
              <div className="mt-4 space-y-2 text-sm text-grey-600">
                <p>
                  이 반영으로 바뀐 <strong className="text-red-600">계획액이 반영 직전 값으로
                  되돌아갑니다.</strong> 반영 이후에 손으로 고친 계획액도 함께 사라집니다.
                </p>
                <p>
                  되돌리기는 <strong>새 스냅샷을 만들지 않으므로 이 조작을 다시 되돌릴 수
                  없습니다</strong> (I-17). 집행 내역과 행 자체는 지워지지 않습니다.
                </p>
                {/* 산출근거 스냅샷만 행을 지운다 — 총괄표 스냅샷의 안내는 종전 그대로다 (D-17a) */}
                {isDetailSnapshot(target) && (
                  <p>
                    이 스냅샷은 <strong>산출근거</strong>도 담고 있어, 대상 비목의 현재 산출근거 행을
                    지우고 스냅샷의 행을 되살립니다 (D-17a). 다만{' '}
                    <strong className="text-grey-800">
                      임포트가 만든 인력은 명부에 남습니다
                    </strong>{' '}
                    (D-17b) — 필요 없으면 인력 화면에서 지우세요.
                  </p>
                )}
              </div>
            ) : (
              <div className="mt-4">
                <p className="text-sm text-red-700">
                  마지막 확인입니다. 계속하려면 아래에 <strong>{CONFIRM_WORD}</strong>라고 입력하세요.
                </p>
                <input
                  type="text"
                  value={confirmText}
                  onChange={(e) => setConfirmText(e.target.value)}
                  placeholder={CONFIRM_WORD}
                  className="mt-2 w-full rounded-lg border border-grey-300 px-3 py-2 text-sm focus:border-red-500 focus:outline-none"
                />
              </div>
            )}
          </>
        )}
      </Modal>
    </section>
  );
}
