// 셀 좌표 맵 로드 · 검증 (SOT §6.12.1 X-3, §6.12.2 X-4·X-7).
//
// **맵은 코드가 아니라 데이터다** (X-3): `templates/*.map.json`이 원본이고 여기는 그것을 읽어
// 형태를 확인하는 층이다. 부처가 늘면 템플릿 파일과 맵 파일을 추가할 뿐 이 파일은 바뀌지 않는다.
//
// SheetJS를 import하지 않는다 (§6.12.4). 워크북의 사실은 어댑터가 `TemplateSheetInfo`로 넘긴다.

import { z } from 'zod';
import { DETAIL_COLUMN_ROLES } from '@/lib/import';
import standardDetailMap from '@/templates/산출근거_표준.map.json';
import type {
  LayoutViolation,
  TemplateBlock,
  TemplateLayout,
  TemplateMergeRange,
  TemplateSheetInfo,
  TemplateSummaryRow,
} from './types';

// ─── A1 좌표 (xlsx 없이) ─────────────────────────────────────

const A1_PATTERN = /^([A-Z]{1,3})(\d{1,7})$/;

/** 열 문자 → 0-based 인덱스. `'A'` → 0, `'AA'` → 26 */
export function columnIndex(column: string): number {
  let index = 0;
  for (const ch of column) index = index * 26 + (ch.charCodeAt(0) - 64);
  return index - 1;
}

/** 0-based 인덱스 → 열 문자 */
export function columnLetter(index: number): string {
  let rest = index + 1;
  let out = '';
  while (rest > 0) {
    const rem = (rest - 1) % 26;
    out = String.fromCharCode(65 + rem) + out;
    rest = Math.floor((rest - rem) / 26);
  }
  return out;
}

/** `'F65'` → `{ r: 64, c: 5 }` (0-based). 형식이 아니면 null */
export function decodeAddr(addr: string): { r: number; c: number } | null {
  const m = A1_PATTERN.exec(addr);
  if (!m) return null;
  return { r: Number(m[2]) - 1, c: columnIndex(m[1] as string) };
}

/** 열 문자 + 1-based 행 → A1 */
export function encodeAddr(column: string, row: number): string {
  return `${column}${row}`;
}

// ─── Zod 스키마 ──────────────────────────────────────────────
//
// 맵은 손이 아니라 `scripts/inspect-template.mjs`가 만들지만, 그렇다고 검증을 건너뛰지 않는다 —
// 템플릿이 바뀌면 맵도 바뀌고, 형태가 깨진 맵은 런타임에 조용히 빈 좌표를 만든다.

const BUDGET_CATEGORIES = [
  'personnel',
  'student_personnel',
  'facility_equipment',
  'material',
  'consignment',
  'international',
  'burden',
  'activity',
  'promotion',
  'allowance',
  'indirect',
  'other',
] as const;

const columnLetterSchema = z.string().regex(/^[A-Z]{1,3}$/, '열 문자여야 한다');
const addrSchema = z.string().regex(A1_PATTERN, 'A1 주소여야 한다');
const rowSchema = z.number().int().positive();

const templateColumnSchema = z.object({
  column: columnLetterSchema,
  role: z.enum(DETAIL_COLUMN_ROLES),
  label: z.string(),
  percentFormat: z.boolean(),
  overwritesFormula: z.boolean(),
});

const templateSubtotalSchema = z.object({
  label: z.string(),
  row: rowSchema,
  cash: addrSchema.nullable(),
  inKind: addrSchema.nullable(),
  total: addrSchema.nullable(),
});

