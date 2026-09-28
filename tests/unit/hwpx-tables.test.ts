// 계획서 표 식별·머리행·잇기·열 역할 테스트 (SOT §6.18 HX-3·HX-4, 부록 C.3.1·C.3.5, S-1·S-2·S-3·S-14·S-28, U-1·U-2·U-5·U-8)
// 격자는 tests/fixtures/hwpx/README.md의 합성 표 모양을 손으로 옮긴 것이다 — 추출(extract)과의 통합은 T8·T13이 본다.

import { describe, expect, it } from 'vitest';
import { PLAN_ISSUES } from '@/lib/hwpx/issues';
import { countHeaderRows, identifyPlanTables, selectPayloadTables, signatureKind } from '@/lib/hwpx/tables';
import type { HwpxTable } from '@/lib/hwpx/types';

function grid(index: number, cells: string[][]): HwpxTable {
  return { index, section: 0, rowCnt: cells.length, colCnt: cells[0]!.length, cells };
}

// ─── 기술목표 (section-tech.xml 모양: 헤더 2, 14열, 최종 열 없음) ───

const TECH_H0 = [
  '평가 항목\n(주요성능\nSpec',
  '평가 항목\n(주요성능\nSpec',
  '단위',
  '전체 항목\n에서 차지하는\n비중\n(%)',
  '세계최고 수준 보유국/\n보유기업\n(   /   )',
  '연구개발 전 국내수준',
  '개발 목표치',
  '개발 목표치',
  '개발 목표치',
  '개발 목표치',
  '표준\n(시험)\n․\n인증\n기준',
  '기준\n설정\n근거\n상세 근거는 평가환경 열 참고',
  '평가 방법',
  '담당\n연구\n개발\n기관',
];
const TECH_H1 = [
  ...TECH_H0.slice(0, 4),
  '성능수준',
  '성능수준',
  '1차\n년도',
  '2차\n년도',
  '3차\n년도',
  '4차\n년도',
  ...TECH_H0.slice(10),
];

function techRow(seq: number | null, group = '합성 관제 플랫폼'): string[] {
  const name = seq === null ? '합성 번호 없는 항목' : `${seq}. 합성 항목 ${seq}`;
  return [group, name, '초', '10', '3(가상국/가상사)', '20', '≤10', '≤8', '≤5', '≤5', '-', '합성 근거', '자체 평가', '가나기술'];
}

function techTable(index: number, seqs: readonly (number | null)[], header: string[][] = [TECH_H0, TECH_H1]): HwpxTable {
  return grid(index, [...header.map((r) => [...r]), ...seqs.map((s) => techRow(s))]);
}

// ─── 성과목표 (section-deliverable.xml 모양: 헤더 2, 12열) ───

const DEL_H0 = ['구분', '항목', '항목', '항목', '단위', '가중치', '개발 목표치', '개발 목표치', '개발 목표치', '개발 목표치', '개발 목표치', '평가방법'];
const DEL_H1 = ['구분', '항목', '항목', '항목', '단위', '가중치', '1차\n년도', '2차\n년도', '3차\n년도', '4차\n년도', '계', '평가방법'];

function deliverableTable(index: number, header: string[][] = [DEL_H0, DEL_H1]): HwpxTable {
  return grid(index, [
    ...header.map((r) => [...r]),
    ['사업별\n성과지표', '인력양성 효과', '인력양성 효과', '인력양성 효과', '명', '10', '1', '1', '1', '1', '4', '재직증명'],
    ['특허', '국내', '등록', '건수', '건', '15', '-', '1', '1', '1', '3', '등록증'],
    ['특허', '국내', '등록', 'SMART(1∼9) 평균*', '점수', '-', '-', '-', '-', '-', '-', '-'],
    ['상용화', '시제품', '시제품', '시제품', '건', '20', '-', '-', '1', '1', '2', '시제품 사진 & 보고서'],
  ]);
}

// ─── 평가방법 (section-method.xml 모양: 헤더 1, 4열) ───

const METHOD_H0 = ['순번', '평가항목\n(성능지표)', '평가방법', '평가환경'];

