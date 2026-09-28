// 실측 계획서 hwpx 검증 (SOT §6.18 HX-1~HX-8, 부록 C.3, §11 Phase 22 완료 기준, S-24·S-34)
//
// 브라우저가 돌릴 추출 코드(zip·extract·tables)와 서버 행 해석(rows)을 실제 계획서 한 부로 끝까지 태운다.
// samples/는 .gitignore 대상(실데이터)이라 저장소에 없다 — 파일이 없으면 조용히 통과시키지 않고 사유를 알린 뒤 skip.
//
// S-34: 실데이터 문자열(평가항목명·기관명·수치)을 이 파일에 적지 않는다. 단언은 건수·구조·유형 분포와 양식 고정 문구
// (`SMART`·`Impact Factor`)뿐이다. 과제 기관 목록도 표의 담당기관 셀에서 읽어 테스트 안에서 만든다.

import fs from 'node:fs';
import path from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { previewGoalForm } from '@/lib/goal-form/preview';
import type { GoalFormPreview } from '@/lib/goal-form/preview';
import { extractHwpxTables } from '@/lib/hwpx/extract';
import { checkPlanPayload, utf8ByteLength } from '@/lib/hwpx/limits';
import { buildPlanRows, isTimeUnit, oneLine, PLAN_EXCLUDED_REASON, planNameKey } from '@/lib/hwpx/rows';
import type { BuildPlanRowsInput, PlanRowsResult } from '@/lib/hwpx/rows';
import { serializePlanTables } from '@/lib/hwpx/serialize';
import { identifyPlanTables, selectPayloadTables } from '@/lib/hwpx/tables';
import type { PlanTablesResult } from '@/lib/hwpx/tables';
import type { HwpxExtractResult, HwpxTable } from '@/lib/hwpx/types';
import { readHwpxSections } from '@/lib/hwpx/zip';
import type { Deliverable, TechTarget } from '@/types';

const REPO_ROOT = path.resolve(__dirname, '../..');
const SAMPLES_DIR = path.join(REPO_ROOT, 'samples');

function findSample(): string | null {
  if (!fs.existsSync(SAMPLES_DIR)) return null;
  const name = fs.readdirSync(SAMPLES_DIR).find((f) => f.toLowerCase().endsWith('.hwpx'));
  return name === undefined ? null : path.join(SAMPLES_DIR, name);
}

const SAMPLE = findSample();
if (SAMPLE === null) {
  process.stderr.write('[hwpx-sample] samples/*.hwpx 없음 — 실측 검증을 건너뜁니다(samples/는 PC 간 수동 복사)\n');
}
const describeSample = SAMPLE === null ? describe.skip : describe;

// ─── 실측 고정값 (2026-09-29 측정 — 계획서가 바뀌면 다시 재서 고친다) ─────────

/** 기술목표 연차 셀 힌트(이하·이내·< 등) 또는 시간 단위로 lower_better가 된 행 수(U-3) */
const LOWER_BETTER_ROWS = 7;
/** 단위가 C.3.6 시간 단위와 완전 일치하는 기술목표 행 수 */
const TIME_UNIT_ROWS = 5;

// ─── 과제 합성 ───────────────────────────────────────────────

const PROJECT = 'sample-project';
const EMPTY = { deliverables: [] as Deliverable[], techTargets: [] as TechTarget[] };

function syntheticYears(): BuildPlanRowsInput['years'] {
  return [0, 1, 2, 3].map((i) => ({ id: `year-${i + 1}`, name: `${i + 1}차년도`, order: i }));
}

/** 기술목표 표 담당기관 셀의 고유값(이름 키 기준) — 기관명을 코드에 적지 않고 표에서 읽는다(S-34) */
function orgsFromTable(tables: PlanTablesResult): BuildPlanRowsInput['orgs'] {
  const tech = tables.tech;
  if (tech === null || tech.columns.org === null) throw new Error('기술목표 표 또는 담당기관 열을 찾지 못함');
  const col = tech.columns.org;
  const byKey = new Map<string, string>();
  for (const row of tech.rows) {
    const name = oneLine(row[col]);
    if (name !== '' && !byKey.has(planNameKey(name))) byKey.set(planNameKey(name), name);
  }
  return [...byKey.values()].map((name, i) => ({ id: `org-${i + 1}`, name }));
}

