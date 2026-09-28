// `_meta` 시트의 쓰기·읽기·검증 (SOT §6.16 IN-2).
//
// 키/값 2열의 왕복이다. `buildMetaRows`가 만든 것을 `parseMeta`가 그대로 되돌려야 하며
// (tests/unit/input-form-layout.test.ts가 고정), 검증은 `checkMeta` 한 곳에서만 한다 —
// 미리보기와 반영이 같은 거부 규칙을 타야 한다(IN-6).

import { cellText } from '@/lib/import/grid';
import type { RawSheet } from '@/lib/import/types';
import {
  INPUT_FORM_SHEETS,
  META_DETAIL_PREFIX,
  META_EXECUTION_PREFIX,
  META_KEYS,
  META_MEMBER_PREFIX,
  META_SUBCATEGORY_PREFIX,
  columnOf,
} from './layout';
import type { InputFormMode } from './layout';
import type { ExecutionFormMeta, FormCell, InputFormMeta, InputFormRejection } from './types';

const META = INPUT_FORM_SHEETS.meta;

/**
 * 헤더 행을 포함한 `_meta` 시트 전체 행. 생성기가 `FormSheet.rows`에 그대로 넣는다.
 * 목록 항목은 값이 아니라 **키**에 담는다(`subcategory:<code>`) — 값 칸은 읽기 편하라고 같은 값을 둔다.
 * `execution:<id>`만 예외로 값 칸이 version이다(IN-2).
 *
 * `mode`·`execution:`·`detail:` 행은 **수행 양식에만** 쓴다(IN-2) — 제안 양식의 행은 Phase 19와 같아야 한다.
 * 그래서 `meta.mode`가 'plan'이어도 mode 행을 쓰지 않는다(없으면 제안이다).
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
  if (meta.mode === 'execution') rows.push(row(META_KEYS.mode, meta.mode));
  for (const code of meta.subcategoryCodes) rows.push(row(`${META_SUBCATEGORY_PREFIX}${code}`, code));
  for (const id of meta.memberIds) rows.push(row(`${META_MEMBER_PREFIX}${id}`, id));
  if (meta.mode === 'execution') {
    for (const [id, version] of Object.entries(meta.executions ?? {})) {
      rows.push(row(`${META_EXECUTION_PREFIX}${id}`, version));
    }
    for (const id of meta.detailIds ?? []) rows.push(row(`${META_DETAIL_PREFIX}${id}`, id));
  }
  return rows;
}

/** 제안 파일(mode 행 없음)은 'plan'이다(IN-2). mode를 읽을 때는 필드가 아니라 이 함수를 쓴다 */
export function metaMode(meta: InputFormMeta): InputFormMode {
  return meta.mode ?? 'plan';
}

/** 수행 파서가 `parseMeta` 결과를 좁힐 때 쓴다 — mode 'execution'이면 목록 두 개가 늘 있다 */
export function isExecutionMeta(meta: InputFormMeta): meta is ExecutionFormMeta {
  return meta.mode === 'execution' && meta.executions !== undefined && meta.detailIds !== undefined;
}

function parseMode(text: string): InputFormMode | null {
  return text === 'plan' || text === 'execution' ? text : null;
}

function parseFormVersion(text: string): number | null {
  if (text === '') return null;
  const n = Number(text);
  return Number.isInteger(n) ? n : null;
}

// version은 O-1 기준값이다(IN-10) — 1 미만·소수는 우리가 쓴 값이 아니다
function parseExecutionVersion(text: string): number | null {
  const n = parseFormVersion(text);
  return n !== null && n >= 1 ? n : null;
}

