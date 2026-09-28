// 계획서 표 행 해석 + 이름 대응 + `_meta` 합성 (SOT §6.18 HX-5~HX-8, 부록 C.3.2~C.3.6, S-9~S-11·S-16~S-18·S-20·S-22·S-29·S-32, U-1~U-8).
//
// 서버 전용 — lib/goal-form을 끌어오므로 클라이언트 import 금지(S-33). lib/hwpx의 다른 파일은 lib/goal-form을 import하지 않는다.
//
// hwpx는 양식 파서의 앞단일 뿐이다(HX-8): 격자 → `GoalFormRows` + 합성 `GoalFormMeta`를 만들어 `previewGoalForm`
// (`allowDeletes: false`)에 넘긴다. 그래서 여기서 반영 판정을 하지 않고, 대응된 기존 행은 표가 주지 않은 필드를
// preview.ts의 투영 헬퍼 값으로 채운다 — previewGoalForm이 그 필드를 "같음"으로 보고 기존 값을 유지한다(S-18).
// 숫자 해석은 parseGoalValue, 비고 원문 줄은 appendOriginalNote를 그대로 쓴다(GF-6 재구현 없음).

import {
  DELIVERABLE_TYPE_DEFAULT_UNITS,
  GOAL_VALUE_NONE_SYMBOLS,
  HWPX_BASIS_RATIONALE_MARKER,
  HWPX_DELIVERABLE_EXCLUDE_NAME_KEYWORDS,
  HWPX_DELIVERABLE_EXCLUDE_UNITS,
  HWPX_DELIVERABLE_TYPE_RULES,
  HWPX_MEASURE_METHOD_RULES,
  HWPX_TIME_UNITS,
  HWPX_YEAR_COLUMN_PATTERN,
} from '@/lib/constants';
import { GOAL_FORM_VERSION } from '@/lib/goal-form/layout';
import { disambiguateLabels, goalYearLabels } from '@/lib/goal-form/meta';
import { GOAL_FORM_MAX_LENGTH, goalFormIssue } from '@/lib/goal-form/parse';
import type {
  GoalFormDeliverableRow,
  GoalFormIssue,
  GoalFormRows,
  GoalFormTechTargetRow,
  GoalYearTargets,
} from '@/lib/goal-form/parse';
import { projectDeliverable, projectTechTarget } from '@/lib/goal-form/preview';
import type { GoalDeliverableValues, GoalTechTargetValues } from '@/lib/goal-form/preview';
import type { GoalFormMeta } from '@/lib/goal-form/types';
import { appendOriginalNote, combineHints, parseGoalValue } from '@/lib/goal-form/value';
import type { ParsedGoalValue } from '@/lib/goal-form/value';
import { normalizeLabel } from '@/lib/import/normalize';
import type { Deliverable, DeliverableType, Direction, MeasureMethod, TechTarget } from '@/types';
import { PLAN_TABLE_LABELS, planIssue, type PlanIssue } from './issues';
import type { DeliverablePlanTable, MethodPlanTable, PlanTablesResult, TechPlanTable } from './tables';

// ─── 입출력 ──────────────────────────────────────────────────

export interface BuildPlanRowsInput {
  projectId: string;
  tables: PlanTablesResult;
  /** 과제 연차 전부. 순서는 여기서 `order`로 정한다 */
  years: readonly { id: string; name: string; order: number }[];
  /** 과제 기관 전부 */
  orgs: readonly { id: string; name: string }[];
  /** 파이프라인을 돌리는 시점의 과제 목표 **전부** — 대응·투영·`_meta` version의 기준(HX-8, U-10) */
  current: { deliverables: readonly Deliverable[]; techTargets: readonly TechTarget[] };
}

/** 반영 제외 행(HX-6 U-7, S-9) — `GoalFormRows` 밖이라 blocking·건수에 영향이 없고 미리보기에 사유와 함께 보인다 */
export interface PlanExcludedRow {
  table: 'deliverable';
  /** 성과목표 표 데이터 행 순번(1-based, S-10) */
  tableRow: number;
  /** 구분 + 항목 라벨(연속 중복 1회) — 제외 행은 U-6 지표명을 만들지 않는다(특허 SMART 행이 건수 지표와 같은 이름이 된다) */
  name: string;
  unit: string;
  reason: string;
}

