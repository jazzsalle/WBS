// 산출근거 시트 채우기 — X-4 행 금액 덮어쓰기 · X-5 용량 · X-6 원 단위 · X-7 백분율 · X-8 빈 슬롯
// + X-12 파일명 (SOT §6.12.2~§6.12.3, §6.12.4).
//
// 부수효과 없는 순수 함수다. **SheetJS를 import하지 않는다** — `lib/import/`와 같은 경계다(I-13).
// 여기는 "어느 값을 어느 셀에 쓸까"만 정하고, 워크북을 여는 것은 어댑터의 몫이다.
// 단위 테스트: tests/unit/export-writes.test.ts
//
// **금액 산식을 여기 다시 구현하지 않는다** (PL-10a): `lib/budget-plan.ts`의 computeDetailAmount를
// 부른다. 서식이 `TRUNC(...)`로 절사하든 말든 앱이 계산한 값이 파일에 들어간다 (X-4).

import { computeDetailAmount } from '@/lib/budget-plan';
import { BUDGET_CATEGORY_LABELS, HIRE_TYPE_LABELS, SUBCATEGORY_PRESETS } from '@/lib/constants';
import type { BudgetCategory } from '@/types';
import { encodeAddr } from './layouts';
import type {
  CellWrite,
  ExportDetailRow,
  ExportMember,
  ExportPlanData,
  ExportYear,
  TemplateBlock,
  TemplateColumn,
  TemplateLayout,
} from './types';

// ─── 블록 배치 ───────────────────────────────────────────────

/** 한 블록에 들어갈 행들. 슬롯 순서대로 배치된 뒤의 상태다 */
export interface BlockAssignment {
  block: TemplateBlock;
  rows: readonly ExportDetailRow[];
}

/** X-5: 서식의 빈 줄보다 데이터 행이 많다. **자르지 않고 거부한다** */
export interface CapacityOverflow {
  blockKey: string;
  /** 템플릿 원문 라벨. 사용자에게 "어느 세목이 넘쳤는지" 보여 준다 */
  label: string;
  needed: number;
  capacity: number;
}

/**
 * 템플릿에 자리 자체가 없는 (비목, 세목). 조용히 버리면 예산이 사라진다.
 *
 * `label`을 함께 담는 이유: 거부 메시지도 확인 화면도 **사람이 읽고 무엇이 왜 안 되는지 알아야**
 * 한다. `student_personnel/student_general`만 던지면 사용자는 어느 줄을 고쳐야 할지 모른다.
 * 실제로 이 템플릿의 산출근거에는 학생인건비 표가 없어서 그 비목을 쓴 과제는 통째로 거부된다.
 */
export interface UnmappedRows {
  category: BudgetCategory;
  subcategory: string;
  /** `학생인건비 > 일반` — 부록 A.1 비목 라벨 + 부록 A.5 세목 라벨 */
  label: string;
  count: number;
}

/** 코드가 아니라 서식·화면에서 쓰는 이름으로 옮긴다. 프리셋에 없는 세목이면 코드를 그대로 보인다 */
function unmappedLabel(category: BudgetCategory, subcategory: string): string {
  const preset = SUBCATEGORY_PRESETS[category].find((def) => def.code === subcategory);
  return `${BUDGET_CATEGORY_LABELS[category]} > ${preset?.label ?? subcategory}`;
}

/**
 * 행은 들어갔지만 **근거를 적을 열이 없는** 경우 (X-5a).
 *
 * X-5가 세로(행 수)라면 이건 가로(열)다. 인자 열이 모자란 경우와 단가 열이 아예 없는 경우
 * 둘 다 여기 담긴다.
 *
 * 금액 자체는 틀어지지 않는다 — X-4대로 금액 열에는 앱이 계산한 값이 그대로 들어간다.
 * 빠지는 것은 그 금액이 어떻게 나왔는지를 보여 주는 칸이므로 **거부가 아니라 경고**다
 * (§7.9.4 "경고를 그대로 안고 나간다").
 */