function methodTable(index: number, seqs: readonly string[], header: string[] = METHOD_H0): HwpxTable {
  return grid(index, [
    [...header],
    ...seqs.map((s) => [s, `합성 항목 ${s}`, '공인기관 시험평가', '합성 환경\n[기준설정 근거] : 합성']),
  ]);
}

function unrelated(index: number): HwpxTable {
  return grid(index, [
    ['항목', '내용'],
    ['합성', '무관한 표'],
  ]);
}

function kinds(issues: readonly { kind: string }[]): string[] {
  return issues.map((i) => i.kind);
}

// ─── 서명 (HX-3, C.3.1) ──────────────────────────────────────

describe('헤더 서명', () => {
  it('세 종류를 머리행 문구로 식별한다(별칭 전체항목에서차지하는비중·연구개발전국내수준·성능지표 포함)', () => {
    expect(signatureKind(techTable(0, [1, 2]))).toBe('tech');
    expect(signatureKind(deliverableTable(0))).toBe('deliverable');
    expect(signatureKind(methodTable(0, ['1']))).toBe('method');
    expect(signatureKind(unrelated(0))).toBeNull();
  });

  it('별칭만 있어도 맞는다 — 비중 ← 전체항목에서차지하는비중, 국내수준 ← 연구개발전국내수준', () => {
    // 픽스처 머리행은 이미 별칭 형태다: `비중` 단독 문구·`국내수준` 단독 문구가 없다
    const h0 = TECH_H0.map((c) => c);
    expect(h0.some((c) => c === '비중' || c === '국내수준')).toBe(false);
    expect(signatureKind(techTable(0, [1]))).toBe('tech');
  });

  it('성과목표 별칭 목표치 — `개발 목표치` 대신 `목표치`여도 맞는다', () => {
    const h0 = DEL_H0.map((c) => (c === '개발 목표치' ? '목표치' : c));
    expect(signatureKind(deliverableTable(0, [h0, DEL_H1]))).toBe('deliverable');
  });

  it('평가방법 별칭 성능지표 — `평가항목` 없이 `성능지표`여도 맞는다', () => {
    const t = methodTable(0, ['1'], ['순번', '성능지표', '평가방법', '평가환경']);
    expect(signatureKind(t)).toBe('method');
  });

  it('키워드 1개 누락이면 불일치 — `연구개발 전 참고수준`(국내수준 없음)', () => {
    const h0 = TECH_H0.map((c) => (c === '연구개발 전 국내수준' ? '연구개발 전 참고수준' : c));
    expect(signatureKind(techTable(0, [1], [h0, TECH_H1]))).toBeNull();
  });

  it('성과목표에서 가중치가 빠지면 불일치', () => {
    const strip = (r: string[]) => r.map((c) => (c === '가중치' ? '비율' : c));
    expect(signatureKind(deliverableTable(0, [strip(DEL_H0), strip(DEL_H1)]))).toBeNull();
  });

  it('서명은 첫 2행만 본다 — 셋째 행의 키워드는 세지 않는다', () => {
    const t = grid(0, [
      ['순번', '평가항목', '평가방법', '비고'],
      ['1', '합성', '자체', '없음'],
      ['평가환경', '', '', ''],
    ]);
    expect(signatureKind(t)).toBeNull();
  });

  it('교차 오인 없음 — 기술목표 표는 성과목표(가중치 없음)·평가방법(순번 없음)으로 잡히지 않고, 성과목표 표는 기술목표(세계최고 없음)로 잡히지 않는다', () => {
    const tech = techTable(0, [1]);
    const del = deliverableTable(1);
    const r = identifyPlanTables([tech, del]);
    expect(r.tech?.pieces).toEqual([0]);
    expect(r.deliverable?.pieces).toEqual([1]);
    expect(r.method).toBeNull();
  });
});

// ─── 머리행 수 (S-2) ─────────────────────────────────────────

describe('머리행 수', () => {
  it('실측 모양 2/2/1', () => {
    expect(countHeaderRows(techTable(0, [1, 2]), 'tech')).toBe(2);
    expect(countHeaderRows(deliverableTable(0), 'deliverable')).toBe(2);
    expect(countHeaderRows(methodTable(0, ['1', '2']), 'method')).toBe(1);
  });

  it('데이터 셀의 긴 문장 속 키워드는 완전 일치가 아니라 머리행으로 세지 않는다', () => {
    const t = grid(0, [
      ['순번', '평가항목', '평가방법', '평가환경'],
      ['1', '평가항목 합성', '평가방법은 공인기관', '평가환경 설명'],
    ]);
    expect(countHeaderRows(t, 'method')).toBe(1);
  });
});

