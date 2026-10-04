'use client';

// 편성 항목 증빙 체크리스트 펼침 편집 (SOT §5.24, §6.19 AG-6, §7.9.8 "편성 항목·증빙 보기", §8.4 O-1·O-3, 계획서 S-1·U-3)
//
// 편집 범위는 버전 상태로 갈린다(U-3):
//  - 작성 중 = 서류 추가·삭제·이름 변경·받음 체크·메모
//  - 확정    = 받음 체크·메모만(AV-2 잠금 예외). 라벨은 글자로만 보이고 추가·삭제 버튼이 없다
// 저장 전 검사는 서버와 같은 순수 함수(`resolveEvidenceUpdate` — 공백 이름·중복·길이·확정 잠금)다. 화면이 같은 문구를
// 먼저 보여 줄 뿐이고, 최종 판정은 액션(Zod·잠금 해석)과 DB 가드다.
// STALE은 ConflictDialog(O-3) — 입력은 그대로 두고, 다시 불러오면 최신 목록과 다른 서류만 보여 준다.
// 이 편집기는 인쇄에 나오지 않는다 — 인쇄는 행의 "받음 n/m"만 찍는다(§7.9.8).

import { useEffect, useMemo, useRef, useState } from 'react';
import type { AgreementEvidenceCheck, AgreementItem } from '@/types';
import type { ActionErrorCode } from '@/lib/db/errors';
import { updateAgreementItemEvidence } from '@/actions/agreement-items';
import { AGREEMENT_ITEM_MAX_LENGTH } from '@/lib/constants';
import {
  EVIDENCE_TEXT,
  evidenceProgress,
  evidenceProgressText,
  resolveEvidenceUpdate,
  sameEvidenceLabels,
  type EvidenceUpdateResolution,
} from '@/lib/agreement/evidence';
import Button from '@/components/ui/Button';
import ErrorBanner from '@/components/ui/ErrorBanner';
import ConflictDialog from '@/components/ui/ConflictDialog';
import { setRealtimePaused } from '@/components/RealtimeRefresher';

const INPUT_CLASS =
  'w-full rounded-lg border border-grey-300 bg-surface px-2.5 py-1.5 text-xs focus:border-grey-500 focus:outline-none';

/** 화면 편집용 행 — key는 이름을 바꿔도 React 행이 유지되게 하는 로컬 식별자다(저장하지 않는다) */
interface DraftCheck extends AgreementEvidenceCheck {
  key: number;
}

function toDraft(evidence: readonly AgreementEvidenceCheck[], startKey: number): DraftCheck[] {
  return evidence.map((check, i) => ({ key: startKey + i, label: check.label, obtained: check.obtained, memo: check.memo }));
}

function toChecks(draft: readonly DraftCheck[]): AgreementEvidenceCheck[] {
  return draft.map(({ label, obtained, memo }) => ({ label, obtained, memo }));
}

function sameChecks(a: readonly AgreementEvidenceCheck[], b: readonly AgreementEvidenceCheck[]): boolean {
  return (
    a.length === b.length &&
    a.every((x, i) => x.label === b[i]!.label && x.obtained === b[i]!.obtained && x.memo === b[i]!.memo)
  );
}

function describe(check: AgreementEvidenceCheck | undefined): string {
  if (check === undefined) return '(없음)';
  const status = check.obtained ? EVIDENCE_TEXT.obtained : EVIDENCE_TEXT.missing;
  return check.memo.trim() === '' ? status : `${status} · ${check.memo.trim()}`;
}

export interface EvidenceEditorProps {
  /** 최신 서버 행(version 포함 — O-1). 다시 불러오기 후 최신 값이 여기로 온다 */
  item: AgreementItem;
  /** 보고 있는 버전이 확정이면 true — 체크·메모만(U-3). 서버 잠금 판정과 같은 입력이다 */
  confirmed: boolean;
  /** 저장 성공 — 부모가 새로 불러온다. 편집기는 열린 채 저장된 값을 새 기준으로 삼는다 */
  onSaved: (saved: AgreementItem) => void;
  /** O-3 [다시 불러오기] — 부모가 서버 값을 새로 받는다 */
  onReload: () => void;
  /** [닫기] — 저장하지 않은 입력은 버린다 */
  onClose: () => void;
}

