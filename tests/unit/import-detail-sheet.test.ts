// 산출근거 시트 구조 감지 — D-1 섹션 · D-2 비목(섹션 문맥) · D-3 세목(번호×라벨) · D-4 컬럼 헤더
// · D-6 메모 열 · D-7 role 매핑 (SOT §6.11.1·§6.11.2, 부록 B.8.1, 부록 C.2 주의 1·2)
// + 행 변환 D-5 소계 · D-8/D-8a 조정액 · D-9 축 · D-10 통화 · D-21 금액 0 · D-18 소계 대조
// (§6.11.3·§6.11.5, 부록 B.7.1·B.7.2·B.8.2·B.8.3·B.8.4)
//
// 실측 파일에 의존하지 않는다 — 부록 B.8.1의 구조를 본뜬 합성 픽스처를 쓴다.
// 여기가 틀리면 금액이 조용히 다른 비목·세목으로 흘러간다.

import { describe, expect, it } from 'vitest';
import {
  DETAIL_COLUMN_ROLES,
  allowsMultipleColumns,
  applyColumnRoleOverrides,
  compareSubtotals,
  detectBlocks,
  detectSections,
  parseDetailRows,
  resolveColumnRole,
  sectionLookupKey,
  stripCategoryOrdinal,
  type DetailBlock,
  type DetailDraftRow,
  type FileSubtotal,
} from '@/lib/import/detail-sheet';
import type { MergeRange, RawCell, RawSheet } from '@/lib/import/types';

type CellSpec = string | number | null;

function sheetOf(name: string, rows: CellSpec[][], merges: MergeRange[] = []): RawSheet {
  const cells: RawCell[][] = rows.map((row) => row.map((value) => ({ value, isError: false })));
  return { name, cells, merges };
}

/**
 * 첫 열 텍스트로 행을 찾는다 — 픽스처가 길어 행 번호를 손으로 세면 반드시 틀린다.
 * `from`을 받는 이유: 섹션 밖 총괄표에도 같은 라벨이 있다 (그게 D-1이 막는 것이다)
 */
function rowOf(rows: CellSpec[][], label: string, from = 0): number {
  const index = rows.findIndex(
    (row, i) => i >= from && (row[0] === label || row[1] === label)
  );
  if (index === -1) throw new Error(`픽스처에 없는 행: ${label}`);
  return index;
}

function blocksOf(sheet: RawSheet): DetailBlock[] {
  return detectBlocks(sheet, detectSections(sheet));
}

// ─── 부록 B.8.1 재현 픽스처 ──────────────────────────────────

/** 활동비·간접비가 쓰는 형태 3 (내역·단가·회·월·합계·비고) */
const ACTIVITY_HEADER: CellSpec[] = ['내역', '단가', '회', '월', '합계', '비고'];

interface Fixture {
  sheet: RawSheet;
  rows: CellSpec[][];
}

function buildDetailFixture(): Fixture {
  const rows: CellSpec[][] = [];
  const merges: MergeRange[] = [];
  const add = (...cells: CellSpec[]): number => {
    rows.push(cells);
    return rows.length - 1;
  };

  // ── 섹션 밖 (실측 1~59행의 총괄표·요약). 여기서 금액을 읽으면 이중 계상이다
  add('연구개발비 총괄표');
  add('비목', '1차년도', '합계');
  add('인건비'); // 비목처럼 보이지만 섹션 밖이므로 블록이 되면 안 된다
  add('인건비', 180840000, 88650000, 269490000);
  add('다. 연구시설·장비비', 3000000, 0, 3000000);
  add(null);

  // ── 1. 직접비 소요명세
  add('1. 직접비 소요명세');

  // 가. 인건비 — 부처마다 열 위치가 다르다(산자부 형태). 소계 3단 (D-5)
  add('- 인건비');
  add('인력구분', '성명', '직위', '연봉', '참여율', '참여기간', '현금', '현물', '계', '비고');
  add('기존인력', '지동민', '책임연구원', 84000000, 64, 9, 40050000, 0, 40050000, null);
  add('기존인력', '김현수', '선임연구원', 60000000, 30, 12, 0, 18000000, 18000000, null);
  add('합계', null, null, null, null, null, 146840000, 88650000, 235490000, null);
  add('신규채용', '미정', '연구원', 40000000, 100, 10, 34000000, 0, 34000000, null);
  add('합계', null, null, null, null, null, 34000000, 0, 34000000, null);
  add('소 계', null, null, null, null, null, 180840000, 88650000, 269490000, null);

  // 다. 연구시설·장비비 — 세목 ①~④. ①만 2행 병합 헤더로 둔다 (D-4 · S-11)
  add('다. 연구시설·장비비');
  add(null, '① 연구시설·장비 구입·설치비');
  const facilityHeaderTop = add(
    '구분', '품명', '규격', '단위', '수량', '단가', '총액', null, null, '비고'
  );
  add(null, null, null, null, null, null, '현금', '현물', '합계', null);
  merges.push({ s: { r: facilityHeaderTop, c: 6 }, e: { r: facilityHeaderTop, c: 8 } });
  for (const c of [0, 1, 2, 3, 4, 5, 9]) {
    merges.push({ s: { r: facilityHeaderTop, c }, e: { r: facilityHeaderTop + 1, c } });
  }
  add('구입', '실증 계측기', 'A-100', '대', 1, 3000000, 3000000, 0, 3000000, null);
  add('소계', null, null, null, null, null, 3000000, 0, 3000000, null);
  for (const label of [
    '② 연구시설·장비 임차비',
    '③ 연구시설·장비 운영·유지비',
    '④ 연구인프라 조성비',
  ]) {
    add(null, label);
    add('구분', '품명', '규격', '단위', '수량', '단가', '현금', '현물', '합계', '비고');
    add('일반', `${label} 항목`, '-', '식', 1, 1000000, 1000000, 0, 1000000, null);
  }

  // 라. 연구재료비 — 세목 ①~③ (형태 2)
  add('라. 연구재료비');
  for (const label of ['① 연구재료 구입비', '② 연구개발과제 관리비', '③ 연구재료 제작비']) {
    add(null, label);
    add('품명', '산출내역', '규격', '단위', '수량', '단가', '현금', '현물', '합계', '비고');
    add(`${label} 자재`, '1식', '-', '식', 2, 500000, 1000000, 0, 1000000, null);
  }

  // 마. 연구활동비 — 세목 ①~⑪. ⑤는 한 번호가 두 표를 덮는다 (C.2 주의 2)
  add('마. 연구활동비');
  for (const label of ['① 외주용역비', '② 지식재산 창출 활동비', '③ 외부 전문기술 활용비']) {
    add(null, label);
    add(...ACTIVITY_HEADER);
    add(`${label} 내역`, 1000000, 1, 1, 1000000, null);
  }
  add(null, '④ 회의비');
  add(...ACTIVITY_HEADER);
  add('연구회의', 500000, 6, 1, 3000000, null);
  add('소계', null, null, null, 3000000, null);

  add(null, '⑤ 출장비');
  add('내역', '직급', '인원', '횟수', '산출비용', '합계', '비고');
  // D-6: 매핑된 열(비고, index 6)을 넘는 N~P 메모는 금액이 아니다
  add(
    '국내출장비', '책임', 2, 4, 150000, 1200000, null,
    null, null, null, null, null, null, '서울역↔실증지', 'KTX 금액', '스마플'
  );
  add('소계', null, null, null, null, 1200000, null);
  add('내역', '직급', '인원', '횟수', '산출비용', '합계', '비고');
  add('국외출장비', '책임', 1, 1, 2500000, 2500000, null);
  add('소계', null, null, null, null, 2500000, null);

  add(null, '⑥ 소프트웨어 활용비');
  add('내역', '단가', '시트(수량)', '월', '합계($)', '비고');
  add('설계 SW', 540000, 4, 9, 19440000, null);
  add(null, '⑦ 연구실 운영비(삭감)');
  add(...ACTIVITY_HEADER);
  add('소모품', 100000, 2, 1, 200000, null);
  for (const label of [
    '⑧ 연구인력 지원비',
    '⑨ 종합사업관리비',
    '⑩ 클라우드컴퓨팅서비스 이용료',
  ]) {
    add(null, label);
    add(...ACTIVITY_HEADER);
    add(`${label} 내역`, 200000, 1, 1, 200000, null);
  }
  add(null, '⑪ 그 밖의 비용');
  add(...ACTIVITY_HEADER);
  add('문헌구입비', 900000, 1, 1, 900000, null);
  add('논문게재료', 2480000, 1, 1, 2480000, null);
  add('학회, 세미나 참가비', null, null, null, 0, null);
  add('합 계', null, null, null, 27020000, null);

  // 자. 연구수당 — 세목이 없는 비목
  add('자. 연구수당');
  add('내역', '단가', '회', '합계', '비고');
  add('연구수당', 13000000, 1, 13000000, null);

  // 바. 국제공동연구개발비 — 세목이 없는 비목
  add('바. 국제공동연구개발비');
  add('품명', '산출내역', '규격', '단위', '수량', '단가', '현금', '현물', '합계', '비고');
  add('해외 공동실험', '1식', '-', '식', 1, 5000000, 5000000, 0, 5000000, null);

  // ── 2. 간접비 소요명세 — `가./나./다.`는 비목이 아니라 indirect의 세목이다 (D-2)
  add('2. 간접비 소요명세');
  add('가. 인력지원비');
  add('내역', '단가', '회', '합계', '비고');
  add('연구지원인력 인건비', 5000000, 1, 5000000, null);
  add('나. 연구지원비');
  add('내역', '단가', '회', '합계', '비고');
  add('연구실 안전관리비', 2000000, 1, 2000000, null);
  add('다. 성과활용지원비');
  add('내역', '단가', '회', '합계', '비고');
  add('성과 확산 활동비', 1000000, 1, 1000000, null);

  return { sheet: sheetOf('1차년도_250520', rows, merges), rows };
}

const fixture = buildDetailFixture();
const sections = detectSections(fixture.sheet);
const blocks = detectBlocks(fixture.sheet, sections);

function find(predicate: (block: DetailBlock) => boolean): DetailBlock {
  const block = blocks.find(predicate);
  if (!block) throw new Error('블록을 찾지 못했다');
  return block;
}

// ─── D-1 섹션 ────────────────────────────────────────────────

