// 산출근거 초안 + 인력 명부 → 미리보기 (SOT §6.11.2 D-3a · §6.11.3 D-8·D-8a ·
// §6.11.4 D-11~D-14 · §6.11.5 D-15·D-15b·D-18, §7.9.3 Step 3·4).
//
// **배치 근거 (§6.11.6)**: 파서 3종(detectSections·detectBlocks·parseDetailRows)과 소계 대조는
// `detail-sheet.ts`에 못박혀 있고 그 파일은 "시트만 안다". 성명 매칭과 미리보기 조립은 명부(Member)와
// 기존 셀 상태를 알아야 하므로 한 층 위이며, 총괄표의 `lib/import/preview.ts`와 같은 층이라
// 형제 파일로 둔다. 여기도 부수효과 없는 순수 함수다 — DB·네트워크·현재 시각을 쓰지 않는다.
// 단위 테스트: tests/unit/import-detail-preview.test.ts
//
// **금액 산식을 다시 구현하지 않는다** (PL-10a): `lib/budget-plan.ts`의 computeDetailAmount만 부른다.
// **명부를 고치지 않는다** (D-14): members는 읽기 전용 입력이다. 연봉 변경은 PL-10b의 별도 조작이다.

import { computeDetailAmount, type BudgetDetailInput, type MemberSalaryInput } from '@/lib/budget-plan';
import { SUBCATEGORY_PRESETS, subcategoryLookupKey, subcategoryLookupTable } from '@/lib/constants';
import { RuleViolationError } from '@/lib/db/errors';
import type { DetailImportNewMember, DetailImportRow } from '@/lib/db/import-snapshots';
import type { BudgetCategory, DetailAxis, DetailFactor, DetailFormula, HireType, Member } from '@/types';
import { compareSubtotals } from './detail-sheet';
import type { DetailBlock, DetailDraftRow, DetailRowIssue, DetailRowsResult } from './detail-sheet';
import { normalizeLabel } from './normalize';

// ─── 공통 키 ─────────────────────────────────────────────────

/**
 * 블록 식별자. 사용자의 세목 선택·통화 확인이 이 키로 붙는다.
 * 표가 여럿인 세목(`⑤ 출장비`)이 있으므로 tableIndex까지 넣어야 유일하다.
 */
export function detailBlockKey(block: DetailBlock): string {
  return `${block.category}:${block.categoryRow}:${block.subcategoryRow ?? '-'}:${block.tableIndex}`;
}

/** 행 식별자. D-9로 한 시트 행이 축 둘로 갈리므로 axisIndex까지 넣는다 */
export function detailRowKey(row: DetailDraftRow): string {
  return `${row.row}:${row.axisIndex}`;
}

/** D-11: 성명 대조 키. I-1 정규화 후 **완전일치**만 자동 제안한다 (퍼지 자동 확정 금지) */
export function detailMemberKey(name: string): string {
  return normalizeLabel(name);
}

// ─── D-3a 세목 확정 ──────────────────────────────────────────

export type DetailSubcategorySource =
  /** 사용자가 골랐다 */
  | 'user'
  /** D-3: 파서가 시트의 세목 헤더에서 정했다 */
  | 'sheet'
  /** D-3a ①: 프리셋 세목이 하나뿐이라 고를 것이 없다 */
  | 'single-preset'
  /** D-3a ②③: 행·비목 헤더의 세목 라벨로 정했다 */
  | 'row-label'
  /** D-3a ②③: 인건비·학생인건비의 기본 제안. 확인을 받아야 한다 */
  | 'suggested'
  /** 정할 근거가 없다 */
  | 'unresolved';

export interface DetailSubcategoryResolution {
  subcategory: string | null;
  source: DetailSubcategorySource;
  /** 자동 확정하지 않고 사용자 확인을 받아야 하는가 (§6.11 대원칙) */
  needsConfirm: boolean;
}

/**
 * D-3a ②③의 기본 제안. **자동 확정이 아니다** — 제안한 뒤 확인을 받는다.
 * 실측 산자부 인건비 표가 세목 라벨 없이 오고 그 총괄표도 내부인건비만 쓴다.
 */
const SUGGESTED_SUBCATEGORY: Partial<Record<BudgetCategory, string>> = {
  personnel: 'personnel_internal',
  student_personnel: 'student_general',
};

/** 세목 라벨이 실릴 수 있는 자리. 파서가 role을 붙여 담아 준 텍스트 필드가 전부다 */
function subcategoryLabelSources(block: DetailBlock, rows: readonly DetailDraftRow[]): string[] {
  const texts: string[] = [block.categoryLabel];
  for (const row of rows) {
    texts.push(row.hireTypeLabel ?? '', row.position ?? '', row.spec, row.note, row.name);
  }
  return texts;
}

/**
 * D-3a: 세목 헤더가 없는 블록(`subcategory === null`)의 세목을 여기서 정한다.
 * 파서는 시트에 없는 값을 지어내지 않으므로 그 판단이 이 층으로 넘어온다.
 *
 * ① 프리셋 세목이 하나뿐인 비목(연구수당·국제공동·위탁·부담비 …)은 고를 것이 없어 확인을 묻지 않는다
 * ② 인건비(3종)·학생인건비(2종)는 자동 확정하지 않는다 — 행에 `내부인건비`/`외부인건비`/
 *    `연구지원인력인건비` 라벨이 있으면 그것으로 정하고, 없으면 제안 + 확인이다
 * ③ 그 밖의 다중 세목 비목은 제안할 근거가 없으므로 미해결로 남긴다 (반영 대상에서 오류로 걸린다)
 */
