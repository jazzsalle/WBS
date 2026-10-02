'use client';

// [붙임4 가져오기] 대화 (SOT §7.9.8, §5.21 AV-7·AV-1·AV-2, 계획서 G-4·G-11·S-13~S-17)
//
//  - 파일 선택(업로드 전 확장자·10MB 검사, S-16) → previewAttachment4Import → 파서 상태별로
//    블록 선택(choose-block) · 8-1 행 선택 또는 "8-1 쓰지 않음"(choose-81-row) · 미리보기(ok) · 반영 불가(blocked)
//  - 선택이 바뀔 때마다 **같은 파일로 미리보기를 다시 부른다** — 숫자를 여기서 다시 계산하지 않는다.
//    반영은 미리보기의 selection·fileHash를 그대로 넘겨 서버가 같은 파싱으로 같은 파일임을 대조한다(AV-7 ⑤)
//  - 블록은 추측해 고르지 않는다(G-11) — 목록은 B열 텍스트 그대로다
//  - 작성 중 버전이 있으면 [반영] 비활성 + 이유(AV-2, [새 버전]과 같은 문구). 서버도 RULE로 거부한다
//  - 결과 문장은 부모가 토스트로 남긴다 — 대화가 닫혀도 무엇이 만들어졌는지 남아야 한다
//
// 파싱은 전부 actions/agreement-import.ts가 한다 — SheetJS를 클라이언트에서 import하지 않는다(I-13).

import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import type { AgreementVersionKind, Settings } from '@/types';
import type { ActionErrorCode } from '@/lib/db/errors';
import type { Plan81Summary } from '@/lib/agreement/attachment4-parse';
import {
  commitAttachment4Import,
  previewAttachment4Import,
  type Attachment4ImportCreated,
  type Attachment4ImportPreview,
  type Attachment4ImportSelection,
} from '@/actions/agreement-import';
import {
  AGREEMENT_VERSION_KIND_LABELS,
  AGREEMENT_VERSION_KIND_ORDER,
  BUDGET_CATEGORY_LABELS,
} from '@/lib/constants';
import { formatAmount } from '@/lib/currency';
import Modal from '@/components/ui/Modal';
import Button from '@/components/ui/Button';
import Badge from '@/components/ui/Badge';
import ErrorBanner from '@/components/ui/ErrorBanner';
import { setRealtimePaused } from '@/components/RealtimeRefresher';
import { MAX_UPLOAD_BYTES, buildFormData, formatBytes } from '@/components/budget/import/wizard-state';
import { draftExistsReason } from './VersionBar';

// lib/import-adapter.ts의 ATTACHMENT4_EXTENSIONS와 같은 값. 그 파일은 server-only라 클라이언트에서 읽을 수 없다 —
// 갈라져도 서버가 거부하므로 조용히 틀리지는 않는다(wizard-state.ts의 MAX_UPLOAD_BYTES와 같은 사정)
const ATTACHMENT4_EXTENSIONS = ['.xlsx', '.xlsm', '.xls'] as const;
const ACCEPT_ATTRIBUTE = ATTACHMENT4_EXTENSIONS.join(',');

const INPUT_CLASS =
  'mt-1 w-full rounded-lg border border-grey-300 bg-surface px-3 py-2 text-sm focus:border-grey-500 focus:outline-none disabled:opacity-50';

// AV-7 — 보내기(AV-6)의 Q4 문구와 같은 자리
const NOT_CLONED_NOTICE = '직전 버전을 복제하지 않고 붙임4 내용으로 새로 만듭니다';

const PLAN81_MODE_TEXT: Record<Plan81Summary['mode'], string> = {
  auto: '고른 블록과 이름이 같은 8-1 행을 찾아 대조했습니다',
  chosen: '고른 8-1 행으로 대조했습니다',
  none: '8-1을 쓰지 않습니다 — 정부지원 현금은 만들지 않습니다',
  unavailable: '8-1 시트를 읽지 못했습니다 — 정부지원 현금은 만들지 않습니다',
};

type Failure = { message: string; code?: ActionErrorCode };

const EMPTY_SELECTION: Attachment4ImportSelection = { blockIndex: null, plan81Row: null };

