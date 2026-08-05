'use client';

// Step 4 — 비목 매핑 (SOT §7.9.1)
//  - 원본 비목명 → 시스템 비목 대응표 (CategoryMapper)
//  - 하단: "이 매핑을 프로파일로 저장" 체크 + 프로파일명·부처 입력
//    수동 지정분은 I-7로 학습된다. **I-6 모호 별칭의 선택은 학습하지 않는다** —
//    학습 후보는 previewImport가 돌려준 learnedAliases를 그대로 쓴다(여기서 다시 계산하지 않는다).

import { useMemo, useState } from 'react';
import type { BudgetCategory, ImportProfile, PreviewImportResult } from '@/types';
import { MINISTRY_ALIAS_PRESETS } from '@/lib/constants';
import Button from '@/components/ui/Button';
import CategoryMapper from './CategoryMapper';
import type { MappingEntry } from './wizard-state';

const MINISTRY_PRESETS = Object.keys(MINISTRY_ALIAS_PRESETS);

export interface Step4CategoriesProps {
  entries: MappingEntry[];
  preview: PreviewImportResult | null;
  manualCategoryByRow: Record<number, BudgetCategory>;
  skippedRowIndexes: number[];
  ministry: string | null;
  busy: boolean;
  /** 사용자 결정이 미리보기에 아직 반영되지 않았는가 */
  dirty: boolean;
  /** Step 1에서 고른 프로파일 (있으면 갱신 대상) */
  selectedProfile: ImportProfile | null;
  saveProfile: boolean;
  profileName: string;
  onAssign: (rowIndex: number, category: BudgetCategory | null) => void;
  onToggleSkip: (rowIndex: number) => void;
  onMinistryChange: (ministry: string | null) => void;
  onRecheck: () => void;
  onSaveProfileChange: (save: boolean) => void;
  onProfileNameChange: (name: string) => void;
}

