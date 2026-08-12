#!/usr/bin/env node
// 제출 서식 템플릿 실측 조사 (dev 전용, SOT §6.12 / Phase 11 T1)
//
// **왜 `lib/export/`가 아니라 `scripts/`인가**: `lib/export/`는 SheetJS를 import하지 않는다
// (§6.12.4, §6.8.5 I-13과 같은 경계). 워크북을 실제로 여는 것은 어댑터와 이 조사 스크립트뿐이다.
// 이 스크립트의 산출물은 `templates/*.map.json`이라는 **데이터**이고(X-3), 런타임은 그 JSON만 읽는다.
//
// **역할 사전이 여기 있는 이유**: 맵을 만드는 것은 1회성 저작 작업이다. 런타임이 이 사전을 쓰지
// 않으므로 `lib/import`의 ROLE_KEYS와 갈라져도 조용히 틀리지 않는다 — 갈라지면 맵이 달라지고
// `validateLayout`과 단위 테스트가 그것을 드러낸다.
//
// 사용법:
//   node scripts/inspect-template.mjs            측정 리포트만 출력
//   node scripts/inspect-template.mjs --write    맵 JSON을 templates/에 쓴다
//
// ⚠ SheetJS의 .mjs 빌드는 `readFile`에 fs가 묶여 있지 않다 — readFileSync로 버퍼를 만들어 넘긴다.

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as XLSX from 'xlsx';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const TEMPLATE_FILE = '산출근거_표준.xlsx';
const MAP_FILE = '산출근거_표준.map.json';
const TEMPLATE_ID = 'standard-detail';

const DETAIL_SHEET = '산출근거';
const SUMMARY_SHEET = '총괄표';

const READ_OPTIONS = { type: 'buffer', cellStyles: true, cellFormula: true, cellNF: true };

// ─── 라벨 정규화 (I-1 계열: 괄호와 그 내용·공백·구분기호를 뗀다) ───────────────────

function normalizeLabel(text) {
  if (text === null || text === undefined) return '';
  return String(text)
    .normalize('NFKC')
    .replace(/\([^)]*\)/g, ' ')
    .replace(/[\s ]/g, '')
    .replace(/[·‧・ㆍ.,\-–—_/]/g, '');
}

/** 한 셀의 헤더 텍스트를 조각으로 쪼갠다. `실지급액\n(연봉)`·`총액(원)_현금`이 한 셀에 들어 있다 */
function headerParts(text) {
  if (text === null || text === undefined) return [];
  return String(text)
    .split(/[\n_]/)
    .map(normalizeLabel)
    .filter((part) => part !== '');
}

// ─── 컬럼 role (lib/import의 DETAIL_COLUMN_ROLES와 같은 어휘) ────────────────────

const ROLE_KEYS = {
  인력구분: 'hireType',
  성명: 'memberName',
  직위: 'position',
  실지급액: 'salary',
  실지급액월: 'salary',
  연봉: 'salary',
  참여율: 'rate',
  참여기간: 'period',
  품명: 'name',
  내역: 'name',
  규격: 'spec',
  산출내역: 'spec',
  단가: 'unitPrice',
  산출비용: 'unitPrice',
  수량: 'factor',
  회: 'factor',
  월: 'factor',
  인원: 'factor',
  횟수: 'factor',
  시트: 'factor',
  현금: 'cashTotal',
  현물: 'inKindTotal',
  합계: 'total',
  계: 'total',
  총액: 'total',
  비고: 'note',
};

/** 한 role이 여러 열을 차지해도 정상인가 (lib/import의 allowsMultipleColumns와 같은 규칙) */
const MULTI_COLUMN_ROLES = new Set(['factor']);

/**
 * 행 단위 **금액** 열. X-4대로 앱이 계산한 값으로 덮어쓰므로, 템플릿에 수식이 있어도
 * 데이터 대상에서 빼지 않는다 (`overwritesFormula: true`로 표시해 어댑터가 수식을 지우게 한다).
 *
 * 실측 근거: `산출근거!J65 = TRUNC(G65*H65*I65,-3)`처럼 금액 열이 수식이고, 원본에는 그 수식 안에
 * 조정상수까지 박혀 있었다. 수식을 살려 두면 §5.17 `adjustment`를 쓸 자리가 없다.
 * 소계·합계는 여기 들어오지 않는다 — 그것은 `subtotals` 좌표이고 X-4a대로 수식을 살린다.
 */
const AMOUNT_ROLES = new Set(['cashTotal', 'inKindTotal', 'total']);

/**
 * D-7: 여러 행에 걸친 헤더를 **아래에서 위로** 되짚어 role을 정한다.
 * `총액(원)` + `현금`은 아래가 의미를 정하고, `산출내역` + `단가`도 아래가 정한다.
 * 가로 병합은 펼치지 않는다 — `산출내역`(E:H 병합) 밑의 `인원`·`횟수`가 전부 spec으로 뭉개진다.
 */
function resolveRole(cellTexts) {
  const parts = cellTexts.flatMap(headerParts);
  for (let i = parts.length - 1; i >= 0; i -= 1) {
    const role = ROLE_KEYS[parts[i]];
    if (role) return role;
  }
  return null;
}

// D-4 헤더 힌트 어휘
const HEADER_HINTS = [
  '품명', '규격', '단위', '수량', '단가', '총액', '합계', '비고',
  '성명', '직위', '참여율', '참여기간', '내역', '인원', '횟수', '구분',
];
const HEADER_HINT_MIN = 3;

// ─── 이 템플릿의 라벨 → 부록 C 비목 / 부록 A.5 세목 ───────────────────────────────

