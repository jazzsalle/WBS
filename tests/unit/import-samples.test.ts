// 실측 서식 2종 파싱 검증 (SOT 부록 B.6) — Phase 5.5의 핵심 합격 기준
// "실제 보유 샘플 2종(samples/)의 총괄표 시트가 미매핑 0건으로 미리보기까지 도달"의
// 파싱 계층 부분을 여기서 고정한다. DB를 쓰지 않으므로 단위 테스트다.
//
// samples/는 .gitignore 대상(실제 예산 자료)이라 저장소에 없다. 파일이 없으면
// **조용히 통과시키지 않고** 무엇이 없어 건너뛰는지 알린 뒤 skip 한다 (부록 B.6, 절대 규칙 5).
//
// 어댑터(SheetJS → RawSheet)는 여기서 최소 구현으로 다시 만든다. actions/의 어댑터에
// 의존하면 이 테스트가 서버 액션 계층의 변경에 끌려다니고, 검증하려는 대상(lib/import/의
// 파싱 규칙)이 흐려진다.

import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import * as XLSX from 'xlsx';
import { detectStructure, parseMatrix, recommendSheet } from '@/lib/import';
import type { MergeRange, RawCell, RawSheet } from '@/lib/import';
import type { BudgetCategory } from '@/types';

const SAMPLES_DIR = path.resolve(__dirname, '../../samples');
/** 자기 기관 총괄표 = 임포트 표준 대상 시트 (§6.8.2) */
const TARGET_SHEET = '유엔이_총괄표';

function toRawSheets(file: string): RawSheet[] {
  const wb = XLSX.read(fs.readFileSync(file), { cellFormula: false, cellDates: false });
  return wb.SheetNames.map((name) => {
    const ws = wb.Sheets[name];
    if (!ws || !ws['!ref']) return { name, cells: [], merges: [] };
    const range = XLSX.utils.decode_range(ws['!ref']);
    const cells: RawCell[][] = [];
    for (let r = 0; r <= range.e.r; r++) {
      const row: RawCell[] = [];
      for (let c = 0; c <= range.e.c; c++) {
        const cell = ws[XLSX.utils.encode_cell({ r, c })];
        // 구멍 없는 2차원 배열이어야 한다 — 빈 셀도 채운다 (RawSheet 계약)
        if (!cell) row.push({ value: null, isError: false });
        else if (cell.t === 'e') {
          row.push({ value: null, isError: true, errorText: String(cell.w ?? cell.v) });
        } else row.push({ value: cell.v as string | number | boolean | null, isError: false });
      }
      cells.push(row);
    }
    const merges: MergeRange[] = (ws['!merges'] ?? []).map((m) => ({
      s: { r: m.s.r, c: m.s.c },
      e: { r: m.e.r, c: m.e.c },
    }));
    return { name, cells, merges };
  });
}

interface Expectation {
  /** 파일명 접두사 */
  prefix: string;
  headerRow: number;
  dataStartRow: number;
  dataEndRow: number;
  /** I-10 단위 힌트가 시트에 있는가 */
  hasUnitHint: boolean;
  /** 1차년도(order 0) 비목별 planned. 표에 없는 비목은 그 서식에 행이 없다는 뜻 (S-9) */
  planned: Partial<Record<BudgetCategory, number>>;
  /** 원본 `직접비 소계` 행 */
  directSubtotal: number;
  /** 원본 `연구개발비 총액` 행 */
  grandTotal: number;
}

// 부록 B.6 표를 그대로 옮긴다. 수치가 안 맞으면 구현이 틀린 것이다.
const EXPECTATIONS: Expectation[] = [
  {
    prefix: '산자부',
    headerRow: 1,
    dataStartRow: 3,
    dataEndRow: 29,
    hasUnitHint: false,
    planned: {
      personnel: 269_490_000,
      student_personnel: 0,
      facility_equipment: 0,
      material: 0,
      activity: 27_020_000,
      allowance: 0,
      consignment: 0,
      indirect: 2_000_000,
    },
    directSubtotal: 296_510_000,
    grandTotal: 298_510_000,
  },
  {
    prefix: '행안부',
    headerRow: 8,
    dataStartRow: 10,
    dataEndRow: 30,
    hasUnitHint: true,
    planned: {
      personnel: 104_240_000,
      student_personnel: 0,
      facility_equipment: 0,
      material: 0,
      activity: 29_100_000,
      allowance: 0,
      indirect: 0,
    },
    directSubtotal: 133_340_000,
    grandTotal: 133_340_000,
  },
];

const available = fs.existsSync(SAMPLES_DIR)
  ? fs.readdirSync(SAMPLES_DIR).filter((f) => f.endsWith('.xlsx'))
  : [];

