// SheetJS 어댑터 단위 테스트 (SOT §6.8 I-12·I-13·I-15·I-16, lib/import/types.ts 어댑터 경계 계약).
//
// 실제 샘플 파일을 쓰지 않는다 — 메모리상에서 워크북을 만들어 xlsx로 직렬화한 뒤 다시 읽는다.
// samples/는 실제 예산 파일이라 커밋 금지이고(CLAUDE.md), 경계 계약은 파일 없이도 고정할 수 있다.

import { describe, expect, it } from 'vitest';
import * as XLSX from 'xlsx';
import {
  MAX_UPLOAD_BYTES,
  PREVIEW_ROW_LIMIT,
  readUploadedWorkbook,
  readWorkbook,
  toCommitRows,
  toGridPreview,
  toRawCell,
  worksheetToRawSheet,
} from '@/lib/import-adapter';
import { RuleViolationError, ValidationError } from '@/lib/db/errors';
import type { ImportPreview, PreviewRow } from '@/types';

// ─── 헬퍼 ─────────────────────────────────────────────────────────────────────

function writeWorkbook(sheets: { name: string; sheet: XLSX.WorkSheet }[]): Uint8Array {
  const wb = XLSX.utils.book_new();
  for (const { name, sheet } of sheets) XLSX.utils.book_append_sheet(wb, sheet, name);
  return new Uint8Array(XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }) as Buffer);
}

/** 실측 총괄표를 축소한 시트: 병합 헤더 + 빈 셀 + 에러 셀 + 수식 셀 */
function makeSampleSheet(): XLSX.WorkSheet {
  const sheet = XLSX.utils.aoa_to_sheet([
    ['(단위 : 원)', null, null],
    ['비목', '1차년도', '2차년도'],
    ['인건비', 1000, null],
    ['재료비', null, 2000],
    ['소계', null, null],
  ]);
  sheet['C3'] = { t: 'e', v: 0x17, w: '#REF!' }; // I-12 에러 셀
  sheet['B5'] = { t: 'n', v: 3000, f: 'B3+B4' }; // I-16 수식 셀 (계산값 3000)
  sheet['!ref'] = 'A1:C5';
  sheet['!merges'] = [{ s: { r: 0, c: 0 }, e: { r: 0, c: 2 } }];
  return sheet;
}

function previewRow(patch: Partial<PreviewRow>): PreviewRow {
  return {
    status: 'new',
    statusLabel: '신규',
    yearId: null,
    yearOrder: null,
    category: null,
    plannedAmount: null,
    cashAmount: null,
    inKindAmount: null,
    existing: null,
    sourceRowIndexes: [],
    reason: null,
    label: null,
    categorySource: null,
    sourceRows: [],
    rounded: false,
    ...patch,
  };
}

function makePreview(patch: Partial<ImportPreview> & { rows: PreviewRow[] }): ImportPreview {
  return {
    summary: {
      new: 0,
      overwrite: 0,
      skipped: 0,
      skippedAmount: 0,
      error: 0,
      totalAmount: 0,
      untouchedCategories: [],
    },
    blocked: false,
    unmappedYearOrders: [],
    ...patch,
  };
}

const YEAR_A = '11111111-1111-4111-8111-111111111111';

// ─── toRawCell (어댑터 경계 계약) ─────────────────────────────────────────────

