'use client';

// 프리셋 적용 (SOT §7.9.5, §9 applyRulePreset, 부록 D, RL-D4)
// [채우기]는 즉시 — 없는 코드만 추가하므로 되돌릴 것이 없다.
// [덮어쓰기]는 사용자가 고친 값을 프리셋 값으로 되돌리므로 2단계 확인을 받는다(§9).
// 어느 쪽이든 프리셋 밖의 기존 행과 메모는 서버(RPC)가 보존한다 — 확인 문구가 그것을 말한다.
// 프리셋 선택은 부모(RulesEditor)가 갖는다 — 안내 목록(AdvisoryList)도 같은 선택을 따라가야 한다.

import { useState } from 'react';
import type { ActionErrorCode } from '@/lib/db/errors';
import { PRESET_IDS, RULE_PRESETS, isPresetId, type PresetId } from '@/lib/rules-presets';
import {
  applyRulePreset,
  type ApplyPresetResult,
  type RulePresetMode,
} from '@/actions/budget-rules';
import Button from '@/components/ui/Button';
import ErrorBanner from '@/components/ui/ErrorBanner';

export interface PresetPickerProps {
  projectId: string;
  presetId: PresetId;
  onPresetChange: (presetId: PresetId) => void;
  /** 적용 성공 뒤 — 부모가 행 목록을 다시 읽고 onChanged를 올린다 */
  onApplied: (result: ApplyPresetResult) => void | Promise<void>;
  disabled?: boolean;
}

const MODE_LABELS: Record<RulePresetMode, string> = { fill: '채우기', overwrite: '덮어쓰기' };

interface AppliedNotice {
  presetLabel: string;
  mode: RulePresetMode;
  result: ApplyPresetResult;
}

export default function PresetPicker({
  projectId,
  presetId,
  onPresetChange,
  onApplied,
  disabled = false,
}: PresetPickerProps) {
  const [applying, setApplying] = useState<RulePresetMode | null>(null);
  const [confirmingOverwrite, setConfirmingOverwrite] = useState(false);
  const [notice, setNotice] = useState<AppliedNotice | null>(null);
  const [failure, setFailure] = useState<{ message: string; code?: ActionErrorCode } | null>(null);

  const preset = RULE_PRESETS[presetId];
  const busy = disabled || applying !== null;

  const apply = async (mode: RulePresetMode): Promise<void> => {
    setFailure(null);
    setNotice(null);
    setApplying(mode);
    try {
      const res = await applyRulePreset(projectId, presetId, mode);
      if (!res.ok) {
        setFailure({ message: res.error, code: res.code });
        return;
      }
      setConfirmingOverwrite(false);
      setNotice({ presetLabel: preset.label, mode, result: res.data });
      await onApplied(res.data);
    } finally {
      setApplying(null);
    }
  };

  return (
    <section aria-label="프리셋 적용" className="rounded-xl border border-hairline bg-grey-50 p-4">
      <div className="flex flex-wrap items-end gap-3">
        <label className="min-w-[260px] flex-1">
          <span className="block text-t7 font-semibold text-grey-600">프리셋 (부록 D)</span>
          <select
            value={presetId}
            disabled={busy}
            onChange={(e) => {
              if (!isPresetId(e.target.value)) return;
              onPresetChange(e.target.value);
              // 다른 프리셋으로 넘어가면 이전 확인·결과는 그 프리셋의 것이라 치운다
              setConfirmingOverwrite(false);
              setNotice(null);
              setFailure(null);
            }}
            className="mt-1 w-full rounded-md border border-grey-300 bg-white px-3 py-2 text-t6 text-grey-900 focus:border-blue-500 focus:outline-none focus:ring-2 focus:ring-blue-100 disabled:bg-grey-100 disabled:text-grey-400"
          >
            {PRESET_IDS.map((id) => (
              <option key={id} value={id}>
                {RULE_PRESETS[id].label}
              </option>
            ))}
          </select>
        </label>
        <div className="flex items-center gap-2">
          <Button
            size="sm"
            variant="primary"
            disabled={busy}
            onClick={() => void apply('fill')}
            title="과제에 없는 규칙만 추가합니다. 이미 있는 규칙은 그대로 둡니다"
          >
            {applying === 'fill' ? '채우는 중…' : '채우기'}
          </Button>
          <Button
            size="sm"
            disabled={busy}
            aria-expanded={confirmingOverwrite}
            onClick={() => setConfirmingOverwrite((v) => !v)}
            title="프리셋에 있는 규칙의 값을 프리셋 값으로 되돌립니다"
          >
            덮어쓰기
          </Button>
        </div>
      </div>

      <p className="mt-2 text-t7 text-grey-500">{preset.description}</p>
      <p className="mt-1 text-t7 text-grey-500">
        규칙 {preset.rules.length}건 · 안내 {preset.advisories.length}건. 적용 뒤에는 과제의 행만
        진실입니다 — 프리셋이 개정돼도 행은 움직이지 않습니다.
      </p>

      {confirmingOverwrite && (
        // 2단계 확인 (§9): 되돌아가는 것과 남는 것을 같은 문장에 적는다
        <div
          role="alertdialog"
          aria-label="덮어쓰기 확인"
          className="mt-3 rounded-lg border border-orange-200 bg-orange-50 p-3 text-t7 text-orange-800"
        >
          <p className="font-semibold">
            &ldquo;{preset.label}&rdquo; 프리셋으로 정말 덮어쓸까요?
          </p>
          <p className="mt-1">
            사용자가 고친 값이 프리셋 값으로 되돌아갑니다. 프리셋에 없는 규칙과 메모는 유지됩니다.
          </p>
          <div className="mt-2 flex gap-2">
            <Button size="sm" variant="danger" disabled={busy} onClick={() => void apply('overwrite')}>
              {applying === 'overwrite' ? '덮어쓰는 중…' : '덮어쓰기'}
            </Button>
            <Button size="sm" variant="ghost" disabled={busy} onClick={() => setConfirmingOverwrite(false)}>
              취소
            </Button>
          </div>
        </div>
      )}

      {notice && (
        <p role="status" className="mt-3 text-t7 font-semibold text-green-600">
          &ldquo;{notice.presetLabel}&rdquo; {MODE_LABELS[notice.mode]} 완료 — 추가{' '}
          {notice.result.added} · 갱신 {notice.result.updated} · 유지 {notice.result.kept}
        </p>
      )}

      {failure && (
        <ErrorBanner
          className="mt-3"
          message={failure.message}
          code={failure.code}
          onDismiss={() => setFailure(null)}
        />
      )}
    </section>
  );
}
