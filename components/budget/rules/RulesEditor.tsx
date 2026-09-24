'use client';

// 연구비 규칙 편집 패널 (SOT §7.9.5, §5.18 RL-D2~D5, §8.4 O-1~O-3, §9 Budget Rules)
// 제안 모드 툴바 [연구비 규칙]이 여는 모달. BudgetScreen이 open·onClose·onChanged로 연결한다.
// `rules`는 초기값이다 — 열릴 때 그대로 받아들이고, 그 뒤에는 액션 결과로 자기 상태를 갱신한다.
// 저장·적용·삭제가 끝나면 onChanged()를 올려 부모가 router.refresh()로 검증 패널을 다시 읽게 한다.
//
// 동시성: 행 편집은 baseline.version을 expectedVersion으로 보낸다(O-1). STALE이면 ConflictDialog →
// [다시 불러오기]는 listBudgetRules로 최신 행을 받아 **입력값은 두고** 행 안에 비교 UI를 연다(O-3).
// budget_rules는 Realtime 구독표에 없으므로(§9) 다른 PC의 변경은 이 경로나 새로고침으로만 온다.
// 부모가 새 `rules`를 내려주면 version이 오른 행만 받아들이고, 입력 중인 행은 비교로 넘긴다.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { BudgetRule, IndirectBase, RuleCode, RuleSeverity } from '@/types';
import type { ActionErrorCode } from '@/lib/db/errors';
import { INDIRECT_BASE_LABELS } from '@/lib/constants';
import { DEFAULT_INDIRECT_BASE, RULE_SPECS } from '@/lib/rules';
import { PRESET_IDS, type PresetId } from '@/lib/rules-presets';
import { deleteBudgetRule, listBudgetRules, upsertBudgetRule } from '@/actions/budget-rules';
import Button from '@/components/ui/Button';
import ConflictDialog from '@/components/ui/ConflictDialog';
import ErrorBanner from '@/components/ui/ErrorBanner';
import Modal from '@/components/ui/Modal';
import AdvisoryList from './AdvisoryList';
import PresetPicker from './PresetPicker';
import RuleRow, { RULE_TABLE_COLUMNS, type RuleRowState } from './RuleRow';
import {
  INDIRECT_BASE_ORDER,
  SEVERITY_LABELS,
  SEVERITY_ORDER,
  buildRulePatch,
  diffRuleDraft,
  govShareOptions,
  missingRuleCodes,
  parseValueText,
  sortRulesByCode,
  toRuleDraft,
  type RuleDraft,
  type RuleDraftKey,
} from './rule-form';

export interface RulesEditorProps {
  projectId: string;
  rules: BudgetRule[];
  open: boolean;
  onClose: () => void;
  /** 저장·적용·삭제 뒤. 부모가 router.refresh()로 규칙 검증 패널을 다시 읽는다 */
  onChanged: () => void;
}

type Tab = 'rules' | 'advisories';
type Rows = Partial<Record<RuleCode, RuleRowState>>;

interface AddForm {
  code: RuleCode | '';
  valueText: string;
  base: IndirectBase;
  severity: RuleSeverity;
  source: string;
}

const EMPTY_ADD_FORM: AddForm = {
  code: '',
  valueText: '',
  base: DEFAULT_INDIRECT_BASE,
  severity: 'warn',
  source: '',
};

const NO_CODES: ReadonlySet<RuleCode> = new Set();

const INPUT_CLASS =
  'w-full rounded-md border border-grey-300 bg-white px-2 py-1.5 text-t7 text-grey-900 focus:border-blue-500 focus:outline-none focus:ring-2 focus:ring-blue-100 disabled:bg-grey-100 disabled:text-grey-400';

const GOV_SHARE_OPTIONS = govShareOptions();

function freshRow(rule: BudgetRule): RuleRowState {
  return {
    baseline: rule,
    draft: toRuleDraft(rule),
    error: null,
    saving: false,
    reloaded: null,
    // 후보(75/67)에 없는 값이면 처음부터 "직접 입력"으로 보인다
    customValue:
      rule.code === 'gov_share_max' &&
      rule.value !== null &&
      !GOV_SHARE_OPTIONS.some((o) => o.value === rule.value),
    confirmingDelete: false,
  };
}