function preview(r: PlanRowsResult, current: typeof EMPTY): GoalFormPreview {
  return previewGoalForm({
    meta: r.meta,
    rows: r.rows,
    current,
    linkedTaskCounts: { deliverable: {}, techTarget: {} },
    options: { allowDeletes: false },
  });
}

/** 미리보기 적용 후 상태를 DB로 삼는다 — 반영이 version을 올리므로 올려 둔다 */
function afterState(p: GoalFormPreview): typeof EMPTY {
  return {
    deliverables: p.after.deliverables.map((d) => ({ ...d, version: d.version + 1 })),
    techTargets: p.after.techTargets.map((t) => ({ ...t, version: t.version + 1 })),
  };
}

function blockingKinds(p: GoalFormPreview): string[] {
  const rows = [...p.rows.deliverables, ...p.rows.techTargets];
  return [...rows.flatMap((r) => r.issues), ...p.issues].filter((i) => i.blocking).map((i) => i.kind);
}

function mb(bytes: number): string {
  return `${(bytes / 1024 / 1024).toFixed(1)}MB`;
}

// ─── git 인덱스 (child_process 없이 `git ls-files samples`) ──────────────

/** .git/index(v2·v3)의 경로 목록. v4(경로 접두 압축)는 지원하지 않는다 — 만나면 실패로 알린다 */
function gitIndexPaths(indexFile: string): string[] {
  const buf = fs.readFileSync(indexFile);
  if (buf.toString('latin1', 0, 4) !== 'DIRC') throw new Error('git index 서명이 아님');
  const version = buf.readUInt32BE(4);
  if (version !== 2 && version !== 3) throw new Error(`지원하지 않는 git index 버전 ${version}`);
  const count = buf.readUInt32BE(8);
  const paths: string[] = [];
  let off = 12;
  for (let i = 0; i < count; i++) {
    const flags = buf.readUInt16BE(off + 60);
    const extended = version === 3 && (flags & 0x4000) !== 0;
    const nameStart = off + 62 + (extended ? 2 : 0);
    const nameEnd = buf.indexOf(0, nameStart);
    paths.push(buf.toString('utf8', nameStart, nameEnd));
    // 엔트리는 NUL 1개 이상으로 8바이트 경계까지 채운다
    const entryLen = nameEnd - off;
    off += Math.ceil((entryLen + 1) / 8) * 8;
  }
  return paths;
}

// ─── 실측 ────────────────────────────────────────────────────

