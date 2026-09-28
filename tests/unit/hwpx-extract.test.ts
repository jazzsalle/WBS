// hwpx zip 판정·섹션 해제·표 격자 추출 (SOT §6.18 HX-1·HX-2, S-15·S-16·S-24·S-25·S-26, U-9).
// 합성 픽스처(tests/fixtures/hwpx) — samples/ 실측은 T8에서 따로 본다.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { strToU8, zipSync, type Zippable } from 'fflate';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// unzipSync의 filter가 어떤 엔트리에 true를 돌려줬는지 기록한다 — BinData를 inflate하지 않는지(S-24) 보려고
const filterLog = vi.hoisted(() => ({ calls: [] as { name: string; kept: boolean }[] }));
vi.mock('fflate', async (importOriginal) => {
  const orig = await importOriginal<typeof import('fflate')>();
  return {
    ...orig,
    unzipSync: (data: Uint8Array, opts?: Parameters<typeof orig.unzipSync>[1]) =>
      orig.unzipSync(data, {
        ...opts,
        filter: (file) => {
          const kept = opts?.filter ? opts.filter(file) : true;
          filterLog.calls.push({ name: file.name, kept });
          return kept;
        },
      }),
  };
});

import { extractHwpxTables, sliceOuterTables } from '@/lib/hwpx/extract';
import type { HwpxExtractResult, HwpxTable } from '@/lib/hwpx/types';
import { HWPX_NOT_HWPX_MESSAGE, HWPX_SAVE_AS_MESSAGE, readHwpxSections } from '@/lib/hwpx/zip';

const FIXTURES = join(process.cwd(), 'tests/fixtures/hwpx');
const fixture = (name: string) => readFileSync(join(FIXTURES, `section-${name}.xml`), 'utf8');
const one = (xml: string) => extractHwpxTables([{ section: 0, xml }]);

function first(r: HwpxExtractResult): HwpxTable {
  const g = r.tables[0];
  if (!g) throw new Error('표가 없다');
  return g;
}
const row = (g: HwpxTable, r: number): string[] => g.cells[r] ?? [];
/** 격자 밖이면 undefined — 단언이 실패로 드러난다 */
const at = (g: HwpxTable, r: number, c: number): string | undefined => g.cells[r]?.[c];

// ---------------------------------------------------------------------------
// 합성 XML 조립 — 실측 요소 순서(tc > subList, cellAddr, cellSpan, cellSz, cellMargin)를 따른다
// ---------------------------------------------------------------------------

const SEC_OPEN =
  '<?xml version="1.0" encoding="UTF-8" standalone="yes" ?><hs:sec xmlns:hp="http://www.hancom.co.kr/hwpml/2011/paragraph" xmlns:hs="http://www.hancom.co.kr/hwpml/2011/section">';
const SEC_CLOSE = '</hs:sec>';

/** 문단 하나. run 안 내용(hp:t·hp:equation 등)을 그대로 받는다 */
const p = (...runs: string[]) =>
  `<hp:p paraPrIDRef="0">${runs.map((r) => `<hp:run charPrIDRef="0">${r}</hp:run>`).join('')}<hp:linesegarray/></hp:p>`;
const t = (inner: string) => `<hp:t>${inner}</hp:t>`;

interface CellSpec {
  r: number;
  c: number;
  rs?: number;
  cs?: number;
  paras: string[];
}
const tc = ({ r, c, rs = 1, cs = 1, paras }: CellSpec) =>
  `<hp:tc header="0"><hp:subList vertAlign="CENTER">${paras.join('')}</hp:subList>` +
  `<hp:cellAddr colAddr="${c}" rowAddr="${r}"/><hp:cellSpan colSpan="${cs}" rowSpan="${rs}"/>` +
  `<hp:cellSz width="100" height="100"/><hp:cellMargin left="0" right="0" top="0" bottom="0"/></hp:tc>`;

