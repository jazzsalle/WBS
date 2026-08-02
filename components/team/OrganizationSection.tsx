'use client';

// 기관 섹션 (SOT §7.10 "기관 섹션: 카드 목록. 역할 뱃지, 기관명, 유형, 책임자,
// 담당 연구개발 내용, 배분 연구개발비. 주관기관은 최상단 고정")
// H-8: 주관기관은 다른 기관을 주관으로 지정하기 전까지 삭제할 수 없다. UI가 먼저 막되,
// 서버가 RULE로 거부한 경우에도 같은 문장을 보여준다 (WbsScreen의 REJECT_MESSAGES와 같은 이유).

import { useEffect, useState } from 'react';
import type { Member, Organization } from '@/types';
import { deleteOrganization, setLeadOrganization } from '@/actions/team';
import { ORG_ROLE_COLORS, ORG_ROLE_LABELS } from '@/lib/constants';
import Badge, { type BadgeTone } from '@/components/ui/Badge';
import Button from '@/components/ui/Button';
import Modal from '@/components/ui/Modal';
import OrganizationFormModal from './OrganizationFormModal';
import type { TeamSectionCallbacks } from './TeamScreen';

// H-8 위반 문구. 서버(actions/team.deleteOrganization)와 같은 문장을 UI 사전 검사에도 쓴다 —
// 버튼 비활성 안내와 배너가 다른 말을 하면 사용자는 무엇이 규칙인지 알 수 없다.
const LEAD_DELETE_BLOCKED = '주관기관은 삭제할 수 없습니다. 다른 기관을 주관으로 먼저 지정하세요.';

// 서버 RULE 문구를 UI 사전 검사와 같은 문장으로 정규화한다.
// 모르는 사유는 서버 문구를 그대로 보여준다 — 삼키지 않는다 (절대 규칙 5).
function toRuleMessage(serverMessage: string): string {
  return serverMessage.includes('주관기관은 삭제할 수 없습니다')
    ? LEAD_DELETE_BLOCKED
    : serverMessage;
}

// 부록 A.3의 Org 색(indigo/sky/slate)을 Badge가 받는 톤으로 옮긴다.
// 색 정의의 원본은 어디까지나 ORG_ROLE_COLORS다.
const COLOR_TONES: Record<string, BadgeTone | undefined> = {
  'indigo-600': 'violet',
  'sky-600': 'blue',
  'slate-500': 'neutral',
};

function formatBudget(budget: number | null): string {
  // 금액은 원 단위 정수다. 표시에서만 천 단위 구분을 넣고 단위 환산은 하지 않는다.
  return budget === null ? '미입력' : `${budget.toLocaleString('ko-KR')}원`;
}

export interface OrganizationSectionProps extends TeamSectionCallbacks {
  projectId: string;
  organizations: Organization[];
  /** 삭제 확인에서 "소속이 비게 되는 인력 N명"(N-8)을 알리는 데 쓴다 */
  members: Member[];
  /** projects.lead_org_id. role='lead'와 함께 봐야 H-8 판정이 서버와 일치한다 */
  leadOrgId: string | null;
}

