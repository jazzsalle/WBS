// 엑셀 가져오기 마법사의 공유 상태·헬퍼 (SOT §7.9.1, §5.12.2 ImportDraft)
//
// 순수 모듈이다. 서버 액션을 부르지 않고, 파싱도 하지 않는다 —
// 파싱은 전부 서버 액션(actions/import.ts)이 하고 여기서는 그 결과를 담을 그릇만 만든다 (I-13).
//
// ImportWizard와 각 Step이 함께 쓰는 타입을 한 곳에 모아 순환 import를 만들지 않는다.

import type {
  BudgetCategory,
  ImportDraft,
  ImportProfile,
  PreviewImportResult,
  SheetGridPreview,
  Year,
} from '@/types';
import type { ActionErrorCode } from '@/lib/db/errors';

// ─── 업로드 규약 (lib/import-adapter.ts와 같은 값) ────────────
//
// `lib/import-adapter.ts`는 `import 'server-only'`라 클라이언트에서 읽을 수 없다.
// 상한을 업로드 **전에** 알려주려면(§7.9.1 Step 1) 같은 값을 여기 한 벌 둘 수밖에 없다.
// 값이 갈라지면 서버가 거부하므로 조용히 틀리지는 않는다.

/** FormData 필드명. `lib/import-adapter.ts`의 UPLOAD_FIELD와 같아야 한다 */
export const UPLOAD_FIELD = 'file';

/** I-15 파일 10MB 상한 — 업로드 전에 막고 이유를 표시한다 */
export const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;

/** §6.8.1 ① 허용 확장자 */
export const ACCEPTED_EXTENSIONS = ['.xlsx', '.xlsm', '.xls', '.csv'] as const;

export const ACCEPT_ATTRIBUTE = ACCEPTED_EXTENSIONS.join(',');

// ─── 마법사 단계 ─────────────────────────────────────────────

export type WizardStep = 1 | 2 | 3 | 4 | 5;

export const STEP_TITLES: Record<WizardStep, string> = {
  1: '파일',
  2: '시트 & 범위',
  3: '열 매핑',
  4: '비목 매핑',
  5: '미리보기 & 반영',
};

export interface Failure {
  message: string;
  code?: ActionErrorCode;
}

/** 마법사가 쓰는 최소 연차 정보 (S-5 연차 열 대응) */
export interface WizardYear {
  id: string;
  name: string;
  order: number;
}

export function toWizardYears(years: readonly Year[]): WizardYear[] {
  return years
    .map((year) => ({ id: year.id, name: year.name, order: year.order }))
    .sort((a, b) => a.order - b.order);
}

// ─── ImportDraft 초기값 ──────────────────────────────────────

/**
 * §5.12.2 ImportDraft의 빈 값.
 *
 * `profile.name`은 프로파일을 저장하지 않더라도 **비워 둘 수 없다** —
 * previewImport/commitImport가 ImportProfile 필드 스키마로 draft를 검증하고,
 * 그 스키마의 name은 min(1)이다. 파일명을 임시 이름으로 넣는다.
 */
export function initialDraft(projectId: string): ImportDraft {
  return {
    profile: {
      name: '엑셀 가져오기',
      kind: 'budget_plan',
      ministry: null,
      projectId,
      sheetName: null,
      headerRow: 0,
      dataStartRow: 1,
      orientation: 'row',
      labelColumns: [],
      yearColumnMappings: [],
      categoryAliases: {},
      amountUnit: 1,
      skipRowPatterns: [],
    },
    yearMapping: {},
    skippedRowIndexes: [],
    manualCategoryByRow: {},
    fileHash: '',
  };
}

/** §6.8.1: 프로파일을 고르면 ③~④(구조 감지·열 매핑)를 건너뛴다. ⑤ 비목 매핑부터는 건너뛰지 않는다 */
export function draftFromProfile(profile: ImportProfile, projectId: string): ImportDraft {
  return {
    profile: {
      name: profile.name,
      kind: profile.kind,
      ministry: profile.ministry,
      projectId,
      sheetName: profile.sheetName,
      headerRow: profile.headerRow,
      dataStartRow: profile.dataStartRow,
      orientation: profile.orientation,
      labelColumns: [...profile.labelColumns],
      yearColumnMappings: profile.yearColumnMappings.map((m) => ({ ...m })),
      categoryAliases: { ...profile.categoryAliases },
      amountUnit: profile.amountUnit,
      skipRowPatterns: [...profile.skipRowPatterns],
    },
    yearMapping: {},
    skippedRowIndexes: [],
    manualCategoryByRow: {},
    fileHash: '',
  };
}

/**
 * S-5 자동 추정: `N차년도` 열 → `order = N-1`인 Year.
 * 대응되는 연차가 없으면 비워 둔다 — 임의로 가까운 연차에 붙이면 금액이 엉뚱한 해에 들어간다.
 */
export function autoYearMapping(
  yearColumnMappings: readonly { column: string; yearOrder: number }[],
  years: readonly WizardYear[]
): Record<string, string> {
  const byOrder = new Map(years.map((year) => [year.order, year.id] as const));
  const mapping: Record<string, string> = {};
  for (const { column, yearOrder } of yearColumnMappings) {
    const yearId = byOrder.get(yearOrder);
    if (yearId) mapping[column] = yearId;
  }
  return mapping;
}

