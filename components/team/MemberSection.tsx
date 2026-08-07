'use client';

// 인력 섹션 (SOT §7.10 "기관별로 그룹핑된 테이블", §5.11, §6.6 H-9·H-9a, 부록 A.4)
// 표시 규칙:
//  - 소속 기관이 없는 인력도 "소속 미지정" 그룹으로 반드시 드러낸다. 목록에서 빼지 않는다(절대 규칙 5).
//  - PM은 과제당 1명. 지정해도 기존 PM의 role은 자동으로 바뀌지 않는다 — 경고만 띄운다(§7.10).
//  - 삭제는 H-9의 참조 8곳 건수를 먼저 보여주고, 삭제 후에는 실제로 정리된 건수를 알린다.
//  - H-9a: 인건비 산출근거는 정리 대상이 아니라 **삭제 차단 사유**다. 별도 줄로 세고 1건 이상이면
//    삭제 버튼을 막는다 — 사람을 지운 조작만으로 비목 총액이 줄어드는 것을 막는다.
//  - hireType='new'는 '채용예정' 배지로 구분한다 (§5.11 — 사람이 정해지지 않은 자리도 Member다).
// 쓰기는 전부 actions/team.ts를 거친다. supabase를 직접 부르지 않는다(§8.2 C-2).

import { useMemo, useState } from 'react';
import Link from 'next/link';
import type { ActionResult, Member, OrgRole, Organization } from '@/types';
import type { ActionErrorCode } from '@/lib/db/errors';
import type { AssignedTask, MemberReferenceCounts } from '@/actions/team';
import { HIRE_TYPE_LABELS, MEMBER_ROLE_LABELS, ORG_ROLE_LABELS } from '@/lib/constants';
import {
  countMemberReferences,
  deleteMember,
  setMemberActive,
  setProjectPM,
} from '@/actions/team';
import Badge, { type BadgeTone } from '@/components/ui/Badge';
import Button from '@/components/ui/Button';
import Modal from '@/components/ui/Modal';
import MemberFormModal from './MemberFormModal';
import MemberTasksPanel from './MemberTasksPanel';

/** 팀 화면(TeamScreen)이 섹션에 내려주는 공통 콜백 — 배너·바쁨 표시·새로고침은 화면이 관장한다 */
export interface TeamSectionCallbacks {
  busy: boolean;
  onBusyChange: (busy: boolean) => void;
  onError: (message: string, code?: ActionErrorCode) => void;
  /** 성공 시 — TeamScreen이 router.refresh() */
  onDone: () => void;
}

export interface MemberSectionProps extends TeamSectionCallbacks {
  projectId: string;
  members: Member[];
  organizations: Organization[];
  /** projects.pm_member_id (§5.3) */
  pmMemberId: string | null;
  /** 키는 memberId. 배정이 없는 인력도 빈 배열로 들어 있다 */
  assignedTasksByMember: Record<string, AssignedTask[]>;
}

// 부록 A.3 Org 역할 색(indigo/sky/slate)을 뱃지 톤으로 옮긴다
const ORG_ROLE_TONES: Record<OrgRole, BadgeTone> = {
  lead: 'violet',
  joint: 'blue',
  consign: 'neutral',
};

// H-9의 참조 8곳 — **정리되는** 참조다. 삭제 확인과 삭제 결과가 같은 정의를 쓴다 — 한쪽만 빠지면
// "무엇이 정리됐는지"가 사용자에게 어긋나 보인다.
// budgetDetails(H-9a)는 여기 없다: 성격이 달라 별도 줄로 세고 삭제 자체를 막는다.
const REFERENCE_FIELDS: readonly { key: keyof MemberReferenceCounts; label: string }[] = [
  { key: 'tasks', label: '담당 작업' },
  { key: 'taskMembers', label: '참여 작업' },
  { key: 'milestones', label: '마일스톤' },
  { key: 'risks', label: '리스크' },
  { key: 'projects', label: 'PM 지정' },
  { key: 'achievementMembers', label: '성과 실적 참여' },
  { key: 'noteAttendees', label: '회의 참석' },
  { key: 'appUsers', label: '계정 연결' },
] as const;

const UNASSIGNED_KEY = '__unassigned__';

interface MemberGroup {
  key: string;
  label: string;
  role: OrgRole | null;
}

