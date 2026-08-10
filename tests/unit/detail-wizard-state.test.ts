// 산출근거 마법사 상태 헬퍼 (SOT §7.9.3, §6.11 D-7·D-9·D-11·D-15·D-21).
//
// 화면 없이 고정할 수 있는 부분만 본다 — 여기 함수들은 전부 draft 하나를 받아 새 draft를 내는
// 순수 함수다. 파싱·판정은 서버가 하므로 이 파일에 파서 이야기는 없다.
//
// 핵심은 **D-7 → D-9 교차 무효화**다: 열 역할을 바꾸면 그 표에서 나온 행이 갈리거나 합쳐져
// `axisSuggested`가 뒤집힌다. 예전 축 재지정이 남으면 서버가 매 미리보기마다 거부하는데
// 그 행에는 셀렉트가 없어 화면에서 지울 통로가 없다 — 사용자가 갇힌다.

import { describe, expect, it } from 'vitest';
import { detailBlockKey } from '@/lib/import';
import type { DetailBlock } from '@/lib/import';
import type { BudgetCategory, DetailImportDraft, DetailSheetBlockInfo } from '@/types';
import {
  initialDetailDraft,
  withAxisOverride,
  withColumnRoleOverride,
  withMemberDecision,
  withReplaceCategory,
  withRowDecision,
} from '@/components/budget/import/detail/detail-wizard-state';

// ─── 픽스처 ──────────────────────────────────────────────────

function makeBlock(
  patch: Partial<DetailBlock> & { category: BudgetCategory; dataStartRow: number; dataEndRow: number }
): DetailBlock {
  return {
    section: 'direct',
    categoryLabel: '- 인건비',
    categoryRow: 60,
    subcategory: null,
    subcategoryLabel: null,
    subcategoryRow: null,
    numberToken: null,
    resolvedBy: null,
    numberCandidates: [],
    needsConfirm: false,
    issues: [],
    headerRows: [patch.dataStartRow - 1],
    columns: [],
    roles: {},
    tableIndex: 0,
    ...patch,
  };
}

function blockInfo(block: DetailBlock): DetailSheetBlockInfo {
  return {
    key: detailBlockKey(block),
    block,
    rowCount: block.dataEndRow - block.dataStartRow + 1,
    skipSuggestedCount: 0,
    fileAmount: 0,
    subtotalCount: 0,
    currency: null,
  };
}

/** 인건비 표 (64~80행) */
const personnel = blockInfo(makeBlock({ category: 'personnel', dataStartRow: 64, dataEndRow: 80 }));
/** 연구수당 표 (100~110행) */
const allowance = blockInfo(
  makeBlock({ category: 'allowance', categoryRow: 96, dataStartRow: 100, dataEndRow: 110 })
);
const blocks = [personnel, allowance];

/** 두 표에 각각 축 재지정이 있는 상태 (D-9) */
function draftWithAxes(): DetailImportDraft {
  let draft = initialDetailDraft();
  draft = withAxisOverride(draft, '70:0', 'in_kind'); // 인건비 표
  draft = withAxisOverride(draft, '104:0', 'in_kind'); // 연구수당 표
  return draft;
}

// ─── D-7 컬럼 role 재지정 ────────────────────────────────────

