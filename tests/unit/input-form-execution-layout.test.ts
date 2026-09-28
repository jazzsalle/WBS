// 수행 모드 좌표 맵·`_meta` (SOT §6.16 IN-1·IN-2·IN-9·IN-13, 부록 F-6·F-9)
//
// 좌표 맵은 하나이고 수행 모드 열은 제안 맵에서 파생한다(IN-9). 제안 맵이 한 바이트라도 바뀌면
// Phase 17·19 양식과 이미 내려받은 파일이 어긋나므로, 파생 전 맵의 JSON을 여기 고정한다.

import { describe, expect, it } from 'vitest';
import {
  EXECUTION_DESCRIPTION_MAX,
  EXECUTION_ISSUES,
  INPUT_FORM_SHEETS,
  INPUT_FORM_VERSION,
  MODE_MISMATCH_MESSAGES,
  buildMetaRows,
  checkMeta,
  columnAddress,
  columnOf,
  hiddenColumnIndexes,
  isExecutionMeta,
  metaMode,
  parseMeta,
  sheetsFor,
} from '@/lib/input-form';
import type { FormCell, InputFormMeta, InputFormSheetDef } from '@/lib/input-form';
import type { RawCell, RawSheet } from '@/lib/import/types';

// Phase 19 커밋(c612687) 시점 INPUT_FORM_SHEETS의 JSON 직렬화
const PHASE19_PLAN_SHEETS_JSON = '{"personnel":{"name":"인건비","hidden":false,"headerRow":1,"dataStartRow":2,"columns":[{"role":"memberId","label":"memberId","hidden":true,"read":true,"format":"text"},{"role":"detailId","label":"detailId","hidden":true,"read":true,"format":"text"},{"role":"name","label":"성명","hidden":false,"read":false,"format":"text"},{"role":"position","label":"직위","hidden":false,"read":false,"format":"text"},{"role":"staff","label":"조직원","hidden":false,"read":false,"format":"text"},{"role":"salaryBasis","label":"급여 기준","hidden":false,"read":false,"format":"text"},{"role":"annualSalary","label":"연봉","hidden":false,"read":false,"format":"int"},{"role":"monthlySalary","label":"월급","hidden":false,"read":false,"format":"int"},{"role":"subcategory","label":"세목","hidden":false,"read":true,"format":"text"},{"role":"participation","label":"참여율(%)","hidden":false,"read":true,"format":"decimal"},{"role":"months","label":"참여개월","hidden":false,"read":true,"format":"decimal"},{"role":"axis","label":"현금/현물","hidden":false,"read":true,"format":"text"},{"role":"adjustment","label":"조정액","hidden":false,"read":true,"format":"int"},{"role":"formulaAmount","label":"산식 금액","hidden":false,"read":false,"format":"formula"},{"role":"amount","label":"금액","hidden":false,"read":false,"format":"formula"},{"role":"note","label":"비고","hidden":false,"read":true,"format":"text"}]},"budget":{"name":"사업비","hidden":false,"headerRow":1,"dataStartRow":2,"columns":[{"role":"subcategory","label":"subcategory","hidden":true,"read":true,"format":"text"},{"role":"detailId","label":"detailId","hidden":true,"read":true,"format":"text"},{"role":"category","label":"비목","hidden":false,"read":false,"format":"text"},{"role":"subcategoryLabel","label":"세목","hidden":false,"read":false,"format":"text"},{"role":"name","label":"품명","hidden":false,"read":true,"format":"text"},{"role":"spec","label":"규격","hidden":false,"read":true,"format":"text"},{"role":"unitPrice","label":"단가","hidden":false,"read":true,"format":"int"},{"role":"factor1","label":"인자1","hidden":false,"read":true,"format":"decimal"},{"role":"factor2","label":"인자2","hidden":false,"read":true,"format":"decimal"},{"role":"factor3","label":"인자3","hidden":false,"read":true,"format":"decimal"},{"role":"adjustment","label":"조정액","hidden":false,"read":true,"format":"int"},{"role":"axis","label":"현금/현물","hidden":false,"read":true,"format":"text"},{"role":"amount","label":"금액","hidden":false,"read":false,"format":"formula"},{"role":"note","label":"비고","hidden":false,"read":true,"format":"text"}]},"meta":{"name":"_meta","hidden":true,"headerRow":1,"dataStartRow":2,"columns":[{"role":"key","label":"키","hidden":false,"read":true,"format":"text"},{"role":"value","label":"값","hidden":false,"read":true,"format":"text"}]}}';

