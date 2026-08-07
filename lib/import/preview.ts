// ParsedRow[] + 기존 BudgetItem → 미리보기 (SOT §7.9.1 Step 5, §9 previewImport, S-8·S-9).
// 부수효과 없는 순수 함수다. 단위 테스트: tests/unit/import-preview.test.ts

import { BUDGET_CATEGORY_ORDER } from '@/lib/constants';
import type {
  BudgetCategory,
  BudgetItem,
  ImportPreview,
  ImportSummary,
  PreviewRow,
  PreviewRowStatus,
  PreviewSourceRow,
  UntouchedCategory,
} from '@/types';
import type { ParsedRow } from './matrix';
import type { CategorySource } from './types';

export const PREVIEW_STATUS_LABELS: Record<PreviewRowStatus, string> = {
  new: '신규',
  overwrite: '덮어씀',
  skipped: '건너뜀',
  locked: '잠김',   // S-14: 산출근거가 있어 덮어쓸 수 없는 셀. 건너뜀과 섞지 않는다
  error: '오류',
};

/**
 * S-14 잠김 행에 붙이는 안내. 라벨과 함께 화면 두 곳(테이블 비고, Step 5 안내 상자)이
 * 쓰므로 문장을 여기 한 곳에만 둔다 — 복사하면 반드시 어긋난다.
 */
export const LOCKED_ROW_GUIDE =
  '산출근거가 있어 덮어쓰지 않습니다. 풀려면 연구비 화면에서 산출근거를 먼저 지우세요.';

/**
 * 기존 계획액 비교 대상. BudgetItem을 그대로 대입할 수 있는 최소 형태.
 * `detailCount`는 S-14 잠금 판정에 쓴다 — 리포지토리가 조회 시 채워 준다 (§5.12).
 */
export type ExistingBudgetItem = Pick<
  BudgetItem,
  'yearId' | 'category' | 'plannedAmount' | 'cashAmount' | 'inKindAmount' | 'detailCount'
>;

export interface BuildPreviewInput {
  rows: readonly ParsedRow[];
  /** yearOrder → yearId. ImportDraft.yearMapping을 order로 푼 것 (S-5) */
  yearIdByOrder: Readonly<Record<number, string>>;
  existingItems: readonly ExistingBudgetItem[];
}

interface Bucket {
  yearOrder: number;
  category: BudgetCategory;
  cash: number;
  inKind: number;
  unassigned: number;
  /** S-4: 축 분리 행(현금/현물)이 하나라도 있었는가 */
  hasAxisSplit: boolean;
  sourceRowIndexes: number[];
  rounded: boolean;
  /**
   * 이 버킷에 기여한 **원본 행별** 라벨·판정 근거 (S-8이면 여러 개, 등장 순서).
   * 마법사 Step 4는 원본 행 단위로 드롭다운·건너뛰기를 달아야 해서 합친 라벨 하나로는 부족하다.
   */
  sourceRows: PreviewSourceRow[];
}

const categoryRank = new Map<BudgetCategory, number>(
  BUDGET_CATEGORY_ORDER.map((category, index) => [category, index])
);

function makeRow(status: PreviewRowStatus, patch: Partial<PreviewRow>): PreviewRow {
  return {
    status,
    statusLabel: PREVIEW_STATUS_LABELS[status],
    yearId: null,
    yearOrder: null,
    category: null,
    plannedAmount: null,
    cashAmount: null,
    inKindAmount: null,
    existing: null,
    sourceRowIndexes: [],
    reason: null,
    label: null,
    categorySource: null,
    sourceRows: [],
    rounded: false,
    ...patch,
  };
}

// S-8로 여러 원본 행이 한 버킷에 합쳐지면 판정 근거가 섞인다. 그때는 **가장 확인이 필요한
// 근거**를 대표로 내보낸다 — 완전일치 하나가 섞였다고 ✅로 보여 주면, 같은 셀에 합산된
// 별칭·승계 행을 사용자가 확인 없이 지나친다.
const SOURCE_ATTENTION: Record<CategorySource, number> = {
  exact: 0,
  manual: 1,
  'alias-draft': 2,
  'alias-ministry': 3,
  'alias-common': 4,
  combined: 5,
  inherited: 6,
};