// ─── 잇기 (HX-4) ─────────────────────────────────────────────

describe('쪽 나뉨 잇기', () => {
  it('index가 연달은 두 조각은 뒤 조각의 머리행을 떼고 잇는다 — 순번 연속이면 경고 없음', () => {
    const r = identifyPlanTables([techTable(0, [1, 2, 3, 4, 5]), techTable(1, [6, 7, 8, 9])]);
    expect(r.tech).not.toBeNull();
    const tech = r.tech!;
    expect(tech.pieces).toEqual([0, 1]);
    expect(tech.headerRows).toBe(2);
    expect(tech.rows).toHaveLength(9);
    expect(tech.rows.map((row) => row[1])).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9].map((n) => `${n}. 합성 항목 ${n}`));
    expect(tech.rowOrigins[0]).toEqual({ index: 0, row: 2 });
    expect(tech.rowOrigins[5]).toEqual({ index: 1, row: 2 });
    expect(kinds(r.issues)).not.toContain('sequence-gap');
    expect(kinds(r.issues)).not.toContain('duplicate-table');
  });

  it('입력 순서와 무관하게 index 순으로 묶는다', () => {
    const r = identifyPlanTables([techTable(1, [3, 4]), techTable(0, [1, 2])]);
    expect(r.tech?.pieces).toEqual([0, 1]);
  });

  it('사이에 다른 표가 있으면 별개 묶음 — 첫 묶음만 쓰고 "같은 표가 N개 더"', () => {
    const r = identifyPlanTables([techTable(0, [1, 2]), unrelated(1), techTable(2, [3, 4])]);
    expect(r.tech?.pieces).toEqual([0]);
    expect(r.tech?.rows).toHaveLength(2);
    const dup = r.issues.find((i) => i.kind === 'duplicate-table');
    expect(dup?.message).toContain('같은 표가 1개 더 있습니다');
    expect(dup?.blocking).toBe(false);
  });

  it('서버처럼 서명 일치 표만 받아도 index 간격으로 별개 묶음을 안다(S-14)', () => {
    const r = identifyPlanTables([techTable(0, [1, 2]), techTable(2, [3, 4]), techTable(5, [5])]);
    expect(r.tech?.pieces).toEqual([0]);
    expect(r.issues.find((i) => i.kind === 'duplicate-table')?.message).toContain('같은 표가 2개 더 있습니다');
  });

  it('구조 불일치로 건너뛴 표가 사이에 있으면 별개 묶음이고 사유로 알린다', () => {
    const r = identifyPlanTables(
      [techTable(0, [1, 2]), techTable(2, [3, 4])],
      [{ index: 1, section: 0, reason: 'structure-mismatch' }],
    );
    expect(r.tech?.pieces).toEqual([0]);
    expect(kinds(r.issues)).toContain('duplicate-table');
    expect(kinds(r.issues)).toContain('structure-mismatch');
  });

  it('이은 뒤 순번이 1씩 늘지 않으면 sequence-gap 경고(section-tech-split [3]·[4] — 4 빠짐)', () => {
    const r = identifyPlanTables([techTable(3, [1, 2, 3]), techTable(4, [5, 6])]);
    expect(r.tech?.pieces).toEqual([3, 4]);
    const gap = r.issues.find((i) => i.kind === 'sequence-gap');
    expect(gap?.blocking).toBe(false);
    expect(gap?.message).toContain('3 다음 5');
  });

  it('평가방법 순번 열(정수)도 검사한다', () => {
    const r = identifyPlanTables([techTable(0, [1]), methodTable(1, ['1', '2', '4'])]);
    expect(r.issues.find((i) => i.kind === 'sequence-gap')?.message).toContain('2 다음 4');
  });

  it('입력을 바꾸지 않고, 같은 입력이면 같은 출력', () => {
    const input = [techTable(0, [1, 2]), techTable(1, [3]), deliverableTable(2), methodTable(3, ['1', '2', '3'])];
    const snapshot = JSON.parse(JSON.stringify(input));
    const a = identifyPlanTables(input);
    const b = identifyPlanTables(input);
    expect(input).toEqual(snapshot);
    expect(a).toEqual(b);
    a.tech!.rows[0]![0] = '바꿈';
    expect(input[0]!.cells[2]![0]).toBe('합성 관제 플랫폼');
  });
});

