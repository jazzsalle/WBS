'use client';

// 인력 ↔ 조직원 연결 모달 (SOT §7.10 "조직원 연결", §5.19, §5.11 staffId)
// 열 때 listStaff(true)로 퇴사자까지 받는다 — 지난 연차 인력은 퇴사자와 연결되는 일이 흔하다(HR-5).
// 이메일이 같은 조직원이 있으면 맨 위에 "자동 제안"으로 띄운다. 없으면 목록에서 고르거나
// [조직원으로 등록]으로 인력의 이름·직위·이메일로 새로 만든 뒤 바로 연결한다.
// 연결은 Member.staffId만 바꾼다 — 연봉은 건드리지 않는다(§7.10). 급여는 [급여 반영]이 따로 한다(SL-5).
// 실패 문구는 서버가 준 그대로 보여준다(절대 규칙 5) — "이미 이 과제의 다른 인력에 연결" 등.

import { useEffect, useMemo, useState } from 'react';
import type { Member, Staff } from '@/types';
import type { ActionErrorCode } from '@/lib/db/errors';
import { createStaff, listStaff, type StaffListItem } from '@/actions/staff';
import { linkMemberToStaff } from '@/actions/team';
import Badge from '@/components/ui/Badge';
import Button from '@/components/ui/Button';
import ErrorBanner from '@/components/ui/ErrorBanner';
import Modal from '@/components/ui/Modal';

export interface StaffLinkPickerProps {
  member: Member;
  onClose: () => void;
  /** 연결·해제·등록 후 연결 성공. staff는 새로 연결된 조직원, 해제면 null */
  onLinked: (member: Member, staff: Staff | null) => void;
}

type ListState =
  | { phase: 'loading' }
  | { phase: 'ready'; items: StaffListItem[] }
  | { phase: 'error'; message: string; code?: ActionErrorCode };

// ST-1과 같은 정규화. 화면의 자동 제안 판정이 서버의 유일 판정과 어긋나면 "제안은 됐는데 등록은 중복"이 된다
function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