function rowsFrom(rules: readonly BudgetRule[]): Rows {
  const rows: Rows = {};
  for (const rule of rules) rows[rule.code] = freshRow(rule);
  return rows;
}

function isDirty(row: RuleRowState): boolean {
  return (
    diffRuleDraft(row.draft, toRuleDraft(row.baseline), RULE_SPECS[row.baseline.code].valueUnit)
      .length > 0
  );
}

/**
 * 최신 행을 받아들인다. version이 오르지 않은 행은 건드리지 않는다(forceCompare 제외).
 * 입력 중인 행(draft ≠ baseline)은 draft를 그대로 두고 비교 UI를 연다 — 작업 내용을 날리지 않는다(O-3).
 */
function mergeLatest(prev: Rows, latest: readonly BudgetRule[], forceCompare: ReadonlySet<RuleCode>): Rows {
  const next: Rows = { ...prev };
  let changed = false;
  for (const rule of latest) {
    const existing = prev[rule.code];
    if (!existing) {
      next[rule.code] = freshRow(rule);
      changed = true;
      continue;
    }
    if (existing.baseline.version >= rule.version && !forceCompare.has(rule.code)) continue;
    changed = true;
    if (!isDirty(existing)) {
      next[rule.code] = { ...freshRow(rule), confirmingDelete: existing.confirmingDelete };
      continue;
    }
    const unit = RULE_SPECS[rule.code].valueUnit;
    const stillDiffers = diffRuleDraft(existing.draft, toRuleDraft(rule), unit).length > 0;
    next[rule.code] = {
      ...existing,
      baseline: rule,
      error: null,
      draft: stillDiffers ? existing.draft : toRuleDraft(rule),
      reloaded: stillDiffers ? { keptKeys: new Set<RuleDraftKey>() } : null,
    };
  }
  // 같은 참조를 돌려주면 부모가 같은 내용의 rules를 다시 내려줘도 다시 그리지 않는다
  return changed ? next : prev;
}

