'use client';

// 엑셀 가져오기 마법사 — 모달 + 5단계 상태 기계 (SOT §7.9.1, §6.8, §5.12.2)
//
// 설계 원칙 (§7.9.1):
//  - 어느 단계에서든 뒤로 갈 수 있고, 마지막 반영 전까지 저장되는 것은 없다
//  - 모달을 닫으면 진행 상태는 폐기한다 (중간 저장 없음 — 부모가 언마운트한다)
//  - 큰 파일은 파싱 중 로딩 인디케이터를 띄운다
//  - 실패는 반드시 화면에 남긴다 (ErrorBanner, 절대 규칙 5)
//
// 이 컴포넌트는 supabase를 직접 부르지 않는다. 파싱·판정은 전부 actions/import.ts가 하고
// (I-13: SheetJS는 서버 전용) 여기서는 사용자의 결정을 ImportDraft 한 값에 모아 넘길 뿐이다.
//
// 반영 가능 판정은 서버가 준 `blocked` / `unmappedYearOrders`를 그대로 쓴다 — UI가 다시 계산하면
// 규칙이 두 곳에 생겨 반드시 어긋난다.

import { useEffect, useMemo, useRef, useState } from 'react';
import type {
  ActionResult,
  AmountUnit,
  AnalyzeSheetHints,
  AnalyzeSheetResult,
  BudgetCategory,
  ImportDraft,
  ImportProfile,
  InspectWorkbookResult,
  PreviewImportResult,
  Settings,
  Year,
} from '@/types';
import {
  analyzeSheet,
  commitImport,
  createImportProfile,
  inspectWorkbook,
  previewImport,
  updateImportProfile,
} from '@/actions/import';
import { columnLetterToIndex } from '@/lib/import/normalize';
import Button from '@/components/ui/Button';
import ErrorBanner from '@/components/ui/ErrorBanner';
import Modal from '@/components/ui/Modal';
import { setRealtimePaused } from '@/components/RealtimeRefresher';
import Step1File from './Step1File';
import Step2Sheet from './Step2Sheet';
import Step3Columns, { EXCLUDE_VALUE } from './Step3Columns';
import Step4Categories from './Step4Categories';
import Step5Preview from './Step5Preview';
import type { PickTarget } from './SheetGrid';
import {
  STEP_TITLES,
  autoYearMapping,
  buildFormData,
  categoryIssueOf,
  draftFromProfile,
  initialDraft,
  labelFromGrid,
  toWizardYears,
  type Failure,
  type MappingEntry,
  type MappingStatus,
  type WizardStep,
} from './wizard-state';

export interface ImportWizardProps {
  projectId: string;
  years: Year[];
  currencyUnit: Settings['currencyUnit'];
  profiles: ImportProfile[];
  /** 프로파일 조회 실패 문구. 빈 목록으로 눙치지 않는다 (절대 규칙 5) */
  profilesError: string | null;
  onClose: () => void;
  /** 반영 성공 — 부모가 토스트를 띄우고 router.refresh()를 부른다 */
  onCommitted: (message: string) => void;
}