export interface TruncatedFactors {
  blockKey: string;
  /** 어느 행인지 사람이 알아볼 라벨 (품명 또는 성명) */
  rowLabel: string;
  kept: number;
  total: number;
  /**
   * 단가가 있는데 서식에 단가 열이 없는가 (X-5a).
   *
   * **인자 개수만 세면 이 경우가 통째로 빠져나간다** — 실측 `나. 연구지원비` 표는
   * `내역 · 산출내역 · 합계`뿐이라 `단가 2,000,000 / 인자 0개`인 행이
   * `total(0) > kept(0)`가 거짓이 되어 경고 없이 근거를 잃는다.
   */
  unitPriceDropped: boolean;
}

export interface CapacityReport {
  assignments: readonly BlockAssignment[];
  overflows: readonly CapacityOverflow[];
  unmapped: readonly UnmappedRows[];
  truncatedFactors: readonly TruncatedFactors[];
}

/** 인건비 행의 인력. 없으면 금액이 0원이 되고 §7.9.4가 "연봉 미입력"으로 경고한다 (D-8a) */
function memberOf(
  row: ExportDetailRow,
  members: ReadonlyMap<string, ExportMember>
): ExportMember | null {
  return row.memberId === null ? null : (members.get(row.memberId) ?? null);
}

/**
 * 행 하나가 들어갈 블록.
 *
 * 세목 일치가 먼저고, 없으면 **세목 없는 블록**(`subcategory: null`)이 받는다 — 서식의 인건비·
 * 연구수당·국제공동연구개발비 표는 세목 구분 없이 한 덩어리인데(D-3a) 앱의 행은 언제나 세목을
 * 갖기 때문이다. 세목을 지어내지 않고 표의 생김새에 맞춘다.
 *
 * 기존인력/신규채용은 **명부의 `hireType`**으로 가른다 (부록 B.8.1). 인력을 못 찾으면 기본값인
 * 기존인력으로 둔다 (§5.11) — 금액은 어차피 0원 + 경고라 자리만 정하면 된다.
 */
function findBlock(
  row: ExportDetailRow,
  member: ExportMember | null,
  blocks: readonly TemplateBlock[]
): TemplateBlock | null {
  const sameCategory = blocks.filter((block) => block.category === row.category);
  const exact = sameCategory.filter((block) => block.subcategory === row.subcategory);
  const candidates = exact.length > 0 ? exact : sameCategory.filter((block) => block.subcategory === null);
  if (candidates.length === 0) return null;

  const segmented = candidates.filter((block) => block.segment !== null);
  if (segmented.length === 0) return candidates[0] ?? null;

  const segment = member?.hireType === 'new' ? 'newHire' : 'existing';
  return segmented.find((block) => block.segment === segment) ?? segmented[0] ?? null;
}

/** §5.17 order 오름차순. 같으면 입력 순서를 지킨다 — 배치가 실행마다 흔들리면 왕복 테스트가 무의미하다 */
function sortRows(rows: readonly { row: ExportDetailRow; index: number }[]): ExportDetailRow[] {
  return [...rows].sort((a, b) => a.row.order - b.row.order || a.index - b.index).map((entry) => entry.row);
}

function rowLabelOf(row: ExportDetailRow, member: ExportMember | null): string {
  return row.formula === 'personnel' ? (member?.name ?? '(인력 미지정)') : row.name;
}

/**
 * X-5: 한 연차의 행들을 템플릿 블록에 배치하고 **넘치는 곳을 밝힌다.**
 *
 * 잘라내지 않는다 — 잘린 예산은 조용히 틀린 예산이다. 행을 삽입해 늘리는 길도 SOT가 허용하지만
 * (병합·수식 범위가 함께 밀려야 한다) 여기서는 **거부** 쪽을 택했다. 넘친 사실은 §7.9.4의
 * 내보내기 전 확인 화면이 그대로 보여 준다.
 */
