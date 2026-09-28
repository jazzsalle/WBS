// 목표 양식 미리보기·커밋 페이로드 (SOT §6.17 GF-5·GF-7·GF-10·GF-11, §6.2·§6.3)
//
// 픽스처는 생성기로 만든 양식을 파서로 읽은 행 모델이다 — "내려받은 그대로 올리기"가 실제 왕복이 되게.
// 시나리오는 그 행 모델을 조금씩 바꿔 만든다(미리보기의 입력은 xlsx가 아니라 행 모델이다).

import { describe, expect, it } from 'vitest';
import { buildGoalForm } from '@/lib/goal-form/build';
import { goalColumnOf, goalSheetsFor } from '@/lib/goal-form/layout';
import type { GoalSheetDef } from '@/lib/goal-form/layout';
import type { GoalFormData } from '@/lib/goal-form/build';
import { parseGoalForm } from '@/lib/goal-form/parse';
import type { GoalFormRows } from '@/lib/goal-form/parse';
import { buildGoalFormCommit, previewGoalForm } from '@/lib/goal-form/preview';
import type { GoalFormPreviewInput, GoalFormPreviewOptions } from '@/lib/goal-form/preview';
import type { GoalFormMeta } from '@/lib/goal-form/types';
import { computeDeliverableTotal, computeTechTargetTotal } from '@/lib/goals';
import type { RawSheet } from '@/lib/import/types';
import type { Deliverable, DeliverableAchievement, TechTarget, TechTargetRecord } from '@/types';

// ─── 픽스처 ──────────────────────────────────────────────────