export interface PlanRowsResult {
  meta: GoalFormMeta;
  /** achievements·records는 늘 빈 배열이다 — 실적·측정 이력은 건드리지 않는다(HX-8) */
  rows: GoalFormRows;
  excluded: PlanExcludedRow[];
  /** 표 단위 사유(year-count-mismatch·unlinked-method-row). 행 사유는 rows의 각 행 issues */
  issues: PlanIssue[];
  /** sheetRow → 사용자 문구 "기술목표 표 N행 (순번 k)" / "성과목표 표 N행"(S-10) */
  locations: { techTargets: Record<number, string>; deliverables: Record<number, string> };
}

export const PLAN_EXCLUDED_REASON = '반영 제외: 건수 지표가 아님';

// ─── 텍스트 (S-16) ───────────────────────────────────────────

function isNoneSymbol(text: string): boolean {
  return GOAL_VALUE_NONE_SYMBOLS.includes(text);
}

/** 한 줄 필드: 개행 → 공백, 연속 공백 1개, trim. 셀 전체가 없음 기호면 '' */
export function oneLine(raw: string | undefined): string {
  const text = (raw ?? '').replace(/\s+/g, ' ').trim();
  return isNoneSymbol(text) ? '' : text;
}

/** 여러 줄 필드(§7.7 긴 텍스트): 개행 유지, 앞뒤 trim. 셀 전체가 없음 기호면 '' */
export function multiLine(raw: string | undefined): string {
  const text = (raw ?? '').replace(/\r\n?/g, '\n').trim();
  return isNoneSymbol(text) ? '' : text;
}

/**
 * 이름 대응 키(S-17): NFC + 공백 전부 제거. 괄호·대소문자는 유지한다 — I-1(normalizeLabel)은 괄호 내용까지
 * 지워 `정확도(A)`와 `정확도(B)`가 한 키가 되므로 서명에만 쓴다. 기관 대응(HX-5)도 같은 키다.
 */
export function planNameKey(name: string): string {
  return name.normalize('NFC').replace(/\s+/g, '');
}

const NUMBERED_NAME = /^\s*(\d+)\.\s*/;

/** 기술목표 평가항목 `N. 이름` → 순번 + 이름(U-1). 접두가 없으면 순번 null */
export function splitNumberedName(text: string): { seq: number | null; name: string } {
  const m = NUMBERED_NAME.exec(text);
  if (m === null) return { seq: null, name: text.trim() };
  return { seq: Number(m[1]), name: text.slice(m[0].length).trim() };
}

/** 평가방법 표 순번 칸: 정수 또는 `N.` */
function parseSeq(text: string): number | null {
  const m = /^(\d+)\.?$/.exec(text);
  return m ? Number(m[1]) : null;
}

/** 평가환경에서 `[기준설정 근거]`로 **시작하는** 문단부터 끝까지 버린다(HX-7, U-8). 문단 중간의 표식은 그대로 둔다 */
export function stripBasisRationale(text: string): string {
  const marker = HWPX_BASIS_RATIONALE_MARKER.replace(/\s+/g, '');
  const paragraphs = text.split('\n');
  const at = paragraphs.findIndex((p) => p.replace(/\s+/g, '').startsWith(marker));
  if (at < 0) return text;
  return paragraphs.slice(0, at).join('\n').trim();
}

// ─── 부록 C.3 판정 ───────────────────────────────────────────

function includesNormalized(haystack: string, keyword: string): boolean {
  return haystack.includes(normalizeLabel(keyword));
}

/** C.3.6: 단위가 I-1 정규화 후 시간 단위와 **완전 일치** */
export function isTimeUnit(unit: string): boolean {
  const n = normalizeLabel(unit);
  return n !== '' && HWPX_TIME_UNITS.some((u) => normalizeLabel(u) === n);
}

/** C.3.3: 빈 칸 self, 위에서부터 포함 판정, 없으면 other(호출부가 비고·경고를 붙인다) */
export function measureMethodOf(raw: string): MeasureMethod {
  const n = normalizeLabel(raw);
  if (n === '') return 'self';
  for (const rule of HWPX_MEASURE_METHOD_RULES) {
    if (rule.keywords.some((kw) => includesNormalized(n, kw))) return rule.method;
  }
  return 'other';
}