describe('toRawCell', () => {
  it('없는 셀·stub 셀은 { value: null, isError: false }로 채운다', () => {
    expect(toRawCell(undefined)).toEqual({ value: null, isError: false });
    expect(toRawCell(null)).toEqual({ value: null, isError: false });
    expect(toRawCell({ t: 'z' } as XLSX.CellObject)).toEqual({ value: null, isError: false });
  });

  it('문자열·숫자·불리언 값을 그대로 옮긴다', () => {
    expect(toRawCell({ t: 's', v: '인건비' } as XLSX.CellObject)).toEqual({
      value: '인건비',
      isError: false,
    });
    expect(toRawCell({ t: 'n', v: 1234.5 } as XLSX.CellObject)).toEqual({
      value: 1234.5,
      isError: false,
    });
    expect(toRawCell({ t: 'b', v: true } as XLSX.CellObject)).toEqual({
      value: true,
      isError: false,
    });
  });

  it('I-12: 에러 셀은 isError + errorText(원문)', () => {
    expect(toRawCell({ t: 'e', v: 0x17, w: '#REF!' } as XLSX.CellObject)).toEqual({
      value: '#REF!',
      isError: true,
      errorText: '#REF!',
    });
  });

  it('w가 없는 에러 셀도 코드가 아니라 에러 문자열로 옮긴다', () => {
    // v를 그대로 쓰면 `#DIV/0!`이 `7`로 보여 미리보기가 무의미해진다
    expect(toRawCell({ t: 'e', v: 0x07 } as XLSX.CellObject).errorText).toBe('#DIV/0!');
    expect(toRawCell({ t: 'e', v: 0x2a } as XLSX.CellObject).errorText).toBe('#N/A');
    expect(toRawCell({ t: 'e', v: 0x0f } as XLSX.CellObject).errorText).toBe('#VALUE!');
    expect(toRawCell({ t: 'e', v: 0x1d } as XLSX.CellObject).errorText).toBe('#NAME?');
  });
});

// ─── readWorkbook (직렬화 왕복) ───────────────────────────────────────────────

function readWorkbookBytes(): Uint8Array {
  return writeWorkbook([{ name: '총괄표', sheet: makeSampleSheet() }]);
}

describe('readWorkbook', () => {
  const sheets = readWorkbook(readWorkbookBytes());
  const sheet = sheets[0]!;

  it('시트 이름과 개수를 유지한다', () => {
    expect(sheets).toHaveLength(1);
    expect(sheet.name).toBe('총괄표');
  });

  it('병합 범위를 0-based·양끝 포함 MergeRange로 돌려준다', () => {
    expect(sheet.merges).toEqual([{ s: { r: 0, c: 0 }, e: { r: 0, c: 2 } }]);
  });

  it('구멍 없는 2차원 배열을 만든다 — 빈 셀도 { value: null, isError: false }', () => {
    expect(sheet.cells).toHaveLength(5);
    for (const row of sheet.cells) {
      expect(row).toHaveLength(3);
      for (const cell of row) expect(cell).toBeDefined();
    }
    // 2행 C열(2차년도 인건비)과 3행 B열(1차년도 재료비)이 원본에서 빈 셀이다
    expect(sheet.cells[3]![1]).toEqual({ value: null, isError: false });
    // 병합 확장은 어댑터가 하지 않는다 (S-11은 lib/import/grid.expandMerges의 몫)
    expect(sheet.cells[0]![1]).toEqual({ value: null, isError: false });
  });

  it('I-12: 에러 셀이 isError + errorText로 살아 온다', () => {
    expect(sheet.cells[2]![2]).toEqual({ value: '#REF!', isError: true, errorText: '#REF!' });
  });

  it('I-16: 수식 셀은 계산된 값으로 읽는다', () => {
    expect(sheet.cells[4]![1]).toEqual({ value: 3000, isError: false });
  });

  it('일반 값 셀을 원본 타입 그대로 옮긴다', () => {
    expect(sheet.cells[1]![0]).toEqual({ value: '비목', isError: false });
    expect(sheet.cells[2]![1]).toEqual({ value: 1000, isError: false });
    expect(sheet.cells[0]![0]).toEqual({ value: '(단위 : 원)', isError: false });
  });

  it('시트가 여러 개면 워크북 순서대로 전부 돌려준다', () => {
    const many = readWorkbook(
      writeWorkbook([
        { name: '표지', sheet: XLSX.utils.aoa_to_sheet([['표지']]) },
        { name: '총괄표', sheet: makeSampleSheet() },
      ])
    );
    expect(many.map((s) => s.name)).toEqual(['표지', '총괄표']);
  });

  it('깨진 워크북은 조용히 빈 결과로 넘기지 않고 거부한다', () => {
    // CSV도 허용 형식이라 아무 바이트나 던지면 SheetJS가 1셀 시트로 읽는다 —
    // 여기서 보는 것은 "xlsx로 판정됐는데 내용이 깨진" 경우다
    const truncated = readWorkbookBytes().slice(0, 200);
    expect(() => readWorkbook(truncated)).toThrow(ValidationError);
  });
});