const templateBlockSchema = z
  .object({
    key: z.string().min(1),
    category: z.enum(BUDGET_CATEGORIES),
    subcategory: z.string().nullable(),
    segment: z.enum(['existing', 'newHire']).nullable(),
    label: z.string(),
    headerRows: z.array(rowSchema).min(1),
    dataStartRow: rowSchema,
    dataEndRow: rowSchema,
    slotRows: z.array(rowSchema).min(1),
    slotCount: z.number().int().nonnegative(),
    columns: z.array(templateColumnSchema),
    subtotals: z.array(templateSubtotalSchema),
  })
  .refine((b) => b.slotCount === b.slotRows.length, 'slotCount가 slotRows 길이와 다르다')
  .refine((b) => b.dataStartRow <= b.dataEndRow, '데이터 행 범위가 뒤집혔다')
  .refine(
    (b) => b.slotRows.every((r) => r >= b.dataStartRow && r <= b.dataEndRow),
    '슬롯 행이 데이터 행 범위 밖이다'
  );

const templateLayoutSchema = z.object({
  templateId: z.string().min(1),
  templateFile: z.string().min(1),
  detail: z.object({
    sheet: z.string().min(1),
    blocks: z.array(templateBlockSchema).min(1),
    categoryTotals: z.array(
      z.object({
        category: z.enum(BUDGET_CATEGORIES),
        row: rowSchema,
        labelAddr: addrSchema,
        valueAddr: addrSchema,
      })
    ),
  }),
  summary: z.object({
    sheet: z.string().min(1),
    headerRow: rowSchema,
    yearColumns: z
      .array(
        z.object({
          yearIndex: z.number().int().positive(),
          column: columnLetterSchema,
          labelCell: addrSchema,
          label: z.string(),
          linked: z.boolean(),
        })
      )
      .min(1),
    totalColumn: columnLetterSchema,
    rows: z
      .array(
        z.object({
          row: rowSchema,
          label: z.string(),
          category: z.enum(BUDGET_CATEGORIES).nullable(),
          subcategory: z.string().nullable(),
          axis: z.enum(['cash', 'inKind']).nullable(),
          kind: z.enum(['amount', 'aggregate', 'ratio']),
          percentFormat: z.boolean(),
          aggregate: z
            .enum([
              'totalPersonnel',
              'modifiedPersonnel',
              'allowanceRate',
              'indirectRate',
              'directTotal',
              'grandTotal',
            ])
            .optional(),
          memo: z.string().optional(),
          conflict: z.string().optional(),
        })
      )
      .min(1),
  }),
});

/**
 * 맵 JSON을 `TemplateLayout`으로. **형태가 깨졌으면 던진다** — 빈 맵으로 계속 가면
 * 내보내기가 좌표를 하나도 못 찾고도 "성공"으로 끝난다 (에러 무음 처리 금지).
 */
export function parseLayout(raw: unknown): TemplateLayout {
  return templateLayoutSchema.parse(raw);
}

// ─── 검증 (맵 × 파일) ────────────────────────────────────────

function isMergeInterior(merges: readonly TemplateMergeRange[], r: number, c: number): boolean {
  for (const m of merges) {
    if (r < m.s.r || r > m.e.r || c < m.s.c || c > m.e.c) continue;
    if (m.s.r === r && m.s.c === c) continue; // 시작 셀은 쓸 수 있다
    return true;
  }
  return false;
}

function inRange(range: TemplateMergeRange, r: number, c: number): boolean {
  return r >= range.s.r && r <= range.e.r && c >= range.s.c && c <= range.e.c;
}

interface CoordCheck {
  addr: string;
  path: string;
  /** true면 앱이 값을 쓰는 좌표다. false면 소계·합계처럼 읽기만 하는 좌표다 */
  isDataTarget: boolean;
}

/**
 * @param aggregated 템플릿이 스스로 굴리는 셀(소계·합계·비율) 주소. 데이터 대상이 여기 닿으면 X-4a 위반이다.
 *   **파일의 수식 목록이 아니다** — 행 금액 열도 수식이지만 그쪽은 X-4대로 덮어쓰는 것이 정상이다.
 */
