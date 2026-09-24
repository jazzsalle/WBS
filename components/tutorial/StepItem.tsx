'use client';

// 따라하기 단계 한 줄 (SOT §7.17 TU-2·TU-4·TU-7)
//  - 완료 표시: auto 단계는 서버 판정을 읽기 전용 체크로만 보인다 — 데이터가 근거라 손으로 못 바꾼다.
//    manual 단계(export·backup)만 체크박스이고, backup은 lastBackupAt이 있으면 체크 고정(TU-4).
//  - `[이 화면으로]`·"자세히 → 도움말"은 lib/tutorial.ts 레지스트리로 그린다 — 본문(md)에는
//    링크가 없다(TU-7, 노트 파서가 상대 URL을 링크로 만들지 않는 경계를 완화하지 않는다).
//  - 본문 1행(제목)·2행(할 일)은 헤더에 따로 그리므로 AST에서는 뺀다 (HelpPage와 같은 방식).

import Link from 'next/link';
import type { TutorialDocument } from '@/lib/content';
import type { TutorialStep } from '@/lib/tutorial';
import MarkdownViewer from '@/components/notes/MarkdownViewer';

export interface StepItemProps {
  step: TutorialStep;
  /** 서버가 content/tutorial/<step>.md를 읽어 내려준 본문. 없으면 빠진 파일이다 — 감추지 않는다 */
  doc: TutorialDocument | undefined;
  done: boolean;
  expanded: boolean;
  onToggleExpand: () => void;
  /** `[이 화면으로]` 대상. 과제가 필요한 단계는 null이면 비활성 */
  selectedProjectId: string | null;
  /** backup 단계에서 lastBackupAt이 있으면 true — 체크 고정·비활성 */
  manualLocked: boolean;
  /** manual 단계 체크 변경. 저장 실패는 부모가 배너로 보인다 */
  onManualChange: (checked: boolean) => void;
  disabled: boolean;
}

export default function StepItem({
  step,
  doc,
  done,
  expanded,
  onToggleExpand,
  selectedProjectId,
  manualLocked,
  onManualChange,
  disabled,
}: StepItemProps) {
  const screenPath = step.screenPath(selectedProjectId);
  const bodyId = `tutorial-step-${step.id}`;

  return (
    <li className={`rounded-xl border ${done ? 'border-green-100 bg-green-50/40' : 'border-hairline bg-white'}`}>
      <div className="flex items-center gap-3 px-4 py-3">
        {step.detection === 'auto' ? (
          <span
            role="img"
            aria-label={done ? '완료 (자동 판정)' : '미완료 (자동 판정)'}
            title={done ? '데이터가 있어 자동으로 완료 처리됐습니다' : '데이터가 생기면 자동으로 완료됩니다'}
            className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-t7 font-bold ${
              done ? 'bg-green-500 text-white' : 'bg-grey-100 text-grey-500'
            }`}
          >
            {done ? '✓' : step.order}
          </span>
        ) : (
          <input
            type="checkbox"
            checked={done}
            disabled={disabled || manualLocked}
            onChange={(e) => onManualChange(e.target.checked)}
            aria-label={`${step.order}. ${step.title} 완료`}
            title={
              manualLocked
                ? '이 PC에서 백업한 기록이 있어 완료로 고정됩니다'
                : '이 단계는 자동 감지가 안 됩니다 — 직접 체크하세요'
            }
            className="h-5 w-5 shrink-0 rounded border-grey-300 text-blue-500 focus:ring-blue-100 disabled:opacity-60"
          />
        )}

        <button
          type="button"
          onClick={onToggleExpand}
          aria-expanded={expanded}
          aria-controls={bodyId}
          className="flex min-w-0 flex-1 items-center justify-between gap-2 text-left"
        >
          <span className={`text-t6 font-semibold ${done ? 'text-grey-500 line-through' : 'text-grey-900'}`}>
            {step.detection === 'manual' && <span className="mr-1 text-grey-400">{step.order}.</span>}
            {step.title}
          </span>
          <span aria-hidden="true" className="text-grey-400">
            {expanded ? '−' : '+'}
          </span>
        </button>
      </div>

      {expanded && (
        <div id={bodyId} className="border-t border-hairline px-4 pb-4 pt-3">
          {doc === undefined ? (
            // 9편이 전부 있어야 하는 파일이다(readAllTutorialDocuments). 빠졌으면 배포 사고다 — 빈 칸으로 두지 않는다
            <p role="alert" className="rounded-lg bg-red-50 p-3 text-t7 text-red-700">
              이 단계의 본문(content/tutorial/{step.id}.md)을 찾지 못했습니다. 관리자에게 알리세요.
            </p>
          ) : (
            <>
              <p className="rounded-lg bg-blue-50 px-3 py-2 text-t7 font-medium text-blue-700">
                할 일: {doc.intro}
              </p>
              <MarkdownViewer blocks={doc.blocks.slice(2)} emptyText="본문이 아직 없습니다." />
            </>
          )}

          <div className="mt-3 flex flex-wrap items-center gap-2">
            {screenPath !== null ? (
              <Link
                href={screenPath}
                className="rounded-lg bg-blue-500 px-3 py-1.5 text-t7 font-semibold text-white transition hover:bg-blue-600"
              >
                이 화면으로
              </Link>
            ) : (
              <>
                <span
                  aria-disabled="true"
                  className="cursor-not-allowed rounded-lg bg-grey-100 px-3 py-1.5 text-t7 font-semibold text-grey-400"
                >
                  이 화면으로
                </span>
                <span className="text-t7 text-grey-500">먼저 과제를 고르세요</span>
              </>
            )}
            <Link
              href={`/help#${step.helpSlug}`}
              className="ml-auto text-t7 font-medium text-grey-600 underline underline-offset-2 hover:text-grey-900"
            >
              자세히 → 도움말
            </Link>
          </div>
        </div>
      )}
    </li>
  );
}