/** C.3.2: 양쪽 I-1 정규화, 위에서부터 첫 매칭(비SCI가 SCI보다 위 — S-7). 없으면 other */
export function deliverableTypeOf(name: string): DeliverableType {
  const n = normalizeLabel(name);
  const has = (kw: string) => includesNormalized(n, kw);
  for (const rule of HWPX_DELIVERABLE_TYPE_RULES) {
    if (rule.exclude.some(has)) continue;
    if (rule.anyOf.some((group) => group.every(has))) return rule.type;
  }
  return 'other';
}

/** C.3.2 반영 제외(U-7): 이름에 SMART·Impact Factor, 또는 단위 `점수` — 이 조건뿐이다 */
export function isExcludedDeliverable(name: string, unit: string): boolean {
  const n = normalizeLabel(name);
  const u = normalizeLabel(unit);
  return (
    HWPX_DELIVERABLE_EXCLUDE_NAME_KEYWORDS.some((kw) => includesNormalized(n, kw)) ||
    (u !== '' && HWPX_DELIVERABLE_EXCLUDE_UNITS.some((x) => normalizeLabel(x) === u))
  );
}

/** 연속으로 같은 라벨은 1회, 빈 라벨은 버린다 — 병합 확장으로 복사된 칸이 이름에 반복되지 않게 */
function dedupeConsecutive(labels: readonly string[]): string[] {
  const out: string[] = [];
  for (const label of labels) {
    if (label === '' || out[out.length - 1] === label) continue;
    out.push(label);
  }
  return out;
}

/**
 * U-6 지표명. 특허는 `특허 {국내|국외}{출원|등록} 건수` 4종 — 구분 값이 이름에 들어가는 유일한 경우다.
 * 그 밖은 항목 라벨(연속 중복 1회, 공백 이음)이고 구분 값은 넣지 않는다. 항목이 비었거나 전부 구분과 같으면
 * (구분이 항목 열까지 병합된 모양) 구분을 쓴다 — 이름이 비는 것보다 낫다.
 */
export function deliverableNameOf(category: string, items: readonly string[]): string {
  const labels = dedupeConsecutive(items);
  const all = normalizeLabel([category, ...labels].join(''));
  if (all.includes(normalizeLabel('특허'))) {
    const region = all.includes('국내') ? '국내' : ['국외', '해외', '국제'].some((w) => all.includes(w)) ? '국외' : null;
    const kind = all.includes('출원') ? '출원' : all.includes('등록') ? '등록' : null;
    if (region !== null && kind !== null) return `특허 ${region}${kind} 건수`;
    // 4종으로 정할 수 없는 특허 행 — 구분을 붙여 두어야 무엇인지 알아본다
    return dedupeConsecutive([category, ...labels]).join(' ');
  }
  const named = labels.filter((l) => l !== category);
  return named.length > 0 ? named.join(' ') : category;
}

// ─── 행 도우미 ───────────────────────────────────────────────

/** 비고 누적 + 행 사유. 경고 사유와 원문 줄이 항상 짝을 이룬다(GF-6) */
interface RowCtx {
  note: string;
  issues: GoalFormIssue[];
}

function cellOf(row: readonly string[], col: number | null): string | undefined {
  return col === null ? undefined : row[col];
}

function checkLength(ctx: RowCtx, text: string, label: string, max: number): void {
  if (text.length > max) ctx.issues.push(goalFormIssue('too-long', `${label} ${text.length}자 (최대 ${max}자)`));
}

/** 비고에 한 줄. 같은 줄이 이미 있으면 그대로(멱등, HX-5) — `[원문] …` 줄은 appendOriginalNote를 쓴다 */
function appendNoteLine(note: string, line: string): string {
  if (note.trim() === '') return line;
  if (note.split('\n').some((existing) => existing.trim() === line)) return note;
  return note.endsWith('\n') ? `${note}${line}` : `${note}\n${line}`;
}

function readNumber(ctx: RowCtx, raw: string | undefined, label: string, unit: string): ParsedGoalValue {
  const parsed = parseGoalValue(oneLine(raw), unit);
  if (parsed.warning !== null && parsed.original !== null) {
    ctx.issues.push(goalFormIssue(parsed.warning, `${label}: ${parsed.original}`));
    ctx.note = appendOriginalNote(ctx.note, label, parsed.original);
  }
  return parsed;
}