export function checkCapacity(
  rows: readonly ExportDetailRow[],
  members: readonly ExportMember[],
  layout: TemplateLayout
): CapacityReport {
  const memberIndex = new Map(members.map((member) => [member.id, member]));
  const grouped = new Map<string, { block: TemplateBlock; rows: { row: ExportDetailRow; index: number }[] }>();
  const unmapped = new Map<string, UnmappedRows>();
  const truncatedFactors: TruncatedFactors[] = [];

  rows.forEach((row, index) => {
    const member = memberOf(row, memberIndex);
    const block = findBlock(row, member, layout.detail.blocks);
    if (block === null) {
      const key = `${row.category}|${row.subcategory}`;
      const found = unmapped.get(key);
      if (found) found.count += 1;
      else
        unmapped.set(key, {
          category: row.category,
          subcategory: row.subcategory,
          label: unmappedLabel(row.category, row.subcategory),
          count: 1,
        });
      return;
    }
    const bucket = grouped.get(block.key) ?? { block, rows: [] };
    bucket.rows.push({ row, index });
    grouped.set(block.key, bucket);

    const factorColumns = block.columns.filter((column) => column.role === 'factor').length;
    const factorCount = row.formula === 'personnel' ? 0 : row.factors.length;
    // X-5a — 단가 열이 없는 표에 단가가 있는 행이 들어오면 근거가 통째로 사라진다.
    // 인건비는 단가가 아니라 명부 연봉에서 오므로(PL-1) 이 판정 대상이 아니다.
    const unitPriceDropped =
      row.formula !== 'personnel' &&
      row.unitPrice !== 0 &&
      !block.columns.some((column) => column.role === 'unitPrice');
    if (factorCount > factorColumns || unitPriceDropped) {
      truncatedFactors.push({
        blockKey: block.key,
        rowLabel: rowLabelOf(row, member),
        kept: factorColumns,
        total: factorCount,
        unitPriceDropped,
      });
    }
  });

  const assignments: BlockAssignment[] = [];
  const overflows: CapacityOverflow[] = [];
  // 블록 순서는 맵(= 서식의 위에서 아래)을 따른다. 데이터가 없는 블록도 담는다 — X-8이 그 자리를 비운다
  for (const block of layout.detail.blocks) {
    const bucket = grouped.get(block.key);
    const assigned = bucket ? sortRows(bucket.rows) : [];
    if (assigned.length > block.slotCount) {
      overflows.push({
        blockKey: block.key,
        label: block.label,
        needed: assigned.length,
        capacity: block.slotCount,
      });
    }
    assignments.push({ block, rows: assigned });
  }

  return { assignments, overflows, unmapped: [...unmapped.values()], truncatedFactors };
}

// ─── 값 만들기 (X-4·X-6·X-7·X-8) ─────────────────────────────

/**
 * X-7: 백분율 서식 셀에는 100으로 나눈 값을 쓴다. 임포트 D-22의 정확한 반대다 —
 * 화면의 `64`를 그대로 쓰면 엑셀이 `6400%`로 읽는다.
 *
 * 숫자에만 적용한다. 실측 템플릿의 `나. 연구지원비` 비고 열(L273:L278)에 `0.00%` 서식이
 * 남아 있는데(export-layout 테스트가 이 잔재를 고정하고 있다) 비고는 텍스트라 나눌 것이 없다.
 */
function scaleForFormat(value: string | number | null, column: TemplateColumn): string | number | null {
  if (typeof value !== 'number' || !column.percentFormat) return value;
  return value / 100;
}

interface RowValues {
  row: ExportDetailRow;
  member: ExportMember | null;
  /** PL-1~PL-5로 계산한 원 단위 정수. X-6: 표시 단위로 환산하지 않는다 */
  amount: number;
  /** 인자 열에 순서대로 채울 값 (quantity 행) */
  factorValues: readonly number[];
  /** 참여율 · 참여기간 (personnel 행) */
  ratePercent: number | null;
  months: number | null;
}