/** rows = 행별 셀 목록. 병합으로 가려진 칸은 실측처럼 hp:tc가 없다 */
const tbl = (rowCnt: number, colCnt: number, rows: CellSpec[][]) =>
  `<hp:tbl id="1" rowCnt="${rowCnt}" colCnt="${colCnt}" repeatHeader="1"><hp:sz width="1"/><hp:pos treatAsChar="0"/>` +
  `<hp:outMargin left="0"/><hp:inMargin left="0"/>${rows.map((cells) => `<hp:tr>${cells.map(tc).join('')}</hp:tr>`).join('')}</hp:tbl>`;
/** 실측 배치: hp:p > hp:run > hp:tbl, 뒤에 빈 hp:t */
const tblPara = (table: string) => p(`${table}<hp:t/>`);
const sec = (...body: string[]) => `${SEC_OPEN}${body.join('')}${SEC_CLOSE}`;

const cell = (r: number, c: number, text: string, extra: Partial<CellSpec> = {}): CellSpec => ({
  r,
  c,
  paras: [p(t(text))],
  ...extra,
});

// ---------------------------------------------------------------------------
// zip 판정 (HX-1, S-25)
// ---------------------------------------------------------------------------

function makeHwpx(entries: { mimetype?: string; sections?: Record<number, string>; extra?: Zippable } = {}) {
  const z: Zippable = {};
  // 실측처럼 mimetype이 첫 엔트리·무압축
  if (entries.mimetype !== undefined) z.mimetype = [strToU8(entries.mimetype), { level: 0 }];
  for (const [n, xml] of Object.entries(entries.sections ?? {})) z[`Contents/section${n}.xml`] = strToU8(xml);
  z['Contents/header.xml'] = strToU8('<hh:head/>');
  z['BinData/x.png'] = new Uint8Array(4096).fill(7);
  Object.assign(z, entries.extra ?? {});
  return zipSync(z);
}

const MIME = 'application/hwp+zip';
const EMPTY_SEC = sec(p(t('본문')));