/** 업로드 전에 막을 이유. 서버도 거부하지만 왕복 없이 알려 준다(S-16) */
function rejectReason(file: File): string | null {
  const lower = file.name.toLowerCase();
  if (!ATTACHMENT4_EXTENSIONS.some((ext) => lower.endsWith(ext))) {
    return `붙임4는 ${ATTACHMENT4_EXTENSIONS.join(' · ')} 파일만 올릴 수 있습니다.`;
  }
  if (file.size > MAX_UPLOAD_BYTES) {
    return `파일이 ${formatBytes(file.size)}로 상한 10MB를 넘습니다. 필요한 시트만 남겨서 다시 올려주세요.`;
  }
  if (file.size === 0) return '빈 파일입니다.';
  return null;
}

function selectionFormData(file: File, selection: Attachment4ImportSelection): FormData {
  const formData = buildFormData(file);
  if (selection.blockIndex !== null) formData.set('blockIndex', String(selection.blockIndex));
  if (selection.plan81Row !== null) formData.set('plan81Row', String(selection.plan81Row));
  return formData;
}

export interface Attachment4ImportDialogProps {
  projectId: string;
  /** 화면 표시 단위. 파일·서버 금액은 언제나 원 단위 정수다 */
  currencyUnit: Settings['currencyUnit'];
  /** false면 아무것도 그리지 않고 진행 상태를 버린다 — 다시 열면 파일 선택부터 */
  open: boolean;
  onClose: () => void;
  /** 반영 성공 직후 결과 문장. 부모가 토스트로 남기고 대화를 닫는다(router.refresh()는 대화가 한다) */
  onDone: (message: string) => void;
}

export default function Attachment4ImportDialog({ open, ...rest }: Attachment4ImportDialogProps) {
  // 닫힐 때 언마운트해 파일·선택·입력을 버린다 — 다음에 열면 다른 파일일 수 있다
  if (!open) return null;
  return <Attachment4ImportDialogBody {...rest} />;
}