export function resolveDetailSubcategory(
  block: DetailBlock,
  rows: readonly DetailDraftRow[],
  choice?: string | null
): DetailSubcategoryResolution {
  if (choice !== undefined && choice !== null && choice !== '') {
    return { subcategory: choice, source: 'user', needsConfirm: false };
  }
  if (block.subcategory !== null) {
    // D-3의 번호·라벨 검증 결과를 그대로 잇는다 — conflict·by-number는 확인이 필요하다
    return { subcategory: block.subcategory, source: 'sheet', needsConfirm: block.needsConfirm };
  }

  const presets = SUBCATEGORY_PRESETS[block.category];
  const only = presets.length === 1 ? presets[0] : undefined;
  if (only !== undefined) {
    return { subcategory: only.code, source: 'single-preset', needsConfirm: false };
  }

  const suggestion = SUGGESTED_SUBCATEGORY[block.category];
  if (suggestion === undefined) {
    return { subcategory: null, source: 'unresolved', needsConfirm: true };
  }

  const table = subcategoryLookupTable(block.category);
  for (const text of subcategoryLabelSources(block, rows)) {
    const code = table[subcategoryLookupKey(text)];
    if (code !== undefined) return { subcategory: code, source: 'row-label', needsConfirm: false };
  }
  return { subcategory: suggestion, source: 'suggested', needsConfirm: true };
}

// ─── D-11~D-14 성명 → Member 매칭 ────────────────────────────

/** 명부 쪽 입력. Member를 그대로 대입할 수 있는 최소 형태 + D-13 표시용 기관명 */
export type DetailMemberInput = Pick<
  Member,
  'id' | 'name' | 'position' | 'annualSalary' | 'orgId'
> & {
  /** 동명이인을 가르는 재료 (D-13). 리포지토리가 조인해 채운다 */
  orgName?: string | null;
};

export type DetailMemberStatus =
  /** 정규화 후 완전일치가 하나 */
  | 'matched'
  /** D-13: 같은 이름이 둘 이상 — **자동 선택하지 않는다** */
  | 'ambiguous'
  /** 명부에 없다 — 기존 인력 선택 / 새 인력 생성 / 건너뛰기 중 하나를 고른다 (D-11) */
  | 'unmatched';

export interface DetailMemberCandidate {
  id: string;
  name: string;
  position: string;
  orgId: string | null;
  orgName: string | null;
  annualSalary: number | null;
}

/** D-14: 파일 연봉과 명부 연봉이 다르다. **명부는 고치지 않는다** */
export interface DetailSalaryMismatch {
  file: number;
  roster: number | null;
}

export type DetailMemberIssue =
  | 'ambiguous'
  | 'unmatched'
  /** D-14 */
  | 'salary-mismatch'
  /** D-8a: 명부 연봉이 비어 산식 결과가 0이다 — 조정액이 금액 전부를 떠안는다 */
  | 'roster-salary-missing'
  /** 지정한 인력이 명부에 없다 */
  | 'member-missing';

/** D-11: 미매칭 성명의 결정 3종 */
export type DetailMemberDecision =
  | { kind: 'existing'; memberId: string }
  /** D-12: 반영 시점에 같은 트랜잭션에서 만든다. 미리보기는 Member를 만들지 않는다 */
  | { kind: 'create'; orgId?: string | null }
  | { kind: 'skip' };

export interface DetailMemberMatch {
  /** I-1 정규화 키. 사용자 결정(memberDecisions)이 이 키로 붙는다 */
  key: string;
  /** 파일의 성명 원문 (첫 등장) */
  fileName: string;
  status: DetailMemberStatus;
  /** 완전일치가 하나일 때의 Member id */
  memberId: string | null;
  /** D-13: 같은 이름의 후보 전부 (소속 기관·직위 포함) */
  candidates: DetailMemberCandidate[];
  /** 이 성명이 등장한 행 키 (detailRowKey) */
  rowKeys: string[];
  /** 파일의 연봉·직위·인력구분 — D-12의 새 인력 초기값이다 */
  fileSalary: number | null;
  filePosition: string | null;
  hireTypeLabel: string | null;
  hireType: HireType;
  salaryMismatch: DetailSalaryMismatch | null;
  issues: DetailMemberIssue[];
  /**
   * 자동 제안이자 최종 결정. 완전일치면 그 인력이고, 그 밖에는 null(사용자가 정해야 한다).
   * buildDetailPreview가 사용자 결정으로 덮어쓴다.
   */
  decision: DetailMemberDecision | null;
}

/** D-12: 파일의 인력구분 원문 → HireType. `신규채용`(신규·채용예정 포함)만 'new'다 */
export function toHireType(label: string | null): HireType {
  if (label === null) return 'existing';
  return normalizeLabel(label).includes('신규') ? 'new' : 'existing';
}

function toCandidate(member: DetailMemberInput): DetailMemberCandidate {
  return {
    id: member.id,
    name: member.name,
    position: member.position,
    orgId: member.orgId,
    orgName: member.orgName ?? null,
    annualSalary: member.annualSalary,
  };
}

/**
 * D-11·D-13·D-14. 인건비 행의 성명을 명부와 대조한다.
 *
 * **완전일치(I-1 정규화 후)만 자동 제안한다** — 퍼지 매칭으로 자동 확정하면 다른 사람의 연봉으로
 * 금액이 계산된다. 같은 이름이 둘 이상이면 후보만 싣고 자동 선택하지 않는다 (D-13).
 *
 * **명부를 고치지 않는다** (D-14): 파일 연봉이 달라도 경고만 싣는다.
 */
export function matchDetailMembers(
  rows: readonly DetailDraftRow[],
  members: readonly DetailMemberInput[]
): DetailMemberMatch[] {
  const roster = new Map<string, DetailMemberInput[]>();
  for (const member of members) {
    const key = detailMemberKey(member.name);
    const bucket = roster.get(key);
    if (bucket) bucket.push(member);
    else roster.set(key, [member]);
  }

  const matches = new Map<string, DetailMemberMatch>();
  for (const row of rows) {
    if (row.formula !== 'personnel') continue;
    if (row.memberName === null) continue; // 성명 없는 인건비 행은 미리보기가 오류로 드러낸다
    const key = detailMemberKey(row.memberName);
    if (key === '') continue;

    let match = matches.get(key);
    if (match === undefined) {
      const candidates = roster.get(key) ?? [];
      const status: DetailMemberStatus =
        candidates.length === 1 ? 'matched' : candidates.length > 1 ? 'ambiguous' : 'unmatched';
      const only = status === 'matched' ? candidates[0] : undefined;
      match = {
        key,
        fileName: row.memberName,
        status,
        memberId: only?.id ?? null,
        candidates: candidates.map(toCandidate),
        rowKeys: [],
        fileSalary: null,
        filePosition: null,
        hireTypeLabel: null,
        hireType: 'existing',
        salaryMismatch: null,
        issues: status === 'matched' ? [] : [status],
        decision: only === undefined ? null : { kind: 'existing', memberId: only.id },
      };
      matches.set(key, match);
    }

    match.rowKeys.push(detailRowKey(row));
    if (match.fileSalary === null && row.fileSalary !== null) match.fileSalary = row.fileSalary;
    if (match.filePosition === null && row.position !== null) match.filePosition = row.position;
    if (match.hireTypeLabel === null && row.hireTypeLabel !== null) {
      match.hireTypeLabel = row.hireTypeLabel;
      match.hireType = toHireType(row.hireTypeLabel);
    }
  }

  for (const match of matches.values()) {
    if (match.status !== 'matched') continue;
    const roster0 = match.candidates[0];
    if (roster0 === undefined) continue;
    // D-8a: 명부 연봉이 비면 산식 결과가 0이라 조정액이 금액 전부를 떠안는다 — 숫자는 맞지만
    // 근거가 비었다는 뜻이므로 경고한다 (PL-5 "연봉 미입력" 경로 재사용)
    if (roster0.annualSalary === null) match.issues.push('roster-salary-missing');
    else if (match.fileSalary !== null && match.fileSalary !== roster0.annualSalary) {
      match.salaryMismatch = { file: match.fileSalary, roster: roster0.annualSalary };
      match.issues.push('salary-mismatch');
    }
  }

  return [...matches.values()];
}