describe('readHwpxSections — 판정(S-25)', () => {
  beforeEach(() => {
    filterLog.calls = [];
  });

  it('mimetype과 Contents/section*.xml만 해제한다 — BinData·header는 inflate하지 않는다', () => {
    const bytes = makeHwpx({ mimetype: MIME, sections: { 0: EMPTY_SEC } });
    const r = readHwpxSections(bytes, '계획서.hwpx');
    expect(r).toEqual({ ok: true, sections: [{ section: 0, xml: EMPTY_SEC }] });
    const kept = filterLog.calls.filter((c) => c.kept).map((c) => c.name).sort();
    expect(kept).toEqual(['Contents/section0.xml', 'mimetype']);
    expect(filterLog.calls.map((c) => c.name)).toContain('BinData/x.png');
    expect(filterLog.calls.find((c) => c.name === 'BinData/x.png')?.kept).toBe(false);
    expect(filterLog.calls.find((c) => c.name === 'Contents/header.xml')?.kept).toBe(false);
  });

  it('fileName을 주지 않아도 바이트로 판정한다', () => {
    const r = readHwpxSections(makeHwpx({ mimetype: MIME, sections: { 0: EMPTY_SEC } }));
    expect(r.ok).toBe(true);
  });

  it('확장자는 대소문자를 가리지 않는다', () => {
    expect(readHwpxSections(makeHwpx({ mimetype: MIME, sections: { 0: EMPTY_SEC } }), 'A.HWPX').ok).toBe(true);
  });

  it('.hwp(OLE 복합 문서)는 "hwpx로 저장해 다시 올려 주세요"', () => {
    const ole = new Uint8Array([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, 0, 0, 0, 0]);
    expect(readHwpxSections(ole, '계획서.hwp')).toEqual({ ok: false, message: HWPX_SAVE_AS_MESSAGE });
    // 이름만 .hwpx로 바꾼 hwp도 같은 안내
    expect(readHwpxSections(ole, '계획서.hwpx')).toEqual({ ok: false, message: HWPX_SAVE_AS_MESSAGE });
  });

  it('PDF는 "hwpx로 저장해 다시 올려 주세요"', () => {
    const pdf = strToU8('%PDF-1.7\n...');
    expect(readHwpxSections(pdf, '계획서.pdf')).toEqual({ ok: false, message: HWPX_SAVE_AS_MESSAGE });
    expect(readHwpxSections(pdf, '계획서.hwpx')).toEqual({ ok: false, message: HWPX_SAVE_AS_MESSAGE });
  });

  it('다른 확장자는 내용이 hwpx여도 받지 않는다', () => {
    const bytes = makeHwpx({ mimetype: MIME, sections: { 0: EMPTY_SEC } });
    expect(readHwpxSections(bytes, '계획서.zip')).toEqual({ ok: false, message: HWPX_SAVE_AS_MESSAGE });
    expect(readHwpxSections(bytes, '계획서.xlsx')).toEqual({ ok: false, message: HWPX_SAVE_AS_MESSAGE });
    expect(HWPX_SAVE_AS_MESSAGE).toBe('hwpx로 저장해 다시 올려 주세요');
  });

  it('mimetype이 다르거나 없으면 "hwpx 형식이 아닙니다"', () => {
    const wrong = makeHwpx({ mimetype: 'application/epub+zip', sections: { 0: EMPTY_SEC } });
    expect(readHwpxSections(wrong, 'a.hwpx')).toEqual({ ok: false, message: HWPX_NOT_HWPX_MESSAGE });
    const missing = makeHwpx({ sections: { 0: EMPTY_SEC } });
    expect(readHwpxSections(missing, 'a.hwpx')).toEqual({ ok: false, message: HWPX_NOT_HWPX_MESSAGE });
    expect(HWPX_NOT_HWPX_MESSAGE).toBe('hwpx 형식이 아닙니다');
  });

  it('section이 없으면 "hwpx 형식이 아닙니다"', () => {
    const bytes = makeHwpx({ mimetype: MIME });
    expect(readHwpxSections(bytes, 'a.hwpx')).toEqual({ ok: false, message: HWPX_NOT_HWPX_MESSAGE });
  });

  it('PK가 아닌 바이트·깨진 zip은 "hwpx 형식이 아닙니다"', () => {
    expect(readHwpxSections(strToU8('hello'), 'a.hwpx')).toEqual({ ok: false, message: HWPX_NOT_HWPX_MESSAGE });
    const broken = makeHwpx({ mimetype: MIME, sections: { 0: EMPTY_SEC } }).slice(0, 40);
    expect(readHwpxSections(broken, 'a.hwpx')).toEqual({ ok: false, message: HWPX_NOT_HWPX_MESSAGE });
  });

  it('section은 숫자 순으로 정렬한다(S-26 — section10이 section2 뒤)', () => {
    const bytes = makeHwpx({ mimetype: MIME, sections: { 10: 'X10', 2: 'X2', 0: 'X0' } });
    const r = readHwpxSections(bytes, 'a.hwpx');
    expect(r.ok && r.sections.map((s) => [s.section, s.xml])).toEqual([
      [0, 'X0'],
      [2, 'X2'],
      [10, 'X10'],
    ]);
  });

  it('Contents 밖이나 이름이 다른 section 파일은 섹션이 아니다', () => {
    const bytes = makeHwpx({
      mimetype: MIME,
      sections: { 1: 'X1' },
      extra: { 'section0.xml': strToU8('ROOT'), 'Contents/section.xml': strToU8('NONUM') },
    });
    const r = readHwpxSections(bytes, 'a.hwpx');
    expect(r.ok && r.sections).toEqual([{ section: 1, xml: 'X1' }]);
  });
});

// ---------------------------------------------------------------------------
// 격자 (HX-2)
// ---------------------------------------------------------------------------