describe('detectSections — D-1', () => {
  it('부록 B.8.1: 섹션 2개', () => {
    expect(sections.map((s) => s.kind)).toEqual(['direct', 'indirect']);
    expect(sections[0]!.label).toBe('1. 직접비 소요명세');
    expect(sections[1]!.label).toBe('2. 간접비 소요명세');
  });

  it('직접비 섹션은 간접비 섹션 헤더 직전에서 끝난다', () => {
    expect(sections[0]!.startRow).toBe(sections[0]!.headerRow + 1);
    expect(sections[0]!.endRow).toBe(sections[1]!.headerRow - 1);
    expect(sections[1]!.endRow).toBe(fixture.rows.length - 1);
  });

  it.each([
    ['1. 직접비 소요명세', 'direct'],
    ['1.직접비 소요명세', 'direct'],
    ['１． 직접비소요명세', 'direct'],
    ['2. 간접비 소요명세', 'indirect'],
    ['２．간접비 소요명세', 'indirect'],
  ])('%s 표기를 감지한다', (label, kind) => {
    const sheet = sheetOf('s', [[label], ['- 인건비']]);
    const detected = detectSections(sheet);
    expect(detected).toHaveLength(1);
    expect(detected[0]!.kind).toBe(kind);
  });

  it('sectionLookupKey는 마침표·전각 숫자·공백을 접는다 (normalizeLabel은 안 한다)', () => {
    expect(sectionLookupKey('1. 직접비 소요명세')).toBe('1직접비소요명세');
    expect(sectionLookupKey('１． 직접비소요명세')).toBe('1직접비소요명세');
    expect(sectionLookupKey('2. 간접비 소요명세')).toBe('2간접비소요명세');
  });

  it('섹션이 없으면 빈 배열이다 — 거부 문구는 액션의 몫이라 던지지 않는다', () => {
    const summary = sheetOf('총괄표', [
      ['비목', '1차년도', '합계'],
      ['인건비', 180840000, 180840000],
    ]);
    expect(detectSections(summary)).toEqual([]);
    expect(detectBlocks(summary, [])).toEqual([]);
  });

  it('섹션 밖(총괄표·요약)은 결과에 한 행도 들어오지 않는다 — 이중 계상 방지', () => {
    const firstSectionRow = sections[0]!.headerRow;
    for (const block of blocks) {
      expect(block.categoryRow).toBeGreaterThan(firstSectionRow - 1);
      expect(block.dataStartRow).toBeGreaterThan(firstSectionRow);
    }
    // 섹션 위의 `인건비` 라벨 행이 블록을 열지 않았다
    expect(blocks.filter((b) => b.category === 'personnel')).toHaveLength(1);
  });
});

// ─── D-2 비목 + 섹션 문맥 ────────────────────────────────────

describe('detectBlocks — D-2 비목', () => {
  it('부록 B.8.1: 비목 블록 6종', () => {
    const direct = blocks.filter((b) => b.section === 'direct');
    expect([...new Set(direct.map((b) => b.category))]).toEqual([
      'personnel',
      'facility_equipment',
      'material',
      'activity',
      'allowance',
      'international',
    ]);
  });

  it('한글 순서 접두어와 `- `를 떼고 판정한다', () => {
    expect(stripCategoryOrdinal('가. 인건비')).toBe('인건비');
    expect(stripCategoryOrdinal('다. 연구시설·장비비')).toBe('연구시설·장비비');
    expect(stripCategoryOrdinal('- 인건비')).toBe('인건비');
    // 원문자는 떼지 않는다 — 떼면 세목이 비목 별칭에 걸린다
    expect(stripCategoryOrdinal('① 연구시설·장비 구입·설치비')).toBe(
      '① 연구시설·장비 구입·설치비'
    );
  });

  it('세목이 없는 비목(연구수당·국제공동)은 subcategory가 null이다', () => {
    for (const category of ['allowance', 'international', 'personnel'] as const) {
      const block = find((b) => b.category === category);
      expect(block.subcategory).toBeNull();
      expect(block.resolvedBy).toBeNull();
      expect(block.needsConfirm).toBe(false);
    }
  });

  it('D-5: 소계에서 멈추지 않는다 — 인건비 3단 소계 뒤 신규채용 행까지 읽는다', () => {
    const personnel = find((b) => b.category === 'personnel');
    const sectionStart = sections[0]!.headerRow;
    const newHire = rowOf(fixture.rows, '신규채용', sectionStart);
    const total = rowOf(fixture.rows, '소 계', sectionStart);
    expect(personnel.dataStartRow).toBeLessThan(newHire);
    expect(personnel.dataEndRow).toBeGreaterThanOrEqual(total);
    expect(personnel.dataEndRow).toBeLessThan(
      rowOf(fixture.rows, '다. 연구시설·장비비', sectionStart)
    );
  });
});

describe('D-2 섹션 문맥 — 같은 `다.`가 섹션에 따라 갈린다', () => {
  it('직접비의 `다.`는 연구시설·장비비 비목이다', () => {
    const block = find((b) => b.categoryLabel === '다. 연구시설·장비비');
    expect(block.section).toBe('direct');
    expect(block.category).toBe('facility_equipment');
  });

  it('간접비의 `다.`는 비목이 아니라 indirect의 성과활용지원비 세목이다', () => {
    const block = find((b) => b.subcategoryLabel === '다. 성과활용지원비');
    expect(block.section).toBe('indirect');
    expect(block.category).toBe('indirect');
    expect(block.subcategory).toBe('indirect_outcome');
  });

  it('부록 B.8.1: 간접비 세목 3종이 전부 indirect 아래로 들어간다', () => {
    const indirect = blocks.filter((b) => b.section === 'indirect');
    expect(indirect.map((b) => b.subcategory)).toEqual([
      'indirect_hr',
      'indirect_support',
      'indirect_outcome',
    ]);
    expect(indirect.every((b) => b.category === 'indirect')).toBe(true);
    // 인력지원비가 인건비로 둔갑하지 않는다
    expect(indirect.some((b) => b.category === 'personnel')).toBe(false);
  });

  it('같은 `가.` 라벨이라도 섹션이 다르면 다르게 읽힌다', () => {
    const direct = blocksOf(
      sheetOf('s', [
        ['1. 직접비 소요명세'],
        ['가. 인건비'],
        ['인력구분', '성명', '직위', '연봉', '참여율', '참여기간', '현금', '현물', '계', '비고'],
        ['기존인력', '홍길동', '책임', 84000000, 100, 12, 84000000, 0, 84000000, null],
      ])
    );
    expect(direct[0]!.category).toBe('personnel');
    expect(direct[0]!.subcategory).toBeNull();

    const indirect = blocksOf(
      sheetOf('s', [
        ['2. 간접비 소요명세'],
        ['가. 인력지원비'],
        ['내역', '단가', '회', '합계', '비고'],
        ['인력지원', 5000000, 1, 5000000, null],
      ])
    );
    expect(indirect[0]!.category).toBe('indirect');
    expect(indirect[0]!.subcategory).toBe('indirect_hr');
  });
});

// ─── D-3 세목 ────────────────────────────────────────────────

describe('detectBlocks — D-3 세목', () => {
  it('부록 B.8.1: 활동비 세목 ①~⑪ (⑤는 표가 둘이라 블록 12개)', () => {
    const activity = blocks.filter((b) => b.category === 'activity');
    expect(activity.map((b) => b.numberToken)).toEqual([
      '①', '②', '③', '④', '⑤', '⑤', '⑥', '⑦', '⑧', '⑨', '⑩', '⑪',
    ]);
    expect(new Set(activity.map((b) => b.subcategoryLabel)).size).toBe(11);
    expect(activity.map((b) => b.subcategory)).toEqual([
      'activity_outsourcing',
      'activity_ip',
      'activity_expert',
      'activity_meeting',
      'activity_travel_dom',
      'activity_travel_intl',
      'activity_software',
      'activity_lab_ops',
      'activity_hr_support',
      'activity_pmo',
      'activity_cloud',
      'activity_etc',
    ]);
  });

  it('시설·장비비 ①~④, 재료비 ①~③', () => {
    expect(blocks.filter((b) => b.category === 'facility_equipment').map((b) => b.subcategory))
      .toEqual(['facility_purchase', 'facility_lease', 'facility_maintain', 'facility_infra']);
    expect(blocks.filter((b) => b.category === 'material').map((b) => b.subcategory)).toEqual([
      'material_purchase',
      'material_manage',
      'material_make',
    ]);
  });

  it('번호와 라벨이 모두 맞으면 resolvedBy=both, 확인 불필요', () => {
    const block = find((b) => b.subcategoryLabel === '④ 회의비');
    expect(block.resolvedBy).toBe('both');
    expect(block.needsConfirm).toBe(false);
    expect(block.numberCandidates).toEqual(['activity_meeting']);
  });

  it('⑦ 연구실 운영비(삭감) — 괄호 접미어는 I-1이 흡수한다', () => {
    const block = find((b) => b.subcategoryLabel === '⑦ 연구실 운영비(삭감)');
    expect(block.subcategory).toBe('activity_lab_ops');
    expect(block.resolvedBy).toBe('both');
  });

  it.each([
    ['⑪ 그 밖의 비용', 'activity_etc'],
    ['⑪ 기타', 'activity_etc'],
  ])('%s → %s (부처별 변형)', (label, code) => {
    const detected = blocksOf(
      sheetOf('s', [
        ['1. 직접비 소요명세'],
        ['마. 연구활동비'],
        [null, label],
        ['내역', '단가', '회', '합계', '비고'],
        ['문헌구입비', 900000, 1, 900000, null],
      ])
    );
    expect(detected[0]!.subcategory).toBe(code);
    expect(detected[0]!.resolvedBy).toBe('both');
    expect(detected[0]!.needsConfirm).toBe(false);
  });

  it('번호와 라벨이 다른 세목을 가리키면 conflict — 자동 확정하지 않는다', () => {
    const detected = blocksOf(
      sheetOf('s', [
        ['1. 직접비 소요명세'],
        ['마. 연구활동비'],
        [null, '④ 국내출장비'],
        ['내역', '단가', '회', '합계', '비고'],
        ['출장', 150000, 8, 1200000, null],
      ])
    );
    const block = detected[0]!;
    expect(block.resolvedBy).toBe('conflict');
    expect(block.needsConfirm).toBe(true);
    expect(block.issues).toContain('subcategory-conflict');
    expect(block.subcategory).toBe('activity_travel_dom'); // 라벨 쪽을 제안하고
    expect(block.numberCandidates).toEqual(['activity_meeting']); // 번호 후보를 함께 낸다
  });

  it('라벨을 못 읽으면 번호로 제안하되 확인을 요구한다 (번호만 믿으면 조용히 틀린다)', () => {
    const detected = blocksOf(
      sheetOf('s', [
        ['1. 직접비 소요명세'],
        ['마. 연구활동비'],
        [null, '④ 사내 워크숍 비용'],
        ['내역', '단가', '회', '합계', '비고'],
        ['워크숍', 150000, 8, 1200000, null],
      ])
    );
    expect(detected[0]!.resolvedBy).toBe('number');
    expect(detected[0]!.subcategory).toBe('activity_meeting');
    expect(detected[0]!.needsConfirm).toBe(true);
  });

  it('번호도 라벨도 못 읽은 세목은 미해결로 드러낸다 — 앞 블록에 행을 붙이지 않는다', () => {
    const detected = blocksOf(
      sheetOf('s', [
        ['1. 직접비 소요명세'],
        ['마. 연구활동비'],
        [null, '④ 회의비'],
        ['내역', '단가', '회', '합계', '비고'],
        ['연구회의', 500000, 6, 3000000, null],
        [null, '⑬ 정체불명비'],
        ['내역', '단가', '회', '합계', '비고'],
        ['알 수 없음', 100000, 1, 100000, null],
      ])
    );
    expect(detected).toHaveLength(2);
    expect(detected[0]!.subcategory).toBe('activity_meeting');
    expect(detected[0]!.dataEndRow).toBeLessThan(detected[1]!.subcategoryRow!);
    expect(detected[1]!.resolvedBy).toBe('unresolved');
    expect(detected[1]!.subcategory).toBeNull();
    expect(detected[1]!.needsConfirm).toBe(true);
    expect(detected[1]!.issues).toContain('subcategory-unresolved');
  });
});

