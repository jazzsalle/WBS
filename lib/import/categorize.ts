// 비목 라벨 판정 (SOT §6.8.3 I-1~I-6, 부록 C 주의 1, §6.8.2 S-12).
// 부수효과 없는 순수 함수다. 단위 테스트: tests/unit/import-categorize.test.ts

import {
  AMBIGUOUS_ALIASES,
  BUDGET_CATEGORY_LABELS,
  CASH_INKIND_AXIS,
  CATEGORY_ALIASES,
  MINISTRY_ALIAS_PRESETS,
  SKIP_ROW_PATTERNS,
  type BudgetAxis,
} from '@/lib/constants';
import type { BudgetCategory } from '@/types';
import { FUZZY_THRESHOLD, normalizeLabel, similarity } from './normalize';
import type { CategorySource, FuzzyCandidate, LabelClassification, MatchContext } from './types';

// ─── 사전 (정규화된 키로 다시 색인) ──────────────────────────

function normalizeDict(
  dict: Readonly<Record<string, BudgetCategory>>
): Map<string, BudgetCategory> {
  const map = new Map<string, BudgetCategory>();
  for (const [key, category] of Object.entries(dict)) {
    const normalized = normalizeLabel(key);
    if (normalized !== '') map.set(normalized, category);
  }
  return map;
}

/**
 * ① 완전일치 비목 = 부록 A.1의 **비목 표준 명칭**(코드가 아니다)과의 일치.
 * `간접비`가 여기서 확정되므로 ④ 스킵 패턴의 `간접비계`류와 섞이지 않는다 (부록 C 주의 1).
 */
const EXACT_CATEGORY_NAMES: Map<string, BudgetCategory> = (() => {
  const map = new Map<string, BudgetCategory>();
  for (const [category, label] of Object.entries(BUDGET_CATEGORY_LABELS)) {
    const normalized = normalizeLabel(label);
    if (normalized !== '') map.set(normalized, category as BudgetCategory);
  }
  return map;
})();

const COMMON_ALIASES = normalizeDict(CATEGORY_ALIASES);
const AXIS_LABELS = new Map<string, BudgetAxis>(
  Object.entries(CASH_INKIND_AXIS).map(([label, axis]) => [normalizeLabel(label), axis])
);
const AMBIGUOUS = new Map<string, BudgetCategory[]>(
  Object.entries(AMBIGUOUS_ALIASES).map(([label, candidates]) => [
    normalizeLabel(label),
    candidates,
  ])
);

const ministryCache = new Map<string, Map<string, BudgetCategory>>();

function ministryAliases(ministry: string | null | undefined): Map<string, BudgetCategory> {
  if (!ministry) return new Map();
  const cached = ministryCache.get(ministry);
  if (cached) return cached;
  const preset = MINISTRY_ALIAS_PRESETS[ministry];
  const map = preset ? normalizeDict(preset) : new Map<string, BudgetCategory>();
  ministryCache.set(ministry, map);
  return map;
}

function skipPatternSet(context: MatchContext | undefined): Set<string> {
  const patterns = context?.skipPatterns ?? SKIP_ROW_PATTERNS;
  const set = new Set<string>();
  for (const pattern of patterns) {
    const normalized = normalizeLabel(pattern);
    if (normalized !== '') set.add(normalized);
  }
  return set;
}

// ─── I-2 별칭 조회 ───────────────────────────────────────────

export interface AliasHit {
  category: BudgetCategory;
  source: CategorySource;
}

/**
 * I-2 우선순위: ① draft `categoryAliases` → ② `MINISTRY_ALIAS_PRESETS[ministry]` → ③ `CATEGORY_ALIASES`.
 * 입력은 이미 정규화된 라벨이어야 한다.
 */
export function lookupAlias(normalized: string, context?: MatchContext): AliasHit | null {
  if (normalized === '') return null;
  if (context?.draftAliases) {
    const draft = normalizeDict(context.draftAliases).get(normalized);
    if (draft) return { category: draft, source: 'alias-draft' };
  }
  const ministry = ministryAliases(context?.ministry).get(normalized);
  if (ministry) return { category: ministry, source: 'alias-ministry' };
  const common = COMMON_ALIASES.get(normalized);
  if (common) return { category: common, source: 'alias-common' };
  return null;
}

// ─── 부록 C 주의 1: 4단계 판정 ───────────────────────────────