// ─── 미리보기 ────────────────────────────────────────────────

export type DetailPreviewRowStatus = 'new' | 'skipped' | 'error';

export const DETAIL_PREVIEW_STATUS_LABELS: Record<DetailPreviewRowStatus, string> = {
  new: '신규',
  skipped: '건너뜀',
  error: '오류',
};

/** D-15 안내. 화면 두 곳(행 비고·셀 머리)이 쓰므로 문장을 여기 한 곳에만 둔다 */
export const EXISTING_CELL_GUIDE =
  '기존 산출근거가 있어 건너뜁니다. 반영하려면 [기존 삭제 후 교체]를 고르세요.';

export type DetailPreviewRowIssue =
  /** D-10: 통화를 확인하지 않아 반영 대상에서 뺐다 */
  | 'currency-unconfirmed'
  /** D-15: 그 (연차, 비목)에 기존 산출근거가 있다 */
  | 'cell-skipped'
  /** D-21 ②: 근거는 있는데 금액이 0이라 기본 건너뜀이다 */
  | 'zero-amount-skipped'
  /** 사용자가 그 성명을 건너뛰기로 정했다 */
  | 'member-skipped'
  /** 사용자가 그 행을 건너뛰기로 정했다 */
  | 'row-skipped'
  /** D-3a로도 세목을 정하지 못했다 — 세목 없이는 저장할 수 없다 */
  | 'subcategory-unresolved'
  /** D-3·D-3a 제안 — 사용자 확인이 필요하다 (반영은 막지 않는다) */
  | 'subcategory-unconfirmed'
  /** D-11: 성명을 인력에 잇지 못했다 (미매칭·동명이인·성명 없음) */
  | 'member-unresolved'
  /** 지정한 인력이 명부에 없다 */
  | 'member-missing'
  /** D-8a: 명부 연봉 미입력 — 조정액이 금액 전부를 떠안았다 */
  | 'roster-salary-missing'
  /** D-14: 파일 연봉 ≠ 명부 연봉 */
  | 'salary-mismatch'
  /** I-12: 금액을 숫자로 읽지 못했다 */
  | 'amount-unparsable'
  /** PL-5: 최종 금액이 음수다 */
  | 'negative-amount';

export type DetailMemberRef =
  | { kind: 'existing'; memberId: string }
  | { kind: 'create'; tempKey: string };

export interface DetailPreviewRow {
  key: string;
  status: DetailPreviewRowStatus;
  statusLabel: string;
  blockKey: string;
  /** 0-based 시트 행 (원본을 가리킨다) */
  sourceRow: number;
  category: BudgetCategory;
  categoryLabel: string;
  subcategory: string | null;
  subcategoryLabel: string | null;
  subcategorySource: DetailSubcategorySource;
  formula: DetailFormula;
  /** 최종 축 — 사용자 재지정(axisOverrides)이 파서 제안보다 앞선다 (D-9) */
  axis: DetailAxis;
  /** D-9: 합계 열만 보고 현금으로 제안했다. **이 행만 축을 바꿀 수 있다** */
  axisSuggested: boolean;
  /**
   * 재지정을 걷어낸 파서의 축. `axis`와 다르면 사용자가 바꾼 것이다 —
   * 화면의 자동/수동 시각 구분과 "자동으로 되돌리기" 판정의 근거다 (D-7 effectiveColumnRole과 같은 자리).
   */
  axisAuto: DetailAxis;
  name: string;
  spec: string;
  note: string;
  unitPrice: number;
  factors: DetailFactor[];
  memberName: string | null;
  memberRef: DetailMemberRef | null;
  /** §5.17 order — 세목 안에서의 순서 */
  sortOrder: number;
  /** D-8a: **명부 연봉**으로 낸 산식 결과 (조정액 0) */
  formulaAmount: number;
  /** D-8: 파일의 합계 열 — 진실 */
  fileAmount: number;
  /** D-8a: `파일 합계 − 명부산식`. 저장 후 재계산해도 amount가 그대로다 */
  adjustment: number;
  /** 저장될 금액. `명부산식 + adjustment`이며 항상 fileAmount와 같다 */
  amount: number;
  /** 조정액으로 흡수한 차액이 있는가 — 조용히 넣지 않는다 (D-8) */
  absorbed: boolean;
  salaryMismatch: DetailSalaryMismatch | null;
  /** 파서가 붙인 행 이슈 (D-10·D-21·I-11·I-12) */
  sourceIssues: DetailRowIssue[];
  issues: DetailPreviewRowIssue[];
  reason: string | null;
}

export type DetailPreviewCellStatus = 'new' | 'replace' | 'skipped' | 'error';

/** (연차, 비목) 셀. 연차는 시트 하나에 하나다 (D-19) */
export interface DetailPreviewCell {
  category: BudgetCategory;
  status: DetailPreviewCellStatus;
  /** D-15: 기존 산출근거 행 수 */
  existingRows: number;
  /** D-15: 사용자가 [기존 삭제 후 교체]를 골랐는가 */
  replace: boolean;
  /** 반영 대상 행 수 */
  rowCount: number;
  /** 반영 대상 금액 합 */
  amount: number;
  reason: string | null;
}

