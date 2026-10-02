// 붙임4형 8-2 칸 편집 해석 (SOT §6.19 AG-3 편집, 부록 C.4.1, 계획서 S-12).
//
// 8-2 칸은 여러 금액 줄을 묶어 보인다(C.4 보기 소스). 사용자가 칸 총액을 바꾸면 그중 **어느 한 줄**만
// 고쳐 총액을 맞춘다 — 칸에 함께 묶인 다른 줄(현물·세목 미지정·연구과제추진비)은 사용자가 그 칸에서 고친
// 대상이 아니므로 건드리지 않고, 입력값에서 빼서 고칠 줄의 목표를 정한다. 그 목표가 음수면 다른 줄을
// 임의로 깎지 않고 거부한다(AG-2와 같은 원칙). 양식 기호가 우리 비목과 1:1이 아닌 행이 있어 분기가 행마다 다르다.
// 순수 함수다 — 실제 쓰기·O-2·경합 STALE은 액션·리포지토리가 한다.

import { ATTACHMENT4_FORM_ROWS, DEFAULT_SUBCATEGORY_CODE } from '@/lib/constants';
import { resolveCellEdit, type CellEditLine, type CellEditResolution } from '@/lib/agreement/cell-edit';
import type { Attachment4RowId, BudgetCategory, DetailAxis } from '@/types';

export interface FormCellEditTarget {
  yearId: string;
  rowId: Attachment4RowId;
  /** 현금/현물이 나뉜 행(A·B·F·G·H)은 그 축, 한 줄 행(C·D 일반·D 통합관리·I·L)은 null */
  axis: DetailAxis | null;
  /** 칸에 보일 새 총액(원 단위 정수, 0 이상). 0도 저장한다 — 줄 없음("—")과 0은 다른 사실이다 */
  amount: number;
}

export type FormCellEditRejectReason =
  /** 금액이 0 이상의 원 단위 정수가 아니다 */
  | 'invalid_amount'
  /** 집계·비율·내역·무시 행, 양식에 없는 비목 행, 또는 행과 축 지정이 맞지 않는 칸 */
  | 'not_editable'
  /** 칸에 함께 묶인 다른 줄(현물·세목 미지정·연구과제추진비)만으로 이미 입력값보다 크다 */
  | 'below_fixed_part'
  /** `default` 흡수 대상 칸에서 세목 줄 합계가 이미 목표보다 크다(resolveCellEdit 그대로) */
  | 'exceeds_target';

export type FormCellEditResolution =
  | Extract<CellEditResolution, { kind: 'update' | 'insert' }>
  /** 고칠 줄이 이미 그 금액이다 — 쓰기 없음 */
  | { kind: 'noop' }
  /** 받을 수 없는 편집. `message`를 그대로 사용자에게 보인다 */
  | { kind: 'reject'; reason: FormCellEditRejectReason; message: string };

const won = (n: number): string => `${n.toLocaleString('ko-KR')}원`;

function reject(reason: FormCellEditRejectReason, message: string): FormCellEditResolution {
  return { kind: 'reject', reason, message };
}

function sumLines(
  lines: readonly CellEditLine[],
  yearId: string,
  category: BudgetCategory,
  axis: DetailAxis,
  subcategoryCodes: readonly string[] | 'all'
): number {
  let sum = 0;
  for (const l of lines) {
    if (l.yearId !== yearId || l.category !== category || l.axis !== axis) continue;
    if (subcategoryCodes !== 'all' && !subcategoryCodes.includes(l.subcategoryCode)) continue;
    sum += l.amount;
  }
  return sum;
}

/** (연차, 비목, 세목, 축) 줄 하나를 정확히 목표로 — 있으면 update(같으면 noop), 없으면 insert */
function resolveExact(
  lines: readonly CellEditLine[],
  yearId: string,
  category: BudgetCategory,
  subcategoryCode: string,
  axis: DetailAxis,
  target: number
): FormCellEditResolution {
  const matches = lines.filter(
    (l) => l.yearId === yearId && l.category === category && l.subcategoryCode === subcategoryCode && l.axis === axis
  );
  // unique(version_id, year_id, category, subcategory_code, axis)가 막는 상태 — 어느 줄을 고칠지 정할 수 없다
  if (matches.length > 1) throw new Error('같은 세목·축의 금액 줄이 두 개 있습니다 — 데이터가 손상되었습니다.');
  const existing = matches[0];
  if (existing === undefined) {
    return { kind: 'insert', line: { yearId, category, subcategoryCode, axis, amount: target } };
  }
  if (existing.amount === target) return { kind: 'noop' };
  return { kind: 'update', lineId: existing.id, amount: target };
}

/** AG-2 `default` 흡수에 맡긴다. 같은 금액으로의 update는 noop으로 바꾼다 */
function resolveAbsorb(
  lines: readonly CellEditLine[],
  yearId: string,
  category: BudgetCategory,
  axis: DetailAxis,
  target: number
): FormCellEditResolution {
  const r = resolveCellEdit(lines, { yearId, category, axis }, target);
  if (r.kind === 'update') {
    const line = lines.find((l) => l.id === r.lineId);
    if (line !== undefined && line.amount === r.amount) return { kind: 'noop' };
  }
  return r;
}

