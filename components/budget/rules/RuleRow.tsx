'use client';

// 규칙 표의 한 행 (SOT §7.9.5, §5.18, §8.4 O-3)
// 상태는 갖지 않는다 — draft·baseline·오류·충돌 모두 부모(RulesEditor)가 들고 이 행은 그린다.
// 텍스트 칸은 포커스 아웃/Enter에 저장(onCommit), 체크박스·셀렉트는 바꾸는 즉시 저장한다.
// Enter는 blur로만 바꾼다 — 저장 경로를 onBlur 하나로 두어 두 번 저장되는 일을 막는다.
// 값을 쓰지 않는 코드(needsValue=false)는 값 칸을 비활성 "—"로 둔다(RL-D2). 분모는 indirect_max만(RL-D3).

import type { KeyboardEvent } from 'react';
import type { BudgetRule, IndirectBase, RuleSeverity } from '@/types';
import { INDIRECT_BASE_LABELS } from '@/lib/constants';
import { RULE_SPECS } from '@/lib/rules';
import Badge, { type BadgeTone } from '@/components/ui/Badge';
import Button from '@/components/ui/Button';
import {
  INDIRECT_BASE_ORDER,
  RULE_DRAFT_FIELDS,
  SEVERITY_LABELS,
  SEVERITY_ORDER,
  diffRuleDraft,
  displayDraftValue,
  parseValueText,
  toRuleDraft,
  unresolvedRuleConflicts,
  type GovShareOption,
  type RuleDraft,
  type RuleDraftKey,
} from './rule-form';

export interface RuleRowState {
  /** 마지막으로 받아들인 서버 값. 저장의 expectedVersion도 여기서만 나온다 */
  baseline: BudgetRule;
  draft: RuleDraft;
  /** VALIDATION 등 행 옆에 붙는 문구 */
  error: string | null;
  saving: boolean;
  /** O-3: 다시 불러온 뒤 비교 중. keptKeys = 사용자가 [내 입력 유지]를 고른 필드 */
  reloaded: { keptKeys: ReadonlySet<RuleDraftKey> } | null;
  /** gov_share_max 전용 — 후보 대신 "직접 입력"을 고른 상태 */
  customValue: boolean;
  confirmingDelete: boolean;
}

export interface RuleRowProps {
  row: RuleRowState;
  govShareOptions: readonly GovShareOption[];
  /** commit=true면 draft 반영 직후 저장까지 한다(체크박스·셀렉트) */
  onDraftChange: (patch: Partial<RuleDraft>, commit?: boolean) => void;
  onCommit: () => void;
  onCustomValueToggle: (custom: boolean) => void;
  onAdoptLatest: (key: RuleDraftKey) => void;
  onKeepMine: (key: RuleDraftKey) => void;
  onDeleteRequest: () => void;
  onDeleteConfirm: () => void;
  onDeleteCancel: () => void;
}

export const RULE_TABLE_COLUMNS = 8;

const SEVERITY_TONES: Record<RuleSeverity, BadgeTone> = {
  error: 'red',
  warn: 'amber', // Badge의 'amber' 키가 부록 E orange 클래스다
  info: 'blue',
};

const INPUT_CLASS =
  'w-full rounded-md border border-grey-300 bg-white px-2 py-1 text-t7 text-grey-900 focus:border-blue-500 focus:outline-none focus:ring-2 focus:ring-blue-100 disabled:bg-grey-100 disabled:text-grey-400';

const CUSTOM_OPTION = '__custom__';

function blurOnEnter(e: KeyboardEvent<HTMLInputElement>): void {
  if (e.key === 'Enter') e.currentTarget.blur();
}

