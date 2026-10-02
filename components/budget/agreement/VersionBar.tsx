'use client';

// 수행 모드 버전 바 (SOT §7.9.8, §5.21 AV-1~AV-5·AV-8, 계획서 S-4·S-5·S-17, U-3·U-4)
// 왼쪽부터 [버전 선택] [새 버전] [빈 버전] [확정] [확정 취소] [버전 정보] [삭제] [전체 버전 삭제].
// 현재·기준 버전·확정 취소 가능 여부는 서버가 lib/agreement/versions로 계산해 내려준 값을 표시만 한다 —
// 규칙을 여기서 다시 쓰면 화면과 액션이 어긋난다(AV-3·AV-5는 파생 값).
// 확정·확정 취소·삭제·전체 삭제는 확인 대화를 거친다(AV-4·AV-8). 실패 문장은 대화 안에 그대로 보인다.
// 인쇄에는 나오지 않는다(P-R4) — 부모가 print:hidden 영역에 둔다.

import { useState } from 'react';
import type { AgreementVersion } from '@/types';
import type { ActionErrorCode } from '@/lib/db/errors';
import type { AgreementVersionView } from '@/actions/agreement';
import type { NextVersionMeta } from '@/lib/agreement/versions';
import {
  AGREEMENT_VERSION_KIND_LABELS,
  AGREEMENT_VERSION_STATUS_LABELS,
} from '@/lib/constants';
import {
  confirmAgreementVersion,
  deleteAgreementVersion,
  deleteAllAgreementVersions,
  unconfirmAgreementVersion,
} from '@/actions/agreement';
import Badge from '@/components/ui/Badge';
import Button from '@/components/ui/Button';
import ErrorBanner from '@/components/ui/ErrorBanner';
import Modal from '@/components/ui/Modal';
import NewVersionDialog, { type NewVersionMode } from './NewVersionDialog';
import VersionMetaDialog from './VersionMetaDialog';

type ConfirmKind = 'confirm' | 'unconfirm' | 'delete' | 'deleteAll';

/** 목록·머리말 공용 — 이름이 종류 라벨과 같으면(예: '선정평가본') 한 번만 적는다 */
export function versionTitle(v: AgreementVersion): string {
  const kindLabel = AGREEMENT_VERSION_KIND_LABELS[v.kind];
  return v.name === kindLabel ? v.name : `${v.name} (${kindLabel})`;
}

/** SOT §7.9.8 AV-2 비활성 이유 문구 */
export function draftExistsReason(draftName: string): string {
  return `작성 중 버전 ${draftName}이 있습니다 — 확정하거나 삭제한 뒤 만드세요`;
}

function optionLabel(v: AgreementVersion, isCurrent: boolean, isBase: boolean): string {
  const parts = [
    versionTitle(v),
    v.baseDate ? `기준일 ${v.baseDate}` : '기준일 없음',
    AGREEMENT_VERSION_STATUS_LABELS[v.status],
  ];
  if (isCurrent) parts.push('현재');
  if (isBase) parts.push('기준');
  return parts.join(' · ');
}

export interface VersionBarProps {
  projectId: string;
  /** order 오름차순 */
  versions: AgreementVersionView[];
  /** 보고 있는 버전 */
  selected: AgreementVersionView;
  currentVersionId: string | null;
  draftVersionId: string | null;
  nextVersionMeta: NextVersionMeta;
  onSelect: (versionId: string) => void;
  /** 새 버전·빈 버전을 만들었다 — 부모가 그 버전을 선택하고 새로고침한다 */
  onCreated: (versionId: string) => void;
  /** 확정·확정 취소·메타 저장 — 부모가 새로고침한다 */
  onChanged: () => void;
  /** 보고 있던 버전(또는 전체)을 지웠다 — 부모가 선택을 기본(현재 버전)으로 돌리고 새로고침한다 */
  onDeleted: () => void;
}