function buildRowValues(row: ExportDetailRow, member: ExportMember | null): RowValues {
  const amount = computeDetailAmount(row, member).amount;
  const isPersonnel = row.formula === 'personnel';
  return {
    row,
    member,
    amount,
    factorValues: isPersonnel ? [] : row.factors.map((factor) => factor.value),
    // PL-1의 인건비 산식이 쓰는 인자는 비율 하나 + 개월 하나뿐이라 라벨이 아니라 isPercent로 고른다
    // (라벨은 세목마다 다르다 — PL-3)
    ratePercent: isPersonnel ? (row.factors.find((f) => f.isPercent)?.value ?? null) : null,
    months: isPersonnel ? (row.factors.find((f) => !f.isPercent)?.value ?? null) : null,
  };
}

/**
 * 열 하나에 들어갈 값. 모르는 값은 `null`이고, `null`은 **셀을 비우라는 뜻**이다 (X-8).
 *
 * 금액 열은 축을 가린다: 현금 행은 현물 칸을, 현물 행은 현금 칸을 **비운다.** 이것을 빠뜨리면
 * 실측 `K83`처럼 현금·현물 양쪽에 수식이 남아 있는 슬롯에서 같은 금액이 두 번 잡힌다.
 */
function valueForColumn(
  column: TemplateColumn,
  values: RowValues,
  factorIndex: number
): string | number | null {
  const { row, member, amount } = values;
  switch (column.role) {
    case 'memberName':
      return member?.name ?? null;
    case 'position':
      return member?.position ?? null;
    case 'salary':
      return member?.annualSalary ?? null;
    case 'hireType':
      return member === null ? null : HIRE_TYPE_LABELS[member.hireType];
    case 'rate':
      return values.ratePercent;
    case 'period':
      return values.months;
    case 'name':
      return row.name === '' ? (member?.name ?? null) : row.name;
    case 'spec':
      return row.spec === '' ? null : row.spec;
    case 'unitPrice':
      // personnel 행의 단가는 명부 연봉이다 (PL-D1) — unitPrice는 무시한다
      return row.formula === 'personnel' ? (member?.annualSalary ?? null) : row.unitPrice;
    case 'factor':
      return values.factorValues[factorIndex] ?? null;
    case 'cashTotal':
      return row.axis === 'cash' ? amount : null;
    case 'inKindTotal':
      return row.axis === 'in_kind' ? amount : null;
    case 'total':
      return amount;
    case 'note':
      return row.note === '' ? null : row.note;
    default:
      return null;
  }
}

function writesForSlot(
  sheet: string,
  block: TemplateBlock,
  slotRow: number,
  values: RowValues | null
): CellWrite[] {
  const writes: CellWrite[] = [];
  let factorIndex = 0;
  for (const column of block.columns) {
    const index = column.role === 'factor' ? factorIndex++ : 0;
    const raw = values === null ? null : valueForColumn(column, values, index);
    writes.push({
      sheet,
      addr: encodeAddr(column.column, slotRow),
      value: scaleForFormat(raw, column),
      // X-4: 금액 열은 템플릿 수식을 지우고 쓴다. 빈 슬롯도 마찬가지다 — 남은 수식이 0원을
      // 만들어 내는 것은 괜찮지만, 남의 조정상수가 붙어 있으면 0원이 아니게 된다 (X-4b의 보완)
      ...(column.overwritesFormula ? { clearFormula: true } : {}),
    });
  }
  return writes;
}

/**
 * X-4·X-6·X-7·X-8. 한 연차(X-9)의 산출근거 시트를 채울 쓰기 지시 전부.
 *
 * **소계·합계에는 쓰지 않는다** (X-4a). 템플릿의 `SUM`이 다시 계산하고, 그 값이 앱의 소계와
 * 같은지가 유일하게 남은 검산이다.
 *
 * 용량을 넘거나(X-5) 템플릿에 자리가 없는 행이 있으면 **던진다.** 반쯤 채운 파일을 돌려주면
 * 호출부가 경고를 무시하는 순간 잘린 예산이 제출된다 — 그래서 §6.12.4가 `checkCapacity`를
 * 별도 함수로 둔 것이고, 화면은 그것으로 먼저 묻는다 (§7.9.4).
 */