export interface DetailPreviewBlock {
  key: string;
  category: BudgetCategory;
  categoryLabel: string;
  subcategory: string | null;
  subcategoryLabel: string | null;
  source: DetailSubcategorySource;
  needsConfirm: boolean;
  /** D-10: 원화가 아닌 통화 기호를 본 자리 */
  currency: DetailRowsResult['currency'];
  /** D-10: 사용자가 통화를 확인했는가. false면 이 블록은 반영 대상이 아니다 */
  currencyConfirmed: boolean;
  rowCount: number;
}

/** D-18 대조 범위. 세목 소계는 블록 단위, 비목 합계는 그 비목의 블록을 합쳐 본다 */
export type DetailSubtotalFold = 'block' | 'category';

export interface DetailSubtotalCheck {
  category: BudgetCategory;
  subcategory: string | null;
  blockKey: string;
  label: string;
  /** 0-based 시트 행 */
  row: number;
  column: string;
  axis: DetailAxis | 'total';
  fileValue: number;
  /** 대조에 채택한 우리 합 */
  ourSum: number;
  difference: number;
  matches: boolean;
  /** 블록 단위로 맞지 않아 비목 전체로 다시 대조했는가 (부록 B.8.3 `L150` 같은 비목 합계) */
  fold: DetailSubtotalFold;
  /** 그 비목의 모든 블록 행 합 — 미리보기가 양쪽을 나란히 보여 줄 재료다 */
  categorySum: number;
}

export interface DetailPreviewSummary {
  /** 신규 행 */
  new: number;
  /** 건너뜀 행 */
  skipped: number;
  /** 오류 행 */
  error: number;
  /** D-12: 새로 만들 인력 */
  newMembers: number;
  /** D-15: 교체할 셀 */
  replaceCells: number;
  /** 반영 대상 금액 합 */
  totalAmount: number;
}

export interface DetailImportPreview {
  yearId: string;
  rows: DetailPreviewRow[];
  cells: DetailPreviewCell[];
  blocks: DetailPreviewBlock[];
  members: DetailMemberMatch[];
  /** D-12: 반영 시점에 만들 인력. **행이 실제로 참조하는 것만 담는다** */
  newMembers: DetailImportNewMember[];
  /** D-18: 소계 대조 결과. 어긋나도 반영을 막지 않는다 */
  subtotals: DetailSubtotalCheck[];
  summary: DetailPreviewSummary;
  /** 오류 1건 이상일 때만 true (§7.9.1과 같은 기준) */
  blocked: boolean;
}

/** 블록 하나의 파싱 결과 묶음. 호출부는 `{ block, ...parseDetailRows(sheet, block) }`를 넘긴다 */
export interface DetailBlockInput extends DetailRowsResult {
  block: DetailBlock;
}

/** D-15: 그 (연차, 비목)의 기존 산출근거 행 수. 리포지토리가 조회해 넘긴다 */
export interface ExistingDetailCell {
  category: BudgetCategory;
  rowCount: number;
}

export type DetailRowDecision = 'include' | 'skip';

export interface BuildDetailPreviewInput {
  /** D-19: 시트 하나 = 연차 하나 */
  yearId: string;
  blocks: readonly DetailBlockInput[];
  /** 그 과제의 인력 명부. **여기서 고치지 않는다** (D-14) */
  members: readonly DetailMemberInput[];
  existingCells?: readonly ExistingDetailCell[];
  /** 성명 결정 (D-11). 키는 detailMemberKey */
  memberDecisions?: Readonly<Record<string, DetailMemberDecision>>;
  /** 세목 선택 (D-3·D-3a). 키는 detailBlockKey */
  subcategoryChoices?: Readonly<Record<string, string>>;
  /** D-9 축 재지정. 키는 detailRowKey. `axisSuggested`인 행에만 듣는다 */
  axisOverrides?: Readonly<Record<string, DetailAxis>>;
  /** D-15: [기존 삭제 후 교체]를 고른 비목 */
  replaceCategories?: readonly BudgetCategory[];
  /** D-10: 통화를 확인한 블록. 키는 detailBlockKey */
  confirmedCurrencyBlocks?: readonly string[];
  /** D-21 ②: 행 단위 포함·제외. 키는 detailRowKey */
  rowDecisions?: Readonly<Record<string, DetailRowDecision>>;
}

const ISSUE_REASONS: Record<DetailPreviewRowIssue, string> = {
  'currency-unconfirmed': '원화가 아닌 통화 기호가 있어 확인 전에는 반영하지 않습니다',
  'cell-skipped': EXISTING_CELL_GUIDE,
  'zero-amount-skipped': '금액이 0원이라 기본 건너뜀입니다 (포함시킬 수 있습니다)',
  'member-skipped': '이 성명을 건너뛰기로 지정했습니다',
  'row-skipped': '이 행을 건너뛰기로 지정했습니다',
  'subcategory-unresolved': '세목을 정하지 못했습니다. 세목을 고른 뒤 반영하세요',
  'subcategory-unconfirmed': '세목이 제안값입니다. 확인해 주세요',
  'member-unresolved': '성명을 인력에 잇지 못했습니다. 기존 인력 선택·새 인력 생성·건너뛰기 중 하나를 고르세요',
  'member-missing': '지정한 인력이 명부에 없습니다',
  'roster-salary-missing': '명부에 연봉이 없어 이 행은 0원으로 반영됩니다 (연봉을 입력한 뒤 다시 가져오세요)',
  'salary-mismatch': '파일 연봉과 명부 연봉이 다릅니다 (명부는 고치지 않습니다)',
  'amount-unparsable': '금액을 숫자로 읽지 못했습니다',
  'negative-amount': '최종 금액이 음수입니다',
};

/** 건너뜀 판정이 오류 판정보다 앞선다 — 반영되지 않는 행의 오류는 반영을 막지 않는다 (부록 B.5) */
const SKIP_ISSUES: readonly DetailPreviewRowIssue[] = [
  'currency-unconfirmed',
  'cell-skipped',
  'member-skipped',
  'row-skipped',
  'zero-amount-skipped',
];