export default function Step4Categories({
  entries,
  preview,
  manualCategoryByRow,
  skippedRowIndexes,
  ministry,
  busy,
  dirty,
  selectedProfile,
  saveProfile,
  profileName,
  onAssign,
  onToggleSkip,
  onMinistryChange,
  onRecheck,
  onSaveProfileChange,
  onProfileNameChange,
}: Step4CategoriesProps) {
  const [onlyIssues, setOnlyIssues] = useState(true);
  const [showSkipped, setShowSkipped] = useState(false);

  const counts = useMemo(() => {
    const base = { exact: 0, alias: 0, manual: 0, fuzzy: 0, ambiguous: 0, unmapped: 0, skipped: 0 };
    for (const entry of entries) base[entry.status] += 1;
    return base;
  }, [entries]);

  const active = useMemo(() => entries.filter((e) => e.status !== 'skipped'), [entries]);
  const skippedEntries = useMemo(() => entries.filter((e) => e.status === 'skipped'), [entries]);
  const shown = onlyIssues ? active.filter((e) => e.needsDecision) : active;

  const learnedCount = Object.keys(preview?.learnedAliases ?? {}).length;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3 rounded-xl border border-slate-200 bg-slate-50 px-3 py-2 text-xs">
        <span>
          ✅ 완전일치 <strong>{counts.exact}</strong>
        </span>
        <span>
          🔵 별칭·지정 <strong>{counts.alias + counts.manual}</strong>
        </span>
        <span className="text-amber-700">
          ⚠️ 확인필요 <strong>{counts.fuzzy + counts.ambiguous}</strong>
        </span>
        <span className="text-red-700">
          ❌ 미매핑 <strong>{counts.unmapped}</strong>
        </span>
        <span className="text-slate-400">
          ⬜ 건너뜀 <strong>{counts.skipped}</strong>
        </span>

        <label className="ml-auto flex cursor-pointer items-center gap-1.5">
          <input
            type="checkbox"
            checked={onlyIssues}
            onChange={(e) => setOnlyIssues(e.target.checked)}
          />
          확인이 필요한 행만 보기
        </label>
      </div>

      {/* 부처 프리셋 — I-2 ② 별칭 조회 우선순위에 영향을 준다 */}
      <div className="flex flex-wrap items-center gap-2 text-xs text-slate-600">
        <label htmlFor="ministry-input" className="font-semibold text-slate-700">
          부처 (별칭 프리셋)
        </label>
        <input
          id="ministry-input"
          list="ministry-presets"
          value={ministry ?? ''}
          disabled={busy}
          placeholder="예: 산업통상자원부"
          onChange={(e) => onMinistryChange(e.target.value.trim() === '' ? null : e.target.value)}
          className="rounded-lg border border-slate-300 px-2 py-1"
        />
        <datalist id="ministry-presets">
          {MINISTRY_PRESETS.map((name) => (
            <option key={name} value={name} />
          ))}
        </datalist>
        <span className="text-slate-400">
          부처를 지정하면 해당 프리셋 별칭이 공통 사전보다 먼저 조회됩니다 (I-2).
        </span>
      </div>

      {dirty && (
        <div className="flex flex-wrap items-center gap-3 rounded-xl border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-900">
          <span>
            변경한 비목 지정·건너뛰기가 아직 미리보기에 반영되지 않았습니다. 반영 결과를 확인하세요.
          </span>
          <Button size="sm" variant="secondary" disabled={busy} onClick={onRecheck} className="ml-auto">
            변경 반영해 다시 확인
          </Button>
        </div>
      )}

      <CategoryMapper
        entries={shown}
        manualCategoryByRow={manualCategoryByRow}
        skippedRowIndexes={skippedRowIndexes}
        busy={busy}
        onAssign={onAssign}
        onToggleSkip={onToggleSkip}
      />

      {onlyIssues && shown.length === 0 && (
        <p className="rounded-xl border border-emerald-200 bg-emerald-50 px-3 py-2 text-xs text-emerald-800">
          확인이 필요한 행이 없습니다. 전체 대응표를 보려면 위 체크를 해제하세요.
        </p>
      )}

      {/* 건너뛴 행도 조용히 숨기지 않는다 — 스킵 패턴에 잘못 걸린 비목을 되살릴 수 있어야 한다 */}
      {skippedEntries.length > 0 && (
        <div>
          <button
            type="button"
            onClick={() => setShowSkipped((v) => !v)}
            className="text-xs font-semibold text-slate-600 underline"
          >
            건너뛴 행 {skippedEntries.length}건 {showSkipped ? '접기' : '보기'}
          </button>
          {showSkipped && (
            <div className="mt-2">
              <p className="mb-1 text-[11px] text-slate-500">
                집계·메모 행은 자동으로 건너뜁니다 (I-5). 실제 비목인데 걸린 행이 있으면 비목을
                지정해 되살릴 수 있습니다.
              </p>
              <CategoryMapper
                entries={skippedEntries}
                manualCategoryByRow={manualCategoryByRow}
                skippedRowIndexes={skippedRowIndexes}
                busy={busy}
                onAssign={onAssign}
                onToggleSkip={onToggleSkip}
              />
            </div>
          )}
        </div>
      )}

      {/* 하단: 프로파일 저장 (§7.9.1 Step 4) */}
      <section className="space-y-2 rounded-xl border border-slate-200 p-3">
        <label className="flex cursor-pointer items-center gap-2 text-sm font-semibold text-slate-700">
          <input
            type="checkbox"
            checked={saveProfile}
            disabled={busy}
            onChange={(e) => onSaveProfileChange(e.target.checked)}
          />
          {selectedProfile
            ? `이 매핑을 프로파일 "${selectedProfile.name}"에 저장(갱신)`
            : '이 매핑을 프로파일로 저장'}
        </label>
        <p className="text-xs text-slate-500">
          시트·범위·라벨 열·연차 열·금액 단위와 <strong>수동 지정한 비목 별칭 {learnedCount}건</strong>이
          저장됩니다 (I-7). 구 비목 체계(`연구장비·재료비`류)의 선택은 서식마다 달라서 학습하지
          않습니다 (I-6).
        </p>
        {saveProfile && !selectedProfile && (
          <label className="flex items-center gap-2 text-xs text-slate-600">
            프로파일 이름
            <input
              value={profileName}
              disabled={busy}
              maxLength={100}
              placeholder="예: 산자부 사업비 총괄표"
              onChange={(e) => onProfileNameChange(e.target.value)}
              className="flex-1 rounded-lg border border-slate-300 px-2 py-1"
            />
          </label>
        )}
      </section>
    </div>
  );
}