// ─── 업로드 헬퍼 ─────────────────────────────────────────────

/**
 * 액션은 스테이트리스라 단계마다 파일을 다시 보낸다 (I-14: 서버는 파싱 후 즉시 폐기).
 * FormData는 재사용하지 않고 매번 새로 만든다.
 */
export function buildFormData(file: File): FormData {
  const formData = new FormData();
  formData.set(UPLOAD_FIELD, file);
  return formData;
}

export function hasAcceptedExtension(fileName: string): boolean {
  const lower = fileName.toLowerCase();
  return ACCEPTED_EXTENSIONS.some((ext) => lower.endsWith(ext));
}

/** 업로드 **전** 거부 사유. 통과하면 null (§7.9.1 Step 1) */
export function rejectReason(file: File): string | null {
  if (!hasAcceptedExtension(file.name)) {
    return `지원하지 않는 파일 형식입니다. ${ACCEPTED_EXTENSIONS.join(', ')} 파일만 올릴 수 있습니다.`;
  }
  if (file.size > MAX_UPLOAD_BYTES) {
    return `파일이 ${formatBytes(file.size)}로 상한 10MB를 넘습니다. 필요한 시트만 남겨서 다시 올려주세요.`;
  }
  if (file.size === 0) return '빈 파일입니다.';
  return null;
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)}MB`;
}

// ─── 그리드 조회 ─────────────────────────────────────────────

/** 라벨 열들 중 **가장 오른쪽 비어 있지 않은** 텍스트 (S-3의 "가장 구체적인 라벨"과 같은 방향) */
export function labelFromGrid(
  grid: SheetGridPreview | null,
  rowIndex: number,
  labelColumnIndexes: readonly number[]
): string | null {
  const row = grid?.rows[rowIndex];
  if (!row) return null;
  for (let i = labelColumnIndexes.length - 1; i >= 0; i -= 1) {
    const text = row[labelColumnIndexes[i]!]?.text ?? '';
    if (text.trim() !== '') return text.trim();
  }
  return null;
}

// ─── Step 4 비목 매핑 항목 ───────────────────────────────────

/** §7.9.1 Step 4 상태 아이콘 */
export type MappingStatus =
  | 'exact' // ✅ 완전일치
  | 'alias' // 🔵 별칭사전(부처 프리셋 포함)
  | 'manual' // 🔵 사용자 지정
  | 'fuzzy' // ⚠️ 유사매칭 — 확인 필요
  | 'ambiguous' // ⚠️ 구 비목 체계 — 선택 필요 (I-6)
  | 'unmapped' // ❌ 미매핑
  | 'skipped'; // 건너뜀

export interface MappingEntry {
  /** 0-based 원본 시트 행 */
  rowIndex: number;
  label: string;
  status: MappingStatus;
  category: BudgetCategory | null;
  /** 건너뜀·미매핑 사유 (서버가 준 문구 그대로) */
  reason: string | null;
  /** I-3 퍼지·I-6 모호에서 사용자가 골라야 하는지 */
  needsDecision: boolean;
}

export const MAPPING_STATUS_ICON: Record<MappingStatus, string> = {
  exact: '✅',
  alias: '🔵',
  manual: '🔵',
  fuzzy: '⚠️',
  ambiguous: '⚠️',
  unmapped: '❌',
  skipped: '⬜',
};

export const MAPPING_STATUS_LABEL: Record<MappingStatus, string> = {
  exact: '완전일치',
  alias: '별칭사전',
  manual: '사용자 지정',
  fuzzy: '유사매칭 (확인필요)',
  ambiguous: '구 비목 체계 (선택필요)',
  unmapped: '미매핑',
  skipped: '건너뜀',
};

export const MAPPING_STATUS_CLASS: Record<MappingStatus, string> = {
  exact: 'text-green-700',
  alias: 'text-blue-700',
  manual: 'text-blue-700 font-semibold',
  fuzzy: 'text-orange-700',
  ambiguous: 'text-orange-700',
  unmapped: 'text-red-700 font-semibold',
  skipped: 'text-grey-400',
};

/** 미리보기 오류 행의 사유가 "비목을 못 정했다"는 뜻인지 (금액 셀 오류와 구분) */
export function categoryIssueOf(reason: string | null): 'fuzzy' | 'ambiguous' | 'unmapped' | null {
  if (!reason) return null;
  if (reason.startsWith('유사 매칭')) return 'fuzzy';
  if (reason.startsWith('구 비목 체계')) return 'ambiguous';
  if (reason.startsWith('미매핑')) return 'unmapped';
  return null;
}

/** 미리보기에서 아직 사용자 결정이 필요한 행이 남았는가 (Step 4 → 5 안내용) */
export function unresolvedCount(preview: PreviewImportResult | null): number {
  if (!preview) return 0;
  return preview.rows.filter(
    (row) => row.status === 'error' && categoryIssueOf(row.reason) !== null
  ).length;
}