export default function OrganizationSection({
  projectId,
  organizations,
  members,
  leadOrgId,
  busy,
  onBusyChange,
  onError,
  onDone,
}: OrganizationSectionProps) {
  const [formMode, setFormMode] = useState<'create' | 'edit' | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [deleteTargetId, setDeleteTargetId] = useState<string | null>(null);

  // 서버 판정과 같은 기준: 둘 중 하나만 lead를 가리켜도 주관기관으로 본다
  const isLead = (org: Organization): boolean => org.role === 'lead' || org.id === leadOrgId;

  // §7.10 "주관기관은 최상단 고정". 그 외 순서는 order 그대로 둔다(sort는 안정 정렬)
  const sorted = [...organizations].sort((a, b) => Number(isLead(b)) - Number(isLead(a)));

  // 과제당 주관기관은 정확히 1개여야 한다(H-8). 어긋난 상태를 조용히 넘기지 않는다 (절대 규칙 5).
  const leadByRole = organizations.filter((org) => org.role === 'lead');
  const leadInconsistent =
    organizations.length > 0 && (leadByRole.length !== 1 || leadByRole[0]?.id !== leadOrgId);

  // 편집 대상은 props에서 다시 찾는다 — router.refresh() 후 최신 행이 그대로 모달로 흘러가
  // 낙관적 잠금 충돌(O-3)의 비교 기준이 갱신된다
  const editing = editingId === null ? null : (organizations.find((o) => o.id === editingId) ?? null);
  const deleteTarget =
    deleteTargetId === null ? null : (organizations.find((o) => o.id === deleteTargetId) ?? null);
  const orphanedMemberCount =
    deleteTarget === null ? 0 : members.filter((m) => m.orgId === deleteTarget.id).length;

  const closeForm = (): void => {
    setFormMode(null);
    setEditingId(null);
  };

  // 편집하던 기관이 목록에서 사라지면(다른 사람이 삭제) 모달이 소리 없이 닫히게 두지 않는다
  // (절대 규칙 5). 입력 중이면 Realtime이 보류 상태(R-4)라 이 상황은 새로고침 직후에만 온다.
  useEffect(() => {
    if (formMode !== 'edit' || editingId === null) return;
    if (organizations.some((org) => org.id === editingId)) return;
    closeForm();
    onError('편집하던 기관이 더 이상 없습니다. 다른 사람이 삭제했을 수 있습니다.');
    // eslint-disable-next-line react-hooks/exhaustive-deps -- closeForm은 상태 setter만 부른다
  }, [formMode, editingId, organizations, onError]);

  const handleSetLead = async (org: Organization): Promise<void> => {
    onBusyChange(true);
    const res = await setLeadOrganization(projectId, org.id);
    onBusyChange(false);
    if (!res.ok) {
      onError(res.error, res.code);
      return;
    }
    onDone();
  };

  const handleDeleteConfirmed = async (): Promise<void> => {
    if (deleteTarget === null) return;
    onBusyChange(true);
    const res = await deleteOrganization(deleteTarget.id);
    onBusyChange(false);
    setDeleteTargetId(null);
    if (!res.ok) {
      onError(res.code === 'RULE' ? toRuleMessage(res.error) : res.error, res.code);
      return;
    }
    onDone();
  };

  return (
    <section aria-labelledby="org-section-heading">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 id="org-section-heading" className="text-lg font-bold">
          기관 <span className="text-sm font-medium text-slate-400">{organizations.length}곳</span>
        </h2>
        <Button
          variant="primary"
          size="sm"
          disabled={busy}
          onClick={() => {
            setEditingId(null);
            setFormMode('create');
          }}
        >
          기관 추가
        </Button>
      </div>

      {leadInconsistent && (
        <p
          role="status"
          className="mt-3 rounded-xl border border-amber-200 bg-amber-50 p-3 text-sm text-amber-800"
        >
          주관기관 지정이 어긋나 있습니다 (역할이 &apos;주관&apos;인 기관 {leadByRole.length}곳).
          과제당 주관기관은 정확히 1곳이어야 합니다. 아래에서 [주관으로 지정]을 눌러 바로잡으세요.
        </p>
      )}

      {sorted.length === 0 ? (
        <p className="mt-4 rounded-xl border border-dashed border-slate-300 p-8 text-center text-sm text-slate-500">
          등록된 기관이 없습니다. 주관기관부터 추가하세요.
        </p>
      ) : (
        <ul className="mt-4 grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
          {sorted.map((org) => {
            const lead = isLead(org);
            return (
              <li
                key={org.id}
                className={`flex flex-col rounded-xl border bg-white p-4 ${
                  lead ? 'border-indigo-200 ring-1 ring-indigo-100' : 'border-slate-200'
                }`}
              >
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-1.5">
                      <Badge tone={COLOR_TONES[ORG_ROLE_COLORS[org.role]] ?? 'neutral'}>
                        {ORG_ROLE_LABELS[org.role]}
                      </Badge>
                      {org.type && <Badge>{org.type}</Badge>}
                    </div>
                    <p className="mt-2 truncate font-semibold text-slate-900" title={org.name}>
                      {org.name}
                    </p>
                  </div>
                </div>

                <dl className="mt-3 space-y-1.5 text-xs text-slate-600">
                  <div className="flex gap-2">
                    <dt className="w-24 shrink-0 text-slate-400">책임자</dt>
                    <dd className="min-w-0 break-words">
                      {org.representative || '미입력'}
                      {org.contact && <span className="text-slate-400"> · {org.contact}</span>}
                    </dd>
                  </div>
                  <div className="flex gap-2">
                    <dt className="w-24 shrink-0 text-slate-400">담당 연구개발 내용</dt>
                    <dd className="min-w-0 whitespace-pre-wrap break-words">
                      {org.responsibility || '미입력'}
                    </dd>
                  </div>
                  <div className="flex gap-2">
                    <dt className="w-24 shrink-0 text-slate-400">배분 연구개발비</dt>
                    <dd className="min-w-0 tabular-nums">{formatBudget(org.budget)}</dd>
                  </div>
                </dl>

                <div className="mt-4 flex flex-wrap gap-2 border-t border-slate-100 pt-3">
                  <Button
                    size="sm"
                    disabled={busy}
                    onClick={() => {
                      setEditingId(org.id);
                      setFormMode('edit');
                    }}
                  >
                    수정
                  </Button>
                  {!lead && (
                    <Button size="sm" disabled={busy} onClick={() => void handleSetLead(org)}>
                      주관으로 지정
                    </Button>
                  )}
                  <Button
                    size="sm"
                    variant="danger"
                    // H-8: 주관기관은 다른 기관을 주관으로 지정하기 전까지 삭제할 수 없다
                    disabled={busy || lead}
                    title={lead ? LEAD_DELETE_BLOCKED : undefined}
                    onClick={() => setDeleteTargetId(org.id)}
                  >
                    삭제
                  </Button>
                  {lead && (
                    <span className="basis-full text-xs text-slate-500">
                      다른 기관을 주관으로 먼저 지정하세요.
                    </span>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      )}

      {formMode !== null && (formMode === 'create' || editing !== null) && (
        <OrganizationFormModal
          // 편집 대상이 바뀌면 폼 상태를 새로 시작한다
          key={editing?.id ?? 'create'}
          mode={formMode}
          projectId={projectId}
          organization={editing ?? undefined}
          hasLeadOrganization={leadByRole.length > 0 || leadOrgId !== null}
          onClose={closeForm}
          onSaved={() => {
            closeForm();
            onDone();
          }}
        />
      )}

      {deleteTarget && (
        <Modal
          open
          title="기관을 삭제할까요?"
          onClose={() => setDeleteTargetId(null)}
          closeOnBackdrop={false}
          footer={
            <>
              <Button size="sm" disabled={busy} onClick={() => setDeleteTargetId(null)}>
                취소
              </Button>
              <Button
                size="sm"
                variant="danger"
                disabled={busy}
                onClick={() => void handleDeleteConfirmed()}
              >
                삭제
              </Button>
            </>
          }
        >
          <p className="text-sm text-slate-700">
            <strong>{deleteTarget.name}</strong>을(를) 삭제합니다.
          </p>
          <p className="mt-2 text-xs text-slate-500">
            {orphanedMemberCount > 0
              ? `이 기관에 소속된 인력 ${orphanedMemberCount}명은 삭제되지 않고 소속만 비워집니다.`
              : '이 기관에 소속된 인력은 없습니다.'}{' '}
            삭제한 기관은 되돌릴 수 없습니다.
          </p>
        </Modal>
      )}
    </section>
  );
}
