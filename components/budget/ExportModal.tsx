'use client';

// 제출 서식 내보내기 모달 (SOT §7.9.4, §6.12 X-3·X-5·X-6·X-9·X-10·X-11·X-12)
//
//  - **연차 하나**를 골라 그 연차의 산출근거 + 총괄표가 든 xlsx를 받는다 (X-9·X-10)
//  - 템플릿은 둘 이상일 때만 고른다. 하나뿐이면 묻지 않는다 (X-3)
//  - **blockers가 있으면 내보내기를 막고** 무엇이 몇 행 넘쳤는지 그대로 보여 준다 (X-5).
//    조용히 자르면 잘린 예산이 그대로 제출된다
//  - **notices는 막지 않는다**: 음수 금액(PL-5)·연봉 미입력(D-8a)·연구비 사용 규칙 위반(§6.14)이
//    있어도 내보낼 수 있어야 한다 — 협의 중인 계획을 내보내는 것이 정상 사용이다(RL-1·PL-15).
//    규칙 finding은 severity가 error여도 경고다. 그래서 **접어 숨기지 않는다.** 보지 않고 지나간
//    경고는 없는 경고와 같다
//  - 내보내기는 읽기 전용이다 (X-11) — 앱 데이터를 한 줄도 바꾸지 않고 스냅샷도 남기지 않는다
//
// 판정(넘침·경고·행 수·합계·파일명)은 전부 서버(actions/export → lib/export)가 내린 값이다.
// 화면이 다시 계산하지 않는다 — 같은 규칙이 두 곳에 생기면 반드시 어긋난다 (O-4).

import { useCallback, useEffect, useRef, useState } from 'react';
import type { RuleSeverity, Settings, Year } from '@/types';
import { INDIRECT_BASE_LABELS } from '@/lib/constants';
import type { ActionErrorCode } from '@/lib/db/errors';
import type { ExportBlocker, ExportNotice, ExportPreview } from '@/actions/export';
import { exportSubmissionWorkbook, previewSubmissionExport } from '@/actions/export';
import { formatAmount } from '@/lib/currency';
import Badge, { type BadgeTone } from '@/components/ui/Badge';
import Button from '@/components/ui/Button';
import ErrorBanner from '@/components/ui/ErrorBanner';
import Modal from '@/components/ui/Modal';

const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

const BLOCKER_KIND_LABELS: Record<ExportBlocker['kind'], string> = {
  overflow: '행 넘침',
  unmapped: '대응 없음',
  layout: '서식 구조',
};

const NOTICE_KIND_LABELS: Record<ExportNotice['kind'], string> = {
  'skipped-row': '건너뛴 행',
  'negative-amount': '음수 금액',
  'missing-salary': '연봉 미입력',
  'rule-finding': '연구비 사용 규칙',
  'truncated-factor': '인자 잘림',
};

// RL-1: severity는 색만 정한다. 부록 E 시맨틱 — error red · warn orange(amber 톤) · info blue
const SEVERITY_TONES: Record<RuleSeverity, BadgeTone> = { error: 'red', warn: 'amber', info: 'blue' };
const SEVERITY_LABELS: Record<RuleSeverity, string> = { error: '위반', warn: '주의', info: '권고' };

interface Failure {
  message: string;
  code?: ActionErrorCode;
}

/**
 * 바이너리 다운로드. BackupPanel의 downloadJson과 같은 흐름이되 내용이 바이트라
 * base64를 먼저 푼다. atob은 바이트를 latin1 코드포인트로 주므로 그대로 옮긴다 —
 * 문자열을 Blob에 바로 넣으면 UTF-8로 다시 인코딩돼 xlsx가 깨진다.
 */
function downloadWorkbook(fileName: string, contentBase64: string): void {
  const binary = atob(contentBase64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);

  const url = URL.createObjectURL(new Blob([bytes], { type: XLSX_MIME }));
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName; // X-12: 과제명·연차·생성일은 서버가 파일명에 넣었다
  a.click();
  URL.revokeObjectURL(url);
}