/** 기관별 그룹. 주관기관을 맨 위, 소속 미지정을 맨 아래에 둔다(§7.10 "주관기관은 최상단 고정") */
function buildGroups(members: Member[], organizations: Organization[]): (MemberGroup & {
  members: Member[];
})[] {
  const byKey = new Map<string, Member[]>();
  for (const member of members) {
    const key = member.orgId ?? UNASSIGNED_KEY;
    const bucket = byKey.get(key);
    if (bucket) bucket.push(member);
    else byKey.set(key, [member]);
  }

  const orderedOrgs = [...organizations].sort(
    (a, b) => Number(b.role === 'lead') - Number(a.role === 'lead')
  );

  const groups: (MemberGroup & { members: Member[] })[] = [];
  for (const org of orderedOrgs) {
    const bucket = byKey.get(org.id);
    if (!bucket) continue; // 인력이 없는 기관은 기관 섹션이 이미 보여준다
    byKey.delete(org.id);
    groups.push({ key: org.id, label: org.name, role: org.role, members: bucket });
  }

  const unassigned = byKey.get(UNASSIGNED_KEY);
  byKey.delete(UNASSIGNED_KEY);

  // 기관 목록에 없는 orgId를 가리키는 인력. 있을 수 없는 상태지만 조용히 감추지 않는다
  for (const [orgId, bucket] of byKey) {
    groups.push({ key: orgId, label: '(목록에 없는 기관)', role: null, members: bucket });
  }

  if (unassigned) {
    groups.push({ key: UNASSIGNED_KEY, label: '소속 미지정', role: null, members: unassigned });
  }
  return groups;
}

/** 정리된 참조를 사람이 읽는 문장으로. 0건은 빼고, 전부 0이면 그 사실을 그대로 알린다 */
function describeCounts(counts: MemberReferenceCounts): string {
  const parts = REFERENCE_FIELDS.filter(({ key }) => counts[key] > 0).map(
    ({ key, label }) => `${label} ${counts[key]}건`
  );
  return parts.length === 0 ? '정리된 참조는 없습니다.' : parts.join(' · ');
}