const ENTITY = { createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z', createdBy: null, updatedBy: null };

function achievement(id: string, over: Partial<DeliverableAchievement> = {}): DeliverableAchievement {
  return {
    id,
    version: 1,
    title: `산출물 ${id}`,
    date: '2026-03-01',
    yearId: 'y-1',
    orgId: 'o-1',
    memberIds: ['m-1'],
    evidenceUrl: '',
    note: '',
    ...over,
  };
}

function record(id: string, over: Partial<TechTargetRecord> = {}): TechTargetRecord {
  return {
    id,
    version: 1,
    value: 85,
    date: '2026-03-01',
    yearId: 'y-1',
    method: 'self',
    evaluator: '',
    evidenceUrl: '',
    note: '',
    ...over,
  };
}

function currentData(): { deliverables: Deliverable[]; techTargets: TechTarget[] } {
  return {
    deliverables: [
      {
        ...ENTITY,
        id: 'd-1',
        version: 2,
        projectId: 'proj-1',
        type: 'paper_sci',
        // 앞뒤 공백·양식 밖 연차 키 — 그대로 올려도 바뀌면 안 된다
        name: ' 논문 게재 ',
        unit: '건',
        weight: 60,
        targetTotal: 3,
        targetByYear: { 'y-1': 1, 'y-2': 2, 'y-x': 5 },
        achievements: [
          achievement('a-1', { memberIds: ['m-1', 'm-2'] }),
          achievement('a-2', { yearId: 'y-2', orgId: null, memberIds: [] }),
        ],
        orgId: 'o-1',
        evidenceMethod: '게재 증빙',
        note: '비고',
        order: 0,
      },
      {
        ...ENTITY,
        id: 'd-2',
        version: 1,
        projectId: 'proj-1',
        type: 'patent_dom_apply',
        name: '특허 출원',
        // 빈 단위는 파서가 기본 단위로 채운다 — 투영도 같아야 한다
        unit: '',
        weight: 40,
        targetTotal: 2,
        targetByYear: { 'y-1': 1, 'y-2': 1 },
        achievements: [],
        orgId: null,
        evidenceMethod: '',
        note: '',
        order: 1,
      },
    ],
    techTargets: [
      {
        ...ENTITY,
        id: 't-1',
        version: 1,
        projectId: 'proj-1',
        name: '정확도',
        group: '성능',
        unit: '%',
        direction: 'higher_better',
        weight: 100,
        targetValue: 90,
        targetByYear: { 'y-1': 80, 'y-2': 90 },
        baselineDomestic: 70,
        worldBest: 95,
        worldBestHolder: '미국',
        measureMethod: 'self',
        measureDescription: '',
        standardBasis: '',
        basisRationale: '',
        evaluationEnvironment: '',
        note: '',
        records: [record('r-1')],
        orgId: 'o-1',
        order: 0,
      },
    ],
  };
}

function formData(current: ReturnType<typeof currentData>): GoalFormData {
  return {
    project: { id: 'proj-1', name: '과제' },
    years: [
      { id: 'y-1', name: '1차년도', order: 0 },
      { id: 'y-2', name: '2차년도', order: 1 },
    ],
    orgs: [{ id: 'o-1', name: '주관기관' }],
    members: [
      { id: 'm-1', name: '홍길동' },
      { id: 'm-2', name: '김철수' },
    ],
    deliverables: current.deliverables,
    techTargets: current.techTargets,
    generatedAt: '2026-09-29T09:00:00.000Z',
  };
}

/**
 * 내려받은 양식 → 파서 행 모델. 수식 셀은 어댑터처럼 null로 읽힌다.
 * `edit`은 파서에 넣기 전 격자를 고친다 — 파서 사유가 미리보기까지 이어지는지 볼 때 쓴다.
 */
function download(
  current = currentData(),
  edit?: (sheets: RawSheet[]) => void
): { meta: GoalFormMeta; rows: GoalFormRows } {
  const workbook = buildGoalForm(formData(current));
  const sheets: RawSheet[] = workbook.sheets.map((sheet) => ({
    name: sheet.name,
    cells: sheet.rows.map((row) => row.map((cell) => ({ value: cell.value ?? null, isError: false }))),
    merges: [],
  }));
  edit?.(sheets);
  const result = parseGoalForm(sheets, { projectId: 'proj-1' });
  if (!result.ok) throw new Error(`거부됨: ${result.rejection.kind}`);
  return { meta: result.meta, rows: result.rows };
}

function preview(
  rows: GoalFormRows,
  meta: GoalFormMeta,
  current = currentData(),
  options?: GoalFormPreviewOptions
) {
  const input: GoalFormPreviewInput = {
    meta,
    rows,
    current,
    linkedTaskCounts: { deliverable: { 'd-1': 3 }, techTarget: { 't-1': 1 } },
    options,
  };
  return previewGoalForm(input);
}

function statuses(p: ReturnType<typeof preview>): string[] {
  return [...p.rows.deliverables, ...p.rows.achievements, ...p.rows.techTargets, ...p.rows.records].map(
    (r) => `${r.id ?? 'new'}:${r.status}`
  );
}

// ─── 그대로 올리기 ───────────────────────────────────────────

describe('previewGoalForm — 그대로 올리기', () => {
  it('전 행 unchanged, 삭제 후보 0, 경고 없음, 페이로드 빈 채', () => {
    const { meta, rows } = download();
    const p = preview(rows, meta);
    expect(statuses(p)).toEqual(['d-1:unchanged', 'd-2:unchanged', 'a-1:unchanged', 'a-2:unchanged', 't-1:unchanged', 'r-1:unchanged']);
    expect(p.deleteCandidates).toEqual([]);
    expect(p.conflicts).toEqual([]);
    expect(p.issues).toEqual([]);
    expect(p.blocked).toBe(false);
    expect(p.counts).toMatchObject({ add: 0, update: 0, unchanged: 6, conflict: 0, error: 0, deleteCandidates: 0 });

    const { payload, expected } = buildGoalFormCommit(p);
    for (const block of Object.values(payload)) {
      expect(block).toEqual({ adds: [], updates: [], deleteIds: [] });
    }
    expect(expected).toEqual({});
  });

  it('unchanged 행의 값은 기존 값 그대로(공백·빈 단위 유지)', () => {
    const { meta, rows } = download();
    const p = preview(rows, meta);
    expect(p.rows.deliverables[0]?.values?.name).toBe(' 논문 게재 ');
    expect(p.rows.deliverables[1]?.values?.unit).toBe('');
  });
});

// ─── 변경·추가 ───────────────────────────────────────────────

describe('previewGoalForm — 변경·추가', () => {
  it('이름 수정 → 같은 id의 update, 달라진 필드만', () => {
    const { meta, rows } = download();
    rows.deliverables[0]!.name = '국제 논문 게재';
    const p = preview(rows, meta);
    const row = p.rows.deliverables[0]!;
    expect(row.status).toBe('update');
    expect(row.id).toBe('d-1');
    expect(row.changedFields).toEqual(['name']);

    const { payload, expected } = buildGoalFormCommit(p);
    expect(payload.deliverables.adds).toEqual([]);
    expect(payload.deliverables.updates).toEqual([
      {
        id: 'd-1',
        type: 'paper_sci',
        name: '국제 논문 게재',
        unit: '건',
        weight: 60,
        target_total: 3,
        // _meta 연차 키만 — 양식 밖 키(y-x)는 싣지 않아 RPC가 보존한다(S-13)
        target_by_year: { 'y-1': 1, 'y-2': 2 },
        org_id: 'o-1',
        evidence_method: '게재 증빙',
        note: '비고',
      },
    ]);
    expect(expected).toEqual({ 'd-1': 2 });
  });

  it('관여자 순서만 바뀐 실적은 unchanged', () => {
    const { meta, rows } = download();
    rows.achievements[0]!.memberIds = ['m-2', 'm-1'];
    expect(preview(rows, meta).rows.achievements[0]?.status).toBe('unchanged');
  });

  it('행 추가 → add, row_key는 시트 행 번호, 추가는 시트 순서', () => {
    const { meta, rows } = download();
    const base = rows.deliverables[1]!;
    rows.deliverables.push(
      { ...base, id: null, sheetRow: 40, name: '기술이전', type: 'tech_transfer', unit: '건', issues: [] },
      { ...base, id: null, sheetRow: 41, name: '표준화', type: 'standard', unit: '건', issues: [] }
    );
    const p = preview(rows, meta);
    expect(p.rows.deliverables.slice(2).map((r) => r.status)).toEqual(['add', 'add']);
    const { payload } = buildGoalFormCommit(p);
    expect(payload.deliverables.adds.map((a) => [a.row_key, a.name])).toEqual([
      ['row:40', '기술이전'],
      ['row:41', '표준화'],
    ]);
    expect(payload.deliverables.adds[0]).toMatchObject({ unit: '건', target_by_year: { 'y-1': 1, 'y-2': 1 } });
  });

  it('새 지표 + 새 실적: 지표는 row_key, 실적은 deliverable_ref', () => {
    const { meta, rows } = download();
    rows.deliverables.push({ ...rows.deliverables[1]!, id: null, sheetRow: 40, name: '기술이전', issues: [] });
    rows.achievements.push({
      ...rows.achievements[0]!,
      id: null,
      sheetRow: 30,
      parentName: '기술이전',
      parent: { kind: 'new', row: 40 },
      title: '이전 계약',
      yearId: null,
      memberIds: ['m-1'],
      issues: [],
    });
    const p = preview(rows, meta);
    expect(p.rows.achievements[2]?.status).toBe('add');
    const { payload } = buildGoalFormCommit(p);
    expect(payload.deliverables.adds[0]?.row_key).toBe('row:40');
    expect(payload.achievements.adds).toEqual([
      {
        deliverable_ref: 'row:40',
        title: '이전 계약',
        date: '2026-03-01',
        year_id: null,
        org_id: 'o-1',
        member_ids: ['m-1'],
        evidence_url: '',
        note: '',
      },
    ]);
  });

  it('기존 지표에 새 실적 → deliverable_id', () => {
    const { meta, rows } = download();
    rows.achievements.push({ ...rows.achievements[0]!, id: null, sheetRow: 30, title: '새 논문', issues: [] });
    const { payload } = buildGoalFormCommit(preview(rows, meta));
    expect(payload.achievements.adds[0]).toMatchObject({ deliverable_id: 'd-1', title: '새 논문' });
    expect(payload.achievements.adds[0]).not.toHaveProperty('deliverable_ref');
  });

  it('측정 변경 → update에 현재 부모 tech_target_id', () => {
    const { meta, rows } = download();
    rows.records[0]!.value = 88;
    const p = preview(rows, meta);
    expect(p.rows.records[0]?.changedFields).toEqual(['value']);
    const { payload, expected } = buildGoalFormCommit(p);
    expect(payload.records.updates[0]).toMatchObject({ id: 'r-1', tech_target_id: 't-1', value: 88, year_id: 'y-1' });
    expect(expected).toEqual({ 'r-1': 1 });
  });
});

// ─── targetByYear (S-13) ─────────────────────────────────────

describe('previewGoalForm — 연차 목표 병합', () => {
  it('_meta 밖 키는 무시·보존, 빈 칸은 null(= 키 삭제)', () => {
    const { meta, rows } = download();
    rows.deliverables[0]!.targetByYear = { 'y-1': null, 'y-2': 2 };
    const p = preview(rows, meta);
    const row = p.rows.deliverables[0]!;
    expect(row.changedFields).toEqual(['targetByYear']);
    expect(buildGoalFormCommit(p).payload.deliverables.updates[0]?.target_by_year).toEqual({ 'y-1': null, 'y-2': 2 });
    // 적용 후 상태: y-1 삭제, y-x 보존
    expect(p.after.deliverables.find((d) => d.id === 'd-1')?.targetByYear).toEqual({ 'y-2': 2, 'y-x': 5 });
  });

  it('양식 밖 키만 다른 기존 행은 unchanged', () => {
    const current = currentData();
    const { meta, rows } = download(current);
    current.deliverables[0]!.targetByYear['y-z'] = 9;
    expect(preview(rows, meta, current).rows.deliverables[0]?.status).toBe('unchanged');
  });
});

// ─── 삭제 후보 ───────────────────────────────────────────────

describe('previewGoalForm — 삭제 후보', () => {
  function withoutD1() {
    const { meta, rows } = download();
    rows.deliverables = rows.deliverables.filter((r) => r.id !== 'd-1');
    rows.achievements = rows.achievements.filter((r) => r.id !== 'a-1' && r.id !== 'a-2');
    return { meta, rows };
  }

  it('_meta id − 시트 id, 딸린 실적·연계 작업 수', () => {
    const { meta, rows } = withoutD1();
    const p = preview(rows, meta);
    expect(p.deleteCandidates.map((d) => [d.kind, d.id, d.conflict])).toEqual([
      ['deliverable', 'd-1', null],
      ['achievement', 'a-1', null],
      ['achievement', 'a-2', null],
    ]);
    expect(p.deleteCandidates[0]).toMatchObject({ achievementCount: 2, linkedTaskCount: 3, childIds: ['a-1', 'a-2'] });
    expect(p.counts.deleteCandidates).toBe(3);
  });

  it('기술목표 삭제 후보: 측정 M · 연계 작업 K', () => {
    const { meta, rows } = download();
    rows.techTargets = [];
    rows.records = [];
    const p = preview(rows, meta);
    expect(p.deleteCandidates.find((d) => d.id === 't-1')).toMatchObject({ recordCount: 1, linkedTaskCount: 1 });
  });

  it('includeDeletes false면 페이로드에 삭제가 없다', () => {
    const { meta, rows } = withoutD1();
    const { payload, expected } = buildGoalFormCommit(preview(rows, meta));
    expect(payload.deliverables.deleteIds).toEqual([]);
    expect(payload.achievements.deleteIds).toEqual([]);
    expect(expected).toEqual({});
  });

  it('includeDeletes true면 deleteIds + expected에 부모의 현재 자식 포함', () => {
    const { meta, rows } = withoutD1();
    const { payload, expected } = buildGoalFormCommit(preview(rows, meta, currentData(), { includeDeletes: true }));
    expect(payload.deliverables.deleteIds).toEqual(['d-1']);
    expect(payload.achievements.deleteIds).toEqual(['a-1', 'a-2']);
    expect(expected).toEqual({ 'd-1': 2, 'a-1': 1, 'a-2': 1 });
  });

  it('자식만 남기고 부모를 지워도(자식은 시트에 없어도) expected에 자식이 실린다', () => {
    const { meta, rows } = download();
    rows.techTargets = [];
    rows.records = [];
    const { payload, expected } = buildGoalFormCommit(preview(rows, meta, currentData(), { includeDeletes: true }));
    expect(payload.techTargets.deleteIds).toEqual(['t-1']);
    expect(expected).toMatchObject({ 't-1': 1, 'r-1': 1 });
  });

  it('allowDeletes false면 삭제 후보 0 (includeDeletes여도)', () => {
    const { meta, rows } = withoutD1();
    const p = preview(rows, meta, currentData(), { includeDeletes: true, allowDeletes: false });
    expect(p.deleteCandidates).toEqual([]);
    const { payload } = buildGoalFormCommit(p);
    expect(payload.deliverables.deleteIds).toEqual([]);
    expect(payload.achievements.deleteIds).toEqual([]);
  });

  it('내려받은 뒤 자식이 추가된 부모는 충돌(S-6②) — deleteIds에서 빠진다', () => {
    const { meta, rows } = withoutD1();
    const current = currentData();
    current.deliverables[0]!.achievements.push(achievement('a-new'));
    const p = preview(rows, meta, current, { includeDeletes: true });
    expect(p.deleteCandidates.find((d) => d.id === 'd-1')?.conflict).toBe('changed');
    expect(p.conflicts).toContainEqual({ kind: 'deliverable', id: 'd-1', reason: 'changed' });
    expect(buildGoalFormCommit(p).payload.deliverables.deleteIds).toEqual([]);
  });

  it('오류 행이 가리키는 id는 삭제 후보가 아니다', () => {
    const { meta, rows } = download();
    rows.deliverables[0]!.issues.push({ kind: 'no-type', message: 'x', blocking: true });
    rows.deliverables[0]!.type = null;
    const p = preview(rows, meta);
    expect(p.rows.deliverables[0]?.status).toBe('error');
    expect(p.deleteCandidates).toEqual([]);
  });
});

// ─── 충돌 ────────────────────────────────────────────────────

describe('previewGoalForm — 충돌', () => {
  it('내려받은 뒤 version이 바뀌면 changed, 페이로드에서 뺀다', () => {
    const { meta, rows } = download();
    rows.deliverables[0]!.name = '바꾼 이름';
    const current = currentData();
    current.deliverables[0]!.version = 3;
    const p = preview(rows, meta, current);
    expect(p.rows.deliverables[0]).toMatchObject({ status: 'conflict', conflict: 'changed', values: null });
    expect(p.rows.deliverables[0]?.issues.map((i) => i.kind)).toContain('conflict');
    expect(p.conflicts).toEqual([{ kind: 'deliverable', id: 'd-1', reason: 'changed' }]);
    expect(p.blocked).toBe(false);
    const { payload, expected } = buildGoalFormCommit(p);
    expect(payload.deliverables.updates).toEqual([]);
    expect(expected).toEqual({});
  });

  it('_meta에 있는데 DB에서 사라진 행은 deleted', () => {
    const { meta, rows } = download();
    const current = currentData();
    current.deliverables = current.deliverables.filter((d) => d.id !== 'd-2');
    const p = preview(rows, meta, current);
    expect(p.rows.deliverables[1]).toMatchObject({ id: 'd-2', status: 'conflict', conflict: 'deleted' });
    expect(p.counts.conflict).toBe(1);
  });

  it('시트에서 지운 행이 DB에서도 이미 지워졌으면 삭제 후보 충돌 deleted', () => {
    const { meta, rows } = download();
    rows.deliverables = rows.deliverables.filter((r) => r.id !== 'd-2');
    const current = currentData();
    current.deliverables = current.deliverables.filter((d) => d.id !== 'd-2');
    const p = preview(rows, meta, current, { includeDeletes: true });
    expect(p.deleteCandidates).toEqual([expect.objectContaining({ id: 'd-2', conflict: 'deleted' })]);
    expect(buildGoalFormCommit(p).payload.deliverables.deleteIds).toEqual([]);
  });
});

// ─── duplicate-row (S-18) ────────────────────────────────────

describe('previewGoalForm — 같은 숨김 id 여러 행', () => {
  it('투영과 같은 행이 하나면 원본, 나머지는 add(숨김 id 무시)', () => {
    const { meta, rows } = download();
    const original = rows.deliverables[0]!;
    rows.deliverables.push({ ...original, sheetRow: 40, name: '복사한 지표', issues: [] });
    const p = preview(rows, meta);
    expect(p.rows.deliverables[0]?.status).toBe('unchanged');
    expect(p.rows.deliverables[2]).toMatchObject({ status: 'add', copiedFrom: 'd-1', id: 'd-1' });
    const { payload, expected } = buildGoalFormCommit(p);
    expect(payload.deliverables.adds.map((a) => [a.row_key, a.name])).toEqual([['row:40', '복사한 지표']]);
    expect(payload.deliverables.adds[0]).not.toHaveProperty('id');
    expect(payload.deliverables.updates).toEqual([]);
    expect(expected).toEqual({});
  });

  it('원본을 가릴 수 없으면 해당 행 전부 blocking duplicate-row', () => {
    const { meta, rows } = download();
    const original = rows.deliverables[0]!;
    original.name = '고친 이름';
    rows.deliverables.push({ ...original, sheetRow: 40, name: '또 고친 이름', issues: [] });
    const p = preview(rows, meta);
    for (const row of [p.rows.deliverables[0]!, p.rows.deliverables[2]!]) {
      expect(row.status).toBe('error');
      expect(row.issues.map((i) => i.kind)).toContain('duplicate-row');
    }
    expect(p.blocked).toBe(true);
  });

  it('복사 실적은 원래 부모에 붙는 add', () => {
    const { meta, rows } = download();
    rows.achievements.push({ ...rows.achievements[0]!, sheetRow: 30, title: '복사 실적', issues: [] });
    const { payload } = buildGoalFormCommit(preview(rows, meta));
    expect(payload.achievements.adds).toEqual([expect.objectContaining({ deliverable_id: 'd-1', title: '복사 실적' })]);
  });
});

// ─── parent-moved DB 대조 ────────────────────────────────────

describe('previewGoalForm — parent-moved', () => {
  it('숨김 부모 id가 DB 현재 부모와 다르면 blocking', () => {
    const { meta, rows } = download();
    rows.achievements[0]!.parent = { kind: 'existing', id: 'd-2' };
    const p = preview(rows, meta);
    expect(p.rows.achievements[0]?.status).toBe('error');
    expect(p.rows.achievements[0]?.issues.map((i) => i.kind)).toContain('parent-moved');
    expect(p.blocked).toBe(true);
  });

  it('측정도 같다', () => {
    const { meta, rows } = download();
    rows.records[0]!.parent = { kind: 'new', row: 40 };
    const p = preview(rows, meta);
    expect(p.rows.records[0]?.issues.map((i) => i.kind)).toContain('parent-moved');
  });
});

// ─── 파서 오류가 미리보기를 막는다 ──────────────────────────

const SHEETS = goalSheetsFor(['1차년도', '2차년도']);

function setCell(sheets: RawSheet[], def: GoalSheetDef, row0: number, role: string, value: string | number | null) {
  const sheet = sheets.find((s) => s.name === def.name);
  if (sheet === undefined) throw new Error(`시트 없음: ${def.name}`);
  const line = (sheet.cells[row0] ??= []);
  line[goalColumnOf(def, role as never)] = { value, isError: false };
}

describe('previewGoalForm — 파서 blocking 사유', () => {
  it('부모 측정방법이 모르는 라벨 + 측정 방법 빈 칸 → throw 없이 blocked (no-method)', () => {
    const { meta, rows } = download(currentData(), (sheets) => {
      setCell(sheets, SHEETS.techTargets, SHEETS.techTargets.dataStartRow - 1, 'measureMethod', '엉터리');
      setCell(sheets, SHEETS.records, SHEETS.records.dataStartRow - 1, 'method', null);
    });
    expect(rows.records[0]?.method).toBeNull();
    expect(rows.records[0]?.issues.map((i) => i.kind)).toEqual(['no-method']);
    let p: ReturnType<typeof preview> | undefined;
    expect(() => {
      p = preview(rows, meta);
    }).not.toThrow();
    expect(p?.blocked).toBe(true);
    expect(p?.rows.records[0]?.status).toBe('error');
  });

  it('합계 행 아래에 적은 행 → throw 없이 blocked (below-total)', () => {
    const { meta, rows } = download(currentData(), (sheets) => {
      const def = SHEETS.deliverables;
      const sheet = sheets.find((s) => s.name === def.name)!;
      const below = sheet.cells.length + 1;
      setCell(sheets, def, below, 'type', 'SCI(E) 논문');
      setCell(sheets, def, below, 'name', '합계 아래 지표');
    });
    const added = rows.deliverables.find((d) => d.name === '합계 아래 지표');
    expect(added?.issues.map((i) => i.kind)).toEqual(['below-total']);
    const p = preview(rows, meta);
    expect(p.blocked).toBe(true);
    expect(p.counts.error).toBe(1);
  });
});

// ─── 경고 ────────────────────────────────────────────────────

describe('previewGoalForm — 경고', () => {
  it('성과목표 가중치 합 ≠ 100 (적용 후 기준)', () => {
    const { meta, rows } = download();
    rows.deliverables[0]!.weight = 50;
    const p = preview(rows, meta);
    expect(p.issues).toEqual([expect.objectContaining({ kind: 'weight-sum', blocking: false })]);
    expect(p.issues[0]?.message).toContain('90');
    expect(p.rates.after.deliverableWeights).toEqual({ totalWeight: 90, weightMismatch: true });
    expect(p.rates.before.deliverableWeights.weightMismatch).toBe(false);
    expect(p.blocked).toBe(false);
  });

  it('기술목표 비중 합 ≠ 100', () => {
    const { meta, rows } = download();
    rows.techTargets.push({ ...rows.techTargets[0]!, id: null, sheetRow: 40, name: '속도', weight: 20, issues: [] });
    const p = preview(rows, meta);
    expect(p.issues.map((i) => i.message)).toEqual([expect.stringContaining('기술목표 비중 합계 120')]);
  });

  it('파서 경고는 행에 그대로 남는다', () => {
    const { meta, rows } = download();
    const warning = { kind: 'total-mismatch' as const, message: '경고', blocking: false };
    rows.deliverables[0]!.issues.push(warning);
    const p = preview(rows, meta);
    expect(p.rows.deliverables[0]?.issues).toContainEqual(warning);
    expect(p.counts.warning).toBe(1);
  });
});

// ─── 달성률 전후 ─────────────────────────────────────────────

describe('previewGoalForm — 달성률 전후', () => {
  it('lib/goals 결과와 일치 — 실적 추가·측정 변경', () => {
    const { meta, rows } = download();
    rows.achievements.push({
      ...rows.achievements[0]!,
      id: null,
      sheetRow: 30,
      parentName: '특허 출원',
      parent: { kind: 'existing', id: 'd-2' },
      title: '특허 1',
      issues: [],
    });
    rows.records[0]!.value = 90;
    const current = currentData();
    const p = preview(rows, meta, current);

    expect(p.rates.before.deliverables).toEqual(computeDeliverableTotal(current.deliverables));
    expect(p.rates.before.techTargets).toEqual(computeTechTargetTotal(current.techTargets));
    // 전: 실적 2 / 목표 5 = 40%, 측정 (85-70)/(90-70) = 75%
    expect(p.rates.before.deliverables.rate).toBe(40);
    expect(p.rates.before.techTargets.weightedRate).toBe(75);
    // 후: 3 / 5 = 60%, 측정 90 → 100%
    expect(p.rates.after.deliverables.rate).toBe(60);
    expect(p.rates.after.techTargets.weightedRate).toBe(100);
    expect(p.rates.after.deliverables).toEqual(computeDeliverableTotal(p.after.deliverables));
    expect(p.rates.after.techTargets).toEqual(computeTechTargetTotal(p.after.techTargets));
    // 입력을 바꾸지 않는다
    expect(current.deliverables[1]?.achievements).toEqual([]);
    expect(current.techTargets[0]?.records[0]?.value).toBe(85);
  });

  it('삭제는 includeDeletes일 때만 "후"에 반영', () => {
    const { meta, rows } = download();
    rows.deliverables = rows.deliverables.filter((r) => r.id !== 'd-1');
    rows.achievements = [];
    expect(preview(rows, meta).rates.after.deliverables.target).toBe(5);
    const withDeletes = preview(rows, meta, currentData(), { includeDeletes: true });
    expect(withDeletes.rates.after.deliverables).toMatchObject({ target: 2, achieved: 0, rate: 0 });
  });
});

// ─── 차단 ────────────────────────────────────────────────────

describe('buildGoalFormCommit — 차단', () => {
  it('blocked면 throw', () => {
    const { meta, rows } = download();
    rows.records[0]!.issues.push({ kind: 'no-value', message: 'x', blocking: true });
    rows.records[0]!.value = null;
    const p = preview(rows, meta);
    expect(p.blocked).toBe(true);
    expect(p.counts.error).toBe(1);
    expect(() => buildGoalFormCommit(p)).toThrow();
  });

  it('다른 과제의 현재 데이터가 섞이면 throw', () => {
    const { meta, rows } = download();
    const current = currentData();
    current.techTargets[0]!.projectId = 'other';
    expect(() => preview(rows, meta, current)).toThrow();
  });
});
