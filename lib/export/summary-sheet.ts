// 총괄표 시트 채우기 — X-10 산출근거와 한 파일 · X-10a 연차 열은 전부 값 · X-10b 서식 모순
// · X-10c 집계·비율 행도 값 · X-10d 메모 행은 비운다 · X-10e 비율 행의 합계 열은 비운다
// (SOT §6.12.3).
//
// 부수효과 없는 순수 함수다. SheetJS를 import하지 않는다 (§6.12.4).
// 단위 테스트: tests/unit/export-writes.test.ts
//
// **산출근거와 같은 배열에서 낸다** (X-10): 총괄표는 산출근거의 합계라 앞뒤가 맞아야 하고,
// 두 시트를 앱이 다 만들면 그 일치가 구조적으로 보장된다. 집계는 `lib/budget-plan.ts`의
// aggregateDetails·evaluateBudgetRules가 하고 여기서는 산식을 다시 쓰지 않는다 (PL-10a).

import { aggregateDetails, buildYearTotals, evaluateBudgetRules } from '@/lib/budget-plan';
import type { BudgetRuleEvaluation, CellTotal } from '@/lib/budget-plan';
import { encodeAddr, isSummaryDataTarget } from './layouts';
import type {
  CellWrite,
  ExportPlanData,
  SummaryAggregateKind,
  TemplateLayout,
  TemplateSummaryRow,
} from './types';

/** 값을 쓰지 않고 비운 채 내보내는 행. UI가 그대로 사용자에게 알린다 (X-10b·X-10d) */
export interface SummarySkip {
  row: number;
  label: string;
  reason: SummarySkipReason;
  /**
   * 사람이 읽는 문장. **`reason` 코드만으로는 오해를 막지 못한다** — 사용자가 빈 줄을 보고
   * "국제공동이 빠졌다"고 읽으면 안 된다. 금액은 아래 합계 줄에 **이미 잡혀 있고** 이 줄만
   * 비어 있다는 사실과, 그래서 무엇을 해야 하는지를 여기서 말한다.
   */
  message: string;
  /** 맵이 담고 있는 서식 모순의 이름 (`label-formula-mismatch`) */
  conflict?: string;
}

export type SummarySkipReason =
  /** X-10b: 라벨과 수식이 어긋나 어느 비목인지 서식 소유자만 안다 */
  | 'conflict'
  /**
   * 같은 (비목, 세목, 축)을 가리키는 행이 둘 이상이라 어느 줄에 얼마를 넣을지 정할 수 없다.
   *
   * 실측 총괄표 10·11행(학생 인건비)이 그렇다 — 다른 비목은 `현금`/`현물` 라벨이 붙어 있는데
   * 이 두 줄에는 없다. 위가 현금이라고 **짐작해서 쓰면 틀릴 수 있고**, 둘 다 쓰면 같은 금액이
   * 두 번 보인다. 지어내지 않고 비운 채 알린다 (D-3a와 같은 태도).
   */
  | 'ambiguous'
  /**
   * X-10d: 앱에 대응 데이터가 **없는** 괄호 메모 행. 통합관리비(현금)·연구실 안전관리비는
   * 부록 A.5의 세목이 아니고 §6.11 I-5·S-10이 임포트에서 이미 건너뛴다 — 임포트가 읽지 않는
   * 것을 내보내기가 지어낼 수는 없다.
   */
  | 'memo';

export interface SummaryWriteResult {
  writes: CellWrite[];
  skipped: SummarySkip[];
}

/** 총괄표 한 줄이 가리키는 금액의 키 */
function targetKey(row: TemplateSummaryRow): string {
  return `${row.category}|${row.subcategory}|${row.axis}`;
}

/**
 * (비목, 세목, 축) → 금액. 세목 행은 세목 소계에서, 세목 없는 행은 비목 셀 합계에서 낸다 (PL-6·PL-7).
 * 축이 없는 행은 현금 + 현물이다.
 */
