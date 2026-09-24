'use client';

// Step 4 — 미리보기 & 반영 (SOT §7.9.3 Step 4, §6.11.3 D-8·D-8a·D-21, §6.11.5 D-15·D-15a·D-15b·D-18)
//
//  - 비목 → 세목 → 행 트리. 행 상태는 `신규`(초록)/`건너뜀`(회색)/`오류`(빨강) (§7.9.1 Step 5 관례)
//  - 셀 상태: `기존 N행 있음` + [기존 삭제 후 교체] 체크박스. **기본 꺼짐** — 조용히 덮지 않는다 (D-15)
//  - D-8: 산식 결과와 파일 합계가 다른 행은 `계산 A → 파일 B (조정 ±C)`로 드러낸다. 조용히 넣지 않는다
//  - D-10: 통화 경고가 있는 표는 확인해야 반영 대상에 들어간다 (환율을 앱이 지어내지 않는다)
//  - D-18: 소계 불일치는 **경고**다. 반영 버튼을 막지 않는다
//  - D-21 ②: 0원 행은 기본 건너뜀 제안이되 사용자가 포함시킬 수 있다
//  - 오류가 1건이라도 있으면 반영 버튼 비활성 (§7.9.1과 같다)
//
// 판정은 전부 서버(previewDetailImport → lib/import/detail-preview)가 내린 값이다. 상태·금액·사유를
// 화면이 다시 계산하지 않는다 — 같은 규칙이 두 곳에 생기면 반드시 어긋난다 (O-4).

import { useMemo } from 'react';
import type {
  BudgetCategory,
  CommitDetailImportResult,
  DetailAxis,
  DetailImportDraft,
  DetailRowDecision,
  PreviewDetailImportResult,
} from '@/types';
// types/index.ts가 재수출하지 않는 미리보기 타입. **타입 전용 import라 번들에 남지 않는다** (I-13)
import type {
  DetailPreviewBlock,
  DetailPreviewCell,
  DetailPreviewRow,
  DetailSubtotalCheck,
} from '@/lib/import';
import { BUDGET_CATEGORY_LABELS, DETAIL_AXIS_LABELS } from '@/lib/constants';
import Badge from '@/components/ui/Badge';
import Button from '@/components/ui/Button';
import { subcategoryOptions } from './detail-wizard-state';

const ROW_STATUS_CLASS: Record<DetailPreviewRow['status'], string> = {
  new: 'bg-green-50 text-green-800',
  skipped: 'bg-grey-100 text-grey-500',
  error: 'bg-red-50 text-red-700',
};

const CELL_STATUS_TONE: Record<DetailPreviewCell['status'], 'green' | 'blue' | 'neutral' | 'red'> = {
  new: 'green',
  replace: 'blue',
  skipped: 'neutral',
  error: 'red',
};

const CELL_STATUS_LABEL: Record<DetailPreviewCell['status'], string> = {
  new: '신규',
  replace: '교체',
  skipped: '건너뜀',
  error: '오류',
};

/** D-9 축 셀렉트의 선택지. 라벨 사전에서 파생시켜 목록이 둘로 갈리지 않게 한다 (D-7 관례) */
const AXIS_OPTIONS = Object.entries(DETAIL_AXIS_LABELS) as [DetailAxis, string][];

/** 행 단위 결정이 통하지 않는 건너뜀 사유 — 셀·통화·성명은 다른 자리에서 푼다 */
const ROW_LOCKED_ISSUES: readonly DetailPreviewRow['issues'][number][] = [
  'cell-skipped',
  'currency-unconfirmed',
  'member-skipped',
];

export interface DetailStep4PreviewProps {
  preview: PreviewDetailImportResult | null;
  draft: DetailImportDraft;
  /** 반영 결과. null이면 아직 반영 전이다 */
  committed: CommitDetailImportResult | null;
  /** 사용자 결정이 이 미리보기에 아직 반영되지 않았는가 */
  dirty: boolean;
  busy: boolean;
  /** Step 3(성명 매핑)이 있는 흐름인가 — 오류 안내의 링크 대상이 달라진다 */
  hasPersonnel: boolean;
  onRecheck: () => void;
  /** D-15 [기존 삭제 후 교체] */
  onToggleReplace: (category: BudgetCategory, replace: boolean) => void;
  /** D-21 ② 행 포함·제외 */
  onRowDecision: (rowKey: string, decision: DetailRowDecision) => void;
  /** D-9 축 재지정. `undefined`면 파서의 제안으로 되돌린다 */
  onAxisOverride: (rowKey: string, axis: DetailAxis | undefined) => void;
  /** D-10 통화 확인 (Step 2와 같은 결정이며 여기서도 풀 수 있다) */
  onCurrencyConfirm: (blockKey: string, confirmed: boolean) => void;
  onGoToStep: (step: 2 | 3) => void;
}