function Attachment4ImportDialogBody({
  projectId,
  currencyUnit,
  onClose,
  onDone,
}: Omit<Attachment4ImportDialogProps, 'open'>) {
  const router = useRouter();
  const inputRef = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<Attachment4ImportPreview | null>(null);
  // 종류·이름은 첫 미리보기의 nextVersionMeta로 한 번만 채운다 — 블록을 바꿔 다시 불러도 사용자가 고친 값을 지킨다
  const [kind, setKind] = useState<AgreementVersionKind | null>(null);
  const [name, setName] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [failure, setFailure] = useState<Failure | null>(null);
  const [created, setCreated] = useState<{ result: Attachment4ImportCreated; name: string } | null>(null);

  // R-4: 대화가 열린 동안 자동 새로고침을 보류해 미리보기·입력 중인 이름을 지킨다
  useEffect(() => {
    setRealtimePaused(true);
    return () => setRealtimePaused(false);
  }, []);

  const money = (won: number): string => formatAmount(won, currencyUnit);

  async function runPreview(target: File, selection: Attachment4ImportSelection): Promise<void> {
    setBusy('붙임4 파일을 읽는 중입니다…');
    setFailure(null);
    try {
      const res = await previewAttachment4Import(projectId, selectionFormData(target, selection));
      if (!res.ok) {
        // 절대 규칙 5: 암호 파일·크기 초과·시트 손상도 여기로 온다. 빈 미리보기로 눙치지 않는다
        setFailure({ message: res.error, code: res.code });
        return;
      }
      setPreview(res.data);
      if (kind === null) {
        setKind(res.data.nextVersionMeta.kind);
        setName(res.data.nextVersionMeta.name);
      }
    } finally {
      setBusy(null);
    }
  }

  async function handleFile(picked: File | null | undefined): Promise<void> {
    if (!picked) return;
    const reason = rejectReason(picked);
    if (reason) {
      setFailure({ message: reason, code: 'VALIDATION' });
      return;
    }
    setFile(picked);
    setPreview(null);
    await runPreview(picked, EMPTY_SELECTION);
  }

  function chooseBlock(blockIndex: number): void {
    if (file === null) return;
    // 블록이 바뀌면 8-1 후보도 달라진다 — 8-1 선택은 버리고 다시 판정받는다
    void runPreview(file, { blockIndex, plan81Row: null });
  }

  function choosePlan81(plan81Row: number | 'none' | null): void {
    if (file === null || preview === null) return;
    void runPreview(file, { blockIndex: preview.selection.blockIndex, plan81Row });
  }

  function resetFile(): void {
    setFile(null);
    setPreview(null);
    setFailure(null);
  }

  const parse = preview?.parse ?? null;
  const commitBlocker: string | null =
    preview === null || parse === null
      ? '붙임4 파일을 먼저 올리세요.'
      : parse.status === 'choose-block'
        ? '가져올 기관 블록을 고르세요.'
        : parse.status === 'choose-81-row'
          ? "8-1 행을 고르거나 '8-1 쓰지 않음'을 고르세요."
          : parse.status === 'blocked'
            ? '파일에 고칠 곳이 있어 반영할 수 없습니다 — 아래 목록을 고친 뒤 다시 올리세요.'
            : preview.draftVersionName !== null
              ? draftExistsReason(preview.draftVersionName)
              : name.trim() === ''
                ? '버전 이름을 입력하세요.'
                : null;

  async function handleCommit(): Promise<void> {
    if (file === null || preview === null || kind === null || commitBlocker !== null || created !== null) return;
    const trimmed = name.trim();
    setBusy('협약 예산 버전을 만드는 중입니다…');
    setFailure(null);
    try {
      // 액션은 스테이트리스라 같은 파일을 다시 보낸다. 선택은 미리보기 시점 값이 정본이다(사용자가 본 것과 같아야 한다)
      const res = await commitAttachment4Import(projectId, buildFormData(file), {
        fileHash: preview.fileHash,
        blockIndex: preview.selection.blockIndex,
        plan81Row: preview.selection.plan81Row,
        kind,
        name: trimmed,
      });
      if (!res.ok) {
        setFailure({ message: res.error, code: res.code });
        return;
      }
      setCreated({ result: res.data, name: trimmed });
      const { lineCount, govCashYearCount, blockLabel, warnings } = res.data;
      const warningText = warnings.length > 0 ? ` · 경고 ${warnings.length}건(가져오기 대화에서 확인)` : '';
      onDone(
        `붙임4 '${blockLabel}' 블록으로 협약 예산 버전 '${trimmed}'(${AGREEMENT_VERSION_KIND_LABELS[kind]}, 작성 중)을 만들었습니다 — 금액 줄 ${lineCount}개 · 정부지원 현금 ${govCashYearCount}개 연차${warningText}. 수행 모드에서 확인하세요.`
      );
      router.refresh();
    } finally {
      setBusy(null);
    }
  }

  const blocks = parse?.blocks ?? [];
  const selectedBlockIndex = parse !== null && parse.status !== 'choose-block' && parse.status !== 'blocked'
    ? parse.blockIndex
    : preview?.selection.blockIndex ?? null;
  const warnings = parse !== null && parse.status !== 'choose-block' ? parse.warnings : [];

  return (
    <Modal
      open
      size="xl"
      closeOnBackdrop={false}
      title="붙임4 가져오기"
      description="붙임4 과제별 사업비검토양식의 8-2 사용계획에서 기관 블록 하나를 읽어 작성 중 협약 예산 버전을 만듭니다. [반영]을 누르기 전에는 아무것도 저장되지 않습니다."
      // 진행 중에는 닫히지 않게 한다 — 결과를 못 본 채 닫히면 무엇이 됐는지 알 수 없다
      onClose={() => {
        if (busy === null) onClose();
      }}
      footer={
        <>
          <span className="mr-auto text-t7 text-grey-500">
            {created === null && preview !== null && commitBlocker !== null && (
              <span className="text-red-600">{commitBlocker}</span>
            )}
          </span>
          {created !== null ? (
            <Button variant="primary" onClick={onClose}>
              닫기
            </Button>
          ) : (
            <>
              <Button variant="ghost" onClick={onClose} disabled={busy !== null}>
                취소
              </Button>
              {file !== null && (
                <Button variant="secondary" onClick={resetFile} disabled={busy !== null}>
                  다른 파일
                </Button>
              )}
              <Button
                variant="primary"
                onClick={() => void handleCommit()}
                disabled={busy !== null || commitBlocker !== null}
                title={commitBlocker ?? undefined}
              >
                반영
              </Button>
            </>
          )}
        </>
      }
    >
      <div className="space-y-4">
        {file && (
          <p className="text-t7 text-grey-400">
            {file.name} ({formatBytes(file.size)})
          </p>
        )}

        {busy && (
          <p
            role="status"
            className="flex items-center gap-2 rounded-lg border border-blue-200 bg-blue-50 px-3 py-2 text-t6 text-blue-800"
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
            // RULE 문장의 위치 목록 줄바꿈을 살린다
            className="whitespace-pre-line"
          />
        )}

        {/* 결과 */}
        {created !== null && (
          <div className="space-y-2 rounded-xl border border-green-200 bg-green-50 px-3 py-2 text-t6 text-green-800">
            <p className="font-semibold">
              협약 예산 버전 &apos;{created.name}&apos;(작성 중)을 만들었습니다.
            </p>
            <p>
              블록 {created.result.blockLabel} · 금액 줄 {created.result.lineCount}개 · 정부지원 현금{' '}
              {created.result.govCashYearCount}개 연차
            </p>
            {created.result.warnings.length > 0 && (
              <ul className="list-disc space-y-0.5 pl-5 text-t7 text-orange-800">
                {created.result.warnings.map((w, i) => (
                  <li key={`${w.code}-${w.cell ?? ''}-${i}`} className="whitespace-pre-line">
                    {w.message}
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}

        {/* ① 파일 선택 */}
        {created === null && file === null && (
          <div className="rounded-xl border-2 border-dashed border-grey-300 bg-surface p-8 text-center">
            <p className="text-t6 font-semibold text-grey-700">붙임4 엑셀 파일을 선택하세요</p>
            <p className="mt-1 text-t7 text-grey-500">.xlsx · .xlsm · .xls · 최대 10MB</p>
            <p className="mt-1 text-t7 text-grey-400">
              8-2 사용계획의 기관 블록 하나로 버전을 만듭니다. 참여인원·편성 항목은 만들지 않습니다.
            </p>
            <Button
              variant="primary"
              className="mt-4"
              disabled={busy !== null}
              onClick={() => inputRef.current?.click()}
            >
              파일 선택
            </Button>
            <input
              ref={inputRef}
              type="file"
              accept={ACCEPT_ATTRIBUTE}
              className="hidden"
              onChange={(e) => {
                void handleFile(e.target.files?.[0]);
                // 같은 파일을 다시 골라도 change가 발생하도록 비운다
                e.target.value = '';
              }}
            />
          </div>
        )}

        {created === null && preview !== null && parse !== null && (
          <>
            {/* ② 블록 선택 — 여럿일 때만. 고른 뒤에도 바꿀 수 있게 남긴다 */}
            {blocks.length > 1 && (
              <section className="space-y-1.5">
                <h3 className="text-t7 font-semibold text-grey-700">
                  기관 블록 {parse.status === 'choose-block' && '— 가져올 블록을 고르세요'}
                </h3>
                <ul className="space-y-1">
                  {blocks.map((block) => {
                    const selected = parse.status !== 'choose-block' && selectedBlockIndex === block.index;
                    return (
                      <li key={block.index}>
                        <button
                          type="button"
                          disabled={busy !== null || selected}
                          onClick={() => chooseBlock(block.index)}
                          className={`flex w-full items-center justify-between gap-3 rounded-lg border px-3 py-2 text-left text-t6 transition disabled:cursor-not-allowed ${
                            selected
                              ? 'border-blue-300 bg-blue-50 text-blue-800'
                              : 'border-grey-200 bg-surface text-grey-700 hover:border-grey-400 disabled:opacity-50'
                          }`}
                        >
                          <span className="whitespace-pre-line font-medium">{block.label}</span>
                          <span className="shrink-0 text-t7 text-grey-500">
                            {block.startRow}~{block.endRow}행{selected && ' · 선택됨'}
                          </span>
                        </button>
                      </li>
                    );
                  })}
                </ul>
              </section>
            )}

            {/* ③ 8-1 행 선택 */}
            {parse.status === 'choose-81-row' && (
              <section className="space-y-1.5">
                <h3 className="text-t7 font-semibold text-grey-700">8-1 행 선택</h3>
                <p className="text-t7 text-grey-600">
                  {parse.reason === 'no-match'
                    ? `8-1에서 블록 '${parse.blockLabel}'과 이름이 같은 기관 행을 찾지 못한 연차가 있습니다.`
                    : `8-1에서 블록 '${parse.blockLabel}'과 이름이 같은 기관 행이 둘 이상인 연차가 있습니다.`}{' '}
                  정부지원 현금을 읽을 행을 고르거나 &apos;8-1 쓰지 않음&apos;을 고르세요.
                </p>
                <ul className="space-y-1">
                  {parse.candidates.map((candidate) => (
                    <li key={candidate.index}>
                      <button
                        type="button"
                        disabled={busy !== null}
                        onClick={() => choosePlan81(candidate.index)}
                        className="w-full rounded-lg border border-grey-200 bg-surface px-3 py-2 text-left text-t6 text-grey-700 transition hover:border-grey-400 disabled:cursor-not-allowed disabled:opacity-50"
                      >
                        <span className="whitespace-pre-line font-medium">{candidate.label}</span>
                        <span className="mt-0.5 block text-t7 text-grey-500">
                          {candidate.rows.map((r) => `${r.yearOrder}차년도 ${r.cell} ${r.label}`).join(' · ')}
                        </span>
                      </button>
                    </li>
                  ))}
                  <li>
                    <button
                      type="button"
                      disabled={busy !== null}
                      onClick={() => choosePlan81('none')}
                      className="w-full rounded-lg border border-grey-200 bg-surface px-3 py-2 text-left text-t6 text-grey-700 transition hover:border-grey-400 disabled:cursor-not-allowed disabled:opacity-50"
                    >
                      <span className="font-medium">8-1 쓰지 않음</span>
                      <span className="mt-0.5 block text-t7 text-grey-500">
                        정부지원 현금 없이 만듭니다 — 나중에 붙임4형 보기에서 입력할 수 있습니다.
                      </span>
                    </button>
                  </li>
                </ul>
              </section>
            )}

            {/* 반영 불가 */}
            {parse.status === 'blocked' && (
              <div role="alert" className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-t6 text-red-800">
                <p className="font-semibold">
                  붙임4 파일을 가져올 수 없습니다 — 파일에서 아래를 고친 뒤 다시 올리세요.
                </p>
                <ul className="mt-1 list-disc space-y-0.5 pl-5">
                  {parse.issues.map((issue, i) => (
                    <li key={`${issue.code}-${issue.cell ?? ''}-${i}`} className="whitespace-pre-line">
                      {issue.message}
                    </li>
                  ))}
                </ul>
              </div>
            )}

            {/* ④ 미리보기 */}
            {parse.status === 'ok' && preview.summary !== null && (
              <>
                {preview.draftVersionName !== null && (
                  <p
                    role="alert"
                    className="rounded-lg border border-orange-200 bg-orange-50 px-3 py-2 text-t6 text-orange-800"
                  >
                    {draftExistsReason(preview.draftVersionName)}
                  </p>
                )}
                {preview.hasVersions && preview.draftVersionName === null && (
                  <p className="rounded-lg border border-blue-200 bg-blue-50 px-3 py-2 text-t6 text-blue-800">
                    이미 협약 예산 버전이 있습니다. {NOT_CLONED_NOTICE}.
                  </p>
                )}

                <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 rounded-xl border border-grey-200 bg-grey-50 px-3 py-2 text-t7">
                  <dt className="text-grey-500">기관 블록</dt>
                  <dd className="whitespace-pre-line font-semibold text-grey-900">{parse.blockLabel}</dd>
                  <dt className="text-grey-500">단위</dt>
                  <dd className="text-grey-900">
                    {parse.unit.text} <span className="text-grey-500">({parse.unit.sheet} 시트 표기)</span>
                  </dd>
                  <dt className="text-grey-500">만들 금액 줄</dt>
                  <dd className="font-semibold text-grey-900">{preview.summary.lineCount}개</dd>
                  <dt className="text-grey-500">합계</dt>
                  <dd className="text-grey-900">
                    현금 {money(preview.summary.cash)} · 현물 {money(preview.summary.inKind)} · 계{' '}
                    {money(preview.summary.total)}
                  </dd>
                </dl>

                {/* 연차 × 비목 현금/현물. 서버가 계산한 합을 표시 단위로 환산만 한다 */}
                <section className="space-y-1.5">
                  <h3 className="text-t7 font-semibold text-grey-700">연차 × 비목</h3>
                  <div className="overflow-x-auto rounded-xl border border-grey-200">
                    <table className="w-full text-t7">
                      <thead className="bg-grey-50 text-grey-600">
                        <tr>
                          <th rowSpan={2} className="px-3 py-1.5 text-left font-semibold">
                            비목
                          </th>
                          {preview.summary.years.map((y) => (
                            <th key={y.yearId} colSpan={2} className="px-3 py-1.5 text-center font-semibold">
                              {y.yearName}
                            </th>
                          ))}
                        </tr>
                        <tr>
                          {preview.summary.years.map((y) => (
                            <YearAxisHeaders key={y.yearId} />
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {preview.summary.categories.map((category) => (
                          <tr key={category} className="border-t border-grey-100 text-grey-700">
                            <td className="px-3 py-1.5">{BUDGET_CATEGORY_LABELS[category]}</td>
                            {preview.summary!.years.map((y) => {
                              const cell = y.byCategory[category];
                              return (
                                <AmountPair
                                  key={y.yearId}
                                  cash={cell?.cash ?? 0}
                                  inKind={cell?.inKind ?? 0}
                                  money={money}
                                />
                              );
                            })}
                          </tr>
                        ))}
                        <tr className="border-t border-grey-200 bg-grey-50 font-semibold text-grey-900">
                          <td className="px-3 py-1.5">합계</td>
                          {preview.summary.years.map((y) => (
                            <AmountPair key={y.yearId} cash={y.cash} inKind={y.inKind} money={money} />
                          ))}
                        </tr>
                        <tr className="border-t border-grey-100 text-grey-700">
                          <td className="px-3 py-1.5">금액 줄</td>
                          {preview.summary.years.map((y) => (
                            <td key={y.yearId} colSpan={2} className="px-3 py-1.5 text-right tabular-nums">
                              {y.lineCount}개
                            </td>
                          ))}
                        </tr>
                        <tr className="border-t border-grey-100 text-grey-700">
                          <td className="px-3 py-1.5">정부지원 현금</td>
                          {preview.summary.years.map((y) => (
                            <td key={y.yearId} colSpan={2} className="px-3 py-1.5 text-right tabular-nums">
                              {y.govCash === null ? (
                                <span className="text-grey-400">미입력</span>
                              ) : (
                                money(y.govCash)
                              )}
                            </td>
                          ))}
                        </tr>
                      </tbody>
                    </table>
                  </div>
                </section>

                {/* 8-1 정합 */}
                <section className="space-y-1.5">
                  <div className="flex flex-wrap items-center gap-2">
                    <h3 className="text-t7 font-semibold text-grey-700">8-1 정합</h3>
                    <span className="text-t7 text-grey-500">{PLAN81_MODE_TEXT[parse.plan81.mode]}</span>
                    {preview.selection.plan81Row !== null && (
                      <Button size="sm" variant="ghost" disabled={busy !== null} onClick={() => choosePlan81(null)}>
                        8-1 행 다시 고르기
                      </Button>
                    )}
                  </div>
                  {parse.plan81.years.length > 0 && (
                    <div className="overflow-x-auto rounded-xl border border-grey-200">
                      <table className="w-full text-t7">
                        <thead className="bg-grey-50 text-grey-600">
                          <tr>
                            <th className="px-3 py-1.5 text-left font-semibold">연차</th>
                            <th className="px-3 py-1.5 text-left font-semibold">8-1 행</th>
                            <th className="px-3 py-1.5 text-right font-semibold">8-1 현금(A+B)</th>
                            <th className="px-3 py-1.5 text-right font-semibold">8-2 현금</th>
                            <th className="px-3 py-1.5 text-right font-semibold">8-1 현물(C)</th>
                            <th className="px-3 py-1.5 text-right font-semibold">8-2 현물</th>
                            <th className="px-3 py-1.5 text-right font-semibold">8-1 합계(H)</th>
                            <th className="px-3 py-1.5 text-right font-semibold">8-2 합계</th>
                            <th className="px-3 py-1.5 text-center font-semibold">결과</th>
                          </tr>
                        </thead>
                        <tbody>
                          {parse.plan81.years.map((check) => {
                            const fileCash =
                              check.govCash !== null && check.file.ownCash !== null
                                ? check.govCash + check.file.ownCash
                                : null;
                            const show = (v: number | null) =>
                              v === null ? <span className="text-grey-400">—</span> : money(v);
                            return (
                              <tr key={check.yearId} className="border-t border-grey-100 text-grey-700">
                                <td className="px-3 py-1.5">{check.yearName}</td>
                                <td className="px-3 py-1.5">
                                  {check.cell} <span className="whitespace-pre-line">{check.label}</span>
                                </td>
                                <td className="px-3 py-1.5 text-right tabular-nums">{show(fileCash)}</td>
                                <td className="px-3 py-1.5 text-right tabular-nums">{money(check.imported.cash)}</td>
                                <td className="px-3 py-1.5 text-right tabular-nums">{show(check.file.ownInKind)}</td>
                                <td className="px-3 py-1.5 text-right tabular-nums">{money(check.imported.inKind)}</td>
                                <td className="px-3 py-1.5 text-right tabular-nums">{show(check.file.total)}</td>
                                <td className="px-3 py-1.5 text-right tabular-nums">{money(check.imported.total)}</td>
                                <td className="px-3 py-1.5 text-center">
                                  {check.matches ? (
                                    <Badge tone="green">일치</Badge>
                                  ) : (
                                    <Badge tone="amber">확인 필요</Badge>
                                  )}
                                </td>
                              </tr>
                            );
                          })}
                        </tbody>
                      </table>
                    </div>
                  )}
                </section>
              </>
            )}

            {/* 경고 — 반영을 막지 않는다 */}
            {warnings.length > 0 && (
              <section className="space-y-1.5">
                <h3 className="text-t7 font-semibold text-grey-700">
                  경고 {warnings.length}건 <span className="font-normal text-grey-500">— 반영을 막지 않습니다</span>
                </h3>
                <ul className="list-disc space-y-0.5 rounded-lg border border-orange-200 bg-orange-50 py-2 pl-8 pr-3 text-t7 text-orange-800">
                  {warnings.map((w, i) => (
                    <li key={`${w.code}-${w.cell ?? ''}-${i}`} className="whitespace-pre-line">
                      {w.message}
                    </li>
                  ))}
                </ul>
              </section>
            )}

            {/* ⑤ 종류·이름(AV-1 초깃값) */}
            {parse.status === 'ok' && kind !== null && (
              <div className="grid gap-4 sm:grid-cols-2">
                <label>
                  <span className="text-sm font-medium text-grey-700">종류</span>
                  <select
                    value={kind}
                    onChange={(e) => setKind(e.target.value as AgreementVersionKind)}
                    disabled={busy !== null}
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
                    type="text"
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    maxLength={100}
                    required
                    disabled={busy !== null}
                    placeholder="예: 선정평가본"
                    className={INPUT_CLASS}
                  />
                </label>
              </div>
            )}
          </>
        )}
      </div>
    </Modal>
  );
}

function YearAxisHeaders() {
  return (
    <>
      <th className="px-3 py-1 text-right font-medium">현금</th>
      <th className="px-3 py-1 text-right font-medium">현물</th>
    </>
  );
}

function AmountPair({ cash, inKind, money }: { cash: number; inKind: number; money: (won: number) => string }) {
  return (
    <>
      <td className="px-3 py-1.5 text-right tabular-nums">{money(cash)}</td>
      <td className="px-3 py-1.5 text-right tabular-nums">{money(inKind)}</td>
    </>
  );
}
