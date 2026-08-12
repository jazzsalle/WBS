// 실측 샘플에서 **값만 비운** 제출 서식 템플릿을 만든다 (SOT §6.12.1 X-2, X-4b, X-10a).
//
// 사용법:  node scripts/build-template.mjs templates/산출근거_표준.xlsx
//
// ⚠️ `samples/`는 `.gitignore` 대상이다 — 실예산 파일이 있는 기계에서만 돌아간다.
//    그래서 이 스크립트는 CI에 걸 수 없고, **산출물(`templates/*.xlsx`)만 커밋**된다.
//    그래도 절차를 저장소에 남기는 이유는 X-3(부처 추가)이 실제로 일어나면
//    같은 작업을 기억에 의존해 반복해야 하기 때문이다. 아래 판단 하나하나가
//    실측에서 한 번씩 데어 가며 얻은 것이다.
//
// 만든 뒤에는 반드시 `npx vitest run tests/unit/export-template-clean.test.ts`로
// X-2의 기계 검증(숫자 셀 0 / 캐시값 0 / 텍스트 전수 스냅샷)을 통과시킨 뒤에 커밋한다.
import { readFileSync, readdirSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// SheetJS의 .mjs 빌드를 절대 경로로 부른다 — 이 빌드는 `fs`가 묶여 있지 않아
// readFile/writeFile을 못 쓴다. 아래에서 readFileSync/writeFileSync로 감싼다.
const XLSX = await import(pathToFileURL(path.join(ROOT, 'node_modules/xlsx/xlsx.mjs')).href);

const SRC_DIR = path.join(ROOT, 'samples');
const OUT = process.argv[2];
if (!OUT) throw new Error('사용법: node scripts/build-template.mjs <출력경로>');

const srcName = readdirSync(SRC_DIR).find((n) => n.startsWith('산자부'));
if (!srcName) throw new Error(`원본 샘플을 찾지 못했다: ${SRC_DIR}/산자부*`);
const wb = XLSX.read(readFileSync(path.join(SRC_DIR, srcName)), {
  cellFormula: true,
  cellStyles: true,
  cellNF: true, // 없으면 cell.z가 비어 백분율 판정이 영영 false가 된다 (D-22)
});

// 남길 시트 2개 (§7.9.4 범위: 산출근거 + 총괄표)
const KEEP_SHEETS = ['유엔이_총괄표', '1차년도_250520'];

// 구조 라벨 — 이것만 텍스트를 남긴다. 나머지 텍스트는 전부 사용자 입력으로 보고 지운다.
const STRUCTURE = [
  /소요명세/, /^[가-힣]\s*[.．]/, /^[①-⑫]/, /^-\s*인건비/,
  /^(소\s*계|합\s*계|계|총\s*계)$/,
  /비목|세목|구\s*분|품\s*명|규\s*격|단\s*위|수\s*량|단\s*가|총\s*액|비\s*고/,
  /성\s*명|직\s*위|인력\s*구분|실지급액|참여율|참여기간|산출내역|산출\s*비용|내\s*역|인\s*원|횟\s*수/,
  /현\s*금|현\s*물|정부출연금|기관부담금|민간부담금|사업비|연구개발비/,
  /차년도$|^\d+차년도|단위\s*[:：]/,
  /인건비|학생인건비|연구시설|장비비|연구재료비|위탁연구|국제공동|부담비|연구활동비|과제추진비|연구수당|간접비|기타/,
  /인력지원비|연구지원비|성과활용지원비|외주용역|지식재산|전문기술|회의비|출장비|소프트웨어|연구실\s*운영|종합사업관리|클라우드/,
  // 2행 헤더의 인자 라벨. 한 글자짜리가 많아 위 패턴에 안 걸린다 —
  // 이걸 지우면 factor 열이 사라져 X-7(참여율)·PL-3(단가×인자)이 쓸 자리를 잃는다
  /^(회|월|일|명|인|건|식|대|개|년|차)$/,
  /시\s*트|수\s*량|횟\s*수|인\s*원|기\s*간|단\s*위|직\s*급|번\s*호/,
  // 인건비 블록의 **세로 병합된 구간 라벨** (`C65:C87 = 기존인력`, `C89:C90 = 신규채용`).
  // 성명 옆에 있어 데이터로 보이지만 사람 이름이 아니라 서식의 구간 표시다 —
  // 지우면 제출 서식의 `인력구분` 칸이 통째로 빈 채 나간다.
  /^(기존인력|신규채용|내부인력|외부인력|참여연구원|연구책임자)$/,
];

const isStructureText = (s) => STRUCTURE.some((re) => re.test(s));

let cleared = 0, keptText = 0, keptFormula = 0, droppedFormula = 0, strippedConst = 0;
const keptSamples = new Set();

for (const name of wb.SheetNames.slice()) {
  if (!KEEP_SHEETS.includes(name)) {
    delete wb.Sheets[name];
    continue;
  }
  const ws = wb.Sheets[name];
  const r = XLSX.utils.decode_range(ws['!ref']);
  for (let R = r.s.r; R <= r.e.r; R++) {
    for (let C = r.s.c; C <= r.e.c; C++) {
      const addr = XLSX.utils.encode_cell({ r: R, c: C });
      const cell = ws[addr];
      if (!cell) continue;

      // 지운 시트를 참조하거나 이미 깨진 수식은 통째로 비운다 (#REF! 잔재를 남기지 않는다)
      if (cell.f && (/#REF!/.test(cell.f) || /'?(예산총괄표|검토_|[234]차년도)/.test(cell.f))) {
        delete ws[addr]; droppedFormula++; cleared++; continue;
      }
      if (cell.t === 'e') { delete ws[addr]; cleared++; continue; }

      if (cell.f) {
        // X-4b — 원본 과제의 **실측 조정액이 수식 안에 상수로 박혀** 있다
        // (예: `TRUNC(G69*H69*I69,-3)-270000`). 이걸 두면 그 줄에 다른 인력을 써도
        // 남의 조정액이 조용히 따라붙는다. 값으로 덮어쓰는 행(X-4)은 어차피 사라지지만
        // **미사용 슬롯에 남으면 그대로 오염된다.**
        const stripped = cell.f.replace(/\)\s*[+-]\s*\d+\s*$/, ')');
        if (stripped !== cell.f) { cell.f = stripped; strippedConst++; }

        // 수식은 살리되 **캐시된 계산값은 지운다** — 금액이 그대로 남으면 안 된다 (X-2 ②)
        delete cell.v; delete cell.w;
        keptFormula++; continue;
      }

      const text = cell.v === null || cell.v === undefined ? '' : String(cell.v).trim();
      if (typeof cell.v === 'string' && text !== '' && isStructureText(text)) {
        keptText++; keptSamples.add(text.replace(/\s+/g, ' ').slice(0, 40));
        continue;
      }

      // 그 밖은 전부 데이터 — 값만 지우고 스타일(cell.s)은 남긴다 (X-8)
      if (cell.v !== undefined) { cleared++; }
      delete cell.v; delete cell.w; delete cell.t;
      cell.t = 'z'; // 서식만 남은 빈 셀
    }
  }
}

wb.SheetNames = wb.SheetNames.filter((n) => KEEP_SHEETS.includes(n));

// 시트명을 일반화한다 — 원본에는 회사명(`유엔이`)과 판본 날짜(`_250520`)가 붙어 있다.
// 템플릿은 어느 과제에나 쓰이므로 특정 조직·판본을 이름에 남기지 않는다 (X-2).
const RENAME = { '유엔이_총괄표': '총괄표', '1차년도_250520': '산출근거' };

// ⚠️ 시트를 바꿔 달기 **전에** 수식 안의 시트 참조를 먼저 고친다.
// 안 고치면 `총괄표!F4 = '1차년도_250520'!G13`이 없는 시트를 가리켜 총괄표 전 열이 #REF!가 되고,
// X-10(총괄표 = 산출근거 합계)이 통째로 깨진다. 이름만 바꾸고 참조를 두는 것이 정확히 그 함정이다.
// (`validateLayout`의 `dangling-sheet-ref`가 사후 그물이지만, 여기서 안 만드는 편이 낫다)
let rewritten = 0;
for (const name of wb.SheetNames) {
  const ws = wb.Sheets[name];
  const rr = XLSX.utils.decode_range(ws['!ref']);
  for (let R = rr.s.r; R <= rr.e.r; R++) {
    for (let C = rr.s.c; C <= rr.e.c; C++) {
      const cell = ws[XLSX.utils.encode_cell({ r: R, c: C })];
      if (!cell?.f) continue;
      let f = cell.f;
      for (const [from, to] of Object.entries(RENAME)) {
        // 작은따옴표로 감싼 형태와 맨 이름 형태를 모두 바꾼다
        f = f.split(`'${from}'!`).join(`${to}!`).split(`${from}!`).join(`${to}!`);
      }
      if (f !== cell.f) { cell.f = f; rewritten++; }
    }
  }
}

for (const [from, to] of Object.entries(RENAME)) {
  if (!wb.Sheets[from]) continue;
  wb.Sheets[to] = wb.Sheets[from];
  delete wb.Sheets[from];
  wb.SheetNames = wb.SheetNames.map((n) => (n === from ? to : n));
}

// X-10a — 총괄표의 2~4차년도 열(G·H·I)에는 셀 레코드가 아예 없다.
// 원본 과제가 1차년도만 채워 넣었기 때문이다. 셀이 없으면 스타일도 없어서
// 내보내기가 값을 써도 테두리·천단위 서식 없이 맨 숫자로 찍힌다.
// 1차년도 열(F)의 서식을 그대로 복제해 둔다. **수식은 복사하지 않는다** —
// F의 수식은 산출근거 시트(=내보내는 연차 하나)를 가리키므로 다른 연차에 그대로 쓰면 틀린다.
let styleCopied = 0;
{
  const ws = wb.Sheets['총괄표'];
  const r = XLSX.utils.decode_range(ws['!ref']);
  const F = XLSX.utils.decode_col('F');
  for (let R = r.s.r; R <= r.e.r; R++) {
    const src = ws[XLSX.utils.encode_cell({ r: R, c: F })];
    if (!src?.s) continue;
    for (const C of [F + 1, F + 2, F + 3]) {
      const addr = XLSX.utils.encode_cell({ r: R, c: C });
      if (ws[addr]) continue;
      ws[addr] = { t: 'z', s: src.s, ...(src.z ? { z: src.z } : {}) };
      styleCopied++;
    }
  }
  if (r.e.c < F + 3) {
    r.e.c = F + 3;
    ws['!ref'] = XLSX.utils.encode_range(r);
  }
}

// 총괄표 23행(연구수당 비율)의 표시형식이 원본에서 어긋나 있다 —
// `J23`만 백분율(`0.00%`)이고 `F23:I23`은 회계 형식(`#,##0`)이다.
// 원본 과제는 연구수당이 0이라 아무도 눈치채지 못했다. 나란한 28행(간접비 비율)은
// `F28:I28`이 전부 백분율이므로 그쪽이 옳다. 고치지 않으면 X-7대로 0.0096을 써도
// 화면에 `-`로 보인다 — **값은 맞고 표시만 틀리는** 가장 잡기 어려운 종류다.
let fmtFixed = 0;
{
  const ws = wb.Sheets['총괄표'];
  const ref = ws['J23']?.z ?? '0.00%';
  for (const a of ['F23', 'G23', 'H23', 'I23']) {
    if (!ws[a] || ws[a].z === ref) continue;
    ws[a].z = ref;
    fmtFixed++;
  }
}

const outPath = path.isAbsolute(OUT) ? OUT : path.join(ROOT, OUT);
mkdirSync(path.dirname(outPath), { recursive: true });
writeFileSync(outPath, XLSX.write(wb, { type: 'buffer', bookType: 'xlsx', cellStyles: true }));

console.log(`원본: ${srcName}`);
console.log(`시트: ${wb.SheetNames.join(', ')} / 시트 참조를 고친 수식 ${rewritten}개`);
console.log(`지운 셀 ${cleared} / 남긴 라벨 ${keptText} / 남긴 수식 ${keptFormula} / 버린 수식 ${droppedFormula}`);
console.log(`떼어낸 조정상수 ${strippedConst}개 / 연차열 서식 복제 ${styleCopied}칸 / 백분율 서식 교정 ${fmtFixed}칸`);
console.log(`\n남긴 라벨 표본 (${keptSamples.size}종):`);
[...keptSamples].sort().slice(0, 60).forEach((s) => console.log('  ' + s));
console.log(`\n→ ${outPath}`);
console.log('다음: npx vitest run tests/unit/export-template-clean.test.ts (X-2 기계 검증)');