export default function DetailStep4Preview({
  preview,
  draft,
  committed,
  dirty,
  busy,
  hasPersonnel,
  onRecheck,
  onToggleReplace,
  onRowDecision,
  onAxisOverride,
  onCurrencyConfirm,
  onGoToStep,
}: DetailStep4PreviewProps) {
  const groups = useMemo(() => buildGroups(preview), [preview]);

  if (preview === null) {
    return (
      <p className="rounded-xl border border-dashed border-grey-300 p-6 text-center text-sm text-grey-400">
        미리보기를 불러오는 중입니다.
      </p>
    );
  }

  const { summary } = preview;
  const mismatched = preview.subtotals.filter((check) => !check.matches);
  const unconfirmedCurrency = preview.blocks.filter(
    (block) => block.currency !== null && !block.currencyConfirmed
  );

  return (
    <div className="space-y-4">
      {/* 상단 요약 6종 (§7.9.3 Step 4) */}
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5 rounded-xl border border-grey-200 bg-grey-50 px-3 py-2 text-xs">
        <span className="text-green-700">
          신규 <strong>{summary.new}</strong>행
        </span>
        <span className="text-grey-500">
          건너뜀 <strong>{summary.skipped}</strong>행
        </span>
        <span className={summary.error > 0 ? 'font-semibold text-red-700' : 'text-grey-500'}>
          오류 <strong>{summary.error}</strong>행
        </span>
        <span className="text-blue-700">
          새로 만들 인력 <strong>{summary.newMembers}</strong>명
        </span>
        <span className="text-blue-700">
          교체할 셀 <strong>{summary.replaceCells}</strong>개
        </span>
        <span className="ml-auto font-semibold text-grey-700">
          합계 {won(summary.totalAmount)}
        </span>
      </div>

      {committed !== null && <CommitResult result={committed} />}

      {dirty && committed === null && (
        <div className="flex flex-wrap items-center gap-3 rounded-xl border border-orange-300 bg-orange-50 px-3 py-2 text-xs text-orange-900">
          <span>
            바꾼 내용(교체·행 포함·통화 확인)이 아직 이 미리보기에 반영되지 않았습니다. 확인하기 전에는
            반영할 수 없습니다.
          </span>
          <Button size="sm" variant="secondary" disabled={busy} onClick={onRecheck} className="ml-auto">
            다시 확인
          </Button>
        </div>
      )}

      {summary.error > 0 && committed === null && (
        <div className="rounded-xl border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700">
          <p className="font-semibold">오류 {summary.error}건이 있어 반영할 수 없습니다.</p>
          <p className="mt-1">
            해당 행의 <strong>[반영]</strong> 체크를 풀어 제외하거나, 세목·성명 지정을 마치세요.{' '}
            <strong>셀 값의 인라인 수정은 지원하지 않습니다</strong> — 원본 엑셀에서 고쳐 다시 올리세요.
          </p>
          <div className="mt-2 flex flex-wrap gap-2">
            <Button size="sm" variant="secondary" onClick={() => onGoToStep(2)}>
              Step 2 시트 · 구조로
            </Button>
            {hasPersonnel && (
              <Button size="sm" variant="secondary" onClick={() => onGoToStep(3)}>
                Step 3 성명 매핑으로
              </Button>
            )}
          </div>
        </div>
      )}

      {/* D-10: 확인하지 않은 표는 반영 대상이 아니다. 여기서도 풀 수 있게 둔다 */}
      {unconfirmedCurrency.length > 0 && committed === null && (
        <div className="rounded-xl border border-orange-300 bg-orange-50 px-3 py-2 text-xs text-orange-900">
          <p className="font-semibold">
            ⚠️ 원화가 아닌 통화 기호가 감지된 표 {unconfirmedCurrency.length}개는 확인 전까지 반영되지
            않습니다 (D-10). 환율을 앱이 지어내지 않습니다.
          </p>
          <ul className="mt-1 space-y-1">
            {unconfirmedCurrency.map((block) => (
              <li key={block.key}>
                <label className="flex cursor-pointer items-center gap-2">
                  <input
                    type="checkbox"
                    checked={false}
                    disabled={busy}
                    onChange={() => onCurrencyConfirm(block.key, true)}
                  />
                  {block.categoryLabel} · {blockLabel(block)} — {block.currency?.symbol} 표기 (
                  {(block.currency?.row ?? 0) + 1}행 {block.currency?.column}열)의 금액이 원화임을
                  확인했습니다
                </label>
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* D-18: 파일 소계와 우리 합계의 차이. 어느 쪽이 맞는지는 사람이 안다 — 반영을 막지 않는다 */}
      {mismatched.length > 0 && (
        <p className="rounded-lg border border-orange-200 bg-orange-50 px-3 py-2 text-[11px] text-orange-900">
          소계가 어긋나는 표가 {mismatched.length}건 있습니다 (D-18). 파일의 소계가 수식 오류이거나
          손으로 덮어쓴 값일 수 있어 <strong>반영은 막지 않습니다</strong> — 아래 세목별 경고에서 양쪽
          값을 확인하세요.
        </p>
      )}

      <div className="space-y-3">
        {groups.map((group) => (
          <CategoryCard
            key={group.category}
            group={group}
            replace={(draft.replaceCategories ?? []).includes(group.category)}
            rowDecisions={draft.rowDecisions ?? {}}
            axisOverrides={draft.axisOverrides ?? {}}
            busy={busy || committed !== null}
            onToggleReplace={onToggleReplace}
            onRowDecision={onRowDecision}
            onAxisOverride={onAxisOverride}
            onCurrencyConfirm={onCurrencyConfirm}
          />
        ))}
        {groups.length === 0 && (
          <p className="rounded-xl border border-dashed border-grey-300 p-6 text-center text-sm text-grey-400">
            반영 예정 내역이 없습니다.
          </p>
        )}
      </div>

      <p className="text-[11px] text-grey-400">
        반영 직전의 계획액과 삭제되는 산출근거 행은 스냅샷으로 저장되어 설정 화면에서 되돌릴 수
        있습니다 (D-17). 파일: {preview.fileName} · 시트: {preview.sheetName}
      </p>
    </div>
  );
}

/** 반영 결과. D-15a는 오류가 아니지만 **반드시 드러낸다** */
function CommitResult({ result }: { result: CommitDetailImportResult }) {
  return (
    <div className="rounded-xl border border-green-300 bg-green-50 px-3 py-2 text-xs text-green-900">
      <p className="font-semibold">
        ✅ 산출근거를 반영했습니다 — 신규 {result.inserted}행 · 삭제 {result.deleted}행 · 새 인력{' '}
        {result.membersCreated}명 · 총액 재계산 {result.cells}셀
      </p>
      {result.skippedLocked > 0 && (
        <p className="mt-1 rounded-lg border border-orange-300 bg-orange-100 px-2 py-1.5 text-orange-900">
          ⚠️ 건너뜀(반영 중 추가됨) <strong>{result.skippedLocked}셀</strong> — 미리보기 이후 그 셀에
          산출근거가 생겨 덮지 않고 건너뛰었습니다 (D-15a). 그 비목을 넣으려면 [기존 삭제 후 교체]를
          고른 뒤 다시 가져오세요.
        </p>
      )}
      <p className="mt-1">
        되돌리려면 설정 &gt; 백업·복원의 임포트 스냅샷을 사용하세요 (D-17). 복원은 산출근거 행을
        되돌리지만 <strong>임포트가 만든 인력은 남습니다</strong> (D-17b).
      </p>
    </div>
  );
}

// ─── 비목 → 세목 → 행 ────────────────────────────────────────

interface BlockGroup {
  key: string;
  block: DetailPreviewBlock | null;
  rows: DetailPreviewRow[];
  amount: number;
  subtotals: DetailSubtotalCheck[];
}

interface CategoryGroup {
  category: BudgetCategory;
  label: string;
  cell: DetailPreviewCell | null;
  blocks: BlockGroup[];
  /** 데이터 행이 없는 표. 조용히 숨기지 않는다 (절대 규칙 5) */
  emptyBlocks: DetailPreviewBlock[];
}

/**
 * 미리보기를 §7.9.3 Step 4의 트리로 접는다. **판정은 하지 않는다** — 서버가 준 행·셀·블록을
 * 파일 순서대로 묶고 금액을 더할 뿐이다.
 *
 * 세목 층은 `blockKey`(표 하나)로 나눈다. 같은 세목이 여러 표로 오는 서식(`⑤ 출장비`)이 있고,
 * D-10 통화 확인과 D-18 소계 대조가 붙는 단위도 표이기 때문이다.
 */
function buildGroups(preview: PreviewDetailImportResult | null): CategoryGroup[] {
  if (preview === null) return [];

  const rowsByBlock = new Map<string, DetailPreviewRow[]>();
  for (const row of preview.rows) {
    const bucket = rowsByBlock.get(row.blockKey);
    if (bucket) bucket.push(row);
    else rowsByBlock.set(row.blockKey, [row]);
  }

  const subtotalsByBlock = new Map<string, DetailSubtotalCheck[]>();
  for (const check of preview.subtotals) {
    if (check.matches) continue;
    const bucket = subtotalsByBlock.get(check.blockKey);
    if (bucket) bucket.push(check);
    else subtotalsByBlock.set(check.blockKey, [check]);
  }

  const groups = new Map<BudgetCategory, CategoryGroup>();
  const groupOf = (category: BudgetCategory): CategoryGroup => {
    let group = groups.get(category);
    if (group === undefined) {
      group = {
        category,
        label: BUDGET_CATEGORY_LABELS[category],
        cell: preview.cells.find((cell) => cell.category === category) ?? null,
        blocks: [],
        emptyBlocks: [],
      };
      groups.set(category, group);
    }
    return group;
  };

  for (const block of preview.blocks) {
    const group = groupOf(block.category);
    const rows = rowsByBlock.get(block.key) ?? [];
    if (rows.length === 0) {
      group.emptyBlocks.push(block);
      continue;
    }
    group.blocks.push({
      key: block.key,
      block,
      rows,
      amount: rows.reduce((sum, row) => sum + (row.status === 'new' ? row.amount : 0), 0),
      subtotals: subtotalsByBlock.get(block.key) ?? [],
    });
  }

  // 파일에 표가 없는데 교체로 지정된 비목(D-15b 오류 셀)도 드러난다
  for (const cell of preview.cells) groupOf(cell.category);

  return [...groups.values()];
}

function CategoryCard({
  group,
  replace,
  rowDecisions,
  axisOverrides,
  busy,
  onToggleReplace,
  onRowDecision,
  onAxisOverride,
  onCurrencyConfirm,
}: {
  group: CategoryGroup;
  replace: boolean;
  rowDecisions: Record<string, DetailRowDecision>;
  axisOverrides: Record<string, DetailAxis>;
  busy: boolean;
  onToggleReplace: (category: BudgetCategory, replace: boolean) => void;
  onRowDecision: (rowKey: string, decision: DetailRowDecision) => void;
  onAxisOverride: (rowKey: string, axis: DetailAxis | undefined) => void;
  onCurrencyConfirm: (blockKey: string, confirmed: boolean) => void;
}) {
  const cell = group.cell;
  const rowCount = group.blocks.reduce((sum, block) => sum + block.rows.length, 0);

  return (
    <section
      className={`rounded-xl border ${
        cell?.status === 'error' ? 'border-red-300' : 'border-grey-200'
      }`}
    >
      <header className="flex flex-wrap items-center gap-2 border-b border-grey-200 bg-grey-50 px-3 py-2 text-xs">
        <span className="text-sm font-semibold text-grey-800">{group.label}</span>
        {cell && <Badge tone={CELL_STATUS_TONE[cell.status]}>{CELL_STATUS_LABEL[cell.status]}</Badge>}
        {/* D-15: 기존 산출근거가 있는 셀은 기본 건너뜀이다 */}
        {cell !== null && cell.existingRows > 0 && (
          <Badge tone="amber">기존 {cell.existingRows}행 있음</Badge>
        )}
        <span className="text-grey-500">
          표 {group.blocks.length}개 · 행 {rowCount}개
        </span>
        <span className="ml-auto font-semibold text-grey-700">
          반영 {cell?.rowCount ?? 0}행 · {won(cell?.amount ?? 0)}
        </span>
      </header>

      {/* D-15: 조용히 덮지 않는다. 기본 꺼짐이며 켜야만 교체한다 */}
      {cell !== null && (cell.existingRows > 0 || replace) && (
        <label className="flex cursor-pointer flex-wrap items-center gap-2 border-b border-grey-100 bg-orange-50 px-3 py-2 text-xs text-orange-900">
          <input
            type="checkbox"
            checked={replace}
            disabled={busy}
            onChange={(e) => onToggleReplace(group.category, e.target.checked)}
          />
          <span className="font-semibold">[기존 삭제 후 교체]</span>
          <span>
            체크하면 이 비목의 기존 {cell.existingRows}행을 전부 지우고 파일 내용으로 바꿉니다. 부분
            병합은 없습니다 (D-15).
          </span>
        </label>
      )}

      {cell?.reason && (
        <p
          className={`border-b border-grey-100 px-3 py-1.5 text-[11px] ${
            cell.status === 'error' ? 'bg-red-50 font-semibold text-red-700' : 'text-grey-500'
          }`}
        >
          {cell.reason}
        </p>
      )}

      <div className="divide-y divide-grey-100">
        {group.blocks.map((block) => (
          <BlockSection
            key={block.key}
            group={block}
            rowDecisions={rowDecisions}
            axisOverrides={axisOverrides}
            busy={busy}
            onRowDecision={onRowDecision}
            onAxisOverride={onAxisOverride}
            onCurrencyConfirm={onCurrencyConfirm}
          />
        ))}
        {group.blocks.length === 0 && (
          <p className="px-3 py-3 text-xs text-grey-400">이 비목에서 반영할 행을 찾지 못했습니다.</p>
        )}
      </div>

      {group.emptyBlocks.length > 0 && (
        <p className="border-t border-grey-100 px-3 py-1.5 text-[11px] text-grey-400">
          데이터 행이 없는 표 {group.emptyBlocks.length}개:{' '}
          {group.emptyBlocks.map((block) => blockLabel(block)).join(', ')}
        </p>
      )}
    </section>
  );
}

function BlockSection({
  group,
  rowDecisions,
  axisOverrides,
  busy,
  onRowDecision,
  onAxisOverride,
  onCurrencyConfirm,
}: {
  group: BlockGroup;
  rowDecisions: Record<string, DetailRowDecision>;
  axisOverrides: Record<string, DetailAxis>;
  busy: boolean;
  onRowDecision: (rowKey: string, decision: DetailRowDecision) => void;
  onAxisOverride: (rowKey: string, axis: DetailAxis | undefined) => void;
  onCurrencyConfirm: (blockKey: string, confirmed: boolean) => void;
}) {
  const block = group.block;
  const currency = block?.currency ?? null;
  const confirmed = block?.currencyConfirmed ?? true;

  return (
    <div className="px-3 py-3">
      <div className="flex flex-wrap items-baseline gap-2 text-xs">
        <span className="font-semibold text-grey-700">
          {block === null ? '(표 정보 없음)' : blockLabel(block)}
        </span>
        {block?.needsConfirm && <Badge tone="amber">세목 확인 필요</Badge>}
        <span className="ml-auto text-grey-500">
          행 {group.rows.length}개 · 반영 금액 {won(group.amount)}
        </span>
      </div>

      {/* D-10: 확인해야 반영 대상에 들어간다 */}
      {currency !== null && (
        <label
          className={`mt-2 flex cursor-pointer items-center gap-2 rounded-lg border px-2 py-1.5 text-[11px] font-semibold ${
            confirmed
              ? 'border-green-200 bg-green-50 text-green-800'
              : 'border-orange-300 bg-orange-100 text-orange-900'
          }`}
        >
          <input
            type="checkbox"
            checked={confirmed}
            disabled={busy}
            onChange={(e) => onCurrencyConfirm(group.key, e.target.checked)}
          />
          이 표의 금액이 원화임을 확인했습니다 ({currency.symbol} 표기 — {currency.row + 1}행{' '}
          {currency.column}열 &quot;{currency.text}&quot;)
        </label>
      )}

      {/* D-18: 양쪽 값을 나란히. 경고이며 반영을 막지 않는다 */}
      {group.subtotals.length > 0 && (
        <ul className="mt-2 space-y-1">
          {group.subtotals.map((check) => (
            <li
              key={`${check.row}:${check.column}:${check.axis}`}
              className="rounded bg-orange-50 px-2 py-1 text-[11px] text-orange-900"
            >
              ⚠️ 소계 불일치 ({check.row + 1}행 {check.column}열 · {axisLabel(check.axis)}) — 파일{' '}
              <strong>{won(check.fileValue)}</strong> / 우리 합계{' '}
              <strong>{won(check.ourSum)}</strong> (차 {signed(check.difference)}원). 반영은 막지
              않습니다 (D-18).
            </li>
          ))}
        </ul>
      )}

      <div className="mt-2 overflow-x-auto rounded-lg border border-grey-200">
        <table className="w-full text-[11px]">
          <thead className="bg-grey-50 text-grey-500">
            <tr>
              <th className="w-14 px-2 py-1.5 text-left">반영</th>
              <th className="w-16 px-2 py-1.5 text-left">상태</th>
              <th className="px-2 py-1.5 text-left">품명 · 성명</th>
              <th className="px-2 py-1.5 text-left">근거</th>
              <th className="w-20 px-2 py-1.5 text-left">축</th>
              <th className="w-40 px-2 py-1.5 text-right">금액</th>
              <th className="px-2 py-1.5 text-left">비고 · 사유</th>
            </tr>
          </thead>
          <tbody>
            {group.rows.map((row) => (
              <PreviewRow
                key={row.key}
                row={row}
                decision={rowDecisions[row.key]}
                axisOverride={axisOverrides[row.key]}
                busy={busy}
                onRowDecision={onRowDecision}
                onAxisOverride={onAxisOverride}
              />
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function PreviewRow({
  row,
  decision,
  axisOverride,
  busy,
  onRowDecision,
  onAxisOverride,
}: {
  row: DetailPreviewRow;
  decision: DetailRowDecision | undefined;
  axisOverride: DetailAxis | undefined;
  busy: boolean;
  onRowDecision: (rowKey: string, decision: DetailRowDecision) => void;
  onAxisOverride: (rowKey: string, axis: DetailAxis | undefined) => void;
}) {
  // 셀·통화·성명 때문에 빠진 행은 여기서 되살릴 수 없다 — 그 결정은 다른 자리에 있다
  const locked = row.issues.some((issue) => ROW_LOCKED_ISSUES.includes(issue));
  const included = decision !== undefined ? decision === 'include' : row.status !== 'skipped';
  const evidence = evidenceOf(row);
  // D-9: 미리보기를 다시 돌리기 전에도 사용자가 고른 축을 그대로 보여 준다 (반영 체크와 같은 규약)
  const axis = axisOverride ?? row.axis;
  const axisOverridden = axis !== row.axisAuto;

  return (
    <tr className={`border-t border-grey-100 ${row.status === 'skipped' ? 'text-grey-400' : ''}`}>
      <td className="px-2 py-1.5">
        <label className="flex cursor-pointer items-center gap-1.5">
          <input
            type="checkbox"
            checked={included && !locked}
            disabled={busy || locked}
            aria-label={`${row.sourceRow + 1}행 반영`}
            onChange={(e) => onRowDecision(row.key, e.target.checked ? 'include' : 'skip')}
          />
        </label>
      </td>
      <td className="px-2 py-1.5">
        <span className={`rounded px-1.5 py-0.5 font-semibold ${ROW_STATUS_CLASS[row.status]}`}>
          {row.statusLabel}
        </span>
      </td>
      <td className="max-w-[14rem] px-2 py-1.5">
        <span className="block truncate text-grey-700" title={row.memberName ?? row.name}>
          {row.memberName ?? (row.name || '(이름 없음)')}
        </span>
        <span className="text-[10px] text-grey-400">원본 {row.sourceRow + 1}행</span>
      </td>
      <td className="max-w-[16rem] px-2 py-1.5 text-grey-600">
        <span className="block truncate" title={`${evidence} ${row.spec}`.trim()}>
          {evidence || '—'}
        </span>
        {row.spec && (
          <span className="block truncate text-[10px] text-grey-400" title={row.spec}>
            {row.spec}
          </span>
        )}
      </td>
      <td className="px-2 py-1.5 text-grey-600">
        {/* D-9: 합계 열만 있는 행은 축이 **제안**이다 — 자동 확정하지 않고 사용자가 바꿀 수 있다.
            파일이 현금·현물을 명시해 행이 갈린 경우는 바꿀 대상이 아니라 라벨로만 둔다 */}
        {row.axisSuggested ? (
          <select
            value={axis}
            disabled={busy}
            aria-label={`${row.sourceRow + 1}행 축`}
            title={
              axisOverridden
                ? '사용자가 지정한 축입니다 (D-9)'
                : '합계 열만 있어 현금으로 제안했습니다. 바꿀 수 있습니다 (D-9)'
            }
            // 자동 제안과 같은 값을 고르면 재지정을 지운다 — 바꾸지 않은 것을 파랑으로 남기면
            // 무엇을 손댔는지 알 수 없다 (D-7 컬럼 재지정과 같은 규약)
            onChange={(e) => {
              const picked = e.target.value as DetailAxis;
              onAxisOverride(row.key, picked === row.axisAuto ? undefined : picked);
            }}
            className={`rounded border px-1 py-0.5 ${
              axisOverridden
                ? 'border-blue-400 font-semibold text-blue-700'
                : 'border-grey-200 text-grey-500'
            }`}
          >
            {AXIS_OPTIONS.map(([value, label]) => (
              <option key={value} value={value}>
                {label}
                {value === row.axisAuto ? ' (제안)' : ''}
              </option>
            ))}
          </select>
        ) : (
          DETAIL_AXIS_LABELS[row.axis]
        )}
      </td>
      <td className="px-2 py-1.5 text-right tabular-nums">
        <span className="font-medium text-grey-800">{won(row.amount)}</span>
        {/* D-8: 조정액으로 흡수했음을 드러낸다. 조용히 넣지 않는다 */}
        {row.absorbed && (
          <span
            className="mt-0.5 block text-[10px] text-orange-700"
            title="파일의 합계 열이 진실이므로 산식과의 차액을 조정액으로 흡수했습니다 (D-8)"
          >
            계산 {row.formulaAmount.toLocaleString('ko-KR')} → 파일{' '}
            {row.fileAmount.toLocaleString('ko-KR')} (조정 {signed(row.adjustment)})
          </span>
        )}
      </td>
      <td className="max-w-[20rem] px-2 py-1.5">
        {row.note && (
          <span className="block truncate text-grey-500" title={row.note}>
            {row.note}
          </span>
        )}
        {row.reason && (
          <span
            className={`block truncate ${
              row.status === 'error' ? 'font-semibold text-red-700' : 'text-grey-500'
            }`}
            title={row.reason}
          >
            {row.reason}
          </span>
        )}
      </td>
    </tr>
  );
}

// ─── 표시 헬퍼 ───────────────────────────────────────────────

function won(value: number): string {
  return `${value.toLocaleString('ko-KR')}원`;
}

function signed(value: number): string {
  // 부호를 유니코드 마이너스로 통일한다 — 하이픈은 좁아서 음수가 눈에 안 띈다
  return `${value < 0 ? '−' : '+'}${Math.abs(value).toLocaleString('ko-KR')}`;
}

function axisLabel(axis: DetailSubtotalCheck['axis']): string {
  return axis === 'total' ? '합계' : DETAIL_AXIS_LABELS[axis];
}

/** 세목 표시. 시트의 세목 헤더가 없으면(D-3a) 프리셋 라벨로 대신한다 */
function blockLabel(block: DetailPreviewBlock): string {
  if (block.subcategoryLabel) return block.subcategoryLabel;
  if (block.subcategory === null) return '(세목 미정)';
  const preset = subcategoryOptions(block.category).find(
    (option) => option.code === block.subcategory
  );
  return preset?.label ?? block.subcategory;
}

/** 근거 필드 — PL-1/PL-3의 입력이다. 금액은 서버가 계산했고 여기서는 재료만 보여 준다 */
function evidenceOf(row: DetailPreviewRow): string {
  const parts: string[] = [];
  if (row.unitPrice !== 0) parts.push(`단가 ${row.unitPrice.toLocaleString('ko-KR')}`);
  for (const factor of row.factors) {
    parts.push(`${factor.label} ${factor.value.toLocaleString('ko-KR')}${factor.isPercent ? '%' : ''}`);
  }
  return parts.join(' × ');
}