export function buildDetailWrites(
  plan: ExportPlanData,
  yearId: string,
  layout: TemplateLayout
): CellWrite[] {
  const rows = plan.details.filter((row) => row.yearId === yearId);
  const report = checkCapacity(rows, plan.members, layout);

  if (report.overflows.length > 0 || report.unmapped.length > 0) {
    const overflow = report.overflows
      .map((item) => `${item.label}(${item.blockKey}) ${item.needed}행 > 빈 줄 ${item.capacity}개`)
      .join(', ');
    // 코드가 아니라 이름으로 말한다 — 사용자가 **어느 비목이 이 서식에 자리가 없는지**를
    // 읽고 알아야 고칠 수 있다. `unmapped`만 던지고 끝내면 무엇을 고칠지 알 수 없다
    const missing = report.unmapped
      .map((item) => `${item.label} ${item.count}행 [${item.category}/${item.subcategory}]`)
      .join(', ');
    throw new Error(
      `산출근거를 '${layout.templateFile}' 서식으로 낼 수 없다. ` +
        `${overflow === '' ? '' : `빈 줄보다 항목이 많다 (X-5): ${overflow}. `}` +
        `${
          missing === ''
            ? ''
            : `이 서식의 산출근거에는 다음 항목을 적을 표가 없다 (X-5): ${missing}. ` +
              `서식을 바꾸거나 그 항목을 빼야 한다. `
        }` +
        `내보내기 전에 checkCapacity로 확인해야 한다`
    );
  }

  const memberIndex = new Map(plan.members.map((member) => [member.id, member]));
  const sheet = layout.detail.sheet;
  const writes: CellWrite[] = [];

  for (const assignment of report.assignments) {
    const { block } = assignment;
    block.slotRows.forEach((slotRow, slot) => {
      const row = assignment.rows[slot];
      // X-8: 빈 슬롯도 행을 없애지 않고 값만 비운다. 서식이 달라지면 제출 서류로 쓸 수 없다
      const values = row === undefined ? null : buildRowValues(row, memberOf(row, memberIndex));
      writes.push(...writesForSlot(sheet, block, slotRow, values));
    });
  }

  return writes;
}

// ─── X-12 파일명 ─────────────────────────────────────────────

/** 윈도우·맥에서 파일명에 쓸 수 없는 문자 + 제어문자. 과제명에 `/`가 들어오는 일이 실제로 있다 */
const FORBIDDEN_FILENAME_CHARS = /[\\/:*?"<>|]|\p{Cc}/gu;

function sanitizeFileNamePart(text: string, fallback: string): string {
  const cleaned = text.replace(FORBIDDEN_FILENAME_CHARS, '_').replace(/\s+/g, ' ').trim();
  // 끝의 점·공백은 윈도우가 조용히 잘라내 파일명이 달라진다
  const trimmed = cleaned.replace(/[. ]+$/, '');
  return trimmed === '' ? fallback : trimmed;
}

/**
 * X-12: 과제명 · 연차 · 생성일을 담은 파일명.
 *
 * 여러 번 내보낸 파일이 한 폴더에 쌓이므로 **파일명만 보고 최신을 골라야 한다.**
 * 날짜 형식이 어긋나면 던진다 — 날짜 없는 파일명이 조용히 만들어지면 그 목적이 사라진다.
 */
export function exportFileName(
  project: { name: string },
  year: Pick<ExportYear, 'order' | 'name'>,
  todayISO: string
): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(todayISO);
  if (!match) throw new Error(`생성일이 YYYY-MM-DD 형식이 아니다: ${todayISO}`);

  const projectPart = sanitizeFileNamePart(project.name, '과제');
  const yearPart = sanitizeFileNamePart(year.name, `${year.order + 1}차년도`);
  return `${projectPart}_${yearPart}_${match[1]}${match[2]}${match[3]}.xlsx`;
}