export default function VersionBar({
  projectId,
  versions,
  selected,
  currentVersionId,
  draftVersionId,
  nextVersionMeta,
  onSelect,
  onCreated,
  onChanged,
  onDeleted,
}: VersionBarProps) {
  const [newMode, setNewMode] = useState<NewVersionMode | null>(null);
  const [metaOpen, setMetaOpen] = useState(false);
  const [confirming, setConfirming] = useState<ConfirmKind | null>(null);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<{ message: string; code?: ActionErrorCode } | null>(null);

  const v = selected.version;
  const isDraft = v.status === 'draft';
  const draft = draftVersionId ? versions.find((x) => x.version.id === draftVersionId) ?? null : null;
  // AV-2: 작성 중 버전이 이미 있으면 새로 만들 수 없다. 목록에서 못 찾아도 id가 있으면 막는다 — 서버가 어차피 거부한다
  const createBlockedReason =
    draftVersionId !== null ? draftExistsReason(draft ? draft.version.name : '(목록에 없는 버전)') : null;
  const latest = versions.length > 0 ? versions[versions.length - 1]! : null;
  const base = selected.baseVersionId
    ? versions.find((x) => x.version.id === selected.baseVersionId) ?? null
    : null;

  const openConfirm = (kind: ConfirmKind): void => {
    setFailure(null);
    setConfirming(kind);
  };

  const closeConfirm = (): void => {
    if (busy) return;
    setConfirming(null);
    setFailure(null);
  };

  const runConfirmed = async (): Promise<void> => {
    if (!confirming) return;
    setBusy(true);
    setFailure(null);
    try {
      if (confirming === 'confirm' || confirming === 'unconfirm') {
        // O-1: 화면이 마지막으로 받은 버전 행의 version을 조건으로 건다
        const res =
          confirming === 'confirm'
            ? await confirmAgreementVersion(v.id, v.version)
            : await unconfirmAgreementVersion(v.id, v.version);
        if (!res.ok) {
          setFailure({ message: res.error, code: res.code });
          // STALE: 최신 버전 행을 받아 와야 다시 시도할 수 있다. 대화는 열어 둬 무엇이 실패했는지 보인다
          if (res.code === 'STALE') onChanged();
          return;
        }
        setConfirming(null);
        onChanged();
        return;
      }
      const res =
        confirming === 'delete'
          ? await deleteAgreementVersion(v.id)
          : await deleteAllAgreementVersions(projectId);
      if (!res.ok) {
        setFailure({ message: res.error, code: res.code });
        return;
      }
      setConfirming(null);
      onDeleted();
    } finally {
      setBusy(false);
    }
  };

  const confirmCopy: Record<ConfirmKind, { title: string; body: string; action: string; danger: boolean }> = {
    confirm: {
      title: '버전 확정',
      body: `'${v.name}'을(를) 확정합니다. 확정하면 금액 줄·참여인원·편성 항목을 고칠 수 없습니다(버전 정보는 계속 고칠 수 있습니다). 뒤에 버전이 쌓이기 전까지는 [확정 취소]로 되돌릴 수 있습니다.`,
      action: '확정',
      danger: false,
    },
    unconfirm: {
      title: '확정 취소',
      body: `'${v.name}'을(를) 작성 중으로 되돌립니다. 내용을 다시 고칠 수 있게 되고, 확정 시각은 지워집니다.`,
      action: '확정 취소',
      danger: false,
    },
    delete: {
      title: '버전 삭제',
      body: `'${v.name}'(${AGREEMENT_VERSION_STATUS_LABELS[v.status]})을(를) 삭제합니다. 이 버전의 금액 줄 ${selected.lineCount.toLocaleString('ko-KR')}개와 참여인원·편성 항목이 함께 지워지며 되돌릴 수 없습니다. 남은 버전의 순번은 바뀌지 않습니다.`,
      action: '삭제',
      danger: true,
    },
    deleteAll: {
      title: '전체 버전 삭제',
      body: `이 과제의 협약 예산 버전 ${versions.length.toLocaleString('ko-KR')}개를 모두 삭제합니다. 확정 버전도 지워지며, 각 버전의 금액 줄·참여인원·편성 항목도 함께 지워집니다. 되돌릴 수 없습니다.`,
      action: `${versions.length.toLocaleString('ko-KR')}개 모두 삭제`,
      danger: true,
    },
  };

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        <label className="flex items-center gap-2">
          <span className="text-sm font-semibold text-grey-700">버전</span>
          <select
            value={v.id}
            onChange={(e) => onSelect(e.target.value)}
            disabled={busy}
            aria-label="협약 예산 버전 선택"
            className="max-w-[28rem] rounded-lg border border-grey-300 bg-surface px-3 py-1.5 text-sm focus:border-grey-500 focus:outline-none"
          >
            {versions.map((x) => (
              <option key={x.version.id} value={x.version.id}>
                {optionLabel(
                  x.version,
                  x.version.id === currentVersionId,
                  x.version.id === selected.baseVersionId
                )}
              </option>
            ))}
          </select>
        </label>

        <Badge tone={isDraft ? 'amber' : 'green'}>{AGREEMENT_VERSION_STATUS_LABELS[v.status]}</Badge>
        {v.id === currentVersionId && (
          // U-3: 확정 0개면 작성 중 버전이 현재다 — 상태 배지와 함께 "현재 · 작성 중"으로 읽힌다
          <Badge tone="blue" title="확정 버전 중 가장 최근 것(확정 버전이 없으면 작성 중 버전)">
            현재
          </Badge>
        )}
        <span className="text-xs text-grey-500">
          기준 버전:{' '}
          {base ? (
            <span className="font-semibold text-grey-700">{base.version.name}</span>
          ) : (
            '기준 버전 없음'
          )}
        </span>

        <span className="mx-1 h-5 w-px bg-grey-200" aria-hidden />

        <Button
          size="sm"
          onClick={() => setNewMode('clone')}
          disabled={busy || createBlockedReason !== null || latest === null}
          title={createBlockedReason ?? '마지막 버전을 복제해 작성 중 버전을 만듭니다'}
        >
          새 버전
        </Button>
        <Button
          size="sm"
          onClick={() => setNewMode('empty')}
          disabled={busy || createBlockedReason !== null}
          title={createBlockedReason ?? '금액 줄이 없는 작성 중 버전을 만듭니다'}
        >
          빈 버전
        </Button>
        {isDraft && (
          <Button size="sm" variant="primary" onClick={() => openConfirm('confirm')} disabled={busy}>
            확정
          </Button>
        )}
        {selected.canUnconfirm && (
          <Button size="sm" onClick={() => openConfirm('unconfirm')} disabled={busy}>
            확정 취소
          </Button>
        )}
        <Button size="sm" onClick={() => setMetaOpen(true)} disabled={busy}>
          버전 정보
        </Button>
        <Button size="sm" variant="ghost" onClick={() => openConfirm('delete')} disabled={busy}>
          삭제
        </Button>
        <Button size="sm" variant="ghost" onClick={() => openConfirm('deleteAll')} disabled={busy}>
          전체 버전 삭제 ({versions.length.toLocaleString('ko-KR')}개)
        </Button>
      </div>

      {createBlockedReason && (
        <p className="text-xs text-grey-500">[새 버전]·[빈 버전]: {createBlockedReason}</p>
      )}

      {newMode && (
        <NewVersionDialog
          mode={newMode}
          projectId={projectId}
          sourceName={latest ? latest.version.name : null}
          initialMeta={nextVersionMeta}
          onClose={() => setNewMode(null)}
          onCreated={(id) => {
            setNewMode(null);
            onCreated(id);
          }}
        />
      )}

      {metaOpen && (
        <VersionMetaDialog
          // 다른 버전으로 바꾸면 입력을 섞지 않도록 새로 시작한다
          key={v.id}
          version={v}
          onClose={() => setMetaOpen(false)}
          onSaved={() => {
            setMetaOpen(false);
            onChanged();
          }}
        />
      )}

      {confirming && (
        <Modal
          open
          title={confirmCopy[confirming].title}
          onClose={closeConfirm}
          closeOnBackdrop={false}
          footer={
            <>
              <Button size="sm" onClick={closeConfirm} disabled={busy}>
                취소
              </Button>
              <Button
                size="sm"
                variant={confirmCopy[confirming].danger ? 'danger' : 'primary'}
                onClick={() => void runConfirmed()}
                disabled={busy}
              >
                {busy ? '처리 중…' : confirmCopy[confirming].action}
              </Button>
            </>
          }
        >
          {failure && (
            <ErrorBanner
              message={failure.message}
              code={failure.code}
              onDismiss={() => setFailure(null)}
              // RULE 문장의 줄바꿈을 살린다 — white-space는 상속된다
              className="mb-4 whitespace-pre-line"
            />
          )}
          <p className="text-sm text-grey-700">{confirmCopy[confirming].body}</p>
        </Modal>
      )}
    </div>
  );
}