// ─── worksheetToRawSheet ──────────────────────────────────────────────────────

describe('worksheetToRawSheet', () => {
  it('!ref가 A1이 아니어도 0행/0열부터 채워 시트 절대 좌표를 유지한다', () => {
    const sheet: XLSX.WorkSheet = { '!ref': 'C3:D4' };
    sheet['C3'] = { t: 's', v: '인건비' };
    sheet['D4'] = { t: 'n', v: 500 };

    const raw = worksheetToRawSheet('s', sheet);
    expect(raw.cells).toHaveLength(4);
    expect(raw.cells[0]).toHaveLength(4);
    expect(raw.cells[2]![2]).toEqual({ value: '인건비', isError: false });
    expect(raw.cells[3]![3]).toEqual({ value: 500, isError: false });
    expect(raw.cells[0]![0]).toEqual({ value: null, isError: false });
  });

  it('!ref가 없으면 빈 그리드', () => {
    expect(worksheetToRawSheet('s', {})).toEqual({ name: 's', cells: [], merges: [] });
  });

  it('I-15: 20,000행을 넘으면 잘라 읽지 않고 거부한다', () => {
    // 셀을 만들지 않고 !ref만 키운다 — 어댑터가 그리드 생성 **전에** 판정하는지 본다
    expect(() => worksheetToRawSheet('큰시트', { '!ref': 'A1:B20001' })).toThrow(ValidationError);
    expect(() => worksheetToRawSheet('큰시트', { '!ref': 'A1:B20001' })).toThrow(/20,001행/);
    expect(() => worksheetToRawSheet('작은시트', { '!ref': 'A1:B20000' })).not.toThrow();
  });
});

// ─── readUploadedWorkbook (I-14, I-15) ────────────────────────────────────────

describe('readUploadedWorkbook', () => {
  function formDataOf(bytes: Uint8Array, fileName: string): FormData {
    const form = new FormData();
    form.set('file', new Blob([bytes as BlobPart]), fileName);
    return form;
  }

  const bytes = writeWorkbook([{ name: '총괄표', sheet: makeSampleSheet() }]);

  it('파일명·크기·sha256과 시트를 함께 돌려준다', async () => {
    const result = await readUploadedWorkbook(formDataOf(bytes, '사업비총괄표.xlsx'));
    expect(result.fileName).toBe('사업비총괄표.xlsx');
    expect(result.fileSize).toBe(bytes.byteLength);
    expect(result.fileHash).toMatch(/^[0-9a-f]{64}$/);
    expect(result.sheets.map((s) => s.name)).toEqual(['총괄표']);
  });

  it('같은 바이트는 같은 해시, 다른 바이트는 다른 해시 — commitImport의 파일 대조 근거', async () => {
    const a = await readUploadedWorkbook(formDataOf(bytes, 'a.xlsx'));
    const b = await readUploadedWorkbook(formDataOf(bytes, 'b.xlsx'));
    const other = await readUploadedWorkbook(
      formDataOf(writeWorkbook([{ name: 'x', sheet: XLSX.utils.aoa_to_sheet([['다른내용']]) }]), 'c.xlsx')
    );
    expect(a.fileHash).toBe(b.fileHash);
    expect(a.fileHash).not.toBe(other.fileHash);
  });

  it('지원하지 않는 확장자는 거부한다', async () => {
    await expect(readUploadedWorkbook(formDataOf(bytes, 'budget.pdf'))).rejects.toThrow(
      ValidationError
    );
  });

  it('파일이 없으면 거부한다', async () => {
    await expect(readUploadedWorkbook(new FormData())).rejects.toThrow(ValidationError);
  });

  it('I-15: 10MB를 넘으면 거부한다', async () => {
    const big = new Uint8Array(MAX_UPLOAD_BYTES + 1);
    await expect(readUploadedWorkbook(formDataOf(big, 'big.xlsx'))).rejects.toThrow(/10MB/);
  });

  it('빈 파일은 거부한다', async () => {
    await expect(readUploadedWorkbook(formDataOf(new Uint8Array(0), 'e.xlsx'))).rejects.toThrow(
      ValidationError
    );
  });
});