function toRawSheet(rows: FormCell[][]): RawSheet {
  const cells: RawCell[][] = rows.map((row) =>
    row.map((cell) => ({ value: cell.value ?? null, isError: false }))
  );
  return { name: '_meta', cells, merges: [] };
}

function column(def: InputFormSheetDef, role: string) {
  const c = def.columns[columnOf(def, role)];
  if (c === undefined) throw new Error(role);
  return c;
}

const PLAN = sheetsFor('plan');
const EXEC = sheetsFor('execution');

const PLAN_META: InputFormMeta = {
  formVersion: INPUT_FORM_VERSION,
  projectId: 'proj-1',
  yearId: 'year-1',
  generatedAt: '2026-09-28T09:00:00.000Z',
  subcategoryCodes: ['personnel:personnel_internal', 'activity:activity_meeting', 'activity:'],
  memberIds: ['m-2', 'm-1'],
};

const EXEC_META: InputFormMeta = {
  ...PLAN_META,
  mode: 'execution',
  executions: { 'e-3': 1, 'e-1': 4, 'e-2': 2 },
  detailIds: ['d-2', 'd-1'],
};

describe('제안 맵 불변 (IN-9 · 제안 모드 불변 제약)', () => {
  it('sheetsFor(plan)의 JSON이 Phase 19 맵과 같다', () => {
    expect(JSON.stringify(sheetsFor('plan'))).toBe(PHASE19_PLAN_SHEETS_JSON);
  });

  it('INPUT_FORM_SHEETS는 sheetsFor(plan)의 별칭이다', () => {
    expect(INPUT_FORM_SHEETS).toBe(sheetsFor('plan'));
    expect(JSON.stringify(INPUT_FORM_SHEETS)).toBe(JSON.stringify(sheetsFor('plan')));
  });

  it('호출마다 같은 객체다', () => {
    expect(sheetsFor('execution')).toBe(sheetsFor('execution'));
  });
});

