// 사업비 입력 양식 생성기 (SOT §6.16 IN-1·IN-3·IN-4·IN-7, §7.9.7).
//
// 앱 데이터 → `InputFormWorkbook`(FormCell 격자). 좌표는 전부 `layout.ts`에서 온다 — 여기에 열 번호가
// 하나라도 박히면 파서와 어긋날 수 있다(IN-1). SheetJS를 import하지 않는다(IN-8).
//
// **금액을 계산하지 않는다.** 인건비·사업비 금액 열은 엑셀 수식이다(IN-7) — 사용자가 엑셀에서 참여율을
// 고치면 그 자리에서 같은 값이 보여야 하고, 올리면 서버가 PL-1로 다시 계산한다(금액 열은 읽지 않는다, IN-3).
// 그래서 `computeDetailAmount`를 부를 이유가 없다. 수식은 연봉 셀을 직접 쓴다 — 월급 셀을 거치면
// 월액 반올림이 끼어 박선욱 행이 1원 어긋난다(PL-2).

import { personnelParticipation } from '@/lib/budget-plan';
import {
  BUDGET_CATEGORY_LABELS,
  BUDGET_CATEGORY_ORDER,
  DETAIL_AXIS_LABELS,
  HIRE_TYPE_LABELS,
  SUBCATEGORY_PRESETS,
} from '@/lib/constants';
import { exportFileName } from '@/lib/export/detail-sheet';
import { personnelMonths } from '@/lib/participation';
import { monthlyDisplay, salaryBasisBadge } from '@/lib/salary';
import type { BudgetCategory, BudgetDetail } from '@/types';
import {
  EMPTY_ROWS_PER_SUBCATEGORY,
  INPUT_FORM_SHEETS,
  INPUT_FORM_VERSION,
  columnAddress,
  columnOf,
  hiddenColumnIndexes,
} from './layout';
import type { InputFormSheetDef } from './layout';
import { buildMetaRows } from './meta';
import { subcategoryKeyOf } from './parse';
import type { FormCell, FormSheet, InputFormData, InputFormWorkbook } from './types';

/** IN-7: 연봉이 없으면 수식 대신 이 비고를 적는다. 파서(T3)가 경고로 되돌려 읽는 문구이기도 하다 */
export const NO_SALARY_NOTE = '연봉 미입력';
/** SL-4 배지가 하나도 없을 때(퇴직금·4대보험 둘 다 미포함으로 기록됨) */
export const NO_INCLUSION_LABEL = '포함 없음';
/** IN-3: 기존 행이 없는 인력의 빈 행에 미리 적는 세목 */
export const DEFAULT_PERSONNEL_SUBCATEGORY = 'personnel_internal';

const PERSONNEL_CATEGORIES: ReadonlySet<BudgetCategory> = new Set(['personnel', 'student_personnel']);

// ─── 셀 헬퍼 ────────────────────────────────────────────────

/** 역할 → 셀 쓰기. 열 번호는 맵이 정한다 */
function makeRow(sheet: InputFormSheetDef): {
  cells: FormCell[];
  set: (role: string, cell: FormCell) => void;
} {
  const cells: FormCell[] = sheet.columns.map(() => ({}));
  return {
    cells,
    set: (role, cell) => {
      cells[columnOf(sheet, role)] = cell;
    },
  };
}

function headerRows(sheet: InputFormSheetDef): FormCell[][] {
  const rows: FormCell[][] = [];
  for (let r = 1; r < sheet.headerRow; r += 1) rows.push([]);
  rows.push(sheet.columns.map((column) => ({ value: column.label })));
  for (let r = sheet.headerRow + 1; r < sheet.dataStartRow; r += 1) rows.push([]);
  return rows;
}

function byOrder<T extends { order: number }>(a: T, b: T): number {
  return a.order - b.order;
}

/** 부록 A.5 세목 코드 → 라벨. 프리셋에 없는 코드는 코드 그대로 보여 준다 — 조용히 빈 칸으로 두지 않는다 */
function subcategoryLabel(category: BudgetCategory, code: string): string {
  const def = SUBCATEGORY_PRESETS[category].find((d) => d.code === code);
  return def ? def.label : code;
}

// ─── 인건비 시트 (IN-3, IN-7) ────────────────────────────────