const ERROR_ISSUES: readonly DetailPreviewRowIssue[] = [
  'subcategory-unresolved',
  'member-unresolved',
  'member-missing',
  'amount-unparsable',
  'negative-amount',
];

function reasonOf(
  issues: readonly DetailPreviewRowIssue[],
  details: Partial<Record<DetailPreviewRowIssue, string>> = {}
): string | null {
  if (issues.length === 0) return null;
  return issues
    .map((issue) => {
      const extra = details[issue];
      return extra === undefined ? ISSUE_REASONS[issue] : `${ISSUE_REASONS[issue]} (${extra})`;
    })
    .join(' / ');
}

function salaryInput(member: DetailMemberInput | null): MemberSalaryInput | null {
  return member === null ? null : { id: member.id, annualSalary: member.annualSalary };
}

interface FinalAmount {
  formulaAmount: number;
  adjustment: number;
  amount: number;
  negative: boolean;
  missingSalary: boolean;
}

/**
 * D-8 · **D-8a 조정액 확정**.
 *
 * 파서는 파일 연봉으로 낸 잠정 조정액(`adjustmentProvisional`)만 실어 온다. 여기서 **명부 연봉**으로
 * 다시 낸다: `adjustment = 파일 합계 − 명부산식`. 그래야 `amount = 명부산식 + adjustment = 파일 합계`이고
 * 저장 이후 PL-D7이 명부 연봉으로 재계산해도 **같은 값**이 나온다. 파일 연봉으로 역산하면
 * 임포트 직후 값과 첫 편집 후 값이 말없이 달라진다.
 *
 * 확정 금액도 다시 computeDetailAmount로 얻는다 — "저장값 = 재계산값"을 구성 자체로 보장하기 위해서다.
 *
 * **명부 연봉이 null이면 금액은 0원이다.** D-8a는 "조정액이 금액 전부를 떠안아 숫자는 파일과 맞는다"고
 * 적었지만, PL-1의 구현(computeDetailAmount)은 단가를 모르면 조정액을 더하지 않고 0원 + 경고로
 * 끝낸다(§7.9.2 "연봉 미입력"). 여기서 파일 값을 만들어 넣으려면 산식을 다시 구현해야 하고(PL-10a 위반),
 * 그렇게 저장한 값은 첫 재계산에서 0원으로 떨어져 D-8a가 막으려던 바로 그 어긋남이 된다.
 * 그래서 **산식은 한 곳(PL-10a)** 과 **저장값 = 재계산값(D-8a 본문)** 을 지키고, 파일 금액이 반영되지
 * 않는다는 사실을 행 경고로 드러낸다 (절대 규칙 5 — 조용히 삼키지 않는다).
 */
function finalizeAmount(
  yearId: string,
  row: DetailDraftRow,
  subcategory: string | null,
  member: DetailMemberInput | null
): FinalAmount {
  const base: BudgetDetailInput = {
    yearId,
    category: row.category,
    subcategory: subcategory ?? '',
    axis: row.axis,
    formula: row.formula,
    memberId: member?.id ?? null,
    unitPrice: row.unitPrice,
    adjustment: 0,
    factors: row.factors,
  };
  const salary = row.formula === 'personnel' ? salaryInput(member) : null;
  const formula = computeDetailAmount(base, salary);
  // 연봉을 모르면 흡수할 "차액"이 없다 — 산식 자체가 성립하지 않는다. 여기서 파일 금액을 조정액에
  // 넣어 두면 나중에 명부에 연봉을 채우는 순간(PL-10b 재계산) `산식 + 파일금액`이 되어 금액이 두 배로
  // 튄다. 사용자는 그 조정액이 임포트가 넣은 것인지 알 수 없다 — 무음 파괴라 넣지 않는다
  const adjustment = formula.missingSalary ? 0 : row.fileAmount - formula.amount;
  const final = computeDetailAmount({ ...base, adjustment }, salary);
  return {
    formulaAmount: formula.amount,
    adjustment,
    amount: final.amount,
    negative: final.negative,
    missingSalary: formula.missingSalary,
  };
}

function effectiveDecision(
  match: DetailMemberMatch,
  decisions: Readonly<Record<string, DetailMemberDecision>>
): DetailMemberDecision | null {
  return decisions[match.key] ?? match.decision;
}

interface AxisResolution {
  blocks: DetailBlockInput[];
  /** 재지정을 걷어낸 파서의 축. 키는 detailRowKey */
  auto: Map<string, DetailAxis>;
}

/**
 * D-9 축 재지정을 **행을 읽기 전에** 적용한다.
 *
 * 합계 열만 있는 세목은 파서가 현금으로 제안할 뿐이므로(`axisSuggested`) 사용자가 바꿀 수 있어야
 * 한다. 여기서 행의 축 자체를 바꾸므로 그 행의 금액 귀속(현금 합계 ↔ 현물 합계)이 함께 따라간다 —
 * D-18 소계 대조도, 저장 후 PL-10 총액 재계산도 같은 축을 본다.
 *
 * **행이 둘로 갈린 경우는 대상이 아니다**: 현금·현물 열에 값이 둘 다 있어 나뉜 행(`axisSuggested`
 * false)은 파일이 축을 명시한 것이라 바꿀 이유가 없고, 바꾸면 같은 시트 행에서 나온 두 행이 한 축으로
 * 겹쳐 D-9가 나눈 의미가 사라진다. 그런 키는 서버가 이미 거부하지만 여기서도 무시한다.
 *
 * **원본을 고치지 않는다** — 축이 실제로 바뀐 행만 새 객체로 만든다 (순수 함수).
 */
function applyAxisOverrides(
  blocks: readonly DetailBlockInput[],
  overrides: Readonly<Record<string, DetailAxis>>
): AxisResolution {
  const auto = new Map<string, DetailAxis>();
  const resolved = blocks.map((entry) => {
    let changed = false;
    const rows = entry.rows.map((row) => {
      const key = detailRowKey(row);
      auto.set(key, row.axis);
      const picked = overrides[key];
      if (picked === undefined || !row.axisSuggested || picked === row.axis) return row;
      changed = true;
      return { ...row, axis: picked };
    });
    return changed ? { ...entry, rows } : entry;
  });
  return { blocks: resolved, auto };
}