/** 표의 키를 정규화형으로 다시 만든다 — NFKC가 `①`을 `1`로 바꾸므로 손으로 적으면 반드시 어긋난다 */
function normalizedTable(table) {
  return Object.fromEntries(Object.entries(table).map(([label, value]) => [normalizeLabel(label), value]));
}

const SECTION_LABELS = { '1직접비소요명세': 'direct', '2간접비소요명세': 'indirect' };

const CATEGORY_LABELS = normalizedTable({
  '인건비': 'personnel',
  '다. 연구시설·장비비': 'facility_equipment',
  '라. 연구재료비': 'material',
  '마. 연구활동비': 'activity',
  '자. 연구수당': 'allowance',
  '바. 국제공동연구개발비': 'international',
});

/** 간접비 섹션의 `가./나./다.`는 비목이 아니라 `indirect`의 세목이다 (D-2) */
const INDIRECT_SUBCATEGORY_LABELS = normalizedTable({
  '가. 인력지원비': 'indirect_hr',
  '나. 연구지원비': 'indirect_support',
  '다. 성과활용지원비': 'indirect_outcome',
});

const SUBCATEGORY_LABELS_RAW = {
  facility_equipment: {
    '①연구시설장비구입설치비': 'facility_purchase',
    '②연구시설장비임차비': 'facility_lease',
    '③연구시설장비운영유지비': 'facility_maintain',
    '④연구인프라조성비': 'facility_infra',
  },
  material: {
    '①연구재료구입비': 'material_purchase',
    '②연구개발과제관리비': 'material_manage',
    '③연구재료제작비': 'material_make',
  },
  activity: {
    '①외주용역비': 'activity_outsourcing',
    '②지식재산창출활동비': 'activity_ip',
    '③외부전문기술활용비': 'activity_expert',
    '④회의비': 'activity_meeting',
    '⑤출장비': null, // 국내/국외 두 하위 블록으로 갈린다. 아래 TRAVEL_LABELS가 정한다
    '⑥소프트웨어활용비': 'activity_software',
    '⑦연구실운영비': 'activity_lab_ops',
    '⑧연구인력지원비': 'activity_hr_support',
    '⑨종합사업관리비': 'activity_pmo',
    '⑩클라우드컴퓨팅서비스이용료': 'activity_cloud',
    '⑪그밖의비용': 'activity_etc',
  },
};

const SUBCATEGORY_LABELS = Object.fromEntries(
  Object.entries(SUBCATEGORY_LABELS_RAW).map(([category, table]) => [category, normalizedTable(table)])
);

/** ⑤ 출장비 아래 두 표는 세목 헤더 없이 데이터 행의 라벨로만 갈린다 */
const TRAVEL_LABELS = normalizedTable({
  국내출장비: 'activity_travel_dom',
  국외출장비: 'activity_travel_intl',
});

/**
 * 인건비는 세목 헤더 없이 소계 3단(합계 → 합계 → 소 계)으로 기존인력/신규채용이 갈린다 (부록 B.8.1).
 * 템플릿은 그 구분 라벨(`C65:C87`·`C89:C90` 병합 셀)까지 비워 두었으므로 **순서로만** 알 수 있다.
 */
const PERSONNEL_SEGMENTS = ['existing', 'newHire'];

const SUBTOTAL_LABELS = new Set(['소계', '합계', '계']);

// ─── 시트 접근 헬퍼 ──────────────────────────────────────────────────────────────

const A1 = (r, c) => XLSX.utils.encode_cell({ r, c });
const COL = (c) => XLSX.utils.encode_col(c);

function cellAt(ws, r, c) {
  return ws[A1(r, c)];
}

function textAt(ws, r, c) {
  const cell = cellAt(ws, r, c);
  if (!cell || cell.v === undefined || cell.v === null) return '';
  return String(cell.v);
}

function hasFormula(ws, r, c) {
  const cell = cellAt(ws, r, c);
  return Boolean(cell && cell.f);
}

function isPercentFormat(ws, r, c) {
  const cell = cellAt(ws, r, c);
  if (!cell || typeof cell.z !== 'string') return false;
  return /(^|[^\\])%/.test(cell.z);
}

function mergeIndex(ws) {
  const merges = ws['!merges'] ?? [];
  const byCell = new Map();
  for (const m of merges) {
    for (let r = m.s.r; r <= m.e.r; r += 1) {
      for (let c = m.s.c; c <= m.e.c; c += 1) byCell.set(A1(r, c), m);
    }
  }
  return { merges, byCell };
}

// ─── 보존 프로브 (X-1의 전제) ────────────────────────────────────────────────────

function workbookStats(wb) {
  let cells = 0;
  let styled = 0;
  let formulas = 0;
  let merges = 0;
  let numFmt = 0;
  for (const name of wb.SheetNames) {
    const ws = wb.Sheets[name];
    merges += (ws['!merges'] ?? []).length;
    for (const addr of Object.keys(ws)) {
      if (addr.startsWith('!')) continue;
      const cell = ws[addr];
      cells += 1;
      if (cell.s) styled += 1;
      if (cell.f) formulas += 1;
      if (cell.z) numFmt += 1;
    }
  }
  return { cells, styled, formulas, merges, numFmt };
}