describe('수행 맵 파생 (IN-9)', () => {
  it('시트 이름·행 좌표·_meta는 두 모드가 같다', () => {
    for (const key of ['personnel', 'budget', 'meta'] as const) {
      const { columns: _planColumns, ...planRest } = PLAN[key];
      const { columns: _execColumns, ...execRest } = EXEC[key];
      expect(execRest).toEqual(planRest);
    }
    expect(EXEC.meta).toBe(PLAN.meta);
  });

  it('인건비: 제안 열 + executionId(숨김) + 집행일, 보이는 열 순서는 그대로', () => {
    expect(EXEC.personnel.columns.map((c) => c.label)).toEqual([
      'memberId', 'detailId', 'executionId', '성명', '직위', '조직원', '급여 기준', '연봉', '월급', '집행일',
      '세목', '참여율(%)', '참여개월', '현금/현물', '조정액', '산식 금액', '금액', '비고',
    ]);
  });

  it('사업비: 제안 열 + executionId(숨김) + 집행일, 보이는 열 순서는 그대로', () => {
    expect(EXEC.budget.columns.map((c) => c.label)).toEqual([
      'subcategory', 'detailId', 'executionId', '비목', '세목', '집행일', '품명', '규격', '단가',
      '인자1', '인자2', '인자3', '조정액', '현금/현물', '금액', '비고',
    ]);
  });

  it('두 시트 모두: 수행 열을 빼면 제안 열의 역할 순서와 같다', () => {
    const extra = new Set(['executionId', 'executionDate']);
    for (const key of ['personnel', 'budget'] as const) {
      expect(EXEC[key].columns.filter((c) => !extra.has(c.role)).map((c) => c.role)).toEqual(
        PLAN[key].columns.map((c) => c.role)
      );
    }
  });

  it.each(['personnel', 'budget'] as const)('%s: executionId는 숨김·read, 집행일은 보이고 read·date', (key) => {
    const def = EXEC[key];
    expect(column(def, 'executionId')).toMatchObject({ label: 'executionId', hidden: true, read: true, format: 'text' });
    expect(column(def, 'executionDate')).toMatchObject({ label: '집행일', hidden: false, read: true, format: 'date' });
  });

  it.each(['personnel', 'budget'] as const)('%s: 금액은 입력값이다 — read, int (IN-11)', (key) => {
    expect(column(EXEC[key], 'amount')).toMatchObject({ read: true, format: 'int' });
    expect(column(PLAN[key], 'amount')).toMatchObject({ read: false, format: 'formula' });
  });

  it.each(['personnel', 'budget'] as const)('%s: 조정액은 자리만 남고 읽지 않는다 (IN-9, S-7)', (key) => {
    expect(column(EXEC[key], 'adjustment')).toMatchObject({ read: false, hidden: false });
    expect(column(PLAN[key], 'adjustment').read).toBe(true);
  });

  it('인건비 산식 금액은 수식 없이 읽지 않는다 (IN-9, IN-11)', () => {
    expect(column(EXEC.personnel, 'formulaAmount')).toMatchObject({ read: false, format: 'int' });
  });

  it('수행 맵에 formula 열이 없다 — 연봉 수식(IN-7)은 제안 모드에서만', () => {
    for (const key of ['personnel', 'budget'] as const) {
      expect(EXEC[key].columns.some((c) => c.format === 'formula'), key).toBe(false);
    }
  });

  it('숨김 열은 전부 read, 읽지 않는 열은 전부 보이는 열, 역할 중복 0, 백분율 서식 0', () => {
    for (const def of Object.values(EXEC)) {
      const roles = def.columns.map((c) => c.role);
      expect(new Set(roles).size, def.name).toBe(roles.length);
      for (const c of def.columns) {
        if (c.hidden) expect(c.read, `${def.name}.${c.role}`).toBe(true);
        if (!c.read) expect(c.hidden, `${def.name}.${c.role}`).toBe(false);
        expect(c.format, `${def.name}.${c.role}`).not.toBe('percent');
      }
    }
  });

  it('나머지 열의 정의는 제안 맵과 같다', () => {
    const changed: Record<'personnel' | 'budget', readonly string[]> = {
      personnel: ['adjustment', 'formulaAmount', 'amount'],
      budget: ['adjustment', 'amount'],
    };
    for (const key of ['personnel', 'budget'] as const) {
      for (const c of PLAN[key].columns) {
        if (changed[key].includes(c.role)) continue;
        expect(column(EXEC[key], c.role), `${key}.${c.role}`).toEqual(c);
      }
    }
  });
});

describe('columnOf · columnAddress · hiddenColumnIndexes — mode별 def를 받는다', () => {
  it('숨김 열: 제안은 2개, 수행은 executionId까지 3개', () => {
    expect(hiddenColumnIndexes(PLAN.personnel)).toEqual([0, 1]);
    expect(hiddenColumnIndexes(EXEC.personnel)).toEqual([0, 1, 2]);
    expect(hiddenColumnIndexes(EXEC.budget)).toEqual([
      columnOf(EXEC.budget, 'subcategory'),
      columnOf(EXEC.budget, 'detailId'),
      columnOf(EXEC.budget, 'executionId'),
    ]);
  });

  it('A1 주소가 mode별 맵을 따른다', () => {
    expect(columnAddress(PLAN.personnel, 'participation', 7)).toBe('J7');
    expect(columnAddress(EXEC.personnel, 'executionDate', 7)).toBe('J7');
    expect(columnAddress(EXEC.personnel, 'participation', 7)).toBe('L7');
    expect(columnAddress(EXEC.budget, 'executionDate', 2)).toBe('F2');
  });

  it('시트 키 문자열은 제안 맵이다 — 기존 호출부 호환', () => {
    expect(columnOf('personnel', 'participation')).toBe(columnOf(PLAN.personnel, 'participation'));
    expect(() => columnOf('personnel', 'executionId')).toThrow(/executionId/);
  });
});