/**
 * 미리보기 조립 (§7.9.3 Step 4).
 *
 * - D-3a: 세목 헤더가 없는 블록의 세목을 여기서 정한다. 정하지 못하면 오류다 (세목 없이 저장할 수 없다)
 * - D-9: 축 재지정을 행에 반영한다 — 축이 바뀌면 그 행의 금액 귀속도 따라간다
 * - D-8a: 조정액을 **명부 연봉**으로 확정한다
 * - D-10: 통화를 확인하지 않은 블록은 반영 대상에서 뺀다 (환율을 지어내지 않는다)
 * - D-15: 기존 산출근거가 있는 셀은 **기본 건너뜀**이다. `replaceCategories`에 든 비목만 교체한다
 * - D-15b: 교체로 지정했는데 넣을 행이 없으면 **오류**다 — 내용 없는 삭제는 무음 파괴다
 * - D-18: 소계 대조는 경고다. `blocked`에 넣지 않는다
 * - D-21 ②: 금액 0인 행은 기본 건너뜀이되 미리보기에 남긴다
 *
 * `blocked`는 오류가 1건 이상일 때만 true다 (§7.9.1과 같은 기준).
 */
export function buildDetailPreview(input: BuildDetailPreviewInput): DetailImportPreview {
  const {
    yearId,
    blocks: inputBlocks,
    members,
    existingCells = [],
    memberDecisions = {},
    subcategoryChoices = {},
    axisOverrides = {},
    replaceCategories = [],
    confirmedCurrencyBlocks = [],
    rowDecisions = {},
  } = input;

  // D-9: 축은 금액 귀속과 소계 대조의 기준이라 다른 무엇보다 먼저 확정한다
  const { blocks, auto: axisAutoByRow } = applyAxisOverrides(inputBlocks, axisOverrides);

  const rosterById = new Map(members.map((member) => [member.id, member]));
  const existingByCategory = new Map(existingCells.map((cell) => [cell.category, cell.rowCount]));
  const replaceSet = new Set(replaceCategories);
  const confirmedCurrency = new Set(confirmedCurrencyBlocks);

  const allDraftRows = blocks.flatMap((entry) => entry.rows);
  const matches = matchDetailMembers(allDraftRows, members).map((match) => ({
    ...match,
    decision: effectiveDecision(match, memberDecisions),
  }));
  const matchByKey = new Map(matches.map((match) => [match.key, match]));

  // D-15: 셀 판정은 행 판정보다 앞선다 — 기존 행이 있는 비목은 통째로 건너뛴다
  const skippedCategories = new Set<BudgetCategory>();
  for (const entry of blocks) {
    const count = existingByCategory.get(entry.block.category) ?? 0;
    if (count > 0 && !replaceSet.has(entry.block.category)) {
      skippedCategories.add(entry.block.category);
    }
  }

  const previewBlocks: DetailPreviewBlock[] = [];
  const previewRows: DetailPreviewRow[] = [];
  const usedTempKeys = new Set<string>();
  // §5.17 order는 "세목 안에서의 순서"다 — (비목, 세목)마다 0부터 센다
  const orderSeq = new Map<string, number>();

  for (const entry of blocks) {
    const { block } = entry;
    const blockKey = detailBlockKey(block);
    const resolution = resolveDetailSubcategory(block, entry.rows, subcategoryChoices[blockKey]);
    const currencyConfirmed = entry.currency === null || confirmedCurrency.has(blockKey);

    previewBlocks.push({
      key: blockKey,
      category: block.category,
      categoryLabel: block.categoryLabel,
      subcategory: resolution.subcategory,
      subcategoryLabel: block.subcategoryLabel,
      source: resolution.source,
      needsConfirm: resolution.needsConfirm,
      currency: entry.currency,
      currencyConfirmed,
      rowCount: entry.rows.length,
    });

    for (const row of entry.rows) {
      const key = detailRowKey(row);
      const issues: DetailPreviewRowIssue[] = [];

      // ─ 성명 → 인력 (D-11~D-13) ─
      let member: DetailMemberInput | null = null;
      let memberRef: DetailMemberRef | null = null;
      let match: DetailMemberMatch | undefined;
      let memberSkipped = false;
      if (row.formula === 'personnel') {
        match = row.memberName === null ? undefined : matchByKey.get(detailMemberKey(row.memberName));
        const decision = match?.decision ?? null;
        if (decision === null) issues.push('member-unresolved');
        else if (decision.kind === 'skip') memberSkipped = true;
        else if (decision.kind === 'existing') {
          const found = rosterById.get(decision.memberId);
          if (found === undefined) issues.push('member-missing');
          else {
            member = found;
            memberRef = { kind: 'existing', memberId: found.id };
          }
        } else if (match !== undefined) {
          // D-12: 새 인력의 연봉은 파일 값이다 → 명부 연봉 = 파일 연봉이라 잠정 조정액이 그대로 확정된다
          const tempKey = `new:${match.key}`;
          member = {
            id: '',
            name: match.fileName,
            position: match.filePosition ?? '',
            annualSalary: match.fileSalary,
            orgId: decision.orgId ?? null,
          };
          memberRef = { kind: 'create', tempKey };
        }
      }

      // ─ D-8a 조정액 확정 ─
      const final = finalizeAmount(yearId, row, resolution.subcategory, member);
      const salaryMismatch = match?.salaryMismatch ?? null;

      // ─ 건너뜀 (오류보다 앞선다) ─
      if (!currencyConfirmed) issues.push('currency-unconfirmed');
      if (skippedCategories.has(block.category)) issues.push('cell-skipped');
      if (memberSkipped) issues.push('member-skipped');
      if (rowDecisions[key] === 'skip') issues.push('row-skipped');
      if (row.status === 'skip-suggested' && rowDecisions[key] !== 'include') {
        issues.push('zero-amount-skipped');
      }

      // ─ 오류 ─
      if (resolution.subcategory === null) issues.push('subcategory-unresolved');
      if (row.issues.includes('amount-unparsable')) issues.push('amount-unparsable');
      if (final.negative) issues.push('negative-amount');

      // ─ 경고 (반영을 막지 않는다) ─
      if (resolution.needsConfirm) issues.push('subcategory-unconfirmed');
      if (final.missingSalary && !issues.includes('member-unresolved')) {
        issues.push('roster-salary-missing');
      }
      if (salaryMismatch !== null) issues.push('salary-mismatch');

      const skipped = issues.some((issue) => SKIP_ISSUES.includes(issue));
      const status: DetailPreviewRowStatus = skipped
        ? 'skipped'
        : issues.some((issue) => ERROR_ISSUES.includes(issue))
          ? 'error'
          : 'new';

      let sortOrder = 0;
      if (status === 'new') {
        const seqKey = `${block.category}|${resolution.subcategory ?? ''}`;
        sortOrder = orderSeq.get(seqKey) ?? 0;
        orderSeq.set(seqKey, sortOrder + 1);
        if (memberRef?.kind === 'create') usedTempKeys.add(memberRef.tempKey);
      }

      previewRows.push({
        key,
        status,
        statusLabel: DETAIL_PREVIEW_STATUS_LABELS[status],
        blockKey,
        sourceRow: row.row,
        category: block.category,
        categoryLabel: block.categoryLabel,
        subcategory: resolution.subcategory,
        subcategoryLabel: block.subcategoryLabel,
        subcategorySource: resolution.source,
        formula: row.formula,
        axis: row.axis,
        axisSuggested: row.axisSuggested,
        axisAuto: axisAutoByRow.get(key) ?? row.axis,
        name: row.name,
        spec: row.spec,
        note: row.note,
        unitPrice: row.unitPrice,
        factors: row.factors,
        memberName: row.memberName,
        memberRef,
        sortOrder,
        formulaAmount: final.formulaAmount,
        fileAmount: row.fileAmount,
        adjustment: final.adjustment,
        amount: final.amount,
        absorbed: final.adjustment !== 0,
        salaryMismatch,
        sourceIssues: row.issues,
        issues,
        reason: reasonOf(issues, {
          // 파일 금액이 그대로 들어가지 않는 유일한 경우다 — 얼마가 빠지는지 숫자로 밝힌다
          'roster-salary-missing': `파일 ${row.fileAmount.toLocaleString('ko-KR')}원 → 반영 ${final.amount.toLocaleString('ko-KR')}원`,
          'salary-mismatch':
            salaryMismatch === null
              ? undefined
              : `파일 ${salaryMismatch.file.toLocaleString('ko-KR')}원 / 명부 ${(salaryMismatch.roster ?? 0).toLocaleString('ko-KR')}원`,
        }),
      });
    }
  }

  // ─ D-12: 행이 실제로 참조하는 새 인력만 만든다 (RPC도 미참조 인력을 거부한다) ─
  const newMembers: DetailImportNewMember[] = [];
  for (const match of matches) {
    const decision = match.decision;
    if (decision === null || decision.kind !== 'create') continue;
    const tempKey = `new:${match.key}`;
    if (!usedTempKeys.has(tempKey)) continue;
    newMembers.push({
      tempKey,
      name: match.fileName,
      position: match.filePosition ?? '',
      annual_salary: match.fileSalary,
      hire_type: match.hireType,
      org_id: decision.orgId ?? null,
    });
  }

  const cells = buildCells(previewRows, blocks, existingByCategory, replaceSet);
  const subtotals = buildSubtotalChecks(blocks);

  const summary: DetailPreviewSummary = {
    new: previewRows.filter((row) => row.status === 'new').length,
    skipped: previewRows.filter((row) => row.status === 'skipped').length,
    error:
      previewRows.filter((row) => row.status === 'error').length +
      cells.filter((cell) => cell.status === 'error').length,
    newMembers: newMembers.length,
    replaceCells: cells.filter((cell) => cell.status === 'replace').length,
    totalAmount: previewRows
      .filter((row) => row.status === 'new')
      .reduce((sum, row) => sum + row.amount, 0),
  };

  return {
    yearId,
    rows: previewRows,
    cells,
    blocks: previewBlocks,
    members: matches,
    newMembers,
    subtotals,
    summary,
    // D-18 소계 불일치·D-14 연봉 차이는 경고다 — 오류만 반영을 막는다
    blocked: summary.error > 0,
  };
}

