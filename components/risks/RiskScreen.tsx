'use client';

// 리스크 관리대장 화면 컨테이너 (SOT §7.11, §6.5, §8.4 O-2·O-3, §8.5 R-4)
// 데이터는 전부 서버(page.tsx → getRiskMatrix)가 조회해 내려준다.
// 점수·등급·주의 필요 판정은 lib/risk.ts를 호출한 결과(RiskView)만 쓴다 — 화면에서
// probability × impact를 다시 계산하지 않는다 (§5.13, §6.5).
// 쓰기는 전부 actions/risks.ts를 거친다. supabase를 직접 부르지 않는다 (§8.2 C-2).

import { useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import type { ActionResult, Risk, RiskStatus, Year } from '@/types';
import type { ActionErrorCode } from '@/lib/db/errors';
import type { RiskMatrixData, RiskView } from '@/actions/risks';
import { deleteRisk, reorderRisks, setRiskStatus } from '@/actions/risks';
import { RISK_STATUS_LABELS } from '@/lib/constants';
import Button from '@/components/ui/Button';
import ErrorBanner from '@/components/ui/ErrorBanner';
import Modal from '@/components/ui/Modal';
import RiskMatrix, { type MatrixSelection } from './RiskMatrix';
import RiskTable from './RiskTable';
import RiskFormModal from './RiskFormModal';

/** §5.5: name이 있으면 name, 없으면 order+1 + '차년도' */
function yearLabel(year: Year): string {
  return year.name.trim() || `${year.order + 1}차년도`;
}

// 점수순은 §7.11의 기본값이다. 수동 순서는 reorderRisks(§9)로 정한 순서를 그대로 본다 —
// 점수순 화면에서 ↑↓를 누르면 순서가 즉시 다시 흐트러져 사용자가 이해할 수 없기 때문에
// 두 모드를 나눈다.
type SortMode = 'score' | 'manual';

export interface RiskScreenProps {
  data: RiskMatrixData;
}

export default function RiskScreen({ data }: RiskScreenProps) {
  const router = useRouter();
  const [formMode, setFormMode] = useState<'create' | 'edit' | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [showResolved, setShowResolved] = useState(false); // §7.11 해결/종료 기본 숨김
  const [selectedCell, setSelectedCell] = useState<MatrixSelection | null>(null);
  const [sortMode, setSortMode] = useState<SortMode>('score');
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<{ message: string; code?: ActionErrorCode } | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const byId = useMemo(
    () => new Map(data.risks.map((view) => [view.risk.id, view.risk])),
    [data.risks]
  );
  const yearNameById = useMemo(
    () => new Map(data.years.map((year) => [year.id, yearLabel(year)])),
    [data.years]
  );
  const memberNameById = useMemo(
    () => new Map(data.members.map((member) => [member.id, member.name])),
    [data.members]
  );
  const taskById = useMemo(() => new Map(data.tasks.map((task) => [task.id, task])), [data.tasks]);

  // §7.11: 해결/종료 기본 숨김 → 매트릭스 셀 클릭 필터 순으로 좁힌다.
  // 정렬은 서버가 이미 끝냈다(점수 내림차순). 수동 순서 모드에서만 order로 다시 세운다.
  const visible = useMemo<RiskView[]>(() => {
    const filtered = data.risks.filter((view) => {
      if (!showResolved && !view.active) return false;
      if (selectedCell === null) return true;
      return (
        view.risk.probability === selectedCell.probability &&
        view.risk.impact === selectedCell.impact
      );
    });
    if (sortMode === 'manual') {
      return [...filtered].sort(
        (a, b) => a.risk.order - b.risk.order || a.risk.title.localeCompare(b.risk.title, 'ko')
      );
    }
    return filtered;
  }, [data.risks, showResolved, selectedCell, sortMode]);

  // 남이 지운 항목의 확장 상태가 남아 있으면 다음 조작이 엉뚱한 행을 가리킨다
  useEffect(() => {
    if (expandedId !== null && !byId.has(expandedId)) setExpandedId(null);
  }, [byId, expandedId]);

  // 편집·삭제 대상은 매번 최신 props에서 다시 찾는다 — O-3의 "다시 불러오기"가 모달까지 닿는 경로다
  const editingRisk = editingId === null ? undefined : byId.get(editingId);
  const deletingRisk = deletingId === null ? null : (byId.get(deletingId) ?? null);

  async function run<T>(
    action: () => Promise<ActionResult<T>>,
    onSuccess: (data: T) => void
  ): Promise<void> {
    setBusy(true);
    setFailure(null);
    try {
      const res = await action();
      if (!res.ok) {
        setFailure({ message: res.error, code: res.code });
        return;
      }
      onSuccess(res.data);
      router.refresh();
    } finally {
      setBusy(false);
    }
  }

  // 사라진 행을 조작하려 할 때 조용히 넘기지 않는다 (절대 규칙 5)
  const requireRisk = (id: string): Risk | null => {
    const risk = byId.get(id);
    if (!risk) {
      setFailure({
        message: '대상 리스크가 더 이상 없습니다. 다른 사용자가 삭제했을 수 있습니다.',
      });
      return null;
    }
    return risk;
  };

  // O-2: 상태 드롭다운은 사용자가 만지는 필드가 하나뿐이라 낙관적 잠금 없이 저장한다
  const handleStatusChange = (id: string, status: RiskStatus): void => {
    const risk = requireRisk(id);
    if (!risk) return;
    void run(
      () => setRiskStatus(id, status),
      () => setNotice(`${risk.title} 상태를 '${RISK_STATUS_LABELS[status]}'로 바꿨습니다.`)
    );
  };

  // X-3: RPC는 넘긴 id 전부에 0..n-1을 부여한다. 화면에 보이는 일부만 넘기면 숨겨진 행의
  // order와 충돌하므로 **과제의 모든 리스크**를 수동 순서대로 세운 뒤 그 안에서 옮긴다.
  const handleMove = (id: string, direction: -1 | 1): void => {
    const risk = requireRisk(id);
    if (!risk) return;

    const full = [...data.risks]
      .sort((a, b) => a.risk.order - b.risk.order || a.risk.title.localeCompare(b.risk.title, 'ko'))
      .map((view) => view.risk.id);

    const visibleIds = visible.map((view) => view.risk.id);
    const visibleIndex = visibleIds.indexOf(id);
    const neighborId = visibleIds[visibleIndex + direction];
    // 목록 끝에서는 버튼이 비활성이라 여기 오지 않는다. 와도 조용히 성공시키지 않는다.
    if (neighborId === undefined) {
      setFailure({ message: '더 이상 옮길 수 없습니다.' });
      return;
    }

    const from = full.indexOf(id);
    const to = full.indexOf(neighborId);
    if (from < 0 || to < 0) {
      setFailure({ message: '순서를 계산하지 못했습니다. 목록을 새로고침하세요.' });
      return;
    }

    const next = [...full];
    next.splice(from, 1);
    next.splice(to, 0, id);

    void run(
      () => reorderRisks(data.projectId, next),
      () => setNotice(`${risk.title}의 순서를 바꿨습니다.`)
    );
  };

  const handleDelete = (risk: Risk): void => {
    void run(
      () => deleteRisk(risk.id),
      () => {
        setDeletingId(null);
        if (expandedId === risk.id) setExpandedId(null);
        setNotice(`${risk.title} 리스크를 삭제했습니다.`);
      }
    );
  };

  return (
    <div>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm text-grey-600">
          미해결 {data.activeCount}건
          {data.highCount > 0 && (
            <span className="ml-2 font-semibold text-red-700">고위험 {data.highCount}건</span>
          )}
          {data.attentionCount > 0 && (
            <span className="ml-2 font-semibold text-orange-700">
              주의 필요 {data.attentionCount}건
            </span>
          )}
          {data.resolvedCount > 0 && (
            <span className="ml-2 text-grey-400">해결·종료 {data.resolvedCount}건</span>
          )}
        </p>
        <Button
          size="sm"
          variant="primary"
          disabled={busy}
          className="print:hidden" // P-R4
          onClick={() => {
            setEditingId(null);
            setFormMode('create');
          }}
        >
          리스크 추가
        </Button>
      </div>

      {failure && (
        <ErrorBanner
          message={failure.message}
          code={failure.code}
          onDismiss={() => setFailure(null)}
          className="mt-3 print:hidden"
        />
      )}

      {notice && (
        <div
          role="status"
          className="mt-3 flex items-start justify-between gap-4 rounded-xl border border-grey-200 bg-grey-50 p-3 text-sm text-grey-700 print:hidden"
        >
          <p className="min-w-0 break-words">{notice}</p>
          <button
            type="button"
            onClick={() => setNotice(null)}
            aria-label="알림 닫기"
            className="shrink-0 font-bold text-grey-400 hover:text-grey-600"
          >
            ×
          </button>
        </div>
      )}

      {/* P-R4: 5×5 히트맵은 클릭 필터용 버튼 격자다. 종이에서는 조작할 수 없어 대장만 남긴다 */}
      <div className="mt-4 print:hidden">
        <RiskMatrix
          cells={data.cells}
          showResolved={showResolved}
          selected={selectedCell}
          onSelect={setSelectedCell}
        />
      </div>

      {/* P-R4: 필터·정렬은 편집 컨트롤이다. 인쇄물에는 그 결과(대장)만 남는다 */}
      <div className="mt-4 flex flex-wrap items-center gap-x-4 gap-y-2 print:hidden">
        {/* §7.11: 해결/종료 항목은 기본 숨김, 토글로 표시 */}
        <label className="flex items-center gap-2 text-sm text-grey-700">
          <input
            type="checkbox"
            checked={showResolved}
            onChange={(e) => setShowResolved(e.target.checked)}
            className="h-4 w-4 rounded border-grey-300"
          />
          해결·종료 항목 표시
        </label>

        <label className="flex items-center gap-2 text-sm text-grey-700">
          정렬
          <select
            value={sortMode}
            onChange={(e) => setSortMode(e.target.value as SortMode)}
            className="rounded-md border border-grey-300 bg-white px-2 py-1 text-xs font-medium focus:border-grey-500 focus:outline-none"
          >
            <option value="score">점수 내림차순 (기본)</option>
            <option value="manual">수동 순서</option>
          </select>
        </label>

        {selectedCell !== null && (
          <div className="flex items-center gap-2 rounded-full bg-blue-50 px-3 py-1 text-xs text-blue-800">
            <span>
              발생가능성 {selectedCell.probability} × 영향도 {selectedCell.impact} 필터
            </span>
            <button
              type="button"
              onClick={() => setSelectedCell(null)}
              aria-label="매트릭스 필터 해제"
              className="font-bold text-blue-500 hover:text-blue-800"
            >
              ×
            </button>
          </div>
        )}

        <span className="text-xs text-grey-500">표시 {visible.length}건</span>
      </div>

      <div className="mt-3">
        <RiskTable
          views={visible}
          projectId={data.projectId}
          projectName={data.projectName}
          todayISO={data.todayISO}
          memberNameById={memberNameById}
          yearNameById={yearNameById}
          taskById={taskById}
          busy={busy}
          expandedId={expandedId}
          manualOrder={sortMode === 'manual'}
          onToggleExpand={(id) => setExpandedId((prev) => (prev === id ? null : id))}
          onStatusChange={handleStatusChange}
          onMove={handleMove}
          onEdit={(id) => {
            setEditingId(id);
            setFormMode('edit');
          }}
          onDelete={(id) => setDeletingId(id)}
        />
      </div>

      {formMode && (
        <RiskFormModal
          mode={formMode}
          projectId={data.projectId}
          risk={formMode === 'edit' ? editingRisk : undefined}
          years={data.years}
          members={data.members}
          tasks={data.tasks}
          onClose={() => {
            setFormMode(null);
            setEditingId(null);
          }}
          onSaved={() => {
            setFormMode(null);
            setEditingId(null);
            router.refresh();
          }}
        />
      )}

      {deletingRisk && (
        <Modal
          open
          title="리스크를 삭제합니다"
          onClose={() => setDeletingId(null)}
          closeOnBackdrop={false}
          footer={
            <>
              <Button size="sm" onClick={() => setDeletingId(null)} disabled={busy}>
                취소
              </Button>
              <Button
                size="sm"
                variant="danger"
                disabled={busy}
                onClick={() => handleDelete(deletingRisk)}
              >
                {busy ? '삭제 중…' : '삭제'}
              </Button>
            </>
          }
        >
          <p className="text-sm text-grey-700">
            <strong>{deletingRisk.title}</strong> 리스크를 삭제합니다.
          </p>
          <p className="mt-3 rounded-lg bg-orange-50 p-3 text-xs text-orange-800">
            대응 방안·비상 계획도 함께 지워집니다. 종료된 리스크는 삭제 대신 상태를
            &lsquo;종결&rsquo;로 두면 기록이 남습니다.
          </p>
        </Modal>
      )}
    </div>
  );
}