describe('C.2 주의 2 — ⑤ 출장비는 한 번호에 표가 둘이다', () => {
  it('표를 둘로 나누고 첫 데이터 행 라벨로 국내/국외를 가른다', () => {
    const travel = blocks.filter((b) => b.numberToken === '⑤');
    expect(travel).toHaveLength(2);
    expect(travel.map((b) => b.subcategory)).toEqual([
      'activity_travel_dom',
      'activity_travel_intl',
    ]);
    expect(travel.map((b) => b.tableIndex)).toEqual([0, 1]);
    expect(travel.every((b) => b.needsConfirm)).toBe(false);
    // 두 표의 데이터 범위가 겹치지 않는다 — 겹치면 금액이 두 번 계상된다
    expect(travel[0]!.dataEndRow).toBeLessThan(travel[1]!.dataStartRow);
  });

  it('가르지 못하면 둘 다 국내로 제안하고 확인을 요구한다 — 조용히 합치지 않는다', () => {
    const detected = blocksOf(
      sheetOf('s', [
        ['1. 직접비 소요명세'],
        ['마. 연구활동비'],
        [null, '⑤ 출장비'],
        ['내역', '직급', '인원', '횟수', '산출비용', '합계', '비고'],
        ['출장 1', '책임', 2, 4, 150000, 1200000, null],
        ['내역', '직급', '인원', '횟수', '산출비용', '합계', '비고'],
        ['출장 2', '책임', 1, 1, 2500000, 2500000, null],
      ])
    );
    expect(detected).toHaveLength(2);
    expect(detected.map((b) => b.subcategory)).toEqual([
      'activity_travel_dom',
      'activity_travel_dom',
    ]);
    expect(detected.every((b) => b.needsConfirm)).toBe(true);
    expect(detected.every((b) => b.issues.includes('travel-undecided'))).toBe(true);
    expect(detected[0]!.dataEndRow).toBeLessThan(detected[1]!.dataStartRow);
  });

  it('표가 하나면 헤더 라벨이 표를 가리킨다 (`⑤ 국외출장비`)', () => {
    const detected = blocksOf(
      sheetOf('s', [
        ['1. 직접비 소요명세'],
        ['마. 연구활동비'],
        [null, '⑤ 국외출장비'],
        ['내역', '직급', '인원', '횟수', '산출비용', '합계', '비고'],
        ['현지 실증 참관', '책임', 1, 1, 2500000, 2500000, null],
      ])
    );
    expect(detected[0]!.subcategory).toBe('activity_travel_intl');
    expect(detected[0]!.needsConfirm).toBe(false);
  });
});

// ─── D-4 · D-7 컬럼 ──────────────────────────────────────────

describe('D-4 컬럼 헤더 · D-7 role 매핑', () => {
  it('2행 병합 헤더를 상·하위 결합해 읽는다 (S-11 먼저)', () => {
    const block = find((b) => b.subcategory === 'facility_purchase');
    expect(block.headerRows).toHaveLength(2);
    const byIndex = new Map(block.columns.map((c) => [c.index, c]));
    expect(byIndex.get(6)).toMatchObject({ top: '총액', bottom: '현금', role: 'cashTotal' });
    expect(byIndex.get(7)).toMatchObject({ top: '총액', bottom: '현물', role: 'inKindTotal' });
    expect(byIndex.get(8)).toMatchObject({ top: '총액', bottom: '합계', role: 'total' });
    // 세로 병합으로 아래 행에 펼쳐진 값은 하위 라벨이 아니다
    expect(byIndex.get(1)).toMatchObject({ top: '품명', bottom: '', role: 'name' });
    expect(byIndex.get(9)!.role).toBe('note');
  });

  it('resolveColumnRole은 결합 → 하위 → 상위 순으로 본다', () => {
    expect(resolveColumnRole('총액', '현금')).toBe('cashTotal');
    expect(resolveColumnRole('산출내역', '단가')).toBe('unitPrice');
    expect(resolveColumnRole('산출내역', '')).toBe('spec');
    expect(resolveColumnRole('참여율(%)', '')).toBe('rate');
    expect(resolveColumnRole('인력 구분', '')).toBe('hireType');
    // 위치 고정 금지의 반대편 — 뜻을 모르는 헤더는 지어내지 않는다
    expect(resolveColumnRole('구 분', '')).toBeNull();
    expect(resolveColumnRole('번호', '')).toBeNull();
  });

  it('인자 라벨을 보존한다 (PL-3) — 실측 `시트(수량)`', () => {
    const block = find((b) => b.subcategory === 'activity_software');
    const factors = block.columns.filter((c) => c.role === 'factor');
    expect(factors.map((c) => c.label)).toEqual(['시트(수량)', '월']);
    // D-10 통화 감지가 볼 수 있게 헤더 원문을 남긴다
    expect(block.columns.find((c) => c.role === 'total')!.top).toBe('합계($)');
  });

  it('세목마다 컬럼을 따로 읽는다 — 출장비는 산출비용이 단가 자리다', () => {
    const travel = find((b) => b.subcategory === 'activity_travel_dom');
    expect(travel.roles.name).toBe(0);
    expect(travel.roles.position).toBe(1);
    expect(travel.roles.factor).toBe(2);
    expect(travel.roles.unitPrice).toBe(4);
    expect(travel.roles.total).toBe(5);
    expect(travel.roles.note).toBe(6);
  });
});

describe('D-7 부처별 인건비 헤더 — 위치가 달라도 같은 role 맵이 나온다', () => {
  const roleSetOf = (header: CellSpec[], dataRow: CellSpec[]): DetailBlock => {
    const detected = blocksOf(
      sheetOf('s', [['1. 직접비 소요명세'], ['- 인건비'], header, dataRow])
    );
    return detected[0]!;
  };

  const industry = roleSetOf(
    ['인력구분', '성명', '직위', '연봉', '참여율', '참여기간', '현금', '현물', '계', '비고'],
    ['기존인력', '지동민', '책임연구원', 84000000, 64, 9, 40050000, 0, 40050000, null]
  );
  const safety = roleSetOf(
    ['구 분', '번호', '인력 구분', '성명', '직위', '연봉', '참여율', '참여기간', '현금', '현물', '합계', '비고'],
    ['내부', 1, '기존인력', '지동민', '책임연구원', 84000000, 64, 9, 40050000, 0, 40050000, null]
  );

  it('두 서식이 같은 role 집합을 낸다', () => {
    const roles = (block: DetailBlock) => Object.keys(block.roles).sort();
    expect(roles(industry)).toEqual(roles(safety));
    expect(roles(industry)).toEqual(
      [
        'cashTotal',
        'hireType',
        'inKindTotal',
        'memberName',
        'note',
        'period',
        'position',
        'rate',
        'salary',
        'total',
      ].sort()
    );
  });

  it('열 위치는 서로 다르다 — 위치를 고정했으면 행안부에서 깨진다', () => {
    expect(industry.roles.memberName).toBe(1);
    expect(safety.roles.memberName).toBe(3);
    expect(industry.roles.hireType).toBe(0);
    expect(safety.roles.hireType).toBe(2);
  });

  it('뜻을 모르는 열(`구 분`·`번호`)은 role 없이 남는다 — 지어내지 않는다', () => {
    const unmapped = safety.columns.filter((c) => c.role === null).map((c) => c.label);
    expect(unmapped).toEqual(['구 분', '번호']);
  });
});

// ─── D-6 메모 열 ─────────────────────────────────────────────

describe('D-6 오른쪽 메모 열은 무시한다', () => {
  it('매핑된 열의 최대 인덱스를 넘는 N~P 메모가 컬럼에 들어오지 않는다', () => {
    const travel = find((b) => b.subcategory === 'activity_travel_dom');
    const maxIndex = Math.max(...travel.columns.map((c) => c.index));
    expect(maxIndex).toBe(travel.roles.note);
    expect(travel.columns.some((c) => c.label.includes('KTX'))).toBe(false);
    // 메모 텍스트가 있는 열(13~15)이 금액 열로 오인되지 않는다
    for (const column of travel.columns) {
      expect(column.index).toBeLessThan(13);
    }
  });

  it('헤더 힌트가 3개 미만인 메모 행은 컬럼 헤더가 아니다', () => {
    const detected = blocksOf(
      sheetOf('s', [
        ['1. 직접비 소요명세'],
        ['자. 연구수당'],
        ['비고: 지침 참조'],
        ['내역', '단가', '회', '합계', '비고'],
        ['연구수당', 13000000, 1, 13000000, null],
      ])
    );
    expect(detected).toHaveLength(1);
    expect(detected[0]!.headerRows).toEqual([3]);
  });
});