describe('extractHwpxTables — 병합 확장', () => {
  it('가로 병합: 좌상단 텍스트를 범위 전체에 복사', () => {
    const xml = sec(tblPara(tbl(2, 3, [[cell(0, 0, 'A', { cs: 3 })], [cell(1, 0, 'x'), cell(1, 1, 'y'), cell(1, 2, 'z')]])));
    expect(first(one(xml)).cells).toEqual([
      ['A', 'A', 'A'],
      ['x', 'y', 'z'],
    ]);
  });

  it('세로 병합', () => {
    const xml = sec(tblPara(tbl(3, 2, [[cell(0, 0, 'G', { rs: 3 }), cell(0, 1, '1')], [cell(1, 1, '2')], [cell(2, 1, '3')]])));
    expect(first(one(xml)).cells).toEqual([
      ['G', '1'],
      ['G', '2'],
      ['G', '3'],
    ]);
  });

  it('2×2 병합', () => {
    const xml = sec(
      tblPara(
        tbl(3, 3, [
          [cell(0, 0, 'H', { rs: 2, cs: 2 }), cell(0, 2, 'a')],
          [cell(1, 2, 'b')],
          [cell(2, 0, 'c'), cell(2, 1, 'd'), cell(2, 2, 'e')],
        ]),
      ),
    );
    const r = one(xml);
    expect(first(r)).toEqual({
      index: 0,
      section: 0,
      rowCnt: 3,
      colCnt: 3,
      cells: [
        ['H', 'H', 'a'],
        ['H', 'H', 'b'],
        ['c', 'd', 'e'],
      ],
    });
    expect(r.skipped).toEqual([]);
  });

  it('cellSpan이 없는 칸은 1×1', () => {
    const noSpan =
      '<hp:tbl rowCnt="1" colCnt="1"><hp:tr><hp:tc><hp:subList>' +
      p(t('v')) +
      '</hp:subList><hp:cellAddr colAddr="0" rowAddr="0"/></hp:tc></hp:tr></hp:tbl>';
    expect(first(one(sec(tblPara(noSpan)))).cells).toEqual([['v']]);
  });
});

describe('extractHwpxTables — 구조 불일치는 건너뛰고 알린다', () => {
  it('rowCnt ≠ hp:tr 수 → skipped, tables에서 빠진다(자르지 않는다)', () => {
    const bad = tbl(3, 1, [[cell(0, 0, 'a')], [cell(1, 0, 'b')]]);
    const good = tbl(1, 1, [[cell(0, 0, 'ok')]]);
    const r = one(sec(tblPara(bad), tblPara(good)));
    expect(r.skipped).toEqual([{ index: 0, section: 0, reason: 'structure-mismatch' }]);
    expect(r.tables.map((x) => [x.index, x.cells])).toEqual([[1, [['ok']]]]);
  });

  it('셀이 격자 범위를 넘으면 structure-mismatch', () => {
    const r = one(sec(tblPara(tbl(1, 2, [[cell(0, 0, 'a', { cs: 3 })]]))));
    expect(r.tables).toEqual([]);
    expect(r.skipped).toHaveLength(1);
  });

  it('셀이 겹치면 structure-mismatch', () => {
    const r = one(sec(tblPara(tbl(2, 2, [[cell(0, 0, 'a', { rs: 2 }), cell(0, 1, 'b')], [cell(1, 0, 'c'), cell(1, 1, 'd')]]))));
    expect(r.tables).toEqual([]);
    expect(r.skipped).toEqual([{ index: 0, section: 0, reason: 'structure-mismatch' }]);
  });
});