function checkCoords(
  sheet: TemplateSheetInfo,
  coords: readonly CoordCheck[],
  aggregated: ReadonlySet<string>
): LayoutViolation[] {
  const violations: LayoutViolation[] = [];
  for (const coord of coords) {
    const pos = decodeAddr(coord.addr);
    if (!pos || !inRange(sheet.range, pos.r, pos.c)) {
      violations.push({
        kind: 'missing-cell',
        sheet: sheet.name,
        addr: coord.addr,
        path: coord.path,
        detail: `${sheet.name}!${coord.addr}은 시트 사용 범위 밖이다`,
      });
      continue;
    }
    if (isMergeInterior(sheet.merges, pos.r, pos.c)) {
      violations.push({
        kind: 'merge-interior',
        sheet: sheet.name,
        addr: coord.addr,
        path: coord.path,
        detail: `${sheet.name}!${coord.addr}은 병합 범위 안쪽이다 — 여기 쓰면 값이 보이지 않는다`,
      });
      continue;
    }
    if (coord.isDataTarget && aggregated.has(coord.addr)) {
      violations.push({
        kind: 'formula-target',
        sheet: sheet.name,
        addr: coord.addr,
        path: coord.path,
        detail:
          `${sheet.name}!${coord.addr}은 소계·합계·비율 셀이다 — 여기 값을 박으면 ` +
          `엑셀 재계산 값과 앱 값의 대조가 사라진다 (X-4a)`,
      });
    }
  }
  return violations;
}

function blockCoords(block: TemplateBlock): CoordCheck[] {
  const coords: CoordCheck[] = [];
  for (const column of block.columns) {
    for (const row of block.slotRows) {
      coords.push({
        addr: encodeAddr(column.column, row),
        path: `detail.blocks[${block.key}].columns.${column.column}`,
        isDataTarget: true,
      });
    }
  }
  for (const subtotal of block.subtotals) {
    for (const addr of [subtotal.cash, subtotal.inKind, subtotal.total]) {
      if (addr === null) continue;
      coords.push({
        addr,
        path: `detail.blocks[${block.key}].subtotals[${subtotal.row}]`,
        // 소계는 템플릿의 SUM이 계산한다 (X-4a). 읽기 좌표이지 데이터 대상이 아니다
        isDataTarget: false,
      });
    }
  }
  return coords;
}

/**
 * 맵이 이 템플릿 파일과 맞는가. **위반을 전부 모아 돌려준다** — 첫 건에서 멈추면
 * 템플릿을 한 번 고칠 때마다 같은 왕복을 반복하게 된다.
 *
 * 잡는 것:
 * 1. 없는 시트 / 사용 범위 밖 셀
 * 2. 병합 범위 **안쪽** 좌표 (쓰면 값이 안 보인다)
 * 3. 소계·합계·비율 셀을 데이터 대상으로 지정 (X-4a)
 * 4. 워크북에 없는 시트를 가리키는 수식 (열면 `#REF!`)
 * 5. 비목을 정할 수 없는 총괄표 행에 `conflict`가 비어 있음 (X-10b)
 *
 * **3번이 파일의 수식 목록을 보지 않는다**: 행 금액 열은 수식이지만 X-4대로 앱 값으로 덮어쓰는
 * 것이 정상이므로, 위반의 기준은 "수식인가"가 아니라 **"맵이 집계 좌표로 선언한 셀인가"**다.
 *
 * 4번은 맵의 잘못이 아니라 **템플릿 파일의 잘못**이지만 여기서 잡는다 — 시트명을 바꾸고 수식을
 * 안 고치는 실수가 실제로 일어났고, 부처 템플릿이 늘면 반복될 자리다. 맵과 파일이 만나는
 * 지점이 여기 하나뿐이라 다른 곳에 두면 검사가 호출되지 않은 채 남는다.
 */