// ─── 조용한 실패 금지 ────────────────────────────────────────

describe('컬럼 헤더를 못 찾은 구간', () => {
  it('내용이 있는데 헤더가 없으면 블록으로 드러낸다 (조용히 버리지 않는다)', () => {
    const detected = blocksOf(
      sheetOf('s', [
        ['1. 직접비 소요명세'],
        ['자. 연구수당'],
        ['연구수당 지급', 13000000],
      ])
    );
    expect(detected).toHaveLength(1);
    expect(detected[0]!.issues).toEqual(['no-column-header']);
    expect(detected[0]!.needsConfirm).toBe(true);
    expect(detected[0]!.columns).toEqual([]);
  });

  it('세목을 거느린 비목 헤더는 자기 표가 없다 — 빈 블록을 만들지 않는다', () => {
    const facility = blocks.filter((b) => b.category === 'facility_equipment');
    expect(facility.every((b) => b.subcategory !== null)).toBe(true);
    expect(facility.every((b) => b.issues.length === 0)).toBe(true);
  });
});

describe('순수 함수', () => {
  it('입력 시트를 변형하지 않는다', () => {
    const snapshot = JSON.stringify(fixture.sheet);
    detectBlocks(fixture.sheet, detectSections(fixture.sheet));
    expect(JSON.stringify(fixture.sheet)).toBe(snapshot);
  });

  it('같은 입력에 같은 결과를 낸다', () => {
    expect(detectBlocks(fixture.sheet, sections)).toEqual(blocks);
  });
});

// ═══ 행 변환 (D-5 · D-8 · D-8a · D-9 · D-10 · D-21) ═════════

/** 부록 B.8.3이 셀 주소로 말한다 — 픽스처 행 번호를 엑셀 표기(1-based)로 되돌린다 */
function cellRef(cell: { column: string; row: number }): string {
  return `${cell.column}${cell.row + 1}`;
}

function rowsOf(sheet: RawSheet, predicate: (block: DetailBlock) => boolean): DetailDraftRow[] {
  const target = detectBlocks(sheet, detectSections(sheet)).filter(predicate);
  return target.flatMap((block) => parseDetailRows(sheet, block).rows);
}

// ─── 부록 B.7.1 인건비 픽스처 ────────────────────────────────

// 성명 · 연봉 · 참여율 · 축 · **파일 합계** · 기대 조정액. 참여기간은 전부 9개월이다.
// 조정액은 `파일 합계 − 산식 결과`이며 부록 B.7.1 표의 조정액 열이 곧 임포트의 기대 산출물이다 (B.8.4)
const B71: readonly (readonly [string, number, number, 'cash' | 'inKind', number, number])[] = [
  ['여욱현', 180000000, 10, 'cash', 13500000, 0],
  ['김영', 90000000, 30, 'cash', 20250000, 0],
  ['김지웅', 90000000, 30, 'inKind', 20250000, 0],
  ['박선욱', 74000000, 28, 'cash', 15540000, 0],
  ['지동민', 84000000, 64, 'inKind', 40050000, -270000],
  ['도상래', 64000000, 10, 'cash', 4800000, 0],
  ['이경아', 54000000, 70, 'inKind', 28350000, 0],
  ['김다래', 54000000, 26, 'cash', 10500000, -30000],
  ['김도현', 52000000, 10, 'cash', 3900000, 0],
  ['유태일', 46200000, 15, 'cash', 5190000, -7500],
  ['정우진', 51000000, 40, 'cash', 15300000, 0],
  ['김형식', 43500000, 41, 'cash', 13370000, -6250],
  ['신나리', 38000000, 40, 'cash', 11400000, 0],
  ['양소희', 39000000, 30, 'cash', 8770000, -5000],
  ['이다정', 41100000, 20, 'cash', 6160000, -5000],
  ['안승현', 36000000, 14, 'cash', 3780000, 0],
  ['진호령', 33000000, 30, 'cash', 7420000, -5000],
  ['장선우', 32000000, 29, 'cash', 6960000, 0],
];

/**
 * 실측 산자부 `1차년도_250520`의 인건비 표를 **행 번호까지** 본뜬다 —
 * 데이터 65~82행, 소계 3단(88 → 91 → 92행). 부록 B.8.3이 `J88`처럼 셀로 말하므로
 * 픽스처가 같은 자리를 쓰면 기준값이 눈으로 대조된다.
 */
function buildPersonnelSheet(): RawSheet {
  const rows: CellSpec[][] = [];
  const at = (index: number, cells: CellSpec[]): void => {
    while (rows.length < index) rows.push([null]);
    rows.push(cells);
  };
  // 행안부 형태 — 열 위치가 산자부와 다르다. 금액이 J·K·L에 온다
  const header: CellSpec[] = [
    '구 분', '번호', '인력 구분', '성명', '직위', '연봉', '참여율', '참여기간',
    '실지급액-월', '현금', '현물', '계', '비고',
  ];
  const money = (cash: number | null, inKind: number | null, total: number | null): CellSpec[] => [
    null, null, null, null, null, null, null, null, null, cash, inKind, total, null,
  ];

  at(0, ['1. 직접비 소요명세']);
  at(59, ['- 인건비']);
  at(63, header);
  B71.forEach(([name, salary, rate, axis, file], i) => {
    at(64 + i, [
      '내부', i + 1, '기존인력', name, '책임연구원', salary, rate, 9,
      Math.round(salary / 12), // 표시용 월액 — 계산 입력이 아니다 (PL-2)
      axis === 'cash' ? file : null,
      axis === 'inKind' ? file : null,
      file,
      null,
    ]);
  });
  // 소계 1단 — 기존인력 (J88 / K88). 여기서 멈추면 신규채용을 통째로 놓친다 (D-5)
  at(87, ['합계', ...money(146840000, 88650000, null).slice(1)]);
  at(88, [
    '내부', 19, '신규채용', '신규채용1(청년의무)', '연구원', 51000000, 100, 8,
    4250000, 34000000, null, 34000000, null,
  ]);
  at(90, ['합계', ...money(34000000, null, null).slice(1)]); // 2단 — 신규채용 (J91)
  at(91, ['소 계', ...money(180840000, 88650000, 269490000).slice(1)]); // 3단 (J92/K92/L92)

  return sheetOf('1차년도_250520', rows);
}

const personnelSheet = buildPersonnelSheet();
const personnelBlock = detectBlocks(personnelSheet, detectSections(personnelSheet))[0]!;
const personnelParsed = parseDetailRows(personnelSheet, personnelBlock);
const rowByName = (name: string): DetailDraftRow => {
  const row = personnelParsed.rows.find((r) => r.memberName === name);
  if (!row) throw new Error(`파싱되지 않은 성명: ${name}`);
  return row;
};

describe('parseDetailRows — D-5 소계에서 멈추지 않는다', () => {
  it('부록 B.8.2: 기존인력 18행 + 신규채용 1행 = 19행', () => {
    expect(personnelParsed.rows).toHaveLength(19);
  });

  it('첫 소계(88행) 뒤의 신규채용 34,000,000이 살아 있다 — 멈췄으면 여기서 실패한다', () => {
    const firstSubtotalRow = personnelParsed.subtotals[0]!.row;
    const afterFirst = personnelParsed.rows.filter((row) => row.row > firstSubtotalRow);
    expect(afterFirst).toHaveLength(1);
    expect(afterFirst[0]).toMatchObject({ memberName: '신규채용1(청년의무)', fileAmount: 34000000 });
    // 3단 소계를 전부 지나 블록 끝까지 읽었다
    expect(personnelParsed.subtotals.filter((s) => s.axis === 'cash')).toHaveLength(3);
  });

  it('부록 B.7.1 인건비 셀 합계 — 현금 180,840,000 / 현물 88,650,000', () => {
    const sum = (axis: 'cash' | 'in_kind'): number =>
      personnelParsed.rows
        .filter((row) => row.axis === axis)
        .reduce((total, row) => total + row.fileAmount, 0);
    expect(sum('cash')).toBe(180840000);
    expect(sum('in_kind')).toBe(88650000);
    expect(sum('cash') + sum('in_kind')).toBe(269490000);
  });

  it('소계 행은 데이터에 섞이지 않는다', () => {
    expect(personnelParsed.rows.some((row) => row.memberName === null)).toBe(false);
    expect(personnelParsed.rows.every((row) => row.status === 'included')).toBe(true);
  });
});

describe('parseDetailRows — D-8 조정액 흡수 (부록 B.7.1 · B.8.4)', () => {
  it.each(B71.map(([name, , , , file, adjustment]) => [name, file, adjustment] as const))(
    '%s: 파일 합계 %d, 조정액 %d',
    (name, file, adjustment) => {
      const row = rowByName(name);
      expect(row.fileAmount).toBe(file);
      expect(row.adjustment).toBe(adjustment);
      expect(row.formulaAmount + row.adjustment).toBe(file); // D-8의 등식
      expect(row.absorbed).toBe(adjustment !== 0);
    }
  );

  it('지동민 — 산식 40,320,000, 파일 40,050,000 → −270,000 (부록 B.8.4)', () => {
    expect(rowByName('지동민')).toMatchObject({
      formulaAmount: 40320000,
      fileAmount: 40050000,
      adjustment: -270000,
      absorbed: true,
      axis: 'in_kind',
    });
  });

  it('PL-2 회귀 — 박선욱은 15,540,000이다 (월액 선반올림이면 15,540,001)', () => {
    const row = rowByName('박선욱');
    expect(row.formulaAmount).toBe(15540000);
    expect(row.formulaAmount).not.toBe(15540001);
    expect(row.adjustment).toBe(0);
  });

  it('천원 절사가 아닌 실제 차액을 넣는다 — 유태일 −7,500 · 김형식 −6,250', () => {
    expect(rowByName('유태일').adjustment).toBe(-7500);
    expect(rowByName('김형식').adjustment).toBe(-6250);
  });
});