function preservationProbe(buffer) {
  const before = XLSX.read(buffer, READ_OPTIONS);
  const roundTripped = XLSX.write(before, { type: 'buffer', bookType: 'xlsx', cellStyles: true });
  const after = XLSX.read(roundTripped, READ_OPTIONS);

  const diffs = { missingCell: 0, style: 0, numFmt: 0, formula: 0, value: 0, mergeRange: 0 };
  for (const name of before.SheetNames) {
    const a = before.Sheets[name];
    const b = after.Sheets[name];
    if (!b) {
      diffs.missingCell += 1;
      continue;
    }
    if (JSON.stringify(a['!merges'] ?? []) !== JSON.stringify(b['!merges'] ?? [])) diffs.mergeRange += 1;
    for (const addr of Object.keys(a)) {
      if (addr.startsWith('!')) continue;
      const x = a[addr];
      const y = b[addr];
      if (!y) {
        diffs.missingCell += 1;
        continue;
      }
      if (JSON.stringify(x.s) !== JSON.stringify(y.s)) diffs.style += 1;
      if (x.z !== y.z) diffs.numFmt += 1;
      if (x.f !== y.f) diffs.formula += 1;
      if (String(x.v) !== String(y.v)) diffs.value += 1;
    }
  }
  return { before: workbookStats(before), after: workbookStats(after), diffs };
}

// ─── X-2 청결도 ─────────────────────────────────────────────────────────────────

function cleanlinessProbe(wb) {
  const numericCells = [];
  const cachedFormulaValues = [];
  const literalsInFormulas = [];
  for (const name of wb.SheetNames) {
    const ws = wb.Sheets[name];
    for (const addr of Object.keys(ws)) {
      if (addr.startsWith('!')) continue;
      const cell = ws[addr];
      if (cell.f) {
        if (cell.v !== undefined && cell.v !== null && cell.v !== '') {
          cachedFormulaValues.push(`${name}!${addr}`);
        }
        // 수식 안에 박힌 숫자 상수. 실측 샘플의 조정액이 그대로 남으면 앱이 쓴 근거 값과
        // 엑셀이 계산한 금액이 어긋난다 (X-4의 검산이 무의미해진다)
        const literals = String(cell.f).match(/(?<![A-Za-z$:])\d{4,}/g);
        if (literals) literalsInFormulas.push({ addr: `${name}!${addr}`, formula: cell.f });
      } else if (typeof cell.v === 'number') {
        numericCells.push(`${name}!${addr}`);
      }
    }
  }
  return { numericCells, cachedFormulaValues, literalsInFormulas };
}

// ─── 수식 분포 (T6 수식 평가기의 범위 입력) ──────────────────────────────────────

// 시트 이름은 따옴표가 있을 수도(`'1차년도_250520'!`) 없을 수도(`산출근거!`) 있다.
// 한쪽만 보면 재생성 뒤 참조가 통째로 분류에서 빠져 분포가 조용히 달라진다
const SHEET_PREFIX = String.raw`(?:'[^']+'!|[^\s!+\-*/(),:'"]+!)?`;
const REF = String.raw`${SHEET_PREFIX}\$?[A-Z]{1,3}\$?\d{1,5}`;
const RANGE = String.raw`${REF}(?::${REF})?`;
const RE_SUM = new RegExp(String.raw`^SUM\(${RANGE}(?:,${RANGE})*\)$`);
const RE_REF = new RegExp(String.raw`^\+?${REF}$`);
const RE_ARITH = new RegExp(String.raw`^\(?\+?${REF}(?:[*/+\-]${REF})+\)?$`);

