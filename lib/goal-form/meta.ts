// 목표 양식 `_meta` 시트의 쓰기·읽기·검증과 라벨 만들기 (SOT §6.17 GF-1~GF-4).
//
// 키/값 2열의 왕복이다. `buildGoalMetaRows`가 만든 것을 `parseGoalMeta`가 그대로 되돌려야 하며
// (tests/unit/goal-form-layout.test.ts가 고정), 거부 판정은 `checkGoalMeta` 한 곳에서만 한다 —
// 미리보기와 반영이 같은 거부 규칙을 타야 한다(IN-6).

import { cellText } from '@/lib/import/grid';
import type { RawSheet } from '@/lib/import/types';
import type { FormCell } from '@/lib/input-form/types';
import type { Year } from '@/types';
import { GOAL_FORM_KIND, GOAL_FORM_VERSION, GOAL_META_KEYS, GOAL_META_PREFIXES, goalColumnOf, goalSheetsFor } from './layout';
import type { GoalFormMeta, GoalFormRejection, GoalMetaCheck, GoalMetaLabel, GoalMetaParse } from './types';

// `_meta` 좌표는 연차 수와 무관하다
const META = goalSheetsFor(0).meta;

// ─── 라벨 (GF-3·GF-4) ────────────────────────────────────────

/**
 * 이름 목록 → 양식에 적을 라벨. 앞뒤 공백을 떼고(파서가 셀 값을 그렇게 읽는다), 겹치면 두 번째부터
 * `이름 (2)`·`이름 (3)`. 매칭이 `_meta` 라벨 완전 일치뿐이라(GF-4) 라벨이 겹치면 고를 수 없다.
 * 원래 이름이 `A (2)`인 항목이 따로 있으면 그 라벨은 건너뛴다 — 만든 라벨이 실제 이름을 가로채지 않게.
 */
export function disambiguateLabels(names: readonly string[]): string[] {
  const trimmed = names.map((name) => name.trim());
  const reserved = new Set(trimmed);
  const used = new Set<string>();
  return trimmed.map((name) => {
    let label = name;
    if (used.has(label)) {
      let n = 2;
      while (used.has(`${name} (${n})`) || reserved.has(`${name} (${n})`)) n += 1;
      label = `${name} (${n})`;
    }
    used.add(label);
    return label;
  });
}

/** 연차 라벨 = `year.name`, 비면 `${order+1}차년도`(입력 양식과 같다, GF-3) */
export function goalYearName(year: Pick<Year, 'name' | 'order'>): string {
  const name = year.name.trim();
  return name === '' ? `${year.order + 1}차년도` : name;
}

/** 연차 열 순서대로 받은 연차 → 겹치지 않는 라벨 */
export function goalYearLabels(years: readonly Pick<Year, 'name' | 'order'>[]): string[] {
  return disambiguateLabels(years.map(goalYearName));
}

/** 연차 열 순서의 id(GF-2) */
export function goalMetaYearIds(meta: GoalFormMeta): string[] {
  return meta.years.map((year) => year.id);
}

// ─── 쓰기 ───────────────────────────────────────────────────

type VersionGroup = 'deliverables' | 'achievements' | 'techTargets' | 'records';
type LabelGroup = 'years' | 'orgs' | 'members';

const LABEL_PREFIX: Readonly<Record<LabelGroup, string>> = {
  years: GOAL_META_PREFIXES.year,
  orgs: GOAL_META_PREFIXES.org,
  members: GOAL_META_PREFIXES.member,
};

const VERSION_PREFIX: Readonly<Record<VersionGroup, string>> = {
  deliverables: GOAL_META_PREFIXES.deliverable,
  achievements: GOAL_META_PREFIXES.achievement,
  techTargets: GOAL_META_PREFIXES.techTarget,
  records: GOAL_META_PREFIXES.record,
};

const LABEL_GROUPS = Object.keys(LABEL_PREFIX) as LabelGroup[];
const VERSION_GROUPS = Object.keys(VERSION_PREFIX) as VersionGroup[];