describe('parseDetailRows — D-8a 경계: 파일 연봉 vs 명부 연봉', () => {
  it('파일의 성명·연봉·직위·인력구분을 초안에 보존한다 (성명 매칭·D-14의 재료)', () => {
    expect(rowByName('지동민')).toMatchObject({
      memberName: '지동민',
      fileSalary: 84000000,
      position: '책임연구원',
      hireTypeLabel: '기존인력',
    });
    expect(rowByName('신규채용1(청년의무)').hireTypeLabel).toBe('신규채용');
  });

  it('인건비 조정액은 **파일 연봉** 기준의 잠정값이다 — 확정은 detail-preview의 몫', () => {
    expect(personnelParsed.rows.every((row) => row.adjustmentProvisional)).toBe(true);
    // 파서는 명부를 모른다: 산식 결과가 파일 연봉으로 계산됐음을 못 박는다
    const row = rowByName('김형식');
    expect(row.formulaAmount).toBe(Math.round(43500000 * 0.41 * (9 / 12)));
    expect(row.fileSalary).toBe(43500000);
  });

  it('PL-D1: personnel 행은 name·unitPrice를 쓰지 않는다 (단가는 명부 연봉이다)', () => {
    for (const row of personnelParsed.rows) {
      expect(row.formula).toBe('personnel');
      expect(row.name).toBe('');
      expect(row.unitPrice).toBe(0);
    }
  });

  it('인자는 참여율(%)·참여기간(월) 한 쌍이다 (PL-1)', () => {
    expect(rowByName('지동민').factors).toEqual([
      { label: '참여율(%)', value: 64, isPercent: true },
      { label: '참여기간(월)', value: 9, isPercent: false },
    ]);
    expect(rowByName('신규채용1(청년의무)').factors).toEqual([
      { label: '참여율(%)', value: 100, isPercent: true },
      { label: '참여기간(월)', value: 8, isPercent: false },
    ]);
  });
});

// ─── 부록 B.8.2 quantity 픽스처 ──────────────────────────────

/** 부록 B.8.2·B.7.2의 활동비 4세목 + 간접비 나. 연구지원비 */
function buildQuantitySheet(): RawSheet {
  const rows: CellSpec[][] = [
    ['1. 직접비 소요명세'],
    ['마. 연구활동비'],
    [null, '④ 회의비'],
    ['내역', '단가', '회', '합계', '비고'],
    ['회의비', 500000, 6, 3000000, null],
    ['소계', null, null, 3000000, null], // K181
    [null, '⑤ 국내출장비'],
    ['내역', '직급', '인원', '횟수', '산출비용', '합계', '비고'],
    // D-6: 매핑된 열을 넘는 메모는 금액이 아니다
    ['국내출장비', '책임', 2, 4, 150000, 1200000, null, null, null, '서울역↔실증지', 'KTX 금액'],
    ['소계', null, null, null, null, 1200000, null], // K188
    [null, '⑥ 소프트웨어 활용비'],
    ['내역', '단가', '시트(수량)', '월', '합계($)', '비고'],
    ['AEC Collection', 540000, 4, 9, 19440000, null],
    ['소계', null, null, null, 19440000, null], // K201
    [null, '⑪ 그 밖의 비용'],
    ['내역', '단가', '회', '합계', '비고'],
    ['인쇄/복사/인화/슬라이드 제작', 450000, 2, 900000, null],
    ['위탁정산 수수료', 2480000, 1, 2480000, null],
    // D-21 ②: 이름·단가는 있는데 금액이 0인 4행 — 건너뜀 제안으로 **남긴다**
    ['문헌구입비', null, null, 0, null],
    ['논문게재료', null, null, 0, null],
    ['학회, 세미나 참가비', null, null, 0, null],
    ['공인인증시험', 10000000, null, 0, null],
    // D-21 ①: 서식이 깔아 둔 빈 줄 — 조용히 버린다
    [null, null, null, null, null],
    [null, null, null, null, null],
    ['소계', null, null, 3380000, null], // K243
    ['합 계', null, null, 27020000, null], // 연구활동비 비목 합계 (L150)
    ['2. 간접비 소요명세'],
    ['나. 연구지원비'],
    ['내역', '단가', '회', '합계', '비고'],
    ['연구실 안전관리비', 2000000, 1, 2000000, null],
    ['학술활동 지원비', null, null, 0, null],
    ['연구실 환경개선비', null, null, 0, null],
    ['지식재산권 출원비', null, null, 0, null],
    ['기술정보 활동비', null, null, 0, null],
    ['시제품 제작 지원비', null, null, 0, null],
    ['소계', null, null, 2000000, null], // K279
  ];
  return sheetOf('1차년도_250520', rows);
}

const quantitySheet = buildQuantitySheet();
const quantityBlocks = detectBlocks(quantitySheet, detectSections(quantitySheet));
const parsedOf = (subcategory: string) => {
  const block = quantityBlocks.find((b) => b.subcategory === subcategory);
  if (!block) throw new Error(`블록을 찾지 못했다: ${subcategory}`);
  return parseDetailRows(quantitySheet, block);
};

describe('parseDetailRows — 부록 B.8.2 quantity 행', () => {
  it('④ 회의비 1행 — 단가 500,000 × 회 6 = 3,000,000', () => {
    const { rows } = parsedOf('activity_meeting');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      formula: 'quantity',
      name: '회의비',
      unitPrice: 500000,
      formulaAmount: 3000000,
      fileAmount: 3000000,
      adjustment: 0,
      absorbed: false,
      adjustmentProvisional: false, // D-8a는 인건비 이야기다
    });
    expect(rows[0]!.factors).toEqual([{ label: '회', value: 6, isPercent: false }]);
  });

  it('⑤ 국내출장비 1행 — 산출비용 150,000 × 인원 2 × 횟수 4 = 1,200,000', () => {
    const { rows } = parsedOf('activity_travel_dom');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ unitPrice: 150000, formulaAmount: 1200000, fileAmount: 1200000 });
    expect(rows[0]!.factors).toEqual([
      { label: '인원', value: 2, isPercent: false },
      { label: '횟수', value: 4, isPercent: false },
    ]);
    expect(rows[0]!.position).toBe('책임');
  });

  it('⑥ SW 1행 — 인자 라벨 `시트(수량)`가 보존된다 (PL-3)', () => {
    const { rows } = parsedOf('activity_software');
    expect(rows).toHaveLength(1);
    expect(rows[0]!.factors).toEqual([
      { label: '시트(수량)', value: 4, isPercent: false },
      { label: '월', value: 9, isPercent: false },
    ]);
    expect(rows[0]).toMatchObject({ formulaAmount: 19440000, fileAmount: 19440000, adjustment: 0 });
  });

  it('⑪ 그 밖의 비용 — 2행 + 0원 4행(건너뜀 제안), 빈 줄 2행은 사라진다 (D-21)', () => {
    const { rows } = parsedOf('activity_etc');
    expect(rows).toHaveLength(6);
    const included = rows.filter((row) => row.status === 'included');
    expect(included.map((row) => row.name)).toEqual([
      '인쇄/복사/인화/슬라이드 제작',
      '위탁정산 수수료',
    ]);
    expect(included.reduce((sum, row) => sum + row.fileAmount, 0)).toBe(3380000);

    const skipped = rows.filter((row) => row.status === 'skip-suggested');
    expect(skipped.map((row) => row.name)).toEqual([
      '문헌구입비',
      '논문게재료',
      '학회, 세미나 참가비',
      '공인인증시험',
    ]);
    // 조용히 버리지 않는다 — 사용자가 포함시킬 수 있게 이유를 붙여 남긴다
    expect(skipped.every((row) => row.issues.includes('zero-amount'))).toBe(true);
    expect(skipped.find((row) => row.name === '공인인증시험')!.unitPrice).toBe(10000000);
  });

  it('간접비 나. 연구지원비 — 1행 + 0원 5행, 2,000,000', () => {
    const { rows } = parsedOf('indirect_support');
    expect(rows).toHaveLength(6);
    const included = rows.filter((row) => row.status === 'included');
    expect(included).toHaveLength(1);
    expect(included[0]).toMatchObject({ name: '연구실 안전관리비', fileAmount: 2000000 });
    expect(rows.filter((row) => row.status === 'skip-suggested')).toHaveLength(5);
  });

  it('부록 B.7.2 연구활동비 셀 합계 27,020,000', () => {
    const rows = rowsOf(quantitySheet, (block) => block.category === 'activity');
    expect(rows.reduce((sum, row) => sum + row.fileAmount, 0)).toBe(27020000);
  });
});

describe('parseDetailRows — D-9 현금/현물 축', () => {
  it('합계 열만 있으면 현금으로 **제안**한다 (자동 확정이 아니다)', () => {
    const { rows } = parsedOf('activity_meeting');
    expect(rows[0]!.axis).toBe('cash');
    expect(rows[0]!.axisSuggested).toBe(true);
  });

  it('현금·현물이 둘 다 값이면 행을 둘로 나눈다 — §5.17은 행마다 축이 하나다', () => {
    const sheet = sheetOf('s', [
      ['1. 직접비 소요명세'],
      ['다. 연구시설·장비비'],
      [null, '① 연구시설·장비 구입·설치비'],
      ['구분', '품명', '규격', '단위', '수량', '단가', '현금', '현물', '합계', '비고'],
      ['구입', '실증 계측기', 'A-100', '대', 1, 3000000, 2000000, 1000000, 3000000, null],
    ]);
    const block = detectBlocks(sheet, detectSections(sheet))[0]!;
    const { rows } = parseDetailRows(sheet, block);

    expect(rows).toHaveLength(2);
    expect(rows.map((row) => row.axis)).toEqual(['cash', 'in_kind']);
    expect(rows.map((row) => row.axisIndex)).toEqual([0, 1]);
    expect(rows.every((row) => row.axisSuggested)).toBe(false);
    expect(rows.map((row) => row.fileAmount)).toEqual([2000000, 1000000]);
    // 근거는 원본 그대로 복제되고 차액은 조정액이 흡수한다 (D-8). 두 행의 합이 파일 합계다
    expect(rows.map((row) => row.formulaAmount)).toEqual([3000000, 3000000]);
    expect(rows.map((row) => row.adjustment)).toEqual([-1000000, -2000000]);
    expect(rows.reduce((sum, row) => sum + row.fileAmount, 0)).toBe(3000000);
  });

  it('한쪽 축만 값이면 나누지 않는다', () => {
    expect(rowByName('지동민').axis).toBe('in_kind');
    expect(rowByName('김영').axis).toBe('cash');
    expect(personnelParsed.rows.every((row) => row.axisIndex === 0)).toBe(true);
  });
});

