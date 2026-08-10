// 실데이터 감지 가드 — 파괴적 테스트(§8.7 K-7 전체 대체 복원)를 시작하기 전에 부른다.
//
// K-7 복원은 대상 26종 테이블의 전 행을 지우고 백업 시점 행을 다시 넣는다. dev DB에
// 실제 과제 데이터가 있는 상태에서 이걸 돌리면, 백업(export) 이후 다른 PC에서 추가된
// 변경분이 통째로 사라진다. 감지 못 한 채 진행하는 것이 가장 나쁜 결과이므로
// "테스트가 만들지 않은 데이터가 하나라도 있으면 실행 거부"라는 보수적 규칙을 쓴다.
//
// 판정 대상은 루트 테이블 4종뿐이다. 나머지 22종은 전부 projects의 하위이거나
// (project_id not null + cascade) 그 하위의 조인 테이블이라 projects 판정에 포함된다.
// budget_details(§5.17, Phase 9)도 project_id not null + on delete cascade라 여기에 해당한다 —
// 산출근거는 반드시 어떤 과제에 속하므로 projects 탐지에 걸리지 않는 고아 행이 존재할 수 없고,
// 별도 탐지 쿼리를 더할 이유가 없다.
// app_users·app_settings는 사용자 데이터가 아니고 K-8에 따라 복원되지도 않으므로 제외한다.

import type { Sql } from 'postgres';
import { SEED } from '../integration/helpers';
import { TEST_ROW_MARK_PATTERN } from '../test-marker';

/** 테스트 사용자 이메일 패턴 — helpers.createTestUser가 만드는 형식 */
const TEST_USER_EMAIL_PATTERN = 'wbs-test+%';

interface ForeignRow {
  table_name: string;
  id: string;
  label: string;
}

const MAX_LISTED = 20;

// 테스트가 만들지 않은 행을 찾는다. created_by가 null인 행도 기본적으로 "남의 것"으로 본다 —
// 소유자가 끊긴 행은 실데이터와 구분할 방법이 없으므로 사람이 확인하게 만든다.
//
// 유일한 예외: 라벨 컬럼에 TEST_ROW_MARK가 찍힌 행. 그 표식은 destroyTestUser가
// "created_by가 wbs-test+… 사용자임을 SQL로 확인한 뒤"에만 찍으므로, 표식이 있다는 것
// 자체가 테스트 소유의 증거다 (근거는 tests/test-marker.ts). 소유자가 살아 있는 행에는
// 이 예외를 적용하지 않는다 — 그때는 소유자로 판단하면 된다.
export async function findForeignData(sql: Sql): Promise<ForeignRow[]> {
  return sql<ForeignRow[]>`
    with test_users as (
      select id from public.app_users where email like ${TEST_USER_EMAIL_PATTERN}
    ),
    owned as (
      select id from test_users
    )
    select 'projects' as table_name, p.id::text as id, p.name as label
      from public.projects p
     where p.id <> ${SEED.projectId}::uuid
       and (p.created_by is null or p.created_by not in (select id from owned))
       and not (p.created_by is null and p.project_no like ${TEST_ROW_MARK_PATTERN})
    union all
    select 'todos', t.id::text, t.title
      from public.todos t
     where (t.created_by is null or t.created_by not in (select id from owned))
       and not (t.created_by is null and t.title like ${TEST_ROW_MARK_PATTERN})
    union all
    select 'notes', n.id::text, n.title
      from public.notes n
     where (n.created_by is null or n.created_by not in (select id from owned))
       and not (n.created_by is null and n.title like ${TEST_ROW_MARK_PATTERN})
    union all
    select 'import_profiles', i.id::text, i.name
      from public.import_profiles i
     where (i.created_by is null or i.created_by not in (select id from owned))
       and not (i.created_by is null and i.name like ${TEST_ROW_MARK_PATTERN})`;
}

/**
 * 테스트 소유가 아닌 데이터가 있으면 무엇이 있는지 알리고 즉시 실패시킨다.
 * 조용히 진행하지 않는다 (절대 규칙 5).
 */
export async function assertNoForeignData(sql: Sql): Promise<void> {
  const rows = await findForeignData(sql);
  if (rows.length === 0) return;

  const listed = rows
    .slice(0, MAX_LISTED)
    .map((r) => `  - ${r.table_name}: ${r.label || '(제목 없음)'} [${r.id}]`)
    .join('\n');
  const omitted = rows.length > MAX_LISTED ? `\n  ... 외 ${rows.length - MAX_LISTED}건` : '';

  throw new Error(
    [
      '파괴적 테스트를 거부했습니다: dev DB에 테스트가 만들지 않은 데이터가 있습니다.',
      '',
      `이 테스트는 §8.7 K-7 전체 대체 복원을 검증하느라 대상 26종 테이블의 전 행을 지웠다 되돌립니다.`,
      '아래 데이터가 실제 과제 데이터라면, 다른 PC에서 그 사이 입력한 변경분이 사라질 수 있습니다.',
      '',
      `발견된 행 ${rows.length}건:`,
      listed + omitted,
      '',
      '해결: ① 실데이터라면 이 테스트를 돌리지 마세요(전용 빈 DB에서만 실행).',
      `      ② 중단된 테스트의 잔여물이라면 직결 SQL로 정리한 뒤 다시 실행하세요.`,
    ].join('\n')
  );
}