/**
 * (연차, 비목) 셀 요약. 연차는 하나이므로 비목이 곧 셀이다 (D-19).
 *
 * D-15b: 교체로 지정했는데 넣을 행이 하나도 없으면 **오류**다. 그대로 반영하면 기존 행을 전부
 * 지우고 아무것도 넣지 않는 조작이 되고, 그 셀은 PL-9로 총액만 직전 값에 얼어붙는다.
 */
function buildCells(
  rows: readonly DetailPreviewRow[],
  blocks: readonly DetailBlockInput[],
  existingByCategory: ReadonlyMap<BudgetCategory, number>,
  replaceSet: ReadonlySet<BudgetCategory>
): DetailPreviewCell[] {
  const categories: BudgetCategory[] = [];
  const push = (category: BudgetCategory): void => {
    if (!categories.includes(category)) categories.push(category);
  };
  for (const entry of blocks) push(entry.block.category);
  // 파일에 아예 없는 비목의 교체 지정도 드러낸다 — 그것 역시 내용 없는 삭제다 (D-15b)
  for (const category of replaceSet) push(category);

  return categories.map((category) => {
    const own = rows.filter((row) => row.category === category);
    const included = own.filter((row) => row.status === 'new');
    const existingRows = existingByCategory.get(category) ?? 0;
    const replace = replaceSet.has(category);
    const amount = included.reduce((sum, row) => sum + row.amount, 0);

    if (replace && included.length === 0) {
      return {
        category,
        status: 'error',
        existingRows,
        replace,
        rowCount: 0,
        amount,
        reason:
          '교체로 지정했지만 반영할 행이 없습니다. 기존 행만 지우면 근거 없이 총액만 남습니다 — 지정을 해제하거나 행을 포함시키세요',
      };
    }
    if (existingRows > 0 && !replace) {
      return {
        category,
        status: 'skipped',
        existingRows,
        replace,
        rowCount: 0,
        amount: 0,
        reason: `${EXISTING_CELL_GUIDE} (기존 ${existingRows}행)`,
      };
    }
    return {
      category,
      status: replace ? 'replace' : 'new',
      existingRows,
      replace,
      rowCount: included.length,
      amount,
      reason: replace ? `기존 ${existingRows}행을 지우고 ${included.length}행으로 바꿉니다` : null,
    };
  });
}