describe('parseDetailRows — D-10 통화 기호', () => {
  it('`합계($)` 헤더를 보면 경고하고 그 블록의 모든 행이 확인 대상이 된다', () => {
    const { rows, currency } = parsedOf('activity_software');
    expect(currency).toMatchObject({ symbol: '$', text: '합계($)' });
    expect(rows.every((row) => row.needsConfirm)).toBe(true);
    expect(rows.every((row) => row.issues.includes('currency'))).toBe(true);
  });

  it('원화 블록에는 경고가 없다 — 환율을 지어내지 않지만 겁을 주지도 않는다', () => {
    expect(parsedOf('activity_meeting').currency).toBeNull();
    expect(personnelParsed.currency).toBeNull();
  });
});

describe('parseDetailRows — 조용한 실패 금지', () => {
  const parseSingle = (dataRow: CellSpec[], header: CellSpec[]): DetailDraftRow[] => {
    const sheet = sheetOf('s', [
      ['1. 직접비 소요명세'],
      ['자. 연구수당'],
      header,
      dataRow,
    ]);
    const block = detectBlocks(sheet, detectSections(sheet))[0]!;
    return parseDetailRows(sheet, block).rows;
  };
  const header: CellSpec[] = ['내역', '단가', '회', '합계', '비고'];

  it('I-12: 금액이 수식 에러면 0으로 삼키지 않고 확인을 요구한다', () => {
    const [row] = parseSingle(['연구수당', 13000000, 1, '#REF!', null], header);
    expect(row!.issues).toContain('amount-unparsable');
    expect(row!.needsConfirm).toBe(true);
    expect(row!.status).toBe('included'); // 읽지 못한 것이지 0원 자리가 아니다
  });

  it('I-11: 소수 금액을 반올림했으면 드러낸다', () => {
    const [row] = parseSingle(['연구수당', 13000000, 1, '13,000,000.5', null], header);
    expect(row!.fileAmount).toBe(13000001);
    expect(row!.issues).toContain('amount-rounded');
  });

  it('금액 열이 아예 없으면 드러낸다', () => {
    const [row] = parseSingle(['연구수당', 13000000, 1, null], ['내역', '단가', '회', '비고']);
    expect(row!.issues).toContain('no-amount-column');
    expect(row!.needsConfirm).toBe(true);
  });

  it('컬럼 헤더를 못 찾은 블록은 읽을 표가 없다 — 블록의 issues가 이미 드러낸다', () => {
    const sheet = sheetOf('s', [
      ['1. 직접비 소요명세'],
      ['자. 연구수당'],
      ['연구수당 지급', 13000000],
    ]);
    const block = detectBlocks(sheet, detectSections(sheet))[0]!;
    expect(block.issues).toEqual(['no-column-header']);
    expect(parseDetailRows(sheet, block)).toEqual({ rows: [], subtotals: [], currency: null });
  });
});

// ─── D-18 소계 대조 (부록 B.8.3) ─────────────────────────────

describe('compareSubtotals — D-18 부록 B.8.3', () => {
  it('인건비 소계 3단이 파일 셀 그대로 수집된다 (J88/K88 · J91 · J92/K92/L92)', () => {
    expect(personnelParsed.subtotals.map((s) => [cellRef(s), s.value])).toEqual([
      ['J88', 146840000],
      ['K88', 88650000],
      ['J91', 34000000],
      ['J92', 180840000],
      ['K92', 88650000],
      ['L92', 269490000],
    ]);
  });

  it('세 단이 모두 우리 합과 일치한다 — 구간 합과 누적 합을 함께 본다', () => {
    const comparisons = compareSubtotals(personnelParsed.rows, personnelParsed.subtotals);
    expect(comparisons.every((c) => c.matches)).toBe(true);
    expect(comparisons.map((c) => [cellRef(c), c.ourSum, c.scope])).toEqual([
      ['J88', 146840000, 'segment'],
      ['K88', 88650000, 'segment'],
      ['J91', 34000000, 'segment'], // 직전 소계 이후 구간 = 신규채용
      ['J92', 180840000, 'cumulative'], // 마지막 소계는 누적이다
      ['K92', 88650000, 'cumulative'],
      ['L92', 269490000, 'cumulative'],
    ]);
  });

  it.each([
    ['activity_meeting', 3000000], // K181
    ['activity_travel_dom', 1200000], // K188
    ['activity_software', 19440000], // K201
    ['indirect_support', 2000000], // K279
  ])('%s 세목 소계 %d이 우리 합과 일치한다', (subcategory, value) => {
    const { rows, subtotals } = parsedOf(subcategory);
    const comparison = compareSubtotals(rows, subtotals).find((c) => c.fileValue === value);
    expect(comparison).toBeDefined();
    expect(comparison!.ourSum).toBe(value);
    expect(comparison!.matches).toBe(true);
  });

  it('그 밖의 비용 소계 3,380,000 (K243) — 0원 행은 합에 보태지 않는다', () => {
    const { rows, subtotals } = parsedOf('activity_etc');
    const comparison = compareSubtotals(rows, subtotals).find((c) => c.fileValue === 3380000);
    expect(comparison).toMatchObject({ ourSum: 3380000, matches: true });
  });

  it('연구활동비 합계 27,020,000 (L150)은 블록을 합쳐 대조한다', () => {
    const activityRows = rowsOf(quantitySheet, (block) => block.category === 'activity');
    const total = parsedOf('activity_etc').subtotals.find((s) => s.value === 27020000)!;
    const [comparison] = compareSubtotals(activityRows, [total]);
    expect(comparison).toMatchObject({ fileValue: 27020000, ourSum: 27020000, matches: true });
  });

  it('어긋나면 양쪽 값과 차액을 그대로 드러낸다 — 반영을 막지는 않는다', () => {
    const { rows, subtotals } = parsedOf('activity_meeting');
    const tampered: FileSubtotal[] = subtotals.map((s) => ({ ...s, value: s.value + 1 }));
    const [comparison] = compareSubtotals(rows, tampered);
    expect(comparison).toMatchObject({
      fileValue: 3000001,
      ourSum: 3000000,
      difference: 1,
      matches: false,
    });
  });
});

describe('parseDetailRows — 순수 함수', () => {
  it('입력 시트를 변형하지 않는다', () => {
    const snapshot = JSON.stringify(quantitySheet);
    for (const block of quantityBlocks) parseDetailRows(quantitySheet, block);
    expect(JSON.stringify(quantitySheet)).toBe(snapshot);
  });

  it('같은 입력에 같은 결과를 낸다', () => {
    expect(parseDetailRows(personnelSheet, personnelBlock)).toEqual(personnelParsed);
  });
});

// ═══ 실물에서만 드러난 규칙 (D-7·D-7a·D-22~D-25) ════════════
//
// 아래는 실측 워크북에서 잡힌 결함을 합성 픽스처로 고정한 것이다. 실측 회귀는
// tests/unit/import-detail-samples.test.ts가 맡지만 그쪽은 samples/가 없는 PC에서 건너뛴다 —
// 규칙 자체는 여기서 파일 없이도 지켜져야 한다.

describe('D-24 비목 헤더 행에 금액이 있어도 비목이다', () => {
  // 실측 `C96="다. 연구시설·장비비" K96="합계" L96=0` — 숫자로 걸러 내면 비목이 통째로 사라지고
  // 그 아래 세목들이 직전 비목(인건비)에 붙어 시설·장비비가 인건비로 계상된다
  const sheet = sheetOf('s', [
    ['1. 직접비 소요명세'],
    ['- 인건비'],
    ['인력구분', '성명', '직위', '연봉', '참여율', '참여기간', '현금', '현물', '계', '비고'],
    ['기존인력', '홍길동', '책임', 84000000, 100, 12, 84000000, null, 84000000, null],
    ['소 계', null, null, null, null, null, 84000000, null, 84000000, null],
    ['다. 연구시설·장비비', null, null, null, null, null, null, null, '합계', 0],
    [null, '① 연구시설·장비 구입·설치비'],
    ['구분', '품명', '규격', '단위', '수량', '단가', '현금', '현물', '합계', '비고'],
    ['구입', '계측기', 'A-100', '대', 1, 3000000, 3000000, null, 3000000, null],
  ]);
  const detected = detectBlocks(sheet, detectSections(sheet));

  it('금액이 붙은 비목 헤더가 블록을 연다', () => {
    expect(detected.map((b) => `${b.category}/${b.subcategory ?? '-'}`)).toEqual([
      'personnel/-',
      'facility_equipment/facility_purchase',
    ]);
    // 세목이 앞 비목(인건비)에 붙어 미해결로 떨어지지 않는다
    expect(detected[1]!.issues).toEqual([]);
  });

  it('인건비 표가 다음 비목 헤더 행을 데이터로 먹지 않는다', () => {
    const rows = parseDetailRows(sheet, detected[0]!).rows;
    expect(rows).toHaveLength(1);
    expect(rows[0]!.memberName).toBe('홍길동');
  });

  it('접두어 없이 비목 이름과 같은 데이터 행은 비목이 아니다 — 실측 `C249="연구수당" K249=0`', () => {
    const same = sheetOf('s', [
      ['1. 직접비 소요명세'],
      ['자. 연구수당'],
      ['내역', '산출내역', '합계', '비고'],
      ['연구수당', '인건비의 20% 이내', 0, null],
      ['소계', null, 0, null],
    ]);
    const blocksOfSame = detectBlocks(same, detectSections(same));
    expect(blocksOfSame).toHaveLength(1);
    expect(parseDetailRows(same, blocksOfSame[0]!).rows.map((r) => r.name)).toEqual(['연구수당']);
  });
});