describe('extractHwpxTables — 셀 텍스트(S-16, U-9)', () => {
  const single = (paras: string[]) => at(first(one(sec(tblPara(tbl(1, 1, [[{ r: 0, c: 0, paras }]]))))), 0, 0);

  it('문단은 \\n으로 잇고, 문단 안 hp:t 조각·run은 이어 붙인다', () => {
    expect(single([p(t('가'), t('나')), p(t('다') + t('라'))])).toBe('가나\n다라');
  });

  it('lineBreak → \\n, tab·fwSpace → 공백, hypen → -', () => {
    expect(single([p(t('a<hp:lineBreak/>b<hp:tab width="4000" leader="0" type="1"/>c<hp:fwSpace/>d<hp:hypen/>e'))])).toBe(
      'a\nb c d-e',
    );
  });

  it('공백·앞뒤 공백·엔티티를 그대로 둔다(trim은 행 해석이 필드별로)', () => {
    expect(single([p(t(' 학술 &amp; &lt;x&gt; '))])).toBe(' 학술 & <x> ');
    // 숫자 원문도 해석하지 않는다
    expect(single([p(t('007')), p(t('1,000'))])).toBe('007\n1,000');
  });

  it('빈 문단만 있는 셀은 ""', () => {
    expect(single([p(), '<hp:p><hp:run charPrIDRef="1"/></hp:p>', p(t(''))])).toBe('');
  });

  it('값 있는 문단 사이 빈 문단은 개행으로 남는다', () => {
    expect(single([p(), p(t('x')), p()])).toBe('\nx\n');
  });

  it('수식·그림·그룹 도형·각주는 셀 텍스트에 넣지 않는다', () => {
    const eq =
      '<hp:equation id="9" version="Equation Version 60"><hp:sz width="1"/><hp:pos treatAsChar="1"/><hp:outMargin left="0"/>' +
      '<hp:shapeComment>수식입니다.</hp:shapeComment><hp:script>EQSCRIPT over 2</hp:script></hp:equation>';
    const pic = '<hp:pic id="8"><hp:shapeComment>그림입니다.</hp:shapeComment><hp:imgRect/></hp:pic>';
    const container =
      '<hp:container id="7"><hp:shapeComment>묶음 개체입니다.</hp:shapeComment>' + pic + '</hp:container>';
    const foot =
      '<hp:ctrl><hp:footNote number="1"><hp:subList>' + p(t('FOOTNOTE 본문')) + '</hp:subList></hp:footNote></hp:ctrl>';
    const text = single([p(t('앞 '), eq + '<hp:t/>', t(' 뒤')), p(pic + '<hp:t/>'), p(container + '<hp:t/>'), p(t('머리'), foot, t('말'))]);
    expect(text).toBe('앞  뒤\n\n\n머리말');
    for (const banned of ['EQSCRIPT', '수식입니다', '그림입니다', '묶음 개체', 'FOOTNOTE']) {
      expect(text).not.toContain(banned);
    }
  });
});

describe('extractHwpxTables — 중첩 표·index', () => {
  it('중첩 표는 부모 셀에 넣지 않고 별도 표로, index는 시작 태그 순서(바깥 → 안쪽 → 다음)', () => {
    const inner = tbl(1, 1, [[cell(0, 0, 'INNER')]]);
    const deep = tbl(1, 1, [[cell(0, 0, 'DEEP')]]);
    const innerWithDeep = tbl(1, 2, [[cell(0, 0, 'mid'), { r: 0, c: 1, paras: [p(t('m-앞')), tblPara(deep)] }]]);
    const outer = tbl(1, 2, [
      [
        { r: 0, c: 0, paras: [p(t('앞')), tblPara(inner), p(t('뒤'))] },
        { r: 0, c: 1, paras: [tblPara(innerWithDeep)] },
      ],
    ]);
    const after = tbl(1, 1, [[cell(0, 0, 'AFTER')]]);
    const r = one(sec(p(t('본문')), tblPara(outer), p(t('사이')), tblPara(after)));
    expect(r.tables.map((x) => [x.index, x.cells])).toEqual([
      [0, [['앞\n\n뒤', '']]],
      [1, [['INNER']]],
      [2, [['mid', 'm-앞\n']]],
      [3, [['DEEP']]],
      [4, [['AFTER']]],
    ]);
  });

  it('섹션을 넘어 index를 통산하고 section 번호를 싣는다 — 입력 순서와 무관하게 숫자 순', () => {
    const a = sec(tblPara(tbl(1, 1, [[cell(0, 0, 's0-a')]])), tblPara(tbl(1, 1, [[cell(0, 0, 's0-b')]])));
    const b = sec(tblPara(tbl(1, 1, [[cell(0, 0, 's2')]])));
    const c = sec(tblPara(tbl(2, 1, [[cell(0, 0, 's10')]]))); // 구조 불일치도 index를 소비한다
    const r = extractHwpxTables([
      { section: 10, xml: c },
      { section: 0, xml: a },
      { section: 2, xml: b },
    ]);
    expect(r.tables.map((x) => [x.index, x.section, at(x, 0, 0)])).toEqual([
      [0, 0, 's0-a'],
      [1, 0, 's0-b'],
      [2, 2, 's2'],
    ]);
    expect(r.skipped).toEqual([{ index: 3, section: 10, reason: 'structure-mismatch' }]);
  });

  it('표가 없는 섹션은 빈 결과', () => {
    expect(one(sec(p(t('본문만'))))).toEqual({ tables: [], skipped: [] });
  });
});