describe('_meta — 수행 양식만 mode·execution·detail 행 (IN-2, S-1)', () => {
  const keysOf = (meta: InputFormMeta) =>
    buildMetaRows(meta)
      .slice(PLAN.meta.dataStartRow - 1)
      .map((r) => r[columnOf(PLAN.meta, 'key')]?.value);

  it('제안 메타는 mode 행이 없고 Phase 19와 같은 키 목록이다', () => {
    expect(keysOf(PLAN_META)).toEqual([
      'formVersion', 'projectId', 'yearId', 'generatedAt',
      'subcategory:personnel:personnel_internal', 'subcategory:activity:activity_meeting', 'subcategory:activity:',
      'member:m-2', 'member:m-1',
    ]);
  });

  it("mode 'plan'을 명시해도 mode 행을 쓰지 않는다", () => {
    expect(buildMetaRows({ ...PLAN_META, mode: 'plan' })).toEqual(buildMetaRows(PLAN_META));
  });

  it('제안 메타에 목록이 실려 와도 쓰지 않는다', () => {
    expect(buildMetaRows({ ...PLAN_META, executions: { x: 1 }, detailIds: ['d'] })).toEqual(
      buildMetaRows(PLAN_META)
    );
  });

  it('수행 메타: 고정 키 뒤에 mode, 목록 끝에 execution·detail (시트 순서 보존)', () => {
    expect(keysOf(EXEC_META)).toEqual([
      'formVersion', 'projectId', 'yearId', 'generatedAt', 'mode',
      'subcategory:personnel:personnel_internal', 'subcategory:activity:activity_meeting', 'subcategory:activity:',
      'member:m-2', 'member:m-1',
      'execution:e-3', 'execution:e-1', 'execution:e-2',
      'detail:d-2', 'detail:d-1',
    ]);
  });

  it('execution 행의 값 칸은 version(숫자)이다', () => {
    const rows = buildMetaRows(EXEC_META);
    const keyCol = columnOf(PLAN.meta, 'key');
    const valueCol = columnOf(PLAN.meta, 'value');
    expect(rows.find((r) => r[keyCol]?.value === 'execution:e-1')?.[valueCol]?.value).toBe(4);
    expect(rows.find((r) => r[keyCol]?.value === 'mode')?.[valueCol]?.value).toBe('execution');
  });

  it('수행 메타 왕복', () => {
    const parsed = parseMeta(toRawSheet(buildMetaRows(EXEC_META)));
    expect(parsed).toStrictEqual(EXEC_META);
    expect(Object.keys(parsed?.executions ?? {})).toEqual(['e-3', 'e-1', 'e-2']);
    expect(parsed !== null && isExecutionMeta(parsed)).toBe(true);
    expect(parsed && metaMode(parsed)).toBe('execution');
  });

  it('수행 메타의 목록이 비어도 빈 값으로 채워 돌아온다', () => {
    const parsed = parseMeta(toRawSheet(buildMetaRows({ ...EXEC_META, executions: {}, detailIds: [] })));
    expect(parsed?.executions).toEqual({});
    expect(parsed?.detailIds).toEqual([]);
    expect(parsed !== null && isExecutionMeta(parsed)).toBe(true);
  });

  it('mode 행이 없으면 제안이다 — 결과에 mode·목록 키를 만들지 않는다 (Phase 19 파일)', () => {
    const parsed = parseMeta(toRawSheet(buildMetaRows(PLAN_META)));
    expect(parsed).toStrictEqual(PLAN_META);
    expect(parsed && metaMode(parsed)).toBe('plan');
    expect(parsed !== null && isExecutionMeta(parsed)).toBe(false);
  });

  it("mode 행이 'plan'이면 제안이다", () => {
    const rows = [...buildMetaRows(PLAN_META), [{ value: 'mode' }, { value: 'plan' }]];
    const parsed = parseMeta(toRawSheet(rows));
    expect(parsed && metaMode(parsed)).toBe('plan');
  });

  it('제안 파일에 섞인 execution·detail 행은 결과에 싣지 않는다', () => {
    const rows = [
      ...buildMetaRows(PLAN_META),
      [{ value: 'execution:e-9' }, { value: 1 }],
      [{ value: 'detail:d-9' }, { value: 'd-9' }],
    ];
    expect(parseMeta(toRawSheet(rows))).toStrictEqual(PLAN_META);
  });

  it('모르는 mode 값이면 null — 추측하지 않는다', () => {
    const rows = [...buildMetaRows(PLAN_META), [{ value: 'mode' }, { value: 'actual' }]];
    expect(parseMeta(toRawSheet(rows))).toBeNull();
  });

  it.each([['0'], ['1.5'], ['abc'], ['']])(
    "execution 행의 version이 '%s'이면 null — 충돌 기준이 깨진 파일 (IN-10)",
    (bad) => {
      const rows = [...buildMetaRows(EXEC_META), [{ value: 'execution:e-9' }, { value: bad }]];
      expect(parseMeta(toRawSheet(rows))).toBeNull();
    }
  );

  it('문자열로 돌아온 version도 정수로 읽는다', () => {
    const rows = [...buildMetaRows(EXEC_META), [{ value: 'execution:e-9' }, { value: '7' }]];
    expect(parseMeta(toRawSheet(rows))?.executions?.['e-9']).toBe(7);
  });
});

