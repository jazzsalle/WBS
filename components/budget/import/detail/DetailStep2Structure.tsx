'use client';

// Step 2 — 시트 · 구조 (SOT §7.9.3)
//  - 시트 탭 + 원본 그리드(총괄표 마법사의 SheetGrid를 그대로 쓴다)
//  - 감지 결과를 트리로: 섹션 → 비목 → 세목 → 데이터 행 수 (D-1·D-2·D-3)
//  - 각 세목의 컬럼 매핑(D-4·D-7)을 함께 보여 준다
//  - 확인이 필요한 표(D-3 번호·라벨 충돌, `⑤ 출장비` 분기, D-10 통화 경고)를 눈에 띄게 표시하고
//    사용자가 세목을 고르거나 통화를 확인하면 그 결정이 draft에 담긴다
//  - 섹션이 없는 시트를 고르면 **명시적으로 거부**한다 (D-1) — 총괄표는 §7.9.1로 안내한다
//
// 감지·판정은 전부 서버(actions/detail-import.ts → lib/import)가 한 것을 표시할 뿐이다.
// 여기서 다시 판정하면 규칙이 두 곳에 생겨 반드시 어긋난다 (O-4).

import type {
  DetailColumnRole,
  DetailImportDraft,
  DetailSheetBlockInfo,
  DetailSheetInfo,
  InspectDetailSheetResult,
  SheetGridPreview,
} from '@/types';
import Badge from '@/components/ui/Badge';
import ErrorBanner from '@/components/ui/ErrorBanner';
import SheetGrid from '../SheetGrid';
import {
  COLUMN_ROLE_LABELS,
  COLUMN_ROLE_OPTIONS,
  NOT_A_DETAIL_SHEET_GUIDE,
  SUBCATEGORY_RESOLUTION_LABELS,
  buildDetailTree,
  columnRoleOverridesOf,
  detailBlockAttentions,
  effectiveColumnRole,
  effectiveSubcategory,
  subcategoryOptions,
  unresolvedAttentionCount,
} from './detail-wizard-state';

const SECTION_LABELS = {
  direct: '직접비',
  indirect: '간접비',
} as const;

export interface DetailStep2StructureProps {
  inspect: InspectDetailSheetResult;
  /** 현재 고른 시트. draft.sheetName으로 찾은 결과이며 없으면 null */
  sheet: DetailSheetInfo | null;
  grid: SheetGridPreview | null;
  draft: DetailImportDraft;
  busy: boolean;
  onSelectSheet: (sheetName: string) => void;
  /** D-3: null이면 파서 판정으로 되돌린다 */
  onSubcategoryChoice: (blockKey: string, code: string | null) => void;
  /** D-10 통화 확인 */
  onCurrencyConfirm: (blockKey: string, confirmed: boolean) => void;
  /**
   * D-7: 컬럼 role 재지정. `null`은 역할 없음, `undefined`는 자동 감지로 되돌리기다.
   * 넘기지 않으면 컬럼 매핑 표는 읽기 전용이 된다.
   */
  onColumnRoleOverride?: (
    blockKey: string,
    columnIndex: number,
    role: DetailColumnRole | null | undefined
  ) => void;
}