/** 가중치·비중: 빈 칸·`-` = 0, 음수 = blocking(GF-9, DB check `weight >= 0`) */
function readWeight(ctx: RowCtx, raw: string | undefined, label: string): number | null {
  const { value } = readNumber(ctx, raw, label, '');
  if (value === null) return 0;
  if (value < 0) {
    ctx.issues.push(goalFormIssue('negative-weight', `${label}: ${value}`));
    return null;
  }
  return value;
}

/** 성과 건수: 빈 칸 null, 0 이상 정수가 아니면 blocking(GF-6, DB integer) */
function readCount(ctx: RowCtx, raw: string | undefined, label: string, unit: string): number | null | 'invalid' {
  const { value } = readNumber(ctx, raw, label, unit);
  if (value === null) return null;
  if (!Number.isInteger(value) || value < 0) {
    ctx.issues.push(goalFormIssue('count-invalid', `${label}: ${value}`));
    return 'invalid';
  }
  return value;
}

/** 연차 열 라벨(비고 원문 줄·사유에 쓴다) — 머리행 아래 칸의 `N차년도`. 못 읽으면 표기 순번 */
function yearColumnLabel(headers: readonly string[], col: number, index: number): string {
  const lower = (headers[col] ?? '').split(' / ').pop() ?? '';
  const m = HWPX_YEAR_COLUMN_PATTERN.exec(normalizeLabel(lower));
  return m ? `${m[1]}차년도` : `${index + 1}번째 연차`;
}

function isBlankRow(row: readonly string[]): boolean {
  return row.every((cell) => cell.trim() === '');
}

/**
 * 연차 목표 → `_meta.yearIds` 키 전부. 표가 준 앞 K개는 표 값(빈 칸 null = 그 키 삭제), 나머지는
 * 대응된 기존 행의 투영값(없으면 null)이다 — 표에 없는 연차의 기존 목표를 지우지 않는다(S-29).
 */
function yearTargets(
  yearIds: readonly string[],
  fromTable: readonly (number | null)[],
  projected: GoalYearTargets | null,
): GoalYearTargets {
  const out: GoalYearTargets = {};
  yearIds.forEach((id, i) => {
    out[id] = i < fromTable.length ? (fromTable[i] ?? null) : (projected?.[id] ?? null);
  });
  return out;
}

// ─── 이름 대응 (HX-8, S-17) ──────────────────────────────────

interface Draft {
  sheetRow: number;
  name: string;
  key: string;
}

type MatchResult<E> = { existing: E | null; issues: GoalFormIssue[] };

/**
 * 계획서 행마다 기존 지표를 정한다. 계획서 안 같은 키 2행 이상은 전부 `duplicate-plan-name`, DB에 같은 키가
 * 2개 이상이면 `ambiguous-match`(둘 다 blocking) — 어느 쪽이든 추측으로 한 행을 고르지 않는다.
 */
function matchByName<E extends { name: string }>(drafts: readonly Draft[], existing: readonly E[]): MatchResult<E>[] {
  const planCount = new Map<string, number>();
  for (const d of drafts) if (d.key !== '') planCount.set(d.key, (planCount.get(d.key) ?? 0) + 1);
  const dbByKey = new Map<string, E[]>();
  for (const e of existing) {
    const key = planNameKey(e.name);
    dbByKey.set(key, [...(dbByKey.get(key) ?? []), e]);
  }
  return drafts.map((d) => {
    if (d.key === '') return { existing: null, issues: [] };
    if ((planCount.get(d.key) ?? 0) > 1) return { existing: null, issues: [goalFormIssue('duplicate-plan-name', d.name)] };
    const found = dbByKey.get(d.key) ?? [];
    if (found.length > 1) return { existing: null, issues: [goalFormIssue('ambiguous-match', `${d.name} (${found.length}개)`)] };
    return { existing: found[0] ?? null, issues: [] };
  });
}

// ─── 기술목표 (HX-5) ─────────────────────────────────────────

interface TechDraft extends Draft {
  seq: number | null;
  cells: readonly string[];
}

interface TechBuilt {
  row: GoalFormTechTargetRow;
  seq: number | null;
  key: string;
  proj: GoalTechTargetValues | null;
}