export default function RulesEditor({ projectId, rules, open, onClose, onChanged }: RulesEditorProps) {
  const [rows, setRows] = useState<Rows>(() => rowsFrom(rules));
  // 비동기 저장 뒤에는 렌더 클로저의 rows가 낡아 있다 — 액션이 돌아온 뒤에는 이 ref로 읽는다
  const rowsRef = useRef(rows);
  rowsRef.current = rows;
  const [tab, setTab] = useState<Tab>('rules');
  // 부록 D.1 msit_profit이 첫 항목 — 부처 고유 요령이 없는 과제의 출발점이라 기본 선택으로 맞다
  const [presetId, setPresetId] = useState<PresetId>(() => PRESET_IDS[0] ?? 'msit_profit');
  const [conflict, setConflict] = useState<{ code: RuleCode; message: string } | null>(null);
  const [reloading, setReloading] = useState(false);
  const [failure, setFailure] = useState<{ message: string; code?: ActionErrorCode } | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [addForm, setAddForm] = useState<AddForm>(EMPTY_ADD_FORM);
  const [addError, setAddError] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);

  // 열릴 때는 부모가 준 rules를 그대로 받아들인다. 닫혀 있는 동안의 입력 상태는 의미가 없다
  const rulesProp = useRef(rules);
  rulesProp.current = rules;
  useEffect(() => {
    if (!open) return;
    setRows(rowsFrom(rulesProp.current));
    setTab('rules');
    setConflict(null);
    setFailure(null);
    setNotice(null);
    setAddForm(EMPTY_ADD_FORM);
    setAddError(null);
  }, [open]);

  // 열려 있는 동안 부모가 새 rules를 내려주면(onChanged → refresh) version이 오른 행만 받는다
  useEffect(() => {
    if (!open) return;
    setRows((prev) => mergeLatest(prev, rules, NO_CODES));
  }, [rules, open]);

  const sortedRows = useMemo(
    () => sortRulesByCode(Object.values(rows).map((row) => ({ code: row.baseline.code, row }))),
    [rows]
  );
  const missingCodes = useMemo(
    () => missingRuleCodes(sortedRows.map((r) => ({ code: r.code }))),
    [sortedRows]
  );
  const enabledCount = sortedRows.filter((r) => r.row.draft.enabled).length;

  const patchRow = (code: RuleCode, patch: Partial<RuleRowState> | ((row: RuleRowState) => RuleRowState)): void => {
    setRows((prev) => {
      const row = prev[code];
      if (!row) return prev;
      return { ...prev, [code]: typeof patch === 'function' ? patch(row) : { ...row, ...patch } };
    });
  };

  // ConflictDialog가 떠 있는 동안 Esc가 바깥 모달까지 닫으면 입력이 사라진다 — 안쪽만 닫는다
  const handleClose = useCallback((): void => {
    if (conflict) return;
    onClose();
  }, [conflict, onClose]);

  /**
   * 한 행 저장. draftOverride는 체크박스·셀렉트처럼 "바꾸고 바로 저장"할 때 setState 반영 전의
   * 값을 넘기기 위한 것이다. 빈 patch(바뀐 것 없음)는 액션을 부르지 않고 오류·비교 상태만 정리한다.
   */
  const commitRow = async (
    code: RuleCode,
    draftOverride?: RuleDraft,
    baselineOverride?: BudgetRule
  ): Promise<void> => {
    const row = rowsRef.current[code];
    if (!row) return;
    // baselineOverride는 방금 끝난 저장의 이어 저장 — 그 저장의 saving=false가 아직 렌더되지 않았을 수 있다
    if (row.saving && !baselineOverride) return;
    const draft = draftOverride ?? row.draft;
    const baseline = baselineOverride ?? row.baseline;
    const unit = RULE_SPECS[code].valueUnit;

    if (row.reloaded) {
      const diffKeys = diffRuleDraft(draft, toRuleDraft(baseline), unit);
      const unresolved = diffKeys.filter((key) => !row.reloaded!.keptKeys.has(key));
      if (unresolved.length > 0) {
        patchRow(code, {
          error: '최신 내용과 다른 항목이 남아 있습니다. 항목마다 [최신 값 사용] 또는 [내 입력 유지]를 고른 뒤 저장하세요.',
        });
        return;
      }
    }

    const built = buildRulePatch(draft, baseline);
    if (!built.ok) {
      patchRow(code, { error: built.message });
      return;
    }
    if (Object.keys(built.patch).length === 0) {
      patchRow(code, { error: null, reloaded: null });
      return;
    }

    patchRow(code, { saving: true, error: null });
    // O-1: 값·심각도·출처를 한 행에서 바꾸므로 baseline의 version을 조건으로 건다
    const res = await upsertBudgetRule(projectId, code, built.patch, baseline.version);
    if (!res.ok) {
      if (res.code === 'STALE') {
        // 입력값은 그대로 두고 선택지를 준다 (O-3)
        patchRow(code, { saving: false });
        setConflict({ code, message: res.error });
        return;
      }
      patchRow(code, { saving: false, error: res.error });
      return;
    }
    // 내 저장이 새 기준이 된다. draft는 두어도 된다 — 서버 값과 같은 내용이라 diff가 비고,
    // 저장 중에 이어 친 글자가 있으면 그것만 다음 저장의 patch가 된다
    patchRow(code, (r) => ({ ...r, saving: false, baseline: res.data, error: null, reloaded: null }));
    onChanged();

    // 저장이 도는 동안 같은 행을 더 고쳤으면(체크박스 등) 그 변경은 아직 서버에 없다 — 이어서 저장한다
    // (그 사이의 편집은 이벤트 핸들러에서 동기 렌더됐으므로 ref가 최신이다)
    const after = rowsRef.current[code];
    if (after && diffRuleDraft(after.draft, toRuleDraft(res.data), unit).length > 0) {
      void commitRow(code, after.draft, res.data);
    }
  };

  const changeDraft = (code: RuleCode, patch: Partial<RuleDraft>, commit = false): void => {
    const row = rowsRef.current[code];
    if (!row) return;
    const nextDraft = { ...row.draft, ...patch };
    patchRow(code, { draft: nextDraft });
    if (commit) void commitRow(code, nextDraft);
  };

  /** 최신 행을 다시 읽는다. compareCode는 STALE이 난 행 — version과 무관하게 비교로 넘긴다 */
  const reload = async (compareCode: RuleCode | null): Promise<void> => {
    setConflict(null);
    setFailure(null);
    setReloading(true);
    const res = await listBudgetRules(projectId);
    setReloading(false);
    if (!res.ok) {
      setFailure({ message: res.error, code: res.code });
      return;
    }
    const latestCodes = new Set(res.data.map((r) => r.code));
    const removed = (Object.keys(rowsRef.current) as RuleCode[]).filter((code) => !latestCodes.has(code));
    setRows((prev) => {
      const merged = mergeLatest(prev, res.data, compareCode ? new Set([compareCode]) : NO_CODES);
      for (const code of removed) delete merged[code];
      return merged;
    });
    if (removed.length > 0) {
      // 조용히 빼지 않는다 — 어느 규칙이 사라졌는지 알린다(절대 규칙 5)
      setNotice(
        `다른 곳에서 삭제된 규칙을 목록에서 뺐습니다: ${removed.map((c) => RULE_SPECS[c].label).join(', ')}`
      );
    }
  };

  const adoptLatest = (code: RuleCode, key: RuleDraftKey): void => {
    patchRow(code, (r) => {
      const latest = toRuleDraft(r.baseline);
      return { ...r, draft: { ...r.draft, [key]: latest[key] } };
    });
  };

  const keepMine = (code: RuleCode, key: RuleDraftKey): void => {
    patchRow(code, (r) => {
      if (!r.reloaded) return r;
      const keptKeys = new Set(r.reloaded.keptKeys);
      keptKeys.add(key);
      return { ...r, reloaded: { keptKeys } };
    });
  };

  const confirmDelete = async (code: RuleCode): Promise<void> => {
    const row = rowsRef.current[code];
    if (!row || row.saving) return;
    patchRow(code, { saving: true, error: null });
    const res = await deleteBudgetRule(projectId, code);
    if (!res.ok) {
      patchRow(code, { saving: false, confirmingDelete: false, error: res.error });
      return;
    }
    setRows((prev) => {
      const next = { ...prev };
      delete next[code];
      return next;
    });
    onChanged();
  };

  const submitAdd = async (): Promise<void> => {
    if (addForm.code === '') return;
    const code = addForm.code;
    const spec = RULE_SPECS[code];
    setAddError(null);

    const parsed = parseValueText(addForm.valueText, spec.valueUnit);
    if (!parsed.ok) {
      setAddError(parsed.message);
      return;
    }
    if (spec.needsValue && parsed.value === null) {
      setAddError('켜져 있는 규칙에는 기준값이 있어야 합니다. 값을 입력하세요.');
      return;
    }
    const source = addForm.source.trim();
    if (source === '') {
      setAddError('출처를 적으세요. "공고 2026-XX"처럼 이 값을 어디서 가져왔는지 남깁니다.');
      return;
    }

    setAdding(true);
    const res = await upsertBudgetRule(projectId, code, {
      enabled: true,
      value: spec.needsValue ? parsed.value : null,
      base: code === 'indirect_max' ? addForm.base : null,
      severity: addForm.severity,
      source,
      note: '',
    });
    setAdding(false);
    if (!res.ok) {
      setAddError(res.error);
      return;
    }
    setRows((prev) => ({ ...prev, [code]: freshRow(res.data) }));
    setAddForm(EMPTY_ADD_FORM);
    onChanged();
  };

  const addSpec = addForm.code === '' ? null : RULE_SPECS[addForm.code];
  const busy = reloading || adding;

  return (
    <Modal
      open={open}
      title="연구비 규칙"
      description="이 과제에 적용할 연구비 사용 규칙입니다. 값을 고치면 바로 저장되고, 검증 패널이 따라 바뀝니다. 행이 없거나 꺼진 규칙은 검사하지 않습니다."
      onClose={handleClose}
      closeOnBackdrop={false}
      size="xl"
      footer={
        <Button size="sm" onClick={handleClose}>
          닫기
        </Button>
      }
    >
      <div className="space-y-4">
        <PresetPicker
          projectId={projectId}
          presetId={presetId}
          onPresetChange={setPresetId}
          disabled={busy}
          onApplied={async () => {
            // 적용 결과에는 행이 없다 — 다시 읽어 표를 맞추고, 부모에게 검증 패널 갱신을 알린다
            await reload(null);
            onChanged();
          }}
        />

        <div className="inline-flex items-center gap-1" role="tablist" aria-label="연구비 규칙 탭">
          {(
            [
              { value: 'rules', label: `규칙 ${sortedRows.length}` },
              { value: 'advisories', label: '안내 목록' },
            ] as const
          ).map((item) => {
            const active = item.value === tab;
            return (
              <button
                key={item.value}
                type="button"
                role="tab"
                aria-selected={active}
                onClick={() => setTab(item.value)}
                className={`rounded-lg px-3 py-1.5 text-t7 font-semibold transition ${
                  active ? 'bg-grey-900 text-white' : 'text-grey-700 hover:bg-grey-100'
                }`}
              >
                {item.label}
              </button>
            );
          })}
        </div>

        {failure && (
          <ErrorBanner
            message={failure.message}
            code={failure.code}
            onRetry={() => void reload(null)}
            onDismiss={() => setFailure(null)}
          />
        )}
        {notice && (
          <p
            role="status"
            className="flex items-start justify-between gap-3 rounded-lg border border-orange-100 bg-orange-50 px-3 py-2 text-t7 text-orange-800"
          >
            <span>{notice}</span>
            <button type="button" onClick={() => setNotice(null)} aria-label="알림 닫기" className="font-bold">
              ×
            </button>
          </p>
        )}

        {tab === 'advisories' ? (
          // key: 프리셋이 바뀌면 체크가 초기화된다 — 다른 프리셋의 조항이므로
          <AdvisoryList key={presetId} presetId={presetId} />
        ) : (
          <section aria-label="규칙 표" className="space-y-3">
            <p className="text-t7 text-grey-500">
              켜짐 {enabledCount} / {sortedRows.length} · 텍스트 칸은 다른 곳을 누르거나 Enter로
              저장됩니다 · 출처는 비울 수 없습니다 (RL-D5)
            </p>

            <div className="overflow-x-auto rounded-xl border border-grey-200">
              <table className="w-full min-w-[1080px] text-t7">
                <thead className="bg-grey-50 text-left text-grey-600">
                  <tr>
                    <th className="px-3 py-2 font-semibold">규칙</th>
                    <th className="px-3 py-2 text-center font-semibold">켜짐</th>
                    <th className="px-3 py-2 font-semibold">값</th>
                    <th className="px-3 py-2 font-semibold">분모 (간접비만)</th>
                    <th className="px-3 py-2 font-semibold">심각도</th>
                    <th className="px-3 py-2 font-semibold">출처</th>
                    <th className="px-3 py-2 font-semibold">메모</th>
                    <th className="px-2 py-2" />
                  </tr>
                </thead>
                <tbody className="divide-y divide-grey-100">
                  {sortedRows.length === 0 ? (
                    <tr>
                      <td colSpan={RULE_TABLE_COLUMNS} className="px-3 py-8 text-center text-grey-500">
                        규칙이 없습니다 — 아무것도 검사하지 않습니다. 위에서 프리셋을 채우거나 아래에서
                        규칙을 추가하세요.
                      </td>
                    </tr>
                  ) : (
                    sortedRows.map(({ code, row }) => (
                      <RuleRow
                        key={code}
                        row={row}
                        govShareOptions={GOV_SHARE_OPTIONS}
                        onDraftChange={(patch, commit) => changeDraft(code, patch, commit)}
                        onCommit={() => void commitRow(code)}
                        onCustomValueToggle={(custom) => patchRow(code, { customValue: custom })}
                        onAdoptLatest={(key) => adoptLatest(code, key)}
                        onKeepMine={(key) => keepMine(code, key)}
                        onDeleteRequest={() => patchRow(code, { confirmingDelete: true, error: null })}
                        onDeleteConfirm={() => void confirmDelete(code)}
                        onDeleteCancel={() => patchRow(code, { confirmingDelete: false })}
                      />
                    ))
                  )}
                </tbody>
              </table>
            </div>

            {/* 규칙 추가 — 과제에 없는 코드만. 출처 필수(RL-D5) */}
            <form
              aria-label="규칙 추가"
              className="rounded-xl border border-dashed border-grey-300 p-3"
              onSubmit={(e) => {
                e.preventDefault();
                void submitAdd();
              }}
            >
              <p className="text-t7 font-semibold text-grey-700">규칙 추가</p>
              {missingCodes.length === 0 ? (
                <p className="mt-1 text-t7 text-grey-500">모든 규칙 코드가 이미 있습니다.</p>
              ) : (
                <div className="mt-2 flex flex-wrap items-end gap-2">
                  <label className="min-w-[260px] flex-1">
                    <span className="block text-t7 text-grey-500">규칙</span>
                    <select
                      value={addForm.code}
                      disabled={busy}
                      onChange={(e) => {
                        setAddError(null);
                        setAddForm((f) => ({ ...f, code: e.target.value as RuleCode | '', valueText: '' }));
                      }}
                      className={INPUT_CLASS}
                    >
                      <option value="">— 고르세요 —</option>
                      {missingCodes.map((code) => (
                        <option key={code} value={code}>
                          {RULE_SPECS[code].label}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label className="w-36">
                    <span className="block text-t7 text-grey-500">
                      값{addSpec?.valueUnit === 'percent' ? ' (%)' : addSpec?.valueUnit === 'won' ? ' (원)' : ''}
                    </span>
                    <input
                      type="text"
                      inputMode="decimal"
                      value={addSpec?.needsValue ? addForm.valueText : ''}
                      disabled={busy || !addSpec?.needsValue}
                      placeholder={addSpec?.needsValue ? '' : '—'}
                      onChange={(e) => setAddForm((f) => ({ ...f, valueText: e.target.value }))}
                      className={`${INPUT_CLASS} text-right`}
                    />
                  </label>
                  {addForm.code === 'indirect_max' && (
                    <label className="min-w-[240px]">
                      <span className="block text-t7 text-grey-500">분모</span>
                      <select
                        value={addForm.base}
                        disabled={busy}
                        onChange={(e) => setAddForm((f) => ({ ...f, base: e.target.value as IndirectBase }))}
                        className={INPUT_CLASS}
                      >
                        {INDIRECT_BASE_ORDER.map((base) => (
                          <option key={base} value={base}>
                            {INDIRECT_BASE_LABELS[base]}
                          </option>
                        ))}
                      </select>
                    </label>
                  )}
                  <label className="w-28">
                    <span className="block text-t7 text-grey-500">심각도</span>
                    <select
                      value={addForm.severity}
                      disabled={busy}
                      onChange={(e) => setAddForm((f) => ({ ...f, severity: e.target.value as RuleSeverity }))}
                      className={INPUT_CLASS}
                    >
                      {SEVERITY_ORDER.map((s) => (
                        <option key={s} value={s}>
                          {SEVERITY_LABELS[s]}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label className="min-w-[220px] flex-1">
                    <span className="block text-t7 text-grey-500">출처 (필수)</span>
                    <input
                      type="text"
                      value={addForm.source}
                      disabled={busy}
                      placeholder='예: "공고 2026-XX" 또는 고시 조문'
                      onChange={(e) => setAddForm((f) => ({ ...f, source: e.target.value }))}
                      className={INPUT_CLASS}
                    />
                  </label>
                  <Button
                    type="submit"
                    size="sm"
                    variant="primary"
                    disabled={busy || addForm.code === ''}
                  >
                    {adding ? '추가 중…' : '추가'}
                  </Button>
                </div>
              )}
              {addError && (
                <p role="alert" className="mt-2 text-t7 font-medium text-red-600">
                  {addError}
                </p>
              )}
            </form>
          </section>
        )}
      </div>

      {conflict && (
        <ConflictDialog
          message={conflict.message}
          onReload={() => void reload(conflict.code)}
          onKeepEditing={() => setConflict(null)}
        />
      )}
    </Modal>
  );
}