// 안내는 **항상 실행되는 테스트 안에서** 낸다. 모듈 최상단이나 skip된 describe 안에서
// console.warn을 부르면 vitest가 그 출력을 삼켜, 검증이 통째로 생략된 사실이 화면에 남지 않는다.
describe('실측 샘플 준비 상태', () => {
  it(`samples/ 확인 — ${available.length}종 발견`, () => {
    if (available.length > 0) {
      expect(available.length).toBeGreaterThan(0);
      return;
    }
    // console.warn을 쓰지 않는다 — vitest 기본 리포터는 **통과한** 테스트의 console 출력을
    // 감춰서(--reporter=verbose에서만 보인다) 안내가 화면에 남지 않는다.
    // process.stderr에 직접 쓰면 리포터를 거치지 않고 그대로 출력된다.
    process.stderr.write(
      `\n[import-samples] samples/에 .xlsx가 없어 실측 검증(부록 B.6) ${EXPECTATIONS.length * 4}건을 건너뜁니다.\n` +
        `  samples/는 실제 예산 자료라 .gitignore 대상입니다 — 회사 PC에서 복사해 오면 이 테스트가 살아납니다.\n` +
        `  기대 경로: ${SAMPLES_DIR}\n\n`
    );
    // 실패시키지 않는다: 샘플이 없는 것은 다른 PC에서 정상 상태다.
    // 다만 무엇이 생략됐는지는 위 경고로 반드시 화면에 남는다 (절대 규칙 5).
    expect(available).toEqual([]);
  });
});

describe.skipIf(available.length === 0)('실측 서식 파싱 (부록 B.6)', () => {
  for (const exp of EXPECTATIONS) {
    const file = available.find((f) => f.startsWith(exp.prefix));

    describe.skipIf(file === undefined)(exp.prefix, () => {
      const sheets = (): RawSheet[] => toRawSheets(path.join(SAMPLES_DIR, file!));

      // S-13: 행 수로 매기면 연차별 산출근거 시트(240~250행)가 총괄표를 이긴다
      it(`시트 추천이 ${TARGET_SHEET}를 1위로 올린다`, () => {
        const rec = recommendSheet(sheets());
        expect(rec.recommended).toBe(TARGET_SHEET);
      });

      it('구조 감지가 힌트 없이 부록 B.6 값을 낸다', () => {
        const sheet = sheets().find((s) => s.name === TARGET_SHEET)!;
        const st = detectStructure(sheet);

        expect(st.headerRow).toBe(exp.headerRow);
        expect(st.dataStartRow).toBe(exp.dataStartRow);
        expect(st.dataEndRow).toBe(exp.dataEndRow);
        expect(st.labelColumns).toEqual(['B', 'C', 'D', 'E']);
        expect(st.yearColumns.map((y) => `${y.column}:${y.yearOrder}`)).toEqual([
          'F:0',
          'G:1',
          'H:2',
          'I:3',
        ]);
        // 두 서식 모두 원 단위다. 힌트 유무만 다르다 (I-10은 자동 확정하지 않는다)
        expect(st.amountUnit).toBe(1);
        expect(st.amountUnitHint !== null).toBe(exp.hasUnitHint);
        expect(st.orientation).toBe('row'); // S-1: 실측 서식은 전부 row
      });

      it('미매핑 0건 — 사용자 결정이 필요한 행이 없다', () => {
        const sheet = sheets().find((s) => s.name === TARGET_SHEET)!;
        const st = detectStructure(sheet);
        const res = parseMatrix(sheet, {
          labelColumns: st.labelColumns,
          yearColumns: st.yearColumns.map((y) => ({ column: y.column, yearOrder: y.yearOrder })),
          dataStartRow: st.dataStartRow,
          dataEndRow: st.dataEndRow,
          amountUnit: st.amountUnit,
        });

        // 실패 시 어느 행이 왜 걸렸는지 바로 보이게 문자열로 비교한다
        const unresolved = res.rows
          .filter((r) => r.status !== 'mapped' && r.status !== 'skipped')
          .map((r) => `${r.rowIndex + 1}행 ${r.status}: ${r.labels.filter(Boolean).join(' | ')}`);
        expect(unresolved).toEqual([]);
        expect(res.unresolvedRowIndexes).toEqual([]);
        expect(res.errorRowIndexes).toEqual([]);
      });

      it('1차년도 비목별 금액 + 소계·총액 교차검증', () => {
        const sheet = sheets().find((s) => s.name === TARGET_SHEET)!;
        const st = detectStructure(sheet);
        const res = parseMatrix(sheet, {
          labelColumns: st.labelColumns,
          yearColumns: st.yearColumns.map((y) => ({ column: y.column, yearOrder: y.yearOrder })),
          dataStartRow: st.dataStartRow,
          dataEndRow: st.dataEndRow,
          amountUnit: st.amountUnit,
        });

        // S-8: 같은 (연차, 비목)에 매핑된 행이 여러 개면 합산한다
        const planned: Partial<Record<BudgetCategory, number>> = {};
        for (const row of res.rows) {
          if (row.status !== 'mapped' || row.category === null) continue;
          const cell = row.amounts.find((a) => a.yearOrder === 0);
          if (!cell || cell.amount === null) continue;
          planned[row.category] = (planned[row.category] ?? 0) + cell.amount;
        }
        expect(planned).toEqual(exp.planned);

        // 파싱 결과가 원본 집계 행과 원 단위까지 맞는지 — 가장 강한 정합성 근거.
        // 소계·총액 행 자체는 스킵 행이라 반영 대상이 아니다.
        const direct = Object.entries(planned)
          .filter(([category]) => category !== 'indirect')
          .reduce((sum, [, amount]) => sum + (amount ?? 0), 0);
        expect(direct).toBe(exp.directSubtotal);
        expect(direct + (planned.indirect ?? 0)).toBe(exp.grandTotal);
      });
    });
  }
});