describeSample('실측 계획서 hwpx (samples/)', () => {
  let extracted: HwpxExtractResult;
  let tables: PlanTablesResult;
  let orgs: BuildPlanRowsInput['orgs'];
  let result: PlanRowsResult;
  let first: GoalFormPreview;

  beforeAll(() => {
    const file = SAMPLE!;
    const heap0 = process.memoryUsage().heapUsed;
    const t0 = performance.now();
    const bytes = new Uint8Array(fs.readFileSync(file));
    const t1 = performance.now();
    const sections = readHwpxSections(bytes, path.basename(file));
    if (!sections.ok) throw new Error(`readHwpxSections 거부: ${sections.message}`);
    const t2 = performance.now();
    extracted = extractHwpxTables(sections.sections);
    const t3 = performance.now();
    const heap1 = process.memoryUsage().heapUsed;
    tables = identifyPlanTables(extracted.tables, extracted.skipped);
    orgs = orgsFromTable(tables);
    result = buildPlanRows({ projectId: PROJECT, tables, years: syntheticYears(), orgs, current: EMPTY });
    first = preview(result, EMPTY);
    const t4 = performance.now();
    // S-24: Worker 도입 판단 근거(추출 1.5초). 파일 읽기는 브라우저에선 File.arrayBuffer라 따로 적는다
    process.stderr.write(
      `[hwpx-sample] 파일 ${mb(bytes.length)} · 읽기 ${(t1 - t0).toFixed(0)}ms · 해제 ${(t2 - t1).toFixed(0)}ms · ` +
        `표 추출 ${(t3 - t2).toFixed(0)}ms (해제+추출 ${(t3 - t1).toFixed(0)}ms) · 식별+행 해석+미리보기 ${(t4 - t3).toFixed(0)}ms · ` +
        `힙 증가(추출까지) ${mb(heap1 - heap0)}\n`,
    );
  }, 120_000);

  describe('추출·식별 (HX-1~HX-4)', () => {
    it('표 276개, 구조 불일치 0', () => {
      expect(extracted.tables).toHaveLength(276);
      expect(extracted.skipped).toEqual([]);
    });

    it('종류별 서명 일치 1묶음·조각 1개(쪽 나뉨 없음), 데이터 28/14/28, 머리행 2/2/1', () => {
      const shape = (t: { pieces: number[]; headerRows: number; rows: string[][] } | null) =>
        t === null ? null : { pieces: t.pieces.length, headerRows: t.headerRows, rows: t.rows.length };
      expect(shape(tables.tech)).toEqual({ pieces: 1, headerRows: 2, rows: 28 });
      expect(shape(tables.deliverable)).toEqual({ pieces: 1, headerRows: 2, rows: 14 });
      expect(shape(tables.method)).toEqual({ pieces: 1, headerRows: 1, rows: 28 });
      const kinds = tables.issues.map((i) => i.kind);
      expect(kinds).not.toContain('duplicate-table');
      expect(kinds).not.toContain('table-not-found');
      expect(kinds).not.toContain('sequence-gap');
      expect(tables.issues.filter((i) => i.blocking)).toEqual([]);
    });

    it('격자 페이로드 = 서명 일치 표 3개, 상한 안(S-14)', () => {
      const payloadTables: HwpxTable[] = selectPayloadTables(extracted);
      expect(payloadTables).toHaveLength(3);
      const payload = { fileName: path.basename(SAMPLE!), tables: payloadTables };
      const bytes = utf8ByteLength(serializePlanTables(payload));
      process.stderr.write(`[hwpx-sample] 격자 JSON ${bytes}B\n`);
      expect(checkPlanPayload(payload)).toEqual({ ok: true });
    });
  });

  describe('기술목표 행 (HX-5·HX-7)', () => {
    it('28행, 비중 합 100, 표 단위 사유 0', () => {
      const rows = result.rows.techTargets;
      expect(rows).toHaveLength(28);
      expect(rows.reduce((s, r) => s + (r.weight ?? Number.NaN), 0)).toBe(100);
      expect(result.issues).toEqual([]);
      expect(rows.flatMap((r) => r.issues).filter((i) => i.blocking)).toEqual([]);
    });

    it('평가방법 표 28행이 모두 연결 — measureDescription 28, evaluationEnvironment ≥ 1, basisRationale 전부 빈 값(U-8)', () => {
      const rows = result.rows.techTargets;
      expect(rows.filter((r) => r.measureDescription !== '')).toHaveLength(28);
      expect(rows.filter((r) => r.evaluationEnvironment !== '').length).toBeGreaterThanOrEqual(1);
      expect(rows.every((r) => r.basisRationale === '')).toBe(true);
    });

    it('읽지 않는 열(U-2)과 구분(U-1)은 새 행 기본값', () => {
      for (const r of result.rows.techTargets) {
        expect(r.worldBest).toBeNull();
        expect(r.baselineDomestic).toBeNull();
        expect(r.worldBestHolder).toBe('');
        expect(r.standardBasis).toBe('');
        expect(r.group).toBe('');
      }
    });

    it('담당기관은 표에서 만든 과제 기관과 전부 대응(HX-5)', () => {
      expect(orgs.length).toBeGreaterThan(0);
      expect(result.rows.techTargets.every((r) => r.orgId !== null)).toBe(true);
      expect(result.rows.techTargets.flatMap((r) => r.issues).map((i) => i.kind)).not.toContain('org-unmatched');
    });

    it(`방향: lower_better ${LOWER_BETTER_ROWS}행, 시간 단위 ${TIME_UNIT_ROWS}행(U-3, C.3.6)`, () => {
      const rows = result.rows.techTargets;
      const lower = rows.filter((r) => r.direction === 'lower_better');
      const time = rows.filter((r) => isTimeUnit(r.unit));
      process.stderr.write(
        `[hwpx-sample] lower_better ${lower.length} · 시간 단위 ${time.length} · ` +
          `시간 단위이면서 higher ${time.filter((r) => r.direction !== 'lower_better').length}\n`,
      );
      expect(lower).toHaveLength(LOWER_BETTER_ROWS);
      expect(time).toHaveLength(TIME_UNIT_ROWS);
      expect(rows.every((r) => r.direction !== null)).toBe(true);
      // 실측: 시간 단위 행은 모두 lower(이상 힌트로 뒤집힌 행 없음) — 나머지 lower는 셀 힌트에서 온다
      expect(time.every((r) => r.direction === 'lower_better')).toBe(true);
    });
  });

  describe('성과목표 행 (HX-6)', () => {
    it('반영 11 + 제외 3(SMART 2 · Impact Factor 1)', () => {
      expect(result.rows.deliverables).toHaveLength(11);
      expect(result.excluded).toHaveLength(3);
      expect(result.excluded.every((e) => e.reason === PLAN_EXCLUDED_REASON && e.table === 'deliverable')).toBe(true);
      expect(result.excluded.filter((e) => /SMART/i.test(e.name))).toHaveLength(2);
      expect(result.excluded.filter((e) => /Impact\s*Factor/i.test(e.name))).toHaveLength(1);
      // 반영 행과 제외 행이 표 14행을 겹침 없이 나눈다
      const all = [...result.rows.deliverables.map((d) => d.sheetRow), ...result.excluded.map((e) => e.tableRow)];
      expect(new Set(all).size).toBe(14);
    });

    it('반영 11행 가중치 합 100', () => {
      expect(result.rows.deliverables.reduce((s, d) => s + (d.weight ?? Number.NaN), 0)).toBe(100);
    });

    it('유형 분포 — 부록 C.3.2 실측 표', () => {
      const dist: Record<string, number> = {};
      for (const d of result.rows.deliverables) dist[d.type ?? 'null'] = (dist[d.type ?? 'null'] ?? 0) + 1;
      expect(dist).toEqual({
        hr_training: 2,
        sw_registration: 1,
        patent_dom_apply: 1,
        patent_dom_reg: 1,
        patent_intl_apply: 1,
        patent_intl_reg: 1,
        paper_sci: 1,
        paper_domestic: 1,
        conference: 1,
        commercialization: 1,
      });
    });

    it('목표가 전부 빈 특허 행은 제외하지 않고 목표 0(C.3.7 ②)', () => {
      const zero = result.rows.deliverables.filter((d) => d.targetTotal === 0);
      expect(zero).toHaveLength(1);
      expect(zero[0]!.type).toBe('patent_intl_reg');
      expect(zero[0]!.weight).toBe(0);
    });
  });

  describe('미리보기·멱등 (HX-8)', () => {
    it('빈 과제 → 전 행 add, 삭제 후보 0, blocking 0', () => {
      const statuses = [...first.rows.techTargets, ...first.rows.deliverables].map((r) => r.status);
      expect(statuses).toEqual(Array(39).fill('add'));
      expect(first.counts.add).toBe(39);
      expect(first.deleteCandidates).toEqual([]);
      expect(blockingKinds(first)).toEqual([]);
      expect(first.blocked).toBe(false);
      process.stderr.write(
        `[hwpx-sample] 경고 ${first.counts.warning}건: ${[...first.rows.techTargets, ...first.rows.deliverables]
          .flatMap((r) => r.issues)
          .map((i) => i.kind)
          .join(',')}\n`,
      );
    });

    it('적용 후 상태로 다시 돌리면 전 행 unchanged', () => {
      const after = afterState(first);
      const again = buildPlanRows({ projectId: PROJECT, tables, years: syntheticYears(), orgs, current: after });
      const p2 = preview(again, after);
      const statuses = [...p2.rows.techTargets, ...p2.rows.deliverables].map((r) => r.status);
      expect(statuses).toEqual(Array(39).fill('unchanged'));
      expect(p2.counts.add + p2.counts.update).toBe(0);
      expect(p2.deleteCandidates).toEqual([]);
      expect(p2.blocked).toBe(false);
    });
  });
});

// ─── 실데이터 커밋 금지 ─────────────────────────────────────

describe('samples/는 git에 없다', () => {
  const index = path.join(REPO_ROOT, '.git', 'index');
  const run = fs.existsSync(index) ? it : it.skip;
  run('git 인덱스에 samples/ 경로 0 (`git ls-files samples`)', () => {
    const paths = gitIndexPaths(index);
    expect(paths.length).toBeGreaterThan(0);
    expect(paths.filter((p) => p === 'samples' || p.startsWith('samples/'))).toEqual([]);
  });
});