describe('sliceOuterTables — 깊이 인식 스캔(S-24)', () => {
  it('가장 바깥 표 조각만, 중첩은 안에 둔 채 자른다', () => {
    const inner = tbl(1, 1, [[cell(0, 0, 'i')]]);
    const outer = tbl(1, 1, [[{ r: 0, c: 0, paras: [tblPara(inner)] }]]);
    const second = tbl(1, 1, [[cell(0, 0, 's')]]);
    const parts = sliceOuterTables(sec(tblPara(outer), p(t('x')), tblPara(second)));
    expect(parts).toEqual([outer, second]);
  });

  it('hp:tbl로 시작하는 다른 이름은 표로 세지 않는다', () => {
    expect(sliceOuterTables('<hp:tblX a="1"></hp:tblX>')).toEqual([]);
  });

  it('닫는 태그가 모자라면 조용히 자르지 않고 던진다', () => {
    const cut = sec(tblPara(tbl(1, 1, [[cell(0, 0, 'a')]]))).replace('</hp:tbl>', '');
    expect(() => sliceOuterTables(cut)).toThrow('hwpx 표 태그 짝이 맞지 않습니다');
    expect(() => sliceOuterTables('<x></hp:tbl>')).toThrow('hwpx 표 태그 짝이 맞지 않습니다');
  });
});

// ---------------------------------------------------------------------------
// 픽스처
// ---------------------------------------------------------------------------

