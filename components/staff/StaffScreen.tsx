'use client';

// 조직원 화면 컨테이너 (SOT §7.18, §5.19 ST-2·ST-3, §6.13 HR-7·HR-12·HR-17, §6.15)
// 데이터는 전부 서버(app/staff/page.tsx)가 조회해 내려준다. 여기서는 탭·검색·모달 상태와 성공 후
// router.refresh()만 소유한다. supabase는 직접 부르지 않는다 — 쓰기는 actions/staff.ts 경유.
// 퇴사자 표시는 URL(retired=1)로 서버가 다시 조회한다(page.tsx 주석). 검색은 받은 목록 안의 필터다.
// 사내 명부: 사용자가 버튼을 눌렀을 때만 HR을 부르고(HR-7), 키는 키체인에서 읽어 서버 액션 인자로만
// 넘기며(HR-13), 모달을 닫으면 state를 null로 돌려 명부를 버린다(HR-17).

import { useMemo, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import type { ActionErrorCode } from '@/lib/db/errors';
import { loadHrApiKey } from '@/lib/hr-key';
import {
  countStaffReferences,
  createStaffFromHr,
  deleteStaff,
  type StaffListItem,
  type StaffReferenceCounts,
} from '@/actions/staff';
import { fetchHrDirectoryForStaff } from '@/actions/team';
import Button from '@/components/ui/Button';
import ErrorBanner from '@/components/ui/ErrorBanner';
import Modal from '@/components/ui/Modal';
import HelpLink from '@/components/help/HelpLink';
import HrDirectoryModal, {
  type HrDirectoryState,
  type HrImportSummary,
  type HrSubmitDraft,
} from '@/components/team/HrDirectoryModal';
import StaffList from './StaffList';
import StaffFormModal from './StaffFormModal';
import StaffDetailPanel from '@/components/staff/StaffDetailPanel';
import ParticipationMatrix from '@/components/staff/ParticipationMatrix';

type Tab = 'list' | 'participation';

const TABS: readonly { key: Tab; label: string }[] = [
  { key: 'list', label: '목록' },
  { key: 'participation', label: '참여율' },
];

type FormState = { mode: 'create' } | { mode: 'edit'; staffId: string } | null;

interface DeleteState {
  item: StaffListItem;
  counts: StaffReferenceCounts | null;
  countsLoading: boolean;
  /** ST-2 2단계 확인: 1 = 영향 건수 확인, 2 = 최종 확인 */
  stage: 1 | 2;
}

function matchesQuery(item: StaffListItem, query: string): boolean {
  if (query === '') return true;
  return (
    item.staff.name.toLowerCase().includes(query) || item.staff.email.toLowerCase().includes(query)
  );
}

export interface StaffScreenProps {
  items: StaffListItem[];
  includeRetired: boolean;
}

export default function StaffScreen({ items, includeRetired }: StaffScreenProps) {
  const router = useRouter();
  const [tab, setTab] = useState<Tab>('list');
  const [query, setQuery] = useState('');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [form, setForm] = useState<FormState>(null);
  const [deleting, setDeleting] = useState<DeleteState | null>(null);
  const [hrState, setHrState] = useState<HrDirectoryState | null>(null);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<{ message: string; code?: ActionErrorCode } | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  // 참여율 탭의 초기 연도. 연도 선택은 ParticipationMatrix가 갖는다 — 여기서는 첫 값만 준다
  const [initialYear] = useState(() => new Date().getFullYear());

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    return items.filter((item) => matchesQuery(item, q));
  }, [items, query]);

  const byId = useMemo(() => new Map(items.map((item) => [item.staff.id, item])), [items]);
  const editing = form?.mode === 'edit' ? (byId.get(form.staffId)?.staff ?? undefined) : undefined;
  // 삭제·남의 수정으로 선택한 행이 목록에서 사라지면 패널도 닫는다 — 없는 조직원의 패널은 뜻이 없다
  const selectedExists = selectedId !== null && byId.has(selectedId);

  const refresh = (): void => {
    setFailure(null);
    router.refresh();
  };

  const toggleRetired = (): void => {
    router.push(includeRetired ? '/staff' : '/staff?retired=1');
  };

  // ─── 사내 명부 (ST-3) ─────────────────────────────────────────────────────

  // HR-7: 사용자가 버튼을 눌렀을 때만 HR을 부른다. 키 원문은 이 핸들러의 지역 변수로만 쓴다 —
  // 상태에 두면 React DevTools·오류 리포트에 실릴 수 있다.
  const openHrDirectory = async (): Promise<void> => {
    setHrState({ phase: 'loading' });
    let key: string | null;
    try {
      key = (await loadHrApiKey()).key;
    } catch (e) {
      setHrState({ phase: 'error', message: e instanceof Error ? e.message : String(e) });
      return;
    }
    if (key === null) {
      // HR-12: 키가 없다는 사실을 모달 안에서 밝힌다(설정 링크 포함). 버튼을 감추지 않는다
      setHrState({ phase: 'no-key' });
      return;
    }
    const res = await fetchHrDirectoryForStaff(key);
    if (!res.ok) {
      setHrState({ phase: 'error', message: res.error, code: res.code });
      return;
    }
    setHrState({ phase: 'ready', directory: res.data });
  };

  // createStaffFromHr는 키를 받지 않는다(결정 ②) — 명부는 이미 받았고 초안만 보낸다.
  // HR의 retired는 employed 초기값으로만 쓰인다(HR-7·ST-3)
  const submitHrDrafts = async (drafts: HrSubmitDraft[]) => {
    const res = await createStaffFromHr(drafts);
    if (!res.ok) return res;
    return {
      ok: true as const,
      data: { createdCount: res.data.created.length, rejected: res.data.rejected },
    };
  };

  // HR-2의 조직원판: 급여는 명부에 없으므로 이력이 비어 있다는 사실을 남긴다
  const handleHrAdded = (result: HrImportSummary): void => {
    const skipped =
      result.rejected.length === 0
        ? ''
        : ` (${result.rejected.length}명은 이미 등록되어 건너뜀: ${result.rejected
            .map((r) => r.name)
            .join(', ')})`;
    setNotice(
      `${result.createdCount}명을 조직원으로 추가했습니다. 급여는 사내 명부에 없어 이력이 비어 있습니다 — 행을 눌러 급여 이력을 추가하세요${skipped}`
    );
    setHrState(null);
    refresh();
  };

  // ─── 삭제 (ST-2) ──────────────────────────────────────────────────────────

  const openDelete = (item: StaffListItem): void => {
    setDeleting({ item, counts: null, countsLoading: true, stage: 1 });
    void countStaffReferences(item.staff.id).then((res) => {
      if (!res.ok) {
        // 건수를 못 읽었다면 삭제 판단 근거가 없다 — 모달을 닫고 실패를 그대로 알린다
        setDeleting(null);
        setFailure({ message: res.error, code: res.code });
        return;
      }
      setDeleting((prev) =>
        prev && prev.item.staff.id === item.staff.id
          ? { ...prev, counts: res.data, countsLoading: false }
          : prev
      );
    });
  };

  const handleDelete = async (state: DeleteState): Promise<void> => {
    setBusy(true);
    setFailure(null);
    try {
      const res = await deleteStaff(state.item.staff.id);
      if (!res.ok) {
        setFailure({ message: res.error, code: res.code });
        return;
      }
      const counts = state.counts;
      setDeleting(null);
      if (selectedId === state.item.staff.id) setSelectedId(null);
      setNotice(
        counts === null
          ? `${state.item.staff.name}님을 삭제했습니다.`
          : `${state.item.staff.name}님을 삭제했습니다. 급여 이력 ${counts.salaries}건이 함께 지워졌고, 연결 인력 ${counts.members}건은 연결만 끊겼습니다.`
      );
      refresh();
    } finally {
      setBusy(false);
    }
  };

  return (
    <div>
      <div className="mb-6 flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="flex items-center gap-2">
            <h1 className="text-t3 font-bold text-grey-900">조직원</h1>
            {/* 도움말 slug는 임시로 settings — 다음 Phase에서 staff 도움말이 추가되면 교체한다 */}
            <HelpLink slug="settings" />
          </div>
          {/* §5.19: 과제 Member와 다른 마스터다 — 무엇을 하는 화면인지 한 줄로 밝힌다 */}
          <p className="mt-1 text-sm text-grey-500">
            회사 직원 마스터입니다. 과제 인력을 조직원에 연결하면 급여 기준을 공유하고 전 과제 참여율을
            합산할 수 있습니다. 급여를 고쳐도 과제 인건비는 자동으로 바뀌지 않습니다.
          </p>
        </div>
        <Link href="/" className="shrink-0 text-sm text-grey-500 underline hover:text-grey-700">
          홈으로
        </Link>
      </div>

      <div role="tablist" className="mb-4 flex gap-1 border-b border-hairline print:hidden">
        {TABS.map((t) => (
          <button
            key={t.key}
            type="button"
            role="tab"
            aria-selected={tab === t.key}
            onClick={() => setTab(t.key)}
            className={`-mb-px border-b-2 px-4 py-2 text-sm font-semibold transition ${
              tab === t.key
                ? 'border-blue-500 text-blue-600'
                : 'border-transparent text-grey-500 hover:text-grey-700'
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>

      {failure && (
        <ErrorBanner
          message={failure.message}
          code={failure.code}
          onDismiss={() => setFailure(null)}
          className="mb-4"
        />
      )}
      {notice && (
        <div
          role="status"
          className="mb-4 flex items-start justify-between gap-3 rounded-xl border border-green-100 bg-green-50 p-3 text-sm text-green-600"
        >
          <span>{notice}</span>
          <button
            type="button"
            onClick={() => setNotice(null)}
            aria-label="알림 닫기"
            className="font-bold opacity-60 hover:opacity-100"
          >
            ×
          </button>
        </div>
      )}

      {tab === 'list' && (
        <section>
          <div className="mb-3 flex flex-wrap items-center gap-2">
            <input
              type="search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="이름 또는 이메일로 검색"
              aria-label="이름 또는 이메일로 검색"
              className="w-full max-w-xs rounded-md border border-grey-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none focus:ring-2 focus:ring-blue-100"
            />
            <label className="flex items-center gap-1.5 text-sm text-grey-600">
              <input type="checkbox" checked={includeRetired} onChange={toggleRetired} />
              퇴사자 표시
            </label>
            <span className="text-xs text-grey-500">
              {visible.length}명 표시{includeRetired ? ' · 퇴사자 포함' : ''}
            </span>
            <div className="ml-auto flex gap-2">
              {/* ST-3·HR-12: 키가 없어도 버튼은 보인다 — 모달이 등록 안내를 띄운다 */}
              <Button size="sm" disabled={busy} onClick={() => void openHrDirectory()}>
                사내 명부에서 추가
              </Button>
              <Button size="sm" variant="primary" disabled={busy} onClick={() => setForm({ mode: 'create' })}>
                조직원 추가
              </Button>
            </div>
          </div>

          <StaffList
            items={visible}
            filtered={query.trim() !== ''}
            selectedId={selectedExists ? selectedId : null}
            busy={busy}
            onSelect={setSelectedId}
            onEdit={(item) => setForm({ mode: 'edit', staffId: item.staff.id })}
            onDelete={openDelete}
          />
        </section>
      )}

      {tab === 'participation' && (
        <ParticipationMatrix
          initialYear={initialYear}
          // 매트릭스의 이름 클릭도 같은 상세 패널을 연다 — 퇴사자는 목록에 없을 수 있어 URL 토글 없이 패널만 연다
          onSelectStaff={setSelectedId}
        />
      )}

      {/* 상세 패널은 오른쪽 드로어(T9)라 탭과 무관하게 여기서 한 번만 그린다 */}
      {selectedId !== null && (tab === 'participation' || selectedExists) && (
        <StaffDetailPanel
          staffId={selectedId}
          onClose={() => setSelectedId(null)}
          onChanged={refresh}
        />
      )}

      {form?.mode === 'create' && (
        <StaffFormModal
          mode="create"
          onClose={() => setForm(null)}
          onSaved={(saved) => {
            setForm(null);
            setNotice(`${saved.name}님을 추가했습니다. 행을 눌러 급여 이력을 추가하세요.`);
            refresh();
          }}
        />
      )}
      {form?.mode === 'edit' && editing && (
        <StaffFormModal
          mode="edit"
          staff={editing}
          onClose={() => setForm(null)}
          onSaved={() => {
            setForm(null);
            refresh();
          }}
        />
      )}

      {hrState && (
        <HrDirectoryModal
          state={hrState}
          title="사내 명부에서 조직원 추가"
          description="이름·직위·이메일만 채워집니다. 재직 여부는 사내 명부의 재직 상태로 처음 한 번만 잡고 이후 동기화하지 않습니다. 급여는 명부에 없으므로 추가한 뒤 이력으로 쌓으세요."
          submit={submitHrDrafts}
          onClose={() => setHrState(null)}
          onAdded={handleHrAdded}
        />
      )}

      {deleting && (
        <Modal
          open
          title={deleting.stage === 1 ? '조직원을 삭제합니다' : '정말 삭제할까요?'}
          onClose={() => setDeleting(null)}
          closeOnBackdrop={false}
          footer={
            <>
              <Button size="sm" onClick={() => setDeleting(null)} disabled={busy}>
                취소
              </Button>
              {deleting.stage === 1 ? (
                <Button
                  size="sm"
                  variant="primary"
                  // 무엇이 정리되는지 모른 채 다음 단계로 가지 않는다
                  disabled={busy || deleting.countsLoading || deleting.counts === null}
                  onClick={() => setDeleting({ ...deleting, stage: 2 })}
                >
                  다음
                </Button>
              ) : (
                <Button
                  size="sm"
                  variant="danger"
                  disabled={busy}
                  onClick={() => void handleDelete(deleting)}
                >
                  {busy ? '삭제 중…' : '삭제'}
                </Button>
              )}
            </>
          }
        >
          <p className="text-sm text-grey-700">
            <strong>{deleting.item.staff.name}</strong>
            <span className="text-grey-500"> ({deleting.item.staff.email})</span>
          </p>

          {deleting.countsLoading && (
            <p className="mt-3 text-sm text-grey-500">참조 건수를 확인하는 중…</p>
          )}

          {deleting.counts && (
            <div className="mt-3 space-y-2 rounded-lg bg-grey-50 p-3 text-sm text-grey-700">
              {/* ST-2: set null — 과제 예산은 조직원 마스터에 종속되지 않는다 */}
              <p>
                연결 인력 <strong className="tabular-nums">{deleting.counts.members}건</strong>은
                연결만 끊기고 연봉·기준은 남습니다.
              </p>
              {/* ST-2: cascade */}
              <p>
                급여 이력 <strong className="tabular-nums">{deleting.counts.salaries}건</strong>은
                함께 삭제됩니다.
              </p>
            </div>
          )}

          {deleting.stage === 2 && (
            <p className="mt-3 rounded-lg border border-red-100 bg-red-50 p-3 text-sm text-red-700">
              되돌릴 수 없습니다. 퇴사자라면 삭제 대신 편집에서 <strong>재직 중</strong>을 끄는 것을
              권장합니다 — 지난 과제의 참여율 합산에 이름이 남습니다.
            </p>
          )}
        </Modal>
      )}
    </div>
  );
}