function buildPersonnelSheet(data: InputFormData): { sheet: FormSheet; memberIds: string[] } {
  const def = INPUT_FORM_SHEETS.personnel;
  const rows = headerRows(def);
  const members = [...data.members].sort(byOrder);
  const memberIdSet = new Set(members.map((m) => m.id));

  // 인력 목록에 없는 memberId를 가진 인건비 행은 양식에서 사라진다 — 조용히 빠뜨리지 않고 던진다
  const orphan = data.details.find(
    (d) => d.formula === 'personnel' && d.memberId !== null && !memberIdSet.has(d.memberId)
  );
  if (orphan) {
    throw new Error(`인건비 산출근거 ${orphan.id}의 인력(${orphan.memberId})이 인력 목록에 없다`);
  }

  for (const member of members) {
    const details = data.details
      .filter((d) => d.formula === 'personnel' && d.memberId === member.id)
      .sort(byOrder);
    const slots: (BudgetDetail | null)[] = details.length > 0 ? details : [null];

    for (const detail of slots) {
      const rowNumber = rows.length + 1; // 1-based — 수식이 같은 행을 가리킬 때 쓴다
      const { cells, set } = makeRow(def);

      set('memberId', { value: member.id });
      set('detailId', { value: detail ? detail.id : null });
      set('name', {
        value: member.hireType === 'new' ? `${member.name} (${HIRE_TYPE_LABELS.new})` : member.name,
      });
      set('position', { value: member.position });
      set('staff', { value: member.staffName ?? '' });
      const badge = salaryBasisBadge(member).labels;
      set('salaryBasis', { value: badge.length > 0 ? badge.join(' · ') : NO_INCLUSION_LABEL });
      set('annualSalary', { value: member.annualSalary });
      set('monthlySalary', {
        value: member.annualSalary === null ? null : monthlyDisplay(member.annualSalary),
      });
      set('subcategory', {
        value: detail
          ? subcategoryLabel(detail.category, detail.subcategory)
          : subcategoryLabel('personnel', DEFAULT_PERSONNEL_SUBCATEGORY),
      });
      set('participation', { value: detail ? personnelParticipation(detail) : null });
      set('months', { value: detail ? personnelMonths(detail) : null });
      set('axis', { value: detail ? DETAIL_AXIS_LABELS[detail.axis] : null });
      set('adjustment', { value: detail ? detail.adjustment : null });

      const note = detail ? detail.note : '';
      if (member.annualSalary === null) {
        // IN-7: 수식 대신 빈 칸. 기존 비고는 지우지 않고 앞에 붙인다
        set('note', { value: note === '' ? NO_SALARY_NOTE : `${NO_SALARY_NOTE} · ${note}` });
      } else {
        const salary = columnAddress(def, 'annualSalary', rowNumber);
        const participation = columnAddress(def, 'participation', rowNumber);
        const months = columnAddress(def, 'months', rowNumber);
        const adjustment = columnAddress(def, 'adjustment', rowNumber);
        const formulaAmount = columnAddress(def, 'formulaAmount', rowNumber);
        // PL-1·PL-2 그대로: 연봉 × 참여율/100 × 개월/12를 한 번에 반올림. 월급 셀 참조 금지
        set('formulaAmount', { formula: `ROUND(${salary}*${participation}/100*${months}/12,0)` });
        set('amount', { formula: `${formulaAmount}+${adjustment}` });
        set('note', { value: note });
      }

      rows.push(cells);
    }
  }

  return {
    sheet: { name: def.name, hidden: def.hidden, rows, hiddenColumns: hiddenColumnIndexes(def) },
    memberIds: members.map((m) => m.id),
  };
}

// ─── 사업비 시트 (IN-4) ──────────────────────────────────────

interface BudgetSlot {
  category: BudgetCategory;
  code: string;
  /** IN-4 복합 키 `비목:세목` — 숨김 열과 `_meta.subcategoryCodes`에 쓰는 값. 세목 코드 `default`가 여섯 비목에 공유된다 */
  key: string;
  label: string;
}

/** 시트에 깔 (비목, 세목 코드, 라벨) 순서 — 부록 A.5 전 세목 + 프리셋에 없는 코드는 그 비목 끝에 */
function budgetSubcategorySlots(details: readonly BudgetDetail[]): BudgetSlot[] {
  const slots: BudgetSlot[] = [];
  const slot = (category: BudgetCategory, code: string, label: string): BudgetSlot => ({
    category,
    code,
    key: subcategoryKeyOf(category, code),
    label,
  });
  for (const category of BUDGET_CATEGORY_ORDER) {
    if (PERSONNEL_CATEGORIES.has(category)) continue;
    const presetCodes = new Set<string>();
    for (const def of SUBCATEGORY_PRESETS[category]) {
      presetCodes.add(def.code);
      slots.push(slot(category, def.code, def.label));
    }
    // 프리셋 밖 코드를 가진 기존 행도 양식에 실어야 사용자가 그 행의 존재를 안다
    const extras = new Set<string>();
    for (const d of details) {
      if (d.category === category && !presetCodes.has(d.subcategory)) extras.add(d.subcategory);
    }
    for (const code of [...extras].sort()) slots.push(slot(category, code, code));
  }
  return slots;
}