function classification(
  raw: string,
  normalized: string,
  patch: Partial<LabelClassification> & { kind: LabelClassification['kind'] }
): LabelClassification {
  return {
    raw,
    normalized,
    category: null,
    categorySource: null,
    axis: null,
    ambiguousCandidates: null,
    ...patch,
  };
}

/**
 * 라벨 한 칸의 판정. 순서는 부록 C 주의 1 그대로:
 * ① 완전일치 비목 → ② 별칭 사전(I-2) → ③ 축 라벨 → ④ 스킵 패턴.
 *
 * I-5: 원래부터 빈 셀(`empty`, S-2 carry-forward 대상)과 정규화 후 비워진 라벨
 * (`blank-after-normalize`, 메모 행 후보 / S-10)을 **다른 값으로** 돌려준다.
 *
 * I-3 퍼지 매칭은 여기서 하지 않는다 — S-12가 S-6(아래 행 결합) 다음에야 퍼지로 내려가기 때문이다.
 */
export function classifyLabel(
  raw: string | null | undefined,
  context?: MatchContext
): LabelClassification {
  const text = raw === null || raw === undefined ? '' : String(raw);
  if (text.trim() === '') return classification('', '', { kind: 'empty' });

  const normalized = normalizeLabel(text);
  if (normalized === '') {
    // I-5: 값은 있었는데 전부 괄호 메모·각주였다
    return classification(text, '', { kind: 'blank-after-normalize' });
  }

  const exact = EXACT_CATEGORY_NAMES.get(normalized);
  if (exact) {
    return classification(text, normalized, {
      kind: 'category',
      category: exact,
      categorySource: 'exact',
    });
  }

  const alias = lookupAlias(normalized, context);
  if (alias) {
    return classification(text, normalized, {
      kind: 'category',
      category: alias.category,
      categorySource: alias.source,
    });
  }

  // I-6: 구 비목 체계는 자동 분할 금지 — 사용자 선택을 요구한다
  const ambiguous = AMBIGUOUS.get(normalized);
  if (ambiguous) {
    return classification(text, normalized, {
      kind: 'ambiguous',
      ambiguousCandidates: [...ambiguous],
    });
  }

  const axis = AXIS_LABELS.get(normalized);
  if (axis) return classification(text, normalized, { kind: 'axis', axis });

  if (skipPatternSet(context).has(normalized)) {
    return classification(text, normalized, { kind: 'skip' });
  }

  return classification(text, normalized, { kind: 'unknown' });
}

/**
 * S-2': carry-forward 대상은 그 열에서 **마지막으로 판정에 성공한(비목·스킵·축)** 값이다.
 * 판정되지 않은 라벨(행안부 B열 세로쓰기 `직`/`접`/`비`)을 아래로 흘리면
 * 우측 라벨이 빈 행마다 그 조각이 채택돼 미매핑이 대량 발생한다.
 */
export function isCarryForwardable(raw: string, context?: MatchContext): boolean {
  const kind = classifyLabel(raw, context).kind;
  return kind === 'category' || kind === 'ambiguous' || kind === 'skip' || kind === 'axis';
}

// ─── I-3 퍼지 매칭 ───────────────────────────────────────────

/**
 * 유사도 ≥ 0.8인 최상위 후보 하나. **자동 확정하지 않는다** — 호출자는 사용자 확인을 받아야 한다.
 * 완전일치 비목명과 별칭 사전 전체(I-2 우선순위 포함)를 후보 풀로 쓴다.
 */
export function findFuzzyCandidate(
  normalized: string,
  context?: MatchContext,
  threshold: number = FUZZY_THRESHOLD
): FuzzyCandidate | null {
  if (normalized === '') return null;

  const pools: Map<string, BudgetCategory>[] = [];
  if (context?.draftAliases) pools.push(normalizeDict(context.draftAliases));
  pools.push(ministryAliases(context?.ministry), EXACT_CATEGORY_NAMES, COMMON_ALIASES);

  let best: FuzzyCandidate | null = null;
  for (const pool of pools) {
    for (const [key, category] of pool) {
      const score = similarity(normalized, key);
      if (score < threshold) continue;
      if (best === null || score > best.similarity) {
        best = { category, key, similarity: score };
      }
    }
  }
  return best;
}

// ─── S-13 시트 추천 보조 ─────────────────────────────────────

/** 라벨 텍스트가 비목으로 판정되는가 (시트 추천 밀도·구조 감지에서 재사용) */
export function isCategoryLabel(raw: string, context?: MatchContext): boolean {
  return classifyLabel(raw, context).kind === 'category';
}