function amountOf(cell: CellTotal | undefined, row: TemplateSummaryRow): number {
  if (cell === undefined) return 0;
  const source =
    row.subcategory === null
      ? cell
      : cell.subcategories.find((subtotal) => subtotal.subcategory === row.subcategory);
  if (source === undefined) return 0;
  if (row.axis === 'cash') return source.cashAmount;
  if (row.axis === 'inKind') return source.inKindAmount;
  return source.plannedAmount;
}

/**
 * X-10c: 집계·비율 행의 값. **산식을 여기 다시 쓰지 않는다** (PL-10a) — `evaluateBudgetRules`가
 * PL-11~PL-13을 이미 계산했고 여기서는 어느 필드를 그 칸에 넣을지만 고른다.
 *
 * `totalPersonnel`(E = A+B+C+D)만 덧셈이 하나 붙는다: E1(PL-11)이 뺀 연구지원인력인건비(C)를
 * 도로 더한 것이 E다. 비목 합계를 여기서 따로 더하면 PL-11이 정한 "무엇이 인건비인가"의 정의가
 * 두 곳으로 갈라진다.
 *
 * 비율이 `null`인 것은 분모가 0이라는 뜻이다 (PL-12·PL-13). 0으로 나누지 않고 칸을 비운다.
 */
function aggregateValue(kind: SummaryAggregateKind, rules: BudgetRuleEvaluation): number | null {
  switch (kind) {
    case 'totalPersonnel':
      return rules.modifiedPersonnel + rules.personnelSupportTotal;
    case 'modifiedPersonnel':
      return rules.modifiedPersonnel;
    case 'allowanceRate':
      return rules.allowanceRate;
    case 'indirectRate':
      return rules.indirectRate;
    case 'directTotal':
      return rules.directTotal;
    case 'grandTotal':
      return rules.grandTotal;
  }
}

/**
 * 값이 나가는 행이 **어디서** 값을 얻는가. `null`이면 비목 금액(`amountOf`), 아니면 집계다.
 *
 * 집계 행인데 맵이 무엇을 계산할지 말하지 않으면 **던진다.** validateLayout이 먼저 잡아야 하는
 * 상태이고(X-10c), 조용히 넘어가면 그 줄이 다른 연차의 값을 단 채로 제출된다.
 */
function valueSourceOf(row: TemplateSummaryRow): { aggregate: SummaryAggregateKind | null } {
  if (row.kind === 'amount') return { aggregate: null };
  if (row.aggregate === undefined) {
    throw new Error(
      `총괄표 ${row.row}행('${row.label}')이 집계 행인데 맵이 무엇을 계산할지(aggregate) 말하지 않는다 — ` +
        `validateLayout으로 먼저 확인해야 한다 (X-10c)`
    );
  }
  return { aggregate: row.aggregate };
}

/** 값이 나가지 않는 행과 그 이유. 나가지 않는다고 **손대지 않는 것이 아니다** — 셀은 비운다 */
function skipReasonOf(row: TemplateSummaryRow, duplicates: ReadonlySet<string>): SummarySkipReason | null {
  if (row.memo !== undefined) return 'memo';
  if (row.conflict !== undefined) return 'conflict';
  if (row.kind === 'amount') {
    if (row.category === null) return 'conflict';
    return duplicates.has(targetKey(row)) ? 'ambiguous' : null;
  }
  return null;
}

/**
 * 비운 줄을 사람 말로 설명한다. **"합계에는 잡혀 있다"를 반드시 말한다** — 빈 칸만 보면
 * 사용자는 그 비목이 예산에서 통째로 빠졌다고 읽고, 그건 사실이 아니다. 직접비 계·연구개발비
 * 총액은 앱이 전 비목을 더해 값으로 쓰므로(X-10c) 이 줄의 금액도 그 안에 들어 있다.
 *
 * 국제공동연구개발비(24·25행)가 바로 그 자리다 — 서식 모순(X-10b)이 풀릴 때까지 줄은 비지만
 * 금액은 총액에 잡힌다. "빠졌다"는 오해가 곧 잘못된 재작성으로 이어진다.
 */