describe('checkMeta — 과제 → 버전 → mode (IN-2·IN-9)', () => {
  const base = { projectId: 'proj-1', formVersion: INPUT_FORM_VERSION };

  it('mode가 맞으면 null', () => {
    expect(checkMeta(PLAN_META, base)).toBeNull();
    expect(checkMeta(PLAN_META, { ...base, mode: 'plan' })).toBeNull();
    expect(checkMeta(EXEC_META, { ...base, mode: 'execution' })).toBeNull();
  });

  it('제안 양식을 수행 모드에서 올리면 거부', () => {
    expect(checkMeta(PLAN_META, { ...base, mode: 'execution' })).toEqual({
      kind: 'mode-mismatch',
      message: '제안 양식입니다 — 제안 모드에서 올리세요',
    });
  });

  it('수행 양식을 제안 모드에서 올리면 거부 — mode 생략은 제안 모드다', () => {
    const expected = { kind: 'mode-mismatch', message: '수행 양식입니다 — 수행 모드에서 올리세요' };
    expect(checkMeta(EXEC_META, { ...base, mode: 'plan' })).toEqual(expected);
    expect(checkMeta(EXEC_META, base)).toEqual(expected);
  });

  it('문구 상수는 파일의 mode 기준이다', () => {
    expect(MODE_MISMATCH_MESSAGES).toEqual({
      plan: '제안 양식입니다 — 제안 모드에서 올리세요',
      execution: '수행 양식입니다 — 수행 모드에서 올리세요',
    });
  });

  it('과제가 다르면 mode보다 과제 불일치가 먼저다', () => {
    expect(checkMeta({ ...EXEC_META, projectId: 'x' }, base)?.kind).toBe('project-mismatch');
  });

  it('버전이 다르면 mode보다 버전 불일치가 먼저다', () => {
    expect(checkMeta({ ...EXEC_META, formVersion: 99 }, base)?.kind).toBe('version-mismatch');
  });
});

describe('수행 모드 사유 코드 (IN-10·IN-11·IN-13)', () => {
  it('반영을 막지 않는 것은 연차 기간 밖·금액 불일치 두 가지뿐이다', () => {
    const warnings = Object.entries(EXECUTION_ISSUES)
      .filter(([, v]) => !v.blocking)
      .map(([k]) => k);
    expect(warnings.sort()).toEqual(['amount-mismatch', 'date-out-of-year']);
  });

  it('SOT·계획서에 이름이 박힌 코드가 있다', () => {
    for (const kind of ['no-date', 'unknown-execution', 'category-moved', 'amount-mismatch', 'no-amount']) {
      expect(EXECUTION_ISSUES, kind).toHaveProperty(kind);
    }
    expect(EXECUTION_DESCRIPTION_MAX).toBe(200);
  });
});
