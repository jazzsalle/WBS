// 예산계획 매트릭스 파싱 — S-1~S-13을 한 곳에서 적용해 ParsedRow[]를 만든다 (SOT §6.8.2).
// 부수효과 없는 순수 함수다. 단위 테스트: tests/unit/import-matrix.test.ts

import type { BudgetAxis } from '@/lib/constants';
import type { BudgetCategory } from '@/types';
import { parseAmountCell } from './amount';
import { classifyLabel, findFuzzyCandidate, isCarryForwardable } from './categorize';
import { buildLabelGrid, cellAt, expandMerges } from './grid';
import { columnLetterToIndex } from './normalize';
import type {
  AmountError,
  AmountUnit,
  CategorySource,
  FuzzyCandidate,
  LabelClassification,
  MatchContext,
  RawSheet,
} from './types';

export type ParsedRowStatus =
  /** 비목 확정 — 반영 대상 */
  | 'mapped'
  /** 스킵 패턴·메모 행·사용자 지정·라벨 없음 */
  | 'skipped'
  /** I-6 모호 별칭 — 사용자 선택 필요 */
  | 'ambiguous'
  /** I-3 퍼지 후보 있음 — 사용자 확인 필요 */
  | 'fuzzy'
  /** I-4 미매핑 */
  | 'unmapped';

export interface ParsedAmountCell {
  column: string;
  columnIndex: number;
  yearOrder: number;
  rawText: string;
  /** 원 단위 정수. 파싱 실패면 null */
  amount: number | null;
  /** I-11 반올림 발생 */
  rounded: boolean;
  error: AmountError | null;
}

export interface ParsedRow {
  /** 0-based 시트 행 인덱스 */
  rowIndex: number;
  /** carry-forward 적용 후의 유효 라벨 (좌→우) */
  labels: string[];
  /** 병합 확장 후 원본 라벨 (carry-forward 전) */
  rawLabels: string[];
  classifications: LabelClassification[];
  status: ParsedRowStatus;
  category: BudgetCategory | null;
  categorySource: CategorySource | null;
  /** 비목을 확정한 라벨 (미리보기 표시용) */
  matchedLabel: string | null;
  /** S-4: 가장 오른쪽 축 라벨. 없으면 null */
  axis: BudgetAxis | null;
  amounts: ParsedAmountCell[];
  /** 스킵·미매핑 사유 */
  reason: string | null;
  fuzzyCandidate: FuzzyCandidate | null;
  ambiguousCandidates: BudgetCategory[] | null;
  /** S-6 결합 상대 행 (0-based) */
  combinedWithRow: number | null;
  /** S-10 비목을 승계해 온 행 (0-based) */
  inheritedFromRow: number | null;
  /**
   * I-12: 반영을 막아야 하는 오류 셀이 있는가.
   * 스킵 행의 오류 셀은 반영 대상이 아니므로 여기 세지 않는다 (부록 B.5의 8·10행 주석).
   */
  hasBlockingError: boolean;
}

export interface ParseMatrixOptions {
  /** 라벨 열 (엑셀 열 문자, 좌→우) */
  labelColumns: readonly string[];
  /** 연차 열 → yearOrder. 합계 열은 여기 넣지 않는다 (S-5) */
  yearColumns: readonly { column: string; yearOrder: number }[];
  dataStartRow: number;
  /** 생략하면 시트 마지막 행 */
  dataEndRow?: number;
  amountUnit: AmountUnit;
  match?: MatchContext;
  /** 사용자가 "이 행 건너뛰기"로 지정한 0-based 행 (ImportDraft.skippedRowIndexes) */
  skippedRowIndexes?: readonly number[];
  /** 행별 수동 비목 지정 (ImportDraft.manualCategoryByRow) */
  manualCategoryByRow?: Readonly<Record<number, BudgetCategory>>;
}

export interface ParseMatrixResult {
  rows: ParsedRow[];
  /** 사용자 결정이 필요한 행 (미매핑·모호·퍼지) */
  unresolvedRowIndexes: number[];
  /** 오류 셀이 있는 반영 대상 행 */
  errorRowIndexes: number[];
}

const REASON = {
  userSkipped: '사용자 지정',
  skipPattern: '집계·메모 행 (스킵 패턴)',
  memo: '메모 행 (정규화 후 빈 라벨)',
  noLabel: '라벨 없음',
  unmapped: '미매핑',
  ambiguous: '구 비목 체계 — 사용자 선택 필요',
  fuzzy: '유사 매칭 — 사용자 확인 필요',
} as const;