export default function StaffLinkPicker({ member, onClose, onLinked }: StaffLinkPickerProps) {
  const [list, setList] = useState<ListState>({ phase: 'loading' });
  const [query, setQuery] = useState('');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [failure, setFailure] = useState<{ message: string; code?: ActionErrorCode } | null>(null);
  // CONFLICT(같은 이메일의 조직원이 이미 있음) 뒤 안내 — 목록에서 그 조직원을 고르도록 이끈다
  const [conflictHint, setConflictHint] = useState<string | null>(null);

  const memberEmail = normalizeEmail(member.email);

  const load = async (): Promise<void> => {
    setList({ phase: 'loading' });
    const res = await listStaff(true);
    if (!res.ok) {
      setList({ phase: 'error', message: res.error, code: res.code });
      return;
    }
    setList({ phase: 'ready', items: res.data });
  };

  // 모달이 열릴 때 한 번만 받는다 — 모달 안에서 다시 받는 경로는 CONFLICT 뒤의 명시적 load()뿐이다
  useEffect(() => {
    void load();
  }, []);

  const items = list.phase === 'ready' ? list.items : [];

  // 이메일이 같은 조직원 = 자동 제안. 이메일이 비어 있으면 제안하지 않는다(빈 문자열끼리 맞는 것은 제안이 아니다)
  const suggested = useMemo(
    () => (memberEmail === '' ? null : (items.find((i) => normalizeEmail(i.staff.email) === memberEmail) ?? null)),
    [items, memberEmail]
  );

  // 제안이 있으면 처음부터 골라 둔다 — 사용자는 [연결]만 누르면 된다
  useEffect(() => {
    if (suggested && selectedId === null) setSelectedId(suggested.staff.id);
  }, [suggested, selectedId]);

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    const filtered =
      q === ''
        ? items
        : items.filter(
            (i) => i.staff.name.toLowerCase().includes(q) || i.staff.email.toLowerCase().includes(q)
          );
    // 자동 제안은 검색과 무관하게 맨 위에 둔다
    if (!suggested) return filtered;
    return [suggested, ...filtered.filter((i) => i.staff.id !== suggested.staff.id)];
  }, [items, query, suggested]);

  const selected = selectedId === null ? null : (items.find((i) => i.staff.id === selectedId) ?? null);
  const current = member.staffId === null ? null : (items.find((i) => i.staff.id === member.staffId) ?? null);

  const link = async (staff: Staff | null): Promise<void> => {
    setSaving(true);
    setFailure(null);
    const res = await linkMemberToStaff(member.id, staff?.id ?? null);
    setSaving(false);
    if (!res.ok) {
      setFailure({ message: res.error, code: res.code });
      return;
    }
    onLinked(res.data, staff);
  };

  // [조직원으로 등록]: 채우는 것은 이름·직위·이메일뿐이다. 연봉은 급여 이력(/staff)에서 따로 쌓는다(SL-3)
  const registerAndLink = async (): Promise<void> => {
    if (memberEmail === '') {
      setFailure({
        message: '이메일이 없어 조직원으로 등록할 수 없습니다. 인력 이메일을 먼저 입력하세요(조직원은 이메일이 키입니다).',
        code: 'VALIDATION',
      });
      return;
    }
    setSaving(true);
    setFailure(null);
    setConflictHint(null);
    const created = await createStaff({
      name: member.name,
      email: member.email,
      position: member.position,
      employed: true,
      note: '',
    });
    if (!created.ok) {
      setSaving(false);
      if (created.code === 'CONFLICT') {
        // 이미 있는 사람이다 — 목록을 다시 받아 그 조직원이 보이게 하고 고르도록 안내한다
        setConflictHint(
          `${created.error} 아래 목록에서 같은 이메일(${memberEmail})의 조직원을 골라 연결하세요.`
        );
        await load();
        setSelectedId(null);
        return;
      }
      setFailure({ message: created.error, code: created.code });
      return;
    }
    setSaving(false);
    await link(created.data);
  };

  const busy = saving || list.phase === 'loading';

  return (
    <Modal
      open
      title="조직원 연결"
      description={`${member.name}님을 조직원과 연결합니다. 연결은 조직원만 바꾸고 연봉은 그대로입니다.`}
      onClose={onClose}
      closeOnBackdrop={false}
      size="lg"
      footer={
        <>
          <Button size="sm" onClick={onClose} disabled={saving}>
            닫기
          </Button>
          {member.staffId !== null && (
            <Button size="sm" variant="danger" disabled={busy} onClick={() => void link(null)}>
              연결 해제
            </Button>
          )}
          <Button size="sm" disabled={busy || suggested !== null} onClick={() => void registerAndLink()}>
            조직원으로 등록
          </Button>
          <Button
            size="sm"
            variant="primary"
            disabled={busy || selected === null || selected.staff.id === member.staffId}
            onClick={() => selected && void link(selected.staff)}
          >
            {saving ? '처리 중…' : '연결'}
          </Button>
        </>
      }
    >
      {failure && (
        <ErrorBanner message={failure.message} code={failure.code} className="mb-3" onDismiss={() => setFailure(null)} />
      )}

      {conflictHint && (
        <p className="mb-3 rounded-lg border border-orange-200 bg-orange-50 p-3 text-sm text-orange-800">
          {conflictHint}
        </p>
      )}

      {current && (
        <p className="mb-3 rounded-lg bg-grey-50 p-3 text-sm text-grey-700">
          현재 연결: <strong>{current.staff.name}</strong>
          <span className="text-grey-500"> ({current.staff.email})</span>
          {!current.staff.employed && (
            <Badge tone="amber" className="ml-2">
              퇴사
            </Badge>
          )}
        </p>
      )}
      {member.staffId !== null && !current && list.phase === 'ready' && (
        <p className="mb-3 rounded-lg border border-orange-200 bg-orange-50 p-3 text-sm text-orange-800">
          연결된 조직원(ID {member.staffId})이 목록에 없습니다. 삭제됐을 수 있습니다 — [연결 해제] 뒤 다시 연결하세요.
        </p>
      )}

      {list.phase === 'loading' && <p className="text-sm text-grey-500">조직원 목록을 불러오는 중…</p>}

      {list.phase === 'error' && (
        <ErrorBanner message={list.message} code={list.code} onRetry={() => void load()} />
      )}

      {list.phase === 'ready' && (
        <>
          <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
            <input
              type="search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="이름 또는 이메일로 검색"
              aria-label="이름 또는 이메일로 검색"
              className="w-full max-w-sm rounded-md border border-grey-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none focus:ring-2 focus:ring-blue-100"
            />
            <span className="text-xs text-grey-500">
              {visible.length}명 표시
              {memberEmail === '' && ' · 인력 이메일이 없어 자동 제안을 할 수 없습니다'}
            </span>
          </div>

          <div className="max-h-[50vh] overflow-y-auto rounded-xl border border-grey-200">
            <table className="w-full text-left text-sm">
              <thead className="sticky top-0 bg-grey-50 text-xs text-grey-500">
                <tr className="border-b border-grey-100">
                  <th className="px-3 py-2 font-medium">이름</th>
                  <th className="px-3 py-2 font-medium">직위</th>
                  <th className="px-3 py-2 font-medium">이메일</th>
                  <th className="px-3 py-2 font-medium">상태</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-grey-100">
                {visible.length === 0 && (
                  <tr>
                    <td colSpan={4} className="px-3 py-6 text-center text-grey-400">
                      {items.length === 0
                        ? '등록된 조직원이 없습니다. [조직원으로 등록]으로 이 인력을 조직원에 추가할 수 있습니다.'
                        : '검색과 일치하는 조직원이 없습니다.'}
                    </td>
                  </tr>
                )}
                {visible.map((item) => {
                  const isSelected = item.staff.id === selectedId;
                  const isSuggested = suggested?.staff.id === item.staff.id;
                  const isCurrent = item.staff.id === member.staffId;
                  return (
                    <tr
                      key={item.staff.id}
                      onClick={() => setSelectedId(item.staff.id)}
                      aria-selected={isSelected}
                      className={`cursor-pointer transition ${
                        isSelected ? 'bg-blue-50' : isSuggested ? 'bg-yellow-50 hover:bg-yellow-100' : 'hover:bg-grey-50'
                      }`}
                    >
                      <td className="px-3 py-2 font-medium text-grey-900">
                        {item.staff.name}
                        {isSuggested && (
                          <Badge tone="blue" className="ml-2" title="인력 이메일과 같은 조직원">
                            자동 제안
                          </Badge>
                        )}
                      </td>
                      <td className="px-3 py-2 text-grey-600">{item.staff.position || '—'}</td>
                      <td className="px-3 py-2 text-grey-600">{item.staff.email}</td>
                      <td className="px-3 py-2">
                        <div className="flex flex-wrap gap-1">
                          {isCurrent && <Badge tone="green">연결됨</Badge>}
                          {!item.staff.employed && <Badge tone="amber">퇴사</Badge>}
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          {suggested && (
            <p className="mt-2 text-xs text-grey-500">
              같은 이메일의 조직원이 있어 [조직원으로 등록]은 쓸 수 없습니다 — 제안된 조직원을 연결하세요.
            </p>
          )}
        </>
      )}
    </Modal>
  );
}