export default function DetailStep2Structure({
  inspect,
  sheet,
  grid,
  draft,
  busy,
  onSelectSheet,
  onSubcategoryChoice,
  onCurrencyConfirm,
  onColumnRoleOverride,
}: DetailStep2StructureProps) {
  const tree = sheet !== null && sheet.eligible ? buildDetailTree(sheet) : null;
  const pending = sheet !== null && sheet.eligible ? unresolvedAttentionCount(sheet, draft) : 0;

  return (
    <div className="space-y-4">
      {/* 시트 탭 — 직접비 섹션이 있는 시트를 추천하되 확정은 사용자가 한다 (D-1) */}
      <div className="flex flex-wrap gap-1.5">
        {inspect.sheets.map((item) => {
          const selected = item.name === sheet?.name;
          const recommended = item.name === inspect.recommendedSheet;
          return (
            <button
              key={item.name}
              type="button"
              disabled={busy}
              onClick={() => onSelectSheet(item.name)}
              title={
                item.eligible
                  ? `섹션 ${item.sections.length}개 · 표 ${item.blocks.length}개 · ${item.rowCount.toLocaleString()}행 × ${item.columnCount}열`
                  : '소요명세 섹션이 없어 산출근거 시트가 아닙니다'
              }
              className={`rounded-lg border px-3 py-1.5 text-xs font-medium transition disabled:opacity-50 ${
                selected
                  ? 'border-grey-900 bg-grey-900 text-surface'
                  : recommended
                    ? 'border-green-400 bg-green-50 text-green-800'
                    : item.eligible
                      ? 'border-grey-200 bg-surface text-grey-600 hover:bg-grey-50'
                      : 'border-grey-200 bg-grey-50 text-grey-400 hover:bg-grey-100'
              }`}
            >
              {item.name}
              {recommended && <span className="ml-1.5">★</span>}
              <span className={`ml-1.5 ${selected ? 'text-grey-300' : 'text-grey-400'}`}>
                {item.eligible ? `표 ${item.blocks.length}` : '섹션 없음'}
              </span>
            </button>
          );
        })}
      </div>
      {inspect.recommendedSheet && (
        <p className="text-xs text-grey-500">
          ★ <strong>{inspect.recommendedSheet}</strong> 시트에서 <code>1. 직접비 소요명세</code>{' '}
          섹션을 찾았습니다. 추천일 뿐이니 실제 시트를 확인하고 고르세요.
        </p>
      )}

      {/* D-1 거부 — 총괄표를 여기 넣는 것이 가장 흔한 오조작이라 갈 곳을 알려 준다 */}
      {sheet !== null && !sheet.eligible && (
        <ErrorBanner message={NOT_A_DETAIL_SHEET_GUIDE} code="RULE" />
      )}

      {grid ? (
        <>
          <SheetGrid
            grid={grid}
            // 산출근거는 헤더·데이터 시작 행을 사용자가 짚지 않는다 — 표마다 다르고 파서가 찾는다
            // (D-4). 그리드는 원본 대조용이라 읽기 전용으로 둔다
            headerRow={null}
            suggestedHeaderRow={null}
            dataStartRow={-1}
            labelColumnIndexes={[]}
            yearColumnIndexes={[]}
            totalColumnIndexes={[]}
            pickTarget="header"
            onPickRow={() => {}}
            disabled
          />
          <p className="text-[11px] text-grey-400">
            원본 그리드는 상위 {grid.rows.length}행입니다. 산출근거 표는 대개 그 아래에 있으니, 아래
            트리의 행 번호로 원본과 대조하세요.
          </p>
        </>
      ) : (
        <p className="rounded-xl border border-dashed border-grey-300 p-6 text-center text-sm text-grey-400">
          시트를 선택하면 원본 미리보기가 표시됩니다.
        </p>
      )}

      {/* 확인이 남은 항목을 상단에 모아 둔다 — 트리가 길어 아래로 밀리면 놓친다 */}
      {pending > 0 && (
        <p className="rounded-lg border border-orange-300 bg-orange-50 px-3 py-2 text-xs font-semibold text-orange-900">
          ⚠️ 확인이 필요한 항목 {pending}건이 있습니다. 자동 인식은 제안이지 확정이 아닙니다 — 아래
          트리에서 세목을 고르거나 통화를 확인하세요.
        </p>
      )}

      {tree && sheet && (
        <section className="space-y-3">
          <h3 className="text-sm font-semibold text-grey-700">
            감지 결과 — 섹션 {tree.sections.length}개 · 표 {sheet.blocks.length}개
          </h3>

          {tree.sections.map((section) => (
            <div key={`${section.kind}:${section.headerRow}`} className="rounded-xl border border-grey-200">
              <div className="flex flex-wrap items-center gap-2 border-b border-grey-200 bg-grey-50 px-3 py-2 text-xs">
                <Badge tone={section.kind === 'direct' ? 'blue' : 'violet'}>
                  {SECTION_LABELS[section.kind]}
                </Badge>
                <span className="font-semibold text-grey-700">{section.label}</span>
                <span className="text-grey-400">{section.headerRow + 1}행</span>
                <span className="ml-auto text-grey-500">비목 {section.categories.length}개</span>
              </div>

              {section.categories.length === 0 ? (
                <p className="px-3 py-3 text-xs text-grey-400">이 섹션에서 비목 표를 찾지 못했습니다.</p>
              ) : (
                <div className="divide-y divide-grey-100">
                  {section.categories.map((category) => (
                    <div key={`${category.categoryRow}:${category.category}`} className="px-3 py-3">
                      <div className="flex flex-wrap items-baseline gap-2 text-sm">
                        <span className="font-semibold text-grey-800">{category.categoryLabel}</span>
                        <span className="text-[11px] text-grey-400">{category.categoryRow + 1}행</span>
                        <span className="ml-auto text-xs text-grey-500">
                          세목 {category.blocks.length}개 · 행 {category.rowCount}개 · 파일 합계{' '}
                          {category.fileAmount.toLocaleString()}원
                        </span>
                      </div>

                      <div className="mt-2 space-y-2">
                        {category.blocks.map((info) => (
                          <BlockCard
                            key={info.key}
                            info={info}
                            draft={draft}
                            busy={busy}
                            onSubcategoryChoice={onSubcategoryChoice}
                            onCurrencyConfirm={onCurrencyConfirm}
                            onColumnRoleOverride={onColumnRoleOverride}
                          />
                        ))}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          ))}

          {/* 섹션 밖의 표는 정상 시트에 없다. 생기면 조용히 버리지 않고 드러낸다 (절대 규칙 5) */}
          {tree.orphans.length > 0 && (
            <div className="rounded-xl border border-red-200 bg-red-50 p-3">
              <p className="text-xs font-semibold text-red-800">
                섹션 범위 밖에서 감지된 표 {tree.orphans.length}건 — 원본 구조를 확인하세요.
              </p>
              <ul className="mt-1 list-disc pl-5 text-[11px] text-red-700">
                {tree.orphans.map((category) => (
                  <li key={`${category.categoryRow}:${category.category}`}>
                    {category.categoryLabel} ({category.categoryRow + 1}행) · 행 {category.rowCount}개
                  </li>
                ))}
              </ul>
            </div>
          )}
        </section>
      )}
    </div>
  );
}

function BlockCard({
  info,
  draft,
  busy,
  onSubcategoryChoice,
  onCurrencyConfirm,
  onColumnRoleOverride,
}: {
  info: DetailSheetBlockInfo;
  draft: DetailImportDraft;
  busy: boolean;
  onSubcategoryChoice: (blockKey: string, code: string | null) => void;
  onCurrencyConfirm: (blockKey: string, confirmed: boolean) => void;
  onColumnRoleOverride?: (
    blockKey: string,
    columnIndex: number,
    role: DetailColumnRole | null | undefined
  ) => void;
}) {
  const block = info.block;
  const attentions = detailBlockAttentions(info, draft);
  const unresolved = attentions.filter((item) => !item.resolved);
  const chosen = (draft.subcategoryChoices ?? {})[info.key];
  const selected = effectiveSubcategory(info, draft);
  const options = subcategoryOptions(block.category);
  const hasData = block.dataEndRow >= block.dataStartRow;

  return (
    <div
      className={`rounded-lg border p-3 ${
        unresolved.length > 0 ? 'border-orange-300 bg-orange-50/60' : 'border-grey-200 bg-surface'
      }`}
    >
      <div className="flex flex-wrap items-baseline gap-2 text-xs">
        <span className="font-semibold text-grey-800">
          {block.subcategoryLabel ?? '(세목 헤더 없음)'}
        </span>
        {block.numberToken && <Badge tone="neutral">{block.numberToken}</Badge>}
        {block.resolvedBy && (
          <Badge tone={block.resolvedBy === 'conflict' ? 'amber' : 'neutral'}>
            {SUBCATEGORY_RESOLUTION_LABELS[block.resolvedBy]}
          </Badge>
        )}
        {block.tableIndex > 0 && <Badge tone="neutral">{block.tableIndex + 1}번째 표</Badge>}
        <span className="ml-auto text-grey-500">
          {hasData
            ? `${block.dataStartRow + 1}~${block.dataEndRow + 1}행`
            : `${block.dataStartRow + 1}행~ (데이터 없음)`}{' '}
          · 행 {info.rowCount}개
          {info.skipSuggestedCount > 0 && ` (0원 ${info.skipSuggestedCount}개 기본 건너뜀)`} · 파일
          합계 {info.fileAmount.toLocaleString()}원
          {info.subtotalCount > 0 && ` · 파일 소계 ${info.subtotalCount}건`}
        </span>
      </div>

      {/* D-3·D-10: 확인이 필요한 항목을 눈에 띄게. 해소된 것도 지우지 않고 ✓로 남긴다 */}
      {attentions.length > 0 && (
        <ul className="mt-2 space-y-1">
          {attentions.map((item) => (
            <li
              key={item.key}
              className={`rounded px-2 py-1 text-[11px] ${
                item.resolved
                  ? 'bg-green-50 text-green-800'
                  : 'bg-orange-100 font-semibold text-orange-900'
              }`}
            >
              {item.resolved ? '✓' : '⚠️'} {item.label} — <span className="font-normal">{item.hint}</span>
            </li>
          ))}
        </ul>
      )}

      <div className="mt-2 flex flex-wrap items-center gap-2 text-xs">
        <label className="flex items-center gap-2">
          <span className="font-medium text-grey-600">세목</span>
          <select
            value={selected ?? ''}
            disabled={busy}
            onChange={(e) => onSubcategoryChoice(info.key, e.target.value === '' ? null : e.target.value)}
            className={`rounded-lg border px-2 py-1 ${
              chosen === undefined ? 'border-grey-300 text-grey-600' : 'border-blue-400 font-semibold text-blue-700'
            }`}
          >
            <option value="">(미지정 — 파서 판정을 따름)</option>
            {options.map((option) => (
              <option key={option.code} value={option.code}>
                {option.label}
              </option>
            ))}
          </select>
        </label>
        <span className="text-[11px] text-grey-400">
          {chosen === undefined
            ? '시트에서 읽은 제안입니다. 다르면 직접 고르세요.'
            : '사용자가 고른 세목입니다.'}
        </span>
      </div>

      {/* D-10: 확인 없이는 반영하지 않는다. 환율을 앱이 지어내지 않는다 */}
      {info.currency !== null && (
        <label className="mt-2 flex cursor-pointer items-center gap-2 rounded-lg border border-orange-300 bg-orange-100 px-2 py-1.5 text-[11px] font-semibold text-orange-900">
          <input
            type="checkbox"
            checked={(draft.confirmedCurrencyBlocks ?? []).includes(info.key)}
            disabled={busy}
            onChange={(e) => onCurrencyConfirm(info.key, e.target.checked)}
          />
          이 표의 금액이 원화임을 확인했습니다 ({info.currency.symbol} 표기 있음)
        </label>
      )}

      <ColumnMapping
        info={info}
        draft={draft}
        busy={busy}
        onColumnRoleOverride={onColumnRoleOverride}
      />
    </div>
  );
}

/**
 * D-4·D-7 컬럼 매핑. **위치가 아니라 헤더 텍스트로** 정한 결과이며, 부처마다 열 순서가 달라도
 * 같은 역할이 잡힌다. 역할이 비어 있는 열은 반영에 쓰이지 않는다.
 *
 * D-7: "매핑 결과는 미리보기에 드러내 **사용자가 고칠 수 있어야 한다**" — 역할 칸은 드롭다운이다.
 * 사전이 모르는 헤더(실측 `실지급액\n(연봉)` 같은 부처 변형)가 나오면 이것이 유일한 우회로이고,
 * 없으면 그 표의 금액이 통째로 0원이 되거나 임포트가 막힌다 (I-4와 같은 형태).
 *
 * 자동 추정은 회색, 사용자가 바꾼 것은 파랑이다 (§7.9.1 Step 3 관례).
 */
function ColumnMapping({
  info,
  draft,
  busy,
  onColumnRoleOverride,
}: {
  info: DetailSheetBlockInfo;
  draft: DetailImportDraft;
  busy: boolean;
  onColumnRoleOverride?: (
    blockKey: string,
    columnIndex: number,
    role: DetailColumnRole | null | undefined
  ) => void;
}) {
  const block = info.block;
  const overrides = columnRoleOverridesOf(draft, info.key);
  const changedCount = block.columns.filter(
    (column) => effectiveColumnRole(column, overrides).overridden
  ).length;
  const headerRows =
    block.headerRows.length === 0
      ? '없음'
      : block.headerRows.map((row) => `${row + 1}`).join(', ') + '행';

  return (
    <details className="mt-2" open={changedCount > 0}>
      <summary className="cursor-pointer text-[11px] text-grey-500">
        컬럼 매핑 {block.columns.length}열 (헤더 {headerRows}) — 헤더 텍스트로 매핑합니다 (D-7)
        {changedCount > 0 && (
          <span className="ml-1 font-semibold text-blue-700">· 사용자 지정 {changedCount}열</span>
        )}
      </summary>
      {block.columns.length === 0 ? (
        <p className="mt-1 text-[11px] text-red-700">
          컬럼 헤더를 찾지 못해 이 표는 반영되지 않습니다 (D-4).
        </p>
      ) : (
        <div className="mt-1 overflow-x-auto">
          <table className="w-max min-w-full border-collapse text-[11px]">
            <thead>
              <tr className="bg-grey-50 text-grey-500">
                <th className="border border-grey-200 px-2 py-1 font-normal">열</th>
                <th className="border border-grey-200 px-2 py-1 font-normal">헤더</th>
                <th className="border border-grey-200 px-2 py-1 font-normal">역할</th>
              </tr>
            </thead>
            <tbody>
              {block.columns.map((column) => {
                const { role, overridden } = effectiveColumnRole(column, overrides);
                return (
                  <tr key={column.index}>
                    <td className="border border-grey-200 px-2 py-1 font-mono text-grey-500">
                      {column.column}
                    </td>
                    <td
                      className="max-w-[16rem] truncate border border-grey-200 px-2 py-1"
                      title={column.label}
                    >
                      {column.label || '(빈 헤더)'}
                    </td>
                    <td className="border border-grey-200 px-2 py-1">
                      <select
                        value={role ?? ''}
                        disabled={busy || onColumnRoleOverride === undefined}
                        // 자동 감지와 같은 값을 고르면 재지정을 지운다 — 바꾸지 않은 것을
                        // 파랑으로 남기면 무엇을 손댔는지 알 수 없다
                        onChange={(e) => {
                          const picked = e.target.value === '' ? null : (e.target.value as DetailColumnRole);
                          onColumnRoleOverride?.(
                            info.key,
                            column.index,
                            picked === column.role ? undefined : picked
                          );
                        }}
                        className={`rounded border px-1.5 py-0.5 ${
                          overridden
                            ? 'border-blue-400 font-semibold text-blue-700'
                            : role === null
                              ? 'border-grey-200 text-grey-400'
                              : 'border-grey-200 text-grey-500'
                        }`}
                      >
                        <option value="">— (쓰지 않음)</option>
                        {COLUMN_ROLE_OPTIONS.map(([value, label]) => (
                          <option key={value} value={value}>
                            {label}
                          </option>
                        ))}
                      </select>
                      {overridden && (
                        <span
                          className="ml-1 text-blue-700"
                          title={`자동 감지: ${
                            column.role === null ? '— (쓰지 않음)' : COLUMN_ROLE_LABELS[column.role]
                          }`}
                        >
                          ✎
                        </span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          <p className="mt-1 text-[11px] text-grey-400">
            회색은 헤더 텍스트로 자동 인식한 역할이고 파랑(✎)은 사용자가 바꾼 역할입니다. 자동
            인식은 제안이지 확정이 아닙니다 — 서식이 달라 역할이 비어 있으면 여기서 지정하세요
            (D-7). 인자(수량·회·월) 외의 역할은 표마다 열 하나입니다.
          </p>
        </div>
      )}
    </details>
  );
}