export default function ImportWizard({
  projectId,
  years,
  currencyUnit,
  profiles,
  profilesError,
  onClose,
  onCommitted,
}: ImportWizardProps) {
  const wizardYears = useMemo(() => toWizardYears(years), [years]);
  const yearNameById = useMemo(() => {
    const map: Record<string, string> = {};
    for (const year of wizardYears) map[year.id] = `${year.order + 1}차년도 · ${year.name}`;
    return map;
  }, [wizardYears]);

  const [step, setStep] = useState<WizardStep>(1);
  const [file, setFile] = useState<File | null>(null);
  const [inspect, setInspect] = useState<InspectWorkbookResult | null>(null);
  const [analysis, setAnalysis] = useState<AnalyzeSheetResult | null>(null);
  const [draft, setDraft] = useState<ImportDraft>(() => initialDraft(projectId));
  const [preview, setPreview] = useState<PreviewImportResult | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [failure, setFailure] = useState<Failure | null>(null);

  const [selectedProfileId, setSelectedProfileId] = useState<string | null>(null);
  const [pickTarget, setPickTarget] = useState<PickTarget>('header');
  const [unitConfirmed, setUnitConfirmed] = useState(false);
  const [labelColumnsTouched, setLabelColumnsTouched] = useState(false);
  const [touchedYearColumns, setTouchedYearColumns] = useState<string[]>([]);
  const [excludedYearColumns, setExcludedYearColumns] = useState<string[]>([]);
  const [labelByRow, setLabelByRow] = useState<Record<number, string>>({});
  const [dirty, setDirty] = useState(false);
  const [saveProfile, setSaveProfile] = useState(false);
  const [profileName, setProfileName] = useState('');

  // 비동기 흐름에서 최신 draft를 읽어야 한다 (await 뒤의 클로저는 낡은 값을 본다)
  const draftRef = useRef(draft);
  draftRef.current = draft;

  // R-4: 마법사가 열려 있는 동안 자동 새로고침을 보류해 진행 중인 입력을 지킨다
  useEffect(() => {
    setRealtimePaused(true);
    return () => setRealtimePaused(false);
  }, []);

  const selectedProfile =
    selectedProfileId === null ? null : (profiles.find((p) => p.id === selectedProfileId) ?? null);

  const applyDraft = (next: ImportDraft): void => {
    draftRef.current = next;
    setDraft(next);
  };

  async function run<T>(label: string, action: () => Promise<ActionResult<T>>): Promise<T | null> {
    setBusy(label);
    setFailure(null);
    try {
      const res = await action();
      if (!res.ok) {
        // 절대 규칙 5: 실패를 조용히 삼키지 않는다
        setFailure({ message: res.error, code: res.code });
        return null;
      }
      return res.data;
    } finally {
      setBusy(null);
    }
  }

  // ─── 구조 분석 ─────────────────────────────────────────────

  function hintsOf(
    source: ImportDraft,
    overrides: Partial<AnalyzeSheetHints>,
    keepLabelColumns: boolean
  ): AnalyzeSheetHints {
    return {
      headerRow: source.profile.headerRow,
      dataStartRow: source.profile.dataStartRow,
      labelColumns: keepLabelColumns ? source.profile.labelColumns : null,
      amountUnit: source.profile.amountUnit,
      ministry: source.profile.ministry,
      categoryAliases: source.profile.categoryAliases,
      skipRowPatterns:
        source.profile.skipRowPatterns.length > 0 ? source.profile.skipRowPatterns : null,
      ...overrides,
    };
  }

  /** 분석 결과를 draft에 반영한다. 사용자가 이미 정한 연차 열 결정은 살아남는다 */
  function mergeAnalysis(
    base: ImportDraft,
    data: AnalyzeSheetResult,
    options: { resetYearDecisions: boolean }
  ): ImportDraft {
    const structure = data.structure;
    const detected = structure.yearColumns.map((y) => ({
      column: y.column,
      yearOrder: y.yearOrder,
    }));

    const excluded = options.resetYearDecisions ? new Set<string>() : new Set(excludedYearColumns);
    const included = detected.filter((d) => !excluded.has(d.column));
    const mapping = autoYearMapping(included, wizardYears);

    if (!options.resetYearDecisions) {
      // 사용자가 직접 고른 열은 자동 추정이 덮지 않는다 ("미지정"으로 되돌린 것도 존중한다)
      for (const column of touchedYearColumns) {
        if (!included.some((i) => i.column === column)) continue;
        const chosen = base.yearMapping[column];
        if (chosen === undefined) delete mapping[column];
        else mapping[column] = chosen;
      }
    }

    return {
      ...base,
      profile: {
        ...base.profile,
        sheetName: structure.sheetName,
        headerRow: structure.headerRow ?? base.profile.headerRow,
        dataStartRow: structure.dataStartRow,
        orientation: structure.orientation,
        labelColumns: structure.labelColumns,
        amountUnit: structure.amountUnit,
        yearColumnMappings: included,
      },
      yearMapping: mapping,
    };
  }

  async function analyze(
    sheetName: string | null,
    overrides: Partial<AnalyzeSheetHints>,
    options: { resetYearDecisions: boolean; keepLabelColumns: boolean }
  ): Promise<void> {
    const currentFile = file;
    if (!currentFile || sheetName === null) return;
    const data = await run('시트를 분석하는 중입니다…', () =>
      analyzeSheet(
        buildFormData(currentFile),
        sheetName,
        hintsOf(draftRef.current, overrides, options.keepLabelColumns)
      )
    );
    if (!data) return;
    setAnalysis(data);
    applyDraft(mergeAnalysis(draftRef.current, data, options));
    // 구조가 바뀌면 이전 미리보기는 더 이상 그 구조의 결과가 아니다
    setPreview(null);
    setDirty(false);
  }

  // ─── Step 1 ────────────────────────────────────────────────

  async function handleFileAccepted(picked: File): Promise<void> {
    setFile(picked);
    setAnalysis(null);
    setPreview(null);
    setLabelByRow({});
    setTouchedYearColumns([]);
    setExcludedYearColumns([]);
    setLabelColumnsTouched(false);
    setDirty(false);

    const profile = selectedProfile;

    const inspected = await run('파일을 읽는 중입니다…', () =>
      inspectWorkbook(buildFormData(picked))
    );
    if (!inspected) return;
    setInspect(inspected);

    // profile.name은 프로파일 저장 여부와 무관하게 비어 있으면 안 된다 (draft 검증 스키마가 min(1))
    const fallbackName = picked.name.replace(/\.[^.]+$/, '').slice(0, 100) || '엑셀 가져오기';
    const base = profile
      ? draftFromProfile(profile, projectId)
      : { ...initialDraft(projectId), profile: { ...initialDraft(projectId).profile, name: fallbackName } };

    const sheetName =
      profile?.sheetName ??
      inspected.recommendedSheet ??
      inspected.sheets[0]?.name ??
      null;
    const seeded: ImportDraft = {
      ...base,
      profile: { ...base.profile, sheetName },
    };
    applyDraft(seeded);
    setProfileName(profile?.name ?? fallbackName);

    if (sheetName === null) {
      setFailure({ message: '워크북에 시트가 없습니다.', code: 'VALIDATION' });
      return;
    }

    const analyzed = await run('시트를 분석하는 중입니다…', () =>
      analyzeSheet(
        buildFormData(picked),
        sheetName,
        profile
          ? {
              headerRow: profile.headerRow,
              dataStartRow: profile.dataStartRow,
              labelColumns: profile.labelColumns,
              amountUnit: profile.amountUnit,
              ministry: profile.ministry,
              categoryAliases: profile.categoryAliases,
              skipRowPatterns:
                profile.skipRowPatterns.length > 0 ? profile.skipRowPatterns : null,
            }
          : null
      )
    );
    if (!analyzed) return;
    setAnalysis(analyzed);

    let next = mergeAnalysis(seeded, analyzed, { resetYearDecisions: true });
    if (profile) {
      // 프로파일의 연차 열 대응을 우선한다 (yearOrder 기반 자동 제안 — §6.8.1)
      next = {
        ...next,
        profile: {
          ...next.profile,
          headerRow: profile.headerRow,
          dataStartRow: profile.dataStartRow,
          labelColumns: profile.labelColumns,
          amountUnit: profile.amountUnit,
          yearColumnMappings: profile.yearColumnMappings.map((m) => ({ ...m })),
        },
        yearMapping: autoYearMapping(profile.yearColumnMappings, wizardYears),
      };
      // 프로파일에 저장된 단위는 저장 시점에 확인된 값이다. 화면 상단에 계속 표시된다
      setUnitConfirmed(true);
      setLabelColumnsTouched(true);
    } else {
      setUnitConfirmed(false);
    }
    applyDraft(next);

    if (profile) {
      // §6.8.1: 프로파일이 있으면 ③~④를 건너뛰고 ⑤ 비목 매핑으로 간다
      const previewed = await runPreview(next);
      if (previewed) setStep(4);
      return;
    }
    setStep(2);
  }

  // ─── 미리보기 ──────────────────────────────────────────────

  async function runPreview(source?: ImportDraft): Promise<PreviewImportResult | null> {
    const currentFile = file;
    if (!currentFile) return null;
    const target = source ?? draftRef.current;
    const data = await run('반영 예정 내역을 계산하는 중입니다…', () =>
      previewImport(buildFormData(currentFile), target, projectId)
    );
    if (!data) return null;

    setPreview(data);
    // §5.12.2: 미리보기가 계산한 fileHash를 draft에 심어 commitImport가 같은 파일임을 대조한다
    applyDraft({ ...target, fileHash: data.fileHash });
    setDirty(false);

    // 원본 라벨은 미리보기가 오류·건너뜀 행에만 담아 준다 — 한 번 본 라벨은 계속 들고 있는다
    setLabelByRow((prev) => {
      const next = { ...prev };
      for (const row of data.rows) {
        const index = row.sourceRowIndexes[0];
        if (index === undefined || !row.label) continue;
        if (next[index] === undefined) next[index] = row.label;
      }
      return next;
    });
    return data;
  }

  // ─── Step 4 대응표 ─────────────────────────────────────────

  const labelColumnIndexes = useMemo(
    () => draft.profile.labelColumns.map(columnLetterToIndex),
    [draft.profile.labelColumns]
  );

  const entries: MappingEntry[] = useMemo(() => {
    if (!preview) return [];
    const grid = analysis?.grid ?? null;
    // 라벨은 서버가 실어 보낸 값(`PreviewRow.sourceRows[].label`)이 1순위다.
    // 나머지는 폴백일 뿐이며, 그리드는 상위 30행만 있으므로 그 아래 행은 여기까지 오지 않아야 한다.
    const labelOf = (rowIndex: number, fromPreview: string | null): string =>
      fromPreview ??
      labelByRow[rowIndex] ??
      labelFromGrid(grid, rowIndex, labelColumnIndexes) ??
      `${rowIndex + 1}행`;

    const map = new Map<number, MappingEntry>();
    for (const row of preview.rows) {
      if (row.status === 'error') {
        // 금액 셀 오류(#REF! 등)는 비목 매핑 문제가 아니다 — Step 5에서 다룬다
        const issue = categoryIssueOf(row.reason);
        const index = row.sourceRowIndexes[0];
        if (issue === null || index === undefined) continue;
        map.set(index, {
          rowIndex: index,
          label: labelOf(index, row.label),
          status: issue,
          category: null,
          reason: row.reason,
          needsDecision: true,
        });
        continue;
      }
      if (row.status === 'skipped') {
        const index = row.sourceRowIndexes[0];
        if (index === undefined || map.has(index)) continue;
        map.set(index, {
          rowIndex: index,
          label: labelOf(index, row.label),
          status: 'skipped',
          category: null,
          reason: row.reason,
          needsDecision: false,
        });
        continue;
      }
      // ✅ 완전일치 / 🔵 별칭사전의 구분은 **서버가 내린 판정을 그대로 쓴다**.
      // 여기서 classifyLabel을 다시 돌리면 같은 규칙이 두 곳에 생기고(O-4), 라벨도
      // 상위 30행 그리드에서 되찾아야 해서 그 아래 행은 `N행`으로 떨어진다.
      for (const source of row.sourceRows) {
        if (map.has(source.rowIndex)) continue;
        const manual = draft.manualCategoryByRow[source.rowIndex];
        const status: MappingStatus = manual
          ? 'manual'
          : source.categorySource === 'exact'
            ? 'exact'
            : 'alias';
        map.set(source.rowIndex, {
          rowIndex: source.rowIndex,
          label: labelOf(source.rowIndex, source.label),
          status,
          category: manual ?? row.category,
          reason: null,
          needsDecision: false,
        });
      }
    }
    return [...map.values()].sort((a, b) => a.rowIndex - b.rowIndex);
  }, [preview, analysis, draft, labelByRow, labelColumnIndexes]);

  // ─── 단계 이동 판정 ────────────────────────────────────────

  const detectedYearColumns = useMemo(
    () => analysis?.structure.yearColumns ?? [],
    [analysis]
  );
  const includedYearColumns = draft.profile.yearColumnMappings;

  // 프로파일이 지정한 연차 열이 이번 파일에서 감지되지 않을 수 있다. 목록에서 빼면 사용자가
  // 대응을 고칠 수단이 사라지므로(그리고 반영은 S-5로 막히므로) 합집합을 보여준다
  const yearColumnChoices = useMemo(() => {
    const map = new Map(detectedYearColumns.map((y) => [y.column, y]));
    for (const mapping of includedYearColumns) {
      if (map.has(mapping.column)) continue;
      map.set(mapping.column, {
        column: mapping.column,
        columnIndex: columnLetterToIndex(mapping.column),
        label: '(이번 파일에서 감지되지 않음 — 프로파일 지정)',
        yearOrder: mapping.yearOrder,
      });
    }
    return [...map.values()].sort((a, b) => a.columnIndex - b.columnIndex);
  }, [detectedYearColumns, includedYearColumns]);
  const unresolvedYearColumns = includedYearColumns.filter(
    (mapping) => draft.yearMapping[mapping.column] === undefined
  );

  const step2Blockers: string[] = [];
  if (!analysis) step2Blockers.push('시트를 분석하지 못했습니다.');
  if (draft.profile.orientation === 'column') {
    step2Blockers.push('비목이 열에 있는 서식(전치 매트릭스)은 v1에서 반영할 수 없습니다 (S-1).');
  }
  if (detectedYearColumns.length === 0) step2Blockers.push('연차 열을 찾지 못했습니다.');
  if (!unitConfirmed) step2Blockers.push('금액 단위를 확인해 주세요 (I-10).');

  const step3Blockers: string[] = [];
  if (draft.profile.labelColumns.length === 0) step3Blockers.push('라벨 열을 1개 이상 지정하세요.');
  if (includedYearColumns.length === 0) step3Blockers.push('연차 열을 1개 이상 지정하세요.');
  if (unresolvedYearColumns.length > 0) {
    step3Blockers.push(
      `대응되지 않은 연차 열이 있습니다 (${unresolvedYearColumns.map((y) => y.column).join(', ')}열). S-5`
    );
  }

  async function goNext(): Promise<void> {
    if (step === 1) {
      if (!inspect) return;
      setStep(selectedProfile ? 4 : 2);
      return;
    }
    if (step === 2) {
      setStep(3);
      return;
    }
    if (step === 3) {
      const data = await runPreview();
      if (data) setStep(4);
      return;
    }
    if (step === 4) {
      if (dirty) {
        const data = await runPreview();
        if (!data) return;
      }
      setStep(5);
    }
  }

  function goBack(): void {
    if (step === 1) return;
    setStep((step - 1) as WizardStep);
  }

  // ─── 반영 ──────────────────────────────────────────────────

  async function handleCommit(): Promise<void> {
    const currentFile = file;
    if (!currentFile || !preview || preview.blocked) return;

    let profileId = selectedProfileId;

    if (saveProfile) {
      const name = (selectedProfile?.name ?? profileName).trim();
      if (name === '') {
        setFailure({ message: '프로파일 이름을 입력하세요.', code: 'VALIDATION' });
        return;
      }
      // I-7: 사용자가 수동 지정한 별칭만 학습한다. 목록은 previewImport가 계산해 준 것을 그대로 쓴다
      const fields = {
        ...draft.profile,
        name,
        categoryAliases: { ...draft.profile.categoryAliases, ...preview.learnedAliases },
      };
      const saved = selectedProfile
        ? await run('프로파일을 저장하는 중입니다…', () =>
            updateImportProfile(selectedProfile.id, fields, selectedProfile.version)
          )
        : await run('프로파일을 저장하는 중입니다…', () => createImportProfile(fields));
      // 프로파일 저장이 실패했는데 반영을 강행하면 학습분이 조용히 사라진다 — 여기서 멈춘다
      if (!saved) return;
      profileId = saved.id;
    }

    const result = await run('예산 계획에 반영하는 중입니다…', () =>
      commitImport(buildFormData(currentFile), draftRef.current, projectId, profileId)
    );
    if (!result) return;

    const parts = [
      `${result.updated}개 셀 반영`,
      `신규 ${result.summary.new}건`,
      `덮어씀 ${result.summary.overwrite}건`,
      `건너뜀 ${result.summary.skipped}건`,
    ];
    if (profileId !== null && !result.profileUsageRecorded) {
      parts.push('(프로파일 사용 이력 갱신은 실패했습니다)');
    }
    onCommitted(`엑셀 가져오기 완료 — ${parts.join(' · ')}. 되돌리려면 설정 > 백업·복원의 임포트 스냅샷을 사용하세요.`);
  }

  // ─── 렌더 ──────────────────────────────────────────────────

  const grid =
    analysis?.grid.sheetName === draft.profile.sheetName
      ? analysis.grid
      : (inspect?.grids.find((g) => g.sheetName === draft.profile.sheetName) ?? null);

  const nextBlockers = step === 2 ? step2Blockers : step === 3 ? step3Blockers : [];
  const canGoNext =
    step < 5 &&
    busy === null &&
    nextBlockers.length === 0 &&
    (step !== 1 || inspect !== null);

  return (
    <Modal
      open
      size="xl"
      closeOnBackdrop={false}
      title={`엑셀 가져오기 — ${step}/5 ${STEP_TITLES[step]}`}
      description="반영 버튼을 누르기 전에는 아무것도 저장되지 않습니다. 모달을 닫으면 진행 상태는 폐기됩니다."
      // 진행 중(특히 반영 중)에는 Esc·× 로 닫히지 않게 한다 — 결과를 못 본 채 닫히면 무엇이 저장됐는지 알 수 없다
      onClose={() => {
        if (busy === null) onClose();
      }}
      footer={
        <>
          <span className="mr-auto text-xs text-slate-500">
            {nextBlockers.length > 0 && step < 5 && <span className="text-red-600">{nextBlockers[0]}</span>}
          </span>
          <Button variant="ghost" onClick={onClose} disabled={busy !== null}>
            취소
          </Button>
          <Button variant="secondary" onClick={goBack} disabled={step === 1 || busy !== null}>
            이전
          </Button>
          {step < 5 ? (
            <Button variant="primary" onClick={() => void goNext()} disabled={!canGoNext}>
              다음
            </Button>
          ) : (
            <Button
              variant="primary"
              onClick={() => void handleCommit()}
              disabled={busy !== null || preview === null || preview.blocked}
              title={
                preview?.blocked
                  ? '오류가 있거나 대응되지 않은 연차 열이 있어 반영할 수 없습니다.'
                  : undefined
              }
            >
              예산 계획에 반영
            </Button>
          )}
        </>
      }
    >
      <div className="space-y-4">
        <StepIndicator step={step} />

        {file && (
          <p className="text-[11px] text-slate-400">
            {file.name} · 시트 {draft.profile.sheetName ?? '(미선택)'} · 금액 단위 ×
            {draft.profile.amountUnit.toLocaleString()}
            {selectedProfile && ` · 프로파일 "${selectedProfile.name}"`}
          </p>
        )}

        {busy && (
          <p
            role="status"
            className="flex items-center gap-2 rounded-lg border border-blue-200 bg-blue-50 px-3 py-2 text-sm text-blue-800"
          >
            <span className="inline-block h-3 w-3 animate-spin rounded-full border-2 border-blue-300 border-t-blue-700" />
            {busy}
          </p>
        )}

        {failure && (
          <ErrorBanner
            message={failure.message}
            code={failure.code}
            onDismiss={() => setFailure(null)}
          />
        )}

        {step === 1 && (
          <Step1File
            file={file}
            busy={busy !== null}
            profiles={profiles}
            profilesError={profilesError}
            selectedProfileId={selectedProfileId}
            onSelectProfile={setSelectedProfileId}
            onFileAccepted={(picked) => void handleFileAccepted(picked)}
          />
        )}

        {step === 2 && inspect && (
          <Step2Sheet
            inspect={inspect}
            analysis={analysis}
            grid={grid}
            sheetName={draft.profile.sheetName}
            headerRow={draft.profile.headerRow}
            dataStartRow={draft.profile.dataStartRow}
            orientation={draft.profile.orientation}
            amountUnit={draft.profile.amountUnit}
            unitConfirmed={unitConfirmed}
            busy={busy !== null}
            pickTarget={pickTarget}
            onPickTargetChange={setPickTarget}
            onSelectSheet={(name) => {
              setLabelColumnsTouched(false);
              setTouchedYearColumns([]);
              setExcludedYearColumns([]);
              setUnitConfirmed(false);
              applyDraft({ ...draftRef.current, profile: { ...draftRef.current.profile, sheetName: name } });
              void analyze(
                name,
                { headerRow: null, dataStartRow: null, labelColumns: null, amountUnit: null },
                { resetYearDecisions: true, keepLabelColumns: false }
              );
            }}
            onPickRow={(rowIndex) => {
              if (pickTarget === 'header') {
                setUnitConfirmed(false);
                void analyze(
                  draftRef.current.profile.sheetName,
                  { headerRow: rowIndex, dataStartRow: null },
                  { resetYearDecisions: false, keepLabelColumns: labelColumnsTouched }
                );
                return;
              }
              applyDraft({
                ...draftRef.current,
                profile: { ...draftRef.current.profile, dataStartRow: rowIndex },
              });
            }}
            onHeaderRowChange={(row) =>
              applyDraft({
                ...draftRef.current,
                profile: { ...draftRef.current.profile, headerRow: row },
              })
            }
            onDataStartRowChange={(row) =>
              applyDraft({
                ...draftRef.current,
                profile: { ...draftRef.current.profile, dataStartRow: row },
              })
            }
            onOrientationChange={(orientation) =>
              applyDraft({
                ...draftRef.current,
                profile: { ...draftRef.current.profile, orientation },
              })
            }
            onAmountUnitChange={(unit: AmountUnit) => {
              setUnitConfirmed(false);
              applyDraft({
                ...draftRef.current,
                profile: { ...draftRef.current.profile, amountUnit: unit },
              });
            }}
            onUnitConfirmedChange={setUnitConfirmed}
            onReanalyze={() =>
              void analyze(
                draftRef.current.profile.sheetName,
                {},
                { resetYearDecisions: false, keepLabelColumns: labelColumnsTouched }
              )
            }
          />
        )}

        {step === 3 && (
          <Step3Columns
            columns={analysis?.columns ?? []}
            detectedYearColumns={yearColumnChoices}
            includedYearColumns={includedYearColumns}
            labelColumns={draft.profile.labelColumns}
            labelColumnsTouched={labelColumnsTouched}
            yearMapping={draft.yearMapping}
            touchedYearColumns={touchedYearColumns}
            years={wizardYears}
            busy={busy !== null}
            onToggleLabelColumn={(column) => {
              setLabelColumnsTouched(true);
              const current = draftRef.current.profile.labelColumns;
              const next = current.includes(column)
                ? current.filter((c) => c !== column)
                : [...current, column].sort(
                    (a, b) => columnLetterToIndex(a) - columnLetterToIndex(b)
                  );
              applyDraft({
                ...draftRef.current,
                profile: { ...draftRef.current.profile, labelColumns: next },
              });
              setPreview(null);
            }}
            onResetLabelColumns={() => {
              setLabelColumnsTouched(false);
              void analyze(
                draftRef.current.profile.sheetName,
                { labelColumns: null },
                { resetYearDecisions: false, keepLabelColumns: false }
              );
            }}
            onYearColumnChange={(column, value) => {
              setTouchedYearColumns((prev) => (prev.includes(column) ? prev : [...prev, column]));
              const current = draftRef.current;
              if (value === EXCLUDE_VALUE) {
                setExcludedYearColumns((prev) => (prev.includes(column) ? prev : [...prev, column]));
                const { [column]: _removed, ...rest } = current.yearMapping;
                applyDraft({
                  ...current,
                  profile: {
                    ...current.profile,
                    yearColumnMappings: current.profile.yearColumnMappings.filter(
                      (m) => m.column !== column
                    ),
                  },
                  yearMapping: rest,
                });
                setPreview(null);
                return;
              }
              setExcludedYearColumns((prev) => prev.filter((c) => c !== column));
              const detected = yearColumnChoices.find((y) => y.column === column);
              const mappings = current.profile.yearColumnMappings.some((m) => m.column === column)
                ? current.profile.yearColumnMappings
                : [
                    ...current.profile.yearColumnMappings,
                    { column, yearOrder: detected?.yearOrder ?? 0 },
                  ].sort((a, b) => a.yearOrder - b.yearOrder);
              const nextMapping = { ...current.yearMapping };
              if (value === '') delete nextMapping[column];
              else nextMapping[column] = value;
              applyDraft({
                ...current,
                profile: { ...current.profile, yearColumnMappings: mappings },
                yearMapping: nextMapping,
              });
              setPreview(null);
            }}
          />
        )}

        {step === 4 && (
          <Step4Categories
            entries={entries}
            preview={preview}
            manualCategoryByRow={draft.manualCategoryByRow}
            skippedRowIndexes={draft.skippedRowIndexes}
            ministry={draft.profile.ministry}
            busy={busy !== null}
            dirty={dirty}
            selectedProfile={selectedProfile}
            saveProfile={saveProfile}
            profileName={profileName}
            onAssign={(rowIndex, category) => {
              const current = draftRef.current;
              const manual: Record<number, BudgetCategory> = { ...current.manualCategoryByRow };
              if (category === null) delete manual[rowIndex];
              else manual[rowIndex] = category;
              applyDraft({
                ...current,
                manualCategoryByRow: manual,
                // 비목을 지정했다는 것은 이 행을 반영하겠다는 뜻이다
                skippedRowIndexes:
                  category === null
                    ? current.skippedRowIndexes
                    : current.skippedRowIndexes.filter((i) => i !== rowIndex),
              });
              setDirty(true);
            }}
            onToggleSkip={(rowIndex) => {
              const current = draftRef.current;
              const skipped = current.skippedRowIndexes.includes(rowIndex)
                ? current.skippedRowIndexes.filter((i) => i !== rowIndex)
                : [...current.skippedRowIndexes, rowIndex];
              applyDraft({ ...current, skippedRowIndexes: skipped });
              setDirty(true);
            }}
            onMinistryChange={(ministry) => {
              applyDraft({
                ...draftRef.current,
                profile: { ...draftRef.current.profile, ministry },
              });
              setDirty(true);
            }}
            onRecheck={() => void runPreview()}
            onSaveProfileChange={setSaveProfile}
            onProfileNameChange={setProfileName}
          />
        )}

        {step === 5 && (
          <Step5Preview
            preview={preview}
            yearNameById={yearNameById}
            currencyUnit={currencyUnit}
            busy={busy !== null}
            dirty={dirty}
            onRecheck={() => void runPreview()}
            onGoToStep={setStep}
          />
        )}
      </div>
    </Modal>
  );
}

function StepIndicator({ step }: { step: WizardStep }) {
  return (
    <ol className="flex flex-wrap items-center gap-1.5 text-xs">
      {([1, 2, 3, 4, 5] as WizardStep[]).map((n) => (
        <li
          key={n}
          className={`rounded-full px-2.5 py-1 ${
            n === step
              ? 'bg-slate-900 font-semibold text-white'
              : n < step
                ? 'bg-slate-200 text-slate-600'
                : 'bg-slate-50 text-slate-400'
          }`}
        >
          {n}. {STEP_TITLES[n]}
        </li>
      ))}
    </ol>
  );
}