// ─── 열 역할 (C.3.5) ─────────────────────────────────────────

describe('열 역할', () => {
  it('기술목표: 평가항목 가로 2열 중 N. 열이 name, 세계최고·국내수준·표준·기준설정근거는 읽지 않음, 연차 4, 최종 없음', () => {
    const r = identifyPlanTables([techTable(0, [1, 2, 3])]);
    const t = r.tech!;
    expect(t.columns).toEqual({ name: 1, unit: 2, weight: 3, year: [6, 7, 8, 9], measureMethod: 12, org: 13 });
    expect(t.unreadColumns.map((u) => [u.col, u.reason])).toEqual([
      [0, 'ignored'],
      [4, 'ignored'],
      [5, 'ignored'],
      [10, 'ignored'],
      [11, 'ignored'],
    ]);
    expect(t.unreadColumns[1]!.header).toBe('세계최고 수준 보유국/ 보유기업 ( / ) / 성능수준');
    const unread = r.issues.find((i) => i.kind === 'unread-column');
    expect(unread?.blocking).toBe(false);
    expect(unread?.message).toContain('기술목표 표');
    expect(kinds(r.issues)).not.toContain('missing-column');
  });

  it('U-1: N. 접두 값이 오른쪽이 아니라 왼쪽 열에 있으면 그 열이 name(데이터 행 다수결)', () => {
    const t = techTable(0, [1, 2, 3]);
    for (const row of t.cells.slice(2)) [row[0], row[1]] = [row[1]!, row[0]!];
    const r = identifyPlanTables([t]);
    expect(r.tech?.columns.name).toBe(0);
    expect(r.tech?.unreadColumns.find((u) => u.col === 1)?.reason).toBe('ignored');
  });

  it('U-1: 번호 없는 행이 섞여도 다수결로 고른다', () => {
    const r = identifyPlanTables([techTable(0, [1, null, 2])]);
    expect(r.tech?.columns.name).toBe(1);
  });

  it('성과목표: 구분·항목×3·단위·가중치·연차 4·계·평가방법', () => {
    const r = identifyPlanTables([deliverableTable(0)]);
    expect(r.deliverable?.columns).toEqual({
      category: 0,
      item: [1, 2, 3],
      unit: 4,
      weight: 5,
      year: [6, 7, 8, 9],
      total: 10,
      evidenceMethod: 11,
    });
    expect(r.deliverable?.unreadColumns).toEqual([]);
    expect(r.deliverable?.rows).toHaveLength(4);
  });

  it('평가방법: 순번·평가항목·평가방법·평가환경 4역할', () => {
    const r = identifyPlanTables([techTable(0, [1]), methodTable(1, ['1', '2'])]);
    expect(r.method?.columns).toEqual({ seq: 0, name: 1, measureDescription: 2, evaluationEnvironment: 3 });
    expect(r.method?.headerRows).toBe(1);
    expect(r.method?.rows).toHaveLength(2);
  });

  it('역할을 못 정한 열은 unknown으로 읽지 않은 열에 남긴다(조용히 버리지 않음)', () => {
    const t = grid(1, [
      ['순번', '평가항목', '평가방법', '평가환경', '비고'],
      ['1', '합성', '자체', '합성 환경', '합성 메모'],
    ]);
    const r = identifyPlanTables([techTable(0, [1]), t]);
    expect(r.method?.unreadColumns).toEqual([{ col: 4, header: '비고', reason: 'unknown' }]);
    expect(r.issues.some((i) => i.kind === 'unread-column' && i.message.includes('평가방법 표 비고'))).toBe(true);
  });

  it('한 역할에 여러 열이 맞으면 왼쪽 첫 열 — 나머지는 duplicate로 읽지 않은 열', () => {
    const t = grid(0, [
      ['순번', '평가항목', '평가방법', '평가환경', '평가방법'],
      ['1', '합성', '자체', '합성 환경', '중복'],
    ]);
    const r = identifyPlanTables([techTable(1, [1]), { ...t, index: 3 }]);
    expect(r.method?.columns.measureDescription).toBe(2);
    expect(r.method?.unreadColumns).toEqual([{ col: 4, header: '평가방법', reason: 'duplicate' }]);
  });

  it('한 열이 여러 역할 라벨을 품으면 긴 라벨이 이긴다(완전 일치는 곧 가장 긴 라벨)', () => {
    // `담당연구개발기관`(8자, org)과 `평가방법`(4자, measureMethod)을 둘 다 품은 머리행
    const h0 = [...TECH_H0];
    const h1 = [...TECH_H1];
    h0[13] = '담당연구개발기관 평가방법';
    h1[13] = h0[13];
    const r = identifyPlanTables([techTable(0, [1], [h0, h1])]);
    expect(r.tech?.columns.measureMethod).toBe(12);
    expect(r.tech?.columns.org).toBe(13);
  });

  it('아래 머리행에 역할이 없으면 위 머리행으로 정한다(세계최고 / 성능수준)', () => {
    const r = identifyPlanTables([techTable(0, [1])]);
    expect(r.tech?.unreadColumns.find((u) => u.col === 4)?.reason).toBe('ignored');
    expect(r.tech?.unreadColumns.find((u) => u.col === 6)).toBeUndefined();
  });

  it('필수 역할 열이 없으면 missing-column 경고', () => {
    const cut = (r: string[]) => r.slice(0, 13); // 담당기관 열 제거
    const t = grid(0, [cut(TECH_H0), cut(TECH_H1), cut(techRow(1))]);
    const r = identifyPlanTables([t]);
    expect(r.tech?.columns.org).toBeNull();
    expect(r.issues.find((i) => i.kind === 'missing-column')?.message).toContain('담당기관');
  });
});