// version은 O-1 기준값이다(GF-5) — 1 미만·소수는 우리가 쓴 값이 아니다
function isVersion(n: number): boolean {
  return Number.isInteger(n) && n >= 1;
}

/**
 * 헤더 행을 포함한 `_meta` 시트 전체 행. 생성기가 `FormSheet.rows`에 그대로 넣는다.
 * 목록 항목은 키에 id를 담고(`org:<id>`) 값에 라벨 또는 version을 담는다(GF-1).
 * 파서가 거부할 메타(겹친 id·라벨, 양의 정수가 아닌 version)는 쓰지 않고 throw한다 — 받자마자 못 올리는 파일이 된다.
 */
export function buildGoalMetaRows(meta: GoalFormMeta): FormCell[][] {
  const keyCol = goalColumnOf(META, 'key');
  const valueCol = goalColumnOf(META, 'value');

  const row = (key: string, value: string | number): FormCell[] => {
    const cells: FormCell[] = Array.from({ length: META.columns.length }, () => ({}));
    cells[keyCol] = { value: key };
    cells[valueCol] = { value };
    return cells;
  };

  const rows: FormCell[][] = [];
  for (let r = 1; r < META.headerRow; r += 1) rows.push([]);
  rows.push(META.columns.map((column) => ({ value: column.label })));
  for (let r = META.headerRow + 1; r < META.dataStartRow; r += 1) rows.push([]);

  rows.push(row(GOAL_META_KEYS.form, GOAL_FORM_KIND));
  rows.push(row(GOAL_META_KEYS.formVersion, meta.formVersion));
  rows.push(row(GOAL_META_KEYS.projectId, meta.projectId));
  rows.push(row(GOAL_META_KEYS.generatedAt, meta.generatedAt));

  for (const group of LABEL_GROUPS) {
    const ids = new Set<string>();
    const labels = new Set<string>();
    for (const { id, label } of meta[group]) {
      if (id === '' || ids.has(id)) throw new Error(`_meta ${group}: id가 비었거나 겹친다 (${id})`);
      if (labels.has(label)) throw new Error(`_meta ${group}: 라벨 '${label}'이 겹친다 — disambiguateLabels를 거쳐야 한다`);
      ids.add(id);
      labels.add(label);
      rows.push(row(`${LABEL_PREFIX[group]}${id}`, label));
    }
  }
  for (const group of VERSION_GROUPS) {
    for (const [id, version] of Object.entries(meta[group])) {
      if (id === '' || !isVersion(version)) throw new Error(`_meta ${group}: 올바르지 않은 행 (${id} = ${version})`);
      rows.push(row(`${VERSION_PREFIX[group]}${id}`, version));
    }
  }
  return rows;
}

// ─── 읽기 ───────────────────────────────────────────────────

function parseInteger(text: string): number | null {
  if (text === '') return null;
  const n = Number(text);
  return Number.isInteger(n) ? n : null;
}

const EMPTY_PARSE: GoalMetaParse = { form: null, projectId: '', formVersion: null, meta: null };

/**
 * `_meta` 시트 → 파싱 결과. 시트가 없으면(`null`) form·meta 모두 null이다. 모르는 키는 무시한다.
 * 본문(`meta`)은 form = goal·과제·버전 값이 있고 다음이 모두 참일 때만 채운다 — 아니면 null이고
 * 충돌 판정 기준이 깨진 파일을 추측으로 살리지 않는다(GF-5):
 * - `deliverable:`·`achievement:`·`techTarget:`·`record:` 값이 전부 양의 정수
 * - 같은 접두 안에서 id가 겹치지 않고, 연차·기관·인력 라벨도 겹치지 않는다(GF-4 완전 일치가 하나로 정해져야 한다)
 */