function pickSource(sourceRows: readonly PreviewSourceRow[]): CategorySource | null {
  const sources = sourceRows
    .map((s) => s.categorySource)
    .filter((s): s is CategorySource => s !== null);
  if (sources.length === 0) return null;
  return sources.reduce((worst, s) =>
    SOURCE_ATTENTION[s] > SOURCE_ATTENTION[worst] ? s : worst
  );
}

function joinLabels(sourceRows: readonly PreviewSourceRow[]): string | null {
  const labels: string[] = [];
  for (const s of sourceRows) {
    if (s.label !== null && !labels.includes(s.label)) labels.push(s.label);
  }
  return labels.length > 0 ? labels.join(' · ') : null;
}

function rowLabel(row: ParsedRow): string | null {
  if (row.matchedLabel) return row.matchedLabel;
  const last = row.labels.filter((l) => l !== '').at(-1);
  return last ?? null;
}

/**
 * 미리보기 조립.
 *
 * - S-8: 같은 (연차, 비목)에 매핑된 행들을 **축별로 합산**해 한 행으로 만든다
 * - S-4: 축 분리 행이 하나도 없으면 `cashAmount`/`inKindAmount`는 null이고 `plannedAmount`만 채운다.
 *   `unassigned`(`일반`/`통합관리`)는 `plannedAmount`에만 더한다
 * - I-12: 오류 셀이 있는 행은 별도의 `오류` 행으로 남기고 반영을 막는다. **스킵 행의 오류 셀은
 *   반영 대상이 아니므로 오류로 세지 않는다** (부록 B.5의 8·10행 주석)
 * - S-9: 파일에 등장하지 않은 (연차, 비목)은 건드리지 않고 `untouchedCategories`로 보고한다
 * - S-14: 대상 셀에 산출근거가 있으면(`detailCount > 0`) `잠김`으로 남기고 반영 대상에서 뺀다.
 *   총액으로 덮으면 근거와 합계가 소리 없이 어긋나기 때문이다. 오류가 아니므로 `blocked`는 아니다
 */