describe('D-25 세로 병합된 데이터 행을 두 번 읽지 않는다', () => {
  // 실측 `⑤ 국내출장비`는 C186:C187…K186:K187로 병합된 한 줄이다 —
  // S-11 확장이 187행에도 값을 펼치므로 그대로 읽으면 1,200,000이 2,400,000이 된다
  const rows: CellSpec[][] = [
    ['1. 직접비 소요명세'],
    ['마. 연구활동비'],
    [null, '⑤ 국내출장비'],
    ['내역', '직급', '인원', '횟수', '산출비용', '합계', '비고'],
    ['국내출장비', '책임', 2, 4, 150000, 1200000, null],
    [null, null, null, null, null, null, null],
    ['소계', null, null, null, null, 1200000, null],
  ];
  const merges: MergeRange[] = [0, 1, 2, 3, 4, 5, 6].map((c) => ({
    s: { r: 4, c },
    e: { r: 5, c },
  }));
  const sheet = sheetOf('s', rows, merges);
  const block = detectBlocks(sheet, detectSections(sheet))[0]!;
  const parsed = parseDetailRows(sheet, block);

  it('병합 안쪽 행은 앞 행의 복제라 행이 되지 않는다', () => {
    expect(parsed.rows).toHaveLength(1);
    expect(parsed.rows[0]!.fileAmount).toBe(1200000);
    expect(compareSubtotals(parsed.rows, parsed.subtotals)[0]).toMatchObject({
      fileValue: 1200000,
      ourSum: 1200000,
      matches: true,
    });
  });

  it('자기 값이 있는 행은 품명이 병합돼 있어도 살아남는다 — 금액을 잃지 않는다', () => {
    const own = sheetOf(
      's',
      [
        ['1. 직접비 소요명세'],
        ['라. 연구재료비'],
        [null, '① 연구재료 구입비'],
        ['품명', '규격', '수량', '단가', '합계', '비고'],
        ['시험용 자재', 'A형', 1, 500000, 500000, null],
        [null, 'B형', 1, 300000, 300000, null],
      ],
      [{ s: { r: 4, c: 0 }, e: { r: 5, c: 0 } }]
    );
    const target = detectBlocks(own, detectSections(own))[0]!;
    const result = parseDetailRows(own, target);
    expect(result.rows.map((r) => r.fileAmount)).toEqual([500000, 300000]);
    expect(result.rows[1]!.name).toBe('시험용 자재'); // 병합된 품명은 이어받는다 (S-11)
  });
});

describe('D-22 엑셀 백분율 서식 (참여율 100× 오차)', () => {
  // 실측 `H65 = 0.1`(표시는 `10.0%`). 그대로 넣으면 PL-1이 다시 100으로 나눠 금액이 1/100이 된다
  const personnelSheetOf = (rate: number, percentFormat: boolean): RawSheet => {
    const rows: CellSpec[][] = [
      ['1. 직접비 소요명세'],
      ['- 인건비'],
      ['인력구분', '성명', '직위', '연봉', '참여율', '참여기간', '현금', '현물', '계', '비고'],
      ['기존인력', '지동민', '책임', 84000000, rate, 9, null, 40050000, 40050000, null],
    ];
    const sheet = sheetOf('s', rows);
    if (percentFormat) sheet.cells[3]![4] = { value: rate, isError: false, percentFormat: true };
    return sheet;
  };

  it('percentFormat 셀은 100을 곱해 사람이 보는 숫자로 되돌린다', () => {
    const sheet = personnelSheetOf(0.64, true);
    const row = parseDetailRows(sheet, detectBlocks(sheet, detectSections(sheet))[0]!).rows[0]!;
    expect(row.factors[0]).toEqual({ label: '참여율(%)', value: 64, isPercent: true });
    expect(row.formulaAmount).toBe(40320000);
    expect(row.adjustment).toBe(-270000); // 부록 B.7.1 지동민
  });

  it('서식이 없으면 값을 그대로 믿는다 — 추측하지 않는다 (1 이하면 ×100 같은 휴리스틱 금지)', () => {
    const sheet = personnelSheetOf(64, false);
    const row = parseDetailRows(sheet, detectBlocks(sheet, detectSections(sheet))[0]!).rows[0]!;
    expect(row.factors[0]!.value).toBe(64);
    expect(row.formulaAmount).toBe(40320000);
  });
});

describe('D-23 비목 합계 줄 — 자리가 셋으로 흔들린다', () => {
  const buildSheet = (): RawSheet =>
    sheetOf('s', [
      ['1. 직접비 소요명세'],
      // ① 같은 행 (실측 96행)
      ['다. 연구시설·장비비', null, null, null, '합계', 3000000],
      [null, '① 연구시설·장비 구입·설치비'],
      ['품명', '규격', '수량', '단가', '합계', '비고'],
      ['계측기', 'A-100', 1, 3000000, 3000000, null],
      ['소계', null, null, null, 3000000, null],
      // ② 다음 행 (실측 149→150행)
      ['마. 연구활동비'],
      [null, null, null, null, '합계', 3000000],
      [null, '④ 회의비'],
      ['내역', '단가', '회', '합계', '비고'],
      ['회의비', 500000, 6, 3000000, null],
      ['소계', null, null, 3000000, null],
      // ③ 앞 행 (실측 246→247행)
      [null, null, null, null, '합계', 13000000],
      ['자. 연구수당'],
      ['내역', '산출내역', '합계', '비고'],
      ['연구수당', '인건비의 20% 이내', 13000000, null],
    ]);

  const sheet = buildSheet();
  const detected = detectBlocks(sheet, detectSections(sheet));
  const parsedAll = detected.map((block) => parseDetailRows(sheet, block));
  const allSubtotals = parsedAll.flatMap((p) => p.subtotals);
  const refOf = (s: FileSubtotal): string => `${s.column}${s.row + 1}`;

  it('세 자리 모두 subtotals에 담긴다 — 한 번씩만', () => {
    // 같은 행(2행) · 다음 행(8행) · 앞 행(13행). 세목 소계(6·12행)와 섞이지 않는다
    const categoryTotals = allSubtotals.filter((s) => s.label === '합계');
    expect(categoryTotals.map(refOf)).toEqual(['F2', 'F8', 'F13']);
    expect(categoryTotals.map((s) => s.value)).toEqual([3000000, 3000000, 13000000]);
    // 같은 비목의 세목이 여럿이어도 비목 합계 줄은 첫 블록에만 실린다
    expect(detected.filter((b) => (b.categoryTotalRows ?? []).length > 0)).toHaveLength(3);
  });

  it('데이터 행으로 만들지 않는다 — 만들면 그 비목이 두 배가 된다', () => {
    const rows = parsedAll.flatMap((p) => p.rows);
    expect(rows.map((r) => r.fileAmount)).toEqual([3000000, 3000000, 13000000]);
  });

  it('앞 행에 있는 합계 줄을 직전 세목(④ 회의비)의 소계로 편입하지 않는다', () => {
    const meeting = detected.findIndex((b) => b.subcategory === 'activity_meeting');
    expect(parsedAll[meeting]!.subtotals.map(refOf)).toEqual(['D12']); // ④의 소계 하나뿐
    const allowance = detected.find((b) => b.category === 'allowance')!;
    expect(allowance.categoryTotalRows).toEqual([12]); // 13행(1-based) = 연구수당의 비목 합계 줄
  });

  it('컬럼 헤더가 없는 자리에 와도 읽는다 — 겁주는 no-column-header를 붙이지 않는다', () => {
    const activityTotalBlock = detected.find(
      (b) => b.category === 'activity' && b.columns.length === 0
    )!;
    expect(activityTotalBlock.issues).toEqual([]);
    expect(activityTotalBlock.needsConfirm).toBe(false);
  });

  it('비목 합계는 그 비목의 행 전부와 대조한다 — 합계 줄이 데이터보다 위에 있어도', () => {
    const activityRows = parsedAll
      .filter((_, i) => detected[i]!.category === 'activity')
      .flatMap((p) => p.rows);
    const total = allSubtotals.find((s) => s.row === 7)!;
    expect(compareSubtotals(activityRows, [total])[0]).toMatchObject({
      fileValue: 3000000,
      ourSum: 3000000,
      scope: 'all',
      matches: true,
    });
  });
});

describe('D-7a 메모 열 숫자가 헤더 판정을 깨뜨리지 않는다', () => {
  // 실측 행안부 `⑥ 소프트웨어 활용비` 헤더 후보 두 줄 오른쪽에 메모 `O206=1`·`O207=1`이 있다 —
  // 시트 전체 폭에서 숫자를 보면 둘 다 탈락해 블록이 통째로 사라지고 통화 경고까지 묻힌다
  const sheet = sheetOf(
    's',
    [
      ['1. 직접비 소요명세'],
      ['마. 연구활동비'],
      [null, '⑥ 소프트웨어 활용비'],
      ['내역', '산출내역', null, null, '합계($)', '비고', null, '스마플', 1],
      [null, '단가', '시트(수량)', '월', null, null, null, '안전솔루션팀', 1],
      ['설계 SW', 540000, 4, 9, 19440000, null, null, '공간정보팀', 1],
      ['소계', null, null, null, 19440000, null],
    ],
    [
      { s: { r: 3, c: 1 }, e: { r: 3, c: 3 } }, // `산출내역`이 단가·시트(수량)·월을 덮는다
      { s: { r: 3, c: 0 }, e: { r: 4, c: 0 } },
      { s: { r: 3, c: 4 }, e: { r: 4, c: 4 } },
      { s: { r: 3, c: 5 }, e: { r: 4, c: 5 } },
    ]
  );
  const block = detectBlocks(sheet, detectSections(sheet))[0]!;
  const parsed = parseDetailRows(sheet, block);

  it('헤더 두 줄을 찾아 행·소계·통화 경고가 모두 살아난다', () => {
    expect(block.headerRows).toEqual([3, 4]);
    expect(block.issues).toEqual([]);
    expect(parsed.rows).toHaveLength(1);
    expect(parsed.rows[0]!.factors.map((f) => f.label)).toEqual([
      '산출내역 시트(수량)',
      '산출내역 월',
    ]);
    expect(parsed.subtotals.map((s) => s.value)).toEqual([19440000]);
    expect(parsed.currency?.symbol).toBe('$');
  });
});