function skipMessageOf(row: TemplateSummaryRow, reason: SummarySkipReason): string {
  const where = `총괄표 ${row.row}행('${row.label}')`;
  const countedIn = '앱에 이 비목 금액이 있다면 직접비 계·연구개발비 총액에는 이미 들어 있습니다';
  switch (reason) {
    case 'conflict':
      return (
        `${where}을 비운 채 내보냅니다 — 서식의 라벨과 수식이 서로 다른 비목을 가리켜 ` +
        `어느 쪽 금액인지 앱이 정할 수 없습니다(${row.conflict ?? '서식 모순'}). ` +
        `${countedIn} — 빠진 것이 아니라 보이는 줄이 없는 것이므로, 제출 전에 이 칸을 손으로 채우십시오.`
      );
    case 'ambiguous':
      return (
        `${where}을 비운 채 내보냅니다 — 같은 항목을 가리키는 줄이 둘인데 서식에 현금/현물 라벨이 없어 ` +
        `어느 줄이 어느 쪽인지 짐작할 수 없습니다. ${countedIn} — 빠진 것이 아니라 보이는 줄이 없는 ` +
        `것이므로, 제출 전에 두 칸을 손으로 나눠 적으십시오.`
      );
    case 'memo':
      return (
        `${where}을 비운 채 내보냅니다 — 괄호 줄은 상위 비목 금액의 내역이라 그 금액은 위 비목 줄과 ` +
        `총액에 이미 들어 있고, 앱은 그 내역을 따로 갖고 있지 않습니다. 합계는 맞으니 이 칸만 ` +
        `필요하면 손으로 채우십시오.`
      );
  }
}

/**
 * X-10·X-10a~X-10d. 총괄표의 **전 연차 열**을 채울 쓰기 지시.
 *
 * 산출근거는 한 연차만 담지만(X-9) 총괄표는 전 연차를 담는다. 템플릿의 1차년도 열은
 * `산출근거!G13` 같은 시트 참조인데, 2차년도를 내보내면 그 수식이 **2차년도 값을 1차년도 칸에**
 * 보여 준다 — 그래서 연차 열은 전부 값으로 덮어쓴다 (X-10a. `clearFormula`가 수식을 지운다).
 *
 * **집계·비율 행도 같다** (X-10c): `총괄표!F12 = 산출근거!G21`이지 총괄표 안의 SUM이 아니므로
 * 같은 함정이 그대로 걸린다. 총 인건비·수정인건비·연구수당 비율·간접비 비율·직접비 계·총액을
 * 연차마다 값으로 쓴다.
 *
 * **값이 나가지 않는 행도 셀은 비운다**: 모순 행(X-10b)·메모 행(X-10d)·축이 모호한 행에
 * 템플릿 수식을 남기면 "비운 채 내보낸다"는 말과 달리 다른 연차의 숫자가 그 칸에 찍힌다.
 * 빈 칸은 사람이 보고 채울 수 있지만 틀린 숫자는 그대로 제출된다.
 *
 * 합계 열(`totalColumn`)은 템플릿의 `SUM`이 채운다 (X-4a). **비율 행만 예외로 비운다** (X-10e):
 * `J23 = SUM(F23:I23)`은 연차가 여럿이면 연차별 비율을 더해 버린다.
 */