export function validateLayout(
  layout: TemplateLayout,
  sheetInfos: readonly TemplateSheetInfo[]
): LayoutViolation[] {
  const violations: LayoutViolation[] = [];
  const bySheet = new Map(sheetInfos.map((info) => [info.name, info]));
  const sheetNames = new Set(sheetInfos.map((info) => info.name));

  // 4) 워크북 전체: 없는 시트를 가리키는 수식
  for (const info of sheetInfos) {
    for (const referenced of info.referencedSheets) {
      if (sheetNames.has(referenced)) continue;
      violations.push({
        kind: 'dangling-sheet-ref',
        sheet: info.name,
        path: `template.${info.name}`,
        detail: `${info.name}의 수식이 없는 시트 '${referenced}'을 가리킨다 — 열면 #REF!가 된다`,
      });
    }
  }

  const detailInfo = bySheet.get(layout.detail.sheet);
  if (!detailInfo) {
    violations.push({
      kind: 'missing-sheet',
      sheet: layout.detail.sheet,
      path: 'detail.sheet',
      detail: `워크북에 시트 '${layout.detail.sheet}'이 없다`,
    });
  } else {
    const coords: CoordCheck[] = [];
    for (const block of layout.detail.blocks) coords.push(...blockCoords(block));
    for (const total of layout.detail.categoryTotals) {
      coords.push(
        { addr: total.labelAddr, path: `detail.categoryTotals[${total.category}].label`, isDataTarget: false },
        { addr: total.valueAddr, path: `detail.categoryTotals[${total.category}].value`, isDataTarget: false }
      );
    }
    violations.push(...checkCoords(detailInfo, coords, detailAggregatedCells(layout)));
  }

  const summaryInfo = bySheet.get(layout.summary.sheet);
  if (!summaryInfo) {
    violations.push({
      kind: 'missing-sheet',
      sheet: layout.summary.sheet,
      path: 'summary.sheet',
      detail: `워크북에 시트 '${layout.summary.sheet}'이 없다`,
    });
  } else {
    const coords: CoordCheck[] = [];
    for (const year of layout.summary.yearColumns) {
      coords.push({
        addr: year.labelCell,
        path: `summary.yearColumns[${year.yearIndex}].labelCell`,
        isDataTarget: false,
      });
      for (const row of layout.summary.rows) {
        coords.push({
          addr: encodeAddr(year.column, row.row),
          path: `summary.yearColumns[${year.yearIndex}] × rows[${row.row}]`,
          // X-10a·X-10c: `linked` 열도, 집계·비율 행도 값으로 쓴다.
          // 값이 나가지 않는 것은 모순 행(X-10b)과 메모 행(X-10d)뿐이고 그쪽은 빈 칸이 나간다
          isDataTarget: isSummaryDataTarget(row),
        });
      }
    }
    for (const row of layout.summary.rows) {
      coords.push({
        addr: encodeAddr(layout.summary.totalColumn, row.row),
        path: `summary.totalColumn × rows[${row.row}]`,
        isDataTarget: false,
      });
    }
    violations.push(...checkCoords(summaryInfo, coords, summaryAggregatedCells(layout)));
    violations.push(...checkSummaryConflicts(layout));
  }

  return violations;
}

// ─── 집계 좌표 · 총괄표 모순 (X-4a · X-10b) ──────────────────

/** 템플릿의 SUM이 굴리는 산출근거 좌표 — 소계와 비목 합계 (X-4a) */
function detailAggregatedCells(layout: TemplateLayout): Set<string> {
  const addrs = new Set<string>();
  for (const block of layout.detail.blocks) {
    for (const subtotal of block.subtotals) {
      for (const addr of [subtotal.cash, subtotal.inKind, subtotal.total]) {
        if (addr !== null) addrs.add(addr);
      }
    }
  }
  for (const total of layout.detail.categoryTotals) addrs.add(total.valueAddr);
  return addrs;
}

/**
 * 템플릿이 스스로 굴리는 총괄표 좌표 — **연차 합계 열뿐이다** (X-4a).
 *
 * 집계·비율 행의 연차 칸은 여기 들어오지 않는다 (X-10c): 그 셀들은 총괄표 안의 SUM이 아니라
 * `총괄표!F12 = 산출근거!G21` 같은 시트 간 참조라 살려 두면 2차년도 값이 1차년도 칸에 찍힌다.
 * 앱이 값으로 덮어쓰는 자리이므로 "여기 쓰면 위반"이라고 표시하면 안 된다.
 */
function summaryAggregatedCells(layout: TemplateLayout): Set<string> {
  const addrs = new Set<string>();
  for (const row of layout.summary.rows) addrs.add(encodeAddr(layout.summary.totalColumn, row.row));
  return addrs;
}