// ─── toGridPreview (§7.9.1 Step 2) ────────────────────────────────────────────

describe('toGridPreview', () => {
  it('상위 30행까지만 내리고 잘렸음을 알린다', () => {
    const rows = Array.from({ length: 40 }, (_, r) => [`행${r}`, r]);
    const sheets = readWorkbook(
      writeWorkbook([{ name: 'big', sheet: XLSX.utils.aoa_to_sheet(rows) }])
    );
    const grid = toGridPreview(sheets[0]!);
    expect(grid.rows).toHaveLength(PREVIEW_ROW_LIMIT);
    expect(grid.totalRows).toBe(40);
    expect(grid.truncated).toBe(true);
  });

  it('에러 셀을 원문 텍스트와 플래그로 함께 내린다', () => {
    const sheets = readWorkbook(writeWorkbook([{ name: '총괄표', sheet: makeSampleSheet() }]));
    const grid = toGridPreview(sheets[0]!);
    expect(grid.truncated).toBe(false);
    expect(grid.rows[2]![2]).toEqual({ text: '#REF!', isError: true });
    expect(grid.rows[3]![1]).toEqual({ text: '', isError: false });
    expect(grid.merges).toEqual([{ s: { r: 0, c: 0 }, e: { r: 0, c: 2 } }]);
  });
});

// ─── toCommitRows (§7.9.1 Step 5, S-5) ────────────────────────────────────────

describe('toCommitRows', () => {
  it('반영 대상(신규·덮어씀)만 commit 행으로 옮긴다', () => {
    const preview = makePreview({
      rows: [
        previewRow({
          status: 'new',
          yearId: YEAR_A,
          yearOrder: 0,
          category: 'personnel',
          plannedAmount: 1000,
          cashAmount: 600,
          inKindAmount: 400,
        }),
        previewRow({
          status: 'overwrite',
          statusLabel: '덮어씀',
          yearId: YEAR_A,
          yearOrder: 0,
          category: 'material',
          plannedAmount: 2000,
        }),
        previewRow({ status: 'skipped', statusLabel: '건너뜀', reason: '집계 행' }),
      ],
    });

    expect(toCommitRows(preview)).toEqual([
      {
        yearId: YEAR_A,
        category: 'personnel',
        plannedAmount: 1000,
        cashAmount: 600,
        inKindAmount: 400,
      },
      { yearId: YEAR_A, category: 'material', plannedAmount: 2000, cashAmount: null, inKindAmount: null },
    ]);
  });

  it('§7.9.1 Step 5: 오류 행이 1건이라도 있으면 반영을 거부한다', () => {
    const preview = makePreview({
      rows: [
        previewRow({
          status: 'new',
          yearId: YEAR_A,
          yearOrder: 0,
          category: 'personnel',
          plannedAmount: 1000,
        }),
        previewRow({ status: 'error', statusLabel: '오류', reason: 'C3열: 수식 에러 셀입니다' }),
      ],
      summary: {
        new: 1,
        overwrite: 0,
        skipped: 0,
        skippedAmount: 0,
        error: 1,
        totalAmount: 1000,
        untouchedCategories: [],
      },
      blocked: true,
    });

    expect(() => toCommitRows(preview)).toThrow(RuleViolationError);
    expect(() => toCommitRows(preview)).toThrow(/오류 1건/);
  });

  it('S-5: 미대응 연차 열이 남아 있으면 반영을 거부한다', () => {
    const preview = makePreview({
      rows: [
        previewRow({
          status: 'new',
          yearId: YEAR_A,
          yearOrder: 0,
          category: 'personnel',
          plannedAmount: 1000,
        }),
      ],
      blocked: true,
      unmappedYearOrders: [1],
    });

    expect(() => toCommitRows(preview)).toThrow(RuleViolationError);
    expect(() => toCommitRows(preview)).toThrow(/2차년도/);
  });

  it('blocked가 아닌데 반영 대상 행이 비어 있으면 조용히 건너뛰지 않고 던진다', () => {
    const preview = makePreview({
      rows: [previewRow({ status: 'new', yearId: null, category: 'personnel', plannedAmount: 100 })],
    });
    expect(() => toCommitRows(preview)).toThrow(RuleViolationError);
  });
});