export function buildSummaryWrites(plan: ExportPlanData, layout: TemplateLayout): SummaryWriteResult {
  const aggregate = aggregateDetails(plan.details, plan.members);
  const cells = new Map<string, CellTotal>(
    aggregate.cells.map((cell) => [`${cell.yearId}|${cell.category}`, cell])
  );
  const yearIdByIndex = new Map(plan.years.map((year) => [year.order + 1, year.id]));

  // 연차마다 PL-11~PL-13을 한 번 돌린다. 한도는 null로 넘긴다 — 여기서 필요한 것은 값이지
  // 위반 판정이 아니고, 한도 초과 경고는 내보내기 전 확인 화면의 몫이다 (§7.9.4)
  const rulesByYear = new Map<string, BudgetRuleEvaluation>();
  for (const year of plan.years) {
    const sources = aggregate.cells.filter((cell) => cell.yearId === year.id);
    rulesByYear.set(
      year.id,
      evaluateBudgetRules(buildYearTotals(sources), { allowanceRateLimit: null, indirectRateLimit: null })
    );
  }

  // 같은 자리를 가리키는 행이 둘 이상이면 어느 줄이 어느 축인지 서식이 말해 주지 않는다는 뜻이다
  const duplicates = new Set<string>();
  const seen = new Set<string>();
  for (const row of layout.summary.rows) {
    if (!isSummaryDataTarget(row)) continue;
    const key = targetKey(row);
    if (seen.has(key)) duplicates.add(key);
    seen.add(key);
  }

  const writes: CellWrite[] = [];
  const skipped: SummarySkip[] = [];

  for (const row of layout.summary.rows) {
    const skip = skipReasonOf(row, duplicates);
    if (skip !== null) {
      skipped.push({
        row: row.row,
        label: row.label,
        reason: skip,
        message: skipMessageOf(row, skip),
        ...(row.conflict !== undefined ? { conflict: row.conflict } : {}),
      });
    }
    const source = skip === null ? valueSourceOf(row) : null;

    for (const year of layout.summary.yearColumns) {
      const yearId = yearIdByIndex.get(year.yearIndex);
      const rules = yearId === undefined ? undefined : rulesByYear.get(yearId);
      // 없는 연차의 칸도, 값이 나가지 않는 행도 **비운다**. 템플릿 수식이 남아 있으면
      // 그 칸에 다른 연차의 값이 보인다 (X-10a·X-10c)
      const raw =
        source === null || yearId === undefined || rules === undefined
          ? null
          : source.aggregate === null
            ? amountOf(cells.get(`${yearId}|${row.category}`), row)
            : aggregateValue(source.aggregate, rules);
      writes.push({
        sheet: layout.summary.sheet,
        addr: encodeAddr(year.column, row.row),
        value: scaleForFormat(raw, row),
        // X-10a: 1차년도 열은 산출근거를 가리키는 수식이다. 지우지 않으면 값이 붙지 않고,
        // 비우는 칸에서는 남은 수식이 그대로 틀린 값을 보여 준다
        clearFormula: true,
      });
    }

    // X-10e: 비율 행의 합계 열은 `SUM(F23:I23)`이라 연차가 여럿 채워지면 **연차별 비율의 합**이
    // 찍힌다(0.96% + 1.00% → 1.96%). 원본은 1차년도 한 칸만 값이 있어 우연히 그 연차의 비율로
    // 보였을 뿐이다. 비율의 합은 의미가 없고 전 연차 통합 비율을 서식이 요구하는지는 알 수 없으니
    // 지어내지 않고 비운다. **금액·집계 행의 합계 열은 건드리지 않는다** — X-4a의 검산이 거기 있다.
    if (row.kind === 'ratio') {
      writes.push({
        sheet: layout.summary.sheet,
        addr: encodeAddr(layout.summary.totalColumn, row.row),
        value: null,
        clearFormula: true,
      });
    }
  }

  return { writes, skipped };
}

/** X-7: 백분율 서식 행에는 100으로 나눠 쓴다. 비율 행이 그 자리다 (금액 행에는 해당이 없다) */
function scaleForFormat(value: number | null, row: TemplateSummaryRow): number | null {
  if (value === null) return null;
  return row.percentFormat ? value / 100 : value;
}