function buildBudgetSheet(data: InputFormData): { sheet: FormSheet; subcategoryCodes: string[] } {
  const def = INPUT_FORM_SHEETS.budget;
  const rows = headerRows(def);
  const factorRoles = ['factor1', 'factor2', 'factor3'] as const;
  const slots = budgetSubcategorySlots(data.details);

  const pushRow = (slot: BudgetSlot, detail: BudgetDetail | null) => {
    const rowNumber = rows.length + 1;
    const { cells, set } = makeRow(def);

    set('subcategory', { value: slot.key });
    set('detailId', { value: detail ? detail.id : null });
    set('category', { value: BUDGET_CATEGORY_LABELS[slot.category] });
    set('subcategoryLabel', { value: slot.label });
    set('name', { value: detail ? detail.name : null });
    set('spec', { value: detail ? detail.spec : null });
    set('unitPrice', { value: detail ? detail.unitPrice : null });
    // IN-4: 인자는 프리셋 defaultFactors 자리(인자1~3)에 순서대로. 라벨은 버리고 값만 —
    // isPercent 인자는 /100해 두면 곱셈에서 같은 금액이 나온다(금액만 보존)
    factorRoles.forEach((role, index) => {
      const factor = detail ? detail.factors[index] : undefined;
      set(role, { value: factor ? (factor.isPercent ? factor.value / 100 : factor.value) : null });
    });
    set('adjustment', { value: detail ? detail.adjustment : null });
    set('axis', { value: detail ? DETAIL_AXIS_LABELS[detail.axis] : null });

    const unitPrice = columnAddress(def, 'unitPrice', rowNumber);
    const adjustment = columnAddress(def, 'adjustment', rowNumber);
    const product = factorRoles
      .map((role) => columnAddress(def, role, rowNumber))
      .map((addr) => `IF(${addr}="",1,${addr})`)
      .join('*');
    // PL-3·PL-4: 빈 인자는 1(곱셈 항등원). 조정액을 더한 뒤 한 번만 반올림
    set('amount', { formula: `ROUND(${unitPrice}*${product}+${adjustment},0)` });
    set('note', { value: detail ? detail.note : null });

    rows.push(cells);
  };

  for (const slot of slots) {
    const existing = data.details
      .filter((d) => d.category === slot.category && d.subcategory === slot.code)
      .sort(byOrder);
    for (const detail of existing) pushRow(slot, detail);
    for (let i = 0; i < EMPTY_ROWS_PER_SUBCATEGORY; i += 1) pushRow(slot, null);
  }

  return {
    sheet: { name: def.name, hidden: def.hidden, rows, hiddenColumns: hiddenColumnIndexes(def) },
    subcategoryCodes: slots.map((s) => s.key),
  };
}

// ─── 워크북 ─────────────────────────────────────────────────

/** X-12와 같은 파일명 규칙(금지 문자 치환·날짜 형식 검사)을 재사용하고 접두만 붙인다 */
export function inputFormFileName(
  project: InputFormData['project'],
  year: InputFormData['year'],
  todayISO: string
): string {
  return `입력양식_${exportFileName(project, year, todayISO)}`;
}

/**
 * 양식 한 장. `todayISO`는 `_meta.generatedAt`과 파일명에 쓴다 — 시각을 여기서 읽지 않아야
 * 같은 입력이면 같은 출력이다(테스트 가능).
 */
export function buildInputForm(data: InputFormData, todayISO: string): InputFormWorkbook {
  const personnel = buildPersonnelSheet(data);
  const budget = buildBudgetSheet(data);
  const metaDef = INPUT_FORM_SHEETS.meta;
  const meta: FormSheet = {
    name: metaDef.name,
    hidden: metaDef.hidden,
    rows: buildMetaRows({
      formVersion: INPUT_FORM_VERSION,
      projectId: data.project.id,
      yearId: data.year.id,
      generatedAt: todayISO,
      subcategoryCodes: budget.subcategoryCodes,
      memberIds: personnel.memberIds,
    }),
    hiddenColumns: hiddenColumnIndexes(metaDef),
  };

  return {
    sheets: [personnel.sheet, budget.sheet, meta],
    fileName: inputFormFileName(data.project, data.year, todayISO),
  };
}