// ─── 찾지 못함 (HX-3, S-28) ──────────────────────────────────

describe('표를 찾지 못함', () => {
  it('일부만 찾으면 찾은 것만 진행하고 나머지는 table-not-found(차단 아님)', () => {
    const r = identifyPlanTables([techTable(0, [1])]);
    expect(r.tech).not.toBeNull();
    const notFound = r.issues.filter((i) => i.kind === 'table-not-found');
    expect(notFound.map((i) => i.message)).toEqual([
      expect.stringContaining('성과목표 표'),
      expect.stringContaining('평가방법 표'),
    ]);
    expect(notFound[0]!.message).toContain('표를 찾지 못했습니다 — 헤더 서명');
    expect(r.issues.some((i) => i.blocking)).toBe(false);
  });

  it('기술목표·성과목표 둘 다 없으면 거부(blocking) — 평가방법만 있어도', () => {
    const r = identifyPlanTables([methodTable(0, ['1']), unrelated(1)]);
    expect(r.method).not.toBeNull();
    const reject = r.issues.find((i) => i.kind === 'no-goal-tables');
    expect(reject?.blocking).toBe(true);
    expect(identifyPlanTables([]).issues.find((i) => i.kind === 'no-goal-tables')?.blocking).toBe(true);
  });

  it('사유 표의 차단 여부', () => {
    expect(PLAN_ISSUES['no-goal-tables'].blocking).toBe(true);
    for (const k of ['sequence-gap', 'year-count-mismatch', 'unlinked-method-row', 'unread-column', 'duplicate-table'] as const) {
      expect(PLAN_ISSUES[k].blocking).toBe(false);
    }
  });
});

// ─── 전송분 (S-14) ───────────────────────────────────────────

describe('selectPayloadTables', () => {
  it('서명 일치 표만, 뒤쪽 중복 묶음까지 문서 순으로', () => {
    const tables = [unrelated(0), techTable(1, [1]), unrelated(2), techTable(3, [2]), deliverableTable(4), methodTable(5, ['1'])];
    const picked = selectPayloadTables({ tables, skipped: [] });
    expect(picked.map((t) => t.index)).toEqual([1, 3, 4, 5]);
    // 서버가 받은 전송분만으로 식별해도 같은 결과
    const onServer = identifyPlanTables(picked);
    const onClient = identifyPlanTables(tables);
    expect(onServer).toEqual(onClient);
  });
});
