// SheetJS 어댑터 — 제출 서식 템플릿을 열고, 값을 쓰고, 파일 바이트로 되돌린다 (SOT §6.12).
//
// `lib/import-adapter.ts`와 대칭이고 이유도 같다. `lib/export/`는 "어느 값을 어느 셀에 쓸까"만
// 다루는 SheetJS 무의존 층이므로(§6.12.4), 워크북을 실제로 여닫는 일은 전부 여기 모인다.
// `actions/`에 두지 않는 이유도 같다 — 'use server' 파일의 export는 전부 서버 액션이어야 해서
// 순수 변환 함수(applyWrites·writeWorkbookBuffer)를 export할 수 없다.
//
// I-13: `import 'server-only'`로 클라이언트 번들 유입을 컴파일 타임에 막는다.
import 'server-only';

import fs from 'node:fs';
import path from 'node:path';
import * as XLSX from 'xlsx';
import type { CellWrite, TemplateMergeRange, TemplateSheetInfo } from '@/lib/export/types';

// ─── 템플릿 파일 위치 (X-3) ───────────────────────────────────────────────────

/**
 * 템플릿은 저장소에 커밋되는 파일이다(X-2의 `.gitignore` 예외). standalone 빌드에서도
 * 서버 루트 아래 같은 경로에 놓이므로 cwd 기준으로 찾는다 —
 * `next.config.ts`의 `outputFileTracingIncludes`가 이 디렉터리를 산출물에 넣는다.
 */
export const TEMPLATES_DIR = path.join(process.cwd(), 'templates');

export function templatePath(file: string): string {
  // 파일명은 맵(TEMPLATE_REGISTRY)에서 온 값이지만 경로 조각이 섞이면 디렉터리를 벗어난다
  return path.join(TEMPLATES_DIR, path.basename(file));
}

/**
 * `templates/*.xlsx` 목록. **없으면 빈 배열이 아니라 던진다** — 템플릿이 하나도 없다는 것은
 * 배포 산출물에서 디렉터리가 빠졌다는 뜻이고, 빈 목록으로 계속 가면 화면이 "내보낼 서식이
 * 없습니다"라고만 말해 진짜 원인(빌드 설정)을 영영 못 찾는다 (절대 규칙 5).
 */
export function listTemplateFiles(): string[] {
  let entries: string[];
  try {
    entries = fs.readdirSync(TEMPLATES_DIR);
  } catch (e) {
    console.error('[export-adapter] 템플릿 디렉터리를 읽지 못했습니다:', e);
    throw new Error(`제출 서식 템플릿 폴더를 찾을 수 없습니다 (${TEMPLATES_DIR}).`);
  }
  const files = entries.filter((name) => name.toLowerCase().endsWith('.xlsx')).sort();
  if (files.length === 0) {
    throw new Error(`제출 서식 템플릿(.xlsx)이 하나도 없습니다 (${TEMPLATES_DIR}).`);
  }
  return files;
}

// ─── 읽기 ─────────────────────────────────────────────────────────────────────

export interface TemplateWorkbook {
  workbook: XLSX.WorkBook;
  /** `validateLayout`에 그대로 넘길 수 있는 시트별 사실 */
  sheets: TemplateSheetInfo[];
}

/**
 * 수식이 가리키는 **다른 시트** 이름. 따옴표가 있을 수도(`'1차년도_250520'!G13`) 없을 수도 있다.
 *
 * `validateLayout`의 `dangling-sheet-ref` 검사가 이 목록에 걸려 있다 — 템플릿 시트명을 바꾸고
 * 수식을 안 고치면 열자마자 그 열 전체가 `#REF!`가 된다 (실제로 한 번 일어났다).
 */