function buildTechRows(
  table: TechPlanTable,
  yearIds: readonly string[],
  k: number,
  orgs: readonly { id: string; name: string }[],
  current: readonly TechTarget[],
): TechBuilt[] {
  const c = table.columns;
  const max = GOAL_FORM_MAX_LENGTH;
  const orgsByKey = new Map<string, string[]>();
  for (const o of orgs) {
    const key = planNameKey(o.name);
    orgsByKey.set(key, [...(orgsByKey.get(key) ?? []), o.id]);
  }

  const drafts: TechDraft[] = [];
  table.rows.forEach((cells, i) => {
    if (isBlankRow(cells)) return;
    const { seq, name } = splitNumberedName(oneLine(cellOf(cells, c.name)));
    drafts.push({ sheetRow: i + 1, seq, name, key: planNameKey(name), cells });
  });
  const matches = matchByName(drafts, current);

  return drafts.map((d, di) => {
    const match = matches[di]!;
    const existing = match.existing;
    const proj = existing === null ? null : projectTechTarget(existing, yearIds);
    const ctx: RowCtx = { note: proj?.note ?? '', issues: [...match.issues] };
    const cells = d.cells;

    if (d.name === '') ctx.issues.push(goalFormIssue('no-name', '평가항목'));
    checkLength(ctx, d.name, '평가항목', max.name);

    const unit = c.unit === null ? (proj?.unit ?? '') : oneLine(cells[c.unit]);
    checkLength(ctx, unit, '단위', max.unit);

    const weight = c.weight === null ? (proj?.weight ?? 0) : readWeight(ctx, cells[c.weight], '비중');

    // S-29: 과제 연차 order 순 앞 K개 ↔ 표 연차 열 앞 K개. 남는 열은 읽지 않는다
    const yearCols = c.year.slice(0, k);
    const years = yearCols.map((col, i) => readNumber(ctx, cells[col], yearColumnLabel(table.headers, col, i), unit));
    const yearValues = years.map((y) => y.value);

    // U-3: 셀 힌트 > 시간 단위 > (기존 행이면 기존 값) > higher_better
    const combined = combineHints(years.map((y) => y.hint));
    if (combined.conflict) ctx.issues.push(goalFormIssue('hint-conflict', '계획서에는 방향 열이 없어 단위·기존 값으로 정합니다'));
    const direction: Direction =
      combined.hint ?? (isTimeUnit(unit) ? 'lower_better' : (proj?.direction ?? 'higher_better'));

    // GF-7: 최종 목표 열이 없다 — 값 있는 마지막 연차. 표에 연차 열이 아예 없으면 기존 값
    let targetValue: number | null;
    if (yearCols.length > 0) targetValue = [...yearValues].reverse().find((v): v is number => v !== null) ?? null;
    else targetValue = proj?.targetValue ?? null;
    if (targetValue === null) ctx.issues.push(goalFormIssue('no-target'));

    // C.3.3: 빈 칸 self, 매칭 실패 other + 원문 비고 + 경고(S-20·S-32)
    let measureMethod: MeasureMethod = proj?.measureMethod ?? 'self';
    if (c.measureMethod !== null) {
      const text = oneLine(cells[c.measureMethod]);
      measureMethod = measureMethodOf(text);
      if (measureMethod === 'other') {
        ctx.issues.push(goalFormIssue('method-other', text));
        ctx.note = appendOriginalNote(ctx.note, '평가방법', text);
      }
    }

    // HX-5: 과제 기관과 이름 키 완전 일치만. 빈 칸은 표가 값을 주지 않은 것이라 기존 값을 둔다(S-18)
    let orgId: string | null = proj?.orgId ?? null;
    if (c.org !== null) {
      const text = oneLine(cells[c.org]);
      if (text !== '') {
        const ids = orgsByKey.get(planNameKey(text)) ?? [];
        if (ids.length === 1) orgId = ids[0]!;
        else {
          ctx.issues.push(goalFormIssue('org-unmatched', ids.length > 1 ? `${text} (같은 이름 기관 ${ids.length}곳)` : text));
          ctx.note = appendNoteLine(ctx.note, `[담당기관] ${text}`);
        }
      }
    }

    const row: GoalFormTechTargetRow = {
      sheetRow: d.sheetRow,
      id: existing?.id ?? null,
      // U-1·U-2: 구분·세계최고·국내수준·표준·기준설정근거는 읽지 않는다 — 기존 값 보존, 새 행 null/''
      group: proj?.group ?? '',
      name: d.name,
      unit,
      direction,
      weight,
      targetValue,
      targetByYear: yearTargets(yearIds, yearValues, proj?.targetByYear ?? null),
      baselineDomestic: proj?.baselineDomestic ?? null,
      worldBest: proj?.worldBest ?? null,
      worldBestHolder: proj?.worldBestHolder ?? '',
      measureMethod,
      // 평가방법 표(HX-7)가 연결되면 덮어쓴다. 연결되지 않으면 기존 값(S-22)
      measureDescription: proj?.measureDescription ?? '',
      standardBasis: proj?.standardBasis ?? '',
      basisRationale: proj?.basisRationale ?? '',
      evaluationEnvironment: proj?.evaluationEnvironment ?? '',
      orgId,
      note: ctx.note,
      issues: ctx.issues,
    };
    return { row, seq: d.seq, key: d.key, proj };
  });
}