export default function RuleRow({
  row,
  govShareOptions,
  onDraftChange,
  onCommit,
  onCustomValueToggle,
  onAdoptLatest,
  onKeepMine,
  onDeleteRequest,
  onDeleteConfirm,
  onDeleteCancel,
}: RuleRowProps) {
  const { baseline, draft } = row;
  const spec = RULE_SPECS[baseline.code];
  const unit = spec.valueUnit;
  const latest = toRuleDraft(baseline);
  const diffKeys = row.reloaded ? diffRuleDraft(draft, latest, unit) : [];
  const unresolved = row.reloaded ? unresolvedRuleConflicts(diffKeys, row.reloaded.keptKeys) : [];
  const disabled = row.saving;

  // gov_share_max: draft 값이 후보 중 하나면 셀렉트가 그것을 가리키고, 아니면 "직접 입력"
  const parsedValue = parseValueText(draft.valueText, unit);
  const matchedOption =
    parsedValue.ok && parsedValue.value !== null
      ? govShareOptions.find((o) => o.value === parsedValue.value)
      : undefined;
  const govSelectValue = row.customValue || !matchedOption ? CUSTOM_OPTION : String(matchedOption.value);

  const renderValueCell = () => {
    if (!spec.needsValue) {
      return (
        <span className="block text-center text-grey-400" title="이 규칙은 값을 쓰지 않습니다">
          —
        </span>
      );
    }
    const unitLabel = unit === 'percent' ? '%' : '원';
    const input = (
      <div className="flex items-center gap-1">
        <input
          type="text"
          inputMode={unit === 'percent' ? 'decimal' : 'numeric'}
          value={draft.valueText}
          disabled={disabled}
          aria-label={`${spec.label} 값`}
          placeholder={unit === 'percent' ? '0~100' : '원 단위 정수'}
          onChange={(e) => onDraftChange({ valueText: e.target.value })}
          onBlur={onCommit}
          onKeyDown={blurOnEnter}
          className={`${INPUT_CLASS} text-right`}
        />
        <span className="shrink-0 text-grey-500">{unitLabel}</span>
      </div>
    );
    if (baseline.code !== 'gov_share_max' || govShareOptions.length === 0) return input;
    return (
      <div className="space-y-1">
        <select
          value={govSelectValue}
          disabled={disabled}
          aria-label={`${spec.label} 후보`}
          onChange={(e) => {
            if (e.target.value === CUSTOM_OPTION) {
              onCustomValueToggle(true);
              return;
            }
            onCustomValueToggle(false);
            onDraftChange({ valueText: e.target.value }, true);
          }}
          className={INPUT_CLASS}
        >
          {govShareOptions.map((o) => (
            <option key={o.value} value={String(o.value)}>
              {o.label} ({o.value}%)
            </option>
          ))}
          <option value={CUSTOM_OPTION}>직접 입력</option>
        </select>
        {govSelectValue === CUSTOM_OPTION && input}
      </div>
    );
  };

  return (
    <>
      <tr className={row.error ? 'bg-red-50/40' : undefined}>
        <td className="px-3 py-2 align-top">
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="font-medium text-grey-900">{spec.label}</span>
            {spec.approximate && (
              <Badge tone="amber" title="세목 근사로 판정합니다 (§6.14)">
                근사
              </Badge>
            )}
          </div>
          <p className="mt-0.5 font-mono text-[11px] text-grey-400">
            {baseline.code} · {spec.ruleRef}
          </p>
        </td>
        <td className="px-3 py-2 text-center align-top">
          <input
            type="checkbox"
            checked={draft.enabled}
            disabled={disabled}
            aria-label={`${spec.label} 켜짐`}
            title="끄면 이 검사를 하지 않습니다 — 0과 다릅니다 (PL-14)"
            onChange={(e) => onDraftChange({ enabled: e.target.checked }, true)}
            className="mt-1 h-4 w-4 rounded border-grey-300"
          />
        </td>
        <td className="w-40 px-3 py-2 align-top">{renderValueCell()}</td>
        <td className="w-56 px-3 py-2 align-top">
          {baseline.code === 'indirect_max' ? (
            <select
              value={draft.base ?? ''}
              disabled={disabled}
              aria-label="간접비 분모"
              onChange={(e) => onDraftChange({ base: e.target.value as IndirectBase }, true)}
              className={INPUT_CLASS}
            >
              {INDIRECT_BASE_ORDER.map((base) => (
                <option key={base} value={base}>
                  {INDIRECT_BASE_LABELS[base]}
                </option>
              ))}
            </select>
          ) : (
            <span className="block text-center text-grey-400">—</span>
          )}
        </td>
        <td className="w-32 px-3 py-2 align-top">
          <div className="flex items-center gap-1.5">
            <Badge tone={SEVERITY_TONES[draft.severity]}>{SEVERITY_LABELS[draft.severity]}</Badge>
            <select
              value={draft.severity}
              disabled={disabled}
              aria-label={`${spec.label} 심각도`}
              onChange={(e) => onDraftChange({ severity: e.target.value as RuleSeverity }, true)}
              className={INPUT_CLASS}
            >
              {SEVERITY_ORDER.map((s) => (
                <option key={s} value={s}>
                  {SEVERITY_LABELS[s]}
                </option>
              ))}
            </select>
          </div>
        </td>
        <td className="min-w-48 px-3 py-2 align-top">
          <input
            type="text"
            value={draft.source}
            disabled={disabled}
            required
            aria-label={`${spec.label} 출처`}
            placeholder="고시 조문 또는 공고명 (필수)"
            title={draft.source}
            onChange={(e) => onDraftChange({ source: e.target.value })}
            onBlur={onCommit}
            onKeyDown={blurOnEnter}
            className={INPUT_CLASS}
          />
        </td>
        <td className="min-w-40 px-3 py-2 align-top">
          <input
            type="text"
            value={draft.note}
            disabled={disabled}
            aria-label={`${spec.label} 메모`}
            placeholder="공고에서 달리 정한 사유 등"
            title={draft.note}
            onChange={(e) => onDraftChange({ note: e.target.value })}
            onBlur={onCommit}
            onKeyDown={blurOnEnter}
            className={INPUT_CLASS}
          />
        </td>
        <td className="w-20 px-2 py-2 text-right align-top">
          {row.saving ? (
            <span className="text-grey-400">저장 중…</span>
          ) : (
            <Button
              size="sm"
              variant="ghost"
              className="text-red-600 hover:bg-red-50"
              disabled={row.confirmingDelete}
              onClick={onDeleteRequest}
              aria-label={`${spec.label} 삭제`}
            >
              삭제
            </Button>
          )}
        </td>
      </tr>

      {(row.error || row.confirmingDelete || row.reloaded) && (
        <tr>
          <td colSpan={RULE_TABLE_COLUMNS} className="px-3 pb-2">
            {row.error && (
              <p role="alert" className="text-t7 font-medium text-red-600">
                {row.error}
              </p>
            )}

            {row.confirmingDelete && (
              // §7.9.5: 지우면 그 검사가 사라진다는 것을 확인 문구에 적는다
              <div
                role="alertdialog"
                aria-label="규칙 삭제 확인"
                className="mt-1 flex flex-wrap items-center gap-2 rounded-lg border border-red-100 bg-red-50 px-3 py-2 text-t7 text-red-700"
              >
                <span className="font-semibold">이 규칙을 지우면 이 검사가 사라집니다.</span>
                <span>다시 검사하려면 규칙을 새로 추가해야 합니다.</span>
                <Button size="sm" variant="danger" onClick={onDeleteConfirm} disabled={row.saving}>
                  지우기
                </Button>
                <Button size="sm" variant="ghost" onClick={onDeleteCancel} disabled={row.saving}>
                  취소
                </Button>
              </div>
            )}

            {row.reloaded && (
              // O-3 비교 UI: 최신 값과 내 입력을 나란히 두고 항목마다 사용자가 고른다
              <div
                role="status"
                className="mt-1 rounded-lg border border-orange-200 bg-orange-50 p-3 text-t7 text-orange-800"
              >
                <p className="font-semibold">최신 내용을 다시 불러왔습니다.</p>
                {diffKeys.length === 0 ? (
                  <div className="mt-1 flex items-center gap-2">
                    <span>내 입력과 다른 항목이 없습니다.</span>
                    <Button size="sm" variant="ghost" onClick={onCommit}>
                      확인
                    </Button>
                  </div>
                ) : (
                  <>
                    <p className="mt-1">
                      아래 항목이 서로 다릅니다. 내 입력은 그대로 두었습니다 — 항목마다 최신 값을
                      쓸지 내 입력을 유지할지 고르세요. 고르기 전에는 저장할 수 없습니다.
                    </p>
                    <ul className="mt-2 space-y-1.5">
                      {RULE_DRAFT_FIELDS.filter((f) => diffKeys.includes(f.key)).map((field) => {
                        const kept = row.reloaded?.keptKeys.has(field.key) ?? false;
                        return (
                          <li key={field.key} className="rounded-lg bg-white/70 px-2.5 py-1.5">
                            <div className="flex flex-wrap items-center gap-2">
                              <span className="font-semibold text-grey-700">{field.label}</span>
                              <span className="text-grey-500">
                                내 입력: {displayDraftValue(field.key, draft, unit)}
                              </span>
                              <span className="text-grey-500">
                                최신: {displayDraftValue(field.key, latest, unit)}
                              </span>
                            </div>
                            <div className="mt-1 flex flex-wrap items-center gap-2">
                              <button
                                type="button"
                                onClick={() => onAdoptLatest(field.key)}
                                className="rounded-md border border-orange-300 px-2 py-0.5 font-semibold text-orange-800"
                              >
                                최신 값 사용
                              </button>
                              <button
                                type="button"
                                onClick={() => onKeepMine(field.key)}
                                className={`rounded-md border px-2 py-0.5 font-semibold ${
                                  kept
                                    ? 'border-orange-800 bg-orange-800 text-white'
                                    : 'border-orange-300 text-orange-800'
                                }`}
                              >
                                {kept ? '내 입력 유지 ✓' : '내 입력 유지'}
                              </button>
                            </div>
                          </li>
                        );
                      })}
                    </ul>
                    <div className="mt-2">
                      <Button
                        size="sm"
                        variant="primary"
                        disabled={unresolved.length > 0 || row.saving}
                        onClick={onCommit}
                        title={
                          unresolved.length > 0
                            ? `확인하지 않은 충돌 항목이 ${unresolved.length}건 있습니다`
                            : undefined
                        }
                      >
                        저장
                      </Button>
                    </div>
                  </>
                )}
              </div>
            )}
          </td>
        </tr>
      )}
    </>
  );
}