export default function EvidenceEditor({ item, confirmed, onSaved, onReload, onClose }: EvidenceEditorProps) {
  const nextKey = useRef(item.evidence.length);
  const [draft, setDraft] = useState<DraftCheck[]>(() => toDraft(item.evidence, 0));
  // O-3 비교 기준: 마지막으로 받아들인 서버 행. 잠금 사전 검사와 expectedVersion은 여기서만 나온다
  const [baseline, setBaseline] = useState<AgreementItem>(item);
  const [reloaded, setReloaded] = useState(false);
  const [saving, setSaving] = useState(false);
  const [failure, setFailure] = useState<{ message: string; code?: ActionErrorCode } | null>(null);
  const [conflict, setConflict] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  // R-4: 펼쳐 둔 동안 자동 새로고침을 보류해 입력 중인 체크·메모를 지킨다
  useEffect(() => {
    setRealtimePaused(true);
    return () => setRealtimePaused(false);
  }, []);

  // 부모가 더 새 행을 내려주면(다시 불러오기·다른 사람의 저장) 비교 기준만 바꾼다. 입력은 건드리지 않는다(O-3)
  useEffect(() => {
    if (item.version === baseline.version) return;
    if (item.version < baseline.version) return; // 저장 직후 아직 옛 값을 받은 경우 — 내 저장값이 더 새롭다
    setBaseline(item);
    setConflict(null);
    setReloaded(true);
  }, [item, baseline.version]);

  const checks = useMemo(() => toChecks(draft), [draft]);
  const dirty = !sameChecks(checks, baseline.evidence);
  const progress = evidenceProgress(checks);

  // 저장 전 사전 검사 — 서버와 같은 해석(공백 이름·중복·길이·확정 잠금)
  // 저장값이 손상돼 있으면(DB check가 막았어야 하는 상태) 던진다 — 저장을 막고 손상이라고 알린다(절대 규칙 5)
  const precheck = useMemo((): EvidenceUpdateResolution => {
    try {
      return resolveEvidenceUpdate(baseline.evidence, checks, confirmed);
    } catch (e) {
      const detail = e instanceof Error ? e.message : String(e);
      return { kind: 'reject', reason: 'invalid', messages: [`저장된 증빙이 손상되었습니다 — ${detail}`] };
    }
  }, [baseline.evidence, checks, confirmed]);

  const differences = useMemo(() => {
    if (!reloaded) return [];
    const mine = new Map(checks.map((c) => [c.label.trim(), c]));
    const latest = new Map(baseline.evidence.map((c) => [c.label, c]));
    const labels = [...new Set([...latest.keys(), ...mine.keys()])];
    return labels
      .filter((label) => {
        const a = mine.get(label);
        const b = latest.get(label);
        return a === undefined || b === undefined || a.obtained !== b.obtained || a.memo !== b.memo;
      })
      .map((label) => ({ label, mine: mine.get(label), latest: latest.get(label) }));
  }, [reloaded, checks, baseline.evidence]);

  const labelsDifferFromLatest = !sameEvidenceLabels(checks, baseline.evidence);

  const update = (key: number, patch: Partial<AgreementEvidenceCheck>): void => {
    setSaved(false);
    setDraft((prev) => prev.map((c) => (c.key === key ? { ...c, ...patch } : c)));
  };

  const addCheck = (): void => {
    setSaved(false);
    const key = nextKey.current;
    nextKey.current += 1;
    setDraft((prev) => [...prev, { key, label: '', obtained: false, memo: '' }]);
  };

  const removeCheck = (key: number): void => {
    setSaved(false);
    setDraft((prev) => prev.filter((c) => c.key !== key));
  };

  const applyLatest = (): void => {
    const key = nextKey.current;
    nextKey.current += baseline.evidence.length;
    setDraft(toDraft(baseline.evidence, key));
    setReloaded(false);
  };

  const handleSave = async (): Promise<void> => {
    setFailure(null);
    setSaved(false);
    if (precheck.kind === 'reject') {
      setFailure({ message: precheck.messages.join('\n'), code: precheck.reason === 'locked' ? 'RULE' : 'VALIDATION' });
      return;
    }
    setSaving(true);
    try {
      // O-1: 마지막으로 받아들인 서버 행의 version을 조건으로 건다
      const res = await updateAgreementItemEvidence(baseline.id, precheck.evidence, baseline.version);
      if (!res.ok) {
        if (res.code === 'STALE') setConflict(res.error);
        else setFailure({ message: res.error, code: res.code });
        return;
      }
      // 저장된 값(서버가 정규화한 라벨)을 새 기준·입력으로 — 부모의 새로고침이 같은 version을 내려주면 그대로다
      const key = nextKey.current;
      nextKey.current += res.data.evidence.length;
      setBaseline(res.data);
      setDraft(toDraft(res.data.evidence, key));
      setReloaded(false);
      setSaved(true);
      onSaved(res.data);
    } catch (err) {
      // 네트워크 단절 등 — 저장됐는지 모르는 채로 넘어가지 않는다
      setFailure({ message: `증빙을 저장하지 못했습니다: ${err instanceof Error ? err.message : String(err)}` });
    } finally {
      setSaving(false);
    }
  };

  const max = AGREEMENT_ITEM_MAX_LENGTH;
  const canAdd = !confirmed && draft.length < max.evidence;

  return (
    <div
      className="space-y-3 rounded-xl border border-grey-200 bg-grey-50 p-3 print:hidden"
      role="group"
      aria-label={`${item.name} 증빙`}
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-t7 font-semibold text-grey-800">
          증빙 — {evidenceProgressText(progress)}
          {dirty && <span className="ml-2 font-normal text-orange-700">(저장하지 않은 변경)</span>}
        </p>
        <p className="text-xs text-grey-500">
          {confirmed
            ? '확정 버전 — 받음 체크와 메모만 바꿀 수 있습니다. 서류 추가·삭제·이름 변경은 작성 중 버전에서 하세요.'
            : '받음 체크·메모를 적고, 필요하면 서류를 추가·삭제·이름 변경합니다. 파일은 첨부하지 않습니다.'}
        </p>
      </div>

      {failure && (
        <ErrorBanner
          message={failure.message}
          code={failure.code}
          onDismiss={() => setFailure(null)}
          className="whitespace-pre-line"
        />
      )}

      {reloaded && (
        <div className="rounded-xl border border-orange-200 bg-orange-50 p-3 text-xs text-orange-800">
          <p className="text-sm font-semibold">최신 증빙을 다시 불러왔습니다.</p>
          {differences.length === 0 && !labelsDifferFromLatest ? (
            <p className="mt-1">내 입력과 다른 서류가 없습니다. 그대로 저장하면 됩니다.</p>
          ) : (
            <>
              <p className="mt-1">
                아래 서류가 서로 다릅니다. 내 입력은 그대로 두었습니다
                {confirmed && labelsDifferFromLatest
                  ? ' — 확정 버전이라 서류 목록이 최신과 같아야 저장됩니다. [최신 목록 사용]으로 맞추세요.'
                  : '.'}
              </p>
              <ul className="mt-2 space-y-1">
                {differences.map((d) => (
                  <li key={d.label} className="flex flex-wrap gap-2 rounded-lg bg-surface/70 px-2.5 py-1">
                    <span className="font-semibold text-grey-700">{d.label === '' ? '(이름 없음)' : d.label}</span>
                    <span className="text-grey-500">내 입력: {describe(d.mine)}</span>
                    <span className="text-grey-500">최신: {describe(d.latest)}</span>
                  </li>
                ))}
              </ul>
              <button
                type="button"
                onClick={applyLatest}
                className="mt-2 rounded-md border border-orange-300 px-2 py-0.5 font-semibold text-orange-800"
              >
                최신 목록 사용
              </button>
            </>
          )}
        </div>
      )}

      {draft.length === 0 ? (
        <p className="text-xs text-grey-500">
          증빙 서류가 없습니다.{confirmed ? '' : ' [서류 추가]로 넣으세요.'}
        </p>
      ) : (
        <table className="w-full text-xs">
          <caption className="sr-only">{item.name}의 증빙 서류별 받음 여부와 메모</caption>
          <thead className="text-grey-500">
            <tr>
              <th scope="col" className="w-16 px-2 py-1 text-center font-medium">
                {EVIDENCE_TEXT.obtained}
              </th>
              <th scope="col" className="px-2 py-1 text-left font-medium">
                서류
              </th>
              <th scope="col" className="px-2 py-1 text-left font-medium">
                메모
              </th>
              {!confirmed && (
                <th scope="col" className="px-2 py-1">
                  <span className="sr-only">작업</span>
                </th>
              )}
            </tr>
          </thead>
          <tbody className="divide-y divide-grey-100">
            {draft.map((check, index) => {
              const name = check.label.trim() === '' ? `${index + 1}번째 서류` : check.label.trim();
              return (
                <tr key={check.key}>
                  <td className="px-2 py-1 text-center">
                    <input
                      type="checkbox"
                      checked={check.obtained}
                      onChange={(e) => update(check.key, { obtained: e.target.checked })}
                      aria-label={`${name} ${EVIDENCE_TEXT.obtained}`}
                      className="h-4 w-4"
                    />
                  </td>
                  <td className="px-2 py-1">
                    {confirmed ? (
                      <span className="text-grey-800">{check.label}</span>
                    ) : (
                      <input
                        type="text"
                        value={check.label}
                        onChange={(e) => update(check.key, { label: e.target.value })}
                        maxLength={max.label}
                        placeholder="서류 이름"
                        aria-label={`${index + 1}번째 서류 이름`}
                        className={INPUT_CLASS}
                      />
                    )}
                  </td>
                  <td className="px-2 py-1">
                    <input
                      type="text"
                      value={check.memo}
                      onChange={(e) => update(check.key, { memo: e.target.value })}
                      maxLength={max.memo}
                      placeholder="메모(선택)"
                      aria-label={`${name} 메모`}
                      className={INPUT_CLASS}
                    />
                  </td>
                  {!confirmed && (
                    <td className="px-2 py-1 text-right">
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => removeCheck(check.key)}
                        disabled={saving}
                        aria-label={`${name} 삭제`}
                      >
                        삭제
                      </Button>
                    </td>
                  )}
                </tr>
              );
            })}
          </tbody>
        </table>
      )}

      {precheck.kind === 'reject' && (
        <ul className="list-disc space-y-0.5 pl-5 text-xs text-red-700" aria-live="polite">
          {precheck.messages.map((m) => (
            <li key={m}>{m}</li>
          ))}
        </ul>
      )}

      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          {!confirmed && (
            <Button size="sm" onClick={addCheck} disabled={saving || !canAdd}>
              서류 추가
            </Button>
          )}
          {!confirmed && !canAdd && (
            <span className="ml-2 text-xs text-grey-500">증빙은 {max.evidence}개까지입니다.</span>
          )}
        </div>
        <div className="flex items-center gap-2">
          {saved && !dirty && (
            <span role="status" className="text-xs text-green-600">
              저장했습니다.
            </span>
          )}
          <Button size="sm" onClick={onClose} disabled={saving}>
            {dirty ? '취소' : '닫기'}
          </Button>
          <Button
            size="sm"
            variant="primary"
            onClick={() => void handleSave()}
            disabled={saving || !dirty || precheck.kind === 'reject'}
          >
            {saving ? '저장 중…' : '증빙 저장'}
          </Button>
        </div>
      </div>

      {conflict && (
        <ConflictDialog
          message={conflict}
          // 다시 가져오면 부모가 최신 행을 내려주고, 위 effect가 비교 패널을 연다
          onReload={() => {
            setConflict(null);
            onReload();
          }}
          onKeepEditing={() => setConflict(null)}
        />
      )}
    </div>
  );
}
