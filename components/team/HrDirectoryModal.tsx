'use client';

// 사내 명부에서 인력 추가 모달 (SOT §7.10.1, §6.13 HR-2·HR-5~HR-9·HR-12·HR-16·HR-17, §7.18 ST-3)
// 이 컴포넌트는 HR을 부르지 않는다. 명부는 부모(MemberSection·StaffScreen)가 [사내 명부에서 추가] 클릭
// 핸들러에서 서버 액션 fetchHrDirectory(ForStaff)로 받아 state로 내려준다(HR-7·HR-13) — 여기에 마운트 시
// 자동 호출을 두면 "사용자가 여는 조작"이라는 원칙이 깨진다. 모달이 닫히면 부모가 state를
// null로 돌려 명부가 버려진다(HR-17). 선택 상태도 이 컴포넌트와 함께 사라진다.
// 저장 대상은 둘이다(ST-3): 기본은 과제 Member(createMembersFromHr), `submit`을 주면 그쪽으로 보낸다
// (조직원 화면 → createStaffFromHr). 판정(이미 등록됨 등)은 부모가 받은 명부에 이미 들어 있으므로
// 이 컴포넌트는 대상이 무엇이든 같은 표를 그린다.
// 표시 규칙:
//  - 선택 불가 행(이미 등록됨·이메일 없음·읽을 수 없음)은 목록에서 빼지 않고 회색+사유로 남긴다
//    (HR-8·HR-9·HR-16). 검색은 필터일 뿐이다.
//  - 퇴사는 배지만 — 선택을 막지 않는다. 지난 연차 예산에 이름이 남아야 하는 사람이 있다(HR-5).
//  - 본부·팀은 표시 전용이다(HR-6). 서버에 보내는 것은 entry.draft(name·position·email)뿐이다.

import { useMemo, useState } from 'react';
import Link from 'next/link';
import type { ActionErrorCode } from '@/lib/db/errors';
import type { ActionResult, HrImportResult } from '@/types';
import type { HrDirectory, HrDirectoryEntry, HrMemberDraft } from '@/lib/hr';
import { createMembersFromHr } from '@/actions/team';
import Badge from '@/components/ui/Badge';
import Button from '@/components/ui/Button';
import ErrorBanner from '@/components/ui/ErrorBanner';
import Modal from '@/components/ui/Modal';

/** 부모가 관리하는 명부 상태. null(모달 닫힘)은 부모 쪽 타입이다 */
export type HrDirectoryState =
  | { phase: 'loading' }
  | { phase: 'no-key' }
  | { phase: 'ready'; directory: HrDirectory }
  | { phase: 'error'; message: string; code?: ActionErrorCode };

/** 커스텀 submit의 저장 결과. created 엔티티 종류(Member·Staff)에 매이지 않는 요약이다 */
export interface HrImportSummary {
  createdCount: number;
  rejected: { name: string; email: string; reason: string }[];
}

/** 커스텀 submit에 넘기는 초안. `retired`는 HR user_is_active의 초기값 반영용이다(ST-3·HR-7) */
export type HrSubmitDraft = HrMemberDraft & { retired: boolean };

interface HrDirectoryModalBaseProps {
  state: HrDirectoryState;
  onClose: () => void;
  /** 기본 "사내 명부에서 추가" */
  title?: string;
  /** 기본은 Member용 HR-2·HR-4 문구. 저장 대상이 다르면 무엇이 채워지는지도 달라진다 */
  description?: string;
}

/**
 * 저장 대상은 둘 중 하나다. `submit`이 없으면 과제 Member(createMembersFromHr — projectId 필수),
 * 있으면 그 함수로 보낸다. 두 경로의 onAdded 인자 모양이 달라 유니온으로 나눈다 —
 * 기존 호출부(MemberSection)는 첫 번째 모양 그대로다.
 */
export type HrDirectoryModalProps = HrDirectoryModalBaseProps &
  (
    | {
        projectId: string;
        submit?: undefined;
        /** 저장 성공 시 — 부모가 HR-2 문구를 남기고 목록을 새로고침한다 */
        onAdded: (result: HrImportResult) => void;
      }
    | {
        projectId?: undefined;
        submit: (drafts: HrSubmitDraft[]) => Promise<ActionResult<HrImportSummary>>;
        onAdded: (result: HrImportSummary) => void;
      }
  );

const BLOCK_LABELS = {
  'already-registered': '이미 등록됨',
  'no-email': '이메일 없음',
} as const;

function matchesQuery(entry: HrDirectoryEntry, query: string): boolean {
  if (query === '') return true;
  const name = entry.kind === 'user' ? entry.user.user_name : (entry.name ?? '');
  const email = entry.kind === 'user' ? entry.user.user_email : (entry.email ?? '');
  return name.toLowerCase().includes(query) || email.toLowerCase().includes(query);
}

