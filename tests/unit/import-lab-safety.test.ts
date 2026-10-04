// 연구실 안전관리비 임포트 — SOT §6.8 I-5(총괄표 SKIP) · §6.11 D-2a(산출근거 세목 헤더) · 부록 C 주의 3
// (Phase 26 S-18)
//
// 총괄표는 비목 단위라 그 행을 **읽지 않는다** — 금액이 이미 `간접비` 행에 들어 있어 읽으면 이중 계상이다.
// 산출근거는 다르다 — `연구실 안전관리비` 세목 헤더는 새 세목 `indirect_lab_safety`로 읽고,
// `나. 연구지원비` 표 안의 같은 이름 품명 행은 `indirect_support` 데이터 행 그대로다(B.7·B.8 불변).

import { describe, expect, it } from 'vitest';
import { classifyLabel } from '@/lib/import/categorize';
import { detectBlocks, detectSections, parseDetailRows } from '@/lib/import/detail-sheet';
import { parseMatrix } from '@/lib/import/matrix';
import type { RawCell, RawSheet } from '@/lib/import/types';

type CellSpec = string | number | null;

function sheetOf(name: string, rows: CellSpec[][]): RawSheet {
  return {
    name,
    cells: rows.map((row) => row.map((value): RawCell => ({ value, isError: false }))),
    merges: [],
  };
}

// ─── 총괄표 (§6.8) ───────────────────────────────────────────

describe('총괄표 — 연구실 안전관리비 행은 간접비에 이미 들어 있어 읽지 않는다 (I-5)', () => {
  it('괄호 없는 `연구실 안전관리비`는 스킵 패턴에 걸린다 — `안전관리비`만으로는 완전 일치가 아니다', () => {
    expect(classifyLabel('연구실 안전관리비').kind).toBe('skip');
    expect(classifyLabel('안전관리비').kind).toBe('skip');
  });

  const sheet = sheetOf('총괄표', [
    [null, '구분', '1차년도'],
    [null, '간접비 (L)', 5_000_000],
    [null, '(간접비 중 연구실 안전관리비)', 1_000_000],
    [null, '연구실 안전관리비', 1_000_000],
  ]);
  const { rows } = parseMatrix(sheet, {
    labelColumns: ['B'],
    yearColumns: [{ column: 'C', yearOrder: 0 }],
    dataStartRow: 1,
    amountUnit: 1,
  });

  it('간접비 행만 반영된다 — 간접비 금액은 5,000,000 그대로', () => {
    const mapped = rows.filter((row) => row.status === 'mapped');
    expect(mapped.map((row) => row.category)).toEqual(['indirect']);
    expect(mapped[0]?.amounts.map((amount) => amount.amount)).toEqual([5_000_000]);
  });

  it('괄호 행은 메모 행, 괄호 없는 행은 스킵 패턴으로 건너뛴다', () => {
    const byIndex = new Map(rows.map((row) => [row.rowIndex, row]));
    expect(byIndex.get(2)).toMatchObject({ status: 'skipped', reason: '메모 행 (정규화 후 빈 라벨)' });
    expect(byIndex.get(3)).toMatchObject({ status: 'skipped', reason: '집계·메모 행 (스킵 패턴)' });
  });
});

// ─── 산출근거 (§6.11 D-2a) ───────────────────────────────────

const HEADER: CellSpec[] = ['내역', '단가', '회', '합계', '비고'];

const detailSheet = sheetOf('산출근거', [
  ['2. 간접비 소요명세'],
  ['가. 인력지원비'],
  HEADER,
  ['연구지원인력 인건비', 5_000_000, 1, 5_000_000, null],
  ['나. 연구지원비'],
  HEADER,
  ['기관 공통지원경비', null, null, null, null],
  // 금액 칸이 빈 품명 행 — 이름이 세목 라벨과 같아도 표 본문 안이라 헤더가 아니다
  ['연구실 안전관리비', null, null, null, null],
  // 부록 B.7·B.8 실측 행 — 스킵 패턴에 먹히면 2,000,000이 통째로 사라진다
  ['연구실 안전관리비', 2_000_000, 1, 2_000_000, null],
  ['다. 성과활용지원비'],
  HEADER,
  ['성과 확산 활동비', 1_000_000, 1, 1_000_000, null],
  // 새 세목 헤더 — 번호가 없고 바로 아래에 자기 컬럼 헤더를 거느린다
  ['연구실 안전관리비'],
  HEADER,
  ['안전점검 위탁', 700_000, 1, 700_000, null],
  ['보호구', 300_000, 1, 300_000, null],
]);

const blocks = detectBlocks(detailSheet, detectSections(detailSheet));
const rowsOf = (subcategory: string) =>
  blocks
    .filter((block) => block.subcategory === subcategory)
    .flatMap((block) => parseDetailRows(detailSheet, block).rows);

describe('산출근거 — 세목 헤더는 A.5 라벨로 먼저, 표 안 품명은 데이터 (D-2a)', () => {
  it('간접비 블록은 네 세목이다 — 연구실 안전관리비 헤더는 라벨로 새 세목에 맞는다', () => {
    expect(blocks.map((block) => block.subcategory)).toEqual([
      'indirect_hr',
      'indirect_support',
      'indirect_outcome',
      'indirect_lab_safety',
    ]);
    const lab = blocks.find((block) => block.subcategory === 'indirect_lab_safety');
    expect(lab).toMatchObject({ resolvedBy: 'label', needsConfirm: false, numberToken: null });
  });

  it('연구지원비 표 안의 "연구실 안전관리비" 품명 행은 indirect_support 데이터다 — 0원 행 포함', () => {
    expect(rowsOf('indirect_support').map((row) => [row.name, row.fileAmount])).toEqual([
      ['기관 공통지원경비', 0],
      ['연구실 안전관리비', 0],
      ['연구실 안전관리비', 2_000_000],
    ]);
  });

  it('새 세목 표의 행은 indirect_lab_safety로 들어온다', () => {
    expect(rowsOf('indirect_lab_safety').map((row) => [row.name, row.subcategory, row.fileAmount])).toEqual([
      ['안전점검 위탁', 'indirect_lab_safety', 700_000],
      ['보호구', 'indirect_lab_safety', 300_000],
    ]);
  });

  it('간접비 합계 = 5,000,000 + 2,000,000 + 1,000,000 + 1,000,000', () => {
    const total = blocks
      .flatMap((block) => parseDetailRows(detailSheet, block).rows)
      .reduce((sum, row) => sum + row.fileAmount, 0);
    expect(total).toBe(9_000_000);
  });
});