describe('withColumnRoleOverride (D-7)', () => {
  it('role을 지정하면 그 표·그 열에만 붙는다', () => {
    const draft = withColumnRoleOverride(initialDetailDraft(), personnel.key, 9, 'cashTotal', blocks);
    expect(draft.columnRoleOverrides).toEqual({ [personnel.key]: { 9: 'cashTotal' } });
  });

  it('null은 "역할 없음"이고 undefined는 재지정을 지운다 (자동 감지로 복귀)', () => {
    const removed = withColumnRoleOverride(initialDetailDraft(), personnel.key, 9, null, blocks);
    expect(removed.columnRoleOverrides).toEqual({ [personnel.key]: { 9: null } });

    // 마지막 재지정이 빠지면 블록 키 자체를 남기지 않는다
    const reverted = withColumnRoleOverride(removed, personnel.key, 9, undefined, blocks);
    expect(reverted.columnRoleOverrides).toEqual({});
  });

  // ① stale axisOverride 교차 무효화
  it('그 표의 축 재지정을 함께 버린다 — 다른 표의 축 재지정은 남는다 (D-9)', () => {
    const draft = withColumnRoleOverride(draftWithAxes(), personnel.key, 9, 'cashTotal', blocks);
    expect(draft.axisOverrides).toEqual({ '104:0': 'in_kind' });
  });

  it('재지정을 지울 때도(undefined) 그 표의 축 재지정을 버린다 — 열 역할이 달라지는 것은 같다', () => {
    const withRole = withColumnRoleOverride(draftWithAxes(), allowance.key, 10, 'inKindTotal', blocks);
    expect(withRole.axisOverrides).toEqual({ '70:0': 'in_kind' });

    const reverted = withColumnRoleOverride(
      { ...withRole, axisOverrides: { '70:0': 'in_kind', '104:0': 'cash' } },
      allowance.key,
      10,
      undefined,
      blocks
    );
    expect(reverted.axisOverrides).toEqual({ '70:0': 'in_kind' });
  });

  it('같은 값을 다시 골라 바뀐 것이 없으면 draft를 그대로 둔다 — 멀쩡한 축 재지정을 버리지 않는다', () => {
    const first = withColumnRoleOverride(draftWithAxes(), personnel.key, 9, 'cashTotal', blocks);
    expect(withColumnRoleOverride(first, personnel.key, 9, 'cashTotal', blocks)).toBe(first);

    // 없는 재지정을 지우는 것도 무동작이다
    const untouched = draftWithAxes();
    expect(withColumnRoleOverride(untouched, personnel.key, 3, undefined, blocks)).toBe(untouched);
  });

  it('블록을 찾지 못하면 축 재지정을 전부 버린다 — 조용히 갇히는 것보다 과하게 비우는 쪽이 낫다', () => {
    const draft = withColumnRoleOverride(draftWithAxes(), 'personnel:0:-:0', 9, 'cashTotal', []);
    expect(draft.axisOverrides).toEqual({});
  });

  it('행 번호를 읽을 수 없는 축 재지정 키도 버린다 — 어떤 역할 변경으로도 지워지지 않아 갇힌다', () => {
    const draft = withColumnRoleOverride(
      { ...initialDetailDraft(), axisOverrides: { 'x:0': 'in_kind', '104:0': 'in_kind' } },
      personnel.key,
      9,
      'cashTotal',
      blocks
    );
    expect(draft.axisOverrides).toEqual({ '104:0': 'in_kind' });
  });

  it('원본 draft를 고치지 않는다', () => {
    const draft = draftWithAxes();
    const snapshot = structuredClone(draft);
    withColumnRoleOverride(draft, personnel.key, 9, 'cashTotal', blocks);
    expect(draft).toEqual(snapshot);
  });
});

// ─── Step 3·4 결정 (같은 규약: draft → 새 draft) ─────────────

describe('withMemberDecision (D-11)', () => {
  it('결정을 담고 null이면 자동 제안으로 되돌린다', () => {
    const chosen = withMemberDecision(initialDetailDraft(), '지동민', {
      kind: 'existing',
      memberId: 'member-1',
    });
    expect(chosen.memberDecisions).toEqual({ 지동민: { kind: 'existing', memberId: 'member-1' } });
    expect(withMemberDecision(chosen, '지동민', null).memberDecisions).toEqual({});
  });
});

describe('withReplaceCategory (D-15)', () => {
  it('비목을 담고 빼며, 같은 비목을 두 번 담지 않는다', () => {
    const once = withReplaceCategory(initialDetailDraft(), 'personnel', true);
    expect(once.replaceCategories).toEqual(['personnel']);
    // 이미 담긴 비목을 다시 담으면 draft가 그대로다 (통화 확인과 같은 규약)
    expect(withReplaceCategory(once, 'personnel', true)).toBe(once);
    expect(withReplaceCategory(once, 'personnel', false).replaceCategories).toEqual([]);
  });
});

describe('withRowDecision (D-21 ②)', () => {
  it('행마다 포함·제외를 명시한다', () => {
    const skipped = withRowDecision(initialDetailDraft(), '70:0', 'skip');
    expect(skipped.rowDecisions).toEqual({ '70:0': 'skip' });
    expect(withRowDecision(skipped, '70:0', 'include').rowDecisions).toEqual({ '70:0': 'include' });
  });
});