describe('D-7 3행 헤더와 연봉 열 (부처별 변형)', () => {
  // 실측 행안부 인건비 헤더는 3단이고, 연봉 열 헤더가 `실지급액-월`+`(연봉`이라
  // I-1이 괄호를 지우면 `실지급액월`만 남는다. `연봉`만 찾으면 매핑에 실패해 산식이 0이 된다
  const sheet = sheetOf(
    's',
    [
      ['1. 직접비 소요명세'],
      ['- 인건비'],
      ['구 분', '번호', '인력 구분', '성명', '직위', '실지급액-월', '실지급액-월', '참여율', '참여기간(월)', '합 계(A×B×C/100)'],
      [null, null, null, null, null, '(연봉', '(연봉/12)', '(%)', '©'],
      [null, null, null, null, null, null, '(A)', '(B)', null, '현금', '현물', '계'],
      ['내부인건비', 1, '기존인력', '지동민', '책임', 84000000, 7000000, 64, 9, null, null, 40050000, 40050000],
      [null, 2, '기존인력', '김영', '이사', 90000000, 7500000, 30, 9, null, 20250000, null, 20250000],
    ],
    // 실측처럼 왼쪽 라벨들이 헤더 3행을 세로로 덮는다 (S-11이 아래 행에 펼친다)
    [0, 1, 2, 3, 4].map((c) => ({ s: { r: 2, c }, e: { r: 4, c } }))
  );
  const block = detectBlocks(sheet, detectSections(sheet))[0]!;
  const parsed = parseDetailRows(sheet, block);

  it('헤더 3행을 묶어 rate·period·salary가 살아난다', () => {
    expect(block.headerRows).toEqual([2, 3, 4]);
    expect(Object.keys(block.roles).sort()).toEqual([
      'cashTotal',
      'hireType',
      'inKindTotal',
      'memberName',
      'period',
      'position',
      'salary',
      'total',
      'rate',
    ].sort());
  });

  it('연봉 열을 찾아 조정액이 금액 전액을 떠안지 않는다 (D-8)', () => {
    const row = parsed.rows[0]!;
    expect(row.fileSalary).toBe(84000000);
    expect(row.formulaAmount).toBe(40320000);
    expect(row.adjustment).toBe(-270000);
  });

  it('D-3a ②: 행의 `내부인건비` 라벨을 초안에 싣고 아래로 이어받는다', () => {
    expect(parsed.rows.map((r) => r.personnelKindLabel)).toEqual(['내부인건비', '내부인건비']);
    // 세목 축(내부/외부)과 기존·신규 축은 다르다 — 섞으면 D-3a ②가 엉뚱한 세목을 고른다
    expect(parsed.rows.map((r) => r.hireTypeLabel)).toEqual(['기존인력', '기존인력']);
    expect(block.roles).not.toHaveProperty('personnelKind');
  });
});

describe('D-8a 명부 연봉을 모르는 자리 — 조정액에 금액을 밀어 넣지 않는다', () => {
  it('파일에 연봉이 없으면 조정액 0 + `salary-missing`으로 드러낸다', () => {
    const sheet = sheetOf('s', [
      ['1. 직접비 소요명세'],
      ['- 인건비'],
      ['인력구분', '성명', '직위', '연봉', '참여율', '참여기간', '현금', '현물', '계', '비고'],
      ['기존인력', '홍길동', '책임', null, 100, 12, 5000000, null, 5000000, null],
    ]);
    const row = parseDetailRows(sheet, detectBlocks(sheet, detectSections(sheet))[0]!).rows[0]!;
    expect(row.fileSalary).toBeNull();
    // 금액 전부를 조정액에 넣으면 나중에 연봉이 채워지는 순간 `산식 + 파일금액`이 되어 두 배가 된다
    expect(row.adjustment).toBe(0);
    expect(row.formulaAmount).toBe(0);
    expect(row.issues).toContain('salary-missing');
    expect(row.needsConfirm).toBe(true);
    expect(row.fileAmount).toBe(5000000); // 파일 값은 그대로 보존해 미리보기가 나란히 보여 준다
  });
});

// ═══ D-7 컬럼 role 재지정 (사용자가 고칠 수 있어야 한다) ═════
//
// "매핑 결과는 미리보기에 드러내 **사용자가 고칠 수 있어야 한다**"(D-7)의 고치는 쪽이다.
// 새 부처 서식에 사전이 모르는 헤더가 나오면 — 실측 `실지급액\n(연봉)` 하나 때문에 인건비 전체가
// 0원이 될 뻔했다 — 우회 수단이 없어 임포트가 통째로 막힌다 (§6.8 대원칙 · I-4).

describe('applyColumnRoleOverrides — D-7', () => {
  /** 부처 변형을 흉내낸다: 연봉 열 헤더만 사전이 모르는 낱말로 바꾼다 */
  const personnelSheetWith = (salaryHeader: string): RawSheet =>
    sheetOf('s', [
      ['1. 직접비 소요명세'],
      ['- 인건비'],
      ['인력구분', '성명', '직위', salaryHeader, '참여율', '참여기간', '현금', '현물', '계', '비고'],
      ['기존인력', '지동민', '책임연구원', 84000000, 64, 9, null, 40050000, 40050000, null],
    ]);

  const firstBlockOf = (sheet: RawSheet): DetailBlock =>
    detectBlocks(sheet, detectSections(sheet))[0]!;

  const SALARY_COLUMN = 3;

  it('사전이 모르는 헤더는 역할 없이 남고 인건비 산식이 0이 된다 (재지정이 없으면 막히는 자리)', () => {
    const sheet = personnelSheetWith('실수령액');
    const block = firstBlockOf(sheet);
    expect(block.columns[SALARY_COLUMN]).toMatchObject({ label: '실수령액', role: null });
    expect(block.roles).not.toHaveProperty('salary');

    const row = parseDetailRows(sheet, block).rows[0]!;
    expect(row.fileSalary).toBeNull();
    expect(row.formulaAmount).toBe(0);
    expect(row.issues).toContain('salary-missing');
  });

  it('재지정으로 salary를 붙이면 인건비 금액이 살아난다 (부록 B.8.4 지동민)', () => {
    const sheet = personnelSheetWith('실수령액');
    const fixed = applyColumnRoleOverrides(firstBlockOf(sheet), { [SALARY_COLUMN]: 'salary' });
    expect(fixed.roles.salary).toBe(SALARY_COLUMN);

    const row = parseDetailRows(sheet, fixed).rows[0]!;
    expect(row.fileSalary).toBe(84000000);
    expect(row.formulaAmount).toBe(40320000); // 84,000,000 / 12 × 9 × 64%
    expect(row.adjustment).toBe(-270000); // D-8: 파일 40,050,000이 진실이다
    expect(row.issues).not.toContain('salary-missing');
  });

  it('null은 잘못 잡힌 역할을 뗀다', () => {
    const sheet = personnelSheetWith('연봉');
    const block = firstBlockOf(sheet);
    expect(block.roles.salary).toBe(SALARY_COLUMN);

    const stripped = applyColumnRoleOverrides(block, { [SALARY_COLUMN]: null });
    expect(stripped.columns[SALARY_COLUMN]!.role).toBeNull();
    expect(stripped.roles).not.toHaveProperty('salary');
    // 열 자체는 남는다 — D-6의 오른쪽 절단을 여기서 되풀이하면 역할을 뗀 순간 열이 사라진다
    expect(stripped.columns).toHaveLength(block.columns.length);
    expect(parseDetailRows(sheet, stripped).rows[0]!.fileSalary).toBeNull();
  });

  it('원본 블록을 변조하지 않는다', () => {
    const block = firstBlockOf(personnelSheetWith('연봉'));
    const snapshot = JSON.stringify(block);
    const next = applyColumnRoleOverrides(block, { [SALARY_COLUMN]: null, 9: 'spec' });

    expect(JSON.stringify(block)).toBe(snapshot);
    expect(next).not.toBe(block);
    expect(next.columns).not.toBe(block.columns);
  });

  it('단일 값 role은 사용자 지정이 자동 감지를 밀어낸다 — 왼쪽 열이 조용히 이기지 않는다', () => {
    const block = firstBlockOf(personnelSheetWith('연봉'));
    // 사용자가 오른쪽 열을 연봉으로 지정했다. 자동 감지된 3열을 그대로 두면
    // columnOfRole이 왼쪽(3열)을 대표로 잡아 사용자의 지정이 아무 일도 하지 않는다
    const next = applyColumnRoleOverrides(block, { 9: 'salary' });
    expect(next.roles.salary).toBe(9);
    expect(next.columns[SALARY_COLUMN]!.role).toBeNull();
    expect(next.columns.filter((column) => column.role === 'salary')).toHaveLength(1);
  });

  it('factor는 여러 열이 정상이라 자동 감지를 밀어내지 않는다 (형태 3의 `단가|회|월`)', () => {
    const sheet = sheetOf('s', [
      ['1. 직접비 소요명세'],
      ['마. 연구활동비'],
      [null, '① 국내여비'],
      ACTIVITY_HEADER, // 내역·단가·회·월·합계·비고
      ['출장', 100000, 2, 3, 600000, null],
    ]);
    const block = firstBlockOf(sheet);
    expect(block.columns.filter((column) => column.role === 'factor').map((c) => c.index)).toEqual([2, 3]);

    const next = applyColumnRoleOverrides(block, { 0: 'factor' });
    expect(next.columns.filter((column) => column.role === 'factor').map((c) => c.index)).toEqual([0, 2, 3]);
    expect(next.roles.factor).toBe(0);
  });

  it('감지 결과에 없는 열은 건너뛴다 — 거부는 입력 검증의 몫이다', () => {
    const block = firstBlockOf(personnelSheetWith('연봉'));
    expect(applyColumnRoleOverrides(block, { 99: 'salary' })).toBe(block);
    expect(applyColumnRoleOverrides(block, undefined)).toBe(block);
    expect(applyColumnRoleOverrides(block, {})).toBe(block);

    // 유효한 지정은 살고 없는 열만 무시된다
    const next = applyColumnRoleOverrides(block, { 99: 'total', [SALARY_COLUMN]: null });
    expect(next.roles).not.toHaveProperty('salary');
    expect(next.roles.total).toBe(8); // `계` 열은 그대로다
  });

  it('allowsMultipleColumns는 factor만 참이다', () => {
    expect(allowsMultipleColumns('factor')).toBe(true);
    for (const role of DETAIL_COLUMN_ROLES.filter((r) => r !== 'factor')) {
      expect(allowsMultipleColumns(role)).toBe(false);
    }
  });
});