// ─── 평가방법 표 (HX-7) ──────────────────────────────────────

function linkMethodRows(table: MethodPlanTable, tech: readonly TechBuilt[], issues: PlanIssue[]): void {
  const c = table.columns;
  const label = PLAN_TABLE_LABELS.method;

  const entries = table.rows
    .map((cells, i) => ({ cells, sheetRow: i + 1 }))
    .filter((e) => !isBlankRow(e.cells))
    .map((e) => {
      const seq = parseSeq(oneLine(cellOf(e.cells, c.seq)));
      const { name } = splitNumberedName(oneLine(cellOf(e.cells, c.name)));
      return { ...e, seq, key: planNameKey(name) };
    });

  const seqCount = new Map<number, number>();
  for (const e of entries) if (e.seq !== null) seqCount.set(e.seq, (seqCount.get(e.seq) ?? 0) + 1);
  const techBySeq = new Map<number, TechBuilt[]>();
  const techByKey = new Map<string, TechBuilt[]>();
  for (const t of tech) {
    if (t.seq !== null) techBySeq.set(t.seq, [...(techBySeq.get(t.seq) ?? []), t]);
    if (t.key !== '') techByKey.set(t.key, [...(techByKey.get(t.key) ?? []), t]);
  }

  const linked = new Set<TechBuilt>();
  for (const e of entries) {
    const where = e.seq === null ? `${label} ${e.sheetRow}행` : `${label} ${e.sheetRow}행 (순번 ${e.seq})`;
    // S-22: 순번이 겹치면 어느 행이 어느 기술목표인지 모른다 — 이름 재시도도 하지 않고 둘 다 잇지 않는다
    if (e.seq !== null && (seqCount.get(e.seq) ?? 0) > 1) {
      issues.push(planIssue('unlinked-method-row', `${where} — 순번이 겹칩니다`));
      continue;
    }
    const bySeq = e.seq === null ? [] : (techBySeq.get(e.seq) ?? []);
    const byName = e.key === '' ? [] : (techByKey.get(e.key) ?? []);
    const target = bySeq.length === 1 ? bySeq[0]! : byName.length === 1 ? byName[0]! : null;
    if (target === null) {
      issues.push(planIssue('unlinked-method-row', where));
      continue;
    }
    // 한 기술목표에 두 행이 붙으면 어느 쪽이 맞는지 모른다 — 먼저 붙은 행을 두고 뒤 행을 알린다
    if (linked.has(target)) {
      issues.push(planIssue('unlinked-method-row', `${where} — 이미 다른 행과 이어진 기술목표입니다`));
      continue;
    }
    linked.add(target);

    const ctx: RowCtx = { note: target.row.note, issues: target.row.issues };
    if (c.measureDescription !== null) {
      target.row.measureDescription = multiLine(e.cells[c.measureDescription]);
      checkLength(ctx, target.row.measureDescription, '평가방법 상세', GOAL_FORM_MAX_LENGTH.note);
    }
    if (c.evaluationEnvironment !== null) {
      // U-8: `[기준설정 근거]` 문단부터는 버린다 — basisRationale에 넣지 않는다(기존 값 보존)
      target.row.evaluationEnvironment = stripBasisRationale(multiLine(e.cells[c.evaluationEnvironment]));
      checkLength(ctx, target.row.evaluationEnvironment, '평가환경', GOAL_FORM_MAX_LENGTH.longText);
    }
  }
}