describe('픽스처 격자', () => {
  const allText = (cells: string[][]) => cells.flat().join('\u0001');

  it('기술목표 11×14 — 병합·조각·lineBreak, 각주 본문 없음', () => {
    const r = one(fixture('tech'));
    expect(r.skipped).toEqual([]);
    expect(r.tables).toHaveLength(1);
    const g = first(r);
    expect([g.index, g.section, g.rowCnt, g.colCnt]).toEqual([0, 0, 11, 14]);
    expect(g.cells).toHaveLength(11);
    expect(g.cells.every((row) => row.length === 14)).toBe(true);
    // 평가 항목 2×2 병합
    expect(new Set([at(g, 0, 0), at(g, 0, 1), at(g, 1, 0), at(g, 1, 1)]).size).toBe(1);
    // 개발 목표치 가로 4 병합, 아래 연차 머리
    expect(new Set(row(g, 0).slice(6, 10))).toEqual(new Set(['개발 목표치']));
    expect(row(g, 1).slice(6, 10)).toEqual(['1차\n년도', '2차\n년도', '3차\n년도', '4차\n년도']);
    // 구분 세로 병합(5행 + 4행), 두 번째 구분 셀은 lineBreak
    expect(new Set(g.cells.slice(2, 7).map((cells) => cells[0])).size).toBe(1);
    expect(new Set(g.cells.slice(7, 11).map((cells) => cells[0]))).toEqual(new Set([at(g, 7, 0)]));
    expect(at(g, 7, 0)).toContain('\n');
    // run 2개 + lineBreak
    expect(at(g, 4, 1)).toBe('3. 합성 탐지 정확도\n(가상 조건)');
    // 두 문단
    expect(at(g, 2, 12)).toBe('공인기관\n시험평가');
    expect(at(g, 4, 13)).toBe('다라\n연구원');
    // 빈 칸
    expect(at(g, 6, 6)).toBe('');
    // 기준설정근거 머리 셀 — 각주 본문은 넣지 않는다
    expect(at(g, 0, 11)).toBe('기준\n설정\n근거');
    expect(allText(g.cells)).not.toContain('상세 근거는 평가환경 열 참고');
  });

  it('성과목표 15×12 — 구분·항목 병합, 조각 이음, &', () => {
    const r = one(fixture('deliverable'));
    expect(r.skipped).toEqual([]);
    expect(r.tables).toHaveLength(1);
    const g = first(r);
    expect([g.rowCnt, g.colCnt]).toEqual([15, 12]);
    expect(row(g, 0).slice(1, 4)).toEqual(['항목', '항목', '항목']);
    expect(at(g, 1, 1)).toBe('항목');
    expect(g.cells.slice(4, 10).map((cells) => cells[0])).toEqual(Array(6).fill('특허'));
    expect(row(g, 4).slice(1, 4)).toEqual(['국내', '등록', '건수']); // '건'+'수' 두 run
    expect(at(g, 6, 3)).toBe('출원');
    expect(at(g, 10, 0)).toBe(' 학술'); // 앞 공백 유지
    expect(at(g, 10, 11)).toBe('합성 증빙&\n합성 논문');
    expect(row(g, 14).slice(1, 4)).toEqual(['시제품', '시제품', '시제품']);
  });

  it('평가방법 10×4 — 수식·그림 제외, tab·fwSpace 공백', () => {
    const r = one(fixture('method'));
    expect(r.skipped).toEqual([]);
    expect(r.tables).toHaveLength(1);
    const g = first(r);
    expect([g.rowCnt, g.colCnt]).toEqual([10, 4]);
    expect(g.cells.map((cells) => cells[0])).toEqual(['순번', '1', '2', '3', '4', '5', '6', '7', '8', '9']);
    expect(at(g, 1, 2)?.startsWith('\n')).toBe(true); // 첫 문단 빈 문단
    expect(at(g, 8, 1)).toBe('합성 연계\n시스템');
    expect(at(g, 9, 3)).toBe('');
    const text = allText(g.cells);
    for (const banned of ['sum _{i', 'TP over', 'T _{up}', 'T _{total}', '수식입니다', '그림입니다']) {
      expect(text).not.toContain(banned);
    }
    expect(text).not.toMatch(/\t/);
  });

  it('misc — rowCnt≠tr는 skipped, 중첩 표는 바깥 다음 index로 따로', () => {
    const r = one(fixture('misc'));
    expect(r.skipped).toEqual([{ index: 3, section: 0, reason: 'structure-mismatch' }]);
    expect(r.tables.map((x) => [x.index, x.rowCnt, x.colCnt])).toEqual([
      [0, 4, 14],
      [1, 2, 2],
      [2, 4, 14],
      [4, 4, 14],
      [5, 2, 2],
      [6, 2, 2],
    ]);
    const outer = r.tables.find((x) => x.index === 5)!;
    const nested = r.tables.find((x) => x.index === 6)!;
    const host = at(outer, 1, 1) ?? '';
    expect(host.startsWith('중첩 표 앞 문단\n')).toBe(true);
    expect(host.endsWith('\n중첩 표 뒤 문단')).toBe(true);
    for (const v of nested.cells.flat().filter((s) => s !== '')) expect(host).not.toContain(v);
    expect(allText(r.tables.flatMap((x) => x.cells))).not.toContain('상세 근거는 평가환경 열 참고');
  });

  it('tech-split — 조각 5개, 순서대로', () => {
    const r = one(fixture('tech-split'));
    expect(r.skipped).toEqual([]);
    expect(r.tables.map((x) => [x.index, x.rowCnt, x.colCnt])).toEqual([
      [0, 7, 14],
      [1, 6, 14],
      [2, 2, 2],
      [3, 5, 14],
      [4, 4, 14],
    ]);
  });
});