const DEFAULT_DESCRIPTION =
  '이름·직위·이메일만 채워집니다. 연봉·채용구분·분야·연락처·소속 기관은 비어 있으므로 나중에 채우세요.';

export default function HrDirectoryModal(props: HrDirectoryModalProps) {
  const { state, onClose, title = '사내 명부에서 추가', description = DEFAULT_DESCRIPTION } = props;
  const [query, setQuery] = useState('');
  // 키는 entries 배열 위치. 명부는 모달이 열려 있는 동안 바뀌지 않으므로 안정적이고,
  // HR의 user_id를 식별자로 쓰지 않는다(HR-9 — 우리 쪽에 남길 이유를 만들지 않는다)
  const [selected, setSelected] = useState<ReadonlySet<number>>(() => new Set());
  const [submitting, setSubmitting] = useState(false);
  const [failure, setFailure] = useState<{ message: string; code?: ActionErrorCode } | null>(null);

  const entries = state.phase === 'ready' ? state.directory.entries : [];

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    return entries
      .map((entry, index) => ({ entry, index }))
      .filter(({ entry }) => matchesQuery(entry, q));
  }, [entries, query]);

  // 전체 선택은 "현재 필터에서 선택 가능한 행"만 대상으로 한다
  const visibleSelectable = visible.filter(({ entry }) => entry.kind === 'user' && entry.selectable);
  const allVisibleSelected =
    visibleSelectable.length > 0 && visibleSelectable.every(({ index }) => selected.has(index));

  const toggle = (index: number): void => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(index)) next.delete(index);
      else next.add(index);
      return next;
    });
  };

  const toggleAllVisible = (): void => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (allVisibleSelected) {
        for (const { index } of visibleSelectable) next.delete(index);
      } else {
        for (const { index } of visibleSelectable) next.add(index);
      }
      return next;
    });
  };

  const submit = async (): Promise<void> => {
    if (state.phase !== 'ready') return;
    // HR-4·HR-6: draft 그대로 보낸다. division/team을 얹으면 서버의 strict 스키마가 거부한다.
    // retired는 커스텀 submit(조직원)에만 얹는다 — createMembersFromHr의 strict 스키마는 그 키도 거부한다
    const chosen = state.directory.entries.flatMap((entry, index) =>
      entry.kind === 'user' && entry.selectable && selected.has(index) ? [entry] : []
    );
    if (chosen.length === 0) return;
    setSubmitting(true);
    setFailure(null);
    try {
      if (props.submit) {
        const res = await props.submit(chosen.map((e) => ({ ...e.draft, retired: e.retired })));
        if (!res.ok) {
          // 모달을 닫지 않는다 — 선택을 유지한 채 다시 시도할 수 있어야 한다
          setFailure({ message: res.error, code: res.code });
          return;
        }
        props.onAdded(res.data);
        return;
      }
      const res = await createMembersFromHr(
        props.projectId,
        chosen.map((e) => e.draft)
      );
      if (!res.ok) {
        setFailure({ message: res.error, code: res.code });
        return;
      }
      props.onAdded(res.data);
    } finally {
      setSubmitting(false);
    }
  };

  const selectedCount = selected.size;
  const ready = state.phase === 'ready';

  return (
    <Modal
      open
      title={title}
      description={description}
      onClose={onClose}
      closeOnBackdrop={false}
      size="xl"
      footer={
        <>
          <Button size="sm" onClick={onClose} disabled={submitting}>
            취소
          </Button>
          <Button
            size="sm"
            variant="primary"
            disabled={!ready || submitting || selectedCount === 0}
            onClick={() => void submit()}
          >
            {submitting ? '추가 중…' : `${selectedCount}명 추가`}
          </Button>
        </>
      }
    >
      {state.phase === 'loading' && (
        <p className="py-6 text-center text-sm text-grey-500">사내 명부를 불러오는 중…</p>
      )}

      {state.phase === 'no-key' && (
        <div className="rounded-xl border border-orange-200 bg-orange-50 p-4 text-sm text-orange-800">
          <p className="font-semibold">설정에서 HR API 키를 등록하세요.</p>
          <p className="mt-1 text-xs">
            사내 명부를 읽으려면 hr.unes.kr에서 발급한 API 키가 필요합니다. 키는 이 PC의 OS
            키체인에만 저장됩니다.
          </p>
          <Link
            href="/settings"
            className="mt-2 inline-block font-semibold underline underline-offset-2"
          >
            설정으로 이동
          </Link>
        </div>
      )}

      {state.phase === 'error' && <ErrorBanner message={state.message} code={state.code} />}

      {state.phase === 'ready' && (
        <div>
          {failure && (
            <ErrorBanner
              message={failure.message}
              code={failure.code}
              onDismiss={() => setFailure(null)}
              className="mb-3"
            />
          )}

          {/* HR-16: 페이징이 없으므로 count와 행 수가 다르면 무언가 잘못된 것이다 — 감추지 않는다 */}
          {state.directory.countMismatch && (
            <p className="mb-3 rounded-lg border border-orange-200 bg-orange-50 p-3 text-sm text-orange-800">
              HR이 알린 인원({state.directory.count ?? '없음'})과 받은 행 수(
              {state.directory.rowCount})가 다릅니다. 명부가 온전하지 않을 수 있습니다.
            </p>
          )}

          <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
            <input
              type="search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="이름 또는 이메일로 검색"
              aria-label="이름 또는 이메일로 검색"
              className="w-full max-w-sm rounded-lg border border-grey-300 px-3 py-2 text-sm focus:border-grey-500 focus:outline-none"
            />
            <span className="text-xs text-grey-500">
              {visible.length}명 표시 · {selectedCount}명 선택
            </span>
          </div>

          <div className="max-h-[60vh] overflow-y-auto rounded-xl border border-grey-200">
            <table className="w-full text-left text-sm">
              <thead className="sticky top-0 bg-grey-50 text-xs text-grey-500">
                <tr className="border-b border-grey-100">
                  <th className="px-3 py-2">
                    <input
                      type="checkbox"
                      checked={allVisibleSelected}
                      disabled={visibleSelectable.length === 0}
                      onChange={toggleAllVisible}
                      aria-label="표시된 선택 가능 인원 전체 선택"
                    />
                  </th>
                  <th className="px-3 py-2 font-medium">이름</th>
                  <th className="px-3 py-2 font-medium">직위</th>
                  <th className="px-3 py-2 font-medium">본부</th>
                  <th className="px-3 py-2 font-medium">팀</th>
                  <th className="px-3 py-2 font-medium">이메일</th>
                  <th className="px-3 py-2 font-medium">상태</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-grey-100">
                {visible.length === 0 && (
                  <tr>
                    <td colSpan={7} className="px-3 py-6 text-center text-grey-400">
                      {entries.length === 0
                        ? '사내 명부에 항목이 없습니다.'
                        : '검색과 일치하는 인원이 없습니다.'}
                    </td>
                  </tr>
                )}
                {visible.map(({ entry, index }) => {
                  if (entry.kind === 'unreadable') {
                    return (
                      <tr key={index} className="bg-grey-50 text-grey-400">
                        <td className="px-3 py-2">
                          <input type="checkbox" checked={false} disabled readOnly />
                        </td>
                        <td className="px-3 py-2">{entry.name ?? '—'}</td>
                        <td className="px-3 py-2">—</td>
                        <td className="px-3 py-2">—</td>
                        <td className="px-3 py-2">—</td>
                        <td className="px-3 py-2">{entry.email ?? '—'}</td>
                        <td className="px-3 py-2">
                          <Badge tone="neutral" title={entry.reason}>
                            읽을 수 없음
                          </Badge>
                          <span className="ml-2 text-xs">{entry.reason}</span>
                        </td>
                      </tr>
                    );
                  }

                  const { user } = entry;
                  const isSelected = selected.has(index);
                  return (
                    <tr
                      key={index}
                      onClick={() => entry.selectable && toggle(index)}
                      className={
                        entry.selectable
                          ? `cursor-pointer transition ${isSelected ? 'bg-grey-100' : 'hover:bg-grey-50'}`
                          : 'bg-grey-50 text-grey-400'
                      }
                    >
                      <td className="px-3 py-2" onClick={(e) => e.stopPropagation()}>
                        <input
                          type="checkbox"
                          checked={isSelected}
                          disabled={!entry.selectable}
                          onChange={() => toggle(index)}
                          aria-label={`${user.user_name} 선택`}
                        />
                      </td>
                      <td className="px-3 py-2 font-medium">{user.user_name}</td>
                      <td className="px-3 py-2">{user.user_position || '—'}</td>
                      <td className="px-3 py-2">{user.user_division ?? '—'}</td>
                      <td className="px-3 py-2">{user.user_team ?? '—'}</td>
                      <td className="px-3 py-2">{user.user_email || '—'}</td>
                      <td className="px-3 py-2">
                        <div className="flex flex-wrap gap-1">
                          {entry.blockReason !== null && (
                            <Badge tone="neutral">{BLOCK_LABELS[entry.blockReason]}</Badge>
                          )}
                          {entry.retired && (
                            <Badge tone="amber" title="HR 기준 퇴사. 지난 연차 예산에 필요하면 선택할 수 있습니다">
                              퇴사
                            </Badge>
                          )}
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </Modal>
  );
}