export function buildPreview(input: BuildPreviewInput): ImportPreview {
  const { rows, yearIdByOrder, existingItems } = input;

  const buckets = new Map<string, Bucket>();
  const skippedRows: PreviewRow[] = [];
  const errorRows: PreviewRow[] = [];
  const unmappedYearOrders = new Set<number>();
  let skippedAmount = 0;

  for (const row of rows) {
    if (row.status === 'skipped') {
      let sum = 0;
      let ignoredErrors = 0;
      for (const cell of row.amounts) {
        if (cell.error) ignoredErrors += 1;
        else sum += cell.amount ?? 0;
      }
      skippedAmount += sum;
      skippedRows.push(
        makeRow('skipped', {
          sourceRowIndexes: [row.rowIndex],
          reason:
            ignoredErrors > 0
              ? `${row.reason ?? '건너뜀'} (오류 셀 ${ignoredErrors}개는 반영 대상이 아니라 집계에서 제외)`
              : row.reason,
          label: rowLabel(row),
          categorySource: row.categorySource,
          sourceRows: [
            { rowIndex: row.rowIndex, label: rowLabel(row), categorySource: row.categorySource },
          ],
        })
      );
      continue;
    }

    if (row.status !== 'mapped') {
      // I-4/I-6/I-3: 사용자가 지정하거나 건너뛰기로 제외해야 반영 가능하다 → 오류로 막는다
      errorRows.push(
        makeRow('error', {
          sourceRowIndexes: [row.rowIndex],
          reason: row.reason,
          label: rowLabel(row),
          categorySource: row.categorySource,
          sourceRows: [
            { rowIndex: row.rowIndex, label: rowLabel(row), categorySource: row.categorySource },
          ],
        })
      );
      continue;
    }

    const failed = row.amounts.filter((cell) => cell.error !== null);
    if (failed.length > 0) {
      errorRows.push(
        makeRow('error', {
          category: row.category,
          sourceRowIndexes: [row.rowIndex],
          reason: failed
            .map((cell) => `${cell.column}열: ${cell.error?.message ?? '파싱 실패'}`)
            .join(' / '),
          label: rowLabel(row),
          categorySource: row.categorySource,
          sourceRows: [
            { rowIndex: row.rowIndex, label: rowLabel(row), categorySource: row.categorySource },
          ],
        })
      );
    }

    // 오류 셀이 있어도 정상 파싱된 셀은 그대로 집계한다 — 미리보기에 보여야 할 값이고,
    // 반영 자체는 blocked로 막힌다 (부록 B.5: 7행이 오류여도 1차년도 activity는 8,000,000)
    for (const cell of row.amounts) {
      if (cell.error) continue;
      if (!(cell.yearOrder in yearIdByOrder)) unmappedYearOrders.add(cell.yearOrder);
      const amount = cell.amount ?? 0;
      const key = `${cell.yearOrder}|${row.category}`;
      let bucket = buckets.get(key);
      if (!bucket) {
        bucket = {
          yearOrder: cell.yearOrder,
          category: row.category!,
          cash: 0,
          inKind: 0,
          unassigned: 0,
          hasAxisSplit: false,
          sourceRowIndexes: [],
          rounded: false,
          sourceRows: [],
        };
        buckets.set(key, bucket);
      }
      if (!bucket.sourceRows.some((s) => s.rowIndex === row.rowIndex)) {
        bucket.sourceRows.push({
          rowIndex: row.rowIndex,
          label: rowLabel(row),
          categorySource: row.categorySource,
        });
      }
      if (row.axis === 'cash') {
        bucket.cash += amount;
        bucket.hasAxisSplit = true;
      } else if (row.axis === 'inKind') {
        bucket.inKind += amount;
        bucket.hasAxisSplit = true;
      } else {
        bucket.unassigned += amount;
      }
      if (cell.rounded) bucket.rounded = true;
      if (!bucket.sourceRowIndexes.includes(row.rowIndex)) {
        bucket.sourceRowIndexes.push(row.rowIndex);
      }
    }
  }

  // 기존 값 색인
  const existingByKey = new Map<string, ExistingBudgetItem>();
  for (const item of existingItems) {
    existingByKey.set(`${item.yearId}|${item.category}`, item);
  }

  const orderByYearId = new Map<string, number>();
  for (const [order, yearId] of Object.entries(yearIdByOrder)) {
    orderByYearId.set(yearId, Number(order));
  }

  const mappedRows: PreviewRow[] = [];
  const lockedRows: PreviewRow[] = [];
  const touched = new Set<string>();

  const sortedBuckets = [...buckets.values()].sort(
    (a, b) =>
      a.yearOrder - b.yearOrder ||
      (categoryRank.get(a.category) ?? 99) - (categoryRank.get(b.category) ?? 99)
  );

  for (const bucket of sortedBuckets) {
    const yearId = yearIdByOrder[bucket.yearOrder] ?? null;
    const planned = bucket.cash + bucket.inKind + bucket.unassigned;
    const cash = bucket.hasAxisSplit ? bucket.cash : null;
    const inKind = bucket.hasAxisSplit ? bucket.inKind : null;

    const existing = yearId ? (existingByKey.get(`${yearId}|${bucket.category}`) ?? null) : null;
    // 잠긴 셀도 "파일에 등장한" 조합이다 — S-9의 "이 파일에 없는 비목" 목록에 넣으면
    // 사용자에게 거짓말이 된다. 유지된다는 사실은 `잠김` 행이 따로 알린다
    if (yearId) touched.add(`${yearId}|${bucket.category}`);

    // S-14: 산출근거가 있는 셀은 계획액의 소유권이 내역에 있다(PL-9). 신규/덮어씀 판정보다
    // **먼저** 본다 — 덮어쓸 값이 있느냐 없느냐와 무관하게 임포트가 손댈 수 없는 셀이다.
    //
    // 사용자가 Step 4에서 명시적으로 `건너뛰기`한 원본 행은 여기까지 오지 않는다(위 루프에서
    // `skipped`로 빠진다). 즉 **사용자의 선택이 잠금보다 앞선다** — 잠금은 시스템이 대신 막아
    // 주는 것이고, 건너뛰기는 사람이 내린 결정이라 그 결정을 화면에서 지워 버리면 안 된다.
    // (두 행이 같은 셀에 걸리면 건너뛴 행은 `건너뜀`으로, 남은 행이 만든 셀은 `잠김`으로 보인다)
    if (existing !== null && existing.detailCount > 0) {
      lockedRows.push(
        makeRow('locked', {
          yearId,
          yearOrder: bucket.yearOrder,
          category: bucket.category,
          // 반영 대상이 아니므로 금액은 비운다. 무시되는 파일 값은 사유에 남긴다 (절대 규칙 5)
          plannedAmount: null,
          cashAmount: null,
          inKindAmount: null,
          existing: {
            plannedAmount: existing.plannedAmount,
            cashAmount: existing.cashAmount,
            inKindAmount: existing.inKindAmount,
          },
          sourceRowIndexes: [...bucket.sourceRowIndexes].sort((a, b) => a - b),
          rounded: bucket.rounded,
          reason: `${LOCKED_ROW_GUIDE} (산출근거 ${existing.detailCount}건 · 파일 값 ${planned.toLocaleString('ko-KR')}원은 반영되지 않습니다)`,
          label: joinLabels(bucket.sourceRows),
          categorySource: pickSource(bucket.sourceRows),
          sourceRows: [...bucket.sourceRows].sort((a, b) => a.rowIndex - b.rowIndex),
        })
      );
      continue;
    }

    // 연차 생성 시 12비목이 0으로 자동 생성되므로(§5.12), "값이 없는 기존 레코드"는 신규로 본다
    const isEmptyExisting =
      existing === null ||
      (existing.plannedAmount === 0 &&
        existing.cashAmount === null &&
        existing.inKindAmount === null);

    mappedRows.push(
      makeRow(isEmptyExisting ? 'new' : 'overwrite', {
        yearId,
        yearOrder: bucket.yearOrder,
        category: bucket.category,
        plannedAmount: planned,
        cashAmount: cash,
        inKindAmount: inKind,
        existing:
          !isEmptyExisting && existing
            ? {
                plannedAmount: existing.plannedAmount,
                cashAmount: existing.cashAmount,
                inKindAmount: existing.inKindAmount,
              }
            : null,
        sourceRowIndexes: [...bucket.sourceRowIndexes].sort((a, b) => a - b),
        rounded: bucket.rounded,
        // 매핑 행에도 원본 라벨과 판정 근거를 싣는다. 이게 없으면 마법사 Step 4가
        // 라벨을 미리보기 그리드(상위 30행)에서 되찾고 ✅/🔵를 classifyLabel로 다시 계산해야 한다
        // — 같은 판정이 서버와 UI 두 곳에 생긴다 (O-4).
        label: joinLabels(bucket.sourceRows),
        categorySource: pickSource(bucket.sourceRows),
        sourceRows: [...bucket.sourceRows].sort((a, b) => a.rowIndex - b.rowIndex),
      })
    );
  }

  // S-9: 반영 대상 연차 안에서 파일에 등장하지 않은 (연차, 비목)
  const targetYearIds = new Set(Object.values(yearIdByOrder));
  const untouchedCategories: UntouchedCategory[] = existingItems
    .filter(
      (item) => targetYearIds.has(item.yearId) && !touched.has(`${item.yearId}|${item.category}`)
    )
    .map((item) => ({
      yearId: item.yearId,
      yearOrder: orderByYearId.get(item.yearId) ?? null,
      category: item.category,
      plannedAmount: item.plannedAmount,
    }))
    .sort(
      (a, b) =>
        (a.yearOrder ?? 0) - (b.yearOrder ?? 0) ||
        (categoryRank.get(a.category) ?? 99) - (categoryRank.get(b.category) ?? 99)
    );

  const previewRows = [...mappedRows, ...errorRows, ...lockedRows, ...skippedRows];
  const summary: ImportSummary = {
    new: mappedRows.filter((r) => r.status === 'new').length,
    overwrite: mappedRows.filter((r) => r.status === 'overwrite').length,
    skipped: skippedRows.length,
    skippedAmount,
    // S-14: `건너뜀`과 별도로 센다 — 건너뜀은 사용자가 고를 수 있지만 잠김은 고를 수 없다
    locked: lockedRows.length,
    error: errorRows.length,
    // 잠김 행은 mappedRows에 없으므로 합계에서도 자연히 빠진다 (반영되지 않을 돈을 더하지 않는다)
    totalAmount: mappedRows.reduce((sum, r) => sum + (r.plannedAmount ?? 0), 0),
    untouchedCategories,
  };

  return {
    rows: previewRows,
    summary,
    // S-14: 잠김은 오류가 아니므로 반영을 막지 않는다. blocked에 넣지 않는다
    blocked: summary.error > 0 || unmappedYearOrders.size > 0,
    unmappedYearOrders: [...unmappedYearOrders].sort((a, b) => a - b),
  };
}