export function parseGoalMeta(sheet: RawSheet | null | undefined): GoalMetaParse {
  if (sheet === null || sheet === undefined) return EMPTY_PARSE;
  const keyCol = goalColumnOf(META, 'key');
  const valueCol = goalColumnOf(META, 'value');

  let form: string | null = null;
  let projectId = '';
  let formVersion: number | null = null;
  let generatedAt = '';
  let bodyValid = true;
  const labels: Record<LabelGroup, GoalMetaLabel[]> = { years: [], orgs: [], members: [] };
  const versions: Record<VersionGroup, Record<string, number>> = {
    deliverables: {},
    achievements: {},
    techTargets: {},
    records: {},
  };

  for (let r = META.dataStartRow - 1; r < sheet.cells.length; r += 1) {
    const cells = sheet.cells[r] ?? [];
    const key = cellText(cells[keyCol]);
    if (key === '') continue;
    const value = cellText(cells[valueCol]);

    if (key === GOAL_META_KEYS.form) form = value;
    else if (key === GOAL_META_KEYS.projectId) projectId = value;
    else if (key === GOAL_META_KEYS.formVersion) formVersion = parseInteger(value);
    else if (key === GOAL_META_KEYS.generatedAt) generatedAt = value;
    else {
      const labelGroup = LABEL_GROUPS.find((group) => key.startsWith(LABEL_PREFIX[group]));
      if (labelGroup !== undefined) {
        const id = key.slice(LABEL_PREFIX[labelGroup].length);
        const list = labels[labelGroup];
        if (id === '' || list.some((entry) => entry.id === id || entry.label === value)) bodyValid = false;
        else list.push({ id, label: value });
        continue;
      }
      const versionGroup = VERSION_GROUPS.find((group) => key.startsWith(VERSION_PREFIX[group]));
      if (versionGroup !== undefined) {
        const id = key.slice(VERSION_PREFIX[versionGroup].length);
        const version = parseInteger(value);
        const map = versions[versionGroup];
        if (id === '' || version === null || !isVersion(version) || Object.hasOwn(map, id)) bodyValid = false;
        else map[id] = version;
      }
    }
  }

  const header = { form, projectId, formVersion };
  if (form !== GOAL_FORM_KIND || projectId === '' || formVersion === null || !bodyValid) {
    return { ...header, meta: null };
  }
  return {
    ...header,
    meta: { formVersion, projectId, generatedAt, ...labels, ...versions },
  };
}

// ─── 거부 (GF-2) ─────────────────────────────────────────────

export const GOAL_FORM_REJECTION_MESSAGES = {
  'not-goal-form': '목표 양식 파일이 아닙니다 — 목표 화면의 [양식 내려받기]로 받은 파일만 올릴 수 있습니다',
  'project-mismatch': '이 과제의 양식이 아닙니다',
  'version-mismatch': '양식 버전이 다릅니다 — 다시 내려받으세요',
  'invalid-meta': '양식 정보(_meta)가 손상되었습니다 — 다시 내려받으세요',
} as const;

/** 파서가 데이터 시트를 찾지 못할 때(`missing-sheet`) */
export function goalMissingSheetRejection(sheetName: string): GoalFormRejection {
  return {
    kind: 'missing-sheet',
    message: `'${sheetName}' 시트가 없습니다 — 시트 이름을 바꾸거나 지우지 말고 다시 내려받으세요`,
  };
}

function reject(kind: keyof typeof GOAL_FORM_REJECTION_MESSAGES): GoalMetaCheck {
  return { ok: false, rejection: { kind, message: GOAL_FORM_REJECTION_MESSAGES[kind] } };
}

/**
 * GF-2 거부. 순서는 **형식 → 과제 → 버전 → 본문**이다. 형식이 먼저인 이유: 입력 양식 `_meta`도
 * projectId·formVersion을 가져 과제·버전 검사만으로는 통과한다. 본문이 맨 뒤인 이유: 버전이 다른 파일의
 * 본문 형식은 믿을 수 없으므로 "손상"이 아니라 "다시 내려받으세요"가 맞다.
 */
export function checkGoalMeta(parsed: GoalMetaParse, expected: { projectId: string }): GoalMetaCheck {
  if (parsed.form !== GOAL_FORM_KIND) return reject('not-goal-form');
  if (parsed.projectId !== expected.projectId) return reject('project-mismatch');
  if (parsed.formVersion !== GOAL_FORM_VERSION) return reject('version-mismatch');
  if (parsed.meta === null) return reject('invalid-meta');
  return { ok: true, meta: parsed.meta };
}