/**
 * `_meta` 시트 → 메타. 필수 키(formVersion·projectId·yearId) 중 하나라도 없거나 버전이 정수가
 * 아니면 null — 호출부는 이것을 "양식 정보 없음"으로 거부한다. 모르는 키는 무시한다.
 *
 * mode 행이 없으면 제안 양식이고 결과에 `mode`·`executions`·`detailIds` 키를 만들지 않는다 —
 * 제안 파일의 왕복 결과가 Phase 19와 같아야 한다. mode는 `metaMode()`로 읽는다.
 * mode 값을 모르거나 `execution:` 행의 version이 양의 정수가 아니면 null이다 — 충돌 판정 기준이
 * 깨진 파일을 추측으로 살리지 않는다(IN-10).
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
  let mode: InputFormMode | null | undefined;
  let executionsValid = true;
  const executions: Record<string, number> = {};
  const detailIds: string[] = [];

  for (let r = META.dataStartRow - 1; r < sheet.cells.length; r += 1) {
    const cells = sheet.cells[r] ?? [];
    const key = cellText(cells[keyCol]);
    if (key === '') continue;
    const value = cellText(cells[valueCol]);

    if (key === META_KEYS.formVersion) formVersion = parseFormVersion(value);
    else if (key === META_KEYS.projectId) projectId = value;
    else if (key === META_KEYS.yearId) yearId = value;
    else if (key === META_KEYS.generatedAt) generatedAt = value;
    else if (key === META_KEYS.mode) mode = parseMode(value);
    else if (key.startsWith(META_EXECUTION_PREFIX)) {
      const version = parseExecutionVersion(value);
      if (version === null) executionsValid = false;
      else executions[key.slice(META_EXECUTION_PREFIX.length)] = version;
    } else if (key.startsWith(META_DETAIL_PREFIX)) {
      detailIds.push(key.slice(META_DETAIL_PREFIX.length));
    } else if (key.startsWith(META_SUBCATEGORY_PREFIX)) {
      subcategoryCodes.push(key.slice(META_SUBCATEGORY_PREFIX.length));
    } else if (key.startsWith(META_MEMBER_PREFIX)) {
      memberIds.push(key.slice(META_MEMBER_PREFIX.length));
    }
  }

  if (formVersion === null || projectId === '' || yearId === '') return null;
  if (mode === null) return null;
  const base: InputFormMeta = { formVersion, projectId, yearId, generatedAt, subcategoryCodes, memberIds };
  // 제안 파일에 수행 목록 행이 섞여 있어도 제안 경로는 그 목록을 쓰지 않는다 — 결과 모양만 Phase 19로 둔다
  if (mode !== 'execution') return mode === 'plan' ? { ...base, mode } : base;
  if (!executionsValid) return null;
  return { ...base, mode, executions, detailIds };
}

export const NO_META_MESSAGE =
  '이 파일에는 입력 양식 정보가 없습니다 — [입력 양식 내려받기]로 받은 파일만 올릴 수 있습니다';
export const PROJECT_MISMATCH_MESSAGE = '이 과제의 양식이 아닙니다';
export const VERSION_MISMATCH_MESSAGE = '양식 버전이 다릅니다 — 다시 내려받으세요';
/** 키는 **파일의** mode다(IN-9). 제안 파일을 수행 모드에서 올리면 'plan' 문구 */
export const MODE_MISMATCH_MESSAGES: Readonly<Record<InputFormMode, string>> = {
  plan: '제안 양식입니다 — 제안 모드에서 올리세요',
  execution: '수행 양식입니다 — 수행 모드에서 올리세요',
};

/**
 * IN-2·IN-9 거부 4종. 통과하면 null. 순서는 과제 → 버전 → mode — 남의 과제 파일은 버전·mode와
 * 무관하게 남의 것이고, 버전이 다른 파일은 mode 행의 의미부터 믿을 수 없다.
 * `expected.mode`를 생략하면 제안 모드다(Phase 17·19 호출부).
 */
export function checkMeta(
  meta: InputFormMeta | null,
  expected: { projectId: string; formVersion: number; mode?: InputFormMode }
): InputFormRejection | null {
  if (meta === null) return { kind: 'no-meta', message: NO_META_MESSAGE };
  if (meta.projectId !== expected.projectId) {
    return { kind: 'project-mismatch', message: PROJECT_MISMATCH_MESSAGE };
  }
  if (meta.formVersion !== expected.formVersion) {
    return { kind: 'version-mismatch', message: VERSION_MISMATCH_MESSAGE };
  }
  const fileMode = metaMode(meta);
  if (fileMode !== (expected.mode ?? 'plan')) {
    return { kind: 'mode-mismatch', message: MODE_MISMATCH_MESSAGES[fileMode] };
  }
  return null;
}