function classifyFormula(f) {
  if (RE_SUM.test(f)) return 'SUM';
  if (RE_REF.test(f)) return 'ref';
  if (RE_ARITH.test(f)) return 'arith';
  if (/^TRUNC\(/.test(f)) return 'TRUNC';
  if (/^ROUND\(/.test(f)) return 'ROUND';
  return 'other';
}

/**
 * 수식이 가리키는 **다른 시트 이름**을 뽑는다. 시트명을 바꾸고 수식을 안 고치면
 * (`'1차년도_250520'!G13`) 엑셀에서 전 열이 `#REF!`가 된다 — 실제로 한 번 일어났다.
 */
function referencedSheetsOf(formula) {
  const names = new Set();
  for (const m of formula.matchAll(/'([^']+)'!/g)) names.add(m[1]);
  for (const m of formula.matchAll(/(?:^|[^A-Za-z0-9_.'!])([^\s!+\-*/(),:'"]+)!/g)) names.add(m[1]);
  return [...names];
}

function formulaDistribution(wb) {
  const byKind = {};
  const crossSheet = [];
  const danglingSheets = new Set();
  const samples = {};
  const others = [];
  for (const name of wb.SheetNames) {
    const ws = wb.Sheets[name];
    for (const addr of Object.keys(ws)) {
      if (addr.startsWith('!')) continue;
      const f = ws[addr].f;
      if (!f) continue;
      const kind = classifyFormula(String(f));
      byKind[kind] = (byKind[kind] ?? 0) + 1;
      if (!samples[kind]) samples[kind] = `${name}!${addr} = ${f}`;
      if (kind === 'other') others.push(`${name}!${addr} = ${f}`);
      for (const sheet of referencedSheetsOf(String(f))) {
        crossSheet.push(`${name}!${addr} → ${sheet}`);
        if (!wb.SheetNames.includes(sheet)) danglingSheets.add(sheet);
      }
    }
  }
  return { byKind, samples, others, crossSheetCount: crossSheet.length, danglingSheets: [...danglingSheets] };
}

// ─── 산출근거 블록 감지 ─────────────────────────────────────────────────────────

const DATA_COL_START = XLSX.utils.decode_col('C');
const DATA_COL_END = XLSX.utils.decode_col('L');

function countHeaderHints(ws, r) {
  let hits = 0;
  for (let c = DATA_COL_START; c <= DATA_COL_END; c += 1) {
    const key = normalizeLabel(textAt(ws, r, c));
    if (key === '') continue;
    if (HEADER_HINTS.some((hint) => key.includes(hint))) hits += 1;
  }
  return hits;
}

/** 헤더는 세로 병합으로 여러 행에 걸친다. 그 행에서 시작하는 병합의 가장 아래 행까지가 헤더다 */
function headerRowSpan(ws, startRow) {
  let end = startRow;
  for (const m of ws['!merges'] ?? []) {
    if (m.s.r === startRow && m.e.r > end) end = m.e.r;
  }
  return end;
}

function detectDetailBlocks(ws, range, merges) {
  const rows = [];
  for (let r = range.s.r; r <= range.e.r; r += 1) rows.push(r);

  // 섹션 경계 (D-1)
  const sections = [];
  for (const r of rows) {
    const key = normalizeLabel(textAt(ws, r, DATA_COL_START));
    if (SECTION_LABELS[key]) sections.push({ row: r, kind: SECTION_LABELS[key] });
  }
  if (sections.length === 0) throw new Error('산출근거 시트에 섹션(1. 직접비 / 2. 간접비)이 없다');

  // 비목 합계 행 (D-23): `합계` 라벨 + 오른쪽 수식. 데이터가 아니라 대조 좌표다
  const categoryTotalRows = [];
  for (const r of rows) {
    for (let c = DATA_COL_START; c <= DATA_COL_END; c += 1) {
      if (normalizeLabel(textAt(ws, r, c)) !== '합계') continue;
      if (!hasFormula(ws, r, c + 1)) continue;
      categoryTotalRows.push({ row: r, labelAddr: A1(r, c), valueAddr: A1(r, c + 1) });
      break;
    }
  }

  const categoryTotalRowSet = new Set(categoryTotalRows.map((t) => t.row));

  /** C~L 어디에도 글자·수식이 없는 줄. 소계 뒤의 여백이며 데이터 슬롯이 아니다 */
  const isBlankRow = (r) => {
    for (let c = DATA_COL_START; c <= DATA_COL_END; c += 1) {
      if (textAt(ws, r, c).trim() !== '') return false;
      if (hasFormula(ws, r, c)) return false;
    }
    return true;
  };

  const blocks = [];
  const categoryTotals = [];
  const excluded = [];

  let sectionKind = null;
  let category = null;
  let categoryLabel = null;
  let subcategory = null;
  let subcategoryLabel = null;
  let headerRows = null;
  let pendingRows = [];
  let travelHint = null;
  let lastRowWasSubtotal = false;
  let personnelSegment = 0;
  // 소계 직후의 빈 줄은 다음 블록의 슬롯이 아니다. 인건비 신규채용(89~90행)처럼
  // 헤더 없이 이어지는 두 번째 표가 있으므로 헤더를 지우는 것만으로는 갈리지 않는다
  let awaitingBlock = false;

  const flushSegment = (subtotalRow, subtotalLabel) => {
    if (!headerRows) return;
    if (pendingRows.length === 0 && subtotalRow !== null) {
      // 데이터 행 없이 이어지는 소계는 블록 소계다 (인건비 `소 계` 92행)
      const last = blocks[blocks.length - 1];
      if (last && lastRowWasSubtotal) {
        last.blockSubtotal = buildSubtotal(ws, subtotalRow, subtotalLabel, last.columns, last.amountCols);
        return;
      }
    }
    if (pendingRows.length === 0) return;
    const segment = category === 'personnel' ? (PERSONNEL_SEGMENTS[personnelSegment] ?? null) : null;
    if (category === 'personnel') personnelSegment += 1;
    const block = buildBlock(ws, merges, {
      sectionKind,
      category,
      categoryLabel,
      subcategory: travelHint ?? subcategory,
      subcategoryLabel: travelHint ? travelLabelOf(ws, pendingRows) : subcategoryLabel,
      segment,
      headerRows,
      dataRows: pendingRows,
      subtotalRow,
      subtotalLabel,
      excluded,
    });
    blocks.push(block);
    pendingRows = [];
    travelHint = null;
  };

  for (const r of rows) {
    const label = textAt(ws, r, DATA_COL_START);
    const key = normalizeLabel(label);

    if (SECTION_LABELS[key]) {
      flushSegment(null, null);
      sectionKind = SECTION_LABELS[key];
      category = sectionKind === 'indirect' ? 'indirect' : null;
      categoryLabel = sectionKind === 'indirect' ? label.trim() : null;
      subcategory = null;
      subcategoryLabel = null;
      headerRows = null;
      lastRowWasSubtotal = false;
      awaitingBlock = false;
      continue;
    }
    if (sectionKind === null) continue;

    const strippedKey = key.replace(/^[-–—]/, '');
    if (sectionKind === 'direct' && CATEGORY_LABELS[strippedKey]) {
      flushSegment(null, null);
      category = CATEGORY_LABELS[strippedKey];
      categoryLabel = label.trim();
      subcategory = null;
      subcategoryLabel = null;
      headerRows = null;
      lastRowWasSubtotal = false;
      awaitingBlock = false;
      personnelSegment = 0;
      continue;
    }
    if (sectionKind === 'indirect' && INDIRECT_SUBCATEGORY_LABELS[key]) {
      flushSegment(null, null);
      subcategory = INDIRECT_SUBCATEGORY_LABELS[key];
      subcategoryLabel = label.trim();
      headerRows = null;
      lastRowWasSubtotal = false;
      awaitingBlock = false;
      continue;
    }
    if (category && SUBCATEGORY_LABELS[category] && key in SUBCATEGORY_LABELS[category]) {
      flushSegment(null, null);
      subcategory = SUBCATEGORY_LABELS[category][key];
      subcategoryLabel = label.trim();
      headerRows = null;
      lastRowWasSubtotal = false;
      awaitingBlock = false;
      continue;
    }

    // D-23: 비목 합계 줄(`K96="합계"`)은 데이터가 아니라 대조 좌표다. **비목 헤더 판정 뒤에**
    // 걸러야 한다 — 실측에서 그 줄이 비목 헤더와 같은 행이라 먼저 거르면 비목이 통째로 사라진다
    if (categoryTotalRowSet.has(r)) continue;

    if (SUBTOTAL_LABELS.has(key)) {
      flushSegment(r, label.trim());
      lastRowWasSubtotal = true;
      awaitingBlock = true;
      continue;
    }

    if (countHeaderHints(ws, r) >= HEADER_HINT_MIN) {
      flushSegment(null, null);
      const end = headerRowSpan(ws, r);
      headerRows = [];
      for (let h = r; h <= end; h += 1) headerRows.push(h);
      lastRowWasSubtotal = false;
      awaitingBlock = false;
      continue;
    }
    if (headerRows && headerRows.includes(r)) continue;

    if (headerRows) {
      if (awaitingBlock) {
        if (isBlankRow(r)) continue;
        awaitingBlock = false;
      }
      if (TRAVEL_LABELS[key]) travelHint = TRAVEL_LABELS[key];
      pendingRows.push(r);
      lastRowWasSubtotal = false;
    }
  }
  flushSegment(null, null);

  // 비목 합계 행을 가장 가까운 비목 헤더에 귀속시킨다 (D-23)
  for (const total of categoryTotalRows) {
    const owner = nearestCategory(blocks, total.row);
    if (!owner) continue;
    categoryTotals.push({
      category: owner,
      row: total.row + 1,
      labelAddr: total.labelAddr,
      valueAddr: total.valueAddr,
    });
  }

  return { sections, blocks, categoryTotals, excluded };
}

function travelLabelOf(ws, dataRows) {
  for (const r of dataRows) {
    const key = normalizeLabel(textAt(ws, r, DATA_COL_START));
    if (TRAVEL_LABELS[key]) return textAt(ws, r, DATA_COL_START).trim();
  }
  return '';
}

function nearestCategory(blocks, row) {
  let best = null;
  let bestDist = Infinity;
  for (const block of blocks) {
    const dist = Math.min(Math.abs(block.dataStartRow - 1 - row), Math.abs(block.dataEndRow - 1 - row));
    if (dist < bestDist) {
      bestDist = dist;
      best = block.category;
    }
  }
  return best;
}

/** 금액 열의 세로 병합이 슬롯을 정한다 (D-25: `C186:C187`은 한 줄이다) */
function slotRowsOf(merges, dataRows, amountCols) {
  const slots = [];
  for (const r of dataRows) {
    const inside = amountCols.some((c) => {
      const m = merges.byCell.get(A1(r, c));
      return m && m.s.r < r;
    });
    if (!inside) slots.push(r);
  }
  return slots;
}

function buildSubtotal(ws, row, label, columns, amountCols) {
  const pick = (role) => {
    const found = columns.find((col) => col.role === role);
    return found ? found.column : null;
  };
  const addrOf = (column) => {
    if (!column) return null;
    const c = XLSX.utils.decode_col(column);
    return A1(row, c);
  };
  // 소계는 데이터 대상이 아니다. 금액 열이 role 맵에서 빠졌어도(수식이라 제외됨) 좌표는 남긴다
  const amountColumns = amountCols.map((c) => COL(c));
  return {
    label,
    row: row + 1,
    cash: addrOf(pick('cashTotal') ?? amountColumns[0] ?? null),
    inKind: addrOf(pick('inKindTotal') ?? amountColumns[1] ?? null),
    total: addrOf(pick('total') ?? amountColumns[amountColumns.length - 1] ?? null),
  };
}

function buildBlock(ws, merges, spec) {
  const { headerRows, dataRows, excluded } = spec;

  // 1) 헤더 텍스트 → role
  const candidates = [];
  for (let c = DATA_COL_START; c <= DATA_COL_END; c += 1) {
    const texts = headerRows.map((r) => textAt(ws, r, c));
    const role = resolveRole(texts);
    if (!role) continue;
    candidates.push({ column: COL(c), col: c, role, label: texts.filter((t) => t !== '').join(' ').trim() });
  }

  // 2) 금액 열(= 슬롯 판정 기준). role이 붙지 않아도 헤더에 `합계/총액`이 있으면 금액 열이다
  const amountCols = candidates
    .filter((x) => x.role === 'cashTotal' || x.role === 'inKindTotal' || x.role === 'total')
    .map((x) => x.col);

  const slotRows = slotRowsOf(merges, dataRows, amountCols.length > 0 ? amountCols : [DATA_COL_END]);

  // 3) 데이터 대상 후보를 거른다 — 병합 안쪽은 쓸 수 없고, 금액이 아닌 수식 열은 서식의 몫이다
  const claimed = new Set();
  const columns = [];
  for (const cand of candidates) {
    if (!MULTI_COLUMN_ROLES.has(cand.role) && claimed.has(cand.role)) {
      excluded.push({ block: blockKeyOf(spec), column: cand.column, role: cand.role, reason: 'duplicate-role' });
      continue;
    }
    // X-4: 금액 열은 수식이어도 대상이다. 금액이 아닌 파생 열(월액 `F/12` 등)은 서식이 계산한다
    const formulaRows = AMOUNT_ROLES.has(cand.role)
      ? []
      : slotRows.filter((r) => hasFormula(ws, r, cand.col));
    if (formulaRows.length > 0) {
      excluded.push({
        block: blockKeyOf(spec),
        column: cand.column,
        role: cand.role,
        reason: 'formula',
        rows: formulaRows.map((r) => r + 1),
      });
      continue;
    }
    const mergedRows = slotRows.filter((r) => {
      const m = merges.byCell.get(A1(r, cand.col));
      return m && !(m.s.r === r && m.s.c === cand.col);
    });
    if (mergedRows.length > 0) {
      excluded.push({
        block: blockKeyOf(spec),
        column: cand.column,
        role: cand.role,
        reason: 'merge-interior',
        rows: mergedRows.map((r) => r + 1),
      });
      continue;
    }
    claimed.add(cand.role);
    columns.push({
      column: cand.column,
      role: cand.role,
      label: cand.label,
      percentFormat: slotRows.length > 0 && slotRows.every((r) => isPercentFormat(ws, r, cand.col)),
      // 이 템플릿에 실제로 수식이 있는지가 아니라 **역할**로 정한다 — 같은 열의 어떤 행은 수식이고
      // 어떤 행은 아니다(실측 `I99`·`I100`은 수식, `I101`은 빈칸). 열 단위의 안정된 사실은 역할뿐이다
      overwritesFormula: AMOUNT_ROLES.has(cand.role),
    });
  }

  const block = {
    key: blockKeyOf(spec),
    category: spec.category,
    subcategory: spec.subcategory,
    segment: spec.segment ?? null,
    label: spec.subcategoryLabel || spec.categoryLabel || '',
    categoryLabel: spec.categoryLabel ?? '',
    headerRows: headerRows.map((r) => r + 1),
    dataStartRow: dataRows[0] + 1,
    dataEndRow: dataRows[dataRows.length - 1] + 1,
    slotRows: slotRows.map((r) => r + 1),
    slotCount: slotRows.length,
    columns,
    subtotals: [],
    blockSubtotal: null,
  };
  block.amountCols = amountCols;
  if (spec.subtotalRow !== null && spec.subtotalRow !== undefined) {
    block.subtotals.push(buildSubtotal(ws, spec.subtotalRow, spec.subtotalLabel, columns, amountCols));
  }
  return block;
}

function blockKeyOf(spec) {
  const sub = spec.subcategory ?? 'null';
  return spec.segment ? `${spec.category}/${sub}#${spec.segment}` : `${spec.category}/${sub}`;
}

// ─── 총괄표 ─────────────────────────────────────────────────────────────────────

// 총괄표 행 라벨 → (비목, 세목, 축). 라벨이 서식의 것이므로 여기서 코드로 옮긴다.
// `kind`는 금액 행(`amount`)과 집계·비율 행(`aggregate`·`ratio`)을 가른다.
//
// **집계·비율 행도 값으로 쓴다** (X-10c): 총괄표의 그 셀들은 총괄표 안의 SUM이 아니라
// `총괄표!F12 = 산출근거!G21` 같은 **시트 간 참조**이고, 산출근거에는 내보내는 연차 하나만
// 들어간다(X-9) — 살려 두면 2차년도 값이 1차년도 칸에 찍힌다. 그래서 `aggregate`가
// **무엇을 계산할지**를 이름으로 말하고, 산식은 `lib/budget-plan.ts`가 갖는다 (PL-10a).
//
// `memo`는 앱에 대응 데이터가 **없는** 괄호 메모 행이다 (X-10d). §6.11 I-5·S-10이 임포트에서
// 이미 건너뛰는 행이므로 내보내기가 지어낼 수 없다 — 값을 쓰지 않고 비운 뒤 알린다.
const SUMMARY_ROWS = [
  { row: 4, category: 'personnel', subcategory: 'personnel_internal', axis: 'cash', kind: 'amount' },
  { row: 5, category: 'personnel', subcategory: 'personnel_internal', axis: 'inKind', kind: 'amount' },
  { row: 6, category: 'personnel', subcategory: 'personnel_external', axis: 'cash', kind: 'amount' },
  { row: 7, category: 'personnel', subcategory: 'personnel_external', axis: 'inKind', kind: 'amount' },
  { row: 8, category: 'personnel', subcategory: 'personnel_support', axis: 'cash', kind: 'amount' },
  { row: 9, category: 'personnel', subcategory: 'personnel_support', axis: 'inKind', kind: 'amount' },
  // 학생인건비 두 줄은 서식에 축 라벨이 없다. 지어내지 않고 null로 둔다 (D-3a와 같은 태도)
  { row: 10, category: 'student_personnel', subcategory: null, axis: null, kind: 'amount' },
  { row: 11, category: 'student_personnel', subcategory: null, axis: null, kind: 'amount' },
  { row: 12, category: null, subcategory: null, axis: null, kind: 'aggregate', aggregate: 'totalPersonnel' },
  { row: 13, category: null, subcategory: null, axis: null, kind: 'aggregate', aggregate: 'modifiedPersonnel' },
  { row: 14, category: 'facility_equipment', subcategory: null, axis: 'cash', kind: 'amount' },
  { row: 15, category: 'facility_equipment', subcategory: null, axis: 'inKind', kind: 'amount' },
  // `(연구시설‧장비비 중 통합관리비(현금))` — 부록 A.5의 세목이 아니다 (X-10d)
  { row: 16, category: null, subcategory: null, axis: null, kind: 'aggregate', memo: 'not-a-subcategory' },
  { row: 17, category: 'material', subcategory: null, axis: 'cash', kind: 'amount' },
  { row: 18, category: 'material', subcategory: null, axis: 'inKind', kind: 'amount' },
  { row: 19, category: 'activity', subcategory: null, axis: 'cash', kind: 'amount' },
  { row: 20, category: 'activity', subcategory: null, axis: 'inKind', kind: 'amount' },
  { row: 21, category: 'allowance', subcategory: null, axis: 'cash', kind: 'amount' },
  { row: 22, category: 'allowance', subcategory: null, axis: 'inKind', kind: 'amount' },
  { row: 23, category: null, subcategory: null, axis: null, kind: 'ratio', aggregate: 'allowanceRate' },
  // ⚠ 라벨은 `위탁연구개발비`인데 1차년도 열의 수식은 산출근거의 **국제공동연구개발비**를 가리킨다.
  // 어느 쪽이 옳은지는 서식 소유자만 안다 — 지어내지 않고 비목을 비워 둔다
  { row: 24, category: null, subcategory: null, axis: 'cash', kind: 'amount', conflict: 'label-formula-mismatch' },
  { row: 25, category: null, subcategory: null, axis: 'inKind', kind: 'amount', conflict: 'label-formula-mismatch' },
  // 라벨이 비어 있는 줄이다. 직접비 계(K)인 근거는 수식 사슬이다:
  // `총괄표!F26 = 산출근거!G35 = SUM(국제공동, 총 인건비 E, 시설장비, 재료, 활동, 수당)`이고
  // 30행이 `M=K+L`이면서 `산출근거!G39 = SUM(G35, G36[간접비])`이다
  { row: 26, category: null, subcategory: null, axis: null, kind: 'aggregate', aggregate: 'directTotal' },
  { row: 27, category: 'indirect', subcategory: null, axis: null, kind: 'amount' },
  { row: 28, category: null, subcategory: null, axis: null, kind: 'ratio', aggregate: 'indirectRate' },
  // `(간접비 중 연구실 안전관리비)` — 부록 A.5의 세목이 아니다 (X-10d)
  { row: 29, category: null, subcategory: null, axis: null, kind: 'aggregate', memo: 'not-a-subcategory' },
  { row: 30, category: null, subcategory: null, axis: null, kind: 'aggregate', aggregate: 'grandTotal' },
];

const SUMMARY_HEADER_ROW = 2;
const SUMMARY_YEAR_COLUMNS = ['F', 'G', 'H', 'I'];
const SUMMARY_TOTAL_COLUMN = 'J';
const SUMMARY_LABEL_COLUMNS = ['B', 'C', 'D', 'E'];

function buildSummaryLayout(ws) {
  const labelOf = (row) => {
    const parts = SUMMARY_LABEL_COLUMNS.map((col) => textAt(ws, row - 1, XLSX.utils.decode_col(col)).trim()).filter(
      (t) => t !== ''
    );
    return parts.join(' / ');
  };

  const yearColumns = SUMMARY_YEAR_COLUMNS.map((column, index) => {
    const c = XLSX.utils.decode_col(column);
    const linkedRows = SUMMARY_ROWS.filter((r) => hasFormula(ws, r.row - 1, c)).length;
    return {
      yearIndex: index + 1,
      column,
      labelCell: A1(SUMMARY_HEADER_ROW - 1, c),
      label: textAt(ws, SUMMARY_HEADER_ROW - 1, c).trim(),
      // 값이 템플릿 수식으로 이미 연결된 열은 **쓰지 않는다** (X-4)
      linked: linkedRows > 0,
    };
  });

  const rows = SUMMARY_ROWS.map((spec) => {
    const percentColumns = SUMMARY_YEAR_COLUMNS.filter((column) =>
      isPercentFormat(ws, spec.row - 1, XLSX.utils.decode_col(column))
    );
    return {
      row: spec.row,
      label: labelOf(spec.row),
      category: spec.category,
      subcategory: spec.subcategory,
      axis: spec.axis,
      kind: spec.kind,
      // X-7: 백분율 서식 셀은 100으로 나눠 쓴다. 서식은 **셀 레코드가 있는 열에서만** 알 수 있다
      percentFormat:
        percentColumns.length > 0 ||
        isPercentFormat(ws, spec.row - 1, XLSX.utils.decode_col(SUMMARY_TOTAL_COLUMN)),
      ...(spec.aggregate ? { aggregate: spec.aggregate } : {}),
      ...(spec.memo ? { memo: spec.memo } : {}),
      ...(spec.conflict ? { conflict: spec.conflict } : {}),
    };
  });

  return {
    sheet: SUMMARY_SHEET,
    headerRow: SUMMARY_HEADER_ROW,
    yearColumns,
    totalColumn: SUMMARY_TOTAL_COLUMN,
    rows,
  };
}

// ─── 실행 ───────────────────────────────────────────────────────────────────────

function main() {
  const templatePath = join(ROOT, 'templates', TEMPLATE_FILE);
  const buffer = readFileSync(templatePath);

  console.log(`## 템플릿: templates/${TEMPLATE_FILE}\n`);

  // 1) 보존 프로브
  const probe = preservationProbe(buffer);
  console.log('### 1. 보존 프로브 (read → write → read)');
  console.log(`원본   : ${JSON.stringify(probe.before)}`);
  console.log(`왕복후 : ${JSON.stringify(probe.after)}`);
  console.log(`차이   : ${JSON.stringify(probe.diffs)}`);
  const preserved =
    probe.before.styled === probe.after.styled &&
    probe.before.merges === probe.after.merges &&
    probe.before.formulas === probe.after.formulas &&
    Object.values(probe.diffs).every((n) => n === 0);
  console.log(`판정   : ${preserved ? 'PASS — X-1의 전제가 성립한다' : 'FAIL — 여기서 멈춘다'}\n`);
  if (!preserved) process.exit(1);

  const wb = XLSX.read(buffer, READ_OPTIONS);

  // 2) X-2 청결도
  const clean = cleanlinessProbe(wb);
  console.log('### 2. X-2 청결도');
  console.log(`수식이 아닌 숫자 셀 : ${clean.numericCells.length}`);
  console.log(`캐시된 계산값       : ${clean.cachedFormulaValues.length}`);
  console.log(`수식에 박힌 숫자 상수: ${clean.literalsInFormulas.length}`);
  for (const item of clean.literalsInFormulas) console.log(`  ${item.addr} = ${item.formula}`);
  console.log('');

  // 3) 수식 분포
  const dist = formulaDistribution(wb);
  console.log('### 3. 수식 분포');
  console.log(JSON.stringify(dist.byKind));
  for (const [kind, sample] of Object.entries(dist.samples)) console.log(`  ${kind}: ${sample}`);
  console.log(`시트 간 참조 ${dist.crossSheetCount}개, 존재하지 않는 시트: ${JSON.stringify(dist.danglingSheets)}`);
  if (process.argv.includes('--formulas')) for (const f of dist.others) console.log(`  other: ${f}`);
  console.log('');

  // 4) 산출근거 블록
  const detailWs = wb.Sheets[DETAIL_SHEET];
  if (!detailWs) throw new Error(`시트 ${DETAIL_SHEET}이 없다`);
  const detailRange = XLSX.utils.decode_range(detailWs['!ref']);
  const detailMerges = mergeIndex(detailWs);
  const detected = detectDetailBlocks(detailWs, detailRange, detailMerges);

  console.log('### 4. 산출근거 블록');
  console.log(`섹션: ${detected.sections.map((s) => `${s.kind}@${s.row + 1}`).join(', ')}`);
  console.log(`블록 ${detected.blocks.length}개\n`);
  for (const block of detected.blocks) {
    const subs = [...block.subtotals, ...(block.blockSubtotal ? [block.blockSubtotal] : [])]
      .map((s) => `${s.label}@${s.row}`)
      .join(' → ');
    console.log(
      `${block.key.padEnd(38)} 헤더 ${block.headerRows.join(',')} · 데이터 ${block.dataStartRow}~${block.dataEndRow}` +
        ` · 슬롯 ${block.slotCount} · 소계 ${subs || '-'}`
    );
    console.log(
      `  대상 열: ${block.columns
        .map((c) => `${c.column}=${c.role}${c.percentFormat ? '(%)' : ''}`)
        .join(' ') || '(없음)'}`
    );
  }
  console.log('\n제외된 열 (데이터 대상이 될 수 없다):');
  for (const ex of detected.excluded) {
    console.log(`  ${ex.block.padEnd(38)} ${ex.column}=${ex.role} — ${ex.reason}${ex.rows ? ` @${ex.rows.join(',')}` : ''}`);
  }
  console.log('\n비목 합계 행 (D-23, 대조용):');
  for (const total of detected.categoryTotals) {
    console.log(`  ${String(total.category).padEnd(20)} ${total.labelAddr} → ${total.valueAddr}`);
  }

  // 5) 총괄표
  const summaryWs = wb.Sheets[SUMMARY_SHEET];
  if (!summaryWs) throw new Error(`시트 ${SUMMARY_SHEET}이 없다`);
  const summary = buildSummaryLayout(summaryWs);
  console.log('\n### 5. 총괄표');
  console.log(
    `연차 열: ${summary.yearColumns.map((y) => `${y.column}=${y.label}${y.linked ? '(수식연결)' : '(빈칸)'}`).join(' ')}`
  );
  const summaryRange = XLSX.utils.decode_range(summaryWs['!ref']);
  for (const row of summary.rows) {
    const missing = SUMMARY_YEAR_COLUMNS.filter((col) => !summaryWs[`${col}${row.row}`]).join(',');
    console.log(
      `  ${String(row.row).padStart(2)} ${row.kind.padEnd(9)} ${String(row.aggregate ?? row.memo ?? row.category ?? '-').padEnd(18)}` +
        ` ${String(row.axis ?? '-').padEnd(7)} ${row.percentFormat ? '%' : ' '} 셀없음:${missing || '-'} | ${row.label}`
    );
  }
  console.log(`시트 범위: ${summaryWs['!ref']} (${XLSX.utils.encode_range(summaryRange)})`);

  // 6) 맵 JSON
  const layout = {
    templateId: TEMPLATE_ID,
    templateFile: TEMPLATE_FILE,
    detail: {
      sheet: DETAIL_SHEET,
      blocks: detected.blocks.map((block) => ({
        key: block.key,
        category: block.category,
        subcategory: block.subcategory,
        segment: block.segment,
        label: block.label,
        headerRows: block.headerRows,
        dataStartRow: block.dataStartRow,
        dataEndRow: block.dataEndRow,
        slotRows: block.slotRows,
        slotCount: block.slotCount,
        columns: block.columns,
        subtotals: [...block.subtotals, ...(block.blockSubtotal ? [block.blockSubtotal] : [])],
      })),
      categoryTotals: detected.categoryTotals,
    },
    summary,
  };

  if (process.argv.includes('--write')) {
    const target = join(ROOT, 'templates', MAP_FILE);
    writeFileSync(target, `${JSON.stringify(layout, null, 2)}\n`, 'utf8');
    console.log(`\n맵을 썼다: templates/${MAP_FILE}`);
  } else {
    console.log('\n(--write 를 주면 맵 JSON을 templates/에 쓴다)');
  }
}

main();
