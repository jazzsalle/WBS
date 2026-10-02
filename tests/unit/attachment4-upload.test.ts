// 붙임4 업로드 어댑터 단위 테스트 (SOT §5.21 AV-7, §6.8 I-14·I-15, Phase 25 S-15·S-16).
//
// 실제 붙임4 파일을 쓰지 않는다 — 메모리에서 워크북·CFB 컨테이너를 만들어 넣는다(samples/ 커밋 금지).

import { describe, expect, it } from 'vitest';
import * as XLSX from 'xlsx';
import {
  ATTACHMENT4_EXTENSIONS,
  EMPTY_FILE_MESSAGE,
  ENCRYPTED_WORKBOOK_MESSAGE,
  MAX_UPLOAD_BYTES,
  UNREADABLE_WORKBOOK_MESSAGE,
  readAttachment4Upload,
  readUploadedWorkbook,
} from '@/lib/import-adapter';
import { ValidationError } from '@/lib/db/errors';

function formDataOf(bytes: Uint8Array, fileName: string): FormData {
  const form = new FormData();
  form.set('file', new Blob([bytes as BlobPart]), fileName);
  return form;
}

function workbookBytes(bookType: XLSX.BookType = 'xlsx'): Uint8Array {
  const sheet = XLSX.utils.aoa_to_sheet([
    ['8-2. 연구개발비 사용계획', null],
    ['기관', '1차년도'],
    ['(주)우리회사', 1000],
  ]);
  sheet['!merges'] = [{ s: { r: 0, c: 0 }, e: { r: 0, c: 1 } }];
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, sheet, '8-2. 연구개발비 사용계획');
  return new Uint8Array(XLSX.write(wb, { type: 'buffer', bookType }) as Buffer);
}

/** ECMA-376 암호 파일 모양 — 암호를 건 xlsx는 ZIP이 아니라 EncryptionInfo·EncryptedPackage를 담은 CFB다 */
function encryptedContainerBytes(): Uint8Array {
  const cfb = XLSX.CFB.utils.cfb_new();
  // Agile 암호화 버전(4.4) 머리 + 빈 XML — SheetJS가 복호화 단계까지 가서 암호 오류를 낸다
  const info = new Uint8Array([0x04, 0x00, 0x04, 0x00, 0x40, 0x00, 0x00, 0x00]);
  XLSX.CFB.utils.cfb_add(cfb, '/EncryptionInfo', info);
  XLSX.CFB.utils.cfb_add(cfb, '/EncryptedPackage', new Uint8Array(64).fill(7));
  const out = XLSX.CFB.write(cfb, { type: 'buffer' }) as unknown as ArrayLike<number>;
  return new Uint8Array(out);
}

describe('readAttachment4Upload', () => {
  const bytes = workbookBytes();

  it('파일명·크기·sha256과 RawSheet(병합 포함)를 돌려준다', async () => {
    const result = await readAttachment4Upload(formDataOf(bytes, '붙임4_사업비검토양식.xlsx'));
    expect(result.fileName).toBe('붙임4_사업비검토양식.xlsx');
    expect(result.fileSize).toBe(bytes.byteLength);
    expect(result.fileHash).toMatch(/^[0-9a-f]{64}$/);
    expect(result.sheets.map((s) => s.name)).toEqual(['8-2. 연구개발비 사용계획']);
    expect(result.sheets[0]!.merges).toEqual([{ s: { r: 0, c: 0 }, e: { r: 0, c: 1 } }]);
    expect(result.sheets[0]!.cells[2]![1]).toEqual({ value: 1000, isError: false });
  });

  it('해시는 기존 임포트 업로드와 같은 방식이다 — 같은 바이트면 같은 값', async () => {
    const a = await readAttachment4Upload(formDataOf(bytes, 'a.xlsx'));
    const b = await readUploadedWorkbook(formDataOf(bytes, 'b.xlsx'));
    expect(a.fileHash).toBe(b.fileHash);
  });

  it('.xlsm·.xls도 받는다 (대소문자 무관)', async () => {
    const xlsm = await readAttachment4Upload(formDataOf(bytes, '붙임4.XLSM'));
    expect(xlsm.sheets).toHaveLength(1);
    const xls = await readAttachment4Upload(formDataOf(workbookBytes('biff8'), '붙임4.xls'));
    expect(xls.sheets[0]!.cells[2]![1]).toEqual({ value: 1000, isError: false });
  });

  it('허용 확장자는 .xlsx·.xlsm·.xls 세 가지다 — CSV는 받지 않는다', async () => {
    expect([...ATTACHMENT4_EXTENSIONS]).toEqual(['.xlsx', '.xlsm', '.xls']);
    await expect(readAttachment4Upload(formDataOf(bytes, '붙임4.csv'))).rejects.toThrow(
      '지원하지 않는 파일 형식입니다. .xlsx, .xlsm, .xls 파일만 올릴 수 있습니다.'
    );
    await expect(readAttachment4Upload(formDataOf(bytes, '붙임4.hwpx'))).rejects.toThrow(ValidationError);
  });

  it('파일이 없으면 거부한다', async () => {
    await expect(readAttachment4Upload(new FormData())).rejects.toThrow('업로드된 파일이 없습니다.');
  });

  it('I-15: 10MB를 넘으면 거부하고, 정확히 10MB는 크기로 거부하지 않는다', async () => {
    const big = new Uint8Array(MAX_UPLOAD_BYTES + 1);
    await expect(readAttachment4Upload(formDataOf(big, 'big.xlsx'))).rejects.toThrow(/10MB/);
    // 10MB 정각은 크기 검사를 통과해 내용 검사(깨진 파일)에서 걸린다
    const exact = new Uint8Array(MAX_UPLOAD_BYTES);
    await expect(readAttachment4Upload(formDataOf(exact, 'exact.xlsx'))).rejects.toThrow(
      UNREADABLE_WORKBOOK_MESSAGE
    );
  });

  it('빈 파일은 전용 문구로 거부한다', async () => {
    await expect(readAttachment4Upload(formDataOf(new Uint8Array(0), 'e.xlsx'))).rejects.toThrow(
      EMPTY_FILE_MESSAGE
    );
  });

  it('깨진 파일은 손상 문구로 거부한다 — xlsx 이름의 텍스트를 CSV처럼 읽어 넘기지 않는다', async () => {
    const text = new TextEncoder().encode('이건 엑셀이 아닙니다,1,2\n');
    await expect(readAttachment4Upload(formDataOf(text, '붙임4.xlsx'))).rejects.toThrow(
      UNREADABLE_WORKBOOK_MESSAGE
    );
    // ZIP 머리는 맞는데 중간에서 잘린 파일
    await expect(readAttachment4Upload(formDataOf(bytes.slice(0, 200), '붙임4.xlsx'))).rejects.toThrow(
      UNREADABLE_WORKBOOK_MESSAGE
    );
  });

  it('암호 파일은 손상과 구분되는 전용 문구로 거부한다', async () => {
    const encrypted = encryptedContainerBytes();
    await expect(readAttachment4Upload(formDataOf(encrypted, '붙임4.xlsx'))).rejects.toThrow(
      ENCRYPTED_WORKBOOK_MESSAGE
    );
    await expect(readAttachment4Upload(formDataOf(encrypted, '붙임4.xls'))).rejects.toThrow(
      ENCRYPTED_WORKBOOK_MESSAGE
    );
  });
});