// ─── 성과목표 (HX-6) ─────────────────────────────────────────

interface DeliverableDraft extends Draft {
  cells: readonly string[];
  unitText: string | null;
}

function buildDeliverableRows(
  table: DeliverablePlanTable,
  yearIds: readonly string[],
  k: number,
  current: readonly Deliverable[],
  excluded: PlanExcludedRow[],
): GoalFormDeliverableRow[] {
  const c = table.columns;
  const max = GOAL_FORM_MAX_LENGTH;

  const drafts: DeliverableDraft[] = [];
  table.rows.forEach((cells, i) => {
    if (isBlankRow(cells)) return;
    const category = oneLine(cellOf(cells, c.category));
    const items = c.item.map((col) => oneLine(cells[col]));
    const unitText = c.unit === null ? null : oneLine(cells[c.unit]);
    // 제외 판정은 U-6 이름이 아니라 구분·항목 라벨 전부로 한다 — 특허 SMART 행의 U-6 이름은 건수 지표와 같아진다
    const label = dedupeConsecutive([category, ...items]).join(' ');
    if (isExcludedDeliverable(label, unitText ?? '')) {
      excluded.push({ table: 'deliverable', tableRow: i + 1, name: label, unit: unitText ?? '', reason: PLAN_EXCLUDED_REASON });
      return;
    }
    const name = deliverableNameOf(category, items);
    drafts.push({ sheetRow: i + 1, name, key: planNameKey(name), cells, unitText });
  });
  const matches = matchByName(drafts, current);

  return drafts.map((d, di) => {
    const match = matches[di]!;
    const existing = match.existing;
    const proj: GoalDeliverableValues | null = existing === null ? null : projectDeliverable(existing, yearIds);
    const ctx: RowCtx = { note: proj?.note ?? '', issues: [...match.issues] };
    const cells = d.cells;

    if (d.name === '') ctx.issues.push(goalFormIssue('no-name', '항목'));
    checkLength(ctx, d.name, '지표명', max.name);

    // S-18: 이름에서 유형을 못 정하면(other) 대응된 기존 행의 유형을 둔다
    const fromName = deliverableTypeOf(d.name);
    const type: DeliverableType = fromName === 'other' && proj !== null ? proj.type : fromName;

    // GF-9: 단위가 비면 그 유형의 기본 단위(부록 A.2)
    let unit: string;
    if (d.unitText === null) unit = proj?.unit ?? DELIVERABLE_TYPE_DEFAULT_UNITS[type];
    else unit = d.unitText === '' ? DELIVERABLE_TYPE_DEFAULT_UNITS[type] : d.unitText;
    checkLength(ctx, unit, '단위', max.unit);

    const weight = c.weight === null ? (proj?.weight ?? 0) : readWeight(ctx, cells[c.weight], '가중치');

    const yearCols = c.year.slice(0, k);
    const yearReads = yearCols.map((col, i) => readCount(ctx, cells[col], yearColumnLabel(table.headers, col, i), unit));
    const yearValues = yearReads.map((v) => (v === 'invalid' ? null : v));
    const sum = yearValues.reduce<number>((acc, v) => acc + (v ?? 0), 0);

    // GF-7: 계가 비면 Σ연차(목표가 전부 `-`면 0 — U-7), 다르면 D-3 경고. 표에 계·연차가 모두 없으면 기존 값
    let targetTotal: number | null;
    const total = c.total === null ? null : readCount(ctx, cells[c.total], '계', unit);
    if (total === 'invalid') targetTotal = null;
    else if (total !== null) {
      targetTotal = total;
      if (yearValues.some((v) => v !== null) && !yearReads.includes('invalid') && total !== sum) {
        ctx.issues.push(goalFormIssue('total-mismatch', `계 ${total} · 연차 합계 ${sum}`));
      }
    } else if (c.total === null && yearCols.length === 0) targetTotal = proj?.targetTotal ?? 0;
    else targetTotal = sum;

    const evidenceMethod = c.evidenceMethod === null ? (proj?.evidenceMethod ?? '') : multiLine(cells[c.evidenceMethod]);
    checkLength(ctx, evidenceMethod, '평가방법', max.longText);
    checkLength(ctx, ctx.note, '비고', max.note);

    return {
      sheetRow: d.sheetRow,
      id: existing?.id ?? null,
      type,
      name: d.name,
      unit,
      weight,
      targetTotal,
      targetByYear: yearTargets(yearIds, yearValues, proj?.targetByYear ?? null),
      // 성과목표 표에는 기관 열이 없다 — 기존 값 보존, 새 행 null
      orgId: proj?.orgId ?? null,
      evidenceMethod,
      note: ctx.note,
      issues: ctx.issues,
    };
  });
}