/**
 * D-18 소계 대조.
 *
 * **세목 소계는 블록 단위로, 비목 합계는 그 비목의 블록을 합쳐 본다.** 부록 B.8.3의 `L150`
 * (연구활동비 합계 27,020,000)처럼 여러 블록을 덮는 소계는 블록 하나의 행만으로는 절대 맞지 않는다.
 * 그래서 ① 블록 단위 → ② 비목 전체 행·소계로 다시 대조 → ③ 비목 전체 합과 직접 비교의 순으로
 * 맞는 것을 채택한다(③이 필요한 이유: 비목 합계가 세목 표들보다 **앞**에 오는 서식이 있다).
 *
 * 어느 것도 맞지 않으면 블록 단위 결과를 그대로 싣는다 — **경고일 뿐 반영을 막지 않는다.**
 * 파일 소계가 수식 오류이거나 사람이 손으로 덮어쓴 값일 수 있고, 어느 쪽이 맞는지는 사람이 안다.
 */
function buildSubtotalChecks(blocks: readonly DetailBlockInput[]): DetailSubtotalCheck[] {
  const byCategory = new Map<BudgetCategory, DetailBlockInput[]>();
  for (const entry of blocks) {
    const bucket = byCategory.get(entry.block.category);
    if (bucket) bucket.push(entry);
    else byCategory.set(entry.block.category, [entry]);
  }

  const checks: DetailSubtotalCheck[] = [];
  for (const [category, entries] of byCategory) {
    const categoryRows = entries.flatMap((entry) => entry.rows);
    const categorySubtotals = entries.flatMap((entry) => entry.subtotals);
    const folded = compareSubtotals(categoryRows, categorySubtotals);
    const foldedByKey = new Map(folded.map((check) => [`${check.row}:${check.column}:${check.axis}`, check]));

    for (const entry of entries) {
      const blockKey = detailBlockKey(entry.block);
      for (const check of compareSubtotals(entry.rows, entry.subtotals)) {
        const categorySum = sumByAxis(categoryRows, check.axis);
        const base: DetailSubtotalCheck = {
          category,
          subcategory: entry.block.subcategory,
          blockKey,
          label: check.label,
          row: check.row,
          column: check.column,
          axis: check.axis,
          fileValue: check.fileValue,
          ourSum: check.ourSum,
          difference: check.difference,
          matches: check.matches,
          fold: 'block',
          categorySum,
        };
        if (check.matches) {
          checks.push(base);
          continue;
        }
        const categoryCheck = foldedByKey.get(`${check.row}:${check.column}:${check.axis}`);
        if (categoryCheck !== undefined && categoryCheck.matches) {
          checks.push({
            ...base,
            ourSum: categoryCheck.ourSum,
            difference: categoryCheck.difference,
            matches: true,
            fold: 'category',
          });
          continue;
        }
        if (check.fileValue === categorySum) {
          checks.push({ ...base, ourSum: categorySum, difference: 0, matches: true, fold: 'category' });
          continue;
        }
        checks.push(base);
      }
    }
  }
  return checks;
}

function sumByAxis(rows: readonly DetailDraftRow[], axis: DetailAxis | 'total'): number {
  let sum = 0;
  for (const row of rows) {
    if (axis !== 'total' && row.axis !== axis) continue;
    sum += row.fileAmount;
  }
  return sum;
}

// ─── 반영 대상 변환 (§7.9.3 Step 4 → commit_detail_import) ────

export interface DetailCommitPayload {
  yearId: string;
  /** D-12: 같은 트랜잭션에서 만들 인력 */
  newMembers: DetailImportNewMember[];
  rows: DetailImportRow[];
  /** D-15: 기존 행을 지우고 교체할 비목 */
  replaceCategories: BudgetCategory[];
}

/**
 * 미리보기 → commit_detail_import RPC 페이로드. **판정을 다시 하지 않는다** —
 * `blocked`는 buildDetailPreview가 이미 계산했고, 같은 규칙이 두 곳에 생기면 반드시 어긋난다
 * (toCommitRows와 같은 규약).
 *
 * `amount`는 여기서 계산하지 않는다. 미리보기가 D-8a로 확정한 값 그대로다 (PL-10a).
 */
export function toDetailCommitRows(preview: DetailImportPreview): DetailCommitPayload {
  if (preview.blocked) {
    throw new RuleViolationError(
      `반영할 수 없습니다 — 오류 ${preview.summary.error}건. 해당 행을 건너뛰기로 제외하거나 세목·성명 지정을 마친 뒤 다시 시도하세요.`
    );
  }

  const rows: DetailImportRow[] = [];
  for (const row of preview.rows) {
    if (row.status !== 'new') continue;
    if (row.subcategory === null) {
      // blocked가 아닌데 반영 대상 행에 세목이 없으면 파이프라인이 깨진 것이다. 조용히 건너뛰지 않는다
      throw new RuleViolationError('반영 대상 행에 세목이 없습니다. 미리보기를 다시 확인하세요.');
    }
    if (row.formula === 'personnel' && row.memberRef === null) {
      throw new RuleViolationError('인건비 행에 참여인력이 지정되지 않았습니다. 미리보기를 다시 확인하세요.');
    }
    rows.push({
      category: row.category,
      subcategory: row.subcategory,
      axis: row.axis,
      formula: row.formula,
      amount: row.amount,
      member_id: row.memberRef?.kind === 'existing' ? row.memberRef.memberId : null,
      memberTempKey: row.memberRef?.kind === 'create' ? row.memberRef.tempKey : null,
      name: row.name,
      spec: row.spec,
      note: row.note,
      unit_price: row.unitPrice,
      factors: row.factors,
      adjustment: row.adjustment,
      sort_order: row.sortOrder,
    });
  }

  return {
    yearId: preview.yearId,
    newMembers: preview.newMembers,
    rows,
    // D-15b를 통과한 셀만 남는다 — 교체 지정에 넣을 행이 없으면 위에서 blocked였다
    replaceCategories: preview.cells
      .filter((cell) => cell.status === 'replace')
      .map((cell) => cell.category),
  };
}