/**
 * X-10a·X-10b·X-10c: 총괄표 연차 열에 **값을** 쓰는 행인가.
 *
 * 금액 행은 비목을 알 때, 집계·비율 행은 무엇을 계산할지(`aggregate`)를 알 때 값이 나간다.
 * `category`가 null인 금액 행은 어느 비목인지 알 수 없어 채울 값이 없다 — 실측 24·25행이
 * 그렇고(`conflict`), 서식 소유자의 결정 전까지 비운 채 내보낸다. `memo` 행도 마찬가지로
 * 값이 아니라 빈 칸이 나간다 (X-10d).
 */
export function isSummaryDataTarget(row: TemplateSummaryRow): boolean {
  if (row.conflict !== undefined || row.memo !== undefined) return false;
  if (row.kind === 'amount') return row.category !== null;
  return row.aggregate !== undefined;
}

/**
 * X-10b·X-10c: 무엇을 쓸지 정할 수 없는 행은 **그 이유를 맵에 달고 있어야 한다.**
 *
 * - 금액 행: 비목이 null이면 `conflict`
 * - 집계·비율 행: `aggregate`(무엇을 계산할까) 아니면 `memo`(왜 비우는가)
 *
 * 표시를 지우면 그 행은 검증도 통과하고 값도 안 들어가는 **말없이 빈 줄**이 된다 — 사용자는
 * 빠진 줄이 있다는 것조차 모른다. 라벨과 수식이 어긋나는 서식은 앞으로도 나올 것이므로 특정
 * 행 번호가 아니라 "정할 수 없는데 이유가 없다"는 형태로 잡는다.
 */
function checkSummaryConflicts(layout: TemplateLayout): LayoutViolation[] {
  const violations: LayoutViolation[] = [];
  for (const row of layout.summary.rows) {
    const unresolved =
      row.kind === 'amount'
        ? row.category === null && row.conflict === undefined
        : row.aggregate === undefined && row.memo === undefined;
    if (!unresolved) continue;
    violations.push({
      kind: 'unresolved-summary-row',
      sheet: layout.summary.sheet,
      path: `summary.rows[${row.row}]`,
      detail:
        row.kind === 'amount'
          ? `총괄표 ${row.row}행('${row.label}')은 비목을 정할 수 없는데 conflict가 비어 있다 — ` +
            `그대로 두면 아무 값도 안 들어간 채 사용자에게 알리지도 못한다 (X-10b)`
          : `총괄표 ${row.row}행('${row.label}')은 집계·비율 행인데 aggregate도 memo도 없다 — ` +
            `무엇을 계산할지도, 왜 비우는지도 알 수 없다 (X-10c)`,
    });
  }
  return violations;
}

// ─── 템플릿 레지스트리 (X-3: 부처가 늘면 여기에 한 줄) ───────

export interface TemplateRegistryEntry {
  templateId: string;
  /** `templates/` 아래의 파일명 */
  file: string;
  layout: TemplateLayout;
}

const STANDARD_DETAIL = parseLayout(standardDetailMap);

/**
 * X-3: 부처가 늘면 **템플릿 파일과 맵 파일을 추가**하고 여기 한 줄을 넣는다.
 * 스키마도 코드도 바뀌지 않는다 — 부록 C(비목 별칭)와 같은 구조다.
 */
export const TEMPLATE_REGISTRY: readonly TemplateRegistryEntry[] = [
  { templateId: STANDARD_DETAIL.templateId, file: STANDARD_DETAIL.templateFile, layout: STANDARD_DETAIL },
];

export const DEFAULT_TEMPLATE_ID = STANDARD_DETAIL.templateId;

/** 모르는 templateId는 **거부한다** — 기본값으로 되돌리면 엉뚱한 서식으로 제출된다 */
export function findTemplate(templateId: string): TemplateRegistryEntry | null {
  return TEMPLATE_REGISTRY.find((entry) => entry.templateId === templateId) ?? null;
}