function referencedSheetsOf(formula: string): string[] {
  const names = new Set<string>();
  for (const m of formula.matchAll(/'([^']+)'!/g)) names.add(m[1] as string);
  for (const m of formula.matchAll(/(?:^|[^A-Za-z0-9_.'!])([^\s!+\-*/(),:'"]+)!/g)) {
    names.add(m[1] as string);
  }
  return [...names];
}

function toMergeRange(m: XLSX.Range): TemplateMergeRange {
  return { s: { r: m.s.r, c: m.s.c }, e: { r: m.e.r, c: m.e.c } };
}

function toSheetInfo(name: string, sheet: XLSX.WorkSheet | undefined): TemplateSheetInfo {
  const ref = sheet?.['!ref'];
  // `!ref`가 없는 시트는 셀이 하나도 없다는 뜻이다. A1:A1로 두면 맵이 그 시트를 가리킬 때
  // missing-cell로 잡힌다 — 빈 시트를 조용히 통과시키지 않는다
  const decoded = XLSX.utils.decode_range(typeof ref === 'string' && ref !== '' ? ref : 'A1:A1');

  const presentCells: string[] = [];
  const formulaCells: string[] = [];
  const referenced = new Set<string>();
  for (const addr of Object.keys(sheet ?? {})) {
    if (addr.startsWith('!')) continue;
    presentCells.push(addr);
    const f = (sheet?.[addr] as XLSX.CellObject | undefined)?.f;
    if (typeof f === 'string') {
      formulaCells.push(addr);
      for (const referencedSheet of referencedSheetsOf(f)) referenced.add(referencedSheet);
    }
  }

  return {
    name,
    range: { s: { r: decoded.s.r, c: decoded.s.c }, e: { r: decoded.e.r, c: decoded.e.c } },
    presentCells,
    formulaCells,
    merges: (sheet?.['!merges'] ?? []).map(toMergeRange),
    // 자기 시트 참조는 dangling 판정과 무관하다 — 언제나 존재한다
    referencedSheets: [...referenced].filter((sheetName) => sheetName !== name),
  };
}

/**
 * 템플릿 워크북 한 벌. 읽기 옵션 셋은 전부 필수다:
 *
 * - `cellStyles` 없으면 서식이 통째로 날아간다 (X-1의 전제가 무너진다)
 * - `cellNF` 없으면 `cell.z`가 비어 백분율 판정이 영영 false가 된다 (D-22에서 겪었다)
 * - `cellFormula` 없으면 살려 둬야 할 소계 수식(X-4a)이 사라진다
 *
 * SheetJS의 `.mjs` 빌드는 `fs`가 묶여 있지 않아 `XLSX.readFile`이 동작하지 않는다 —
 * `readFileSync` + `XLSX.read`를 쓴다 (tests/unit/export-template-clean.test.ts와 같은 이유).
 */
export function readTemplate(filePath: string): TemplateWorkbook {
  let bytes: Buffer;
  try {
    bytes = fs.readFileSync(filePath);
  } catch (e) {
    console.error('[export-adapter] 템플릿 파일 읽기 실패:', e);
    throw new Error(`제출 서식 템플릿 파일을 읽을 수 없습니다: ${path.basename(filePath)}`);
  }

  let workbook: XLSX.WorkBook;
  try {
    workbook = XLSX.read(bytes, {
      type: 'buffer',
      cellFormula: true,
      cellStyles: true,
      cellNF: true,
      cellDates: false,
    });
  } catch (e) {
    // 원인은 로그로 남기고 사용자에게는 내부 정보 없는 문장을 준다 (SA-4, 절대 규칙 5)
    console.error('[export-adapter] 템플릿 워크북 파싱 실패:', e);
    throw new Error(
      `제출 서식 템플릿이 손상되었습니다: ${path.basename(filePath)}. 템플릿 파일을 확인하세요.`
    );
  }

  return {
    workbook,
    sheets: workbook.SheetNames.map((name) => toSheetInfo(name, workbook.Sheets[name])),
  };
}

// ─── 쓰기 ─────────────────────────────────────────────────────────────────────

const A1_PATTERN = /^[A-Z]{1,3}\d{1,7}$/;

/**
 * 수식을 떼어낸다. `f` 하나만 지우면 배열 수식 범위(`F`)·공유 수식(`D`)이 남아
 * 엑셀이 다시 수식으로 되살릴 수 있다.
 */
function stripFormula(cell: XLSX.CellObject): void {
  delete cell.f;
  delete cell.F;
  delete cell.D;
}

/**
 * 살려 두는 수식 셀의 **캐시된 계산값**을 지운다 (X-4a).
 *
 * 남겨 두면 엑셀이 다시 계산하기 전까지 **옛 과제의 소계**를 그대로 보여 준다. 값을 지운 뒤
 * `t = 'e'`로 두는 것은 템플릿 자체가 저장돼 있는 모양 그대로다(`<c t="e"><f>SUM(...)</f></c>`) —
 * `t`를 숫자로 남기고 값만 지우면 SheetJS 기록기가 `#NUM!`을 캐시값으로 박아 넣는다.
 */
function clearCachedValue(cell: XLSX.CellObject): void {
  delete cell.v;
  delete cell.w;
  cell.t = 'e';
}

function writeValue(cell: XLSX.CellObject, value: string | number): void {
  if (typeof value === 'number') {
    cell.t = 'n';
    cell.v = value;
  } else {
    cell.t = 's';
    cell.v = value;
  }
  // 캐시된 표시 문자열을 남기면 엑셀이 옛 문자열을 보여 준다
  delete cell.w;
}

/**
 * X-8: 값을 비우되 **스타일(`s`)·표시형식(`z`)은 남긴다.** 값이 없다고 서식의 자리를 없애면
 * 제출 서류로 쓸 수 없다.
 *
 * `z`를 지우면 안 되는 이유가 하나 더 있다: SheetJS 기록기는 값도 수식도 표시형식도 없는 셀을
 * 아예 내보내지 않는다 — 셀 레코드가 사라지면서 테두리까지 함께 날아간다.
 */
function clearValue(cell: XLSX.CellObject): void {
  delete cell.v;
  delete cell.w;
  cell.t = 'z';
}

/**
 * 쓰기 지시를 워크북에 반영한다. **맵이 가리키지 않은 셀은 건드리지 않는다.**
 *
 * 순서가 중요하다: `clearFormula`는 값을 쓰기 **전에** 수식을 지운다. 남겨 두면 엑셀이 열면서
 * 다시 계산해 우리가 쓴 값을 덮어쓰고, 무엇보다 원본 과제의 조정상수가 붙은 수식이 살아
 * 금액이 조용히 어긋난다 (X-4·X-10a~X-10e).
 *
 * 마지막에 워크북 전체의 **살아남은 수식 셀**에서 캐시값을 걷어낸다 (X-4a). 지금 템플릿은
 * 캐시가 0개지만(X-2 ②), 나중에 다른 부처 템플릿을 실측 파일에서 뜰 때 캐시가 섞여 들어오면
 * 소계 칸에 남의 과제 금액이 그대로 보인다.
 */
export function applyWrites(workbook: XLSX.WorkBook, writes: readonly CellWrite[]): void {
  for (const write of writes) {
    const sheet = workbook.Sheets[write.sheet];
    if (!sheet) {
      throw new Error(
        `템플릿에 '${write.sheet}' 시트가 없습니다 — 셀 좌표 맵과 템플릿 파일이 어긋납니다.`
      );
    }
    if (!A1_PATTERN.test(write.addr)) {
      throw new Error(`셀 주소 형식이 올바르지 않습니다: ${write.sheet}!${write.addr}`);
    }

    const cell = sheet[write.addr] as XLSX.CellObject | undefined;
    if (!cell) {
      // 셀 레코드가 없다 = 그 자리에 서식이 붙어 있지 않다. 값을 비우라는 지시라면 지울 것도
      // 없으므로 넘어가지만, 값을 써야 하는데 레코드가 없으면 **테두리·천단위 서식 없이 맨
      // 숫자로 찍힌다**(X-10a). 그건 제출 서류로 쓸 수 없으므로 조용히 만들지 않고 거부한다
      if (write.value === null) continue;
      throw new Error(
        `템플릿 ${write.sheet}!${write.addr}에 셀 서식이 없습니다 — ` +
          `여기에 값을 쓰면 서식 없이 찍힙니다. 템플릿과 셀 좌표 맵을 확인하세요.`
      );
    }

    if (write.clearFormula === true) stripFormula(cell);
    if (write.value === null) clearValue(cell);
    else writeValue(cell, write.value);
  }

  for (const name of workbook.SheetNames) {
    const sheet = workbook.Sheets[name];
    if (!sheet) continue;
    for (const addr of Object.keys(sheet)) {
      if (addr.startsWith('!')) continue;
      const cell = sheet[addr] as XLSX.CellObject | undefined;
      if (cell && typeof cell.f === 'string' && cell.v !== undefined) clearCachedValue(cell);
    }
  }
}

/**
 * 워크북 → xlsx 바이트. `cellStyles`를 주지 않으면 읽을 때 살려 온 서식이 기록 단계에서 날아간다.
 *
 * `.mjs` 빌드의 `XLSX.writeFile`은 `fs`가 묶여 있지 않으므로 버퍼를 받아 호출부가 저장한다
 * (내보내기 자체는 파일을 쓰지 않는다 — 액션은 base64로 돌려주고 저장은 셸의 몫이다).
 */
export function writeWorkbookBuffer(workbook: XLSX.WorkBook): Buffer {
  const out: unknown = XLSX.write(workbook, {
    type: 'buffer',
    bookType: 'xlsx',
    cellStyles: true,
    compression: true,
  });
  if (Buffer.isBuffer(out)) return out;
  // type:'buffer'는 Node에서 Buffer를 주지만, 런타임이 Uint8Array를 주더라도 그대로 삼키지 않는다
  if (out instanceof Uint8Array) return Buffer.from(out);
  throw new Error('제출 서식 파일을 만들지 못했습니다 (예상치 못한 출력 형식).');
}
