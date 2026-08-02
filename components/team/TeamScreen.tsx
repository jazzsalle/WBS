'use client';

// 인력·기관 화면 컨테이너 (SOT §7.10)
// 데이터는 전부 서버(page.tsx)가 조회해 내려준다. 여기서는 두 섹션이 공유하는
// 진행 중(busy)·실패(failure) 상태와 성공 후 router.refresh()만 소유한다 —
// 섹션이 각자 새로고침하면 기관 삭제로 인력의 소속이 바뀐 것 같은 교차 영향(H-8, N-8)을 놓친다.

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import type { Member, Organization } from '@/types';
import type { AssignedTask } from '@/actions/team';
import type { ActionErrorCode } from '@/lib/db/errors';
import ErrorBanner from '@/components/ui/ErrorBanner';
import OrganizationSection from './OrganizationSection';
import MemberSection from './MemberSection';

/** 두 섹션이 컨테이너의 상태를 다루는 공통 계약. 섹션은 자기 성공/실패를 여기로 올린다. */
export interface TeamSectionCallbacks {
  busy: boolean;
  onBusyChange: (busy: boolean) => void;
  onError: (message: string, code?: ActionErrorCode) => void;
  onDone: () => void; // 성공 시 TeamScreen이 router.refresh()
}

export interface TeamScreenProps {
  projectId: string;
  pmMemberId: string | null;
  leadOrgId: string | null;
  organizations: Organization[];
  members: Member[];
  assignedTasksByMember: Record<string, AssignedTask[]>;
}

export default function TeamScreen({
  projectId,
  pmMemberId,
  leadOrgId,
  organizations,
  members,
  assignedTasksByMember,
}: TeamScreenProps) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<{ message: string; code?: ActionErrorCode } | null>(null);

  const callbacks: TeamSectionCallbacks = {
    busy,
    onBusyChange: setBusy,
    // 절대 규칙 5: 실패는 반드시 화면에 남긴다
    onError: (message, code) => setFailure({ message, code }),
    onDone: () => {
      setFailure(null);
      router.refresh();
    },
  };

  return (
    <div className="space-y-8">
      {failure && (
        <ErrorBanner
          message={failure.message}
          code={failure.code}
          onDismiss={() => setFailure(null)}
        />
      )}

      <OrganizationSection
        projectId={projectId}
        organizations={organizations}
        members={members}
        leadOrgId={leadOrgId}
        {...callbacks}
      />

      <MemberSection
        projectId={projectId}
        members={members}
        organizations={organizations}
        pmMemberId={pmMemberId}
        assignedTasksByMember={assignedTasksByMember}
        {...callbacks}
      />
    </div>
  );
}
