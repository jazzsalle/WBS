'use client';

// [새 버전]·[빈 버전] 대화 (SOT §7.9.8 버전 바, §5.21 AV-1·AV-2, 계획서 S-17·S-22)
// 종류·이름 두 칸만 받는다 — 나머지 메타는 만든 뒤 [버전 정보]에서 채운다.
// 초깃값은 서버가 계산한 nextVersionMeta(S-22)이고, 사용자가 고칠 수 있다(AV-1).
// 작성 중 버전이 있으면 이 대화는 열리지 않지만(버전 바가 막는다), 그사이 남이 만들었으면
// 서버가 RULE로 거부한다 — 그 문장을 줄바꿈까지 그대로 보인다.

import { useEffect, useRef, useState } from 'react';
import type { AgreementVersionKind } from '@/types';
import type { ActionErrorCode } from '@/lib/db/errors';
import type { NextVersionMeta } from '@/lib/agreement/versions';
import { AGREEMENT_VERSION_KIND_LABELS, AGREEMENT_VERSION_KIND_ORDER } from '@/lib/constants';
import { cloneLatestAgreementVersion, createEmptyAgreementVersion } from '@/actions/agreement';
import Modal from '@/components/ui/Modal';
import Button from '@/components/ui/Button';
import ErrorBanner from '@/components/ui/ErrorBanner';
import { setRealtimePaused } from '@/components/RealtimeRefresher';

/** 'clone' = [새 버전](마지막 버전 복제, AV-1), 'empty' = [빈 버전] */
export type NewVersionMode = 'clone' | 'empty';

const INPUT_CLASS =
  'mt-1 w-full rounded-lg border border-grey-300 bg-surface px-3 py-2 text-sm focus:border-grey-500 focus:outline-none';

export interface NewVersionDialogProps {
  mode: NewVersionMode;
  projectId: string;
  /** 복제 원본 이름 — 'clone'일 때 무엇을 복제하는지 알린다 */
  sourceName: string | null;
  initialMeta: NextVersionMeta;
  onClose: () => void;
  /** 만든 버전 id. 부모가 그 버전을 선택하고 router.refresh()한다 */
  onCreated: (versionId: string) => void;
}

export default function NewVersionDialog({
  mode,
  projectId,
  sourceName,
  initialMeta,
  onClose,
  onCreated,
}: NewVersionDialogProps) {
  const [kind, setKind] = useState<AgreementVersionKind>(initialMeta.kind);
  const [name, setName] = useState(initialMeta.name);
  const [saving, setSaving] = useState(false);
  const [failure, setFailure] = useState<{ message: string; code?: ActionErrorCode } | null>(null);

  // R-4: 대화가 열린 동안 자동 새로고침을 보류해 입력 중인 이름을 지킨다
  useEffect(() => {
    setRealtimePaused(true);
    return () => setRealtimePaused(false);
  }, []);

  const nameRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    nameRef.current?.focus();
  }, []);

  const handleSubmit = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault();
    setFailure(null);
    if (name.trim() === '') {
      setFailure({ message: '버전 이름을 입력하세요.', code: 'VALIDATION' });
      return;
    }
    setSaving(true);
    try {
      const input = { kind, name: name.trim() };
      const res =
        mode === 'clone'
          ? await cloneLatestAgreementVersion(projectId, input)
          : await createEmptyAgreementVersion(projectId, input);
      if (!res.ok) {
        setFailure({ message: res.error, code: res.code });
        return;
      }
      onCreated(res.data.versionId);
    } finally {
      setSaving(false);
    }
  };

  const isClone = mode === 'clone';

  return (
    <Modal
      open
      title={isClone ? '새 버전' : '빈 버전'}
      description={
        isClone
          ? `마지막 버전${sourceName ? ` '${sourceName}'` : ''}의 금액 줄·참여인원·편성 항목을 그대로 복제해 작성 중 버전을 만듭니다. 원본은 바뀌지 않습니다.`
          : '금액 줄이 하나도 없는 작성 중 버전을 만듭니다. 비목별 보기에서 금액을 입력하세요.'
      }
      onClose={onClose}
      closeOnBackdrop={false}
    >
      <form onSubmit={handleSubmit}>
        {failure && (
          <ErrorBanner
            message={failure.message}
            code={failure.code}
            onDismiss={() => setFailure(null)}
            // RULE 문장의 줄바꿈을 살린다 — white-space는 상속된다
            className="mb-4 whitespace-pre-line"
          />
        )}

        <div className="grid gap-4">
          <label>
            <span className="text-sm font-medium text-grey-700">종류</span>
            <select
              value={kind}
              onChange={(e) => setKind(e.target.value as AgreementVersionKind)}
              className={INPUT_CLASS}
            >
              {AGREEMENT_VERSION_KIND_ORDER.map((k) => (
                <option key={k} value={k}>
                  {AGREEMENT_VERSION_KIND_LABELS[k]}
                </option>
              ))}
            </select>
          </label>

          <label>
            <span className="text-sm font-medium text-grey-700">
              이름 <span className="text-red-600">*</span>
            </span>
            <input
              ref={nameRef}
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              maxLength={100}
              required
              placeholder="예: 협약변경 1차"
              className={INPUT_CLASS}
            />
          </label>
        </div>

        <p className="mt-3 text-xs text-grey-500">
          만든 버전은 작성 중 상태입니다. 기준일·변경 사유 등은 [버전 정보]에서 채웁니다.
        </p>

        <div className="mt-6 flex justify-end gap-2">
          <Button onClick={onClose} disabled={saving}>
            취소
          </Button>
          <Button type="submit" variant="primary" disabled={saving}>
            {saving ? '만드는 중…' : '만들기'}
          </Button>
        </div>
      </form>
    </Modal>
  );
}