export interface ExportModalProps {
  projectId: string;
  /** X-9: 한 번에 한 연차. 이 목록에서 고른다 */
  years: Year[];
  /** 화면 표시 단위. 파일에는 언제나 원 단위 정수가 나간다 (X-6) */
  currencyUnit: Settings['currencyUnit'];
  onClose: () => void;
}

export default function ExportModal({ projectId, years, currencyUnit, onClose }: ExportModalProps) {
  const [yearId, setYearId] = useState(years[0]?.id ?? '');
  // 사용자가 **직접 고른** 템플릿만 담는다. null이면 서버가 고른 기본값(preview.templateId)을
  // 따른다 — 미리보기 응답을 그대로 되먹이면 같은 값으로 미리보기가 한 번 더 돈다
  const [templateId, setTemplateId] = useState<string | null>(null);
  const [preview, setPreview] = useState<ExportPreview | null>(null);
  const [loading, setLoading] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [failure, setFailure] = useState<Failure | null>(null);
  const [done, setDone] = useState<string | null>(null);

  // 연차·템플릿을 빠르게 바꾸면 늦게 온 응답이 최신 미리보기를 덮는다
  const requestRef = useRef(0);

  const loadPreview = useCallback(async (): Promise<void> => {
    if (yearId === '') return;
    const seq = requestRef.current + 1;
    requestRef.current = seq;
    setLoading(true);
    setFailure(null);
    setDone(null);
    try {
      const res = await previewSubmissionExport(projectId, yearId, templateId ?? undefined);
      if (seq !== requestRef.current) return;
      if (!res.ok) {
        // 절대 규칙 5: 실패를 빈 미리보기로 눙치지 않는다 — 0행짜리 서식으로 보이면 안 된다
        setPreview(null);
        setFailure({ message: res.error, code: res.code });
        return;
      }
      setPreview(res.data);
    } finally {
      if (seq === requestRef.current) setLoading(false);
    }
  }, [projectId, yearId, templateId]);

  useEffect(() => {
    void loadPreview();
  }, [loadPreview]);

  async function handleExport(): Promise<void> {
    if (preview === null || preview.blockers.length > 0) return;
    setExporting(true);
    setFailure(null);
    setDone(null);
    try {
      const res = await exportSubmissionWorkbook(projectId, yearId, templateId ?? undefined);
      if (!res.ok) {
        setFailure({ message: res.error, code: res.code });
        return;
      }
      downloadWorkbook(res.data.fileName, res.data.contentBase64);
      setDone(`${res.data.fileName} 파일을 내려받았습니다.`);
    } catch (e) {
      // 다운로드 자체가 실패해도 알린다 — 파일이 없는데 성공으로 보이면 안 된다
      setFailure({
        message: `파일을 저장하지 못했습니다: ${e instanceof Error ? e.message : String(e)}`,
      });
    } finally {
      setExporting(false);
    }
  }

  const busy = loading || exporting;
  const blockers = preview?.blockers ?? [];
  const notices = preview?.notices ?? [];
  // 선택된 템플릿. 사용자가 고르기 전에는 서버가 고른 기본값이 유효값이다
  const effectiveTemplateId = templateId ?? preview?.templateId ?? '';

  const exportBlocker =
    years.length === 0
      ? '이 과제에 연차가 없습니다.'
      : preview === null
        ? '미리보기를 불러오지 못했습니다.'
        : blockers.length > 0
          ? `서식에 담을 수 없는 항목이 ${blockers.length}건 있어 내보낼 수 없습니다.`
          : null;

  return (
    <Modal
      open
      size="lg"
      closeOnBackdrop={false}
      title="제출 서식 내보내기"
      description="고른 연차의 산출근거와 총괄표를 한 파일(xlsx)로 내려받습니다. 앱의 데이터는 바뀌지 않습니다 (X-11)."
      onClose={() => {
        if (!exporting) onClose();
      }}
      footer={
        <>
          <span className="mr-auto text-xs text-grey-500">
            {exportBlocker !== null && <span className="text-red-600">{exportBlocker}</span>}
          </span>
          <Button variant="ghost" onClick={onClose} disabled={exporting}>
            닫기
          </Button>
          <Button
            variant="primary"
            onClick={() => void handleExport()}
            disabled={busy || exportBlocker !== null}
            title={exportBlocker ?? undefined}
          >
            {exporting ? '만드는 중…' : '내보내기'}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        {years.length === 0 ? (
          <p className="rounded-xl border border-dashed border-grey-300 p-6 text-center text-sm text-grey-400">
            연차가 없어 내보낼 서식이 없습니다. 과제 개요에서 단계·연차를 먼저 만드세요.
          </p>
        ) : (
          <>
            <div className="flex flex-wrap items-end gap-4">
              <label className="text-xs text-grey-600">
                <span className="mb-1 block font-semibold">대상 연차</span>
                <select
                  value={yearId}
                  disabled={busy}
                  onChange={(e) => {
                    setYearId(e.target.value);
                    setPreview(null); // 연차가 바뀌면 이전 미리보기는 그 연차의 결과가 아니다
                  }}
                  className="rounded-md border border-grey-300 px-2 py-1.5 text-xs focus:border-grey-500 focus:outline-none disabled:bg-grey-50"
                >
                  {years.map((year) => (
                    <option key={year.id} value={year.id}>
                      {year.order + 1}차년도 · {year.name}
                    </option>
                  ))}
                </select>
              </label>

              {/* X-3: 템플릿이 둘 이상일 때만 고른다. 하나뿐이면 묻지 않는다 */}
              {preview !== null && preview.templates.length > 1 && (
                <label className="text-xs text-grey-600">
                  <span className="mb-1 block font-semibold">서식 템플릿</span>
                  <select
                    value={effectiveTemplateId}
                    disabled={busy}
                    onChange={(e) => {
                      setTemplateId(e.target.value);
                      setPreview(null);
                    }}
                    className="rounded-md border border-grey-300 px-2 py-1.5 text-xs focus:border-grey-500 focus:outline-none disabled:bg-grey-50"
                  >
                    {preview.templates.map((template) => (
                      <option key={template.id} value={template.id}>
                        {template.label}
                      </option>
                    ))}
                  </select>
                </label>
              )}

              <p className="text-[11px] text-grey-400">
                산출근거 + 총괄표 두 시트가 함께 나갑니다 (X-9·X-10).
              </p>
            </div>

            {loading && (
              <p
                role="status"
                className="flex items-center gap-2 rounded-lg border border-blue-200 bg-blue-50 px-3 py-2 text-sm text-blue-800"
              >
                <span className="inline-block h-3 w-3 animate-spin rounded-full border-2 border-blue-300 border-t-blue-700" />
                내보낼 내용을 확인하는 중입니다…
              </p>
            )}

            {failure && (
              <ErrorBanner
                message={failure.message}
                code={failure.code}
                onRetry={() => void loadPreview()}
                onDismiss={() => setFailure(null)}
              />
            )}

            {done !== null && (
              <p
                role="status"
                className="rounded-xl border border-green-300 bg-green-50 px-3 py-2 text-xs text-green-900"
              >
                ✅ {done} 엑셀에서 열면 템플릿의 소계·합계 수식이 다시 계산됩니다 (X-4a).
              </p>
            )}

            {preview !== null && (
              <>
                {/* 내보내기 전 확인 (§7.9.4): 행 수 · 합계 금액 · 넘치는 세목 여부 */}
                <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5 rounded-xl border border-grey-200 bg-grey-50 px-3 py-2 text-xs">
                  <span className="font-semibold text-grey-700">{preview.yearLabel}</span>
                  <span className="text-grey-600">
                    반영될 행 <strong>{preview.rowCount}</strong>개
                  </span>
                  <span className="text-grey-600">
                    합계 <strong>{formatAmount(preview.totalAmount, currencyUnit)}</strong>
                  </span>
                  {blockers.length > 0 ? (
                    <Badge tone="red">서식에 담을 수 없는 항목 {blockers.length}건</Badge>
                  ) : (
                    <Badge tone="green">서식 자리 안에 모두 들어갑니다</Badge>
                  )}
                  {notices.length > 0 && <Badge tone="amber">확인할 경고 {notices.length}건</Badge>}
                </div>

                {/* X-5: 잘라내지 않는다. 무엇이 몇 행 넘쳤는지 그대로 보여 주고 내보내기를 막는다 */}
                {blockers.length > 0 && (
                  <div className="rounded-xl border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700">
                    <p className="font-semibold">
                      아래 {blockers.length}건 때문에 내보낼 수 없습니다. 조용히 잘라내지 않습니다
                      (X-5) — 잘린 예산은 조용히 틀린 예산입니다.
                    </p>
                    <ul className="mt-2 space-y-1">
                      {blockers.map((blocker, index) => (
                        <li
                          key={`${blocker.kind}:${blocker.label}:${index}`}
                          className="rounded bg-red-100/60 px-2 py-1"
                        >
                          <span className="font-semibold">
                            [{BLOCKER_KIND_LABELS[blocker.kind]}] {blocker.label}
                          </span>
                          <span className="ml-1">— {blocker.detail}</span>
                        </li>
                      ))}
                    </ul>
                    <p className="mt-2">
                      산출근거의 행을 줄이거나, 서식에 자리가 더 많은 템플릿으로 바꾼 뒤 다시
                      시도하세요.
                    </p>
                  </div>
                )}

                {/* 경고는 막지 않는다 (§7.9.4) — 협의 중인 계획도 내보낼 수 있어야 한다.
                    접어 숨기지 않는다: 보지 않고 지나간 경고는 없는 경고와 같다 */}
                {notices.length > 0 && (
                  <div className="rounded-xl border border-orange-300 bg-orange-50 px-3 py-2 text-xs text-orange-900">
                    <p className="font-semibold">
                      ⚠️ 확인할 내용 {notices.length}건이 있습니다. <strong>내보내기는 막지
                      않습니다</strong> — 이대로 파일에 반영됩니다.
                    </p>
                    <ul className="mt-2 space-y-1">
                      {notices.map((notice, index) => (
                        <li
                          key={`${notice.kind}:${notice.label}:${index}`}
                          className="rounded bg-orange-100/60 px-2 py-1"
                        >
                          <span className="font-semibold">
                            [{NOTICE_KIND_LABELS[notice.kind]}] {notice.label}
                          </span>
                          {notice.kind === 'rule-finding' && (
                            <>
                              <Badge tone={SEVERITY_TONES[notice.severity]} className="ml-1">
                                {SEVERITY_LABELS[notice.severity]}
                              </Badge>
                              {notice.approximate && (
                                <Badge
                                  tone="neutral"
                                  className="ml-1"
                                  title="가정이 들어간 판정입니다 (RL-7·RL-9)"
                                >
                                  근사
                                </Badge>
                              )}
                            </>
                          )}
                          <span className="ml-1">— {notice.detail}</span>
                        </li>
                      ))}
                    </ul>
                  </div>
                )}

                <p className="text-[11px] text-grey-400">
                  화면 금액은 표시 단위({currencyUnit})로 환산한 값이고, 파일에는 언제나 원 단위
                  정수가 들어갑니다 (X-6). 총괄표의 간접비 비율은 수정직접비 = {INDIRECT_BASE_LABELS[preview.indirectBase]}
                  기준입니다 (PL-13). 내보내기는 앱의 데이터를 바꾸지 않습니다 (X-11).
                </p>
              </>
            )}
          </>
        )}
      </div>
    </Modal>
  );
}