export function parseMatrix(sheet: RawSheet, options: ParseMatrixOptions): ParseMatrixResult {
  const expanded = expandMerges(sheet);
  const cells = expanded.cells;
  const context = options.match;

  const labelIndexes = options.labelColumns.map(columnLetterToIndex);
  const yearCols = options.yearColumns.map((y) => ({
    column: y.column,
    columnIndex: columnLetterToIndex(y.column),
    yearOrder: y.yearOrder,
  }));

  const startRow = Math.max(0, options.dataStartRow);
  const endRow = Math.min(
    options.dataEndRow ?? cells.length - 1,
    Math.max(cells.length - 1, startRow)
  );

  const grid = buildLabelGrid(cells, labelIndexes, startRow, endRow, (raw) =>
    isCarryForwardable(raw, context)
  );

  const userSkipped = new Set(options.skippedRowIndexes ?? []);
  const manual = options.manualCategoryByRow ?? {};
  const width = labelIndexes.length;

  // S-6: 결합에 성공한 행이 아래 짝 행에 물려주는 비목
  const pairCategory = new Map<number, { category: BudgetCategory; fromRow: number }>();
  // S-10 승계 원본. push()가 갱신하므로 객체에 담아 둔다 (지역 let은 클로저 대입이 좁혀지지 않는다)
  const state = { lastCategory: null as { category: BudgetCategory; rowIndex: number } | null };

  const rows: ParsedRow[] = [];

  for (let i = 0; i < grid.effective.length; i += 1) {
    const rowIndex = startRow + i;
    const labels = grid.effective[i]!;
    const rawLabels = grid.raw[i]!;
    const classifications = labels.map((label) => classifyLabel(label, context));

    const amounts: ParsedAmountCell[] = yearCols.map((yc) => {
      const parsed = parseAmountCell(cellAt(cells, rowIndex, yc.columnIndex), options.amountUnit);
      return {
        column: yc.column,
        columnIndex: yc.columnIndex,
        yearOrder: yc.yearOrder,
        rawText: parsed.rawText,
        amount: parsed.amount,
        rounded: parsed.rounded,
        error: parsed.error,
      };
    });

    // S-12: 축 라벨은 채택 대상이 아니라 별도 수집 — 가장 오른쪽 축이 그 행의 축이다
    let axis: BudgetAxis | null = null;
    for (let c = width - 1; c >= 0; c -= 1) {
      const found = classifications[c]!;
      if (found.kind === 'axis') {
        axis = found.axis;
        break;
      }
    }
    // S-10 판정용 — "**그 행에** 축 라벨이 있고"이므로 carry-forward로 물려받은 축은 세지 않는다.
    // 물려받은 축까지 인정하면 축 열이 비어 있는 메모 행이 위 행의 `현물`을 이어받아 금액 행으로 둔갑한다.
    let ownAxis: BudgetAxis | null = null;
    for (let c = width - 1; c >= 0; c -= 1) {
      if (rawLabels[c] === '') continue;
      const found = classifications[c]!;
      if (found.kind === 'axis') {
        ownAxis = found.axis;
        break;
      }
    }

    const base = {
      rowIndex,
      labels: [...labels],
      rawLabels: [...rawLabels],
      classifications,
      amounts,
      axis,
      category: null as BudgetCategory | null,
      categorySource: null as CategorySource | null,
      matchedLabel: null as string | null,
      reason: null as string | null,
      fuzzyCandidate: null as FuzzyCandidate | null,
      ambiguousCandidates: null as BudgetCategory[] | null,
      combinedWithRow: null as number | null,
      inheritedFromRow: null as number | null,
    };

    const push = (row: ParsedRow) => {
      rows.push(row);
      if (row.status === 'mapped' && row.category) {
        state.lastCategory = { category: row.category, rowIndex };
      }
    };
    const blocking = (status: ParsedRowStatus) =>
      status !== 'skipped' && amounts.some((a) => a.error !== null);

    if (userSkipped.has(rowIndex)) {
      push({ ...base, status: 'skipped', reason: REASON.userSkipped, hasBlockingError: false });
      continue;
    }

    const manualCategory = manual[rowIndex];
    if (manualCategory) {
      push({
        ...base,
        status: 'mapped',
        category: manualCategory,
        categorySource: 'manual',
        matchedLabel: labels.filter((l) => l !== '').at(-1) ?? null,
        hasBlockingError: blocking('mapped'),
      });
      continue;
    }

    // S-12: 우→좌로 훑어 비목/스킵 중 가장 오른쪽 판정 하나를 채택한다
    let catIdx = -1;
    let detIdx = -1;
    let unknownIdx = -1;
    for (let c = width - 1; c >= 0; c -= 1) {
      const kind = classifications[c]!.kind;
      if (kind === 'category' || kind === 'ambiguous') {
        if (catIdx === -1) catIdx = c;
        if (detIdx === -1) detIdx = c;
      } else if (kind === 'skip') {
        if (detIdx === -1) detIdx = c;
      } else if (kind === 'unknown') {
        if (unknownIdx === -1) unknownIdx = c;
      }
    }

    // S-10: "전부 빈 문자열" 판정에서 **축 라벨 열은 제외**한다.
    // 축은 채택 대상이 아니라 별도 수집이므로, 축이 있다고 이 분기를 벗어나면
    // 행안부 22행(`(G)` + `현물`)에서 현물 금액이 통째로 유실된다.
    const contentIdx: number[] = [];
    for (let c = 0; c < width; c += 1) {
      const kind = classifications[c]!.kind;
      if (kind !== 'empty' && kind !== 'axis') contentIdx.push(c);
    }
    const allBlank =
      contentIdx.length > 0 &&
      contentIdx.every((c) => classifications[c]!.kind === 'blank-after-normalize');

    // ① 비목/모호가 가장 오른쪽 판정이면 채택
    if (catIdx !== -1 && catIdx === detIdx) {
      const hit = classifications[catIdx]!;
      if (hit.kind === 'ambiguous') {
        push({
          ...base,
          status: 'ambiguous',
          matchedLabel: hit.raw,
          ambiguousCandidates: hit.ambiguousCandidates,
          reason: REASON.ambiguous,
          hasBlockingError: blocking('ambiguous'),
        });
      } else {
        push({
          ...base,
          status: 'mapped',
          category: hit.category,
          categorySource: hit.categorySource,
          matchedLabel: hit.raw,
          hasBlockingError: blocking('mapped'),
        });
      }
      continue;
    }

    // ② S-6 결합에 성공한 위 행이 물려준 비목 (두 행을 같은 비목의 현금/현물 쌍으로 처리)
    const pair = pairCategory.get(rowIndex);
    if (pair) {
      push({
        ...base,
        status: 'mapped',
        category: pair.category,
        categorySource: 'combined',
        matchedLabel: labels.filter((l) => l !== '').at(-1) ?? null,
        combinedWithRow: pair.fromRow,
        hasBlockingError: blocking('mapped'),
      });
      continue;
    }

    // ③ S-10: 정규화 후 전부 빈 라벨인 행
    if (allBlank) {
      const inherited = state.lastCategory;
      if (ownAxis !== null && inherited !== null) {
        push({
          ...base,
          status: 'mapped',
          category: inherited.category,
          categorySource: 'inherited',
          matchedLabel: null,
          inheritedFromRow: inherited.rowIndex,
          hasBlockingError: blocking('mapped'),
        });
      } else {
        push({ ...base, status: 'skipped', reason: REASON.memo, hasBlockingError: false });
      }
      continue;
    }

    // ④ 스킵 판정 (비목보다 오른쪽의 스킵도 여기로 온다)
    if (detIdx !== -1) {
      push({
        ...base,
        status: 'skipped',
        matchedLabel: classifications[detIdx]!.raw,
        reason: REASON.skipPattern,
        hasBlockingError: false,
      });
      continue;
    }

    // ⑤ 어느 열도 판정되지 않음 → S-6(아래 행 결합) → I-3(퍼지) → I-4(미매핑)
    if (unknownIdx !== -1) {
      const own = rawLabels[unknownIdx] !== '' ? rawLabels[unknownIdx]! : labels[unknownIdx]!;
      const below = grid.raw[i + 1]?.[unknownIdx] ?? '';
      if (below !== '') {
        const combined = classifyLabel(own + below, context);
        if (combined.kind === 'category' && combined.category) {
          pairCategory.set(rowIndex + 1, { category: combined.category, fromRow: rowIndex });
          push({
            ...base,
            status: 'mapped',
            category: combined.category,
            categorySource: 'combined',
            matchedLabel: own + below,
            combinedWithRow: rowIndex + 1,
            hasBlockingError: blocking('mapped'),
          });
          continue;
        }
      }

      const fuzzy = findFuzzyCandidate(classifications[unknownIdx]!.normalized, context);
      push({
        ...base,
        status: fuzzy ? 'fuzzy' : 'unmapped',
        matchedLabel: classifications[unknownIdx]!.raw,
        fuzzyCandidate: fuzzy,
        reason: fuzzy ? REASON.fuzzy : REASON.unmapped,
        hasBlockingError: blocking(fuzzy ? 'fuzzy' : 'unmapped'),
      });
      continue;
    }

    // ⑥ 라벨이 하나도 없는 행 — 금액만 있어도 조용히 버리지 않고 남긴다 (S-12)
    push({ ...base, status: 'skipped', reason: REASON.noLabel, hasBlockingError: false });
  }

  return {
    rows,
    unresolvedRowIndexes: rows
      .filter((r) => r.status === 'unmapped' || r.status === 'ambiguous' || r.status === 'fuzzy')
      .map((r) => r.rowIndex),
    errorRowIndexes: rows.filter((r) => r.hasBlockingError).map((r) => r.rowIndex),
  };
}