/** 입력값 − 고정분이 음수면 거부 메시지, 아니면 null */
function fixedPartTooLarge(amount: number, fixed: number, what: string): FormCellEditResolution | null {
  if (amount - fixed >= 0) return null;
  return reject(
    'below_fixed_part',
    `이 칸에는 ${what} ${won(fixed)}이 함께 들어 있어 ${won(amount)}으로 줄일 수 없습니다. ${what}을 먼저 줄이세요.`
  );
}

/**
 * 8-2 데이터 칸의 새 총액을 금액 줄 쓰기 하나로 해석한다(S-12).
 *
 * - A·B(현금/현물): (`personnel_internal`|`personnel_external`, 축) 줄을 정확히 고친다. A 칸에는 세목 미지정
 *   인건비(`personnel`/`default`) 같은 축 금액이 함께 보이므로 목표 = 입력 − 그 금액(음수면 거부)
 * - C·D 일반·D 통합관리: 그 세목 현금 줄을 정확히 고친다. 목표 = 입력 − 그 세목 현물(D 일반은 세목 미지정
 *   학생인건비 현금·현물도 뺀다)
 * - F·G(현금/현물): `resolveCellEdit`(AG-2 `default` 흡수)
 * - I·L: 현금 셀 목표 = 입력 − 그 비목 현물(전 세목) → `resolveCellEdit`
 * - H(현금/현물): `activity` 셀 목표 = 입력 − 그 연차·축 `promotion` 합 → `resolveCellEdit`
 * - 그 밖의 행(집계·비율·내역·무시·양식에 없는 비목)과 행·축 지정이 맞지 않는 칸은 거부
 *
 * `lines`에는 버전의 줄 전체를 넘겨도 된다.
 */
export function resolveFormCellEdit(
  lines: readonly CellEditLine[],
  target: FormCellEditTarget
): FormCellEditResolution {
  const { yearId, rowId, axis, amount } = target;
  if (!Number.isSafeInteger(amount) || amount < 0) {
    return reject('invalid_amount', '금액은 0 이상의 원 단위 정수여야 합니다.');
  }
  const row = ATTACHMENT4_FORM_ROWS.find((r) => r.id === rowId);
  if (row === undefined || row.kind !== 'data' || row.id === 'outside') {
    return reject('not_editable', '이 칸은 다른 칸에서 계산되거나 양식에 없는 비목이라 직접 고칠 수 없습니다.');
  }
  if ((row.axes === 'split') !== (axis !== null)) {
    return reject(
      'not_editable',
      row.axes === 'split' ? '이 행은 현금·현물 칸을 골라 고쳐야 합니다.' : '이 행은 현금·현물로 나뉘지 않는 한 칸입니다.'
    );
  }

  switch (rowId) {
    case 'personnel_internal': {
      const ax = axis!;
      const fixed = sumLines(lines, yearId, 'personnel', ax, [DEFAULT_SUBCATEGORY_CODE]);
      return (
        fixedPartTooLarge(amount, fixed, '세목 미지정 인건비') ??
        resolveExact(lines, yearId, 'personnel', 'personnel_internal', ax, amount - fixed)
      );
    }
    case 'personnel_external':
      return resolveExact(lines, yearId, 'personnel', 'personnel_external', axis!, amount);
    case 'personnel_support': {
      const fixed = sumLines(lines, yearId, 'personnel', 'in_kind', ['personnel_support']);
      return (
        fixedPartTooLarge(amount, fixed, '현물') ??
        resolveExact(lines, yearId, 'personnel', 'personnel_support', 'cash', amount - fixed)
      );
    }
    case 'student_general': {
      const inKind = sumLines(lines, yearId, 'student_personnel', 'in_kind', ['student_general']);
      const unassigned =
        sumLines(lines, yearId, 'student_personnel', 'cash', [DEFAULT_SUBCATEGORY_CODE]) +
        sumLines(lines, yearId, 'student_personnel', 'in_kind', [DEFAULT_SUBCATEGORY_CODE]);
      return (
        fixedPartTooLarge(amount, inKind + unassigned, unassigned > 0 ? '현물·세목 미지정 학생인건비' : '현물') ??
        resolveExact(lines, yearId, 'student_personnel', 'student_general', 'cash', amount - inKind - unassigned)
      );
    }
    case 'student_managed': {
      const fixed = sumLines(lines, yearId, 'student_personnel', 'in_kind', ['student_managed']);
      return (
        fixedPartTooLarge(amount, fixed, '현물') ??
        resolveExact(lines, yearId, 'student_personnel', 'student_managed', 'cash', amount - fixed)
      );
    }
    case 'facility_equipment':
    case 'material':
      return resolveAbsorb(lines, yearId, rowId, axis!, amount);
    case 'allowance':
    case 'indirect': {
      const fixed = sumLines(lines, yearId, rowId, 'in_kind', 'all');
      return fixedPartTooLarge(amount, fixed, '현물') ?? resolveAbsorb(lines, yearId, rowId, 'cash', amount - fixed);
    }
    case 'activity': {
      const ax = axis!;
      const fixed = sumLines(lines, yearId, 'promotion', ax, 'all');
      return (
        fixedPartTooLarge(amount, fixed, '연구과제추진비') ?? resolveAbsorb(lines, yearId, 'activity', ax, amount - fixed)
      );
    }
    default:
      // ATTACHMENT4_FORM_ROWS에 data 행이 늘었는데 여기 분기가 없으면 금액이 엉뚱한 줄로 가지 않게 멈춘다
      throw new Error(`붙임4 8-2 행 '${rowId}'의 편집 규칙이 없습니다.`);
  }
}