// ─── 진입점 ──────────────────────────────────────────────────

/**
 * 식별된 계획서 표 → 양식 행 모델 + 합성 `_meta`(HX-5~HX-8). 결과를 `previewGoalForm({ allowDeletes: false })`에
 * 넣으면 계획서에 없는 기존 목표는 삭제 후보가 되지 않고, 같은 격자를 적용한 상태로 다시 돌리면 전 행 unchanged다.
 */
export function buildPlanRows(input: BuildPlanRowsInput): PlanRowsResult {
  const { projectId, tables, orgs, current } = input;
  const issues: PlanIssue[] = [];
  const excluded: PlanExcludedRow[] = [];
  const years = [...input.years].sort((a, b) => a.order - b.order);

  // S-29: 표마다 K = min(표 연차 열 수, 과제 연차 수). `_meta` 연차는 두 표 중 큰 K — 작은 쪽 표의 나머지 연차는 보존된다
  const kOf = (table: TechPlanTable | DeliverablePlanTable | null): number => {
    if (table === null) return 0;
    const n = table.columns.year.length;
    if (n !== years.length) {
      issues.push(planIssue('year-count-mismatch', `${PLAN_TABLE_LABELS[table.kind]} 연차 열 ${n}개 · 과제 연차 ${years.length}개`));
    }
    return Math.min(n, years.length);
  };
  const kTech = kOf(tables.tech);
  const kDeliverable = kOf(tables.deliverable);
  const metaYears = years.slice(0, Math.max(kTech, kDeliverable));
  const yearIds = metaYears.map((y) => y.id);

  const tech = tables.tech === null ? [] : buildTechRows(tables.tech, yearIds, kTech, orgs, current.techTargets);
  if (tables.method !== null) linkMethodRows(tables.method, tech, issues);
  for (const t of tech) checkLength({ note: t.row.note, issues: t.row.issues }, t.row.note, '비고', GOAL_FORM_MAX_LENGTH.note);

  const deliverables =
    tables.deliverable === null ? [] : buildDeliverableRows(tables.deliverable, yearIds, kDeliverable, current.deliverables, excluded);

  const locations: PlanRowsResult['locations'] = { techTargets: {}, deliverables: {} };
  for (const t of tech) {
    const base = `${PLAN_TABLE_LABELS.tech} ${t.row.sheetRow}행`;
    locations.techTargets[t.row.sheetRow] = t.seq === null ? base : `${base} (순번 ${t.seq})`;
  }
  for (const d of deliverables) locations.deliverables[d.sheetRow] = `${PLAN_TABLE_LABELS.deliverable} ${d.sheetRow}행`;

  const versions = <T extends { id: string; version: number }>(list: readonly T[]): Record<string, number> =>
    Object.fromEntries(list.map((x) => [x.id, x.version]));
  const yearLabels = goalYearLabels(metaYears);
  const orgLabels = disambiguateLabels(orgs.map((o) => o.name));

  // S-11: generatedAt은 파일이 없어 ''. version은 파이프라인 시점 DB 값 — 미리보기 뒤 변경은 덮어쓴다(U-10)
  const meta: GoalFormMeta = {
    formVersion: GOAL_FORM_VERSION,
    projectId,
    generatedAt: '',
    years: metaYears.map((y, i) => ({ id: y.id, label: yearLabels[i]! })),
    orgs: orgs.map((o, i) => ({ id: o.id, label: orgLabels[i]! })),
    members: [],
    deliverables: versions(current.deliverables),
    achievements: versions(current.deliverables.flatMap((d) => d.achievements)),
    techTargets: versions(current.techTargets),
    records: versions(current.techTargets.flatMap((t) => t.records)),
  };

  return {
    meta,
    rows: { deliverables, achievements: [], techTargets: tech.map((t) => t.row), records: [] },
    excluded,
    issues,
    locations,
  };
}