export default function MemberSection({
  projectId,
  members,
  organizations,
  pmMemberId,
  assignedTasksByMember,
  busy,
  onBusyChange,
  onError,
  onDone,
}: MemberSectionProps) {
  const [formMode, setFormMode] = useState<'create' | 'edit' | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [pmTargetId, setPmTargetId] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [counts, setCounts] = useState<MemberReferenceCounts | null>(null);
  const [countsLoading, setCountsLoading] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  const groups = useMemo(() => buildGroups(members, organizations), [members, organizations]);

  const byId = useMemo(() => new Map(members.map((m) => [m.id, m])), [members]);
  // 편집 대상은 매번 최신 props에서 다시 찾는다 — O-3의 "다시 불러오기"가 모달까지 닿는 경로다
  const editingMember = editingId === null ? undefined : byId.get(editingId);
  const selectedMember = selectedId === null ? null : (byId.get(selectedId) ?? null);
  const pmTarget = pmTargetId === null ? null : (byId.get(pmTargetId) ?? null);
  const deletingMember = deletingId === null ? null : (byId.get(deletingId) ?? null);
  // H-9a: 산출근거가 1건이라도 있으면 삭제 자체가 불가능하다 (서버 RPC도 같은 판단으로 거부한다)
  const deleteBlocked = counts !== null && counts.budgetDetails > 0;
  const currentPmName =
    pmMemberId === null ? null : (byId.get(pmMemberId)?.name ?? '(삭제된 인력)');

  async function run<T>(
    action: () => Promise<ActionResult<T>>,
    onSuccess: (data: T) => void
  ): Promise<void> {
    onBusyChange(true);
    try {
      const res = await action();
      if (!res.ok) {
        onError(res.error, res.code);
        return;
      }
      onSuccess(res.data);
      onDone();
    } finally {
      onBusyChange(false);
    }
  }

  const openDelete = (member: Member): void => {
    setDeletingId(member.id);
    setCounts(null);
    setCountsLoading(true);
    void countMemberReferences(member.id).then((res) => {
      setCountsLoading(false);
      if (!res.ok) {
        // 건수를 못 읽었다면 삭제 판단 근거가 없다 — 모달을 닫고 실패를 그대로 알린다
        setDeletingId(null);
        onError(res.error, res.code);
        return;
      }
      setCounts(res.data);
    });
  };

  const handleDelete = (member: Member): void => {
    void run(
      () => deleteMember(member.id),
      (cleaned) => {
        setDeletingId(null);
        setCounts(null);
        if (selectedId === member.id) setSelectedId(null);
        setNotice(`${member.name} 인력을 삭제했습니다. ${describeCounts(cleaned)}`);
      }
    );
  };

  const handleSetPM = (member: Member): void => {
    void run(
      () => setProjectPM(projectId, member.id),
      (result) => {
        setPmTargetId(null);
        const previousName =
          result.previousPmMemberId === null
            ? null
            : (byId.get(result.previousPmMemberId)?.name ?? '(삭제된 인력)');
        setNotice(
          previousName === null
            ? `${member.name}님을 총괄책임자(PM)로 지정했습니다.`
            : `${member.name}님을 총괄책임자(PM)로 지정했습니다. 기존 PM(${previousName})의 역할은 그대로입니다 — 필요하면 직접 수정하세요.`
        );
      }
    );
  };

  const handleToggleActive = (member: Member): void => {
    void run(
      () => setMemberActive(member.id, !member.active),
      () => {
        setNotice(
          `${member.name}님을 ${member.active ? '비활성' : '활성'} 상태로 바꿨습니다.`
        );
      }
    );
  };

  const requestPM = (member: Member): void => {
    // 기존 PM이 있으면 "자동으로 바뀌지 않는다"를 먼저 알린다 (§7.10)
    if (pmMemberId !== null && pmMemberId !== member.id) {
      setPmTargetId(member.id);
      return;
    }
    handleSetPM(member);
  };

  return (
    <section aria-labelledby="member-section-title">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 id="member-section-title" className="text-base font-bold text-slate-900">
          참여인력
          <span className="ml-2 text-xs font-normal text-slate-500">{members.length}명</span>
        </h2>
        <Button
          size="sm"
          variant="primary"
          disabled={busy}
          onClick={() => {
            setEditingId(null);
            setFormMode('create');
          }}
        >
          인력 추가
        </Button>
      </div>

      {notice && (
        <div
          role="status"
          className="mt-3 flex items-start justify-between gap-4 rounded-xl border border-slate-200 bg-slate-50 p-3 text-sm text-slate-700"
        >
          <p className="min-w-0 break-words">{notice}</p>
          <button
            type="button"
            onClick={() => setNotice(null)}
            aria-label="알림 닫기"
            className="shrink-0 font-bold text-slate-400 hover:text-slate-600"
          >
            ×
          </button>
        </div>
      )}

      <div className="mt-3 flex flex-col gap-4 lg:flex-row">
        <div className="min-w-0 flex-1 space-y-5">
          {groups.length === 0 && (
            <p className="rounded-xl border border-dashed border-slate-300 bg-white p-6 text-center text-sm text-slate-400">
              등록된 인력이 없습니다. [인력 추가]로 시작하세요.
            </p>
          )}

          {groups.map((group) => (
            <div
              key={group.key}
              className="overflow-hidden rounded-xl border border-slate-200 bg-white"
            >
              <div className="flex items-center gap-2 border-b border-slate-100 bg-slate-50 px-4 py-2.5">
                <span className="text-sm font-semibold text-slate-800">{group.label}</span>
                {group.role && <Badge tone={ORG_ROLE_TONES[group.role]}>{ORG_ROLE_LABELS[group.role]}</Badge>}
                <span className="text-xs text-slate-500">{group.members.length}명</span>
              </div>

              <table className="w-full text-left text-sm">
                <thead className="text-xs text-slate-500">
                  <tr className="border-b border-slate-100">
                    <th className="px-4 py-2 font-medium">이름</th>
                    <th className="px-4 py-2 font-medium">역할</th>
                    <th className="px-4 py-2 font-medium">직급</th>
                    <th className="px-4 py-2 font-medium">분야</th>
                    <th className="px-4 py-2 font-medium">연락처</th>
                    <th className="px-4 py-2 text-right font-medium">연봉</th>
                    <th className="px-4 py-2 font-medium">활성</th>
                    <th className="px-4 py-2 text-right font-medium">동작</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {group.members.map((member) => {
                    const isPm = member.id === pmMemberId;
                    const isSelected = member.id === selectedId;
                    return (
                      <tr
                        key={member.id}
                        onClick={() => setSelectedId(member.id)}
                        className={`cursor-pointer transition ${
                          isSelected ? 'bg-slate-100' : 'hover:bg-slate-50'
                        } ${member.active ? '' : 'text-slate-400'}`}
                      >
                        <td className="px-4 py-2.5">
                          <button
                            type="button"
                            // 행 클릭과 같은 동작 — 키보드 사용자를 위한 접근 경로다
                            onClick={() => setSelectedId(member.id)}
                            className="text-left font-medium text-slate-900 underline-offset-2 hover:underline"
                          >
                            {member.name}
                          </button>
                          {isPm && (
                            <Badge tone="violet" className="ml-2">
                              PM
                            </Badge>
                          )}
                          {/* §7.10: 아직 사람이 정해지지 않은 자리를 목록에서 구분한다 */}
                          {member.hireType === 'new' && (
                            <Badge tone="amber" className="ml-2">
                              {HIRE_TYPE_LABELS.new}
                            </Badge>
                          )}
                        </td>
                        <td className="px-4 py-2.5 text-slate-600">
                          {MEMBER_ROLE_LABELS[member.role]}
                        </td>
                        <td className="px-4 py-2.5 text-slate-600">{member.position || '—'}</td>
                        <td className="px-4 py-2.5 text-slate-600">{member.field || '—'}</td>
                        <td className="px-4 py-2.5 text-slate-600">
                          {member.email === '' && member.phone === '' ? (
                            '—'
                          ) : (
                            <>
                              {member.email && <span className="block">{member.email}</span>}
                              {member.phone && (
                                <span className="block text-xs text-slate-500">{member.phone}</span>
                              )}
                            </>
                          )}
                        </td>
                        {/* 미입력(null)은 0원과 다르다 — '—'로 구분해 보여준다 (§5.11) */}
                        <td className="px-4 py-2.5 text-right tabular-nums text-slate-600">
                          {member.annualSalary === null
                            ? '—'
                            : `${member.annualSalary.toLocaleString('ko-KR')}원`}
                        </td>
                        <td className="px-4 py-2.5">
                          <Badge tone={member.active ? 'green' : 'neutral'}>
                            {member.active ? '활성' : '비활성'}
                          </Badge>
                        </td>
                        <td
                          className="px-4 py-2.5 text-right"
                          // 행 클릭(패널 열기)이 버튼 동작과 겹치지 않게 한다
                          onClick={(e) => e.stopPropagation()}
                        >
                          <div className="flex flex-wrap justify-end gap-1.5">
                            <Button
                              size="sm"
                              disabled={busy}
                              onClick={() => {
                                setEditingId(member.id);
                                setFormMode('edit');
                              }}
                            >
                              수정
                            </Button>
                            <Button
                              size="sm"
                              disabled={busy}
                              onClick={() => handleToggleActive(member)}
                            >
                              {member.active ? '비활성' : '활성화'}
                            </Button>
                            {!isPm && (
                              <Button size="sm" disabled={busy} onClick={() => requestPM(member)}>
                                PM으로 지정
                              </Button>
                            )}
                            <Button
                              size="sm"
                              variant="danger"
                              disabled={busy}
                              onClick={() => openDelete(member)}
                            >
                              삭제
                            </Button>
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          ))}
        </div>

        {selectedMember && (
          <MemberTasksPanel
            member={selectedMember}
            tasks={assignedTasksByMember[selectedMember.id] ?? []}
            onClose={() => setSelectedId(null)}
          />
        )}
      </div>

      {formMode && (
        <MemberFormModal
          mode={formMode}
          projectId={projectId}
          member={formMode === 'edit' ? editingMember : undefined}
          organizations={organizations}
          onClose={() => {
            setFormMode(null);
            setEditingId(null);
          }}
          onSaved={() => {
            setFormMode(null);
            setEditingId(null);
            onDone();
          }}
        />
      )}

      {pmTarget && (
        <Modal
          open
          title="총괄책임자(PM)를 바꿉니다"
          onClose={() => setPmTargetId(null)}
          closeOnBackdrop={false}
          footer={
            <>
              <Button size="sm" onClick={() => setPmTargetId(null)} disabled={busy}>
                취소
              </Button>
              <Button
                size="sm"
                variant="primary"
                disabled={busy}
                onClick={() => handleSetPM(pmTarget)}
              >
                {busy ? '처리 중…' : 'PM으로 지정'}
              </Button>
            </>
          }
        >
          <p className="text-sm text-slate-700">
            <strong>{pmTarget.name}</strong>님을 이 과제의 총괄책임자(PM)로 지정합니다.
          </p>
          <p className="mt-3 rounded-lg bg-amber-50 p-3 text-sm text-amber-800">
            기존 PM({currentPmName ?? '미지정'})의 역할은 자동으로 바뀌지 않습니다. 필요하면 직접
            수정하세요.
          </p>
        </Modal>
      )}

      {deletingMember && (
        <Modal
          open
          title="인력을 삭제합니다"
          onClose={() => {
            setDeletingId(null);
            setCounts(null);
          }}
          closeOnBackdrop={false}
          footer={
            <>
              <Button
                size="sm"
                onClick={() => {
                  setDeletingId(null);
                  setCounts(null);
                }}
                disabled={busy}
              >
                취소
              </Button>
              {deletingMember.active && (
                <Button
                  size="sm"
                  disabled={busy}
                  onClick={() => {
                    setDeletingId(null);
                    setCounts(null);
                    handleToggleActive(deletingMember);
                  }}
                >
                  비활성으로 전환
                </Button>
              )}
              <Button
                size="sm"
                variant="danger"
                // 무엇이 정리되는지 모른 채 삭제하지 않는다.
                // H-9a: 인건비 산출근거가 걸려 있으면 아예 막는다 — 서버도 같은 판단으로 거부한다
                disabled={busy || countsLoading || counts === null || deleteBlocked}
                onClick={() => handleDelete(deletingMember)}
              >
                {busy ? '삭제 중…' : '삭제'}
              </Button>
            </>
          }
        >
          <p className="text-sm text-slate-700">
            <strong>{deletingMember.name}</strong>님을 삭제하면 아래 참조가 함께 정리됩니다.
          </p>

          {countsLoading && <p className="mt-3 text-sm text-slate-500">참조 건수를 확인하는 중…</p>}

          {counts && (
            <ul className="mt-3 grid grid-cols-2 gap-x-4 gap-y-1.5 rounded-lg bg-slate-50 p-3 text-sm">
              {REFERENCE_FIELDS.map(({ key, label }) => (
                <li key={key} className="flex items-center justify-between gap-2">
                  <span className="text-slate-600">{label}</span>
                  <span
                    className={`tabular-nums ${
                      counts[key] > 0 ? 'font-semibold text-slate-900' : 'text-slate-400'
                    }`}
                  >
                    {counts[key]}건
                  </span>
                </li>
              ))}
            </ul>
          )}

          {/* H-9a: 위 8곳과 성격이 다르다 — 정리되는 참조가 아니라 삭제를 막는 참조다 */}
          {counts && (
            <div
              className={`mt-3 flex flex-wrap items-center justify-between gap-2 rounded-lg p-3 text-sm ${
                deleteBlocked ? 'bg-red-50 text-red-800' : 'bg-slate-50 text-slate-600'
              }`}
            >
              <span>인건비 산출근거</span>
              <span className={`tabular-nums ${deleteBlocked ? 'font-semibold' : 'text-slate-400'}`}>
                {counts.budgetDetails}건
              </span>
            </div>
          )}

          {deleteBlocked && counts && (
            <div className="mt-3 rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-800">
              <p>
                <strong>인건비 산출근거 {counts.budgetDetails}건</strong>이 이 인력을 참조합니다.
                함께 지우면 사람을 지운 조작만으로 비목 총액이 줄어들기 때문에 삭제할 수 없습니다.
                연구비 화면에서 먼저 정리하세요.
              </p>
              <Link
                href={`/projects/${projectId}/budget`}
                className="mt-2 inline-block font-semibold underline underline-offset-2"
              >
                연구비로 이동
              </Link>
              <p className="mt-2 text-xs">
                참여가 끝난 인력이라면 <strong>[비활성]</strong>은 그대로 가능합니다. 비활성 인력의
                지난 연차 인건비는 남아 있어야 정상입니다.
              </p>
            </div>
          )}

          <p className="mt-3 rounded-lg bg-amber-50 p-3 text-xs text-amber-800">
            참여가 끝난 인력이라면 삭제 대신 <strong>[비활성]</strong>을 권장합니다. 비활성으로
            두면 지난 작업·실적 기록이 그대로 남습니다.
          </p>
        </Modal>
      )}
    </section>
  );
}
