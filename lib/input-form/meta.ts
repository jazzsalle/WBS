// `_meta` 시트의 쓰기·읽기·검증 (SOT §6.16 IN-2).
//
// 키/값 2열의 왕복이다. `buildMetaRows`가 만든 것을 `parseMeta`가 그대로 되돌려야 하며
// (tests/unit/input-form-layout.test.ts가 고정), 검증은 `checkMeta` 한 곳에서만 한다 —
// 미리보기와 반영이 같은 거부 규칙을 타야 한다(IN-6).

import { cellText } from '@/lib/import/grid';
import type { RawSheet } from '@/lib/import/types';
import { INPUT_FORM_SHEETS, META_KEYS, META_MEMBER_PREFIX, META_SUBCATEGORY_PREFIX, columnOf } from './layout';
import type { FormCell, InputFormMeta, InputFormRejection } from './types';

const META = INPUT_FORM_SHEETS.meta;

/**
 * 헤더 행을 포함한 `_meta` 시트 전체 행. 생성기가 `FormSheet.rows`에 그대로 넣는다.
 * 목록 항목은 값이 아니라 **키**에 담는다(`subcategory:<code>`) — 값 칸은 읽기 편하라고 같은 값을 둔다.
 * `mode` 행은 쓰지 않는다 — 행의 존재가 곧 옛 수행 양식의 표지다(IN-2).
 */
export function buildMetaRows(meta: InputFormMeta): FormCell[][] {
  const keyCol = columnOf(META, 'key');
  const valueCol = columnOf(META, 'value');

  const row = (key: string, value: string | number): FormCell[] => {
    const cells: FormCell[] = Array.from({ length: META.columns.length }, () => ({}));
    cells[keyCol] = { value: key };
    cells[valueCol] = { value };
    return cells;
  };

  const rows: FormCell[][] = [];
  // 헤더 행 앞에 빈 행이 필요하면(headerRow > 1) 그만큼 채운다 — 좌표 맵이 바뀌어도 여기는 그대로다
  for (let r = 1; r < META.headerRow; r += 1) rows.push([]);
  rows.push(META.columns.map((column) => ({ value: column.label })));
  for (let r = META.headerRow + 1; r < META.dataStartRow; r += 1) rows.push([]);

  rows.push(row(META_KEYS.formVersion, meta.formVersion));
  rows.push(row(META_KEYS.projectId, meta.projectId));
  rows.push(row(META_KEYS.yearId, meta.yearId));
  rows.push(row(META_KEYS.generatedAt, meta.generatedAt));
  for (const code of meta.subcategoryCodes) rows.push(row(`${META_SUBCATEGORY_PREFIX}${code}`, code));
  for (const id of meta.memberIds) rows.push(row(`${META_MEMBER_PREFIX}${id}`, id));
  return rows;
}

function parseFormVersion(text: string): number | null {
  if (text === '') return null;
  const n = Number(text);
  return Number.isInteger(n) ? n : null;
}

/**
 * `_meta` 시트 → 메타. 필수 키(formVersion·projectId·yearId) 중 하나라도 없거나 버전이 정수가
 * 아니면 null — 호출부는 이것을 "양식 정보 없음"으로 거부한다. 모르는 키는 무시한다.
 *
 * `mode` 행이 있으면 값을 보지 않고 `hasModeRow: true`만 남긴다 — 거부는 `checkMeta`가 한다(IN-2).
 * 없으면 그 키를 만들지 않는다 — 제안 파일의 왕복 결과가 Phase 19와 같아야 한다.
 */
export function parseMeta(sheet: RawSheet): InputFormMeta | null {
  const keyCol = columnOf(META, 'key');
  const valueCol = columnOf(META, 'value');

  let formVersion: number | null = null;
  let projectId = '';
  let yearId = '';
  let generatedAt = '';
  const subcategoryCodes: string[] = [];
  const memberIds: string[] = [];
  let hasModeRow = false;

  for (let r = META.dataStartRow - 1; r < sheet.cells.length; r += 1) {
    const cells = sheet.cells[r] ?? [];
    const key = cellText(cells[keyCol]);
    if (key === '') continue;
    const value = cellText(cells[valueCol]);

    if (key === META_KEYS.formVersion) formVersion = parseFormVersion(value);
    else if (key === META_KEYS.projectId) projectId = value;
    else if (key === META_KEYS.yearId) yearId = value;
    else if (key === META_KEYS.generatedAt) generatedAt = value;
    else if (key === META_KEYS.mode) hasModeRow = true;
    else if (key.startsWith(META_SUBCATEGORY_PREFIX)) {
      subcategoryCodes.push(key.slice(META_SUBCATEGORY_PREFIX.length));
    } else if (key.startsWith(META_MEMBER_PREFIX)) {
      memberIds.push(key.slice(META_MEMBER_PREFIX.length));
    }
  }

  if (formVersion === null || projectId === '' || yearId === '') return null;
  const meta: InputFormMeta = { formVersion, projectId, yearId, generatedAt, subcategoryCodes, memberIds };
  return hasModeRow ? { ...meta, hasModeRow: true } : meta;
}

export const NO_META_MESSAGE =
  '이 파일에는 입력 양식 정보가 없습니다 — [입력 양식 내려받기]로 받은 파일만 올릴 수 있습니다';
export const PROJECT_MISMATCH_MESSAGE = '이 과제의 양식이 아닙니다';
export const VERSION_MISMATCH_MESSAGE = '양식 버전이 다릅니다 — 다시 내려받으세요';
export const LEGACY_MODE_ROW_MESSAGE =
  '수행 양식(집행 내역) 파일입니다 — 집행 관리 기능이 삭제되어 올릴 수 없습니다. 제안 모드에서 [입력 양식 내려받기]로 받은 양식을 쓰세요.';

/**
 * IN-2 거부 4종. 통과하면 null. 순서는 과제 → 버전 → `mode` 행 — 남의 과제 파일은 버전과 무관하게
 * 남의 것이고, 버전이 다른 파일은 다시 내려받으라는 안내가 먼저다. 옛 수행 양식을 제안 양식으로
 * 읽어 반영하면 사용자가 모르는 데이터 변경이 되므로 `mode` 행은 값과 무관하게 거부한다.
 */
export function checkMeta(
  meta: InputFormMeta | null,
  expected: { projectId: string; formVersion: number }
): InputFormRejection | null {
  if (meta === null) return { kind: 'no-meta', message: NO_META_MESSAGE };
  if (meta.projectId !== expected.projectId) {
    return { kind: 'project-mismatch', message: PROJECT_MISMATCH_MESSAGE };
  }
  if (meta.formVersion !== expected.formVersion) {
    return { kind: 'version-mismatch', message: VERSION_MISMATCH_MESSAGE };
  }
  if (meta.hasModeRow === true) return { kind: 'legacy-mode-row', message: LEGACY_MODE_ROW_MESSAGE };
  return null;
}
